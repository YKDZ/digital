import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  type SourceAddressingCapability,
  type SourceArtifactAcquirer,
  type SourceCollectionFailure,
  type SourceCollectionResult,
  type SourceCollector,
  type SourceInterpreter,
  type SourceAssociationInterpreter,
  type StagedSourceArtifact,
} from "@digital/application";
import type {
  CapabilityCoordinate,
  EntityMention,
  EntityResolutionDecision,
  ProposedEntityRelationship,
  RecognitionEvidence,
  SourcedEntity,
  SourceRecord,
} from "@digital/domain";
import { parse } from "parse5";

const productOrigin = "https://www.kadokawa.com.tw";
const sourceIdentity = "taiwan-kadokawa";
const maximumPageBytes = 2 * 1024 * 1024;
const maximumCoverBytes = 20 * 1024 * 1024;

const addressingCapability = declareCapability({
  identity: "taiwan-kadokawa.explicit-isbn-addressing",
  implementationVersion: "1",
  kind: "source-addressing",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const collectorCapability = declareCapability({
  identity: "taiwan-kadokawa.official-product-collection",
  implementationVersion: "1",
  kind: "source-collector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const interpreterCapability = declareCapability({
  identity: "taiwan-kadokawa.product-interpretation",
  implementationVersion: "1",
  kind: "source-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const associationCapability = declareCapability({
  identity: "taiwan-kadokawa.isbn-association-interpretation",
  implementationVersion: "1",
  kind: "source-association-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const acquirerCapability = declareCapability({
  identity: "taiwan-kadokawa.source-artifact-acquirer",
  implementationVersion: "1",
  kind: "source-artifact-acquirer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

type Request = (input: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type TaiwanKadokawaPorts = {
  readonly sourceAddressing: SourceAddressingCapability;
  readonly collector: SourceCollector;
  readonly interpreter: SourceInterpreter;
  readonly associationInterpreter: SourceAssociationInterpreter;
  readonly artifactAcquirer: SourceArtifactAcquirer;
};

/** 建立固定配套的台湾角川来源能力；页面语法和 HTTP 细节不越过此集成。 */
export function createTaiwanKadokawaSource(
  options: {
    readonly request?: Request;
  } = {},
): TaiwanKadokawaPorts {
  const request = options.request ?? fetch;
  const sourceAddressing: SourceAddressingCapability = {
    capability: addressingCapability,
    inputRequirement: {
      sourceIdentity,
      displayName: "台灣角川",
      fields: [
        {
          key: "isbn",
          label: "ISBN",
          required: true,
          acceptedInput: "台灣角川 ISBN-13 編號",
          example: "9789577435064",
        },
      ],
    },
    normalize(input) {
      if (!sameStrings(Object.keys(input), ["isbn"]))
        return { status: "invalid", reason: "台灣角川來源輸入包含未知欄位" };
      const isbn = taiwanIsbn(input.isbn);
      if (isbn === undefined)
        return { status: "invalid", reason: "請輸入有效的台灣 ISBN-13 編號" };
      return {
        status: "accepted",
        normalizedInput: { isbn },
        evidence: {
          kind: "directed-source-address",
          sourceIdentity,
          sourceAddress: productAddress(isbn),
          explanation: "使用者明確指定台灣角川 ISBN",
          producer: addressingCapability,
        },
      };
    },
  };
  const collector: SourceCollector = {
    capability: collectorCapability,
    canCollect(evidence) {
      return sourceAddressFromEvidence(evidence) !== undefined;
    },
    coverageScopeIds(evidence) {
      return sourceAddressFromEvidence(evidence) === undefined
        ? []
        : ["taiwan-kadokawa.product-page"];
    },
    async collect(evidence): Promise<SourceCollectionResult> {
      const address = sourceAddressFromEvidence(evidence);
      if (address === undefined)
        return collectionFailure("台灣角川採集需要已驗證的產品地址");
      let response: Awaited<ReturnType<Request>>;
      try {
        response = await request(address);
      } catch {
        return collectionFailure("台灣角川產品頁請求失敗");
      }
      if (!response.ok)
        return collectionFailure(`台灣角川產品頁 HTTP ${response.status}`);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        return collectionFailure("台灣角川產品頁回應讀取失敗");
      }
      if (bytes.byteLength === 0 || bytes.byteLength > maximumPageBytes)
        return collectionFailure("台灣角川產品頁回應不符合保存限制");
      if (!isHtml(response.headers.get("content-type")))
        return collectionFailure("台灣角川產品頁不是 HTML 回應");
      const finalAddress = canonicalProductAddress(response.url);
      if (finalAddress === undefined || finalAddress !== address)
        return collectionFailure("台灣角川產品頁重新導向到不同產品地址");
      return {
        records: [
          {
            id: `source-record_taiwan-kadokawa_${randomUUID()}`,
            sourceIdentity,
            nativeAddress: address,
            mediaType: "text/html",
            acquiredAt: new Date().toISOString(),
            acquisition: {
              requestedAddress: address,
              method: "GET",
              authorized: false,
            },
            coverage: {
              id: "taiwan-kadokawa.product-page",
              completeness: "complete",
              authority: "official",
            },
            digest: createHash("sha256").update(bytes).digest("hex"),
            body: new TextDecoder().decode(bytes),
            producer: collectorCapability,
          },
        ],
        failures: [],
      };
    },
  };
  const interpreter: SourceInterpreter = {
    relationshipDefinitions: [
      {
        id: "taiwan-kadokawa.contribution",
        type: "asset.contribution",
        label: "图书署名（台湾角川）",
        roles: [
          { role: "asset", label: "作品", minimum: 1, maximum: 1 },
          { role: "book.contributor", label: "署名者", minimum: 1 },
        ],
        qualifiers: [],
      },
    ],
    capability: interpreterCapability,
    canInterpret(input) {
      return (
        requestedAddress(input.evidence) !== undefined &&
        officialRecord(input.sourceRecords) !== undefined
      );
    },
    interpret(input) {
      const address = requestedAddress(input.evidence);
      const record = officialRecord(input.sourceRecords);
      if (
        address === undefined ||
        record === undefined ||
        record.nativeAddress !== address
      )
        throw new Error("台灣角川解釋需要一條同地址完整官方產品頁記錄");
      const page = readProductPage(record.body, address);
      const metadata = [
        assertion(
          "book.isbn-13",
          "taiwan-kadokawa.isbn-13",
          isbnFromAddress(address)!,
          record.id,
        ),
        assertion(
          "asset.title",
          "taiwan-kadokawa.product.name",
          page.name,
          record.id,
        ),
        assertion(
          "book.publisher",
          "taiwan-kadokawa.publisher",
          "台灣角川",
          record.id,
        ),
      ];
      const description = descriptionFacts(page.description);
      const entities: SourcedEntity[] = [];
      const entityMentions: EntityMention[] = [];
      const entityResolutionDecisions: EntityResolutionDecision[] = [];
      const relationships: ProposedEntityRelationship[] = [];
      if (description !== undefined) {
        for (const [index, contributor] of description.contributors.entries()) {
          const slot = `taiwan-kadokawa.contributor.${index + 1}`;
          const sourceKey = `${address}\u0000${slot}`;
          const identityNamespace =
            "taiwan-kadokawa.contributor.occurrence-local";
          const entityId = relatedEntityId(identityNamespace, sourceKey);
          const mentionId = relatedEntityId("mention", sourceKey);
          entities.push({
            id: entityId,
            kind: "entity",
            sourceIdentity,
            sourceKey,
            identityNamespace,
            label: contributor,
            sourceRecordIds: [record.id],
          });
          entityMentions.push({
            id: mentionId,
            sourceRecordIds: [record.id],
            sourceIdentity,
            field: "book.contributor",
            role: "book.contributor",
            label: contributor,
            identityNamespace,
            sourceKey,
          });
          entityResolutionDecisions.push({
            id: relatedEntityId("resolution", mentionId),
            mentionId,
            entityId,
            rule: "source-field-role-exact",
            sourceRecordIds: [record.id],
          });
          relationships.push({
            participants: [
              {
                entityId,
                role: "book.contributor",
                mentionIds: [mentionId],
              },
            ],
            subjectRole: "asset",
            requiredRoles: ["asset", "book.contributor"],
            type: "asset.contribution",
            sourceSlot: slot,
            sourceRecordIds: [record.id],
          });
          metadata.push(
            assertion("book.contributor", slot, contributor, record.id),
          );
        }
        metadata.push(
          assertion(
            "book.publication-date",
            "taiwan-kadokawa.publication-date",
            description.date,
            record.id,
          ),
        );
        metadata.push(
          assertion(
            "asset.introduction",
            "taiwan-kadokawa.introduction",
            description.introduction,
            record.id,
          ),
        );
      }
      return [
        {
          id: `source-interpretation_${randomUUID()}`,
          producer: interpreterCapability,
          sourceRecordIds: [record.id],
          sourceIdentity,
          sourceAddress: address,
          metadata,
          ...(entities.length === 0 ? {} : { entities }),
          ...(entityMentions.length === 0 ? {} : { entityMentions }),
          ...(entityResolutionDecisions.length === 0
            ? {}
            : { entityResolutionDecisions }),
          ...(relationships.length === 0 ? {} : { relationships }),
          sourceArtifacts:
            page.image === undefined
              ? []
              : [
                  {
                    id: `taiwan-kadokawa-cover_${randomUUID()}`,
                    sourceRecordId: record.id,
                    role: "asset.primary-cover",
                    acquisitionReference: page.image,
                    mediaType: "image/jpeg",
                    producer: interpreterCapability,
                  },
                ],
        },
      ];
    },
  };
  const associationInterpreter: SourceAssociationInterpreter = {
    capability: associationCapability,
    canInterpret({ evidence, interpretation }) {
      return (
        sourceAddressFromEvidence(evidence) === interpretation.sourceAddress &&
        interpretation.sourceIdentity === sourceIdentity &&
        canonicalProductAddress(interpretation.sourceAddress) ===
          interpretation.sourceAddress
      );
    },
    interpret({ subject, evidence, interpretation }) {
      if (!this.canInterpret({ evidence, interpretation })) return undefined;
      if (sourceAddressFromEvidence(evidence) !== interpretation.sourceAddress)
        return undefined;
      const isbn = isbnFromAddress(interpretation.sourceAddress);
      if (isbn === undefined) return undefined;
      const existing = [
        ...new Set(
          subject.metadata
            .filter((fact) => fact.property === "book.isbn-13")
            .map((fact) => isbn13(String(fact.value)))
            .filter((value): value is string => value !== undefined),
        ),
      ];
      return existing.every((value) => value === isbn)
        ? {
            status: "accepted",
            explanation: "台灣角川 ISBN 與目前主體無衝突",
          }
        : {
            status: "contradicted",
            explanation: "台灣角川 ISBN 與目前主體已有 ISBN 衝突",
          };
    },
  };
  const artifactAcquirer: SourceArtifactAcquirer = {
    capability: acquirerCapability,
    canAcquire(candidate) {
      return (
        candidate.id.startsWith("taiwan-kadokawa-cover_") &&
        candidate.mediaType === "image/jpeg" &&
        candidate.producer !== undefined &&
        sameCapability(candidate.producer, interpreterCapability) &&
        coverAddress(candidate.acquisitionReference)
      );
    },
    async acquire(candidate): Promise<StagedSourceArtifact> {
      if (!this.canAcquire(candidate)) throw new Error("台灣角川封面候選無效");
      let response: Awaited<ReturnType<Request>>;
      try {
        response = await request(candidate.acquisitionReference);
      } catch {
        throw new Error("台灣角川封面請求失敗");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        response.status < 200 ||
        response.status >= 300 ||
        !isJpeg(response.headers.get("content-type")) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > maximumCoverBytes
      )
        throw new Error("台灣角川封面回應不符合獲取限制");
      return {
        candidateId: candidate.id,
        sourceRecordId: candidate.sourceRecordId,
        bytes,
        mediaType: "image/jpeg",
      };
    },
  };
  return {
    sourceAddressing,
    collector,
    interpreter,
    associationInterpreter,
    artifactAcquirer,
  };
}

function relatedEntityId(namespace: string, value: string): string {
  return `entity_${createHash("sha256")
    .update(`${namespace}\u0000${value}`)
    .digest("hex")}`;
}

function sourceAddressFromEvidence(
  evidence: RecognitionEvidence,
): string | undefined {
  if (
    evidence.sourceIdentity !== sourceIdentity ||
    evidence.sourceAddress === undefined
  )
    return undefined;
  if (evidence.kind === "source-association")
    return canonicalProductAddress(evidence.sourceAddress);
  return evidence.kind === "directed-source-address" &&
    sameCapability(evidence.producer, addressingCapability)
    ? canonicalProductAddress(evidence.sourceAddress)
    : undefined;
}

function requestedAddress(
  evidence: readonly RecognitionEvidence[],
): string | undefined {
  const addresses = [
    ...new Set(
      evidence.flatMap((item) => {
        const address = sourceAddressFromEvidence(item);
        return address === undefined ? [] : [address];
      }),
    ),
  ];
  return addresses.length === 1 ? addresses[0] : undefined;
}

function officialRecord(
  records: readonly SourceRecord[],
): SourceRecord | undefined {
  const recordsForSource = records.filter(
    (record) =>
      record.sourceIdentity === sourceIdentity &&
      record.coverage.id === "taiwan-kadokawa.product-page" &&
      record.coverage.completeness === "complete" &&
      record.coverage.authority === "official" &&
      record.mediaType === "text/html" &&
      record.producer !== undefined &&
      sameCapability(record.producer, collectorCapability),
  );
  return recordsForSource.length === 1 ? recordsForSource[0] : undefined;
}

function productAddress(isbn: string): string {
  return `${productOrigin}/products/${isbn}`;
}

function canonicalProductAddress(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.kadokawa.com.tw" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return undefined;
    const match = /^\/products\/(978(?:957|986)\d{7})$/u.exec(url.pathname);
    return match === null || !isIsbn13(match[1]!)
      ? undefined
      : productAddress(match[1]!);
  } catch {
    return undefined;
  }
}

function isbnFromAddress(address: string): string | undefined {
  return /^https:\/\/www\.kadokawa\.com\.tw\/products\/(978(?:957|986)\d{7})$/u.exec(
    address,
  )?.[1];
}

function taiwanIsbn(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const stripped = value.startsWith("ISBN") ? value.slice(4) : value;
  if (!/^[0-9 -]+$/u.test(stripped)) return undefined;
  const isbn = stripped.replaceAll(/[ -]/gu, "");
  if (!/^978(?:957|986)\d{7}$/u.test(isbn)) return undefined;
  return isIsbn13(isbn) ? isbn : undefined;
}

function isbn13(value: string): string | undefined {
  const stripped = value
    .replace(/^ISBN(?:-13)?\s*:?\s*/iu, "")
    .replaceAll(/[ -]/gu, "");
  return isIsbn13(stripped) ? stripped : undefined;
}

function isIsbn13(value: string): boolean {
  if (!/^97[89]\d{10}$/u.test(value)) return false;
  const total = value
    .slice(0, 12)
    .split("")
    .reduce(
      (sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0,
    );
  return (10 - (total % 10)) % 10 === Number(value[12]);
}

function collectionFailure(reason: string): SourceCollectionResult {
  const failure: SourceCollectionFailure = {
    capability: collectorCapability,
    reason,
  };
  return { records: [], failures: [failure] };
}

function assertion(
  property: string,
  sourceSlot: string,
  value: string,
  sourceRecordId: string,
) {
  return { property, sourceSlot, value, sourceRecordIds: [sourceRecordId] };
}

type Node = {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly Node[];
  readonly value?: string;
};

function readProductPage(
  html: string,
  address: string,
): {
  readonly name: string;
  readonly description?: string;
  readonly image?: string;
} {
  const document = parse(html) as unknown as Node;
  const elements = descendants(document);
  const canonicals = elements
    .filter(
      (node) =>
        node.tagName === "link" && attribute(node, "rel") === "canonical",
    )
    .map((node) => attribute(node, "href"))
    .filter((value): value is string => value !== undefined);
  if (
    canonicals.length !== 1 ||
    canonicalProductAddress(canonicals[0]!) !== address
  )
    throw new Error("台灣角川產品頁 canonical 地址無效");
  const jsonLd = elements
    .filter(
      (node) =>
        node.tagName === "script" &&
        mediaType(attribute(node, "type")) === "application/ld+json",
    )
    .map((node) => JSON.parse(text(node)) as unknown);
  const products = jsonLd.flatMap((value) => typedJsonLd(value, "Product"));
  const organizations = jsonLd.flatMap((value) =>
    typedJsonLd(value, "Organization"),
  );
  if (
    products.length !== 1 ||
    organizations.length !== 1 ||
    requiredString(organizations[0]?.name) !== "台灣角川"
  )
    throw new Error("台灣角川產品頁 JSON-LD 結構無效");
  const product = products[0]!;
  const name = requiredString(product.name);
  const sku = requiredString(product.sku);
  const description = optionalString(product.description);
  if (name === undefined || sku === undefined)
    throw new Error("台灣角川產品頁缺少必要 Product 欄位");
  const image = validProductImage(product.image) ? product.image[0] : undefined;
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(image === undefined ? {} : { image }),
  };
}

function descendants(root: Node): readonly Node[] {
  const found: Node[] = [];
  const visit = (node: Node) => {
    found.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return found;
}

function attribute(node: Node, name: string): string | undefined {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function text(node: Node): string {
  return (
    node.childNodes?.map((child) => child.value ?? text(child)).join("") ??
    node.value ??
    ""
  );
}

function typedJsonLd(
  value: unknown,
  type: "Product" | "Organization",
): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [];
  const record = value as Record<string, unknown>;
  return record["@type"] === type ? [record] : [];
}

function validProductImage(value: unknown): value is readonly [string] {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === "string" &&
    coverAddress(value[0])
  );
}

function descriptionFacts(value: string | undefined):
  | {
      readonly contributors: readonly string[];
      readonly date: string;
      readonly introduction: string;
    }
  | undefined {
  if (value === undefined) return undefined;
  const matched =
    /^作者資訊：(?<contributors>.+?)上市日期：(?<date>\d{4}-\d{2}-\d{2})購買 BOOKWALKER 電子書試閱 BOOKWALKER 電子書(?<introduction>[\s\S]+)$/u.exec(
      value,
    );
  if (matched?.groups === undefined || !isIsoDate(matched.groups.date!))
    return undefined;
  const contributors = [
    ...new Set(
      matched.groups
        .contributors!.split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  ];
  const introduction = matched.groups.introduction!.trim();
  return contributors.length === 0 || introduction.length === 0
    ? undefined
    : { contributors, date: matched.groups.date!, introduction };
}

function isIsoDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function coverAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "img.shoplineapp.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      /^\/media\/image_clips\/[a-f0-9]{24}\/original\.jpg$/u.test(
        url.pathname,
      ) &&
      /^\d+$/u.test(url.search.slice(1)) &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isHtml(value: string | null): boolean {
  return mediaType(value) === "text/html";
}
function isJpeg(value: string | null): boolean {
  return mediaType(value) === "image/jpeg";
}
function mediaType(value: string | undefined | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}
function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
function sameCapability(
  left: CapabilityCoordinate,
  right: CapabilityCoordinate,
): boolean {
  return (
    left.capabilityId === right.capabilityId &&
    left.capabilityVersion === right.capabilityVersion &&
    left.contractVersion === right.contractVersion &&
    left.identity === right.identity &&
    left.implementationVersion === right.implementationVersion &&
    left.kind === right.kind &&
    sameStrings(
      left.interpretationContractVersions ?? [],
      right.interpretationContractVersions ?? [],
    )
  );
}
