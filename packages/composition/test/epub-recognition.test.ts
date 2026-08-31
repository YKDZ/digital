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
    });
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
        relationshipTypes: [],
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
    const subject = await workflow.inspectCurrentCatalogueSubject(
      accepted!.entity.id,
    );
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
  } finally {
    await workflow.close();
    await rm(observed, { recursive: true, force: true });
    await rm(productData, { recursive: true, force: true });
  }
});

function syntheticEpub(cover: Uint8Array, withIsbn = false): Uint8Array {
  const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>合成本地出版物</dc:title>${withIsbn ? '<dc:identifier opf:scheme="ISBN">9780306406157</dc:identifier>' : ""}<dc:creator opf:role="aut">Carlo Zen 東條チカ</dc:creator><dc:publisher>本地出版社</dc:publisher><dc:date>2026</dc:date><dc:language>zh</dc:language><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="cover.png" media-type="image/png"/></manifest></package>`;
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
