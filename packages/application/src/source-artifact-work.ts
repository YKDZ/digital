import { createHash } from "node:crypto";

import {
  type Artifact,
  type ArtifactAssociation,
  type ArtifactRevision,
  type Blob,
  type CapabilityCoordinate,
  type Location,
  type RecognitionProposal,
  type SourceArtifactCandidate,
  type SourceRecord,
  recognitionSourceInterpretation,
} from "@digital/domain";

import { assetLibraryCapabilityToken } from "./asset-libraries.ts";

export type SourceArtifactAcquisitionCheckpoint = {
  readonly candidateId: string;
  readonly sourceRecordId: string;
  readonly subjectId?: string;
  readonly role: string;
  /** 旧检查点缺少该坐标，不得进行语义复用。 */
  readonly acquisitionReference?: string;
  /** 使该候选可用的解释器。 */
  readonly sourceArtifactProducer?: CapabilityCoordinate;
  /** 执行外部效果的获取器。 */
  readonly acquisitionProducer?: CapabilityCoordinate;
  readonly stagedReference: string;
  readonly digest: string;
  readonly mediaType: string;
};

export type ManagedSourceArtifactCheckpoint = {
  readonly candidateId: string;
  readonly sourceRecordId: string;
  readonly subjectId?: string;
  readonly role: string;
  /** 在托管存储恢复期间保留获取坐标。 */
  readonly acquisitionReference?: string;
  readonly sourceArtifactProducer?: CapabilityCoordinate;
  readonly acquisitionProducer?: CapabilityCoordinate;
  readonly blob: Blob;
  readonly location: { readonly address: string };
};

type AcquiredSourceArtifact = {
  readonly candidateId: string;
  readonly sourceRecordId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly producer?: CapabilityCoordinate;
};

type SourceArtifactAcquirer = {
  readonly capability?: CapabilityCoordinate;
  canAcquire(candidate: SourceArtifactCandidate): boolean;
  acquire(candidate: SourceArtifactCandidate): Promise<AcquiredSourceArtifact>;
};

type ManagedArtifactStore = {
  store(content: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<{
    readonly blob: Blob;
    readonly location: { readonly address: string };
  }>;
  stage?(content: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly idempotencyKey: string;
    readonly candidateId: string;
    readonly sourceRecordId: string;
    readonly role?: string;
    readonly acquisitionReference?: string;
    readonly sourceArtifactProducer?: CapabilityCoordinate;
    readonly acquisitionProducer?: CapabilityCoordinate;
  }): Promise<SourceArtifactAcquisitionCheckpoint>;
  storeStaged?(checkpoint: SourceArtifactAcquisitionCheckpoint): Promise<{
    readonly blob: Blob;
    readonly location: { readonly address: string };
  }>;
};

type CheckpointedSourceArtifactWorkPorts = {
  readonly acquirers: readonly SourceArtifactAcquirer[];
  readonly managedStore: ManagedArtifactStore;
  /**
   * 冻结库配置为某个来源身份允许的获取器能力坐标拼写（ID@实现版/契约版）。未提供该端口
   * 时沿用调用方给出的完整集合；提供空数组表示该来源在本次执行内不得越过任何外部获取效果。
   */
  readonly acquirerCapabilityTokensForSourceIdentity?: (
    sourceIdentity: string,
  ) => readonly string[];
};

/** 只标记真正越过 Source Artifact Acquirer seam 的外部获取效果失败。 */
export class SourceArtifactAcquisitionEffectFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Source Artifact external acquisition effect failed");
    this.cause = cause;
  }
}

export class CheckpointedSourceArtifactWork {
  private readonly ports: CheckpointedSourceArtifactWorkPorts;

  constructor(ports: CheckpointedSourceArtifactWorkPorts) {
    this.ports = ports;
  }

