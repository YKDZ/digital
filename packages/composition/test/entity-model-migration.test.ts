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

/** 基线 911a0c3 只经正式 prepare 与公开产品操作得到的旧合同数据及其公开读取结果。 */
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

async function temporaryProductRoot(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

const openProduct = (productDataDirectory: string) =>
  runProduct(
    { productDataDirectory, environment: {} },
    { start: (application) => application },
  );

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
        kind: manifest.personEntity.kind,
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
        kind: "person",
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
      entity: {
        id: manifest.personEntity.id,
        kind: manifest.personEntity.kind,
      },
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
    // 可证伪项：基线的新装配会把该 id 投影成生效的 person 断言，取消绑定后只剩普通实体。
    expect(
      await workflow.previewEntityKindDecision({
        entityId: "person:local-user",
      }),
    ).toMatchObject({ effective: { status: "ordinary" } });

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
    // 本票保留种类调整入口：人工新建的人物实体仍可按种类被读取。
    const manualPerson = await workflow.createLocalRelatedEntity({
      commitmentId: "manual-person",
      label: "人工人物",
      kind: "person",
      actorId: "local-user",
    });
    expect(
      await workflow.previewEntityKindDecision({
        entityId: manualPerson.id,
        selectedKind: "person",
      }),
    ).toMatchObject({ entityId: manualPerson.id });
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
  } finally {
    await product.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
