import { createHash, timingSafeEqual } from "node:crypto";

import {
  ArtifactByteAccessError,
  artifactCandidateFailureIsTerminal,
  artifactProofConditionalBaseline,
  type ArtifactByteAccess,
  type ArtifactByteCleanupReporter,
  type ArtifactByteDescriptor,
  type ArtifactByteSource,
  type ArtifactContentProofCommands,
  type ArtifactContentProofMetadata,
  type ArtifactContentProofQueries,
  type ArtifactFrameProofStorePort,
  type ArtifactLocationByteSources,
  type ArtifactRevisionAccessFacts,
  type ArtifactRevisionAccessQueries,
  type AuthorizedArtifactByteLease,
  type ByteInterval,
  type ByteReadCancellation,
  type ObservedFileConfirmationFacts,
  type ObservedFileConfirmationQueries,
  type ObservedRevisionConfirmationCommands,
  ObservedRevisionConfirmationError,
  orderedArtifactByteLocations,
  safeArtifactFilename,
  type VerifiedArtifactFrameManifest,
} from "./artifact-byte-access.ts";
import {
  type ExecutionHost,
  type OperationLease,
  OperationLeaseInvalidated,
} from "./execution-host.ts";
import {
  type ConsumerPlaybackCapabilities,
  type PlaybackDeploymentCapabilities,
  type PlaybackFormatInspector,
  type PlaybackPlanResult,
  type PlaybackPreferences,
  planDirectPlayback,
} from "./playback-plan.ts";

const artifactProofFrameSize = 1_048_576;
const maximumReadBytes = 1_048_576;
const maximumPlaybackProbeReadBytes = 65_536;
const maximumPlaybackProbeTotalBytes = 262_144;
const maximumPlaybackProbeFrames = 4;

type ArtifactAccessPersistence = ArtifactRevisionAccessQueries &
  ArtifactContentProofQueries &
  ArtifactContentProofCommands &
  ObservedFileConfirmationQueries &
  ObservedRevisionConfirmationCommands;

type ResolvedSource = {
  readonly source: ArtifactByteSource;
  readonly suggestedFilename: string;
  readonly candidate: ArtifactRevisionAccessFacts["locations"][number];
  readonly observedBinding?: { release(): void };
  readonly observedAuthority?: {
    readonly registrationId: string;
    readonly registrationVersion: number;
  };
};

type RetainedObservedBinding = { binding?: { release(): void } };

/**
 * 精确修订版消费的 Application 深模块。调用方只看媒体中立接口；候选、proof、
 * confirmation、CAS、取消和租约状态机全部留在这个实现内。
 */
export class ApplicationArtifactByteAccess implements ArtifactByteAccess {
  private readonly persistence: ArtifactAccessPersistence;
  private readonly sources: ArtifactLocationByteSources;
  private readonly proofStore: ArtifactFrameProofStorePort;
  private readonly executionHost: ExecutionHost;
  private readonly cleanupReporter: ArtifactByteCleanupReporter | undefined;
  private readonly playbackInspector: PlaybackFormatInspector | undefined;
  private readonly playbackDeployment: PlaybackDeploymentCapabilities;

  constructor(input: {
    readonly persistence: ArtifactAccessPersistence;
    readonly sources: ArtifactLocationByteSources;
    readonly proofStore: ArtifactFrameProofStorePort;
    readonly executionHost: ExecutionHost;
    readonly cleanupReporter?: ArtifactByteCleanupReporter;
    readonly playbackInspector?: PlaybackFormatInspector;
    readonly playbackDeployment?: PlaybackDeploymentCapabilities;
  }) {
    this.persistence = input.persistence;
    this.sources = input.sources;
    this.proofStore = input.proofStore;
    this.executionHost = input.executionHost;
    this.cleanupReporter = input.cleanupReporter;
    this.playbackInspector = input.playbackInspector;
    this.playbackDeployment = input.playbackDeployment ?? {
      direct: { contractVersion: "direct-playback/1" },
      processors: [],
    };
  }

  async describe(selection: {
    readonly artifactRevisionId: string;
  }): Promise<ArtifactByteDescriptor> {
    const operation = this.operation();
    const finalBinding: RetainedObservedBinding = {};
    try {
      const descriptor = await this.describeWithOperation(selection, operation);
      const inspector = this.playbackInspector;
      if (!genericMediaType(descriptor.mediaType) || inspector === undefined)
        return descriptor;
      const inspected = await this.inspectFormatWithReauthorization(
        selection,
        descriptor,
        inspector,
        operation,
        finalBinding,
      );
      assertOperation(operation);
      return {
        ...inspected.descriptor,
        mediaType:
          inspected.format === undefined
            ? inspected.descriptor.mediaType
            : normalizedMediaType(inspected.format.mediaType),
      };
    } catch (error) {
      throw publicAccessError(error, operation);
    } finally {
      finalBinding.binding?.release();
      operation.release();
    }
  }

