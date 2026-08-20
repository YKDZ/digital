import path from "node:path";

import {
  AssetRefreshAutomation,
  type AssetRefreshAutomationWorkflow,
  AssetRefreshWorkflow,
  AutomationHost,
  ExecutionHost,
  ObservedRootRegistrations,
  applicationOwnedCapabilityDeclarations,
  attachAssetRefreshAutomation,
  type AutomationClock,
  type AutomationInformationRequirementResolver,
  type CapabilityDeclaration,
  type DeclaredCapability,
  type DueAutomationRunner,
  type InformationRequirement,
  type MetadataPolicyConfiguration,
  type ObservedRootCleanupFailure,
  type ObservedRootCleanupFailureReporter,
  type RecognitionPolicy,
  type WorkflowConfigurationCompatibility,
} from "@digital/application";
import {
  BangumiArtifactAcquirer,
  BangumiCollector,
  BangumiEpisodicDirectoryInterpreter,
  BangumiEpisodicRecognizer,
  BangumiSourceInterpreter,
  trustedBangumiEpisodicRule,
} from "@digital/bangumi";
import {
  DlsiteArtifactAcquirer,
  DlsiteCollector,
  DlsiteExactDirectoryInterpreter,
  DlsiteExactRecognizer,
  DlsiteSourceInterpreter,
  dlsiteInformationFulfillmentCapabilities,
  trustedDlsiteExactRule,
} from "@digital/dlsite";
import type { AcceptedRecognition } from "@digital/domain";
import {
  EpubEmbeddedCoverAcquirer,
  EpubPublicationInspector,
} from "@digital/epub";
import {
  FanboxArtifactAcquirer,
  FanboxCollector,
  FanboxDateDirectoryInterpreter,
  FanboxExactRecognizer,
  FanboxSourceInterpreter,
  trustedFanboxCreatorDateRule,
} from "@digital/fanbox";
import {
  BdmvFilesystemPackageInterpreter,
  ContentAddressedManagedArtifactStore,
  ReadOnlyFilesystemObserver,
} from "@digital/filesystem";
import {
  NbinetCollector,
  NbinetExactIsbnRecognizer,
  NbinetSourceInterpreter,
  trustedNbinetExactEpubIsbnRule,
} from "@digital/nbinet";
import {
  OmdbArtifactAcquirer,
  OmdbCollector,
  OmdbSourceAssociationCandidateInterpreter,
  OmdbSourceAssociationInterpreter,
  OmdbSourceInterpreter,
} from "@digital/omdb";
import {
  ProductDataOperations,
  createOfflineProductDataBackup,
  restoreOfflineProductDataBackup,
  type ProductDataWriterLifecycle,
} from "@digital/product-data";
import { SqliteCatalogue } from "@digital/sqlite";
import {
  TmdbArtifactAcquirer,
  TmdbCollector,
  TmdbSourceInterpreter,
  TmdbStrictFilmDirectoryInterpreter,
  TmdbStrictFilmRecognizer,
  trustedTmdbDirectedFilmRule,
  trustedTmdbStrictFilmRule,
} from "@digital/tmdb";

import {
  InProcessObservedRootCleanupEmergencyJournal,
  type ObservedRootCleanupEmergencyJournal,
} from "./observed-root-cleanup-journal.js";
import { ProductSourceConnections } from "./source-connections.js";

export {
  InProcessObservedRootCleanupEmergencyJournal,
  observedRootCleanupEmergencyJournalCapacity,
} from "./observed-root-cleanup-journal.js";
export type {
  ObservedRootCleanupEmergencyIncident,
  ObservedRootCleanupEmergencyJournal,
  ObservedRootCleanupEmergencyJournalSnapshot,
} from "./observed-root-cleanup-journal.js";
export {
  OmdbSourceConnection,
  ProductSourceConnections,
  TmdbSourceConnection,
} from "./source-connections.js";
export { createOfflineProductDataBackup, restoreOfflineProductDataBackup };
export { ProductBangumiSourceConnection } from "./bangumi-source-connection.js";
export type { BangumiAuthorizationStart } from "./bangumi-source-connection.js";
export type {
  SourceConnectionAvailability,
  SourceConnectionCredentialStatus,
  SourceConnectionInspection,
} from "./source-connections.js";

