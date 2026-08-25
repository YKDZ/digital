import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  prerequisiteUnavailableFailure,
  type InformationRequirement,
  type SourceArtifactAcquirer,
  type SourceCollectionFailure,
  type SourceCollectionExecutionContext,
  type SourceCollectionResult,
  type SourceCollector,
  type SourceInterpreter,
  type StagedSourceArtifact,
} from "@digital/application";
import type {
  MetadataAssertion,
  RecognitionEvidence,
  SourceAssociation,
  SourceArtifactCandidate,
  SourceInterpretationBatch,
  SourceRecord,
} from "@digital/domain";

const apiOrigin = "https://www.omdbapi.com/";
const maximumResponseBytes = 2 * 1024 * 1024;
const maximumPosterBytes = 20 * 1024 * 1024;

const candidateInterpreterCapability = declareCapability({
  identity: "omdb.source-association-candidate-interpretation",
  implementationVersion: "1",
  kind: "source-association-candidate-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const associationInterpreterCapability = declareCapability({
  identity: "omdb.source-association-interpretation",
  implementationVersion: "1",
  kind: "source-association-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const collectorCapability = declareCapability({
  identity: "omdb.film-enrichment-collection",
  implementationVersion: "1",
  kind: "source-collector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
/** 私有 OMDb 访问与丰富采集分别声明。 */
export const omdbSourceConnectionCapability = declareCapability({
  identity: "omdb.source-connection",
  implementationVersion: "1",
  kind: "source-connection",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const interpreterCapability = declareCapability({
  identity: "omdb.film-enrichment-interpretation",
  implementationVersion: "1",
  kind: "source-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const artifactCapability = declareCapability({
  identity: "omdb.source-artifact-acquirer",
  implementationVersion: "1",
  kind: "source-artifact-acquirer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

type FetchLike = (input: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** 由应用层提供、与提供方无关的主体快照，绝不是影片实体。 */
export type SourceEnrichmentInput = {
  readonly subjectId: string;
  readonly recognitionSourceAssociation: SourceAssociation;
  readonly recognitionDecisionId: string;
  readonly sourceAssociations: readonly SourceAssociation[];
  readonly metadata: readonly MetadataAssertion[];
  readonly metadataSourceRecords: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
  }[];
  readonly informationRequirement: InformationRequirement;
};

type OmdbResponse = {
  readonly imdbId: string;
  readonly title: string;
  readonly year: string;
  readonly plot?: string;
  readonly released?: string;
  readonly runtime?: string;
  readonly awards?: string;
  readonly boxOffice?: string;
  readonly poster?: string;
  readonly imdbVotes?: string;
  readonly ratings: readonly {
    readonly source: string;
    readonly value: string;
  }[];
};

/**
 * 将已接受且带有来源标签的事实解释为一个精确候选地址。采集仍由 `OmdbCollector` 负责。
 */
export class OmdbSourceAssociationCandidateInterpreter {
  readonly capability = candidateInterpreterCapability;

  interpret(input: SourceEnrichmentInput): RecognitionEvidence | undefined {
    const identityMetadata = recognitionSourceMetadata(input);
    const imdbId = imdbIdentifier(identityMetadata);
    if (
      !requestsOmdbContribution(input.informationRequirement) ||
      imdbId === undefined ||
      initialReleaseYear(identityMetadata) === undefined ||
      sourceTitles(identityMetadata).length === 0
    )
      return undefined;
    return {
      kind: "source-association",
      explanation: "以已接受来源的 IMDb 标识请求独立 OMDb 记录",
      sourceIdentity: "omdb",
      sourceAddress: canonicalAddress(imdbId),
      producer: this.capability,
    };
  }
}

/**
 * 依据已接受主体验证一份独立解释的 OMDb 响应。它本身不建立关联，也绝不采集记录。
 */
export class OmdbSourceAssociationInterpreter {
  readonly capability = associationInterpreterCapability;

  canInterpret(input: {
    readonly evidence: RecognitionEvidence;
    readonly interpretation: SourceInterpretationBatch;
  }): boolean {
    return (
      input.evidence.sourceIdentity === "omdb" &&
      input.interpretation.sourceIdentity === "omdb"
    );
  }

  interpret(input: {
    readonly subject: SourceEnrichmentInput;
    readonly evidence: RecognitionEvidence;
    readonly interpretation: SourceInterpretationBatch;
  }):
    | { readonly status: "accepted"; readonly explanation: string }
    | { readonly status: "contradicted"; readonly explanation: string } {
    const expected = recognitionSourceMetadata(input.subject);
    const accepted =
      input.interpretation.sourceIdentity === "omdb" &&
      input.evidence.sourceIdentity === input.interpretation.sourceIdentity &&
      input.evidence.sourceAddress === input.interpretation.sourceAddress &&
      imdbIdentifier(input.interpretation.metadata) ===
        imdbIdentifier(expected) &&
      initialReleaseYear(input.interpretation.metadata) ===
        initialReleaseYear(expected) &&
      sourceTitles(input.interpretation.metadata).some((candidate) =>
        sourceTitles(expected).some(
          (title) => normalisedTitle(title) === normalisedTitle(candidate),
        ),
      );
    return accepted
      ? {
          status: "accepted",
          explanation: "OMDb 响应与已接受身份的标识、年份和标题完全一致",
        }
      : {
          status: "contradicted",
          explanation: "OMDb 响应与已接受身份的标识、年份或标题矛盾",
        };
  }
}

function requestsOmdbContribution(
  requirement: InformationRequirement,
): boolean {
  const supported = new Set([
    "asset.title",
    "asset.introduction",
    "asset.release-date",
    "asset.runtime-minutes",
    "asset.awards",
    "asset.box-office",
    "external.imdb-id",
    "rating.imdb",
    "rating.rotten-tomatoes",
    "rating.metacritic",
  ]);
  return (
    requirement.metadata.some(
      ({ property }) =>
        supported.has(property) ||
        property === "rating.*" ||
        property === "asset.*",
    ) ||
    requirement.artifactRoles.some(({ role }) => role === "asset.primary-cover")
  );
}

function recognitionSourceMetadata(
  input: SourceEnrichmentInput,
): readonly MetadataAssertion[] {
  const supportingRecords = new Set(
    input.metadataSourceRecords
      .filter(
        (record) =>
          record.sourceIdentity ===
          input.recognitionSourceAssociation.sourceIdentity,
      )
      .map((record) => record.id),
  );
  return input.metadata.filter((assertion) =>
    assertion.sourceRecordIds.some((sourceRecordId) =>
      supportingRecords.has(sourceRecordId),
    ),
  );
}

/** 刷新已经确认的 OMDb 关联；绝不发现新关联。 */
export class OmdbCollector implements SourceCollector {
  readonly capability = collectorCapability;
  private readonly apiKey: string | undefined;
  private readonly apiKeyForExecution:
    | ((
        context: SourceCollectionExecutionContext | undefined,
      ) => string | undefined)
    | undefined;
  private readonly request: FetchLike;

  constructor(
    options: {
      readonly apiKey?: string;
      readonly apiKeyForExecution?: (
        context: SourceCollectionExecutionContext | undefined,
      ) => string | undefined;
      readonly request?: FetchLike;
    } = {},
  ) {
    this.apiKey = options.apiKey;
    this.apiKeyForExecution = options.apiKeyForExecution;
    this.request = options.request ?? fetch;
  }

  canCollect(evidence: RecognitionEvidence): boolean {
    return omdbIdentifierFromEvidence(evidence) !== undefined;
  }

  coverageScopeIds(evidence: RecognitionEvidence): readonly string[] {
    return this.canCollect(evidence) ? ["omdb.movie"] : [];
  }

  async collect(
    evidence: RecognitionEvidence,
    context?: SourceCollectionExecutionContext,
  ): Promise<SourceCollectionResult> {
    const imdbId = omdbIdentifierFromEvidence(evidence);
    if (imdbId === undefined)
      return {
        records: [],
        failures: [failure("OMDb 刷新需要当前 OMDb 来源关联")],
      };
    return await collectOmdbRecord({
      apiKey:
        this.apiKeyForExecution === undefined
          ? this.apiKey
          : this.apiKeyForExecution(context),
      request: this.request,
      imdbId,
    });
  }
}

/** 只解释当前关联精确指向的 OMDb 记录。 */
export class OmdbSourceInterpreter implements SourceInterpreter {
  readonly capability = interpreterCapability;

  canInterpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): boolean {
    return (
      input.evidence.some(
        (evidence) => omdbIdentifierFromEvidence(evidence) !== undefined,
      ) &&
      input.sourceRecords.some(
        (record) =>
          record.sourceIdentity === "omdb" &&
          record.coverage.id === "omdb.movie",
      )
    );
  }

  interpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): SourceInterpretationBatch {
    const imdbId = input.evidence
      .map(omdbIdentifierFromEvidence)
      .find((value) => value !== undefined);
    const record = input.sourceRecords.find(
      (item) =>
        item.sourceIdentity === "omdb" &&
        item.nativeAddress ===
          (imdbId === undefined ? undefined : canonicalAddress(imdbId)),
    );
    if (imdbId === undefined || record === undefined)
      throw new Error("OMDb 刷新缺少当前来源关联对应的记录");
    const parsed = parseResponse(record.body);
    if (parsed.imdbId !== imdbId)
      throw new Error("OMDb 刷新记录未确认当前来源关联");
    return {
      id: `source-interpretation_omdb_${randomUUID()}`,
      producer: this.capability,
      sourceRecordIds: [record.id],
      sourceIdentity: "omdb",
      sourceAddress: record.nativeAddress,
      metadata: metadataFromResponse(parsed, record.id),
      sourceArtifacts: artifactCandidates(parsed, record.id),
    };
  }
}

export class OmdbArtifactAcquirer implements SourceArtifactAcquirer {
  readonly capability = artifactCapability;
  private readonly request: FetchLike;

  constructor(request: FetchLike = fetch) {
    this.request = request;
  }

  canAcquire(candidate: SourceArtifactCandidate): boolean {
    return (
      candidate.role === "asset.primary-cover" &&
      canonicalPosterAddress(candidate.acquisitionReference) !== undefined &&
      candidate.mediaType.startsWith("image/")
    );
  }

  async acquire(
    candidate: SourceArtifactCandidate,
  ): Promise<StagedSourceArtifact> {
    if (!this.canAcquire(candidate))
      throw new Error("OMDb 海报候选不是受支持的官方 HTTPS 图片地址");
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.request(candidate.acquisitionReference);
    } catch (error) {
      throw new Error(`OMDb 海报请求失败：${message(error)}`, { cause: error });
    }
    if (!response.ok)
      throw new Error(`OMDb 海报请求失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumPosterBytes)
      throw new Error("OMDb 海报不符合保存限制");
    const mediaType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    if (
      !mediaType.startsWith("image/") ||
      mediaType !== candidate.mediaType.split(";", 1)[0]?.trim()
    )
      throw new Error("OMDb 海报响应类型与候选不一致");
    return {
      candidateId: candidate.id,
      sourceRecordId: candidate.sourceRecordId,
      bytes,
      mediaType,
    };
  }
}

function failure(
  reason: string,
  options: Pick<SourceCollectionFailure, "failureClassification"> = {},
): SourceCollectionFailure {
  return { capability: collectorCapability, reason, ...options };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalAddress(imdbId: string): string {
  return `omdb:imdb:${imdbId}`;
}

function omdbIdentifierFromEvidence(
  evidence: RecognitionEvidence,
): string | undefined {
  if (
    evidence.kind !== "source-association" ||
    evidence.sourceIdentity !== "omdb"
  )
    return undefined;
  const match = /^omdb:imdb:(tt\d+)$/u.exec(evidence.sourceAddress ?? "");
  return match?.[1];
}

async function collectOmdbRecord(input: {
  readonly apiKey: string | undefined;
  readonly request: FetchLike;
  readonly imdbId: string;
}): Promise<SourceCollectionResult> {
  if (input.apiKey === undefined || input.apiKey.length === 0) {
    return {
      records: [],
      failures: [
        failure("OMDb 官方来源获取需要私有访问令牌", {
          failureClassification: prerequisiteUnavailableFailure,
        }),
      ],
    };
  }
  const nativeAddress = canonicalAddress(input.imdbId);
  let response: Awaited<ReturnType<FetchLike>>;
  let body: string;
  try {
    const endpoint = new URL(apiOrigin);
    endpoint.searchParams.set("apikey", input.apiKey);
    endpoint.searchParams.set("i", input.imdbId);
    endpoint.searchParams.set("plot", "full");
    endpoint.searchParams.set("r", "json");
    response = await input.request(endpoint.href);
    if (!response.ok)
      return {
        records: [],
        failures: [failure(`OMDb 官方来源请求失败：HTTP ${response.status}`)],
      };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes)
      return {
        records: [],
        failures: [failure("OMDb 官方来源响应不符合保存限制")],
      };
    body = redactOmdbResponseBody(
      new TextDecoder().decode(bytes),
      input.apiKey,
    );
    if (!hasSuccessfulOmdbEnvelope(body))
      return {
        records: [],
        // OMDb 的否定载荷通常包含请求 URL、密钥和提供方特定的 `Error` 文本。
        // 它属于获取失败而非证据，因此只保留本地可修复分类。
        failures: [failure("OMDb 官方来源未返回可用作品")],
      };
  } catch {
    // OMDb 密钥是请求 URL 的一部分。网络实现可能在错误中回显该 URL，
    // 因此其诊断不得进入持久采集失败或公开执行检查。
    return {
      records: [],
      failures: [failure("OMDb 官方来源请求未完成")],
    };
  }
  return {
    records: [
      {
        id: `source-record_omdb_${randomUUID()}`,
        sourceIdentity: "omdb",
        nativeAddress,
        // OMDb 采集是纯 JSON 协议。保留其声明的媒体类型，不要映射可能包含请求上下文
        // 或私有配置的响应标头。
        mediaType: "application/json",
        acquiredAt: new Date().toISOString(),
        acquisition: {
          requestedAddress: nativeAddress,
          method: "GET",
          authorized: true,
        },
        coverage: {
          id: "omdb.movie",
          completeness: "complete",
          authority: "official",
        },
        // 保留正文刻意采用净化后的来源证据；因此其摘要必须精确描述后续检查和解释可见的内容，
        // 绝不是未保留的私有响应。
        digest: createHash("sha256").update(body).digest("hex"),
        body,
      },
    ],
    failures: [],
  };
}

function imdbIdentifier(
  metadata: readonly MetadataAssertion[],
): string | undefined {
  return metadata.find((item) => item.property === "external.imdb-id")?.value;
}

function initialReleaseYear(
  metadata: readonly MetadataAssertion[],
): string | undefined {
  const date = metadata.find(
    (item) => item.property === "asset.release-date",
  )?.value;
  return date === undefined ? undefined : /^(\d{4})-/u.exec(date)?.[1];
}

function sourceTitles(
  metadata: readonly MetadataAssertion[],
): readonly string[] {
  return metadata
    .filter((item) =>
      [
        "asset.title",
        "asset.title.original",
        "asset.title.alternative",
      ].includes(item.property),
    )
    .map((item) => item.value);
}

function normalisedTitle(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und");
}

function parseResponse(body: string): OmdbResponse {
  const raw = JSON.parse(body) as Record<string, unknown>;
  if (raw.Response !== "True")
    throw new Error(text(raw.Error) ?? "OMDb 未返回作品");
  const imdbId = text(raw.imdbID);
  const title = text(raw.Title);
  const year = text(raw.Year)?.match(/^\d{4}$/u)?.[0];
  if (
    imdbId === undefined ||
    !/^tt\d+$/u.test(imdbId) ||
    title === undefined ||
    year === undefined
  )
    throw new Error("OMDb 响应缺少确定身份所需字段");
  const ratingValues = Array.isArray(raw.Ratings) ? raw.Ratings : [];
  const plot = optionalText(raw.Plot);
  const released = omdbReleaseDate(optionalText(raw.Released));
  const runtime = optionalText(raw.Runtime);
  const awards = optionalText(raw.Awards);
  const boxOffice = optionalText(raw.BoxOffice);
  const poster = optionalText(raw.Poster);
  const imdbVotes = optionalText(raw.imdbVotes);
  return {
    imdbId,
    title,
    year,
    ...(plot === undefined ? {} : { plot }),
    ...(released === undefined ? {} : { released }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(awards === undefined ? {} : { awards }),
    ...(boxOffice === undefined ? {} : { boxOffice }),
    ...(poster === undefined ? {} : { poster }),
    ...(imdbVotes === undefined ? {} : { imdbVotes }),
    ratings: ratingValues.flatMap((entry) => {
      const item = entry as Record<string, unknown>;
      const source = text(item.Source);
      const rating = text(item.Value);
      return source === undefined || rating === undefined
        ? []
        : [{ source, value: rating }];
    }),
  };
}

/**
 * 来源记录只保存成功且有界的证据。响应进入持久存储前，先确认提供方最小成功响应结构；
 * 完整身份验证仍由来源解释器和关联契约负责。
 */
function hasSuccessfulOmdbEnvelope(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { readonly Response?: unknown }).Response === "True"
    );
  } catch {
    return false;
  }
}

/**
 * 调用 OMDb 时只能把 API 密钥嵌入请求 URL。即使远端响应成功也仍不可信：它跨越提供方
 * 采集器边界进入来源记录前，应移除密钥的精确表示。共享的领域/应用契约刻意不知道
 * 该来源使用 API 密钥。
 */
function redactOmdbResponseBody(body: string, apiKey: string): string {
  const representations = new Set([
    apiKey,
    JSON.stringify(apiKey).slice(1, -1),
    encodeURIComponent(apiKey),
  ]);
  let sanitized = body;
  for (const representation of representations) {
    if (representation.length > 0)
      sanitized = sanitized.replaceAll(representation, "[REDACTED]");
  }
  return sanitized;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalText(value: unknown): string | undefined {
  const parsed = text(value);
  return parsed === "N/A" ? undefined : parsed;
}

function metadataFromResponse(
  value: OmdbResponse,
  sourceRecordId: string,
): readonly MetadataAssertion[] {
  const facts: MetadataAssertion[] = [];
  const add = (
    property: string,
    sourceSlot: string,
    field: string | undefined,
    qualifiers?: MetadataAssertion["qualifiers"],
  ) => {
    if (field !== undefined)
      facts.push({
        property,
        sourceSlot,
        value: field,
        sourceRecordIds: [sourceRecordId],
        ...(qualifiers === undefined ? {} : { qualifiers }),
      });
  };
  add("asset.title", "omdb.movie.title", value.title);
  add("asset.introduction", "omdb.movie.plot", value.plot);
  add("asset.release-date", "omdb.movie.released", value.released);
  add(
    "asset.runtime-minutes",
    "omdb.movie.runtime",
    /^([1-9]\d*) min$/u.exec(value.runtime ?? "")?.[1],
  );
  add("asset.awards", "omdb.movie.awards", value.awards);
  add("asset.box-office", "omdb.movie.box-office", value.boxOffice);
  add("external.imdb-id", "omdb.movie.imdb-id", value.imdbId);
  for (const rating of value.ratings) {
    const property = {
      "Internet Movie Database": "rating.imdb",
      "Rotten Tomatoes": "rating.rotten-tomatoes",
      Metacritic: "rating.metacritic",
    }[rating.source];
    if (property !== undefined) {
      const scale =
        property === "rating.imdb"
          ? "10"
          : property === "rating.rotten-tomatoes" ||
              property === "rating.metacritic"
            ? "100"
            : undefined;
      add(property, `omdb.rating.${property}`, rating.value, [
        { key: "rating.source-label", value: rating.source },
        {
          key: "rating.unit",
          value: property === "rating.rotten-tomatoes" ? "percent" : "score",
        },
        ...(scale === undefined ? [] : [{ key: "rating.scale", value: scale }]),
        ...(property !== "rating.imdb" || value.imdbVotes === undefined
          ? []
          : [{ key: "rating.population", value: value.imdbVotes }]),
      ]);
    }
  }
  return facts;
}

function artifactCandidates(
  value: OmdbResponse,
  sourceRecordId: string,
): readonly SourceArtifactCandidate[] {
  const address =
    value.poster === undefined
      ? undefined
      : canonicalPosterAddress(value.poster);
  if (address === undefined) return [];
  return [
    {
      id: "omdb.primary-poster",
      sourceRecordId,
      role: "asset.primary-cover",
      acquisitionReference: address,
      mediaType: posterMediaType(address),
    },
  ];
}

function canonicalPosterAddress(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const hosts = new Set([
    "m.media-amazon.com",
    "images-na.ssl-images-amazon.com",
    "ia.media-imdb.com",
  ]);
  return parsed.protocol === "https:" &&
    hosts.has(parsed.hostname) &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname.startsWith("/images/") &&
    parsed.search === "" &&
    parsed.hash === ""
    ? parsed.href
    : undefined;
}

function posterMediaType(address: string): string {
  const path = new URL(address).pathname.toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function omdbReleaseDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/u.exec(value);
  if (match === null) return undefined;
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(match[2]!);
  const day = Number(match[1]);
  const year = Number(match[3]);
  if (month < 0 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  )
    return undefined;
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]}`;
}
