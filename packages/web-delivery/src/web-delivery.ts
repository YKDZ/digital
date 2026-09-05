import {
  type CurrentAttentionPageRequest,
  type CurrentCataloguePageRequest,
  ExecutionHost,
  type SourceConnectionInspection,
  type WorkflowHistoryPageRequest,
} from "@digital/application";
import {
  type AssetViewFacts,
  type AssetViewModel,
  type BangumiSeriesViewModel,
  type InformationRequirement,
  generalAssetViewInformationRequirement,
  informationRequirementForAssetView,
  projectAssetView,
  projectCatalogue,
  libraryIndexMetadataProperties,
} from "@digital/presentation";
import type {
  ProductApplication,
  ProductAssetRefresh,
  ProductWorkflowOperations,
} from "@digital/product-application";
import {
  ArtifactByteAccessError,
  ObservedRevisionConfirmationError,
  type ByteReadCancellation,
  type ConsumerPlaybackCapabilities,
  type PlaybackPreferences,
} from "@digital/product-application";
import type { Hono } from "hono";

import { createApi } from "./api.ts";
import type {
  AttentionViewModel,
  AutomationViewModel,
  CatalogueSurfaceResponse,
  CatalogueSnapshot,
  ExecutionViewModel,
  ObservedRootViewModel,
} from "./catalogue.ts";

export type BangumiAuthorizationStart = ReturnType<
  ProductAssetRefresh["sourceConnections"]["bangumi"]["beginAuthorization"]
>;

/** Web delivery 的完整进程接口；可执行根只需把已组合的产品应用交给它。 */
export type WebDelivery = {
  readonly api: Hono;
  readonly startCatalogueAutomation: () => Promise<void>;
  readonly catalogueReady: () => boolean;
  readonly catalogueReadinessFailure: () => string | undefined;
};

/**
 * 将已组合的产品操作绑定到 Web delivery。这里不选择适配器，也不拥有组合资源。
 */
export function createWebDelivery(
  application: ProductApplication,
): WebDelivery {
  application.setAutomationInformationRequirementForAcceptedSubject(
    informationRequirementForAutomatedAcceptedSubject,
  );
  productApplication = application;
  const catalogueAutomation = createCatalogueAutomation(application);
  activeCatalogueAutomation = catalogueAutomation;
  return {
    api: createApi(),
    startCatalogueAutomation: catalogueAutomation.start,
    catalogueReady: catalogueAutomation.ready,
    catalogueReadinessFailure: catalogueAutomation.failure,
  };
}

let productApplication: ProductApplication | undefined;
let activeCatalogueAutomation: CatalogueAutomation | undefined;

type CatalogueAutomation = {
  readonly start: () => Promise<void>;
  readonly ready: () => boolean;
  readonly failure: () => string | undefined;
};

function createCatalogueAutomation(
  application: ProductApplication,
): CatalogueAutomation {
  let automationStart: Promise<void> | undefined;
  let startupFailure: string | undefined;
  return {
    async start(): Promise<void> {
      if (!application.configured) return;
      automationStart ??= application
        .startAutomation({
          onError(error) {
            console.error("自动刷新检查未完成", error);
          },
        })
        .catch((error: unknown) => {
          startupFailure = describeStartupFailure(error);
          automationStart = undefined;
          throw error;
        });
      await automationStart;
    },
    ready(): boolean {
      return (
        automationStart !== undefined &&
        application.automation.recoveryReady === true
      );
    },
    failure(): string | undefined {
      if (startupFailure !== undefined) return startupFailure;
      if (!application.configured)
        return "尚未配置产品数据目录；设置 DIGITAL_PRODUCT_DATA 后运行 digital-db-migrate prepare-only";
      return undefined;
    },
  };
}

function configuredProductApplication(): ProductApplication {
  if (productApplication === undefined)
    throw new Error("Web 交付尚未注入产品应用");
  return productApplication;
}

function application() {
  return configuredProductApplication().workflow;
}

/**
 * Source Connection 操作停留在 delivery 边界。Composition 持有能力专属私有授权；
 * 这个面向 HTTP 的用例只返回安全的运行投影。
 */
export function beginBangumiAuthorization(): BangumiAuthorizationStart {
  return application().sourceConnections.bangumi.beginAuthorization();
}

export async function completeBangumiAuthorizationCallback(
  callbackUrl: string,
): Promise<SourceConnectionInspection> {
  return await application().sourceConnections.bangumi.completeAuthorizationCallback(
    callbackUrl,
  );
}

export function revokeBangumiAuthorization(
  expectedVersion: number,
): SourceConnectionInspection {
  return application().sourceConnections.bangumi.revoke(expectedVersion);
}

function executions() {
  return configuredProductApplication().execution;
}

/** 启动且仅启动一个进程内 host；导出它以便 delivery 测试等待。 */
export async function startCatalogueAutomation(): Promise<void> {
  await configuredCatalogueAutomation().start();
}

/** delivery 安全的运行状态；它不会自行打开 catalogue。 */
export function catalogueReady(): boolean {
  return configuredCatalogueAutomation().ready();
}

/** 启动准入失败的脱敏 delivery 投影。 */
export function catalogueReadinessFailure(): string | undefined {
  return (
    activeCatalogueAutomation?.failure() ??
    "尚未配置产品数据目录；设置 DIGITAL_PRODUCT_DATA 后运行 digital-db-migrate prepare-only"
  );
}

function configuredCatalogueAutomation(): CatalogueAutomation {
  if (activeCatalogueAutomation === undefined)
    throw new Error("Web 交付尚未注入产品应用");
  return activeCatalogueAutomation;
}

