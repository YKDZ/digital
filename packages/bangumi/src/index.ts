import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  type AssetRefreshWorkPlan,
  type DirectoryInterpreter,
  type FilesystemPackageSnapshot,
  type Recognizer,
  type SourceCollectionExecutionContext,
  type SourceArtifactAcquirer,
  type SourceCollectionResult,
  type SourceCollector,
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

const maximumResponseBytes = 2 * 1024 * 1024;
const apiOrigin = "https://api.bgm.tv/v0";

const directoryCapability = declareCapability({
  identity: "bangumi.episodic-directory",
  implementationVersion: "1",
  kind: "directory-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
export const bangumiOfficialCollectionCapability = declareCapability({
  identity: "bangumi.official-collection",
  implementationVersion: "1",
  kind: "source-collector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const collectorCapability = bangumiOfficialCollectionCapability;
export const bangumiSourceConnectionCapability = declareCapability({
  identity: "bangumi.source-connection",
  implementationVersion: "1",
  kind: "source-connection",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const interpreterCapability = declareCapability({
  identity: "bangumi.episodic-interpretation",
  implementationVersion: "1",
  kind: "source-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const recognizerCapability = declareCapability({
  identity: "bangumi.episodic-recognizer",
  implementationVersion: "1",
  kind: "recognizer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const acquirerCapability = declareCapability({
  identity: "bangumi.source-artifact-acquirer",
  implementationVersion: "1",
  kind: "source-artifact-acquirer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

/** Product composition, never the integration itself, admits this exact rule. */
export const trustedBangumiEpisodicRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "title-year-season-ordinary-episode",
  ruleVersion: "1",
} as const;

type EpisodeEvidence = RecognitionEvidence & {
  readonly kind: "bangumi.episodic-directory/v1";
  readonly sourceIdentity: "bangumi";
  readonly sourceAddress: string;
};

/**
 * The convention owns only local structural evidence. It deliberately does
 * not turn a directory into a Domain season or infer special-entry semantics.
 */
export class BangumiEpisodicDirectoryInterpreter implements DirectoryInterpreter {
  readonly capability = directoryCapability;

  interpret(
    snapshot: FilesystemPackageSnapshot,
  ): AssetRefreshWorkPlan | readonly RecognitionEvidence[] {
    const root = /^(.+?) \((\d{4})\)$/u.exec(baseName(snapshot.root));
    // An empty evidence list means this convention is simply not applicable.
    // An explicit empty plan is malformed at the Application boundary because
    // it would claim to have selected an asset boundary without selecting one.
    if (root === null) return [];

    const title = root[1]!;
    const year = root[2]!;
    const workItems = snapshot.files.flatMap((file) => {
      const entry =
        /^Season ([1-9]\d*)\/(.+?) - S(\d{2})E(\d{2})(?: - 第 (\d+) 集)?(\.[^/]+)$/u.exec(
          file.relativePath,
        );
      if (entry === null) return [];
      const seasonText = entry[1]!;
      const observedTitle = entry[2]!;
      const markerSeason = entry[3]!;
      const episodeText = entry[4]!;
      const displayedEpisode = entry[5];
      const season = Number(seasonText);
      const marker = Number(markerSeason);
      const episode = Number(episodeText);

      if (
        season < 1 ||
        marker !== season ||
        episode < 1 ||
        (displayedEpisode !== undefined &&
          Number(displayedEpisode) !== episode) ||
        normalize(observedTitle) !== normalize(title)
      )
        return [];

      const evidence: EpisodeEvidence = {
        kind: "bangumi.episodic-directory/v1",
        sourceIdentity: "bangumi",
        sourceAddress: directoryAddress(title, year, season, episode),
        explanation: `Bangumi 普通正片目录约定 v1：${title} (${year}) Season ${season} S${markerSeason}E${episodeText}`,
        producer: this.capability,
      };

      return [
        {
          key: `bangumi:season-${season}:episode-${episode}`,
          relativePaths: [file.relativePath],
          evidence: [evidence],
        },
      ];
    });
    return workItems.length === 0 ? [] : { workItems };
  }
}

export type BangumiOAuthTransport = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type FetchLike = BangumiOAuthTransport;

const bangumiAuthorizationEndpoint = "https://bgm.tv/oauth/authorize";
const bangumiTokenEndpoint = "https://bgm.tv/oauth/access_token";

export type BangumiOAuthGrant = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
};

/**
 * A sanitized protocol classification for the private connection adapter.
 * It deliberately retains no response body, headers, tokens, or credentials.
 */
export class BangumiOAuthGrantRequestFailure extends Error {
  readonly kind:
    | "authorization-rejected"
    | "transport-uncertain"
    | "retryable-response"
    | "response-invalid";

  constructor(
    kind:
      | "authorization-rejected"
      | "transport-uncertain"
      | "retryable-response"
      | "response-invalid",
  ) {
    super("Bangumi OAuth token request failed");
    this.kind = kind;
  }
}

export function isBangumiOAuthAuthorizationRejected(
  error: unknown,
): error is BangumiOAuthGrantRequestFailure {
  return (
    error instanceof BangumiOAuthGrantRequestFailure &&
    error.kind === "authorization-rejected"
  );
}

/**
 * A complete HTTP response proves the token endpoint processed this request
 * enough to answer it.  The product may use its source retry policy for this
 * class; a transport abort intentionally remains authorization-uncertain.
 */
export function isBangumiOAuthRetryableResponse(
  error: unknown,
): error is BangumiOAuthGrantRequestFailure {
  return (
    error instanceof BangumiOAuthGrantRequestFailure &&
    error.kind === "retryable-response"
  );
}

/**
 * Bangumi documents an OAuth 2.0 authorization-code flow.  Its documented
 * authorization parameters include `state`, but not PKCE parameters, so this
 * integration deliberately sends only the source-supported contract.
 */
export function createBangumiOAuthAuthorizationRequest(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const endpoint = new URL(bangumiAuthorizationEndpoint);
  endpoint.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
  }).toString();
  return endpoint.toString();
}

/** Exchanges one callback code using Bangumi's documented form contract. */
export async function exchangeBangumiOAuthAuthorizationCode(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly state: string;
  readonly request?: BangumiOAuthTransport;
  readonly now?: () => Date;
}): Promise<BangumiOAuthGrant> {
  return await requestBangumiOAuthGrant({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    redirectUri: input.redirectUri,
    request: input.request,
    now: input.now,
    failurePrefix: "Bangumi OAuth authorization exchange",
    parameters: {
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
      state: input.state,
    },
  });
}

/** Refreshes a private grant without exposing it to collector callers. */
export async function refreshBangumiOAuthGrant(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly refreshToken: string;
  readonly request?: BangumiOAuthTransport;
  readonly now?: () => Date;
}): Promise<BangumiOAuthGrant> {
  return await requestBangumiOAuthGrant({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    redirectUri: input.redirectUri,
    request: input.request,
    now: input.now,
    failurePrefix: "Bangumi OAuth refresh",
    parameters: {
      grant_type: "refresh_token",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      refresh_token: input.refreshToken,
    },
  });
}

async function requestBangumiOAuthGrant(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly request: BangumiOAuthTransport | undefined;
  readonly now: (() => Date) | undefined;
  readonly failurePrefix: string;
  readonly parameters: Readonly<Record<string, string>>;
}): Promise<BangumiOAuthGrant> {
  if (
    input.clientId.trim().length === 0 ||
    input.clientSecret.trim().length === 0 ||
    input.redirectUri.trim().length === 0
  ) {
    throw new Error(`${input.failurePrefix} requires client configuration`);
  }
  let response: Awaited<ReturnType<BangumiOAuthTransport>>;
  try {
    response = await (input.request ?? fetch)(bangumiTokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(input.parameters).toString(),
    });
  } catch {
    // The transport interface cannot prove whether bytes reached Bangumi. A
    // refresh token may already have rotated, so callers must not retry it.
    throw new BangumiOAuthGrantRequestFailure("transport-uncertain");
  }
  if (!response.ok) {
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    )
      throw new BangumiOAuthGrantRequestFailure("retryable-response");
    if (await isOAuthAuthorizationRejection(response)) {
      throw new BangumiOAuthGrantRequestFailure("authorization-rejected");
    }
    throw new BangumiOAuthGrantRequestFailure("response-invalid");
  }
  let body: Record<string, unknown> | undefined;
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes)
      throw new Error("invalid response");
    body = object(json(new TextDecoder().decode(bytes)));
  } catch {
    throw new BangumiOAuthGrantRequestFailure("response-invalid");
  }
  const accessToken = nonEmptyText(body?.access_token);
  const refreshToken = nonEmptyText(body?.refresh_token);
  const expiresIn = integer(body?.expires_in);
  if (
    accessToken === undefined ||
    refreshToken === undefined ||
    expiresIn === undefined ||
    expiresIn < 1
  ) {
    throw new BangumiOAuthGrantRequestFailure("response-invalid");
  }
  const now = input.now ?? (() => new Date());
  const expiresAt = new Date(now().getTime() + expiresIn * 1000);
  if (!Number.isFinite(expiresAt.getTime()))
    throw new BangumiOAuthGrantRequestFailure("response-invalid");
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAt.toISOString(),
  };
}

