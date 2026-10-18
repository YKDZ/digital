import {
  confirmedObservedMaterialSchema,
  playbackInteractionListSchema,
  playbackInteractionReadRequestSchema,
  playbackPlanRequestSchema,
  playbackInteractionSavedSchema,
  publicPlaybackPlanSchema,
  savePlaybackInteractionRequestSchema,
  type ConfirmedObservedMaterial,
  type PlaybackPlanRequest,
  type PublicPlaybackInteraction,
  type PublicPlaybackPlan,
} from "./media-contract.ts";
import type {
  PublicApiJsonRequest,
  PublicApiJsonRequestOptions,
  PublicApiRequestValidation,
} from "./source-connection-client.ts";

export type PublicMediaReadOptions = {
  readonly assetLibraryId?: string;
  readonly range?: string;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
  readonly ifRange?: string;
  readonly signal?: AbortSignal;
};

export type PublicMediaClientMethods = {
  confirmObservedMaterial(
    subjectId: string,
    locationId: string,
    assetLibraryId?: string,
  ): Promise<ConfirmedObservedMaterial>;
  readObservedMaterial(
    subjectId: string,
    locationId: string,
    options?: PublicMediaReadOptions,
  ): Promise<Response>;
  readObservedArtwork(
    subjectId: string,
    locationId: string,
    options?: PublicMediaReadOptions,
  ): Promise<Response>;
  readManagedArtifact(digest: string, signal?: AbortSignal): Promise<Response>;
  readArtifactRevision(
    revisionId: string,
    options?: PublicMediaReadOptions,
  ): Promise<Response>;
  createPlaybackPlan(
    revisionId: string,
    input: PlaybackPlanRequest,
    assetLibraryId?: string,
  ): Promise<PublicPlaybackPlan>;
  readPlaybackMedia(
    revisionId: string,
    blobDigest: string,
    options?: PublicMediaReadOptions,
  ): Promise<Response>;
  readPlaybackInteractions(
    artifactRevisionIds: readonly string[],
  ): Promise<readonly PublicPlaybackInteraction[]>;
  savePlaybackInteraction(input: PublicPlaybackInteraction): Promise<void>;
};

/** 媒体字节通过标准 HTTP Response 流交付，响应取消继续传到服务端租约。 */
export function mediaClientMethods(input: {
  readonly apiBaseUrl: URL;
  readonly fetch: typeof globalThis.fetch;
  readonly requestJson: PublicApiJsonRequest;
  readonly validateRequest: PublicApiRequestValidation;
  readonly jsonRequest: PublicApiJsonRequestOptions;
}): PublicMediaClientMethods {
  const mediaUrl = (path: string, options?: PublicMediaReadOptions) => {
    const url = new URL(`media/${path}`, input.apiBaseUrl);
    if (options?.assetLibraryId !== undefined)
      url.searchParams.set("assetLibraryId", options.assetLibraryId);
    return url;
  };
  const read = async (
    url: URL,
    options: PublicMediaReadOptions = {},
  ): Promise<Response> => {
    const headers = new Headers({ accept: "application/octet-stream" });
    if (options.range !== undefined) headers.set("range", options.range);
    if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);
    if (options.ifNoneMatch !== undefined)
      headers.set("if-none-match", options.ifNoneMatch);
    if (options.ifRange !== undefined) headers.set("if-range", options.ifRange);
    try {
      return await input.fetch(url, {
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      throw new Error("无法连接当前产品服务", { cause });
    }
  };

  return {
    async confirmObservedMaterial(subjectId, locationId, assetLibraryId) {
      const url = mediaUrl(
        `observed-materials/${encodeURIComponent(subjectId)}/${encodeURIComponent(locationId)}/confirm`,
        assetLibraryId === undefined ? {} : { assetLibraryId },
      );
      return await input.requestJson(
        url,
        input.jsonRequest("POST", {}),
        confirmedObservedMaterialSchema,
      );
    },
    async readObservedMaterial(subjectId, locationId, options = {}) {
      return await read(
        mediaUrl(
          `observed-materials/${encodeURIComponent(subjectId)}/${encodeURIComponent(locationId)}`,
          options,
        ),
        options,
      );
    },
    async readObservedArtwork(subjectId, locationId, options = {}) {
      return await read(
        mediaUrl(
          `observed-artwork/${encodeURIComponent(subjectId)}/${encodeURIComponent(locationId)}`,
          options,
        ),
        options,
      );
    },
    async readManagedArtifact(digest, signal) {
      return await read(
        mediaUrl(`managed-artifacts/${encodeURIComponent(digest)}`),
        signal === undefined ? {} : { signal },
      );
    },
    async readArtifactRevision(revisionId, options = {}) {
      return await read(
        mediaUrl(
          `artifact-revisions/${encodeURIComponent(revisionId)}`,
          options,
        ),
        options,
      );
    },
    async createPlaybackPlan(revisionId, value, assetLibraryId) {
      const request = input.validateRequest(
        playbackPlanRequestSchema,
        value,
        "播放计划输入无效",
      );
      return await input.requestJson(
        mediaUrl(
          `playback-plans/${encodeURIComponent(revisionId)}`,
          assetLibraryId === undefined ? {} : { assetLibraryId },
        ),
        input.jsonRequest("POST", request),
        publicPlaybackPlanSchema,
      );
    },
    async readPlaybackMedia(revisionId, blobDigest, options = {}) {
      return await read(
        mediaUrl(
          `playback-media/${encodeURIComponent(revisionId)}/${encodeURIComponent(blobDigest)}`,
          options,
        ),
        options,
      );
    },
    async readPlaybackInteractions(artifactRevisionIds) {
      const request = input.validateRequest(
        playbackInteractionReadRequestSchema,
        { artifactRevisionIds },
        "播放交互查询条件无效",
      );
      const url = mediaUrl("playback-interactions");
      for (const revisionId of request.artifactRevisionIds)
        url.searchParams.append("artifactRevisionId", revisionId);
      return (
        await input.requestJson(
          url,
          { headers: { accept: "application/json" } },
          playbackInteractionListSchema,
        )
      ).items;
    },
    async savePlaybackInteraction(value) {
      const request = input.validateRequest(
        savePlaybackInteractionRequestSchema,
        value,
        "播放交互状态无效",
      );
      await input.requestJson(
        mediaUrl("playback-interactions"),
        input.jsonRequest("POST", request),
        playbackInteractionSavedSchema,
      );
    },
  };
}
