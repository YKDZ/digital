import { createHash, randomUUID } from "node:crypto";

import {
  type AcceptedRecognition,
  type Artifact,
  type ArtifactAssociation,
  type ArtifactRevision,
  type Blob,
  type CapabilityCoordinate,
  type CreateSourceRefreshRunInput,
  type DigitalAsset,
  deriveEffectiveMetadata,
  type EffectiveMetadata,
  type Location,
  type MetadataAssertion,
  type MetadataPolicy,
  type MetadataPolicyConflict,
  type RecognitionEvidence,
  type RecognitionProposal,
  type RecognitionProposalDraft,
  type RecognitionRuleResult,
  type SourceAssociation,
  type SourceArtifactCandidate,
  type SourceCoverageScope,
  type SourceRefreshRun,
  type ObservedArtifactPartCandidate,
  type SourceInterpretationBatch,
  type SourceRecord,
  validateAcceptedRecognition,
  validateMetadataPolicy,
  validateRecognitionProposal,
  validateReevaluatedRecognition,
  validateSourceInterpretationBatch,
} from "@digital/domain";

import {
  assetRefreshSelectionVersion,
  assertAssetRefreshSelection,
  freezeAssetRefreshSelection,
  type AssetRefreshSelection,
  type ResolvedAssetRefreshSelection,
} from "./asset-refresh-selection.ts";
import type {
  ExecutionHost,
  ExecutionInvocationControl,
} from "./execution-host.ts";
import {
  blockedInformationReadiness,
  InformationFulfillment,
  type InformationFulfillmentCapability,
  type InformationFulfillmentInitiation,
  type InformationFulfillmentPendingReconciliation,
  type InformationFulfillmentPlan,
  type InformationFulfillmentStart,
  type InformationReadiness,
  type InformationSubjectFacts,
  type InformationSubjectSelection,
} from "./information-fulfillment.ts";
import type { MetadataPolicyConfiguration } from "./metadata-policy-configuration.ts";
import {
  decodeObservedRootSnapshot,
  freezeObservedRootAutomationAuthorization,
  type ObservedRootAutomationAuthorization,
  type ObservedRootAutomationScope,
} from "./observed-root-authority.ts";
import { ObservedRootExecution } from "./observed-root-execution.ts";
import {
  BoundObservedScope,
  ObservedByteSource,
  type ObservedRootRegistrations,
  type ObservedRootSnapshot,
  ObservedRootUnavailable,
} from "./observed-root-registrations.ts";
import {
  CheckpointedSourceArtifactWork,
  projectManagedSourceArtifacts,
} from "./source-artifact-work.ts";
import {
  atPublicWorkflowBoundary,
  notifyWorkflowCheckpoint as notifyDurableCheckpoint,
  rethrowWorkflowLifecycle,
  WorkflowLifecycleInterruption as WorkflowCheckpointInterruption,
} from "./workflow-invocation-lifecycle.ts";

export * from "./information-fulfillment.ts";
export * from "./execution-host.ts";
export * from "./workflow-invocation-lifecycle.ts";
export * from "./observed-root-registrations.ts";
export * from "./observed-root-authority.ts";
export * from "./observed-root-execution.ts";
export * from "./source-connection-private-state.ts";
export * from "./source-connection.ts";

export * from "./asset-refresh-selection.ts";
export {
  deriveEffectiveMetadata,
  validateMetadataPolicy,
  type EffectiveMetadata,
  type EffectiveMetadataAlternative,
  type EffectiveMetadataInput,
  type EffectiveMetadataProjection,
  type MetadataPolicy,
  type MetadataPolicyConflict,
  type MetadataPolicyRule,
} from "@digital/domain";
export * from "./metadata-policy-configuration.ts";

export type FileObservation = {
  readonly relativePath: string;
  readonly size: number;
  readonly modifiedAt: string;
  /**
   * 不透明观察器证据。快照内的值只能在本次不可变快照中合并别名。耐久值还要求观察器
   * 明确声明耐久身份能力，Application 才能把它们用作跨执行的产物连续性证据。
   */
  readonly objectIdentity?: FilesystemObjectIdentity;
};

export type FilesystemObjectIdentity =
  | {
      readonly version: "filesystem-object-identity/2";
      readonly kind: "snapshot-local";
      readonly value: string;
    }
  | {
      readonly version: "filesystem-object-identity/2";
      readonly kind: "durable";
      /** 为连续性提供保证、且独立版本化的能力。 */
      readonly capability: CapabilityCoordinate;
      readonly value: string;
    };

/**
 * 可靠性声明刻意与单个不透明值分离。快照不能自行提升自己的 `durable` 声明；只有
 * 已配置的文件系统观察器可以选择加入，并在首次 I/O 前冻结能力坐标。
 */
export type FilesystemObjectIdentityContract =
  | { readonly kind: "snapshot-local" }
  | {
      readonly kind: "durable";
      readonly capability: CapabilityCoordinate;
    };

/**
 * 耐久的解析器结果，而不是领域或操作系统错误。存在诊断意味着快照覆盖不完整，因此
 * 不能据此推断未出现的位置已经消失。
 */
export type FilesystemObservationDiagnostic = {
  readonly relativePath: string;
  readonly kind:
    | "symbolic-link-not-followed"
    | "directory-link-not-allowed"
    | "link-target-outside-authorized-roots"
    | "broken-symbolic-link"
    | "inaccessible-symbolic-link"
    | "symbolic-link-cycle"
    | "repeated-directory-target"
    /** 目录项在枚举后消失；健康的同级项仍保持已观察。 */
    | "entry-missing"
    /** 隔离在单个目录项上的权限或运行时访问失败。 */
    | "entry-inaccessible"
    /** `lstat` 与打开操作不再指向同一对象，因此将其排除。 */
    | "entry-identity-changed";
};

/**
 * 文件系统包快照内的结构观察。根用 `.` 表示，使空包、唯一条目为空目录的包和缺失
 * 观察三者仍可区分。
 */
export type DirectoryObservation = {
  readonly relativePath: string;
  readonly modifiedAt: string;
};

export type FilesystemPackageSnapshot = {
  readonly id: string;
  readonly root: string;
  readonly complete: boolean;
  readonly files: readonly FileObservation[];
  /**
   * 在首批持久化快照之后加入。`undefined` 表示旧版仅文件记录，不证明其包中没有目录。
   */
  readonly directories?: readonly DirectoryObservation[];
  readonly excluded: readonly {
    readonly relativePath: string;
    readonly kind: "symbolic-link" | "special" | "unavailable";
  }[];
  readonly diagnostics?: readonly FilesystemObservationDiagnostic[];
  readonly observedAt: string;
};

export type AssetRefreshOutcome =
  | "unresolved"
  | "proposal"
  | "accepted"
  | "partially-succeeded"
  | "failed"
  /** 恢复过程无法安全继续冻结的执行。 */
  | "interrupted"
  /** 用户明确停止了工作流执行。 */
  | "cancelled"
  | "no-change";

/**
 * 元数据刷新刻意只携带当前有效来源关联允许刷新的事实。它不是另一次识别接受，因此
 * 绝不能顺带替换资产身份。
 */
export type MetadataRefreshSubmission = {
  readonly assetId: string;
  readonly sourceAssociation: SourceAssociation;
  readonly sourceRecords: readonly SourceRecord[];
  readonly interpretation: SourceInterpretationBatch;
  /** 在解释／应用前冻结；可以保留过期采集器，但它不能推进事实。 */
  readonly expectedLineageHeads: readonly {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
    readonly coverageId: string;
    readonly sourceRecordId?: string;
  }[];
};

/**
 * Application 把完整的已解释候选传入领域持有的来源刷新运行。SQLite 将候选与变更集
 * 一同保存，直到它被批准、拒绝、取消或条件追加。
 */
export type StageSourceRefreshChangeSetInput = {
  readonly runId: string;
  readonly candidateSourceRecordId: string;
  readonly interpretation: SourceInterpretationBatch;
  readonly requiresReview?: boolean;
};

export type CreateSourceRefreshRunInputForExecution = {
  readonly executionId: string;
  readonly run: CreateSourceRefreshRunInput;
};

/**
 * 把另一个既有来源附加到一个已接受主体的、与交付层无关的候选。它刻意不携带资产
 * 类别或来源语法；二者都由来源能力持有。
 */
export type SourceEnrichmentInput = {
  readonly subjectId: string;
  /** 其断言可为来源补充提供依据的已接受身份来源。 */
  readonly recognitionSourceAssociation: SourceAssociation;
  /** 随关联一同冻结，使身份替换同时使两个坐标失效。 */
  readonly recognitionDecisionId: string;
  readonly sourceAssociations: readonly SourceAssociation[];
  readonly metadata: readonly MetadataAssertion[];
  readonly metadataSourceRecords: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
  }[];
  readonly informationRequirement: InformationRequirement;
};

/** 把当前已接受事实解释为一个精确的补充来源候选。 */
export type SourceAssociationCandidateInterpreter = {
  readonly capability: CapabilityCoordinate;
  interpret(
    input: SourceEnrichmentInput,
  ): import("@digital/domain").RecognitionEvidence | undefined;
};

/**
 * 验证一份普通来源解释是否指向已经接受的主体；不执行采集或来源记录解释。
 */
export type SourceAssociationInterpreter = {
  readonly capability: CapabilityCoordinate;
  canInterpret(input: {
    readonly evidence: import("@digital/domain").RecognitionEvidence;
    readonly interpretation: SourceInterpretationBatch;
  }): boolean;
  interpret(input: {
    readonly subject: SourceEnrichmentInput;
    readonly evidence: import("@digital/domain").RecognitionEvidence;
    readonly interpretation: SourceInterpretationBatch;
  }):
    | { readonly status: "accepted"; readonly explanation: string }
    | { readonly status: "contradicted"; readonly explanation: string };
};

/** 主识别关联以及当前适用的所有来源。 */
export type AcceptedAssetState = AcceptedRecognition & {
  /** 旧存储在迁移前可能只公开识别关联。 */
  readonly sourceAssociations?: readonly SourceAssociation[];
  /**
   * 该明确主体的不透明产品策略登记。定义仍由组合层持有；持久化只保存耐久适用性。
   */
  readonly metadataPolicyIds?: readonly string[];
  /** 推导带来源标签值所需的当前来源记录。 */
  readonly metadataSourceRecords?: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
  }[];
};

/**
 * 唯一的跨位置复用坐标：由观察器声明的不透明文件系统对象身份，已经投影为确定性的
 * 产物 ID。
 *
 * 这里刻意不公开路径名、标题、Blob 摘要或数据库专用查询。存在多个当前资产属于相互
 * 矛盾的耐久证据，因此 Application 必须停止，不能任选其一。
 */
export type ObservedArtifactReuseMatch =
  | { readonly status: "none" }
  | {
      readonly status: "one";
      readonly accepted: AcceptedAssetState;
      readonly execution: WorkflowExecution;
    }
  | {
      readonly status: "ambiguous";
      readonly assetIds: readonly string[];
    };

export type AssetStateProjection = {
  readonly sourceAssociation: Pick<
    SourceAssociation,
    "sourceIdentity" | "nativeAddress"
  >;
  readonly metadata: readonly import("@digital/domain").MetadataAssertion[];
  readonly entities: readonly import("@digital/domain").SourcedEntity[];
  readonly entityMentions: readonly import("@digital/domain").EntityMention[];
  readonly entityResolutionDecisions: readonly import("@digital/domain").EntityResolutionDecision[];
  readonly relationships: readonly import("@digital/domain").EntityRelationship[];
  readonly artifacts: readonly Artifact[];
  readonly locations: readonly Location[];
  readonly blobs: readonly Blob[];
  readonly artifactRevisions: readonly import("@digital/domain").ArtifactRevision[];
  readonly artifactAssociations: readonly ArtifactAssociation[];
  readonly primaryCoverArtifactId?: string;
};

export type ChangeImpactPreview = {
  readonly id: string;
  readonly executionId: string;
  readonly assetId: string;
  readonly proposal: RecognitionProposal;
  /** 应用确认时仍必须成立的每个值。 */
  readonly baselines: readonly {
    readonly key: string;
    readonly value: string;
  }[];
  /** 冻结基线上的完整已应用状态。 */
  readonly current: AssetStateProjection;
  /** 变更后由同一应用投影推导的完整状态。 */
  readonly projected: AssetStateProjection;
  readonly blockingConditions: readonly string[];
  readonly status: "awaiting-confirmation" | "rejected" | "applied" | "stale";
};

/** 安全的交付 DTO；原始提议和条件基线保留在内部。 */
export type ChangeImpactPreviewInspection = {
  readonly id: string;
  readonly executionId: string;
  readonly assetId: string;
  readonly status: ChangeImpactPreview["status"];
  readonly sourceAssociation: ChangeImpactPreview["projected"]["sourceAssociation"];
  readonly current: AssetStateProjection;
  readonly projected: AssetStateProjection;
  readonly metadataCount: number;
  readonly entityCount: number;
  readonly mentionCount: number;
  readonly resolutionCount: number;
  readonly relationshipCount: number;
  readonly artifactCount: number;
  readonly primaryCoverArtifactId?: string;
  readonly blockingConditions: readonly string[];
};

/** 耐久的重复执行配置；执行状态属于工作流执行。 */
export type AutomationDisabledReason =
  | "observed-root-revoked"
  /** 实时文件系统绑定失败；由操作方修复后重新启用。 */
  | "observed-root-unavailable"
  /** 某项能力报告操作前置条件不可用。 */
  | "prerequisite-unavailable"
  | "invalid-configuration";

/**
 * 写入一次耐久自动化意图所需的瞬时授权证据。它刻意只包含注册版本：自动化意图和
 * 它的持久化适配器都不会收到文件系统路径或已绑定文件系统能力。
 */
/** @deprecated 新 Application 适配器应使用由权威持有的名称。 */
export type AutomationObservedRootAuthorization =
  ObservedRootAutomationAuthorization;

export type AutomationIntentCreationResult =
  | { readonly status: "created" }
  | { readonly status: "root-unavailable" };

export type AutomationIntent = {
  readonly id: string;
  readonly scope: ObservedRootAutomationScope;
  readonly enabled: boolean;
  /**
   * 仅在产品持有的前置条件停用该意图时存在。它刻意记录稳定原因而非基础设施错误消息，
   * 使后续交付界面无需检查观察根或数据库行也能解释状态。
   */
  readonly disabledReason?: AutomationDisabledReason;
  readonly intervalMilliseconds: number;
  readonly workflowInputVersion: "asset-refresh-input/1";
  /** 固定启用策略，而不是宿主生命周期指令。 */
  readonly runInitial: boolean;
  readonly policyReferences: readonly string[];
  readonly acceptTrusted: boolean;
};

export type AutomationTrigger = "initial" | "interval" | "scan-now";

/** 一次执行的不可变发起路径。 */
export type WorkflowExecutionTrigger =
  | AutomationTrigger
  | "interactive"
  | "information-fulfillment";

/** 只在读取输入封装机制引入前的执行行时保留的值。 */
export type LegacyWorkflowExecutionTrigger =
  | WorkflowExecutionTrigger
  | "manual"
  | "directed-recognition"
  | "metadata-refresh";

/**
 * 安全重放一次资产刷新所需的小型非秘密输入封装；刻意不把它扩展为通用工作流定义。
 */
export type AssetRefreshWorkflowInput = {
  readonly version: "asset-refresh-input/1";
  readonly trigger: WorkflowExecutionTrigger;
  readonly initiatedBy: string;
  readonly acceptTrusted: boolean;
  readonly configurationReferences: readonly string[];
  readonly observedRoots?: readonly ObservedRootSnapshot[];
  readonly operation?: {
    readonly version: "information-fulfillment-operation/1";
    readonly kind: InformationFulfillmentPlan["operation"];
    readonly subjectId: string;
    readonly sourceIdentity: string;
    readonly sourceAssociationId?: string;
  };
};

export type InvalidAssetRefreshWorkflowInput = {
  /**
   * 原始、不可执行的耐久输入，只为检查和明确的中断审计保留。兼容性读取器可以对无法
   * 安全重放的旧选择复用同一个已净化屏障。
   */
  readonly raw: string;
  readonly reason: string;
};

export type AssetRefreshWorkflowInputDecodeResult =
  | { readonly valid: true; readonly input: AssetRefreshWorkflowInput }
  | { readonly valid: false; readonly reason: string };

function isWorkflowExecutionTrigger(
  value: unknown,
): value is WorkflowExecutionTrigger {
  return (
    value === "interactive" ||
    value === "initial" ||
    value === "interval" ||
    value === "scan-now" ||
    value === "information-fulfillment"
  );
}

/**
 * 对小型持久化重启封装执行运行时验证。SQLite 读取器和 Application 恢复共用该验证；
 * 仅靠 TypeScript 类型绝不能使耐久 JSON 达到安全重放条件。
 */
export function decodeAssetRefreshWorkflowInput(
  value: unknown,
): AssetRefreshWorkflowInputDecodeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { valid: false, reason: "刷新版本化输入必须是对象" };
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "trigger",
    "initiatedBy",
    "acceptTrusted",
    "configurationReferences",
    "observedRoots",
    "operation",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    return { valid: false, reason: "刷新版本化输入包含不支持的字段" };
  if (input.version !== "asset-refresh-input/1")
    return { valid: false, reason: "刷新版本化输入版本不受支持" };
  if (!isWorkflowExecutionTrigger(input.trigger))
    return { valid: false, reason: "刷新版本化输入触发方式无效" };
  if (
    typeof input.initiatedBy !== "string" ||
    input.initiatedBy.trim().length === 0
  )
    return { valid: false, reason: "刷新版本化输入缺少发起者" };
  if (typeof input.acceptTrusted !== "boolean")
    return { valid: false, reason: "刷新版本化输入缺少可信规则策略" };
  if (
    !Array.isArray(input.configurationReferences) ||
    !input.configurationReferences.every(
      (reference) =>
        typeof reference === "string" && reference.trim().length > 0,
    ) ||
    new Set(input.configurationReferences).size !==
      input.configurationReferences.length
  )
    return { valid: false, reason: "刷新版本化输入配置引用无效" };
  let operation: AssetRefreshWorkflowInput["operation"];
  let observedRoots: readonly ObservedRootSnapshot[] | undefined;
  if (input.observedRoots !== undefined) {
    if (!Array.isArray(input.observedRoots)) {
      return { valid: false, reason: "刷新版本化输入文件位置快照无效" };
    }
    const decodedRoots = input.observedRoots.map(decodeObservedRootSnapshot);
    if (
      decodedRoots.some((root) => !root.valid) ||
      new Set(
        decodedRoots.map((root) => (root.valid ? root.value.id : undefined)),
      ).size !== decodedRoots.length
    ) {
      return { valid: false, reason: "刷新版本化输入文件位置快照无效" };
    }
    observedRoots = decodedRoots.map((root) => {
      if (!root.valid) throw new Error("unreachable");
      return root.value;
    });
  }
  if (input.operation !== undefined) {
    if (
      typeof input.operation !== "object" ||
      input.operation === null ||
      Array.isArray(input.operation)
    )
      return { valid: false, reason: "信息履行操作输入必须是对象" };
    const candidate = input.operation as Record<string, unknown>;
    const operationAllowed = new Set([
      "version",
      "kind",
      "subjectId",
      "sourceIdentity",
      "sourceAssociationId",
    ]);
    if (
      Object.keys(candidate).some((key) => !operationAllowed.has(key)) ||
      candidate.version !== "information-fulfillment-operation/1" ||
      (candidate.kind !== "source-refresh" &&
        candidate.kind !== "source-artifact-acquisition") ||
      typeof candidate.subjectId !== "string" ||
      candidate.subjectId.length === 0 ||
      typeof candidate.sourceIdentity !== "string" ||
      candidate.sourceIdentity.length === 0 ||
      (candidate.sourceAssociationId !== undefined &&
        (typeof candidate.sourceAssociationId !== "string" ||
          candidate.sourceAssociationId.length === 0))
    )
      return { valid: false, reason: "信息履行操作输入无效" };
    operation = candidate as AssetRefreshWorkflowInput["operation"];
  }
  if (
    (input.trigger === "information-fulfillment") !==
    (operation !== undefined)
  )
    return { valid: false, reason: "信息履行触发与操作输入不一致" };
  return {
    valid: true,
    input: {
      version: "asset-refresh-input/1",
      trigger: input.trigger,
      initiatedBy: input.initiatedBy,
      acceptTrusted: input.acceptTrusted,
      configurationReferences: input.configurationReferences,
      ...(observedRoots === undefined ? {} : { observedRoots }),
      ...(operation === undefined ? {} : { operation }),
    },
  };
}

export type AutomationTriggerResult =
  | { readonly status: "started"; readonly execution: AssetRefreshInspection }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "disabled"; readonly reason: string };

export type ExecutionStartDisposition = "started" | "skipped" | "disabled";

export type OrdinaryScanReusePlan = {
  /** 相互独立的能力工作项，而不是通用资产缓存键。 */
  readonly workItems: readonly {
    readonly key: string;
    readonly domainBaseline: string;
    readonly sourceBaseline: string;
    readonly informationBaseline: string;
    readonly managedArtifactBaseline?: string;
  }[];
};

export type WorkflowCompatibility = {
  readonly workflowVersion: "asset-refresh/2";
  readonly policyVersion: string;
  readonly capabilityCoordinates: readonly string[];
};

/**
 * 由 Application 持有的判定：一次工作流执行中冻结的不透明、非秘密配置引用是否仍可
 * 用于恢复该执行。具体配置登记表位于组合边界。
 */
export type WorkflowConfigurationCompatibility = {
  checkCompatibility(input: {
    readonly references: readonly string[];
  }): Promise<
    | { readonly compatible: true }
    | { readonly compatible: false; readonly reason: string }
  >;
};

/**
 * 仅当已完成执行实际冻结的每项能力仍在同一坐标可用时，才能复用该执行。额外配置的
 * 能力刻意与此无关：它们没有参与先前执行，因此不能使其失效。
 */
export function workflowCompatibilityCanReuse(
  frozen: WorkflowCompatibility,
  available: WorkflowCompatibility,
): boolean {
  return (
    frozen.workflowVersion === available.workflowVersion &&
    frozen.policyVersion === available.policyVersion &&
    frozen.capabilityCoordinates.length > 0 &&
    frozen.capabilityCoordinates.every((coordinate) =>
      available.capabilityCoordinates.includes(coordinate),
    )
  );
}

export type WorkItemDisposition = {
  readonly key: string;
  readonly status:
    | "running"
    | "completed"
    | "failed"
    | "skipped"
    | "reused"
    | "no-change";
  readonly reason?: string;
  /** 由 Application 持有、且平台中立的操作失败分类。 */
  readonly failureClassification?: OperationalFailureClassification;
  readonly effectReference?: string;
};

export type AssetRefreshTargetDisposition = {
  readonly key: string;
  readonly target:
    | { readonly kind: "subject"; readonly subjectId: string }
    | { readonly kind: "filesystem-scope"; readonly root: string };
  readonly status:
    | "running"
    | "completed"
    | "reused"
    | "skipped"
    | "blocked"
    | "failed"
    | "no-change";
  readonly reason?: string;
  readonly sourceRecordIds?: readonly string[];
  readonly outputReferences?: readonly string[];
};

export type AssetRefreshTarget = {
  readonly subjectId: string;
  readonly filesystemScope: {
    readonly observedRootId: string;
    readonly relativeScope: string;
  };
  readonly sourceAssociation: AcceptedRecognition["sourceAssociation"];
};

export type MetadataRefreshInput = {
  readonly selection: AssetRefreshSelection;
  readonly informationRequirement?: InformationRequirement;
  /** 来源刷新运行的审计主体；集成可以提供用户身份。 */
  readonly initiatedBy?: string;
  /** 自动运行和审阅门控运行使用同一条耐久变更集路径。 */
  readonly reviewPolicy?: "automatic" | "review";
  readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
  readonly onProgress?: (message: string) => void;
  readonly onCheckpoint?: (execution: WorkflowExecution) => void;
  /** 进程持有者生命周期；绝不作为工作流输入持久化。 */
  readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
};

/**
 * 仅供内部使用的子元数据执行发起上下文。持久化工作流输入仍是恢复权威；该上下文只在
 * 创建子执行时使用。
 */
type MetadataRefreshInitiation = {
  readonly version: "metadata-refresh-initiation/1";
  readonly trigger: "information-fulfillment";
  readonly initiatedBy: string;
  readonly operation: NonNullable<AssetRefreshWorkflowInput["operation"]>;
};

function metadataRefreshInitiationForInformationFulfillment(
  plan: InformationFulfillmentPlan,
  initiation: InformationFulfillmentInitiation | undefined,
): MetadataRefreshInitiation {
  return {
    version: "metadata-refresh-initiation/1",
    trigger: "information-fulfillment",
    initiatedBy:
      initiation === undefined
        ? "information-fulfillment"
        : `information-fulfillment:${initiation.parentExecutionId}:${plan.subjectId}`,
    operation: {
      version: "information-fulfillment-operation/1",
      kind: plan.operation,
      subjectId: plan.subjectId,
      sourceIdentity: plan.sourceIdentity,
      ...(plan.sourceAssociationId === undefined
        ? {}
        : { sourceAssociationId: plan.sourceAssociationId }),
    },
  };
}

/** 一个独立规划识别边界的耐久审计状态。 */
export type AssetRefreshWorkItem = {
  readonly key: string;
  readonly relativePaths: readonly string[];
  /** 即使明确的包包含多个文件，它仍是一个产物。 */
  readonly observedArtifactBoundary?: "filesystem-package";
  /** 作出技术边界决策的能力；不是领域事实。 */
  readonly observedArtifactBoundaryProducer?: CapabilityCoordinate;
  readonly planningEvidence?: readonly import("@digital/domain").RecognitionEvidence[];
  readonly reuseFingerprint?: string;
  /** 该边界的实际能力坐标，绝不是完整配置。 */
  readonly reuseCompatibility?: WorkflowCompatibility;
  readonly sourceRecordIds: readonly string[];
  readonly proposalId?: string;
  readonly acceptedAssetId?: string;
  readonly outcome?: AssetRefreshOutcome;
  readonly reason?: string;
  /** 由 Application 持有、且平台中立的操作失败分类。 */
  readonly failureClassification?: OperationalFailureClassification;
  readonly sourceArtifactAcquisitions?: readonly SourceArtifactAcquisitionCheckpoint[];
  readonly managedSourceArtifacts?: readonly ManagedSourceArtifactCheckpoint[];
};

export type InformationRequirement = {
  readonly metadataUsageContext: string;
  readonly metadata: readonly {
    readonly property: string;
    readonly necessity: "required" | "optional";
  }[];
  readonly artifactRoles: readonly {
    readonly role: string;
    readonly necessity: "required" | "optional";
    readonly maximum?: number;
  }[];
  readonly relationshipTypes: readonly {
    readonly type: string;
    readonly necessity: "required" | "optional";
  }[];
};

/**
 * 一个已部署窄能力的静态 Application 权威身份。
 *
 * `kind` 刻意保持为开放且稳定的字符串：Application 持有端口契约，但 Application
 * 与数字资产都不维护提供方或能力种类枚举。
 */
export type CapabilityDeclaration = {
  readonly identity: string;
  readonly implementationVersion: string;
  readonly kind: string;
  /** 只有该能力不适用任何解释契约时才为空。 */
  readonly interpretationContractVersions: readonly string[];
};

/**
 * 具体能力连同完整静态声明一起产生的来源坐标。附加字段在结构化作为领域
 * `CapabilityCoordinate` 使用时仍会保留，使派生事实保留生成它们的声明，同时不在
 * 领域中引入 Application 依赖。
 */
export type DeclaredCapability = CapabilityCoordinate & CapabilityDeclaration;

/**
 * 在一个不可变值中同时保留旧坐标拼写和声明术语。它是值构造器，不是插件接口。
 */
export function declareCapability(input: {
  readonly identity: string;
  readonly implementationVersion: string;
  readonly kind: string;
  readonly contractVersion: string;
  readonly interpretationContractVersions: readonly string[];
}): DeclaredCapability {
  return {
    capabilityId: input.identity,
    capabilityVersion: input.implementationVersion,
    contractVersion: input.contractVersion,
    identity: input.identity,
    implementationVersion: input.implementationVersion,
    kind: input.kind,
    interpretationContractVersions: input.interpretationContractVersions,
  };
}

export const directedRecognitionEvidenceCapability = declareCapability({
  identity: "application.directed-recognition",
  implementationVersion: "1",
  kind: "directed-recognition-evidence",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

export const knownSourceAssociationEvidenceCapability = declareCapability({
  identity: "application.known-source-association",
  implementationVersion: "1",
  kind: "known-source-association-evidence",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

/**
 * Application 持有的证据生产者同样是已部署能力；其静态值与集成实例一样参与组合验证。
 */
export const applicationOwnedCapabilityDeclarations = [
  directedRecognitionEvidenceCapability,
  knownSourceAssociationEvidenceCapability,
] as const;

export const emptyInformationRequirement: InformationRequirement = {
  metadataUsageContext: "asset.ordinary",
  metadata: [],
  artifactRoles: [],
  relationshipTypes: [],
};

/**
 * Application 持有通过端口提交的执行审计形状。这是带入条件识别接受的精确最后持久化
 * 快照；刻意不提供基础设施回读。
 */
function persistedWorkflowExecution(
  execution: WorkflowExecution,
): WorkflowExecution {
  const { workItems, ...withoutWorkItems } = execution;
  return {
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
    ...(workItems === undefined || workItems.length === 0 ? {} : { workItems }),
  };
}

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

/**
 * 一次已接受识别后来源补充的完整耐久意图。恢复过程直接消费该检查点，绝不会通过
 * 重新运行识别或来源解释来重建它。
 */
type SourceEnrichmentCheckpointBase = {
  readonly key: string;
  readonly subjectId: string;
  /** 在采集前冻结，使恢复过程无需重新发现该意图。 */
  readonly subject: SourceEnrichmentInput;
  readonly evidence: RecognitionEvidence;
  readonly fulfilledArtifactRoles: readonly {
    readonly role: string;
    readonly count: number;
  }[];
  readonly metadataPolicyIds: readonly string[];
};

type InterpretedSourceEnrichmentCheckpoint = SourceEnrichmentCheckpointBase & {
  readonly stage:
    | "association-interpreted"
    | "source-artifact-acquired"
    | "source-artifact-stored"
    | "applied";
  readonly sourceAssociation: SourceAssociation;
  readonly interpretation: SourceInterpretationBatch;
  readonly sourceRecordIds: readonly string[];
  readonly sourceArtifacts: readonly SourceArtifactCandidate[];
  readonly sourceArtifactAcquisitions?: readonly SourceArtifactAcquisitionCheckpoint[];
  readonly managedSourceArtifacts?: readonly ManagedSourceArtifactCheckpoint[];
};

type CandidateSourceEnrichmentCheckpoint = SourceEnrichmentCheckpointBase & {
  readonly stage: "candidate-interpreted";
};

type RetainedSourceEnrichmentCheckpoint = SourceEnrichmentCheckpointBase & {
  readonly stage: "source-records-retained";
  readonly sourceRecordIds: readonly string[];
  readonly collectionFailures: readonly SourceCollectionFailure[];
};

export type SourceEnrichmentCheckpoint =
  | CandidateSourceEnrichmentCheckpoint
  | RetainedSourceEnrichmentCheckpoint
  | (SourceEnrichmentCheckpointBase & {
      readonly stage: "failed";
      readonly sourceRecordIds: readonly string[];
      readonly collectionFailures: readonly SourceCollectionFailure[];
    })
  | InterpretedSourceEnrichmentCheckpoint;

type ManagedObservedArtifactPart = {
  readonly candidate: ObservedArtifactPartCandidate;
  /** 实际观察部分获取器，在物化效果前冻结。 */
  readonly producer: CapabilityCoordinate;
  readonly blob: Blob;
  readonly location: { readonly address: string };
  readonly origin: Blob;
};

/** 首个切片持久化的列名保留为基础设施兼容性细节。 */
export type CoverAcquisitionCheckpoint = SourceArtifactAcquisitionCheckpoint;
export type ManagedCoverCheckpoint = ManagedSourceArtifactCheckpoint;

/** 明确取消一次工作流执行的耐久归因。 */
export type WorkflowExecutionCancellation = {
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly reason?: string;
};

export type WorkflowExecution = {
  readonly id: string;
  /** 仅旧行可能缺失；这类行不能安全恢复。 */
  readonly workflowInput?: AssetRefreshWorkflowInput;
  /** 不可执行的持久化重放坐标仍可查询，只为使恢复过程能够停止它。 */
  readonly workflowInputInvalid?: InvalidAssetRefreshWorkflowInput;
  readonly selection: {
    /** 旧版单范围输入；精确主体执行中不存在。 */
    readonly directory?: string;
    readonly intent?: "scan-now" | "metadata-refresh" | "directed-recognition";
    readonly informationRequirement?: InformationRequirement;
  };
  /** 旧版单范围观察；仅主体执行中不存在。 */
  readonly snapshot?: FilesystemPackageSnapshot;
  readonly operationKind?: "scan-filesystem" | "refresh-metadata" | "rescrape";
  readonly requestedSelection?: AssetRefreshSelection;
  readonly resolvedSelection?: ResolvedAssetRefreshSelection;
  readonly filesystemSnapshots?: readonly FilesystemPackageSnapshot[];
  readonly targetDispositions?: readonly AssetRefreshTargetDisposition[];
  readonly status: "running" | "completed" | "failed";
  readonly stage:
    | "recognition"
    | "source-records-retained"
    | "source-artifacts-acquired"
    | "source-artifacts-stored"
    /** 为兼容恢复保留的旧版持久化阶段名。 */
    | "cover-acquired"
    | "cover-stored"
    | "completed"
    | "failed";
  readonly outcome?: AssetRefreshOutcome;
  readonly sourceRecordIds: readonly string[];
  /** 只保留领域过程引用；其阶段、审阅和结果仍属于数字资产。 */
  readonly sourceRefreshRunIds?: readonly string[];
  readonly proposalId?: string;
  readonly acceptedAssetId?: string;
  readonly reason?: string;
  /** 仅在行为主体明确终态取消本次执行时存在。 */
  readonly cancellation?: WorkflowExecutionCancellation;
  readonly reusePlan?: OrdinaryScanReusePlan;
  readonly reusedExecutionId?: string;
  readonly compatibility: WorkflowCompatibility;
  readonly dispositions: readonly WorkItemDisposition[];
  /** 明确的工作项审计；旧执行仍填充旧版单项列。 */
  readonly workItems?: readonly AssetRefreshWorkItem[];
  readonly coverAcquisition?: CoverAcquisitionCheckpoint;
  readonly managedCover?: ManagedCoverCheckpoint;
  readonly sourceArtifactAcquisitions?: readonly SourceArtifactAcquisitionCheckpoint[];
  readonly managedSourceArtifacts?: readonly ManagedSourceArtifactCheckpoint[];
  readonly sourceEnrichments?: readonly SourceEnrichmentCheckpoint[];
  readonly automationIntentId?: string;
  /** 仅供旧版使用的触发列；新执行使用 `workflowInput.trigger`。 */
  readonly trigger?: string;
};

export type ExecutionInspection = {
  readonly execution: WorkflowExecution;
  readonly sourceRecords: readonly SourceRecord[];
  /** 可重建的领域投影；工作流执行只持有其身份。 */
  readonly sourceRefreshRuns?: readonly SourceRefreshRun[];
  readonly proposal?: RecognitionProposal;
  readonly accepted?: AcceptedAssetState;
  readonly workItemInspections?: readonly {
    readonly workItem: AssetRefreshWorkItem;
    readonly proposal?: RecognitionProposal;
    readonly accepted?: AcceptedAssetState;
  }[];
};

/**
 * 未识别文件系统观察的紧凑、交付层无关审计视图。它不保留任何媒体解释，直接从耐久
 * 文件系统包快照派生。
 */
export type UnresolvedObservation = {
  readonly observedRoot: string;
  readonly fileCount: number;
  readonly totalSize: number;
  readonly representativePaths: readonly string[];
};

function unresolvedObservation(
  snapshot: FilesystemPackageSnapshot,
): UnresolvedObservation {
  let totalSize = 0;
  for (const file of snapshot.files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0)
      throw new Error("Filesystem observation has an unsafe file size");
    totalSize += file.size;
    if (!Number.isSafeInteger(totalSize))
      throw new Error("Filesystem observation total size exceeds safe range");
  }
  return {
    observedRoot: snapshot.root,
    fileCount: snapshot.files.length,
    totalSize,
    representativePaths: snapshot.files
      .map((file) => file.relativePath)
      .slice(0, 8),
  };
}

/** 所有普通 CLI／Web 检查共用、由 Application 持有的 DTO。 */
export type AssetRefreshInspection = {
  readonly execution: Omit<
    WorkflowExecution,
    | "coverAcquisition"
    | "managedCover"
    | "sourceArtifactAcquisitions"
    | "managedSourceArtifacts"
    | "sourceEnrichments"
    | "reusePlan"
    | "compatibility"
    | "proposalId"
    | "dispositions"
    | "workItems"
  > & {
    readonly dispositions: readonly Omit<
      WorkItemDisposition,
      "effectReference"
    >[];
    readonly workItems?: readonly Omit<
      AssetRefreshWorkItem,
      | "planningEvidence"
      | "reuseFingerprint"
      | "observedArtifactBoundaryProducer"
      | "sourceArtifactAcquisitions"
      | "managedSourceArtifacts"
    >[];
  };
  readonly sourceRecords: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
    readonly coverage: SourceRecord["coverage"];
    readonly acquiredAt: string;
    readonly digest: string;
  }[];
  /** 为普通刷新检查投影的领域权威状态。 */
  readonly sourceRefreshRuns?: readonly SourceRefreshRun[];
  /** 仅在本次执行没有已提议或已接受身份时存在。 */
  readonly unresolvedObservation?: UnresolvedObservation;
  readonly recognition?: {
    readonly explanation: string;
    readonly status: "proposed" | "accepted";
  };
  readonly accepted?: Omit<
    AcceptedRecognition,
    "proposal" | "recognitionDecision" | "sourceAssociation"
  > & {
    readonly sourceAssociation: {
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
    };
    /** 当前关联可以有多个；`sourceAssociation` 仍表示识别来源。 */
    readonly sourceAssociations?: readonly {
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
    }[];
    readonly effectiveMetadata: readonly EffectiveMetadata[];
    readonly metadataPolicyConflicts: readonly MetadataPolicyConflict[];
    readonly recognitionExplanation: string;
  };
  /** 多边界执行中可独立检查的结果。 */
  readonly itemResults?: readonly {
    readonly key: string;
    readonly relativePaths: readonly string[];
    readonly outcome?: AssetRefreshOutcome;
    readonly reason?: string;
    readonly recognition?: {
      readonly explanation: string;
      readonly status: "proposed" | "accepted";
    };
    readonly accepted?: AssetRefreshInspection["accepted"];
  }[];
  readonly changeImpactPreview?: ChangeImpactPreviewInspection;
};

export type DirectoryInterpreter = {
  readonly capability: CapabilityCoordinate;
  interpret(
    snapshot: FilesystemPackageSnapshot,
  ):
    | readonly import("@digital/domain").RecognitionEvidence[]
    | AssetRefreshWorkPlan;
};

/**
 * 技术解析器可以把选定文件系统包识别为服务于定向资产的一个观察产物；它绝不建立
 * 身份或提供方专用目录约定。
 */
export type FilesystemPackageInterpreter = {
  readonly capability: CapabilityCoordinate;
  interpretPackage(
    snapshot: FilesystemPackageSnapshot,
  ): { readonly observedArtifactBoundary: "filesystem-package" } | undefined;
};

/**
 * 格式能力检查产物，可选包边界则由目录解释器持有。保持这些端口分离，可防止来源
 * 提供方了解归档语法，并允许 CBZ／ID3 后续遵循同一契约。
 */
export type ArtifactFormatInspector = {
  readonly capability: CapabilityCoordinate;
  inspect(input: {
    /** 不透明观察器引用；Application 绝不解释其语法。 */
    readonly observedArtifactReference: string;
    /** 已经打开的字节；检查器绝不会收到观察路径名。 */
    readonly byteSource: ObservedByteSource;
  }):
    | readonly import("@digital/domain").RecognitionEvidence[]
    | Promise<readonly import("@digital/domain").RecognitionEvidence[]>;
};

/**
 * 一个冻结选择内可独立提交的明确边界。普通证据数组仍构成一个边界：它可以表示竞争
 * 身份，且绝不会被隐式拆分。
 */
export type AssetRefreshWorkPlan = {
  readonly workItems: readonly AssetRefreshWorkItemPlan[];
};

export type AssetRefreshWorkItemPlan = {
  /** 插件持有的稳定键；Application 绝不解释其语法。 */
  readonly key: string;
  readonly relativePaths: readonly string[];
  /** 通用打包指令；作出决策的外层能力持有其语法。 */
  readonly observedArtifactBoundary?: "filesystem-package";
  /** Application 附加的已部署技术解释器来源信息。 */
  readonly observedArtifactBoundaryProducer?: CapabilityCoordinate;
  readonly evidence: readonly import("@digital/domain").RecognitionEvidence[];
};

/** 一个可修复前置条件当前不可用；适配器绝不在此命名平台。 */
export type OperationalFailureClassification = {
  readonly kind: "prerequisite-unavailable";
};

export const prerequisiteUnavailableFailure = {
  kind: "prerequisite-unavailable",
} as const satisfies OperationalFailureClassification;

export type SourceCollectionFailure = {
  readonly capability: CapabilityCoordinate;
  readonly reason: string;
  /** 类型化操作分类；绝不从诊断字符串推断。 */
  readonly failureClassification?: OperationalFailureClassification;
  /**
   * 本次响应未能获取的可选精确来源刷新覆盖。它影响耐久运行前，协调器会根据采集器声明
   * 的范围进行验证。
   */
  readonly coverage?: SourceCoverageScope;
  /**
   * 本次响应使其不可用的中立信息。由 Application 而非提供方根据当前信息需求决定失败
   * 是否阻塞。省略该字段会保留既有原子契约语义并阻塞识别。
   */
  readonly affects?: {
    readonly recognition?: boolean;
    readonly metadataProperties?: readonly string[];
    readonly artifactRoles?: readonly string[];
    readonly relationshipTypes?: readonly string[];
  };
};

export type SourceCollectionResult = {
  readonly records: readonly SourceRecord[];
  readonly failures: readonly SourceCollectionFailure[];
};

/**
 * 为一次采集器调用冻结的非秘密配置坐标。采集器只能通过能力专用私有句柄使用它们；
 * Application 和工作流执行都不携带凭据。
 */
export type SourceCollectionExecutionContext = {
  readonly configurationReferences: readonly string[];
};

/**
 * Application 要求这个窄外层端口只绑定即将实际参与的采集器。这样既能把无关来源连接
 * 排除在执行的可复现封装外，又允许持有能力从不透明版本引用解析自己的私密秘密。
 */
export type SourceConnectionExecutionConfiguration = {
  bindCollector(input: {
    readonly collector: CapabilityCoordinate;
    /**
     * 正在绑定的采集器调用所用不透明识别证据。Application 不解释它；外层适配器可以
     * 用它选择能力范围内的私密连接，同时不把提供方规则泄漏进工作流核心。
     */
    readonly evidence: RecognitionEvidence;
    readonly configurationReferences: readonly string[];
  }): Promise<{
    readonly configurationReferences: readonly string[];
  }>;
};

export type SourceCollector = {
  readonly capability: CapabilityCoordinate;
  canCollect(evidence: import("@digital/domain").RecognitionEvidence): boolean;
  /**
   * 声明一次采集尝试可以推进的精确 lineage 范围。在传输前求值，使并发响应不能变基。
   */
  coverageScopeIds?(
    evidence: import("@digital/domain").RecognitionEvidence,
  ): readonly string[];
  /**
   * 可选的执行内请求范围。它不同于覆盖 lineage，表示相同规划边界可以共享一次获取结果。
   */
  collectionScopeIds?(
    evidence: import("@digital/domain").RecognitionEvidence,
  ): readonly string[];
  /**
   * 可选地为一个已声明执行范围中的所有证据执行一次获取。该操作仍由采集器持有，并
   * 返回普通且各自有界的来源记录。
   */
  collectShared?(
    evidence: readonly import("@digital/domain").RecognitionEvidence[],
    context?: SourceCollectionExecutionContext,
  ): Promise<SourceCollectionResult>;
  collect(
    evidence: import("@digital/domain").RecognitionEvidence,
    context?: SourceCollectionExecutionContext,
  ): Promise<SourceCollectionResult>;
};

export type SourceInterpreter = {
  readonly capability: CapabilityCoordinate;
  canInterpret(input: {
    readonly evidence: readonly import("@digital/domain").RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): boolean;
  interpret(input: {
    readonly evidence: readonly import("@digital/domain").RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): SourceInterpretationBatch;
};

export type Recognizer = {
  readonly capability: CapabilityCoordinate;
  canRecognize(input: SourceInterpretationBatch): boolean;
  recognize(input: {
    readonly evidence: readonly import("@digital/domain").RecognitionEvidence[];
    readonly interpretation: SourceInterpretationBatch;
  }): RecognitionProposalDraft;
};

export type RecognitionPolicy = {
  readonly version?: string;
  readonly trustedRuleCoordinates?: readonly string[];
  accepts(result: RecognitionRuleResult): boolean;
};

export type SourceArtifactAcquirer = {
  readonly capability: CapabilityCoordinate;
  canAcquire(candidate: SourceArtifactCandidate): boolean;
  acquire(candidate: SourceArtifactCandidate): Promise<StagedSourceArtifact>;
};

/**
 * 端口持有实际生成事实的实现。它不能允许响应替换为相邻能力的坐标，否则保留的来源
 * 会描述一个从未运行的实现。
 *
 * 语义声明字段刻意保留在端口坐标上，但比较从耐久旧版三元组开始，使旧事实仍可读取。
 */
function actualProducer(
  reported: CapabilityCoordinate | undefined,
  actual: CapabilityCoordinate,
  fact: string,
): CapabilityCoordinate {
  if (reported === undefined) return actual;
  if (
    reported.capabilityId !== actual.capabilityId ||
    reported.capabilityVersion !== actual.capabilityVersion ||
    reported.contractVersion !== actual.contractVersion ||
    (reported.identity !== undefined &&
      reported.identity !== actual.identity) ||
    (reported.implementationVersion !== undefined &&
      reported.implementationVersion !== actual.implementationVersion) ||
    (reported.kind !== undefined && reported.kind !== actual.kind) ||
    (reported.interpretationContractVersions !== undefined &&
      JSON.stringify(reported.interpretationContractVersions) !==
        JSON.stringify(actual.interpretationContractVersions))
  ) {
    throw new Error(`${fact} producer does not match the executing capability`);
  }
  return actual;
}

/**
 * 证据是刚执行的端口生成的不可变事实，不是适配器对相邻能力作出的声明。该规则刻意
 * 留在三个证据生产端口边界，而不引入通用能力结果流水线。
 */
function bindRecognitionEvidenceToProducer(
  evidence: RecognitionEvidence,
  producer: CapabilityCoordinate,
): RecognitionEvidence {
  return {
    ...evidence,
    producer: actualProducer(
      evidence.producer,
      producer,
      "Recognition Evidence",
    ),
  };
}

function bindRecognitionEvidenceOutputToProducer(
  output: readonly RecognitionEvidence[],
  producer: CapabilityCoordinate,
): readonly RecognitionEvidence[];
function bindRecognitionEvidenceOutputToProducer(
  output: AssetRefreshWorkPlan,
  producer: CapabilityCoordinate,
): AssetRefreshWorkPlan;
function bindRecognitionEvidenceOutputToProducer(
  output: readonly RecognitionEvidence[] | AssetRefreshWorkPlan,
  producer: CapabilityCoordinate,
): readonly RecognitionEvidence[] | AssetRefreshWorkPlan;
function bindRecognitionEvidenceOutputToProducer(
  output: readonly RecognitionEvidence[] | AssetRefreshWorkPlan,
  producer: CapabilityCoordinate,
): readonly RecognitionEvidence[] | AssetRefreshWorkPlan {
  if (!isAssetRefreshWorkPlan(output)) {
    return output.map((evidence) =>
      bindRecognitionEvidenceToProducer(evidence, producer),
    );
  }
  return {
    ...output,
    workItems: output.workItems.map((item) => ({
      ...item,
      ...(item.observedArtifactBoundaryProducer === undefined
        ? {}
        : {
            observedArtifactBoundaryProducer: actualProducer(
              item.observedArtifactBoundaryProducer,
              producer,
              "Filesystem-package boundary",
            ),
          }),
      evidence: item.evidence.map((evidence) =>
        bindRecognitionEvidenceToProducer(evidence, producer),
      ),
    })),
  };
}

function retainCollectedRecordProvenance(
  collector: Pick<SourceCollector, "capability">,
  collection: SourceCollectionResult,
): SourceCollectionResult {
  return {
    ...collection,
    records: collection.records.map((record) => ({
      ...record,
      producer: actualProducer(
        record.producer,
        collector.capability,
        "Source Record",
      ),
    })),
  };
}

function retainInterpretationProvenance(
  interpreter: Pick<SourceInterpreter, "capability">,
  interpretation: SourceInterpretationBatch,
): SourceInterpretationBatch {
  const producer = actualProducer(
    interpretation.producer,
    interpreter.capability,
    "Source Interpretation Batch",
  );
  return {
    ...interpretation,
    producer,
    metadata: interpretation.metadata.map((assertion) => ({
      ...assertion,
      producer: actualProducer(
        assertion.producer,
        producer,
        "Metadata Assertion",
      ),
    })),
    sourceArtifacts: interpretation.sourceArtifacts.map((candidate) => ({
      ...candidate,
      producer: actualProducer(
        candidate.producer,
        producer,
        "Source Artifact Candidate",
      ),
    })),
    ...(interpretation.entityMentions === undefined
      ? {}
      : {
          entityMentions: interpretation.entityMentions.map((mention) => ({
            ...mention,
            producer: actualProducer(
              mention.producer,
              producer,
              "Entity Mention",
            ),
          })),
        }),
    ...(interpretation.entityResolutionDecisions === undefined
      ? {}
      : {
          entityResolutionDecisions:
            interpretation.entityResolutionDecisions.map((decision) => ({
              ...decision,
              producer: actualProducer(
                decision.producer,
                producer,
                "Entity Resolution Decision",
              ),
            })),
        }),
    ...(interpretation.entities === undefined
      ? {}
      : {
          entities: interpretation.entities.map((entity) => ({
            ...entity,
            producer: actualProducer(
              entity.producer,
              producer,
              "Sourced Entity",
            ),
          })),
        }),
    ...(interpretation.relationships === undefined
      ? {}
      : {
          relationships: interpretation.relationships.map((relationship) => ({
            ...relationship,
            producer: actualProducer(
              relationship.producer,
              producer,
              "Entity Relationship",
            ),
          })),
        }),
  };
}

/**
 * 识别器只有很小的草稿界面。工作流在调用前对绑定输入取快照并冻结，随后从这些输入
 * 重建完整提议。这可以防止受信规则把自己伪装成来源解释器或产物格式检查器。
 */
function frozenRecognitionInput(input: {
  readonly evidence: readonly RecognitionEvidence[];
  readonly interpretation: SourceInterpretationBatch;
}): {
  readonly evidence: readonly RecognitionEvidence[];
  readonly interpretation: SourceInterpretationBatch;
} {
  return freezeRecognitionInput({
    evidence: structuredClone(input.evidence),
    interpretation: structuredClone(input.interpretation),
  });
}

function freezeRecognitionInput<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== "object" || seen.has(current))
      return;
    seen.add(current);
    for (const child of Object.values(current)) visit(child);
    Object.freeze(current);
  };
  visit(value);
  return value;
}

function bindRecognitionProposalToRecognizer(
  recognizer: Pick<Recognizer, "capability">,
  draft: RecognitionProposalDraft,
  input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly interpretation: SourceInterpretationBatch;
  },
): RecognitionProposal {
  const allowed = new Set(["id", "ruleResults"]);
  if (Object.keys(draft).some((key) => !allowed.has(key)))
    throw new Error("Recognizer proposal draft contains unauthorized fields");
  if (!Array.isArray((draft as { readonly ruleResults?: unknown }).ruleResults))
    throw new Error(
      "Recognizer proposal draft requires Recognition Rule Results",
    );
  return {
    id: draft.id,
    interpretation: input.interpretation,
    ruleResults: draft.ruleResults.map((result) => {
      if (
        result.capabilityId !== recognizer.capability.capabilityId ||
        result.capabilityVersion !== recognizer.capability.capabilityVersion
      ) {
        throw new Error(
          "Recognition Rule Result producer does not match the executing recognizer",
        );
      }
      const evidence = result.evidence.map((candidate) => {
        const bound = input.evidence.find((item) => item === candidate);
        if (bound === undefined)
          throw new Error(
            "Recognition Rule Result references evidence outside the recognizer input",
          );
        return bound;
      });
      return {
        ...result,
        evidence,
        capabilityId: recognizer.capability.capabilityId,
        capabilityVersion: recognizer.capability.capabilityVersion,
      };
    }),
  };
}

/** 只在收到请求后，才从观察产物中提取有界部分。 */
export type ObservedArtifactPartAcquirer = {
  readonly capability: CapabilityCoordinate;
  canAcquire(candidate: ObservedArtifactPartCandidate): boolean;
  acquire(input: {
    readonly candidate: ObservedArtifactPartCandidate;
    /** 已经打开的字节；获取器不能重新打开任意位置。 */
    readonly byteSource: ObservedByteSource;
  }): Promise<{
    readonly candidateId: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly origin: Blob;
  }>;
};

export type StagedSourceArtifact = {
  readonly candidateId: string;
  readonly sourceRecordId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  /** 由 Application 根据实际执行获取的获取器设置。 */
  readonly producer?: CapabilityCoordinate;
};

export type ManagedArtifactStore = {
  store(content: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<{
    readonly blob: Blob;
    readonly location: { readonly address: string };
  }>;
  /** 耐久暂存使恢复过程无需重复已经完成的外部获取效果。 */
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
  isAvailable?(address: string): Promise<boolean>;
};

/** 刻意采用用例专用持久化端口，绝不是通用仓储。 */
type CataloguePersistenceOperations = {
  /** 在任何外部效果前，原子租用一个可恢复执行。 */
  claimResumeExecution(input: {
    readonly executionId: string;
    readonly token: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<"claimed" | "busy" | "terminal">;
  renewResumeExecutionClaim(input: {
    readonly executionId: string;
    readonly token: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<boolean>;
  releaseResumeExecutionClaim(input: {
    readonly executionId: string;
    readonly token: string;
  }): Promise<void>;
  /**
   * 自动化执行与其单活动声明一同插入。交互执行始终返回 `started`。
   */
  createExecution(
    execution: WorkflowExecution,
    requestedAt?: string,
  ): Promise<ExecutionStartDisposition>;
  /** 一个正式的记录保留检查点，带完整执行 CAS。 */
  retainSourceRecords(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly sourceRecords: readonly SourceRecord[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  finishExecution(
    /** 调用方准备 `execution` 前观察到的完整冻结审计。 */
    expectedExecution: WorkflowExecution,
    execution: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void>;
  /**
   * 明确取消本身就是终态迁移。它刻意不要求恢复声明，因为必须能够停止活动工作者。
   */
  cancelExecution(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
  }): Promise<void>;
  finishExecutionWithProposal(
    /** 调用方准备 `execution` 前观察到的完整冻结审计。 */
    expectedExecution: WorkflowExecution,
    execution: WorkflowExecution,
    proposal: RecognitionProposal,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void>;
  finishExecutionWithChangeImpactPreview(input: {
    /** 调用方准备 `execution` 前观察到的完整冻结审计。 */
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly proposal: RecognitionProposal;
    readonly preview: ChangeImpactPreview;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  acceptRecognition(input: {
    /** 调用方准备接受前观察到的完整运行中审计。 */
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly accepted: AcceptedRecognition;
    readonly metadataPolicyIds?: readonly string[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  inspectExecution(
    executionId: string,
  ): Promise<ExecutionInspection | undefined>;
  /** 交付层可以浏览耐久结果，而无需取得 Catalogue 实现。 */
  /** 按耐久创建时间从新到旧排列的完整历史。 */
  listExecutions(): Promise<readonly WorkflowExecution[]>;
  /** 启动恢复刻意覆盖每个非终态执行。 */
  listRunningExecutions(): Promise<readonly WorkflowExecution[]>;
  /** 复用是针对冻结输入的普通扫描策略，绝不是资产缓存。 */
  findReusableOrdinaryScan(input: {
    readonly plan: OrdinaryScanReusePlan;
    /** 当前部署坐标只用于验证先前冻结集合。 */
    readonly availableCompatibility: WorkflowCompatibility;
  }): Promise<WorkflowExecution | undefined>;
  /** SQLite 以条件方式实现；终态记录绝不重新打开。 */
  transitionExecution(
    /** 调用方准备 `next` 前观察到的完整冻结审计。 */
    expected: WorkflowExecution,
    next: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void>;
  inspectRawSourceRecord(
    executionId: string,
    sourceRecordId: string,
  ): Promise<SourceRecord | undefined>;
  /** 解析已接受范围，而不解析其目录或来源键。 */
  findAcceptedForDirectory(directory: string): Promise<
    | {
        readonly accepted: AcceptedAssetState;
        readonly execution: WorkflowExecution;
      }
    | undefined
  >;
  /** 只加载调用方请求的精确当前已接受主体。 */
  findAcceptedForSubjects(subjectIds: readonly string[]): Promise<
    readonly {
      readonly subjectId: string;
      readonly accepted: AcceptedAssetState;
      readonly execution: WorkflowExecution;
    }[]
  >;
  /**
   * 只查找精确的当前观察材料关联。调用方传入从可靠观察器证据派生的确定性产物 ID；
   * 该端口绝不能退回路径、标题、时间戳或 Blob 匹配。
   */
  findCurrentAcceptedForObservedArtifacts(input: {
    readonly artifactIds: readonly string[];
  }): Promise<ObservedArtifactReuseMatch>;
  /** 复用始终限制在一个稳定观察边界内，绝不扩大到整个根。 */
  findReusableWorkItem(input: {
    readonly directory: string;
    readonly relativePaths: readonly string[];
    /** 当前部署坐标只用于验证先前冻结集合。 */
    readonly availableCompatibility: WorkflowCompatibility;
    readonly reuseFingerprint: string;
  }): Promise<
    | {
        readonly execution: WorkflowExecution;
        readonly accepted: AcceptedAssetState;
        /** 匹配耐久项的完整实际依赖闭包。 */
        readonly reuseCompatibility: WorkflowCompatibility;
      }
    | undefined
  >;
  /** 查找一个精确明确边界的当前已接受身份。 */
  findAcceptedForWorkItem(input: {
    readonly directory: string;
    readonly relativePaths: readonly string[];
  }): Promise<
    | {
        readonly execution: WorkflowExecution;
        readonly accepted: AcceptedAssetState;
      }
    | undefined
  >;
  /**
   * 重新求值未变的已接受身份会推进适用事实，但不会新建数字资产、来源关联或决策。
   */
  refreshAcceptedRecognition(input: {
    /** 重新求值提交前观察到的完整运行中审计。 */
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly current: AcceptedRecognition;
    readonly accepted: AcceptedRecognition;
    readonly sourceRecords: readonly SourceRecord[];
    readonly expectedLineageHeads: MetadataRefreshSubmission["expectedLineageHeads"];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  /** 只原子推进已知关联范围内的来源事实。 */
  applyMetadataRefresh(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly submission: MetadataRefreshSubmission;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  freezeSourceLineageHeads(input: {
    readonly assetId: string;
    readonly sourceAssociation: SourceAssociation;
    readonly coverageIds: readonly string[];
  }): Promise<MetadataRefreshSubmission["expectedLineageHeads"]>;
  inspectChangeImpactPreview(
    previewId: string,
  ): Promise<ChangeImpactPreview | undefined>;
  inspectChangeImpactPreviewForExecution(
    executionId: string,
  ): Promise<ChangeImpactPreview | undefined>;
  /** 覆盖当前 lineage 和投影事实头的不透明精确基线。 */
  freezeChangeImpactBaseline(input: {
    readonly assetId: string;
    readonly sourceAssociationId: string;
    readonly recognitionDecisionId: string;
  }): Promise<string>;
  applyChangeImpactPreview(
    preview: ChangeImpactPreview,
  ): Promise<"applied" | "stale">;
  rejectChangeImpactPreview(previewId: string): Promise<"rejected" | "stale">;
  /**
   * 在持久化重复配置及其运行时行之前，原子证明预检的注册根闭包仍然活动。
   */
  createAutomationIntentForObservedRoot(input: {
    readonly intent: AutomationIntent;
    readonly authorization: AutomationObservedRootAuthorization;
  }): Promise<AutomationIntentCreationResult>;
  inspectAutomationIntent(
    intentId: string,
  ): Promise<AutomationIntent | undefined>;
  listAutomationIntents(): Promise<readonly AutomationIntent[]>;
  listRunningAutomationExecutions(): Promise<readonly WorkflowExecution[]>;
  releaseAutomationTrigger(input: {
    readonly intentId: string;
    readonly executionId: string;
    readonly trigger: AutomationTrigger;
    readonly now: string;
  }): Promise<void>;
  setAutomationIntentEnabled(
    intentId: string,
    enabled: boolean,
    disabledReason?: AutomationDisabledReason,
  ): Promise<void>;
};

export type WorkflowExecutionCommands = Pick<
  CataloguePersistenceOperations,
  | "createExecution"
  | "retainSourceRecords"
  | "transitionExecution"
  | "finishExecution"
  | "cancelExecution"
  | "finishExecutionWithProposal"
>;

export type WorkflowExecutionQueries = Pick<
  CataloguePersistenceOperations,
  | "inspectExecution"
  | "listExecutions"
  | "listRunningExecutions"
  | "inspectRawSourceRecord"
>;

export type WorkflowRecoveryLease = Pick<
  CataloguePersistenceOperations,
  | "claimResumeExecution"
  | "renewResumeExecutionClaim"
  | "releaseResumeExecutionClaim"
>;

export type AssetRefreshReuseQueries = Pick<
  CataloguePersistenceOperations,
  | "findReusableOrdinaryScan"
  | "findAcceptedForDirectory"
  | "findAcceptedForSubjects"
  | "findCurrentAcceptedForObservedArtifacts"
  | "findReusableWorkItem"
  | "findAcceptedForWorkItem"
>;

/**
 * 权威当前 Catalogue 投影的游标输入。游标对交付层刻意保持不透明；只有签发它的查询
 * 可以在后续请求中解释它。
 */
export type CurrentCataloguePageRequest = {
  readonly limit?: number;
  readonly cursor?: string;
};

/**
 * Application 移除交付层不得接收的来源信息前，持久化侧的页面。虽然三者都使用不透明
 * 游标，它仍刻意区别于工作流历史页和当前待处理页。
 */
export type CurrentCataloguePersistencePage = {
  readonly items: readonly AcceptedAssetState[];
  readonly nextCursor?: string;
};

/** 对交付层安全的当前 Catalogue 页面。 */
export type CurrentCataloguePage = {
  readonly items: readonly NonNullable<AssetRefreshInspection["accepted"]>[];
  readonly nextCursor?: string;
};

/**
 * 按用途塑形的当前 Catalogue 读取。它只返回已接受领域事实；表行、Drizzle 模型和
 * 数据库句柄保留在基础设施适配器内部。
 */
export type CurrentCatalogueQueries = {
  listCurrentCataloguePage(
    input?: CurrentCataloguePageRequest,
  ): Promise<CurrentCataloguePersistencePage>;
  /** @deprecated 交付层应使用上方的有界页面契约。 */
  listCurrentCatalogue(): Promise<readonly AcceptedAssetState[]>;
};

/** 永久工作流历史的游标输入。 */
export type WorkflowHistoryPageRequest = {
  readonly limit?: number;
  readonly cursor?: string;
};

/**
 * 适配器侧历史页面。嵌入的检查是结构化审计记录，不是当前 Catalogue 重建。
 */
export type WorkflowHistoryResultReferences = {
  readonly proposalIds: readonly string[];
  readonly acceptedProposalIds: readonly string[];
  readonly recognitionDecisionIds: readonly string[];
  readonly sourceAssociationIds: readonly string[];
  readonly acceptedAssetIds: readonly string[];
  readonly sourceRecordIds: readonly string[];
  readonly sourceRefreshRunIds: readonly string[];
  readonly changeImpactPreviewIds: readonly string[];
  readonly affectedSubjectIds: readonly string[];
};

/** 不可变执行结果记录；绝不是从当前头重建的结果。 */
export type WorkflowHistoryPersistenceEntry = {
  readonly execution: WorkflowExecution;
  readonly resultReferences: WorkflowHistoryResultReferences;
  readonly sourceRecords: readonly SourceRecord[];
  readonly proposals: readonly RecognitionProposal[];
  readonly sourceRefreshRuns: readonly SourceRefreshRun[];
  readonly changeImpactPreviews: readonly ChangeImpactPreview[];
};

export type WorkflowHistoryPersistencePage = {
  readonly items: readonly WorkflowHistoryPersistenceEntry[];
  readonly nextCursor?: string;
};

/** 对交付层安全的永久工作流历史页面。 */
export type WorkflowHistoryEntry = {
  readonly execution: AssetRefreshInspection["execution"];
  readonly resultReferences: WorkflowHistoryResultReferences;
  readonly sourceRecords: AssetRefreshInspection["sourceRecords"];
  readonly recognitionResults: readonly {
    readonly proposalId: string;
    readonly explanation: string;
    readonly status: "proposed" | "accepted";
  }[];
  readonly sourceRefreshRuns: readonly SourceRefreshRun[];
  readonly changeImpactPreviews: readonly ChangeImpactPreviewInspection[];
};

export type WorkflowHistoryPage = {
  readonly items: readonly WorkflowHistoryEntry[];
  readonly nextCursor?: string;
};

export type WorkflowHistoryQueries = {
  listWorkflowHistoryPage(
    input?: WorkflowHistoryPageRequest,
  ): Promise<WorkflowHistoryPersistencePage>;
};

/** 只用于当前、可重建待处理条件的游标输入。 */
export type CurrentAttentionPageRequest = {
  readonly limit?: number;
  readonly cursor?: string;
};

/**
 * 一个现在可以采取行动的当前条件。这里刻意排除通用终态失败，以及已经通过识别决策
 * 或变更影响预览解决的提议。
 */
export type CurrentAttentionItem = {
  readonly id: string;
  readonly kind:
    | "recognition-review"
    | "change-impact-review"
    | "source-refresh-review"
    | "prerequisite-unavailable";
  /** 根预检在创建任何执行前失败时不存在。 */
  readonly executionId?: string;
  /** 尚无已接受主体的初始识别提议中不存在。 */
  readonly assetId?: string;
  readonly summary: string;
  readonly recognitionProposalId?: string;
  readonly changeImpactPreviewId?: string;
  readonly sourceRefreshChangeSetId?: string;
  /** 仅在自动化意图因可修复前置工作而停用时存在。 */
  readonly automationIntentId?: string;
};

export type CurrentAttentionPage = {
  readonly items: readonly CurrentAttentionItem[];
  readonly nextCursor?: string;
};

export type CurrentAttentionQueries = {
  listCurrentAttentionPage(
    input?: CurrentAttentionPageRequest,
  ): Promise<CurrentAttentionPage>;
};

export type RecognitionAcceptancePersistence = Pick<
  CataloguePersistenceOperations,
  "acceptRecognition"
>;

export type RecognitionReevaluationPersistence = Pick<
  CataloguePersistenceOperations,
  "refreshAcceptedRecognition"
>;

export type RecognitionChangeImpactPersistence = Pick<
  CataloguePersistenceOperations,
  "finishExecutionWithChangeImpactPreview"
>;

export type MetadataRefreshPersistence = Pick<
  CataloguePersistenceOperations,
  "freezeSourceLineageHeads" | "applyMetadataRefresh"
>;

/**
 * 可以满足一个选定主体信息需求的精确当前事实。这里刻意排除已装载的相关实体图：调用方
 * 不会收到关联主体不同于选定主体的事实，产物可用性也只从托管位置开始。
 */
export type CurrentInformationSubjectFacts = {
  readonly subjectId: string;
  readonly sourceAssociations: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
  }[];
  readonly metadata: readonly {
    readonly subjectId: string;
    readonly property: string;
  }[];
  readonly relationships: readonly {
    readonly subjectId: string;
    readonly type: string;
  }[];
  readonly artifactAssociations: readonly {
    readonly id: string;
    readonly subjectId: string;
    readonly artifactId: string;
    readonly role: string;
    /** 仅对绑定到一个关联的托管来源产物存在。 */
    readonly sourceAssociationId?: string;
    /** 该托管来源产物不再匹配当前头时为 false。 */
    readonly currentSourceArtifact?: boolean;
    /** 该可用性输入刻意不包含观察位置。 */
    readonly managedLocations: readonly { readonly address: string }[];
  }[];
};

/**
 * 一个已接受主体可用后，外层组合重建完整的中立信息需求。Application 调用该边界时，
 * 不了解选择它的视图、提供方、路由或组件。
 */
export type AutomationInformationRequirementResolver = (
  accepted: NonNullable<AssetRefreshInspection["accepted"]>,
) => InformationRequirement;

/** 只用于重建当前履行就绪状态的窄查询端口。 */
export type InformationSubjectFactsQueries = {
  readCurrentInformationSubjectFacts(input: {
    readonly subjectIds: readonly string[];
  }): Promise<readonly CurrentInformationSubjectFacts[]>;
};

/**
 * Application 可为已识别主体选择来源产物的精确当前解释 lineage。它刻意不公开识别提议：
 * 识别历史不是产物候选缓存。
 */
export type CurrentSourceArtifactFacts = {
  readonly subjectId: string;
  readonly sourceAssociation: SourceAssociation;
  readonly recognitionIdentity: {
    readonly recognitionDecisionId: string;
    readonly sourceAssociationId: string;
  };
  readonly candidates: readonly {
    readonly candidate: SourceArtifactCandidate;
    /** 当前耐久来源解释的完整来源信息。 */
    readonly interpretationSourceRecordIds: readonly string[];
    readonly sourceRecords: readonly SourceRecord[];
  }[];
};

/** 针对当前来源刷新解释 lineage 的窄读取端口。 */
export type CurrentSourceArtifactQueries = {
  readCurrentSourceArtifactFacts(input: {
    readonly subjectId: string;
    readonly sourceIdentity: string;
    /** 选择就绪规划期间选定的精确当前关联。 */
    readonly sourceAssociationId?: string;
  }): Promise<CurrentSourceArtifactFacts | undefined>;
};

/**
 * 已经获取到托管存储中字节的身份保持提交边界。它接受普通 Blob／产物／位置／关联事实，
 * 绝不接受识别提议或决策。
 */
export type ManagedSourceArtifactPersistence = {
  submitManagedSourceArtifacts(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly expectedIdentity: CurrentSourceArtifactFacts["recognitionIdentity"] & {
      readonly subjectId: string;
    };
    readonly sourceRecordIds: readonly string[];
    readonly managedArtifacts: {
      readonly artifacts: readonly Artifact[];
      readonly locations: readonly Location[];
      readonly blobs: readonly Blob[];
      readonly revisions: readonly ArtifactRevision[];
      readonly associations: readonly ArtifactAssociation[];
    };
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
};

/**
 * 领域持有来源刷新运行的窄持久化边界。它刻意不公开工作流执行状态迁移：执行只保留 ID
 * 引用，刷新生命周期真相由该端口持有。
 */
export type SourceRefreshRunPersistence = {
  createSourceRefreshRun(
    input: CreateSourceRefreshRunInputForExecution,
  ): Promise<SourceRefreshRun>;
  /** 在外部采集前立即持久化逐范围检查点。 */
  beginSourceRefreshScopeAcquisition(input: {
    readonly runId: string;
    readonly coverage: SourceCoverageScope;
  }): Promise<SourceRefreshRun>;
  stageSourceRefreshChangeSet(
    input: StageSourceRefreshChangeSetInput,
  ): Promise<SourceRefreshRun>;
  applySourceRefreshChangeSet(input: {
    readonly runId: string;
    readonly changeSetId: string;
  }): Promise<SourceRefreshRun>;
  reviewSourceRefreshChangeSet(input: {
    readonly runId: string;
    readonly changeSetId: string;
    readonly disposition: "approved" | "rejected";
  }): Promise<SourceRefreshRun>;
  failSourceRefreshScope(input: {
    readonly runId: string;
    readonly coverage: SourceCoverageScope;
    readonly outcome: "failed" | "stale";
    readonly reason: string;
  }): Promise<SourceRefreshRun>;
  cancelSourceRefreshRun(runId: string): Promise<SourceRefreshRun>;
  inspectSourceRefreshRun(runId: string): Promise<SourceRefreshRun | undefined>;
};

/**
 * 恢复过程持有短期工作流执行租约，公开取消则是独立授权的领域操作。保持二者命令界面
 * 分离，使恢复持有者失去租约后不能误用公开取消权威。
 */
export type RecoverySourceRefreshRunCommands = {
  cancelUncommittedRun(input: {
    readonly executionId: string;
    readonly runId: string;
    readonly resumeClaim: { readonly token: string; readonly now: string };
  }): Promise<SourceRefreshRun>;
};

export type SourceEnrichmentPersistence = {
  /**
   * 在一次提交中保留已完成采集并推进其耐久意图。因此恢复过程绝不需要重复已经保留的
   * 提供方请求。
   */
  checkpointSourceEnrichmentRecords(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly sourceRecords: readonly SourceRecord[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;

  /**
   * 原子提交已解释事实和 `applied` 检查点。进程退出可以让执行保持运行中，但绝不会
   * 使其模糊地停在领域应用与耐久效果标记之间。
   */
  applySourceEnrichment(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    /** 提交时两个坐标仍必须是该主体的识别头。 */
    readonly expectedRecognitionBaseline: {
      readonly sourceAssociationId: string;
      readonly recognitionDecisionId: string;
    };
    readonly assetId: string;
    readonly sourceAssociation: SourceAssociation;
    readonly sourceRecords: readonly SourceRecord[];
    readonly interpretation: SourceInterpretationBatch;
    /**
     * 从同一解释获取的已请求来源产物。适配器将它们与新关联和断言一同提交。
     */
    readonly managedArtifacts?: {
      readonly artifacts: readonly Artifact[];
      readonly locations: readonly Location[];
      readonly blobs: readonly Blob[];
      readonly revisions: readonly ArtifactRevision[];
      readonly associations: readonly ArtifactAssociation[];
    };
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
};

export type ChangeImpactQueries = Pick<
  CataloguePersistenceOperations,
  "inspectChangeImpactPreview" | "inspectChangeImpactPreviewForExecution"
>;

export type ChangeImpactCommands = Pick<
  CataloguePersistenceOperations,
  | "freezeChangeImpactBaseline"
  | "applyChangeImpactPreview"
  | "rejectChangeImpactPreview"
>;

export type AutomationQueries = Pick<
  CataloguePersistenceOperations,
  "inspectAutomationIntent" | "listAutomationIntents"
>;

export type AutomationCommands = Pick<
  CataloguePersistenceOperations,
  | "createAutomationIntentForObservedRoot"
  | "releaseAutomationTrigger"
  | "setAutomationIntentEnabled"
>;

export type AssetRefreshWorkflowPorts = {
  /** 每次文件系统执行都通过该注册权威绑定。 */
  readonly observedRootRegistrations: Pick<
    ObservedRootRegistrations,
    | "resolveActiveScope"
    | "rebindFrozenScope"
    | "assertFrozenRootsCurrent"
    | "capability"
    | "objectIdentityContract"
    | "observeBoundScope"
    | "openBoundByteSource"
    | "closeBoundScope"
    | "reportCleanupFailure"
  >;
  readonly directoryInterpreters: readonly DirectoryInterpreter[];
  readonly filesystemPackageInterpreters?: readonly FilesystemPackageInterpreter[];
  /** 格式检查按观察产物进行，而不是目录约定。 */
  readonly formatInspectors?: readonly ArtifactFormatInspector[];
  readonly collectors: readonly SourceCollector[];
  readonly sourceInterpreters: readonly SourceInterpreter[];
  /** 在产品明确配置来源补充前可选。 */
  readonly sourceAssociationCandidateInterpreters?: readonly SourceAssociationCandidateInterpreter[];
  readonly sourceAssociationInterpreters?: readonly SourceAssociationInterpreter[];
  /**
   * 没有产品管理的私密来源连接参与时可选。它持有不透明配置版本绑定，绝不向
   * Application 公开秘密或提供方专用凭据形状。
   */
  readonly sourceConnectionExecutionConfiguration?: SourceConnectionExecutionConfiguration;
  readonly metadataPolicyConfiguration?: MetadataPolicyConfiguration;
  /**
   * 只在恢复冻结的不透明配置引用时查询；配置身份和版本存储仍位于 Application 之外。
   */
  readonly configurationCompatibility?: WorkflowConfigurationCompatibility;
  readonly recognizers: readonly Recognizer[];
  readonly recognitionPolicy: RecognitionPolicy;
  readonly acquirers: readonly SourceArtifactAcquirer[];
  readonly observedArtifactPartAcquirers?: readonly ObservedArtifactPartAcquirer[];
  readonly managedStore: ManagedArtifactStore;
  readonly executionCommands: WorkflowExecutionCommands;
  readonly executionQueries: WorkflowExecutionQueries;
  readonly recoveryLease: WorkflowRecoveryLease;
  readonly reuseQueries: AssetRefreshReuseQueries;
  /** 测试／旧版组合仍只公开历史时可选。 */
  readonly currentCatalogueQueries?: CurrentCatalogueQueries;
  /** 测试／旧版组合仍只公开完整历史时可选。 */
  readonly workflowHistoryQueries?: WorkflowHistoryQueries;
  /** 测试／旧版组合没有可重建待处理权威时可选。 */
  readonly currentAttentionQueries?: CurrentAttentionQueries;
  readonly recognitionAcceptance: RecognitionAcceptancePersistence;
  readonly recognitionReevaluation: RecognitionReevaluationPersistence;
  readonly recognitionChangeImpact: RecognitionChangeImpactPersistence;
  readonly metadataRefreshPersistence: MetadataRefreshPersistence;
  /** 生产环境只读取履行就绪所需的精确当前事实。 */
  readonly informationSubjectFactsQueries?: InformationSubjectFactsQueries;
  /** 生产环境只读取当前耐久来源产物解释。 */
  readonly currentSourceArtifactQueries?: CurrentSourceArtifactQueries;
  /** 生产环境提交托管来源产物而不重新求值身份。 */
  readonly managedSourceArtifactPersistence?: ManagedSourceArtifactPersistence;
  /** 只对旧版／测试组合可选；生产环境使用该权威。 */
  readonly sourceRefreshRuns?: SourceRefreshRunPersistence;
  /**
   * 只供恢复使用的领域运行权威配套端口。其命令携带工作流执行租约条件，绝不能替换为
   * 面向用户的领域取消命令。
   */
  readonly recoverySourceRefreshRuns?: RecoverySourceRefreshRunCommands;
  readonly sourceEnrichmentPersistence?: SourceEnrichmentPersistence;
  readonly changeImpactQueries: ChangeImpactQueries;
  readonly changeImpactCommands: ChangeImpactCommands;
  /** 只用于规划需求驱动信息工作的中立声明。 */
  readonly informationFulfillmentCapabilities?: readonly InformationFulfillmentCapability[];
  /** 一个进程持有者监督履行子执行和运行时关闭。 */
  readonly invocationSupervisor?: {
    invoke(
      invocation: (control: ExecutionInvocationControl) => void | Promise<void>,
    ): Promise<{ readonly id: string }>;
  };
  readonly resumeClock?: AutomationClock;
};

export type AutomationClock = {
  now(): Date;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
};

export type RecoveryLifecycle = {
  readonly onCheckpoint?: (() => void) | undefined;
  /** 耐久且未过期的持有者声明使本次执行继续等待重试。 */
  readonly onWaitingExecution?: (executionId: string) => void;
};

export type DueAutomationRunner = {
  recoverRunningExecutions(
    lifecycle?: RecoveryLifecycle,
  ): Promise<readonly AssetRefreshInspection[]>;
  triggerDueAutomation(
    now?: Date,
    lifecycle?: { readonly onCheckpoint: () => void },
  ): Promise<readonly AutomationTriggerResult[]>;
};

const systemAutomationClock: AutomationClock = {
  now: () => new Date(),
  setInterval: (callback, milliseconds) =>
    globalThis.setInterval(callback, milliseconds),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * 重复自动化意图的进程生命周期宿主。它只持有定时器和重叠机制；到期决策与执行仍在
 * 工作流中。
 */
export class AutomationHost {
  private readonly runner: DueAutomationRunner;
  private readonly clock: AutomationClock;
  private readonly pollIntervalMilliseconds: number;
  private readonly onError: (error: unknown) => void;
  private readonly executionHost:
    | Pick<ExecutionHost, "runWithControl">
    | undefined;
  private timer: unknown;
  private poll: Promise<void> = Promise.resolve();
  private polling = false;
  private started = false;
  private recoveryWaiting = false;

  constructor(
    runner: DueAutomationRunner,
    options?: {
      readonly clock?: AutomationClock;
      readonly pollIntervalMilliseconds?: number;
      readonly onError?: (error: unknown) => void;
      readonly executionHost?: Pick<ExecutionHost, "runWithControl">;
    },
  ) {
    this.runner = runner;
    this.clock = options?.clock ?? systemAutomationClock;
    this.pollIntervalMilliseconds = options?.pollIntervalMilliseconds ?? 1_000;
    if (
      !Number.isFinite(this.pollIntervalMilliseconds) ||
      this.pollIntervalMilliseconds <= 0
    ) {
      throw new Error("自动刷新轮询间隔必须为正数");
    }
    this.onError = options?.onError ?? (() => undefined);
    this.executionHost = options?.executionHost;
  }

  get running(): boolean {
    return this.started;
  }

  /**
   * 所有保留执行完成分类后开放启动准入。等待中的声明仍受监督并抑制重复恢复，但不会
   * 让整个 Catalogue 处于未就绪状态。
   */
  get recoveryReady(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.runPoll(true);
    } catch (error) {
      // 启动分类失败时尚未准入定时器。保持宿主可重试，而不是永久污染 `started` 锁存。
      this.started = false;
      throw error;
    }
    if (!this.started) return;
    this.timer = this.clock.setInterval(() => {
      void this.runPoll(false);
    }, this.pollIntervalMilliseconds);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== undefined) {
      this.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 等待已经开始的轮询；绝不启动新轮询。 */
  async settled(): Promise<void> {
    await this.poll;
  }

  private async runPoll(propagateError: boolean): Promise<void> {
    if (!this.started || this.polling) return;
    this.polling = true;
    this.poll = (async () => {
      try {
        const waiting = new Set<string>();
        const poll = async (lifecycle?: RecoveryLifecycle) => {
          await this.runner.recoverRunningExecutions(
            lifecycle === undefined
              ? {
                  onWaitingExecution: (executionId) => waiting.add(executionId),
                }
              : {
                  ...lifecycle,
                  onWaitingExecution: (executionId) => waiting.add(executionId),
                },
          );
          this.recoveryWaiting = waiting.size > 0;
          if (this.recoveryWaiting) return;
          const checkpoint = lifecycle?.onCheckpoint;
          await this.runner.triggerDueAutomation(
            this.clock.now(),
            checkpoint === undefined ? undefined : { onCheckpoint: checkpoint },
          );
        };
        if (this.executionHost === undefined) await poll();
        else
          await this.executionHost.runWithControl(async (control) => {
            await poll({ onCheckpoint: control.safeCheckpoint });
          });
      } catch (error) {
        this.onError(error);
        if (propagateError) throw error;
      } finally {
        this.polling = false;
      }
    })();
    await this.poll;
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function planRecognitionWorkItems(
  snapshot: FilesystemPackageSnapshot,
  interpretations: readonly (
    | readonly import("@digital/domain").RecognitionEvidence[]
    | AssetRefreshWorkPlan
  )[],
): readonly AssetRefreshWorkItemPlan[] {
  const legacyEvidence = interpretations.flatMap((interpretation) =>
    isAssetRefreshWorkPlan(interpretation) ? [] : interpretation,
  );
  const explicit = interpretations.flatMap((interpretation) =>
    isAssetRefreshWorkPlan(interpretation) ? interpretation.workItems : [],
  );
  if (
    interpretations.some(
      (interpretation) =>
        isAssetRefreshWorkPlan(interpretation) &&
        interpretation.workItems.length === 0,
    )
  ) {
    throw new Error("Explicit recognition work plan must contain a work item");
  }
  const explicitItems = new Set(explicit);
  const planned = [
    ...(legacyEvidence.length === 0
      ? []
      : [
          {
            key: "selection",
            relativePaths: snapshot.files.map((file) => file.relativePath),
            evidence: legacyEvidence,
          },
        ]),
    ...explicit,
  ];
  const keys = new Set<string>();
  const observed = new Set(snapshot.files.map((file) => file.relativePath));
  const claimedBoundaries = new Map<string, string>();
  for (const item of planned) {
    if (item.key.length === 0 || keys.has(item.key))
      throw new Error(
        "Recognition work-item keys must be non-empty and unique",
      );
    if (
      (explicitItems.has(item) && item.relativePaths.length === 0) ||
      item.relativePaths.some(
        (path) => path.length === 0 || !observed.has(path),
      )
    ) {
      throw new Error(
        "Recognition work item must select a non-empty observed boundary",
      );
    }
    if (
      (item.observedArtifactBoundary === undefined) !==
      (item.observedArtifactBoundaryProducer === undefined)
    ) {
      throw new Error(
        "Filesystem-package boundary requires capability provenance",
      );
    }
    const itemPaths = new Set<string>();
    for (const path of item.relativePaths) {
      if (itemPaths.has(path)) {
        throw new Error(
          "Recognition work item boundary contains duplicate paths",
        );
      }
      itemPaths.add(path);
      const prior = claimedBoundaries.get(path);
      if (prior !== undefined) {
        throw new Error(
          "Recognition work-item boundaries must not overlap across interpreters or plans",
        );
      }
      claimedBoundaries.set(path, item.key);
    }
    keys.add(item.key);
  }
  return planned;
}

function isAssetRefreshWorkPlan(
  value:
    | readonly import("@digital/domain").RecognitionEvidence[]
    | AssetRefreshWorkPlan,
): value is AssetRefreshWorkPlan {
  return "workItems" in value;
}

function completeWorkItem(
  execution: WorkflowExecution,
  key: string,
  outcome: Omit<AssetRefreshWorkItem, "key" | "relativePaths">,
): WorkflowExecution {
  const workItems = execution.workItems ?? [];
  const current = workItems.find((item) => item.key === key);
  if (current === undefined) throw new Error("Unknown recognition work item");
  const nextItem = { ...current, ...outcome };
  const status =
    outcome.outcome === "failed"
      ? "failed"
      : outcome.outcome === "no-change"
        ? "no-change"
        : "completed";
  return {
    ...execution,
    sourceRecordIds: [
      ...new Set([...execution.sourceRecordIds, ...outcome.sourceRecordIds]),
    ],
    workItems: workItems.map((item) => (item.key === key ? nextItem : item)),
    dispositions: execution.dispositions.map((item) =>
      item.key === `work-item:${key}`
        ? {
            ...item,
            status,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            ...(outcome.acceptedAssetId === undefined
              ? {}
              : { effectReference: outcome.acceptedAssetId }),
          }
        : item,
    ),
  };
}

function checkpointWorkItem(
  execution: WorkflowExecution,
  key: string,
  checkpoint: Partial<
    Pick<
      AssetRefreshWorkItem,
      | "sourceRecordIds"
      | "proposalId"
      | "sourceArtifactAcquisitions"
      | "managedSourceArtifacts"
    >
  >,
): WorkflowExecution {
  const workItems = execution.workItems ?? [];
  if (!workItems.some((item) => item.key === key))
    throw new Error("Unknown recognition work item");
  return {
    ...execution,
    sourceRecordIds:
      checkpoint.sourceRecordIds === undefined
        ? execution.sourceRecordIds
        : [
            ...new Set([
              ...execution.sourceRecordIds,
              ...checkpoint.sourceRecordIds,
            ]),
          ],
    workItems: workItems.map((item) =>
      item.key === key ? { ...item, ...checkpoint } : item,
    ),
  };
}

/** 在本地工作流状态中镜像耐久来源记录保留检查点。 */
function executionWithRetainedSourceRecords(
  execution: WorkflowExecution,
  sourceRecords: readonly SourceRecord[],
): WorkflowExecution {
  return {
    ...execution,
    sourceRecordIds: [
      ...new Set([
        ...execution.sourceRecordIds,
        ...sourceRecords.map((record) => record.id),
      ]),
    ],
  };
}

function terminalFromWorkItems(
  execution: WorkflowExecution,
): WorkflowExecution {
  const items = execution.workItems ?? [];
  const outcomes = items.map((item) => item.outcome);
  const accepted = items.filter((item) => item.outcome === "accepted");
  const failed = items.filter((item) => item.outcome === "failed");
  const outcome: AssetRefreshOutcome =
    accepted.length > 0
      ? "accepted"
      : failed.length > 0
        ? "failed"
        : outcomes.every((item) => item === "no-change")
          ? "no-change"
          : outcomes.some((item) => item === "proposal")
            ? "proposal"
            : "unresolved";
  return {
    ...execution,
    status: outcome === "failed" ? "failed" : "completed",
    stage: outcome === "failed" ? "failed" : "completed",
    outcome,
    ...(failed.length === 0
      ? {}
      : {
          reason: `${failed.length} 个工作项未完成；其余工作项已独立保留结果`,
        }),
    ...(execution.targetDispositions === undefined
      ? {}
      : {
          targetDispositions: execution.targetDispositions.map((target) =>
            target.status !== "running"
              ? target
              : {
                  ...target,
                  status:
                    outcome === "failed"
                      ? ("failed" as const)
                      : outcome === "no-change"
                        ? ("no-change" as const)
                        : ("completed" as const),
                },
          ),
        }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completeManagedStoreDisposition(
  item: WorkItemDisposition,
  storedArtifacts: readonly ManagedSourceArtifactCheckpoint[],
): WorkItemDisposition {
  if (!item.key.startsWith("source-artifact.store:")) return item;
  const effectReference = storedArtifacts.find(
    (artifact) => item.key === `source-artifact.store:${artifact.role}`,
  )?.location.address;
  return {
    ...item,
    status: "completed",
    ...(effectReference === undefined ? {} : { effectReference }),
  };
}

function sourceRefreshSelectors(
  requirement: InformationRequirement,
): readonly import("@digital/domain").SourceRefreshFactSelector[] {
  return [
    ...requirement.metadata.map((item) => ({
      kind: "metadata-property" as const,
      property: item.property,
    })),
    ...requirement.relationshipTypes.map((item) => ({
      kind: "relationship-type" as const,
      relationshipType: item.type,
    })),
    ...requirement.artifactRoles.map((item) => ({
      kind: "artifact-fact-family" as const,
      family: item.role,
    })),
  ];
}

function sourceRefreshRunCoordinatesSuccess(run: SourceRefreshRun): boolean {
  return (
    run.phase === "terminal" &&
    (run.outcome === "succeeded" || run.outcome === "partially-succeeded")
  );
}

function sourceRefreshRunCoordinatesFailure(run: SourceRefreshRun): boolean {
  return (
    run.phase === "terminal" &&
    run.outcome !== undefined &&
    run.outcome !== "succeeded"
  );
}

/** 终态来源刷新诊断仍是领域持有的证据。 */
function sourceRefreshTerminalReason(
  runs: readonly SourceRefreshRun[],
): string | undefined {
  return runs
    .flatMap((run) => run.scopes)
    .find((scope) => scope.state === "terminal" && scope.reason !== undefined)
    ?.reason;
}

/**
 * 一份来源刷新变更集只有一个候选记录和一个覆盖边界。多记录解释结果只能在来源完全
 * 归属于该精确记录的贡献处拆分；混合证据绝不能被静默改写为捏造的单记录断言。
 */
function sourceRefreshInterpretationForRecord(
  interpretation: SourceInterpretationBatch,
  sourceRecordId: string,
): SourceInterpretationBatch {
  const belongsOnlyToRecord = (ids: readonly string[]) =>
    ids.length > 0 && ids.every((id) => id === sourceRecordId);
  const entities = (interpretation.entities ?? []).filter((entity) =>
    belongsOnlyToRecord(entity.sourceRecordIds),
  );
  const entityIds = new Set(entities.map((entity) => entity.id));
  const mentions = (interpretation.entityMentions ?? []).filter((mention) =>
    belongsOnlyToRecord(mention.sourceRecordIds),
  );
  const mentionIds = new Set(mentions.map((mention) => mention.id));
  const resolutions = (interpretation.entityResolutionDecisions ?? []).filter(
    (decision) =>
      belongsOnlyToRecord(decision.sourceRecordIds) &&
      mentionIds.has(decision.mentionId) &&
      entityIds.has(decision.entityId),
  );
  const resolvedMentionIds = new Set(
    resolutions.map((decision) => decision.mentionId),
  );
  const relationships = (interpretation.relationships ?? []).filter(
    (relationship) =>
      belongsOnlyToRecord(relationship.sourceRecordIds) &&
      entityIds.has(relationship.participantId) &&
      (relationship.subjectId === undefined ||
        entityIds.has(relationship.subjectId)) &&
      (relationship.participantMentionIds === undefined ||
        relationship.participantMentionIds.every((mentionId) =>
          resolvedMentionIds.has(mentionId),
        )),
  );
  const scoped: SourceInterpretationBatch = {
    id: `${interpretation.id}:source-record:${sourceRecordId}`,
    producer: interpretation.producer,
    sourceRecordIds: [sourceRecordId],
    sourceIdentity: interpretation.sourceIdentity,
    sourceAddress: interpretation.sourceAddress,
    metadata: interpretation.metadata.filter(
      (assertion) =>
        belongsOnlyToRecord(assertion.sourceRecordIds) &&
        (assertion.subjectId === undefined ||
          entityIds.has(assertion.subjectId)),
    ),
    sourceArtifacts: interpretation.sourceArtifacts.filter(
      (candidate) =>
        candidate.sourceRecordId === sourceRecordId &&
        (candidate.subjectId === undefined ||
          entityIds.has(candidate.subjectId)),
    ),
    ...(entities.length === 0 ? {} : { entities }),
    ...(mentions.length === 0 ? {} : { entityMentions: mentions }),
    ...(resolutions.length === 0
      ? {}
      : { entityResolutionDecisions: resolutions }),
    ...(relationships.length === 0 ? {} : { relationships }),
  };
  validateSourceInterpretationBatch(scoped);
  return scoped;
}

class AutomationExecutionNotStarted extends Error {
  readonly disposition: Exclude<ExecutionStartDisposition, "started">;

  constructor(disposition: Exclude<ExecutionStartDisposition, "started">) {
    super(disposition);
    this.disposition = disposition;
  }
}

class ResumeExecutionBusyError extends Error {
  constructor() {
    super("刷新记录正在由另一个进程继续");
  }
}

function terminal(
  execution: WorkflowExecution,
  outcome: Exclude<AssetRefreshOutcome, "accepted">,
  reason?: string,
): WorkflowExecution {
  const failed =
    outcome === "failed" ||
    outcome === "interrupted" ||
    outcome === "cancelled";
  return {
    ...execution,
    status: failed ? "failed" : "completed",
    stage: failed ? "failed" : "completed",
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(execution.targetDispositions === undefined
      ? {}
      : {
          targetDispositions: execution.targetDispositions.map((target) =>
            target.status !== "running"
              ? target
              : {
                  ...target,
                  status: failed
                    ? ("failed" as const)
                    : outcome === "no-change"
                      ? ("no-change" as const)
                      : ("completed" as const),
                  ...(reason === undefined ? {} : { reason }),
                },
          ),
        }),
  };
}

/** 只序列化稳定执行坐标，绝不序列化端口实例。 */
function capabilityCoordinates(
  capabilities: readonly CapabilityCoordinate[],
): readonly string[] {
  return capabilities
    .map(
      (capability) =>
        `${capability.capabilityId}@${capability.capabilityVersion}/${capability.contractVersion}`,
    )
    .filter((coordinate, index, all) => all.indexOf(coordinate) === index)
    .toSorted();
}

function capabilityCoordinate(capability: CapabilityCoordinate): string {
  return `${capability.capabilityId}@${capability.capabilityVersion}/${capability.contractVersion}`;
}

function isCapabilityCoordinate(value: unknown): value is CapabilityCoordinate {
  if (typeof value !== "object" || value === null) return false;
  const capability = value as Partial<CapabilityCoordinate>;
  return [
    capability.capabilityId,
    capability.capabilityVersion,
    capability.contractVersion,
  ].every(
    (item) =>
      typeof item === "string" && item.trim().length > 0 && item.length <= 240,
  );
}

function sameCapabilityCoordinate(
  left: CapabilityCoordinate,
  right: CapabilityCoordinate,
): boolean {
  return capabilityCoordinate(left) === capabilityCoordinate(right);
}

function observedFilesystemCapabilities(
  registrations: Pick<
    ObservedRootRegistrations,
    "capability" | "objectIdentityContract"
  >,
): readonly CapabilityCoordinate[] {
  const contract = registrations.objectIdentityContract;
  if (contract === undefined || contract.kind === "snapshot-local")
    return [registrations.capability];
  if (!isCapabilityCoordinate(contract.capability))
    throw new Error(
      "Observed filesystem capability has an invalid durable identity capability",
    );
  return [registrations.capability, contract.capability];
}

function completeTargetDisposition(
  execution: WorkflowExecution,
  key: string,
  status: AssetRefreshTargetDisposition["status"],
  reason?: string,
  outputReferences?: readonly string[],
  sourceRecordIds?: readonly string[],
): WorkflowExecution {
  return {
    ...execution,
    ...(execution.targetDispositions === undefined
      ? {}
      : {
          targetDispositions: execution.targetDispositions.map((item) =>
            item.key === key
              ? {
                  ...item,
                  status,
                  ...(reason === undefined ? {} : { reason }),
                  ...(sourceRecordIds === undefined ? {} : { sourceRecordIds }),
                  ...(outputReferences === undefined
                    ? {}
                    : { outputReferences }),
                }
              : item,
          ),
        }),
  };
}

function requiredFilesystemSnapshot(
  execution: WorkflowExecution,
): FilesystemPackageSnapshot {
  if (execution.snapshot === undefined) {
    throw new Error("Filesystem operation has no frozen snapshot");
  }
  return execution.snapshot;
}

function requiredFilesystemDirectory(execution: WorkflowExecution): string {
  if (execution.selection.directory === undefined) {
    throw new Error("Filesystem operation has no selected directory");
  }
  return execution.selection.directory;
}

function publicAccepted(
  accepted: AcceptedAssetState | undefined,
  sourceRecords: readonly Pick<SourceRecord, "id" | "sourceIdentity">[],
  metadataUsageContext: string,
  configuration: MetadataPolicyConfiguration | undefined,
): AssetRefreshInspection["accepted"] | undefined {
  if (accepted === undefined) return undefined;
  const enrolledDefinitions = (accepted.metadataPolicyIds ?? []).flatMap(
    (policyId) =>
      configuration?.policies.filter(
        (definition) =>
          definition.id === policyId &&
          definition.metadataUsageContext === metadataUsageContext,
      ) ?? [],
  );
  const policies: readonly MetadataPolicy[] = enrolledDefinitions.map(
    (definition) => ({
      ...definition,
      subjectIds: [accepted.entity.id],
    }),
  );
  const provenance = [
    ...(accepted.metadataSourceRecords ?? []),
    ...sourceRecords,
  ].filter(
    (record, index, records) =>
      records.findIndex((candidate) => candidate.id === record.id) === index,
  );
  const effectiveMetadata = deriveEffectiveMetadata({
    subjectId: accepted.entity.id,
    metadataUsageContext,
    policies,
    sourceRecords: provenance,
    metadata: accepted.metadata,
  });
  return {
    entity: accepted.entity,
    sourceAssociation: {
      sourceIdentity: accepted.sourceAssociation.sourceIdentity,
      nativeAddress: accepted.sourceAssociation.nativeAddress,
    },
    sourceAssociations: (
      accepted.sourceAssociations ?? [accepted.sourceAssociation]
    ).map((association) => ({
      sourceIdentity: association.sourceIdentity,
      nativeAddress: association.nativeAddress,
    })),
    artifacts: accepted.artifacts,
    locations: accepted.locations,
    blobs: accepted.blobs,
    artifactRevisions: accepted.artifactRevisions,
    artifactAssociations: accepted.artifactAssociations,
    metadata: accepted.metadata,
    effectiveMetadata: effectiveMetadata.values,
    metadataPolicyConflicts: effectiveMetadata.conflicts,
    ...(accepted.entities === undefined ? {} : { entities: accepted.entities }),
    ...(accepted.entityMentions === undefined
      ? {}
      : { entityMentions: accepted.entityMentions }),
    ...(accepted.entityResolutionDecisions === undefined
      ? {}
      : { entityResolutionDecisions: accepted.entityResolutionDecisions }),
    ...(accepted.relationships === undefined
      ? {}
      : { relationships: accepted.relationships }),
    recognitionExplanation: accepted.recognitionDecision.acceptedRuleResults
      .map((result) => result.explanation)
      .join("；"),
  };
}

const defaultBrowsePageLimit = 24;
const maximumBrowsePageLimit = 100;

function boundedPageRequest(
  input:
    | CurrentCataloguePageRequest
    | WorkflowHistoryPageRequest
    | CurrentAttentionPageRequest
    | undefined,
  name: string,
): { readonly limit: number; readonly cursor?: string } {
  const limit = input?.limit ?? defaultBrowsePageLimit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximumBrowsePageLimit
  ) {
    throw new Error(
      `${name} page limit must be between 1 and ${maximumBrowsePageLimit}`,
    );
  }
  const cursor = input?.cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4096)
  ) {
    throw new Error(`${name} cursor is invalid`);
  }
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

function publicInspection(
  inspection: ExecutionInspection,
  configuration?: MetadataPolicyConfiguration,
): AssetRefreshInspection {
  const {
    coverAcquisition: _coverAcquisition,
    managedCover: _managedCover,
    sourceArtifactAcquisitions: _sourceArtifactAcquisitions,
    managedSourceArtifacts: _managedSourceArtifacts,
    sourceEnrichments: _sourceEnrichments,
    reusePlan: _reusePlan,
    compatibility: _compatibility,
    proposalId: _proposalId,
    dispositions: internalDispositions,
    workItems: internalWorkItems,
    ...execution
  } = inspection.execution;
  const accepted = inspection.accepted;
  const metadataUsageContext =
    inspection.execution.selection.informationRequirement
      ?.metadataUsageContext ??
    emptyInformationRequirement.metadataUsageContext;
  const publicAcceptedState = publicAccepted(
    accepted,
    inspection.sourceRecords,
    metadataUsageContext,
    configuration,
  );
  return {
    execution: {
      ...execution,
      dispositions: internalDispositions.map(
        ({ effectReference: _effectReference, ...item }) => item,
      ),
      ...(internalWorkItems === undefined
        ? {}
        : {
            workItems: internalWorkItems.map(
              ({
                planningEvidence: _planningEvidence,
                reuseFingerprint: _reuseFingerprint,
                reuseCompatibility: _reuseCompatibility,
                observedArtifactBoundaryProducer:
                  _observedArtifactBoundaryProducer,
                sourceArtifactAcquisitions: _sourceArtifactAcquisitions,
                managedSourceArtifacts: _managedSourceArtifacts,
                ...item
              }) => item,
            ),
          }),
    },
    sourceRecords: inspection.sourceRecords.map((record) => ({
      id: record.id,
      sourceIdentity: record.sourceIdentity,
      nativeAddress: record.nativeAddress,
      coverage: record.coverage,
      acquiredAt: record.acquiredAt,
      digest: record.digest,
    })),
    ...(inspection.sourceRefreshRuns === undefined
      ? {}
      : { sourceRefreshRuns: inspection.sourceRefreshRuns }),
    ...(inspection.execution.outcome !== "unresolved" ||
    inspection.execution.snapshot === undefined
      ? {}
      : {
          unresolvedObservation: unresolvedObservation(
            inspection.execution.snapshot,
          ),
        }),
    ...(inspection.proposal === undefined
      ? {}
      : {
          recognition: {
            explanation: inspection.proposal.ruleResults
              .map((result) => result.explanation)
              .join("；"),
            status: accepted === undefined ? "proposed" : "accepted",
          },
        }),
    ...(publicAcceptedState === undefined
      ? {}
      : { accepted: publicAcceptedState }),
    ...(inspection.workItemInspections === undefined
      ? {}
      : {
          itemResults: inspection.workItemInspections.map((item) => ({
            key: item.workItem.key,
            relativePaths: item.workItem.relativePaths,
            ...(item.workItem.outcome === undefined
              ? {}
              : { outcome: item.workItem.outcome }),
            ...(item.workItem.reason === undefined
              ? {}
              : { reason: item.workItem.reason }),
            ...(item.proposal === undefined
              ? {}
              : {
                  recognition: {
                    explanation: item.proposal.ruleResults
                      .map((result) => result.explanation)
                      .join("；"),
                    status:
                      item.accepted === undefined ? "proposed" : "accepted",
                  },
                }),
            ...(publicAccepted(
              item.accepted,
              inspection.sourceRecords,
              metadataUsageContext,
              configuration,
            ) === undefined
              ? {}
              : {
                  accepted: publicAccepted(
                    item.accepted,
                    inspection.sourceRecords,
                    metadataUsageContext,
                    configuration,
                  ),
                }),
          })),
        }),
  };
}

function publicChangeImpactPreview(
  preview: ChangeImpactPreview,
): ChangeImpactPreviewInspection {
  return {
    id: preview.id,
    executionId: preview.executionId,
    assetId: preview.assetId,
    status: preview.status,
    sourceAssociation: preview.projected.sourceAssociation,
    current: preview.current,
    projected: preview.projected,
    metadataCount: preview.projected.metadata.length,
    entityCount: preview.projected.entities.length,
    mentionCount: preview.projected.entityMentions.length,
    resolutionCount: preview.projected.entityResolutionDecisions.length,
    relationshipCount: preview.projected.relationships.length,
    artifactCount: preview.projected.artifacts.length,
    ...(preview.projected.primaryCoverArtifactId === undefined
      ? {}
      : { primaryCoverArtifactId: preview.projected.primaryCoverArtifactId }),
    blockingConditions: preview.blockingConditions,
  };
}

export class AssetRefreshWorkflow {
  private readonly ports: AssetRefreshWorkflowPorts;
  private readonly observedRootExecution: ObservedRootExecution;
  private readonly resumeClock: AutomationClock;
  private readonly sourceArtifactWork: CheckpointedSourceArtifactWork;
  private readonly informationFulfillment: InformationFulfillment;
  private readonly informationWork = new Map<
    string,
    Promise<AssetRefreshInspection>
  >();
  private informationFulfillmentClosing = false;

  constructor(ports: AssetRefreshWorkflowPorts) {
    this.ports = ports;
    this.observedRootExecution = new ObservedRootExecution(
      ports.observedRootRegistrations,
    );
    this.resumeClock = ports.resumeClock ?? systemAutomationClock;
    this.sourceArtifactWork = new CheckpointedSourceArtifactWork({
      acquirers: ports.acquirers,
      managedStore: ports.managedStore,
    });
    this.informationFulfillment = new InformationFulfillment({
      readSubjects: async (selection) =>
        await this.readInformationSubjectFacts(selection),
      capabilities: ports.informationFulfillmentCapabilities ?? [],
      start: async (plan, initiation) =>
        await this.startInformationFulfillment(plan, initiation),
      reconcilePending: async (input) =>
        await this.reconcilePendingInformationFulfillment(input),
    });
  }

  /**
   * 交互调用方与自动调用方共用的唯一交付层无关履行接缝。其就绪状态从已接受 Catalogue
   * 事实重建；规划效果保留在既有耐久资产刷新工作流内。
   */
  fulfillInformation(input: {
    readonly selection: InformationSubjectSelection;
    readonly requirement: InformationRequirement;
    /** 来自已接受父执行的 Application 内部来源信息。 */
    readonly initiation?: InformationFulfillmentInitiation;
  }): Promise<InformationReadiness> {
    if (this.informationFulfillmentClosing) {
      return Promise.resolve(
        blockedInformationReadiness(input, "信息履行正在关闭"),
      );
    }
    return this.informationFulfillment.fulfill(input);
  }

  /**
   * 阻止继续启动履行。注入的调用监督器持有收尾过程，并由外层组合优先排空。
   */
  close(): Promise<void> {
    this.informationFulfillmentClosing = true;
    return Promise.resolve();
  }

  private async readInformationSubjectFacts(
    selection: InformationSubjectSelection,
  ): Promise<readonly InformationSubjectFacts[]> {
    const exactFacts = this.ports.informationSubjectFactsQueries;
    if (exactFacts !== undefined) {
      const current = await exactFacts.readCurrentInformationSubjectFacts({
        subjectIds: selection.subjectIds,
      });
      return await Promise.all(
        current
          .filter((facts) => selection.subjectIds.includes(facts.subjectId))
          .map(async (facts) => ({
            subjectId: facts.subjectId,
            metadata: facts.metadata
              .filter((fact) => fact.subjectId === facts.subjectId)
              .map(({ property }) => ({ property })),
            relationships: facts.relationships
              .filter((fact) => fact.subjectId === facts.subjectId)
              .map(({ type }) => ({ type })),
            artifactAssociations: await Promise.all(
              facts.artifactAssociations
                .filter(
                  (association) => association.subjectId === facts.subjectId,
                )
                .map(
                  async ({
                    role,
                    managedLocations,
                    currentSourceArtifact,
                  }) => ({
                    role,
                    available:
                      currentSourceArtifact !== false &&
                      (await this.managedLocationsAreAvailable(
                        managedLocations,
                      )),
                  }),
                ),
            ),
            sourceAssociations: facts.sourceAssociations.map(
              ({ id, sourceIdentity }) => ({
                sourceIdentity,
                sourceAssociationId: id,
              }),
            ),
          })),
      );
    }
    const accepted = await this.ports.reuseQueries.findAcceptedForSubjects(
      selection.subjectIds,
    );
    return await Promise.all(
      accepted.map(async ({ subjectId, accepted: state }) => ({
        subjectId,
        metadata: state.metadata
          .filter((fact) => fact.subjectId === subjectId)
          .map(({ property }) => ({ property })),
        relationships: (state.relationships ?? [])
          .filter((fact) => fact.subjectId === subjectId)
          .map(({ type }) => ({ type })),
        artifactAssociations: await Promise.all(
          state.artifactAssociations
            .filter((association) => association.subjectId === subjectId)
            .map(async ({ artifactId, role }) => {
              const managed = state.locations.filter(
                (location) =>
                  location.artifactId === artifactId &&
                  location.kind === "managed",
              );
              return {
                role,
                available: await this.managedLocationsAreAvailable(managed),
              };
            }),
        ),
        sourceAssociations: (
          state.sourceAssociations ?? [state.sourceAssociation]
        )
          .filter((association) => association.subjectId === subjectId)
          .map(({ id, sourceIdentity }) => ({
            sourceIdentity,
            sourceAssociationId: id,
          })),
      })),
    );
  }

  /**
   * 履行就绪的产物必须至少有一个托管位置。观察路径建立本地来源，而不是耐久交付字节。
   */
  private async managedLocationsAreAvailable(
    locations: readonly { readonly address: string }[],
  ): Promise<boolean> {
    if (locations.length === 0) return false;
    if (this.ports.managedStore.isAvailable === undefined) return true;
    return (
      await Promise.all(
        locations.map((location) =>
          this.ports.managedStore.isAvailable!(location.address),
        ),
      )
    ).some(Boolean);
  }

  private async startInformationFulfillment(
    plan: InformationFulfillmentPlan,
    initiation?: InformationFulfillmentInitiation,
  ): Promise<InformationFulfillmentStart> {
    if (this.informationFulfillmentClosing) {
      return {
        status: "blocked",
        reason: "信息履行正在关闭",
      };
    }
    const supervisor = this.ports.invocationSupervisor;
    if (supervisor === undefined) throw new Error("信息履行缺少执行监督器");
    {
      const workKey = [
        plan.subjectId,
        plan.sourceIdentity,
        plan.sourceAssociationId ?? "",
      ].join("\u0000");
      const predecessor = this.informationWork.get(workKey);
      const metadataRefreshInitiation =
        metadataRefreshInitiationForInformationFulfillment(plan, initiation);
      const started = await supervisor.invoke(async (control) => {
        let durableExecutionId: string | undefined;
        const onExecutionStarted = (execution: WorkflowExecution) => {
          durableExecutionId = execution.id;
          control.executionStarted(execution.id);
        };
        const launch = async () => {
          if (plan.operation === "source-artifact-acquisition") {
            return await this.acquireAcceptedSourceArtifacts(
              plan,
              onExecutionStarted,
              predecessor,
              metadataRefreshInitiation,
              { onHostCheckpoint: () => control.safeCheckpoint() },
            );
          }
          await predecessor;
          return await this.refreshMetadataInternal(
            {
              selection: {
                version: assetRefreshSelectionVersion,
                subjects: [
                  {
                    subjectId: plan.subjectId,
                    explanations: [
                      {
                        path: [
                          "information-fulfillment",
                          plan.operation,
                          plan.sourceIdentity,
                        ],
                      },
                    ],
                  },
                ],
                filesystemScopes: [],
              },
              informationRequirement: plan.requirement,
              onExecutionStarted,
              onHostCheckpoint: () => control.safeCheckpoint(),
            },
            plan.sourceIdentity,
            plan.sourceAssociationId,
            metadataRefreshInitiation,
          );
        };
        const running = launch();
        this.informationWork.set(workKey, running);
        try {
          await running;
        } catch (error) {
          if (error instanceof WorkflowCheckpointInterruption)
            throw error.cause;
          if (durableExecutionId === undefined) throw error;
          const current =
            await this.ports.executionQueries.inspectExecution(
              durableExecutionId,
            );
          if (current?.execution.status === "running") {
            const failed = terminal(
              current.execution,
              "failed",
              errorMessage(error),
            );
            await this.transition(current.execution, failed);
          }
        } finally {
          if (this.informationWork.get(workKey) === running)
            this.informationWork.delete(workKey);
        }
      });
      return { status: "pending", workflowExecutionId: started.id };
    }
  }

  /**
   * 只有在耐久执行及其协调的任意领域权威来源刷新运行仍为非终态时，就绪引用才是等待中。
   * 一旦进入终态，就保留稳定的不可用／阻塞结果，而不是允许普通交付轮询重放同一来源请求。
   */
  private async reconcilePendingInformationFulfillment(input: {
    readonly plan: InformationFulfillmentPlan;
    readonly workflowExecutionId: string;
  }): Promise<InformationFulfillmentPendingReconciliation> {
    const inspection = await this.ports.executionQueries.inspectExecution(
      input.workflowExecutionId,
    );
    if (inspection === undefined) {
      return {
        status: "blocked",
        reason: "信息履行执行记录不可读取",
      };
    }
    const sourceRuns = (inspection.sourceRefreshRuns ?? []).filter(
      (run) =>
        run.requestedSelection.subjectId === input.plan.subjectId &&
        run.requestedSelection.sourceIdentity === input.plan.sourceIdentity &&
        (input.plan.sourceAssociationId === undefined ||
          run.requestedSelection.sourceAssociationId ===
            input.plan.sourceAssociationId),
    );
    if (
      inspection.execution.status === "running" ||
      sourceRuns.some((run) => run.phase !== "terminal")
    ) {
      return { status: "pending" };
    }
    const target = inspection.execution.targetDispositions?.find(
      (candidate) =>
        candidate.target.kind === "subject" &&
        candidate.target.subjectId === input.plan.subjectId,
    );
    const missingRequestedArtifact =
      input.plan.operation === "source-artifact-acquisition" &&
      inspection.execution.reason?.startsWith("缺少必需的产物角色：") === true;
    if (missingRequestedArtifact) {
      return {
        status: "unavailable",
        reason: "当前来源未提供所需信息",
      };
    }
    if (
      inspection.execution.status === "failed" ||
      target?.status === "failed" ||
      target?.status === "blocked"
    ) {
      return {
        status: "blocked",
        reason:
          target?.reason ??
          sourceRefreshTerminalReason(sourceRuns) ??
          inspection.execution.reason ??
          "信息履行执行未完成",
      };
    }
    return {
      status: "unavailable",
      reason:
        sourceRefreshTerminalReason(sourceRuns) ?? "当前来源未提供所需信息",
    };
  }

  /**
   * 即使元数据变更集没有其他变化，当前来源 lineage 仍可能改变产物候选。因此只有成功
   * 终态的来源刷新才会使先前终态产物记忆失效；单纯刷新页面绝不会变成隐式重试。
   */
  private invalidateSourceArtifactFulfillmentForRuns(
    runs: readonly SourceRefreshRun[],
  ): void {
    for (const run of runs) {
      if (!sourceRefreshRunCoordinatesSuccess(run)) continue;
      this.informationFulfillment.invalidateForSourceFacts({
        subjectId: run.requestedSelection.subjectId,
        sourceIdentity: run.requestedSelection.sourceIdentity,
        sourceAssociationId: run.requestedSelection.sourceAssociationId,
        operations: ["source-artifact-acquisition"],
      });
    }
  }

  private async acquireAcceptedSourceArtifacts(
    plan: InformationFulfillmentPlan,
    onExecutionStarted: (execution: WorkflowExecution) => void,
    predecessor?: Promise<AssetRefreshInspection>,
    initiation?: MetadataRefreshInitiation,
    lifecycle?: {
      readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
    },
  ): Promise<AssetRefreshInspection> {
    const selection: AssetRefreshSelection = {
      version: assetRefreshSelectionVersion,
      subjects: [
        {
          subjectId: plan.subjectId,
          explanations: [
            {
              path: [
                "information-fulfillment",
                plan.operation,
                plan.sourceIdentity,
              ],
            },
          ],
        },
      ],
      filesystemScopes: [],
    };
    let execution: WorkflowExecution = {
      id: id("execution"),
      workflowInput: {
        version: "asset-refresh-input/1",
        trigger: initiation?.trigger ?? "information-fulfillment",
        initiatedBy: initiation?.initiatedBy ?? "information-fulfillment",
        acceptTrusted: false,
        configurationReferences: [],
        ...(initiation === undefined
          ? {}
          : { operation: initiation.operation }),
      },
      selection: {
        intent: "metadata-refresh",
        informationRequirement: plan.requirement,
      },
      operationKind: "refresh-metadata",
      requestedSelection: selection,
      resolvedSelection: selection,
      filesystemSnapshots: [],
      targetDispositions: [
        {
          key: `subject:${plan.subjectId}`,
          target: { kind: "subject", subjectId: plan.subjectId },
          status: "running",
        },
      ],
      status: "running",
      stage: "recognition",
      sourceRecordIds: [],
      compatibility: this.compatibility(),
      dispositions: [],
    };
    const startDisposition =
      await this.ports.executionCommands.createExecution(execution);
    if (startDisposition !== "started")
      throw new AutomationExecutionNotStarted(startDisposition);
    onExecutionStarted(execution);
    notifyDurableCheckpoint(lifecycle ?? {}, execution);
    await predecessor;
    const sourceArtifactQueries = this.ports.currentSourceArtifactQueries;
    if (sourceArtifactQueries === undefined)
      throw new Error("当前来源产物解释查询未配置");
    const current = await sourceArtifactQueries.readCurrentSourceArtifactFacts({
      subjectId: plan.subjectId,
      sourceIdentity: plan.sourceIdentity,
      ...(plan.sourceAssociationId === undefined
        ? {}
        : { sourceAssociationId: plan.sourceAssociationId }),
    });
    if (current === undefined)
      throw new Error("所选主体没有适用的当前来源产物解释");
    if (
      plan.sourceAssociationId !== undefined &&
      current.sourceAssociation.id !== plan.sourceAssociationId
    ) {
      throw new Error("当前来源产物解释不属于所选来源关联");
    }
    const selected = selectCurrentSourceArtifacts(
      current.candidates,
      plan.requirement,
      plan.subjectId,
    );
    if (selected.length === 0)
      throw new Error("当前来源没有可获取的所需产物候选");
    const candidates = selected.map(({ candidate }) =>
      resolveSourceArtifactSubject(candidate, plan.subjectId),
    );
    const interpretationSourceRecordIds = [
      ...new Set(
        selected.flatMap((item) => item.interpretationSourceRecordIds),
      ),
    ];
    const sourceRecords = [
      ...new Map(
        selected
          .flatMap((item) => item.sourceRecords)
          .map((record) => [record.id, record]),
      ).values(),
    ];
    if (
      sourceRecords.length === 0 ||
      !interpretationSourceRecordIds.every((sourceRecordId) =>
        sourceRecords.some((record) => record.id === sourceRecordId),
      )
    )
      throw new Error("当前来源产物解释缺少可读取的 Source Record");
    const plannedExecution: WorkflowExecution = {
      ...execution,
      sourceRecordIds: sourceRecords.map((record) => record.id),
      dispositions: candidates.flatMap((candidate) => [
        {
          key: `source-artifact.acquire:${candidate.role}`,
          status: "running" as const,
        },
        {
          key: `source-artifact.store:${candidate.role}`,
          status: "running" as const,
        },
      ]),
    };
    await this.transition(execution, plannedExecution);
    execution = plannedExecution;
    notifyDurableCheckpoint(lifecycle ?? {}, execution);
    const managed = await this.sourceArtifactWork.complete({
      candidates,
      interpretationSourceRecordIds,
      sourceRecords,
      idempotencyKey: (candidate) =>
        sourceArtifactIdempotencyKey(execution.id, candidate),
      requireCheckpointStore: true,
      beforeAcquire: async (capability) => {
        execution = await this.freezeCapabilityParticipation(execution, [
          capability,
        ]);
      },
      onAcquired: async (acquisitions) => {
        const acquired: WorkflowExecution = {
          ...execution,
          stage: "source-artifacts-acquired",
          sourceArtifactAcquisitions: acquisitions,
          dispositions: execution.dispositions.map((item) =>
            item.key.startsWith("source-artifact.acquire:")
              ? { ...item, status: "completed" as const }
              : item,
          ),
        };
        await this.transition(execution, acquired);
        execution = acquired;
        notifyDurableCheckpoint(lifecycle ?? {}, execution);
      },
      onStored: async (stored) => {
        const storedExecution: WorkflowExecution = {
          ...execution,
          stage: "source-artifacts-stored",
          managedSourceArtifacts: stored,
          dispositions: execution.dispositions.map((item) =>
            item.key.startsWith("source-artifact.store:")
              ? { ...item, status: "completed" as const }
              : item,
          ),
        };
        await this.transition(execution, storedExecution);
        execution = storedExecution;
        notifyDurableCheckpoint(lifecycle ?? {}, execution);
      },
    });
    const finished: WorkflowExecution = {
      ...execution,
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      acceptedAssetId: plan.subjectId,
      ...(execution.targetDispositions === undefined
        ? {}
        : {
            targetDispositions: execution.targetDispositions.map((target) => ({
              ...target,
              status: "completed" as const,
            })),
          }),
    };
    const artifactPersistence = this.ports.managedSourceArtifactPersistence;
    if (artifactPersistence === undefined)
      throw new Error("托管来源产物提交未配置");
    await artifactPersistence.submitManagedSourceArtifacts({
      expectedExecution: execution,
      execution: finished,
      expectedIdentity: {
        subjectId: plan.subjectId,
        ...current.recognitionIdentity,
      },
      sourceRecordIds: interpretationSourceRecordIds,
      managedArtifacts: projectManagedSourceArtifacts(managed, plan.subjectId),
    });
    notifyDurableCheckpoint(lifecycle ?? {}, finished);
    return await this.inspectPublic(finished.id);
  }

  private async resumeInformationFulfillmentArtifacts(input: {
    readonly execution: WorkflowExecution;
    readonly operation: NonNullable<AssetRefreshWorkflowInput["operation"]>;
    readonly onHostCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly resumeClaim: { readonly token: string; readonly now: string };
  }): Promise<AssetRefreshInspection> {
    let execution = input.execution;
    const current =
      await this.ports.currentSourceArtifactQueries?.readCurrentSourceArtifactFacts(
        {
          subjectId: input.operation.subjectId,
          sourceIdentity: input.operation.sourceIdentity,
          ...(input.operation.sourceAssociationId === undefined
            ? {}
            : { sourceAssociationId: input.operation.sourceAssociationId }),
        },
      );
    if (current === undefined)
      throw new Error("所选主体没有适用的当前来源产物解释");
    const managed =
      execution.managedSourceArtifacts ??
      (await this.sourceArtifactWork.resumeStore({
        acquisitions: execution.sourceArtifactAcquisitions ?? [],
        onStored: async (stored) => {
          const storedExecution: WorkflowExecution = {
            ...execution,
            stage: "source-artifacts-stored",
            managedSourceArtifacts: stored,
            dispositions: execution.dispositions.map((item) =>
              item.key.startsWith("source-artifact.store:")
                ? { ...item, status: "completed" as const }
                : item,
            ),
          };
          await this.transition(execution, storedExecution, input.resumeClaim);
          execution = storedExecution;
          notifyDurableCheckpoint(input, execution, false);
        },
      }));
    const finished: WorkflowExecution = {
      ...execution,
      status: "completed",
      stage: "completed",
      outcome: "accepted",
      acceptedAssetId: input.operation.subjectId,
      ...(execution.targetDispositions === undefined
        ? {}
        : {
            targetDispositions: execution.targetDispositions.map((target) => ({
              ...target,
              status: "completed" as const,
            })),
          }),
    };
    const persistence = this.ports.managedSourceArtifactPersistence;
    if (persistence === undefined) throw new Error("托管来源产物提交未配置");
    await persistence.submitManagedSourceArtifacts({
      expectedExecution: execution,
      execution: finished,
      expectedIdentity: {
        subjectId: input.operation.subjectId,
        ...current.recognitionIdentity,
      },
      sourceRecordIds: [
        ...new Set(
          current.candidates.flatMap(
            (candidate) => candidate.interpretationSourceRecordIds,
          ),
        ),
      ],
      managedArtifacts: projectManagedSourceArtifacts(
        managed,
        input.operation.subjectId,
      ),
      resumeClaim: input.resumeClaim,
    });
    notifyDurableCheckpoint(input, finished, false);
    return await this.inspectResumedPublic(finished.id);
  }

  /** 生产文件系统扫描边界：调用方绝不提供服务器路径。 */
  async scanObservedScope(input: {
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly acceptTrusted: boolean;
    readonly informationRequirement?: InformationRequirement | undefined;
    readonly executionId?: string | undefined;
    readonly automationIntentId?: string | undefined;
    readonly trigger?: WorkflowExecutionTrigger | undefined;
    readonly initiatedBy?: string | undefined;
    readonly configurationReferences?: readonly string[] | undefined;
    readonly requestedAt?: string | undefined;
    readonly onExecutionStarted?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly onProgress?: ((message: string) => void) | undefined;
    readonly onCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly onHostCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
  }): Promise<AssetRefreshInspection> {
    return await this.observedRootExecution.invoke(
      input,
      async (resolved) =>
        await this.runFilesystemRecognition({
          scope: resolved.scope,
          requestedSelection: resolved.requestedSelection,
          resolvedSelection: resolved.resolvedSelection,
          operationKind: "scan-filesystem",
          intent: "scan-now",
          acceptTrusted: input.acceptTrusted,
          informationRequirement: input.informationRequirement,
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
        }),
    );
  }

  async rescrapeObservedScope(input: {
    readonly subjectId: string;
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly sourceIdentity: string;
    readonly sourceAddress: string;
    readonly informationRequirement?: InformationRequirement;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<AssetRefreshInspection> {
    return await this.observedRootExecution.invoke(
      {
        registrationId: input.registrationId,
        relativeScope: input.relativeScope,
        subjects: [
          {
            subjectId: input.subjectId,
            explanations: [{ path: ["rescrape", input.subjectId] }],
          },
        ],
      },
      async (resolved) => {
        if (
          resolved.resolvedSelection.subjects.length !== 1 ||
          resolved.resolvedSelection.filesystemScopes.length !== 1
        ) {
          throw new Error(
            "Re-scrape requires one exact current subject and one filesystem scope",
          );
        }
        const [current] = await this.ports.reuseQueries.findAcceptedForSubjects(
          [input.subjectId],
        );
        if (current === undefined || current.subjectId !== input.subjectId) {
          throw new Error("Re-scrape selected subject has no current identity");
        }
        return await this.runFilesystemRecognition({
          scope: resolved.scope,
          requestedSelection: resolved.requestedSelection,
          resolvedSelection: resolved.resolvedSelection,
          operationKind: "rescrape",
          acceptTrusted: true,
          directedSourceIdentity: input.sourceIdentity,
          directedSourceAddress: input.sourceAddress,
          informationRequirement: input.informationRequirement,
          onExecutionStarted: input.onExecutionStarted,
          onProgress: input.onProgress,
          onCheckpoint: input.onCheckpoint,
          onHostCheckpoint: input.onHostCheckpoint,
          directedCurrent: current,
        });
      },
    );
  }

  async directedRecognitionObservedScope(input: {
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly sourceIdentity: string;
    readonly sourceAddress: string;
    readonly informationRequirement?: InformationRequirement;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onProgress?: (message: string) => void;
  }): Promise<AssetRefreshInspection> {
    return await this.observedRootExecution.invoke(input, async (resolved) => {
      if (
        resolved.resolvedSelection.subjects.length !== 0 ||
        resolved.resolvedSelection.filesystemScopes.length !== 1
      ) {
        throw new Error(
          "Directed Recognition requires one filesystem scope and no current subject",
        );
      }
      return await this.runFilesystemRecognition({
        scope: resolved.scope,
        requestedSelection: resolved.requestedSelection,
        resolvedSelection: resolved.resolvedSelection,
        operationKind: "scan-filesystem",
        acceptTrusted: true,
        directedSourceIdentity: input.sourceIdentity,
        directedSourceAddress: input.sourceAddress,
        informationRequirement: input.informationRequirement,
        onExecutionStarted: input.onExecutionStarted,
        onProgress: input.onProgress,
      });
    });
  }

  /**
   * 为一个精确主体解析当前服务器持有的刷新坐标。交付调用方不得从 Catalogue 树重建它，
   * 也不得接受客户端提供的当前来源关联。
   */
  async inspectRefreshTarget(
    subjectId: string,
  ): Promise<AssetRefreshTarget | undefined> {
    const [current] = await this.ports.reuseQueries.findAcceptedForSubjects([
      subjectId,
    ]);
    if (current === undefined || current.subjectId !== subjectId)
      return undefined;
    const scope = current.execution.resolvedSelection?.filesystemScopes[0];
    if (scope?.observedRoot === undefined || scope.relativeScope === undefined)
      return undefined;
    return {
      subjectId,
      filesystemScope: {
        observedRootId: scope.observedRoot.id,
        relativeScope: scope.relativeScope,
      },
      sourceAssociation: current.accepted.sourceAssociation,
    };
  }

  /**
   * 读取一个精确已接受主体的交付层安全当前事实。这里刻意不通过浏览工作流历史实现。
   */
  async inspectCurrentCatalogueSubject(
    subjectId: string,
  ): Promise<AssetRefreshInspection["accepted"] | undefined> {
    const [current] = await this.ports.reuseQueries.findAcceptedForSubjects([
      subjectId,
    ]);
    if (current === undefined || current.subjectId !== subjectId)
      return undefined;
    return publicAccepted(
      current.accepted,
      [],
      "asset.ordinary",
      this.ports.metadataPolicyConfiguration,
    );
  }

  async refreshMetadata(
    input: MetadataRefreshInput,
  ): Promise<AssetRefreshInspection> {
    return await atPublicWorkflowBoundary(
      async () => await this.refreshMetadataInternal(input),
    );
  }

  private async refreshMetadataInternal(
    input: MetadataRefreshInput,
    fulfillmentSourceIdentity?: string,
    fulfillmentSourceAssociationId?: string,
    initiation?: MetadataRefreshInitiation,
  ): Promise<AssetRefreshInspection> {
    assertAssetRefreshSelection(input.selection);
    if (input.selection.filesystemScopes.length !== 0) {
      throw new Error("Metadata Refresh 不接受文件位置范围");
    }
    const resolvedSelection = await freezeAssetRefreshSelection(
      input.selection,
    );
    if (
      resolvedSelection.subjects.length === 0 ||
      resolvedSelection.filesystemScopes.length !== 0
    ) {
      throw new Error(
        "Metadata Refresh requires exact subjects and no filesystem scopes",
      );
    }
    const initial: WorkflowExecution = {
      id: id("execution"),
      workflowInput: {
        version: "asset-refresh-input/1",
        trigger: initiation?.trigger ?? "interactive",
        initiatedBy:
          initiation?.initiatedBy ?? input.initiatedBy ?? "interactive",
        // 元数据刷新绝不作出识别决策。来源刷新运行审阅策略属于它引用的领域过程。
        acceptTrusted: false,
        configurationReferences: [],
        ...(initiation === undefined
          ? {}
          : { operation: initiation.operation }),
      },
      selection: {
        intent: "metadata-refresh",
        informationRequirement:
          input.informationRequirement ?? emptyInformationRequirement,
      },
      operationKind: "refresh-metadata",
      requestedSelection: input.selection,
      resolvedSelection,
      filesystemSnapshots: [],
      targetDispositions: resolvedSelection.subjects.map(({ subjectId }) => ({
        key: `subject:${subjectId}`,
        target: { kind: "subject", subjectId },
        status: "running",
      })),
      status: "running",
      stage: "recognition",
      sourceRecordIds: [],
      compatibility: this.compatibility(),
      dispositions: [],
    };
    const startDisposition =
      await this.ports.executionCommands.createExecution(initial);
    if (startDisposition !== "started") {
      throw new AutomationExecutionNotStarted(startDisposition);
    }
    input.onExecutionStarted?.(initial);
    notifyDurableCheckpoint(input, initial);
    const acceptedTargets =
      await this.ports.reuseQueries.findAcceptedForSubjects(
        resolvedSelection.subjects.map((target) => target.subjectId),
      );
    const acceptedBySubject = new Map(
      acceptedTargets.map((target) => [target.subjectId, target]),
    );
    const usesSourceRefreshRunAuthority =
      this.ports.sourceRefreshRuns !== undefined;
    const coordinatedSourceRefreshRuns: SourceRefreshRun[] = [];
    let execution = initial;
    for (const target of resolvedSelection.subjects) {
      const key = `subject:${target.subjectId}`;
      const existing = acceptedBySubject.get(target.subjectId);
      if (existing === undefined) {
        const blocked = completeTargetDisposition(
          execution,
          key,
          "blocked",
          "所选主体没有当前来源关联",
        );
        await this.transition(execution, blocked);
        execution = blocked;
        continue;
      }
      const currentAssociations = [
        ...new Map(
          (
            existing.accepted.sourceAssociations ?? [
              existing.accepted.sourceAssociation,
            ]
          ).map((association) => [association.id, association]),
        ).values(),
      ].filter(
        (association) =>
          fulfillmentSourceIdentity === undefined ||
          association.sourceIdentity === fulfillmentSourceIdentity,
      );
      const exactCurrentAssociations = currentAssociations.filter(
        (association) =>
          fulfillmentSourceAssociationId === undefined ||
          association.id === fulfillmentSourceAssociationId,
      );
      const associations = exactCurrentAssociations;
      const sourceScopes: string[] = [];
      const associationRuns: SourceRefreshRun[] = [];
      for (const association of associations) {
        const sourceScope = `source-refresh:${target.subjectId}:${association.id}`;
        if (!usesSourceRefreshRunAuthority) sourceScopes.push(sourceScope);
        const refreshed = await this.refreshAcceptedAssociation(
          execution,
          existing,
          input,
          key,
          association,
          sourceScope,
        );
        const currentExecution =
          await this.ports.executionQueries.inspectExecution(
            refreshed.execution.id,
          );
        if (currentExecution === undefined) {
          throw new Error(
            "Metadata Refresh execution disappeared during coordination",
          );
        }
        execution = currentExecution.execution;
        // 采集器仍在进行时，审阅者或取消请求可能已经终态协调了同一次执行。权威运行
        // 处置持有该结果，因此这个过期协调器必须返回它，而不是尝试另一次迁移。
        if (execution.status !== "running") {
          return await this.inspectPublic(execution.id);
        }
        if (usesSourceRefreshRunAuthority) {
          const run = (refreshed.sourceRefreshRuns ?? [])
            .toReversed()
            .find(
              (candidate) =>
                candidate.requestedSelection.subjectId === target.subjectId &&
                candidate.requestedSelection.sourceAssociationId ===
                  association.id,
            );
          if (run !== undefined) {
            associationRuns.push(run);
            coordinatedSourceRefreshRuns.push(run);
          }
        }
      }
      if (usesSourceRefreshRunAuthority) {
        if (associationRuns.some((run) => run.phase !== "terminal")) {
          // 变更集等待审阅期间，领域持有的来源刷新运行是唯一权威。让本次执行停留在耐久
          // 应用检查点；处置使所有引用运行进入终态后，再次协调它。
          continue;
        }
        const succeeded = associationRuns.some(
          sourceRefreshRunCoordinatesSuccess,
        );
        const failed =
          associationRuns.length !== associations.length ||
          associationRuns.some(sourceRefreshRunCoordinatesFailure);
        const completed = completeTargetDisposition(
          execution,
          key,
          succeeded ? "completed" : "failed",
          succeeded && failed
            ? "部分当前来源未完成；其他来源结果已保留"
            : undefined,
          associationRuns.map((run) => run.id),
        );
        await this.transition(execution, completed);
        execution = completed;
        continue;
      }
      const succeeded = sourceScopes.some((scope) =>
        execution.dispositions.some(
          (disposition) =>
            disposition.key === scope && disposition.status === "completed",
        ),
      );
      const completed = completeTargetDisposition(
        execution,
        key,
        succeeded ? "completed" : "failed",
        succeeded &&
          sourceScopes.some((scope) =>
            execution.dispositions.some(
              (disposition) =>
                disposition.key === scope && disposition.status === "failed",
            ),
          )
          ? "部分当前来源未完成；其他来源结果已保留"
          : undefined,
      );
      await this.transition(execution, completed);
      execution = completed;
    }
    const authoritativeRuns = usesSourceRefreshRunAuthority
      ? ((await this.ports.executionQueries.inspectExecution(execution.id))
          ?.sourceRefreshRuns ?? coordinatedSourceRefreshRuns)
      : [];
    if (
      usesSourceRefreshRunAuthority &&
      authoritativeRuns.some((run) => run.phase !== "terminal")
    ) {
      return await this.inspectPublic(execution.id);
    }
    let enrichment: Awaited<
      ReturnType<typeof this.enrichAcceptedSubjectsInExecution>
    >;
    try {
      enrichment = await this.enrichAcceptedSubjectsInExecution({
        execution,
        selection: resolvedSelection,
        informationRequirement:
          input.informationRequirement ?? emptyInformationRequirement,
        onProgress: input.onProgress,
      });
    } catch (error) {
      rethrowWorkflowLifecycle(error);
      const failed = await this.failLatestEnrichmentPlanningExecution(
        execution,
        error,
      );
      return await this.inspectPublic(failed.id);
    }
    execution = enrichment.execution;
    const completed =
      execution.targetDispositions?.filter(
        (target) =>
          target.status === "completed" ||
          target.status === "no-change" ||
          target.status === "reused",
      ).length ?? 0;
    const failed =
      execution.targetDispositions?.filter(
        (target) => target.status === "failed" || target.status === "blocked",
      ).length ?? 0;
    const completedSubjects = new Set(
      (execution.targetDispositions ?? []).flatMap((target) =>
        target.target.kind === "subject" &&
        (target.status === "completed" ||
          target.status === "no-change" ||
          target.status === "reused")
          ? [target.target.subjectId]
          : [],
      ),
    );
    const failedSourceScopes = usesSourceRefreshRunAuthority
      ? authoritativeRuns.filter(
          (run) =>
            run.phase === "terminal" &&
            run.outcome !== undefined &&
            run.outcome !== "succeeded",
        ).length
      : execution.dispositions.filter((disposition) => {
          if (
            !disposition.key.startsWith("source-refresh:") ||
            disposition.status !== "failed"
          )
            return false;
          const subjectId = disposition.key.split(":")[1];
          return subjectId !== undefined && completedSubjects.has(subjectId);
        }).length;
    const finished: WorkflowExecution = {
      ...execution,
      status: completed > 0 ? "completed" : "failed",
      stage: completed > 0 ? "completed" : "failed",
      outcome:
        completed === 0
          ? "failed"
          : enrichment.failed > 0 || failedSourceScopes > 0
            ? "partially-succeeded"
            : "accepted",
      ...(failed === 0 && enrichment.failed === 0 && failedSourceScopes === 0
        ? {}
        : {
            reason:
              enrichment.failed > 0
                ? `${enrichment.failed} 个来源补充未完成；成功范围已保留`
                : failedSourceScopes > 0
                  ? `${failedSourceScopes} 个当前来源未完成；成功范围已保留`
                  : `${failed} 个精确主体刷新未完成；成功 siblings 已保留`,
          }),
    };
    await this.transition(execution, finished);
    this.invalidateSourceArtifactFulfillmentForRuns(authoritativeRuns);
    return await this.inspectPublic(finished.id);
  }

  /**
   * 明确配置的识别后来源补充运行。它不创建识别决策，并独立处理每个来源结果。从普通
   * 元数据刷新调用它，可让来源补充留在同一产品路径，而不添加提供方专用 CLI 操作。
   */
  private async enrichAcceptedSubjectsInExecution(input: {
    readonly execution: WorkflowExecution;
    readonly selection: ResolvedAssetRefreshSelection;
    readonly informationRequirement: InformationRequirement;
    readonly onProgress?: ((message: string) => void) | undefined;
    readonly onCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly onHostCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly resumeClaim?:
      | { readonly token: string; readonly now: string }
      | undefined;
  }): Promise<{
    readonly execution: WorkflowExecution;
    readonly failed: number;
  }> {
    const candidateInterpreters =
      this.ports.sourceAssociationCandidateInterpreters ?? [];
    const associationInterpreters =
      this.ports.sourceAssociationInterpreters ?? [];
    const persistence = this.ports.sourceEnrichmentPersistence;
    if (
      candidateInterpreters.length === 0 ||
      associationInterpreters.length === 0 ||
      persistence === undefined
    )
      return { execution: input.execution, failed: 0 };
    const acceptedTargets =
      await this.ports.reuseQueries.findAcceptedForSubjects(
        input.selection.subjects.map((target) => target.subjectId),
      );
    let execution = input.execution;
    const planned: {
      readonly target: (typeof acceptedTargets)[number];
      readonly state: SourceEnrichmentInput;
      readonly candidateInterpreter: (typeof candidateInterpreters)[number];
      readonly evidence: NonNullable<
        ReturnType<(typeof candidateInterpreters)[number]["interpret"]>
      >;
    }[] = [];
    for (const target of acceptedTargets) {
      const state: SourceEnrichmentInput = {
        subjectId: target.subjectId,
        recognitionSourceAssociation: target.accepted.sourceAssociation,
        recognitionDecisionId: target.accepted.recognitionDecision.id,
        sourceAssociations: target.accepted.sourceAssociations ?? [
          target.accepted.sourceAssociation,
        ],
        metadata: target.accepted.metadata,
        metadataSourceRecords: target.accepted.metadataSourceRecords ?? [],
        informationRequirement: input.informationRequirement,
      };
      for (const candidateInterpreter of candidateInterpreters) {
        execution = await this.freezeCapabilityParticipation(
          execution,
          [candidateInterpreter.capability],
          input.resumeClaim,
        );
        const candidateEvidence = candidateInterpreter.interpret(state);
        const evidence =
          candidateEvidence === undefined
            ? undefined
            : bindRecognitionEvidenceToProducer(
                candidateEvidence,
                candidateInterpreter.capability,
              );
        if (
          evidence === undefined ||
          evidence.sourceIdentity === undefined ||
          evidence.sourceAddress === undefined ||
          state.sourceAssociations.some(
            (association) =>
              association.sourceIdentity === evidence.sourceIdentity,
          )
        )
          continue;
        planned.push({ target, state, candidateInterpreter, evidence });
      }
    }
    if (planned.length === 0) return { execution, failed: 0 };
    const initialCheckpoints = planned.map(
      ({
        target,
        state,
        candidateInterpreter,
        evidence,
      }): CandidateSourceEnrichmentCheckpoint => {
        const roleCounts = countArtifactRoles(
          target.accepted.artifactAssociations,
        );
        return {
          key: `source-enrichment:${target.subjectId}:${candidateInterpreter.capability.capabilityId}`,
          subjectId: target.subjectId,
          stage: "candidate-interpreted",
          subject: state,
          evidence,
          fulfilledArtifactRoles: [...roleCounts].map(([role, count]) => ({
            role,
            count,
          })),
          metadataPolicyIds: target.accepted.metadataPolicyIds ?? [],
        };
      },
    );
    const executionBeforeCheckpoints = execution;
    execution = initialCheckpoints.reduce<WorkflowExecution>(
      (current, checkpoint) =>
        upsertSourceEnrichmentCheckpoint(current, checkpoint),
      {
        ...execution,
        dispositions: [
          ...execution.dispositions,
          ...initialCheckpoints.map((checkpoint) => ({
            key: checkpoint.key,
            status: "running" as const,
          })),
        ],
      },
    );
    await this.transition(
      executionBeforeCheckpoints,
      execution,
      input.resumeClaim,
    );
    notifyDurableCheckpoint(input, execution);
    const checkpointed = async (
      nextCheckpoint: SourceEnrichmentCheckpoint,
    ): Promise<void> => {
      const nextExecution = upsertSourceEnrichmentCheckpoint(
        execution,
        nextCheckpoint,
      );
      await this.transition(execution, nextExecution, input.resumeClaim);
      execution = nextExecution;
      notifyDurableCheckpoint(input, nextExecution);
    };
    let failed = 0;
    for (const initial of initialCheckpoints) {
      const { key, evidence } = initial;
      try {
        input.onProgress?.("正在补充已识别资产的其他来源");
        const collector = this.ports.collectors.find((candidate) =>
          candidate.canCollect(evidence),
        );
        if (collector === undefined)
          throw new Error("没有采集能力接受补充来源证据");
        execution = await this.bindCollectorConfiguration(
          execution,
          collector,
          evidence,
          input.resumeClaim,
        );
        execution = await this.freezeCapabilityParticipation(
          execution,
          [collector.capability],
          input.resumeClaim,
        );
        const collection = retainCollectedRecordProvenance(
          collector,
          await collector.collect(
            evidence,
            this.collectionExecutionContext(execution),
          ),
        );
        const retainedCheckpoint: RetainedSourceEnrichmentCheckpoint = {
          ...initial,
          stage: "source-records-retained",
          sourceRecordIds: collection.records.map((record) => record.id),
          collectionFailures: collection.failures,
        };
        const retainedExecution = upsertSourceEnrichmentCheckpoint(
          {
            ...execution,
            stage: "source-records-retained",
            sourceRecordIds: [
              ...new Set([
                ...execution.sourceRecordIds,
                ...collection.records.map((record) => record.id),
              ]),
            ],
          },
          retainedCheckpoint,
        );
        await persistence.checkpointSourceEnrichmentRecords({
          expectedExecution: execution,
          execution: retainedExecution,
          sourceRecords: collection.records,
          ...(input.resumeClaim === undefined
            ? {}
            : { resumeClaim: input.resumeClaim }),
        });
        execution = retainedExecution;
        notifyDurableCheckpoint(input, execution);
        if (collection.failures.length > 0) {
          failed += 1;
          const failedExecution = upsertSourceEnrichmentCheckpoint(
            {
              ...execution,
              dispositions: execution.dispositions.map((item) =>
                item.key === key
                  ? {
                      ...item,
                      status: "failed" as const,
                      reason: collection.failures
                        .map((failure) => failure.reason)
                        .join("；"),
                    }
                  : item,
              ),
            },
            {
              ...retainedCheckpoint,
              stage: "failed",
            },
          );
          await this.transition(execution, failedExecution, input.resumeClaim);
          execution = failedExecution;
          notifyDurableCheckpoint(input, execution);
          continue;
        }
        const interpreted = await this.interpretRetainedSourceEnrichment(
          retainedCheckpoint,
          collection.records,
          execution.id,
          async (capability) => {
            execution = await this.freezeCapabilityParticipation(
              execution,
              [capability],
              input.resumeClaim,
            );
          },
        );
        const interpretedCheckpoint = interpreted.checkpoint;
        await checkpointed(interpretedCheckpoint);
        let managedArtifacts: readonly ManagedSourceArtifactCheckpoint[] = [];
        managedArtifacts =
          interpretedCheckpoint.sourceArtifacts.length === 0
            ? []
            : await this.sourceArtifactWork.complete({
                candidates: interpretedCheckpoint.sourceArtifacts,
                interpretationSourceRecordIds:
                  interpretedCheckpoint.interpretation.sourceRecordIds,
                sourceRecords: collection.records,
                idempotencyKey: (candidate) =>
                  sourceArtifactIdempotencyKey(execution.id, candidate),
                requireCheckpointStore: true,
                beforeAcquire: async (capability) => {
                  execution = await this.freezeCapabilityParticipation(
                    execution,
                    [capability],
                    input.resumeClaim,
                  );
                },
                onAcquired: async (acquisitions) => {
                  await checkpointed({
                    ...interpretedCheckpoint,
                    stage: "source-artifact-acquired",
                    sourceArtifactAcquisitions: acquisitions,
                  });
                },
                onStored: async (stored) => {
                  const current = execution.sourceEnrichments?.find(
                    (item) => item.key === key,
                  );
                  await checkpointed({
                    ...interpretedCheckpoint,
                    stage: "source-artifact-stored",
                    ...(current?.stage === "source-artifact-acquired"
                      ? {
                          sourceArtifactAcquisitions:
                            current.sourceArtifactAcquisitions,
                        }
                      : {}),
                    managedSourceArtifacts: stored,
                  });
                },
              });
        const projectedManagedArtifacts =
          managedArtifacts.length === 0
            ? undefined
            : projectManagedSourceArtifacts(
                managedArtifacts,
                interpretedCheckpoint.subjectId,
                { forceFallbackSubject: true },
              );
        const appliedCheckpoint: SourceEnrichmentCheckpoint = {
          ...interpretedCheckpoint,
          stage: "applied",
          ...(managedArtifacts.length === 0
            ? {}
            : { managedSourceArtifacts: managedArtifacts }),
        };
        const appliedExecution = {
          ...upsertSourceEnrichmentCheckpoint(execution, appliedCheckpoint),
          dispositions: execution.dispositions.map((item) =>
            item.key === key ? { ...item, status: "completed" as const } : item,
          ),
        };
        await persistence.applySourceEnrichment({
          expectedExecution: execution,
          execution: appliedExecution,
          expectedRecognitionBaseline: {
            sourceAssociationId:
              interpretedCheckpoint.subject.recognitionSourceAssociation.id,
            recognitionDecisionId:
              interpretedCheckpoint.subject.recognitionDecisionId,
          },
          assetId: interpretedCheckpoint.subjectId,
          sourceAssociation: interpretedCheckpoint.sourceAssociation,
          sourceRecords: collection.records,
          interpretation: interpretedCheckpoint.interpretation,
          ...(projectedManagedArtifacts === undefined
            ? {}
            : { managedArtifacts: projectedManagedArtifacts }),
          ...(input.resumeClaim === undefined
            ? {}
            : { resumeClaim: input.resumeClaim }),
        });
        execution = appliedExecution;
        notifyDurableCheckpoint(input, execution);
      } catch (error) {
        rethrowWorkflowLifecycle(error);
        failed += 1;
        const currentCheckpoint =
          execution.sourceEnrichments?.find((item) => item.key === key) ??
          initial;
        const failedExecution = upsertSourceEnrichmentCheckpoint(
          {
            ...execution,
            dispositions: execution.dispositions.map((item) =>
              item.key === key
                ? {
                    ...item,
                    status: "failed" as const,
                    reason: errorMessage(error),
                  }
                : item,
            ),
          },
          failedSourceEnrichmentCheckpoint(currentCheckpoint),
        );
        // 本进程退出时，后续配置的来源补充可能已进入外部效果。继续前持久化这个普通
        // 失败，使恢复过程绝不会把它当成尚未尝试的候选。
        await this.transition(execution, failedExecution, input.resumeClaim);
        execution = failedExecution;
        notifyDurableCheckpoint(input, execution);
      }
    }
    return { execution, failed };
  }

  private async interpretRetainedSourceEnrichment(
    checkpoint: RetainedSourceEnrichmentCheckpoint,
    records: readonly SourceRecord[],
    executionId: string,
    beforeInterpret: (capability: CapabilityCoordinate) => void | Promise<void>,
  ): Promise<{
    readonly checkpoint: InterpretedSourceEnrichmentCheckpoint;
  }> {
    if (checkpoint.collectionFailures.length > 0)
      throw new Error("失败的来源补充采集不得进入解释");
    const interpreter = this.ports.sourceInterpreters.find((candidate) =>
      candidate.canInterpret({
        evidence: [checkpoint.evidence],
        sourceRecords: records,
      }),
    );
    if (interpreter === undefined)
      throw new Error("没有解释能力接受补充来源记录");
    await beforeInterpret(interpreter.capability);
    const interpretation = retainInterpretationProvenance(
      interpreter,
      interpreter.interpret({
        evidence: [checkpoint.evidence],
        sourceRecords: records,
      }),
    );
    validateSourceInterpretationBatch(interpretation);
    if (
      interpretation.sourceIdentity !== checkpoint.evidence.sourceIdentity ||
      interpretation.sourceAddress !== checkpoint.evidence.sourceAddress
    )
      throw new Error("来源补充解释与候选来源关联不一致");
    const associationInterpreter = (
      this.ports.sourceAssociationInterpreters ?? []
    ).find((candidate) =>
      candidate.canInterpret({
        evidence: checkpoint.evidence,
        interpretation,
      }),
    );
    if (associationInterpreter === undefined)
      throw new Error("没有来源关联解释能力接受补充来源");
    await beforeInterpret(associationInterpreter.capability);
    const associationInterpretation = associationInterpreter.interpret({
      subject: checkpoint.subject,
      evidence: checkpoint.evidence,
      interpretation,
    });
    if (associationInterpretation.status !== "accepted")
      throw new Error(associationInterpretation.explanation);
    const roleCounts = new Map(
      checkpoint.fulfilledArtifactRoles.map(({ role, count }) => [role, count]),
    );
    const selectedArtifacts = selectEnrichmentSourceArtifacts(
      interpretation,
      checkpoint.subject.informationRequirement,
      roleCounts,
    ).map((candidate) =>
      resolveSourceArtifactSubject(candidate, checkpoint.subjectId),
    );
    return {
      checkpoint: {
        ...checkpoint,
        stage: "association-interpreted",
        sourceAssociation: {
          id: id("source-association"),
          subjectId: checkpoint.subjectId,
          sourceIdentity: interpretation.sourceIdentity,
          nativeAddress: interpretation.sourceAddress,
          proposalId: `source-enrichment:${executionId}:${associationInterpreter.capability.capabilityId}`,
        },
        interpretation,
        sourceRecordIds: interpretation.sourceRecordIds,
        sourceArtifacts: selectedArtifacts,
      },
    };
  }

  private async resumeSourceEnrichmentCheckpoints(input: {
    readonly execution: WorkflowExecution;
    readonly sourceRecords: readonly SourceRecord[];
    readonly beforeEffect: () => void | Promise<void>;
    readonly resumeClaim: { readonly token: string; readonly now: string };
    readonly onHostCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
  }): Promise<WorkflowExecution> {
    const persistence = this.ports.sourceEnrichmentPersistence;
    if (persistence === undefined)
      throw new Error("当前组合无法继续已持久化的来源补充");
    let execution = input.execution;
    let retainedSourceRecords = [...input.sourceRecords];
    for (const initial of execution.sourceEnrichments ?? []) {
      if (initial.stage === "applied" || initial.stage === "failed") continue;
      notifyDurableCheckpoint(input, execution, false);
      let checkpoint: SourceEnrichmentCheckpoint = initial;
      if (checkpoint.stage === "candidate-interpreted") {
        const collector = this.ports.collectors.find((candidate) =>
          candidate.canCollect(checkpoint.evidence),
        );
        if (collector === undefined)
          throw new Error("没有采集能力接受补充来源证据");
        await input.beforeEffect();
        execution = await this.bindCollectorConfiguration(
          execution,
          collector,
          checkpoint.evidence,
          input.resumeClaim,
        );
        execution = await this.freezeCapabilityParticipation(
          execution,
          [collector.capability],
          input.resumeClaim,
        );
        const collection = retainCollectedRecordProvenance(
          collector,
          await collector.collect(
            checkpoint.evidence,
            this.collectionExecutionContext(execution),
          ),
        );
        checkpoint = {
          ...checkpoint,
          stage: "source-records-retained",
          sourceRecordIds: collection.records.map((record) => record.id),
          collectionFailures: collection.failures,
        };
        const next = upsertSourceEnrichmentCheckpoint(
          {
            ...execution,
            stage: "source-records-retained",
            sourceRecordIds: [
              ...new Set([
                ...execution.sourceRecordIds,
                ...collection.records.map((record) => record.id),
              ]),
            ],
          },
          checkpoint,
        );
        await persistence.checkpointSourceEnrichmentRecords({
          expectedExecution: execution,
          execution: next,
          sourceRecords: collection.records,
          resumeClaim: input.resumeClaim,
        });
        execution = next;
        notifyDurableCheckpoint(input, execution, false);
        retainedSourceRecords = [
          ...retainedSourceRecords,
          ...collection.records,
        ];
      }
      const records = retainedSourceRecords.filter((record) =>
        checkpoint.sourceRecordIds.includes(record.id),
      );
      if (records.length !== new Set(checkpoint.sourceRecordIds).size)
        throw new Error("来源补充检查点缺少已保留的来源记录");
      if (
        checkpoint.stage === "source-records-retained" &&
        checkpoint.collectionFailures.length > 0
      ) {
        const reason = checkpoint.collectionFailures
          .map((failure) => failure.reason)
          .join("；");
        const failedExecution = upsertSourceEnrichmentCheckpoint(
          {
            ...execution,
            dispositions: execution.dispositions.map((item) =>
              item.key === checkpoint.key
                ? { ...item, status: "failed" as const, reason }
                : item,
            ),
          },
          { ...checkpoint, stage: "failed" },
        );
        await this.transition(execution, failedExecution, input.resumeClaim);
        execution = failedExecution;
        notifyDurableCheckpoint(input, execution, false);
        continue;
      }
      let activeCheckpoint: InterpretedSourceEnrichmentCheckpoint;
      if (checkpoint.stage === "source-records-retained") {
        const interpreted = await this.interpretRetainedSourceEnrichment(
          checkpoint,
          records,
          execution.id,
          async (capability) => {
            execution = await this.freezeCapabilityParticipation(
              execution,
              [capability],
              input.resumeClaim,
            );
          },
        );
        activeCheckpoint = interpreted.checkpoint;
        const next = upsertSourceEnrichmentCheckpoint(
          execution,
          activeCheckpoint,
        );
        await this.transition(execution, next, input.resumeClaim);
        execution = next;
        notifyDurableCheckpoint(input, execution, false);
      } else {
        activeCheckpoint = checkpoint;
      }
      if (
        !activeCheckpoint.interpretation.sourceRecordIds.every(
          (sourceRecordId) =>
            records.some((record) => record.id === sourceRecordId),
        )
      )
        throw new Error("来源补充检查点缺少解释所需的来源记录");
      let managed = activeCheckpoint.managedSourceArtifacts ?? [];
      if (
        activeCheckpoint.stage === "association-interpreted" &&
        activeCheckpoint.sourceArtifacts.length > 0
      ) {
        const associationCheckpoint = activeCheckpoint;
        managed = await this.sourceArtifactWork.complete({
          candidates: associationCheckpoint.sourceArtifacts,
          interpretationSourceRecordIds:
            associationCheckpoint.interpretation.sourceRecordIds,
          sourceRecords: records,
          idempotencyKey: (candidate) =>
            sourceArtifactIdempotencyKey(execution.id, candidate),
          requireCheckpointStore: true,
          beforeEffect: input.beforeEffect,
          beforeAcquire: async (capability) => {
            execution = await this.freezeCapabilityParticipation(
              execution,
              [capability],
              input.resumeClaim,
            );
          },
          onAcquired: async (acquisitions) => {
            activeCheckpoint = {
              ...associationCheckpoint,
              stage: "source-artifact-acquired",
              sourceArtifactAcquisitions: acquisitions,
            };
            const next = upsertSourceEnrichmentCheckpoint(
              execution,
              activeCheckpoint,
            );
            await this.transition(execution, next, input.resumeClaim);
            execution = next;
            notifyDurableCheckpoint(input, execution, false);
          },
          onStored: async (stored) => {
            activeCheckpoint = {
              ...associationCheckpoint,
              stage: "source-artifact-stored",
              ...(activeCheckpoint.stage === "source-artifact-acquired"
                ? {
                    sourceArtifactAcquisitions:
                      activeCheckpoint.sourceArtifactAcquisitions,
                  }
                : {}),
              managedSourceArtifacts: stored,
            };
            const next = upsertSourceEnrichmentCheckpoint(
              execution,
              activeCheckpoint,
            );
            await this.transition(execution, next, input.resumeClaim);
            execution = next;
            notifyDurableCheckpoint(input, execution, false);
          },
        });
      } else if (activeCheckpoint.stage === "source-artifact-acquired") {
        const acquiredCheckpoint = activeCheckpoint;
        const acquisitions = acquiredCheckpoint.sourceArtifactAcquisitions;
        if (acquisitions === undefined)
          throw new Error("来源补充检查点缺少已暂存的来源产物");
        managed = await this.sourceArtifactWork.resumeStore({
          acquisitions,
          beforeEffect: input.beforeEffect,
          onStored: async (stored) => {
            activeCheckpoint = {
              ...acquiredCheckpoint,
              stage: "source-artifact-stored",
              managedSourceArtifacts: stored,
            };
            const next = upsertSourceEnrichmentCheckpoint(
              execution,
              activeCheckpoint,
            );
            await this.transition(execution, next, input.resumeClaim);
            execution = next;
            notifyDurableCheckpoint(input, execution, false);
          },
        });
      }
      const projected =
        managed.length === 0
          ? undefined
          : projectManagedSourceArtifacts(managed, activeCheckpoint.subjectId, {
              forceFallbackSubject: true,
            });
      const applied = upsertSourceEnrichmentCheckpoint(execution, {
        ...activeCheckpoint,
        stage: "applied",
        ...(managed.length === 0 ? {} : { managedSourceArtifacts: managed }),
      });
      const completed = {
        ...applied,
        dispositions: applied.dispositions.map((item) =>
          item.key === activeCheckpoint.key
            ? { ...item, status: "completed" as const }
            : item,
        ),
      };
      try {
        await persistence.applySourceEnrichment({
          expectedExecution: execution,
          execution: completed,
          expectedRecognitionBaseline: {
            sourceAssociationId:
              activeCheckpoint.subject.recognitionSourceAssociation.id,
            recognitionDecisionId:
              activeCheckpoint.subject.recognitionDecisionId,
          },
          assetId: activeCheckpoint.subjectId,
          sourceAssociation: activeCheckpoint.sourceAssociation,
          sourceRecords: records,
          interpretation: activeCheckpoint.interpretation,
          ...(projected === undefined ? {} : { managedArtifacts: projected }),
          resumeClaim: input.resumeClaim,
        });
        execution = completed;
      } catch (error) {
        rethrowWorkflowLifecycle(error);
        const reason = errorMessage(error);
        const failedExecution = upsertSourceEnrichmentCheckpoint(
          {
            ...execution,
            dispositions: execution.dispositions.map((item) =>
              item.key === activeCheckpoint.key
                ? { ...item, status: "failed" as const, reason }
                : item,
            ),
          },
          {
            ...activeCheckpoint,
            stage: "failed",
            collectionFailures: [],
          },
        );
        await this.transition(execution, failedExecution, input.resumeClaim);
        execution = failedExecution;
      }
      notifyDurableCheckpoint(input, execution, false);
    }
    return execution;
  }

  /** 只由文件系统入口持有的内部协调器。 */
  private async runFilesystemRecognition(input: {
    readonly scope: BoundObservedScope;
    readonly acceptTrusted: boolean;
    readonly informationRequirement?: InformationRequirement | undefined;
    readonly intent?: "scan-now" | "metadata-refresh" | undefined;
    readonly directedSourceAddress?: string | undefined;
    readonly directedSourceIdentity?: string | undefined;
    readonly executionId?: string | undefined;
    readonly automationIntentId?: string | undefined;
    readonly trigger?: WorkflowExecutionTrigger | undefined;
    readonly initiatedBy?: string | undefined;
    readonly configurationReferences?: readonly string[] | undefined;
    readonly requestedAt?: string | undefined;
    readonly onExecutionStarted?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly onProgress?: ((message: string) => void) | undefined;
    readonly onCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly onHostCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly operationKind: NonNullable<WorkflowExecution["operationKind"]>;
    readonly requestedSelection: AssetRefreshSelection;
    readonly resolvedSelection: ResolvedAssetRefreshSelection;
    readonly directedCurrent?: {
      readonly subjectId: string;
      readonly accepted: AcceptedRecognition;
      readonly execution: WorkflowExecution;
    };
  }): Promise<AssetRefreshInspection> {
    if (
      (input.directedSourceAddress === undefined) !==
      (input.directedSourceIdentity === undefined)
    ) {
      throw new Error("定向识别必须同时指定来源与精确地址");
    }
    if (input.resolvedSelection.filesystemScopes.length !== 1) {
      throw new Error(
        "Filesystem recognition requires one frozen registered filesystem scope",
      );
    }
    const [filesystemScope] = input.resolvedSelection.filesystemScopes;
    if (filesystemScope === undefined) {
      throw new Error("冻结文件范围在校验后不可读取");
    }
    const directory = filesystemScope.root;
    const trigger: WorkflowExecutionTrigger = input.trigger ?? "interactive";
    const initiatedBy =
      input.initiatedBy ??
      (input.automationIntentId === undefined
        ? "interactive"
        : `automation:${input.automationIntentId}`);
    const observationInitial: WorkflowExecution = {
      id: input.executionId ?? id("execution"),
      workflowInput: {
        version: "asset-refresh-input/1",
        trigger,
        initiatedBy,
        acceptTrusted: input.acceptTrusted,
        configurationReferences: [
          ...(input.configurationReferences ?? []),
          `recognition-policy/${this.ports.recognitionPolicy.version ?? "unversioned"}`,
        ].filter((value, index, values) => values.indexOf(value) === index),
        ...(() => {
          const observedRoots =
            input.resolvedSelection.filesystemScopes.flatMap((scope) =>
              scope.observedRoot === undefined ? [] : [scope.observedRoot],
            );
          return observedRoots.length === 0 ? {} : { observedRoots };
        })(),
      },
      selection: {
        directory,
        intent:
          input.directedSourceAddress === undefined
            ? (input.intent ?? "scan-now")
            : "directed-recognition",
        informationRequirement:
          input.informationRequirement ?? emptyInformationRequirement,
      },
      operationKind: input.operationKind,
      requestedSelection: input.requestedSelection,
      resolvedSelection: input.resolvedSelection,
      filesystemSnapshots: [],
      targetDispositions: [
        {
          key: `filesystem-scope:${directory}`,
          target: { kind: "filesystem-scope", root: directory },
          status: "running",
        },
      ],
      status: "running",
      stage: "recognition",
      sourceRecordIds: [],
      compatibility: this.compatibility(),
      dispositions: [{ key: "filesystem-observation", status: "running" }],
      ...(input.automationIntentId === undefined
        ? {}
        : { automationIntentId: input.automationIntentId }),
    };
    const startDisposition = await this.ports.executionCommands.createExecution(
      observationInitial,
      input.requestedAt,
    );
    if (startDisposition !== "started") {
      throw new AutomationExecutionNotStarted(startDisposition);
    }
    input.onExecutionStarted?.(observationInitial);
    let observationExecution = await this.freezeCapabilityParticipation(
      observationInitial,
      observedFilesystemCapabilities(this.ports.observedRootRegistrations),
    );
    let snapshot: FilesystemPackageSnapshot;
    try {
      snapshot = await this.ports.observedRootRegistrations.observeBoundScope(
        input.scope,
      );
    } catch (error) {
      const reason = errorMessage(error);
      const failed = terminal(
        filesystemPrerequisiteFailure(
          observationExecution,
          "filesystem-observation",
          reason,
          error,
        ),
        "failed",
        reason,
      );
      await this.transition(observationExecution, failed);
      return await this.inspectPublic(failed.id);
    }
    if (!snapshot.complete) {
      const observed: WorkflowExecution = {
        ...observationExecution,
        snapshot,
        filesystemSnapshots: [snapshot],
        targetDispositions: [
          {
            key: `filesystem-scope:${directory}`,
            target: { kind: "filesystem-scope", root: directory },
            status: "failed",
            reason: "Filesystem snapshot is incomplete",
          },
        ],
        reusePlan: this.ordinaryScanReusePlan(
          snapshot,
          [],
          input.informationRequirement ?? emptyInformationRequirement,
          observationInitial.workflowInput?.observedRoots,
        ),
        dispositions: [
          {
            key: "filesystem-observation",
            status: "failed",
            reason: "Filesystem snapshot is incomplete",
            ...(snapshotHasUnavailablePrerequisite(snapshot)
              ? { failureClassification: prerequisiteUnavailableFailure }
              : {}),
          },
        ],
      };
      const failed = terminal(
        observed,
        "failed",
        "Filesystem snapshot is incomplete",
      );
      await this.transition(observationExecution, observed);
      await this.transition(observed, failed);
      return await this.inspectPublic(failed.id);
    }
    let planningExecution: WorkflowExecution = {
      ...observationExecution,
      snapshot,
      filesystemSnapshots: [snapshot],
      dispositions: [{ key: "filesystem-observation", status: "completed" }],
    };
    await this.transition(observationExecution, planningExecution);
    notifyDurableCheckpoint(input, planningExecution, false);
    let packageBoundaries: {
      readonly observedArtifactBoundary: "filesystem-package";
      readonly observedArtifactBoundaryProducer: CapabilityCoordinate;
    }[] = [];
    const formatInterpretation: AssetRefreshWorkPlan[] = [];
    const directoryInterpretations: Array<
      ReturnType<DirectoryInterpreter["interpret"]>
    > = [];
    try {
      if (input.directedSourceAddress !== undefined) {
        for (const interpreter of this.ports.filesystemPackageInterpreters ??
          []) {
          planningExecution = await this.freezeCapabilityParticipation(
            planningExecution,
            [interpreter.capability],
          );
          const result = interpreter.interpretPackage(snapshot);
          if (result !== undefined)
            packageBoundaries.push({
              ...result,
              observedArtifactBoundaryProducer: interpreter.capability,
            });
        }
      }
      if (packageBoundaries.length > 1)
        throw new Error("多个文件系统包解析器声明了同一观察范围");
      for (const inspector of this.ports.formatInspectors ?? []) {
        /**
         * 格式检查器建立一个产物的事实，而不是该产物每个位置的事实。可靠观察器可以证明
         * 多个定位项属于同一文件系统对象，因此只检查一个稳定代表，同时在同一边界保留
         * 所有别名。这既避免重复资产／修订，也避免把重复别名证据伪装成独立来源证据。
         */
        const aliasesByObjectIdentity = new Map<string, FileObservation[]>();
        const inspectionGroups: Array<{
          readonly representative: FileObservation;
          readonly relativePaths: readonly string[];
        }> = [];
        for (const file of snapshot.files) {
          const identity = observedObjectIdentityKey(
            file,
            this.ports.observedRootRegistrations.objectIdentityContract,
          );
          if (identity === undefined) {
            inspectionGroups.push({
              representative: file,
              relativePaths: [file.relativePath],
            });
            continue;
          }
          const aliases = aliasesByObjectIdentity.get(identity) ?? [];
          aliases.push(file);
          aliasesByObjectIdentity.set(identity, aliases);
        }
        inspectionGroups.push(
          ...[...aliasesByObjectIdentity.values()].map((aliases) => {
            const ordered = aliases.toSorted((left, right) =>
              left.relativePath < right.relativePath
                ? -1
                : left.relativePath > right.relativePath
                  ? 1
                  : 0,
            );
            const [representative] = ordered;
            if (representative === undefined) {
              throw new Error("可靠文件身份组不可为空");
            }
            return {
              representative,
              relativePaths: ordered.map((file) => file.relativePath),
            };
          }),
        );
        for (const group of inspectionGroups) {
          planningExecution = await this.freezeCapabilityParticipation(
            planningExecution,
            [inspector.capability],
          );
          const byteSource = await this.openObservedByteSource(
            input.scope,
            group.representative.relativePath,
          );
          let evidence: readonly RecognitionEvidence[];
          try {
            evidence = bindRecognitionEvidenceOutputToProducer(
              await inspector.inspect({
                observedArtifactReference: group.representative.relativePath,
                byteSource,
              }),
              inspector.capability,
            );
          } finally {
            await byteSource.close();
          }
          if (evidence.length === 0) continue;
          formatInterpretation.push({
            workItems: [
              {
                key: `format:${inspector.capability.capabilityId}:${group.relativePaths[0]}`,
                relativePaths: group.relativePaths,
                evidence,
              },
            ],
          });
        }
      }
      if (
        input.intent !== "metadata-refresh" &&
        input.directedSourceAddress === undefined
      ) {
        for (const interpreter of this.ports.directoryInterpreters) {
          planningExecution = await this.freezeCapabilityParticipation(
            planningExecution,
            [interpreter.capability],
          );
          directoryInterpretations.push(
            bindRecognitionEvidenceOutputToProducer(
              interpreter.interpret(snapshot),
              interpreter.capability,
            ),
          );
        }
      }
      if (input.directedSourceAddress !== undefined) {
        planningExecution = await this.freezeCapabilityParticipation(
          planningExecution,
          [directedRecognitionEvidenceCapability],
        );
      }
    } catch (error) {
      const current = await this.ports.executionQueries.inspectExecution(
        planningExecution.id,
      );
      const reason = errorMessage(error);
      const failed = terminal(
        filesystemPrerequisiteFailure(
          current?.execution ?? planningExecution,
          "filesystem-byte-access",
          reason,
          error,
        ),
        "failed",
        reason,
      );
      await this.transition(current?.execution ?? planningExecution, failed);
      return await this.inspectPublic(failed.id);
    }
    const packageBoundary = packageBoundaries[0];
    const interpretations: readonly ReturnType<
      DirectoryInterpreter["interpret"]
    >[] =
      input.intent === "metadata-refresh" ||
      input.directedSourceAddress !== undefined
        ? []
        : [...directoryInterpretations, ...formatInterpretation];
    const hasExplicitWorkItems =
      packageBoundary !== undefined ||
      interpretations.some(isAssetRefreshWorkPlan);
    const directedWorkItems: readonly AssetRefreshWorkItemPlan[] =
      input.directedSourceAddress === undefined
        ? []
        : [
            {
              key: "directed-recognition",
              relativePaths: snapshot.files.map((file) => file.relativePath),
              ...(packageBoundary === undefined ? {} : packageBoundary),
              evidence: [
                {
                  kind: "directed-source-address",
                  sourceIdentity:
                    input.directedSourceIdentity ??
                    (() => {
                      throw new Error("定向识别缺少来源身份");
                    })(),
                  sourceAddress: input.directedSourceAddress,
                  explanation: "用户指定精确来源地址",
                  producer: directedRecognitionEvidenceCapability,
                },
              ],
            },
          ];
    const plannedWorkItems: readonly AssetRefreshWorkItemPlan[] =
      input.intent === "metadata-refresh"
        ? []
        : input.directedSourceAddress === undefined
          ? planRecognitionWorkItems(snapshot, interpretations)
          : directedWorkItems;
    const evidence = plannedWorkItems.flatMap((item) => item.evidence);
    const initial: WorkflowExecution = {
      ...planningExecution,
      reusePlan: this.ordinaryScanReusePlan(
        snapshot,
        evidence,
        input.informationRequirement ?? emptyInformationRequirement,
        observationInitial.workflowInput?.observedRoots,
      ),
      dispositions: [
        ...planningExecution.dispositions,
        { key: "directory-interpretation", status: "running" },
      ],
      ...(hasExplicitWorkItems
        ? {
            workItems: plannedWorkItems.map((item) => ({
              key: item.key,
              relativePaths: item.relativePaths,
              ...(item.observedArtifactBoundary === undefined
                ? {}
                : { observedArtifactBoundary: item.observedArtifactBoundary }),
              ...(item.observedArtifactBoundaryProducer === undefined
                ? {}
                : {
                    observedArtifactBoundaryProducer:
                      item.observedArtifactBoundaryProducer,
                  }),
              planningEvidence: item.evidence,
              reuseFingerprint: this.workItemReuseFingerprint(
                snapshot,
                item,
                input.informationRequirement ?? emptyInformationRequirement,
                observationInitial.workflowInput?.observedRoots,
              ),
              reuseCompatibility: this.compatibility([
                ...observedFilesystemCapabilities(
                  this.ports.observedRootRegistrations,
                ),
                ...item.evidence.map((evidence) => evidence.producer),
                ...(item.observedArtifactBoundaryProducer === undefined
                  ? []
                  : [item.observedArtifactBoundaryProducer]),
              ]),
              sourceRecordIds: [],
            })),
          }
        : {}),
    };
    await this.transition(planningExecution, initial);

    if (input.intent === "metadata-refresh") {
      return await this.refreshKnownAssociation(initial, {
        ...input,
        directory,
      });
    }

    input.onProgress?.("正在识别目录");

    if (hasExplicitWorkItems) {
      return await this.refreshPlannedWorkItems(
        initial,
        input,
        plannedWorkItems,
      );
    }

    const reusable =
      input.directedSourceAddress === undefined
        ? await this.ports.reuseQueries.findReusableOrdinaryScan({
            plan: initial.reusePlan!,
            availableCompatibility: this.availableCompatibility(),
          })
        : undefined;
    if (
      reusable?.acceptedAssetId !== undefined &&
      (await this.hasReusableManagedArtifacts(
        reusable,
        input.informationRequirement ?? emptyInformationRequirement,
      ))
    ) {
      const finished: WorkflowExecution = {
        ...initial,
        status: "completed",
        stage: "completed",
        outcome: "no-change",
        acceptedAssetId: reusable.acceptedAssetId,
        reusedExecutionId: reusable.id,
        reason: "目录观察和已满足的信息要求未变化，复用已接受结果",
        dispositions: initial.dispositions.map((item) => ({
          ...item,
          status: "no-change" as const,
          reason: "独立工作项基线均未变化",
        })),
      };
      await this.transition(initial, finished);
      return await this.inspectPublic(finished.id);
    }

    if (evidence.length === 0) {
      const finished = terminal(
        {
          ...initial,
          dispositions: initial.dispositions.map((item) => ({
            ...item,
            status: "completed" as const,
            reason: "未发现适用的目录识别线索",
          })),
        },
        "unresolved",
      );
      await this.transition(initial, finished);
      return await this.inspectPublic(finished.id);
    }

    const sourceRecords: SourceRecord[] = [];
    const collectionFailures: SourceCollectionFailure[] = [];
    let collectionExecution = initial;
    for (const currentEvidence of evidence) {
      const collectors = this.ports.collectors.filter((collector) =>
        collector.canCollect(currentEvidence),
      );
      for (const collector of collectors) {
        input.onProgress?.("正在获取官方来源");
        try {
          collectionExecution = await this.bindCollectorConfiguration(
            collectionExecution,
            collector,
            currentEvidence,
          );
          collectionExecution = await this.freezeCapabilityParticipation(
            collectionExecution,
            [collector.capability],
          );
          const collected = retainCollectedRecordProvenance(
            collector,
            await collector.collect(
              currentEvidence,
              this.collectionExecutionContext(collectionExecution),
            ),
          );
          sourceRecords.push(...collected.records);
          collectionFailures.push(...collected.failures);
          if (collected.records.length > 0) {
            const retainedExecution = executionWithRetainedSourceRecords(
              collectionExecution,
              collected.records,
            );
            await this.ports.executionCommands.retainSourceRecords({
              expectedExecution: collectionExecution,
              execution: retainedExecution,
              sourceRecords: collected.records,
            });
            collectionExecution = retainedExecution;
          }
        } catch (error) {
          collectionFailures.push({
            capability: collector.capability,
            reason: errorMessage(error),
          });
        }
      }
    }

    const blockingCollectionFailures = collectionFailures.filter((failure) =>
      collectionFailureBlocks(
        failure,
        input.informationRequirement ?? emptyInformationRequirement,
      ),
    );
    const collectionReason =
      collectionFailures.length === 0
        ? undefined
        : blockingCollectionFailures.length > 0
          ? "当前信息需求所需的官方来源工作项未完成"
          : partialCollectionReason(collectionFailures);
    const sourced: WorkflowExecution = {
      ...collectionExecution,
      stage: "source-records-retained",
      sourceRecordIds: collectionExecution.sourceRecordIds,
      dispositions: [
        { key: "directory-interpretation", status: "completed" },
        {
          key: "official-collection",
          status:
            blockingCollectionFailures.length > 0 ? "failed" : "completed",
          ...(collectionReason === undefined
            ? {}
            : { reason: collectionReason }),
          ...(blockingCollectionFailures.some(
            sourceCollectionFailureIsPrerequisiteUnavailable,
          )
            ? { failureClassification: prerequisiteUnavailableFailure }
            : {}),
        },
      ],
    };
    if (blockingCollectionFailures.length > 0) {
      const failed = terminal(
        sourced,
        "failed",
        blockingCollectionFailures.map((failure) => failure.reason).join("；"),
      );
      await this.transition(collectionExecution, failed);
      return await this.inspectPublic(failed.id);
    }
    await this.transition(collectionExecution, sourced);
    notifyDurableCheckpoint(input, sourced);

    try {
      let recognitionExecution = sourced;
      const batches: SourceInterpretationBatch[] = [];
      for (const interpreter of this.ports.sourceInterpreters) {
        if (!interpreter.canInterpret({ evidence, sourceRecords })) continue;
        recognitionExecution = await this.freezeCapabilityParticipation(
          recognitionExecution,
          [interpreter.capability],
        );
        batches.push(
          retainInterpretationProvenance(
            interpreter,
            interpreter.interpret({ evidence, sourceRecords }),
          ),
        );
      }
      const proposals: RecognitionProposal[] = [];
      for (const recognizer of this.ports.recognizers) {
        for (const interpretation of batches) {
          const recognizerInput = frozenRecognitionInput({
            evidence,
            interpretation,
          });
          if (!recognizer.canRecognize(recognizerInput.interpretation))
            continue;
          recognitionExecution = await this.freezeCapabilityParticipation(
            recognitionExecution,
            [recognizer.capability],
          );
          proposals.push(
            validateRecognitionProposalForRecords(
              attachObservedFormatFacts(
                bindRecognitionProposalToRecognizer(
                  recognizer,
                  recognizer.recognize(recognizerInput),
                  recognizerInput,
                ),
                recognizerInput.evidence,
              ),
              sourceRecords,
            ),
          );
        }
      }
      if (proposals.length === 0) {
        const finished = terminal(recognitionExecution, "unresolved");
        await this.transition(recognitionExecution, finished);
        return await this.inspectPublic(finished.id);
      }
      if (proposals.length > 1) {
        const finished = terminal(
          recognitionExecution,
          "unresolved",
          "同一识别边界存在多个候选身份",
        );
        await this.transition(recognitionExecution, finished);
        return await this.inspectPublic(finished.id);
      }
      const [proposal] = proposals;
      if (proposal === undefined) {
        throw new Error("唯一识别提案在校验后不可读取");
      }
      assertInterpretationSatisfiesInformationRequirement(
        proposal,
        input.informationRequirement ?? emptyInformationRequirement,
      );
      const preview = { ...recognitionExecution, proposalId: proposal.id };
      let current =
        input.directedCurrent ??
        (await this.ports.reuseQueries.findAcceptedForDirectory(directory));
      if (current === undefined && input.directedSourceAddress === undefined) {
        const exactObservedReuse =
          await this.currentAcceptedForObservedArtifacts(
            snapshot,
            this.ports.observedRootRegistrations.objectIdentityContract,
          );
        if (exactObservedReuse.status === "ambiguous") {
          const finished = terminal(
            preview,
            "unresolved",
            "可靠文件身份对应多个当前作品，无法安全重用",
          );
          await this.ports.executionCommands.finishExecutionWithProposal(
            recognitionExecution,
            finished,
            proposal,
          );
          notifyDurableCheckpoint(input, finished);
          return await this.inspectPublic(finished.id);
        }
        if (exactObservedReuse.status === "one") {
          current = {
            accepted: exactObservedReuse.accepted,
            execution: exactObservedReuse.execution,
          };
        }
      }
      const sameIdentity =
        current !== undefined &&
        current.accepted.sourceAssociation.sourceIdentity ===
          proposal.interpretation.sourceIdentity &&
        current.accepted.sourceAssociation.nativeAddress ===
          proposal.interpretation.sourceAddress;
      // 复用可能只因能力或请求信息坐标推进而未命中。只有普通观察或证据基线改变时，才把
      // 原本稳定的身份转为重新求值；定向识别保留自己的无变化路径。
      const ordinaryObservationOrEvidenceChanged =
        input.directedSourceAddress === undefined &&
        sameIdentity &&
        ordinaryObservationOrEvidenceBaselineChanged(
          current?.execution.reusePlan,
          initial.reusePlan,
        );
      const currentAccepted = ordinaryObservationOrEvidenceChanged
        ? current?.accepted
        : undefined;
      if (current !== undefined) {
        if (sameIdentity && currentAccepted === undefined) {
          const finished: WorkflowExecution = {
            ...preview,
            status: "completed",
            stage: "completed",
            outcome: "no-change",
            acceptedAssetId: current.accepted.entity.id,
            reason: "识别结果与当前已接受身份一致",
            dispositions: [
              ...preview.dispositions,
              {
                key: "recognition",
                status: "no-change",
                reason: "当前身份未变化",
              },
            ],
          };
          await this.transition(recognitionExecution, finished);
          return await this.inspectPublic(finished.id);
        }
        if (!sameIdentity) {
          const change = await this.changeImpactPreview({
            execution: recognitionExecution,
            current: current.accepted,
            proposal,
            sourceRecords,
          });
          const finished = terminal(
            { ...change.execution, proposalId: proposal.id },
            "proposal",
            "定向识别会取代当前身份；等待确认变更影响预演",
          );
          await this.ports.recognitionChangeImpact.finishExecutionWithChangeImpactPreview(
            {
              expectedExecution: change.execution,
              execution: finished,
              proposal,
              preview: change.preview,
            },
          );
          notifyDurableCheckpoint(input, finished);
          return await this.inspectPublic(finished.id);
        }
      }
      if (
        !input.acceptTrusted ||
        !proposal.ruleResults.some(
          (result) =>
            result.outcome === "satisfied" &&
            this.ports.recognitionPolicy.accepts(result),
        )
      ) {
        const finished = terminal(preview, "proposal");
        await this.ports.executionCommands.finishExecutionWithProposal(
          recognitionExecution,
          finished,
          proposal,
        );
        notifyDurableCheckpoint(input, finished);
        return await this.inspectPublic(finished.id);
      }

      const informationRequirement =
        input.informationRequirement ?? emptyInformationRequirement;
      const acceptedAsset: DigitalAsset = currentAccepted?.entity ?? {
        id: id("entity"),
        kind: "digital-asset",
      };
      const selectedArtifacts = selectSourceArtifacts(
        proposal,
        informationRequirement,
      ).map((candidate) =>
        resolveSourceArtifactSubject(candidate, acceptedAsset.id),
      );
      let acquisitionExecution: WorkflowExecution = recognitionExecution;
      input.onProgress?.(
        selectedArtifacts.length === 0
          ? "当前信息需求不需要获取来源产物"
          : "正在获取所需来源产物",
      );
      let acquiredExecution: WorkflowExecution | undefined;
      let storedExecution: WorkflowExecution | undefined;
      const managedArtifacts = await this.sourceArtifactWork.complete({
        candidates: selectedArtifacts,
        proposal,
        sourceRecords,
        idempotencyKey: (candidate) =>
          sourceArtifactIdempotencyKey(initial.id, candidate),
        requireCheckpointStore: false,
        beforeAcquire: async (capability) => {
          acquisitionExecution = await this.freezeCapabilityParticipation(
            acquisitionExecution,
            [capability],
          );
        },
        onAcquired: async (acquiredArtifacts) => {
          acquiredExecution = {
            ...acquisitionExecution,
            proposalId: proposal.id,
            stage: "source-artifacts-acquired",
            sourceArtifactAcquisitions: acquiredArtifacts,
            dispositions: [
              ...preview.dispositions,
              ...acquiredArtifacts.map((acquisition) => ({
                key: `source-artifact.acquire:${acquisition.role}`,
                status: "completed" as const,
                effectReference: acquisition.stagedReference,
              })),
              ...acquiredArtifacts.map((acquisition) => ({
                key: `source-artifact.store:${acquisition.role}`,
                status: "running" as const,
              })),
            ],
          };
          await this.transition(acquisitionExecution, acquiredExecution);
          acquisitionExecution = acquiredExecution;
          notifyDurableCheckpoint(input, acquiredExecution);
        },
        onStored: async (storedArtifacts) => {
          if (acquiredExecution === undefined)
            throw new Error(
              "Source-artifact acquisition checkpoint was skipped",
            );
          const completedStorageExecution: WorkflowExecution = {
            ...acquiredExecution,
            stage: "source-artifacts-stored",
            managedSourceArtifacts: storedArtifacts,
            dispositions: acquiredExecution.dispositions.map((item) =>
              completeManagedStoreDisposition(item, storedArtifacts),
            ),
          };
          storedExecution = completedStorageExecution;
          await this.transition(acquiredExecution, completedStorageExecution);
          notifyDurableCheckpoint(input, completedStorageExecution);
        },
      });
      if (storedExecution === undefined)
        throw new Error("Source-artifact storage checkpoint was skipped");
      let executionForAcceptance = storedExecution;
      const managedObservedParts = await this.materializeObservedArtifactParts(
        proposal,
        snapshot,
        informationRequirement,
        input.scope,
        async (capability) => {
          executionForAcceptance = await this.freezeCapabilityParticipation(
            executionForAcceptance,
            [capability],
          );
        },
      );
      const accepted = createAcceptedRecognition({
        proposal,
        snapshot,
        managedArtifacts,
        asset: acceptedAsset,
        managedObservedParts,
        ...(this.ports.observedRootRegistrations.objectIdentityContract ===
        undefined
          ? {}
          : {
              objectIdentityContract:
                this.ports.observedRootRegistrations.objectIdentityContract,
            }),
        ...(currentAccepted === undefined ? {} : { current: currentAccepted }),
      });
      // 接受建立不可变识别身份，但配置的可选来源进行补充期间，父执行刻意保持运行中。
      // 来源补充绝不是第二次元数据刷新执行。
      const lastPersistedExecution = persistedWorkflowExecution(
        executionForAcceptance,
      );
      const acceptedExecution: WorkflowExecution = {
        ...lastPersistedExecution,
        status: "running",
        stage: "source-artifacts-stored",
        acceptedAssetId: accepted.entity.id,
      };
      if (currentAccepted === undefined) {
        validateAcceptedRecognition(accepted);
        await this.ports.recognitionAcceptance.acceptRecognition({
          expectedExecution: lastPersistedExecution,
          execution: acceptedExecution,
          accepted,
          metadataPolicyIds: this.metadataPolicyIdsFor(accepted),
        });
      } else {
        validateReevaluatedRecognition({
          current: currentAccepted,
          accepted,
        });
        const expectedLineageHeads =
          await this.ports.metadataRefreshPersistence.freezeSourceLineageHeads({
            assetId: currentAccepted.entity.id,
            sourceAssociation: currentAccepted.sourceAssociation,
            coverageIds: [
              ...new Set(sourceRecords.map((record) => record.coverage.id)),
            ],
          });
        await this.ports.recognitionReevaluation.refreshAcceptedRecognition({
          expectedExecution: lastPersistedExecution,
          execution: acceptedExecution,
          current: currentAccepted,
          accepted,
          sourceRecords,
          expectedLineageHeads,
        });
      }
      const enrichment = await this.enrichAcceptedSubjectsInExecution({
        execution: acceptedExecution,
        selection: {
          version: assetRefreshSelectionVersion,
          subjects: [
            {
              subjectId: accepted.entity.id,
              explanations: [{ path: ["accepted recognition"] }],
            },
          ],
          filesystemScopes: [],
        },
        informationRequirement,
        onProgress: input.onProgress,
        onCheckpoint: input.onCheckpoint,
        onHostCheckpoint: input.onHostCheckpoint,
      });
      const finished: WorkflowExecution = {
        ...enrichment.execution,
        status: "completed",
        stage: "completed",
        outcome: enrichment.failed > 0 ? "partially-succeeded" : "accepted",
        ...(enrichment.failed === 0
          ? {}
          : {
              reason: `${enrichment.failed} 个来源补充未完成；成功范围已保留`,
            }),
      };
      await this.transition(enrichment.execution, finished);
      return await this.inspectPublic(finished.id);
    } catch (error) {
      rethrowWorkflowLifecycle(error);
      const current = await this.ports.executionQueries.inspectExecution(
        initial.id,
      );
      const failed = terminal(
        current?.execution ?? sourced,
        "failed",
        errorMessage(error),
      );
      // 即使后续检查失败，条件提交也可能已经成功。绝不能把已接受历史改写为失败。
      if (current?.execution.outcome === "accepted")
        return publicInspection(
          current,
          this.ports.metadataPolicyConfiguration,
        );
      await this.transition(current?.execution ?? sourced, failed);
      return await this.inspectPublic(failed.id);
    }
  }

  private async refreshPlannedWorkItems(
    initial: WorkflowExecution,
    input: {
      /** 生成 `initial` 的同一个描述符绑定权威。 */
      readonly scope?: BoundObservedScope | undefined;
      readonly acceptTrusted: boolean;
      readonly informationRequirement?: InformationRequirement | undefined;
      readonly onProgress?: ((message: string) => void) | undefined;
      readonly onCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
      readonly onHostCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
    },
    plans: readonly AssetRefreshWorkItemPlan[],
    resumeClaim?: { readonly token: string; readonly now: string },
    sharedManagedArtifacts = new Map<string, ManagedSourceArtifactCheckpoint>(),
  ): Promise<AssetRefreshInspection> {
    const requirement =
      input.informationRequirement ?? emptyInformationRequirement;
    let execution: WorkflowExecution = {
      ...initial,
      dispositions: [
        { key: "directory-interpretation", status: "completed" },
        ...plans.map((item) => {
          const prior = initial.workItems?.find(
            (current) => current.key === item.key,
          );
          return {
            key: `work-item:${item.key}`,
            status:
              prior?.outcome === "failed"
                ? ("failed" as const)
                : prior?.outcome === "no-change"
                  ? ("no-change" as const)
                  : prior?.outcome === undefined
                    ? ("running" as const)
                    : ("completed" as const),
            ...(prior?.reason === undefined ? {} : { reason: prior.reason }),
          };
        }),
      ],
    };
    const sourceArtifactDefinitions = new Map<string, string>();
    const sourceArtifactDefinitionConflicts = new Map<string, string>();
    /** 来源为一个精确已解析实体声明的产物构成一个事实。 */
    const committedSharedArtifactServeKeys = new Set<string>();
    /**
     * 一次执行可以规划多个依赖同一已声明来源范围的边界。共享刻意限制在本次冻结执行：
     * 它避免重复外部读取，同时不会变成过期的跨执行采集器缓存或提供方专用工作流分支。
     */
    const sharedSourceCollections = new Map<
      string,
      Promise<SourceCollectionResult>
    >();
    await this.transition(initial, execution, resumeClaim);
    const persisted = await this.ports.executionQueries.inspectExecution(
      initial.id,
    );
    const freezeWorkItemCapability = async (
      key: string,
      capability: CapabilityCoordinate,
    ): Promise<void> => {
      const current = await this.ports.executionQueries.inspectExecution(
        execution.id,
      );
      const durable = current?.execution ?? execution;
      const workItems = durable.workItems;
      const item = workItems?.find((candidate) => candidate.key === key);
      if (item === undefined)
        throw new Error(`Unknown recognition work item ${key}`);
      if (workItems === undefined)
        throw new Error(`Recognition work items are missing for ${key}`);
      const next: WorkflowExecution = {
        ...this.retainCapabilityParticipation(durable, [capability]),
        workItems: workItems.map((candidate) =>
          candidate.key === key
            ? this.retainWorkItemCapabilityParticipation(candidate, [
                capability,
              ])
            : candidate,
        ),
      };
      if (JSON.stringify(next) === JSON.stringify(durable)) {
        execution = durable;
        return;
      }
      await this.transition(durable, next, resumeClaim);
      execution = next;
    };
    for (const inspection of persisted?.workItemInspections ?? []) {
      if (inspection.proposal !== undefined) {
        try {
          registerSourceArtifactDefinitions(
            sourceArtifactDefinitions,
            inspection.proposal.interpretation.sourceArtifacts,
          );
        } catch (error) {
          sourceArtifactDefinitionConflicts.set(
            inspection.proposal.id,
            errorMessage(error),
          );
        }
      }
      for (const managed of inspection.workItem.managedSourceArtifacts ?? []) {
        const rawCandidate =
          inspection.proposal?.interpretation.sourceArtifacts.find((item) =>
            checkpointMatchesCandidateExceptSubject(managed, item),
          );
        const acceptedAssetId =
          inspection.accepted?.entity.id ??
          inferCheckpointedAcceptedAssetId(
            inspection.proposal?.interpretation.sourceArtifacts ?? [],
            [
              ...(inspection.workItem.sourceArtifactAcquisitions ?? []),
              ...(inspection.workItem.managedSourceArtifacts ?? []),
            ],
          );
        const candidate =
          rawCandidate === undefined || acceptedAssetId === undefined
            ? rawCandidate
            : resolveSourceArtifactSubject(rawCandidate, acceptedAssetId);
        if (
          candidate !== undefined &&
          managedSourceArtifactMatchesCandidate(managed, candidate)
        ) {
          sharedManagedArtifacts.set(
            sourceArtifactCacheKey(candidate),
            managed,
          );
          if (inspection.workItem.outcome === "accepted")
            committedSharedArtifactServeKeys.add(
              sourceArtifactCacheKey(candidate),
            );
        }
      }
    }
    for (const plan of plans) {
      if (
        execution.workItems?.find((item) => item.key === plan.key)?.outcome !==
        undefined
      ) {
        continue;
      }
      const reusable = await this.ports.reuseQueries.findReusableWorkItem({
        directory: requiredFilesystemDirectory(initial),
        relativePaths: plan.relativePaths,
        availableCompatibility: this.availableCompatibility(),
        reuseFingerprint:
          execution.workItems?.find((item) => item.key === plan.key)
            ?.reuseFingerprint ??
          this.workItemReuseFingerprint(
            requiredFilesystemSnapshot(initial),
            plan,
            requirement,
            initial.workflowInput?.observedRoots,
          ),
      });
      if (
        reusable !== undefined &&
        (await this.acceptedSatisfiesInformationRequirement(
          reusable.accepted,
          requirement,
        ))
      ) {
        execution = completeWorkItem(execution, plan.key, {
          sourceRecordIds: [],
          proposalId: reusable.accepted.proposal.id,
          acceptedAssetId: reusable.accepted.entity.id,
          outcome: "no-change",
          reason: "工作项边界、兼容坐标和已满足的信息要求未变化",
          // 无变化执行从复用项推导结果，因此必须保留该项完整的实际依赖闭包。否则它会
          // 成为更新但更弱的候选，可能掩盖采集器／解释器／识别器／获取器工作的升级。
          reuseCompatibility: reusable.reuseCompatibility,
        });
        await this.transitionAfterWorkItem(execution, resumeClaim);
        notifyDurableCheckpoint(input, execution, false);
        continue;
      }
      const frozenSnapshot = requiredFilesystemSnapshot(initial);
      const itemSnapshot = {
        ...frozenSnapshot,
        files: frozenSnapshot.files.filter((file) =>
          plan.relativePaths.includes(file.relativePath),
        ),
      };
      const prior = execution.workItems?.find((item) => item.key === plan.key);
      const persistedInspection = persisted?.workItemInspections?.find(
        (item) => item.workItem.key === plan.key,
      );
      const records: SourceRecord[] =
        prior?.proposalId === undefined
          ? []
          : (persisted?.sourceRecords.filter((record) =>
              prior.sourceRecordIds.includes(record.id),
            ) ?? []);
      const failures: SourceCollectionFailure[] = [];
      if (prior?.proposalId === undefined) {
        for (const evidence of plan.evidence) {
          for (const collector of this.ports.collectors.filter((candidate) =>
            candidate.canCollect(evidence),
          )) {
            try {
              input.onProgress?.("正在获取官方来源");
              const sharedKey = sourceCollectionShareKey(collector, evidence);
              const durablyShared =
                sharedKey === undefined
                  ? []
                  : persistedSharedCollectionRecords(
                      persisted,
                      plans,
                      collector,
                      sharedKey,
                    );
              if (durablyShared.length > 0) {
                records.push(...durablyShared);
                continue;
              }
              execution = await this.bindCollectorConfiguration(
                execution,
                collector,
                evidence,
                resumeClaim,
              );
              await freezeWorkItemCapability(plan.key, collector.capability);
              const collectionContext =
                this.collectionExecutionContext(execution);
              const collected = retainCollectedRecordProvenance(
                collector,
                sharedKey === undefined
                  ? await collector.collect(evidence, collectionContext)
                  : await (sharedSourceCollections.get(sharedKey) ??
                      (() => {
                        const scopedEvidence = plans
                          .flatMap((plan) => plan.evidence)
                          .filter(
                            (candidate) =>
                              collector.canCollect(candidate) &&
                              sourceCollectionShareKey(collector, candidate) ===
                                sharedKey,
                          );
                        const pending =
                          collector.collectShared?.(
                            scopedEvidence,
                            collectionContext,
                          ) ?? collector.collect(evidence, collectionContext);
                        sharedSourceCollections.set(sharedKey, pending);
                        return pending;
                      })()),
              );
              records.push(...collected.records);
              failures.push(...collected.failures);
            } catch (error) {
              rethrowWorkflowLifecycle(error);
              failures.push({
                capability: collector.capability,
                reason: errorMessage(error),
              });
            }
          }
        }
        if (records.length > 0) {
          const retainedExecution = executionWithRetainedSourceRecords(
            execution,
            records,
          );
          await this.ports.executionCommands.retainSourceRecords({
            expectedExecution: execution,
            execution: retainedExecution,
            sourceRecords: records,
            ...(resumeClaim === undefined ? {} : { resumeClaim }),
          });
          execution = retainedExecution;
          notifyDurableCheckpoint(input, execution, false);
        }
      }
      const recordIds = records.map((record) => record.id);
      const blocking = failures.filter((failure) =>
        collectionFailureBlocks(failure, requirement),
      );
      if (blocking.length > 0) {
        execution = completeWorkItem(execution, plan.key, {
          sourceRecordIds: recordIds,
          outcome: "failed",
          reason: blocking.map((failure) => failure.reason).join("；"),
          ...(blocking.some(sourceCollectionFailureIsPrerequisiteUnavailable)
            ? { failureClassification: prerequisiteUnavailableFailure }
            : {}),
        });
        await this.transitionAfterWorkItem(execution, resumeClaim);
        notifyDurableCheckpoint(input, execution, false);
        continue;
      }
      try {
        const proposals: readonly RecognitionProposal[] =
          persistedInspection?.proposal === undefined
            ? await this.recognizePlannedWorkItem({
                evidence: plan.evidence,
                sourceRecords: records,
                beforeInterpret: async (capability) =>
                  await freezeWorkItemCapability(plan.key, capability),
                beforeRecognize: async (capability) =>
                  await freezeWorkItemCapability(plan.key, capability),
              })
            : [persistedInspection.proposal];
        if (proposals.length !== 1) {
          execution = completeWorkItem(execution, plan.key, {
            sourceRecordIds: recordIds,
            outcome: "unresolved",
            reason:
              proposals.length > 1
                ? "同一工作项边界存在多个识别提案"
                : "没有可接受的识别提案",
          });
          await this.transitionAfterWorkItem(execution, resumeClaim);
          notifyDurableCheckpoint(input, execution, false);
          continue;
        }
        const [proposal] = proposals;
        if (proposal === undefined) {
          throw new Error("唯一工作项识别提案在校验后不可读取");
        }
        assertInterpretationSatisfiesInformationRequirement(
          proposal,
          requirement,
        );
        if (
          !input.acceptTrusted ||
          !proposal.ruleResults.some(
            (result) =>
              result.outcome === "satisfied" &&
              this.ports.recognitionPolicy.accepts(result),
          )
        ) {
          if (prior?.proposalId === undefined) {
            const expectedExecution = execution;
            execution = checkpointWorkItem(execution, plan.key, {
              sourceRecordIds: recordIds,
              proposalId: proposal.id,
            });
            await this.ports.executionCommands.finishExecutionWithProposal(
              expectedExecution,
              execution,
              proposal,
              resumeClaim,
            );
          }
          const expectedExecution = execution;
          execution = completeWorkItem(execution, plan.key, {
            sourceRecordIds: recordIds,
            proposalId: proposal.id,
            outcome: "proposal",
            reason: "等待识别决策",
          });
          await this.ports.executionCommands.finishExecutionWithProposal(
            expectedExecution,
            execution,
            proposal,
            resumeClaim,
          );
          notifyDurableCheckpoint(input, execution, false);
          continue;
        }
        let currentAccepted =
          await this.ports.reuseQueries.findAcceptedForWorkItem({
            directory: requiredFilesystemDirectory(initial),
            relativePaths: plan.relativePaths,
          });
        if (
          currentAccepted === undefined &&
          plan.observedArtifactBoundary === undefined
        ) {
          const exactObservedReuse =
            await this.currentAcceptedForObservedArtifacts(
              itemSnapshot,
              this.ports.observedRootRegistrations.objectIdentityContract,
            );
          if (exactObservedReuse.status === "ambiguous") {
            const expectedExecution = execution;
            execution = completeWorkItem(execution, plan.key, {
              sourceRecordIds: recordIds,
              proposalId: proposal.id,
              outcome: "unresolved",
              reason: "可靠文件身份对应多个当前作品，无法安全重用",
            });
            await this.ports.executionCommands.finishExecutionWithProposal(
              expectedExecution,
              execution,
              proposal,
              resumeClaim,
            );
            notifyDurableCheckpoint(input, execution, false);
            continue;
          }
          if (exactObservedReuse.status === "one") {
            currentAccepted = {
              accepted: exactObservedReuse.accepted,
              execution: exactObservedReuse.execution,
            };
          }
        }
        if (currentAccepted !== undefined) {
          const sameIdentity =
            currentAccepted.accepted.sourceAssociation.sourceIdentity ===
              proposal.interpretation.sourceIdentity &&
            currentAccepted.accepted.sourceAssociation.nativeAddress ===
              proposal.interpretation.sourceAddress;
          if (!sameIdentity) {
            const change = await this.changeImpactPreview({
              execution,
              current: currentAccepted.accepted,
              proposal,
              sourceRecords: records,
            });
            execution = completeWorkItem(change.execution, plan.key, {
              sourceRecordIds: recordIds,
              proposalId: proposal.id,
              outcome: "proposal",
              reason: "识别身份会取代当前工作项身份；等待确认变更影响预演",
            });
            await this.ports.recognitionChangeImpact.finishExecutionWithChangeImpactPreview(
              {
                expectedExecution: change.execution,
                execution,
                proposal,
                preview: change.preview,
                ...(resumeClaim === undefined ? {} : { resumeClaim }),
              },
            );
            notifyDurableCheckpoint(input, execution, false);
            continue;
          }
        }
        // 受信的明确工作项可以记录效果检查点，但在同一事务能够提交识别决策和所有已接受
        // 事实前，不得提交识别提议。恢复过程改从保留的来源记录重新推导提议。
        const managedArtifacts: ManagedSourceArtifactCheckpoint[] = [];
        const persistedDefinitionConflict =
          sourceArtifactDefinitionConflicts.get(proposal.id);
        if (persistedDefinitionConflict !== undefined)
          throw new Error(persistedDefinitionConflict);
        registerSourceArtifactDefinitions(
          sourceArtifactDefinitions,
          proposal.interpretation.sourceArtifacts,
        );
        const currentWorkItem = execution.workItems?.find(
          (item) => item.key === plan.key,
        );
        const acceptedAsset = currentAccepted?.accepted.entity ?? {
          id:
            inferCheckpointedAcceptedAssetId(
              selectSourceArtifacts(proposal, requirement),
              [
                ...(currentWorkItem?.sourceArtifactAcquisitions ?? []),
                ...(currentWorkItem?.managedSourceArtifacts ?? []),
              ],
            ) ?? id("entity"),
          kind: "digital-asset" as const,
        };
        for (const rawCandidate of selectSourceArtifacts(
          proposal,
          requirement,
        )) {
          const candidate = resolveSourceArtifactSubject(
            rawCandidate,
            acceptedAsset.id,
          );
          const sharedKey = sourceArtifactCacheKey(candidate);
          if (
            candidate.subjectId !== undefined &&
            committedSharedArtifactServeKeys.has(sharedKey)
          )
            continue;
          const shared = sharedManagedArtifacts.get(sharedKey);
          if (shared !== undefined) {
            managedArtifacts.push(shared);
            continue;
          }
          const alreadyManaged = currentWorkItem?.managedSourceArtifacts?.find(
            (item) => managedSourceArtifactMatchesCandidate(item, candidate),
          );
          if (alreadyManaged !== undefined) {
            sharedManagedArtifacts.set(sharedKey, alreadyManaged);
            managedArtifacts.push(alreadyManaged);
            continue;
          }
          if (
            this.ports.managedStore.stage === undefined ||
            this.ports.managedStore.storeStaged === undefined
          ) {
            throw new Error(
              "Multi-boundary source artifacts require resumable managed-store checkpoints",
            );
          }
          let acquisition = currentWorkItem?.sourceArtifactAcquisitions?.find(
            (item) => sourceArtifactCheckpointMatchesCandidate(item, candidate),
          );
          if (acquisition === undefined) {
            acquisition = (
              await this.sourceArtifactWork.acquireAndStage({
                candidate,
                proposal,
                sourceRecords: records,
                idempotencyKey: sourceArtifactIdempotencyKey(
                  `${initial.id}:${plan.key}`,
                  candidate,
                ),
                requireCheckpointStore: true,
                beforeAcquire: async (capability) =>
                  await freezeWorkItemCapability(plan.key, capability),
              })
            ).checkpoint;
            execution = checkpointWorkItem(execution, plan.key, {
              sourceRecordIds: recordIds,
              proposalId: proposal.id,
              sourceArtifactAcquisitions: [
                ...(prior?.sourceArtifactAcquisitions ?? []),
                acquisition,
              ],
            });
            await this.transitionAfterWorkItem(execution, resumeClaim);
            notifyDurableCheckpoint(input, execution, false);
          }
          const managed = await this.sourceArtifactWork.store({
            acquisition,
            requireCheckpointStore: true,
          });
          const sourceArtifactAcquisitions = execution.workItems?.find(
            (item) => item.key === plan.key,
          )?.sourceArtifactAcquisitions;
          execution = checkpointWorkItem(execution, plan.key, {
            sourceRecordIds: recordIds,
            proposalId: proposal.id,
            ...(sourceArtifactAcquisitions === undefined
              ? {}
              : { sourceArtifactAcquisitions }),
            managedSourceArtifacts: [
              ...(execution.workItems?.find((item) => item.key === plan.key)
                ?.managedSourceArtifacts ?? []),
              managed,
            ],
          });
          await this.transitionAfterWorkItem(execution, resumeClaim);
          notifyDurableCheckpoint(input, execution, false);
          sharedManagedArtifacts.set(sharedKey, managed);
          managedArtifacts.push(managed);
        }
        const managedObservedParts =
          await this.materializeObservedArtifactParts(
            proposal,
            itemSnapshot,
            requirement,
            input.scope,
            async (capability) =>
              await freezeWorkItemCapability(plan.key, capability),
          );
        const accepted = createAcceptedRecognition({
          proposal,
          snapshot: itemSnapshot,
          managedArtifacts,
          asset: acceptedAsset,
          managedObservedParts,
          ...(this.ports.observedRootRegistrations.objectIdentityContract ===
          undefined
            ? {}
            : {
                objectIdentityContract:
                  this.ports.observedRootRegistrations.objectIdentityContract,
              }),
          ...(plan.observedArtifactBoundary === undefined
            ? {}
            : { observedArtifactBoundary: plan.observedArtifactBoundary }),
          ...(currentAccepted === undefined
            ? {}
            : { current: currentAccepted.accepted }),
        });
        if (currentAccepted === undefined)
          validateAcceptedRecognition(accepted);
        else
          validateReevaluatedRecognition({
            current: currentAccepted.accepted,
            accepted,
          });
        const lastPersistedExecution = persistedWorkflowExecution(execution);
        execution = completeWorkItem(lastPersistedExecution, plan.key, {
          sourceRecordIds: recordIds,
          proposalId: proposal.id,
          acceptedAssetId: accepted.entity.id,
          outcome: "accepted",
        });
        if (currentAccepted === undefined) {
          await this.ports.recognitionAcceptance.acceptRecognition({
            expectedExecution: lastPersistedExecution,
            execution,
            accepted,
            metadataPolicyIds: this.metadataPolicyIdsFor(accepted),
            ...(resumeClaim === undefined ? {} : { resumeClaim }),
          });
        } else {
          const expectedLineageHeads =
            await this.ports.metadataRefreshPersistence.freezeSourceLineageHeads(
              {
                assetId: currentAccepted.accepted.entity.id,
                sourceAssociation: currentAccepted.accepted.sourceAssociation,
                coverageIds: [
                  ...new Set(records.map((record) => record.coverage.id)),
                ],
              },
            );
          await this.ports.recognitionReevaluation.refreshAcceptedRecognition({
            expectedExecution: lastPersistedExecution,
            execution,
            current: currentAccepted.accepted,
            accepted,
            sourceRecords: records,
            expectedLineageHeads,
            ...(resumeClaim === undefined ? {} : { resumeClaim }),
          });
        }
        for (const rawCandidate of selectSourceArtifacts(proposal, requirement))
          committedSharedArtifactServeKeys.add(
            sourceArtifactCacheKey(
              resolveSourceArtifactSubject(rawCandidate, acceptedAsset.id),
            ),
          );
      } catch (error) {
        rethrowWorkflowLifecycle(error);
        execution = completeWorkItem(execution, plan.key, {
          sourceRecordIds: recordIds,
          outcome: "failed",
          reason: errorMessage(error),
        });
        await this.transitionAfterWorkItem(execution, resumeClaim);
      }
      notifyDurableCheckpoint(input, execution);
    }
    const acceptedSubjectIds = [
      ...new Set(
        (execution.workItems ?? []).flatMap((item) =>
          item.outcome === "accepted" && item.acceptedAssetId !== undefined
            ? [item.acceptedAssetId]
            : [],
        ),
      ),
    ];
    let enrichment: {
      readonly execution: WorkflowExecution;
      readonly failed: number;
    };
    try {
      enrichment =
        acceptedSubjectIds.length === 0
          ? { execution, failed: 0 }
          : await this.enrichAcceptedSubjectsInExecution({
              execution,
              selection: {
                version: assetRefreshSelectionVersion,
                subjects: acceptedSubjectIds.map((subjectId) => ({
                  subjectId,
                  explanations: [{ path: ["accepted work item"] }],
                })),
                filesystemScopes: [],
              },
              informationRequirement: requirement,
              onProgress: input.onProgress,
              onCheckpoint: input.onCheckpoint,
              onHostCheckpoint: input.onHostCheckpoint,
              ...(resumeClaim === undefined ? {} : { resumeClaim }),
            });
    } catch (error) {
      // 检查点回调模拟进程中断，并刻意留下可恢复执行。候选规划属于普通端口失败，因此
      // 必须改为以终态记录最新耐久形态。
      rethrowWorkflowLifecycle(error);
      const failed = await this.failLatestEnrichmentPlanningExecution(
        execution,
        error,
        resumeClaim,
      );
      return await this.inspectPublic(failed.id);
    }
    execution = enrichment.execution;
    const workItemTerminal = terminalFromWorkItems(execution);
    const terminalExecution: WorkflowExecution =
      enrichment.failed === 0 || workItemTerminal.outcome !== "accepted"
        ? workItemTerminal
        : {
            ...workItemTerminal,
            outcome: "partially-succeeded",
            reason: `${enrichment.failed} 个来源补充未完成；成功工作项已保留`,
          };
    await this.transition(execution, terminalExecution, resumeClaim);
    return await this.inspectPublic(terminalExecution.id);
  }

  /**
   * 只有当每个观察文件都有观察器可靠的不透明对象身份契约支持时，才允许跨根复用。
   * 持久化端口通过当前材料关联解析这些确定性产物 ID；它无权从名称或字节推断连续性。
   */
  private async currentAcceptedForObservedArtifacts(
    snapshot: FilesystemPackageSnapshot,
    contract: FilesystemObjectIdentityContract | undefined,
  ): Promise<ObservedArtifactReuseMatch> {
    const artifactIds = exactObservedArtifactIds(snapshot, contract);
    if (artifactIds === undefined) return { status: "none" };
    return await this.ports.reuseQueries.findCurrentAcceptedForObservedArtifacts(
      { artifactIds },
    );
  }

  /**
   * 工作项识别刻意明确表达嵌套的解释器／识别器语义；调用方提供每次具体调用前必须存在的
   * 耐久检查点。
   */
  private async recognizePlannedWorkItem(input: {
    readonly evidence: readonly import("@digital/domain").RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
    readonly beforeInterpret: (
      capability: CapabilityCoordinate,
    ) => void | Promise<void>;
    readonly beforeRecognize: (
      capability: CapabilityCoordinate,
    ) => void | Promise<void>;
  }): Promise<readonly RecognitionProposal[]> {
    const proposals: RecognitionProposal[] = [];
    for (const recognizer of this.ports.recognizers) {
      for (const interpreter of this.ports.sourceInterpreters) {
        if (
          !interpreter.canInterpret({
            evidence: input.evidence,
            sourceRecords: input.sourceRecords,
          })
        )
          continue;
        await input.beforeInterpret(interpreter.capability);
        const interpretation = retainInterpretationProvenance(
          interpreter,
          interpreter.interpret({
            evidence: input.evidence,
            sourceRecords: input.sourceRecords,
          }),
        );
        const recognizerInput = frozenRecognitionInput({
          evidence: input.evidence,
          interpretation,
        });
        if (!recognizer.canRecognize(recognizerInput.interpretation)) continue;
        await input.beforeRecognize(recognizer.capability);
        proposals.push(
          validateRecognitionProposalForRecords(
            attachObservedFormatFacts(
              bindRecognitionProposalToRecognizer(
                recognizer,
                recognizer.recognize(recognizerInput),
                recognizerInput,
              ),
              recognizerInput.evidence,
            ),
            input.sourceRecords,
          ),
        );
      }
    }
    return proposals;
  }

  private async transitionAfterWorkItem(
    next: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void> {
    const current = await this.ports.executionQueries.inspectExecution(next.id);
    await this.transition(current?.execution ?? next, next, resumeClaim);
  }

  /** 只标识为具体请求候选选定的获取器。 */
  private acquirerCapabilitiesFor(
    candidates: readonly SourceArtifactCandidate[],
  ): readonly CapabilityCoordinate[] {
    return candidates.flatMap((candidate) => {
      const acquirer = this.ports.acquirers.find((current) =>
        current.canAcquire(candidate),
      );
      return acquirer === undefined ? [] : [acquirer.capability];
    });
  }

  private async materializeObservedArtifactParts(
    proposal: RecognitionProposal,
    snapshot: FilesystemPackageSnapshot,
    requirement: InformationRequirement,
    scope: BoundObservedScope | undefined,
    onCapabilityParticipated?: (
      capability: CapabilityCoordinate,
    ) => void | Promise<void>,
  ): Promise<readonly ManagedObservedArtifactPart[]> {
    const candidates = selectObservedArtifactParts(proposal, requirement);
    if (candidates.length > 0 && scope === undefined)
      throw new Error("刷新记录缺少可重新绑定的冻结文件位置");
    const selected = [];
    for (const candidate of candidates) {
      if (
        !snapshot.files.some(
          (file) => file.relativePath === candidate.observedArtifactReference,
        )
      )
        throw new Error(
          "Observed Artifact Part is outside the selected boundary",
        );
      const acquirer = this.ports.observedArtifactPartAcquirers?.find((item) =>
        item.canAcquire(candidate),
      );
      if (acquirer === undefined)
        throw new Error(
          "No capability can materialize the selected observed Artifact Part",
        );
      await onCapabilityParticipated?.(acquirer.capability);
      const byteSource = await this.openObservedByteSource(
        scope!,
        candidate.observedArtifactReference,
      );
      let acquired: Awaited<
        ReturnType<ObservedArtifactPartAcquirer["acquire"]>
      >;
      try {
        acquired = await acquirer.acquire({ candidate, byteSource });
      } finally {
        await byteSource.close();
      }
      if (
        acquired.candidateId !== candidate.id ||
        mediaTypeEssence(acquired.mediaType) !==
          mediaTypeEssence(candidate.mediaType)
      )
        throw new Error(
          "Observed Artifact Part acquisition contradicts its candidate",
        );
      const stored = await this.ports.managedStore.store({
        bytes: acquired.bytes,
        mediaType: acquired.mediaType,
      });
      selected.push({
        candidate,
        producer: acquirer.capability,
        blob: stored.blob,
        location: stored.location,
        origin: acquired.origin,
      });
    }
    return selected;
  }

  async inspect(
    executionId: string,
  ): Promise<AssetRefreshInspection | undefined> {
    const inspection =
      await this.ports.executionQueries.inspectExecution(executionId);
    if (inspection === undefined) return undefined;
    const preview =
      await this.ports.changeImpactQueries.inspectChangeImpactPreviewForExecution(
        executionId,
      );
    return {
      ...publicInspection(inspection, this.ports.metadataPolicyConfiguration),
      ...(preview === undefined
        ? {}
        : { changeImpactPreview: publicChangeImpactPreview(preview) }),
    };
  }

  /**
   * 明确停止一个运行中的工作流执行。来源刷新运行持有其未提交范围，因此先取消这些范围，
   * 但不通过公开来源刷新运行协调器反向投影其领域结果。任一过程已经提交的耐久记录仍为历史。
   */
  async cancel(input: {
    readonly executionId: string;
    readonly requestedBy: string;
    readonly requestedAt: string;
    readonly reason?: string;
  }): Promise<AssetRefreshInspection> {
    if (input.requestedBy.trim().length === 0)
      throw new Error("取消刷新需要请求者");
    if (input.requestedAt.trim().length === 0)
      throw new Error("取消刷新需要请求时间");
    if (!Number.isFinite(Date.parse(input.requestedAt)))
      throw new Error("取消刷新需要有效的 ISO 时间");

    const initial = await this.ports.executionQueries.inspectExecution(
      input.executionId,
    );
    if (initial === undefined) throw new Error("未找到刷新记录");
    if (initial.execution.status !== "running")
      throw new Error("只有未完成的刷新记录可以取消");

    const runIds = [...new Set(initial.execution.sourceRefreshRunIds ?? [])];
    if (runIds.length > 0) {
      const authority = this.ports.sourceRefreshRuns;
      if (authority === undefined) {
        throw new Error("Source Refresh Run authority is not configured");
      }
      for (const runId of runIds) {
        const run =
          initial.sourceRefreshRuns?.find(
            (candidate) => candidate.id === runId,
          ) ?? (await authority.inspectSourceRefreshRun(runId));
        if (run === undefined)
          throw new Error(`missing Source Refresh Run ${runId}`);
        if (run.phase !== "terminal")
          await authority.cancelSourceRefreshRun(run.id);
      }
    }

    // 来源刷新取消独立耐久化。在终态 CAS 前重新读取完整工作流执行审计，使迟到工作者既
    // 不能赢得本次取消，也不能赢得任何后续正式提交。
    const current = await this.ports.executionQueries.inspectExecution(
      input.executionId,
    );
    if (current === undefined) throw new Error("未找到刷新记录");
    if (current.execution.status !== "running")
      throw new Error("只有未完成的刷新记录可以取消");
    const cancellation: WorkflowExecutionCancellation = {
      requestedBy: input.requestedBy,
      requestedAt: input.requestedAt,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    const cancelled = terminal(
      { ...current.execution, cancellation },
      "cancelled",
      input.reason,
    );
    await this.ports.executionCommands.cancelExecution({
      expectedExecution: current.execution,
      execution: cancelled,
    });
    const inspection = await this.inspect(input.executionId);
    if (inspection === undefined) throw new Error("未找到刷新记录");
    return inspection;
  }

  /**
   * 对交付层安全的永久工作流历史查询。适配器先选择一个有界审计页面，再装载每条选中的
   * 结构化记录；绝不在 Application 中从全部执行重建页面。
   */
  async listWorkflowHistoryPage(
    input?: WorkflowHistoryPageRequest,
  ): Promise<WorkflowHistoryPage> {
    const queries = this.ports.workflowHistoryQueries;
    if (queries === undefined) {
      throw new Error("Workflow History page query is not configured");
    }
    const page = await queries.listWorkflowHistoryPage(
      boundedPageRequest(input, "Workflow History"),
    );
    return {
      items: page.items.map((item) => {
        const publicRecord = publicInspection(
          { execution: item.execution, sourceRecords: item.sourceRecords },
          this.ports.metadataPolicyConfiguration,
        );
        return {
          execution: publicRecord.execution,
          resultReferences: item.resultReferences,
          sourceRecords: publicRecord.sourceRecords,
          recognitionResults: item.proposals.map((proposal) => ({
            proposalId: proposal.id,
            explanation: proposal.ruleResults
              .map((result) => result.explanation)
              .join("；"),
            status: item.resultReferences.acceptedProposalIds.includes(
              proposal.id,
            )
              ? ("accepted" as const)
              : ("proposed" as const),
          })),
          sourceRefreshRuns: item.sourceRefreshRuns,
          changeImpactPreviews: item.changeImpactPreviews.map(
            publicChangeImpactPreview,
          ),
        };
      }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  /** 仅供兼容的完整历史查询。新的交付调用方使用上方有界页面契约。 */
  async listInspections(): Promise<readonly AssetRefreshInspection[]> {
    const executions = await this.ports.executionQueries.listExecutions();
    const inspections = await Promise.all(
      executions.map((execution) => this.inspect(execution.id)),
    );
    return inspections.filter(
      (inspection): inspection is AssetRefreshInspection =>
        inspection !== undefined,
    );
  }

  /**
   * 当前 Catalogue 始终区别于工作流历史。它通过 Application 投影一个权威且有界的
   * 已接受主体页面，绝不会公开 ORM 行或持久化句柄。
   */
  async listCurrentCataloguePage(
    input?: CurrentCataloguePageRequest,
  ): Promise<CurrentCataloguePage> {
    const queries = this.ports.currentCatalogueQueries;
    if (queries === undefined) {
      throw new Error("Current Catalogue page query is not configured");
    }
    const page = await queries.listCurrentCataloguePage(
      boundedPageRequest(input, "Current Catalogue"),
    );
    return {
      items: page.items.flatMap((accepted) => {
        const projected = publicAccepted(
          accepted,
          [],
          "asset.ordinary",
          this.ports.metadataPolicyConfiguration,
        );
        return projected === undefined ? [] : [projected];
      }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  /**
   * 可重建的当前审阅条件。普通终态审计结果本身刻意不会被推断为待处理事项。
   */
  async listCurrentAttentionPage(
    input?: CurrentAttentionPageRequest,
  ): Promise<CurrentAttentionPage> {
    const queries = this.ports.currentAttentionQueries;
    if (queries === undefined) {
      throw new Error("Current Attention page query is not configured");
    }
    return await queries.listCurrentAttentionPage(
      boundedPageRequest(input, "Current Attention"),
    );
  }

  /** 仅供兼容的完整当前 Catalogue 投影。 */
  async listCurrentCatalogue(): Promise<
    readonly NonNullable<AssetRefreshInspection["accepted"]>[]
  > {
    const current =
      (await this.ports.currentCatalogueQueries?.listCurrentCatalogue()) ?? [];
    return current.flatMap((accepted) => {
      const projected = publicAccepted(
        accepted,
        [],
        "asset.ordinary",
        this.ports.metadataPolicyConfiguration,
      );
      return projected === undefined ? [] : [projected];
    });
  }

  /**
   * 刷新沿已接受关联进行，绝不沿目录识别进行。中立关联证据刻意在此生成，而不是要求
   * 集成搜索或重新解释文件系统名称。
   */
  private async refreshKnownAssociation(
    initial: WorkflowExecution,
    input: {
      readonly directory: string;
      readonly onProgress?: ((message: string) => void) | undefined;
      readonly onCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
      readonly onHostCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
    },
  ): Promise<AssetRefreshInspection> {
    const existing = await this.ports.reuseQueries.findAcceptedForDirectory(
      input.directory,
    );
    if (existing === undefined) {
      const failed = terminal(
        initial,
        "failed",
        "所选范围没有可刷新的已关联来源",
      );
      await this.transition(initial, failed);
      return await this.inspectPublic(failed.id);
    }
    return await this.refreshAcceptedAssociation(initial, existing, input);
  }

  private async refreshAcceptedAssociation(
    unfrozenInitial: WorkflowExecution,
    existing: {
      readonly accepted: AcceptedAssetState;
      readonly execution: WorkflowExecution;
    },
    input: {
      readonly onProgress?: ((message: string) => void) | undefined;
      readonly informationRequirement?: InformationRequirement | undefined;
      readonly initiatedBy?: string | undefined;
      readonly reviewPolicy?: "automatic" | "review" | undefined;
      readonly onCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
      readonly onHostCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
    },
    targetKey?: string,
    sourceAssociation: SourceAssociation = existing.accepted.sourceAssociation,
    sourceScopeKey?: string,
  ): Promise<AssetRefreshInspection> {
    const initial = await this.freezeCapabilityParticipation(unfrozenInitial, [
      knownSourceAssociationEvidenceCapability,
    ]);
    if (this.ports.sourceRefreshRuns !== undefined) {
      return await this.refreshAcceptedAssociationThroughSourceRefreshRun(
        initial,
        existing,
        input,
        targetKey,
        sourceAssociation,
      );
    }
    const withSourceScope = (
      execution: WorkflowExecution,
      status: "running" | "completed" | "failed",
      reason?: string,
    ): WorkflowExecution => {
      if (sourceScopeKey === undefined) return execution;
      const current = execution.dispositions.find(
        (item) => item.key === sourceScopeKey,
      );
      const disposition = {
        key: sourceScopeKey,
        status,
        ...(reason === undefined ? {} : { reason }),
      };
      return {
        ...execution,
        dispositions:
          current === undefined
            ? [...execution.dispositions, disposition]
            : execution.dispositions.map((item) =>
                item.key === sourceScopeKey ? disposition : item,
              ),
      };
    };
    const associationEvidence: RecognitionEvidence = {
      kind: "source-association",
      sourceIdentity: sourceAssociation.sourceIdentity,
      sourceAddress: sourceAssociation.nativeAddress,
      explanation: "使用当前来源关联重新获取元数据",
      producer: knownSourceAssociationEvidenceCapability,
    };
    const evidence: readonly RecognitionEvidence[] = [associationEvidence];
    let expectedLineageHeads: MetadataRefreshSubmission["expectedLineageHeads"];
    const applicableCollectors = this.ports.collectors.filter((candidate) =>
      candidate.canCollect(associationEvidence),
    );
    try {
      const coverageIds = [
        ...new Set(
          applicableCollectors.flatMap((collector) => {
            if (collector.coverageScopeIds === undefined) {
              throw new Error("来源采集器未声明刷新覆盖范围");
            }
            return collector.coverageScopeIds(associationEvidence);
          }),
        ),
      ];
      if (coverageIds.length === 0) {
        throw new Error("没有来源采集器可处理当前来源关联");
      }
      expectedLineageHeads =
        await this.ports.metadataRefreshPersistence.freezeSourceLineageHeads({
          assetId: existing.accepted.entity.id,
          sourceAssociation,
          coverageIds,
        });
    } catch (error) {
      rethrowWorkflowLifecycle(error);
      const scoped = withSourceScope(initial, "failed", errorMessage(error));
      const failed =
        targetKey === undefined
          ? terminal(scoped, "failed", errorMessage(error))
          : completeTargetDisposition(
              scoped,
              targetKey,
              "failed",
              errorMessage(error),
            );
      await this.transition(initial, failed);
      return await this.inspectPublic(failed.id);
    }
    const sourceRecords: SourceRecord[] = [];
    const failures: SourceCollectionFailure[] = [];
    let collectionExecution = initial;
    for (const currentEvidence of evidence) {
      for (const collector of applicableCollectors) {
        input.onProgress?.("正在刷新已关联官方来源");
        try {
          collectionExecution = await this.bindCollectorConfiguration(
            collectionExecution,
            collector,
            currentEvidence,
          );
          collectionExecution = await this.freezeCapabilityParticipation(
            collectionExecution,
            [collector.capability],
          );
          const collected = retainCollectedRecordProvenance(
            collector,
            await collector.collect(
              currentEvidence,
              this.collectionExecutionContext(collectionExecution),
            ),
          );
          sourceRecords.push(...collected.records);
          failures.push(...collected.failures);
          if (collected.records.length > 0) {
            const retainedExecution = executionWithRetainedSourceRecords(
              collectionExecution,
              collected.records,
            );
            await this.ports.executionCommands.retainSourceRecords({
              expectedExecution: collectionExecution,
              execution: retainedExecution,
              sourceRecords: collected.records,
            });
            collectionExecution = retainedExecution;
          }
        } catch (error) {
          rethrowWorkflowLifecycle(error);
          failures.push({
            capability: collector.capability,
            reason: errorMessage(error),
          });
        }
      }
    }
    const sourced: WorkflowExecution = withSourceScope(
      {
        ...collectionExecution,
        stage: "source-records-retained",
        sourceRecordIds: collectionExecution.sourceRecordIds,
        acceptedAssetId: existing.accepted.entity.id,
        dispositions: [
          ...initial.dispositions,
          { key: "known-source-association", status: "completed" },
          {
            key: "official-metadata-refresh",
            status:
              failures.filter((failure) =>
                collectionFailureBlocks(
                  failure,
                  initial.selection.informationRequirement ??
                    emptyInformationRequirement,
                ),
              ).length === 0
                ? "completed"
                : "failed",
            ...(failures.length === 0
              ? {}
              : failures.some((failure) =>
                    collectionFailureBlocks(
                      failure,
                      initial.selection.informationRequirement ??
                        emptyInformationRequirement,
                    ),
                  )
                ? { reason: "当前信息需求所需的官方来源工作项未完成" }
                : { reason: partialCollectionReason(failures) }),
          },
        ],
      },
      "running",
    );
    const blockingFailures = failures.filter((failure) =>
      collectionFailureBlocks(
        failure,
        initial.selection.informationRequirement ?? emptyInformationRequirement,
      ),
    );
    if (blockingFailures.length > 0) {
      const reason = blockingFailures
        .map((failure) => failure.reason)
        .join("；");
      const scoped = withSourceScope(sourced, "failed", reason);
      const failed =
        targetKey === undefined
          ? terminal(scoped, "failed", reason)
          : completeTargetDisposition(
              scoped,
              targetKey,
              "failed",
              reason,
              sourceRecords.map((record) => record.id),
              sourceRecords.map((record) => record.id),
            );
      await this.transition(collectionExecution, failed);
      return await this.inspectPublic(failed.id);
    }
    await this.transition(collectionExecution, sourced);
    try {
      let interpretationExecution = sourced;
      const interpretations: SourceInterpretationBatch[] = [];
      for (const interpreter of this.ports.sourceInterpreters) {
        if (!interpreter.canInterpret({ evidence, sourceRecords })) continue;
        interpretationExecution = await this.freezeCapabilityParticipation(
          interpretationExecution,
          [interpreter.capability],
        );
        interpretations.push(
          retainInterpretationProvenance(
            interpreter,
            interpreter.interpret({ evidence, sourceRecords }),
          ),
        );
      }
      if (interpretations.length !== 1) {
        throw new Error("已关联来源未形成唯一完整的元数据解释");
      }
      const [interpretation] = interpretations;
      if (interpretation === undefined) {
        throw new Error("唯一来源解释在校验后不可读取");
      }
      validateSourceInterpretationBatch(interpretation);
      if (
        interpretation.sourceIdentity !== sourceAssociation.sourceIdentity ||
        interpretation.sourceAddress !== sourceAssociation.nativeAddress
      ) {
        throw new Error("元数据刷新不得更换来源关联或资产身份");
      }
      const completedBase: WorkflowExecution = {
        ...interpretationExecution,
        dispositions: [
          ...sourced.dispositions,
          { key: "scoped-source-lineage", status: "completed" },
        ],
      };
      const completed: WorkflowExecution = withSourceScope(
        targetKey === undefined
          ? {
              ...completedBase,
              status: "completed",
              stage: "completed",
              outcome: "accepted",
              reason: "已刷新当前来源关联的元数据",
            }
          : completeTargetDisposition(
              completedBase,
              targetKey,
              "completed",
              undefined,
              [
                existing.accepted.entity.id,
                ...sourceRecords.map((record) => record.id),
              ],
              sourceRecords.map((record) => record.id),
            ),
        "completed",
      );
      await this.ports.metadataRefreshPersistence.applyMetadataRefresh({
        expectedExecution: interpretationExecution,
        execution: completed,
        submission: {
          assetId: existing.accepted.entity.id,
          sourceAssociation,
          sourceRecords,
          interpretation,
          expectedLineageHeads,
        },
      });
      return await this.inspectPublic(completed.id);
    } catch (error) {
      rethrowWorkflowLifecycle(error);
      const current = await this.ports.executionQueries.inspectExecution(
        initial.id,
      );
      const base = current?.execution ?? sourced;
      const scoped = withSourceScope(base, "failed", errorMessage(error));
      const failed =
        targetKey === undefined
          ? terminal(scoped, "failed", errorMessage(error))
          : completeTargetDisposition(
              scoped,
              targetKey,
              "failed",
              errorMessage(error),
              sourceRecords.map((record) => record.id),
              sourceRecords.map((record) => record.id),
            );
      await this.transition(current?.execution ?? sourced, failed);
      return await this.inspectPublic(failed.id);
    }
  }

  /**
   * 生产刷新让工作流执行停留在协调边界。逐覆盖候选、审阅、比较并追加以及终态结果由
   * 来源刷新运行持有。
   */
  private async refreshAcceptedAssociationThroughSourceRefreshRun(
    initial: WorkflowExecution,
    existing: {
      readonly accepted: AcceptedAssetState;
      readonly execution: WorkflowExecution;
    },
    input: {
      readonly onProgress?: ((message: string) => void) | undefined;
      readonly informationRequirement?: InformationRequirement | undefined;
      readonly initiatedBy?: string | undefined;
      readonly reviewPolicy?: "automatic" | "review" | undefined;
      readonly onCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
      readonly onHostCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
    },
    targetKey: string | undefined,
    sourceAssociation: SourceAssociation,
  ): Promise<AssetRefreshInspection> {
    const authority = this.ports.sourceRefreshRuns;
    if (authority === undefined) {
      throw new Error("Source Refresh Run authority is not configured");
    }
    const associationEvidence: RecognitionEvidence = {
      kind: "source-association",
      sourceIdentity: sourceAssociation.sourceIdentity,
      sourceAddress: sourceAssociation.nativeAddress,
      explanation: "使用当前来源关联重新获取元数据",
      producer: knownSourceAssociationEvidenceCapability,
    };
    const evidence: readonly RecognitionEvidence[] = [associationEvidence];
    const applicableCollectors = this.ports.collectors.filter((collector) =>
      collector.canCollect(associationEvidence),
    );
    let collectorScopes: readonly {
      readonly collector: SourceCollector;
      readonly coverageIds: readonly string[];
    }[];
    let run: SourceRefreshRun;
    try {
      collectorScopes = applicableCollectors.flatMap((collector) => {
        if (collector.coverageScopeIds === undefined) {
          throw new Error("来源采集器未声明刷新覆盖范围");
        }
        const declaredCoverageIds =
          collector.coverageScopeIds(associationEvidence);
        const coverageIds = declaredCoverageIds;
        return coverageIds.length === 0 ? [] : [{ collector, coverageIds }];
      });
      const coverageIds = collectorScopes.flatMap((item) => item.coverageIds);
      if (coverageIds.length === 0) {
        throw new Error("没有来源采集器可处理当前来源关联");
      }
      if (new Set(coverageIds).size !== coverageIds.length) {
        throw new Error("多个来源采集器声明了同一刷新覆盖范围");
      }
      const baselineLineageHeads =
        await this.ports.metadataRefreshPersistence.freezeSourceLineageHeads({
          assetId: existing.accepted.entity.id,
          sourceAssociation,
          coverageIds,
        });
      const initiatedBy = input.initiatedBy ?? "system";
      const initiatedAt = new Date().toISOString();
      run = await authority.createSourceRefreshRun({
        executionId: initial.id,
        run: {
          id: id("source-refresh-run"),
          initiatedBy,
          initiatedAt,
          requestedSelection: {
            subjectId: existing.accepted.entity.id,
            sourceAssociationId: sourceAssociation.id,
            sourceIdentity: sourceAssociation.sourceIdentity,
            nativeAddress: sourceAssociation.nativeAddress,
            selectors: sourceRefreshSelectors(
              input.informationRequirement ??
                initial.selection.informationRequirement ??
                emptyInformationRequirement,
            ),
          },
          reviewPolicy: input.reviewPolicy ?? "automatic",
          baselineLineageHeads,
        },
      });
      notifyDurableCheckpoint(input, initial);
    } catch (error) {
      rethrowWorkflowLifecycle(error);
      const failed =
        targetKey === undefined
          ? terminal(initial, "failed", errorMessage(error))
          : completeTargetDisposition(
              initial,
              targetKey,
              "failed",
              errorMessage(error),
            );
      await this.transition(initial, failed);
      return await this.inspectPublic(failed.id);
    }

    const refreshAuthoritativeRun = async (): Promise<SourceRefreshRun> => {
      const current = await authority.inspectSourceRefreshRun(run.id);
      if (current === undefined) {
        throw new Error("Source Refresh Run disappeared during coordination");
      }
      run = current;
      return current;
    };
    const wasCancelled = (current: SourceRefreshRun) =>
      current.scopes.some((scope) => scope.outcome === "cancelled");
    const stopIfCancelled = async (): Promise<boolean> =>
      wasCancelled(await refreshAuthoritativeRun());
    const retainParticipation = async (
      capability: CapabilityCoordinate,
    ): Promise<void> => {
      const current = await this.ports.executionQueries.inspectExecution(
        initial.id,
      );
      if (current === undefined) throw new Error("刷新记录在提交后不可读取");
      const next = this.retainCapabilityParticipation(current.execution, [
        capability,
      ]);
      await this.transition(current.execution, next);
      notifyDurableCheckpoint(input, next);
    };

    const sourceRecords: SourceRecord[] = [];
    const failedCoverageReasons = new Map<string, string[]>();
    const recordFailure = (coverageIds: readonly string[], reason: string) => {
      for (const coverageId of coverageIds) {
        const reasons = failedCoverageReasons.get(coverageId) ?? [];
        failedCoverageReasons.set(coverageId, [...reasons, reason]);
      }
    };
    const successfulCoverageIds = (
      item: (typeof collectorScopes)[number],
      records: readonly SourceRecord[],
    ) =>
      new Set(
        records.flatMap((record) =>
          record.sourceIdentity === sourceAssociation.sourceIdentity &&
          record.nativeAddress === sourceAssociation.nativeAddress &&
          item.coverageIds.includes(record.coverage.id)
            ? [record.coverage.id]
            : [],
        ),
      );
    const failureTargets = (
      item: (typeof collectorScopes)[number],
      failure: SourceCollectionFailure,
      succeeded: ReadonlySet<string>,
    ): readonly string[] => {
      const coverage = failure.coverage;
      if (
        coverage !== undefined &&
        coverage.sourceIdentity === sourceAssociation.sourceIdentity &&
        coverage.nativeAddress === sourceAssociation.nativeAddress &&
        item.coverageIds.includes(coverage.coverageId)
      ) {
        return [coverage.coverageId];
      }
      // 旧版／无范围失败诊断刻意保持保守：返回的记录证明其精确声明范围已经成功，因此
      // 诊断只能关闭采集器尚未满足的范围。
      return item.coverageIds.filter(
        (coverageId) => !succeeded.has(coverageId),
      );
    };
    for (const item of collectorScopes) {
      input.onProgress?.("正在刷新已关联官方来源");
      try {
        for (const coverageId of item.coverageIds) {
          if (await stopIfCancelled())
            return await this.inspectPublic(initial.id);
          run = await authority.beginSourceRefreshScopeAcquisition({
            runId: run.id,
            coverage: {
              sourceIdentity: sourceAssociation.sourceIdentity,
              nativeAddress: sourceAssociation.nativeAddress,
              coverageId,
            },
          });
          notifyDurableCheckpoint(input, initial);
        }
        // 这里位于来源运行获取检查点之后、外部请求之前，因此恢复过程会记录真实采集器，
        // 而不会冻结仅仅完成配置的同级能力。
        const beforeConnectionBinding =
          await this.ports.executionQueries.inspectExecution(initial.id);
        if (beforeConnectionBinding === undefined)
          throw new Error("刷新记录在提交后不可读取");
        await this.bindCollectorConfiguration(
          beforeConnectionBinding.execution,
          item.collector,
          associationEvidence,
        );
        await retainParticipation(item.collector.capability);
        const atCollection = await this.ports.executionQueries.inspectExecution(
          initial.id,
        );
        if (atCollection === undefined)
          throw new Error("刷新记录在提交后不可读取");
        const collected = retainCollectedRecordProvenance(
          item.collector,
          await item.collector.collect(
            associationEvidence,
            this.collectionExecutionContext(atCollection.execution),
          ),
        );
        if (await stopIfCancelled())
          return await this.inspectPublic(initial.id);
        const collectedForRun = collected.records;
        sourceRecords.push(...collectedForRun);
        const succeeded = successfulCoverageIds(item, collectedForRun);
        for (const failure of collected.failures) {
          recordFailure(
            failureTargets(item, failure, succeeded),
            failure.reason,
          );
        }
      } catch (error) {
        rethrowWorkflowLifecycle(error);
        if (await stopIfCancelled())
          return await this.inspectPublic(initial.id);
        recordFailure(item.coverageIds, errorMessage(error));
      }
    }
    if (await stopIfCancelled()) return await this.inspectPublic(initial.id);
    if (sourceRecords.length > 0) {
      const current = await this.ports.executionQueries.inspectExecution(
        initial.id,
      );
      if (current === undefined) throw new Error("刷新记录在提交后不可读取");
      const retainedExecution = executionWithRetainedSourceRecords(
        current.execution,
        sourceRecords,
      );
      await this.ports.executionCommands.retainSourceRecords({
        expectedExecution: current.execution,
        execution: retainedExecution,
        sourceRecords,
      });
      notifyDurableCheckpoint(input, retainedExecution);
    }
    if (await stopIfCancelled()) return await this.inspectPublic(initial.id);

    const scopeForCoverage = (coverageId: string) =>
      run.scopes.find(
        (scope) =>
          scope.coverage.sourceIdentity === sourceAssociation.sourceIdentity &&
          scope.coverage.nativeAddress === sourceAssociation.nativeAddress &&
          scope.coverage.coverageId === coverageId,
      );
    const failScope = async (coverageId: string, reason: string) => {
      if (await stopIfCancelled()) return false;
      const scope = scopeForCoverage(coverageId);
      if (scope === undefined || scope.state === "terminal") return true;
      run = await authority.failSourceRefreshScope({
        runId: run.id,
        coverage: scope.coverage,
        outcome: "failed",
        reason,
      });
      notifyDurableCheckpoint(input, initial);
      return true;
    };
    for (const [coverageId, reasons] of failedCoverageReasons) {
      if (!(await failScope(coverageId, reasons.join("；"))))
        return await this.inspectPublic(initial.id);
    }

    const candidateForScope = (scope: SourceRefreshRun["scopes"][number]) =>
      sourceRecords.filter(
        (record) =>
          record.sourceIdentity === scope.coverage.sourceIdentity &&
          record.nativeAddress === scope.coverage.nativeAddress &&
          record.coverage.id === scope.coverage.coverageId,
      );
    for (const scope of run.scopes) {
      if (scope.state !== "acquiring") continue;
      const candidates = candidateForScope(scope);
      if (candidates.length !== 1) {
        if (
          !(await failScope(
            scope.coverage.coverageId,
            candidates.length === 0
              ? "来源采集器没有返回该覆盖范围的 Source Record"
              : "来源采集器为同一覆盖范围返回了多个 Source Record",
          ))
        )
          return await this.inspectPublic(initial.id);
      }
    }

    if (run.scopes.some((scope) => scope.state === "acquiring")) {
      try {
        const interpretations: SourceInterpretationBatch[] = [];
        for (const interpreter of this.ports.sourceInterpreters) {
          if (!interpreter.canInterpret({ evidence, sourceRecords })) continue;
          await retainParticipation(interpreter.capability);
          interpretations.push(
            retainInterpretationProvenance(
              interpreter,
              interpreter.interpret({ evidence, sourceRecords }),
            ),
          );
        }
        if (interpretations.length !== 1) {
          throw new Error("已关联来源未形成唯一完整的元数据解释");
        }
        const [interpretation] = interpretations;
        if (interpretation === undefined) {
          throw new Error("唯一来源刷新解释在校验后不可读取");
        }
        validateSourceInterpretationBatch(interpretation);
        if (
          interpretation.sourceIdentity !== sourceAssociation.sourceIdentity ||
          interpretation.sourceAddress !== sourceAssociation.nativeAddress
        ) {
          throw new Error("元数据刷新不得更换来源关联或资产身份");
        }
        for (const scope of run.scopes) {
          if (scope.state !== "acquiring") continue;
          const candidate = candidateForScope(scope)[0];
          if (candidate === undefined) continue;
          try {
            if (await stopIfCancelled())
              return await this.inspectPublic(initial.id);
            const staged = await authority.stageSourceRefreshChangeSet({
              runId: run.id,
              candidateSourceRecordId: candidate.id,
              interpretation: sourceRefreshInterpretationForRecord(
                interpretation,
                candidate.id,
              ),
            });
            run = staged;
            notifyDurableCheckpoint(input, initial);
            const stagedScope = run.scopes.find(
              (current) =>
                current.coverage.sourceIdentity ===
                  scope.coverage.sourceIdentity &&
                current.coverage.nativeAddress ===
                  scope.coverage.nativeAddress &&
                current.coverage.coverageId === scope.coverage.coverageId,
            );
            if (
              stagedScope?.state === "applying" &&
              stagedScope.changeSetId !== undefined
            ) {
              if (await stopIfCancelled())
                return await this.inspectPublic(initial.id);
              run = await authority.applySourceRefreshChangeSet({
                runId: run.id,
                changeSetId: stagedScope.changeSetId,
              });
              notifyDurableCheckpoint(input, initial);
            }
          } catch (error) {
            rethrowWorkflowLifecycle(error);
            if (
              !(await failScope(scope.coverage.coverageId, errorMessage(error)))
            )
              return await this.inspectPublic(initial.id);
          }
        }
      } catch (error) {
        rethrowWorkflowLifecycle(error);
        if (await stopIfCancelled())
          return await this.inspectPublic(initial.id);
        for (const scope of run.scopes) {
          if (scope.state === "acquiring") {
            if (
              !(await failScope(scope.coverage.coverageId, errorMessage(error)))
            )
              return await this.inspectPublic(initial.id);
          }
        }
      }
    }

    if (await stopIfCancelled()) return await this.inspectPublic(initial.id);

    const current = await this.ports.executionQueries.inspectExecution(
      initial.id,
    );
    if (current === undefined) throw new Error("刷新记录在提交后不可读取");
    const coordinated: WorkflowExecution = {
      ...current.execution,
      stage: "source-records-retained",
      acceptedAssetId: existing.accepted.entity.id,
    };
    await this.transition(current.execution, coordinated);
    notifyDurableCheckpoint(input, coordinated);

    if (targetKey === undefined) {
      const outcome =
        run.phase === "reviewing"
          ? ("proposal" as const)
          : run.outcome === "succeeded"
            ? ("accepted" as const)
            : run.outcome === "partially-succeeded"
              ? ("partially-succeeded" as const)
              : ("failed" as const);
      const finished: WorkflowExecution = {
        ...coordinated,
        status: outcome === "failed" ? "failed" : "completed",
        stage: outcome === "failed" ? "failed" : "completed",
        outcome,
        ...(outcome === "proposal"
          ? { reason: "Source Refresh Change Set 正在等待审阅" }
          : outcome === "failed"
            ? { reason: "当前来源刷新未完成" }
            : {}),
      };
      await this.transition(coordinated, finished);
      notifyDurableCheckpoint(input, finished);
      this.invalidateSourceArtifactFulfillmentForRuns([run]);
    }
    return await this.inspectPublic(initial.id);
  }

  /**
   * 变更集处置先改变领域权威运行状态。仍在运行的元数据刷新执行所引用的所有运行进入
   * 终态后，该协调器才投影实际 Application 结果。它绝不把临时领域结果写入工作流执行。
   */
  private async continueSourceRefreshRunExecution(
    runId: string,
    resumeClaim?: () => { readonly token: string; readonly now: string },
  ): Promise<void> {
    const execution = (await this.ports.executionQueries.listExecutions()).find(
      (candidate) => candidate.sourceRefreshRunIds?.includes(runId),
    );
    if (execution === undefined || execution.status !== "running") return;

    const inspection = await this.ports.executionQueries.inspectExecution(
      execution.id,
    );
    if (inspection === undefined || inspection.execution.status !== "running")
      return;
    const runs = inspection.sourceRefreshRuns ?? [];
    if (runs.some((run) => run.phase !== "terminal")) return;

    let coordinated = inspection.execution;
    for (const target of coordinated.targetDispositions ?? []) {
      if (target.target.kind !== "subject" || target.status !== "running")
        continue;
      const subjectId = target.target.subjectId;
      const targetRuns = runs.filter(
        (run) => run.requestedSelection.subjectId === subjectId,
      );
      if (targetRuns.length === 0) continue;
      const succeeded = targetRuns.some(sourceRefreshRunCoordinatesSuccess);
      const failed = targetRuns.some(sourceRefreshRunCoordinatesFailure);
      const completed = completeTargetDisposition(
        coordinated,
        target.key,
        succeeded ? "completed" : "failed",
        succeeded && failed
          ? "部分当前来源未完成；其他来源结果已保留"
          : undefined,
        targetRuns.map((run) => run.id),
      );
      await this.transition(coordinated, completed, resumeClaim?.());
      coordinated = completed;
    }

    const selection = coordinated.resolvedSelection;
    if (selection === undefined) {
      const failed = terminal(
        coordinated,
        "failed",
        "Source Refresh Execution 缺少冻结的主体选择",
      );
      await this.transition(coordinated, failed, resumeClaim?.());
      return;
    }
    let enrichment: Awaited<
      ReturnType<typeof this.enrichAcceptedSubjectsInExecution>
    >;
    try {
      enrichment = await this.enrichAcceptedSubjectsInExecution({
        execution: coordinated,
        selection,
        informationRequirement:
          coordinated.selection.informationRequirement ??
          emptyInformationRequirement,
        resumeClaim: resumeClaim?.(),
      });
    } catch (error) {
      await this.failLatestEnrichmentPlanningExecution(
        coordinated,
        error,
        resumeClaim?.(),
      );
      return;
    }
    coordinated = enrichment.execution;
    const completed =
      coordinated.targetDispositions?.filter(
        (target) =>
          target.status === "completed" ||
          target.status === "no-change" ||
          target.status === "reused",
      ).length ?? 0;
    const failed =
      coordinated.targetDispositions?.filter(
        (target) => target.status === "failed" || target.status === "blocked",
      ).length ?? 0;
    const failedSourceScopes = runs.filter(
      sourceRefreshRunCoordinatesFailure,
    ).length;
    const finished: WorkflowExecution = {
      ...coordinated,
      status: completed > 0 ? "completed" : "failed",
      stage: completed > 0 ? "completed" : "failed",
      outcome:
        completed === 0
          ? "failed"
          : enrichment.failed > 0 || failedSourceScopes > 0
            ? "partially-succeeded"
            : "accepted",
      ...(failed === 0 && enrichment.failed === 0 && failedSourceScopes === 0
        ? {}
        : {
            reason:
              enrichment.failed > 0
                ? `${enrichment.failed} 个来源补充未完成；成功范围已保留`
                : failedSourceScopes > 0
                  ? `${failedSourceScopes} 个当前来源未完成；成功范围已保留`
                  : `${failed} 个精确主体刷新未完成；成功 siblings 已保留`,
          }),
    };
    await this.transition(coordinated, finished, resumeClaim?.());
    this.invalidateSourceArtifactFulfillmentForRuns(runs);
  }

  async inspectRawSourceRecord(
    executionId: string,
    sourceRecordId: string,
  ): Promise<SourceRecord | undefined> {
    return await this.ports.executionQueries.inspectRawSourceRecord(
      executionId,
      sourceRecordId,
    );
  }

  /** 批准／拒绝一整份变更集，并且只对批准执行条件追加。 */
  async reviewSourceRefreshChangeSet(input: {
    readonly runId: string;
    readonly changeSetId: string;
    readonly disposition: "approved" | "rejected";
  }): Promise<SourceRefreshRun> {
    const authority = this.ports.sourceRefreshRuns;
    if (authority === undefined) {
      throw new Error("Source Refresh Run authority is not configured");
    }
    const reviewed = await authority.reviewSourceRefreshChangeSet(input);
    const scope = reviewed.scopes.find(
      (candidate) => candidate.changeSetId === input.changeSetId,
    );
    if (
      input.disposition !== "approved" ||
      scope?.state !== "applying" ||
      scope.changeSetId === undefined
    ) {
      await this.continueSourceRefreshRunExecution(reviewed.id);
      return reviewed;
    }
    const applied = await authority.applySourceRefreshChangeSet({
      runId: reviewed.id,
      changeSetId: scope.changeSetId,
    });
    await this.continueSourceRefreshRunExecution(applied.id);
    return applied;
  }

  /** 只取消未提交的来源刷新范围；已提交同级范围保留为历史。 */
  async cancelSourceRefreshRun(runId: string): Promise<SourceRefreshRun> {
    const authority = this.ports.sourceRefreshRuns;
    if (authority === undefined) {
      throw new Error("Source Refresh Run authority is not configured");
    }
    const cancelled = await authority.cancelSourceRefreshRun(runId);
    await this.continueSourceRefreshRunExecution(cancelled.id);
    return cancelled;
  }

  async inspectSourceRefreshRun(
    runId: string,
  ): Promise<SourceRefreshRun | undefined> {
    const authority = this.ports.sourceRefreshRuns;
    return authority === undefined
      ? undefined
      : await authority.inspectSourceRefreshRun(runId);
  }

  async inspectChangeImpactPreview(
    previewId: string,
  ): Promise<ChangeImpactPreviewInspection | undefined> {
    const preview =
      await this.ports.changeImpactQueries.inspectChangeImpactPreview(
        previewId,
      );
    return preview === undefined
      ? undefined
      : publicChangeImpactPreview(preview);
  }

  /** 确认刻意与获取和预览分离。 */
  async applyChangeImpactPreview(
    previewId: string,
  ): Promise<ChangeImpactPreview> {
    const preview =
      await this.ports.changeImpactQueries.inspectChangeImpactPreview(
        previewId,
      );
    if (preview === undefined) throw new Error("未找到变更影响预演");
    if (preview.status !== "awaiting-confirmation") {
      throw new Error("该变更影响预演不能再次应用");
    }
    if (preview.blockingConditions.length > 0) {
      throw new Error("存在阻塞条件，不能应用变更影响预演");
    }
    const result =
      await this.ports.changeImpactCommands.applyChangeImpactPreview(preview);
    return {
      ...preview,
      status: result === "applied" ? "applied" : "stale",
    };
  }

  async rejectChangeImpactPreview(
    previewId: string,
  ): Promise<ChangeImpactPreviewInspection> {
    const result =
      await this.ports.changeImpactCommands.rejectChangeImpactPreview(
        previewId,
      );
    const preview =
      await this.ports.changeImpactQueries.inspectChangeImpactPreview(
        previewId,
      );
    if (preview === undefined) throw new Error("未找到变更影响预演");
    return publicChangeImpactPreview({
      ...preview,
      status: result === "rejected" ? "rejected" : "stale",
    });
  }

  private async changeImpactPreview(input: {
    readonly execution: WorkflowExecution;
    readonly current: AcceptedAssetState;
    readonly proposal: RecognitionProposal;
    readonly sourceRecords: readonly SourceRecord[];
  }): Promise<{
    readonly execution: WorkflowExecution;
    readonly preview: ChangeImpactPreview;
  }> {
    let execution = input.execution;
    const fullBaseline =
      await this.ports.changeImpactCommands.freezeChangeImpactBaseline({
        assetId: input.current.entity.id,
        sourceAssociationId: input.current.sourceAssociation.id,
        recognitionDecisionId: input.current.recognitionDecision.id,
      });
    const blockingConditions: string[] = [];
    const currentSourceIdentities = new Set(
      (
        input.current.sourceAssociations ?? [input.current.sourceAssociation]
      ).map((association) => association.sourceIdentity),
    );
    const currentSourceRecordIds = new Set([
      ...input.current.proposal.interpretation.sourceRecordIds,
      ...(input.current.metadataSourceRecords ?? [])
        .filter((record) => currentSourceIdentities.has(record.sourceIdentity))
        .map((record) => record.id),
    ]);
    const isOwnedByCurrentAssociation = (ids: readonly string[] | undefined) =>
      ids !== undefined &&
      ids.length > 0 &&
      ids.every((sourceRecordId) => currentSourceRecordIds.has(sourceRecordId));
    const requirement =
      input.execution.selection.informationRequirement ??
      emptyInformationRequirement;
    const requestedArtifactRoles = new Set(
      requirement.artifactRoles.map((item) => item.role),
    );
    const retainedAssociations = input.current.artifactAssociations.filter(
      (association) =>
        !isOwnedByCurrentAssociation(association.sourceRecordIds) &&
        !(
          (association.sourceRecordIds === undefined ||
            association.sourceRecordIds.length === 0) &&
          requestedArtifactRoles.has(association.role)
        ),
    );
    const retainedArtifactIds = new Set(
      retainedAssociations.map((association) => association.artifactId),
    );
    const retainedArtifacts = input.current.artifacts.filter((artifact) =>
      retainedArtifactIds.has(artifact.id),
    );
    const retainedLocations = input.current.locations.filter((location) =>
      retainedArtifactIds.has(location.artifactId),
    );
    const retainedRevisions = input.current.artifactRevisions.filter(
      (revision) => retainedArtifactIds.has(revision.artifactId),
    );
    const retainedBlobDigests = new Set(
      retainedRevisions.map((revision) => revision.blobDigest),
    );
    const retainedBlobs = input.current.blobs.filter((blob) =>
      retainedBlobDigests.has(blob.digest),
    );
    const previewManagedArtifacts: ManagedSourceArtifactCheckpoint[] = [];
    try {
      for (const candidate of selectSourceArtifacts(
        input.proposal,
        requirement,
      )) {
        previewManagedArtifacts.push(
          await this.sourceArtifactWork.materializeDirect({
            candidate,
            proposal: input.proposal,
            sourceRecords: input.sourceRecords,
            beforeAcquire: async (capability) => {
              execution = await this.freezeCapabilityParticipation(execution, [
                capability,
              ]);
            },
          }),
        );
      }
    } catch (error) {
      blockingConditions.push(`信息需求未满足：${errorMessage(error)}`);
    }
    const projected = projectManagedSourceArtifacts(
      previewManagedArtifacts,
      input.current.entity.id,
      {
        freshId: id,
        forceFallbackSubject: true,
      },
    );
    const projectedArtifacts = projected.artifacts.map((artifact, index) => {
      const location = projected.locations[index];
      const blob = projected.blobs[index];
      const revision = projected.revisions[index];
      const association = projected.associations[index];
      if (
        location === undefined ||
        blob === undefined ||
        revision === undefined ||
        association === undefined
      ) {
        throw new Error("来源产物投影未保持平行事实集合");
      }
      return { artifact, location, blob, revision, association };
    });
    if (
      !input.proposal.ruleResults.some(
        (result) => result.outcome === "satisfied",
      )
    ) {
      blockingConditions.push("识别规则没有形成满足结果");
    }
    const retainedMetadata = input.current.metadata.filter(
      (assertion) => !isOwnedByCurrentAssociation(assertion.sourceRecordIds),
    );
    const retainedEntities = (input.current.entities ?? []).filter(
      (entity) => !isOwnedByCurrentAssociation(entity.sourceRecordIds),
    );
    const retainedMentions = (input.current.entityMentions ?? []).filter(
      (mention) => !isOwnedByCurrentAssociation(mention.sourceRecordIds),
    );
    const retainedResolutions = (
      input.current.entityResolutionDecisions ?? []
    ).filter(
      (decision) => !isOwnedByCurrentAssociation(decision.sourceRecordIds),
    );
    const retainedRelationships = (input.current.relationships ?? []).filter(
      (relationship) =>
        !isOwnedByCurrentAssociation(relationship.sourceRecordIds),
    );
    const currentPrimaryCoverArtifactId =
      input.current.artifactAssociations.find(
        (association) => association.role === "asset.primary-cover",
      )?.artifactId;
    return {
      execution,
      preview: {
        id: id("change-impact-preview"),
        executionId: execution.id,
        assetId: input.current.entity.id,
        proposal: input.proposal,
        baselines: [
          {
            key: "source-association",
            value: input.current.sourceAssociation.id,
          },
          {
            key: "recognition-decision",
            value: input.current.recognitionDecision.id,
          },
          {
            key: "source-records",
            value: input.current.proposal.interpretation.sourceRecordIds
              .toSorted()
              .join(","),
          },
          { key: "complete-current-projection", value: fullBaseline },
        ],
        current: {
          sourceAssociation: {
            sourceIdentity: input.current.sourceAssociation.sourceIdentity,
            nativeAddress: input.current.sourceAssociation.nativeAddress,
          },
          metadata: input.current.metadata,
          entities: input.current.entities ?? [],
          entityMentions: input.current.entityMentions ?? [],
          entityResolutionDecisions:
            input.current.entityResolutionDecisions ?? [],
          relationships: input.current.relationships ?? [],
          artifacts: input.current.artifacts,
          locations: input.current.locations,
          blobs: input.current.blobs,
          artifactRevisions: input.current.artifactRevisions,
          artifactAssociations: input.current.artifactAssociations,
          ...(currentPrimaryCoverArtifactId === undefined
            ? {}
            : { primaryCoverArtifactId: currentPrimaryCoverArtifactId }),
        },
        projected: {
          sourceAssociation: {
            sourceIdentity: input.proposal.interpretation.sourceIdentity,
            nativeAddress: input.proposal.interpretation.sourceAddress,
          },
          metadata: [
            ...retainedMetadata,
            ...input.proposal.interpretation.metadata,
          ],
          entities: [
            ...retainedEntities,
            ...(input.proposal.interpretation.entities ?? []),
          ],
          entityMentions: [
            ...retainedMentions,
            ...(input.proposal.interpretation.entityMentions ?? []),
          ],
          entityResolutionDecisions: [
            ...retainedResolutions,
            ...(input.proposal.interpretation.entityResolutionDecisions ?? []),
          ],
          relationships: [
            ...retainedRelationships,
            ...(input.proposal.interpretation.relationships ?? []).map(
              (relationship) => ({
                id: relationshipId(relationship, input.current.entity.id),
                subjectId: relationship.subjectId ?? input.current.entity.id,
                participantId: relationship.participantId,
                type: relationship.type,
                role: relationship.role,
                sourceSlot: relationship.sourceSlot,
                sourceRecordIds: relationship.sourceRecordIds,
                ...(relationship.producer === undefined
                  ? {}
                  : { producer: relationship.producer }),
                ...(relationship.qualifiers === undefined
                  ? {}
                  : { qualifiers: relationship.qualifiers }),
              }),
            ),
          ],
          artifacts: [
            ...retainedArtifacts,
            ...projectedArtifacts.map((item) => item.artifact),
          ],
          locations: [
            ...retainedLocations,
            ...projectedArtifacts.map((item) => item.location),
          ],
          blobs: [
            ...retainedBlobs,
            ...projectedArtifacts.map((item) => item.blob),
          ],
          artifactRevisions: [
            ...retainedRevisions,
            ...projectedArtifacts.map((item) => item.revision),
          ],
          artifactAssociations: [
            ...retainedAssociations,
            ...projectedArtifacts.map((item) => item.association),
          ],
          ...(() => {
            const primaryCover = projectedArtifacts.find(
              (item) => item.association.role === "asset.primary-cover",
            );
            return primaryCover === undefined
              ? {}
              : { primaryCoverArtifactId: primaryCover.artifact.id };
          })(),
        },
        blockingConditions,
        status: "awaiting-confirmation",
      },
    };
  }

  /** 继续同一个兼容的非终态执行；这不是重试。 */
  async resume(input: {
    readonly executionId: string;
    readonly onProgress?: ((message: string) => void) | undefined;
    readonly onCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly onHostCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
  }): Promise<AssetRefreshInspection> {
    const inspection = await this.ports.executionQueries.inspectExecution(
      input.executionId,
    );
    if (inspection === undefined) throw new Error("未找到刷新记录");
    if (inspection.execution.status !== "running") {
      throw new Error("只有未完成的刷新记录可以继续");
    }
    const decodedInput =
      inspection.execution.workflowInputInvalid !== undefined
        ? {
            valid: false as const,
            reason: inspection.execution.workflowInputInvalid.reason,
          }
        : inspection.execution.workflowInput === undefined
          ? {
              valid: false as const,
              reason: "刷新记录缺少版本化输入，无法安全继续；请重新开始刷新",
            }
          : decodeAssetRefreshWorkflowInput(inspection.execution.workflowInput);
    const hasExplicitWorkItems = inspection.execution.workItems !== undefined;
    const hasDurableObservationCheckpoint =
      inspection.execution.stage === "recognition" &&
      inspection.execution.snapshot?.complete === true;
    let interruptionReason: string | undefined = decodedInput.valid
      ? this.legacyFilesystemScopeRecoveryReason(inspection.execution)
      : decodedInput.reason;
    if (
      interruptionReason === undefined &&
      !hasExplicitWorkItems &&
      !hasDurableObservationCheckpoint &&
      inspection.execution.stage !== "source-records-retained" &&
      inspection.execution.stage !== "source-artifacts-acquired" &&
      inspection.execution.stage !== "source-artifacts-stored" &&
      inspection.execution.stage !== "cover-acquired" &&
      inspection.execution.stage !== "cover-stored"
    ) {
      interruptionReason = "刷新记录尚未到达可继续的持久检查点";
    }
    if (interruptionReason === undefined && decodedInput.valid) {
      try {
        await this.assertResumeCompatibility(
          inspection.execution.compatibility,
          decodedInput.input.configurationReferences,
          decodedInput.input.observedRoots ?? [],
        );
      } catch (error) {
        interruptionReason = errorMessage(error);
      }
    }
    let resumedScope: BoundObservedScope | undefined;
    if (interruptionReason === undefined && decodedInput.valid) {
      try {
        resumedScope = await this.rebindObservedScopeForResume(
          inspection.execution,
        );
      } catch (error) {
        // 绑定是恢复工作前最后一次权威检查。绝不重新打开冻结逻辑位置来替代这一步。
        interruptionReason = errorMessage(error);
      }
    }
    // ADR-0072 只允许已经证明可解码且兼容的冻结执行进入领域权威审阅等待。不兼容的
    // 等待中运行必须明确关闭／中断，不能继续保持运行中。
    if (
      interruptionReason === undefined &&
      (await this.isDomainOwnedSourceRefreshReviewWait(inspection.execution))
    ) {
      try {
        return await this.inspectResumedPublic(inspection.execution.id);
      } finally {
        await this.closeObservedScope(resumedScope);
      }
    }
    const acceptTrusted = decodedInput.valid
      ? decodedInput.input.acceptTrusted
      : false;
    const claimToken = randomUUID();
    const leaseMilliseconds = 30_000;
    const leaseExpiry = () =>
      new Date(
        this.resumeClock.now().getTime() + leaseMilliseconds,
      ).toISOString();
    let disposition: "claimed" | "terminal" | "busy";
    try {
      disposition = await this.ports.recoveryLease.claimResumeExecution({
        executionId: input.executionId,
        token: claimToken,
        now: this.resumeClock.now().toISOString(),
        expiresAt: leaseExpiry(),
      });
    } catch (error) {
      await this.closeObservedScope(resumedScope);
      throw error;
    }
    if (disposition === "terminal") {
      await this.closeObservedScope(resumedScope);
      throw new Error("只有未完成的刷新记录可以继续");
    }
    if (disposition === "busy") {
      await this.closeObservedScope(resumedScope);
      throw new ResumeExecutionBusyError();
    }
    const mutationClaim = () => ({
      token: claimToken,
      now: this.resumeClock.now().toISOString(),
    });
    let claimLost = false;
    let heartbeat: Promise<void> | undefined;
    const renew = async (): Promise<void> => {
      await heartbeat;
      if (claimLost) throw new Error("继续刷新租约已失效");
      const current = this.resumeClock.now();
      const renewed = await this.ports.recoveryLease.renewResumeExecutionClaim({
        executionId: input.executionId,
        token: claimToken,
        now: current.toISOString(),
        expiresAt: new Date(
          current.getTime() + leaseMilliseconds,
        ).toISOString(),
      });
      if (!renewed) {
        claimLost = true;
        throw new Error("继续刷新租约已失效");
      }
    };
    const timer = this.resumeClock.setInterval(() => {
      if (heartbeat !== undefined || claimLost) return;
      heartbeat = renew()
        .catch(() => {
          claimLost = true;
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, leaseMilliseconds / 3);
    try {
      notifyDurableCheckpoint(input, inspection.execution);
      try {
        if (interruptionReason !== undefined) {
          return await this.interruptRecovery(
            inspection.execution,
            interruptionReason,
            mutationClaim,
          );
        }
        const operation = decodedInput.valid
          ? decodedInput.input.operation
          : undefined;
        if (
          operation?.kind === "source-artifact-acquisition" &&
          (inspection.execution.sourceArtifactAcquisitions?.length ?? 0) > 0
        ) {
          return await this.resumeInformationFulfillmentArtifacts({
            execution: inspection.execution,
            operation,
            onHostCheckpoint: input.onHostCheckpoint,
            resumeClaim: mutationClaim(),
          });
        }
        const domainRecovery =
          await this.recoverDomainOwnedSourceRefreshRunExecution(
            inspection.execution,
            mutationClaim,
          );
        if (domainRecovery !== undefined) return domainRecovery;
        if (
          inspection.execution.sourceEnrichments?.some(
            (checkpoint) => checkpoint.stage !== "applied",
          ) === true
        ) {
          const resumed = await this.resumeSourceEnrichmentCheckpoints({
            execution: inspection.execution,
            sourceRecords: inspection.sourceRecords,
            beforeEffect: renew,
            resumeClaim: mutationClaim(),
            onHostCheckpoint: input.onHostCheckpoint,
          });
          const baseFinished =
            resumed.workItems === undefined
              ? {
                  ...resumed,
                  status: "completed" as const,
                  stage: "completed" as const,
                  outcome: "accepted" as const,
                }
              : terminalFromWorkItems(resumed);
          const failedEnrichments = resumed.dispositions.filter(
            (item) =>
              item.key.startsWith("source-enrichment:") &&
              item.status === "failed",
          ).length;
          const finished: WorkflowExecution =
            failedEnrichments === 0 || baseFinished.outcome !== "accepted"
              ? baseFinished
              : {
                  ...baseFinished,
                  outcome: "partially-succeeded",
                  reason: `${failedEnrichments} 个来源补充未完成；已接受身份保持有效`,
                };
          await this.transition(resumed, finished, mutationClaim());
          return await this.inspectResumedPublic(finished.id);
        }
        if (
          !hasExplicitWorkItems &&
          inspection.execution.acceptedAssetId !== undefined
        ) {
          const acceptedAssetId = inspection.execution.acceptedAssetId;
          const enrichment = await this.enrichAcceptedSubjectsInExecution({
            execution: inspection.execution,
            selection: {
              version: assetRefreshSelectionVersion,
              subjects: [
                {
                  subjectId: acceptedAssetId,
                  explanations: [{ path: ["resume accepted recognition"] }],
                },
              ],
              filesystemScopes: [],
            },
            informationRequirement:
              inspection.execution.selection.informationRequirement ??
              emptyInformationRequirement,
            onProgress: input.onProgress,
            onHostCheckpoint: input.onHostCheckpoint,
            resumeClaim: mutationClaim(),
          });
          const finished: WorkflowExecution = {
            ...enrichment.execution,
            status: "completed",
            stage: "completed",
            outcome:
              enrichment.failed === 0 ? "accepted" : "partially-succeeded",
            ...(enrichment.failed === 0
              ? {}
              : {
                  reason: `${enrichment.failed} 个来源补充未完成；已接受身份保持有效`,
                }),
          };
          await this.transition(
            enrichment.execution,
            finished,
            mutationClaim(),
          );
          return await this.inspectResumedPublic(finished.id);
        }
        let resumedExecution = inspection.execution;
        const retainResumedCapabilities = async (
          capabilities: readonly CapabilityCoordinate[],
        ): Promise<void> => {
          const next = this.retainCapabilityParticipation(
            resumedExecution,
            capabilities,
          );
          if (
            JSON.stringify(next.compatibility.capabilityCoordinates) ===
            JSON.stringify(resumedExecution.compatibility.capabilityCoordinates)
          )
            return;
          await this.transition(resumedExecution, next, mutationClaim());
          resumedExecution = next;
        };
        const hasPlanningEvidence =
          hasExplicitWorkItems &&
          inspection.execution.workItems?.every(
            (item) => item.planningEvidence !== undefined,
          );
        const resumedDirectoryInterpretations: Array<
          ReturnType<DirectoryInterpreter["interpret"]>
        > = [];
        if (!hasPlanningEvidence) {
          for (const interpreter of this.ports.directoryInterpreters) {
            await retainResumedCapabilities([interpreter.capability]);
            resumedDirectoryInterpretations.push(
              bindRecognitionEvidenceOutputToProducer(
                interpreter.interpret(
                  requiredFilesystemSnapshot(resumedExecution),
                ),
                interpreter.capability,
              ),
            );
          }
        }
        const plannedWorkItems = hasPlanningEvidence
          ? inspection.execution.workItems.map((item) => ({
              key: item.key,
              relativePaths: item.relativePaths,
              ...(item.observedArtifactBoundary === undefined
                ? {}
                : { observedArtifactBoundary: item.observedArtifactBoundary }),
              ...(item.observedArtifactBoundaryProducer === undefined
                ? {}
                : {
                    observedArtifactBoundaryProducer:
                      item.observedArtifactBoundaryProducer,
                  }),
              evidence: item.planningEvidence!,
            }))
          : planRecognitionWorkItems(
              requiredFilesystemSnapshot(resumedExecution),
              resumedDirectoryInterpretations,
            );
        if (hasExplicitWorkItems) {
          return await this.refreshPlannedWorkItems(
            resumedExecution,
            {
              ...(resumedScope === undefined ? {} : { scope: resumedScope }),
              acceptTrusted,
              informationRequirement:
                inspection.execution.selection.informationRequirement,
              onProgress: input.onProgress,
              onHostCheckpoint: input.onHostCheckpoint,
            },
            plannedWorkItems,
            mutationClaim(),
          );
        }
        const evidence = plannedWorkItems.flatMap((item) => item.evidence);
        const batches: SourceInterpretationBatch[] = [];
        for (const interpreter of this.ports.sourceInterpreters) {
          if (
            !interpreter.canInterpret({
              evidence,
              sourceRecords: inspection.sourceRecords,
            })
          )
            continue;
          await retainResumedCapabilities([interpreter.capability]);
          batches.push(
            retainInterpretationProvenance(
              interpreter,
              interpreter.interpret({
                evidence,
                sourceRecords: inspection.sourceRecords,
              }),
            ),
          );
        }
        const proposals: RecognitionProposal[] = [];
        for (const recognizer of this.ports.recognizers) {
          for (const interpretation of batches) {
            const recognizerInput = frozenRecognitionInput({
              evidence,
              interpretation,
            });
            if (!recognizer.canRecognize(recognizerInput.interpretation))
              continue;
            await retainResumedCapabilities([recognizer.capability]);
            proposals.push(
              validateRecognitionProposalForRecords(
                attachObservedFormatFacts(
                  bindRecognitionProposalToRecognizer(
                    recognizer,
                    recognizer.recognize(recognizerInput),
                    recognizerInput,
                  ),
                  recognizerInput.evidence,
                ),
                inspection.sourceRecords,
              ),
            );
          }
        }
        if (proposals.length !== 1) {
          const failed = terminal(
            resumedExecution,
            "failed",
            "继续时无法形成唯一识别提案",
          );
          await this.ports.executionCommands.finishExecution(
            resumedExecution,
            failed,
            mutationClaim(),
          );
          return await this.inspectResumedPublic(failed.id);
        }
        const [proposal] = proposals;
        if (proposal === undefined) {
          throw new Error("恢复形成的唯一识别提案在校验后不可读取");
        }
        const preview = { ...resumedExecution, proposalId: proposal.id };
        if (
          !acceptTrusted ||
          !proposal.ruleResults.some(
            (result) =>
              result.outcome === "satisfied" &&
              this.ports.recognitionPolicy.accepts(result),
          )
        ) {
          const finished = terminal(preview, "proposal");
          await this.ports.executionCommands.finishExecutionWithProposal(
            resumedExecution,
            finished,
            proposal,
            mutationClaim(),
          );
          return await this.inspectResumedPublic(finished.id);
        }
        try {
          const requirement =
            resumedExecution.selection.informationRequirement ??
            emptyInformationRequirement;
          assertInterpretationSatisfiesInformationRequirement(
            proposal,
            requirement,
          );
          const rawSelected = selectSourceArtifacts(proposal, requirement);
          const legacyAcquisitions =
            resumedExecution.sourceArtifactAcquisitions ??
            (resumedExecution.coverAcquisition === undefined
              ? []
              : [resumedExecution.coverAcquisition]);
          const legacyManagedArtifacts =
            resumedExecution.managedSourceArtifacts ??
            (resumedExecution.managedCover === undefined
              ? []
              : [resumedExecution.managedCover]);
          const acceptedAsset: DigitalAsset = {
            id:
              inferCheckpointedAcceptedAssetId(rawSelected, [
                ...legacyAcquisitions,
                ...legacyManagedArtifacts,
              ]) ?? id("entity"),
            kind: "digital-asset",
          };
          const selected = rawSelected.map((candidate) =>
            resolveSourceArtifactSubject(candidate, acceptedAsset.id),
          );
          input.onProgress?.(
            selected.length === 0
              ? "当前信息需求不需要获取来源产物"
              : "正在获取所需来源产物",
          );
          let checkpointExecution = resumedExecution;
          let managedArtifacts: readonly ManagedSourceArtifactCheckpoint[];
          const storedCheckpointMatches =
            legacyManagedArtifacts.length === selected.length &&
            legacyManagedArtifacts.every((managed) =>
              selected.some((candidate) =>
                managedSourceArtifactMatchesCandidate(managed, candidate),
              ),
            );
          const acquiredCheckpointMatches =
            legacyAcquisitions.length === selected.length &&
            legacyAcquisitions.every((acquisition) =>
              selected.some((candidate) =>
                sourceArtifactCheckpointMatchesCandidate(
                  acquisition,
                  candidate,
                ),
              ),
            );
          if (
            resumedExecution.stage === "source-artifacts-stored" ||
            resumedExecution.stage === "cover-stored"
          ) {
            if (storedCheckpointMatches)
              managedArtifacts = legacyManagedArtifacts;
            else {
              checkpointExecution = resumedExecution;
              managedArtifacts = await this.sourceArtifactWork.complete({
                candidates: selected,
                proposal,
                sourceRecords: inspection.sourceRecords,
                idempotencyKey: (candidate) =>
                  sourceArtifactIdempotencyKey(
                    checkpointExecution.id,
                    candidate,
                  ),
                requireCheckpointStore: false,
                beforeEffect: renew,
                beforeAcquire: async (capability) => {
                  await retainResumedCapabilities([capability]);
                  checkpointExecution = resumedExecution;
                },
                onAcquired: async (acquisitions) => {
                  const acquiredExecution: WorkflowExecution = {
                    ...checkpointExecution,
                    proposalId: proposal.id,
                    stage: "source-artifacts-acquired",
                    sourceArtifactAcquisitions: acquisitions,
                  };
                  await this.transition(
                    checkpointExecution,
                    acquiredExecution,
                    mutationClaim(),
                  );
                  checkpointExecution = acquiredExecution;
                  notifyDurableCheckpoint(input, checkpointExecution, false);
                },
                onStored: async (storedArtifacts) => {
                  const storedExecution: WorkflowExecution = {
                    ...checkpointExecution,
                    stage: "source-artifacts-stored",
                    managedSourceArtifacts: storedArtifacts,
                  };
                  await this.transition(
                    checkpointExecution,
                    storedExecution,
                    mutationClaim(),
                  );
                  checkpointExecution = storedExecution;
                  notifyDurableCheckpoint(input, checkpointExecution, false);
                },
              });
            }
          } else if (
            resumedExecution.stage === "source-artifacts-acquired" ||
            resumedExecution.stage === "cover-acquired"
          ) {
            if (
              acquiredCheckpointMatches &&
              this.ports.managedStore.storeStaged !== undefined
            )
              managedArtifacts = await this.sourceArtifactWork.resumeStore({
                acquisitions: legacyAcquisitions,
                beforeEffect: renew,
                onStored: async (storedArtifacts) => {
                  const storedExecution: WorkflowExecution = {
                    ...checkpointExecution,
                    stage: "source-artifacts-stored",
                    managedSourceArtifacts: storedArtifacts,
                    dispositions: checkpointExecution.dispositions.map((item) =>
                      completeManagedStoreDisposition(item, storedArtifacts),
                    ),
                  };
                  await this.transition(
                    checkpointExecution,
                    storedExecution,
                    mutationClaim(),
                  );
                  checkpointExecution = storedExecution;
                  notifyDurableCheckpoint(input, checkpointExecution, false);
                },
              });
            else {
              checkpointExecution = resumedExecution;
              managedArtifacts = await this.sourceArtifactWork.complete({
                candidates: selected,
                proposal,
                sourceRecords: inspection.sourceRecords,
                idempotencyKey: (candidate) =>
                  sourceArtifactIdempotencyKey(
                    checkpointExecution.id,
                    candidate,
                  ),
                requireCheckpointStore: false,
                beforeEffect: renew,
                beforeAcquire: async (capability) => {
                  await retainResumedCapabilities([capability]);
                  checkpointExecution = resumedExecution;
                },
                onAcquired: async (acquisitions) => {
                  const acquiredExecution: WorkflowExecution = {
                    ...checkpointExecution,
                    proposalId: proposal.id,
                    stage: "source-artifacts-acquired",
                    sourceArtifactAcquisitions: acquisitions,
                  };
                  await this.transition(
                    checkpointExecution,
                    acquiredExecution,
                    mutationClaim(),
                  );
                  checkpointExecution = acquiredExecution;
                  notifyDurableCheckpoint(input, checkpointExecution, false);
                },
                onStored: async (storedArtifacts) => {
                  const storedExecution: WorkflowExecution = {
                    ...checkpointExecution,
                    stage: "source-artifacts-stored",
                    managedSourceArtifacts: storedArtifacts,
                  };
                  await this.transition(
                    checkpointExecution,
                    storedExecution,
                    mutationClaim(),
                  );
                  checkpointExecution = storedExecution;
                  notifyDurableCheckpoint(input, checkpointExecution, false);
                },
              });
            }
          } else {
            checkpointExecution = resumedExecution;
            managedArtifacts = await this.sourceArtifactWork.complete({
              candidates: selected,
              proposal,
              sourceRecords: inspection.sourceRecords,
              idempotencyKey: (candidate) =>
                sourceArtifactIdempotencyKey(checkpointExecution.id, candidate),
              requireCheckpointStore: false,
              beforeEffect: renew,
              beforeAcquire: async (capability) => {
                await retainResumedCapabilities([capability]);
                checkpointExecution = resumedExecution;
              },
              onAcquired: async (acquisitions) => {
                const acquiredExecution: WorkflowExecution = {
                  ...checkpointExecution,
                  proposalId: proposal.id,
                  stage: "source-artifacts-acquired",
                  sourceArtifactAcquisitions: acquisitions,
                  dispositions: [
                    ...checkpointExecution.dispositions,
                    ...acquisitions.map((acquisition) => ({
                      key: `source-artifact.acquire:${acquisition.role}`,
                      status: "completed" as const,
                      effectReference: acquisition.stagedReference,
                    })),
                    ...acquisitions.map((acquisition) => ({
                      key: `source-artifact.store:${acquisition.role}`,
                      status: "running" as const,
                    })),
                  ],
                };
                await this.transition(
                  checkpointExecution,
                  acquiredExecution,
                  mutationClaim(),
                );
                checkpointExecution = acquiredExecution;
                notifyDurableCheckpoint(input, checkpointExecution, false);
              },
              onStored: async (storedArtifacts) => {
                const storedExecution: WorkflowExecution = {
                  ...checkpointExecution,
                  stage: "source-artifacts-stored",
                  managedSourceArtifacts: storedArtifacts,
                  dispositions: checkpointExecution.dispositions.map((item) =>
                    completeManagedStoreDisposition(item, storedArtifacts),
                  ),
                };
                await this.transition(
                  checkpointExecution,
                  storedExecution,
                  mutationClaim(),
                );
                checkpointExecution = storedExecution;
                notifyDurableCheckpoint(input, checkpointExecution, false);
              },
            });
          }
          const accepted = createAcceptedRecognition({
            proposal,
            snapshot: requiredFilesystemSnapshot(checkpointExecution),
            managedArtifacts,
            asset: acceptedAsset,
            ...(this.ports.observedRootRegistrations.objectIdentityContract ===
            undefined
              ? {}
              : {
                  objectIdentityContract:
                    this.ports.observedRootRegistrations.objectIdentityContract,
                }),
          });
          const lastPersistedExecution =
            persistedWorkflowExecution(checkpointExecution);
          const finished: WorkflowExecution = {
            ...lastPersistedExecution,
            status: "completed",
            stage: "completed",
            outcome: "accepted",
            acceptedAssetId: accepted.entity.id,
          };
          validateAcceptedRecognition(accepted);
          await this.ports.recognitionAcceptance.acceptRecognition({
            expectedExecution: lastPersistedExecution,
            execution: finished,
            accepted,
            metadataPolicyIds: this.metadataPolicyIdsFor(accepted),
            resumeClaim: mutationClaim(),
          });
          return await this.inspectResumedPublic(finished.id);
        } catch (error) {
          rethrowWorkflowLifecycle(error);
          const current = await this.ports.executionQueries.inspectExecution(
            input.executionId,
          );
          const expectedExecution = current?.execution ?? preview;
          const failed = terminal(
            expectedExecution,
            "failed",
            errorMessage(error),
          );
          await this.ports.executionCommands.finishExecution(
            expectedExecution,
            failed,
            mutationClaim(),
          );
          return await this.inspectResumedPublic(failed.id);
        }
      } catch (error) {
        if (error instanceof WorkflowCheckpointInterruption) throw error.cause;
        const current = await this.ports.executionQueries.inspectExecution(
          input.executionId,
        );
        if (current?.execution.status !== "running")
          return await this.inspectResumedPublic(input.executionId);
        const expectedExecution = current?.execution ?? inspection.execution;
        if ((expectedExecution.sourceRefreshRunIds?.length ?? 0) > 0) {
          return await this.interruptRecovery(
            expectedExecution,
            errorMessage(error),
            mutationClaim,
          );
        }
        const failed = terminal(
          expectedExecution,
          "failed",
          errorMessage(error),
        );
        await this.ports.executionCommands.finishExecution(
          expectedExecution,
          failed,
          mutationClaim(),
        );
        return await this.inspectResumedPublic(failed.id);
      }
    } finally {
      this.resumeClock.clearInterval(timer);
      await heartbeat;
      try {
        await this.ports.recoveryLease.releaseResumeExecutionClaim({
          executionId: input.executionId,
          token: claimToken,
        });
      } finally {
        await this.closeObservedScope(resumedScope);
      }
    }
  }

  /**
   * ADR-0072 只允许兼容执行在其所有仍打开的来源刷新运行都等待人工审阅时，产生无操作
   * 启动结果。这里刻意不读取租约，也不执行领域或执行写入。
   */
  private async isDomainOwnedSourceRefreshReviewWait(
    execution: WorkflowExecution,
  ): Promise<boolean> {
    const inspection = await this.ports.executionQueries.inspectExecution(
      execution.id,
    );
    if (inspection === undefined || inspection.execution.status !== "running")
      return false;
    const runIds = [...new Set(inspection.execution.sourceRefreshRunIds ?? [])];
    if (runIds.length === 0) return false;
    const authority = this.ports.sourceRefreshRuns;
    const embedded = new Map(
      (inspection.sourceRefreshRuns ?? []).map((run) => [run.id, run]),
    );
    for (const runId of runIds) {
      const run =
        embedded.get(runId) ??
        (authority === undefined
          ? undefined
          : await authority.inspectSourceRefreshRun(runId));
      if (run?.phase !== "reviewing") return false;
    }
    return true;
  }

  /**
   * 仅在本进程持有工作流执行恢复租约后运行。被引用的来源刷新运行仍具权威：全部终态
   * 运行通过普通协调器投影；正在获取或应用的运行没有安全采集器恢复协议，因此在父执行
   * 中断前明确关闭。
   */
  private async recoverDomainOwnedSourceRefreshRunExecution(
    execution: WorkflowExecution,
    resumeClaim: () => { readonly token: string; readonly now: string },
  ): Promise<AssetRefreshInspection | undefined> {
    const inspection = await this.ports.executionQueries.inspectExecution(
      execution.id,
    );
    if (inspection === undefined || inspection.execution.status !== "running")
      return await this.inspectResumedPublic(execution.id);
    const runIds = [...new Set(inspection.execution.sourceRefreshRunIds ?? [])];
    if (runIds.length === 0) return undefined;

    const authority = this.ports.sourceRefreshRuns;
    const embedded = new Map(
      (inspection.sourceRefreshRuns ?? []).map((run) => [run.id, run]),
    );
    const runs: SourceRefreshRun[] = [];
    for (const runId of runIds) {
      const run =
        embedded.get(runId) ??
        (authority === undefined
          ? undefined
          : await authority.inspectSourceRefreshRun(runId));
      if (run === undefined) {
        return await this.interruptRecovery(
          inspection.execution,
          "引用的 Source Refresh Run 已不可读取，无法安全继续",
          resumeClaim,
        );
      }
      runs.push(run);
    }

    const nonTerminalRuns = runs.filter((run) => run.phase !== "terminal");
    if (
      nonTerminalRuns.length > 0 &&
      nonTerminalRuns.every((run) => run.phase === "reviewing")
    ) {
      return await this.inspectResumedPublic(execution.id);
    }
    if (nonTerminalRuns.length === 0) {
      const [completedRun] = runs;
      if (completedRun === undefined) {
        throw new Error("执行引用的来源刷新运行集合不可为空");
      }
      await this.continueSourceRefreshRunExecution(
        completedRun.id,
        resumeClaim,
      );
      return await this.inspectResumedPublic(execution.id);
    }
    return await this.interruptRecovery(
      inspection.execution,
      "Source Refresh Run 在采集或应用检查点中断，当前版本无法安全继续",
      resumeClaim,
    );
  }

  /**
   * 进程启动后协调每个耐久非终态执行。版本化持久输入封装是唯一重放权威。
   */
  async recoverRunningExecutions(
    lifecycle?: RecoveryLifecycle,
  ): Promise<readonly AssetRefreshInspection[]> {
    const running = await this.ports.executionQueries.listRunningExecutions();
    const recovered: AssetRefreshInspection[] = [];
    for (const execution of running) {
      lifecycle?.onCheckpoint?.();
      try {
        recovered.push(
          await this.resume({
            executionId: execution.id,
            onHostCheckpoint: lifecycle?.onCheckpoint,
          }),
        );
      } catch (error) {
        // 保留且未过期的声明既不是已恢复、等待审阅，也不是终态。它尚未分类时，不得报告
        // 启动就绪。因此单进程宿主保持准入屏障关闭，直到操作方或声明持有者解决它。
        if (error instanceof ResumeExecutionBusyError) {
          const current = await this.ports.executionQueries.inspectExecution(
            execution.id,
          );
          if (current?.execution.status === "running") {
            lifecycle?.onWaitingExecution?.(execution.id);
          }
          continue;
        }
        // 竞争持有者也可能在启动扫描与声明尝试之间将其终态化。`resume()` 为明确调用方
        // 保留公开错误，但启动恢复把现在已终态的行视为已经协调，而不是让整个宿主失败。
        const current = await this.ports.executionQueries.inspectExecution(
          execution.id,
        );
        if (current?.execution.status !== "running") continue;
        throw error;
      }
    }
    return recovered;
  }

  private ordinaryScanReusePlan(
    snapshot: FilesystemPackageSnapshot,
    evidence: readonly import("@digital/domain").RecognitionEvidence[],
    informationRequirement: InformationRequirement,
    observedRoots: readonly ObservedRootSnapshot[] | undefined,
  ): OrdinaryScanReusePlan {
    const files = reuseComparableFiles(snapshot.files);
    const fingerprint = sha256(
      new TextEncoder().encode(
        JSON.stringify({
          root: snapshot.root,
          observedRoots: observedRoots ?? [],
          complete: snapshot.complete,
          files,
          directories: snapshot.directories,
          excluded: snapshot.excluded,
        }),
      ),
    );
    const sourceBaseline = JSON.stringify(
      evidence.map((item) => JSON.stringify(item)).toSorted(),
    );
    const requirementBaseline = JSON.stringify(informationRequirement);
    const item = (
      key: string,
      informationBaseline: string,
      managedArtifactBaseline?: string,
    ) => ({
      key,
      domainBaseline: fingerprint,
      sourceBaseline,
      informationBaseline: `${informationBaseline}:${requirementBaseline}`,
      ...(managedArtifactBaseline === undefined
        ? {}
        : { managedArtifactBaseline }),
    });
    return {
      workItems: [
        item("directory-interpretation", "recognition-evidence/v1"),
        item("official-collection", "official-records/v1"),
        item("source-interpretation", "stable-metadata/v1"),
        item(
          "recognition",
          `policy/${this.ports.recognitionPolicy.version ?? "unversioned"};rules/${(
            this.ports.recognitionPolicy.trustedRuleCoordinates ?? []
          )
            .toSorted()
            .join(",")}`,
        ),
        item(
          "source-artifacts",
          JSON.stringify(informationRequirement.artifactRoles),
          "requested-managed-artifacts-present/v1",
        ),
      ],
    };
  }

  private workItemReuseFingerprint(
    snapshot: FilesystemPackageSnapshot,
    plan: AssetRefreshWorkItemPlan,
    informationRequirement: InformationRequirement,
    observedRoots: readonly ObservedRootSnapshot[] | undefined,
  ): string {
    const selected = new Set(plan.relativePaths);
    const files = reuseComparableFiles(snapshot.files);
    const containsBoundary = (directory: string) =>
      directory === "." ||
      plan.relativePaths.some(
        (relativePath) =>
          relativePath === directory ||
          relativePath.startsWith(`${directory}/`),
      );
    return sha256(
      new TextEncoder().encode(
        JSON.stringify({
          root: snapshot.root,
          observedRoots: observedRoots ?? [],
          complete: snapshot.complete,
          files: files.filter((file) => selected.has(file.relativePath)),
          directories: snapshot.directories?.filter((directory) =>
            containsBoundary(directory.relativePath),
          ),
          excluded: snapshot.excluded,
          key: plan.key,
          relativePaths: plan.relativePaths,
          evidence: plan.evidence,
          informationRequirement,
          trustedRuleCoordinates:
            this.ports.recognitionPolicy.trustedRuleCoordinates ?? [],
        }),
      ),
    );
  }

  /**
   * 启动不含插件坐标的执行。只有具体端口参与后才追加坐标，因此已配置但不适用的集成
   * 不能成为耐久恢复契约的一部分。
   */
  private compatibility(
    capabilities: readonly CapabilityCoordinate[] = [],
  ): WorkflowCompatibility {
    return {
      workflowVersion: "asset-refresh/2",
      policyVersion: [
        this.ports.recognitionPolicy.version ?? "unversioned",
        ...(this.ports.metadataPolicyConfiguration === undefined
          ? []
          : [`metadata/${this.ports.metadataPolicyConfiguration.version}`]),
      ].join(";"),
      capabilityCoordinates: capabilityCoordinates(capabilities),
    };
  }

  /** 只添加耐久坐标值，绝不添加运行时端口或其秘密。 */
  private retainCapabilityParticipation(
    execution: WorkflowExecution,
    capabilities: readonly CapabilityCoordinate[],
  ): WorkflowExecution {
    return {
      ...execution,
      compatibility: {
        ...execution.compatibility,
        capabilityCoordinates: [
          ...execution.compatibility.capabilityCoordinates,
          ...capabilityCoordinates(capabilities),
        ]
          .filter((coordinate, index, all) => all.indexOf(coordinate) === index)
          .toSorted(),
      },
    };
  }

  private retainWorkItemCapabilityParticipation(
    item: AssetRefreshWorkItem,
    capabilities: readonly CapabilityCoordinate[],
  ): AssetRefreshWorkItem {
    // 旧版条目从未证明自己的参与坐标。恢复时不要捏造该证明；它仍不具备跨执行复用资格。
    if (item.reuseCompatibility === undefined) return item;
    return {
      ...item,
      reuseCompatibility: {
        ...item.reuseCompatibility,
        capabilityCoordinates: [
          ...item.reuseCompatibility.capabilityCoordinates,
          ...capabilityCoordinates(capabilities),
        ]
          .filter((coordinate, index, all) => all.indexOf(coordinate) === index)
          .toSorted(),
      },
    };
  }

  /**
   * 调用能力前先写入耐久执行坐标检查点。这刻意是小型执行记录原语，而不是通用能力
   * 流水线：每个工作流仍持有自己的规划、检查点、效果和失败语义。
   */
  private async freezeCapabilityParticipation(
    execution: WorkflowExecution,
    capabilities: readonly CapabilityCoordinate[],
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<WorkflowExecution> {
    const next = this.retainCapabilityParticipation(execution, capabilities);
    if (
      JSON.stringify(next.compatibility.capabilityCoordinates) ===
      JSON.stringify(execution.compatibility.capabilityCoordinates)
    )
      return execution;
    await this.transition(execution, next, resumeClaim);
    return next;
  }

  /**
   * 只冻结即将运行的采集器对应私密来源连接。不透明引用是耐久审计输入；秘密仍留在
   * 外层能力专用句柄之后，并在每次请求时重新解析。
   */
  private async bindCollectorConfiguration(
    execution: WorkflowExecution,
    collector: SourceCollector,
    evidence: RecognitionEvidence,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<WorkflowExecution> {
    const binder = this.ports.sourceConnectionExecutionConfiguration;
    if (binder === undefined) return execution;
    const workflowInput = execution.workflowInput;
    if (workflowInput === undefined) {
      throw new Error("刷新记录缺少可冻结的来源连接配置");
    }
    const bound = await binder.bindCollector({
      collector: collector.capability,
      evidence,
      configurationReferences: workflowInput.configurationReferences,
    });
    const references = [
      ...new Set([
        ...workflowInput.configurationReferences,
        ...bound.configurationReferences,
      ]),
    ];
    if (
      references.length === workflowInput.configurationReferences.length &&
      references.every(
        (reference, index) =>
          reference === workflowInput.configurationReferences[index],
      )
    ) {
      return execution;
    }
    const next: WorkflowExecution = {
      ...execution,
      workflowInput: {
        ...workflowInput,
        configurationReferences: references,
      },
    };
    await this.transition(execution, next, resumeClaim);
    return next;
  }

  private collectionExecutionContext(
    execution: WorkflowExecution,
  ): SourceCollectionExecutionContext {
    return {
      configurationReferences:
        execution.workflowInput?.configurationReferences ?? [],
    };
  }

  private availableCapabilityCoordinates(): readonly string[] {
    return capabilityCoordinates([
      ...applicationOwnedCapabilityDeclarations,
      ...observedFilesystemCapabilities(this.ports.observedRootRegistrations),
      ...this.ports.directoryInterpreters.map(({ capability }) => capability),
      ...(this.ports.filesystemPackageInterpreters ?? []).map(
        ({ capability }) => capability,
      ),
      ...(this.ports.formatInspectors ?? []).map(
        ({ capability }) => capability,
      ),
      ...this.ports.collectors.map(({ capability }) => capability),
      ...this.ports.sourceInterpreters.map(({ capability }) => capability),
      ...this.ports.recognizers.map(({ capability }) => capability),
      ...this.ports.acquirers.map(({ capability }) => capability),
      ...(this.ports.observedArtifactPartAcquirers ?? []).map(
        ({ capability }) => capability,
      ),
      ...(this.ports.sourceAssociationCandidateInterpreters ?? []).map(
        ({ capability }) => capability,
      ),
      ...(this.ports.sourceAssociationInterpreters ?? []).map(
        ({ capability }) => capability,
      ),
    ]);
  }

  /** 将部署范围可用性与先前冻结参与情况比较。 */
  private availableCompatibility(): WorkflowCompatibility {
    return {
      ...this.compatibility(),
      capabilityCoordinates: this.availableCapabilityCoordinates(),
    };
  }

  /**
   * 描述符范围是不透明适配器能力。工作流可以把冻结位置用作证据，但每次字节打开和释放
   * 都会回到绑定该范围的观察根权威。
   */
  private observedRootScopeOperations(): Pick<
    ObservedRootRegistrations,
    "openBoundByteSource" | "closeBoundScope"
  > {
    return this.ports.observedRootRegistrations;
  }

  private async openObservedByteSource(
    scope: BoundObservedScope,
    relativePath: string,
  ): Promise<ObservedByteSource> {
    return await this.observedRootScopeOperations().openBoundByteSource({
      scope,
      relativePath,
    });
  }

  private async closeObservedScope(
    scope: BoundObservedScope | undefined,
  ): Promise<void> {
    if (scope !== undefined)
      await this.observedRootScopeOperations().closeBoundScope(scope);
  }

  /**
   * 耐久执行保留冻结根快照，而不是活动句柄。因此恢复过程再次读取观察字节前，先从该
   * 精确快照取得新的适配器绑定范围；绝不退回持久化逻辑位置。
   */
  private async rebindObservedScopeForResume(
    execution: WorkflowExecution,
  ): Promise<BoundObservedScope | undefined> {
    const scopes = execution.resolvedSelection?.filesystemScopes ?? [];
    if (scopes.length === 0) return undefined;
    if (scopes.length !== 1) {
      throw new Error("刷新记录包含无法安全恢复的多个冻结文件范围");
    }
    const [scope] = scopes;
    if (scope === undefined) {
      throw new Error("冻结文件范围在恢复校验后不可读取");
    }
    try {
      return await this.ports.observedRootRegistrations.rebindFrozenScope({
        root: scope.observedRoot,
        relativeScope: scope.relativeScope,
      });
    } catch (error) {
      if (error instanceof ObservedRootUnavailable) throw error;
      throw new ObservedRootUnavailable(
        "刷新记录的冻结文件位置当前不可用或版本已变更",
      );
    }
  }

  /**
   * 旧耐久行可能保留逻辑目录或旧 `{ root }` 选择，但从未保留可安全重新绑定的注册快照。
   * 这些行仍是可检查历史；ADR-0068 与 ADR-0072 要求明确终态中断，而不是采用当前根或
   * 重新打开保存路径。
   */
  private legacyFilesystemScopeRecoveryReason(
    execution: WorkflowExecution,
  ): string | undefined {
    const requiresFilesystemScope =
      execution.operationKind === "scan-filesystem" ||
      execution.operationKind === "rescrape";
    if (!requiresFilesystemScope) return undefined;
    const selection = execution.resolvedSelection;
    if (selection === undefined) {
      return "刷新记录使用旧版未登记文件位置范围，无法安全继续；请重新选择范围并刷新";
    }
    try {
      assertAssetRefreshSelection(selection);
    } catch {
      return "刷新记录使用旧版未登记文件位置范围，无法安全继续；请重新选择范围并刷新";
    }
    return selection.filesystemScopes.length === 1
      ? undefined
      : "刷新记录使用旧版未登记文件位置范围，无法安全继续；请重新选择范围并刷新";
  }

  private async assertResumeCompatibility(
    frozen: WorkflowCompatibility,
    configurationReferences: readonly string[],
    observedRoots: readonly ObservedRootSnapshot[] = [],
  ): Promise<void> {
    const current = this.compatibility();
    if (
      frozen.workflowVersion !== current.workflowVersion ||
      frozen.policyVersion !== current.policyVersion
    ) {
      throw new Error("刷新记录与当前工作流或策略版本不兼容");
    }
    if (frozen.capabilityCoordinates.length === 0) {
      throw new Error(
        "刷新记录缺少实际参与能力坐标，无法安全继续；请重新开始刷新",
      );
    }
    const available = new Set(this.availableCapabilityCoordinates());
    const incompatible = frozen.capabilityCoordinates.filter(
      (coordinate) => !available.has(coordinate),
    );
    if (incompatible.length > 0) {
      throw new Error(
        `刷新记录与实际参与能力的实现或契约不兼容：${incompatible.join(", ")}`,
      );
    }
    // 没有冻结配置就没有需要解析的内容。这使旧版中立执行保持兼容，而不会在恢复时
    // 捏造配置依赖。
    if (observedRoots.length > 0) {
      await this.ports.observedRootRegistrations.assertFrozenRootsCurrent(
        observedRoots,
      );
    }
    if (configurationReferences.length === 0) return;
    const configurationCompatibility = this.ports.configurationCompatibility;
    if (configurationCompatibility === undefined) {
      throw new Error("刷新记录的冻结配置无法在当前组合中验证");
    }
    const result = await configurationCompatibility.checkCompatibility({
      references: configurationReferences,
    });
    if (result.compatible) return;
    const reason = result.reason.trim();
    throw new Error(
      reason.length === 0 ? "刷新记录的冻结配置当前不可用" : reason,
    );
  }

  /**
   * 重启恢复绝不静默重新规划冻结执行。当检查点或兼容性坐标无法满足时，保留完整既有
   * 审计，只追加明确终态结果。
   */
  private async interruptRecovery(
    execution: WorkflowExecution,
    reason: string,
    resumeClaim: () => { readonly token: string; readonly now: string },
  ): Promise<AssetRefreshInspection> {
    await this.closeUncommittedSourceRefreshRunsForInterruptedRecovery(
      execution,
      resumeClaim,
    );
    const current = await this.ports.executionQueries.inspectExecution(
      execution.id,
    );
    if (current === undefined || current.execution.status !== "running")
      return await this.inspectResumedPublic(execution.id);
    const interrupted = terminal(current.execution, "interrupted", reason);
    await this.ports.executionCommands.finishExecution(
      current.execution,
      interrupted,
      resumeClaim(),
    );
    return await this.inspectResumedPublic(interrupted.id);
  }

  /**
   * 中断的 Application 恢复不能遗留活动的领域权威来源刷新运行。领域取消只向前生效，
   * 因此保留所有已提交事实，并在工作流执行取得中断结果前只关闭未提交范围。
   */
  private async closeUncommittedSourceRefreshRunsForInterruptedRecovery(
    execution: WorkflowExecution,
    resumeClaim: () => { readonly token: string; readonly now: string },
  ): Promise<void> {
    const inspection = await this.ports.executionQueries.inspectExecution(
      execution.id,
    );
    const runIds = [
      ...new Set(
        inspection?.execution.sourceRefreshRunIds ??
          execution.sourceRefreshRunIds ??
          [],
      ),
    ];
    if (runIds.length === 0) return;
    const embedded = new Map(
      (inspection?.sourceRefreshRuns ?? []).map((run) => [run.id, run]),
    );
    const authority = this.ports.sourceRefreshRuns;
    const recoveryCommands = this.ports.recoverySourceRefreshRuns;
    for (const runId of runIds) {
      const known = embedded.get(runId);
      if (known?.phase === "terminal") continue;
      if (authority === undefined || recoveryCommands === undefined) {
        throw new Error(
          "Source Refresh Run 正在执行，但当前组合没有可安全关闭它的恢复 authority",
        );
      }
      const run = await authority.inspectSourceRefreshRun(runId);
      if (run === undefined || run.phase === "terminal") continue;
      await recoveryCommands.cancelUncommittedRun({
        executionId: execution.id,
        runId: run.id,
        resumeClaim: resumeClaim(),
      });
    }
  }

  private metadataPolicyIdsFor(
    accepted: AcceptedRecognition,
  ): readonly string[] {
    const configuration = this.ports.metadataPolicyConfiguration;
    if (configuration === undefined) return [];
    if (configuration.version.length === 0)
      throw new Error("Metadata Policy configuration version is empty");
    const definitions = new Map(
      configuration.policies.map((policy) => [policy.id, policy]),
    );
    if (definitions.size !== configuration.policies.length)
      throw new Error(
        "Metadata Policy configuration has duplicate identifiers",
      );
    const enrolled = [...new Set(configuration.enroll(accepted))];
    for (const definition of configuration.policies) {
      validateMetadataPolicy({
        ...definition,
        subjectIds: [accepted.entity.id],
      });
    }
    for (const policyId of enrolled) {
      if (!definitions.has(policyId))
        throw new Error(
          `Metadata Policy enrollment references unknown policy ${policyId}`,
        );
    }
    return enrolled;
  }

  private async transition(
    expected: WorkflowExecution,
    next: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void> {
    await this.ports.executionCommands.transitionExecution(
      expected,
      next,
      resumeClaim,
    );
  }

  /**
   * 候选规划发生在能力坐标耐久冻结后、形成来源补充检查点前。因此解释器抛错时不存在
   * 可以诚实捏造的可恢复候选意图。先回读权威执行以保留前序冻结／目标迁移，再以终态
   * 记录普通端口失败。
   */
  private async failLatestEnrichmentPlanningExecution(
    fallback: WorkflowExecution,
    error: unknown,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<WorkflowExecution> {
    const latest = await this.ports.executionQueries.inspectExecution(
      fallback.id,
    );
    const current = latest?.execution ?? fallback;
    if (current.status !== "running") return current;
    const failed = terminal(current, "failed", errorMessage(error));
    await this.transition(current, failed, resumeClaim);
    return failed;
  }

  private async inspectPublic(
    executionId: string,
  ): Promise<AssetRefreshInspection> {
    const inspection =
      await this.ports.executionQueries.inspectExecution(executionId);
    if (inspection === undefined) throw new Error("刷新记录在提交后不可读取");
    const preview =
      await this.ports.changeImpactQueries.inspectChangeImpactPreviewForExecution(
        executionId,
      );
    return {
      ...publicInspection(inspection, this.ports.metadataPolicyConfiguration),
      ...(preview === undefined
        ? {}
        : { changeImpactPreview: publicChangeImpactPreview(preview) }),
    };
  }

  private async inspectResumedPublic(
    executionId: string,
  ): Promise<AssetRefreshInspection> {
    return await this.inspectPublic(executionId);
  }

  private async hasReusableManagedArtifacts(
    execution: WorkflowExecution,
    requirement: InformationRequirement,
  ): Promise<boolean> {
    const requiredRoles = requirement.artifactRoles
      .filter((item) => item.necessity === "required")
      .map((item) => item.role);
    if (requiredRoles.length === 0) return true;
    const inspection = await this.ports.executionQueries.inspectExecution(
      execution.id,
    );
    for (const role of requiredRoles) {
      const association = inspection?.accepted?.artifactAssociations.find(
        (item) => item.role === role,
      );
      const location = inspection?.accepted?.locations.find(
        (item) =>
          item.artifactId === association?.artifactId &&
          item.kind === "managed",
      );
      if (location === undefined) return false;
      if (
        this.ports.managedStore.isAvailable !== undefined &&
        !(await this.ports.managedStore.isAvailable(location.address))
      )
        return false;
    }
    return true;
  }

  private async acceptedSatisfiesInformationRequirement(
    accepted: AcceptedRecognition,
    requirement: InformationRequirement,
  ): Promise<boolean> {
    for (const requested of requirement.metadata) {
      if (
        requested.necessity === "required" &&
        !accepted.metadata.some(
          (assertion) => assertion.property === requested.property,
        )
      )
        return false;
    }
    for (const requested of requirement.relationshipTypes) {
      if (
        requested.necessity === "required" &&
        !(accepted.relationships ?? []).some(
          (relationship) => relationship.type === requested.type,
        )
      )
        return false;
    }
    for (const requested of requirement.artifactRoles) {
      if (requested.necessity !== "required") continue;
      const matched = accepted.artifactAssociations.filter(
        (association) => association.role === requested.role,
      );
      if (matched.length === 0) return false;
      const managedLocations = matched.flatMap((association) =>
        accepted.locations.filter(
          (location) =>
            location.artifactId === association.artifactId &&
            location.kind === "managed",
        ),
      );
      if (managedLocations.length === 0) return false;
      if (this.ports.managedStore.isAvailable !== undefined) {
        for (const location of managedLocations) {
          if (!(await this.ports.managedStore.isAvailable(location.address)))
            return false;
        }
      }
    }
    return true;
  }
}

type AssetRefreshAutomationOperations = Pick<
  AssetRefreshWorkflow,
  "scanObservedScope" | "recoverRunningExecutions" | "fulfillInformation"
>;

type AssetRefreshAutomationPorts = {
  readonly executionQueries: WorkflowExecutionQueries;
  readonly automationQueries: AutomationQueries;
  readonly automationCommands: AutomationCommands;
  /**
   * 自动化意图耐久化前检查授权。这仍是 Application 持有的边界：调度不推断文件系统
   * 权威，也绝不接收宿主机路径映射。
   */
  readonly observedRootRegistrations: Pick<
    ObservedRootRegistrations,
    "resolveActiveScope" | "closeBoundScope"
  >;
  readonly recognitionPolicyVersion: string;
  /** 旧版静态中立需求；绝不持久化到意图。 */
  readonly informationRequirement?: InformationRequirement;
  /**
   * 由外层组合为每个已接受主体重建。这里它是不透明中立需求回调：Application 绝不
   * 接收资产视图、组件、路由或提供方专用模型。
   */
  readonly informationRequirementForAcceptedSubject?: AutomationInformationRequirementResolver;
};

export class AssetRefreshAutomation {
  private readonly workflow: AssetRefreshAutomationOperations;
  private readonly ports: AssetRefreshAutomationPorts;

  constructor(
    workflow: AssetRefreshAutomationOperations,
    ports: AssetRefreshAutomationPorts,
  ) {
    this.workflow = workflow;
    this.ports = ports;
  }

  async enableAutomation(input: {
    readonly observedRootId: string;
    readonly relativeScope: string;
    readonly intervalMilliseconds: number;
    readonly acceptTrusted: boolean;
    readonly policyReferences?: readonly string[];
    readonly runInitial?: boolean;
    readonly onIntentCreated?: (intent: AutomationIntent) => void;
    readonly onInitialExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onInitialCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<{
    readonly intent: AutomationIntent;
    readonly initial?: AutomationTriggerResult;
  }> {
    if (
      !Number.isSafeInteger(input.intervalMilliseconds) ||
      input.intervalMilliseconds <= 0
    )
      throw new Error("自动刷新间隔必须为正数");
    // 在首次耐久写入前立即解析。后续触发通过 `scanObservedScope` 再次解析，因此本次
    // 预检与运行之间的配置变更不能授权文件系统工作。
    const preflight =
      await this.ports.observedRootRegistrations.resolveActiveScope({
        registrationId: input.observedRootId,
        relativeScope: input.relativeScope,
      });
    let authorization: AutomationObservedRootAuthorization;
    try {
      if (preflight.root.id !== input.observedRootId) {
        throw new ObservedRootUnavailable("文件位置配置不一致，请刷新后重试");
      }
      const frozenAuthorization = freezeObservedRootAutomationAuthorization(
        preflight.root,
      );
      if (frozenAuthorization === undefined) {
        throw new ObservedRootUnavailable(
          "文件位置的允许链接目标当前不可用，请刷新后重试",
        );
      }
      authorization = frozenAuthorization;
    } finally {
      // 预检证明已配置范围现在可以绑定；它不向后续定时器授予权威。在耐久配置写入前
      // 释放其短期描述符。
      await this.ports.observedRootRegistrations.closeBoundScope(
        preflight.scope,
      );
    }
    const intent: AutomationIntent = {
      id: id("automation-intent"),
      scope: {
        // 持久化权威边界返回的注册坐标，而不是调用方未规范化的路径拼写。原子持久化端口
        // 写入意图时仍会证明该精确冻结坐标当前有效。
        observedRootId: preflight.root.id,
        relativeScope: preflight.relativeScope,
      },
      enabled: true,
      intervalMilliseconds: input.intervalMilliseconds,
      workflowInputVersion: "asset-refresh-input/1",
      runInitial: input.runInitial !== false,
      policyReferences: input.policyReferences ?? [
        this.ports.recognitionPolicyVersion,
      ],
      acceptTrusted: input.acceptTrusted,
    };
    const created =
      await this.ports.automationCommands.createAutomationIntentForObservedRoot(
        { intent, authorization },
      );
    if (created.status !== "created") {
      throw new ObservedRootUnavailable(
        "文件位置已停用或配置已变更，请刷新后重试",
      );
    }
    input.onIntentCreated?.(intent);
    const initial = !intent.runInitial
      ? undefined
      : await this.triggerAutomation(intent.id, "initial", new Date(), {
          onExecutionStarted: input.onInitialExecutionStarted,
          onCheckpoint: input.onInitialCheckpoint,
        });
    return { intent, ...(initial === undefined ? {} : { initial }) };
  }

  async disableAutomation(intentId: string): Promise<void> {
    await this.ports.automationCommands.setAutomationIntentEnabled(
      intentId,
      false,
    );
  }

  async listAutomationIntents(): Promise<readonly AutomationIntent[]> {
    return await this.ports.automationQueries.listAutomationIntents();
  }

  async triggerAutomation(
    intentId: string,
    trigger: AutomationTrigger = "scan-now",
    now = new Date(),
    lifecycle?: {
      readonly onExecutionStarted?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
      readonly onCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
    },
  ): Promise<AutomationTriggerResult> {
    const intent =
      await this.ports.automationQueries.inspectAutomationIntent(intentId);
    if (intent === undefined) throw new Error("未找到自动刷新意图");
    if (trigger !== "scan-now" && !intent.enabled)
      return { status: "disabled", reason: "自动刷新已停用" };
    const executionId = id("execution");
    try {
      const execution = await this.workflow.scanObservedScope({
        registrationId: intent.scope.observedRootId,
        relativeScope: intent.scope.relativeScope,
        acceptTrusted: intent.acceptTrusted,
        // 识别前无法得到视图专用需求。保持扫描输入中立，并从已接受主体重建需求。
        ...(this.ports.informationRequirementForAcceptedSubject === undefined
          ? { informationRequirement: this.ports.informationRequirement }
          : {}),
        executionId,
        automationIntentId: intent.id,
        trigger,
        initiatedBy: `automation:${intent.id}`,
        configurationReferences: intent.policyReferences,
        requestedAt: now.toISOString(),
        onExecutionStarted: lifecycle?.onExecutionStarted,
        onHostCheckpoint: lifecycle?.onCheckpoint,
      });
      const childHasUnavailablePrerequisite =
        await this.fulfillAcceptedInformation(execution);
      const hasUnavailablePrerequisite =
        executionHasUnavailablePrerequisite(execution.execution) ||
        childHasUnavailablePrerequisite;
      if (trigger !== "scan-now" && hasUnavailablePrerequisite) {
        await this.ports.automationCommands.setAutomationIntentEnabled(
          intent.id,
          false,
          "prerequisite-unavailable",
        );
      }
      return { status: "started", execution };
    } catch (error) {
      if (error instanceof AutomationExecutionNotStarted)
        return error.disposition === "disabled"
          ? { status: "disabled", reason: "自动刷新已停用" }
          : { status: "skipped", reason: "同一自动刷新意图已有进行中的执行" };
      if (trigger !== "scan-now" && error instanceof ObservedRootUnavailable) {
        // 重复定时器不能把一个持续不可用的根变成无界的等价失败执行历史。耐久意图仍是
        // 审计坐标；挂载或权限修复后，由操作方明确重新启用。
        await this.ports.automationCommands.setAutomationIntentEnabled(
          intent.id,
          false,
          "observed-root-unavailable",
        );
        return { status: "skipped", reason: error.message };
      }
      throw error;
    } finally {
      await this.releaseTerminalTrigger(intentId, executionId, trigger, now);
    }
  }

  /** 通用恢复后，自动化只贡献运行时持有者释放。 */
  async releaseRecoveredAutomationRuntime(
    recovered: readonly AssetRefreshInspection[],
  ): Promise<void> {
    for (const inspection of recovered) {
      const execution = inspection.execution;
      const trigger = execution.workflowInput?.trigger ?? execution.trigger;
      if (
        execution.automationIntentId !== undefined &&
        isAutomationTrigger(trigger)
      ) {
        await this.fulfillAcceptedInformation(inspection);
        await this.releaseTerminalTrigger(
          execution.automationIntentId,
          execution.id,
          trigger,
          new Date(),
        );
      }
    }
  }

  private async fulfillAcceptedInformation(
    inspection: AssetRefreshInspection,
  ): Promise<boolean> {
    const accepted = [
      ...(inspection.accepted === undefined ? [] : [inspection.accepted]),
      ...(inspection.itemResults ?? []).flatMap((item) =>
        item.accepted === undefined ? [] : [item.accepted],
      ),
    ];
    const resolver = this.ports.informationRequirementForAcceptedSubject;
    const initiation = {
      version: "information-fulfillment-initiation/1" as const,
      parentExecutionId: inspection.execution.id,
    };
    if (resolver !== undefined) {
      const bySubject = new Map(
        accepted.map((subject) => [subject.entity.id, subject]),
      );
      const readiness = await Promise.all(
        [...bySubject.values()].map(
          async (subject) =>
            await this.workflow.fulfillInformation({
              selection: { subjectIds: [subject.entity.id] },
              requirement: resolver(subject),
              initiation,
            }),
        ),
      );
      return await this.requiredReadinessHasUnavailablePrerequisite(readiness);
    }
    const requirement = this.ports.informationRequirement;
    if (requirement === undefined) return false;
    const subjectIds = accepted.map((subject) => subject.entity.id);
    if (subjectIds.length === 0) return false;
    const readiness = await this.workflow.fulfillInformation({
      selection: { subjectIds: [...new Set(subjectIds)] },
      requirement,
      initiation,
    });
    return await this.requiredReadinessHasUnavailablePrerequisite([readiness]);
  }

  private async requiredReadinessHasUnavailablePrerequisite(
    readiness: readonly InformationReadiness[],
  ): Promise<boolean> {
    const executionIds = new Set(
      readiness.flatMap((result) =>
        result.subjects.flatMap((subject) =>
          subject.inputs.flatMap((input) =>
            input.necessity !== "required"
              ? []
              : (input.executionReferences ?? []).map(
                  (reference) => reference.workflowExecutionId,
                ),
          ),
        ),
      ),
    );
    for (const executionId of executionIds) {
      const inspection =
        await this.ports.executionQueries.inspectExecution(executionId);
      if (
        inspection !== undefined &&
        executionHasUnavailablePrerequisite(inspection.execution)
      )
        return true;
    }
    return false;
  }

  async triggerDueAutomation(
    now = new Date(),
    lifecycle?: { readonly onCheckpoint: () => void },
  ): Promise<readonly AutomationTriggerResult[]> {
    const intents = await this.ports.automationQueries.listAutomationIntents();
    const results: AutomationTriggerResult[] = [];
    for (const intent of intents.filter((candidate) => candidate.enabled)) {
      lifecycle?.onCheckpoint?.();
      const priorInformation =
        await this.classifyPriorInformationFulfillment(intent);
      if (priorInformation === "waiting") {
        results.push({
          status: "skipped",
          reason: "信息履行仍在进行中",
        });
        continue;
      }
      if (priorInformation === "unavailable") {
        await this.ports.automationCommands.setAutomationIntentEnabled(
          intent.id,
          false,
          "prerequisite-unavailable",
        );
        results.push({
          status: "skipped",
          reason: "自动刷新所需的前置条件当前不可用",
        });
        continue;
      }
      results.push(
        await this.triggerAutomation(intent.id, "interval", now, {
          onCheckpoint: lifecycle?.onCheckpoint,
        }),
      );
    }
    return results;
  }

  /**
   * 父扫描可以在宿主持有的信息履行子执行前完成。后续定时器触发创建另一个父执行前必须
   * 检查该耐久图；运行中的子执行归类为等待，终态类型化前置条件失败与上方同步路径属于
   * 同一种耐久降级。
   */
  private async classifyPriorInformationFulfillment(
    intent: AutomationIntent,
  ): Promise<"waiting" | "unavailable" | undefined> {
    // 生产持久化公开这个必需查询；少数窄范围进程内旧测试刻意只提供检查。
    const listExecutions = this.ports.executionQueries.listExecutions;
    if (listExecutions === undefined) return undefined;
    const newestFirstExecutions = await listExecutions.call(
      this.ports.executionQueries,
    );
    const parent = newestFirstExecutions.find(
      (execution) => execution.automationIntentId === intent.id,
    );
    if (parent === undefined) return undefined;
    const prefix = `information-fulfillment:${parent.id}:`;
    const children = newestFirstExecutions.filter((execution) =>
      execution.workflowInput?.initiatedBy?.startsWith(prefix),
    );
    if (children.some((child) => child.status === "running")) return "waiting";
    if (children.some(executionHasUnavailablePrerequisite))
      return "unavailable";
    return undefined;
  }

  private async releaseTerminalTrigger(
    intentId: string,
    executionId: string,
    trigger: AutomationTrigger,
    now: Date,
  ): Promise<void> {
    const inspection =
      await this.ports.executionQueries.inspectExecution(executionId);
    if (inspection !== undefined && inspection.execution.status !== "running")
      await this.ports.automationCommands.releaseAutomationTrigger({
        intentId,
        executionId,
        trigger,
        now: now.toISOString(),
      });
  }
}

function isAutomationTrigger(
  trigger: string | undefined,
): trigger is AutomationTrigger {
  return (
    trigger === "initial" || trigger === "interval" || trigger === "scan-now"
  );
}

function executionHasUnavailablePrerequisite(
  execution: Pick<WorkflowExecution, "dispositions" | "workItems">,
): boolean {
  return (
    execution.dispositions.some(workFailureIsPrerequisiteUnavailable) ||
    execution.workItems?.some(workFailureIsPrerequisiteUnavailable) === true
  );
}

function sourceCollectionFailureIsPrerequisiteUnavailable(
  failure: SourceCollectionFailure,
): boolean {
  return failure.failureClassification?.kind === "prerequisite-unavailable";
}

function workFailureIsPrerequisiteUnavailable(
  failure: Pick<WorkItemDisposition, "failureClassification">,
): boolean {
  return failure.failureClassification?.kind === "prerequisite-unavailable";
}

function filesystemPrerequisiteFailure(
  execution: WorkflowExecution,
  key: string,
  reason: string,
  error: unknown,
): WorkflowExecution {
  if (!(error instanceof ObservedRootUnavailable)) return execution;
  return {
    ...execution,
    dispositions: [
      ...execution.dispositions.filter(
        (disposition) => disposition.key !== key,
      ),
      {
        key,
        status: "failed",
        reason,
        failureClassification: prerequisiteUnavailableFailure,
      },
    ],
  };
}

function snapshotHasUnavailablePrerequisite(
  snapshot: FilesystemPackageSnapshot,
): boolean {
  return (snapshot.diagnostics ?? []).some(
    (diagnostic) =>
      diagnostic.kind === "entry-missing" ||
      diagnostic.kind === "entry-inaccessible" ||
      diagnostic.kind === "entry-identity-changed",
  );
}

export type AssetRefreshAutomationWorkflow = Pick<
  AssetRefreshAutomation,
  | "enableAutomation"
  | "disableAutomation"
  | "listAutomationIntents"
  | "triggerAutomation"
  | "triggerDueAutomation"
> &
  Pick<AssetRefreshWorkflow, "recoverRunningExecutions">;

export function attachAssetRefreshAutomation(
  workflow: AssetRefreshWorkflow,
  automation: AssetRefreshAutomation,
): AssetRefreshWorkflow & AssetRefreshAutomationWorkflow {
  const recoverRunningExecutions =
    workflow.recoverRunningExecutions.bind(workflow);
  return Object.assign(workflow, {
    enableAutomation: automation.enableAutomation.bind(automation),
    disableAutomation: automation.disableAutomation.bind(automation),
    listAutomationIntents: automation.listAutomationIntents.bind(automation),
    triggerAutomation: automation.triggerAutomation.bind(automation),
    recoverRunningExecutions: async (lifecycle?: RecoveryLifecycle) => {
      const recovered = await recoverRunningExecutions(lifecycle);
      await automation.releaseRecoveredAutomationRuntime(recovered);
      return recovered;
    },
    triggerDueAutomation: automation.triggerDueAutomation.bind(automation),
  });
}

function selectSourceArtifacts(
  proposal: RecognitionProposal,
  requirement: InformationRequirement,
): readonly SourceArtifactCandidate[] {
  const selected: SourceArtifactCandidate[] = [];
  for (const requested of requirement.artifactRoles) {
    if (
      requested.maximum !== undefined &&
      (!Number.isInteger(requested.maximum) || requested.maximum < 1)
    ) {
      throw new Error("信息需求中的产物数量上限无效");
    }
    const candidates = proposal.interpretation.sourceArtifacts.filter(
      (candidate) => candidate.role === requested.role,
    );
    const observedCandidates = proposal.observedArtifactParts?.filter(
      (candidate) => candidate.role === requested.role,
    );
    if (
      requested.necessity === "required" &&
      candidates.length === 0 &&
      (observedCandidates?.length ?? 0) === 0
    ) {
      throw new Error(`缺少必需的产物角色：${requested.role}`);
    }
    selected.push(...candidates.slice(0, requested.maximum ?? 1));
  }
  return selected;
}

/**
 * 信息履行只消费当前耐久来源刷新解释中的候选。历史识别提议绝不能替代该 lineage。
 */
function selectCurrentSourceArtifacts(
  candidates: CurrentSourceArtifactFacts["candidates"],
  requirement: InformationRequirement,
  subjectId: string,
): readonly CurrentSourceArtifactFacts["candidates"][number][] {
  const selected: CurrentSourceArtifactFacts["candidates"][number][] = [];
  for (const requested of requirement.artifactRoles) {
    if (
      requested.maximum !== undefined &&
      (!Number.isInteger(requested.maximum) || requested.maximum < 1)
    ) {
      throw new Error("信息需求中的产物数量上限无效");
    }
    const matching = candidates.filter(
      ({ candidate }) =>
        candidate.role === requested.role &&
        (candidate.subjectId === undefined ||
          candidate.subjectId === subjectId),
    );
    if (requested.necessity === "required" && matching.length === 0)
      throw new Error(`缺少必需的产物角色：${requested.role}`);
    selected.push(...matching.slice(0, requested.maximum ?? 1));
  }
  return selected;
}

function countArtifactRoles(
  associations: readonly ArtifactAssociation[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const association of associations)
    counts.set(association.role, (counts.get(association.role) ?? 0) + 1);
  return counts;
}

function upsertSourceEnrichmentCheckpoint(
  execution: WorkflowExecution,
  checkpoint: SourceEnrichmentCheckpoint,
): WorkflowExecution {
  const current = execution.sourceEnrichments ?? [];
  return {
    ...execution,
    sourceEnrichments: [
      ...current.filter((item) => item.key !== checkpoint.key),
      checkpoint,
    ],
  };
}

/**
 * 即使错误发生在采集创建记录保留检查点前，失败的来源补充仍是可恢复审计证据。该情况下
 * 失败联合刻意记录空采集基线，而不是捏造来源记录或重试指令。
 */
function failedSourceEnrichmentCheckpoint(
  checkpoint: SourceEnrichmentCheckpoint,
): Extract<SourceEnrichmentCheckpoint, { readonly stage: "failed" }> {
  return {
    ...checkpoint,
    stage: "failed",
    sourceRecordIds:
      checkpoint.stage === "candidate-interpreted"
        ? []
        : checkpoint.sourceRecordIds,
    collectionFailures:
      checkpoint.stage === "source-records-retained" ||
      checkpoint.stage === "failed"
        ? checkpoint.collectionFailures
        : [],
  };
}

/**
 * 补充来源只能填充尚未满足的请求角色。既有物化结果在该使用上下文中仍具权威，因此
 * 来源补充绝不下载背景图，也不替换已经可用的主封面。
 */
function selectEnrichmentSourceArtifacts(
  interpretation: SourceInterpretationBatch,
  requirement: InformationRequirement,
  fulfilled: ReadonlyMap<string, number>,
): readonly SourceArtifactCandidate[] {
  return requirement.artifactRoles.flatMap((requested) => {
    const maximum = requested.maximum ?? 1;
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new Error("信息需求中的产物数量上限无效");
    const remaining = Math.max(
      0,
      maximum - (fulfilled.get(requested.role) ?? 0),
    );
    return interpretation.sourceArtifacts
      .filter((candidate) => candidate.role === requested.role)
      .slice(0, remaining);
  });
}

/**
 * 由工作流而不是书目提供方把本地格式事实投影进已接受提议。工作项边界使这些不透明
 * 证据引用没有歧义，并保持提供方可替换。
 */
function attachObservedFormatFacts(
  proposal: RecognitionProposal,
  evidence: readonly import("@digital/domain").RecognitionEvidence[],
): RecognitionProposal {
  const selectedEvidence = new Set(
    proposal.ruleResults
      .filter((result) => result.outcome === "satisfied")
      .flatMap((result) => result.evidence),
  );
  const inspections = evidence
    .filter((item) => selectedEvidence.has(item))
    .flatMap((item) =>
      item.inspection === undefined
        ? []
        : [{ inspection: item.inspection, producer: item.producer }],
    );
  if (inspections.length === 0) return proposal;
  return {
    ...proposal,
    observedMetadata: inspections.flatMap(({ inspection, producer }) =>
      inspection.metadata.map((metadata) => ({
        ...metadata,
        observedArtifactReference: inspection.observedArtifactReference,
        producer,
      })),
    ),
    observedArtifactParts: inspections.flatMap(({ inspection, producer }) =>
      inspection.parts.map((part) => ({
        id: `observed-artifact-part_${randomUUID()}`,
        ...part,
        observedArtifactReference: inspection.observedArtifactReference,
        producer,
      })),
    ),
    observedArtifactRevisions: inspections.map(({ inspection, producer }) => ({
      observedArtifactReference: inspection.observedArtifactReference,
      blob: inspection.revision,
      producer,
    })),
  };
}

function validateRecognitionProposalForRecords(
  proposal: RecognitionProposal,
  sourceRecords: readonly SourceRecord[],
): RecognitionProposal {
  const available = new Set(sourceRecords.map((record) => record.id));
  const references = [
    ...(proposal.interpretation.recognitionEvidenceReferences ?? []),
    ...proposal.ruleResults.flatMap(
      (result) => result.evidenceReferences ?? [],
    ),
  ];
  if (
    references.some((reference) => !available.has(reference.sourceRecordId))
  ) {
    throw new Error(
      "Recognition Proposal references unavailable source evidence",
    );
  }
  return validateRecognitionProposal(proposal);
}

function selectObservedArtifactParts(
  proposal: RecognitionProposal,
  requirement: InformationRequirement,
): readonly ObservedArtifactPartCandidate[] {
  return requirement.artifactRoles.flatMap(
    (requested) =>
      proposal.observedArtifactParts
        ?.filter((candidate) => candidate.role === requested.role)
        .slice(0, requested.maximum ?? 1) ?? [],
  );
}

/** 候选 ID 只在完整服务语义中唯一。 */
function sourceArtifactCacheKey(candidate: SourceArtifactCandidate): string {
  return JSON.stringify({
    sourceRecordId: candidate.sourceRecordId,
    candidateId: candidate.id,
    subjectId: candidate.subjectId,
    role: candidate.role,
    acquisitionReference: candidate.acquisitionReference,
    mediaType: mediaTypeEssence(candidate.mediaType),
  });
}

function sourceArtifactIdempotencyKey(
  executionScope: string,
  candidate: SourceArtifactCandidate,
): string {
  return `${executionScope}:${sha256(
    new TextEncoder().encode(sourceArtifactCacheKey(candidate)),
  )}`;
}

/** 在生成任何效果键前，解析领域的普通省略主体简写。 */
function resolveSourceArtifactSubject(
  candidate: SourceArtifactCandidate,
  acceptedAssetId: string,
): SourceArtifactCandidate {
  return candidate.subjectId === undefined
    ? { ...candidate, subjectId: acceptedAssetId }
    : candidate;
}

/**
 * 新接受资产在首次提交前没有耐久身份。因此完整待处理检查点同时也是已选隐式服务主体
 * 的耐久记录；任何不完整内容都不能复活该身份或其暂存字节。
 */
function inferCheckpointedAcceptedAssetId(
  candidates: readonly SourceArtifactCandidate[],
  checkpoints: readonly (
    | SourceArtifactAcquisitionCheckpoint
    | ManagedSourceArtifactCheckpoint
  )[],
): string | undefined {
  const implicit = candidates.filter(
    (candidate) => candidate.subjectId === undefined,
  );
  if (implicit.length === 0) return undefined;
  const subjects = implicit.map((candidate) => {
    const matches = checkpoints.filter((checkpoint) =>
      checkpointMatchesCandidateExceptSubject(checkpoint, candidate),
    );
    const [match] = matches;
    return matches.length === 1 && match !== undefined
      ? match.subjectId
      : undefined;
  });
  if (subjects.some((subjectId) => subjectId === undefined)) return undefined;
  const resolved = new Set(subjects);
  const [subject] = subjects;
  return resolved.size === 1 ? subject : undefined;
}

function checkpointMatchesCandidateExceptSubject(
  checkpoint:
    | SourceArtifactAcquisitionCheckpoint
    | ManagedSourceArtifactCheckpoint,
  candidate: SourceArtifactCandidate,
): checkpoint is (
  | SourceArtifactAcquisitionCheckpoint
  | ManagedSourceArtifactCheckpoint
) & {
  readonly subjectId: string;
  readonly acquisitionReference: string;
} {
  const mediaType =
    "blob" in checkpoint ? checkpoint.blob.mediaType : checkpoint.mediaType;
  return (
    checkpoint.candidateId === candidate.id &&
    checkpoint.sourceRecordId === candidate.sourceRecordId &&
    checkpoint.subjectId !== undefined &&
    checkpoint.subjectId.length > 0 &&
    checkpoint.role === candidate.role &&
    checkpoint.acquisitionReference === candidate.acquisitionReference &&
    checkpoint.acquisitionReference.length > 0 &&
    mediaTypeEssence(mediaType) === mediaTypeEssence(candidate.mediaType)
  );
}

function sourceArtifactCheckpointMatchesCandidate(
  checkpoint: SourceArtifactAcquisitionCheckpoint,
  candidate: SourceArtifactCandidate,
): boolean {
  return (
    checkpoint.candidateId === candidate.id &&
    checkpoint.sourceRecordId === candidate.sourceRecordId &&
    checkpoint.subjectId === candidate.subjectId &&
    checkpoint.role === candidate.role &&
    checkpoint.acquisitionReference === candidate.acquisitionReference &&
    mediaTypeEssence(checkpoint.mediaType) ===
      mediaTypeEssence(candidate.mediaType)
  );
}

function managedSourceArtifactMatchesCandidate(
  checkpoint: ManagedSourceArtifactCheckpoint,
  candidate: SourceArtifactCandidate,
): boolean {
  return (
    checkpoint.candidateId === candidate.id &&
    checkpoint.sourceRecordId === candidate.sourceRecordId &&
    checkpoint.subjectId === candidate.subjectId &&
    checkpoint.role === candidate.role &&
    checkpoint.acquisitionReference === candidate.acquisitionReference &&
    mediaTypeEssence(checkpoint.blob.mediaType) ===
      mediaTypeEssence(candidate.mediaType)
  );
}

/**
 * 候选标识符以来源记录为范围，因此其获取定义必须跨工作项和进程重启保持稳定。服务主体
 * 与角色刻意保留在缓存键中：相同可下载材料可以合法服务不同主体，而不共享关联或托管
 * 产物检查点。
 */
function registerSourceArtifactDefinitions(
  definitions: Map<string, string>,
  candidates: readonly SourceArtifactCandidate[],
): void {
  for (const candidate of candidates) {
    const identity = `${candidate.sourceRecordId}\u0000${candidate.id}`;
    const definition = JSON.stringify({
      acquisitionReference: candidate.acquisitionReference,
      mediaType: mediaTypeEssence(candidate.mediaType),
    });
    const previous = definitions.get(identity);
    if (previous !== undefined && previous !== definition)
      throw new Error(
        "Source Artifact Candidate has contradictory acquisition semantics",
      );
    definitions.set(identity, definition);
  }
}

function assertInterpretationSatisfiesInformationRequirement(
  proposal: RecognitionProposal,
  requirement: InformationRequirement,
): void {
  for (const requested of requirement.metadata) {
    if (
      requested.necessity === "required" &&
      ![
        ...proposal.interpretation.metadata,
        ...(proposal.observedMetadata ?? []).map((item) => ({
          property: item.property,
        })),
      ].some((assertion) => assertion.property === requested.property)
    )
      throw new Error(`缺少必需的元数据属性：${requested.property}`);
  }
  for (const requested of requirement.relationshipTypes) {
    if (
      requested.necessity === "required" &&
      !(proposal.interpretation.relationships ?? []).some(
        (relationship) => relationship.type === requested.type,
      )
    )
      throw new Error(`缺少必需的关系类型：${requested.type}`);
  }
}

function createAcceptedRecognition(options: {
  readonly proposal: RecognitionProposal;
  readonly snapshot: FilesystemPackageSnapshot;
  readonly managedArtifacts: readonly ManagedSourceArtifactCheckpoint[];
  readonly managedObservedParts?: readonly ManagedObservedArtifactPart[];
  /** 在外部产物效果前分配，使省略的主体保持稳定。 */
  readonly asset?: DigitalAsset;
  /** 相同的已接受来源身份：保留其承载身份的事实。 */
  readonly current?: AcceptedRecognition;
  readonly observedArtifactBoundary?: "filesystem-package";
  readonly objectIdentityContract?: FilesystemObjectIdentityContract;
}): AcceptedRecognition {
  const asset: DigitalAsset = options.current?.entity ??
    options.asset ?? {
      id: id("entity"),
      kind: "digital-asset",
    };
  // ADR0030／ADR0036：观察路径名是定位项，而不是身份连续性证明。缺少观察器提供的
  // 不透明对象身份时，即使地址、大小、时间戳或内容摘要碰巧相同，后续接受的观察仍会
  // 得到新产物。Blob 身份刻意在持久化层通过摘要单独处理。
  const localArtifacts: Artifact[] = [];
  const localLocations: Location[] = [];
  const localAssociations: ArtifactAssociation[] = [];
  const localByObjectIdentity = new Map<string, Artifact>();
  const localAssociationIds = new Set<string>();
  const observedByRelativePath = new Map<string, Artifact>();
  const observedLocations =
    options.observedArtifactBoundary === "filesystem-package"
      ? [
          {
            address: options.snapshot.root,
            // 文件系统包边界是一个技术产物。它刻意不从成员推导文件对象连续性，因为
            // 该边界由包解释器持有。
          },
        ]
      : options.snapshot.files.map((file) => ({
          file,
          address: `${options.snapshot.root}/${file.relativePath}`,
        }));
  for (const observed of observedLocations) {
    const identity =
      "file" in observed
        ? observedObjectIdentityKey(
            observed.file,
            options.objectIdentityContract,
          )
        : undefined;
    const durableIdentity =
      "file" in observed
        ? durableObservedObjectIdentityKey(
            observed.file,
            options.objectIdentityContract,
          )
        : undefined;
    const artifactId =
      durableIdentity === undefined
        ? undefined
        : observedArtifactId(durableIdentity);
    let artifact =
      identity === undefined ? undefined : localByObjectIdentity.get(identity);
    if (artifact === undefined) {
      const createdArtifact: Artifact =
        artifactId === undefined
          ? { id: id("artifact") }
          : (options.current?.artifacts.find(
              (candidate) => candidate.id === artifactId,
            ) ?? { id: artifactId });
      artifact = createdArtifact;
      localArtifacts.push(createdArtifact);
      if (identity !== undefined)
        localByObjectIdentity.set(identity, createdArtifact);
      const association = options.current?.artifactAssociations.find(
        (candidate) =>
          candidate.subjectId === asset.id &&
          candidate.artifactId === createdArtifact.id &&
          candidate.role === "asset.material-delivered" &&
          (candidate.sourceRecordIds === undefined ||
            candidate.sourceRecordIds.length === 0) &&
          candidate.observedArtifactPart === undefined,
      ) ?? {
        id: observedArtifactAssociationId(asset.id, createdArtifact.id),
        subjectId: asset.id,
        artifactId: createdArtifact.id,
        role: "asset.material-delivered" as const,
      };
      if (!localAssociationIds.has(association.id)) {
        localAssociationIds.add(association.id);
        localAssociations.push(association);
      }
    }
    const location = options.current?.locations.find(
      (candidate) =>
        candidate.artifactId === artifact.id &&
        candidate.address === observed.address &&
        candidate.kind === "observed",
    ) ?? {
      id: observedLocationId(artifact.id, observed.address),
      artifactId: artifact.id,
      address: observed.address,
      kind: "observed" as const,
    };
    localLocations.push(location);
    if ("file" in observed)
      observedByRelativePath.set(observed.file.relativePath, artifact);
  }
  const managed = projectManagedSourceArtifacts(
    options.managedArtifacts,
    asset.id,
  );
  const observedRevisionByReference = new Map<
    string,
    { readonly artifactId: string; readonly revisionId: string }
  >();
  const observedRevisionsByReference = new Map<
    string,
    { readonly blob: Blob; readonly revision: ArtifactRevision }
  >();
  for (const candidate of options.proposal.observedArtifactRevisions ?? []) {
    const observedArtifact = observedByRelativePath.get(
      candidate.observedArtifactReference,
    );
    if (observedArtifact === undefined)
      throw new Error(
        "Observed Artifact Revision is outside the accepted work boundary",
      );
    const revision: ArtifactRevision = {
      id: `artifact-revision_${sha256(new TextEncoder().encode(`${observedArtifact.id}\u0000${candidate.blob.digest}`))}`,
      artifactId: observedArtifact.id,
      blobDigest: candidate.blob.digest,
      producer: candidate.producer,
    };
    observedRevisionByReference.set(candidate.observedArtifactReference, {
      artifactId: observedArtifact.id,
      revisionId: revision.id,
    });
    observedRevisionsByReference.set(candidate.observedArtifactReference, {
      blob: candidate.blob,
      revision,
    });
  }
  for (const part of options.managedObservedParts ?? []) {
    const observedArtifact = observedByRelativePath.get(
      part.candidate.observedArtifactReference,
    );
    if (observedArtifact === undefined)
      throw new Error(
        "Observed Artifact Part is outside the accepted work boundary",
      );
    const existing = observedRevisionsByReference.get(
      part.candidate.observedArtifactReference,
    );
    if (existing !== undefined) {
      if (existing.blob.digest !== part.origin.digest)
        throw new Error(
          "Observed Artifact Parts for one parent contradict its progressive hash",
        );
      continue;
    }
    const revision: ArtifactRevision = {
      id: `artifact-revision_${sha256(new TextEncoder().encode(`${observedArtifact.id}\u0000${part.origin.digest}`))}`,
      artifactId: observedArtifact.id,
      blobDigest: part.origin.digest,
      producer: part.producer,
    };
    observedRevisionByReference.set(part.candidate.observedArtifactReference, {
      artifactId: observedArtifact.id,
      revisionId: revision.id,
    });
    observedRevisionsByReference.set(part.candidate.observedArtifactReference, {
      blob: part.origin,
      revision,
    });
  }
  const observedRevisions = [
    ...new Map(
      [...observedRevisionsByReference.values()].map((item) => [
        item.revision.id,
        item,
      ]),
    ).values(),
  ];
  const localParts = (options.managedObservedParts ?? []).map((part) => {
    const origin = observedByRelativePath.get(
      part.candidate.observedArtifactReference,
    );
    if (origin === undefined)
      throw new Error(
        "Observed Artifact Part is outside the accepted work boundary",
      );
    const parentRevision = observedRevisionByReference.get(
      part.candidate.observedArtifactReference,
    );
    if (parentRevision === undefined)
      throw new Error(
        "Observed Artifact Part requires a progressively hashed parent Artifact Revision",
      );
    const materializationKey = createHash("sha256")
      .update(
        JSON.stringify({
          digest: part.blob.digest,
          role: part.candidate.role,
          origin: origin.id,
          locator: part.candidate.locator,
        }),
      )
      .digest("hex");
    const artifact: Artifact = { id: `artifact_${materializationKey}` };
    const location: Location = {
      id: `location_${materializationKey}`,
      artifactId: artifact.id,
      address: part.location.address,
      kind: "managed",
    };
    return {
      artifact,
      location,
      blob: part.blob,
      revision: {
        id: `artifact-revision_${materializationKey}`,
        artifactId: artifact.id,
        blobDigest: part.blob.digest,
        producer: part.producer,
      },
      association: {
        id: `artifact-association_${materializationKey}`,
        subjectId: asset.id,
        artifactId: artifact.id,
        role: part.candidate.role,
        producer: part.producer,
        observedArtifactPart: {
          artifactId: origin.id,
          revisionId: parentRevision.revisionId,
          locator: part.candidate.locator,
        },
      },
    };
  });
  const observedMetadata: MetadataAssertion[] = (
    options.proposal.observedMetadata ?? []
  ).map((candidate) => {
    const parent = observedRevisionByReference.get(
      candidate.observedArtifactReference,
    );
    if (parent === undefined)
      throw new Error(
        `Observed metadata requires a progressively hashed parent Artifact Revision for ${candidate.observedArtifactReference}; materialized parents: ${[...observedRevisionByReference.keys()].join(",")}`,
      );
    return {
      property: candidate.property,
      sourceSlot: candidate.sourceSlot,
      value: candidate.value,
      sourceRecordIds: [],
      producer: candidate.producer,
      observedArtifactPart: {
        artifactId: parent.artifactId,
        revisionId: parent.revisionId,
        locator: candidate.locator,
      },
    };
  });
  return {
    proposal: options.proposal,
    entity: asset,
    sourceAssociation: {
      id: options.current?.sourceAssociation.id ?? id("source-association"),
      subjectId: asset.id,
      sourceIdentity: options.proposal.interpretation.sourceIdentity,
      nativeAddress: options.proposal.interpretation.sourceAddress,
      proposalId:
        options.current?.sourceAssociation.proposalId ?? options.proposal.id,
    },
    recognitionDecision: {
      id: options.current?.recognitionDecision.id ?? id("recognition-decision"),
      proposalId:
        options.current?.recognitionDecision.proposalId ?? options.proposal.id,
      assetId: asset.id,
      acceptedRuleResults:
        options.current?.recognitionDecision.acceptedRuleResults ??
        options.proposal.ruleResults,
    },
    artifacts: [
      ...localArtifacts,
      ...managed.artifacts,
      ...localParts.map((item) => item.artifact),
    ],
    locations: [
      ...localLocations,
      ...managed.locations,
      ...localParts.map((item) => item.location),
    ],
    blobs: [
      ...managed.blobs,
      ...localParts.map((item) => item.blob),
      ...observedRevisions.map((item) => item.blob),
    ],
    artifactRevisions: [
      ...managed.revisions,
      ...localParts.map((item) => item.revision),
      ...observedRevisions.map((item) => item.revision),
    ],
    artifactAssociations: [
      ...localAssociations,
      ...managed.associations,
      ...localParts.map((item) => item.association),
    ],
    metadata: [
      ...options.proposal.interpretation.metadata,
      ...observedMetadata,
    ],
    entities: options.proposal.interpretation.entities ?? [],
    entityMentions: options.proposal.interpretation.entityMentions ?? [],
    entityResolutionDecisions:
      options.proposal.interpretation.entityResolutionDecisions ?? [],
    relationships: (options.proposal.interpretation.relationships ?? []).map(
      (relationship) => ({
        id: relationshipId(relationship, asset.id),
        ...relationship,
        subjectId: relationship.subjectId ?? asset.id,
      }),
    ),
  };
}

/**
 * 快照内身份刻意保持瞬时：它可以在一个结果中归组两个别名位置，但不能制造耐久产物
 * 标识符。只有已配置观察器明确声明提供该值的精确能力时，耐久值才有效。
 */
function observedObjectIdentityKey(
  file: FileObservation,
  contract: FilesystemObjectIdentityContract | undefined,
): string | undefined {
  const identity = file.objectIdentity;
  if (identity === undefined) return undefined;
  if (
    identity.version !== "filesystem-object-identity/2" ||
    typeof identity.value !== "string" ||
    identity.value.trim().length === 0 ||
    identity.value.length > 512
  ) {
    throw new Error(
      "Filesystem observation has an invalid opaque object identity",
    );
  }
  if (identity.kind === "snapshot-local") {
    if (contract?.kind !== "snapshot-local")
      throw new Error(
        "Filesystem observation emitted snapshot-local identity without its declared contract",
      );
    return JSON.stringify([identity.version, identity.kind, identity.value]);
  }
  if (
    identity.kind !== "durable" ||
    !isCapabilityCoordinate(identity.capability)
  )
    throw new Error(
      "Filesystem observation has an invalid opaque object identity",
    );
  if (
    contract?.kind !== "durable" ||
    !sameCapabilityCoordinate(contract.capability, identity.capability)
  ) {
    throw new Error(
      "Filesystem observation emitted durable identity without its declared capability",
    );
  }
  return JSON.stringify([
    identity.version,
    identity.kind,
    capabilityCoordinate(identity.capability),
    identity.value,
  ]);
}

function durableObservedObjectIdentityKey(
  file: FileObservation,
  contract: FilesystemObjectIdentityContract | undefined,
): string | undefined {
  const identity = file.objectIdentity;
  if (identity?.kind !== "durable" || contract?.kind !== "durable")
    return undefined;
  return observedObjectIdentityKey(file, contract);
}

function observedArtifactId(identity: string): string {
  return `artifact_${sha256(
    new TextEncoder().encode(`observed-object-identity\u0000${identity}`),
  )}`;
}

/**
 * 跨位置查找需要完整且精确的集合。只要一个观察文件缺少明确声明的耐久身份能力，就不
 * 得用该快照的任何部分推断既有资产。
 */
function exactObservedArtifactIds(
  snapshot: FilesystemPackageSnapshot,
  contract: FilesystemObjectIdentityContract | undefined,
): readonly string[] | undefined {
  if (
    contract?.kind !== "durable" ||
    !isCapabilityCoordinate(contract.capability) ||
    !snapshot.complete ||
    snapshot.files.length === 0
  )
    return undefined;
  const artifactIds = new Set<string>();
  for (const file of snapshot.files) {
    const identity = durableObservedObjectIdentityKey(file, contract);
    if (identity === undefined) return undefined;
    artifactIds.add(observedArtifactId(identity));
  }
  return [...artifactIds].toSorted();
}

function observedArtifactAssociationId(
  assetId: string,
  artifactId: string,
): string {
  return `artifact-association_${sha256(
    new TextEncoder().encode(
      `${assetId}\u0000${artifactId}\u0000asset.material-delivered`,
    ),
  )}`;
}

function observedLocationId(artifactId: string, address: string): string {
  return `location_${sha256(
    new TextEncoder().encode(`${artifactId}\u0000observed\u0000${address}`),
  )}`;
}

/**
 * 资产范围关系是接受过程内的事实；而来源实体之间的明确关系可以由一个包中的多个资产
 * 投影。为后者赋予语义身份，使持久化只记录一次，而不是为每一集制造一条关系。
 */
function relationshipId(
  relationship: NonNullable<SourceInterpretationBatch["relationships"]>[number],
  fallbackSubjectId: string,
): string {
  if (relationship.subjectId === undefined) return id("entity-relationship");
  const semanticKey = [
    relationship.subjectId ?? fallbackSubjectId,
    relationship.participantId,
    relationship.type,
    relationship.role,
    relationship.sourceSlot,
  ].join("\u0000");
  return `entity-relationship_${sha256(new TextEncoder().encode(semanticKey))}`;
}

function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function collectionFailureBlocks(
  failure: SourceCollectionFailure,
  requirement: InformationRequirement,
): boolean {
  const affects = failure.affects;
  if (affects === undefined || affects.recognition === true) return true;
  const requiredMetadata = new Set(
    requirement.metadata
      .filter((item) => item.necessity === "required")
      .map((item) => item.property),
  );
  const requiredArtifactRoles = new Set(
    requirement.artifactRoles
      .filter((item) => item.necessity === "required")
      .map((item) => item.role),
  );
  const requiredRelationshipTypes = new Set(
    requirement.relationshipTypes
      .filter((item) => item.necessity === "required")
      .map((item) => item.type),
  );
  return (
    (affects.metadataProperties ?? []).some((property) =>
      [...requiredMetadata].some((required) =>
        affectedInformationMatches(property, required),
      ),
    ) ||
    (affects.artifactRoles ?? []).some((role) =>
      [...requiredArtifactRoles].some((required) =>
        affectedInformationMatches(role, required),
      ),
    ) ||
    (affects.relationshipTypes ?? []).some((type) =>
      [...requiredRelationshipTypes].some((required) =>
        affectedInformationMatches(type, required),
      ),
    )
  );
}

/**
 * 采集器持有其范围含义。Application 只在一次执行内共享相同声明范围，绝不检查提供方
 * 地址或载荷。
 */
function sourceCollectionShareKey(
  collector: SourceCollector,
  evidence: import("@digital/domain").RecognitionEvidence,
): string | undefined {
  const scopes = collector.collectionScopeIds?.(evidence) ?? [];
  if (scopes.length === 0 || scopes.some((scope) => scope.length === 0))
    return undefined;
  return JSON.stringify({
    capability: collector.capability,
    scopes: [...new Set(scopes)].toSorted(),
  });
}

/**
 * 恢复过程从耐久工作项规划证据和不可变保留来源记录重建执行内共享。它只向采集器请求
 * 不透明范围坐标；Application 绝不解释提供方地址或载荷。
 */
function persistedSharedCollectionRecords(
  inspection: ExecutionInspection | undefined,
  plans: readonly AssetRefreshWorkItemPlan[],
  collector: SourceCollector,
  sharedKey: string,
): readonly SourceRecord[] {
  if (inspection === undefined) return [];
  const ids = new Set<string>();
  for (const item of inspection.execution.workItems ?? []) {
    const plan = plans.find((candidate) => candidate.key === item.key);
    if (
      plan === undefined ||
      !plan.evidence.some(
        (evidence) =>
          collector.canCollect(evidence) &&
          sourceCollectionShareKey(collector, evidence) === sharedKey,
      )
    )
      continue;
    for (const id of item.sourceRecordIds) ids.add(id);
  }
  if (ids.size === 0) return [];
  return inspection.sourceRecords.filter((record) => ids.has(record.id));
}

function partialCollectionReason(
  failures: readonly SourceCollectionFailure[],
): string {
  return `已保留可用官方记录；未请求的信息仍不可用：${failures
    .map((failure) => failure.reason)
    .join("；")}`;
}

/**
 * 兼容性或信息需求变更可以要求再次求值，但它本身不是新文件观察。身份保持重新求值只
 * 留给后者或新目录证据，因此能力升级不会仅因重新采集相同普通范围就制造新的产物阶段。
 */
function ordinaryObservationOrEvidenceBaselineChanged(
  current: OrdinaryScanReusePlan | undefined,
  next: OrdinaryScanReusePlan | undefined,
): boolean {
  if (current === undefined || next === undefined) return true;
  const currentByKey = new Map(
    current.workItems.map((item) => [item.key, item]),
  );
  if (currentByKey.size !== next.workItems.length) return true;
  return next.workItems.some((item) => {
    const prior = currentByKey.get(item.key);
    return (
      prior === undefined ||
      prior.domainBaseline !== item.domainBaseline ||
      prior.sourceBaseline !== item.sourceBaseline
    );
  });
}

/**
 * 快照内身份跨观察刻意保持不透明，但其别名等价关系仍是复用基线的有用输入。把每快照
 * 随机令牌替换为从该别名类已排序逻辑路径派生的确定性类令牌。这样稳定同根扫描仍可
 * 复用，而硬链接／符号链接归组变化仍会改变指纹。耐久身份原样保留能力和值。
 */
function reuseComparableFiles(
  files: readonly FileObservation[],
): readonly FileObservation[] {
  const pathsBySnapshotIdentity = new Map<string, string[]>();
  for (const file of files) {
    if (file.objectIdentity?.kind !== "snapshot-local") continue;
    const paths = pathsBySnapshotIdentity.get(file.objectIdentity.value) ?? [];
    paths.push(file.relativePath);
    pathsBySnapshotIdentity.set(file.objectIdentity.value, paths);
  }
  if (pathsBySnapshotIdentity.size === 0) return files;

  const normalizedClassBySnapshotIdentity = new Map<string, string>();
  for (const [identity, paths] of pathsBySnapshotIdentity) {
    const stablePaths = paths.toSorted();
    normalizedClassBySnapshotIdentity.set(
      identity,
      `snapshot-local-alias-class/${sha256(
        new TextEncoder().encode(JSON.stringify(stablePaths)),
      )}`,
    );
  }
  return files.map((file) => {
    const identity = file.objectIdentity;
    if (identity?.kind !== "snapshot-local") return file;
    const normalized = normalizedClassBySnapshotIdentity.get(identity.value);
    if (normalized === undefined)
      throw new Error("Snapshot-local alias class was not collected");
    return {
      ...file,
      objectIdentity: { ...identity, value: normalized },
    };
  });
}

function affectedInformationMatches(
  affected: string,
  required: string,
): boolean {
  return (
    affected === required ||
    (affected.endsWith(".*") && required.startsWith(affected.slice(0, -1)))
  );
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