async function isOAuthAuthorizationRejection(
  response: Awaited<ReturnType<BangumiOAuthTransport>>,
): Promise<boolean> {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes)
      return false;
    const body = object(json(new TextDecoder().decode(bytes)));
    // RFC 6749 defines invalid_grant as an invalid, expired, revoked, or
    // otherwise unacceptable refresh grant. Other 4xx responses can be a
    // transient deployment/configuration problem and must not burn a grant.
    return body?.error === "invalid_grant";
  } catch {
    return false;
  }
}

/** A narrow private authorization capability; grants are never returned. */
type PrivateAuthorization = {
  readonly bearer: (
    context?: SourceCollectionExecutionContext,
  ) => Promise<string>;
};

export type BangumiCollectorOptions = {
  /** Composition may inject a package-private OAuth capability. */
  readonly authorization?: {
    readonly bearer: (
      context?: SourceCollectionExecutionContext,
    ) => Promise<string>;
  };
  readonly request?: BangumiOAuthTransport;
};

/** Captures every endpoint response separately; there is no synthetic payload. */
export class BangumiCollector implements SourceCollector {
  readonly capability = collectorCapability;
  private readonly request: FetchLike;
  private readonly authorization: PrivateAuthorization | undefined;

  constructor(options: BangumiCollectorOptions = {}) {
    this.request = options.request ?? fetch;
    this.authorization = options.authorization;
  }