/**
 * Composition chooses the concrete audit sink for Application-owned cleanup
 * incidents. The record retains registration coordinates, never an adapter
 * scope or a filesystem path another layer could reopen.
 */
class StderrObservedRootCleanupFailureReporter implements ObservedRootCleanupFailureReporter {
  reportCleanupFailure(input: ObservedRootCleanupFailure): void {
    process.stderr.write(
      `${JSON.stringify({
        event: "observed-root-cleanup-failure",
        operation: input.operation,
        cleanup: input.cleanup,
        rootId: input.rootId,
        relativeScope: input.relativeScope,
        error: describeCleanupError(input.error),
        ...(input.primaryError === undefined
          ? {}
          : { primaryError: describeCleanupError(input.primaryError) }),
      })}\n`,
    );
  }
}

function describeCleanupError(error: unknown): string {
  if (error === null) return "null";
  if (error instanceof Error) return "error";
  return typeof error;
}

/** Product policy is assembled here; integrations can never grant themselves trust. */
class CuratedInitialRecognitionPolicy implements RecognitionPolicy {
  readonly version = "curated-initial-sources/3";
  readonly trustedRuleCoordinates = [
    trustedDlsiteExactRule,
    trustedFanboxCreatorDateRule,
    trustedBangumiEpisodicRule,
    trustedNbinetExactEpubIsbnRule,
    trustedTmdbStrictFilmRule,
    trustedTmdbDirectedFilmRule,
  ].map(
    (rule) =>
      `${rule.capabilityId}@${rule.capabilityVersion}/${rule.ruleId}@${rule.ruleVersion}`,
  );
  accepts(result: Parameters<RecognitionPolicy["accepts"]>[0]): boolean {
    return [
      trustedDlsiteExactRule,
      trustedFanboxCreatorDateRule,
      trustedBangumiEpisodicRule,
      trustedNbinetExactEpubIsbnRule,
      trustedTmdbStrictFilmRule,
      trustedTmdbDirectedFilmRule,
    ].some(
      (rule) =>
        result.capabilityId === rule.capabilityId &&
        result.capabilityVersion === rule.capabilityVersion &&
        result.ruleId === rule.ruleId &&
        result.ruleVersion === rule.ruleVersion,
    );
  }
}

/** The allow-list is product policy, never a capability declaration. */
export function curatedInitialRecognitionPolicy(): RecognitionPolicy & {
  readonly version: string;
} {
  return new CuratedInitialRecognitionPolicy();
}

const ordinaryFilmMetadataPolicyId = "ordinary-film-metadata";

/**
 * Reject an invalid static assembly before it can create process resources.
 * Concrete capability instances are registered below; this function remains
 * deliberately unaware of provider names and of any closed kind catalogue.
 */
