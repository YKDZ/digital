import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductSourceIo } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import { createPublicApiClient } from "@digital/public-api";
import { refusingSessionTransport } from "@digital/test-support/source-io";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { createProductService } from "../src/service.ts";

const servers: Array<Awaited<ReturnType<typeof serve>>> = [];
const bootstraps: Array<Awaited<ReturnType<typeof createProductService>>> = [];
const temporaryRoots: string[] = [];
const terminalChildren: Array<ReturnType<typeof spawn>> = [];
let releaseVerification: (() => void) | undefined;
let releaseBangumiExchange: (() => void) | undefined;

afterEach(async () => {
  releaseBangumiExchange?.();
  releaseBangumiExchange = undefined;
  releaseVerification?.();
  releaseVerification = undefined;
  for (const child of terminalChildren.splice(0).reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else child.kill("SIGTERM");
    }
  }
  for (const server of servers.splice(0).reverse()) await server.close(true);
  for (const bootstrap of bootstraps.splice(0).reverse())
    await bootstrap.abort();
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("在真实服务中授权、替换并撤销 Bangumi 连接", async () => {
  const clientSecret = "controlled-bangumi-client-secret";
  const accessTokens = [
    "controlled-bangumi-access-token",
    "controlled-bangumi-replacement-access-token",
  ];
  const refreshTokens = [
    "controlled-bangumi-refresh-token",
    "controlled-bangumi-replacement-refresh-token",
  ];
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    request: async (input, init) => {
      const url = new URL(input);
      if (
        url.host !== "bgm.tv" ||
        url.pathname !== "/oauth/access_token" ||
        init?.method !== "POST"
      ) {
        throw new Error("受控验收遇到未声明的 OAuth 请求");
      }
      const parameters = new URLSearchParams(String(init.body));
      expect(parameters.get("client_secret")).toBe(clientSecret);
      const code = parameters.get("code");
      const grantIndex =
        code === "controlled-authorization-code"
          ? 0
          : code === "controlled-replacement-code"
            ? 1
            : -1;
      expect(grantIndex).toBeGreaterThanOrEqual(0);
      return verificationResponse(
        true,
        url.toString(),
        JSON.stringify({
          access_token: accessTokens[grantIndex],
          refresh_token: refreshTokens[grantIndex],
          expires_in: 3600,
        }),
      );
    },
    sessionTransport: refusingSessionTransport(),
  };
  const { baseUrl, callbackUri, productDataDirectory } =
    await startBangumiOAuthService(sourceIo, {
      clientId: "controlled-bangumi-client",
      clientSecret,
    });
  const client = createPublicApiClient({ baseUrl });

  const authorization = await client.beginBangumiAuthorization();
  const authorizationUrl = new URL(authorization.authorizationUrl);
  expect(authorizationUrl.origin).toBe("https://bgm.tv");
  expect(authorizationUrl.pathname).toBe("/oauth/authorize");
  expect(authorizationUrl.searchParams.get("client_id")).toBe(
    "controlled-bangumi-client",
  );
  expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(callbackUri);
  expect(authorization.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT/u);
  await expect(
    client.getBangumiAuthorizationAttempt(authorization.attemptId),
  ).resolves.toMatchObject({ status: "waiting" });

  const callback = new URL(callbackUri);
  callback.searchParams.set("code", "untrusted-authorization-code");
  callback.searchParams.set("state", "untrusted-state");
  const rejected = await fetch(callback);
  const rejectedText = await rejected.text();
  expect(rejected.status).toBe(400);
  expect(rejectedText).not.toContain("untrusted-authorization-code");
  expect(rejectedText).not.toContain("untrusted-state");
  await expect(
    client.getBangumiAuthorizationAttempt(authorization.attemptId),
  ).resolves.toMatchObject({ status: "waiting" });

  callback.search = "";
  callback.searchParams.set("code", "controlled-authorization-code");
  callback.searchParams.set(
    "state",
    authorizationUrl.searchParams.get("state") ?? "missing-state",
  );
  const completed = await fetch(callback);
  const completedText = await completed.text();
  expect(completed.status).toBe(200);
  expect(completed.headers.get("content-type")).toContain("text/html");
  expect(completedText).toContain("授权已完成");
  expect(completedText).not.toContain(accessTokens[0]);
  expect(completedText).not.toContain(refreshTokens[0]);
  expect(completedText).not.toContain(clientSecret);
  expect(completed.headers.get("referrer-policy")).toBe("no-referrer");
  expect(completed.headers.get("cache-control")).toBe("no-store");
  expect(completed.headers.get("x-content-type-options")).toBe("nosniff");
  await expect(
    client.getBangumiAuthorizationAttempt(authorization.attemptId),
  ).resolves.toMatchObject({
    attemptId: authorization.attemptId,
    status: "succeeded",
  });

  const replacement = await client.beginBangumiAuthorization();
  const replacementCallback = new URL(callbackUri);
  replacementCallback.searchParams.set("code", "controlled-replacement-code");
  replacementCallback.searchParams.set(
    "state",
    new URL(replacement.authorizationUrl).searchParams.get("state") ?? "",
  );
  expect((await fetch(replacementCallback)).status).toBe(200);
  await expect(
    client.getBangumiAuthorizationAttempt(replacement.attemptId),
  ).resolves.toMatchObject({ status: "succeeded" });

  const current = await fetch(
    new URL("/api/v1/source-connections/bangumi", baseUrl),
  );
  expect(current.status).toBe(200);
  const currentText = await current.text();
  expect(currentText).toContain('"id":"bangumi"');
  expect(currentText).toContain('"availability":"available"');
  expect(currentText).not.toContain(accessTokens[1]);
  expect(currentText).not.toContain(refreshTokens[1]);
  expect(currentText).not.toContain(clientSecret);
  await expect(Promise.resolve(JSON.parse(currentText))).resolves.toMatchObject(
    {
      id: "bangumi",
      credentialStatus: "configured",
      availability: "available",
      version: 2,
    },
  );
  await expect(
    client.revokeBangumiSourceConnection({ expectedVersion: 1 }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });
  await expect(client.getSourceConnection("bangumi")).resolves.toMatchObject({
    version: 2,
    credentialStatus: "configured",
    availability: "available",
  });
  await expect(
    client.revokeBangumiSourceConnection({ expectedVersion: 2 }),
  ).resolves.toMatchObject({
    revoked: true,
    connection: {
      id: "bangumi",
      version: 3,
      credentialStatus: "revoked",
      availability: "unavailable",
    },
  });
  await expect(client.getSourceConnection("bangumi")).resolves.toMatchObject({
    version: 3,
    credentialStatus: "revoked",
    availability: "unavailable",
  });
  await writeFile(
    path.join(
      productDataDirectory,
      "private-source-connections",
      "bangumi-oauth.json",
    ),
    "{corrupt private storage",
  );
  await expect(
    client.revokeBangumiSourceConnection({ expectedVersion: 3 }),
  ).rejects.toMatchObject({ kind: "unavailable", status: 503 });
});

