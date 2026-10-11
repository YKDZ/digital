import { createHash } from "node:crypto";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { createPdfRecognitionCapabilities } from "../src/index.ts";

describe("PDF 本地格式能力", () => {
  it("从有效 PDF 的公开检查 seam 形成精确修订版与格式事实", async () => {
    const bytes = syntheticPdf({ author: "Document Author", pageCount: 2 });
    const { formatInspectors } = createPdfRecognitionCapabilities();

    const evidence = await formatInspectors[0].inspect({
      observedArtifactReference: "observed-pdf",
      byteSource: byteSource(bytes, "publication.pdf"),
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.inspection).toMatchObject({
      identifiers: [],
      observedArtifactReference: "observed-pdf",
      revision: {
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mediaType: "application/pdf",
      },
      metadata: [
        {
          property: "pdf.page-count",
          sourceSlot: "pdf.page-count",
          value: "2",
          locator: "pdf:catalog/pages",
        },
        {
          property: "pdf.document-author",
          sourceSlot: "pdf.info.author",
          value: "Document Author",
          locator: "pdf:info/Author",
        },
      ],
      parts: [
        {
          role: "asset.material-image",
          locator: "pdf:page[1]",
          mediaType: "image/png",
        },
      ],
    });
    expect(JSON.stringify(evidence)).not.toContain("publication.pdf");
  });

  it("只把非 PDF 当作不适用，并稳定拒绝已声明的损坏或加密 PDF", async () => {
    const { formatInspectors } = createPdfRecognitionCapabilities();
    const inspector = formatInspectors[0];

    await expect(
      inspector.inspect({
        observedArtifactReference: "ordinary",
        byteSource: byteSource(
          new TextEncoder().encode("ordinary"),
          "item.bin",
        ),
      }),
    ).resolves.toEqual([]);
    await expect(
      inspector.inspect({
        observedArtifactReference: "damaged",
        byteSource: byteSource(
          new TextEncoder().encode("ordinary"),
          "item.pdf",
        ),
      }),
    ).rejects.toThrow("damaged-pdf");
    await expect(
      inspector.inspect({
        observedArtifactReference: "encrypted",
        byteSource: byteSource(structurallyEncryptedPdf(), "encrypted.pdf"),
      }),
    ).rejects.toThrow("unsupported-encryption");

    let read = false;
    await expect(
      inspector.inspect({
        observedArtifactReference: "large",
        byteSource: {
          ...byteSource(new Uint8Array(), "large.pdf"),
          byteLength: 64 * 1024 * 1024 + 1,
          read: async () => {
            read = true;
            return new Uint8Array();
          },
        },
      }),
    ).rejects.toThrow("resource-limit:artifact-bytes");
    expect(read).toBe(false);

    let sniffedRead = false;
    await expect(
      inspector.inspect({
        observedArtifactReference: "large-sniffed",
        byteSource: {
          ...byteSource(new Uint8Array(), "large.bin"),
          byteLength: 64 * 1024 * 1024 + 1,
          readChunk: async () => ({
            bytes: new TextEncoder().encode("%PDF-1.7"),
            done: false,
          }),
          read: async () => {
            sniffedRead = true;
            return new Uint8Array();
          },
        },
      }),
    ).rejects.toThrow("resource-limit:artifact-bytes");
    expect(sniffedRead).toBe(false);
  });

  it("大型非 PDF 只读取有界格式头，不触发 PDF 整体大小限制", async () => {
    const { formatInspectors } = createPdfRecognitionCapabilities();
    const chunks: { readonly offset: number; readonly maximumBytes: number }[] =
      [];
    let read = false;

    await expect(
      formatInspectors[0].inspect({
        observedArtifactReference: "large-non-pdf",
        byteSource: {
          ...byteSource(new Uint8Array(), "large-video.mp4"),
          byteLength: 349_453_386,
          readChunk: async (offset, maximumBytes) => {
            chunks.push({ offset, maximumBytes });
            return {
              bytes: new TextEncoder().encode("ordinary-media-header"),
              done: false,
            };
          },
          read: async () => {
            read = true;
            return new Uint8Array();
          },
        },
      }),
    ).resolves.toEqual([]);
    expect(chunks).toEqual([{ offset: 0, maximumBytes: 1_024 }]);
    expect(read).toBe(false);
  });

  it("拒绝超过页数预算的完整 PDF，且不返回部分格式事实", async () => {
    const bytes = syntheticPdf({ author: "Document Author", pageCount: 2_001 });
    const { formatInspectors } = createPdfRecognitionCapabilities();

    await expect(
      formatInspectors[0].inspect({
        observedArtifactReference: "too-many-pages",
        byteSource: byteSource(bytes, "pages.pdf"),
      }),
    ).rejects.toThrow("resource-limit:pages");
  });

  it("对精确单一修订版按 0／1／多 ISBN 形成可审计规则结果", async () => {
    const capabilities = createPdfRecognitionCapabilities();
    const inspector = capabilities.formatInspectors[0]!;
    const recognizer = capabilities.recognizers[0]!;

    async function contextFor(isbns: readonly string[]) {
      const bytes = syntheticPdf({
        author: "Document Author",
        pageCount: 1,
        isbns,
      });
      const [evidence] = await inspector.inspect({
        observedArtifactReference: "local.pdf",
        byteSource: byteSource(bytes, "local.pdf"),
      });
      const inspection = evidence!.inspection!;
      return {
        basis: {
          kind: "observed-evidence" as const,
          producer: evidence!.producer,
          artifactRevisions: [
            {
              observedArtifactReference: inspection.observedArtifactReference,
              blob: inspection.revision,
              producer: evidence!.producer,
            },
          ],
        },
        evidence: [evidence!],
      };
    }

    // 现行 v3 契约：识别规则只声明「格式检查确认的单一修订版即独立本地出版物边界」，
    // ISBN 的条数与冲突解释留在格式检查层逐载体保留，不在此任选或改写（见下一条用例）。
    for (const isbns of [
      [] as string[],
      ["9784049131291"],
      ["9784049131291", "9789577435064"],
    ]) {
      const context = await contextFor(isbns);
      expect(recognizer.canRecognize(context)).toBe(true);
      expect(recognizer.recognize(context).ruleResults).toMatchObject([
        {
          ...trustedRuleCoordinate(),
          outcome: "satisfied",
          evidence: context.evidence,
        },
      ]);
    }

    const single = await contextFor(["9784049131291"]);
    expect(
      recognizer.canRecognize({
        ...single,
        evidence: [single.evidence[0]!, single.evidence[0]!],
      }),
    ).toBe(false);
    expect(
      recognizer.canRecognize({
        ...single,
        basis: {
          ...single.basis,
          producer: {
            ...single.basis.producer,
            implementationVersion: "1",
            capabilityVersion: "1",
          },
        },
      }),
    ).toBe(false);
    expect(() =>
      recognizer.recognize({
        ...single,
        basis: {
          ...single.basis,
          producer: {
            ...single.basis.producer,
            implementationVersion: "1",
            capabilityVersion: "1",
          },
        },
      }),
    ).toThrow("PDF 本地识别只接受格式检查确认的单一出版物修订版");

    // 逐条件负项：每次只改变一项依据，其余保持合法，识别仍必须拒绝，
    // 覆盖精确修订版的摘要、字节长度、媒体类型、观察引用、修订生产者与依据数量。
    const rejectsOneCondition = (
      label: string,
      context: Awaited<ReturnType<typeof contextFor>>,
    ) => {
      expect(recognizer.canRecognize(context), label).toBe(false);
      expect(() => recognizer.recognize(context), label).toThrow(
        "PDF 本地识别只接受格式检查确认的单一出版物修订版",
      );
    };
    const revision = single.basis.artifactRevisions[0]!;
    const withRevision = (
      change: (
        source: typeof revision,
      ) => (typeof single.basis.artifactRevisions)[number],
    ) => ({
      ...single,
      basis: {
        ...single.basis,
        artifactRevisions: [change(revision)],
      },
    });
    rejectsOneCondition(
      "摘要与格式检查不一致",
      withRevision((source) => ({
        ...source,
        blob: { ...source.blob, digest: "0".repeat(64) },
      })),
    );
    rejectsOneCondition(
      "字节长度与格式检查不一致",
      withRevision((source) => ({
        ...source,
        blob: { ...source.blob, byteLength: source.blob.byteLength + 1 },
      })),
    );
    rejectsOneCondition(
      "媒体类型与格式检查不一致",
      withRevision((source) => ({
        ...source,
        blob: { ...source.blob, mediaType: "application/octet-stream" },
      })),
    );
    rejectsOneCondition(
      "观察引用与格式检查不一致",
      withRevision((source) => ({
        ...source,
        observedArtifactReference: "renamed.pdf",
      })),
    );
    rejectsOneCondition(
      "修订生产者不是格式检查能力",
      withRevision((source) => ({
        ...source,
        producer: { ...source.producer, implementationVersion: "1" },
      })),
    );
    rejectsOneCondition("依据包含两个修订版", {
      ...single,
      basis: {
        ...single.basis,
        artifactRevisions: [revision, revision],
      },
    });
  });

  it("只从完整 XMP carrier 读取有效 ISBN，并在 Title 冲突时不任选", async () => {
    const { formatInspectors } = createPdfRecognitionCapabilities();
    const [single] = await formatInspectors[0].inspect({
      observedArtifactReference: "single-isbn",
      byteSource: byteSource(
        syntheticPdf({
          author: "Document Author",
          pageCount: 1,
          infoTitle: "Info title",
          xmpTitle: "Different XMP title",
          isbns: ["9784049131291"],
        }),
        "single.pdf",
      ),
    });
    const [multiple] = await formatInspectors[0].inspect({
      observedArtifactReference: "multiple-isbn",
      byteSource: byteSource(
        syntheticPdf({
          author: "Document Author",
          pageCount: 1,
          isbns: ["9784049131291", "9789577435064"],
        }),
        "multiple.pdf",
      ),
    });
    const [infoOnly] = await formatInspectors[0].inspect({
      observedArtifactReference: "info-title",
      byteSource: byteSource(
        syntheticPdf({
          author: "Document Author",
          pageCount: 1,
          infoTitle: "Shared title",
        }),
        "info-title.pdf",
      ),
    });
    const [matchingTitles] = await formatInspectors[0].inspect({
      observedArtifactReference: "matching-title",
      byteSource: byteSource(
        syntheticPdf({
          author: "Document Author",
          pageCount: 1,
          infoTitle: "Shared title",
          xmpTitle: "Shared title",
        }),
        "matching-title.pdf",
      ),
    });

    expect(single.inspection!.identifiers).toEqual([
      {
        scheme: "isbn-13",
        value: "9784049131291",
        locators: ["pdf:xmp/dc:identifier[1]/rdf:li[1]"],
      },
    ]);
    expect(multiple.inspection!.identifiers).toEqual([
      {
        scheme: "isbn-13",
        value: "9784049131291",
        locators: ["pdf:xmp/dc:identifier[1]/rdf:li[1]"],
      },
      {
        scheme: "isbn-13",
        value: "9789577435064",
        locators: ["pdf:xmp/dc:identifier[1]/rdf:li[2]"],
      },
    ]);
    expect(single.inspection!.metadata).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "asset.title" }),
      ]),
    );
    expect(infoOnly.inspection!.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Shared title",
          locator: "pdf:info/Title",
        }),
      ]),
    );
    expect(matchingTitles.inspection!.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Shared title",
          locator: "pdf:info/Title",
        }),
      ]),
    );
  });

  it("按 XML namespace 和直接文本边界解释 XMP 并聚合同值载体", async () => {
    const xmp = [
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description xmlns:d="http://purl.org/dc/elements/1.1/" xmlns:fake="urn:fake">',
      "<d:title><rdf:Alt><rdf:li>One</rdf:li><rdf:li>Two</rdf:li></rdf:Alt></d:title>",
      "<d:identifier>9784049131291</d:identifier>",
      "<d:identifier><rdf:Bag><rdf:li>978-4-04-913129-1</rdf:li><rdf:li><fake:value>9789577435064</fake:value></rdf:li><rdf:li><![CDATA[9789577435064]]></rdf:li></rdf:Bag></d:identifier>",
      "<d:description><d:identifier>9789577435064</d:identifier></d:description>",
      "<fake:identifier>9789577435064</fake:identifier>",
      "<!-- <d:identifier>9789577435064</d:identifier> -->",
      "<![CDATA[<d:identifier>9789577435064</d:identifier>]]>",
      "</rdf:Description></rdf:RDF></x:xmpmeta>",
    ].join("");
    const { formatInspectors } = createPdfRecognitionCapabilities();
    const [evidence] = await formatInspectors[0].inspect({
      observedArtifactReference: "structured-xmp",
      byteSource: byteSource(
        syntheticPdf({
          author: "Document Author",
          pageCount: 1,
          infoTitle: "Info title must not resolve ambiguous XMP",
          xmpRaw: xmp,
        }),
        "structured.pdf",
      ),
    });
    const [directTitle] = await formatInspectors[0].inspect({
      observedArtifactReference: "direct-title",
      byteSource: byteSource(
        syntheticPdf({
          author: "Document Author",
          pageCount: 1,
          xmpRaw:
            '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:d="http://purl.org/dc/elements/1.1/"><d:title>Title &amp; Name</d:title></rdf:Description></rdf:RDF>',
        }),
        "direct-title.pdf",
      ),
    });

    expect(evidence.inspection!.identifiers).toEqual([
      {
        scheme: "isbn-13",
        value: "9784049131291",
        locators: [
          "pdf:xmp/dc:identifier[1]",
          "pdf:xmp/dc:identifier[2]/rdf:li[1]",
        ],
      },
    ]);
    expect(evidence.inspection!.metadata).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "asset.title" }),
      ]),
    );
    expect(directTitle.inspection!.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Title & Name",
          locator: "pdf:xmp/dc:title[1]",
        }),
      ]),
    );
  });

  it("从同一修订版重复获取确定性第一页 PNG，并报告实际父修订版", async () => {
    const bytes = syntheticVisualPdf();
    const capabilities = createPdfRecognitionCapabilities();
    const [evidence] = await capabilities.formatInspectors[0].inspect({
      observedArtifactReference: "cover.pdf",
      byteSource: byteSource(bytes, "cover.pdf"),
    });
    const part = evidence.inspection!.parts[0];
    const candidate = {
      ...part,
      id: "pdf-cover",
      observedArtifactReference: "cover.pdf",
      producer: evidence.producer,
    };
    const acquirer = capabilities.observedArtifactPartAcquirers[0];

    const first = await acquirer.acquire({
      candidate,
      byteSource: byteSource(bytes, "cover.pdf"),
    });
    const second = await acquirer.acquire({
      candidate,
      byteSource: byteSource(bytes, "renamed.pdf"),
    });

    expect([...first.bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.mediaType).toBe("image/png");
    expect(first.origin).toEqual(evidence.inspection!.revision);
    expect(first.bytes.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
    const image = await loadImage(first.bytes);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const left = context.getImageData(
      Math.floor(image.width / 4),
      Math.floor(image.height / 2),
      1,
      1,
    ).data;
    const right = context.getImageData(
      Math.floor((image.width * 3) / 4),
      Math.floor(image.height / 2),
      1,
      1,
    ).data;
    expect([...left]).toEqual([0, 0, 0, 255]);
    expect([...right]).toEqual([255, 255, 255, 255]);
  });
});