  async complete(input: {
    readonly candidates: readonly SourceArtifactCandidate[];
    readonly proposal?: RecognitionProposal;
    readonly interpretationSourceRecordIds?: readonly string[];
    readonly sourceRecords: readonly SourceRecord[];
    readonly idempotencyKey: (candidate: SourceArtifactCandidate) => string;
    readonly requireCheckpointStore: boolean;
    readonly beforeEffect?: () => void | Promise<void>;
    /** 在效果发生前冻结选定获取器的实际坐标。 */
    readonly beforeAcquire?: (
      capability: CapabilityCoordinate,
    ) => void | Promise<void>;
    readonly onAcquired?: (
      acquisitions: readonly SourceArtifactAcquisitionCheckpoint[],
    ) => void | Promise<void>;
    readonly onStored?: (
      managed: readonly ManagedSourceArtifactCheckpoint[],
    ) => void | Promise<void>;
  }): Promise<readonly ManagedSourceArtifactCheckpoint[]> {
    const acquired = [];
    for (const candidate of input.candidates) {
      await input.beforeEffect?.();
      acquired.push(
        await this.acquireAndStage({
          candidate,
          ...(input.proposal === undefined ? {} : { proposal: input.proposal }),
          ...(input.interpretationSourceRecordIds === undefined
            ? {}
            : {
                interpretationSourceRecordIds:
                  input.interpretationSourceRecordIds,
              }),
          sourceRecords: input.sourceRecords,
          idempotencyKey: input.idempotencyKey(candidate),
          requireCheckpointStore: input.requireCheckpointStore,
          ...(input.beforeAcquire === undefined
            ? {}
            : { beforeAcquire: input.beforeAcquire }),
        }),
      );
    }
    const checkpoints = acquired.map(({ checkpoint }) => checkpoint);
    await input.onAcquired?.(checkpoints);
    const managed = [];
    for (const item of acquired) {
      await input.beforeEffect?.();
      managed.push(
        await this.store({
          acquisition: item.checkpoint,
          ...(item.staged === undefined ? {} : { staged: item.staged }),
          requireCheckpointStore: input.requireCheckpointStore,
        }),
      );
    }
    await input.onStored?.(managed);
    return managed;
  }

  async resumeStore(input: {
    readonly acquisitions: readonly SourceArtifactAcquisitionCheckpoint[];
    readonly beforeEffect?: () => void | Promise<void>;
    readonly onStored?: (
      managed: readonly ManagedSourceArtifactCheckpoint[],
    ) => void | Promise<void>;
  }): Promise<readonly ManagedSourceArtifactCheckpoint[]> {
    const managed = [];
    for (const acquisition of input.acquisitions) {
      if (!hasCompleteAcquisitionCoordinate(acquisition))
        throw new Error(
          "Source Artifact Acquisition checkpoint cannot safely resume without complete semantic coordinate",
        );
      await input.beforeEffect?.();
      managed.push(
        await this.store({
          acquisition,
          requireCheckpointStore: true,
        }),
      );
    }
    await input.onStored?.(managed);
    return managed;
  }