function describeStartupFailure(error: unknown): string {
  if (!(error instanceof Error)) return "内容目录启动失败；检查部署诊断后重试";
  // Catalogue 就绪失败刻意包含运维动作，但不包含私有路径、连接 secret、SQLite
  // 堆栈或来源响应。
  return error.message.replaceAll(/\/[^\s]+/gu, "[路径已隐藏]");
}

function managedArtifactDigest(address: string): string | undefined {
  return configuredProductApplication().managedArtifactReference(address)
    ?.digest;
}

function isPrivateFilesystemAddress(address: string): boolean {
  if (address.startsWith("/api/") || address.startsWith("/covers/")) {
    return false;
  }
  if (address.startsWith("file:")) return true;
  return /^(?:[a-zA-Z]:[\\/]|\/)/u.test(address);
}

export function deliveryAssetView(view: AssetViewModel): AssetViewModel {
  const delivered = withDeliveryCover(view);
  return {
    ...delivered,
    ...(delivered.fanbox === undefined
      ? {}
      : {
          fanbox: withDeliveryCover(delivered.fanbox),
        }),
    ...(delivered.dlsite === undefined
      ? {}
      : {
          dlsite: withDeliveryCover(delivered.dlsite),
        }),
    ...(delivered.book === undefined
      ? {}
      : {
          book: withDeliveryCover(delivered.book),
        }),
    ...(delivered.film === undefined
      ? {}
      : {
          film: withDeliveryCover(delivered.film),
        }),
  };
}

function withDeliveryCover<T extends { readonly cover?: string }>(value: T): T {
  const cover = deliveryCover(value.cover);
  if (cover !== undefined) return { ...value, cover };
  if (value.cover === undefined) return value;
  const { cover: _cover, ...withoutCover } = value;
  return withoutCover as T;
}

function deliveryCover(cover: string | undefined): string | undefined {
  if (cover === undefined) return undefined;
  const digest = managedArtifactDigest(cover);
  if (digest !== undefined) return `/api/artifacts/${digest}`;
  if (!isPrivateFilesystemAddress(cover)) return cover;
  return undefined;
}

function mediaTypeForBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  )
    return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return "application/octet-stream";
}

export async function managedArtifactResponse(
  digest: string,
): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("未找到文件");
  const bytes =
    await configuredProductApplication().readManagedArtifact(digest);
  return { bytes, mediaType: mediaTypeForBytes(bytes) };
}

const artifactDownloadChunkBytes = 64 * 1024;

function artifactRevisionSelection(value: string) {
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  )
    throw new Error("产物修订版身份无效");
  return { artifactRevisionId: value };
}

function playbackRevisionSelection(value: string) {
  if (!/^artifact-revision_[A-Za-z0-9][A-Za-z0-9._~-]{0,220}$/u.test(value))
    throw new Error("产物修订版身份无效");
  return artifactRevisionSelection(value);
}

function attachmentDisposition(filename: string): string {
  const fallback =
    filename
      .replaceAll(/[^\u0020-\u007e]|["\\/]/gu, "_")
      .trim()
      .slice(0, 150) || "artifact";
  const extended = encodeURIComponent(filename).replaceAll(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

function requestCancellation(signal: AbortSignal): ByteReadCancellation {
  return {
    get cancelled() {
      return signal.aborted;
    },
    onCancel(listener) {
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
      return () => signal.removeEventListener("abort", listener);
    },
  };
}

/** 把 Product Application 的有界租约映射为附件 body；这里从不接收或解析服务器路径。 */
export async function artifactDownloadResponse(
  revisionId: string,
  request: Request,
): Promise<Response> {
  const selection = artifactRevisionSelection(revisionId);
  const descriptor =
    await configuredProductApplication().prepareArtifactDownload(selection);
  return await artifactByteResponse(selection, descriptor, request, true);
}

async function artifactByteResponse(
  selection: { readonly artifactRevisionId: string },
  descriptor: Awaited<
    ReturnType<ProductApplication["prepareArtifactDownload"]>
  >,
  request: Request,
  attachment: boolean,
): Promise<Response> {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-length": String(descriptor.byteLength),
    "content-type": descriptor.mediaType,
    etag: `"sha256:${descriptor.blobDigest}"`,
  });
  if (attachment)
    headers.set(
      "content-disposition",
      attachmentDisposition(descriptor.suggestedFilename),
    );
  const etag = headers.get("etag")!;
  const ifMatch = request.headers.get("if-match");
  if (ifMatch !== null) {
    const tags = parseEntityTagList(ifMatch);
    if (tags === undefined) return jsonRequestError("条件请求格式无效", 400);
    if (
      tags !== "*" &&
      !tags.some((tag) => !tag.weak && entityTagText(tag) === etag)
    ) {
      headers.delete("content-length");
      return new Response(null, { status: 412, headers });
    }
  }
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    const tags = parseEntityTagList(ifNoneMatch);
    if (tags === undefined) return jsonRequestError("条件请求格式无效", 400);
    if (tags === "*" || tags.some((tag) => entityTagText(tag) === etag))
      return new Response(null, { status: 304, headers });
  }
  let interval =
    descriptor.byteLength === 0
      ? undefined
      : { startInclusive: 0, endInclusive: descriptor.byteLength - 1 };
  let status = 200;
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  if (
    range !== null &&
    (ifRange === null || (!ifRange.startsWith("W/") && ifRange === etag))
  ) {
    const parsed = parseSingleByteRange(range, descriptor.byteLength);
    if (parsed.status === "malformed")
      return jsonRequestError("字节范围格式无效", 400);
    if (parsed.status === "unsatisfied") {
      headers.set("content-range", `bytes */${descriptor.byteLength}`);
      headers.delete("content-length");
      return new Response(null, { status: 416, headers });
    }
    if (parsed.status === "partial") {
      interval = parsed.interval;
      status = 206;
      headers.set(
        "content-range",
        `bytes ${interval.startInclusive}-${interval.endInclusive}/${descriptor.byteLength}`,
      );
      headers.set(
        "content-length",
        String(interval.endInclusive - interval.startInclusive + 1),
      );
    }
  }
  if (interval === undefined) return new Response(null, { status, headers });
  const lease = await configuredProductApplication().openArtifactBytes({
    selection,
    expectedBlobDigest: descriptor.blobDigest,
    interval,
  });
  const cancellation = requestCancellation(request.signal);
  let settled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled) return;
      try {
        const next = await lease.read({
          maximumBytes: artifactDownloadChunkBytes,
          cancellation,
        });
        if (next.bytes.byteLength > 0) controller.enqueue(next.bytes);
        if (next.done) {
          settled = true;
          await lease.close("completed");
          controller.close();
        }
      } catch (error) {
        settled = true;
        try {
          await lease.close(
            cancellation.cancelled ? "client-cancelled" : "failed",
          );
        } catch {
          // body 的主读取错误保持可见，资源清理失败不能把它改写为另一响应。
        }
        controller.error(error);
      }
    },
    async cancel() {
      if (settled) return;
      settled = true;
      await lease.close("client-cancelled");
    },
  });
  return new Response(body, { status, headers });
}