it("经公共 API 配置 Bangumi OAuth 应用并沿用正式私密授权流程", async () => {
  const clientId = "controlled-public-client";
  const clientSecret = "controlled-public-client-secret";
  const replacementClientId = "controlled-public-client-replacement";
  const replacementClientSecret = "controlled-public-client-replacement-secret";
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    request: async (input, init) => {
      const url = new URL(input);
      if (
        url.host !== "bgm.tv" ||
        url.pathname !== "/oauth/access_token" ||
        init?.method !== "POST"
      ) {
        throw new Error("受控验收遇到未声明的 OAuth 请求");
      }
      const parameters = new URLSearchParams(String(init.body));
      const requestSecret = parameters.get("client_secret");
      const requestClientId = parameters.get("client_id");
      expect([
        [clientId, clientSecret],
        [replacementClientId, replacementClientSecret],
      ]).toContainEqual([requestClientId, requestSecret]);
      return verificationResponse(
        true,
        url.toString(),
        JSON.stringify({
          access_token: `controlled-${requestClientId}-access-token`,
          refresh_token: `controlled-${requestClientId}-refresh-token`,
          expires_in: 3600,
        }),
      );
    },
    sessionTransport: refusingSessionTransport(),
  };
  const baseUrl = await startService(sourceIo);
  const client = createPublicApiClient({ baseUrl });
  const callbackUri = new URL(
    "/api/v1/source-connections/bangumi/callback",
    baseUrl,
  ).toString();

  const configured = await client.configureBangumiOAuthClient({
    clientId,
    clientSecret,
    redirectUri: callbackUri,
  });
  expect(configured).toEqual({ configured: true });
  expect(JSON.stringify(configured)).not.toContain(clientSecret);

  const authorization = await client.beginBangumiAuthorization();
  const authorizationUrl = new URL(authorization.authorizationUrl);
  expect(authorizationUrl.searchParams.get("client_id")).toBe(clientId);
  expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(callbackUri);
  const callback = new URL(callbackUri);
  callback.searchParams.set("code", "controlled-public-authorization-code");
  callback.searchParams.set(
    "state",
    authorizationUrl.searchParams.get("state") ?? "missing-state",
  );
  const callbackResponse = await fetch(callback);
  const callbackText = await callbackResponse.text();
  expect(callbackResponse.status).toBe(200);
  expect(callbackText).not.toContain(clientSecret);
  await expect(
    client.getBangumiAuthorizationAttempt(authorization.attemptId),
  ).resolves.toMatchObject({ status: "succeeded" });
  await expect(client.getSourceConnection("bangumi")).resolves.toMatchObject({
    availability: "available",
    credentialStatus: "configured",
  });

  await expect(
    client.configureBangumiOAuthClient({
      clientId: replacementClientId,
      clientSecret: replacementClientSecret,
      redirectUri: callbackUri,
    }),
  ).resolves.toEqual({ configured: true });
  await expect(client.getSourceConnection("bangumi")).resolves.toMatchObject({
    availability: "unavailable",
    credentialStatus: "revoked",
    version: 3,
  });
  const replacementAuthorization = await client.beginBangumiAuthorization();
  expect(
    new URL(replacementAuthorization.authorizationUrl).searchParams.get(
      "client_id",
    ),
  ).toBe(replacementClientId);
  const replacementCallback = new URL(callbackUri);
  replacementCallback.searchParams.set(
    "code",
    "controlled-public-replacement-code",
  );
  replacementCallback.searchParams.set(
    "state",
    new URL(replacementAuthorization.authorizationUrl).searchParams.get(
      "state",
    ) ?? "missing-state",
  );
  expect((await fetch(replacementCallback)).status).toBe(200);
  await expect(
    client.getBangumiAuthorizationAttempt(replacementAuthorization.attemptId),
  ).resolves.toMatchObject({ status: "succeeded" });

  const ordinaryConfiguration = await fetch(
    new URL("/api/v1/source-connections", baseUrl),
  );
  const ordinaryText = await ordinaryConfiguration.text();
  expect(ordinaryText).not.toContain(clientId);
  expect(ordinaryText).not.toContain(clientSecret);
  expect(ordinaryText).not.toContain("controlled-public-access-token");
}, 20_000);

