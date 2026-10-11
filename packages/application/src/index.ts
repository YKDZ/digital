import { createHash, randomUUID } from "node:crypto";

import {
  type AcceptedRecognition,
  type Artifact,
  type ArtifactAssociation,
  type ArtifactRevision,
  type ArtifactRoleDecision,
  type Blob,
  type CapabilityCoordinate,
  type CreateSourceRefreshRunInput,
  type DescriptionTarget,
  type DigitalAsset,
  deriveEffectiveMetadata,
  type EffectiveMetadata,
  type EvidenceComparison,
  type Location,
  type MetadataAssertion,
  type MetadataPolicy,
  type ObservedMaterialAssociationSubmission,
  type ObservedMaterialAssociationAudit,
  type ObservedMaterialAssociationProjection,
  type RecognitionEvidence,
  type RecognitionDecision,
  type RecognitionMaterialBoundary,
  sameRecognitionMaterialBoundaries,
  projectArtifactRoleDecisionHead,
  type RecognitionBasis,
  type ObservedArtifactAssociationCandidate,
  type RecognitionProposal,
  type RecognitionProposalDraft,
  type RecognitionRuleResult,
  type EntityRelationship,
  type EntityRelationshipParticipant,
  type EffectiveEntityKind,
  type RelationshipDraft,
  type SourcedEntity,
  type SourceAssociation,
  type SourceAssociationChangeProposal,
  type SourceAssociationDecision,
  type SourceArtifactCandidate,
  type SourceCoverageScope,
  type SourceRefreshRun,
  type ObservedArtifactPartCandidate,
  type ObservedEntityGraphCandidate,
  type SourceInterpretationBatch,
  type SourceRecord,
  decodeLibraryScanDirectoryCoverage,
  decodeLibraryScanPlan,
  type LibraryScanDirectoryCoverage,
  type LibraryScanDirectoryPlan,
  type LibraryScanDirectoryUnavailable,
  type LibraryScanPlan,
  recognitionSourceInterpretation,
  validateAcceptedRecognition,
  validateArtifactRoleDecision,
  validateMetadataPolicy,
  validateObservedEntityGraphCandidates,
  validateRecognitionProposal,
  validateObservedMaterialAssociationSubmission,
  validateReevaluatedRecognition,
  validateSourceAssociationChange,
  validateSourceInterpretationBatch,
} from "@digital/domain";

import {
  assetLibraryCapabilityToken,
  assetLibrarySnapshotFingerprint,
  assetLibrarySnapshotSourceScope,
  decodeAssetLibrarySnapshot,
  type AssetLibraries,
  type AssetLibraryCapability,
  type AssetLibrarySnapshot,
  type AssetLibrarySnapshotSource,
} from "./asset-libraries.ts";
import {
  assetRefreshSelectionVersion,
  assertAssetRefreshSelection,
  freezeAssetRefreshSelection,
  type AssetRefreshSelection,
  type ResolvedAssetRefreshSelection,
} from "./asset-refresh-selection.ts";
import {
  artifactRoleCandidates,
  descriptionTargetKey,
  readEffectiveSubject,
  subjectConflictEvidence,
  type ArtifactRoleCandidate,
  type CurrentLocationRead,
  type EffectiveArtifactRoleRead,
  type EffectiveSubjectRead,
  type RelationshipReadBasis,
  type SubjectConflictEvidence,
  type SubjectFactBasis,
} from "./effective-fact-reads.ts";
import type {
  ExecutionHost,
  ExecutionInvocationControl,
  OperationLease,
} from "./execution-host.ts";
import {
  InformationFulfillment,
  type InformationFulfillmentCapability,
  type InformationFulfillmentInitiation,
  type InformationFulfillmentPendingReconciliation,
  type InformationFulfillmentPlan,
  type InformationFulfillmentPlanEnvelope,
  type InformationFulfillmentPreparation,
  type InformationFulfillmentStart,
  type InformationReadiness,
  type InformationSubjectFacts,
  type InformationSubjectReadiness,
  type InformationSubjectSelection,
  terminalInformationReadiness,
} from "./information-fulfillment.ts";
import {
  decodeFrozenDirectoryAuthorizations,
  type FrozenDirectoryAuthorization,
} from "./library-directory-grants.ts";
import {
  coveredWorkItems,
  libraryScanDirectoryFromPlan,
  libraryScanDirectoryResult,
  libraryScanEntryOutcome,
  libraryScanLedgerWrite,
  planLibraryScanDirectories,
  sanitizeScanReason,
  summarizeLibraryScan,
  type LibraryScanChildCoordinates,
  type LibraryScanDirectoryInspection,
  type LibraryScanDirectoryRecord,
  type LibraryScanDirectoryResult,
  type LibraryScanDirectoryStage,
  type LibraryScanDirectoryWorkItem,
  type LibraryScanEntryOutcome,
  type LibraryScanInspection,
  type LibraryScanInspectionDetail,
  type LibraryScanRun,
  type UnrecognizedLibraryScanObservation,
} from "./library-scan-plan.ts";
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
  bindRecognitionMaterialBoundaries,
  groupMaterialScopeDeclarations,
  isWithinObservedDirectory,
  observedAddress,
  materialScopeDeclarationBaseline,
  materialScopeDeclarationsIntersect,
  reconcileRecognitionMaterialPlans,
  RecognitionBoundaryBaselineStale,
  type EffectiveRecognitionMaterialBoundary,
  type MaterialScopeDeclaration,
  type PlannedMaterialBoundary,
} from "./recognition-material-boundaries.ts";
import {
  type RelationshipTypeDefinition,
  validateDeclaredRelationships,
  validateRelationshipDefinition,
} from "./relationship-definition.ts";
import {
  CheckpointedSourceArtifactWork,
  projectManagedSourceArtifacts,
  SourceArtifactAcquisitionEffectFailure,
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
export * from "./asset-libraries.ts";
export * from "./observed-root-authority.ts";
export * from "./observed-root-execution.ts";
export * from "./source-connection-private-state.ts";
export * from "./source-connection.ts";
export * from "./recognition-material-boundaries.ts";
export * from "./library-scan-plan.ts";
export * from "./library-directory-grants.ts";

export * from "./asset-refresh-selection.ts";
export * from "./artifact-byte-access.ts";
export * from "./playback-plan.ts";
export * from "./current-user-interaction.ts";
export * from "./relationship-definition.ts";
export * from "./application-artifact-byte-access.ts";
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
  type RelationshipDraft,
} from "@digital/domain";
export * from "./metadata-policy-configuration.ts";
export * from "./effective-fact-reads.ts";

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
  readonly recognitionSourceAssociation?: SourceAssociation;
  /** 随关联一同冻结，使身份替换同时使两个坐标失效。 */
  readonly recognitionDecisionId: string;
  readonly sourceAssociations: readonly SourceAssociation[];
  readonly metadata: readonly MetadataAssertion[];
  readonly metadataSourceRecords: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
    readonly nativeAddress?: string;
  }[];
  readonly informationRequirement: InformationRequirement;
};

/**
 * 来源能力公开其真正接受的显式寻址输入。字段只是稳定的调用合同，不是由核心解释的
 * 来源 DSL；规范化和语法校验始终由实现该端口的来源能力完成。
 */
export type SourceInputRequirement = {
  readonly sourceIdentity: string;
  readonly displayName: string;
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly required: boolean;
    readonly acceptedInput: string;
    readonly example?: string;
  }[];
};

export type SourceAddressingCapability = {
  readonly capability: CapabilityCoordinate;
  readonly inputRequirement: SourceInputRequirement;
  normalize(input: Readonly<Record<string, string>>):
    | {
        readonly status: "accepted";
        readonly normalizedInput: Readonly<Record<string, string>>;
        readonly evidence: import("@digital/domain").RecognitionEvidence;
      }
    | { readonly status: "invalid"; readonly reason: string };
};

export type ExplicitSourceEnrichmentInput = {
  readonly subjectId: string;
  readonly sourceIdentity: string;
  readonly sourceInput: Readonly<Record<string, string>>;
  /**
   * 明确资产库语境：定向补充须在效果前原子冻结该库当前完整 09 来源／能力快照。缺此依据且调用方
   * 未范围化到某一库时，绝不借今日全局能力伪称补充，只引导从明确资产库重新发起。
   */
  readonly assetLibraryId?: string;
  readonly informationRequirement?: InformationRequirement;
  readonly initiatedBy?: string;
  readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
  readonly onProgress?: (message: string) => void;
  readonly onCheckpoint?: (execution: WorkflowExecution) => void;
  /** 进程持有者生命周期；绝不作为工作流输入持久化。 */
  readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
};

/** 把当前已接受事实解释为一个精确的补充来源候选。 */
export type SourceAssociationCandidateInterpreter = {
  readonly capability: CapabilityCoordinate;
  interpret(
    input: SourceEnrichmentInput & {
      /** 本次调用读取的已接受观察依据；耐久关联检查点仍绑定原识别决定。 */
      readonly observedEvidence?: readonly RecognitionEvidence[];
    },
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
    | { readonly status: "contradicted"; readonly explanation: string }
    | undefined;
};

/** 主识别关联以及当前适用的所有来源。 */
/** 当前观察与确认相交的交付选择坐标；不是产物修订版的领域 head。 */
export type CurrentLocationRevisionSelection = {
  readonly locationId: string;
  readonly revisionId: string;
};

export type AcceptedAssetState = AcceptedRecognition & {
  readonly relationshipReadBasis?: RelationshipReadBasis;
  /**
   * 主头为空时点名的生效决定只提供读取依据，绝不构成当前身份；null 明确表达
   * 「头存在但没有决定」，缺省表示读取的就是主头决定。
   */
  readonly recognitionHeadDecisionId?: string | null;
  /** 当前读取的相关实体种类只能来自生效投影。 */
  readonly currentRelatedEntities?: readonly import("@digital/domain").CurrentRelatedEntity[];
  readonly artifactAssociationRecognitionSupports?: readonly {
    readonly associationId: string;
    readonly recognitionDecisionId: string;
  }[];
  /** 推导带来源标签值所需的当前来源记录。 */
  readonly metadataSourceRecords?: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
    readonly nativeAddress?: string;
  }[];
  readonly currentLocationRevisions?: readonly CurrentLocationRevisionSelection[];
  /** 当前生效的人工产物角色决定头，与观察支持一样只来自这份耐久读取。 */
  readonly artifactRoleDecisions?: readonly ArtifactRoleDecision[];
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
  /** 原始依据随预演冻结；普通视图只接收 preview.facts。 */
  readonly readBasis?: Pick<
    SubjectFactBasis,
    | "sourceAssociations"
    | "metadataSourceRecords"
    | "relationshipReadBasis"
    | "currentRelatedEntities"
    | "currentLocationRevisions"
    | "artifactRoleDecisions"
  >;
  readonly recognitionState?: "recognized" | "unresolved";
  readonly recognitionDecisionId?: string;
  readonly sourceAssociations: readonly Pick<
    SourceAssociation,
    "sourceIdentity" | "nativeAddress"
  >[];
  readonly recognitionSourceAssociation?: Pick<
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
  readonly currentLocationRevisions?: readonly CurrentLocationRevisionSelection[];
  readonly artifactAssociations: readonly ArtifactAssociation[];
};

export type PublicAssetStateProjection = Omit<
  AssetStateProjection,
  | "metadata"
  | "entities"
  | "entityMentions"
  | "entityResolutionDecisions"
  | "relationships"
  | "locations"
  | "artifactRevisions"
  | "artifactAssociations"
  | "readBasis"
> & {
  readonly metadata: readonly Omit<
    import("@digital/domain").MetadataAssertion,
    "producer" | "sourceRecordIds" | "authoredBy" | "observedArtifactPart"
  >[];
  readonly entities: readonly Omit<
    import("@digital/domain").SourcedEntity,
    "producer" | "sourceRecordIds"
  >[];
  readonly entityMentions: readonly Omit<
    import("@digital/domain").EntityMention,
    "producer" | "sourceRecordIds"
  >[];
  readonly entityResolutionDecisions: readonly Omit<
    import("@digital/domain").EntityResolutionDecision,
    "producer" | "sourceRecordIds"
  >[];
  readonly relationships: readonly Omit<
    import("@digital/domain").EntityRelationship,
    "producer" | "sourceRecordIds"
  >[];
  readonly artifactRevisions: readonly Omit<
    import("@digital/domain").ArtifactRevision,
    "producer"
  >[];
  readonly locations: readonly Pick<Location, "id" | "artifactId" | "kind">[];
  readonly artifactAssociations: readonly (Pick<
    ArtifactAssociation,
    "id" | "target" | "artifactId" | "role"
  > &
    Partial<Pick<ArtifactAssociation, "sourceAssociationId">>)[];
};

export type PublicRecognitionRuleResult = Pick<
  RecognitionRuleResult,
  "ruleId" | "ruleVersion" | "outcome" | "explanation"
>;

export type PublicRecognitionEvidence = {
  readonly kind: string;
  readonly explanation: string;
  readonly sourceIdentity?: string;
  readonly sourceAddress?: string;
};

export type PublicSourceAssociationCandidate = Pick<
  SourceAssociationDecisionCandidate,
  "outcome" | "sourceIdentity" | "nativeAddress" | "explanation"
> & {
  /** 对一次冻结执行稳定、且不暴露来源记录或能力坐标的选择引用。 */
  readonly reference: string;
  readonly ruleResults: readonly PublicRecognitionRuleResult[];
};

export type PublicEvidenceComparison = {
  readonly observed: readonly PublicRecognitionEvidence[];
  readonly manual: readonly PublicRecognitionEvidence[];
  readonly sourceCandidates: readonly PublicSourceAssociationCandidate[];
  readonly conflicts: readonly string[];
};

export type ChangeImpactPreview = {
  readonly version: "change-impact-preview/2";
  readonly id: string;
  readonly executionId: string;
  readonly assetId: string;
  /** 识别取代兼容视图；来源关联与撤回预演不携带它。 */
  readonly proposal?: RecognitionProposal;
  readonly change:
    | {
        readonly kind: "source-association";
        readonly proposal: SourceAssociationChangeProposal;
      }
    | {
        readonly kind: "recognition-supersession";
        readonly proposal: RecognitionProposal;
      }
    | {
        readonly kind: "recognition-retraction";
        readonly intent: import("@digital/domain").RecognitionDecisionRetractionIntent;
      }
    | {
        /**
         * 明确的范围追加／修订：提案携带完整声明的全部边界，主头只在点名的就是主头时
         * 前进；追加不会把新材料并成第二个身份，也不会改写主身份。
         */
        readonly kind: "recognition-scope-amendment";
        readonly proposal: RecognitionProposal;
        readonly successorDecisionId: string;
        /** 点名的前驱决定：确认即结束它，主头只在点名的就是主头时前进。 */
        readonly predecessorDecisionId: string;
        /** 冻结这份基线时所用的完整范围地址，事务内按同一范围重查比较。 */
        readonly scopeAddress: string;
      }
    | {
        /**
         * 人工封面决定：确认时按点名的期望头 CAS 追加这一条后继并原子推进头。
         * 它不引入新策略层，也不改变其他角色。
         */
        readonly kind: "artifact-role-decision";
        readonly decision: ArtifactRoleDecision;
        /** 冻结时的当前头决定标识；无头时刻意为 null，事务内按同一坐标重查。 */
        readonly expectedHeadDecisionId: string | null;
      };
  readonly evidenceComparison: import("@digital/domain").EvidenceComparison;
  /** 应用确认时仍必须成立的每个值。 */
  readonly baselines: readonly {
    readonly key: string;
    readonly value: string;
  }[];
  /** 冻结基线上的完整已应用状态。 */
  readonly current: AssetStateProjection;
  /** 变更后由同一应用投影推导的完整状态。 */
  readonly projected: AssetStateProjection;
  readonly facts?: {
    readonly current: EffectiveSubjectRead;
    readonly projected: EffectiveSubjectRead;
  };
  /**
   * 形成预演时冻结的消费需求与使用语境；current 与 projected 都据此走同一
   * `readEffectiveSubject`，从而与确认后同需求普通详情含义一致。普通语境留空，
   * 与详情读取的普通分支一样不额外施加选择器。旧预演不携带该字段，保持可明确检查。
   */
  readonly requestContext?: InformationRequirement | undefined;
  /**
   * 仅供 durable supersession apply 重建下一份已接受观察图；交付 DTO 刻意不公开它。
   * 当前性仍由 successor RecognitionDecision 唯一决定。
   */
  readonly projectedObservedEntityGraphs?: AcceptedRecognition["observedEntityGraphs"];
  readonly blockingConditions: readonly string[];
  readonly rejectedBy?: string;
  readonly status: "awaiting-confirmation" | "rejected" | "applied" | "stale";
};

export type RecognitionSupersessionPlan = {
  readonly successorDecision: RecognitionDecision;
  readonly supersession: {
    readonly id: string;
    readonly predecessorDecisionId: string;
    readonly successorDecisionId: string;
  };
  readonly recognitionSourceAssociation?: SourceAssociation;
};

/**
 * 范围追加或修订的落库计划：新决定携带完整声明边界，主头只在点名的前驱就是主头时
 * 前进。纯追加不前移主头，也不新建第二个身份。
 */
export type RecognitionScopeAmendmentPlan = {
  readonly successorDecision: RecognitionDecision;
  /** 被点名的决定由这份后继取代；主头是否前进由数据库里的当前主头决定。 */
  readonly supersession: {
    readonly id: string;
    readonly predecessorDecisionId: string;
    readonly successorDecisionId: string;
  };
  /** 冻结范围基线时使用的完整范围地址；事务内按同一范围重查比较。 */
  readonly scopeAddress: string;
};

/**
 * 人工封面候选的稳定不透明引用：只由当前有精确图片依据的封面关联三元组导出，
 * 交付层因此不能伪造路径、任意材料图或旧修订。
 */
export type ArtifactRoleCandidateInspection = {
  readonly reference: string;
  readonly kind: "observed" | "managed";
  readonly locationId: string;
  readonly address: string;
};

/** 封面卡一次读取所需的全部当前事实：候选、生效选择、人工意图与可理解的问题。 */
export type ArtifactRoleCoverInspection = {
  readonly entityId: string;
  readonly candidates: readonly ArtifactRoleCandidateInspection[];
  /** 当前生效封面所在候选的引用；同级冲突或人工选择失效时为空。 */
  readonly effectiveReference?: string;
  /** 当前人工意图；clear 表示曾撤回，缺省表示从未选择。 */
  readonly decision?: {
    readonly kind: "select" | "clear";
    readonly reference?: string;
  };
  readonly problems: readonly string[];
};

/** 安全的交付 DTO；原始提议和条件基线保留在内部。 */
export type ChangeImpactPreviewInspection = {
  readonly id: string;
  readonly executionId: string;
  readonly assetId: string;
  readonly status: ChangeImpactPreview["status"];
  readonly evidenceComparison: PublicEvidenceComparison;
  readonly sourceAssociations: ChangeImpactPreview["projected"]["sourceAssociations"];
  readonly recognitionSourceAssociation?: ChangeImpactPreview["projected"]["recognitionSourceAssociation"];
  readonly current: PublicAssetStateProjection;
  readonly projected: PublicAssetStateProjection;
  readonly facts?: {
    readonly current: EffectiveSubjectRead;
    readonly projected: EffectiveSubjectRead;
  };
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
  readonly assetLibrary?: AssetLibrarySnapshot;
  /**
   * 本次目录工作冻结的本库目录授权账目（授权 ID 对应的物理根与权威版本）。它是 I/O 撤销
   * 判据，与配置版本刻意分离：普通改名或能力、来源配置编辑不影响它，目录或库移除、链接
   * 授权改变、显式重连才推进版本，从而让旧工作的下一次效果、提交或恢复被持久拒绝。
   */
  readonly directoryAuthorizations?: readonly FrozenDirectoryAuthorization[];
  /**
   * 一次耐久资产库扫描父执行冻结的目录计划。父级协调只读它，绝不从今日库配置重选
   * 代表或补字段。
   */
  readonly libraryScan?: LibraryScanPlan;
  /**
   * 派生工作（信息履行及其获取子执行）与 08 目录子共享的父执行身份载体；监督关系
   * 因此不依赖 initiatedBy 文案前缀。`directoryCoverage` 是本次物理观察对同父其他
   * 目录的只读覆盖映射。
   */
  readonly parentExecutionId?: string;
  readonly parentDirectoryKey?: string;
  readonly directoryCoverage?: readonly LibraryScanDirectoryCoverage[];
  readonly operation?: {
    /**
     * `/1` 是历史 child 的原样记录，刻意没有操作身份；新 child 一律使用 `/2` 并携带账本里的
     * 稳定 operation ID，因此恢复能逐项核对 parent、subject 与具体计划。
     */
    readonly version:
      | "information-fulfillment-operation/1"
      | "information-fulfillment-operation/2";
    readonly kind: InformationFulfillmentPlan["operation"];
    readonly subjectId: string;
    readonly sourceIdentity: string;
    readonly sourceAssociationId?: string;
    readonly operationId?: string;
  };
  /**
   * 显式"再次获取"终态失败来源补充项时，新执行在创建时耐久持有的具体操作意图：前次执行、
   * 所选主体/来源、精确规范地址与（显式项）必要非秘密规范化输入。首来源检查点之前中断后，
   * 正式 resume 据此只续同新 ID、同精确操作，绝不改走普通自动补充、不重开旧失败项、不用当前
   * 候选替换显式输入。刻意只记录重放该单项所需的最小可逆非秘密字段，不扩为通用工作流定义。
   */
  readonly sourceEnrichmentRetry?: {
    readonly version: "source-enrichment-retry/1";
    readonly priorExecutionId: string;
    readonly subjectId: string;
    readonly sourceIdentity: string;
    readonly sourceAddress: string;
    readonly explicitInput?: Readonly<Record<string, string>>;
    /**
     * 显式 retry 创建时耐久绑定的精确寻址能力坐标（实现／合同版本）。恢复据此严校当前能力，
     * 缺失／不唯一／改址／版本漂移一律零效果；绝不借今日全局新版本，也不以同地址替代版本兼容。
     */
    readonly addressingCapability?: {
      readonly capabilityId: string;
      readonly capabilityVersion: string;
      readonly contractVersion: string;
    };
  };
};

export type ObservedMaterialAssociationWorkflowInput = {
  readonly assetLibrary?: undefined;
  readonly parentExecutionId?: undefined;
  readonly version: "observed-material-association-input/1";
  readonly trigger: "interactive";
  readonly initiatedBy: string;
  readonly acceptTrusted: false;
  readonly configurationReferences: readonly string[];
  readonly observedRoots?: undefined;
  readonly libraryScan?: undefined;
  readonly directoryAuthorizations?: undefined;
  readonly parentDirectoryKey?: undefined;
  readonly directoryCoverage?: undefined;
  readonly operation?: undefined;
  readonly targetAssetId: string;
  readonly registrationId: string;
  readonly relativeScope: string;
  readonly relativePaths: readonly string[];
};

export type SourceAssociationDecisionWorkflowInput = {
  readonly assetLibrary?: undefined;
  readonly parentExecutionId?: undefined;
  readonly version: "source-association-decision-input/1";
  readonly trigger: "interactive";
  readonly initiatedBy: string;
  readonly acceptTrusted: false;
  readonly configurationReferences: readonly string[];
  readonly intent: "establish" | "replace" | "retract";
  readonly assetId: string;
  readonly sourceIdentity?: string;
  readonly predecessorAssociationId?: string;
  readonly sourceInput?: Readonly<Record<string, string>>;
  readonly reason?: string;
  readonly priorExecutionId?: string;
  readonly observedRoots?: undefined;
  readonly libraryScan?: undefined;
  readonly directoryAuthorizations?: undefined;
  readonly parentDirectoryKey?: undefined;
  readonly directoryCoverage?: undefined;
  readonly operation?: undefined;
};

export type WorkflowExecutionInput =
  | AssetRefreshWorkflowInput
  | ObservedMaterialAssociationWorkflowInput
  | SourceAssociationDecisionWorkflowInput;

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

export function decodeWorkflowExecutionInput(
  value: unknown,
):
  | { readonly valid: true; readonly input: WorkflowExecutionInput }
  | { readonly valid: false; readonly reason: string } {
  if (
    isStringRecord(value) &&
    value.version === "source-association-decision-input/1"
  ) {
    const required = [
      "acceptTrusted",
      "assetId",
      "configurationReferences",
      "initiatedBy",
      "intent",
      "trigger",
      "version",
    ];
    if (
      !hasExactKeys(value, required, [
        "predecessorAssociationId",
        "priorExecutionId",
        "reason",
        "sourceIdentity",
        "sourceInput",
      ]) ||
      value.trigger !== "interactive" ||
      value.acceptTrusted !== false ||
      !isNonEmptyString(value.initiatedBy) ||
      !isNonEmptyString(value.assetId) ||
      !["establish", "replace", "retract"].includes(value.intent as string) ||
      !Array.isArray(value.configurationReferences) ||
      value.configurationReferences.some((item) => !isNonEmptyString(item)) ||
      new Set(value.configurationReferences).size !==
        value.configurationReferences.length ||
      [
        value.predecessorAssociationId,
        value.priorExecutionId,
        value.reason,
        value.sourceIdentity,
      ].some((item) => item !== undefined && !isNonEmptyString(item)) ||
      (value.sourceInput !== undefined &&
        (!isStringRecord(value.sourceInput) ||
          Object.values(value.sourceInput).some(
            (item) => typeof item !== "string",
          )))
    )
      return { valid: false, reason: "来源关联决定版本化输入无效" };
    const intent =
      value.intent as SourceAssociationDecisionWorkflowInput["intent"];
    const hasSourceInput = value.sourceInput !== undefined;
    const hasPredecessor = value.predecessorAssociationId !== undefined;
    const hasReason = value.reason !== undefined;
    if (
      (intent === "establish" &&
        (!isNonEmptyString(value.sourceIdentity) ||
          !hasSourceInput ||
          hasPredecessor ||
          hasReason)) ||
      (intent === "replace" &&
        (!isNonEmptyString(value.sourceIdentity) ||
          !hasSourceInput ||
          !hasPredecessor ||
          hasReason)) ||
      (intent === "retract" &&
        (!isNonEmptyString(value.sourceIdentity) ||
          hasSourceInput ||
          !hasPredecessor ||
          !hasReason))
    )
      return { valid: false, reason: "来源关联决定输入与明确意图不匹配" };
    return {
      valid: true,
      input: value as unknown as SourceAssociationDecisionWorkflowInput,
    };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version ===
      "observed-material-association-input/1"
  ) {
    const input = value as Record<string, unknown>;
    const keys = [
      "acceptTrusted",
      "configurationReferences",
      "initiatedBy",
      "registrationId",
      "relativePaths",
      "relativeScope",
      "targetAssetId",
      "trigger",
      "version",
    ].toSorted((left, right) => left.localeCompare(right));
    if (
      JSON.stringify(Object.keys(input).toSorted()) !== JSON.stringify(keys) ||
      input.trigger !== "interactive" ||
      input.acceptTrusted !== false ||
      !Array.isArray(input.configurationReferences) ||
      input.configurationReferences.some(
        (item) => typeof item !== "string" || item.length === 0,
      ) ||
      new Set(input.configurationReferences).size !==
        input.configurationReferences.length ||
      typeof input.initiatedBy !== "string" ||
      input.initiatedBy.trim().length === 0 ||
      typeof input.targetAssetId !== "string" ||
      input.targetAssetId.length === 0 ||
      typeof input.registrationId !== "string" ||
      input.registrationId.length === 0 ||
      typeof input.relativeScope !== "string" ||
      !Array.isArray(input.relativePaths) ||
      input.relativePaths.length === 0 ||
      input.relativePaths.some(
        (item) => typeof item !== "string" || item.length === 0,
      ) ||
      new Set(input.relativePaths).size !== input.relativePaths.length
    )
      return { valid: false, reason: "观察材料关联版本化输入无效" };
    return {
      valid: true,
      input: input as unknown as ObservedMaterialAssociationWorkflowInput,
    };
  }
  return decodeAssetRefreshWorkflowInput(value);
}

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
    "assetLibrary",
    "directoryAuthorizations",
    "libraryScan",
    "parentExecutionId",
    "parentDirectoryKey",
    "directoryCoverage",
    "sourceEnrichmentRetry",
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
  const assetLibrary =
    input.assetLibrary === undefined
      ? undefined
      : decodeAssetLibrarySnapshot(input.assetLibrary);
  if (input.assetLibrary !== undefined && assetLibrary === undefined)
    return { valid: false, reason: "刷新输入的资产库配置无效" };
  // 冻结的库目录授权是 I/O 权威，而非库配置代次：缺失表示本票之前的旧执行，持久复核
  // 按种子代次处理；出现但为空只可能是无授权库，两者都绝不以今日配置补齐。
  let directoryAuthorizations:
    | readonly FrozenDirectoryAuthorization[]
    | undefined;
  if (input.directoryAuthorizations !== undefined) {
    directoryAuthorizations = decodeFrozenDirectoryAuthorizations(
      input.directoryAuthorizations,
    );
    if (directoryAuthorizations === undefined)
      return { valid: false, reason: "刷新输入的库目录授权无效" };
  }
  if (
    input.parentExecutionId !== undefined &&
    (typeof input.parentExecutionId !== "string" ||
      input.parentExecutionId.length === 0)
  )
    return { valid: false, reason: "刷新版本化输入的父执行身份无效" };
  // 派生获取必须自带完整库归属；缺少快照的旧输入不再借用当前配置补齐。
  if (input.trigger === "information-fulfillment" && assetLibrary === undefined)
    return { valid: false, reason: "信息履行输入缺少资产库归属" };
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
      "operationId",
    ]);
    if (
      Object.keys(candidate).some((key) => !operationAllowed.has(key)) ||
      (candidate.version !== "information-fulfillment-operation/1" &&
        candidate.version !== "information-fulfillment-operation/2") ||
      (candidate.kind !== "source-refresh" &&
        candidate.kind !== "source-artifact-acquisition") ||
      typeof candidate.subjectId !== "string" ||
      candidate.subjectId.length === 0 ||
      typeof candidate.sourceIdentity !== "string" ||
      candidate.sourceIdentity.length === 0 ||
      (candidate.sourceAssociationId !== undefined &&
        (typeof candidate.sourceAssociationId !== "string" ||
          candidate.sourceAssociationId.length === 0)) ||
      // 历史 `/1` 不能猜造操作身份；新 `/2` 必须携带账本里的稳定身份。
      (candidate.version === "information-fulfillment-operation/1"
        ? candidate.operationId !== undefined
        : typeof candidate.operationId !== "string" ||
          candidate.operationId.length === 0)
    )
      return { valid: false, reason: "信息履行操作输入无效" };
    operation = candidate as AssetRefreshWorkflowInput["operation"];
  }
  if (
    (input.trigger === "information-fulfillment") !==
    (operation !== undefined)
  )
    return { valid: false, reason: "信息履行触发与操作输入不一致" };
  let libraryScan: LibraryScanPlan | undefined;
  if (input.libraryScan !== undefined) {
    const decoded = decodeLibraryScanPlan(input.libraryScan);
    if (!decoded.valid) return { valid: false, reason: decoded.reason };
    libraryScan = decoded.plan;
    if (input.parentExecutionId !== undefined)
      return { valid: false, reason: "库扫描父执行不能声明自己的父执行" };
    if (
      assetLibrary !== undefined &&
      (assetLibrary.id !== libraryScan.assetLibraryId ||
        assetLibrary.configVersion !== libraryScan.configVersion)
    )
      return { valid: false, reason: "库扫描计划与冻结的资产库配置不一致" };
  }
  const parentExecutionId = input.parentExecutionId;
  // 08 目录子的父归属坐标：目录键出现时必须同时具备非空父执行身份与非空目录键。此守卫
  // 同时为下面的返回提供 parentDirectoryKey 的 string 收窄，不新增字段或版本。
  if (
    input.parentDirectoryKey !== undefined &&
    (parentExecutionId === undefined ||
      typeof input.parentDirectoryKey !== "string" ||
      input.parentDirectoryKey.length === 0)
  )
    return { valid: false, reason: "库扫描目录子的父归属坐标不完整" };
  // 覆盖映射只随 08 目录子出现：目录键缺失时必须拒绝而不是回落到 09 单父 ID 形状，
  // 绝不把已校验的有效 coverage 静默丢弃。
  if (
    input.directoryCoverage !== undefined &&
    input.parentDirectoryKey === undefined
  )
    return { valid: false, reason: "库扫描目录子的父归属坐标不完整" };
  // 09 单父 ID 只可伴随真实 information-fulfillment 操作，或 13 的耐久来源重试意图：该意图
  // 自带主体／来源／精确地址的严格解码（下方进行），是已批准的首检查点前续跑耐久依据，因此
  // 正式 retry 创建的输入必须能按同一形状读回。这里只区分父载体形状，绝不放行畸形意图，也
  // 绝不据今日配置或能力补全旧意图；无目录字段、无操作又无重试意图的普通混形继续按非法拒绝。
  if (
    parentExecutionId !== undefined &&
    operation === undefined &&
    input.parentDirectoryKey === undefined &&
    input.directoryCoverage === undefined &&
    input.sourceEnrichmentRetry === undefined
  )
    return { valid: false, reason: "刷新版本化输入的父执行身份无效" };
  // 两种父载体互斥：09 的 information-fulfillment 操作绝不携带 08 目录坐标。任一目录字段
  // 出现即属目录子形状，须走完整 08 坐标而非操作派生归属，不得让派生输入作用于目录覆盖。
  if (
    operation !== undefined &&
    (input.parentDirectoryKey !== undefined ||
      input.directoryCoverage !== undefined)
  )
    return { valid: false, reason: "刷新版本化输入的父执行身份无效" };
  let directoryCoverage: readonly LibraryScanDirectoryCoverage[] | undefined;
  if (input.directoryCoverage !== undefined) {
    if (!Array.isArray(input.directoryCoverage))
      return { valid: false, reason: "库扫描覆盖映射无效" };
    const decoded = input.directoryCoverage.map(
      decodeLibraryScanDirectoryCoverage,
    );
    if (
      decoded.some(
        (coverage) =>
          coverage === undefined ||
          libraryScanPlanCoverageConflict(coverage, input.observedRoots),
      ) ||
      new Set(decoded.map((coverage) => coverage?.scopeReference ?? ""))
        .size !== decoded.length
    )
      return { valid: false, reason: "库扫描覆盖映射无效" };
    directoryCoverage = decoded as readonly LibraryScanDirectoryCoverage[];
  }
  let sourceEnrichmentRetry: AssetRefreshWorkflowInput["sourceEnrichmentRetry"];
  if (input.sourceEnrichmentRetry !== undefined) {
    const retry = input.sourceEnrichmentRetry;
    if (typeof retry !== "object" || retry === null || Array.isArray(retry))
      return { valid: false, reason: "来源补充重试意图必须是对象" };
    const intent = retry as Record<string, unknown>;
    const retryAllowed = new Set([
      "version",
      "priorExecutionId",
      "subjectId",
      "sourceIdentity",
      "sourceAddress",
      "explicitInput",
      "addressingCapability",
    ]);
    const nonEmptyString = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0;
    const explicitInputValid =
      intent.explicitInput === undefined ||
      (typeof intent.explicitInput === "object" &&
        intent.explicitInput !== null &&
        !Array.isArray(intent.explicitInput) &&
        Object.values(intent.explicitInput as Record<string, unknown>).every(
          (value) => typeof value === "string",
        ));
    // 显式 retry 的耐久寻址坐标须是完整三段坐标；缺段或畸形一律判为无效意图，不借今日能力补全。
    const addressingRaw = intent.addressingCapability;
    let addressingCapability:
      | {
          readonly capabilityId: string;
          readonly capabilityVersion: string;
          readonly contractVersion: string;
        }
      | undefined;
    if (addressingRaw !== undefined) {
      if (
        typeof addressingRaw !== "object" ||
        addressingRaw === null ||
        Array.isArray(addressingRaw)
      )
        return { valid: false, reason: "来源补充重试意图无效" };
      const coordinate = addressingRaw as Record<string, unknown>;
      if (
        !nonEmptyString(coordinate.capabilityId) ||
        !nonEmptyString(coordinate.capabilityVersion) ||
        !nonEmptyString(coordinate.contractVersion)
      )
        return { valid: false, reason: "来源补充重试意图无效" };
      addressingCapability = {
        capabilityId: coordinate.capabilityId,
        capabilityVersion: coordinate.capabilityVersion,
        contractVersion: coordinate.contractVersion,
      };
    }
    if (
      Object.keys(intent).some((key) => !retryAllowed.has(key)) ||
      intent.version !== "source-enrichment-retry/1" ||
      !nonEmptyString(intent.priorExecutionId) ||
      !nonEmptyString(intent.subjectId) ||
      !nonEmptyString(intent.sourceIdentity) ||
      !nonEmptyString(intent.sourceAddress) ||
      !explicitInputValid
    )
      return { valid: false, reason: "来源补充重试意图无效" };
    sourceEnrichmentRetry = {
      version: "source-enrichment-retry/1",
      priorExecutionId: intent.priorExecutionId,
      subjectId: intent.subjectId,
      sourceIdentity: intent.sourceIdentity,
      sourceAddress: intent.sourceAddress,
      ...(intent.explicitInput === undefined
        ? {}
        : {
            explicitInput: intent.explicitInput as Readonly<
              Record<string, string>
            >,
          }),
      ...(addressingCapability === undefined ? {} : { addressingCapability }),
    };
  }
  return {
    valid: true,
    input: {
      version: "asset-refresh-input/1",
      trigger: input.trigger,
      initiatedBy: input.initiatedBy,
      acceptTrusted: input.acceptTrusted,
      configurationReferences: input.configurationReferences,
      ...(observedRoots === undefined ? {} : { observedRoots }),
      ...(assetLibrary === undefined ? {} : { assetLibrary }),
      ...(directoryAuthorizations === undefined
        ? {}
        : { directoryAuthorizations }),
      ...(libraryScan === undefined ? {} : { libraryScan }),
      ...(parentExecutionId === undefined
        ? {}
        : input.parentDirectoryKey === undefined
          ? // 09 派生获取：只带父执行身份，不带目录坐标。
            { parentExecutionId }
          : {
              parentExecutionId,
              parentDirectoryKey: input.parentDirectoryKey,
              ...(directoryCoverage === undefined ||
              directoryCoverage.length === 0
                ? {}
                : { directoryCoverage }),
            }),
      ...(operation === undefined ? {} : { operation }),
      ...(sourceEnrichmentRetry === undefined ? {} : { sourceEnrichmentRetry }),
    },
  };
}

/** 覆盖坐标必须能与本次冻结根一起自证：既引用别的根，又不能引用自己。 */
function libraryScanPlanCoverageConflict(
  coverage: LibraryScanDirectoryCoverage,
  observedRoots: unknown,
): boolean {
  if (!Array.isArray(observedRoots)) return false;
  return observedRoots.some(
    (root) =>
      typeof root === "object" &&
      root !== null &&
      (root as { id?: unknown }).id === coverage.scopeReference,
  );
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
  /** 本次处理实际涉及的观察材料，供部分失败后的检查与继续操作使用。 */
  readonly materialReferences?: readonly string[];
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
  readonly sourceFailureCodes?: readonly SourceFailureCode[];
  readonly effectReference?: string;
};

export type SourceFailureCode = {
  readonly capability: CapabilityCoordinate;
  readonly code: string;
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
  readonly sourceAssociations: readonly SourceAssociation[];
  readonly recognitionSourceAssociation?: SourceAssociation;
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

/** 一个主体在本次履行请求内的资产库语境；终态语境不启动任何获取。 */
type InformationLibraryContext =
  | {
      readonly subjectId: string;
      readonly status: "library";
      readonly snapshot: AssetLibrarySnapshot;
    }
  | {
      readonly subjectId: string;
      readonly status: "blocked" | "unavailable";
      readonly reason: string;
    };

/**
 * 仅供内部使用的子元数据执行发起上下文。持久化工作流输入仍是恢复权威；该上下文只在
 * 创建子执行时使用。
 */
type MetadataRefreshInitiation = {
  readonly version: "metadata-refresh-initiation/1";
  readonly trigger: "information-fulfillment";
  readonly initiatedBy: string;
  /** 耐久写入子执行输入的父身份；监督关系不靠 initiatedBy 文案。 */
  readonly parentExecutionId?: string;
  readonly operation: NonNullable<AssetRefreshWorkflowInput["operation"]>;
  /** 父执行冻结的来源目录授权，派生子执行继续沿用同一份 I/O 权威。 */
  readonly directoryAuthorizations?:
    | readonly FrozenDirectoryAuthorization[]
    | undefined;
  /**
   * 存在时，child 的插入必须与父账本里的这个具体 operation 同一条事务绑定；缺失即普通创建，
   * 因此交互轮询永远不会借用账本接缝。
   */
  readonly durableOperation?: {
    readonly parentExecutionId: string;
    readonly operationId: string;
  };
};

function metadataRefreshInitiationForInformationFulfillment(
  plan: InformationFulfillmentPlan,
  initiation: InformationFulfillmentInitiation | undefined,
): MetadataRefreshInitiation {
  const durable =
    initiation?.fromDurableLedger === true &&
    initiation.parentExecutionId !== undefined
      ? {
          parentExecutionId: initiation.parentExecutionId,
          operationId: plan.operationId,
        }
      : undefined;
  return {
    version: "metadata-refresh-initiation/1",
    trigger: "information-fulfillment",
    initiatedBy:
      initiation === undefined
        ? "information-fulfillment"
        : `information-fulfillment:${initiation.parentExecutionId}:${plan.subjectId}`,
    ...(initiation === undefined
      ? {}
      : { parentExecutionId: initiation.parentExecutionId }),
    ...(initiation?.directoryAuthorizations === undefined
      ? {}
      : { directoryAuthorizations: initiation.directoryAuthorizations }),
    ...(durable === undefined ? {} : { durableOperation: durable }),
    operation: {
      version: "information-fulfillment-operation/2",
      kind: plan.operation,
      subjectId: plan.subjectId,
      sourceIdentity: plan.sourceIdentity,
      operationId: plan.operationId,
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
  readonly boundaries?: readonly RecognitionMaterialBoundary[];
  /** 冻结的相交有效范围基线；刷新提交前在事务内按同一形状重算比较。 */
  readonly boundaryBaseline?: readonly string[];
  readonly retainedAssetId?: string;
  /**
   * 与本次候选相交的那个已结束决定；只在身份已撤回／被取代而范围支持仍保留时存在。
   * 明确决定只需点名它，绝不据此推断新的当前授权。
   */
  readonly retainedDecisionId?: string;
  readonly reuseAcceptedBoundary?: boolean;
  readonly boundaryConflict?: string;
  readonly materialBoundary?: PlannedMaterialBoundary;
  readonly observedArtifactAssociations?: readonly ObservedArtifactAssociationCandidate[];
  /** 即使明确的包包含多个文件，它仍是一个产物。 */
  readonly observedArtifactBoundary?: "filesystem-package";
  /** 作出技术边界决策的能力；不是领域事实。 */
  readonly observedArtifactBoundaryProducer?: CapabilityCoordinate;
  /** 声明该候选自身内容身份的能力坐标；只有能力自己才能设置。 */
  readonly independentIdentityDeclaredBy?: CapabilityCoordinate;
  readonly planningEvidence?: readonly import("@digital/domain").RecognitionEvidence[];
  readonly reuseFingerprint?: string;
  /** 该边界的实际能力坐标，绝不是完整配置。 */
  readonly reuseCompatibility?: WorkflowCompatibility;
  readonly sourceRecordIds: readonly string[];
  readonly proposalId?: string;
  /** 新识别在原子接受前预分配、并可跨中断恢复的主体身份。 */
  readonly plannedAssetId?: string;
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
  /** 来源能力规范化后的非秘密显式输入，供失败检查和正式重试复用。 */
  readonly explicitInput?: Readonly<Record<string, string>>;
  readonly fulfilledArtifactRoles: readonly {
    readonly role: string;
    readonly count: number;
  }[];
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

function sourceEnrichmentDecision(
  checkpoint: InterpretedSourceEnrichmentCheckpoint,
  initiatedBy: string,
): {
  readonly proposal: SourceAssociationChangeProposal;
  readonly decision: SourceAssociationDecision;
} {
  const explicitActor =
    checkpoint.explicitInput === undefined ? undefined : initiatedBy;
  const proposal: SourceAssociationChangeProposal = {
    id: `source-association-proposal:${checkpoint.sourceAssociation.id}`,
    kind: "establish",
    subjectId: checkpoint.subjectId,
    successor: checkpoint.sourceAssociation,
    sourceRecordIds: checkpoint.sourceRecordIds,
    proposedBy:
      explicitActor === undefined
        ? { kind: "capability", coordinate: checkpoint.evidence.producer }
        : { kind: "user", actorId: explicitActor },
    evidence: {
      observed: [],
      manual:
        checkpoint.explicitInput === undefined ? [] : [checkpoint.evidence],
      sourceCandidates: [
        {
          outcome: "accepted",
          sourceIdentity: checkpoint.interpretation.sourceIdentity,
          nativeAddress: checkpoint.interpretation.sourceAddress,
          sourceRecordIds: checkpoint.sourceRecordIds,
          ruleResults: [],
          explanation: "来源解释与明确地址一致",
        },
      ],
      conflicts: [],
    },
  };
  const decision: SourceAssociationDecision = {
    id: `source-association-decision:${checkpoint.sourceAssociation.id}`,
    proposalId: proposal.id,
    subjectId: checkpoint.subjectId,
    decidedBy:
      explicitActor === undefined
        ? {
            kind: "application-policy",
            policyCoordinate: "source-enrichment/exact-interpretation/1",
          }
        : { kind: "user", actorId: explicitActor },
  };
  validateSourceAssociationChange({ proposal, decision });
  return { proposal, decision };
}

type CandidateSourceEnrichmentCheckpoint = SourceEnrichmentCheckpointBase & {
  readonly stage: "candidate-interpreted";
};

type DurableSourceCollectionFailure = Omit<
  SourceCollectionFailure,
  "failureCode"
>;

type RetainedSourceEnrichmentCheckpoint = SourceEnrichmentCheckpointBase & {
  readonly stage: "source-records-retained";
  readonly sourceRecordIds: readonly string[];
  readonly collectionFailures: readonly DurableSourceCollectionFailure[];
};

export type SourceEnrichmentCheckpoint =
  | CandidateSourceEnrichmentCheckpoint
  | RetainedSourceEnrichmentCheckpoint
  | (SourceEnrichmentCheckpointBase & {
      readonly stage: "failed";
      readonly sourceRecordIds: readonly string[];
      readonly collectionFailures: readonly DurableSourceCollectionFailure[];
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
  readonly workflowInput?: WorkflowExecutionInput;
  /** 不可执行的持久化重放坐标仍可查询，只为使恢复过程能够停止它。 */
  readonly workflowInputInvalid?: InvalidAssetRefreshWorkflowInput;
  readonly selection: {
    /** 旧版单范围输入；精确主体执行中不存在。 */
    readonly directory?: string;
    readonly intent?:
      | "scan-now"
      | "metadata-refresh"
      | "directed-recognition"
      | "source-enrichment";
    readonly informationRequirement?: InformationRequirement;
  };
  /** 旧版单范围观察；仅主体执行中不存在。 */
  readonly snapshot?: FilesystemPackageSnapshot;
  readonly operationKind?:
    | "scan-filesystem"
    | "scan-asset-library"
    | "refresh-metadata"
    | "rescrape"
    | "associate-observed-material";
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
  /** 新识别在原子接受前预分配、并可跨中断恢复的主体身份。 */
  readonly plannedAssetId?: string;
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
  readonly materialAssociation?: ObservedMaterialAssociationCheckpoint;
  readonly materialAssociationInvalid?: InvalidAssetRefreshWorkflowInput;
  readonly sourceAssociationDecision?: SourceAssociationDecisionCheckpoint;
  readonly sourceAssociationDecisionInvalid?: InvalidAssetRefreshWorkflowInput;
  readonly automationIntentId?: string;
  /** 仅供旧版使用的触发列；新执行使用 `workflowInput.trigger`。 */
  readonly trigger?: string;
};

export type SourceAssociationDecisionCandidate = {
  readonly outcome: "accepted" | "contradicted";
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
  readonly sourceRecordIds: readonly string[];
  readonly ruleResults: readonly RecognitionRuleResult[];
  readonly interpretation: SourceInterpretationBatch;
  readonly explanation: string;
};

export type SourceAssociationDecisionInspection = {
  readonly executionId: string;
  readonly status: WorkflowExecution["status"];
  readonly state: SourceAssociationDecisionCheckpoint["state"];
  readonly assetId: string;
  readonly intent: SourceAssociationDecisionCheckpoint["intent"];
  readonly predecessor?: SourceAssociation;
  readonly currentAssociations: readonly SourceAssociation[];
  readonly historicalAssociations: readonly {
    readonly association: SourceAssociation;
    readonly status: "superseded" | "retracted" | "legacy-retired";
    readonly authorizedBy?: SourceAssociationTerminationAudit;
  }[];
  readonly inputRequirements: readonly SourceInputRequirement[];
  readonly candidates: readonly PublicSourceAssociationCandidate[];
  readonly evidenceComparison?: PublicEvidenceComparison;
  readonly failure?: string;
  readonly preview?: ChangeImpactPreviewInspection;
  readonly availableActions: readonly (
    | "select"
    | "apply"
    | "reject"
    | "retry"
    | "cancel"
  )[];
};

/** 正式检查路径公开的追加式终止权威；只含可核对的领域标识，不泄漏存储坐标。 */
export type SourceAssociationTerminationAudit =
  | {
      readonly kind: "recognition-decision-supersession";
      readonly supersessionId: string;
      readonly predecessorDecisionId: string;
      readonly predecessorProposalId: string;
      readonly successorDecisionId: string;
      readonly successorProposalId: string;
    }
  | {
      readonly kind: "source-association-decision";
      readonly decisionId: string;
    }
  | {
      readonly kind: "recognition-decision-retraction";
      readonly retractionId: string;
    };

export type SourceNormalizationRecord = {
  readonly version: "source-normalization-record/1";
  readonly rawInput: Readonly<Record<string, string>>;
  readonly capability: CapabilityCoordinate;
  readonly normalizedInput: Readonly<Record<string, string>>;
  readonly evidence: RecognitionEvidence;
  readonly integrityFingerprint: string;
};

type SourceNormalizationRecordContent = Omit<
  SourceNormalizationRecord,
  "integrityFingerprint"
>;

function canonicalIntegrityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalIntegrityValue);
  if (!isStringRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalIntegrityValue(item)]),
  );
}

/** 只检测归一化记录的非对抗性局部损坏，不证明外部来源语义。 */
function sourceNormalizationIntegrityFingerprint(
  value: SourceNormalizationRecordContent,
): string {
  return createHash("sha256")
    .update("source-normalization-record-integrity/1\0")
    .update(JSON.stringify(canonicalIntegrityValue(value)))
    .digest("hex");
}

export type SourceAssociationDecisionCheckpoint = {
  readonly version: "source-association-decision-checkpoint/1";
  readonly state:
    | "created"
    | "normalizing"
    | "collecting"
    | "interpreting"
    | "awaiting-selection"
    | "awaiting-confirmation"
    | "no-change"
    | "applied"
    | "rejected"
    | "stale"
    | "failed"
    | "cancelled"
    | "interrupted";
  readonly intent: "establish" | "replace" | "retract";
  readonly assetId: string;
  readonly sourceIdentity?: string;
  readonly predecessor?: SourceAssociation;
  readonly normalization?: SourceNormalizationRecord;
  readonly candidates: readonly SourceAssociationDecisionCandidate[];
  readonly capturedSourceRecordIds: readonly string[];
  readonly proposal?: SourceAssociationChangeProposal;
  readonly previewId?: string;
  readonly failure?: string;
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

/** 使用与普通资产相同的事实投影，外层状态区分尚未采用的人工提案。 */
export type LocalContentReview = {
  readonly executionId: string;
  readonly status: "proposed" | "accepted";
  readonly relativePaths: readonly string[];
  readonly content: NonNullable<AssetRefreshInspection["accepted"]>;
};

export type ObservedMaterialAssociationCheckpoint = {
  readonly version: "observed-material-association-checkpoint/1";
  readonly state:
    | "created"
    | "observing"
    | "inspecting"
    | "awaiting-confirmation"
    | "confirmation-recorded"
    | "revalidating"
    | "accepted"
    | "no-change"
    | "stale"
    | "failed"
    | "interrupted";
  readonly input: {
    readonly targetAssetId: string;
    readonly registrationId: string;
    readonly registrationVersion?: number;
    readonly relativeScope: string;
    readonly relativePaths: readonly string[];
    readonly initiatedBy: string;
  };
  readonly registrationDisplayName?: string;
  readonly snapshot?: FilesystemPackageSnapshot;
  readonly identityBaseline?: string;
  readonly materialBaseline?: string;
  readonly submission?: ObservedMaterialAssociationSubmission;
  readonly confirmedBy?: string;
  readonly associationIds?: readonly string[];
  readonly decisionId?: string;
};

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrictProposalAuthor(value: unknown): boolean {
  if (!isStringRecord(value)) return false;
  if (value.kind === "user")
    return (
      hasExactKeys(value, ["actorId", "kind"]) &&
      isNonEmptyString(value.actorId)
    );
  return (
    value.kind === "capability" &&
    hasExactKeys(value, ["coordinate", "kind"]) &&
    isStrictCapabilityCoordinate(value.coordinate)
  );
}

function isStrictSourceAssociation(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    hasExactKeys(value, [
      "id",
      "nativeAddress",
      "sourceIdentity",
      "subjectId",
    ]) &&
    [
      value.id,
      value.nativeAddress,
      value.sourceIdentity,
      value.subjectId,
    ].every(isNonEmptyString)
  );
}

function isStrictSourceNormalizationRecord(
  value: unknown,
): value is SourceNormalizationRecord {
  return (
    isStringRecord(value) &&
    hasExactKeys(value, [
      "capability",
      "evidence",
      "integrityFingerprint",
      "normalizedInput",
      "rawInput",
      "version",
    ]) &&
    value.version === "source-normalization-record/1" &&
    isStringRecord(value.rawInput) &&
    Object.values(value.rawInput).every((item) => typeof item === "string") &&
    isStringRecord(value.normalizedInput) &&
    Object.values(value.normalizedInput).every(
      (item) => typeof item === "string",
    ) &&
    isStrictCapabilityCoordinate(value.capability) &&
    isStrictRecognitionEvidence(value.evidence) &&
    capabilityCoordinate((value.evidence as RecognitionEvidence).producer) ===
      capabilityCoordinate(value.capability as CapabilityCoordinate) &&
    value.integrityFingerprint ===
      sourceNormalizationIntegrityFingerprint({
        version: value.version,
        rawInput: value.rawInput as Readonly<Record<string, string>>,
        capability: value.capability as CapabilityCoordinate,
        normalizedInput: value.normalizedInput as Readonly<
          Record<string, string>
        >,
        evidence: value.evidence as RecognitionEvidence,
      })
  );
}

function isStrictEvidenceComparison(value: unknown): boolean {
  if (
    !isStringRecord(value) ||
    !hasExactKeys(value, [
      "conflicts",
      "manual",
      "observed",
      "sourceCandidates",
    ]) ||
    !Array.isArray(value.observed) ||
    !value.observed.every(isStrictRecognitionEvidence) ||
    !Array.isArray(value.manual) ||
    !value.manual.every(isStrictRecognitionEvidence) ||
    !Array.isArray(value.conflicts) ||
    !value.conflicts.every(isNonEmptyString) ||
    !Array.isArray(value.sourceCandidates)
  )
    return false;
  return value.sourceCandidates.every(
    (candidate) =>
      isStringRecord(candidate) &&
      hasExactKeys(
        candidate,
        [
          "explanation",
          "nativeAddress",
          "outcome",
          "ruleResults",
          "sourceIdentity",
          "sourceRecordIds",
        ],
        ["reference"],
      ) &&
      (candidate.reference === undefined ||
        isNonEmptyString(candidate.reference)) &&
      ["accepted", "contradicted"].includes(candidate.outcome as string) &&
      isNonEmptyString(candidate.explanation) &&
      isNonEmptyString(candidate.nativeAddress) &&
      isNonEmptyString(candidate.sourceIdentity) &&
      Array.isArray(candidate.sourceRecordIds) &&
      candidate.sourceRecordIds.every(isNonEmptyString) &&
      new Set(candidate.sourceRecordIds).size ===
        candidate.sourceRecordIds.length &&
      Array.isArray(candidate.ruleResults) &&
      candidate.ruleResults.every(isStrictRecognitionRuleResult),
  );
}

function isStrictSourceAssociationProposal(value: unknown): boolean {
  if (
    !isStringRecord(value) ||
    !["establish", "replace", "retract"].includes(value.kind as string)
  )
    return false;
  const commonValid =
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.subjectId) &&
    isStrictProposalAuthor(value.proposedBy) &&
    isStrictEvidenceComparison(value.evidence);
  if (!commonValid) return false;
  if (value.kind === "retract")
    return (
      hasExactKeys(value, [
        "evidence",
        "id",
        "kind",
        "predecessorAssociationId",
        "proposedBy",
        "reason",
        "subjectId",
      ]) &&
      isNonEmptyString(value.predecessorAssociationId) &&
      isNonEmptyString(value.reason)
    );
  const required = [
    "evidence",
    "id",
    "kind",
    "proposedBy",
    "sourceRecordIds",
    "subjectId",
    "successor",
    ...(value.kind === "replace" ? ["predecessorAssociationId"] : []),
  ];
  return (
    hasExactKeys(value, required) &&
    isStrictSourceAssociation(value.successor) &&
    Array.isArray(value.sourceRecordIds) &&
    value.sourceRecordIds.every(isNonEmptyString) &&
    new Set(value.sourceRecordIds).size === value.sourceRecordIds.length &&
    (value.kind !== "replace" ||
      isNonEmptyString(value.predecessorAssociationId))
  );
}

/** 持久化适配器与 readiness 共用的来源关联提议精确解码边界。 */
export function decodeSourceAssociationChangeProposal(
  value: unknown,
):
  | { readonly valid: true; readonly value: SourceAssociationChangeProposal }
  | { readonly valid: false; readonly reason: string } {
  if (!isStrictSourceAssociationProposal(value))
    return { valid: false, reason: "来源关联提议结构无效" };
  return {
    valid: true,
    value: value as SourceAssociationChangeProposal,
  };
}

export function decodeSourceAssociationDecisionCheckpoint(value: unknown):
  | {
      readonly valid: true;
      readonly value: SourceAssociationDecisionCheckpoint;
    }
  | { readonly valid: false; readonly reason: string } {
  if (!isStringRecord(value))
    return { valid: false, reason: "来源关联决定检查点必须是对象" };
  if (
    value.version !== "source-association-decision-checkpoint/1" ||
    ![
      "created",
      "normalizing",
      "collecting",
      "interpreting",
      "awaiting-selection",
      "awaiting-confirmation",
      "no-change",
      "applied",
      "rejected",
      "stale",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(value.state as string) ||
    !["establish", "replace", "retract"].includes(value.intent as string) ||
    !isNonEmptyString(value.assetId) ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.capturedSourceRecordIds) ||
    value.capturedSourceRecordIds.some((item) => !isNonEmptyString(item)) ||
    new Set(value.capturedSourceRecordIds).size !==
      value.capturedSourceRecordIds.length ||
    !hasExactKeys(
      value,
      [
        "assetId",
        "candidates",
        "capturedSourceRecordIds",
        "intent",
        "state",
        "version",
      ],
      [
        "failure",
        "normalization",
        "predecessor",
        "previewId",
        "proposal",
        "sourceIdentity",
      ],
    )
  )
    return { valid: false, reason: "来源关联决定检查点结构无效" };
  const checkpoint = value as unknown as SourceAssociationDecisionCheckpoint;
  if (
    checkpoint.candidates.some(
      (candidate) =>
        !isStringRecord(candidate) ||
        !hasExactKeys(candidate, [
          "explanation",
          "interpretation",
          "nativeAddress",
          "outcome",
          "ruleResults",
          "sourceIdentity",
          "sourceRecordIds",
        ]) ||
        !["accepted", "contradicted"].includes(candidate.outcome) ||
        !isNonEmptyString(candidate.explanation) ||
        !isNonEmptyString(candidate.nativeAddress) ||
        !isNonEmptyString(candidate.sourceIdentity) ||
        !Array.isArray(candidate.sourceRecordIds) ||
        candidate.sourceRecordIds.some((id) => !isNonEmptyString(id)) ||
        new Set(candidate.sourceRecordIds).size !==
          candidate.sourceRecordIds.length ||
        !Array.isArray(candidate.ruleResults) ||
        !candidate.ruleResults.every(isStrictRecognitionRuleResult) ||
        !isStrictSourceInterpretationBatch(candidate.interpretation),
    ) ||
    (checkpoint.predecessor !== undefined &&
      (!isStringRecord(checkpoint.predecessor) ||
        !hasExactKeys(checkpoint.predecessor, [
          "id",
          "nativeAddress",
          "sourceIdentity",
          "subjectId",
        ]) ||
        !isNonEmptyString(checkpoint.predecessor.id) ||
        !isNonEmptyString(checkpoint.predecessor.subjectId) ||
        !isNonEmptyString(checkpoint.predecessor.sourceIdentity) ||
        !isNonEmptyString(checkpoint.predecessor.nativeAddress))) ||
    (checkpoint.normalization !== undefined &&
      !isStrictSourceNormalizationRecord(checkpoint.normalization)) ||
    [checkpoint.failure, checkpoint.previewId, checkpoint.sourceIdentity].some(
      (item) => item !== undefined && !isNonEmptyString(item),
    )
  )
    return { valid: false, reason: "来源关联决定检查点内容无效" };
  const sameStringSet = (left: readonly string[], right: readonly string[]) =>
    JSON.stringify([...left].toSorted()) ===
    JSON.stringify([...right].toSorted());
  const hasNormalization = checkpoint.normalization !== undefined;
  const hasProposalValue = checkpoint.proposal !== undefined;
  const hasPreviewId = checkpoint.previewId !== undefined;
  const captured = new Set(checkpoint.capturedSourceRecordIds);
  const candidateKeys = checkpoint.candidates.map((candidate) =>
    JSON.stringify({
      outcome: candidate.outcome,
      sourceIdentity: candidate.sourceIdentity,
      nativeAddress: candidate.nativeAddress,
      sourceRecordIds: [...candidate.sourceRecordIds].toSorted(),
      ruleResults: candidate.ruleResults,
      interpretation: candidate.interpretation,
      explanation: candidate.explanation,
    }),
  );
  if (
    !isNonEmptyString(checkpoint.sourceIdentity) ||
    hasProposalValue !== hasPreviewId ||
    (checkpoint.predecessor !== undefined &&
      (checkpoint.predecessor.subjectId !== checkpoint.assetId ||
        checkpoint.predecessor.sourceIdentity !== checkpoint.sourceIdentity)) ||
    (checkpoint.normalization !== undefined &&
      (checkpoint.normalization.evidence.sourceIdentity !==
        checkpoint.sourceIdentity ||
        checkpoint.normalization.evidence.sourceAddress === undefined)) ||
    checkpoint.candidates.some(
      (candidate) =>
        candidate.sourceIdentity !== checkpoint.sourceIdentity ||
        candidate.sourceIdentity !== candidate.interpretation.sourceIdentity ||
        candidate.nativeAddress !== candidate.interpretation.sourceAddress ||
        !sameStringSet(
          candidate.sourceRecordIds,
          candidate.interpretation.sourceRecordIds,
        ) ||
        candidate.sourceRecordIds.some(
          (sourceRecordId) => !captured.has(sourceRecordId),
        ),
    ) ||
    new Set(candidateKeys).size !== candidateKeys.length
  )
    return { valid: false, reason: "来源关联决定检查点坐标不一致" };
  if (checkpoint.proposal !== undefined) {
    const proposal = checkpoint.proposal;
    if (!decodeSourceAssociationChangeProposal(proposal).valid)
      return { valid: false, reason: "来源关联决定检查点提议结构无效" };
    try {
      validateSourceAssociationChange({
        proposal,
        ...(checkpoint.predecessor === undefined
          ? {}
          : { predecessor: checkpoint.predecessor }),
      });
    } catch {
      return { valid: false, reason: "来源关联决定检查点提议无效" };
    }
    if (
      proposal.subjectId !== checkpoint.assetId ||
      proposal.kind !== checkpoint.intent ||
      (checkpoint.state !== "awaiting-confirmation" &&
        !["applied", "rejected", "stale"].includes(checkpoint.state))
    )
      return { valid: false, reason: "来源关联决定检查点提议状态无效" };
    if (proposal.kind === "retract") {
      if (
        proposal.evidence.observed.length !== 0 ||
        proposal.evidence.manual.length !== 0 ||
        proposal.evidence.sourceCandidates.length !== 0 ||
        proposal.evidence.conflicts.length !== 0
      )
        return { valid: false, reason: "来源关联撤回提议证据无效" };
    } else {
      const selected = checkpoint.candidates.filter(
        (candidate) =>
          candidate.sourceIdentity === proposal.successor.sourceIdentity &&
          candidate.nativeAddress === proposal.successor.nativeAddress &&
          sameStringSet(candidate.sourceRecordIds, proposal.sourceRecordIds),
      );
      if (
        selected.length !== 1 ||
        proposal.successor.subjectId !== checkpoint.assetId ||
        proposal.successor.sourceIdentity !== checkpoint.sourceIdentity ||
        !sameStringSet(checkpoint.capturedSourceRecordIds, [
          ...new Set(
            checkpoint.candidates.flatMap(
              ({ sourceRecordIds }) => sourceRecordIds,
            ),
          ),
        ]) ||
        JSON.stringify(proposal.evidence.sourceCandidates) !==
          JSON.stringify(
            checkpoint.candidates.map((candidate) => ({
              ...(proposal.evidence.sourceCandidates.every(
                (evidenceCandidate) =>
                  evidenceCandidate.reference !== undefined,
              )
                ? {
                    reference:
                      publicSourceAssociationCandidate(candidate).reference,
                  }
                : {}),
              outcome: candidate.outcome,
              sourceIdentity: candidate.sourceIdentity,
              nativeAddress: candidate.nativeAddress,
              sourceRecordIds: candidate.sourceRecordIds,
              ruleResults: candidate.ruleResults,
              explanation: candidate.explanation,
            })),
          ) ||
        JSON.stringify(proposal.evidence.manual) !==
          JSON.stringify(
            checkpoint.normalization === undefined
              ? []
              : [checkpoint.normalization.evidence],
          ) ||
        proposal.evidence.observed.length !== 0 ||
        JSON.stringify(proposal.evidence.conflicts) !==
          JSON.stringify(
            checkpoint.candidates
              .filter(({ outcome }) => outcome === "contradicted")
              .map(({ explanation }) => explanation),
          )
      )
        return { valid: false, reason: "来源关联决定检查点候选提议不一致" };
    }
  }
  if (
    (checkpoint.state === "awaiting-selection" &&
      checkpoint.candidates.length < 2) ||
    (checkpoint.state === "awaiting-confirmation" &&
      (checkpoint.proposal === undefined || checkpoint.previewId === undefined))
  )
    return { valid: false, reason: "来源关联决定检查点状态不完整" };
  const forbiddenOutsideFailed =
    checkpoint.failure !== undefined && checkpoint.state !== "failed";
  const missingFailedReason =
    checkpoint.state === "failed" && checkpoint.failure === undefined;
  if (forbiddenOutsideFailed || missingFailedReason)
    return { valid: false, reason: "来源关联决定检查点终态字段无效" };
  const hasCandidateInput = hasNormalization;
  const hasProposal = hasProposalValue && hasPreviewId;
  const intentInvalid =
    (checkpoint.intent === "establish" &&
      checkpoint.predecessor !== undefined) ||
    (checkpoint.intent !== "establish" &&
      checkpoint.predecessor === undefined) ||
    (checkpoint.intent === "retract" &&
      (checkpoint.normalization !== undefined ||
        checkpoint.candidates.length > 0 ||
        checkpoint.capturedSourceRecordIds.length > 0));
  const stateInvalid =
    (["created", "normalizing"].includes(checkpoint.state) &&
      (hasCandidateInput ||
        checkpoint.candidates.length > 0 ||
        checkpoint.capturedSourceRecordIds.length > 0 ||
        hasProposal)) ||
    (checkpoint.state === "collecting" &&
      (!hasCandidateInput ||
        checkpoint.candidates.length > 0 ||
        checkpoint.capturedSourceRecordIds.length > 0 ||
        hasProposal)) ||
    (checkpoint.state === "interpreting" &&
      (!hasCandidateInput ||
        checkpoint.capturedSourceRecordIds.length === 0 ||
        checkpoint.candidates.length > 1 ||
        hasProposal)) ||
    (checkpoint.state === "awaiting-selection" &&
      (!hasCandidateInput || hasProposal)) ||
    (checkpoint.state === "awaiting-confirmation" && !hasProposal) ||
    (checkpoint.state === "awaiting-confirmation" &&
      checkpoint.intent !== "retract" &&
      checkpoint.candidates.length === 0) ||
    (["applied", "rejected", "stale"].includes(checkpoint.state) &&
      !hasProposal) ||
    (["failed", "cancelled", "interrupted", "no-change"].includes(
      checkpoint.state,
    ) &&
      hasProposal);
  if (intentInvalid || stateInvalid)
    return { valid: false, reason: "来源关联决定检查点状态字段组合无效" };
  return { valid: true, value: checkpoint };
}

/** 持久执行封装必须把公开意图与私有检查点绑定为同一条因果链。 */
export function validateSourceAssociationDecisionEnvelope(
  execution: Pick<
    WorkflowExecution,
    | "id"
    | "workflowInput"
    | "acceptedAssetId"
    | "compatibility"
    | "sourceRecordIds"
    | "sourceAssociationDecision"
  >,
): boolean {
  const workflowInput = execution.workflowInput;
  const checkpoint = execution.sourceAssociationDecision;
  if (checkpoint === undefined)
    return workflowInput?.version !== "source-association-decision-input/1";
  if (
    workflowInput?.version !== "source-association-decision-input/1" ||
    !decodeSourceAssociationDecisionCheckpoint(checkpoint).valid
  )
    return false;
  const stableInput = (value: Readonly<Record<string, string>> | undefined) =>
    value === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(value).toSorted(([left], [right]) =>
            left.localeCompare(right),
          ),
        );
  return (
    workflowInput.intent === checkpoint.intent &&
    workflowInput.assetId === checkpoint.assetId &&
    execution.acceptedAssetId === checkpoint.assetId &&
    workflowInput.priorExecutionId !== execution.id &&
    JSON.stringify([...execution.sourceRecordIds].toSorted()) ===
      JSON.stringify([...checkpoint.capturedSourceRecordIds].toSorted()) &&
    workflowInput.sourceIdentity === checkpoint.sourceIdentity &&
    workflowInput.predecessorAssociationId === checkpoint.predecessor?.id &&
    (checkpoint.normalization === undefined ||
      (JSON.stringify(stableInput(workflowInput.sourceInput)) ===
        JSON.stringify(stableInput(checkpoint.normalization.rawInput)) &&
        execution.compatibility.capabilityCoordinates.includes(
          capabilityCoordinate(checkpoint.normalization.capability),
        ))) &&
    (checkpoint.predecessor === undefined ||
      (checkpoint.predecessor.subjectId === workflowInput.assetId &&
        checkpoint.predecessor.sourceIdentity ===
          workflowInput.sourceIdentity)) &&
    (checkpoint.normalization === undefined ||
      checkpoint.normalization.evidence.sourceIdentity ===
        workflowInput.sourceIdentity) &&
    (checkpoint.proposal === undefined ||
      (checkpoint.proposal.proposedBy.kind === "user" &&
        checkpoint.proposal.proposedBy.actorId ===
          workflowInput.initiatedBy)) &&
    (checkpoint.proposal?.kind !== "retract" ||
      checkpoint.proposal.reason === workflowInput.reason)
  );
}

/** 重试输入只能指向同一冻结动作的一条真实、已终止来源决定执行。 */
export function validateSourceAssociationDecisionPriorExecution(
  execution: Pick<WorkflowExecution, "id" | "workflowInput">,
  prior:
    | Pick<
        WorkflowExecution,
        "id" | "status" | "workflowInput" | "sourceAssociationDecision"
      >
    | undefined,
): boolean {
  const input = execution.workflowInput;
  if (input?.version !== "source-association-decision-input/1") return true;
  if (input.priorExecutionId === undefined) return true;
  const priorInput = prior?.workflowInput;
  if (
    prior === undefined ||
    prior.id !== input.priorExecutionId ||
    prior.status === "running" ||
    prior.sourceAssociationDecision === undefined ||
    priorInput?.version !== "source-association-decision-input/1"
  )
    return false;
  const checkpointState = prior.sourceAssociationDecision.state;
  if (
    (prior.status === "completed" &&
      !["applied", "rejected", "no-change"].includes(checkpointState)) ||
    (prior.status === "failed" &&
      !["failed", "cancelled", "interrupted", "stale"].includes(
        checkpointState,
      ))
  )
    return false;
  const stableInput = (value: SourceAssociationDecisionWorkflowInput) => ({
    version: value.version,
    trigger: value.trigger,
    initiatedBy: value.initiatedBy,
    acceptTrusted: value.acceptTrusted,
    configurationReferences: [...value.configurationReferences].toSorted(
      (left, right) => left.localeCompare(right),
    ),
    intent: value.intent,
    assetId: value.assetId,
    sourceIdentity: value.sourceIdentity,
    predecessorAssociationId: value.predecessorAssociationId,
    sourceInput:
      value.sourceInput === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(value.sourceInput).toSorted(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
    reason: value.reason,
  });
  return (
    JSON.stringify(stableInput(input)) ===
    JSON.stringify(stableInput(priorInput))
  );
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function isStrictCapabilityCoordinate(value: unknown): boolean {
  if (!isStringRecord(value)) return false;
  return (
    hasExactKeys(
      value,
      ["capabilityId", "capabilityVersion", "contractVersion"],
      [
        "identity",
        "implementationVersion",
        "kind",
        "interpretationContractVersions",
      ],
    ) &&
    [value.capabilityId, value.capabilityVersion, value.contractVersion].every(
      isNonEmptyString,
    ) &&
    [value.identity, value.implementationVersion, value.kind].every(
      (item) => item === undefined || isNonEmptyString(item),
    ) &&
    (value.interpretationContractVersions === undefined ||
      (Array.isArray(value.interpretationContractVersions) &&
        value.interpretationContractVersions.every(isNonEmptyString) &&
        new Set(value.interpretationContractVersions).size ===
          value.interpretationContractVersions.length))
  );
}

function isStrictRecognitionRuleResult(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    hasExactKeys(
      value,
      [
        "capabilityId",
        "capabilityVersion",
        "evidence",
        "explanation",
        "outcome",
        "ruleId",
        "ruleVersion",
      ],
      ["evidenceReferences"],
    ) &&
    [
      value.capabilityId,
      value.capabilityVersion,
      value.explanation,
      value.ruleId,
      value.ruleVersion,
    ].every(isNonEmptyString) &&
    ["satisfied", "contradicted"].includes(value.outcome as string) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isStrictRecognitionEvidence) &&
    optionalArrayEvery(
      value.evidenceReferences,
      (reference) =>
        isStringRecord(reference) &&
        hasExactKeys(reference, ["kind", "sourceRecordId"]) &&
        reference.kind === "source-record" &&
        isNonEmptyString(reference.sourceRecordId),
    )
  );
}

function isStrictSourceInterpretationBatch(
  value: unknown,
): value is SourceInterpretationBatch {
  if (
    !isStringRecord(value) ||
    !hasExactKeys(
      value,
      [
        "id",
        "metadata",
        "producer",
        "sourceAddress",
        "sourceArtifacts",
        "sourceIdentity",
        "sourceRecordIds",
      ],
      [
        "entities",
        "entityMentions",
        "entityResolutionDecisions",
        "recognitionEvidenceReferences",
        "relationships",
      ],
    ) ||
    !isStrictCapabilityCoordinate(value.producer) ||
    !Array.isArray(value.sourceRecordIds) ||
    !Array.isArray(value.metadata) ||
    !Array.isArray(value.sourceArtifacts) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.sourceIdentity) ||
    !isNonEmptyString(value.sourceAddress) ||
    new Set(value.sourceRecordIds).size !== value.sourceRecordIds.length ||
    !value.sourceRecordIds.every(isNonEmptyString) ||
    !value.metadata.every(isStrictMetadataAssertion) ||
    !value.sourceArtifacts.every(isStrictSourceArtifactCandidate) ||
    !optionalArrayEvery(value.entities, isStrictSourcedEntity) ||
    !optionalArrayEvery(value.entityMentions, isStrictEntityMention) ||
    !optionalArrayEvery(
      value.entityResolutionDecisions,
      isStrictEntityResolutionDecision,
    ) ||
    !optionalArrayEvery(value.relationships, isStrictProposedRelationship) ||
    !optionalArrayEvery(
      value.recognitionEvidenceReferences,
      (reference) =>
        isStringRecord(reference) &&
        hasExactKeys(reference, ["kind", "sourceRecordId"]) &&
        reference.kind === "source-record" &&
        isNonEmptyString(reference.sourceRecordId),
    )
  )
    return false;
  try {
    validateSourceInterpretationBatch(value as SourceInterpretationBatch);
    return true;
  } catch {
    return false;
  }
}

/** readiness 与持久读取共用的 Recognition basis 精确联合解码。 */
export function decodeRecognitionBasis(
  value: unknown,
):
  | { readonly valid: true; readonly value: RecognitionBasis }
  | { readonly valid: false; readonly reason: string } {
  if (!isStringRecord(value))
    return { valid: false, reason: "Recognition basis 必须是对象" };
  if (value.kind === "accepted-boundary")
    return hasExactKeys(value, [
      "kind",
      "recognitionDecisionId",
      "observationSnapshotId",
      "materialReferences",
      "evidence",
    ]) &&
      isNonEmptyString(value.recognitionDecisionId) &&
      isNonEmptyString(value.observationSnapshotId) &&
      isStrictStringArray(value.materialReferences) &&
      Array.isArray(value.evidence) &&
      value.evidence.every(isStrictRecognitionEvidence)
      ? { valid: true, value: value as unknown as RecognitionBasis }
      : { valid: false, reason: "已确认范围 basis 无效" };
  if (value.kind === "source-interpretation")
    return hasExactKeys(value, ["interpretation", "kind"]) &&
      isStrictSourceInterpretationBatch(value.interpretation)
      ? { valid: true, value: value as unknown as RecognitionBasis }
      : { valid: false, reason: "来源解释 basis 无效" };
  if (value.kind === "manual-boundary") {
    const valid =
      hasExactKeys(value, [
        "evidence",
        "kind",
        "materialReferences",
        "metadata",
        "observationSnapshotId",
        "proposedBy",
        "revisesProposalIds",
      ]) &&
      isNonEmptyString(value.proposedBy) &&
      isNonEmptyString(value.observationSnapshotId) &&
      isStrictStringArray(value.materialReferences) &&
      isStrictStringArray(value.revisesProposalIds) &&
      Array.isArray(value.metadata) &&
      value.metadata.every(
        (item) =>
          isStringRecord(item) &&
          hasExactKeys(item, ["property", "value"]) &&
          isNonEmptyString(item.property) &&
          typeof item.value === "string",
      ) &&
      Array.isArray(value.evidence) &&
      value.evidence.every(isStrictRecognitionEvidence);
    return valid
      ? { valid: true, value: value as unknown as RecognitionBasis }
      : { valid: false, reason: "人工边界 basis 无效" };
  }
  if (value.kind === "observed-evidence") {
    const valid =
      hasExactKeys(value, [
        "artifactRevisions",
        "evidence",
        "kind",
        "producer",
      ]) &&
      isStrictCapabilityCoordinate(value.producer) &&
      Array.isArray(value.evidence) &&
      value.evidence.every(isStrictRecognitionEvidence) &&
      Array.isArray(value.artifactRevisions) &&
      value.artifactRevisions.every(
        (item) =>
          isStringRecord(item) &&
          hasExactKeys(item, [
            "blob",
            "observedArtifactReference",
            "producer",
          ]) &&
          isNonEmptyString(item.observedArtifactReference) &&
          isStrictBlob(item.blob) &&
          isStrictCapabilityCoordinate(item.producer),
      );
    return valid
      ? { valid: true, value: value as unknown as RecognitionBasis }
      : { valid: false, reason: "观察证据 basis 无效" };
  }
  return { valid: false, reason: "Recognition basis kind 无效" };
}

/** 完整来源解释批次共用的精确严格解码，与 Recognition basis 同一规则来源。 */
export function decodeSourceInterpretationBatch(
  value: unknown,
):
  | { readonly valid: true; readonly value: SourceInterpretationBatch }
  | { readonly valid: false; readonly reason: string } {
  return isStrictSourceInterpretationBatch(value)
    ? { valid: true, value }
    : { valid: false, reason: "来源解释批次无效" };
}

/** 当前形状来源实体条目的精确严格解码。 */
export function decodeSourcedEntity(
  value: unknown,
):
  | { readonly valid: true; readonly value: SourcedEntity }
  | { readonly valid: false; readonly reason: string } {
  return isStrictSourcedEntity(value)
    ? { valid: true, value: value as SourcedEntity }
    : { valid: false, reason: "来源实体条目无效" };
}

function optionalArrayEvery(
  value: unknown,
  predicate: (item: unknown) => boolean,
): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every(predicate))
  );
}

function isStrictStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}

function isStrictQualifiers(value: unknown): boolean {
  return optionalArrayEvery(
    value,
    (item) =>
      isStringRecord(item) &&
      hasExactKeys(item, ["key", "value"]) &&
      isNonEmptyString(item.key) &&
      isNonEmptyString(item.value),
  );
}

function isStrictMetadataAssertion(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    hasExactKeys(
      value,
      ["property", "sourceRecordIds", "sourceSlot", "value"],
      [
        "authoredBy",
        "observedArtifactPart",
        "producer",
        "qualifiers",
        "subjectId",
      ],
    ) &&
    [value.property, value.sourceSlot, value.value].every(isNonEmptyString) &&
    isStrictStringArray(value.sourceRecordIds) &&
    (value.subjectId === undefined || isNonEmptyString(value.subjectId)) &&
    (value.producer === undefined ||
      isStrictCapabilityCoordinate(value.producer)) &&
    isStrictQualifiers(value.qualifiers) &&
    (value.authoredBy === undefined ||
      (isStringRecord(value.authoredBy) &&
        hasExactKeys(value.authoredBy, ["initiatedBy", "proposalId"]) &&
        isNonEmptyString(value.authoredBy.initiatedBy) &&
        isNonEmptyString(value.authoredBy.proposalId))) &&
    (value.observedArtifactPart === undefined ||
      (isStringRecord(value.observedArtifactPart) &&
        hasExactKeys(value.observedArtifactPart, [
          "artifactId",
          "locator",
          "revisionId",
        ]) &&
        [
          value.observedArtifactPart.artifactId,
          value.observedArtifactPart.locator,
          value.observedArtifactPart.revisionId,
        ].every(isNonEmptyString)))
  );
}

function isStrictSourceArtifactCandidate(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    hasExactKeys(
      value,
      ["acquisitionReference", "id", "mediaType", "role", "sourceRecordId"],
      ["producer", "selectionEvidence", "subjectId"],
    ) &&
    [
      value.acquisitionReference,
      value.id,
      value.mediaType,
      value.role,
      value.sourceRecordId,
    ].every(isNonEmptyString) &&
    (value.subjectId === undefined || isNonEmptyString(value.subjectId)) &&
    (value.producer === undefined ||
      isStrictCapabilityCoordinate(value.producer)) &&
    (value.selectionEvidence === undefined ||
      (isStringRecord(value.selectionEvidence) &&
        hasExactKeys(
          value.selectionEvidence,
          [],
          ["declaredByteLength", "sourceOrdinal", "suggestedFilename"],
        ) &&
        (value.selectionEvidence.suggestedFilename === undefined ||
          isNonEmptyString(value.selectionEvidence.suggestedFilename)) &&
        [
          value.selectionEvidence.declaredByteLength,
          value.selectionEvidence.sourceOrdinal,
        ].every(
          (item) =>
            item === undefined ||
            (Number.isSafeInteger(item) && (item as number) >= 0),
        )))
  );
}

function isStrictSourcedEntity(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "identityNamespace",
        "label",
        "sourceIdentity",
        "sourceKey",
        "sourceRecordIds",
      ],
      ["producer"],
    ) &&
    [
      value.id,
      value.identityNamespace,
      value.label,
      value.sourceIdentity,
      value.sourceKey,
    ].every(isNonEmptyString) &&
    isStrictStringArray(value.sourceRecordIds) &&
    (value.producer === undefined ||
      isStrictCapabilityCoordinate(value.producer))
  );
}

function isStrictEntityMention(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    hasExactKeys(
      value,
      [
        "field",
        "id",
        "identityNamespace",
        "label",
        "role",
        "sourceIdentity",
        "sourceKey",
        "sourceRecordIds",
      ],
      ["producer"],
    ) &&
    [
      value.field,
      value.id,
      value.identityNamespace,
      value.label,
      value.role,
      value.sourceIdentity,
      value.sourceKey,
    ].every(isNonEmptyString) &&
    isStrictStringArray(value.sourceRecordIds) &&
    (value.producer === undefined ||
      isStrictCapabilityCoordinate(value.producer))
  );
}

function isStrictEntityResolutionDecision(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    hasExactKeys(
      value,
      ["entityId", "id", "mentionId", "rule", "sourceRecordIds"],
      ["producer"],
    ) &&
    value.rule === "source-field-role-exact" &&
    [value.entityId, value.id, value.mentionId].every(isNonEmptyString) &&
    isStrictStringArray(value.sourceRecordIds) &&
    (value.producer === undefined ||
      isStrictCapabilityCoordinate(value.producer))
  );
}

function isStrictProposedRelationship(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    hasExactKeys(
      value,
      ["participants", "sourceRecordIds", "sourceSlot", "type"],
      [
        "producer",
        "qualifiers",
        "requiredRoles",
        "sourceSubjectId",
        "subjectRole",
      ],
    ) &&
    isNonEmptyString(value.sourceSlot) &&
    isNonEmptyString(value.type) &&
    Array.isArray(value.participants) &&
    value.participants.length > 0 &&
    value.participants.every(
      (participant) =>
        isStringRecord(participant) &&
        hasExactKeys(participant, ["entityId", "role"], ["mentionIds"]) &&
        isNonEmptyString(participant.entityId) &&
        isNonEmptyString(participant.role) &&
        (participant.mentionIds === undefined ||
          isStrictStringArray(participant.mentionIds)),
    ) &&
    isStrictStringArray(value.sourceRecordIds) &&
    (value.requiredRoles === undefined ||
      isStrictStringArray(value.requiredRoles)) &&
    (value.sourceSubjectId === undefined ||
      isNonEmptyString(value.sourceSubjectId)) &&
    (value.subjectRole === undefined || isNonEmptyString(value.subjectRole)) &&
    (value.producer === undefined ||
      isStrictCapabilityCoordinate(value.producer)) &&
    isStrictQualifiers(value.qualifiers)
  );
}

/** 尚未发布的 02A→02C forward migration 只接受完整、递归精确的旧来源补充权威。 */
export function isExactLegacySourceEnrichmentAuthorityCheckpoint(
  value: unknown,
): boolean {
  if (
    !isStringRecord(value) ||
    !hasExactKeys(
      value,
      [
        "evidence",
        "fulfilledArtifactRoles",
        "interpretation",
        "key",
        "metadataPolicyIds",
        "sourceArtifacts",
        "sourceAssociation",
        "sourceRecordIds",
        "stage",
        "subject",
        "subjectId",
      ],
      ["explicitInput", "managedSourceArtifacts", "sourceArtifactAcquisitions"],
    ) ||
    value.stage !== "applied" ||
    !isNonEmptyString(value.key) ||
    !isNonEmptyString(value.subjectId) ||
    !isStrictRecognitionEvidence(value.evidence) ||
    !isStrictSourceInterpretationBatch(value.interpretation) ||
    !isStrictStringArray(value.sourceRecordIds) ||
    !Array.isArray(value.sourceArtifacts) ||
    !value.sourceArtifacts.every(isStrictSourceArtifactCandidate) ||
    !Array.isArray(value.fulfilledArtifactRoles) ||
    new Set(
      value.fulfilledArtifactRoles.map((item) =>
        isStringRecord(item) ? item.role : undefined,
      ),
    ).size !== value.fulfilledArtifactRoles.length ||
    !Array.isArray(value.metadataPolicyIds) ||
    !value.metadataPolicyIds.every(isNonEmptyString) ||
    new Set(value.metadataPolicyIds).size !== value.metadataPolicyIds.length
  )
    return false;
  const interpretation = value.interpretation;
  const evidence = value.evidence as RecognitionEvidence;
  const sourceAssociation = value.sourceAssociation;
  const associationValid = (candidate: unknown): boolean =>
    isStringRecord(candidate) &&
    hasExactKeys(
      candidate,
      ["id", "nativeAddress", "sourceIdentity", "subjectId"],
      ["proposalId"],
    ) &&
    [
      candidate.id,
      candidate.nativeAddress,
      candidate.sourceIdentity,
      candidate.subjectId,
    ].every(isNonEmptyString) &&
    (candidate.proposalId === undefined ||
      isNonEmptyString(candidate.proposalId));
  if (!associationValid(sourceAssociation)) return false;
  const association = sourceAssociation as Record<string, unknown>;
  const subject = value.subject;
  if (
    !isStringRecord(subject) ||
    !hasExactKeys(
      subject,
      [
        "informationRequirement",
        "metadata",
        "metadataSourceRecords",
        "recognitionDecisionId",
        "sourceAssociations",
        "subjectId",
      ],
      ["recognitionSourceAssociation"],
    ) ||
    subject.subjectId !== value.subjectId ||
    !isNonEmptyString(subject.recognitionDecisionId) ||
    !Array.isArray(subject.sourceAssociations) ||
    !subject.sourceAssociations.every(associationValid) ||
    new Set(
      subject.sourceAssociations.map((item) =>
        isStringRecord(item) ? item.id : undefined,
      ),
    ).size !== subject.sourceAssociations.length ||
    (subject.recognitionSourceAssociation !== undefined &&
      !associationValid(subject.recognitionSourceAssociation)) ||
    !Array.isArray(subject.metadata) ||
    !subject.metadata.every(isStrictMetadataAssertion) ||
    !Array.isArray(subject.metadataSourceRecords) ||
    new Set(
      subject.metadataSourceRecords.map((item) =>
        isStringRecord(item) ? item.id : undefined,
      ),
    ).size !== subject.metadataSourceRecords.length ||
    !subject.metadataSourceRecords.every(
      (record) =>
        isStringRecord(record) &&
        hasExactKeys(record, ["id", "sourceIdentity"], ["nativeAddress"]) &&
        isNonEmptyString(record.id) &&
        isNonEmptyString(record.sourceIdentity) &&
        (record.nativeAddress === undefined ||
          isNonEmptyString(record.nativeAddress)),
    )
  )
    return false;
  const requirement = subject.informationRequirement;
  if (
    !isStringRecord(requirement) ||
    !hasExactKeys(requirement, [
      "artifactRoles",
      "metadata",
      "metadataUsageContext",
      "relationshipTypes",
    ]) ||
    !isNonEmptyString(requirement.metadataUsageContext) ||
    !Array.isArray(requirement.metadata) ||
    new Set(
      requirement.metadata.map((item) =>
        isStringRecord(item) ? item.property : undefined,
      ),
    ).size !== requirement.metadata.length ||
    !requirement.metadata.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["necessity", "property"]) &&
        isNonEmptyString(item.property) &&
        ["required", "optional"].includes(item.necessity as string),
    ) ||
    !Array.isArray(requirement.artifactRoles) ||
    new Set(
      requirement.artifactRoles.map((item) =>
        isStringRecord(item) ? item.role : undefined,
      ),
    ).size !== requirement.artifactRoles.length ||
    !requirement.artifactRoles.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["necessity", "role"], ["maximum"]) &&
        isNonEmptyString(item.role) &&
        ["required", "optional"].includes(item.necessity as string) &&
        (item.maximum === undefined ||
          (Number.isSafeInteger(item.maximum) && (item.maximum as number) > 0)),
    ) ||
    !Array.isArray(requirement.relationshipTypes) ||
    new Set(
      requirement.relationshipTypes.map((item) =>
        isStringRecord(item) ? item.type : undefined,
      ),
    ).size !== requirement.relationshipTypes.length ||
    !requirement.relationshipTypes.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["necessity", "type"]) &&
        isNonEmptyString(item.type) &&
        ["required", "optional"].includes(item.necessity as string),
    ) ||
    !value.fulfilledArtifactRoles.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["count", "role"]) &&
        isNonEmptyString(item.role) &&
        Number.isSafeInteger(item.count) &&
        (item.count as number) >= 0,
    ) ||
    (value.explicitInput !== undefined &&
      (!isStringRecord(value.explicitInput) ||
        Object.keys(value.explicitInput).length === 0 ||
        Object.entries(value.explicitInput).some(
          ([key, item]) => key.trim().length === 0 || typeof item !== "string",
        ))) ||
    association.subjectId !== value.subjectId ||
    association.sourceIdentity !== interpretation.sourceIdentity ||
    association.nativeAddress !== interpretation.sourceAddress ||
    evidence.sourceIdentity !== association.sourceIdentity ||
    evidence.sourceAddress !== association.nativeAddress ||
    JSON.stringify([...value.sourceRecordIds].toSorted()) !==
      JSON.stringify([...interpretation.sourceRecordIds].toSorted()) ||
    JSON.stringify(value.sourceArtifacts) !==
      JSON.stringify(interpretation.sourceArtifacts)
  )
    return false;
  const exactCoordinate = (candidate: unknown): boolean =>
    candidate === undefined || isStrictCapabilityCoordinate(candidate);
  if (
    !optionalArrayEvery(
      value.sourceArtifactAcquisitions,
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(
          item,
          [
            "candidateId",
            "digest",
            "mediaType",
            "role",
            "sourceRecordId",
            "stagedReference",
          ],
          [
            "acquisitionProducer",
            "acquisitionReference",
            "sourceArtifactProducer",
            "subjectId",
          ],
        ) &&
        [
          item.candidateId,
          item.digest,
          item.mediaType,
          item.role,
          item.sourceRecordId,
          item.stagedReference,
        ].every(isNonEmptyString) &&
        [item.acquisitionReference, item.subjectId].every(
          (field) => field === undefined || isNonEmptyString(field),
        ) &&
        exactCoordinate(item.sourceArtifactProducer) &&
        exactCoordinate(item.acquisitionProducer),
    )
  )
    return false;
  return optionalArrayEvery(
    value.managedSourceArtifacts,
    (item) =>
      isStringRecord(item) &&
      hasExactKeys(
        item,
        ["blob", "candidateId", "location", "role", "sourceRecordId"],
        [
          "acquisitionProducer",
          "acquisitionReference",
          "sourceArtifactProducer",
          "subjectId",
        ],
      ) &&
      [item.candidateId, item.role, item.sourceRecordId].every(
        isNonEmptyString,
      ) &&
      [item.acquisitionReference, item.subjectId].every(
        (field) => field === undefined || isNonEmptyString(field),
      ) &&
      exactCoordinate(item.sourceArtifactProducer) &&
      exactCoordinate(item.acquisitionProducer) &&
      isStringRecord(item.blob) &&
      hasExactKeys(item.blob, ["byteLength", "digest", "mediaType"]) &&
      isNonEmptyString(item.blob.digest) &&
      isNonEmptyString(item.blob.mediaType) &&
      Number.isSafeInteger(item.blob.byteLength) &&
      (item.blob.byteLength as number) >= 0 &&
      isStringRecord(item.location) &&
      hasExactKeys(item.location, ["address"]) &&
      isNonEmptyString(item.location.address),
  );
}

/** 旧来源补充迁移只接收由完整执行封装证明的单条已应用权威。 */
export function isExactLegacySourceEnrichmentExecutionAuthority(
  value: unknown,
): boolean {
  if (
    !isStringRecord(value) ||
    !hasExactKeys(value, [
      "acceptedAssetId",
      "authorityCheckpoint",
      "compatibility",
      "executionId",
      "sourceEnrichments",
      "sourceRecordIds",
      "workflowInput",
    ]) ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.acceptedAssetId) ||
    !isStrictStringArray(value.sourceRecordIds) ||
    !Array.isArray(value.sourceEnrichments) ||
    value.sourceEnrichments.length === 0 ||
    !isExactLegacySourceEnrichmentAuthorityCheckpoint(value.authorityCheckpoint)
  )
    return false;
  const input = decodeWorkflowExecutionInput(value.workflowInput);
  if (
    !input.valid ||
    input.input.version !== "asset-refresh-input/1" ||
    !isStringRecord(value.compatibility) ||
    !hasExactKeys(value.compatibility, [
      "capabilityCoordinates",
      "policyVersion",
      "workflowVersion",
    ]) ||
    value.compatibility.workflowVersion !== "asset-refresh/2" ||
    !isNonEmptyString(value.compatibility.policyVersion) ||
    !Array.isArray(value.compatibility.capabilityCoordinates) ||
    !value.compatibility.capabilityCoordinates.every(
      isStrictCapabilityCoordinate,
    )
  )
    return false;
  const checkpoints = value.sourceEnrichments as unknown[];
  const applied = checkpoints.filter(
    (checkpoint) =>
      isStringRecord(checkpoint) && checkpoint.stage === "applied",
  );
  if (
    !applied.every(isExactLegacySourceEnrichmentAuthorityCheckpoint) ||
    new Set(
      checkpoints.map((checkpoint) =>
        isStringRecord(checkpoint) ? checkpoint.key : undefined,
      ),
    ).size !== checkpoints.length ||
    applied.filter(
      (checkpoint) =>
        JSON.stringify(checkpoint) ===
        JSON.stringify(value.authorityCheckpoint),
    ).length !== 1
  )
    return false;
  const checkpoint = value.authorityCheckpoint as SourceEnrichmentCheckpoint & {
    readonly stage: "applied";
    readonly interpretation: SourceInterpretationBatch;
    readonly sourceRecordIds: readonly string[];
    readonly subjectId: string;
  };
  const coordinates = value.compatibility
    .capabilityCoordinates as CapabilityCoordinate[];
  const coordinateKeys = coordinates.map(capabilityCoordinate);
  return (
    new Set(coordinateKeys).size === coordinateKeys.length &&
    checkpoint.subjectId === value.acceptedAssetId &&
    checkpoint.sourceRecordIds.every((id) =>
      (value.sourceRecordIds as readonly string[]).includes(id),
    ) &&
    coordinateKeys.includes(
      capabilityCoordinate(checkpoint.interpretation.producer),
    )
  );
}

function isStrictFilesystemObjectIdentity(value: unknown): boolean {
  if (!isStringRecord(value)) return false;
  if (
    value.version !== "filesystem-object-identity/2" ||
    (value.kind !== "snapshot-local" && value.kind !== "durable") ||
    typeof value.value !== "string" ||
    value.value.length === 0
  )
    return false;
  if (value.kind === "snapshot-local")
    return hasExactKeys(value, ["version", "kind", "value"]);
  if (
    !hasExactKeys(value, ["version", "kind", "value", "capability"]) ||
    !isStringRecord(value.capability)
  )
    return false;
  const capability = value.capability;
  return (
    hasExactKeys(
      capability,
      ["capabilityId", "capabilityVersion", "contractVersion"],
      [
        "identity",
        "implementationVersion",
        "kind",
        "interpretationContractVersions",
      ],
    ) && isStrictCapabilityCoordinate(capability)
  );
}

function isStrictFilesystemPackageSnapshot(
  value: unknown,
): value is FilesystemPackageSnapshot {
  if (
    !isStringRecord(value) ||
    !hasExactKeys(
      value,
      ["id", "root", "complete", "files", "excluded", "observedAt"],
      ["directories", "diagnostics"],
    ) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.root !== "string" ||
    value.root.length === 0 ||
    typeof value.complete !== "boolean" ||
    typeof value.observedAt !== "string" ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.excluded)
  )
    return false;
  const filesValid = value.files.every(
    (file) =>
      isStringRecord(file) &&
      hasExactKeys(
        file,
        ["relativePath", "size", "modifiedAt"],
        ["objectIdentity"],
      ) &&
      typeof file.relativePath === "string" &&
      file.relativePath.length > 0 &&
      Number.isSafeInteger(file.size) &&
      (file.size as number) >= 0 &&
      typeof file.modifiedAt === "string" &&
      (file.objectIdentity === undefined ||
        isStrictFilesystemObjectIdentity(file.objectIdentity)),
  );
  const excludedValid = value.excluded.every(
    (entry) =>
      isStringRecord(entry) &&
      hasExactKeys(entry, ["relativePath", "kind"]) &&
      typeof entry.relativePath === "string" &&
      ["symbolic-link", "special", "unavailable"].includes(
        entry.kind as string,
      ),
  );
  const directoriesValid =
    value.directories === undefined ||
    (Array.isArray(value.directories) &&
      value.directories.every(
        (entry) =>
          isStringRecord(entry) &&
          hasExactKeys(entry, ["relativePath", "modifiedAt"]) &&
          typeof entry.relativePath === "string" &&
          typeof entry.modifiedAt === "string",
      ));
  const diagnosticsValid =
    value.diagnostics === undefined ||
    (Array.isArray(value.diagnostics) &&
      value.diagnostics.every(
        (entry) =>
          isStringRecord(entry) &&
          hasExactKeys(entry, ["relativePath", "kind"]) &&
          typeof entry.relativePath === "string" &&
          [
            "symbolic-link-not-followed",
            "directory-link-not-allowed",
            "link-target-outside-authorized-roots",
            "broken-symbolic-link",
            "inaccessible-symbolic-link",
            "symbolic-link-cycle",
            "repeated-directory-target",
            "entry-missing",
            "entry-inaccessible",
            "entry-identity-changed",
          ].includes(entry.kind as string),
      ));
  return filesValid && excludedValid && directoriesValid && diagnosticsValid;
}

function isStrictBlob(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    hasExactKeys(value, ["digest", "mediaType", "byteLength"]) &&
    isNonEmptyString(value.digest) &&
    isNonEmptyString(value.mediaType) &&
    Number.isSafeInteger(value.byteLength) &&
    (value.byteLength as number) >= 0
  );
}

function isStrictRecognitionEvidence(value: unknown): boolean {
  if (
    !isStringRecord(value) ||
    !hasExactKeys(
      value,
      ["kind", "explanation", "producer"],
      ["sourceIdentity", "sourceAddress", "inspection"],
    ) ||
    !isNonEmptyString(value.kind) ||
    !isNonEmptyString(value.explanation) ||
    !isStrictCapabilityCoordinate(value.producer) ||
    (value.sourceIdentity !== undefined &&
      !isNonEmptyString(value.sourceIdentity)) ||
    (value.sourceAddress !== undefined &&
      !isNonEmptyString(value.sourceAddress)) ||
    (value.sourceIdentity === undefined) !== (value.sourceAddress === undefined)
  )
    return false;
  if (value.inspection === undefined) return true;
  const inspection = value.inspection;
  return (
    isStringRecord(inspection) &&
    hasExactKeys(
      inspection,
      [
        "identifiers",
        "observedArtifactReference",
        "revision",
        "metadata",
        "parts",
      ],
      ["entityGraph"],
    ) &&
    isStrictInspectionEntityGraph(inspection.entityGraph) &&
    isNonEmptyString(inspection.observedArtifactReference) &&
    isStrictBlob(inspection.revision) &&
    Array.isArray(inspection.identifiers) &&
    inspection.identifiers.every(
      (identifier) =>
        isStringRecord(identifier) &&
        hasExactKeys(identifier, ["scheme", "value", "locators"]) &&
        isNonEmptyString(identifier.scheme) &&
        isNonEmptyString(identifier.value) &&
        Array.isArray(identifier.locators) &&
        identifier.locators.length > 0 &&
        identifier.locators.every(isNonEmptyString) &&
        new Set(identifier.locators).size === identifier.locators.length,
    ) &&
    Array.isArray(inspection.metadata) &&
    inspection.metadata.every(
      (metadata) =>
        isStringRecord(metadata) &&
        hasExactKeys(metadata, [
          "property",
          "sourceSlot",
          "value",
          "locator",
        ]) &&
        [
          metadata.property,
          metadata.sourceSlot,
          metadata.value,
          metadata.locator,
        ].every(isNonEmptyString),
    ) &&
    Array.isArray(inspection.parts) &&
    inspection.parts.every(
      (part) =>
        isStringRecord(part) &&
        hasExactKeys(part, ["role", "locator", "mediaType"]) &&
        [part.role, part.locator, part.mediaType].every(isNonEmptyString),
    )
  );
}

/** 观察实体图的结构由领域唯一权威判定，readiness 只确认它仍然自洽。 */
function isStrictInspectionEntityGraph(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isStringRecord(value)) return false;
  try {
    validateObservedEntityGraphCandidates([
      value as unknown as ObservedEntityGraphCandidate,
    ]);
    return true;
  } catch {
    return false;
  }
}

function hasStrictObservedMaterialSubmissionShape(value: unknown): boolean {
  if (!isStringRecord(value)) return false;
  const arrayKeys = [
    "artifacts",
    "locations",
    "blobs",
    "artifactRevisions",
    "artifactAssociations",
    "projections",
    "supports",
  ] as const;
  if (
    !hasExactKeys(value, ["proposal", "recognitionDecision", ...arrayKeys]) ||
    arrayKeys.some((key) => !Array.isArray(value[key]))
  )
    return false;
  if (
    !isStringRecord(value.proposal) ||
    !hasExactKeys(value.proposal, [
      "id",
      "boundaries",
      "basis",
      "ruleResults",
      "observedArtifactAssociations",
      "observedArtifactRevisions",
    ]) ||
    !isStringRecord(value.proposal.basis) ||
    !hasExactKeys(value.proposal.basis, [
      "kind",
      "proposedBy",
      "observationSnapshotId",
      "materialReferences",
      "revisesProposalIds",
      "metadata",
      "evidence",
    ]) ||
    !isStringRecord(value.recognitionDecision) ||
    !hasExactKeys(value.recognitionDecision, [
      "id",
      "boundaries",
      "proposalId",
      "assetId",
      "acceptedRuleResults",
    ])
  )
    return false;
  const proposal = value.proposal;
  const basis = proposal.basis as Record<string, unknown>;
  if (
    !isNonEmptyString(proposal.id) ||
    !isNonEmptyString(basis.proposedBy) ||
    !isNonEmptyString(basis.observationSnapshotId) ||
    basis.kind !== "manual-boundary" ||
    !Array.isArray(basis.materialReferences) ||
    !Array.isArray(basis.revisesProposalIds) ||
    !Array.isArray(basis.metadata) ||
    !Array.isArray(basis.evidence) ||
    !Array.isArray(proposal.ruleResults) ||
    !Array.isArray(proposal.observedArtifactAssociations) ||
    !Array.isArray(proposal.observedArtifactRevisions) ||
    !basis.materialReferences.every(isNonEmptyString) ||
    new Set(basis.materialReferences).size !==
      basis.materialReferences.length ||
    !basis.revisesProposalIds.every(isNonEmptyString) ||
    new Set(basis.revisesProposalIds).size !==
      basis.revisesProposalIds.length ||
    !basis.metadata.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["property", "value"]) &&
        isNonEmptyString(item.property) &&
        typeof item.value === "string",
    ) ||
    !basis.evidence.every(isStrictRecognitionEvidence) ||
    !proposal.observedArtifactAssociations.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(
          item,
          ["observedArtifactReference", "role"],
          ["producer"],
        ) &&
        isNonEmptyString(item.observedArtifactReference) &&
        isNonEmptyString(item.role) &&
        (item.producer === undefined ||
          isStrictCapabilityCoordinate(item.producer)),
    ) ||
    !proposal.observedArtifactRevisions.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["observedArtifactReference", "blob", "producer"]) &&
        isNonEmptyString(item.observedArtifactReference) &&
        isStringRecord(item.blob) &&
        hasExactKeys(item.blob, ["digest", "mediaType", "byteLength"]) &&
        isNonEmptyString(item.blob.digest) &&
        isNonEmptyString(item.blob.mediaType) &&
        Number.isSafeInteger(item.blob.byteLength) &&
        (item.blob.byteLength as number) >= 0 &&
        isStrictCapabilityCoordinate(item.producer),
    )
  )
    return false;
  const exactArray = (key: (typeof arrayKeys)[number], keys: string[]) =>
    (value[key] as unknown[]).every(
      (item) => isStringRecord(item) && hasExactKeys(item, keys),
    );
  return (
    exactArray("artifacts", ["id"]) &&
    (value.artifacts as Record<string, unknown>[]).every((item) =>
      isNonEmptyString(item.id),
    ) &&
    exactArray("locations", ["id", "artifactId", "address", "kind"]) &&
    (value.locations as Record<string, unknown>[]).every(
      (item) =>
        [item.id, item.artifactId, item.address].every(isNonEmptyString) &&
        (item.kind === "observed" || item.kind === "managed"),
    ) &&
    exactArray("blobs", ["digest", "mediaType", "byteLength"]) &&
    (value.blobs as Record<string, unknown>[]).every(
      (item) =>
        isNonEmptyString(item.digest) &&
        isNonEmptyString(item.mediaType) &&
        Number.isSafeInteger(item.byteLength) &&
        (item.byteLength as number) >= 0,
    ) &&
    (value.artifactRevisions as unknown[]).every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["id", "artifactId", "blobDigest"], ["producer"]) &&
        [item.id, item.artifactId, item.blobDigest].every(isNonEmptyString) &&
        (item.producer === undefined ||
          isStrictCapabilityCoordinate(item.producer)),
    ) &&
    (value.artifactAssociations as unknown[]).every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(
          item,
          ["id", "target", "artifactId", "role"],
          [
            "sourceRecordIds",
            "sourceAssociationId",
            "producer",
            "observedArtifactPart",
          ],
        ) &&
        [item.id, item.artifactId, item.role].every(isNonEmptyString) &&
        isStringRecord(item.target) &&
        hasExactKeys(item.target, ["kind", "entityId"]) &&
        item.target.kind === "entity" &&
        isNonEmptyString(item.target.entityId) &&
        (item.sourceRecordIds === undefined ||
          (Array.isArray(item.sourceRecordIds) &&
            item.sourceRecordIds.every(isNonEmptyString) &&
            new Set(item.sourceRecordIds).size ===
              item.sourceRecordIds.length)) &&
        (item.sourceAssociationId === undefined ||
          isNonEmptyString(item.sourceAssociationId)) &&
        (item.producer === undefined ||
          isStrictCapabilityCoordinate(item.producer)) &&
        (item.observedArtifactPart === undefined ||
          (isStringRecord(item.observedArtifactPart) &&
            hasExactKeys(item.observedArtifactPart, [
              "artifactId",
              "revisionId",
              "locator",
            ]) &&
            [
              item.observedArtifactPart.artifactId,
              item.observedArtifactPart.revisionId,
              item.observedArtifactPart.locator,
            ].every(isNonEmptyString))),
    ) &&
    exactArray("projections", [
      "observedArtifactReference",
      "artifactId",
      "locationId",
      "revisionId",
      "associationId",
    ]) &&
    (value.projections as Record<string, unknown>[]).every((item) =>
      Object.values(item).every(isNonEmptyString),
    ) &&
    exactArray("supports", ["associationId", "recognitionDecisionId"]) &&
    (value.supports as Record<string, unknown>[]).every((item) =>
      [item.associationId, item.recognitionDecisionId].every(isNonEmptyString),
    ) &&
    [
      value.recognitionDecision.id,
      value.recognitionDecision.proposalId,
      value.recognitionDecision.assetId,
    ].every(isNonEmptyString) &&
    Array.isArray(value.recognitionDecision.acceptedRuleResults) &&
    arrayKeys.every((key) => {
      const entries = value[key] as Record<string, unknown>[];
      const identities = entries.map((item) =>
        key === "blobs"
          ? item.digest
          : key === "supports"
            ? `${String(item.associationId)}\0${String(item.recognitionDecisionId)}`
            : key === "projections"
              ? item.observedArtifactReference
              : item.id,
      );
      return new Set(identities).size === identities.length;
    })
  );
}

export function decodeObservedMaterialAssociationCheckpoint(value: unknown):
  | {
      readonly valid: true;
      readonly checkpoint: ObservedMaterialAssociationCheckpoint;
    }
  | { readonly valid: false; readonly reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { valid: false, reason: "观察材料关联检查点必须是对象" };
  const checkpoint = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "state",
    "input",
    "registrationDisplayName",
    "snapshot",
    "identityBaseline",
    "materialBaseline",
    "submission",
    "confirmedBy",
    "associationIds",
    "decisionId",
  ]);
  const states = new Set([
    "created",
    "observing",
    "inspecting",
    "awaiting-confirmation",
    "confirmation-recorded",
    "revalidating",
    "accepted",
    "no-change",
    "stale",
    "failed",
    "interrupted",
  ]);
  if (
    checkpoint.version !== "observed-material-association-checkpoint/1" ||
    Object.keys(checkpoint).some((key) => !allowed.has(key)) ||
    !states.has(checkpoint.state as string) ||
    typeof checkpoint.input !== "object" ||
    checkpoint.input === null ||
    Array.isArray(checkpoint.input)
  )
    return { valid: false, reason: "观察材料关联检查点版本或字段无效" };
  const input = checkpoint.input as Record<string, unknown>;
  const inputAllowed = new Set([
    "targetAssetId",
    "registrationId",
    "registrationVersion",
    "relativeScope",
    "relativePaths",
    "initiatedBy",
  ]);
  if (
    Object.keys(input).some((key) => !inputAllowed.has(key)) ||
    typeof input.targetAssetId !== "string" ||
    input.targetAssetId.length === 0 ||
    typeof input.registrationId !== "string" ||
    input.registrationId.length === 0 ||
    (input.registrationVersion !== undefined &&
      (!Number.isSafeInteger(input.registrationVersion) ||
        (input.registrationVersion as number) < 1)) ||
    typeof input.relativeScope !== "string" ||
    !Array.isArray(input.relativePaths) ||
    input.relativePaths.length === 0 ||
    input.relativePaths.some(
      (item) => typeof item !== "string" || item.length === 0,
    ) ||
    new Set(input.relativePaths).size !== input.relativePaths.length ||
    typeof input.initiatedBy !== "string" ||
    input.initiatedBy.trim().length === 0
  )
    return { valid: false, reason: "观察材料关联检查点输入无效" };
  const state =
    checkpoint.state as ObservedMaterialAssociationCheckpoint["state"];
  const afterObservation = [
    "inspecting",
    "awaiting-confirmation",
    "confirmation-recorded",
    "revalidating",
    "accepted",
    "no-change",
  ].includes(state);
  const afterSnapshot = [
    "inspecting",
    "awaiting-confirmation",
    "confirmation-recorded",
    "revalidating",
    "accepted",
    "no-change",
  ].includes(state);
  const afterInspection = [
    "awaiting-confirmation",
    "confirmation-recorded",
    "revalidating",
    "accepted",
    "no-change",
  ].includes(state);
  const afterConfirmation = [
    "confirmation-recorded",
    "revalidating",
    "accepted",
    "no-change",
  ].includes(state);
  if (
    (afterObservation &&
      (input.registrationVersion === undefined ||
        typeof checkpoint.identityBaseline !== "string" ||
        typeof checkpoint.materialBaseline !== "string")) ||
    (afterSnapshot &&
      !isStrictFilesystemPackageSnapshot(checkpoint.snapshot)) ||
    (afterInspection &&
      (typeof checkpoint.submission !== "object" ||
        checkpoint.submission === null)) ||
    (afterConfirmation &&
      (typeof checkpoint.confirmedBy !== "string" ||
        checkpoint.confirmedBy.length === 0 ||
        typeof checkpoint.decisionId !== "string" ||
        !Array.isArray(checkpoint.associationIds)))
  )
    return { valid: false, reason: "观察材料关联检查点缺少状态所需字段" };
  if (
    (checkpoint.snapshot !== undefined &&
      !isStrictFilesystemPackageSnapshot(checkpoint.snapshot)) ||
    (checkpoint.registrationDisplayName !== undefined &&
      typeof checkpoint.registrationDisplayName !== "string") ||
    (checkpoint.identityBaseline !== undefined &&
      !isNonEmptyString(checkpoint.identityBaseline)) ||
    (checkpoint.materialBaseline !== undefined &&
      !isNonEmptyString(checkpoint.materialBaseline)) ||
    (checkpoint.confirmedBy !== undefined &&
      !isNonEmptyString(checkpoint.confirmedBy)) ||
    (checkpoint.decisionId !== undefined &&
      !isNonEmptyString(checkpoint.decisionId)) ||
    (checkpoint.associationIds !== undefined &&
      (!Array.isArray(checkpoint.associationIds) ||
        !checkpoint.associationIds.every(isNonEmptyString) ||
        new Set(checkpoint.associationIds).size !==
          checkpoint.associationIds.length))
  )
    return { valid: false, reason: "观察材料关联检查点可选字段无效" };
  if (checkpoint.submission !== undefined) {
    try {
      if (!hasStrictObservedMaterialSubmissionShape(checkpoint.submission))
        throw new Error("invalid durable submission shape");
      validateObservedMaterialAssociationSubmission(
        checkpoint.submission as ObservedMaterialAssociationSubmission,
      );
    } catch {
      return { valid: false, reason: "观察材料关联检查点领域批次无效" };
    }
  }
  if (afterInspection) {
    const snapshot = checkpoint.snapshot as FilesystemPackageSnapshot;
    const submission =
      checkpoint.submission as ObservedMaterialAssociationSubmission;
    const inputReferences = [...(input.relativePaths as string[])].toSorted();
    const snapshotReferences = snapshot.files
      .map((file) => file.relativePath)
      .toSorted();
    const projectionReferences = submission.projections
      .map((projection) => projection.observedArtifactReference)
      .toSorted();
    if (
      !snapshot.complete ||
      new Set(snapshotReferences).size !== snapshotReferences.length ||
      JSON.stringify(inputReferences) !== JSON.stringify(snapshotReferences) ||
      JSON.stringify(inputReferences) !==
        JSON.stringify(projectionReferences) ||
      submission.proposal.basis.kind !== "manual-boundary" ||
      submission.proposal.basis.observationSnapshotId !== snapshot.id ||
      submission.recognitionDecision.assetId !== input.targetAssetId
    )
      return { valid: false, reason: "观察材料关联检查点内部引用不一致" };
    for (const projection of submission.projections) {
      const location = submission.locations.find(
        (item) => item.id === projection.locationId,
      );
      const revision = submission.artifactRevisions.find(
        (item) => item.id === projection.revisionId,
      );
      const candidate = submission.proposal.observedArtifactRevisions?.find(
        (item) =>
          item.observedArtifactReference ===
          projection.observedArtifactReference,
      );
      if (
        location?.kind !== "observed" ||
        location.artifactId !== projection.artifactId ||
        location.address !==
          `${snapshot.root}/${projection.observedArtifactReference}` ||
        revision?.artifactId !== projection.artifactId ||
        candidate === undefined ||
        revision.blobDigest !== candidate.blob.digest ||
        !submission.blobs.some(
          (blob) =>
            blob.digest === revision.blobDigest &&
            blob.mediaType === candidate.blob.mediaType &&
            blob.byteLength === candidate.blob.byteLength,
        )
      )
        return { valid: false, reason: "观察材料关联检查点材料投影不一致" };
    }
  }
  if (afterConfirmation) {
    const submission =
      checkpoint.submission as ObservedMaterialAssociationSubmission;
    const associationIds = checkpoint.associationIds as unknown[];
    const expectedAssociationIds = [
      ...new Set(
        submission.artifactAssociations.map((association) => association.id),
      ),
    ].toSorted((left, right) => left.localeCompare(right));
    if (
      associationIds.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(associationIds).size !== associationIds.length ||
      checkpoint.decisionId !== submission.recognitionDecision.id ||
      JSON.stringify(
        [...associationIds].toSorted((left, right) =>
          String(left).localeCompare(String(right)),
        ),
      ) !== JSON.stringify(expectedAssociationIds)
    )
      return { valid: false, reason: "观察材料关联确认引用不一致" };
  }
  return {
    valid: true,
    checkpoint: checkpoint as unknown as ObservedMaterialAssociationCheckpoint,
  };
}

export type ObservedMaterialAssociationInspection = {
  readonly executionId: string;
  readonly status: ObservedMaterialAssociationCheckpoint["state"];
  readonly failure?:
    | "invalid-target"
    | "authority-stale"
    | "material-stale"
    | "unavailable"
    | "interrupted";
  readonly reason?: string;
  readonly target: { readonly id: string; readonly title?: string };
  readonly observedRoot: {
    readonly id: string;
    readonly displayName?: string;
    readonly relativeScope: string;
  };
  readonly files: readonly {
    readonly relativePath: string;
    readonly byteLength: number;
    readonly digest: string;
    readonly mediaType: string;
    readonly disposition: "new-artifact" | "existing-artifact";
    readonly formatValid: boolean;
  }[];
  readonly proposal: {
    readonly id: string;
    readonly proposedBy: string;
    readonly materials: readonly {
      readonly relativePath: string;
      readonly role: "asset.material-delivered";
    }[];
  };
  readonly confirmedBy?: string;
  readonly decisionId?: string;
  readonly associationIds?: readonly string[];
};

export type ObservedMaterialAssociationPersistence = {
  freezeObservedMaterialAssociationTarget(assetId: string): Promise<{
    readonly identityBaseline: string;
    readonly materialBaseline: string;
  }>;
  commitObservedMaterialAssociation(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly terminalExecutions: {
      readonly accepted: WorkflowExecution;
      readonly noChange: WorkflowExecution;
      readonly stale: WorkflowExecution;
    };
    readonly expectedIdentityBaseline: string;
    readonly expectedMaterialBaseline: string;
    readonly observedAuthority: {
      readonly registrationId: string;
      readonly registrationVersion: number;
    };
    readonly submission: ObservedMaterialAssociationSubmission;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<"accepted" | "no-change" | "stale">;
  auditObservedMaterialAssociations(
    projections: readonly ObservedMaterialAssociationProjection[],
  ): Promise<readonly ObservedMaterialAssociationAudit[]>;
};

/** 对交付层安全的当前来源产物候选；获取引用和能力私有坐标永不公开。 */
export type PublicSourceArtifactCandidate = Pick<
  SourceArtifactCandidate,
  "sourceRecordId" | "role" | "mediaType" | "selectionEvidence"
>;

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
    | "sourceAssociationDecision"
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
  readonly sourceEnrichments?: readonly {
    readonly subjectId: string;
    readonly sourceIdentity: string;
    readonly sourceAddress: string;
    readonly input?: Readonly<Record<string, string>>;
    readonly status: "running" | "failed" | "completed";
    readonly reason?: string;
    readonly canRetry: boolean;
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
    | "proposal"
    | "recognitionDecision"
    | "sourceAssociations"
    | "recognitionSourceAssociation"
    | "entities"
  > & {
    readonly facts: EffectiveSubjectRead;
    readonly sourceAssociations: readonly {
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
    }[];
    readonly recognitionSourceAssociation?: {
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
    };
    readonly sourceArtifactCandidates?: readonly PublicSourceArtifactCandidate[];
    readonly currentLocationRevisions?: readonly CurrentLocationRevisionSelection[];
    readonly primaryCoverArtifactId?: string;
    /** 当前相关实体的种类由种类断言、来源支持与决定共同投影。 */
    readonly currentRelatedEntities?: readonly import("@digital/domain").CurrentRelatedEntity[];
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
  readonly relationshipDefinitions?: readonly RelationshipTypeDefinition[];
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
  readonly materialBoundary?: PlannedMaterialBoundary;
  readonly boundaries?: readonly RecognitionMaterialBoundary[];
  readonly boundaryBaseline?: readonly string[];
  readonly retainedAssetId?: string;
  readonly retainedDecisionId?: string;
  readonly reuseAcceptedBoundary?: boolean;
  readonly boundaryConflict?: string;
  readonly observedArtifactAssociations?: readonly ObservedArtifactAssociationCandidate[];
  /** 通用打包指令；作出决策的外层能力持有其语法。 */
  readonly observedArtifactBoundary?: "filesystem-package";
  /** Application 附加的已部署技术解释器来源信息。 */
  readonly observedArtifactBoundaryProducer?: CapabilityCoordinate;
  /**
   * 声明该候选自身内容身份的能力坐标；只有能力自己才能设置。范围覆盖不足以吸收它，
   * Application 绝不解释其来源语法，也只凭这一坐标停止吞并。
   */
  readonly independentIdentityDeclaredBy?: CapabilityCoordinate;
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
  readonly failureCode?: string;
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
  readonly relationshipDefinitions?: readonly RelationshipTypeDefinition[];
  canInterpret(input: {
    readonly evidence: readonly import("@digital/domain").RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): boolean;
  interpret(input: {
    readonly evidence: readonly import("@digital/domain").RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): readonly SourceInterpretationBatch[];
};

export type Recognizer = {
  readonly capability: CapabilityCoordinate;
  canRecognize(input: RecognitionCandidateContext): boolean;
  recognize(input: RecognitionCandidateContext): RecognitionProposalDraft;
};

export type RecognitionCandidateContext =
  | {
      readonly basis: {
        readonly kind: "source-interpretation";
        readonly interpretation: SourceInterpretationBatch;
      };
      readonly evidence: readonly RecognitionEvidence[];
    }
  | {
      readonly basis: {
        readonly kind: "observed-evidence";
        readonly producer: CapabilityCoordinate;
        readonly materialBoundary?: PlannedMaterialBoundary;
        readonly artifactRevisions: readonly import("@digital/domain").ObservedArtifactRevisionCandidate[];
      };
      readonly evidence: readonly RecognitionEvidence[];
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
  relationshipDefinitions: readonly RelationshipTypeDefinition[] = [],
): RecognitionEvidence {
  validateDeclaredRelationships(
    relationshipDefinitions,
    evidence.inspection?.entityGraph?.relationships ?? [],
  );
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
  relationshipDefinitions?: readonly RelationshipTypeDefinition[],
): readonly RecognitionEvidence[];
function bindRecognitionEvidenceOutputToProducer(
  output: AssetRefreshWorkPlan,
  producer: CapabilityCoordinate,
  relationshipDefinitions?: readonly RelationshipTypeDefinition[],
): AssetRefreshWorkPlan;
function bindRecognitionEvidenceOutputToProducer(
  output: readonly RecognitionEvidence[] | AssetRefreshWorkPlan,
  producer: CapabilityCoordinate,
  relationshipDefinitions?: readonly RelationshipTypeDefinition[],
): readonly RecognitionEvidence[] | AssetRefreshWorkPlan;
function bindRecognitionEvidenceOutputToProducer(
  output: readonly RecognitionEvidence[] | AssetRefreshWorkPlan,
  producer: CapabilityCoordinate,
  relationshipDefinitions: readonly RelationshipTypeDefinition[] = [],
): readonly RecognitionEvidence[] | AssetRefreshWorkPlan {
  if (!isAssetRefreshWorkPlan(output)) {
    return output.map((evidence) =>
      bindRecognitionEvidenceToProducer(
        evidence,
        producer,
        relationshipDefinitions,
      ),
    );
  }
  return {
    ...output,
    workItems: output.workItems.map((item) => ({
      ...item,
      ...(item.observedArtifactAssociations === undefined
        ? {}
        : {
            observedArtifactAssociations: item.observedArtifactAssociations.map(
              (candidate) => ({
                ...candidate,
                producer: actualProducer(
                  candidate.producer,
                  producer,
                  "Observed artifact role declaration",
                ),
              }),
            ),
          }),
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
        bindRecognitionEvidenceToProducer(
          evidence,
          producer,
          relationshipDefinitions,
        ),
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
    failures: collection.failures.map((failure) =>
      safeSourceCollectionFailure(collector, failure),
    ),
  };
}

function safeSourceCollectionFailure(
  collector: Pick<SourceCollector, "capability">,
  value: unknown,
): SourceCollectionFailure {
  const failure =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const topLevelSafe =
    failure !== undefined &&
    Object.keys(failure).every((key) =>
      [
        "capability",
        "reason",
        "failureCode",
        "failureClassification",
        "coverage",
        "affects",
      ].includes(key),
    );
  const declaredCapability = failure?.capability;
  const capabilitySafe = isCapabilityCoordinate(declaredCapability);
  const capabilityCodeSafe =
    capabilitySafe && isCompleteSourceFailureCapability(declaredCapability);
  const capability = capabilitySafe
    ? actualProducer(
        declaredCapability,
        collector.capability,
        "Source Collection Failure",
      )
    : collector.capability;
  const classification = safeOperationalFailureClassification(
    failure?.failureClassification,
  );
  const coverage = safeSourceCoverage(failure?.coverage);
  const affects = safeSourceFailureAffects(failure?.affects);
  const optionalShapesSafe =
    (failure?.failureClassification === undefined ||
      classification !== undefined) &&
    (failure?.coverage === undefined || coverage !== undefined) &&
    (failure?.affects === undefined || affects !== undefined);
  const canRetainCode =
    topLevelSafe &&
    capabilityCodeSafe &&
    typeof failure?.reason === "string" &&
    optionalShapesSafe;
  return {
    capability,
    reason:
      typeof failure?.reason === "string"
        ? failure.reason
        : "Source collection failed",
    ...(canRetainCode && typeof failure?.failureCode === "string"
      ? { failureCode: failure.failureCode }
      : {}),
    ...(classification === undefined
      ? {}
      : { failureClassification: classification }),
    ...(coverage === undefined ? {} : { coverage }),
    ...(affects === undefined ? {} : { affects }),
  };
}

function safeOperationalFailureClassification(
  value: unknown,
): OperationalFailureClassification | undefined {
  return hasOnlyKeys(value, ["kind"]) &&
    (value as Record<string, unknown>).kind === "prerequisite-unavailable"
    ? prerequisiteUnavailableFailure
    : undefined;
}

function safeSourceCoverage(value: unknown): SourceCoverageScope | undefined {
  if (!hasOnlyKeys(value, ["sourceIdentity", "nativeAddress", "coverageId"]))
    return undefined;
  const coverage = value as Record<string, unknown>;
  return typeof coverage.sourceIdentity === "string" &&
    typeof coverage.nativeAddress === "string" &&
    typeof coverage.coverageId === "string"
    ? {
        sourceIdentity: coverage.sourceIdentity,
        nativeAddress: coverage.nativeAddress,
        coverageId: coverage.coverageId,
      }
    : undefined;
}

function safeSourceFailureAffects(
  value: unknown,
): SourceCollectionFailure["affects"] | undefined {
  if (
    !hasOnlyKeys(value, [
      "recognition",
      "metadataProperties",
      "artifactRoles",
      "relationshipTypes",
    ])
  )
    return undefined;
  const affects = value as Record<string, unknown>;
  const stringArray = (candidate: unknown): candidate is readonly string[] =>
    Array.isArray(candidate) &&
    candidate.every((item) => typeof item === "string");
  if (
    (affects.recognition !== undefined &&
      typeof affects.recognition !== "boolean") ||
    (affects.metadataProperties !== undefined &&
      !stringArray(affects.metadataProperties)) ||
    (affects.artifactRoles !== undefined &&
      !stringArray(affects.artifactRoles)) ||
    (affects.relationshipTypes !== undefined &&
      !stringArray(affects.relationshipTypes))
  )
    return undefined;
  return {
    ...(affects.recognition === undefined
      ? {}
      : { recognition: affects.recognition }),
    ...(affects.metadataProperties === undefined
      ? {}
      : {
          metadataProperties: affects.metadataProperties,
        }),
    ...(affects.artifactRoles === undefined
      ? {}
      : { artifactRoles: affects.artifactRoles }),
    ...(affects.relationshipTypes === undefined
      ? {}
      : { relationshipTypes: affects.relationshipTypes }),
  };
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
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
 * 将一次已保留采集的解释结果收拢为可独立消费的来源主体。这里是来源解释端口的
 * 基数接缝：适配器只负责形成批次，Application 负责把真实生产者、保留记录和批次
 * 独立性绑定起来；调用者不必各自重做这些校验。
 */
async function interpretRetainedSourceRecords(input: {
  readonly interpreters: readonly SourceInterpreter[];
  readonly evidence: readonly RecognitionEvidence[];
  readonly sourceRecords: readonly SourceRecord[];
  readonly beforeInterpret: (
    capability: CapabilityCoordinate,
  ) => void | Promise<void>;
}): Promise<readonly SourceInterpretationBatch[]> {
  const retainedRecords = new Map(
    input.sourceRecords.map((record) => [record.id, record]),
  );
  const interpretations: SourceInterpretationBatch[] = [];
  for (const interpreter of input.interpreters) {
    if (!interpreter.canInterpret(input)) continue;
    await input.beforeInterpret(interpreter.capability);
    const addresses = new Set<string>();
    for (const raw of interpreter.interpret(input)) {
      validateDeclaredRelationships(
        interpreter.relationshipDefinitions ?? [],
        raw.relationships ?? [],
      );
      const interpretation = retainInterpretationProvenance(interpreter, raw);
      validateSourceInterpretationBatch(interpretation);
      if (
        interpretation.sourceRecordIds.some(
          (sourceRecordId) => !retainedRecords.has(sourceRecordId),
        )
      )
        throw new Error("来源解释引用了本次未保留的 Source Record");
      const productRecord = interpretation.sourceRecordIds
        .map((sourceRecordId) => retainedRecords.get(sourceRecordId))
        .find(
          (record) =>
            record?.sourceIdentity === interpretation.sourceIdentity &&
            record.nativeAddress === interpretation.sourceAddress,
        );
      if (productRecord === undefined)
        throw new Error("来源解释必须引用本次已保留的同来源同地址产品记录");
      const addressKey = `${interpretation.sourceIdentity}\u0000${interpretation.sourceAddress}`;
      if (addresses.has(addressKey))
        throw new Error("同一来源解释器不得重复解释同一来源地址");
      addresses.add(addressKey);
      interpretations.push(interpretation);
    }
  }
  return interpretations;
}

function sourceAssociationInterpreterFor(input: {
  readonly interpreters: readonly SourceAssociationInterpreter[];
  readonly evidence: RecognitionEvidence;
  readonly interpretation: SourceInterpretationBatch;
}): SourceAssociationInterpreter | undefined {
  const applicable = input.interpreters.filter((candidate) =>
    candidate.canInterpret({
      evidence: input.evidence,
      interpretation: input.interpretation,
    }),
  );
  if (applicable.length > 1)
    throw new Error("一个来源解释只能由一个来源关联解释能力判定");
  return applicable[0];
}

/**
 * 识别器只有很小的草稿界面。工作流在调用前对绑定输入取快照并冻结，随后从这些输入
 * 重建完整提议。这可以防止受信规则把自己伪装成来源解释器或产物格式检查器。
 */
function frozenRecognitionInput(
  input: RecognitionCandidateContext,
): RecognitionCandidateContext {
  return freezeRecognitionInput(structuredClone(input));
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
  input: RecognitionCandidateContext,
  boundaries: readonly RecognitionMaterialBoundary[] = [],
): RecognitionProposal {
  const allowed = new Set(["id", "ruleResults"]);
  if (Object.keys(draft).some((key) => !allowed.has(key)))
    throw new Error("Recognizer proposal draft contains unauthorized fields");
  if (!Array.isArray((draft as { readonly ruleResults?: unknown }).ruleResults))
    throw new Error(
      "Recognizer proposal draft requires Recognition Rule Results",
    );
  const ruleResults = draft.ruleResults.map((result) => {
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
  });
  const basis: RecognitionBasis =
    input.basis.kind === "source-interpretation"
      ? input.basis
      : {
          kind: "observed-evidence",
          producer: input.basis.producer,
          evidence: [
            ...new Set(ruleResults.flatMap((result) => result.evidence)),
          ],
          artifactRevisions: input.basis.artifactRevisions.filter((revision) =>
            ruleResults.some((result) =>
              result.evidence.some(
                (evidence) =>
                  evidence.inspection?.observedArtifactReference ===
                  revision.observedArtifactReference,
              ),
            ),
          ),
        };
  return {
    id: draft.id,
    boundaries,
    basis,
    ruleResults,
  };
}

function recognitionCandidateContexts(input: {
  readonly evidence: readonly RecognitionEvidence[];
  readonly interpretations: readonly SourceInterpretationBatch[];
  readonly materialBoundary?: PlannedMaterialBoundary;
}): readonly RecognitionCandidateContext[] {
  const sourced: RecognitionCandidateContext[] = input.interpretations.map(
    (interpretation) => ({
      basis: { kind: "source-interpretation", interpretation },
      evidence: input.evidence,
    }),
  );
  // 定向来源由明确操作持有，本地规则不能改写这次操作的目的。
  if (
    input.evidence.some(
      (evidence) => evidence.kind === "directed-source-address",
    )
  )
    return sourced;
  const directoryProducers = new Map(
    input.evidence
      .filter((evidence) => evidence.producer.kind === "directory-interpreter")
      .map((evidence) => [
        JSON.stringify(evidence.producer),
        evidence.producer,
      ]),
  );
  if (directoryProducers.size > 0) {
    const inspected = input.evidence.filter(
      (evidence) => evidence.inspection !== undefined,
    );
    return [
      ...sourced,
      ...[...directoryProducers].map(
        ([coordinate, producer]): RecognitionCandidateContext => ({
          basis: {
            kind: "observed-evidence",
            producer,
            ...(input.materialBoundary === undefined
              ? {}
              : { materialBoundary: input.materialBoundary }),
            artifactRevisions: inspected.map((evidence) => ({
              observedArtifactReference:
                evidence.inspection!.observedArtifactReference,
              blob: evidence.inspection!.revision,
              producer: evidence.producer,
            })),
          },
          evidence: input.evidence.filter(
            (evidence) =>
              evidence.inspection !== undefined ||
              JSON.stringify(evidence.producer) === coordinate,
          ),
        }),
      ),
    ];
  }
  const observed = new Map<
    string,
    {
      producer: CapabilityCoordinate;
      evidence: RecognitionEvidence[];
      revisions: import("@digital/domain").ObservedArtifactRevisionCandidate[];
    }
  >();
  for (const evidence of input.evidence) {
    const inspection = evidence.inspection;
    if (inspection === undefined) continue;
    const key = JSON.stringify(evidence.producer);
    const group = observed.get(key) ?? {
      producer: evidence.producer,
      evidence: [],
      revisions: [],
    };
    group.evidence.push(evidence);
    group.revisions.push({
      observedArtifactReference: inspection.observedArtifactReference,
      blob: inspection.revision,
      producer: evidence.producer,
    });
    observed.set(key, group);
  }
  return [
    ...sourced,
    ...[...observed.values()].map(
      ({ producer, evidence, revisions }): RecognitionCandidateContext => ({
        basis: {
          kind: "observed-evidence",
          producer,
          artifactRevisions: revisions,
        },
        evidence,
      }),
    ),
  ];
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
  commitSourceRefreshCollectionFailure(
    input: CommitSourceRefreshCollectionFailureInput,
  ): Promise<{
    readonly execution: WorkflowExecution;
    readonly run: SourceRefreshRun;
  }>;
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
  finishExecutionWithSourceAssociationPreview(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly preview: ChangeImpactPreview;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  finishExecutionWithRecognitionRetractionPreview(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly preview: ChangeImpactPreview;
  }): Promise<void>;
  acceptRecognition(input: {
    /** 调用方准备接受前观察到的完整运行中审计。 */
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly accepted: AcceptedRecognition;
    /** 本次接受建立的精确材料映射；与领域事实在同一事务原子写入。 */
    readonly observedMaterialAcceptances?:
      | readonly ObservedMaterialAcceptanceBinding[]
      | undefined;
    /** 首次人工整理的并发基线；不是材料只能服务一个资产的领域约束。 */
    readonly expectedUnassignedMaterials?: readonly Pick<
      Location,
      "artifactId" | "address"
    >[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  freezeObservedMaterialAssociationTarget: ObservedMaterialAssociationPersistence["freezeObservedMaterialAssociationTarget"];
  commitObservedMaterialAssociation: ObservedMaterialAssociationPersistence["commitObservedMaterialAssociation"];
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
  listEffectiveMaterialBoundaries(input: {
    readonly scope: ObservedRootSnapshot;
    readonly relativeScope: string;
  }): Promise<readonly EffectiveRecognitionMaterialBoundary[]>;
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
  findCurrentSourceAssociationByCoordinate(input: {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  }): Promise<SourceAssociation | undefined>;
  inspectSourceAssociationHistory(assetId: string): Promise<
    | {
        readonly recognitionState: "recognized" | "unresolved";
        readonly recognitionDecisionId?: string;
        readonly current: readonly SourceAssociation[];
        readonly historical: readonly {
          readonly association: SourceAssociation;
          readonly status: "superseded" | "retracted" | "legacy-retired";
          readonly authorizedBy?: SourceAssociationTerminationAudit;
        }[];
      }
    | undefined
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
    /** 本工作项明确创建或复用的材料的精确映射；无关位置不参与。 */
    readonly observedMaterialAcceptances?:
      | readonly ObservedMaterialAcceptanceBinding[]
      | undefined;
    readonly sourceRecords: readonly SourceRecord[];
    readonly expectedLineageHeads: MetadataRefreshSubmission["expectedLineageHeads"];
    /**
     * 冻结时该资产全部相交有效材料范围的基线，以及冻结它时使用的相交范围地址
     * （本次观察快照根，即 `resolve(root.containerPath, relativeScope)`）；提交前在
     * 同一事务内按同一规则重算比较，不一致则本次刷新不产生任何写入。
     */
    readonly expectedBoundary?:
      | { readonly keys: readonly string[]; readonly scopeAddress: string }
      | undefined;
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
    readonly recognitionSourceAssociationId?: string;
    readonly recognitionDecisionId: string;
    /** 给出时把指纹收窄到这些决定相交的精确支持，用于范围局部预演。 */
    readonly scopeDecisionIds?: readonly string[];
  }): Promise<string>;
  applyChangeImpactPreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly plan: RecognitionSupersessionPlan;
  }): Promise<"applied" | "stale">;
  applySourceAssociationChangePreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly decision: SourceAssociationDecision;
    readonly confirmedBy: string;
  }): Promise<"applied" | "stale">;
  applyRecognitionRetractionPreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly confirmedBy: string;
  }): Promise<"applied" | "stale">;
  /** 以冻结的相交范围基线为条件，原子写入范围修订的新决定与支持。 */
  applyRecognitionScopeAmendmentPreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly plan: RecognitionScopeAmendmentPlan;
  }): Promise<"applied" | "stale">;
  /**
   * 人工封面决定不属于任何工作流执行，也没有租约或新状态机；预演本身就是它的耐久
   * 因果记录，因此只落这一行。
   */
  saveArtifactRoleDecisionPreview(preview: ChangeImpactPreview): Promise<void>;
  /** 比较冻结候选、政策版本与当前头后，原子追加决定、推进头并把预演置为 applied。 */
  applyArtifactRoleDecisionPreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly confirmedBy: string;
    /** 确认时按同一规则重算的候选指纹；主体当前事实已不可读时为 null。 */
    readonly currentCandidateBaseline: string | null;
    readonly policyVersion: string;
  }): Promise<"applied" | "stale">;
  /** 保存一次明确范围决定的预演，并把那次观察的提议随执行一起落库。 */
  finishExecutionWithRecognitionScopeAmendmentPreview(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly proposal: RecognitionProposal;
    readonly preview: ChangeImpactPreview;
  }): Promise<void>;
  rejectChangeImpactPreview(input: {
    readonly previewId: string;
    readonly rejectedBy: string;
  }): Promise<"rejected" | "stale">;
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
  /**
   * 一次耐久库扫描父执行与其全部目录条目在同一条事务内落下：父先存在，目录子才有
   * 可以登记的归属。携带意图时同一事务核对启用、到期与运行时独占，未接纳就不落任何行。
   */
  createLibraryScan(input: {
    readonly execution: WorkflowExecution;
    readonly directories: readonly LibraryScanDirectoryRecord[];
    readonly requestedAt?: string;
    /** 提供时同事务建立该父的 awaiting-results 批次壳；自动化父必须给，交互父不给。 */
    readonly fulfillmentPlannerCoordinate?: string;
  }): Promise<ExecutionStartDisposition>;
  /**
   * 原子比较父仍运行且未被明确取消，插入目录子并把其 ID 登记到父的 execute 条目及其
   * covered 条目。取消竞态下最多只有一次登记成功，崩溃不会留下无归属的子执行。
   */
  registerLibraryScanChild(input: {
    readonly parentExecutionId: string;
    readonly directoryKey: string;
    readonly execution: WorkflowExecution;
    readonly requestedAt?: string;
  }): Promise<"registered" | "cancelled" | "already-registered">;
  /** 写下某目录条目的终态结果；covered 只按其前缀投影后的计数进入。 */
  recordLibraryScanDirectoryResult(input: {
    readonly parentExecutionId: string;
    readonly directoryKey: string;
    readonly stage: LibraryScanDirectoryStage;
    readonly outcome?: AssetRefreshOutcome;
    readonly reason?: string;
    readonly workItemCount: number;
    readonly unresolvedCount: number;
    readonly failedCount: number;
  }): Promise<void>;
  inspectLibraryScan(
    parentExecutionId: string,
  ): Promise<LibraryScanInspection | undefined>;
  /** 先CAS写下取消意图：此后任何新目录子都不能登记。 */
  requestLibraryScanCancellation(input: {
    readonly parentExecutionId: string;
    readonly requestedBy: string;
    readonly requestedAt: string;
    readonly reason?: string;
  }): Promise<
    | {
        readonly status: "recorded" | "already-requested";
        readonly childExecutionIds: readonly string[];
      }
    | { readonly status: "absent" | "terminal" }
  >;
  /** 未识别观察的有界查询：只按父、库或目录范围展开，并给出可核对的子执行归属。 */
  listUnrecognizedLibraryScanObservations(input: {
    readonly parentExecutionId?: string;
    readonly assetLibraryId?: string;
    readonly directoryKey?: string;
    readonly limit: number;
  }): Promise<readonly UnrecognizedLibraryScanObservation[]>;
  /**
   * 父终态与其全部耐久处置在同一条 immediate/CAS 事务内落下：CAS 失败或 claim 过期就不写
   * 批次、主体、计划，也不写终态。这是现代父唯一能写下规划结果的位置。
   */
  finishLibraryScanWithFulfillmentPlan(input: {
    readonly expectedParent: WorkflowExecution;
    readonly finishedParent: WorkflowExecution;
    readonly batch: LibraryScanFulfillmentBatchWrite;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  /** 终态收敛只读这份耐久计划，绝不按今日规则重算。 */
  inspectLibraryScanFulfillment(
    parentExecutionId: string,
  ): Promise<LibraryScanFulfillmentInspection | undefined>;
  /** 只列出确实欠信息履行处置的终态自动化库扫描父，按耐久载体判定而非执行摘要。 */
  listTerminalLibraryScanFulfillmentDebt(): Promise<readonly string[]>;
  /**
   * 按稳定 operation 身份原子绑定唯一 child：已绑定返回原执行 ID 且不启动第二份效果，
   * 缺原计划或冻结依据时写下耐久中断而不是失败重放。
   */
  registerInformationFulfillmentChild(input: {
    readonly parentExecutionId: string;
    readonly operationId: string;
    readonly execution: WorkflowExecution;
  }): Promise<InformationFulfillmentChildRegistration>;
  /** 迁移前就没有批次的终态父只收口为可读的历史中断，绝不回填 no-work 或伪造计划。 */
  closeLegacyLibraryScanFulfillment(
    input: LegacyLibraryScanFulfillmentClosure,
  ): Promise<void>;
};

/**
 * 信息履行账本自己的窄命令端口。普通执行命令不因此获得写批次、绑定的能力；只有父终态规划
 * 与终态收敛这条机制使用它。
 */
export type LibraryScanFulfillmentCommands = Pick<
  CataloguePersistenceOperations,
  | "finishLibraryScanWithFulfillmentPlan"
  | "registerInformationFulfillmentChild"
  | "closeLegacyLibraryScanFulfillment"
>;

/**
 * 信息履行账本的只读端口：交付投影与终态收敛从这里读原计划与原原因，绝不据此重算今日事实。
 */
export type LibraryScanFulfillmentQueries = Pick<
  CataloguePersistenceOperations,
  "inspectLibraryScanFulfillment" | "listTerminalLibraryScanFulfillmentDebt"
>;

export type WorkflowExecutionCommands = Pick<
  CataloguePersistenceOperations,
  | "createExecution"
  | "retainSourceRecords"
  | "commitSourceRefreshCollectionFailure"
  | "transitionExecution"
  | "finishExecution"
  | "cancelExecution"
  | "finishExecutionWithProposal"
  | "createLibraryScan"
  | "registerLibraryScanChild"
  | "recordLibraryScanDirectoryResult"
  | "requestLibraryScanCancellation"
>;

export type CommitSourceRefreshCollectionFailureInput = {
  readonly expectedExecution: WorkflowExecution;
  readonly runId: string;
  readonly coverage: SourceCoverageScope;
  readonly acquisitionAttempt: number;
  readonly outcome: "failed" | "stale";
  readonly reason: string;
  readonly sourceFailureCodes?: readonly SourceFailureCode[];
  readonly idempotencyKey: string;
  readonly resumeClaim?: { readonly token: string; readonly now: string };
};

export type WorkflowExecutionQueries = Pick<
  CataloguePersistenceOperations,
  | "inspectExecution"
  | "listExecutions"
  | "listRunningExecutions"
  | "inspectRawSourceRecord"
  | "inspectLibraryScan"
  | "listUnrecognizedLibraryScanObservations"
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
  | "listEffectiveMaterialBoundaries"
  | "findAcceptedForSubjects"
  | "findCurrentSourceAssociationByCoordinate"
  | "inspectSourceAssociationHistory"
  | "findCurrentAcceptedForObservedArtifacts"
  | "findReusableWorkItem"
  | "findAcceptedForWorkItem"
> & {
  /**
   * 与本次范围相交的完整声明：逐决定的全部边界、主头标识，以及已经取代／撤回结束的历史
   * 决定。只提供规划与明确决定的入口，绝不授予任何观察或 I/O 权限。
   */
  listMaterialScopeDeclarations?(input: {
    readonly scopeAddress: string;
  }): Promise<readonly MaterialScopeDeclaration[]>;
  /** 该内容当前生效的全部范围决定，供点名撤回与修订核对；不授予观察权限。 */
  listEffectiveMaterialBoundariesForSubject?(input: {
    readonly assetId: string;
  }): Promise<readonly EffectiveRecognitionMaterialBoundary[]>;
  /**
   * 被点名决定自己的提案、形成它的观察执行与快照，以及该主体当前仍有效的已接受投影。
   * 逐决定复用只与该决定自己的观察比较，绝不拿资产主头的执行充当追加范围基线。
   */
  findAcceptedForDecision?(input: { readonly decisionId: string }): Promise<
    | {
        readonly accepted: AcceptedAssetState;
        readonly proposal: RecognitionProposal;
        readonly execution: WorkflowExecution;
      }
    | undefined
  >;
};

/** 普通实体遍历所需的产品安全节点身份。 */
export type PublicRelationshipParticipantEntity = Pick<
  SourcedEntity,
  "id" | "label"
> & {
  /** 关系可读，但冲突实体不能被伪装成某一静态种类。 */
  readonly kind: import("@digital/domain").EffectiveEntityKind;
} & Partial<
    Pick<SourcedEntity, "sourceIdentity" | "sourceKey" | "identityNamespace">
  >;

/** 一项可公开检查的关系事实；记录、槽位和能力坐标留在持久化边界。 */
export type PublicCatalogueEntityRelationship = {
  readonly id: string;
  readonly participants: readonly Pick<
    EntityRelationshipParticipant,
    "entityId" | "role"
  >[];
  readonly type: string;
  readonly qualifiers?: EntityRelationship["qualifiers"];
  readonly sources: readonly Pick<
    SourceAssociation,
    "sourceIdentity" | "nativeAddress"
  >[];
};

/** 从一个普通实体读取仍由当前来源支持的已收录关系事实。 */
export type CatalogueEntityRelationshipFacts = {
  /** 被查询的实体；即使没有邻接关系也会明确返回。 */
  readonly entity: PublicRelationshipParticipantEntity;
  /** 当前代表的原属成员，仅供 Application 汇集既有资料投影。 */
  readonly memberIds: readonly string[];
  /** 此实体仍有效的具名关系事实。 */
  readonly relationships: readonly PublicCatalogueEntityRelationship[];
  /** 原属成员的当前资料事实及来源归属；不以关系邻接作为资料发现条件。 */
  readonly metadataAccepted: readonly {
    readonly subjectId: string;
    readonly accepted: AcceptedAssetState;
    readonly execution: WorkflowExecution;
  }[];
  /** 经每项关系连接到的当前已收录内容。 */
  readonly accepted: readonly {
    readonly subjectId: string;
    readonly accepted: AcceptedAssetState;
    readonly execution: WorkflowExecution;
  }[];
};

export type RelationshipTraversalQueries = {
  findCurrentRelationshipParticipant(
    entityId: string,
  ): Promise<CatalogueEntityRelationshipFacts | undefined>;
};

/** 有界的公开关系操作。每项修改都点名一个当前关系事实，绝不按类型与参与者整体作用。 */
export type RelationshipChange =
  | {
      readonly kind: "create";
      readonly definitionId: string;
      readonly relationship: RelationshipDraft;
    }
  | {
      readonly kind: "replace";
      readonly targetRelationshipId: string;
      readonly definitionId: string;
      readonly relationship: RelationshipDraft;
    }
  | {
      readonly kind: "select" | "exclude" | "clear";
      readonly targetRelationshipId: string;
    };

export type RelationshipChangePreview = {
  readonly baseline: string;
  readonly changes: readonly RelationshipChange[];
  readonly relationships: readonly PublicCatalogueEntityRelationship[];
};

export type RelationshipDecisionPersistence = {
  previewRelationshipChange(input: {
    readonly changes: readonly RelationshipChange[];
  }): Promise<RelationshipChangePreview>;
  applyRelationshipChange(input: {
    readonly id: string;
    readonly actorId: string;
    readonly preview: RelationshipChangePreview;
  }): Promise<"applied" | "stale">;
};

/** 公开身份操作刻意与关系编写分离。 */
export type RelatedEntityIdentity = {
  readonly id: string;
  readonly label: string;
  /** 公开诚实的生效投影；冲突绝不伪装成普通实体。 */
  readonly kind: import("@digital/domain").EffectiveEntityKind;
  readonly identity: "local" | "source";
};

export type EntityIdentityMergePreview = {
  readonly retainedEntityId: string;
  readonly mergedEntityId: string;
  readonly members: readonly string[];
  /** 采用后以代表身份可见的当前关系；事实本身不会被复制。 */
  readonly relationshipIds: readonly string[];
  /** 原属成员的当前资料；采用不会迁移这些事实。 */
  readonly metadata: readonly {
    readonly entityId: string;
    readonly property: string;
    readonly value: string;
  }[];
  /** 合并后资料冲突的最小公开影响摘要；不泄露来源坐标或原始断言。 */
  readonly metadataConflicts: readonly PublicMetadataConflict[];
  /** Application 资料策略投影的不可解释预演坐标。 */
  readonly metadataPolicyBaseline: string;
  readonly effectiveKind: EffectiveEntityKind;
  readonly baseline: string;
  readonly mergeId?: string;
};

/** 供用户确认影响的资料冲突摘要，不包含候选断言、来源或来源记录。 */
export type PublicMetadataConflict = {
  readonly subjectId: string;
  readonly property: string;
  readonly reason: "policy-conflict" | "multiple-values";
  readonly cardinality: "one" | "conflicting";
  readonly metadataUsageContext: string;
};

function canonicalMetadataImpact(metadata: {
  readonly entityId: string;
  readonly property: string;
  readonly value: string;
}): {
  readonly entityId: string;
  readonly property: string;
  readonly value: string;
} {
  return {
    entityId: metadata.entityId,
    property: metadata.property,
    value: metadata.value,
  };
}

function canonicalMetadataConflictImpact(conflict: PublicMetadataConflict): {
  readonly subjectId: string;
  readonly property: string;
  readonly reason: "policy-conflict" | "multiple-values";
  readonly cardinality: "one" | "conflicting";
  readonly metadataUsageContext: string;
} {
  return {
    subjectId: conflict.subjectId,
    property: conflict.property,
    reason: conflict.reason,
    cardinality: conflict.cardinality,
    metadataUsageContext: conflict.metadataUsageContext,
  };
}

function canonicalEffectiveKindImpact(kind: EffectiveEntityKind): object {
  switch (kind.status) {
    case "ordinary":
      return { status: "ordinary" };
    case "effective":
      return { status: "effective", kind: kind.kind, basis: kind.basis };
  }
}

/** 仅比较用户已确认的合并影响；持久化事实基线仍由 SQLite 自行比较。 */
function entityIdentityMergeImpact(
  preview: EntityIdentityMergePreview,
): string {
  return JSON.stringify({
    retainedEntityId: preview.retainedEntityId,
    mergedEntityId: preview.mergedEntityId,
    members: [...preview.members].toSorted(),
    relationshipIds: [...preview.relationshipIds].toSorted(),
    metadata: preview.metadata
      .map(canonicalMetadataImpact)
      .toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    metadataConflicts: preview.metadataConflicts
      .map(canonicalMetadataConflictImpact)
      .toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    effectiveKind: canonicalEffectiveKindImpact(preview.effectiveKind),
    metadataPolicyBaseline: preview.metadataPolicyBaseline,
    factsBaseline: preview.baseline,
  });
}

function entityIdentityMergeImpactFingerprint(
  preview: EntityIdentityMergePreview,
): string {
  return createHash("sha256")
    .update(entityIdentityMergeImpact(preview))
    .digest("hex");
}

export type EntityMentionResolution = {
  readonly mentionId: string;
  readonly label: string;
  readonly entityId?: string;
  readonly basis?: "source" | "manual";
  readonly decisionId?: string;
  readonly actorId?: string;
  readonly sourceRecordIds: readonly string[];
  readonly baseline: string;
};

export type RelatedEntityIdentityPersistence = {
  createLocalRelatedEntity(input: {
    /** 用户一次本地身份提交的不可变坐标；同一坐标可安全重放。 */
    readonly commitmentId: string;
    readonly id: string;
    readonly label: string;
    readonly actorId: string;
  }): Promise<RelatedEntityIdentity>;
  findRelatedEntities(label: string): Promise<readonly RelatedEntityIdentity[]>;
  previewEntityIdentityMerge(input: {
    readonly retainedEntityId: string;
    readonly mergedEntityId: string;
  }): Promise<EntityIdentityMergePreview>;
  /** 只读取身份合并的持久提交坐标；不形成通用幂等层。 */
  findEntityIdentityMergeReplay(input: {
    readonly actorId: string;
    readonly commitmentId: string;
  }): Promise<
    | {
        readonly retainedEntityId: string;
        readonly mergedEntityId: string;
        readonly impactFingerprint: string;
      }
    | undefined
  >;
  applyEntityIdentityMerge(input: {
    readonly id: string;
    readonly commitmentId: string;
    readonly actorId: string;
    readonly preview: EntityIdentityMergePreview;
    /** Application 已规范化的用户确认影响及 SQLite 事实基线指纹。 */
    readonly impactFingerprint: string;
  }): Promise<"applied" | "stale">;
  undoEntityIdentityMerge(input: {
    readonly id: string;
    readonly commitmentId: string;
    readonly actorId: string;
    readonly preview: EntityIdentityMergePreview;
  }): Promise<"applied" | "stale">;
  resolveEntityMentionManually(input: {
    readonly id: string;
    readonly mentionId: string;
    readonly entityId: string;
    readonly actorId: string;
    readonly baseline: string;
  }): Promise<"applied" | "stale">;
  inspectEntityMentionResolution(
    mentionId: string,
  ): Promise<EntityMentionResolution>;
  retractEntityMentionResolution(input: {
    readonly id: string;
    readonly mentionId: string;
    readonly actorId: string;
    readonly baseline: string;
  }): Promise<"applied" | "stale">;
};

/**
 * 权威当前 Catalogue 投影的游标输入。游标对交付层刻意保持不透明；只有签发它的查询
 * 可以在后续请求中解释它。
 */
export type CurrentCataloguePageRequest = {
  readonly limit?: number;
  readonly cursor?: string;
  readonly subjectIds?: readonly string[];
  readonly informationRequirement?: InformationRequirement;
  /**
   * 库语境 current 读取：带上本库的活动目录授权与 `awaitingObservation = 0` 资格，与库索引
   * 共用同一谓词。省略时沿用全局 current 判定。
   */
  readonly assetLibraryId?: string;
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
  readonly items: readonly EffectiveSubjectRead[];
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
  /** 仅载入检索所需事实，不读取文件、产物内容或工作流历史。 */
  listCurrentCatalogueIndex(
    metadataProperties: readonly string[],
    observedRootIds?: readonly string[],
    assetLibraryId?: string,
  ): Promise<readonly CurrentCatalogueIndexFacts[]>;
};

export type CurrentCatalogueIndexFacts = Pick<
  AcceptedAssetState,
  | "entity"
  | "metadata"
  | "metadataSourceRecords"
  | "sourceAssociations"
  | "recognitionSourceAssociation"
  | "currentRelatedEntities"
  | "relationships"
  | "relationshipReadBasis"
> & { readonly additionOrder: number };

export type CurrentCatalogueIndexEntry = EffectiveSubjectRead & {
  readonly additionOrder: number;
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
  | "finishExecutionWithChangeImpactPreview"
  | "finishExecutionWithSourceAssociationPreview"
  | "finishExecutionWithRecognitionRetractionPreview"
  | "finishExecutionWithRecognitionScopeAmendmentPreview"
>;

export type MetadataRefreshPersistence = Pick<
  CataloguePersistenceOperations,
  "freezeSourceLineageHeads" | "applyMetadataRefresh"
>;

/**
 * 可以满足一个选定主体信息需求的精确当前事实。这里刻意排除已装载的相关实体图：调用方
 * 不会收到关联主体不同于选定主体的事实，产物可用性也只从托管位置开始。
 */
/**
 * 履行就绪所需的供应：完整事实依据（由应用层共同求值）与真实来源当前性。
 * SQLite 只供应所需事实及位置／来源头部，不在持久层裁决生效结果。
 */
export type CurrentInformationSubjectFacts = {
  readonly subjectId: string;
  /** 供共同读取求值生效描述、关系与图片角色的完整依据。 */
  readonly basis: SubjectFactBasis;
  /**
   * 绑定到某个来源关联的托管来源产物是否仍是该来源关联的当前头部。
   * 只包含来源绑定关联；本地托管与观察产物不在此列。
   */
  readonly sourceArtifactCurrency: readonly {
    readonly associationId: string;
    readonly current: boolean;
  }[];
};

/**
 * 交付层提供的信息履行规划规则，连同它自己的稳定坐标。规则会随交付代码演进而改变计划，因此
 * 自动化父在创建时冻结该坐标；只有坐标精确相等的部署才能继续补完这份计划，绝不把今日规则
 * 当作原计划。
 */
export type AutomatedInformationPlanner = {
  readonly coordinate: string;
  readonly requirementForAcceptedSubject: (
    accepted: EffectiveSubjectRead,
  ) => InformationRequirement;
};

/**
 * 交付层交给组合的那份规划规则。名称沿用既有产品边界，内容已经是规划器：Application 只调用
 * 其中的中立需求，绝不接收视图、提供方、路由或组件。
 */
export type AutomationInformationRequirementResolver =
  AutomatedInformationPlanner;

/** 没有配置解析规则时冻结的坐标：主体需求完全来自父自己耐久写下的信息需求。 */
export const automatedInformationPlannerNoneCoordinate =
  "information-planner:none";

/** 父创建时冻结的解析规则身份。 */
export function automatedInformationPlannerCoordinate(
  planner: AutomatedInformationPlanner | undefined,
): string {
  return planner?.coordinate ?? automatedInformationPlannerNoneCoordinate;
}

/**
 * 一次扫描里已接受主体的中立规划输入：只有主体身份与 delivery 中立 facts 能进到规划接缝，
 * 视图、组件、路由与提供方输出模型都不越过这条边界。
 */
export type AcceptedInformationSubject = {
  readonly subjectId: string;
  readonly facts: EffectiveSubjectRead;
};

/**
 * 一次自动化库扫描父的父后信息履行账本批次版本。它是现代父与历史无规划父的耐久分界，
 * 迁移绝不给旧父补造。
 */
export const libraryScanFulfillmentVersion = "library-scan-fulfillment/1";

export type LibraryScanFulfillmentBatchStage =
  | "awaiting-results"
  | "planned"
  | "closed"
  | "interrupted";

export type LibraryScanFulfillmentSubjectDisposition =
  | "no-work"
  | "planned"
  | "interrupted";

export type LibraryScanFulfillmentOperationDisposition =
  | "planned"
  | "registered"
  | "interrupted";

/** 与父终态同事务写入的一个接受主体处置。 */
export type LibraryScanFulfillmentSubjectWrite = {
  readonly subjectId: string;
  readonly disposition: LibraryScanFulfillmentSubjectDisposition;
  /** 该主体请求的完整版本化中立需求；无法安全解析时缺失。 */
  readonly requirement?: InformationRequirement;
  readonly reason?: string;
};

/** 与父终态同事务写入的一个具体计划；child 之后按该稳定身份原子绑定。 */
export type LibraryScanFulfillmentOperationWrite = {
  readonly operationId: string;
  readonly subjectId: string;
  readonly plan: InformationFulfillmentPlan;
};

export type LibraryScanFulfillmentBatchWrite = {
  readonly parentExecutionId: string;
  readonly plannerCoordinate: string;
  readonly subjects: readonly LibraryScanFulfillmentSubjectWrite[];
  readonly operations: readonly LibraryScanFulfillmentOperationWrite[];
};

export type LibraryScanFulfillmentOperationRecord = {
  readonly operationId: string;
  readonly subjectId: string;
  readonly disposition: LibraryScanFulfillmentOperationDisposition;
  /** 只有导入的历史 `/1` child 引用才缺原计划。 */
  readonly plan?: InformationFulfillmentPlan;
  readonly childExecutionId?: string;
  /** child 的运行结果以执行行为权威，这里只做组合投影，不复制第二份终态。 */
  readonly childStatus?: WorkflowExecution["status"];
  readonly reason?: string;
};

export type LibraryScanFulfillmentSubjectRecord = {
  readonly subjectId: string;
  readonly disposition: LibraryScanFulfillmentSubjectDisposition;
  readonly requirement?: InformationRequirement;
  readonly reason?: string;
  readonly operations: readonly LibraryScanFulfillmentOperationRecord[];
};

export type LibraryScanFulfillmentInspection = {
  readonly parentExecutionId: string;
  readonly stage: LibraryScanFulfillmentBatchStage;
  readonly plannerCoordinate: string;
  readonly reason?: string;
  readonly plannedAt?: string;
  readonly subjects: readonly LibraryScanFulfillmentSubjectRecord[];
};

/**
 * 一个耐久 operation 与唯一 child 的绑定结果。`existing` 让调用方沿用原执行而不启动第二份
 * 效果；`interrupted` 是耐久处置，因此不会在每次启动重放同一远程工作。
 */
export type InformationFulfillmentChildRegistration =
  | { readonly status: "registered"; readonly executionId: string }
  | { readonly status: "existing"; readonly executionId: string }
  | { readonly status: "interrupted"; readonly reason: string };

/**
 * 迁移前没有批次的终态自动化库扫描父的收口输入。这里只提供从耐久载体定位到的接受主体，或载体读不到
 * 时的批次级原因；调用方不能伪造处置，适配器也绝不据此回填 no-work 或伪造计划。
 */
export type LegacyLibraryScanFulfillmentClosure = {
  readonly parentExecutionId: string;
  readonly acceptedSubjectIds: readonly string[];
  /** 提供时只写批次级中断，绝不伪造主体处置。 */
  readonly unreadableReason?: string;
};

const informationRequirementVersion = "information-requirement/1";

function isNonEmptyStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}

function isStrictNecessity(value: unknown): boolean {
  return value === "required" || value === "optional";
}

/** 严格校验一份中立信息需求；绝不接受未预期的键或空坐标。 */
export function validateInformationRequirement(
  value: unknown,
): value is InformationRequirement {
  if (!isStringRecord(value) || !isNonEmptyString(value.metadataUsageContext))
    return false;
  if (
    !hasExactKeys(value, [
      "artifactRoles",
      "metadata",
      "metadataUsageContext",
      "relationshipTypes",
    ])
  )
    return false;
  if (!Array.isArray(value.metadata) || !Array.isArray(value.relationshipTypes))
    return false;
  if (
    !value.metadata.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["necessity", "property"]) &&
        isNonEmptyString(item.property) &&
        isStrictNecessity(item.necessity),
    )
  )
    return false;
  if (
    !value.relationshipTypes.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["necessity", "type"]) &&
        isNonEmptyString(item.type) &&
        isStrictNecessity(item.necessity),
    )
  )
    return false;
  return (
    Array.isArray(value.artifactRoles) &&
    value.artifactRoles.every(
      (item) =>
        isStringRecord(item) &&
        hasExactKeys(item, ["necessity", "role"], ["maximum"]) &&
        isNonEmptyString(item.role) &&
        isStrictNecessity(item.necessity) &&
        (item.maximum === undefined ||
          (typeof item.maximum === "number" &&
            Number.isInteger(item.maximum) &&
            item.maximum > 0)),
    )
  );
}

function isStrictDeclaredCapability(value: unknown): boolean {
  if (!isStringRecord(value) || !isStrictCapabilityCoordinate(value))
    return false;
  const declared = value as Record<string, unknown>;
  return (
    [declared.identity, declared.implementationVersion, declared.kind].every(
      isNonEmptyString,
    ) && isNonEmptyStringArray(declared.interpretationContractVersions)
  );
}

function isStrictFulfillmentOperation(value: unknown): boolean {
  return (
    value === "source-refresh" ||
    value === "source-enrichment" ||
    value === "source-artifact-acquisition"
  );
}

/** 严格校验一份耐久计划；缺任何版本或身份字段都不能启动 child。 */
export function validateInformationFulfillmentPlan(
  value: unknown,
): value is InformationFulfillmentPlan {
  if (!isStringRecord(value)) return false;
  if (
    !hasExactKeys(
      value,
      ["capability", "operation", "requirement", "sourceIdentity", "subjectId"],
      ["sourceAssociationId", "operationId"],
    )
  )
    return false;
  if (
    !isNonEmptyString(value.subjectId) ||
    !isNonEmptyString(value.sourceIdentity)
  )
    return false;
  if (
    value.sourceAssociationId !== undefined &&
    !isNonEmptyString(value.sourceAssociationId)
  )
    return false;
  if (!isStrictFulfillmentOperation(value.operation)) return false;
  if (!isNonEmptyString(value.operationId)) return false;
  if (!isStrictDeclaredCapability(value.capability)) return false;
  return validateInformationRequirement(value.requirement);
}

function requirementJson(requirement: InformationRequirement): string {
  if (!validateInformationRequirement(requirement))
    throw new Error("信息需求不是可耐久的严格形状");
  return JSON.stringify({
    version: informationRequirementVersion,
    requirement,
  });
}

/** 把一份中立信息需求编码为账本使用的版本化 JSON。 */
export function encodeLibraryScanFulfillmentRequirement(
  requirement: InformationRequirement,
): string {
  return requirementJson(requirement);
}

/** 解码账本中的需求；任何未版本化或损坏载荷都明确失败，绝不按今日事实补齐。 */
export function decodeLibraryScanFulfillmentRequirement(
  json: string,
): InformationRequirement {
  const decoded: unknown = JSON.parse(json);
  if (
    !isStringRecord(decoded) ||
    !hasExactKeys(decoded, ["requirement", "version"]) ||
    decoded.version !== informationRequirementVersion ||
    !validateInformationRequirement(decoded.requirement)
  )
    throw new Error("信息需求账本记录无法解码");
  return decoded.requirement;
}

/** 把一份具体计划编码为账本使用的版本化封装。 */
export function encodeInformationFulfillmentPlan(
  plan: InformationFulfillmentPlan,
): string {
  if (!validateInformationFulfillmentPlan(plan))
    throw new Error("信息履行计划不是可耐久的严格形状");
  const envelope: InformationFulfillmentPlanEnvelope = {
    version: "information-fulfillment-plan/1",
    plan,
  };
  return JSON.stringify(envelope);
}

/** 解码账本中的计划；解码失败绝不能变成按今日能力重建。 */
export function decodeInformationFulfillmentPlan(
  json: string,
): InformationFulfillmentPlan {
  const decoded: unknown = JSON.parse(json);
  if (
    !isStringRecord(decoded) ||
    !hasExactKeys(decoded, ["plan", "version"]) ||
    decoded.version !== "information-fulfillment-plan/1" ||
    !validateInformationFulfillmentPlan(decoded.plan)
  )
    throw new Error("信息履行计划账本记录无法解码");
  return decoded.plan;
}

/** 只用于重建当前履行就绪状态的窄查询端口。 */
export type InformationSubjectFactsQueries = {
  readCurrentInformationSubjectFacts(input: {
    readonly subjectIds: readonly string[];
  }): Promise<readonly CurrentInformationSubjectFacts[]>;
  /**
   * 主体当前观察材料所引用的活动观察根，用来把普通浏览解析到唯一资产库。只有支持库范围
   * 解析的持久化提供它。
   */
  readCurrentObservedMaterialRootIds?(input: {
    readonly subjectIds: readonly string[];
  }): Promise<
    readonly {
      readonly subjectId: string;
      readonly observedRootIds: readonly string[];
    }[]
  >;
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
    /** 提交时识别决策及可选的识别来源关联仍必须是该主体的识别头。 */
    readonly expectedRecognitionBaseline: {
      readonly recognitionSourceAssociationId?: string;
      readonly recognitionDecisionId: string;
    };
    readonly assetId: string;
    readonly sourceAssociation: SourceAssociation;
    readonly proposal: SourceAssociationChangeProposal;
    readonly decision: SourceAssociationDecision;
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
  | "applySourceAssociationChangePreview"
  | "applyRecognitionRetractionPreview"
  | "applyRecognitionScopeAmendmentPreview"
  | "saveArtifactRoleDecisionPreview"
  | "applyArtifactRoleDecisionPreview"
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
  readonly assetLibraries?: AssetLibraries;
  readonly assetLibrarySnapshot?: AssetLibrarySnapshot;
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
    | "bindDirectoryOperation"
    | "assertDirectoryOperationLive"
    | "reportCleanupFailure"
    | "get"
  >;
  readonly directoryInterpreters: readonly DirectoryInterpreter[];
  readonly filesystemPackageInterpreters?: readonly FilesystemPackageInterpreter[];
  /** 格式检查按观察产物进行，而不是目录约定。 */
  readonly formatInspectors?: readonly ArtifactFormatInspector[];
  readonly collectors: readonly SourceCollector[];
  readonly sourceInterpreters: readonly SourceInterpreter[];
  /** 已部署来源中明确支持用户寻址的窄能力；不是动态插件登记表。 */
  readonly sourceAddressingCapabilities?: readonly SourceAddressingCapability[];
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
  /**
   * 交付层注入的解析规则连同它自己的稳定坐标。自动化父创建时冻结该坐标，补完规划时只有坐标
   * 精确相等才使用；没有版本注册表，也没有按今日规则重建旧计划的路径。
   */
  readonly informationPlanner?: AutomatedInformationPlanner;
  /**
   * 父后信息履行的耐久账本。现代自动化父的处置只经这条窄端口写下；没有它的部署保持既有收尾，
   * 也不会被伪造出一份处置。
   */
  readonly libraryScanFulfillment?: LibraryScanFulfillmentCommands &
    LibraryScanFulfillmentQueries;
  readonly recoveryLease: WorkflowRecoveryLease;
  readonly reuseQueries: AssetRefreshReuseQueries;
  /** 关系读取与资产复用各有窄用途，避免把实体查询伪装成资产加载。 */
  readonly relationshipTraversalQueries?: RelationshipTraversalQueries;
  readonly relatedEntityIdentity?: RelatedEntityIdentityPersistence;
  readonly relationshipDecisionPersistence?: RelationshipDecisionPersistence;
  /** 测试／旧版组合仍只公开历史时可选。 */
  readonly currentCatalogueQueries?: CurrentCatalogueQueries;
  /** 测试／旧版组合仍只公开完整历史时可选。 */
  readonly workflowHistoryQueries?: WorkflowHistoryQueries;
  /** 测试／旧版组合没有可重建待处理权威时可选。 */
  readonly currentAttentionQueries?: CurrentAttentionQueries;
  readonly recognitionAcceptance: RecognitionAcceptancePersistence;
  readonly observedMaterialAssociationPersistence?: ObservedMaterialAssociationPersistence;
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
    /** 库目录工作据此复用同一 Host 租约与失效生命周期。 */
    lease(): OperationLease;
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
  /** 后续轮询只重访启动时仍在等待的执行，不能接管新开始的工作。 */
  readonly executionIds?: ReadonlySet<string>;
  /** 耐久且未过期的持有者声明使本次执行继续等待重试。 */
  readonly onWaitingExecution?: (executionId: string) => void;
};

/**
 * 启动恢复逐条的耐久分类。`subject`、`reason` 与 `nextAction` 都是给使用者看的简体中文，
 * 坐标与标识符只留在本地持久证据里。
 */
export type RecoveryClassification = {
  readonly executionId: string;
  readonly category: "waiting" | "continuable" | "wrap-up" | "interrupted";
  readonly subject: string;
  readonly reason?: string | undefined;
  readonly nextAction?: string | undefined;
};

export type DueAutomationRunner = {
  classifyRunningExecutions(
    exclude?: ReadonlySet<string>,
    within?: ReadonlySet<string>,
  ): Promise<readonly RecoveryClassification[]>;
  continueRunningExecution(
    executionId: string,
    lifecycle?: RecoveryLifecycle,
  ): Promise<AssetRefreshInspection | undefined>;
  triggerDueAutomation(
    now?: Date,
    lifecycle?: { readonly onCheckpoint: () => void },
  ): Promise<readonly AutomationTriggerResult[]>;
  reconcileTerminalFulfillment(lifecycle?: {
    readonly onCheckpoint: () => void;
  }): Promise<readonly AutomationFulfillmentReconciliation[]>;
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
  private classified = false;
  private readonly recoveryItems = new Map<string, RecoveryClassification>();
  private readonly recoveryNotes = new Map<string, RecoveryClassification>();
  private readonly recoveryInFlight = new Map<string, Promise<void>>();
  /**
   * 本次启动的恢复集合。未定义只发生在启动第一遍（枚举崩溃遗留的全部非终态执行）；之后每一轮
   * 只重访其中仍在等待的执行。本进程正常调用新开始的工作永远不进入这个集合。
   */
  private recoveryScope: ReadonlySet<string> | undefined;
  /**
   * 本次启动里已经分类接纳、但这一轮还领不到权利的执行为（另一进程仍持有未过期声明，或它
   * 正等人工审阅）。它们必须留在后续轮询的重访集合里，直到持有者终态或声明到期后被接手，
   * 而不是因为一次「正在被继续」就永久退出恢复。
   */
  private readonly recoveryDeferred = new Set<string>();
  private fulfillment: Promise<void> | undefined;

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
   * 每个保留执行完成分类并被宿主接纳后开放启动准入。被接纳的长工作仍在自己的监督下继续，
   * 等待用户确认的执行只抑制自己那条计划的后续触发，两者都不让整个目录处于未就绪状态。
   */
  get recoveryReady(): boolean {
    return this.started && this.classified;
  }

  /** 本次启动逐条的中文分类结果：状态、原因与下一步动作，不含任何技术坐标。 */
  startupRecovery(): readonly RecoveryClassification[] {
    return [...this.recoveryItems.values(), ...this.recoveryNotes.values()];
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.recoveryNotes.clear();
    this.recoveryDeferred.clear();
    this.recoveryScope = undefined;
    try {
      // 就绪只等待分类与被接纳执行的监督登记；崩溃前欠下的父后续内容整理同样在后台接续。
      await this.recover();
      this.classified = true;
      this.reconcileFulfillment();
    } catch (error) {
      // 启动分类失败时尚未准入定时器。保持宿主可重试，而不是永久污染 `started` 锁存。
      this.started = false;
      this.classified = false;
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
    this.classified = false;
    if (this.timer !== undefined) {
      this.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 等待已经开始的轮询与全部在途恢复；绝不启动新工作。 */
  async settled(): Promise<void> {
    for (;;) {
      await this.poll;
      const inFlight = [
        ...this.recoveryInFlight.values(),
        ...(this.fulfillment === undefined ? [] : [this.fulfillment]),
      ];
      if (inFlight.length === 0) return;
      await Promise.all(inFlight);
    }
  }

  /**
   * 逐条分类并接纳：每个执行都有自己的一次宿主监督，一个执行的停止或失败绝不牵连同批
   * 其他执行。已经在途的执行不再重复分类，本进程启动后新创建的工作不由恢复接管。
   */
  private async recover(): Promise<void> {
    // 重访集合在每一遍开始时现取：上一遍轮询之后才被标为「领不到权利」的执行同样要接回去。
    const within =
      this.recoveryScope === undefined
        ? undefined
        : new Set([...this.recoveryScope, ...this.recoveryDeferred]);
    const classifications = await this.runner.classifyRunningExecutions(
      new Set(this.recoveryInFlight.keys()),
      within,
    );
    const present = new Set(classifications.map((item) => item.executionId));
    for (const executionId of this.recoveryItems.keys())
      if (!present.has(executionId) && !this.recoveryInFlight.has(executionId))
        this.recoveryItems.delete(executionId);
    // 已经耐久终结的占用执行不再需要重访；仍在途的那条由本轮的接纳任务继续负责。
    for (const executionId of this.recoveryDeferred)
      if (!present.has(executionId) && !this.recoveryInFlight.has(executionId))
        this.recoveryDeferred.delete(executionId);
    for (const item of classifications) {
      this.recoveryItems.set(item.executionId, item);
      if (item.category !== "waiting") this.admit(item);
    }
    // 等待用户的那几条由这份集合带着；领不到权利的那几条由 `recoveryDeferred` 自己带着，
    // 下一遍轮询在开头合并。本进程新开始的工作始终不在两者之中。
    this.recoveryScope = new Set(
      classifications
        .filter((item) => item.category === "waiting")
        .map((item) => item.executionId),
    );
  }

  private admit(item: RecoveryClassification): void {
    if (this.recoveryInFlight.has(item.executionId)) return;
    const executionId = item.executionId;
    let deferred = false;
    const lifecycle: RecoveryLifecycle = {
      // 「另一进程仍在继续」和「等人工审阅」都不算这条已被协调完：留在本次启动的重访集合里，
      // 等持有者终态或声明到期后由同一个宿主沿原 ID 接手。
      onWaitingExecution: (waitingExecutionId) => {
        deferred = true;
        this.recoveryDeferred.add(waitingExecutionId);
      },
    };
    const continuing = async (): Promise<
      AssetRefreshInspection | undefined
    > => {
      if (this.executionHost === undefined)
        return await this.runner.continueRunningExecution(
          executionId,
          lifecycle,
        );
      return await this.executionHost.runWithControl((control) =>
        this.runner.continueRunningExecution(executionId, {
          ...lifecycle,
          onCheckpoint: control.safeCheckpoint,
        }),
      );
    };
    const task = continuing()
      .then((inspection) => {
        // 这一轮领不到权利：这条分类继续留在本次启动里可见并等待重访，不算协调完成。
        if (deferred) return;
        this.recoveryDeferred.delete(executionId);
        this.recoveryItems.delete(executionId);
        // 明确中断的执行已耐久终结，不再出现在后续分类里；这份结果留在本次启动，用户因此
        // 仍能看到它为什么停下与下一步该做什么。
        if (inspection?.execution.outcome !== "interrupted") return;
        this.recoveryNotes.set(executionId, {
          executionId,
          category: "interrupted",
          subject: item.subject,
          reason: inspection.execution.reason ?? item.reason,
          nextAction: "请重新发起一次刷新",
        });
      })
      .catch((error: unknown) => {
        this.onError(error);
      })
      .finally(() => {
        this.recoveryInFlight.delete(executionId);
      });
    this.recoveryInFlight.set(executionId, task);
  }

  /** 父扫描之后欠下的内容整理沿耐久父 ID 后台接续，不占用启动准入。 */
  private reconcileFulfillment(): void {
    if (this.fulfillment !== undefined) return;
    const run = async (): Promise<void> => {
      const results =
        this.executionHost === undefined
          ? await this.runner.reconcileTerminalFulfillment()
          : await this.executionHost.runWithControl((control) =>
              this.runner.reconcileTerminalFulfillment({
                onCheckpoint: control.safeCheckpoint,
              }),
            );
      // 终态父不会进入启动恢复集合，账本级中断又没有 child，因此这份逐条结果必须留在本次
      // 启动的分类里，用户在既有 Settings 入口才能看到每份内容整理为何没建起来与下一步该做什么。
      for (const result of results)
        if (result.status === "interrupted")
          this.recoveryNotes.set(`fulfillment:${result.intentId}`, {
            executionId: `fulfillment:${result.intentId}`,
            category: "interrupted",
            subject: "自动扫描后的内容整理",
            reason: result.reason ?? "该父扫描的内容整理未能补齐",
            nextAction: "请重新发起一次扫描",
          });
    };
    const task = run().catch((error: unknown) => {
      this.onError(error);
    });
    this.fulfillment = task;
    void task.finally(() => {
      if (this.fulfillment === task) this.fulfillment = undefined;
    });
  }

  private async runPoll(propagateError: boolean): Promise<void> {
    if (!this.started || this.polling) return;
    this.polling = true;
    this.poll = (async () => {
      try {
        const poll = async (lifecycle?: RecoveryLifecycle) => {
          await this.recover();
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
  const candidates: AssetRefreshWorkItemPlan[] = [
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
  const formatOnly = (item: AssetRefreshWorkItemPlan) =>
    item.evidence.length > 0 &&
    item.evidence.every((evidence) => evidence.inspection !== undefined);
  const planned = candidates.filter((item) => !formatOnly(item));
  for (const format of candidates.filter(formatOnly)) {
    const ownerIndex = planned.findIndex((item) =>
      format.relativePaths.every((reference) =>
        item.relativePaths.includes(reference),
      ),
    );
    const owner = planned[ownerIndex];
    if (owner === undefined) planned.push(format);
    else
      planned[ownerIndex] = {
        ...owner,
        evidence: [...owner.evidence, ...format.evidence],
      };
  }
  const keys = new Set<string>();
  const observed = new Set(snapshot.files.map((file) => file.relativePath));
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
    }
    keys.add(item.key);
  }
  return planned.map((item) =>
    planned.some(
      (other) =>
        other !== item &&
        other.relativePaths.some((reference) =>
          item.relativePaths.includes(reference),
        ),
    )
      ? {
          ...item,
          boundaryConflict: "多个候选资产范围包含相同材料，需要明确决定",
        }
      : item,
  );
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
      | "plannedAssetId"
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

/**
 * 历史父的收口只有在其冻结输入可读回时才可信：缺失版本化输入或已被读取器标为不可执行的旧行都无法
 * 证明接受主体的空／非空，必须走批次级耐久中断而不是伪造空 closed。这里只核对耐久载体本身是否存在
 * 可复验的冻结输入，绝不据今日配置重新解码或补齐。
 */
function historicalCarrierReadable(execution: {
  readonly workflowInput?: unknown;
  readonly workflowInputInvalid?: unknown;
}): boolean {
  return (
    execution.workflowInputInvalid === undefined &&
    execution.workflowInput !== undefined
  );
}

function completeManagedStoreDisposition(
  item: WorkItemDisposition,
  dispositionKey: string,
  storedArtifact: ManagedSourceArtifactCheckpoint,
): WorkItemDisposition {
  if (item.key !== dispositionKey) return item;
  return {
    ...item,
    status: "completed",
    effectReference: storedArtifact.location.address,
  };
}

/** 同角色多候选只公开稳定的选择序号，不公开提供方获取坐标或内部候选标识。 */
function sourceArtifactDispositionKey(
  effect: "acquire" | "store",
  candidates: readonly SourceArtifactCandidate[],
  selectionIndex: number,
  prefix = "source-artifact",
): string {
  const candidate = candidates[selectionIndex];
  if (candidate === undefined)
    throw new Error("Source-artifact disposition selection is unavailable");
  const roleCandidates = candidates.filter(
    (selected) => selected.role === candidate.role,
  );
  if (roleCandidates.length === 1)
    return `${prefix}.${effect}:${candidate.role}`;
  const roleOrdinal = candidates
    .slice(0, selectionIndex + 1)
    .filter((selected) => selected.role === candidate.role).length;
  return `${prefix}.${effect}:${candidate.role}:${roleOrdinal}`;
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
      relationship.participants.every(
        (participant) =>
          entityIds.has(participant.entityId) &&
          (participant.mentionIds === undefined ||
            participant.mentionIds.every((mentionId) =>
              resolvedMentionIds.has(mentionId),
            )),
      ),
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

/**
 * 耐久账本已把该 operation 绑定到一份原执行。内部哨兵只在监督器建立可跟踪执行之前抛出，
 * 调用方据此沿用原身份，而不是把这次请求当成失败重放。
 */
class DurableInformationFulfillmentBound extends Error {
  readonly executionId: string;

  constructor(executionId: string) {
    super(`信息履行计划已绑定执行 ${executionId}`);
    this.executionId = executionId;
  }
}

/** 耐久账本已写下该计划的终局中断处置；同一份远程工作不再按今日事实重算或重放。 */
class DurableInformationFulfillmentInterrupted extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

class ResumeExecutionBusyError extends Error {
  constructor() {
    super("刷新记录正在由另一个进程继续");
  }
}

/**
 * 一条执行在一次续跑里的耐久持有者声明时长。逐条恢复与库扫描父续跑共用这一份，因此竞争
 * 的一方要么接到「正在被继续」，要么在对方终态或声明到期后接手。
 */
const resumeLeaseMilliseconds = 30_000;

/**
 * 取消意图在目录子登记的原子窗口内落地：本次不创建子执行，也不虚构工作项。它是协调
 * 循环的正常终止信号，不是失败。
 */
export class LibraryScanCancelledBeforeChildError extends Error {
  readonly parentExecutionId: string;

  constructor(parentExecutionId: string) {
    super("库扫描已取消，此目录不再开始观察");
    this.parentExecutionId = parentExecutionId;
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

/**
 * 一个终态失败来源补充项是否具备可靠的重试依据：形状完整（当前来源与精确规范地址均在）
 * 且其 producer 属于该执行创建时冻结的兼容坐标。缺依据的旧／畸形项既不公开为可重试，也不
 * 借全局今日能力伪称 retry——这是 R3 边界严校与 R4 无采集诚实投影共用的同一判据。
 */
function sourceEnrichmentFailureIsRetryable(
  evidence: RecognitionEvidence,
  capabilityCoordinates: readonly string[],
): boolean {
  return (
    evidence.sourceIdentity !== undefined &&
    evidence.sourceAddress !== undefined &&
    capabilityCoordinates.includes(capabilityCoordinate(evidence.producer))
  );
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

function selectedIdentityMetadataPolicies(
  accepted: Pick<AcceptedAssetState, "entity" | "sourceAssociations">,
  configuration: MetadataPolicyConfiguration | undefined,
  representativeId: string,
): readonly MetadataPolicy[] {
  if (configuration === undefined) return [];
  if (configuration.version.length === 0)
    throw new Error("Metadata Policy configuration version is empty");
  const definitions = new Map(
    configuration.policies.map((definition) => [definition.id, definition]),
  );
  if (definitions.size !== configuration.policies.length)
    throw new Error("Metadata Policy configuration has duplicate identifiers");
  const selected = configuration.select(accepted);
  if (new Set(selected).size !== selected.length)
    throw new Error("Metadata Policy selection contains duplicate identifiers");
  return selected.flatMap((policyId) => {
    const definition = definitions.get(policyId);
    if (definition === undefined)
      throw new Error(
        `Metadata Policy selection references unknown policy ${policyId}`,
      );
    if (definition.metadataUsageContext !== "asset.ordinary") return [];
    const policy = { ...definition, subjectIds: [representativeId] };
    return [validateMetadataPolicy(policy)];
  });
}

/**
 * 身份合并只折叠资料的读取视图：断言与来源仍保留原属实体，投影时才映射到当前代表。
 * 这里不引入资料优先级，继续交给既有 asset.ordinary 投影器产生值、冲突和依据。
 */
function effectiveIdentityMemberMetadata(
  facts: readonly Pick<
    CatalogueEntityRelationshipFacts["metadataAccepted"][number],
    "accepted"
  >[],
  memberIds: readonly string[],
  representativeId: string,
  configuration: MetadataPolicyConfiguration | undefined,
): {
  readonly values: readonly (EffectiveMetadata & {
    readonly subjectId: string;
  })[];
  readonly conflicts: readonly PublicMetadataConflict[];
  readonly policyBaseline: string;
} {
  const accepted = [
    ...new Map(
      facts.map((fact) => [fact.accepted.entity.id, fact.accepted]),
    ).values(),
  ];
  const metadata = accepted.flatMap((item) =>
    item.metadata.flatMap((assertion) =>
      assertion.target.kind === "entity" &&
      memberIds.includes(assertion.target.entityId)
        ? [
            {
              ...assertion,
              target: { kind: "entity" as const, entityId: representativeId },
            },
          ]
        : [],
    ),
  );
  const sourceRecords = [
    ...new Map(
      accepted
        .flatMap((item) => item.metadataSourceRecords ?? [])
        .map((record) => [record.id, record]),
    ).values(),
  ];
  const policies = [
    ...new Map(
      accepted
        .flatMap((item) =>
          selectedIdentityMetadataPolicies(
            item,
            configuration,
            representativeId,
          ),
        )
        .map((policy) => [policy.id, policy]),
    ).values(),
  ];
  const projection = deriveEffectiveMetadata({
    target: { kind: "entity", entityId: representativeId },
    metadataUsageContext: "asset.ordinary",
    policies,
    sourceRecords,
    metadata,
  });
  return {
    values: projection.values.map((value) => ({
      ...value,
      subjectId: representativeId,
    })),
    conflicts: projection.conflicts.map((conflict) => ({
      subjectId: representativeId,
      property: conflict.property,
      reason:
        conflict.kind === "policy-conflict"
          ? ("policy-conflict" as const)
          : ("multiple-values" as const),
      cardinality: conflict.kind === "policy-conflict" ? "conflicting" : "one",
      metadataUsageContext: conflict.metadataUsageContext,
    })),
    policyBaseline: createHash("sha256")
      .update(
        JSON.stringify({
          configurationVersion: configuration?.version,
          metadataUsageContext: "asset.ordinary",
          policies,
        }),
      )
      .digest("hex"),
  };
}

function publicAccepted(
  accepted: AcceptedAssetState | undefined,
  sourceRecords: readonly Pick<SourceRecord, "id" | "sourceIdentity">[],
  metadataUsageContext: string,
  configuration: MetadataPolicyConfiguration | undefined,
  sourceArtifactCandidates: readonly PublicSourceArtifactCandidate[] = [],
): AssetRefreshInspection["accepted"] | undefined {
  if (accepted === undefined) return undefined;
  const facts = readEffectiveSubject(
    {
      ...accepted,
      id: accepted.entity.id,
      metadataSourceRecords: [
        ...(accepted.metadataSourceRecords ?? []),
        ...sourceRecords,
      ],
    },
    configuration,
    metadataUsageContext,
  );
  const primaryCoverArtifactId = facts.descriptions
    .find(
      (description) =>
        description.target.kind === "entity" &&
        description.target.entityId === accepted.entity.id,
    )
    ?.artifactRoles.find(
      (role) => role.role === "asset.primary-cover",
    )?.artifactId;
  return {
    entity: accepted.entity,
    facts: {
      ...facts,
      sourceArtifacts: sourceArtifactCandidates.map(
        ({ role, mediaType, selectionEvidence }) => ({
          role,
          mediaType,
          ...(selectionEvidence === undefined ? {} : { selectionEvidence }),
        }),
      ),
    },
    sourceAssociations: accepted.sourceAssociations.map((association) => ({
      sourceIdentity: association.sourceIdentity,
      nativeAddress: association.nativeAddress,
    })),
    ...(accepted.recognitionSourceAssociation === undefined
      ? {}
      : {
          recognitionSourceAssociation: {
            sourceIdentity:
              accepted.recognitionSourceAssociation.sourceIdentity,
            nativeAddress: accepted.recognitionSourceAssociation.nativeAddress,
          },
        }),
    ...(sourceArtifactCandidates.length === 0
      ? {}
      : { sourceArtifactCandidates }),
    artifacts: accepted.artifacts,
    locations: accepted.locations,
    blobs: accepted.blobs,
    artifactRevisions: accepted.artifactRevisions,
    ...(accepted.currentLocationRevisions === undefined
      ? {}
      : { currentLocationRevisions: accepted.currentLocationRevisions }),
    artifactAssociations: accepted.artifactAssociations,
    metadata: accepted.metadata,
    ...(primaryCoverArtifactId === undefined ? {} : { primaryCoverArtifactId }),
    ...(accepted.currentRelatedEntities === undefined
      ? {}
      : { currentRelatedEntities: accepted.currentRelatedEntities }),
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
  sourceArtifactCandidates: readonly PublicSourceArtifactCandidate[] = [],
): AssetRefreshInspection {
  const {
    coverAcquisition: _coverAcquisition,
    managedCover: _managedCover,
    sourceArtifactAcquisitions: _sourceArtifactAcquisitions,
    managedSourceArtifacts: _managedSourceArtifacts,
    sourceEnrichments: _sourceEnrichments,
    reusePlan: _reusePlan,
    compatibility: _compatibility,
    sourceAssociationDecision: _sourceAssociationDecision,
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
    sourceArtifactCandidates,
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
    ...(inspection.execution.sourceEnrichments === undefined
      ? {}
      : {
          sourceEnrichments: inspection.execution.sourceEnrichments.map(
            (item) => {
              const disposition = inspection.execution.dispositions.find(
                (candidate) => candidate.key === item.key,
              );
              const status =
                item.stage === "applied"
                  ? ("completed" as const)
                  : item.stage === "failed"
                    ? ("failed" as const)
                    : ("running" as const);
              return {
                subjectId: item.subjectId,
                sourceIdentity: item.evidence.sourceIdentity!,
                sourceAddress: item.evidence.sourceAddress!,
                ...(item.explicitInput === undefined
                  ? {}
                  : { input: item.explicitInput }),
                status,
                ...(disposition?.reason === undefined
                  ? {}
                  : { reason: disposition.reason }),
                canRetry:
                  status === "failed" &&
                  sourceEnrichmentFailureIsRetryable(
                    item.evidence,
                    inspection.execution.compatibility.capabilityCoordinates,
                  ),
              };
            },
          ),
        }),
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

function publicRuleResult(
  result: RecognitionRuleResult,
): PublicRecognitionRuleResult {
  return {
    ruleId: result.ruleId,
    ruleVersion: result.ruleVersion,
    outcome: result.outcome,
    explanation: result.explanation,
  };
}

function publicEvidence(
  evidence: import("@digital/domain").RecognitionEvidence,
): PublicRecognitionEvidence {
  return {
    kind: evidence.kind,
    explanation: evidence.explanation,
    ...("sourceIdentity" in evidence &&
    typeof evidence.sourceIdentity === "string"
      ? { sourceIdentity: evidence.sourceIdentity }
      : {}),
    ...("sourceAddress" in evidence &&
    typeof evidence.sourceAddress === "string"
      ? { sourceAddress: evidence.sourceAddress }
      : {}),
  };
}

function publicSourceAssociationCandidate(
  candidate:
    | SourceAssociationDecisionCandidate
    | EvidenceComparison["sourceCandidates"][number],
): PublicSourceAssociationCandidate {
  const reference =
    "reference" in candidate && typeof candidate.reference === "string"
      ? candidate.reference
      : createHash("sha256")
          .update(
            JSON.stringify({
              outcome: candidate.outcome,
              sourceIdentity: candidate.sourceIdentity,
              nativeAddress: candidate.nativeAddress,
              sourceRecordIds: [...candidate.sourceRecordIds].toSorted(),
              ...("interpretation" in candidate
                ? { interpretation: candidate.interpretation }
                : {}),
              ruleResults: candidate.ruleResults,
              explanation: candidate.explanation,
            }),
          )
          .digest("hex");
  return {
    reference,
    outcome: candidate.outcome,
    sourceIdentity: candidate.sourceIdentity,
    nativeAddress: candidate.nativeAddress,
    explanation: candidate.explanation,
    ruleResults: candidate.ruleResults.map(publicRuleResult),
  };
}

function publicEvidenceComparison(
  comparison: EvidenceComparison,
): PublicEvidenceComparison {
  return {
    observed: comparison.observed.map(publicEvidence),
    manual: comparison.manual.map(publicEvidence),
    sourceCandidates: comparison.sourceCandidates.map(
      publicSourceAssociationCandidate,
    ),
    conflicts: comparison.conflicts,
  };
}

/** 冻结普通显示与确认依据；读取预演时不会重新按当前配置选择历史事实。 */
function freezeChangeImpactFactReads(
  preview: ChangeImpactPreview,
  configuration: MetadataPolicyConfiguration | undefined,
  records: readonly SourceRecord[],
): ChangeImpactPreview {
  // 冻结的消费需求与详情读取采用同一形状：只有普通语境且三类选择器全部为空时，
  // 才省略为无选择器（all-available），与确认后省略需求的普通详情一致；普通语境但
  // 携带选择器的需求必须完整冻结并传入共同读取，令缺失资料、缺失必需角色与单值
  // 冲突裁决与同需求详情一致。绝不在此重新发明元数据求值。
  const keepSelectors =
    preview.requestContext !== undefined &&
    !(
      preview.requestContext.metadataUsageContext ===
        emptyInformationRequirement.metadataUsageContext &&
      preview.requestContext.metadata.length === 0 &&
      preview.requestContext.artifactRoles.length === 0 &&
      preview.requestContext.relationshipTypes.length === 0
    );
  const requestContext = keepSelectors ? preview.requestContext : undefined;
  const project = (
    projection: AssetStateProjection,
    roleDecisions?: readonly import("@digital/domain").ArtifactRoleDecision[],
  ): EffectiveSubjectRead => {
    const retained = projection.readBasis ?? preview.current.readBasis;
    if (retained === undefined)
      throw new Error("变更预演缺少冻结读取依据，请重新形成预演");
    const sourceAssociations = projection.sourceAssociations.map(
      (coordinate) =>
        retained.sourceAssociations.find(
          (association) =>
            association.sourceIdentity === coordinate.sourceIdentity &&
            association.nativeAddress === coordinate.nativeAddress,
        ) ??
        (preview.change.kind === "source-association" &&
        preview.change.proposal.kind !== "retract" &&
        preview.change.proposal.successor.sourceIdentity ===
          coordinate.sourceIdentity &&
        preview.change.proposal.successor.nativeAddress ===
          coordinate.nativeAddress
          ? preview.change.proposal.successor
          : {
              ...coordinate,
              id: `preview-source:${coordinate.sourceIdentity}:${coordinate.nativeAddress}`,
              subjectId: preview.assetId,
            }),
    );
    const targets = new Map(
      (retained.relationshipReadBasis?.targets ?? []).map(
        ({ relationshipId, target }) => [relationshipId, target],
      ),
    );
    for (const relationship of projection.relationships) {
      if (targets.has(relationship.id)) continue;
      const graph = preview.projectedObservedEntityGraphs?.find((candidate) =>
        candidate.relationships.some(
          ({ id: relationshipId }) => relationshipId === relationship.id,
        ),
      );
      if (graph !== undefined) {
        targets.set(relationship.id, {
          kind: "observed",
          assetId: preview.assetId,
          artifactId: graph.artifactId,
          capabilityId: graph.producer.capabilityId,
          coverageId: graph.coverageId,
          sourceSlot: relationship.sourceSlot,
        });
        continue;
      }
      const supporting = records.filter((record) =>
        relationship.sourceRecordIds.includes(record.id),
      );
      const scopes = new Map(
        supporting.map((record) => [
          JSON.stringify([
            record.sourceIdentity,
            record.nativeAddress,
            record.coverage.id,
          ]),
          record,
        ]),
      );
      if (scopes.size !== 1) throw new Error("预演关系缺少唯一的来源支持范围");
      const record = [...scopes.values()][0]!;
      targets.set(relationship.id, {
        kind: "source",
        sourceSubjectId: preview.assetId,
        sourceIdentity: record.sourceIdentity,
        nativeAddress: record.nativeAddress,
        coverageId: record.coverage.id,
        sourceSlot: relationship.sourceSlot,
      });
    }
    const knownEntities = new Map(
      (retained.currentRelatedEntities ?? []).map((entity) => [
        entity.id,
        entity,
      ]),
    );
    const recognitionSourceAssociation = sourceAssociations.find(
      (association) =>
        association.sourceIdentity ===
          projection.recognitionSourceAssociation?.sourceIdentity &&
        association.nativeAddress ===
          projection.recognitionSourceAssociation.nativeAddress,
    );
    const {
      recognitionSourceAssociation: _recognitionSourceAssociation,
      ...facts
    } = projection;
    return readEffectiveSubject(
      {
        ...facts,
        id: preview.assetId,
        sourceAssociations,
        ...(recognitionSourceAssociation === undefined
          ? {}
          : { recognitionSourceAssociation }),
        metadataSourceRecords: [
          ...(retained.metadataSourceRecords ?? []),
          ...records,
        ],
        currentRelatedEntities: projection.entities.map((entity) => ({
          ...entity,
          kind: knownEntities.get(entity.id)?.kind ?? { status: "ordinary" },
        })),
        currentLocationRevisions: retained.currentLocationRevisions ?? [],
        artifactRoleDecisions:
          roleDecisions ?? retained.artifactRoleDecisions ?? [],
        relationshipReadBasis: {
          ...retained.relationshipReadBasis,
          targets: [...targets].map(([relationshipId, target]) => ({
            relationshipId,
            target,
          })),
          decisions: retained.relationshipReadBasis?.decisions ?? [],
          manualRelationshipIds:
            retained.relationshipReadBasis?.manualRelationshipIds ?? [],
        },
      },
      configuration,
      requestContext?.metadataUsageContext,
      requestContext,
    );
  };
  return {
    ...preview,
    facts: {
      current: project(preview.current),
      // 预演的项目状态与确认后普通详情走同一求值，只多这一条待追加的头决定。
      projected:
        preview.change.kind === "artifact-role-decision"
          ? project(
              preview.projected,
              projectArtifactRoleDecisionHead(
                preview.current.readBasis?.artifactRoleDecisions ?? [],
                preview.change.decision,
              ),
            )
          : project(preview.projected),
    },
  };
}

const primaryCoverRole = "asset.primary-cover";
const artifactRoleCandidateBaselineKey = "artifact-role-candidates";

/** 候选引用只由这一冻结三元组导出，交付层因此无法伪造路径、材料图或旧修订。 */
function artifactRoleCandidateReference(
  candidate: ArtifactRoleCandidate,
): string {
  return `cover-candidate_${sha256(
    new TextEncoder().encode(
      JSON.stringify([
        candidate.associationId,
        candidate.artifactId,
        candidate.revisionId,
      ]),
    ),
  )}`;
}

function publicChangeImpactPreview(
  preview: ChangeImpactPreview,
): ChangeImpactPreviewInspection {
  const safeProjection = (
    projection: AssetStateProjection,
  ): PublicAssetStateProjection => {
    const withoutPrivateProvenance = <
      T extends {
        readonly producer?: unknown;
        readonly sourceRecordIds?: unknown;
        readonly authoredBy?: unknown;
        readonly observedArtifactPart?: unknown;
      },
    >(
      value: T,
    ): Omit<
      T,
      "producer" | "sourceRecordIds" | "authoredBy" | "observedArtifactPart"
    > => {
      const {
        producer: _producer,
        sourceRecordIds: _sourceRecordIds,
        authoredBy: _authoredBy,
        observedArtifactPart: _observedArtifactPart,
        ...safe
      } = value;
      return safe;
    };
    const { readBasis: _readBasis, ...publicProjection } = projection;
    return {
      ...publicProjection,
      metadata: projection.metadata.map(withoutPrivateProvenance),
      entities: projection.entities.map(withoutPrivateProvenance),
      entityMentions: projection.entityMentions.map(withoutPrivateProvenance),
      entityResolutionDecisions: projection.entityResolutionDecisions.map(
        withoutPrivateProvenance,
      ),
      relationships: projection.relationships.map(withoutPrivateProvenance),
      artifactRevisions: projection.artifactRevisions.map(
        withoutPrivateProvenance,
      ),
      artifactAssociations: projection.artifactAssociations.map(
        ({ id, target, artifactId, role, sourceAssociationId }) => ({
          id,
          target,
          artifactId,
          role,
          ...(sourceAssociationId === undefined ? {} : { sourceAssociationId }),
        }),
      ),
      locations: projection.locations.map(({ id, artifactId, kind }) => ({
        id,
        artifactId,
        kind,
      })),
    };
  };
  return {
    id: preview.id,
    executionId: preview.executionId,
    assetId: preview.assetId,
    status: preview.status,
    evidenceComparison: publicEvidenceComparison(preview.evidenceComparison),
    sourceAssociations: preview.projected.sourceAssociations,
    ...(preview.projected.recognitionSourceAssociation === undefined
      ? {}
      : {
          recognitionSourceAssociation:
            preview.projected.recognitionSourceAssociation,
        }),
    current: safeProjection(preview.current),
    projected: safeProjection(preview.projected),
    ...(preview.facts === undefined ? {} : { facts: preview.facts }),
    metadataCount: preview.projected.metadata.length,
    entityCount: preview.projected.entities.length,
    mentionCount: preview.projected.entityMentions.length,
    resolutionCount: preview.projected.entityResolutionDecisions.length,
    relationshipCount: preview.projected.relationships.length,
    artifactCount: preview.projected.artifacts.length,
    ...(preview.facts?.projected.descriptions
      .find(
        (description) =>
          description.target.kind === "entity" &&
          description.target.entityId === preview.assetId,
      )
      ?.artifactRoles.find((role) => role.role === "asset.primary-cover")
      ?.artifactId === undefined
      ? {}
      : {
          primaryCoverArtifactId: preview
            .facts!.projected.descriptions.find(
              (description) =>
                description.target.kind === "entity" &&
                description.target.entityId === preview.assetId,
            )!
            .artifactRoles.find((role) => role.role === "asset.primary-cover")!
            .artifactId,
        }),
    blockingConditions:
      preview.facts === undefined && preview.status === "awaiting-confirmation"
        ? [
            ...preview.blockingConditions,
            "此预演缺少冻结的生效读取结果，请重新形成预演",
          ]
        : preview.blockingConditions,
  };
}

function assetStateProjection(
  accepted: AcceptedAssetState,
): AssetStateProjection {
  return {
    readBasis: {
      sourceAssociations: accepted.sourceAssociations,
      metadataSourceRecords: accepted.metadataSourceRecords ?? [],
      ...(accepted.relationshipReadBasis === undefined
        ? {}
        : { relationshipReadBasis: accepted.relationshipReadBasis }),
      currentRelatedEntities: accepted.currentRelatedEntities ?? [],
      currentLocationRevisions: accepted.currentLocationRevisions ?? [],
      // 预演的当前事实必须与 ordinary 读取同义，人工封面决定同样属于已接受状态。
      artifactRoleDecisions: accepted.artifactRoleDecisions ?? [],
    },
    recognitionState:
      accepted.recognitionHeadDecisionId === null ? "unresolved" : "recognized",
    ...(accepted.recognitionHeadDecisionId === null
      ? {}
      : { recognitionDecisionId: accepted.recognitionDecision.id }),
    sourceAssociations: accepted.sourceAssociations.map(
      ({ sourceIdentity, nativeAddress }) => ({
        sourceIdentity,
        nativeAddress,
      }),
    ),
    ...(accepted.recognitionSourceAssociation === undefined
      ? {}
      : {
          recognitionSourceAssociation: {
            sourceIdentity:
              accepted.recognitionSourceAssociation.sourceIdentity,
            nativeAddress: accepted.recognitionSourceAssociation.nativeAddress,
          },
        }),
    metadata: accepted.metadata,
    entities: accepted.entities ?? [],
    entityMentions: accepted.entityMentions ?? [],
    entityResolutionDecisions: accepted.entityResolutionDecisions ?? [],
    relationships: accepted.relationships ?? [],
    artifacts: accepted.artifacts,
    locations: accepted.locations,
    blobs: accepted.blobs,
    artifactRevisions: accepted.artifactRevisions,
    artifactAssociations: accepted.artifactAssociations,
  };
}

function acceptedConcurrencyFingerprint(accepted: AcceptedAssetState): string {
  const sort = <T>(values: readonly T[]) =>
    [...values].toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return JSON.stringify({
    projection: assetStateProjection(accepted),
    sourceAssociations: sort(accepted.sourceAssociations),
    artifactAssociationRecognitionSupports: sort(
      accepted.artifactAssociationRecognitionSupports ?? [],
    ),
  });
}

/**
 * 两条更正路径共用的产物已应用状态投影。一个关联只有在本次结束它的最后一个
 * 可证明支持时才离开当前图；历史事实本身不在这里删除。
 */
function projectSupportedArtifactGraph(input: {
  readonly current: AcceptedAssetState;
  readonly endingSourceAssociationId?: string;
  readonly endingSourceRecordIds?: ReadonlySet<string>;
  readonly endingRecognitionDecisionId?: string;
  readonly retainDeliveredMaterials?: boolean;
  readonly appended?: Pick<
    AssetStateProjection,
    | "artifacts"
    | "locations"
    | "blobs"
    | "artifactRevisions"
    | "artifactAssociations"
  >;
}): Pick<
  AssetStateProjection,
  | "artifacts"
  | "locations"
  | "blobs"
  | "artifactRevisions"
  | "artifactAssociations"
> {
  const supports = input.current.artifactAssociationRecognitionSupports ?? [];
  const currentSourceAssociationIds = new Set(
    input.current.sourceAssociations.map(({ id }) => id),
  );
  const retained = input.current.artifactAssociations.filter((association) => {
    if (
      input.retainDeliveredMaterials === true &&
      association.role === "asset.material-delivered"
    )
      return true;
    const sourceRecordIds = association.sourceRecordIds ?? [];
    const associationSupports = supports.filter(
      ({ associationId }) => associationId === association.id,
    );
    const losesSourceSupport =
      association.sourceAssociationId !== undefined &&
      association.sourceAssociationId === input.endingSourceAssociationId;
    const losesSourceRecordSupport =
      association.role === "asset.primary-cover" &&
      sourceRecordIds.length > 0 &&
      sourceRecordIds.every((sourceRecordId) =>
        input.endingSourceRecordIds?.has(sourceRecordId),
      );
    const hasRemainingRecognitionSupport = associationSupports.some(
      ({ recognitionDecisionId }) =>
        recognitionDecisionId !== input.endingRecognitionDecisionId,
    );
    const hasRemainingSourceSupport =
      association.sourceAssociationId !== undefined &&
      currentSourceAssociationIds.has(association.sourceAssociationId) &&
      !losesSourceSupport;
    if (
      association.sourceAssociationId === undefined &&
      associationSupports.length === 0
    )
      return !losesSourceRecordSupport;
    return hasRemainingRecognitionSupport || hasRemainingSourceSupport;
  });
  const artifactAssociations = [
    ...new Map(
      [...retained, ...(input.appended?.artifactAssociations ?? [])].map(
        (association) => [association.id, association],
      ),
    ).values(),
  ];
  const artifactIds = new Set(
    artifactAssociations.flatMap((association) => [
      association.artifactId,
      ...(association.observedArtifactPart === undefined
        ? []
        : [association.observedArtifactPart.artifactId]),
    ]),
  );
  const artifacts = [
    ...new Map(
      [...input.current.artifacts, ...(input.appended?.artifacts ?? [])]
        .filter(({ id: artifactId }) => artifactIds.has(artifactId))
        .map((artifact) => [artifact.id, artifact]),
    ).values(),
  ];
  const locations = [
    ...new Map(
      [...input.current.locations, ...(input.appended?.locations ?? [])]
        .filter(({ artifactId }) => artifactIds.has(artifactId))
        .map((location) => [location.id, location]),
    ).values(),
  ];
  const artifactRevisions = [
    ...new Map(
      [
        ...input.current.artifactRevisions,
        ...(input.appended?.artifactRevisions ?? []),
      ]
        .filter(({ artifactId }) => artifactIds.has(artifactId))
        .map((revision) => [revision.id, revision]),
    ).values(),
  ];
  const blobDigests = new Set(
    artifactRevisions.map(({ blobDigest }) => blobDigest),
  );
  const blobs = [
    ...new Map(
      [...input.current.blobs, ...(input.appended?.blobs ?? [])]
        .filter(({ digest }) => blobDigests.has(digest))
        .map((blob) => [blob.digest, blob]),
    ).values(),
  ];
  return {
    artifacts,
    locations,
    blobs,
    artifactRevisions,
    artifactAssociations,
  };
}

function otherLegacyArtifactBlockers(
  current: AcceptedAssetState,
  projectedAssociationIds: ReadonlySet<string>,
  endingSourceRecordIds: ReadonlySet<string>,
): readonly string[] {
  const recognized = new Set(
    (current.artifactAssociationRecognitionSupports ?? []).map(
      ({ associationId }) => associationId,
    ),
  );
  return current.artifactAssociations.flatMap((association) =>
    projectedAssociationIds.has(association.id) ||
    association.sourceAssociationId !== undefined ||
    recognized.has(association.id) ||
    (association.role === "asset.primary-cover" &&
      (association.sourceRecordIds?.length ?? 0) > 0 &&
      association.sourceRecordIds?.every((sourceRecordId) =>
        endingSourceRecordIds.has(sourceRecordId),
      ))
      ? []
      : [`产物关联 ${association.id} 缺少可审计支持，不能由本次更正自动终止`],
  );
}

function projectSourceInterpretationFacts(
  interpretation: SourceInterpretationBatch | undefined,
  assetId: string,
) {
  if (interpretation === undefined)
    return {
      metadata: [],
      entities: [],
      entityMentions: [],
      entityResolutionDecisions: [],
      relationships: [],
    };
  const withProducer = <T extends { readonly producer?: CapabilityCoordinate }>(
    value: T,
  ): T & { readonly producer: CapabilityCoordinate } => ({
    ...value,
    producer: value.producer ?? interpretation.producer,
  });
  return {
    metadata: interpretation.metadata.map((assertion) => ({
      ...withProducer(assertion),
      target: {
        kind: "entity" as const,
        entityId: assertion.subjectId ?? assetId,
      },
    })),
    entities: (interpretation.entities ?? []).map(withProducer),
    entityMentions: (interpretation.entityMentions ?? []).map(withProducer),
    entityResolutionDecisions: (
      interpretation.entityResolutionDecisions ?? []
    ).map(withProducer),
    relationships: (interpretation.relationships ?? []).map((relationship) => ({
      ...withProducer(relationship),
      id: relationshipId(relationship, interpretation.sourceIdentity),
      participants: [
        ...(relationship.subjectRole === undefined
          ? []
          : [{ entityId: assetId, role: relationship.subjectRole }]),
        ...relationship.participants,
      ],
    })),
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
  private closing = false;

  constructor(ports: AssetRefreshWorkflowPorts) {
    this.ports = ports;
    const supervisor = ports.invocationSupervisor;
    this.observedRootExecution = new ObservedRootExecution(
      ports.observedRootRegistrations,
      supervisor === undefined
        ? undefined
        : () => supervisor.lease() as OperationLease,
    );
    this.resumeClock = ports.resumeClock ?? systemAutomationClock;
    const librarySnapshot = ports.assetLibrarySnapshot;
    this.sourceArtifactWork = new CheckpointedSourceArtifactWork({
      acquirers: ports.acquirers,
      managedStore: ports.managedStore,
      ...(librarySnapshot === undefined
        ? {}
        : {
            acquirerCapabilityTokensForSourceIdentity: (
              sourceIdentity: string,
            ) =>
              (
                assetLibrarySnapshotSourceScope(librarySnapshot, sourceIdentity)
                  ?.acquirers ?? []
              ).map(assetLibraryCapabilityToken),
          }),
    });
    this.informationFulfillment = new InformationFulfillment({
      readSubjects: async (selection, requirement) =>
        await this.readInformationSubjectFacts(selection, requirement),
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
   *
   * 库范围执行直接沿自己的冻结配置。根执行必须先把每个主体解析到明确的资产库，因为履行
   * 会启动外部获取；多库共享资产绝不取首项配置。
   */
  async fulfillInformation(input: {
    readonly selection: InformationSubjectSelection;
    readonly requirement: InformationRequirement;
    /** 来自已接受父执行的 Application 内部来源信息。 */
    readonly initiation?: InformationFulfillmentInitiation;
    /** 有副作用的浏览所提供的明确资产库。 */
    readonly assetLibraryId?: string;
  }): Promise<InformationReadiness> {
    if (this.informationFulfillmentClosing) {
      return Promise.resolve(
        terminalInformationReadiness(input, "blocked", "信息履行正在关闭"),
      );
    }
    const fulfillment = {
      selection: input.selection,
      requirement: input.requirement,
      ...(input.initiation === undefined
        ? {}
        : { initiation: input.initiation }),
    };
    if (
      this.ports.assetLibrarySnapshot !== undefined ||
      this.ports.assetLibraries === undefined
    )
      return await this.informationFulfillment.fulfill(fulfillment);
    const contexts = await this.resolveInformationLibraryContexts(
      input.selection.subjectIds,
      input.assetLibraryId,
    );
    const readinessBySubject = new Map<string, InformationSubjectReadiness>();
    const groups = new Map<
      string,
      { subjectIds: string[]; snapshot: AssetLibrarySnapshot }
    >();
    const terminal: {
      subjectId: string;
      status: "blocked" | "unavailable";
      reason: string;
    }[] = [];
    for (const context of contexts) {
      if (context.status === "library") {
        const key = assetLibrarySnapshotFingerprint(context.snapshot);
        const group = groups.get(key) ?? {
          subjectIds: [],
          snapshot: context.snapshot,
        };
        group.subjectIds.push(context.subjectId);
        groups.set(key, group);
        continue;
      }
      terminal.push({
        subjectId: context.subjectId,
        status: context.status,
        reason: context.reason,
      });
    }
    for (const group of groups.values()) {
      const readiness = await this.workflowForLibrary(
        group.snapshot,
      ).fulfillInformation({
        selection: { subjectIds: group.subjectIds },
        requirement: input.requirement,
        ...(input.initiation === undefined
          ? {}
          : { initiation: input.initiation }),
      });
      for (const subject of readiness.subjects)
        readinessBySubject.set(subject.subjectId, subject);
    }
    for (const item of terminal) {
      const readiness = terminalInformationReadiness(
        {
          selection: { subjectIds: [item.subjectId] },
          requirement: input.requirement,
          ...(input.initiation === undefined
            ? {}
            : { initiation: input.initiation }),
        },
        item.status,
        item.reason,
      );
      readinessBySubject.set(item.subjectId, readiness.subjects[0]!);
    }
    return {
      requirement: input.requirement,
      subjects: input.selection.subjectIds.map((subjectId) => {
        const subject = readinessBySubject.get(subjectId);
        if (subject === undefined) throw new Error("信息履行遗漏了所选主体");
        return subject;
      }),
    };
  }

  /**
   * 把每个主体解析到它自己的资产库语境。已接受观察材料只落在唯一活动库时才自动补充；
   * 多库共享要求显式选择，零库不启动获取。这里不建立「资产属于库」的领域事实。
   */
  private async resolveInformationLibraryContexts(
    subjectIds: readonly string[],
    assetLibraryId?: string,
  ): Promise<readonly InformationLibraryContext[]> {
    const libraries = this.ports.assetLibraries;
    if (libraries === undefined) throw new Error("当前部署没有资产库配置");
    const facts = this.ports.informationSubjectFactsQueries;
    const observed =
      facts?.readCurrentObservedMaterialRootIds === undefined
        ? []
        : await facts.readCurrentObservedMaterialRootIds({ subjectIds });
    const rootsBySubject = new Map(
      observed.map(({ subjectId, observedRootIds }) => [
        subjectId,
        new Set(observedRootIds),
      ]),
    );
    const active = await libraries.list();
    const snapshotCache = new Map<string, AssetLibrarySnapshot>();
    const snapshotFor = async (
      libraryId: string,
    ): Promise<AssetLibrarySnapshot | undefined> => {
      const cached = snapshotCache.get(libraryId);
      if (cached !== undefined) return cached;
      try {
        const snapshot = await libraries.snapshot(libraryId);
        snapshotCache.set(libraryId, snapshot);
        return snapshot;
      } catch {
        return undefined;
      }
    };
    const contexts: InformationLibraryContext[] = [];
    for (const subjectId of subjectIds) {
      const rootIds = rootsBySubject.get(subjectId);
      const matching = active.filter((library) =>
        library.rootIds.some((rootId) => rootIds?.has(rootId) === true),
      );
      const chosen =
        assetLibraryId === undefined
          ? matching
          : matching.filter((library) => library.id === assetLibraryId);
      if (assetLibraryId !== undefined && chosen.length !== 1) {
        contexts.push({
          subjectId,
          status: "blocked",
          reason: "所选资产库当前不包含该资产，请选择其所属资产库",
        });
        continue;
      }
      if (chosen.length === 0) {
        contexts.push({
          subjectId,
          status: "unavailable",
          reason: "该资产当前不属于任何资产库，因此不会自动补充资料",
        });
        continue;
      }
      if (chosen.length > 1) {
        contexts.push({
          subjectId,
          status: "blocked",
          reason: "该资产同时属于多个资产库，请选择要补充资料的资产库",
        });
        continue;
      }
      const snapshot = await snapshotFor(chosen[0]!.id);
      if (snapshot === undefined) {
        contexts.push({
          subjectId,
          status: "unavailable",
          reason: "该资产所属资产库的配置当前不可用，因此不会自动补充资料",
        });
        continue;
      }
      contexts.push({ subjectId, status: "library", snapshot });
    }
    return contexts;
  }

  /**
   * 阻止继续启动履行。注入的调用监督器持有收尾过程，并由外层组合优先排空。
   */
  close(): Promise<void> {
    this.informationFulfillmentClosing = true;
    this.closing = true;
    // scoped 记忆随产品关闭一起释放；每个 entry 只停止自身的规划，绝不关闭共享资源。
    for (const scoped of this.libraryScoped.values()) void scoped.close();
    this.libraryScoped.clear();
    return Promise.resolve();
  }

  private async readInformationSubjectFacts(
    selection: InformationSubjectSelection,
    requirement: InformationRequirement,
  ): Promise<readonly InformationSubjectFacts[]> {
    const exactFacts = this.ports.informationSubjectFactsQueries;
    if (exactFacts !== undefined) {
      const current = await exactFacts.readCurrentInformationSubjectFacts({
        subjectIds: selection.subjectIds,
      });
      return await Promise.all(
        current
          .filter((facts) => selection.subjectIds.includes(facts.subjectId))
          .map(
            async (facts) =>
              await this.informationFactsFromBasis(
                facts.basis,
                requirement,
                new Map(
                  facts.sourceArtifactCurrency.map((currency) => [
                    currency.associationId,
                    currency.current,
                  ]),
                ),
              ),
          ),
      );
    }
    const accepted = await this.ports.reuseQueries.findAcceptedForSubjects(
      selection.subjectIds,
    );
    return await Promise.all(
      accepted.map(
        async ({ subjectId, accepted: state }) =>
          await this.informationFactsFromBasis(
            { ...state, id: subjectId },
            requirement,
            new Map(),
          ),
      ),
    );
  }

  /**
   * 信息就绪只把已生效且可用的共同读取结果转换为需求可用性：冲突或被排除的描述与关系
   * 不算满足，未生效的图片角色不算可用。未请求的坐标不会进入这一投影。
   */
  private async informationFactsFromBasis(
    basis: SubjectFactBasis,
    requirement: InformationRequirement,
    sourceCurrency: ReadonlyMap<string, boolean>,
  ): Promise<InformationSubjectFacts> {
    const subjectId = basis.id;
    const read = readEffectiveSubject(
      basis,
      this.ports.metadataPolicyConfiguration,
      requirement.metadataUsageContext,
      requirement,
    );
    const description = read.descriptions.find(
      (candidate) =>
        candidate.target.kind === "entity" &&
        candidate.target.entityId === subjectId,
    );
    return {
      subjectId,
      metadata: (description?.metadata ?? [])
        .filter((item) => item.result.status === "resolved")
        .map((item) => ({ property: item.property })),
      relationships: read.relationships
        .filter((relationship) =>
          relationship.participants.some(
            (participant) => participant.entityId === subjectId,
          ),
        )
        .map(({ type }) => ({ type })),
      artifactAssociations: await Promise.all(
        (description?.artifactRoles ?? []).map(async (role) => ({
          role: role.role,
          available: await this.effectiveRoleIsAvailable(
            role,
            read.locations,
            sourceCurrency,
          ),
        })),
      ),
      sourceAssociations: basis.sourceAssociations
        .filter((association) => association.subjectId === subjectId)
        .map(({ id, sourceIdentity }) => ({
          sourceIdentity,
          sourceAssociationId: id,
        })),
    };
  }

  /**
   * 生效图片必须具有可访问的当前位置：观察位置只接受精确确认的当前内容；托管位置保留
   * 真实字节可用性检查，并要求其来源绑定关联仍至少有一个是当前来源头部。
   */
  private async effectiveRoleIsAvailable(
    role: EffectiveArtifactRoleRead,
    locations: readonly CurrentLocationRead[],
    sourceCurrency: ReadonlyMap<string, boolean>,
  ): Promise<boolean> {
    const location =
      role.locationId === undefined
        ? undefined
        : locations.find((candidate) => candidate.id === role.locationId);
    if (location === undefined || location.address === undefined) return false;
    if (location.kind === "observed")
      return location.content.status === "confirmed";
    if (
      !(await this.managedLocationsAreAvailable([
        { address: location.address },
      ]))
    )
      return false;
    const sourceBound = role.associationIds.filter((id) =>
      sourceCurrency.has(id),
    );
    if (sourceBound.length === 0) return true;
    return sourceBound.some((id) => sourceCurrency.get(id) === true);
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

  /**
   * 来自耐久账本的履行请求，其 child 只能由账本在同一条事务里写下并绑定 operation；返回
   * `false` 表示这是普通创建路径。已绑定时抛内部哨兵让调用方沿用原执行身份，已中断时抛耐久
   * 处置，两者都绝不落下第二份效果。
   */
  private async registerDurableInformationFulfillmentChild(
    execution: WorkflowExecution,
    initiation: MetadataRefreshInitiation | undefined,
    onExecutionStarted: (execution: WorkflowExecution) => void,
  ): Promise<boolean> {
    const durable = initiation?.durableOperation;
    const ledger = this.ports.libraryScanFulfillment;
    if (durable === undefined || ledger === undefined) return false;
    const outcome = await ledger.registerInformationFulfillmentChild({
      parentExecutionId: durable.parentExecutionId,
      operationId: durable.operationId,
      execution,
    });
    switch (outcome.status) {
      case "registered":
        onExecutionStarted(execution);
        return true;
      case "existing":
        throw new DurableInformationFulfillmentBound(outcome.executionId);
      case "interrupted":
        throw new DurableInformationFulfillmentInterrupted(outcome.reason);
    }
  }

  private async startInformationFulfillment(
    plan: InformationFulfillmentPlan,
    initiation?: InformationFulfillmentInitiation,
  ): Promise<InformationFulfillmentStart> {
    if (
      this.ports.assetLibraries !== undefined &&
      this.ports.assetLibrarySnapshot === undefined
    )
      throw new Error("信息履行缺少资产库归属，不启动外部获取");
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
      let started: { readonly id: string };
      try {
        started = await supervisor.invoke(async (control) => {
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
      } catch (error) {
        if (error instanceof DurableInformationFulfillmentBound)
          return {
            status: "pending",
            workflowExecutionId: error.executionId,
          };
        if (error instanceof DurableInformationFulfillmentInterrupted)
          return {
            status: "blocked",
            reason: error.reason,
          };
        throw error;
      }
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
        ...(this.ports.assetLibrarySnapshot === undefined
          ? {}
          : { assetLibrary: this.ports.assetLibrarySnapshot }),
        ...(initiation?.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: initiation.parentExecutionId }),
        ...(initiation?.directoryAuthorizations === undefined
          ? {}
          : { directoryAuthorizations: initiation.directoryAuthorizations }),
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
    if (
      !(await this.registerDurableInformationFulfillmentChild(
        execution,
        initiation,
        onExecutionStarted,
      ))
    ) {
      const startDisposition =
        await this.ports.executionCommands.createExecution(execution);
      if (startDisposition !== "started")
        throw new AutomationExecutionNotStarted(startDisposition);
      onExecutionStarted(execution);
    }
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

  /** 人工选择只修订观察结果的范围，不要求先满足任何自动识别规则。 */
  async inspectLocalIntake(input: {
    readonly registrationId: string;
    readonly executionId?: string;
  }) {
    const execution =
      input.executionId === undefined
        ? (await this.ports.executionQueries.listExecutions()).find(
            (item) =>
              item.operationKind === "scan-filesystem" &&
              !item.dispositions.some(
                (disposition) => disposition.key === "manual-boundary",
              ) &&
              item.resolvedSelection?.filesystemScopes[0]?.observedRoot?.id ===
                input.registrationId,
          )
        : (
            await this.ports.executionQueries.inspectExecution(
              input.executionId,
            )
          )?.execution;
    if (
      execution !== undefined &&
      execution.resolvedSelection?.filesystemScopes[0]?.observedRoot?.id !==
        input.registrationId
    )
      throw new Error("本次检查不属于所选文件位置");
    const snapshot = execution?.snapshot;
    const current =
      snapshot === undefined ? [] : await this.listCurrentCatalogue();
    const files =
      snapshot?.files.map((file) => {
        const address = `${snapshot.root}/${file.relativePath}`;
        const problem = execution?.dispositions.find(
          (disposition) =>
            disposition.status === "failed" &&
            disposition.materialReferences?.includes(file.relativePath),
        );
        return {
          relativePath: file.relativePath,
          size: file.size,
          assetIds: current
            .filter((content) =>
              content.locations.some(
                (location) =>
                  location.kind === "observed" && location.address === address,
              ),
            )
            .map((content) => content.id),
          ...(problem === undefined ? {} : { problem: "无法读取此文件" }),
        };
      }) ?? [];
    for (const relativePath of new Set(
      execution?.dispositions.flatMap((item) =>
        item.status === "failed" ? (item.materialReferences ?? []) : [],
      ) ?? [],
    )) {
      if (files.some((file) => file.relativePath === relativePath)) continue;
      files.push({
        relativePath,
        size: 0,
        problem: "找不到文件或无法读取",
        assetIds: current
          .filter((content) =>
            content.locations.some(
              (location) =>
                location.kind === "observed" &&
                location.address === `${snapshot?.root}/${relativePath}`,
            ),
          )
          .map((content) => content.id),
      });
    }
    const assetIds = new Set(files.flatMap((file) => file.assetIds));
    return {
      execution:
        execution === undefined ? undefined : await this.inspect(execution.id),
      files: [
        ...files,
        ...(snapshot?.diagnostics
          ?.filter(
            (item) =>
              !files.some((file) => file.relativePath === item.relativePath),
          )
          .map((item) => ({
            relativePath: item.relativePath,
            size: 0,
            assetIds: [] as string[],
            problem: "未能检查此位置",
          })) ?? []),
      ],
      contents: current.filter((content) => assetIds.has(content.id)),
    };
  }

  async inspectLocalContent(executionId: string): Promise<LocalContentReview> {
    const prepared =
      await this.ports.executionQueries.inspectExecution(executionId);
    if (
      prepared?.proposal?.basis.kind !== "manual-boundary" ||
      prepared.execution.plannedAssetId === undefined
    )
      throw new Error("未找到待确认的内容，请重新整理");
    const [current] = await this.ports.reuseQueries.findAcceptedForSubjects([
      prepared.execution.plannedAssetId,
    ]);
    return this.localContentReview(
      prepared.execution,
      prepared.proposal,
      current?.accepted,
    );
  }

  async prepareObservedMaterialAssociation(input: {
    readonly targetAssetId: string;
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly relativePaths: readonly string[];
    readonly initiatedBy: string;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<ObservedMaterialAssociationInspection> {
    const persistence = this.ports.observedMaterialAssociationPersistence;
    if (persistence === undefined)
      throw new Error("当前产品未装配观察材料关联能力");
    if (
      !input.targetAssetId ||
      !input.registrationId ||
      !input.initiatedBy.trim() ||
      input.relativePaths.length === 0 ||
      new Set(input.relativePaths).size !== input.relativePaths.length ||
      input.relativePaths.some((relativePath) => !relativePath)
    )
      throw new Error("请选择既有内容和不重复的完整文件");
    const target = (
      await this.ports.reuseQueries.findAcceptedForSubjects([
        input.targetAssetId,
      ])
    )[0];
    if (target === undefined) throw new Error("目标内容不存在或尚未确认");
    const baseline = await persistence.freezeObservedMaterialAssociationTarget(
      input.targetAssetId,
    );
    const initialCheckpoint: ObservedMaterialAssociationCheckpoint = {
      version: "observed-material-association-checkpoint/1",
      state: "created",
      input: {
        targetAssetId: input.targetAssetId,
        registrationId: input.registrationId,
        relativeScope: input.relativeScope,
        relativePaths: [...input.relativePaths].toSorted(),
        initiatedBy: input.initiatedBy.trim(),
      },
      identityBaseline: baseline.identityBaseline,
      materialBaseline: baseline.materialBaseline,
    };
    let execution: WorkflowExecution = {
      id: id("execution"),
      workflowInput: {
        version: "observed-material-association-input/1",
        trigger: "interactive",
        initiatedBy: input.initiatedBy.trim(),
        acceptTrusted: false,
        configurationReferences: [],
        targetAssetId: input.targetAssetId,
        registrationId: input.registrationId,
        relativeScope: input.relativeScope,
        relativePaths: [...input.relativePaths].toSorted(),
      },
      selection: {
        intent: "scan-now",
        informationRequirement: emptyInformationRequirement,
      },
      operationKind: "associate-observed-material",
      status: "running",
      stage: "recognition",
      sourceRecordIds: [],
      compatibility: this.availableCompatibility(),
      dispositions: [],
      materialAssociation: initialCheckpoint,
    };
    await this.ports.executionCommands.createExecution(execution);
    input.onExecutionStarted?.(execution);
    try {
      execution = await this.observedRootExecution.invoke(
        {
          registrationId: input.registrationId,
          relativeScope: input.relativeScope,
          subjects: [
            {
              subjectId: input.targetAssetId,
              explanations: [
                {
                  path: ["observed-material-association", input.targetAssetId],
                },
              ],
            },
          ],
        },
        async (bound) => {
          const registration = await this.ports.observedRootRegistrations.get(
            input.registrationId,
          );
          if (registration === undefined || registration.status !== "active")
            throw new Error("文件位置已停用");
          const observing: WorkflowExecution = {
            ...execution,
            requestedSelection: bound.requestedSelection,
            resolvedSelection: bound.resolvedSelection,
            materialAssociation: {
              ...initialCheckpoint,
              state: "observing",
              registrationDisplayName: registration.displayName,
              input: {
                ...initialCheckpoint.input,
                registrationVersion: registration.configVersion,
              },
            },
          };
          await this.transition(execution, observing);
          execution = observing;
          notifyDurableCheckpoint(input, execution);
          const snapshot =
            await this.ports.observedRootRegistrations.observeBoundScope(
              bound.scope,
            );
          if (!snapshot.complete)
            throw new Error("文件位置观察不完整，请重新检查");
          const selectedPaths = initialCheckpoint.input.relativePaths;
          const selectedFiles = selectedPaths.map((relativePath) => {
            const file = snapshot.files.find(
              (candidate) => candidate.relativePath === relativePath,
            );
            if (file === undefined)
              throw new Error(`所选完整文件不可用：${relativePath}`);
            return file;
          });
          const selectedSnapshot: FilesystemPackageSnapshot = {
            ...snapshot,
            files: selectedFiles,
          };
          const inspecting: WorkflowExecution = {
            ...execution,
            snapshot: selectedSnapshot,
            filesystemSnapshots: [selectedSnapshot],
            materialAssociation: {
              ...execution.materialAssociation!,
              state: "inspecting",
              snapshot: selectedSnapshot,
            },
          };
          await this.transition(execution, inspecting);
          execution = inspecting;
          const observed = await this.inspectWholeObservedMaterials(
            bound.scope,
            selectedSnapshot,
            () => notifyDurableCheckpoint(input, execution, false),
          );
          const proposal: RecognitionProposal = {
            id: id("recognition-proposal"),
            boundaries: bindRecognitionMaterialBoundaries({
              snapshot: selectedSnapshot,
              boundRoot: bound.scope.root,
              relativePaths: selectedPaths,
            }),
            basis: {
              kind: "manual-boundary",
              proposedBy: input.initiatedBy.trim(),
              observationSnapshotId: selectedSnapshot.id,
              materialReferences: selectedPaths,
              revisesProposalIds: [],
              metadata: [],
              evidence: observed.evidence,
            },
            ruleResults: [],
            observedArtifactAssociations: selectedPaths.map(
              (observedArtifactReference) => ({
                observedArtifactReference,
                role: "asset.material-delivered" as const,
              }),
            ),
            observedArtifactRevisions: observed.revisions,
          };
          const accepted = createAcceptedRecognition({
            proposal,
            snapshot: selectedSnapshot,
            managedArtifacts: [],
            asset: target.accepted.entity,
            ...(this.ports.observedRootRegistrations.objectIdentityContract ===
            undefined
              ? {}
              : {
                  objectIdentityContract:
                    this.ports.observedRootRegistrations.objectIdentityContract,
                }),
          });
          const submission: ObservedMaterialAssociationSubmission = {
            proposal,
            recognitionDecision: accepted.recognitionDecision,
            artifacts: accepted.artifacts,
            locations: accepted.locations,
            blobs: uniqueObservedMaterialBlobs(accepted.blobs),
            artifactRevisions: accepted.artifactRevisions,
            artifactAssociations: accepted.artifactAssociations,
            projections: observedMaterialAssociationProjections(
              proposal,
              selectedSnapshot,
              accepted,
            ),
            supports: accepted.artifactAssociations
              .filter(({ target }) => target.kind === "entity")
              .map((association) => ({
                associationId: association.id,
                recognitionDecisionId: accepted.recognitionDecision.id,
              })),
          };
          validateObservedMaterialAssociationSubmission(submission);
          const waiting: WorkflowExecution = {
            ...execution,
            materialAssociation: {
              ...execution.materialAssociation!,
              state: "awaiting-confirmation",
              submission,
            },
          };
          await this.transition(execution, waiting);
          execution = waiting;
          notifyDurableCheckpoint(input, execution);
          return execution;
        },
      );
    } catch (error) {
      rethrowWorkflowLifecycle(error);
      const latest =
        (await this.ports.executionQueries.inspectExecution(execution.id))
          ?.execution ?? execution;
      if (latest.status === "running") {
        const failed: WorkflowExecution = {
          ...latest,
          status: "failed",
          stage: "failed",
          outcome: "failed",
          reason: errorMessage(error),
          materialAssociation: {
            ...latest.materialAssociation!,
            state: "failed",
          },
        };
        await this.ports.executionCommands.finishExecution(latest, failed);
      }
      throw error;
    }
    return await this.inspectObservedMaterialAssociation(execution.id);
  }

  async inspectObservedMaterialAssociation(
    executionId: string,
  ): Promise<ObservedMaterialAssociationInspection> {
    const inspection =
      await this.ports.executionQueries.inspectExecution(executionId);
    const execution = inspection?.execution;
    const checkpoint = execution?.materialAssociation;
    if (execution === undefined || checkpoint === undefined)
      throw new Error("未找到观察材料关联记录");
    const proposal = checkpoint.submission?.proposal;
    const basis = proposal?.basis;
    const target = (
      await this.ports.reuseQueries.findAcceptedForSubjects([
        checkpoint.input.targetAssetId,
      ])
    )[0];
    if (target === undefined) throw new Error("目标内容不再可用");
    if (checkpoint.state === "accepted") {
      const audits =
        await this.ports.observedMaterialAssociationPersistence!.auditObservedMaterialAssociations(
          [
            ...new Map(
              checkpoint.submission!.projections.map((projection) => [
                projection.associationId,
                projection,
              ]),
            ).values(),
          ],
        );
      const auditedAssociationIds = audits
        .map((audit) => audit.association.id)
        .toSorted();
      if (
        proposal === undefined ||
        checkpoint.decisionId !==
          checkpoint.submission!.recognitionDecision.id ||
        checkpoint.submission!.recognitionDecision.proposalId !== proposal.id ||
        JSON.stringify(auditedAssociationIds) !==
          JSON.stringify([...(checkpoint.associationIds ?? [])].toSorted()) ||
        audits.some(
          (audit) =>
            !audit.supports.some(
              (support) =>
                support.decision.id === checkpoint.decisionId &&
                support.proposal.id === proposal.id,
            ),
        )
      )
        throw new Error("观察材料关联的耐久领域审计链不完整");
    }
    const title = target.accepted.metadata.find(
      (metadata) => metadata.property === "asset.title",
    )?.value;
    const byReference = new Map(
      (proposal?.observedArtifactRevisions ?? []).map((revision) => [
        revision.observedArtifactReference,
        revision,
      ]),
    );
    const artifactByReference = new Map(
      (checkpoint.snapshot?.files ?? []).map((file, index) => [
        file.relativePath,
        checkpoint.submission?.artifacts[index],
      ]),
    );
    return {
      executionId,
      status: checkpoint.state,
      ...(execution.reason === undefined ? {} : { reason: execution.reason }),
      ...(checkpoint.state === "stale"
        ? { failure: "material-stale" as const }
        : checkpoint.state === "failed"
          ? { failure: "unavailable" as const }
          : checkpoint.state === "interrupted"
            ? { failure: "interrupted" as const }
            : {}),
      target: {
        id: checkpoint.input.targetAssetId,
        ...(title === undefined ? {} : { title }),
      },
      observedRoot: {
        id: checkpoint.input.registrationId,
        ...(checkpoint.registrationDisplayName === undefined
          ? {}
          : { displayName: checkpoint.registrationDisplayName }),
        relativeScope: checkpoint.input.relativeScope,
      },
      files: checkpoint.input.relativePaths.map((relativePath) => {
        const revision = byReference.get(relativePath);
        return {
          relativePath,
          byteLength: revision?.blob.byteLength ?? 0,
          digest: revision?.blob.digest ?? "",
          mediaType: revision?.blob.mediaType ?? "application/octet-stream",
          disposition:
            artifactByReference.get(relativePath) !== undefined &&
            checkpoint.submission?.artifacts.some((artifact) =>
              target.accepted.artifacts.some(
                (current) => current.id === artifact.id,
              ),
            )
              ? ("existing-artifact" as const)
              : ("new-artifact" as const),
          formatValid: revision !== undefined,
        };
      }),
      proposal: {
        id: proposal?.id ?? "",
        proposedBy:
          basis?.kind === "manual-boundary"
            ? basis.proposedBy
            : checkpoint.input.initiatedBy,
        materials: checkpoint.input.relativePaths.map((relativePath) => ({
          relativePath,
          role: "asset.material-delivered" as const,
        })),
      },
      ...(checkpoint.confirmedBy === undefined
        ? {}
        : { confirmedBy: checkpoint.confirmedBy }),
      ...(checkpoint.decisionId === undefined
        ? {}
        : { decisionId: checkpoint.decisionId }),
      ...(checkpoint.associationIds === undefined
        ? {}
        : { associationIds: checkpoint.associationIds }),
    };
  }

  async confirmObservedMaterialAssociation(input: {
    readonly executionId: string;
    readonly confirmedBy: string;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<ObservedMaterialAssociationInspection> {
    return await this.confirmObservedMaterialAssociationWithClaim(input);
  }

  private async confirmObservedMaterialAssociationWithClaim(
    input: {
      readonly executionId: string;
      readonly confirmedBy: string;
      readonly onCheckpoint?: (execution: WorkflowExecution) => void;
      readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
    },
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<ObservedMaterialAssociationInspection> {
    if (!input.confirmedBy.trim()) throw new Error("确认者不能为空");
    const inspected = await this.ports.executionQueries.inspectExecution(
      input.executionId,
    );
    let execution = inspected?.execution;
    let checkpoint = execution?.materialAssociation;
    if (execution === undefined || checkpoint?.submission === undefined)
      throw new Error("未找到待确认的观察材料关联");
    if (execution.status !== "running")
      return await this.inspectObservedMaterialAssociation(input.executionId);
    if (
      checkpoint.state !== "awaiting-confirmation" &&
      checkpoint.state !== "confirmation-recorded" &&
      checkpoint.state !== "revalidating"
    )
      throw new Error("观察材料关联当前不能确认");
    if (checkpoint.state === "awaiting-confirmation") {
      const recorded: WorkflowExecution = {
        ...execution,
        materialAssociation: {
          ...checkpoint,
          state: "confirmation-recorded",
          confirmedBy: input.confirmedBy.trim(),
          decisionId: checkpoint.submission.recognitionDecision.id,
          associationIds: checkpoint.submission.artifactAssociations.map(
            (association) => association.id,
          ),
        },
      };
      await this.transition(execution, recorded, resumeClaim);
      execution = recorded;
      checkpoint = recorded.materialAssociation!;
      notifyDurableCheckpoint(input, execution);
    } else if (checkpoint.confirmedBy !== input.confirmedBy.trim()) {
      throw new Error("观察材料关联必须由原确认者继续");
    }
    const expected = checkpoint.submission!;
    try {
      await this.observedRootExecution.invoke(
        {
          registrationId: checkpoint.input.registrationId,
          relativeScope: checkpoint.input.relativeScope,
          subjects: [
            {
              subjectId: checkpoint.input.targetAssetId,
              explanations: [
                {
                  path: [
                    "observed-material-association",
                    checkpoint.input.targetAssetId,
                  ],
                },
              ],
            },
          ],
        },
        async (bound) => {
          if (
            bound.resolvedSelection.filesystemScopes[0]?.observedRoot
              .configVersion !== checkpoint!.input.registrationVersion
          )
            throw new ObservedMaterialStaleError("文件位置已变化，请重新准备");
          const revalidating: WorkflowExecution = {
            ...execution!,
            materialAssociation: {
              ...checkpoint!,
              state: "revalidating",
            },
          };
          await this.transition(execution!, revalidating, resumeClaim);
          execution = revalidating;
          checkpoint = revalidating.materialAssociation!;
          notifyDurableCheckpoint(input, execution);
          const snapshot =
            await this.ports.observedRootRegistrations.observeBoundScope(
              bound.scope,
            );
          if (!snapshot.complete)
            throw new Error("文件位置观察不完整，无法确认材料关联");
          const selected: FilesystemPackageSnapshot = {
            ...snapshot,
            files: checkpoint.input.relativePaths.map((relativePath) => {
              const file = snapshot.files.find(
                (candidate) => candidate.relativePath === relativePath,
              );
              if (file === undefined)
                throw new ObservedMaterialStaleError(
                  `所选完整文件不可用：${relativePath}`,
                );
              return file;
            }),
          };
          if (
            canonicalObservedMaterialObjectIdentity(
              selected.files,
              this.ports.observedRootRegistrations.objectIdentityContract,
            ) !==
            canonicalObservedMaterialObjectIdentity(
              checkpoint.snapshot?.files ?? [],
              this.ports.observedRootRegistrations.objectIdentityContract,
            )
          )
            throw new ObservedMaterialStaleError(
              "所选文件对象身份或别名关系已变化，请重新准备",
            );
          const observed = await this.inspectWholeObservedMaterials(
            bound.scope,
            selected,
            () => notifyDurableCheckpoint(input, execution!, false),
          );
          if (
            canonicalObservedMaterialRevisions(observed.revisions) !==
            canonicalObservedMaterialRevisions(
              expected.proposal.observedArtifactRevisions ?? [],
            )
          )
            throw new ObservedMaterialStaleError("所选文件已变化，请重新准备");
        },
      );
    } catch (error) {
      rethrowWorkflowLifecycle(error);
      const isStale = error instanceof ObservedMaterialStaleError;
      const failed: WorkflowExecution = {
        ...execution,
        status: isStale ? "completed" : "failed",
        stage: isStale ? "completed" : "failed",
        outcome: isStale ? "no-change" : "failed",
        reason: errorMessage(error),
        materialAssociation: {
          ...checkpoint,
          state: isStale ? "stale" : "failed",
        },
      };
      await this.ports.executionCommands.finishExecution(
        execution,
        failed,
        resumeClaim,
      );
      return await this.inspectObservedMaterialAssociation(input.executionId);
    }
    const terminalExecution = (
      state: "accepted" | "no-change" | "stale",
    ): WorkflowExecution => ({
      ...execution!,
      status: "completed",
      stage: "completed",
      outcome: state === "accepted" ? "accepted" : "no-change",
      ...(state === "accepted" ? { proposalId: expected.proposal.id } : {}),
      acceptedAssetId: checkpoint!.input.targetAssetId,
      materialAssociation: { ...checkpoint!, state },
    });
    await this.ports.observedMaterialAssociationPersistence!.commitObservedMaterialAssociation(
      {
        expectedExecution: execution,
        terminalExecutions: {
          accepted: terminalExecution("accepted"),
          noChange: terminalExecution("no-change"),
          stale: terminalExecution("stale"),
        },
        expectedIdentityBaseline: checkpoint.identityBaseline!,
        expectedMaterialBaseline: checkpoint.materialBaseline!,
        observedAuthority: {
          registrationId: checkpoint.input.registrationId,
          registrationVersion: checkpoint.input.registrationVersion!,
        },
        submission: expected,
        ...(resumeClaim === undefined ? {} : { resumeClaim }),
      },
    );
    return await this.inspectObservedMaterialAssociation(input.executionId);
  }

  private async inspectWholeObservedMaterials(
    scope: BoundObservedScope,
    snapshot: FilesystemPackageSnapshot,
    checkpoint: () => void,
  ): Promise<{
    readonly evidence: readonly RecognitionEvidence[];
    readonly revisions: readonly import("@digital/domain").ObservedArtifactRevisionCandidate[];
  }> {
    const evidence: RecognitionEvidence[] = [];
    const revisions: import("@digital/domain").ObservedArtifactRevisionCandidate[] =
      [];
    for (const file of snapshot.files) {
      this.ports.observedRootRegistrations.assertDirectoryOperationLive(scope);
      const { digest: digestValue, byteLength: offset } =
        await this.streamWholeFileDigest(scope, file, checkpoint);
      const inspected: RecognitionEvidence[] = [];
      for (const inspector of this.ports.formatInspectors ?? []) {
        const formatSource = await this.openObservedByteSource(
          scope,
          file.relativePath,
        );
        try {
          inspected.push(
            ...bindRecognitionEvidenceOutputToProducer(
              await inspector.inspect({
                observedArtifactReference: file.relativePath,
                byteSource: formatSource,
              }),
              inspector.capability,
              inspector.relationshipDefinitions,
            ),
          );
        } finally {
          await formatSource.close();
        }
      }
      const inspectedRevision = inspected
        .map((item) => item.inspection?.revision)
        .find(
          (revision) =>
            revision?.digest === digestValue && revision.byteLength === offset,
        );
      const blob: Blob = {
        digest: digestValue,
        mediaType: inspectedRevision?.mediaType ?? "application/octet-stream",
        byteLength: offset,
      };
      const producer = this.ports.observedRootRegistrations.capability;
      evidence.push({
        kind: "format.whole-file-observation",
        explanation: "完整文件字节已复验",
        producer,
        inspection: {
          observedArtifactReference: file.relativePath,
          revision: blob,
          identifiers: [],
          metadata: [],
          parts: [],
        },
      });
      evidence.push(...inspected);
      revisions.push({
        observedArtifactReference: file.relativePath,
        blob,
        producer,
      });
    }
    return { evidence, revisions };
  }

  /** 流式复验整文件，返回精确摘要与长度；读取期间协作 checkpoint，长度不符即失败。 */
  private async streamWholeFileDigest(
    scope: BoundObservedScope,
    file: FilesystemPackageSnapshot["files"][number],
    checkpoint: () => void,
  ): Promise<{ readonly digest: string; readonly byteLength: number }> {
    const source = await this.openObservedByteSource(scope, file.relativePath);
    const digest = createHash("sha256");
    let offset = 0;
    try {
      for (;;) {
        const chunk = await source.readChunk(offset, 1024 * 1024);
        digest.update(chunk.bytes);
        offset += chunk.bytes.byteLength;
        checkpoint();
        if (chunk.done) break;
      }
    } finally {
      await source.close();
    }
    if (offset !== file.size || offset !== source.byteLength)
      throw new Error(`完整文件在读取期间发生变化：${file.relativePath}`);
    return { digest: digest.digest("hex"), byteLength: offset };
  }

  /**
   * 来源无关的完整字节观察：只断言精确字节修订，不解析容器、编码或字幕语义，也不重复运行专用
   * 格式检查器。用于需要明确离散范围修订的工作项，使正式范围决定预演能引用真实冻结修订。
   */
  private async observeWholeFileRevisions(
    scope: BoundObservedScope,
    snapshot: FilesystemPackageSnapshot,
    checkpoint: () => void,
  ): Promise<{
    readonly evidence: readonly RecognitionEvidence[];
    readonly revisions: readonly import("@digital/domain").ObservedArtifactRevisionCandidate[];
  }> {
    const evidence: RecognitionEvidence[] = [];
    const revisions: import("@digital/domain").ObservedArtifactRevisionCandidate[] =
      [];
    const producer = this.ports.observedRootRegistrations.capability;
    for (const file of snapshot.files) {
      const { digest, byteLength } = await this.streamWholeFileDigest(
        scope,
        file,
        checkpoint,
      );
      const blob: Blob = {
        digest,
        mediaType: "application/octet-stream",
        byteLength,
      };
      evidence.push({
        kind: "format.whole-file-observation",
        explanation: "完整文件字节已复验",
        producer,
        inspection: {
          observedArtifactReference: file.relativePath,
          revision: blob,
          identifiers: [],
          metadata: [],
          parts: [],
        },
      });
      revisions.push({
        observedArtifactReference: file.relativePath,
        blob,
        producer,
      });
    }
    return { evidence, revisions };
  }

  /** 人工选择只修订观察结果的范围，不要求先满足任何自动识别规则。 */
  async prepareLocalContent(input: {
    readonly executionId: string;
    readonly relativePaths: readonly string[];
    readonly name?: string;
    readonly classification?: string;
  }): Promise<LocalContentReview> {
    const observed = await this.ports.executionQueries.inspectExecution(
      input.executionId,
    );
    if (
      observed === undefined ||
      observed.execution.status === "running" ||
      observed.execution.snapshot === undefined
    )
      throw new Error("请先完成文件检查");
    const snapshot = observed.execution.snapshot;
    const paths = new Set(input.relativePaths);
    if (
      !paths.size ||
      paths.size !== input.relativePaths.length ||
      input.relativePaths.some(
        (reference) =>
          !snapshot.files.some((file) => file.relativePath === reference),
      )
    )
      throw new Error("请选择本次检查中可用的完整文件");
    const selected = {
      ...snapshot,
      files: snapshot.files.filter((file) => paths.has(file.relativePath)),
    };
    const scope = observed.execution.resolvedSelection?.filesystemScopes[0];
    if (scope?.observedRoot === undefined || scope.relativeScope === undefined)
      throw new Error("文件位置已失效，请重新检查");
    const evidence = await this.observedRootExecution.invoke(
      {
        registrationId: scope.observedRoot.id,
        relativeScope: scope.relativeScope,
      },
      async (bound) => {
        if (
          bound.resolvedSelection.filesystemScopes[0]?.observedRoot
            ?.configVersion !== scope.observedRoot.configVersion
        )
          throw new Error("文件位置已变化，请重新检查");
        return await this.checkLocalContentFiles(bound.scope, selected);
      },
    );
    const proposal: RecognitionProposal = {
      id: id("recognition-proposal"),
      boundaries: bindRecognitionMaterialBoundaries({
        snapshot: selected,
        boundRoot: scope.observedRoot,
        relativePaths: [...paths],
      }),
      basis: {
        kind: "manual-boundary",
        evidence,
        proposedBy:
          observed.execution.workflowInput?.initiatedBy ?? "interactive",
        observationSnapshotId: snapshot.id,
        materialReferences: [...paths].toSorted(),
        metadata: [
          ...(input.name?.trim()
            ? [{ property: "asset.title", value: input.name.trim() }]
            : []),
          ...(input.classification?.trim()
            ? [
                {
                  property: "asset.content-classification",
                  value: input.classification.trim(),
                },
              ]
            : []),
        ],
        revisesProposalIds: [
          ...new Set([
            ...(observed.proposal === undefined ? [] : [observed.proposal.id]),
            ...(observed.proposal?.basis.kind === "manual-boundary"
              ? observed.proposal.basis.revisesProposalIds
              : []),
            ...(observed.workItemInspections ?? []).flatMap((item) =>
              item.proposal !== undefined &&
              item.workItem.relativePaths.some((reference) =>
                paths.has(reference),
              )
                ? [item.proposal.id]
                : [],
            ),
          ]),
        ],
      },
      ruleResults: [],
    };
    validateRecognitionProposal(proposal);
    const initial = this.localContentExecution(observed.execution, snapshot);
    await this.ports.executionCommands.createExecution(initial);
    const prepared: WorkflowExecution = {
      ...initial,
      status: "completed",
      stage: "completed",
      outcome: "proposal",
      proposalId: proposal.id,
      plannedAssetId: id("entity"),
    };
    await this.ports.executionCommands.finishExecutionWithProposal(
      initial,
      prepared,
      proposal,
    );
    return this.localContentReview(prepared, proposal);
  }

  async confirmLocalContent(input: {
    readonly executionId: string;
  }): Promise<LocalContentReview> {
    const prepared = await this.ports.executionQueries.inspectExecution(
      input.executionId,
    );
    if (
      prepared?.proposal?.basis.kind !== "manual-boundary" ||
      prepared.execution.plannedAssetId === undefined
    )
      throw new Error("未找到待确认的内容，请重新整理");
    const [existing] = await this.ports.reuseQueries.findAcceptedForSubjects([
      prepared.execution.plannedAssetId,
    ]);
    const preparedProposal = prepared.proposal;
    const basis = prepared.proposal.basis;
    const assetId = prepared.execution.plannedAssetId;
    if (existing !== undefined)
      return this.localContentReview(
        prepared.execution,
        prepared.proposal,
        existing.accepted,
      );
    const selected = this.localContentSnapshot(
      prepared.execution,
      prepared.proposal,
    );
    const scope = prepared.execution.resolvedSelection?.filesystemScopes[0];
    if (scope?.observedRoot === undefined || scope.relativeScope === undefined)
      throw new Error("文件位置已失效，请重新检查");
    return await this.observedRootExecution.invoke(
      {
        registrationId: scope.observedRoot.id,
        relativeScope: scope.relativeScope,
      },
      async (bound) => {
        if (
          bound.resolvedSelection.filesystemScopes[0]?.observedRoot
            ?.configVersion !== scope.observedRoot.configVersion
        )
          throw new Error("文件位置已变化，请重新检查");
        const currentEvidence = await this.checkLocalContentFiles(
          bound.scope,
          selected,
        );
        if (
          inspectedRevisionCoordinates(currentEvidence, selected.root) !==
          inspectedRevisionCoordinates(basis.evidence, selected.root)
        )
          throw new Error("所选文件已变化，请重新检查后确认");
        const proposal = attachObservedFormatFacts(
          {
            ...preparedProposal,
            id: id("recognition-proposal"),
            basis: {
              ...basis,
              revisesProposalIds: [
                preparedProposal.id,
                ...basis.revisesProposalIds,
              ],
            },
          },
          basis.evidence,
        );
        const managedObservedParts =
          await this.materializeObservedArtifactParts(
            proposal,
            selected,
            withObservedMaterialImageRequirement(
              prepared.execution.selection.informationRequirement ??
                emptyInformationRequirement,
            ),
            bound.scope,
          );
        const initial = this.localContentExecution(
          prepared.execution,
          requiredFilesystemSnapshot(prepared.execution),
        );
        await this.ports.executionCommands.createExecution(initial);
        const accepted = createAcceptedRecognition({
          proposal,
          snapshot: selected,
          managedArtifacts: [],
          managedObservedParts,
          asset: {
            id: assetId,
            kind: "digital-asset",
          },
          ...(this.ports.observedRootRegistrations.objectIdentityContract ===
          undefined
            ? {}
            : {
                objectIdentityContract:
                  this.ports.observedRootRegistrations.objectIdentityContract,
              }),
        });
        const finished: WorkflowExecution = {
          ...initial,
          status: "completed",
          stage: "completed",
          outcome: "accepted",
          proposalId: proposal.id,
          acceptedAssetId: accepted.entity.id,
        };
        try {
          await this.ports.recognitionAcceptance.acceptRecognition({
            expectedExecution: initial,
            execution: finished,
            accepted,
            observedMaterialAcceptances: observedMaterialAcceptanceBindings({
              accepted,
              snapshot: selected,
              workItemKey: "",
              acceptanceKind: "b-local",
              relativePaths: basis.materialReferences,
            }),
            expectedUnassignedMaterials: accepted.locations.filter(
              (location) => location.kind === "observed",
            ),
          });
        } catch (error) {
          const [concurrent] =
            await this.ports.reuseQueries.findAcceptedForSubjects([
              accepted.entity.id,
            ]);
          await this.transition(
            initial,
            terminal(
              initial,
              concurrent === undefined ? "failed" : "no-change",
              concurrent === undefined ? errorMessage(error) : "该内容已确认",
            ),
          );
          if (concurrent !== undefined)
            return this.localContentReview(
              prepared.execution,
              prepared.proposal!,
              concurrent.accepted,
            );
          throw error;
        }
        return this.localContentReview(
          prepared.execution,
          prepared.proposal!,
          accepted,
        );
      },
    );
  }

  private async checkLocalContentFiles(
    scope: BoundObservedScope,
    selected: FilesystemPackageSnapshot,
  ): Promise<RecognitionEvidence[]> {
    const evidence: RecognitionEvidence[] = [];
    const current =
      await this.ports.observedRootRegistrations.observeBoundScope(scope);
    for (const file of selected.files) {
      const now = current.files.find(
        (candidate) => candidate.relativePath === file.relativePath,
      );
      if (
        now === undefined ||
        now.size !== file.size ||
        now.modifiedAt !== file.modifiedAt ||
        (file.objectIdentity?.kind === "durable" &&
          JSON.stringify(now.objectIdentity) !==
            JSON.stringify(file.objectIdentity))
      )
        throw new Error("所选文件已变化，请重新检查后确认");
      const source = await this.openObservedByteSource(
        scope,
        file.relativePath,
      );
      try {
        for (const inspector of this.ports.formatInspectors ?? [])
          evidence.push(
            ...bindRecognitionEvidenceOutputToProducer(
              await inspector.inspect({
                observedArtifactReference: file.relativePath,
                byteSource: source,
              }),
              inspector.capability,
              inspector.relationshipDefinitions,
            ),
          );
      } catch (cause) {
        throw new Error(`无法完成文件检查：${file.relativePath}`, { cause });
      } finally {
        await source.close();
      }
    }
    return evidence;
  }

  private localContentExecution(
    observed: WorkflowExecution,
    snapshot: FilesystemPackageSnapshot,
  ): WorkflowExecution {
    return {
      id: id("execution"),
      selection: observed.selection,
      snapshot,
      filesystemSnapshots: [snapshot],
      ...(observed.workflowInput === undefined
        ? {}
        : {
            workflowInput: {
              ...observed.workflowInput,
            },
          }),
      ...(observed.requestedSelection === undefined
        ? {}
        : { requestedSelection: observed.requestedSelection }),
      ...(observed.resolvedSelection === undefined
        ? {}
        : { resolvedSelection: observed.resolvedSelection }),
      operationKind: "scan-filesystem",
      status: "running",
      stage: "recognition",
      sourceRecordIds: [],
      compatibility: observed.compatibility,
      dispositions: [{ key: "manual-boundary", status: "completed" }],
    };
  }

  private localContentReview(
    execution: WorkflowExecution,
    proposal: RecognitionProposal,
    accepted?: AcceptedRecognition,
  ): LocalContentReview {
    if (proposal.basis.kind === "manual-boundary")
      proposal = attachObservedFormatFacts(proposal, proposal.basis.evidence);
    const selected = this.localContentSnapshot(execution, proposal);
    const value =
      accepted ??
      createAcceptedRecognition({
        proposal,
        snapshot: selected,
        managedArtifacts: [],
        asset: { id: execution.plannedAssetId!, kind: "digital-asset" },
        ...(this.ports.observedRootRegistrations.objectIdentityContract ===
        undefined
          ? {}
          : {
              objectIdentityContract:
                this.ports.observedRootRegistrations.objectIdentityContract,
            }),
      });
    return {
      executionId: execution.id,
      status: accepted === undefined ? "proposed" : "accepted",
      relativePaths: selected.files.map((file) => file.relativePath),
      content: publicAccepted(
        value,
        [],
        "asset.ordinary",
        this.ports.metadataPolicyConfiguration,
      )!,
    };
  }

  private localContentSnapshot(
    execution: WorkflowExecution,
    proposal: RecognitionProposal,
  ): FilesystemPackageSnapshot {
    const snapshot = requiredFilesystemSnapshot(execution);
    if (proposal.basis.kind !== "manual-boundary")
      throw new Error("人工内容缺少明确范围");
    const references = proposal.basis.materialReferences;
    return {
      ...snapshot,
      files: snapshot.files.filter((file) =>
        references.includes(file.relativePath),
      ),
    };
  }

  /**
   * 一次库扫描的生产边界：父执行与其全部目录条目先在同一事务里耐久落下，并且只有父
   * 身份被公布给调用方；其后由同一个调用按冻结计划顺序观察每个代表目录。等价包含的
   * 目录不再重复物理观察，其结果只按自身前缀投影。取消意图一旦写下就不再登记目录子，
   * 已提交的结果保持不动。
   *
   * 周期触发使用同一个入口与同一本账，只是把范围缩到该目录授权内的有限相对范围：意图
   * 只决定何时触发，不另造一套执行机制。
   */
  async scanAssetLibrary(input: {
    readonly libraryId: string;
    readonly acceptTrusted: boolean;
    readonly initiatedBy?: string | undefined;
    readonly informationRequirement?: InformationRequirement | undefined;
    readonly onProgress?: ((message: string) => void) | undefined;
    readonly onExecutionStarted?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly onHostCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
    readonly automation?:
      | {
          readonly intentId: string;
          readonly trigger: AutomationTrigger;
          readonly observedRootId: string;
          readonly relativeScope: string;
          readonly requestedAt: string;
          readonly policyReferences: readonly string[];
        }
      | undefined;
  }): Promise<LibraryScanRun> {
    const libraries = this.ports.assetLibraries;
    if (libraries === undefined) throw new Error("当前部署没有资产库配置");
    const automation = input.automation;
    const frozen = await libraries.freezeLibraryScan(input.libraryId);
    const snapshot = frozen.snapshot;
    const candidates =
      automation === undefined
        ? frozen.candidates
        : frozen.candidates.filter(
            (candidate) => candidate.id === automation.observedRootId,
          );
    if (candidates.length === 0) {
      if (automation !== undefined)
        throw new ObservedRootUnavailable("该目录已不在此资产库中，请重新设置");
      throw new Error("资产库没有配置可扫描的目录");
    }
    if (automation !== undefined && candidates[0]?.unavailable !== undefined)
      throw new ObservedRootUnavailable(
        candidates[0].unavailable === "inactive"
          ? "该目录已停用，无法自动刷新"
          : "该目录当前不可观察，请检查后重试",
      );
    const plan = planLibraryScanDirectories({
      assetLibraryId: snapshot.id,
      configVersion: snapshot.configVersion,
      roots: candidates,
    });
    const scoped: LibraryScanPlan =
      automation === undefined || automation.relativeScope === "."
        ? plan
        : {
            ...plan,
            // 意图的有限范围只落到它自己的目录条目，绝不放宽成整库观察。
            directories: plan.directories.map((directory) =>
              directory.mode === "execute" &&
              directory.unavailable === undefined
                ? { ...directory, relativeScope: automation.relativeScope }
                : directory,
            ),
          };
    const frozenRoots =
      automation === undefined
        ? frozen.frozenRoots
        : frozen.frozenRoots.filter(
            (root) => root.id === automation.observedRootId,
          );
    const directoryAuthorizations =
      automation === undefined
        ? frozen.directoryAuthorizations
        : frozen.directoryAuthorizations.filter(
            (entry) => entry.observedRootId === automation.observedRootId,
          );
    const parent: WorkflowExecution = {
      id: id("execution"),
      workflowInput: {
        version: "asset-refresh-input/1",
        trigger: automation?.trigger ?? "interactive",
        initiatedBy:
          input.initiatedBy?.trim() ||
          (automation === undefined
            ? "interactive"
            : `automation:${automation.intentId}`),
        acceptTrusted: input.acceptTrusted,
        configurationReferences:
          automation === undefined
            ? [`asset-library/${snapshot.id}/config/${snapshot.configVersion}`]
            : [...automation.policyReferences],
        assetLibrary: snapshot,
        libraryScan: scoped,
        // 冻结的可用观察根权威随父耐久写下；续跑与目录子都只重绑这一份快照。
        observedRoots: frozenRoots,
        // 本票的目录授权账目同样只冻结一次：后续每个效果、提交与恢复都复核这一份，
        // 而不是回看今天的库配置。周期意图只带走它自己那一条目录授权。
        directoryAuthorizations,
      },
      selection: {
        intent: "scan-now",
        informationRequirement:
          input.informationRequirement ?? emptyInformationRequirement,
      },
      operationKind: "scan-asset-library",
      filesystemSnapshots: [],
      status: "running",
      stage: "recognition",
      sourceRecordIds: [],
      compatibility: this.compatibility(),
      dispositions: [{ key: "library-scan-directories", status: "running" }],
      ...(automation === undefined
        ? {}
        : { automationIntentId: automation.intentId }),
    };
    const directoryRecords = scoped.directories.map(
      libraryScanDirectoryFromPlan,
    );
    const disposition = await this.ports.executionCommands.createLibraryScan({
      execution: parent,
      directories: directoryRecords,
      ...(automation === undefined
        ? {}
        : { requestedAt: automation.requestedAt }),
      // 批次壳只在自动化父且部署接好了账本时与现代父同事务落下：它的存在与否就是现代父与
      // 历史无规划父的耐久分界，普通扫描与旧库因此保持原样。
      ...(automation === undefined ||
      this.ports.libraryScanFulfillment === undefined
        ? {}
        : {
            fulfillmentPlannerCoordinate: automatedInformationPlannerCoordinate(
              this.ports.informationPlanner,
            ),
          }),
    });
    if (disposition !== "started")
      throw new AutomationExecutionNotStarted(disposition);
    input.onExecutionStarted?.(parent);
    return await this.executeLibraryScanDirectories({
      parent,
      snapshot,
      plan: scoped,
      frozenRoots,
      ledger: directoryRecords,
      acceptTrusted: input.acceptTrusted,
      ...(input.informationRequirement === undefined
        ? {}
        : { informationRequirement: input.informationRequirement }),
      ...(input.onProgress === undefined
        ? {}
        : { onProgress: input.onProgress }),
      ...(input.onHostCheckpoint === undefined
        ? {}
        : { onHostCheckpoint: input.onHostCheckpoint }),
    });
  }

  /**
   * 库扫描目录的执行与结算：既服务首次扫描（全部条目排队），也服务同一父的显式续跑
   * （读取耐久计划、冻结权威与目录账本继续）。已结算或已取消的条目从账本如实保留、绝不
   * 重新观察；注册但未终结的子按其既有兼容检查点继续；尚未开始的目录只用父冻结的权威绑定
   * 观察，普通库配置变化不会替换它。取消意图一旦写下就停止新的登记，未开始目录如实记取消。
   */
  private async executeLibraryScanDirectories(input: {
    readonly parent: WorkflowExecution;
    readonly snapshot: AssetLibrarySnapshot;
    readonly plan: LibraryScanPlan;
    readonly frozenRoots: readonly ObservedRootSnapshot[];
    readonly ledger: readonly LibraryScanDirectoryRecord[];
    readonly acceptTrusted: boolean;
    /**
     * 续跑路径带来的耐久单持有者权利：父的汇总收尾因此和逐条恢复共用同一条 CAS，失去权利的
     * 那一路写不进父的终态。前台新扫描没有这份权利，保持既有收尾。
     */
    readonly resumeClaim?:
      | (() => { readonly token: string; readonly now: string })
      | undefined;
    readonly informationRequirement?: InformationRequirement | undefined;
    readonly onProgress?: ((message: string) => void) | undefined;
    readonly onHostCheckpoint?:
      | ((execution: WorkflowExecution) => void)
      | undefined;
  }): Promise<LibraryScanRun> {
    if (this.ports.assetLibraries === undefined)
      throw new Error("当前部署没有资产库配置");
    const { parent, snapshot, plan } = input;
    const frozenRootById = new Map(
      input.frozenRoots.map((root) => [root.id, root]),
    );
    // 本次父冻结的目录授权代次：每个目录子只携带自己那一条，后续效果与提交因此逐目录复核，
    // 一个目录被移除不会连带剥夺同库其他目录的既有权威。
    const authorityVersionByRoot = new Map(
      (parent.workflowInput?.directoryAuthorizations ?? []).map((entry) => [
        entry.observedRootId,
        entry.authorityVersion,
      ]),
    );
    const containerPaths = input.frozenRoots
      .map((root) => root.containerPath)
      .filter((value) => value.length > 0);
    // 友好名只用于展示，绝不参与范围或归属：历史父或已移除库的名字查询失败绝不阻断
    // 恢复与账本，缺名走既有的「该目录」回退。
    const displayNameById = await this.scanDirectoryDisplayNames(snapshot.id);
    const entries = new Map(
      plan.directories.map((directory) => [
        directory.directoryKey,
        libraryScanDirectoryFromPlan(directory),
      ]),
    );
    const ledgerBy = new Map(
      input.ledger.map((record) => [record.directoryKey, record]),
    );
    const coveredBy = new Map<string, readonly LibraryScanDirectoryPlan[]>();
    for (const directory of plan.directories) {
      const representative = directory.executedByDirectoryKey;
      if (directory.mode !== "covered" || representative === undefined)
        continue;
      const group = coveredBy.get(representative);
      coveredBy.set(
        representative,
        group === undefined ? [directory] : [...group, directory],
      );
    }
    const results = new Map<string, LibraryScanDirectoryResult>();
    const summaries: LibraryScanEntryOutcome[] = [];
    const settle = async (
      entry: LibraryScanDirectoryRecord,
      summary: LibraryScanEntryOutcome,
      workItems: readonly LibraryScanDirectoryWorkItem[],
      reason?: string,
    ): Promise<void> => {
      const result = libraryScanDirectoryResult({
        entry,
        displayName: displayNameById.get(entry.directoryKey) ?? "该目录",
        summary,
        workItems,
        ...(reason === undefined ? {} : { reason }),
      });
      results.set(entry.directoryKey, result);
      summaries.push(summary);
      await this.ports.executionCommands.recordLibraryScanDirectoryResult(
        libraryScanLedgerWrite({
          parentExecutionId: parent.id,
          result,
          summary,
        }),
      );
      input.onHostCheckpoint?.(parent);
    };
    // 一个代表子只装载一次，covered 条目按自身前缀投影。
    const itemsByChild = new Map<
      string,
      readonly LibraryScanDirectoryWorkItem[]
    >();
    const itemsFor = async (
      childExecutionId: string | undefined,
    ): Promise<readonly LibraryScanDirectoryWorkItem[]> => {
      if (childExecutionId === undefined) return [];
      const cached = itemsByChild.get(childExecutionId);
      if (cached !== undefined) return cached;
      const loaded =
        (await this.inspect(childExecutionId))?.execution.workItems ?? [];
      itemsByChild.set(childExecutionId, loaded);
      return loaded;
    };
    // 保留：从账本如实重建已终结条目的结果与计数，绝不重新观察或改写耐久成果。
    const retain = async (
      record: LibraryScanDirectoryRecord,
      directory: LibraryScanDirectoryPlan,
    ): Promise<void> => {
      const raw = await itemsFor(record.childExecutionId);
      const workItems =
        directory.mode === "covered"
          ? coveredWorkItems(raw, record.coveredPrefix ?? ".")
          : raw;
      const summary: LibraryScanEntryOutcome = {
        outcome: record.outcome ?? "unresolved",
        workItemCount: record.workItemCount,
        unresolvedCount: record.unresolvedCount,
        failedCount: record.failedCount,
      };
      results.set(
        record.directoryKey,
        libraryScanDirectoryResult({
          entry: record,
          displayName: displayNameById.get(record.directoryKey) ?? "该目录",
          summary,
          workItems,
          ...(record.reason === undefined ? {} : { reason: record.reason }),
        }),
      );
      summaries.push(summary);
    };
    // 第一步：先保留父创建时或上一轮已经结算／取消的目录条目（含 covered）。
    for (const directory of plan.directories) {
      const record = ledgerBy.get(directory.directoryKey);
      if (record === undefined) continue;
      if (record.stage !== "settled" && record.stage !== "cancelled") continue;
      await retain(record, directory);
    }
    // 代表在上一轮已结算、但其 covered 目录尚未结算时，从代表的既有子如实投影续上，
    // 绝不把这类目录误当成未开始而记取消。代表的取消或失败由投影共享，不伪造成功。
    for (const directory of plan.directories) {
      if (directory.mode !== "covered") continue;
      if (results.has(directory.directoryKey)) continue;
      const representative = ledgerBy.get(directory.executedByDirectoryKey!);
      if (
        representative === undefined ||
        (representative.stage !== "settled" &&
          representative.stage !== "cancelled")
      )
        continue;
      const coveredEntry: LibraryScanDirectoryRecord = {
        ...entries.get(directory.directoryKey)!,
        ...(representative.childExecutionId === undefined
          ? {}
          : { childExecutionId: representative.childExecutionId }),
      };
      const projected =
        representative.stage === "cancelled"
          ? []
          : coveredWorkItems(
              await itemsFor(representative.childExecutionId),
              directory.coveredByReference ?? ".",
            );
      await settle(
        coveredEntry,
        representative.stage === "cancelled"
          ? libraryScanEntryOutcome({ cancelled: true })
          : libraryScanEntryOutcome({ workItems: projected }),
        projected,
        representative.reason,
      );
    }
    const unavailableReason = (kind: LibraryScanDirectoryUnavailable): string =>
      kind === "missing"
        ? "此目录对应的文件位置配置已缺失，无法观察"
        : kind === "inactive"
          ? "此目录对应的文件位置已停用，无法观察"
          : "此目录对应的文件位置当前不可用，无法观察";
    // 严格完整：在创建任何新目录子之前，先整体预检本次「待新观察」的目录集合——即所有
    // 尚未登记（无 child）、未结算/取消（不在 results）、mode execute 且非 unavailable 的
    // 目录。只要其中一个缺少对应冻结根或版本不符，本次恢复就不得启动集合内任何目录的新观察，
    // 包括自身冻结依据完好的目录，绝不因完好目录排在缺失目录之前而先被观察。已登记子按自身
    // 耐久依据继续、covered 从既结算代表投影、真正 unavailable 走独立失败，均不经此处，也不
    // 要求为不存在的根虚构依据、不借今日字段。
    const frozenSetIncomplete = plan.directories
      .filter(
        (directory) =>
          directory.mode === "execute" &&
          directory.unavailable === undefined &&
          !results.has(directory.directoryKey) &&
          ledgerBy.get(directory.directoryKey)?.childExecutionId === undefined,
      )
      .some((directory) => {
        const root = frozenRootById.get(directory.scopeReference);
        return (
          root === undefined || root.configVersion !== directory.rootVersion
        );
      });
    for (const directory of plan.directories) {
      if (directory.mode !== "execute") continue;
      if (results.has(directory.directoryKey)) continue;
      if (
        (await this.ports.executionQueries.inspectLibraryScan(parent.id))
          ?.cancellationRequested !== undefined
      )
        break;
      const covered = coveredBy.get(directory.directoryKey) ?? [];
      const entry = entries.get(directory.directoryKey)!;
      // 冻结读取时不可用的目录：逐条如实失败，绝不借今日根或猜测归属。
      if (directory.unavailable !== undefined) {
        const reason = unavailableReason(directory.unavailable);
        const summary = libraryScanEntryOutcome({ error: reason });
        await settle(entry, summary, [], reason);
        continue;
      }
      const frozenRoot = frozenRootById.get(directory.scopeReference);
      const record = ledgerBy.get(directory.directoryKey);
      let childId: string | undefined;
      let workItems: readonly LibraryScanDirectoryWorkItem[] = [];
      let error: string | undefined;
      let entryCancelled = false;
      if (record?.childExecutionId !== undefined) {
        // 已登记但未终结的子：按其既有兼容检查点继续，成果如实保留，不伪造成功。
        childId = record.childExecutionId;
        try {
          let execution = (await this.inspect(childId))?.execution;
          if (execution?.status === "running") {
            try {
              await this.resume({
                executionId: childId,
                ...(input.onProgress === undefined
                  ? {}
                  : { onProgress: input.onProgress }),
                ...(input.onHostCheckpoint === undefined
                  ? {}
                  : { onHostCheckpoint: input.onHostCheckpoint }),
              });
            } catch (error_) {
              rethrowWorkflowLifecycle(error_);
              // 另一个进程仍持有这个目录子的有效声明：这既不是该目录失败也不是取消。整段父续跑
              // 就此停下，账本前端不推进，由本次启动对该父的监督在声明终态或到期后重新接手。
              if (error_ instanceof ResumeExecutionBusyError) throw error_;
              // 扫描与领取之间这个子也可能已被竞争者耐久终结，那不属于本次失败：只有它仍在
              // 运行中才把这次错误如实记为该目录的结果。
              const reread = (await this.inspect(childId))?.execution;
              if (reread === undefined || reread.status === "running")
                throw error_;
            }
            execution = (await this.inspect(childId))?.execution;
          }
          if (execution === undefined) error = "未找到该目录的观察记录";
          else if (execution.status === "running")
            error = "目录子尚未到达可继续的持久检查点";
          else if (execution.outcome === "cancelled") entryCancelled = true;
          else if (
            execution.status === "failed" &&
            (execution.outcome === "failed" ||
              execution.outcome === "interrupted")
          )
            error = execution.reason ?? "目录子未能继续完成";
          else workItems = execution.workItems ?? [];
        } catch (error_) {
          rethrowWorkflowLifecycle(error_);
          entryCancelled = errorMessage(error_) === "库扫描已取消";
          if (!entryCancelled) error = errorMessage(error_);
        }
      } else {
        // 新观察必须整体满足本次父冻结的根集合：上面已在启动任何新观察之前判定集合是否
        // 完整。不完整时（例如缺 observedRoots 的旧父，或部分冻结根被删）此处对每个待新
        // 观察目录一律诚实拒绝安全恢复，零新观察、不借今日根或配置、不新造今日字段——包括
        // 自身根完好的目录也一并不启动。已登记子走上面的续跑分支、不可用目录走上面的独立
        // 失败，均不经此处，绝不要求不存在的根。
        if (frozenSetIncomplete) {
          const reason = "此目录缺少本次扫描冻结的观察依据，无法安全恢复";
          const summary = libraryScanEntryOutcome({ error: reason });
          await settle(entry, summary, [], reason);
          for (const candidate of covered) {
            await settle(
              entries.get(candidate.directoryKey)!,
              summary,
              [],
              reason,
            );
          }
          continue;
        }
        try {
          const inspection = await this.workflowForLibrary(
            snapshot,
          ).scanObservedScope({
            assetLibraryId: snapshot.id,
            registrationId: directory.scopeReference,
            relativeScope: directory.relativeScope,
            acceptTrusted: input.acceptTrusted,
            initiatedBy: parent.workflowInput?.initiatedBy,
            informationRequirement: input.informationRequirement,
            onProgress: input.onProgress,
            // 目录子只重绑父冻结的这一份权威，绝不解析今日根替换旧快照。
            libraryScanFrozenRoot: frozenRoot,
            ...(authorityVersionByRoot.has(directory.scopeReference)
              ? {
                  directoryAuthorityVersion: authorityVersionByRoot.get(
                    directory.scopeReference,
                  ),
                }
              : {}),
            // 目录子与父登记原子完成；取消胜出时这里不会留下新的观察执行。
            libraryScanParent: {
              parentExecutionId: parent.id,
              directoryKey: directory.directoryKey,
              coverage: covered.map((candidate) => ({
                scopeReference: candidate.scopeReference,
                rootVersion: candidate.rootVersion,
                relativePrefix: candidate.coveredByReference ?? ".",
              })),
            },
            onExecutionStarted: (child) => {
              childId = child.id;
            },
            onHostCheckpoint: input.onHostCheckpoint,
          });
          childId = inspection.execution.id;
          workItems = inspection.execution.workItems ?? [];
        } catch (error_) {
          rethrowWorkflowLifecycle(error_);
          entryCancelled =
            error_ instanceof LibraryScanCancelledBeforeChildError ||
            (childId !== undefined &&
              (await this.ports.executionQueries.inspectExecution(childId))
                ?.execution.outcome === "cancelled");
          if (!entryCancelled) error = errorMessage(error_);
        }
      }
      const observed: LibraryScanDirectoryRecord = {
        ...entry,
        ...(childId === undefined ? {} : { childExecutionId: childId }),
      };
      const summary = libraryScanEntryOutcome({
        ...(error === undefined ? {} : { error }),
        ...(entryCancelled ? { cancelled: true } : {}),
        workItems,
      });
      const reason = entryCancelled
        ? "库扫描已取消，此目录没有继续观察"
        : error === undefined
          ? undefined
          : sanitizeScanReason(error, containerPaths);
      await settle(observed, summary, workItems, reason);
      for (const candidate of covered) {
        const coveredEntry: LibraryScanDirectoryRecord = {
          ...entries.get(candidate.directoryKey)!,
          ...(childId === undefined ? {} : { childExecutionId: childId }),
        };
        // 代表的观察没有完成时，被覆盖目录如实共享同一结果。
        const projected =
          error === undefined && !entryCancelled
            ? coveredWorkItems(workItems, candidate.coveredByReference ?? ".")
            : [];
        await settle(
          coveredEntry,
          error === undefined && !entryCancelled
            ? libraryScanEntryOutcome({ workItems: projected })
            : summary,
          error === undefined && !entryCancelled ? projected : [],
          reason,
        );
      }
    }
    for (const directory of plan.directories) {
      if (results.has(directory.directoryKey)) continue;
      await settle(
        entries.get(directory.directoryKey)!,
        libraryScanEntryOutcome({ cancelled: true }),
        [],
        "库扫描已取消，此目录没有开始观察",
      );
    }
    const aggregate = summarizeLibraryScan(summaries);
    const current = await this.ports.executionQueries.inspectExecution(
      parent.id,
    );
    if (current === undefined) throw new Error("未找到刷新记录");
    const cancellation = (
      await this.ports.executionQueries.inspectLibraryScan(parent.id)
    )?.cancellationRequested;
    // 父取消从耐久意图与目录账本一致推导：意图存在且确有目录被取消才算本次被取消，
    // 取消到达时已完成的目录保持原结果。
    const parentCancelled =
      cancellation !== undefined &&
      summaries.some((summary) => summary.outcome === "cancelled");
    const unsuccessful =
      aggregate.outcome === "failed" ||
      aggregate.outcome === "cancelled" ||
      aggregate.outcome === "interrupted";
    const finished: WorkflowExecution = {
      ...current.execution,
      status: unsuccessful ? "failed" : "completed",
      stage: unsuccessful ? "failed" : "completed",
      outcome: aggregate.outcome,
      ...(aggregate.outcome === "failed" || aggregate.outcome === "unresolved"
        ? {
            reason: `${aggregate.failedCount + aggregate.unresolvedCount} 个目录没有完成`,
          }
        : {}),
      ...(cancellation === undefined
        ? {}
        : {
            cancellation: {
              requestedBy: cancellation.requestedBy,
              requestedAt: cancellation.requestedAt,
              ...(cancellation.reason === undefined
                ? {}
                : { reason: cancellation.reason }),
            },
          }),
      dispositions: [
        {
          key: "library-scan-directories",
          status:
            parentCancelled || unsuccessful
              ? ("failed" as const)
              : ("completed" as const),
        },
      ],
    };
    await this.finishLibraryScanParent({
      parent: current.execution,
      finished,
      snapshot,
      ...(input.resumeClaim === undefined
        ? {}
        : { resumeClaim: input.resumeClaim }),
    });
    return {
      parentExecutionId: parent.id,
      assetLibraryId: snapshot.id,
      configVersion: snapshot.configVersion,
      outcome: aggregate.outcome,
      cancelled: parentCancelled,
      directories: plan.directories.map(
        (directory) => results.get(directory.directoryKey)!,
      ),
    };
  }

  /**
   * 库扫描父的收尾。现代自动化父在同一条 CAS 事务里落下完整耐久处置与原终态；没有账本的历史父
   * 和普通父保持既有收尾，绝不在这里补造处置。规划只在父仍 running 时做一次、不启动任何效果。
   */
  private async finishLibraryScanParent(input: {
    readonly parent: WorkflowExecution;
    readonly finished: WorkflowExecution;
    readonly snapshot: AssetLibrarySnapshot;
    readonly resumeClaim?:
      | (() => { readonly token: string; readonly now: string })
      | undefined;
  }): Promise<void> {
    const claim = input.resumeClaim?.();
    const ledger = this.ports.libraryScanFulfillment;
    if (ledger === undefined || input.parent.automationIntentId === undefined) {
      await this.ports.executionCommands.finishExecution(
        input.parent,
        input.finished,
        claim,
      );
      return;
    }
    const batch = await ledger.inspectLibraryScanFulfillment(input.parent.id);
    if (batch?.stage !== "awaiting-results") {
      await this.ports.executionCommands.finishExecution(
        input.parent,
        input.finished,
        claim,
      );
      return;
    }
    const planned = await this.planLibraryScanFulfillment(input, batch);
    await ledger.finishLibraryScanWithFulfillmentPlan({
      expectedParent: input.parent,
      finishedParent: input.finished,
      batch: planned,
      ...(claim === undefined ? {} : { resumeClaim: claim }),
    });
  }

  /**
   * 用批次冻结的那一份规则坐标核对当前部署：不相等或读不到规划依据的主体只耐久中断，绝不把
   * 今日规则当作原计划。其余主体用父冻结的库快照做一次无效果规划，完整 requirement 与具体计划
   * 一起留下，child 之后按稳定 operation 身份绑定。
   */
  private async planLibraryScanFulfillment(
    input: {
      readonly parent: WorkflowExecution;
      readonly snapshot: AssetLibrarySnapshot;
    },
    batch: LibraryScanFulfillmentInspection,
  ): Promise<LibraryScanFulfillmentBatchWrite> {
    const planner = this.ports.informationPlanner;
    const subjects: LibraryScanFulfillmentSubjectWrite[] = [];
    const operations: LibraryScanFulfillmentOperationWrite[] = [];
    const accepted = await this.acceptedSubjectsOfLibraryScan(input.parent.id);
    const initiation: InformationFulfillmentInitiation = {
      version: "information-fulfillment-initiation/1",
      parentExecutionId: input.parent.id,
      ...(input.parent.workflowInput?.directoryAuthorizations === undefined
        ? {}
        : {
            directoryAuthorizations:
              input.parent.workflowInput.directoryAuthorizations,
          }),
    };
    for (const subject of accepted) {
      if (
        batch.plannerCoordinate !==
        automatedInformationPlannerCoordinate(planner)
      ) {
        subjects.push({
          subjectId: subject.subjectId,
          disposition: "interrupted",
          reason: "信息履行规划规则已改变，这份扫描不按今日规则补齐",
        });
        continue;
      }
      const requirement =
        planner?.requirementForAcceptedSubject(subject.facts) ??
        input.parent.selection.informationRequirement;
      if (requirement === undefined) {
        subjects.push({
          subjectId: subject.subjectId,
          disposition: "interrupted",
          reason: "该主体没有可复验的信息需求依据，不按今日状态补齐",
        });
        continue;
      }
      try {
        const preparation = await this.workflowForLibrary(
          input.snapshot,
        ).prepareInformation({
          selection: { subjectIds: [subject.subjectId] },
          requirement,
          initiation,
        });
        const prepared = preparation.subjects[0];
        if (prepared === undefined || prepared.subjectId !== subject.subjectId)
          throw new Error("信息履行规划没有覆盖该已接受主体");
        subjects.push({
          subjectId: subject.subjectId,
          disposition: prepared.disposition,
          requirement: prepared.requirement,
          ...(prepared.reason === undefined ? {} : { reason: prepared.reason }),
        });
        for (const plan of prepared.plans)
          operations.push({
            operationId: plan.operationId,
            subjectId: plan.subjectId,
            plan,
          });
      } catch (error_) {
        rethrowWorkflowLifecycle(error_);
        subjects.push({
          subjectId: subject.subjectId,
          disposition: "interrupted",
          reason: `该主体的信息履行规划依据无法读取：${errorMessage(error_)}`,
        });
      }
    }
    return {
      parentExecutionId: input.parent.id,
      plannerCoordinate: batch.plannerCoordinate,
      subjects,
      operations,
    };
  }

  /** 只规划、不启动任何效果；父终态前写下耐久处置的唯一入口。 */
  async prepareInformation(input: {
    readonly selection: InformationSubjectSelection;
    readonly requirement: InformationRequirement;
    readonly initiation?: InformationFulfillmentInitiation;
  }): Promise<InformationFulfillmentPreparation> {
    return await this.informationFulfillment.prepare(input);
  }

  /**
   * 执行一份来自耐久账本的规划。终态收敛只消费账本里的原计划，绝不在这里重新规划；child 由
   * 登记事务按稳定 operation 身份原子绑定，已绑定时沿用原执行而不启动第二份效果。
   */
  async fulfillPreparedInformation(input: {
    readonly preparation: InformationFulfillmentPreparation;
    readonly initiation?: InformationFulfillmentInitiation;
  }): Promise<InformationReadiness> {
    return await this.informationFulfillment.fulfillPrepared(
      input.preparation,
      input.initiation,
    );
  }

  /**
   * 从父与它目录子的耐久结果收集本次扫描已接受的主体并按主体去重。这里只读已经写下的事实，
   * 不按今日配置重新解释归属。
   */
  async acceptedSubjectsOfLibraryScan(
    parentExecutionId: string,
  ): Promise<readonly AcceptedInformationSubject[]> {
    const carriers = [await this.inspect(parentExecutionId)];
    const ledger =
      await this.ports.executionQueries.inspectLibraryScan(parentExecutionId);
    for (const entry of ledger?.directories ?? []) {
      if (entry.mode !== "execute" || entry.childExecutionId === undefined)
        continue;
      carriers.push(await this.inspect(entry.childExecutionId));
    }
    const bySubject = new Map<string, AcceptedInformationSubject>();
    for (const inspection of carriers) {
      for (const accepted of [
        ...(inspection?.accepted === undefined ? [] : [inspection.accepted]),
        ...(inspection?.itemResults ?? []).flatMap((item) =>
          item.accepted === undefined ? [] : [item.accepted],
        ),
      ]) {
        bySubject.set(accepted.entity.id, {
          subjectId: accepted.entity.id,
          facts: accepted.facts,
        });
      }
    }
    return [...bySubject.values()];
  }

  /**
   * 库目录的友好名只用于展示，绝不参与范围或结果归属。历史父的今日配置变化或库被正式
   * 移除时，名字查询不能阻断恢复与检查：任何失败都回退为空表，让既有的「该目录」如实兜底。
   */
  private async scanDirectoryDisplayNames(
    assetLibraryId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const libraries = this.ports.assetLibraries;
    if (libraries === undefined) return new Map();
    try {
      return new Map(
        (await libraries.directories(assetLibraryId)).map((directory) => [
          directory.id,
          directory.displayName,
        ]),
      );
    } catch {
      return new Map();
    }
  }

  /**
   * 显式续跑同一库扫描父：先取得这份执行自己的耐久单持有者权利，再从父耐久写下的冻结计划、
   * 冻结观察根权威与目录账本继续，绝不按今日库配置重选目录或补字段。普通配置版本变化不阻止
   * 原父继续，真实的路径漂移由目录子重绑冻结权威时诚实拒绝。已结算目录与已终结子保持原成果，
   * 未开始目录用同一冻结权威观察。
   */
  private async resumeAssetLibraryScan(
    parent: WorkflowExecution,
    input: {
      readonly onProgress?: ((message: string) => void) | undefined;
      readonly onHostCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
    },
  ): Promise<AssetRefreshInspection> {
    if (this.ports.assetLibraries === undefined)
      throw new Error("当前部署没有资产库配置");
    const decoded =
      parent.workflowInput === undefined
        ? ({ valid: false, reason: "库扫描记录缺少版本化输入" } as const)
        : decodeAssetRefreshWorkflowInput(parent.workflowInput);
    if (!decoded.valid) throw new Error(decoded.reason);
    const plan = decoded.input.libraryScan;
    const snapshot = decoded.input.assetLibrary;
    if (plan === undefined || snapshot === undefined)
      throw new Error("库扫描记录缺少冻结计划或资产库配置");
    const ledger = await this.ports.executionQueries.inspectLibraryScan(
      parent.id,
    );
    if (ledger === undefined) throw new Error("未找到库扫描目录账本");
    return await this.withScanParentResumeOwnership(
      parent.id,
      async (claim) => {
        await this.executeLibraryScanDirectories({
          parent,
          snapshot,
          plan,
          frozenRoots: decoded.input.observedRoots ?? [],
          ledger: ledger.directories,
          acceptTrusted: decoded.input.acceptTrusted,
          resumeClaim: claim,
          ...(parent.selection.informationRequirement === undefined
            ? {}
            : {
                informationRequirement: parent.selection.informationRequirement,
              }),
          ...(input.onProgress === undefined
            ? {}
            : { onProgress: input.onProgress }),
          ...(input.onHostCheckpoint === undefined
            ? {}
            : { onHostCheckpoint: input.onHostCheckpoint }),
        });
        return await this.inspectResumedPublic(parent.id);
      },
    );
  }

  /**
   * 库扫描父的续跑与逐条恢复共用同一份耐久单持有者权利：领取失败（另一进程仍持有未过期声明）
   * 时零写入退出，因此任何时刻只有一个推进者碰目录账本前端，也不会替同一个父第二次收尾。
   * 权利在续跑期间按同一租约心跳续期，无论正常返回还是抛出都释放。
   */
  private async withScanParentResumeOwnership<T>(
    executionId: string,
    advance: (
      resumeClaim: () => { readonly token: string; readonly now: string },
    ) => Promise<T>,
  ): Promise<T> {
    const claimToken = randomUUID();
    const leaseExpiry = () =>
      new Date(
        this.resumeClock.now().getTime() + resumeLeaseMilliseconds,
      ).toISOString();
    const disposition = await this.ports.recoveryLease.claimResumeExecution({
      executionId,
      token: claimToken,
      now: this.resumeClock.now().toISOString(),
      expiresAt: leaseExpiry(),
    });
    if (disposition === "terminal")
      throw new Error("只有未完成的刷新记录可以继续");
    if (disposition === "busy") throw new ResumeExecutionBusyError();
    let claimLost = false;
    let heartbeat: Promise<void> | undefined;
    const renew = async (): Promise<void> => {
      await heartbeat;
      if (claimLost) throw new Error("继续刷新租约已失效");
      const current = this.resumeClock.now();
      const renewed = await this.ports.recoveryLease.renewResumeExecutionClaim({
        executionId,
        token: claimToken,
        now: current.toISOString(),
        expiresAt: new Date(
          current.getTime() + resumeLeaseMilliseconds,
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
    }, resumeLeaseMilliseconds / 3);
    try {
      return await advance(() => ({
        token: claimToken,
        now: this.resumeClock.now().toISOString(),
      }));
    } finally {
      this.resumeClock.clearInterval(timer);
      await heartbeat;
      await this.ports.recoveryLease.releaseResumeExecutionClaim({
        executionId,
        token: claimToken,
      });
    }
  }

  /**
   * 一次库扫描的完整检查：目录归属、阶段与计数来自父的耐久账本，工作项只在子权威记录
   * 上读取，covered 条目按自身前缀投影。友好名只用于显示，绝不参与范围或结果归属。
   */
  async inspectAssetLibraryScan(
    parentExecutionId: string,
  ): Promise<LibraryScanInspectionDetail | undefined> {
    const ledger =
      await this.ports.executionQueries.inspectLibraryScan(parentExecutionId);
    if (ledger === undefined) return undefined;
    // 友好名只用于显示，绝不参与范围或结果归属；历史父或已移除库不得被名字查询阻断检查。
    const displayNameById = await this.scanDirectoryDisplayNames(
      ledger.assetLibraryId,
    );
    // 一个代表子可能同时服务多个 covered 条目，其工作项只装载一次。
    const itemsByChild = new Map<
      string,
      readonly LibraryScanDirectoryWorkItem[]
    >();
    const directories: LibraryScanDirectoryInspection[] = [];
    for (const entry of ledger.directories) {
      let items: readonly LibraryScanDirectoryWorkItem[] = [];
      if (entry.childExecutionId !== undefined) {
        const cached = itemsByChild.get(entry.childExecutionId);
        if (cached === undefined) {
          items =
            (await this.inspect(entry.childExecutionId))?.execution.workItems ??
            [];
          itemsByChild.set(entry.childExecutionId, items);
        } else items = cached;
      }
      directories.push({
        ...entry,
        displayName: displayNameById.get(entry.directoryKey) ?? "该目录",
        workItems:
          entry.mode === "covered"
            ? coveredWorkItems(items, entry.coveredPrefix ?? ".")
            : items,
      });
    }
    return { ...ledger, directories };
  }

  /**
   * 父取消：取消意图先耐久写下，此后任何目录子都不能再登记；仍运行的子沿既有取消语义
   * 取消，已提交或在这一瞬间自行进入终态的结果如实保留。未开始目录的记账与完整汇总由
   * 协调调用在其安全检查点上完成。
   */
  async cancelAssetLibraryScan(input: {
    readonly parentExecutionId: string;
    readonly requestedBy: string;
    readonly reason?: string | undefined;
    readonly requestedAt?: string | undefined;
  }): Promise<LibraryScanInspectionDetail> {
    if (input.requestedBy.trim().length === 0)
      throw new Error("取消库扫描需要请求者");
    const requestedAt = input.requestedAt ?? new Date().toISOString();
    const requestedBy = input.requestedBy.trim();
    const requested =
      await this.ports.executionCommands.requestLibraryScanCancellation({
        parentExecutionId: input.parentExecutionId,
        requestedBy,
        requestedAt,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    if (requested.status === "absent") throw new Error("未找到刷新记录");
    if (
      requested.status === "recorded" ||
      requested.status === "already-requested"
    ) {
      for (const childExecutionId of requested.childExecutionIds) {
        try {
          await this.cancel({
            executionId: childExecutionId,
            requestedBy,
            requestedAt,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          });
        } catch (error) {
          // 子可能在意图写下的瞬间已完成；它已有的领域事实不属于本次取消。
          rethrowWorkflowLifecycle(error);
        }
      }
    }
    const inspection = await this.inspectAssetLibraryScan(
      input.parentExecutionId,
    );
    if (inspection === undefined) throw new Error("未找到刷新记录");
    return inspection;
  }

  /**
   * 未形成提案的观察材料的有界查询：结果给出形成该观察的冻结根与相对范围，人工入口据此
   * 校验确切归属，绝不回落到“第一个活动目录”。
   */
  async unrecognizedLibraryScanObservations(input: {
    readonly parentExecutionId?: string | undefined;
    readonly assetLibraryId?: string | undefined;
    readonly directoryKey?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly UnrecognizedLibraryScanObservation[]> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new Error("未识别观察查询必须有界");
    return await this.ports.executionQueries.listUnrecognizedLibraryScanObservations(
      {
        ...(input.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: input.parentExecutionId }),
        ...(input.assetLibraryId === undefined
          ? {}
          : { assetLibraryId: input.assetLibraryId }),
        ...(input.directoryKey === undefined
          ? {}
          : { directoryKey: input.directoryKey }),
        limit,
      },
    );
  }

  /**
   * 按库冻结配置复用的 scoped workflow。共享持久化、产物存储、来源连接与调用监督器仍由
   * 组合根单例持有，这里只持有范围视图与它自己的履行记忆。已接受父执行的派生履行同样
   * 沿父快照，因此配置编辑不会改变它规划出的子执行能力集合。
   */
  private readonly libraryScoped = new Map<string, AssetRefreshWorkflow>();

  workflowForLibrary(snapshot: AssetLibrarySnapshot): AssetRefreshWorkflow {
    if (this.closing)
      throw new Error("资产刷新工作流正在关闭，不再规划新的库范围执行");
    const key = `${snapshot.id}\u0000${snapshot.configVersion}\u0000${assetLibrarySnapshotFingerprint(snapshot)}`;
    const existing = this.libraryScoped.get(key);
    if (existing !== undefined) return existing;
    const frozenSourceTokens = (
      pick: (
        source: AssetLibrarySnapshotSource,
      ) => readonly AssetLibraryCapability[],
    ): ReadonlySet<string> =>
      new Set(
        snapshot.sources.flatMap((source) =>
          pick(source).map(assetLibraryCapabilityToken),
        ),
      );
    // scoped 过滤只按完整坐标匹配：同 ID 但实现或契约版本不同的接缝一律留在范围外。
    const directoryInterpreterTokens = new Set(
      snapshot.directoryInterpreters.map(assetLibraryCapabilityToken),
    );
    const recognizerTokens = new Set(
      snapshot.recognizers.map(assetLibraryCapabilityToken),
    );
    const collectorTokens = frozenSourceTokens(({ collectors }) => collectors);
    const sourceCandidateInterpreterTokens = frozenSourceTokens(
      ({ sourceCandidateInterpreters }) => sourceCandidateInterpreters,
    );
    const sourceInterpreterTokens = frozenSourceTokens(
      ({ sourceInterpreters }) => sourceInterpreters,
    );
    const sourceAssociationInterpreterTokens = frozenSourceTokens(
      ({ sourceAssociationInterpreters }) => sourceAssociationInterpreters,
    );
    const acquirerTokens = frozenSourceTokens(({ acquirers }) => acquirers);
    const informationFulfillmentTokens = frozenSourceTokens(
      ({ informationFulfillments }) => informationFulfillments,
    );
    const scoped = new AssetRefreshWorkflow({
      ...this.ports,
      assetLibrarySnapshot: snapshot,
      directoryInterpreters: this.ports.directoryInterpreters.filter((item) =>
        directoryInterpreterTokens.has(
          assetLibraryCapabilityToken(item.capability),
        ),
      ),
      recognizers: this.ports.recognizers.filter((item) =>
        recognizerTokens.has(assetLibraryCapabilityToken(item.capability)),
      ),
      collectors: this.ports.collectors.filter((item) =>
        collectorTokens.has(assetLibraryCapabilityToken(item.capability)),
      ),
      sourceInterpreters: this.ports.sourceInterpreters.filter((item) =>
        sourceInterpreterTokens.has(
          assetLibraryCapabilityToken(item.capability),
        ),
      ),
      ...(this.ports.sourceAssociationCandidateInterpreters === undefined
        ? {}
        : {
            sourceAssociationCandidateInterpreters:
              this.ports.sourceAssociationCandidateInterpreters.filter((item) =>
                sourceCandidateInterpreterTokens.has(
                  assetLibraryCapabilityToken(item.capability),
                ),
              ),
          }),
      ...(this.ports.sourceAssociationInterpreters === undefined
        ? {}
        : {
            sourceAssociationInterpreters:
              this.ports.sourceAssociationInterpreters.filter((item) =>
                sourceAssociationInterpreterTokens.has(
                  assetLibraryCapabilityToken(item.capability),
                ),
              ),
          }),
      acquirers: this.ports.acquirers.filter((item) =>
        acquirerTokens.has(assetLibraryCapabilityToken(item.capability)),
      ),
      ...(this.ports.informationFulfillmentCapabilities === undefined
        ? {}
        : {
            informationFulfillmentCapabilities:
              this.ports.informationFulfillmentCapabilities.filter((item) =>
                informationFulfillmentTokens.has(
                  assetLibraryCapabilityToken(item.declaration),
                ),
              ),
          }),
    });
    this.libraryScoped.set(key, scoped);
    return scoped;
  }

  private async assertAssetLibraryCurrent(): Promise<void> {
    const snapshot = this.ports.assetLibrarySnapshot;
    if (
      snapshot !== undefined &&
      !(await this.ports.assetLibraries?.isCurrent(snapshot))
    )
      throw new Error("资产库配置已变更或移除，请重新扫描");
  }

  async scanObservedScope(input: {
    readonly assetLibraryId?: string;
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly acceptTrusted: boolean;
    readonly libraryScanParent?: LibraryScanChildCoordinates | undefined;
    readonly libraryScanFrozenRoot?: ObservedRootSnapshot | undefined;
    /** 库扫描父冻结的本目录授权代次；新扫描由当前授权取得。 */
    readonly directoryAuthorityVersion?: number | undefined;
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
    if (
      input.libraryScanFrozenRoot === undefined &&
      this.ports.assetLibraries !== undefined &&
      this.ports.assetLibrarySnapshot === undefined
    ) {
      const snapshot = await this.ports.assetLibraries.snapshotForRoot({
        registrationId: input.registrationId,
        ...(input.assetLibraryId === undefined
          ? {}
          : { libraryId: input.assetLibraryId }),
      });
      return await this.workflowForLibrary(snapshot).scanObservedScope({
        ...input,
        // 解析到库之后，本次调用的 I/O 权威只能来自该库自己的目录授权；另一库共享同一
        // 物理根不会为该目录续权。
        assetLibraryId: snapshot.id,
      });
    }
    // 携带冻结权威时，授权来自这份快照本身：普通库配置版本变化绝不阻止原目录子继续，
    // 真实的路径漂移由 rebindFrozenScope 的当前权威检查诚实拒绝，而不是在此静默换根。
    if (input.libraryScanFrozenRoot === undefined)
      await this.assertAssetLibraryCurrent();
    if (
      input.libraryScanFrozenRoot === undefined &&
      this.ports.assetLibrarySnapshot !== undefined &&
      !this.ports.assetLibrarySnapshot.rootIds.includes(input.registrationId)
    )
      throw new Error("所选目录不属于此资产库");
    return await this.observedRootExecution.invoke(
      input,
      async (resolved) =>
        await this.runFilesystemRecognition({
          scope: resolved.scope,
          requestedSelection: resolved.requestedSelection,
          resolvedSelection: resolved.resolvedSelection,
          ...(resolved.directoryAuthorityVersion === undefined
            ? {}
            : {
                directoryAuthorityVersion: resolved.directoryAuthorityVersion,
              }),
          ...(resolved.libraryScanParent === undefined
            ? {}
            : { libraryScanParent: resolved.libraryScanParent }),
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
    readonly sourceInput: Readonly<Record<string, string>>;
    readonly informationRequirement?: InformationRequirement;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<AssetRefreshInspection> {
    const capability = this.requireSourceAddressingCapability(
      input.sourceIdentity,
    );
    const normalized = capability.normalize(input.sourceInput);
    if (normalized.status === "invalid") throw new Error(normalized.reason);
    return await this.rescrapeCanonicalObservedScope({
      ...input,
      sourceAddress: normalized.evidence.sourceAddress!,
      sourceProducer: capability.capability,
    });
  }

  async rescrapeCurrentObservedScope(input: {
    readonly subjectId: string;
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly informationRequirement?: InformationRequirement;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<AssetRefreshInspection> {
    const [current] = await this.ports.reuseQueries.findAcceptedForSubjects([
      input.subjectId,
    ]);
    const association = current?.accepted.recognitionSourceAssociation;
    if (current?.subjectId !== input.subjectId || association === undefined)
      throw new Error("当前内容没有可重新刮削的识别来源");
    return await this.rescrapeCanonicalObservedScope({
      ...input,
      sourceIdentity: association.sourceIdentity,
      sourceAddress: association.nativeAddress,
    });
  }

  private async rescrapeCanonicalObservedScope(input: {
    readonly subjectId: string;
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly sourceIdentity: string;
    readonly sourceAddress: string;
    readonly sourceProducer?: CapabilityCoordinate;
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
          directedSourceProducer: input.sourceProducer,
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

  private async directedRecognitionObservedScope(input: {
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly sourceIdentity: string;
    readonly sourceAddress: string;
    readonly informationRequirement?: InformationRequirement;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
    readonly sourceProducer?: CapabilityCoordinate;
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
        directedSourceProducer: input.sourceProducer,
        informationRequirement: input.informationRequirement,
        ...(input.onExecutionStarted === undefined
          ? {}
          : { onExecutionStarted: input.onExecutionStarted }),
        onProgress: input.onProgress,
        onCheckpoint: input.onCheckpoint,
        onHostCheckpoint: input.onHostCheckpoint,
      });
    });
  }

  async directedRecognitionSourceInputObservedScope(input: {
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly sourceIdentity: string;
    readonly sourceInput: Readonly<Record<string, string>>;
    readonly informationRequirement?: InformationRequirement;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<AssetRefreshInspection> {
    const capability = this.requireSourceAddressingCapability(
      input.sourceIdentity,
    );
    const normalized = capability.normalize(input.sourceInput);
    if (normalized.status === "invalid") throw new Error(normalized.reason);
    return await this.directedRecognitionObservedScope({
      registrationId: input.registrationId,
      relativeScope: input.relativeScope,
      sourceIdentity: input.sourceIdentity,
      sourceAddress: normalized.evidence.sourceAddress!,
      sourceProducer: capability.capability,
      ...(input.informationRequirement === undefined
        ? {}
        : { informationRequirement: input.informationRequirement }),
      ...(input.onExecutionStarted === undefined
        ? {}
        : { onExecutionStarted: input.onExecutionStarted }),
      ...(input.onProgress === undefined
        ? {}
        : { onProgress: input.onProgress }),
      ...(input.onCheckpoint === undefined
        ? {}
        : { onCheckpoint: input.onCheckpoint }),
      ...(input.onHostCheckpoint === undefined
        ? {}
        : { onHostCheckpoint: input.onHostCheckpoint }),
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
      sourceAssociations: current.accepted.sourceAssociations,
      ...(current.accepted.recognitionSourceAssociation === undefined
        ? {}
        : {
            recognitionSourceAssociation:
              current.accepted.recognitionSourceAssociation,
          }),
    };
  }

  /**
   * 读取一个精确已接受主体的交付层安全当前事实。这里刻意不通过浏览工作流历史实现。
   */
  async inspectCurrentCatalogueSubject(
    subjectId: string,
    informationRequirement?: InformationRequirement,
    assetLibraryId?: string,
  ): Promise<EffectiveSubjectRead | undefined> {
    const page = await this.listCurrentCataloguePage({
      subjectIds: [subjectId],
      ...(informationRequirement === undefined
        ? {}
        : { informationRequirement }),
      ...(assetLibraryId === undefined ? {} : { assetLibraryId }),
    });
    return page.items.find((item) => item.id === subjectId);
  }

  /**
   * 只读投影所选精确主体真正导致资料冲突的候选值。这里保留与共同生效读取完全相同的
   * 一次精确主体查询依据，只透传已报告冲突的候选断言值、来源身份及可用支持记录标识；
   * 绝不重新裁决、不透传被排除断言，也不把来源关联历史当作冲突证据。主体不存在返回
   * undefined，让交付层明确未找到。
   */
  async inspectSubjectConflictEvidence(
    subjectId: string,
    informationRequirement?: InformationRequirement,
  ): Promise<
    | {
        readonly id: string;
        readonly conflicts: readonly SubjectConflictEvidence[];
      }
    | undefined
  > {
    const queries = this.ports.currentCatalogueQueries;
    if (queries === undefined)
      throw new Error("Current Catalogue page query is not configured");
    if (subjectId.length === 0)
      throw new Error("Current Catalogue subject selection is invalid");
    const page = await queries.listCurrentCataloguePage({
      subjectIds: [subjectId],
    });
    const accepted = page.items.find((item) => item.entity.id === subjectId);
    if (accepted === undefined) return undefined;
    return {
      id: subjectId,
      conflicts: subjectConflictEvidence(
        { ...accepted, id: accepted.entity.id },
        this.ports.metadataPolicyConfiguration,
        informationRequirement?.metadataUsageContext,
      ),
    };
  }

  /**
   * 公开从任一实体读取同一关系所连接的已收录内容；返回的是普通产品安全投影，
   * 不把持久化表或来源记录暴露给交付层。
   */
  async inspectCurrentCatalogueEntity(entityId: string): Promise<
    | {
        readonly entity: PublicRelationshipParticipantEntity;
        readonly relationships: readonly PublicCatalogueEntityRelationship[];
        readonly metadata: readonly (EffectiveMetadata & {
          readonly subjectId: string;
        })[];
        readonly metadataConflicts: readonly PublicMetadataConflict[];
        readonly accepted: readonly EffectiveSubjectRead[];
      }
    | undefined
  > {
    const found =
      await this.ports.relationshipTraversalQueries?.findCurrentRelationshipParticipant(
        entityId,
      );
    if (found === undefined) return undefined;
    const projected = found.accepted.map(({ accepted }) =>
      readEffectiveSubject(
        { ...accepted, id: accepted.entity.id },
        this.ports.metadataPolicyConfiguration,
      ),
    );
    const metadataProjection = effectiveIdentityMemberMetadata(
      found.metadataAccepted,
      found.memberIds,
      found.entity.id,
      this.ports.metadataPolicyConfiguration,
    );
    const title = metadataProjection.values.find(
      (value) =>
        value.subjectId === found.entity.id && value.property === "asset.title",
    )?.value;
    return {
      entity:
        typeof title === "string"
          ? { ...found.entity, label: title }
          : found.entity,
      relationships: found.relationships,
      // 公开读取必须沿用产品资料策略，不能把原始断言当成当前展示资料。
      metadata: metadataProjection.values,
      metadataConflicts: metadataProjection.conflicts,
      accepted: projected,
    };
  }

  /** 类型声明来自已部署模块，读取不触发来源连接或采集。 */
  relationshipTypeDefinitions(): readonly RelationshipTypeDefinition[] {
    return [
      ...this.ports.sourceInterpreters,
      ...(this.ports.formatInspectors ?? []),
    ].flatMap((provider) => provider.relationshipDefinitions ?? []);
  }

  /** 建立本地相关身份而不虚构来源身份。 */
  async createLocalRelatedEntity(input: {
    readonly commitmentId: string;
    readonly label: string;
    readonly actorId: string;
  }): Promise<RelatedEntityIdentity> {
    if (input.label.trim().length === 0)
      throw new Error("相关实体名称不能为空");
    if (input.commitmentId.trim().length === 0)
      throw new Error("本地身份提交坐标不能为空");
    const identity = this.requireRelatedEntityIdentity();
    return await identity.createLocalRelatedEntity({
      id: `related-entity_${createHash("sha256")
        .update(`${input.actorId}\u0000${input.commitmentId}`)
        .digest("hex")}`,
      commitmentId: input.commitmentId,
      label: input.label,
      actorId: input.actorId,
    });
  }

  async findRelatedEntities(
    label: string,
  ): Promise<readonly RelatedEntityIdentity[]> {
    return await this.requireRelatedEntityIdentity().findRelatedEntities(label);
  }

  async previewEntityIdentityMerge(input: {
    readonly retainedEntityId: string;
    readonly mergedEntityId: string;
  }): Promise<EntityIdentityMergePreview> {
    const preview =
      await this.requireRelatedEntityIdentity().previewEntityIdentityMerge(
        input,
      );
    const traversal = this.ports.relationshipTraversalQueries;
    const facts =
      traversal === undefined
        ? []
        : await Promise.all(
            preview.members.map(
              async (memberId) =>
                await traversal.findCurrentRelationshipParticipant(memberId),
            ),
          );
    const metadataProjection = effectiveIdentityMemberMetadata(
      facts.flatMap((found) => found?.metadataAccepted ?? []),
      preview.members,
      preview.retainedEntityId,
      this.ports.metadataPolicyConfiguration,
    );
    return {
      ...preview,
      metadata: metadataProjection.values.map(
        ({ subjectId, property, value }) => ({
          entityId: subjectId,
          property,
          value,
        }),
      ),
      metadataConflicts: metadataProjection.conflicts,
      metadataPolicyBaseline: metadataProjection.policyBaseline,
    };
  }

  async applyEntityIdentityMerge(input: {
    readonly commitmentId: string;
    readonly actorId: string;
    readonly preview: EntityIdentityMergePreview;
  }): Promise<"applied" | "stale"> {
    const identity = this.requireRelatedEntityIdentity();
    const impactFingerprint = entityIdentityMergeImpactFingerprint(
      input.preview,
    );
    const replay = await identity.findEntityIdentityMergeReplay({
      actorId: input.actorId,
      commitmentId: input.commitmentId,
    });
    if (replay !== undefined) {
      if (
        replay.retainedEntityId !== input.preview.retainedEntityId ||
        replay.mergedEntityId !== input.preview.mergedEntityId ||
        replay.impactFingerprint !== impactFingerprint
      )
        throw new Error("身份合并提交坐标与既有内容冲突");
      return "applied";
    }
    const current = await this.previewEntityIdentityMerge({
      retainedEntityId: input.preview.retainedEntityId,
      mergedEntityId: input.preview.mergedEntityId,
    });
    if (entityIdentityMergeImpactFingerprint(current) !== impactFingerprint)
      return "stale";
    return await identity.applyEntityIdentityMerge({
      id: id("entity-identity-merge"),
      ...input,
      impactFingerprint,
    });
  }

  async undoEntityIdentityMerge(input: {
    readonly commitmentId: string;
    readonly actorId: string;
    readonly preview: EntityIdentityMergePreview;
  }): Promise<"applied" | "stale"> {
    return await this.requireRelatedEntityIdentity().undoEntityIdentityMerge({
      id: id("entity-identity-merge-retraction"),
      ...input,
    });
  }

  /** 预演与采用使用同一份持久化生效投影。 */
  async previewRelationshipChange(input: {
    readonly changes: readonly RelationshipChange[];
  }): Promise<RelationshipChangePreview> {
    this.validateRelationshipChanges(input.changes);
    const persistence = this.ports.relationshipDecisionPersistence;
    if (persistence === undefined) throw new Error("关系更正能力尚未配置");
    const preview = await persistence.previewRelationshipChange(input);
    // 合并投影可能把原本不同的参与者收敛为同一实体，仍须走既有结构校验。
    this.validateRelationshipChanges(preview.changes);
    return preview;
  }

  async applyRelationshipChange(input: {
    readonly actorId: string;
    readonly preview: RelationshipChangePreview;
  }): Promise<"applied" | "stale"> {
    this.validateRelationshipChanges(input.preview.changes);
    const persistence = this.ports.relationshipDecisionPersistence;
    if (persistence === undefined) throw new Error("关系更正能力尚未配置");
    return await persistence.applyRelationshipChange({
      id: id("relationship-decision"),
      actorId: input.actorId,
      preview: input.preview,
    });
  }

  private validateRelationshipChanges(
    changes: readonly RelationshipChange[],
  ): void {
    if (changes.length === 0) throw new Error("关系更正不能为空");
    for (const change of changes) {
      if (change.kind !== "create" && change.kind !== "replace") {
        if (change.targetRelationshipId.trim().length === 0)
          throw new Error("关系决定必须点名当前关系事实");
        continue;
      }
      const relationship = change.relationship;
      if (relationship.type.trim().length === 0)
        throw new Error("更正关系必须包含类型和参与者");
      if (
        relationship.participants.length < 2 ||
        relationship.participants.some(
          ({ entityId, role }) =>
            entityId.trim().length === 0 || role.trim().length === 0,
        ) ||
        new Set(
          relationship.participants.map(
            ({ entityId, role }) => `${entityId}\u0000${role}`,
          ),
        ).size !== relationship.participants.length ||
        relationship.qualifiers?.some(
          ({ key, value }) =>
            key.trim().length === 0 || value.trim().length === 0,
        )
      )
        throw new Error("更正关系结构无效");
      const definition = this.relationshipTypeDefinitions().find(
        (item) => item.id === change.definitionId,
      );
      if (definition === undefined) throw new Error("关系类型尚未声明");
      validateRelationshipDefinition(definition, relationship);
    }
  }

  /** 人工与来源解析共用同一个可读取的当前指称投影。 */
  async resolveEntityMentionManually(input: {
    readonly mentionId: string;
    readonly entityId: string;
    readonly actorId: string;
    readonly baseline: string;
  }): Promise<"applied" | "stale"> {
    return await this.requireRelatedEntityIdentity().resolveEntityMentionManually(
      {
        id: id("manual-entity-resolution"),
        ...input,
      },
    );
  }

  async inspectEntityMentionResolution(
    mentionId: string,
  ): Promise<EntityMentionResolution> {
    return await this.requireRelatedEntityIdentity().inspectEntityMentionResolution(
      mentionId,
    );
  }

  async retractEntityMentionResolution(input: {
    readonly mentionId: string;
    readonly actorId: string;
    readonly baseline: string;
  }): Promise<"applied" | "stale"> {
    return await this.requireRelatedEntityIdentity().retractEntityMentionResolution(
      {
        id: id("manual-entity-resolution-retraction"),
        ...input,
      },
    );
  }

  private requireRelatedEntityIdentity(): RelatedEntityIdentityPersistence {
    if (this.ports.relatedEntityIdentity === undefined)
      throw new Error("相关实体身份能力未配置");
    return this.ports.relatedEntityIdentity;
  }

  /** 精确更正入口即使在身份未决后也可检查稳定资产与来源历史。 */
  async inspectCorrectionSubject(subjectId: string) {
    return await this.ports.reuseQueries.inspectSourceAssociationHistory(
      subjectId,
    );
  }

  /** 交付层读取静态产品组合真正支持的来源输入，不推断或解析来源语法。 */
  sourceInputRequirements(): readonly SourceInputRequirement[] {
    return (this.ports.sourceAddressingCapabilities ?? []).map(
      ({ inputRequirement }) => inputRequirement,
    );
  }

  private requireSourceAddressingCapability(sourceIdentity: string) {
    const capabilities = (this.ports.sourceAddressingCapabilities ?? []).filter(
      (candidate) =>
        candidate.inputRequirement.sourceIdentity === sourceIdentity,
    );
    if (capabilities.length !== 1) throw new Error("所选来源不支持明确寻址");
    return capabilities[0]!;
  }

  async prepareConflictedEstablishment(input: {
    readonly assetId: string;
    readonly sourceIdentity: string;
    readonly sourceInput: Readonly<Record<string, string>>;
    readonly initiatedBy: string;
    readonly priorExecutionId?: string;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<SourceAssociationDecisionInspection> {
    return await this.prepareSourceAssociationDecision({
      ...input,
      intent: "establish",
    });
  }

  async prepareReplacement(input: {
    readonly assetId: string;
    readonly predecessorAssociationId: string;
    readonly sourceInput: Readonly<Record<string, string>>;
    readonly initiatedBy: string;
    readonly priorExecutionId?: string;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<SourceAssociationDecisionInspection> {
    return await this.prepareSourceAssociationDecision({
      ...input,
      intent: "replace",
    });
  }

  async prepareRetraction(input: {
    readonly assetId: string;
    readonly predecessorAssociationId: string;
    readonly initiatedBy: string;
    readonly reason: string;
    readonly priorExecutionId?: string;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<SourceAssociationDecisionInspection> {
    return await this.prepareSourceAssociationDecision({
      ...input,
      intent: "retract",
    });
  }

  /**
   * 点名决定的当前读取：主头仍在时用普通当前事实；主头已被撤回时，那份仍生效的决定只
   * 提供事实依据，投影明确标记身份未解决，绝不因此新建或自动继任身份。
   */
  private async namedRecognitionTarget(input: {
    readonly assetId: string;
    readonly decisionId: string;
  }): Promise<{ readonly accepted: AcceptedAssetState } | undefined> {
    const [current] = await this.ports.reuseQueries.findAcceptedForSubjects([
      input.assetId,
    ]);
    if (current !== undefined && current.subjectId === input.assetId)
      return { accepted: current.accepted };
    return await this.ports.reuseQueries.findAcceptedForDecision?.({
      decisionId: input.decisionId,
    });
  }

  async prepareRecognitionRetraction(input: {
    readonly assetId: string;
    readonly predecessorDecisionId: string;
    readonly proposedBy: string;
    readonly reason: string;
    /** 消费者据以查看确认后的普通详情需求；随预演冻结，缺省为普通语境。 */
    readonly informationRequirement?: InformationRequirement;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
  }): Promise<ChangeImpactPreviewInspection> {
    if (
      input.proposedBy.trim().length === 0 ||
      input.reason.trim().length === 0
    )
      throw new Error("身份撤回必须包含提议者和原因");
    const target = await this.namedRecognitionTarget({
      assetId: input.assetId,
      decisionId: input.predecessorDecisionId,
    });
    if (target === undefined) throw new Error("所选内容不存在或尚未确认");
    // 可点名任一仍生效的决定：主头与追加范围都能被明确撤回，绝不只允许当前身份。
    // 主头为空时点名的决定只是事实依据，撤回它不会结束主来源，也不会让身份出现。
    const headDecisionId =
      target.accepted.recognitionHeadDecisionId === null
        ? undefined
        : target.accepted.recognitionDecision.id;
    const withdrawsHead = headDecisionId === input.predecessorDecisionId;
    const headDecisionIds =
      headDecisionId === undefined ? [] : [headDecisionId];
    const effectiveBoundaries =
      await this.ports.reuseQueries.listEffectiveMaterialBoundariesForSubject?.(
        {
          assetId: input.assetId,
        },
      );
    if (!withdrawsHead && effectiveBoundaries === undefined)
      throw new Error("该内容没有可点名撤回的追加范围记录");
    const declarations = groupMaterialScopeDeclarations(
      effectiveBoundaries ?? [],
      { headDecisionIds },
    );
    const namedDeclaration = declarations.find(
      (declaration) => declaration.decisionId === input.predecessorDecisionId,
    );
    if (!withdrawsHead && namedDeclaration === undefined)
      throw new Error("点名的识别决定不是该内容当前生效的范围");
    // 范围局部基线只覆盖与点名决定相交的完整声明：不相交决定的新增或撤回不该让这份
    // 预演过期，相交一侧的支持变化则必须让它过期且不落任何写。
    const intersectingDeclarations =
      namedDeclaration === undefined
        ? undefined
        : declarations.filter((declaration) =>
            materialScopeDeclarationsIntersect(declaration, namedDeclaration),
          );
    const scopeDecisionIds =
      intersectingDeclarations === undefined
        ? undefined
        : [
            ...new Set(
              intersectingDeclarations.map(
                (declaration) => declaration.decisionId,
              ),
            ),
          ].toSorted();
    const initial: WorkflowExecution = {
      id: id("execution"),
      workflowInput: {
        version: "asset-refresh-input/1",
        trigger: "interactive",
        initiatedBy: input.proposedBy,
        acceptTrusted: false,
        configurationReferences: [],
      },
      selection: {
        intent: "directed-recognition",
        informationRequirement:
          input.informationRequirement ?? emptyInformationRequirement,
      },
      operationKind: "rescrape",
      status: "running",
      stage: "recognition",
      sourceRecordIds: [],
      acceptedAssetId: input.assetId,
      compatibility: this.compatibility(),
      dispositions: [],
    };
    const started = await this.ports.executionCommands.createExecution(initial);
    if (started !== "started") throw new AutomationExecutionNotStarted(started);
    input.onExecutionStarted?.(initial);
    const current = assetStateProjection(target.accepted);
    // 只有撤主才结束主来源：追加撤回绝不因为来源关联挂在主头上就删掉仅由主来源支持的封面。
    const endingSourceAssociationId = withdrawsHead
      ? target.accepted.recognitionSourceAssociation?.id
      : undefined;
    const projectedArtifactGraph = projectSupportedArtifactGraph({
      current: target.accepted,
      endingRecognitionDecisionId: input.predecessorDecisionId,
      ...(endingSourceAssociationId === undefined
        ? {}
        : { endingSourceAssociationId }),
    });
    const baseline =
      await this.ports.changeImpactCommands.freezeChangeImpactBaseline({
        assetId: input.assetId,
        // 身份基线取当前主头；主头为空时取点名决定的读取依据。
        recognitionDecisionId: target.accepted.recognitionDecision.id,
        ...(scopeDecisionIds === undefined ? {} : { scopeDecisionIds }),
        ...(target.accepted.recognitionSourceAssociation === undefined
          ? {}
          : {
              recognitionSourceAssociationId:
                target.accepted.recognitionSourceAssociation.id,
            }),
      });
    const afterRetractionBaseline = await this.namedRecognitionTarget({
      assetId: input.assetId,
      decisionId: input.predecessorDecisionId,
    });
    if (
      afterRetractionBaseline === undefined ||
      acceptedConcurrencyFingerprint(afterRetractionBaseline.accepted) !==
        acceptedConcurrencyFingerprint(target.accepted)
    ) {
      await this.transition(
        initial,
        terminal(initial, "failed", "形成撤回预演期间当前事实或支持已经变化"),
      );
      throw new Error("形成撤回预演期间当前事实或支持已经变化");
    }
    const {
      recognitionDecisionId: _recognitionDecisionId,
      recognitionSourceAssociation: _recognitionSourceAssociation,
      ...unresolvedProjection
    } = current;
    // 冻结与该决定相交的完整范围声明集合：确认时任何相交决定的新增、撤回、取代或边界
    // 变化都必须让这份预演过期，而不是静默落在已经改变的范围上。
    const scopeBaseline =
      intersectingDeclarations === undefined
        ? undefined
        : materialScopeDeclarationBaseline(intersectingDeclarations);
    let preview: ChangeImpactPreview = {
      version: "change-impact-preview/2",
      id: id("change-impact-preview"),
      executionId: initial.id,
      assetId: input.assetId,
      change: {
        kind: "recognition-retraction",
        intent: {
          predecessorDecisionId: input.predecessorDecisionId,
          proposedBy: input.proposedBy,
          reason: input.reason,
        },
      },
      evidenceComparison: {
        observed:
          target.accepted.proposal.basis.kind === "source-interpretation"
            ? []
            : target.accepted.proposal.basis.evidence,
        manual: [],
        sourceCandidates: [],
        conflicts: [
          withdrawsHead
            ? "撤回当前身份后，内容保持可按精确 ID 检查但身份未解决"
            : "撤回该追加范围后，其材料失去范围支持，当前身份保持不变",
        ],
      },
      baselines: [
        {
          key: "recognition-decision",
          value: input.predecessorDecisionId,
        },
        { key: "complete-current-projection", value: baseline },
        ...(scopeBaseline === undefined
          ? []
          : [
              {
                key: "recognition-scope-declarations",
                value: JSON.stringify(scopeBaseline),
              },
              {
                key: "recognition-scope-decision-ids",
                value: JSON.stringify(scopeDecisionIds),
              },
            ]),
      ],
      current,
      projected: withdrawsHead
        ? {
            ...unresolvedProjection,
            ...projectedArtifactGraph,
            recognitionState: "unresolved",
            sourceAssociations: target.accepted.sourceAssociations
              .filter(
                ({ id: associationId }) =>
                  associationId !==
                  target.accepted.recognitionSourceAssociation?.id,
              )
              .map(({ sourceIdentity, nativeAddress }) => ({
                sourceIdentity,
                nativeAddress,
              })),
          }
        : { ...current, ...projectedArtifactGraph },
      blockingConditions: [],
      requestContext: initial.selection.informationRequirement,
      status: "awaiting-confirmation",
    };
    preview = freezeChangeImpactFactReads(
      preview,
      this.ports.metadataPolicyConfiguration,
      [],
    );
    await this.ports.recognitionChangeImpact.finishExecutionWithRecognitionRetractionPreview(
      { expectedExecution: initial, execution: initial, preview },
    );
    return publicChangeImpactPreview(preview);
  }

  /**
   * 封面卡与预演共用的当前事实：候选只来自共同读取认定的精确当前图片修订，生效封面
   * 与问题也来自同一求值，因此视图永远拿不到第二套封面裁决。
   */
  private async artifactRoleCoverFacts(entityId: string): Promise<{
    readonly basis: SubjectFactBasis;
    readonly target: DescriptionTarget;
    readonly candidates: readonly ArtifactRoleCandidate[];
    readonly effective?: EffectiveArtifactRoleRead;
    readonly decision?: ArtifactRoleDecision;
    readonly problems: readonly string[];
  }> {
    const queries = this.ports.informationSubjectFactsQueries;
    if (queries === undefined) throw new Error("当前部署没有共同事实读取");
    const [subject] = await queries.readCurrentInformationSubjectFacts({
      subjectIds: [entityId],
    });
    if (subject === undefined) throw new Error("未找到该实体的当前事实");
    const target: DescriptionTarget = { kind: "entity", entityId };
    const read = readEffectiveSubject(
      subject.basis,
      this.ports.metadataPolicyConfiguration,
    );
    const description = read.descriptions.find(
      (candidate) =>
        descriptionTargetKey(candidate.target) === descriptionTargetKey(target),
    );
    const decision = (subject.basis.artifactRoleDecisions ?? []).find(
      (candidate) =>
        candidate.role === primaryCoverRole &&
        descriptionTargetKey(candidate.target) === descriptionTargetKey(target),
    );
    const effectiveRole = description?.artifactRoles.find(
      (role) => role.role === primaryCoverRole,
    );
    return {
      basis: subject.basis,
      target,
      candidates: artifactRoleCandidates(
        subject.basis,
        target,
        primaryCoverRole,
      ),
      ...(effectiveRole === undefined ? {} : { effective: effectiveRole }),
      ...(decision === undefined ? {} : { decision }),
      problems: (description?.conflicts ?? [])
        .filter((conflict) => conflict.role === primaryCoverRole)
        .map((conflict) => conflict.explanation),
    };
  }

  /** 列出当前合格封面候选、生效封面与人工意图。 */
  async inspectArtifactRoleCovers(input: {
    readonly entityId: string;
  }): Promise<ArtifactRoleCoverInspection> {
    const facts = await this.artifactRoleCoverFacts(input.entityId);
    const referenceOf = (candidate: ArtifactRoleCandidate) =>
      artifactRoleCandidateReference(candidate);
    const effective = facts.effective;
    const effectiveReference =
      effective === undefined
        ? undefined
        : facts.candidates.find(
            (candidate) =>
              candidate.artifactId === effective.artifactId &&
              effective.associationIds.includes(candidate.associationId),
          );
    const decided =
      facts.decision === undefined || facts.decision.kind === "clear"
        ? undefined
        : facts.candidates.find(
            (candidate) =>
              JSON.stringify([
                candidate.associationId,
                candidate.artifactId,
                candidate.revisionId,
              ]) ===
              JSON.stringify([
                facts.decision?.selected?.associationId,
                facts.decision?.selected?.artifactId,
                facts.decision?.selected?.revisionId,
              ]),
          );
    return {
      entityId: input.entityId,
      candidates: facts.candidates.map((candidate) => ({
        reference: referenceOf(candidate),
        kind: candidate.kind,
        locationId: candidate.locationId,
        address: candidate.address,
      })),
      ...(effectiveReference === undefined
        ? {}
        : { effectiveReference: referenceOf(effectiveReference) }),
      ...(facts.decision === undefined
        ? {}
        : {
            decision: {
              kind: facts.decision.kind,
              ...(decided === undefined
                ? {}
                : { reference: referenceOf(decided) }),
            },
          }),
      problems: facts.problems,
    };
  }

  /**
   * 形成选择或撤回的预演：只追加一条决定，冻结期望头、候选集、适用政策版本与资产
   * 完整事实基线；不访问网络、不扫描媒体、不生成派生图。
   */
  async prepareArtifactRoleDecision(input: {
    readonly entityId: string;
    readonly initiatedBy: string;
    /** 留空即为撤回当前人工选择。 */
    readonly candidateReference?: string;
    readonly informationRequirement?: InformationRequirement;
  }): Promise<ChangeImpactPreviewInspection> {
    if (input.initiatedBy.trim().length === 0)
      throw new Error("封面决定缺少发起者");
    const facts = await this.artifactRoleCoverFacts(input.entityId);
    const selected =
      input.candidateReference === undefined
        ? undefined
        : facts.candidates.find(
            (candidate) =>
              artifactRoleCandidateReference(candidate) ===
              input.candidateReference,
          );
    if (input.candidateReference !== undefined && selected === undefined)
      throw new Error("封面候选引用不属于该实体当前合格的封面");
    const expectedHeadDecisionId = facts.decision?.id ?? null;
    if (selected === undefined && expectedHeadDecisionId === null)
      throw new Error("该实体当前没有可撤回的人工封面选择");
    if (
      selected !== undefined &&
      facts.decision?.kind === "select" &&
      JSON.stringify(facts.decision.selected) ===
        JSON.stringify({
          associationId: selected.associationId,
          artifactId: selected.artifactId,
          revisionId: selected.revisionId,
        })
    )
      throw new Error("该封面已经是当前人工选择");
    const [target] = await this.ports.reuseQueries.findAcceptedForSubjects([
      input.entityId,
    ]);
    if (target === undefined) throw new Error("未找到该实体的已接受事实");
    const decision: ArtifactRoleDecision = {
      id: id("artifact-role-decision"),
      target: facts.target,
      role: primaryCoverRole,
      kind: selected === undefined ? "clear" : "select",
      ...(selected === undefined
        ? {}
        : {
            selected: {
              associationId: selected.associationId,
              artifactId: selected.artifactId,
              revisionId: selected.revisionId,
            },
          }),
      ...(expectedHeadDecisionId === null
        ? {}
        : { predecessorDecisionId: expectedHeadDecisionId }),
      initiatedBy: input.initiatedBy,
    };
    validateArtifactRoleDecision(decision);
    const current = assetStateProjection(target.accepted);
    const baseline =
      await this.ports.changeImpactCommands.freezeChangeImpactBaseline({
        assetId: input.entityId,
        recognitionDecisionId: target.accepted.recognitionDecision.id,
        ...(target.accepted.recognitionSourceAssociation === undefined
          ? {}
          : {
              recognitionSourceAssociationId:
                target.accepted.recognitionSourceAssociation.id,
            }),
      });
    let preview: ChangeImpactPreview = {
      version: "change-impact-preview/2",
      id: id("change-impact-preview"),
      // 决定本身是这份预演的因果来源，因此不挂任何工作流执行。
      executionId: `artifact-role-decision:${decision.id}`,
      assetId: input.entityId,
      change: {
        kind: "artifact-role-decision",
        decision,
        expectedHeadDecisionId,
      },
      evidenceComparison: {
        observed: [],
        manual: [],
        sourceCandidates: [],
        conflicts: [
          selected === undefined
            ? "撤回后封面回到既有本地与来源政策的裁决"
            : "确认后这张精确图片成为该实体的当前封面，优先于本地与来源政策",
        ],
      },
      baselines: [
        {
          key: "recognition-decision",
          value: target.accepted.recognitionDecision.id,
        },
        { key: "complete-current-projection", value: baseline },
        {
          key: artifactRoleCandidateBaselineKey,
          value: JSON.stringify(facts.candidates),
        },
        {
          key: "artifact-role-decision-head",
          value: expectedHeadDecisionId ?? "none",
        },
        {
          key: "artifact-role-policy-version",
          value: this.compatibility().policyVersion,
        },
      ],
      current,
      projected: current,
      blockingConditions: [],
      requestContext: input.informationRequirement,
      status: "awaiting-confirmation",
    };
    preview = freezeChangeImpactFactReads(
      preview,
      this.ports.metadataPolicyConfiguration,
      [],
    );
    await this.ports.changeImpactCommands.saveArtifactRoleDecisionPreview(
      preview,
    );
    return publicChangeImpactPreview(preview);
  }

  /**
   * 范围追加／修订的明确决定：完整声明取自那次观察冻结的工作项，绝不以本次可见文件
   * 代替整个声明；主头只在点名的就是主头时前进，追加不会另造第二个身份。
   */
  async prepareRecognitionScopeAmendment(input: {
    readonly sourceExecutionId: string;
    readonly workItemKey: string;
    readonly proposedBy: string;
    readonly reason: string;
    /** 缺省时使用那次观察为该工作项点名的决定。 */
    readonly decisionId?: string;
    readonly informationRequirement?: InformationRequirement;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
  }): Promise<ChangeImpactPreviewInspection> {
    if (
      input.proposedBy.trim().length === 0 ||
      input.reason.trim().length === 0
    )
      throw new Error("范围决定必须包含提议者和原因");
    const source = await this.ports.executionQueries.inspectExecution(
      input.sourceExecutionId,
    );
    if (source === undefined)
      throw new Error("找不到形成该范围决定的那次观察记录");
    const frozen = source.execution.workItems?.find(
      (item) => item.key === input.workItemKey,
    );
    const assetId = frozen?.retainedAssetId ?? source.execution.acceptedAssetId;
    const namedDecisionId = input.decisionId ?? frozen?.retainedDecisionId;
    const snapshot = source.execution.snapshot;
    if (
      frozen === undefined ||
      frozen.outcome !== "unresolved" ||
      frozen.boundaries === undefined ||
      frozen.boundaries.length === 0 ||
      assetId === undefined ||
      namedDecisionId === undefined ||
      snapshot === undefined
    )
      throw new Error(
        "这个工作项没有可应用的完整范围与点名决定，需要重新扫描后再明确决定",
      );
    const target = await this.namedRecognitionTarget({
      assetId,
      decisionId: namedDecisionId,
    });
    if (target === undefined) throw new Error("所选内容不存在或尚未确认");
    const headDecisionId =
      target.accepted.recognitionHeadDecisionId === null
        ? undefined
        : target.accepted.recognitionDecision.id;
    const effectiveBoundaries =
      await this.ports.reuseQueries.listEffectiveMaterialBoundariesForSubject?.(
        {
          assetId,
        },
      );
    if (effectiveBoundaries === undefined)
      throw new Error("该内容没有可点名修订的范围决定记录");
    const declarations = groupMaterialScopeDeclarations(effectiveBoundaries, {
      headDecisionIds: headDecisionId === undefined ? [] : [headDecisionId],
    });
    const namedDeclaration = declarations.find(
      (declaration) => declaration.decisionId === namedDecisionId,
    );
    if (namedDeclaration === undefined)
      throw new Error("点名的识别决定不是该内容当前生效的范围");
    const scopeDeclarations =
      await this.ports.reuseQueries.listMaterialScopeDeclarations?.({
        scopeAddress: snapshot.root,
      });
    if (
      scopeDeclarations === undefined ||
      !scopeDeclarations.some(
        (declaration) => declaration.decisionId === namedDecisionId,
      )
    )
      throw new Error(
        "该范围缺少可核对的相交声明记录，需要重新扫描后再明确决定",
      );
    const materialReferences = frozen.relativePaths;
    const evidence = (frozen.planningEvidence ?? []).filter(
      (item) =>
        item.inspection !== undefined &&
        materialReferences.includes(item.inspection.observedArtifactReference),
    );
    if (evidence.length === 0)
      throw new Error(
        "该范围没有可归属的文件检查证据，需要重新扫描后再明确决定",
      );
    // 从同一次冻结的通用完整字节观察逐材料重建精确修订：不在预演时重读当前文件，也不从
    // size/mtime 推导摘要。缺失、重复或矛盾都保留既有语义，要求重新扫描后再明确决定。
    const revisions = new Map<
      string,
      import("@digital/domain").ObservedArtifactRevisionCandidate
    >();
    for (const item of evidence) {
      if (item.kind !== "format.whole-file-observation") continue;
      const inspection = item.inspection;
      if (inspection === undefined) continue;
      const reference = inspection.observedArtifactReference;
      if (revisions.has(reference))
        throw new Error(
          "该范围材料存在重复的文件修订，需要重新扫描后再明确决定",
        );
      revisions.set(reference, {
        observedArtifactReference: reference,
        blob: inspection.revision,
        producer: item.producer,
      });
    }
    if (materialReferences.some((reference) => !revisions.has(reference)))
      throw new Error("该范围材料缺少完整的文件修订，需要重新扫描后再明确决定");
    const observedArtifactRevisions = [...revisions.values()];
    const proposal = validateRecognitionProposal({
      id: id("recognition-proposal"),
      boundaries: frozen.boundaries,
      basis: {
        kind: "manual-boundary",
        proposedBy: input.proposedBy,
        observationSnapshotId: snapshot.id,
        materialReferences,
        revisesProposalIds: [],
        metadata: [],
        evidence,
      },
      ruleResults: [],
      observedArtifactAssociations: materialReferences.map(
        (observedArtifactReference) => ({
          observedArtifactReference,
          role: "asset.material-delivered" as const,
        }),
      ),
      observedArtifactRevisions,
    });
    const roots = source.execution.workflowInput?.observedRoots ?? [];
    const declaredDirectories = frozen.boundaries.flatMap((boundary) => {
      if (boundary.kind !== "directory") return [];
      const [owner] = roots.filter(
        (root) => root.id === boundary.scopeReference,
      );
      if (owner === undefined)
        throw new Error(
          "冻结范围引用的观察根已经不存在，需要重新扫描后再明确决定",
        );
      return [
        observedAddress(owner.containerPath, boundary.directoryReference),
      ];
    });
    // 裁剪只保留声明范围内的观察：范围内的排除项与诊断随范围一起冻结，完整语义不伪装。
    const inDeclaredRange = (relativePath: string) =>
      materialReferences.includes(relativePath) ||
      declaredDirectories.some((directory) =>
        isWithinObservedDirectory(
          directory,
          observedAddress(snapshot.root, relativePath),
        ),
      );
    const selectedSnapshot: FilesystemPackageSnapshot = {
      ...snapshot,
      files: snapshot.files.filter((file) =>
        inDeclaredRange(file.relativePath),
      ),
      excluded: snapshot.excluded.filter((item) =>
        inDeclaredRange(item.relativePath),
      ),
      ...(snapshot.diagnostics === undefined
        ? {}
        : {
            diagnostics: snapshot.diagnostics.filter((item) =>
              inDeclaredRange(item.relativePath),
            ),
          }),
    };
    const initial: WorkflowExecution = {
      id: id("execution"),
      workflowInput: {
        version: "asset-refresh-input/1",
        trigger: "interactive",
        initiatedBy: input.proposedBy,
        acceptTrusted: false,
        configurationReferences: [],
        // 复用源执行已耐久冻结的观察根，使应用后新增材料位置能按同一根版本建立当前正向支持。
        observedRoots: roots,
      },
      selection: {
        intent: "directed-recognition",
        informationRequirement:
          input.informationRequirement ?? emptyInformationRequirement,
      },
      operationKind: "rescrape",
      status: "running",
      stage: "recognition",
      sourceRecordIds: [],
      // 明确决定针对那次观察的裁剪范围形成；该快照是支持证据的载体，不是新的观察。
      snapshot: selectedSnapshot,
      acceptedAssetId: assetId,
      compatibility: this.compatibility(),
      dispositions: [],
    };
    const started = await this.ports.executionCommands.createExecution(initial);
    if (started !== "started") throw new AutomationExecutionNotStarted(started);
    input.onExecutionStarted?.(initial);
    // 范围载体（上面的完整三项 proposal/execution snapshot）决定这条离散范围是否成立；
    // 交付载体只负责把尚未落到原主体上的材料并进当前事实。原 MKV 已是主体的既有观察
    // 位置，snapshot-local 语义下重扫会重新铸成第二个 artifact，因此交付快照与关联/修订
    // 只含未交付项，让 rangeRecognition 恰好贡献这些新增，避免重复材料。
    const deliveredAddresses = new Set(
      target.accepted.locations
        .filter((location) => location.kind === "observed")
        .map((location) => location.address),
    );
    const deliveryReferences = materialReferences.filter(
      (reference) => !deliveredAddresses.has(`${snapshot.root}/${reference}`),
    );
    const deliverySnapshot: FilesystemPackageSnapshot = {
      ...selectedSnapshot,
      files: selectedSnapshot.files.filter((file) =>
        deliveryReferences.includes(file.relativePath),
      ),
    };
    const deliveryProposal: RecognitionProposal = {
      ...proposal,
      observedArtifactAssociations: deliveryReferences.map(
        (observedArtifactReference) => ({
          observedArtifactReference,
          role: "asset.material-delivered" as const,
        }),
      ),
      observedArtifactRevisions: observedArtifactRevisions.filter((revision) =>
        deliveryReferences.includes(revision.observedArtifactReference),
      ),
    };
    const rangeRecognition = createAcceptedRecognition({
      proposal: deliveryProposal,
      snapshot: deliverySnapshot,
      managedArtifacts: [],
      current: target.accepted,
      ...(this.ports.observedRootRegistrations.objectIdentityContract ===
      undefined
        ? {}
        : {
            objectIdentityContract:
              this.ports.observedRootRegistrations.objectIdentityContract,
          }),
    });
    const amendsHead =
      headDecisionId !== undefined && namedDecisionId === headDecisionId;
    const successorDecisionId = id("recognition-decision");
    const current = assetStateProjection(target.accepted);
    // 范围基线只覆盖与点名声明相交的完整范围：不相交主体新增不该让这份预演过期，
    // 相交一侧的支持刷新则必须让它过期且不落任何写。
    const intersectingScopeDeclarations = scopeDeclarations.filter(
      (declaration) =>
        materialScopeDeclarationsIntersect(declaration, namedDeclaration),
    );
    const scopeDecisionIds = [
      ...new Set(
        intersectingScopeDeclarations.map(
          (declaration) => declaration.decisionId,
        ),
      ),
    ].toSorted();
    const baseline =
      await this.ports.changeImpactCommands.freezeChangeImpactBaseline({
        assetId,
        // 身份基线取当前主头；主头为空时取点名决定的读取依据。
        recognitionDecisionId: target.accepted.recognitionDecision.id,
        ...(target.accepted.recognitionSourceAssociation === undefined
          ? {}
          : {
              recognitionSourceAssociationId:
                target.accepted.recognitionSourceAssociation.id,
            }),
        scopeDecisionIds,
      });
    const afterBaseline = await this.namedRecognitionTarget({
      assetId,
      decisionId: namedDecisionId,
    });
    if (
      afterBaseline === undefined ||
      acceptedConcurrencyFingerprint(afterBaseline.accepted) !==
        acceptedConcurrencyFingerprint(target.accepted)
    ) {
      await this.transition(
        initial,
        terminal(
          initial,
          "failed",
          "形成范围决定预演期间当前事实或支持已经变化",
        ),
      );
      throw new Error("形成范围决定预演期间当前事实或支持已经变化");
    }
    const unionBy = <T>(
      left: readonly T[],
      right: readonly T[],
      key: (item: T) => string,
    ): readonly T[] => {
      const seen = new Set(left.map(key));
      return [...left, ...right.filter((item) => !seen.has(key(item)))];
    };
    // 范围决定只改变被点名那一份声明的材料归属：其余当前事实原样保留。
    const projected: AssetStateProjection = {
      ...current,
      artifacts: unionBy(
        current.artifacts,
        rangeRecognition.artifacts,
        ({ id: artifactId }) => artifactId,
      ),
      locations: unionBy(
        current.locations,
        rangeRecognition.locations,
        (item) => `${item.artifactId}\u0000${item.address}`,
      ),
      blobs: unionBy(
        current.blobs,
        rangeRecognition.blobs,
        ({ digest }) => digest,
      ),
      artifactRevisions: unionBy(
        current.artifactRevisions,
        rangeRecognition.artifactRevisions,
        ({ id: revisionId }) => revisionId,
      ),
      artifactAssociations: unionBy(
        current.artifactAssociations,
        rangeRecognition.artifactAssociations,
        ({ id: associationId }) => associationId,
      ),
      // 只有点名的是主头时当前身份才改由新决定授权；追加修订绝不改写主头，
      // 主头为空时保持未解决，绝不自动继任或新造身份。
      ...(amendsHead ? { recognitionDecisionId: successorDecisionId } : {}),
    };
    const scopeBaseline = materialScopeDeclarationBaseline(
      intersectingScopeDeclarations,
    );
    let preview: ChangeImpactPreview = {
      version: "change-impact-preview/2",
      id: id("change-impact-preview"),
      executionId: initial.id,
      assetId,
      proposal,
      change: {
        kind: "recognition-scope-amendment",
        proposal,
        successorDecisionId,
        predecessorDecisionId: namedDecisionId,
        scopeAddress: snapshot.root,
      },
      evidenceComparison: {
        observed: [],
        manual: evidence,
        sourceCandidates: [],
        conflicts: [
          amendsHead
            ? "确认这份修订后，当前身份改由新范围授权；历史决定与撤回记录保持不变"
            : "确认这份修订后，只有点名的追加范围改变，当前身份保持不变",
        ],
      },
      baselines: [
        { key: "recognition-decision", value: namedDecisionId },
        { key: "complete-current-projection", value: baseline },
        {
          key: "recognition-scope-declarations",
          value: JSON.stringify(scopeBaseline),
        },
        {
          key: "recognition-scope-decision-ids",
          value: JSON.stringify(scopeDecisionIds),
        },
      ],
      current,
      projected,
      blockingConditions: [],
      requestContext: initial.selection.informationRequirement,
      status: "awaiting-confirmation",
    };
    preview = freezeChangeImpactFactReads(
      preview,
      this.ports.metadataPolicyConfiguration,
      [],
    );
    await this.ports.recognitionChangeImpact.finishExecutionWithRecognitionScopeAmendmentPreview(
      { expectedExecution: initial, execution: initial, proposal, preview },
    );
    return publicChangeImpactPreview(preview);
  }

  private async prepareSourceAssociationDecision(
    input:
      | {
          readonly intent: "establish";
          readonly assetId: string;
          readonly sourceIdentity: string;
          readonly sourceInput: Readonly<Record<string, string>>;
          readonly initiatedBy: string;
          readonly priorExecutionId?: string;
          readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
          readonly onCheckpoint?: (execution: WorkflowExecution) => void;
          readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
        }
      | {
          readonly intent: "replace";
          readonly assetId: string;
          readonly predecessorAssociationId: string;
          readonly sourceInput: Readonly<Record<string, string>>;
          readonly initiatedBy: string;
          readonly priorExecutionId?: string;
          readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
          readonly onCheckpoint?: (execution: WorkflowExecution) => void;
          readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
        }
      | {
          readonly intent: "retract";
          readonly assetId: string;
          readonly predecessorAssociationId: string;
          readonly initiatedBy: string;
          readonly reason: string;
          readonly priorExecutionId?: string;
          readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
          readonly onCheckpoint?: (execution: WorkflowExecution) => void;
          readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
        },
  ): Promise<SourceAssociationDecisionInspection> {
    return await atPublicWorkflowBoundary(async () => {
      if (input.initiatedBy.trim().length === 0)
        throw new Error("来源关联决定发起者不能为空");
      const [target] = await this.ports.reuseQueries.findAcceptedForSubjects([
        input.assetId,
      ]);
      if (target === undefined || target.subjectId !== input.assetId)
        throw new Error("所选内容不存在或尚未确认");
      const predecessor =
        input.intent === "establish"
          ? undefined
          : target.accepted.sourceAssociations.find(
              ({ id: associationId }) =>
                associationId === input.predecessorAssociationId,
            );
      if (input.intent !== "establish" && predecessor === undefined)
        throw new Error("点名的来源关联不存在、非当前或不属于该内容");
      const sourceIdentity =
        input.intent === "establish"
          ? input.sourceIdentity
          : predecessor!.sourceIdentity;
      const initialCheckpoint: SourceAssociationDecisionCheckpoint = {
        version: "source-association-decision-checkpoint/1",
        state: "created",
        intent: input.intent,
        assetId: input.assetId,
        sourceIdentity,
        ...(predecessor === undefined ? {} : { predecessor }),
        candidates: [],
        capturedSourceRecordIds: [],
      };
      const initial: WorkflowExecution = {
        id: id("execution"),
        workflowInput: {
          version: "source-association-decision-input/1",
          trigger: "interactive",
          initiatedBy: input.initiatedBy,
          acceptTrusted: false,
          configurationReferences: [],
          intent: input.intent,
          assetId: input.assetId,
          sourceIdentity,
          ...(input.priorExecutionId === undefined
            ? {}
            : { priorExecutionId: input.priorExecutionId }),
          ...(predecessor === undefined
            ? {}
            : { predecessorAssociationId: predecessor.id }),
          ...(input.intent === "retract"
            ? { reason: input.reason }
            : { sourceInput: input.sourceInput }),
        },
        selection: {
          intent: "source-enrichment",
          informationRequirement: emptyInformationRequirement,
        },
        status: "running",
        stage: "recognition",
        sourceRecordIds: [],
        acceptedAssetId: input.assetId,
        compatibility: this.compatibility(),
        dispositions: [],
        sourceAssociationDecision: initialCheckpoint,
      };
      const started =
        await this.ports.executionCommands.createExecution(initial);
      if (started !== "started")
        throw new AutomationExecutionNotStarted(started);
      input.onExecutionStarted?.(initial);
      input.onHostCheckpoint?.(initial);
      if (input.intent === "retract") {
        return await this.finalizeSourceAssociationDecisionPreview({
          execution: initial,
          accepted: target.accepted,
          checkpoint: initialCheckpoint,
          initiatedBy: input.initiatedBy,
          reason: input.reason,
        });
      }
      const capability = (this.ports.sourceAddressingCapabilities ?? []).find(
        (candidate) =>
          candidate.inputRequirement.sourceIdentity === sourceIdentity,
      );
      if (capability === undefined)
        return await this.failSourceAssociationDecision(
          initial,
          "所选来源不支持明确寻址",
        );
      const normalized = capability.normalize(input.sourceInput);
      if (
        normalized.status === "invalid" ||
        normalized.evidence.sourceIdentity !== sourceIdentity ||
        normalized.evidence.sourceAddress === undefined
      )
        return await this.failSourceAssociationDecision(
          initial,
          normalized.status === "invalid"
            ? normalized.reason
            : "来源能力返回了无效的规范化地址",
        );
      const normalizationContent: SourceNormalizationRecordContent = {
        version: "source-normalization-record/1",
        rawInput: { ...input.sourceInput },
        capability: capability.capability,
        normalizedInput: normalized.normalizedInput,
        evidence: normalized.evidence,
      };
      const normalization: SourceNormalizationRecord = {
        ...normalizationContent,
        integrityFingerprint:
          sourceNormalizationIntegrityFingerprint(normalizationContent),
      };
      let execution = await this.freezeCapabilityParticipation(initial, [
        capability.capability,
      ]);
      if (
        input.intent === "replace" &&
        normalized.evidence.sourceAddress === predecessor!.nativeAddress
      ) {
        const noChange: WorkflowExecution = {
          ...execution,
          status: "completed",
          stage: "completed",
          outcome: "no-change",
          sourceAssociationDecision: {
            ...initialCheckpoint,
            state: "no-change",
            normalization,
          },
        };
        await this.transition(execution, noChange);
        return this.publicSourceAssociationDecision(noChange);
      }
      const collectingCheckpoint: SourceAssociationDecisionCheckpoint = {
        ...initialCheckpoint,
        state: "collecting",
        normalization,
      };
      const collecting = {
        ...execution,
        sourceAssociationDecision: collectingCheckpoint,
      };
      await this.transition(execution, collecting);
      execution = collecting;
      input.onCheckpoint?.(execution);
      input.onHostCheckpoint?.(execution);
      const collector = this.ports.collectors.find((candidate) =>
        candidate.canCollect(normalized.evidence),
      );
      if (collector === undefined)
        return await this.failSourceAssociationDecision(
          execution,
          "没有采集能力接受该来源地址",
        );
      execution = await this.bindCollectorConfiguration(
        execution,
        collector,
        normalized.evidence,
      );
      execution = await this.freezeCapabilityParticipation(execution, [
        collector.capability,
      ]);
      let collection: SourceCollectionResult;
      try {
        collection = retainCollectedRecordProvenance(
          collector,
          await collector.collect(
            normalized.evidence,
            this.collectionExecutionContext(execution),
          ),
        );
      } catch (error) {
        return await this.failSourceAssociationDecision(
          execution,
          errorMessage(error),
        );
      }
      input.onHostCheckpoint?.(execution);
      const retainedCheckpoint: SourceAssociationDecisionCheckpoint = {
        ...collectingCheckpoint,
        state: collection.failures.length === 0 ? "interpreting" : "failed",
        capturedSourceRecordIds: collection.records.map(({ id }) => id),
        ...(collection.failures.length === 0
          ? {}
          : {
              failure: collection.failures
                .map(({ reason }) => reason)
                .join("；"),
            }),
      };
      const retainedExecution: WorkflowExecution = {
        ...execution,
        stage: "source-records-retained",
        sourceRecordIds: collection.records.map(({ id }) => id),
        sourceAssociationDecision: retainedCheckpoint,
      };
      const persistence = this.ports.sourceEnrichmentPersistence;
      if (persistence === undefined)
        throw new Error("当前组合无法保存来源关联决定证据");
      await persistence.checkpointSourceEnrichmentRecords({
        expectedExecution: execution,
        execution: retainedExecution,
        sourceRecords: collection.records,
      });
      execution = retainedExecution;
      input.onCheckpoint?.(execution);
      input.onHostCheckpoint?.(execution);
      if (collection.failures.length > 0)
        return await this.failSourceAssociationDecision(
          execution,
          retainedCheckpoint.failure!,
        );
      const [currentTarget] =
        await this.ports.reuseQueries.findAcceptedForSubjects([input.assetId]);
      if (
        currentTarget === undefined ||
        currentTarget.accepted.recognitionDecision.id !==
          target.accepted.recognitionDecision.id ||
        (predecessor !== undefined &&
          !currentTarget.accepted.sourceAssociations.some(
            ({ id: associationId }) => associationId === predecessor.id,
          ))
      )
        return await this.failSourceAssociationDecision(
          execution,
          "采集期间当前身份或来源关联已经变化",
        );
      const candidates: SourceAssociationDecisionCandidate[] = [];
      const interpretations = await interpretRetainedSourceRecords({
        interpreters: this.ports.sourceInterpreters,
        evidence: [normalized.evidence],
        sourceRecords: collection.records,
        beforeInterpret: async (capability) => {
          input.onHostCheckpoint?.(execution);
          execution = await this.freezeCapabilityParticipation(execution, [
            capability,
          ]);
          input.onHostCheckpoint?.(execution);
        },
      });
      for (const interpretation of interpretations) {
        if (interpretation.sourceIdentity !== sourceIdentity) continue;
        const associationInterpreter = sourceAssociationInterpreterFor({
          interpreters: this.ports.sourceAssociationInterpreters ?? [],
          evidence: normalized.evidence,
          interpretation,
        });
        if (associationInterpreter === undefined) continue;
        const result = associationInterpreter.interpret({
          subject: {
            subjectId: input.assetId,
            recognitionDecisionId:
              currentTarget.accepted.recognitionDecision.id,
            sourceAssociations: currentTarget.accepted.sourceAssociations,
            metadata: currentTarget.accepted.metadata,
            metadataSourceRecords:
              currentTarget.accepted.metadataSourceRecords ?? [],
            informationRequirement: emptyInformationRequirement,
            ...(currentTarget.accepted.recognitionSourceAssociation ===
            undefined
              ? {}
              : {
                  recognitionSourceAssociation:
                    currentTarget.accepted.recognitionSourceAssociation,
                }),
          },
          evidence: normalized.evidence,
          interpretation,
        });
        if (result === undefined) continue;
        candidates.push({
          outcome: result.status,
          sourceIdentity,
          nativeAddress: interpretation.sourceAddress,
          sourceRecordIds: interpretation.sourceRecordIds,
          // 来源关联候选只携带本次来源判断自身产生的规则；当前解释器契约没有额外规则结果。
          ruleResults: [],
          interpretation,
          explanation: result.explanation,
        });
      }
      if (candidates.length === 0)
        return await this.failSourceAssociationDecision(
          execution,
          "来源记录没有形成可用候选",
        );
      const candidateCheckpoint: SourceAssociationDecisionCheckpoint = {
        ...retainedCheckpoint,
        state: candidates.length === 1 ? "interpreting" : "awaiting-selection",
        candidates,
      };
      const candidateExecution = {
        ...execution,
        sourceAssociationDecision: candidateCheckpoint,
      };
      await this.transition(execution, candidateExecution);
      if (candidates.length > 1)
        return this.publicSourceAssociationDecision(candidateExecution);
      return await this.finalizeSourceAssociationDecisionPreview({
        execution: candidateExecution,
        accepted: currentTarget.accepted,
        checkpoint: candidateCheckpoint,
        initiatedBy: input.initiatedBy,
        ...(candidates[0] === undefined ? {} : { candidate: candidates[0] }),
      });
    });
  }

  async inspectSourceAssociationDecision(
    executionId: string,
  ): Promise<SourceAssociationDecisionInspection | undefined> {
    const inspection =
      await this.ports.executionQueries.inspectExecution(executionId);
    return inspection === undefined ||
      inspection.execution.sourceAssociationDecision === undefined
      ? undefined
      : await this.publicSourceAssociationDecision(inspection.execution);
  }

  async selectSourceAssociationCandidate(input: {
    readonly executionId: string;
    readonly candidateReference: string;
  }): Promise<SourceAssociationDecisionInspection> {
    const inspection = await this.ports.executionQueries.inspectExecution(
      input.executionId,
    );
    const execution = inspection?.execution;
    const checkpoint = execution?.sourceAssociationDecision;
    if (
      execution === undefined ||
      checkpoint === undefined ||
      execution.status !== "running" ||
      checkpoint.state !== "awaiting-selection"
    )
      throw new Error("该来源关联决定当前不能选择候选");
    const selected = checkpoint.candidates.filter(
      (candidate) =>
        publicSourceAssociationCandidate(candidate).reference ===
        input.candidateReference,
    );
    if (selected.length !== 1) throw new Error("所选候选不属于该执行或不唯一");
    const [target] = await this.ports.reuseQueries.findAcceptedForSubjects([
      checkpoint.assetId,
    ]);
    if (target === undefined || target.subjectId !== checkpoint.assetId)
      throw new Error("所选内容不再可用");
    return await this.finalizeSourceAssociationDecisionPreview({
      execution,
      accepted: target.accepted,
      checkpoint,
      initiatedBy: execution.workflowInput!.initiatedBy,
      candidate: selected[0]!,
    });
  }

  async retrySourceAssociationDecision(input: {
    readonly executionId: string;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<SourceAssociationDecisionInspection> {
    const inspection = await this.ports.executionQueries.inspectExecution(
      input.executionId,
    );
    const execution = inspection?.execution;
    const workflowInput = execution?.workflowInput;
    if (
      execution === undefined ||
      execution.status === "running" ||
      workflowInput?.version !== "source-association-decision-input/1"
    )
      throw new Error("只有已终止的来源关联决定可以重试");
    const common = {
      assetId: workflowInput.assetId,
      initiatedBy: workflowInput.initiatedBy,
      priorExecutionId: execution.id,
      ...(input.onCheckpoint === undefined
        ? {}
        : { onCheckpoint: input.onCheckpoint }),
      ...(input.onHostCheckpoint === undefined
        ? {}
        : { onHostCheckpoint: input.onHostCheckpoint }),
    };
    if (workflowInput.intent === "establish")
      return await this.prepareConflictedEstablishment({
        ...common,
        sourceIdentity: workflowInput.sourceIdentity!,
        sourceInput: workflowInput.sourceInput!,
        ...(input.onExecutionStarted === undefined
          ? {}
          : { onExecutionStarted: input.onExecutionStarted }),
      });
    if (workflowInput.intent === "replace")
      return await this.prepareReplacement({
        ...common,
        predecessorAssociationId: workflowInput.predecessorAssociationId!,
        sourceInput: workflowInput.sourceInput!,
        ...(input.onExecutionStarted === undefined
          ? {}
          : { onExecutionStarted: input.onExecutionStarted }),
      });
    return await this.prepareRetraction({
      ...common,
      predecessorAssociationId: workflowInput.predecessorAssociationId!,
      reason: workflowInput.reason!,
      ...(input.onExecutionStarted === undefined
        ? {}
        : { onExecutionStarted: input.onExecutionStarted }),
    });
  }

  private async failSourceAssociationDecision(
    execution: WorkflowExecution,
    reason: string,
  ): Promise<SourceAssociationDecisionInspection> {
    const failed: WorkflowExecution = {
      ...execution,
      status: "failed",
      stage: "failed",
      outcome: "failed",
      reason,
      sourceAssociationDecision: {
        ...(execution.sourceAssociationDecision ?? {
          version: "source-association-decision-checkpoint/1" as const,
          intent: "establish" as const,
          assetId: execution.acceptedAssetId!,
          candidates: [],
          capturedSourceRecordIds: [],
          state: "created" as const,
        }),
        state: "failed",
        failure: reason,
      },
    };
    await this.transition(execution, failed);
    return await this.publicSourceAssociationDecision(failed);
  }

  private async finalizeSourceAssociationDecisionPreview(input: {
    readonly execution: WorkflowExecution;
    readonly accepted: AcceptedAssetState;
    readonly checkpoint: SourceAssociationDecisionCheckpoint;
    readonly initiatedBy: string;
    readonly candidate?: SourceAssociationDecisionCandidate;
    readonly reason?: string;
  }): Promise<SourceAssociationDecisionInspection> {
    const predecessor = input.checkpoint.predecessor;
    if (input.checkpoint.intent !== "retract" && input.candidate === undefined)
      throw new Error("来源关联建立或更换缺少精确候选");
    const [latest] = await this.ports.reuseQueries.findAcceptedForSubjects([
      input.checkpoint.assetId,
    ]);
    if (
      latest === undefined ||
      latest.subjectId !== input.checkpoint.assetId ||
      latest.accepted.recognitionDecision.id !==
        input.accepted.recognitionDecision.id ||
      (predecessor !== undefined &&
        !latest.accepted.sourceAssociations.some(
          ({ id: associationId }) => associationId === predecessor.id,
        ))
    )
      return await this.failSourceAssociationDecision(
        input.execution,
        "来源关联决定的当前基线已变化",
      );
    const accepted = latest.accepted;
    if (
      input.checkpoint.intent === "establish" &&
      accepted.sourceAssociations.some(
        ({ sourceIdentity, nativeAddress }) =>
          sourceIdentity === input.candidate!.sourceIdentity &&
          nativeAddress === input.candidate!.nativeAddress,
      )
    ) {
      const noChange: WorkflowExecution = {
        ...input.execution,
        status: "completed",
        stage: "completed",
        outcome: "no-change",
        sourceAssociationDecision: {
          ...input.checkpoint,
          state: "no-change",
        },
      };
      await this.transition(input.execution, noChange);
      return await this.publicSourceAssociationDecision(noChange);
    }
    const comparison: EvidenceComparison = {
      observed: [],
      manual:
        input.checkpoint.normalization === undefined
          ? []
          : [input.checkpoint.normalization.evidence],
      sourceCandidates: input.checkpoint.candidates.map((candidate) => ({
        reference: publicSourceAssociationCandidate(candidate).reference,
        outcome: candidate.outcome,
        sourceIdentity: candidate.sourceIdentity,
        nativeAddress: candidate.nativeAddress,
        sourceRecordIds: candidate.sourceRecordIds,
        ruleResults: candidate.ruleResults,
        explanation: candidate.explanation,
      })),
      conflicts: input.checkpoint.candidates
        .filter(({ outcome }) => outcome === "contradicted")
        .map(({ explanation }) => explanation),
    };
    const proposal: SourceAssociationChangeProposal = (() => {
      if (input.checkpoint.intent === "retract")
        return {
          id: id("source-association-proposal"),
          kind: "retract" as const,
          subjectId: input.checkpoint.assetId,
          predecessorAssociationId: predecessor!.id,
          proposedBy: { kind: "user" as const, actorId: input.initiatedBy },
          reason: input.reason!,
          evidence: comparison,
        };
      const successor = {
        id: id("source-association"),
        subjectId: input.checkpoint.assetId,
        sourceIdentity: input.candidate!.sourceIdentity,
        nativeAddress: input.candidate!.nativeAddress,
      };
      if (input.checkpoint.intent === "replace")
        return {
          id: id("source-association-proposal"),
          kind: "replace" as const,
          subjectId: input.checkpoint.assetId,
          predecessorAssociationId: predecessor!.id,
          successor,
          sourceRecordIds: input.candidate!.sourceRecordIds,
          proposedBy: { kind: "user" as const, actorId: input.initiatedBy },
          evidence: comparison,
        };
      return {
        id: id("source-association-proposal"),
        kind: "establish" as const,
        subjectId: input.checkpoint.assetId,
        successor,
        sourceRecordIds: input.candidate!.sourceRecordIds,
        proposedBy: { kind: "user" as const, actorId: input.initiatedBy },
        evidence: comparison,
      };
    })();
    validateSourceAssociationChange({
      proposal,
      ...(predecessor ? { predecessor } : {}),
    });
    const baseline =
      await this.ports.changeImpactCommands.freezeChangeImpactBaseline({
        assetId: input.checkpoint.assetId,
        recognitionDecisionId: accepted.recognitionDecision.id,
        ...(accepted.recognitionSourceAssociation === undefined
          ? {}
          : {
              recognitionSourceAssociationId:
                accepted.recognitionSourceAssociation.id,
            }),
      });
    const coordinateOwner =
      proposal.kind === "retract"
        ? undefined
        : await this.ports.reuseQueries.findCurrentSourceAssociationByCoordinate(
            {
              sourceIdentity: proposal.successor.sourceIdentity,
              nativeAddress: proposal.successor.nativeAddress,
            },
          );
    const [afterBaseline] =
      await this.ports.reuseQueries.findAcceptedForSubjects([
        input.checkpoint.assetId,
      ]);
    if (
      afterBaseline === undefined ||
      acceptedConcurrencyFingerprint(afterBaseline.accepted) !==
        acceptedConcurrencyFingerprint(accepted)
    )
      return await this.failSourceAssociationDecision(
        input.execution,
        "形成预演期间当前事实或支持已经变化",
      );
    const blockingConditions =
      coordinateOwner === undefined ||
      (proposal.kind !== "establish" &&
        coordinateOwner.id === proposal.predecessorAssociationId)
        ? []
        : coordinateOwner.subjectId === proposal.subjectId
          ? [
              "目标来源地址已由该内容的另一条当前关联持有；请显式撤回 predecessor",
            ]
          : ["目标来源地址已由另一内容持有；请进入身份／边界更正"];
    const current = assetStateProjection(accepted);
    const predecessorRecordIds = new Set(
      predecessor === undefined
        ? []
        : (accepted.metadataSourceRecords ?? [])
            .filter(
              (record) =>
                record.sourceIdentity === predecessor.sourceIdentity &&
                record.nativeAddress === predecessor.nativeAddress,
            )
            .map(({ id: sourceRecordId }) => sourceRecordId),
    );
    const retainedBySourceChange = <
      T extends { sourceRecordIds: readonly string[] },
    >(
      values: readonly T[],
    ) =>
      values.filter(
        ({ sourceRecordIds }) =>
          !sourceRecordIds.some((sourceRecordId) =>
            predecessorRecordIds.has(sourceRecordId),
          ),
      );
    const interpretation = input.candidate?.interpretation;
    const interpretedFacts = projectSourceInterpretationFacts(
      interpretation,
      accepted.entity.id,
    );
    const projectedSourceAssociations =
      proposal.kind === "establish"
        ? [...accepted.sourceAssociations, proposal.successor]
        : proposal.kind === "replace"
          ? [
              ...accepted.sourceAssociations.filter(
                ({ id: associationId }) =>
                  associationId !== proposal.predecessorAssociationId,
              ),
              proposal.successor,
            ]
          : accepted.sourceAssociations.filter(
              ({ id: associationId }) =>
                associationId !== proposal.predecessorAssociationId,
            );
    const projectedArtifactGraph = projectSupportedArtifactGraph({
      current: accepted,
      ...(predecessor === undefined
        ? {}
        : { endingSourceAssociationId: predecessor.id }),
    });
    let preview: ChangeImpactPreview = {
      version: "change-impact-preview/2",
      id: id("change-impact-preview"),
      executionId: input.execution.id,
      assetId: input.checkpoint.assetId,
      change: { kind: "source-association", proposal },
      evidenceComparison: comparison,
      baselines: [
        { key: "complete-current-projection", value: baseline },
        ...(predecessor === undefined
          ? []
          : [{ key: "source-association", value: predecessor.id }]),
      ],
      current,
      projected: {
        ...current,
        ...projectedArtifactGraph,
        sourceAssociations: projectedSourceAssociations.map(
          ({ sourceIdentity, nativeAddress }) => ({
            sourceIdentity,
            nativeAddress,
          }),
        ),
        metadata: [
          ...retainedBySourceChange(accepted.metadata),
          ...interpretedFacts.metadata,
        ],
        entities: [
          ...retainedBySourceChange(accepted.entities ?? []),
          ...interpretedFacts.entities,
        ],
        entityMentions: [
          ...retainedBySourceChange(accepted.entityMentions ?? []),
          ...interpretedFacts.entityMentions,
        ],
        entityResolutionDecisions: [
          ...retainedBySourceChange(accepted.entityResolutionDecisions ?? []),
          ...interpretedFacts.entityResolutionDecisions,
        ],
        relationships: [
          ...retainedBySourceChange(accepted.relationships ?? []),
          ...interpretedFacts.relationships,
        ],
      },
      blockingConditions,
      requestContext: input.execution.selection.informationRequirement,
      status: "awaiting-confirmation",
    };
    preview = freezeChangeImpactFactReads(
      preview,
      this.ports.metadataPolicyConfiguration,
      (await this.ports.executionQueries.inspectExecution(input.execution.id))
        ?.sourceRecords ?? [],
    );
    const awaiting: WorkflowExecution = {
      ...input.execution,
      sourceAssociationDecision: {
        ...input.checkpoint,
        state: "awaiting-confirmation",
        proposal,
        previewId: preview.id,
      },
    };
    await this.ports.recognitionChangeImpact.finishExecutionWithSourceAssociationPreview(
      {
        expectedExecution: input.execution,
        execution: awaiting,
        preview,
      },
    );
    return await this.publicSourceAssociationDecision(awaiting, preview);
  }

  private async publicSourceAssociationDecision(
    execution: WorkflowExecution,
    knownPreview?: ChangeImpactPreview,
  ): Promise<SourceAssociationDecisionInspection> {
    const checkpoint = execution.sourceAssociationDecision!;
    const preview =
      knownPreview ??
      (checkpoint.previewId === undefined
        ? undefined
        : await this.ports.changeImpactQueries.inspectChangeImpactPreview(
            checkpoint.previewId,
          ));
    const actions: SourceAssociationDecisionInspection["availableActions"] =
      checkpoint.state === "awaiting-selection"
        ? ["select", "cancel"]
        : checkpoint.state === "awaiting-confirmation"
          ? ["apply", "reject"]
          : execution.status === "failed"
            ? ["retry"]
            : [];
    const history =
      await this.ports.reuseQueries.inspectSourceAssociationHistory(
        checkpoint.assetId,
      );
    return {
      executionId: execution.id,
      status: execution.status,
      state: checkpoint.state,
      assetId: checkpoint.assetId,
      intent: checkpoint.intent,
      ...(checkpoint.predecessor === undefined
        ? {}
        : { predecessor: checkpoint.predecessor }),
      currentAssociations: history?.current ?? [],
      historicalAssociations: history?.historical ?? [],
      inputRequirements: this.sourceInputRequirements().filter(
        ({ sourceIdentity }) => sourceIdentity === checkpoint.sourceIdentity,
      ),
      candidates: checkpoint.candidates.map(publicSourceAssociationCandidate),
      ...(checkpoint.proposal === undefined
        ? {}
        : {
            evidenceComparison: publicEvidenceComparison(
              checkpoint.proposal.evidence,
            ),
          }),
      ...(checkpoint.failure === undefined
        ? {}
        : { failure: checkpoint.failure }),
      ...(preview === undefined
        ? {}
        : { preview: publicChangeImpactPreview(preview) }),
      availableActions: actions,
    };
  }

  /**
   * 纯读投影：列出某主体在耐久接受历史中归属的资产库身份。只读取既有执行检查点里记录的
   * accepted 主体与其创建时冻结的 workflowInput.assetLibrary，不触发任何采集，也不任选其一；
   * 多于一个即多库共享，交由上层以友好名称引导明确的定向补充。
   */
  async assetLibraryIdsOwningSubject(
    subjectId: string,
  ): Promise<readonly string[]> {
    const executions = await this.ports.executionQueries.listExecutions();
    const owners = new Set<string>();
    for (const execution of executions) {
      const libraryId = execution.workflowInput?.assetLibrary?.id;
      if (libraryId === undefined) continue;
      const accepted =
        execution.acceptedAssetId === subjectId ||
        (execution.workItems ?? []).some(
          (item) => item.acceptedAssetId === subjectId,
        );
      if (accepted) owners.add(libraryId);
    }
    return [...owners];
  }

  /**
   * 从耐久接受历史证明某主体唯一归属的资产库：恰好一个库返回其身份；零个或多个
   * （多库不任选）返回 undefined，交由调用方友好引导明确的定向补充。
   */
  private async uniqueOwningAssetLibraryId(
    subjectId: string,
  ): Promise<string | undefined> {
    const owners = await this.assetLibraryIdsOwningSubject(subjectId);
    return owners.length === 1 ? owners[0] : undefined;
  }

  /**
   * 给一个已接受主体显式补充新来源。它建立独立的耐久执行，并复用普通来源采集、解释、
   * 来源产物和 SourceEnrichmentPersistence 提交路径。
   */
  async enrichSource(
    input: ExplicitSourceEnrichmentInput,
  ): Promise<AssetRefreshInspection> {
    return await atPublicWorkflowBoundary(async () => {
      // 定向补充须先确立可靠资产库语境并在任何外部效果前原子冻结其当前完整 09 范围：
      // 调用方已范围化到某库则沿用该活动快照；否则以明确传入或耐久接受历史证明的唯一归属
      // 定位库，绝不借今日全局能力伪称补充，也绝不在多库归属时任选其一。
      if (this.ports.assetLibrarySnapshot === undefined) {
        const libraryId =
          input.assetLibraryId ??
          (await this.uniqueOwningAssetLibraryId(input.subjectId));
        if (libraryId === undefined || this.ports.assetLibraries === undefined)
          throw new Error("请从明确的资产库发起定向补充");
        return await this.workflowForLibrary(
          await this.ports.assetLibraries.snapshot(libraryId),
        ).enrichSource(input);
      }
      const capabilities = (
        this.ports.sourceAddressingCapabilities ?? []
      ).filter(
        (candidate) =>
          candidate.inputRequirement.sourceIdentity === input.sourceIdentity,
      );
      if (capabilities.length !== 1)
        throw new Error("所选来源不支持明确来源补充");
      const capability = capabilities[0]!;
      const normalized = capability.normalize(input.sourceInput);
      if (normalized.status === "invalid") throw new Error(normalized.reason);
      if (
        normalized.evidence.sourceIdentity !== input.sourceIdentity ||
        normalized.evidence.sourceAddress === undefined
      )
        throw new Error("来源能力返回了无效的规范化地址");

      const [target] = await this.ports.reuseQueries.findAcceptedForSubjects([
        input.subjectId,
      ]);
      if (target === undefined || target.subjectId !== input.subjectId)
        throw new Error("所选内容不存在或尚未确认");
      const sameSource = target.accepted.sourceAssociations.filter(
        (association) => association.sourceIdentity === input.sourceIdentity,
      );
      const exactAssociation = sameSource.find(
        (association) =>
          association.nativeAddress === normalized.evidence.sourceAddress,
      );

      const requirement =
        input.informationRequirement ?? emptyInformationRequirement;
      const resolvedSelection = await freezeAssetRefreshSelection({
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: input.subjectId,
            explanations: [{ path: ["source-enrichment", input.subjectId] }],
          },
        ],
        filesystemScopes: [],
      });
      const initial: WorkflowExecution = {
        id: id("execution"),
        workflowInput: {
          version: "asset-refresh-input/1",
          trigger: "interactive",
          initiatedBy: input.initiatedBy ?? "interactive",
          acceptTrusted: false,
          configurationReferences: [],
          ...(this.ports.assetLibrarySnapshot === undefined
            ? {}
            : { assetLibrary: this.ports.assetLibrarySnapshot }),
        },
        selection: {
          intent: "source-enrichment",
          informationRequirement: requirement,
        },
        operationKind: "refresh-metadata",
        requestedSelection: {
          version: "asset-refresh-selection/1",
          subjects: [
            {
              subjectId: input.subjectId,
              explanations: [{ path: ["source-enrichment", input.subjectId] }],
            },
          ],
          filesystemScopes: [],
        },
        resolvedSelection,
        filesystemSnapshots: [],
        targetDispositions: [
          {
            key: `subject:${input.subjectId}`,
            target: { kind: "subject", subjectId: input.subjectId },
            status: "running",
          },
        ],
        status: "running",
        stage: "recognition",
        sourceRecordIds: [],
        acceptedAssetId: input.subjectId,
        compatibility: this.compatibility(),
        dispositions: [],
      };
      const start = await this.ports.executionCommands.createExecution(initial);
      if (start !== "started") throw new AutomationExecutionNotStarted(start);
      input.onExecutionStarted?.(initial);
      if (exactAssociation !== undefined) {
        const finished: WorkflowExecution = {
          ...initial,
          status: "completed",
          stage: "completed",
          outcome: "no-change",
          targetDispositions: initial.targetDispositions!.map((item) => ({
            ...item,
            status: "no-change" as const,
          })),
        };
        await this.transition(initial, finished);
        return await this.inspectPublic(finished.id);
      }
      let execution = await this.freezeCapabilityParticipation(initial, [
        capability.capability,
      ]);
      const enrichment = await this.enrichAcceptedSubjectsInExecution({
        execution,
        selection: resolvedSelection,
        informationRequirement: requirement,
        explicitEvidence: [
          {
            subjectId: input.subjectId,
            evidence: normalized.evidence,
            normalizedInput: normalized.normalizedInput,
          },
        ],
        onProgress: input.onProgress,
        onCheckpoint: input.onCheckpoint,
        onHostCheckpoint: input.onHostCheckpoint,
      });
      execution = enrichment.execution;
      const finished: WorkflowExecution = {
        ...execution,
        status: enrichment.failed === 0 ? "completed" : "failed",
        stage: enrichment.failed === 0 ? "completed" : "failed",
        outcome: enrichment.failed === 0 ? "accepted" : "failed",
        ...(enrichment.failed === 0
          ? {}
          : { reason: "明确来源补充未完成；已确认内容保持有效" }),
        targetDispositions: execution.targetDispositions!.map((item) => ({
          ...item,
          status:
            enrichment.failed === 0
              ? ("completed" as const)
              : ("failed" as const),
          ...(enrichment.failed === 0
            ? {}
            : { reason: "明确来源补充未完成；可以稍后重试" }),
        })),
      };
      await this.transition(execution, finished);
      return await this.inspectPublic(finished.id);
    });
  }

  /**
   * 明确"再次获取"一个已终止失败的来源补充项：创建全新执行并耐久关联前次失败执行与
   * 该项，按创建时活动资产库原子冻结完整 09 来源范围。自动候选由当前已接受主体／当前
   * 证据重新推导（保持选定来源与精确地址，当前线索消失则不续取）；显式项复用旧保存的
   * 规范化非秘密输入，但新冻结寻址能力须兼容同一精确地址，否则提示明确的新定向补充。
   * 旧 failed 检查点与来源记录绝不冒充新结果，旧失败历史不改写；中断的新执行只 resume 新 ID。
   */
  async retrySourceEnrichment(input: {
    readonly executionId: string;
    readonly subjectId: string;
    readonly sourceIdentity: string;
    readonly initiatedBy?: string;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
  }): Promise<AssetRefreshInspection> {
    return await atPublicWorkflowBoundary(async () => {
      const prior = await this.ports.executionQueries.inspectExecution(
        input.executionId,
      );
      const priorExecution = prior?.execution;
      if (priorExecution === undefined)
        throw new Error("找不到要再次获取的来源补充执行");
      if (priorExecution.status === "running")
        throw new Error("只有已终止的来源补充可以再次获取");
      const failedItem = (priorExecution.sourceEnrichments ?? []).find(
        (item) =>
          item.subjectId === input.subjectId &&
          item.stage === "failed" &&
          item.evidence.sourceIdentity === input.sourceIdentity,
      );
      if (failedItem === undefined)
        throw new Error("所选主体没有可再次获取的失败来源补充项");
      // 严校所选失败项：需具备精确来源坐标，且其生产者属于前次执行的兼容能力集。缺证据、
      // 畸形或生产者不再兼容的旧项不得借今日全局能力伪称恢复，只诚实引导新的定向补充。
      if (
        !sourceEnrichmentFailureIsRetryable(
          failedItem.evidence,
          priorExecution.compatibility.capabilityCoordinates,
        )
      )
        throw new Error(
          "该失败项缺少可靠的当前证据，请从明确的资产库发起新的定向补充",
        );
      // retry 恒以创建时活动资产库原子冻结完整 09 范围：缺可靠库归属不借今日配置伪称恢复；
      // 即便调用方已是旧 scoped 实例，也要重取当前活动快照并在不一致时重新范围化，绝不借旧快照。
      const libraryId = priorExecution.workflowInput?.assetLibrary?.id;
      if (
        libraryId === undefined ||
        this.ports.assetLibraries === undefined ||
        this.ports.assetLibrarySnapshot === undefined
      ) {
        if (libraryId === undefined || this.ports.assetLibraries === undefined)
          throw new Error(
            "该失败项缺少可靠的资产库归属，请从明确的资产库发起新的定向补充",
          );
        return await this.workflowForLibrary(
          await this.ports.assetLibraries.snapshot(libraryId),
        ).retrySourceEnrichment(input);
      }
      const activeLibrary = await this.ports.assetLibraries.snapshot(libraryId);
      if (
        activeLibrary.id !== this.ports.assetLibrarySnapshot.id ||
        activeLibrary.configVersion !==
          this.ports.assetLibrarySnapshot.configVersion ||
        assetLibrarySnapshotFingerprint(activeLibrary) !==
          assetLibrarySnapshotFingerprint(this.ports.assetLibrarySnapshot)
      )
        return await this.workflowForLibrary(
          activeLibrary,
        ).retrySourceEnrichment(input);

      let explicitEvidence:
        | readonly {
            readonly subjectId: string;
            readonly evidence: RecognitionEvidence;
            readonly normalizedInput: Readonly<Record<string, string>>;
          }[]
        | undefined;
      let addressingCapability: SourceAddressingCapability | undefined;
      if (failedItem.explicitInput !== undefined) {
        const capabilities = (
          this.ports.sourceAddressingCapabilities ?? []
        ).filter(
          (candidate) =>
            candidate.inputRequirement.sourceIdentity === input.sourceIdentity,
        );
        if (capabilities.length !== 1)
          throw new Error("当前来源能力不再支持该项的定向补充，请明确重新定向");
        addressingCapability = capabilities[0]!;
        const normalized = addressingCapability.normalize(
          failedItem.explicitInput,
        );
        if (
          normalized.status === "invalid" ||
          normalized.evidence.sourceAddress !==
            failedItem.evidence.sourceAddress
        )
          throw new Error("旧定向输入与当前来源能力不兼容，请明确重新定向");
        explicitEvidence = [
          {
            subjectId: input.subjectId,
            evidence: normalized.evidence,
            normalizedInput: normalized.normalizedInput,
          },
        ];
      }

      const sourceAddress = failedItem.evidence.sourceAddress!;
      // 精准锁定所选旧失败项：自动分支只允许同主体／来源／精确规范地址的单一候选。
      const restrictTo = {
        subjectId: input.subjectId,
        sourceIdentity: input.sourceIdentity,
        sourceAddress,
      };
      const retryIntent = {
        version: "source-enrichment-retry/1" as const,
        priorExecutionId: priorExecution.id,
        subjectId: input.subjectId,
        sourceIdentity: input.sourceIdentity,
        sourceAddress,
        ...(failedItem.explicitInput === undefined
          ? {}
          : { explicitInput: failedItem.explicitInput }),
        // 显式项创建时即耐久绑定所采用的精确寻址能力坐标，使首检查点前中断也留有可严校的耐久依据。
        ...(addressingCapability === undefined
          ? {}
          : {
              addressingCapability: {
                capabilityId: addressingCapability.capability.capabilityId,
                capabilityVersion:
                  addressingCapability.capability.capabilityVersion,
                contractVersion:
                  addressingCapability.capability.contractVersion,
              },
            }),
      };

      const requirement =
        priorExecution.selection.informationRequirement ??
        emptyInformationRequirement;
      const resolvedSelection = await freezeAssetRefreshSelection({
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: input.subjectId,
            explanations: [{ path: ["source-enrichment", input.subjectId] }],
          },
        ],
        filesystemScopes: [],
      });
      const initial: WorkflowExecution = {
        id: id("execution"),
        workflowInput: {
          version: "asset-refresh-input/1",
          trigger: "interactive",
          initiatedBy: input.initiatedBy ?? "interactive",
          acceptTrusted: false,
          configurationReferences: [],
          ...(this.ports.assetLibrarySnapshot === undefined
            ? {}
            : { assetLibrary: this.ports.assetLibrarySnapshot }),
          parentExecutionId: priorExecution.id,
          sourceEnrichmentRetry: retryIntent,
        },
        selection: {
          intent: "source-enrichment",
          informationRequirement: requirement,
        },
        operationKind: "refresh-metadata",
        requestedSelection: {
          version: "asset-refresh-selection/1",
          subjects: [
            {
              subjectId: input.subjectId,
              explanations: [{ path: ["source-enrichment", input.subjectId] }],
            },
          ],
          filesystemScopes: [],
        },
        resolvedSelection,
        filesystemSnapshots: [],
        targetDispositions: [
          {
            key: `subject:${input.subjectId}`,
            target: { kind: "subject", subjectId: input.subjectId },
            status: "running",
          },
        ],
        status: "running",
        stage: "recognition",
        sourceRecordIds: [],
        acceptedAssetId: input.subjectId,
        // 显式项的寻址能力在创建事务内即记入耐久兼容集，早于任何外部效果与首检查点。
        compatibility: this.compatibility(
          addressingCapability === undefined
            ? []
            : [addressingCapability.capability],
        ),
        dispositions: [],
      };
      const start = await this.ports.executionCommands.createExecution(initial);
      if (start !== "started") throw new AutomationExecutionNotStarted(start);
      input.onExecutionStarted?.(initial);
      let execution = initial;
      const enrichment = await this.enrichAcceptedSubjectsInExecution({
        execution,
        selection: resolvedSelection,
        informationRequirement: requirement,
        ...(explicitEvidence === undefined ? {} : { explicitEvidence }),
        restrictTo,
        onProgress: input.onProgress,
        onCheckpoint: input.onCheckpoint,
        onHostCheckpoint: input.onHostCheckpoint,
      });
      execution = enrichment.execution;
      const applied = (execution.sourceEnrichments ?? []).some(
        (item) =>
          item.subjectId === input.subjectId &&
          item.stage === "applied" &&
          item.evidence.sourceIdentity === input.sourceIdentity &&
          item.evidence.sourceAddress === restrictTo.sourceAddress,
      );
      const finished: WorkflowExecution = applied
        ? {
            ...execution,
            status: "completed",
            stage: "completed",
            outcome: "accepted",
            targetDispositions: execution.targetDispositions!.map((item) => ({
              ...item,
              status: "completed" as const,
            })),
          }
        : enrichment.failed > 0
          ? {
              ...execution,
              status: "failed",
              stage: "failed",
              outcome: "failed",
              reason: "再次获取未完成；本地身份与材料保持不变，可稍后重试",
              targetDispositions: execution.targetDispositions!.map((item) => ({
                ...item,
                status: "failed" as const,
              })),
            }
          : {
              // 当前已无可用自动来源线索（配置或证据变化使候选消失）：既不伪造成功，
              // 也不退回失败重试，明确提示改用定向补充。
              ...execution,
              status: "completed",
              stage: "completed",
              outcome: "no-change",
              reason: "当前已无可用自动来源线索，请使用明确的定向补充",
              targetDispositions: execution.targetDispositions!.map((item) => ({
                ...item,
                status: "no-change" as const,
              })),
            };
      await this.transition(execution, finished);
      return await this.inspectPublic(finished.id);
    });
  }

  /**
   * 首来源检查点之前被中断的新重试之正式续跑。从 workflowInput 中耐久版本化的精确意图重建
   * 同一操作：显式项复用保存的规范化非秘密输入并验证当前寻址能力兼容同一精确地址，自动项以
   * 同主体／来源／精确规范地址锁定唯一候选。沿同一新执行与同一租约继续，绝不退回普通自动补充、
   * 不重开旧失败执行、不以当前候选替换显式输入；当前线索改变／消失／歧义则零外部效果并友好引导。
   */
  private async resumeSourceEnrichmentRetry(
    execution: WorkflowExecution,
    intent: NonNullable<AssetRefreshWorkflowInput["sourceEnrichmentRetry"]>,
    input: {
      readonly onProgress?: ((message: string) => void) | undefined;
      readonly onCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
      readonly onHostCheckpoint?:
        | ((execution: WorkflowExecution) => void)
        | undefined;
    },
    mutationClaim: () => { readonly token: string; readonly now: string },
  ): Promise<AssetRefreshInspection> {
    const restrictTo = {
      subjectId: intent.subjectId,
      sourceIdentity: intent.sourceIdentity,
      sourceAddress: intent.sourceAddress,
    };
    let explicitEvidence:
      | readonly {
          readonly subjectId: string;
          readonly evidence: RecognitionEvidence;
          readonly normalizedInput: Readonly<Record<string, string>>;
        }[]
      | undefined;
    if (intent.explicitInput !== undefined) {
      // 显式 retry 必须保持耐久显式模式：先沿用创建路径的同一唯一原则，按来源收集当前寻址能力并要求
      // 恰一项，再核对该唯一项三段坐标与耐久坐标相等。缺失／同来源不唯一（即便旧能力项仍在、与另一
      // 不同 capabilityId 并存）／实现或合同版本漂移／拒绝规范化／改址，一律零外部效果并友好引导新的
      // 定向补充；绝不因旧项仍匹配耐久坐标或自动材料仍给原地址而续取，也不退化为自动候选或改写旧规范输入。
      const durable = intent.addressingCapability;
      const sameSource = (this.ports.sourceAddressingCapabilities ?? []).filter(
        (candidate) =>
          candidate.inputRequirement.sourceIdentity === intent.sourceIdentity,
      );
      const unique = sameSource.length === 1 ? sameSource[0] : undefined;
      const capability =
        durable === undefined ||
        unique === undefined ||
        unique.capability.capabilityId !== durable.capabilityId ||
        unique.capability.capabilityVersion !== durable.capabilityVersion ||
        unique.capability.contractVersion !== durable.contractVersion
          ? undefined
          : unique;
      const normalized = capability?.normalize(intent.explicitInput);
      if (
        normalized === undefined ||
        normalized.status !== "accepted" ||
        normalized.evidence.sourceAddress !== intent.sourceAddress
      ) {
        // 寻址依据不再兼容：把这条耐久新执行终结为无变化的友好引导，不进入任何采集或自动候选循环。
        const finished: WorkflowExecution = {
          ...execution,
          status: "completed",
          stage: "completed",
          outcome: "no-change",
          reason:
            "当前来源能力与原来的定向依据不再兼容，请从明确的资产库发起新的定向补充",
          targetDispositions: (execution.targetDispositions ?? []).map(
            (item) => ({ ...item, status: "no-change" as const }),
          ),
        };
        await this.transition(execution, finished, mutationClaim());
        return await this.inspectResumedPublic(finished.id);
      }
      explicitEvidence = [
        {
          subjectId: intent.subjectId,
          evidence: normalized.evidence,
          normalizedInput: normalized.normalizedInput,
        },
      ];
    }
    const resolvedSelection = await freezeAssetRefreshSelection({
      version: "asset-refresh-selection/1",
      subjects: [
        {
          subjectId: intent.subjectId,
          explanations: [{ path: ["source-enrichment", intent.subjectId] }],
        },
      ],
      filesystemScopes: [],
    });
    const enrichment = await this.enrichAcceptedSubjectsInExecution({
      execution,
      selection: resolvedSelection,
      informationRequirement:
        execution.selection.informationRequirement ??
        emptyInformationRequirement,
      ...(explicitEvidence === undefined ? {} : { explicitEvidence }),
      restrictTo,
      onProgress: input.onProgress,
      onCheckpoint: input.onCheckpoint,
      onHostCheckpoint: input.onHostCheckpoint,
      resumeClaim: mutationClaim(),
    });
    const running = enrichment.execution;
    const applied = (running.sourceEnrichments ?? []).some(
      (item) =>
        item.subjectId === restrictTo.subjectId &&
        item.stage === "applied" &&
        item.evidence.sourceIdentity === restrictTo.sourceIdentity &&
        item.evidence.sourceAddress === restrictTo.sourceAddress,
    );
    const finished: WorkflowExecution = applied
      ? {
          ...running,
          status: "completed",
          stage: "completed",
          outcome: "accepted",
          targetDispositions: running.targetDispositions!.map((item) => ({
            ...item,
            status: "completed" as const,
          })),
        }
      : enrichment.failed > 0
        ? {
            ...running,
            status: "failed",
            stage: "failed",
            outcome: "failed",
            reason: "再次获取未完成；本地身份与材料保持不变，可稍后重试",
            targetDispositions: running.targetDispositions!.map((item) => ({
              ...item,
              status: "failed" as const,
            })),
          }
        : {
            ...running,
            status: "completed",
            stage: "completed",
            outcome: "no-change",
            reason: "当前已无可用自动来源线索，请使用明确的定向补充",
            targetDispositions: running.targetDispositions!.map((item) => ({
              ...item,
              status: "no-change" as const,
            })),
          };
    await this.transition(running, finished, mutationClaim());
    return await this.inspectResumedPublic(finished.id);
  }

  /**
   * 无采集地投影某主体已终止的失败来源补充项，供普通主体读取与页面重开时展示友好的
   * "再次获取"。每个主体—来源只取最新一条终态记录（新执行覆盖旧证据），据此诚实区分
   * 可靠可重试与须发起新定向的旧／畸形项；绝不触发任何采集，也不外显来源地址、检查点、
   * 版本或内部键。页面自身不得据此自动重试。
   */
  async inspectRetryableSourceEnrichments(subjectId: string): Promise<
    readonly {
      readonly executionId: string;
      readonly subjectId: string;
      readonly sourceIdentity: string;
      readonly canRetry: boolean;
    }[]
  > {
    if (subjectId.length === 0) throw new Error("来源补充重试投影需要主体身份");
    const executions = await this.ports.executionQueries.listExecutions();
    const seen = new Set<string>();
    const options: {
      readonly executionId: string;
      readonly subjectId: string;
      readonly sourceIdentity: string;
      readonly canRetry: boolean;
    }[] = [];
    for (const execution of executions) {
      for (const item of execution.sourceEnrichments ?? []) {
        if (item.subjectId !== subjectId) continue;
        const sourceIdentity = item.evidence.sourceIdentity;
        if (sourceIdentity === undefined) continue;
        const key = `${subjectId}\u0000${sourceIdentity}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (execution.status === "running" || item.stage !== "failed") continue;
        options.push({
          executionId: execution.id,
          subjectId,
          sourceIdentity,
          canRetry: sourceEnrichmentFailureIsRetryable(
            item.evidence,
            execution.compatibility.capabilityCoordinates,
          ),
        });
      }
      const retryIntent =
        execution.workflowInput?.version === "asset-refresh-input/1"
          ? execution.workflowInput.sourceEnrichmentRetry
          : undefined;
      if (
        execution.status !== "running" &&
        execution.outcome === "no-change" &&
        retryIntent !== undefined &&
        retryIntent.subjectId === subjectId
      ) {
        const intentKey = `${subjectId}\u0000${retryIntent.sourceIdentity}`;
        if (!seen.has(intentKey)) {
          seen.add(intentKey);
          options.push({
            executionId: execution.id,
            subjectId,
            sourceIdentity: retryIntent.sourceIdentity,
            canRetry: false,
          });
        }
      }
    }
    return options;
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
        ...(this.ports.assetLibrarySnapshot === undefined
          ? {}
          : { assetLibrary: this.ports.assetLibrarySnapshot }),
        ...(initiation?.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: initiation.parentExecutionId }),
        ...(initiation?.directoryAuthorizations === undefined
          ? {}
          : { directoryAuthorizations: initiation.directoryAuthorizations }),
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
    if (
      !(await this.registerDurableInformationFulfillmentChild(
        initial,
        initiation,
        (created) => {
          input.onExecutionStarted?.(created);
        },
      ))
    ) {
      const startDisposition =
        await this.ports.executionCommands.createExecution(initial);
      if (startDisposition !== "started") {
        throw new AutomationExecutionNotStarted(startDisposition);
      }
      input.onExecutionStarted?.(initial);
    }
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
          existing.accepted.sourceAssociations.map((association) => [
            association.id,
            association,
          ]),
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
      if (associations.length === 0) {
        const unavailable = completeTargetDisposition(
          execution,
          key,
          "failed",
          "所选主体没有当前来源关联",
        );
        await this.transition(execution, unavailable);
        execution = unavailable;
        continue;
      }
      const sourceScopes: string[] = [];
      const associationRuns: SourceRefreshRun[] = [];
      for (const association of associations) {
        const sourceScope = `source-refresh:${target.subjectId}:${association.id}`;
        if (!usesSourceRefreshRunAuthority) sourceScopes.push(sourceScope);
        const refreshed = await this.refreshAcceptedAssociation(
          execution,
          existing,
          input,
          association,
          key,
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
    // 补充成功提交后，把此前因“无当前来源”而记 failed 的同一主体提升为 completed，
    // 让汇总据已提交结果诚实计数，不沿用补充前的 failed。
    const enrichedSubjectIds = new Set(
      (execution.sourceEnrichments ?? [])
        .filter((checkpoint) => checkpoint.stage === "applied")
        .map((checkpoint) => checkpoint.subjectId),
    );
    if (enrichedSubjectIds.size > 0)
      execution = {
        ...execution,
        targetDispositions: execution.targetDispositions!.map((target) => {
          if (
            target.target.kind !== "subject" ||
            target.status !== "failed" ||
            !enrichedSubjectIds.has(target.target.subjectId)
          )
            return target;
          const { reason: _reason, ...promoted } = target;
          return { ...promoted, status: "completed" as const };
        }),
      };
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
    readonly explicitEvidence?: readonly {
      readonly subjectId: string;
      readonly evidence: RecognitionEvidence;
      readonly normalizedInput: Readonly<Record<string, string>>;
    }[];
    /**
     * 精准重试约束：只允许与所选旧失败项同 subjectId／sourceIdentity／精确规范
     * sourceAddress 的单一自动候选。当前证据改变、消失或歧义则不规划任何采集。
     */
    readonly restrictTo?: {
      readonly subjectId: string;
      readonly sourceIdentity: string;
      readonly sourceAddress: string;
    };
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
      (candidateInterpreters.length === 0 &&
        input.explicitEvidence === undefined) ||
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
      readonly explicitInput?: Readonly<Record<string, string>>;
    }[] = [];
    for (const target of acceptedTargets) {
      const state: SourceEnrichmentInput = {
        subjectId: target.subjectId,
        ...(target.accepted.recognitionSourceAssociation === undefined
          ? {}
          : {
              recognitionSourceAssociation:
                target.accepted.recognitionSourceAssociation,
            }),
        recognitionDecisionId: target.accepted.recognitionDecision.id,
        sourceAssociations: target.accepted.sourceAssociations,
        metadata: target.accepted.metadata,
        metadataSourceRecords: target.accepted.metadataSourceRecords ?? [],
        informationRequirement: input.informationRequirement,
      };
      const explicit = input.explicitEvidence?.filter(
        (item) => item.subjectId === target.subjectId,
      );
      if (explicit !== undefined) {
        for (const item of explicit) {
          planned.push({
            target,
            state,
            candidateInterpreter: {
              capability: item.evidence.producer,
              interpret: () => item.evidence,
            },
            evidence: item.evidence,
            explicitInput: item.normalizedInput,
          });
        }
        continue;
      }
      for (const candidateInterpreter of candidateInterpreters) {
        execution = await this.freezeCapabilityParticipation(
          execution,
          [candidateInterpreter.capability],
          input.resumeClaim,
        );
        const acceptedBasis = target.accepted.proposal.basis;
        const candidateEvidence = candidateInterpreter.interpret({
          ...state,
          observedEvidence:
            acceptedBasis.kind === "source-interpretation"
              ? target.accepted.proposal.ruleResults.flatMap(
                  (result) => result.evidence,
                )
              : acceptedBasis.evidence,
        });
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
          evidence.sourceAddress === undefined
        )
          continue;
        // 冻结库范围在外部效果前约束来源候选：库未启用的来源不生成任务，也不留下失败
        // 检查点（禁用来源＝零效果），本地格式检查独立照常。
        if (
          this.ports.assetLibrarySnapshot !== undefined &&
          assetLibrarySnapshotSourceScope(
            this.ports.assetLibrarySnapshot,
            evidence.sourceIdentity,
          ) === undefined
        )
          continue;
        // 精准重试只保留与所选旧失败项同主体／来源／精确规范地址的唯一候选；当前
        // 证据改变、消失或落到其它来源时全部跳过，零外部效果。
        if (
          input.restrictTo !== undefined &&
          !(
            target.subjectId === input.restrictTo.subjectId &&
            evidence.sourceIdentity === input.restrictTo.sourceIdentity &&
            evidence.sourceAddress === input.restrictTo.sourceAddress
          )
        )
          continue;
        if (
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
        explicitInput,
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
          ...(explicitInput === undefined ? {} : { explicitInput }),
          fulfilledArtifactRoles: [...roleCounts].map(([role, count]) => ({
            role,
            count,
          })),
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
        const durableFailures = durableSourceCollectionFailures(
          collection.failures,
        );
        const collectionCodes = sourceFailureCodes(collection.failures);
        const retainedCheckpoint: RetainedSourceEnrichmentCheckpoint = {
          ...initial,
          stage: "source-records-retained",
          sourceRecordIds: collection.records.map((record) => record.id),
          collectionFailures: durableFailures,
        };
        const checkpoint =
          collection.failures.length === 0
            ? retainedCheckpoint
            : { ...retainedCheckpoint, stage: "failed" as const };
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
            dispositions: execution.dispositions.map((item) =>
              item.key === key && collection.failures.length > 0
                ? {
                    ...item,
                    status: "failed" as const,
                    reason: collection.failures
                      .map((failure) => failure.reason)
                      .join("；"),
                    ...(collectionCodes === undefined
                      ? {}
                      : { sourceFailureCodes: collectionCodes }),
                  }
                : item,
            ),
          },
          checkpoint,
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
        const enrichmentDecision = sourceEnrichmentDecision(
          interpretedCheckpoint,
          execution.workflowInput?.initiatedBy ?? "interactive",
        );
        await persistence.applySourceEnrichment({
          expectedExecution: execution,
          execution: appliedExecution,
          expectedRecognitionBaseline: {
            ...(interpretedCheckpoint.subject.recognitionSourceAssociation ===
            undefined
              ? {}
              : {
                  recognitionSourceAssociationId:
                    interpretedCheckpoint.subject.recognitionSourceAssociation
                      .id,
                }),
            recognitionDecisionId:
              interpretedCheckpoint.subject.recognitionDecisionId,
          },
          assetId: interpretedCheckpoint.subjectId,
          sourceAssociation: interpretedCheckpoint.sourceAssociation,
          ...enrichmentDecision,
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
    const interpretations = await interpretRetainedSourceRecords({
      interpreters: this.ports.sourceInterpreters,
      evidence: [checkpoint.evidence],
      sourceRecords: records,
      beforeInterpret,
    });
    const matches = interpretations.filter(
      (interpretation) =>
        interpretation.sourceIdentity === checkpoint.evidence.sourceIdentity,
    );
    if (matches.length !== 1)
      throw new Error("来源补充未形成当前关联的唯一完整解释");
    const interpretation = matches[0]!;
    const associationInterpreter = sourceAssociationInterpreterFor({
      interpreters: this.ports.sourceAssociationInterpreters ?? [],
      evidence: checkpoint.evidence,
      interpretation,
    });
    if (associationInterpreter === undefined)
      throw new Error("没有来源关联解释能力接受补充来源");
    await beforeInterpret(associationInterpreter.capability);
    const associationInterpretation = associationInterpreter.interpret({
      subject: checkpoint.subject,
      evidence: checkpoint.evidence,
      interpretation,
    });
    if (associationInterpretation === undefined)
      throw new Error("来源关联解释能力不适用于当前已接受身份");
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
        const durableFailures = durableSourceCollectionFailures(
          collection.failures,
        );
        const collectionCodes = sourceFailureCodes(collection.failures);
        const collectedCheckpoint:
          | RetainedSourceEnrichmentCheckpoint
          | (SourceEnrichmentCheckpointBase & {
              readonly stage: "failed";
              readonly sourceRecordIds: readonly string[];
              readonly collectionFailures: readonly DurableSourceCollectionFailure[];
            }) = {
          ...checkpoint,
          stage:
            collection.failures.length === 0
              ? "source-records-retained"
              : "failed",
          sourceRecordIds: collection.records.map((record) => record.id),
          collectionFailures: durableFailures,
        };
        checkpoint = collectedCheckpoint;
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
            dispositions: execution.dispositions.map((item) =>
              item.key === checkpoint.key && collection.failures.length > 0
                ? {
                    ...item,
                    status: "failed" as const,
                    reason: collection.failures
                      .map((failure) => failure.reason)
                      .join("；"),
                    ...(collectionCodes === undefined
                      ? {}
                      : { sourceFailureCodes: collectionCodes }),
                  }
                : item,
            ),
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
      if (checkpoint.stage === "failed") continue;
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
        const enrichmentDecision = sourceEnrichmentDecision(
          activeCheckpoint,
          execution.workflowInput?.initiatedBy ?? "interactive",
        );
        await persistence.applySourceEnrichment({
          expectedExecution: execution,
          execution: completed,
          expectedRecognitionBaseline: {
            ...(activeCheckpoint.subject.recognitionSourceAssociation ===
            undefined
              ? {}
              : {
                  recognitionSourceAssociationId:
                    activeCheckpoint.subject.recognitionSourceAssociation.id,
                }),
            recognitionDecisionId:
              activeCheckpoint.subject.recognitionDecisionId,
          },
          assetId: activeCheckpoint.subjectId,
          sourceAssociation: activeCheckpoint.sourceAssociation,
          ...enrichmentDecision,
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
    readonly directedSourceProducer?: CapabilityCoordinate | undefined;
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
    readonly libraryScanParent?: LibraryScanChildCoordinates | undefined;
    /** 本次调用实际取得的库目录授权代次，随子执行耐久冻结。 */
    readonly directoryAuthorityVersion?: number | undefined;
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
        ...(this.ports.assetLibrarySnapshot === undefined
          ? {}
          : { assetLibrary: this.ports.assetLibrarySnapshot }),
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
        // 目录子只冻结自己那一条授权代次：本目录被移除或重连后它的下一次效果与提交被持久
        // 拒绝，同库其他目录的既有权威不受牵连。
        ...(() => {
          if (input.directoryAuthorityVersion === undefined) return {};
          const [observedRoot] = input.resolvedSelection.filesystemScopes
            .map((scope) => scope.observedRoot)
            .filter((root) => root !== undefined);
          return observedRoot === undefined
            ? {}
            : {
                directoryAuthorizations: [
                  {
                    observedRootId: observedRoot.id,
                    authorityVersion: input.directoryAuthorityVersion,
                  },
                ],
              };
        })(),
        ...(input.libraryScanParent === undefined
          ? {}
          : {
              parentExecutionId: input.libraryScanParent.parentExecutionId,
              parentDirectoryKey: input.libraryScanParent.directoryKey,
              directoryCoverage: input.libraryScanParent.coverage,
            }),
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
    const parent = input.libraryScanParent;
    if (parent === undefined) {
      const startDisposition =
        await this.ports.executionCommands.createExecution(
          observationInitial,
          input.requestedAt,
        );
      if (startDisposition !== "started") {
        throw new AutomationExecutionNotStarted(startDisposition);
      }
    } else {
      // 目录子与父登记在同一条事务里落下；取消胜出时这里既不插入子也不留下目录绑定。
      const registered =
        await this.ports.executionCommands.registerLibraryScanChild({
          parentExecutionId: parent.parentExecutionId,
          directoryKey: parent.directoryKey,
          execution: observationInitial,
          ...(input.requestedAt === undefined
            ? {}
            : { requestedAt: input.requestedAt }),
        });
      if (registered === "cancelled")
        throw new LibraryScanCancelledBeforeChildError(
          parent.parentExecutionId,
        );
      if (registered !== "registered")
        throw new Error("此目录已在本次库扫描中登记，不能重复物理观察");
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
    const formatFailures: WorkItemDisposition[] = [];
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
          this.ports.observedRootRegistrations.assertDirectoryOperationLive(
            input.scope,
          );
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
            evidence = await inspector.inspect({
              observedArtifactReference: group.representative.relativePath,
              byteSource,
            });
          } catch (error) {
            rethrowWorkflowLifecycle(error);
            evidence = [];
            formatFailures.push({
              key: `format-inspection:${inspector.capability.capabilityId}:${group.representative.relativePath}`,
              status: "failed",
              materialReferences: group.relativePaths,
              reason: "无法读取此文件",
            });
          } finally {
            await byteSource.close();
          }
          // 不可信能力输出不是单个材料损坏，不能被部分可用策略吞掉。
          evidence = bindRecognitionEvidenceOutputToProducer(
            evidence,
            inspector.capability,
            inspector.relationshipDefinitions,
          );
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
          [
            input.directedSourceProducer ??
              directedRecognitionEvidenceCapability,
          ],
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
    let hasExplicitWorkItems =
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
                  producer:
                    input.directedSourceProducer ??
                    directedRecognitionEvidenceCapability,
                },
              ],
            },
          ];
    let plannedWorkItems: readonly AssetRefreshWorkItemPlan[] =
      input.intent === "metadata-refresh"
        ? []
        : input.directedSourceAddress === undefined
          ? planRecognitionWorkItems(snapshot, interpretations)
          : directedWorkItems;
    plannedWorkItems = plannedWorkItems.map((plan) => ({
      ...plan,
      boundaries: bindRecognitionMaterialBoundaries({
        snapshot,
        boundRoot: input.scope.root,
        relativePaths: plan.relativePaths,
        ...(plan.materialBoundary === undefined
          ? {}
          : { materialBoundary: plan.materialBoundary }),
      }),
    }));
    if (
      input.intent === "scan-now" &&
      input.directedSourceAddress === undefined
    ) {
      const effective =
        await this.ports.reuseQueries.listEffectiveMaterialBoundaries({
          scope: input.scope.root,
          relativeScope: input.scope.relativeScope,
        });
      const declarations =
        await this.ports.reuseQueries.listMaterialScopeDeclarations?.({
          scopeAddress: observedAddress(
            input.scope.root.containerPath,
            input.scope.relativeScope,
          ),
        });
      plannedWorkItems = reconcileRecognitionMaterialPlans({
        snapshot,
        boundRoot: input.scope.root,
        plans: plannedWorkItems,
        effective,
        formatInterpretation,
        ...(declarations === undefined ? {} : { declarations }),
      });
      // 07 已把同一来源身份下的材料范围扩大点名为原决定的离散范围修订。为这类工作项补充来源无关
      // 的精确字节观察，使后续正式范围决定预演能引用真实冻结修订；未知媒体只断言字节修订，不解析
      // 容器/编码/字幕，也不重复运行专用格式检查器。仅覆盖这些工作项引用的文件，不做全库哈希。
      const isScopeRevision = (item: AssetRefreshWorkItemPlan) =>
        item.retainedAssetId !== undefined &&
        item.retainedDecisionId !== undefined &&
        item.reuseAcceptedBoundary !== true &&
        item.boundaryConflict === undefined;
      const scopeRevisionCandidates = plannedWorkItems.filter(isScopeRevision);
      if (scopeRevisionCandidates.length > 0) {
        const scopeRevisionPaths = new Set(
          scopeRevisionCandidates.flatMap((item) => item.relativePaths),
        );
        const revisionSnapshot: FilesystemPackageSnapshot = {
          ...snapshot,
          files: snapshot.files.filter((file) =>
            scopeRevisionPaths.has(file.relativePath),
          ),
        };
        const observed = await this.observeWholeFileRevisions(
          input.scope,
          revisionSnapshot,
          () => input.onProgress?.("复验范围修订材料的精确字节"),
        );
        const observationsByPath = new Map(
          observed.evidence
            .filter((item) => item.inspection !== undefined)
            .map((item) => [item.inspection!.observedArtifactReference, item]),
        );
        plannedWorkItems = plannedWorkItems.map((item) =>
          isScopeRevision(item)
            ? {
                ...item,
                evidence: [
                  ...item.evidence,
                  ...item.relativePaths.flatMap((relativePath) => {
                    const observation = observationsByPath.get(relativePath);
                    return observation === undefined ? [] : [observation];
                  }),
                ],
              }
            : item,
        );
      }
    }
    hasExplicitWorkItems = hasExplicitWorkItems || plannedWorkItems.length > 0;
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
        ...formatFailures,
        { key: "directory-interpretation", status: "running" },
      ],
      ...(hasExplicitWorkItems
        ? {
            workItems: plannedWorkItems.map((item) => ({
              key: item.key,
              relativePaths: item.relativePaths,
              ...(item.boundaries === undefined
                ? {}
                : { boundaries: item.boundaries }),
              ...(item.boundaryBaseline === undefined
                ? {}
                : { boundaryBaseline: item.boundaryBaseline }),
              ...(item.retainedAssetId === undefined
                ? {}
                : { retainedAssetId: item.retainedAssetId }),
              ...(item.retainedDecisionId === undefined
                ? {}
                : { retainedDecisionId: item.retainedDecisionId }),
              ...(item.reuseAcceptedBoundary === undefined
                ? {}
                : { reuseAcceptedBoundary: item.reuseAcceptedBoundary }),
              ...(item.boundaryConflict === undefined
                ? {}
                : { boundaryConflict: item.boundaryConflict }),
              ...(item.materialBoundary === undefined
                ? {}
                : { materialBoundary: item.materialBoundary }),
              ...(item.observedArtifactAssociations === undefined
                ? {}
                : {
                    observedArtifactAssociations:
                      item.observedArtifactAssociations,
                  }),
              ...(item.observedArtifactBoundary === undefined
                ? {}
                : { observedArtifactBoundary: item.observedArtifactBoundary }),
              ...(item.observedArtifactBoundaryProducer === undefined
                ? {}
                : {
                    observedArtifactBoundaryProducer:
                      item.observedArtifactBoundaryProducer,
                  }),
              ...(item.independentIdentityDeclaredBy === undefined
                ? {}
                : {
                    independentIdentityDeclaredBy:
                      item.independentIdentityDeclaredBy,
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
          dispositions: initial.dispositions.map((item) =>
            item.status === "failed"
              ? item
              : {
                  ...item,
                  status: "completed" as const,
                  reason: "未发现适用的目录识别线索",
                },
          ),
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
          // 发起外部请求前复核该目录租约：撤销后绝不启动下一 collector 的外部效果。
          this.ports.observedRootRegistrations.assertDirectoryOperationLive(
            input.scope,
          );
          collectionExecution = await this.bindCollectorConfiguration(
            collectionExecution,
            collector,
            currentEvidence,
          );
          collectionExecution = await this.freezeCapabilityParticipation(
            collectionExecution,
            [collector.capability],
          );
          // bind/freeze 是可 await 的异步前置效果：撤销落在其间时不得再发起不可中止的 collect
          // 外部请求，故在真正 collect 之前复核同一 scope 租约（发起前的检查不是最终效果门）。
          this.ports.observedRootRegistrations.assertDirectoryOperationLive(
            input.scope,
          );
          const collected = retainCollectedRecordProvenance(
            collector,
            await collector.collect(
              currentEvidence,
              this.collectionExecutionContext(collectionExecution),
            ),
          );
          // 不可中止的已发请求可返回，但撤销期间返回不得把结果并入或进入后续暂存/提交：
          // 合并前用同一 scope 租约复核。
          this.ports.observedRootRegistrations.assertDirectoryOperationLive(
            input.scope,
          );
          sourceRecords.push(...collected.records);
          collectionFailures.push(...collected.failures);
        } catch (error) {
          // 撤销期间返回的错误不是普通采集失败：再次复核让取消向上中止，绝不继续下一 collector。
          this.ports.observedRootRegistrations.assertDirectoryOperationLive(
            input.scope,
          );
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
    const retainedCollectionExecution = executionWithRetainedSourceRecords(
      collectionExecution,
      sourceRecords,
    );
    const codes = sourceFailureCodes(collectionFailures);
    const sourced: WorkflowExecution = {
      ...retainedCollectionExecution,
      stage: "source-records-retained",
      sourceRecordIds: retainedCollectionExecution.sourceRecordIds,
      dispositions: [
        ...initial.dispositions.filter(
          (item) => item.materialReferences !== undefined,
        ),
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
          ...(codes === undefined ? {} : { sourceFailureCodes: codes }),
        },
      ],
    };
    if (blockingCollectionFailures.length > 0) {
      const failed = terminal(
        sourced,
        "failed",
        blockingCollectionFailures.map((failure) => failure.reason).join("；"),
      );
      if (sourceRecords.length > 0)
        await this.ports.executionCommands.retainSourceRecords({
          expectedExecution: collectionExecution,
          execution: failed,
          sourceRecords,
        });
      else await this.transition(collectionExecution, failed);
      return await this.inspectPublic(failed.id);
    }
    if (sourceRecords.length > 0)
      await this.ports.executionCommands.retainSourceRecords({
        expectedExecution: collectionExecution,
        execution: sourced,
        sourceRecords,
      });
    else await this.transition(collectionExecution, sourced);
    notifyDurableCheckpoint(input, sourced);

    try {
      let recognitionExecution = sourced;
      const batches = await interpretRetainedSourceRecords({
        interpreters: this.ports.sourceInterpreters,
        evidence,
        sourceRecords,
        beforeInterpret: async (capability) => {
          recognitionExecution = await this.freezeCapabilityParticipation(
            recognitionExecution,
            [capability],
          );
        },
      });
      const proposals: RecognitionProposal[] = [];
      const candidateContexts = recognitionCandidateContexts({
        evidence,
        interpretations: batches,
      });
      for (const recognizer of this.ports.recognizers) {
        for (const candidateContext of candidateContexts) {
          const recognizerInput = frozenRecognitionInput(candidateContext);
          if (!recognizer.canRecognize(recognizerInput)) continue;
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
        sameRecognitionIdentity(
          current.accepted,
          proposal,
          current.execution.snapshot?.files ?? snapshot.files,
          snapshot.files,
          input.directedSourceAddress !== undefined,
        );
      if (
        current !== undefined &&
        recognitionChangesOnlySourceAddress(
          current.accepted,
          proposal,
          current.execution.snapshot?.files ?? snapshot.files,
          snapshot.files,
        )
      )
        throw new Error("仅更改来源地址必须使用来源关联更换流程");
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
      if (currentAccepted === undefined) {
        const plannedExecution: WorkflowExecution = {
          ...acquisitionExecution,
          proposalId: proposal.id,
          plannedAssetId: acceptedAsset.id,
        };
        await this.transition(acquisitionExecution, plannedExecution);
        acquisitionExecution = plannedExecution;
      }
      input.onProgress?.(
        selectedArtifacts.length === 0
          ? "当前信息需求不需要获取来源产物"
          : "正在获取所需来源产物",
      );
      let storedExecution: WorkflowExecution | undefined;
      const managedArtifacts: ManagedSourceArtifactCheckpoint[] = [];
      for (const [selectionIndex, candidate] of selectedArtifacts.entries()) {
        const acquireDispositionKey = sourceArtifactDispositionKey(
          "acquire",
          selectedArtifacts,
          selectionIndex,
        );
        const storeDispositionKey = sourceArtifactDispositionKey(
          "store",
          selectedArtifacts,
          selectionIndex,
        );
        const necessity =
          informationRequirement.artifactRoles.find(
            (requested) => requested.role === candidate.role,
          )?.necessity ?? "required";
        const acquired = await runSourceArtifactAcquisitionEffect({
          necessity,
          acquire: async () =>
            await this.sourceArtifactWork.acquireAndStage({
              candidate,
              proposal,
              sourceRecords,
              idempotencyKey: sourceArtifactIdempotencyKey(
                initial.id,
                candidate,
              ),
              requireCheckpointStore: false,
              assertEffectLive: () =>
                this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                  input.scope,
                ),
              beforeAcquire: async (capability) => {
                acquisitionExecution = await this.freezeCapabilityParticipation(
                  acquisitionExecution,
                  [capability],
                );
              },
            }),
        });
        if (acquired.status === "optional-failed") {
          const skipped: WorkflowExecution = {
            ...acquisitionExecution,
            dispositions: [
              ...acquisitionExecution.dispositions.filter(
                (item) => item.key !== acquireDispositionKey,
              ),
              {
                key: acquireDispositionKey,
                status: "failed",
                reason: "可选来源产物获取失败；识别仍可继续",
              },
            ],
          };
          await this.transition(acquisitionExecution, skipped);
          acquisitionExecution = skipped;
          notifyDurableCheckpoint(input, skipped);
          continue;
        }
        const acquiredExecution: WorkflowExecution = {
          ...acquisitionExecution,
          proposalId: proposal.id,
          stage: "source-artifacts-acquired",
          sourceArtifactAcquisitions: [
            ...(acquisitionExecution.sourceArtifactAcquisitions ?? []),
            acquired.value.checkpoint,
          ],
          dispositions: [
            ...acquisitionExecution.dispositions.filter(
              (item) =>
                item.key !== acquireDispositionKey &&
                item.key !== storeDispositionKey,
            ),
            {
              key: acquireDispositionKey,
              status: "completed",
              effectReference: acquired.value.checkpoint.stagedReference,
            },
            {
              key: storeDispositionKey,
              status: "running",
            },
          ],
        };
        await this.transition(acquisitionExecution, acquiredExecution);
        notifyDurableCheckpoint(input, acquiredExecution);
        // 易失 checkpoint 路径无 stage：托管 store 才是本路径的耐久最终效果，撤销后不得把
        // 已获取来源写入托管位置，故在真正 store 之前复核同一 scope 租约。
        this.ports.observedRootRegistrations.assertDirectoryOperationLive(
          input.scope,
        );
        const managed = await this.sourceArtifactWork.store({
          acquisition: acquired.value.checkpoint,
          ...(acquired.value.staged === undefined
            ? {}
            : { staged: acquired.value.staged }),
          requireCheckpointStore: false,
        });
        managedArtifacts.push(managed);
        const completedStorageExecution: WorkflowExecution = {
          ...acquiredExecution,
          stage: "source-artifacts-stored",
          managedSourceArtifacts: [...managedArtifacts],
          dispositions: acquiredExecution.dispositions.map((item) =>
            completeManagedStoreDisposition(item, storeDispositionKey, managed),
          ),
        };
        await this.transition(acquiredExecution, completedStorageExecution);
        acquisitionExecution = completedStorageExecution;
        storedExecution = completedStorageExecution;
        notifyDurableCheckpoint(input, completedStorageExecution);
      }
      if (selectedArtifacts.length === 0) {
        const emptyStored: WorkflowExecution = {
          ...acquisitionExecution,
          proposalId: proposal.id,
          stage: "source-artifacts-stored",
          managedSourceArtifacts: [],
        };
        await this.transition(acquisitionExecution, emptyStored);
        acquisitionExecution = emptyStored;
        storedExecution = emptyStored;
        notifyDurableCheckpoint(input, emptyStored);
      } else if (storedExecution === undefined) {
        const optionalOnlyStored: WorkflowExecution = {
          ...acquisitionExecution,
          proposalId: proposal.id,
          stage: "source-artifacts-stored",
          managedSourceArtifacts: [],
        };
        await this.transition(acquisitionExecution, optionalOnlyStored);
        acquisitionExecution = optionalOnlyStored;
        storedExecution = optionalOnlyStored;
        notifyDurableCheckpoint(input, optionalOnlyStored);
      }
      if (storedExecution === undefined)
        throw new Error("Source-artifact storage checkpoint was skipped");
      let executionForAcceptance = acquisitionExecution;
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
      const acceptanceWorkItem = (acceptedExecution.workItems ?? []).find(
        (candidate) => candidate.proposalId === proposal.id,
      );
      if (currentAccepted === undefined) {
        validateAcceptedRecognition(accepted);
        await this.ports.recognitionAcceptance.acceptRecognition({
          expectedExecution: lastPersistedExecution,
          execution: acceptedExecution,
          accepted,
          observedMaterialAcceptances: observedMaterialAcceptanceBindings({
            accepted,
            snapshot,
            workItemKey: acceptanceWorkItem?.key ?? "",
            acceptanceKind: "a-work-item",
            relativePaths:
              acceptanceWorkItem?.relativePaths ??
              (proposal.observedArtifactAssociations ?? []).map(
                (reference) => reference.observedArtifactReference,
              ),
            ...(acceptanceWorkItem?.observedArtifactBoundary === undefined
              ? {}
              : {
                  observedArtifactBoundary:
                    acceptanceWorkItem.observedArtifactBoundary,
                }),
          }),
        });
      } else {
        validateReevaluatedRecognition({
          current: currentAccepted,
          accepted,
        });
        const currentRecognitionAssociation =
          currentAccepted.recognitionSourceAssociation;
        const expectedLineageHeads =
          currentRecognitionAssociation === undefined
            ? []
            : await this.ports.metadataRefreshPersistence.freezeSourceLineageHeads(
                {
                  assetId: currentAccepted.entity.id,
                  sourceAssociation: currentRecognitionAssociation,
                  coverageIds: [
                    ...new Set(
                      sourceRecords.map((record) => record.coverage.id),
                    ),
                  ],
                },
              );
        await this.ports.recognitionReevaluation.refreshAcceptedRecognition({
          expectedExecution: lastPersistedExecution,
          execution: acceptedExecution,
          current: currentAccepted,
          accepted,
          observedMaterialAcceptances: observedMaterialAcceptanceBindings({
            accepted,
            snapshot,
            workItemKey: acceptanceWorkItem?.key ?? "",
            acceptanceKind: "a-work-item",
            relativePaths:
              acceptanceWorkItem?.relativePaths ??
              (proposal.observedArtifactAssociations ?? []).map(
                (reference) => reference.observedArtifactReference,
              ),
            ...(acceptanceWorkItem?.observedArtifactBoundary === undefined
              ? {}
              : {
                  observedArtifactBoundary:
                    acceptanceWorkItem.observedArtifactBoundary,
                }),
          }),
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
    const persisted = await this.ports.executionQueries.inspectExecution(
      initial.id,
    );
    const durableOnlyCollectionPlans = new Map<
      string,
      readonly SourceRecord[]
    >();
    let guardedInitial = initial;
    if (resumeClaim !== undefined) {
      const frozenInvocations = plans.flatMap((plan) =>
        plan.evidence.flatMap((evidence) =>
          this.ports.collectors.flatMap((collector) => {
            if (!collector.canCollect(evidence)) return [];
            const shareKey = sourceCollectionShareKey(collector, evidence);
            return [{ planKey: plan.key, collector, evidence, shareKey }];
          }),
        ),
      );
      for (const plan of plans) {
        const prior = guardedInitial.workItems?.find(
          (item) => item.key === plan.key,
        );
        if (
          prior === undefined ||
          prior.outcome !== undefined ||
          prior.sourceRecordIds.length > 0
        )
          continue;
        if (
          recognitionCandidateContexts({
            evidence: plan.evidence,
            interpretations: [],
            ...(plan.materialBoundary === undefined
              ? {}
              : { materialBoundary: plan.materialBoundary }),
          }).some(
            (context) =>
              context.basis.kind === "observed-evidence" &&
              this.ports.recognizers.some((recognizer) =>
                recognizer.canRecognize(frozenRecognitionInput(context)),
              ),
          )
        )
          continue;
        const applicable = frozenInvocations.filter(
          (invocation) => invocation.planKey === plan.key,
        );
        const durableRecords = applicable.map(({ collector, shareKey }) =>
          shareKey === undefined
            ? []
            : persistedSharedCollectionRecordsForPlanKeys(
                persisted,
                frozenInvocations
                  .filter(
                    (invocation) =>
                      invocation.collector === collector &&
                      invocation.shareKey === shareKey,
                  )
                  .map((invocation) => invocation.planKey),
              ),
        );
        const pureDurableShared =
          applicable.length > 0 &&
          durableRecords.every((records) => records.length > 0);
        if (pureDurableShared) {
          durableOnlyCollectionPlans.set(plan.key, [
            ...new Map(
              durableRecords
                .flat()
                .map((record) => [record.id, record] as const),
            ).values(),
          ]);
          continue;
        }
        guardedInitial = completeWorkItem(guardedInitial, plan.key, {
          sourceRecordIds: [],
          outcome: "failed",
          reason: "官方来源完整采集批次尚未提交，当前工作项不能安全继续",
        });
      }
      if (guardedInitial !== initial) {
        await this.transition(initial, guardedInitial, resumeClaim);
        notifyDurableCheckpoint(input, guardedInitial, false);
      }
    }
    let execution: WorkflowExecution = {
      ...guardedInitial,
      dispositions: [
        ...guardedInitial.dispositions.filter(
          (item) => item.materialReferences !== undefined,
        ),
        { key: "directory-interpretation", status: "completed" },
        ...plans.map((item) => {
          const prior = guardedInitial.workItems?.find(
            (current) => current.key === item.key,
          );
          const durable = guardedInitial.dispositions.find(
            (current) => current.key === `work-item:${item.key}`,
          );
          return {
            ...durable,
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
    await this.transition(guardedInitial, execution, resumeClaim);
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
            recognitionSourceInterpretation(inspection.proposal)
              ?.sourceArtifacts ?? [],
          );
        } catch (error) {
          sourceArtifactDefinitionConflicts.set(
            inspection.proposal.id,
            errorMessage(error),
          );
        }
      }
      for (const managed of inspection.workItem.managedSourceArtifacts ?? []) {
        const rawCandidate = (
          inspection.proposal === undefined
            ? []
            : (recognitionSourceInterpretation(inspection.proposal)
                ?.sourceArtifacts ?? [])
        ).find((item) =>
          checkpointMatchesCandidateExceptSubject(managed, item),
        );
        const acceptedAssetId =
          inspection.accepted?.entity.id ??
          inferCheckpointedAcceptedAssetId(
            inspection.proposal === undefined
              ? []
              : (recognitionSourceInterpretation(inspection.proposal)
                  ?.sourceArtifacts ?? []),
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
      )
        continue;
      if (plan.boundaryConflict !== undefined) {
        execution = completeWorkItem(execution, plan.key, {
          sourceRecordIds: [],
          outcome: "unresolved",
          reason: plan.boundaryConflict,
        });
        await this.transitionAfterWorkItem(execution, resumeClaim);
        continue;
      }
      if (
        execution.workItems?.find((item) => item.key === plan.key)?.outcome !==
        undefined
      ) {
        continue;
      }
      if (
        execution.dispositions.some(
          (disposition) =>
            disposition.status === "failed" &&
            disposition.materialReferences?.some((reference) =>
              plan.relativePaths.includes(reference),
            ),
        )
      ) {
        execution = completeWorkItem(execution, plan.key, {
          sourceRecordIds: [],
          outcome: "failed",
          reason: "这项内容中有文件未能通过检查",
        });
        await this.transitionAfterWorkItem(execution, resumeClaim);
        continue;
      }
      const exactRetained =
        await this.ports.reuseQueries.findAcceptedForWorkItem({
          directory: requiredFilesystemDirectory(initial),
          relativePaths: plan.relativePaths,
        });
      const retained =
        plan.retainedAssetId === undefined ||
        exactRetained?.accepted.entity.id === plan.retainedAssetId
          ? exactRetained
          : (
              await this.ports.reuseQueries.findAcceptedForSubjects([
                plan.retainedAssetId,
              ])
            )[0];
      if (plan.retainedAssetId !== undefined && retained === undefined) {
        execution = completeWorkItem(execution, plan.key, {
          sourceRecordIds: [],
          outcome: "unresolved",
          reason:
            "材料仍有已确认的范围支持，但当前资产身份已结束，需要明确处理",
        });
        await this.transitionAfterWorkItem(execution, resumeClaim);
        continue;
      }
      if (retained !== undefined && plan.reuseAcceptedBoundary === true) {
        // 追加范围只复用支持它的决定；内容变化时不借主身份的刷新改写，见下方处置。
        const refreshesHeadDecision =
          plan.retainedDecisionId === undefined ||
          plan.retainedDecisionId === retained.accepted.recognitionDecision.id;
        // 比较基线只能是被点名决定自己那次观察：主头的执行里没有追加材料，拿它当基线
        // 会把未变的追加材料判成缺失，进而被误判成需要修订。
        const decisionObservation =
          plan.retainedDecisionId === undefined
            ? undefined
            : await this.ports.reuseQueries.findAcceptedForDecision?.({
                decisionId: plan.retainedDecisionId,
              });
        if (
          plan.retainedDecisionId !== undefined &&
          (decisionObservation === undefined ||
            decisionObservation.execution.snapshot === undefined)
        ) {
          // 没有唯一可比的观察记录就诚实停下：不借主身份的执行顶替，也不把缺证据说成内容变化。
          execution = completeWorkItem(execution, plan.key, {
            sourceRecordIds: [],
            outcome: "unresolved",
            reason:
              "该范围决定没有可比的观察记录，需要明确决定后才能继续，不会改写当前身份",
          });
          await this.transitionAfterWorkItem(execution, resumeClaim);
          continue;
        }
        const reusedProposal =
          decisionObservation?.proposal ?? retained.accepted.proposal;
        const reusedExecution =
          decisionObservation?.execution ?? retained.execution;
        const localAssociations: readonly ObservedArtifactAssociationCandidate[] =
          [
            ...plan.relativePaths.map((observedArtifactReference) => ({
              observedArtifactReference,
              role: "asset.material-delivered" as const,
            })),
            ...(plan.observedArtifactAssociations ?? []).filter(
              (item) => item.role !== "asset.material-delivered",
            ),
            ...(reusedProposal.observedArtifactAssociations ?? []).filter(
              (item) =>
                item.role !== "asset.material-delivered" &&
                plan.relativePaths.includes(item.observedArtifactReference) &&
                !(plan.observedArtifactAssociations ?? []).some(
                  (candidate) =>
                    candidate.role === item.role &&
                    candidate.observedArtifactReference ===
                      item.observedArtifactReference,
                ),
            ),
          ];
        const baseline = reusedExecution.snapshot;
        const previousEvidence =
          reusedExecution.workItems?.find(
            (item) => item.acceptedAssetId === retained.accepted.entity.id,
          )?.planningEvidence ?? [];
        // 冻结坐标只在基线那次运行真的按工作项留下证据时才存在；缺失时不能凭"历史里
        // 没有可比坐标"就把材料判成需要修订。
        const frozenCoordinates =
          previousEvidence.length === 0 || baseline === undefined
            ? undefined
            : inspectedRevisionCoordinates(previousEvidence, baseline.root);
        const changed =
          baseline === undefined ||
          // 冻结坐标属于正在刷新的那份决定：追加范围的比较只看该决定自己那次观察里
          // 的文件事实，绝不借主身份的运行坐标把未变的追加材料误判成需要修订。
          (refreshesHeadDecision &&
            frozenCoordinates !== undefined &&
            inspectedRevisionCoordinates(
              plan.evidence,
              requiredFilesystemSnapshot(initial).root,
            ) !== frozenCoordinates) ||
          plan.relativePaths.some((reference) => {
            const file = initial.snapshot?.files.find(
              (item) => item.relativePath === reference,
            );
            const previous = baseline.files.find(
              (item) =>
                `${baseline.root}/${item.relativePath}` ===
                `${initial.snapshot?.root}/${reference}`,
            );
            return (
              file === undefined ||
              previous === undefined ||
              file.size !== previous.size ||
              file.modifiedAt !== previous.modifiedAt
            );
          }) ||
          // 追加范围不与主身份的产物图比较是否需协调：那份判断只属于正在被刷新的当前
          // 决定，否则会把未变化的追加范围误判成需要修订。
          (refreshesHeadDecision &&
            observedPartAssociationsRequireReconciliation(
              attachObservedFormatFacts(
                {
                  id: id("recognition-proposal"),
                  boundaries: retained.accepted.recognitionDecision.boundaries,
                  observedArtifactAssociations: localAssociations,
                  basis: {
                    kind: "accepted-boundary",
                    recognitionDecisionId:
                      retained.accepted.recognitionDecision.id,
                    observationSnapshotId:
                      requiredFilesystemSnapshot(initial).id,
                    evidence: plan.evidence,
                    materialReferences: plan.relativePaths,
                  },
                  ruleResults: [],
                },
                plan.evidence,
              ),
              retained.accepted,
            ));
        if (changed && !refreshesHeadDecision) {
          // 追加范围的内容变化不能借主身份的刷新改写：材料仍受该决定支持，但更新它需要
          // 一份明确决定，经共同预演确认后才会落库。
          execution = completeWorkItem(execution, plan.key, {
            sourceRecordIds: [],
            outcome: "unresolved",
            reason:
              "这批材料的内容已变化，其追加范围需要明确决定后才能更新，不会自动改写当前身份",
          });
          await this.transitionAfterWorkItem(execution, resumeClaim);
          continue;
        }
        if (changed) {
          const snapshot = requiredFilesystemSnapshot(initial);
          const proposal = attachObservedFormatFacts(
            {
              id: id("recognition-proposal"),
              boundaries: retained.accepted.recognitionDecision.boundaries,
              observedArtifactAssociations: localAssociations,
              basis: {
                kind: "accepted-boundary",
                recognitionDecisionId: retained.accepted.recognitionDecision.id,
                observationSnapshotId: snapshot.id,
                materialReferences: plan.relativePaths,
                evidence: plan.evidence,
              },
              ruleResults: [],
            },
            plan.evidence,
          );
          const selectedSnapshot = {
            ...snapshot,
            files: snapshot.files.filter((file) =>
              plan.relativePaths.includes(file.relativePath),
            ),
          };
          // 范围载体（上面完整三项 proposal/boundaries/materialReferences、冻结执行快照
          // 与范围 CAS）继续声明整条离散范围；交付载体只对本次相对耐久基线确有字节变化的
          // 引用铸造新的 Artifact/Location/Revision。snapshot-local 下按完整范围重扫会把未变
          // 材料重新铸成第二个 Artifact，而来源建立的原始 MKV 又按读取 model (i) 保持 current，
          // 于是出现重复；只用变化项创建 accepted 又会让新决定没续接未变 MP4 的精确支持、MP4
          // 掉出 current。故交付与完整下一状态分开构造：delta 只含变化引用，交给
          // refreshAcceptedRecognition 的 accepted 是"当前完整事实减去被变化坐标替换的旧本地
          // 观察事实，再并入本次增量"。选择只依据工作项冻结的相对引用、Location 地址与
          // Artifact/Revision 关系，绝不依据文件名或 presentation 输出。
          const deliveryReferences =
            baseline === undefined
              ? plan.relativePaths
              : plan.relativePaths.filter((reference) => {
                  const file = snapshot.files.find(
                    (item) => item.relativePath === reference,
                  );
                  const previous = baseline.files.find(
                    (item) =>
                      `${baseline.root}/${item.relativePath}` ===
                      `${snapshot.root}/${reference}`,
                  );
                  return (
                    file === undefined ||
                    previous === undefined ||
                    file.size !== previous.size ||
                    file.modifiedAt !== previous.modifiedAt
                  );
                });
          const deliverySnapshot: FilesystemPackageSnapshot = {
            ...selectedSnapshot,
            files: selectedSnapshot.files.filter((file) =>
              deliveryReferences.includes(file.relativePath),
            ),
          };
          const deliveryProposal: RecognitionProposal = {
            ...proposal,
            observedArtifactAssociations: (
              proposal.observedArtifactAssociations ?? []
            ).filter((candidate) =>
              deliveryReferences.includes(candidate.observedArtifactReference),
            ),
            observedArtifactRevisions: (
              proposal.observedArtifactRevisions ?? []
            ).filter((candidate) =>
              deliveryReferences.includes(candidate.observedArtifactReference),
            ),
          };
          // 提交基线只能取最后一次持久化的运行中审计：可选预览失败的处置随 next 一起
          // 前进，绝不能把它当成数据库里已经存在的状态，否则刷新会判自己过期而整笔回滚。
          const expectedExecution = persistedWorkflowExecution(execution);
          let managedObservedParts: readonly ManagedObservedArtifactPart[] = [];
          let observedPartsFailure: string | undefined;
          try {
            managedObservedParts = await this.materializeObservedArtifactParts(
              deliveryProposal,
              deliverySnapshot,
              withObservedMaterialImageRequirement(requirement),
              input.scope,
            );
          } catch (error) {
            rethrowWorkflowLifecycle(error);
            // 与首次准入一致：预览属于非必要处理，失败只局部记录，不否定已成立的
            // 本地材料，也不撤回该资产已有的身份与支持。
            observedPartsFailure = errorMessage(error);
          }
          const delta = createAcceptedRecognition({
            proposal: deliveryProposal,
            snapshot: deliverySnapshot,
            managedArtifacts: [],
            managedObservedParts,
            current: retained.accepted,
            ...(this.ports.observedRootRegistrations.objectIdentityContract ===
            undefined
              ? {}
              : {
                  objectIdentityContract:
                    this.ports.observedRootRegistrations.objectIdentityContract,
                }),
          });
          // 完整下一状态：以 retained.accepted 为左、delta 为右，先按被交付坐标（同一观察
          // 根下的确切地址）移除其旧本地观察事实，再按稳定 ID 并入增量；未变化的 MP4/MKV
          // 与来源建立的 MKV 原样沿用既有 Artifact/Location/Revision/Association。
          const deliveryAddresses = new Set(
            deliveryReferences.map(
              (reference) => `${snapshot.root}/${reference}`,
            ),
          );
          const replacedArtifactIds = new Set(
            retained.accepted.locations
              .filter(
                (location) =>
                  location.kind === "observed" &&
                  deliveryAddresses.has(location.address),
              )
              .map((location) => location.artifactId),
          );
          const unionById = <T>(
            left: readonly T[],
            right: readonly T[],
            key: (item: T) => string,
          ): readonly T[] => {
            const seen = new Set(left.map(key));
            return [...left, ...right.filter((item) => !seen.has(key(item)))];
          };
          const accepted: AcceptedRecognition = {
            ...delta,
            proposal,
            artifacts: unionById(
              retained.accepted.artifacts.filter(
                (artifact) => !replacedArtifactIds.has(artifact.id),
              ),
              delta.artifacts,
              ({ id: artifactId }) => artifactId,
            ),
            locations: unionById(
              retained.accepted.locations.filter(
                (location) =>
                  !(
                    location.kind === "observed" &&
                    replacedArtifactIds.has(location.artifactId)
                  ),
              ),
              delta.locations,
              (location) => location.id,
            ),
            blobs: unionById(
              retained.accepted.blobs,
              delta.blobs,
              (blob) => blob.digest,
            ),
            artifactRevisions: unionById(
              retained.accepted.artifactRevisions.filter(
                (revision) => !replacedArtifactIds.has(revision.artifactId),
              ),
              delta.artifactRevisions,
              ({ id: revisionId }) => revisionId,
            ),
            artifactAssociations: unionById(
              retained.accepted.artifactAssociations.filter(
                (association) =>
                  !replacedArtifactIds.has(association.artifactId),
              ),
              delta.artifactAssociations,
              ({ id: associationId }) => associationId,
            ),
          };
          execution = completeWorkItem(
            observedPartsFailure === undefined
              ? expectedExecution
              : {
                  ...expectedExecution,
                  dispositions: [
                    ...expectedExecution.dispositions,
                    {
                      key: `work-item:${plan.key}:observed-parts`,
                      status: "failed",
                      reason: `本地内容成立，材料预览尚未生成：${observedPartsFailure}`,
                    },
                  ],
                },
            plan.key,
            {
              sourceRecordIds: [],
              proposalId: proposal.id,
              acceptedAssetId: accepted.entity.id,
              outcome: "accepted",
            },
          );
          try {
            await this.ports.recognitionReevaluation.refreshAcceptedRecognition(
              {
                expectedExecution,
                execution,
                current: retained.accepted,
                accepted,
                observedMaterialAcceptances: observedMaterialAcceptanceBindings(
                  {
                    accepted,
                    snapshot: selectedSnapshot,
                    workItemKey: plan.key,
                    acceptanceKind: "a-work-item",
                    relativePaths: plan.relativePaths,
                    ...(plan.observedArtifactBoundary === undefined
                      ? {}
                      : {
                          observedArtifactBoundary:
                            plan.observedArtifactBoundary,
                        }),
                  },
                ),
                sourceRecords: [],
                expectedLineageHeads: [],
                ...(plan.boundaryBaseline === undefined
                  ? {}
                  : {
                      expectedBoundary: {
                        keys: plan.boundaryBaseline,
                        // 与冻结该基线时同一份相交范围：本次观察的快照根就是
                        // `resolve(root.containerPath, relativeScope)`。
                        scopeAddress: snapshot.root,
                      },
                    }),
                ...(resumeClaim === undefined ? {} : { resumeClaim }),
              },
            );
          } catch (error) {
            if (!(error instanceof RecognitionBoundaryBaselineStale))
              throw error;
            // 范围基线在冻结之后被其他决定改动；这次刷新已整体回滚，保持未解决并
            // 由下一次扫描重新检查，不能凭旧提交写入材料或结束任何支持。
            execution = completeWorkItem(expectedExecution, plan.key, {
              sourceRecordIds: [],
              outcome: "unresolved",
              reason: errorMessage(error),
            });
            await this.transitionAfterWorkItem(execution, resumeClaim);
          }
          continue;
        }
        execution = completeWorkItem(execution, plan.key, {
          sourceRecordIds: [],
          proposalId: reusedProposal.id,
          acceptedAssetId: retained.accepted.entity.id,
          outcome: "no-change",
          reason: "保留已经确认的资产范围",
        });
        await this.transitionAfterWorkItem(execution, resumeClaim);
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
      let localProposals: readonly RecognitionProposal[];
      try {
        localProposals =
          persistedInspection?.proposal === undefined
            ? await this.recognizePlannedWorkItem({
                evidence: plan.evidence,
                boundaries: plan.boundaries ?? [],
                ...(plan.materialBoundary === undefined
                  ? {}
                  : { materialBoundary: plan.materialBoundary }),
                ...(plan.observedArtifactAssociations === undefined
                  ? {}
                  : {
                      observedArtifactAssociations:
                        plan.observedArtifactAssociations,
                    }),
                sourceRecords: [],
                basisKind: "observed-evidence",
                beforeInterpret: async (capability) =>
                  await freezeWorkItemCapability(plan.key, capability),
                beforeRecognize: async (capability) =>
                  await freezeWorkItemCapability(plan.key, capability),
              })
            : persistedInspection.proposal.basis.kind === "observed-evidence"
              ? [persistedInspection.proposal]
              : [];
      } catch (error) {
        rethrowWorkflowLifecycle(error);
        execution = completeWorkItem(execution, plan.key, {
          sourceRecordIds: prior?.sourceRecordIds ?? [],
          outcome: "failed",
          reason: errorMessage(error),
        });
        await this.transitionAfterWorkItem(execution, resumeClaim);
        continue;
      }
      const localAdmission = localProposals.length > 0;
      const admissionRequirement: InformationRequirement = localAdmission
        ? withObservedMaterialImageRequirement({
            ...requirement,
            metadata: requirement.metadata.map((item) => ({
              ...item,
              necessity: "optional",
            })),
            artifactRoles: requirement.artifactRoles.map((item) => ({
              ...item,
              necessity: "optional",
            })),
            relationshipTypes: requirement.relationshipTypes.map((item) => ({
              ...item,
              necessity: "optional",
            })),
          })
        : requirement;
      const records: SourceRecord[] =
        prior === undefined || prior.sourceRecordIds.length === 0
          ? []
          : (persisted?.sourceRecords.filter((record) =>
              prior.sourceRecordIds.includes(record.id),
            ) ?? []);
      const failures: SourceCollectionFailure[] = [];
      const consumedSharedKeys = new Set<string>();
      let usedDurablySharedRecords = false;
      if (
        !localAdmission &&
        (prior === undefined || prior.sourceRecordIds.length === 0)
      ) {
        const durableOnlyRecords = durableOnlyCollectionPlans.get(plan.key);
        if (durableOnlyRecords !== undefined) {
          records.push(...durableOnlyRecords);
          usedDurablySharedRecords = true;
        } else
          for (const evidence of plan.evidence) {
            for (const collector of this.ports.collectors.filter((candidate) =>
              candidate.canCollect(evidence),
            )) {
              try {
                input.onProgress?.("正在获取官方来源");
                if (input.scope !== undefined)
                  this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                    input.scope,
                  );
                const sharedKey = sourceCollectionShareKey(collector, evidence);
                if (
                  sharedKey !== undefined &&
                  consumedSharedKeys.has(sharedKey)
                )
                  continue;
                if (sharedKey !== undefined) consumedSharedKeys.add(sharedKey);
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
                  usedDurablySharedRecords = true;
                  continue;
                }
                execution = await this.bindCollectorConfiguration(
                  execution,
                  collector,
                  evidence,
                  resumeClaim,
                );
                await freezeWorkItemCapability(plan.key, collector.capability);
                // bind/freeze 是可 await 的异步前置效果：撤销落在其间时不得再发起不可中止的
                // collect/collectShared 外部请求，故在真正 request 之前复核同一 scope 租约。
                if (input.scope !== undefined)
                  this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                    input.scope,
                  );
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
                                sourceCollectionShareKey(
                                  collector,
                                  candidate,
                                ) === sharedKey,
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
                // 不可中止的已发请求可返回，但撤销期间返回不得把结果并入或进入下一效果：
                // 合并前用同一目录租约复核。
                if (input.scope !== undefined)
                  this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                    input.scope,
                  );
                records.push(...collected.records);
                failures.push(...collected.failures);
              } catch (error) {
                rethrowWorkflowLifecycle(error);
                // 撤销期间返回的错误不是普通采集失败：再次复核让取消向上中止，绝不继续下一 collector。
                if (input.scope !== undefined)
                  this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                    input.scope,
                  );
                failures.push({
                  capability: collector.capability,
                  reason: errorMessage(error),
                });
              }
            }
          }
      }
      const normalizedRecords = normalizeSourceRecordBatch(records);
      records.splice(0, records.length, ...normalizedRecords);
      const recordIds = records.map((record) => record.id);
      const blocking = failures.filter((failure) =>
        collectionFailureBlocks(failure, requirement),
      );
      const codes = usedDurablySharedRecords
        ? undefined
        : sourceFailureCodes(failures);
      if (blocking.length > 0) {
        const expectedExecution = execution;
        execution = completeWorkItem(execution, plan.key, {
          sourceRecordIds: recordIds,
          outcome: "failed",
          reason: blocking.map((failure) => failure.reason).join("；"),
          ...(blocking.some(sourceCollectionFailureIsPrerequisiteUnavailable)
            ? { failureClassification: prerequisiteUnavailableFailure }
            : {}),
        });
        execution = executionWithDispositionSourceFailureCodes(
          execution,
          `work-item:${plan.key}`,
          codes,
        );
        if (records.length > 0)
          await this.ports.executionCommands.retainSourceRecords({
            expectedExecution,
            execution,
            sourceRecords: records,
            ...(resumeClaim === undefined ? {} : { resumeClaim }),
          });
        else await this.transitionAfterWorkItem(execution, resumeClaim);
        notifyDurableCheckpoint(input, execution, false);
        continue;
      }
      if (records.length > 0 && (prior?.sourceRecordIds.length ?? 0) === 0) {
        const retainedExecution = executionWithDispositionSourceFailureCodes(
          checkpointWorkItem(execution, plan.key, {
            sourceRecordIds: recordIds,
          }),
          `work-item:${plan.key}`,
          codes,
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
      try {
        const proposals: readonly RecognitionProposal[] = localAdmission
          ? localProposals
          : persistedInspection?.proposal === undefined
            ? await this.recognizePlannedWorkItem({
                evidence: plan.evidence,
                boundaries: plan.boundaries ?? [],
                ...(plan.materialBoundary === undefined
                  ? {}
                  : { materialBoundary: plan.materialBoundary }),
                ...(plan.observedArtifactAssociations === undefined
                  ? {}
                  : {
                      observedArtifactAssociations:
                        plan.observedArtifactAssociations,
                    }),
                sourceRecords: records,
                basisKind: "source-interpretation",
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
          admissionRequirement,
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
        // 能力声明独立内容身份的候选落在另一份已确认范围里：识别链已经给出明确结论，这里
        // 停下等待点名决定，绝不自动并入所属资产，也不自动新建身份。
        if (
          plan.independentIdentityDeclaredBy !== undefined &&
          plan.retainedAssetId !== undefined &&
          plan.retainedDecisionId !== undefined
        ) {
          const expectedExecution = execution;
          execution = completeWorkItem(execution, plan.key, {
            sourceRecordIds: recordIds,
            proposalId: proposal.id,
            outcome: "unresolved",
            reason:
              "能力把这份内容声明为独立身份，但它落在已确认的另一资产范围内；需要明确决定，不会自动并入或新建身份",
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
          retained ??
          (await this.ports.reuseQueries.findAcceptedForWorkItem({
            directory: requiredFilesystemDirectory(initial),
            relativePaths: plan.relativePaths,
          }));
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
          const predecessorSnapshotFiles =
            currentAccepted.execution.snapshot?.files ?? itemSnapshot.files;
          const predecessorMatches = plan.relativePaths.map((selected) =>
            predecessorSnapshotFiles.filter(
              ({ relativePath }) =>
                relativePath === selected ||
                relativePath.endsWith(`/${selected}`),
            ),
          );
          const currentObservedFiles = predecessorMatches.every(
            (matches) => matches.length === 1,
          )
            ? predecessorMatches.map(([match], index) => ({
                ...match!,
                relativePath: plan.relativePaths[index]!,
              }))
            : [];
          const sameIdentity = sameRecognitionIdentity(
            currentAccepted.accepted,
            proposal,
            currentObservedFiles,
            itemSnapshot.files.filter(({ relativePath }) =>
              plan.relativePaths.includes(relativePath),
            ),
            false,
          );
          if (
            recognitionChangesOnlySourceAddress(
              currentAccepted.accepted,
              proposal,
              (
                currentAccepted.execution.snapshot?.files ?? itemSnapshot.files
              ).filter(({ relativePath }) =>
                plan.relativePaths.includes(relativePath),
              ),
              itemSnapshot.files.filter(({ relativePath }) =>
                plan.relativePaths.includes(relativePath),
              ),
            )
          )
            throw new Error("仅更改来源地址必须使用来源关联更换流程");
          if (!sameIdentity) {
            // 07 已把同一来源身份下的材料范围扩大点名为原决定的离散范围修订。正式扫描必须
            // 留下可明确范围决定的工作项，交由 prepareRecognitionScopeAmendment 形成范围决定
            // 预演，绝不自动换身份或进入通用身份更正。仅当来源身份坐标未变、差异是范围扩大
            // 时成立；真正的来源身份变更仍走下方通用取代预演。
            if (
              plan.retainedAssetId !== undefined &&
              plan.retainedDecisionId !== undefined &&
              plan.reuseAcceptedBoundary !== true &&
              plan.boundaryConflict === undefined &&
              plan.independentIdentityDeclaredBy === undefined &&
              recognitionSourceCoordinate(currentAccepted.accepted.proposal) ===
                recognitionSourceCoordinate(proposal)
            ) {
              const expectedExecution = execution;
              execution = completeWorkItem(execution, plan.key, {
                sourceRecordIds: recordIds,
                proposalId: proposal.id,
                outcome: "unresolved",
                reason:
                  "同一内容的材料范围扩大，需要明确范围决定后再更新，不会自动改写身份",
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
          recognitionSourceInterpretation(proposal)?.sourceArtifacts ?? [],
        );
        let currentWorkItem = execution.workItems?.find(
          (item) => item.key === plan.key,
        );
        if (
          currentWorkItem?.plannedAssetId !== undefined &&
          currentWorkItem.plannedAssetId.trim().length === 0
        )
          throw new Error("工作项中的预分配识别主体身份无效");
        const acceptedAsset = currentAccepted?.accepted.entity ?? {
          id:
            currentWorkItem?.plannedAssetId ??
            inferCheckpointedAcceptedAssetId(
              selectSourceArtifacts(proposal, admissionRequirement),
              [
                ...(currentWorkItem?.sourceArtifactAcquisitions ?? []),
                ...(currentWorkItem?.managedSourceArtifacts ?? []),
              ],
            ) ??
            id("entity"),
          kind: "digital-asset" as const,
        };
        if (
          currentAccepted === undefined &&
          currentWorkItem?.plannedAssetId === undefined
        ) {
          execution = checkpointWorkItem(execution, plan.key, {
            sourceRecordIds: recordIds,
            proposalId: proposal.id,
            plannedAssetId: acceptedAsset.id,
          });
          await this.transitionAfterWorkItem(execution, resumeClaim);
          currentWorkItem = execution.workItems?.find(
            (item) => item.key === plan.key,
          );
        }
        const selectedSourceArtifacts = selectSourceArtifacts(
          proposal,
          admissionRequirement,
        );
        for (const [
          selectionIndex,
          rawCandidate,
        ] of selectedSourceArtifacts.entries()) {
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
            // 发起不可中止的来源产物获取外部请求前复核该目录租约：撤销后绝不启动下一外部效果。
            if (input.scope !== undefined)
              this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                input.scope,
              );
            const acquired = await runSourceArtifactAcquisitionEffect({
              necessity:
                requirement.artifactRoles.find(
                  (requested) => requested.role === candidate.role,
                )?.necessity ?? "required",
              acquire: async () =>
                await this.sourceArtifactWork.acquireAndStage({
                  candidate,
                  proposal,
                  sourceRecords: records,
                  idempotencyKey: sourceArtifactIdempotencyKey(
                    `${initial.id}:${plan.key}`,
                    candidate,
                  ),
                  requireCheckpointStore: true,
                  ...(input.scope === undefined
                    ? {}
                    : {
                        assertEffectLive: () =>
                          this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                            input.scope!,
                          ),
                      }),
                  beforeAcquire: async (capability) =>
                    await freezeWorkItemCapability(plan.key, capability),
                }),
            });
            // 已发获取请求可返回，但撤销期间返回不得继续形成 checkpoint/stage/managed 效果：
            // 处理结果前用同一目录租约复核。
            if (input.scope !== undefined)
              this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                input.scope,
              );
            if (acquired.status === "optional-failed") {
              const dispositionKey = sourceArtifactDispositionKey(
                "acquire",
                selectedSourceArtifacts,
                selectionIndex,
                `work-item:${plan.key}:source-artifact`,
              );
              execution = {
                ...execution,
                dispositions: [
                  ...execution.dispositions.filter(
                    (item) => item.key !== dispositionKey,
                  ),
                  {
                    key: dispositionKey,
                    status: "failed",
                    reason: "可选来源产物获取失败；识别仍可继续",
                  },
                ],
              };
              await this.transitionAfterWorkItem(execution, resumeClaim);
              notifyDurableCheckpoint(input, execution, false);
              continue;
            }
            acquisition = acquired.value.checkpoint;
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
          // 托管 store 是阶段转换前的耐久副作用：撤销后不得把已获取来源写入托管位置。
          if (input.scope !== undefined)
            this.ports.observedRootRegistrations.assertDirectoryOperationLive(
              input.scope,
            );
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
        let managedObservedParts: readonly ManagedObservedArtifactPart[] = [];
        try {
          managedObservedParts = await this.materializeObservedArtifactParts(
            proposal,
            itemSnapshot,
            admissionRequirement,
            input.scope,
            async (capability) =>
              await freezeWorkItemCapability(plan.key, capability),
          );
        } catch (error) {
          rethrowWorkflowLifecycle(error);
          if (!localAdmission) throw error;
          execution = {
            ...execution,
            dispositions: [
              ...execution.dispositions,
              {
                key: `work-item:${plan.key}:observed-parts`,
                status: "failed",
                reason: `本地内容成立，材料预览尚未生成：${errorMessage(error)}`,
              },
            ],
          };
          await this.transitionAfterWorkItem(execution, resumeClaim);
        }
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
            observedMaterialAcceptances: observedMaterialAcceptanceBindings({
              accepted,
              snapshot: itemSnapshot,
              workItemKey: plan.key,
              acceptanceKind: "a-work-item",
              relativePaths: plan.relativePaths,
              ...(plan.observedArtifactBoundary === undefined
                ? {}
                : { observedArtifactBoundary: plan.observedArtifactBoundary }),
            }),
            ...(resumeClaim === undefined ? {} : { resumeClaim }),
          });
        } else {
          const currentRecognitionAssociation =
            currentAccepted.accepted.recognitionSourceAssociation;
          const expectedLineageHeads =
            currentRecognitionAssociation === undefined
              ? []
              : await this.ports.metadataRefreshPersistence.freezeSourceLineageHeads(
                  {
                    assetId: currentAccepted.accepted.entity.id,
                    sourceAssociation: currentRecognitionAssociation,
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
            observedMaterialAcceptances: observedMaterialAcceptanceBindings({
              accepted,
              snapshot: itemSnapshot,
              workItemKey: plan.key,
              acceptanceKind: "a-work-item",
              relativePaths: plan.relativePaths,
              ...(plan.observedArtifactBoundary === undefined
                ? {}
                : { observedArtifactBoundary: plan.observedArtifactBoundary }),
            }),
            sourceRecords: records,
            expectedLineageHeads,
            ...(resumeClaim === undefined ? {} : { resumeClaim }),
          });
        }
        for (const rawCandidate of selectSourceArtifacts(
          proposal,
          admissionRequirement,
        )) {
          const candidate = resolveSourceArtifactSubject(
            rawCandidate,
            acceptedAsset.id,
          );
          if (
            managedArtifacts.some((managed) =>
              managedSourceArtifactMatchesCandidate(managed, candidate),
            )
          )
            committedSharedArtifactServeKeys.add(
              sourceArtifactCacheKey(candidate),
            );
        }
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
          (item.outcome === "accepted" || item.outcome === "no-change") &&
          item.acceptedAssetId !== undefined
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
      enrichment.failed === 0
        ? workItemTerminal
        : {
            ...workItemTerminal,
            status: "completed",
            stage: "completed",
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
    readonly boundaries: readonly RecognitionMaterialBoundary[];
    readonly materialBoundary?: PlannedMaterialBoundary;
    readonly observedArtifactAssociations?: readonly ObservedArtifactAssociationCandidate[];
    readonly sourceRecords: readonly SourceRecord[];
    readonly basisKind?: "observed-evidence" | "source-interpretation";
    readonly beforeInterpret: (
      capability: CapabilityCoordinate,
    ) => void | Promise<void>;
    readonly beforeRecognize: (
      capability: CapabilityCoordinate,
    ) => void | Promise<void>;
  }): Promise<readonly RecognitionProposal[]> {
    const proposals: RecognitionProposal[] = [];
    const interpretations =
      input.basisKind === "observed-evidence"
        ? []
        : await interpretRetainedSourceRecords({
            interpreters: this.ports.sourceInterpreters,
            evidence: input.evidence,
            sourceRecords: input.sourceRecords,
            beforeInterpret: input.beforeInterpret,
          });
    const candidateContexts = recognitionCandidateContexts({
      evidence: input.evidence,
      interpretations,
      ...(input.materialBoundary === undefined
        ? {}
        : { materialBoundary: input.materialBoundary }),
    });
    for (const recognizer of this.ports.recognizers) {
      for (const candidateContext of candidateContexts) {
        if (
          input.basisKind !== undefined &&
          candidateContext.basis.kind !== input.basisKind
        )
          continue;
        const recognizerInput = frozenRecognitionInput(candidateContext);
        if (!recognizer.canRecognize(recognizerInput)) continue;
        await input.beforeRecognize(recognizer.capability);
        proposals.push(
          validateRecognitionProposalForRecords(
            attachObservedFormatFacts(
              {
                ...bindRecognitionProposalToRecognizer(
                  recognizer,
                  recognizer.recognize(recognizerInput),
                  recognizerInput,
                  input.boundaries,
                ),
                ...(input.observedArtifactAssociations === undefined
                  ? {}
                  : {
                      observedArtifactAssociations:
                        input.observedArtifactAssociations.filter(
                          (candidate) =>
                            candidate.role === "asset.material-delivered" ||
                            recognizerInput.evidence.some(
                              (evidence) =>
                                evidence.inspection
                                  ?.observedArtifactReference ===
                                  candidate.observedArtifactReference &&
                                ((candidate.role !== "asset.primary-cover" &&
                                  candidate.role !== "asset.material-image") ||
                                  evidence.inspection.revision.mediaType.startsWith(
                                    "image/",
                                  )),
                            ),
                        ),
                    }),
              },
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
      this.ports.observedRootRegistrations.assertDirectoryOperationLive(scope!);
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
      // 不可取消的获取返回后，继续托管存储效果前复核本目录授权：撤销即停止，
      // 绝不把已撤销目录取得的字节写入托管存储。
      this.ports.observedRootRegistrations.assertDirectoryOperationLive(scope!);
      if (
        acquired.candidateId !== candidate.id ||
        mediaTypeEssence(acquired.mediaType) !==
          mediaTypeEssence(candidate.mediaType)
      )
        throw new Error(
          "Observed Artifact Part acquisition contradicts its candidate",
        );
      const expectedParent = proposal.observedArtifactRevisions?.find(
        (revision) =>
          revision.observedArtifactReference ===
          candidate.observedArtifactReference,
      );
      if (
        expectedParent !== undefined &&
        (expectedParent.blob.digest !== acquired.origin.digest ||
          mediaTypeEssence(expectedParent.blob.mediaType) !==
            mediaTypeEssence(acquired.origin.mediaType) ||
          expectedParent.blob.byteLength !== acquired.origin.byteLength)
      )
        throw new Error(
          "Observed Artifact Part acquisition contradicts its proposed parent revision",
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
    const sourceArtifactCandidates = await this.publicSourceArtifactCandidates(
      inspection.accepted,
    );
    return {
      ...publicInspection(
        inspection,
        this.ports.metadataPolicyConfiguration,
        sourceArtifactCandidates,
      ),
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
      {
        ...current.execution,
        cancellation,
        ...(current.execution.sourceAssociationDecision === undefined
          ? {}
          : {
              sourceAssociationDecision: {
                ...current.execution.sourceAssociationDecision,
                state: "cancelled" as const,
              },
            }),
      },
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
    if (
      input?.subjectIds !== undefined &&
      (input.subjectIds.length > maximumBrowsePageLimit ||
        input.subjectIds.some(
          (id) => typeof id !== "string" || id.length === 0,
        ))
    )
      throw new Error("Current Catalogue subject selection is invalid");
    const page = await queries.listCurrentCataloguePage({
      ...boundedPageRequest(input, "Current Catalogue"),
      ...(input?.subjectIds === undefined
        ? {}
        : { subjectIds: input.subjectIds }),
      ...(input?.assetLibraryId === undefined
        ? {}
        : { assetLibraryId: input.assetLibraryId }),
    });
    return {
      items: await Promise.all(
        page.items.map(async (accepted) => ({
          ...readEffectiveSubject(
            { ...accepted, id: accepted.entity.id },
            this.ports.metadataPolicyConfiguration,
            input?.informationRequirement?.metadataUsageContext,
            input?.informationRequirement,
          ),
          sourceArtifacts: (
            await this.publicSourceArtifactCandidates(accepted)
          ).map(({ role, mediaType, selectionEvidence }) => ({
            role,
            mediaType,
            ...(selectionEvidence === undefined ? {} : { selectionEvidence }),
          })),
        })),
      ),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  /** 检索索引使用与详情相同的生效元数据规则；不为检索重新定义来源优先级。 */
  async listCurrentCatalogueIndex(
    metadataProperties: readonly string[],
    assetLibraryId?: string,
  ): Promise<readonly CurrentCatalogueIndexEntry[]> {
    const queries = this.ports.currentCatalogueQueries;
    if (queries === undefined)
      throw new Error("Current Catalogue index query is not configured");
    const library =
      assetLibraryId === undefined
        ? undefined
        : await this.ports.assetLibraries?.get(assetLibraryId);
    if (assetLibraryId !== undefined && library === undefined)
      throw new Error("资产库不存在或已移除");
    const facts = await queries.listCurrentCatalogueIndex(
      metadataProperties,
      library?.rootIds,
      assetLibraryId,
    );
    return facts.map((item) => ({
      ...readEffectiveSubject(
        {
          ...item,
          id: item.entity.id,
          artifactAssociations: [],
          artifactRevisions: [],
          blobs: [],
          locations: [],
        },
        this.ports.metadataPolicyConfiguration,
        "asset.ordinary",
        {
          metadata: metadataProperties.map((property) => ({
            property,
            necessity: "optional",
          })),
          artifactRoles: [],
        },
      ),
      additionOrder: item.additionOrder,
    }));
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

  /** 完整读取仍复用有界普通读取；不再暴露检查 DTO。 */
  async listCurrentCatalogue(): Promise<readonly EffectiveSubjectRead[]> {
    const result: EffectiveSubjectRead[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listCurrentCataloguePage({
        limit: maximumBrowsePageLimit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      result.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return result;
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
    const association = existing.accepted.sourceAssociations[0];
    if (association === undefined) {
      const failed = terminal(
        initial,
        "failed",
        "所选范围没有可刷新的已关联来源",
      );
      await this.transition(initial, failed);
      return await this.inspectPublic(failed.id);
    }
    return await this.refreshAcceptedAssociation(
      initial,
      existing,
      input,
      association,
      undefined,
    );
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
    sourceAssociation: SourceAssociation,
    targetKey?: string,
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
      const interpretations = await interpretRetainedSourceRecords({
        interpreters: this.ports.sourceInterpreters,
        evidence,
        sourceRecords,
        beforeInterpret: async (capability) => {
          interpretationExecution = await this.freezeCapabilityParticipation(
            interpretationExecution,
            [capability],
          );
        },
      });
      const currentInterpretations = interpretations.filter(
        (interpretation) =>
          interpretation.sourceIdentity === sourceAssociation.sourceIdentity &&
          interpretation.sourceAddress === sourceAssociation.nativeAddress,
      );
      if (currentInterpretations.length !== 1)
        throw new Error("已关联来源未形成当前关联的唯一完整元数据解释");
      const [interpretation] = currentInterpretations;
      if (interpretation === undefined)
        throw new Error("唯一来源解释在校验后不可读取");
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
    const failedCoverageReasons = new Map<string, SourceCollectionFailure[]>();
    const recordFailure = (
      coverageIds: readonly string[],
      failure: SourceCollectionFailure,
    ) => {
      for (const coverageId of coverageIds) {
        const reasons = failedCoverageReasons.get(coverageId) ?? [];
        failedCoverageReasons.set(coverageId, [...reasons, failure]);
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
          recordFailure(failureTargets(item, failure, succeeded), failure);
        }
      } catch (error) {
        rethrowWorkflowLifecycle(error);
        if (await stopIfCancelled())
          return await this.inspectPublic(initial.id);
        recordFailure(item.coverageIds, {
          capability: item.collector.capability,
          reason: errorMessage(error),
        });
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
    const failCollectionScope = async (
      coverageId: string,
      failures: readonly SourceCollectionFailure[],
    ) => {
      if (await stopIfCancelled()) return false;
      const scope = scopeForCoverage(coverageId);
      if (scope === undefined || scope.state === "terminal") return true;
      const current = await this.ports.executionQueries.inspectExecution(
        initial.id,
      );
      if (current === undefined) throw new Error("刷新记录在提交后不可读取");
      const idempotencyKey = `source-refresh-failure:${run.id}:${coverageId}:${scope.acquisitionAttempt}`;
      const codes = sourceFailureCodes(failures);
      const committed =
        await this.ports.executionCommands.commitSourceRefreshCollectionFailure(
          {
            expectedExecution: current.execution,
            runId: run.id,
            coverage: scope.coverage,
            acquisitionAttempt: scope.acquisitionAttempt,
            outcome: "failed",
            reason: failures.map((failure) => failure.reason).join("；"),
            ...(codes === undefined ? {} : { sourceFailureCodes: codes }),
            idempotencyKey,
          },
        );
      run = committed.run;
      notifyDurableCheckpoint(input, initial);
      return true;
    };
    for (const [coverageId, failures] of failedCoverageReasons) {
      if (!(await failCollectionScope(coverageId, failures)))
        return await this.inspectPublic(initial.id);
    }

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
        const interpretations = await interpretRetainedSourceRecords({
          interpreters: this.ports.sourceInterpreters,
          evidence,
          sourceRecords,
          beforeInterpret: retainParticipation,
        });
        const currentInterpretations = interpretations.filter(
          (interpretation) =>
            interpretation.sourceIdentity ===
              sourceAssociation.sourceIdentity &&
            interpretation.sourceAddress === sourceAssociation.nativeAddress,
        );
        if (currentInterpretations.length !== 1)
          throw new Error("已关联来源未形成当前关联的唯一完整元数据解释");
        const [interpretation] = currentInterpretations;
        if (interpretation === undefined)
          throw new Error("唯一来源刷新解释在校验后不可读取");
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
    // 与初次刷新一致：补充成功提交后把同一主体的 failed 提升为 completed，让续跑汇总
    // 据已提交结果诚实计数，混合成功／失败时保留成功范围。
    {
      const enrichedSubjectIds = new Set(
        (coordinated.sourceEnrichments ?? [])
          .filter((checkpoint) => checkpoint.stage === "applied")
          .map((checkpoint) => checkpoint.subjectId),
      );
      if (enrichedSubjectIds.size > 0)
        coordinated = {
          ...coordinated,
          targetDispositions: coordinated.targetDispositions!.map((target) => {
            if (
              target.target.kind !== "subject" ||
              target.status !== "failed" ||
              !enrichedSubjectIds.has(target.target.subjectId)
            )
              return target;
            const { reason: _reason, ...promoted } = target;
            return { ...promoted, status: "completed" as const };
          }),
        };
    }
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
  async applyChangeImpactPreview(input: {
    readonly previewId: string;
    readonly confirmedBy: string;
  }): Promise<ChangeImpactPreview> {
    if (input.confirmedBy.trim().length === 0)
      throw new Error("确认者不能为空");
    const preview =
      await this.ports.changeImpactQueries.inspectChangeImpactPreview(
        input.previewId,
      );
    if (preview === undefined) throw new Error("未找到变更影响预演");
    if (preview.status !== "awaiting-confirmation") {
      return preview;
    }
    if (preview.facts === undefined)
      throw new Error("此预演缺少冻结的生效读取结果，请重新形成预演");
    if (preview.blockingConditions.length > 0) {
      throw new Error("存在阻塞条件，不能应用变更影响预演");
    }
    if (preview.version !== "change-impact-preview/2")
      throw new Error("旧版变更影响预演只能审计，不能应用");
    if (preview.change.kind === "source-association") {
      const decisionExecution =
        await this.ports.executionQueries.inspectExecution(preview.executionId);
      if (
        decisionExecution === undefined ||
        !validateSourceAssociationDecisionEnvelope(
          decisionExecution.execution,
        ) ||
        decisionExecution.execution.sourceAssociationDecision?.previewId !==
          preview.id ||
        JSON.stringify(
          decisionExecution.execution.sourceAssociationDecision.proposal,
        ) !== JSON.stringify(preview.change.proposal)
      )
        throw new Error("来源关联决定的持久因果记录无效");
      await this.ports.changeImpactCommands.applySourceAssociationChangePreview(
        {
          preview,
          confirmedBy: input.confirmedBy,
          decision: {
            id: id("source-association-decision"),
            proposalId: preview.change.proposal.id,
            subjectId: preview.assetId,
            decidedBy: { kind: "user", actorId: input.confirmedBy },
          },
        },
      );
      return await this.requireDurableChangeImpactPreview(preview.id);
    }
    if (preview.change.kind === "recognition-retraction") {
      await this.ports.changeImpactCommands.applyRecognitionRetractionPreview({
        preview,
        confirmedBy: input.confirmedBy,
      });
      return await this.requireDurableChangeImpactPreview(preview.id);
    }
    if (preview.change.kind === "recognition-scope-amendment") {
      const change = preview.change;
      const plan: RecognitionScopeAmendmentPlan = {
        successorDecision: {
          id: change.successorDecisionId,
          proposalId: change.proposal.id,
          assetId: preview.assetId,
          boundaries: change.proposal.boundaries,
          acceptedRuleResults: change.proposal.ruleResults,
        },
        supersession: {
          id: id("recognition-decision-supersession"),
          predecessorDecisionId: change.predecessorDecisionId,
          successorDecisionId: change.successorDecisionId,
        },
        scopeAddress: change.scopeAddress,
      };
      await this.ports.changeImpactCommands.applyRecognitionScopeAmendmentPreview(
        { preview, plan },
      );
      return await this.requireDurableChangeImpactPreview(preview.id);
    }
    if (preview.change.kind === "artifact-role-decision") {
      const queries = this.ports.informationSubjectFactsQueries;
      const [subject] =
        queries === undefined
          ? []
          : await queries.readCurrentInformationSubjectFacts({
              subjectIds: [preview.assetId],
            });
      // 确认只按同一规则重算候选指纹；主体事实读不到时交事务置为过期，绝不补齐。
      const currentCandidateBaseline =
        subject === undefined
          ? null
          : JSON.stringify(
              artifactRoleCandidates(
                subject.basis,
                preview.change.decision.target,
                preview.change.decision.role,
              ),
            );
      await this.ports.changeImpactCommands.applyArtifactRoleDecisionPreview({
        preview,
        confirmedBy: input.confirmedBy,
        currentCandidateBaseline,
        policyVersion: this.compatibility().policyVersion,
      });
      return await this.requireDurableChangeImpactPreview(preview.id);
    }
    const proposal = preview.change.proposal;
    if (preview.projected.recognitionDecisionId === undefined)
      throw new Error("身份更正预演缺少后继识别决策");
    const successorDecision: RecognitionDecision = {
      id: preview.projected.recognitionDecisionId,
      proposalId: proposal.id,
      assetId: preview.assetId,
      boundaries: proposal.boundaries,
      acceptedRuleResults: proposal.ruleResults,
    };
    const projectedRecognitionSourceAssociation =
      preview.projected.recognitionSourceAssociation;
    const predecessorDecisionId = preview.baselines.find(
      (baseline) => baseline.key === "recognition-decision",
    )?.value;
    if (predecessorDecisionId === undefined)
      throw new Error("变更影响预演缺少识别决策基线");
    const plan: RecognitionSupersessionPlan = {
      successorDecision,
      supersession: {
        id: id("recognition-decision-supersession"),
        predecessorDecisionId,
        successorDecisionId: successorDecision.id,
      },
      ...(projectedRecognitionSourceAssociation === undefined
        ? {}
        : {
            recognitionSourceAssociation: {
              id: id("source-association"),
              subjectId: preview.assetId,
              sourceIdentity:
                projectedRecognitionSourceAssociation.sourceIdentity,
              nativeAddress:
                projectedRecognitionSourceAssociation.nativeAddress,
            },
          }),
    };
    await this.ports.changeImpactCommands.applyChangeImpactPreview({
      preview,
      plan,
    });
    return await this.requireDurableChangeImpactPreview(preview.id);
  }

  async rejectChangeImpactPreview(input: {
    readonly previewId: string;
    readonly rejectedBy: string;
  }): Promise<ChangeImpactPreviewInspection> {
    if (input.rejectedBy.trim().length === 0) throw new Error("拒绝者不能为空");
    const current =
      await this.ports.changeImpactQueries.inspectChangeImpactPreview(
        input.previewId,
      );
    if (current === undefined) throw new Error("未找到变更影响预演");
    if (current.status !== "awaiting-confirmation")
      return publicChangeImpactPreview(current);
    await this.ports.changeImpactCommands.rejectChangeImpactPreview(input);
    const preview =
      await this.ports.changeImpactQueries.inspectChangeImpactPreview(
        input.previewId,
      );
    if (preview === undefined) throw new Error("未找到变更影响预演");
    return publicChangeImpactPreview(preview);
  }

  private async requireDurableChangeImpactPreview(
    previewId: string,
  ): Promise<ChangeImpactPreview> {
    const durable =
      await this.ports.changeImpactQueries.inspectChangeImpactPreview(
        previewId,
      );
    if (durable === undefined) throw new Error("未找到变更影响预演");
    return durable;
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
    const currentRecognitionAssociation =
      input.current.recognitionSourceAssociation;
    const successorRecognitionDecisionId = id("recognition-decision");
    const currentInterpretation = recognitionSourceInterpretation(
      input.current.proposal,
    );
    const proposedInterpretation = recognitionSourceInterpretation(
      input.proposal,
    );
    const fullBaseline =
      await this.ports.changeImpactCommands.freezeChangeImpactBaseline({
        assetId: input.current.entity.id,
        ...(currentRecognitionAssociation === undefined
          ? {}
          : {
              recognitionSourceAssociationId: currentRecognitionAssociation.id,
            }),
        recognitionDecisionId: input.current.recognitionDecision.id,
      });
    const [afterBaseline] =
      await this.ports.reuseQueries.findAcceptedForSubjects([
        input.current.entity.id,
      ]);
    if (
      afterBaseline === undefined ||
      acceptedConcurrencyFingerprint(afterBaseline.accepted) !==
        acceptedConcurrencyFingerprint(input.current)
    )
      throw new Error("形成身份更正预演期间当前事实或支持已经变化");
    const blockingConditions: string[] = [];
    // 身份更正只结束前序识别提议的解释；独立补充的记录仍通过各自当前来源关联保持适用。
    const currentSourceRecordIds = new Set([
      ...(currentInterpretation?.sourceRecordIds ?? []),
      ...(input.current.metadataSourceRecords ?? [])
        .filter(
          (record) =>
            currentRecognitionAssociation !== undefined &&
            record.sourceIdentity ===
              currentRecognitionAssociation.sourceIdentity &&
            record.nativeAddress ===
              currentRecognitionAssociation.nativeAddress,
        )
        .map(({ id: sourceRecordId }) => sourceRecordId),
    ]);
    const isOwnedByCurrentAssociation = (ids: readonly string[] | undefined) =>
      ids !== undefined &&
      ids.length > 0 &&
      ids.every((sourceRecordId) => currentSourceRecordIds.has(sourceRecordId));
    // 预演可以投影已保留证据，但绝不获取或物化候选产物；履行仍属于后续工作流。
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
    if (input.execution.snapshot === undefined)
      throw new Error("身份更正预演缺少冻结观察快照");
    const projectedRecognition = createAcceptedRecognition({
      proposal: input.proposal,
      snapshot: input.execution.snapshot,
      managedArtifacts: [],
      current: input.current,
      ...(this.ports.observedRootRegistrations.objectIdentityContract ===
      undefined
        ? {}
        : {
            objectIdentityContract:
              this.ports.observedRootRegistrations.objectIdentityContract,
          }),
    });
    const projectedRecognitionFacts =
      proposedInterpretation === undefined
        ? {
            metadata: projectedRecognition.metadata,
            entities: projectedRecognition.entities ?? [],
            entityMentions: projectedRecognition.entityMentions ?? [],
            entityResolutionDecisions:
              projectedRecognition.entityResolutionDecisions ?? [],
            relationships: projectedRecognition.relationships ?? [],
          }
        : projectSourceInterpretationFacts(
            proposedInterpretation,
            input.current.entity.id,
          );
    const projectedArtifactGraph =
      proposedInterpretation === undefined &&
      projectedRecognition.observedEntityGraphs !== undefined
        ? {
            artifacts: projectedRecognition.artifacts,
            locations: projectedRecognition.locations,
            blobs: projectedRecognition.blobs,
            artifactRevisions: projectedRecognition.artifactRevisions,
            artifactAssociations: projectedRecognition.artifactAssociations,
          }
        : projectSupportedArtifactGraph({
            current: input.current,
            endingRecognitionDecisionId: input.current.recognitionDecision.id,
            endingSourceRecordIds: currentSourceRecordIds,
            retainDeliveredMaterials: true,
            ...(currentRecognitionAssociation === undefined
              ? {}
              : {
                  endingSourceAssociationId: currentRecognitionAssociation.id,
                }),
          });
    blockingConditions.push(
      ...otherLegacyArtifactBlockers(
        input.current,
        new Set(
          projectedArtifactGraph.artifactAssociations.map(
            ({ id: associationId }) => associationId,
          ),
        ),
        currentSourceRecordIds,
      ),
    );
    // 图片候选随支持保留，生效角色在共同读取中裁决。
    const preview: ChangeImpactPreview = {
      version: "change-impact-preview/2",
      id: id("change-impact-preview"),
      executionId: execution.id,
      assetId: input.current.entity.id,
      proposal: input.proposal,
      change: {
        kind: "recognition-supersession",
        proposal: input.proposal,
      },
      evidenceComparison: {
        observed:
          input.proposal.basis.kind === "source-interpretation"
            ? []
            : input.proposal.basis.evidence,
        manual:
          input.proposal.basis.kind === "manual-boundary"
            ? input.proposal.basis.evidence
            : [],
        sourceCandidates:
          proposedInterpretation === undefined
            ? []
            : [
                {
                  outcome: "accepted",
                  sourceIdentity: proposedInterpretation.sourceIdentity,
                  nativeAddress: proposedInterpretation.sourceAddress,
                  sourceRecordIds: proposedInterpretation.sourceRecordIds,
                  ruleResults: input.proposal.ruleResults,
                  explanation: "识别提议中的来源解释",
                },
              ],
        conflicts: [],
      },
      baselines: [
        ...(currentRecognitionAssociation === undefined
          ? []
          : [
              {
                key: "source-association",
                value: currentRecognitionAssociation.id,
              },
            ]),
        {
          key: "recognition-decision",
          value: input.current.recognitionDecision.id,
        },
        {
          key: "source-records",
          value: (currentInterpretation?.sourceRecordIds ?? [])
            .toSorted()
            .join(","),
        },
        { key: "complete-current-projection", value: fullBaseline },
      ],
      current: {
        ...assetStateProjection(input.current),
        recognitionState: "recognized",
        recognitionDecisionId: input.current.recognitionDecision.id,
        sourceAssociations: input.current.sourceAssociations.map(
          ({ sourceIdentity, nativeAddress }) => ({
            sourceIdentity,
            nativeAddress,
          }),
        ),
        ...(currentRecognitionAssociation === undefined
          ? {}
          : {
              recognitionSourceAssociation: {
                sourceIdentity: currentRecognitionAssociation.sourceIdentity,
                nativeAddress: currentRecognitionAssociation.nativeAddress,
              },
            }),
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
      },
      projected: {
        readBasis: {
          ...assetStateProjection(input.current).readBasis!,
          sourceAssociations: [
            ...input.current.sourceAssociations,
            ...projectedRecognition.sourceAssociations,
          ],
        },
        recognitionState: "recognized",
        recognitionDecisionId: successorRecognitionDecisionId,
        sourceAssociations:
          proposedInterpretation === undefined
            ? input.current.sourceAssociations
                .filter(
                  (association) =>
                    association.id !== currentRecognitionAssociation?.id,
                )
                .map(({ sourceIdentity, nativeAddress }) => ({
                  sourceIdentity,
                  nativeAddress,
                }))
            : [
                ...input.current.sourceAssociations
                  .filter(
                    (association) =>
                      association.id !== currentRecognitionAssociation?.id,
                  )
                  .map(({ sourceIdentity, nativeAddress }) => ({
                    sourceIdentity,
                    nativeAddress,
                  })),
                {
                  sourceIdentity: proposedInterpretation.sourceIdentity,
                  nativeAddress: proposedInterpretation.sourceAddress,
                },
              ],
        ...(proposedInterpretation === undefined
          ? {}
          : {
              recognitionSourceAssociation: {
                sourceIdentity: proposedInterpretation.sourceIdentity,
                nativeAddress: proposedInterpretation.sourceAddress,
              },
            }),
        metadata: [...retainedMetadata, ...projectedRecognitionFacts.metadata],
        entities: [...retainedEntities, ...projectedRecognitionFacts.entities],
        entityMentions: [
          ...retainedMentions,
          ...projectedRecognitionFacts.entityMentions,
        ],
        entityResolutionDecisions: [
          ...retainedResolutions,
          ...projectedRecognitionFacts.entityResolutionDecisions,
        ],
        relationships: [
          ...retainedRelationships,
          ...projectedRecognitionFacts.relationships,
        ],
        ...projectedArtifactGraph,
      },
      ...(projectedRecognition.observedEntityGraphs === undefined
        ? {}
        : {
            projectedObservedEntityGraphs:
              projectedRecognition.observedEntityGraphs,
          }),
      blockingConditions,
      requestContext: execution.selection.informationRequirement,
      status: "awaiting-confirmation",
    };
    return {
      execution,
      preview: freezeChangeImpactFactReads(
        preview,
        this.ports.metadataPolicyConfiguration,
        input.sourceRecords,
      ),
    };
  }

  /** 继续同一个兼容的非终态执行；这不是重试。 */
  /**
   * 下一次进入的耐久分类：只读取已提交的证据，判定等待、可继续、只耐久收尾或明确中断。
   * 本判定绝不打开 I/O 权威、领取声明或产生效果；当前权威始终由 `resume` 在任何一个效果之前
   * 逐条复核。因此它只决定启动能否立即就绪，既不放宽核心完整性，也不借今天的库配置补旧边界。
   */
  private async classifyRecoveryEntry(execution: WorkflowExecution): Promise<
    | {
        readonly kind: "scan-parent";
        readonly wrapUpOnly: boolean;
      }
    | {
        readonly kind: "library-scoped";
        readonly snapshot: AssetLibrarySnapshot;
      }
    | { readonly kind: "waiting"; readonly projection: "public" | "resumed" }
    | {
        readonly kind: "continuable";
        readonly decoded: AssetRefreshWorkflowInputDecodeResult;
      }
    | {
        readonly kind: "interrupted";
        readonly decoded: AssetRefreshWorkflowInputDecodeResult;
        readonly reason: string;
      }
  > {
    const decode = (): AssetRefreshWorkflowInputDecodeResult =>
      execution.workflowInputInvalid !== undefined
        ? {
            valid: false as const,
            reason: execution.workflowInputInvalid.reason,
          }
        : execution.workflowInput === undefined
          ? {
              valid: false as const,
              reason: "刷新记录缺少版本化输入，无法安全继续；请重新开始刷新",
            }
          : decodeAssetRefreshWorkflowInput(execution.workflowInput);
    if (execution.operationKind === "scan-asset-library") {
      const decoded = decode();
      if (!decoded.valid)
        return { kind: "interrupted", decoded, reason: decoded.reason };
      const plan = decoded.input.libraryScan;
      const snapshot = decoded.input.assetLibrary;
      if (plan === undefined || snapshot === undefined)
        return {
          kind: "interrupted",
          decoded,
          reason: "库扫描记录缺少冻结的目录计划，无法安全继续；请重新开始刷新",
        };
      const ledger = await this.ports.executionQueries.inspectLibraryScan(
        execution.id,
      );
      if (ledger === undefined)
        return {
          kind: "interrupted",
          decoded,
          reason: "库扫描的目录账本无法读取，无法安全继续；请重新开始刷新",
        };
      // 全部目录都已结算时，父只剩汇总与登记，不会再产生任何观察效果。
      return {
        kind: "scan-parent",
        wrapUpOnly: ledger.directories.every(
          (entry) => entry.stage === "settled" || entry.stage === "cancelled",
        ),
      };
    }
    const librarySnapshot = execution.workflowInput?.assetLibrary;
    if (
      librarySnapshot !== undefined &&
      this.ports.assetLibrarySnapshot === undefined
    ) {
      const decoded = decodeAssetLibrarySnapshot(librarySnapshot);
      if (decoded !== undefined)
        return { kind: "library-scoped", snapshot: decoded };
    }
    const confirmationPreview =
      await this.ports.changeImpactQueries.inspectChangeImpactPreviewForExecution(
        execution.id,
      );
    if (
      confirmationPreview?.version === "change-impact-preview/2" &&
      confirmationPreview.status === "awaiting-confirmation"
    )
      return { kind: "waiting", projection: "resumed" };
    if (
      execution.workflowInput?.version ===
        "source-association-decision-input/1" &&
      execution.sourceAssociationDecision?.state === "awaiting-selection"
    )
      return { kind: "waiting", projection: "public" };
    const decoded = decode();
    const durableRetryIntent = decoded.valid
      ? decoded.input.sourceEnrichmentRetry
      : undefined;
    // 首来源检查点之前中断的新重试：能力坐标尚未冻结，续跑安全依据是耐久精确意图与创建时
    // 重取的活动库配置，而非任何冻结参与集；因此这条路径跳过面向冻结范围的恢复兼容校验。
    const durableRetryBeforeFirstCheckpoint =
      durableRetryIntent !== undefined &&
      execution.workItems === undefined &&
      execution.acceptedAssetId !== undefined &&
      (execution.sourceEnrichments?.length ?? 0) === 0;
    let interruptionReason = decoded.valid
      ? this.legacyFilesystemScopeRecoveryReason(execution)
      : decoded.reason;
    // 配置版本变化不终结已创建的执行：它沿自己的冻结计划继续（ADR-0068），新的耐久创建
    // 才由持久化在同一事务内验证当前配置。
    if (
      execution.dispositions.some(
        (disposition) => disposition.key === "manual-boundary",
      )
    )
      interruptionReason = "人工确认尚未提交，请回到待添加内容重新确认";
    if (
      interruptionReason === undefined &&
      execution.workItems === undefined &&
      !(
        (execution.stage === "recognition" &&
          execution.snapshot?.complete === true) ||
        // 其 workflowInput 已耐久版本化保存可严格解码的精确意图（主体／来源／精确地址／
        // 必要非秘密规范输入），本身就是可安全续跑的持久依据。
        durableRetryBeforeFirstCheckpoint
      ) &&
      execution.stage !== "source-records-retained" &&
      execution.stage !== "source-artifacts-acquired" &&
      execution.stage !== "source-artifacts-stored" &&
      execution.stage !== "cover-acquired" &&
      execution.stage !== "cover-stored"
    )
      interruptionReason = "刷新记录尚未到达可继续的持久检查点";
    if (
      interruptionReason === undefined &&
      decoded.valid &&
      !durableRetryBeforeFirstCheckpoint
    ) {
      try {
        await this.assertResumeCompatibility(
          execution.compatibility,
          decoded.input.configurationReferences,
          decoded.input.observedRoots ?? [],
          ...(decoded.input.assetLibrary === undefined
            ? []
            : [
                {
                  assetLibraryId: decoded.input.assetLibrary.id,
                  ...(decoded.input.directoryAuthorizations === undefined
                    ? {}
                    : {
                        directoryAuthorizations:
                          decoded.input.directoryAuthorizations,
                      }),
                },
              ]),
        );
      } catch (error) {
        interruptionReason = errorMessage(error);
      }
    }
    if (interruptionReason !== undefined)
      return { kind: "interrupted", decoded, reason: interruptionReason };
    return { kind: "continuable", decoded };
  }

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
    const classification = await this.classifyRecoveryEntry(
      inspection.execution,
    );
    // 库扫描父有专属续跑：读取耐久计划、冻结权威与目录账本继续同一父，绝不落入按今日
    // 配置判定的通用逐库恢复，也不从今日 scanCandidates 重建。那份续跑在任何目录写入之前
    // 先领取与其他恢复一致的耐久单持有者权利，竞争的一路因此零账本写入。
    if (classification.kind === "scan-parent")
      return await this.resumeAssetLibraryScan(inspection.execution, input);
    if (classification.kind === "library-scoped")
      return await this.workflowForLibrary(classification.snapshot).resume(
        input,
      );
    if (classification.kind === "waiting")
      // 等待态不持有外部资源；重新打开只保留耐久用户决定或耐久等待，不重放也不终结它。
      return classification.projection === "public"
        ? await this.inspectPublic(inspection.execution.id)
        : await this.inspectResumedPublic(inspection.execution.id);
    const decodedInput = classification.decoded;
    const durableRetryIntent = decodedInput.valid
      ? decodedInput.input.sourceEnrichmentRetry
      : undefined;
    const hasExplicitWorkItems = inspection.execution.workItems !== undefined;
    // 缺边界、缺冻结配置、不兼容能力或缺耐久检查点都在同一份判定里给出明确中断原因；耐久
    // 终结在领取声明之后进行，已提交结果与原始载荷一律保留。
    let interruptionReason: string | undefined =
      classification.kind === "interrupted" ? classification.reason : undefined;
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
    const leaseExpiry = () =>
      new Date(
        this.resumeClock.now().getTime() + resumeLeaseMilliseconds,
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
          current.getTime() + resumeLeaseMilliseconds,
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
    }, resumeLeaseMilliseconds / 3);
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
        if (
          !hasExplicitWorkItems &&
          decodedInput.valid &&
          decodedInput.input.operation === undefined &&
          inspection.execution.acceptedAssetId === undefined &&
          (inspection.execution.stage === "recognition" ||
            inspection.execution.stage === "source-records-retained") &&
          (inspection.execution.stage !== "source-records-retained" ||
            !inspection.execution.dispositions.some(
              (item) => item.key === "official-collection",
            ))
        ) {
          return await this.interruptRecovery(
            inspection.execution,
            "官方来源完整采集批次尚未提交，当前执行不能安全继续",
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
        const retryIntent = durableRetryIntent;
        if (
          !hasExplicitWorkItems &&
          retryIntent !== undefined &&
          inspection.execution.acceptedAssetId !== undefined &&
          (inspection.execution.sourceEnrichments?.length ?? 0) === 0
        ) {
          // 首来源检查点之前中断的新重试：沿同新 ID 与同精确操作续跑，绝不退回普通自动补充，
          // 也不重开旧失败执行或以当前候选替换显式输入。
          return await this.resumeSourceEnrichmentRetry(
            inspection.execution,
            retryIntent,
            input,
            mutationClaim,
          );
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
              ...(item.boundaries === undefined
                ? {}
                : { boundaries: item.boundaries }),
              ...(item.boundaryBaseline === undefined
                ? {}
                : { boundaryBaseline: item.boundaryBaseline }),
              ...(item.retainedAssetId === undefined
                ? {}
                : { retainedAssetId: item.retainedAssetId }),
              ...(item.retainedDecisionId === undefined
                ? {}
                : { retainedDecisionId: item.retainedDecisionId }),
              ...(item.reuseAcceptedBoundary === undefined
                ? {}
                : { reuseAcceptedBoundary: item.reuseAcceptedBoundary }),
              ...(item.boundaryConflict === undefined
                ? {}
                : { boundaryConflict: item.boundaryConflict }),
              ...(item.materialBoundary === undefined
                ? {}
                : { materialBoundary: item.materialBoundary }),
              ...(item.observedArtifactAssociations === undefined
                ? {}
                : {
                    observedArtifactAssociations:
                      item.observedArtifactAssociations,
                  }),
              ...(item.observedArtifactBoundary === undefined
                ? {}
                : { observedArtifactBoundary: item.observedArtifactBoundary }),
              ...(item.observedArtifactBoundaryProducer === undefined
                ? {}
                : {
                    observedArtifactBoundaryProducer:
                      item.observedArtifactBoundaryProducer,
                  }),
              ...(item.independentIdentityDeclaredBy === undefined
                ? {}
                : {
                    independentIdentityDeclaredBy:
                      item.independentIdentityDeclaredBy,
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
        const batches = await interpretRetainedSourceRecords({
          interpreters: this.ports.sourceInterpreters,
          evidence,
          sourceRecords: inspection.sourceRecords,
          beforeInterpret: async (capability) => {
            await retainResumedCapabilities([capability]);
          },
        });
        const proposals: RecognitionProposal[] = [];
        const candidateContexts = recognitionCandidateContexts({
          evidence,
          interpretations: batches,
        });
        for (const recognizer of this.ports.recognizers) {
          for (const candidateContext of candidateContexts) {
            const recognizerInput = frozenRecognitionInput(candidateContext);
            if (!recognizer.canRecognize(recognizerInput)) continue;
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
          if (
            resumedExecution.plannedAssetId !== undefined &&
            resumedExecution.plannedAssetId.trim().length === 0
          )
            throw new Error("恢复中的预分配识别主体身份无效");
          const acceptedAsset: DigitalAsset = {
            id:
              resumedExecution.plannedAssetId ??
              inferCheckpointedAcceptedAssetId(rawSelected, [
                ...legacyAcquisitions,
                ...legacyManagedArtifacts,
              ]) ??
              id("entity"),
            kind: "digital-asset",
          };
          if (resumedExecution.plannedAssetId === undefined) {
            const plannedExecution: WorkflowExecution = {
              ...resumedExecution,
              plannedAssetId: acceptedAsset.id,
            };
            await this.transition(
              resumedExecution,
              plannedExecution,
              mutationClaim(),
            );
            resumedExecution = plannedExecution;
          }
          const selected = rawSelected.map((candidate) =>
            resolveSourceArtifactSubject(candidate, acceptedAsset.id),
          );
          input.onProgress?.(
            selected.length === 0
              ? "当前信息需求不需要获取来源产物"
              : "正在获取所需来源产物",
          );
          let checkpointExecution = resumedExecution;
          const managedArtifacts: ManagedSourceArtifactCheckpoint[] = [];
          const acquisitions = legacyAcquisitions.filter((acquisition) =>
            selected.some(
              (candidate) =>
                sourceArtifactCheckpointMatchesCandidate(
                  acquisition,
                  candidate,
                ) &&
                (resumedExecution.stage === "source-artifacts-acquired" ||
                  resumedExecution.stage === "cover-acquired" ||
                  legacyManagedArtifacts.some((managed) =>
                    managedSourceArtifactMatchesCandidate(managed, candidate),
                  )),
            ),
          );
          for (const [selectionIndex, candidate] of selected.entries()) {
            const acquireDispositionKey = sourceArtifactDispositionKey(
              "acquire",
              selected,
              selectionIndex,
            );
            const storeDispositionKey = sourceArtifactDispositionKey(
              "store",
              selected,
              selectionIndex,
            );
            const alreadyManaged = legacyManagedArtifacts.find((managed) =>
              managedSourceArtifactMatchesCandidate(managed, candidate),
            );
            if (alreadyManaged !== undefined) {
              managedArtifacts.push(alreadyManaged);
              continue;
            }
            let acquisition = acquisitions.find((item) =>
              sourceArtifactCheckpointMatchesCandidate(item, candidate),
            );
            let staged:
              | Awaited<
                  ReturnType<CheckpointedSourceArtifactWork["acquireAndStage"]>
                >["staged"]
              | undefined;
            if (acquisition === undefined) {
              await renew();
              const acquired = await runSourceArtifactAcquisitionEffect({
                necessity:
                  requirement.artifactRoles.find(
                    (requested) => requested.role === candidate.role,
                  )?.necessity ?? "required",
                acquire: async () =>
                  await this.sourceArtifactWork.acquireAndStage({
                    candidate,
                    proposal,
                    sourceRecords: inspection.sourceRecords,
                    idempotencyKey: sourceArtifactIdempotencyKey(
                      checkpointExecution.id,
                      candidate,
                    ),
                    requireCheckpointStore: true,
                    ...(resumedScope === undefined
                      ? {}
                      : {
                          assertEffectLive: () =>
                            this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                              resumedScope!,
                            ),
                        }),
                    beforeAcquire: async (capability) => {
                      await retainResumedCapabilities([capability]);
                      checkpointExecution = resumedExecution;
                    },
                  }),
              });
              if (acquired.status === "optional-failed") {
                const skipped: WorkflowExecution = {
                  ...checkpointExecution,
                  sourceArtifactAcquisitions: acquisitions,
                  managedSourceArtifacts: managedArtifacts,
                  dispositions: [
                    ...checkpointExecution.dispositions.filter(
                      (item) => item.key !== acquireDispositionKey,
                    ),
                    {
                      key: acquireDispositionKey,
                      status: "failed",
                      reason: "可选来源产物获取失败；识别仍可继续",
                    },
                  ],
                };
                await this.transition(
                  checkpointExecution,
                  skipped,
                  mutationClaim(),
                );
                checkpointExecution = skipped;
                resumedExecution = skipped;
                notifyDurableCheckpoint(input, skipped, false);
                continue;
              }
              acquisition = acquired.value.checkpoint;
              staged = acquired.value.staged;
              acquisitions.push(acquisition);
              const acquiredExecution: WorkflowExecution = {
                ...checkpointExecution,
                proposalId: proposal.id,
                stage: "source-artifacts-acquired",
                sourceArtifactAcquisitions: acquisitions,
                dispositions: [
                  ...checkpointExecution.dispositions.filter(
                    (item) =>
                      item.key !== acquireDispositionKey &&
                      item.key !== storeDispositionKey,
                  ),
                  {
                    key: acquireDispositionKey,
                    status: "completed",
                    effectReference: acquisition.stagedReference,
                  },
                  {
                    key: storeDispositionKey,
                    status: "running",
                  },
                ],
              };
              await this.transition(
                checkpointExecution,
                acquiredExecution,
                mutationClaim(),
              );
              checkpointExecution = acquiredExecution;
              resumedExecution = acquiredExecution;
              notifyDurableCheckpoint(input, acquiredExecution, false);
            }
            await renew();
            // 恢复路径的托管 store 是阶段转换前的耐久最终效果：撤销落在已发获取期间时，
            // 不得把已获取来源写入托管位置，故在真正 store 之前用重绑的 resumedScope 复核。
            if (resumedScope !== undefined)
              this.ports.observedRootRegistrations.assertDirectoryOperationLive(
                resumedScope,
              );
            const managed = await this.sourceArtifactWork.store({
              acquisition,
              ...(staged === undefined ? {} : { staged }),
              requireCheckpointStore: true,
            });
            managedArtifacts.push(managed);
            const storedExecution: WorkflowExecution = {
              ...checkpointExecution,
              proposalId: proposal.id,
              stage: "source-artifacts-stored",
              sourceArtifactAcquisitions: acquisitions,
              managedSourceArtifacts: managedArtifacts,
              dispositions: checkpointExecution.dispositions.map((item) =>
                completeManagedStoreDisposition(
                  item,
                  storeDispositionKey,
                  managed,
                ),
              ),
            };
            await this.transition(
              checkpointExecution,
              storedExecution,
              mutationClaim(),
            );
            checkpointExecution = storedExecution;
            resumedExecution = storedExecution;
            notifyDurableCheckpoint(input, storedExecution, false);
          }
          if (
            (checkpointExecution.stage !== "source-artifacts-stored" &&
              checkpointExecution.stage !== "cover-stored") ||
            (checkpointExecution.managedSourceArtifacts?.length ?? 0) !==
              managedArtifacts.length ||
            !(checkpointExecution.managedSourceArtifacts ?? []).every(
              (managed) =>
                managedArtifacts.some(
                  (expected) =>
                    expected.candidateId === managed.candidateId &&
                    expected.sourceRecordId === managed.sourceRecordId &&
                    expected.role === managed.role,
                ),
            )
          ) {
            const storedExecution: WorkflowExecution = {
              ...checkpointExecution,
              proposalId: proposal.id,
              stage: "source-artifacts-stored",
              sourceArtifactAcquisitions: acquisitions,
              managedSourceArtifacts: managedArtifacts,
            };
            await this.transition(
              checkpointExecution,
              storedExecution,
              mutationClaim(),
            );
            checkpointExecution = storedExecution;
            notifyDurableCheckpoint(input, storedExecution, false);
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
          const resumeSnapshot =
            requiredFilesystemSnapshot(checkpointExecution);
          const resumeWorkItem = (checkpointExecution.workItems ?? []).find(
            (candidate) => candidate.proposalId === proposal.id,
          );
          await this.ports.recognitionAcceptance.acceptRecognition({
            expectedExecution: lastPersistedExecution,
            execution: finished,
            accepted,
            observedMaterialAcceptances: observedMaterialAcceptanceBindings({
              accepted,
              snapshot: resumeSnapshot,
              workItemKey: resumeWorkItem?.key ?? "",
              acceptanceKind: "a-work-item",
              relativePaths:
                resumeWorkItem?.relativePaths ??
                (proposal.observedArtifactAssociations ?? []).map(
                  (reference) => reference.observedArtifactReference,
                ),
              ...(resumeWorkItem?.observedArtifactBoundary === undefined
                ? {}
                : {
                    observedArtifactBoundary:
                      resumeWorkItem.observedArtifactBoundary,
                  }),
            }),
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

  private async recoverObservedMaterialAssociation(
    original: WorkflowExecution,
    onHostCheckpoint?: () => void,
  ): Promise<AssetRefreshInspection | undefined> {
    const checkpoint = original.materialAssociation;
    if (checkpoint === undefined) return undefined;
    if (checkpoint.state === "awaiting-confirmation") return undefined;
    const token = randomUUID();
    const now = this.resumeClock.now().toISOString();
    const claim = { token, now };
    const disposition = await this.ports.recoveryLease.claimResumeExecution({
      executionId: original.id,
      token,
      now,
      expiresAt: new Date(
        this.resumeClock.now().getTime() + resumeLeaseMilliseconds,
      ).toISOString(),
    });
    if (disposition === "busy") throw new ResumeExecutionBusyError();
    if (disposition === "terminal") return undefined;
    try {
      if (
        (checkpoint.state === "confirmation-recorded" ||
          checkpoint.state === "revalidating") &&
        checkpoint.confirmedBy !== undefined
      ) {
        await this.confirmObservedMaterialAssociationWithClaim(
          {
            executionId: original.id,
            confirmedBy: checkpoint.confirmedBy,
            onHostCheckpoint: () => onHostCheckpoint?.(),
          },
          claim,
        );
        return await this.inspectResumedPublic(original.id);
      }
      if (
        checkpoint.state !== "created" &&
        checkpoint.state !== "observing" &&
        checkpoint.state !== "inspecting"
      )
        return undefined;
      const target = (
        await this.ports.reuseQueries.findAcceptedForSubjects([
          checkpoint.input.targetAssetId,
        ])
      )[0];
      if (target === undefined)
        return await this.interruptRecovery(
          original,
          "目标内容不再可用，无法继续材料准备",
          () => claim,
        );
      let execution = original;
      await this.observedRootExecution.invoke(
        {
          registrationId: checkpoint.input.registrationId,
          relativeScope: checkpoint.input.relativeScope,
          subjects: [
            {
              subjectId: checkpoint.input.targetAssetId,
              explanations: [
                {
                  path: [
                    "observed-material-association",
                    checkpoint.input.targetAssetId,
                  ],
                },
              ],
            },
          ],
        },
        async (bound) => {
          const registration = await this.ports.observedRootRegistrations.get(
            checkpoint.input.registrationId,
          );
          if (
            registration === undefined ||
            registration.status !== "active" ||
            (checkpoint.input.registrationVersion !== undefined &&
              checkpoint.input.registrationVersion !==
                registration.configVersion)
          )
            throw new Error("文件位置已变化，无法继续材料准备");
          const observing: WorkflowExecution = {
            ...execution,
            requestedSelection: bound.requestedSelection,
            resolvedSelection: bound.resolvedSelection,
            materialAssociation: {
              ...checkpoint,
              state: "observing",
              registrationDisplayName: registration.displayName,
              input: {
                ...checkpoint.input,
                registrationVersion: registration.configVersion,
              },
            },
          };
          await this.transition(execution, observing, claim);
          execution = observing;
          onHostCheckpoint?.();
          const snapshot =
            await this.ports.observedRootRegistrations.observeBoundScope(
              bound.scope,
            );
          if (!snapshot.complete)
            throw new Error("文件位置观察不完整，无法继续材料准备");
          const selectedSnapshot: FilesystemPackageSnapshot = {
            ...snapshot,
            files: checkpoint.input.relativePaths.map((relativePath) => {
              const file = snapshot.files.find(
                (candidate) => candidate.relativePath === relativePath,
              );
              if (file === undefined)
                throw new Error(`所选完整文件不可用：${relativePath}`);
              return file;
            }),
          };
          const inspecting: WorkflowExecution = {
            ...execution,
            snapshot: selectedSnapshot,
            filesystemSnapshots: [selectedSnapshot],
            materialAssociation: {
              ...execution.materialAssociation!,
              state: "inspecting",
              snapshot: selectedSnapshot,
            },
          };
          await this.transition(execution, inspecting, claim);
          execution = inspecting;
          const observed = await this.inspectWholeObservedMaterials(
            bound.scope,
            selectedSnapshot,
            () => onHostCheckpoint?.(),
          );
          const proposal: RecognitionProposal = {
            id: id("recognition-proposal"),
            boundaries: bindRecognitionMaterialBoundaries({
              snapshot: selectedSnapshot,
              boundRoot: bound.scope.root,
              relativePaths: checkpoint.input.relativePaths,
            }),
            basis: {
              kind: "manual-boundary",
              proposedBy: checkpoint.input.initiatedBy,
              observationSnapshotId: selectedSnapshot.id,
              materialReferences: checkpoint.input.relativePaths,
              revisesProposalIds: [],
              metadata: [],
              evidence: observed.evidence,
            },
            ruleResults: [],
            observedArtifactAssociations: checkpoint.input.relativePaths.map(
              (observedArtifactReference) => ({
                observedArtifactReference,
                role: "asset.material-delivered" as const,
              }),
            ),
            observedArtifactRevisions: observed.revisions,
          };
          const accepted = createAcceptedRecognition({
            proposal,
            snapshot: selectedSnapshot,
            managedArtifacts: [],
            asset: target.accepted.entity,
            ...(this.ports.observedRootRegistrations.objectIdentityContract ===
            undefined
              ? {}
              : {
                  objectIdentityContract:
                    this.ports.observedRootRegistrations.objectIdentityContract,
                }),
          });
          const submission: ObservedMaterialAssociationSubmission = {
            proposal,
            recognitionDecision: accepted.recognitionDecision,
            artifacts: accepted.artifacts,
            locations: accepted.locations,
            blobs: uniqueObservedMaterialBlobs(accepted.blobs),
            artifactRevisions: accepted.artifactRevisions,
            artifactAssociations: accepted.artifactAssociations,
            projections: observedMaterialAssociationProjections(
              proposal,
              selectedSnapshot,
              accepted,
            ),
            supports: accepted.artifactAssociations
              .filter(({ target }) => target.kind === "entity")
              .map((association) => ({
                associationId: association.id,
                recognitionDecisionId: accepted.recognitionDecision.id,
              })),
          };
          validateObservedMaterialAssociationSubmission(submission);
          const waiting: WorkflowExecution = {
            ...execution,
            materialAssociation: {
              ...execution.materialAssociation!,
              state: "awaiting-confirmation",
              submission,
            },
          };
          await this.transition(execution, waiting, claim);
          execution = waiting;
          onHostCheckpoint?.();
        },
      );
      return await this.inspectResumedPublic(original.id);
    } catch (error) {
      if (error instanceof WorkflowCheckpointInterruption) throw error.cause;
      const current = await this.ports.executionQueries.inspectExecution(
        original.id,
      );
      if (current?.execution.status !== "running")
        return await this.inspectResumedPublic(original.id);
      return await this.interruptRecovery(
        current.execution,
        errorMessage(error),
        () => claim,
      );
    } finally {
      await this.ports.recoveryLease.releaseResumeExecutionClaim({
        executionId: original.id,
        token,
      });
    }
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
      if (
        lifecycle?.executionIds !== undefined &&
        !lifecycle.executionIds.has(execution.id)
      )
        continue;
      lifecycle?.onCheckpoint?.();
      const inspection = await this.continueDiscoveredExecution(
        execution,
        lifecycle,
      );
      if (inspection !== undefined) recovered.push(inspection);
    }
    return recovered;
  }

  /**
   * 启动的第一遍：逐条按下一转换所需的原证据判定等待、可继续、只耐久收尾或明确中断，并给出
   * 简体中文原因与下一步动作。这一步不领取声明、不打开权威也不产生效果，因此宿主可以在它完成
   * 后立即就绪，让被接纳的执行沿原 ID 在自己的监督下继续。
   *
   * 恢复只对崩溃遗留的工作说话。`within` 给出既有的启动恢复集合时，本进程之后正常调用新建的
   * 活跃执行一律不在范围内；仍挂在未终结扫描父账本下的派生子也一律不由这里接管——父的续跑链
   * 会按耐久子 ID 自己继续或如实中断它们，第二个 owner 只会与父抢同一份终结基线。
   */
  async classifyRunningExecutions(
    exclude?: ReadonlySet<string>,
    within?: ReadonlySet<string>,
  ): Promise<readonly RecoveryClassification[]> {
    const running = await this.ports.executionQueries.listRunningExecutions();
    const items: RecoveryClassification[] = [];
    const supervisedParents = new Set(
      running
        .filter((execution) => execution.operationKind === "scan-asset-library")
        .map((execution) => execution.id),
    );
    for (const execution of running) {
      if (exclude?.has(execution.id) === true) continue;
      if (within !== undefined && !within.has(execution.id)) continue;
      const supervisedBy = execution.workflowInput?.parentExecutionId;
      if (supervisedBy !== undefined && supervisedParents.has(supervisedBy))
        continue;
      const subject = await this.recoverySubjectLabel(execution);
      if (execution.materialAssociation !== undefined) {
        items.push(
          execution.materialAssociation.state === "awaiting-confirmation"
            ? {
                executionId: execution.id,
                category: "waiting",
                subject,
                nextAction: "请回到这条记录完成确认，它会原样继续",
              }
            : {
                executionId: execution.id,
                category: "continuable",
                subject,
                nextAction: "无需操作，这次启动会继续这条记录",
              },
        );
        continue;
      }
      const classification = await this.classifyRecoveryEntry(execution);
      if (classification.kind === "waiting") {
        items.push({
          executionId: execution.id,
          category: "waiting",
          subject,
          nextAction: "请回到这条记录完成确认，它会原样继续",
        });
        continue;
      }
      if (classification.kind === "interrupted") {
        items.push({
          executionId: execution.id,
          category: "interrupted",
          subject,
          reason: classification.reason,
          nextAction: "请重新发起一次刷新",
        });
        continue;
      }
      items.push({
        executionId: execution.id,
        category:
          classification.kind === "scan-parent" && classification.wrapUpOnly
            ? "wrap-up"
            : "continuable",
        subject,
        nextAction:
          classification.kind === "scan-parent" && classification.wrapUpOnly
            ? "无需操作，正在补齐这次扫描的汇总登记"
            : "无需操作，这次启动会继续这条记录",
      });
    }
    return items;
  }

  /**
   * 沿原 ID 继续一个已分类的执行；终态或等待中的执行没有新的耐久结果，返回 undefined。
   */
  async continueRunningExecution(
    executionId: string,
    lifecycle?: RecoveryLifecycle,
  ): Promise<AssetRefreshInspection | undefined> {
    const current =
      await this.ports.executionQueries.inspectExecution(executionId);
    if (current === undefined || current.execution.status !== "running")
      return undefined;
    return await this.continueDiscoveredExecution(current.execution, lifecycle);
  }

  /**
   * 单个非终态执行的一次进入：观察材料走它自己的耐久收尾，其余沿版本化输入续跑。等待中的执行
   * 只登记等待，明确中断的执行在同一次进入里耐久终结并保留已提交结果。
   */
  private async continueDiscoveredExecution(
    execution: WorkflowExecution,
    lifecycle?: RecoveryLifecycle,
  ): Promise<AssetRefreshInspection | undefined> {
    const material = execution.materialAssociation;
    if (material?.state === "awaiting-confirmation") {
      lifecycle?.onWaitingExecution?.(execution.id);
      return undefined;
    }
    if (material !== undefined)
      return await this.recoverObservedMaterialAssociation(
        execution,
        lifecycle?.onCheckpoint,
      );
    try {
      return await this.resume({
        executionId: execution.id,
        onHostCheckpoint: lifecycle?.onCheckpoint,
      });
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
        return undefined;
      }
      // 竞争持有者也可能在启动扫描与声明尝试之间将其终态化。`resume()` 为明确调用方
      // 保留公开错误，但启动恢复把现在已终态的行视为已经协调，而不是让整个宿主失败。
      const current = await this.ports.executionQueries.inspectExecution(
        execution.id,
      );
      if (current?.execution.status !== "running") return undefined;
      throw error;
    }
  }

  /** 面向使用者的定位文本：库名与触发方式，绝不携带坐标、路径或标识符。 */
  private async recoverySubjectLabel(
    execution: WorkflowExecution,
  ): Promise<string> {
    // 触发方式以版本化输入里耐久保存的那份为准：旧的 trigger_kind 列对自动化行为空，
    // 借它分类会把周期计划报成「手动刷新」。
    const trigger = execution.workflowInput?.trigger ?? execution.trigger;
    const kind = isAutomationTrigger(trigger) ? "自动刷新" : "手动刷新";
    const libraryId = execution.workflowInput?.assetLibrary?.id;
    if (libraryId === undefined) return `资产库的${kind}`;
    const displayName = await this.ports.assetLibraries
      ?.get(libraryId)
      .then((library) => library?.displayName)
      .catch(() => undefined);
    return displayName === undefined
      ? `资产库的${kind}`
      : `${displayName}的${kind}`;
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
          // 范围内的诊断同样参与复用判断；没有诊断的旧记录保持原指纹。
          ...(snapshot.diagnostics === undefined
            ? {}
            : { diagnostics: snapshot.diagnostics }),
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
          // 范围内的诊断同样参与复用判断；没有诊断的旧记录保持原指纹。
          ...(snapshot.diagnostics === undefined
            ? {}
            : { diagnostics: snapshot.diagnostics }),
          key: plan.key,
          relativePaths: plan.relativePaths,
          boundaries: plan.boundaries,
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
    // 恢复沿执行自己冻结的库目录授权重建权威，绝不采用当前配置为新代次续权。
    const libraryId = execution.workflowInput?.assetLibrary?.id;
    const authorityVersion =
      execution.workflowInput?.directoryAuthorizations?.find(
        (authorization) =>
          authorization.observedRootId === scope.observedRoot.id,
      )?.authorityVersion;
    try {
      return await this.ports.observedRootRegistrations.rebindFrozenScope({
        root: scope.observedRoot,
        relativeScope: scope.relativeScope,
        ...(libraryId === undefined ? {} : { assetLibraryId: libraryId }),
        ...(authorityVersion === undefined
          ? {}
          : { directoryAuthorityVersion: authorityVersion }),
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
    context?: {
      readonly assetLibraryId: string;
      readonly directoryAuthorizations?: readonly FrozenDirectoryAuthorization[];
    },
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
        context,
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
    const sourceArtifactCandidates = await this.publicSourceArtifactCandidates(
      inspection.accepted,
    );
    return {
      ...publicInspection(
        inspection,
        this.ports.metadataPolicyConfiguration,
        sourceArtifactCandidates,
      ),
      ...(preview === undefined
        ? {}
        : { changeImpactPreview: publicChangeImpactPreview(preview) }),
    };
  }

  private async publicSourceArtifactCandidates(
    accepted: AcceptedAssetState | undefined,
  ): Promise<readonly PublicSourceArtifactCandidate[]> {
    const queries = this.ports.currentSourceArtifactQueries;
    if (accepted === undefined || queries === undefined) return [];
    const associations = accepted.sourceAssociations;
    const facts = await Promise.all(
      associations.map((association) =>
        queries.readCurrentSourceArtifactFacts({
          subjectId: accepted.entity.id,
          sourceIdentity: association.sourceIdentity,
          sourceAssociationId: association.id,
        }),
      ),
    );
    return facts.flatMap((current) =>
      current === undefined
        ? []
        : current.candidates.map(({ candidate }) => ({
            sourceRecordId: candidate.sourceRecordId,
            role: candidate.role,
            mediaType: candidate.mediaType,
            ...(candidate.selectionEvidence === undefined
              ? {}
              : {
                  selectionEvidence: {
                    ...(candidate.selectionEvidence.suggestedFilename ===
                    undefined
                      ? {}
                      : {
                          suggestedFilename:
                            candidate.selectionEvidence.suggestedFilename,
                        }),
                    ...(candidate.selectionEvidence.declaredByteLength ===
                    undefined
                      ? {}
                      : {
                          declaredByteLength:
                            candidate.selectionEvidence.declaredByteLength,
                        }),
                    ...(candidate.selectionEvidence.sourceOrdinal === undefined
                      ? {}
                      : {
                          sourceOrdinal:
                            candidate.selectionEvidence.sourceOrdinal,
                        }),
                  },
                }),
          })),
    );
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
        ![
          ...(accepted.relationships ?? []),
          ...(accepted.observedEntityGraphs ?? []).flatMap(
            (graph) => graph.relationships,
          ),
        ].some((relationship) => relationship.type === requested.type)
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
  | "inspectAssetLibraryScan"
  | "scanAssetLibrary"
  | "inspect"
  | "recoverRunningExecutions"
  | "fulfillPreparedInformation"
  | "acceptedSubjectsOfLibraryScan"
  | "workflowForLibrary"
>;

/** 自动化收尾使用的账本窄端口：读耐久处置、绑定 child、收口历史父。 */
type LibraryScanFulfillmentLedger = LibraryScanFulfillmentCommands &
  LibraryScanFulfillmentQueries;

type AssetRefreshAutomationPorts = {
  readonly assetLibraries?: AssetLibraries;
  readonly executionQueries: WorkflowExecutionQueries;
  readonly automationQueries: AutomationQueries;
  readonly automationCommands: AutomationCommands;
  /**
   * 信息履行账本。终态父的内容整理只从这份耐久载体继续；没有它时自动化绝不按今日事实补齐。
   */
  readonly libraryScanFulfillment?: LibraryScanFulfillmentLedger;
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
    readonly assetLibraryId: string;
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
    const libraries = this.ports.assetLibraries;
    if (libraries === undefined) throw new Error("当前部署没有资产库配置");
    if (
      !Number.isSafeInteger(input.intervalMilliseconds) ||
      input.intervalMilliseconds <= 0
    )
      throw new Error("自动刷新间隔必须为正数");
    // 归属先于授权：一次冻结读取同时给出该库目录清单与其权威闭包，全局根仍 active
    // 不足以让本库对该目录做周期观察。
    const frozen = await libraries.freezeLibraryScan(input.assetLibraryId);
    const candidate = frozen.candidates.find(
      (entry) => entry.id === input.observedRootId,
    );
    if (candidate === undefined)
      throw new ObservedRootUnavailable("该目录不在此资产库中，请刷新后重试");
    if (candidate.unavailable !== undefined)
      throw new ObservedRootUnavailable(
        candidate.unavailable === "missing"
          ? "该目录已不在此资产库中，请刷新后重试"
          : candidate.unavailable === "inactive"
            ? "该目录已停用，请刷新后重试"
            : "该目录允许的观察目标当前不可用，请刷新后重试",
      );
    const frozenRoot = frozen.frozenRoots.find(
      (root) => root.id === input.observedRootId,
    );
    const authorization =
      frozenRoot === undefined
        ? undefined
        : freezeObservedRootAutomationAuthorization(frozenRoot);
    if (authorization === undefined)
      throw new ObservedRootUnavailable(
        "文件位置的允许链接目标当前不可用，请刷新后重试",
      );
    // 在首次耐久写入前立即解析。后续触发通过库目录扫描沿本库冻结授权再次解析，因此本次
    // 预检与运行之间的配置变更不能授权文件系统工作。
    const preflight =
      await this.ports.observedRootRegistrations.resolveActiveScope({
        registrationId: input.observedRootId,
        relativeScope: input.relativeScope,
      });
    try {
      if (preflight.root.id !== input.observedRootId)
        throw new ObservedRootUnavailable("文件位置配置不一致，请刷新后重试");
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
        // 持久化的是本库目录授权坐标与权威边界返回的规范化范围，而不是调用方拼写。
        assetLibraryId: frozen.snapshot.id,
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
    let parentExecutionId: string | undefined;
    try {
      const run = await this.workflow.scanAssetLibrary({
        libraryId: intent.scope.assetLibraryId,
        acceptTrusted: intent.acceptTrusted,
        // 识别前无法得到视图专用需求。规划在父仍 running 时按批次冻结的规则坐标重建需求。
        ...(this.ports.informationRequirement === undefined
          ? {}
          : { informationRequirement: this.ports.informationRequirement }),
        // 周期触发与人工扫描共用同一入口、同一本目录账；意图只提供触发时间与目录范围。
        automation: {
          intentId: intent.id,
          trigger,
          observedRootId: intent.scope.observedRootId,
          relativeScope: intent.scope.relativeScope,
          requestedAt: now.toISOString(),
          policyReferences: intent.policyReferences,
        },
        onExecutionStarted: (execution) => {
          parentExecutionId = execution.id;
          lifecycle?.onExecutionStarted?.(execution);
        },
        onHostCheckpoint: lifecycle?.onCheckpoint,
      });
      parentExecutionId = run.parentExecutionId;
      const execution = await this.workflow.inspect(run.parentExecutionId);
      if (execution === undefined)
        throw new Error("自动刷新的扫描记录未能耐久保存");
      const reconciliation = await this.reconcileParentInformation(
        run.parentExecutionId,
      );
      const scan =
        execution.execution.operationKind === "scan-asset-library"
          ? await this.workflow.inspectAssetLibraryScan(run.parentExecutionId)
          : undefined;
      const hasUnavailablePrerequisite =
        executionHasUnavailablePrerequisite(execution.execution) ||
        scan?.directories.some((directory) =>
          directory.workItems.some(workFailureIsPrerequisiteUnavailable),
        ) === true ||
        reconciliation.hasUnavailablePrerequisite;
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
        // 重复定时器不能把一个持续不可用的目录变成无界的等价失败执行历史。耐久意图仍是
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
      if (parentExecutionId !== undefined)
        await this.releaseTerminalTrigger(
          intentId,
          parentExecutionId,
          trigger,
          now,
        );
    }
  }

  /** 通用恢复后，自动化只贡献耐久信息履行接续与运行时持有者释放。 */
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
        await this.reconcileParentInformation(execution.id);
        await this.releaseTerminalTrigger(
          execution.automationIntentId,
          execution.id,
          trigger,
          new Date(),
        );
      }
    }
  }

  /**
   * 父扫描之后的信息履行接续只读它自己的耐久账本：终态恢复绝不重新规划，仍未登记的计划才交给
   * 既有履行接缝按稳定 operation 身份绑定 child，已绑定的沿用原执行。没有批次的父只按历史中断
   * 收口，绝不按今日能力补造计划；父已提交的结果原样保留。
   */
  private async reconcileParentInformation(
    parentExecutionId: string,
  ): Promise<InformationFulfillmentReconciliation> {
    const ledger = this.ports.libraryScanFulfillment;
    if (ledger === undefined)
      return {
        hasUnavailablePrerequisite: false,
        fulfilledCount: 0,
        interrupted: ["这份部署没有信息履行账本，不能按今日事实补齐内容整理"],
      };
    const parent = await this.workflow.inspect(parentExecutionId);
    if (parent === undefined)
      return {
        hasUnavailablePrerequisite: false,
        fulfilledCount: 0,
        interrupted: ["这次扫描的记录无法读取，未补齐它的内容整理"],
      };
    const batch = await ledger.inspectLibraryScanFulfillment(parentExecutionId);
    if (batch === undefined)
      return parent.execution.automationIntentId === undefined
        ? {
            hasUnavailablePrerequisite: false,
            fulfilledCount: 0,
            interrupted: [],
          }
        : await this.closeHistoricalParentInformation(parent, ledger);
    if (batch.stage === "awaiting-results")
      return {
        hasUnavailablePrerequisite: false,
        fulfilledCount: 0,
        interrupted: [
          batch.reason ?? "这次扫描结束前没有写下耐久规划，未补齐它的内容整理",
        ],
      };
    return await this.registerDurableOperations(parent, batch, ledger);
  }

  /**
   * 迁移前的父没有批次，也就没有任何可复验的原规划。收口前先判定父的冻结输入与每个目录载体的
   * 可读性：只有都能读回时才据其汇集接受主体（可读且为零即空 closed 批次），任一载体缺失或无法
   * 判读就只写批次级耐久中断，绝不借今日解析器伪造处置，也不新建 child 或计划。已有 `/1` child
   * 保持原 ID 不被重开，父已提交的原扫描结果原样保留。数据库故障仍回滚抛错，绝不当成撤权或成功。
   */
  private async closeHistoricalParentInformation(
    parent: AssetRefreshInspection,
    ledger: LibraryScanFulfillmentLedger,
  ): Promise<InformationFulfillmentReconciliation> {
    const closure = await this.readHistoricalFulfillmentClosure(
      parent.execution.id,
    );
    try {
      await ledger.closeLegacyLibraryScanFulfillment(closure);
    } catch (error) {
      rethrowWorkflowLifecycle(error);
      return {
        hasUnavailablePrerequisite: false,
        fulfilledCount: 0,
        interrupted: [
          `该父的观察依据无法读取，未补齐它的内容整理：${errorMessage(error)}`,
        ],
      };
    }
    const closed = await ledger.inspectLibraryScanFulfillment(
      parent.execution.id,
    );
    if (closed === undefined)
      return {
        hasUnavailablePrerequisite: false,
        fulfilledCount: 0,
        interrupted: ["该父的历史信息履行收口无法读回"],
      };
    return await this.summariseDurableFulfillment(closed);
  }

  private async readHistoricalFulfillmentClosure(
    parentExecutionId: string,
  ): Promise<LegacyLibraryScanFulfillmentClosure> {
    const unreadableReason =
      await this.historicalCarrierUnreadableReason(parentExecutionId);
    if (unreadableReason !== undefined)
      return { parentExecutionId, acceptedSubjectIds: [], unreadableReason };
    const accepted =
      await this.workflow.acceptedSubjectsOfLibraryScan(parentExecutionId);
    return {
      parentExecutionId,
      acceptedSubjectIds: accepted.map((subject) => subject.subjectId),
    };
  }

  private async historicalCarrierUnreadableReason(
    parentExecutionId: string,
  ): Promise<string | undefined> {
    const parent = await this.workflow.inspect(parentExecutionId);
    if (parent === undefined)
      return "这次扫描的记录无法读取，未补齐它的内容整理";
    if (!historicalCarrierReadable(parent.execution))
      return "该父扫描的冻结输入无法读回，未补齐它的内容整理";
    const ledger =
      await this.ports.executionQueries.inspectLibraryScan(parentExecutionId);
    if (ledger === undefined)
      return "该父扫描的目录账本无法读取，未补齐它的内容整理";
    for (const entry of ledger.directories) {
      if (entry.mode !== "execute" || entry.childExecutionId === undefined)
        continue;
      const child = await this.workflow.inspect(entry.childExecutionId);
      if (child === undefined || !historicalCarrierReadable(child.execution))
        return "该父的内容整理载体无法读回，未补齐它的内容整理";
    }
    return undefined;
  }

  /**
   * 只把账本里仍处于 `planned` 的原计划交给履行接缝，逐主体一份，因此一个操作登记成功不会替
   * 同主体的其他操作结案。登记完成即返回，不等待远程效果；结果一律按重新读回的耐久行汇总。
   */
  private async registerDurableOperations(
    parent: AssetRefreshInspection,
    batch: LibraryScanFulfillmentInspection,
    ledger: LibraryScanFulfillmentLedger,
  ): Promise<InformationFulfillmentReconciliation> {
    const interrupted: string[] = [];
    const owed = batch.subjects.filter((subject) =>
      subject.operations.some(
        (operation) => operation.disposition === "planned",
      ),
    );
    if (owed.length !== 0) {
      const initiation: InformationFulfillmentInitiation = {
        version: "information-fulfillment-initiation/1",
        parentExecutionId: parent.execution.id,
        // 派生获取继承父执行冻结的库目录授权，效果接缝据此逐根复核，撤销/重连不替旧快照续权。
        ...(parent.execution.workflowInput?.directoryAuthorizations ===
        undefined
          ? {}
          : {
              directoryAuthorizations:
                parent.execution.workflowInput.directoryAuthorizations,
            }),
        fromDurableLedger: true,
      };
      // 派生履行沿父执行自己冻结的库快照，不借当前配置重新解释能力集合。
      const workflow =
        parent.execution.workflowInput?.assetLibrary === undefined
          ? this.workflow
          : this.workflow.workflowForLibrary(
              parent.execution.workflowInput.assetLibrary,
            );
      for (const subject of owed) {
        const plans = subject.operations.flatMap((operation) =>
          operation.disposition === "planned" && operation.plan !== undefined
            ? [operation.plan]
            : [],
        );
        const requirement = plans[0]?.requirement;
        if (plans.length === 0 || requirement === undefined) {
          interrupted.push(
            "耐久账本缺少该主体的原计划版本，未补齐它的内容整理",
          );
          continue;
        }
        try {
          await workflow.fulfillPreparedInformation({
            preparation: {
              requirement,
              subjects: [
                {
                  subjectId: subject.subjectId,
                  requirement,
                  disposition: "planned",
                  inputs: [],
                  plans,
                },
              ],
            },
            initiation,
          });
        } catch (error) {
          rethrowWorkflowLifecycle(error);
          interrupted.push(
            `该主体的信息履行登记无法完成：${errorMessage(error)}`,
          );
        }
      }
    }
    const settled = await ledger.inspectLibraryScanFulfillment(
      parent.execution.id,
    );
    if (settled === undefined)
      return {
        hasUnavailablePrerequisite: false,
        fulfilledCount: 0,
        interrupted: [...interrupted, "该父的信息履行账本无法读回"],
      };
    const durable = await this.summariseDurableFulfillment(settled);
    return {
      hasUnavailablePrerequisite: durable.hasUnavailablePrerequisite,
      fulfilledCount: durable.fulfilledCount,
      interrupted: [...interrupted, ...durable.interrupted],
    };
  }

  /**
   * 逐条汇总耐久行，原原因逐字节带出：child 的运行结果以执行行为权威，因此这里只引用它，
   * 不复制第二份终态，也不据此自动重试。
   */
  private async summariseDurableFulfillment(
    batch: LibraryScanFulfillmentInspection,
  ): Promise<InformationFulfillmentReconciliation> {
    let hasUnavailablePrerequisite = false;
    let fulfilledCount = 0;
    const interrupted: string[] = [];
    for (const subject of batch.subjects) {
      if (subject.disposition === "interrupted") {
        interrupted.push(subject.reason ?? "该主体的信息履行处置无法确定");
        continue;
      }
      for (const operation of subject.operations) {
        if (operation.disposition === "interrupted") {
          interrupted.push(operation.reason ?? "该计划的信息履行登记已中断");
          continue;
        }
        if (
          operation.disposition === "planned" ||
          operation.childExecutionId === undefined
        )
          continue;
        const child = await this.ports.executionQueries.inspectExecution(
          operation.childExecutionId,
        );
        if (
          child !== undefined &&
          executionHasUnavailablePrerequisite(child.execution)
        )
          hasUnavailablePrerequisite = true;
        fulfilledCount += 1;
      }
    }
    if (batch.stage === "interrupted")
      interrupted.push(
        batch.reason ?? "这次扫描没有留下可复验的信息履行规划依据",
      );
    return { hasUnavailablePrerequisite, fulfilledCount, interrupted };
  }

  /**
   * 已经完成的父扫描还可能在崩溃前没来得及登记内容整理。启动与轮询都只按耐久账本挑出欠账的父，
   * 从最早那份开始逐个接续：不重开终态观察，也不按今日事实重算计划，只登记它自己欠下的原计划，
   * 并把无法核对的条目如实中断。
   */
  async reconcileTerminalFulfillment(lifecycle?: {
    readonly onCheckpoint: () => void;
  }): Promise<readonly AutomationFulfillmentReconciliation[]> {
    const ledger = this.ports.libraryScanFulfillment;
    if (ledger === undefined) return [];
    const [intents, debtParentIds] = await Promise.all([
      this.ports.automationQueries.listAutomationIntents(),
      ledger.listTerminalLibraryScanFulfillmentDebt(),
    ]);
    const owedByIntent = new Map<string, AssetRefreshInspection[]>();
    // 账本按创建顺序给出欠账父，因此接续从最早那份欠账开始；后来一次扫描不能把旧父永久挤出收尾。
    for (const parentExecutionId of debtParentIds) {
      const parent = await this.workflow.inspect(parentExecutionId);
      const intentId = parent?.execution.automationIntentId;
      if (parent === undefined || intentId === undefined) continue;
      const group = owedByIntent.get(intentId);
      if (group === undefined) owedByIntent.set(intentId, [parent]);
      else group.push(parent);
    }
    const results: AutomationFulfillmentReconciliation[] = [];
    for (const intent of intents) {
      lifecycle?.onCheckpoint?.();
      let fulfilled = false;
      const interrupted: string[] = [];
      for (const parent of owedByIntent.get(intent.id) ?? []) {
        const reconciliation = await this.reconcileParentInformation(
          parent.execution.id,
        );
        if (
          reconciliation.hasUnavailablePrerequisite &&
          intent.enabled &&
          parent.execution.workflowInput?.trigger !== "scan-now"
        )
          await this.ports.automationCommands.setAutomationIntentEnabled(
            intent.id,
            false,
            "prerequisite-unavailable",
          );
        if (reconciliation.fulfilledCount > 0) fulfilled = true;
        interrupted.push(...reconciliation.interrupted);
      }
      if (!fulfilled && interrupted.length === 0) continue;
      results.push({
        intentId: intent.id,
        status: interrupted.length === 0 ? "continued" : "interrupted",
        ...(interrupted.length === 0
          ? {}
          : { reason: interrupted[0] ?? "该父的内容整理未能补齐" }),
      });
    }
    return results;
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
    // 这份计划的父不止最新那一个：旧父欠下的履行子仍在运行时，新一次定时扫描同样要等它收尾，
    // 否则后来的父会永久遮住那份还没补齐的耐久内容整理。
    const parents = new Set(
      newestFirstExecutions
        .filter((execution) => execution.automationIntentId === intent.id)
        .map((execution) => execution.id),
    );
    if (parents.size === 0) return undefined;
    const children = newestFirstExecutions.filter((execution) => {
      const workflowInput = execution.workflowInput;
      if (workflowInput === undefined) return false;
      if (workflowInput.parentExecutionId !== undefined)
        return parents.has(workflowInput.parentExecutionId);
      // 只有缺少耐久父 ID 载体的早期执行才回退到发起文案。
      return [...parents].some(
        (parentId) =>
          workflowInput.initiatedBy?.startsWith(
            `information-fulfillment:${parentId}:`,
          ) === true,
      );
    });
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

/** 父扫描之后信息履行耐久接续的结果，只含业务可读文本。 */
export type InformationFulfillmentReconciliation = {
  readonly hasUnavailablePrerequisite: boolean;
  readonly fulfilledCount: number;
  readonly interrupted: readonly string[];
};

/** 一个周期计划本次接续的结果；界面据此逐条给出状态、原因与下一步。 */
export type AutomationFulfillmentReconciliation = {
  readonly intentId: string;
  readonly status: "continued" | "interrupted";
  readonly reason?: string;
};

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
  | "reconcileTerminalFulfillment"
> &
  Pick<
    AssetRefreshWorkflow,
    | "recoverRunningExecutions"
    | "classifyRunningExecutions"
    | "continueRunningExecution"
  >;

export function attachAssetRefreshAutomation(
  workflow: AssetRefreshWorkflow,
  automation: AssetRefreshAutomation,
): AssetRefreshWorkflow & AssetRefreshAutomationWorkflow {
  const recoverRunningExecutions =
    workflow.recoverRunningExecutions.bind(workflow);
  const classifyRunningExecutions =
    workflow.classifyRunningExecutions.bind(workflow);
  const continueRunningExecution =
    workflow.continueRunningExecution.bind(workflow);
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
    classifyRunningExecutions: (
      exclude?: ReadonlySet<string>,
      within?: ReadonlySet<string>,
    ) => classifyRunningExecutions(exclude, within),
    continueRunningExecution: async (
      executionId: string,
      lifecycle?: RecoveryLifecycle,
    ) => {
      const inspection = await continueRunningExecution(executionId, lifecycle);
      // 单条继续完成后同样由自动化贡献耐久接续与运行时持有者释放，与整批恢复入口一致。
      if (inspection !== undefined)
        await automation.releaseRecoveredAutomationRuntime([inspection]);
      return inspection;
    },
    reconcileTerminalFulfillment:
      automation.reconcileTerminalFulfillment.bind(automation),
    triggerDueAutomation: automation.triggerDueAutomation.bind(automation),
  });
}

function selectSourceArtifacts(
  proposal: RecognitionProposal,
  requirement: InformationRequirement,
): readonly SourceArtifactCandidate[] {
  const interpretation = recognitionSourceInterpretation(proposal);
  if (interpretation === undefined) return [];
  const selected: SourceArtifactCandidate[] = [];
  for (const requested of requirement.artifactRoles) {
    if (
      requested.maximum !== undefined &&
      (!Number.isInteger(requested.maximum) || requested.maximum < 1)
    ) {
      throw new Error("信息需求中的产物数量上限无效");
    }
    const candidates = interpretation.sourceArtifacts.filter(
      (candidate) => candidate.role === requested.role,
    );
    const observedCandidates = proposal.observedArtifactParts?.filter(
      (candidate) =>
        observedArtifactPartAssociationRole(proposal, candidate) ===
        requested.role,
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

async function runSourceArtifactAcquisitionEffect<Value>(input: {
  readonly necessity: "required" | "optional";
  readonly acquire: () => Promise<Value>;
}): Promise<
  | { readonly status: "acquired"; readonly value: Value }
  | { readonly status: "optional-failed" }
> {
  try {
    return { status: "acquired", value: await input.acquire() };
  } catch (error) {
    if (!(error instanceof SourceArtifactAcquisitionEffectFailure)) throw error;
    rethrowWorkflowLifecycle(error.cause);
    if (input.necessity === "required") throw error.cause;
    return { status: "optional-failed" };
  }
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
    proposal.basis.kind === "manual-boundary"
      ? proposal.basis.evidence
      : evidence,
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
    observedEntityGraphs: inspections.flatMap(({ inspection, producer }) =>
      inspection.entityGraph === undefined
        ? []
        : [
            {
              ...inspection.entityGraph,
              producer,
            } satisfies ObservedEntityGraphCandidate,
          ],
    ),
  };
}

function validateRecognitionProposalForRecords(
  proposal: RecognitionProposal,
  sourceRecords: readonly SourceRecord[],
): RecognitionProposal {
  const available = new Set(sourceRecords.map((record) => record.id));
  const interpretation = recognitionSourceInterpretation(proposal);
  const references = [
    ...(interpretation?.recognitionEvidenceReferences ?? []),
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
  return requirement.artifactRoles.flatMap((requested) => {
    const candidates =
      proposal.observedArtifactParts?.filter(
        (candidate) =>
          observedArtifactPartAssociationRole(proposal, candidate) ===
          requested.role,
      ) ?? [];
    return candidates.slice(
      0,
      requested.maximum ??
        (requested.role === "asset.material-image" ? candidates.length : 1),
    );
  });
}

function withObservedMaterialImageRequirement(
  requirement: InformationRequirement,
): InformationRequirement {
  if (
    requirement.artifactRoles.some(
      (requested) => requested.role === "asset.material-image",
    )
  )
    return requirement;
  return {
    ...requirement,
    artifactRoles: [
      ...requirement.artifactRoles,
      { role: "asset.material-image", necessity: "optional" },
    ],
  };
}

function observedArtifactPartRepresentsEntity(
  proposal: RecognitionProposal,
  candidate: ObservedArtifactPartCandidate,
): boolean {
  if (candidate.role !== "asset.material-image") return false;
  const isExplicitSingleMaterial =
    proposal.basis.kind === "manual-boundary" &&
    proposal.basis.materialReferences.length === 1 &&
    proposal.basis.materialReferences[0] ===
      candidate.observedArtifactReference;
  const observedRevisions =
    proposal.basis.kind === "observed-evidence"
      ? proposal.basis.artifactRevisions
      : (proposal.observedArtifactRevisions ?? []);
  const isRecognitionEvidenceForCandidate = proposal.ruleResults.some(
    (result) =>
      result.evidence.some(
        (evidence) =>
          evidence.inspection?.observedArtifactReference ===
          candidate.observedArtifactReference,
      ),
  );
  const isRecognizedSingleRevision =
    observedRevisions.length === 1 &&
    observedRevisions[0]?.observedArtifactReference ===
      candidate.observedArtifactReference &&
    isRecognitionEvidenceForCandidate;
  return isExplicitSingleMaterial || isRecognizedSingleRevision;
}

function observedArtifactPartAssociationRole(
  proposal: RecognitionProposal,
  candidate: ObservedArtifactPartCandidate,
): string {
  return observedArtifactPartRepresentsEntity(proposal, candidate)
    ? "asset.primary-cover"
    : candidate.role;
}

function observedPartAssociationsRequireReconciliation(
  proposal: RecognitionProposal,
  current: AcceptedRecognition,
): boolean {
  const expected = (proposal.observedArtifactParts ?? [])
    .flatMap((candidate) => [
      JSON.stringify([candidate.role, candidate.locator]),
      ...(observedArtifactPartRepresentsEntity(proposal, candidate)
        ? [JSON.stringify(["asset.primary-cover", candidate.locator])]
        : []),
    ])
    .toSorted();
  const actual = current.artifactAssociations
    .filter((association) => association.observedArtifactPart !== undefined)
    .map((association) =>
      JSON.stringify([
        association.role,
        association.observedArtifactPart!.locator,
      ]),
    )
    .toSorted();
  return JSON.stringify(expected) !== JSON.stringify(actual);
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
    selectionEvidence: candidate.selectionEvidence,
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
 * 新接受资产在首次提交前没有耐久身份。因此任一完整待处理检查点都可以恢复已选隐式
 * 服务主体；重复或互相矛盾的检查点不能复活该身份或其暂存字节。
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
  const subjects: string[] = [];
  for (const candidate of implicit) {
    const matches = checkpoints.filter((checkpoint) =>
      checkpointMatchesCandidateExceptSubject(checkpoint, candidate),
    );
    const matchedSubjects = new Set(matches.map((match) => match.subjectId));
    if (matchedSubjects.size > 1) return undefined;
    const [subject] = matchedSubjects;
    if (subject !== undefined) subjects.push(subject);
  }
  if (subjects.length === 0) return undefined;
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
      selectionEvidence: candidate.selectionEvidence,
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
  const interpretation = recognitionSourceInterpretation(proposal);
  for (const requested of requirement.metadata) {
    if (
      requested.necessity === "required" &&
      ![
        ...(interpretation?.metadata ?? []),
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
      ![
        ...(interpretation?.relationships ?? []),
        ...(proposal.observedEntityGraphs ?? []).flatMap(
          (graph) => graph.relationships,
        ),
      ].some((relationship) => relationship.type === requested.type)
    )
      throw new Error(`缺少必需的关系类型：${requested.type}`);
  }
}

function sameRecognitionIdentity(
  current: AcceptedRecognition,
  proposal: RecognitionProposal,
  currentObservedFiles: readonly Pick<
    FilesystemPackageSnapshot["files"][number],
    "modifiedAt" | "relativePath" | "size"
  >[],
  observedFiles: readonly Pick<
    FilesystemPackageSnapshot["files"][number],
    "modifiedAt" | "relativePath" | "size"
  >[],
  compareSourceFacts: boolean,
): boolean {
  return (
    sameRecognitionMaterialBoundaries(
      current.recognitionDecision.boundaries,
      proposal.boundaries,
    ) &&
    recognitionSourceCoordinate(current.proposal) ===
      recognitionSourceCoordinate(proposal) &&
    recognitionMaterialBoundary(
      current.proposal,
      currentObservedFiles,
      compareSourceFacts,
    ) ===
      recognitionMaterialBoundary(proposal, observedFiles, compareSourceFacts)
  );
}

function recognitionChangesOnlySourceAddress(
  current: AcceptedRecognition,
  proposal: RecognitionProposal,
  currentObservedFiles: readonly Pick<
    FilesystemPackageSnapshot["files"][number],
    "modifiedAt" | "relativePath" | "size"
  >[],
  observedFiles: readonly Pick<
    FilesystemPackageSnapshot["files"][number],
    "modifiedAt" | "relativePath" | "size"
  >[],
): boolean {
  const before = recognitionSourceInterpretation(current.proposal);
  const after = recognitionSourceInterpretation(proposal);
  return (
    before !== undefined &&
    after !== undefined &&
    before.sourceIdentity === after.sourceIdentity &&
    before.sourceAddress !== after.sourceAddress &&
    recognitionMaterialBoundary(
      current.proposal,
      currentObservedFiles,
      true,
    ) === recognitionMaterialBoundary(proposal, observedFiles, true)
  );
}

function recognitionSourceCoordinate(proposal: RecognitionProposal): string {
  const interpretation = recognitionSourceInterpretation(proposal);
  return interpretation === undefined
    ? proposal.basis.kind
    : JSON.stringify([
        interpretation.sourceIdentity,
        interpretation.sourceAddress,
      ]);
}

function recognitionMaterialBoundary(
  proposal: RecognitionProposal,
  observedFiles: readonly Pick<
    FilesystemPackageSnapshot["files"][number],
    "modifiedAt" | "relativePath" | "size"
  >[],
  compareSourceFacts: boolean,
): string {
  const withoutCapabilityProvenance = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutCapabilityProvenance);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        key === "producer" ? [] : [[key, withoutCapabilityProvenance(child)]],
      ),
    );
  };
  const interpretation = recognitionSourceInterpretation(proposal);
  const sourceMaterial =
    interpretation === undefined || !compareSourceFacts
      ? undefined
      : {
          metadata: interpretation.metadata.map(
            ({ producer: _producer, sourceRecordIds: _records, ...item }) =>
              item,
          ),
          entities: (interpretation.entities ?? []).map(
            ({ producer: _producer, sourceRecordIds: _records, ...item }) =>
              item,
          ),
          entityMentions: (interpretation.entityMentions ?? []).map(
            ({ producer: _producer, sourceRecordIds: _records, ...item }) =>
              item,
          ),
          entityResolutionDecisions: (
            interpretation.entityResolutionDecisions ?? []
          ).map(
            ({ producer: _producer, sourceRecordIds: _records, ...item }) =>
              item,
          ),
          relationships: (interpretation.relationships ?? []).map(
            ({ producer: _producer, sourceRecordIds: _records, ...item }) =>
              item,
          ),
          sourceArtifacts: interpretation.sourceArtifacts.map(
            ({
              producer: _producer,
              sourceRecordId: _record,
              id: _id,
              ...item
            }) => item,
          ),
        };
  return JSON.stringify({
    observedFiles:
      proposal.basis.kind === "source-interpretation"
        ? []
        : observedFiles.map(({ relativePath, size, modifiedAt }) => ({
            relativePath,
            size,
            modifiedAt,
          })),
    basis:
      proposal.basis.kind === "source-interpretation"
        ? { kind: proposal.basis.kind, sourceMaterial }
        : proposal.basis.kind === "manual-boundary"
          ? {
              kind: proposal.basis.kind,
              materialReferences: proposal.basis.materialReferences,
              metadata: proposal.basis.metadata,
              evidence: withoutCapabilityProvenance(proposal.basis.evidence),
            }
          : {
              kind: proposal.basis.kind,
              evidence: withoutCapabilityProvenance(proposal.basis.evidence),
              artifactRevisions: withoutCapabilityProvenance(
                proposal.basis.kind === "observed-evidence"
                  ? proposal.basis.artifactRevisions
                  : [],
              ),
            },
    // 观察证据提议已在 basis 中完整携带格式元数据、组成部分和修订版；再次比较其
    // 派生投影会让旧持久化提议因缺少重复字段而被误判为身份变化。来源解释提议没有
    // 这份观察 basis，仍须比较其附带的本地格式投影。
    observedArtifactParts:
      proposal.basis.kind !== "source-interpretation" || !compareSourceFacts
        ? []
        : (proposal.observedArtifactParts ?? []).map(
            ({ id: _id, producer: _producer, ...item }) => item,
          ),
    observedMetadata:
      proposal.basis.kind !== "source-interpretation" || !compareSourceFacts
        ? []
        : (proposal.observedMetadata ?? []).map(
            ({ producer: _producer, ...item }) => item,
          ),
    observedArtifactRevisions:
      proposal.basis.kind !== "source-interpretation" || !compareSourceFacts
        ? []
        : (proposal.observedArtifactRevisions ?? []).map(
            ({ producer: _producer, ...item }) => item,
          ),
    observedArtifactAssociations:
      proposal.observedArtifactAssociations !== undefined &&
      proposal.observedArtifactAssociations.length > 0
        ? proposal.observedArtifactAssociations
        : observedFiles.map(({ relativePath: observedArtifactReference }) => ({
            observedArtifactReference,
            role: "asset.material-delivered",
          })),
  });
}

function inspectedRevisionCoordinates(
  evidence: readonly RecognitionEvidence[],
  root: string,
): string {
  return JSON.stringify(
    evidence
      .flatMap((item) =>
        item.inspection === undefined
          ? []
          : [
              JSON.stringify([
                `${root}/${item.inspection.observedArtifactReference}`,
                item.producer.capabilityId,
                item.producer.capabilityVersion,
                item.producer.contractVersion,
                item.inspection.revision.digest,
                item.inspection.revision.byteLength,
              ]),
            ],
      )
      .toSorted(),
  );
}

function canonicalObservedMaterialRevisions(
  revisions: readonly import("@digital/domain").ObservedArtifactRevisionCandidate[],
): string {
  return JSON.stringify(
    revisions
      .map((revision) => ({
        reference: revision.observedArtifactReference,
        digest: revision.blob.digest,
        byteLength: revision.blob.byteLength,
        mediaType: revision.blob.mediaType,
      }))
      .toSorted((left, right) => left.reference.localeCompare(right.reference)),
  );
}

function observedMaterialAssociationProjections(
  proposal: RecognitionProposal,
  snapshot: FilesystemPackageSnapshot,
  accepted: AcceptedRecognition,
): ObservedMaterialAssociationSubmission["projections"] {
  const revisions = new Map(
    (proposal.observedArtifactRevisions ?? []).map((revision) => [
      revision.observedArtifactReference,
      revision,
    ]),
  );
  return (proposal.observedArtifactAssociations ?? []).map((candidate) => {
    const location = accepted.locations.find(
      (item) =>
        item.kind === "observed" &&
        item.address ===
          `${snapshot.root}/${candidate.observedArtifactReference}`,
    );
    const revisionCandidate = revisions.get(
      candidate.observedArtifactReference,
    );
    const revision = accepted.artifactRevisions.find(
      (item) =>
        item.artifactId === location?.artifactId &&
        item.blobDigest === revisionCandidate?.blob.digest,
    );
    const association = accepted.artifactAssociations.find(
      (item) =>
        item.target.kind === "entity" &&
        item.target.entityId === accepted.entity.id &&
        item.artifactId === location?.artifactId &&
        item.role === candidate.role,
    );
    if (
      location === undefined ||
      revision === undefined ||
      association === undefined
    )
      throw new Error("Observed material projection is incomplete");
    return {
      observedArtifactReference: candidate.observedArtifactReference,
      artifactId: location.artifactId,
      locationId: location.id,
      revisionId: revision.id,
      associationId: association.id,
    };
  });
}

function uniqueObservedMaterialBlobs(blobs: readonly Blob[]): readonly Blob[] {
  return [...new Map(blobs.map((blob) => [blob.digest, blob])).values()];
}

class ObservedMaterialStaleError extends Error {}

function canonicalObservedMaterialObjectIdentity(
  files: readonly FileObservation[],
  contract: FilesystemObjectIdentityContract | undefined,
): string {
  const selected = [...files].toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const localGroups = new Map<string, string[]>();
  for (const file of selected) {
    if (file.objectIdentity?.kind !== "snapshot-local") continue;
    const key = observedObjectIdentityKey(file, contract);
    localGroups.set(key!, [
      ...(localGroups.get(key!) ?? []),
      file.relativePath,
    ]);
  }
  const aliasClasses = [...localGroups.values()]
    .map((members) => members.toSorted())
    .filter((members) => members.length > 1)
    .toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return JSON.stringify({
    files: selected.map((file) => ({
      relativePath: file.relativePath,
      size: file.size,
      modifiedAt: file.modifiedAt,
      durableIdentity:
        file.objectIdentity?.kind === "durable"
          ? observedObjectIdentityKey(file, contract)
          : undefined,
    })),
    aliasClasses,
  });
}

/**
 * Application 在一次接受内构造的精确材料映射，交给同一原子接受事务写入私有
 * observed_material_acceptances 投影；不是公开交付合同，也不新增领域事实。
 * `c-association` 与 `a-preview` 由 SQLite 从其版本化 checkpoint／preview 载体派生。
 */
export type ObservedMaterialAcceptanceBinding = {
  readonly workItemKey: string;
  readonly acceptanceKind:
    | "a-work-item"
    | "b-local"
    | "c-association"
    | "a-preview";
  readonly proposalId: string;
  readonly assetId: string;
  readonly artifactId: string;
  readonly locationId: string;
  readonly associationId: string;
  readonly snapshotId: string;
  readonly observedReference: string;
  readonly materialKind: "file" | "directory";
};

/**
 * 按该工作项自己的原始完整 snapshot，把明确创建或复用的材料映射到本次接受结果中的
 * 精确 Artifact、Location 与 delivered 关联；不把无关的既有位置写成本次事件。
 */
function observedMaterialAcceptanceBindings(input: {
  readonly accepted: AcceptedRecognition;
  readonly snapshot: FilesystemPackageSnapshot;
  readonly workItemKey: string;
  readonly acceptanceKind: "a-work-item" | "b-local";
  readonly relativePaths: readonly string[];
  readonly observedArtifactBoundary?: "filesystem-package";
}): ObservedMaterialAcceptanceBinding[] {
  const assetId = input.accepted.entity.id;
  const delivered = input.accepted.artifactAssociations.filter(
    (association) =>
      association.target.kind === "entity" &&
      association.target.entityId === assetId &&
      association.role === "asset.material-delivered",
  );
  const deliveredArtifactIds = new Set(
    delivered.map((association) => association.artifactId),
  );
  // 没有工作项限定范围时（例如周期意图的受信接受），本次接受确认的材料就是 accepted
  // 自己交付的观察位置；不能把这条公开路径的边界与正向支持留空。
  const references =
    input.observedArtifactBoundary === "filesystem-package"
      ? ["."]
      : input.relativePaths.length > 0
        ? input.relativePaths
        : input.accepted.locations.flatMap((location) =>
            location.kind !== "observed" ||
            !deliveredArtifactIds.has(location.artifactId) ||
            !location.address.startsWith(`${input.snapshot.root}/`)
              ? []
              : input.snapshot.files
                  .filter(
                    (file) =>
                      `${input.snapshot.root}/${file.relativePath}` ===
                      location.address,
                  )
                  .map((file) => file.relativePath),
          );
  return references.map((observedReference) => {
    if (
      observedReference !== "." &&
      !input.snapshot.files.some(
        (file) => file.relativePath === observedReference,
      )
    )
      throw new Error(
        `Accepted material ${observedReference} is missing from its snapshot`,
      );
    const address =
      observedReference === "."
        ? input.snapshot.root
        : `${input.snapshot.root}/${observedReference}`;
    const location = input.accepted.locations.find(
      (candidate) =>
        candidate.kind === "observed" && candidate.address === address,
    );
    if (location === undefined)
      throw new Error(`Accepted material location is missing for ${address}`);
    const association = delivered.find(
      (candidate) => candidate.artifactId === location.artifactId,
    );
    if (association === undefined)
      throw new Error(`Delivered association is missing for ${address}`);
    return {
      workItemKey: input.workItemKey,
      acceptanceKind: input.acceptanceKind,
      proposalId: input.accepted.proposal.id,
      assetId,
      artifactId: location.artifactId,
      locationId: location.id,
      associationId: association.id,
      snapshotId: input.snapshot.id,
      observedReference,
      materialKind:
        observedReference === "." ? ("directory" as const) : ("file" as const),
    };
  });
}

/**
 * 代表正文依据：整批已确认材料就是一个文件，或来源规则把目录内的材料声明为代表正文，
 * 且这些文件的格式检查被明确接受的规则覆盖时，它们的内嵌标题才代表资产本身，可以沿
 * 共同事实成为实体标题。目录范围（例如 RJ 音声）里未被声明为代表正文的台本或图片修订
 * 绝不会被当成音声标题的代表正文；核心不解析目录名，也不按格式或顺序任选正文。
 * 同名多格式正文只有共同指认同一标题时才有代表依据，分歧时诚实缺失，不从路径造标题。
 * 代表决定授权下的材料刷新沿用同一条决定与同一判定：正文被替换后，只要代表正文集合
 * 不变，实体标题就跟着新修订走，而不是停在旧修订上或凭空消失。
 */
function selectRepresentativeBodyEntityMetadata(input: {
  readonly proposal: RecognitionProposal;
  readonly assetId: string;
  readonly recognitionDecisionId: string;
  readonly observedRevisionByReference: ReadonlyMap<
    string,
    { readonly artifactId: string; readonly revisionId: string }
  >;
  readonly observedMetadata: readonly MetadataAssertion[];
}): readonly MetadataAssertion[] {
  const { basis } = input.proposal;
  if (basis.kind !== "observed-evidence" && basis.kind !== "accepted-boundary")
    return [];
  const [boundary] = input.proposal.boundaries;
  if (input.proposal.boundaries.length !== 1 || boundary === undefined)
    return [];
  const inspectedReferences = new Set(
    (input.proposal.observedArtifactRevisions ?? []).map(
      (candidate) => candidate.observedArtifactReference,
    ),
  );
  let bodyReferences: readonly string[];
  if (boundary.kind === "discrete") {
    // 材料唯一且格式检查只覆盖一个观察引用，两者才同指那条正文。
    if (boundary.materialReferences.length !== 1) return [];
    const [inspectedReference] = [...inspectedReferences];
    if (inspectedReferences.size !== 1 || inspectedReference === undefined)
      return [];
    // 整批依据只有那一个修订时，才谈得上这条正文代表资产本身。
    if (
      basis.kind === "observed-evidence" &&
      basis.artifactRevisions.length !== 1
    )
      return [];
    bodyReferences = [inspectedReference];
  } else {
    // 目录范围的代表正文只认来源规则的声明，核心不解释路径含义。
    bodyReferences = [
      ...new Set(
        (input.proposal.observedArtifactAssociations ?? [])
          .filter((candidate) => candidate.role === "asset.representative-body")
          .map((candidate) => candidate.observedArtifactReference)
          .filter((reference) => inspectedReferences.has(reference)),
      ),
    ].toSorted();
    if (bodyReferences.length === 0) return [];
  }
  const represented = bodyReferences.every((reference) =>
    basis.kind === "observed-evidence"
      ? basis.artifactRevisions.some(
          (candidate) =>
            candidate.observedArtifactReference === reference &&
            input.proposal.ruleResults.some(
              (result) =>
                result.outcome === "satisfied" &&
                result.evidence.some(
                  (evidence) =>
                    evidence.inspection?.observedArtifactReference ===
                    reference,
                ),
            ),
        )
      : basis.evidence.some(
          (evidence) =>
            evidence.inspection?.observedArtifactReference === reference,
        ),
  );
  if (!represented) return [];
  const titles: MetadataAssertion[] = [];
  for (const reference of bodyReferences) {
    const parent = input.observedRevisionByReference.get(reference);
    if (parent === undefined) return [];
    const bodyTitles = [
      ...new Map(
        input.observedMetadata
          .filter(
            (assertion) =>
              assertion.property === "asset.title" &&
              assertion.target.kind === "artifact-revision" &&
              assertion.target.artifactId === parent.artifactId &&
              assertion.target.revisionId === parent.revisionId,
          )
          .map((title) => [title.sourceSlot, title]),
      ).values(),
    ];
    // 少一份代表正文的精确修订标题，代表依据就不成立。
    if (bodyTitles.length === 0) return [];
    titles.push(...bodyTitles);
  }
  if (bodyReferences.length === 1) return projectEntityTitles(titles, input);
  // 多份同名正文必须共同指认同一个标题；分歧时诚实缺失，不按格式或数组顺序任选。
  if (
    titles.length !== bodyReferences.length ||
    titles.some(
      (title) =>
        JSON.stringify(title.value) !== JSON.stringify(titles[0]!.value),
    )
  )
    return [];
  return projectEntityTitles([titles[0]!], input);
}

function projectEntityTitles(
  titles: readonly MetadataAssertion[],
  input: { readonly assetId: string; readonly recognitionDecisionId: string },
): readonly MetadataAssertion[] {
  return titles.map((assertion) => ({
    ...assertion,
    target: { kind: "entity" as const, entityId: input.assetId },
    recognitionDecisionId: input.recognitionDecisionId,
  }));
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
  const proposal: RecognitionProposal = {
    ...options.proposal,
    ...(options.proposal.observedArtifactAssociations !== undefined
      ? {}
      : {
          observedArtifactAssociations: options.snapshot.files.map((file) => ({
            observedArtifactReference: file.relativePath,
            role: "asset.material-delivered" as const,
          })),
        }),
  };
  const interpretation = recognitionSourceInterpretation(proposal);
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
          candidate.target.kind === "entity" &&
          candidate.target.entityId === asset.id &&
          candidate.artifactId === createdArtifact.id &&
          candidate.role === "asset.material-delivered" &&
          (candidate.sourceRecordIds === undefined ||
            candidate.sourceRecordIds.length === 0) &&
          candidate.observedArtifactPart === undefined,
      ) ?? {
        id: observedArtifactAssociationId(asset.id, createdArtifact.id),
        target: { kind: "entity" as const, entityId: asset.id },
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
  for (const candidate of proposal.observedArtifactAssociations ?? []) {
    if (candidate.role === "asset.material-delivered") continue;
    const artifact = observedByRelativePath.get(
      candidate.observedArtifactReference,
    );
    if (artifact === undefined)
      throw new Error(
        "Observed artifact role is outside the accepted material boundary",
      );
    const revision = (proposal.observedArtifactRevisions ?? []).find(
      (item) =>
        item.observedArtifactReference ===
          candidate.observedArtifactReference &&
        (candidate.role !== "asset.primary-cover" &&
        candidate.role !== "asset.material-image"
          ? true
          : item.blob.mediaType.startsWith("image/")),
    );
    // 无精确图片修订依据就不产生封面角色，图片头检查也不冒称完整解码。
    if (revision === undefined) continue;
    // 材料身份与代表角色都钉在同一稳定实体目标上，共用同一 Artifact；精确修订只在
    // 共同生效读取里按当前位置解析，不由关联自己冒充内容寻据。
    const association: ArtifactAssociation = {
      id: `artifact-association_${sha256(new TextEncoder().encode(JSON.stringify([asset.id, artifact.id, candidate.role, candidate.producer])))}`,
      target: { kind: "entity", entityId: asset.id },
      artifactId: artifact.id,
      role: candidate.role,
      ...(candidate.producer === undefined
        ? {}
        : { producer: candidate.producer }),
    };
    if (!localAssociationIds.has(association.id)) {
      localAssociationIds.add(association.id);
      localAssociations.push(association);
    }
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
  for (const candidate of proposal.observedArtifactRevisions ?? []) {
    const observedArtifact = observedByRelativePath.get(
      candidate.observedArtifactReference,
    );
    if (observedArtifact === undefined)
      throw new Error(
        "Observed Artifact Revision is outside the accepted work boundary",
      );
    const revision: ArtifactRevision = {
      id: observedArtifactRevisionId(
        observedArtifact.id,
        candidate.blob.digest,
      ),
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
      id: observedArtifactRevisionId(observedArtifact.id, part.origin.digest),
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
        target: {
          kind: "artifact-revision" as const,
          artifactId: parentRevision.artifactId,
          revisionId: parentRevision.revisionId,
        },
        artifactId: artifact.id,
        role: part.candidate.role,
        producer: part.producer,
        observedArtifactPart: {
          artifactId: origin.id,
          revisionId: parentRevision.revisionId,
          locator: part.candidate.locator,
        },
      },
      entityAssociation: observedArtifactPartRepresentsEntity(
        proposal,
        part.candidate,
      )
        ? {
            id: `artifact-association_${materializationKey}_entity-cover`,
            target: { kind: "entity" as const, entityId: asset.id },
            artifactId: artifact.id,
            role: "asset.primary-cover",
            producer: part.producer,
            observedArtifactPart: {
              artifactId: origin.id,
              revisionId: parentRevision.revisionId,
              locator: part.candidate.locator,
            },
          }
        : undefined,
    };
  });
  const observedMetadata: MetadataAssertion[] = (
    proposal.observedMetadata ?? []
  ).map((candidate) => {
    const parent = observedRevisionByReference.get(
      candidate.observedArtifactReference,
    );
    if (parent === undefined)
      throw new Error(
        `Observed metadata requires a progressively hashed parent Artifact Revision for ${candidate.observedArtifactReference}; materialized parents: ${[...observedRevisionByReference.keys()].join(",")}`,
      );
    return {
      target: {
        kind: "artifact-revision" as const,
        artifactId: parent.artifactId,
        revisionId: parent.revisionId,
      },
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
  const recognitionDecisionId =
    options.current?.recognitionDecision.id ?? id("recognition-decision");
  const representativeEntityMetadata = selectRepresentativeBodyEntityMetadata({
    proposal,
    assetId: asset.id,
    recognitionDecisionId,
    observedRevisionByReference,
    observedMetadata,
  });
  const recognitionSourceAssociation: SourceAssociation | undefined =
    options.current?.recognitionSourceAssociation ??
    (interpretation === undefined
      ? undefined
      : {
          id: id("source-association"),
          subjectId: asset.id,
          sourceIdentity: interpretation.sourceIdentity,
          nativeAddress: interpretation.sourceAddress,
        });
  const sourceAssociations =
    options.current?.sourceAssociations ??
    (recognitionSourceAssociation === undefined
      ? []
      : [recognitionSourceAssociation]);
  const sourceMetadata: readonly MetadataAssertion[] =
    interpretation?.metadata.map(({ subjectId, ...assertion }) => ({
      ...assertion,
      target: {
        kind: "entity" as const,
        entityId: subjectId ?? asset.id,
      },
    })) ?? [];
  const observedEntityGraphs = (proposal.observedEntityGraphs ?? []).map(
    (candidate) => {
      const parent = observedRevisionByReference.get(
        candidate.observedArtifactReference,
      );
      if (parent === undefined)
        throw new Error(
          "Observed entity graph requires a progressively hashed parent Artifact Revision",
        );
      const entityIdByKey = new Map(
        candidate.entities.map((entity) => [
          entity.key,
          `observed-entity_${sha256(new TextEncoder().encode(JSON.stringify([asset.id, parent.artifactId, candidate.producer, candidate.coverage.id, entity.occurrenceSlot, entity.preservedValue])))}`,
        ]),
      );
      const mentionIdByKey = new Map(
        candidate.mentions.map((mention) => [
          mention.key,
          `observed-mention_${sha256(new TextEncoder().encode(JSON.stringify([entityIdByKey.get(mention.entityKey), parent.revisionId, mention.sourceSlot, mention.label])))}`,
        ]),
      );
      return {
        assetId: asset.id,
        artifactId: parent.artifactId,
        revisionId: parent.revisionId,
        producer: candidate.producer,
        coverageId: candidate.coverage.id,
        complete: true as const,
        entities: candidate.entities.map((entity) => ({
          id: entityIdByKey.get(entity.key)!,
          occurrenceSlot: entity.occurrenceSlot,
          label: entity.label,
          preservedValue: entity.preservedValue,
          locator: entity.locator,
        })),
        mentions: candidate.mentions.map((mention) => ({
          id: mentionIdByKey.get(mention.key)!,
          entityId: entityIdByKey.get(mention.entityKey)!,
          sourceSlot: mention.sourceSlot,
          field: mention.field,
          role: mention.role,
          label: mention.label,
          locator: mention.locator,
        })),
        resolutions: candidate.resolutions.map((resolution) => ({
          mentionId: mentionIdByKey.get(resolution.mentionKey)!,
          entityId: entityIdByKey.get(resolution.entityKey)!,
        })),
        relationships: candidate.relationships.map((relationship) => ({
          id: `observed-relationship_${sha256(new TextEncoder().encode(JSON.stringify([asset.id, parent.artifactId, candidate.producer, candidate.coverage.id, relationship.sourceSlot, parent.revisionId, relationship.type, relationship.subjectRole, relationship.participants, relationship.qualifiers])))}`,
          participants: [
            { entityId: asset.id, role: relationship.subjectRole },
            ...relationship.participants.map((participant) => ({
              entityId: entityIdByKey.get(participant.entityKey)!,
              role: participant.role,
              mentionIds: participant.mentionKeys.map(
                (mentionKey) => mentionIdByKey.get(mentionKey)!,
              ),
            })),
          ],
          type: relationship.type,
          sourceSlot: relationship.sourceSlot,
          sourceRecordIds: [],
          producer: candidate.producer,
          qualifiers: relationship.qualifiers,
        })),
      };
    },
  );
  return {
    proposal,
    entity: asset,
    sourceAssociations,
    ...(recognitionSourceAssociation === undefined
      ? {}
      : { recognitionSourceAssociation }),
    recognitionDecision: {
      id: recognitionDecisionId,
      proposalId:
        options.current?.recognitionDecision.proposalId ?? proposal.id,
      assetId: asset.id,
      boundaries:
        options.current?.recognitionDecision.boundaries ?? proposal.boundaries,
      acceptedRuleResults:
        options.current?.recognitionDecision.acceptedRuleResults ??
        proposal.ruleResults,
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
      ...localParts.flatMap((item) =>
        item.entityAssociation === undefined ? [] : [item.entityAssociation],
      ),
    ],
    metadata: [
      ...sourceMetadata,
      ...observedMetadata,
      ...representativeEntityMetadata,
      ...(proposal.basis.kind !== "manual-boundary"
        ? []
        : proposal.basis.metadata.map((assertion) => ({
            ...assertion,
            target: { kind: "entity" as const, entityId: asset.id },
            sourceSlot: assertion.property,
            sourceRecordIds: [],
            authoredBy: {
              initiatedBy:
                proposal.basis.kind === "manual-boundary"
                  ? proposal.basis.proposedBy
                  : "",
              proposalId: proposal.id,
            },
          }))),
    ],
    entities: interpretation?.entities ?? [],
    entityMentions: interpretation?.entityMentions ?? [],
    entityResolutionDecisions: interpretation?.entityResolutionDecisions ?? [],
    relationships: (interpretation?.relationships ?? []).map(
      (relationship) => ({
        id: relationshipId(relationship, interpretation?.sourceIdentity ?? ""),
        ...relationship,
        participants: [
          ...(relationship.subjectRole === undefined
            ? []
            : [{ entityId: asset.id, role: relationship.subjectRole }]),
          ...relationship.participants,
        ],
      }),
    ),
    ...(observedEntityGraphs.length === 0 ? {} : { observedEntityGraphs }),
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

function observedArtifactRevisionId(
  artifactId: string,
  blobDigest: string,
): string {
  return `artifact-revision_${sha256(
    new TextEncoder().encode(`${artifactId}\u0000${blobDigest}`),
  )}`;
}

/**
 * 完整来源实体关系只由其来源事实本身形成稳定身份，不能随采用它的资产镜像复制。
 */
function relationshipId(
  relationship: NonNullable<SourceInterpretationBatch["relationships"]>[number],
  sourceIdentity: string,
): string {
  if (relationship.subjectRole !== undefined) return id("entity-relationship");
  const semanticKey = [
    ...relationship.participants
      .map((participant) => `${participant.entityId}:${participant.role}`)
      .toSorted(),
    relationship.type,
    relationship.sourceSlot,
    sourceIdentity,
    relationship.sourceSubjectId ?? "",
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

function persistedSharedCollectionRecordsForPlanKeys(
  inspection: ExecutionInspection | undefined,
  eligiblePlanKeys: readonly string[],
): readonly SourceRecord[] {
  if (inspection === undefined) return [];
  const eligible = new Set(eligiblePlanKeys);
  const ids = new Set<string>();
  for (const item of inspection.execution.workItems ?? []) {
    if (!eligible.has(item.key)) continue;
    for (const id of item.sourceRecordIds) ids.add(id);
  }
  return inspection.sourceRecords.filter((record) => ids.has(record.id));
}

function normalizeSourceRecordBatch(
  records: readonly SourceRecord[],
): readonly SourceRecord[] {
  const byId = new Map<string, SourceRecord>();
  for (const record of records) {
    const retained = byId.get(record.id);
    if (retained === undefined) {
      byId.set(record.id, record);
      continue;
    }
    if (!sameSourceRecord(retained, record))
      throw new Error("同一来源记录标识对应冲突的不可变记录");
  }
  return [...byId.values()];
}

function sameSourceRecord(left: SourceRecord, right: SourceRecord): boolean {
  return (
    left.id === right.id &&
    left.sourceIdentity === right.sourceIdentity &&
    left.nativeAddress === right.nativeAddress &&
    left.mediaType === right.mediaType &&
    left.acquiredAt === right.acquiredAt &&
    left.acquisition.requestedAddress === right.acquisition.requestedAddress &&
    left.acquisition.method === right.acquisition.method &&
    left.acquisition.authorized === right.acquisition.authorized &&
    left.coverage.id === right.coverage.id &&
    left.coverage.completeness === right.coverage.completeness &&
    left.coverage.authority === right.coverage.authority &&
    left.digest === right.digest &&
    left.body === right.body &&
    sameOptionalCompleteCapability(left.producer, right.producer)
  );
}

function sameOptionalCompleteCapability(
  left: CapabilityCoordinate | undefined,
  right: CapabilityCoordinate | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftInterpretationVersions = left.interpretationContractVersions;
  const rightInterpretationVersions = right.interpretationContractVersions;
  const sameInterpretationVersions =
    leftInterpretationVersions === undefined ||
    rightInterpretationVersions === undefined
      ? leftInterpretationVersions === rightInterpretationVersions
      : leftInterpretationVersions.length ===
          rightInterpretationVersions.length &&
        leftInterpretationVersions.every(
          (version, index) => version === rightInterpretationVersions[index],
        );
  return (
    left.capabilityId === right.capabilityId &&
    left.capabilityVersion === right.capabilityVersion &&
    left.contractVersion === right.contractVersion &&
    left.identity === right.identity &&
    left.implementationVersion === right.implementationVersion &&
    left.kind === right.kind &&
    sameInterpretationVersions
  );
}

function partialCollectionReason(
  failures: readonly SourceCollectionFailure[],
): string {
  return `已保留可用官方记录；未请求的信息仍不可用：${failures
    .map((failure) => failure.reason)
    .join("；")}`;
}

function sourceFailureCodes(
  failures: readonly SourceCollectionFailure[],
): readonly SourceFailureCode[] | undefined {
  if (failures.length === 0 || failures.length > 16) return undefined;
  const codes: SourceFailureCode[] = [];
  for (const failure of failures) {
    if (
      !isCompleteSourceFailureCapability(failure.capability) ||
      typeof failure.failureCode !== "string" ||
      failure.failureCode.length === 0 ||
      new TextEncoder().encode(failure.failureCode).byteLength > 128
    )
      return undefined;
    codes.push({
      capability: failure.capability,
      code: failure.failureCode,
    });
  }
  return codes;
}

function isCompleteSourceFailureCapability(
  capability: CapabilityCoordinate,
): boolean {
  return (
    hasExactCapabilityCoordinateShape(capability) &&
    isCapabilityCoordinate(capability) &&
    typeof capability.identity === "string" &&
    capability.identity.trim().length > 0 &&
    capability.identity.length <= 240 &&
    typeof capability.implementationVersion === "string" &&
    capability.implementationVersion.trim().length > 0 &&
    capability.implementationVersion.length <= 240 &&
    typeof capability.kind === "string" &&
    capability.kind.trim().length > 0 &&
    capability.kind.length <= 240 &&
    Array.isArray(capability.interpretationContractVersions) &&
    capability.interpretationContractVersions.length > 0 &&
    capability.interpretationContractVersions.every(
      (value) =>
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 240,
    )
  );
}

function hasExactCapabilityCoordinateShape(
  capability: CapabilityCoordinate,
): boolean {
  const actual = Object.keys(capability).toSorted();
  const expected = [
    "capabilityId",
    "capabilityVersion",
    "contractVersion",
    "identity",
    "implementationVersion",
    "interpretationContractVersions",
    "kind",
  ];
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function durableSourceCollectionFailures(
  failures: readonly SourceCollectionFailure[],
): readonly DurableSourceCollectionFailure[] {
  return failures.map((failure) => ({
    capability: failure.capability,
    reason: failure.reason,
    ...(failure.failureClassification === undefined
      ? {}
      : { failureClassification: failure.failureClassification }),
    ...(failure.coverage === undefined ? {} : { coverage: failure.coverage }),
    ...(failure.affects === undefined ? {} : { affects: failure.affects }),
  }));
}

function executionWithDispositionSourceFailureCodes(
  execution: WorkflowExecution,
  key: string,
  codes: readonly SourceFailureCode[] | undefined,
): WorkflowExecution {
  return {
    ...execution,
    dispositions: execution.dispositions.map((disposition) =>
      disposition.key === key
        ? {
            ...disposition,
            ...(codes === undefined ? {} : { sourceFailureCodes: codes }),
          }
        : disposition,
    ),
  };
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
