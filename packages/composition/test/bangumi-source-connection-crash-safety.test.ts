import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProductBangumiSourceConnection } from "@digital/bangumi";
import { ProductSourceConnectionPrivateState } from "@digital/product-data";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryRoots: string[] = [];
const environment = {
  DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
  DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-client-secret",
  DIGITAL_BANGUMI_REDIRECT_URI:
    "https://digital.example.test/api/source-connections/bangumi/callback",
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Bangumi OAuth immutable private lease namespaces", () => {
  it("persists OAuth rotation uncertainty before provider success and requires reauthorization after interruption", async () => {
    const root = await temporaryRoot();
    const productDataDirectory = path.join(root, "product-data");
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    let authorizationRequests = 0;
    let refreshRequests = 0;
    const request = vi.fn(async (_input: string, init?: RequestInit) => {
      const parameters = new URLSearchParams(init?.body);
      if (parameters.get("grant_type") === "authorization_code") {
        authorizationRequests += 1;
        return response({
          access_token:
            authorizationRequests === 1 ? "initial-access" : "repaired-access",
          refresh_token:
            authorizationRequests === 1
              ? "initial-refresh"
              : "repaired-refresh",
          expires_in: authorizationRequests === 1 ? 1 : 3600,
        });
      }
      refreshRequests += 1;
      return response({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    });
    const initial = connection({
      productDataDirectory,
      now: () => currentTime,
      request,
    });
    await authorize(initial, "initial-code");
    currentTime = new Date("2026-08-12T01:00:00.000Z");
    const interrupted = new ProductBangumiSourceConnection({
      privateState:
        ProductSourceConnectionPrivateState.forRoot(productDataDirectory),
      environment,
      now: () => currentTime,
      request,
      beforeRefreshGrantCommit: () => {
        throw new Error("simulated process interruption");
      },
    });
    const frozenContext = {
      configurationReferences: ["source-connection/bangumi@1"],
    };

    await expect(
      interrupted.authorization().bearer(frozenContext),
    ).rejects.toThrow("Bangumi OAuth 授权更新失败");
    expect(refreshRequests).toBe(1);
    expect(interrupted.inspect()).toMatchObject({
      credentialStatus: "configured",
      availability: "unavailable",
      reason: "authorization-uncertain",
      version: 1,
    });

    const restarted = connection({
      productDataDirectory,
      now: () => currentTime,
      request,
    });
    await expect(
      restarted.authorization().bearer(frozenContext),
    ).rejects.toThrow("Bangumi 来源连接当前不可用");
    expect(refreshRequests).toBe(1);
    await authorize(restarted, "repair-code");
    expect(restarted.inspect()).toMatchObject({
      credentialStatus: "configured",
      availability: "available",
      version: 2,
    });
  });

  it("does not exchange an OAuth callback twice when two processes race to consume it", async () => {
    const root = await temporaryRoot();
    const productDataDirectory = path.join(root, "product-data");
    let exchanges = 0;
    const request = vi.fn(async () => {
      exchanges += 1;
      return response({
        access_token: "one-access",
        refresh_token: "one-refresh",
        expires_in: 3600,
      });
    });
    const first = connection({ productDataDirectory, request });
    const started = first.beginAuthorization();
    const callback = callbackFor(started.authorizationUrl, "one-time-code");
    const second = connection({ productDataDirectory, request });

    const results = await Promise.allSettled([
      first.completeAuthorizationCallback(callback),
      second.completeAuthorizationCallback(callback),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(exchanges).toBe(1);
  });

  it("fails closed for a symlinked immutable refresh namespace without issuing a provider request", async () => {
    const root = await temporaryRoot();
    const productDataDirectory = path.join(root, "product-data");
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    let refreshRequests = 0;
    const request = vi.fn(async (_input: string, init?: RequestInit) => {
      const parameters = new URLSearchParams(init?.body);
      if (parameters.get("grant_type") === "authorization_code") {
        return response({
          access_token: "initial-access",
          refresh_token: "initial-refresh",
          expires_in: 1,
        });
      }
      refreshRequests += 1;
      return response({
        access_token: "unexpected-access",
        refresh_token: "unexpected-refresh",
        expires_in: 3600,
      });
    });
    const source = connection({
      productDataDirectory,
      now: () => currentTime,
      request,
    });
    await authorize(source, "initial-code");
    const fingerprint = grantFingerprint({
      accessToken: "initial-access",
      refreshToken: "initial-refresh",
      expiresAt: "2026-08-12T00:00:01.000Z",
    });
    const privateDirectory = path.join(
      productDataDirectory,
      "private-source-connections",
    );
    const leasePath = path.join(
      privateDirectory,
      `bangumi-oauth-refresh-1-${fingerprint}.json`,
    );
    await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
    await symlink(path.join(root, "outside"), `${leasePath}.namespace`);
    currentTime = new Date("2026-08-12T01:00:00.000Z");

    await expect(
      source.authorization().bearer({
        configurationReferences: ["source-connection/bangumi@1"],
      }),
    ).rejects.toThrow("Bangumi OAuth 私有存储不可用");
    expect(refreshRequests).toBe(0);
  });

  it("uses no legacy reclaim, retired, or withdrawn pathname in the actual callback, refresh, and mutation flows", async () => {
    const root = await temporaryRoot();
    const productDataDirectory = path.join(root, "product-data");
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    const source = connection({
      productDataDirectory,
      now: () => currentTime,
      request: async (_input, init) => {
        const grantType = new URLSearchParams(init?.body).get("grant_type");
        return response(
          grantType === "authorization_code"
            ? {
                access_token: "initial-access",
                refresh_token: "initial-refresh",
                expires_in: 1,
              }
            : {
                access_token: "rotated-access",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
              },
        );
      },
    });
    await authorize(source, "initial-code");
    currentTime = new Date("2026-08-12T01:00:00.000Z");
    await source.authorization().bearer({
      configurationReferences: ["source-connection/bangumi@1"],
    });
    source.revoke(1);

    const names = await recursivelyListedNames(
      path.join(productDataDirectory, "private-source-connections"),
    );
    expect(
      names.some((name) => /(?:reclaim|retired|withdrawn)/u.test(name)),
    ).toBe(false);
    expect(names.some((name) => name.endsWith(".namespace"))).toBe(true);
  });
});

function connection(input: {
  readonly productDataDirectory: string;
  readonly now?: () => Date;
  readonly request: (
    input: string,
    init?: RequestInit,
  ) => Promise<ReturnType<typeof response>>;
}): ProductBangumiSourceConnection {
  return new ProductBangumiSourceConnection({
    privateState: ProductSourceConnectionPrivateState.forRoot(
      input.productDataDirectory,
    ),
    environment,
    ...(input.now === undefined ? {} : { now: input.now }),
    request: input.request,
    nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  });
}

async function authorize(
  source: ProductBangumiSourceConnection,
  code: string,
): Promise<void> {
  const started = source.beginAuthorization();
  await source.completeAuthorizationCallback(
    callbackFor(started.authorizationUrl, code),
  );
}

function callbackFor(authorizationUrl: string, code: string): string {
  const callback = new URL(environment.DIGITAL_BANGUMI_REDIRECT_URI);
  callback.searchParams.set("code", code);
  callback.searchParams.set(
    "state",
    new URL(authorizationUrl).searchParams.get("state")!,
  );
  return callback.toString();
}

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}

function grantFingerprint(grant: {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
}): string {
  return createHash("sha256")
    .update(grant.accessToken)
    .update("\u0000")
    .update(grant.refreshToken)
    .update("\u0000")
    .update(grant.expiresAt)
    .digest("base64url");
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-crash-"));
  temporaryRoots.push(root);
  return root;
}

async function recursivelyListedNames(
  root: string,
): Promise<readonly string[]> {
  const names: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    names.push(entry.name);
    if (entry.isDirectory()) {
      names.push(
        ...(await recursivelyListedNames(path.join(root, entry.name))),
      );
    }
  }
  return names;
}
