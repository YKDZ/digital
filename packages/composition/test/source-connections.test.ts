import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assetRefreshSelectionVersion } from "@digital/application";
import { ProductBangumiSourceConnection } from "@digital/bangumi";
import { ProductSourceConnectionPrivateState } from "@digital/product-data";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { composeAssetRefresh } from "../src/runtime.ts";
import {
  disposePreparedCatalogueTemplate,
  prepareCatalogueAt,
} from "./prepared-catalogue.ts";

vi.mock("@digital/fanbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@digital/fanbox")>();
  return {
    ...actual,
    createFanboxProductAssembly: () => ({
      async validatedBrowserCredential() {
        throw new Error("unused FANBOX product assembly validation");
      },
      async verifyStoredCredential() {
        throw new Error("unused FANBOX product assembly verification");
      },
      createCollector: () => ({
        capability: actual.fanboxOfficialCollectionCapability,
        canCollect: () => false,
        coverageScopeIds: () => [],
        collect: async () => ({ records: [], failures: [] }),
      }),
      async close() {},
    }),
  };
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await disposePreparedCatalogueTemplate();
});

describe("static source registration", () => {
  it("枚举静态注册的台湾角川 ISBN 输入", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-taiwan-kadokawa-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const workflow = composeAssetRefresh(productDataDirectory);
    try {
      expect(workflow.sourceInputRequirements()).toContainEqual(
        expect.objectContaining({
          sourceIdentity: "taiwan-kadokawa",
          fields: [expect.objectContaining({ key: "isbn" })],
        }),
      );
    } finally {
      await workflow.close();
    }
  });

  it("在重开后保留 KADOKAWA 日本的两个产品候选，并只预演选中的第二项", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-kadokawa-jp-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    const observed = path.join(root, "observed");
    await prepareCatalogueAt(productDataDirectory);
    await mkdir(observed);
    await writeFile(path.join(observed, "local.txt"), "local content");
    const isbn = "9784049131291";
    const codes = ["321912000002", "321912000003"] as const;
    const requested: string[] = [];
    const fakeResponse = (body: string, url: string, mediaType: string) => {
      const bytes = new TextEncoder().encode(body);
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => mediaType },
        arrayBuffer: async () => bytes.buffer,
      };
    };
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = String(input);
      requested.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/search/"))
        return fakeResponse(
          JSON.stringify({
            count_raw: { book: 2 },
            result: { book: codes.map((itemCode) => ({ isbn, itemCode })) },
          }),
          url,
          "application/json",
        );
      const code = codes.find((item) => url.includes(item))!;
      const title = code === codes[0] ? "第一册" : "第二册";
      return fakeResponse(
        `<!doctype html><link rel="canonical" href="${url}"><meta itemprop="isbn" content="${isbn}"><meta property="og:title" content="${title}">`,
        url,
        "text/html",
      );
    });
    let workflow = composeAssetRefresh(productDataDirectory);
    try {
      const registered = await workflow.observedRootRegistrations.create({
        displayName: "KADOKAWA 本地材料",
        containerPath: observed,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      });
      const scanned = await workflow.scanObservedScope({
        registrationId: registered.id,
        relativeScope: ".",
        acceptTrusted: false,
      });
      const preparedLocal = await workflow.prepareLocalContent({
        executionId: scanned.execution.id,
        relativePaths: ["local.txt"],
        name: "本地书",
        classification: "book",
      });
      const accepted = await workflow.confirmLocalContent({
        executionId: preparedLocal.executionId,
      });
      const decision = await workflow.prepareConflictedEstablishment({
        assetId: accepted.content.entity.id,
        sourceIdentity: "kadokawa-jp",
        sourceInput: { isbn },
        initiatedBy: "test",
      });
      expect(decision).toMatchObject({
        state: "awaiting-selection",
        candidates: [{}, {}],
      });
      await workflow.close();
      workflow = composeAssetRefresh(productDataDirectory);
      const reopened = await workflow.inspectSourceAssociationDecision(
        decision.executionId,
      );
      expect(reopened).toMatchObject({
        state: "awaiting-selection",
        candidates: [{}, {}],
      });
      const selected = await workflow.selectSourceAssociationCandidate({
        executionId: decision.executionId,
        candidateReference: reopened!.candidates[1]!.reference,
      });
      const durablePreview = await workflow.inspectChangeImpactPreview(
        selected.preview!.id,
      );
      expect(durablePreview?.projected.metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: "asset.title", value: "第二册" }),
        ]),
      );
      expect(durablePreview?.projected.metadata).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: "asset.title", value: "第一册" }),
        ]),
      );
      const persisted = await workflow.inspect(decision.executionId);
      const secondDetailRecord = persisted.sourceRecords.find(
        (record) =>
          record.nativeAddress ===
          `https://www.kadokawa.co.jp/product/${codes[1]}/`,
      )!;
      expect(secondDetailRecord).toMatchObject({
        nativeAddress: `https://www.kadokawa.co.jp/product/${codes[1]}/`,
      });
      expect(selected.preview?.projected.sourceAssociations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceIdentity: "kadokawa-jp",
            nativeAddress: `https://www.kadokawa.co.jp/product/${codes[1]}/`,
          }),
        ]),
      );
      expect(selected.preview?.projected.sourceAssociations).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nativeAddress: `https://www.kadokawa.co.jp/product/${codes[0]}/`,
          }),
        ]),
      );
      await workflow.applyChangeImpactPreview({
        previewId: selected.preview!.id,
        confirmedBy: "test",
      });
      requested.length = 0;
      const refreshed = await workflow.refreshMetadata({
        selection: {
          version: assetRefreshSelectionVersion,
          subjects: [
            {
              subjectId: accepted.content.entity.id,
              explanations: [{ path: ["test", "kadokawa-jp-refresh"] }],
            },
          ],
          filesystemScopes: [],
        },
      });
      expect(requested).toEqual([
        `GET https://www.kadokawa.co.jp/product/${codes[1]}/`,
      ]);
      expect(refreshed).toMatchObject({
        execution: { status: "completed", outcome: "accepted" },
        sourceRecords: [
          {
            sourceIdentity: "kadokawa-jp",
            nativeAddress: `https://www.kadokawa.co.jp/product/${codes[1]}/`,
            coverage: { id: "kadokawa-jp.detail" },
          },
        ],
        sourceRefreshRuns: [
          {
            phase: "terminal",
            outcome: "succeeded",
            scopes: [
              {
                coverage: { coverageId: "kadokawa-jp.detail" },
                outcome: "unchanged",
              },
            ],
          },
        ],
      });
      const current = await workflow.inspectCurrentCatalogueSubject(
        accepted.content.entity.id,
      );
      expect(
        current?.effectiveMetadata.find(
          (item) => item.property === "asset.title",
        )?.alternatives,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceIdentity: "kadokawa-jp",
            value: "第二册",
          }),
        ]),
      );
      expect(current?.effectiveMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: "book.isbn-13",
            value: isbn,
            sourceIdentity: "kadokawa-jp",
          }),
        ]),
      );
    } finally {
      await workflow.close();
    }
  });
});

