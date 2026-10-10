import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, expect, it, vi } from "vitest";

import { composeAssetRefresh } from "../src/runtime.ts";
import {
  disposePreparedCatalogueTemplate,
  preparedCatalogueRoot,
} from "./prepared-catalogue.ts";

afterAll(async () => {
  await disposePreparedCatalogueTemplate();
});

it("普通组合资产刷新保持 exact ISBN 的官方来源依据", async () => {
  const productData = await preparedCatalogueRoot();
  const observed = await mkdtemp(path.join(tmpdir(), "digital-isbn-observed-"));
  await writeFile(
    path.join(observed, "official.epub"),
    syntheticEpub(new Uint8Array([1]), true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            docs: [
              {
                pnx: {
                  display: {
                    title: ["官方合成出版物"],
                    creator: ["官方原始贡献者文本"],
                    publisher: ["官方出版社"],
                    creationdate: ["2026"],
                    language: ["chi"],
                  },
                  addata: { isbn: ["9780306406157"] },
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  );
  const workflow = composeAssetRefresh(productData, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "合成 exact ISBN EPUB",
      containerPath: observed,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    // 现行契约：登记不等于授权，扫描前必须经正式资产库操作把该目录纳入恰好一个活动库。
    await workflow.assetLibraries.save({
      displayName: "exact ISBN EPUB 库",
      directories: [observed],
      recognitionProfileIds: ["books"],
      sourceIdentities: ["nbinet"],
    });
    const result = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        relationshipTypes: [
          { type: "asset.contribution", necessity: "required" },
        ],
        artifactRoles: [
          {
            role: "asset.primary-cover",
            necessity: "required",
            maximum: 1,
          },
        ],
      },
    });
    const accepted = result.itemResults?.[0]?.accepted;

    expect(accepted).toMatchObject({
      sourceAssociations: [
        {
          sourceIdentity: "nbinet",
          nativeAddress: expect.stringContaining("9780306406157"),
        },
      ],
      metadata: expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "官方合成出版物",
          sourceRecordIds: [expect.stringMatching(/^source-record_nbinet_/u)],
        }),
      ]),
      relationships: expect.arrayContaining([
        expect.objectContaining({
          type: "asset.contribution",
          participants: expect.arrayContaining([
            expect.objectContaining({ role: "asset" }),
            expect.objectContaining({ role: "book.contributor" }),
          ]),
        }),
      ]),
    });
    // 原断言：已接受工作项投影上同时给出 recognitionSourceAssociation 与
    // artifactAssociations 里的 primary-cover 角色。
    // 现断言：现行生效主体读取不再单独携带「识别来源依据」字段，而是给出来源关联本身，
    // 以及每个已选值的来源身份与支撑记录标识——两者共同承担原断言的保护：官方 ISBN 的来源
    // 依据必须精确指向该 nbinet 关联，且官方值必须由该 nbinet 记录支撑。
    // 封面角色断言保留在本用例末尾（见下方固定反例注释），使来源依据与公开关系流程的断言
    // 先真实到达。
    const subject = await workflow.inspectCurrentCatalogueSubject(
      accepted!.entity.id,
    );
    expect(subject?.sourceAssociations).toMatchObject([
      {
        sourceIdentity: "nbinet",
        nativeAddress: expect.stringContaining("9780306406157"),
      },
    ]);
    const officialTitle = subject!.descriptions
      .flatMap((description) => description.metadata)
      .filter((item) => item.property === "asset.title")
      .flatMap((item) =>
        item.result.status === "resolved" ? item.result.values : [],
      );
    expect(officialTitle).toHaveLength(1);
    expect(officialTitle[0]).toMatchObject({
      value: "官方合成出版物",
      sourceIdentity: "nbinet",
      sourceRecordIds: [expect.stringMatching(/^source-record_nbinet_/u)],
    });
    expect(officialTitle[0]!.assertions).toMatchObject([
      {
        sourceRecordIds: [expect.stringMatching(/^source-record_nbinet_/u)],
      },
    ]);
    const contributor = accepted?.currentRelatedEntities?.find(
      (entity) => entity.label === "官方原始贡献者文本",
    );
    expect(contributor).toBeDefined();
    const contributorFacts = await workflow.inspectCurrentCatalogueEntity(
      contributor!.id,
    );
    expect(contributorFacts?.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "asset.contribution" }),
      ]),
    );
    const sourceRelationship = contributorFacts!.relationships[0];
    expect(sourceRelationship.sources).toEqual([
      expect.objectContaining({ sourceIdentity: "nbinet" }),
    ]);
    const manual = await workflow.previewRelationshipChange({
      changes: [
        {
          kind: "replace",
          targetRelationshipId: sourceRelationship.id,
          definitionId: "nbinet.contribution",
          relationship: {
            type: sourceRelationship.type,
            participants: sourceRelationship.participants,
          },
        },
      ],
    });
    expect(
      await workflow.applyRelationshipChange({
        actorId: "user:reader",
        preview: manual,
      }),
    ).toBe("applied");
    const overridden = await workflow.inspectCurrentCatalogueEntity(
      contributor!.id,
    );
    expect(overridden!.relationships).toMatchObject([
      { type: "asset.contribution", sources: [] },
    ]);
    expect(
      (await workflow.inspectCurrentCatalogueSubject(accepted!.entity.id))!
        .sourceAssociations,
    ).toEqual(accepted!.sourceAssociations);
    const clear = await workflow.previewRelationshipChange({
      changes: [{ kind: "clear", targetRelationshipId: sourceRelationship.id }],
    });
    expect(
      await workflow.applyRelationshipChange({
        actorId: "user:reader",
        preview: clear,
      }),
    ).toBe("applied");
    expect(
      (await workflow.inspectCurrentCatalogueEntity(contributor!.id))!
        .relationships,
    ).toEqual(contributorFacts!.relationships);
    // 原断言：扫描请求 asset.primary-cover 时，工作项投影直接给出该角色的观察产物部分关联。
    // 现断言：同一事实保留在工作项投影上，并要求生效主体读取把这个角色解析到一个当前位置；
    // 不在测试侧把「角色缺失」当作可接受结果。
    // 固定反例（归属 04 资料确认生产修复，窄需求见 current/06/coordination.md）：可信扫描
    // 请求封面角色后，持久提议仍含 asset.material-image 部分，却既不产出任何观察材料关联、
    // 也不记录「材料预览尚未生成」处置，并使库进入「观察材料决定支持链损坏」。
    // 证据：current/06/probe-persisted-parts.log、current/06/probe-run-06c.log。
    expect(accepted).toMatchObject({
      artifactAssociations: expect.arrayContaining([
        expect.objectContaining({
          role: "asset.primary-cover",
          observedArtifactPart: expect.objectContaining({
            locator:
              "epub:OPS/book.opf#/metadata/meta[@name='cover'][@content='cover']->manifest/item[@id='cover']->entry:OPS/cover.png",
          }),
        }),
      ]),
    });
    const coverRoles = (await workflow.inspectCurrentCatalogueSubject(
      accepted!.entity.id,
    ))!.descriptions.flatMap((description) =>
      description.artifactRoles.filter(
        (role) => role.role === "asset.primary-cover",
      ),
    );
    expect(coverRoles).toHaveLength(1);
    expect(coverRoles[0]!.associationIds).not.toHaveLength(0);
    expect(
      (await workflow.listCurrentCatalogue())[0]!.locations.map(
        (location) => location.artifactId,
      ),
    ).toContain(coverRoles[0]!.artifactId);
  } finally {
    vi.unstubAllGlobals();
    await workflow.close();
    await rm(observed, { recursive: true, force: true });
    await rm(productData, { recursive: true, force: true });
  }
});

