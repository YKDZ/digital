import { cp, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { ProductConfiguration } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import { createPublicApiClient } from "@digital/public-api";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
  resolveSourceIoFromEnvironment,
} from "@digital/test-support/source-io";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { createProductService } from "../src/service.ts";

const active: Array<{
  readonly closeServer: () => Promise<void>;
  readonly closeService: () => Promise<void>;
  readonly root: string;
}> = [];
const materialRoot = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/publication-screen/material"),
);
const nbinetManifestPath = fileURLToPath(
  import.meta
    .resolve("@digital/preview-corpus/publication-screen/manifest.json"),
);

afterEach(async () => {
  for (const service of active.splice(0).reverse()) {
    await service.closeServer();
    await service.closeService();
    await rm(service.root, { recursive: true, force: true });
  }
});

it("公开来源输入要求，供调用者按来源准备有效的识别或补充请求", async () => {
  const baseUrl = await startService();
  const client = createPublicApiClient({ baseUrl });

  const requirements = await client.listSourceInputRequirements();

  expect(requirements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceIdentity: "nbinet",
        fields: expect.arrayContaining([
          expect.objectContaining({ key: "isbn", required: true }),
        ]),
      }),
    ]),
  );
});

it("定向来源识别拒绝缺少来源坐标的请求", async () => {
  const baseUrl = await startService();

  const response = await fetch(
    new URL("/api/v1/directed-recognitions", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ registrationId: "root", relativeScope: "." }),
    },
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: "invalid-request" },
  });
});

