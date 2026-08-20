import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProductBangumiSourceConnection } from "../src/index.ts";

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

describe("Bangumi OAuth refresh across product processes", () => {
  it("keeps a live mutation owner authoritative across its TTL, then lets the waiter mutate after release", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-refresh-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    const privateDirectory = path.join(
      productDataDirectory,
      "private-source-connections",
    );
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    let monotonicNow = 1_000;
    let authorizationRequests = 0;
    const request = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(new URLSearchParams(init?.body).get("grant_type")).toBe(
        "authorization_code",
      );
      authorizationRequests += 1;
      return jsonResponse({
        access_token: `access-${authorizationRequests}`,
        refresh_token: `refresh-${authorizationRequests}`,
        expires_in: 3600,
      });
    });
    const clock = {
      monotonicNow: () => monotonicNow,
      bootId: () => "test-linux-boot",
    };
    const seed = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      ...clock,
    });
    await authorize(seed, "initial-code");

    let interleaved = false;
    let secondProcess: ProductBangumiSourceConnection;
    const firstProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      ...clock,
      afterConnectionMutationOwnershipCheck: () => {
        if (interleaved) return;
        interleaved = true;
        // A has passed its mutation-entry ownership check. Simulate an await
        // that runs beyond the old active-owner TTL before A commits.
        monotonicNow = 60_000;
        const mutationNamespace = path.join(
          privateDirectory,
          "bangumi-oauth-connection.mutation.json.namespace",
        );
        const namesBeforeWaiter = readdirSync(mutationNamespace).sort();
        const connectionBeforeWaiter = readFileSync(
          path.join(privateDirectory, "bangumi-oauth.json"),
          "utf8",
        );
        const startedAt = performance.now();

        expect(() => secondProcess.revoke(1)).toThrow(
          "Bangumi 来源连接正在被其他操作修改，请刷新后重试",
        );

        // The bounded busy path cannot publish a lease generation or mutate
        // the connection while A is the exact same-boot live owner.
        expect(performance.now() - startedAt).toBeLessThan(1_500);
        expect(readdirSync(mutationNamespace).sort()).toEqual(
          namesBeforeWaiter,
        );
        expect(
          readFileSync(
            path.join(privateDirectory, "bangumi-oauth.json"),
            "utf8",
          ),
        ).toBe(connectionBeforeWaiter);
      },
    });
    secondProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789HIJKLMN",
      ...clock,
    });

    expect(firstProcess.revoke(1)).toMatchObject({
      version: 2,
      credentialStatus: "revoked",
    });
    expect(interleaved).toBe(true);

    // Once A releases its immutable generation, B can acquire the same
    // mutation authority and durably reauthorize the connection.
    const started = secondProcess.beginAuthorization();
    const callback = new URL(environment.DIGITAL_BANGUMI_REDIRECT_URI);
    callback.searchParams.set("code", "after-release-code");
    callback.searchParams.set(
      "state",
      new URL(started.authorizationUrl).searchParams.get("state")!,
    );
    await expect(
      secondProcess.completeAuthorizationCallback(callback.toString()),
    ).resolves.toMatchObject({
      version: 3,
      credentialStatus: "configured",
      availability: "available",
    });
  });

  it("lets one lease holder rotate an expired grant while another process waits for its persisted access token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-refresh-"));
    temporaryRoots.push(root);
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    let refreshRequests = 0;
    let releaseRefresh:
      | ((response: ReturnType<typeof jsonResponse>) => void)
      | undefined;
    const refreshResponse = new Promise<ReturnType<typeof jsonResponse>>(
      (resolve) => {
        releaseRefresh = resolve;
      },
    );
    const request = vi.fn(async (_input: string, init?: RequestInit) => {
      const parameters = new URLSearchParams(init?.body);
      if (parameters.get("grant_type") === "authorization_code") {
        return jsonResponse({
          access_token: "initial-access",
          refresh_token: "initial-refresh",
          expires_in: 1,
        });
      }
      refreshRequests += 1;
      if (refreshRequests === 1) return await refreshResponse;
      expect(parameters.get("refresh_token")).toBe("rotated-refresh");
      return jsonResponse({
        access_token: "second-rotated-access",
        refresh_token: "second-rotated-refresh",
        expires_in: 3600,
      });
    });
    const productDataDirectory = path.join(root, "product-data");
    const firstProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    });
    await authorize(firstProcess, "initial-code");
    currentTime = new Date("2026-08-12T01:00:00.000Z");
    const secondProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
    });
    const context = {
      configurationReferences: ["source-connection/bangumi@1"],
    };

    const heldRefresh = firstProcess.authorization().bearer(context);
    await vi.waitFor(() => expect(refreshRequests).toBe(1));
    // Token rotation is private maintenance of the same frozen Source
    // Connection. A second workflow must not treat its configuration version
    // as replaced merely because the holder is between token request and
    // durable commit.
    expect(
      secondProcess.isConfigurationReferenceCurrent(
        "source-connection/bangumi@1",
      ),
    ).toBe(true);
    const waitingRefresh = secondProcess.authorization().bearer(context);
    releaseRefresh!(
      jsonResponse({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }),
    );

    await expect(Promise.all([heldRefresh, waitingRefresh])).resolves.toEqual([
      "rotated-access",
      "rotated-access",
    ]);
    expect(refreshRequests).toBe(1);

    const restartedProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
    });
    await expect(
      restartedProcess.authorization().bearer(context),
    ).resolves.toBe("rotated-access");
    expect(refreshRequests).toBe(1);

    currentTime = new Date("2026-08-12T03:00:00.000Z");
    await expect(
      restartedProcess.authorization().bearer(context),
    ).resolves.toBe("second-rotated-access");
    expect(refreshRequests).toBe(2);
  });

  it("keeps a transport-aborted refresh authorization-uncertain and never retries its old token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-refresh-"));
    temporaryRoots.push(root);
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    let refreshRequests = 0;
    let finishFailedRequest: (() => void) | undefined;
    const failedRequest = new Promise<void>((resolve) => {
      finishFailedRequest = resolve;
    });
    const request = vi.fn(async (_input: string, init?: RequestInit) => {
      const parameters = new URLSearchParams(init?.body);
      if (parameters.get("grant_type") === "authorization_code") {
        return jsonResponse({
          access_token: "initial-access",
          refresh_token: "initial-refresh",
          expires_in: 1,
        });
      }
      refreshRequests += 1;
      await failedRequest;
      throw new Error("temporary provider transport failure");
    });
    const productDataDirectory = path.join(root, "product-data");
    const firstProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    });
    await authorize(firstProcess, "initial-code");
    currentTime = new Date("2026-08-12T01:00:00.000Z");
    const secondProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
    });
    const context = {
      configurationReferences: ["source-connection/bangumi@1"],
    };

    const failedHolder = firstProcess.authorization().bearer(context);
    await vi.waitFor(() => expect(refreshRequests).toBe(1));
    const failedWaiter = secondProcess.authorization().bearer(context);
    finishFailedRequest!();

    await expect(failedHolder).rejects.toThrow("Bangumi OAuth 授权更新失败");
    await expect(failedWaiter).rejects.toThrow("Bangumi 来源连接当前不可用");
    expect(refreshRequests).toBe(1);
    expect(firstProcess.inspect()).toMatchObject({
      version: 1,
      credentialStatus: "configured",
      availability: "unavailable",
      reason: "authorization-uncertain",
    });
    expect(
      firstProcess.isConfigurationReferenceCurrent(
        "source-connection/bangumi@1",
      ),
    ).toBe(false);

    // A generic transport rejection cannot prove whether the provider already
    // rotated `initial-refresh`.  Even when the test transport would now
    // succeed, a later execution must require reauthorization instead of
    // sending that old token again.
    await expect(firstProcess.authorization().bearer(context)).rejects.toThrow(
      "Bangumi 来源连接当前不可用",
    );
    expect(refreshRequests).toBe(1);
  });

  it("only marks the current grant unavailable after an explicit OAuth authorization rejection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-refresh-"));
    temporaryRoots.push(root);
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    let refreshRequests = 0;
    const request = vi.fn(async (_input: string, init?: RequestInit) => {
      const parameters = new URLSearchParams(init?.body);
      if (parameters.get("grant_type") === "authorization_code") {
        return jsonResponse({
          access_token: "initial-access",
          refresh_token: "initial-refresh",
          expires_in: 1,
        });
      }
      refreshRequests += 1;
      return errorResponse(400, { error: "invalid_grant" });
    });
    const productDataDirectory = path.join(root, "product-data");
    const connection = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    });
    await authorize(connection, "initial-code");
    currentTime = new Date("2026-08-12T01:00:00.000Z");

    await expect(
      connection.authorization().bearer({
        configurationReferences: ["source-connection/bangumi@1"],
      }),
    ).rejects.toThrow("Bangumi OAuth 授权更新失败");
    expect(refreshRequests).toBe(1);
    expect(connection.inspect()).toMatchObject({
      version: 1,
      credentialStatus: "configured",
      availability: "unavailable",
      reason: "authorization-failed",
    });
  });

  it("does not let an old refresh overwrite a revoked and reauthorized connection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-refresh-"));
    temporaryRoots.push(root);
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    let releaseOldRefresh:
      | ((response: ReturnType<typeof jsonResponse>) => void)
      | undefined;
    const oldRefresh = new Promise<ReturnType<typeof jsonResponse>>(
      (resolve) => {
        releaseOldRefresh = resolve;
      },
    );
    let authorizationRequests = 0;
    let refreshRequests = 0;
    const request = vi.fn(async (_input: string, init?: RequestInit) => {
      const parameters = new URLSearchParams(init?.body);
      if (parameters.get("grant_type") === "refresh_token") {
        refreshRequests += 1;
        return await oldRefresh;
      }
      authorizationRequests += 1;
      return jsonResponse({
        access_token:
          authorizationRequests === 1 ? "initial-access" : "new-access",
        refresh_token:
          authorizationRequests === 1 ? "initial-refresh" : "new-refresh",
        expires_in: authorizationRequests === 1 ? 1 : 3600,
      });
    });
    const productDataDirectory = path.join(root, "product-data");
    const refreshingProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    });
    await authorize(refreshingProcess, "initial-code");
    currentTime = new Date("2026-08-12T01:00:00.000Z");
    const settingsProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789HIJKLMN",
    });
    const oldContext = {
      configurationReferences: ["source-connection/bangumi@1"],
    };
    const refresh = refreshingProcess.authorization().bearer(oldContext);
    await vi.waitFor(() => expect(refreshRequests).toBe(1));
    expect(settingsProcess.revoke(1)).toMatchObject({ version: 2 });
    await authorize(settingsProcess, "reauthorization-code");
    releaseOldRefresh!(
      jsonResponse({
        access_token: "old-rotated-access",
        refresh_token: "old-rotated-refresh",
        expires_in: 3600,
      }),
    );

    await expect(refresh).rejects.toThrow("Bangumi 来源连接已变化");
    await expect(
      refreshingProcess.authorization().bearer(oldContext),
    ).rejects.toThrow("Bangumi 来源连接当前不可用");
    expect(settingsProcess.inspect()).toMatchObject({
      version: 3,
      credentialStatus: "configured",
      availability: "available",
    });
    await expect(
      settingsProcess.authorization().bearer({
        configurationReferences: ["source-connection/bangumi@3"],
      }),
    ).resolves.toBe("new-access");
    expect(refreshRequests).toBe(1);
  });

  it("does not let an old OAuth rejection disable a reauthorized connection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-refresh-"));
    temporaryRoots.push(root);
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    let releaseOldRefresh:
      | ((response: ReturnType<typeof errorResponse>) => void)
      | undefined;
    const oldRefresh = new Promise<ReturnType<typeof errorResponse>>(
      (resolve) => {
        releaseOldRefresh = resolve;
      },
    );
    let authorizationRequests = 0;
    let refreshRequests = 0;
    const request = vi.fn(async (_input: string, init?: RequestInit) => {
      const parameters = new URLSearchParams(init?.body);
      if (parameters.get("grant_type") === "refresh_token") {
        refreshRequests += 1;
        return await oldRefresh;
      }
      authorizationRequests += 1;
      return jsonResponse({
        access_token:
          authorizationRequests === 1 ? "initial-access" : "new-access",
        refresh_token:
          authorizationRequests === 1 ? "initial-refresh" : "new-refresh",
        expires_in: authorizationRequests === 1 ? 1 : 3600,
      });
    });
    const productDataDirectory = path.join(root, "product-data");
    const refreshingProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    });
    await authorize(refreshingProcess, "initial-code");
    currentTime = new Date("2026-08-12T01:00:00.000Z");
    const settingsProcess = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
      now: () => currentTime,
      request,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789HIJKLMN",
    });
    const oldContext = {
      configurationReferences: ["source-connection/bangumi@1"],
    };
    const refresh = refreshingProcess.authorization().bearer(oldContext);
    await vi.waitFor(() => expect(refreshRequests).toBe(1));
    expect(settingsProcess.revoke(1)).toMatchObject({ version: 2 });
    await authorize(settingsProcess, "reauthorization-code");
    releaseOldRefresh!(errorResponse(400, { error: "invalid_grant" }));

    await expect(refresh).rejects.toThrow("Bangumi OAuth 授权更新失败");
    expect(settingsProcess.inspect()).toMatchObject({
      version: 3,
      credentialStatus: "configured",
      availability: "available",
    });
    await expect(
      settingsProcess.authorization().bearer({
        configurationReferences: ["source-connection/bangumi@3"],
      }),
    ).resolves.toBe("new-access");
    expect(refreshRequests).toBe(1);
  });
});

async function authorize(
  connection: ProductBangumiSourceConnection,
  code: string,
): Promise<void> {
  const started = connection.beginAuthorization();
  const callback = new URL(environment.DIGITAL_BANGUMI_REDIRECT_URI);
  callback.searchParams.set("code", code);
  callback.searchParams.set(
    "state",
    new URL(started.authorizationUrl).searchParams.get("state")!,
  );
  await connection.completeAuthorizationCallback(callback.toString());
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}

function errorResponse(status: number, body: unknown) {
  return {
    ok: false,
    status,
    headers: { get: () => "application/json" },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}