  private async describeWithOperation(
    selection: { readonly artifactRevisionId: string },
    operation: OperationLease,
    retainedBinding?: RetainedObservedBinding,
  ): Promise<ArtifactByteDescriptor> {
    let resolved: ResolvedSource | undefined;
    let sourceCloseAttempted = false;
    let sourceClosed = false;
    let bindingReleaseAttempted = false;
    let primaryError: unknown;
    try {
      const facts = await this.facts(selection.artifactRevisionId);
      await this.ensureInspectableProof(facts, operation);
      resolved = await this.resolveAccessibleCandidate(facts, operation);
      const descriptor = {
        revisionId: facts.revision.id,
        blobDigest: facts.blob.digest,
        byteLength: facts.blob.byteLength,
        mediaType: normalizedMediaType(facts.blob.mediaType),
        suggestedFilename: safeArtifactFilename(
          resolved.suggestedFilename,
          facts.revision.id,
        ),
      };
      sourceCloseAttempted = true;
      sourceClosed = await this.closeSource(
        resolved.source,
        undefined,
        operation,
      ).then(
        () => true,
        () => false,
      );
      if (sourceClosed) {
        assertOperation(operation);
        bindingReleaseAttempted = true;
        if (
          resolved.observedBinding !== undefined &&
          retainedBinding !== undefined
        )
          retainedBinding.binding = resolved.observedBinding;
        else resolved.observedBinding?.release();
        resolved = undefined;
        return descriptor;
      }
      resolved = undefined;
      assertOperation(operation);
      return descriptor;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (resolved !== undefined && !sourceCloseAttempted)
        await this.closeResolvedSource(resolved, primaryError, operation).catch(
          () => undefined,
        );
      if (resolved !== undefined && sourceClosed && !bindingReleaseAttempted) {
        bindingReleaseAttempted = true;
        resolved.observedBinding?.release();
      }
    }
  }

  async open(input: {
    readonly selection: { readonly artifactRevisionId: string };
    readonly expectedBlobDigest: string;
    readonly interval: ByteInterval;
  }): Promise<AuthorizedArtifactByteLease> {
    const operation = this.operation();
    return await this.openWithOperation(input, operation, true);
  }

  private async openWithOperation(
    input: {
      readonly selection: { readonly artifactRevisionId: string };
      readonly expectedBlobDigest: string;
      readonly interval: ByteInterval;
    },
    operation: OperationLease,
    releaseOperation: boolean,
  ): Promise<AuthorizedArtifactByteLease> {
    let manifest: VerifiedArtifactFrameManifest | undefined;
    try {
      const facts = await this.facts(input.selection.artifactRevisionId);
      if (facts.blob.digest !== input.expectedBlobDigest)
        throw new ArtifactByteAccessError("artifact-integrity-failed");
      validateInterval(input.interval, facts.blob.byteLength);
      manifest = await this.openVerifiedProof(facts, operation);
      let candidateFailure: ArtifactByteAccessError | undefined;
      for (const candidate of orderedArtifactByteLocations(facts.locations)) {
        let resolved: ResolvedSource | undefined;
        try {
          resolved = await this.openCandidate(facts, candidate, operation);
          if (resolved === undefined) continue;
          const lease = new ApplicationArtifactByteLease({
            revisionId: facts.revision.id,
            blobDigest: facts.blob.digest,
            byteLength: facts.blob.byteLength,
            mediaType: normalizedMediaType(facts.blob.mediaType),
            interval: input.interval,
            source: resolved.source,
            manifest: manifest!,
            operation,
            releaseOperation,
            ...(resolved.observedBinding === undefined
              ? {}
              : { observedBinding: resolved.observedBinding }),
            ...(this.cleanupReporter === undefined
              ? {}
              : { cleanupReporter: this.cleanupReporter }),
          });
          try {
            await lease.prepareFirstFrame();
            assertOperation(operation);
            manifest = undefined;
            return lease;
          } catch (error) {
            if (await lease.closeForCandidateFailure(error))
              manifest = undefined;
            resolved = undefined;
            if (operation.cancellation.cancelled)
              throw operationError(operation);
            if (artifactCandidateFailureIsTerminal(error)) throw error;
            candidateFailure = strongerCandidateFailure(
              candidateFailure,
              publicAccessError(error, operation),
            );
          }
        } catch (error) {
          if (resolved !== undefined)
            await this.closeResolvedSource(resolved, error).catch(
              () => undefined,
            );
          if (operation.cancellation.cancelled) throw operationError(operation);
          if (artifactCandidateFailureIsTerminal(error)) throw error;
          candidateFailure = strongerCandidateFailure(
            candidateFailure,
            publicAccessError(error, operation),
          );
        }
      }
      assertOperation(operation);
      throw (
        candidateFailure ??
        new ArtifactByteAccessError("artifact-bytes-unavailable")
      );
    } catch (error) {
      if (manifest !== undefined)
        await this.closeManifest(manifest, error).catch(() => undefined);
      if (releaseOperation) operation.release();
      throw publicAccessError(error, operation);
    }
  }

