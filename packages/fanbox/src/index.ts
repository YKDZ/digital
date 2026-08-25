import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  knownSourceAssociationEvidenceCapability,
  type DirectoryInterpreter,
  type FilesystemPackageSnapshot,
  type Recognizer,
  type SourceArtifactAcquirer,
  type SourceCollectionFailure,
  type SourceCollectionExecutionContext,
  type SourceCollectionResult,
  type SourceCollector,
  type SourceInterpreter,
  type StagedSourceArtifact,
} from "@digital/application";
import type {
  EntityMention,
  EntityResolutionDecision,
  ProposedEntityRelationship,
  RecognitionEvidence,
  RecognitionProposalDraft,
  SourceArtifactCandidate,
  SourceInterpretationBatch,
  SourceRecord,
  SourcedEntity,
} from "@digital/domain";

const directoryCapability = declareCapability({
  identity: "fanbox.creator-date-directory",
  implementationVersion: "1",
  kind: "directory-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
export const fanboxOfficialCollectionCapability = declareCapability({
  identity: "fanbox.official-collection",
  implementationVersion: "1",
  kind: "source-collector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
/**
 * 浏览器凭据是独立于 FANBOX 采集契约的私有能力。其导出 Cookie 结构绝不会进入
 * 领域层或应用层。
 */
export const fanboxSourceConnectionCapability = declareCapability({
  identity: "fanbox.source-connection",
  implementationVersion: "1",
  kind: "source-connection",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const interpreterCapability = declareCapability({
  identity: "fanbox.post-interpretation",
  implementationVersion: "1",
  kind: "source-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const recognizerCapability = declareCapability({
  identity: "fanbox.creator-date-recognizer",
  implementationVersion: "1",
  kind: "recognizer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const acquirerCapability = declareCapability({
  identity: "fanbox.source-artifact-acquirer",
  implementationVersion: "1",
  kind: "source-artifact-acquirer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const maximumResponseBytes = 2 * 1024 * 1024;
const maximumSummaryPages = 20;

type FetchLike = (
  input: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type CapturedFanboxResponse = {
  readonly requestedAddress: string;
  readonly body: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  /** 语义上成功的 FANBOX 响应封装正文，绝不是错误正文。 */
  readonly envelopeBody: Record<string, unknown>;
};

/**
 * 被拒绝的传输仍可留下有效但范围更窄的摘要记录；无效的 HTTP 成功 JSON 则不行，
 * 因为它根本没有形成来源证据。
 */
class FanboxTransportFailure extends Error {}

export class FanboxDateDirectoryInterpreter implements DirectoryInterpreter {
  readonly capability = directoryCapability;
  private readonly creatorIds: () => readonly string[];

  constructor(creatorScope: string | (() => readonly string[])) {
    if (typeof creatorScope === "string" && !isFanboxCreatorId(creatorScope)) {
      throw new Error("FANBOX creator scope is invalid");
    }
    this.creatorIds =
      typeof creatorScope === "string"
        ? () => [creatorScope]
        : () =>
            [
              ...new Set(
                creatorScope().filter((value) => isFanboxCreatorId(value)),
              ),
            ].toSorted();
  }

  interpret(
    snapshot: FilesystemPackageSnapshot,
  ): readonly RecognitionEvidence[] {
    const basename = snapshot.root.split(/[\\/]/u).at(-1) ?? "";
    const date = publicationDateFromDirectory(basename);
    if (date === undefined) return [];
    return this.creatorIds().map((creatorId) => ({
      kind: "directory-convention" as const,
      sourceIdentity: "fanbox",
      explanation: "FANBOX 创作者与发布日期目录规则匹配",
      producer: this.capability,
      sourceAddress: `fanbox-directory:${creatorId}:${date}`,
    }));
  }
}

export class FanboxCollector implements SourceCollector {
  readonly capability = fanboxOfficialCollectionCapability;
  private readonly creatorIds: () => readonly string[];
  private readonly cookieHeader: string | undefined;
  private readonly cookieHeaderForExecution:
    | ((input: {
        readonly creatorId: string;
        readonly context: SourceCollectionExecutionContext | undefined;
      }) => string | undefined)
    | undefined;
  private readonly request: FetchLike;

  constructor(options: {
    readonly creatorId?: string;
    readonly creatorIds?: () => readonly string[];
    readonly cookieHeader?: string;
    readonly cookieHeaderForExecution?: (input: {
      readonly creatorId: string;
      readonly context: SourceCollectionExecutionContext | undefined;
    }) => string | undefined;
    readonly request?: FetchLike;
  }) {
    if (options.creatorId === undefined && options.creatorIds === undefined)
      throw new Error("FANBOX collector requires a creator scope");
    if (options.creatorId !== undefined && options.creatorIds !== undefined)
      throw new Error("FANBOX collector accepts one creator scope source");
    if (
      options.cookieHeader === undefined &&
      options.cookieHeaderForExecution === undefined
    ) {
      throw new Error("FANBOX authenticated collection requires credentials");
    }
    if (
      options.cookieHeader !== undefined &&
      options.cookieHeaderForExecution !== undefined
    ) {
      throw new Error("FANBOX collector accepts one credential source");
    }
    if (
      options.creatorId !== undefined &&
      !isFanboxCreatorId(options.creatorId)
    ) {
      throw new Error("FANBOX creator scope is invalid");
    }
    if (options.cookieHeader !== undefined && options.cookieHeader.length === 0)
      throw new Error("FANBOX authenticated collection requires credentials");
    this.creatorIds =
      options.creatorId === undefined
        ? () =>
            (options.creatorIds?.() ?? []).filter((value) =>
              isFanboxCreatorId(value),
            )
        : () => [options.creatorId!];
    this.cookieHeader = options.cookieHeader;
    this.cookieHeaderForExecution = options.cookieHeaderForExecution;
    this.request = options.request ?? fetch;
  }

  canCollect(evidence: RecognitionEvidence): boolean {
    const creatorId = fanboxCreatorIdFromEvidence(evidence);
    return creatorId !== undefined && this.creatorIds().includes(creatorId);
  }

  coverageScopeIds(evidence: RecognitionEvidence): readonly string[] {
    return this.canCollect(evidence)
      ? ["fanbox.creator-post-summaries", "fanbox.post-detail"]
      : [];
  }

  async collect(
    evidence: RecognitionEvidence,
    context?: SourceCollectionExecutionContext,
  ): Promise<SourceCollectionResult> {
    const creatorId = fanboxCreatorIdFromEvidence(evidence);
    if (creatorId === undefined || !this.creatorIds().includes(creatorId))
      return {
        records: [],
        failures: [
          {
            capability: this.capability,
            reason: "FANBOX evidence does not belong to this creator scope",
          },
        ],
      };
    const credential = this.credentialForExecution(creatorId, context);
    if (credential === undefined) {
      return {
        records: [],
        failures: [
          {
            capability: this.capability,
            reason: "FANBOX 创作者范围缺少当前执行可用的私有来源连接",
            affects: {
              recognition: true,
              metadataProperties: [
                "asset.title",
                "asset.publication-datetime",
                "fanbox.post.*",
                "asset.body",
                "fanbox.attachment.*",
              ],
              artifactRoles: ["asset.primary-cover", "fanbox.attachment.*"],
            },
          },
        ],
      };
    }
    const directoryConvention =
      evidence.kind === "directory-convention" &&
      sameCapabilityCoordinate(evidence.producer, directoryCapability);
    const date = directoryConvention
      ? evidence.sourceAddress!.split(":").at(-1)!
      : undefined;
    const associated = directoryConvention
      ? undefined
      : parsePostAddress(evidence.sourceAddress!);
    let summarySelection: FanboxSummarySelection;
    try {
      summarySelection = await this.selectSummary({
        creatorId,
        credential,
        ...(date === undefined
          ? { postId: associated!.postId }
          : { publicationDate: date }),
      });
    } catch (error) {
      return { records: [], failures: [this.failure(error, credential)] };
    }
    const { captured: capturedSummary, selected } = summarySelection;
    const postId = requiredString(selected.id, "summary post identity");
    const summaryPublicationDatetime = requiredString(
      selected.publishedDatetime,
      "summary publication datetime",
    );
    const nativeAddress = canonicalPostAddress(creatorId, postId);
    const summary = this.sourceRecord(
      capturedSummary,
      nativeAddress,
      "fanbox.creator-post-summaries",
      summarySelection.completeness,
    );
    const detailAddress = new URL("https://api.fanbox.cc/post.info");
    detailAddress.searchParams.set("postId", postId);
    try {
      const capturedDetail = await this.capture(
        detailAddress.href,
        "fanbox.post-detail",
        creatorId,
        credential,
      );
      const detailPost = capturedDetail.envelopeBody;
      try {
        assertPostIdentity(detailPost, postId, creatorId, "detail");
        if (detailPost.publishedDatetime !== summaryPublicationDatetime)
          throw new Error(
            "FANBOX detail publication datetime differs from its summary",
          );
      } catch (error) {
        // 相互矛盾的端点响应意味着本次采集尚未建立统一的 FANBOX 帖子身份。
        // 不要在配对官方端点拒绝的身份下保留摘要记录。
        return {
          records: [],
          failures: [
            this.detailFailure(
              this.failureReason(error, credential),
              nativeAddress,
            ),
          ],
        };
      }
      validateDetailPost(detailPost);
      const detail = this.sourceRecord(
        capturedDetail,
        nativeAddress,
        "fanbox.post-detail",
        detailCompleteness(detailPost),
      );
      return { records: [summary, detail], failures: [] };
    } catch (error) {
      // 所选创作者摘要响应是独立且有效的来源覆盖边界。格式错误、不可用或权限受限的
      // 详情端点不能把它变成空来源响应；只会让详情事实族不可用。
      return {
        records: [summary],
        failures: [
          this.detailFailure(
            this.failureReason(error, credential),
            nativeAddress,
          ),
        ],
      };
    }
  }

  private async selectSummary(input: {
    readonly creatorId: string;
    readonly credential: FanboxPrivateCredential;
    readonly postId?: string;
    readonly publicationDate?: string;
  }): Promise<FanboxSummarySelection> {
    const initial = new URL("https://api.fanbox.cc/post.listCreator");
    initial.searchParams.set("creatorId", input.creatorId);
    initial.searchParams.set("limit", "300");
    let requestedAddress = canonicalSummaryAddress(
      initial.href,
      input.creatorId,
    );
    const requestedAddresses = new Set<string>();
    const dateMatches: FanboxSummarySelection[] = [];
    for (let pageCount = 0; pageCount < maximumSummaryPages; pageCount += 1) {
      if (requestedAddresses.has(requestedAddress))
        throw new Error("FANBOX creator summaries repeated a next URL");
      requestedAddresses.add(requestedAddress);
      const captured = await this.capture(
        requestedAddress,
        "fanbox.creator-post-summaries",
        input.creatorId,
        input.credential,
      );
      const page = fanboxSummaryPage(captured.envelopeBody, input.creatorId);
      const completeness = summaryCompleteness(page.nextUrl);
      if (input.postId !== undefined) {
        const selected = summaryPostForId(page.posts, input.postId);
        if (selected !== undefined) return { captured, selected, completeness };
      } else {
        const selected = summaryPostsForDate(
          page.posts,
          input.publicationDate!,
        );
        dateMatches.push(
          ...selected.map((post) => ({
            captured,
            selected: post,
            completeness,
          })),
        );
      }
      if (page.nextUrl === undefined) {
        if (input.postId !== undefined)
          throw new Error(
            "known post identity is absent from creator summaries",
          );
        return uniqueSummaryDateSelection(dateMatches);
      }
      requestedAddress = canonicalSummaryAddress(page.nextUrl, input.creatorId);
    }
    throw new Error("FANBOX creator summaries exceeded the bounded page limit");
  }

  private credentialForExecution(
    creatorId: string,
    context: SourceCollectionExecutionContext | undefined,
  ): FanboxPrivateCredential | undefined {
    const cookieHeader =
      this.cookieHeader ??
      this.cookieHeaderForExecution?.({ creatorId, context });
    return cookieHeader === undefined
      ? undefined
      : fanboxPrivateCredential(cookieHeader);
  }

  private failure(
    error: unknown,
    credential: FanboxPrivateCredential,
  ): SourceCollectionFailure {
    return {
      capability: this.capability,
      reason: this.failureReason(error, credential),
    };
  }

  private detailFailure(
    reason: string,
    nativeAddress: string,
  ): SourceCollectionFailure {
    return {
      capability: this.capability,
      reason,
      coverage: {
        sourceIdentity: "fanbox",
        nativeAddress,
        coverageId: "fanbox.post-detail",
      },
      affects: {
        metadataProperties: [
          "fanbox.post.form",
          "asset.body",
          "fanbox.attachment.*",
        ],
        artifactRoles: ["fanbox.attachment.*"],
      },
    };
  }

  private failureReason(
    error: unknown,
    credential: FanboxPrivateCredential,
  ): string {
    const reason = credential.removePrivateConfiguration(errorMessage(error));
    return `FANBOX official source request failed: ${reason}`;
  }

  private async capture(
    requestedAddress: string,
    coverage: string,
    creatorId: string,
    credential: FanboxPrivateCredential,
  ): Promise<CapturedFanboxResponse> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.request(requestedAddress, {
        headers: {
          Accept: "application/json",
          Cookie: credential.cookieHeader,
          Origin: "https://www.fanbox.cc",
          Referer: `https://www.fanbox.cc/@${creatorId}`,
          "User-Agent": "digital-fanbox-integration/1",
        },
      });
    } catch (error) {
      throw new FanboxTransportFailure(errorMessage(error));
    }
    if (!response.ok) {
      // Cloudflare 质询属于运维证据，而非来源响应。只检查被拒正文中足以对失败分类的部分，
      // 绝不保留该正文或把它纳入诊断。
      let rejected: Uint8Array;
      try {
        rejected = new Uint8Array(await response.arrayBuffer());
      } catch {
        throw new FanboxTransportFailure(`HTTP ${response.status}`);
      }
      const rejectedBody =
        rejected.byteLength <= maximumResponseBytes
          ? new TextDecoder().decode(rejected)
          : "";
      if (cloudflareChallenge(rejectedBody)) {
        throw new FanboxTransportFailure(
          "Cloudflare challenge blocked the official API request; refresh the private browser clearance before retrying",
        );
      }
      throw new FanboxTransportFailure(`HTTP ${response.status}`);
    }
    const mediaType = response.headers.get("content-type");
    if (!isJsonMediaType(mediaType))
      throw new Error(`FANBOX ${coverage} response media type was not JSON`);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new FanboxTransportFailure(errorMessage(error));
    }
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes)
      throw new Error("response did not meet the capture limits");
    const body = new TextDecoder().decode(bytes);
    let envelopeBody: Record<string, unknown>;
    try {
      envelopeBody = fanboxSuccessfulEnvelope(JSON.parse(body) as unknown);
    } catch {
      throw new Error(
        `FANBOX ${coverage} response was not a successful envelope`,
      );
    }
    if (credential.containsPrivateConfiguration(body)) {
      throw new Error(
        "response contained private configuration and was not retained",
      );
    }
    return {
      requestedAddress,
      body,
      bytes,
      mediaType,
      envelopeBody,
    };
  }

  private sourceRecord(
    captured: CapturedFanboxResponse,
    nativeAddress: string,
    coverage: string,
    completeness: "complete" | "incomplete",
  ): SourceRecord {
    return {
      id: `source-record_${randomUUID()}`,
      sourceIdentity: "fanbox",
      nativeAddress,
      mediaType: captured.mediaType,
      acquiredAt: new Date().toISOString(),
      acquisition: {
        requestedAddress: captured.requestedAddress,
        method: "GET",
        authorized: true,
      },
      coverage: {
        id: coverage,
        completeness,
        authority: "official",
      },
      digest: createHash("sha256").update(captured.bytes).digest("hex"),
      body: captured.body,
    };
  }
}

type FanboxPrivateCredential = {
  readonly cookieHeader: string;
  containsPrivateConfiguration(value: string): boolean;
  removePrivateConfiguration(value: string): string;
};

function fanboxPrivateCredential(
  cookieHeader: string,
): FanboxPrivateCredential | undefined {
  if (cookieHeader.length === 0 || /[\r\n]/u.test(cookieHeader))
    return undefined;
  const sensitiveCookiePairs = cookieHeader
    .split(/;\s*/u)
    .filter((pair) => pair.includes("="));
  if (sensitiveCookiePairs.length === 0) return undefined;
  // 裸露的短值（例如 A/B 实验标志）会自然出现在 HTTP 诊断中。完整 Cookie 对保持私有，
  // 只有形似令牌的值会作为独立子串被遮盖。
  const sensitiveCookieValues = sensitiveCookiePairs
    .map((pair) => pair.slice(pair.indexOf("=") + 1))
    .filter((secret) => secret.length >= 8);
  const sensitiveRepresentations = sensitiveCookieValues.flatMap((secret) =>
    privateRepresentations(secret),
  );
  const sensitivePatterns = sensitiveCookieValues.map(
    (secret) => new RegExp(privateRepresentationPattern(secret), "u"),
  );
  const containsPrivateConfiguration = (value: string): boolean =>
    value.includes(cookieHeader) ||
    sensitiveCookiePairs.some((pair) => value.includes(pair)) ||
    sensitiveRepresentations.some((secret) => value.includes(secret)) ||
    sensitivePatterns.some((pattern) => pattern.test(value));
  return {
    cookieHeader,
    containsPrivateConfiguration,
    removePrivateConfiguration(value) {
      let sanitized = value.replaceAll(cookieHeader, "[credential removed]");
      for (const pair of sensitiveCookiePairs)
        sanitized = sanitized.replaceAll(pair, "[credential removed]");
      for (const secret of sensitiveRepresentations)
        sanitized = sanitized.replaceAll(secret, "[credential removed]");
      for (const pattern of sensitivePatterns)
        sanitized = sanitized.replace(
          new RegExp(pattern.source, "gu"),
          "[credential removed]",
        );
      return sanitized;
    },
  };
}

/**
 * 即使上游错误将凭据材料序列化为 JSON 或 URL 编码，采集器也绝不保留它。
 * 浏览器安全的 Cookie 值均为 ASCII，因此这些变体具有确定性，遮盖前无需解码
 * 由攻击者控制的任意诊断内容。
 */
function privateRepresentations(secret: string): readonly string[] {
  const escaped = JSON.stringify(secret).slice(1, -1);
  const encoded = encodeURIComponent(secret);
  return [...new Set([secret, escaped, encoded])].filter(
    (candidate) => candidate.length > 0,
  );
}

function privateRepresentationPattern(secret: string): string {
  return Array.from(secret)
    .map((character) => {
      const code = character.charCodeAt(0).toString(16).padStart(4, "0");
      const encoded = encodeURIComponent(character);
      const variants = [
        escapeRegularExpression(character),
        String.raw`\\u${code}`,
        String.raw`\\u${code.toUpperCase()}`,
      ];
      if (encoded !== character) {
        variants.push(
          escapeRegularExpression(encoded),
          escapeRegularExpression(encoded.toLowerCase()),
        );
      }
      return `(?:${[...new Set(variants)].join("|")})`;
    })
    .join("");
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
}

/**
 * FANBOX 来源地址语法保留在该集成中。组合层只使用这个窄化辅助方法选择匹配的私有连接；
 * 应用层继续传递不透明识别证据。
 */
export function fanboxCreatorIdFromEvidence(
  evidence: RecognitionEvidence,
): string | undefined {
  if (
    evidence.sourceIdentity !== "fanbox" ||
    evidence.sourceAddress === undefined
  )
    return undefined;
  if (
    evidence.kind === "directory-convention" &&
    sameCapabilityCoordinate(evidence.producer, directoryCapability)
  ) {
    const match = /^fanbox-directory:([a-zA-Z0-9_-]+):\d{4}-\d{2}-\d{2}$/u.exec(
      evidence.sourceAddress,
    );
    return match?.[1];
  }
  if (
    evidence.kind !== "source-association" ||
    !sameCapabilityCoordinate(
      evidence.producer,
      knownSourceAssociationEvidenceCapability,
    )
  ) {
    return undefined;
  }
  try {
    return parsePostAddress(evidence.sourceAddress).creatorId;
  } catch {
    return undefined;
  }
}

/**
 * 现有关联是应用层生成的证据，而不是任意提供方地址的逃生口。比较完整声明，
 * 使名称相似的文件系统或插件能力无法仅靠发出形似 FANBOX 的地址，就取得私有创作者凭据。
 */
function sameCapabilityCoordinate(
  actual: RecognitionEvidence["producer"],
  expected: RecognitionEvidence["producer"],
): boolean {
  return (
    actual.capabilityId === expected.capabilityId &&
    actual.capabilityVersion === expected.capabilityVersion &&
    actual.contractVersion === expected.contractVersion &&
    actual.identity === expected.identity &&
    actual.implementationVersion === expected.implementationVersion &&
    actual.kind === expected.kind &&
    sameStringList(
      actual.interpretationContractVersions,
      expected.interpretationContractVersions,
    )
  );
}

function sameStringList(
  actual: readonly string[] | undefined,
  expected: readonly string[] | undefined,
): boolean {
  return (
    actual !== undefined &&
    expected !== undefined &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function isFanboxCreatorId(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/u.test(value);
}

function cloudflareChallenge(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("challenge-platform") ||
    normalized.includes("_cf_chl_opt") ||
    normalized.includes("cf-chl")
  );
}

export const trustedFanboxCreatorDateRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "unique-creator-publication-date",
  ruleVersion: "1",
} as const;

type FanboxPost = {
  readonly id?: unknown;
  readonly creatorId?: unknown;
  readonly title?: unknown;
  readonly excerpt?: unknown;
  readonly publishedDatetime?: unknown;
  readonly type?: unknown;
  readonly feeRequired?: unknown;
  readonly likeCount?: unknown;
  readonly commentCount?: unknown;
  readonly isRestricted?: unknown;
  readonly restrictedFor?: unknown;
  readonly coverImageUrl?: unknown;
  readonly cover?: { readonly url?: unknown };
  readonly user?: { readonly name?: unknown };
  readonly body?: {
    readonly text?: unknown;
    readonly blocks?: unknown;
    readonly fileMap?: unknown;
    readonly imageMap?: unknown;
    readonly embedMap?: unknown;
    readonly urlEmbedMap?: unknown;
    readonly files?: unknown;
    readonly images?: unknown;
  };
};

type FanboxSummaryPage = {
  readonly posts: readonly FanboxPost[];
  readonly nextUrl: string | undefined;
};

type FanboxSummarySelection = {
  readonly captured: CapturedFanboxResponse;
  readonly selected: FanboxPost;
  readonly completeness: "complete" | "incomplete";
};

export class FanboxSourceInterpreter implements SourceInterpreter {
  readonly capability = interpreterCapability;

  canInterpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): boolean {
    return (
      input.evidence.some(
        (evidence) =>
          evidence.sourceIdentity === "fanbox" &&
          (evidence.producer.capabilityId ===
            directoryCapability.capabilityId ||
            evidence.kind === "source-association"),
      ) &&
      input.sourceRecords.length >= 1 &&
      input.sourceRecords.every(
        (record) => record.sourceIdentity === "fanbox",
      ) &&
      input.sourceRecords.some(
        (record) => record.coverage.id === "fanbox.creator-post-summaries",
      )
    );
  }

  interpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): SourceInterpretationBatch {
    const detail = input.sourceRecords.find(
      (record) => record.coverage.id === "fanbox.post-detail",
    );
    const summary = input.sourceRecords.find(
      (record) => record.coverage.id === "fanbox.creator-post-summaries",
    );
    if (summary === undefined)
      throw new Error("FANBOX interpretation requires a summary record");
    if (
      input.sourceRecords.some(
        (record) => record.nativeAddress !== summary.nativeAddress,
      )
    )
      throw new Error("FANBOX source records disagree about post identity");
    const source = parsePostAddress(summary.nativeAddress);
    assertAddressedSummaryTitle(summary.body, source.postId);
    const detailEnvelope =
      detail === undefined
        ? undefined
        : (JSON.parse(detail.body) as { readonly body?: FanboxPost });
    const detailPost = detailEnvelope?.body;
    if (detail !== undefined && detailPost === undefined)
      throw new Error("FANBOX detail response is empty");
    let summaryPost: FanboxPost | undefined;
    const matchingSummaryPost = () => {
      summaryPost ??= postSummary(summary.body, source.postId);
      return summaryPost;
    };
    const optionalMatchingSummaryPost = () => {
      try {
        return matchingSummaryPost();
      } catch {
        return undefined;
      }
    };
    const post = detailPost ?? matchingSummaryPost();
    const postId = requiredString(post.id, "post identity");
    const creatorId = optionalString(post.creatorId) ?? source.creatorId;
    if (summary.nativeAddress !== canonicalPostAddress(creatorId, postId))
      throw new Error("FANBOX detail response contradicts its source address");
    const title = requiredNonBlankString(post.title, "post title");
    const published = requiredString(
      post.publishedDatetime,
      "publication datetime",
    );
    const factRecord = detail ?? summary;
    const form = optionalString(post.type);
    const metadata = [
      assertion("asset.title", "fanbox.post.title", title, factRecord.id),
      assertion(
        "asset.publication-datetime",
        "fanbox.post.publication-datetime",
        published,
        factRecord.id,
      ),
      assertion(
        "fanbox.post.entitlement",
        "fanbox.post.entitlement",
        detail === undefined
          ? isRestricted(post)
            ? "restricted"
            : "unverified"
          : isRestricted(post)
            ? "restricted"
            : "available",
        factRecord.id,
      ),
    ];
    if (form !== undefined)
      metadata.push(
        assertion("fanbox.post.form", "fanbox.post.form", form, factRecord.id),
      );
    const likeCount = countString(post.likeCount);
    if (likeCount !== undefined)
      metadata.push(
        assertion(
          "fanbox.post.like-count",
          "fanbox.post.like-count",
          likeCount,
          factRecord.id,
        ),
      );
    const commentCount = countString(post.commentCount);
    if (commentCount !== undefined)
      metadata.push(
        assertion(
          "fanbox.post.comment-count",
          "fanbox.post.comment-count",
          commentCount,
          factRecord.id,
        ),
      );
    const body = articleBody(post.body) ?? optionalString(post.body?.text);
    if (body !== undefined)
      metadata.push(
        assertion("asset.body", "fanbox.post.body", body, factRecord.id),
      );
    const detailCoverUrl =
      detailPost === undefined ? undefined : officialCoverUrl(detailPost);
    const summaryCoverPost =
      detailPost === undefined ? post : optionalMatchingSummaryPost();
    const summaryCoverUrl =
      detailCoverUrl === undefined && summaryCoverPost !== undefined
        ? officialCoverUrl(summaryCoverPost)
        : undefined;
    const coverUrl = detailCoverUrl ?? summaryCoverUrl;
    const coverRecord = detailCoverUrl === undefined ? summary : factRecord;
    const sourceArtifacts: SourceArtifactCandidate[] =
      coverUrl === undefined
        ? []
        : [
            {
              id: `source-artifact-candidate_${randomUUID()}`,
              sourceRecordId: coverRecord.id,
              role: "asset.primary-cover",
              acquisitionReference: officialImageAddress(coverUrl),
              mediaType: imageMediaType(coverUrl),
            },
          ];
    const attachments = attachmentCandidates(post.body, factRecord.id);
    sourceArtifacts.push(...attachments.candidates);
    metadata.push(...attachments.metadata);
    const label = optionalString(post.user?.name) ?? creatorId;
    const entity: SourcedEntity = {
      id: stableEntityId("fanbox.creator", creatorId),
      kind: "entity",
      sourceIdentity: "fanbox",
      sourceKey: creatorId,
      identityNamespace: "fanbox.creator",
      label,
      sourceRecordIds: [factRecord.id],
    };
    const mention: EntityMention = {
      id: `entity-mention_${randomUUID()}`,
      sourceRecordIds: [factRecord.id],
      sourceIdentity: "fanbox",
      field: "creator",
      role: "fanbox.post.creator",
      label,
      identityNamespace: "fanbox.creator",
      sourceKey: creatorId,
    };
    const resolution: EntityResolutionDecision = {
      id: `entity-resolution_${randomUUID()}`,
      mentionId: mention.id,
      entityId: entity.id,
      rule: "source-field-role-exact",
      sourceRecordIds: [factRecord.id],
    };
    const relationship: ProposedEntityRelationship = {
      participantId: entity.id,
      participantMentionIds: [mention.id],
      type: "asset.contribution",
      role: "fanbox.post.creator",
      sourceSlot: `fanbox.post.creator:${creatorId}`,
      sourceRecordIds: [factRecord.id],
    };
    return {
      id: `source-interpretation_${randomUUID()}`,
      producer: this.capability,
      sourceRecordIds: input.sourceRecords.map((record) => record.id),
      sourceIdentity: "fanbox",
      sourceAddress: summary.nativeAddress,
      metadata,
      sourceArtifacts,
      entities: [entity],
      entityMentions: [mention],
      entityResolutionDecisions: [resolution],
      relationships: [relationship],
    };
  }
}

export class FanboxExactRecognizer implements Recognizer {
  readonly capability = recognizerCapability;

  canRecognize(input: SourceInterpretationBatch): boolean {
    return input.producer.capabilityId === interpreterCapability.capabilityId;
  }

  recognize(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly interpretation: SourceInterpretationBatch;
  }): RecognitionProposalDraft {
    const published = input.interpretation.metadata.find(
      (item) => item.property === "asset.publication-datetime",
    )?.value;
    const source = parsePostAddress(input.interpretation.sourceAddress);
    const satisfied =
      published !== undefined &&
      input.evidence.some(
        (evidence) =>
          evidence.producer.capabilityId === directoryCapability.capabilityId &&
          evidence.sourceAddress ===
            `fanbox-directory:${source.creatorId}:${publicationDateOf(published)}`,
      );
    return {
      id: `recognition-proposal_${randomUUID()}`,
      ruleResults: [
        {
          ...trustedFanboxCreatorDateRule,
          outcome: satisfied ? "satisfied" : "contradicted",
          explanation: satisfied
            ? "创作者与发布日期唯一解析到同一篇官方帖子"
            : "创作者、发布日期与官方帖子不一致",
          evidence: input.evidence,
        },
      ],
    };
  }
}

export class FanboxArtifactAcquirer implements SourceArtifactAcquirer {
  readonly capability = acquirerCapability;
  private readonly request: FetchLike;

  constructor(request: FetchLike = fetch) {
    this.request = request;
  }

  canAcquire(candidate: SourceArtifactCandidate): boolean {
    try {
      officialArtifactAddress(candidate.acquisitionReference);
      return (
        candidate.role === "asset.primary-cover" ||
        candidate.role.startsWith("fanbox.attachment.")
      );
    } catch {
      return false;
    }
  }

  async acquire(
    candidate: SourceArtifactCandidate,
  ): Promise<StagedSourceArtifact> {
    const address = officialArtifactAddress(candidate.acquisitionReference);
    const response = await this.request(address, { headers: {} });
    if (!response.ok)
      throw new Error(`FANBOX image request failed: HTTP ${response.status}`);
    const mediaType =
      response.headers.get("content-type") ?? "application/octet-stream";
    if (mediaTypeEssence(mediaType) !== mediaTypeEssence(candidate.mediaType))
      throw new Error("FANBOX image response type differs from its candidate");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > 1024 * 1024 * 1024 ||
      (mediaTypeEssence(mediaType).startsWith("image/") &&
        !isSupportedImage(bytes, mediaType))
    )
      throw new Error("FANBOX artifact response failed bounded validation");
    return {
      candidateId: candidate.id,
      sourceRecordId: candidate.sourceRecordId,
      bytes,
      mediaType,
    };
  }
}

function articleBody(body: FanboxPost["body"]): string | undefined {
  if (!Array.isArray(body?.blocks)) return undefined;
  const paragraphs = body.blocks.flatMap((block) => {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { readonly type?: unknown }).type === "p"
    ) {
      const text = optionalString((block as { readonly text?: unknown }).text);
      return text === undefined ? [] : [text];
    }
    return [];
  });
  return paragraphs.length === 0 ? undefined : paragraphs.join("\n\n");
}

