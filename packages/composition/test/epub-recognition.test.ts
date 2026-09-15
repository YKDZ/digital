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
      recognitionSourceAssociation: {
        sourceIdentity: "nbinet",
        nativeAddress: expect.stringContaining("9780306406157"),
      },
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
      artifactAssociations: expect.arrayContaining([
        expect.objectContaining({
          role: "asset.primary-cover",
          observedArtifactPart: expect.any(Object),
        }),
      ]),
    });
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
    const sourceRelationship = contributorFacts!.relationships[0]!;
    expect(sourceRelationship.sources).toEqual([
      expect.objectContaining({ sourceIdentity: "nbinet" }),
    ]);
    const manual = await workflow.previewRelationshipChange({
      changes: [
        {
          kind: "fix",
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
      changes: [{ kind: "clear", relationshipIds: [sourceRelationship.id] }],
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
      recognitionExplanation: expect.stringContaining("无有效 ISBN"),
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
    expect(accepted).not.toHaveProperty("recognitionSourceAssociation");
    const currentSubject = await workflow.inspectCurrentCatalogueSubject(
      accepted!.entity.id,
    );
    const contributor = currentSubject?.currentRelatedEntities?.find(
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
    const subject = currentSubject;
    expect(subject).toMatchObject({
      sourceAssociations: [],
      metadata: expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          observedArtifactPart: expect.objectContaining({
            locator: "epub:OPS/book.opf#/metadata/dc:title[1]",
          }),
        }),
      ]),
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
    const replay = await workflow.scanObservedScope({
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
      changes: [{ kind: "exclude", relationshipIds: [automatic.id] }],
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
      changes: [{ kind: "select", relationshipIds: [automatic.id] }],
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
      changes: [{ kind: "clear", relationshipIds: [automatic.id] }],
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