it("通过正式检查、准备和确认流程将普通本地材料纳入资产", async () => {
  const baseUrl = await startService();
  const client = createPublicApiClient({ baseUrl });
  const materialDirectory = path.join(active.at(-1)!.root, "我的资料");
  await mkdir(materialDirectory, { recursive: true });
  await writeFile(path.join(materialDirectory, "一本书.txt"), "正文内容");
  const library = await client.saveAssetLibrary({
    displayName: "本地材料库",
    directories: [materialDirectory],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });

  const started = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(started.parentExecutionId))
          .status,
      { timeout: 5_000 },
    )
    .toBe("completed");
  const directoryId = library.directories[0]?.id;
  expect(directoryId).toBeTypeOf("string");
  if (directoryId === undefined) throw new Error("资产库目录缺失");

  const intake = await client.inspectLocalIntake({
    assetLibraryId: library.id,
    directoryId,
    parentExecutionId: started.parentExecutionId,
  });
  expect(intake.files).toEqual([
    expect.objectContaining({ relativePath: "一本书.txt", size: 12 }),
  ]);
  expect(intake.execution?.id).toBeTypeOf("string");
  await expect(
    client.prepareLocalContent({
      executionId: intake.execution!.id,
      relativePaths: ["missing.txt"],
      classification: "book",
    }),
  ).rejects.toMatchObject({ kind: "invalid-request", status: 400 });

  const proposed = await client.prepareLocalContent({
    executionId: intake.execution!.id,
    relativePaths: ["一本书.txt"],
    classification: "book",
    name: "人工整理的书",
  });
  expect(proposed.status).toBe("proposed");
  expect(proposed.relativePaths).toEqual(["一本书.txt"]);
  expect(proposed.content.id).toBeTypeOf("string");
  await expect(
    client.inspectLocalContent(proposed.executionId),
  ).resolves.toMatchObject({
    status: "proposed",
    relativePaths: ["一本书.txt"],
  });

  const accepted = await client.confirmLocalContent(proposed.executionId);
  expect(accepted).toMatchObject({
    executionId: proposed.executionId,
    status: "accepted",
    content: { id: proposed.content.id },
  });
  await expect(
    client.listAssets({ assetLibraryId: library.id }),
  ).resolves.toMatchObject({
    items: [expect.objectContaining({ id: proposed.content.id })],
  });

  const associationDecisionStart = await client.startSourceAssociationDecision({
    intent: "establish",
    assetId: proposed.content.id,
    sourceIdentity: "nbinet",
    sourceInput: { isbn: "9789864738281" },
    initiatedBy: "operator",
  });
  await expect
    .poll(
      async () =>
        (
          await client.inspectSourceAssociationDecision(
            associationDecisionStart.executionId,
          )
        ).status,
      { timeout: 5_000 },
    )
    .toBe("failed");
  const failedDecision = await client.inspectSourceAssociationDecision(
    associationDecisionStart.executionId,
  );
  expect(failedDecision).toMatchObject({
    state: "failed",
    availableActions: expect.arrayContaining(["retry"]),
  });
  const retriedDecision = await client.retrySourceAssociationDecision(
    associationDecisionStart.executionId,
  );
  expect(retriedDecision.executionId).not.toBe(
    associationDecisionStart.executionId,
  );
  await expect
    .poll(
      async () =>
        (
          await client.inspectSourceAssociationDecision(
            retriedDecision.executionId,
          )
        ).status,
      { timeout: 5_000 },
    )
    .toBe("failed");

  const associatedMaterialPath = path.join(materialDirectory, "补充材料.txt");
  await writeFile(associatedMaterialPath, "新增的完整材料");
  const invalidAssociation = await client.prepareObservedMaterialAssociation({
    targetAssetId: proposed.content.id,
    assetLibraryId: library.id,
    directoryId,
    relativeScope: ".",
    relativePaths: ["missing.txt"],
    initiatedBy: "operator",
  });
  await expect
    .poll(
      async () =>
        (
          await client.inspectObservedMaterialAssociation(
            invalidAssociation.executionId,
          )
        ).status,
      { timeout: 5_000 },
    )
    .toBe("failed");
  const association = await client.prepareObservedMaterialAssociation({
    targetAssetId: proposed.content.id,
    assetLibraryId: library.id,
    directoryId,
    relativeScope: ".",
    relativePaths: ["补充材料.txt"],
    initiatedBy: "operator",
  });
  await expect
    .poll(
      async () =>
        (
          await client.inspectObservedMaterialAssociation(
            association.executionId,
          )
        ).status,
      { timeout: 5_000 },
    )
    .toBe("awaiting-confirmation");
  const associationReview = await client.inspectObservedMaterialAssociation(
    association.executionId,
  );
  expect(associationReview).toMatchObject({
    target: { id: proposed.content.id },
    observedRoot: { relativeScope: "." },
    files: [
      expect.objectContaining({
        relativePath: "补充材料.txt",
        formatValid: true,
      }),
    ],
    proposal: {
      materials: [
        { relativePath: "补充材料.txt", role: "asset.material-delivered" },
      ],
    },
  });
  const associationResult = await client.confirmObservedMaterialAssociation(
    association.executionId,
    "operator",
  );
  expect(associationResult).toMatchObject({
    status: "accepted",
    confirmedBy: "operator",
    associationIds: [expect.any(String)],
  });

  const staleMaterialPath = path.join(materialDirectory, "变化中的材料.txt");
  await writeFile(staleMaterialPath, "确认前会变化");
  const staleAssociation = await client.prepareObservedMaterialAssociation({
    targetAssetId: proposed.content.id,
    assetLibraryId: library.id,
    directoryId,
    relativeScope: ".",
    relativePaths: ["变化中的材料.txt"],
    initiatedBy: "operator",
  });
  await expect
    .poll(
      async () =>
        (
          await client.inspectObservedMaterialAssociation(
            staleAssociation.executionId,
          )
        ).status,
      { timeout: 5_000 },
    )
    .toBe("awaiting-confirmation");
  await writeFile(staleMaterialPath, "确认前内容已经变化");
  await expect(
    client.confirmObservedMaterialAssociation(
      staleAssociation.executionId,
      "operator",
    ),
  ).resolves.toMatchObject({ status: "stale", failure: "material-stale" });

  const beforeRetraction = await client.inspectSourceAssociationHistory(
    proposed.content.id,
  );
  expect(beforeRetraction.recognitionState).toBe("recognized");
  await expect(
    client.prepareRecognitionRetraction({
      assetId: proposed.content.id,
      predecessorDecisionId: beforeRetraction.recognitionDecisionId!,
      proposedBy: "operator",
      reason: " ",
    }),
  ).rejects.toMatchObject({ kind: "invalid-request", status: 400 });
  await expect(
    client.prepareRecognitionRetraction({
      assetId: "missing-asset",
      predecessorDecisionId: "missing-decision",
      proposedBy: "operator",
      reason: "不存在的识别",
    }),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });
  await expect(
    client.prepareRecognitionScopeAmendment({
      sourceExecutionId: "missing-execution",
      workItemKey: "missing-work-item",
      proposedBy: "operator",
      reason: "不存在的范围",
    }),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });
  const failedPreparationDatabase = new DatabaseSync(
    path.join(active.at(-1)!.root, "product-data", "catalogue.sqlite"),
  );
  failedPreparationDatabase.exec(`
    CREATE TRIGGER reject_recognition_retraction_preview
    BEFORE INSERT ON change_impact_previews
    BEGIN
      SELECT RAISE(ABORT, '10 confidential recognition write failure');
    END;
  `);
  try {
    const failedPreparation = await fetch(
      new URL("/api/v1/recognition-retractions", baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assetId: proposed.content.id,
          predecessorDecisionId: beforeRetraction.recognitionDecisionId,
          proposedBy: "operator",
          reason: "验证存储故障不会变成业务冲突",
        }),
      },
    );
    const body = await failedPreparation.text();
    expect(failedPreparation.status).toBe(503);
    expect(body).toContain("暂时无法形成身份撤回预演");
    expect(body).not.toContain("10 confidential recognition write failure");
    expect(body).not.toContain("SQLITE_CONSTRAINT_TRIGGER");
  } finally {
    failedPreparationDatabase.exec(
      "DROP TRIGGER reject_recognition_retraction_preview",
    );
    failedPreparationDatabase.close();
  }
  const rejectedPreview = await client.prepareRecognitionRetraction({
    assetId: proposed.content.id,
    predecessorDecisionId: beforeRetraction.recognitionDecisionId!,
    proposedBy: "operator",
    reason: "保留当前识别",
  });
  expect(rejectedPreview).toMatchObject({
    status: "awaiting-confirmation",
    current: { recognitionState: "recognized" },
    projected: { recognitionState: "unresolved" },
  });
  await expect(
    client.confirmChangeImpactPreview(rejectedPreview.previewId, ""),
  ).rejects.toMatchObject({ kind: "invalid-request" });
  await expect(
    client.rejectChangeImpactPreview(rejectedPreview.previewId, "operator"),
  ).resolves.toMatchObject({ status: "rejected" });
  await expect(
    client.inspectSourceAssociationHistory(proposed.content.id),
  ).resolves.toMatchObject({ recognitionState: "recognized" });

  const confirmedPreview = await client.prepareRecognitionRetraction({
    assetId: proposed.content.id,
    predecessorDecisionId: beforeRetraction.recognitionDecisionId!,
    proposedBy: "operator",
    reason: "材料不足，撤回当前识别",
  });
  await expect(
    client.confirmChangeImpactPreview(confirmedPreview.previewId, "operator"),
  ).resolves.toMatchObject({
    status: "applied",
    current: { recognitionState: "recognized" },
    projected: { recognitionState: "unresolved" },
  });
  await expect(
    client.inspectSourceAssociationHistory(proposed.content.id),
  ).resolves.toMatchObject({ recognitionState: "unresolved" });
  await expect(
    client.prepareRecognitionRetraction({
      assetId: proposed.content.id,
      predecessorDecisionId: beforeRetraction.recognitionDecisionId!,
      proposedBy: "operator",
      reason: "点名已撤回的识别",
    }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });
}, 60_000);

