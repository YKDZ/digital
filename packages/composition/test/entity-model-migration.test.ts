import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteCatalogue } from "@digital/sqlite";
import { expect, it } from "vitest";

import { runProduct } from "../src/index.ts";
import { prepareWithFormalMigration } from "./prepared-catalogue.ts";

/** 基线 09f0ec9 只经正式 prepare 与公开产品操作得到的旧合同数据及其公开读取结果。 */
type EntityE01Manifest = {
  readonly contentEntityId: string;
  readonly personEntity: {
    readonly id: string;
    readonly label: string;
    readonly kind: { readonly status: string; readonly kind?: string };
  };
  readonly seriesEntity: { readonly id: string; readonly label: string };
  readonly seriesRelationships: readonly unknown[];
  readonly readBack: readonly {
    readonly artifactRevisionId: string;
    readonly positionMilliseconds: number;
    readonly completed: boolean;
  }[];
};

/** 同一固定点在 E02 硬迁移前的公开读取结果，含被移除的专门种类投影。 */
type AudioEntitySnapshot = {
  readonly entity: { readonly id: string; readonly label: string };
  readonly metadata: readonly unknown[];
  readonly relationships: readonly {
    readonly participants: readonly {
      readonly entityId: string;
      readonly role: string;
    }[];
  }[];
};

type EntityE02Manifest = {
  readonly startCommit: string;
  readonly audioEntity: AudioEntitySnapshot;
  readonly afterAudioRefresh: AudioEntitySnapshot;
  readonly unidentifiedAsset: { readonly id: string };
  readonly unidentifiedAssetMetadata: readonly unknown[];
  readonly enrichment: {
    readonly executionId: string;
    readonly sourceEnrichments: readonly unknown[];
  };
  readonly enrichmentSourceRecords: readonly unknown[];
  readonly localEntities: {
    readonly person: { readonly id: string; readonly label: string };
    readonly persona: { readonly id: string; readonly label: string };
    readonly ordinary: { readonly id: string; readonly label: string };
    readonly sameName: { readonly id: string; readonly label: string };
  };
  readonly personaRelationships: readonly unknown[];
  readonly pendingAssociation: {
    readonly executionId: string;
    readonly state: string;
    readonly availableActions: readonly string[];
  };
  readonly readBack: readonly {
    readonly artifactRevisionId: string;
    readonly positionMilliseconds: number;
    readonly completed: boolean;
  }[];
};

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../db-migrations/test/fixtures/entity-model",
);

async function entityE01Manifest(): Promise<EntityE01Manifest> {
  return JSON.parse(
    await readFile(
      path.join(fixtureRoot, "entity-e01-911a0c3.manifest.json"),
      "utf8",
    ),
  ) as EntityE01Manifest;
}

async function entityE02Manifest(): Promise<EntityE02Manifest> {
  return JSON.parse(
    await readFile(
      path.join(fixtureRoot, "entity-e02-after-e01.manifest.json"),
      "utf8",
    ),
  ) as EntityE02Manifest;
}

async function temporaryProductRoot(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

const openProduct = (productDataDirectory: string) =>
  runProduct(
    { productDataDirectory, environment: {} },
    { start: (application) => application },
  );

const ordinaryKind = { status: "ordinary" } as const;

/** 迁移副本没有网络；只为已通过正式刷新读取的来源提供同一合法样本。 */
function mockSourceFetch(): () => void {
  const originalFetch = globalThis.fetch;
  const dlsiteProduct = {
    RJ01668691: {
      site_id: "maniax",
      work_name: "带台本的音声作品",
      regist_date: "2026-07-17",
      work_image: "//img.dlsite.jp/official.jpg",
      maker_id: "MI000001",
      maker_name: "朗读社团",
      title_id: "SE000001",
      title_name: "所属系列",
      voice: ["声优甲"],
      scenario: ["脚本乙"],
      illustration: ["插画丙"],
      author: ["作者丁"],
    },
  };
  globalThis.fetch = async (input: string | URL | Request) => {
    const address =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (address.includes("/product/info/ajax"))
      return new Response(JSON.stringify(dlsiteProduct), {
        headers: { "content-type": "application/json" },
      });
    if (address.includes("dlsite.com"))
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    if (address.startsWith("https://img.dlsite.jp/"))
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "image/jpeg" },
      });
    throw new Error(`迁移测试不允许访问其他来源：${address}`);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