function attachmentCandidates(
  body: FanboxPost["body"],
  sourceRecordId: string,
): {
  readonly candidates: readonly SourceArtifactCandidate[];
  readonly metadata: ReturnType<typeof assertion>[];
} {
  if (body === undefined) return { candidates: [], metadata: [] };
  const candidates: SourceArtifactCandidate[] = [];
  const metadata: ReturnType<typeof assertion>[] = [];
  const seen = new Set<string>();
  const fileMap = recordMap(body.fileMap);
  const imageMap = recordMap(body.imageMap);
  const add = (
    attachment: Record<string, unknown>,
    role: string,
    sourceKey: string,
  ) => {
    if (seen.has(`${role}\u0000${sourceKey}`)) return;
    const address = firstString(
      attachment.url,
      attachment.originalUrl,
      attachment.downloadUrl,
    );
    if (address === undefined) return;
    const official = officialArtifactAddress(address);
    seen.add(`${role}\u0000${sourceKey}`);
    const name = firstString(attachment.name, attachment.fileName);
    if (name !== undefined) {
      metadata.push(
        assertion(
          "fanbox.attachment.name",
          `fanbox.post.attachment:${sourceKey}:name`,
          name,
          sourceRecordId,
        ),
      );
    }
    const size =
      typeof attachment.size === "number" &&
      Number.isSafeInteger(attachment.size) &&
      attachment.size >= 0
        ? String(attachment.size)
        : undefined;
    if (size !== undefined) {
      metadata.push(
        assertion(
          "fanbox.attachment.byte-length",
          `fanbox.post.attachment:${sourceKey}:byte-length`,
          size,
          sourceRecordId,
        ),
      );
    }
    candidates.push({
      id: `source-artifact-candidate_${randomUUID()}`,
      sourceRecordId,
      role,
      acquisitionReference: official,
      mediaType: artifactMediaType(
        firstString(attachment.extension, attachment.name, address) ?? address,
      ),
    });
  };
  if (Array.isArray(body.blocks)) {
    for (const block of body.blocks) {
      if (block === null || typeof block !== "object") continue;
      const value = block as Record<string, unknown>;
      const type = optionalString(value.type) ?? "unknown";
      const role = `fanbox.attachment.${encodeURIComponent(type)}`;
      const fileId = optionalString(value.fileId);
      const imageId = optionalString(value.imageId);
      if (fileId !== undefined) {
        const file = fileMap[fileId];
        if (file !== undefined) add(file, "fanbox.attachment.file", fileId);
        continue;
      }
      if (imageId !== undefined) {
        const image = imageMap[imageId];
        if (image !== undefined) add(image, "fanbox.attachment.image", imageId);
        continue;
      }
      if (
        optionalString(value.url) !== undefined ||
        optionalString(value.originalUrl) !== undefined
      ) {
        add(
          value,
          role,
          optionalString(value.id) ?? `block:${candidates.length}`,
        );
      }
    }
  }
  for (const [key, value] of Object.entries(fileMap))
    add(value, "fanbox.attachment.file", key);
  for (const [key, value] of Object.entries(imageMap))
    add(value, "fanbox.attachment.image", key);
  for (const [index, value] of recordArray(body.files).entries())
    add(
      value,
      "fanbox.attachment.file",
      optionalString(value.id) ?? `file:${index}`,
    );
  for (const [index, value] of recordArray(body.images).entries())
    add(
      value,
      "fanbox.attachment.image",
      optionalString(value.id) ?? `image:${index}`,
    );
  return { candidates, metadata };
}