it("当前未识别材料排除定向识别已认领路径并保留历史与未认领分页", async () => {
  const directoryName =
    "[怒火救援].Man.on.Fire.2004.Blu-ray.1080p.AVC.DTS-HD.MA5.1-CMCT";
  const relativeFilmPaths = [
    `${directoryName}/BDMV/index.bdmv`,
    `${directoryName}/BDMV/PLAYLIST/00001.mpls`,
    `${directoryName}/BDMV/STREAM/00001.m2ts`,
    `${directoryName}/BDMV/STREAM/00002.m2ts`,
  ];
  const controlled = await loadControlledSourceIo({
    manifestPath: nbinetManifestPath,
  });
  const sourceIo: NonNullable<ProductConfiguration["sourceIo"]> = {
    mode: "controlled",
    request: controlled.request,
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  const baseUrl = await startService(sourceIo);
  const client = createPublicApiClient({ baseUrl });
  const materialDirectory = path.join(active.at(-1)!.root, "电影资料库目录");
  await mkdir(materialDirectory, { recursive: true });
  await cp(
    path.join(materialRoot, "films", directoryName),
    path.join(materialDirectory, directoryName),
    { recursive: true },
  );
  await writeFile(path.join(materialDirectory, "未认领甲.txt"), "普通说明甲\n");
  await writeFile(path.join(materialDirectory, "未认领乙.txt"), "普通说明乙\n");

  const library = await client.saveAssetLibrary({
    displayName: "当前未识别过滤库",
    directories: [materialDirectory],
    recognitionProfileIds: ["movies"],
    sourceIdentities: ["tmdb"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 30_000 },
    )
    .toBe("completed");
  const scanInspection = await client.inspectAssetLibraryScan(
    scan.parentExecutionId,
  );
  const registrationId = scanInspection.directories[0]?.id;
  expect(registrationId).toBeTypeOf("string");
  const initial = await client.listUnrecognizedMaterials({
    assetLibraryId: library.id,
    limit: 100,
  });
  const initialPaths = initial.items.flatMap(
    ({ relativePaths }) => relativePaths,
  );
  expect(initialPaths).toEqual(
    expect.arrayContaining([
      ...relativeFilmPaths,
      "未认领甲.txt",
      "未认领乙.txt",
    ]),
  );

  await expect(
    client.configureSourceConnection({
      sourceId: "tmdb",
      expectedVersion: 0,
      secret: "controlled-unrecognized-tmdb-token",
    }),
  ).resolves.toMatchObject({ verification: "verified" });
  const directed = await client.startDirectedRecognition({
    registrationId: registrationId!,
    relativeScope: directoryName,
    sourceIdentity: "tmdb",
    sourceInput: { movie: "9509" },
  });
  await expect
    .poll(async () => (await client.inspectExecution(directed.id)).status, {
      timeout: 60_000,
    })
    .toBe("completed");

  const assets = await client.listAssets({
    assetLibraryId: library.id,
    limit: 20,
  });
  const recognizedFilm = assets.items.find((asset) =>
    asset.locations.some(({ address }) =>
      address.endsWith(relativeFilmPaths[0]!),
    ),
  );
  expect(recognizedFilm).toBeDefined();
  expect(
    recognizedFilm!.locations
      .map(({ address }) => address)
      .filter((address) =>
        relativeFilmPaths.some((relativePath) =>
          address.endsWith(relativePath),
        ),
      ),
  ).toHaveLength(relativeFilmPaths.length);

  const historical = await client.listUnrecognizedMaterials({
    assetLibraryId: library.id,
    parentExecutionId: scan.parentExecutionId,
    limit: 100,
  });
  expect(
    historical.items.flatMap(({ relativePaths }) => relativePaths),
  ).toEqual(expect.arrayContaining(relativeFilmPaths));

  const currentPaths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listUnrecognizedMaterials({
      assetLibraryId: library.id,
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(page.items).toHaveLength(1);
    currentPaths.push(
      ...page.items.flatMap(({ relativePaths }) => relativePaths),
    );
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  expect(currentPaths.toSorted()).toEqual(["未认领乙.txt", "未认领甲.txt"]);
}, 90_000);

it("通过公开 HTTP 选择 KADOKAWA 日本多候选之一并确认其来源依据", async () => {
  const controlled = createKadokawaControlledSourceIo();
  const baseUrl = await startService(controlled.sourceIo);
  const client = createPublicApiClient({ baseUrl });
  const accepted = await createAcceptedBook(client, "选择来源候选");
  controlled.setMode("multiple");

  const started = await client.startSourceAssociationDecision({
    intent: "establish",
    assetId: accepted.assetId,
    sourceIdentity: "kadokawa-jp",
    sourceInput: { isbn: kadokawaIsbn },
    initiatedBy: "operator",
  });
  await expect
    .poll(
      async () =>
        (await client.inspectSourceAssociationDecision(started.executionId))
          .state,
      { timeout: 30_000 },
    )
    .toBe("awaiting-selection");
  const decision = await client.inspectSourceAssociationDecision(
    started.executionId,
  );
  expect(decision.candidates).toHaveLength(2);
  expect(decision.candidates.map(({ nativeAddress }) => nativeAddress)).toEqual(
    [
      "https://www.kadokawa.co.jp/product/321912000002/",
      "https://www.kadokawa.co.jp/product/321912000003/",
    ],
  );
  const selectedCandidate = decision.candidates.find(
    ({ nativeAddress }) =>
      nativeAddress === "https://www.kadokawa.co.jp/product/321912000003/",
  );
  expect(selectedCandidate?.reference).toBeTypeOf("string");
  if (selectedCandidate === undefined)
    throw new Error("没有找到第二册来源候选");

  const selected = await client.selectSourceAssociationCandidate(
    started.executionId,
    selectedCandidate.reference,
  );
  expect(selected).toMatchObject({
    state: "awaiting-confirmation",
    preview: { status: "awaiting-confirmation" },
  });
  const previewId = selected.preview?.previewId;
  expect(previewId).toBeTypeOf("string");
  if (previewId === undefined) throw new Error("候选选择没有生成变更预演");
  await expect(
    client.inspectChangeImpactPreview(previewId),
  ).resolves.toMatchObject({
    status: "awaiting-confirmation",
    projected: {
      recognitionState: "recognized",
      sourceAssociations: [
        {
          sourceIdentity: "kadokawa-jp",
          nativeAddress: "https://www.kadokawa.co.jp/product/321912000003/",
        },
      ],
    },
  });
  await expect(
    client.confirmChangeImpactPreview(previewId, "operator"),
  ).resolves.toMatchObject({ status: "applied" });

  await expect(
    client.inspectSourceAssociationHistory(accepted.assetId),
  ).resolves.toMatchObject({
    current: [
      expect.objectContaining({
        sourceIdentity: "kadokawa-jp",
        nativeAddress: "https://www.kadokawa.co.jp/product/321912000003/",
      }),
    ],
  });
  const currentValues = await client.listAssetEvidence(accepted.assetId, {
    kind: "current-values",
    limit: 100,
  });
  expect(currentValues.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "current-value",
        evidence: expect.objectContaining({
          property: "book.isbn-13",
          result: expect.objectContaining({
            status: "resolved",
            values: expect.arrayContaining([
              expect.objectContaining({
                value: kadokawaIsbn,
                sourceIdentity: "kadokawa-jp",
                sourceRecordIds: [expect.any(String)],
              }),
            ]),
          }),
        }),
      }),
      expect.objectContaining({
        kind: "current-value",
        evidence: expect.objectContaining({
          property: "asset.title",
          result: expect.objectContaining({
            status: "resolved",
            notSelected: expect.arrayContaining([
              expect.objectContaining({
                value: "第二册",
                sourceIdentity: "kadokawa-jp",
              }),
            ]),
          }),
        }),
      }),
    ]),
  );
  expect(controlled.requests).toEqual([
    "POST https://www.kadokawa.co.jp/product/search/",
    "GET https://www.kadokawa.co.jp/product/321912000002/",
    "GET https://www.kadokawa.co.jp/product/321912000003/",
  ]);
});