  async acquireAndStage(input: {
    readonly candidate: SourceArtifactCandidate;
    readonly proposal?: RecognitionProposal;
    readonly interpretationSourceRecordIds?: readonly string[];
    readonly sourceRecords: readonly SourceRecord[];
    readonly idempotencyKey: string;
    readonly requireCheckpointStore: boolean;
    readonly beforeAcquire?: (
      capability: CapabilityCoordinate,
    ) => void | Promise<void>;
    /**
     * 同一目录租约的最终效果门：异步冻结完成后、真正发起不可中止的外部获取前，以及获取
     * 返回后、写托管 stage 或返回易失 checkpoint 前各复核一次。省略时（managed / 无目录
     * 中立调用）语义完全不变。
     */
    readonly assertEffectLive?: () => void | Promise<void>;
  }): Promise<{
    readonly checkpoint: SourceArtifactAcquisitionCheckpoint;
    readonly staged?: AcquiredSourceArtifact;
  }> {
    const { candidate } = input;
    const staged = await this.acquire(
      candidate,
      interpretationSourceRecordIds(input),
      input.sourceRecords,
      input.beforeAcquire,
      input.assertEffectLive,
    );

    // 获取是不可中止的外部请求：撤销只发生在这段 await 期间时，返回后仍不得进入任何托管效果
    // （stage 或易失 checkpoint 交回后由调用方落盘），故在 digest/stage 之前复核同一目录租约。
    await input.assertEffectLive?.();
    const digest = sha256(staged.bytes);
    if (this.ports.managedStore.stage === undefined) {
      if (input.requireCheckpointStore)
        throw new Error(
          "Managed Artifact Store does not support durable source-artifact staging",
        );
      return {
        checkpoint: {
          candidateId: candidate.id,
          sourceRecordId: candidate.sourceRecordId,
          ...(candidate.subjectId === undefined
            ? {}
            : { subjectId: candidate.subjectId }),
          role: candidate.role,
          acquisitionReference: candidate.acquisitionReference,
          ...(candidate.producer === undefined
            ? {}
            : { sourceArtifactProducer: candidate.producer }),
          ...(staged.producer === undefined
            ? {}
            : { acquisitionProducer: staged.producer }),
          stagedReference: `volatile:${digest}`,
          digest,
          mediaType: staged.mediaType,
        },
        staged,
      };
    }

    const checkpoint = await this.ports.managedStore.stage({
      bytes: staged.bytes,
      mediaType: staged.mediaType,
      idempotencyKey: input.idempotencyKey,
      candidateId: candidate.id,
      sourceRecordId: candidate.sourceRecordId,
      role: candidate.role,
      acquisitionReference: candidate.acquisitionReference,
      ...(candidate.producer === undefined
        ? {}
        : { sourceArtifactProducer: candidate.producer }),
      ...(staged.producer === undefined
        ? {}
        : { acquisitionProducer: staged.producer }),
    });
    const normalized = {
      ...checkpoint,
      ...(candidate.subjectId === undefined
        ? {}
        : { subjectId: candidate.subjectId }),
      role: candidate.role,
      acquisitionReference: candidate.acquisitionReference,
      ...(candidate.producer === undefined
        ? {}
        : { sourceArtifactProducer: candidate.producer }),
      ...(staged.producer === undefined
        ? {}
        : { acquisitionProducer: staged.producer }),
    };
    assertAcquisitionCheckpoint(normalized, candidate, digest);
    return { checkpoint: normalized };
  }

  async materializeDirect(input: {
    readonly candidate: SourceArtifactCandidate;
    readonly proposal?: RecognitionProposal;
    readonly interpretationSourceRecordIds?: readonly string[];
    readonly sourceRecords: readonly SourceRecord[];
    readonly beforeAcquire?: (
      capability: CapabilityCoordinate,
    ) => void | Promise<void>;
  }): Promise<ManagedSourceArtifactCheckpoint> {
    const staged = await this.acquire(
      input.candidate,
      interpretationSourceRecordIds(input),
      input.sourceRecords,
      input.beforeAcquire,
    );
    const stored = await this.ports.managedStore.store({
      bytes: staged.bytes,
      mediaType: staged.mediaType,
    });
    if (stored.blob.digest !== sha256(staged.bytes))
      throw new Error(
        "Managed store reported a digest different from projected source-artifact content",
      );
    return {
      candidateId: input.candidate.id,
      sourceRecordId: input.candidate.sourceRecordId,
      ...(input.candidate.subjectId === undefined
        ? {}
        : { subjectId: input.candidate.subjectId }),
      role: input.candidate.role,
      acquisitionReference: input.candidate.acquisitionReference,
      ...(input.candidate.producer === undefined
        ? {}
        : { sourceArtifactProducer: input.candidate.producer }),
      ...(staged.producer === undefined
        ? {}
        : { acquisitionProducer: staged.producer }),
      blob: stored.blob,
      location: stored.location,
    };
  }

  async store(input: {
    readonly acquisition: SourceArtifactAcquisitionCheckpoint;
    readonly staged?: AcquiredSourceArtifact;
    readonly requireCheckpointStore: boolean;
  }): Promise<ManagedSourceArtifactCheckpoint> {
    const stored =
      this.ports.managedStore.storeStaged === undefined
        ? await this.storeVolatile(input)
        : await this.ports.managedStore.storeStaged(input.acquisition);
    if (stored.blob.digest !== input.acquisition.digest)
      throw new Error(
        "Managed store reported a digest different from acquired source-artifact content",
      );
    return {
      candidateId: input.acquisition.candidateId,
      sourceRecordId: input.acquisition.sourceRecordId,
      ...(input.acquisition.subjectId === undefined
        ? {}
        : { subjectId: input.acquisition.subjectId }),
      role: input.acquisition.role,
      ...(input.acquisition.acquisitionReference === undefined
        ? {}
        : { acquisitionReference: input.acquisition.acquisitionReference }),
      ...(input.acquisition.sourceArtifactProducer === undefined
        ? {}
        : { sourceArtifactProducer: input.acquisition.sourceArtifactProducer }),
      ...(input.acquisition.acquisitionProducer === undefined
        ? {}
        : { acquisitionProducer: input.acquisition.acquisitionProducer }),
      blob: stored.blob,
      location: stored.location,
    };
  }