it("拒绝无效 Bangumi OAuth 配置且不把提交的密钥放进错误响应", async () => {
  const baseUrl = await startService({
    mode: "controlled",
    request: async () => {
      throw new Error("无效配置验收不应发起外部请求");
    },
    sessionTransport: refusingSessionTransport(),
  });
  const clientSecret = "private-invalid-client-secret";
  const response = await fetch(
    new URL("/api/v1/source-connections/bangumi/client-configuration", baseUrl),
    jsonRequest("PUT", {
      clientId: "controlled-client",
      clientSecret,
      redirectUri: "http://example.com/callback",
    }),
  );
  const body = await response.text();
  expect(response.status).toBe(400);
  expect(body).not.toContain(clientSecret);
  expect(body).not.toContain("example.com");
});

it("Bangumi 替换授权失败时保留旧连接并向浏览器报告失败", async () => {
  const clientSecret = "controlled-bangumi-client-secret";
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    request: async (input, init) => {
      const url = new URL(input);
      if (url.host !== "bgm.tv" || url.pathname !== "/oauth/access_token")
        throw new Error("受控验收遇到未声明的 OAuth 请求");
      const code = new URLSearchParams(String(init?.body)).get("code");
      if (code !== "initial-code")
        return verificationResponse(
          false,
          url.toString(),
          '{"error":"failed"}',
        );
      return verificationResponse(
        true,
        url.toString(),
        JSON.stringify({
          access_token: "controlled-initial-access",
          refresh_token: "controlled-initial-refresh",
          expires_in: 3600,
        }),
      );
    },
    sessionTransport: refusingSessionTransport(),
  };
  const { baseUrl, callbackUri } = await startBangumiOAuthService(sourceIo, {
    clientId: "controlled-bangumi-client",
    clientSecret,
  });
  const client = createPublicApiClient({ baseUrl });
  const initial = await client.beginBangumiAuthorization();
  const initialCallback = new URL(callbackUri);
  initialCallback.searchParams.set("code", "initial-code");
  initialCallback.searchParams.set(
    "state",
    new URL(initial.authorizationUrl).searchParams.get("state") ?? "",
  );
  expect((await fetch(initialCallback)).status).toBe(200);

  const replacement = await client.beginBangumiAuthorization();
  const deniedCallback = new URL(callbackUri);
  deniedCallback.searchParams.set("error", "server_error");
  deniedCallback.searchParams.set(
    "error_description",
    "provider-private-detail",
  );
  deniedCallback.searchParams.set(
    "state",
    new URL(replacement.authorizationUrl).searchParams.get("state") ?? "",
  );
  const denied = await fetch(deniedCallback);
  const deniedText = await denied.text();
  expect(denied.status).toBe(200);
  expect(deniedText).toContain("Bangumi 授权失败");
  expect(deniedText).not.toContain("provider-private-detail");
  await expect(
    client.getBangumiAuthorizationAttempt(replacement.attemptId),
  ).resolves.toMatchObject({ status: "failed" });
  const current = await client.getSourceConnection("bangumi");
  expect(current).toMatchObject({
    version: 1,
    credentialStatus: "configured",
    availability: "available",
  });
  expect(JSON.stringify(current)).not.toContain("controlled-initial-access");

  const userCancelled = await client.beginBangumiAuthorization();
  const cancellationCallback = new URL(callbackUri);
  cancellationCallback.searchParams.set("error", "access_denied");
  cancellationCallback.searchParams.set(
    "state",
    new URL(userCancelled.authorizationUrl).searchParams.get("state") ?? "",
  );
  const cancellationResponse = await fetch(cancellationCallback);
  expect(await cancellationResponse.text()).toContain("Bangumi 授权已取消");
  await expect(
    client.getBangumiAuthorizationAttempt(userCancelled.attemptId),
  ).resolves.toMatchObject({ status: "cancelled" });
  await expect(client.getSourceConnection("bangumi")).resolves.toMatchObject({
    version: 1,
    availability: "available",
    credentialStatus: "configured",
  });
});

