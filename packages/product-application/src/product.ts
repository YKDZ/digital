import type {
  AssetRefreshAutomationWorkflow,
  AssetRefreshWorkflow,
  AssetLibraries,
  AutomationClock,
  AutomationHost,
  ArtifactByteAccess,
  ArtifactByteDescriptor,
  ArtifactRevisionSelection,
  AuthorizedArtifactByteLease,
  ByteInterval,
  ConsumerPlaybackCapabilities,
  ObservedFileSelectionId,
  ObservedFileConfirmationQueries,
  ExecutionHost,
  ObservedRootRegistrations,
  PlaybackPlanResult,
  PlaybackPlanning,
  PlaybackPreferences,
  InitialAssetLibraryConfigurationRestoreStatus,
} from "@digital/application";
import type { AssetInteractionState } from "@digital/domain";

export {
  ArtifactByteAccessError,
  ObservedRevisionConfirmationError,
  type ByteReadCancellation,
  type ConsumerPlaybackCapabilities,
  type PlaybackPlanResult,
  type PlaybackPreferences,
} from "@digital/application";

import type { ProductRefreshOperations } from "./refresh-operations.ts";
import type { ProductSourceConnections } from "./source-connections.ts";

export type InitialAssetLibraryOperations = {
  save(): Promise<{ readonly libraryCount: number }>;
  inspectRestoreStatus(): Promise<InitialAssetLibraryConfigurationRestoreStatus>;
  restoreForDataGeneration(): Promise<InitialAssetLibraryConfigurationRestoreStatus>;
};

/** 交付层可以使用的产品工作流；其中不包含任何持久化或来源 Adapter。 */
export type ProductAssetRefresh = AssetRefreshWorkflow &
  AssetRefreshAutomationWorkflow & {
    readonly assetLibraries: AssetLibraries;
    readonly observedRootRegistrations: ObservedRootRegistrations;
    readonly sourceConnections: ProductSourceConnections;
    close(): Promise<void>;
  };

export type ProductAutomationHost = AutomationHost & {
  close(): Promise<void>;
};

/** Web 进程共享的一组产品能力和生命周期持有者。 */
export type ProductAssetRefreshRuntime = {
  readonly workflow: ProductAssetRefresh;
  readonly executionHost: ExecutionHost;
  readonly automationHost: ProductAutomationHost;
  close(): Promise<void>;
};

export type ProductAutomationHostOptions = {
  readonly clock?: AutomationClock;
  readonly pollIntervalMilliseconds?: number;
  readonly onError?: (error: unknown) => void;
};

export type ProductManagedArtifactReference = {
  readonly digest: string;
};

/** 交付层只接收已由组合根创建的操作，不取得其资源释放权。 */
export type ProductWorkflowOperations = Pick<
  AssetRefreshWorkflow,
  | "fulfillInformation"
  | "listCurrentCataloguePage"
  | "listCurrentCatalogueIndex"
  | "inspectCurrentCatalogueSubject"
  | "inspectCurrentCatalogueEntity"
  | "inspectSubjectConflictEvidence"
  | "inspectAssetEvidence"
  | "prepareMetadataDecision"
  | "listAssetEvidence"
  | "inspectAssetSourceRecord"
  | "inspectRetryableSourceEnrichments"
  | "assetLibraryIdsOwningSubject"
  | "listCurrentAttentionPage"
  | "listWorkflowHistoryPage"
  | "inspect"
  | "inspectLocalIntake"
  | "inspectLocalContent"
  | "prepareLocalContent"
  | "confirmLocalContent"
  | "prepareObservedMaterialAssociation"
  | "inspectObservedMaterialAssociation"
  | "confirmObservedMaterialAssociation"
  | "scanAssetLibrary"
  | "inspectAssetLibraryScan"
  | "cancelAssetLibraryScan"
  | "unrecognizedLibraryScanObservations"
  | "listUnrecognizedLibraryScanObservationPage"
  | "scanObservedScope"
  | "rescrapeObservedScope"
  | "rescrapeCurrentObservedScope"
  | "directedRecognitionSourceInputObservedScope"
  | "inspectRefreshTarget"
  | "relationshipTypeDefinitions"
  | "createLocalRelatedEntity"
  | "findRelatedEntities"
  | "previewEntityIdentityMerge"
  | "applyEntityIdentityMerge"
  | "undoEntityIdentityMerge"
  | "previewRelationshipChange"
  | "applyRelationshipChange"
  | "resolveEntityMentionManually"
  | "inspectEntityMentionResolution"
  | "retractEntityMentionResolution"
  | "inspectCorrectionSubject"
  | "sourceInputRequirements"
  | "acceptsSourceInput"
  | "prepareConflictedEstablishment"
  | "prepareReplacement"
  | "prepareRetraction"
  | "prepareRecognitionRetraction"
  | "prepareRecognitionScopeAmendment"
  | "inspectArtifactRoleCovers"
  | "prepareArtifactRoleDecision"
  | "inspectSourceAssociationDecision"
  | "selectSourceAssociationCandidate"
  | "retrySourceAssociationDecision"
  | "enrichSource"
  | "retrySourceEnrichment"
  | "refreshMetadata"
  | "cancel"
  | "inspectRawSourceRecord"
  | "reviewSourceRefreshChangeSet"
  | "cancelSourceRefreshRun"
  | "inspectSourceRefreshRun"
  | "inspectChangeImpactPreview"
  | "applyChangeImpactPreview"
  | "rejectChangeImpactPreview"
  | "resume"