it("来源补充成功及失败后重试成功都会更新当前来源结果和依据", async () => {
  const controlled = await createNbinetControlledSourceIo();
  const baseUrl = await startService(controlled.sourceIo);
  const client = createPublicApiClient({ baseUrl });

  const successAsset = await createAcceptedBook(
    client,
    "来源补充成功",
    "nbinet",
  );
  const successful = await client.startSourceEnrichment({
    subjectId: successAsset.assetId,
    assetLibraryId: successAsset.assetLibraryId,
    sourceIdentity: "nbinet",
    sourceInput: { isbn: nbinetIsbn },
  });
  await expect
    .poll(
      async () => (await client.inspectSourceEnrichment(successful.id)).status,
      { timeout: 30_000 },
    )
    .not.toBe("running");
  const successfulInspection = await client.inspectSourceEnrichment(
    successful.id,
  );
  expect(successfulInspection).toMatchObject({
    status: "completed",
    outcome: "accepted",
    items: [
      expect.objectContaining({
        sourceIdentity: "nbinet",
        input: { isbn: nbinetIsbn },
        status: "completed",
        canRetry: false,
      }),
    ],
    sourceAssociations: [
      expect.objectContaining({
        sourceIdentity: "nbinet",
        nativeAddress: expect.stringContaining(
          "q=isbn%2Cexact%2C9789864738281",
        ),
      }),
    ],
  });
  const successEvidence = await client.listAssetEvidence(successAsset.assetId, {
    kind: "current-values",
    limit: 100,
  });
  expect(successEvidence.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "current-value",
        evidence: expect.objectContaining({
          property: "book.isbn-13",
          result: expect.objectContaining({
            status: "resolved",
            values: expect.arrayContaining([
              expect.objectContaining({
                value: nbinetIsbn,
                sourceIdentity: "nbinet",
                sourceRecordIds: [expect.any(String)],
              }),
            ]),
          }),
        }),
      }),
    ]),
  );

  const retryAsset = await createAcceptedBook(
    client,
    "失败后重试成功",
    "nbinet",
  );
  const retryIsbn = "9789864738298";
  controlled.setMode("unavailable");
  const failed = await client.startSourceEnrichment({
    subjectId: retryAsset.assetId,
    assetLibraryId: retryAsset.assetLibraryId,
    sourceIdentity: "nbinet",
    sourceInput: { isbn: retryIsbn },
  });
  await expect
    .poll(
      async () => (await client.inspectSourceEnrichment(failed.id)).status,
      { timeout: 30_000 },
    )
    .toBe("failed");
  const failedEvidence = await client.listAssetEvidence(retryAsset.assetId, {
    kind: "current-values",
    limit: 100,
  });
  expect(failedEvidence.items).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "current-value",
        evidence: expect.objectContaining({ property: "book.isbn-13" }),
      }),
    ]),
  );
  await expect(
    client.listRetryableSourceEnrichments(retryAsset.assetId),
  ).resolves.toContainEqual(
    expect.objectContaining({
      executionId: failed.id,
      subjectId: retryAsset.assetId,
      sourceIdentity: "nbinet",
      canRetry: true,
    }),
  );

  controlled.setMode("success");
  const retried = await client.retrySourceEnrichment({
    executionId: failed.id,
    subjectId: retryAsset.assetId,
    sourceIdentity: "nbinet",
  });
  expect(retried.id).not.toBe(failed.id);
  await expect
    .poll(
      async () => (await client.inspectSourceEnrichment(retried.id)).status,
      { timeout: 30_000 },
    )
    .not.toBe("running");
  const retriedInspection = await client.inspectSourceEnrichment(retried.id);
  expect(retriedInspection).toMatchObject({
    status: "completed",
    outcome: "accepted",
    executionId: retried.id,
    items: [
      expect.objectContaining({
        sourceIdentity: "nbinet",
        input: { isbn: retryIsbn },
        status: "completed",
        canRetry: false,
      }),
    ],
    sourceAssociations: [
      expect.objectContaining({
        sourceIdentity: "nbinet",
        nativeAddress: expect.stringContaining(
          "q=isbn%2Cexact%2C9789864738298",
        ),
      }),
    ],
  });
  const retryEvidence = await client.listAssetEvidence(retryAsset.assetId, {
    kind: "current-values",
    limit: 100,
  });
  expect(retryEvidence.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "current-value",
        evidence: expect.objectContaining({
          property: "book.isbn-13",
          result: expect.objectContaining({
            status: "resolved",
            values: expect.arrayContaining([
              expect.objectContaining({
                value: retryIsbn,
                sourceIdentity: "nbinet",
                sourceRecordIds: [expect.any(String)],
              }),
            ]),
          }),
        }),
      }),
    ]),
  );
  await expect(
    client.inspectSourceAssociationHistory(retryAsset.assetId),
  ).resolves.toMatchObject({
    current: [
      expect.objectContaining({
        sourceIdentity: "nbinet",
        nativeAddress: expect.stringContaining(
          "q=isbn%2Cexact%2C9789864738298",
        ),
      }),
    ],
  });
}, 60_000);

