import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import {
  declareCapability,
  type ArtifactFormatInspector,
  type ObservedArtifactPartAcquirer,
  type Recognizer,
  type RecognitionCandidateContext,
} from "@digital/application";
import type {
  CapabilityCoordinate,
  RecognitionEvidence,
  ObservedArtifactPartCandidate,
  RecognitionProposalDraft,
} from "@digital/domain";

const maximumArchiveMemberBytes = 32 * 1024 * 1024;
const maximumDeflateCompressionRatio = 100;

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
const localRecognizerCapability = declareCapability({
  identity: "epub.local-publication-recognizer",
  implementationVersion: "1",
  kind: "recognizer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

export const trustedEpubLocalPublicationRule = {
  capabilityId: localRecognizerCapability.capabilityId,
  capabilityVersion: localRecognizerCapability.capabilityVersion,
  ruleId: "epub.valid-single-publication-revision",
  ruleVersion: "1",
} as const;

export type EpubPublication = {
  readonly opfPath: string;
  readonly isbn13s: readonly string[];
  readonly isbn13Identifiers: readonly {
    readonly value: string;
    readonly locators: readonly [string, ...string[]];
  }[];
  readonly invalidIsbnCount: number;
  readonly title?: string;
  readonly contributors: readonly string[];
  readonly contributorFacts: readonly {
    readonly role: "creator" | "contributor";
    readonly declaredRole?: LocatedText;
    readonly value: string;
    readonly locator: string;
  }[];
  readonly language?: string;
  readonly publisherFacts: readonly LocatedText[];
  readonly dateFacts: readonly LocatedText[];
  readonly collectionFacts: readonly {
    readonly sourceKey: string;
    readonly value: string;
    readonly locator: string;
    readonly groupPosition?: LocatedText;
  }[];
  readonly cover?: {
    readonly locator: string;
    readonly entryPath: string;
    readonly mediaType: string;
  };
};

type LocatedText = { readonly value: string; readonly locator: string };

/** 解析应用层已绑定观察者能力提供的字节。 */
export function inspectEpubPublication(bytes: Uint8Array): EpubPublication {
  const archive = new ZipArchive(bytes);
  const container = archive.text("META-INF/container.xml");
  requireClosedXmlRoot(container, "container");
  requireClosedXmlRoot(container, "rootfiles");
  const rootfilesBody = container.match(
    /<rootfiles\b[^>]*>([\s\S]*?)<\/rootfiles\s*>/iu,
  )?.[1];
  if (rootfilesBody === undefined)
    throw new Error("EPUB container rootfiles wrapper is malformed");
  const rootfiles = [...rootfilesBody.matchAll(/<rootfile\b[^>]*>/giu)];
  if (rootfiles.length !== 1)
    throw new Error("EPUB container must declare one OPF rootfile");
  const rootfilePaths = [
    ...rootfiles[0]![0].matchAll(/\bfull-path\s*=\s*(["'])(.*?)\1/giu),
  ];
  if (rootfilePaths.length !== 1)
    throw new Error("EPUB container has no OPF rootfile");
  const rootfile = decodeXml(rootfilePaths[0]![2]!);
  const opf = archive.text(rootfile);
  requireClosedXmlRoot(opf, "package");
  const title = firstElementText(opf, "dc:title");
  const contributorFacts = [
    ...elementFacts(opf, "dc:creator", rootfile).map((fact) => ({
      role: "creator" as const,
      value: fact.value,
      locator: fact.locator,
      ...declaredContributorRole(opf, rootfile, fact),
    })),
    ...elementFacts(opf, "dc:contributor", rootfile).map((fact) => ({
      role: "contributor" as const,
      value: fact.value,
      locator: fact.locator,
      ...declaredContributorRole(opf, rootfile, fact),
    })),
  ];
  const contributors = contributorFacts.map((item) => item.value);
  const language = firstElementText(opf, "dc:language");
  const publisherFacts = elementFacts(opf, "dc:publisher", rootfile);
  const dateFacts = elementFacts(opf, "dc:date", rootfile);
  const collectionFacts = metaElements(opf)
    .filter(
      (meta) => attribute(meta.tag, "property") === "belongs-to-collection",
    )
    .flatMap((meta, index) => {
      const id = attribute(meta.tag, "id");
      if (meta.value === undefined) return [];
      const groupPosition =
        id === undefined ? undefined : refinedMeta(opf, id, "group-position");
      return [
        {
          sourceKey: id ?? `mention-${index + 1}`,
          value: meta.value,
          locator:
            id === undefined
              ? `epub:${rootfile}#/metadata/meta[@property='belongs-to-collection'][${index + 1}]`
              : metaLocator(rootfile, `@id='${id}'`, "belongs-to-collection"),
          ...(groupPosition === undefined
            ? {}
            : {
                groupPosition: {
                  value: groupPosition,
                  locator: metaLocator(
                    rootfile,
                    `@refines='#${id}'`,
                    "group-position",
                  ),
                },
              }),
        },
      ];
    });
  const isbnIdentifiers = isbnIdentifierFacts(opf, rootfile);
  const isbn13Locators = new Map<string, string[]>();
  for (const identifier of isbnIdentifiers) {
    if (!identifier.valid) continue;
    const locators = isbn13Locators.get(identifier.value) ?? [];
    if (!locators.includes(identifier.locator))
      locators.push(identifier.locator);
    isbn13Locators.set(identifier.value, locators);
  }
  const isbn13Identifiers = [...isbn13Locators].map(([value, locators]) => ({
    value,
    locators: [locators[0]!, ...locators.slice(1)] as const,
  }));
  const isbn13s = isbn13Identifiers.map((identifier) => identifier.value);
  const manifest = manifestItems(opf);
  const coverDeclarations = [
    ...metaElements(opf).flatMap((meta) => {
      if (attribute(meta.tag, "name") !== "cover" || meta.value === undefined)
        return [];
      return [
        {
          id: meta.value,
          selector: `/metadata/meta[@name='cover'][@content='${meta.value}']->manifest/item[@id='${meta.value}']`,
        },
      ];
    }),
    ...manifest.flatMap((item) =>
      /(?:^|\s)cover-image(?:\s|$)/u.test(item.properties ?? "")
        ? [
            {
              id: item.id,
              selector: `/manifest/item[@id='${item.id}'][@properties~='cover-image']`,
            },
          ]
        : [],
    ),
  ];
  const coverDeclaration =
    coverDeclarations.length === 1 ? coverDeclarations[0] : undefined;
  const coverItems =
    coverDeclaration === undefined
      ? []
      : manifest.filter((item) => item.id === coverDeclaration.id);
  const coverItem = coverItems.length === 1 ? coverItems[0] : undefined;
  const coverEntry =
    coverItem === undefined ? undefined : resolveHref(rootfile, coverItem.href);
  const cover =
    coverDeclaration === undefined ||
    coverItem === undefined ||
    coverEntry === undefined ||
    !archive.has(coverEntry)
      ? undefined
      : {
          locator: `epub:${rootfile}#${coverDeclaration.selector}->entry:${coverEntry}`,
          entryPath: coverEntry,
          mediaType: coverItem.mediaType,
        };
  return {
    opfPath: rootfile,
    isbn13s,
    isbn13Identifiers,
    invalidIsbnCount: isbnIdentifiers.filter((identifier) => !identifier.valid)
      .length,
    ...(title === undefined ? {} : { title }),
    contributors,
    contributorFacts,
    ...(language === undefined ? {} : { language }),
    publisherFacts,
    dateFacts,
    collectionFacts,
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
    return [
      {
        kind: "artifact-format-inspection",
        explanation: inspectionExplanation(publication),
        producer: this.capability,
        inspection: {
          identifiers: publication.isbn13Identifiers.map((identifier) => ({
            scheme: "isbn-13",
            value: identifier.value,
            locators: identifier.locators,
          })),
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
                    locator: elementLocator(publication.opfPath, "dc:title", 1),
                  },
                ]),
            ...(publication.language === undefined
              ? []
              : [
                  {
                    property: "asset.declared-language",
                    sourceSlot: "opf.language",
                    value: publication.language,
                    locator: elementLocator(
                      publication.opfPath,
                      "dc:language",
                      1,
                    ),
                  },
                ]),
            ...publication.contributorFacts.map((item, index) => ({
              property: "book.contributor",
              sourceSlot: `opf.${item.role}.${indexWithinRole(publication.contributorFacts, index)}`,
              value: item.value,
              locator: item.locator,
            })),
            ...publication.contributorFacts.flatMap((item, index) =>
              item.declaredRole === undefined
                ? []
                : [
                    {
                      property: "book.contributor-role",
                      sourceSlot: `opf.${item.role}.${indexWithinRole(publication.contributorFacts, index)}.role`,
                      value: item.declaredRole.value,
                      locator: item.declaredRole.locator,
                    },
                  ],
            ),
            ...publication.publisherFacts.map((item, index) => ({
              property: "book.publisher",
              sourceSlot: `opf.publisher.${index + 1}`,
              value: item.value,
              locator: item.locator,
            })),
            ...publication.dateFacts.map((item, index) => ({
              property: "book.publication-date",
              sourceSlot: `opf.date.${index + 1}`,
              value: item.value,
              locator: item.locator,
            })),
            ...publication.collectionFacts.flatMap((item) => [
              {
                property: "book.collection-mention",
                sourceSlot: `opf.collection.${item.sourceKey}`,
                value: item.value,
                locator: item.locator,
              },
              ...(item.groupPosition === undefined
                ? []
                : [
                    {
                      property: "book.collection-group-position",
                      sourceSlot: `opf.collection.${item.sourceKey}.group-position`,
                      value: item.groupPosition.value,
                      locator: item.groupPosition.locator,
                    },
                  ]),
            ]),
          ],
          parts:
            publication.cover === undefined
              ? []
              : [
                  {
                    role: "asset.primary-cover",
                    locator: publication.cover.locator,
                    mediaType: publication.cover.mediaType,
                  },
                ],
        },
      },
    ];
  }
}

/** 无有效 ISBN 的单 EPUB 修订版只形成观察依据提案。 */
export class EpubLocalPublicationRecognizer implements Recognizer {
  readonly capability = localRecognizerCapability;

  canRecognize(input: RecognitionCandidateContext): boolean {
    if (input.basis.kind !== "observed-evidence") return false;
    if (
      !sameCapabilityCoordinate(input.basis.producer, directoryCapability) ||
      input.basis.artifactRevisions.length !== 1 ||
      input.evidence.length !== 1
    )
      return false;
    const evidence = input.evidence[0]!;
    const inspection = evidence.inspection;
    const revision = input.basis.artifactRevisions[0]!;
    return (
      evidence.kind === "artifact-format-inspection" &&
      sameCapabilityCoordinate(evidence.producer, directoryCapability) &&
      inspection !== undefined &&
      inspection.identifiers.filter(
        (identifier) =>
          identifier.scheme === "isbn-13" && isValidIsbn13(identifier.value),
      ).length === 0 &&
      revision.observedArtifactReference ===
        inspection.observedArtifactReference &&
      revision.blob.digest === inspection.revision.digest &&
      revision.blob.mediaType === inspection.revision.mediaType &&
      revision.blob.byteLength === inspection.revision.byteLength &&
      sameCapabilityCoordinate(revision.producer, directoryCapability)
    );
  }

  recognize(input: RecognitionCandidateContext): RecognitionProposalDraft {
    if (!this.canRecognize(input))
      throw new Error("EPUB 本地识别只接受无有效 ISBN 的单一出版物修订版");
    return {
      id: `recognition-proposal_${randomUUID()}`,
      ruleResults: [
        {
          ...trustedEpubLocalPublicationRule,
          outcome: "satisfied",
          explanation:
            "格式检查确认该单一 EPUB 修订版是无有效 ISBN 的独立本地出版物边界",
          evidence: input.evidence,
        },
      ],
    };
  }
}

function sameCapabilityCoordinate(
  actual: CapabilityCoordinate,
  expected: CapabilityCoordinate,
): boolean {
  return (
    actual.capabilityId === expected.capabilityId &&
    actual.capabilityVersion === expected.capabilityVersion &&
    actual.contractVersion === expected.contractVersion &&
    actual.identity === expected.identity &&
    actual.implementationVersion === expected.implementationVersion &&
    actual.kind === expected.kind &&
    sameStrings(
      actual.interpretationContractVersions,
      expected.interpretationContractVersions,
    )
  );
}

function sameStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

/** 只有应用层提出请求后，才实体化 EPUB 内嵌封面。 */
export class EpubEmbeddedCoverAcquirer implements ObservedArtifactPartAcquirer {
  readonly capability = acquirerCapability;

  canAcquire(candidate: ObservedArtifactPartCandidate): boolean {
    return (
      candidate.role === "asset.primary-cover" &&
      sameCapabilityCoordinate(candidate.producer, directoryCapability) &&
      mediaTypeEssence(candidate.mediaType).startsWith("image/") &&
      candidate.locator.startsWith("epub:")
    );
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
    if (
      publication.cover === undefined ||
      publication.cover.locator !== input.candidate.locator
    )
      throw new Error("EPUB no longer contains its declared cover");
    const archive = new ZipArchive(sourceBytes);
    const coverBytes = archive.bytes(publication.cover.entryPath);
    if (
      mediaTypeEssence(publication.cover.mediaType) !==
      mediaTypeEssence(input.candidate.mediaType)
    )
      throw new Error(
        "EPUB cover media type differs from the declared candidate",
      );
    return {
      candidateId: input.candidate.id,
      bytes: coverBytes,
      mediaType: input.candidate.mediaType,
      origin: {
        digest: createHash("sha256").update(sourceBytes).digest("hex"),
        mediaType: "application/epub+zip",
        byteLength: sourceBytes.byteLength,
      },
    };
  }
}

function indexWithinRole(
  facts: EpubPublication["contributorFacts"],
  index: number,
): number {
  return facts
    .slice(0, index + 1)
    .filter((item) => item.role === facts[index]!.role).length;
}

function elementLocator(opfPath: string, name: string, index: number): string {
  return `epub:${opfPath}#/metadata/${name}[${index}]`;
}

function elementFacts(
  source: string,
  name: string,
  opfPath: string,
): readonly (LocatedText & { readonly attributes: string })[] {
  return [
    ...source.matchAll(
      new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`, "giu"),
    ),
  ].flatMap((match, index) => {
    const value = decodeXml(match[2]!.replaceAll(/<[^>]+>/gu, "").trim());
    return value.length === 0
      ? []
      : [
          {
            value,
            attributes: match[1]!,
            locator: elementLocator(opfPath, name, index + 1),
          },
        ];
  });
}

function declaredContributorRole(
  opf: string,
  opfPath: string,
  fact: LocatedText & { readonly attributes: string },
): { readonly declaredRole?: LocatedText } {
  const opfRole = attribute(fact.attributes, "opf:role");
  if (opfRole !== undefined)
    return {
      declaredRole: { value: opfRole, locator: `${fact.locator}/@opf:role` },
    };
  const role = attribute(fact.attributes, "role");
  if (role !== undefined)
    return { declaredRole: { value: role, locator: `${fact.locator}/@role` } };
  const id = attribute(fact.attributes, "id");
  if (id === undefined) return {};
  const refined = refinedMeta(opf, id, "role");
  return refined === undefined
    ? {}
    : {
        declaredRole: {
          value: refined,
          locator: metaLocator(opfPath, `@refines='#${id}'`, "role"),
        },
      };
}

function metaElements(
  opf: string,
): readonly { readonly tag: string; readonly value?: string }[] {
  return [...opf.matchAll(/<meta\b([^>]*?)(?:\/>|>([\s\S]*?)<\/meta>)/giu)].map(
    (match) => {
      const tag = `<meta${match[1]!}>`;
      const body = decodeXml(
        (match[2] ?? "").replaceAll(/<[^>]+>/gu, "").trim(),
      );
      const content = attribute(tag, "content");
      const value = body || content;
      return value === undefined || value.length === 0
        ? { tag }
        : { tag, value };
    },
  );
}

function refinedMeta(
  opf: string,
  id: string,
  property: string,
): string | undefined {
  return metaElements(opf).find(
    (meta) =>
      attribute(meta.tag, "refines") === `#${id}` &&
      attribute(meta.tag, "property") === property,
  )?.value;
}

function metaLocator(
  opfPath: string,
  selector: string,
  property: string,
): string {
  return `epub:${opfPath}#/metadata/meta[${selector}][@property='${property}']`;
}

function inspectionExplanation(publication: EpubPublication): string {
  if (publication.isbn13s.length > 1)
    return `本地格式检查发现 ${publication.isbn13s.length} 个冲突的有效 ISBN-13`;
  if (publication.isbn13s.length === 1)
    return "本地格式检查发现唯一有效 ISBN-13";
  if (publication.invalidIsbnCount > 0)
    return `本地格式检查确认有效 EPUB，并拒绝 ${publication.invalidIsbnCount} 个无效 ISBN`;
  return "本地格式检查确认有效 EPUB，但没有声明 ISBN";
}

function isbnIdentifierFacts(
  opf: string,
  opfPath: string,
): readonly {
  readonly value: string;
  readonly valid: boolean;
  readonly locator: string;
}[] {
  return [
    ...opf.matchAll(/<dc:identifier\b([^>]*)>([\s\S]*?)<\/dc:identifier>/giu),
  ].flatMap((match, index) => {
    const identifierId = attribute(match[1], "id");
    const explicitScheme =
      attribute(match[1], "opf:scheme") ?? attribute(match[1], "scheme");
    if (
      explicitScheme !== undefined &&
      !/^isbn(?:-13)?$/iu.test(explicitScheme)
    )
      return [];
    const refinedTypes =
      identifierId === undefined
        ? []
        : refinedMetaValues(opf, identifierId, "identifier-type");
    if (
      refinedTypes.length > 0 &&
      !refinedTypes.every((value) => /^isbn(?:-13)?$/iu.test(value))
    )
      return [];
    const value = supportedIsbn13Lexeme(
      decodeXml(match[2]!.replaceAll(/<[^>]+>/gu, "").trim()),
    );
    return [
      {
        value: value ?? "",
        valid: value !== undefined && isValidIsbn13(value),
        locator: elementLocator(opfPath, "dc:identifier", index + 1),
      },
    ];
  });
}

function refinedMetaValues(
  opf: string,
  id: string,
  property: string,
): readonly string[] {
  return metaElements(opf).flatMap((meta) =>
    attribute(meta.tag, "refines") === `#${id}` &&
    attribute(meta.tag, "property") === property
      ? [meta.value ?? ""]
      : [],
  );
}

function supportedIsbn13Lexeme(value: string): string | undefined {
  const match =
    /^(?:ISBN(?:-13)?(?:\s*:\s*|\s+))?(97[89](?:[ -]?\d){10})$/iu.exec(value);
  return match?.[1]?.replaceAll(/[ -]/gu, "");
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

function requireClosedXmlRoot(source: string, name: string): void {
  const openings = [...source.matchAll(new RegExp(`<${name}\\b[^>]*>`, "giu"))];
  const closings = [...source.matchAll(new RegExp(`</${name}\\s*>`, "giu"))];
  if (
    openings.length !== 1 ||
    closings.length !== 1 ||
    closings[0]!.index <= openings[0]!.index
  )
    throw new Error(`EPUB ${name} XML root is malformed`);
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
      if (this.entries.has(name))
        throw new Error("EPUB ZIP contains a duplicate archive member");
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

  has(name: string): boolean {
    return this.entries.has(name);
  }

  bytes(name: string): Uint8Array {
    return this.bytesFor(name);
  }

  private bytesFor(name: string): Uint8Array {
    const entry = this.entries.get(name);
    if (entry === undefined)
      throw new Error(`EPUB archive member is absent: ${name}`);
    if (entry.uncompressedSize > maximumArchiveMemberBytes)
      throw new Error("EPUB archive member exceeds inspection limit");
    if (
      entry.method === 8 &&
      (entry.compressedSize === 0
        ? entry.uncompressedSize > 0
        : entry.uncompressedSize / entry.compressedSize >
          maximumDeflateCompressionRatio)
    )
      throw new Error("EPUB archive member exceeds compression ratio limit");
    const offset = entry.localOffset;
    if (readU32(this.archiveBytes, offset) !== 0x04034b50)
      throw new Error("EPUB ZIP local header is invalid");
    const flags = readU16(this.archiveBytes, offset + 6);
    const nameLength = readU16(this.archiveBytes, offset + 26);
    const extraLength = readU16(this.archiveBytes, offset + 28);
    const localName = decodeZipName(
      this.archiveBytes.subarray(offset + 30, offset + 30 + nameLength),
      flags,
    );
    if (localName !== name)
      throw new Error("EPUB ZIP local and central member names disagree");
    const raw = this.archiveBytes.subarray(
      offset + 30 + nameLength + extraLength,
      offset + 30 + nameLength + extraLength + entry.compressedSize,
    );
    const unpacked =
      entry.method === 0
        ? raw
        : entry.method === 8
          ? new Uint8Array(
              inflateRawSync(raw, {
                maxOutputLength: Math.max(1, entry.uncompressedSize),
              }),
            )
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