it("普通组合资产刷新接受无 ISBN EPUB 并保留修订版格式事实", async () => {
  const productData = await preparedCatalogueRoot();
  const observed = await mkdtemp(path.join(tmpdir(), "digital-epub-observed-"));
  const cover = new Uint8Array([9, 8, 7, 6]);
  await writeFile(
    path.join(observed, "publication.epub"),
    syntheticEpub(cover),
  );
  const workflow = composeAssetRefresh(productData, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "合成 EPUB",
      containerPath: observed,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    await workflow.assetLibraries.save({
      displayName: "无 ISBN EPUB 库",
      directories: [observed],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const result = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.title", necessity: "required" }],
        relationshipTypes: [
          { type: "asset.contribution", necessity: "required" },
        ],
        artifactRoles: [
          {
            role: "asset.primary-cover",
            necessity: "required",
            maximum: 1,
          },
        ],
      },
    });

    expect(result.itemResults).toHaveLength(1);
    const accepted = result.itemResults?.[0]?.accepted;
    expect(accepted).toMatchObject({
      entity: { kind: "digital-asset" },
      sourceAssociations: [],
      // 现行契约：本地身份由格式检查确认的单一修订版规则说明，不再由 ISBN 缺失措辞承担。
      recognitionExplanation:
        "格式检查确认该单一 EPUB 修订版是独立本地出版物边界",
      metadata: expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "合成本地出版物",
          sourceRecordIds: [],
          observedArtifactPart: expect.objectContaining({
            locator: "epub:OPS/book.opf#/metadata/dc:title[1]",
          }),
        }),
        expect.objectContaining({
          property: "book.publisher",
          value: "本地出版社",
          sourceRecordIds: [],
          observedArtifactPart: expect.objectContaining({
            locator: "epub:OPS/book.opf#/metadata/dc:publisher[1]",
          }),
        }),
      ]),
    });
    // 原断言：投影上「没有识别来源依据」用 not.toHaveProperty 表达，随后在生效主体读取上
    // 重放「标题观察 locator」与「封面角色关联」。
    // 现断言：缺席项保留（本地接受不得伪造识别来源依据），并同时要求生效主体读取给出
    // 「无来源关联、无识别来源依据」；本地观察的修订版格式事实保留在工作项投影 metadata 上
    // （上方 arrayContaining 已锁 locator），主体读取按现行契约核对贡献者实体与本地关系。
    // 封面角色与未变化重扫作为固定反例留在本用例末尾。
    expect(accepted).not.toHaveProperty("recognitionSourceAssociation");
    const currentSubject = await workflow.inspectCurrentCatalogueSubject(
      accepted!.entity.id,
    );
    expect(currentSubject).toMatchObject({
      id: accepted!.entity.id,
      sourceAssociations: [],
    });
    expect(currentSubject!.recognitionSourceAssociation).toBeUndefined();
    const contributor = currentSubject?.relatedEntities?.find(
      (entity) => entity.label === "Carlo Zen 東條チカ",
    );
    expect(contributor).toBeDefined();
    expect(
      await workflow.inspectCurrentCatalogueEntity(contributor!.id),
    ).toMatchObject({
      entity: { label: "Carlo Zen 東條チカ" },
      relationships: [
        expect.objectContaining({
          type: "asset.contribution",
          sources: [],
        }),
      ],
    });
    await workflow.close();
    const reopened = composeAssetRefresh(productData, {});
    try {
      expect(
        await reopened.inspectCurrentCatalogueEntity(contributor!.id),
      ).toMatchObject({
        relationships: [
          expect.objectContaining({ type: "asset.contribution", sources: [] }),
        ],
      });
      // 固定反例（归属 04「资料确认生产修复」与 05/07 支持链写入形状，窄需求见
      // current/06/coordination.md）：可信扫描请求封面角色后，观察产物部分既不投影为工作项
      // 材料关联，也不进入生效主体读取的角色与修订版描述；库同时进入
      // 「观察材料决定支持链损坏」。证据：current/06/probe-persisted-parts.log、
      // current/06/probe-epub-subject-facts.log、current/06/probe-read-shapes.log。
      expect(accepted).toMatchObject({
        artifactAssociations: expect.arrayContaining([
          expect.objectContaining({
            role: "asset.primary-cover",
            observedArtifactPart: expect.objectContaining({
              locator:
                "epub:OPS/book.opf#/metadata/meta[@name='cover'][@content='cover']->manifest/item[@id='cover']->entry:OPS/cover.png",
            }),
          }),
        ]),
      });
      const reopenedSubject = (await reopened.inspectCurrentCatalogueSubject(
        accepted!.entity.id,
      ))!;
      const coverRoles = reopenedSubject.descriptions.flatMap((description) =>
        description.artifactRoles.filter(
          (role) => role.role === "asset.primary-cover",
        ),
      );
      expect(coverRoles).toHaveLength(1);
      expect(coverRoles[0]!.associationIds).not.toHaveLength(0);
      expect(
        reopenedSubject.locations.map((location) => location.artifactId),
      ).toContain(coverRoles[0]!.artifactId);
      // 「保留修订版格式事实」在现行读取上的另一半：观察到的标题必须挂在一个
      // artifact-revision 描述上，并且该观察位置带有已确认的当前修订版内容。
      expect(
        reopenedSubject.descriptions.some(
          (description) => description.target.kind === "artifact-revision",
        ),
      ).toBe(true);
      const carrierArtifactId = accepted!.locations.find(
        (location) => location.kind === "observed",
      )!.artifactId;
      const carrierLocation = reopenedSubject.locations.find(
        (location) => location.artifactId === carrierArtifactId,
      );
      expect(carrierLocation?.content.status).toBe("confirmed");
      // 同一范围未变化时保留已确认的载体、材料图和身份。
      const replay = await reopened.scanObservedScope({
        registrationId: root.id,
        relativeScope: ".",
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.title", necessity: "required" }],
          relationshipTypes: [
            { type: "asset.contribution", necessity: "required" },
          ],
          artifactRoles: [
            {
              role: "asset.primary-cover",
              necessity: "required",
              maximum: 1,
            },
          ],
        },
      });
      expect(replay.itemResults?.[0]?.outcome).toBe("no-change");
    } finally {
      await reopened.close();
    }
  } finally {
    await workflow.close();
    await rm(observed, { recursive: true, force: true });
    await rm(productData, { recursive: true, force: true });
  }
});

