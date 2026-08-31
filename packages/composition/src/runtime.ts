import path from "node:path";

import {
  AssetRefreshAutomation,
  AssetRefreshWorkflow,
  ApplicationArtifactByteAccess,
  AutomationHost,
  ExecutionHost,
  ObservedRootRegistrations,
  applicationOwnedCapabilityDeclarations,
  attachAssetRefreshAutomation,
  type AutomationClock,
  type AutomationInformationRequirementResolver,
  type DueAutomationRunner,
  type ObservedRootCleanupFailure,
  type ObservedRootCleanupFailureReporter,
  type SourceCollector,
} from "@digital/application";
import {
  BangumiArtifactAcquirer,
  BangumiCollector,
  BangumiEpisodicDirectoryInterpreter,
  BangumiEpisodicRecognizer,
  ProductBangumiSourceConnection,
  BangumiSourceInterpreter,
  bangumiOfficialCollectionCapability,
} from "@digital/bangumi";
import {
  DlsiteArtifactAcquirer,
  DlsiteCollector,
  DlsiteExactDirectoryInterpreter,
  DlsiteExactRecognizer,
  DlsiteSourceInterpreter,
  dlsiteInformationFulfillmentCapabilities,
} from "@digital/dlsite";
import {
  EpubEmbeddedCoverAcquirer,
  EpubLocalPublicationRecognizer,
  EpubPublicationInspector,
} from "@digital/epub";
import {
  FanboxArtifactAcquirer,
  FanboxCollector,
  FanboxDateDirectoryInterpreter,
  FanboxExactRecognizer,
  FanboxSourceInterpreter,
  fanboxCreatorIdFromEvidence,
  fanboxOfficialCollectionCapability,
  fanboxSourceConnectionCapability,
  validatedFanboxBrowserCredential,
  verifyFanboxStoredCredential,
} from "@digital/fanbox";
import {
  BdmvFilesystemPackageInterpreter,
  ArtifactFrameProofStore,
  ContentAddressedManagedArtifactStore,
  ReadOnlyFilesystemObserver,
} from "@digital/filesystem";
import {
  NbinetCollector,
  NbinetExactIsbnRecognizer,
  NbinetSourceInterpreter,
} from "@digital/nbinet";
import {
  OmdbArtifactAcquirer,
  OmdbCollector,
  omdbOfficialCollectionCapability,
  omdbSourceConnectionCapability,
  OmdbSourceAssociationCandidateInterpreter,
  OmdbSourceAssociationInterpreter,
  OmdbSourceInterpreter,
  verifyOmdbApiKey,
} from "@digital/omdb";
import { boundedPlaybackFormatInspector } from "@digital/playback-format";
import {
  CuratedMetadataPolicyConfiguration,
  type ProductApplication,
  type ProductAutomationOperations,
  type ProductAssetRefresh,
  type ProductAssetRefreshRuntime,
  type ProductAutomationHost,
  type ProductAutomationHostOptions,
  type ProductExecutionOperations,
  type ProductWorkflowOperations,
  artifactDownloadOperations,
  ProductSourceConnections,
  RegisteredWorkflowConfigurationCompatibility,
  curatedInitialRecognitionPolicy,
  validateCapabilityDeclarations,
} from "@digital/product-application";
import {
  ProductDataOperations,
  ProductSourceConnectionPrivateState,
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
  tmdbOfficialCollectionCapability,
  tmdbSourceConnectionCapability,
  verifyTmdbAccessToken,
} from "@digital/tmdb";

import {
  ComposedArtifactByteCleanupReporter,
  ComposedArtifactLocationByteSources,
} from "./artifact-byte-access.ts";
import {
  InProcessObservedRootCleanupEmergencyJournal,
  type ObservedRootCleanupEmergencyJournal,
} from "./observed-root-cleanup-journal.ts";