export async function playbackPlanResponse(
  revisionId: string,
  value: unknown,
): Promise<
  | { readonly status: "incompatible"; readonly reason: string }
  | {
      readonly status: "ready";
      readonly revisionId: string;
      readonly blobDigest: string;
      readonly rendition: {
        readonly kind: "direct";
        readonly mediaType: string;
        readonly codecs: readonly string[];
        readonly byteLength: number;
      };
      readonly mediaUrl: string;
    }
> {
  const selection = playbackRevisionSelection(revisionId);
  const input = playbackPlanInput(value);
  const result = await configuredProductApplication().planPlayback(
    selection,
    input.consumer,
    input.preferences,
  );
  if (result.status === "incompatible") return result;
  return {
    ...result,
    mediaUrl: `/api/playback-media/${encodeURIComponent(result.revisionId)}/${result.blobDigest}`,
  };
}

export async function playbackMediaResponse(
  revisionId: string,
  blobDigest: string,
  request: Request,
): Promise<Response> {
  if (!/^[a-f0-9]{64}$/u.test(blobDigest))
    throw new ArtifactByteAccessError("artifact-integrity-failed");
  const selection = playbackRevisionSelection(revisionId);
  const descriptor =
    await configuredProductApplication().prepareArtifactDownload(selection);
  if (descriptor.blobDigest !== blobDigest)
    throw new ArtifactByteAccessError("artifact-integrity-failed");
  return await artifactByteResponse(selection, descriptor, request, false);
}

function playbackPlanInput(value: unknown): {
  readonly consumer: ConsumerPlaybackCapabilities;
  readonly preferences: PlaybackPreferences;
} {
  const object = strictObject(value, ["consumer", "preferences"]);
  const consumerObject = strictObject(object.consumer, [
    "contractVersion",
    "supportsByteRanges",
    "media",
  ]);
  if (
    consumerObject.contractVersion !== "consumer-playback/1" ||
    typeof consumerObject.supportsByteRanges !== "boolean" ||
    !Array.isArray(consumerObject.media) ||
    consumerObject.media.length > 128
  )
    throw new Error("消费者播放能力无效");
  const media = consumerObject.media.map((candidate) => {
    const entry = strictObject(candidate, ["mediaType", "codecs"], ["codecs"]);
    if (
      typeof entry.mediaType !== "string" ||
      !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(entry.mediaType.trim()) ||
      (entry.codecs !== undefined &&
        (!Array.isArray(entry.codecs) ||
          entry.codecs.length > 32 ||
          !entry.codecs.every(
            (codec) =>
              typeof codec === "string" &&
              codec.trim().length > 0 &&
              codec.length <= 127,
          )))
    )
      throw new Error("消费者播放能力无效");
    return {
      mediaType: entry.mediaType,
      ...(entry.codecs === undefined
        ? {}
        : { codecs: entry.codecs as string[] }),
    };
  });
  const preferencesObject = strictObject(
    object.preferences,
    ["audioTrackId", "subtitleTrackId", "quality"],
    ["audioTrackId", "subtitleTrackId", "quality"],
  );
  const optionalText = (candidate: unknown) =>
    candidate === undefined ||
    (typeof candidate === "string" &&
      candidate.trim().length > 0 &&
      candidate.length <= 256);
  if (
    !optionalText(preferencesObject.audioTrackId) ||
    !optionalText(preferencesObject.subtitleTrackId) ||
    (preferencesObject.quality !== undefined &&
      preferencesObject.quality !== "source")
  )
    throw new Error("播放偏好无效");
  return {
    consumer: {
      contractVersion: "consumer-playback/1",
      supportsByteRanges: consumerObject.supportsByteRanges,
      media,
    },
    preferences: {
      ...(preferencesObject.audioTrackId === undefined
        ? {}
        : { audioTrackId: preferencesObject.audioTrackId as string }),
      ...(preferencesObject.subtitleTrackId === undefined
        ? {}
        : { subtitleTrackId: preferencesObject.subtitleTrackId as string }),
      ...(preferencesObject.quality === undefined
        ? {}
        : { quality: "source" as const }),
    },
  };
}