function recordMap(
  value: unknown,
): Readonly<Record<string, Record<string, unknown>>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? [[key, item as Record<string, unknown>]]
        : [],
    ),
  );
}

function recordArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function publicationDateFromDirectory(value: string): string | undefined {
  const compact = /^(\d{2})\.(\d{2})\.(\d{2})(?:\s|$)/u.exec(value);
  const expanded = /^(\d{4})-(\d{2})-(\d{2})(?:\s|$)/u.exec(value);
  const year =
    expanded === null ? Number(`20${compact?.[1] ?? ""}`) : Number(expanded[1]);
  const month = Number(expanded?.[2] ?? compact?.[2]);
  const day = Number(expanded?.[3] ?? compact?.[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  )
    return undefined;
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  )
    return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function fanboxSummaryPage(
  body: Record<string, unknown>,
  creatorId: string,
): FanboxSummaryPage {
  if (!Array.isArray(body.items))
    throw new Error("FANBOX creator summaries did not contain an items array");
  const posts = body.items.map((item, index) => {
    if (!isRecord(item))
      throw new Error(`FANBOX creator summary item ${index} was not an object`);
    assertPostMatchesCreator(item, creatorId, "summary");
    return item;
  });
  return { posts, nextUrl: summaryNextUrl(body) };
}

function summaryPostForId(
  posts: readonly FanboxPost[],
  postId: string,
): FanboxPost | undefined {
  const matches = distinctPosts(posts.filter((post) => post.id === postId));
  if (matches.length > 1)
    throw new Error(
      "known post identity occurs more than once in creator summaries",
    );
  return matches[0];
}

function summaryPostsForDate(
  posts: readonly FanboxPost[],
  date: string,
): readonly FanboxPost[] {
  return posts.filter(
    (post) => publicationDateOfOptional(post.publishedDatetime) === date,
  );
}

function uniqueSummaryDateSelection(
  selections: readonly FanboxSummarySelection[],
): FanboxSummarySelection {
  const distinct = new Map<string, FanboxSummarySelection>();
  for (const selection of selections) {
    const postId = requiredString(
      selection.selected.id,
      "summary post identity",
    );
    const existing = distinct.get(postId);
    if (
      existing !== undefined &&
      JSON.stringify(existing.selected) !== JSON.stringify(selection.selected)
    ) {
      throw new Error("creator publication date matched conflicting summaries");
    }
    distinct.set(postId, selection);
  }
  if (distinct.size !== 1)
    throw new Error(
      distinct.size === 0
        ? "no post matched the creator publication date"
        : "creator publication date matched more than one post",
    );
  return [...distinct.values()][0]!;
}

function postSummary(body: string, postId: string): FanboxPost {
  const parsed = JSON.parse(body) as unknown;
  const matches: FanboxPost[] = [];
  walkJson(parsed, (value) => {
    if (value.id === postId) matches.push(value);
  });
  if (matches.length === 0)
    throw new Error("FANBOX summary does not contain the addressed post");
  const distinct = [
    ...new Map(matches.map((match) => [JSON.stringify(match), match])).values(),
  ];
  if (distinct.length !== 1)
    throw new Error("FANBOX summary contains conflicting addressed posts");
  return distinct[0]!;
}

/**
 * 受保护详情不可用时，保留的创作者摘要记录仍可独立存在。即使后续详情记录提供了投影标题，
 * 已寻址但格式错误的摘要也不得静默保留为同一帖子的有效来源输入。
 */
function assertAddressedSummaryTitle(body: string, postId: string): void {
  const parsed = JSON.parse(body) as unknown;
  walkJson(parsed, (value) => {
    if (value.id === postId)
      requiredNonBlankString(value.title, "summary post title");
  });
}

function distinctPosts(posts: readonly FanboxPost[]): readonly FanboxPost[] {
  return [
    ...new Map(
      posts.map((post) => [
        `${optionalString(post.id) ?? ""}\u0000${JSON.stringify(post)}`,
        post,
      ]),
    ).values(),
  ];
}

function summaryNextUrl(body: Record<string, unknown>): string | undefined {
  const nextUrl = body.nextUrl;
  if (nextUrl === undefined || nextUrl === null) return undefined;
  if (typeof nextUrl === "string" && nextUrl.length > 0) return nextUrl;
  throw new Error("FANBOX summary next URL was invalid");
}

function canonicalSummaryAddress(value: string, creatorId: string): string {
  let address: URL;
  try {
    address = new URL(value);
  } catch {
    throw new Error("FANBOX summary next URL was invalid");
  }
  if (
    address.protocol !== "https:" ||
    address.hostname !== "api.fanbox.cc" ||
    address.pathname !== "/post.listCreator" ||
    address.username !== "" ||
    address.password !== "" ||
    address.searchParams.get("creatorId") !== creatorId
  ) {
    throw new Error("FANBOX summary next URL was outside the creator endpoint");
  }
  return address.href;
}

function fanboxSuccessfulEnvelope(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !Object.hasOwn(value, "body"))
    throw new Error("FANBOX response did not contain an envelope body");
  if (
    (Object.hasOwn(value, "error") &&
      value.error !== undefined &&
      value.error !== null &&
      value.error !== false &&
      value.error !== "") ||
    (Object.hasOwn(value, "errors") &&
      value.errors !== undefined &&
      value.errors !== null &&
      value.errors !== false)
  ) {
    throw new Error("FANBOX response declared an error");
  }
  if (!isRecord(value.body))
    throw new Error("FANBOX response body was not an object");
  return value.body;
}