  canCollect(evidence: RecognitionEvidence): boolean {
    return (
      evidence.sourceIdentity === "bangumi" &&
      evidence.sourceAddress !== undefined &&
      (evidence.kind === "bangumi.episodic-directory/v1" ||
        (evidence.kind === "source-association" &&
          parseEpisodeAddress(evidence.sourceAddress) !== undefined) ||
        evidence.kind === "directed-source-address")
    );
  }

  coverageScopeIds(evidence: RecognitionEvidence): readonly string[] {
    const episodeId = parseEpisodeAddress(evidence.sourceAddress);
    return episodeId === undefined ? [] : [`bangumi.episode:${episodeId}`];
  }

  collectionScopeIds(evidence: RecognitionEvidence): readonly string[] {
    const parsed = parseDirectoryAddress(evidence.sourceAddress);
    return parsed === undefined
      ? []
      : [`bangumi.root:${parsed.title}:${parsed.year}`];
  }

  async collectShared(
    evidence: readonly RecognitionEvidence[],
    context?: SourceCollectionExecutionContext,
  ): Promise<SourceCollectionResult> {
    const targets = evidence.flatMap((item) => {
      const parsed = parseDirectoryAddress(item.sourceAddress);
      return parsed === undefined ? [] : [parsed];
    });
    if (targets.length === 0)
      return failure(
        this.capability,
        "Bangumi shared collection requires episodic directory evidence",
      );
    const first = targets[0]!;
    if (
      !targets.every(
        (item) => item.title === first.title && item.year === first.year,
      )
    )
      return failure(
        this.capability,
        "Bangumi shared collection scope contains different roots",
      );
    const maximumSeason = Math.max(...targets.map((item) => item.season));
    const representative = evidence.find(
      (item) =>
        parseDirectoryAddress(item.sourceAddress)?.season === maximumSeason,
    );
    const collected = await this.collect(
      {
        ...(representative ?? evidence[0]!),
        sourceAddress: directoryAddress(
          first.title,
          first.year,
          maximumSeason,
          1,
        ),
      },
      context,
    );
    if (collected.failures.length > 0) return collected;
    const records = [...collected.records];
    let token: string | undefined;
    try {
      token =
        this.authorization === undefined
          ? undefined
          : await this.authorization.bearer(context);
      for (const target of targets)
        await this.captureTargetEpisode(target, token, records);
      return { records, failures: [] };
    } catch (error) {
      return {
        records,
        failures: [
          {
            capability: this.capability,
            reason: `Bangumi official source request failed: ${message(error)}`,
          },
        ],
      };
    }
  }

  async collect(
    evidence: RecognitionEvidence,
    context?: SourceCollectionExecutionContext,
  ): Promise<SourceCollectionResult> {
    const target = parseDirectoryAddress(evidence.sourceAddress);
    const knownEpisodeId = parseEpisodeAddress(evidence.sourceAddress);
    if (
      !this.canCollect(evidence) ||
      (target === undefined && knownEpisodeId === undefined)
    )
      return failure(
        this.capability,
        "Bangumi collection requires episodic directory evidence",
      );
    let token: string | undefined;
    try {
      token =
        this.authorization === undefined
          ? undefined
          : await this.authorization.bearer(context);
    } catch (error) {
      return failure(
        this.capability,
        `Bangumi authorization failed: ${message(error)}`,
      );
    }
    const records: SourceRecord[] = [];
    try {
      if (knownEpisodeId !== undefined) {
        records.push(
          await this.capture({
            address: `${apiOrigin}/episodes/${knownEpisodeId}`,
            nativeAddress: episodeAddress(knownEpisodeId),
            coverage: `bangumi.episode:${knownEpisodeId}`,
            token,
          }),
        );
        return { records, failures: [] };
      }
      if (target === undefined)
        return failure(
          this.capability,
          "Bangumi collection requires a supported source address",
        );
      const search = await this.capture({
        address: `${apiOrigin}/search/subjects`,
        nativeAddress: `bangumi:search:${encodeURIComponent(target.title)}:${target.year}`,
        coverage: "bangumi.subject-search",
        token,
        method: "POST",
        body: JSON.stringify({ keyword: target.title, filter: { type: [2] } }),
      });
      const candidates = searchSubjects(search.body).filter((subject) =>
        subjectMatchesRoot(subject, target),
      );
      records.push(search);
      for (const candidate of candidates) {
        await this.collectSubjectGraph(
          candidate.id,
          target.season,
          token,
          records,
          new Set(),
          1,
        );
      }
      await this.captureTargetEpisode(target, token, records);
      return { records, failures: [] };
    } catch (error) {
      return {
        records,
        failures: [
          {
            capability: this.capability,
            reason: `Bangumi official source request failed: ${message(error)}`,
          },
        ],
      };
    }
  }