it("来源补充在真实 HTTP 宿主重启后结为中断，并以新执行编号成功重试", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc10-enrichment-recovery-"));
  const productDataDirectory = path.join(root, "product-data");
  await prepareProductionCatalogue({ productDataDirectory });
  const gated = await createGatedNbinetControlledSourceIo();
  const baseUrl = await startServiceAt(root, gated.sourceIo);
  const client = createPublicApiClient({ baseUrl });

  const accepted = await createAcceptedBook(client, "中断后补充来源", "nbinet");
  const pendingResponse = client.startSourceEnrichment({
    subjectId: accepted.assetId,
    assetLibraryId: accepted.assetLibraryId,
    sourceIdentity: "nbinet",
    sourceInput: { isbn: nbinetIsbn },
  });
  await gated.entered;
  const returnedBeforeSource = await settlesWithin(pendingResponse, 100);
  if (!returnedBeforeSource) gated.release();
  expect(returnedBeforeSource).toBe(true);
  const started = await pendingResponse;
  expect(started.id).toBeTypeOf("string");
  await expect(
    client.inspectSourceEnrichment(started.id),
  ).resolves.toMatchObject({
    executionId: started.id,
    status: "running",
    items: [
      expect.objectContaining({
        input: { isbn: nbinetIsbn },
        status: "running",
      }),
    ],
    sourceAssociations: [],
  });

  const previousService = active.at(-1);
  if (previousService === undefined)
    throw new Error("来源补充服务没有登记清理现场");
  const closing = previousService.closeService();
  gated.release();
  await closing;
  await previousService.closeServer();
  active.splice(active.indexOf(previousService), 1);

  const restartedUrl = await startServiceAt(root, gated.sourceIo);
  const restarted = createPublicApiClient({ baseUrl: restartedUrl });
  await expect
    .poll(
      async () => (await restarted.inspectSourceEnrichment(started.id)).status,
      { timeout: 30_000 },
    )
    .toBe("failed");
  const interrupted = await restarted.inspectSourceEnrichment(started.id);
  expect(interrupted).toMatchObject({
    executionId: started.id,
    status: "failed",
    outcome: "interrupted",
    items: [
      expect.objectContaining({
        input: { isbn: nbinetIsbn },
      }),
    ],
    sourceAssociations: [],
  });

  const retried = await restarted.startSourceEnrichment({
    subjectId: accepted.assetId,
    assetLibraryId: accepted.assetLibraryId,
    sourceIdentity: "nbinet",
    sourceInput: { isbn: nbinetIsbn },
  });
  expect(retried.id).not.toBe(started.id);
  await expect
    .poll(
      async () => (await restarted.inspectSourceEnrichment(retried.id)).status,
      { timeout: 30_000 },
    )
    .toBe("completed");
  await expect(
    restarted.inspectSourceEnrichment(retried.id),
  ).resolves.toMatchObject({
    executionId: retried.id,
    outcome: "accepted",
    sourceAssociations: [expect.objectContaining({ sourceIdentity: "nbinet" })],
  });
  await expect(
    restarted.inspectSourceAssociationHistory(accepted.assetId),
  ).resolves.toMatchObject({
    current: [expect.objectContaining({ sourceIdentity: "nbinet" })],
  });
}, 90_000);