  async planPlayback(
    selection: { readonly artifactRevisionId: string },
    consumer: ConsumerPlaybackCapabilities,
    preferences: PlaybackPreferences,
  ): Promise<PlaybackPlanResult> {
    const operation = this.operation();
    const finalBinding: RetainedObservedBinding = {};
    try {
      const descriptor = await this.describeWithOperation(selection, operation);
      const inspector = this.playbackInspector;
      const inspected =
        consumer.supportsByteRanges && inspector !== undefined
          ? await this.inspectFormatWithReauthorization(
              selection,
              descriptor,
              inspector,
              operation,
              finalBinding,
            )
          : {
              descriptor: await this.describeWithOperation(
                selection,
                operation,
                finalBinding,
              ),
              format: undefined,
            };
      if (!samePlaybackArtifact(descriptor, inspected.descriptor))
        throw new ArtifactByteAccessError("artifact-integrity-failed");
      const result = planDirectPlayback({
        descriptor: inspected.descriptor,
        consumer,
        preferences,
        format: inspected.format,
        deployment: this.playbackDeployment,
      });
      assertOperation(operation);
      return result;
    } catch (error) {
      throw publicAccessError(error, operation);
    } finally {
      finalBinding.binding?.release();
      operation.release();
    }
  }

  private async inspectFormatWithReauthorization(
    selection: { readonly artifactRevisionId: string },
    descriptor: ArtifactByteDescriptor,
    inspector: PlaybackFormatInspector,
    operation: OperationLease,
    finalBinding: RetainedObservedBinding,
  ) {
    const format = await inspector.inspect({
      revisionId: descriptor.revisionId,
      blobDigest: descriptor.blobDigest,
      bytes: this.playbackProbe(descriptor, operation),
    });
    assertOperation(operation);
    const finalDescriptor = await this.describeWithOperation(
      selection,
      operation,
      finalBinding,
    );
    if (!samePlaybackArtifact(descriptor, finalDescriptor))
      throw new ArtifactByteAccessError("artifact-integrity-failed");
    assertOperation(operation);
    return { descriptor: finalDescriptor, format } as const;
  }

  private playbackProbe(
    descriptor: ArtifactByteDescriptor,
    operation: OperationLease,
  ) {
    let totalLogicalBytes = 0;
    let reading = false;
    const frames = new Map<number, Promise<Uint8Array>>();

    const loadFrame = (startInclusive: number): Promise<Uint8Array> => {
      const cached = frames.get(startInclusive);
      if (cached !== undefined) return cached;
      if (frames.size >= maximumPlaybackProbeFrames)
        throw new ArtifactByteAccessError("artifact-integrity-failed");
      const loading = (async () => {
        let lease: AuthorizedArtifactByteLease | undefined;
        try {
          lease = await this.openWithOperation(
            {
              selection: { artifactRevisionId: descriptor.revisionId },
              expectedBlobDigest: descriptor.blobDigest,
              interval: {
                startInclusive,
                endInclusive: Math.min(
                  startInclusive + artifactProofFrameSize - 1,
                  descriptor.byteLength - 1,
                ),
              },
            },
            operation,
            false,
          );
          const bytes = new Uint8Array(
            Math.min(
              artifactProofFrameSize,
              descriptor.byteLength - startInclusive,
            ),
          );
          let offset = 0;
          while (offset < bytes.byteLength) {
            const next = await lease.read({
              maximumBytes: bytes.byteLength - offset,
              cancellation: operation.cancellation,
            });
            bytes.set(next.bytes, offset);
            offset += next.bytes.byteLength;
            if (next.done) break;
          }
          if (offset !== bytes.byteLength)
            throw new ArtifactByteAccessError("artifact-integrity-failed");
          assertOperation(operation);
          return bytes;
        } finally {
          await lease?.close(
            operation.cancellation.cancelled ? "shutdown" : "completed",
          );
        }
      })();
      frames.set(startInclusive, loading);
      return loading;
    };

    return {
      read: async (interval: ByteInterval): Promise<Uint8Array> => {
        if (
          !Number.isSafeInteger(interval.startInclusive) ||
          !Number.isSafeInteger(interval.endInclusive) ||
          interval.startInclusive < 0 ||
          interval.endInclusive < interval.startInclusive
        )
          throw new ArtifactByteAccessError("artifact-integrity-failed");
        const requestedBytes =
          interval.endInclusive - interval.startInclusive + 1;
        if (
          requestedBytes > maximumPlaybackProbeReadBytes ||
          totalLogicalBytes + requestedBytes > maximumPlaybackProbeTotalBytes
        )
          throw new ArtifactByteAccessError("artifact-integrity-failed");
        if (reading) throw new ArtifactByteAccessError("byte-read-in-progress");
        totalLogicalBytes += requestedBytes;
        reading = true;
        try {
          if (
            descriptor.byteLength === 0 ||
            interval.startInclusive >= descriptor.byteLength
          )
            return new Uint8Array();
          const endInclusive = Math.min(
            interval.endInclusive,
            descriptor.byteLength - 1,
          );
          const result = new Uint8Array(
            endInclusive - interval.startInclusive + 1,
          );
          let resultOffset = 0;
          for (
            let frameStart =
              Math.floor(interval.startInclusive / artifactProofFrameSize) *
              artifactProofFrameSize;
            frameStart <= endInclusive;
            frameStart += artifactProofFrameSize
          ) {
            const frame = await loadFrame(frameStart);
            const copyStart = Math.max(interval.startInclusive, frameStart);
            const copyEnd = Math.min(
              endInclusive + 1,
              frameStart + frame.byteLength,
            );
            const slice = frame.subarray(
              copyStart - frameStart,
              copyEnd - frameStart,
            );
            result.set(slice, resultOffset);
            resultOffset += slice.byteLength;
          }
          assertOperation(operation);
          return result;
        } finally {
          reading = false;
        }
      },
    };
  }

