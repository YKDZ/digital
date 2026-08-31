/** 公开消费只接受精确产物修订版身份。 */
import type {
  OperationCancellation,
  OperationLease,
} from "./execution-host.ts";

export type ArtifactRevisionSelection = {
  readonly artifactRevisionId: string;
};

/** Application 授权后的、脱敏的精确修订版描述。 */
export type ArtifactByteDescriptor = {
  readonly revisionId: string;
  readonly blobDigest: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly suggestedFilename: string;
};

/** Delivery 提供的客户端取消桥接；不泄露 HTTP 或 Node 类型。 */
export type ByteReadCancellation = {
  readonly cancelled: boolean;
  onCancel(listener: () => void): () => void;
};

export type ByteInterval = {
  readonly startInclusive: number;
  readonly endInclusive: number;
};

/** 固定 revision 与摘要的一次有界读取租约。 */
export type AuthorizedArtifactByteLease = {
  readonly revisionId: string;
  readonly blobDigest: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly interval: ByteInterval;
  read(input: {
    readonly maximumBytes: number;
    readonly cancellation: ByteReadCancellation;
  }): Promise<{ readonly bytes: Uint8Array; readonly done: boolean }>;
  close(
    reason: "completed" | "client-cancelled" | "failed" | "shutdown",
  ): Promise<void>;
};

/** Application 拥有的精确 revision 字节入口。 */
export type ArtifactByteAccess = {
  describe(
    selection: ArtifactRevisionSelection,
  ): Promise<ArtifactByteDescriptor>;
  open(input: {
    readonly selection: ArtifactRevisionSelection;
    readonly expectedBlobDigest: string;
    readonly interval: ByteInterval;
  }): Promise<AuthorizedArtifactByteLease>;
};

export class ArtifactByteAccessError extends Error {
  readonly code:
    | "artifact-revision-not-found"
    | "artifact-bytes-unavailable"
    | "artifact-location-revoked"
    | "artifact-bytes-changed"
    | "artifact-integrity-failed"
    | "client-cancelled"
    | "application-shutting-down"
    | "byte-read-in-progress";

  constructor(code: ArtifactByteAccessError["code"]) {
    super(code);
    this.name = "ArtifactByteAccessError";
    this.code = code;
  }
}

/** SQLite 等持久适配器实现的、用例专属事实查询。 */
export type ArtifactRevisionAccessFacts = {
  readonly revision: {
    readonly id: string;
    readonly artifactId: string;
    readonly blobDigest: string;
  };
  readonly blob: {
    readonly digest: string;
    readonly byteLength: number;
    readonly mediaType: string;
  };
  readonly locations: readonly (
    | {
        readonly kind: "managed";
        readonly locationId: string;
        /** Application 私有位置事实，绝不越过 ProductApplication。 */
        readonly address: string;
      }
    | {
        readonly kind: "observed";
        readonly locationId: string;
        /** Application 私有位置事实，绝不越过 ProductApplication。 */
        readonly address: string;
        readonly confirmedObservation: {
          readonly snapshotId: string;
          readonly observedAt: string;
          readonly size: number;
          readonly modifiedAt: string;
        };
        readonly confirmationBaseline: string;
      }
  )[];
};

/** Application 固定同一修订版的候选策略：托管优先，其后按稳定位置身份。 */
export function orderedArtifactByteLocations(
  locations: ArtifactRevisionAccessFacts["locations"],
): ArtifactRevisionAccessFacts["locations"] {
  return [...locations].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "managed" ? -1 : 1;
    return left.locationId.localeCompare(right.locationId);
  });
}

/** 进程关闭是整次用例失败；单一位置失败允许尝试同 revision 的下一候选。 */
export function artifactCandidateFailureIsTerminal(error: unknown): boolean {
  return (
    error instanceof ArtifactByteAccessError &&
    error.code === "application-shutting-down"
  );
}

/** 将适配器提供的 basename 收窄为不暴露内部地址的展示文件名。 */
export function safeArtifactFilename(
  value: string,
  revisionId: string,
): string {
  if (/^[a-f0-9]{64}$/u.test(value))
    return `artifact-${revisionId.slice(0, 16)}`;
  const withoutControls = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f ? "_" : character;
    })
    .join("");
  const cleaned = withoutControls
    .replaceAll(/[\\/]/gu, "_")
    .replaceAll(/^\.{1,2}$/gu, "")
    .trimEnd()
    .slice(0, 180);
  return cleaned || `artifact-${revisionId.slice(0, 16)}`;
}

export type ArtifactRevisionAccessQueries = {
  readArtifactRevisionAccessFacts(
    revisionId: string,
  ): Promise<ArtifactRevisionAccessFacts | undefined>;
};

export type ArtifactContentProofMetadata = {
  readonly blobDigest: string;
  readonly scheme: "artifact-frame-manifest/1";
  readonly byteLength: number;
  readonly frameSize: 1_048_576;
  readonly frameCount: number;
  readonly manifestDigest: string;
};