it("迁移后的旧合同数据经公开操作仍保留人物节点、人工关系与精确修订版交互状态", async () => {
  const root = await temporaryProductRoot("digital-disposable-e01-migrated-");
  const data = path.join(root, "data");
  const manifest = await entityE01Manifest();
  const [stateA, stateB] = manifest.readBack as [
    (typeof manifest.readBack)[0],
    (typeof manifest.readBack)[0],
  ];
  await mkdir(path.join(data, "managed-artifacts"), { recursive: true });
  await copyFile(
    path.join(fixtureRoot, "entity-e01-911a0c3.sqlite"),
    path.join(data, "catalogue.sqlite"),
  );
  await prepareWithFormalMigration(data);
  await expect(
    SqliteCatalogue.inspectProductionReadiness({ productDataDirectory: data }),
  ).resolves.toMatchObject({ state: "ready" });

  let product = openProduct(data);
  try {
    const application = product.result;
    const workflow = application.workflow;
    // 取消绑定后，稳定的 `local-user` 归属无需任何人物身份准备即可读写。
    expect(
      await application.interactions.read([
        stateA.artifactRevisionId,
        stateB.artifactRevisionId,
      ]),
    ).toEqual(manifest.readBack);
    expect(
      await workflow.inspectCurrentCatalogueEntity(manifest.personEntity.id),
    ).toMatchObject({
      entity: {
        id: manifest.personEntity.id,
        label: manifest.personEntity.label,
        kind: ordinaryKind,
      },
    });
    expect(
      (await workflow.inspectCurrentCatalogueEntity(manifest.contentEntityId))
        ?.metadata,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "旧合同书",
          sourceIdentity: "user",
        }),
      ]),
    );
    expect(
      (await workflow.inspectCurrentCatalogueEntity(manifest.seriesEntity.id))
        ?.relationships,
    ).toEqual(manifest.seriesRelationships);
    // 同一人工承诺的重放仍归属稳定的 `local-user`，返回同一人物实体。
    expect(
      await workflow.createLocalRelatedEntity({
        commitmentId: "local-person",
        label: manifest.personEntity.label,
        actorId: "local-user",
      }),
    ).toMatchObject({ id: manifest.personEntity.id });

    const updatedA = {
      artifactRevisionId: stateA.artifactRevisionId,
      positionMilliseconds: 123_450,
      completed: true,
    };
    await application.interactions.save(updatedA);
    // 读写只按精确修订版定位：更新 A 绝不串写到同一内容的修订版 B。
    expect(
      await application.interactions.read([
        stateA.artifactRevisionId,
        stateB.artifactRevisionId,
      ]),
    ).toEqual([updatedA, stateB]);
    await product.close();

    product = openProduct(data);
    expect(
      await product.result.interactions.read([
        stateA.artifactRevisionId,
        stateB.artifactRevisionId,
      ]),
    ).toEqual([updatedA, stateB]);
    expect(
      await product.result.workflow.inspectCurrentCatalogueEntity(
        manifest.personEntity.id,
      ),
    ).toMatchObject({
      entity: { id: manifest.personEntity.id, kind: ordinaryKind },
    });
  } finally {
    await product.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("新装配的产品数据不引导人物节点，交互状态仍按稳定用户归属", async () => {
  const root = await temporaryProductRoot("digital-disposable-e01-fresh-");
  const data = path.join(root, "data");
  const media = path.join(root, "media");
  await mkdir(data, { recursive: true });
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "book.txt"), "新装配本地材料");
  // 从空目录运行完整冻结历史，这正是唯一不再创建引导人物节点的路径。
  await prepareWithFormalMigration(data);

  let product = openProduct(data);
  try {
    const application = product.result;
    const workflow = application.workflow;
    expect(
      await SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).toMatchObject({ state: "ready" });
    expect(
      await workflow.inspectCurrentCatalogueEntity("person:local-user"),
    ).toBeUndefined();

    const registration = await workflow.observedRootRegistrations.create({
      displayName: "新装配材料",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scan = await workflow.scanObservedScope({
      registrationId: registration.id,
      relativeScope: ".",
      acceptTrusted: false,
    });
    const review = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["book.txt"],
      name: "新装配的书",
      classification: "book",
    });
    const accepted = await workflow.confirmLocalContent({
      executionId: review.executionId,
    });
    const [location] = accepted.content.locations as [{ id: string }];
    const selectionId = await application.observedFileSelectionForLocation(
      location.id,
    );
    const confirmed = await application.confirmObservedFileRevision({
      observedFileSelectionId: selectionId!,
    });
    await application.interactions.save({
      artifactRevisionId: confirmed.artifactRevisionId,
      positionMilliseconds: 45_000,
      completed: false,
    });
    expect(
      await application.interactions.read([confirmed.artifactRevisionId]),
    ).toEqual([
      {
        artifactRevisionId: confirmed.artifactRevisionId,
        positionMilliseconds: 45_000,
        completed: false,
      },
    ]);
    const manualEntity = await workflow.createLocalRelatedEntity({
      commitmentId: "manual-entity",
      label: "人工新建",
      actorId: "local-user",
    });
    expect(manualEntity).toMatchObject({
      identity: "local",
      kind: ordinaryKind,
    });
    // 材料准入仍只由已接受内容决定：人工新建的普通实体不能成为数字资产。
    expect(
      await workflow.inspectCurrentCatalogueSubject(manualEntity.id),
    ).toBeUndefined();
    expect(
      await workflow.inspectCurrentCatalogueSubject(accepted.content.entity.id),
    ).toBeDefined();
    await product.close();

    product = openProduct(data);
    expect(
      await product.result.interactions.read([confirmed.artifactRevisionId]),
    ).toEqual([
      {
        artifactRevisionId: confirmed.artifactRevisionId,
        positionMilliseconds: 45_000,
        completed: false,
      },
    ]);
    expect(
      await product.result.workflow.inspectCurrentCatalogueEntity(
        "person:local-user",
      ),
    ).toBeUndefined();
    expect(
      await product.result.workflow.inspectCurrentCatalogueEntity(
        manualEntity.id,
      ),
    ).toMatchObject({ entity: { id: manualEntity.id, kind: ordinaryKind } });
  } finally {
    await product.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("人物与活动身份硬迁移后公开读取保全身份、资料、关系、依据与提交坐标", async () => {
  const root = await temporaryProductRoot("digital-disposable-e02-migrated-");
  const data = path.join(root, "data");
  const manifest = await entityE02Manifest();
  await mkdir(path.join(data, "managed-artifacts"), { recursive: true });
  await copyFile(
    path.join(fixtureRoot, "entity-e02-after-e01.sqlite"),
    path.join(data, "catalogue.sqlite"),
  );
  await prepareWithFormalMigration(data);
  await expect(
    SqliteCatalogue.inspectProductionReadiness({ productDataDirectory: data }),
  ).resolves.toMatchObject({ state: "ready" });

  const restoreFetch = mockSourceFetch();
  let product = openProduct(data);
  try {
    const application = product.result;
    const workflow = application.workflow;
    // 旧专门种类只剩普通投影，标识与名称逐一保全。
    for (const entity of Object.values(manifest.localEntities))
      expect(
        await workflow.inspectCurrentCatalogueEntity(entity.id),
      ).toMatchObject({
        entity: { id: entity.id, label: entity.label, kind: ordinaryKind },
      });
    // 同名实体绝不因迁移自动合并。
    const sameName = await workflow.findRelatedEntities("同名社团");
    expect(sameName.map((found) => found.id).sort()).toEqual(
      [
        manifest.localEntities.ordinary.id,
        manifest.localEntities.sameName.id,
      ].sort(),
    );
    // 无外部身份的已确认数字资产仍按材料准入生效，资料原样保留。
    const unidentified = await workflow.inspectCurrentCatalogueEntity(
      manifest.unidentifiedAsset.id,
    );
    expect(unidentified?.entity).toMatchObject({
      id: manifest.unidentifiedAsset.id,
      kind: { status: "effective", kind: "digital-asset", basis: "assertion" },
    });
    const unidentifiedMetadata = unidentified?.metadata ?? [];
    for (const expected of manifest.unidentifiedAssetMetadata)
      expect(
        unidentifiedMetadata.find(
          ({ property }) => property === expected.property,
        ),
      ).toMatchObject({
        value: expected.value,
        sourceIdentity: expected.sourceIdentity,
        sourceSlot: expected.sourceSlot,
        subjectId: manifest.unidentifiedAsset.id,
        selectedAssertion: expected.selectedAssertion,
        contributingAssertions: expect.arrayContaining(
          expected.contributingAssertions,
        ),
      });
    expect(
      unidentifiedMetadata.find(({ property }) => property === "book.isbn-13"),
    ).toMatchObject({
      value: "9789864738281",
      sourceIdentity: "nbinet",
      subjectId: manifest.unidentifiedAsset.id,
    });
    // DLsite 来源资产的关系与资料完整，其人物／活动身份来源实体改为普通实体。
    const audio = await workflow.inspectCurrentCatalogueEntity(
      manifest.audioEntity.entity.id,
    );
    expect(audio?.relationships).toEqual(
      manifest.afterAudioRefresh.relationships,
    );
    expect(audio?.metadata).toEqual(manifest.afterAudioRefresh.metadata);
    for (const participant of manifest.audioEntity.relationships.flatMap(
      (relationship) => relationship.participants,
    ))
      if (participant.entityId !== manifest.audioEntity.entity.id)
        expect(
          (await workflow.inspectCurrentCatalogueEntity(participant.entityId))
            ?.entity,
        ).toMatchObject({ kind: ordinaryKind });
    const [voice] = await workflow.findRelatedEntities("声优甲");
    expect(voice).toMatchObject({
      label: "声优甲",
      identity: "source",
      kind: ordinaryKind,
    });
    // 来源意义仍可追溯：DLsite 声优指称保留身份命名空间与来源键。
    expect(
      (await workflow.inspectCurrentCatalogueEntity(voice!.id))?.entity,
    ).toMatchObject({
      label: "声优甲",
      sourceIdentity: "dlsite",
      identityNamespace: "dlsite.credit.voice.voice.occurrence-local",
    });
    expect(
      await workflow.inspectCurrentCatalogueSubject(voice!.id),
    ).toBeUndefined();
    // 人工关系与撤销后的归属仍留在原实体上。
    expect(
      (
        await workflow.inspectCurrentCatalogueEntity(
          manifest.localEntities.persona.id,
        )
      )?.relationships,
    ).toEqual(manifest.personaRelationships);
    // 持久来源解释与执行依据（含审计镜像列）经公开执行读取原样返回。
    const enrichment = await workflow.inspect(manifest.enrichment.executionId);
    expect(enrichment?.sourceEnrichments).toEqual(
      manifest.enrichment.sourceEnrichments,
    );
    expect(enrichment?.sourceRecords).toEqual(manifest.enrichmentSourceRecords);
    // 待确认的来源关联决定：用户明确选择、依据与可执行动作在迁移后逐项保全。
    const pendingDecision = await workflow.inspectSourceAssociationDecision(
      manifest.pendingAssociation.executionId,
    );
    expect(pendingDecision).toMatchObject({
      state: manifest.pendingAssociation.state,
      availableActions: manifest.pendingAssociation.availableActions,
      assetId: manifest.audioEntity.entity.id,
      candidates: [
        {
          outcome: "accepted",
          sourceIdentity: "nbinet",
          nativeAddress: expect.stringContaining("9789864738281"),
          explanation: "明确 ISBN 与当前主体的身份证据无冲突",
        },
      ],
      evidenceComparison: {
        manual: [
          expect.objectContaining({
            kind: "directed-source-address",
            explanation: "用户明确指定国家图书馆 ISBN",
          }),
        ],
      },
    });
    const pendingPreviewId = pendingDecision!.preview!.id;
    const pendingReferences = pendingDecision!.candidates.map(
      (candidate) => candidate.reference,
    );
    // 候选句柄由迁移后的字节重新派生，执行与预演两份持久副本读出同一句柄。
    const pendingPreview =
      await workflow.inspectChangeImpactPreview(pendingPreviewId);
    expect(pendingPreview?.evidenceComparison.sourceCandidates).toEqual(
      pendingDecision!.evidenceComparison!.sourceCandidates,
    );
    // 被业务阻塞的预演迁移后仍是同一条阻塞规则，不因种类移除而被静默采用。
    await expect(
      workflow.applyChangeImpactPreview({
        previewId: pendingPreviewId,
        confirmedBy: "local-user",
      }),
    ).resolves.toMatchObject({ status: "stale" });
    // 旧确认的完整影响指纹保留：新合同重算的预览不得改写旧提交坐标。
    const currentMergePreview = await workflow.previewEntityIdentityMerge({
      retainedEntityId: manifest.localEntities.sameName.id,
      mergedEntityId: manifest.localEntities.persona.id,
    });
    expect(currentMergePreview.effectiveKind).toEqual(ordinaryKind);
    for (const preview of [
      currentMergePreview,
      {
        ...currentMergePreview,
        members: [...currentMergePreview.members, "x"],
      },
    ])
      await expect(
        workflow.applyEntityIdentityMerge({
          commitmentId: "commitment-merge",
          actorId: "local-user",
          preview,
        }),
      ).rejects.toThrow("身份合并提交坐标与既有内容冲突");
    // 迁移后的普通实体新建不再选择种类，同一承诺可安全重放。
    const created = await workflow.createLocalRelatedEntity({
      commitmentId: "e02-local",
      label: "迁移后新建",
      actorId: "local-user",
    });
    expect(created).toMatchObject({ kind: ordinaryKind, identity: "local" });
    expect(
      await workflow.createLocalRelatedEntity({
        commitmentId: "e02-local",
        label: "迁移后新建",
        actorId: "local-user",
      }),
    ).toMatchObject({ id: created.id });
    expect(
      await workflow.inspectCurrentCatalogueSubject(created.id),
    ).toBeUndefined();

    const [stateA, stateB] = manifest.readBack as [
      (typeof manifest.readBack)[0],
      (typeof manifest.readBack)[0],
    ];
    expect(
      await application.interactions.read([
        stateA.artifactRevisionId,
        stateB.artifactRevisionId,
      ]),
    ).toEqual(manifest.readBack);
    await product.close();

    product = openProduct(data);
    const reopened = product.result.workflow;
    // 重复读取与重开都不重新引入旧核心种类。
    for (const entity of Object.values(manifest.localEntities))
      expect(
        await reopened.inspectCurrentCatalogueEntity(entity.id),
      ).toMatchObject({ entity: { kind: ordinaryKind } });
    // 重开沿用同一派生句柄，不恢复迁移前的旧句柄也不改变决定状态。
    expect(
      await reopened.inspectSourceAssociationDecision(
        manifest.pendingAssociation.executionId,
      ),
    ).toMatchObject({
      state: manifest.pendingAssociation.state,
      candidates: pendingReferences.map((reference) => ({ reference })),
    });
    // 正式来源刷新沿用同一持久谱系，且不产生任何旧种类依据。
    const refresh = await reopened.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: manifest.audioEntity.entity.id,
            explanations: [{ path: ["来源刷新"] }],
          },
        ],
        filesystemScopes: [],
      },
      initiatedBy: "local-user",
    });
    expect(refresh.execution.outcome).toBe("accepted");
    expect(
      (await reopened.inspectCurrentCatalogueEntity(voice!.id))?.entity,
    ).toMatchObject({ kind: ordinaryKind });
    expect(
      (
        await reopened.inspectCurrentCatalogueEntity(
          manifest.audioEntity.entity.id,
        )
      )?.relationships,
    ).toEqual(manifest.afterAudioRefresh.relationships);
    expect(
      await product.result.interactions.read([
        stateA.artifactRevisionId,
        stateB.artifactRevisionId,
      ]),
    ).toEqual(manifest.readBack);
  } finally {
    restoreFetch();
    await product.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
