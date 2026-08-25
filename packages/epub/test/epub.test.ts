import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EpubPublicationInspector,
  inspectEpubPublication,
} from "../src/index.ts";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const tracer = path.join(
  workspace,
  ".scratch/acceptance-corpus/assets/appdata/booklore/books/漫画/Carlo Zen 東條チカ/幼女战记(1)/幼女战记(1) - Carlo Zen 東條チカ (2024).epub",
);

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
  it("reads OPF identity facts and the embedded cover from a real EPUB", () => {
    const publication = inspectEpubPublication(readFileSync(tracer));
    expect(publication.isbn13).toBe("9789864738281");
    expect(publication.title).toBe("幼女战记(1)");
    expect(publication.contributors).toContain("Carlo Zen 東條チカ");
    expect(publication.language).toBe("zh");
    expect(publication.cover).toMatchObject({
      mediaType: expect.stringMatching(/^image\//u),
    });
  });

  it("uses the per-artifact inspector and keeps bytes out of its evidence", async () => {
    const evidence = await new EpubPublicationInspector().inspect({
      observedArtifactReference: "book.epub",
      byteSource: byteSource(readFileSync(tracer), tracer),
    });
    const serialized = JSON.stringify(evidence);
    expect(evidence[0]?.inspection?.identifiers).toContainEqual({
      scheme: "isbn-13",
      value: "9789864738281",
    });
    expect(serialized).not.toContain(path.dirname(tracer));
    expect(serialized).not.toContain("bytes");
  });

  it("reports revision and exact metadata locators for a text-only synthetic EPUB", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "digital-epub-"));
    try {
      const epub2 = fixture(
        directory,
        "epub2.epub",
        `<dc:identifier opf:scheme="ISBN">978-0-306-40615-7</dc:identifier><dc:creator>A</dc:creator><dc:contributor>B</dc:contributor>`,
      );
      const epub3 = fixture(
        directory,
        "epub3.epub",
        `<dc:identifier id="book-id">9780306406157</dc:identifier><meta refines="#book-id" property="identifier-type">ISBN</meta>`,
      );
      const nonIsbn = fixture(
        directory,
        "other.epub",
        `<dc:identifier opf:scheme="UUID">9780306406157</dc:identifier>`,
      );
      const invalid = fixture(
        directory,
        "invalid.epub",
        `<dc:identifier opf:scheme="ISBN">9780306406158</dc:identifier>`,
      );
      expect(inspectEpubPublication(readFileSync(epub2))).toMatchObject({
        isbn13: "9780306406157",
        contributorFacts: [
          { role: "creator", locator: "epub:opf/dc:creator[1]" },
          { role: "contributor", locator: "epub:opf/dc:contributor[1]" },
        ],
      });
      expect(inspectEpubPublication(readFileSync(epub3)).isbn13).toBe(
        "9780306406157",
      );
      expect(
        inspectEpubPublication(readFileSync(nonIsbn)).isbn13,
      ).toBeUndefined();
      expect(
        inspectEpubPublication(readFileSync(invalid)).isbn13,
      ).toBeUndefined();
      const evidence = await new EpubPublicationInspector().inspect({
        observedArtifactReference: "epub2.epub",
        byteSource: byteSource(readFileSync(epub2), epub2),
      });
      const sourceBytes = readFileSync(epub2);
      expect(evidence[0]?.inspection?.revision).toEqual({
        digest: createHash("sha256").update(sourceBytes).digest("hex"),
        byteLength: sourceBytes.byteLength,
        mediaType: "application/epub+zip",
      });
      expect(evidence[0]?.inspection?.metadata).toEqual([
        {
          property: "asset.title",
          sourceSlot: "opf.title",
          value: "文本书",
          locator: "epub:opf/dc:title[1]",
        },
        {
          property: "asset.declared-language",
          sourceSlot: "opf.language",
          value: "zh",
          locator: "epub:opf/dc:language[1]",
        },
        {
          property: "book.contributor",
          sourceSlot: "opf.creator.1",
          value: "A",
          locator: "epub:opf/dc:creator[1]",
        },
        {
          property: "book.contributor",
          sourceSlot: "opf.contributor.2",
          value: "B",
          locator: "epub:opf/dc:contributor[1]",
        },
      ]);
      expect(evidence[0]?.inspection?.parts).toEqual([]);
      expect(
        evidence[0]?.inspection?.metadata.map((item) => item.locator),
      ).toContain("epub:opf/dc:creator[1]");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function fixture(directory: string, name: string, identifiers: string): string {
  const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>文本书</dc:title>${identifiers}<dc:language>zh</dc:language></metadata><manifest/></package>`;
  const file = path.join(directory, name);
  writeFileSync(
    file,
    storedZip([
      ["META-INF/container.xml", container],
      ["OPS/book.opf", opf],
    ]),
  );
  return file;
}

function storedZip(
  entries: readonly (readonly [string, string])[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const bytes = new TextEncoder().encode(text);
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
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, bytes.length, true);
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