export function validateCapabilityDeclarations(
  declarations: readonly Partial<DeclaredCapability>[],
): readonly CapabilityDeclaration[] {
  const identities = new Set<string>();
  return declarations.map((declaration) => {
    if (!nonEmpty(declaration.identity))
      throw new Error("Capability declaration requires a stable identity");
    if (!nonEmpty(declaration.implementationVersion))
      throw new Error(
        `Capability declaration ${declaration.identity} requires an implementation version`,
      );
    if (!nonEmpty(declaration.kind))
      throw new Error(
        `Capability declaration ${declaration.identity} requires a capability kind`,
      );
    if (!Array.isArray(declaration.interpretationContractVersions))
      throw new Error(
        `Capability declaration ${declaration.identity} requires interpretation contract versions`,
      );
    if (identities.has(declaration.identity))
      throw new Error(
        `Capability declaration has duplicate stable identity ${declaration.identity}`,
      );
    const contractVersions = new Set<string>();
    for (const version of declaration.interpretationContractVersions) {
      if (!nonEmpty(version) || contractVersions.has(version))
        throw new Error(
          `Capability declaration ${declaration.identity} has invalid interpretation contract versions`,
        );
      contractVersions.add(version);
    }
    if (
      declaration.capabilityId !== undefined &&
      declaration.capabilityId !== declaration.identity
    ) {
      throw new Error(
        `Capability declaration ${declaration.identity} has an incompatible stable identity coordinate`,
      );
    }
    if (
      declaration.capabilityVersion !== undefined &&
      declaration.capabilityVersion !== declaration.implementationVersion
    ) {
      throw new Error(
        `Capability declaration ${declaration.identity} has an incompatible implementation version coordinate`,
      );
    }
    if (!nonEmpty(declaration.contractVersion)) {
      throw new Error(
        `Capability declaration ${declaration.identity} requires a selected interpretation contract`,
      );
    }
    if (!contractVersions.has(declaration.contractVersion)) {
      throw new Error(
        `Capability declaration ${declaration.identity} has an incompatible interpretation contract`,
      );
    }
    identities.add(declaration.identity);
    return {
      identity: declaration.identity,
      implementationVersion: declaration.implementationVersion,
      kind: declaration.kind,
      interpretationContractVersions:
        declaration.interpretationContractVersions,
    };
  });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Product policy lives at the assembly boundary. The Application receives
 * only generic rules and durable opaque enrollment identifiers.
 */
class CuratedMetadataPolicyConfiguration implements MetadataPolicyConfiguration {
  readonly version = "curated-metadata/2";
  readonly policies = [
    {
      id: ordinaryFilmMetadataPolicyId,
      metadataUsageContext: "asset.ordinary",
      rules: [
        ...[
          "asset.title",
          "asset.title.original",
          "asset.introduction",
          "asset.release-date",
          "asset.runtime-minutes",
          "external.imdb-id",
        ].map((property) => ({
          property,
          preferredSourceIdentities: ["tmdb", "omdb"],
          cardinality: "one" as const,
        })),
        {
          property: "asset.title.alternative",
          preferredSourceIdentities: ["tmdb", "omdb"],
          cardinality: "many" as const,
        },
        {
          property: "asset.genre",
          preferredSourceIdentities: ["tmdb", "omdb"],
          cardinality: "many" as const,
        },
        ...["asset.awards", "asset.box-office"].map((property) => ({
          property,
          preferredSourceIdentities: ["omdb"],
          cardinality: "one" as const,
        })),
        {
          property: "rating.*",
          preferredSourceIdentities: ["omdb"],
          cardinality: "many" as const,
        },
      ],
    },
  ];

  enroll(accepted: AcceptedRecognition): readonly string[] {
    const acceptedTmdbFilmRule =
      accepted.recognitionDecision.acceptedRuleResults.some((result) =>
        [trustedTmdbStrictFilmRule, trustedTmdbDirectedFilmRule].some(
          (trusted) =>
            result.outcome === "satisfied" &&
            result.capabilityId === trusted.capabilityId &&
            result.capabilityVersion === trusted.capabilityVersion &&
            result.ruleId === trusted.ruleId &&
            result.ruleVersion === trusted.ruleVersion,
        ),
      );
    return acceptedTmdbFilmRule ? [ordinaryFilmMetadataPolicyId] : [];
  }
}

/**
 * Composition owns the concrete configuration registry. It derives its
 * entries from the current composed policy/configuration versions, never from
 * an execution's frozen references, so a stale execution cannot validate
 * itself by echoing its own historical input.
 */
class RegisteredWorkflowConfigurationCompatibility implements WorkflowConfigurationCompatibility {
  private readonly registered: ReadonlySet<string>;
  private readonly sourceConnections:
    | Pick<ProductSourceConnections, "isConfigurationReferenceCurrent">
    | undefined;

  constructor(
    references: readonly string[],
    sourceConnections?: Pick<
      ProductSourceConnections,
      "isConfigurationReferenceCurrent"
    >,
  ) {
    this.registered = new Set(references);
    this.sourceConnections = sourceConnections;
  }

  async checkCompatibility(input: {
    readonly references: readonly string[];
  }): Promise<
    | { readonly compatible: true }
    | { readonly compatible: false; readonly reason: string }
  > {
    return input.references.every(
      (reference) =>
        this.registered.has(reference) ||
        this.sourceConnections?.isConfigurationReferenceCurrent(reference) ===
          true,
    )
      ? { compatible: true }
      : {
          compatible: false,
          reason: "冻结配置引用当前不可用或版本已变更",
        };
  }
}

export type ComposedAssetRefresh = AssetRefreshWorkflow &
  AssetRefreshAutomationWorkflow & {
    /** Every production composition owns the registered-root authority. */
    readonly observedRootRegistrations: ObservedRootRegistrations;
    /** Process-local fallback evidence when the ordinary cleanup audit fails. */
    readonly observedRootCleanupEmergencyJournal: ObservedRootCleanupEmergencyJournal;
    /** Product-managed private access for currently deployed film sources. */
    readonly sourceConnections: ProductSourceConnections;
    /** Drains Application work, then releases infrastructure exactly once. */
    close(): Promise<void>;
  };

export type ComposedAutomationHost = AutomationHost & {
  /**
   * Stops polling and releases the resources it owns exactly once. A failed
   * active poll remains observable after release rather than becoming a
   * graceful shutdown result.
   */
  close(): Promise<void>;
};

/**
 * One production process composition. Delivery and its owned Automation Host
 * receive the same Application Workflow instance, so Information Fulfillment
 * memoization and durable work serialization are shared across both triggers.
 */
export type ComposedAssetRefreshRuntime = {
  readonly workflow: ComposedAssetRefresh;
  readonly executionHost: ExecutionHost;
  readonly automationHost: ComposedAutomationHost;
  /** Releases the owned host first, then the one workflow/persistence owner. */
  close(): Promise<void>;
};

export type AssetRefreshRuntimeOptions = {
  readonly clock?: AutomationClock;
  readonly pollIntervalMilliseconds?: number;
  readonly onError?: (error: unknown) => void;
  readonly configuration?: Readonly<Record<string, string | undefined>>;
  /**
   * Delivery-owned dispatch rebuilt after each accepted subject. The callback
   * returns only Application's neutral Information Requirement contract.
   */
  readonly automationInformationRequirementForAcceptedSubject?: AutomationInformationRequirementResolver;
  /** @deprecated Prefer per-accepted-subject resolver for new composition. */
  readonly automationInformationRequirement?: InformationRequirement;
};

/** Delivery 可用的维护准入 seam，不暴露持久化实现。 */
export async function assertProductDataOffline(
  productDataDirectory: string,
): Promise<void> {
  await ProductDataOperations.forRoot(productDataDirectory).assertOffline();
}

/**
 * Delivery may supply a per-accepted-subject neutral resolver without making
 * composition depend on a View or persisting expanded demand on an Automation
 * Intent. The static option remains for legacy callers only.
 */
export type AssetRefreshCompositionOptions = {
  readonly automationInformationRequirementForAcceptedSubject?: AutomationInformationRequirementResolver;
  /** @deprecated Prefer per-accepted-subject resolver for new composition. */
  readonly automationInformationRequirement?: InformationRequirement;
  /** Runtime-owned supervisor shared by Delivery and Automation children. */
  readonly invocationSupervisor?: Pick<ExecutionHost, "invoke">;
};

export function composeAssetRefresh(
  productDataDirectory: string,
  configuration: Readonly<Record<string, string | undefined>> = process.env,
  options: AssetRefreshCompositionOptions = {},
): ComposedAssetRefresh {
  return composeAssetRefreshWithGeneration(
    productDataDirectory,
    configuration,
    options,
    ProductDataOperations.forRoot(productDataDirectory).startWriter(),
  );
}

/** 仅供本文件的运行时组装复用；不构成可注入的公开 seam。 */
function composeAssetRefreshWithGeneration(
  productDataDirectory: string,
  configuration: Readonly<Record<string, string | undefined>>,
  options: AssetRefreshCompositionOptions,
  productWriterLease: ProductDataWriterLifecycle,
): ComposedAssetRefresh {
  try {
    const ownedInvocationSupervisor =
      options.invocationSupervisor === undefined
        ? new ExecutionHost()
        : undefined;
    const invocationSupervisor =
      options.invocationSupervisor ?? ownedInvocationSupervisor!;
    const managedDirectory = path.join(
      productDataDirectory,
      "managed-artifacts",
    );
    const sourceConnections = new ProductSourceConnections(
      productDataDirectory,
      configuration,
    );
    const fanbox = fanboxCapabilitiesFromProductConnections(sourceConnections);
    const bangumi =
      bangumiCapabilitiesFromProductConnections(sourceConnections);
    const tmdb = tmdbCapabilitiesFromPrivateConfiguration(sourceConnections);
    const omdb = omdbCapabilitiesFromPrivateConfiguration(sourceConnections);
    const directoryInterpreters = [
      new DlsiteExactDirectoryInterpreter(),
      new BangumiEpisodicDirectoryInterpreter(),
      new TmdbStrictFilmDirectoryInterpreter(),
      ...fanbox.directoryInterpreters,
    ];
    const filesystemPackageInterpreters = [
      new BdmvFilesystemPackageInterpreter(),
    ];
    const formatInspectors = [new EpubPublicationInspector()];
    const collectors = [
      new DlsiteCollector(),
      bangumi.collector,
      new NbinetCollector(),
      tmdb.collector,
      omdb.collector,
      ...fanbox.collectors,
    ];
    const sourceInterpreters = [
      new DlsiteSourceInterpreter(),
      new BangumiSourceInterpreter(),
      new NbinetSourceInterpreter(),
      new TmdbSourceInterpreter(),
      omdb.interpreter,
      ...fanbox.sourceInterpreters,
    ];
    const sourceAssociationCandidateInterpreters = [
      omdb.sourceAssociationCandidateInterpreter,
    ];
    const sourceAssociationInterpreters = [omdb.sourceAssociationInterpreter];
    const recognizers = [
      new DlsiteExactRecognizer(),
      new BangumiEpisodicRecognizer(),
      new NbinetExactIsbnRecognizer(),
      new TmdbStrictFilmRecognizer(),
      ...fanbox.recognizers,
    ];
    const acquirers = [
      new DlsiteArtifactAcquirer(),
      new BangumiArtifactAcquirer(),
      new TmdbArtifactAcquirer(),
      new OmdbArtifactAcquirer(),
      ...fanbox.acquirers,
    ];
    const observedArtifactPartAcquirers = [new EpubEmbeddedCoverAcquirer()];
    const filesystem = new ReadOnlyFilesystemObserver();
    const persistence = SqliteCatalogue.forProductData(productDataDirectory);
    const recognitionPolicy = curatedInitialRecognitionPolicy();
    const metadataPolicyConfiguration =
      new CuratedMetadataPolicyConfiguration();
    const configurationCompatibility =
      new RegisteredWorkflowConfigurationCompatibility(
        [
          // Automation's default policy reference is the current policy object.
          recognitionPolicy.version,
          // Filesystem executions retain this explicit planning-input reference.
          `recognition-policy/${recognitionPolicy.version}`,
          // This is a separately versioned composed configuration, not an
          // execution-derived echo of opaque references.
          `metadata-policy/${metadataPolicyConfiguration.version}`,
        ],
        sourceConnections,
      );
    const observedRootCleanupReporter =
      new StderrObservedRootCleanupFailureReporter();
    const observedRootCleanupEmergencyJournal =
      new InProcessObservedRootCleanupEmergencyJournal();
    const observedRootRegistrations = new ObservedRootRegistrations({
      commands: persistence,
      queries: persistence,
      filesystem,
      productDataDirectory,
      managedArtifactDirectory: managedDirectory,
      cleanupFailureReporter: observedRootCleanupReporter,
      cleanupFailureFallback: observedRootCleanupEmergencyJournal,
    });
    validateCapabilityDeclarations([
      ...applicationOwnedCapabilityDeclarations,
      observedRootRegistrations.capability,
      ...directoryInterpreters.map(({ capability }) => capability),
      ...filesystemPackageInterpreters.map(({ capability }) => capability),
      ...formatInspectors.map(({ capability }) => capability),
      ...collectors.map(({ capability }) => capability),
      ...sourceInterpreters.map(({ capability }) => capability),
      ...sourceAssociationCandidateInterpreters.map(
        ({ capability }) => capability,
      ),
      ...sourceAssociationInterpreters.map(({ capability }) => capability),
      ...recognizers.map(({ capability }) => capability),
      ...acquirers.map(({ capability }) => capability),
      ...observedArtifactPartAcquirers.map(({ capability }) => capability),
      ...sourceConnections.capabilityDeclarations,
    ]);
    const workflow = new AssetRefreshWorkflow({
      observedRootRegistrations,
      directoryInterpreters,
      filesystemPackageInterpreters,
      formatInspectors,
      collectors,
      sourceInterpreters,
      sourceAssociationCandidateInterpreters,
      sourceAssociationInterpreters,
      sourceConnectionExecutionConfiguration: sourceConnections,
      metadataPolicyConfiguration,
      configurationCompatibility,
      recognizers,
      recognitionPolicy,
      acquirers,
      observedArtifactPartAcquirers,
      managedStore: new ContentAddressedManagedArtifactStore(managedDirectory),
      executionCommands: persistence,
      executionQueries: persistence,
      recoveryLease: persistence,
      reuseQueries: persistence,
      currentCatalogueQueries: persistence,
      workflowHistoryQueries: persistence,
      currentAttentionQueries: persistence,
      recognitionAcceptance: persistence,
      recognitionReevaluation: persistence,
      recognitionChangeImpact: persistence,
      metadataRefreshPersistence: persistence,
      informationSubjectFactsQueries: persistence,
      currentSourceArtifactQueries: persistence,
      managedSourceArtifactPersistence: persistence,
      sourceRefreshRuns: persistence,
      recoverySourceRefreshRuns: persistence,
      sourceEnrichmentPersistence: persistence,
      changeImpactQueries: persistence,
      changeImpactCommands: persistence,
      informationFulfillmentCapabilities:
        dlsiteInformationFulfillmentCapabilities,
      invocationSupervisor,
    });
    const automated = attachAssetRefreshAutomation(
      workflow,
      new AssetRefreshAutomation(workflow, {
        executionQueries: persistence,
        automationQueries: persistence,
        automationCommands: persistence,
        observedRootRegistrations,
        recognitionPolicyVersion: recognitionPolicy.version,
        ...(options.automationInformationRequirementForAcceptedSubject ===
        undefined
          ? {}
          : {
              informationRequirementForAcceptedSubject:
                options.automationInformationRequirementForAcceptedSubject,
            }),
        ...(options.automationInformationRequirement === undefined
          ? {}
          : {
              informationRequirement: options.automationInformationRequirement,
            }),
      }),
    );
    return composeOwnedAssetRefresh(
      Object.assign(automated, {
        observedRootRegistrations,
        observedRootCleanupEmergencyJournal,
        sourceConnections,
      }),
      persistence,
      ownedInvocationSupervisor,
      productWriterLease,
    );
  } catch (error) {
    productWriterLease.close();
    throw error;
  }
}

/**
 * Applies the one close order for a composed workflow without exposing the
 * persistence implementation to Application. It is also the narrow seam for
 * composition-level lifecycle tests with an instance-local owner.
 */
export function composeOwnedAssetRefresh<
  Workflow extends { close(): Promise<void> },
>(
  workflow: Workflow,
  persistence: { readonly close: () => void },
  ownedInvocationSupervisor?: Pick<ExecutionHost, "close">,
  productWriterLease?: ProductDataWriterLifecycle,
): Workflow & { close(): Promise<void> } {
  const drainWorkflow = workflow.close.bind(workflow);
  let closing: Promise<void> | undefined;
  return Object.assign(workflow, {
    close() {
      closing ??= releaseOwnedResources([
        ...(ownedInvocationSupervisor === undefined
          ? []
          : [() => ownedInvocationSupervisor.close()]),
        drainWorkflow,
        () => persistence.close(),
        ...(productWriterLease === undefined
          ? []
          : [() => productWriterLease.close()]),
      ]);
      return closing;
    },
  });
}

/**
 * The production composition root. It deliberately owns exactly one workflow
 * and passes that object to both Delivery and Automation Host composition.
 */
export function composeAssetRefreshRuntime(
  productDataDirectory: string,
  options: AssetRefreshRuntimeOptions = {},
): ComposedAssetRefreshRuntime {
  const runtimeLock =
    ProductDataOperations.forRoot(productDataDirectory).startWriter();
  try {
    const executionHost = new ExecutionHost();
    const workflow = composeAssetRefreshWithGeneration(
      productDataDirectory,
      options.configuration ?? process.env,
      {
        ...(options.automationInformationRequirementForAcceptedSubject ===
        undefined
          ? {}
          : {
              automationInformationRequirementForAcceptedSubject:
                options.automationInformationRequirementForAcceptedSubject,
            }),
        ...(options.automationInformationRequirement === undefined
          ? {}
          : {
              automationInformationRequirement:
                options.automationInformationRequirement,
            }),
        invocationSupervisor: executionHost,
      },
      runtimeLock,
    );
    const automationHost = composeAutomationHostForWorkflow(workflow, {
      ...options,
      executionHost,
    });
    let closing: Promise<void> | undefined;
    return {
      workflow,
      executionHost,
      automationHost,
      close() {
        automationHost.stop();
        closing ??= releaseOwnedResources([
          () => executionHost.close(),
          () => automationHost.settled(),
          () => workflow.close(),
          () => runtimeLock.close(),
        ]);
        return closing;
      },
    };
  } catch (error) {
    runtimeLock.close();
    throw error;
  }
}

function tmdbCapabilitiesFromPrivateConfiguration(
  sourceConnections: ProductSourceConnections,
): { readonly collector: TmdbCollector } {
  return {
    collector: sourceConnections.tmdbCollector(),
  };
}

function omdbCapabilitiesFromPrivateConfiguration(
  sourceConnections: ProductSourceConnections,
): {
  readonly sourceAssociationCandidateInterpreter: OmdbSourceAssociationCandidateInterpreter;
  readonly sourceAssociationInterpreter: OmdbSourceAssociationInterpreter;
  readonly collector: OmdbCollector;
  readonly interpreter: OmdbSourceInterpreter;
} {
  return {
    sourceAssociationCandidateInterpreter:
      new OmdbSourceAssociationCandidateInterpreter(),
    sourceAssociationInterpreter: new OmdbSourceAssociationInterpreter(),
    collector: sourceConnections.omdbCollector(),
    interpreter: new OmdbSourceInterpreter(),
  };
}

function bangumiCapabilitiesFromProductConnections(
  sourceConnections: ProductSourceConnections,
): { readonly collector: BangumiCollector } {
  return { collector: sourceConnections.bangumiCollector() };
}

function fanboxCapabilitiesFromProductConnections(
  sourceConnections: ProductSourceConnections,
): {
  readonly directoryInterpreters: readonly FanboxDateDirectoryInterpreter[];
  readonly collectors: readonly FanboxCollector[];
  readonly sourceInterpreters: readonly FanboxSourceInterpreter[];
  readonly recognizers: readonly FanboxExactRecognizer[];
  readonly acquirers: readonly FanboxArtifactAcquirer[];
} {
  return {
    directoryInterpreters: [
      new FanboxDateDirectoryInterpreter(() =>
        sourceConnections.fanbox.creatorIds(),
      ),
    ],
    collectors: [sourceConnections.fanboxCollector()],
    sourceInterpreters: [new FanboxSourceInterpreter()],
    recognizers: [new FanboxExactRecognizer()],
    acquirers: [new FanboxArtifactAcquirer()],
  };
}

export function composeAutomationHost(
  productDataDirectory: string,
  options?: {
    readonly clock?: AutomationClock;
    readonly pollIntervalMilliseconds?: number;
    readonly onError?: (error: unknown) => void;
    readonly executionHost?: Pick<ExecutionHost, "runWithControl">;
    readonly configuration?: Readonly<Record<string, string | undefined>>;
    readonly automationInformationRequirementForAcceptedSubject?: AutomationInformationRequirementResolver;
    readonly automationInformationRequirement?: InformationRequirement;
  },
): ComposedAutomationHost {
  const workflow = composeAssetRefresh(
    productDataDirectory,
    options?.configuration,
    {
      ...(options?.automationInformationRequirementForAcceptedSubject ===
      undefined
        ? {}
        : {
            automationInformationRequirementForAcceptedSubject:
              options.automationInformationRequirementForAcceptedSubject,
          }),
      ...(options?.automationInformationRequirement === undefined
        ? {}
        : {
            automationInformationRequirement:
              options.automationInformationRequirement,
          }),
    },
  );
  const ownedExecutionHost =
    options?.executionHost === undefined ? new ExecutionHost() : undefined;
  const executionHost = options?.executionHost ?? ownedExecutionHost!;
  return composeAutomationHostForWorkflow(
    workflow,
    { ...options, executionHost },
    true,
    ownedExecutionHost,
  );
}

export function composeOwnedAutomationHost(
  workflow: DueAutomationRunner & { close(): void | Promise<void> },
  options?: {
    readonly clock?: AutomationClock;
    readonly pollIntervalMilliseconds?: number;
    readonly onError?: (error: unknown) => void;
    readonly executionHost?: Pick<ExecutionHost, "runWithControl">;
  },
): ComposedAutomationHost {
  const ownedExecutionHost =
    options?.executionHost === undefined ? new ExecutionHost() : undefined;
  const executionHost = options?.executionHost ?? ownedExecutionHost!;
  return composeAutomationHostForWorkflow(
    workflow,
    { ...options, executionHost },
    true,
    ownedExecutionHost,
  );
}

/**
 * A runtime-owned host stops its timer but leaves the shared workflow open
 * for its outer composition to release exactly once.
 */
function composeAutomationHostForWorkflow(
  workflow: DueAutomationRunner & {
    readonly close?: () => void | Promise<void>;
  },
  options?: {
    readonly clock?: AutomationClock;
    readonly pollIntervalMilliseconds?: number;
    readonly onError?: (error: unknown) => void;
    readonly executionHost?: Pick<ExecutionHost, "runWithControl">;
  },
  ownsWorkflow = false,
  ownedExecutionHost?: ExecutionHost,
): ComposedAutomationHost {
  const host = new AutomationHost(workflow, options);
  let closing: Promise<void> | undefined;
  return Object.assign(host, {
    close() {
      host.stop();
      closing ??= releaseOwnedResources([
        ...(ownedExecutionHost === undefined
          ? []
          : [() => ownedExecutionHost.close()]),
        () => host.settled(),
        ...(ownsWorkflow ? [() => workflow.close?.()] : []),
      ]);
      return closing;
    },
  });
}

/**
 * Every owner gets a chance to release even if an earlier lifecycle phase
 * failed. The first failure remains the caller-visible cause so a failed poll
 * cannot be hidden by a later persistence-close error.
 */
async function releaseOwnedResources(
  releases: readonly (() => void | Promise<void>)[],
): Promise<void> {
  let failed = false;
  let failure: unknown;
  for (const release of releases) {
    try {
      await release();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
}
