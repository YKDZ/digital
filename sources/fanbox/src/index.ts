import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  knownSourceAssociationEvidenceCapability,
  type AssetRefreshWorkPlan,
  type DirectoryInterpreter,
  type FilesystemPackageSnapshot,
  type Recognizer,
  type RecognitionCandidateContext,
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

import {
  FanboxSessionTransportFault,
  createPlaywrightFanboxSessionTransport,
  fanboxEndpointAddress,
  type FanboxClosedEndpoint,
  type FanboxClosedGet,
  type FanboxEndpointSessionTransport,
  type FanboxPrivateBrowserContextV2,
  type FanboxSessionResponse,
} from "./browser-session.ts";

const directoryCapability = declareCapability({
  identity: "fanbox.creator-date-directory",
  implementationVersion: "2",
  kind: "directory-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
export const fanboxOfficialCollectionCapability = declareCapability({
  identity: "fanbox.official-collection",
  implementationVersion: "2",
  kind: "source-collector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
/**
 * 浏览器请求上下文是独立于 FANBOX 采集契约的私有能力。Cookie 与 User-Agent
 * 绝不会进入领域层或应用层。
 */
export const fanboxSourceConnectionCapability = declareCapability({
  identity: "fanbox.source-connection",
  implementationVersion: "2",
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
  implementationVersion: "2",
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
const maximumCreatorSummaryPosts = 300;

type FanboxArtifactFetch = (
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

export type FanboxProductAssembly = {
  readonly validatedBrowserCredential: (input: {
    readonly creatorId: string;
    readonly browserCredential: unknown;
  }) => Promise<string>;
  readonly verifyStoredCredential: (input: {
    readonly creatorId: string;
    readonly privateConfiguration: string;
  }) => Promise<void>;
  readonly createCollector: (input: {
    readonly creatorIds: () => readonly string[];
    readonly privateConfigurationForExecution: (input: {
      readonly creatorId: string;
      readonly context: SourceCollectionExecutionContext | undefined;
    }) => string | undefined;
  }) => SourceCollector;
  close(): Promise<void>;
};

/** 建立生产 FANBOX 能力闭包；factory 本身不启动 Chromium。 */
export function createFanboxProductAssembly(): FanboxProductAssembly {
  return createFanboxProductAssemblyWithTransport(
    createPlaywrightFanboxSessionTransport(),
  );
}

/** 仅供 FANBOX 生产装配与 testing 子路径使用；不经 production public facade 暴露。 */
export function createFanboxProductAssemblyWithTransport(
  transport: FanboxEndpointSessionTransport,
): FanboxProductAssembly {
  return {
    async validatedBrowserCredential(input) {
      if (!isFanboxCreatorId(input.creatorId))
        throw new Error("FANBOX 创作者范围无效");
      const privateConfiguration = serializedFanboxBrowserCredential(
        input.browserCredential,
      );
      const credential = fanboxPrivateCredential(privateConfiguration);
      if (credential === undefined) throw new Error("FANBOX 来源连接验证失败");
      try {
        await verifyFanboxStoredCredentialWithTransport({
          creatorId: input.creatorId,
          credential,
          transport,
        });
      } catch {
        throw new Error("FANBOX 来源连接验证失败");
      }
      return privateConfiguration;
    },
    async verifyStoredCredential(input) {
      if (!isFanboxCreatorId(input.creatorId))
        throw new Error("FANBOX 创作者范围无效");
      const credential = fanboxPrivateCredential(input.privateConfiguration);
      if (credential === undefined) throw new Error("FANBOX 来源连接验证失败");
      try {
        await verifyFanboxStoredCredentialWithTransport({
          creatorId: input.creatorId,
          credential,
          transport,
        });
      } catch {
        throw new Error("FANBOX 来源连接验证失败");
      }
    },
    createCollector(input) {
      const collector = new FanboxCollector(transport, {
        creatorIds: input.creatorIds,
        privateConfigurationForExecution:
          input.privateConfigurationForExecution,
      });
      return collector;
    },
    close: () => transport.close(),
  };
}

async function verifyFanboxStoredCredentialWithTransport(input: {
  readonly creatorId: string;
  readonly credential: FanboxPrivateCredential;
  readonly transport: FanboxEndpointSessionTransport;
}): Promise<void> {
  await input.transport.transact({
    creatorId: input.creatorId,
    privateContext: input.credential.privateContext,
    use: async (get) => {
      const authentication = await verifiedFanboxSessionJson(get, {
        kind: "login-status",
      });
      if (!isFanboxAuthenticatedSessionEnvelope(authentication))
        throw new Error("invalid authenticated session");
      const summaries = fanboxSummaryPosts(
        fanboxSuccessfulEnvelope(
          await verifiedFanboxSessionJson(get, {
            kind: "creator-summaries",
            creatorId: input.creatorId,
            limit: 1,
          }),
        ),
        input.creatorId,
      );
      if (summaries.length !== 1)
        throw new Error("verification summary count was not exactly one");
      const postId = requiredString(summaries[0]!.id, "summary post identity");
      const detail = fanboxDetailPost(
        fanboxSuccessfulEnvelope(
          await verifiedFanboxSessionJson(get, {
            kind: "post-detail",
            postId,
            access: "connected",
          }),
        ),
      );
      assertPostIdentity(detail, postId, input.creatorId, "detail");
    },
  });
}

async function verifiedFanboxSessionJson(
  get: FanboxClosedGet,
  endpoint: FanboxClosedEndpoint,
): Promise<unknown> {
  const response = await get(endpoint);
  if (
    response.kind !== "response" ||
    response.status < 200 ||
    response.status >= 300 ||
    !isJsonMediaType(response.mediaType) ||
    response.body.byteLength === 0
  ) {
    throw new Error("invalid response");
  }
  return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
}

function sessionTransactionFailure(error: unknown): FanboxCollectionFault {
  if (error instanceof FanboxCollectionFault) return error;
  return new FanboxCollectionFault(
    "FANBOX browser session transport failed",
    "transport-failure",
  );
}

function serializedFanboxBrowserCredential(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ["cookies", "userAgent"]))
    throw new Error("FANBOX 浏览器凭据格式无效");
  const userAgent = fanboxBrowserUserAgent(value.userAgent);
  const cookies = fanboxBrowserCookies(value.cookies);
  return JSON.stringify({
    format: "fanbox-browser-request-context/2",
    userAgent,
    cookies,
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function fanboxBrowserUserAgent(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > 512 ||
    !/^[\x20-\x7E]+$/u.test(value)
  )
    throw new Error("FANBOX 浏览器凭据格式无效");
  return value;
}

function fanboxBrowserCookies(
  value: unknown,
): FanboxPrivateBrowserContextV2["cookies"] {
  if (!Array.isArray(value)) throw new Error("FANBOX 浏览器凭据格式无效");
  const cookies: FanboxPrivateBrowserContextV2["cookies"][number][] = [];
  const identities = new Map<string, string>();
  let hasSession = false;
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new Error("FANBOX 浏览器凭据格式无效");
    const cookie = item as {
      readonly name?: unknown;
      readonly value?: unknown;
      readonly domain?: unknown;
      readonly path?: unknown;
      readonly secure?: unknown;
      readonly httpOnly?: unknown;
      readonly sameSite?: unknown;
      readonly expirationDate?: unknown;
      readonly expires?: unknown;
    };
    if (
      typeof cookie.name !== "string" ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(cookie.name) ||
      typeof cookie.value !== "string" ||
      cookie.value.length === 0 ||
      !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/u.test(cookie.value) ||
      (cookie.domain !== "fanbox.cc" && cookie.domain !== ".fanbox.cc") ||
      (cookie.path !== undefined &&
        (typeof cookie.path !== "string" ||
          !cookie.path.startsWith("/") ||
          containsControlCharacter(cookie.path))) ||
      (cookie.secure !== undefined && typeof cookie.secure !== "boolean") ||
      (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean")
    ) {
      throw new Error("FANBOX 浏览器凭据格式无效");
    }
    const sameSite = normalizedSameSite(cookie.sameSite);
    if (cookie.sameSite !== undefined && sameSite === undefined)
      throw new Error("FANBOX 浏览器凭据格式无效");
    const expirationDate = cookie.expirationDate;
    const expires = cookie.expires;
    if (
      (expirationDate !== undefined &&
        (typeof expirationDate !== "number" ||
          !Number.isFinite(expirationDate))) ||
      (expires !== undefined &&
        (typeof expires !== "number" || !Number.isFinite(expires))) ||
      (expirationDate !== undefined &&
        expires !== undefined &&
        expirationDate !== expires)
    )
      throw new Error("FANBOX 浏览器凭据格式无效");
    const normalized = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? "/",
      ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
      ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      ...(sameSite === undefined ? {} : { sameSite }),
      ...(expirationDate === undefined && expires === undefined
        ? {}
        : { expires: (expirationDate ?? expires)! }),
    } satisfies FanboxPrivateBrowserContextV2["cookies"][number];
    const identity = `${normalized.name}\u0000${normalized.domain}\u0000${normalized.path}`;
    const serialized = JSON.stringify(normalized);
    const previous = identities.get(identity);
    if (previous !== undefined && previous !== serialized)
      throw new Error("FANBOX 浏览器凭据格式无效");
    if (previous === undefined) {
      identities.set(identity, serialized);
      cookies.push(normalized);
    }
    hasSession ||= cookie.name === "FANBOXSESSID";
  }
  if (cookies.length === 0 || !hasSession)
    throw new Error("FANBOX 浏览器凭据缺少有效会话");
  return cookies;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}

function normalizedSameSite(
  value: unknown,
): "Strict" | "Lax" | "None" | undefined {
  if (value === undefined) return undefined;
  if (value === "strict" || value === "Strict") return "Strict";
  if (value === "lax" || value === "Lax") return "Lax";
  if (value === "none" || value === "None" || value === "no_restriction")
    return "None";
  return undefined;
}

function isFanboxAuthenticatedSessionEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const envelope = value as Record<string, unknown>;
  if (
    !Object.hasOwn(envelope, "body") ||
    Object.hasOwn(envelope, "error") ||
    Object.hasOwn(envelope, "errors")
  ) {
    return false;
  }
  const body = envelope.body;
  return typeof body === "number" && Number.isSafeInteger(body) && body >= 0;
}

/**
 * 被拒绝的传输仍可留下有效但范围更窄的摘要记录；无效的 HTTP 成功 JSON 则不行，
 * 因为它根本没有形成来源证据。
 */
type FanboxFailureKind =
  | "transport-failure"
  | "cloudflare-challenge"
  | "summary-selection"
  | "response-contract"
  | "source-identity-conflict"
  | "detail-contract"
  | "connection-unavailable"
  | "unknown";

class FanboxCollectionFault extends Error {
  readonly failureCode: string;

  constructor(message: string, failureCode: string) {
    super(message);
    this.failureCode = failureCode;
  }
}

class FanboxTransportFailure extends FanboxCollectionFault {
  constructor(message: string, failureCode = "transport-failure") {
    super(message, failureCode);
  }
}

export type FanboxCollectionFailureCause =
  | { readonly category: FanboxFailureKind }
  | {
      readonly category: "http-status";
      readonly status: number;
      readonly class: "4xx" | "5xx";
    };

export function decodeFanboxCollectionFailureCode(input: {
  readonly capability: SourceCollectionFailure["capability"];
  readonly code: string;
}): FanboxCollectionFailureCause | undefined {
  if (
    !sameCapabilityCoordinate(
      input.capability,
      fanboxOfficialCollectionCapability,
    )
  )
    return undefined;
  if (
    input.code === "transport-failure" ||
    input.code === "cloudflare-challenge" ||
    input.code === "summary-selection" ||
    input.code === "response-contract" ||
    input.code === "source-identity-conflict" ||
    input.code === "detail-contract" ||
    input.code === "connection-unavailable" ||
    input.code === "unknown"
  ) {
    return { category: input.code };
  }
  const match = /^http:(creator-summaries|post-detail):([45][0-9]{2})$/u.exec(
    input.code,
  );
  if (match === null) return undefined;
  const status = Number(match[2]);
  return {
    category: "http-status",
    status,
    class: status < 500 ? "4xx" : "5xx",
  };
}

export class FanboxDateDirectoryInterpreter implements DirectoryInterpreter {
  readonly capability = directoryCapability;

  interpret(
    snapshot: FilesystemPackageSnapshot,
  ): AssetRefreshWorkPlan | readonly RecognitionEvidence[] {
    const rootComponents = snapshot.root.split(/[\\/]/u).filter(Boolean);
    const groups = new Map<
      string,
      { creatorId: string; date: string; relativePaths: string[] }
    >();
    for (const file of snapshot.files) {
      const directories = [
        rootComponents.at(-2) ?? "",
        rootComponents.at(-1) ?? "",
        ...file.relativePath.split("/").slice(0, -1),
      ];
      for (let index = 1; index < directories.length; index++) {
        const creatorId = directories[index - 1]!;
        if (!isFanboxCreatorId(creatorId)) continue;
        const date = publicationDateFromDirectory(directories[index]!);
        if (date === undefined) continue;
        const relativeRoot = directories.slice(2, index + 1).join("/") || ".";
        const group = groups.get(relativeRoot) ?? {
          creatorId,
          date,
          relativePaths: [],
        };
        group.relativePaths.push(file.relativePath);
        groups.set(relativeRoot, group);
        // 日期目录的普通子树都服务这项内容，不再从内容内猜另一篇帖子。
        break;
      }
    }
    const workItems = [...groups].map(([relativeRoot, group]) => ({
      key: `fanbox:date-directory:${relativeRoot}`,
      relativePaths: group.relativePaths.toSorted(),
      materialBoundary: {
        kind: "directory" as const,
        relativePath: relativeRoot,
      },
      evidence: [
        {
          kind: "directory-convention",
          sourceIdentity: "fanbox",
          explanation: "FANBOX creatorId 与发布日期目录规则匹配",
          producer: this.capability,
          sourceAddress: `fanbox-directory:${group.creatorId}:${group.date}`,
        },
      ],
    }));
    return workItems.length === 0 ? [] : { workItems };
  }
}

class FanboxCollector implements SourceCollector {
  readonly capability = fanboxOfficialCollectionCapability;
  private readonly creatorIds: () => readonly string[];
  private readonly privateConfigurationForExecution: (input: {
    readonly creatorId: string;
    readonly context: SourceCollectionExecutionContext | undefined;
  }) => string | undefined;
  private readonly transport: FanboxEndpointSessionTransport;

  constructor(
    transport: FanboxEndpointSessionTransport,
    options: {
      readonly creatorIds: () => readonly string[];
      readonly privateConfigurationForExecution: (input: {
        readonly creatorId: string;
        readonly context: SourceCollectionExecutionContext | undefined;
      }) => string | undefined;
    },
  ) {
    this.creatorIds = () =>
      options.creatorIds().filter((value) => isFanboxCreatorId(value));
    this.transport = transport;
    this.privateConfigurationForExecution =
      options.privateConfigurationForExecution;
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
    if (creatorId === undefined)
      return {
        records: [],
        failures: [
          {
            capability: this.capability,
            reason: "FANBOX evidence does not belong to this creator scope",
            failureCode: "unknown",
          },
        ],
      };
    if (!this.creatorIds().includes(creatorId))
      return {
        records: [],
        failures: [
          {
            capability: this.capability,
            reason: "FANBOX 创作者范围缺少当前执行可用的私有来源连接",
            failureCode: "connection-unavailable",
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
            failureCode: "connection-unavailable",
            affects: {
              recognition: true,
              metadataProperties: [
                "asset.title",
                "asset.publication-datetime",
                "fanbox.post.*",
                "asset.body",
              ],
              artifactRoles: ["asset.primary-cover", "fanbox.attachment.*"],
            },
          },
        ],
      };
    }
    try {
      return await this.transport.transact({
        creatorId,
        privateContext: credential.privateContext,
        use: async (get) =>
          await this.collectInSession(evidence, creatorId, credential, get),
      });
    } catch (error) {
      return {
        records: [],
        failures: [this.failure(sessionTransactionFailure(error), credential)],
      };
    }
  }

  private async collectInSession(
    evidence: RecognitionEvidence,
    creatorId: string,
    credential: FanboxPrivateCredential,
    get: FanboxClosedGet,
  ): Promise<SourceCollectionResult> {
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
        get,
        ...(date === undefined
          ? { postId: associated!.postId }
          : { publicationDate: date }),
      });
    } catch (error) {
      return { records: [], failures: [this.failure(error, credential)] };
    }
    const { captured: capturedSummary, selected } = summarySelection;
    let postId: string;
    let summaryPublicationDatetime: string;
    try {
      postId = requiredString(selected.id, "summary post identity");
      summaryPublicationDatetime = requiredString(
        selected.publishedDatetime,
        "summary publication datetime",
      );
    } catch (error) {
      return {
        records: [],
        failures: [
          this.failure(
            new FanboxCollectionFault(errorMessage(error), "response-contract"),
            credential,
          ),
        ],
      };
    }
    const nativeAddress = canonicalPostAddress(creatorId, postId);
    const summary = this.sourceRecord(
      capturedSummary,
      nativeAddress,
      "fanbox.creator-post-summaries",
      summarySelection.completeness,
    );
    let authenticatedDetailFailure: FanboxTransportFailure | undefined;
    let detailAuthorized = true;
    try {
      let capturedDetail: CapturedFanboxResponse;
      try {
        capturedDetail = await this.capture(
          {
            kind: "post-detail",
            postId,
            access: "connected",
          },
          "fanbox.post-detail",
          credential,
          get,
        );
      } catch (error) {
        if (!(error instanceof FanboxTransportFailure)) throw error;
        authenticatedDetailFailure = error;
        detailAuthorized = false;
        capturedDetail = await this.capture(
          { kind: "post-detail", postId, access: "public" },
          "fanbox.post-detail",
          credential,
          get,
        );
      }
      let detailPost: Record<string, unknown>;
      try {
        detailPost = fanboxDetailPost(capturedDetail.envelopeBody);
      } catch (error) {
        throw new FanboxCollectionFault(
          errorMessage(error),
          "response-contract",
        );
      }
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
              new FanboxCollectionFault(
                errorMessage(error),
                "source-identity-conflict",
              ),
              credential,
              nativeAddress,
            ),
          ],
        };
      }
      try {
        validateDetailPost(detailPost);
      } catch (error) {
        throw new FanboxCollectionFault(errorMessage(error), "detail-contract");
      }
      const detail = this.sourceRecord(
        capturedDetail,
        nativeAddress,
        "fanbox.post-detail",
        detailCompleteness(detailPost),
        detailAuthorized,
      );
      return {
        records: [summary, detail],
        failures:
          authenticatedDetailFailure === undefined ||
          detail.coverage.completeness === "complete"
            ? []
            : [
                this.detailFailure(
                  authenticatedDetailFailure,
                  credential,
                  nativeAddress,
                ),
              ],
      };
    } catch (error) {
      // 所选创作者摘要响应是独立且有效的来源覆盖边界。格式错误、不可用或权限受限的
      // 详情端点不能把它变成空来源响应；只会让详情事实族不可用。
      return {
        records: [summary],
        failures: [this.detailFailure(error, credential, nativeAddress)],
      };
    }
  }

  private async selectSummary(input: {
    readonly creatorId: string;
    readonly credential: FanboxPrivateCredential;
    readonly get: FanboxClosedGet;
    readonly postId?: string;
    readonly publicationDate?: string;
  }): Promise<FanboxSummarySelection> {
    const captured = await this.capture(
      {
        kind: "creator-summaries",
        creatorId: input.creatorId,
        limit: maximumCreatorSummaryPosts,
      },
      "fanbox.creator-post-summaries",
      input.credential,
      input.get,
    );
    let posts: readonly FanboxPost[];
    try {
      posts = fanboxSummaryPosts(captured.envelopeBody, input.creatorId);
    } catch (error) {
      if (error instanceof FanboxCollectionFault) throw error;
      throw new FanboxCollectionFault(errorMessage(error), "response-contract");
    }
    const completeness = summaryCompleteness(posts.length);
    if (input.postId !== undefined) {
      let selected: FanboxPost | undefined;
      try {
        selected = summaryPostForId(posts, input.postId);
      } catch (error) {
        throw new FanboxCollectionFault(
          errorMessage(error),
          "summary-selection",
        );
      }
      if (selected !== undefined) return { captured, selected, completeness };
      if (completeness === "incomplete")
        throw new FanboxCollectionFault(
          "known post identity is absent from truncated creator summaries",
          "summary-selection",
        );
      throw new FanboxCollectionFault(
        "known post identity is absent from creator summaries",
        "summary-selection",
      );
    }
    const dateMatches = summaryPostsForDate(posts, input.publicationDate!).map(
      (selected) => ({ captured, selected, completeness }),
    );
    if (dateMatches.length === 0 && completeness === "incomplete")
      throw new FanboxCollectionFault(
        "creator publication date is absent from truncated creator summaries",
        "summary-selection",
      );
    try {
      return uniqueSummaryDateSelection(dateMatches);
    } catch (error) {
      throw new FanboxCollectionFault(errorMessage(error), "summary-selection");
    }
  }

  private credentialForExecution(
    creatorId: string,
    context: SourceCollectionExecutionContext | undefined,
  ): FanboxPrivateCredential | undefined {
    const privateConfiguration = this.privateConfigurationForExecution({
      creatorId,
      context,
    });
    return privateConfiguration === undefined
      ? undefined
      : fanboxPrivateCredential(privateConfiguration);
  }

  private failure(
    error: unknown,
    credential: FanboxPrivateCredential,
  ): SourceCollectionFailure {
    return {
      capability: this.capability,
      reason: this.failureReason(error, credential),
      failureCode:
        error instanceof FanboxCollectionFault ? error.failureCode : "unknown",
    };
  }

  private detailFailure(
    error: unknown,
    credential: FanboxPrivateCredential,
    nativeAddress: string,
  ): SourceCollectionFailure {
    return {
      capability: this.capability,
      reason: this.failureReason(error, credential),
      failureCode:
        error instanceof FanboxCollectionFault ? error.failureCode : "unknown",
      coverage: {
        sourceIdentity: "fanbox",
        nativeAddress,
        coverageId: "fanbox.post-detail",
      },
      affects: {
        metadataProperties: ["fanbox.post.form", "asset.body"],
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
    endpoint: Exclude<FanboxClosedEndpoint, { readonly kind: "login-status" }>,
    coverage: string,
    credential: FanboxPrivateCredential,
    get: FanboxClosedGet,
  ): Promise<CapturedFanboxResponse> {
    let response: FanboxSessionResponse;
    try {
      response = await get(endpoint);
    } catch (error) {
      if (
        error instanceof FanboxSessionTransportFault &&
        error.category === "network-failure"
      )
        throw new FanboxTransportFailure("renderer request failed");
      throw sessionTransactionFailure(error);
    }
    if (response.kind === "response-limit")
      throw new FanboxCollectionFault(
        "response did not meet the capture limits",
        "response-contract",
      );
    if (response.kind === "cloudflare-challenge")
      throw new FanboxTransportFailure(
        "Cloudflare challenge blocked the official API request; refresh the private browser clearance before retrying",
        "cloudflare-challenge",
      );
    if (response.status < 200 || response.status >= 300) {
      throw rejectedResponseFault(coverage, response.status);
    }
    const mediaType = response.mediaType;
    if (!isJsonMediaType(mediaType))
      throw new FanboxCollectionFault(
        `FANBOX ${coverage} response media type was not JSON`,
        "response-contract",
      );
    const bytes = response.body;
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes)
      throw new FanboxCollectionFault(
        "response did not meet the capture limits",
        "response-contract",
      );
    const body = new TextDecoder().decode(bytes);
    let envelopeBody: Record<string, unknown>;
    try {
      envelopeBody = fanboxSuccessfulEnvelope(JSON.parse(body) as unknown);
    } catch {
      throw new FanboxCollectionFault(
        `FANBOX ${coverage} response was not a successful envelope`,
        "response-contract",
      );
    }
    if (credential?.containsPrivateConfiguration(body)) {
      throw new FanboxCollectionFault(
        "response contained private configuration and was not retained",
        "response-contract",
      );
    }
    return {
      requestedAddress: fanboxEndpointAddress(endpoint),
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
    authorized = true,
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
        authorized,
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
  readonly privateConfiguration: string;
  readonly privateContext: FanboxPrivateBrowserContextV2;
  readonly userAgent: string;
  containsPrivateConfiguration(value: string): boolean;
  removePrivateConfiguration(value: string): string;
};

function fanboxPrivateCredential(
  privateConfiguration: string,
): FanboxPrivateCredential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(privateConfiguration) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["cookies", "format", "userAgent"]) ||
    parsed.format !== "fanbox-browser-request-context/2" ||
    typeof parsed.userAgent !== "string" ||
    !Array.isArray(parsed.cookies)
  )
    return undefined;
  let userAgent: string;
  let cookies: FanboxPrivateBrowserContextV2["cookies"];
  try {
    userAgent = fanboxBrowserUserAgent(parsed.userAgent);
    cookies = fanboxBrowserCookies(parsed.cookies);
  } catch {
    return undefined;
  }
  const privateContext: FanboxPrivateBrowserContextV2 = {
    format: "fanbox-browser-request-context/2",
    userAgent,
    cookies,
  };
  if (JSON.stringify(privateContext) !== privateConfiguration) return undefined;
  const sensitiveCookiePairs = cookies.map(
    (cookie) => `${cookie.name}=${cookie.value}`,
  );
  // 裸露的短值（例如 A/B 实验标志）会自然出现在 HTTP 诊断中。完整 Cookie 对保持私有，
  // 只有形似令牌的值会作为独立子串被遮盖。
  const sensitiveCookieValues = sensitiveCookiePairs
    .map((pair) => pair.slice(pair.indexOf("=") + 1))
    .filter((secret) => secret.length >= 8);
  const sensitiveConfigurationValues = [
    ...sensitiveCookieValues,
    ...sensitiveCookiePairs,
    userAgent,
  ];
  const sensitiveRepresentations = sensitiveConfigurationValues.flatMap(
    (secret) => privateRepresentations(secret),
  );
  const sensitivePatterns = sensitiveConfigurationValues.map(
    (secret) => new RegExp(privateRepresentationPattern(secret), "u"),
  );
  const containsPrivateConfiguration = (value: string): boolean =>
    value.includes(privateConfiguration) ||
    sensitiveCookiePairs.some((pair) => value.includes(pair)) ||
    sensitiveRepresentations.some((secret) => value.includes(secret)) ||
    sensitivePatterns.some((pattern) => pattern.test(value));
  return {
    privateConfiguration,
    privateContext,
    userAgent,
    containsPrivateConfiguration,
    removePrivateConfiguration(value) {
      let sanitized = value.replaceAll(
        privateConfiguration,
        "[credential removed]",
      );
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

function rejectedResponseFault(
  coverage: string,
  status: number,
): FanboxCollectionFault {
  const endpoint =
    coverage === "fanbox.creator-post-summaries"
      ? "creator-summaries"
      : coverage === "fanbox.post-detail"
        ? "post-detail"
        : undefined;
  return endpoint !== undefined && status >= 400 && status <= 599
    ? new FanboxTransportFailure(`HTTP ${status}`, `http:${endpoint}:${status}`)
    : new FanboxCollectionFault(`HTTP ${status}`, "response-contract");
}

export const trustedFanboxCreatorDateRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "unique-creator-publication-date",
  ruleVersion: "2",
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

type FanboxSummarySelection = {
  readonly captured: CapturedFanboxResponse;
  readonly selected: FanboxPost;
  readonly completeness: "complete" | "incomplete";
};

export class FanboxSourceInterpreter implements SourceInterpreter {
  readonly relationshipDefinitions = [
    {
      id: "fanbox.post-creation",
      type: "asset.contribution",
      label: "帖子创作",
      roles: [
        { role: "asset", label: "帖子", minimum: 1, maximum: 1 },
        { role: "fanbox.post.creator", label: "创作者", minimum: 1 },
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
  }): readonly SourceInterpretationBatch[] {
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
    const summaryPosts = fanboxSummaryPosts(
      fanboxSuccessfulEnvelope(JSON.parse(summary.body) as unknown),
      source.creatorId,
    );
    const summaryPost = summaryPostForId(summaryPosts, source.postId);
    if (summaryPost === undefined)
      throw new Error("FANBOX summary does not contain the addressed post");
    const detailPost =
      detail === undefined
        ? undefined
        : fanboxDetailPost(
            fanboxSuccessfulEnvelope(JSON.parse(detail.body) as unknown),
          );
    if (detailPost !== undefined) validateDetailPost(detailPost);
    const post = detailPost ?? summaryPost;
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
    const metadata: ReturnType<typeof assertion>[] = [];
    if (detailPost !== undefined) {
      metadata.push(
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
          isRestricted(post) ? "restricted" : "available",
          factRecord.id,
        ),
      );
      if (form !== undefined)
        metadata.push(
          assertion(
            "fanbox.post.form",
            "fanbox.post.form",
            form,
            factRecord.id,
          ),
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
      metadata.push(...articleBlockAssertions(post.body, factRecord.id));
    }
    const detailCoverUrl =
      detailPost === undefined ? undefined : officialCoverUrl(detailPost);
    const summaryCoverPost = detailPost === undefined ? undefined : summaryPost;
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
              id: stableSourceArtifactCandidateId(
                coverRecord.id,
                "asset.primary-cover",
                coverUrl,
              ),
              sourceRecordId: coverRecord.id,
              role: "asset.primary-cover",
              acquisitionReference: officialImageAddress(coverUrl),
              mediaType: imageMediaType(coverUrl),
            },
          ];
    sourceArtifacts.push(
      ...attachmentCandidates(detailPost?.body, factRecord.id),
    );
    const label = optionalString(post.user?.name) ?? creatorId;
    const entity: SourcedEntity = {
      id: stableEntityId("fanbox.creator", creatorId),
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
      participants: [
        {
          entityId: entity.id,
          role: "fanbox.post.creator",
          mentionIds: [mention.id],
        },
      ],
      subjectRole: "asset",
      requiredRoles: ["asset", "fanbox.post.creator"],
      type: "asset.contribution",
      sourceSlot: `fanbox.post.creator:${creatorId}`,
      sourceRecordIds: [factRecord.id],
    };
    return [
      {
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
      },
    ];
  }
}

export class FanboxExactRecognizer implements Recognizer {
  readonly capability = recognizerCapability;

  canRecognize(input: RecognitionCandidateContext): boolean {
    return (
      input.basis.kind === "source-interpretation" &&
      input.basis.interpretation.producer.capabilityId ===
        interpreterCapability.capabilityId
    );
  }

  recognize(input: RecognitionCandidateContext): RecognitionProposalDraft {
    if (input.basis.kind !== "source-interpretation")
      throw new Error("FANBOX recognizer requires source interpretation");
    const interpretation = input.basis.interpretation;
    const published = interpretation.metadata.find(
      (item) => item.property === "asset.publication-datetime",
    )?.value;
    const source = parsePostAddress(interpretation.sourceAddress);
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
  private readonly request: FanboxArtifactFetch;

  constructor(request: FanboxArtifactFetch = fetch) {
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

function articleBlockAssertions(
  body: FanboxPost["body"],
  sourceRecordId: string,
): ReturnType<typeof assertion>[] {
  if (!Array.isArray(body?.blocks)) return [];
  const embedMap = recordMap(body.embedMap);
  const urlEmbedMap = recordMap(body.urlEmbedMap);
  return body.blocks.map((block, ordinal) => {
    const value = block as Record<string, unknown>;
    const type = requiredString(value.type, "article block type");
    let projected: Readonly<Record<string, unknown>>;
    switch (type) {
      case "p":
        projected = {
          type,
          text: requiredArticleParagraphText(value),
        };
        break;
      case "header":
        projected = {
          type,
          text: requiredNonBlankString(value.text, `article ${type} block`),
        };
        break;
      case "file":
        projected = {
          type,
          fileId: requiredNonBlankString(
            value.fileId,
            "article file block identity",
          ),
        };
        break;
      case "image":
        projected = {
          type,
          imageId: requiredNonBlankString(
            value.imageId,
            "article image block identity",
          ),
        };
        break;
      case "embed": {
        const id = requiredNonBlankString(
          value.embedId,
          "article embed block identity",
        );
        const embed = embedMap[id]!;
        projected = {
          type,
          embed: {
            id: requiredNonBlankString(embed.id, "article embed identity"),
            serviceProvider: requiredNonBlankString(
              embed.serviceProvider,
              "article embed service provider",
            ),
            contentId: requiredNonBlankString(
              embed.contentId,
              "article embed content identity",
            ),
          },
        };
        break;
      }
      case "url_embed": {
        const id = requiredNonBlankString(
          value.urlEmbedId,
          "article URL embed block identity",
        );
        projected = { type, urlEmbed: projectedUrlEmbed(urlEmbedMap[id]!) };
        break;
      }
      default:
        throw new Error("FANBOX article block type was unsupported");
    }
    return assertion(
      "fanbox.post.body-block",
      `fanbox.post.body-block:${ordinal}`,
      JSON.stringify(projected),
      sourceRecordId,
      [
        { key: "fanbox.post.block-type", value: type },
        { key: "fanbox.post.block-ordinal", value: String(ordinal) },
      ],
    );
  });
}

function projectedUrlEmbed(
  value: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const id = requiredNonBlankString(value.id, "article URL embed identity");
  const type = requiredNonBlankString(value.type, "article URL embed type");
  switch (type) {
    case "default":
      return {
        id,
        type,
        url: requiredNonBlankString(value.url, "article URL embed address"),
      };
    case "html":
    case "html.card":
      return {
        id,
        type,
        html: requiredNonBlankString(value.html, "article URL embed HTML"),
      };
    case "fanbox.post":
      return {
        id,
        type,
        postInfo: {
          id: requiredNonBlankString(
            (value.postInfo as Record<string, unknown>).id,
            "article URL embed post identity",
          ),
        },
      };
    default:
      throw new Error("FANBOX article URL embed type was unsupported");
  }
}

function attachmentCandidates(
  body: FanboxPost["body"],
  sourceRecordId: string,
): readonly SourceArtifactCandidate[] {
  if (!isRecord(body)) return [];
  const candidates: SourceArtifactCandidate[] = [];
  const seen = new Set<string>();
  const fileMap = recordMap(body.fileMap);
  const imageMap = recordMap(body.imageMap);
  const add = (
    attachment: Record<string, unknown>,
    kind: "file" | "image",
    sourceKey: string,
  ) => {
    const role = `fanbox.attachment.${kind}`;
    if (seen.has(`${role}\u0000${sourceKey}`)) return;
    const address = firstString(
      attachment.url,
      attachment.originalUrl,
      attachment.downloadUrl,
    );
    if (address === undefined) return;
    const official = officialArtifactAddress(address);
    seen.add(`${role}\u0000${sourceKey}`);
    const ordinal = candidates.length;
    const name = firstString(attachment.name, attachment.fileName);
    const size =
      typeof attachment.size === "number" &&
      Number.isSafeInteger(attachment.size) &&
      attachment.size >= 0
        ? attachment.size
        : undefined;
    candidates.push({
      id: stableSourceArtifactCandidateId(sourceRecordId, role, sourceKey),
      sourceRecordId,
      role,
      acquisitionReference: official,
      mediaType: artifactMediaType(
        firstString(attachment.extension, attachment.name, address) ?? address,
      ),
      selectionEvidence: {
        ...(name === undefined ? {} : { suggestedFilename: name }),
        ...(size === undefined ? {} : { declaredByteLength: size }),
        sourceOrdinal: ordinal,
      },
    });
  };
  if (Array.isArray(body.blocks)) {
    for (const block of body.blocks) {
      if (block === null || typeof block !== "object") continue;
      const value = block as Record<string, unknown>;
      const fileId = optionalString(value.fileId);
      const imageId = optionalString(value.imageId);
      if (fileId !== undefined) {
        const file = fileMap[fileId];
        if (file !== undefined) add(file, "file", fileId);
        continue;
      }
      if (imageId !== undefined) {
        const image = imageMap[imageId];
        if (image !== undefined) add(image, "image", imageId);
      }
    }
  } else {
    for (const [index, value] of recordArray(body.files).entries())
      add(value, "file", optionalString(value.id) ?? `file:${index}`);
    for (const [index, value] of recordArray(body.images).entries())
      add(value, "image", optionalString(value.id) ?? `image:${index}`);
  }
  return candidates;
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

function fanboxSummaryPosts(
  body: Record<string, unknown>,
  creatorId: string,
): readonly FanboxPost[] {
  if (!Array.isArray(body.posts))
    throw new Error("FANBOX creator summaries did not contain a posts array");
  if (body.posts.length > maximumCreatorSummaryPosts)
    throw new Error("FANBOX creator summaries exceeded the requested limit");
  return body.posts.map((item, index) => {
    if (!isRecord(item))
      throw new Error(`FANBOX creator summary item ${index} was not an object`);
    const actualCreatorId = requiredString(item.creatorId, "summary creator");
    if (actualCreatorId !== creatorId)
      throw new FanboxCollectionFault(
        "FANBOX summary post creator differs from its scope",
        "source-identity-conflict",
      );
    requiredString(item.id, "summary post identity");
    requiredNonBlankString(item.title, "summary post title");
    publicationDateOf(
      requiredString(item.publishedDatetime, "summary publication datetime"),
    );
    return item;
  });
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

function fanboxSuccessfulEnvelope(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !Object.hasOwn(value, "body"))
    throw new Error("FANBOX response did not contain an envelope body");
  if (Object.hasOwn(value, "error") || Object.hasOwn(value, "errors")) {
    throw new Error("FANBOX response declared an error");
  }
  if (!isRecord(value.body))
    throw new Error("FANBOX response body was not an object");
  return value.body;
}

function fanboxDetailPost(body: Record<string, unknown>): FanboxPost {
  if (!isRecord(body.post))
    throw new Error("FANBOX post detail did not contain a post object");
  return body.post;
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

function requiredArticleParagraphText(block: Record<string, unknown>): string {
  if (!Object.hasOwn(block, "text") || typeof block.text !== "string")
    throw new Error("FANBOX article p block detail body text was invalid");
  if (block.text.length > 0 && block.text.trim().length === 0)
    throw new Error("FANBOX article p block detail body text was invalid");
  return block.text;
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
        requiredArticleParagraphText(block);
        hasContent = true;
        break;
      case "header":
        requireBodyText(block, "article header block");
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
  for (const field of ["name", "fileName"] as const) {
    if (Object.hasOwn(value, field))
      requiredNonBlankString(value[field], `${form} attachment ${field}`);
  }
  if (
    Object.hasOwn(value, "size") &&
    (typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0)
  )
    throw new Error(`FANBOX ${form} attachment size was invalid`);
  const address = firstNonBlankString(
    value.url,
    value.originalUrl,
    value.downloadUrl,
  );
  if (address === undefined)
    throw new Error(`FANBOX ${form} attachment address was unavailable`);
  officialArtifactAddress(address);
}

function summaryCompleteness(postCount: number): "complete" | "incomplete" {
  return postCount < maximumCreatorSummaryPosts ? "complete" : "incomplete";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonMediaType(value: string | null): value is string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
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
  qualifiers?: readonly { readonly key: string; readonly value: string }[],
) {
  return {
    property,
    sourceSlot,
    value,
    sourceRecordIds: [sourceRecordId],
    ...(qualifiers === undefined ? {} : { qualifiers }),
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

function stableSourceArtifactCandidateId(
  sourceRecordId: string,
  role: string,
  sourceKey: string,
): string {
  return `source-artifact-candidate_${createHash("sha256")
    .update(`${sourceRecordId}\u0000${role}\u0000${sourceKey}`)
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
