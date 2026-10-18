import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProductConfiguration } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import { createPublicHttpApi } from "@digital/http-delivery";
import type { ProductApplication } from "@digital/product-application";
import { createPublicApiClient } from "@digital/public-api";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
} from "@digital/test-support/source-io";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { createProductService } from "../src/service.ts";

const running: Array<{
  readonly server: Awaited<ReturnType<typeof serve>>;
  readonly abort: () => Promise<void>;
}> = [];
const temporaryRoots: string[] = [];
const materialFixture = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/material"),
);
const sourceManifest = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/manifest.json"),
);
const sourceResponses = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/responses"),
);

afterEach(async () => {
  for (const item of running.splice(0).reverse()) {
    await item.server.close(true);
    await item.abort();
  }
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

// 场景边界：用户从空的正式 SQLite 业务库及两个普通目录开始；准备阶段仅复制 DLsite 材料，并控制第二作响应使用与第一作相同的稳定系列键，未预置实体、指称解析或关系。
// 实际操作经真实 HTTP 公共客户端完成资产库配置与扫描、关系和指称检查、人工解析、本地身份及关系创建、身份合并、合并后新增关系、公开刷新，再分别撤回指定合并与指称解析。
// 可观察结果包括来源稳定身份按键复用、同名但身份不同的材料各自保留单次出现身份（occurrence-local）、刷新后的作品名、反向作品查询，以及撤回后仍保留的来源归属、人工署名与刷新结果。
// 未覆盖 TUI 或旧 Web 的关系编辑界面；本场景仅证明公开 HTTP API 的业务路径。
it("经真实 HTTP 从普通目录形成作品关系，再独立撤回指称解析和指定身份合并", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc11-relationship-http-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const firstDirectory = path.join(root, "收藏", "声音", "2025");
  const secondDirectory = path.join(root, "继续收藏", "声音", "2026");
  await mkdir(firstDirectory, { recursive: true });
  await mkdir(secondDirectory, { recursive: true });
  await cp(
    path.join(materialFixture, "RJ01029383"),
    path.join(firstDirectory, "RJ01029383"),
    { recursive: true },
  );
  await cp(
    path.join(materialFixture, "RJ01049458"),
    path.join(secondDirectory, "RJ01049458"),
    { recursive: true },
  );
  await mkdir(path.join(firstDirectory, "普通文件夹"), { recursive: true });
  await writeFile(
    path.join(firstDirectory, "普通文件夹", "目录说明.txt"),
    "普通目录素材\n",
  );

  const controlRoot = path.join(root, "controlled-source-variant");
  const responseRoot = path.join(controlRoot, "responses");
  await mkdir(responseRoot, { recursive: true });
  await cp(sourceResponses, responseRoot, { recursive: true });
  const controlledManifestPath = path.join(controlRoot, "manifest.json");
  await cp(sourceManifest, controlledManifestPath);

  const secondProductPath = path.join(responseRoot, "RJ01049458.json");
  let secondProductResponse = JSON.parse(
    await readFile(secondProductPath, "utf8"),
  ) as Record<string, Record<string, unknown>>;
  const secondProduct = secondProductResponse.RJ01049458;
  if (secondProduct === undefined) throw new Error("DLsite 受控作品响应缺失");
  // 测试变体让第二作带上正式稳定系列来源键；默认 corpus 保持原样。
  secondProduct.title_id = "SRI0000036577";
  secondProduct.title_name = "裏世界少女";
  secondProduct.series_id = "SRI0000036577";
  secondProduct.series_name = "裏世界少女";
  await writeFile(secondProductPath, JSON.stringify(secondProductResponse));
  const controlled = await loadControlledSourceIo({
    manifestPath: controlledManifestPath,
  });
  const secondProductUrl =
    "https://www.dlsite.com/maniax/product/info/ajax?product_id=RJ01049458";
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: async (url, init) => {
      if (url === secondProductUrl) {
        const bytes = new TextEncoder().encode(
          JSON.stringify(secondProductResponse),
        );
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => "application/json" },
          arrayBuffer: async () =>
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
        };
      }
      return await controlled.request(url, init);
    },
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  await prepareProductionCatalogue({ productDataDirectory });
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
  running.push({ server, abort: () => bootstrap.abort() });
  await server.ready();
  bootstrap.publish();
  const client = createPublicApiClient({ baseUrl: new URL(server.url!) });

  const definitions = await client.listRelationshipTypeDefinitions();
  expect(definitions.map(({ id }) => id)).toEqual(
    expect.arrayContaining(["dlsite.contribution", "dlsite.series-membership"]),
  );
  const library = await client.saveAssetLibrary({
    displayName: "关系修复普通目录",
    directories: [firstDirectory, secondDirectory],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");

  const firstAsset = await assetForWork(client, library.id, "RJ01029383");
  const secondAsset = await assetForWork(client, library.id, "RJ01049458");
  const circleMatches = await client.findRelatedEntities("G線上の牡丹雪");
  expect(circleMatches).toHaveLength(1);
  const circle = await client.inspectRelatedEntity(circleMatches[0]!.id);
  expect(circle.entity).toMatchObject({
    sourceIdentity: "dlsite",
    identityNamespace: "dlsite.circle",
    sourceKey: "RG51784",
  });
  expect(circle.accepted.map(({ id }) => id).toSorted()).toEqual(
    [firstAsset.id, secondAsset.id].toSorted(),
  );

  const seriesMatches = await client.findRelatedEntities("裏世界少女");
  expect(seriesMatches).toHaveLength(1);
  const seriesId = seriesMatches[0]!.id;
  const series = await client.inspectRelatedEntity(seriesId);
  expect(series.entity).toMatchObject({
    identityNamespace: "dlsite.series",
    sourceKey: "SRI0000036577",
  });
  expect(series.accepted.map(({ id }) => id).toSorted()).toEqual(
    [firstAsset.id, secondAsset.id].toSorted(),
  );
  const seriesMembershipForFirstWork = series.relationships.find(
    ({ type, participants }) =>
      type === "asset.membership" &&
      participants.some(
        ({ entityId, role }) => entityId === firstAsset.id && role === "asset",
      ),
  );
  expect(seriesMembershipForFirstWork).toBeDefined();
  expect(seriesMembershipForFirstWork!.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceIdentity: "dlsite",
        nativeAddress: expect.stringContaining("RJ01029383"),
      }),
    ]),
  );
  const firstWorkRelationships = await client.inspectRelatedEntity(
    firstAsset.id,
  );
  expect(firstWorkRelationships.relationships).toContainEqual(
    expect.objectContaining({
      id: seriesMembershipForFirstWork!.id,
      sources: seriesMembershipForFirstWork!.sources,
    }),
  );

  const occurrenceLocal = [
    ["涼花みなせ", "dlsite.credit.voice.voice.occurrence-local"],
    ["牡丹一", "dlsite.credit.scenario.scenario.occurrence-local"],
    ["かふか", "dlsite.credit.illustration.illustration.occurrence-local"],
  ] as const;
  for (const [label, namespace] of occurrenceLocal) {
    const matches = await client.findRelatedEntities(label);
    expect(matches).toHaveLength(2);
    const details = await Promise.all(
      matches.map(({ id }) => client.inspectRelatedEntity(id)),
    );
    expect(details.map(({ entity }) => entity.identityNamespace)).toEqual([
      namespace,
      namespace,
    ]);
    expect(new Set(details.map(({ entity }) => entity.id)).size).toBe(2);
    const sourceKeys = details.map(({ entity }) => entity.sourceKey ?? "");
    expect(new Set(sourceKeys).size).toBe(2);
    expect(
      sourceKeys.some((sourceKey) => sourceKey.includes("RJ01029383")),
    ).toBe(true);
    expect(
      sourceKeys.some((sourceKey) => sourceKey.includes("RJ01049458")),
    ).toBe(true);
  }

  const voiceMatches = await client.findRelatedEntities("涼花みなせ");
  const voiceDetails = await Promise.all(
    voiceMatches.map(({ id }) => client.inspectRelatedEntity(id)),
  );
  const voiceFirst = voiceDetails.find(({ accepted }) =>
    accepted.some(({ id }) => id === firstAsset.id),
  );
  const voiceSecond = voiceDetails.find(({ accepted }) =>
    accepted.some(({ id }) => id === secondAsset.id),
  );
  expect(voiceFirst).toBeDefined();
  expect(voiceSecond).toBeDefined();
  expect(voiceFirst!.entity.id).not.toBe(voiceSecond!.entity.id);
  expect(voiceFirst!.accepted.map(({ id }) => id)).toEqual([firstAsset.id]);
  expect(voiceSecond!.accepted.map(({ id }) => id)).toEqual([secondAsset.id]);
  await expect(
    client.previewEntityIdentityMerge({
      retainedEntityId: voiceFirst!.entity.id,
      mergedEntityId: voiceFirst!.entity.id,
    }),
  ).rejects.toMatchObject({ kind: "invalid-request", status: 400 });
  await expect(
    client.inspectEntityMentionResolution("missing-entity-mention"),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });

  const sourceMention = secondAsset.relationships
    .flatMap(({ participants }) => participants)
    .find(
      (participant) =>
        participant.entityId === voiceSecond!.entity.id &&
        participant.role === "voice",
    )?.mentionIds?.[0];
  expect(sourceMention).toBeDefined();
  const mentionBefore = await client.inspectEntityMentionResolution(
    sourceMention!,
  );
  expect(mentionBefore).toMatchObject({
    basis: "source",
    entityId: voiceSecond!.entity.id,
    label: "涼花みなせ",
  });
  await expect(
    client.resolveEntityMentionManually({
      mentionId: mentionBefore.mentionId,
      entityId: voiceFirst!.entity.id,
      actorId: "user:关系修复",
      baseline: mentionBefore.baseline,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.inspectEntityMentionResolution(mentionBefore.mentionId),
  ).resolves.toMatchObject({
    basis: "manual",
    entityId: voiceFirst!.entity.id,
  });
  await expect(
    client.inspectRelatedEntity(voiceFirst!.entity.id),
  ).resolves.toMatchObject({
    accepted: expect.arrayContaining([
      expect.objectContaining({ id: firstAsset.id }),
      expect.objectContaining({ id: secondAsset.id }),
    ]),
  });
  const localAuthor = await client.createLocalRelatedEntity({
    commitmentId: "ewc11-local-author",
    label: "人工补录署名",
    actorId: "user:关系修复",
  });
  const manualRelationship = await client.previewRelationshipChange({
    changes: [
      {
        kind: "create",
        definitionId: "dlsite.contribution",
        relationship: {
          type: "asset.contribution",
          participants: [
            { entityId: secondAsset.id, role: "asset" },
            { entityId: localAuthor.id, role: "author" },
          ],
        },
      },
    ],
  });
  expect(manualRelationship.relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "asset.contribution",
        participants: expect.arrayContaining([
          expect.objectContaining({ entityId: localAuthor.id, role: "author" }),
        ]),
      }),
    ]),
  );
  await expect(
    client.applyRelationshipChange({
      actorId: "user:关系修复",
      preview: manualRelationship,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.inspectRelatedEntity(localAuthor.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ type: "asset.contribution" })],
    accepted: [expect.objectContaining({ id: secondAsset.id })],
  });
  const localContribution = manualRelationship.relationships.find(
    ({ type, participants }) =>
      type === "asset.contribution" &&
      participants.some(({ entityId }) => entityId === localAuthor.id),
  );
  expect(localContribution).toBeDefined();
  const excludedContribution = await client.previewRelationshipChange({
    changes: [{ kind: "exclude", targetRelationshipId: localContribution!.id }],
  });
  await expect(
    client.applyRelationshipChange({
      actorId: "user:关系修复",
      preview: excludedContribution,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.inspectRelatedEntity(localAuthor.id),
  ).resolves.toMatchObject({ relationships: [] });
  const selectedContribution = await client.previewRelationshipChange({
    changes: [{ kind: "select", targetRelationshipId: localContribution!.id }],
  });
  await expect(
    client.applyRelationshipChange({
      actorId: "user:关系修复",
      preview: selectedContribution,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.inspectRelatedEntity(localAuthor.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ id: localContribution!.id })],
  });

  const replacementAuthor = await client.createLocalRelatedEntity({
    commitmentId: "ewc11-local-author-replacement",
    label: "人工更正署名",
    actorId: "user:关系修复",
  });
  const replacedContribution = await client.previewRelationshipChange({
    changes: [
      {
        kind: "replace",
        targetRelationshipId: localContribution!.id,
        definitionId: "dlsite.contribution",
        relationship: {
          type: "asset.contribution",
          participants: [
            { entityId: secondAsset.id, role: "asset" },
            { entityId: replacementAuthor.id, role: "author" },
          ],
        },
      },
    ],
  });
  await expect(
    client.applyRelationshipChange({
      actorId: "user:关系修复",
      preview: replacedContribution,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.inspectRelatedEntity(localAuthor.id),
  ).resolves.toMatchObject({ relationships: [] });
  const replacementFact = replacedContribution.relationships.find(
    ({ type, participants }) =>
      type === "asset.contribution" &&
      participants.some(({ entityId }) => entityId === replacementAuthor.id),
  );
  expect(replacementFact).toBeDefined();
  await expect(
    client.inspectRelatedEntity(replacementAuthor.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ id: replacementFact!.id })],
  });

  const restoredContribution = await client.previewRelationshipChange({
    changes: [
      {
        kind: "replace",
        targetRelationshipId: replacementFact!.id,
        definitionId: "dlsite.contribution",
        relationship: {
          type: "asset.contribution",
          participants: [
            { entityId: secondAsset.id, role: "asset" },
            { entityId: localAuthor.id, role: "author" },
          ],
        },
      },
    ],
  });
  await expect(
    client.applyRelationshipChange({
      actorId: "user:关系修复",
      preview: restoredContribution,
    }),
  ).resolves.toEqual({ status: "applied" });
  const restoredFact = restoredContribution.relationships.find(
    ({ type, participants }) =>
      type === "asset.contribution" &&
      participants.some(({ entityId }) => entityId === localAuthor.id),
  );
  expect(restoredFact).toBeDefined();
  const clearedContribution = await client.previewRelationshipChange({
    changes: [{ kind: "clear", targetRelationshipId: restoredFact!.id }],
  });
  await expect(
    client.applyRelationshipChange({
      actorId: "user:关系修复",
      preview: clearedContribution,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.inspectRelatedEntity(localAuthor.id),
  ).resolves.toMatchObject({ relationships: [] });
  const reselectedContribution = await client.previewRelationshipChange({
    changes: [{ kind: "select", targetRelationshipId: restoredFact!.id }],
  });
  await expect(
    client.applyRelationshipChange({
      actorId: "user:关系修复",
      preview: reselectedContribution,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.inspectRelatedEntity(localAuthor.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ id: restoredFact!.id })],
  });
  const staleRelationshipPreview = await client.previewRelationshipChange({
    changes: [{ kind: "exclude", targetRelationshipId: restoredFact!.id }],
  });

  const mergePreview = await client.previewEntityIdentityMerge({
    retainedEntityId: voiceFirst!.entity.id,
    mergedEntityId: voiceSecond!.entity.id,
  });
  const replayConflictTarget = await client.createLocalRelatedEntity({
    commitmentId: "ewc11-identity-replay-conflict-target",
    label: "提交键冲突目标",
    actorId: "user:关系修复",
  });
  const conflictingMergePreview = await client.previewEntityIdentityMerge({
    retainedEntityId: voiceFirst!.entity.id,
    mergedEntityId: replayConflictTarget.id,
  });
  await expect(
    client.applyEntityIdentityMerge({
      commitmentId: "ewc11-voice-merge",
      actorId: "user:关系修复",
      preview: mergePreview,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.applyEntityIdentityMerge({
      commitmentId: "ewc11-voice-merge",
      actorId: "user:关系修复",
      preview: mergePreview,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.applyEntityIdentityMerge({
      commitmentId: "ewc11-voice-merge",
      actorId: "user:关系修复",
      preview: conflictingMergePreview,
    }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });
  const postMergeAuthor = await client.createLocalRelatedEntity({
    commitmentId: "ewc11-post-merge-author",
    label: "合并后新增署名",
    actorId: "user:关系修复",
  });
  const postMergeRelationshipPreview = await client.previewRelationshipChange({
    changes: [
      {
        kind: "create",
        definitionId: "dlsite.contribution",
        relationship: {
          type: "asset.contribution",
          participants: [
            { entityId: secondAsset.id, role: "asset" },
            { entityId: voiceFirst!.entity.id, role: "voice" },
            { entityId: postMergeAuthor.id, role: "author" },
          ],
        },
      },
    ],
  });
  await expect(
    client.applyRelationshipChange({
      actorId: "user:关系修复",
      preview: postMergeRelationshipPreview,
    }),
  ).resolves.toEqual({ status: "applied" });
  const postMergeRelationship = postMergeRelationshipPreview.relationships.find(
    ({ type, participants }) =>
      type === "asset.contribution" &&
      participants.some(({ entityId }) => entityId === postMergeAuthor.id),
  );
  expect(postMergeRelationship).toBeDefined();
  await expect(
    client.inspectRelatedEntity(postMergeAuthor.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ id: postMergeRelationship!.id })],
    accepted: [expect.objectContaining({ id: secondAsset.id })],
  });
  await expect(
    client.inspectRelatedEntity(voiceFirst!.entity.id),
  ).resolves.toMatchObject({
    accepted: expect.arrayContaining([
      expect.objectContaining({ id: firstAsset.id }),
      expect.objectContaining({ id: secondAsset.id }),
    ]),
  });
  await expect(
    client.applyRelationshipChange({
      actorId: "user:关系修复",
      preview: staleRelationshipPreview,
    }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });
  await expect(
    client.undoEntityIdentityMerge({
      commitmentId: "ewc11-missing-merge-retraction",
      actorId: "user:关系修复",
      preview: mergePreview,
    }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });

  const revisedProduct = JSON.parse(JSON.stringify(secondProductResponse)) as {
    readonly RJ01049458: Record<string, unknown>;
  };
  revisedProduct.RJ01049458.title_name = "裏世界少女・受控更新";
  revisedProduct.RJ01049458.series_name = "裏世界少女・受控更新";
  revisedProduct.RJ01049458.work_name = "受控来源更新后的作品名";
  secondProductResponse = revisedProduct;
  const refresh = await client.startMetadataRefresh({
    subjectId: secondAsset.id,
    reviewPolicy: "automatic",
  });
  await expect
    .poll(async () => (await client.inspectExecution(refresh.id)).status, {
      timeout: 120_000,
      interval: 200,
    })
    .toBe("completed");
  await expect(
    client.applyEntityIdentityMerge({
      commitmentId: "ewc11-stale-voice-merge",
      actorId: "user:关系修复",
      preview: mergePreview,
    }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });

  const refreshedAsset = await assetForWork(client, library.id, "RJ01049458");
  const refreshedTitle = refreshedAsset.descriptions
    .flatMap(({ metadata }) => metadata)
    .find(({ property }) => property === "asset.title")?.result;
  expect(refreshedTitle).toMatchObject({
    status: "resolved",
    values: [expect.objectContaining({ value: "受控来源更新后的作品名" })],
  });
  const refreshedSeries = await client.inspectRelatedEntity(seriesId);
  expect(refreshedSeries.entity).toMatchObject({
    identityNamespace: "dlsite.series",
    sourceKey: "SRI0000036577",
  });
  expect(refreshedSeries.accepted.map(({ id }) => id).toSorted()).toEqual(
    [firstAsset.id, secondAsset.id].toSorted(),
  );
  expect(
    refreshedSeries.relationships.find(
      ({ type, participants }) =>
        type === "asset.membership" &&
        participants.some(
          ({ entityId, role }) =>
            entityId === secondAsset.id && role === "asset",
        ),
    )?.sources,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceIdentity: "dlsite",
        nativeAddress: expect.stringContaining("RJ01049458"),
      }),
    ]),
  );
  await expect(
    client.inspectEntityMentionResolution(mentionBefore.mentionId),
  ).resolves.toMatchObject({
    basis: "manual",
    entityId: voiceFirst!.entity.id,
  });
  await expect(
    client.inspectRelatedEntity(voiceFirst!.entity.id),
  ).resolves.toMatchObject({
    accepted: expect.arrayContaining([
      expect.objectContaining({ id: firstAsset.id }),
      expect.objectContaining({ id: secondAsset.id }),
    ]),
  });

  const locatedMerge = await client.previewEntityIdentityMerge({
    retainedEntityId: voiceFirst!.entity.id,
    mergedEntityId: voiceSecond!.entity.id,
  });
  expect(locatedMerge.mergeId).toBeDefined();
  await expect(
    client.undoEntityIdentityMerge({
      commitmentId: "ewc11-voice-merge-retraction",
      actorId: "user:关系修复",
      preview: locatedMerge,
    }),
  ).resolves.toEqual({ status: "applied" });
  const retainedVoice = await client.inspectRelatedEntity(
    voiceFirst!.entity.id,
  );
  const unmergedVoice = await client.inspectRelatedEntity(
    voiceSecond!.entity.id,
  );
  expect(retainedVoice.entity.id).toBe(voiceFirst!.entity.id);
  expect(unmergedVoice.entity.id).toBe(voiceSecond!.entity.id);
  expect(retainedVoice.entity.id).not.toBe(unmergedVoice.entity.id);
  expect(retainedVoice.relationships).toContainEqual(
    expect.objectContaining({
      id: postMergeRelationship!.id,
      participants: expect.arrayContaining([
        expect.objectContaining({ entityId: secondAsset.id, role: "asset" }),
        expect.objectContaining({
          entityId: voiceFirst!.entity.id,
          role: "voice",
        }),
        expect.objectContaining({
          entityId: postMergeAuthor.id,
          role: "author",
        }),
      ]),
    }),
  );
  expect(unmergedVoice.relationships).not.toContainEqual(
    expect.objectContaining({ id: postMergeRelationship!.id }),
  );
  await expect(
    client.inspectRelatedEntity(postMergeAuthor.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ id: postMergeRelationship!.id })],
    accepted: [expect.objectContaining({ id: secondAsset.id })],
  });
  await expect(
    client.inspectRelatedEntity(voiceFirst!.entity.id),
  ).resolves.toMatchObject({
    accepted: expect.arrayContaining([
      expect.objectContaining({ id: firstAsset.id }),
      expect.objectContaining({ id: secondAsset.id }),
    ]),
  });
  const manualMention = await client.inspectEntityMentionResolution(
    mentionBefore.mentionId,
  );
  await expect(
    client.retractEntityMentionResolution({
      mentionId: manualMention.mentionId,
      actorId: "user:关系修复",
      baseline: manualMention.baseline,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.inspectEntityMentionResolution(mentionBefore.mentionId),
  ).resolves.toMatchObject({
    basis: "source",
    entityId: voiceSecond!.entity.id,
  });
  await expect(
    client.inspectRelatedEntity(voiceFirst!.entity.id),
  ).resolves.toMatchObject({
    accepted: expect.arrayContaining([
      expect.objectContaining({ id: firstAsset.id }),
      expect.objectContaining({ id: secondAsset.id }),
    ]),
  });
  await expect(
    client.inspectRelatedEntity(voiceSecond!.entity.id),
  ).resolves.toMatchObject({
    accepted: [expect.objectContaining({ id: secondAsset.id })],
  });
  await expect(
    client.inspectRelatedEntity(localAuthor.id),
  ).resolves.toMatchObject({
    relationships: [expect.objectContaining({ type: "asset.contribution" })],
    accepted: [expect.objectContaining({ id: secondAsset.id })],
  });
  const finalAsset = await assetForWork(client, library.id, "RJ01049458");
  expect(
    finalAsset.descriptions
      .flatMap(({ metadata }) => metadata)
      .find(({ property }) => property === "asset.title")?.result,
  ).toMatchObject({
    status: "resolved",
    values: [expect.objectContaining({ value: "受控来源更新后的作品名" })],
  });

  await client.removeAssetLibrary({
    id: library.id,
    expectedVersion: library.configVersion,
  });
  const retainedRelationship = await client.inspectRelatedEntity(
    localAuthor.id,
  );
  expect(retainedRelationship.accepted).toEqual([]);
  expect(retainedRelationship.relationships).toContainEqual(
    expect.objectContaining({ type: "asset.contribution" }),
  );
});

it("将未知关系应用故障映射为稳定 503 文案", async () => {
  const api = createPublicHttpApi({
    workflow: {
      relationshipTypeDefinitions() {
        throw new Error("database token must not be exposed");
      },
    },
  } as unknown as ProductApplication);
  const response = await api.request("/relationships/types");
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    error: {
      code: "unavailable",
      message: "关系资料暂时不可用，请稍后重试",
    },
  });
});

async function assetForWork(
  client: ReturnType<typeof createPublicApiClient>,
  assetLibraryId: string,
  workId: string,
) {
  const page = await client.listAssets({ assetLibraryId, limit: 100 });
  const matches = page.items.filter(({ locations }) =>
    locations.some(({ address }) => address.includes(workId)),
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