it("取消正在兑换的 Bangumi 授权会报告处理中且不会覆盖晚到的成功结果", async () => {
  const clientSecret = "controlled-bangumi-client-secret";
  let markExchangeStarted!: (value: void) => void;
  const exchangeStarted = new Promise<void>((resolve) => {
    markExchangeStarted = resolve;
  });
  let finishExchange!: (
    response: ReturnType<typeof verificationResponse>,
  ) => void;
  const exchangeResponse = new Promise<ReturnType<typeof verificationResponse>>(
    (resolve) => {
      finishExchange = resolve;
    },
  );
  releaseBangumiExchange = () =>
    finishExchange(
      verificationResponse(false, "https://bgm.tv/oauth/access_token"),
    );
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    request: async (input, init) => {
      const url = new URL(input);
      if (
        url.host !== "bgm.tv" ||
        url.pathname !== "/oauth/access_token" ||
        init?.method !== "POST"
      ) {
        throw new Error("受控验收遇到未声明的 OAuth 请求");
      }
      markExchangeStarted(undefined);
      return await exchangeResponse;
    },
    sessionTransport: refusingSessionTransport(),
  };
  const { baseUrl, callbackUri } = await startBangumiOAuthService(sourceIo, {
    clientId: "controlled-bangumi-client",
    clientSecret,
  });
  const client = createPublicApiClient({ baseUrl });
  const authorization = await client.beginBangumiAuthorization();
  const callback = new URL(callbackUri);
  callback.searchParams.set("code", "controlled-authorization-code");
  callback.searchParams.set(
    "state",
    new URL(authorization.authorizationUrl).searchParams.get("state") ?? "",
  );

  const callbackResponse = fetch(callback).catch(() => undefined);
  await exchangeStarted;
  await expect(
    client.cancelBangumiAuthorization(authorization.attemptId),
  ).resolves.toMatchObject({
    attemptId: authorization.attemptId,
    status: "processing",
  });
  await expect(
    client.getBangumiAuthorizationAttempt(authorization.attemptId),
  ).resolves.toMatchObject({ status: "processing" });
  await expect(client.beginBangumiAuthorization()).rejects.toMatchObject({
    kind: "conflict",
  });

  finishExchange(
    verificationResponse(
      true,
      "https://bgm.tv/oauth/access_token",
      JSON.stringify({
        access_token: "controlled-late-access",
        refresh_token: "controlled-late-refresh",
        expires_in: 3600,
      }),
    ),
  );
  releaseBangumiExchange = undefined;
  expect((await callbackResponse)?.status).toBe(200);
  await expect(
    client.getBangumiAuthorizationAttempt(authorization.attemptId),
  ).resolves.toMatchObject({ status: "succeeded" });
  await expect(client.getSourceConnection("bangumi")).resolves.toMatchObject({
    availability: "available",
    credentialStatus: "configured",
    version: 1,
  });
});