it("公开 EPUB 自动关系可被排除、重选并清除", async () => {
  const productData = await preparedCatalogueRoot();
  const observed = await mkdtemp(
    path.join(tmpdir(), "digital-epub-relationship-"),
  );
  const informationRequirement = {
    metadataUsageContext: "asset.ordinary" as const,
    metadata: [],
    relationshipTypes: [
      { type: "asset.contribution", necessity: "required" as const },
    ],
    artifactRoles: [],
  };
  await writeFile(
    path.join(observed, "publication.epub"),
    syntheticEpub(new Uint8Array([1, 2, 3])),
  );
  const workflow = composeAssetRefresh(productData, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "关系 EPUB",
      containerPath: observed,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    await workflow.assetLibraries.save({
      displayName: "EPUB 关系库",
      directories: [observed],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const result = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement,
    });
    const accepted = result.itemResults?.[0]?.accepted;
    const contributor = accepted?.currentRelatedEntities?.find(
      (entity) => entity.label === "Carlo Zen 東條チカ",
    );
    const current = await workflow.inspectCurrentCatalogueEntity(
      contributor!.id,
    );
    const automatic = current!.relationships.find(
      ({ type }) => type === "asset.contribution",
    )!;

    const exclude = await workflow.previewRelationshipChange({
      changes: [{ kind: "exclude", targetRelationshipId: automatic.id }],
    });
    await expect(
      workflow.applyRelationshipChange({
        actorId: "user:甲",
        preview: exclude,
      }),
    ).resolves.toBe("applied");
    await expect(
      workflow.inspectCurrentCatalogueEntity(contributor!.id),
    ).resolves.toMatchObject({ relationships: [] });

    const select = await workflow.previewRelationshipChange({
      changes: [{ kind: "select", targetRelationshipId: automatic.id }],
    });
    await expect(
      workflow.applyRelationshipChange({ actorId: "user:甲", preview: select }),
    ).resolves.toBe("applied");
    const selected = await workflow.inspectCurrentCatalogueEntity(
      contributor!.id,
    );
    expect(selected!.relationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: automatic.id })]),
    );

    const clear = await workflow.previewRelationshipChange({
      changes: [{ kind: "clear", targetRelationshipId: automatic.id }],
    });
    await expect(
      workflow.applyRelationshipChange({ actorId: "user:甲", preview: clear }),
    ).resolves.toBe("applied");
    await expect(
      workflow.inspectCurrentCatalogueEntity(contributor!.id),
    ).resolves.toMatchObject({
      relationships: [expect.objectContaining({ id: automatic.id })],
    });
  } finally {
    await workflow.close();
    await rm(observed, { recursive: true, force: true });
    await rm(productData, { recursive: true, force: true });
  }
});