export {
  InProcessObservedRootCleanupEmergencyJournal,
  observedRootCleanupEmergencyJournalCapacity,
} from "./observed-root-cleanup-journal.ts";
export type {
  ObservedRootCleanupEmergencyIncident,
  ObservedRootCleanupEmergencyJournal,
  ObservedRootCleanupEmergencyJournalSnapshot,
} from "./observed-root-cleanup-journal.ts";
export { createOfflineProductDataBackup, restoreOfflineProductDataBackup };

/**
 * 组合层为 Application 持有的清理事件选择具体审计接收端。记录只保留注册坐标，
 * 绝不保留适配器范围或可被其他层重新打开的文件系统路径。
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

export type ComposedAssetRefresh = ProductAssetRefresh & {
  /** 每个生产组合都持有注册观察根权威。 */
  readonly observedRootRegistrations: ObservedRootRegistrations;
  /** 普通清理审计失败时使用的进程内后备证据。 */
  readonly observedRootCleanupEmergencyJournal: ObservedRootCleanupEmergencyJournal;
  /** 产品管理的、供当前部署电影来源使用的私密访问能力。 */
  readonly sourceConnections: ProductSourceConnections;
  readonly artifactByteAccess: ApplicationArtifactByteAccess;
  /** 排空 Application 工作，然后且仅然后释放一次基础设施。 */
  close(): Promise<void>;
};

export type ComposedAutomationHost = ProductAutomationHost & {
  /**
   * 停止轮询并且只释放一次所持资源。失败的活动轮询在释放后仍可观察，不会被改写为
   * 正常关闭结果。
   */
  close(): Promise<void>;
};

/**
 * 一个生产进程组合。交付层及其持有的自动化宿主接收同一个应用工作流实例，因此两种
 * 触发来源共享信息履行的记忆化和耐久工作串行化。
 */
export type ComposedAssetRefreshRuntime = ProductAssetRefreshRuntime & {
  readonly workflow: ComposedAssetRefresh;
  readonly automationHost: ComposedAutomationHost;
  /** 先释放所持宿主，再释放唯一的工作流／持久化持有者。 */
  close(): Promise<void>;
};

export type AssetRefreshRuntimeOptions = {
  readonly clock?: AutomationClock;
  readonly pollIntervalMilliseconds?: number;
  readonly onError?: (error: unknown) => void;
  readonly configuration?: Readonly<Record<string, string | undefined>>;
  /**
   * 每个已接受主体建立后重建的交付层分派。回调只返回 Application 的中立信息需求契约。
   */
  readonly automationInformationRequirementForAcceptedSubject?: AutomationInformationRequirementResolver;
};

/** Delivery 可用的维护准入 seam，不暴露持久化实现。 */
export async function assertProductDataOffline(
  productDataDirectory: string,
): Promise<void> {
  await ProductDataOperations.forRoot(productDataDirectory).assertOffline();
}

/**
 * 交付层可以提供按已接受主体工作的中立解析器，而不会让组合依赖视图，也不会把展开后
 * 的需求持久化到自动化意图。
 */