it("在真实服务中先报告待配置，验证期间保持不可用并在成功后读回状态", async () => {
  const controlledAccessToken = "controlled-test-access-token";
  const controlledReplacementToken = "controlled-replacement-access-token";
  let beginFirstVerification!: () => void;
  const verificationStarted = new Promise<void>((resolve) => {
    beginFirstVerification = resolve;
  });
  let beginReplacementVerification!: () => void;
  const replacementVerificationStarted = new Promise<void>((resolve) => {
    beginReplacementVerification = resolve;
  });
  let finishVerification!: () => void;
  const verificationGate = new Promise<void>((resolve) => {
    finishVerification = resolve;
  });
  releaseVerification = finishVerification;
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    request: async (input, init) => {
      const url = new URL(input);
      if (
        url.host === "api.themoviedb.org" &&
        url.pathname === "/3/authentication"
      ) {
        const headers = init?.headers as Record<string, string> | undefined;
        const authorization = headers?.Authorization;
        if (authorization === `Bearer ${controlledAccessToken}`)
          beginFirstVerification();
        else if (authorization === `Bearer ${controlledReplacementToken}`)
          beginReplacementVerification();
        else throw new Error("受控验收收到未知的 TMDB 访问令牌");
        await verificationGate;
        return verificationResponse(
          authorization === `Bearer ${controlledAccessToken}` ||
            authorization === `Bearer ${controlledReplacementToken}`,
          url.toString(),
        );
      }
      throw new Error("受控验收遇到未声明的外部请求");
    },
    sessionTransport: refusingSessionTransport(),
  };
  const baseUrl = await startService(sourceIo);
  const client = createPublicApiClient({ baseUrl });
  await expect
    .poll(
      async () => {
        const response = await fetch(new URL("/api/ready", baseUrl), {
          signal: AbortSignal.timeout(1_000),
        });
        return {
          status: response.status,
          body: await response.json(),
        };
      },
      { timeout: 60_000, interval: 100 },
    )
    .toMatchObject({ status: 200, body: { ok: true } });

  const beforeState = await client.listSourceConnections();
  expect(beforeState.items).toContainEqual(
    expect.objectContaining({
      id: "tmdb",
      credentialStatus: "unconfigured",
      availability: "unavailable",
    }),
  );
  expect(beforeState.items).toContainEqual(
    expect.objectContaining({
      id: "omdb",
      credentialStatus: "unconfigured",
      availability: "unavailable",
    }),
  );

  const configureResponse = fetch(
    new URL("/api/v1/source-connections/tmdb", baseUrl),
    jsonRequest("POST", {
      expectedVersion: 0,
      secret: controlledAccessToken,
    }),
  );
  await verificationStarted;

  const during = await fetch(
    new URL("/api/v1/source-connections/tmdb", baseUrl),
  );
  expect(during.status).toBe(200);
  const duringText = await during.text();
  expect(duringText).toContain('"availability":"unavailable"');
  expect(duringText).toContain('"reason":"verification-pending"');
  expect(duringText).not.toContain(controlledAccessToken);

  const replacement = client.replaceSourceConnection({
    sourceId: "tmdb",
    expectedVersion: 1,
    secret: controlledReplacementToken,
  });
  await replacementVerificationStarted;
  const replacedDuring = await client.getSourceConnection("tmdb");
  expect(replacedDuring).toMatchObject({
    version: 2,
    availability: "unavailable",
    reason: "verification-pending",
  });
  expect(JSON.stringify(replacedDuring)).not.toContain(
    controlledReplacementToken,
  );

  finishVerification();
  const configured = await configureResponse;
  expect(configured.status).toBe(200);
  const configuredText = await configured.text();
  expect(configuredText).toContain('"verification":"superseded"');
  expect(configuredText).not.toContain(controlledAccessToken);
  await expect(replacement).resolves.toMatchObject({
    verification: "verified",
    connection: { version: 2, availability: "available" },
  });
  const current = await client.getSourceConnection("tmdb");
  expect(current).toMatchObject({
    version: 2,
    credentialStatus: "configured",
    availability: "available",
  });
  expect(JSON.stringify(current)).not.toContain(controlledReplacementToken);
}, 70_000);

