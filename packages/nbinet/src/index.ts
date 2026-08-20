import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  type Recognizer,
  type SourceCollectionResult,
  type SourceCollector,
  type SourceInterpreter,
} from "@digital/application";
import type {
  RecognitionEvidence,
  RecognitionProposalDraft,
  SourceInterpretationBatch,
  SourceRecord,
} from "@digital/domain";

const maximumResponseBytes = 2 * 1024 * 1024;
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
  implementationVersion: "1",
  kind: "recognizer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

export const trustedNbinetExactEpubIsbnRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "embedded-isbn-in-exact-official-record",
  ruleVersion: "1",
} as const;

type FetchLike = (input: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class NbinetCollector implements SourceCollector {
  readonly capability = collectorCapability;
  private readonly request: FetchLike;

  constructor(request: FetchLike = fetch) {
    this.request = request;
  }

  canCollect(evidence: RecognitionEvidence): boolean {
    return (
      inspectionFrom(evidence)?.identifiers.some(
        (identifier) =>
          identifier.scheme === "isbn-13" && isValidIsbn13(identifier.value),
      ) ?? false
    );
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
            reason: "NBINet collection requires exact EPUB ISBN evidence",
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
        },
      ],
      failures: [],
    };
  }
}

export class NbinetSourceInterpreter implements SourceInterpreter {
  readonly capability = interpreterCapability;

  canInterpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): boolean {
    return (
      input.evidence.some((item) => isbnFromEvidence(item) !== undefined) &&
      input.sourceRecords.some(
        (record) =>
          record.sourceIdentity === "nbinet" &&
          record.coverage.id === "nbinet.exact-isbn",
      )
    );
  }

  interpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): SourceInterpretationBatch {
    const evidence = input.evidence.find(
      (item) => isbnFromEvidence(item) !== undefined,
    );
    const isbn =
      evidence === undefined ? undefined : isbnFromEvidence(evidence);
    if (isbn === undefined)
      throw new Error(
        "NBINet interpretation requires exact EPUB ISBN evidence",
      );
    const official = input.sourceRecords.find(
      (record) =>
        record.sourceIdentity === "nbinet" &&
        record.coverage.id === "nbinet.exact-isbn",
    );
    if (official === undefined)
      throw new Error(
        "NBINet interpretation requires official record and EPUB evidence",
      );
    if (official.nativeAddress !== canonicalIsbnAddress(isbn))
      throw new Error("book source records disagree about the ISBN address");
    const bibliographic = exactBibliographicRecord(official.body, isbn);
    if (bibliographic === undefined)
      throw new Error("国家图书馆未返回包含该精确 ISBN 的唯一书目记录");
    const metadata = [
      assertion("book.isbn-13", "nbinet.isbn-13", isbn, official.id),
    ];
    return {
      id: `source-interpretation_${randomUUID()}`,
      producer: this.capability,
      sourceRecordIds: [official.id],
      sourceIdentity: "nbinet",
      sourceAddress: canonicalIsbnAddress(isbn),
      metadata,
      sourceArtifacts: [],
    };
  }
}

export class NbinetExactIsbnRecognizer implements Recognizer {
  readonly capability = recognizerCapability;
  canRecognize(input: SourceInterpretationBatch): boolean {
    return (
      input.sourceIdentity === "nbinet" &&
      input.producer.capabilityId === interpreterCapability.capabilityId
    );
  }
  recognize(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly interpretation: SourceInterpretationBatch;
  }): RecognitionProposalDraft {
    const isbn = isbnFromAddress(input.interpretation.sourceAddress);
    const satisfied =
      isbn !== undefined &&
      input.evidence.some((item) => isbnFromEvidence(item) === isbn);
    return {
      id: `recognition-proposal_${randomUUID()}`,
      ruleResults: [
        {
          ...trustedNbinetExactEpubIsbnRule,
          outcome: satisfied ? "satisfied" : "contradicted",
          explanation: satisfied
            ? "EPUB 内嵌精确 ISBN 已在国家图书馆书目记录中明确出现"
            : "EPUB ISBN 与国家图书馆书目记录不一致",
          evidence: input.evidence.filter(
            (item) => isbnFromEvidence(item) === isbn,
          ),
        },
      ],
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

function exactBibliographicRecord(body: string, isbn: string): {} | undefined {
  const parsed = JSON.parse(body) as { readonly docs?: unknown };
  const matches = (Array.isArray(parsed.docs) ? parsed.docs : []).flatMap(
    (doc) => {
      const record = doc as {
        readonly pnx?: {
          readonly addata?: { readonly isbn?: unknown };
        };
      };
      const identifiers = strings(record.pnx?.addata?.isbn).map(normalizeIsbn);
      if (!identifiers.includes(isbn)) return [];
      return [{}];
    },
  );
  return matches.length === 1 ? matches[0] : undefined;
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
  return inspectionFrom(evidence)?.identifiers.find(
    (identifier) =>
      identifier.scheme === "isbn-13" && isValidIsbn13(identifier.value),
  )?.value;
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

function normalizeIsbn(value: string): string {
  return value.replaceAll(/[^\dX]/giu, "");
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