function byteSource(bytes: Uint8Array, logicalLocation: string) {
  return {
    byteLength: bytes.byteLength,
    logicalLocation,
    readChunk: async (offset: number, maximumBytes: number) => ({
      bytes: bytes.slice(offset, offset + maximumBytes),
      done: offset + maximumBytes >= bytes.byteLength,
    }),
    read: async () => bytes,
    close: async () => undefined,
  };
}

function trustedRuleCoordinate() {
  return {
    capabilityId: "pdf.local-publication-recognizer",
    capabilityVersion: "3",
    ruleId: "pdf.valid-single-publication-revision",
    ruleVersion: "3",
  } as const;
}

function syntheticPdf(input: {
  readonly author: string;
  readonly pageCount: number;
  readonly infoTitle?: string;
  readonly xmpTitle?: string;
  readonly isbns?: readonly string[];
  readonly xmpRaw?: string;
}): Uint8Array {
  const xmp =
    input.xmpRaw ??
    (input.xmpTitle === undefined && (input.isbns?.length ?? 0) === 0
      ? undefined
      : [
          '<?xpacket begin="﻿"?>',
          '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
          '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
          '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">',
          ...(input.xmpTitle === undefined
            ? []
            : [
                `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${input.xmpTitle}</rdf:li></rdf:Alt></dc:title>`,
              ]),
          ...((input.isbns?.length ?? 0) === 0
            ? []
            : [
                `<dc:identifier><rdf:Bag>${input.isbns!.map((isbn) => `<rdf:li>${isbn}</rdf:li>`).join("")}</rdf:Bag></dc:identifier>`,
              ]),
          "</rdf:Description></rdf:RDF></x:xmpmeta>",
          '<?xpacket end="w"?>',
        ].join(""));
  const metadataId = input.pageCount + 3;
  const infoId = metadataId + (xmp === undefined ? 0 : 1);
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${xmp === undefined ? "" : ` /Metadata ${metadataId} 0 R`} >>`,
    `<< /Type /Pages /Kids [${Array.from({ length: input.pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${input.pageCount} >>`,
    ...Array.from(
      { length: input.pageCount },
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>",
    ),
    ...(xmp === undefined
      ? []
      : [
          `<< /Type /Metadata /Subtype /XML /Length ${new TextEncoder().encode(xmp).byteLength} >>\nstream\n${xmp}\nendstream`,
        ]),
    `<< /Author (${input.author})${input.infoTitle === undefined ? "" : ` /Title (${input.infoTitle})`} >>`,
  ];
  let source = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

function syntheticVisualPdf(): Uint8Array {
  const content = "0 0 0 rg 0 0 100 300 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Author (Document Author) >>",
  ];
  let source = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size 6 /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

function structurallyEncryptedPdf(): Uint8Array {
  return serializePdf(
    [
      ascii("<< /Type /Catalog /Pages 2 0 R >>"),
      ascii("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      ascii("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>"),
      ascii(
        "<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>",
      ),
      ascii("<< /Author (Encrypted) >>"),
    ],
    {
      infoId: 5,
      trailer:
        "/Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]",
    },
  );
}

function serializePdf(
  objects: readonly Uint8Array[],
  options: { readonly infoId: number; readonly trailer?: string },
): Uint8Array {
  const chunks: Uint8Array[] = [ascii("%PDF-1.7\n")];
  const offsets = [0];
  let length = chunks[0].byteLength;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const framed = joinBytes([
      ascii(`${index + 1} 0 obj\n`),
      object,
      ascii("\nendobj\n"),
    ]);
    chunks.push(framed);
    length += framed.byteLength;
  }
  const xref = length;
  chunks.push(
    ascii(
      [
        `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
        ...offsets
          .slice(1)
          .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${options.infoId} 0 R${options.trailer === undefined ? "" : ` ${options.trailer}`} >>\nstartxref\n${xref}\n%%EOF\n`,
      ].join(""),
    ),
  );
  return joinBytes(chunks);
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