it("指定来源识别在真实 HTTP 宿主重启后结为中断，且重试以新编号认领材料", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc10-directed-recovery-"));
  const productDataDirectory = path.join(root, "product-data");
  await prepareProductionCatalogue({ productDataDirectory });
  const gated = await createGatedNbinetControlledSourceIo();
  const baseUrl = await startServiceAt(root, gated.sourceIo);
  const client = createPublicApiClient({ baseUrl });
  const materialDirectory = path.join(root, "待识别材料");
  await mkdir(materialDirectory, { recursive: true });
  await writeFile(
    path.join(materialDirectory, "待识别.pdf"),
    syntheticPdf({ author: "Local Author", pageCount: 1 }),
  );
  const library = await client.saveAssetLibrary({
    displayName: "指定来源识别恢复库",
    directories: [materialDirectory],
    recognitionProfileIds: ["books"],
    sourceIdentities: ["nbinet"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 30_000 },
    )
    .toBe("completed");
  const scanInspection = await client.inspectAssetLibraryScan(
    scan.parentExecutionId,
  );
  const registrationId = scanInspection.directories[0]?.id;
  expect(registrationId).toBeTypeOf("string");
  if (registrationId === undefined)
    throw new Error("正式扫描没有登记指定来源识别目录");

  const pendingResponse = client.startDirectedRecognition({
    registrationId,
    relativeScope: ".",
    sourceIdentity: "nbinet",
    sourceInput: { isbn: nbinetIsbn },
  });
  await gated.entered;
  const returnedBeforeSource = await settlesWithin(pendingResponse, 100);
  if (!returnedBeforeSource) gated.release();
  expect(returnedBeforeSource).toBe(true);
  const started = await pendingResponse;
  expect(started.id).toBeTypeOf("string");

  const previousService = active.at(-1);
  if (previousService === undefined)
    throw new Error("指定来源识别服务没有登记清理现场");
  const closing = previousService.closeService();
  gated.release();
  await closing;
  await previousService.closeServer();
  active.splice(active.indexOf(previousService), 1);

  const restartedUrl = await startServiceAt(root, gated.sourceIo);
  const restarted = createPublicApiClient({ baseUrl: restartedUrl });
  await expect
    .poll(async () => (await restarted.inspectExecution(started.id)).status, {
      timeout: 30_000,
    })
    .toBe("failed");
  const interrupted = await restarted.inspectExecution(started.id);
  expect(interrupted).toMatchObject({
    id: started.id,
    kind: "execution",
    status: "failed",
    outcome: "interrupted",
    progress: {
      workItems: [
        expect.objectContaining({
          relativePaths: ["待识别.pdf"],
        }),
      ],
    },
  });
  if (interrupted.kind !== "execution")
    throw new Error("中断的指定来源识别返回了资料库扫描");
  expect(interrupted.progress.workItems[0]?.acceptedAssetId).toBeUndefined();
  const assetsBeforeRetry = await restarted.listAssets({
    assetLibraryId: library.id,
    limit: 20,
  });
  expect(
    assetsBeforeRetry.items.flatMap(
      ({ sourceAssociations }) => sourceAssociations,
    ),
  ).toEqual([]);

  const retried = await restarted.startDirectedRecognition({
    registrationId,
    relativeScope: ".",
    sourceIdentity: "nbinet",
    sourceInput: { isbn: nbinetIsbn },
  });
  expect(retried.id).not.toBe(started.id);
  await expect
    .poll(async () => (await restarted.inspectExecution(retried.id)).status, {
      timeout: 30_000,
    })
    .toBe("completed");
  const retriedInspection = await restarted.inspectExecution(retried.id);
  expect(retriedInspection).toMatchObject({
    kind: "execution",
    id: retried.id,
    status: "completed",
    outcome: "proposal",
  });
  const history = await restarted.listWorkflowHistory({ limit: 100 });
  const retriedRecord = history.items.find(
    ({ execution }) => execution.id === retried.id,
  );
  expect(retriedRecord?.resultReferences.changeImpactPreviewIds).toHaveLength(
    1,
  );
  const previewId = retriedRecord?.resultReferences.changeImpactPreviewIds[0];
  expect(previewId).toBeTypeOf("string");
  if (previewId === undefined) throw new Error("指定来源识别没有生成确认预演");
  await expect(
    restarted.inspectChangeImpactPreview(previewId),
  ).resolves.toMatchObject({
    status: "awaiting-confirmation",
    projected: {
      recognitionState: "recognized",
      sourceAssociations: [
        expect.objectContaining({ sourceIdentity: "nbinet" }),
      ],
    },
  });
  await expect(
    restarted.confirmChangeImpactPreview(previewId, "operator"),
  ).resolves.toMatchObject({ status: "applied" });
  const assets = await restarted.listAssets({
    assetLibraryId: library.id,
    limit: 20,
  });
  expect(assets.items).toEqual([
    expect.objectContaining({
      locations: [
        expect.objectContaining({
          address: expect.stringContaining("待识别.pdf"),
        }),
      ],
      sourceAssociations: [
        expect.objectContaining({ sourceIdentity: "nbinet" }),
      ],
    }),
  ]);
}, 90_000);

