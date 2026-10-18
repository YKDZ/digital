import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductSourceIo } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import type { FanboxEndpointSessionTransport } from "@digital/fanbox";
import { createPublicApiClient } from "@digital/public-api";
import { createProcessLifecycleRegistry } from "@digital/service-host";
import { refusingSessionTransport } from "@digital/test-support/source-io";
import { serve } from "srvx";
import { afterEach, expect, it, vi } from "vitest";

import { createProductService } from "../src/service.ts";

const servers: Array<Awaited<ReturnType<typeof serve>>> = [];
const bootstraps: Array<Awaited<ReturnType<typeof createProductService>>> = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0).reverse()) await server.close(true);
  for (const bootstrap of bootstraps.splice(0).reverse())
    await bootstrap.abort();
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("创建限范围的限时配对请求，并拒绝其他服务实例", async () => {
  const firstBaseUrl = await startService();
  const secondBaseUrl = await startService();
  const firstClient = createPublicApiClient({ baseUrl: firstBaseUrl });
  const secondClient = createPublicApiClient({ baseUrl: secondBaseUrl });
  await firstClient.listSourceConnections();
  await secondClient.listSourceConnections();

  const created = await firstClient.createFanboxConnectionRequest({
    creatorId: "customudon",
  });
  expect(created.request).toMatchObject({
    creatorId: "customudon",
    instanceId: expect.any(String),
    status: "waiting",
  });
  expect(created.pairingCode).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const lifetime =
    Date.parse(created.request.expiresAt) -
    Date.parse(created.request.createdAt);
  expect(lifetime).toBeGreaterThan(0);
  expect(lifetime).toBeLessThanOrEqual(5 * 60 * 1000);

  await expect(
    secondClient.getFanboxConnectionRequestForPairing({
      requestId: created.request.id,
      pairingCode: created.pairingCode,
    }),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });

  const target = await firstClient.getFanboxConnectionRequestForPairing({
    requestId: created.request.id,
    pairingCode: created.pairingCode,
  });
  expect(target).toMatchObject({
    creatorId: "customudon",
    instanceId: created.request.instanceId,
    status: "waiting",
  });
  expect(JSON.stringify(target)).not.toContain(created.pairingCode);
});

it("请求取消后不保存之后回传的浏览器上下文", async () => {
  const baseUrl = await startService();
  const client = createPublicApiClient({ baseUrl });
  const created = await client.createFanboxConnectionRequest({
    creatorId: "customudon",
  });

  const cancelled = await client.cancelFanboxConnectionRequest({
    requestId: created.request.id,
    pairingCode: created.pairingCode,
  });
  expect(cancelled.status).toBe("cancelled");

  const lateCompletion = await client.completeFanboxConnectionRequest({
    requestId: created.request.id,
    pairingCode: created.pairingCode,
    browserCredential: {
      userAgent: "controlled-browser/1",
      cookies: [
        {
          name: "FANBOXSESSID",
          value: "synthetic-late-session-value",
          domain: ".fanbox.cc",
          path: "/",
        },
      ],
    },
  });
  expect(lateCompletion.status).toBe("cancelled");
  expect((await client.listSourceConnections()).items).not.toContainEqual(
    expect.objectContaining({ id: "fanbox/customudon" }),
  );
});

it("请求过期后不接受之后回传的浏览器上下文", async () => {
  const baseUrl = await startService();
  const client = createPublicApiClient({ baseUrl });
  const created = await client.createFanboxConnectionRequest({
    creatorId: "customudon",
  });
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse(created.request.expiresAt) + 1);

  try {
    const expired = await client.getFanboxConnectionRequest(created.request.id);
    expect(expired.status).toBe("expired");
    const lateCompletion = await client.completeFanboxConnectionRequest({
      requestId: created.request.id,
      pairingCode: created.pairingCode,
      browserCredential: syntheticBrowserCredential("synthetic-expired-value"),
    });
    expect(lateCompletion.status).toBe("expired");
  } finally {
    now.mockRestore();
  }

  expect((await client.listSourceConnections()).items).not.toContainEqual(
    expect.objectContaining({ id: "fanbox/customudon" }),
  );
});

it("FANBOX 验证失败时若请求已过期则报告过期", async () => {
  const verification = gatedSessionTransport(
    "synthetic-expired-verification-value",
  );
  const baseUrl = await startService(sourceIoWith(verification.transport));
  const client = createPublicApiClient({ baseUrl });
  const created = await client.createFanboxConnectionRequest({
    creatorId: "customudon",
  });
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse(created.request.createdAt) + 1);

  try {
    const completion = client.completeFanboxConnectionRequest({
      requestId: created.request.id,
      pairingCode: created.pairingCode,
      browserCredential: syntheticBrowserCredential(
        "synthetic-expired-verification-value",
      ),
    });
    await verification.started;
    expect(
      (await client.getFanboxConnectionRequest(created.request.id)).status,
    ).toBe("verifying");

    now.mockReturnValue(Date.parse(created.request.expiresAt) + 1);
    verification.release();
    expect((await completion).status).toBe("expired");
  } finally {
    verification.release();
    now.mockRestore();
  }

  expect((await client.listSourceConnections()).items).not.toContainEqual(
    expect.objectContaining({ id: "fanbox/customudon" }),
  );
});