> &
  Pick<
    AssetRefreshAutomationWorkflow,
    | "enableAutomation"
    | "disableAutomation"
    | "listAutomationIntents"
    | "triggerAutomation"
  > &
  Pick<ProductAssetRefresh, "sourceConnections" | "assetLibraries">;

export type ProductAutomationOperations = Omit<ProductAutomationHost, "close">;

export type ProductExecutionOperations = Pick<ExecutionHost, "invoke">;

export type ArtifactDownloadDescriptor = ArtifactByteDescriptor;

/**
 * 当前产品提供给交付层的唯一目标导向入口。产品数据位置、适配器和提供方实现均被
 * 封装在此边界之后；未配置的部署仍能启动健康检查，但不能打开产品数据。
 */
export type ProductApplication = {
  readonly configured: boolean;
  readonly productDataDirectory?: string;
  readonly initialAssetLibraries?: InitialAssetLibraryOperations | undefined;
  readonly refresh: ProductRefreshOperations;
  readonly workflow: ProductWorkflowOperations;
  readonly automation: ProductAutomationOperations;
  readonly execution: ProductExecutionOperations;
  readonly interactions: {
    read(
      revisionIds: readonly string[],
    ): Promise<readonly AssetInteractionState[]>;
    save(input: AssetInteractionState): Promise<void>;
  };
  startAutomation(options?: ProductAutomationHostOptions): Promise<void>;
  managedArtifactReference(
    address: string,
  ): ProductManagedArtifactReference | undefined;
  readManagedArtifact(digest: string): Promise<Uint8Array>;
  prepareArtifactDownload(
    selection: ArtifactRevisionSelection,
  ): Promise<ArtifactDownloadDescriptor>;
  openArtifactBytes(input: {
    readonly selection: ArtifactRevisionSelection;
    readonly expectedBlobDigest: string;
    readonly interval: ByteInterval;
  }): Promise<AuthorizedArtifactByteLease>;
  planPlayback(
    selection: ArtifactRevisionSelection,
    consumer: ConsumerPlaybackCapabilities,
    preferences: PlaybackPreferences,
  ): Promise<PlaybackPlanResult>;
  observedFileSelectionForLocation(
    locationId: string,
  ): Promise<ObservedFileSelectionId | undefined>;
  observedFileDownloadForLocation(locationId: string): Promise<
    | {
        readonly selectionId: ObservedFileSelectionId;
        readonly byteLength: number;
      }
    | undefined
  >;
  confirmObservedFileRevision(input: {
    readonly observedFileSelectionId: ObservedFileSelectionId;
    readonly assetLibraryId?: string;
  }): Promise<{ readonly artifactRevisionId: string }>;
};

export function artifactDownloadOperations(
  bytes: ArtifactByteAccess & PlaybackPlanning,
  confirmation: ObservedFileConfirmationQueries & {
    confirmObservedFileSelection(
      selectionId: ObservedFileSelectionId,
      assetLibraryId?: string,
    ): Promise<{
      readonly artifactRevisionId: string;
    }>;
  },
): Pick<
  ProductApplication,
  | "prepareArtifactDownload"
  | "openArtifactBytes"
  | "planPlayback"
  | "observedFileSelectionForLocation"
  | "observedFileDownloadForLocation"
  | "confirmObservedFileRevision"
> {
  return {
    async prepareArtifactDownload(selection) {
      return await bytes.describe(selection);
    },
    async openArtifactBytes(input) {
      return await bytes.open(input);
    },
    async planPlayback(selection, consumer, preferences) {
      return await bytes.planPlayback(selection, consumer, preferences);
    },
    observedFileSelectionForLocation: async (locationId) =>
      await confirmation.observedFileSelectionForLocation(locationId),
    async observedFileDownloadForLocation(locationId) {
      const selectionId =
        await confirmation.observedFileSelectionForLocation(locationId);
      if (selectionId === undefined) return undefined;
      const facts =
        await confirmation.readObservedFileConfirmationFacts(selectionId);
      return facts === undefined
        ? undefined
        : { selectionId, byteLength: facts.observation.size };
    },
    async confirmObservedFileRevision(input) {
      return await confirmation.confirmObservedFileSelection(
        input.observedFileSelectionId,
        input.assetLibraryId,
      );
    },
  };
}

/** 可执行根通过这个单一生命周期协议把产品交给一种交付方式。 */
export type ProductDelivery<Result> = {
  start(application: ProductApplication): Result;
};