export type AssetRefreshCompositionOptions = {
  readonly automationInformationRequirementForAcceptedSubject?: AutomationInformationRequirementResolver;
  /** 由运行时持有、交付层和自动化子执行共享的监督器。 */
  readonly invocationSupervisor?: ExecutionHost;
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
    const privateState =
      ProductSourceConnectionPrivateState.forRoot(productDataDirectory);
    const bangumiSourceConnection = new ProductBangumiSourceConnection({
      privateState,
      environment: configuration,
    });
    const sourceConnections = new ProductSourceConnections({
      privateState,
      environment: configuration,
      bangumi: {
        connection: bangumiSourceConnection,
        collectorCapability: bangumiOfficialCollectionCapability,
        createCollector: (input) => new BangumiCollector(input),
      },
      fanbox: {
        connectionCapability: fanboxSourceConnectionCapability,
        collectorCapability: fanboxOfficialCollectionCapability,
        creatorIdFromEvidence: fanboxCreatorIdFromEvidence,
        validatedBrowserCredential: validatedFanboxBrowserCredential,
        verifyStoredCredential: verifyFanboxStoredCredential,
        createCollector: (input) => new FanboxCollector(input),
      },
      tmdb: {
        connectionCapability: tmdbSourceConnectionCapability,
        collectorCapability: tmdbOfficialCollectionCapability,
        verifyAccessToken: verifyTmdbAccessToken,
        createCollector: (input) => new TmdbCollector(input),
      },
      omdb: {
        connectionCapability: omdbSourceConnectionCapability,
        collectorCapability: omdbOfficialCollectionCapability,
        verifyApiKey: verifyOmdbApiKey,
        createCollector: (input) => new OmdbCollector(input),
      },
    });
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
      new EpubLocalPublicationRecognizer(),
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
          // 自动化的默认策略引用就是当前策略对象。
          recognitionPolicy.version,
          // 文件系统执行保留这个明确的规划输入引用。
          `recognition-policy/${recognitionPolicy.version}`,
          // 这是独立版本化的组合配置，而不是从执行派生、对不透明引用的回显。
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
      operationSupervisor: invocationSupervisor,
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
      }),
    );
    return composeOwnedAssetRefresh(
      Object.assign(automated, {
        observedRootRegistrations,
        observedRootCleanupEmergencyJournal,
        sourceConnections,
        artifactByteAccess: new ApplicationArtifactByteAccess({
          persistence,
          sources: new ComposedArtifactLocationByteSources(
            observedRootRegistrations,
            new ContentAddressedManagedArtifactStore(managedDirectory),
          ),
          proofStore: new ArtifactFrameProofStore(productDataDirectory),
          executionHost: invocationSupervisor,
          playbackInspector: boundedPlaybackFormatInspector,
          cleanupReporter: new ComposedArtifactByteCleanupReporter(
            observedRootRegistrations,
          ),
        }),
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
 * 为组合工作流应用唯一关闭顺序，同时不向 Application 暴露持久化实现。它也是使用
 * 实例内持有者进行组合层生命周期测试的窄接缝。
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
 * 生产组合根。它刻意只持有一个工作流，并把同一个对象传给交付层和自动化宿主组合。
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
): { readonly collector: SourceCollector } {
  return {
    collector: sourceConnections.tmdbCollector(),
  };
}

function omdbCapabilitiesFromPrivateConfiguration(
  sourceConnections: ProductSourceConnections,
): {
  readonly sourceAssociationCandidateInterpreter: OmdbSourceAssociationCandidateInterpreter;
  readonly sourceAssociationInterpreter: OmdbSourceAssociationInterpreter;
  readonly collector: SourceCollector;
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
): { readonly collector: SourceCollector } {
  return { collector: sourceConnections.bangumiCollector() };
}

function fanboxCapabilitiesFromProductConnections(
  sourceConnections: ProductSourceConnections,
): {
  readonly directoryInterpreters: readonly FanboxDateDirectoryInterpreter[];
  readonly collectors: readonly SourceCollector[];
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
  },
): ComposedAutomationHost {
  const workflow = composeAssetRefresh(
    productDataDirectory,
    options?.configuration,
    options,
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
 * 运行时持有的宿主停止自己的定时器，但保持共享工作流打开，由外层组合只释放一次。
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
 * 即使较早的生命周期阶段失败，每个持有者仍有机会释放。第一个失败始终是调用方可见
 * 的原因，因此失败轮询不会被后续持久化关闭错误掩盖。
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

/**
 * 为一种部署配置建立产品应用。这里仅绑定构造和生命周期；固定策略与来源入口由
 * Product Application 持有，文件系统行为仍留在具体 Adapter 中。
 */
export function composeProductApplication(input: {
  readonly productDataDirectory?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): { readonly application: ProductApplication; close(): Promise<void> } {
  const productDataDirectory = input.productDataDirectory?.trim() || undefined;
  const managedArtifacts =
    productDataDirectory === undefined
      ? undefined
      : new ContentAddressedManagedArtifactStore(
          path.join(productDataDirectory, "managed-artifacts"),
        );
  if (productDataDirectory === undefined) {
    const unavailable = unavailableProductOperations();
    return {
      application: {
        configured: false,
        workflow: unavailable.workflow,
        automation: unavailable.automation,
        execution: unavailable.execution,
        async startAutomation() {
          throw new Error("尚未配置产品数据目录");
        },
        setAutomationInformationRequirementForAcceptedSubject() {
          throw new Error("尚未配置产品数据目录");
        },
        async createOfflineBackup() {
          throw new Error("尚未配置产品数据目录");
        },
        managedArtifactReference() {
          return undefined;
        },
        async readManagedArtifact() {
          throw new Error("尚未配置产品数据目录");
        },
        async prepareArtifactDownload() {
          throw new Error("尚未配置产品数据目录");
        },
        async openArtifactBytes() {
          throw new Error("尚未配置产品数据目录");
        },
        async planPlayback() {
          throw new Error("尚未配置产品数据目录");
        },
        async observedFileSelectionForLocation() {
          throw new Error("尚未配置产品数据目录");
        },
        async confirmObservedFileRevision() {
          throw new Error("尚未配置产品数据目录");
        },
      },
      async close() {},
    };
  }

  let runtime: ComposedAssetRefreshRuntime | undefined;
  let automationInformationRequirementForAcceptedSubject:
    | AutomationInformationRequirementResolver
    | undefined;
  const requireRuntime = (
    options: ProductAutomationHostOptions = {},
  ): ComposedAssetRefreshRuntime =>
    (runtime ??= composeAssetRefreshRuntime(productDataDirectory, {
      configuration: input.environment,
      ...options,
      ...(automationInformationRequirementForAcceptedSubject === undefined
        ? {}
        : { automationInformationRequirementForAcceptedSubject }),
    }));
  const downloadOperations = () => {
    const access = requireRuntime().workflow.artifactByteAccess;
    return artifactDownloadOperations(access, access);
  };
  return {
    application: {
      configured: true,
      get workflow() {
        return requireRuntime().workflow;
      },
      get automation() {
        return requireRuntime().automationHost;
      },
      get execution() {
        return requireRuntime().executionHost;
      },
      async startAutomation(options: ProductAutomationHostOptions = {}) {
        await requireRuntime(options).automationHost.start();
      },
      setAutomationInformationRequirementForAcceptedSubject(resolver) {
        if (runtime !== undefined) throw new Error("自动刷新已经由组合根启动");
        automationInformationRequirementForAcceptedSubject = resolver;
      },
      async createOfflineBackup(backupDirectory: string) {
        await createOfflineProductDataBackup({
          productDataDirectory,
          backupDirectory,
        });
      },
      managedArtifactReference(address: string) {
        return managedArtifacts?.reference(address);
      },
      async readManagedArtifact(digest: string) {
        return await managedArtifacts!.read(digest);
      },
      async prepareArtifactDownload(selection) {
        return await downloadOperations().prepareArtifactDownload(selection);
      },
      async openArtifactBytes(input) {
        return await downloadOperations().openArtifactBytes(input);
      },
      async planPlayback(selection, consumer, preferences) {
        return await downloadOperations().planPlayback(
          selection,
          consumer,
          preferences,
        );
      },
      async observedFileSelectionForLocation(locationId) {
        return await downloadOperations().observedFileSelectionForLocation(
          locationId,
        );
      },
      async confirmObservedFileRevision(input) {
        return await downloadOperations().confirmObservedFileRevision(input);
      },
    },
    async close() {
      await runtime?.close();
    },
  };
}

function unavailableProductOperations(): {
  readonly workflow: ProductWorkflowOperations;
  readonly automation: ProductAutomationOperations;
  readonly execution: ProductExecutionOperations;
} {
  const unavailable = new Proxy(
    {},
    {
      get() {
        throw new Error("尚未配置产品数据目录");
      },
    },
  );
  return {
    workflow: unavailable as ProductWorkflowOperations,
    automation: unavailable as ProductAutomationOperations,
    execution: unavailable as ProductExecutionOperations,
  };
}