it("来源补充失败后公开可重试候选，并以新执行编号保留再次获取结果", async () => {
  const baseUrl = await startService();
  const client = createPublicApiClient({ baseUrl });
  const materialDirectory = path.join(active.at(-1)!.root, "待补充来源");
  await mkdir(materialDirectory, { recursive: true });
  await writeFile(path.join(materialDirectory, "一本书.txt"), "正文内容");
  const library = await client.saveAssetLibrary({
    displayName: "来源补充库",
    directories: [materialDirectory],
    recognitionProfileIds: ["books"],
    sourceIdentities: ["nbinet"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 30_000 },
    )
    .toBe("completed");
  const intake = await client.inspectLocalIntake({
    assetLibraryId: library.id,
    directoryId: library.directories[0]!.id,
    parentExecutionId: scan.parentExecutionId,
  });
  const accepted = await client.confirmLocalContent(
    (
      await client.prepareLocalContent({
        executionId: intake.execution!.id,
        relativePaths: ["一本书.txt"],
        classification: "book",
        name: "待补充来源的书",
      })
    ).executionId,
  );

  await expect(
    client.startSourceEnrichment({
      subjectId: accepted.content.id,
      sourceIdentity: "unknown-source",
      sourceInput: { isbn: "9789864738281" },
    }),
  ).rejects.toMatchObject({ kind: "invalid-request", status: 400 });
  const started = await client.startSourceEnrichment({
    subjectId: accepted.content.id,
    assetLibraryId: library.id,
    sourceIdentity: "nbinet",
    sourceInput: { isbn: "9789864738281" },
  });
  await expect
    .poll(
      async () => (await client.inspectSourceEnrichment(started.id)).status,
      { timeout: 30_000 },
    )
    .toBe("failed");
  const failed = await client.inspectSourceEnrichment(started.id);
  expect(failed).toMatchObject({
    executionId: started.id,
    status: "failed",
    items: [
      expect.objectContaining({
        sourceIdentity: "nbinet",
        input: { isbn: "9789864738281" },
        canRetry: true,
      }),
    ],
    sourceAssociations: [],
  });
  const retries = await client.listRetryableSourceEnrichments(
    accepted.content.id,
  );
  expect(retries).toContainEqual(
    expect.objectContaining({
      executionId: started.id,
      subjectId: accepted.content.id,
      sourceIdentity: "nbinet",
      canRetry: true,
    }),
  );

  const retried = await client.retrySourceEnrichment({
    executionId: started.id,
    subjectId: accepted.content.id,
    sourceIdentity: "nbinet",
  });
  expect(retried.id).not.toBe(started.id);
  await expect
    .poll(
      async () => (await client.inspectSourceEnrichment(retried.id)).status,
      { timeout: 30_000 },
    )
    .toBe("failed");
  await expect(
    client.inspectSourceEnrichment("missing-execution"),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });
});

it("通过公开 HTTP 预演并确认完整识别范围调整", async () => {
  const baseUrl = await startService();
  const client = createPublicApiClient({ baseUrl });
  const directory = path.join(active.at(-1)!.root, "范围调整资料");
  await mkdir(directory, { recursive: true });
  const primary = path.join(directory, "publication.epub");
  await cp(
    path.join(materialRoot, "books", "架构整洁之道", "publication.epub"),
    primary,
  );
  const library = await client.saveAssetLibrary({
    displayName: "范围调整资料库",
    directories: [directory],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  const initialScan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(initialScan.parentExecutionId))
          .status,
      { timeout: 30_000 },
    )
    .toBe("completed");
  const initialInspection = await client.inspectAssetLibraryScan(
    initialScan.parentExecutionId,
  );
  const assetId = initialInspection.directories
    .flatMap((directory) => directory.files)
    .find((file) => file.assetId !== undefined)?.assetId;
  if (assetId === undefined) throw new Error("首次范围观察没有接受 EPUB 内容");

  await link(primary, path.join(directory, "publication-alias.epub"));
  const expandedScan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(expandedScan.parentExecutionId))
          .status,
      { timeout: 30_000 },
    )
    .toBe("completed");
  const rangeMaterial = await client.listUnrecognizedMaterials({
    assetLibraryId: library.id,
    parentExecutionId: expandedScan.parentExecutionId,
    limit: 100,
  });
  const rangeItem = rangeMaterial.items.find(
    (item) =>
      item.kind === "work-item" &&
      item.relativePaths.includes("publication-alias.epub"),
  );
  if (rangeItem === undefined || rangeItem.kind !== "work-item")
    throw new Error("新增别名没有留下待明确的完整范围工作项");

  await expect(
    client.prepareRecognitionScopeAmendment({
      sourceExecutionId: rangeItem.childExecutionId,
      workItemKey: "missing-work-item",
      proposedBy: "operator",
      reason: "点名已变化的工作项",
    }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });
  await expect(
    client.prepareRecognitionScopeAmendment({
      sourceExecutionId: rangeItem.childExecutionId,
      workItemKey: rangeItem.workItemKey,
      proposedBy: " ",
      reason: "无效提议者",
    }),
  ).rejects.toMatchObject({ kind: "invalid-request", status: 400 });
  const preview = await client.prepareRecognitionScopeAmendment({
    sourceExecutionId: rangeItem.childExecutionId,
    workItemKey: rangeItem.workItemKey,
    proposedBy: "operator",
    reason: "明确新增别名与原出版物属于同一材料范围",
  });
  expect(preview).toMatchObject({
    assetId,
    status: "awaiting-confirmation",
    current: { recognitionDecisionId: expect.any(String) },
  });
  await expect(
    client.confirmChangeImpactPreview(preview.previewId, "operator"),
  ).resolves.toMatchObject({ status: "applied" });
  await expect(
    client.inspectChangeImpactPreview(preview.previewId),
  ).resolves.toMatchObject({
    status: "applied",
    projected: {
      recognitionDecisionId: expect.any(String),
    },
  });
}, 60_000);

async function startService(
  configuredSourceIo?: ProductConfiguration["sourceIo"],
): Promise<URL> {
  const root = await mkdtemp(path.join(tmpdir(), "ewc10-http-"));
  const productDataDirectory = path.join(root, "product-data");
  await prepareProductionCatalogue({ productDataDirectory });
  return await startServiceAt(root, configuredSourceIo);
}

async function startServiceAt(
  root: string,
  configuredSourceIo?: ProductConfiguration["sourceIo"],
): Promise<URL> {
  const productDataDirectory = path.join(root, "product-data");
  const sourceIo =
    configuredSourceIo ??
    (await resolveSourceIoFromEnvironment({
      DIGITAL_SOURCE_IO_MODE: "offline",
    }));
  const bootstrap = await createProductService({
    productDataDirectory,
    environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
    sourceIo,
  });
  const server = serve({
    fetch: bootstrap.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  await server.ready();
  bootstrap.publish();
  const baseUrl = new URL(server.url!);
  const service = {
    root,
    closeServer: async () => await server.close(true),
    closeService: async () => await bootstrap.abort(),
  };
  active.push(service);
  await waitForServiceReady(baseUrl);
  return baseUrl;
}

async function waitForServiceReady(address: URL): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastResponse = "尚未收到就绪响应";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/api/ready", address));
      const body: unknown = await response.json().catch(() => undefined);
      if (
        response.ok &&
        typeof body === "object" &&
        body !== null &&
        "ok" in body &&
        body.ok === true
      )
        return;
      lastResponse = `HTTP ${String(response.status)} ${JSON.stringify(body)}`;
    } catch (error) {
      lastResponse = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`正式服务在 60000 ms 内未就绪：${lastResponse}`);
}