it("分别验证 OMDb、替换失败、版本冲突和撤销结果", async () => {
  const controlledTmdbToken = "controlled-tmdb-token";
  const controlledOmdbKey = "controlled-omdb-key";
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    request: async (input, init) => {
      const url = new URL(input);
      if (
        url.host === "api.themoviedb.org" &&
        url.pathname === "/3/authentication"
      ) {
        const headers = init?.headers as Record<string, string> | undefined;
        return verificationResponse(
          headers?.Authorization === `Bearer ${controlledTmdbToken}`,
          url.toString(),
        );
      }
      if (url.host === "www.omdbapi.com") {
        const valid = url.searchParams.get("apikey") === controlledOmdbKey;
        return verificationResponse(
          true,
          "https://www.omdbapi.com/",
          JSON.stringify(
            valid
              ? { Response: "True", imdbID: "tt3896198" }
              : { Response: "False", Error: "Invalid API key!" },
          ),
        );
      }
      throw new Error("受控验收遇到未声明的外部请求");
    },
    sessionTransport: refusingSessionTransport(),
  };
  const baseUrl = await startService(sourceIo);
  const client = createPublicApiClient({ baseUrl });

  const tmdbConfigured = await fetch(
    new URL("/api/v1/source-connections/tmdb", baseUrl),
    jsonRequest("POST", {
      expectedVersion: 0,
      secret: controlledTmdbToken,
    }),
  );
  const tmdbConfiguredText = await tmdbConfigured.text();
  expect(tmdbConfigured.status).toBe(200);
  expect(tmdbConfiguredText).toContain('"verification":"verified"');
  expect(tmdbConfiguredText).not.toContain(controlledTmdbToken);

  const tmdbReplacement = await client.replaceSourceConnection({
    sourceId: "tmdb",
    expectedVersion: 1,
    secret: "controlled-invalid-tmdb-token",
  });
  expect(tmdbReplacement.verification).toBe("failed");
  expect(JSON.stringify(tmdbReplacement)).not.toContain(
    "controlled-invalid-tmdb-token",
  );
  const failedReplacementState = await fetch(
    new URL("/api/v1/source-connections/tmdb", baseUrl),
  );
  const failedReplacementText = await failedReplacementState.text();
  expect(failedReplacementState.status).toBe(200);
  expect(failedReplacementText).toContain('"reason":"verification-failed"');
  expect(failedReplacementText).toContain('"availability":"unavailable"');
  expect(failedReplacementText).not.toContain("controlled-invalid-tmdb-token");

  await expect(
    client.replaceSourceConnection({
      sourceId: "tmdb",
      expectedVersion: 1,
      secret: "controlled-stale-tmdb-token",
    }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });

  const omdbConfigured = await client.configureSourceConnection({
    sourceId: "omdb",
    expectedVersion: 0,
    secret: controlledOmdbKey,
  });
  expect(omdbConfigured.verification).toBe("verified");
  expect(JSON.stringify(omdbConfigured)).not.toContain(controlledOmdbKey);

  const revoked = await client.revokeSourceConnection({
    sourceId: "tmdb",
    expectedVersion: 2,
  });
  expect(revoked).toMatchObject({
    revoked: true,
    connection: { credentialStatus: "revoked" },
  });
  expect(JSON.stringify(revoked)).not.toContain(controlledTmdbToken);
});