  private async storeVolatile(input: {
    readonly acquisition: SourceArtifactAcquisitionCheckpoint;
    readonly staged?: AcquiredSourceArtifact;
    readonly requireCheckpointStore: boolean;
  }) {
    if (input.requireCheckpointStore || input.staged === undefined)
      throw new Error(
        "Managed Artifact Store cannot resume a staged source artifact",
      );
    return this.ports.managedStore.store({
      bytes: input.staged.bytes,
      mediaType: input.staged.mediaType,
    });
  }

  private async acquire(
    candidate: SourceArtifactCandidate,
    interpretationRecordIds: readonly string[],
    sourceRecords: readonly SourceRecord[],
    beforeAcquire?: (capability: CapabilityCoordinate) => void | Promise<void>,
    assertEffectLive?: () => void | Promise<void>,
  ): Promise<AcquiredSourceArtifact> {
    if (!interpretationRecordIds.includes(candidate.sourceRecordId))
      throw new Error(
        "Source Artifact Candidate lacks interpretation provenance",
      );
    const sourceRecord = sourceRecords.find(
      (record) => record.id === candidate.sourceRecordId,
    );
    if (sourceRecord === undefined)
      throw new Error(
        "Source Artifact Candidate references an unavailable Source Record",
      );
    // 来源资格在效果前判定：候选引用哪个来源，就只能使用该来源冻结允许的获取器坐标。
    const allowed = this.ports.acquirerCapabilityTokensForSourceIdentity?.(
      sourceRecord.sourceIdentity,
    );
    const acquirer = this.ports.acquirers.find(
      (current) =>
        (allowed === undefined ||
          (current.capability !== undefined &&
            allowed.includes(
              assetLibraryCapabilityToken(current.capability),
            ))) &&
        current.canAcquire(candidate),
    );
    if (acquirer === undefined)
      throw new Error("No Source Artifact Acquirer accepted the candidate");
    if (acquirer.capability !== undefined)
      await beforeAcquire?.(acquirer.capability);
    // 冻结是可 await 的前置效果：撤销落在冻结期间时不得再发起不可中止的外部获取，
    // 故在真正 request 之前复核同一目录租约（前置 await 前的检查不是最终效果门）。
    await assertEffectLive?.();
    let staged: AcquiredSourceArtifact;
    try {
      staged = await acquirer.acquire(candidate);
    } catch (error) {
      throw new SourceArtifactAcquisitionEffectFailure(error);
    }
    if (
      staged.candidateId !== candidate.id ||
      staged.sourceRecordId !== candidate.sourceRecordId
    )
      throw new Error(
        "Source Artifact Acquirer returned content for another candidate",
      );
    if (
      mediaTypeEssence(staged.mediaType) !==
      mediaTypeEssence(candidate.mediaType)
    )
      throw new Error(
        "Source Artifact response media type differs from its candidate",
      );
    return {
      ...staged,
      ...(acquirer.capability === undefined
        ? {}
        : { producer: acquirer.capability }),
    };
  }
}

function interpretationSourceRecordIds(input: {
  readonly proposal?: RecognitionProposal;
  readonly interpretationSourceRecordIds?: readonly string[];
}): readonly string[] {
  const sourceRecordIds =
    input.interpretationSourceRecordIds ??
    (input.proposal === undefined
      ? undefined
      : recognitionSourceInterpretation(input.proposal)?.sourceRecordIds);
  if (sourceRecordIds === undefined)
    throw new Error("Source Artifact work requires interpretation provenance");
  return sourceRecordIds;
}

