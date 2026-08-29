import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  prerequisiteUnavailableFailure,
  type DirectoryInterpreter,
  type FilesystemPackageSnapshot,
  type Recognizer,
  type SourceArtifactAcquirer,
  type SourceCollectionResult,
  type SourceCollector,
  type SourceCollectionExecutionContext,
  type SourceInterpreter,
  type StagedSourceArtifact,
} from "@digital/application";
import type {
  CapabilityCoordinate,
  ProposedEntityRelationship,
  RecognitionEvidence,
  RecognitionProposalDraft,
  SourceArtifactCandidate,
  SourceInterpretationBatch,
  SourceRecord,
  SourcedEntity,
} from "@digital/domain";

const apiOrigin = "https://api.themoviedb.org/3";
const imageOrigin = "https://image.tmdb.org/t/p/original";
const publicOrigin = "https://www.themoviedb.org";
const maximumResponseBytes = 2 * 1024 * 1024;
const maximumSearchPages = 500;

const directoryCapability = declareCapability({
  identity: "tmdb.strict-film-directory",
  implementationVersion: "1",
  kind: "directory-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const collectorCapability = declareCapability({
  identity: "tmdb.official-film-collection",
  implementationVersion: "2",
  kind: "source-collector",
  contractVersion: "2",
  interpretationContractVersions: ["2"],
});
export const tmdbOfficialCollectionCapability = collectorCapability;
/**
 * 产品管理的私有访问是独立于公开采集契约的已部署能力。其秘密结构只保留在该集成和
 * 外层组合中，绝不进入领域层。
 */