function assertPostMatchesCreator(
  post: FanboxPost,
  creatorId: string,
  endpoint: "summary" | "detail",
): void {
  const actualCreatorId = requiredString(post.creatorId, `${endpoint} creator`);
  if (actualCreatorId !== creatorId)
    throw new Error(`FANBOX ${endpoint} post creator differs from its scope`);
  requiredString(post.id, `${endpoint} post identity`);
  requiredNonBlankString(post.title, `${endpoint} post title`);
  publicationDateOf(
    requiredString(post.publishedDatetime, `${endpoint} publication datetime`),
  );
}

function assertPostIdentity(
  post: Record<string, unknown>,
  postId: string,
  creatorId: string,
  endpoint: "summary" | "detail",
): void {
  assertPostMatchesCreator(post, creatorId, endpoint);
  if (post.id !== postId)
    throw new Error(
      `FANBOX ${endpoint} post identity differs from its address`,
    );
}

function detailCompleteness(
  post: Record<string, unknown>,
): "complete" | "incomplete" {
  if (isRestricted(post)) return "incomplete";
  return "complete";
}

/**
 * 每种帖子形态拥有具体的 FANBOX 端点模式。完整性是对该模式的声明，
 * 不只是存在一个名为 `body` 的对象。受限响应刻意保持不完整，因为上游服务可能省略受保护字段。
 */