  private async captureTargetEpisode(
    target: {
      readonly title: string;
      readonly year: string;
      readonly season: number;
      readonly episode: number;
    },
    token: string | undefined,
    records: SourceRecord[],
  ): Promise<void> {
    const roots = subjectRecords(records).filter((item) =>
      subjectMatchesRoot(item.subject, target),
    );
    if (roots.length !== 1) return;
    const chain = resolveSeasonChain(
      roots[0]!.subject.id,
      target.season,
      target.episode,
      records,
    );
    if (chain === undefined) return;
    const episodes = ordinaryEpisodes(chain.at(-1)!, records).filter(
      (episode) => episode.ep === target.episode,
    );
    if (episodes.length !== 1) return;
    const episode = episodes[0]!;
    if (
      records.some(
        (record) => record.coverage.id === `bangumi.episode:${episode.id}`,
      )
    )
      return;
    records.push(
      await this.capture({
        address: `${apiOrigin}/episodes/${episode.id}`,
        nativeAddress: episodeAddress(episode.id),
        coverage: `bangumi.episode:${episode.id}`,
        token,
      }),
    );
  }

  private async collectSubjectGraph(
    subjectId: number,
    maximumSeason: number,
    token: string | undefined,
    records: SourceRecord[],
    path: ReadonlySet<number>,
    depth: number,
  ): Promise<void> {
    if (path.has(subjectId)) return;
    const nextPath = new Set(path).add(subjectId);
    const nativeAddress = subjectAddress(subjectId);
    const subject = await this.capture({
      address: `${apiOrigin}/subjects/${subjectId}`,
      nativeAddress,
      coverage: `bangumi.subject:${subjectId}`,
      token,
    });
    records.push(subject);
    const relations = await this.capture({
      address: `${apiOrigin}/subjects/${subjectId}/subjects`,
      nativeAddress,
      coverage: `bangumi.relationships:${subjectId}`,
      token,
    });
    records.push(relations);
    for (let offset = 0; ; offset += 100) {
      const page = await this.capture({
        address: `${apiOrigin}/episodes?subject_id=${subjectId}&type=0&limit=100&offset=${offset}`,
        nativeAddress,
        coverage: `bangumi.ordinary-episodes:${subjectId}:${offset}`,
        token,
      });
      records.push(page);
      const parsed = episodesPage(page.body);
      if (
        offset + parsed.data.length >= parsed.total ||
        parsed.data.length === 0
      )
        break;
    }
    if (depth >= maximumSeason) return;
    for (const related of relatedSubjects(relations.body).filter(
      (item) => item.relation === "续集",
    ))
      await this.collectSubjectGraph(
        related.id,
        maximumSeason,
        token,
        records,
        nextPath,
        depth + 1,
      );
  }