it("安装的 TUI 通过真实服务隐藏密钥输入并立即验证【安装客户端】", async () => {
  const controlledAccessToken = "controlled-pty-access-token";
  const controlledConcurrentToken = "controlled-pty-concurrent-token";
  let verifiedAuthorization: string | undefined;
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    request: async (input, init) => {
      const url = new URL(input);
      if (
        url.host === "api.themoviedb.org" &&
        url.pathname === "/3/authentication"
      ) {
        const headers = init?.headers as Record<string, string> | undefined;
        verifiedAuthorization = headers?.Authorization;
        return verificationResponse(
          verifiedAuthorization === `Bearer ${controlledAccessToken}` ||
            verifiedAuthorization === `Bearer ${controlledConcurrentToken}`,
          url.toString(),
        );
      }
      throw new Error("受控验收遇到未声明的外部请求");
    },
    sessionTransport: refusingSessionTransport(),
  };
  const baseUrl = await startService(sourceIo);
  const concurrentClient = createPublicApiClient({ baseUrl });
  const terminalCommand = [
    "stty cols 58 rows 16 -icanon -echo",
    "terminalModeBefore=$(stty -g)",
    `pnpm --filter @digital/service exec digital-tui --url ${shellQuote(baseUrl.origin)}`,
    "terminalModeAfter=$(stty -g)",
    'if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi',
  ].join("; ");
  const child = spawn("script", ["-qfec", terminalCommand, "/dev/null"], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: "58", LINES: "16" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  terminalChildren.push(child);
  const childClosed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let terminalOutput = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk: Buffer) => {
    terminalOutput += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString("utf8");
  });
  const waitForText = async (value: string, after = 0, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (terminalOutput.slice(after).includes(value)) return;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `TUI 提前退出，未显示“${value}”：${errorOutput}\n${terminalOutput.slice(-3000)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `TUI 未显示“${value}”：${errorOutput}\n${terminalOutput.slice(-3000)}`,
    );
  };
  const send = (value: string) => {
    const after = terminalOutput.length;
    child.stdin.write(value);
    return after;
  };

  await waitForText("还没有资产库");
  await waitForText("TMDB：待配置", send("7"));
  await waitForText("设置TMDB密钥", send("\r"));
  await waitForText(
    "•".repeat(Math.min(24, controlledAccessToken.length)),
    send(controlledAccessToken),
  );
  const concurrentConfiguration =
    await concurrentClient.configureSourceConnection({
      sourceId: "tmdb",
      expectedVersion: 0,
      secret: controlledConcurrentToken,
    });
  expect(concurrentConfiguration.verification).toBe("verified");
  await waitForText("来源连接已被其他操作更改", send("\r"));
  await waitForText("TMDB：可用", send("r"));
  await waitForText("设置TMDB密钥", send("\r"));
  await waitForText(
    "•".repeat(Math.min(24, controlledAccessToken.length)),
    send(controlledAccessToken),
  );
  await waitForText("验证成功，来源连接已可用", send("\r"));
  expect(verifiedAuthorization).toBe(`Bearer ${controlledAccessToken}`);
  expect(terminalOutput).not.toContain(controlledAccessToken);
  expect(terminalOutput).not.toContain(controlledConcurrentToken);

  await waitForText("还没有资产库", send("q"));
  send("q");
  child.stdin.end();
  const exitCode = await childClosed;
  expect(exitCode, `${errorOutput}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(terminalOutput).not.toContain(controlledAccessToken);
  expect(terminalOutput).not.toContain(controlledConcurrentToken);
}, 20_000);

