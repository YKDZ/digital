import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, afterAll, expect, it, vi } from "vitest";

import { runProduct } from "../src/index.ts";
import {
  disposePreparedCatalogueTemplate,
  prepareCatalogueAt,
} from "./prepared-catalogue.ts";

afterAll(disposePreparedCatalogueTemplate);

const open = (data: string) =>
  runProduct(
    { productDataDirectory: data, environment: {} },
    { start: (product) => product.workflow },
  );

async function admitBook(
  workflow: ReturnType<typeof open>["result"],
  name: string,
) {
  const root = await mkdtemp(path.join(tmpdir(), "digital-search-media-"));
  await writeFile(path.join(root, "book.txt"), `${name} 正文`);
  // 每次收纳都通过公开资产库入口取得该目录授权：登记本身不构成读取权威。
  const libraries = workflow.assetLibraries;
  const library = await libraries.save({
    displayName: name,
    directories: [root],
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
    name,
    classification: "book",
  });
  const accepted = await workflow.confirmLocalContent({
    executionId: content.executionId,
  });
  await rm(root, { recursive: true, force: true });
  return accepted.content.entity.id;
}

it("正式公开查找按文字包含命中显示名称、本地与已有名称，同名独立且通配符按字面处理", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-relationship-search-"),
  );
  const data = path.join(root, "data");
  await prepareCatalogueAt(data);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("离线"));
  let product = open(data);
  try {
    const workflow = product.result;
    // 数字资产的显示名称来自正式名称事实，而非标签列；片段仍应命中。
    const bookId = await admitBook(workflow, "深海之声 纪念册");
    const display = await workflow.findRelatedEntities("深海之声");
    expect(display.map((found) => found.id)).toContain(bookId);
    expect(display.find((found) => found.id === bookId)?.label).toContain(
      "深海之声",
    );
    // 本地标签按片段命中，同名不同实体各自返回，不产生身份等价。
    const first = await workflow.createLocalRelatedEntity({
      commitmentId: "author/1",
      label: "并川太郎",
      actorId: "user:reader",
    });
    const second = await workflow.createLocalRelatedEntity({
      commitmentId: "author/2",
      label: "并川太郎",
      actorId: "user:reader",
    });
    expect(second.id).not.toBe(first.id);
    const sameName = await workflow.findRelatedEntities("川太");
    expect(new Set(sameName.map((found) => found.id))).toEqual(
      new Set([first.id, second.id]),
    );
    // % 与 _ 按文字包含处理，绝不退化为 SQL 通配符。
    const literal = await workflow.createLocalRelatedEntity({
      commitmentId: "literal/percent",
      label: "特价50%OFF",
      actorId: "user:reader",
    });
    await workflow.createLocalRelatedEntity({
      commitmentId: "literal/other",
      label: "特价50倍OFF",
      actorId: "user:reader",
    });
    expect(
      (await workflow.findRelatedEntities("50%OFF")).map((found) => found.id),
    ).toEqual([literal.id]);
    const underscore = await workflow.createLocalRelatedEntity({
      commitmentId: "literal/underscore",
      label: "编号A_B卷",
      actorId: "user:reader",
    });
    await workflow.createLocalRelatedEntity({
      commitmentId: "literal/wide",
      label: "编号AXB卷",
      actorId: "user:reader",
    });
    expect(
      (await workflow.findRelatedEntities("A_B")).map((found) => found.id),
    ).toEqual([underscore.id]);
    // 大小写差异是不同字面片段：查找按字面区分，不因大小写不敏感而收敛命中。
    const upper = await workflow.createLocalRelatedEntity({
      commitmentId: "case/upper",
      label: "AlphaSeries",
      actorId: "user:reader",
    });
    const lower = await workflow.createLocalRelatedEntity({
      commitmentId: "case/lower",
      label: "alphaseries-control",
      actorId: "user:reader",
    });
    // 片段 "alpha" 只命中字面含该片段的小写实体，绝不命中仅大小写不同的 "AlphaSeries"。
    expect(
      (await workflow.findRelatedEntities("alpha")).map((found) => found.id),
    ).toEqual([lower.id]);
    // 大小写一致的片段仍按字面命中其归属实体。
    expect(
      (await workflow.findRelatedEntities("Series")).map((found) => found.id),
    ).toEqual([upper.id]);
    // 空输入维持既有语义：返回空集，而不是命中全部。
    await expect(workflow.findRelatedEntities("")).resolves.toEqual([]);
    await expect(workflow.findRelatedEntities("   ")).resolves.toEqual([]);
    // 重开后包含查询与持久化一致，不依赖任何内存检索。
    await product.close();
    product = open(data);
    expect(
      (await product.result.findRelatedEntities("深海之声")).map((f) => f.id),
    ).toContain(bookId);
    expect(
      (await product.result.findRelatedEntities("50%OFF")).map((f) => f.id),
    ).toEqual([literal.id]);
    expect(
      (await product.result.findRelatedEntities("alpha")).map((f) => f.id),
    ).toEqual([lower.id]);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await product.close();
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("已显式合并成员别名只映射到已接受森林的代表身份，未合并同名各自保留", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-relationship-search-merge-"),
  );
  const data = path.join(root, "data");
  await prepareCatalogueAt(data);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("离线"));
  const product = open(data);
  try {
    const workflow = product.result;
    const retained = await workflow.createLocalRelatedEntity({
      commitmentId: "merge/retained",
      label: "并合代表",
      actorId: "user:reader",
    });
    const member = await workflow.createLocalRelatedEntity({
      commitmentId: "merge/member",
      label: "并入成员",
      actorId: "user:reader",
    });
    const twin = await workflow.createLocalRelatedEntity({
      commitmentId: "merge/twin",
      label: "并入成员",
      actorId: "user:reader",
    });
    expect(
      await workflow.applyEntityIdentityMerge({
        commitmentId: "merge/apply",
        actorId: "user:reader",
        preview: await workflow.previewEntityIdentityMerge({
          retainedEntityId: retained.id,
          mergedEntityId: member.id,
        }),
      }),
    ).toBe("applied");
    // 命中被并入成员的保留名称时，返回其已接受代表身份，而不是成员本身。
    const byAlias = await workflow.findRelatedEntities("并入成员");
    const ids = new Set(byAlias.map((found) => found.id));
    expect(ids.has(member.id)).toBe(false);
    expect(ids.has(retained.id)).toBe(true);
    // 无等同证据的同名独立实体仍各自返回，别名映射不吞掉它。
    expect(ids.has(twin.id)).toBe(true);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await product.close();
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("离线按声明明确选择角色标注关系，逐项拒绝未知、缺角色、非法限定项、缺实体与过期", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-relationship-search-role-"),
  );
  const data = path.join(root, "data");
  await prepareCatalogueAt(data);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("离线"));
  let product = open(data);
  try {
    const workflow = product.result;
    const membership = workflow
      .relationshipTypeDefinitions()
      .find(({ id }) => id === "epub.series-membership")!;
    const assetRole = membership.roles.find(({ role }) => role === "asset")!;
    const seriesRole = membership.roles.find(({ role }) => role === "series")!;
    const bookId = await admitBook(workflow, "离线整理之书");
    const series = await workflow.createLocalRelatedEntity({
      commitmentId: "role/series",
      label: "离线整理系列",
      actorId: "user:reader",
    });
    // 没有历史关系或分类的普通实体，仍承担声明允许且明确选择的角色。
    expect([assetRole.minimum, seriesRole.minimum]).toEqual([1, 1]);
    const change = {
      kind: "create" as const,
      definitionId: membership.id,
      relationship: {
        type: membership.type,
        participants: [
          { entityId: bookId, role: assetRole.role },
          { entityId: series.id, role: seriesRole.role },
        ],
        qualifiers: [{ key: "position", value: "3" }],
      },
    };
    const preview = await workflow.previewRelationshipChange({
      changes: [change],
    });
    expect(
      await workflow.applyRelationshipChange({
        actorId: "user:reader",
        preview,
      }),
    ).toBe("applied");
    // 从任一参与者反查同一人工事实，依据为人工而非来源。
    const seriesEntity = await workflow.inspectCurrentCatalogueEntity(
      series.id,
    );
    assert.isDefined(seriesEntity);
    const fromSeries = seriesEntity.relationships.find(
      ({ type }) => type === membership.type,
    )!;
    expect(fromSeries.sources).toEqual([]);
    expect(fromSeries.participants.map((p) => p.entityId).sort()).toEqual(
      [bookId, series.id].sort(),
    );
    const bookEntity = await workflow.inspectCurrentCatalogueEntity(bookId);
    assert.isDefined(bookEntity);
    expect(bookEntity.relationships).toContainEqual(fromSeries);

    // 未知定义：调用方自报的类型不能改变提供方含义。
    await expect(
      workflow.previewRelationshipChange({
        changes: [{ ...change, definitionId: "自造/关系" }],
      }),
    ).rejects.toThrow("关系类型尚未声明");
    // 自报的关系类型与所选定义不一致。
    await expect(
      workflow.previewRelationshipChange({
        changes: [
          {
            ...change,
            relationship: {
              ...change.relationship,
              type: "自造/类型",
            },
          },
        ],
      }),
    ).rejects.toThrow("关系类型与声明不一致");
    // 缺失必需角色：署名定义允许额外角色，但没有声明的作品角色，
    // 仅凭署名参与者无法满足必需角色，由共用规则拒绝。
    const contribution = workflow
      .relationshipTypeDefinitions()
      .find(({ id }) => id === "epub.contribution")!;
    await expect(
      workflow.previewRelationshipChange({
        changes: [
          {
            ...change,
            definitionId: contribution.id,
            relationship: {
              type: contribution.type,
              participants: [
                { entityId: bookId, role: "作画" },
                { entityId: series.id, role: "发行" },
              ],
            },
          },
        ],
      }),
    ).rejects.toThrow("关系缺少必需角色");
    // 未声明的角色不能凭自报进入。
    await expect(
      workflow.previewRelationshipChange({
        changes: [
          {
            ...change,
            relationship: {
              type: membership.type,
              participants: [
                { entityId: bookId, role: assetRole.role },
                { entityId: series.id, role: seriesRole.role },
                { entityId: bookId, role: "自报角色" },
              ],
            },
          },
        ],
      }),
    ).rejects.toThrow("关系包含未声明的角色");
    // 非法限定项。
    await expect(
      workflow.previewRelationshipChange({
        changes: [
          {
            ...change,
            relationship: {
              ...change.relationship,
              qualifiers: [{ key: "自报限定", value: "x" }],
            },
          },
        ],
      }),
    ).rejects.toThrow("关系包含未声明的限定项");
    // 缺失实体：引用不存在的参与者被拒绝。
    await expect(
      workflow.previewRelationshipChange({
        changes: [
          {
            ...change,
            relationship: {
              ...change.relationship,
              participants: [
                { entityId: "related-entity_missing", role: assetRole.role },
                { entityId: series.id, role: seriesRole.role },
              ],
            },
          },
        ],
      }),
    ).rejects.toThrow("实体");
    // 过期预演在采用时被拒绝，且不覆盖当前事实。
    const stale = await workflow.previewRelationshipChange({
      changes: [change],
    });
    await workflow.applyRelationshipChange({
      actorId: "user:reader",
      preview: await workflow.previewRelationshipChange({
        changes: [
          {
            kind: "create" as const,
            definitionId: membership.id,
            relationship: {
              ...change.relationship,
              qualifiers: [{ key: "position", value: "4" }],
            },
          },
        ],
      }),
    });
    expect(
      await workflow.applyRelationshipChange({
        actorId: "user:reader",
        preview: stale,
      }),
    ).toBe("stale");
    // 重开后已采用的人工事实仍在，未知输入从未写入。
    await product.close();
    product = open(data);
    const reopenedBookEntity =
      await product.result.inspectCurrentCatalogueEntity(bookId);
    assert.isDefined(reopenedBookEntity);
    expect(reopenedBookEntity.relationships).toContainEqual(
      expect.objectContaining({ type: membership.type }),
    );
    expect(network).not.toHaveBeenCalled();
  } finally {
    await product.close();
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