describe("product-managed Bangumi OAuth source connection", () => {
  it("does not bind TMDB or OMDb secrets when only collector ids match", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-coordinate-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: "tmdb-coordinate-secret",
    });
    try {
      const collectors = [
        {
          collector: workflow.sourceConnections.tmdbCollector(),
          sourceIdentity: "tmdb",
          sourceAddress: "tmdb:9509",
          mismatch: { capabilityVersion: "unexpected-version" },
        },
        {
          collector: workflow.sourceConnections.omdbCollector(),
          sourceIdentity: "omdb",
          sourceAddress: "omdb:tt0328107",
          mismatch: { contractVersion: "unexpected-contract" },
        },
      ] as const;
      for (const input of collectors) {
        const bound = await workflow.sourceConnections.bindCollector({
          collector: { ...input.collector.capability, ...input.mismatch },
          evidence: {
            kind: "source-association",
            explanation: `错误坐标的 ${input.sourceIdentity} collector`,
            sourceIdentity: input.sourceIdentity,
            sourceAddress: input.sourceAddress,
            producer: input.collector.capability,
          },
          configurationReferences: [],
        });

        expect(bound.configurationReferences).toEqual([]);
      }
    } finally {
      await workflow.close();
    }
  });

  it("starts Digital's authorization-code flow and atomically stores only a safe connection projection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const accessToken = "bangumi-private-access-token";
    const refreshToken = "bangumi-private-refresh-token";
    vi.stubGlobal("fetch", async (input: string | URL) => {
      expect(new URL(input).href).toBe("https://bgm.tv/oauth/access_token");
      return jsonResponse({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600,
        token_type: "Bearer",
      });
    });
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    });
    try {
      const authorization =
        workflow.sourceConnections.bangumi.beginAuthorization();
      const authorizationUrl = new URL(authorization.authorizationUrl);
      const state = authorizationUrl.searchParams.get("state");
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const callback = new URL(
        "https://digital.example.test/api/source-connections/bangumi/callback",
      );
      callback.searchParams.set("code", "one-time-authorisation-code");
      callback.searchParams.set("state", state!);

      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          callback.toString(),
        ),
      ).resolves.toMatchObject({
        id: "bangumi",
        credentialStatus: "configured",
        availability: "available",
        version: 1,
      });
      const inspected = workflow.sourceConnections.bangumi.inspect();
      expect(JSON.stringify(inspected)).not.toContain(accessToken);
      expect(JSON.stringify(inspected)).not.toContain(refreshToken);
      expect(
        JSON.stringify(workflow.sourceConnections.inspect()),
      ).not.toContain(accessToken);
      const privateDirectory = path.join(
        productDataDirectory,
        "private-source-connections",
      );
      expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700);
      expect(
        (await stat(path.join(privateDirectory, "bangumi-oauth.json"))).mode &
          0o777,
      ).toBe(0o600);
    } finally {
      await workflow.close();
    }
  });

  it("binds state to its configured callback and consumes it exactly once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const request = vi.fn(async () =>
      jsonResponse({
        access_token: "bangumi-callback-access",
        refresh_token: "bangumi-callback-refresh",
        expires_in: 3600,
      }),
    );
    vi.stubGlobal("fetch", request);
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    });
    try {
      const started = workflow.sourceConnections.bangumi.beginAuthorization();
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      const wrongOrigin = new URL(
        "https://attacker.example.test/api/source-connections/bangumi/callback",
      );
      wrongOrigin.searchParams.set("code", "attacker-code");
      wrongOrigin.searchParams.set("state", state!);
      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          wrongOrigin.toString(),
        ),
      ).rejects.toThrow("回调状态无效");

      const callback = new URL(
        "https://digital.example.test/api/source-connections/bangumi/callback",
      );
      callback.searchParams.set("code", "valid-code");
      callback.searchParams.set("state", state!);
      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          callback.toString(),
        ),
      ).resolves.toMatchObject({ version: 1, availability: "available" });
      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          callback.toString(),
        ),
      ).rejects.toThrow("回调状态无效");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await workflow.close();
    }
  });

  it("consumes a matching OAuth rejection callback once without sending a token request or reflecting provider text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const request = vi.fn(async () =>
      jsonResponse({
        access_token: "valid-access",
        refresh_token: "valid-refresh",
        expires_in: 3600,
      }),
    );
    vi.stubGlobal("fetch", request);
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    });
    try {
      const started = workflow.sourceConnections.bangumi.beginAuthorization();
      const callback = new URL(
        "https://digital.example.test/api/source-connections/bangumi/callback",
      );
      callback.searchParams.set("code", "untrusted-code");
      callback.searchParams.set(
        "state",
        new URL(started.authorizationUrl).searchParams.get("state")!,
      );
      callback.searchParams.set("error", "provider-private-rejection");
      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          callback.toString(),
        ),
      ).rejects.toThrow("Bangumi OAuth 授权未完成");
      expect(request).not.toHaveBeenCalled();

      callback.searchParams.delete("error");
      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          callback.toString(),
        ),
      ).rejects.toThrow("Bangumi OAuth 回调状态无效或已过期");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await workflow.close();
    }
  });

  it("does not let a mismatched OAuth error callback consume a valid pending authorization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const request = vi.fn(async () =>
      jsonResponse({
        access_token: "valid-access",
        refresh_token: "valid-refresh",
        expires_in: 3600,
      }),
    );
    vi.stubGlobal("fetch", request);
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    });
    try {
      const started = workflow.sourceConnections.bangumi.beginAuthorization();
      const state = new URL(started.authorizationUrl).searchParams.get(
        "state",
      )!;
      const wrongTarget = new URL(
        "https://attacker.example.test/api/source-connections/bangumi/callback",
      );
      wrongTarget.searchParams.set("state", state);
      wrongTarget.searchParams.set("error", "access_denied");
      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          wrongTarget.toString(),
        ),
      ).rejects.toThrow("Bangumi OAuth 回调状态无效或已过期");

      const wrongState = new URL(
        "https://digital.example.test/api/source-connections/bangumi/callback",
      );
      wrongState.searchParams.set(
        "state",
        "abcdefghijklmnopqrstuvwxyz0123456789HIJKLMN",
      );
      wrongState.searchParams.set("error", "access_denied");
      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          wrongState.toString(),
        ),
      ).rejects.toThrow("Bangumi OAuth 回调状态无效或已过期");
      expect(request).not.toHaveBeenCalled();

      const success = new URL(
        "https://digital.example.test/api/source-connections/bangumi/callback",
      );
      success.searchParams.set("state", state);
      success.searchParams.set("code", "valid-code");
      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          success.toString(),
        ),
      ).resolves.toMatchObject({ version: 1, availability: "available" });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await workflow.close();
    }
  });

  it("expires a pending callback state before any token request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    const request = vi.fn(async () =>
      jsonResponse({
        access_token: "unexpected-access",
        refresh_token: "unexpected-refresh",
        expires_in: 3600,
      }),
    );
    const connection = new ProductBangumiSourceConnection({
      privateState: ProductSourceConnectionPrivateState.forRoot(
        path.join(root, "product-data"),
      ),
      environment: {
        DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
        DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
        DIGITAL_BANGUMI_REDIRECT_URI:
          "https://digital.example.test/api/source-connections/bangumi/callback",
      },
      now: () => currentTime,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      request,
    });
    const started = connection.beginAuthorization();
    const callback = new URL(
      "https://digital.example.test/api/source-connections/bangumi/callback",
    );
    callback.searchParams.set("code", "expired-code");
    callback.searchParams.set(
      "state",
      new URL(started.authorizationUrl).searchParams.get("state")!,
    );
    currentTime = new Date("2026-08-12T00:10:00.000Z");

    await expect(
      connection.completeAuthorizationCallback(callback.toString()),
    ).rejects.toThrow("Bangumi OAuth 回调状态无效或已过期");
    expect(request).not.toHaveBeenCalled();
    expect(
      existsSync(
        path.join(
          root,
          "product-data",
          "private-source-connections",
          "bangumi-oauth-pending.json",
        ),
      ),
    ).toBe(false);
  });

  it("does not replace a state while its matching callback is being exchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    let resolveExchange:
      | ((response: ReturnType<typeof jsonResponse>) => void)
      | undefined;
    const exchange = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveExchange = resolve;
    });
    const request = vi.fn(async () => await exchange);
    vi.stubGlobal("fetch", request);
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    });
    try {
      const started = workflow.sourceConnections.bangumi.beginAuthorization();
      const callback = new URL(
        "https://digital.example.test/api/source-connections/bangumi/callback",
      );
      callback.searchParams.set("code", "in-flight-code");
      callback.searchParams.set(
        "state",
        new URL(started.authorizationUrl).searchParams.get("state")!,
      );
      const completing =
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          callback.toString(),
        );
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

      expect(() =>
        workflow.sourceConnections.bangumi.beginAuthorization(),
      ).toThrow("Bangumi OAuth 授权正在完成");

      resolveExchange!(
        jsonResponse({
          access_token: "in-flight-access",
          refresh_token: "in-flight-refresh",
          expires_in: 3600,
        }),
      );
      await expect(completing).resolves.toMatchObject({ version: 1 });
    } finally {
      await workflow.close();
    }
  });

  it("persists callback state across a restart and lets only one concurrent callback consume it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    const environment = {
      DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    };
    const request = vi.fn(async () =>
      jsonResponse({
        access_token: "restart-access",
        refresh_token: "restart-refresh",
        expires_in: 3600,
      }),
    );
    const startedByFirstProcess = new ProductBangumiSourceConnection({
      privateState:
        ProductSourceConnectionPrivateState.forRoot(productDataDirectory),
      environment,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    }).beginAuthorization();
    const callback = new URL(environment.DIGITAL_BANGUMI_REDIRECT_URI);
    callback.searchParams.set("code", "restart-code");
    callback.searchParams.set(
      "state",
      new URL(startedByFirstProcess.authorizationUrl).searchParams.get(
        "state",
      )!,
    );
    const resumedBySecondProcess = new ProductBangumiSourceConnection({
      privateState:
        ProductSourceConnectionPrivateState.forRoot(productDataDirectory),
      environment,
      request,
    });
    const concurrentProcess = new ProductBangumiSourceConnection({
      privateState:
        ProductSourceConnectionPrivateState.forRoot(productDataDirectory),
      environment,
      request,
    });

    const results = await Promise.allSettled([
      resumedBySecondProcess.completeAuthorizationCallback(callback.toString()),
      concurrentProcess.completeAuthorizationCallback(callback.toString()),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(concurrentProcess.inspect()).toMatchObject({
      version: 1,
      credentialStatus: "configured",
      availability: "available",
    });
  });

  it("revokes and reauthorizes at runtime without letting a frozen collector use the old grant", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    let authorizationCount = 0;
    vi.stubGlobal("fetch", async () => {
      authorizationCount += 1;
      return jsonResponse({
        access_token: `bangumi-access-${authorizationCount}`,
        refresh_token: `bangumi-refresh-${authorizationCount}`,
        expires_in: 3600,
      });
    });
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    });
    const callbackFor = (authorizationUrl: string, code: string) => {
      const callback = new URL(
        "https://digital.example.test/api/source-connections/bangumi/callback",
      );
      callback.searchParams.set("code", code);
      callback.searchParams.set(
        "state",
        new URL(authorizationUrl).searchParams.get("state")!,
      );
      return callback.toString();
    };
    try {
      const first = workflow.sourceConnections.bangumi.beginAuthorization();
      await workflow.sourceConnections.bangumi.completeAuthorizationCallback(
        callbackFor(first.authorizationUrl, "first-code"),
      );
      const firstContext = {
        configurationReferences: ["source-connection/bangumi@1"],
      };
      await expect(
        workflow.sourceConnections.bangumi.authorization().bearer(firstContext),
      ).resolves.toBe("bangumi-access-1");

      expect(workflow.sourceConnections.bangumi.revoke(1)).toMatchObject({
        version: 2,
        credentialStatus: "revoked",
        availability: "unavailable",
      });
      expect(
        workflow.sourceConnections.isConfigurationReferenceCurrent(
          "source-connection/bangumi@1",
        ),
      ).toBe(false);
      await expect(
        workflow.sourceConnections.bangumi.authorization().bearer(firstContext),
      ).rejects.toThrow("Bangumi 来源连接当前不可用");

      const reauthorization =
        workflow.sourceConnections.bangumi.beginAuthorization();
      await expect(
        workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          callbackFor(reauthorization.authorizationUrl, "second-code"),
        ),
      ).resolves.toMatchObject({
        version: 3,
        credentialStatus: "configured",
        availability: "available",
      });
      await expect(
        workflow.sourceConnections.bangumi.authorization().bearer({
          configurationReferences: ["source-connection/bangumi@3"],
        }),
      ).resolves.toBe("bangumi-access-2");
    } finally {
      await workflow.close();
    }
  });

  it("gives the Bangumi collector only Digital's frozen connection, never a legacy grant location", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const accessToken = "digital-owned-bangumi-access";
    const legacyGrantPath = "/emby/legacy/bangumi-oauth.json";
    const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const address = new URL(input).href;
      if (address === "https://bgm.tv/oauth/access_token") {
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "digital-owned-bangumi-refresh",
          expires_in: 3600,
        });
      }
      expect(address).toBe("https://api.bgm.tv/v0/episodes/1");
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${accessToken}`,
      });
      return jsonResponse({ id: 1, ep: 1, name: "第一集" });
    });
    vi.stubGlobal("fetch", request);
    const legacyEnvironmentName = ["DIGITAL", "BANGUMI", "OAUTH", "FILE"].join(
      "_",
    );
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
      [legacyEnvironmentName]: legacyGrantPath,
    });
    try {
      const started = workflow.sourceConnections.bangumi.beginAuthorization();
      const callback = new URL(
        "https://digital.example.test/api/source-connections/bangumi/callback",
      );
      callback.searchParams.set("code", "digital-owned-code");
      callback.searchParams.set(
        "state",
        new URL(started.authorizationUrl).searchParams.get("state")!,
      );
      await workflow.sourceConnections.bangumi.completeAuthorizationCallback(
        callback.toString(),
      );

      const collector = workflow.sourceConnections.bangumiCollector();
      const evidence = {
        kind: "source-association",
        explanation: "已关联 Bangumi 单集",
        sourceIdentity: "bangumi",
        sourceAddress: "https://bgm.tv/episode/1",
        producer: collector.capability,
      };
      const unbound = await collector.collect(evidence, {
        configurationReferences: [],
      });
      expect(unbound.records).toEqual([]);
      expect(unbound.failures).toEqual([
        expect.objectContaining({
          reason: expect.stringContaining("Bangumi authorization failed"),
        }),
      ]);

      const bound = await workflow.sourceConnections.bindCollector({
        collector: collector.capability,
        evidence,
        configurationReferences: [],
      });
      expect(bound.configurationReferences).toEqual([
        "source-connection/bangumi@1",
      ]);
      const collected = await collector.collect(evidence, bound);
      expect(collected.failures).toEqual([]);
      expect(collected.records).toEqual([
        expect.objectContaining({
          acquisition: expect.objectContaining({ authorized: true }),
        }),
      ]);
      expect(JSON.stringify(collected)).not.toContain(legacyGrantPath);
    } finally {
      await workflow.close();
    }
  });

  it("contains malformed and unsafe Bangumi private state as a repairable local failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    const privateDirectory = path.join(
      productDataDirectory,
      "private-source-connections",
    );
    const privateRecord = path.join(privateDirectory, "bangumi-oauth.json");
    const corruptPrivateValue = "not-a-valid-digital-bangumi-grant";
    await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
    await chmod(privateDirectory, 0o700);
    await writeFile(privateRecord, corruptPrivateValue, { mode: 0o600 });
    await chmod(privateRecord, 0o600);
    const connection = new ProductBangumiSourceConnection({
      privateState:
        ProductSourceConnectionPrivateState.forRoot(productDataDirectory),
      environment: {
        DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
        DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
        DIGITAL_BANGUMI_REDIRECT_URI:
          "https://digital.example.test/api/source-connections/bangumi/callback",
      },
    });

    expect(connection.inspect()).toMatchObject({
      version: 0,
      credentialStatus: "invalid",
      availability: "unavailable",
      reason: "storage-invalid",
    });
    expect(() => connection.beginAuthorization()).toThrow(
      "Bangumi OAuth 私有存储不可用",
    );
    expect(await readFile(privateRecord, "utf8")).toBe(corruptPrivateValue);

    await chmod(privateRecord, 0o644);
    expect(connection.inspect()).toMatchObject({
      version: 0,
      credentialStatus: "invalid",
      availability: "unavailable",
      reason: "permissions-unsafe",
    });
    expect(() => connection.beginAuthorization()).toThrow(
      "Bangumi OAuth 私有存储不可用",
    );
    expect(await readFile(privateRecord, "utf8")).toBe(corruptPrivateValue);
  });

  it("does not persist or reflect a rejected OAuth response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const privateClientSecret = "bangumi-private-client-secret";
    const reflectedProviderText = "bangumi-provider-private-response";
    vi.stubGlobal("fetch", async () => {
      throw new Error(`${reflectedProviderText}:${privateClientSecret}`);
    });
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: privateClientSecret,
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    });
    try {
      const started = workflow.sourceConnections.bangumi.beginAuthorization();
      const callback = new URL(
        "https://digital.example.test/api/source-connections/bangumi/callback",
      );
      callback.searchParams.set("code", "private-one-time-code");
      callback.searchParams.set(
        "state",
        new URL(started.authorizationUrl).searchParams.get("state")!,
      );
      let failure: unknown;
      try {
        await workflow.sourceConnections.bangumi.completeAuthorizationCallback(
          callback.toString(),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Bangumi OAuth 回调换取授权失败");
      expect((failure as Error).message).not.toContain(privateClientSecret);
      expect((failure as Error).message).not.toContain(reflectedProviderText);
      expect(workflow.sourceConnections.bangumi.inspect()).toMatchObject({
        version: 0,
        credentialStatus: "unconfigured",
        availability: "unavailable",
      });
      expect(
        existsSync(
          path.join(
            productDataDirectory,
            "private-source-connections",
            "bangumi-oauth.json",
          ),
        ),
      ).toBe(false);
    } finally {
      await workflow.close();
    }
  });

  it("retries an expired grant only after a complete HTTP 503 response and leaves a transport abort authorization-uncertain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-bangumi-oauth-"));
    temporaryRoots.push(root);
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    const firstAccess = "bangumi-first-access";
    const firstRefresh = "bangumi-first-refresh";
    const rotatedAccess = "bangumi-rotated-access";
    const rotatedRefresh = "bangumi-rotated-refresh";
    const retriedAccess = "bangumi-retried-after-503-access";
    const retriedRefresh = "bangumi-retried-after-503-refresh";
    let stage:
      | "exchange"
      | "rotate"
      | "http-503"
      | "retry-after-503"
      | "transport-failure" = "exchange";
    let refreshRequests = 0;
    const connection = new ProductBangumiSourceConnection({
      privateState: ProductSourceConnectionPrivateState.forRoot(
        path.join(root, "product-data"),
      ),
      environment: {
        DIGITAL_BANGUMI_CLIENT_ID: "digital-test-client",
        DIGITAL_BANGUMI_CLIENT_SECRET: "digital-test-secret",
        DIGITAL_BANGUMI_REDIRECT_URI:
          "https://digital.example.test/api/source-connections/bangumi/callback",
      },
      now: () => currentTime,
      nextState: () => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      request: async (_input, init) => {
        const parameters = new URLSearchParams(init?.body);
        if (stage === "exchange") {
          expect(parameters.get("grant_type")).toBe("authorization_code");
          return jsonResponse({
            access_token: firstAccess,
            refresh_token: firstRefresh,
            expires_in: 3600,
          });
        }
        if (stage === "rotate") {
          refreshRequests += 1;
          expect(parameters.get("grant_type")).toBe("refresh_token");
          expect(parameters.get("refresh_token")).toBe(firstRefresh);
          return jsonResponse({
            access_token: rotatedAccess,
            refresh_token: rotatedRefresh,
            expires_in: 3600,
          });
        }
        if (stage === "http-503") {
          refreshRequests += 1;
          expect(parameters.get("grant_type")).toBe("refresh_token");
          expect(parameters.get("refresh_token")).toBe(rotatedRefresh);
          return {
            ok: false,
            status: 503,
            headers: { get: () => "application/json" },
            arrayBuffer: async () =>
              new TextEncoder().encode('{"error":"upstream"}').buffer,
          };
        }
        if (stage === "retry-after-503") {
          refreshRequests += 1;
          expect(parameters.get("grant_type")).toBe("refresh_token");
          expect(parameters.get("refresh_token")).toBe(rotatedRefresh);
          return jsonResponse({
            access_token: retriedAccess,
            refresh_token: retriedRefresh,
            expires_in: 3600,
          });
        }
        refreshRequests += 1;
        expect(parameters.get("grant_type")).toBe("refresh_token");
        expect(parameters.get("refresh_token")).toBe(retriedRefresh);
        throw new Error(`reflected ${rotatedRefresh}`);
      },
    });
    const started = connection.beginAuthorization();
    const callback = new URL(
      "https://digital.example.test/api/source-connections/bangumi/callback",
    );
    callback.searchParams.set("code", "initial-code");
    callback.searchParams.set(
      "state",
      new URL(started.authorizationUrl).searchParams.get("state")!,
    );
    await connection.completeAuthorizationCallback(callback.toString());
    const context = {
      configurationReferences: ["source-connection/bangumi@1"],
    };

    currentTime = new Date("2026-08-12T02:00:00.000Z");
    stage = "rotate";
    await expect(
      Promise.all([
        connection.authorization().bearer(context),
        connection.authorization().bearer(context),
      ]),
    ).resolves.toEqual([rotatedAccess, rotatedAccess]);
    expect(refreshRequests).toBe(1);
    expect(connection.inspect()).toMatchObject({
      version: 1,
      credentialStatus: "configured",
      availability: "available",
    });

    currentTime = new Date("2026-08-12T04:00:00.000Z");
    stage = "http-503";
    await expect(connection.authorization().bearer(context)).rejects.toThrow(
      "Bangumi OAuth 授权更新失败",
    );
    expect(connection.inspect()).toMatchObject({
      version: 1,
      credentialStatus: "configured",
      availability: "available",
    });
    const persisted = await readFile(
      path.join(
        root,
        "product-data",
        "private-source-connections",
        "bangumi-oauth.json",
      ),
      "utf8",
    );
    expect(persisted).toContain(rotatedAccess);
    expect(persisted).toContain(rotatedRefresh);
    expect(JSON.stringify(connection.inspect())).not.toContain(rotatedAccess);
    expect(JSON.stringify(connection.inspect())).not.toContain(rotatedRefresh);

    // 完整 503 响应遵循已配置重试策略：端点已答复请求，因此后续一次刷新尝试可以使用旧令牌。
    stage = "retry-after-503";
    await expect(connection.authorization().bearer(context)).resolves.toBe(
      retriedAccess,
    );
    expect(refreshRequests).toBe(3);

    currentTime = new Date("2026-08-12T06:00:00.000Z");
    stage = "transport-failure";
    await expect(connection.authorization().bearer(context)).rejects.toThrow(
      "Bangumi OAuth 授权更新失败",
    );
    expect(connection.inspect()).toMatchObject({
      version: 1,
      credentialStatus: "configured",
      availability: "unavailable",
      reason: "authorization-uncertain",
    });
    await expect(connection.authorization().bearer(context)).rejects.toThrow(
      "Bangumi 来源连接当前不可用",
    );
    expect(refreshRequests).toBe(4);
  });
});

describe("product-managed film source connections", () => {
  it("keeps an unconfigured connection as a read-only product projection until a user or bootstrap supplies a secret", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);

    const workflow = composeAssetRefresh(productDataDirectory, {});
    try {
      expect(workflow.sourceConnections.inspect()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "tmdb",
            credentialStatus: "unconfigured",
            availability: "unavailable",
            reason: "not-configured",
          }),
          expect.objectContaining({
            id: "omdb",
            credentialStatus: "unconfigured",
            availability: "unavailable",
            reason: "not-configured",
          }),
        ]),
      );
    } finally {
      await workflow.close();
    }
    expect(
      existsSync(path.join(productDataDirectory, "private-source-connections")),
    ).toBe(false);
  });

  it("keeps a named FANBOX creator connection unconfigured without creating private storage", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);

    const workflow = composeAssetRefresh(productDataDirectory, {});
    try {
      expect(workflow.sourceConnections.fanbox.inspect("customudon")).toEqual(
        expect.objectContaining({
          id: "fanbox/customudon",
          creatorId: "customudon",
          credentialStatus: "unconfigured",
          availability: "unavailable",
          reason: "not-configured",
        }),
      );
    } finally {
      await workflow.close();
    }
    expect(
      existsSync(path.join(productDataDirectory, "private-source-connections")),
    ).toBe(false);
  });

  it("contains one malformed private connection as local unavailable state without replacing it from the environment", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const privateDirectory = path.join(
      productDataDirectory,
      "private-source-connections",
    );
    const tmdbStorage = path.join(privateDirectory, "tmdb.json");
    await mkdir(privateDirectory, { mode: 0o700 });
    await writeFile(tmdbStorage, "{malformed", { mode: 0o600 });
    await chmod(privateDirectory, 0o700);
    await chmod(tmdbStorage, 0o600);
    const before = await readFile(tmdbStorage, "utf8");
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input);
      if (url.host !== "www.omdbapi.com")
        throw new Error("unexpected independent connection verification host");
      return jsonResponse({ Response: "True", imdbID: "tt3896198" });
    });

    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: "bootstrap-must-not-replace-corrupt-tmdb",
      DIGITAL_OMDB_API_KEY: "independent-omdb-bootstrap",
    });
    try {
      expect(workflow.sourceConnections.tmdb.inspect()).toMatchObject({
        id: "tmdb",
        credentialStatus: "invalid",
        availability: "unavailable",
        reason: "storage-invalid",
      });
      expect(workflow.sourceConnections.omdb.inspect()).toMatchObject({
        id: "omdb",
        credentialStatus: "configured",
        availability: "available",
      });
      await expect(workflow.sourceConnections.omdb.verify()).resolves.toEqual(
        expect.objectContaining({
          credentialStatus: "configured",
          availability: "available",
          verifiedAt: expect.any(String),
        }),
      );
      await expect(workflow.listCurrentCatalogue()).resolves.toEqual([]);
      await expect(workflow.sourceConnections.tmdb.verify()).resolves.toEqual(
        expect.objectContaining({
          credentialStatus: "invalid",
          reason: "storage-invalid",
        }),
      );
      expect(() =>
        workflow.sourceConnections.tmdb.configureAccessToken(
          "must-not-overwrite-private-storage",
        ),
      ).toThrow("私有来源连接存储不可用");
      expect(await readFile(tmdbStorage, "utf8")).toBe(before);
      const observable = JSON.stringify(workflow.sourceConnections.inspect());
      expect(observable).not.toContain("bootstrap-must-not-replace-corrupt");
      expect(observable).not.toContain("must-not-overwrite-private-storage");
    } finally {
      await workflow.close();
    }
  });

  it("treats an unknown private connection record version as repairable local unavailability", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const privateDirectory = path.join(
      productDataDirectory,
      "private-source-connections",
    );
    const tmdbStorage = path.join(privateDirectory, "tmdb.json");
    await mkdir(privateDirectory, { mode: 0o700 });
    await writeFile(
      tmdbStorage,
      JSON.stringify({
        version: "product-source-connection/999",
        configurationVersion: 42,
        credentialStatus: "configured",
        availability: "available",
        secret: "unknown-version-private-value",
      }),
      { mode: 0o600 },
    );
    await chmod(privateDirectory, 0o700);
    await chmod(tmdbStorage, 0o600);
    const before = await readFile(tmdbStorage, "utf8");

    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: "bootstrap-must-not-replace-unknown-version",
    });
    try {
      expect(workflow.sourceConnections.tmdb.inspect()).toMatchObject({
        credentialStatus: "invalid",
        availability: "unavailable",
        reason: "storage-invalid",
      });
      expect(await readFile(tmdbStorage, "utf8")).toBe(before);
      const observable = JSON.stringify(workflow.sourceConnections.inspect());
      expect(observable).not.toContain("unknown-version-private-value");
      expect(observable).not.toContain(
        "bootstrap-must-not-replace-unknown-version",
      );
    } finally {
      await workflow.close();
    }
  });

  it.each([
    [
      "declares a configured available connection without a secret",
      {
        version: "product-source-connection/1",
        configurationVersion: 1,
        credentialStatus: "configured",
        availability: "available",
      },
    ],
    [
      "declares a configured available connection with a whitespace secret",
      {
        version: "product-source-connection/1",
        configurationVersion: 1,
        credentialStatus: "configured",
        availability: "available",
        secret: "   ",
      },
    ],
    [
      "declares an available connection with a verification-failed reason",
      {
        version: "product-source-connection/1",
        configurationVersion: 1,
        credentialStatus: "configured",
        availability: "available",
        secret: "state-union-private-value",
        reason: "verification-failed",
      },
    ],
    [
      "declares a failed verification without a configured secret",
      {
        version: "product-source-connection/1",
        configurationVersion: 1,
        credentialStatus: "configured",
        availability: "unavailable",
        reason: "verification-failed",
      },
    ],
    [
      "declares an unconfigured connection as available",
      {
        version: "product-source-connection/1",
        configurationVersion: 0,
        credentialStatus: "unconfigured",
        availability: "available",
        reason: "not-configured",
      },
    ],
    [
      "declares an unconfigured connection with a nonzero version",
      {
        version: "product-source-connection/1",
        configurationVersion: 1,
        credentialStatus: "unconfigured",
        availability: "unavailable",
        reason: "not-configured",
      },
    ],
    [
      "retains credentials and verification evidence for an unconfigured connection",
      {
        version: "product-source-connection/1",
        configurationVersion: 0,
        credentialStatus: "unconfigured",
        availability: "unavailable",
        reason: "not-configured",
        secret: "state-union-private-value",
        verifiedAt: "2026-08-12T00:00:00.000Z",
      },
    ],
    [
      "retains a secret after revocation",
      {
        version: "product-source-connection/1",
        configurationVersion: 2,
        credentialStatus: "revoked",
        availability: "unavailable",
        reason: "revoked",
        secret: "state-union-private-value",
      },
    ],
    [
      "declares a revoked connection as available",
      {
        version: "product-source-connection/1",
        configurationVersion: 2,
        credentialStatus: "revoked",
        availability: "available",
        reason: "revoked",
      },
    ],
    [
      "retains a verification timestamp after revocation",
      {
        version: "product-source-connection/1",
        configurationVersion: 2,
        credentialStatus: "revoked",
        availability: "unavailable",
        reason: "revoked",
        verifiedAt: "2026-08-12T00:00:00.000Z",
      },
    ],
    [
      "retains a verification timestamp after verification failed",
      {
        version: "product-source-connection/1",
        configurationVersion: 2,
        credentialStatus: "configured",
        availability: "unavailable",
        reason: "verification-failed",
        secret: "state-union-private-value",
        verifiedAt: "2026-08-12T00:00:00.000Z",
      },
    ],
    [
      "uses a noncanonical verification timestamp",
      {
        version: "product-source-connection/1",
        configurationVersion: 2,
        credentialStatus: "configured",
        availability: "available",
        secret: "state-union-private-value",
        verifiedAt: "2026-08-12T00:00:00Z",
      },
    ],
  ])(
    "contains a private connection record that %s without changing it or applying environment bootstrap",
    async (_description, privateRecord) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "digital-source-connections-"),
      );
      temporaryRoots.push(root);
      const productDataDirectory = path.join(root, "product-data");
      await prepareCatalogueAt(productDataDirectory);
      const privateDirectory = path.join(
        productDataDirectory,
        "private-source-connections",
      );
      const tmdbStorage = path.join(privateDirectory, "tmdb.json");
      const before = JSON.stringify(privateRecord);
      await mkdir(privateDirectory, { mode: 0o700 });
      await writeFile(tmdbStorage, before, { mode: 0o600 });
      await chmod(privateDirectory, 0o700);
      await chmod(tmdbStorage, 0o600);

      const workflow = composeAssetRefresh(productDataDirectory, {
        DIGITAL_TMDB_ACCESS_TOKEN: "state-union-bootstrap-must-not-apply",
      });
      try {
        expect(workflow.sourceConnections.tmdb.inspect()).toMatchObject({
          credentialStatus: "invalid",
          availability: "unavailable",
          reason: "storage-invalid",
        });
        expect(() =>
          workflow.sourceConnections.tmdb.configureAccessToken(
            "state-union-repair-must-not-overwrite",
          ),
        ).toThrow("私有来源连接存储不可用");
        expect(await readFile(tmdbStorage, "utf8")).toBe(before);
        const observable = JSON.stringify(
          workflow.sourceConnections.tmdb.inspect(),
        );
        expect(observable).not.toContain("state-union-private-value");
        expect(observable).not.toContain(
          "state-union-bootstrap-must-not-apply",
        );
      } finally {
        await workflow.close();
      }
    },
  );

  it("contains unsafe private-file permissions as a local connection failure", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const privateDirectory = path.join(
      productDataDirectory,
      "private-source-connections",
    );
    const tmdbStorage = path.join(privateDirectory, "tmdb.json");
    const privateRecord = JSON.stringify({
      version: "product-source-connection/1",
      configurationVersion: 1,
      credentialStatus: "configured",
      availability: "available",
      secret: "unsafe-permissions-private-value",
    });
    await mkdir(privateDirectory, { mode: 0o700 });
    await writeFile(tmdbStorage, privateRecord, { mode: 0o644 });
    await chmod(privateDirectory, 0o700);
    await chmod(tmdbStorage, 0o644);

    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: "bootstrap-must-not-replace-unsafe-storage",
    });
    try {
      expect(workflow.sourceConnections.tmdb.inspect()).toMatchObject({
        credentialStatus: "invalid",
        availability: "unavailable",
        reason: "permissions-unsafe",
      });
      expect(await readFile(tmdbStorage, "utf8")).toBe(privateRecord);
      expect((await stat(tmdbStorage)).mode & 0o077).toBe(0o044);
      const observable = JSON.stringify(workflow.sourceConnections.inspect());
      expect(observable).not.toContain("unsafe-permissions-private-value");
      expect(observable).not.toContain(
        "bootstrap-must-not-replace-unsafe-storage",
      );
    } finally {
      await workflow.close();
    }
  });

  it("bootstraps each configured film connection once without retaining its secret in its inspectable state", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);

    const initial = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: "tmdb-bootstrap-secret",
      DIGITAL_OMDB_API_KEY: "omdb-bootstrap-secret",
    });
    try {
      expect(initial.sourceConnections.tmdb.inspect()).toMatchObject({
        id: "tmdb",
        capability: {
          identity: "tmdb.source-connection",
          kind: "source-connection",
        },
        credentialStatus: "configured",
        availability: "available",
        version: 1,
      });
      expect(initial.sourceConnections.omdb.inspect()).toMatchObject({
        id: "omdb",
        capability: {
          identity: "omdb.source-connection",
          kind: "source-connection",
        },
        credentialStatus: "configured",
        availability: "available",
        version: 1,
      });
      expect(JSON.stringify(initial.sourceConnections.inspect())).not.toContain(
        "bootstrap-secret",
      );
      const privateDirectory = path.join(
        productDataDirectory,
        "private-source-connections",
      );
      expect((await stat(privateDirectory)).mode & 0o077).toBe(0);
      expect(
        (await stat(path.join(privateDirectory, "tmdb.json"))).mode & 0o077,
      ).toBe(0);
      expect(
        (await stat(path.join(privateDirectory, "omdb.json"))).mode & 0o077,
      ).toBe(0);
    } finally {
      await initial.close();
    }

    const restarted = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: "tmdb-replacement-from-environment",
      DIGITAL_OMDB_API_KEY: "omdb-replacement-from-environment",
    });
    try {
      expect(restarted.sourceConnections.inspect()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "tmdb",
            credentialStatus: "configured",
            version: 1,
          }),
          expect.objectContaining({
            id: "omdb",
            credentialStatus: "configured",
            version: 1,
          }),
        ]),
      );
      expect(
        JSON.stringify(restarted.sourceConnections.inspect()),
      ).not.toContain("replacement-from-environment");
    } finally {
      await restarted.close();
    }
  });

  it("validates each configured connection independently and never exposes its supplied credential", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    let omdbCredentialAccepted = false;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input);
      if (url.host === "api.themoviedb.org")
        return jsonResponse({ success: true });
      if (url.host === "www.omdbapi.com")
        return jsonResponse(
          omdbCredentialAccepted
            ? { Response: "True", imdbID: "tt3896198" }
            : { Response: "False", Error: "Invalid API key!" },
        );
      throw new Error("unexpected verification source host");
    });
    const workflow = composeAssetRefresh(productDataDirectory, {});
    try {
      const tmdb =
        workflow.sourceConnections.tmdb.configureAccessToken(
          "tmdb-verify-token",
        );
      const omdb =
        workflow.sourceConnections.omdb.configureApiKey("omdb-invalid-key");
      await expect(workflow.sourceConnections.tmdb.verify()).resolves.toEqual(
        expect.objectContaining({
          id: "tmdb",
          version: tmdb.version,
          credentialStatus: "configured",
          availability: "available",
          verifiedAt: expect.any(String),
        }),
      );
      await expect(workflow.sourceConnections.omdb.verify()).resolves.toEqual(
        expect.objectContaining({
          id: "omdb",
          version: omdb.version,
          credentialStatus: "configured",
          availability: "unavailable",
          reason: "verification-failed",
        }),
      );

      omdbCredentialAccepted = true;
      const replacement = workflow.sourceConnections.omdb.replaceApiKey(
        "omdb-verified-key",
        omdb.version,
      );
      await expect(workflow.sourceConnections.omdb.verify()).resolves.toEqual(
        expect.objectContaining({
          id: "omdb",
          version: replacement.version,
          credentialStatus: "configured",
          availability: "available",
          verifiedAt: expect.any(String),
        }),
      );
      const observable = JSON.stringify(workflow.sourceConnections.inspect());
      expect(observable).not.toContain("verify-token");
      expect(observable).not.toContain("invalid-key");
      expect(observable).not.toContain("verified-key");
    } finally {
      await workflow.close();
    }
  });

  it("uses the version frozen for each real TMDB collection and fails explicitly after revocation without retaining an empty record", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const authorizationHeaders: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization !== null) authorizationHeaders.push(authorization);
      if (url.pathname.endsWith("/search/movie"))
        return jsonResponse({
          page: 1,
          total_pages: 1,
          results: [{ id: 1 }],
        });
      if (url.pathname.endsWith("/credits"))
        return jsonResponse({ id: 1, crew: [], cast: [] });
      if (url.pathname.endsWith("/translations"))
        return jsonResponse({ id: 1, translations: [] });
      return jsonResponse({
        id: 1,
        title:
          url.searchParams.get("query") === "Second Film"
            ? "Second Film"
            : "First Film",
        release_date: "2004-01-01",
        genres: [],
      });
    });
    const workflow = composeAssetRefresh(productDataDirectory, {});
    try {
      const first = await scanStrictFilm(
        workflow,
        path.join(root, "Unavailable Before Config (2004)"),
      );
      expect(first.execution.workflowInput?.configurationReferences).toContain(
        "source-connection/tmdb@0",
      );
      expect(first.sourceRecords).toEqual([]);

      const configured =
        workflow.sourceConnections.tmdb.configureAccessToken(
          "tmdb-first-secret",
        );
      const accepted = await scanStrictFilm(
        workflow,
        path.join(root, "First Film (2004)"),
      );
      expect(
        accepted.execution.workflowInput?.configurationReferences,
      ).toContain("source-connection/tmdb@1");
      expect(accepted.sourceRecords.length).toBeGreaterThan(0);
      expect(authorizationHeaders).toContain("Bearer tmdb-first-secret");

      const replaced = workflow.sourceConnections.tmdb.replaceAccessToken(
        "tmdb-second-secret",
        configured.version,
      );
      const second = await scanStrictFilm(
        workflow,
        path.join(root, "Second Film (2004)"),
      );
      expect(second.execution.workflowInput?.configurationReferences).toContain(
        "source-connection/tmdb@2",
      );
      expect(second.sourceRecords.length).toBeGreaterThan(0);
      expect(authorizationHeaders).toContain("Bearer tmdb-second-secret");

      const revoked = workflow.sourceConnections.tmdb.revoke(replaced.version);
      const unavailable = await scanStrictFilm(
        workflow,
        path.join(root, "Unavailable Film (2004)"),
      );
      expect(
        unavailable.execution.workflowInput?.configurationReferences,
      ).toContain(`source-connection/tmdb@${revoked.version}`);
      expect(unavailable.sourceRecords).toEqual([]);
      expect(unavailable.execution.status).toBe("failed");
      expect(JSON.stringify(unavailable)).not.toContain("tmdb-second-secret");
    } finally {
      await workflow.close();
    }
  });

  it("persists one typed unavailable-source automatic degradation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-source-auto-"));
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const observed = path.join(root, "Unavailable Automation Film (2004)");
    await mkdir(observed, { recursive: true });
    await writeFile(path.join(observed, "video.mkv"), "fixture");
    let workflow = composeAssetRefresh(productDataDirectory, {});
    let workflowClosed = false;
    try {
      const registration = await workflow.observedRootRegistrations.create({
        displayName: "unavailable automation film",
        containerPath: observed,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      });
      const automation = await workflow.enableAutomation({
        observedRootId: registration.id,
        relativeScope: ".",
        intervalMilliseconds: 60_000,
        acceptTrusted: true,
        runInitial: false,
      });
      const [triggered] = await workflow.triggerDueAutomation(
        new Date("2026-08-20T00:00:00Z"),
      );
      expect(triggered).toMatchObject({
        execution: {
          execution: {
            dispositions: expect.arrayContaining([
              expect.objectContaining({
                failureClassification: { kind: "prerequisite-unavailable" },
              }),
            ]),
          },
        },
      });
      expect(await workflow.listAutomationIntents()).toEqual([
        expect.objectContaining({
          id: automation.intent.id,
          enabled: false,
          disabledReason: "prerequisite-unavailable",
        }),
      ]);
      await expect(workflow.listCurrentAttentionPage()).resolves.toMatchObject({
        items: [
          {
            id: `prerequisite-unavailable:${automation.intent.id}`,
            kind: "prerequisite-unavailable",
            automationIntentId: automation.intent.id,
          },
        ],
      });
      await workflow.triggerDueAutomation(new Date("2026-08-20T00:01:00Z"));
      expect((await workflow.listWorkflowHistoryPage()).items).toHaveLength(1);
      await workflow.close();
      workflowClosed = true;

      workflow = composeAssetRefresh(productDataDirectory, {});
      workflowClosed = false;
      expect(await workflow.listAutomationIntents()).toEqual([
        expect.objectContaining({
          id: automation.intent.id,
          enabled: false,
          disabledReason: "prerequisite-unavailable",
        }),
      ]);
      await workflow.triggerDueAutomation(new Date("2026-08-20T00:02:00Z"));
      expect((await workflow.listWorkflowHistoryPage()).items).toHaveLength(1);
    } finally {
      if (!workflowClosed) await workflow.close();
    }
  });

  it("keeps an in-flight collection on its frozen connection version when a newer version is saved", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const authorizationHeaders: string[] = [];
    let firstSearchStarted!: () => void;
    const firstSearch = new Promise<void>((resolve) => {
      firstSearchStarted = resolve;
    });
    let releaseFirstSearch!: () => void;
    const waitForReplacement = new Promise<void>((resolve) => {
      releaseFirstSearch = resolve;
    });
    let searchCount = 0;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization !== null) authorizationHeaders.push(authorization);
      if (url.pathname.endsWith("/search/movie")) {
        searchCount += 1;
        if (searchCount === 1) {
          firstSearchStarted();
          await waitForReplacement;
        }
        return jsonResponse({
          page: 1,
          total_pages: 1,
          results: [{ id: searchCount === 1 ? 81 : 82 }],
        });
      }
      const segments = url.pathname.split("/");
      const id = Number(
        segments.at(-1) === "credits" || segments.at(-1) === "translations"
          ? (segments.at(-2) ?? "0")
          : (segments.at(-1) ?? "0"),
      );
      if (url.pathname.endsWith("/credits"))
        return jsonResponse({ id, crew: [], cast: [] });
      if (url.pathname.endsWith("/translations"))
        return jsonResponse({ id, translations: [] });
      return jsonResponse({
        id,
        title: id === 81 ? "Frozen Version Film" : "Latest Version Film",
        release_date: "2004-01-01",
        genres: [],
      });
    });
    const workflow = composeAssetRefresh(productDataDirectory, {});
    try {
      const original = workflow.sourceConnections.tmdb.configureAccessToken(
        "tmdb-frozen-version",
      );
      const running = scanStrictFilm(
        workflow,
        path.join(root, "Frozen Version Film (2004)"),
      );
      await firstSearch;
      const replacement = workflow.sourceConnections.tmdb.replaceAccessToken(
        "tmdb-latest-version",
        original.version,
      );
      releaseFirstSearch();
      const first = await running;
      const frozenHeaders = [...authorizationHeaders];

      expect(first.execution.workflowInput?.configurationReferences).toContain(
        `source-connection/tmdb@${original.version}`,
      );
      expect(new Set(frozenHeaders)).toEqual(
        new Set(["Bearer tmdb-frozen-version"]),
      );

      const later = await scanStrictFilm(
        workflow,
        path.join(root, "Latest Version Film (2004)"),
      );
      expect(later.execution.workflowInput?.configurationReferences).toContain(
        `source-connection/tmdb@${replacement.version}`,
      );
      expect(authorizationHeaders.slice(frozenHeaders.length)).toContain(
        "Bearer tmdb-latest-version",
      );
      expect(JSON.stringify(first)).not.toContain("frozen-version");
      expect(JSON.stringify(later)).not.toContain("latest-version");
    } finally {
      await workflow.close();
    }
  });

  it("combines the two configured official film sources through the ordinary workflow with per-field provenance", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const requestedHosts: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      requestedHosts.push(url.host);
      if (url.host === "api.themoviedb.org") {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer tmdb-two-source-token",
        );
        if (url.pathname.endsWith("/search/movie"))
          return jsonResponse({
            page: 1,
            total_pages: 1,
            results: [{ id: 42 }],
          });
        if (url.pathname.endsWith("/credits"))
          return jsonResponse({ id: 42, crew: [], cast: [] });
        if (url.pathname.endsWith("/translations"))
          return jsonResponse({ id: 42, translations: [] });
        return jsonResponse({
          id: 42,
          title: "Two Source Film",
          original_title: "Two Source Film",
          release_date: "2004-08-06",
          imdb_id: "tt1234567",
          genres: [],
          alternative_titles: { titles: [] },
          images: { posters: [], backdrops: [] },
        });
      }
      if (url.host === "www.omdbapi.com") {
        expect(url.searchParams.get("apikey")).toBe("omdb-two-source-key");
        expect(url.searchParams.get("i")).toBe("tt1234567");
        return jsonResponse({
          Response: "True",
          imdbID: "tt1234567",
          Title: "Two Source Film",
          Year: "2004",
          Released: "06 Aug 2004",
          Awards: "Nominated for 1 Oscar.",
          Ratings: [{ Source: "Internet Movie Database", Value: "7.2/10" }],
        });
      }
      throw new Error("unexpected official source host");
    });
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: "tmdb-two-source-token",
      DIGITAL_OMDB_API_KEY: "omdb-two-source-key",
    });
    try {
      const result = await scanStrictFilm(
        workflow,
        path.join(root, "Two Source Film (2004)"),
        ordinaryFilmRequirementWithAwards,
      );

      expect(result.execution.outcome).toBe("accepted");
      expect(requestedHosts).toEqual(
        expect.arrayContaining(["api.themoviedb.org", "www.omdbapi.com"]),
      );
      expect(result.sourceRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceIdentity: "tmdb",
            acquiredAt: expect.any(String),
          }),
          expect.objectContaining({
            sourceIdentity: "omdb",
            acquiredAt: expect.any(String),
          }),
        ]),
      );
      expect(result.accepted?.effectiveMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: "asset.title",
            value: "Two Source Film",
            sourceIdentity: "tmdb",
          }),
          expect.objectContaining({
            property: "asset.awards",
            value: "Nominated for 1 Oscar.",
            sourceIdentity: "omdb",
          }),
        ]),
      );
      expect(JSON.stringify(result)).not.toContain("two-source-token");
      expect(JSON.stringify(result)).not.toContain("two-source-key");
    } finally {
      await workflow.close();
    }
  });

  it("persists only sanitized reflected film credentials through raw-record, execution, public, and restart inspection", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const tmdbCredential = "tmdb-persisted-reflection-secret";
    const omdbCredential = "omdb-persisted-reflection-secret";
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input);
      if (url.host === "api.themoviedb.org") {
        if (url.pathname.endsWith("/search/movie"))
          return jsonResponse({
            page: 1,
            total_pages: 1,
            results: [{ id: 84 }],
            reflectedCredential: tmdbCredential,
          });
        if (url.pathname.endsWith("/credits"))
          return jsonResponse({
            id: 84,
            crew: [],
            cast: [],
            reflectedCredential: tmdbCredential,
          });
        if (url.pathname.endsWith("/translations"))
          return jsonResponse({
            id: 84,
            translations: [],
            reflectedCredential: tmdbCredential,
          });
        return jsonResponse({
          id: 84,
          title: "Sanitized Persistence Film",
          original_title: "Sanitized Persistence Film",
          release_date: "2004-08-06",
          imdb_id: "tt1234584",
          genres: [],
          alternative_titles: { titles: [] },
          images: { posters: [], backdrops: [] },
          reflectedCredential: tmdbCredential,
        });
      }
      if (url.host === "www.omdbapi.com")
        return jsonResponse({
          Response: "True",
          imdbID: "tt1234584",
          Title: "Sanitized Persistence Film",
          Year: "2004",
          Awards: "Won 1 award.",
          reflectedCredential: omdbCredential,
        });
      throw new Error("unexpected official source host");
    });

    const first = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: tmdbCredential,
      DIGITAL_OMDB_API_KEY: omdbCredential,
    });
    let executionId: string;
    let sourceRecordIds: readonly string[];
    let subjectId: string;
    try {
      const result = await scanStrictFilm(
        first,
        path.join(root, "Sanitized Persistence Film (2004)"),
        ordinaryFilmRequirementWithAwards,
      );
      if (result.accepted === undefined)
        throw new Error("sanitized film was not accepted");
      executionId = result.execution.id;
      sourceRecordIds = result.sourceRecords.map(({ id }) => id);
      subjectId = result.accepted.entity.id;
      const observable = JSON.stringify(result);
      expect(observable).not.toContain(tmdbCredential);
      expect(observable).not.toContain(omdbCredential);
      expect(JSON.stringify(result.execution)).not.toContain(tmdbCredential);
      expect(JSON.stringify(result.execution)).not.toContain(omdbCredential);
      expect(
        JSON.stringify(await first.inspectCurrentCatalogueSubject(subjectId)),
      ).not.toContain(tmdbCredential);
      expect(
        JSON.stringify(await first.inspectCurrentCatalogueSubject(subjectId)),
      ).not.toContain(omdbCredential);
      for (const sourceRecordId of sourceRecordIds) {
        const raw = await first.inspectRawSourceRecord(
          executionId,
          sourceRecordId,
        );
        expect(JSON.stringify(raw)).not.toContain(tmdbCredential);
        expect(JSON.stringify(raw)).not.toContain(omdbCredential);
      }
    } finally {
      await first.close();
    }

    const restarted = composeAssetRefresh(productDataDirectory, {});
    try {
      for (const sourceRecordId of sourceRecordIds!) {
        const raw = await restarted.inspectRawSourceRecord(
          executionId!,
          sourceRecordId,
        );
        expect(JSON.stringify(raw)).not.toContain(tmdbCredential);
        expect(JSON.stringify(raw)).not.toContain(omdbCredential);
      }
      const publicInspection = await restarted.inspectCurrentCatalogueSubject(
        subjectId!,
      );
      expect(JSON.stringify(publicInspection)).not.toContain(tmdbCredential);
      expect(JSON.stringify(publicInspection)).not.toContain(omdbCredential);
    } finally {
      await restarted.close();
    }
  });

  it("keeps existing OMDb facts when its connection is revoked while TMDB refresh still succeeds", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    let omdbRequests = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input);
      if (url.host === "api.themoviedb.org") {
        if (url.pathname.endsWith("/search/movie"))
          return jsonResponse({
            page: 1,
            total_pages: 1,
            results: [{ id: 73 }],
          });
        if (url.pathname.endsWith("/credits"))
          return jsonResponse({ id: 73, crew: [], cast: [] });
        if (url.pathname.endsWith("/translations"))
          return jsonResponse({ id: 73, translations: [] });
        return jsonResponse({
          id: 73,
          title: "Degraded Source Film",
          original_title: "Degraded Source Film",
          release_date: "2004-08-06",
          imdb_id: "tt7654321",
          genres: [],
          alternative_titles: { titles: [] },
          images: { posters: [], backdrops: [] },
        });
      }
      if (url.host === "www.omdbapi.com") {
        omdbRequests += 1;
        return jsonResponse({
          Response: "True",
          imdbID: "tt7654321",
          Title: "Degraded Source Film",
          Year: "2004",
          Released: "06 Aug 2004",
          Awards: "Won 1 award.",
        });
      }
      throw new Error("unexpected official source host");
    });
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: "tmdb-degradation-token",
      DIGITAL_OMDB_API_KEY: "omdb-degradation-key",
    });
    try {
      const initial = await scanStrictFilm(
        workflow,
        path.join(root, "Degraded Source Film (2004)"),
        ordinaryFilmRequirementWithAwards,
      );
      const subjectId = initial.accepted?.entity.id;
      if (subjectId === undefined)
        throw new Error("initial film was not accepted");
      expect(omdbRequests).toBe(1);
      expect(initial.accepted?.effectiveMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: "asset.awards",
            value: "Won 1 award.",
            sourceIdentity: "omdb",
          }),
        ]),
      );

      const revoked = workflow.sourceConnections.omdb.revoke(
        workflow.sourceConnections.omdb.inspect().version,
      );
      const refreshed = await workflow.refreshMetadata({
        selection: {
          version: assetRefreshSelectionVersion,
          subjects: [{ subjectId, explanations: [{ path: ["test"] }] }],
          filesystemScopes: [],
        },
        informationRequirement: ordinaryFilmRequirementWithAwards,
      });

      expect(revoked).toMatchObject({
        credentialStatus: "revoked",
        availability: "unavailable",
      });
      expect(refreshed.execution.outcome).toBe("partially-succeeded");
      expect(refreshed.sourceRecords).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceIdentity: "omdb" }),
        ]),
      );
      expect(omdbRequests).toBe(1);
      await expect(
        workflow.inspectCurrentCatalogueSubject(subjectId),
      ).resolves.toEqual(
        expect.objectContaining({
          effectiveMetadata: expect.arrayContaining([
            expect.objectContaining({
              property: "asset.awards",
              value: "Won 1 award.",
              sourceIdentity: "omdb",
            }),
          ]),
        }),
      );
      expect(JSON.stringify(refreshed)).not.toContain("degradation-key");
      expect(JSON.stringify(refreshed)).not.toContain("degradation-token");
    } finally {
      await workflow.close();
    }
  });

  it("keeps existing OMDb facts when a negative OMDb envelope locally degrades an otherwise successful refresh", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-source-connections-"),
    );
    temporaryRoots.push(root);
    const productDataDirectory = path.join(root, "product-data");
    await prepareCatalogueAt(productDataDirectory);
    const omdbCredential = "omdb-negative-refresh-private-key";
    let omitOmdb = false;
    let omdbRequests = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input);
      if (url.host === "api.themoviedb.org") {
        if (url.pathname.endsWith("/search/movie"))
          return jsonResponse({
            page: 1,
            total_pages: 1,
            results: [{ id: 85 }],
          });
        if (url.pathname.endsWith("/credits"))
          return jsonResponse({ id: 85, crew: [], cast: [] });
        if (url.pathname.endsWith("/translations"))
          return jsonResponse({ id: 85, translations: [] });
        return jsonResponse({
          id: 85,
          title: "Negative Envelope Film",
          original_title: "Negative Envelope Film",
          release_date: "2004-08-06",
          imdb_id: "tt1234585",
          genres: [],
          alternative_titles: { titles: [] },
          images: { posters: [], backdrops: [] },
        });
      }
      if (url.host === "www.omdbapi.com") {
        omdbRequests += 1;
        return jsonResponse(
          omitOmdb
            ? {
                Response: "False",
                Error: `Invalid key at https://www.omdbapi.com/?apikey=${omdbCredential}`,
              }
            : {
                Response: "True",
                imdbID: "tt1234585",
                Title: "Negative Envelope Film",
                Year: "2004",
                Released: "06 Aug 2004",
                Awards: "Won 1 award.",
              },
        );
      }
      throw new Error("unexpected official source host");
    });
    const workflow = composeAssetRefresh(productDataDirectory, {
      DIGITAL_TMDB_ACCESS_TOKEN: "tmdb-negative-refresh-token",
      DIGITAL_OMDB_API_KEY: omdbCredential,
    });
    try {
      const initial = await scanStrictFilm(
        workflow,
        path.join(root, "Negative Envelope Film (2004)"),
        ordinaryFilmRequirementWithAwards,
      );
      const subjectId = initial.accepted?.entity.id;
      if (subjectId === undefined)
        throw new Error("initial negative-envelope film was not accepted");
      expect(omdbRequests).toBe(1);
      expect(initial.sourceRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceIdentity: "omdb" }),
        ]),
      );
      expect(initial.accepted?.effectiveMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: "asset.awards",
            value: "Won 1 award.",
            sourceIdentity: "omdb",
          }),
        ]),
      );

      omitOmdb = true;
      const refreshed = await workflow.refreshMetadata({
        selection: {
          version: assetRefreshSelectionVersion,
          subjects: [{ subjectId, explanations: [{ path: ["test"] }] }],
          filesystemScopes: [],
        },
        informationRequirement: ordinaryFilmRequirementWithAwards,
      });

      expect(omdbRequests).toBe(2);
      expect(refreshed.execution.outcome).toBe("partially-succeeded");
      expect(refreshed.sourceRecords).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceIdentity: "omdb" }),
        ]),
      );
      const observable = JSON.stringify(refreshed);
      expect(observable).toContain("OMDb 官方来源未返回可用作品");
      expect(observable).not.toContain(omdbCredential);
      expect(observable).not.toContain("Invalid key");
      expect(observable).not.toContain("www.omdbapi.com");
      await expect(
        workflow.inspectCurrentCatalogueSubject(subjectId),
      ).resolves.toEqual(
        expect.objectContaining({
          effectiveMetadata: expect.arrayContaining([
            expect.objectContaining({
              property: "asset.awards",
              value: "Won 1 award.",
              sourceIdentity: "omdb",
            }),
          ]),
        }),
      );
    } finally {
      await workflow.close();
    }
  });
});

const ordinaryFilmRequirementWithAwards = {
  metadataUsageContext: "asset.ordinary",
  metadata: [
    { property: "asset.title", necessity: "required" as const },
    { property: "asset.awards", necessity: "optional" as const },
  ],
  artifactRoles: [],
  relationshipTypes: [],
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}

async function scanStrictFilm(
  workflow: ReturnType<typeof composeAssetRefresh>,
  directory: string,
  informationRequirement = {
    metadataUsageContext: "asset.ordinary",
    metadata: [{ property: "asset.title", necessity: "required" as const }],
    artifactRoles: [],
    relationshipTypes: [],
  },
) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "video.mkv"), "fixture");
  const registration = await workflow.observedRootRegistrations.create({
    displayName: path.basename(directory),
    containerPath: directory,
    readOnly: true,
    symlinkMode: "do-not-follow",
    allowedTargetRootIds: [],
  });
  return await workflow.scanObservedScope({
    registrationId: registration.id,
    relativeScope: ".",
    acceptTrusted: true,
    informationRequirement,
  });
}