function strictObject(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("播放计划输入无效");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !keys.includes(key)) ||
    keys.some((key) => !optional.includes(key) && !(key in object))
  )
    throw new Error("播放计划输入无效");
  return object;
}

export async function confirmedObservedArtifactDownloadResponse(
  observedFileSelectionId: string,
  request: Request,
): Promise<Response> {
  if (
    !/^observed-file-selection_1_[a-f0-9]{64}$/u.test(observedFileSelectionId)
  )
    return jsonRequestError("观察文件选择已失效", 400);
  const confirmed =
    await configuredProductApplication().confirmObservedFileRevision({
      observedFileSelectionId,
    });
  return await artifactDownloadResponse(confirmed.artifactRevisionId, request);
}

export function artifactDeliveryErrorResponse(error: unknown): Response {
  if (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      ["播放计划输入无效", "消费者播放能力无效", "播放偏好无效"].includes(
        error.message,
      ))
  )
    return Response.json({ error: "播放计划输入无效" }, { status: 400 });
  if (error instanceof Error && error.message === "产物修订版身份无效")
    return Response.json({ error: error.message }, { status: 400 });
  if (error instanceof ArtifactByteAccessError) {
    const status =
      error.code === "artifact-revision-not-found"
        ? 404
        : error.code === "application-shutting-down"
          ? 503
          : 409;
    return Response.json({ error: error.code }, { status });
  }
  if (error instanceof ObservedRevisionConfirmationError) {
    return Response.json(
      { error: error.code },
      { status: error.code === "confirmation-commit-failed" ? 503 : 409 },
    );
  }
  return Response.json(
    { error: "artifact-bytes-unavailable" },
    { status: 409 },
  );
}

type ParsedEntityTag = {
  readonly weak: boolean;
  readonly opaque: string;
};

function parseEntityTagList(
  value: string,
): readonly ParsedEntityTag[] | "*" | undefined {
  let index = skipOws(value, 0);
  if (value[index] === "*")
    return skipOws(value, index + 1) === value.length ? "*" : undefined;
  const tags: ParsedEntityTag[] = [];
  while (index < value.length) {
    let weak = false;
    if (value.startsWith("W/", index)) {
      weak = true;
      index += 2;
    }
    if (value[index] !== '"') return undefined;
    index += 1;
    const start = index;
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index);
      if (
        !(
          code === 0x21 ||
          (code >= 0x23 && code <= 0x7e) ||
          (code >= 0x80 && code <= 0xff)
        )
      )
        return undefined;
      index += 1;
    }
    if (value[index] !== '"') return undefined;
    tags.push({ weak, opaque: value.slice(start, index) });
    index = skipOws(value, index + 1);
    if (index === value.length) return tags;
    if (value[index] !== ",") return undefined;
    index = skipOws(value, index + 1);
    if (index === value.length) return undefined;
  }
  return tags.length === 0 ? undefined : tags;
}

function entityTagText(tag: ParsedEntityTag): string {
  return `"${tag.opaque}"`;
}

function skipOws(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t") index += 1;
  return index;
}

function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/gu, "");
}

type ParsedRange =
  | { readonly status: "ignored" }
  | { readonly status: "malformed" }
  | { readonly status: "unsatisfied" }
  | {
      readonly status: "partial";
      readonly interval: {
        readonly startInclusive: number;
        readonly endInclusive: number;
      };
    };

function parseSingleByteRange(value: string, length: number): ParsedRange {
  const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=(.*)$/u.exec(value);
  if (match === null) return { status: "malformed" };
  if (match[1]!.toLowerCase() !== "bytes") return { status: "ignored" };
  const members = match[2]!.split(",").map(trimOws);
  if (members.length !== 1) {
    return members.every(validByteRangeMember)
      ? { status: "unsatisfied" }
      : { status: "malformed" };
  }
  const member = members[0]!;
  if (!validByteRangeSyntax(member)) return { status: "malformed" };
  if (length === 0) return { status: "unsatisfied" };
  const [first, last] = member.split("-") as [string, string];
  if (first.length === 0) {
    const suffix = boundedDecimal(last);
    if (suffix === undefined) return { status: "malformed" };
    if (suffix === 0) return { status: "unsatisfied" };
    return {
      status: "partial",
      interval: {
        startInclusive: Math.max(0, length - suffix),
        endInclusive: length - 1,
      },
    };
  }
  const start = boundedDecimal(first);
  if (start === undefined) return { status: "malformed" };
  if (start >= length) return { status: "unsatisfied" };
  if (last.length === 0)
    return {
      status: "partial",
      interval: { startInclusive: start, endInclusive: length - 1 },
    };
  const requestedEnd = boundedDecimal(last);
  if (requestedEnd === undefined || requestedEnd < start)
    return { status: "malformed" };
  return {
    status: "partial",
    interval: {
      startInclusive: start,
      endInclusive: Math.min(requestedEnd, length - 1),
    },
  };
}

function validByteRangeMember(value: string): boolean {
  if (!validByteRangeSyntax(value)) return false;
  const [first, last] = value.split("-") as [string, string];
  if (first.length === 0) return boundedDecimal(last) !== undefined;
  const start = boundedDecimal(first);
  if (start === undefined) return false;
  if (last.length === 0) return true;
  const end = boundedDecimal(last);
  return end !== undefined && end >= start;
}

