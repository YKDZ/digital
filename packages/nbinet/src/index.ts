import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  type Recognizer,
  type RecognitionCandidateContext,
  type SourceAddressingCapability,
  type SourceCollectionResult,
  type SourceCollector,
  type SourceEnrichmentInput,
  type SourceInterpreter,
} from "@digital/application";
import type {
  CapabilityCoordinate,
  EntityMention,
  EntityResolutionDecision,
  ProposedEntityRelationship,
  RecognitionEvidence,
  RecognitionProposalDraft,
  SourcedEntity,
  SourceInterpretationBatch,
  SourceRecord,
} from "@digital/domain";

const maximumResponseBytes = 2 * 1024 * 1024;
const epubInspectorCapability = {
  capabilityId: "epub.publication-inspection",
  capabilityVersion: "2",
  contractVersion: "2",
  identity: "epub.publication-inspection",
  implementationVersion: "2",
  kind: "artifact-format-inspector",
  interpretationContractVersions: ["2"],
} as const satisfies CapabilityCoordinate;
const collectorCapability = declareCapability({
  identity: "nbinet.exact-isbn-collection",
  implementationVersion: "1",
  kind: "source-collector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const interpreterCapability = declareCapability({
  identity: "nbinet.exact-isbn-bibliographic-interpretation",
  implementationVersion: "1",
  kind: "source-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const recognizerCapability = declareCapability({
  identity: "nbinet.exact-isbn-recognizer",
  implementationVersion: "2",
  kind: "recognizer",
  contractVersion: "2",
  interpretationContractVersions: ["2"],
});
const addressingCapability = declareCapability({
  identity: "nbinet.explicit-isbn-addressing",
  implementationVersion: "1",
  kind: "source-addressing",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const associationInterpreterCapability = declareCapability({
  identity: "nbinet.exact-isbn-association-interpretation",
  implementationVersion: "1",
  kind: "source-association-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

export const trustedNbinetExactEpubIsbnRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "embedded-isbn-in-exact-official-record",
  ruleVersion: "2",
} as const;
export const trustedNbinetDirectedIsbnRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "directed-isbn-in-exact-official-record",
  ruleVersion: "1",
} as const;

type FetchLike = (input: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class NbinetSourceAddressing implements SourceAddressingCapability {
  readonly capability = addressingCapability;
  readonly inputRequirement = {
    sourceIdentity: "nbinet",
    displayName: "国家图书馆书目",
    fields: [
      {
        key: "isbn",
        label: "ISBN",
        required: true,
        acceptedInput: "ISBN-13 编号或国家图书馆完整书目地址",
        example: "9789864738281",
      },
    ],
  } as const;

  normalize(input: Readonly<Record<string, string>>) {
    if (Object.keys(input).some((key) => key !== "isbn"))
      return {
        status: "invalid" as const,
        reason: "国家图书馆来源输入包含未知字段",
      };
    const supplied = string(input.isbn);
    if (supplied === undefined)
      return {
        status: "invalid" as const,
        reason: "请输入 ISBN-13 编号或国家图书馆完整书目地址",
      };
    const isbn = supportedIsbn13Lexeme(supplied) ?? isbnFromAddress(supplied);
    if (isbn === undefined || !isValidIsbn13(isbn))
      return {
        status: "invalid" as const,
        reason: "ISBN-13 编号或国家图书馆书目地址无效",
      };
    const sourceAddress = canonicalIsbnAddress(isbn);
    return {
      status: "accepted" as const,
      normalizedInput: { isbn },
      evidence: {
        kind: "directed-source-address",
        sourceIdentity: "nbinet",
        sourceAddress,
        explanation: "用户明确指定国家图书馆 ISBN",
        producer: this.capability,
      },
    };
  }
}

export class NbinetCollector implements SourceCollector {
  readonly capability = collectorCapability;
  private readonly request: FetchLike;

  constructor(request: FetchLike = fetch) {
    this.request = request;
  }

  canCollect(evidence: RecognitionEvidence): boolean {
    return isbnFromEvidence(evidence) !== undefined;
  }

  coverageScopeIds(evidence: RecognitionEvidence): readonly string[] {
    return this.canCollect(evidence) ? ["nbinet.exact-isbn"] : [];
  }

  async collect(
    evidence: RecognitionEvidence,
  ): Promise<SourceCollectionResult> {
    if (!this.canCollect(evidence))
      return {
        records: [],
        failures: [
          {
            capability: this.capability,
            reason:
              "NBINet collection requires exactly one unique valid ISBN in one EPUB inspection（单一唯一有效 ISBN）",
          },
        ],
      };
    const isbn = isbnFromEvidence(evidence)!;
    const requestedAddress = publicApiAddress(isbn);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.request(requestedAddress);
    } catch (error) {
      throw new Error(`国家图书馆书目请求失败：${message(error)}`, {
        cause: error,
      });
    }
    if (!response.ok)
      throw new Error(`国家图书馆书目请求失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes)
      throw new Error("国家图书馆书目响应不符合保存限制");
    const body = new TextDecoder().decode(bytes);
    JSON.parse(body);
    return {
      records: [
        {
          id: `source-record_nbinet_${randomUUID()}`,
          sourceIdentity: "nbinet",
          nativeAddress: canonicalIsbnAddress(isbn),
          mediaType: response.headers.get("content-type") ?? "application/json",
          acquiredAt: new Date().toISOString(),
          acquisition: { requestedAddress, method: "GET", authorized: false },
          coverage: {
            id: "nbinet.exact-isbn",
            completeness: "complete",
            authority: "official",
          },
          digest: createHash("sha256").update(bytes).digest("hex"),
          body,
          producer: this.capability,
        },
      ],
      failures: [],
    };
  }
}

export class NbinetSourceInterpreter implements SourceInterpreter {
  readonly relationshipDefinitions = [
    {
      id: "nbinet.contribution",
      type: "asset.contribution",
      label: "图书署名（国家图书馆）",
      roles: [
        { role: "asset", label: "作品", minimum: 1, maximum: 1 },
        { role: "book.contributor", label: "署名者", minimum: 1 },
      ],
      qualifiers: [],
    },
  ];
  readonly capability = interpreterCapability;

  canInterpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): boolean {
    return (
      exactRequestedIsbn(input.evidence) !== undefined &&
      officialRecords(input.sourceRecords).length === 1
    );
  }

  interpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): readonly SourceInterpretationBatch[] {
    const isbn = exactRequestedIsbn(input.evidence);
    if (isbn === undefined)
      throw new Error("NBINet interpretation requires one exact ISBN evidence");
    const records = officialRecords(input.sourceRecords);
    if (records.length !== 1)
      throw new Error(
        "NBINet interpretation requires one unique official record with its exact producer coordinate and EPUB evidence",
      );
    const official = records[0]!;
    if (official.nativeAddress !== canonicalIsbnAddress(isbn))
      throw new Error("book source records disagree about the ISBN address");
    const bibliographic = exactBibliographicRecord(official.body, isbn);
    if (bibliographic === undefined)
      throw new Error("国家图书馆未返回包含该精确 ISBN 的唯一书目记录");
    const metadata = [
      assertion("book.isbn-13", "nbinet.isbn-13", isbn, official.id),
      ...bibliographic.titles.map((value, index) =>
        assertion(
          "asset.title",
          `nbinet.title.${index + 1}`,
          value,
          official.id,
        ),
      ),
      ...bibliographic.contributors.map((value, index) =>
        assertion(
          "book.contributor",
          `nbinet.contributor.${index + 1}`,
          value,
          official.id,
        ),
      ),
      ...bibliographic.publishers.map((value, index) =>
        assertion(
          "book.publisher",
          `nbinet.publisher.${index + 1}`,
          value,
          official.id,
        ),
      ),
      ...bibliographic.dates.map((value, index) =>
        assertion(
          "book.publication-date",
          `nbinet.date.${index + 1}`,
          value,
          official.id,
        ),
      ),
      ...bibliographic.languages.map((value, index) =>
        assertion(
          "asset.declared-language",
          `nbinet.language.${index + 1}`,
          value,
          official.id,
        ),
      ),
    ];
    const entities: SourcedEntity[] = [];
    const entityMentions: EntityMention[] = [];
    const entityResolutionDecisions: EntityResolutionDecision[] = [];
    const relationships: ProposedEntityRelationship[] = [];
    for (const [index, label] of bibliographic.contributors.entries()) {
      const slot = `nbinet.contributor.${index + 1}`;
      const sourceKey = `${official.nativeAddress}\u0000${slot}`;
      const identityNamespace = "nbinet.contributor.occurrence-local";
      const entityId = relatedEntityId(identityNamespace, sourceKey);
      const mentionId = relatedEntityId("mention", sourceKey);
      entities.push({
        id: entityId,
        kind: "entity",
        sourceIdentity: "nbinet",
        sourceKey,
        identityNamespace,
        label,
        sourceRecordIds: [official.id],
      });
      entityMentions.push({
        id: mentionId,
        sourceRecordIds: [official.id],
        sourceIdentity: "nbinet",
        field: "book.contributor",
        role: "book.contributor",
        label,
        identityNamespace,
        sourceKey,
      });
      entityResolutionDecisions.push({
        id: relatedEntityId("resolution", mentionId),
        mentionId,
        entityId,
        rule: "source-field-role-exact",
        sourceRecordIds: [official.id],
      });
      relationships.push({
        participants: [
          { entityId, role: "book.contributor", mentionIds: [mentionId] },
        ],
        subjectRole: "asset",
        requiredRoles: ["asset", "book.contributor"],
        type: "asset.contribution",
        sourceSlot: slot,
        sourceRecordIds: [official.id],
      });
    }
    return [
      {
        id: `source-interpretation_${randomUUID()}`,
        producer: this.capability,
        sourceRecordIds: [official.id],
        sourceIdentity: "nbinet",
        sourceAddress: canonicalIsbnAddress(isbn),
        metadata,
        ...(entities.length === 0 ? {} : { entities }),
        ...(entityMentions.length === 0 ? {} : { entityMentions }),
        ...(entityResolutionDecisions.length === 0
          ? {}
          : { entityResolutionDecisions }),
        ...(relationships.length === 0 ? {} : { relationships }),
        sourceArtifacts: [],
      },
    ];
  }
}

function relatedEntityId(namespace: string, value: string): string {
  return `entity_${createHash("sha256")
    .update(`${namespace}\u0000${value}`)
    .digest("hex")}`;
}

export class NbinetExactIsbnRecognizer implements Recognizer {
  readonly capability = recognizerCapability;
  canRecognize(input: RecognitionCandidateContext): boolean {
    if (input.basis.kind !== "source-interpretation") return false;
    const interpretation = input.basis.interpretation;
    return (
      interpretation.sourceIdentity === "nbinet" &&
      sameCapabilityCoordinate(interpretation.producer, interpreterCapability)
    );
  }
  recognize(input: RecognitionCandidateContext): RecognitionProposalDraft {
    if (
      input.basis.kind !== "source-interpretation" ||
      !this.canRecognize(input)
    )
      throw new Error(
        "国家图书馆识别器需要精确解释器 producer coordinate 的来源解释",
      );
    const isbn = isbnFromAddress(input.basis.interpretation.sourceAddress);
    const directed = input.evidence.some(
      (item) =>
        sameCapabilityCoordinate(item.producer, addressingCapability) &&
        isbnFromEvidence(item) === isbn,
    );
    const satisfied =
      isbn !== undefined &&
      input.evidence.some((item) => isbnFromEvidence(item) === isbn);
    return {
      id: `recognition-proposal_${randomUUID()}`,
      ruleResults: [
        {
          ...(directed
            ? trustedNbinetDirectedIsbnRule
            : trustedNbinetExactEpubIsbnRule),
          outcome: satisfied ? "satisfied" : "contradicted",
          explanation: satisfied
            ? directed
              ? "用户指定 ISBN 已在国家图书馆唯一书目记录中明确出现"
              : "EPUB 内嵌精确 ISBN 已在国家图书馆书目记录中明确出现"
            : "ISBN 与国家图书馆书目记录不一致",
          evidence: input.evidence.filter(
            (item) => isbnFromEvidence(item) === isbn,
          ),
        },
      ],
    };
  }
}

/** 已接受资产的显式 ISBN 只能在不与已有 ISBN 事实冲突时建立新来源关联。 */
export class NbinetSourceAssociationInterpreter {
  readonly capability = associationInterpreterCapability;

  canInterpret(input: {
    readonly evidence: RecognitionEvidence;
    readonly interpretation: SourceInterpretationBatch;
  }): boolean {
    return (
      input.evidence.sourceIdentity === "nbinet" &&
      input.interpretation.sourceIdentity === "nbinet"
    );
  }

  interpret(input: {
    readonly subject: SourceEnrichmentInput;
    readonly evidence: RecognitionEvidence;
    readonly interpretation: SourceInterpretationBatch;
  }) {
    const isbn = isbnFromAddress(input.interpretation.sourceAddress);
    if (
      isbn === undefined ||
      input.evidence.sourceAddress !== input.interpretation.sourceAddress
    )
      return undefined;
    const existing = [
      ...new Set(
        input.subject.metadata
          .filter((assertion) => assertion.property === "book.isbn-13")
          .map((assertion) => supportedIsbn13Lexeme(String(assertion.value)))
          .filter((value): value is string => value !== undefined),
      ),
    ];
    return existing.every((value) => value === isbn)
      ? {
          status: "accepted" as const,
          explanation: "明确 ISBN 与当前主体的身份证据无冲突",
        }
      : {
          status: "contradicted" as const,
          explanation: "明确 ISBN 与当前主体已有 ISBN 身份证据矛盾",
        };
  }
}

function assertion(
  property: string,
  sourceSlot: string,
  value: string,
  sourceRecordId: string,
) {
  return { property, sourceSlot, value, sourceRecordIds: [sourceRecordId] };
}

function exactBibliographicRecord(
  body: string,
  isbn: string,
):
  | {
      readonly titles: readonly string[];
      readonly contributors: readonly string[];
      readonly publishers: readonly string[];
      readonly dates: readonly string[];
      readonly languages: readonly string[];
    }
  | undefined {
  const parsed = JSON.parse(body) as { readonly docs?: unknown };
  const matches = (Array.isArray(parsed.docs) ? parsed.docs : []).flatMap(
    (doc) => {
      const record = doc as {
        readonly pnx?: {
          readonly display?: {
            readonly title?: unknown;
            readonly creator?: unknown;
            readonly publisher?: unknown;
            readonly creationdate?: unknown;
            readonly language?: unknown;
          };
          readonly addata?: { readonly isbn?: unknown };
        };
      };
      const identifiers = strings(record.pnx?.addata?.isbn).flatMap((value) => {
        const normalized = supportedIsbn13Lexeme(value);
        return normalized === undefined ? [] : [normalized];
      });
      if (!identifiers.includes(isbn)) return [];
      return [
        {
          titles: strings(record.pnx?.display?.title),
          contributors: strings(record.pnx?.display?.creator).flatMap(
            contributorDisplayClaims,
          ),
          publishers: strings(record.pnx?.display?.publisher),
          dates: strings(record.pnx?.display?.creationdate),
          languages: strings(record.pnx?.display?.language),
        },
      ];
    },
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** NBINet 的展示字段以 `$$Q` 附带权威检索形；逗号前各项才是独立署名。 */
function contributorDisplayClaims(value: string): readonly string[] {
  const [display] = value.split("$$Q", 1);
  return (display ?? "")
    .split("、")
    .map((claim) => claim.trim())
    .filter((claim) => claim.length > 0);
}

function canonicalIsbnAddress(isbn: string): string {
  const query = new URLSearchParams({
    inst: "886NCL_NBINET",
    vid: "886NCL_NBINET:NBINET",
    lang: "zh-tw",
    q: `isbn,exact,${isbn}`,
    scope: "MyInstitution",
    tab: "NBINET",
    skipDelivery: "Y",
  });
  return `https://nbinet.primo.exlibrisgroup.com/discovery/search?${query}`;
}

type FormatInspection = {
  readonly identifiers: readonly {
    readonly scheme: string;
    readonly value: string;
    readonly locators: readonly [string, ...string[]];
  }[];
  readonly observedArtifactReference: string;
  readonly revision: {
    readonly digest: string;
    readonly mediaType: string;
    readonly byteLength: number;
  };
  readonly metadata: readonly {
    readonly property: string;
    readonly sourceSlot: string;
    readonly value: string;
    readonly locator: string;
  }[];
  readonly parts: readonly {
    readonly role: string;
    readonly locator: string;
    readonly mediaType: string;
  }[];
};

function inspectionFrom(
  evidence: RecognitionEvidence,
): FormatInspection | undefined {
  const candidate = evidence as RecognitionEvidence & {
    readonly inspection?: FormatInspection;
  };
  return candidate.kind === "artifact-format-inspection" &&
    candidate.inspection !== undefined
    ? candidate.inspection
    : undefined;
}

function isbnFromEvidence(evidence: RecognitionEvidence): string | undefined {
  return (
    uniqueIsbnFromInspection(evidence) ??
    (evidence.sourceIdentity === "nbinet" &&
    evidence.sourceAddress !== undefined &&
    (evidence.kind === "directed-source-address" ||
      evidence.kind === "source-association")
      ? isbnFromAddress(evidence.sourceAddress)
      : undefined)
  );
}

function uniqueIsbnFromInspection(
  evidence: RecognitionEvidence,
): string | undefined {
  if (!sameCapabilityCoordinate(evidence.producer, epubInspectorCapability))
    return undefined;
  const inspection = inspectionFrom(evidence);
  if (inspection === undefined) return undefined;
  const values = [
    ...new Set(
      inspection.identifiers
        .filter(
          (identifier) =>
            identifier.scheme === "isbn-13" && isValidIsbn13(identifier.value),
        )
        .map((identifier) => identifier.value),
    ),
  ];
  return values.length === 1 ? values[0] : undefined;
}

function exactRequestedIsbn(
  evidence: readonly RecognitionEvidence[],
): string | undefined {
  const values = [
    ...new Set(
      evidence.flatMap((item) => {
        const isbn = isbnFromEvidence(item);
        return isbn === undefined ? [] : [isbn];
      }),
    ),
  ];
  return values.length === 1 ? values[0] : undefined;
}

function officialRecords(
  records: readonly SourceRecord[],
): readonly SourceRecord[] {
  return records.filter(
    (record) =>
      record.sourceIdentity === "nbinet" &&
      record.coverage.id === "nbinet.exact-isbn" &&
      record.coverage.authority === "official" &&
      record.producer !== undefined &&
      sameCapabilityCoordinate(record.producer, collectorCapability),
  );
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

function publicApiAddress(isbn: string): string {
  const query = new URLSearchParams({
    inst: "886NCL_NBINET",
    vid: "886NCL_NBINET:NBINET",
    lang: "zh-tw",
    q: `isbn,exact,${isbn}`,
    scope: "MyInstitution",
    tab: "NBINET",
    skipDelivery: "Y",
  });
  return `https://nbinet.primo.exlibrisgroup.com/primaws/rest/pub/pnxs?${query}`;
}

function isbnFromAddress(address: string): string | undefined {
  try {
    const url = new URL(address);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "nbinet.primo.exlibrisgroup.com"
    )
      return undefined;
    const match = /(?:^|,)isbn,exact,(97[89]\d{10})(?:,|$)/u.exec(
      url.searchParams.get("q") ?? "",
    );
    return match?.[1];
  } catch {
    return undefined;
  }
}

function supportedIsbn13Lexeme(value: string): string | undefined {
  const match =
    /^(?:ISBN(?:-13)?(?:\s*:\s*|\s+))?(97[89](?:[ -]?\d){10})$/iu.exec(value);
  return match?.[1]?.replaceAll(/[ -]/gu, "");
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item) =>
        string(item) === undefined ? [] : [string(item)!],
      )
    : string(value) === undefined
      ? []
      : [string(value)!];
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