export const tmdbSourceConnectionCapability = declareCapability({
  identity: "tmdb.source-connection",
  implementationVersion: "1",
  kind: "source-connection",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const interpreterCapability = declareCapability({
  identity: "tmdb.film-interpretation",
  implementationVersion: "2",
  kind: "source-interpreter",
  contractVersion: "2",
  interpretationContractVersions: ["2"],
});
const recognizerCapability = declareCapability({
  identity: "tmdb.strict-film-recognizer",
  implementationVersion: "1",
  kind: "recognizer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const acquirerCapability = declareCapability({
  identity: "tmdb.source-artifact-acquirer",
  implementationVersion: "1",
  kind: "source-artifact-acquirer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

export const trustedTmdbStrictFilmRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "unique-exact-title-year-official-record",
  ruleVersion: "1",
} as const;
export const trustedTmdbDirectedFilmRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "exact-directed-official-address",
  ruleVersion: "1",
} as const;

type FetchLike = (
  input: string,
  init?: { readonly headers?: Readonly<Record<string, string>> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type SearchAddress = { readonly title: string; readonly year: string };

/** 验证一份 TMDB 访问令牌；远端诊断不会越过该能力。 */
export async function verifyTmdbAccessToken(
  accessToken: string,
  request: FetchLike = fetch,
): Promise<void> {
  const response = await request(`${apiOrigin}/authentication`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error("TMDB 来源连接验证失败");
}

/**
 * TMDB 拥有这个刻意保持精简的本地约定。它只贡献证据：标题和年份绝不是领域身份。
 */
export class TmdbStrictFilmDirectoryInterpreter implements DirectoryInterpreter {
  readonly capability = directoryCapability;

  interpret(
    snapshot: FilesystemPackageSnapshot,
  ): readonly RecognitionEvidence[] {
    const basename = snapshot.root.split(/[\\/]/u).at(-1) ?? "";
    const match = /^(\S(?:.*\S)?) \((\d{4})\)$/u.exec(basename);
    if (match === null) return [];
    if (
      snapshot.directories?.some((directory) =>
        /^Season [1-9]\d*$/u.test(directory.relativePath),
      ) === true
    )
      return [];
    const title = match[1]!;
    const year = match[2]!;
    return [
      {
        kind: "directory-convention",
        sourceIdentity: "tmdb",
        sourceAddress: searchAddress(title, year),
        explanation: "TMDB 严格电影目录规则匹配",
        producer: this.capability,
      },
    ];
  }
}

/** 实时官方采集；不记名凭据保留在外层配置中。 */
export class TmdbCollector implements SourceCollector {
  readonly capability = collectorCapability;
  private readonly accessToken: string | undefined;
  private readonly accessTokenForExecution:
    | ((
        context: SourceCollectionExecutionContext | undefined,
      ) => string | undefined)
    | undefined;
  private readonly request: FetchLike;

  constructor(
    options: {
      readonly accessToken?: string;
      readonly accessTokenForExecution?: (
        context: SourceCollectionExecutionContext | undefined,
      ) => string | undefined;
      readonly request?: FetchLike;
    } = {},
  ) {
    this.accessToken = options.accessToken;
    this.accessTokenForExecution = options.accessTokenForExecution;
    this.request = options.request ?? fetch;
  }

  canCollect(evidence: RecognitionEvidence): boolean {
    if (
      evidence.sourceIdentity !== "tmdb" ||
      evidence.sourceAddress === undefined
    )
      return false;
    if (evidence.producer.capabilityId === directoryCapability.capabilityId)
      return parseSearchAddress(evidence.sourceAddress) !== undefined;
    if (
      evidence.kind !== "source-association" &&
      evidence.kind !== "directed-source-address"
    )
      return false;
    return canonicalDirectedMovieAddress(evidence.sourceAddress) !== undefined;
  }

  coverageScopeIds(evidence: RecognitionEvidence): readonly string[] {
    if (!this.canCollect(evidence)) return [];
    return parseSearchAddress(evidence.sourceAddress!) === undefined
      ? [
          "tmdb.movie",
          "tmdb.translations",
          "tmdb.credits.directors",
          "tmdb.credits",
        ]
      : [
          "tmdb.search",
          "tmdb.movie",
          "tmdb.translations",
          "tmdb.credits.directors",
          "tmdb.credits",
        ];
  }

  async collect(
    evidence: RecognitionEvidence,
    context?: SourceCollectionExecutionContext,
  ): Promise<SourceCollectionResult> {
    if (!this.canCollect(evidence))
      return failed(
        this.capability,
        "TMDB 采集需要本集成产生的严格目录证据或精确官方地址",
      );
    const accessToken =
      this.accessTokenForExecution === undefined
        ? this.accessToken
        : this.accessTokenForExecution(context);
    if (accessToken === undefined || accessToken.length === 0)
      return {
        records: [],
        failures: [
          {
            capability: this.capability,
            reason: "TMDB 官方来源获取需要私有访问令牌",
            failureClassification: prerequisiteUnavailableFailure,
          },
        ],
      };
    const search = parseSearchAddress(evidence.sourceAddress!);
    try {
      if (search !== undefined)
        return await this.collectSearch(search, accessToken);
      return await this.collectMovie(
        canonicalDirectedMovieAddress(evidence.sourceAddress!)!,
        accessToken,
      );
    } catch (error) {
      return failed(
        this.capability,
        `TMDB 官方来源请求失败：${safeTmdbDiagnostic(error, accessToken)}`,
      );
    }
  }

  private async collectSearch(
    input: SearchAddress,
    accessToken: string,
  ): Promise<SourceCollectionResult> {
    const capturePage = async (page: number): Promise<SourceRecord> => {
      const endpoint = new URL(`${apiOrigin}/search/movie`);
      endpoint.searchParams.set("query", input.title);
      endpoint.searchParams.set("primary_release_year", input.year);
      endpoint.searchParams.set("language", "zh-CN");
      endpoint.searchParams.set("page", String(page));
      return await this.capture(
        endpoint.href,
        searchAddress(input.title, input.year),
        `tmdb.search.page.${page}`,
        accessToken,
      );
    };
    const records: SourceRecord[] = [];
    const failures: SourceCollectionResult["failures"][number][] = [];
    const firstAttempt = await this.captureForRecognition(
      () => capturePage(1),
      accessToken,
    );
    records.push(...firstAttempt.records);
    failures.push(...firstAttempt.failures);
    const first = firstAttempt.records[0];
    if (first === undefined) return { records, failures };
    let firstPage: ReturnType<typeof parseSearchPage>;
    try {
      firstPage = parseSearchPage(first.body);
    } catch (error) {
      failures.push(
        recognitionFailure(
          this.capability,
          safeTmdbDiagnostic(error, accessToken),
        ),
      );
      return { records, failures };
    }
    if (firstPage.page !== 1 || firstPage.totalPages > maximumSearchPages) {
      failures.push(
        recognitionFailure(this.capability, "TMDB 搜索分页范围无效"),
      );
      return { records, failures };
    }
    if (firstPage.totalPages === 0) return { records, failures };
    const pageAttempts = await Promise.all(
      Array.from(
        { length: firstPage.totalPages - 1 },
        (_, index) => index + 2,
      ).map(
        async (page) =>
          await this.captureForRecognition(
            () => capturePage(page),
            accessToken,
          ),
      ),
    );
    for (const attempt of pageAttempts) {
      records.push(...attempt.records);
      failures.push(...attempt.failures);
    }
    if (failures.length > 0) return { records, failures };
    const searches = records.filter((record) =>
      record.coverage.id.startsWith("tmdb.search.page."),
    );
    let parsedPages: ReturnType<typeof parseSearchPage>[];
    try {
      parsedPages = searches.map((record) => parseSearchPage(record.body));
    } catch (error) {
      failures.push(
        recognitionFailure(
          this.capability,
          safeTmdbDiagnostic(error, accessToken),
        ),
      );
      return { records, failures };
    }
    if (
      parsedPages.some(
        (page, index) =>
          page.page !== index + 1 || page.totalPages !== firstPage.totalPages,
      )
    ) {
      failures.push(
        recognitionFailure(this.capability, "TMDB 搜索分页响应不完整"),
      );
      return { records, failures };
    }
    const candidates = [
      ...new Set(parsedPages.flatMap((page) => page.movieIds)),
    ];
    const detailAttempts = await Promise.all(
      candidates.map(
        async (movieId) =>
          await this.captureForRecognition(
            () => this.captureMovie(movieId, accessToken),
            accessToken,
          ),
      ),
    );
    const details = detailAttempts.flatMap((attempt) => attempt.records);
    records.push(...details);
    failures.push(...detailAttempts.flatMap((attempt) => attempt.failures));
    if (failures.length > 0) return { records, failures };
    let exact: SourceRecord[];
    try {
      exact = details.filter((detail) =>
        exactMovieMatch(parseMovie(detail.body), input),
      );
    } catch (error) {
      failures.push(
        recognitionFailure(
          this.capability,
          safeTmdbDiagnostic(error, accessToken),
        ),
      );
      return { records, failures };
    }
    if (exact.length !== 1) return { records, failures };
    const movieId = movieIdFromAddress(exact[0]!.nativeAddress)!;
    const [credits, translations] = await Promise.all([
      this.captureCreditsForRecognition(movieId, accessToken),
      this.captureTranslationsForMetadata(movieId, accessToken),
    ]);
    records.push(...credits.records);
    failures.push(...credits.failures);
    records.push(...translations.records);
    failures.push(...translations.failures);
    return { records, failures };
  }

  private async collectMovie(
    nativeAddress: string,
    accessToken: string,
  ): Promise<SourceCollectionResult> {
    const movieId = movieIdFromAddress(nativeAddress)!;
    const attempts = await Promise.all([
      this.captureForRecognition(
        () => this.captureMovie(movieId, accessToken),
        accessToken,
      ),
      this.captureCreditsForRecognition(movieId, accessToken),
      this.captureTranslationsForMetadata(movieId, accessToken),
    ]);
    return {
      records: attempts.flatMap((attempt) => attempt.records),
      failures: attempts.flatMap((attempt) => attempt.failures),
    };
  }

  private async captureForRecognition(
    capture: () => Promise<SourceRecord>,
    accessToken: string,
  ): Promise<SourceCollectionResult> {
    try {
      return { records: [await capture()], failures: [] };
    } catch (error) {
      return {
        records: [],
        failures: [
          recognitionFailure(
            this.capability,
            `TMDB 官方来源请求失败：${safeTmdbDiagnostic(error, accessToken)}`,
          ),
        ],
      };
    }
  }

  private async captureMovie(
    movieId: string,
    accessToken: string,
  ): Promise<SourceRecord> {
    const endpoint = new URL(`${apiOrigin}/movie/${movieId}`);
    endpoint.searchParams.set("language", "zh-CN");
    endpoint.searchParams.set(
      "append_to_response",
      "alternative_titles,images",
    );
    endpoint.searchParams.set("include_image_language", "zh,null,en");
    return await this.capture(
      endpoint.href,
      movieAddress(movieId),
      "tmdb.movie",
      accessToken,
    );
  }

  private async captureTranslations(
    movieId: string,
    accessToken: string,
  ): Promise<SourceRecord> {
    const endpoint = new URL(`${apiOrigin}/movie/${movieId}/translations`);
    return await this.capture(
      endpoint.href,
      movieAddress(movieId),
      "tmdb.translations",
      accessToken,
    );
  }

  private async captureCredits(
    movieId: string,
    accessToken: string,
  ): Promise<readonly SourceRecord[]> {
    const endpoint = new URL(`${apiOrigin}/movie/${movieId}/credits`);
    endpoint.searchParams.set("language", "zh-CN");
    const leadingCast = await this.capture(
      endpoint.href,
      movieAddress(movieId),
      "tmdb.credits",
      accessToken,
      "incomplete",
    );
    // 一份保留载荷支持两个独立事实范围。来源记录完整性描述的是所声明范围，
    // 而不是正文中的每个字段。
    return [
      {
        ...leadingCast,
        id: `source-record_tmdb_${randomUUID()}`,
        coverage: {
          id: "tmdb.credits.directors",
          completeness: "complete",
          authority: "official",
        },
      },
      leadingCast,
    ];
  }

  private async captureCreditsForRecognition(
    movieId: string,
    accessToken: string,
  ): Promise<SourceCollectionResult> {
    try {
      return {
        records: await this.captureCredits(movieId, accessToken),
        failures: [],
      };
    } catch (error) {
      return {
        records: [],
        failures: [
          recognitionFailure(
            this.capability,
            `TMDB 官方来源请求失败：${safeTmdbDiagnostic(error, accessToken)}`,
          ),
        ],
      };
    }
  }

  /**
   * 本地化标题是描述性证据，而非识别权威。因此补充响应失败不能撤回完整的
   * 影片与演职员表识别路径。
   */
  private async captureTranslationsForMetadata(
    movieId: string,
    accessToken: string,
  ): Promise<SourceCollectionResult> {
    try {
      const record = await this.captureTranslations(movieId, accessToken);
      if (translationResponseMovieId(record.body) === movieId)
        return { records: [record], failures: [] };
      return {
        // 保留官方响应用于检查，但明确标示其主体确认失败。它不能作为来源解释器的
        // 合格完整翻译范围。
        records: [
          {
            ...record,
            coverage: {
              ...record.coverage,
              id: "tmdb.translations.subject-mismatch",
              completeness: "incomplete",
            },
          },
        ],
        failures: [
          {
            capability: this.capability,
            reason: "TMDB 翻译响应未确认电影来源地址",
            affects: { metadataProperties: ["asset.title.alternative"] },
          },
        ],
      };
    } catch (error) {
      return {
        records: [],
        failures: [
          {
            capability: this.capability,
            reason: `TMDB 官方来源请求失败：${safeTmdbDiagnostic(error, accessToken)}`,
            affects: { metadataProperties: ["asset.title.alternative"] },
          },
        ],
      };
    }
  }

  private async capture(
    requestedAddress: string,
    nativeAddress: string,
    coverage: string,
    accessToken: string,
    completeness: SourceRecord["coverage"]["completeness"] = "complete",
  ): Promise<SourceRecord> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.request(requestedAddress, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
    } catch {
      // 请求错误并非安全诊断通道：实现可能暴露 `Authorization` 标头。
      // 保留的执行只需要稳定且可修复的失败分类。
      throw new Error("网络请求未完成");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes)
      throw new Error("响应不符合保存限制");
    const body = redactTmdbResponseBody(
      new TextDecoder().decode(bytes),
      accessToken,
    );
    JSON.parse(body);
    return {
      id: `source-record_tmdb_${randomUUID()}`,
      sourceIdentity: "tmdb",
      nativeAddress,
      // 该采集器保留 JSON 协议证据。不要把任意响应标头映射进来源记录，否则恶意中间方
      // 可能借此回显私有请求材料。
      mediaType: "application/json",
      acquiredAt: new Date().toISOString(),
      acquisition: { requestedAddress, method: "GET", authorized: true },
      coverage: {
        id: coverage,
        completeness,
        authority: "official",
      },
      // 保留正文是之后重新解释的权威，因此其摘要必须描述净化后的正文，
      // 而不是在采集器边界刻意丢弃的私有传输字节。
      digest: createHash("sha256").update(body).digest("hex"),
      body,
    };
  }
}

/** 将一部已验证 TMDB 影片及其完整演职员表响应映射为通用事实。 */
export class TmdbSourceInterpreter implements SourceInterpreter {
  readonly capability = interpreterCapability;

  canInterpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): boolean {
    if (!input.evidence.some((evidence) => evidence.sourceIdentity === "tmdb"))
      return false;
    const details = input.sourceRecords.filter(
      (record) =>
        record.sourceIdentity === "tmdb" && record.coverage.id === "tmdb.movie",
    );
    const strict = input.evidence
      .filter((evidence) => evidence.sourceIdentity === "tmdb")
      .flatMap((evidence) => {
        const address = evidence.sourceAddress;
        return address === undefined ? [] : (parseSearchAddress(address) ?? []);
      })[0];
    if (strict !== undefined) {
      const matched = details.filter((record) =>
        exactMovieMatch(parseMovie(record.body), strict),
      );
      return (
        matched.length === 1 &&
        creditsConfirmMovie(input.sourceRecords, matched[0]!.nativeAddress)
      );
    }
    const exactAddress = input.evidence
      .filter(
        (evidence) =>
          evidence.sourceIdentity === "tmdb" &&
          (evidence.kind === "directed-source-address" ||
            evidence.kind === "source-association"),
      )
      .flatMap((evidence) => {
        const canonical = canonicalDirectedMovieAddress(
          evidence.sourceAddress ?? "",
        );
        return canonical === undefined ? [] : [canonical];
      })[0];
    if (exactAddress === undefined) return false;
    const matched = details.filter((record) => {
      const movie = parseMovie(record.body);
      return (
        record.nativeAddress === exactAddress &&
        movieAddress(movie.id) === exactAddress
      );
    });
    return (
      matched.length === 1 &&
      creditsConfirmMovie(input.sourceRecords, exactAddress)
    );
  }

  interpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): SourceInterpretationBatch {
    const strict = input.evidence
      .filter((evidence) => evidence.sourceIdentity === "tmdb")
      .map((evidence) =>
        evidence.sourceAddress === undefined
          ? undefined
          : parseSearchAddress(evidence.sourceAddress),
      )
      .find((value): value is SearchAddress => value !== undefined);
    const exactAddress = input.evidence
      .filter(
        (evidence) =>
          evidence.sourceIdentity === "tmdb" &&
          (evidence.kind === "directed-source-address" ||
            evidence.kind === "source-association"),
      )
      .flatMap((evidence) => {
        const canonical = canonicalDirectedMovieAddress(
          evidence.sourceAddress ?? "",
        );
        return canonical === undefined ? [] : [canonical];
      })[0];
    const details = input.sourceRecords.filter(
      (record) =>
        record.sourceIdentity === "tmdb" && record.coverage.id === "tmdb.movie",
    );
    const matched = details.filter((record) => {
      const movie = parseMovie(record.body);
      return strict !== undefined
        ? exactMovieMatch(movie, strict)
        : exactAddress !== undefined &&
            record.nativeAddress === exactAddress &&
            movieAddress(movie.id) === exactAddress;
    });
    if (matched.length !== 1)
      throw new Error("TMDB 未返回唯一满足严格标题和年份条件的电影");
    const detail = matched[0]!;
    const movie = parseMovie(detail.body);
    const movieId = movieIdFromAddress(detail.nativeAddress);
    if (
      movieId === undefined ||
      movie.id !== movieId ||
      (strict === undefined && exactAddress !== detail.nativeAddress)
    )
      throw new Error("TMDB 官方记录未确认定向来源地址");
    const credits = input.sourceRecords.find(
      (record) =>
        record.sourceIdentity === "tmdb" &&
        record.coverage.id === "tmdb.credits" &&
        record.nativeAddress === detail.nativeAddress,
    );
    const directorCredits = input.sourceRecords.find(
      (record) =>
        record.sourceIdentity === "tmdb" &&
        record.coverage.id === "tmdb.credits.directors" &&
        record.nativeAddress === detail.nativeAddress,
    );
    if (credits === undefined || directorCredits === undefined)
      throw new Error("TMDB 电影记录缺少完整演职员表响应");
    const parsedCredits = parseCredits(credits.body);
    const parsedDirectorCredits = parseCredits(directorCredits.body);
    if (
      parsedCredits.movieId !== movie.id ||
      parsedDirectorCredits.movieId !== movie.id
    )
      throw new Error("TMDB 演职员表响应未确认电影来源地址");
    const translations = input.sourceRecords.find(
      (record) =>
        record.sourceIdentity === "tmdb" &&
        record.coverage.id === "tmdb.translations" &&
        record.nativeAddress === detail.nativeAddress,
    );
    const localizedTitles =
      translations === undefined
        ? []
        : localizedTitlesFromTranslations(translations.body, movie.id);
    const metadata = [
      ...metadataFromMovie(movie, detail.id),
      ...(translations === undefined
        ? []
        : metadataFromLocalizedTitles(localizedTitles, translations.id)),
    ];
    const sourceArtifacts = artifactCandidates(movie, detail.id);
    const people = new Map<string, SourcedEntity>();
    const relationships: ProposedEntityRelationship[] = [];
    const person = (value: Person, sourceRecordId: string): SourcedEntity => {
      const existing = people.get(value.id);
      if (existing !== undefined) {
        if (existing.sourceRecordIds.includes(sourceRecordId)) return existing;
        const expanded = {
          ...existing,
          sourceRecordIds: [...existing.sourceRecordIds, sourceRecordId],
        };
        people.set(value.id, expanded);
        return expanded;
      }
      const entity: SourcedEntity = {
        id: `entity_tmdb_person_${value.id}`,
        kind: "person",
        sourceIdentity: "tmdb",
        sourceKey: value.id,
        identityNamespace: "tmdb.person",
        label: value.name,
        sourceRecordIds: [sourceRecordId],
      };
      people.set(value.id, entity);
      return entity;
    };
    for (const value of parsedDirectorCredits.crew) {
      if (value.job !== "Director") continue;
      const entity = person(value, directorCredits.id);
      relationships.push({
        participantId: entity.id,
        type: "asset.contribution",
        role: "director",
        sourceSlot: `tmdb.credits.crew.${value.sourceIndex}`,
        sourceRecordIds: [directorCredits.id],
      });
    }
    for (const value of parsedCredits.cast
      .toSorted((left, right) => left.order! - right.order!)
      .slice(0, 10)) {
      const entity = person(value, credits.id);
      relationships.push({
        participantId: entity.id,
        type: "asset.contribution",
        role: "cast",
        sourceSlot: `tmdb.credits.cast.${value.sourceIndex}`,
        sourceRecordIds: [credits.id],
        qualifiers: [
          ...(value.character === undefined
            ? []
            : [{ key: "character", value: value.character }]),
          { key: "tmdb.cast-order", value: String(value.order) },
        ],
      });
    }
    return {
      id: `source-interpretation_tmdb_${randomUUID()}`,
      producer: this.capability,
      sourceRecordIds: [
        detail.id,
        directorCredits.id,
        credits.id,
        ...(translations === undefined ? [] : [translations.id]),
      ],
      sourceIdentity: "tmdb",
      sourceAddress: detail.nativeAddress,
      recognitionEvidenceReferences: (strict === undefined
        ? [detail]
        : input.sourceRecords.filter(
            (record) =>
              record.sourceIdentity === "tmdb" &&
              (record.coverage.id.startsWith("tmdb.search.page.") ||
                record.coverage.id === "tmdb.movie"),
          )
      ).map((record) => ({
        kind: "source-record" as const,
        sourceRecordId: record.id,
      })),
      metadata,
      sourceArtifacts,
      entities: [...people.values()],
      relationships,
    };
  }
}

/** 识别绝不把提供方顺序当作信任依据；该规则精确且有版本。 */
export class TmdbStrictFilmRecognizer implements Recognizer {
  readonly capability = recognizerCapability;
  canRecognize(input: SourceInterpretationBatch): boolean {
    return (
      input.sourceIdentity === "tmdb" &&
      input.producer.capabilityId === interpreterCapability.capabilityId
    );
  }
  recognize(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly interpretation: SourceInterpretationBatch;
  }): RecognitionProposalDraft {
    const strictEvidence = input.evidence.some(
      (evidence) =>
        evidence.sourceIdentity === "tmdb" &&
        evidence.sourceAddress !== undefined &&
        parseSearchAddress(evidence.sourceAddress) !== undefined,
    );
    const directedEvidence = input.evidence.some(
      (evidence) =>
        evidence.kind === "directed-source-address" &&
        evidence.sourceIdentity === "tmdb" &&
        canonicalDirectedMovieAddress(evidence.sourceAddress ?? "") ===
          input.interpretation.sourceAddress,
    );
    const satisfied = strictEvidence || directedEvidence;
    return {
      id: `recognition-proposal_tmdb_${randomUUID()}`,
      ruleResults: [
        {
          ...(directedEvidence
            ? trustedTmdbDirectedFilmRule
            : trustedTmdbStrictFilmRule),
          outcome: satisfied ? "satisfied" : "contradicted",
          explanation: directedEvidence
            ? "用户指定的精确 TMDB 来源地址与官方记录一致"
            : "严格目录标题和年份唯一匹配 TMDB 官方记录",
          evidence: input.evidence,
          ...(input.interpretation.recognitionEvidenceReferences === undefined
            ? {}
            : {
                evidenceReferences:
                  input.interpretation.recognitionEvidenceReferences,
              }),
        },
      ],
    };
  }
}

export class TmdbArtifactAcquirer implements SourceArtifactAcquirer {
  readonly capability = acquirerCapability;
  private readonly request: FetchLike;
  constructor(request: FetchLike = fetch) {
    this.request = request;
  }
  canAcquire(candidate: SourceArtifactCandidate): boolean {
    return canonicalImageAddress(candidate.acquisitionReference) !== undefined;
  }
  async acquire(
    candidate: SourceArtifactCandidate,
  ): Promise<StagedSourceArtifact> {
    if (!this.canAcquire(candidate))
      throw new Error("TMDB 图片候选不是官方 HTTPS 图片地址");
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.request(candidate.acquisitionReference);
    } catch (error) {
      throw new Error(`TMDB 图片请求失败：${message(error)}`, { cause: error });
    }
    if (!response.ok)
      throw new Error(`TMDB 图片请求失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes)
      throw new Error("TMDB 图片不符合保存限制");
    const mediaType = response.headers.get("content-type") ?? "";
    if (mediaTypeEssence(mediaType) !== mediaTypeEssence(candidate.mediaType))
      throw new Error("TMDB 图片响应类型与候选不一致");
    return {
      candidateId: candidate.id,
      sourceRecordId: candidate.sourceRecordId,
      bytes,
      mediaType,
    };
  }
}

function searchAddress(title: string, year: string): string {
  return `tmdb-search:${encodeURIComponent(title)}:${year}`;
}
function parseSearchAddress(value: string): SearchAddress | undefined {
  const match = /^tmdb-search:([^:]+):(\d{4})$/u.exec(value);
  if (match === null) return undefined;
  try {
    const title = decodeURIComponent(match[1]!);
    return title.length === 0 ? undefined : { title, year: match[2]! };
  } catch {
    return undefined;
  }
}
function movieAddress(id: string): string {
  return `${publicOrigin}/movie/${id}`;
}
function movieIdFromAddress(value: string): string | undefined {
  return /^https:\/\/www\.themoviedb\.org\/movie\/([1-9]\d*)$/u.exec(
    value,
  )?.[1];
}
function canonicalDirectedMovieAddress(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.themoviedb.org" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    return undefined;
  const id = /^\/movie\/([1-9]\d*)$/u.exec(parsed.pathname)?.[1];
  return id === undefined ? undefined : movieAddress(id);
}
function canonicalImageAddress(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  return parsed.protocol === "https:" &&
    parsed.hostname === "image.tmdb.org" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    /^\/t\/p\/original\/.+/u.test(parsed.pathname) &&
    parsed.search === "" &&
    parsed.hash === ""
    ? parsed.href
    : undefined;
}
function parseSearchPage(body: string): {
  readonly page: number;
  readonly totalPages: number;
  readonly movieIds: readonly string[];
} {
  const parsed = JSON.parse(body) as {
    readonly page?: unknown;
    readonly total_pages?: unknown;
    readonly results?: unknown;
  };
  const positiveInteger = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : undefined;
  const nonNegativeInteger = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  const page = positiveInteger(parsed.page);
  const totalPages = nonNegativeInteger(parsed.total_pages);
  const movieIds = (
    Array.isArray(parsed.results) ? parsed.results : []
  ).flatMap((value) => {
    const id = positiveInteger((value as { readonly id?: unknown }).id);
    return id === undefined ? [] : [String(id)];
  });
  if (
    page === undefined ||
    totalPages === undefined ||
    (totalPages === 0 ? page !== 1 || movieIds.length !== 0 : page > totalPages)
  )
    throw new Error("TMDB 搜索响应没有有效分页信息");
  return {
    page,
    totalPages,
    movieIds,
  };
}
type Movie = {
  readonly id: string;
  readonly title?: string;
  readonly originalTitle?: string;
  readonly overview?: string;
  readonly releaseDate?: string;
  readonly runtime?: number;
  readonly genres: readonly SourcedText[];
  readonly posterPath?: string;
  readonly backdropPath?: string;
  readonly alternatives: readonly SourcedText[];
  readonly imdbId?: string;
};
type SourcedText = {
  readonly value: string;
  readonly sourceIndex: number;
  readonly qualifiers?: readonly {
    readonly key: string;
    readonly value: string;
  }[];
};
function parseMovie(body: string): Movie {
  const value = JSON.parse(body) as Record<string, unknown>;
  const id =
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0
      ? String(value.id)
      : undefined;
  if (id === undefined) throw new Error("TMDB 电影响应没有有效标识");
  // 逐字节保留有意义的来源文本，以进行严格身份比较。仅含空白的传输值没有语义，应省略。
  const strings = (input: unknown) =>
    typeof input === "string" && input.trim().length > 0 ? input : undefined;
  const title = strings(value.title);
  const originalTitle = strings(value.original_title);
  const overview = strings(value.overview);
  const releaseDate = strings(value.release_date);
  const runtime =
    typeof value.runtime === "number" &&
    Number.isInteger(value.runtime) &&
    value.runtime > 0
      ? value.runtime
      : undefined;
  const posterPath = strings(value.poster_path);
  const backdropPath = strings(value.backdrop_path);
  const images = value.images as
    | { readonly posters?: unknown; readonly backdrops?: unknown }
    | undefined;
  const imagePath = (items: unknown) =>
    (Array.isArray(items) ? items : [])
      .map((item) =>
        strings((item as { readonly file_path?: unknown }).file_path),
      )
      .find((item) => item !== undefined);
  const selectedPosterPath = posterPath ?? imagePath(images?.posters);
  const selectedBackdropPath = backdropPath ?? imagePath(images?.backdrops);
  const imdbId = strings(value.imdb_id);
  return {
    id,
    ...(title === undefined ? {} : { title }),
    ...(originalTitle === undefined ? {} : { originalTitle }),
    ...(overview === undefined ? {} : { overview }),
    ...(releaseDate === undefined ? {} : { releaseDate }),
    ...(runtime === undefined ? {} : { runtime }),
    genres: (Array.isArray(value.genres) ? value.genres : []).flatMap(
      (genre, sourceIndex) => {
        const name = strings((genre as { readonly name?: unknown }).name);
        return name === undefined ? [] : [{ value: name, sourceIndex }];
      },
    ),
    ...(selectedPosterPath === undefined
      ? {}
      : { posterPath: selectedPosterPath }),
    ...(selectedBackdropPath === undefined
      ? {}
      : { backdropPath: selectedBackdropPath }),
    alternatives: (Array.isArray(
      (value.alternative_titles as { readonly titles?: unknown } | undefined)
        ?.titles,
    )
      ? (value.alternative_titles as { readonly titles: unknown[] }).titles
      : []
    ).flatMap((item, sourceIndex) => {
      const alternative = strings((item as { readonly title?: unknown }).title);
      return alternative === undefined
        ? []
        : [{ value: alternative, sourceIndex }];
    }),
    ...(imdbId === undefined ? {} : { imdbId }),
  };
}

function localizedTitlesFromTranslations(
  body: string,
  expectedMovieId: string,
): readonly SourcedText[] {
  const value = JSON.parse(body) as Record<string, unknown>;
  const movieId = translationResponseMovieId(body);
  if (movieId !== expectedMovieId) return [];
  return (Array.isArray(value.translations) ? value.translations : []).flatMap(
    (entry, sourceIndex) => {
      const title = (entry as { readonly data?: { readonly title?: unknown } })
        .data?.title;
      const source = entry as {
        readonly iso_639_1?: unknown;
        readonly iso_3166_1?: unknown;
      };
      const qualifier = (key: string, value: unknown) =>
        typeof value === "string" && value.trim().length > 0
          ? [{ key, value: value.trim() }]
          : [];
      const qualifiers = [
        ...qualifier("language", source.iso_639_1),
        ...qualifier("region", source.iso_3166_1),
      ];
      return typeof title !== "string" || title.trim().length === 0
        ? []
        : [
            {
              value: title.trim(),
              sourceIndex,
              ...(qualifiers.length === 0 ? {} : { qualifiers }),
            },
          ];
    },
  );
}

function translationResponseMovieId(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    return typeof value.id === "number" &&
      Number.isSafeInteger(value.id) &&
      value.id > 0
      ? String(value.id)
      : undefined;
  } catch {
    return undefined;
  }
}
function exactMovieMatch(movie: Movie, search: SearchAddress): boolean {
  const titles = [
    movie.title,
    movie.originalTitle,
    ...movie.alternatives.map((alternative) => alternative.value),
  ].flatMap((value) => (value === undefined ? [] : [value]));
  return (
    movie.releaseDate?.slice(0, 4) === search.year &&
    titles.some(
      (title) => title.normalize("NFC") === search.title.normalize("NFC"),
    )
  );
}
type Person = {
  readonly id: string;
  readonly name: string;
  readonly job?: string;
  readonly character?: string;
  readonly order?: number;
  readonly sourceIndex: number;
};
function parseCredits(body: string): {
  readonly movieId: string;
  readonly crew: readonly Person[];
  readonly cast: readonly Person[];
} {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const movieId =
    typeof parsed.id === "number" &&
    Number.isSafeInteger(parsed.id) &&
    parsed.id > 0
      ? String(parsed.id)
      : undefined;
  if (movieId === undefined)
    throw new Error("TMDB 演职员表响应没有有效电影标识");
  const people = (input: unknown, extras: "crew" | "cast") =>
    (Array.isArray(input) ? input : []).flatMap((value, sourceIndex) => {
      const item = value as Record<string, unknown>;
      const id =
        typeof item.id === "number" &&
        Number.isSafeInteger(item.id) &&
        item.id > 0
          ? String(item.id)
          : undefined;
      const text = (value: unknown) =>
        typeof value === "string" && value.trim().length > 0
          ? value.trim()
          : undefined;
      const name = text(item.name);
      const job = text(item.job);
      const character = text(item.character);
      const order =
        typeof item.order === "number" &&
        Number.isSafeInteger(item.order) &&
        item.order >= 0
          ? item.order
          : undefined;
      return id === undefined ||
        name === undefined ||
        (extras === "cast" && order === undefined)
        ? []
        : [
            {
              id,
              name,
              sourceIndex,
              ...(extras === "crew" && job !== undefined ? { job } : {}),
              ...(extras === "cast" && character !== undefined
                ? { character }
                : {}),
              ...(extras === "cast" ? { order: order! } : {}),
            },
          ];
    });
  return {
    movieId,
    crew: people(parsed.crew, "crew"),
    cast: people(parsed.cast, "cast"),
  };
}

function creditsConfirmMovie(
  sourceRecords: readonly SourceRecord[],
  nativeAddress: string,
): boolean {
  const expectedMovieId = movieIdFromAddress(nativeAddress);
  const credits = ["tmdb.credits.directors", "tmdb.credits"].map((coverageId) =>
    sourceRecords.find(
      (record) =>
        record.sourceIdentity === "tmdb" &&
        record.coverage.id === coverageId &&
        record.nativeAddress === nativeAddress,
    ),
  );
  return (
    expectedMovieId !== undefined &&
    credits.every(
      (record) =>
        record !== undefined &&
        parseCredits(record.body).movieId === expectedMovieId,
    )
  );
}
function metadataFromMovie(movie: Movie, sourceRecordId: string) {
  const facts: {
    property: string;
    sourceSlot: string;
    value: string;
    sourceRecordIds: readonly string[];
  }[] = [];
  const add = (
    property: string,
    sourceSlot: string,
    value: string | undefined,
  ) => {
    const projected = value?.trim();
    if (projected !== undefined && projected.length > 0)
      facts.push({
        property,
        sourceSlot,
        value: projected,
        sourceRecordIds: [sourceRecordId],
      });
  };
  add("asset.title", "tmdb.movie.title", movie.title);
  add("asset.title.original", "tmdb.movie.original-title", movie.originalTitle);
  add("asset.introduction", "tmdb.movie.overview", movie.overview);
  add("asset.release-date", "tmdb.movie.release-date", movie.releaseDate);
  add(
    "asset.runtime-minutes",
    "tmdb.movie.runtime",
    movie.runtime === undefined ? undefined : String(movie.runtime),
  );
  add("tmdb.movie.id", "tmdb.movie.id", movie.id);
  // 该值是通用外部标识符，其来源记录和槽保留 TMDB 溯源；它不是与该目录的关联。
  add("external.imdb-id", "tmdb.movie.imdb-id", movie.imdbId);
  for (const alternative of movie.alternatives)
    add(
      "asset.title.alternative",
      `tmdb.movie.alternative-title.${alternative.sourceIndex}`,
      alternative.value,
    );
  for (const genre of movie.genres)
    add("asset.genre", `tmdb.movie.genre.${genre.sourceIndex}`, genre.value);
  return facts;
}

function metadataFromLocalizedTitles(
  titles: readonly SourcedText[],
  sourceRecordId: string,
) {
  return titles.map((title) => ({
    property: "asset.title.alternative",
    sourceSlot: `tmdb.translations.title.${title.sourceIndex}`,
    value: title.value,
    sourceRecordIds: [sourceRecordId],
    ...(title.qualifiers === undefined ? {} : { qualifiers: title.qualifiers }),
  }));
}
function artifactCandidates(
  movie: Movie,
  sourceRecordId: string,
): readonly SourceArtifactCandidate[] {
  const candidate = (
    id: string,
    role: string,
    path: string | undefined,
  ): SourceArtifactCandidate[] =>
    path === undefined || !/^\/[A-Za-z0-9._-]+$/u.test(path)
      ? []
      : [
          {
            id,
            sourceRecordId,
            role,
            acquisitionReference: `${imageOrigin}${path}`,
            mediaType: imageMediaType(path),
          },
        ];
  return [
    ...candidate(
      "tmdb.primary-poster",
      "asset.primary-cover",
      movie.posterPath,
    ),
    ...candidate("tmdb.backdrop", "asset.background", movie.backdropPath),
  ];
}
function imageMediaType(path: string): string {
  if (path.toLowerCase().endsWith(".png")) return "image/png";
  if (path.toLowerCase().endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
function failed(
  capability: CapabilityCoordinate,
  reason: string,
): SourceCollectionResult {
  return { records: [], failures: [{ capability, reason }] };
}
function recognitionFailure(
  capability: CapabilityCoordinate,
  reason: string,
): SourceCollectionResult["failures"][number] {
  return { capability, reason, affects: { recognition: true } };
}
function mediaTypeEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 保留有用的 HTTP/模式诊断，同时绝不保留不记名凭据值。 */
function safeTmdbDiagnostic(error: unknown, accessToken: string): string {
  return message(error)
    .replaceAll(accessToken, "[REDACTED]")
    .replace(/Bearer\s+[^\s]+/gu, "Bearer [REDACTED]");
}

/**
 * TMDB 响应本不应回显授权材料，但外部来源是不可信边界。响应成为领域来源记录前，
 * 应移除精确的私有令牌；领域层和应用层刻意不知道该能力使用了不记名凭据。
 */
function redactTmdbResponseBody(body: string, accessToken: string): string {
  const representations = new Set([
    accessToken,
    JSON.stringify(accessToken).slice(1, -1),
    encodeURIComponent(accessToken),
  ]);
  let sanitized = body;
  for (const representation of representations) {
    if (representation.length > 0)
      sanitized = sanitized.replaceAll(representation, "[REDACTED]");
  }
  return sanitized;
}