function validateDetailPost(post: Record<string, unknown>): void {
  if (isRestricted(post)) return;
  const form = requiredString(post.type, "detail post form");
  const body = post.body;
  if (!isRecord(body))
    throw new Error("FANBOX detail body was unavailable without a restriction");
  switch (form) {
    case "text":
      requireBodyText(body, "text");
      return;
    case "file":
      requireAttachmentArray(body.files, "file");
      return;
    case "image":
      requireAttachmentArray(body.images, "image");
      return;
    case "video":
      validateVideoBody(body);
      return;
    case "article":
      validateArticleBody(body);
      return;
    default:
      throw new Error("FANBOX detail post form was unsupported");
  }
}

function requireBodyText(body: Record<string, unknown>, form: string): void {
  if (typeof body.text !== "string" || body.text.trim().length === 0)
    throw new Error(`FANBOX ${form} detail body text was invalid`);
}

function requireAttachmentArray(value: unknown, form: "file" | "image"): void {
  if (!Array.isArray(value))
    throw new Error(`FANBOX ${form} detail attachments were unavailable`);
  if (value.length === 0)
    throw new Error(`FANBOX ${form} detail attachments were empty`);
  for (const attachment of value) validateAttachment(attachment, form);
}

function validateArticleBody(body: Record<string, unknown>): void {
  if (!Array.isArray(body.blocks))
    throw new Error("FANBOX article detail blocks were unavailable");
  if (body.blocks.length === 0)
    throw new Error("FANBOX article detail body was empty");
  const fileMap = attachmentMap(body.fileMap, "file");
  const imageMap = attachmentMap(body.imageMap, "image");
  const embedMap = articleEmbedMap(body.embedMap);
  const urlEmbedMap = articleUrlEmbedMap(body.urlEmbedMap);
  let hasContent = false;
  for (const block of body.blocks) {
    if (!isRecord(block)) throw new Error("FANBOX article block was invalid");
    const type = requiredString(block.type, "article block type");
    switch (type) {
      case "p":
      case "header":
        requireBodyText(block, `article ${type} block`);
        hasContent = true;
        break;
      case "file": {
        const id = requiredNonBlankString(
          block.fileId,
          "article file block identity",
        );
        if (fileMap[id] === undefined)
          throw new Error(
            "FANBOX article file block did not resolve an attachment",
          );
        hasContent = true;
        break;
      }
      case "image": {
        const id = requiredNonBlankString(
          block.imageId,
          "article image block identity",
        );
        if (imageMap[id] === undefined)
          throw new Error(
            "FANBOX article image block did not resolve an attachment",
          );
        hasContent = true;
        break;
      }
      case "embed": {
        const id = requiredNonBlankString(
          block.embedId,
          "article embed block identity",
        );
        if (embedMap[id] === undefined)
          throw new Error(
            "FANBOX article embed block did not resolve an embed",
          );
        hasContent = true;
        break;
      }
      case "url_embed": {
        const id = requiredNonBlankString(
          block.urlEmbedId,
          "article URL embed block identity",
        );
        if (urlEmbedMap[id] === undefined)
          throw new Error(
            "FANBOX article URL embed block did not resolve an embed",
          );
        hasContent = true;
        break;
      }
      default:
        throw new Error("FANBOX article block type was unsupported");
    }
  }
  if (!hasContent) throw new Error("FANBOX article detail body was empty");
}