  async observedFileSelectionForLocation(
    locationId: string,
  ): Promise<string | undefined> {
    return await this.persistence.observedFileSelectionForLocation(locationId);
  }

  async readObservedFileConfirmationFacts(selectionId: string) {
    return await this.persistence.readObservedFileConfirmationFacts(
      selectionId,
    );
  }

  async submitConfirmedObservedRevision(
    input: Parameters<
      ObservedRevisionConfirmationCommands["submitConfirmedObservedRevision"]
    >[0],
  ) {
    return await this.persistence.submitConfirmedObservedRevision(input);
  }

  async confirmObservedFileSelection(selectionId: string) {
    const operation = this.operation();
    let source: ArtifactByteSource | undefined;
    let observedBinding: { release(): void } | undefined;
    let sourceCloseAttempted = false;
    let sourceClosed = false;
    let bindingReleaseAttempted = false;
    let proofBuilt = false;
    let primaryError: unknown;
    try {
      const facts =
        await this.persistence.readObservedFileConfirmationFacts(selectionId);
      if (facts === undefined)
        throw new ObservedRevisionConfirmationError("observed-selection-stale");
      const candidate = confirmationCandidate(facts);
      const opened = await this.sources.open({
        candidate,
        blobDigest: "",
        purpose: "confirmation",
        operation,
      });
      if (opened?.observedAuthority === undefined) {
        assertOperation(operation);
        throw new ObservedRevisionConfirmationError(
          "artifact-location-revoked",
        );
      }
      source = opened.source;
      observedBinding = opened.observedBinding;
      if (source.byteLength !== facts.observation.size)
        throw new ObservedRevisionConfirmationError("artifact-bytes-changed");
      assertOperation(operation);
      const proof = await this.proofStore.build(source, operation.cancellation);
      proofBuilt = true;
      assertOperation(operation);
      const revisionId = `artifact-revision_${createHash("sha256")
        .update(`${facts.artifactId}\u0000${proof.blobDigest}`)
        .digest("hex")}`;
      const result = await this.persistence.submitConfirmedObservedRevision({
        expected: facts,
        observedAuthority: opened.observedAuthority,
        blob: {
          digest: proof.blobDigest,
          mediaType: "application/octet-stream",
          byteLength: proof.byteLength,
        },
        revision: {
          id: revisionId,
          artifactId: facts.artifactId,
          blobDigest: proof.blobDigest,
        },
        proof,
      });
      if (result === "stale")
        throw new ObservedRevisionConfirmationError("confirmation-stale");
      assertOperation(operation);
      const confirmation = { artifactRevisionId: revisionId };
      sourceCloseAttempted = true;
      sourceClosed = await this.closeSource(source, undefined, operation).then(
        () => true,
        () => false,
      );
      if (sourceClosed) {
        assertOperation(operation);
        bindingReleaseAttempted = true;
        observedBinding?.release();
        source = undefined;
        return confirmation;
      }
      source = undefined;
      assertOperation(operation);
      return confirmation;
    } catch (error) {
      let publicError: unknown;
      if (
        error instanceof ObservedRevisionConfirmationError ||
        error instanceof ArtifactByteAccessError
      )
        publicError = error;
      else if (operation.cancellation.cancelled)
        publicError = operationError(operation);
      else
        publicError = new ObservedRevisionConfirmationError(
          proofBuilt ? "confirmation-commit-failed" : "artifact-bytes-changed",
        );
      primaryError = publicError;
      throw publicError;
    } finally {
      if (source !== undefined && !sourceCloseAttempted) {
        sourceClosed = await this.closeSource(
          source,
          primaryError,
          operation,
        ).then(
          () => true,
          () => false,
        );
        if (sourceClosed) {
          bindingReleaseAttempted = true;
          observedBinding?.release();
        }
      }
      if (source !== undefined && sourceClosed && !bindingReleaseAttempted) {
        bindingReleaseAttempted = true;
        observedBinding?.release();
      }
      operation.release();
    }
  }

