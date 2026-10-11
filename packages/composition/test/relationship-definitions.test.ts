import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, expect, it, vi } from "vitest";

import { runProduct } from "../src/index.ts";
import {
  disposePreparedCatalogueTemplate,
  prepareCatalogueAt,
} from "./prepared-catalogue.ts";

afterAll(disposePreparedCatalogueTemplate);

it("无来源连接的本地作品按已部署的系列定义标注，重开后从两端读取同一人工关系", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-relationship-types-"),
  );
  const data = path.join(root, "data");
  const media = path.join(root, "media");
  await prepareCatalogueAt(data);
  await mkdir(media);
  await writeFile(path.join(media, "book.txt"), "本地作品正文");
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("离线"));
  const open = () =>
    runProduct(
      { productDataDirectory: data, environment: {} },
      { start: (product) => product.workflow },
    );
  let product = open();
  try {
    const workflow = product.result;
    const definitions = workflow.relationshipTypeDefinitions();
    expect(definitions).toContainEqual(
      expect.objectContaining({
        id: "epub.series-membership",
        type: "asset.membership",
        label: "属于系列",
        roles: expect.arrayContaining([
          expect.objectContaining({ role: "asset", label: "作品", minimum: 1 }),
          expect.objectContaining({
            role: "series",
            label: "系列",
            minimum: 1,
          }),
        ]),
      }),
    );
    // 合法前置：走公开资产库入口登记并授权该目录，注册本身从不自动等于授权。
    const libraries = workflow.assetLibraries;
    const library = await libraries.save({
      displayName: "本地作品库",
      directories: [media],
      recognitionProfileIds: libraries.recognitionProfiles.map(
        (profile) => profile.id,
      ),
      sourceIdentities: libraries.sources.map((source) => source.id),
    });
    const scan = await workflow.scanObservedScope({
      registrationId: library.rootIds[0]!,
      relativeScope: ".",
      acceptTrusted: false,
    });
    const content = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["book.txt"],
      name: "无来源的书",
      classification: "book",
    });
    const accepted = await workflow.confirmLocalContent({
      executionId: content.executionId,
    });
    const bookId = accepted.content.entity.id;
    expect(await workflow.inspectCurrentCatalogueEntity(bookId)).toMatchObject({
      entity: { id: bookId, label: "无来源的书" },
      relationships: [],
    });
    const series = await workflow.createLocalRelatedEntity({
      commitmentId: "local-series",
      label: "我的系列",
      actorId: "user:reader",
    });
    const preview = await workflow.previewRelationshipChange({
      changes: [
        {
          kind: "create",
          definitionId: "epub.series-membership",
          relationship: {
            type: "asset.membership",
            participants: [
              { entityId: bookId, role: "asset" },
              { entityId: series.id, role: "series" },
            ],
            qualifiers: [{ key: "position", value: "2" }],
          },
        },
      ],
    });
    expect(
      await workflow.applyRelationshipChange({
        actorId: "user:reader",
        preview,
      }),
    ).toBe("applied");
    const relation = (await workflow.inspectCurrentCatalogueEntity(series.id))!
      .relationships[0];
    expect(relation).toMatchObject({
      type: "asset.membership",
      participants: expect.arrayContaining([
        { entityId: bookId, role: "asset" },
        { entityId: series.id, role: "series" },
      ]),
      qualifiers: [{ key: "position", value: "2" }],
      sources: [],
    });
    expect(
      (await workflow.inspectCurrentCatalogueEntity(bookId))!.relationships,
    ).toContainEqual(relation);
    const circle = await workflow.createLocalRelatedEntity({
      commitmentId: "circle",
      label: "发行社团",
      actorId: "user:reader",
    });
    const voice = await workflow.createLocalRelatedEntity({
      commitmentId: "voice",
      label: "朗读者",
      actorId: "user:reader",
    });
    const contribution = await workflow.previewRelationshipChange({
      changes: [
        {
          kind: "create",
          definitionId: "dlsite.contribution",
          relationship: {
            type: "asset.contribution",
            participants: [
              { entityId: bookId, role: "asset" },
              { entityId: circle.id, role: "circle" },
              { entityId: voice.id, role: "voice" },
            ],
          },
        },
      ],
    });
    expect(
      await workflow.applyRelationshipChange({
        actorId: "user:reader",
        preview: contribution,
      }),
    ).toBe("applied");
    const threeWay = (await workflow.inspectCurrentCatalogueEntity(circle.id))!
      .relationships[0];
    expect(threeWay).toMatchObject({
      type: "asset.contribution",
      sources: [],
      participants: [
        { entityId: bookId, role: "asset" },
        { entityId: circle.id, role: "circle" },
        { entityId: voice.id, role: "voice" },
      ],
    });
    await product.close();
    product = open();
    expect(
      (await product.result.inspectCurrentCatalogueEntity(series.id))!
        .relationships,
    ).toContainEqual(relation);
    expect(
      (await product.result.inspectCurrentCatalogueEntity(bookId))!
        .relationships,
    ).toContainEqual(relation);
    for (const participant of [bookId, circle.id, voice.id])
      expect(
        (await product.result.inspectCurrentCatalogueEntity(participant))!
          .relationships,
      ).toContainEqual(threeWay);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await product.close();
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("人工新建只接受已声明的类型和角色，提交者不能删去必需角色要求", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-relationship-validation-"),
  );
  await prepareCatalogueAt(root);
  const product = runProduct(
    { productDataDirectory: root, environment: {} },
    { start: (application) => application.workflow },
  );
  try {
    const first = await product.result.createLocalRelatedEntity({
      commitmentId: "first",
      label: "甲",
      actorId: "user:reader",
    });
    const second = await product.result.createLocalRelatedEntity({
      commitmentId: "second",
      label: "乙",
      actorId: "user:reader",
    });
    const relationship = {
      type: "asset.membership",
      participants: [
        { entityId: first.id, role: "series" },
        { entityId: second.id, role: "series" },
      ],
    };
    await expect(
      product.result.previewRelationshipChange({
        changes: [
          {
            kind: "create",
            definitionId: "unknown.relationship",
            relationship,
          },
        ],
      }),
    ).rejects.toThrow("关系类型尚未声明");
    const weakened = {
      kind: "create" as const,
      definitionId: "epub.series-membership",
      relationship,
      requiredRoles: [],
    };
    await expect(
      product.result.previewRelationshipChange({ changes: [weakened] }),
    ).rejects.toThrow("关系缺少必需角色");
    expect(
      (await product.result.inspectCurrentCatalogueEntity(first.id))!
        .relationships,
    ).toEqual([]);
  } finally {
    await product.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("预演拒绝不存在的参与对象，采用仍校验限定项而不信任提交者改写的预演", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-relationship-constraints-"),
  );
  await prepareCatalogueAt(root);
  const product = runProduct(
    { productDataDirectory: root, environment: {} },
    { start: (application) => application.workflow },
  );
  try {
    const first = await product.result.createLocalRelatedEntity({
      commitmentId: "first",
      label: "前作",
      actorId: "user:reader",
    });
    const second = await product.result.createLocalRelatedEntity({
      commitmentId: "second",
      label: "续作",
      actorId: "user:reader",
    });
    const change = {
      kind: "create" as const,
      definitionId: "bangumi.subject-sequel",
      relationship: {
        type: "bangumi.subject.related",
        participants: [
          { entityId: first.id, role: "bangumi.subject.predecessor" },
          { entityId: second.id, role: "bangumi.subject.sequel" },
        ],
      },
    };
    const preview = await product.result.previewRelationshipChange({
      changes: [change],
    });
    await expect(
      product.result.previewRelationshipChange({
        changes: [
          {
            ...change,
            relationship: {
              ...change.relationship,
              participants: [
                change.relationship.participants[0],
                { entityId: "missing", role: "bangumi.subject.sequel" },
              ],
            },
          },
        ],
      }),
    ).rejects.toThrow("不存在的实体");
    await expect(
      product.result.applyRelationshipChange({
        actorId: "user:reader",
        preview: {
          ...preview,
          changes: [
            {
              ...change,
              relationship: {
                ...change.relationship,
                qualifiers: [{ key: "invented", value: "1" }],
              },
            },
          ],
        },
      }),
    ).rejects.toThrow("未声明的限定项");
    expect(
      (await product.result.inspectCurrentCatalogueEntity(first.id))!
        .relationships,
    ).toEqual([]);
    expect(
      await product.result.applyRelationshipChange({
        actorId: "user:reader",
        preview,
      }),
    ).toBe("applied");
    expect(
      (await product.result.inspectCurrentCatalogueEntity(second.id))!
        .relationships,
    ).toMatchObject([
      { type: "bangumi.subject.related", qualifiers: [], sources: [] },
    ]);
  } finally {
    await product.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