  private async capture(input: {
    readonly address: string;
    readonly nativeAddress: string;
    readonly coverage: string;
    readonly token: string | undefined;
    readonly method?: "GET" | "POST";
    readonly body?: string;
  }): Promise<SourceRecord> {
    const response = await this.request(input.address, {
      method: input.method ?? "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "digital-asset-refresh/1",
        ...(input.token === undefined
          ? {}
          : { Authorization: `Bearer ${input.token}` }),
        ...(input.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes)
      throw new Error("response did not meet the bounded capture limit");
    return {
      id: `source-record_${randomUUID()}`,
      sourceIdentity: "bangumi",
      nativeAddress: input.nativeAddress,
      mediaType: response.headers.get("content-type") ?? "application/json",
      acquiredAt: new Date().toISOString(),
      acquisition: {
        requestedAddress: input.address,
        method: input.method ?? "GET",
        authorized: input.token !== undefined,
      },
      coverage: {
        id: input.coverage,
        completeness: "complete",
        authority: "official",
      },
      digest: createHash("sha256").update(bytes).digest("hex"),
      body: new TextDecoder().decode(bytes),
    };
  }
}

/** A deterministic interpretation of one ordinary episode boundary. */
export class BangumiSourceInterpreter implements SourceInterpreter {
  readonly capability = interpreterCapability;

  canInterpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): boolean {
    return (
      input.evidence.some(
        (evidence) =>
          isEpisodeEvidence(evidence) ||
          (evidence.kind === "source-association" &&
            parseEpisodeAddress(evidence.sourceAddress) !== undefined),
      ) &&
      input.sourceRecords.some((record) => record.sourceIdentity === "bangumi")
    );
  }

  interpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): SourceInterpretationBatch {
    const evidence = input.evidence.find(isEpisodeEvidence);
    const associated = input.evidence.find(
      (item) =>
        item.kind === "source-association" &&
        parseEpisodeAddress(item.sourceAddress) !== undefined,
    );
    const records = input.sourceRecords.filter(
      (record) => record.sourceIdentity === "bangumi",
    );
    const associatedEpisodeId = parseEpisodeAddress(associated?.sourceAddress);
    if (evidence === undefined && associatedEpisodeId !== undefined)
      return this.interpretKnownEpisode(
        associated!,
        records,
        associatedEpisodeId,
      );
    if (evidence === undefined)
      throw new Error(
        "Bangumi interpretation requires episodic directory evidence",
      );
    const target = parseDirectoryAddress(evidence.sourceAddress);
    if (target === undefined)
      throw new Error("Bangumi directory evidence is malformed");
    const subjects = subjectRecords(records).filter((item) =>
      subjectMatchesRoot(item.subject, target),
    );
    if (subjects.length !== 1)
      throw new Error(
        "Bangumi root title/year did not resolve to one compatible subject",
      );
    const root = subjects[0]!;
    const chain = resolveSeasonChain(
      root.subject.id,
      target.season,
      target.episode,
      records,
    );
    if (chain === undefined)
      throw new Error(
        "Bangumi season lacks a unique compatible relationship path",
      );
    const seasonSubject = subjectById(chain.at(-1)!, records);
    if (seasonSubject === undefined)
      throw new Error("Bangumi compatible season subject was not captured");
    const episodes = ordinaryEpisodes(seasonSubject.id, records).filter(
      (episode) => episode.ep === target.episode,
    );
    if (episodes.length !== 1)
      throw new Error("Bangumi ordinary episode identity is not unique");
    const episode = episodes[0]!;
    const subjectRecord = subjectRecordFor(seasonSubject.id, records);
    const episodeRecord = episodeRecordFor(
      seasonSubject.id,
      episode.id,
      records,
    );
    if (subjectRecord === undefined || episodeRecord === undefined)
      throw new Error("Bangumi episode provenance was not captured");
    const works = chain.flatMap((subjectId) => {
      const subject = subjectById(subjectId, records);
      const record = subjectRecordFor(subjectId, records);
      return subject === undefined || record === undefined
        ? []
        : [workEntity(subject, record)];
    });
    const work = works.find(
      (item) => item.sourceKey === String(seasonSubject.id),
    );
    if (work === undefined)
      throw new Error("Bangumi compatible season work was not captured");
    const metadata = [
      assertion(
        "asset.title",
        "bangumi.episode.name",
        episode.name,
        episodeRecord.id,
      ),
      ...(nonEmpty(episode.name_cn) === undefined
        ? []
        : [
            assertion(
              "asset.title.zh-hans",
              "bangumi.episode.name-cn",
              episode.name_cn!,
              episodeRecord.id,
            ),
          ]),
      ...(nonEmpty(episode.desc) === undefined
        ? []
        : [
            assertion(
              "asset.description",
              "bangumi.episode.description",
              episode.desc!,
              episodeRecord.id,
            ),
          ]),
      ...(nonEmpty(episode.airdate) === undefined
        ? []
        : [
            assertion(
              "asset.release-date",
              "bangumi.episode.date",
              episode.airdate!,
              episodeRecord.id,
            ),
          ]),
      assertion(
        "bangumi.episode.season-position",
        "bangumi.episode.ep",
        String(episode.ep),
        episodeRecord.id,
      ),
      assertion(
        "bangumi.episode.continuous-position",
        "bangumi.episode.sort",
        String(episode.sort),
        episodeRecord.id,
      ),
      assertion(
        "bangumi.subject.name",
        "bangumi.subject.name",
        seasonSubject.name,
        subjectRecord.id,
        work.id,
      ),
      ...(nonEmpty(seasonSubject.name_cn) === undefined
        ? []
        : [
            assertion(
              "bangumi.subject.name.zh-hans",
              "bangumi.subject.name-cn",
              seasonSubject.name_cn!,
              subjectRecord.id,
              work.id,
            ),
          ]),
      ...(nonEmpty(seasonSubject.summary) === undefined
        ? []
        : [
            assertion(
              "bangumi.subject.description",
              "bangumi.subject.summary",
              seasonSubject.summary!,
              subjectRecord.id,
              work.id,
            ),
          ]),
      ...(nonEmpty(seasonSubject.date) === undefined
        ? []
        : [
            assertion(
              "bangumi.subject.date",
              "bangumi.subject.date",
              seasonSubject.date!,
              subjectRecord.id,
              work.id,
            ),
          ]),
    ];
    const relationships: ProposedEntityRelationship[] = [
      {
        participantId: work.id,
        type: "asset.membership",
        role: "bangumi.subject.ordinary-episode",
        sourceSlot: `bangumi.subject.ordinary-episode:${seasonSubject.id}:${episode.id}`,
        sourceRecordIds: [subjectRecord.id, episodeRecord.id],
      },
      ...officialSeasonRelationships(chain, records, works),
    ];
    const image = imageUrl(seasonSubject.images);
    const sourceArtifacts: SourceArtifactCandidate[] =
      image === undefined
        ? []
        : [
            {
              id: `bangumi.subject-cover:${seasonSubject.id}`,
              sourceRecordId: subjectRecord.id,
              subjectId: work.id,
              role: "asset.primary-cover",
              acquisitionReference: image,
              mediaType: "image/jpeg",
            },
          ];
    return {
      id: `source-interpretation_${randomUUID()}`,
      producer: this.capability,
      sourceRecordIds: records.map((record) => record.id),
      sourceIdentity: "bangumi",
      sourceAddress: episodeAddress(episode.id),
      metadata,
      sourceArtifacts,
      entities: works,
      relationships,
    };
  }

