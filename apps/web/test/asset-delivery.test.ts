import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AssetRefreshAutomation,
  AssetRefreshWorkflow,
  ArtifactByteAccessError,
  ExecutionHost,
} from "@digital/application";
import { runProduct } from "@digital/composition";
import {
  dlsiteAssetViewInformationRequirement,
  generalAssetViewInformationRequirement,
} from "@digital/presentation";
import {
  createApi,
  createWebDelivery,
  executionOutcomeLabel,
  catalogueSnapshot,
  createObservedRoot,
  deliveryAssetView,
  deliveryExecution,
  projectCatalogueAssets,
  startAssetMetadataRefresh,
  startAssetRescrape,
  startAssetRescrapeForSubject,
  startAutomationNowWith,
  startCatalogueAutomation,
  startRefreshWith,
  updateAutomation,
} from "@digital/web-delivery";
import { describe, expect, it, vi } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

let closeBoundWebProduct: (() => Promise<void>) | undefined;

function bindWebDelivery() {
  const product = runProduct(
    {
      productDataDirectory: process.env.DIGITAL_PRODUCT_DATA,
      environment: process.env,
    },
    { start: createWebDelivery },
  );
  closeBoundWebProduct = async () => await product.close();
  return product.result;
}

async function shutdownBoundWebProduct(): Promise<void> {
  try {
    await closeBoundWebProduct?.();
  } finally {
    closeBoundWebProduct = undefined;
  }
}