it("安装的 TUI 显示 Bangumi 授权目标并报告明确取消结果【安装客户端】", async () => {
  const clientSecret = "controlled-tui-bangumi-client-secret";
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    request: async () => {
      throw new Error("取消验收不应发起外部请求");
    },
    sessionTransport: refusingSessionTransport(),
  };
  const { baseUrl } = await startBangumiOAuthService(sourceIo, {
    clientId: "controlled-bangumi-client",
    clientSecret,
  });
  const publicClient = createPublicApiClient({ baseUrl });
  const terminalCommand = [
    "stty cols 100 rows 20 -icanon -echo",
    "terminalModeBefore=$(stty -g)",
    `pnpm --filter @digital/service exec digital-tui --url ${shellQuote(baseUrl.origin)}`,
    "terminalModeAfter=$(stty -g)",
    'if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi',
  ].join("; ");
  const child = spawn("script", ["-qfec", terminalCommand, "/dev/null"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLUMNS: "100",
      LINES: "20",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  terminalChildren.push(child);
  const childClosed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let terminalOutput = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk: Buffer) => {
    terminalOutput += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString("utf8");
  });
  const waitForText = async (value: string, after = 0, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (terminalOutput.slice(after).includes(value)) return;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `TUI 提前退出，未显示“${value}”：${errorOutput}\n${terminalOutput.slice(-3000)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `TUI 未显示“${value}”：${errorOutput}\n${terminalOutput.slice(-3000)}`,
    );
  };
  const send = (value: string) => {
    const after = terminalOutput.length;
    child.stdin.write(value);
    return after;
  };

  await waitForText("还没有资产库");
  await waitForText("Bangumi：待配置", send("7"));
  await waitForText("› OMDb：待配置", send("\u001b[B"));
  await waitForText("› Bangumi：待配置", send("\u001b[B"));
  await waitForText("在你自己的浏览器", send("\r"));
  await waitForText("目标实例：");
  await waitForText("授权地址：");
  expect(terminalOutput).toContain(baseUrl.host);
  expect(terminalOutput).not.toContain(clientSecret);
  await waitForText("当前状态：授权已取消", send("x"));
  await waitForText("› Bangumi：待配置", send("q"));
  const competingAuthorization = await publicClient.beginBangumiAuthorization();
  const failedStartOutput = send("\r");
  await waitForText("Bangumi 授权正在处理", failedStartOutput);
  expect(terminalOutput.slice(failedStartOutput)).not.toContain(
    "设置Bangumi密钥",
  );
  await publicClient.cancelBangumiAuthorization(
    competingAuthorization.attemptId,
  );
  await waitForText("还没有资产库", send("q"));
  send("q");
  child.stdin.end();
  const exitCode = await childClosed;
  expect(exitCode, `${errorOutput}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(terminalOutput).not.toContain(clientSecret);
}, 20_000);

async function startService(sourceIo: ProductSourceIo): Promise<URL> {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-source-connection-http-"),
  );
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  await mkdir(path.join(root, "ordinary-materials"));
  await prepareProductionCatalogue({ productDataDirectory });
  const bootstrap = await createProductService({
    productDataDirectory,
    environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
    sourceIo,
  });
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
  return new URL(server.url!);
}

async function startBangumiOAuthService(
  sourceIo: ProductSourceIo,
  client: { readonly clientId: string; readonly clientSecret: string },
): Promise<{
  readonly baseUrl: URL;
  readonly callbackUri: string;
  readonly productDataDirectory: string;
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-bangumi-oauth-http-"),
  );
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  await mkdir(path.join(root, "ordinary-materials"));
  await prepareProductionCatalogue({ productDataDirectory });
  const port = await unusedPort();
  const callbackUri = `http://127.0.0.1:${String(port)}/api/v1/source-connections/bangumi/callback`;
  const bootstrap = await createProductService({
    productDataDirectory,
    environment: {
      DIGITAL_PRODUCT_DATA: productDataDirectory,
      DIGITAL_BANGUMI_CLIENT_ID: client.clientId,
      DIGITAL_BANGUMI_CLIENT_SECRET: client.clientSecret,
      DIGITAL_BANGUMI_REDIRECT_URI: callbackUri,
    },
    sourceIo,
  });
  bootstraps.push(bootstrap);
  const server = serve({
    fetch: bootstrap.app.fetch,
    port,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  servers.push(server);
  await server.ready();
  bootstrap.publish();
  return {
    baseUrl: new URL(server.url!),
    callbackUri,
    productDataDirectory,
  };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("未能分配服务测试端口");
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

function jsonRequest(method: "POST" | "PUT" | "DELETE", body: unknown) {
  return {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function verificationResponse(ok: boolean, url: string, body = "") {
  const bytes = new TextEncoder().encode(body);
  return {
    ok,
    status: ok ? 200 : 401,
    url,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
