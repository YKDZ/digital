import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AssetRefreshAutomation,
  AssetRefreshWorkflow,
  ExecutionHost,
} from "@digital/application";
import {
  dlsiteAssetViewInformationRequirement,
  generalAssetViewInformationRequirement,
} from "@digital/presentation";
import { describe, expect, it, vi } from "vitest";

import { executionOutcomeLabel } from "#/lib/catalogue";
import { createApi } from "#/server/api";
import {
  catalogueSnapshot,
  createObservedRoot,
  deliveryAssetView,
  deliveryExecution,
  projectCatalogueAssets,
  shutdownCatalogue,
  startAssetMetadataRefresh,
  startAssetRescrape,
  startAssetRescrapeForSubject,
  startAutomationNowWith,
  startCatalogueAutomation,
  startRefreshWith,
  updateAutomation,
} from "#/server/catalogue";

import { prepareWebProductData } from "./prepare-catalogue";

describe("asset delivery view", () => {
  it("exposes Bangumi authorization, browser callback, and revoke through one safe HTTP surface", async () => {
    const beginAuthorization = vi.fn(() => ({
      authorizationUrl: "https://bgm.tv/oauth/authorize?state=web-state",
      expiresAt: "2026-08-12T00:10:00.000Z",
    }));
    const completeAuthorizationCallback = vi.fn(async (callbackUrl: string) => {
      expect(callbackUrl).toContain("code=web-callback-code");
      expect(callbackUrl).toContain("state=web-state");
      return {
        id: "bangumi",
        capability: {
          capabilityId: "bangumi.source-connection",
          capabilityVersion: "1",
          contractVersion: "1",
        },
        version: 1,
        credentialStatus: "configured" as const,
        availability: "available" as const,
      };
    });
    const revokeAuthorization = vi.fn((expectedVersion?: number) => ({
      id: "bangumi",
      capability: {
        capabilityId: "bangumi.source-connection",
        capabilityVersion: "1",
        contractVersion: "1",
      },
      version: (expectedVersion ?? 0) + 1,
      credentialStatus: "revoked" as const,
      availability: "unavailable" as const,
      reason: "revoked" as const,
    }));
    const api = createApi({
      beginBangumiAuthorization: beginAuthorization,
      completeBangumiAuthorizationCallback: completeAuthorizationCallback,
      revokeBangumiAuthorization: revokeAuthorization,
    });

    const started = await api.request("/source-connections/bangumi/authorize", {
      method: "POST",
    });
    expect(started.status).toBe(201);
    await expect(started.json()).resolves.toEqual({
      authorizationUrl: "https://bgm.tv/oauth/authorize?state=web-state",
      expiresAt: "2026-08-12T00:10:00.000Z",
    });

    const completed = await api.request(
      "/source-connections/bangumi/callback?code=web-callback-code&state=web-state",
    );
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      id: "bangumi",
      version: 1,
      credentialStatus: "configured",
      availability: "available",
    });
    expect(completeAuthorizationCallback).toHaveBeenCalledTimes(1);

    const revoked = await api.request("/source-connections/bangumi/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      id: "bangumi",
      version: 2,
      credentialStatus: "revoked",
      availability: "unavailable",
    });
    expect(revokeAuthorization).toHaveBeenCalledWith(1);
  });

  it("does not start scan-now after execution admission closes", async () => {
    const host = new ExecutionHost();
    await host.close();
    const triggerAutomation = vi.fn();

    await expect(
      startAutomationNowWith({ triggerAutomation }, host, "intent"),
    ).rejects.toThrow("执行服务正在关闭，请稍后重试");
    expect(triggerAutomation).not.toHaveBeenCalled();
  });

  it("delivers a managed book cover without exposing its filesystem address", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = "/product";
    try {
      const view = deliveryAssetView({
        id: "book",
        refreshTarget: { subjectId: "book" },
        cardComponent: "book",
        detailComponent: "book",
        title: "书",
        classifications: [],
        available: true,
        relationships: [],
        cover:
          "/product/managed-artifacts/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        book: {
          title: "书",
          cover:
            "/product/managed-artifacts/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          contributors: [],
          files: [],
        },
      });
      expect(view.book?.cover).toBe(
        "/api/artifacts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });

  it("leaves provider partition and grouping in Presentation", async () => {
    const deliverySource = await readFile(
      new URL("../server/catalogue.ts", import.meta.url),
      "utf8",
    );

    expect(deliverySource).not.toMatch(
      /sourceIdentity\s*[!=]==?\s*["']bangumi|["']bangumi["']\s*[!=]==?\s*[^;\n]*sourceIdentity/u,
    );
    expect(deliverySource).not.toContain("projectBangumiCatalogue");
  });

  it("keeps test-only Drizzle preparation out of the Web runtime", async () => {
    const catalogueSource = await readFile(
      new URL("../server/catalogue.ts", import.meta.url),
      "utf8",
    );

    expect(catalogueSource).not.toContain(
      "prepareDisposableProductDataCatalogue",
    );
    expect(catalogueSource).not.toContain("prepareWebProductData");
  });

  it("reads separate bounded Application pages instead of rebuilding Web history", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-web-paged-catalogue-"),
    );
    const productData = path.join(root, "product-data");
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    const currentCatalogue = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "listCurrentCataloguePage",
    );
    const workflowHistory = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "listWorkflowHistoryPage",
    );
    const currentAttention = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "listCurrentAttentionPage",
    );
    const legacyHistory = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "listInspections",
    );
    try {
      await prepareWebProductData(productData);
      process.env.DIGITAL_PRODUCT_DATA = productData;

      await expect(
        catalogueSnapshot({
          currentCatalogue: { limit: 1 },
          workflowHistory: { limit: 2 },
          currentAttention: { limit: 3 },
        }),
      ).resolves.toMatchObject({
        configured: true,
        assets: [],
        executions: [],
        attention: [],
      });

      expect(currentCatalogue).toHaveBeenCalledWith({ limit: 1 });
      expect(workflowHistory).toHaveBeenCalledWith({ limit: 2 });
      expect(currentAttention).toHaveBeenCalledWith({ limit: 3 });
      expect(legacyHistory).not.toHaveBeenCalled();
    } finally {
      currentCatalogue.mockRestore();
      workflowHistory.mockRestore();
      currentAttention.mockRestore();
      legacyHistory.mockRestore();
      await shutdownCatalogue();
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves a Workflow History page without querying or fulfilling sibling surfaces", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-web-history-surface-"),
    );
    const productData = path.join(root, "product-data");
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    const currentCatalogue = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "listCurrentCataloguePage",
    );
    const workflowHistory = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "listWorkflowHistoryPage",
    );
    workflowHistory.mockResolvedValue({ items: [] });
    const currentAttention = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "listCurrentAttentionPage",
    );
    const automation = vi.spyOn(
      AssetRefreshAutomation.prototype,
      "listAutomationIntents",
    );
    const fulfillment = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "fulfillInformation",
    );
    try {
      await prepareWebProductData(productData);
      process.env.DIGITAL_PRODUCT_DATA = productData;
      const response = await createApi().request(
        "/catalogue?surface=workflow-history&cursor=history-cursor&limit=2",
      );

      expect(response.status).toBe(200);
      expect(workflowHistory).toHaveBeenCalledWith({
        cursor: "history-cursor",
        limit: 2,
      });
      expect(currentCatalogue).not.toHaveBeenCalled();
      expect(currentAttention).not.toHaveBeenCalled();
      expect(automation).not.toHaveBeenCalled();
      expect(fulfillment).not.toHaveBeenCalled();

      vi.clearAllMocks();
      const invalidResponse = await createApi().request(
        "/catalogue?surface=not-a-surface",
      );
      expect(invalidResponse.status).toBe(400);
      expect(await invalidResponse.json()).toEqual({
        error: "未知内容目录 surface",
      });
      expect(currentCatalogue).not.toHaveBeenCalled();
      expect(workflowHistory).not.toHaveBeenCalled();
      expect(currentAttention).not.toHaveBeenCalled();
      expect(automation).not.toHaveBeenCalled();
      expect(fulfillment).not.toHaveBeenCalled();

      vi.clearAllMocks();
      currentAttention.mockResolvedValue({ items: [] });
      const attentionResponse = await createApi().request(
        "/catalogue?surface=current-attention&cursor=attention-cursor&limit=3",
      );
      expect(attentionResponse.status).toBe(200);
      expect(currentAttention).toHaveBeenCalledWith({
        cursor: "attention-cursor",
        limit: 3,
      });
      expect(currentCatalogue).not.toHaveBeenCalled();
      expect(workflowHistory).not.toHaveBeenCalled();
      expect(automation).not.toHaveBeenCalled();
      expect(fulfillment).not.toHaveBeenCalled();
    } finally {
      currentCatalogue.mockRestore();
      workflowHistory.mockRestore();
      currentAttention.mockRestore();
      automation.mockRestore();
      fulfillment.mockRestore();
      await shutdownCatalogue();
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes DLsite renderer contracts for formal boundary enforcement", async () => {
    const [rendererPackage, rendererContracts] = await Promise.all([
      readDeliveryFixture("../../../packages/presentation/package.json"),
      readDeliveryFixture(
        "../../../packages/presentation/src/renderer-contracts.ts",
      ),
    ] as const);

    expect(
      (
        JSON.parse(rendererPackage) as {
          readonly exports?: Record<string, unknown>;
        }
      ).exports?.["./renderer-contracts"],
    ).toEqual({
      default: "./src/renderer-contracts.ts",
      types: "./src/renderer-contracts.ts",
    });
    expect(rendererContracts).toContain("readonly");
    expect(rendererContracts).not.toMatch(/\bimport\b/u);
  });

  it("delivers accepted Bangumi episodes as one finite series card", () => {
    const workId = "entity_bangumi-subject_243981";
    const assets = projectCatalogueAssets(
      Array.from({ length: 13 }, (_, index) => {
        const position = index + 1;
        const assetId = `asset_bloom_${position}`;
        return {
          id: assetId,
          sourceAssociation: {
            sourceIdentity: "bangumi",
            nativeAddress: `https://bgm.tv/ep/${position}`,
          },
          metadata: [
            { property: "asset.title", value: `第 ${position} 集` },
            {
              property: "bangumi.episode.season-position",
              value: String(position),
            },
            {
              property: "bangumi.episode.continuous-position",
              value: String(position),
            },
            {
              subjectId: workId,
              property: "bangumi.subject.name.zh-hans",
              value: "终将成为你",
            },
          ],
          entities: [
            {
              id: workId,
              label: "やがて君になる",
              sourceIdentity: "bangumi",
              identityNamespace: "bangumi.subject",
              sourceKey: "243981",
            },
          ],
          relationships: [
            {
              subjectId: assetId,
              participantId: workId,
              type: "asset.membership",
              role: "bangumi.subject.ordinary-episode",
            },
          ],
          artifactAssociations: [],
          locations: [
            {
              artifactId: `artifact_${position}`,
              kind: "observed",
              address: `/media/Bloom/${position}.mkv`,
            },
          ],
        };
      }),
    );

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      component: "bangumi",
      title: "终将成为你",
      episodes: expect.arrayContaining([
        expect.objectContaining({
          assetId: "asset_bloom_13",
          actionTarget: { subjectId: "asset_bloom_13" },
        }),
      ]),
    });
    expect("episodes" in assets[0]! ? assets[0].episodes : []).toHaveLength(13);
  });

  it("submits the exact asset subject for a metadata-refresh action", async () => {
    const requests: unknown[] = [];
    const workflow = {
      async refreshMetadata(
        input: Parameters<
          Parameters<typeof startAssetMetadataRefresh>[0]["refreshMetadata"]
        >[0],
      ) {
        requests.push(input);
        input.onExecutionStarted?.({ id: "episode-b-refresh" } as never);
        return {} as never;
      },
    };

    await expect(
      startAssetMetadataRefresh(workflow, "episode-b", new ExecutionHost()),
    ).resolves.toEqual({ id: "episode-b-refresh" });
    expect(requests).toEqual([
      expect.objectContaining({
        selection: {
          version: "asset-refresh-selection/1",
          subjects: [
            {
              subjectId: "episode-b",
              explanations: [{ path: ["asset-detail", "episode-b"] }],
            },
          ],
          filesystemScopes: [],
        },
      }),
    ]);
  });

  it("submits exact current subject, filesystem scope, and designation for re-scrape", async () => {
    const requests: unknown[] = [];
    const workflow = {
      async rescrapeObservedScope(
        input: Parameters<
          Parameters<typeof startAssetRescrape>[0]["rescrapeObservedScope"]
        >[0],
      ) {
        requests.push(input);
        input.onExecutionStarted?.({ id: "episode-b-rescrape" } as never);
        return {} as never;
      },
    };

    await expect(
      startAssetRescrape(
        workflow,
        {
          assetId: "episode-b",
          observedRootId: "series-root",
          relativeScope: ".",
          sourceIdentity: "bangumi",
          sourceAddress: "https://bgm.tv/ep/2",
        },
        new ExecutionHost(),
      ),
    ).resolves.toEqual({ id: "episode-b-rescrape" });
    expect(requests).toEqual([
      expect.objectContaining({
        subjectId: "episode-b",
        registrationId: "series-root",
        relativeScope: ".",
        sourceIdentity: "bangumi",
        sourceAddress: "https://bgm.tv/ep/2",
      }),
    ]);
  });

  it("dispatches scan and exact DLsite actions to their presentation-owned requirements", async () => {
    const previousRoots = process.env.DIGITAL_WEB_OBSERVED_ROOTS;
    process.env.DIGITAL_WEB_OBSERVED_ROOTS = "/media";
    const requests: Array<{ readonly informationRequirement?: unknown }> = [];
    const workflow = {
      async scanObservedScope(input: {
        readonly informationRequirement?: unknown;
        readonly onExecutionStarted?: (execution: { id: string }) => void;
      }) {
        requests.push(input);
        input.onExecutionStarted?.({ id: "scan" });
        return {} as never;
      },
      async rescrapeObservedScope(input: {
        readonly informationRequirement?: unknown;
        readonly onExecutionStarted?: (execution: { id: string }) => void;
      }) {
        requests.push(input);
        input.onExecutionStarted?.({ id: "rescrape" });
        return {} as never;
      },
      async refreshMetadata(input: {
        readonly informationRequirement?: unknown;
        readonly onExecutionStarted?: (execution: { id: string }) => void;
      }) {
        requests.push(input);
        input.onExecutionStarted?.({ id: "metadata-refresh" });
        return {} as never;
      },
      async inspectRefreshTarget() {
        return {
          subjectId: "dlsite-work",
          filesystemScope: {
            observedRootId: "registered-media",
            relativeScope: ".",
          },
          sourceAssociation: {
            sourceIdentity: "dlsite",
            nativeAddress:
              "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
          },
        };
      },
      async inspectCurrentCatalogueSubject() {
        return {
          entity: { id: "dlsite-work", kind: "digital-asset" },
          sourceAssociation: {
            sourceIdentity: "dlsite",
            nativeAddress:
              "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
          },
          sourceAssociations: [
            {
              sourceIdentity: "dlsite",
              nativeAddress:
                "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
            },
          ],
          effectiveMetadata: [],
          entities: [],
          relationships: [],
          artifactAssociations: [],
          locations: [],
        };
      },
      async listInspections() {
        return [];
      },
    };

    try {
      await startRefreshWith(
        workflow as never,
        { observedRootId: "registered-media", relativeScope: "." },
        new ExecutionHost(),
      );
      await startRefreshWith(
        workflow as never,
        {
          target: { subjectId: "dlsite-work" },
          operation: "rescrape",
        },
        new ExecutionHost(),
      );
      await startRefreshWith(
        workflow as never,
        {
          target: { subjectId: "dlsite-work" },
          operation: "metadata-refresh",
        },
        new ExecutionHost(),
      );

      const requirements = requests.map(
        (request) => request.informationRequirement,
      );
      expect(requirements).toEqual([
        generalAssetViewInformationRequirement,
        dlsiteAssetViewInformationRequirement,
        dlsiteAssetViewInformationRequirement,
      ]);
      expect(dlsiteAssetViewInformationRequirement.metadata).not.toContainEqual(
        {
          property: "asset.runtime-minutes",
          necessity: "optional",
        },
      );
    } finally {
      if (previousRoots === undefined)
        delete process.env.DIGITAL_WEB_OBSERVED_ROOTS;
      else process.env.DIGITAL_WEB_OBSERVED_ROOTS = previousRoots;
    }
  });

  it("rebuilds each automated DLsite subject's exact Presentation requirement instead of using the general fallback", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-web-dlsite-automation-"),
    );
    const productData = path.join(root, "product-data");
    const observed = path.join(root, "RJ01668691");
    const previousProductData = process.env.DIGITAL_PRODUCT_DATA;
    const previousRoots = process.env.DIGITAL_WEB_OBSERVED_ROOTS;
    const requested: string[] = [];
    const fulfillInformation = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "fulfillInformation",
    );
    const scanFilesystem = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "scanObservedScope",
    );
    const listCurrentCataloguePage = vi.spyOn(
      AssetRefreshWorkflow.prototype,
      "listCurrentCataloguePage",
    );
    await mkdir(observed, { recursive: true });
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
    await prepareWebProductData(productData);
    process.env.DIGITAL_PRODUCT_DATA = productData;
    process.env.DIGITAL_WEB_OBSERVED_ROOTS = observed;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push(address);
      if (address.includes("/product/info/ajax")) {
        return new Response(
          JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "Exact automated work",
              regist_date: "2026-08-01",
              price: 880,
              maker_id: "circle-1",
              maker_name: "Exact Circle",
              voice: ["Voice One"],
              title_id: "series-1",
              title_name: "Exact Series",
              title_volumn: "2",
              work_image: "//img.dlsite.jp/primary.jpg",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (
        address ===
        "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html"
      ) {
        return new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (address === "https://img.dlsite.jp/primary.jpg") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const registration = await createObservedRoot({
        displayName: "自动刷新测试",
        containerPath: observed,
        symlinkMode: "do-not-follow",
      });
      const configuredRoots = await catalogueSnapshot();
      expect(configuredRoots.observedRoots).toEqual([
        { id: registration.id, displayName: "自动刷新测试" },
      ]);
      expect(JSON.stringify(configuredRoots.observedRoots)).not.toContain(
        observed,
      );
      const enabled = await updateAutomation({
        action: "enable",
        observedRootId: registration.id,
        relativeScope: ".",
        intervalMilliseconds: 60_000,
        acceptTrusted: true,
      });
      expect(enabled).toMatchObject({ initialStatus: "started" });
      if (!("intent" in enabled)) throw new Error("自动刷新未创建意图");

      const automatedScan = scanFilesystem.mock.calls.find(
        ([input]) => input.automationIntentId === enabled.intent.id,
      )?.[0];
      expect(automatedScan).toMatchObject({
        automationIntentId: enabled.intent.id,
      });
      // 周期意图及其扫描执行只保留中立自动化坐标；完整展示需求在接受后重建，
      // 而不会成为持久化输入。
      expect(automatedScan).not.toHaveProperty("informationRequirement");
      expect(enabled.intent).not.toHaveProperty("informationRequirement");

      await vi.waitFor(() => {
        expect(fulfillInformation).toHaveBeenCalled();
      });

      const automatedRequirement = fulfillInformation.mock.calls
        .map(([input]) => input.requirement)
        .find(
          (requirement) =>
            requirement.metadata.some(
              (item) => item.property === "dlsite.product.price-jpy",
            ) &&
            requirement.metadata.some(
              (item) => item.property === "asset.series-position",
            ),
        );
      expect(automatedRequirement).toEqual(
        dlsiteAssetViewInformationRequirement,
      );
      expect(automatedRequirement).not.toEqual(
        generalAssetViewInformationRequirement,
      );
      expect(automatedRequirement?.relationshipTypes).toEqual(
        expect.arrayContaining([
          { type: "asset.contribution", necessity: "optional" },
          { type: "asset.membership", necessity: "optional" },
        ]),
      );
      expect(automatedRequirement?.artifactRoles).toEqual([
        {
          role: "asset.primary-cover",
          necessity: "optional",
          maximum: 1,
        },
      ]);

      let coverStored = false;
      let latestSnapshot:
        | Awaited<ReturnType<typeof catalogueSnapshot>>
        | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const snapshot = await catalogueSnapshot();
        latestSnapshot = snapshot;
        coverStored = snapshot.assets.some(
          (asset) => "cover" in asset && asset.cover !== undefined,
        );
        if (coverStored) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(requested).toContain("https://img.dlsite.jp/primary.jpg");
      expect(coverStored).toBe(true);
      expect(listCurrentCataloguePage).toHaveBeenCalled();
      expect(latestSnapshot?.assets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: "Exact automated work",
            cover: expect.stringMatching(/^\/api\/artifacts\//u),
          }),
        ]),
      );
    } finally {
      listCurrentCataloguePage.mockRestore();
      scanFilesystem.mockRestore();
      fulfillInformation.mockRestore();
      vi.unstubAllGlobals();
      await shutdownCatalogue();
      if (previousProductData === undefined)
        delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previousProductData;
      if (previousRoots === undefined)
        delete process.env.DIGITAL_WEB_OBSERVED_ROOTS;
      else process.env.DIGITAL_WEB_OBSERVED_ROOTS = previousRoots;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Bangumi item-result subject on the server before re-scrape", async () => {
    const previousRoots = process.env.DIGITAL_WEB_OBSERVED_ROOTS;
    process.env.DIGITAL_WEB_OBSERVED_ROOTS = "/media";
    const requests: unknown[] = [];
    const workflow = {
      async inspectRefreshTarget(subjectId: string) {
        expect(subjectId).toBe("episode-b");
        return {
          subjectId: "episode-b",
          filesystemScope: {
            observedRootId: "series-root",
            relativeScope: ".",
          },
          sourceAssociation: {
            sourceIdentity: "bangumi",
            nativeAddress: "https://bgm.tv/ep/2",
          },
        };
      },
      async inspectCurrentCatalogueSubject() {
        return undefined;
      },
      async listInspections() {
        return [];
      },
      async rescrapeObservedScope(input: unknown) {
        requests.push(input);
        (
          input as {
            onExecutionStarted?: (execution: { id: string }) => void;
          }
        ).onExecutionStarted?.({ id: "episode-b-rescrape" });
        return {} as never;
      },
    };

    try {
      await expect(
        startAssetRescrapeForSubject(
          workflow as never,
          "episode-b",
          new ExecutionHost(),
        ),
      ).resolves.toEqual({ id: "episode-b-rescrape" });
      expect(requests).toEqual([
        expect.objectContaining({
          subjectId: "episode-b",
          registrationId: "series-root",
          relativeScope: ".",
          sourceIdentity: "bangumi",
          sourceAddress: "https://bgm.tv/ep/2",
        }),
      ]);
    } finally {
      if (previousRoots === undefined)
        delete process.env.DIGITAL_WEB_OBSERVED_ROOTS;
      else process.env.DIGITAL_WEB_OBSERVED_ROOTS = previousRoots;
    }
  });

  it("routes the real refresh API contract to Episode B exact-subject resolution", async () => {
    const previousRoots = process.env.DIGITAL_WEB_OBSERVED_ROOTS;
    process.env.DIGITAL_WEB_OBSERVED_ROOTS = "/media";
    const calls: unknown[] = [];
    const workflow = {
      async inspectRefreshTarget(subjectId: string) {
        return {
          subjectId,
          filesystemScope: {
            observedRootId: "series-root",
            relativeScope: ".",
          },
          sourceAssociation: {
            sourceIdentity: "bangumi",
            nativeAddress: "https://bgm.tv/ep/2",
          },
        };
      },
      async inspectCurrentCatalogueSubject() {
        return undefined;
      },
      async listInspections() {
        return [];
      },
      async rescrapeObservedScope(input: {
        onExecutionStarted?: (execution: { id: string }) => void;
      }) {
        calls.push(input);
        input.onExecutionStarted?.({ id: "episode-b-api" });
        return {} as never;
      },
    };
    const api = createApi({
      startRefresh: async (input) =>
        await startRefreshWith(workflow as never, input, new ExecutionHost()),
    });

    try {
      const response = await api.request("/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: { subjectId: "episode-b" },
          operation: "rescrape",
        }),
      });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({ id: "episode-b-api" });
      expect(calls).toEqual([
        expect.objectContaining({
          sourceIdentity: "bangumi",
          sourceAddress: "https://bgm.tv/ep/2",
          subjectId: "episode-b",
          registrationId: "series-root",
          relativeScope: ".",
        }),
      ]);
    } finally {
      if (previousRoots === undefined)
        delete process.env.DIGITAL_WEB_OBSERVED_ROOTS;
      else process.env.DIGITAL_WEB_OBSERVED_ROOTS = previousRoots;
    }
  });

  it("accepts only a registered-root identity and relative scope at the refresh API boundary", async () => {
    const scans: unknown[] = [];
    const workflow = {
      async scanObservedScope(input: {
        readonly onExecutionStarted?: (execution: { id: string }) => void;
      }) {
        scans.push(input);
        input.onExecutionStarted?.({ id: "registered-scope-api" });
        return {} as never;
      },
    };
    const api = createApi({
      startRefresh: async (input) =>
        await startRefreshWith(workflow as never, input, new ExecutionHost()),
    });

    const rawDirectory = await api.request("/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: "/media/private" }),
    });
    expect(rawDirectory.status).toBe(400);
    await expect(rawDirectory.json()).resolves.toEqual({
      error: "扫描必须选择已登记的文件位置",
    });
    expect(scans).toHaveLength(0);

    const registeredScope = await api.request("/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        observedRootId: "books-root",
        relativeScope: "novels/2026",
      }),
    });
    expect(registeredScope.status).toBe(201);
    await expect(registeredScope.json()).resolves.toEqual({
      id: "registered-scope-api",
    });
    expect(scans).toEqual([
      expect.objectContaining({
        registrationId: "books-root",
        relativeScope: "novels/2026",
      }),
    ]);
    expect(scans[0]).not.toHaveProperty("directory");
  });

  it("rejects an exact subject whose historical execution lacks a registered scope", async () => {
    const previousRoots = process.env.DIGITAL_WEB_OBSERVED_ROOTS;
    process.env.DIGITAL_WEB_OBSERVED_ROOTS = "/media/allowed";
    let rescrapeCalls = 0;
    const workflow = {
      async inspectRefreshTarget(subjectId: string) {
        void subjectId;
        return undefined;
      },
      async rescrapeObservedScope() {
        rescrapeCalls += 1;
        return {} as never;
      },
    };
    const api = createApi({
      startRefresh: async (input) =>
        await startRefreshWith(workflow as never, input, new ExecutionHost()),
    });

    try {
      const response = await api.request("/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: { subjectId: "episode-b" },
          operation: "rescrape",
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "未找到可重新刮削的当前内容",
      });
      expect(rescrapeCalls).toBe(0);
    } finally {
      if (previousRoots === undefined)
        delete process.env.DIGITAL_WEB_OBSERVED_ROOTS;
      else process.env.DIGITAL_WEB_OBSERVED_ROOTS = previousRoots;
    }
  });

  it("keeps itemized boundary outcomes and accepted references in the Web execution model", () => {
    const inspection = {
      execution: {
        id: "multi",
        selection: { directory: "/observed/multi", intent: "scan-now" },
        snapshot: {
          id: "snapshot",
          root: "/observed/multi",
          complete: true,
          excluded: [],
          observedAt: "2026-07-30T00:00:00.000Z",
          files: [],
        },
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        sourceRecordIds: [],
        dispositions: [],
      },
      sourceRecords: [],
      itemResults: [
        {
          key: "episode-1",
          relativePaths: ["Season 1/S01E01.mkv"],
          outcome: "accepted",
          reason: "trusted exact rule",
          recognition: { explanation: "exact", status: "accepted" },
          accepted: {
            entity: { id: "asset-1", kind: "digital-asset" },
            sourceAssociation: {
              sourceIdentity: "source",
              nativeAddress: "opaque:episode-1",
            },
            recognitionExplanation: "exact",
            artifacts: [],
            locations: [],
            blobs: [],
            artifactRevisions: [],
            artifactAssociations: [],
            metadata: [],
            effectiveMetadata: [],
            metadataPolicyConflicts: [],
            entities: [],
            entityMentions: [],
            entityResolutionDecisions: [],
            relationships: [],
          },
        },
      ],
    } as Parameters<typeof deliveryExecution>[0];

    expect(deliveryExecution(inspection)).toMatchObject({
      acceptedAssetId: undefined,
      items: [
        {
          key: "episode-1",
          relativePaths: ["Season 1/S01E01.mkv"],
          outcome: "accepted",
          reason: "trusted exact rule",
          recognition: { explanation: "exact", status: "accepted" },
          acceptedAssetId: "asset-1",
          acceptedSource: "opaque:episode-1",
        },
      ],
    });
  });

  it("delivers an interrupted recovery outcome with its Chinese presentation label", () => {
    const inspection = {
      execution: {
        id: "interrupted-recovery",
        selection: { directory: "/observed/recovery", intent: "scan-now" },
        snapshot: {
          id: "snapshot",
          root: "/observed/recovery",
          complete: true,
          excluded: [],
          observedAt: "2026-08-02T00:00:00.000Z",
          files: [],
        },
        status: "failed",
        stage: "failed",
        outcome: "interrupted",
        sourceRecordIds: [],
        dispositions: [],
      },
      sourceRecords: [],
    } as Parameters<typeof deliveryExecution>[0];

    expect(deliveryExecution(inspection)).toMatchObject({
      id: "interrupted-recovery",
      status: "failed",
      outcome: "interrupted",
    });
    expect(executionOutcomeLabel("interrupted")).toBe("已中断");
  });

  it("delivers understandable per-target outcomes without selection paths", () => {
    const selection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: "episode-b",
          explanations: [{ path: ["Series", "Season", "Episode B"] }],
        },
      ],
      filesystemScopes: [],
    };
    const inspection = {
      execution: {
        id: "metadata-parent",
        selection: { intent: "metadata-refresh" },
        operationKind: "refresh-metadata",
        requestedSelection: selection,
        resolvedSelection: selection,
        targetDispositions: [
          {
            key: "subject:episode-b",
            target: { kind: "subject", subjectId: "episode-b" },
            status: "failed",
            reason: "official endpoint unavailable",
            sourceRecordIds: ["episode-b-partial-record"],
            outputReferences: ["episode-b-partial-record"],
          },
        ],
        status: "failed",
        stage: "failed",
        outcome: "failed",
        sourceRecordIds: [],
        dispositions: [],
      },
      sourceRecords: [],
    } as Parameters<typeof deliveryExecution>[0];

    const delivered = deliveryExecution(inspection);
    expect(delivered?.targets).toEqual([
      {
        key: "subject:episode-b",
        label: "内容 episode-b",
        status: "failed",
        reason: "official endpoint unavailable",
        sourceRecordIds: ["episode-b-partial-record"],
        outputReferences: ["episode-b-partial-record"],
      },
    ]);
    expect(JSON.stringify(delivered)).not.toContain("Series");
  });

  it("releases a failed automation owner and permits a later ordinary restart", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-web-failed-start-"),
    );
    const databasePath = path.join(directory, "catalogue.sqlite");
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = directory;
    await mkdir(databasePath);
    try {
      await expect(startCatalogueAutomation()).rejects.toThrow();
      await expect(shutdownCatalogue()).rejects.toThrow();
      await rm(databasePath, { recursive: true, force: true });
      await prepareWebProductData(directory);
      await expect(catalogueSnapshot()).resolves.toMatchObject({
        configured: true,
        assets: [],
      });
      await shutdownCatalogue();
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shuts down process-owned compositions idempotently and can restart", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-web-close-"),
    );
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = directory;
    try {
      await prepareWebProductData(directory);
      await startCatalogueAutomation();
      const closing = shutdownCatalogue();
      await expect(catalogueSnapshot()).rejects.toThrow(
        "内容目录正在关闭，请稍后重试",
      );
      await Promise.all([closing, shutdownCatalogue()]);
      await expect(catalogueSnapshot()).resolves.toMatchObject({
        configured: true,
        assets: [],
      });
      await shutdownCatalogue();
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serves managed covers through the Web API instead of exposing workspace paths", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = "/workspaces/digital/.scratch/product";
    try {
      const digest =
        "e3a991a37c8da26db9860238c628f7d34d6cb57a4da0c6ceea04989ea8a6c584";
      const view = deliveryAssetView({
        id: "asset-1",
        refreshTarget: { subjectId: "asset-1" },
        cardComponent: "generic",
        detailComponent: "generic",
        title: "带封面的内容",
        cover: `/workspaces/digital/.scratch/product/managed-artifacts/e3/${digest}`,
        classifications: [],
        available: true,
        relationships: [],
      });

      expect(view.cover).toBe(`/api/artifacts/${digest}`);
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });

  it("serves source-specific managed covers through the Web API", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = "/workspaces/digital/.scratch/product";
    try {
      const digest =
        "fddd9347aa1930afbac3b248465f027c7e387dba0d140f55c4c2a64d2a8c19c7";
      const view = deliveryAssetView({
        id: "asset-1",
        refreshTarget: { subjectId: "asset-1" },
        cardComponent: "dlsite",
        detailComponent: "dlsite",
        title: "来源视图内容",
        cover: `/workspaces/digital/.scratch/product/managed-artifacts/fd/${digest}`,
        classifications: [],
        available: true,
        relationships: [],
        dlsite: {
          title: "来源视图内容",
          cover: `/workspaces/digital/.scratch/product/managed-artifacts/fd/${digest}`,
          languages: [],
          classifications: [],
          credits: [],
        },
      });

      expect(view.cover).toBe(`/api/artifacts/${digest}`);
      expect(view.dlsite?.cover).toBe(`/api/artifacts/${digest}`);
      expect(JSON.stringify(view)).not.toContain("/workspaces/digital");
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });

  it("serves film poster paths through the Web API", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = "/workspaces/digital/.scratch/product";
    try {
      const digest =
        "ad04989ea8a6c584fddd9347aa1930afbac3b248465f027c7e387dba0d140f55";
      const address = `/workspaces/digital/.scratch/product/managed-artifacts/ad/${digest}`;
      const view = deliveryAssetView({
        id: "film-1",
        refreshTarget: { subjectId: "film-1" },
        cardComponent: "film",
        detailComponent: "film",
        title: "恐怖直播",
        cover: address,
        classifications: [],
        available: true,
        relationships: [],
        film: {
          title: "恐怖直播",
          cover: address,
          genres: [],
          directors: [],
          cast: [],
          ratings: [],
          sources: [],
        },
      });

      expect(view.cover).toBe(`/api/artifacts/${digest}`);
      expect(view.film?.cover).toBe(`/api/artifacts/${digest}`);
      expect(JSON.stringify(view)).not.toContain("/workspaces/digital");
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });

  it("leaves non-managed addresses untouched", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = "/workspaces/digital/.scratch/product";
    try {
      const view = deliveryAssetView({
        id: "asset-1",
        refreshTarget: { subjectId: "asset-1" },
        cardComponent: "generic",
        detailComponent: "generic",
        title: "外部内容",
        cover: "/covers/asset.jpg",
        classifications: [],
        available: true,
        relationships: [],
      });

      expect(view.cover).toBe("/covers/asset.jpg");
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });

  it("does not deliver a workspace path when the cover is not a managed artifact", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = "/workspaces/digital/.scratch/product";
    try {
      const view = deliveryAssetView({
        id: "asset-1",
        refreshTarget: { subjectId: "asset-1" },
        cardComponent: "generic",
        detailComponent: "generic",
        title: "本地路径不应送往浏览器",
        cover: "/workspaces/digital/private/cover.jpg",
        classifications: [],
        available: true,
        relationships: [],
      });

      expect(view.cover).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain("/workspaces/digital");
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });

  it("does not deliver private source-specific cover paths", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = "/workspaces/digital/.scratch/product";
    try {
      const view = deliveryAssetView({
        id: "asset-1",
        refreshTarget: { subjectId: "asset-1" },
        cardComponent: "fanbox",
        detailComponent: "fanbox",
        title: "本地路径不应送往浏览器",
        classifications: [],
        available: true,
        relationships: [],
        fanbox: {
          title: "本地路径不应送往浏览器",
          cover: "/workspaces/digital/private/cover.jpg",
          hasOfficialCover: true,
          attachments: [],
        },
      });

      expect(view.fanbox?.cover).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain("/workspaces/digital");
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });
});

async function readDeliveryFixture(relativePath: string): Promise<string> {
  return await readFile(new URL(relativePath, import.meta.url), "utf8");
}