  private interpretKnownEpisode(
    evidence: RecognitionEvidence,
    records: readonly SourceRecord[],
    episodeId: number,
  ): SourceInterpretationBatch {
    const record = records.find(
      (item) => item.coverage.id === `bangumi.episode:${episodeId}`,
    );
    const episode =
      record === undefined ? undefined : directEpisode(record.body);
    if (record === undefined || episode === undefined)
      throw new Error("Bangumi associated episode was not captured");
    return {
      id: `source-interpretation_${randomUUID()}`,
      producer: this.capability,
      sourceRecordIds: [record.id],
      sourceIdentity: "bangumi",
      sourceAddress: evidence.sourceAddress!,
      metadata: episodeMetadata(episode, record.id),
      sourceArtifacts: [],
      entities: [],
      relationships: [],
    };
  }
}

export class BangumiEpisodicRecognizer implements Recognizer {
  readonly capability = recognizerCapability;
  canRecognize(input: SourceInterpretationBatch): boolean {
    return (
      input.sourceIdentity === "bangumi" &&
      input.producer.capabilityId === interpreterCapability.capabilityId
    );
  }
  recognize(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly interpretation: SourceInterpretationBatch;
  }): RecognitionProposalDraft {
    const convention = input.evidence.some(isEpisodeEvidence);
    return {
      id: `recognition-proposal_${randomUUID()}`,
      ruleResults: [
        {
          ...trustedBangumiEpisodicRule,
          outcome: convention ? "satisfied" : "contradicted",
          explanation: convention
            ? "Bangumi v1 标题年份、唯一关系路径及普通正片位置均一致"
            : "Bangumi v1 目录约定不完整",
          evidence: input.evidence,
        },
      ],
    };
  }
}

export class BangumiArtifactAcquirer implements SourceArtifactAcquirer {
  readonly capability = acquirerCapability;
  private readonly request: FetchLike;
  constructor(request: FetchLike = fetch) {
    this.request = request;
  }
  canAcquire(candidate: SourceArtifactCandidate): boolean {
    try {
      const url = new URL(candidate.acquisitionReference);
      return (
        url.protocol === "https:" &&
        (url.hostname === "lain.bgm.tv" || url.hostname.endsWith(".bgm.tv"))
      );
    } catch {
      return false;
    }
  }
  async acquire(
    candidate: SourceArtifactCandidate,
  ): Promise<StagedSourceArtifact> {
    if (!this.canAcquire(candidate))
      throw new Error(
        "Bangumi artifact candidate must use an official HTTPS image host",
      );
    const response = await this.request(candidate.acquisitionReference);
    if (!response.ok)
      throw new Error(
        `Bangumi artifact request failed: HTTP ${response.status}`,
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mediaType = response.headers.get("content-type") ?? "";
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > maximumResponseBytes ||
      !mediaType.startsWith("image/")
    )
      throw new Error("Bangumi artifact did not meet capture limits");
    return {
      candidateId: candidate.id,
      sourceRecordId: candidate.sourceRecordId,
      bytes,
      mediaType,
    };
  }
}

type Subject = {
  readonly id: number;
  readonly type?: number;
  readonly name: string;
  readonly name_cn?: string;
  readonly date?: string;
  readonly summary?: string;
  readonly images?: unknown;
};
type Episode = {
  readonly id: number;
  readonly subject_id: number;
  readonly type: number;
  readonly sort: number;
  readonly ep: number;
  readonly name: string;
  readonly name_cn?: string;
  readonly desc?: string;
  readonly airdate?: string;
};
type Related = { readonly id: number; readonly relation: string };