const nbinetIsbn = "9789864738281";
const kadokawaIsbn = "9784049131291";
const kadokawaItemCodes = ["321912000002", "321912000003"] as const;

function createKadokawaControlledSourceIo() {
  let mode: "multiple" | "single" | "unavailable" = "single";
  const requests: string[] = [];
  const sourceIo: NonNullable<ProductConfiguration["sourceIo"]> = {
    mode: "controlled",
    request: async (input, init) => {
      const method = init?.method ?? "GET";
      requests.push(`${method} ${input}`);
      if (input === "https://www.kadokawa.co.jp/product/search/") {
        if (method !== "POST") throw new Error("日角搜索请求必须使用 POST");
        if (init?.body !== `isbn=${kadokawaIsbn}`)
          throw new Error("日角搜索请求没有提交指定 ISBN");
        if (mode === "unavailable")
          return kadokawaResponse("{}", input, "application/json", 503);
        const itemCodes =
          mode === "multiple" ? kadokawaItemCodes : [kadokawaItemCodes[0]];
        return kadokawaResponse(
          JSON.stringify({
            count_raw: { book: itemCodes.length },
            result: {
              book: itemCodes.map((itemCode) => ({
                isbn: kadokawaIsbn,
                itemCode,
              })),
            },
          }),
          input,
          "application/json",
        );
      }
      const itemCode = kadokawaItemCodes.find(
        (candidate) =>
          input === `https://www.kadokawa.co.jp/product/${candidate}/`,
      );
      if (method !== "GET" || itemCode === undefined)
        throw new Error(`没有受控的日角请求：${method} ${input}`);
      return kadokawaResponse(
        `<!doctype html><link rel="canonical" href="${input}"><meta itemprop="isbn" content="${kadokawaIsbn}"><meta property="og:title" content="${itemCode === kadokawaItemCodes[0] ? "第一册" : "第二册"}">`,
        input,
        "text/html",
      );
    },
    sessionTransport: refusingSessionTransport(),
  };
  return {
    sourceIo,
    requests,
    setMode(next: "multiple" | "single" | "unavailable") {
      mode = next;
    },
  };
}

function kadokawaResponse(
  body: string,
  url: string,
  mediaType: string,
  status = 200,
) {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-type" ? mediaType : null;
      },
    },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

async function createAcceptedBook(
  client: ReturnType<typeof createPublicApiClient>,
  name: string,
  sourceIdentity = "kadokawa-jp",
) {
  const directory = path.join(active.at(-1)!.root, name);
  await mkdir(directory, { recursive: true });
  const fileName = `${name}.txt`;
  await writeFile(path.join(directory, fileName), "本地材料正文");
  const library = await client.saveAssetLibrary({
    displayName: `${name}资料库`,
    directories: [directory],
    recognitionProfileIds: ["books"],
    sourceIdentities: [sourceIdentity],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 30_000 },
    )
    .toBe("completed");
  const intake = await client.inspectLocalIntake({
    assetLibraryId: library.id,
    directoryId: library.directories[0]!.id,
    parentExecutionId: scan.parentExecutionId,
  });
  const proposal = await client.prepareLocalContent({
    executionId: intake.execution!.id,
    relativePaths: [fileName],
    classification: "book",
    name,
  });
  const accepted = await client.confirmLocalContent(proposal.executionId);
  return { assetId: accepted.content.id, assetLibraryId: library.id };
}

async function createNbinetControlledSourceIo() {
  const fixture = await loadControlledSourceIo({
    manifestPath: nbinetManifestPath,
  });
  let mode: "success" | "unavailable" = "success";
  const sourceIo: NonNullable<ProductConfiguration["sourceIo"]> = {
    mode: "controlled",
    request: async (input, init) =>
      mode === "success"
        ? await fixture.request(input, init)
        : kadokawaResponse("{}", input, "application/json", 503),
    sessionTransport: fixture.sessionTransport ?? refusingSessionTransport(),
  };
  return {
    sourceIo,
    setMode(next: "success" | "unavailable") {
      mode = next;
    },
  };
}

async function createGatedNbinetControlledSourceIo() {
  const fixture = await loadControlledSourceIo({
    manifestPath: nbinetManifestPath,
  });
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let shouldBlock = true;
  const sourceIo: NonNullable<ProductConfiguration["sourceIo"]> = {
    mode: "controlled",
    async request(input, init) {
      if (shouldBlock) {
        shouldBlock = false;
        markEntered();
        await released;
      }
      return await fixture.request(input, init);
    },
    sessionTransport: fixture.sessionTransport ?? refusingSessionTransport(),
  };
  return {
    sourceIo,
    entered,
    release,
  };
}

async function settlesWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(resolve, milliseconds, false)),
  ]);
}

function syntheticPdf(input: {
  readonly author: string;
  readonly pageCount: number;
}): Uint8Array {
  const pageIds = Array.from(
    { length: input.pageCount },
    (_, index) => index + 3,
  );
  const infoId = input.pageCount + 3;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${input.pageCount} >>`,
    ...Array.from(
      { length: input.pageCount },
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>",
    ),
    `<< /Author (${input.author}) >>`,
  ];
  let source = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}
