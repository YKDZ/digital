import {
  ArtifactByteAccessError,
  ObservedRevisionConfirmationError,
  type ConsumerPlaybackCapabilities,
  type PlaybackPreferences,
  type ProductApplication,
} from "@digital/product-application";
import {
  confirmedObservedMaterialSchema,
  playbackInteractionListSchema,
  playbackPlanRequestSchema,
  playbackInteractionSavedSchema,
  publicPlaybackPlanSchema,
  savePlaybackInteractionRequestSchema,
} from "@digital/public-api";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

const artifactDownloadChunkBytes = 64 * 1024;

/** 媒体与播放状态使用公共产品契约；资源租约始终留在服务进程内。 */
export function createMediaHttpApi(application: ProductApplication): Hono {
  const api = new Hono();

  api.get("/media/managed-artifacts/:digest", async (context) => {
    const digest = context.req.param("digest");
    if (!/^[a-f0-9]{64}$/u.test(digest))
      return mediaError(context, "not-found", "未找到封面", 404);
    try {
      const bytes = await application.readManagedArtifact(digest);
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      return new Response(body, {
        headers: {
          "content-type": mediaTypeForBytes(bytes),
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    } catch (error) {
      return mediaDeliveryError(context, error);
    }
  });

  api.post(
    "/media/observed-materials/:subjectId/:locationId/confirm",
    async (context) => {
      const assetLibraryId = context.req.query("assetLibraryId");
      try {
        const selection = await observedMaterialSelection(
          application,
          context.req.param("subjectId"),
          context.req.param("locationId"),
          assetLibraryId,
        );
        if (selection === undefined)
          return mediaError(context, "not-found", "观察材料当前不可用", 404);
        const revisionId =
          selection.kind === "revision"
            ? selection.revisionId
            : (
                await application.confirmObservedFileRevision({
                  observedFileSelectionId: selection.selectionId,
                  ...(assetLibraryId === undefined ? {} : { assetLibraryId }),
                })
              ).artifactRevisionId;
        const revision = artifactRevisionSelection(revisionId, assetLibraryId);
        const descriptor = await application.prepareArtifactDownload(revision);
        const result = safeParse(confirmedObservedMaterialSchema, {
          artifactRevisionId: descriptor.revisionId,
          blobDigest: descriptor.blobDigest,
          byteLength: descriptor.byteLength,
          mediaType: descriptor.mediaType,
        });
        if (!result.success) throw new Error("观察材料确认结果无效");
        return context.json(result.output);
      } catch (error) {
        return mediaDeliveryError(context, error);
      }
    },
  );

  api.get(
    "/media/observed-materials/:subjectId/:locationId",
    async (context) => {
      const assetLibraryId = context.req.query("assetLibraryId");
      try {
        const selection = await observedMaterialSelection(
          application,
          context.req.param("subjectId"),
          context.req.param("locationId"),
          assetLibraryId,
        );
        if (selection === undefined)
          return mediaError(context, "not-found", "观察材料当前不可用", 404);
        return await readObservedSelection(
          application,
          selection,
          context.req.raw,
          assetLibraryId,
        );
      } catch (error) {
        return mediaDeliveryError(context, error);
      }
    },
  );

  api.get("/media/observed-artwork/:subjectId/:locationId", async (context) => {
    const assetLibraryId = context.req.query("assetLibraryId");
    try {
      const facts = await application.workflow.inspectCurrentCatalogueSubject(
        context.req.param("subjectId"),
        undefined,
        assetLibraryId,
      );
      const selected = facts?.descriptions.some((description) =>
        description.artifactRoles.some(
          (role) =>
            role.locationId === context.req.param("locationId") &&
            ["asset.primary-cover", "asset.material-image"].includes(role.role),
        ),
      );
      if (!selected)
        return mediaError(context, "not-found", "此图片当前不可用", 404);
      const selection = await observedMaterialSelection(
        application,
        context.req.param("subjectId"),
        context.req.param("locationId"),
        assetLibraryId,
      );
      if (selection === undefined)
        return mediaError(context, "not-found", "此图片当前不可用", 404);
      const response = await readObservedSelection(
        application,
        selection,
        context.req.raw,
        assetLibraryId,
      );
      response.headers.set("content-disposition", "inline");
      return response;
    } catch (error) {
      return mediaDeliveryError(context, error);
    }
  });

  api.get("/media/artifact-revisions/:revisionId", async (context) => {
    const revisionId = context.req.param("revisionId");
    if (!validArtifactRevisionId(revisionId))
      return mediaError(context, "invalid-request", "媒体请求格式无效", 400);
    try {
      return await artifactDownloadResponse(
        application,
        revisionId,
        context.req.raw,
        context.req.query("assetLibraryId"),
      );
    } catch (error) {
      return mediaDeliveryError(context, error);
    }
  });

  api.post("/media/playback-plans/:revisionId", async (context) => {
    try {
      const body = await context.req.json().catch(() => undefined);
      const request = safeParse(playbackPlanRequestSchema, body);
      if (!request.success)
        return mediaError(context, "invalid-request", "播放计划输入无效", 400);
      const selection = playbackRevisionSelection(
        context.req.param("revisionId"),
        context.req.query("assetLibraryId"),
      );
      if (selection === undefined)
        return mediaError(context, "invalid-request", "媒体请求格式无效", 400);
      const result = await application.planPlayback(
        selection,
        request.output.consumer as ConsumerPlaybackCapabilities,
        request.output.preferences as PlaybackPreferences,
      );
      const library = selection.assetLibraryId;
      const libraryQuery =
        library === undefined
          ? ""
          : `?assetLibraryId=${encodeURIComponent(library)}`;
      const output = safeParse(publicPlaybackPlanSchema, {
        ...result,
        ...(result.status === "ready"
          ? {
              mediaUrl: `/api/v1/media/playback-media/${encodeURIComponent(result.revisionId)}/${result.blobDigest}${libraryQuery}`,
            }
          : {}),
      });
      if (!output.success) throw new Error("播放计划结果无效");
      return context.json(output.output);
    } catch (error) {
      return mediaDeliveryError(context, error);
    }
  });

  api.get("/media/playback-media/:revisionId/:blobDigest", async (context) => {
    const digest = context.req.param("blobDigest");
    if (!/^[a-f0-9]{64}$/u.test(digest))
      return mediaError(context, "invalid-request", "媒体请求格式无效", 400);
    try {
      const selection = playbackRevisionSelection(
        context.req.param("revisionId"),
        context.req.query("assetLibraryId"),
      );
      if (selection === undefined)
        return mediaError(context, "invalid-request", "媒体请求格式无效", 400);
      const descriptor = await application.prepareArtifactDownload(selection);
      if (descriptor.blobDigest !== digest)
        throw new ArtifactByteAccessError("artifact-integrity-failed");
      return await artifactByteResponse(
        application,
        selection,
        descriptor,
        context.req.raw,
        false,
      );
    } catch (error) {
      return mediaDeliveryError(context, error);
    }
  });

  api.get("/media/playback-interactions", async (context) => {
    const revisions = context.req.queries("artifactRevisionId") ?? [];
    if (
      revisions.length === 0 ||
      revisions.length > 128 ||
      revisions.some((revision) => !validArtifactRevisionId(revision))
    )
      return mediaError(
        context,
        "invalid-request",
        "播放交互查询条件无效",
        400,
      );
    try {
      const result = safeParse(playbackInteractionListSchema, {
        items: await application.interactions.read(revisions),
      });
      if (!result.success) throw new Error("播放交互读取结果无效");
      return context.json(result.output);
    } catch {
      return mediaError(context, "unavailable", "暂时无法读取播放状态", 503);
    }
  });

  api.post("/media/playback-interactions", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const request = safeParse(savePlaybackInteractionRequestSchema, body);
    if (!request.success)
      return mediaError(context, "invalid-request", "播放交互状态无效", 400);
    try {
      await application.interactions.save(request.output);
      const result = safeParse(playbackInteractionSavedSchema, {
        status: "saved",
      });
      if (!result.success) throw new Error("播放状态保存结果无效");
      return context.json(result.output);
    } catch {
      return mediaError(context, "unavailable", "暂时无法保存播放状态", 503);
    }
  });

  return api;
}

async function observedMaterialSelection(
  application: ProductApplication,
  subjectId: string,
  locationId: string,
  assetLibraryId?: string,
) {
  const facts = await application.workflow.inspectCurrentCatalogueSubject(
    subjectId,
    undefined,
    assetLibraryId,
  );
  const location = facts?.locations.find(
    (candidate) => candidate.id === locationId && candidate.kind === "observed",
  );
  if (location === undefined) return undefined;
  if (
    location.content.status === "confirmed" &&
    location.content.target.kind === "artifact-revision"
  )
    return {
      kind: "revision" as const,
      revisionId: location.content.target.revisionId,
    };
  const selected =
    await application.observedFileDownloadForLocation(locationId);
  return selected === undefined
    ? undefined
    : { kind: "selection" as const, selectionId: selected.selectionId };
}

async function readObservedSelection(
  application: ProductApplication,
  selection: Awaited<ReturnType<typeof observedMaterialSelection>> & {},
  request: Request,
  assetLibraryId?: string,
): Promise<Response> {
  if (selection.kind === "revision")
    return await artifactDownloadResponse(
      application,
      selection.revisionId,
      request,
      assetLibraryId,
    );
  return await observedMaterialResponse(
    application,
    selection.selectionId,
    request,
    assetLibraryId,
  );
}

async function observedMaterialResponse(
  application: ProductApplication,
  selectionId: string,
  request: Request,
  assetLibraryId?: string,
): Promise<Response> {
  if (!/^observed-file-selection_1_[a-f0-9]{64}$/u.test(selectionId))
    return mediaErrorResponse("unavailable", "媒体服务暂时不可用", 503);
  const confirmed = await application.confirmObservedFileRevision({
    observedFileSelectionId: selectionId,
    ...(assetLibraryId === undefined ? {} : { assetLibraryId }),
  });
  return await artifactDownloadResponse(
    application,
    confirmed.artifactRevisionId,
    request,
    assetLibraryId,
  );
}

async function artifactDownloadResponse(
  application: ProductApplication,
  revisionId: string,
  request: Request,
  assetLibraryId?: string,
): Promise<Response> {
  const selection = artifactRevisionSelection(revisionId, assetLibraryId);
  const descriptor = await application.prepareArtifactDownload(selection);
  return await artifactByteResponse(
    application,
    selection,
    descriptor,
    request,
    true,
  );
}

async function artifactByteResponse(
  application: ProductApplication,
  selection: {
    readonly artifactRevisionId: string;
    readonly assetLibraryId?: string;
  },
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
    if (tags === undefined)
      return mediaErrorResponse("invalid-request", "条件请求格式无效", 400);
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
    if (tags === undefined)
      return mediaErrorResponse("invalid-request", "条件请求格式无效", 400);
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
      return mediaErrorResponse("invalid-request", "字节范围格式无效", 400);
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
  const lease = await application.openArtifactBytes({
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
          // 保留读取失败本身，清理错误由应用层资源报告通道处理。
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

function artifactRevisionSelection(value: string, assetLibraryId?: string) {
  return {
    artifactRevisionId: value,
    ...(assetLibraryId === undefined || assetLibraryId.length === 0
      ? {}
      : { assetLibraryId }),
  };
}

function playbackRevisionSelection(value: string, assetLibraryId?: string) {
  if (!/^artifact-revision_[A-Za-z0-9][A-Za-z0-9._~-]{0,220}$/u.test(value))
    return undefined;
  return artifactRevisionSelection(value, assetLibraryId);
}

function validArtifactRevisionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".."
  );
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

function requestCancellation(signal: AbortSignal) {
  return {
    get cancelled() {
      return signal.aborted;
    },
    onCancel(listener: () => void) {
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
      return () => signal.removeEventListener("abort", listener);
    },
  };
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

type ParsedEntityTag = { readonly weak: boolean; readonly opaque: string };
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

function parseSingleByteRange(value: string, length: number): ParsedRange {
  const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=(.*)$/u.exec(value);
  if (match === null) return { status: "malformed" };
  if (match[1]!.toLowerCase() !== "bytes") return { status: "ignored" };
  const members = match[2]!.split(",").map(trimOws);
  if (members.length !== 1)
    return members.every(validByteRangeMember)
      ? { status: "unsatisfied" }
      : { status: "malformed" };
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

function mediaDeliveryError(context: Context, error: unknown): Response {
  if (error instanceof ArtifactByteAccessError) {
    const status =
      error.code === "artifact-revision-not-found"
        ? 404
        : error.code === "application-shutting-down"
          ? 503
          : 409;
    return mediaError(
      context,
      status === 404
        ? "not-found"
        : status === 503
          ? "unavailable"
          : "conflict",
      "媒体材料当前不可用",
      status,
    );
  }
  if (error instanceof ObservedRevisionConfirmationError) {
    const status = error.code === "confirmation-commit-failed" ? 503 : 409;
    return mediaError(
      context,
      status === 503 ? "unavailable" : "conflict",
      "观察材料已变化或当前不可用",
      status,
    );
  }
  return mediaError(context, "unavailable", "媒体服务暂时不可用", 503);
}

function mediaError(
  context: Context,
  code: "invalid-request" | "conflict" | "not-found" | "unavailable",
  message: string,
  status: 400 | 404 | 409 | 503,
): Response {
  return context.json({ error: { code, message } }, status);
}

function mediaErrorResponse(
  code: "invalid-request" | "conflict" | "not-found" | "unavailable",
  message: string,
  status: 400 | 404 | 409 | 503,
): Response {
  return Response.json({ error: { code, message } }, { status });
}
