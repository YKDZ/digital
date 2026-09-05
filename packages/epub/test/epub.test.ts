import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

import type { CapabilityCoordinate } from "@digital/domain";
import { describe, expect, it } from "vitest";

import {
  EpubEmbeddedCoverAcquirer,
  EpubLocalPublicationRecognizer,
  EpubPublicationInspector,
  trustedEpubLocalPublicationRule,
} from "../src/index.ts";

function byteSource(bytes: Uint8Array, logicalLocation: string) {
  return {
    logicalLocation,
    async read() {
      return bytes;
    },
    async close() {},
  };
}

describe("EPUB publication inspection", () => {
  it("reports an exact revision for a valid EPUB with no ISBN", async () => {
    const bytes = fixture(
      `<dc:identifier opf:scheme="UUID">book-1</dc:identifier>`,
    );
    const evidence = await new EpubPublicationInspector().inspect({
      observedArtifactReference: "observed-book-1",
      byteSource: byteSource(bytes, "synthetic.epub"),
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.inspection).toMatchObject({
      identifiers: [],
      observedArtifactReference: "observed-book-1",
      revision: {
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mediaType: "application/epub+zip",
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("synthetic.epub");
    expect(JSON.stringify(evidence)).not.toContain("bytes");
  });

  it("explains invalid and conflicting ISBN declarations without choosing one", async () => {
    const inspector = new EpubPublicationInspector();
    const invalid = await inspector.inspect({
      observedArtifactReference: "invalid-isbn",
      byteSource: byteSource(
        fixture(
          `<dc:identifier opf:scheme="ISBN">9780306406158</dc:identifier>`,
        ),
        "invalid.epub",
      ),
    });
    const conflicting = await inspector.inspect({
      observedArtifactReference: "conflicting-isbn",
      byteSource: byteSource(
        fixture(
          `<dc:identifier opf:scheme="ISBN">9780306406157</dc:identifier><dc:identifier opf:scheme="ISBN">9789864738281</dc:identifier>`,
        ),
        "conflicting.epub",
      ),
    });

    expect(invalid[0]).toMatchObject({
      explanation: expect.stringContaining("拒绝 1 个无效 ISBN"),
      inspection: { identifiers: [] },
    });
    expect(conflicting[0]).toMatchObject({
      explanation: expect.stringContaining("2 个冲突的有效 ISBN-13"),
      inspection: {
        identifiers: [
          {
            scheme: "isbn-13",
            value: "9780306406157",
            locators: ["epub:OPS/book.opf#/metadata/dc:identifier[1]"],
          },
          {
            scheme: "isbn-13",
            value: "9789864738281",
            locators: ["epub:OPS/book.opf#/metadata/dc:identifier[2]"],
          },
        ],
      },
    });
  });

  it("recognizes an EPUB 3 refined ISBN and aggregates duplicate carrier locators", async () => {
    const evidence = await new EpubPublicationInspector().inspect({
      observedArtifactReference: "epub3-isbn",
      byteSource: byteSource(
        fixture(
          `<dc:identifier id="book-id">9780306406157</dc:identifier><meta property="identifier-type" refines="#book-id">ISBN</meta><dc:identifier>978-0-306-40615-7</dc:identifier>`,
        ),
        "epub3.epub",
      ),
    });

    expect(evidence[0]?.inspection?.identifiers).toEqual([
      {
        scheme: "isbn-13",
        value: "9780306406157",
        locators: [
          "epub:OPS/book.opf#/metadata/dc:identifier[1]",
          "epub:OPS/book.opf#/metadata/dc:identifier[2]",
        ],
      },
    ]);
  });

  it("accepts only supported ISBN-13 lexical forms and fails conflicting semantics closed", async () => {
    const inspector = new EpubPublicationInspector();
    const inspect = async (metadata: string) =>
      (
        await inspector.inspect({
          observedArtifactReference: "isbn-lexical-boundary",
          byteSource: byteSource(fixture(metadata), "lexical.epub"),
        })
      )[0]!;
    const prefixed = await inspect(
      `<dc:identifier>ISBN-13: 978-0-306-40615-7</dc:identifier>`,
    );
    const garbage = await inspect(
      `<dc:identifier>garbage9780306406157suffix</dc:identifier>`,
    );
    const explicitNonIsbn = await inspect(
      `<dc:identifier id="book-id" opf:scheme="UUID">9780306406157</dc:identifier><meta refines="#book-id" property="identifier-type">ISBN</meta>`,
    );
    const conflictIsbnFirst = await inspect(
      `<dc:identifier id="book-id">9780306406157</dc:identifier><meta refines="#book-id" property="identifier-type">ISBN</meta><meta property="identifier-type" refines="#book-id">DOI</meta>`,
    );
    const conflictIsbnLast = await inspect(
      `<dc:identifier id="book-id">9780306406157</dc:identifier><meta refines="#book-id" property="identifier-type">DOI</meta><meta property="identifier-type" refines="#book-id">ISBN</meta>`,
    );

    expect(prefixed.inspection?.identifiers).toEqual([
      {
        scheme: "isbn-13",
        value: "9780306406157",
        locators: ["epub:OPS/book.opf#/metadata/dc:identifier[1]"],
      },
    ]);
    for (const rejected of [
      garbage,
      explicitNonIsbn,
      conflictIsbnFirst,
      conflictIsbnLast,
    ]) {
      expect(rejected.inspection?.identifiers).toEqual([]);
      expect(
        new EpubLocalPublicationRecognizer().canRecognize(
          observedContext(rejected),
        ),
      ).toBe(true);
    }
  });

  it("preserves a collection mention whose EPUB 3 carrier has no id", async () => {
    const [evidence] = await new EpubPublicationInspector().inspect({
      observedArtifactReference: "collection-without-id",
      byteSource: byteSource(
        fixture(`<meta property="belongs-to-collection">无标识系列</meta>`),
        "collection.epub",
      ),
    });

    expect(evidence?.inspection?.metadata).toEqual(
      expect.arrayContaining([
        fact(
          "book.collection-mention",
          "opf.collection.mention-1",
          "无标识系列",
          "epub:OPS/book.opf#/metadata/meta[@property='belongs-to-collection'][1]",
        ),
      ]),
    );
    expect(
      evidence?.inspection?.metadata.some(
        (item) => item.property === "book.collection-group-position",
      ),
    ).toBe(false);
  });

  it("rejects malformed or ambiguous supported EPUB container structures", async () => {
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`;
    const opf = `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>文本书</dc:title></metadata><manifest></manifest></package>`;
    const mismatchedName = storedZip([
      ["META-INF/container.xml", container],
      ["OPS/book.opf", opf],
    ]);
    rewriteLocalEntryName(mismatchedName, 1, "OPS/evil.opf");
    const malformed = [
      storedZip([
        ["META-INF/container.xml", container.replace("</container>", "")],
        ["OPS/book.opf", opf],
      ]),
      storedZip([
        ["META-INF/container.xml", container.replace("</rootfiles>", "")],
        ["OPS/book.opf", opf],
      ]),
      storedZip([
        ["META-INF/container.xml", container],
        ["OPS/book.opf", opf.replace("</package>", "")],
      ]),
      storedZip([
        ["META-INF/container.xml", container],
        ["OPS/book.opf", opf],
        ["OPS/book.opf", opf],
      ]),
      mismatchedName,
      storedZip([
        [
          "META-INF/container.xml",
          container.replace(
            "</rootfiles>",
            `<rootfile full-path="ALT/book.opf"/></rootfiles>`,
          ),
        ],
        ["OPS/book.opf", opf],
        ["ALT/book.opf", opf],
      ]),
      storedZip([
        [
          "META-INF/container.xml",
          container.replace(
            `full-path="OPS/book.opf"`,
            `full-path="OPS/book.opf" full-path="ALT/book.opf"`,
          ),
        ],
        ["OPS/book.opf", opf],
      ]),
    ];
    const inspector = new EpubPublicationInspector();

    for (const bytes of malformed)
      await expect(
        inspector.inspect({
          observedArtifactReference: "malformed-epub",
          byteSource: byteSource(bytes, "malformed.epub"),
        }),
      ).resolves.toEqual([]);
  });

  it("bounds deflated EPUB members by actual output and compression ratio", async () => {
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`;
    const opf = `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>文本书</dc:title></metadata><manifest></manifest></package>`;
    const ordinary = storedZip([
      ["META-INF/container.xml", container],
      ["OPS/book.opf", opf, "deflate"],
    ]);
    const bomb = storedZip([
      ["META-INF/container.xml", container],
      [
        "OPS/book.opf",
        opf.replace("</metadata>", `${" ".repeat(64 * 1024)}</metadata>`),
        "deflate",
      ],
    ]);
    const inspector = new EpubPublicationInspector();

    await expect(
      inspector.inspect({
        observedArtifactReference: "ordinary-deflate",
        byteSource: byteSource(ordinary, "ordinary.epub"),
      }),
    ).resolves.toHaveLength(1);
    await expect(
      inspector.inspect({
        observedArtifactReference: "ratio-bomb",
        byteSource: byteSource(bomb, "bomb.epub"),
      }),
    ).resolves.toEqual([]);
  });

  it("preserves EPUB 2 and 3 publication facts at exact format locators and acquires their covers", async () => {
    const epub2 = fixture(
      `<dc:creator opf:role="aut">Carlo Zen 東條チカ</dc:creator><dc:contributor opf:role="trl">譯者</dc:contributor><dc:publisher>EPUB2 出版社</dc:publisher><dc:date>2018-04-01</dc:date><meta content="cover2" name="cover"/>`,
      `<item id="cover2" href="images/cover.jpg" media-type="image/jpeg"/>`,
      [["OPS/images/cover.jpg", new Uint8Array([2, 4, 6])]],
    );
    const epub3 = fixture(
      `<dc:creator id="creator-1">Carlo Zen 東條チカ</dc:creator><meta refines="#creator-1" property="role">aut</meta><dc:publisher>EPUB3 出版社</dc:publisher><dc:date>2024</dc:date><meta id="collection-1" property="belongs-to-collection">幼女战记</meta><meta refines="#collection-1" property="collection-type">series</meta><meta refines="#collection-1" property="group-position">2</meta>`,
      `<item id="cover3" href="cover.png" media-type="image/png" properties="cover-image"/>`,
      [["OPS/cover.png", new Uint8Array([3, 6, 9])]],
    );
    const inspector = new EpubPublicationInspector();
    const [epub2Evidence] = await inspector.inspect({
      observedArtifactReference: "revision-epub2",
      byteSource: byteSource(epub2, "publication.epub"),
    });
    const [epub3Evidence] = await inspector.inspect({
      observedArtifactReference: "revision-epub3",
      byteSource: byteSource(epub3, "publication.epub"),
    });

    expect(epub2Evidence?.inspection?.metadata).toEqual(
      expect.arrayContaining([
        fact(
          "book.contributor",
          "opf.creator.1",
          "Carlo Zen 東條チカ",
          "epub:OPS/book.opf#/metadata/dc:creator[1]",
        ),
        fact(
          "book.contributor-role",
          "opf.creator.1.role",
          "aut",
          "epub:OPS/book.opf#/metadata/dc:creator[1]/@opf:role",
        ),
        fact(
          "book.contributor",
          "opf.contributor.1",
          "譯者",
          "epub:OPS/book.opf#/metadata/dc:contributor[1]",
        ),
        fact(
          "book.contributor-role",
          "opf.contributor.1.role",
          "trl",
          "epub:OPS/book.opf#/metadata/dc:contributor[1]/@opf:role",
        ),
        fact(
          "book.publisher",
          "opf.publisher.1",
          "EPUB2 出版社",
          "epub:OPS/book.opf#/metadata/dc:publisher[1]",
        ),
        fact(
          "book.publication-date",
          "opf.date.1",
          "2018-04-01",
          "epub:OPS/book.opf#/metadata/dc:date[1]",
        ),
      ]),
    );
    expect(epub3Evidence?.inspection?.metadata).toEqual(
      expect.arrayContaining([
        fact(
          "book.contributor",
          "opf.creator.1",
          "Carlo Zen 東條チカ",
          "epub:OPS/book.opf#/metadata/dc:creator[1]",
        ),
        fact(
          "book.contributor-role",
          "opf.creator.1.role",
          "aut",
          "epub:OPS/book.opf#/metadata/meta[@refines='#creator-1'][@property='role']",
        ),
        fact(
          "book.publisher",
          "opf.publisher.1",
          "EPUB3 出版社",
          "epub:OPS/book.opf#/metadata/dc:publisher[1]",
        ),
        fact(
          "book.publication-date",
          "opf.date.1",
          "2024",
          "epub:OPS/book.opf#/metadata/dc:date[1]",
        ),
        fact(
          "book.collection-mention",
          "opf.collection.collection-1",
          "幼女战记",
          "epub:OPS/book.opf#/metadata/meta[@id='collection-1'][@property='belongs-to-collection']",
        ),
        fact(
          "book.collection-group-position",
          "opf.collection.collection-1.group-position",
          "2",
          "epub:OPS/book.opf#/metadata/meta[@refines='#collection-1'][@property='group-position']",
        ),
      ]),
    );
    expect(
      epub3Evidence?.inspection?.metadata.filter(
        (item) => item.property === "book.contributor",
      ),
    ).toHaveLength(1);

    const epub2Part = epub2Evidence!.inspection!.parts[0]!;
    const epub3Part = epub3Evidence!.inspection!.parts[0]!;
    expect(epub2Part.locator).toBe(
      "epub:OPS/book.opf#/metadata/meta[@name='cover'][@content='cover2']->manifest/item[@id='cover2']->entry:OPS/images/cover.jpg",
    );
    expect(epub3Part.locator).toBe(
      "epub:OPS/book.opf#/manifest/item[@id='cover3'][@properties~='cover-image']->entry:OPS/cover.png",
    );
    const acquirer = new EpubEmbeddedCoverAcquirer();
    expect(
      acquirer.canAcquire({
        id: "foreign-cover",
        ...epub3Part,
        observedArtifactReference: "revision-epub3",
        producer: { ...epub3Evidence!.producer, capabilityId: "foreign" },
      }),
    ).toBe(false);
    for (const forged of forgedCoordinates(epub3Evidence!.producer)) {
      expect(
        acquirer.canAcquire({
          id: "forged-producer-cover",
          ...epub3Part,
          observedArtifactReference: "revision-epub3",
          producer: forged,
        }),
      ).toBe(false);
    }
    await expect(
      acquirer.acquire({
        candidate: {
          id: "forged-selector",
          ...epub3Part,
          locator: epub3Part.locator.replace("cover-image", "ordinary-image"),
          observedArtifactReference: "revision-epub3",
          producer: epub3Evidence!.producer,
        },
        byteSource: byteSource(epub3, "publication.epub"),
      }),
    ).rejects.toThrow(/declared cover|声明|candidate/u);
    await expect(
      acquirer.acquire({
        candidate: {
          id: "cover-3",
          ...epub3Part,
          observedArtifactReference: "revision-epub3",
          producer: epub3Evidence!.producer,
        },
        byteSource: byteSource(epub3, "publication.epub"),
      }),
    ).resolves.toMatchObject({
      candidateId: "cover-3",
      bytes: new Uint8Array([3, 6, 9]),
      mediaType: "image/png",
      origin: {
        digest: createHash("sha256").update(epub3).digest("hex"),
        byteLength: epub3.byteLength,
        mediaType: "application/epub+zip",
      },
    });

    const ambiguous = fixture(
      "",
      `<item id="cover-a" href="a.png" media-type="image/png" properties="cover-image"/><item id="cover-b" href="b.png" media-type="image/png" properties="cover-image"/>`,
      [
        ["OPS/a.png", new Uint8Array([1])],
        ["OPS/b.png", new Uint8Array([2])],
      ],
    );
    const ambiguousEvidence = await inspector.inspect({
      observedArtifactReference: "ambiguous-cover",
      byteSource: byteSource(ambiguous, "ambiguous.epub"),
    });
    expect(ambiguousEvidence[0]?.inspection?.parts).toEqual([]);
  });

  it("proposes only one inspector-produced revision with no valid ISBN", async () => {
    const inspector = new EpubPublicationInspector();
    const noIsbn = (
      await inspector.inspect({
        observedArtifactReference: "revision-local",
        byteSource: byteSource(fixture(""), "local.epub"),
      })
    )[0]!;
    const withIsbn = (
      await inspector.inspect({
        observedArtifactReference: "revision-official",
        byteSource: byteSource(
          fixture(
            `<dc:identifier opf:scheme="ISBN">9780306406157</dc:identifier>`,
          ),
          "official.epub",
        ),
      })
    )[0]!;
    const conflicting = (
      await inspector.inspect({
        observedArtifactReference: "revision-conflict",
        byteSource: byteSource(
          fixture(
            `<dc:identifier opf:scheme="ISBN">9780306406157</dc:identifier><dc:identifier opf:scheme="ISBN">9789864738281</dc:identifier>`,
          ),
          "conflict.epub",
        ),
      })
    )[0]!;
    const recognizer = new EpubLocalPublicationRecognizer();
    const localContext = observedContext(noIsbn);

    expect(recognizer.canRecognize(localContext)).toBe(true);
    expect(recognizer.recognize(localContext)).toMatchObject({
      ruleResults: [
        {
          ...trustedEpubLocalPublicationRule,
          outcome: "satisfied",
          evidence: [noIsbn],
        },
      ],
    });
    expect(recognizer.canRecognize(observedContext(withIsbn))).toBe(false);
    expect(recognizer.canRecognize(observedContext(conflicting))).toBe(false);
    for (const forged of forgedCoordinates(noIsbn.producer)) {
      expect(
        recognizer.canRecognize({
          ...localContext,
          basis: { ...localContext.basis, producer: forged },
        }),
      ).toBe(false);
      expect(
        recognizer.canRecognize({
          ...localContext,
          evidence: [{ ...noIsbn, producer: forged }],
        }),
      ).toBe(false);
      expect(
        recognizer.canRecognize({
          ...localContext,
          basis: {
            ...localContext.basis,
            artifactRevisions: [
              { ...localContext.basis.artifactRevisions[0]!, producer: forged },
            ],
          },
        }),
      ).toBe(false);
    }
    expect(
      recognizer.canRecognize({
        ...localContext,
        basis: {
          ...localContext.basis,
          artifactRevisions: [
            ...localContext.basis.artifactRevisions,
            {
              ...localContext.basis.artifactRevisions[0]!,
              observedArtifactReference: "second",
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      recognizer.canRecognize({
        evidence: [noIsbn],
        basis: {
          kind: "source-interpretation",
          interpretation: {
            id: "not-local",
            producer: inspector.capability,
            sourceRecordIds: [],
            sourceIdentity: "local.epub",
            sourceAddress: "not-a-source",
            metadata: [],
            sourceArtifacts: [],
          },
        },
      }),
    ).toBe(false);
  });
});

function forgedCoordinates(coordinate: CapabilityCoordinate) {
  return [
    { ...coordinate, contractVersion: "forged-contract" },
    { ...coordinate, implementationVersion: "forged-implementation" },
    { ...coordinate, identity: "forged-identity" },
    { ...coordinate, kind: "forged-kind" },
    {
      ...coordinate,
      interpretationContractVersions: ["forged-interpretation-contract"],
    },
  ];
}

function observedContext(
  evidence: Awaited<ReturnType<EpubPublicationInspector["inspect"]>>[number],
) {
  return {
    evidence: [evidence],
    basis: {
      kind: "observed-evidence" as const,
      producer: evidence.producer,
      artifactRevisions: [
        {
          observedArtifactReference:
            evidence.inspection!.observedArtifactReference,
          blob: evidence.inspection!.revision,
          producer: evidence.producer,
        },
      ],
    },
  };
}

function fact(
  property: string,
  sourceSlot: string,
  value: string,
  locator: string,
) {
  return { property, sourceSlot, value, locator };
}

function fixture(
  metadata: string,
  manifest = "",
  entries: readonly (readonly [string, Uint8Array])[] = [],
): Uint8Array {
  const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>文本书</dc:title>${metadata}<dc:language>zh</dc:language></metadata><manifest>${manifest}</manifest></package>`;
  return storedZip([
    ["META-INF/container.xml", container],
    ["OPS/book.opf", opf],
    ...entries,
  ]);
}

function storedZip(
  entries: readonly (readonly [
    string,
    string | Uint8Array,
    ("deflate" | undefined)?,
  ])[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content, compression] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    const encoded =
      compression === "deflate" ? new Uint8Array(deflateRawSync(bytes)) : bytes;
    const method = compression === "deflate" ? 8 : 0;
    const local = new Uint8Array(30 + nameBytes.length + encoded.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, method, true);
    view.setUint32(18, encoded.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(encoded, 30 + nameBytes.length);
    chunks.push(local);
    const header = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, encoded.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    central.push(header);
    offset += local.length;
  }
  const centralLength = central.reduce((total, item) => total + item.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralLength, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const result = new Uint8Array(
    all.reduce((total, item) => total + item.length, 0),
  );
  let index = 0;
  for (const part of all) {
    result.set(part, index);
    index += part.length;
  }
  return result;
}

function rewriteLocalEntryName(
  archive: Uint8Array,
  entryIndex: number,
  replacement: string,
): void {
  let offset = 0;
  for (let index = 0; index <= entryIndex; index += 1) {
    const view = new DataView(
      archive.buffer,
      archive.byteOffset + offset,
      archive.byteLength - offset,
    );
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    if (index === entryIndex) {
      const replacementBytes = new TextEncoder().encode(replacement);
      if (replacementBytes.byteLength !== nameLength)
        throw new Error("replacement ZIP name must retain its encoded length");
      archive.set(replacementBytes, offset + 30);
      return;
    }
    offset += 30 + nameLength + extraLength + compressedSize;
  }
}