function validByteRangeSyntax(value: string): boolean {
  return /^(?:[0-9]+-[0-9]*|-[0-9]+)$/u.test(value);
}

function boundedDecimal(value: string): number | undefined {
  try {
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

function jsonRequestError(message: string, status: 400): Response {
  return Response.json({ error: message }, { status });
}

type AcceptedPresentationSubject = NonNullable<
  NonNullable<Awaited<ReturnType<ProductAssetRefresh["inspect"]>>>["accepted"]
>;

/** 从已接受的 Application 投影到 Presentation facts 的 delivery 中立桥接。 */
function assetViewFactsForAccepted(
  accepted: AcceptedPresentationSubject,
): AssetViewFacts {
  return {
    id: accepted.entity.id,
    sourceAssociation: accepted.recognitionSourceAssociation,
    sourceAssociations: accepted.sourceAssociations,
    metadata: accepted.effectiveMetadata,
    sourceArtifactCandidates: accepted.sourceArtifactCandidates,
    entities: accepted.entities,
    relationships: accepted.relationships,
    artifactAssociations: accepted.artifactAssociations,
    locations: accepted.locations,
  };
}

/**
 * Automation 仅在 subject 被接受后运行这个由 delivery 持有的 dispatch。返回
 * Application 的值是中立 contract；任何 View 或来源专属输出模型都不能越过边界。
 */
export function informationRequirementForAutomatedAcceptedSubject(
  accepted: AcceptedPresentationSubject,
): InformationRequirement {
  return informationRequirementForAssetView(
    assetViewFactsForAccepted(accepted),
  );
}

/**
 * Presentation 根据当前中立 facts 选择 requirement。Delivery 不会按来源身份分支，
 * 也不会要求 Application 提供所有已交付 View 可选输入的全局并集。
 */
async function informationRequirementForSubject(
  subject: Pick<ProductAssetRefresh, "inspectCurrentCatalogueSubject">,
  subjectId: string,
  fallbackSourceAssociation?: AssetViewFacts["sourceAssociation"],
) {
  const accepted = await subject.inspectCurrentCatalogueSubject(subjectId);
  const facts =
    accepted === undefined ? undefined : assetViewFactsForAccepted(accepted);
  return informationRequirementForAssetView(
    facts ?? { sourceAssociation: fallbackSourceAssociation, metadata: [] },
  );
}

function deliveryBangumiView(
  view: BangumiSeriesViewModel,
): BangumiSeriesViewModel {
  const delivered = withDeliveryCover(view);
  return {
    ...delivered,
    works: delivered.works.map((work) => ({
      ...withDeliveryCover(work),
      episodes: work.episodes.map(withDeliveryArtwork),
    })),
    episodes: delivered.episodes.map(withDeliveryArtwork),
  };
}

function withDeliveryArtwork<T extends { readonly artwork?: string }>(
  value: T,
): T {
  const artwork = deliveryCover(value.artwork);
  if (artwork !== undefined) return { ...value, artwork };
  if (value.artwork === undefined) return value;
  const { artwork: _artwork, ...withoutArtwork } = value;
  return withoutArtwork as T;
}

export function projectCatalogueAssets(
  facts: readonly AssetViewFacts[],
): CatalogueSnapshot["assets"] {
  return projectCatalogue(facts).map((view) =>
    "works" in view ? deliveryBangumiView(view) : deliveryAssetView(view),
  );
}

function folderName(directory: string): string {
  return directory.split(/[\\/]/u).filter(Boolean).at(-1) || "已选择的文件夹";
}

function toAutomationView(intent: {
  readonly id: string;
  readonly scope: {
    readonly observedRootId: string;
    readonly relativeScope: string;
  };
  readonly enabled: boolean;
  readonly intervalMilliseconds: number;
  readonly acceptTrusted: boolean;
}): AutomationViewModel {
  return {
    id: intent.id,
    folder: `${intent.scope.observedRootId}:${intent.scope.relativeScope}`,
    observedRootId: intent.scope.observedRootId,
    relativeScope: intent.scope.relativeScope,
    enabled: intent.enabled,
    intervalMilliseconds: intent.intervalMilliseconds,
    acceptTrusted: intent.acceptTrusted,
  };
}

async function activeObservedRootViews(
  subject: ProductWorkflowOperations,
): Promise<readonly ObservedRootViewModel[]> {
  return (await subject.observedRootRegistrations.list())
    .filter((registration) => registration.status === "active")
    .map(({ id, displayName }) => ({ id, displayName }));
}

export function deliveryExecution(
  inspection: Awaited<ReturnType<ProductWorkflowOperations["inspect"]>>,
): ExecutionViewModel | undefined {
  if (!inspection) return undefined;
  return {
    id: inspection.execution.id,
    folder:
      inspection.execution.selection.directory === undefined
        ? "selection"
        : folderName(inspection.execution.selection.directory),
    intent: inspection.execution.selection.intent ?? "scan-now",
    status: inspection.execution.status,
    outcome: inspection.execution.outcome,
    reason: inspection.execution.reason,
    acceptedAssetId: inspection.execution.acceptedAssetId,
    dispositions: inspection.execution.dispositions.map((item) => ({
      key: item.key,
      status: item.status,
      reason: item.reason,
    })),
    ...(inspection.execution.targetDispositions === undefined
      ? {}
      : {
          targets: inspection.execution.targetDispositions.map((item) => ({
            key: item.key,
            label:
              item.target.kind === "subject"
                ? `内容 ${item.target.subjectId}`
                : `文件范围 ${folderName(item.target.root)}`,
            status: item.status,
            reason: item.reason,
            sourceRecordIds: item.sourceRecordIds,
            outputReferences: item.outputReferences,
          })),
        }),
    ...(inspection.itemResults === undefined
      ? {}
      : {
          items: inspection.itemResults.map((item) => ({
            key: item.key,
            relativePaths: item.relativePaths,
            outcome: item.outcome,
            reason: item.reason,
            recognition: item.recognition,
            acceptedAssetId: item.accepted?.entity.id,
            acceptedSource:
              item.accepted?.recognitionSourceAssociation?.nativeAddress,
          })),
        }),
    recognition: inspection.recognition,
    ...(inspection.changeImpactPreview === undefined
      ? {}
      : {
          preview: {
            id: inspection.changeImpactPreview.id,
            status: inspection.changeImpactPreview.status,
            blockingConditions:
              inspection.changeImpactPreview.blockingConditions,
            current: deliveryAssetView(
              projectAssetView({
                id: inspection.changeImpactPreview.assetId,
                ...inspection.changeImpactPreview.current,
              }),
            ),
            proposed: deliveryAssetView(
              projectAssetView({
                id: inspection.changeImpactPreview.assetId,
                ...inspection.changeImpactPreview.projected,
              }),
            ),
          },
        }),
  };
}

function deliveryAttention(input: {
  readonly id: string;
  readonly kind: AttentionViewModel["kind"];
  readonly executionId?: string;
  readonly assetId?: string;
  readonly summary: string;
  readonly recognitionProposalId?: string;
  readonly changeImpactPreviewId?: string;
  readonly sourceRefreshChangeSetId?: string;
  readonly automationIntentId?: string;
}): AttentionViewModel {
  return input;
}

export type CatalogueSnapshotRequest = {
  readonly currentCatalogue?: CurrentCataloguePageRequest;
  readonly workflowHistory?: WorkflowHistoryPageRequest;
  readonly currentAttention?: CurrentAttentionPageRequest;
};

type CatalogueSurfaceRequest =
  | {
      readonly surface: "current-catalogue";
      readonly page?: CurrentCataloguePageRequest;
    }
  | {
      readonly surface: "workflow-history";
      readonly page?: WorkflowHistoryPageRequest;
    }
  | {
      readonly surface: "current-attention";
      readonly page?: CurrentAttentionPageRequest;
    }
  | { readonly surface: "automation" };

function emptyCatalogueSnapshot(configured: boolean): CatalogueSnapshot {
  return {
    configured,
    assets: [],
    executions: [],
    attention: [],
    automation: [],
    observedRoots: [],
    pagination: {
      currentCatalogue: {},
      workflowHistory: {},
      currentAttention: {},
    },
  };
}

/** 只执行一个 delivery surface，不执行同级 Application 查询。 */
export async function catalogueSurface(
  input: CatalogueSurfaceRequest,
): Promise<CatalogueSurfaceResponse> {
  const configured = productApplication?.configured === true;
  if (!configured) {
    if (input.surface === "current-catalogue")
      return { surface: input.surface, configured, assets: [], pagination: {} };
    if (input.surface === "workflow-history")
      return {
        surface: input.surface,
        configured,
        executions: [],
        pagination: {},
      };
    if (input.surface === "current-attention")
      return {
        surface: input.surface,
        configured,
        attention: [],
        pagination: {},
      };
    return { surface: input.surface, configured, automation: [] };
  }
  const subject = application();
  if (input.surface === "current-catalogue") {
    const page = await subject.listCurrentCataloguePage(input.page);
    const facts = page.items.map(assetViewFactsForAccepted);
    await Promise.all(
      facts.map((fact) =>
        subject.fulfillInformation({
          selection: { subjectIds: [fact.id] },
          requirement: informationRequirementForAssetView(fact),
        }),
      ),
    );
    return {
      surface: input.surface,
      configured,
      assets: projectCatalogueAssets(facts),
      pagination:
        page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    };
  }
  if (input.surface === "workflow-history") {
    const page = await subject.listWorkflowHistoryPage(input.page);
    return {
      surface: input.surface,
      configured,
      executions: page.items
        .map(deliveryExecution)
        .filter((item): item is NonNullable<typeof item> => item !== undefined),
      pagination:
        page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    };
  }
  if (input.surface === "current-attention") {
    const page = await subject.listCurrentAttentionPage(input.page);
    return {
      surface: input.surface,
      configured,
      attention: page.items.map(deliveryAttention),
      pagination:
        page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    };
  }
  return {
    surface: input.surface,
    configured,
    automation: (await subject.listAutomationIntents()).map(toAutomationView),
  };
}

export async function catalogueSnapshot(
  input: CatalogueSnapshotRequest = {},
): Promise<CatalogueSnapshot> {
  if (productApplication?.configured !== true) {
    return emptyCatalogueSnapshot(false);
  }
  const subject = application();
  const [currentCatalogue, history, attention, automation, observedRoots] =
    await Promise.all([
      subject.listCurrentCataloguePage(input.currentCatalogue),
      subject.listWorkflowHistoryPage(input.workflowHistory),
      subject.listCurrentAttentionPage(input.currentAttention),
      subject.listAutomationIntents(),
      activeObservedRootViews(subject),
    ]);
  const facts = currentCatalogue.items.map(assetViewFactsForAccepted);
  await Promise.all(
    facts.map((fact) =>
      subject.fulfillInformation({
        selection: { subjectIds: [fact.id] },
        requirement: informationRequirementForAssetView(fact),
      }),
    ),
  );
  return {
    configured: true,
    assets: projectCatalogueAssets(facts),
    executions: history.items
      .map(deliveryExecution)
      .filter((item): item is NonNullable<typeof item> => item !== undefined),
    attention: attention.items.map(deliveryAttention),
    automation: automation.map(toAutomationView),
    observedRoots,
    pagination: {
      currentCatalogue:
        currentCatalogue.nextCursor === undefined
          ? {}
          : { nextCursor: currentCatalogue.nextCursor },
      workflowHistory:
        history.nextCursor === undefined
          ? {}
          : { nextCursor: history.nextCursor },
      currentAttention:
        attention.nextCursor === undefined
          ? {}
          : { nextCursor: attention.nextCursor },
    },
  };
}

export async function startRefresh(input: {
  readonly observedRootId?: string;
  readonly relativeScope?: string;
  readonly assetId?: string;
  readonly target?: { readonly subjectId: string };
  readonly operation?: "metadata-refresh" | "rescrape";
  readonly intent?: "scan-now" | "metadata-refresh";
  readonly rescrape?: boolean;
  readonly directedSourceAddress?: string;
  readonly directedSourceIdentity?: string;
}): Promise<{ readonly id: string }> {
  return await startRefreshWith(application(), input, executions());
}

export async function createObservedRoot(input: {
  readonly displayName: string;
  readonly containerPath: string;
  readonly symlinkMode:
    | "do-not-follow"
    | "follow-file-links"
    | "follow-file-and-directory-links";
}) {
  return await application().observedRootRegistrations.create({
    ...input,
    readOnly: true,
    allowedTargetRootIds: [],
  });
}

export async function startRefreshWith(
  subject: ProductWorkflowOperations,
  input: Parameters<typeof startRefresh>[0],
  host: Pick<ExecutionHost, "invoke">,
): Promise<{ readonly id: string }> {
  const subjectId = input.target?.subjectId ?? input.assetId;
  if (
    input.target !== undefined &&
    input.assetId !== undefined &&
    input.target.subjectId !== input.assetId
  )
    throw new Error("刷新请求包含冲突的主体标识");
  if (
    (input.operation === "metadata-refresh" ||
      input.intent === "metadata-refresh") &&
    subjectId !== undefined
  ) {
    return await startAssetMetadataRefresh(
      subject,
      subjectId,
      host,
      await informationRequirementForSubject(subject, subjectId),
    );
  }
  if (
    (input.operation === "rescrape" || input.rescrape === true) &&
    subjectId !== undefined
  ) {
    if (
      input.observedRootId !== undefined ||
      input.directedSourceAddress !== undefined ||
      input.directedSourceIdentity !== undefined
    )
      throw new Error("重新刮削的当前范围与来源关联必须由服务端解析");
    return await startAssetRescrapeForSubject(subject, subjectId, host);
  }
  if (input.observedRootId === undefined)
    throw new Error("扫描必须选择已登记的文件位置");
  const observedRootId = input.observedRootId;
  if (
    input.rescrape ||
    input.operation !== undefined ||
    input.intent === "metadata-refresh"
  )
    throw new Error("该操作需要精确内容标识");
  return await host.invoke(async (control) => {
    await subject.scanObservedScope({
      registrationId: observedRootId,
      relativeScope: input.relativeScope ?? ".",
      acceptTrusted: true,
      // scan 被接受前不存在专门 View；General Asset View 持有这个有界初始需求。
      informationRequirement: generalAssetViewInformationRequirement,
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function startAssetRescrapeForSubject(
  subject: Pick<
    ProductWorkflowOperations,
    | "inspectCurrentCatalogueSubject"
    | "inspectRefreshTarget"
    | "rescrapeObservedScope"
  >,
  subjectId: string,
  host: Pick<ExecutionHost, "invoke">,
): Promise<{ readonly id: string }> {
  const target = await subject.inspectRefreshTarget(subjectId);
  if (target === undefined) throw new Error("未找到可重新刮削的当前内容");
  const recognitionSourceAssociation = target.recognitionSourceAssociation;
  if (recognitionSourceAssociation === undefined)
    throw new Error("当前内容没有可重新刮削的识别来源");
  return await startAssetRescrape(
    subject,
    {
      assetId: target.subjectId,
      observedRootId: target.filesystemScope.observedRootId,
      relativeScope: target.filesystemScope.relativeScope,
      sourceIdentity: recognitionSourceAssociation.sourceIdentity,
      sourceAddress: recognitionSourceAssociation.nativeAddress,
    },
    host,
    await informationRequirementForSubject(
      subject,
      subjectId,
      recognitionSourceAssociation,
    ),
  );
}

export async function startAssetRescrape(
  subject: Pick<ReturnType<typeof application>, "rescrapeObservedScope">,
  input: {
    readonly assetId: string;
    readonly observedRootId: string;
    readonly relativeScope: string;
    readonly sourceAddress: string;
    readonly sourceIdentity: string;
  },
  host: Pick<ExecutionHost, "invoke">,
  informationRequirement: InformationRequirement = informationRequirementForAssetView(
    {
      sourceAssociation: {
        sourceIdentity: input.sourceIdentity,
        nativeAddress: input.sourceAddress,
      },
      metadata: [],
    },
  ),
): Promise<{ readonly id: string }> {
  return await host.invoke(async (control) => {
    await subject.rescrapeObservedScope({
      subjectId: input.assetId,
      registrationId: input.observedRootId,
      relativeScope: input.relativeScope,
      sourceAddress: input.sourceAddress,
      sourceIdentity: input.sourceIdentity,
      informationRequirement,
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function startAssetMetadataRefresh(
  subject: Pick<ReturnType<typeof application>, "refreshMetadata">,
  assetId: string,
  host: Pick<ExecutionHost, "invoke">,
  informationRequirement: InformationRequirement = generalAssetViewInformationRequirement,
): Promise<{ readonly id: string }> {
  return await host.invoke(async (control) => {
    await subject.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: assetId,
            explanations: [{ path: ["asset-detail", assetId] }],
          },
        ],
        filesystemScopes: [],
      },
      informationRequirement,
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function updateAutomation(input: {
  readonly action: "enable" | "disable" | "scan-now";
  readonly intentId?: string;
  readonly observedRootId?: string;
  readonly relativeScope?: string;
  readonly intervalMilliseconds?: number;
  readonly acceptTrusted?: boolean;
}): Promise<
  | {
      readonly intent: AutomationViewModel;
      readonly initialStatus?: string;
      readonly initialExecution?: { readonly id: string };
    }
  | { readonly status: "disabled" }
  | {
      readonly status: "started" | "skipped" | "disabled";
      readonly execution?: { readonly id: string };
      readonly reason?: string;
    }
> {
  const subject = application();
  if (input.action === "enable") {
    if (!input.observedRootId || !input.intervalMilliseconds)
      throw new Error("请填写刷新范围和间隔");
    const observedRootId = input.observedRootId;
    const intervalMilliseconds = input.intervalMilliseconds;
    let announceIntent!: (
      intent: Awaited<ReturnType<typeof subject.enableAutomation>>["intent"],
    ) => void;
    const intentCreated = new Promise<
      Awaited<ReturnType<typeof subject.enableAutomation>>["intent"]
    >((resolve) => {
      announceIntent = resolve;
    });
    const initialExecution = executions().invoke(async (control) => {
      await subject.enableAutomation({
        observedRootId,
        relativeScope: input.relativeScope ?? ".",
        intervalMilliseconds,
        acceptTrusted: input.acceptTrusted ?? true,
        onIntentCreated: announceIntent,
        onInitialExecutionStarted(execution) {
          control.executionStarted(execution.id);
        },
        onInitialCheckpoint() {
          control.safeCheckpoint();
        },
      });
    });
    const [intent, execution] = await Promise.all([
      intentCreated,
      initialExecution,
    ]);
    return {
      intent: toAutomationView(intent),
      initialStatus: "started",
      initialExecution: execution,
    };
  }
  if (!input.intentId) throw new Error("未找到自动刷新设置");
  if (input.action === "disable") {
    await subject.disableAutomation(input.intentId);
    return { status: "disabled" };
  }
  return await startAutomationNowWith(subject, executions(), input.intentId);
}

export async function startAutomationNowWith(
  subject: Pick<ReturnType<typeof application>, "triggerAutomation">,
  host: Pick<ExecutionHost, "invoke">,
  intentId: string,
): Promise<
  | {
      readonly status: "started";
      readonly execution: { readonly id: string };
    }
  | { readonly status: "skipped" | "disabled"; readonly reason: string }
> {
  let completed: ReturnType<typeof subject.triggerAutomation> | undefined;
  const accepted = host.invoke((control) => {
    completed = subject.triggerAutomation(intentId, "scan-now", new Date(), {
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onCheckpoint() {
        control.safeCheckpoint();
      },
    });
    return completed.then(() => undefined);
  });
  try {
    const execution = await accepted;
    return { status: "started", execution };
  } catch (error) {
    if (completed === undefined) throw error;
    const disposition = await completed;
    if (disposition.status !== "started") return disposition;
    throw error;
  }
}

export async function updatePreview(input: {
  readonly action: "apply" | "reject";
  readonly previewId: string;
}): Promise<{
  readonly status: "awaiting-confirmation" | "rejected" | "applied" | "stale";
}> {
  const preview =
    input.action === "apply"
      ? await application().applyChangeImpactPreview(input.previewId)
      : await application().rejectChangeImpactPreview(input.previewId);
  return { status: preview.status };
}

import type { CatalogueSubjectResponse } from "./catalogue.ts";
import { libraryItems } from "./library-query.ts";
/** 详情按稳定主体读取，不依赖首页恰好加载了哪一页。 */
export async function catalogueSubject(
  id: string,
): Promise<CatalogueSubjectResponse | undefined> {
  if (productApplication?.configured !== true) return undefined;
  const items = libraryItems(
    await application().listCurrentCatalogueIndex(
      libraryIndexMetadataProperties,
    ),
  );
  const item = items.find(
    (entry) => entry.view.id === id || entry.subjectIds.includes(id),
  );
  if (item === undefined) return undefined;
  const assets = await catalogueViewsForSubjects(item.subjectIds);
  const asset = assets.find((view) => view.id === item.view.id);
  if (asset === undefined) return undefined;
  return {
    asset,
    ...("works" in asset && asset.id !== id ? { selectedEpisodeId: id } : {}),
  };
}

async function catalogueViewsForSubjects(subjectIds: readonly string[]) {
  const facts: AssetViewFacts[] = [];
  for (let offset = 0; offset < subjectIds.length; offset += 100) {
    const batch = subjectIds.slice(offset, offset + 100);
    const page = await application().listCurrentCataloguePage({
      limit: batch.length,
      subjectIds: batch,
    });
    facts.push(...page.items.map(assetViewFactsForAccepted));
  }
  return projectCatalogueAssets(facts);
}