  private async facts(
    revisionId: string,
  ): Promise<ArtifactRevisionAccessFacts> {
    if (
      revisionId.length === 0 ||
      revisionId.length > 256 ||
      revisionId.includes("/") ||
      revisionId.includes("\\") ||
      revisionId === "." ||
      revisionId === ".."
    )
      throw new ArtifactByteAccessError("artifact-revision-not-found");
    const facts =
      await this.persistence.readArtifactRevisionAccessFacts(revisionId);
    if (facts === undefined)
      throw new ArtifactByteAccessError("artifact-revision-not-found");
    if (
      facts.revision.blobDigest !== facts.blob.digest ||
      !Number.isSafeInteger(facts.blob.byteLength) ||
      facts.blob.byteLength < 0
    )
      throw new ArtifactByteAccessError("artifact-integrity-failed");
    return facts;
  }

  private async ensureInspectableProof(
    facts: ArtifactRevisionAccessFacts,
    operation: OperationLease,
  ): Promise<ArtifactContentProofMetadata> {
    let metadata = await this.persistence.readArtifactContentProof(
      facts.blob.digest,
    );
    if (metadata !== undefined) {
      try {
        await this.proofStore.inspect(metadata, operation.cancellation);
        return metadata;
      } catch {
        if (operation.cancellation.cancelled) throw operationError(operation);
        // 引用 proof 缺失或损坏：在任何媒体字节交付前从当前候选完整重建。
      }
    }
    metadata = await this.rebuildProof(facts, operation);
    await this.proofStore.inspect(metadata, operation.cancellation);
    return metadata;
  }

  private async openVerifiedProof(
    facts: ArtifactRevisionAccessFacts,
    operation: OperationLease,
  ): Promise<VerifiedArtifactFrameManifest> {
    const metadata = await this.persistence.readArtifactContentProof(
      facts.blob.digest,
    );
    if (metadata !== undefined) {
      try {
        return await this.proofStore.open(metadata, operation.cancellation);
      } catch {
        if (operation.cancellation.cancelled) throw operationError(operation);
      }
    }
    const rebuilt = await this.rebuildProof(facts, operation);
    return await this.proofStore.open(rebuilt, operation.cancellation);
  }

  private async rebuildProof(
    facts: ArtifactRevisionAccessFacts,
    operation: OperationLease,
  ): Promise<ArtifactContentProofMetadata> {
    for (const candidate of orderedArtifactByteLocations(facts.locations)) {
      let resolved: ResolvedSource | undefined;
      let primaryError: unknown;
      try {
        resolved = await this.openCandidate(facts, candidate, operation);
        if (resolved === undefined) continue;
        assertOperation(operation);
        const proof = await this.proofStore.build(
          resolved.source,
          operation.cancellation,
          {
            blobDigest: facts.blob.digest,
            byteLength: facts.blob.byteLength,
          },
        );
        assertOperation(operation);
        const adopted = await this.persistence.adoptArtifactContentProof({
          expected: proofBaseline(facts, resolved),
          proof,
        });
        if (adopted === "stale")
          throw new ArtifactByteAccessError("artifact-integrity-failed");
        assertOperation(operation);
        return proof;
      } catch (error) {
        primaryError = error;
        if (operation.cancellation.cancelled) throw operationError(operation);
        if (artifactCandidateFailureIsTerminal(error)) throw error;
      } finally {
        if (resolved !== undefined)
          await this.closeResolvedSource(resolved, primaryError).catch(
            () => undefined,
          );
      }
    }
    assertOperation(operation);
    throw new ArtifactByteAccessError("artifact-integrity-failed");
  }

  private async resolveAccessibleCandidate(
    facts: ArtifactRevisionAccessFacts,
    operation: OperationLease,
  ): Promise<ResolvedSource> {
    for (const candidate of orderedArtifactByteLocations(facts.locations)) {
      try {
        const resolved = await this.openCandidate(facts, candidate, operation);
        if (resolved !== undefined) return resolved;
      } catch (error) {
        if (operation.cancellation.cancelled) throw operationError(operation);
        if (artifactCandidateFailureIsTerminal(error)) throw error;
      }
    }
    assertOperation(operation);
    throw new ArtifactByteAccessError("artifact-bytes-unavailable");
  }