function articleEmbedMap(
  value: unknown,
): Readonly<Record<string, Record<string, unknown>>> {
  return sourceMap(value, "embed", validateArticleEmbed);
}

function articleUrlEmbedMap(
  value: unknown,
): Readonly<Record<string, Record<string, unknown>>> {
  return sourceMap(value, "URL embed", validateArticleUrlEmbed);
}

function sourceMap(
  value: unknown,
  label: string,
  validate: (value: unknown) => void,
): Readonly<Record<string, Record<string, unknown>>> {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new Error(`FANBOX article ${label} map was invalid`);
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [key, item] of Object.entries(value)) {
    validate(item);
    entries[key] = item as Record<string, unknown>;
  }
  return entries;
}

function validateArticleEmbed(value: unknown): void {
  if (!isRecord(value)) throw new Error("FANBOX article embed was invalid");
  requiredNonBlankString(value.id, "article embed identity");
  const serviceProvider = requiredNonBlankString(
    value.serviceProvider,
    "article embed service provider",
  );
  if (
    ![
      "fanbox",
      "twitter",
      "youtube",
      "vimeo",
      "soundcloud",
      "google_forms",
      "gist",
    ].includes(serviceProvider)
  ) {
    throw new Error("FANBOX article embed service provider was unsupported");
  }
  requiredNonBlankString(value.contentId, "article embed content identity");
}