function hasCompleteAcquisitionCoordinate(
  checkpoint: SourceArtifactAcquisitionCheckpoint,
): checkpoint is SourceArtifactAcquisitionCheckpoint & {
  readonly subjectId: string;
  readonly acquisitionReference: string;
} {
  return (
    checkpoint.candidateId.length > 0 &&
    checkpoint.sourceRecordId.length > 0 &&
    checkpoint.subjectId !== undefined &&
    checkpoint.subjectId.length > 0 &&
    checkpoint.role.length > 0 &&
    checkpoint.acquisitionReference !== undefined &&
    checkpoint.acquisitionReference.length > 0 &&
    mediaTypeEssence(checkpoint.mediaType).length > 0
  );
}

export function projectManagedSourceArtifacts(
  managed: readonly ManagedSourceArtifactCheckpoint[],
  fallbackSubjectId: string,
  options?: {
    readonly freshId?: (kind: string) => string;
    readonly forceFallbackSubject?: boolean;
  },
): {
  readonly artifacts: readonly Artifact[];
  readonly locations: readonly Location[];
  readonly blobs: readonly Blob[];
  readonly revisions: readonly ArtifactRevision[];
  readonly associations: readonly ArtifactAssociation[];
} {
  const projected = managed.map((stored) => {
    const materializationKey = sha256(
      new TextEncoder().encode(
        JSON.stringify({
          candidateId: stored.candidateId,
          sourceRecordId: stored.sourceRecordId,
          subjectId: stored.subjectId,
          role: stored.role,
          acquisitionReference: stored.acquisitionReference,
          sourceArtifactProducer: stored.sourceArtifactProducer,
          acquisitionProducer: stored.acquisitionProducer,
          digest: stored.blob.digest,
          mediaType: stored.blob.mediaType,
          byteLength: stored.blob.byteLength,
          address: stored.location.address,
        }),
      ),
    );
    const artifact: Artifact = {
      id: options?.freshId?.("artifact") ?? `artifact_${materializationKey}`,
    };
    return {
      artifact,
      location: {
        id: options?.freshId?.("location") ?? `location_${materializationKey}`,
        artifactId: artifact.id,
        address: stored.location.address,
        kind: "managed" as const,
      },
      blob: stored.blob,
      revision: {
        id:
          options?.freshId?.("artifact-revision") ??
          `artifact-revision_${materializationKey}`,
        artifactId: artifact.id,
        blobDigest: stored.blob.digest,
        ...(stored.acquisitionProducer === undefined
          ? {}
          : { producer: stored.acquisitionProducer }),
      },
      association: {
        id:
          options?.freshId?.("artifact-association") ??
          `artifact-association_${materializationKey}`,
        target: {
          kind: "entity" as const,
          entityId: options?.forceFallbackSubject
            ? fallbackSubjectId
            : (stored.subjectId ?? fallbackSubjectId),
        },
        artifactId: artifact.id,
        role: stored.role,
        sourceRecordIds: [stored.sourceRecordId],
        ...(stored.sourceArtifactProducer === undefined
          ? {}
          : { producer: stored.sourceArtifactProducer }),
      },
    };
  });
  return {
    artifacts: projected.map(({ artifact }) => artifact),
    locations: projected.map(({ location }) => location),
    blobs: projected.map(({ blob }) => blob),
    revisions: projected.map(({ revision }) => revision),
    associations: projected.map(({ association }) => association),
  };
}

function assertAcquisitionCheckpoint(
  checkpoint: SourceArtifactAcquisitionCheckpoint,
  candidate: SourceArtifactCandidate,
  digest: string,
): void {
  if (
    checkpoint.candidateId !== candidate.id ||
    checkpoint.sourceRecordId !== candidate.sourceRecordId ||
    checkpoint.subjectId !== candidate.subjectId ||
    checkpoint.role !== candidate.role ||
    checkpoint.acquisitionReference !== candidate.acquisitionReference ||
    checkpoint.digest !== digest ||
    mediaTypeEssence(checkpoint.mediaType) !==
      mediaTypeEssence(candidate.mediaType)
  )
    throw new Error(
      "Managed Artifact Store returned an inconsistent acquisition checkpoint",
    );
}

function mediaTypeEssence(mediaType: string): string {
  const [essence] = mediaType.split(";", 1);
  return (essence ?? "").trim().toLowerCase();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