  private async openCandidate(
    facts: ArtifactRevisionAccessFacts,
    candidate: ArtifactRevisionAccessFacts["locations"][number],
    operation: OperationLease,
  ): Promise<ResolvedSource | undefined> {
    const opened = await this.sources.open({
      candidate,
      blobDigest: facts.blob.digest,
      purpose: "access",
      operation,
    });
    if (opened === undefined) {
      assertOperation(operation);
      return undefined;
    }
    const resolved = { ...opened, candidate };
    try {
      if (opened.source.byteLength !== facts.blob.byteLength)
        throw new ArtifactByteAccessError("artifact-bytes-changed");
      assertOperation(operation);
      return resolved;
    } catch (error) {
      await this.closeResolvedSource(resolved, error).catch(() => undefined);
      if (operation.cancellation.cancelled) throw operationError(operation);
      throw error;
    }
  }

  private operation(): OperationLease {
    try {
      return this.executionHost.lease();
    } catch (error) {
      if (error instanceof OperationLeaseInvalidated)
        throw new ArtifactByteAccessError("artifact-location-revoked");
      throw new ArtifactByteAccessError("application-shutting-down");
    }
  }

  private async closeSource(
    source: ArtifactByteSource,
    primaryError?: unknown,
    cancellationOperation?: OperationLease,
  ): Promise<void> {
    try {
      await source.close();
    } catch (error) {
      const cleanupPrimary =
        primaryError ??
        (cancellationOperation?.cancellation.cancelled === true
          ? operationError(cancellationOperation)
          : undefined);
      await this.cleanupReporter?.reportCleanupFailure({
        cleanup: "media-source",
        error,
        ...(cleanupPrimary === undefined
          ? {}
          : { primaryError: cleanupPrimary }),
      });
      throw error;
    }
  }

  private async closeResolvedSource(
    resolved: ResolvedSource,
    primaryError?: unknown,
    cancellationOperation?: OperationLease,
  ): Promise<void> {
    await this.closeSource(
      resolved.source,
      primaryError,
      cancellationOperation,
    );
    resolved.observedBinding?.release();
  }

  private async closeManifest(
    manifest: VerifiedArtifactFrameManifest,
    primaryError?: unknown,
  ): Promise<void> {
    try {
      await manifest.close();
    } catch (error) {
      await this.cleanupReporter?.reportCleanupFailure({
        cleanup: "proof-manifest",
        error,
        ...(primaryError === undefined ? {} : { primaryError }),
      });
      throw error;
    }
  }
}

class ApplicationArtifactByteLease implements AuthorizedArtifactByteLease {
  readonly revisionId: string;
  readonly blobDigest: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly interval: ByteInterval;
  private readonly source: ArtifactByteSource;
  private readonly manifest: VerifiedArtifactFrameManifest;
  private readonly operation: OperationLease;
  private readonly releaseOperation: boolean;
  private readonly observedBinding: { release(): void } | undefined;
  private readonly cleanupReporter: ArtifactByteCleanupReporter | undefined;
  private cursor: number;
  private reading = false;
  private closed = false;
  private delivered = false;
  private removeOperationCancellation: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  private verifiedFrame?: {
    readonly ordinal: number;
    readonly startOffset: number;
    readonly bytes: Uint8Array;
  };

  constructor(input: {
    readonly revisionId: string;
    readonly blobDigest: string;
    readonly byteLength: number;
    readonly mediaType: string;
    readonly interval: ByteInterval;
    readonly source: ArtifactByteSource;
    readonly manifest: VerifiedArtifactFrameManifest;
    readonly operation: OperationLease;
    readonly releaseOperation: boolean;
    readonly observedBinding?: { release(): void };
    readonly cleanupReporter?: ArtifactByteCleanupReporter;
  }) {
    this.revisionId = input.revisionId;
    this.blobDigest = input.blobDigest;
    this.byteLength = input.byteLength;
    this.mediaType = input.mediaType;
    this.interval = input.interval;
    this.source = input.source;
    this.manifest = input.manifest;
    this.operation = input.operation;
    this.releaseOperation = input.releaseOperation;
    this.observedBinding = input.observedBinding;
    this.cleanupReporter = input.cleanupReporter;
    this.cursor = input.interval.startInclusive;
  }

  async prepareFirstFrame(): Promise<void> {
    if (this.byteLength !== 0)
      await this.loadFrame(
        Math.floor(this.interval.startInclusive / artifactProofFrameSize),
      );
    this.removeOperationCancellation = this.operation.cancellation.onCancel(
      () => {
        void this.closeResources(operationError(this.operation), true).catch(
          () => undefined,
        );
      },
    );
  }