function isEpisodeEvidence(
  value: RecognitionEvidence,
): value is EpisodeEvidence {
  return (
    value.kind === "bangumi.episodic-directory/v1" &&
    value.sourceIdentity === "bangumi" &&
    parseDirectoryAddress(value.sourceAddress) !== undefined
  );
}
function baseName(value: string): string {
  return value.split(/[\\/]/u).at(-1) ?? "";
}
function normalize(value: string): string {
  return value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ");
}
function directoryAddress(
  title: string,
  year: string,
  season: number,
  episode: number,
): string {
  return `bangumi:directory/${encodeURIComponent(title)}/${year}/${season}/${episode}`;
}
function parseDirectoryAddress(value: string | undefined):
  | {
      readonly title: string;
      readonly year: string;
      readonly season: number;
      readonly episode: number;
    }
  | undefined {
  if (value === undefined) return undefined;
  const match =
    /^bangumi:directory\/([^/]+)\/(\d{4})\/([1-9]\d*)\/([1-9]\d*)$/u.exec(
      value,
    );
  return match === null
    ? undefined
    : {
        title: decodeURIComponent(match[1]!),
        year: match[2]!,
        season: Number(match[3]),
        episode: Number(match[4]),
      };
}
function subjectAddress(id: number): string {
  return `https://bgm.tv/subject/${id}`;
}
function episodeAddress(id: number): string {
  return `https://bgm.tv/episode/${id}`;
}
function parseEpisodeAddress(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^https:\/\/bgm\.tv\/episode\/(\d+)$/u.exec(value);
  return match === null ? undefined : Number(match[1]);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failure(
  capability: CapabilityCoordinate,
  reason: string,
): SourceCollectionResult {
  return { records: [], failures: [{ capability, reason }] };
}
function json(value: string): unknown {
  return JSON.parse(value) as unknown;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function subject(value: unknown): Subject | undefined {
  const input = object(value);
  const id = integer(input?.id),
    name = text(input?.name),
    type = integer(input?.type),
    nameCn = text(input?.name_cn),
    date = text(input?.date),
    summary = text(input?.summary);
  return id === undefined || name === undefined
    ? undefined
    : {
        id,
        name,
        ...(type === undefined ? {} : { type }),
        ...(nameCn === undefined ? {} : { name_cn: nameCn }),
        ...(date === undefined ? {} : { date }),
        ...(summary === undefined ? {} : { summary }),
        ...(input?.images === undefined ? {} : { images: input.images }),
      };
}
function searchSubjects(body: string): readonly Subject[] {
  const parsed = object(json(body));
  const data = Array.isArray(parsed?.data) ? parsed.data : [];
  return data.flatMap((item) => {
    const itemSubject = subject(item);
    return itemSubject === undefined ? [] : [itemSubject];
  });
}
function relatedSubjects(body: string): readonly Related[] {
  const parsed = json(body);
  return (Array.isArray(parsed) ? parsed : []).flatMap((item) => {
    const input = object(item),
      id = integer(input?.id),
      relation = text(input?.relation);
    return id === undefined || relation === undefined ? [] : [{ id, relation }];
  });
}
function episodesPage(body: string): {
  readonly total: number;
  readonly data: readonly Episode[];
} {
  const parsed = object(json(body));
  const data = Array.isArray(parsed?.data) ? parsed.data.flatMap(episode) : [];
  return { total: integer(parsed?.total) ?? data.length, data };
}
function episode(value: unknown): Episode[] {
  const input = object(value),
    id = integer(input?.id),
    subjectId = integer(input?.subject_id),
    type = integer(input?.type),
    sort = integer(input?.sort),
    ep = integer(input?.ep),
    name = text(input?.name),
    nameCn = text(input?.name_cn),
    desc = text(input?.desc),
    airdate = text(input?.airdate);
  return id === undefined ||
    subjectId === undefined ||
    type === undefined ||
    sort === undefined ||
    ep === undefined ||
    name === undefined
    ? []
    : [
        {
          id,
          subject_id: subjectId,
          type,
          sort,
          ep,
          name,
          ...(nameCn === undefined ? {} : { name_cn: nameCn }),
          ...(desc === undefined ? {} : { desc }),
          ...(airdate === undefined ? {} : { airdate }),
        },
      ];
}
function directEpisode(body: string): Episode | undefined {
  return episode(json(body))[0];
}
function episodeMetadata(value: Episode, sourceRecordId: string) {
  return [
    assertion(
      "asset.title",
      "bangumi.episode.name",
      value.name,
      sourceRecordId,
    ),
    ...(nonEmpty(value.name_cn) === undefined
      ? []
      : [
          assertion(
            "asset.title.zh-hans",
            "bangumi.episode.name-cn",
            value.name_cn!,
            sourceRecordId,
          ),
        ]),
    ...(nonEmpty(value.desc) === undefined
      ? []
      : [
          assertion(
            "asset.description",
            "bangumi.episode.description",
            value.desc!,
            sourceRecordId,
          ),
        ]),
    ...(nonEmpty(value.airdate) === undefined
      ? []
      : [
          assertion(
            "asset.release-date",
            "bangumi.episode.date",
            value.airdate!,
            sourceRecordId,
          ),
        ]),
    assertion(
      "bangumi.episode.season-position",
      "bangumi.episode.ep",
      String(value.ep),
      sourceRecordId,
    ),
    assertion(
      "bangumi.episode.continuous-position",
      "bangumi.episode.sort",
      String(value.sort),
      sourceRecordId,
    ),
  ];
}
function subjectMatchesRoot(
  value: Subject,
  target: { readonly title: string; readonly year: string },
): boolean {
  return (
    value.date?.startsWith(target.year) === true &&
    [value.name, value.name_cn].some(
      (name) =>
        name !== undefined && normalize(name) === normalize(target.title),
    )
  );
}
function subjectRecords(
  records: readonly SourceRecord[],
): readonly { readonly subject: Subject; readonly record: SourceRecord }[] {
  return records.flatMap((record) =>
    record.coverage.id.startsWith("bangumi.subject:")
      ? (() => {
          const parsed = subject(json(record.body));
          return parsed === undefined ? [] : [{ subject: parsed, record }];
        })()
      : [],
  );
}
function subjectById(
  id: number,
  records: readonly SourceRecord[],
): Subject | undefined {
  return subjectRecords(records).find((item) => item.subject.id === id)
    ?.subject;
}
function subjectRecordFor(
  id: number,
  records: readonly SourceRecord[],
): SourceRecord | undefined {
  return subjectRecords(records).find((item) => item.subject.id === id)?.record;
}
function ordinaryEpisodes(
  subjectId: number,
  records: readonly SourceRecord[],
): readonly Episode[] {
  return records.flatMap((record) =>
    record.coverage.id.startsWith(`bangumi.ordinary-episodes:${subjectId}:`)
      ? episodesPage(record.body).data.filter((item) => item.type === 0)
      : [],
  );
}
function episodeRecordFor(
  subjectId: number,
  episodeId: number,
  records: readonly SourceRecord[],
): SourceRecord | undefined {
  const direct = records.find(
    (record) =>
      record.coverage.id === `bangumi.episode:${episodeId}` &&
      directEpisode(record.body)?.id === episodeId,
  );
  return (
    direct ??
    records.find(
      (record) =>
        record.coverage.id.startsWith(
          `bangumi.ordinary-episodes:${subjectId}:`,
        ) &&
        episodesPage(record.body).data.some((item) => item.id === episodeId),
    )
  );
}
function resolveSeasonChain(
  rootId: number,
  season: number,
  observedEpisode: number,
  records: readonly SourceRecord[],
): readonly number[] | undefined {
  let frontier: readonly (readonly number[])[] = [[rootId]];
  for (let level = 1; level < season; level += 1) {
    const next = frontier.flatMap((path) => {
      const id = path.at(-1)!;
      const record = records.find(
        (item) => item.coverage.id === `bangumi.relationships:${id}`,
      );
      return record === undefined
        ? []
        : relatedSubjects(record.body)
            .filter((item) => item.relation === "续集")
            .filter((item) => !path.includes(item.id))
            .filter((item) =>
              isCompatibleOrdinarySubject(
                item.id,
                level === season - 1 ? observedEpisode : undefined,
                records,
              ),
            )
            .map((item) => [...path, item.id]);
    });
    if (next.length === 0) return undefined;
    frontier = next;
  }
  return frontier.length === 1 ? frontier[0] : undefined;
}
function isCompatibleOrdinarySubject(
  subjectId: number,
  expectedEpisode: number | undefined,
  records: readonly SourceRecord[],
): boolean {
  const candidate = subjectById(subjectId, records);
  if (candidate === undefined || candidate.type !== 2) return false;
  const episodes = ordinaryEpisodes(subjectId, records);
  return (
    episodes.length > 0 &&
    (expectedEpisode === undefined ||
      episodes.some((episode) => episode.ep === expectedEpisode))
  );
}
function preferredName(value: Subject): string {
  return nonEmpty(value.name_cn) ?? value.name;
}
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
function assertion(
  property: string,
  sourceSlot: string,
  value: string,
  sourceRecordId: string,
  subjectId?: string,
) {
  return {
    property,
    sourceSlot,
    value,
    sourceRecordIds: [sourceRecordId],
    ...(subjectId === undefined ? {} : { subjectId }),
  };
}
function workEntity(subject: Subject, record: SourceRecord): SourcedEntity {
  return {
    id: sourcedEntityId("bangumi.subject", String(subject.id)),
    kind: "entity",
    sourceIdentity: "bangumi",
    sourceKey: String(subject.id),
    identityNamespace: "bangumi.subject",
    label: preferredName(subject),
    sourceRecordIds: [record.id],
  };
}
/**
 * The official sequel assertion is one directed Entity-to-Entity relationship.
 * Episode membership remains a separate relationship whose subject is the
 * collected episode Asset, so neither fact leaks a season container into core.
 */
function officialSeasonRelationships(
  chain: readonly number[],
  records: readonly SourceRecord[],
  works: readonly SourcedEntity[],
): readonly ProposedEntityRelationship[] {
  return chain.slice(1).flatMap((seasonId, index) => {
    const predecessorId = chain[index]!;
    const relationRecord = records.find(
      (record) =>
        record.coverage.id === `bangumi.relationships:${predecessorId}`,
    );
    const predecessor = works.find(
      (work) => work.sourceKey === String(predecessorId),
    );
    const season = works.find((work) => work.sourceKey === String(seasonId));
    if (
      relationRecord === undefined ||
      predecessor === undefined ||
      season === undefined ||
      !relatedSubjects(relationRecord.body).some(
        (related) => related.id === seasonId && related.relation === "续集",
      )
    )
      return [];
    return [
      {
        subjectId: predecessor.id,
        participantId: season.id,
        type: "bangumi.subject.related",
        role: "bangumi.subject.sequel",
        sourceSlot: `bangumi.subject.sequel:${predecessorId}:${seasonId}`,
        sourceRecordIds: [relationRecord.id],
      },
    ];
  });
}
function sourcedEntityId(namespace: string, sourceKey: string): string {
  return `entity_${createHash("sha256").update(`${namespace}\u0000${sourceKey}`).digest("hex").slice(0, 24)}`;
}
function imageUrl(images: unknown): string | undefined {
  const source = object(images);
  const value =
    text(source?.large) ?? text(source?.common) ?? text(source?.medium);
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
