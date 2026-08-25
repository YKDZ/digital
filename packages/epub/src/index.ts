import { createHash } from "node:crypto";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import {
  declareCapability,
  type ArtifactFormatInspector,
  type ObservedArtifactPartAcquirer,
} from "@digital/application";
import type {
  RecognitionEvidence,
  ObservedArtifactPartCandidate,
} from "@digital/domain";

const directoryCapability = declareCapability({
  identity: "epub.publication-inspection",
  implementationVersion: "1",
  kind: "artifact-format-inspector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const acquirerCapability = declareCapability({
  identity: "epub.embedded-cover-acquirer",
  implementationVersion: "1",
  kind: "observed-artifact-part-acquirer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

export type EpubPublication = {
  readonly isbn13?: string;
  readonly title?: string;
  readonly contributors: readonly string[];
  readonly contributorFacts: readonly {
    readonly role: "creator" | "contributor";
    readonly value: string;
    readonly locator: string;
  }[];
  readonly language?: string;
  readonly cover?: { readonly bytes: Uint8Array; readonly mediaType: string };
};

/** 解析应用层已绑定观察者能力提供的字节。 */
export function inspectEpubPublication(bytes: Uint8Array): EpubPublication {
  const archive = new ZipArchive(bytes);
  const container = archive.text("META-INF/container.xml");
  const rootfile = attribute(
    /<rootfile\b[^>]*>/iu.exec(container)?.[0],
    "full-path",
  );
  if (rootfile === undefined)
    throw new Error("EPUB container has no OPF rootfile");
  const opf = archive.text(rootfile);
  const title = firstElementText(opf, "dc:title");
  const contributorFacts = [
    ...elementTexts(opf, "dc:creator").map((value, index) => ({
      role: "creator" as const,
      value,
      locator: `epub:opf/dc:creator[${index + 1}]`,
    })),
    ...elementTexts(opf, "dc:contributor").map((value, index) => ({
      role: "contributor" as const,
      value,
      locator: `epub:opf/dc:contributor[${index + 1}]`,
    })),
  ];
  const contributors = contributorFacts.map((item) => item.value);
  const language = firstElementText(opf, "dc:language");
  const isbn13 = isbnIdentifiers(opf).find(isValidIsbn13);
  const manifest = manifestItems(opf);
  const coverId =
    attribute(
      /<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*>/iu.exec(opf)?.[0],
      "content",
    ) ??
    manifest.find((item) =>
      /(?:^|\s)cover-image(?:\s|$)/u.test(item.properties ?? ""),
    )?.id;
  const coverItem =
    coverId === undefined
      ? undefined
      : manifest.find((item) => item.id === coverId);
  const cover =
    coverItem === undefined
      ? undefined
      : {
          bytes: archive.bytes(resolveHref(rootfile, coverItem.href)),
          mediaType: coverItem.mediaType,
        };
  return {
    ...(isbn13 === undefined ? {} : { isbn13 }),
    ...(title === undefined ? {} : { title }),
    contributors,
    contributorFacts,
    ...(language === undefined ? {} : { language }),
    ...(cover === undefined ? {} : { cover }),
  };
}

/**
 * EPUB 集成拥有容器解释。它选择显式的单文件作品边界，而不是把父目录变成图书。
 */
export class EpubPublicationInspector implements ArtifactFormatInspector {
  readonly capability = directoryCapability;
  async inspect(input: {
    readonly observedArtifactReference: string;
    readonly byteSource: import("@digital/application").ObservedByteSource;
  }): Promise<readonly RecognitionEvidence[]> {
    if (!input.byteSource.logicalLocation.toLowerCase().endsWith(".epub"))
      return [];
    let sourceBytes: Uint8Array;
    let publication: EpubPublication;
    try {
      sourceBytes = await input.byteSource.read();
      publication = inspectEpubPublication(sourceBytes);
    } catch {
      return [];
    }
    if (publication.isbn13 === undefined) return [];
    return [
      {
        kind: "artifact-format-inspection",
        explanation: "本地格式检查发现有效 ISBN-13",
        producer: this.capability,
        inspection: {
          identifiers: [{ scheme: "isbn-13", value: publication.isbn13 }],
          observedArtifactReference: input.observedArtifactReference,
          revision: {
            digest: createHash("sha256").update(sourceBytes).digest("hex"),
            mediaType: "application/epub+zip",
            byteLength: sourceBytes.byteLength,
          },
          metadata: [
            ...(publication.title === undefined
              ? []
              : [
                  {
                    property: "asset.title",
                    sourceSlot: "opf.title",
                    value: publication.title,
                    locator: "epub:opf/dc:title[1]",
                  },
                ]),
            ...(publication.language === undefined
              ? []
              : [
                  {
                    property: "asset.declared-language",
                    sourceSlot: "opf.language",
                    value: publication.language,
                    locator: "epub:opf/dc:language[1]",
                  },
                ]),
            ...publication.contributorFacts.map((item, index) => ({
              property: "book.contributor",
              sourceSlot: `opf.${item.role}.${index + 1}`,
              value: item.value,
              locator: item.locator,
            })),
          ],
          parts:
            publication.cover === undefined
              ? []
              : [
                  {
                    role: "asset.primary-cover",
                    locator: "epub:cover",
                    mediaType: publication.cover.mediaType,
                  },
                ],
        },
      },
    ];
  }
}

/** 只有应用层提出请求后，才实体化 EPUB 内嵌封面。 */
export class EpubEmbeddedCoverAcquirer implements ObservedArtifactPartAcquirer {
  readonly capability = acquirerCapability;

  canAcquire(candidate: ObservedArtifactPartCandidate): boolean {
    return candidate.locator === "epub:cover";
  }

  async acquire(input: {
    readonly candidate: ObservedArtifactPartCandidate;
    readonly byteSource: import("@digital/application").ObservedByteSource;
  }): Promise<{
    readonly candidateId: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly origin: {
      readonly digest: string;
      readonly mediaType: string;
      readonly byteLength: number;
    };
  }> {
    if (!this.canAcquire(input.candidate))
      throw new Error("EPUB cover candidate is unsupported");
    const sourceBytes = await input.byteSource.read();
    const publication = inspectEpubPublication(sourceBytes);
    if (publication.cover === undefined)
      throw new Error("EPUB no longer contains its declared cover");
    if (
      mediaTypeEssence(publication.cover.mediaType) !==
      mediaTypeEssence(input.candidate.mediaType)
    )
      throw new Error(
        "EPUB cover media type differs from the declared candidate",
      );
    return {
      candidateId: input.candidate.id,
      bytes: publication.cover.bytes,
      mediaType: publication.cover.mediaType,
      origin: {
        digest: createHash("sha256").update(sourceBytes).digest("hex"),
        mediaType: "application/epub+zip",
        byteLength: sourceBytes.byteLength,
      },
    };
  }
}

function isbnIdentifiers(opf: string): readonly string[] {
  return [
    ...opf.matchAll(/<dc:identifier\b([^>]*)>([\s\S]*?)<\/dc:identifier>/giu),
  ].flatMap((match) => {
    const identifierId = attribute(match[1], "id");
    const scheme =
      attribute(match[1], "opf:scheme") ??
      attribute(match[1], "scheme") ??
      identifierId;
    const value = decodeXml(
      match[2]!.replaceAll(/<[^>]+>/gu, "").trim(),
    ).replaceAll(/[^\d]/gu, "");
    const epub3Semantic =
      identifierId === undefined
        ? false
        : new RegExp(
            `<meta\\b[^>]*\\brefines\\s*=\\s*(["'])#${escapeRegExp(identifierId)}\\1[^>]*\\bproperty\\s*=\\s*(["'])identifier-type\\2[^>]*>\\s*isbn(?:-13)?\\s*<\\/meta>`,
            "iu",
          ).test(opf);
    // 显式非 ISBN 方案始终优先。EPUB2 未提供方案时，只接受 ISBN-13 前缀/校验和本身的语义。
    if (
      scheme !== undefined &&
      !/^isbn(?:-13)?$/iu.test(scheme) &&
      !epub3Semantic
    )
      return [];
    return isValidIsbn13(value) ? [value] : [];
  });
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isValidIsbn13(value: string): boolean {
  if (!/^(?:97[89])\d{10}$/u.test(value)) return false;
  const sum = Array.from(value)
    .slice(0, 12)
    .reduce(
      (total, digit, index) =>
        total + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0,
    );
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

function mediaTypeEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? value;
}

type ManifestItem = {
  readonly id: string;
  readonly href: string;
  readonly mediaType: string;
  readonly properties?: string;
};

function manifestItems(opf: string): readonly ManifestItem[] {
  return [...opf.matchAll(/<item\b[^>]*>/giu)].flatMap((match) => {
    const id = attribute(match[0], "id");
    const href = attribute(match[0], "href");
    const mediaType = attribute(match[0], "media-type");
    if (id === undefined || href === undefined || mediaType === undefined)
      return [];
    const properties = attribute(match[0], "properties");
    return [
      {
        id,
        href,
        mediaType,
        ...(properties === undefined ? {} : { properties }),
      },
    ];
  });
}

function attribute(tag: string | undefined, name: string): string | undefined {
  if (tag === undefined) return undefined;
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(tag);
  return match === null ? undefined : decodeXml(match[2]!);
}

function firstElementText(source: string, name: string): string | undefined {
  return elementTexts(source, name)[0];
}

function elementTexts(source: string, name: string): readonly string[] {
  return [
    ...source.matchAll(
      new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "giu"),
    ),
  ]
    .map((match) => decodeXml(match[1]!.replaceAll(/<[^>]+>/gu, "").trim()))
    .filter(Boolean);
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function resolveHref(opf: string, href: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(opf), href));
}

/** 刻意保持精简且有界的 EPUB 容器成员 ZIP 读取器。 */
class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>();
  private readonly archiveBytes: Uint8Array;

  constructor(archiveBytes: Uint8Array) {
    this.archiveBytes = archiveBytes;
    const eocd = findEndOfCentralDirectory(archiveBytes);
    const count = readU16(archiveBytes, eocd + 10);
    const directoryOffset = readU32(archiveBytes, eocd + 16);
    if (count > 10_000) throw new Error("EPUB has too many archive members");
    let offset = directoryOffset;
    for (let index = 0; index < count; index += 1) {
      if (readU32(archiveBytes, offset) !== 0x02014b50)
        throw new Error("EPUB ZIP central directory is invalid");
      const flags = readU16(archiveBytes, offset + 8);
      const method = readU16(archiveBytes, offset + 10);
      const compressedSize = readU32(archiveBytes, offset + 20);
      const uncompressedSize = readU32(archiveBytes, offset + 24);
      const nameLength = readU16(archiveBytes, offset + 28);
      const extraLength = readU16(archiveBytes, offset + 30);
      const commentLength = readU16(archiveBytes, offset + 32);
      const localOffset = readU32(archiveBytes, offset + 42);
      const name = decodeZipName(
        archiveBytes.subarray(offset + 46, offset + 46 + nameLength),
        flags,
      );
      this.entries.set(name, {
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  text(name: string): string {
    return new TextDecoder().decode(this.bytesFor(name));
  }

  bytes(name: string): Uint8Array {
    return this.bytesFor(name);
  }

  private bytesFor(name: string): Uint8Array {
    const entry = this.entries.get(name);
    if (entry === undefined)
      throw new Error(`EPUB archive member is absent: ${name}`);
    if (entry.uncompressedSize > 32 * 1024 * 1024)
      throw new Error("EPUB archive member exceeds inspection limit");
    const offset = entry.localOffset;
    if (readU32(this.archiveBytes, offset) !== 0x04034b50)
      throw new Error("EPUB ZIP local header is invalid");
    const nameLength = readU16(this.archiveBytes, offset + 26);
    const extraLength = readU16(this.archiveBytes, offset + 28);
    const raw = this.archiveBytes.subarray(
      offset + 30 + nameLength + extraLength,
      offset + 30 + nameLength + extraLength + entry.compressedSize,
    );
    const unpacked =
      entry.method === 0
        ? raw
        : entry.method === 8
          ? new Uint8Array(inflateRawSync(raw))
          : undefined;
    if (
      unpacked === undefined ||
      unpacked.byteLength !== entry.uncompressedSize
    )
      throw new Error("EPUB archive member is unsupported or corrupt");
    return unpacked;
  }
}

type ZipEntry = {
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
};

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (
    let index = bytes.length - 22;
    index >= Math.max(0, bytes.length - 65_557);
    index -= 1
  )
    if (readU32(bytes, index) === 0x06054b50) return index;
  throw new Error("EPUB ZIP end record is absent");
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength)
    throw new Error("EPUB ZIP offset is invalid");
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength)
    throw new Error("EPUB ZIP offset is invalid");
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function decodeZipName(bytes: Uint8Array, _flags: number): string {
  return new TextDecoder().decode(bytes);
}
