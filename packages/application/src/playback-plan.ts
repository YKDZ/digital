import type { CapabilityCoordinate } from "@digital/domain";

import type {
  ArtifactByteDescriptor,
  ArtifactRevisionSelection,
  ByteInterval,
} from "./artifact-byte-access.ts";

export type ConsumerPlaybackCapabilities = {
  readonly contractVersion: "consumer-playback/1";
  readonly supportsByteRanges: boolean;
  readonly media: readonly {
    readonly mediaType: string;
    /** 省略或空数组表示该 mediaType 下接受检查器报告的任意 codec 集合。 */
    readonly codecs?: readonly string[];
  }[];
};

export type PlaybackPreferences = {
  readonly audioTrackId?: string;
  readonly subtitleTrackId?: string;
  readonly quality?: "source";
};

export type PlaybackFormatFacts = {
  readonly mediaType: string;
  readonly container: string;
  readonly codecs: readonly string[];
};

export type BoundedArtifactByteProbe = {
  read(input: ByteInterval): Promise<Uint8Array>;
};

export type PlaybackFormatInspector = {
  readonly capability: CapabilityCoordinate;
  inspect(input: {
    readonly revisionId: string;
    readonly blobDigest: string;
    readonly bytes: BoundedArtifactByteProbe;
  }): Promise<PlaybackFormatFacts | undefined>;
};

export type PlaybackDeploymentCapabilities = {
  readonly direct: { readonly contractVersion: "direct-playback/1" };
  readonly processors: readonly [];
};

export type PlaybackPlanResult =
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
    }
  | {
      readonly status: "incompatible";
      readonly reason:
        | "format-unknown"
        | "byte-ranges-required"
        | "container-unsupported"
        | "codec-unsupported"
        | "preference-unavailable";
    };

export type PlaybackPlanning = {
  planPlayback(
    selection: ArtifactRevisionSelection,
    consumer: ConsumerPlaybackCapabilities,
    preferences: PlaybackPreferences,
  ): Promise<PlaybackPlanResult>;
};

export function planDirectPlayback(input: {
  readonly descriptor: ArtifactByteDescriptor;
  readonly consumer: ConsumerPlaybackCapabilities;
  readonly preferences: PlaybackPreferences;
  readonly format: PlaybackFormatFacts | undefined;
  readonly deployment: PlaybackDeploymentCapabilities;
}): PlaybackPlanResult {
  if (
    input.deployment.direct.contractVersion !== "direct-playback/1" ||
    input.deployment.processors.length !== 0
  )
    throw new Error("部署播放能力无效");
  const consumer = normalizeConsumer(input.consumer);
  const preferences = normalizePreferences(input.preferences);
  const format = normalizeFormat(input.format);
  if (!consumer.supportsByteRanges)
    return { status: "incompatible", reason: "byte-ranges-required" };
  if (format === undefined)
    return { status: "incompatible", reason: "format-unknown" };
  if (
    preferences.audioTrackId !== undefined ||
    preferences.subtitleTrackId !== undefined
  )
    return { status: "incompatible", reason: "preference-unavailable" };
  const matchingContainers = consumer.media.filter(
    (candidate) => candidate.mediaType === format.mediaType,
  );
  if (matchingContainers.length === 0)
    return { status: "incompatible", reason: "container-unsupported" };
  if (
    !matchingContainers.some(
      (candidate) =>
        candidate.codecs.length === 0 ||
        format.codecs.every((codec) => candidate.codecs.includes(codec)),
    )
  )
    return { status: "incompatible", reason: "codec-unsupported" };
  return {
    status: "ready",
    revisionId: input.descriptor.revisionId,
    blobDigest: input.descriptor.blobDigest,
    rendition: {
      kind: "direct",
      mediaType: format.mediaType,
      codecs: format.codecs,
      byteLength: input.descriptor.byteLength,
    },
  };
}

function normalizeConsumer(input: ConsumerPlaybackCapabilities) {
  if (input.contractVersion !== "consumer-playback/1")
    throw new Error("消费者播放能力合同无效");
  const entries = new Map<
    string,
    { readonly mediaType: string; readonly codecs: readonly string[] }
  >();
  for (const candidate of input.media) {
    const mediaType = normalizeToken(candidate.mediaType);
    if (!mediaType.includes("/")) throw new Error("消费者媒体类型无效");
    const codecs = [
      ...new Set((candidate.codecs ?? []).map(normalizeToken)),
    ].toSorted();
    entries.set(`${mediaType}\u0000${codecs.join("\u0000")}`, {
      mediaType,
      codecs,
    });
  }
  return {
    contractVersion: input.contractVersion,
    supportsByteRanges: input.supportsByteRanges,
    media: [...entries.values()].toSorted((left, right) =>
      `${left.mediaType}\u0000${left.codecs.join("\u0000")}`.localeCompare(
        `${right.mediaType}\u0000${right.codecs.join("\u0000")}`,
      ),
    ),
  };
}

function normalizePreferences(input: PlaybackPreferences): PlaybackPreferences {
  const audioTrackId = normalizeOptionalPreference(input.audioTrackId);
  const subtitleTrackId = normalizeOptionalPreference(input.subtitleTrackId);
  return {
    ...(audioTrackId === undefined ? {} : { audioTrackId }),
    ...(subtitleTrackId === undefined ? {} : { subtitleTrackId }),
    ...(input.quality === undefined ? {} : { quality: input.quality }),
  };
}

function normalizeFormat(
  input: PlaybackFormatFacts | undefined,
): PlaybackFormatFacts | undefined {
  if (input === undefined) return undefined;
  const codecs = [...new Set(input.codecs.map(normalizeToken))].toSorted();
  const mediaType = normalizeToken(input.mediaType);
  if (codecs.length === 0 || !mediaType.includes("/")) return undefined;
  return {
    mediaType,
    container: normalizeToken(input.container),
    codecs,
  };
}

function normalizeOptionalPreference(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("播放偏好无效");
  return normalized;
}

function normalizeToken(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) throw new Error("播放能力值无效");
  return normalized;
}