  async closeForCandidateFailure(primaryError: unknown): Promise<boolean> {
    if (this.delivered) throw primaryError;
    if (this.closePromise !== undefined) {
      await this.closePromise.catch(() => undefined);
      return true;
    }
    try {
      await this.source.close();
      this.observedBinding?.release();
    } catch (error) {
      await Promise.resolve(
        this.cleanupReporter?.reportCleanupFailure({
          cleanup: "media-source",
          error,
          primaryError,
        }),
      ).catch(() => undefined);
    }
    return false;
  }

  async read(input: {
    readonly maximumBytes: number;
    readonly cancellation: ByteReadCancellation;
  }): Promise<{ readonly bytes: Uint8Array; readonly done: boolean }> {
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0)
      throw new Error("读取块上限无效");
    if (this.reading)
      throw new ArtifactByteAccessError("byte-read-in-progress");
    if (this.closed || this.operation.cancellation.cancelled)
      throw operationError(this.operation);
    if (input.cancellation.cancelled)
      throw new ArtifactByteAccessError("client-cancelled");
    this.reading = true;
    const removeCancellation = input.cancellation.onCancel(() => {
      void this.closeResources(
        new ArtifactByteAccessError("client-cancelled"),
        true,
      ).catch(() => undefined);
    });
    try {
      if (
        this.delivered &&
        this.verifiedFrame !== undefined &&
        this.cursor >= this.verifiedFrame.startOffset &&
        this.cursor <
          this.verifiedFrame.startOffset + this.verifiedFrame.bytes.byteLength
      )
        await this.assertCurrentSourceByte();
      const ordinal = Math.floor(this.cursor / artifactProofFrameSize);
      if (this.verifiedFrame?.ordinal !== ordinal)
        await this.loadFrame(ordinal);
      if (input.cancellation.cancelled)
        throw new ArtifactByteAccessError("client-cancelled");
      assertOperation(this.operation);
      const frame = this.verifiedFrame!;
      const frameOffset = this.cursor - frame.startOffset;
      const remaining = this.interval.endInclusive - this.cursor + 1;
      const bytes = frame.bytes.slice(
        frameOffset,
        frameOffset +
          Math.min(
            input.maximumBytes,
            maximumReadBytes,
            remaining,
            frame.bytes.byteLength - frameOffset,
          ),
      );
      this.cursor += bytes.byteLength;
      this.delivered ||= bytes.byteLength > 0;
      const done = this.cursor > this.interval.endInclusive;
      if (done) await this.close("completed");
      return { bytes, done };
    } catch (error) {
      const primary = input.cancellation.cancelled
        ? new ArtifactByteAccessError("client-cancelled")
        : publicAccessError(error, this.operation);
      await this.closeResources(primary, true).catch(() => undefined);
      throw primary;
    } finally {
      removeCancellation();
      this.reading = false;
    }
  }

  private async assertCurrentSourceByte(): Promise<void> {
    assertOperation(this.operation);
    try {
      const probe = await this.source.readChunk(this.cursor, 1);
      assertOperation(this.operation);
      const frame = this.verifiedFrame;
      const expected =
        frame === undefined
          ? undefined
          : frame.bytes[this.cursor - frame.startOffset];
      if (probe.bytes.byteLength !== 1 || probe.bytes[0] !== expected)
        throw new ArtifactByteAccessError("artifact-bytes-changed");
    } catch (error) {
      if (error instanceof ArtifactByteAccessError) throw error;
      if (this.operation.cancellation.cancelled)
        throw operationError(this.operation);
      throw new ArtifactByteAccessError("artifact-bytes-changed");
    }
  }

  private async loadFrame(ordinal: number): Promise<void> {
    assertOperation(this.operation);
    const startOffset = ordinal * artifactProofFrameSize;
    const frameLength = Math.min(
      artifactProofFrameSize,
      this.byteLength - startOffset,
    );
    const bytes = new Uint8Array(frameLength);
    let filled = 0;
    while (filled < frameLength) {
      assertOperation(this.operation);
      const next = await this.source.readChunk(
        startOffset + filled,
        frameLength - filled,
      );
      assertOperation(this.operation);
      if (next.bytes.byteLength === 0)
        throw new ArtifactByteAccessError("artifact-bytes-changed");
      bytes.set(next.bytes, filled);
      filled += next.bytes.byteLength;
    }
    assertOperation(this.operation);
    const expected = await this.manifest.expectedFrameDigest(
      ordinal,
      this.operation.cancellation,
    );
    assertOperation(this.operation);
    const actual = artifactFrameDigest(ordinal, startOffset, bytes);
    if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected)))
      throw new ArtifactByteAccessError("artifact-integrity-failed");
    this.verifiedFrame = { ordinal, startOffset, bytes };
  }

  close(
    _reason: "completed" | "client-cancelled" | "failed" | "shutdown",
  ): Promise<void> {
    return this.closeResources(undefined, true);
  }

  private closeResources(
    primaryError: unknown,
    releaseOperation: boolean,
  ): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.removeOperationCancellation?.();
    this.closePromise = (async () => {
      const failures: Array<{
        readonly cleanup: "media-source" | "proof-manifest";
        readonly error: unknown;
      }> = [];
      try {
        await this.manifest.close();
      } catch (error) {
        failures.push({ cleanup: "proof-manifest", error });
      }
      try {
        await this.source.close();
        this.observedBinding?.release();
      } catch (error) {
        failures.push({ cleanup: "media-source", error });
      }
      for (const failure of failures)
        await Promise.resolve(
          this.cleanupReporter?.reportCleanupFailure({
            ...failure,
            ...(primaryError === undefined ? {} : { primaryError }),
          }),
        ).catch(() => undefined);
      if (releaseOperation && this.releaseOperation) this.operation.release();
      if (primaryError === undefined && failures[0] !== undefined)
        throw failures[0].error;
    })();
    return this.closePromise;
  }
}