describe("asset delivery view", () => {
  it("transports typed source and identity correction intents through the formal HTTP API", async () => {
    const startDecision = vi.fn(async (input: unknown) => ({
      executionId: "decision-execution",
      input,
    }));
    const inspectDecision = vi.fn(async (id: string) => ({
      executionId: id,
      state: "awaiting-selection",
      candidates: [
        {
          reference: "opaque-candidate",
          outcome: "accepted",
          sourceIdentity: "nbinet",
          nativeAddress: "nbinet:9786264151726",
          explanation: "来源候选匹配",
          ruleResults: [],
        },
      ],
      evidenceComparison: {
        observed: [],
        manual: [],
        sourceCandidates: [
          {
            outcome: "accepted",
            sourceIdentity: "nbinet",
            nativeAddress: "nbinet:9786264151726",
            explanation: "来源候选匹配",
            ruleResults: [],
          },
        ],
        conflicts: [],
      },
    }));
    const inspectSubject = vi.fn(async (id: string) => ({
      assetId: id,
      current: [],
      historical: [],
    }));
    const selectCandidate = vi.fn(async (id: string, input: unknown) => ({
      executionId: id,
      input,
    }));
    const retryDecision = vi.fn(async (id: string) => ({ executionId: id }));
    const retractIdentity = vi.fn(async (input: unknown) => ({
      id: "recognition-preview",
      input,
    }));
    const api = createApi({
      startSourceAssociationDecision: startDecision as never,
      inspectSourceAssociationDecision: inspectDecision as never,
      inspectCorrectionSubject: inspectSubject as never,
      selectSourceAssociationDecisionCandidate: selectCandidate as never,
      retrySourceAssociationDecision: retryDecision as never,
      startRecognitionRetraction: retractIdentity as never,
    });

    const prepared = await api.request("/source-association-decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "retract",
        assetId: "asset",
        predecessorAssociationId: "association",
        initiatedBy: "reviewer",
        reason: "wrong source",
      }),
    });
    expect(prepared.status).toBe(202);
    expect(startDecision).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "retract", initiatedBy: "reviewer" }),
    );
    const inspected = await api.request(
      "/source-association-decisions/execution",
    );
    expect(inspected.status).toBe(200);
    const inspectedJson = await inspected.text();
    expect(JSON.parse(inspectedJson)).toMatchObject({
      candidates: [expect.objectContaining({ sourceIdentity: "nbinet" })],
    });
    for (const forbidden of [
      "interpretation",
      "sourceRecordIds",
      "producer",
      "capabilityId",
      "capabilityVersion",
      "contractVersion",
    ])
      expect(inspectedJson).not.toContain(forbidden);
    expect((await api.request("/correction-subjects/asset")).status).toBe(200);
    const selected = await api.request(
      "/source-association-decisions/execution/select",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          candidateReference: "opaque-candidate",
        }),
      },
    );
    expect(selected.status).toBe(200);
    expect(selectCandidate).toHaveBeenCalledWith("execution", {
      candidateReference: "opaque-candidate",
    });
    expect(
      (
        await api.request("/source-association-decisions/execution/retry", {
          method: "POST",
        })
      ).status,
    ).toBe(202);
    const retraction = await api.request("/recognition-retractions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assetId: "asset",
        predecessorDecisionId: "decision",
        proposedBy: "reviewer",
        reason: "wrong identity",
      }),
    });
    expect(retraction.status).toBe(202);
    expect(retractIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ proposedBy: "reviewer" }),
    );
  });

  it("rejects malformed preview actions without consuming the live preview", async () => {
    const previewAction = vi.fn(async () => ({ status: "applied" as const }));
    const api = createApi({ updatePreview: previewAction as never });

    for (const body of [
      { action: "approve", previewId: "preview", actorId: "reviewer" },
      {
        action: "apply",
        previewId: "preview",
        actorId: "reviewer",
        unexpected: true,
      },
      { action: "apply", previewId: "preview", actorId: " " },
      { action: "apply", previewId: " ", actorId: "reviewer" },
    ]) {
      const response = await api.request("/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(previewAction).not.toHaveBeenCalled();

    const valid = await api.request("/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply",
        previewId: "preview",
        actorId: "reviewer",
      }),
    });
    expect(valid.status).toBe(200);
    expect(previewAction).toHaveBeenCalledOnce();
  });

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
      bindWebDelivery();
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
      new URL(
        "../../../packages/web-delivery/src/web-delivery.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(deliverySource).not.toMatch(
      /sourceIdentity\s*[!=]==?\s*["']bangumi|["']bangumi["']\s*[!=]==?\s*[^;\n]*sourceIdentity/u,
    );
    expect(deliverySource).not.toContain("projectBangumiCatalogue");
  });

  it("keeps test-only Drizzle preparation out of the Web runtime", async () => {
    const catalogueSource = await readFile(
      new URL(
        "../../../packages/web-delivery/src/web-delivery.ts",
        import.meta.url,
      ),
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
      bindWebDelivery();

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
      await shutdownBoundWebProduct();
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
      bindWebDelivery();
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
      await shutdownBoundWebProduct();
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
      await rm(root, { recursive: true, force: true });
    }
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
      async rescrapeCurrentObservedScope(
        input: Parameters<
          Parameters<
            typeof startAssetRescrape
          >[0]["rescrapeCurrentObservedScope"]
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
      async rescrapeCurrentObservedScope(input: {
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
          recognitionSourceAssociation: {
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
    bindWebDelivery();
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
      await shutdownBoundWebProduct();
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
          recognitionSourceAssociation: {
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
      async rescrapeCurrentObservedScope(input: unknown) {
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
          recognitionSourceAssociation: {
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
      async rescrapeCurrentObservedScope(input: {
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
      async rescrapeCurrentObservedScope() {
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
            sourceAssociations: [
              {
                sourceIdentity: "source",
                nativeAddress: "opaque:episode-1",
              },
            ],
            recognitionSourceAssociation: {
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
      bindWebDelivery();
      await expect(startCatalogueAutomation()).rejects.toThrow();
      await expect(shutdownBoundWebProduct()).rejects.toThrow();
      await rm(databasePath, { recursive: true, force: true });
      await prepareWebProductData(directory);
      bindWebDelivery();
      await expect(catalogueSnapshot()).resolves.toMatchObject({
        configured: true,
        assets: [],
      });
      await shutdownBoundWebProduct();
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
      bindWebDelivery();
      await startCatalogueAutomation();
      const closing = shutdownBoundWebProduct();
      await Promise.all([closing, shutdownBoundWebProduct()]);
      bindWebDelivery();
      await startCatalogueAutomation();
      await expect(catalogueSnapshot()).resolves.toMatchObject({
        configured: true,
        assets: [],
      });
      await shutdownBoundWebProduct();
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
      bindWebDelivery();
      const digest =
        "e3a991a37c8da26db9860238c628f7d34d6cb57a4da0c6ceea04989ea8a6c584";
      const view = deliveryAssetView({
        id: "asset-1",
        refreshTarget: { subjectId: "asset-1" },
        cardComponent: "generic",
        detailComponent: "generic",
        title: "带封面的内容",
        cover: `/workspaces/digital/.scratch/product/managed-artifacts/e3/${digest}`,
        files: [
          {
            name: "台本.pdf",
            format: "PDF",
            revisionId: "artifact-revision_script",
            image: `/workspaces/digital/.scratch/product/managed-artifacts/e3/${digest}`,
          },
        ],
        book: {
          title: "带封面的内容",
          contributors: [],
          files: [
            {
              name: "台本.pdf",
              format: "PDF",
              revisionId: "artifact-revision_script",
              image: `/workspaces/digital/.scratch/product/managed-artifacts/e3/${digest}`,
            },
          ],
        },
        classifications: [],
        available: true,
        relationships: [],
      });

      expect(view.cover).toBe(`/api/artifacts/${digest}`);
      expect(view.files).toEqual([
        {
          name: "台本.pdf",
          format: "PDF",
          revisionId: "artifact-revision_script",
          image: `/api/artifacts/${digest}`,
        },
      ]);
      expect(view.book?.files).toEqual(view.files);
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });

  it("serves source-specific managed covers through the Web API", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    process.env.DIGITAL_PRODUCT_DATA = "/workspaces/digital/.scratch/product";
    try {
      bindWebDelivery();
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
      bindWebDelivery();
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

  it("delivers managed bytes only through injected product operations", async () => {
    const digest =
      "e3a991a37c8da26db9860238c628f7d34d6cb57a4da0c6ceea04989ea8a6c584";
    const managedArtifactReference = vi.fn((address: string) =>
      address === "/private/product/managed-artifacts/e3/" + digest
        ? { digest }
        : undefined,
    );
    const readManagedArtifact = vi.fn(
      async () => new Uint8Array([0xff, 0xd8, 0xff]),
    );
    const delivery = createWebDelivery({
      configured: true,
      setAutomationInformationRequirementForAcceptedSubject: vi.fn(),
      managedArtifactReference,
      readManagedArtifact,
    } as never);

    expect(
      deliveryAssetView({
        id: "asset-1",
        refreshTarget: { subjectId: "asset-1" },
        cardComponent: "generic",
        detailComponent: "generic",
        title: "注入产物",
        cover: `/private/product/managed-artifacts/e3/${digest}`,
        classifications: [],
        available: true,
        relationships: [],
      }).cover,
    ).toBe(`/api/artifacts/${digest}`);

    const served = await delivery.api.request(`/artifacts/${digest}`);
    expect(served.status).toBe(200);
    expect(readManagedArtifact).toHaveBeenCalledWith(digest);

    const rejected = await delivery.api.request("/artifacts/%2Fetc%2Fpasswd");
    expect(rejected.status).toBe(404);
    expect(readManagedArtifact).toHaveBeenCalledTimes(1);
  });

  it("以安全附件流下载一个精确产物修订版", async () => {
    const close = vi.fn(async () => undefined);
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        bytes: new TextEncoder().encode("abc"),
        done: false,
      })
      .mockResolvedValueOnce({
        bytes: new TextEncoder().encode("def"),
        done: true,
      });
    const prepareArtifactDownload = vi.fn(async () => ({
      revisionId: "artifact-revision_123",
      blobDigest: "a".repeat(64),
      byteLength: 6,
      mediaType: "application/pdf",
      suggestedFilename: "报告'(*).pdf",
    }));
    const openArtifactBytes = vi.fn(async () => ({
      revisionId: "artifact-revision_123",
      blobDigest: "a".repeat(64),
      byteLength: 6,
      mediaType: "application/pdf",
      interval: { startInclusive: 0, endInclusive: 5 },
      read,
      close,
    }));
    const delivery = createWebDelivery({
      configured: true,
      setAutomationInformationRequirementForAcceptedSubject: vi.fn(),
      prepareArtifactDownload,
      openArtifactBytes,
    } as never);

    const response = await delivery.api.request(
      "/artifact-downloads/artifact-revision_123",
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      "attachment;",
    );
    expect(response.headers.get("content-disposition")).not.toContain("/");
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E6%8A%A5%E5%91%8A%27%28%2A%29.pdf",
    );
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe("6");
    expect(response.headers.get("etag")).toBe(`"sha256:${"a".repeat(64)}"`);
    await expect(response.text()).resolves.toBe("abcdef");
    expect(prepareArtifactDownload).toHaveBeenCalledWith({
      artifactRevisionId: "artifact-revision_123",
    });
    expect(openArtifactBytes).toHaveBeenCalledWith({
      selection: { artifactRevisionId: "artifact-revision_123" },
      expectedBlobDigest: "a".repeat(64),
      interval: { startInclusive: 0, endInclusive: 5 },
    });
    expect(close).toHaveBeenCalledWith("completed");
  });

  it("以 revision 与 digest 绑定的可重建地址计划和 Range 播放", async () => {
    const digest = "b".repeat(64);
    let revoked = false;
    const planPlayback = vi.fn(async () => ({
      status: "ready" as const,
      revisionId: "artifact-revision_playback",
      blobDigest: digest,
      rendition: {
        kind: "direct" as const,
        mediaType: "audio/mpeg",
        codecs: ["mp3"],
        byteLength: 6,
      },
    }));
    const prepareArtifactDownload = vi.fn(async () => {
      if (revoked)
        throw new ArtifactByteAccessError("artifact-location-revoked");
      return {
        revisionId: "artifact-revision_playback",
        blobDigest: digest,
        byteLength: 6,
        mediaType: "audio/mpeg",
        suggestedFilename: "track.mp3",
      };
    });
    const close = vi.fn(async () => undefined);
    const openArtifactBytes = vi.fn(async (input) => ({
      revisionId: "artifact-revision_playback",
      blobDigest: digest,
      byteLength: 6,
      mediaType: "audio/mpeg",
      interval: input.interval,
      async read() {
        return { bytes: new TextEncoder().encode("bcd"), done: true };
      },
      close,
    }));
    const delivery = createWebDelivery({
      configured: true,
      setAutomationInformationRequirementForAcceptedSubject: vi.fn(),
      planPlayback,
      prepareArtifactDownload,
      openArtifactBytes,
    } as never);
    const body = {
      consumer: {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "audio/mpeg", codecs: ["mp3"] }],
      },
      preferences: {},
    };
    const plan = await delivery.api.request(
      "/playback-plans/artifact-revision_playback",
      { method: "POST", body: JSON.stringify(body) },
    );
    expect(plan.status, await plan.clone().text()).toBe(200);
    const planned = await plan.json();
    expect(planned.mediaUrl).toBe(
      `/api/playback-media/artifact-revision_playback/${digest}`,
    );
    const rebuilt = await delivery.api.request(
      "/playback-plans/artifact-revision_playback",
      { method: "POST", body: JSON.stringify(body) },
    );
    expect((await rebuilt.json()).mediaUrl).toBe(planned.mediaUrl);

    const media = await delivery.api.request(planned.mediaUrl.slice(4), {
      headers: { range: "bytes=1-3" },
    });
    expect(media.status).toBe(206);
    expect(media.headers.get("content-range")).toBe("bytes 1-3/6");
    expect(media.headers.get("content-disposition")).toBeNull();
    expect(media.headers.get("etag")).toBe(`"sha256:${digest}"`);
    await expect(media.text()).resolves.toBe("bcd");
    expect(openArtifactBytes).toHaveBeenCalledWith({
      selection: { artifactRevisionId: "artifact-revision_playback" },
      expectedBlobDigest: digest,
      interval: { startInclusive: 1, endInclusive: 3 },
    });

    const tampered = await delivery.api.request(
      `/playback-media/artifact-revision_playback/${"c".repeat(64)}`,
    );
    expect(tampered.status).toBe(409);
    expect(openArtifactBytes).toHaveBeenCalledTimes(1);
    revoked = true;
    const afterRevoke = await delivery.api.request(planned.mediaUrl.slice(4));
    expect(afterRevoke.status).toBe(409);
    expect(openArtifactBytes).toHaveBeenCalledTimes(1);
    const arbitrary = await delivery.api.request(
      "/playback-plans/artifact-revision_playback",
      {
        method: "POST",
        body: JSON.stringify({ ...body, path: "/private/track.mp3" }),
      },
    );
    expect(arbitrary.status).toBe(400);
    const latest = await delivery.api.request("/playback-plans/latest", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(latest.status).toBe(400);
    expect(planPlayback).toHaveBeenCalledTimes(2);
  });

  it("在打开 body 租约前解释强 ETag 条件与单一字节范围", async () => {
    const digest = "b".repeat(64);
    const close = vi.fn(async () => undefined);
    const openArtifactBytes = vi.fn(async (input) => {
      const source = new TextEncoder()
        .encode("abcdef")
        .slice(input.interval.startInclusive, input.interval.endInclusive + 1);
      return {
        revisionId: "revision-range",
        blobDigest: digest,
        byteLength: 6,
        mediaType: "text/plain",
        interval: input.interval,
        async read() {
          return { bytes: source, done: true };
        },
        close,
      };
    });
    const delivery = createWebDelivery({
      configured: true,
      setAutomationInformationRequirementForAcceptedSubject: vi.fn(),
      async prepareArtifactDownload() {
        return {
          revisionId: "revision-range",
          blobDigest: digest,
          byteLength: 6,
          mediaType: "text/plain",
          suggestedFilename: "sample.txt",
        };
      },
      openArtifactBytes,
    } as never);

    const partial = await delivery.api.request(
      "/artifact-downloads/revision-range",
      { headers: { range: "bytes=2-4" } },
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-4/6");
    expect(partial.headers.get("content-length")).toBe("3");
    await expect(partial.text()).resolves.toBe("cde");

    const opaqueComma = await delivery.api.request(
      "/artifact-downloads/revision-range",
      { headers: { "if-match": '"other,tag"' } },
    );
    expect(opaqueComma.status).toBe(412);
    expect(opaqueComma.headers.get("content-length")).toBeNull();
    expect(openArtifactBytes).toHaveBeenCalledTimes(1);

    const unchanged = await delivery.api.request(
      "/artifact-downloads/revision-range",
      { headers: { "if-none-match": `W/"sha256:${digest}"` } },
    );
    expect(unchanged.status).toBe(304);
    expect(openArtifactBytes).toHaveBeenCalledTimes(1);

    const malformed = await delivery.api.request(
      "/artifact-downloads/revision-range",
      { headers: { range: "bytes=1x-2" } },
    );
    expect(malformed.status).toBe(400);
    expect(openArtifactBytes).toHaveBeenCalledTimes(1);

    const multipleWithOws = await delivery.api.request(
      "/artifact-downloads/revision-range",
      { headers: { range: "bytes=0-1, \t4-5" } },
    );
    expect(multipleWithOws.status).toBe(416);
    expect(multipleWithOws.headers.get("content-range")).toBe("bytes */6");
    expect(multipleWithOws.headers.get("content-length")).toBeNull();
    expect(openArtifactBytes).toHaveBeenCalledTimes(1);

    const illegalWhitespace = await delivery.api.request(
      "/artifact-downloads/revision-range",
      { headers: { range: "bytes=0 - 1" } },
    );
    expect(illegalWhitespace.status).toBe(400);

    const unicodeWhitespace = await delivery.api.request(
      "/artifact-downloads/revision-range",
      { headers: { range: "bytes=0-1,\u00a04-5" } },
    );
    expect(unicodeWhitespace.status).toBe(400);

    const overflow = await delivery.api.request(
      "/artifact-downloads/revision-range",
      { headers: { range: "bytes=9007199254740992-" } },
    );
    expect(overflow.status).toBe(400);

    const unknownUnit = await delivery.api.request(
      "/artifact-downloads/revision-range",
      { headers: { range: "examples=anything,goes" } },
    );
    expect(unknownUnit.status).toBe(200);
    await expect(unknownUnit.text()).resolves.toBe("abcdef");
  });

  it("客户端取消附件 body 时立即关闭 Product 字节租约", async () => {
    const close = vi.fn(async () => undefined);
    const delivery = createWebDelivery({
      configured: true,
      setAutomationInformationRequirementForAcceptedSubject: vi.fn(),
      async prepareArtifactDownload() {
        return {
          revisionId: "revision-cancelled",
          blobDigest: "c".repeat(64),
          byteLength: 2,
          mediaType: "application/octet-stream",
          suggestedFilename: "cancel.bin",
        };
      },
      async openArtifactBytes() {
        return {
          revisionId: "revision-cancelled",
          blobDigest: "c".repeat(64),
          byteLength: 2,
          mediaType: "application/octet-stream",
          interval: { startInclusive: 0, endInclusive: 1 },
          async read() {
            return { bytes: new Uint8Array([1]), done: false };
          },
          close,
        };
      },
    } as never);
    const response = await delivery.api.request(
      "/artifact-downloads/revision-cancelled",
    );

    await response.body?.cancel();

    expect(close).toHaveBeenCalledWith("client-cancelled");
  });

  it("从真实组合根为 generic MP3 Blob 一致投影计划、附件和 Range 媒体类型", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-artifact-download-"),
    );
    const productData = path.join(root, "product-data");
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    const bytes = new Uint8Array(418);
    bytes.set([0xff, 0xfb, 0x90, 0x64]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const revisionId = "artifact-revision_managed-download";
    try {
      await prepareWebProductData(productData);
      const directory = path.join(
        productData,
        "managed-artifacts",
        digest.slice(0, 2),
      );
      const address = path.join(directory, digest);
      await mkdir(directory, { recursive: true });
      await writeFile(address, bytes);
      const database = new DatabaseSync(
        path.join(productData, "catalogue.sqlite"),
      );
      database.exec(`
        INSERT INTO artifacts (id) VALUES ('artifact-managed-download');
        INSERT INTO blobs (digest, media_type, byte_length)
          VALUES ('${digest}', 'application/octet-stream', ${bytes.byteLength});
        INSERT INTO artifact_revisions (id, artifact_id, blob_digest)
          VALUES ('${revisionId}', 'artifact-managed-download', '${digest}');
        INSERT INTO locations (id, artifact_id, address, kind)
          VALUES ('location-managed-download', 'artifact-managed-download', '${address.replaceAll("'", "''")}', 'managed');
      `);
      database.close();
      process.env.DIGITAL_PRODUCT_DATA = productData;
      const delivery = bindWebDelivery();

      const response = await delivery.api.request(
        `/artifact-downloads/${revisionId}`,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("content-length")).toBe(
        String(bytes.byteLength),
      );
      expect(response.headers.get("content-type")).toBe("audio/mpeg");
      await expect(response.bytes()).resolves.toEqual(bytes);

      const planResponse = await delivery.api.request(
        `/playback-plans/${revisionId}`,
        {
          method: "POST",
          body: JSON.stringify({
            consumer: {
              contractVersion: "consumer-playback/1",
              supportsByteRanges: true,
              media: [{ mediaType: "audio/mpeg", codecs: ["mp3"] }],
            },
            preferences: {},
          }),
        },
      );
      expect(planResponse.status).toBe(200);
      const plan = (await planResponse.json()) as {
        readonly status: string;
        readonly revisionId: string;
        readonly blobDigest: string;
        readonly rendition: { readonly mediaType: string };
        readonly mediaUrl: string;
      };
      expect(plan).toMatchObject({
        status: "ready",
        revisionId,
        blobDigest: digest,
        rendition: { mediaType: "audio/mpeg" },
      });
      const playbackRange = await delivery.api.request(plan.mediaUrl.slice(4), {
        headers: { range: "bytes=1-3" },
      });
      expect(playbackRange.status).toBe(206);
      expect(playbackRange.headers.get("content-type")).toBe("audio/mpeg");
      expect(playbackRange.headers.get("content-range")).toBe(
        `bytes 1-3/${String(bytes.byteLength)}`,
      );
      expect(playbackRange.headers.get("etag")).toBe(`"sha256:${digest}"`);
      expect(playbackRange.headers.get("content-disposition")).toBeNull();
      await expect(playbackRange.bytes()).resolves.toEqual(bytes.slice(1, 4));

      const suffix = await delivery.api.request(
        `/artifact-downloads/${revisionId}`,
        { headers: { range: "bytes=-6" } },
      );
      expect(suffix.status).toBe(206);
      await expect(suffix.bytes()).resolves.toEqual(bytes.slice(-6));

      const proofDatabase = new DatabaseSync(
        path.join(productData, "catalogue.sqlite"),
        { readOnly: true },
      );
      const proofRow = proofDatabase
        .prepare(
          "SELECT manifest_digest AS manifestDigest FROM artifact_content_proofs WHERE blob_digest = ?",
        )
        .get(digest) as { readonly manifestDigest: string };
      proofDatabase.close();
      const proofPath = path.join(
        productData,
        "artifact-proofs",
        "sha256",
        proofRow.manifestDigest.slice(0, 2),
        `${proofRow.manifestDigest}.fproof`,
      );
      await writeFile(proofPath, new Uint8Array([0]));
      const rebuilt = await delivery.api.request(
        `/artifact-downloads/${revisionId}`,
        { headers: { range: "bytes=0-2" } },
      );
      expect(rebuilt.status).toBe(206);
      await expect(rebuilt.bytes()).resolves.toEqual(bytes.slice(0, 3));

      await writeFile(address, bytes.slice(0, bytes.byteLength - 1));
      const truncatedConditional = await delivery.api.request(
        `/artifact-downloads/${revisionId}`,
        { headers: { "if-none-match": `"sha256:${digest}"` } },
      );
      expect(truncatedConditional.status).toBe(409);
      await writeFile(address, bytes);

      const corrupted = bytes.slice();
      corrupted[0] = corrupted[0]! ^ 1;
      await writeFile(address, corrupted);
      const corruptedRange = await delivery.api.request(
        `/artifact-downloads/${revisionId}`,
        { headers: { range: "bytes=0-2" } },
      );
      expect(corruptedRange.status).toBe(409);
      await expect(corruptedRange.json()).resolves.toEqual({
        error: "artifact-integrity-failed",
      });

      const managedReplacement = path.join(directory, "replacement");
      await writeFile(managedReplacement, bytes);
      await rename(managedReplacement, address);
      const restoredRange = await delivery.api.request(
        `/artifact-downloads/${revisionId}`,
        { headers: { range: "bytes=1-3" } },
      );
      expect(restoredRange.status).toBe(206);
      await expect(restoredRange.bytes()).resolves.toEqual(bytes.slice(1, 4));
      const unknown = await delivery.api.request(
        "/artifact-downloads/artifact-revision_unknown",
      );
      expect(unknown.status).toBe(404);
      const pathInput = await delivery.api.request(
        "/artifact-downloads/%2Fetc%2Fpasswd",
      );
      expect(pathInput.status).toBe(400);
    } finally {
      await shutdownBoundWebProduct();
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("首次选择只渐进确认一个观察文件并立即通过精确 revision 下载", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-observed-download-"),
    );
    const productData = path.join(root, "product-data");
    const observedRoot = path.join(root, "observed");
    const observedFile = path.join(observedRoot, "作品.txt");
    const bytes = new TextEncoder().encode("只确认这个文件");
    let closeProduct: (() => Promise<void>) | undefined;
    try {
      await mkdir(observedRoot, { recursive: true });
      await writeFile(observedFile, bytes);
      const details = await stat(observedFile);
      const observationBaseline = createHash("sha256")
        .update(
          JSON.stringify({
            artifactId: "artifact-observed-download",
            locationId: "location-observed-download",
            modifiedAt: details.mtime.toISOString(),
            observedAt: "2026-08-29T00:00:00.000Z",
            revisionHeads: [],
            size: bytes.byteLength,
            snapshotId: "snapshot-observed-download",
          }),
        )
        .digest("hex");
      await prepareWebProductData(productData);
      const database = new DatabaseSync(
        path.join(productData, "catalogue.sqlite"),
      );
      const snapshot = JSON.stringify({
        version: "observed-root-snapshot/1",
        id: "snapshot-observed-download",
        root: observedRoot,
        complete: true,
        files: [
          {
            relativePath: "作品.txt",
            size: bytes.byteLength,
            modifiedAt: details.mtime.toISOString(),
          },
        ],
        directories: [],
        excluded: [],
        observedAt: "2026-08-29T00:00:00.000Z",
      }).replaceAll("'", "''");
      database.exec(`
        INSERT INTO artifacts (id) VALUES ('artifact-observed-download');
        INSERT INTO locations (id, artifact_id, address, kind)
          VALUES ('location-observed-download', 'artifact-observed-download', '${observedFile.replaceAll("'", "''")}', 'observed');
        INSERT INTO current_file_observations (
          location_id, snapshot_id, observed_at, size, modified_at,
          conditional_baseline
        ) VALUES (
          'location-observed-download', 'snapshot-observed-download',
          '2026-08-29T00:00:00.000Z', ${bytes.byteLength},
          '${details.mtime.toISOString()}', '${observationBaseline}'
        );
        INSERT INTO workflow_executions (
          id, snapshot_json, status, stage, source_record_ids_json,
          selection_intent, compatibility_json, dispositions_json,
          information_requirement_json, source_enrichments_json,
          source_refresh_run_ids_json
        ) VALUES (
          'execution-observed-download', '${snapshot}', 'completed', 'completed', '[]',
          'scan-now', '{}', '[]', '{}', '[]', '[]'
        );
      `);
      database.close();
      const product = runProduct(
        { productDataDirectory: productData, environment: {} },
        {
          start(application) {
            return {
              application: application as never,
              api: createWebDelivery(application).api,
            };
          },
        },
      );
      closeProduct = async () => await product.close();
      const application = product.result.application as {
        readonly workflow: {
          readonly observedRootRegistrations: {
            create(input: {
              readonly displayName: string;
              readonly containerPath: string;
              readonly readOnly: true;
              readonly symlinkMode: "do-not-follow";
              readonly allowedTargetRootIds: readonly string[];
            }): Promise<{
              readonly id: string;
              readonly configVersion: number;
            }>;
            deactivate(input: {
              readonly id: string;
              readonly expectedVersion: number;
            }): Promise<unknown>;
          };
        };
        observedFileSelectionForLocation(
          locationId: string,
        ): Promise<string | undefined>;
        prepareArtifactDownload(input: {
          readonly artifactRevisionId: string;
        }): Promise<{
          readonly blobDigest: string;
          readonly byteLength: number;
        }>;
        openArtifactBytes(input: {
          readonly selection: { readonly artifactRevisionId: string };
          readonly expectedBlobDigest: string;
          readonly interval: {
            readonly startInclusive: number;
            readonly endInclusive: number;
          };
        }): Promise<{
          read(input: {
            readonly maximumBytes: number;
            readonly cancellation: {
              readonly cancelled: boolean;
              onCancel(listener: () => void): () => void;
            };
          }): Promise<{ readonly bytes: Uint8Array; readonly done: boolean }>;
          close(
            reason: "completed" | "client-cancelled" | "failed" | "shutdown",
          ): Promise<void>;
        }>;
      };
      const registration =
        await application.workflow.observedRootRegistrations.create({
          displayName: "观察文件",
          containerPath: observedRoot,
          readOnly: true,
          symlinkMode: "do-not-follow",
          allowedTargetRootIds: [],
        });
      const selectionId = await application.observedFileSelectionForLocation(
        "location-observed-download",
      );
      expect(selectionId).toMatch(/^observed-file-selection_1_[a-f0-9]{64}$/u);

      const response = await product.result.api.request(
        `/observed-file-downloads/${selectionId}`,
      );

      expect(response.status).toBe(200);
      await expect(response.bytes()).resolves.toEqual(bytes);
      const retried = await product.result.api.request(
        `/observed-file-downloads/${selectionId}`,
      );
      expect(retried.status).toBe(200);
      await expect(retried.bytes()).resolves.toEqual(bytes);

      await writeFile(observedFile, new TextEncoder().encode("内容已经改变"));
      const changed = await product.result.api.request(
        `/observed-file-downloads/${selectionId}`,
      );
      expect(changed.status).toBe(409);
      await expect(changed.json()).resolves.toEqual({
        error: "artifact-bytes-changed",
      });

      await writeFile(observedFile, bytes);
      await utimes(observedFile, details.atime, details.mtime);
      const blobDigest = createHash("sha256").update(bytes).digest("hex");
      const artifactRevisionId = `artifact-revision_${createHash("sha256")
        .update(`artifact-observed-download\u0000${blobDigest}`)
        .digest("hex")}`;
      const descriptor = await application.prepareArtifactDownload({
        artifactRevisionId,
      });

      const changedSameLength = bytes.slice();
      changedSameLength[0] = changedSameLength[0]! ^ 1;
      const changedReplacement = path.join(observedRoot, "changed.txt");
      await writeFile(changedReplacement, changedSameLength);
      await utimes(changedReplacement, details.atime, details.mtime);
      await rename(changedReplacement, observedFile);
      const swappedRange = await product.result.api.request(
        `/artifact-downloads/${artifactRevisionId}`,
        { headers: { range: "bytes=0-2" } },
      );
      expect(swappedRange.status).toBe(409);

      const restoredReplacement = path.join(observedRoot, "restored.txt");
      await writeFile(restoredReplacement, bytes);
      await utimes(restoredReplacement, details.atime, details.mtime);
      await rename(restoredReplacement, observedFile);
      const restoredRange = await product.result.api.request(
        `/artifact-downloads/${artifactRevisionId}`,
        { headers: { range: "bytes=1-3" } },
      );
      expect(restoredRange.status).toBe(206);
      await expect(restoredRange.bytes()).resolves.toEqual(bytes.slice(1, 4));

      await writeFile(observedFile, changedSameLength);
      await utimes(observedFile, details.atime, details.mtime);
      const rewrittenRange = await product.result.api.request(
        `/artifact-downloads/${artifactRevisionId}`,
        { headers: { range: "bytes=0-2" } },
      );
      expect(rewrittenRange.status).toBe(409);
      await writeFile(observedFile, bytes);
      await utimes(observedFile, details.atime, details.mtime);

      const lease = await application.openArtifactBytes({
        selection: { artifactRevisionId },
        expectedBlobDigest: descriptor.blobDigest,
        interval: {
          startInclusive: 0,
          endInclusive: descriptor.byteLength - 1,
        },
      });
      await lease.read({
        maximumBytes: 1,
        cancellation: { cancelled: false, onCancel: () => () => undefined },
      });

      const replacement = path.join(observedRoot, "replacement.txt");
      await writeFile(replacement, bytes);
      await utimes(replacement, details.atime, details.mtime);
      await rename(replacement, observedFile);
      await expect(
        lease.read({
          maximumBytes: Number.MAX_SAFE_INTEGER,
          cancellation: { cancelled: false, onCancel: () => () => undefined },
        }),
      ).rejects.toMatchObject({ code: "artifact-bytes-changed" });
      await lease.close("failed");

      const revokeLease = await application.openArtifactBytes({
        selection: { artifactRevisionId },
        expectedBlobDigest: descriptor.blobDigest,
        interval: {
          startInclusive: 0,
          endInclusive: descriptor.byteLength - 1,
        },
      });

      await application.workflow.observedRootRegistrations.deactivate({
        id: registration.id,
        expectedVersion: registration.configVersion,
      });
      await expect(
        revokeLease.read({
          maximumBytes: 1,
          cancellation: { cancelled: false, onCancel: () => () => undefined },
        }),
      ).rejects.toMatchObject({ code: "artifact-location-revoked" });
      await revokeLease.close("failed");
      await revokeLease.close("failed");
      const revoked = await product.result.api.request(
        `/observed-file-downloads/${selectionId}`,
      );
      expect(revoked.status).toBe(409);
      await expect(revoked.json()).resolves.toEqual({
        error: "artifact-location-revoked",
      });
    } finally {
      await closeProduct?.();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
