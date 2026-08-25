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
} from "./observed-root-cleanup-journal.ts";
import { ProductSourceConnections } from "./source-connections.ts";

export {
  InProcessObservedRootCleanupEmergencyJournal,
  observedRootCleanupEmergencyJournalCapacity,
} from "./observed-root-cleanup-journal.ts";
export type {
  ObservedRootCleanupEmergencyIncident,
  ObservedRootCleanupEmergencyJournal,
  ObservedRootCleanupEmergencyJournalSnapshot,
} from "./observed-root-cleanup-journal.ts";
export {
  OmdbSourceConnection,
  ProductSourceConnections,
  TmdbSourceConnection,
} from "./source-connections.ts";
export { createOfflineProductDataBackup, restoreOfflineProductDataBackup };
export { ProductBangumiSourceConnection } from "./bangumi-source-connection.ts";
export type { BangumiAuthorizationStart } from "./bangumi-source-connection.ts";
export type {
  SourceConnectionAvailability,
  SourceConnectionCredentialStatus,
  SourceConnectionInspection,
} from "./source-connections.ts";

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

/** 产品策略在此装配；集成绝不能自行授予信任。 */
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

/** 允许列表属于产品策略，绝不是能力声明。 */
export function curatedInitialRecognitionPolicy(): RecognitionPolicy & {
  readonly version: string;
} {
  return new CuratedInitialRecognitionPolicy();
}

const ordinaryFilmMetadataPolicyId = "ordinary-film-metadata";

/**
 * 在无效静态装配创建进程资源前拒绝它。具体能力实例在下方注册；该函数刻意不了解
 * 提供方名称，也不了解任何封闭的种类目录。
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
 * 产品策略位于装配边界。Application 只接收通用规则和耐久的不透明登记标识。
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
 * 组合层持有具体配置登记表。条目来自当前已组合的策略与配置版本，绝不来自执行的
 * 冻结引用，因此过期执行不能通过回显自己的历史输入来验证自身。
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
    /** 每个生产组合都持有注册观察根权威。 */
    readonly observedRootRegistrations: ObservedRootRegistrations;
    /** 普通清理审计失败时使用的进程内后备证据。 */
    readonly observedRootCleanupEmergencyJournal: ObservedRootCleanupEmergencyJournal;
    /** 产品管理的、供当前部署电影来源使用的私密访问能力。 */
    readonly sourceConnections: ProductSourceConnections;
    /** 排空 Application 工作，然后且仅然后释放一次基础设施。 */
    close(): Promise<void>;
  };

export type ComposedAutomationHost = AutomationHost & {
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
export type ComposedAssetRefreshRuntime = {
  readonly workflow: ComposedAssetRefresh;
  readonly executionHost: ExecutionHost;
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
  /** @deprecated 新组合应优先使用按已接受主体解析的解析器。 */
  readonly automationInformationRequirement?: InformationRequirement;
};

/** Delivery 可用的维护准入 seam，不暴露持久化实现。 */
export async function assertProductDataOffline(
  productDataDirectory: string,
): Promise<void> {
  await ProductDataOperations.forRoot(productDataDirectory).assertOffline();
}

/**
 * 交付层可以提供按已接受主体工作的中立解析器，而不会让组合依赖视图，也不会把展开后
 * 的需求持久化到自动化意图。静态选项只为旧调用方保留。
 */
export type AssetRefreshCompositionOptions = {
  readonly automationInformationRequirementForAcceptedSubject?: AutomationInformationRequirementResolver;
  /** @deprecated 新组合应优先使用按已接受主体解析的解析器。 */
  readonly automationInformationRequirement?: InformationRequirement;
  /** 由运行时持有、交付层和自动化子执行共享的监督器。 */
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