function samePlaybackArtifact(
  initial: ArtifactByteDescriptor,
  final: ArtifactByteDescriptor,
): boolean {
  return (
    initial.revisionId === final.revisionId &&
    initial.blobDigest === final.blobDigest &&
    initial.byteLength === final.byteLength &&
    initial.mediaType === final.mediaType
  );
}

function confirmationCandidate(
  facts: ObservedFileConfirmationFacts,
): ArtifactRevisionAccessFacts["locations"][number] {
  return {
    kind: "observed",
    locationId: facts.location.locationId,
    address: facts.location.address,
    confirmedObservation: facts.observation,
    confirmationBaseline: facts.conditionalBaseline,
  };
}

function proofBaseline(
  facts: ArtifactRevisionAccessFacts,
  resolved: ResolvedSource,
) {
  const base = {
    revisionId: facts.revision.id,
    artifactId: facts.revision.artifactId,
    blobDigest: facts.blob.digest,
    blobByteLength: facts.blob.byteLength,
    locationId: resolved.candidate.locationId,
    locationKind: resolved.candidate.kind,
    conditionalBaseline: artifactProofConditionalBaseline({
      revisionId: facts.revision.id,
      artifactId: facts.revision.artifactId,
      blobDigest: facts.blob.digest,
      blobByteLength: facts.blob.byteLength,
      locationId: resolved.candidate.locationId,
      locationKind: resolved.candidate.kind,
    }),
  } as const;
  return resolved.candidate.kind === "observed" &&
    resolved.observedAuthority !== undefined
    ? {
        ...base,
        observedAuthority: {
          ...resolved.observedAuthority,
          confirmationBaseline: resolved.candidate.confirmationBaseline,
        },
      }
    : base;
}

function validateInterval(interval: ByteInterval, byteLength: number) {
  if (
    byteLength === 0 ||
    !Number.isSafeInteger(interval.startInclusive) ||
    !Number.isSafeInteger(interval.endInclusive) ||
    interval.startInclusive < 0 ||
    interval.endInclusive < interval.startInclusive ||
    interval.endInclusive >= byteLength
  )
    throw new ArtifactByteAccessError("artifact-integrity-failed");
}

function normalizedMediaType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function genericMediaType(value: string): boolean {
  return normalizedMediaType(value) === "application/octet-stream";
}

function artifactFrameDigest(
  ordinal: number,
  startOffset: number,
  bytes: Uint8Array,
): Uint8Array {
  const coordinate = Buffer.alloc(20);
  coordinate.writeBigUInt64BE(BigInt(ordinal), 0);
  coordinate.writeBigUInt64BE(BigInt(startOffset), 8);
  coordinate.writeUInt32BE(bytes.byteLength, 16);
  return createHash("sha256")
    .update(Buffer.from("digital-artifact-frame-v1\0", "utf8"))
    .update(coordinate)
    .update(bytes)
    .digest();
}

function assertOperation(operation: OperationLease): void {
  if (operation.cancellation.cancelled) throw operationError(operation);
}

function operationError(operation: OperationLease): ArtifactByteAccessError {
  return new ArtifactByteAccessError(
    operation.cancellation.reason === "observed-root-invalidated"
      ? "artifact-location-revoked"
      : "application-shutting-down",
  );
}

function publicAccessError(
  error: unknown,
  operation: OperationLease,
): ArtifactByteAccessError {
  if (error instanceof ArtifactByteAccessError) return error;
  if (operation.cancellation.cancelled) return operationError(operation);
  return new ArtifactByteAccessError("artifact-integrity-failed");
}

function strongerCandidateFailure(
  current: ArtifactByteAccessError | undefined,
  next: ArtifactByteAccessError,
): ArtifactByteAccessError {
  const priority = (error: ArtifactByteAccessError) =>
    error.code === "artifact-integrity-failed"
      ? 2
      : error.code === "artifact-bytes-changed"
        ? 1
        : 0;
  return current === undefined || priority(next) > priority(current)
    ? next
    : current;
}
