import path from "node:path";

import {
  beginSourceRefreshScopeAcquisition,
  cancelSourceRefreshRun,
  completeSourceRefreshChangeSet,
  createSourceRefreshRun,
  failSourceRefreshScope,
  reviewSourceRefreshChangeSet,
  stageSourceRefreshChangeSet,
  validateSourceInterpretationBatch,
  type MetadataAssertion,
  type SourceInterpretationBatch,
} from "@digital/domain";
import {
  InMemoryObservedFilesystemCapability,
  InMemoryObservedRootCleanupReporter,
  InMemoryObservedRootRegistrationStore,
} from "@digital/test-support";
import { describe, expect, it, vi } from "vitest";

import {
  AssetRefreshWorkflow,
  AssetLibraries,
  AssetRefreshAutomation,
  AutomationHost,
  ExecutionHost,
  ObservedRootUnavailable,
  ObservedRootRegistrations,
  attachAssetRefreshAutomation,
  prerequisiteUnavailableFailure,
  recognitionMaterialBoundaryIntersectsScope,
  sha256,
  workflowCompatibilityCanReuse,
  type AssetRefreshReuseQueries,
  type AssetLibraryPersistence,
  type LibraryScanDirectoryRecord,
  type AutomationCommands,
  type AutomationQueries,
  type ChangeImpactCommands,
  type ChangeImpactPreview,
  type ChangeImpactQueries,
  type EffectiveRecognitionMaterialBoundary,
  type ExecutionInspection,
  type MetadataRefreshPersistence,
  type InformationRequirement,
  type FilesystemObjectIdentityContract,
  type RecognitionAcceptancePersistence,
  type RecognitionReevaluationPersistence,
  type RecoverySourceRefreshRunCommands,
  type SourceRefreshRunPersistence,
  type WorkflowConfigurationCompatibility,
  type WorkflowExecutionCommands,
  type WorkflowExecutionQueries,
  type WorkflowRecoveryLease,
  type WorkflowExecution,
  type ObservedFilesystemCapability,
  type ObservedRootRegistration,
  type ObservedRootSnapshot,
} from "../src/index.ts";

type RefreshFixturePersistence = WorkflowExecutionCommands &
  WorkflowExecutionQueries &
  WorkflowRecoveryLease &
  AssetRefreshReuseQueries &
  RecognitionAcceptancePersistence &
  RecognitionReevaluationPersistence &
  MetadataRefreshPersistence &
  ChangeImpactQueries &
  ChangeImpactCommands &
  AutomationQueries &
  AutomationCommands;

function bindSourceMetadata(
  metadata: SourceInterpretationBatch["metadata"],
  assetId: string,
): readonly MetadataAssertion[] {
  return metadata.map(({ subjectId, ...assertion }) => ({
    ...assertion,
    target: { kind: "entity", entityId: subjectId ?? assetId },
  }));
}

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const primaryCoverRequirement = {
  metadataUsageContext: "asset.ordinary",
  metadata: [],
  artifactRoles: [
    {
      role: "asset.primary-cover",
      necessity: "required" as const,
      maximum: 1,
    },
  ],
  relationshipTypes: [],
};
const optionalPrimaryCoverRequirement = {
  ...primaryCoverRequirement,
  artifactRoles: [
    { role: "asset.primary-cover", necessity: "optional" as const, maximum: 1 },
  ],
};

function fixtureObservedRoot(
  id: string,
  logicalDirectory = "/observed/work",
  configVersion = 1,
): ObservedRootSnapshot {
  return {
    version: "observed-root-snapshot/1",
    id,
    configVersion,
    containerPath: logicalDirectory,
    canonicalPath: logicalDirectory,
    readOnly: true,
    symlinkMode: "do-not-follow",
    allowedTargetRootIds: [],
  };
}

function fixtureObservedRootRegistration(
  id: string,
  logicalDirectory = "/observed/work",
  configVersion = 1,
): ObservedRootRegistration {
  return {
    id,
    displayName: id,
    containerPath: logicalDirectory,
    canonicalPath: logicalDirectory,
    status: "active",
    configVersion,
    readOnly: true,
    symlinkMode: "do-not-follow",
    allowedTargetRootIds: [],
  };
}

/** 仅点名这一库和目录；冻结后撤权及绑定失败仍由原预检边界判定。 */
function fixtureAutomationLibraries(rootId: string) {
  return {
    async freezeLibraryScan(libraryId: string) {
      if (libraryId !== "library-fixture")
        throw new Error("资产库不存在或已移除");
      const root = fixtureObservedRoot(rootId);
      return {
        snapshot: { id: libraryId },
        candidates: [{ id: rootId }],
        frozenRoots: [root],
        directoryAuthorizations: [
          { observedRootId: rootId, authorityVersion: 1 },
        ],
      };
    },
  };
}

function fixtureObservedFilesystem(
  input: {
    readonly onClose?: () => void;
  } = {},
): ObservedFilesystemCapability {
  return new InMemoryObservedFilesystemCapability({
    onClose: () => input.onClose?.(),
  });
}

async function scanFixtureObservedScope(
  workflow: Pick<AssetRefreshWorkflow, "scanObservedScope">,
  input: Omit<
    Parameters<AssetRefreshWorkflow["scanObservedScope"]>[0],
    "registrationId" | "relativeScope"
  > & {
    /** 测试夹具拼写，映射到显式注册的根。 */
    readonly directory?: "/observed/work";
  },
) {
  const { directory, ...request } = input;
  if (directory !== undefined && directory !== "/observed/work")
    throw new Error("测试文件位置未登记");
  return await workflow.scanObservedScope({
    registrationId: "fixture-root",
    relativeScope: ".",
    ...request,
  });
}

/**
 * 用于注册机制引入前测试案例的迁移适配器。它刻意作为测试辅助方法而非工作流方法：
 * 每个分支都调用当前公开已注册根入口，且没有原始目录进入应用层。
 */
async function refreshFixtureObservedScope(
  workflow: Pick<
    AssetRefreshWorkflow,
    "scanObservedScope" | "directedRecognitionSourceInputObservedScope"
  >,
  input: Omit<
    Parameters<AssetRefreshWorkflow["scanObservedScope"]>[0],
    "registrationId" | "relativeScope"
  > & {
    readonly directory: "/observed/work";
    readonly directedSourceAddress?: string;
    readonly directedSourceIdentity?: string;
  },
) {
  const {
    directory,
    directedSourceAddress,
    directedSourceIdentity,
    acceptTrusted: _acceptTrusted,
    executionId: _executionId,
    automationIntentId: _automationIntentId,
    trigger: _trigger,
    initiatedBy: _initiatedBy,
    configurationReferences: _configurationReferences,
    requestedAt: _requestedAt,
    onCheckpoint: _onCheckpoint,
    onHostCheckpoint: _onHostCheckpoint,
    ...ordinary
  } = input;
  if (
    (directedSourceAddress === undefined) !==
    (directedSourceIdentity === undefined)
  ) {
    throw new Error("定向识别必须同时指定来源与精确地址");
  }
  if (
    directedSourceAddress === undefined ||
    directedSourceIdentity === undefined
  )
    return await scanFixtureObservedScope(workflow, {
      directory,
      acceptTrusted: input.acceptTrusted,
      executionId: input.executionId,
      automationIntentId: input.automationIntentId,
      trigger: input.trigger,
      initiatedBy: input.initiatedBy,
      configurationReferences: input.configurationReferences,
      requestedAt: input.requestedAt,
      onExecutionStarted: input.onExecutionStarted,
      onProgress: input.onProgress,
      onCheckpoint: input.onCheckpoint,
      onHostCheckpoint: input.onHostCheckpoint,
      ...ordinary,
    });
  return await workflow.directedRecognitionSourceInputObservedScope({
    registrationId: "fixture-root",
    relativeScope: ".",
    sourceIdentity: directedSourceIdentity,
    sourceInput: { address: directedSourceAddress },
    informationRequirement: input.informationRequirement,
    onExecutionStarted: input.onExecutionStarted,
    onProgress: input.onProgress,
  });
}

type FixtureSelection = Parameters<
  AssetRefreshWorkflow["refreshMetadata"]
>[0]["selection"];

function fixtureRegisteredScopeFromSelection(
  selection: FixtureSelection,
  expectedSubjects: "none" | "one",
): { readonly registrationId: "fixture-root"; readonly relativeScope: "." } {
  if (
    (expectedSubjects === "none" && selection.subjects.length !== 0) ||
    (expectedSubjects === "one" && selection.subjects.length !== 1)
  ) {
    throw new Error(
      expectedSubjects === "none"
        ? "scan requires no subjects"
        : "rescrape requires one exact current subject",
    );
  }
  if (selection.filesystemScopes.length !== 1)
    throw new Error("requires exactly one filesystem scope");
  const [scope] = selection.filesystemScopes;
  if (scope?.root !== "/observed/work") throw new Error("测试文件位置未登记");
  return { registrationId: "fixture-root", relativeScope: "." };
}

async function scanFixtureObservedSelection(
  workflow: Pick<AssetRefreshWorkflow, "scanObservedScope">,
  input: Omit<
    Parameters<AssetRefreshWorkflow["scanObservedScope"]>[0],
    "registrationId" | "relativeScope"
  > & { readonly selection: FixtureSelection },
) {
  const { selection, ...request } = input;
  return await workflow.scanObservedScope({
    ...fixtureRegisteredScopeFromSelection(selection, "none"),
    ...request,
  });
}

async function rescrapeFixtureObservedSelection(
  workflow: Pick<AssetRefreshWorkflow, "rescrapeObservedScope">,
  input: Omit<
    Parameters<AssetRefreshWorkflow["rescrapeObservedScope"]>[0],
    "registrationId" | "relativeScope" | "subjectId" | "sourceInput"
  > & {
    readonly selection: FixtureSelection;
    readonly sourceAddress: string;
  },
) {
  const { selection, sourceAddress, ...request } = input;
  const [subject] = selection.subjects;
  const scope = fixtureRegisteredScopeFromSelection(selection, "one");
  if (subject === undefined) throw new Error("rescrape requires one subject");
  return await workflow.rescrapeObservedScope({
    ...scope,
    subjectId: subject.subjectId,
    ...request,
    sourceInput: { address: sourceAddress },
  });
}

async function directedRecognitionFixtureObservedSelection(
  workflow: Pick<
    AssetRefreshWorkflow,
    "directedRecognitionSourceInputObservedScope"
  >,
  input: Omit<
    Parameters<
      AssetRefreshWorkflow["directedRecognitionSourceInputObservedScope"]
    >[0],
    "registrationId" | "relativeScope" | "sourceInput"
  > & { readonly selection: FixtureSelection; readonly sourceAddress: string },
) {
  const { selection, sourceAddress, ...request } = input;
  return await workflow.directedRecognitionSourceInputObservedScope({
    ...fixtureRegisteredScopeFromSelection(selection, "none"),
    ...request,
    sourceInput: { address: sourceAddress },
  });
}

async function refreshFixtureMetadata(
  workflow: Pick<AssetRefreshWorkflow, "refreshMetadata">,
  subjectId: string,
  input: Omit<
    Parameters<AssetRefreshWorkflow["refreshMetadata"]>[0],
    "selection"
  > = {},
) {
  return await workflow.refreshMetadata({
    selection: {
      version: "asset-refresh-selection/1",
      subjects: [
        {
          subjectId,
          explanations: [{ path: ["test", "current-subject", subjectId] }],
        },
      ],
      filesystemScopes: [],
    },
    ...input,
  });
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function refreshFixture(options?: {
  readonly coverFails?: boolean;
  readonly coverFailureState?: { fails: boolean };
  readonly collectionFailsAfterOneRecord?: boolean;
  readonly collectionUnavailableForUnrequestedMetadata?: boolean;
  readonly collectionFailureCapabilityShape?: "incomplete" | "extra";
  readonly collectionFailureProducerSpoof?: boolean;
  readonly catalogueFails?: boolean;
  readonly reusable?: boolean;
  readonly invalidMetadataProvenance?: boolean;
  readonly unavailableManagedCover?: boolean;
  readonly managedCoverAvailability?: { available: boolean };
  readonly requireLineageFreezeBeforeCollection?: boolean;
  readonly invalidRefreshMetadataProvenance?: boolean;
  readonly includeForeignAndUserFacts?: boolean;
  readonly includeListedAttachmentCandidate?: boolean;
  readonly includeSecondCoverCandidate?: boolean;
  readonly publicCandidateSelectionEvidence?: Record<string, unknown>;
  readonly acquisitionBarrier?: () => Promise<void>;
  readonly acquisitionFailsForCandidateIds?: ReadonlySet<string>;
  readonly acquisitionFailsForRoles?: ReadonlySet<string>;
  readonly managedStoreBarrier?: () => Promise<void>;
  readonly managedStoreFails?: boolean;
  readonly transitionFailsWhenAcquirerFrozen?: boolean;
  readonly strictExecutionCas?: boolean;
  readonly acceptanceBarrier?: () => Promise<void>;
  readonly resumeClock?: import("../src/index.ts").AutomationClock;
  readonly configurationCompatibility?: WorkflowConfigurationCompatibility;
  readonly omitConfigurationCompatibility?: boolean;
  readonly independentEvidence?: boolean;
  readonly duplicateFirstBoundaryEvidence?: boolean;
  readonly conflictingSharedRecord?: boolean;
  readonly sharedCollectionFailure?: boolean;
  readonly producerInterpretationPresenceConflict?: boolean;
  readonly explicitWorkItemsAfterFirstInterpretation?: () => boolean;
  readonly failSecondCollection?: boolean;
  readonly competingProposals?: boolean;
  readonly emptyWorkItemBoundary?: boolean;
  readonly overlappingInterpreter?: boolean;
  readonly sharedSourceArtifact?: boolean;
  /** 同一个来源候选项，但每个工作项目都以各自已接受资产为主体。 */
  readonly sharedImplicitSourceArtifact?: boolean;
  readonly singletonExplicit?: boolean;
  readonly snapshotVersion?: (relativePath: string) => number;
  readonly explicitSelectionKeyWithEmptyBoundary?: boolean;
  readonly duplicateWorkItemKey?: boolean;
  readonly duplicateWorkItemPath?: boolean;
  readonly sharedCandidateWithDifferentServingSemantics?: boolean;
  readonly sharedCandidateWithConflictingAcquisition?: boolean;
  readonly sourceAddressForSnapshotVersion?: (version: number) => string;
  readonly sharedCollectionScope?: boolean;
  readonly automationInformationRequirement?: InformationRequirement;
  /** 自动化用例使用真实库冻结及父子目录账本，其他单目录用例保留原接缝。 */
  readonly assetLibraryAutomation?: boolean;
  /** 存在于组合层，但绝不适用于本次执行的证据。 */
  readonly unusedConfiguredCollector?: boolean;
  /** 允许后续部署在一次执行后新增不适用的采集器。 */
  readonly unusedConfiguredCollectorState?: { enabled: boolean };
  /** 在恢复预检后改变适用性的相邻采集器，用于证明 durable-only 计划不会重新枚举。 */
  readonly dynamicRecoveryCollectorState?: {
    enabled: boolean;
    firstApplicable: boolean;
    otherPlanApplicable?: boolean;
    separateCapability?: boolean;
    retainRecord?: boolean;
    retainedRecordId?: string;
    omitInterpretationContractVersions?: boolean;
    nonShareable?: boolean;
    canCollectCalls: number;
    collectCalls: number;
  };
  readonly incompleteSnapshot?: boolean;
  readonly thirdIndependentBoundary?: boolean;
  readonly ambiguousSourceAddresses?: readonly string[];
  readonly collectionFailureState?: {
    readonly addresses: Set<string>;
  };
  readonly partialCollectionFailureState?: {
    readonly addresses: Set<string>;
  };
  readonly observedEpubPart?: boolean;
  readonly observedEpubPartOnly?: boolean;
  readonly observedPartOriginDigest?: string;
  readonly formatFactsOnly?: boolean;
  readonly formatIncludesTitle?: boolean;
  readonly recognitionBasis?: "source-interpretation" | "observed-evidence";
  /** 允许格式检查器把另一项能力报告为证据生产者。 */
  readonly formatEvidenceProducerSpoof?: boolean;
  readonly sourceOmitsTitle?: boolean;
  readonly sourceRelationshipQualifiers?: boolean;
  /** 产生不依赖采用资产的完整来源关系，用于来源事实坐标测试。 */
  readonly fullSourceRelationship?: boolean;
  /** 让测试来源记录以地址决定来源身份。 */
  readonly sourceFactIdentityForAddress?: (
    address: string | undefined,
  ) => string;
  /** 完整来源关系夹具的独立来源入口地址。 */
  readonly sourceFactEpisodeAddresses?: {
    readonly second: string;
    readonly third: string;
  };
  readonly sourceAssociationOutcome?: "accepted" | "contradicted";
  /** 一次采集形成两个可独立选择的来源产品解释。 */
  readonly multipleSourceInterpretations?: boolean;
  /** 故意错误的组合：同一批次被两个关联判断器接受。 */
  readonly duplicateSourceAssociationInterpreters?: boolean;
  /** 只在明确的来源关联试验地址上返回协调器必须拒绝的解释结果。 */
  readonly sourceInterpretationFault?:
    | "empty"
    | "unknown-record"
    | "duplicate-address"
    | "undeclared-relationship";
  readonly sourceEnrichmentFails?: boolean;
  readonly sourceEnrichmentSucceeds?: boolean;
  /** 允许来源关联候选解释器伪造其生产者。 */
  readonly sourceEnrichmentCandidateProducerSpoof?: boolean;
  /**
   * 允许已配置候选解释器只在识别获接受后出现，随后在生成持久丰富意图前失败。
   */
  readonly sourceEnrichmentCandidateFailureState?: {
    enabled: boolean;
    fails: boolean;
  };
  readonly sourceEnrichmentPartialFailure?: boolean;
  readonly sourceEnrichmentUnsafeFailure?: boolean;
  /**
   * 验证独立配置的丰富操作之间的持久失败处理。第一个采集器正常抛错；第二个可暂停在采集中，
   * 用于模拟进程在下一检查点前退出。
   */
  readonly sourceEnrichmentFailureThenInterrupted?: boolean;
  readonly sourceEnrichmentFirstFailureStage?: "collection" | "interpretation";
  readonly enrichmentCollectionBarrier?: () => Promise<void>;
  readonly mutateAcceptedDuringChangeBaseline?: boolean;
  readonly sourceOmitsCover?: boolean;
  readonly metadataPolicyConfigured?: boolean;
  readonly metadataPolicyConflict?: boolean;
  readonly multiAssociationRefresh?: boolean;
  readonly failSupplementaryAssociationRefresh?: boolean;
  readonly sourceRefreshAuthority?: boolean;
  readonly formatCoordinateState?: {
    capabilityVersion: string;
    contractVersion: string;
  };
  readonly partAcquirerCoordinateState?: {
    capabilityVersion: string;
    contractVersion: string;
  };
  readonly directedFilesystemPackage?: boolean;
  readonly filesystemPackageCoordinateState?: {
    capabilityVersion: string;
    contractVersion: string;
  };
  readonly collectorCoordinateState?: {
    capabilityVersion: string;
    contractVersion: string;
  };
  readonly sourceInterpreterCoordinateState?: {
    capabilityVersion: string;
    contractVersion: string;
  };
  readonly recognizerCoordinateState?: {
    capabilityVersion: string;
    contractVersion: string;
  };
  readonly acquirerCoordinateState?: {
    capabilityVersion: string;
    contractVersion: string;
  };
  /** 允许恶意识别器冒充产品信任的规则坐标。 */
  readonly recognizerSpoofState?: { enabled: boolean };
  /**
   * 允许原本受信任的识别器尝试通过提案响应创作来源解释器和产物格式检查器事实。
   */
  readonly recognizerProposalForgery?:
    | "interpretation"
    | "evidence"
    | "observed"
    | "all";
  /** 允许目录解释器把另一项能力报告为证据生产者。 */
  readonly directoryEvidenceProducerSpoof?: boolean;
  /** 可在先前检查点或已接受刷新后让解释失败。 */
  readonly sourceInterpreterFailureState?: { enabled: boolean };
  /** 可在来源解释完成后让识别失败。 */
  readonly recognizerFailureState?: { enabled: boolean };
  /** 可在观察者坐标持久冻结后让观察者失败。 */
  readonly observerFailureState?: { enabled: boolean };
  /** 模拟适配器尝试夹带未绑定的快照位置。 */
  readonly spoofedSnapshotRoot?: string;
  /** 确保采集器在网络 I/O 前观察其真实坐标。 */
  readonly requireCollectorCoordinateBeforeInvocation?: boolean;
  /** 确保观察者在文件系统 I/O 前观察其坐标。 */
  readonly requireObserverCoordinateBeforeInvocation?: boolean;
  /** 在来源刷新范围开始后暂停普通采集。 */
  readonly collectionBarrier?: () => Promise<void>;
  /**
   * 观察者拥有的结构证据。测试用它验证别名，而不让应用层了解任何文件系统特定命名约定。
   */
  readonly observedFiles?: readonly {
    readonly relativePath: string;
    readonly size: number;
    readonly objectIdentity?: import("../src/index.ts").FilesystemObjectIdentity;
  }[];
  readonly objectIdentityContract?: FilesystemObjectIdentityContract;
  /** 精确已观察产物复用端口的测试接缝。 */
  readonly observedArtifactReuseMatch?: import("../src/index.ts").ObservedArtifactReuseMatch;
  readonly observedScopeTracker?: {
    resolveCalls: number;
    rebindCalls: number;
    closeCalls: number;
  };
  readonly rebindScopeFailure?: Error;
}) {
  const executions: WorkflowExecution[] = [];
  const retained = [] as string[];
  const accepted = [] as NonNullable<ExecutionInspection["accepted"]>[];
  let collectionCalls = 0;
  let directoryInterpretations = 0;
  let observerCalls = 0;
  let acquisitionCalls = 0;
  let managedStoreCalls = 0;
  let formatInspectionCalls = 0;
  let changedDuringChangeBaseline = false;
  let observedPartAcquisitionCalls = 0;
  let recognitionAcceptanceCalls = 0;
  let lastOrdinaryReuseAvailability:
    | import("../src/index.ts").WorkflowCompatibility
    | undefined;
  const enrichmentCollectionCalls = new Map<string, number>();
  let managedStoreBarrierUsed = false;
  let acceptanceBarrierUsed = false;
  let lineageFrozen = false;
  const persisted = new Map<string, ExecutionInspection>();
  const libraryScanDirectories = new Map<
    string,
    readonly LibraryScanDirectoryRecord[]
  >();
  /**
   * SQLite 复用只会看到识别决定仍为当前关联头的已接受执行。应将它与提案标识符区分开：
   * 夹具提案刻意复用简单 ID。
   */
  const currentRecognitionHeadExecutionByAsset = new Map<string, string>();
  const changePreviews = new Map<string, ChangeImpactPreview>();
  const automationIntents = new Map<
    string,
    import("../src/index.ts").AutomationIntent
  >();
  const activeAutomation = new Map<string, string>();
  const sourceRefreshRuns = new Map<
    string,
    import("@digital/domain").SourceRefreshRun
  >();
  const sourceRefreshRunExecutions = new Map<string, string>();
  const sourceRefreshInterpretations = new Map<
    string,
    import("@digital/domain").SourceInterpretationBatch
  >();
  let resumeClaimAttempts = 0;
  let resumeClaimReleases = 0;
  const resumeClaims = new Map<
    string,
    { readonly token: string; readonly expiresAt: string }
  >();
  const strictCasComparable = (execution: WorkflowExecution): string => {
    const { workItems, ...withoutWorkItems } = execution;
    return JSON.stringify({
      ...withoutWorkItems,
      selection: {
        ...execution.selection,
        intent: execution.selection.intent ?? "scan-now",
        informationRequirement:
          execution.selection.informationRequirement ??
          emptyInformationRequirement,
      },
      sourceRefreshRunIds: execution.sourceRefreshRunIds ?? [],
      sourceEnrichments: execution.sourceEnrichments ?? [],
      ...(workItems === undefined || workItems.length === 0
        ? {}
        : { workItems }),
    });
  };
  const validSourceFailureCodes = (value: unknown): boolean =>
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 16 &&
      value.every((item) => {
        if (
          typeof item !== "object" ||
          item === null ||
          Array.isArray(item) ||
          Object.keys(item).toSorted().join("\0") !== "capability\0code"
        )
          return false;
        const candidate = item as Record<string, unknown>;
        const capability = candidate.capability;
        return (
          typeof candidate.code === "string" &&
          candidate.code.length > 0 &&
          new TextEncoder().encode(candidate.code).byteLength <= 128 &&
          typeof capability === "object" &&
          capability !== null &&
          !Array.isArray(capability) &&
          Object.keys(capability).toSorted().join("\0") ===
            "capabilityId\0capabilityVersion\0contractVersion\0identity\0implementationVersion\0interpretationContractVersions\0kind" &&
          Object.values(capability).every((field) =>
            Array.isArray(field)
              ? field.length > 0 &&
                field.every(
                  (entry) =>
                    typeof entry === "string" &&
                    entry.trim().length > 0 &&
                    entry.length <= 240,
                )
              : typeof field === "string" &&
                field.trim().length > 0 &&
                field.length <= 240,
          )
        );
      }));
  const sourceRefreshFailureDispositionsAreConsistent = (
    run: import("@digital/domain").SourceRefreshRun,
    execution: WorkflowExecution,
  ): boolean => {
    const prefix = `source-refresh-failure:${run.id}:`;
    const reserved = execution.dispositions.filter((item) =>
      item.key.startsWith(prefix),
    );
    if (new Set(reserved.map((item) => item.key)).size !== reserved.length)
      return false;
    return reserved.every((disposition) => {
      const matches = run.scopes.filter(
        (scope) =>
          `source-refresh-failure:${run.id}:${scope.coverage.coverageId}:${scope.acquisitionAttempt}` ===
          disposition.key,
      );
      if (matches.length !== 1) return false;
      const scope = matches[0];
      return (
        scope.state === "terminal" &&
        (scope.outcome === "failed" || scope.outcome === "stale") &&
        disposition.status === "failed" &&
        disposition.reason === scope.reason
      );
    });
  };
  const persistence: RefreshFixturePersistence = {
    async claimResumeExecution({ executionId, token, now, expiresAt }) {
      resumeClaimAttempts += 1;
      const inspection = persisted.get(executionId);
      if (inspection?.execution.status !== "running") return "terminal";
      const current = resumeClaims.get(executionId);
      if (current !== undefined && current.expiresAt > now) return "busy";
      resumeClaims.set(executionId, { token, expiresAt });
      return "claimed";
    },
    async renewResumeExecutionClaim({ executionId, token, expiresAt }) {
      const current = resumeClaims.get(executionId);
      if (current?.token !== token) return false;
      resumeClaims.set(executionId, { token, expiresAt });
      return true;
    },
    async releaseResumeExecutionClaim({ executionId, token }) {
      resumeClaimReleases += 1;
      if (resumeClaims.get(executionId)?.token === token)
        resumeClaims.delete(executionId);
    },
    async createExecution(execution) {
      const intentId = execution.automationIntentId;
      if (intentId !== undefined) {
        const intent = automationIntents.get(intentId);
        const trigger = execution.workflowInput?.trigger ?? execution.trigger;
        if (intent === undefined || (trigger !== "scan-now" && !intent.enabled))
          return "disabled";
        if (activeAutomation.has(intentId)) return "skipped";
        activeAutomation.set(intentId, execution.id);
      }
      executions.push(execution);
      persisted.set(execution.id, { execution, sourceRecords: [] });
      return "started";
    },
    async createLibraryScan({ execution, directories }) {
      const started = await persistence.createExecution(execution);
      if (started === "started")
        libraryScanDirectories.set(execution.id, directories);
      return started;
    },
    async registerLibraryScanChild({
      parentExecutionId,
      directoryKey,
      execution,
    }) {
      const parent = persisted.get(parentExecutionId)?.execution;
      const directories = libraryScanDirectories.get(parentExecutionId);
      const entry = directories?.find(
        (directory) => directory.directoryKey === directoryKey,
      );
      if (parent?.status !== "running" || parent.cancellation !== undefined)
        return "cancelled";
      if (entry === undefined) throw new Error("测试目录没有父扫描归属");
      if (entry.childExecutionId !== undefined) return "already-registered";
      executions.push(execution);
      persisted.set(execution.id, { execution, sourceRecords: [] });
      libraryScanDirectories.set(
        parentExecutionId,
        directories!.map((directory) =>
          directory.directoryKey === directoryKey ||
          directory.executedByDirectoryKey === directoryKey
            ? { ...directory, childExecutionId: execution.id, stage: "running" }
            : directory,
        ),
      );
      return "registered";
    },
    async recordLibraryScanDirectoryResult({
      parentExecutionId,
      directoryKey,
      ...result
    }) {
      const directories = libraryScanDirectories.get(parentExecutionId);
      if (!directories?.some((entry) => entry.directoryKey === directoryKey))
        throw new Error("测试目录没有父扫描归属");
      libraryScanDirectories.set(
        parentExecutionId,
        directories.map((entry) =>
          entry.directoryKey === directoryKey ? { ...entry, ...result } : entry,
        ),
      );
    },
    async inspectLibraryScan(parentExecutionId) {
      const parent = persisted.get(parentExecutionId)?.execution;
      const directories = libraryScanDirectories.get(parentExecutionId);
      const snapshot = parent?.workflowInput?.assetLibrary;
      if (
        parent === undefined ||
        directories === undefined ||
        snapshot === undefined
      )
        return undefined;
      return {
        parentExecutionId,
        assetLibraryId: snapshot.id,
        configVersion: snapshot.configVersion,
        status: parent.status,
        ...(parent.outcome === undefined ? {} : { outcome: parent.outcome }),
        directories,
      };
    },
    async retainSourceRecords({ expectedExecution, execution, sourceRecords }) {
      retained.push(...sourceRecords.map((record) => record.id));
      const inspection = persisted.get(expectedExecution.id)!;
      if (
        JSON.stringify(inspection.execution) !==
        JSON.stringify(expectedExecution)
      )
        throw new Error("stale Source Record checkpoint");
      persisted.set(expectedExecution.id, {
        ...inspection,
        execution,
        sourceRecords: [
          ...new Map(
            [...inspection.sourceRecords, ...sourceRecords].map((record) => [
              record.id,
              record,
            ]),
          ).values(),
        ],
      });
    },
    async commitSourceRefreshCollectionFailure(input) {
      const inspection = persisted.get(input.expectedExecution.id);
      const run = sourceRefreshRuns.get(input.runId);
      const owner = sourceRefreshRunExecutions.get(input.runId);
      if (
        inspection === undefined ||
        run === undefined ||
        owner !== input.expectedExecution.id ||
        !input.expectedExecution.sourceRefreshRunIds?.includes(input.runId)
      )
        throw new Error("Source Refresh collection failure owner is invalid");
      if (!validSourceFailureCodes(input.sourceFailureCodes))
        throw new Error(
          "Source Refresh collection failure codes are malformed",
        );
      if (
        !sourceRefreshFailureDispositionsAreConsistent(
          run,
          inspection.execution,
        )
      )
        throw new Error("Source Refresh collection failure split state");
      const expectedKey = `source-refresh-failure:${run.id}:${input.coverage.coverageId}:${input.acquisitionAttempt}`;
      if (input.idempotencyKey !== expectedKey)
        throw new Error("Source Refresh collection failure key is invalid");
      const scope = run.scopes.find(
        (candidate) =>
          JSON.stringify(candidate.coverage) === JSON.stringify(input.coverage),
      );
      const claim = resumeClaims.get(input.expectedExecution.id);
      const existingDisposition = inspection.execution.dispositions.find(
        (item) => item.key === expectedKey,
      );
      if (scope?.state === "terminal") {
        if (
          (claim !== undefined || input.resumeClaim !== undefined) &&
          (input.resumeClaim === undefined ||
            claim?.token !== input.resumeClaim.token ||
            claim.expiresAt <= input.resumeClaim.now)
        )
          throw new Error("stale resume claim");
        if (
          scope.acquisitionAttempt === input.acquisitionAttempt &&
          scope.outcome === input.outcome &&
          scope.reason === input.reason &&
          existingDisposition?.status === "failed" &&
          existingDisposition.reason === input.reason &&
          JSON.stringify(existingDisposition.sourceFailureCodes) ===
            JSON.stringify(input.sourceFailureCodes)
        )
          return { execution: inspection.execution, run };
        throw new Error("Source Refresh collection failure replay conflicts");
      }
      if (
        (claim !== undefined || input.resumeClaim !== undefined) &&
        (input.resumeClaim === undefined ||
          claim?.token !== input.resumeClaim.token ||
          claim.expiresAt <= input.resumeClaim.now)
      )
        throw new Error("stale resume claim");
      if (existingDisposition !== undefined)
        throw new Error("Source Refresh collection failure split state");
      if (
        scope?.state !== "acquiring" ||
        scope.acquisitionAttempt !== input.acquisitionAttempt ||
        JSON.stringify(inspection.execution) !==
          JSON.stringify(input.expectedExecution)
      )
        throw new Error("stale Source Refresh collection failure");
      const nextRun = failSourceRefreshScope(run, {
        coverage: input.coverage,
        outcome: input.outcome,
        reason: input.reason,
      });
      const nextExecution = {
        ...input.expectedExecution,
        dispositions: [
          ...input.expectedExecution.dispositions.filter(
            (item) => item.key !== input.idempotencyKey,
          ),
          {
            key: input.idempotencyKey,
            status: "failed" as const,
            reason: input.reason,
            ...(input.sourceFailureCodes === undefined
              ? {}
              : { sourceFailureCodes: input.sourceFailureCodes }),
          },
        ],
      };
      const nextInspection = {
        ...inspection,
        execution: nextExecution,
        sourceRefreshRuns: [
          ...(inspection.sourceRefreshRuns ?? []).filter(
            (current) => current.id !== nextRun.id,
          ),
          nextRun,
        ],
      };
      sourceRefreshRuns.set(nextRun.id, nextRun);
      persisted.set(input.expectedExecution.id, nextInspection);
      return { execution: nextExecution, run: nextRun };
    },
    async finishExecution(_expectedExecution, execution) {
      executions.push(execution);
      const inspection = persisted.get(execution.id)!;
      persisted.set(execution.id, { ...inspection, execution });
    },
    async cancelExecution({ expectedExecution, execution }) {
      const inspection = persisted.get(expectedExecution.id);
      if (
        inspection === undefined ||
        inspection.execution.status !== "running" ||
        JSON.stringify(inspection.execution) !==
          JSON.stringify(expectedExecution)
      )
        throw new Error("stale or terminal execution cancellation");
      executions.push(execution);
      persisted.set(execution.id, { ...inspection, execution });
    },
    async transitionExecution(expected, next) {
      if (
        options?.transitionFailsWhenAcquirerFrozen === true &&
        !expected.compatibility.capabilityCoordinates.includes(
          "acquirer@1/1",
        ) &&
        next.compatibility.capabilityCoordinates.includes("acquirer@1/1")
      )
        throw new Error("acquirer freeze persistence failed");
      const inspection = persisted.get(expected.id);
      if (
        inspection === undefined ||
        (options?.strictExecutionCas === true &&
          strictCasComparable(inspection.execution) !==
            strictCasComparable(expected)) ||
        inspection.execution.status !== expected.status ||
        inspection.execution.stage !== expected.stage ||
        inspection.execution.status !== "running"
      )
        throw new Error("stale or terminal execution transition");
      executions.push(next);
      persisted.set(next.id, { ...inspection, execution: next });
    },
    async finishExecutionWithProposal(_expectedExecution, execution, proposal) {
      executions.push(execution);
      const inspection = persisted.get(execution.id)!;
      persisted.set(execution.id, { ...inspection, execution, proposal });
    },
    async finishExecutionWithChangeImpactPreview({
      execution,
      proposal,
      preview,
    }) {
      executions.push(execution);
      const inspection = persisted.get(execution.id)!;
      persisted.set(execution.id, { ...inspection, execution, proposal });
      changePreviews.set(preview.id, preview);
    },
    async finishExecutionWithSourceAssociationPreview({
      expectedExecution,
      execution,
      preview,
    }) {
      const inspection = persisted.get(expectedExecution.id)!;
      persisted.set(execution.id, { ...inspection, execution });
      changePreviews.set(preview.id, preview);
    },
    async finishExecutionWithRecognitionRetractionPreview({
      expectedExecution,
      execution,
      preview,
    }) {
      const inspection = persisted.get(expectedExecution.id)!;
      persisted.set(execution.id, { ...inspection, execution });
      changePreviews.set(preview.id, preview);
    },
    async acceptRecognition(input) {
      recognitionAcceptanceCalls += 1;
      if (options?.acceptanceBarrier !== undefined && !acceptanceBarrierUsed) {
        acceptanceBarrierUsed = true;
        await options.acceptanceBarrier();
      }
      if (options?.catalogueFails === true)
        throw new Error("catalogue unavailable");
      if (
        options?.strictExecutionCas === true &&
        (persisted.get(input.execution.id)?.execution === undefined ||
          strictCasComparable(persisted.get(input.execution.id)!.execution) !==
            strictCasComparable(input.expectedExecution))
      )
        throw new Error("stale recognition acceptance");
      const acceptedValue =
        options?.includeForeignAndUserFacts === true
          ? {
              ...input.accepted,
              metadata: [
                ...input.accepted.metadata,
                {
                  target: {
                    kind: "entity" as const,
                    entityId: input.accepted.entity.id,
                  },
                  property: "user.note",
                  sourceSlot: "user.note",
                  value: "keep me",
                  sourceRecordIds: ["user-record"],
                },
              ],
              entities: [
                ...(input.accepted.entities ?? []),
                {
                  id: "foreign-entity",
                  kind: "entity" as const,
                  sourceIdentity: "other-source",
                  sourceKey: "foreign",
                  identityNamespace: "other.entity",
                  label: "Foreign entity",
                  sourceRecordIds: ["other-record"],
                },
              ],
              relationships: [
                ...(input.accepted.relationships ?? []),
                {
                  id: "foreign-relationship",
                  participants: [
                    { entityId: input.accepted.entity.id, role: "asset" },
                    { entityId: "foreign-entity", role: "other.role" },
                  ],
                  type: "asset.contribution" as const,
                  sourceSlot: "other.relationship",
                  sourceRecordIds: ["other-record"],
                },
              ],
              relationshipReadBasis: {
                targets: [
                  {
                    relationshipId: "foreign-relationship",
                    target: {
                      kind: "source" as const,
                      sourceSubjectId: input.accepted.entity.id,
                      sourceIdentity: "other-source",
                      nativeAddress: "https://other.example/foreign",
                      coverageId: "other-official",
                      sourceSlot: "other.relationship",
                    },
                  },
                ],
                decisions: [],
                manualRelationshipIds: [],
              },
              artifacts: [...input.accepted.artifacts, { id: "user-artifact" }],
              locations: [
                ...input.accepted.locations,
                {
                  id: "user-location",
                  artifactId: "user-artifact",
                  address: "/managed/user-artifact",
                  kind: "managed" as const,
                },
              ],
              artifactAssociations: [
                ...input.accepted.artifactAssociations,
                {
                  id: "user-artifact-association",
                  target: {
                    kind: "entity" as const,
                    entityId: input.accepted.entity.id,
                  },
                  artifactId: "user-artifact",
                  role: "future.unknown-role",
                  sourceRecordIds: ["user-record"],
                },
              ],
            }
          : input.accepted;
      const enrolled = acceptedValue;
      const currentSources =
        options?.multiAssociationRefresh === true
          ? {
              ...enrolled,
              sourceAssociations: [
                enrolled.recognitionSourceAssociation!,
                {
                  ...enrolled.recognitionSourceAssociation!,
                  id: "supplementary-source-association",
                  nativeAddress: "https://source.example/supplementary-work",
                  proposalId: "supplementary-proposal",
                },
              ],
            }
          : enrolled;
      accepted.push(currentSources);
      currentRecognitionHeadExecutionByAsset.set(
        currentSources.entity.id,
        input.execution.id,
      );
      const inspection = persisted.get(input.execution.id)!;
      persisted.set(input.execution.id, {
        ...inspection,
        execution: input.execution,
        accepted: currentSources,
        proposal: currentSources.proposal,
        ...(input.execution.workItems === undefined
          ? {}
          : {
              workItemInspections: input.execution.workItems
                .filter(
                  (item) =>
                    item.acceptedAssetId !== undefined &&
                    item.proposalId !== undefined,
                )
                .map((item) =>
                  item.acceptedAssetId === currentSources.entity.id
                    ? {
                        workItem: item,
                        proposal: currentSources.proposal,
                        accepted: currentSources,
                      }
                    : {
                        ...inspection.workItemInspections?.find(
                          (previous) => previous.workItem.key === item.key,
                        ),
                        workItem: item,
                      },
                ),
            }),
      });
    },
    async inspectExecution(executionId) {
      return persisted.get(executionId);
    },
    async listExecutions() {
      return [...persisted.values()].map((inspection) => inspection.execution);
    },
    async listRunningExecutions() {
      return [...persisted.values()]
        .map((inspection) => inspection.execution)
        .filter((execution) => execution.status === "running");
    },
    async findReusableOrdinaryScan({ plan, availableCompatibility }) {
      lastOrdinaryReuseAvailability = availableCompatibility;
      for (const inspection of [...persisted.values()].toReversed()) {
        if (
          (inspection.execution.outcome === "accepted" ||
            inspection.execution.outcome === "partially-succeeded") &&
          inspection.execution.acceptedAssetId !== undefined &&
          currentRecognitionHeadExecutionByAsset.get(
            inspection.execution.acceptedAssetId,
          ) === inspection.execution.id &&
          inspection.execution.proposalId ===
            inspection.accepted?.proposal.id &&
          inspection.execution.reusePlan !== undefined &&
          JSON.stringify(inspection.execution.reusePlan) ===
            JSON.stringify(plan) &&
          workflowCompatibilityCanReuse(
            inspection.execution.compatibility,
            availableCompatibility,
          )
        )
          return inspection.execution;
      }
      return options?.reusable === true
        ? {
            id: "prior-execution",
            selection: { directory: "/observed/work", intent: "scan-now" },
            snapshot: {
              id: "prior-snapshot",
              root: "/observed/work",
              complete: true,
              excluded: [],
              files: [],
              observedAt: "2026-07-29T00:00:00.000Z",
            },
            status: "completed",
            stage: "completed",
            outcome: "accepted",
            sourceRecordIds: [],
            acceptedAssetId: "asset",
            compatibility: {
              workflowVersion: "asset-refresh/2",
              policyVersion: availableCompatibility.policyVersion,
              capabilityCoordinates: ["filesystem-observer@1/1"],
            },
            dispositions: [],
          }
        : undefined;
    },
    async findAcceptedForDirectory(directory) {
      for (const inspection of [...persisted.values()].toReversed()) {
        if (
          inspection.execution.selection.directory === directory &&
          inspection.accepted !== undefined
        ) {
          return {
            execution: inspection.execution,
            accepted: inspection.accepted,
          };
        }
      }
      return undefined;
    },
    async findAcceptedForSubjects(subjectIds) {
      return subjectIds.flatMap((subjectId) => {
        const acceptedValue = accepted.find(
          (candidate) => candidate.entity.id === subjectId,
        );
        if (acceptedValue === undefined) return [];
        const inspection = [...persisted.values()]
          .toReversed()
          .find(
            (candidate) =>
              candidate.accepted?.entity.id === subjectId ||
              candidate.execution.workItems?.some(
                (item) => item.acceptedAssetId === subjectId,
              ),
          );
        return inspection === undefined
          ? []
          : [
              {
                subjectId,
                accepted: acceptedValue,
                execution: inspection.execution,
              },
            ];
      });
    },
    /**
     * 与 SQLite 同一语义：只有范围引用仍能解析到一份登记观察根、且该决定仍留在当前
     * 已接受状态里的声明才算生效；再按与本次刷新范围是否相交筛除无关根。
     */
    async listEffectiveMaterialBoundaries({ scope, relativeScope }) {
      const address = path.resolve(scope.containerPath, relativeScope);
      const members = await Promise.all(
        accepted.flatMap((item) =>
          item.recognitionDecision.boundaries.map(async (boundary) => {
            const registration =
              await observedRootStore.queries.getObservedRootRegistration(
                boundary.scopeReference,
              );
            if (registration === undefined) return undefined;
            const candidate: EffectiveRecognitionMaterialBoundary = {
              assetId: item.entity.id,
              decisionId: item.recognitionDecision.id,
              boundary,
              rootPath: registration.containerPath,
            };
            return recognitionMaterialBoundaryIntersectsScope(
              candidate,
              address,
            )
              ? candidate
              : undefined;
          }),
        ),
      );
      return members.filter(
        (member): member is EffectiveRecognitionMaterialBoundary =>
          member !== undefined,
      );
    },
    /**
     * 与 SQLite 同一语义：被点名决定只由形成其提案的那次执行代表，并返回该主体当前
     * 仍生效的已接受投影。缺这份读取时逐决定复用会诚实停下，夹具必须提供而不是省略。
     */
    async findAcceptedForDecision({ decisionId }) {
      const acceptedValue = accepted.find(
        (current) => current.recognitionDecision.id === decisionId,
      );
      if (acceptedValue === undefined) return undefined;
      // 被点名决定的比较基线只能是它自己那次扫描的观察：只有携带耐久文件系统
      // snapshot 的执行才真正代表那次观察（生产 index.ts:17963-17979 要求
      // decisionObservation.execution.snapshot）。同名提案可能散落在多次执行里，
      // 必须优先挑出确实带有 snapshot 的那一份，而不是随手取最近一条无观察的执行。
      const matches = [...persisted.values()]
        .toReversed()
        .filter(
          (candidate) =>
            candidate.proposal?.id === acceptedValue.proposal.id ||
            candidate.workItemInspections?.some(
              (item) => item.proposal?.id === acceptedValue.proposal.id,
            ),
        );
      const inspection =
        matches.find(
          (candidate) => candidate.execution.snapshot !== undefined,
        ) ?? matches[0];
      return inspection === undefined
        ? undefined
        : {
            accepted: acceptedValue,
            proposal: acceptedValue.proposal,
            execution: inspection.execution,
          };
    },
    async findCurrentSourceAssociationByCoordinate(input) {
      return accepted
        .flatMap((item) => item.sourceAssociations)
        .find(
          (association) =>
            association.sourceIdentity === input.sourceIdentity &&
            association.nativeAddress === input.nativeAddress,
        );
    },
    async inspectSourceAssociationHistory(assetId) {
      const current = accepted.find((item) => item.entity.id === assetId);
      return current === undefined
        ? undefined
        : {
            recognitionState: "recognized" as const,
            recognitionDecisionId: current.recognitionDecision.id,
            current: current.sourceAssociations,
            historical: [],
          };
    },
    async findCurrentAcceptedForObservedArtifacts() {
      return (
        options?.observedArtifactReuseMatch ?? {
          status: "none" as const,
        }
      );
    },
    async findReusableWorkItem({
      directory,
      relativePaths,
      availableCompatibility,
      reuseFingerprint,
    }) {
      const expected = [...relativePaths].toSorted((left, right) =>
        left.localeCompare(right),
      );
      for (const inspection of [...persisted.values()].toReversed()) {
        if (
          inspection.execution.selection.directory !== directory ||
          inspection.execution.workItems === undefined
        )
          continue;
        const item = inspection.execution.workItems?.find(
          (current) =>
            current.acceptedAssetId !== undefined &&
            current.proposalId !== undefined &&
            current.reuseFingerprint === reuseFingerprint &&
            JSON.stringify(
              [...current.relativePaths].toSorted((left, right) =>
                left.localeCompare(right),
              ),
            ) === JSON.stringify(expected),
        );
        const acceptedValue = accepted.find(
          (current) => current.entity.id === item?.acceptedAssetId,
        );
        if (
          item !== undefined &&
          item.reuseCompatibility !== undefined &&
          workflowCompatibilityCanReuse(
            item.reuseCompatibility,
            availableCompatibility,
          ) &&
          acceptedValue !== undefined
        )
          return {
            execution: inspection.execution,
            accepted: acceptedValue,
            reuseCompatibility: item.reuseCompatibility,
          };
      }
      return undefined;
    },
    async findAcceptedForWorkItem({ directory, relativePaths }) {
      const expected = JSON.stringify(
        [...relativePaths].toSorted((left, right) => left.localeCompare(right)),
      );
      for (const inspection of [...persisted.values()].toReversed()) {
        if (inspection.execution.selection.directory !== directory) continue;
        const item = inspection.execution.workItems?.find(
          (current) =>
            current.acceptedAssetId !== undefined &&
            JSON.stringify(
              [...current.relativePaths].toSorted((left, right) =>
                left.localeCompare(right),
              ),
            ) === expected,
        );
        const acceptedAssetId =
          item?.acceptedAssetId ??
          ((inspection.execution.workItems === undefined ||
            inspection.execution.workItems.length === 0) &&
          inspection.execution.snapshot !== undefined &&
          JSON.stringify(
            inspection.execution.snapshot.files
              .map((file) => file.relativePath)
              .toSorted((left, right) => left.localeCompare(right)),
          ) === expected
            ? inspection.execution.acceptedAssetId
            : undefined);
        const acceptedValue = accepted.find(
          (current) => current.entity.id === acceptedAssetId,
        );
        if (acceptedAssetId !== undefined && acceptedValue !== undefined)
          return { execution: inspection.execution, accepted: acceptedValue };
      }
      return undefined;
    },
    async refreshAcceptedRecognition({ execution, current, accepted: next }) {
      const index = accepted.findIndex(
        (candidate) => candidate.entity.id === current.entity.id,
      );
      if (index < 0) throw new Error("current accepted identity disappeared");
      // accepted-boundary 是本地观察写批次；SQLite 只替换本地事实，保留来源与人工事实。
      const projected =
        next.proposal.basis.kind === "accepted-boundary"
          ? {
              ...next,
              metadata: [
                ...current.metadata.filter(
                  (fact) =>
                    fact.sourceRecordIds.length > 0 ||
                    fact.authoredBy !== undefined ||
                    fact.observedArtifactPart === undefined,
                ),
                ...next.metadata,
              ],
            }
          : next;
      accepted[index] = projected;
      currentRecognitionHeadExecutionByAsset.set(next.entity.id, execution.id);
      const inspection = persisted.get(execution.id)!;
      persisted.set(execution.id, {
        ...inspection,
        execution,
        proposal: next.proposal,
        accepted: projected,
        workItemInspections: execution.workItems?.map((item) =>
          item.acceptedAssetId === next.entity.id
            ? { workItem: item, proposal: next.proposal, accepted: projected }
            : {
                ...inspection.workItemInspections?.find(
                  (previous) => previous.workItem.key === item.key,
                ),
                workItem: item,
              },
        ),
      });
    },
    async applyMetadataRefresh({ execution, submission }) {
      const inspection = persisted.get(execution.id)!;
      const prior = accepted.find(
        (candidate) => candidate.entity.id === submission.assetId,
      );
      persisted.set(execution.id, {
        ...inspection,
        execution,
        ...(prior === undefined
          ? {}
          : {
              accepted: {
                ...prior,
                metadata: bindSourceMetadata(
                  submission.interpretation.metadata,
                  submission.assetId,
                ),
              },
            }),
      });
    },
    async freezeSourceLineageHeads({ sourceAssociation, coverageIds }) {
      lineageFrozen = true;
      return coverageIds.map((coverageId) => ({
        sourceIdentity: sourceAssociation.sourceIdentity,
        nativeAddress: sourceAssociation.nativeAddress,
        coverageId,
      }));
    },
    async inspectChangeImpactPreview(previewId) {
      return changePreviews.get(previewId);
    },
    async inspectChangeImpactPreviewForExecution(executionId) {
      return [...changePreviews.values()].find(
        (preview) => preview.executionId === executionId,
      );
    },
    async freezeChangeImpactBaseline() {
      if (
        options?.mutateAcceptedDuringChangeBaseline === true &&
        !changedDuringChangeBaseline &&
        accepted[0] !== undefined
      ) {
        changedDuringChangeBaseline = true;
        accepted[0] = {
          ...accepted[0],
          metadata: [
            ...accepted[0].metadata,
            {
              property: "user.note",
              sourceSlot: "user.note",
              value: "并发用户事实",
              sourceRecordIds: [],
              authoredBy: {
                initiatedBy: "reviewer",
                proposalId: "manual-concurrent",
              },
            },
          ],
        };
      }
      return "complete-current-projection";
    },
    async applyChangeImpactPreview({ preview, plan }) {
      const stored = changePreviews.get(preview.id);
      if (stored === undefined || stored.status !== "awaiting-confirmation")
        return "stale";
      changePreviews.set(preview.id, { ...stored, status: "applied" });
      currentRecognitionHeadExecutionByAsset.set(
        preview.assetId,
        preview.executionId,
      );
      for (const [executionId, inspection] of persisted) {
        if (inspection.accepted?.entity.id !== preview.assetId) continue;
        persisted.set(executionId, {
          ...inspection,
          proposal: preview.proposal,
          accepted: {
            ...inspection.accepted,
            proposal: preview.proposal,
            sourceAssociations: preview.projected.sourceAssociations.map(
              (association, index) => ({
                id: `preview-association-${index}`,
                subjectId: preview.assetId,
                proposalId: preview.proposal.id,
                ...association,
              }),
            ),
            ...(plan.recognitionSourceAssociation === undefined
              ? { recognitionSourceAssociation: undefined }
              : {
                  recognitionSourceAssociation:
                    plan.recognitionSourceAssociation,
                }),
            recognitionDecision: plan.successorDecision,
            metadata: preview.projected.metadata,
            entities: preview.projected.entities,
            entityMentions: preview.projected.entityMentions,
            entityResolutionDecisions:
              preview.projected.entityResolutionDecisions,
            relationships: preview.projected.relationships,
            artifacts: preview.projected.artifacts,
            locations: preview.projected.locations,
            blobs: preview.projected.blobs,
            artifactRevisions: preview.projected.artifactRevisions,
            artifactAssociations: preview.projected.artifactAssociations,
          },
        });
      }
      const acceptedIndex = accepted.findIndex(
        ({ entity }) => entity.id === preview.assetId,
      );
      const acceptedValue = accepted[acceptedIndex];
      if (acceptedValue !== undefined)
        accepted[acceptedIndex] = {
          ...acceptedValue,
          proposal: preview.proposal,
          recognitionDecision: plan.successorDecision,
          sourceAssociations: preview.projected.sourceAssociations.map(
            (association, index) => ({
              id: `preview-association-${index}`,
              subjectId: preview.assetId,
              proposalId: preview.proposal.id,
              ...association,
            }),
          ),
          ...(plan.recognitionSourceAssociation === undefined
            ? { recognitionSourceAssociation: undefined }
            : {
                recognitionSourceAssociation: plan.recognitionSourceAssociation,
              }),
          metadata: preview.projected.metadata,
          entities: preview.projected.entities,
          entityMentions: preview.projected.entityMentions,
          entityResolutionDecisions:
            preview.projected.entityResolutionDecisions,
          relationships: preview.projected.relationships,
          artifacts: preview.projected.artifacts,
          locations: preview.projected.locations,
          blobs: preview.projected.blobs,
          artifactRevisions: preview.projected.artifactRevisions,
          artifactAssociations: preview.projected.artifactAssociations,
        };
      return "applied";
    },
    async rejectChangeImpactPreview({ previewId }) {
      const preview = changePreviews.get(previewId);
      if (preview === undefined || preview.status !== "awaiting-confirmation")
        return "stale";
      changePreviews.set(previewId, { ...preview, status: "rejected" });
      const inspection = persisted.get(preview.executionId);
      if (inspection?.execution.sourceAssociationDecision !== undefined)
        persisted.set(preview.executionId, {
          ...inspection,
          execution: {
            ...inspection.execution,
            status: "completed",
            stage: "completed",
            outcome: "cancelled",
            sourceAssociationDecision: {
              ...inspection.execution.sourceAssociationDecision,
              state: "rejected",
            },
          },
        });
      return "rejected";
    },
    async createAutomationIntentForObservedRoot({ intent }) {
      automationIntents.set(intent.id, intent);
      return { status: "created" as const };
    },
    async inspectAutomationIntent(intentId) {
      return automationIntents.get(intentId);
    },
    async listAutomationIntents() {
      return [...automationIntents.values()];
    },
    async listRunningAutomationExecutions() {
      return [...persisted.values()]
        .map((inspection) => inspection.execution)
        .filter(
          (execution) =>
            execution.status === "running" &&
            execution.automationIntentId !== undefined,
        );
    },
    async setAutomationIntentEnabled(intentId, enabled) {
      const intent = automationIntents.get(intentId);
      if (intent === undefined) throw new Error("missing intent");
      automationIntents.set(intentId, { ...intent, enabled });
    },
    async releaseAutomationTrigger({ intentId, executionId }) {
      if (activeAutomation.get(intentId) === executionId)
        activeAutomation.delete(intentId);
    },
  };
  const writeSourceRefreshRun = (
    run: import("@digital/domain").SourceRefreshRun,
  ) => {
    sourceRefreshRuns.set(run.id, run);
    const executionId = sourceRefreshRunExecutions.get(run.id);
    if (executionId === undefined) throw new Error("missing run execution");
    const inspection = persisted.get(executionId);
    if (inspection === undefined) throw new Error("missing run inspection");
    persisted.set(executionId, {
      ...inspection,
      sourceRefreshRuns: [
        ...(inspection.sourceRefreshRuns ?? []).filter(
          (current) => current.id !== run.id,
        ),
        run,
      ],
    });
  };
  const sourceRefreshRunPersistence: SourceRefreshRunPersistence | undefined =
    options?.sourceRefreshAuthority === true
      ? {
          async createSourceRefreshRun(input) {
            const run = createSourceRefreshRun(input.run);
            const inspection = persisted.get(input.executionId);
            if (inspection === undefined) throw new Error("missing execution");
            sourceRefreshRunExecutions.set(run.id, input.executionId);
            persisted.set(input.executionId, {
              ...inspection,
              execution: {
                ...inspection.execution,
                sourceRefreshRunIds: [
                  ...(inspection.execution.sourceRefreshRunIds ?? []),
                  run.id,
                ],
              },
            });
            writeSourceRefreshRun(run);
            return run;
          },
          async beginSourceRefreshScopeAcquisition(input) {
            const run = sourceRefreshRuns.get(input.runId);
            if (run === undefined)
              throw new Error("missing source refresh run");
            const next = beginSourceRefreshScopeAcquisition(
              run,
              input.coverage,
            );
            writeSourceRefreshRun(next);
            return next;
          },
          async stageSourceRefreshChangeSet(input) {
            const run = sourceRefreshRuns.get(input.runId);
            const executionId = sourceRefreshRunExecutions.get(input.runId);
            const record = persisted
              .get(executionId ?? "")
              ?.sourceRecords.find(
                (candidate) => candidate.id === input.candidateSourceRecordId,
              );
            if (run === undefined || record === undefined) {
              throw new Error("missing source refresh candidate");
            }
            const next = stageSourceRefreshChangeSet(run, {
              id: `source-refresh-change-set_${run.id}_${record.id}`,
              coverage: {
                sourceIdentity: record.sourceIdentity,
                nativeAddress: record.nativeAddress,
                coverageId: record.coverage.id,
              },
              candidateSourceRecordId: record.id,
              changes: input.interpretation.metadata.map((assertion) => ({
                kind: "superseded" as const,
                factReference: `metadata:${assertion.property}`,
              })),
              ...(input.requiresReview === true
                ? { requiresReview: true }
                : {}),
            });
            const changeSet = next.changeSets.find(
              (current) => current.candidateSourceRecordId === record.id,
            );
            if (changeSet === undefined) throw new Error("missing change set");
            sourceRefreshInterpretations.set(
              changeSet.id,
              input.interpretation,
            );
            writeSourceRefreshRun(next);
            return next;
          },
          async applySourceRefreshChangeSet(input) {
            const run = sourceRefreshRuns.get(input.runId);
            if (run === undefined)
              throw new Error("missing source refresh run");
            const next = completeSourceRefreshChangeSet(run, {
              changeSetId: input.changeSetId,
              outcome: "applied",
            });
            const executionId = sourceRefreshRunExecutions.get(input.runId)!;
            const interpretation = sourceRefreshInterpretations.get(
              input.changeSetId,
            );
            const prior = accepted.find(
              (candidate) =>
                candidate.entity.id === next.requestedSelection.subjectId,
            );
            if (prior !== undefined && interpretation !== undefined) {
              const refreshed = {
                ...prior,
                metadata: bindSourceMetadata(
                  interpretation.metadata,
                  prior.entity.id,
                ),
              };
              const index = accepted.indexOf(prior);
              accepted[index] = refreshed;
              const inspection = persisted.get(executionId)!;
              persisted.set(executionId, {
                ...inspection,
                accepted: refreshed,
              });
            }
            writeSourceRefreshRun(next);
            return next;
          },
          async reviewSourceRefreshChangeSet(input) {
            const run = sourceRefreshRuns.get(input.runId);
            if (run === undefined)
              throw new Error("missing source refresh run");
            const next = reviewSourceRefreshChangeSet(run, input);
            writeSourceRefreshRun(next);
            return next;
          },
          async failSourceRefreshScope(input) {
            const run = sourceRefreshRuns.get(input.runId);
            if (run === undefined)
              throw new Error("missing source refresh run");
            const next = failSourceRefreshScope(run, input);
            writeSourceRefreshRun(next);
            return next;
          },
          async cancelSourceRefreshRun(runId) {
            const run = sourceRefreshRuns.get(runId);
            if (run === undefined)
              throw new Error("missing source refresh run");
            const next = cancelSourceRefreshRun(run);
            writeSourceRefreshRun(next);
            return next;
          },
          async inspectSourceRefreshRun(runId) {
            return sourceRefreshRuns.get(runId);
          },
        }
      : undefined;
  const recoverySourceRefreshRunCommands:
    | RecoverySourceRefreshRunCommands
    | undefined =
    sourceRefreshRunPersistence === undefined
      ? undefined
      : {
          async cancelUncommittedRun({ executionId, runId, resumeClaim }) {
            const claim = resumeClaims.get(executionId);
            if (
              claim?.token !== resumeClaim.token ||
              claim.expiresAt <= resumeClaim.now
            ) {
              throw new Error(
                `Execution ${executionId} rejected a stale resume claim`,
              );
            }
            if (sourceRefreshRunExecutions.get(runId) !== executionId) {
              throw new Error(
                `Source Refresh Run ${runId} does not belong to Workflow Execution ${executionId}`,
              );
            }
            const inspection = persisted.get(executionId);
            if (!inspection?.execution.sourceRefreshRunIds?.includes(runId)) {
              throw new Error(
                `Workflow Execution ${executionId} does not reference Source Refresh Run ${runId}`,
              );
            }
            const run = sourceRefreshRuns.get(runId);
            if (run === undefined)
              throw new Error("missing source refresh run");
            const next = cancelSourceRefreshRun(run);
            writeSourceRefreshRun(next);
            return next;
          },
        };
  const observedFilesystem = new InMemoryObservedFilesystemCapability({
    capability: {
      capabilityId: "filesystem-observer",
      capabilityVersion: "1",
      contractVersion: "1",
    },
    ...(options?.objectIdentityContract === undefined
      ? {}
      : { objectIdentityContract: options.objectIdentityContract }),
    onClose: () => {
      if (options?.observedScopeTracker !== undefined)
        options.observedScopeTracker.closeCalls += 1;
    },
    async observe({ scope }) {
      const directory = scope.logicalLocation;
      observerCalls += 1;
      if (options?.requireObserverCoordinateBeforeInvocation === true) {
        const current = [...persisted.values()].at(-1)?.execution;
        if (
          !current?.compatibility.capabilityCoordinates.includes(
            "filesystem-observer@1/1",
          )
        ) {
          throw new Error("observer coordinate was not durably frozen");
        }
      }
      if (options?.observerFailureState?.enabled === true)
        throw new Error("observer exploded");
      return {
        id: "snapshot",
        root: options?.spoofedSnapshotRoot ?? directory,
        complete: options?.incompleteSnapshot !== true,
        excluded: [],
        observedAt: "2026-07-29T00:00:00.000Z",
        files: options?.observedFiles ?? [
          {
            relativePath: "track.flac",
            size: 12,
            modifiedAt: `2026-07-29T00:00:0${options?.snapshotVersion?.("track.flac") ?? 0}.000Z`,
          },
          ...(options?.independentEvidence === true
            ? [
                {
                  relativePath: "other.flac",
                  size: 13,
                  modifiedAt: `2026-07-29T00:00:0${options?.snapshotVersion?.("other.flac") ?? 0}.000Z`,
                },
                ...(options?.thirdIndependentBoundary === true
                  ? [
                      {
                        relativePath: "third.flac",
                        size: 14,
                        modifiedAt: "2026-07-29T00:00:00.000Z",
                      },
                    ]
                  : []),
              ]
            : []),
        ],
      };
    },
  });
  const observedRootStore =
    new InMemoryObservedRootRegistrationStore<ObservedRootRegistration>(
      [fixtureObservedRootRegistration("fixture-root")],
      {
        libraries: [
          {
            id: "library-fixture",
            status: "active" as const,
            rootIds: ["fixture-root"],
          },
        ],
      },
    );
  const observedRootCleanupReporter = new InMemoryObservedRootCleanupReporter();
  const observedRootRegistrations = new ObservedRootRegistrations({
    commands: observedRootStore.commands,
    queries: observedRootStore.queries,
    filesystem: observedFilesystem,
    productDataDirectory: "/product-data",
    managedArtifactDirectory: "/product-data/managed-artifacts",
    cleanupFailureReporter: observedRootCleanupReporter,
    cleanupFailureFallback: observedRootCleanupReporter,
  });
  if (options?.observedScopeTracker !== undefined) {
    const resolveActiveScope =
      observedRootRegistrations.resolveActiveScope.bind(
        observedRootRegistrations,
      );
    observedRootRegistrations.resolveActiveScope = async (input) => {
      options.observedScopeTracker!.resolveCalls += 1;
      return await resolveActiveScope(input);
    };
    const rebindFrozenScope = observedRootRegistrations.rebindFrozenScope.bind(
      observedRootRegistrations,
    );
    observedRootRegistrations.rebindFrozenScope = async (input) => {
      options.observedScopeTracker!.rebindCalls += 1;
      if (options.rebindScopeFailure !== undefined)
        throw options.rebindScopeFailure;
      return await rebindFrozenScope(input);
    };
  }
  const workflowPorts: ConstructorParameters<typeof AssetRefreshWorkflow>[0] = {
    invocationSupervisor: new ExecutionHost(),
    observedRootRegistrations,
    sourceAddressingCapabilities: [
      {
        capability: {
          capabilityId: "source.addressing",
          capabilityVersion: "1",
          contractVersion: "1",
        },
        inputRequirement: {
          sourceIdentity: "source",
          displayName: "测试来源",
          fields: [
            {
              key: "address",
              label: "地址",
              required: true,
              acceptedInput: "完整地址",
            },
          ],
        },
        normalize(input) {
          const address = input.address;
          return typeof address !== "string" || address.trim().length === 0
            ? { status: "invalid" as const, reason: "地址无效" }
            : {
                status: "accepted" as const,
                normalizedInput: { address: address.trim() },
                evidence: {
                  kind: "directed-source-address" as const,
                  sourceIdentity: "source",
                  sourceAddress: address.trim(),
                  explanation: "用户明确指定来源地址",
                  producer: {
                    capabilityId: "source.addressing",
                    capabilityVersion: "1",
                    contractVersion: "1",
                  },
                },
              };
        },
      },
    ],
    directoryInterpreters:
      options?.formatFactsOnly === true ||
      options?.observedEpubPart === true ||
      options?.observedEpubPartOnly === true
        ? []
        : [
            {
              capability: {
                capabilityId: "directory",
                capabilityVersion: "1",
                contractVersion: "1",
              },
              interpret: () => {
                directoryInterpretations += 1;
                const exact = {
                  kind: "source-address",
                  explanation: "exact",
                  sourceAddress:
                    options?.sourceAddressForSnapshotVersion?.(
                      options?.snapshotVersion?.("track.flac") ?? 0,
                    ) ?? "https://source.example/work",
                  producer: {
                    capabilityId:
                      options?.directoryEvidenceProducerSpoof === true
                        ? "rogue.directory-producer"
                        : "directory",
                    capabilityVersion: "1",
                    contractVersion: "1",
                  },
                } as const;
                if (options?.explicitWorkItemsAfterFirstInterpretation?.()) {
                  return {
                    workItems: [
                      {
                        key: "explicit-boundary",
                        relativePaths: ["track.flac"],
                        evidence: [exact],
                      },
                    ],
                  };
                }
                if (options?.independentEvidence !== true) return [exact];
                return {
                  workItems: [
                    {
                      key: "first-boundary",
                      relativePaths: ["track.flac"],
                      evidence:
                        options?.duplicateFirstBoundaryEvidence === true
                          ? [
                              exact,
                              {
                                ...exact,
                                explanation: "same shared source",
                              },
                            ]
                          : [exact],
                    },
                    ...(options?.singletonExplicit === true
                      ? []
                      : [
                          {
                            key:
                              options?.explicitSelectionKeyWithEmptyBoundary ===
                              true
                                ? "selection"
                                : options?.duplicateWorkItemKey === true
                                  ? "first-boundary"
                                  : "second-boundary",
                            relativePaths:
                              options?.emptyWorkItemBoundary === true ||
                              options?.explicitSelectionKeyWithEmptyBoundary ===
                                true
                                ? []
                                : options?.duplicateWorkItemPath === true
                                  ? ["other.flac", "other.flac"]
                                  : ["other.flac"],
                            evidence: [
                              {
                                ...exact,
                                explanation: "independent boundary",
                                sourceAddress:
                                  options?.sourceFactEpisodeAddresses?.second ??
                                  "https://source.example/other-work",
                              },
                            ],
                          },
                        ]),
                    ...(options?.thirdIndependentBoundary === true
                      ? [
                          {
                            key: "third-boundary",
                            relativePaths: ["third.flac"],
                            evidence: [
                              {
                                ...exact,
                                explanation: "independent boundary",
                                sourceAddress:
                                  options?.sourceFactEpisodeAddresses?.third ??
                                  "https://source.example/third-work",
                              },
                            ],
                          },
                        ]
                      : []),
                  ],
                };
              },
            },
            ...(options?.overlappingInterpreter === true
              ? [
                  {
                    capability: {
                      capabilityId: "other-directory",
                      capabilityVersion: "1",
                      contractVersion: "1",
                    },
                    interpret: () => ({
                      workItems: [
                        {
                          key: "overlapping-boundary",
                          relativePaths: ["track.flac"],
                          evidence: [
                            {
                              kind: "source-address",
                              explanation: "competing interpreter boundary",
                              sourceAddress: "https://source.example/conflict",
                              producer: {
                                capabilityId: "other-directory",
                                capabilityVersion: "1",
                                contractVersion: "1",
                              },
                            },
                          ],
                        },
                      ],
                    }),
                  },
                ]
              : []),
          ],
    filesystemPackageInterpreters:
      options?.directedFilesystemPackage === true
        ? [
            {
              capability: {
                capabilityId: "test.filesystem-package",
                get capabilityVersion() {
                  return (
                    options.filesystemPackageCoordinateState
                      ?.capabilityVersion ?? "1"
                  );
                },
                get contractVersion() {
                  return (
                    options.filesystemPackageCoordinateState?.contractVersion ??
                    "1"
                  );
                },
              },
              interpretPackage: () => ({
                observedArtifactBoundary: "filesystem-package" as const,
              }),
            },
          ]
        : [],
    formatInspectors:
      options?.formatFactsOnly === true ||
      options?.observedEpubPart === true ||
      options?.observedEpubPartOnly === true
        ? [
            {
              get capability() {
                return {
                  capabilityId: "format.inspector",
                  capabilityVersion:
                    options.formatCoordinateState?.capabilityVersion ?? "1",
                  contractVersion:
                    options.formatCoordinateState?.contractVersion ?? "1",
                };
              },
              inspect({ observedArtifactReference }) {
                formatInspectionCalls += 1;
                return [
                  {
                    kind: "artifact-format-inspection",
                    explanation: "format evidence",
                    producer:
                      options?.formatEvidenceProducerSpoof === true
                        ? {
                            capabilityId: "rogue.format-producer",
                            capabilityVersion: "1",
                            contractVersion: "1",
                          }
                        : this.capability,
                    inspection: {
                      identifiers: [
                        {
                          scheme: "isbn-13",
                          value: "9780306406157",
                          locators: ["format:identifier[1]"],
                        },
                      ],
                      observedArtifactReference,
                      revision: {
                        digest: "observed-parent-digest",
                        mediaType: "application/x-test-container",
                        byteLength: 12,
                      },
                      metadata:
                        options.formatIncludesTitle === false
                          ? []
                          : [
                              {
                                property: "asset.title",
                                sourceSlot: "format.title",
                                value: "Local work",
                                locator: "format:title",
                              },
                            ],
                      parts: [
                        {
                          role: "asset.primary-cover",
                          locator: "format:cover",
                          mediaType: "image/jpeg",
                        },
                      ],
                    },
                  },
                ];
              },
            },
          ]
        : [],
    collectors: [
      {
        capability: {
          capabilityId: "collector",
          get capabilityVersion() {
            return options?.collectorCoordinateState?.capabilityVersion ?? "1";
          },
          get contractVersion() {
            return options?.collectorCoordinateState?.contractVersion ?? "1";
          },
          identity: "collector",
          implementationVersion: "1",
          kind: "source-collector",
          interpretationContractVersions:
            options?.producerInterpretationPresenceConflict === true
              ? []
              : ["1"],
        },
        canCollect: (evidence) =>
          evidence.sourceIdentity !== "supplement" &&
          evidence.sourceIdentity !== "failing-supplement" &&
          evidence.sourceIdentity !== "surviving-supplement",
        coverageScopeIds: () => ["complete"],
        ...(options?.sharedCollectionScope === true
          ? {
              collectionScopeIds: () => ["test.shared-root"],
              async collectShared() {
                collectionCalls += 1;
                return {
                  records: [
                    {
                      id: "shared-recovery-record",
                      sourceIdentity: "source",
                      nativeAddress: "https://source.example/shared-root",
                      mediaType: "application/json",
                      acquiredAt: "2026-07-29T00:00:00.000Z",
                      acquisition: {
                        requestedAddress: "https://source.example/shared",
                        method: "GET" as const,
                        authorized: false,
                      },
                      coverage: {
                        id: "complete",
                        completeness: "complete" as const,
                        authority: "official" as const,
                      },
                      digest: "shared-recovery-digest",
                      body: "{}",
                    },
                    ...(options?.conflictingSharedRecord === true
                      ? [
                          {
                            id: "shared-recovery-record",
                            sourceIdentity: "source",
                            nativeAddress: "https://source.example/shared-root",
                            mediaType: "application/json",
                            acquiredAt: "2026-07-29T00:00:00.000Z",
                            acquisition: {
                              requestedAddress: "https://source.example/shared",
                              method: "GET" as const,
                              authorized: false,
                            },
                            coverage: {
                              id: "complete",
                              completeness: "complete" as const,
                              authority: "official" as const,
                            },
                            digest: "shared-recovery-digest-conflict",
                            body: '{"conflict":true}',
                          },
                        ]
                      : []),
                  ],
                  failures:
                    options?.sharedCollectionFailure === true
                      ? [
                          {
                            capability: this.capability,
                            reason: "optional shared metadata unavailable",
                            failureCode: "optional-metadata",
                            affects: {
                              metadataProperties: ["asset.description"],
                            },
                          },
                        ]
                      : [],
                };
              },
            }
          : {}),
        async collect(evidence) {
          if (options?.requireCollectorCoordinateBeforeInvocation === true) {
            const current = [...persisted.values()].at(-1)?.execution;
            if (
              !current?.compatibility.capabilityCoordinates.includes(
                "collector@1/1",
              )
            )
              throw new Error("collector coordinate was not durably frozen");
          }
          if (
            options?.failSecondCollection === true &&
            evidence.sourceAddress === "https://source.example/other-work"
          ) {
            throw new Error("other work is offline");
          }
          if (
            options?.failSupplementaryAssociationRefresh === true &&
            evidence.sourceAddress ===
              "https://source.example/supplementary-work"
          ) {
            throw new Error("supplementary source is offline");
          }
          if (
            evidence.sourceAddress !== undefined &&
            options?.collectionFailureState?.addresses.has(
              evidence.sourceAddress,
            ) === true
          ) {
            throw new Error(`${evidence.sourceAddress} is offline`);
          }
          if (
            options?.requireLineageFreezeBeforeCollection === true &&
            collectionCalls > 0 &&
            !lineageFrozen
          ) {
            throw new Error("lineage was not frozen before collection");
          }
          collectionCalls += 1;
          await options?.collectionBarrier?.();
          const record = {
            id:
              options?.fullSourceRelationship === true
                ? `full-relationship-${evidence.sourceAddress ?? "work"}`
                : options?.sharedSourceArtifact === true ||
                    options?.sharedImplicitSourceArtifact === true
                  ? "shared-record"
                  : options?.independentEvidence === true &&
                      evidence.sourceAddress ===
                        "https://source.example/other-work"
                    ? "other-record"
                    : "record",
            sourceIdentity:
              options?.sourceFactIdentityForAddress?.(evidence.sourceAddress) ??
              "source",
            nativeAddress:
              evidence.sourceAddress ?? "https://source.example/work",
            mediaType: "application/json",
            acquiredAt: "2026-07-29T00:00:00.000Z",
            acquisition: {
              requestedAddress: "https://source.example/endpoint",
              method: "GET" as const,
              authorized: false,
            },
            coverage: {
              id: "complete",
              completeness: "complete" as const,
              authority: "official" as const,
            },
            digest: "digest",
            body: "{}",
          };
          return {
            records: [
              record,
              ...(options?.multipleSourceInterpretations === true &&
              evidence.sourceAddress === "https://source.example/multiple"
                ? [
                    {
                      ...record,
                      id: "multiple-second-record",
                      nativeAddress: "https://source.example/multiple/second",
                      digest: "multiple-second-digest",
                    },
                  ]
                : []),
            ],
            failures:
              options?.collectionFailsAfterOneRecord === true ||
              (evidence.sourceAddress !== undefined &&
                options?.partialCollectionFailureState?.addresses.has(
                  evidence.sourceAddress,
                ) === true)
                ? [
                    {
                      capability:
                        options?.collectionFailureProducerSpoof === true
                          ? {
                              ...this.capability,
                              capabilityId: "adjacent.collector",
                            }
                          : this.capability,
                      reason: "one endpoint failed",
                    },
                  ]
                : options?.collectionUnavailableForUnrequestedMetadata === true
                  ? [
                      {
                        capability:
                          options.collectionFailureCapabilityShape ===
                          "incomplete"
                            ? {
                                capabilityId: "collector",
                                capabilityVersion: "1",
                                contractVersion: "1",
                              }
                            : options.collectionFailureCapabilityShape ===
                                "extra"
                              ? {
                                  ...this.capability,
                                  rawCapability:
                                    "private capability material must not persist",
                                }
                              : this.capability,
                        reason: "protected detail unavailable",
                        failureCode: "detail-contract",
                        affects: {
                          metadataProperties: ["source.protected-body"],
                          artifactRoles: ["fanbox.attachment.*"],
                        },
                      },
                    ]
                  : [],
          };
        },
      },
      ...(options?.sourceEnrichmentSucceeds === true ||
      options?.sourceEnrichmentFails === true ||
      options?.sourceEnrichmentFailureThenInterrupted === true ||
      options?.sourceEnrichmentCandidateFailureState !== undefined
        ? [
            {
              capability: {
                capabilityId: "supplement.collector",
                capabilityVersion: "1",
                contractVersion: "1",
                identity: "supplement.collector",
                implementationVersion: "1",
                kind: "source-collector",
                interpretationContractVersions: ["1"],
              },
              canCollect: (evidence) =>
                evidence.sourceIdentity === "supplement" ||
                evidence.sourceIdentity === "failing-supplement" ||
                evidence.sourceIdentity === "surviving-supplement",
              coverageScopeIds: () => ["supplement.complete"],
              async collect(evidence) {
                const sourceIdentity = evidence.sourceIdentity;
                enrichmentCollectionCalls.set(
                  sourceIdentity,
                  (enrichmentCollectionCalls.get(sourceIdentity) ?? 0) + 1,
                );
                if (
                  sourceIdentity === "failing-supplement" &&
                  options?.sourceEnrichmentFirstFailureStage !==
                    "interpretation"
                )
                  throw new Error("first enrichment collection exploded");
                if (sourceIdentity === "surviving-supplement")
                  await options?.enrichmentCollectionBarrier?.();
                if (options.sourceEnrichmentFails === true)
                  return {
                    records: [],
                    failures: [
                      {
                        capability: {
                          capabilityId: "supplement.collector",
                          capabilityVersion: "1",
                          contractVersion: "1",
                        },
                        reason: "optional supplement unavailable",
                      },
                    ],
                  };
                return {
                  records: [
                    {
                      id:
                        sourceIdentity === "surviving-supplement"
                          ? "surviving-supplement-record"
                          : sourceIdentity === "failing-supplement"
                            ? "failing-supplement-record"
                            : "supplement-record",
                      sourceIdentity,
                      nativeAddress:
                        sourceIdentity === "surviving-supplement"
                          ? "surviving-supplement:work"
                          : sourceIdentity === "failing-supplement"
                            ? "failing-supplement:work"
                            : "supplement:work",
                      mediaType: "application/json",
                      acquiredAt: "2026-07-31T00:00:00.000Z",
                      acquisition: {
                        requestedAddress:
                          sourceIdentity === "surviving-supplement"
                            ? "surviving-supplement:work"
                            : sourceIdentity === "failing-supplement"
                              ? "failing-supplement:work"
                              : "supplement:work",
                        method: "GET" as const,
                        authorized: true,
                      },
                      coverage: {
                        id: "supplement.complete",
                        completeness: "complete" as const,
                        authority: "official" as const,
                      },
                      digest: "supplement-digest",
                      body: "{}",
                    },
                  ],
                  failures:
                    options?.sourceEnrichmentPartialFailure === true
                      ? [
                          {
                            capability: {
                              capabilityId: "supplement.collector",
                              capabilityVersion: "1",
                              contractVersion: "1",
                              identity: "supplement.collector",
                              implementationVersion: "1",
                              kind: "source-collector" as const,
                              interpretationContractVersions: ["1"],
                            },
                            reason: "supplement detail response failed",
                            failureCode: "detail-contract",
                            ...(options.sourceEnrichmentUnsafeFailure === true
                              ? {
                                  raw: "private response must not persist",
                                  credentialPath: "/private/credential",
                                }
                              : {}),
                          },
                        ]
                      : [],
                };
              },
            },
          ]
        : []),
      ...(options?.unusedConfiguredCollector === true ||
      options?.unusedConfiguredCollectorState?.enabled === true
        ? [
            {
              capability: {
                capabilityId: "unused.collector",
                capabilityVersion: "1",
                contractVersion: "1",
              },
              canCollect: () => false,
              coverageScopeIds: () => [],
              async collect() {
                throw new Error("an inapplicable collector must never run");
              },
            },
          ]
        : []),
      ...(options?.dynamicRecoveryCollectorState === undefined
        ? []
        : [
            {
              capability: {
                capabilityId: options.dynamicRecoveryCollectorState
                  .separateCapability
                  ? "dynamic-collector"
                  : "collector",
                capabilityVersion: "1",
                contractVersion: "1",
                identity: "collector",
                implementationVersion: "1",
                kind: "source-collector" as const,
                ...(options.dynamicRecoveryCollectorState
                  .omitInterpretationContractVersions
                  ? {}
                  : { interpretationContractVersions: ["1"] }),
              },
              canCollect(evidence) {
                if (!options.dynamicRecoveryCollectorState!.enabled)
                  return false;
                if (
                  evidence.sourceAddress !== "https://source.example/other-work"
                )
                  return (
                    options.dynamicRecoveryCollectorState!
                      .otherPlanApplicable ?? true
                  );
                options.dynamicRecoveryCollectorState!.canCollectCalls += 1;
                return options.dynamicRecoveryCollectorState!
                  .canCollectCalls === 1
                  ? options.dynamicRecoveryCollectorState!.firstApplicable
                  : !options.dynamicRecoveryCollectorState!.firstApplicable;
              },
              coverageScopeIds: () => ["dynamic"],
              collectionScopeIds: () =>
                options.dynamicRecoveryCollectorState!.nonShareable
                  ? []
                  : ["test.shared-root"],
              async collect() {
                options.dynamicRecoveryCollectorState!.collectCalls += 1;
                if (options.dynamicRecoveryCollectorState!.retainRecord)
                  options.dynamicRecoveryCollectorState!.otherPlanApplicable = false;
                return {
                  records: options.dynamicRecoveryCollectorState!.retainRecord
                    ? [
                        {
                          id:
                            options.dynamicRecoveryCollectorState!
                              .retainedRecordId ??
                            `dynamic-record-${options.dynamicRecoveryCollectorState!.collectCalls}`,
                          sourceIdentity: "source",
                          nativeAddress: "https://source.example/work",
                          mediaType: "application/json",
                          acquiredAt: "2026-07-29T00:00:00.000Z",
                          acquisition: {
                            requestedAddress: "https://source.example/endpoint",
                            method: "GET" as const,
                            authorized: false,
                          },
                          coverage: {
                            id: "complete",
                            completeness: "complete" as const,
                            authority: "official" as const,
                          },
                          digest: "digest",
                          body: "{}",
                        },
                      ]
                    : [],
                  failures: [],
                };
              },
            },
          ]),
    ],
    sourceInterpreters: [
      {
        relationshipDefinitions: [
          {
            id: "fixture.contribution",
            type: "asset.contribution",
            label: "测试署名",
            roles: [],
            additionalRoles: { label: "角色" },
            qualifiers: [
              { key: "character", label: "角色名" },
              { key: "source.order", label: "来源顺序" },
            ],
          },
          {
            id: "fixture.membership",
            type: "asset.membership",
            label: "测试归属",
            roles: [],
            additionalRoles: { label: "角色" },
            qualifiers: [],
          },
          {
            id: "fixture.sequel",
            type: "bangumi.subject.related",
            label: "测试续作",
            roles: [],
            additionalRoles: { label: "角色" },
            qualifiers: [],
          },
        ],
        capability: {
          capabilityId: "interpreter",
          get capabilityVersion() {
            return (
              options?.sourceInterpreterCoordinateState?.capabilityVersion ??
              "1"
            );
          },
          get contractVersion() {
            return (
              options?.sourceInterpreterCoordinateState?.contractVersion ?? "1"
            );
          },
        },
        canInterpret: ({ evidence }) =>
          evidence.every(
            (item) =>
              item.sourceIdentity !== "supplement" &&
              item.sourceIdentity !== "failing-supplement" &&
              item.sourceIdentity !== "surviving-supplement",
          ),
        interpret({ sourceRecords, evidence }) {
          if (options?.sourceInterpreterFailureState?.enabled === true)
            throw new Error("interpreter exploded");
          const batch = {
            id: "interpretation",
            producer: this.capability,
            sourceRecordIds: sourceRecords.map((record) => record.id),
            sourceIdentity: sourceRecords[0]?.sourceIdentity ?? "source",
            sourceAddress:
              sourceRecords[0]?.nativeAddress ??
              evidence[0]?.sourceAddress ??
              "https://source.example/work",
            metadata:
              options?.sourceOmitsTitle === true
                ? [
                    {
                      property: "book.isbn-13",
                      sourceSlot: "source.isbn",
                      value: "9780306406157",
                      sourceRecordIds: sourceRecords.map((record) => record.id),
                    },
                  ]
                : [
                    {
                      property: "asset.title",
                      sourceSlot: "source.title",
                      value:
                        evidence[0]?.sourceAddress ===
                        "https://source.example/other-work"
                          ? "Other Work"
                          : "Work",
                      sourceRecordIds:
                        options?.invalidMetadataProvenance === true ||
                        (options?.invalidRefreshMetadataProvenance === true &&
                          collectionCalls > 1)
                          ? ["missing"]
                          : sourceRecords.map((record) => record.id),
                    },
                  ],
            sourceArtifacts:
              options?.observedEpubPartOnly === true ||
              options?.sourceOmitsCover === true
                ? []
                : [
                    {
                      id: "cover-candidate",
                      sourceRecordId: sourceRecords[0]?.id ?? "record",
                      ...(options?.sharedSourceArtifact === true ||
                      options?.sharedCandidateWithDifferentServingSemantics ===
                        true
                        ? {
                            subjectId:
                              options?.sharedCandidateWithDifferentServingSemantics ===
                                true &&
                              evidence[0]?.sourceAddress ===
                                "https://source.example/other-work"
                                ? "other-work"
                                : "shared-work",
                          }
                        : {}),
                      role: "asset.primary-cover",
                      acquisitionReference:
                        options?.sharedCandidateWithConflictingAcquisition ===
                          true &&
                        evidence[0]?.sourceAddress ===
                          "https://source.example/other-work"
                          ? "https://source.example/conflicting-cover.png"
                          : "https://source.example/cover.jpg",
                      mediaType:
                        options?.sharedCandidateWithConflictingAcquisition ===
                          true &&
                        evidence[0]?.sourceAddress ===
                          "https://source.example/other-work"
                          ? "image/png"
                          : "image/jpeg",
                    },
                    ...(options?.includeListedAttachmentCandidate === true
                      ? [
                          {
                            id: "listed-attachment-candidate",
                            sourceRecordId: "record",
                            role: "fanbox.attachment.file",
                            acquisitionReference:
                              "https://source.example/attachment.mp4",
                            mediaType: "video/mp4",
                          },
                        ]
                      : []),
                    ...(options?.includeSecondCoverCandidate === true
                      ? [
                          {
                            id: "second-cover-candidate",
                            sourceRecordId: "record",
                            role: "asset.primary-cover",
                            acquisitionReference:
                              "https://source.example/second-cover.jpg",
                            mediaType: "image/jpeg",
                          },
                        ]
                      : []),
                  ],
            ...(options?.fullSourceRelationship === true
              ? {
                  entities: [
                    {
                      id: "bangumi-subject",
                      kind: "entity" as const,
                      sourceIdentity:
                        sourceRecords[0]?.sourceIdentity ?? "source",
                      sourceKey: "subject",
                      identityNamespace: "bangumi.subject",
                      label: "Season one",
                      sourceRecordIds: sourceRecords.map((record) => record.id),
                    },
                    {
                      id: "bangumi-sequel",
                      kind: "entity" as const,
                      sourceIdentity:
                        sourceRecords[0]?.sourceIdentity ?? "source",
                      sourceKey: "sequel",
                      identityNamespace: "bangumi.subject",
                      label: "Season two",
                      sourceRecordIds: sourceRecords.map((record) => record.id),
                    },
                  ],
                }
              : options?.sharedSourceArtifact === true ||
                  options?.sharedCandidateWithDifferentServingSemantics ===
                    true ||
                  options?.sourceRelationshipQualifiers === true
                ? {
                    entities: [
                      {
                        id:
                          options?.sourceRelationshipQualifiers === true
                            ? "credited-person"
                            : options?.sharedCandidateWithDifferentServingSemantics ===
                                  true &&
                                evidence[0]?.sourceAddress ===
                                  "https://source.example/other-work"
                              ? "other-work"
                              : "shared-work",
                        sourceIdentity: "source",
                        sourceKey:
                          options?.sourceRelationshipQualifiers === true
                            ? "credited-person"
                            : options?.sharedCandidateWithDifferentServingSemantics ===
                                  true &&
                                evidence[0]?.sourceAddress ===
                                  "https://source.example/other-work"
                              ? "other-work"
                              : "shared-work",
                        identityNamespace:
                          options?.sourceRelationshipQualifiers === true
                            ? "source.person"
                            : "source.work",
                        label:
                          options?.sourceRelationshipQualifiers === true
                            ? "Credited person"
                            : "Shared work",
                        sourceRecordIds: sourceRecords.map(
                          (record) => record.id,
                        ),
                      },
                    ],
                  }
                : {}),
            ...(options?.fullSourceRelationship === true
              ? {
                  relationships: [
                    {
                      participants: [
                        {
                          entityId: "bangumi-subject",
                          role: "bangumi.subject.predecessor",
                        },
                        {
                          entityId: "bangumi-sequel",
                          role: "bangumi.subject.sequel",
                        },
                      ],
                      sourceSubjectId: "bangumi-subject",
                      type: "bangumi.subject.related",
                      sourceSlot: "bangumi.subject.related",
                      sourceRecordIds: sourceRecords.map((record) => record.id),
                    },
                  ],
                }
              : options?.sourceRelationshipQualifiers === true
                ? {
                    relationships: [
                      {
                        participants: [
                          { entityId: "credited-person", role: "cast" },
                        ],
                        subjectRole: "asset",
                        type: "asset.contribution",
                        sourceSlot: "source.cast.0",
                        sourceRecordIds: sourceRecords.map(
                          (record) => record.id,
                        ),
                        qualifiers: [
                          { key: "character", value: "Character" },
                          { key: "source.order", value: "0" },
                        ],
                      },
                    ],
                  }
                : {}),
          };
          if (
            options?.multipleSourceInterpretations === true &&
            evidence[0]?.sourceAddress === "https://source.example/multiple"
          )
            return sourceRecords.map((record, index) => ({
              ...batch,
              id: `multiple-interpretation-${index + 1}`,
              sourceRecordIds: [record.id],
              sourceAddress: record.nativeAddress,
              metadata: [
                {
                  property: "asset.title",
                  sourceSlot: `source.title.${index + 1}`,
                  value: index === 0 ? "First candidate" : "Second candidate",
                  sourceRecordIds: [record.id],
                },
              ],
              sourceArtifacts: [],
            }));
          if (evidence[0]?.sourceAddress === "https://source.example/fault") {
            if (options?.sourceInterpretationFault === "empty") return [];
            if (options?.sourceInterpretationFault === "unknown-record")
              return [
                {
                  ...batch,
                  sourceRecordIds: [...batch.sourceRecordIds, "unknown-record"],
                },
              ];
            if (options?.sourceInterpretationFault === "duplicate-address")
              return [batch, { ...batch, id: "duplicate-address-batch" }];
            if (
              options?.sourceInterpretationFault === "undeclared-relationship"
            )
              return [
                {
                  ...batch,
                  entities: [
                    {
                      id: "unknown-participant",
                      kind: "entity" as const,
                      sourceIdentity: "source",
                      sourceKey: "unknown-participant",
                      identityNamespace: "fixture.entity",
                      label: "参与者",
                      sourceRecordIds: batch.sourceRecordIds,
                    },
                  ],
                  relationships: [
                    {
                      type: "fixture.undeclared",
                      subjectRole: "asset",
                      sourceSlot: "fixture.undeclared",
                      participants: [
                        {
                          entityId: "unknown-participant",
                          role: "participant",
                        },
                      ],
                      sourceRecordIds: batch.sourceRecordIds,
                    },
                  ],
                },
              ];
          }
          return [batch];
        },
      },
      ...(options?.sourceEnrichmentSucceeds === true ||
      options?.sourceEnrichmentCandidateFailureState !== undefined
        ? [
            {
              capability: {
                capabilityId: "supplement.interpreter",
                capabilityVersion: "1",
                contractVersion: "1",
              },
              canInterpret: ({ evidence }) =>
                evidence.some((item) => item.sourceIdentity === "supplement"),
              interpret: ({ sourceRecords }) => [
                {
                  id: "supplement-interpretation",
                  producer: {
                    capabilityId: "supplement.interpreter",
                    capabilityVersion: "1",
                    contractVersion: "1",
                  },
                  sourceRecordIds: ["supplement-record"],
                  sourceIdentity: "supplement",
                  sourceAddress: "supplement:work",
                  metadata: [
                    {
                      property: "asset.awards",
                      sourceSlot: "supplement.awards",
                      value: "One award",
                      sourceRecordIds: sourceRecords.map((record) => record.id),
                    },
                  ],
                  sourceArtifacts: [
                    {
                      id: "supplement-cover",
                      sourceRecordId: "supplement-record",
                      role: "asset.primary-cover",
                      acquisitionReference:
                        "https://supplement.example/poster.jpg",
                      mediaType: "image/jpeg",
                    },
                    {
                      id: "supplement-background",
                      sourceRecordId: "supplement-record",
                      role: "asset.background",
                      acquisitionReference:
                        "https://supplement.example/background.jpg",
                      mediaType: "image/jpeg",
                    },
                  ],
                },
              ],
            },
          ]
        : []),
      ...(options?.sourceEnrichmentFailureThenInterrupted === true
        ? [
            {
              capability: {
                capabilityId: "failing-supplement.interpreter",
                capabilityVersion: "1",
                contractVersion: "1",
              },
              canInterpret: ({ evidence }) =>
                evidence.some(
                  (item) => item.sourceIdentity === "failing-supplement",
                ),
              interpret: () => {
                throw new Error("first enrichment interpretation exploded");
              },
            },
            {
              capability: {
                capabilityId: "surviving-supplement.interpreter",
                capabilityVersion: "1",
                contractVersion: "1",
              },
              canInterpret: ({ evidence }) =>
                evidence.some(
                  (item) => item.sourceIdentity === "surviving-supplement",
                ),
              interpret: ({ sourceRecords }) => [
                {
                  id: "surviving-supplement-interpretation",
                  producer: {
                    capabilityId: "surviving-supplement.interpreter",
                    capabilityVersion: "1",
                    contractVersion: "1",
                  },
                  sourceRecordIds: ["surviving-supplement-record"],
                  sourceIdentity: "surviving-supplement",
                  sourceAddress: "surviving-supplement:work",
                  metadata: [
                    {
                      property: "asset.awards",
                      sourceSlot: "surviving-supplement.awards",
                      value: "One durable award",
                      sourceRecordIds: sourceRecords.map((record) => record.id),
                    },
                  ],
                  sourceArtifacts: [],
                },
              ],
            },
          ]
        : []),
    ],
    recognizers: [
      {
        capability: {
          get capabilityId() {
            return options?.recognizerSpoofState?.enabled === true
              ? "rogue-recognizer"
              : "recognizer";
          },
          get capabilityVersion() {
            return options?.recognizerCoordinateState?.capabilityVersion ?? "1";
          },
          get contractVersion() {
            return options?.recognizerCoordinateState?.contractVersion ?? "1";
          },
        },
        canRecognize: (input) =>
          input.basis.kind ===
          (options?.recognitionBasis ?? "source-interpretation"),
        recognize: (input) => {
          const evidence = input.evidence;
          const interpretation =
            "interpretation" in input
              ? input.interpretation
              : input.basis.kind === "source-interpretation"
                ? input.basis.interpretation
                : undefined;
          if (options?.recognizerFailureState?.enabled === true)
            throw new Error("recognizer exploded");
          const forgery = options?.recognizerProposalForgery;
          const draft = {
            id:
              options?.independentEvidence === true
                ? evidence[0]?.sourceAddress ===
                  "https://source.example/other-work"
                  ? "other-proposal"
                  : evidence[0]?.sourceAddress ===
                      "https://source.example/third-work"
                    ? "third-proposal"
                    : "first-proposal"
                : "proposal",
            ruleResults: [
              {
                capabilityId: "recognizer",
                capabilityVersion:
                  options?.recognizerCoordinateState?.capabilityVersion ?? "1",
                ruleId: "exact",
                ruleVersion: "1",
                outcome: "satisfied" as const,
                explanation: "exact",
                evidence:
                  forgery === "all" || forgery === "evidence"
                    ? [
                        ...evidence,
                        {
                          kind: "rogue-evidence",
                          explanation: "forged by recognizer",
                          producer: {
                            capabilityId: "rogue.format-inspector",
                            capabilityVersion: "1",
                            contractVersion: "1",
                          },
                        },
                      ]
                    : evidence,
              },
            ],
          };
          if (forgery === undefined) return draft;
          return {
            ...draft,
            ...(forgery === "all" || forgery === "interpretation"
              ? {
                  interpretation: {
                    ...interpretation!,
                    producer: {
                      capabilityId: "rogue.source-interpreter",
                      capabilityVersion: "1",
                      contractVersion: "1",
                    },
                    metadata: [
                      ...interpretation!.metadata,
                      {
                        property: "asset.forged-title",
                        sourceSlot: "rogue.interpreter.title",
                        value: "Forged by recognizer",
                        sourceRecordIds: interpretation!.sourceRecordIds,
                        producer: {
                          capabilityId: "rogue.source-interpreter",
                          capabilityVersion: "1",
                          contractVersion: "1",
                        },
                      },
                    ],
                  },
                }
              : {}),
            ...(forgery === "all" || forgery === "observed"
              ? {
                  observedMetadata: [
                    {
                      property: "asset.forged-local-title",
                      sourceSlot: "rogue.format.title",
                      value: "Forged local title",
                      observedArtifactReference: "track.flac",
                      locator: "rogue:format:title",
                      producer: {
                        capabilityId: "rogue.format-inspector",
                        capabilityVersion: "1",
                        contractVersion: "1",
                      },
                    },
                  ],
                  observedArtifactParts: [
                    {
                      id: "rogue-observed-part",
                      role: "asset.primary-cover",
                      observedArtifactReference: "track.flac",
                      locator: "rogue:format:cover",
                      mediaType: "image/jpeg",
                      producer: {
                        capabilityId: "rogue.format-inspector",
                        capabilityVersion: "1",
                        contractVersion: "1",
                      },
                    },
                  ],
                  observedArtifactRevisions: [
                    {
                      observedArtifactReference: "track.flac",
                      blob: {
                        digest: "rogue-observed-parent-digest",
                        mediaType: "application/x-rogue",
                        byteLength: 13,
                      },
                      producer: {
                        capabilityId: "rogue.format-inspector",
                        capabilityVersion: "1",
                        contractVersion: "1",
                      },
                    },
                  ],
                }
              : {}),
          };
        },
      },
      ...(options?.competingProposals === true ||
      options?.ambiguousSourceAddresses !== undefined
        ? [
            {
              capability: {
                capabilityId: "second-recognizer",
                capabilityVersion: "1",
                contractVersion: "1",
              },
              canRecognize: (input) =>
                input.basis.kind === "source-interpretation" &&
                (options?.competingProposals === true ||
                  options?.ambiguousSourceAddresses?.includes(
                    input.basis.interpretation.sourceAddress,
                  ) === true),
              recognize: ({ evidence }) => ({
                id: "competing-proposal",
                ruleResults: [
                  {
                    capabilityId: "second-recognizer",
                    capabilityVersion: "1",
                    ruleId: "exact",
                    ruleVersion: "1",
                    outcome: "satisfied" as const,
                    explanation: "equally plausible",
                    evidence,
                  },
                ],
              }),
            },
          ]
        : []),
    ],
    recognitionPolicy: { accepts: (result) => result.ruleId === "exact" },
    ...(options?.metadataPolicyConfigured !== true &&
    options?.metadataPolicyConflict !== true
      ? {}
      : {
          metadataPolicyConfiguration: {
            version: "ordinary-test/1",
            policies: [
              {
                id: "ordinary-test",
                metadataUsageContext: "asset.ordinary",
                rules: [
                  {
                    property: "asset.title",
                    preferredSourceIdentities: ["source"],
                    cardinality: "one" as const,
                  },
                ],
              },
              ...(options?.metadataPolicyConflict !== true
                ? []
                : [
                    {
                      id: "ordinary-test-competing",
                      metadataUsageContext: "asset.ordinary",
                      rules: [
                        {
                          property: "asset.title",
                          preferredSourceIdentities: ["other-source"],
                          cardinality: "one" as const,
                        },
                      ],
                    },
                  ]),
            ],
            select: () =>
              options?.metadataPolicyConflict === true
                ? ["ordinary-test", "ordinary-test-competing"]
                : ["ordinary-test"],
          },
        }),
    acquirers: [
      {
        capability: {
          capabilityId: "acquirer",
          get capabilityVersion() {
            return options?.acquirerCoordinateState?.capabilityVersion ?? "1";
          },
          get contractVersion() {
            return options?.acquirerCoordinateState?.contractVersion ?? "1";
          },
        },
        canAcquire: () => true,
        async acquire(candidate) {
          acquisitionCalls += 1;
          await options?.acquisitionBarrier?.();
          if (
            options?.coverFails === true ||
            options?.coverFailureState?.fails === true ||
            options?.acquisitionFailsForCandidateIds?.has(candidate.id) ===
              true ||
            options?.acquisitionFailsForRoles?.has(candidate.role) === true
          )
            throw new Error("cover offline");
          return {
            candidateId: candidate.id,
            sourceRecordId: candidate.sourceRecordId,
            bytes: jpeg,
            mediaType: "image/jpeg",
          };
        },
      },
    ],
    ...(options?.observedEpubPart === true ||
    options?.observedEpubPartOnly === true ||
    options?.formatFactsOnly === true
      ? {
          observedArtifactPartAcquirers: [
            {
              get capability() {
                return {
                  capabilityId: "format.part",
                  capabilityVersion:
                    options.partAcquirerCoordinateState?.capabilityVersion ??
                    "1",
                  contractVersion:
                    options.partAcquirerCoordinateState?.contractVersion ?? "1",
                };
              },
              canAcquire: () => true,
              async acquire(input) {
                observedPartAcquisitionCalls += 1;
                return {
                  candidateId: input.candidate.id,
                  bytes: jpeg,
                  mediaType: "image/jpeg",
                  origin: {
                    digest:
                      options.observedPartOriginDigest ??
                      "observed-parent-digest",
                    mediaType: "application/x-test-container",
                    byteLength: 12,
                  },
                };
              },
            },
          ],
        }
      : {}),
    managedStore: {
      async stage(content) {
        return {
          candidateId: content.candidateId,
          sourceRecordId: content.sourceRecordId,
          role: content.role,
          stagedReference: `staged:${content.idempotencyKey}`,
          digest: sha256(content.bytes),
          mediaType: content.mediaType,
        };
      },
      async storeStaged(checkpoint) {
        if (options?.managedStoreFails === true)
          throw new Error("managed store failed");
        if (
          options?.managedStoreBarrier !== undefined &&
          !managedStoreBarrierUsed
        ) {
          managedStoreBarrierUsed = true;
          await options.managedStoreBarrier();
        }
        managedStoreCalls += 1;
        return {
          blob: {
            digest: checkpoint.digest,
            mediaType: checkpoint.mediaType,
            byteLength: jpeg.byteLength,
          },
          location: { address: "/managed/blob" },
        };
      },
      async store(content) {
        if (options?.managedStoreFails === true)
          throw new Error("managed store failed");
        managedStoreCalls += 1;
        return {
          blob: {
            digest: sha256(content.bytes),
            mediaType: content.mediaType,
            byteLength: content.bytes.byteLength,
          },
          location: { address: "/managed/blob" },
        };
      },
      ...(options?.unavailableManagedCover === true ||
      options?.managedCoverAvailability !== undefined
        ? {
            async isAvailable() {
              return options?.managedCoverAvailability?.available ?? false;
            },
          }
        : {}),
    },
    executionCommands: persistence,
    executionQueries: persistence,
    recoveryLease: persistence,
    reuseQueries: persistence,
    ...(options?.publicCandidateSelectionEvidence === undefined
      ? {}
      : {
          currentSourceArtifactQueries: {
            async readCurrentSourceArtifactFacts(input: {
              readonly subjectId: string;
              readonly sourceIdentity: string;
              readonly sourceAssociationId?: string;
            }) {
              const current = accepted.find(
                (item) => item.entity.id === input.subjectId,
              );
              const association = (current?.sourceAssociations ?? []).find(
                (item) =>
                  item.sourceIdentity === input.sourceIdentity &&
                  (input.sourceAssociationId === undefined ||
                    item.id === input.sourceAssociationId),
              );
              if (association === undefined) return undefined;
              return {
                subjectId: input.subjectId,
                sourceAssociation: association,
                recognitionIdentity: {
                  recognitionDecisionId: "current-decision",
                  sourceAssociationId: association.id,
                },
                candidates: [
                  {
                    candidate: {
                      id: "public-candidate",
                      sourceRecordId: "record",
                      role: "fanbox.attachment.file",
                      acquisitionReference: "opaque-provider-reference",
                      mediaType: "application/octet-stream",
                      selectionEvidence:
                        options.publicCandidateSelectionEvidence,
                    },
                    interpretationSourceRecordIds: ["record"],
                    sourceRecords: [],
                  },
                ],
              };
            },
          },
        }),
    currentCatalogueQueries: {
      async listCurrentCataloguePage(input) {
        const limit = input?.limit ?? 24;
        return {
          items: accepted.slice(0, limit).map((item) => ({
            ...item,
            metadataSourceRecords: [...persisted.values()]
              .flatMap((inspection) => inspection.sourceRecords)
              .filter((record) =>
                item.metadata.some((assertion) =>
                  assertion.sourceRecordIds.includes(record.id),
                ),
              )
              .map(({ id, sourceIdentity }) => ({ id, sourceIdentity })),
          })),
        };
      },
      async listCurrentCatalogue() {
        return accepted;
      },
      async listCurrentCatalogueIndex(properties) {
        return accepted.map((item, additionOrder) => ({
          ...item,
          additionOrder,
          metadata: item.metadata.filter((assertion) =>
            properties.includes(assertion.property),
          ),
        }));
      },
    },
    workflowHistoryQueries: {
      async listWorkflowHistoryPage(input) {
        const limit = input?.limit ?? 24;
        return {
          items: [...persisted.values()].slice(0, limit).map((inspection) => {
            const proposals = [
              ...(inspection.proposal === undefined
                ? []
                : [inspection.proposal]),
              ...(inspection.workItemInspections ?? []).flatMap((item) =>
                item.proposal === undefined ? [] : [item.proposal],
              ),
            ];
            const accepted = [
              ...(inspection.accepted === undefined
                ? []
                : [inspection.accepted]),
              ...(inspection.workItemInspections ?? []).flatMap((item) =>
                item.accepted === undefined ? [] : [item.accepted],
              ),
            ];
            return {
              execution: inspection.execution,
              resultReferences: {
                proposalIds: proposals.map(({ id }) => id),
                acceptedProposalIds: accepted.map(
                  ({ proposal }) => proposal.id,
                ),
                recognitionDecisionIds: accepted.map(
                  ({ recognitionDecision }) => recognitionDecision.id,
                ),
                sourceAssociationIds: accepted.flatMap(
                  ({ sourceAssociations }) =>
                    sourceAssociations.map((association) => association.id),
                ),
                acceptedAssetIds: accepted.map(({ entity }) => entity.id),
                sourceRecordIds: inspection.sourceRecords.map(({ id }) => id),
                sourceRefreshRunIds:
                  inspection.execution.sourceRefreshRunIds ?? [],
                changeImpactPreviewIds: [],
                affectedSubjectIds: accepted.map(({ entity }) => entity.id),
              },
              sourceRecords: inspection.sourceRecords,
              proposals,
              sourceRefreshRuns: inspection.sourceRefreshRuns ?? [],
              changeImpactPreviews: [],
            };
          }),
        };
      },
    },
    currentAttentionQueries: {
      async listCurrentAttentionPage() {
        return { items: [] };
      },
    },
    recognitionAcceptance: persistence,
    recognitionReevaluation: persistence,
    recognitionChangeImpact: persistence,
    metadataRefreshPersistence: persistence,
    ...(sourceRefreshRunPersistence === undefined
      ? {}
      : { sourceRefreshRuns: sourceRefreshRunPersistence }),
    ...(recoverySourceRefreshRunCommands === undefined
      ? {}
      : { recoverySourceRefreshRuns: recoverySourceRefreshRunCommands }),
    ...(options?.omitConfigurationCompatibility === true
      ? {}
      : {
          configurationCompatibility: options?.configurationCompatibility ?? {
            async checkCompatibility() {
              return { compatible: true };
            },
          },
        }),
    ...(options?.sourceEnrichmentSucceeds === true ||
    options?.sourceEnrichmentFailureThenInterrupted === true ||
    options?.sourceEnrichmentCandidateFailureState !== undefined
      ? {
          sourceAssociationCandidateInterpreters: [
            ...(options?.sourceEnrichmentSucceeds === true ||
            options?.sourceEnrichmentCandidateFailureState !== undefined
              ? [
                  {
                    capability: {
                      capabilityId: "supplement.enricher",
                      capabilityVersion: "1",
                      contractVersion: "1",
                    },
                    interpret() {
                      if (
                        options?.sourceEnrichmentCandidateFailureState
                          ?.enabled !== true
                      ) {
                        if (
                          options?.sourceEnrichmentCandidateFailureState !==
                          undefined
                        )
                          return undefined;
                      } else if (
                        options.sourceEnrichmentCandidateFailureState.fails
                      ) {
                        throw new Error(
                          "source enrichment candidate interpreter exploded",
                        );
                      }
                      return {
                        kind: "source-association" as const,
                        explanation: "supplement",
                        sourceIdentity: "supplement",
                        sourceAddress: "supplement:work",
                        producer:
                          options?.sourceEnrichmentCandidateProducerSpoof ===
                          true
                            ? {
                                capabilityId: "rogue.enricher-producer",
                                capabilityVersion: "1",
                                contractVersion: "1",
                              }
                            : {
                                capabilityId: "supplement.enricher",
                                capabilityVersion: "1",
                                contractVersion: "1",
                              },
                      };
                    },
                  },
                ]
              : []),
            ...(options?.sourceEnrichmentFailureThenInterrupted === true
              ? [
                  {
                    capability: {
                      capabilityId: "failing-supplement.enricher",
                      capabilityVersion: "1",
                      contractVersion: "1",
                    },
                    interpret() {
                      return {
                        kind: "source-association" as const,
                        explanation: "failing supplement",
                        sourceIdentity: "failing-supplement",
                        sourceAddress: "failing-supplement:work",
                        producer: {
                          capabilityId: "failing-supplement.enricher",
                          capabilityVersion: "1",
                          contractVersion: "1",
                        },
                      };
                    },
                  },
                  {
                    capability: {
                      capabilityId: "surviving-supplement.enricher",
                      capabilityVersion: "1",
                      contractVersion: "1",
                    },
                    interpret() {
                      return {
                        kind: "source-association" as const,
                        explanation: "surviving supplement",
                        sourceIdentity: "surviving-supplement",
                        sourceAddress: "surviving-supplement:work",
                        producer: {
                          capabilityId: "surviving-supplement.enricher",
                          capabilityVersion: "1",
                          contractVersion: "1",
                        },
                      };
                    },
                  },
                ]
              : []),
          ],
          sourceAssociationInterpreters: Array.from(
            { length: options?.duplicateSourceAssociationInterpreters ? 2 : 1 },
            (_, index) => ({
              capability: {
                capabilityId:
                  index === 0
                    ? "supplement.association-interpreter"
                    : `supplement.association-interpreter-${index}`,
                capabilityVersion: "1",
                contractVersion: "1",
              },
              canInterpret: () => true,
              interpret: () => ({
                status: "accepted" as const,
                explanation: `exact supplement identity ${index}`,
              }),
            }),
          ),
          sourceEnrichmentPersistence: {
            async checkpointSourceEnrichmentRecords(input) {
              const inspection = persisted.get(input.execution.id);
              if (inspection === undefined)
                throw new Error("missing enrichment execution");
              executions.push(input.execution);
              persisted.set(input.execution.id, {
                ...inspection,
                execution: input.execution,
                sourceRecords: [
                  ...inspection.sourceRecords,
                  ...input.sourceRecords,
                ],
              });
            },
            async applySourceEnrichment(input) {
              const index = accepted.findIndex(
                (item) => item.entity.id === input.assetId,
              );
              const current = accepted[index];
              if (current === undefined)
                throw new Error("missing accepted enrichment target");
              if (
                current.recognitionSourceAssociation?.id !==
                  input.expectedRecognitionBaseline
                    .recognitionSourceAssociationId ||
                current.recognitionDecision.id !==
                  input.expectedRecognitionBaseline.recognitionDecisionId
              )
                throw new Error(
                  "Source Enrichment recognition identity baseline is stale",
                );
              const managed = input.managedArtifacts;
              const next = {
                ...current,
                sourceAssociations: [
                  ...current.sourceAssociations,
                  input.sourceAssociation,
                ],
                metadata: [
                  ...current.metadata,
                  ...bindSourceMetadata(
                    input.interpretation.metadata,
                    input.assetId,
                  ),
                ],
                metadataSourceRecords: [
                  ...(current.metadataSourceRecords ?? []),
                  ...input.sourceRecords.map((record) => ({
                    id: record.id,
                    sourceIdentity: record.sourceIdentity,
                  })),
                ],
                ...(managed === undefined
                  ? {}
                  : {
                      artifacts: [...current.artifacts, ...managed.artifacts],
                      locations: [...current.locations, ...managed.locations],
                      blobs: [...current.blobs, ...managed.blobs],
                      artifactRevisions: [
                        ...current.artifactRevisions,
                        ...managed.revisions,
                      ],
                      artifactAssociations: [
                        ...current.artifactAssociations,
                        ...managed.associations,
                      ],
                    }),
              };
              accepted.splice(index, 1, next);
              for (const [executionId, inspection] of persisted) {
                if (inspection.accepted?.entity.id !== input.assetId) continue;
                persisted.set(executionId, {
                  ...inspection,
                  accepted: next,
                  ...(inspection.workItemInspections === undefined
                    ? {}
                    : {
                        workItemInspections: inspection.workItemInspections.map(
                          (item) =>
                            item.accepted?.entity.id === input.assetId
                              ? { ...item, accepted: next }
                              : item,
                        ),
                      }),
                });
              }
              const inspection = persisted.get(input.execution.id);
              if (inspection === undefined)
                throw new Error("missing enrichment execution");
              executions.push(input.execution);
              persisted.set(input.execution.id, {
                ...inspection,
                execution: input.execution,
                accepted: next,
              });
            },
          },
        }
      : options?.sourceEnrichmentFails === true
        ? {
            sourceAssociationCandidateInterpreters: [
              {
                capability: {
                  capabilityId: "supplement.enricher",
                  capabilityVersion: "1",
                  contractVersion: "1",
                },
                interpret() {
                  return {
                    kind: "source-association" as const,
                    explanation: "supplement",
                    sourceIdentity: "supplement",
                    sourceAddress: "supplement:work",
                    producer: {
                      capabilityId: "supplement.enricher",
                      capabilityVersion: "1",
                      contractVersion: "1",
                    },
                  };
                },
              },
            ],
            sourceAssociationInterpreters: [
              {
                capability: {
                  capabilityId: "supplement.association-interpreter",
                  capabilityVersion: "1",
                  contractVersion: "1",
                },
                canInterpret: () => true,
                interpret: () => ({
                  status: "accepted" as const,
                  explanation: "exact supplement identity",
                }),
              },
            ],
            sourceEnrichmentPersistence: {
              async checkpointSourceEnrichmentRecords(input) {
                const inspection = persisted.get(input.execution.id);
                if (inspection === undefined)
                  throw new Error("missing enrichment execution");
                executions.push(input.execution);
                persisted.set(input.execution.id, {
                  ...inspection,
                  execution: input.execution,
                  sourceRecords: [
                    ...inspection.sourceRecords,
                    ...input.sourceRecords,
                  ],
                });
              },
              async applySourceEnrichment() {
                throw new Error("failing enrichment must not apply facts");
              },
            },
          }
        : {}),
    ...(options?.sourceAssociationOutcome === undefined
      ? {}
      : {
          sourceAssociationInterpreters: Array.from(
            { length: options.duplicateSourceAssociationInterpreters ? 2 : 1 },
            (_, index) => ({
              capability: {
                capabilityId:
                  index === 0
                    ? "source.association-interpreter"
                    : `source.association-interpreter-${index}`,
                capabilityVersion: "1",
                contractVersion: "1",
              },
              canInterpret: () => true,
              interpret: () => ({
                status: options.sourceAssociationOutcome!,
                explanation:
                  options.sourceAssociationOutcome === "contradicted"
                    ? "来源记录与当前身份矛盾"
                    : `来源记录支持当前身份 ${index}`,
              }),
            }),
          ),
        }),
    changeImpactQueries: persistence,
    changeImpactCommands: persistence,
    ...(options?.resumeClock === undefined
      ? {}
      : { resumeClock: options.resumeClock }),
  };
  let assetLibraries: AssetLibraries | undefined;
  if (options?.assetLibraryAutomation === true) {
    const library = () => {
      const entry = observedRootStore.libraryLedger.read("library-fixture");
      return entry === undefined
        ? undefined
        : {
            ...entry,
            displayName: "自动化夹具作品库",
            recognitionProfileIds: ["fixture-profile"],
            sourceIdentities: ["source"],
          };
    };
    const libraryPersistence: AssetLibraryPersistence = {
      async listAssetLibraries() {
        const current = library();
        return current === undefined ? [] : [current];
      },
      async getAssetLibrary(id) {
        return id === "library-fixture" ? library() : undefined;
      },
      async saveAssetLibrary() {
        throw new Error("此自动化夹具不写库配置");
      },
      async reconnectAssetLibraryDirectory() {
        throw new Error("此自动化夹具不重连目录");
      },
    };
    assetLibraries = new AssetLibraries({
      persistence: libraryPersistence,
      roots: observedRootRegistrations,
      recognitionProfiles: [
        {
          id: "fixture-profile",
          displayName: "夹具识别方式",
          directoryInterpreterIds: ["directory"],
          recognizerIds: ["recognizer"],
        },
      ],
      sources: [
        {
          id: "source",
          displayName: "测试来源",
          collectorIds: ["collector"],
          sourceCandidateInterpreterIds: [],
          sourceInterpreterIds: ["interpreter"],
          sourceAssociationInterpreterIds: [],
          acquirerIds: ["acquirer"],
          informationFulfillmentIds: [],
        },
      ],
      capabilities: {
        directoryInterpreters: workflowPorts.directoryInterpreters.map(
          ({ capability }) => capability,
        ),
        recognizers: workflowPorts.recognizers.map(
          ({ capability }) => capability,
        ),
        collectors: workflowPorts.collectors.map(
          ({ capability }) => capability,
        ),
        sourceCandidateInterpreters: [],
        sourceAssociationInterpreters: [],
        informationFulfillments: [],
        sourceInterpreters: workflowPorts.sourceInterpreters.map(
          ({ capability }) => capability,
        ),
        acquirers: workflowPorts.acquirers.map(({ capability }) => capability),
      },
    });
  }
  const workflow = new AssetRefreshWorkflow({
    ...workflowPorts,
    ...(assetLibraries === undefined ? {} : { assetLibraries }),
  });
  const automatedWorkflow = attachAssetRefreshAutomation(
    workflow,
    new AssetRefreshAutomation(workflow, {
      ...(assetLibraries === undefined ? {} : { assetLibraries }),
      executionQueries: persistence,
      automationQueries: persistence,
      automationCommands: persistence,
      observedRootRegistrations,
      recognitionPolicyVersion: "policy/1",
      ...(options?.automationInformationRequirement === undefined
        ? {}
        : {
            informationRequirement: options.automationInformationRequirement,
          }),
    }),
  );
  return {
    workflow: automatedWorkflow,
    executions,
    retained,
    accepted,
    recognitionAcceptanceCalls: () => recognitionAcceptanceCalls,
    resumeClaimAttempts: () => resumeClaimAttempts,
    resumeClaimReleases: () => resumeClaimReleases,
    collectionCalls: () => collectionCalls,
    acquisitionCalls: () => acquisitionCalls,
    managedStoreCalls: () => managedStoreCalls,
    formatInspectionCalls: () => formatInspectionCalls,
    observedPartAcquisitionCalls: () => observedPartAcquisitionCalls,
    directoryInterpretations: () => directoryInterpretations,
    observerCalls: () => observerCalls,
    lastOrdinaryReuseAvailability: () => lastOrdinaryReuseAvailability,
    enrichmentCollectionCalls: (sourceIdentity: string) =>
      enrichmentCollectionCalls.get(sourceIdentity) ?? 0,
    changePreviews,
    automationIntents,
    persisted,
    resumeClaims,
    executionCommands: persistence,
    sourceRefreshRunPersistence,
  };
}

describe("Asset Refresh acceptance", () => {
  it("rejects a corrupt persisted AcceptedRecognition batch before invoking its persistence Port", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      singletonExplicit: true,
    });
    const proposed = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: false,
    });
    const inspection = subject.persisted.get(proposed.execution.id)!;
    const stored = inspection.proposal!;
    const workItem = {
      ...inspection.execution.workItems![0],
      outcome: undefined,
      reason: undefined,
    };
    if (stored.basis.kind !== "source-interpretation")
      throw new Error("测试提案缺少来源解释依据");
    const malformedInterpretation = { ...stored.basis.interpretation };
    Object.defineProperty(malformedInterpretation, "sourceIdentity", {
      enumerable: true,
      get: () =>
        (new Error().stack ?? "").includes("createAcceptedRecognition")
          ? "source"
          : "corrupt-source",
    });
    subject.persisted.set(proposed.execution.id, {
      ...inspection,
      execution: {
        ...inspection.execution,
        workflowInput: {
          ...inspection.execution.workflowInput!,
          acceptTrusted: true,
        },
        status: "running",
        stage: "recognition",
        outcome: undefined,
        reason: undefined,
        workItems: [workItem],
      },
      proposal: {
        ...stored,
        basis: { ...stored.basis, interpretation: malformedInterpretation },
      },
      workItemInspections: [
        {
          workItem,
          proposal: {
            ...stored,
            basis: {
              ...stored.basis,
              interpretation: malformedInterpretation,
            },
          },
        },
      ],
    });

    const resumed = await subject.workflow.resume({
      executionId: proposed.execution.id,
    });

    expect(resumed.execution).toMatchObject({
      outcome: "failed",
    });
    expect(resumed.execution.workItems?.[0]).toMatchObject({
      outcome: "failed",
      reason:
        "Source Association must match the Recognition Proposal source identity",
    });
    expect(subject.recognitionAcceptanceCalls()).toBe(0);
    expect(subject.accepted).toEqual([]);
  });

  it("rejects a directory interpreter that spoofs an ordinary evidence producer", async () => {
    const subject = refreshFixture({ directoryEvidenceProducerSpoof: true });

    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
    });

    expect(result.execution).toMatchObject({
      outcome: "failed",
      reason:
        "Recognition Evidence producer does not match the executing capability",
    });
    expect(subject.accepted).toHaveLength(0);
  });

  it("rejects a directory interpreter that spoofs evidence inside an itemized work plan", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      directoryEvidenceProducerSpoof: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution).toMatchObject({
      outcome: "failed",
      reason:
        "Recognition Evidence producer does not match the executing capability",
    });
    expect(
      subject.persisted.get(result.execution.id)?.execution.compatibility,
    ).toMatchObject({
      capabilityCoordinates: expect.arrayContaining(["directory@1/1"]),
    });
    expect(subject.accepted).toHaveLength(0);
  });

  it("rejects a format inspector that spoofs its evidence producer", async () => {
    const subject = refreshFixture({
      formatFactsOnly: true,
      formatEvidenceProducerSpoof: true,
    });

    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
    });

    expect(result.execution).toMatchObject({
      outcome: "failed",
      reason:
        "Recognition Evidence producer does not match the executing capability",
    });
    expect(
      subject.persisted.get(result.execution.id)?.execution.compatibility,
    ).toMatchObject({
      capabilityCoordinates: expect.arrayContaining(["format.inspector@1/1"]),
    });
    expect(subject.accepted).toHaveLength(0);
  });

  it("accepts one observed-evidence proposal without manufacturing a Source Association", async () => {
    const subject = refreshFixture({
      formatFactsOnly: true,
      recognitionBasis: "observed-evidence",
    });

    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
    });

    expect(
      result.execution.outcome,
      JSON.stringify(result.execution.workItems),
    ).toBe("accepted");
    expect(subject.accepted).toHaveLength(1);
    expect(subject.accepted[0]?.proposal.basis.kind).toBe("observed-evidence");
    expect(subject.accepted[0]?.sourceAssociations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nativeAddress: "https://source.example/fault",
        }),
      ]),
    );
    expect(subject.accepted[0]?.recognitionSourceAssociation).toBeUndefined();
  });

  it("routes a changed observed-only material boundary through correction preview", async () => {
    let version = 1;
    const subject = refreshFixture({
      formatFactsOnly: true,
      recognitionBasis: "observed-evidence",
      snapshotVersion: () => version,
    });
    await scanFixtureObservedScope(subject.workflow, { acceptTrusted: true });
    const first = subject.accepted[0];
    const firstEntityId = first?.entity.id;
    const firstDecisionId = first?.recognitionDecision.id;
    const previewCountBefore = subject.changePreviews.size;
    version = 2;

    const changed = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
    });
    // 有字节改动落在已确认头范围内时，现在就地耐久重接受（accepted），不再新增改动影响预览：
    // 见生产 index.ts:18079-18270，同主体同决定重接受 index.ts:25572。
    expect(changed.execution.outcome).toBe("accepted");
    expect(subject.changePreviews.size).toBe(previewCountBefore);
    // 价值保留：同一资产、同一识别决定被就地刷新，观察版本推进（新记录替换旧记录），
    // 既没有新建身份/决定，也没有重复资产。
    expect(subject.accepted).toHaveLength(1);
    expect(subject.accepted[0].entity.id).toBe(firstEntityId);
    expect(subject.accepted[0].recognitionDecision.id).toBe(firstDecisionId);
    expect(subject.accepted[0]).not.toBe(first);
  });

  it("adds a later ordinary source to an observed-evidence asset without rewriting its recognition basis", async () => {
    const subject = refreshFixture({
      formatFactsOnly: true,
      recognitionBasis: "observed-evidence",
      sourceEnrichmentSucceeds: true,
    });

    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.awards", necessity: "optional" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(subject.accepted[0]?.proposal.basis.kind).toBe("observed-evidence");
    expect(subject.accepted[0]?.recognitionSourceAssociation).toBeUndefined();
    expect(subject.accepted[0]?.sourceAssociations).toEqual([
      expect.objectContaining({ sourceIdentity: "supplement" }),
    ]);
  });

  it("reports no current source when refreshing an observed-evidence asset and keeps it admitted", async () => {
    const subject = refreshFixture({
      formatFactsOnly: true,
      recognitionBasis: "observed-evidence",
    });
    await scanFixtureObservedScope(subject.workflow, { acceptTrusted: true });
    const assetId = subject.accepted[0].entity.id;

    const refreshed = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          { subjectId: assetId, explanations: [{ path: ["test", "asset"] }] },
        ],
        filesystemScopes: [],
      },
    });

    expect(refreshed.execution.outcome).toBe("failed");
    expect(refreshed.execution.targetDispositions).toEqual([
      expect.objectContaining({
        target: { kind: "subject", subjectId: assetId },
        status: "failed",
        reason: "所选主体没有当前来源关联",
      }),
    ]);
    expect(subject.accepted[0]?.entity.id).toBe(assetId);
  });

  it("rejects a source-enrichment candidate interpreter that spoofs its evidence producer", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceEnrichmentCandidateProducerSpoof: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution).toMatchObject({
      outcome: "failed",
      reason:
        "Recognition Evidence producer does not match the executing capability",
    });
    expect(
      subject.persisted.get(result.execution.id)?.execution.compatibility,
    ).toMatchObject({
      capabilityCoordinates: expect.arrayContaining([
        "supplement.enricher@1/1",
      ]),
    });
    expect(result.accepted?.sourceAssociations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceIdentity: "supplement" }),
      ]),
    );
  });

  it("rejects a rogue recognizer that impersonates a trusted rule during an ordinary scan", async () => {
    const subject = refreshFixture({
      recognizerSpoofState: { enabled: true },
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(subject.accepted).toHaveLength(0);
  });

  it("rejects a trusted recognizer proposal that forges interpreter, evidence, and format provenance during an ordinary scan", async () => {
    const subject = refreshFixture({ recognizerProposalForgery: "all" });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution).toMatchObject({
      outcome: "failed",
      reason: "1 个工作项未完成；其余工作项已独立保留结果",
    });
    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "failed",
          reason: expect.stringContaining("Recognizer"),
        }),
      ]),
    );
    expect(subject.accepted).toEqual([]);
  });

  it("rejects a trusted recognizer that adds evidence during itemized recognition", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      recognizerProposalForgery: "evidence",
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "failed",
          reason: expect.stringContaining(
            "Recognition Rule Result references evidence outside the recognizer input",
          ),
        }),
      ]),
    );
    expect(subject.accepted).toEqual([]);
  });

  it("rejects a trusted recognizer that injects observed format facts when resuming", async () => {
    const subject = refreshFixture({ recognizerProposalForgery: "observed" });
    let executionId = "";

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onCheckpoint(execution) {
          executionId = execution.id;
          throw new Error("stop before recognition");
        },
      }),
    ).rejects.toThrow("stop before recognition");

    const resumed = await subject.workflow.resume({
      executionId,
      acceptTrusted: true,
    });

    // 执行聚合原因承载在 execution 上，具体越权字段原因现在落在 workItems[]：
    // 见生产 index.ts:7372-7398（terminalFromWorkItems 聚合）与 index.ts:5060-5121（伪造护栏）。
    expect(resumed.execution).toMatchObject({
      outcome: "failed",
      reason: "1 个工作项未完成；其余工作项已独立保留结果",
    });
    expect(resumed.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "failed",
          reason: expect.stringContaining(
            "Recognizer proposal draft contains unauthorized fields",
          ),
        }),
      ]),
    );
    expect(subject.accepted).toEqual([]);
  });

  it("rejects a rogue recognizer that impersonates a trusted rule in every planned work item", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      recognizerSpoofState: { enabled: true },
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "failed" })]),
    );
    expect(subject.accepted).toHaveLength(0);
  });

  it("rejects a recognizer coordinate spoof when resuming before recognition", async () => {
    const spoof = { enabled: false };
    const subject = refreshFixture({ recognizerSpoofState: spoof });
    let executionId = "";

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onHostCheckpoint(execution) {
          if (
            !execution.workItems?.some(
              (item) =>
                item.sourceRecordIds.length > 0 &&
                item.proposalId === undefined,
            )
          )
            return;
          executionId = execution.id;
          throw new Error("stop before recognition");
        },
      }),
    ).rejects.toThrow("stop before recognition");
    spoof.enabled = true;

    const resumed = await subject.workflow.resume({
      executionId,
      acceptTrusted: true,
    });
    // 初次采集已耐久保存，识别器尚未参与；恢复时仍须拒绝其冒用受信规则的结果。
    expect(resumed.execution).toMatchObject({
      outcome: "failed",
      workItems: [
        expect.objectContaining({
          outcome: "failed",
          reason:
            "Recognition Rule Result producer does not match the executing recognizer",
        }),
      ],
    });
    expect(subject.accepted).toHaveLength(0);
    // 保留护栏价值：中断发生在接受之前，识别接受一次都没有被调用。
    expect(subject.recognitionAcceptanceCalls()).toBe(0);
  });

  it("durably freezes an interpreter coordinate before an ordinary scan interpreter throws", async () => {
    const subject = refreshFixture({
      sourceInterpreterFailureState: { enabled: true },
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(
      subject.persisted.get(result.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toContain("interpreter@1/1");
  });

  it("declares and freezes the filesystem observer before observation I/O or an observer error", async () => {
    const guarded = refreshFixture({
      requireObserverCoordinateBeforeInvocation: true,
    });
    await expect(
      refreshFixtureObservedScope(guarded.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      }),
    ).resolves.toMatchObject({ execution: { outcome: "accepted" } });

    const failing = refreshFixture({
      observerFailureState: { enabled: true },
    });
    const failed = await refreshFixtureObservedScope(failing.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    expect(failed.execution.outcome).toBe("failed");
    expect(
      failing.persisted.get(failed.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toContain("filesystem-observer@1/1");
  });

  it("rejects a spoofed snapshot root before recognition can create an outside Location", async () => {
    const subject = refreshFixture({
      spoofedSnapshotRoot: "/outside/not-a-registered-root",
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(result.accepted).toBeUndefined();
    expect(subject.accepted).toEqual([]);
  });

  it("fails closed before public scan work when a request escapes its registered root", async () => {
    const subject = refreshFixture();

    await expect(
      subject.workflow.scanObservedScope({
        registrationId: "fixture-root",
        relativeScope: "../outside",
        acceptTrusted: true,
      }),
    ).rejects.toThrow("范围不能越过登记根目录");

    expect(subject.observerCalls()).toBe(0);
    expect(subject.accepted).toEqual([]);
  });

  it("durably freezes a recognizer coordinate before an ordinary scan recognizer throws", async () => {
    const subject = refreshFixture({
      recognizerFailureState: { enabled: true },
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(
      subject.persisted.get(result.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toContain("recognizer@1/1");
  });

  it("durably freezes the actual acquirer coordinate before an ordinary scan acquisition throws", async () => {
    const subject = refreshFixture({ coverFails: true });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(
      subject.persisted.get(result.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toContain("acquirer@1/1");
  });

  it("freezes the ordinary scan collector coordinate before collector I/O", async () => {
    const subject = refreshFixture({
      requireCollectorCoordinateBeforeInvocation: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("accepted");
  });

  it("uses the latest durable execution when a metadata-refresh interpreter throws", async () => {
    const failure = { enabled: false };
    const subject = refreshFixture({
      sourceInterpreterFailureState: failure,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    failure.enabled = true;

    const result = await refreshFixtureMetadata(
      subject.workflow,
      subject.accepted[0].entity.id,
    );

    expect(result.execution.outcome).toBe("failed");
    expect(
      subject.persisted.get(result.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toEqual(expect.arrayContaining(["collector@1/1", "interpreter@1/1"]));
  });

  it("retains the actual producer coordinate on collected records and every derived source fact", async () => {
    const subject = refreshFixture({ sourceRelationshipQualifiers: true });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const persisted = subject.persisted.get(result.execution.id)!;

    expect(persisted.sourceRecords[0]).toMatchObject({
      producer: {
        capabilityId: "collector",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    });
    expect(persisted.accepted?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          producer: expect.objectContaining({ capabilityId: "interpreter" }),
        }),
      ]),
    );
    expect(persisted.accepted?.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          producer: expect.objectContaining({ capabilityId: "interpreter" }),
        }),
      ]),
    );
    expect(persisted.accepted?.artifactAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          producer: expect.objectContaining({ capabilityId: "interpreter" }),
        }),
      ]),
    );
  });

  it("projects a complete Bangumi fact by its source coordinate, not its adopting episode address", async () => {
    const subject = refreshFixture({
      fullSourceRelationship: true,
      independentEvidence: true,
      thirdIndependentBoundary: true,
      sourceAddressForSnapshotVersion: () =>
        "https://bangumi.example/episode/one",
      sourceFactEpisodeAddresses: {
        second: "https://bangumi.example/episode/two",
        third: "https://bangumi.example/episode/foreign-source",
      },
      sourceFactIdentityForAddress: (address) =>
        address === "https://bangumi.example/episode/foreign-source"
          ? "other-bangumi"
          : "bangumi",
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("accepted");
    const relationships = subject.accepted.flatMap(
      (accepted) => accepted.relationships ?? [],
    );
    const bangumiRelationshipIds = relationships
      .filter((relationship) => relationship.type === "bangumi.subject.related")
      .map((relationship) => relationship.id);
    expect(bangumiRelationshipIds).toHaveLength(3);
    expect(bangumiRelationshipIds[0]).toBe(bangumiRelationshipIds[1]);
    expect(bangumiRelationshipIds[2]).not.toBe(bangumiRelationshipIds[0]);
    expect(new Set(bangumiRelationshipIds).size).toBe(2);
  });

  it("freezes only capabilities that actually participate in a filesystem refresh", async () => {
    const subject = refreshFixture({ unusedConfiguredCollector: true });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const compatibility = subject.persisted.get(result.execution.id)?.execution
      .compatibility;

    expect(compatibility?.capabilityCoordinates).toEqual(
      expect.arrayContaining([
        "collector@1/1",
        "interpreter@1/1",
        "recognizer@1/1",
        "acquirer@1/1",
      ]),
    );
    expect(compatibility?.capabilityCoordinates).not.toContain(
      "unused.collector@1/1",
    );
  });

  it("retains only actual capabilities across itemized refresh work", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      unusedConfiguredCollector: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const coordinates = subject.persisted.get(result.execution.id)?.execution
      .compatibility.capabilityCoordinates;

    expect(coordinates).toEqual(
      expect.arrayContaining([
        "collector@1/1",
        "interpreter@1/1",
        "recognizer@1/1",
        "acquirer@1/1",
      ]),
    );
    expect(coordinates).not.toContain("unused.collector@1/1");
  });

  it("freezes itemized collector, interpreter, and recognizer coordinates before their calls", async () => {
    const collector = refreshFixture({
      independentEvidence: true,
      requireCollectorCoordinateBeforeInvocation: true,
    });
    await expect(
      refreshFixtureObservedScope(collector.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      }),
    ).resolves.toMatchObject({ execution: { outcome: "accepted" } });

    const interpreter = refreshFixture({
      independentEvidence: true,
      sourceInterpreterFailureState: { enabled: true },
    });
    const interpreterResult = await refreshFixtureObservedScope(
      interpreter.workflow,
      {
        directory: "/observed/work",
        acceptTrusted: true,
      },
    );
    expect(
      interpreter.persisted.get(interpreterResult.execution.id)?.execution
        .compatibility.capabilityCoordinates,
    ).toContain("interpreter@1/1");

    const recognizer = refreshFixture({
      independentEvidence: true,
      recognizerFailureState: { enabled: true },
    });
    const recognizerResult = await refreshFixtureObservedScope(
      recognizer.workflow,
      {
        directory: "/observed/work",
        acceptTrusted: true,
      },
    );
    expect(
      recognizer.persisted.get(recognizerResult.execution.id)?.execution
        .compatibility.capabilityCoordinates,
    ).toContain("recognizer@1/1");
  });

  it("freezes the selected itemized acquirer coordinate before acquisition fails", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      coverFails: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(
      subject.persisted.get(result.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toContain("acquirer@1/1");
  });

  it("retains only actual capabilities across metadata refresh work", async () => {
    const subject = refreshFixture({ unusedConfiguredCollector: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    const result = await refreshFixtureMetadata(
      subject.workflow,
      subject.accepted[0].entity.id,
      { informationRequirement: primaryCoverRequirement },
    );
    const coordinates = subject.persisted.get(result.execution.id)?.execution
      .compatibility.capabilityCoordinates;

    expect(coordinates).toEqual(
      expect.arrayContaining(["collector@1/1", "interpreter@1/1"]),
    );
    expect(coordinates).not.toContain("unused.collector@1/1");
  });

  it("retains only actual capabilities across configured source enrichment", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      unusedConfiguredCollector: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const coordinates = subject.persisted.get(result.execution.id)?.execution
      .compatibility.capabilityCoordinates;

    expect(coordinates).toEqual(
      expect.arrayContaining([
        "supplement.enricher@1/1",
        "supplement.collector@1/1",
        "supplement.interpreter@1/1",
        "supplement.association-interpreter@1/1",
      ]),
    );
    expect(coordinates).not.toContain("unused.collector@1/1");
  });

  it("accepts required metadata supplied only by attached observed format facts", async () => {
    const subject = refreshFixture({
      formatFactsOnly: true,
      sourceOmitsTitle: true,
      formatIncludesTitle: true,
    });

    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.title", necessity: "required" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(result.itemResults?.[0]?.accepted?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Local work",
          sourceRecordIds: [],
          observedArtifactPart: expect.objectContaining({
            locator: "format:title",
          }),
        }),
      ]),
    );
  });

  it("retains inspector and actual observed-part acquirer provenance across local facts", async () => {
    const subject = refreshFixture({
      formatFactsOnly: true,
      sourceOmitsTitle: true,
      sourceOmitsCover: true,
    });

    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.title", necessity: "required" }],
        artifactRoles: [
          { role: "asset.primary-cover", necessity: "required", maximum: 1 },
        ],
        relationshipTypes: [],
      },
    });
    const accepted = subject.accepted[0];
    const localMetadata = accepted.metadata.find(
      (item) => item.sourceSlot === "format.title",
    );
    const localPart = accepted.artifactAssociations.find(
      (item) => item.role === "asset.primary-cover",
    );
    const localPartRevision = accepted.artifactRevisions.find(
      (item) => item.artifactId === localPart?.artifactId,
    );
    const parentRevision = accepted.artifactRevisions.find(
      (item) => item.id === localMetadata?.observedArtifactPart?.revisionId,
    );

    expect(result.execution.outcome).toBe("accepted");
    expect(localMetadata?.producer).toMatchObject({
      capabilityId: "format.inspector",
    });
    expect(parentRevision?.producer).toMatchObject({
      capabilityId: "format.inspector",
    });
    expect(localPart?.producer).toMatchObject({
      capabilityId: "format.part",
    });
    expect(localPartRevision?.producer).toMatchObject({
      capabilityId: "format.part",
    });
  });

  it("binds actual format evidence provenance into local facts and item reuse compatibility", async () => {
    const subject = refreshFixture({
      formatFactsOnly: true,
      sourceOmitsTitle: true,
    });

    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const persisted = subject.persisted.get(result.execution.id)!;
    const localTitle = persisted.accepted?.metadata.find(
      (item) => item.sourceSlot === "format.title",
    );
    const parentRevision = persisted.accepted?.artifactRevisions.find(
      (item) => item.id === localTitle?.observedArtifactPart?.revisionId,
    );
    const item = persisted.execution.workItems?.[0];

    expect(result.execution.outcome).toBe("accepted");
    expect(localTitle?.producer).toMatchObject({
      capabilityId: "format.inspector",
      capabilityVersion: "1",
      contractVersion: "1",
    });
    expect(parentRevision?.producer).toMatchObject({
      capabilityId: "format.inspector",
    });
    expect(item?.reuseCompatibility?.capabilityCoordinates).toContain(
      "format.inspector@1/1",
    );
  });

  it("fails required metadata when neither source nor observed format facts supply it", async () => {
    const subject = refreshFixture({
      formatFactsOnly: true,
      sourceOmitsTitle: true,
      formatIncludesTitle: false,
    });

    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.title", necessity: "required" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });

    expect(result.execution.outcome).toBe("failed");
    expect(result.execution.workItems?.[0]?.reason).toContain(
      "缺少必需的元数据属性：asset.title",
    );
  });

  it("reinspects when an observed format capability coordinate changes", async () => {
    const coordinate = { capabilityVersion: "1", contractVersion: "1" };
    const subject = refreshFixture({
      formatFactsOnly: true,
      sourceOmitsTitle: true,
      formatCoordinateState: coordinate,
    });
    await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
    });
    coordinate.contractVersion = "2";

    const repeated = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
    });

    expect(repeated.execution.outcome).toBe("accepted");
    expect(subject.formatInspectionCalls()).toBe(2);
    expect(subject.collectionCalls()).toBe(1);
    expect(subject.accepted.at(-1)?.artifactRevisions).toContainEqual(
      expect.objectContaining({
        producer: {
          capabilityId: "format.inspector",
          capabilityVersion: "1",
          contractVersion: "2",
        },
      }),
    );
  });

  it("does not reuse an ordinary scan when collector and interpreter contracts advance, and records their new provenance", async () => {
    const collector = { capabilityVersion: "1", contractVersion: "1" };
    const interpreter = { capabilityVersion: "1", contractVersion: "1" };
    const subject = refreshFixture({
      collectorCoordinateState: collector,
      sourceInterpreterCoordinateState: interpreter,
    });
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    collector.capabilityVersion = "2";
    collector.contractVersion = "2";
    interpreter.capabilityVersion = "2";
    interpreter.contractVersion = "2";

    const initialDecisionId = subject.accepted[0]!.recognitionDecision.id;
    const repeated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(initial.execution.outcome).toBe("accepted");
    expect(repeated.execution.outcome).toBe("no-change");
    expect(repeated.execution.reusedExecutionId).toBeUndefined();
    expect(subject.collectionCalls()).toBe(1);
    expect(repeated.execution.workItems).toEqual([
      expect.objectContaining({
        outcome: "no-change",
        acceptedAssetId: initial.accepted!.entity.id,
      }),
    ]);
    expect(subject.accepted[0]!.recognitionDecision.id).toBe(initialDecisionId);
    const refreshed = await refreshFixtureMetadata(
      subject.workflow,
      initial.accepted!.entity.id,
    );
    expect(subject.collectionCalls()).toBe(2);
    expect(refreshed.accepted?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          producer: expect.objectContaining({
            capabilityId: "interpreter",
            capabilityVersion: "2",
            contractVersion: "2",
          }),
        }),
      ]),
    );
    expect(
      subject.persisted.get(refreshed.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toEqual(expect.arrayContaining(["collector@2/2", "interpreter@2/2"]));
  });

  it("reuses an ordinary scan after a later deployment adds an unused collector", async () => {
    const unusedCollector = { enabled: false };
    const subject = refreshFixture({
      unusedConfiguredCollectorState: unusedCollector,
    });
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    unusedCollector.enabled = true;

    const repeated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(
      subject.persisted.get(repeated.execution.id)?.execution.reusePlan,
    ).toEqual(subject.persisted.get(initial.execution.id)?.execution.reusePlan);
    expect(repeated.execution).toMatchObject({
      outcome: "no-change",
      workItems: [
        expect.objectContaining({
          outcome: "no-change",
          acceptedAssetId: initial.accepted!.entity.id,
        }),
      ],
    });
    expect(
      subject.persisted.get(repeated.execution.id)!.execution.compatibility
        .capabilityCoordinates,
    ).not.toContain("unused.collector@1/1");
    expect(subject.collectionCalls()).toBe(1);
  });

  it("does not reuse an ordinary scan whose legacy execution lacks frozen capabilities", async () => {
    const subject = refreshFixture();
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const persisted = subject.persisted.get(initial.execution.id)!;
    subject.persisted.set(initial.execution.id, {
      ...persisted,
      execution: {
        ...persisted.execution,
        compatibility: {
          ...persisted.execution.compatibility,
          capabilityCoordinates: [],
        },
      },
    });

    const initialDecisionId = subject.accepted[0]!.recognitionDecision.id;
    const repeated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(repeated.execution.reusedExecutionId).toBeUndefined();
    expect(subject.collectionCalls()).toBe(1);
    expect(repeated.execution.workItems).toEqual([
      expect.objectContaining({
        outcome: "no-change",
        acceptedAssetId: initial.accepted!.entity.id,
      }),
    ]);
    expect(
      subject.persisted.get(initial.execution.id)!.execution.compatibility
        .capabilityCoordinates,
    ).toEqual([]);
    expect(subject.accepted[0]!.recognitionDecision.id).toBe(initialDecisionId);
  });

  it("rematerializes a required observed part when its acquirer coordinate changes", async () => {
    const coordinate = { capabilityVersion: "1", contractVersion: "1" };
    const subject = refreshFixture({
      formatFactsOnly: true,
      sourceOmitsTitle: true,
      partAcquirerCoordinateState: coordinate,
    });
    await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const initialPart = subject.accepted[0]!.artifactRevisions.find(
      (revision) => revision.producer?.capabilityId === "format.part",
    );
    expect(initialPart?.producer).toEqual({
      capabilityId: "format.part",
      capabilityVersion: "1",
      contractVersion: "1",
    });
    coordinate.capabilityVersion = "2";

    const repeated = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(initialPart?.producer?.capabilityVersion).toBe("1");
    expect(repeated.execution.outcome).toBe("accepted");
    expect(subject.observedPartAcquisitionCalls()).toBe(2);
    expect(subject.managedStoreCalls()).toBe(3);
    expect(subject.collectionCalls()).toBe(1);
    expect(subject.accepted.at(-1)?.artifactRevisions).toContainEqual(
      expect.objectContaining({
        producer: {
          capabilityId: "format.part",
          capabilityVersion: "2",
          contractVersion: "1",
        },
      }),
    );
    const unchanged = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    expect(unchanged.execution.outcome).toBe("no-change");
    expect(subject.observedPartAcquisitionCalls()).toBe(2);
    expect(subject.managedStoreCalls()).toBe(3);
    expect(subject.collectionCalls()).toBe(1);
  });

  it("materializes local format facts only with a persisted parent revision", async () => {
    const subject = refreshFixture({ observedEpubPartOnly: true });
    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    if (result.execution.outcome !== "accepted")
      throw new Error(result.execution.reason ?? "local part was not accepted");
    const accepted = subject.accepted[0];
    const local = accepted.metadata.find(
      (item) => item.sourceSlot === "format.title",
    );
    expect(local).toMatchObject({
      sourceRecordIds: [],
      observedArtifactPart: { locator: "format:title" },
    });
    const parent = accepted.artifactRevisions.find(
      (item) => item.id === local?.observedArtifactPart?.revisionId,
    );
    expect(parent).toMatchObject({
      artifactId: local?.observedArtifactPart?.artifactId,
      blobDigest: "observed-parent-digest",
    });
    expect(accepted.blobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          digest: "observed-parent-digest",
          mediaType: "application/x-test-container",
        }),
      ]),
    );
  });

  it("rejects a changed observed-part parent before managed storage", async () => {
    const subject = refreshFixture({
      observedEpubPartOnly: true,
      observedPartOriginDigest: "changed-observed-parent-digest",
    });

    const result = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution).toMatchObject({
      outcome: "failed",
      workItems: [
        expect.objectContaining({
          outcome: "failed",
          reason:
            "Observed Artifact Part acquisition contradicts its proposed parent revision",
        }),
      ],
    });
    expect(subject.managedStoreCalls()).toBe(0);
  });

  it("keeps materializing a persisted observed part without a proposed parent revision", async () => {
    const subject = refreshFixture({ observedEpubPartOnly: true });
    const proposed = await scanFixtureObservedScope(subject.workflow, {
      acceptTrusted: false,
      informationRequirement: primaryCoverRequirement,
    });
    const inspection = subject.persisted.get(proposed.execution.id)!;
    const stored = inspection.proposal!;
    const workItem = {
      ...inspection.execution.workItems![0],
      outcome: undefined,
      reason: undefined,
    };
    const withoutProposedParent = {
      ...stored,
      observedArtifactRevisions: [],
    };
    subject.persisted.set(proposed.execution.id, {
      ...inspection,
      execution: {
        ...inspection.execution,
        workflowInput: {
          ...inspection.execution.workflowInput!,
          acceptTrusted: true,
        },
        status: "running",
        stage: "recognition",
        outcome: undefined,
        reason: undefined,
        workItems: [workItem],
      },
      proposal: withoutProposedParent,
      workItemInspections: [{ workItem, proposal: withoutProposedParent }],
    });

    const resumed = await subject.workflow.resume({
      executionId: proposed.execution.id,
    });

    expect(resumed.execution.outcome).toBe("accepted");
    expect(subject.managedStoreCalls()).toBe(1);
  });

  it("fails an incomplete filesystem snapshot before interpreting or committing work items", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      incompleteSnapshot: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution).toMatchObject({
      status: "failed",
      stage: "failed",
      outcome: "failed",
      reason: "Filesystem snapshot is incomplete",
    });
    expect(subject.accepted).toEqual([]);
    expect(subject.directoryInterpretations()).toBe(0);
  });

  it("permits a source artifact only for a resolved provenance-bearing proposal Entity", () => {
    const batch = {
      id: "batch",
      producer: {
        capabilityId: "source",
        capabilityVersion: "1",
        contractVersion: "1",
      },
      sourceRecordIds: ["record"],
      sourceIdentity: "source",
      sourceAddress: "source:asset",
      metadata: [],
      entities: [
        {
          id: "work",
          kind: "entity" as const,
          sourceIdentity: "source",
          sourceKey: "work",
          identityNamespace: "source.work",
          label: "Shared work",
          sourceRecordIds: ["record"],
        },
      ],
      sourceArtifacts: [
        {
          id: "cover",
          sourceRecordId: "record",
          subjectId: "work",
          role: "asset.primary-cover",
          acquisitionReference: "source:cover",
          mediaType: "image/jpeg",
        },
      ],
    };
    expect(validateSourceInterpretationBatch(batch)).toBe(batch);
    expect(() =>
      validateSourceInterpretationBatch({
        ...batch,
        sourceArtifacts: [
          { ...batch.sourceArtifacts[0], subjectId: "injected" },
        ],
      }),
    ).toThrow("target must be a sourced resolved Entity");
  });

  it("commits one explicit work-item boundary when a sibling boundary's source work fails", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      failSecondCollection: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(subject.accepted).toHaveLength(1);
    expect(result.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "work-item:first-boundary",
          status: "completed",
        }),
        expect.objectContaining({
          key: "work-item:second-boundary",
          status: "failed",
          reason: "other work is offline",
        }),
      ]),
    );
  });

  it("records two explicit boundaries as independently accepted work items", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      sharedCollectionScope: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(subject.accepted).toHaveLength(2);
    expect(result.execution.workItems).toEqual([
      expect.objectContaining({
        key: "first-boundary",
        proposalId: "first-proposal",
        acceptedAssetId: subject.accepted[0]?.entity.id,
        outcome: "accepted",
      }),
      expect.objectContaining({
        key: "second-boundary",
        proposalId: "other-proposal",
        acceptedAssetId: subject.accepted[1]?.entity.id,
        outcome: "accepted",
      }),
    ]);
    expect(subject.accepted.map((accepted) => accepted.artifacts)).toEqual([
      [expect.any(Object)],
      [expect.any(Object)],
    ]);
  });

  it("consumes one shared collection result once per work item batch", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      duplicateFirstBoundaryEvidence: true,
      sharedCollectionScope: true,
      sharedCollectionFailure: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(subject.collectionCalls()).toBe(1);
    expect(result.sourceRecords).toHaveLength(1);
    expect(result.execution.workItems?.[0]?.sourceRecordIds).toEqual([
      "shared-recovery-record",
    ]);
    expect(
      result.execution.dispositions.find(
        (item) => item.key === "work-item:first-boundary",
      )?.sourceFailureCodes,
    ).toEqual([expect.objectContaining({ code: "optional-metadata" })]);
  });

  it("rejects conflicting records with the same id in one work item batch", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      singletonExplicit: true,
      sharedCollectionScope: true,
      conflictingSharedRecord: true,
    });

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      }),
    ).rejects.toThrow("同一来源记录标识对应冲突的不可变记录");
  });

  it("rejects the same record id when producer interpretation versions differ only by presence", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      singletonExplicit: true,
      producerInterpretationPresenceConflict: true,
      dynamicRecoveryCollectorState: {
        enabled: true,
        firstApplicable: true,
        retainRecord: true,
        retainedRecordId: "record",
        omitInterpretationContractVersions: true,
        nonShareable: true,
        canCollectCalls: 0,
        collectCalls: 0,
      },
    });

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      }),
    ).rejects.toThrow("同一来源记录标识对应冲突的不可变记录");
  });

  it("keeps one explicit boundary itemized and binds only its selected paths", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      singletonExplicit: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.workItems).toEqual([
      expect.objectContaining({
        key: "first-boundary",
        relativePaths: ["track.flac"],
        outcome: "accepted",
      }),
    ]);
    expect(result.itemResults?.[0]?.accepted?.locations).toEqual([
      expect.objectContaining({
        address: "/observed/work/track.flac",
        kind: "observed",
      }),
    ]);
  });

  it("runs configured Source Enrichment for an accepted explicit work item in the same parent execution", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      singletonExplicit: true,
      sourceEnrichmentSucceeds: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.awards", necessity: "optional" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(result.itemResults?.[0]?.accepted?.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceIdentity: "source" }),
        expect.objectContaining({ sourceIdentity: "supplement" }),
      ]),
    );
    const awards = result.itemResults?.[0]?.accepted?.facts.descriptions
      .flatMap((description) => description.metadata)
      .find((item) => item.property === "asset.awards");
    expect(awards?.result).toMatchObject({
      status: "resolved",
      values: [
        expect.objectContaining({
          property: "asset.awards",
          value: "One award",
          sourceIdentity: "supplement",
        }),
      ],
    });
  });

  it("reuses every unchanged explicit boundary without new source or catalogue effects", async () => {
    const subject = refreshFixture({ independentEvidence: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const repeated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(repeated.execution.outcome).toBe("no-change");
    expect(repeated.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePaths: ["track.flac"],
          outcome: "no-change",
        }),
        expect.objectContaining({
          relativePaths: ["other.flac"],
          outcome: "no-change",
        }),
      ]),
    );
    expect(subject.collectionCalls()).toBe(2);
    expect(subject.accepted).toHaveLength(2);
  });

  it("来源能力升级保留已确认边界，显式资料刷新使用新坐标", async () => {
    const collector = { capabilityVersion: "1", contractVersion: "1" };
    const interpreter = { capabilityVersion: "1", contractVersion: "1" };
    const recognizer = { capabilityVersion: "1", contractVersion: "1" };
    const acquirer = { capabilityVersion: "1", contractVersion: "1" };
    const subject = refreshFixture({
      independentEvidence: true,
      collectorCoordinateState: collector,
      sourceInterpreterCoordinateState: interpreter,
      recognizerCoordinateState: recognizer,
      acquirerCoordinateState: acquirer,
    });
    const first = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const second = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(first.execution.outcome).toBe("accepted");
    expect(second.execution.outcome).toBe("no-change");

    collector.capabilityVersion = "2";
    collector.contractVersion = "2";
    interpreter.capabilityVersion = "2";
    interpreter.contractVersion = "2";
    recognizer.capabilityVersion = "2";
    recognizer.contractVersion = "2";
    acquirer.capabilityVersion = "2";
    acquirer.contractVersion = "2";

    const third = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(third.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePaths: ["track.flac"],
          outcome: "no-change",
        }),
        expect.objectContaining({
          relativePaths: ["other.flac"],
          outcome: "no-change",
        }),
      ]),
    );
    expect(subject.collectionCalls()).toBe(2);
    for (const accepted of subject.accepted) {
      const refreshed = await refreshFixtureMetadata(
        subject.workflow,
        accepted.entity.id,
      );
      expect(refreshed.accepted?.entity.id).toBe(accepted.entity.id);
      expect(
        subject.persisted.get(refreshed.execution.id)?.execution.compatibility
          .capabilityCoordinates,
      ).toEqual(expect.arrayContaining(["collector@2/2", "interpreter@2/2"]));
    }
    expect(subject.collectionCalls()).toBe(4);
    expect(subject.accepted).toHaveLength(2);
  });

  it("continues to reuse an item's complete closure when no capability changed", async () => {
    const subject = refreshFixture({ independentEvidence: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    const third = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(third.execution.outcome).toBe("no-change");
    expect(third.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePaths: ["track.flac"],
          outcome: "no-change",
        }),
        expect.objectContaining({
          relativePaths: ["other.flac"],
          outcome: "no-change",
        }),
      ]),
    );
    expect(subject.collectionCalls()).toBe(2);
  });

  it("reuses explicit boundaries after a later deployment adds an unused collector", async () => {
    const unusedCollector = { enabled: false };
    const subject = refreshFixture({
      independentEvidence: true,
      unusedConfiguredCollectorState: unusedCollector,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    unusedCollector.enabled = true;

    const repeated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(repeated.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePaths: ["track.flac"],
          outcome: "no-change",
        }),
        expect.objectContaining({
          relativePaths: ["other.flac"],
          outcome: "no-change",
        }),
      ]),
    );
    expect(subject.collectionCalls()).toBe(2);
  });

  it("does not reuse an explicit boundary missing its own frozen coordinates", async () => {
    const subject = refreshFixture({ independentEvidence: true });
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const persisted = subject.persisted.get(initial.execution.id)!;
    subject.persisted.set(initial.execution.id, {
      ...persisted,
      execution: {
        ...persisted.execution,
        workItems: persisted.execution.workItems?.map((item) => {
          const { reuseCompatibility: _reuseCompatibility, ...legacy } = item;
          return legacy;
        }),
      },
    });

    const repeated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(repeated.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePaths: ["track.flac"],
          outcome: "no-change",
        }),
        expect.objectContaining({
          relativePaths: ["other.flac"],
          outcome: "no-change",
        }),
      ]),
    );
    expect(subject.collectionCalls()).toBe(2);
    expect(
      subject.persisted
        .get(initial.execution.id)!
        .execution.workItems?.every(
          (item) => item.reuseCompatibility === undefined,
        ),
    ).toBe(true);
    expect(subject.accepted).toHaveLength(2);
    expect(
      repeated.execution.workItems
        ?.map((item) => item.acceptedAssetId)
        .toSorted(),
    ).toEqual(subject.accepted.map((item) => item.entity.id).toSorted());
  });

  it("reevaluates same-path explicit boundaries when their frozen observations change", async () => {
    let snapshotVersion = 0;
    const subject = refreshFixture({
      independentEvidence: true,
      snapshotVersion: (relativePath) =>
        relativePath === "track.flac" ? snapshotVersion : 0,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const initialIdentities = subject.accepted.map((item) => ({
      assetId: item.entity.id,
      associationId: item.recognitionSourceAssociation!.id,
      decisionId: item.recognitionDecision.id,
    }));

    const before = subject.accepted.map((item) => ({
      id: item.entity.id,
      revisions: item.artifactRevisions,
      metadata: item.metadata,
    }));
    snapshotVersion = 1;
    const changed = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(changed.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePaths: ["track.flac"],
          outcome: "accepted",
        }),
        expect.objectContaining({
          relativePaths: ["other.flac"],
          outcome: "no-change",
        }),
      ]),
    );
    expect(subject.collectionCalls()).toBe(2);
    expect(subject.accepted).toHaveLength(2);
    const observed = subject.persisted.get(changed.execution.id)!.execution
      .snapshot!.files;
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "track.flac",
          modifiedAt: "2026-07-29T00:00:01.000Z",
        }),
        expect.objectContaining({
          relativePath: "other.flac",
          modifiedAt: "2026-07-29T00:00:00.000Z",
        }),
      ]),
    );
    expect(
      subject.persisted
        .get(changed.execution.id)!
        .workItemInspections?.find((item) =>
          item.workItem.relativePaths.includes("track.flac"),
        )?.proposal?.basis.kind,
    ).toBe("accepted-boundary");
    for (const previous of before)
      expect(
        subject.accepted.find((item) => item.entity.id === previous.id)
          ?.metadata,
      ).toEqual(
        expect.arrayContaining(
          previous.metadata.filter((fact) => fact.sourceRecordIds.length > 0),
        ),
      );
    expect(
      subject.accepted.map((item) => ({
        assetId: item.entity.id,
        associationId: item.recognitionSourceAssociation!.id,
        decisionId: item.recognitionDecision.id,
      })),
    ).toEqual(initialIdentities);
  });

  it("preserves a work item's accepted identity while reevaluating changed observations", async () => {
    let snapshotVersion = 0;
    const subject = refreshFixture({
      independentEvidence: true,
      snapshotVersion: (path) => (path === "track.flac" ? snapshotVersion : 0),
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const firstAssetId = subject.accepted[0].entity.id;
    const firstAssociationId =
      subject.accepted[0].recognitionSourceAssociation!.id;
    const firstDecisionId = subject.accepted[0].recognitionDecision.id;

    snapshotVersion = 1;
    const refreshed = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(refreshed.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePaths: ["track.flac"],
          outcome: "accepted",
          acceptedAssetId: firstAssetId,
        }),
      ]),
    );
    expect(subject.accepted).toHaveLength(2);
    expect(subject.accepted[0]).toMatchObject({
      entity: { id: firstAssetId },
      recognitionSourceAssociation: { id: firstAssociationId },
      recognitionDecision: { id: firstDecisionId },
    });
  });

  it("reevaluates a formerly singular accepted boundary without creating another asset", async () => {
    let planExplicitBoundary = false;
    const subject = refreshFixture({
      explicitWorkItemsAfterFirstInterpretation: () => planExplicitBoundary,
    });

    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const current = subject.accepted[0];

    planExplicitBoundary = true;
    const reevaluated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(reevaluated.execution.workItems).toEqual([
      expect.objectContaining({
        relativePaths: ["track.flac"],
        outcome: "no-change",
        acceptedAssetId: current.entity.id,
      }),
    ]);
    expect(subject.collectionCalls()).toBe(1);
    expect(subject.accepted).toHaveLength(1);
    expect(subject.accepted[0]).toMatchObject({
      entity: { id: current.entity.id },
      recognitionSourceAssociation: {
        id: current.recognitionSourceAssociation!.id,
      },
      recognitionDecision: { id: current.recognitionDecision.id },
    });
  });

  it("routes an itemized address-only change to source association replacement", async () => {
    let snapshotVersion = 0;
    const subject = refreshFixture({
      independentEvidence: true,
      snapshotVersion: (path) => (path === "track.flac" ? snapshotVersion : 0),
      sourceAddressForSnapshotVersion: (version) =>
        version === 0
          ? "https://source.example/work"
          : "https://source.example/replacement",
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const assetId = subject.accepted[0]!.entity.id;
    const original = subject.accepted[0]!;
    snapshotVersion = 1;

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePaths: ["track.flac"],
          outcome: "accepted",
          acceptedAssetId: assetId,
        }),
      ]),
    );
    expect(subject.accepted.map((item) => item.entity.id)).toContain(assetId);
    expect(subject.accepted).toHaveLength(2);
    expect(subject.changePreviews.size).toBe(0);
    expect(subject.collectionCalls()).toBe(2);
    expect(subject.accepted[0]!.recognitionSourceAssociation).toEqual(
      original.recognitionSourceAssociation,
    );
    expect(
      subject.persisted.get(result.execution.id)!.execution.snapshot!.files,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "track.flac",
          modifiedAt: "2026-07-29T00:00:01.000Z",
        }),
      ]),
    );
    expect(subject.accepted[0]!.proposal.basis.kind).toBe("accepted-boundary");
    expect(subject.accepted[0]!.metadata).toEqual(
      expect.arrayContaining(
        original.metadata.filter((fact) => fact.sourceRecordIds.length > 0),
      ),
    );
  });

  it("does not reuse explicit boundaries when required metadata or relationships expand", async () => {
    const subject = refreshFixture({ independentEvidence: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const initialIdentities = subject.accepted.map((item) => ({
      assetId: item.entity.id,
      associationId: item.recognitionSourceAssociation!.id,
      decisionId: item.recognitionDecision.id,
    }));

    const expanded = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.description", necessity: "required" }],
        artifactRoles: [],
        relationshipTypes: [
          { type: "asset.contribution", necessity: "required" },
        ],
      },
    });

    expect(expanded.execution.outcome).toBe("no-change");
    expect(subject.collectionCalls()).toBe(2);
    const preparation = await subject.workflow.prepareInformation({
      selection: { subjectIds: subject.accepted.map((item) => item.entity.id) },
      requirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.description", necessity: "required" }],
        relationshipTypes: [
          { type: "asset.contribution", necessity: "required" },
        ],
        artifactRoles: [],
      },
    });
    expect(preparation.subjects).toHaveLength(2);
    for (const item of preparation.subjects) {
      expect(item.inputs.map((input) => input.readiness)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "metadata",
            coordinate: "asset.description",
            necessity: "required",
            status: "unavailable",
          }),
          expect.objectContaining({
            kind: "relationship",
            coordinate: "asset.contribution",
            necessity: "required",
            status: "unavailable",
          }),
        ]),
      );
    }
    for (const item of subject.accepted)
      expect(item.metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: "asset.title" }),
        ]),
      );
    expect(
      subject.accepted.map((item) => ({
        assetId: item.entity.id,
        associationId: item.recognitionSourceAssociation!.id,
        decisionId: item.recognitionDecision.id,
      })),
    ).toEqual(initialIdentities);
  });

  it("does not reuse an explicit boundary whose required managed artifact disappeared", async () => {
    const availability = { available: true };
    const subject = refreshFixture({
      independentEvidence: true,
      managedCoverAvailability: availability,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const initialIdentities = subject.accepted.map((item) => ({
      assetId: item.entity.id,
      associationId: item.recognitionSourceAssociation!.id,
      decisionId: item.recognitionDecision.id,
    }));
    const before = await subject.workflow.prepareInformation({
      selection: { subjectIds: subject.accepted.map((item) => item.entity.id) },
      requirement: primaryCoverRequirement,
    });
    expect(before.subjects).toHaveLength(2);
    for (const item of before.subjects)
      expect(item.inputs.map((input) => input.readiness)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "artifact-role",
            coordinate: "asset.primary-cover",
            status: "available",
          }),
        ]),
      );
    availability.available = false;
    const repeated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(repeated.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePaths: ["track.flac"],
          outcome: "no-change",
        }),
        expect.objectContaining({
          relativePaths: ["other.flac"],
          outcome: "no-change",
        }),
      ]),
    );
    expect(subject.collectionCalls()).toBe(2);
    expect(subject.acquisitionCalls()).toBe(2);
    const after = await subject.workflow.prepareInformation({
      selection: { subjectIds: subject.accepted.map((item) => item.entity.id) },
      requirement: primaryCoverRequirement,
    });
    expect(after.subjects).toHaveLength(2);
    for (const item of after.subjects)
      expect(item.inputs.map((input) => input.readiness)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "artifact-role",
            coordinate: "asset.primary-cover",
            necessity: "required",
            status: "unavailable",
          }),
        ]),
      );
    expect(
      subject.accepted.map((item) => ({
        assetId: item.entity.id,
        associationId: item.recognitionSourceAssociation!.id,
        decisionId: item.recognitionDecision.id,
      })),
    ).toEqual(initialIdentities);
  });

  it("restores the persisted information requirement while resuming remaining work items", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      sharedCollectionScope: true,
    });
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: primaryCoverRequirement,
        onCheckpoint(execution) {
          if (
            execution.workItems?.some(
              (item) =>
                item.key === "first-boundary" && item.outcome === "accepted",
            )
          )
            throw new Error("interrupt after first boundary");
        },
      }),
    ).rejects.toThrow("interrupt after first boundary");
    const collectionsBeforeResume = subject.collectionCalls();

    const resumed = await subject.workflow.resume({
      executionId: subject.executions[0].id,
      acceptTrusted: true,
    });
    expect(resumed.execution.outcome).toBe("accepted");
    expect(subject.collectionCalls()).toBe(collectionsBeforeResume);
    expect(subject.acquisitionCalls()).toBe(2);
  });

  it("closes itemized recovery when its uncommitted batch has no applicable collector", async () => {
    const subject = refreshFixture({ independentEvidence: true });
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onCheckpoint(execution) {
          if (
            execution.workItems?.some(
              (item) =>
                item.key === "first-boundary" && item.outcome === "accepted",
            )
          )
            throw new Error("interrupt before the second itemized batch");
        },
      }),
    ).rejects.toThrow("interrupt before the second itemized batch");
    const executionId = subject.executions[0].id;
    const persisted = subject.persisted.get(executionId)!;
    subject.persisted.set(executionId, {
      ...persisted,
      execution: {
        ...persisted.execution,
        workItems: persisted.execution.workItems?.map((item) =>
          item.key === "second-boundary"
            ? {
                ...item,
                planningEvidence: item.planningEvidence.map((evidence) => ({
                  ...evidence,
                  sourceIdentity: "supplement",
                })),
              }
            : item,
        ),
      },
    });
    const collectionsBeforeResume = subject.collectionCalls();

    const resumed = await subject.workflow.resume({
      executionId,
      acceptTrusted: true,
    });

    expect(resumed.execution.workItems).toEqual([
      expect.objectContaining({ outcome: "accepted" }),
      expect.objectContaining({
        outcome: "failed",
        reason: "官方来源完整采集批次尚未提交，当前工作项不能安全继续",
      }),
    ]);
    expect(subject.collectionCalls()).toBe(collectionsBeforeResume);
  });

  it.each([false, true])(
    "freezes a durable-only itemized recovery plan before a collector changes applicability from %s",
    async (firstApplicable) => {
      const dynamic = {
        enabled: false,
        firstApplicable,
        canCollectCalls: 0,
        collectCalls: 0,
      };
      const subject = refreshFixture({
        independentEvidence: true,
        sharedCollectionScope: true,
        dynamicRecoveryCollectorState: dynamic,
      });
      await expect(
        refreshFixtureObservedScope(subject.workflow, {
          directory: "/observed/work",
          acceptTrusted: true,
          onCheckpoint(execution) {
            if (
              execution.workItems?.some(
                (item) =>
                  item.key === "first-boundary" && item.outcome === "accepted",
              )
            )
              throw new Error("interrupt before durable-only sibling");
          },
        }),
      ).rejects.toThrow("interrupt before durable-only sibling");
      dynamic.enabled = true;
      const collectionsBeforeResume = subject.collectionCalls();

      const resumed = await subject.workflow.resume({
        executionId: subject.executions[0].id,
        acceptTrusted: true,
      });

      expect(dynamic.canCollectCalls).toBe(1);
      expect(dynamic.collectCalls).toBe(0);
      expect(subject.collectionCalls()).toBe(collectionsBeforeResume);
      expect(
        resumed.execution.workItems?.find(
          (item) => item.key === "second-boundary",
        )?.sourceRecordIds,
      ).toEqual(["shared-recovery-record"]);
    },
  );

  it("closes durable-only recovery when another applicable collector is not shareable", async () => {
    const dynamic = {
      enabled: false,
      firstApplicable: true,
      nonShareable: true,
      canCollectCalls: 0,
      collectCalls: 0,
    };
    const subject = refreshFixture({
      independentEvidence: true,
      sharedCollectionScope: true,
      dynamicRecoveryCollectorState: dynamic,
    });
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onCheckpoint(execution) {
          if (
            execution.workItems?.some(
              (item) =>
                item.key === "first-boundary" && item.outcome === "accepted",
            )
          )
            throw new Error("interrupt before mixed durable recovery");
        },
      }),
    ).rejects.toThrow("interrupt before mixed durable recovery");
    dynamic.enabled = true;
    const collectionsBeforeResume = subject.collectionCalls();

    const resumed = await subject.workflow.resume({
      executionId: subject.executions[0].id,
      acceptTrusted: true,
    });

    expect(
      resumed.execution.workItems?.find(
        (item) => item.key === "second-boundary",
      ),
    ).toEqual(
      expect.objectContaining({
        outcome: "failed",
        reason: "官方来源完整采集批次尚未提交，当前工作项不能安全继续",
      }),
    );
    expect(dynamic.collectCalls).toBe(0);
    expect(subject.collectionCalls()).toBe(collectionsBeforeResume);
  });

  it("does not reuse an ordinary shared record from a plan where that collector is inapplicable", async () => {
    const dynamic = {
      enabled: true,
      firstApplicable: true,
      otherPlanApplicable: true,
      separateCapability: true,
      retainRecord: true,
      canCollectCalls: 0,
      collectCalls: 0,
    };
    const subject = refreshFixture({
      independentEvidence: true,
      sharedCollectionScope: true,
      dynamicRecoveryCollectorState: dynamic,
    });

    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(dynamic.collectCalls).toBe(1);
  });

  it.each([
    {
      stage: "itemized source records retained",
      acceptTrusted: true,
      requirement: undefined,
      reached: (execution: WorkflowExecution) =>
        execution.workItems?.some(
          (item) => (item.sourceRecordIds?.length ?? 0) > 0,
        ) === true,
    },
    {
      stage: "itemized proposal waiting",
      acceptTrusted: false,
      requirement: undefined,
      reached: (execution: WorkflowExecution) =>
        execution.workItems?.some((item) => item.outcome === "proposal") ===
        true,
    },
    {
      stage: "itemized artifact acquired",
      acceptTrusted: true,
      requirement: primaryCoverRequirement,
      reached: (execution: WorkflowExecution) =>
        execution.workItems?.some(
          (item) => (item.sourceArtifactAcquisitions?.length ?? 0) > 0,
        ) === true,
    },
    {
      stage: "itemized artifact stored",
      acceptTrusted: true,
      requirement: primaryCoverRequirement,
      reached: (execution: WorkflowExecution) =>
        execution.workItems?.some(
          (item) => (item.managedSourceArtifacts?.length ?? 0) > 0,
        ) === true,
    },
  ])(
    "propagates a Host interruption unchanged after $stage without recording business failure",
    async ({ stage, acceptTrusted, requirement, reached }) => {
      const subject = refreshFixture({ independentEvidence: true });
      const interruption = new Error(`stop after ${stage}`);

      await expect(
        scanFixtureObservedSelection(subject.workflow, {
          selection: {
            version: "asset-refresh-selection/1",
            subjects: [],
            filesystemScopes: [
              {
                root: "/observed/work",
                explanations: [{ path: ["checkpoint fault table"] }],
              },
            ],
          },
          acceptTrusted,
          ...(requirement === undefined
            ? {}
            : { informationRequirement: requirement }),
          onHostCheckpoint(execution) {
            if (reached(execution)) throw interruption;
          },
        }),
      ).rejects.toBe(interruption);

      const durable = subject.persisted.get(subject.executions[0].id);
      expect(durable?.execution.status).toBe("running");
      expect(durable?.execution.outcome).not.toBe("failed");
    },
  );

  it("acquires a shared source artifact once and associates it with its resolved Entity", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      sharedSourceArtifact: true,
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(subject.acquisitionCalls()).toBe(1);
    expect(subject.accepted).toHaveLength(2);
    expect(
      subject.accepted.flatMap((item) => item.artifactAssociations),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "asset.primary-cover",
          target: { kind: "entity", entityId: "shared-work" },
        }),
      ]),
    );
  });

  it("does not share a source artifact candidate across different serving subjects", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      sharedSourceArtifact: true,
      sharedCandidateWithDifferentServingSemantics: true,
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(subject.acquisitionCalls()).toBe(2);
    expect(subject.managedStoreCalls()).toBe(2);
  });

  it("treats an omitted candidate subject as each current accepted asset across work items", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      sharedImplicitSourceArtifact: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(subject.accepted).toHaveLength(2);
    expect(subject.acquisitionCalls()).toBe(2);
    const covers = subject.accepted.map((accepted) =>
      accepted.artifactAssociations.find(
        (association) => association.role === "asset.primary-cover",
      ),
    );
    expect(covers).toEqual([
      expect.objectContaining({
        target: {
          kind: "entity",
          entityId: subject.accepted[0].entity.id,
        },
      }),
      expect.objectContaining({
        target: {
          kind: "entity",
          entityId: subject.accepted[1].entity.id,
        },
      }),
    ]);
    expect(new Set(covers.map((cover) => cover?.id)).size).toBe(2);
  });

  it.each([
    ["sourceRecordId", "source-artifacts-acquired"],
    ["subjectId", "source-artifacts-acquired"],
    ["acquisitionReference", "source-artifacts-acquired"],
    ["normalized media type", "source-artifacts-acquired"],
    ["sourceRecordId", "source-artifacts-stored"],
    ["subjectId", "source-artifacts-stored"],
    ["acquisitionReference", "source-artifacts-stored"],
    ["normalized media type", "source-artifacts-stored"],
  ] as const)(
    "旧检查点缺少 %s 时在 %s 修复缺失坐标并复用仍有效的已获取内容",
    async (coordinate, stage) => {
      const subject = refreshFixture();
      const interruption = new Error("在来源产物耐久窗口中断");
      const executionId = `legacy-${stage}`;
      const reached = (execution: WorkflowExecution) =>
        execution.workItems?.some((item) =>
          stage === "source-artifacts-acquired"
            ? (item.sourceArtifactAcquisitions?.length ?? 0) > 0
            : (item.managedSourceArtifacts?.length ?? 0) > 0,
        ) === true;
      await expect(
        refreshFixtureObservedScope(subject.workflow, {
          directory: "/observed/work",
          executionId,
          acceptTrusted: true,
          informationRequirement: primaryCoverRequirement,
          onHostCheckpoint(execution) {
            if (reached(execution)) throw interruption;
          },
        }),
      ).rejects.toBe(interruption);
      const inspection = subject.persisted.get(executionId);
      expect(inspection !== undefined && reached(inspection.execution)).toBe(
        true,
      );
      const execution = inspection!.execution;
      const legacyAcquisition = (
        checkpoint: NonNullable<
          NonNullable<
            WorkflowExecution["workItems"]
          >[number]["sourceArtifactAcquisitions"]
        >[number],
      ) => {
        if (coordinate === "sourceRecordId") {
          const { sourceRecordId: _ignored, ...legacy } = checkpoint;
          return legacy;
        }
        if (coordinate === "subjectId") {
          const { subjectId: _ignored, ...legacy } = checkpoint;
          return legacy;
        }
        if (coordinate === "acquisitionReference") {
          const { acquisitionReference: _ignored, ...legacy } = checkpoint;
          return legacy;
        }
        return { ...checkpoint, mediaType: "image/png" };
      };
      const legacyManaged = (
        checkpoint: NonNullable<
          NonNullable<
            WorkflowExecution["workItems"]
          >[number]["managedSourceArtifacts"]
        >[number],
      ) => {
        if (coordinate === "sourceRecordId") {
          const { sourceRecordId: _ignored, ...legacy } = checkpoint;
          return legacy;
        }
        if (coordinate === "subjectId") {
          const { subjectId: _ignored, ...legacy } = checkpoint;
          return legacy;
        }
        if (coordinate === "acquisitionReference") {
          const { acquisitionReference: _ignored, ...legacy } = checkpoint;
          return legacy;
        }
        return {
          ...checkpoint,
          blob: { ...checkpoint.blob, mediaType: "image/png" },
        };
      };
      subject.persisted.set(executionId, {
        ...inspection!,
        execution: {
          ...execution,
          workItems: execution.workItems?.map((item) =>
            stage === "source-artifacts-acquired"
              ? {
                  ...item,
                  sourceArtifactAcquisitions:
                    item.sourceArtifactAcquisitions?.map(legacyAcquisition),
                }
              : {
                  ...item,
                  managedSourceArtifacts:
                    item.managedSourceArtifacts?.map(legacyManaged),
                },
          ),
        },
      });

      const resumed = await subject.workflow.resume({
        executionId,
        acceptTrusted: true,
      });
      expect(resumed.execution.outcome).toBe("accepted");
      // 托管记录失效时仍保留合法获取记录，只重存；获取记录失效时才重新获取。
      expect(subject.acquisitionCalls()).toBe(
        stage === "source-artifacts-acquired" ? 2 : 1,
      );
      expect(subject.managedStoreCalls()).toBe(
        stage === "source-artifacts-acquired" ? 1 : 2,
      );
      expect(subject.accepted).toHaveLength(1);
      expect(subject.accepted[0].artifactAssociations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "asset.primary-cover" }),
        ]),
      );
    },
  );

  it("rejects one source-record candidate id with conflicting acquisition semantics instead of reusing it", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      sharedSourceArtifact: true,
      sharedCandidateWithConflictingAcquisition: true,
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "first-boundary",
          outcome: "accepted",
        }),
        expect.objectContaining({
          key: "second-boundary",
          outcome: "failed",
          reason:
            "Source Artifact Candidate has contradictory acquisition semantics",
        }),
      ]),
    );
    expect(subject.acquisitionCalls()).toBe(1);
    expect(subject.managedStoreCalls()).toBe(1);
  });

  it("sanitizes nested resumable checkpoints from public itemized inspection", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      sharedSourceArtifact: true,
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    const publicItems = JSON.stringify(result.execution.workItems);
    expect(publicItems).not.toContain("stagedReference");
    expect(publicItems).not.toContain("managedSourceArtifacts");
    expect(publicItems).not.toContain("sourceArtifactAcquisitions");
    expect(publicItems).not.toContain("/managed/");
    expect(publicItems).not.toContain("mediaType");
  });

  it("rejects an explicit recognition work item without an observed boundary", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      emptyWorkItemBoundary: true,
    });

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      }),
    ).rejects.toThrow(
      "Recognition work item must select a non-empty observed boundary",
    );
    expect(subject.accepted).toEqual([]);
  });

  it("does not let the legacy selection key bypass explicit empty-boundary validation", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      explicitSelectionKeyWithEmptyBoundary: true,
    });
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      }),
    ).rejects.toThrow(
      "Recognition work item must select a non-empty observed boundary",
    );
  });

  it("rejects duplicate explicit work-item keys", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      duplicateWorkItemKey: true,
    });
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      }),
    ).rejects.toThrow(
      "Recognition work-item keys must be non-empty and unique",
    );
  });

  it("rejects duplicate paths within one explicit work-item boundary", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      duplicateWorkItemPath: true,
    });
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      }),
    ).rejects.toThrow(
      "Recognition work item boundary contains duplicate paths",
    );
  });

  it("keeps overlapping recognition boundaries emitted by different interpreters unresolved instead of throwing", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      overlappingInterpreter: true,
    });
    // 重叠范围现在按每个候选计划落为 boundaryConflict 未处置项，不再整体抛出：
    // 见生产 index.ts:7272（标记 boundaryConflict）与 index.ts:17897-17901（逐计划处置）。
    const conflictReason = "多个候选资产范围包含相同材料，需要明确决定";
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "first-boundary",
          outcome: "unresolved",
          reason: conflictReason,
        }),
        expect.objectContaining({
          key: "overlapping-boundary",
          outcome: "unresolved",
          reason: conflictReason,
        }),
      ]),
    );
    // 非重叠的 other.flac 身份仍被独立接受并只落一份资产。
    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "second-boundary",
          outcome: "accepted",
        }),
      ]),
    );
    expect(subject.accepted).toHaveLength(1);
  });

  it("keeps competing identities for one boundary unresolved instead of treating them as sibling work items", async () => {
    const subject = refreshFixture({ competingProposals: true });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("unresolved");
    expect(subject.accepted).toEqual([]);
  });

  it.each([
    {
      scope: "root",
      ambiguousSourceAddresses: [
        "https://source.example/work",
        "https://source.example/other-work",
        "https://source.example/third-work",
      ],
      outcomes: ["unresolved", "unresolved", "unresolved"],
      acceptedCount: 0,
    },
    {
      scope: "season",
      ambiguousSourceAddresses: [
        "https://source.example/other-work",
        "https://source.example/third-work",
      ],
      outcomes: ["accepted", "unresolved", "unresolved"],
      acceptedCount: 1,
    },
    {
      scope: "episode",
      ambiguousSourceAddresses: ["https://source.example/third-work"],
      outcomes: ["accepted", "accepted", "unresolved"],
      acceptedCount: 2,
    },
  ] as const)(
    "isolates provider-declared $scope ambiguity to only its dependent neutral work-item range",
    async ({ ambiguousSourceAddresses, outcomes, acceptedCount }) => {
      const subject = refreshFixture({
        independentEvidence: true,
        thirdIndependentBoundary: true,
        ambiguousSourceAddresses,
      });

      const result = await refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      });

      expect(result.execution.workItems?.map((item) => item.outcome)).toEqual(
        outcomes,
      );
      expect(subject.accepted).toHaveLength(acceptedCount);
    },
  );

  it("lists durable inspections for delivery without exposing persistence details", async () => {
    const subject = refreshFixture();
    const completed = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    await expect(subject.workflow.listInspections()).resolves.toEqual([
      expect.objectContaining({
        execution: expect.objectContaining({ id: completed.execution.id }),
      }),
    ]);
  });

  it("projects a bounded authoritative Current Catalogue page for Delivery", async () => {
    const subject = refreshFixture();
    const completed = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    const page = await subject.workflow.listCurrentCataloguePage({ limit: 1 });
    // Delivery 投影改用 readEffectiveSubject 的扁平主体：作品身份直接落在 item.id
    // 而不再是 item.entity.id；见生产 listCurrentCataloguePage index.ts:19627-19643。
    expect(page).toMatchObject({
      items: [
        {
          id: completed.accepted?.entity.id,
          recognitionSourceAssociation: { sourceIdentity: "source" },
        },
      ],
    });
    expect(page.items[0]).not.toHaveProperty("recognitionDecision");
    expect(page.items[0]).not.toHaveProperty("entity");
  });

  it("keeps bounded Workflow History and Current Attention as separate Delivery queries", async () => {
    const subject = refreshFixture();
    const completed = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    await expect(
      subject.workflow.listWorkflowHistoryPage({ limit: 1 }),
    ).resolves.toMatchObject({
      items: [
        {
          execution: { id: completed.execution.id },
        },
      ],
    });
    await expect(
      subject.workflow.listCurrentAttentionPage({ limit: 1 }),
    ).resolves.toEqual({ items: [] });
    await expect(
      subject.workflow.listWorkflowHistoryPage({ limit: 0 }),
    ).rejects.toThrow("Workflow History page limit must be between 1 and 100");
    await expect(
      subject.workflow.listCurrentAttentionPage({ limit: 101 }),
    ).rejects.toThrow("Current Attention page limit must be between 1 and 100");
  });

  it("conditionally submits independent Digital Asset facts with association-owned roles", async () => {
    const subject = refreshFixture({ directedFilesystemPackage: true });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(subject.accepted).toHaveLength(1);
    expect(subject.accepted[0]).toMatchObject({
      entity: { kind: "digital-asset" },
      recognitionSourceAssociation: { sourceIdentity: "source" },
      recognitionDecision: { proposalId: "proposal" },
      blobs: [{ digest: sha256(jpeg) }],
    });
    expect(subject.accepted[0]?.artifacts).toHaveLength(2);
    expect(subject.accepted[0]?.artifactAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "asset.material-delivered" }),
        expect.objectContaining({ role: "asset.primary-cover" }),
      ]),
    );
    expect(subject.accepted[0]?.artifactRevisions).toHaveLength(1);
  });

  it("keeps observed delivery separate from only the explicitly requested source artifact", async () => {
    const subject = refreshFixture({ includeListedAttachmentCandidate: true });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("accepted");
    const accepted = subject.accepted[0];
    expect(accepted.artifacts).toHaveLength(2);
    const observed = accepted.locations.find(
      (location) => location.kind === "observed",
    )!;
    const managed = accepted.locations.find(
      (location) => location.kind === "managed",
    )!;
    expect(
      accepted.artifactAssociations.find(
        (association) => association.artifactId === observed.artifactId,
      ),
    ).toMatchObject({ role: "asset.material-delivered" });
    expect(
      accepted.artifactAssociations.find(
        (association) => association.artifactId === managed.artifactId,
      ),
    ).toMatchObject({
      role: "asset.primary-cover",
      sourceRecordIds: ["record"],
    });
    expect(
      accepted.artifactAssociations.some(
        (association) => association.role === "fanbox.attachment.file",
      ),
    ).toBe(false);
  });

  it("projects only generic candidate selection evidence from current source lineage", async () => {
    const subject = refreshFixture({
      publicCandidateSelectionEvidence: {
        suggestedFilename: "official.zip",
        sourceOrdinal: 0,
        providerDiagnostic: "provider-only-note",
      },
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.accepted?.sourceArtifactCandidates).toEqual([
      {
        sourceRecordId: "record",
        role: "fanbox.attachment.file",
        mediaType: "application/octet-stream",
        selectionEvidence: {
          suggestedFilename: "official.zip",
          sourceOrdinal: 0,
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("providerDiagnostic");
    expect(JSON.stringify(result)).not.toContain("opaque-provider-reference");
  });

  it("keeps observer-proven file aliases as two Locations of one Artifact", async () => {
    const identity = {
      version: "filesystem-object-identity/2" as const,
      kind: "snapshot-local" as const,
      value: "same-file",
    };
    const subject = refreshFixture({
      objectIdentityContract: { kind: "snapshot-local" },
      observedFiles: [
        { relativePath: "original.flac", size: 12, objectIdentity: identity },
        { relativePath: "alias.flac", size: 12, objectIdentity: identity },
      ],
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("accepted");
    const accepted = subject.accepted[0];
    expect(accepted.artifacts).toHaveLength(1);
    expect(accepted.artifactAssociations).toHaveLength(1);
    expect(accepted.locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: accepted.artifacts[0]?.id,
          address: "/observed/work/original.flac",
          kind: "observed",
        }),
        expect.objectContaining({
          artifactId: accepted.artifacts[0]?.id,
          address: "/observed/work/alias.flac",
          kind: "observed",
        }),
      ]),
    );
  });

  it("ignores snapshot-local object tokens when comparing an unchanged recognition boundary", async () => {
    const observedFile = {
      relativePath: "book.epub",
      size: 12,
      objectIdentity: {
        version: "filesystem-object-identity/2" as const,
        kind: "snapshot-local" as const,
        value: "first-observation-token",
      },
    };
    const subject = refreshFixture({
      objectIdentityContract: { kind: "snapshot-local" },
      observedFiles: [observedFile],
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    observedFile.objectIdentity.value = "second-observation-token";

    const repeated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(repeated.execution.outcome).toBe("no-change");
    expect(subject.accepted).toHaveLength(1);
  });

  it("fails closed when exact observed Artifact evidence names multiple current Assets", async () => {
    const durableCapability = {
      capabilityId: "test.durable-object-identity",
      capabilityVersion: "1",
      contractVersion: "1",
    } as const;
    const subject = refreshFixture({
      objectIdentityContract: {
        kind: "durable",
        capability: durableCapability,
      },
      observedFiles: [
        {
          relativePath: "track.flac",
          size: 12,
          objectIdentity: {
            version: "filesystem-object-identity/2",
            kind: "durable",
            capability: durableCapability,
            value: "contradictory-file",
          },
        },
      ],
      observedArtifactReuseMatch: {
        status: "ambiguous",
        assetIds: ["asset-a", "asset-b"],
      },
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    // 执行层不再承载具体原因（单个未处置工作项不聚合出原因），
    // 可靠文件身份歧义的具体原因落在该工作项上：见生产 index.ts:18717-18733。
    expect(result.execution).toMatchObject({
      outcome: "unresolved",
    });
    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "unresolved",
          reason: "可靠文件身份对应多个当前作品，无法安全重用",
        }),
      ]),
    );
    expect(subject.persisted.get(result.execution.id)?.proposal).toBeDefined();
    expect(subject.accepted).toEqual([]);
  });

  it("fails one explicit work item closed when its exact observed Artifact evidence is ambiguous", async () => {
    const durableCapability = {
      capabilityId: "test.durable-object-identity",
      capabilityVersion: "1",
      contractVersion: "1",
    } as const;
    const subject = refreshFixture({
      independentEvidence: true,
      singletonExplicit: true,
      objectIdentityContract: {
        kind: "durable",
        capability: durableCapability,
      },
      observedFiles: [
        {
          relativePath: "track.flac",
          size: 12,
          objectIdentity: {
            version: "filesystem-object-identity/2",
            kind: "durable",
            capability: durableCapability,
            value: "contradictory-file",
          },
        },
      ],
      observedArtifactReuseMatch: {
        status: "ambiguous",
        assetIds: ["asset-a", "asset-b"],
      },
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.workItems).toEqual([
      expect.objectContaining({
        key: "first-boundary",
        outcome: "unresolved",
        reason: "可靠文件身份对应多个当前作品，无法安全重用",
      }),
    ]);
    expect(subject.persisted.get(result.execution.id)?.proposal).toBeDefined();
    expect(subject.accepted).toEqual([]);
  });

  it("retains successful Source Records yet creates no proposal when a required endpoint fails", async () => {
    const subject = refreshFixture({ collectionFailsAfterOneRecord: true });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution).toMatchObject({
      outcome: "failed",
      sourceRecordIds: ["record"],
    });
    expect(result.proposal).toBeUndefined();
    expect(subject.retained).toEqual(["record"]);
    expect(subject.accepted).toEqual([]);
  });

  it("accepts identity from retained records when only unrequested protected information is unavailable", async () => {
    const subject = refreshFixture({
      collectionUnavailableForUnrequestedMetadata: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(result.sourceRecords).toHaveLength(1);
    expect(subject.accepted).toHaveLength(1);
    expect(subject.accepted[0]?.artifactAssociations).toEqual([
      expect.objectContaining({ role: "asset.material-delivered" }),
    ]);
  });

  it("在明确请求缺失资料时保留采集器的安全诊断及来源失败码", async () => {
    const subject = refreshFixture({
      collectionUnavailableForUnrequestedMetadata: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [
          { property: "source.protected-body", necessity: "required" },
        ],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });

    expect(result.execution.outcome).toBe("failed");
    expect(subject.accepted).toEqual([]);

    // ADR-0086 后诊断挂在逐工作项处置 work-item:${plan.key}（普通目录扫描即 selection），
    // 不再是前置的 official-collection 处置：见生产 index.ts:18563-18585。
    expect(
      result.execution.dispositions.find(
        (disposition) => disposition.key === "work-item:selection",
      )?.reason,
    ).toContain("protected detail unavailable");
    expect(
      result.execution.dispositions.find(
        (disposition) => disposition.key === "work-item:selection",
      )?.sourceFailureCodes,
    ).toEqual([
      {
        capability: {
          capabilityId: "collector",
          capabilityVersion: "1",
          contractVersion: "1",
          identity: "collector",
          implementationVersion: "1",
          kind: "source-collector",
          interpretationContractVersions: ["1"],
        },
        code: "detail-contract",
      },
    ]);
  });

  it.each(["incomplete", "extra"] as const)(
    "omits structured codes for a %s fresh failure capability coordinate",
    async (collectionFailureCapabilityShape) => {
      const subject = refreshFixture({
        collectionUnavailableForUnrequestedMetadata: true,
        collectionFailureCapabilityShape,
      });

      const result = await refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      });

      expect(result.execution.outcome).toBe("accepted");
      // 诊断挂在 work-item:selection，用真键确认畸形坐标确实被省略结构化码，
      // 而不是靠 official-collection 前置键的空命中蒙混过关。
      expect(
        result.execution.dispositions.find(
          (item) => item.key === "work-item:selection",
        )?.sourceFailureCodes,
      ).toBeUndefined();
      expect(JSON.stringify([...subject.persisted.values()])).not.toContain(
        "private capability material must not persist",
      );
    },
  );

  it("rejects a collection failure attributed to an adjacent capability", async () => {
    const subject = refreshFixture({
      collectionFailsAfterOneRecord: true,
      collectionFailureProducerSpoof: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    // 越权护栏仍在（生产 index.ts:4632/4775 抛出），具体原因落在失败工作项上，
    // 执行层只保留聚合原因（index.ts:7372-7398）。
    expect(result.execution).toMatchObject({
      outcome: "failed",
      reason: "1 个工作项未完成；其余工作项已独立保留结果",
    });
    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "failed",
          reason: expect.stringContaining(
            "Source Collection Failure producer does not match the executing capability",
          ),
        }),
      ]),
    );
    expect(result.sourceRecords).toEqual([]);
  });

  it("blocks the same partial collection when the unavailable property is required", async () => {
    const subject = refreshFixture({
      collectionUnavailableForUnrequestedMetadata: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [
          { property: "source.protected-body", necessity: "required" },
        ],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });

    expect(result.execution.outcome).toBe("failed");
    expect(subject.accepted).toEqual([]);
  });

  it("matches an unavailable open artifact-role namespace against a concrete requirement", async () => {
    const subject = refreshFixture({
      collectionUnavailableForUnrequestedMetadata: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        artifactRoles: [
          { role: "fanbox.attachment.file", necessity: "required" },
        ],
        relationshipTypes: [],
      },
    });

    expect(result.execution.outcome).toBe("failed");
    expect(subject.accepted).toEqual([]);
  });

  it.each([
    {
      label: "metadata property",
      requirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [
          { property: "asset.missing", necessity: "required" as const },
        ],
        artifactRoles: [],
        relationshipTypes: [],
      },
    },
    {
      label: "relationship type",
      requirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        artifactRoles: [],
        relationshipTypes: [
          { type: "asset.membership", necessity: "required" as const },
        ],
      },
    },
  ])(
    "does not accept when a required $label is absent",
    async ({ requirement }) => {
      const subject = refreshFixture();

      const result = await refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: requirement,
      });

      expect(result.execution.outcome).toBe("failed");
      expect(subject.accepted).toEqual([]);
    },
  );

  it("does not submit a recognition when the required primary cover fails", async () => {
    const subject = refreshFixture({ coverFails: true });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution).toMatchObject({
      outcome: "failed",
      sourceRecordIds: ["record"],
    });
    expect(subject.accepted).toEqual([]);
  });

  it("accepts trusted recognition when an optional primary cover cannot be acquired", async () => {
    const subject = refreshFixture({ coverFails: true });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: optionalPrimaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(result.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          // 逐工作项获取处置现在带 work-item:${plan.key}: 前缀：见生产 index.ts:18967-18972。
          key: "work-item:selection:source-artifact.acquire:asset.primary-cover",
          status: "failed",
          reason: "可选来源产物获取失败；识别仍可继续",
        }),
      ]),
    );
    expect(subject.accepted).toHaveLength(1);
    expect(
      subject.accepted[0].artifactAssociations.some(
        (association) => association.role === "asset.primary-cover",
      ),
    ).toBe(false);
  });

  it.each([
    {
      label: "Host checkpoint interruption",
      options: {},
      expected: "reject",
    },
    {
      label: "acquirer coordinate persistence failure",
      options: { transitionFailsWhenAcquirerFrozen: true },
      expected: "failed",
    },
    {
      label: "managed store failure",
      options: { managedStoreFails: true },
      expected: "failed",
    },
  ])(
    "does not rewrite $label as optional source-artifact absence",
    async ({ options, expected }) => {
      const interruption = new Error("host stopped after acquisition");
      const subject = refreshFixture(options);
      const operation = refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: optionalPrimaryCoverRequirement,
        ...(expected !== "reject"
          ? {}
          : {
              // 工作项获取循环里的耐久检查点只通知宿主接缝（notifyDurableCheckpoint
              // 传入 notifyCaller=false），故抛错钩子必须挂在 onHostCheckpoint：
              // 见生产 index.ts:18987/19000 与 workflow-invocation-lifecycle.ts:21-24。
              onHostCheckpoint(execution) {
                if (
                  execution.workItems?.some(
                    (item) =>
                      (item.sourceArtifactAcquisitions?.length ?? 0) > 0,
                  )
                )
                  throw interruption;
              },
            }),
      });

      if (expected === "reject")
        await expect(operation).rejects.toBe(interruption);
      else
        await expect(operation).resolves.toMatchObject({
          execution: { outcome: "failed" },
        });
      expect(subject.accepted).toEqual([]);
    },
  );

  it.each([
    {
      label: "one required success and one optional failure",
      requirement: {
        ...primaryCoverRequirement,
        artifactRoles: [
          { role: "asset.primary-cover", necessity: "required" as const },
          { role: "fanbox.attachment.file", necessity: "optional" as const },
        ],
      },
    },
    {
      label: "one optional success and one optional failure",
      requirement: {
        ...primaryCoverRequirement,
        artifactRoles: [
          { role: "asset.primary-cover", necessity: "optional" as const },
          { role: "fanbox.attachment.file", necessity: "optional" as const },
        ],
      },
    },
  ])("accepts $label independently", async ({ requirement }) => {
    const subject = refreshFixture({
      includeListedAttachmentCandidate: true,
      acquisitionFailsForRoles: new Set(["fanbox.attachment.file"]),
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: requirement,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(subject.accepted[0].artifactAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "asset.primary-cover" }),
      ]),
    );
    expect(
      subject.accepted[0].artifactAssociations.some(
        (item) => item.role === "fanbox.attachment.file",
      ),
    ).toBe(false);
  });

  it("continues recognition acceptance from the latest strict-CAS optional-failure checkpoint", async () => {
    const subject = refreshFixture({
      includeListedAttachmentCandidate: true,
      acquisitionFailsForCandidateIds: new Set(["listed-attachment-candidate"]),
      strictExecutionCas: true,
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        ...primaryCoverRequirement,
        artifactRoles: [
          { role: "asset.primary-cover", necessity: "required", maximum: 1 },
          {
            role: "fanbox.attachment.file",
            necessity: "optional",
            maximum: 1,
          },
        ],
      },
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(result.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          // 逐工作项获取处置键带 work-item:${plan.key}: 前缀（生产 index.ts:18967-18972）。
          key: "work-item:selection:source-artifact.acquire:fanbox.attachment.file",
          status: "failed",
        }),
      ]),
    );
    expect(subject.accepted).toHaveLength(1);
  });

  it("audits two optional candidates of one role without contradicting their different outcomes", async () => {
    const subject = refreshFixture({
      includeSecondCoverCandidate: true,
      acquisitionFailsForCandidateIds: new Set(["second-cover-candidate"]),
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        ...primaryCoverRequirement,
        artifactRoles: [
          { role: "asset.primary-cover", necessity: "optional", maximum: 2 },
        ],
      },
    });

    expect(result.execution.outcome).toBe("accepted");
    // 工作项路径只对“未完成的可选获取”落一条失败处置；成功的可选获取不再落 completed
    // 获取处置（生产 index.ts:18967-18972：仅 status === "optional-failed" 记处置）。
    // 审计价值仍由「恰好一条 :2 失败处置 + 恰好一份封面被接受」共同承载，两者不矛盾。
    expect(
      result.execution.dispositions
        .filter((item) =>
          /^work-item:selection:source-artifact\.acquire:asset\.primary-cover(?::\d)?$/.test(
            item.key,
          ),
        )
        .map(({ key, status }) => ({ key, status })),
    ).toEqual([
      {
        key: "work-item:selection:source-artifact.acquire:asset.primary-cover:2",
        status: "failed",
      },
    ]);
    expect(
      subject.accepted[0].artifactAssociations.filter(
        (item) => item.role === "asset.primary-cover",
      ),
    ).toHaveLength(1);
  });

  it("keeps one-role candidate audit distinct after resuming a stored success", async () => {
    const failure = { fails: false };
    const subject = refreshFixture({
      coverFailureState: failure,
      includeSecondCoverCandidate: true,
    });
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: {
          ...primaryCoverRequirement,
          artifactRoles: [
            {
              role: "asset.primary-cover",
              necessity: "optional",
              maximum: 2,
            },
          ],
        },
        onHostCheckpoint(execution) {
          if (
            !execution.workItems?.some(
              (item) => (item.managedSourceArtifacts?.length ?? 0) > 0,
            )
          )
            return;
          executionId = execution.id;
          throw new Error("stop after first same-role candidate");
        },
      }),
    ).rejects.toThrow("stop after first same-role candidate");
    failure.fails = true;

    const resumed = await subject.workflow.resume({ executionId });

    expect(resumed.execution.outcome).toBe("accepted");
    expect(
      resumed.execution.dispositions
        .filter((item) =>
          /^work-item:selection:source-artifact\.acquire:asset\.primary-cover(?::\d)?$/.test(
            item.key,
          ),
        )
        .map(({ key, status }) => ({ key, status })),
    ).toEqual([
      {
        key: "work-item:selection:source-artifact.acquire:asset.primary-cover:2",
        status: "failed",
      },
    ]);
    expect(
      subject.accepted[0].artifactAssociations.filter(
        (item) => item.role === "asset.primary-cover",
      ),
    ).toHaveLength(1);
    expect(subject.acquisitionCalls()).toBe(2);
    expect(subject.managedStoreCalls()).toBe(1);
  });

  it("resumes the preallocated subject after optional failure is durably interrupted", async () => {
    const interruption = new Error("stop after optional absence checkpoint");
    const subject = refreshFixture({ coverFails: true });
    let executionId = "";
    let plannedAssetId: string | undefined;
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: optionalPrimaryCoverRequirement,
        onHostCheckpoint(execution) {
          if (
            !execution.dispositions.some(
              (item) =>
                item.key ===
                  "work-item:selection:source-artifact.acquire:asset.primary-cover" &&
                item.status === "failed",
            )
          )
            return;
          executionId = execution.id;
          plannedAssetId = execution.workItems?.find(
            (item) => item.key === "selection",
          )?.plannedAssetId;
          throw interruption;
        },
      }),
    ).rejects.toBe(interruption);
    expect(plannedAssetId).toEqual(expect.any(String));

    const resumed = await subject.workflow.resume({ executionId });

    expect(resumed.execution.outcome).toBe("accepted");
    expect(subject.accepted).toHaveLength(1);
    expect(subject.accepted[0].entity.id).toBe(plannedAssetId);
  });

  it.each([
    { necessity: "optional" as const, outcome: "accepted" },
    { necessity: "required" as const, outcome: "failed" },
  ])(
    "preserves a stored success while applying $necessity acquisition failure policy after resume",
    async ({ necessity, outcome }) => {
      const failure = { fails: false };
      const subject = refreshFixture({
        coverFailureState: failure,
        includeListedAttachmentCandidate: true,
      });
      let executionId = "";
      await expect(
        refreshFixtureObservedScope(subject.workflow, {
          directory: "/observed/work",
          acceptTrusted: true,
          informationRequirement: {
            ...primaryCoverRequirement,
            artifactRoles: [
              {
                role: "asset.primary-cover",
                necessity: "required",
                maximum: 1,
              },
              { role: "fanbox.attachment.file", necessity, maximum: 1 },
            ],
          },
          onHostCheckpoint(execution) {
            if (
              execution.workItems?.some(
                (item) => (item.managedSourceArtifacts?.length ?? 0) > 0,
              )
            ) {
              executionId = execution.id;
              throw new Error("stop after storing the first source artifact");
            }
          },
        }),
      ).rejects.toThrow("stop after storing the first source artifact");
      failure.fails = true;

      const resumed = await subject.workflow.resume({ executionId });
      expect(resumed).toMatchObject({
        execution: { outcome },
      });
      expect(subject.acquisitionCalls()).toBe(2);
      if (necessity === "optional") {
        expect(subject.accepted[0].artifactAssociations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: "asset.primary-cover" }),
          ]),
        );
        expect(
          subject.accepted[0].artifactAssociations.some(
            (item) => item.role === "fanbox.attachment.file",
          ),
        ).toBe(false);
      } else expect(subject.accepted).toEqual([]);
    },
  );

  it("accepts explicit work items independently when their optional covers cannot be acquired", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      coverFails: true,
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: optionalPrimaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("accepted");
    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "first-boundary", outcome: "accepted" }),
        expect.objectContaining({
          key: "second-boundary",
          outcome: "accepted",
        }),
      ]),
    );
    expect(
      result.execution.dispositions.filter((item) =>
        item.key.includes("source-artifact.acquire:asset.primary-cover"),
      ),
    ).toHaveLength(2);
    expect(subject.accepted).toHaveLength(2);
    expect(
      subject.accepted
        .flatMap((item) => item.artifactAssociations)
        .some((association) => association.role === "asset.primary-cover"),
    ).toBe(false);
  });

  it("fails explicit work items when the same unavailable cover is required", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      coverFails: true,
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(subject.accepted).toEqual([]);
  });

  it("retries a later refresh after a cover failure without retaining duplicate cover facts", async () => {
    const cover = { fails: true };
    const subject = refreshFixture({ coverFailureState: cover });
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: primaryCoverRequirement,
      }),
    ).resolves.toMatchObject({ execution: { outcome: "failed" } });

    cover.fails = false;
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: primaryCoverRequirement,
      }),
    ).resolves.toMatchObject({ execution: { outcome: "accepted" } });

    expect(subject.acquisitionCalls()).toBe(2);
    expect(subject.accepted).toHaveLength(1);
    expect(
      subject.accepted[0].artifactAssociations.filter(
        (association) => association.role === "asset.primary-cover",
      ),
    ).toHaveLength(1);
  });

  it("rejects the complete interpretation before any cover effect when one candidate lacks provenance", async () => {
    const subject = refreshFixture({ invalidMetadataProvenance: true });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    expect(result.execution.outcome).toBe("failed");
    expect(subject.accepted).toEqual([]);
  });

  it("records a failed execution when conditional catalogue acceptance rejects the batch", async () => {
    const subject = refreshFixture({ catalogueFails: true });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });

    expect(result.execution.outcome).toBe("failed");
    expect(subject.acquisitionCalls()).toBe(1);
    expect(subject.managedStoreCalls()).toBe(1);
    expect(subject.accepted).toEqual([]);
  });

  it("reuses a legacy files-only persisted snapshot without treating absent directory observations as empty structure", async () => {
    const subject = refreshFixture();
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const prior = subject.persisted.get(initial.execution.id)!;
    const { directories: _directories, ...filesOnly } =
      prior.execution.snapshot!;
    subject.persisted.set(initial.execution.id, {
      ...prior,
      execution: { ...prior.execution, snapshot: filesOnly },
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(result.execution).toMatchObject({
      outcome: "no-change",
      workItems: [
        expect.objectContaining({
          acceptedAssetId: initial.accepted!.entity.id,
          outcome: "no-change",
        }),
      ],
    });
    expect(subject.collectionCalls()).toBe(1);
    expect(subject.accepted).toHaveLength(1);
  });

  it("does not call an unavailable managed cover a no-change result", async () => {
    const subject = refreshFixture({
      unavailableManagedCover: true,
    });
    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    expect(result.execution.outcome).toBe("accepted");
    expect(subject.collectionCalls()).toBe(1);
    const readiness = await subject.workflow.prepareInformation({
      selection: { subjectIds: [result.accepted!.entity.id] },
      requirement: primaryCoverRequirement,
    });
    expect(
      readiness.subjects[0]!.inputs.map((input) => input.readiness),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact-role",
          coordinate: "asset.primary-cover",
          status: "unavailable",
        }),
      ]),
    );
  });

  it("keeps owning entrypoints distinct and rejects selections from another operation", async () => {
    const subject = refreshFixture();
    const filesystemSelection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [],
      filesystemScopes: [
        {
          root: "/observed/work",
          explanations: [{ path: ["CLI", "observed work"] }],
        },
      ],
    };
    const scanned = await scanFixtureObservedSelection(subject.workflow, {
      selection: filesystemSelection,
      acceptTrusted: true,
    });
    expect(scanned.execution.operationKind).toBe("scan-filesystem");
    expect(scanned.execution.requestedSelection?.subjects).toEqual([]);
    expect(
      scanned.execution.requestedSelection?.filesystemScopes[0],
    ).toMatchObject({
      root: "/observed/work",
      observedRoot: { id: "fixture-root", configVersion: 1 },
      relativeScope: ".",
    });
    expect(scanned.execution.resolvedSelection?.subjects).toEqual([]);
    expect(
      scanned.execution.resolvedSelection?.filesystemScopes[0],
    ).toMatchObject({
      root: "/observed/work",
      observedRoot: { id: "fixture-root", configVersion: 1 },
      relativeScope: ".",
    });

    const subjectSelection = {
      version: "asset-refresh-selection/1" as const,
      subjects: [
        {
          subjectId: "asset",
          explanations: [{ path: ["Asset", "asset"] }],
        },
      ],
      filesystemScopes: [],
    };
    await expect(
      scanFixtureObservedSelection(subject.workflow, {
        selection: subjectSelection,
        acceptTrusted: true,
      }),
    ).rejects.toThrow("no subjects");
    await expect(
      scanFixtureObservedSelection(subject.workflow, {
        selection: {
          ...filesystemSelection,
          filesystemScopes: [
            ...filesystemSelection.filesystemScopes,
            {
              root: "/observed/other",
              explanations: [{ path: ["CLI", "other"] }],
            },
          ],
        },
        acceptTrusted: true,
      }),
    ).rejects.toThrow("exactly one filesystem scope");
    await expect(
      rescrapeFixtureObservedSelection(subject.workflow, {
        selection: filesystemSelection,
        sourceIdentity: "source",
        sourceAddress: "https://source.example/work",
      }),
    ).rejects.toThrow("one exact current subject");
    await expect(
      subject.workflow.refreshMetadata({
        selection: scanned.execution.requestedSelection!,
      }),
    ).rejects.toThrow("不接受文件位置范围");

    const currentAssetId = scanned.accepted!.entity.id;
    const rescraped = await rescrapeFixtureObservedSelection(subject.workflow, {
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: currentAssetId,
            explanations: [{ path: ["Asset", currentAssetId] }],
          },
        ],
        filesystemScopes: filesystemSelection.filesystemScopes,
      },
      sourceIdentity: "source",
      sourceAddress: "https://source.example/other-work",
    });
    expect(rescraped.execution).toMatchObject({
      operationKind: "rescrape",
      outcome: "proposal",
      requestedSelection: {
        subjects: [{ subjectId: currentAssetId }],
        filesystemScopes: [{ root: "/observed/work" }],
      },
    });
  });

  it("refreshes only the exact selected subject when accepted siblings share one directory", async () => {
    const subject = refreshFixture({ independentEvidence: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const episodeB = subject.accepted[1];
    const observerCallsBeforeRefresh = subject.observerCalls();

    const refreshed = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: episodeB.entity.id,
            explanations: [{ path: ["selected episode"] }],
          },
        ],
        filesystemScopes: [],
      },
    });

    expect(subject.observerCalls()).toBe(observerCallsBeforeRefresh);
    expect(refreshed.accepted?.entity.id).toBe(episodeB.entity.id);
    expect(
      refreshed.sourceRecords.map((record) => record.nativeAddress),
    ).toEqual(["https://source.example/other-work"]);
  });

  it("routes ordinary metadata refresh through a referenced Source Refresh Run", async () => {
    const subject = refreshFixture({ sourceRefreshAuthority: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const [accepted] = subject.accepted;

    const refreshed = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: accepted.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      initiatedBy: "user-1",
    });

    expect(refreshed.execution).toMatchObject({
      status: "completed",
      outcome: "accepted",
      sourceRefreshRunIds: [expect.any(String)],
    });
    expect(refreshed.sourceRefreshRuns).toMatchObject([
      {
        initiatedBy: "user-1",
        requestedSelection: {
          subjectId: accepted.entity.id,
          sourceAssociationId: accepted.recognitionSourceAssociation!.id,
        },
        phase: "terminal",
        outcome: "succeeded",
      },
    ]);
    expect(refreshed.execution.dispositions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("source-refresh:"),
        }),
      ]),
    );
    expect(
      subject.persisted.get(refreshed.execution.id)?.execution.workflowInput,
    ).toMatchObject({
      trigger: "interactive",
      initiatedBy: "user-1",
      acceptTrusted: false,
    });
  });

  it("keeps the in-memory Source Refresh failure command atomic across ownership, lease, and replay validation", async () => {
    const subject = refreshFixture({ sourceRefreshAuthority: true });
    const accepted = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const authority = subject.sourceRefreshRunPersistence!;
    const commands = subject.executionCommands;
    const coverage = {
      sourceIdentity: "source",
      nativeAddress: "opaque:asset",
      coverageId: "title",
    };
    const createAcquiring = async (
      executionId: string,
      runId: string,
      withSibling = false,
    ) => {
      const { outcome: _outcome, ...terminal } = accepted.execution;
      const execution: WorkflowExecution = {
        ...terminal,
        id: executionId,
        status: "running",
        stage: "recognition",
        dispositions: [],
        sourceRefreshRunIds: [],
      };
      await commands.createExecution(execution);
      await authority.createSourceRefreshRun({
        executionId,
        run: {
          id: runId,
          initiatedBy: "test",
          initiatedAt: "2026-08-01T00:00:00.000Z",
          requestedSelection: {
            subjectId: "atomic-subject",
            sourceAssociationId: "atomic-association",
            sourceIdentity: "source",
            nativeAddress: "opaque:asset",
            selectors: [],
          },
          reviewPolicy: "automatic",
          baselineLineageHeads: [
            { ...coverage, sourceRecordId: "atomic-baseline" },
            ...(withSibling
              ? [
                  {
                    ...coverage,
                    coverageId: "description",
                    sourceRecordId: "atomic-description-baseline",
                  },
                ]
              : []),
          ],
        },
      });
      await authority.beginSourceRefreshScopeAcquisition({ runId, coverage });
      if (withSibling)
        await authority.beginSourceRefreshScopeAcquisition({
          runId,
          coverage: { ...coverage, coverageId: "description" },
        });
      return (await commands.inspectExecution(executionId))!.execution;
    };
    const expected = await createAcquiring("atomic-owner", "atomic-run");
    const foreign = await createAcquiring("atomic-foreign", "foreign-run");
    const key = "source-refresh-failure:atomic-run:title:1";
    const codes = [
      {
        capability: {
          capabilityId: "collector",
          capabilityVersion: "1",
          contractVersion: "1",
          identity: "collector",
          implementationVersion: "1",
          kind: "source-collector",
          interpretationContractVersions: ["1"],
        },
        code: "transport-failure",
      },
    ];
    const input = {
      expectedExecution: expected,
      runId: "atomic-run",
      coverage,
      acquisitionAttempt: 1,
      outcome: "failed" as const,
      reason: "official collection failed",
      sourceFailureCodes: codes,
      idempotencyKey: key,
    };
    const before = await commands.inspectExecution(expected.id);
    await expect(
      commands.commitSourceRefreshCollectionFailure({
        ...input,
        sourceFailureCodes: [
          {
            capability: { ...codes[0].capability, identity: "   " },
            code: "transport-failure",
          },
        ],
      }),
    ).rejects.toThrow("codes are malformed");
    await expect(
      commands.commitSourceRefreshCollectionFailure({
        ...input,
        expectedExecution: foreign,
      }),
    ).rejects.toThrow("owner is invalid");
    await expect(
      commands.commitSourceRefreshCollectionFailure({
        ...input,
        acquisitionAttempt: 2,
      }),
    ).rejects.toThrow("key is invalid");
    await expect(
      commands.commitSourceRefreshCollectionFailure({
        ...input,
        resumeClaim: { token: "missing-owner", now: "2026-08-01T00:00:00Z" },
      }),
    ).rejects.toThrow("stale resume claim");
    await expect(commands.inspectExecution(expected.id)).resolves.toEqual(
      before,
    );
    const now = "2026-08-01T00:00:01.000Z";
    await commands.claimResumeExecution({
      executionId: expected.id,
      token: "atomic-owner-token",
      now,
      expiresAt: "2026-08-01T00:01:01.000Z",
    });
    const resumeClaim = { token: "atomic-owner-token", now };
    const committed = await commands.commitSourceRefreshCollectionFailure({
      ...input,
      resumeClaim,
    });
    await expect(
      commands.commitSourceRefreshCollectionFailure({
        ...input,
        resumeClaim,
      }),
    ).resolves.toEqual(committed);
    await expect(
      commands.commitSourceRefreshCollectionFailure({
        ...input,
        reason: "conflicting replay",
        resumeClaim,
      }),
    ).rejects.toThrow("replay conflicts");
    await commands.releaseResumeExecutionClaim({
      executionId: expected.id,
      token: resumeClaim.token,
    });
    await expect(
      commands.commitSourceRefreshCollectionFailure(input),
    ).resolves.toEqual(committed);
    await expect(
      commands.commitSourceRefreshCollectionFailure({
        ...input,
        reason: "conflicting unclaimed replay",
      }),
    ).rejects.toThrow("replay conflicts");
    await expect(
      commands.commitSourceRefreshCollectionFailure({
        ...input,
        resumeClaim: {
          token: resumeClaim.token,
          now: "2026-08-01T00:02:00.000Z",
        },
      }),
    ).rejects.toThrow("stale resume claim");

    const split = await createAcquiring("atomic-split", "split-run");
    const splitKey = "source-refresh-failure:split-run:title:1";
    await commands.transitionExecution(split, {
      ...split,
      dispositions: [
        {
          key: "source-refresh-failure:split-run:title:2",
          status: "failed",
          reason: "orphaned wrong-attempt half-state",
        },
      ],
    });
    const splitExpected = (await commands.inspectExecution(split.id))!
      .execution;
    const splitNow = "2026-08-01T00:00:02.000Z";
    await commands.claimResumeExecution({
      executionId: split.id,
      token: "split-token",
      now: splitNow,
      expiresAt: "2026-08-01T00:01:02.000Z",
    });
    const splitBefore = await commands.inspectExecution(split.id);
    await expect(
      commands.commitSourceRefreshCollectionFailure({
        ...input,
        expectedExecution: splitExpected,
        runId: "split-run",
        idempotencyKey: splitKey,
        resumeClaim: { token: "split-token", now: splitNow },
      }),
    ).rejects.toThrow("split state");
    await expect(commands.inspectExecution(split.id)).resolves.toEqual(
      splitBefore,
    );

    const siblingExpected = await createAcquiring(
      "atomic-siblings",
      "siblings-run",
      true,
    );
    const siblingCommitted =
      await commands.commitSourceRefreshCollectionFailure({
        ...input,
        expectedExecution: siblingExpected,
        runId: "siblings-run",
        coverage: { ...coverage, coverageId: "description" },
        idempotencyKey: "source-refresh-failure:siblings-run:description:1",
      });
    const targetInput = {
      ...input,
      expectedExecution: siblingCommitted.execution,
      runId: "siblings-run",
      idempotencyKey: "source-refresh-failure:siblings-run:title:1",
    };
    const targetCommitted =
      await commands.commitSourceRefreshCollectionFailure(targetInput);
    await expect(
      commands.commitSourceRefreshCollectionFailure(targetInput),
    ).resolves.toEqual(targetCommitted);
  });

  it("freezes only the application evidence, collector, and interpreter that actually participate in a Source Refresh Run", async () => {
    const subject = refreshFixture({
      sourceRefreshAuthority: true,
      unusedConfiguredCollector: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const [accepted] = subject.accepted;

    const refreshed = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: accepted.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
    });

    expect(
      subject.persisted.get(refreshed.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toEqual([
      "application.known-source-association@1/1",
      "collector@1/1",
      "interpreter@1/1",
    ]);
  });

  it("uses the same public Source Refresh Run path for review-gated metadata", async () => {
    const subject = refreshFixture({ sourceRefreshAuthority: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const [accepted] = subject.accepted;

    const awaitingReview = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: accepted.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    expect(awaitingReview.execution).toMatchObject({
      status: "running",
      stage: "source-records-retained",
      sourceRefreshRunIds: [expect.any(String)],
    });
    expect(awaitingReview.execution.outcome).toBeUndefined();
    expect(run).toMatchObject({
      phase: "reviewing",
      changeSets: [{ disposition: "pending" }],
    });

    await expect(
      subject.workflow.reviewSourceRefreshChangeSet({
        runId: run!.id,
        changeSetId: run!.changeSets[0].id,
        disposition: "approved",
      }),
    ).resolves.toMatchObject({ phase: "terminal", outcome: "succeeded" });
    await expect(
      subject.workflow.inspectSourceRefreshRun(run!.id),
    ).resolves.toMatchObject({
      phase: "terminal",
      outcome: "succeeded",
    });
    await expect(
      subject.workflow.inspect(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: {
        status: "completed",
        stage: "completed",
        outcome: "accepted",
      },
      sourceRefreshRuns: [{ phase: "terminal", outcome: "succeeded" }],
    });
  });

  it("keeps a review-gated Source Refresh Run waiting during startup recovery", async () => {
    const subject = refreshFixture({ sourceRefreshAuthority: true });
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const awaitingReview = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: initial.accepted!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    const collectionCallsBeforeRecovery = subject.collectionCalls();

    await expect(subject.workflow.recoverRunningExecutions()).resolves.toEqual([
      expect.objectContaining({
        execution: expect.objectContaining({
          id: awaitingReview.execution.id,
          status: "running",
          stage: "source-records-retained",
        }),
        sourceRefreshRuns: [
          expect.objectContaining({
            id: run!.id,
            phase: "reviewing",
            changeSets: [expect.objectContaining({ disposition: "pending" })],
          }),
        ],
      }),
    ]);
    expect(subject.resumeClaimAttempts()).toBe(0);
    expect(subject.resumeClaimReleases()).toBe(0);
    expect(subject.collectionCalls()).toBe(collectionCallsBeforeRecovery);
    await expect(
      subject.workflow.inspect(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: {
        status: "running",
        stage: "source-records-retained",
      },
      sourceRefreshRuns: [
        {
          id: run!.id,
          phase: "reviewing",
          changeSets: [{ disposition: "pending" }],
        },
      ],
    });
  });

  it("interrupts an incompatible reviewing Source Refresh execution instead of leaving it waiting", async () => {
    const subject = refreshFixture({ sourceRefreshAuthority: true });
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const awaitingReview = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: initial.accepted!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    const durable = subject.persisted.get(awaitingReview.execution.id)!;
    subject.persisted.set(awaitingReview.execution.id, {
      ...durable,
      execution: {
        ...durable.execution,
        workflowInput: {
          ...durable.execution.workflowInput!,
          version: "asset-refresh-input/999" as "asset-refresh-input/1",
        },
      },
    });

    await expect(subject.workflow.recoverRunningExecutions()).resolves.toEqual([
      expect.objectContaining({
        execution: expect.objectContaining({
          status: "failed",
          stage: "failed",
          outcome: "interrupted",
          reason: "刷新版本化输入版本不受支持",
        }),
        sourceRefreshRuns: [
          expect.objectContaining({
            id: run!.id,
            phase: "terminal",
            outcome: "cancelled",
          }),
        ],
      }),
    ]);
  });

  it("closes an acquiring Source Refresh Run before interrupting unsafe startup recovery", async () => {
    let armed = false;
    let release!: () => void;
    let entered!: () => void;
    const collectionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const collectionReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = refreshFixture({
      sourceRefreshAuthority: true,
      collectionBarrier: async () => {
        if (!armed) return;
        entered();
        await collectionReleased;
      },
    });
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    armed = true;
    let executionId = "";
    const active = subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: initial.accepted!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      onExecutionStarted(execution) {
        executionId = execution.id;
      },
    });
    await collectionEntered;
    const beforeRecovery = await subject.workflow.inspect(executionId);
    const run = beforeRecovery?.sourceRefreshRuns?.[0];
    expect(run).toMatchObject({ phase: "acquiring" });
    const collectionCallsBeforeRecovery = subject.collectionCalls();

    await expect(subject.workflow.recoverRunningExecutions()).resolves.toEqual([
      expect.objectContaining({
        execution: expect.objectContaining({
          id: executionId,
          status: "failed",
          stage: "failed",
          outcome: "interrupted",
        }),
        sourceRefreshRuns: [
          expect.objectContaining({
            id: run!.id,
            phase: "terminal",
            outcome: "cancelled",
          }),
        ],
      }),
    ]);
    expect(subject.collectionCalls()).toBe(collectionCallsBeforeRecovery);

    release();
    await expect(active).resolves.toMatchObject({
      execution: { outcome: "interrupted" },
      sourceRefreshRuns: [{ id: run!.id, outcome: "cancelled" }],
    });
  });

  it("cancels uncommitted Source Refresh scopes before terminally cancelling their Workflow Execution", async () => {
    const subject = refreshFixture({ sourceRefreshAuthority: true });
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const awaitingReview = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: initial.accepted!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    expect(run).toMatchObject({ phase: "reviewing" });

    await expect(
      subject.workflow.cancel({
        executionId: awaitingReview.execution.id,
        requestedBy: "user-1",
        requestedAt: "2026-08-02T00:00:00.000Z",
        reason: "no longer needed",
      }),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        stage: "failed",
        outcome: "cancelled",
        cancellation: { requestedBy: "user-1" },
      },
      sourceRefreshRuns: [
        { id: run!.id, phase: "terminal", outcome: "cancelled" },
      ],
    });
    await expect(
      subject.workflow.inspectSourceRefreshRun(run!.id),
    ).resolves.toMatchObject({ phase: "terminal", outcome: "cancelled" });
    await expect(
      subject.workflow.inspect(awaitingReview.execution.id),
    ).resolves.toMatchObject({
      execution: { outcome: "cancelled" },
      sourceRefreshRuns: [{ id: run!.id, outcome: "cancelled" }],
    });
  });

  it("finishes the latest durable metadata execution when Source Refresh continuation candidate planning throws", async () => {
    const candidate = { enabled: false, fails: false };
    const subject = refreshFixture({
      sourceRefreshAuthority: true,
      sourceEnrichmentCandidateFailureState: candidate,
    });
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    const awaitingReview = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: initial.accepted!.entity.id,
            explanations: [{ path: ["selected asset"] }],
          },
        ],
        filesystemScopes: [],
      },
      reviewPolicy: "review",
    });
    const run = awaitingReview.sourceRefreshRuns?.[0];
    candidate.enabled = true;
    candidate.fails = true;

    await expect(
      subject.workflow.reviewSourceRefreshChangeSet({
        runId: run!.id,
        changeSetId: run!.changeSets[0].id,
        disposition: "approved",
      }),
    ).resolves.toMatchObject({ phase: "terminal", outcome: "succeeded" });

    const failed = await subject.workflow.inspect(awaitingReview.execution.id);
    expect(failed?.execution).toMatchObject({
      status: "failed",
      stage: "failed",
      outcome: "failed",
      reason: "source enrichment candidate interpreter exploded",
    });
    expect(
      subject.persisted.get(awaitingReview.execution.id)?.execution
        .compatibility.capabilityCoordinates,
    ).toContain("supplement.enricher@1/1");
    await expect(
      subject.workflow.resume({
        executionId: awaitingReview.execution.id,
        acceptTrusted: true,
      }),
    ).rejects.toThrow("只有未完成的刷新记录可以继续");
  });

  it("retains independent target outcomes in one parent metadata-refresh execution", async () => {
    const collectionFailureState = { addresses: new Set<string>() };
    const subject = refreshFixture({
      independentEvidence: true,
      collectionFailureState,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const [episodeA, episodeB] = subject.accepted;
    const executionCountBeforeRefresh = (
      await subject.workflow.listInspections()
    ).length;
    collectionFailureState.addresses.add(
      episodeB.recognitionSourceAssociation!.nativeAddress,
    );

    const refreshed = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [episodeA, episodeB].map((accepted) => ({
          subjectId: accepted.entity.id,
          explanations: [{ path: ["selected parent", accepted.entity.id] }],
        })),
        filesystemScopes: [],
      },
    });

    expect(await subject.workflow.listInspections()).toHaveLength(
      executionCountBeforeRefresh + 1,
    );
    expect(refreshed.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("source-refresh"),
          status: "completed",
        }),
      ]),
    );
    expect(refreshed.execution.targetDispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: { kind: "subject", subjectId: episodeA.entity.id },
          status: "completed",
        }),
        expect.objectContaining({
          target: { kind: "subject", subjectId: episodeB.entity.id },
          status: "failed",
        }),
      ]),
    );
    expect(refreshed.execution.outcome).toBe("accepted");
  });

  it("records optional Source Enrichment failure in the same parent refresh without rolling back accepted facts", async () => {
    const subject = refreshFixture({ sourceEnrichmentFails: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const [accepted] = subject.accepted;
    const before = (await subject.workflow.listInspections()).length;

    const refreshed = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: accepted.entity.id,
            explanations: [{ path: ["accepted asset"] }],
          },
        ],
        filesystemScopes: [],
      },
    });

    expect(await subject.workflow.listInspections()).toHaveLength(before + 1);
    expect(refreshed.execution).toMatchObject({
      status: "completed",
      outcome: "partially-succeeded",
      acceptedAssetId: accepted.entity.id,
    });
    expect(refreshed.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("source-enrichment"),
          status: "failed",
          reason: "optional supplement unavailable",
        }),
      ]),
    );
    expect(refreshed.accepted?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Work",
        }),
      ]),
    );
  });

  it("keeps initial recognition and optional Source Enrichment in one parent execution", async () => {
    const subject = refreshFixture({ sourceEnrichmentFails: true });

    const inspected = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(await subject.workflow.listInspections()).toHaveLength(1);
    expect(inspected.execution).toMatchObject({
      status: "completed",
      outcome: "partially-succeeded",
      workItems: [
        expect.objectContaining({ acceptedAssetId: expect.any(String) }),
      ],
    });
    expect(inspected.recognition?.status).toBe("accepted");
    expect(inspected.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("source-enrichment"),
          status: "failed",
          reason: "optional supplement unavailable",
        }),
      ]),
    );
    expect(inspected.accepted?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Work",
        }),
      ]),
    );
  });

  it.each([
    {
      stage: "source-records-retained" as const,
      fixture: { sourceEnrichmentSucceeds: true, sourceOmitsCover: true },
    },
    {
      stage: "source-artifact-acquired" as const,
      fixture: { sourceEnrichmentSucceeds: true, sourceOmitsCover: true },
    },
    {
      stage: "applied" as const,
      fixture: { sourceEnrichmentSucceeds: true, sourceOmitsCover: true },
    },
    {
      stage: "failed" as const,
      fixture: { sourceEnrichmentFails: true },
    },
  ])(
    "propagates an enrichment Host interruption unchanged after $stage without rewriting the checkpoint",
    async ({ stage, fixture }) => {
      const subject = refreshFixture(fixture);
      const interruption = new Error(`stop after enrichment ${stage}`);

      await expect(
        scanFixtureObservedSelection(subject.workflow, {
          selection: {
            version: "asset-refresh-selection/1",
            subjects: [],
            filesystemScopes: [
              {
                root: "/observed/work",
                explanations: [{ path: ["enrichment fault table"] }],
              },
            ],
          },
          acceptTrusted: true,
          informationRequirement: {
            metadataUsageContext: "asset.ordinary",
            metadata: [{ property: "asset.awards", necessity: "optional" }],
            relationshipTypes: [],
            artifactRoles: [
              {
                role: "asset.primary-cover",
                necessity: "optional",
                maximum: 1,
              },
            ],
          },
          onHostCheckpoint(execution) {
            if (
              execution.sourceEnrichments?.some(
                (checkpoint) => checkpoint.stage === stage,
              ) === true
            )
              throw interruption;
          },
        }),
      ).rejects.toBe(interruption);

      const durable = subject.persisted.get(subject.executions[0].id)!;
      expect(
        durable.execution.sourceEnrichments?.some(
          (checkpoint) => checkpoint.stage === stage,
        ),
      ).toBe(true);
      expect(durable.execution.status).toBe("running");
    },
  );

  it("finishes an itemized execution from its latest durable state when candidate planning throws", async () => {
    const candidate = { enabled: true, fails: true };
    const subject = refreshFixture({
      independentEvidence: true,
      singletonExplicit: true,
      sourceEnrichmentCandidateFailureState: candidate,
    });

    const failed = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(failed.execution).toMatchObject({
      status: "failed",
      stage: "failed",
      outcome: "failed",
      reason: "source enrichment candidate interpreter exploded",
    });
    expect(failed.itemResults).toEqual([
      expect.objectContaining({ outcome: "accepted" }),
    ]);
    expect(
      subject.persisted.get(failed.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toContain("supplement.enricher@1/1");
    await expect(
      subject.workflow.resume({
        executionId: failed.execution.id,
        acceptTrusted: true,
      }),
    ).rejects.toThrow("只有未完成的刷新记录可以继续");
  });

  it("persists an ordinary enrichment failure before a later collection is interrupted, then resumes only the pending enrichment", async () => {
    let releaseInitialSecondCollection: (() => void) | undefined;
    let notifyInitialSecondCollection: (() => void) | undefined;
    const initialSecondCollectionStarted = new Promise<void>((resolve) => {
      notifyInitialSecondCollection = resolve;
    });
    let blockInitialSecondCollection = true;
    const subject = refreshFixture({
      sourceEnrichmentFailureThenInterrupted: true,
      async enrichmentCollectionBarrier() {
        if (!blockInitialSecondCollection) return;
        blockInitialSecondCollection = false;
        notifyInitialSecondCollection?.();
        await new Promise<void>((resolve) => {
          releaseInitialSecondCollection = resolve;
        });
      },
    });

    const interrupted = refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.awards", necessity: "optional" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });
    await Promise.race([
      initialSecondCollectionStarted,
      (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        throw new Error(
          `second enrichment collection did not begin; first calls: ${subject.enrichmentCollectionCalls("failing-supplement")}; last execution: ${JSON.stringify(subject.executions.at(-1))}`,
        );
      })(),
    ]);

    const pending = (await subject.workflow.listInspections()).find(
      (inspection) => inspection.execution.status === "running",
    );
    expect(pending?.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("failing-supplement"),
          status: "failed",
          reason: "first enrichment collection exploded",
        }),
      ]),
    );
    expect(subject.enrichmentCollectionCalls("failing-supplement")).toBe(1);

    const resumed = await subject.workflow.resume({
      executionId: pending!.execution.id,
      acceptTrusted: true,
    });

    expect(subject.enrichmentCollectionCalls("failing-supplement")).toBe(1);
    expect(subject.enrichmentCollectionCalls("surviving-supplement")).toBe(2);
    expect(resumed.execution.outcome).toBe("partially-succeeded");
    expect(resumed.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("failing-supplement"),
          status: "failed",
          reason: "first enrichment collection exploded",
        }),
        expect.objectContaining({
          key: expect.stringContaining("surviving-supplement"),
          status: "completed",
        }),
      ]),
    );
    expect(resumed.accepted?.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceIdentity: "surviving-supplement" }),
      ]),
    );

    // 原进程仍停在外部采集效果中。在恢复执行终止后再解除它，只能模拟过期进程醒来，
    // 不属于本恢复断言范围。
    void interrupted.catch(() => {});
    void releaseInitialSecondCollection;
  });

  it("also checkpoints an interpretation failure before a later collection can be recovered", async () => {
    let notifyInitialSecondCollection: (() => void) | undefined;
    const initialSecondCollectionStarted = new Promise<void>((resolve) => {
      notifyInitialSecondCollection = resolve;
    });
    let blockInitialSecondCollection = true;
    const subject = refreshFixture({
      sourceEnrichmentFailureThenInterrupted: true,
      sourceEnrichmentFirstFailureStage: "interpretation",
      async enrichmentCollectionBarrier() {
        if (!blockInitialSecondCollection) return;
        blockInitialSecondCollection = false;
        notifyInitialSecondCollection?.();
        await new Promise<void>(() => {});
      },
    });

    const interrupted = refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.awards", necessity: "optional" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });
    await initialSecondCollectionStarted;

    const pending = (await subject.workflow.listInspections()).find(
      (inspection) => inspection.execution.status === "running",
    );
    expect(pending?.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("failing-supplement"),
          status: "failed",
          reason: "first enrichment interpretation exploded",
        }),
      ]),
    );
    expect(
      subject.persisted.get(pending!.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toContain("failing-supplement.interpreter@1/1");

    const resumed = await subject.workflow.resume({
      executionId: pending!.execution.id,
      acceptTrusted: true,
    });

    expect(subject.enrichmentCollectionCalls("failing-supplement")).toBe(1);
    expect(resumed.execution.outcome).toBe("partially-succeeded");
    expect(resumed.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("failing-supplement"),
          status: "failed",
          reason: "first enrichment interpretation exploded",
        }),
        expect.objectContaining({
          key: expect.stringContaining("surviving-supplement"),
          status: "completed",
        }),
      ]),
    );
    void interrupted.catch(() => {});
  });

  it("keeps an accepted work item's recognition accepted when optional enrichment only partially succeeds", async () => {
    const subject = refreshFixture({
      independentEvidence: true,
      singletonExplicit: true,
      sourceEnrichmentFails: true,
    });

    const inspected = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(inspected.execution.outcome).toBe("partially-succeeded");
    expect(inspected.itemResults).toEqual([
      expect.objectContaining({
        outcome: "accepted",
        recognition: expect.objectContaining({ status: "accepted" }),
        accepted: expect.objectContaining({
          entity: expect.objectContaining({ id: expect.any(String) }),
        }),
      }),
    ]);
  });

  it("downloads a supplementary primary cover only when the recognition source left that requested role empty", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceOmitsCover: true,
    });

    const inspected = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.awards", necessity: "optional" }],
        artifactRoles: [
          {
            role: "asset.primary-cover",
            necessity: "optional",
            maximum: 1,
          },
        ],
        relationshipTypes: [],
      },
    });

    expect(subject.acquisitionCalls()).toBe(1);
    expect(inspected.execution.outcome).toBe("accepted");
    expect(inspected.accepted?.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceIdentity: "source" }),
        expect.objectContaining({ sourceIdentity: "supplement" }),
      ]),
    );
    expect(inspected.accepted?.artifactAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "asset.primary-cover",
          sourceRecordIds: ["supplement-record"],
        }),
      ]),
    );
    expect(inspected.accepted?.artifactAssociations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "asset.background" }),
      ]),
    );
  });

  it("resumes a checkpointed enrichment artifact without rebuilding recognition or recollecting its source", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceOmitsCover: true,
    });
    let executionId: string | undefined;

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.awards", necessity: "optional" }],
          artifactRoles: [
            {
              role: "asset.primary-cover",
              necessity: "optional",
              maximum: 1,
            },
          ],
          relationshipTypes: [],
        },
        onCheckpoint(execution) {
          const checkpoint = execution.sourceEnrichments?.find(
            (item) => item.stage === "source-artifact-acquired",
          );
          if (checkpoint === undefined) return;
          executionId = execution.id;
          throw new Error("simulated process interruption during enrichment");
        },
      }),
    ).rejects.toThrow("simulated process interruption during enrichment");
    expect(executionId).toBeDefined();
    const pendingInspection = (await subject.workflow.listInspections()).find(
      (inspection) => inspection.execution.id === executionId,
    );
    expect(pendingInspection?.execution).not.toHaveProperty(
      "sourceEnrichments",
    );
    const collectionCalls = subject.collectionCalls();
    const acquisitionCalls = subject.acquisitionCalls();

    const resumed = await subject.workflow.resume({
      executionId: executionId!,
      acceptTrusted: true,
    });

    expect(subject.collectionCalls()).toBe(collectionCalls);
    expect(subject.acquisitionCalls()).toBe(acquisitionCalls);
    expect(resumed.execution.outcome).toBe("accepted");
    expect(resumed.accepted?.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceIdentity: "source" }),
        expect.objectContaining({ sourceIdentity: "supplement" }),
      ]),
    );
    expect(resumed.accepted?.artifactAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "asset.primary-cover",
          sourceRecordIds: ["supplement-record"],
        }),
      ]),
    );
  });

  it("resumes retained enrichment records without recollecting the source", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceOmitsCover: true,
    });
    let executionId: string | undefined;

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.awards", necessity: "optional" }],
          artifactRoles: [],
          relationshipTypes: [],
        },
        onCheckpoint(execution) {
          const checkpoint = execution.sourceEnrichments?.find(
            (item) => item.stage === "source-records-retained",
          );
          if (checkpoint === undefined) return;
          executionId = execution.id;
          throw new Error(
            "simulated process interruption after enrichment collection",
          );
        },
      }),
    ).rejects.toThrow(
      "simulated process interruption after enrichment collection",
    );
    expect(executionId).toBeDefined();
    const collectionCalls = subject.collectionCalls();
    const interpretations = subject.directoryInterpretations();

    const resumed = await subject.workflow.resume({
      executionId: executionId!,
      acceptTrusted: true,
    });

    expect(subject.collectionCalls()).toBe(collectionCalls);
    expect(subject.directoryInterpretations()).toBe(interpretations);
    expect(resumed.execution.outcome).toBe("accepted");
    expect(resumed.accepted?.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceIdentity: "supplement" }),
      ]),
    );
  });

  it("audits a retained enrichment as failed when its recognition identity was replaced before resume", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceOmitsCover: true,
    });
    let executionId: string | undefined;

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.awards", necessity: "optional" }],
          artifactRoles: [],
          relationshipTypes: [],
        },
        onCheckpoint(execution) {
          if (
            execution.sourceEnrichments?.some(
              (item) => item.stage === "source-records-retained",
            ) !== true
          )
            return;
          executionId = execution.id;
          throw new Error(
            "simulated process interruption before identity replacement",
          );
        },
      }),
    ).rejects.toThrow(
      "simulated process interruption before identity replacement",
    );
    const previous = subject.accepted[0];
    const replacement = {
      ...previous,
      recognitionSourceAssociation: {
        ...previous.recognitionSourceAssociation!,
        id: "replacement-association",
        nativeAddress: "https://source.example/replacement",
      },
      sourceAssociations: previous.sourceAssociations.map((association) => ({
        ...association,
        id: "replacement-association",
        nativeAddress: "https://source.example/replacement",
      })),
      recognitionDecision: {
        ...previous.recognitionDecision,
        id: "replacement-decision",
      },
    };
    subject.accepted.splice(0, 1, replacement);
    for (const [id, inspection] of subject.persisted) {
      if (inspection.accepted?.entity.id !== replacement.entity.id) continue;
      subject.persisted.set(id, { ...inspection, accepted: replacement });
    }

    const resumed = await subject.workflow.resume({
      executionId: executionId!,
      acceptTrusted: true,
    });

    expect(resumed.execution.outcome).toBe("partially-succeeded");
    expect(resumed.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("source-enrichment"),
          status: "failed",
          reason: "Source Enrichment recognition identity baseline is stale",
        }),
      ]),
    );
    expect(resumed.accepted?.sourceAssociations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceIdentity: "supplement" }),
      ]),
    );
  });

  it("does not interpret retained enrichment records when their collection also failed", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceEnrichmentPartialFailure: true,
      sourceEnrichmentUnsafeFailure: true,
      sourceOmitsCover: true,
    });
    let executionId: string | undefined;

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.awards", necessity: "optional" }],
          artifactRoles: [],
          relationshipTypes: [],
        },
        onCheckpoint(execution) {
          const checkpoint = execution.sourceEnrichments?.find(
            (item) => item.stage === "failed",
          );
          if (checkpoint === undefined) return;
          executionId = execution.id;
          throw new Error(
            "simulated interruption after atomic partial enrichment checkpoint",
          );
        },
      }),
    ).rejects.toThrow(
      "simulated interruption after atomic partial enrichment checkpoint",
    );
    expect(executionId).toBeDefined();
    const persistedBeforeResume = subject.persisted.get(executionId!);
    expect(JSON.stringify(persistedBeforeResume)).not.toContain(
      "private response must not persist",
    );
    expect(JSON.stringify(persistedBeforeResume)).not.toContain(
      "/private/credential",
    );
    expect(
      persistedBeforeResume?.execution.dispositions.find((item) =>
        item.key.includes("source-enrichment"),
      )?.sourceFailureCodes,
    ).toBeUndefined();
    const collectionCalls = subject.collectionCalls();

    const resumed = await subject.workflow.resume({
      executionId: executionId!,
      acceptTrusted: true,
    });

    expect(subject.collectionCalls()).toBe(collectionCalls);
    expect(resumed.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("source-enrichment"),
          status: "failed",
          reason: "supplement detail response failed",
        }),
      ]),
    );
    expect(resumed.execution.outcome).toBe("partially-succeeded");
    expect(resumed.accepted?.sourceAssociations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceIdentity: "supplement" }),
      ]),
    );
    expect(resumed.accepted?.metadata).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceSlot: "supplement.awards" }),
      ]),
    );
  });

  it("resumes an atomically applied enrichment without applying it twice", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceOmitsCover: true,
    });
    let executionId: string | undefined;

    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.awards", necessity: "optional" }],
          artifactRoles: [],
          relationshipTypes: [],
        },
        onCheckpoint(execution) {
          const checkpoint = execution.sourceEnrichments?.find(
            (item) => item.stage === "applied",
          );
          if (checkpoint === undefined) return;
          executionId = execution.id;
          throw new Error(
            "simulated process interruption after enrichment commit",
          );
        },
      }),
    ).rejects.toThrow("simulated process interruption after enrichment commit");
    expect(executionId).toBeDefined();
    const collectionCalls = subject.collectionCalls();

    const resumed = await subject.workflow.resume({
      executionId: executionId!,
      acceptTrusted: true,
    });

    expect(subject.collectionCalls()).toBe(collectionCalls);
    expect(
      resumed.accepted?.sourceAssociations?.filter(
        (association) => association.sourceIdentity === "supplement",
      ),
    ).toHaveLength(1);
    expect(
      resumed.accepted?.metadata.filter(
        (metadata) => metadata.sourceSlot === "supplement.awards",
      ),
    ).toHaveLength(1);
  });

  it("keeps an existing recognition-source primary cover without downloading the supplementary candidate", async () => {
    const subject = refreshFixture({ sourceEnrichmentSucceeds: true });

    const inspected = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.awards", necessity: "optional" }],
        artifactRoles: [
          {
            role: "asset.primary-cover",
            necessity: "optional",
            maximum: 1,
          },
        ],
        relationshipTypes: [],
      },
    });

    expect(subject.acquisitionCalls()).toBe(1);
    expect(inspected.accepted?.artifactAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "asset.primary-cover",
          sourceRecordIds: ["record"],
        }),
      ]),
    );
  });

  it("selects the configured product policy from current facts and exposes explainable Effective Metadata", async () => {
    const subject = refreshFixture({ metadataPolicyConfigured: true });

    const inspected = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    expect(subject.accepted[0]).not.toHaveProperty("metadataPolicyIds");
    // ADR-0086：共同生效读取不再暴露 accepted.effectiveMetadata，
    // 而是把可解释的生效值放进 facts.descriptions[].metadata[].result（见
    // effective-fact-reads.ts:118-137 的 SelectedMetadataRead）。
    const titleRead = (inspected.accepted?.facts.descriptions ?? [])
      .flatMap((description) => description.metadata)
      .find((metadata) => metadata.property === "asset.title");
    expect(titleRead?.result).toEqual(
      expect.objectContaining({
        status: "resolved",
        values: [
          expect.objectContaining({
            property: "asset.title",
            value: "Work",
            sourceIdentity: "source",
            sourceRecordIds: ["record"],
            sourceSlot: "source.title",
            reasoning: {
              kind: "source-preference",
              preferredSource: "source",
            },
          }),
        ],
      }),
    );
  });

  it("projects incomparable enrolled policies as an inspectable conflict with no effective value", async () => {
    const subject = refreshFixture({ metadataPolicyConflict: true });

    const inspected = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    // ADR-0086：不可比较的登记策略不再暴露 effectiveMetadata/metadataPolicyConflicts，
    // 而是把冲突落到 facts：metadata 项 result.status === "conflict"，描述级 conflicts 记录
    // policy-conflict（effective-fact-reads.ts:118-137），候选值改由专用公开读取
    // workflow.inspectSubjectConflictEvidence 给出（effective-fact-reads.ts:194-206、index.ts:12443）。
    const descriptions = inspected.accepted?.facts.descriptions ?? [];
    const titleResult = descriptions
      .flatMap((description) => description.metadata)
      .find((metadata) => metadata.property === "asset.title")?.result;
    expect(titleResult).toMatchObject({ status: "conflict" });
    expect(
      descriptions.some((description) =>
        description.conflicts.some(
          (conflict) => conflict.kind === "policy-conflict",
        ),
      ),
    ).toBe(true);

    const evidence = await subject.workflow.inspectSubjectConflictEvidence(
      subject.accepted[0].entity.id,
      {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        artifactRoles: [],
        relationshipTypes: [],
      },
    );
    expect(evidence?.conflicts).toEqual([
      expect.objectContaining({
        kind: "policy-conflict",
        property: "asset.title",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            value: "Work",
            sourceIdentity: "source",
            sourceRecordIds: ["record"],
          }),
        ]),
      }),
    ]);
  });

  it("refreshes every current Source Association as an independent scope without rolling back a successful source", async () => {
    const subject = refreshFixture({
      multiAssociationRefresh: true,
      failSupplementaryAssociationRefresh: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const [accepted] = subject.accepted;

    const refreshed = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: accepted.entity.id,
            explanations: [{ path: ["accepted asset"] }],
          },
        ],
        filesystemScopes: [],
      },
    });

    expect(subject.retained).toEqual(expect.arrayContaining(["record"]));
    expect(refreshed.execution.outcome).toBe("partially-succeeded");
    expect(refreshed.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("source-refresh"),
          status: "completed",
        }),
      ]),
    );
    expect(refreshed.execution.targetDispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: { kind: "subject", subjectId: accepted.entity.id },
          status: "completed",
          reason: expect.stringContaining("其他来源结果已保留"),
        }),
      ]),
    );
    expect(refreshed.execution.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("source-refresh"),
          status: "completed",
        }),
        expect.objectContaining({
          key: expect.stringContaining("supplementary-source-association"),
          status: "failed",
          reason: "supplementary source is offline",
        }),
      ]),
    );
  });

  it("audits a failed target's retained partial source records", async () => {
    const partialCollectionFailureState = { addresses: new Set<string>() };
    const subject = refreshFixture({
      independentEvidence: true,
      partialCollectionFailureState,
    });
    await scanFixtureObservedSelection(subject.workflow, {
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [],
        filesystemScopes: [
          {
            root: "/observed/work",
            explanations: [{ path: ["test", "initial"] }],
          },
        ],
      },
      acceptTrusted: true,
    });
    const episodeB = subject.accepted[1];
    partialCollectionFailureState.addresses.add(
      episodeB.recognitionSourceAssociation!.nativeAddress,
    );

    const refreshed = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: episodeB.entity.id,
            explanations: [{ path: ["test", "episode-b"] }],
          },
        ],
        filesystemScopes: [],
      },
    });

    expect(refreshed.execution.targetDispositions).toContainEqual(
      expect.objectContaining({
        target: { kind: "subject", subjectId: episodeB.entity.id },
        status: "failed",
        sourceRecordIds: ["other-record"],
        outputReferences: ["other-record"],
      }),
    );
  });

  it("blocks an exact selected entity without its own Source Association", async () => {
    const subject = refreshFixture();
    const observerCallsBeforeRefresh = subject.observerCalls();
    const collectionCallsBeforeRefresh = subject.collectionCalls();

    const refreshed = await subject.workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: "work-entity-without-association",
            explanations: [{ path: ["selected work"] }],
          },
        ],
        filesystemScopes: [],
      },
    });

    expect(refreshed.execution.targetDispositions).toEqual([
      expect.objectContaining({
        target: {
          kind: "subject",
          subjectId: "work-entity-without-association",
        },
        status: "blocked",
      }),
    ]);
    expect(subject.observerCalls()).toBe(observerCallsBeforeRefresh);
    expect(subject.collectionCalls()).toBe(collectionCallsBeforeRefresh);
  });

  it("refreshes an existing Source Association without rerunning recognition or cover acquisition", async () => {
    const subject = refreshFixture();
    const progress: string[] = [];
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const refreshed = await refreshFixtureMetadata(
      subject.workflow,
      subject.accepted[0].entity.id,
      {
        onProgress(message) {
          progress.push(message);
        },
      },
    );

    expect(refreshed.execution).toMatchObject({
      outcome: "accepted",
      acceptedAssetId: subject.accepted[0]?.entity.id,
      selection: { intent: "metadata-refresh" },
    });
    expect(subject.collectionCalls()).toBe(2);
    expect(subject.directoryInterpretations()).toBe(1);
    expect(subject.accepted).toHaveLength(1);
    expect(progress).not.toContain("正在识别目录");
    expect(progress).not.toContain("正在获取主封面");
  });

  it("freezes every selected source-lineage head before metadata-refresh network I/O", async () => {
    const subject = refreshFixture({
      requireLineageFreezeBeforeCollection: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    const refreshed = await refreshFixtureMetadata(
      subject.workflow,
      subject.accepted[0].entity.id,
    );

    expect(refreshed.execution.outcome).toBe("accepted");
  });

  it("refreshes retained identity facts when an unrequested protected source remains unavailable", async () => {
    const subject = refreshFixture({
      collectionUnavailableForUnrequestedMetadata: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    const refreshed = await refreshFixtureMetadata(
      subject.workflow,
      subject.accepted[0].entity.id,
    );

    expect(refreshed.execution).toMatchObject({
      outcome: "accepted",
      selection: { intent: "metadata-refresh" },
    });
    expect(refreshed.sourceRecords).toHaveLength(1);
  });

  it("rejects a malformed metadata-refresh interpretation batch without committing it", async () => {
    const subject = refreshFixture({
      invalidRefreshMetadataProvenance: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    const refreshed = await refreshFixtureMetadata(
      subject.workflow,
      subject.accepted[0].entity.id,
    );

    expect(refreshed.execution.outcome).toBe("failed");
    expect(subject.accepted).toHaveLength(1);
  });

  it("previews a directed identity replacement and does not let trusted recognition apply it", async () => {
    const subject = refreshFixture({ sourceRelationshipQualifiers: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    const preview = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
      directedSourceAddress: "https://source.example/other-work",
      directedSourceIdentity: "source",
    });
    expect(preview.execution).toMatchObject({
      outcome: "proposal",
      selection: { intent: "directed-recognition" },
    });
    expect(subject.accepted).toHaveLength(1);
    const stored = [...subject.changePreviews.values()][0];
    const current = subject.accepted[0];
    const oldCoverId = current.artifactAssociations.find(
      (association) => association.role === "asset.primary-cover",
    )?.artifactId;
    expect(oldCoverId).toBeDefined();
    const materialAssociations = current.artifactAssociations.filter(
      ({ role }) => role === "asset.material-delivered",
    );
    const materialArtifactIds = new Set(
      materialAssociations.map(({ artifactId }) => artifactId),
    );
    expect(stored).toMatchObject({
      assetId: subject.accepted[0]?.entity.id,
      status: "awaiting-confirmation",
      projected: {
        metadata: [{ property: "asset.title", value: "Other Work" }],
      },
    });
    expect(stored.projected.primaryCoverArtifactId).toBeUndefined();
    expect(
      stored.projected.artifactAssociations.filter(
        (association) => association.role === "asset.primary-cover",
      ),
    ).toHaveLength(0);
    expect(
      stored.projected.artifactAssociations.map(({ id }) => id).toSorted(),
    ).toEqual(materialAssociations.map(({ id }) => id).toSorted());
    expect(stored.projected.artifacts.map(({ id }) => id).toSorted()).toEqual(
      [...materialArtifactIds].toSorted(),
    );
    expect(stored.projected.relationships).toEqual([
      expect.objectContaining({
        participants: expect.arrayContaining([
          { entityId: current.entity.id, role: "asset" },
          { entityId: "credited-person", role: "cast" },
        ]),
        producer: expect.objectContaining({ capabilityId: "interpreter" }),
        qualifiers: [
          { key: "character", value: "Character" },
          { key: "source.order", value: "0" },
        ],
      }),
    ]);
    expect(stored.projected.locations.map(({ id }) => id).toSorted()).toEqual(
      current.locations
        .filter(({ artifactId }) => materialArtifactIds.has(artifactId))
        .map(({ id }) => id)
        .toSorted(),
    );
    await expect(
      subject.workflow.applyChangeImpactPreview({
        previewId: stored.id,
        confirmedBy: "reviewer",
      }),
    ).resolves.toMatchObject({ status: "applied" });
    const applied = subject.accepted[0];
    const appliedCoverId = applied.artifactAssociations.find(
      ({ role }) => role === "asset.primary-cover",
    )?.artifactId;
    expect(appliedCoverId).toBeUndefined();
    expect(
      applied.artifactAssociations
        .filter(({ role }) => role === "asset.material-delivered")
        .map(({ artifactId }) => artifactId)
        .toSorted(),
    ).toEqual([...materialArtifactIds].toSorted());
    expect(applied.artifacts).toHaveLength(materialArtifactIds.size);
  });

  it("returns the durable terminal preview when a confirmation response is retried", async () => {
    const subject = refreshFixture();
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      directedSourceAddress: "https://source.example/other-work",
      directedSourceIdentity: "source",
    });
    const preview = [...subject.changePreviews.values()].at(-1)!;

    const concurrent = await Promise.all([
      subject.workflow.applyChangeImpactPreview({
        previewId: preview.id,
        confirmedBy: "reviewer-a",
      }),
      subject.workflow.applyChangeImpactPreview({
        previewId: preview.id,
        confirmedBy: "reviewer-b",
      }),
    ]);
    expect(concurrent.map(({ status }) => status)).toEqual([
      "applied",
      "applied",
    ]);
    await expect(
      subject.workflow.applyChangeImpactPreview({
        previewId: preview.id,
        confirmedBy: "reviewer",
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(
      subject.workflow.rejectChangeImpactPreview({
        previewId: preview.id,
        rejectedBy: "reviewer",
      }),
    ).resolves.toMatchObject({ status: "applied" });

    const rejectPreview = {
      ...preview,
      id: `${preview.id}:reject-race`,
      status: "awaiting-confirmation" as const,
    };
    subject.changePreviews.set(rejectPreview.id, rejectPreview);
    const rejected = await Promise.all([
      subject.workflow.rejectChangeImpactPreview({
        previewId: rejectPreview.id,
        rejectedBy: "reviewer-a",
      }),
      subject.workflow.rejectChangeImpactPreview({
        previewId: rejectPreview.id,
        rejectedBy: "reviewer-b",
      }),
    ]);
    expect(rejected.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
    ]);

    const mixedPreview = {
      ...preview,
      id: `${preview.id}:mixed-race`,
      status: "awaiting-confirmation" as const,
    };
    subject.changePreviews.set(mixedPreview.id, mixedPreview);
    const mixed = await Promise.all([
      subject.workflow.applyChangeImpactPreview({
        previewId: mixedPreview.id,
        confirmedBy: "reviewer-a",
      }),
      subject.workflow.rejectChangeImpactPreview({
        previewId: mixedPreview.id,
        rejectedBy: "reviewer-b",
      }),
    ]);
    expect(new Set(mixed.map(({ status }) => status))).toEqual(
      new Set(["applied"]),
    );
  });

  it("rejects a locally mixed normalization record before applying its source preview", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceAssociationOutcome: "accepted",
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const prepared = await subject.workflow.prepareConflictedEstablishment({
      assetId: subject.accepted[0].entity.id,
      sourceIdentity: "source",
      sourceInput: { address: "https://source.example/mixed-work" },
      initiatedBy: "reviewer",
    });
    const durable = subject.persisted.get(prepared.executionId)!;
    const checkpoint = durable.execution.sourceAssociationDecision!;
    subject.persisted.set(prepared.executionId, {
      ...durable,
      execution: {
        ...durable.execution,
        sourceAssociationDecision: {
          ...checkpoint,
          normalization: {
            ...checkpoint.normalization!,
            normalizedInput: { address: "source:locally-mixed" },
          },
        },
      },
    });

    await expect(
      subject.workflow.applyChangeImpactPreview({
        previewId: prepared.preview!.id,
        confirmedBy: "reviewer",
      }),
    ).rejects.toThrow("持久因果记录无效");
    expect(subject.accepted).toHaveLength(1);
  });

  it("recovers a recognition-retraction confirmation wait without interrupting it", async () => {
    const subject = refreshFixture();
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const current = subject.accepted[0];
    const preview = await subject.workflow.prepareRecognitionRetraction({
      assetId: current.entity.id,
      predecessorDecisionId: current.recognitionDecision.id,
      proposedBy: "reviewer",
      reason: "错误身份",
    });

    const resumed = await subject.workflow.resume({
      executionId: preview.executionId,
    });
    expect(resumed.execution).toMatchObject({ status: "running" });
    expect(resumed.changeImpactPreview).toMatchObject({
      id: preview.id,
      status: "awaiting-confirmation",
    });
    expect(subject.changePreviews.get(preview.id)).toMatchObject({
      status: "awaiting-confirmation",
    });
  });

  it("projects only current source and live recognition supports across a two-step ending", async () => {
    const subject = refreshFixture();
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const current = subject.accepted[0];
    const staleArtifact = { id: "stale-source-artifact" };
    const staleAssociation = {
      id: "stale-source-artifact-association",
      // ArtifactAssociation 现要求 target: DescriptionTarget，不再是 subjectId
      // （domain index.ts:760-762；effective-fact-reads.ts:302/314/465/481 读取 target.kind）。
      target: { kind: "entity" as const, entityId: current.entity.id },
      artifactId: staleArtifact.id,
      role: "asset.material-delivered" as const,
      sourceRecordIds: ["ended-source-record"],
      sourceAssociationId: "ended-source-association",
    };
    const independent = {
      id: "independent-source-association",
      subjectId: current.entity.id,
      sourceIdentity: "independent",
      nativeAddress: "independent:work",
      proposalId: "independent-proposal",
    };
    const coverArtifact = { id: "independently-supported-cover" };
    const cover = {
      id: "independently-supported-cover-association",
      target: { kind: "entity" as const, entityId: current.entity.id },
      artifactId: coverArtifact.id,
      role: "asset.primary-cover" as const,
      sourceRecordIds: ["independent-source-record"],
      sourceAssociationId: independent.id,
    };
    const amended = {
      ...current,
      sourceAssociations: [...current.sourceAssociations, independent],
      artifacts: [...current.artifacts, staleArtifact, coverArtifact],
      artifactAssociations: [
        ...current.artifactAssociations,
        cover,
        staleAssociation,
      ],
      artifactAssociationRecognitionSupports: [
        ...(current.artifactAssociationRecognitionSupports ?? []),
        {
          associationId: cover.id,
          recognitionDecisionId: current.recognitionDecision.id,
        },
      ],
    };
    subject.accepted.splice(0, 1, amended);
    for (const [id, inspection] of subject.persisted)
      if (inspection.accepted?.entity.id === amended.entity.id)
        subject.persisted.set(id, { ...inspection, accepted: amended });

    const preview = await subject.workflow.prepareRecognitionRetraction({
      assetId: amended.entity.id,
      predecessorDecisionId: amended.recognitionDecision.id,
      proposedBy: "reviewer",
      reason: "结束识别支持",
    });
    expect(preview.projected.artifactAssociations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: staleAssociation.id }),
      ]),
    );
    expect(preview.projected.artifactAssociations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: cover.id })]),
    );
  });

  it("preserves a contradicted source candidate as an explicit conflict preview", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceAssociationOutcome: "contradicted",
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    const prepared = await subject.workflow.prepareConflictedEstablishment({
      assetId: subject.accepted[0].entity.id,
      sourceIdentity: "source",
      sourceInput: { address: "https://source.example/other-work" },
      initiatedBy: "reviewer",
    });

    expect(prepared).toMatchObject({
      state: "awaiting-confirmation",
      evidenceComparison: {
        sourceCandidates: [
          {
            outcome: "contradicted",
            explanation: "来源记录与当前身份矛盾",
          },
        ],
        conflicts: ["来源记录与当前身份矛盾"],
      },
      preview: { status: "awaiting-confirmation" },
    });
    expect(prepared.candidates[0]?.ruleResults).toEqual([]);
    expect(JSON.stringify(prepared)).not.toContain('"interpretation"');
    expect(JSON.stringify(prepared)).not.toContain('"producer"');
    expect(JSON.stringify(prepared)).not.toContain('"capabilityId"');
    // 范围修正（非删除）：ADR-0086 后 ChangeImpactPreviewInspection.facts 刻意暴露可解释的
    // sourceRecordIds（index.ts:8519），因此禁止项只应收窄到仍被 safeProjection 剥离的
    // current/projected 表面，而不是整份 prepared。
    expect(JSON.stringify(prepared.preview?.current)).not.toContain(
      '"sourceRecordIds"',
    );
    expect(JSON.stringify(prepared.preview?.projected)).not.toContain(
      '"sourceRecordIds"',
    );
    // 同时正向确认 facts 表面确实携带可解释来源记录，保证覆盖真实而非空断言。
    expect(JSON.stringify(prepared.preview?.facts)).toContain(
      '"sourceRecordIds"',
    );
    expect(prepared.preview?.projected.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Other Work",
        }),
      ]),
    );
  });

  it("continues one of several public source candidates only by its opaque reference", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceAssociationOutcome: "accepted",
      multipleSourceInterpretations: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const prepared = await subject.workflow.prepareConflictedEstablishment({
      assetId: subject.accepted[0].entity.id,
      sourceIdentity: "source",
      sourceInput: { address: "https://source.example/multiple" },
      initiatedBy: "reviewer",
    });
    expect(prepared.state).toBe("awaiting-selection");
    expect(prepared.candidates).toHaveLength(2);
    expect(
      new Set(prepared.candidates.map(({ reference }) => reference)).size,
    ).toBe(2);
    expect(JSON.stringify(prepared.candidates)).not.toContain(
      "sourceRecordIds",
    );
    const generic = await subject.workflow.inspect(prepared.executionId);
    expect(generic?.execution).not.toHaveProperty("sourceAssociationDecision");
    expect(JSON.stringify(generic)).not.toContain("interpretation");

    const selected = await subject.workflow.selectSourceAssociationCandidate({
      executionId: prepared.executionId,
      candidateReference: prepared.candidates[1].reference,
    });
    expect(selected.state).toBe("awaiting-confirmation");
    expect(selected.preview?.evidenceComparison.sourceCandidates).toHaveLength(
      2,
    );
    expect(selected.preview?.projected.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Second candidate",
        }),
      ]),
    );
    expect(selected.preview?.projected.sourceAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nativeAddress: "https://source.example/multiple/second",
        }),
      ]),
    );
  });

  it("keeps the asset without a source association when an interpreter returns no products", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceAssociationOutcome: "accepted",
      sourceInterpretationFault: "empty",
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    const prepared = await subject.workflow.prepareConflictedEstablishment({
      assetId: subject.accepted[0].entity.id,
      sourceIdentity: "source",
      sourceInput: { address: "https://source.example/fault" },
      initiatedBy: "reviewer",
    });

    expect(prepared).toMatchObject({ state: "failed", candidates: [] });
    expect(subject.accepted[0]?.sourceAssociations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nativeAddress: "https://source.example/fault",
        }),
      ]),
    );
  });

  it.each([
    ["unknown-record", "来源解释引用了本次未保留的 Source Record"],
    ["duplicate-address", "同一来源解释器不得重复解释同一来源地址"],
    ["undeclared-relationship", "关系类型尚未声明"],
  ] as const)(
    "rejects a %s source interpretation before it can become a candidate",
    async (sourceInterpretationFault, reason) => {
      const subject = refreshFixture({
        sourceEnrichmentSucceeds: true,
        sourceAssociationOutcome: "accepted",
        sourceInterpretationFault,
      });
      await refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
      });

      await expect(
        subject.workflow.prepareConflictedEstablishment({
          assetId: subject.accepted[0].entity.id,
          sourceIdentity: "source",
          sourceInput: { address: "https://source.example/fault" },
          initiatedBy: "reviewer",
        }),
      ).rejects.toThrow(reason);
      expect(subject.accepted[0]?.sourceAssociations).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nativeAddress: "https://source.example/fault",
          }),
        ]),
      );
    },
  );

  it("rejects two association interpreters for one source batch as a composition error", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceAssociationOutcome: "accepted",
      duplicateSourceAssociationInterpreters: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    await expect(
      subject.workflow.prepareConflictedEstablishment({
        assetId: subject.accepted[0].entity.id,
        sourceIdentity: "source",
        sourceInput: { address: "https://source.example/other-work" },
        initiatedBy: "reviewer",
      }),
    ).rejects.toThrow("一个来源解释只能由一个来源关联解释能力判定");
  });

  it("links a retried source decision to the frozen prior execution", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceAssociationOutcome: "accepted",
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const first = await subject.workflow.prepareConflictedEstablishment({
      assetId: subject.accepted[0].entity.id,
      sourceIdentity: "source",
      sourceInput: { address: "https://source.example/retry-work" },
      initiatedBy: "reviewer",
    });
    await subject.workflow.rejectChangeImpactPreview({
      previewId: first.preview!.id,
      rejectedBy: "reviewer",
    });

    const retried = await subject.workflow.retrySourceAssociationDecision({
      executionId: first.executionId,
    });
    expect(
      subject.persisted.get(retried.executionId)?.execution.workflowInput,
    ).toMatchObject({ priorExecutionId: first.executionId });
  });

  it("honors the Host checkpoint before source-decision collection", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceAssociationOutcome: "accepted",
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const callsBefore = subject.collectionCalls();
    const shutdown = new Error("host is closing");

    await expect(
      subject.workflow.prepareConflictedEstablishment({
        assetId: subject.accepted[0].entity.id,
        sourceIdentity: "source",
        sourceInput: { address: "https://source.example/host-work" },
        initiatedBy: "reviewer",
        onHostCheckpoint() {
          throw shutdown;
        },
      }),
    ).rejects.toBe(shutdown);
    expect(subject.collectionCalls()).toBe(callsBefore);
  });

  it("forms a source preview from the latest accepted state after delayed collection", async () => {
    let entered!: () => void;
    let release!: () => void;
    let armed = false;
    const collectionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const collectionReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceAssociationOutcome: "accepted",
      collectionBarrier: async () => {
        if (!armed) return;
        entered();
        await collectionReleased;
      },
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    armed = true;
    const preparing = subject.workflow.prepareConflictedEstablishment({
      assetId: subject.accepted[0].entity.id,
      sourceIdentity: "source",
      sourceInput: { address: "https://source.example/concurrent-work" },
      initiatedBy: "reviewer",
    });
    await collectionEntered;
    subject.accepted[0] = {
      ...subject.accepted[0],
      metadata: [
        ...subject.accepted[0].metadata,
        {
          // MetadataAssertion 现在要求 target: DescriptionTarget（domain index.ts:760-762；
          // effective-fact-reads.ts:314 读取 target.kind），真实接受都会写 target。
          target: {
            kind: "entity" as const,
            entityId: subject.accepted[0].entity.id,
          },
          property: "user.note",
          value: "added while collecting",
          sourceSlot: "user.note",
          sourceRecordIds: [],
        },
      ],
    };
    release();

    const prepared = await preparing;
    expect(prepared.preview?.current.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "user.note",
          value: "added while collecting",
        }),
      ]),
    );
    expect(prepared.preview?.projected.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "user.note",
          value: "added while collecting",
        }),
      ]),
    );
  });

  it("fails without a proposal when accepted support changes while freezing the preview baseline", async () => {
    const subject = refreshFixture({
      sourceEnrichmentSucceeds: true,
      sourceAssociationOutcome: "accepted",
      mutateAcceptedDuringChangeBaseline: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    const result = await subject.workflow.prepareConflictedEstablishment({
      assetId: subject.accepted[0].entity.id,
      sourceIdentity: "source",
      sourceInput: { address: "https://source.example/concurrent-baseline" },
      initiatedBy: "reviewer",
    });
    expect(result).toMatchObject({ state: "failed" });
    expect(result.preview).toBeUndefined();
    expect(subject.changePreviews.size).toBe(0);
  });

  it("propagates a Host interruption after the durable change-impact preview without rewriting it as failure", async () => {
    const subject = refreshFixture();
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const interruption = new Error("stop after change-impact preview");
    let checkpoint: WorkflowExecution | undefined;

    await expect(
      rescrapeFixtureObservedSelection(subject.workflow, {
        selection: {
          version: "asset-refresh-selection/1",
          subjects: [
            {
              subjectId: initial.accepted!.entity.id,
              explanations: [{ path: ["change impact fault"] }],
            },
          ],
          filesystemScopes: [
            {
              root: "/observed/work",
              explanations: [{ path: ["change impact fault"] }],
            },
          ],
        },
        sourceIdentity: "source",
        sourceAddress: "https://source.example/other-work",
        onHostCheckpoint(execution) {
          if (
            execution.workItems?.some((item) => item.outcome === "proposal")
          ) {
            checkpoint = execution;
            throw interruption;
          }
        },
      }),
    ).rejects.toBe(interruption);

    const durable = subject.persisted.get(subject.executions.at(-1)!.id)!;
    expect(checkpoint).toBeDefined();
    expect(durable.execution).toEqual(checkpoint);
    expect(durable.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "proposal" }),
      ]),
    );
    expect(subject.changePreviews.size).toBe(1);
  });

  it("does not select an acquirer while building a change preview", async () => {
    const failure = { fails: false };
    const subject = refreshFixture({ coverFailureState: failure });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
    });
    failure.fails = true;

    const preview = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
      directedSourceIdentity: "source",
      directedSourceAddress: "https://source.example/other-work",
    });

    expect(preview.execution.outcome).toBe("proposal");
    expect(
      subject.persisted.get(preview.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).not.toContain("acquirer@1/1");
  });

  it("projects concrete before and after state while preserving facts outside the replaced source", async () => {
    const subject = refreshFixture({
      includeForeignAndUserFacts: true,
      sourceAssociationOutcome: "accepted",
      sourceEnrichmentSucceeds: true,
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const prepared = await subject.workflow.prepareConflictedEstablishment({
      assetId: subject.accepted[0]!.entity.id,
      sourceIdentity: "source",
      sourceInput: { address: "https://source.example/other-work" },
      initiatedBy: "reviewer",
    });
    expect(prepared.state).toBe("awaiting-confirmation");

    const preview = [...subject.changePreviews.values()].at(-1)!;
    expect(preview.current.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "user.note", value: "keep me" }),
      ]),
    );
    expect(preview.projected.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "user.note", value: "keep me" }),
        expect.objectContaining({
          property: "asset.title",
          value: "Other Work",
        }),
      ]),
    );
    expect(preview.projected.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "foreign-relationship",
          participants: expect.arrayContaining([
            { entityId: "foreign-entity", role: "other.role" },
          ]),
        }),
      ]),
    );
    expect(preview.projected.artifactAssociations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "user-artifact-association",
          role: "future.unknown-role",
        }),
      ]),
    );
    const inspected = await subject.workflow.inspectChangeImpactPreview(
      preview.id,
    );
    expect(inspected?.current.metadata).toEqual(
      preview.current.metadata.map(
        ({
          producer: _producer,
          sourceRecordIds: _sourceRecordIds,
          authoredBy: _authoredBy,
          observedArtifactPart: _observedArtifactPart,
          ...item
        }) => item,
      ),
    );
    expect(inspected?.projected.metadata).toEqual(
      preview.projected.metadata.map(
        ({
          producer: _producer,
          sourceRecordIds: _sourceRecordIds,
          authoredBy: _authoredBy,
          observedArtifactPart: _observedArtifactPart,
          ...item
        }) => item,
      ),
    );
    expect(JSON.stringify(inspected)).not.toContain("/observed/work");
    expect(JSON.stringify(inspected)).not.toContain('"capabilityId"');
  });

  it("retains an independently enriched source in an identity-replacement projection", async () => {
    const subject = refreshFixture({ sourceEnrichmentSucceeds: true });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.awards", necessity: "optional" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      directedSourceAddress: "https://source.example/other-work",
      directedSourceIdentity: "source",
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.awards", necessity: "optional" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });

    const preview = [...subject.changePreviews.values()].at(-1)!;
    expect(preview.current.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.awards",
          sourceRecordIds: ["supplement-record"],
        }),
      ]),
    );
    expect(preview.projected.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "asset.awards" }),
      ]),
    );
  });

  it("does not duplicate an accepted asset when directed recognition confirms the same identity", async () => {
    const subject = refreshFixture();
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const firstAssetId = subject.accepted[0]?.entity.id;

    const repeated = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      directedSourceAddress: "https://source.example/work",
      directedSourceIdentity: "source",
    });

    // 有字节变化落在已确认头范围内时现在就地耐久重接受（accepted），不再走预览：
    // 见生产 index.ts:18079-18270、同主体同决定重接受 25572。
    expect(repeated.execution.outcome).toBe("accepted");
    // 价值保留：不重复创建资产，仍只有一份且身份不变。
    expect(subject.accepted).toHaveLength(1);
    expect(subject.accepted[0]?.entity.id).toBe(firstAssetId);
    expect(subject.changePreviews.size).toBe(0);
  });

  it("rejects an address-only recognition change in favor of source replacement", async () => {
    const subject = refreshFixture();
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    const result = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      directedSourceAddress: "https://source.example/address-only",
      directedSourceIdentity: "source",
    });
    // 拒绝仅改地址的具体原因现在落在工作项，执行层是聚合原因（index.ts:7372-7398）。
    expect(result.execution).toMatchObject({
      outcome: "failed",
      reason: "1 个工作项未完成；其余工作项已独立保留结果",
    });
    expect(result.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "failed",
          reason: "仅更改来源地址必须使用来源关联更换流程",
        }),
      ]),
    );
    expect(subject.changePreviews.size).toBe(0);
  });

  it("routes ordinary recognition back through preview after an identity replacement", async () => {
    const subject = refreshFixture();
    await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const _replacement = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      directedSourceAddress: "https://source.example/other-work",
      directedSourceIdentity: "source",
    });
    const replacementPreview = [...subject.changePreviews.values()].at(-1);
    expect(replacementPreview).toBeDefined();
    await subject.workflow.applyChangeImpactPreview({
      previewId: replacementPreview!.id,
      confirmedBy: "reviewer",
    });

    const previewCountBefore = subject.changePreviews.size;
    const ordinary = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });

    // 身份更换确认后，普通扫描不再回炉生成改动预览，而是就地保留已确认范围：
    // 见生产 index.ts:18322-18330。
    expect(ordinary.execution.outcome, JSON.stringify(ordinary.execution)).toBe(
      "no-change",
    );
    expect(ordinary.execution.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "no-change",
          reason: "保留已经确认的资产范围",
        }),
      ]),
    );
    // 价值保留：不新增改动预览，也不复制资产。
    expect(subject.changePreviews.size).toBe(previewCountBefore);
    expect(subject.accepted).toHaveLength(1);
  });

  it("persists a minimal Automation Intent and invokes the ordinary workflow for initial and scan-now triggers", async () => {
    const tracker = { resolveCalls: 0, rebindCalls: 0, closeCalls: 0 };
    const subject = refreshFixture({
      assetLibraryAutomation: true,
      observedScopeTracker: tracker,
    });
    const enabled = await subject.workflow.enableAutomation({
      assetLibraryId: "library-fixture",
      observedRootId: "fixture-root",
      relativeScope: ".",
      intervalMilliseconds: 60_000,
      acceptTrusted: true,
    });
    expect(enabled.intent).toMatchObject({
      scope: { observedRootId: "fixture-root", relativeScope: "." },
      enabled: true,
      workflowInputVersion: "asset-refresh-input/1",
      runInitial: true,
    });
    expect(enabled.initial).toMatchObject({ status: "started" });
    const scanned = await subject.workflow.triggerAutomation(
      enabled.intent.id,
      "scan-now",
    );
    expect(scanned).toMatchObject({ status: "started" });
    await subject.workflow.disableAutomation(enabled.intent.id);
    await expect(
      subject.workflow.triggerAutomation(enabled.intent.id, "interval"),
    ).resolves.toMatchObject({ status: "disabled" });
    expect(tracker).toEqual({ resolveCalls: 1, rebindCalls: 2, closeCalls: 3 });
  });

  it("does not persist an automation intent when its observed root is unavailable", async () => {
    let intentWrites = 0;
    let scanCalls = 0;
    const automation = new AssetRefreshAutomation(
      {
        async scanAssetLibrary() {
          scanCalls += 1;
          return {} as never;
        },
      } as never,
      {
        assetLibraries: fixtureAutomationLibraries("revoked-root"),
        executionQueries: {} as never,
        automationQueries: {} as never,
        automationCommands: {
          async createAutomationIntentForObservedRoot() {
            intentWrites += 1;
            return { status: "created" as const };
          },
        },
        recognitionPolicyVersion: "policy/1",
        observedRootRegistrations: {
          async resolveActiveScope() {
            throw new Error("文件位置已停用");
          },
        },
      } as never,
    );

    await expect(
      automation.enableAutomation({
        assetLibraryId: "library-fixture",
        observedRootId: "revoked-root",
        relativeScope: ".",
        intervalMilliseconds: 60_000,
        acceptTrusted: true,
        runInitial: false,
      }),
    ).rejects.toThrow("文件位置已停用");
    expect(intentWrites).toBe(0);
    expect(scanCalls).toBe(0);
  });

  it("suppresses repeated automatic root failures until an operator enables the intent again", async () => {
    const intent = {
      id: "temporarily-unavailable-root",
      scope: {
        assetLibraryId: "library-fixture",
        observedRootId: "fixture-root",
        relativeScope: ".",
      },
      enabled: true,
      intervalMilliseconds: 60_000,
      workflowInputVersion: "asset-refresh-input/1" as const,
      runInitial: false,
      policyReferences: ["policy/1"],
      acceptTrusted: true,
    };
    let scans = 0;
    const disabled: Array<{ readonly id: string; readonly reason?: string }> =
      [];
    const automation = new AssetRefreshAutomation(
      {
        async scanAssetLibrary() {
          scans += 1;
          throw new ObservedRootUnavailable(
            "文件位置当前缺失、不可读或范围越界",
          );
        },
      } as never,
      {
        executionQueries: {
          async inspectExecution() {
            return undefined;
          },
        },
        automationQueries: {
          async inspectAutomationIntent() {
            return intent.enabled ? intent : { ...intent, enabled: false };
          },
          async listAutomationIntents() {
            return [intent];
          },
        },
        automationCommands: {
          async setAutomationIntentEnabled(id, enabled, reason) {
            disabled.push({ id, reason });
            (intent as { enabled: boolean }).enabled = enabled;
          },
          async releaseAutomationTrigger() {},
        },
        recognitionPolicyVersion: "policy/1",
        observedRootRegistrations: {} as never,
      } as never,
    );

    await expect(
      automation.triggerDueAutomation(new Date("2026-08-20T00:00:00.000Z")),
    ).resolves.toEqual([
      {
        status: "skipped",
        reason: "文件位置当前缺失、不可读或范围越界",
      },
    ]);
    await expect(
      automation.triggerDueAutomation(new Date("2026-08-20T00:01:00.000Z")),
    ).resolves.toEqual([]);
    expect(scans).toBe(1);
    expect(disabled).toEqual([
      { id: intent.id, reason: "observed-root-unavailable" },
    ]);
  });

  it("suppresses an adapter-reported prerequisite failure without interpreting its diagnostic", async () => {
    const intent = {
      id: "unavailable-source-prerequisite",
      scope: {
        assetLibraryId: "library-fixture",
        observedRootId: "fixture-root",
        relativeScope: ".",
      },
      enabled: true,
      intervalMilliseconds: 60_000,
      workflowInputVersion: "asset-refresh-input/1" as const,
      runInitial: false,
      policyReferences: ["policy/1"],
      acceptTrusted: true,
    };
    let scans = 0;
    const disabled: string[] = [];
    const automation = new AssetRefreshAutomation(
      {
        async scanAssetLibrary() {
          scans += 1;
          return { parentExecutionId: "failed-by-typed-prerequisite" };
        },
        async inspect(executionId: string) {
          expect(executionId).toBe("failed-by-typed-prerequisite");
          return {
            execution: {
              id: "failed-by-typed-prerequisite",
              status: "failed",
              dispositions: [
                {
                  key: "official-collection",
                  status: "failed",
                  reason: "opaque adapter diagnostic",
                  failureClassification: prerequisiteUnavailableFailure,
                },
              ],
            },
          } as never;
        },
      } as never,
      {
        executionQueries: {
          async inspectExecution() {
            return undefined;
          },
        },
        automationQueries: {
          async inspectAutomationIntent() {
            return intent.enabled ? intent : { ...intent, enabled: false };
          },
          async listAutomationIntents() {
            return [intent];
          },
        },
        automationCommands: {
          async setAutomationIntentEnabled(_id, enabled, reason) {
            disabled.push(reason ?? "");
            (intent as { enabled: boolean }).enabled = enabled;
          },
          async releaseAutomationTrigger() {},
        },
        recognitionPolicyVersion: "policy/1",
        observedRootRegistrations: {} as never,
      } as never,
    );

    await automation.triggerDueAutomation();
    await automation.triggerDueAutomation();
    expect(scans).toBe(1);
    expect(disabled).toEqual(["prerequisite-unavailable"]);
  });

  it("suppresses automatic work when a required Information Fulfillment child durably records an unavailable prerequisite", async () => {
    const intent = {
      id: "modern-information-intent",
      scope: {
        assetLibraryId: "library-fixture",
        observedRootId: "fixture-root",
        relativeScope: ".",
      },
      enabled: true,
      intervalMilliseconds: 60_000,
      workflowInputVersion: "asset-refresh-input/1" as const,
      runInitial: false,
      policyReferences: ["policy/1"],
      acceptTrusted: true,
    };
    const parent = {
      id: "modern-information-parent",
      automationIntentId: intent.id,
      status: "completed",
      dispositions: [],
    };
    const requirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [{ property: "asset.awards", necessity: "required" as const }],
      relationshipTypes: [],
      artifactRoles: [],
    };
    const plan = {
      operationId: "awards-operation",
      subjectId: "accepted-subject",
      sourceIdentity: "source",
      operation: "source-refresh",
      capability: {
        kind: "source-collector",
        capabilityId: "collector",
        capabilityVersion: "1",
        contractVersion: "1",
        implementationVersion: "1",
        identity: "source",
      },
      requirement,
    };
    let childStatus: "running" | "failed" = "failed";
    let scans = 0;
    let registrations = 0;
    let operationDisposition: "planned" | "registered" = "planned";
    const disabled: string[] = [];
    const child = () => ({
      id: "modern-information-child",
      status: childStatus,
      workflowInput: { parentExecutionId: parent.id },
      dispositions:
        childStatus === "failed"
          ? [
              {
                key: "source-refresh",
                status: "failed",
                failureClassification: prerequisiteUnavailableFailure,
              },
            ]
          : [],
    });
    const automation = new AssetRefreshAutomation(
      {
        async scanAssetLibrary(input: { libraryId: string }) {
          expect(input.libraryId).toBe("library-fixture");
          scans += 1;
          return { parentExecutionId: parent.id };
        },
        async inspect(executionId: string) {
          expect(executionId).toBe(parent.id);
          return { execution: parent };
        },
        async fulfillPreparedInformation(input: {
          preparation: { subjects: readonly { plans: readonly unknown[] }[] };
          initiation: { parentExecutionId: string; fromDurableLedger: boolean };
        }) {
          expect(input.initiation).toMatchObject({
            parentExecutionId: parent.id,
            fromDurableLedger: true,
          });
          expect(input.preparation.subjects[0]!.plans).toEqual([plan]);
          registrations += 1;
          operationDisposition = "registered";
          return { requirement, subjects: [] };
        },
      } as never,
      {
        executionQueries: {
          async inspectExecution(executionId: string) {
            return executionId === child().id &&
              operationDisposition === "registered"
              ? { execution: child() }
              : executionId === parent.id && scans > 0
                ? { execution: parent }
                : undefined;
          },
          async listExecutions() {
            return scans === 0
              ? []
              : [
                  parent,
                  ...(operationDisposition === "registered" ? [child()] : []),
                ];
          },
        },
        libraryScanFulfillment: {
          async inspectLibraryScanFulfillment(parentExecutionId: string) {
            expect(parentExecutionId).toBe(parent.id);
            return {
              parentExecutionId,
              stage: "planned",
              plannerCoordinate: "information-planner@1/1",
              subjects: [
                {
                  subjectId: "accepted-subject",
                  disposition: "planned",
                  requirement,
                  operations: [
                    {
                      operationId: plan.operationId,
                      subjectId: plan.subjectId,
                      plan,
                      disposition: operationDisposition,
                      ...(operationDisposition === "registered"
                        ? { childExecutionId: child().id }
                        : {}),
                    },
                  ],
                },
              ],
            };
          },
        },
        automationQueries: {
          async inspectAutomationIntent() {
            return intent;
          },
          async listAutomationIntents() {
            return [intent];
          },
        },
        automationCommands: {
          async setAutomationIntentEnabled(
            _id: string,
            enabled: boolean,
            reason?: string,
          ) {
            disabled.push(reason ?? "");
            intent.enabled = enabled;
          },
          async releaseAutomationTrigger() {},
        },
        recognitionPolicyVersion: "policy/1",
        observedRootRegistrations: {} as never,
      } as never,
    );
    expect(registrations).toBe(0);
    const first = await automation.triggerDueAutomation();
    expect(first).toMatchObject([
      { status: "started", execution: { execution: { id: parent.id } } },
    ]);
    expect(registrations).toBe(1);
    expect(disabled).toEqual(["prerequisite-unavailable"]);
    expect(await automation.triggerDueAutomation()).toEqual([]);
    expect(scans).toBe(1);
    expect(registrations).toBe(1);
    expect(disabled).toEqual(["prerequisite-unavailable"]);
  });

  it("classifies a still-running Information Fulfillment child before a later due poll starts another parent", async () => {
    const intent = {
      id: "modern-information-intent",
      scope: {
        assetLibraryId: "library-fixture",
        observedRootId: "fixture-root",
        relativeScope: ".",
      },
      enabled: true,
      intervalMilliseconds: 60_000,
      workflowInputVersion: "asset-refresh-input/1" as const,
      runInitial: false,
      policyReferences: ["policy/1"],
      acceptTrusted: true,
    };
    const parent = {
      id: "modern-information-parent",
      automationIntentId: intent.id,
      status: "completed",
      dispositions: [],
    };
    const requirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [{ property: "asset.awards", necessity: "required" as const }],
      relationshipTypes: [],
      artifactRoles: [],
    };
    const plan = {
      operationId: "awards-operation",
      subjectId: "accepted-subject",
      sourceIdentity: "source",
      operation: "source-refresh",
      capability: {
        kind: "source-collector",
        capabilityId: "collector",
        capabilityVersion: "1",
        contractVersion: "1",
        implementationVersion: "1",
        identity: "source",
      },
      requirement,
    };
    let childStatus: "running" | "failed" = "running";
    let scans = 0;
    let registrations = 0;
    let operationDisposition: "planned" | "registered" = "planned";
    const disabled: string[] = [];
    const child = () => ({
      id: "modern-information-child",
      status: childStatus,
      workflowInput: { parentExecutionId: parent.id },
      dispositions:
        childStatus === "failed"
          ? [
              {
                key: "source-refresh",
                status: "failed",
                failureClassification: prerequisiteUnavailableFailure,
              },
            ]
          : [],
    });
    const automation = new AssetRefreshAutomation(
      {
        async scanAssetLibrary(input: { libraryId: string }) {
          expect(input.libraryId).toBe("library-fixture");
          scans += 1;
          return { parentExecutionId: parent.id };
        },
        async inspect(executionId: string) {
          expect(executionId).toBe(parent.id);
          return { execution: parent };
        },
        async fulfillPreparedInformation(input: {
          preparation: { subjects: readonly { plans: readonly unknown[] }[] };
          initiation: { parentExecutionId: string; fromDurableLedger: boolean };
        }) {
          expect(input.initiation).toMatchObject({
            parentExecutionId: parent.id,
            fromDurableLedger: true,
          });
          expect(input.preparation.subjects[0]!.plans).toEqual([plan]);
          registrations += 1;
          operationDisposition = "registered";
          return { requirement, subjects: [] };
        },
      } as never,
      {
        executionQueries: {
          async inspectExecution(executionId: string) {
            return executionId === child().id &&
              operationDisposition === "registered"
              ? { execution: child() }
              : executionId === parent.id && scans > 0
                ? { execution: parent }
                : undefined;
          },
          async listExecutions() {
            return scans === 0
              ? []
              : [
                  parent,
                  ...(operationDisposition === "registered" ? [child()] : []),
                ];
          },
        },
        libraryScanFulfillment: {
          async inspectLibraryScanFulfillment(parentExecutionId: string) {
            expect(parentExecutionId).toBe(parent.id);
            return {
              parentExecutionId,
              stage: "planned",
              plannerCoordinate: "information-planner@1/1",
              subjects: [
                {
                  subjectId: "accepted-subject",
                  disposition: "planned",
                  requirement,
                  operations: [
                    {
                      operationId: plan.operationId,
                      subjectId: plan.subjectId,
                      plan,
                      disposition: operationDisposition,
                      ...(operationDisposition === "registered"
                        ? { childExecutionId: child().id }
                        : {}),
                    },
                  ],
                },
              ],
            };
          },
        },
        automationQueries: {
          async inspectAutomationIntent() {
            return intent;
          },
          async listAutomationIntents() {
            return [intent];
          },
        },
        automationCommands: {
          async setAutomationIntentEnabled(
            _id: string,
            enabled: boolean,
            reason?: string,
          ) {
            disabled.push(reason ?? "");
            intent.enabled = enabled;
          },
          async releaseAutomationTrigger() {},
        },
        recognitionPolicyVersion: "policy/1",
        observedRootRegistrations: {} as never,
      } as never,
    );
    expect(registrations).toBe(0);
    const first = await automation.triggerDueAutomation();
    expect(first).toMatchObject([
      { status: "started", execution: { execution: { id: parent.id } } },
    ]);
    expect(registrations).toBe(1);
    expect(disabled).toEqual([]);
    const waiting = await automation.triggerDueAutomation();
    expect(waiting).toEqual([
      { status: "skipped", reason: "信息履行仍在进行中" },
    ]);
    expect(scans).toBe(1);
    childStatus = "failed";
    const unavailable = await automation.triggerDueAutomation();
    expect(unavailable).toEqual([
      { status: "skipped", reason: "自动刷新所需的前置条件当前不可用" },
    ]);
    expect(scans).toBe(1);
    expect(registrations).toBe(1);
    expect(disabled).toEqual(["prerequisite-unavailable"]);
  });

  it("does not persist an automation intent after its bound root preflight is revoked", async () => {
    let rootAvailable = true;
    let authorizedWrites = 0;
    let scopeCloses = 0;
    const filesystem = fixtureObservedFilesystem({
      onClose: () => {
        scopeCloses += 1;
        rootAvailable = false;
      },
    });
    const automation = new AssetRefreshAutomation(
      {
        async scanAssetLibrary() {
          throw new Error("a rejected intent must not start a scan");
        },
      } as never,
      {
        assetLibraries: fixtureAutomationLibraries("fixture-root"),
        executionQueries: {} as never,
        automationQueries: {} as never,
        automationCommands: {
          async createAutomationIntentForObservedRoot() {
            authorizedWrites += 1;
            return rootAvailable
              ? { status: "created" as const }
              : { status: "root-unavailable" as const };
          },
        },
        recognitionPolicyVersion: "policy/1",
        observedRootRegistrations: {
          async resolveActiveScope() {
            const root = fixtureObservedRoot("fixture-root");
            return {
              scope: await filesystem.bindScope({ root, relativeScope: "." }),
              relativeScope: ".",
              root,
            };
          },
          async closeBoundScope(scope) {
            await filesystem.closeScope(scope);
          },
        },
      } as never,
    );

    await expect(
      automation.enableAutomation({
        assetLibraryId: "library-fixture",
        observedRootId: "fixture-root",
        relativeScope: ".",
        intervalMilliseconds: 60_000,
        acceptTrusted: true,
        runInitial: false,
      }),
    ).rejects.toThrow("文件位置");
    expect({ authorizedWrites, scopeCloses }).toEqual({
      authorizedWrites: 1,
      scopeCloses: 1,
    });
  });

  it.each([
    ["不存在", "文件位置不存在", false],
    ["不存在", "文件位置不存在", true],
    ["已停用", "文件位置已停用", false],
    ["已停用", "文件位置已停用", true],
    ["范围越界", "文件位置范围不能越过登记根目录", false],
    ["范围越界", "文件位置范围不能越过登记根目录", true],
  ] as const)(
    "在文件位置%s时不会为自动刷新落库（runInitial=%s）",
    async (_state, reason, runInitial) => {
      let intentWrites = 0;
      let scanCalls = 0;
      const preflight = vi.fn(async () => {
        throw new Error(reason);
      });
      const automation = new AssetRefreshAutomation(
        {
          async scanAssetLibrary() {
            scanCalls += 1;
            return {} as never;
          },
        } as never,
        {
          assetLibraries: fixtureAutomationLibraries("invalid-root"),
          executionQueries: {} as never,
          automationQueries: {} as never,
          automationCommands: {
            async createAutomationIntentForObservedRoot() {
              intentWrites += 1;
              return { status: "created" as const };
            },
          },
          observedRootRegistrations: { resolveActiveScope: preflight },
          recognitionPolicyVersion: "policy/1",
        } as never,
      );

      await expect(
        automation.enableAutomation({
          assetLibraryId: "library-fixture",
          observedRootId: "invalid-root",
          relativeScope: "../outside",
          intervalMilliseconds: 60_000,
          acceptTrusted: true,
          runInitial,
        }),
      ).rejects.toThrow(reason);
      expect(preflight).toHaveBeenCalledWith({
        registrationId: "invalid-root",
        relativeScope: "../outside",
      });
      expect(intentWrites).toBe(0);
      expect(scanCalls).toBe(0);
    },
  );

  it("reconstructs the configured neutral requirement for automatic scans without persisting it on the Automation Intent", async () => {
    const requirement: InformationRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [
        { property: "asset.title", necessity: "required" },
        { property: "dlsite.product.price-jpy", necessity: "optional" },
      ],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "optional",
          maximum: 1,
        },
      ],
      relationshipTypes: [
        { type: "asset.contribution", necessity: "optional" },
      ],
    };
    const subject = refreshFixture({
      assetLibraryAutomation: true,
      automationInformationRequirement: requirement,
    });

    const enabled = await subject.workflow.enableAutomation({
      assetLibraryId: "library-fixture",
      observedRootId: "fixture-root",
      relativeScope: ".",
      intervalMilliseconds: 60_000,
      acceptTrusted: true,
    });

    expect(enabled.intent).not.toHaveProperty("informationRequirement");
    expect(enabled.initial).toMatchObject({
      status: "started",
      execution: {
        execution: { selection: { informationRequirement: requirement } },
      },
    });
    const interactive = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: requirement,
    });
    expect(interactive.execution.selection.informationRequirement).toEqual(
      requirement,
    );
  });

  it("closes a bound observed scope after a successful registered scan", async () => {
    const tracker = { resolveCalls: 0, rebindCalls: 0, closeCalls: 0 };
    const subject = refreshFixture({ observedScopeTracker: tracker });

    await expect(
      subject.workflow.scanObservedScope({
        registrationId: "fixture-root",
        relativeScope: ".",
        acceptTrusted: true,
      }),
    ).resolves.toMatchObject({ execution: { outcome: "accepted" } });

    expect(tracker).toEqual({ resolveCalls: 1, rebindCalls: 0, closeCalls: 1 });
  });

  it("closes a bound observed scope after observer failure", async () => {
    const tracker = { resolveCalls: 0, rebindCalls: 0, closeCalls: 0 };
    const subject = refreshFixture({
      observedScopeTracker: tracker,
      observerFailureState: { enabled: true },
    });

    await expect(
      subject.workflow.scanObservedScope({
        registrationId: "fixture-root",
        relativeScope: ".",
        acceptTrusted: true,
      }),
    ).resolves.toMatchObject({ execution: { outcome: "failed" } });

    expect(tracker).toEqual({ resolveCalls: 1, rebindCalls: 0, closeCalls: 1 });
  });

  it("closes a bound observed scope after cancellation wins an in-flight scan", async () => {
    let entered!: () => void;
    let release!: () => void;
    const acquisitionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const acquisitionRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tracker = { resolveCalls: 0, rebindCalls: 0, closeCalls: 0 };
    const subject = refreshFixture({
      observedScopeTracker: tracker,
      acquisitionBarrier: async () => {
        entered();
        await acquisitionRelease;
      },
    });
    const executionId = "bound-scope-cancelled";
    const active = subject.workflow.scanObservedScope({
      registrationId: "fixture-root",
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
      executionId,
    });
    await acquisitionEntered;

    await subject.workflow.cancel({
      executionId,
      requestedBy: "user-1",
      requestedAt: "2026-08-02T00:00:00.000Z",
    });
    release();
    await expect(active).rejects.toThrow("stale");

    expect(tracker).toEqual({ resolveCalls: 1, rebindCalls: 0, closeCalls: 1 });
  });

  it("interrupts recovery when its frozen observed scope cannot be rebound", async () => {
    const tracker = { resolveCalls: 0, rebindCalls: 0, closeCalls: 0 };
    const subject = refreshFixture({
      observedScopeTracker: tracker,
      rebindScopeFailure: new Error("frozen authority missing"),
    });
    let executionId = "";
    await expect(
      subject.workflow.scanObservedScope({
        registrationId: "fixture-root",
        relativeScope: ".",
        acceptTrusted: true,
        onCheckpoint(execution) {
          executionId = execution.id;
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");

    await expect(
      subject.workflow.resume({ executionId }),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        reason: expect.stringContaining("冻结文件位置"),
      },
    });
    expect(tracker).toEqual({ resolveCalls: 1, rebindCalls: 1, closeCalls: 1 });
  });

  it("interrupts a legacy root-only filesystem execution instead of reopening its directory", async () => {
    const tracker = { resolveCalls: 0, rebindCalls: 0, closeCalls: 0 };
    const subject = refreshFixture({ observedScopeTracker: tracker });
    let executionId = "";
    await expect(
      subject.workflow.scanObservedScope({
        registrationId: "fixture-root",
        relativeScope: ".",
        acceptTrusted: true,
        onCheckpoint(execution) {
          executionId = execution.id;
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");

    const durable = subject.persisted.get(executionId)!;
    subject.persisted.set(executionId, {
      ...durable,
      execution: {
        ...durable.execution,
        // 这是旧版持久解码器可为原 `{ root }` 选择生成的唯一结构：保留历史目录证据，
        // 但不提供可执行文件系统范围。
        requestedSelection: undefined,
        resolvedSelection: undefined,
      },
    });

    await expect(
      subject.workflow.resume({ executionId }),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        reason:
          "刷新记录使用旧版未登记文件位置范围，无法安全继续；请重新选择范围并刷新",
      },
    });
    expect(tracker).toEqual({ resolveCalls: 1, rebindCalls: 0, closeCalls: 1 });
  });

  it("resumes the same non-terminal execution from retained source records in a later process", async () => {
    const subject = refreshFixture();
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onCheckpoint(execution) {
          executionId = execution.id;
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");

    const resumed = await subject.workflow.resume({
      executionId,
      acceptTrusted: true,
    });
    expect(resumed.execution).toMatchObject({
      id: executionId,
      outcome: "accepted",
    });
    expect(subject.collectionCalls()).toBe(1);
    expect(subject.accepted).toHaveLength(1);
    expect(
      subject.persisted.get(executionId)?.execution.compatibility
        .capabilityCoordinates,
    ).toEqual([
      "collector@1/1",
      "directory@1/1",
      "filesystem-observer@1/1",
      "interpreter@1/1",
      "recognizer@1/1",
    ]);
  });

  it("interrupts an ordinary recovery before every producer unless the retained batch stage and disposition agree", async () => {
    const subject = refreshFixture();
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onHostCheckpoint(execution) {
          if (
            !execution.workItems?.some(
              (item) =>
                item.sourceRecordIds.length > 0 &&
                item.proposalId === undefined,
            )
          )
            return;
          executionId = execution.id;
          throw new Error("freeze ordinary recovery checkpoint");
        },
      }),
    ).rejects.toThrow("freeze ordinary recovery checkpoint");
    const durable = subject.persisted.get(executionId)!;
    subject.persisted.set(executionId, {
      ...durable,
      execution: {
        ...durable.execution,
        stage: "recognition",
        workItems: undefined,
        sourceRecordIds: [],
        dispositions: [
          ...durable.execution.dispositions.filter(
            (item) => item.key !== "official-collection",
          ),
          { key: "official-collection", status: "completed" },
        ],
      },
      sourceRecords: [],
    });
    const collectionCalls = subject.collectionCalls();
    const directoryInterpretations = subject.directoryInterpretations();

    await expect(
      subject.workflow.resume({ executionId }),
    ).resolves.toMatchObject({
      execution: {
        outcome: "interrupted",
        reason: "官方来源完整采集批次尚未提交，当前执行不能安全继续",
      },
    });
    expect(subject.collectionCalls()).toBe(collectionCalls);
    expect(subject.directoryInterpretations()).toBe(directoryInterpretations);
    expect(subject.accepted).toEqual([]);
  });

  it("treats an execution with no frozen configuration references as compatible without a resolver", async () => {
    const subject = refreshFixture({ omitConfigurationCompatibility: true });
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onCheckpoint(execution) {
          executionId = execution.id;
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");
    const durable = subject.persisted.get(executionId)!;
    subject.persisted.set(executionId, {
      ...durable,
      execution: {
        ...durable.execution,
        workflowInput: {
          ...durable.execution.workflowInput!,
          configurationReferences: [],
        },
      },
    });

    await expect(
      subject.workflow.resume({ executionId }),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });
    expect(subject.collectionCalls()).toBe(1);
  });

  it("finishes from the latest durable execution when resumed recognition throws", async () => {
    const failure = { enabled: false };
    const subject = refreshFixture({ recognizerFailureState: failure });
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onHostCheckpoint(execution) {
          if (
            !execution.workItems?.some(
              (item) =>
                item.sourceRecordIds.length > 0 &&
                item.proposalId === undefined,
            )
          )
            return;

          executionId = execution.id;
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");
    failure.enabled = true;

    const resumed = await subject.workflow.resume({
      executionId,
      acceptTrusted: true,
    });

    expect(resumed.execution.outcome).toBe("failed");
    expect(
      subject.persisted.get(executionId)?.execution.compatibility
        .capabilityCoordinates,
    ).toEqual(
      expect.arrayContaining([
        "collector@1/1",
        "directory@1/1",
        "interpreter@1/1",
        "recognizer@1/1",
      ]),
    );
  });

  it("does not repeatedly resume a durable accepted execution when candidate planning throws", async () => {
    const candidate = { enabled: false, fails: false };
    const subject = refreshFixture({
      sourceEnrichmentCandidateFailureState: candidate,
    });
    const initial = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const durable = subject.persisted.get(initial.execution.id)!;
    // 这是接受识别与开始可选候选规划之间的精确持久接受状态。新进程必须以终态记录
    // 候选项失败，而不是让本次执行保持可复用。
    subject.persisted.set(initial.execution.id, {
      ...durable,
      execution: {
        ...durable.execution,
        status: "running",
        stage: "source-artifacts-stored",
        outcome: undefined,
        reason: undefined,
      },
    });
    candidate.enabled = true;
    candidate.fails = true;

    const failed = await subject.workflow.resume({
      executionId: initial.execution.id,
      acceptTrusted: true,
    });

    expect(failed.execution).toMatchObject({
      status: "failed",
      stage: "failed",
      outcome: "failed",
      reason: "source enrichment candidate interpreter exploded",
    });
    expect(
      subject.persisted.get(initial.execution.id)?.execution.compatibility
        .capabilityCoordinates,
    ).toContain("supplement.enricher@1/1");
    await expect(
      subject.workflow.resume({
        executionId: initial.execution.id,
        acceptTrusted: true,
      }),
    ).rejects.toThrow("只有未完成的刷新记录可以继续");
  });

  it("refuses resume before reinterpreting when a frozen participating capability changed", async () => {
    const collector = { capabilityVersion: "1", contractVersion: "1" };
    const subject = refreshFixture({ collectorCoordinateState: collector });
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onCheckpoint(execution) {
          executionId = execution.id;
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");
    collector.capabilityVersion = "2";
    collector.contractVersion = "2";

    await expect(
      subject.workflow.resume({ executionId }),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        reason: expect.stringContaining("实际参与能力的实现或契约不兼容"),
      },
    });
    expect(subject.persisted.get(executionId)?.execution.compatibility).toEqual(
      expect.objectContaining({
        capabilityCoordinates: expect.arrayContaining(["collector@1/1"]),
      }),
    );
    expect(subject.collectionCalls()).toBe(1);
  });

  it("resumes a manual execution from its frozen review mode instead of caller input", async () => {
    const subject = refreshFixture();
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: false,
        onHostCheckpoint(execution) {
          if (
            !execution.workItems?.some(
              (item) =>
                item.sourceRecordIds.length > 0 &&
                item.proposalId === undefined,
            )
          )
            return;
          executionId = execution.id;
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");

    await expect(
      subject.workflow.resume({ executionId, acceptTrusted: true }),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "proposal" },
    });
    expect(subject.persisted.get(executionId)?.execution).toMatchObject({
      workflowInput: {
        version: "asset-refresh-input/1",
        trigger: "interactive",
        initiatedBy: "interactive",
        acceptTrusted: false,
      },
    });
  });

  it("interrupts an unknown frozen-input version without blocking another recovery", async () => {
    const subject = refreshFixture();
    const crash = async (executionId: string) =>
      await refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        executionId,
        onHostCheckpoint(execution) {
          if (
            !execution.workItems?.some(
              (item) =>
                item.sourceRecordIds.length > 0 &&
                item.proposalId === undefined,
            )
          )
            return;
          throw new Error(`simulated crash ${executionId}`);
        },
      });
    await expect(crash("unknown-input-version")).rejects.toThrow(
      "simulated crash unknown-input-version",
    );
    await expect(crash("valid-input-version")).rejects.toThrow(
      "simulated crash valid-input-version",
    );
    const corrupt = subject.persisted.get("unknown-input-version")!;
    subject.persisted.set("unknown-input-version", {
      ...corrupt,
      execution: {
        ...corrupt.execution,
        workflowInput: {
          ...corrupt.execution.workflowInput!,
          version: "asset-refresh-input/999" as "asset-refresh-input/1",
        },
      },
    });

    await expect(
      subject.workflow.recoverRunningExecutions(),
    ).resolves.toHaveLength(2);
    await expect(
      subject.workflow.inspect("unknown-input-version"),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        outcome: "interrupted",
        reason: "刷新版本化输入版本不受支持",
      },
    });
    await expect(
      subject.workflow.inspect("valid-input-version"),
    ).resolves.toMatchObject({
      execution: { status: "completed", outcome: "accepted" },
    });
    expect(subject.collectionCalls()).toBe(2);
  });

  it("claims a resumable execution before acquiring external artifacts", async () => {
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = refreshFixture({
      async acquisitionBarrier() {
        entered();
        await barrier;
      },
    });
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: primaryCoverRequirement,
        onHostCheckpoint(execution) {
          if (
            !execution.workItems?.some(
              (item) =>
                item.sourceRecordIds.length > 0 &&
                item.proposalId === undefined,
            )
          )
            return;
          executionId = execution.id;
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");

    const winner = subject.workflow.resume({
      executionId,
      acceptTrusted: true,
    });
    await firstEntered;
    await expect(
      subject.workflow.resume({ executionId, acceptTrusted: true }),
    ).rejects.toThrow("刷新记录正在由另一个进程继续");
    expect(subject.acquisitionCalls()).toBe(1);
    release();
    await expect(winner).resolves.toMatchObject({
      execution: { id: executionId, outcome: "accepted" },
    });
    expect(subject.acquisitionCalls()).toBe(1);
  });

  it("records an explicit cancellation as a terminal inspection without rolling back retained source evidence", async () => {
    let entered!: () => void;
    let release!: () => void;
    const acquisitionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const acquisitionRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = refreshFixture({
      acquisitionBarrier: async () => {
        entered();
        await acquisitionRelease;
      },
    });
    const executionId = "cancelled-while-acquiring";
    const active = refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
      informationRequirement: primaryCoverRequirement,
      executionId,
    });
    await acquisitionEntered;

    await expect(
      subject.workflow.cancel({
        executionId,
        requestedBy: "user-1",
        requestedAt: "2026-08-02T00:00:00.000Z",
        reason: "user stopped this refresh",
      }),
    ).resolves.toMatchObject({
      execution: {
        status: "failed",
        stage: "failed",
        outcome: "cancelled",
        cancellation: {
          requestedBy: "user-1",
          requestedAt: "2026-08-02T00:00:00.000Z",
          reason: "user stopped this refresh",
        },
      },
      sourceRecords: [{ id: "record" }],
    });
    await expect(subject.workflow.inspect(executionId)).resolves.toMatchObject({
      execution: {
        outcome: "cancelled",
        cancellation: { requestedBy: "user-1" },
      },
      sourceRecords: [{ id: "record" }],
    });

    release();
    await expect(active).rejects.toThrow("stale");
  });

  it("renews its lease while a long external artifact effect is in flight", async () => {
    let now = new Date("2026-07-29T00:00:00.000Z");
    let heartbeat: (() => void) | undefined;
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = refreshFixture({
      acquisitionBarrier: async () => {
        entered();
        await barrier;
      },
      resumeClock: {
        now: () => now,
        setInterval(callback, milliseconds) {
          expect(milliseconds).toBe(10_000);
          heartbeat = callback;
          return "resume-heartbeat";
        },
        clearInterval(handle) {
          expect(handle).toBe("resume-heartbeat");
        },
      },
    });
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        informationRequirement: primaryCoverRequirement,
        onHostCheckpoint(execution) {
          if (
            !execution.workItems?.some(
              (item) =>
                item.sourceRecordIds.length > 0 &&
                item.proposalId === undefined,
            )
          )
            return;
          executionId = execution.id;
          throw new Error("simulated process interruption");
        },
      }),
    ).rejects.toThrow("simulated process interruption");

    const winner = subject.workflow.resume({
      executionId,
      acceptTrusted: true,
    });
    await firstEntered;
    now = new Date("2026-07-29T00:00:20.000Z");
    heartbeat?.();
    await Promise.resolve();
    now = new Date("2026-07-29T00:00:35.000Z");
    await expect(
      subject.workflow.resume({ executionId, acceptTrusted: true }),
    ).rejects.toThrow("刷新记录正在由另一个进程继续");
    release();
    await expect(winner).resolves.toMatchObject({
      execution: { outcome: "accepted" },
    });
  });

  it("classifies startup recovery as waiting while a durable execution has an unexpired claim", async () => {
    const subject = refreshFixture();
    let executionId = "";
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        onCheckpoint(execution) {
          executionId = execution.id;
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    subject.resumeClaims.set(executionId, {
      token: "crashed-process",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const waiting: string[] = [];
    await expect(
      subject.workflow.recoverRunningExecutions({
        onWaitingExecution(execution) {
          waiting.push(execution);
        },
      }),
    ).resolves.toEqual([]);
    expect(waiting).toEqual([executionId]);
    await expect(subject.workflow.inspect(executionId)).resolves.toMatchObject({
      execution: { status: "running" },
    });
  });

  it("recovers interactive and automatic durable executions before polling new triggers", async () => {
    const subject = refreshFixture({ assetLibraryAutomation: true });
    const enabled = await subject.workflow.enableAutomation({
      assetLibraryId: "library-fixture",
      observedRootId: "fixture-root",
      relativeScope: ".",
      intervalMilliseconds: 60_000,
      acceptTrusted: true,
      runInitial: false,
    });
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: false,
        executionId: "interrupted-interactive",
        onHostCheckpoint(execution) {
          if (
            execution.workItems?.some(
              (item) =>
                item.sourceRecordIds.length > 0 &&
                item.proposalId === undefined,
            )
          )
            throw new Error("simulated interactive process crash");
        },
      }),
    ).rejects.toThrow("simulated interactive process crash");
    await expect(
      refreshFixtureObservedScope(subject.workflow, {
        directory: "/observed/work",
        acceptTrusted: true,
        executionId: "interrupted-automation",
        automationIntentId: enabled.intent.id,
        trigger: "interval",
        requestedAt: "2026-07-29T00:00:00.000Z",
        onHostCheckpoint(execution) {
          if (
            execution.workItems?.some(
              (item) =>
                item.sourceRecordIds.length > 0 &&
                item.proposalId === undefined,
            )
          )
            throw new Error("simulated automation process crash");
        },
      }),
    ).rejects.toThrow("simulated automation process crash");

    await expect(
      subject.workflow.triggerAutomation(enabled.intent.id, "scan-now"),
    ).resolves.toMatchObject({ status: "skipped" });
    await subject.workflow.disableAutomation(enabled.intent.id);
    const host = new AutomationHost(subject.workflow);
    await host.start();
    await host.settled();
    host.stop();
    await expect(
      subject.workflow.inspect("interrupted-automation"),
    ).resolves.toMatchObject({ execution: { outcome: "accepted" } });
    await expect(
      subject.workflow.inspect("interrupted-interactive"),
    ).resolves.toMatchObject({
      execution: {
        outcome: "proposal",
        workflowInput: { trigger: "interactive", acceptTrusted: false },
      },
    });
    expect(subject.collectionCalls()).toBe(2);
    subject.automationIntents.set(enabled.intent.id, {
      ...enabled.intent,
      enabled: true,
    });
    await expect(
      subject.workflow.triggerAutomation(enabled.intent.id, "scan-now"),
    ).resolves.toMatchObject({ status: "started" });
  });

  it("refuses to reopen a terminal failed execution", async () => {
    const subject = refreshFixture({ coverFails: true });
    const failed = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    await expect(
      subject.workflow.resume({
        executionId: failed.execution.id,
        acceptTrusted: true,
      }),
    ).rejects.toThrow("只有未完成的刷新记录可以继续");
  });

  it("can deliberately serve one whole observed filesystem package without promoting every member file", async () => {
    const subject = refreshFixture({ directedFilesystemPackage: true });
    const first = await refreshFixtureObservedScope(subject.workflow, {
      directory: "/observed/work",
      acceptTrusted: true,
    });
    const assetId = first.accepted!.entity.id;
    const reevaluated = await rescrapeFixtureObservedSelection(
      subject.workflow,
      {
        selection: {
          version: "asset-refresh-selection/1",
          subjects: [
            {
              subjectId: assetId,
              explanations: [{ path: ["Asset", assetId] }],
            },
          ],
          filesystemScopes: [
            {
              root: "/observed/work",
              explanations: [{ path: ["CLI", "work"] }],
            },
          ],
        },
        sourceIdentity: "source",
        sourceAddress: "https://source.example/work",
      },
    );

    expect(reevaluated.accepted?.entity.id).toBe(assetId);
    expect(
      reevaluated.accepted?.locations.filter(
        (item) => item.kind === "observed",
      ),
    ).toEqual([expect.objectContaining({ address: "/observed/work" })]);
    expect(
      reevaluated.accepted?.artifactAssociations.filter(
        (item) => item.role === "asset.material-delivered",
      ),
    ).toHaveLength(1);
  });

  it("retains the selected filesystem-package interpreter coordinate in durable work-item audit only", async () => {
    const subject = refreshFixture({ directedFilesystemPackage: true });

    const recognized = await directedRecognitionFixtureObservedSelection(
      subject.workflow,
      {
        selection: {
          version: "asset-refresh-selection/1",
          subjects: [],
          filesystemScopes: [
            {
              root: "/observed/work",
              explanations: [{ path: ["CLI", "work"] }],
            },
          ],
        },
        sourceIdentity: "source",
        sourceAddress: "https://source.example/work",
      },
    );
    const durable = subject.persisted.get(recognized.execution.id)!.execution;

    expect(durable.workItems?.[0]).toMatchObject({
      observedArtifactBoundary: "filesystem-package",
      observedArtifactBoundaryProducer: {
        capabilityId: "test.filesystem-package",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    });
    expect(recognized.execution.workItems?.[0]).not.toHaveProperty(
      "observedArtifactBoundaryProducer",
    );
  });

  it("reevaluates a filesystem package when its technical interpreter coordinate changes", async () => {
    const coordinate = { capabilityVersion: "1", contractVersion: "1" };
    const subject = refreshFixture({
      directedFilesystemPackage: true,
      filesystemPackageCoordinateState: coordinate,
    });
    const input = {
      selection: {
        version: "asset-refresh-selection/1" as const,
        subjects: [],
        filesystemScopes: [
          { root: "/observed/work", explanations: [{ path: ["CLI", "work"] }] },
        ],
      },
      sourceIdentity: "source",
      sourceAddress: "https://source.example/work",
    };
    await directedRecognitionFixtureObservedSelection(subject.workflow, input);
    coordinate.contractVersion = "2";

    const repeated = await directedRecognitionFixtureObservedSelection(
      subject.workflow,
      input,
    );

    expect(repeated.execution.outcome).toBe("accepted");
    expect(subject.collectionCalls()).toBe(2);
    expect(
      subject.persisted.get(repeated.execution.id)?.execution.workItems?.[0]
        ?.observedArtifactBoundaryProducer,
    ).toMatchObject({ contractVersion: "2" });
  });

  it("directs an unrecognized filesystem scope to one exact source address without requiring an existing subject", async () => {
    const subject = refreshFixture({ directedFilesystemPackage: true });

    const recognized = await directedRecognitionFixtureObservedSelection(
      subject.workflow,
      {
        selection: {
          version: "asset-refresh-selection/1",
          subjects: [],
          filesystemScopes: [
            {
              root: "/observed/work",
              explanations: [{ path: ["CLI", "work"] }],
            },
          ],
        },
        sourceIdentity: "source",
        sourceAddress: "https://source.example/work",
      },
    );

    expect(recognized.execution).toMatchObject({
      operationKind: "scan-filesystem",
      outcome: "accepted",
      requestedSelection: {
        subjects: [],
        filesystemScopes: [{ root: "/observed/work" }],
      },
    });
    expect(recognized.accepted).toMatchObject({
      recognitionSourceAssociation: {
        sourceIdentity: "source",
        nativeAddress: "https://source.example/work",
      },
      locations: [{ address: "/observed/work", kind: "observed" }],
    });
  });
});

function informationFulfillmentLifecycleFixture() {
  const launch = deferred<never>();
  const terminalWrite = deferred<void>();
  const terminalizationStarted = deferred<void>();
  const businessFailure = new Error("source became unavailable");
  const running = {
    id: "information-execution",
    status: "running",
    stage: "recognition",
  } as WorkflowExecution;
  const transition = vi.fn(async () => {
    terminalizationStarted.resolve();
    await terminalWrite.promise;
  });
  const host = new ExecutionHost();
  const workflow = new AssetRefreshWorkflow({
    invocationSupervisor: host,
    informationSubjectFactsQueries: {
      async readCurrentInformationSubjectFacts() {
        return [
          {
            subjectId: "subject",
            sourceArtifactCurrency: [],
            basis: {
              id: "subject",
              metadata: [],
              relationships: [],
              artifactAssociations: [],
              artifactRevisions: [],
              blobs: [],
              locations: [],
              sourceAssociations: [
                {
                  id: "association",
                  subjectId: "subject",
                  sourceIdentity: "source",
                },
              ],
            },
          },
        ];
      },
    },
    informationFulfillmentCapabilities: [
      {
        declaration: {
          identity: "source.refresh",
          implementationVersion: "1",
          kind: "source-refresh",
          interpretationContractVersions: ["1"],
        },
        operation: "source-refresh",
        sourceIdentities: ["source"],
        metadataProperties: ["asset.title"],
        cost: "low",
        availability: "available",
      },
    ],
    executionQueries: {
      async inspectExecution() {
        return { execution: running };
      },
    },
    executionCommands: { transitionExecution: transition },
  } as never);
  const refreshMetadataInternal = vi
    .spyOn(
      workflow as unknown as {
        refreshMetadataInternal(input: {
          readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
        }): Promise<never>;
      },
      "refreshMetadataInternal",
    )
    .mockImplementation(async (input) => {
      input.onExecutionStarted?.(running);
      return await launch.promise;
    });
  const input = {
    selection: { subjectIds: ["subject"] },
    requirement: {
      metadataUsageContext: "asset.ordinary",
      metadata: [{ property: "asset.title", necessity: "required" as const }],
      relationshipTypes: [],
      artifactRoles: [],
    },
  };
  return {
    launch,
    terminalWrite,
    terminalizationStarted,
    businessFailure,
    running,
    transition,
    workflow,
    host,
    refreshMetadataInternal,
    input,
  };
}

describe("Information fulfillment lifecycle", () => {
  it("drains a started fulfillment's terminal transition before closing and blocks later fulfillment", async () => {
    const {
      launch,
      terminalWrite,
      terminalizationStarted,
      businessFailure,
      running,
      transition,
      workflow,
      host,
      refreshMetadataInternal,
      input,
    } = informationFulfillmentLifecycleFixture();

    await expect(workflow.fulfillInformation(input)).resolves.toMatchObject({
      subjects: [
        {
          subjectId: "subject",
          status: "pending",
        },
      ],
    });

    const closing = host.close();
    await workflow.close();
    const repeatedClose = host.close();
    expect(repeatedClose).toBe(closing);
    await expect(workflow.fulfillInformation(input)).resolves.toMatchObject({
      subjects: [
        {
          subjectId: "subject",
          status: "blocked",
          inputs: [
            expect.objectContaining({
              coordinate: "asset.title",
              reason: "信息履行正在关闭",
            }),
          ],
        },
      ],
    });
    expect(refreshMetadataInternal).toHaveBeenCalledTimes(1);

    let closeResolved = false;
    void closing.then(() => {
      closeResolved = true;
    });
    launch.reject(businessFailure);
    await terminalizationStarted.promise;
    expect(closeResolved).toBe(false);
    expect(transition).toHaveBeenCalledWith(
      running,
      expect.objectContaining({
        status: "failed",
        reason: businessFailure.message,
      }),
      undefined,
    );

    terminalWrite.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(closeResolved).toBe(true);
  });

  it("reports a terminalization failure only after its fulfillment settlement", async () => {
    const {
      launch,
      terminalWrite,
      terminalizationStarted,
      businessFailure,
      transition,
      workflow,
      host,
      input,
    } = informationFulfillmentLifecycleFixture();
    const terminalizationFailure = new Error("terminal write failed");

    await expect(workflow.fulfillInformation(input)).resolves.toMatchObject({
      subjects: [{ subjectId: "subject", status: "pending" }],
    });

    const closing = host.close();
    await workflow.close();
    launch.reject(businessFailure);
    await terminalizationStarted.promise;
    terminalWrite.reject(terminalizationFailure);

    await expect(closing).resolves.toBeUndefined();
    await expect(host.close()).resolves.toBeUndefined();
    expect(transition).toHaveBeenCalledTimes(1);
  });
});

describe("Automation host", () => {
  it("classifies startup recovery before the injected clock drives any due poll, and stops cleanly", async () => {
    let now = new Date("2026-07-29T00:00:00.000Z");
    let timer: (() => void) | undefined;
    let cleared = false;
    const calls: string[] = [];
    const host = new AutomationHost(
      {
        async classifyRunningExecutions() {
          calls.push("classify");
          return [];
        },
        async continueRunningExecution() {
          return undefined;
        },
        async triggerDueAutomation(current) {
          calls.push(`due:${current.toISOString()}`);
          return [];
        },
        async reconcileTerminalFulfillment() {
          return [];
        },
      },
      {
        pollIntervalMilliseconds: 250,
        clock: {
          now: () => now,
          setInterval(callback, milliseconds) {
            expect(milliseconds).toBe(250);
            timer = callback;
            return "timer";
          },
          clearInterval(handle) {
            expect(handle).toBe("timer");
            cleared = true;
          },
        },
      },
    );

    await host.start();
    expect(host.running).toBe(true);
    expect(host.recoveryReady).toBe(true);
    expect(calls).toEqual(["classify"]);
    now = new Date("2026-07-29T00:00:00.250Z");
    timer?.();
    await host.settled();
    expect(calls).toEqual([
      "classify",
      "classify",
      "due:2026-07-29T00:00:00.250Z",
    ]);

    host.stop();
    expect(host.running).toBe(false);
    expect(host.recoveryReady).toBe(false);
    expect(cleared).toBe(true);
    now = new Date("2026-07-29T00:00:00.500Z");
    timer?.();
    await host.settled();
    expect(calls).toHaveLength(3);
  });

  it("passes the shared Host checkpoint request into an active interval execution", async () => {
    let now = new Date("2026-07-29T00:00:00.000Z");
    let timer: (() => void) | undefined;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const intervalEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let polls = 0;
    let continuedAfterCheckpoint = false;
    let receivedLifecycle = false;
    const executionHost = new ExecutionHost();
    const host = new AutomationHost(
      {
        async classifyRunningExecutions() {
          return [];
        },
        async continueRunningExecution() {
          return undefined;
        },
        async triggerDueAutomation(_now, lifecycle) {
          polls += 1;
          receivedLifecycle = lifecycle !== undefined;
          entered();
          await barrier;
          lifecycle?.onCheckpoint();
          continuedAfterCheckpoint = true;
          return [];
        },
        async reconcileTerminalFulfillment() {
          return [];
        },
      },
      {
        executionHost,
        clock: {
          now: () => now,
          setInterval(callback) {
            timer = callback;
            return "timer";
          },
          clearInterval() {},
        },
      },
    );

    await host.start();
    now = new Date("2026-07-29T00:00:02.000Z");
    timer?.();
    await intervalEntered;
    expect(polls).toBe(1);
    expect(receivedLifecycle).toBe(true);
    host.stop();
    const closing = executionHost.close();
    release();
    await expect(closing).resolves.toBeUndefined();
    await expect(host.settled()).resolves.toBeUndefined();
    expect(continuedAfterCheckpoint).toBe(false);
  });

  it("can restart after its initial classification poll fails", async () => {
    let attempts = 0;
    const host = new AutomationHost({
      async classifyRunningExecutions() {
        attempts += 1;
        if (attempts === 1) throw new Error("claim still busy");
        return [];
      },
      async continueRunningExecution() {
        return undefined;
      },
      async triggerDueAutomation() {
        return [];
      },
      async reconcileTerminalFulfillment() {
        return [];
      },
    });

    await expect(host.start()).rejects.toThrow("claim still busy");
    expect(host.running).toBe(false);
    await expect(host.start()).resolves.toBeUndefined();
    expect(host.running).toBe(true);
    host.stop();
  });

  it("passes the shared Host checkpoint request into startup recovery", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let continuedAfterCheckpoint = false;
    let dueCalls = 0;
    const executionHost = new ExecutionHost();
    const host = new AutomationHost(
      {
        async classifyRunningExecutions() {
          return [
            {
              executionId: "execution-recovered",
              category: "continuable" as const,
              subject: "崩溃前已开始的观察刷新",
            },
          ];
        },
        async continueRunningExecution(_executionId, lifecycle) {
          entered();
          await barrier;
          lifecycle?.onCheckpoint();
          continuedAfterCheckpoint = true;
          return undefined;
        },
        async triggerDueAutomation() {
          dueCalls += 1;
          return [];
        },
        async reconcileTerminalFulfillment() {
          return [];
        },
      },
      { executionHost },
    );

    const starting = host.start();
    await recoveryEntered;
    host.stop();
    const closing = executionHost.close();
    release();

    await expect(closing).resolves.toBeUndefined();
    await expect(starting).resolves.toBeUndefined();
    expect(continuedAfterCheckpoint).toBe(false);
    expect(dueCalls).toBe(0);
  });
});