export type ArtifactProofPreparationBaseline = {
  readonly revisionId: string;
  readonly artifactId: string;
  readonly blobDigest: string;
  readonly blobByteLength: number;
  readonly locationId: string;
  readonly locationKind: "managed" | "observed";
  readonly conditionalBaseline: string;
  readonly observedAuthority?: {
    readonly registrationId: string;
    readonly registrationVersion: number;
    readonly confirmationBaseline: string;
  };
};

export function artifactProofConditionalBaseline(input: {
  readonly revisionId: string;
  readonly artifactId: string;
  readonly blobDigest: string;
  readonly blobByteLength: number;
  readonly locationId: string;
  readonly locationKind: "managed" | "observed";
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        revisionId: input.revisionId,
        artifactId: input.artifactId,
        blobDigest: input.blobDigest,
        blobByteLength: input.blobByteLength,
        locationId: input.locationId,
        locationKind: input.locationKind,
      }),
    )
    .digest("hex");
}

export type ArtifactContentProofQueries = {
  readArtifactContentProof(
    blobDigest: string,
  ): Promise<ArtifactContentProofMetadata | undefined>;
};

export type ArtifactContentProofCommands = {
  adoptArtifactContentProof(input: {
    readonly expected: ArtifactProofPreparationBaseline;
    readonly proof: ArtifactContentProofMetadata;
  }): Promise<"committed" | "already-committed" | "stale">;
};

/** Application 可逐块读取并负责关闭的单个当前位置来源。 */
export type ArtifactByteSource = {
  readonly byteLength: number;
  readChunk(
    offset: number,
    maximumBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly done: boolean }>;
  close(): Promise<void>;
};

export type OpenedArtifactByteSource = {
  readonly source: ArtifactByteSource;
  readonly suggestedFilename: string;
  readonly observedBinding?: { release(): void };
  readonly observedAuthority?: {
    readonly registrationId: string;
    readonly registrationVersion: number;
  };
};

/** 具体文件系统只解析一个 Application 已选择的候选，不拥有排序或回退策略。 */
export type ArtifactLocationByteSources = {
  open(input: {
    readonly candidate: ArtifactRevisionAccessFacts["locations"][number];
    readonly blobDigest: string;
    readonly purpose: "confirmation" | "access";
    readonly operation: OperationLease;
  }): Promise<OpenedArtifactByteSource | undefined>;
};

export type VerifiedArtifactFrameManifest = {
  expectedFrameDigest(
    ordinal: number,
    cancellation: OperationCancellation,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
};

/** proof store 是固定格式字节适配端口；何时检查、重建和采纳由 Application 决定。 */
export type ArtifactFrameProofStorePort = {
  inspect(
    metadata: ArtifactContentProofMetadata,
    cancellation: OperationCancellation,
  ): Promise<void>;
  build(
    source: ArtifactByteSource,
    cancellation: OperationCancellation,
    expected?: { readonly blobDigest: string; readonly byteLength: number },
  ): Promise<ArtifactContentProofMetadata>;
  open(
    metadata: ArtifactContentProofMetadata,
    cancellation: OperationCancellation,
  ): Promise<VerifiedArtifactFrameManifest>;
};

export type ArtifactByteCleanupReporter = {
  reportCleanupFailure(input: {
    readonly cleanup: "media-source" | "proof-manifest";
    readonly error: unknown;
    readonly primaryError?: unknown;
  }): void | Promise<void>;
};

export type ObservedFileSelectionId = string;

export type ObservationBaseline = {
  readonly snapshotId: string;
  readonly observedAt: string;
  readonly size: number;
  readonly modifiedAt: string;
};

export type ObservedFileConfirmationFacts = {
  readonly selectionId: ObservedFileSelectionId;
  readonly artifactId: string;
  readonly location: {
    readonly locationId: string;
    /** Application 私有位置事实。 */
    readonly address: string;
  };
  readonly observation: ObservationBaseline;
  readonly conditionalBaseline: string;
};

export type ObservedFileConfirmationQueries = {
  observedFileSelectionForLocation(
    locationId: string,
  ): Promise<ObservedFileSelectionId | undefined>;
  readObservedFileConfirmationFacts(
    selectionId: ObservedFileSelectionId,
  ): Promise<ObservedFileConfirmationFacts | undefined>;
};

export type ObservedRevisionConfirmationCommands = {
  submitConfirmedObservedRevision(input: {
    readonly expected: ObservedFileConfirmationFacts;
    readonly observedAuthority: {
      readonly registrationId: string;
      readonly registrationVersion: number;
    };
    readonly blob: {
      readonly digest: string;
      readonly mediaType: string;
      readonly byteLength: number;
    };
    readonly revision: {
      readonly id: string;
      readonly artifactId: string;
      readonly blobDigest: string;
    };
    readonly proof: ArtifactContentProofMetadata;
  }): Promise<"committed" | "already-committed" | "stale">;
};

export class ObservedRevisionConfirmationError extends Error {
  readonly code:
    | "observed-selection-stale"
    | "confirmation-stale"
    | "confirmation-commit-failed"
    | "artifact-bytes-changed"
    | "artifact-location-revoked";

  constructor(code: ObservedRevisionConfirmationError["code"]) {
    super(code);
    this.name = "ObservedRevisionConfirmationError";
    this.code = code;
  }
}
import { createHash } from "node:crypto";
