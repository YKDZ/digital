import path from "node:path";

import {
  type ArtifactByteCleanupReporter,
  type ArtifactLocationByteSources,
  type ArtifactRevisionAccessFacts,
  type ObservedRootRegistration,
  type ObservedRootRegistrations,
  type OperationLease,
  ObservedRevisionConfirmationError,
} from "@digital/application";
import { ContentAddressedManagedArtifactStore } from "@digital/filesystem";

/** 组合层选择的具体位置适配器；候选顺序、回退和错误归并仍由 Application 拥有。 */
export class ComposedArtifactLocationByteSources implements ArtifactLocationByteSources {
  private readonly observedRoots: ObservedRootRegistrations;
  private readonly managedStore: ContentAddressedManagedArtifactStore;

  constructor(
    observedRoots: ObservedRootRegistrations,
    managedStore: ContentAddressedManagedArtifactStore,
  ) {
    this.observedRoots = observedRoots;
    this.managedStore = managedStore;
  }

  async open(input: {
    readonly candidate: ArtifactRevisionAccessFacts["locations"][number];
    readonly blobDigest: string;
    readonly purpose: "confirmation" | "access";
    readonly operation: OperationLease;
  }) {
    if (input.candidate.kind === "managed") {
      const reference = this.managedStore.reference(input.candidate.address);
      if (reference?.digest !== input.blobDigest) return undefined;
      const source = await this.managedStore.openByteSource(reference.digest);
      if (input.operation.cancellation.cancelled) {
        await source.close();
        return undefined;
      }
      return {
        source,
        suggestedFilename: path.basename(input.candidate.address),
      };
    }

    const root = await this.observedRootFor(input.candidate.address);
    if (root === undefined) return undefined;
    const relativePath = path.relative(
      root.containerPath,
      input.candidate.address,
    );
    const source = await this.observedRoots.openActiveByteSource({
      registrationId: root.id,
      relativePath,
    });
    try {
      if (
        input.purpose === "confirmation" &&
        (source.byteLength !== input.candidate.confirmedObservation.size ||
          source.modifiedAt !== input.candidate.confirmedObservation.modifiedAt)
      ) {
        throw new ObservedRevisionConfirmationError("artifact-bytes-changed");
      }
      const observedBinding = input.operation.bindObservedRoot({
        registrationId: root.id,
        registrationVersion: root.configVersion,
      });
      return {
        source,
        suggestedFilename: path.basename(input.candidate.address),
        observedBinding,
        observedAuthority: {
          registrationId: root.id,
          registrationVersion: root.configVersion,
        },
      };
    } catch (error) {
      await source.close().catch(() => undefined);
      throw error;
    }
  }

  private async observedRootFor(
    address: string,
  ): Promise<ObservedRootRegistration | undefined> {
    const matches = (await this.observedRoots.list())
      .filter((root) => root.status === "active")
      .filter((root) => {
        const relative = path.relative(root.containerPath, address);
        return (
          relative.length > 0 &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      })
      .sort(
        (left, right) => right.containerPath.length - left.containerPath.length,
      );
    if (
      matches.length > 1 &&
      matches[0]!.containerPath.length === matches[1]!.containerPath.length
    )
      return undefined;
    return matches[0];
  }
}

/** 将字节模块清理失败接入既有 observed-root reporter/fallback 链。 */
export class ComposedArtifactByteCleanupReporter implements ArtifactByteCleanupReporter {
  private readonly observedRoots: ObservedRootRegistrations;

  constructor(observedRoots: ObservedRootRegistrations) {
    this.observedRoots = observedRoots;
  }

  async reportCleanupFailure(input: {
    readonly cleanup: "media-source" | "proof-manifest";
    readonly error: unknown;
    readonly primaryError?: unknown;
  }): Promise<void> {
    await this.observedRoots.reportCleanupFailure({
      operation: "artifact-byte-access",
      cleanup: input.cleanup,
      rootId: "artifact-byte-access",
      relativeScope: "",
      error: input.error,
      ...(input.primaryError === undefined
        ? {}
        : { primaryError: input.primaryError }),
    });
  }
}