function validateArticleUrlEmbed(value: unknown): void {
  if (!isRecord(value)) throw new Error("FANBOX article URL embed was invalid");
  requiredNonBlankString(value.id, "article URL embed identity");
  const type = requiredNonBlankString(value.type, "article URL embed type");
  switch (type) {
    case "default": {
      const address = requiredNonBlankString(
        value.url,
        "article URL embed address",
      );
      try {
        new URL(address);
      } catch {
        throw new Error("FANBOX article URL embed address was invalid");
      }
      return;
    }
    case "html":
    case "html.card":
      requiredNonBlankString(value.html, "article URL embed HTML");
      return;
    case "fanbox.post": {
      if (!isRecord(value.postInfo))
        throw new Error("FANBOX article URL embed post was invalid");
      requiredNonBlankString(
        value.postInfo.id,
        "article URL embed post identity",
      );
      return;
    }
    default:
      throw new Error("FANBOX article URL embed type was unsupported");
  }
}

function validateVideoBody(body: Record<string, unknown>): void {
  if (!isRecord(body.video))
    throw new Error("FANBOX video detail payload was unavailable");
  const serviceProvider = requiredNonBlankString(
    body.video.serviceProvider,
    "video service provider",
  );
  requiredNonBlankString(body.video.videoId, "video identity");
  if (!["youtube", "vimeo", "soundcloud"].includes(serviceProvider)) {
    throw new Error("FANBOX video detail payload was unsupported");
  }
  if (body.text !== undefined && typeof body.text !== "string")
    throw new Error("FANBOX video detail text was invalid");
}