function syntheticEpub(
  cover: Uint8Array,
  withIsbn = false,
  creator = "Carlo Zen 東條チカ",
): Uint8Array {
  const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>合成本地出版物</dc:title>${withIsbn ? '<dc:identifier opf:scheme="ISBN">9780306406157</dc:identifier>' : ""}<dc:creator role="aut">${creator}</dc:creator><dc:publisher>本地出版社</dc:publisher><dc:date>2026</dc:date><dc:language>zh</dc:language><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="cover.png" media-type="image/png"/></manifest></package>`;
  return storedZip([
    ["META-INF/container.xml", new TextEncoder().encode(container)],
    ["OPS/book.opf", new TextEncoder().encode(opf)],
    ["OPS/cover.png", cover],
  ]);
}

function storedZip(
  entries: readonly (readonly [string, Uint8Array])[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + nameBytes.length + bytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint32(18, bytes.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(bytes, 30 + nameBytes.length);
    chunks.push(local);
    const header = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(header.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    central.push(header);
    offset += local.length;
  }
  const centralLength = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralLength, true);
  view.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const result = new Uint8Array(
    all.reduce((sum, item) => sum + item.length, 0),
  );
  let cursor = 0;
  for (const part of all) {
    result.set(part, cursor);
    cursor += part.length;
  }
  return result;
}