it.each(["cancel", "revoke", "replacement"] as const)(
  "does not persist validation that finishes after pairing %s",
  async (interruption) => {
    const verification = gatedSessionTransport();
    const baseUrl = await startService(sourceIoWith(verification.transport));
    const client = createPublicApiClient({ baseUrl });
    const created = await client.createFanboxConnectionRequest({
      creatorId: "customudon",
    });

    const completion = client.completeFanboxConnectionRequest({
      requestId: created.request.id,
      pairingCode: created.pairingCode,
      browserCredential: syntheticBrowserCredential("synthetic-racing-value"),
    });
    await verification.started;
    expect(
      (await client.getFanboxConnectionRequest(created.request.id)).status,
    ).toBe("verifying");

    if (interruption === "cancel") {
      const cancelled = await client.cancelFanboxConnectionRequest({
        requestId: created.request.id,
        pairingCode: created.pairingCode,
      });
      expect(cancelled.status).toBe("cancelled");
    } else if (interruption === "revoke") {
      const revoked = await client.revokeFanboxSourceConnection({
        creatorId: "customudon",
        expectedVersion: 0,
      });
      expect(revoked.connection.credentialStatus).toBe("revoked");
      expect(
        (await client.getFanboxConnectionRequest(created.request.id)).status,
      ).toBe("superseded");
    } else {
      const replacement = await client.createFanboxConnectionRequest({
        creatorId: "customudon",
      });
      expect(
        (await client.getFanboxConnectionRequest(created.request.id)).status,
      ).toBe("superseded");
      verification.release();
      expect((await completion).status).toBe("superseded");
      expect(
        (
          await client.completeFanboxConnectionRequest({
            requestId: replacement.request.id,
            pairingCode: replacement.pairingCode,
            browserCredential: syntheticBrowserCredential(
              "synthetic-replacement-value",
            ),
          })
        ).status,
      ).toBe("succeeded");
    }

    if (interruption !== "replacement") {
      verification.release();
      expect((await completion).status).toBe(
        interruption === "cancel" ? "cancelled" : "superseded",
      );
    }
    const connection = (await client.listSourceConnections()).items.find(
      ({ id }) => id === "fanbox/customudon",
    );
    if (interruption === "cancel") expect(connection).toBeUndefined();
    else if (interruption === "replacement")
      expect(connection).toMatchObject({
        id: "fanbox/customudon",
        version: 1,
        credentialStatus: "configured",
        availability: "available",
      });
    else
      expect(connection).toMatchObject({
        id: "fanbox/customudon",
        version: 1,
        credentialStatus: "revoked",
      });
  },
);

function gatedSessionTransport(rejectedCookieValue?: string) {
  let releaseVerification!: () => void;
  let markVerificationStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markVerificationStarted = resolve;
  });
  const transport: FanboxEndpointSessionTransport = {
    async transact(input) {
      markVerificationStarted();
      await gate;
      const cookieValue = input.privateContext.cookies.find(
        ({ name }) => name === "FANBOXSESSID",
      )?.value;
      return await input.use(async (endpoint) => ({
        kind: "response",
        status: 200,
        mediaType: "application/json",
        body: new TextEncoder().encode(
          JSON.stringify(
            cookieValue === rejectedCookieValue
              ? { error: "controlled rejection" }
              : responseFor(endpoint.kind),
          ),
        ),
      }));
    },
    async close() {},
  };
  return { transport, started, release: releaseVerification };
}

async function startService(
  sourceIo: ProductSourceIo = refusingSourceIo(),
): Promise<URL> {
  const root = await mkdtemp(path.join(tmpdir(), "digital-fanbox-pairing-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  await prepareProductionCatalogue({ productDataDirectory });
  const bootstrap = await createProductService(
    {
      productDataDirectory,
      environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
      sourceIo,
    },
    { lifecycle: createIsolatedLifecycle() },
  );
  bootstraps.push(bootstrap);
  const server = serve({
    fetch: bootstrap.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  servers.push(server);
  await server.ready();
  bootstrap.publish();
  const baseUrl = new URL(server.url!);
  await waitUntilReady(baseUrl);
  return baseUrl;
}

function sourceIoWith(
  sessionTransport: FanboxEndpointSessionTransport,
): ProductSourceIo {
  return {
    mode: "controlled",
    request: async () => {
      throw new Error("受控连接验收不允许未声明的来源请求");
    },
    sessionTransport,
  };
}

function syntheticBrowserCredential(cookieValue: string) {
  return {
    userAgent: "controlled-browser/1",
    cookies: [
      {
        name: "FANBOXSESSID",
        value: cookieValue,
        domain: ".fanbox.cc",
        path: "/",
      },
    ],
  };
}

function responseFor(endpointKind: string): unknown {
  const post = {
    id: "9135862",
    creatorId: "customudon",
    title: "受控验收帖子",
    publishedDatetime: "2025-01-01T00:00:00+09:00",
  };
  switch (endpointKind) {
    case "login-status":
      return { body: 0 };
    case "creator-summaries":
      return { body: { posts: [post] } };
    case "post-detail":
      return { body: { post } };
    default:
      throw new Error("FANBOX 适配器请求了未定义的验收端点");
  }
}

function createIsolatedLifecycle() {
  return createProcessLifecycleRegistry({
    addSignalListener() {},
    removeSignalListener() {},
    forceExit() {},
  });
}

async function waitUntilReady(baseUrl: URL): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await fetch(new URL("/api/v1/source-connections", baseUrl))).ok)
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("受控 FANBOX 服务未就绪");
}

function refusingSourceIo(): ProductSourceIo {
  return {
    mode: "controlled",
    request: async () => {
      throw new Error("受控连接验收不允许未声明的来源请求");
    },
    sessionTransport: refusingSessionTransport(),
  };
}