function attachmentMap(
  value: unknown,
  form: "file" | "image",
): Readonly<Record<string, Record<string, unknown>>> {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new Error(`FANBOX article ${form} map was invalid`);
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [key, attachment] of Object.entries(value)) {
    validateAttachment(attachment, form);
    entries[key] = attachment as Record<string, unknown>;
  }
  return entries;
}

function validateAttachment(value: unknown, form: "file" | "image"): void {
  if (!isRecord(value))
    throw new Error(`FANBOX ${form} attachment was invalid`);
  requiredNonBlankString(value.id, `${form} attachment identity`);
  const address = firstNonBlankString(
    value.url,
    value.originalUrl,
    value.downloadUrl,
  );
  if (address === undefined)
    throw new Error(`FANBOX ${form} attachment address was unavailable`);
  officialArtifactAddress(address);
}

function summaryCompleteness(
  nextUrl: string | undefined,
): "complete" | "incomplete" {
  return nextUrl === undefined ? "complete" : "incomplete";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonMediaType(value: string | null): value is string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function walkJson(
  value: unknown,
  visit: (value: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  visit(object);
  for (const child of Object.values(object)) walkJson(child, visit);
}

function canonicalPostAddress(creatorId: string, postId: string): string {
  if (!/^\d+$/u.test(postId))
    throw new Error("FANBOX returned an invalid post identity");
  return `https://www.fanbox.cc/@${creatorId}/posts/${postId}`;
}

function parsePostAddress(value: string): {
  readonly creatorId: string;
  readonly postId: string;
} {
  const match =
    /^https:\/\/www\.fanbox\.cc\/@([a-zA-Z0-9_-]+)\/posts\/(\d+)$/u.exec(value);
  if (match === null) throw new Error("Invalid FANBOX source address");
  return { creatorId: match[1]!, postId: match[2]! };
}

function assertion(
  property: string,
  sourceSlot: string,
  value: string,
  sourceRecordId: string,
) {
  return {
    property,
    sourceSlot,
    value,
    sourceRecordIds: [sourceRecordId],
  };
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (result === undefined) throw new Error(`Missing FANBOX ${label}`);
  return result;
}

function requiredNonBlankString(value: unknown, label: string): string {
  const result = optionalNonBlankString(value);
  if (result === undefined) throw new Error(`Missing FANBOX ${label}`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * FANBOX 当前返回 RFC 3339 发布时间戳。只有验证完整端点值后，才能把日期部分视为
 * 来源身份；字符串前缀不构成日期断言。原始表示会保留在来源记录和后续元数据投影中。
 */
function publicationDateOf(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (match === null)
    throw new Error("FANBOX publication datetime was invalid");
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour =
    offsetHourText === undefined ? undefined : Number(offsetHourText);
  const offsetMinute =
    offsetMinuteText === undefined ? undefined : Number(offsetMinuteText);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offsetHour !== undefined &&
      (offsetHour > 14 ||
        offsetMinute! > 59 ||
        (offsetHour === 14 && offsetMinute !== 0)))
  ) {
    throw new Error("FANBOX publication datetime was invalid");
  }
  return `${yearText}-${monthText}-${dayText}`;
}

function publicationDateOfOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return publicationDateOf(value);
  } catch {
    return undefined;
  }
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const result = optionalString(value);
    if (result !== undefined) return result;
  }
  return undefined;
}

function firstNonBlankString(
  ...values: readonly unknown[]
): string | undefined {
  for (const value of values) {
    const result = optionalNonBlankString(value);
    if (result !== undefined) return result;
  }
  return undefined;
}

function countString(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return undefined;
  return String(value);
}

function isRestricted(post: FanboxPost): boolean {
  return (
    post.isRestricted === true ||
    (typeof post.restrictedFor === "string" &&
      post.restrictedFor.length > 0 &&
      post.restrictedFor !== "none")
  );
}

function stableEntityId(namespace: string, sourceKey: string): string {
  return `entity_${createHash("sha256")
    .update(`fanbox:${namespace}:${sourceKey}`)
    .digest("hex")}`;
}

function officialImageAddress(value: string): string {
  return officialArtifactAddress(value);
}

function officialCoverUrl(post: FanboxPost): string | undefined {
  return optionalString(post.coverImageUrl) ?? optionalString(post.cover?.url);
}

function officialArtifactAddress(value: string): string {
  const address = new URL(value);
  if (
    address.protocol !== "https:" ||
    !["downloads.fanbox.cc", "pixiv.pximg.net"].includes(address.hostname) ||
    address.username !== "" ||
    address.password !== ""
  )
    throw new Error("FANBOX image must use an official HTTPS image host");
  return address.href;
}

function imageMediaType(value: string): string {
  return artifactMediaType(value);
}

function artifactMediaType(value: string): string {
  let extension: string;
  try {
    extension = new URL(value).pathname.split(".").at(-1)?.toLowerCase() ?? "";
  } catch {
    extension = value.replace(/^\./u, "").toLowerCase();
  }
  switch (extension) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "zip":
      return "application/zip";
    case "pdf":
      return "application/pdf";
    default:
      return "image/jpeg";
  }
}

function mediaTypeEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isSupportedImage(bytes: Uint8Array, mediaType: string): boolean {
  switch (mediaTypeEssence(mediaType)) {
    case "image/jpeg":
      return (
        bytes.length >= 4 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes.at(-2) === 0xff &&
        bytes.at(-1) === 0xd9
      );
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      );
    case "image/webp":
      return (
        new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
        new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
      );
    default:
      return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
