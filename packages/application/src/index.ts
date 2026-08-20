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
} from "./asset-refresh-selection.js";
import type {
  ExecutionHost,
  ExecutionInvocationControl,
} from "./execution-host.js";
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
} from "./information-fulfillment.js";
import type { MetadataPolicyConfiguration } from "./metadata-policy-configuration.js";
import {
  decodeObservedRootSnapshot,
  freezeObservedRootAutomationAuthorization,
  type ObservedRootAutomationAuthorization,
  type ObservedRootAutomationScope,
} from "./observed-root-authority.js";
import { ObservedRootExecution } from "./observed-root-execution.js";
import {
  BoundObservedScope,
  ObservedByteSource,
  type ObservedRootRegistrations,
  type ObservedRootSnapshot,
  ObservedRootUnavailable,
} from "./observed-root-registrations.js";
import {
  CheckpointedSourceArtifactWork,
  projectManagedSourceArtifacts,
} from "./source-artifact-work.js";
import {
  atPublicWorkflowBoundary,
  notifyWorkflowCheckpoint as notifyDurableCheckpoint,
  rethrowWorkflowLifecycle,
  WorkflowLifecycleInterruption as WorkflowCheckpointInterruption,
} from "./workflow-invocation-lifecycle.js";

export * from "./information-fulfillment.js";
export * from "./execution-host.js";
export * from "./workflow-invocation-lifecycle.js";
export * from "./observed-root-registrations.js";
export * from "./observed-root-authority.js";
export * from "./observed-root-execution.js";

export * from "./asset-refresh-selection.js";
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
export * from "./metadata-policy-configuration.js";

export type FileObservation = {
  readonly relativePath: string;
  readonly size: number;
  readonly modifiedAt: string;
  /**
   * Opaque observer evidence. Snapshot-local values can only coalesce aliases
   * within this one immutable snapshot. Durable values additionally require
   * the observer's explicit durable-identity capability before Application
   * may use them as cross-execution Artifact continuity evidence.
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
      /** The independently versioned capability that guarantees continuity. */
      readonly capability: CapabilityCoordinate;
      readonly value: string;
    };

/**
 * The reliability declaration is intentionally separate from individual
 * opaque values. A snapshot cannot elevate its own `durable` claim; only the
 * configured Filesystem Observer may opt in and freezes the capability
 * coordinate before its first I/O.
 */
export type FilesystemObjectIdentityContract =
  | { readonly kind: "snapshot-local" }
  | {
      readonly kind: "durable";
      readonly capability: CapabilityCoordinate;
    };

/**
 * A durable parser result, not a domain or operating-system error.  A
 * diagnostic means the snapshot has incomplete coverage and therefore cannot
 * be used to infer an omitted Location disappeared.
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
    /** A directory entry disappeared after enumeration; healthy siblings remain observed. */
    | "entry-missing"
    /** Permission or a runtime access failure isolated to one entry. */
    | "entry-inaccessible"
    /** lstat/open no longer named the same object, so it was excluded. */
    | "entry-identity-changed";
};

/**
 * A structural observation inside a Filesystem Package Snapshot. The root is
 * represented as `.` so an empty package and a package whose only entry is an
 * empty directory remain distinguishable from an omitted observation.
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
   * Added after the first persisted snapshots. Undefined is a legacy
   * files-only record, not evidence that its package had no directories.
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
  /** Recovery could not safely continue the frozen execution. */
  | "interrupted"
  /** A user explicitly stopped the Workflow Execution. */
  | "cancelled"
  | "no-change";

/**
 * A metadata refresh deliberately carries only facts which an already-current
 * Source Association is allowed to refresh.  It is not another recognition
 * acceptance, so it can never replace an asset identity as a side effect.
 */
export type MetadataRefreshSubmission = {
  readonly assetId: string;
  readonly sourceAssociation: SourceAssociation;
  readonly sourceRecords: readonly SourceRecord[];
  readonly interpretation: SourceInterpretationBatch;
  /** Frozen before interpretation/application; stale collectors may be retained but cannot advance facts. */
  readonly expectedLineageHeads: readonly {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
    readonly coverageId: string;
    readonly sourceRecordId?: string;
  }[];
};

/**
 * Application passes a complete interpreted candidate into the domain-owned
 * Run. SQLite stores the candidate with its Change Set until it is approved,
 * rejected, cancelled, or conditionally appended.
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
 * A delivery-independent candidate for attaching another existing source to
 * one accepted subject. It deliberately carries no asset category or source
 * grammar; the source capability owns both.
 */
export type SourceEnrichmentInput = {
  readonly subjectId: string;
  /** The accepted identity source whose assertions may justify enrichment. */
  readonly recognitionSourceAssociation: SourceAssociation;
  /** Frozen with the association so an identity replacement invalidates both coordinates. */
  readonly recognitionDecisionId: string;
  readonly sourceAssociations: readonly SourceAssociation[];
  readonly metadata: readonly MetadataAssertion[];
  readonly metadataSourceRecords: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
  }[];
  readonly informationRequirement: InformationRequirement;
};

/** Interprets current accepted facts into one exact enrichment-source candidate. */
export type SourceAssociationCandidateInterpreter = {
  readonly capability: CapabilityCoordinate;
  interpret(
    input: SourceEnrichmentInput,
  ): import("@digital/domain").RecognitionEvidence | undefined;
};

/**
 * Validates whether one ordinary source interpretation denotes the already
 * accepted subject. It performs no collection or source-record interpretation.
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

/** The primary recognition association plus every currently applicable source. */
export type AcceptedAssetState = AcceptedRecognition & {
  /** Legacy stores may expose only the recognition association until migrated. */
  readonly sourceAssociations?: readonly SourceAssociation[];
  /**
   * Opaque product-policy enrollments for this explicit subject. Definitions
   * remain composition-owned; persistence stores only durable applicability.
   */
  readonly metadataPolicyIds?: readonly string[];
  /** Current provenance records needed to derive source-labelled values. */
  readonly metadataSourceRecords?: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
  }[];
};

/**
 * The only cross-location reuse coordinate: an observer-declared, opaque
 * filesystem-object identity already projected to deterministic Artifact IDs.
 *
 * This deliberately does not expose pathname, title, Blob digest, or a
 * database-specific query.  More than one current Asset is contradictory
 * durable evidence, so Application must stop rather than choose one.
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
  /** Every value that must still hold when the confirmation is applied. */
  readonly baselines: readonly {
    readonly key: string;
    readonly value: string;
  }[];
  /** Complete applied state at the frozen baseline. */
  readonly current: AssetStateProjection;
  /** Complete state derived by the same application projection after change. */
  readonly projected: AssetStateProjection;
  readonly blockingConditions: readonly string[];
  readonly status: "awaiting-confirmation" | "rejected" | "applied" | "stale";
};

/** Safe delivery DTO; raw proposals and conditional baselines stay internal. */
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

/** Durable recurring configuration; execution state lives in WorkflowExecution. */
export type AutomationDisabledReason =
  | "observed-root-revoked"
  /** A live filesystem binding failed; operator re-enables after repair. */
  | "observed-root-unavailable"
  /** A capability reported an unavailable operational prerequisite. */
  | "prerequisite-unavailable"
  | "invalid-configuration";

/**
 * Transient authorization evidence for the one durable Automation Intent
 * write.  It deliberately contains registration versions only: neither an
 * Automation Intent nor its persistence adapter receives a filesystem path
 * or a bound filesystem capability.
 */
/** @deprecated Use the authority-owned name for new Application adapters. */
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
   * Present only when a product-owned prerequisite disabled the intent.  It
   * deliberately records a stable reason rather than an infrastructure error
   * message so a later Delivery surface can explain the state without
   * inspecting an Observed Root or a database row.
   */
  readonly disabledReason?: AutomationDisabledReason;
  readonly intervalMilliseconds: number;
  readonly workflowInputVersion: "asset-refresh-input/1";
  /** Fixed enablement policy, not a host-lifecycle instruction. */
  readonly runInitial: boolean;
  readonly policyReferences: readonly string[];
  readonly acceptTrusted: boolean;
};

export type AutomationTrigger = "initial" | "interval" | "scan-now";

/** The immutable initiation path for one execution. */
export type WorkflowExecutionTrigger =
  | AutomationTrigger
  | "interactive"
  | "information-fulfillment";

/** Values retained only when reading pre-envelope execution rows. */
export type LegacyWorkflowExecutionTrigger =
  | WorkflowExecutionTrigger
  | "manual"
  | "directed-recognition"
  | "metadata-refresh";

/**
 * The small, non-secret input envelope needed to replay one Asset Refresh
 * safely. It deliberately does not become a generic workflow definition.
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
   * Original non-executable durable input, retained only for inspection and
   * an explicit interrupted audit. A compatibility reader may use this same
   * sanitized barrier for a legacy selection that cannot be safely replayed.
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
 * Runtime validation for the small persisted restart envelope. This is shared
 * by the SQLite reader and Application recovery; TypeScript types alone never
 * make durable JSON safe to replay.
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
  /** Independent capability work-items, not one universal asset cache key. */
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
 * Application-owned answer about whether the opaque non-secret configuration
 * references frozen in one Workflow Execution can still be used to recover
 * it. Concrete configuration registries live at composition boundaries.
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
 * A completed execution may be reused only when every capability it actually
 * froze is still available at the same coordinate. Extra configured
 * capabilities are deliberately irrelevant: they did not participate in the
 * prior execution and must not invalidate it.
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
  /** Application-owned, platform-neutral operational failure classification. */
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
  /** Audit principal for the Source Refresh Run; integrations may supply a user identity. */
  readonly initiatedBy?: string;
  /** Automatic and review-gated runs use the same durable Change Set path. */
  readonly reviewPolicy?: "automatic" | "review";
  readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
  readonly onProgress?: (message: string) => void;
  readonly onCheckpoint?: (execution: WorkflowExecution) => void;
  /** Process-owner lifecycle; never persisted as workflow input. */
  readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
};

/**
 * Internal-only initiation context for a child metadata execution. The
 * persisted Workflow Input remains the recovery authority; this context is
 * only used while creating that child.
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

/** Durable audit state for one independently planned recognition boundary. */
export type AssetRefreshWorkItem = {
  readonly key: string;
  readonly relativePaths: readonly string[];
  /** An explicit package remains one Artifact even when it contains many files. */
  readonly observedArtifactBoundary?: "filesystem-package";
  /** Capability that made the technical boundary decision; not a Domain fact. */
  readonly observedArtifactBoundaryProducer?: CapabilityCoordinate;
  readonly planningEvidence?: readonly import("@digital/domain").RecognitionEvidence[];
  readonly reuseFingerprint?: string;
  /** Actual capability coordinates for this boundary, never the full configuration. */
  readonly reuseCompatibility?: WorkflowCompatibility;
  readonly sourceRecordIds: readonly string[];
  readonly proposalId?: string;
  readonly acceptedAssetId?: string;
  readonly outcome?: AssetRefreshOutcome;
  readonly reason?: string;
  /** Application-owned, platform-neutral operational failure classification. */
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
 * Static, application-owned identity for one deployed narrow capability.
 *
 * `kind` deliberately remains an open stable string: Application owns the
 * Port contracts, but neither Application nor Digital Assets maintains a
 * provider or capability-kind enum.
 */
export type CapabilityDeclaration = {
  readonly identity: string;
  readonly implementationVersion: string;
  readonly kind: string;
  /** Empty only when this capability applies no interpretation contract. */
  readonly interpretationContractVersions: readonly string[];
};

/**
 * The provenance coordinate emitted by a concrete capability together with
 * its complete static declaration. The extra fields survive structural use as
 * a Domain `CapabilityCoordinate`, so derived facts retain the declaration
 * that produced them without introducing an Application dependency in Domain.
 */
export type DeclaredCapability = CapabilityCoordinate & CapabilityDeclaration;

/**
 * Keeps the legacy coordinate spelling and the declaration's terminology in
 * one immutable value. It is a value constructor, not a plugin interface.
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
 * Application-owned evidence producers are deployed capabilities too. Their
 * static values join Composition validation just like integration instances.
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
 * Application owns the execution audit shape it submits through its Ports.
 * This is the exact last-persisted snapshot carried into a conditional
 * recognition acceptance; it deliberately has no infrastructure readback.
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
  /** Legacy checkpoints lack this coordinate and must not be semantically reused. */
  readonly acquisitionReference?: string;
  /** The interpreter that made this candidate available. */
  readonly sourceArtifactProducer?: CapabilityCoordinate;
  /** The acquirer that performed the external effect. */
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
  /** Preserves the acquisition coordinate through managed-store recovery. */
  readonly acquisitionReference?: string;
  readonly sourceArtifactProducer?: CapabilityCoordinate;
  readonly acquisitionProducer?: CapabilityCoordinate;
  readonly blob: Blob;
  readonly location: { readonly address: string };
};

/**
 * Complete durable intent for one accepted post-recognition source
 * enrichment. Recovery consumes this checkpoint directly and never rebuilds
 * it by rerunning recognition or source interpretation.
 */
type SourceEnrichmentCheckpointBase = {
  readonly key: string;
  readonly subjectId: string;
  /** Frozen before collection so recovery never has to rediscover the intent. */
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
  /** Actual observed-part acquirer, frozen before the materialization effect. */
  readonly producer: CapabilityCoordinate;
  readonly blob: Blob;
  readonly location: { readonly address: string };
  readonly origin: Blob;
};

/** Persisted first-slice column names remain an infrastructure compatibility detail. */
export type CoverAcquisitionCheckpoint = SourceArtifactAcquisitionCheckpoint;
export type ManagedCoverCheckpoint = ManagedSourceArtifactCheckpoint;

/** Durable attribution for an explicit Workflow Execution cancellation. */
export type WorkflowExecutionCancellation = {
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly reason?: string;
};

export type WorkflowExecution = {
  readonly id: string;
  /** Missing only on legacy rows, which cannot safely resume. */
  readonly workflowInput?: AssetRefreshWorkflowInput;
  /** A non-executable persisted replay coordinate remains queryable solely so recovery can stop it. */
  readonly workflowInputInvalid?: InvalidAssetRefreshWorkflowInput;
  readonly selection: {
    /** Legacy single-scope input; absent for exact-subject executions. */
    readonly directory?: string;
    readonly intent?: "scan-now" | "metadata-refresh" | "directed-recognition";
    readonly informationRequirement?: InformationRequirement;
  };
  /** Legacy single-scope observation; absent for subject-only executions. */
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
    /** Legacy persisted stage names retained for compatible recovery. */
    | "cover-acquired"
    | "cover-stored"
    | "completed"
    | "failed";
  readonly outcome?: AssetRefreshOutcome;
  readonly sourceRecordIds: readonly string[];
  /** Domain-process references only; their phase, review, and outcome stay in Digital Assets. */
  readonly sourceRefreshRunIds?: readonly string[];
  readonly proposalId?: string;
  readonly acceptedAssetId?: string;
  readonly reason?: string;
  /** Present only when an actor explicitly terminally cancelled this execution. */
  readonly cancellation?: WorkflowExecutionCancellation;
  readonly reusePlan?: OrdinaryScanReusePlan;
  readonly reusedExecutionId?: string;
  readonly compatibility: WorkflowCompatibility;
  readonly dispositions: readonly WorkItemDisposition[];
  /** Explicit work-item audit; legacy single-item columns remain populated for old executions. */
  readonly workItems?: readonly AssetRefreshWorkItem[];
  readonly coverAcquisition?: CoverAcquisitionCheckpoint;
  readonly managedCover?: ManagedCoverCheckpoint;
  readonly sourceArtifactAcquisitions?: readonly SourceArtifactAcquisitionCheckpoint[];
  readonly managedSourceArtifacts?: readonly ManagedSourceArtifactCheckpoint[];
  readonly sourceEnrichments?: readonly SourceEnrichmentCheckpoint[];
  readonly automationIntentId?: string;
  /** Legacy-only trigger column; new executions use workflowInput.trigger. */
  readonly trigger?: string;
};

export type ExecutionInspection = {
  readonly execution: WorkflowExecution;
  readonly sourceRecords: readonly SourceRecord[];
  /** Rebuildable domain projections; Workflow Execution holds only their identities. */
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
 * A compact, delivery-independent audit view of an unresolved filesystem
 * observation. It preserves no media interpretation and is derived directly
 * from the durable Filesystem Package Snapshot.
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

/** Application-owned DTO for every ordinary CLI/Web inspection. */
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
  /** Domain-owned state projected for ordinary refresh inspection. */
  readonly sourceRefreshRuns?: readonly SourceRefreshRun[];
  /** Present only while this execution has no proposed or accepted identity. */
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
    /** Current associations are plural; sourceAssociation remains recognition provenance. */
    readonly sourceAssociations?: readonly {
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
    }[];
    readonly effectiveMetadata: readonly EffectiveMetadata[];
    readonly metadataPolicyConflicts: readonly MetadataPolicyConflict[];
    readonly recognitionExplanation: string;
  };
  /** Independently inspectable outcomes for a multi-boundary execution. */
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
 * A technical parser may recognize a selected filesystem package as the one
 * observed Artifact that serves a directed asset. It never establishes
 * identity or a provider-specific directory convention.
 */
export type FilesystemPackageInterpreter = {
  readonly capability: CapabilityCoordinate;
  interpretPackage(
    snapshot: FilesystemPackageSnapshot,
  ): { readonly observedArtifactBoundary: "filesystem-package" } | undefined;
};

/**
 * A format capability inspects artifacts, while a Directory Interpreter owns
 * the optional package boundary.  Keeping these ports separate prevents a
 * source provider from learning archive syntax and lets CBZ/ID3 follow the
 * same contract later.
 */
export type ArtifactFormatInspector = {
  readonly capability: CapabilityCoordinate;
  inspect(input: {
    /** Opaque observer references; Application never interprets their grammar. */
    readonly observedArtifactReference: string;
    /** Already-opened bytes; inspectors never receive an observed pathname. */
    readonly byteSource: ObservedByteSource;
  }):
    | readonly import("@digital/domain").RecognitionEvidence[]
    | Promise<readonly import("@digital/domain").RecognitionEvidence[]>;
};

/**
 * Explicit independently committable boundaries inside one frozen selection.
 * A plain evidence array remains one boundary: it can represent competing
 * identities and is never split implicitly.
 */
export type AssetRefreshWorkPlan = {
  readonly workItems: readonly AssetRefreshWorkItemPlan[];
};

export type AssetRefreshWorkItemPlan = {
  /** Plugin-owned stable key; Application never interprets its grammar. */
  readonly key: string;
  readonly relativePaths: readonly string[];
  /** Generic packaging instruction; the deciding outer capability owns its grammar. */
  readonly observedArtifactBoundary?: "filesystem-package";
  /** Application-attached provenance of the deployed technical interpreter. */
  readonly observedArtifactBoundaryProducer?: CapabilityCoordinate;
  readonly evidence: readonly import("@digital/domain").RecognitionEvidence[];
};

/** A repairable prerequisite is unavailable now; adapters never name platforms here. */
export type OperationalFailureClassification = {
  readonly kind: "prerequisite-unavailable";
};

export const prerequisiteUnavailableFailure = {
  kind: "prerequisite-unavailable",
} as const satisfies OperationalFailureClassification;

export type SourceCollectionFailure = {
  readonly capability: CapabilityCoordinate;
  readonly reason: string;
  /** Typed operational classification; never inferred from a diagnostic string. */
  readonly failureClassification?: OperationalFailureClassification;
  /**
   * Optional exact Source Refresh coverage that this response could not
   * acquire.  The coordinator validates it against the collector's declared
   * scope before it can affect a durable Run.
   */
  readonly coverage?: SourceCoverageScope;
  /**
   * Neutral information made unavailable by this response. Application, not
   * the provider, decides whether the current Information Requirement makes
   * the failure blocking. Omission retains the existing atomic-contract
   * meaning and blocks recognition.
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
 * The non-secret configuration coordinates frozen for one collector call.
 * A collector may use them only through its capability-specific private
 * handle; neither Application nor a Workflow Execution carries credentials.
 */
export type SourceCollectionExecutionContext = {
  readonly configurationReferences: readonly string[];
};

/**
 * Application asks this narrow outer Port to bind only a collector that is
 * actually about to participate.  This keeps unrelated Source Connections
 * out of an execution's reproducibility envelope while allowing the owning
 * capability to resolve its private secret from an opaque version reference.
 */
export type SourceConnectionExecutionConfiguration = {
  bindCollector(input: {
    readonly collector: CapabilityCoordinate;
    /**
     * Opaque recognition evidence for the collector invocation being bound.
     * Application does not interpret it: an outer adapter may use it to select
     * a capability-scoped private connection without leaking provider rules
     * into the workflow core.
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
   * Declares the exact lineage scopes a collection attempt may advance.
   * This is evaluated before transport so concurrent responses cannot rebase.
   */
  coverageScopeIds?(
    evidence: import("@digital/domain").RecognitionEvidence,
  ): readonly string[];
  /**
   * Optional execution-local request scope. Unlike coverage lineage this says
   * that identical planned boundaries may share one acquisition result.
   */
  collectionScopeIds?(
    evidence: import("@digital/domain").RecognitionEvidence,
  ): readonly string[];
  /**
   * Optional single acquisition for all evidence in one declared execution
   * scope. It remains a collector-owned operation and returns ordinary,
   * independently bounded Source Records.
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
 * A Port owns the actual implementation that produced a fact.  It may not
 * let a response substitute a neighbouring capability's coordinate: doing so
 * would make retained provenance describe an implementation which never ran.
 *
 * The semantic declaration fields are intentionally preserved on the Port's
 * coordinate, but comparison starts with the durable legacy triple so old
 * facts remain readable.
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
 * Evidence is an immutable fact produced by the Port that just executed, not
 * an adapter-controlled claim about some neighbouring capability.  Keep this
 * deliberately at the three evidence-producing Port boundaries instead of
 * introducing a universal capability-result pipeline.
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
 * A Recognizer has only a small draft surface. The workflow snapshots and
 * freezes the bound inputs before calling it, then reconstructs the full
 * proposal from those inputs. This prevents a trusted rule from laundering
 * itself into a Source Interpreter or Artifact Format Inspector.
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

/** Extracts a bounded Part from an observed Artifact only after it is requested. */
export type ObservedArtifactPartAcquirer = {
  readonly capability: CapabilityCoordinate;
  canAcquire(candidate: ObservedArtifactPartCandidate): boolean;
  acquire(input: {
    readonly candidate: ObservedArtifactPartCandidate;
    /** Already-opened bytes; an acquirer cannot reopen arbitrary locations. */
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
  /** Set by Application from the acquirer that actually performed acquisition. */
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
  /** Durable staging lets resume avoid repeating an acquired external effect. */
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

/** Deliberately use-case-specific persistence Port, never a generic repository. */
type CataloguePersistenceOperations = {
  /** Atomically leases one resumable execution before any external effect. */
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
   * Automation executions are inserted together with their single-active
   * claim. Interactive executions always return `started`.
   */
  createExecution(
    execution: WorkflowExecution,
    requestedAt?: string,
  ): Promise<ExecutionStartDisposition>;
  /** One formal retained-record checkpoint with a complete execution CAS. */
  retainSourceRecords(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly sourceRecords: readonly SourceRecord[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  finishExecution(
    /** Complete frozen audit observed before the caller prepares `execution`. */
    expectedExecution: WorkflowExecution,
    execution: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void>;
  /**
   * An explicit cancellation is its own terminal transition. It deliberately
   * does not require a resume claim: it must be able to stop an active worker.
   */
  cancelExecution(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
  }): Promise<void>;
  finishExecutionWithProposal(
    /** Complete frozen audit observed before the caller prepares `execution`. */
    expectedExecution: WorkflowExecution,
    execution: WorkflowExecution,
    proposal: RecognitionProposal,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void>;
  finishExecutionWithChangeImpactPreview(input: {
    /** Complete frozen audit observed before the caller prepares `execution`. */
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly proposal: RecognitionProposal;
    readonly preview: ChangeImpactPreview;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  acceptRecognition(input: {
    /** Complete running audit observed by the caller before it prepares acceptance. */
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly accepted: AcceptedRecognition;
    readonly metadataPolicyIds?: readonly string[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  inspectExecution(
    executionId: string,
  ): Promise<ExecutionInspection | undefined>;
  /** Delivery may browse durable outcomes without receiving the catalogue implementation. */
  /** Complete history in newest-first durable creation order. */
  listExecutions(): Promise<readonly WorkflowExecution[]>;
  /** Startup recovery deliberately spans every non-terminal execution. */
  listRunningExecutions(): Promise<readonly WorkflowExecution[]>;
  /** Reuse is an ordinary-scan policy over frozen inputs, never an asset cache. */
  findReusableOrdinaryScan(input: {
    readonly plan: OrdinaryScanReusePlan;
    /** Current deployment coordinates only verify a prior frozen set. */
    readonly availableCompatibility: WorkflowCompatibility;
  }): Promise<WorkflowExecution | undefined>;
  /** SQLite implements this conditionally; terminal records never reopen. */
  transitionExecution(
    /** Complete frozen audit observed before the caller prepares `next`. */
    expected: WorkflowExecution,
    next: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void>;
  inspectRawSourceRecord(
    executionId: string,
    sourceRecordId: string,
  ): Promise<SourceRecord | undefined>;
  /** Resolves an accepted scope without parsing its directory or source key. */
  findAcceptedForDirectory(directory: string): Promise<
    | {
        readonly accepted: AcceptedAssetState;
        readonly execution: WorkflowExecution;
      }
    | undefined
  >;
  /** Loads only the exact current accepted subjects requested by the caller. */
  findAcceptedForSubjects(subjectIds: readonly string[]): Promise<
    readonly {
      readonly subjectId: string;
      readonly accepted: AcceptedAssetState;
      readonly execution: WorkflowExecution;
    }[]
  >;
  /**
   * Looks up only exact current observed-material associations. Callers pass
   * deterministic Artifact IDs derived from reliable observer evidence; this
   * port must never fall back to path, title, timestamp, or Blob matching.
   */
  findCurrentAcceptedForObservedArtifacts(input: {
    readonly artifactIds: readonly string[];
  }): Promise<ObservedArtifactReuseMatch>;
  /** Reuse remains scoped to one stable observed boundary, never a whole root. */
  findReusableWorkItem(input: {
    readonly directory: string;
    readonly relativePaths: readonly string[];
    /** Current deployment coordinates only verify a prior frozen set. */
    readonly availableCompatibility: WorkflowCompatibility;
    readonly reuseFingerprint: string;
  }): Promise<
    | {
        readonly execution: WorkflowExecution;
        readonly accepted: AcceptedAssetState;
        /** Complete actual dependency closure of the matched durable item. */
        readonly reuseCompatibility: WorkflowCompatibility;
      }
    | undefined
  >;
  /** Finds the current accepted identity for one exact explicit boundary. */
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
   * Re-evaluating an unchanged accepted identity advances applicable facts
   * without minting another Digital Asset, Source Association, or Decision.
   */
  refreshAcceptedRecognition(input: {
    /** Complete running audit observed before the reevaluation commit. */
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly current: AcceptedRecognition;
    readonly accepted: AcceptedRecognition;
    readonly sourceRecords: readonly SourceRecord[];
    readonly expectedLineageHeads: MetadataRefreshSubmission["expectedLineageHeads"];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;
  /** Atomically advances only the known association's scoped source facts. */
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
  /** Opaque exact baseline over current lineage and projected fact heads. */
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
   * Atomically proves the preflight's registered-root closure is still active
   * before persisting the recurring configuration and its runtime row.
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
 * Cursor input for the authoritative Current Catalogue projection.  The
 * cursor is deliberately opaque to Delivery: only the query that issued it
 * may interpret it on a later request.
 */
export type CurrentCataloguePageRequest = {
  readonly limit?: number;
  readonly cursor?: string;
};

/**
 * Persistence-side page before Application removes provenance that Delivery
 * must not receive.  It is deliberately distinct from Workflow History and
 * Current Attention pages even though all three use opaque cursors.
 */
export type CurrentCataloguePersistencePage = {
  readonly items: readonly AcceptedAssetState[];
  readonly nextCursor?: string;
};

/** Delivery-safe Current Catalogue page. */
export type CurrentCataloguePage = {
  readonly items: readonly NonNullable<AssetRefreshInspection["accepted"]>[];
  readonly nextCursor?: string;
};

/**
 * A purpose-shaped Current Catalogue read.  It returns accepted domain facts
 * only; table rows, Drizzle models, and a database handle remain inside the
 * infrastructure adapter.
 */
export type CurrentCatalogueQueries = {
  listCurrentCataloguePage(
    input?: CurrentCataloguePageRequest,
  ): Promise<CurrentCataloguePersistencePage>;
  /** @deprecated Delivery uses the bounded page contract above. */
  listCurrentCatalogue(): Promise<readonly AcceptedAssetState[]>;
};

/** Cursor input for permanent Workflow History. */
export type WorkflowHistoryPageRequest = {
  readonly limit?: number;
  readonly cursor?: string;
};

/**
 * Adapter-side history page. The embedded inspection is a structured audit
 * record, not a current-catalogue reconstruction.
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

/** Immutable execution result records; never a reconstruction from current heads. */
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

/** Delivery-safe permanent Workflow History page. */
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

/** Cursor input for current, rebuildable attention conditions only. */
export type CurrentAttentionPageRequest = {
  readonly limit?: number;
  readonly cursor?: string;
};

/**
 * One present-tense condition which is actionable now. This intentionally
 * excludes generic terminal failure and proposals already resolved through a
 * Recognition Decision or Change Impact Preview.
 */
export type CurrentAttentionItem = {
  readonly id: string;
  readonly kind:
    | "recognition-review"
    | "change-impact-review"
    | "source-refresh-review"
    | "prerequisite-unavailable";
  /** Absent when root preflight failed before any execution could be created. */
  readonly executionId?: string;
  /** Absent for an initial Recognition Proposal that has no accepted subject yet. */
  readonly assetId?: string;
  readonly summary: string;
  readonly recognitionProposalId?: string;
  readonly changeImpactPreviewId?: string;
  readonly sourceRefreshChangeSetId?: string;
  /** Present only for a disabled automatic intent with repairable prerequisite work. */
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
 * The exact current facts that can satisfy an Information Requirement for one
 * selected subject. This deliberately excludes a hydrated related-entity
 * graph: callers receive no fact whose association subject differs from the
 * selected subject, and artifact availability starts with managed locations
 * only.
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
    /** Present only for a managed source artifact tied to one association. */
    readonly sourceAssociationId?: string;
    /** False when that managed source artifact no longer matches a current head. */
    readonly currentSourceArtifact?: boolean;
    /** Observed locations are intentionally absent from this availability input. */
    readonly managedLocations: readonly { readonly address: string }[];
  }[];
};

/**
 * An outer composition rebuilds a complete neutral Information Requirement
 * after one accepted subject is available. Application invokes this boundary
 * without learning the View, provider, route, or component that selected it.
 */
export type AutomationInformationRequirementResolver = (
  accepted: NonNullable<AssetRefreshInspection["accepted"]>,
) => InformationRequirement;

/** A narrow query Port used only to rebuild current fulfillment readiness. */
export type InformationSubjectFactsQueries = {
  readCurrentInformationSubjectFacts(input: {
    readonly subjectIds: readonly string[];
  }): Promise<readonly CurrentInformationSubjectFacts[]>;
};

/**
 * The exact current interpretation lineage from which Application may select
 * source artifacts for an already-recognized subject. It intentionally does
 * not expose a Recognition Proposal: recognition history is not an artifact
 * candidate cache.
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
    /** Complete provenance of the current durable source interpretation. */
    readonly interpretationSourceRecordIds: readonly string[];
    readonly sourceRecords: readonly SourceRecord[];
  }[];
};

/** A narrow read Port over current Source Refresh interpretation lineage. */
export type CurrentSourceArtifactQueries = {
  readCurrentSourceArtifactFacts(input: {
    readonly subjectId: string;
    readonly sourceIdentity: string;
    /** Selects the exact current association chosen during readiness planning. */
    readonly sourceAssociationId?: string;
  }): Promise<CurrentSourceArtifactFacts | undefined>;
};

/**
 * Identity-preserving commit boundary for bytes already acquired into the
 * managed store. It accepts ordinary Blob/Artifact/Location/Association facts
 * and never accepts a Recognition Proposal or Decision.
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
 * Narrow persistence boundary for the domain-owned Source Refresh Run. It
 * deliberately exposes no Workflow Execution state transitions: execution
 * only retains an ID reference while this Port owns refresh lifecycle truth.
 */
export type SourceRefreshRunPersistence = {
  createSourceRefreshRun(
    input: CreateSourceRefreshRunInputForExecution,
  ): Promise<SourceRefreshRun>;
  /** Persists the per-scope checkpoint immediately before external collection. */
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
 * Recovery owns a short-lived Workflow Execution lease, while a public
 * cancellation is an independently authorized Domain operation. Keep their
 * command surfaces separate so a recovery owner cannot accidentally use the
 * public cancellation authority after it has lost its lease.
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
   * Retains a completed collection and advances its durable intent in one
   * commit. Recovery therefore never has to repeat an already-retained
   * provider request.
   */
  checkpointSourceEnrichmentRecords(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly sourceRecords: readonly SourceRecord[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void>;

  /**
   * Commits the interpreted facts and the `applied` checkpoint atomically.
   * A process exit can leave the execution running, but never ambiguously
   * between domain application and its durable effect marker.
   */
  applySourceEnrichment(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    /** Both coordinates must still be the subject's recognition head at commit. */
    readonly expectedRecognitionBaseline: {
      readonly sourceAssociationId: string;
      readonly recognitionDecisionId: string;
    };
    readonly assetId: string;
    readonly sourceAssociation: SourceAssociation;
    readonly sourceRecords: readonly SourceRecord[];
    readonly interpretation: SourceInterpretationBatch;
    /**
     * Requested source artifacts acquired from this same interpretation.
     * The adapter commits them with the new association and assertions.
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
  /** Every filesystem execution is bound through this registered authority. */
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
  /** Format inspection is per observed Artifact, not a directory convention. */
  readonly formatInspectors?: readonly ArtifactFormatInspector[];
  readonly collectors: readonly SourceCollector[];
  readonly sourceInterpreters: readonly SourceInterpreter[];
  /** Optional until a product deliberately configures a source enrichment. */
  readonly sourceAssociationCandidateInterpreters?: readonly SourceAssociationCandidateInterpreter[];
  readonly sourceAssociationInterpreters?: readonly SourceAssociationInterpreter[];
  /**
   * Optional while no product-managed private Source Connection participates.
   * It owns opaque configuration-version binding and never exposes a secret
   * or a provider-specific credential shape to Application.
   */
  readonly sourceConnectionExecutionConfiguration?: SourceConnectionExecutionConfiguration;
  readonly metadataPolicyConfiguration?: MetadataPolicyConfiguration;
  /**
   * Consulted only while recovering frozen opaque configuration references;
   * configuration identities and version storage remain outside Application.
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
  /** Optional while test/legacy composition still exposes history only. */
  readonly currentCatalogueQueries?: CurrentCatalogueQueries;
  /** Optional while test/legacy composition still exposes whole history only. */
  readonly workflowHistoryQueries?: WorkflowHistoryQueries;
  /** Optional while test/legacy composition has no rebuildable attention authority. */
  readonly currentAttentionQueries?: CurrentAttentionQueries;
  readonly recognitionAcceptance: RecognitionAcceptancePersistence;
  readonly recognitionReevaluation: RecognitionReevaluationPersistence;
  readonly recognitionChangeImpact: RecognitionChangeImpactPersistence;
  readonly metadataRefreshPersistence: MetadataRefreshPersistence;
  /** Production reads only exact current facts for fulfillment readiness. */
  readonly informationSubjectFactsQueries?: InformationSubjectFactsQueries;
  /** Production reads only current durable source-artifact interpretations. */
  readonly currentSourceArtifactQueries?: CurrentSourceArtifactQueries;
  /** Production submits managed source artifacts without reevaluating identity. */
  readonly managedSourceArtifactPersistence?: ManagedSourceArtifactPersistence;
  /** Optional only for legacy/test composition; production uses this authority. */
  readonly sourceRefreshRuns?: SourceRefreshRunPersistence;
  /**
   * Recovery-only companion to the Domain Run authority. Its command carries
   * the Workflow Execution lease condition and must never be substituted by
   * the user-facing Domain cancellation command.
   */
  readonly recoverySourceRefreshRuns?: RecoverySourceRefreshRunCommands;
  readonly sourceEnrichmentPersistence?: SourceEnrichmentPersistence;
  readonly changeImpactQueries: ChangeImpactQueries;
  readonly changeImpactCommands: ChangeImpactCommands;
  /** Neutral declarations used only to plan demand-driven information work. */
  readonly informationFulfillmentCapabilities?: readonly InformationFulfillmentCapability[];
  /** One process owner supervises fulfillment children and runtime shutdown. */
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
  readonly onCheckpoint?: () => void;
  /** A durable, unexpired owner claim keeps this execution waiting for retry. */
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
 * Process-lifecycle host for recurring Automation Intents. It owns only timer
 * and overlap mechanics; due decisions and executions remain in the workflow.
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
   * Startup admission opens after every retained execution is classified.
   * A waiting claim remains supervised and suppresses duplicate recovery, but
   * does not make the entire catalogue unready.
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
      // A startup classification failure has not admitted a timer. Leave the
      // Host retryable rather than poisoning its `started` latch forever.
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

  /** Waits for an already-started poll; it never starts a new one. */
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

/** Mirrors the durable Source Record retention checkpoint in local workflow state. */
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
    targetDispositions: execution.targetDispositions?.map((target) =>
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
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** A terminal Source Refresh diagnostic is still Domain-owned evidence. */
function sourceRefreshTerminalReason(
  runs: readonly SourceRefreshRun[],
): string | undefined {
  return runs
    .flatMap((run) => run.scopes)
    .find((scope) => scope.state === "terminal" && scope.reason !== undefined)
    ?.reason;
}

/**
 * A Source Refresh Change Set has one candidate record and one coverage
 * boundary. Split a multi-record interpreter result only at contributions
 * whose provenance is wholly owned by that exact record; mixed evidence is
 * never silently rewritten into an invented one-record assertion.
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
    targetDispositions: execution.targetDispositions?.map((target) =>
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
  };
}

/** Serializes only the stable execution coordinate, never a Port instance. */
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
    targetDispositions: execution.targetDispositions?.map((item) =>
      item.key === key
        ? {
            ...item,
            status,
            ...(reason === undefined ? {} : { reason }),
            ...(sourceRecordIds === undefined ? {} : { sourceRecordIds }),
            ...(outputReferences === undefined ? {} : { outputReferences }),
          }
        : item,
    ),
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
    entities: accepted.entities,
    entityMentions: accepted.entityMentions,
    entityResolutionDecisions: accepted.entityResolutionDecisions,
    relationships: accepted.relationships,
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
    ...(publicAccepted(
      accepted,
      inspection.sourceRecords,
      metadataUsageContext,
      configuration,
    ) === undefined
      ? {}
      : {
          accepted: publicAccepted(
            accepted,
            inspection.sourceRecords,
            metadataUsageContext,
            configuration,
          ),
        }),
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
   * The one delivery-independent fulfillment seam used by interactive and
   * automatic callers. Its readiness is rebuilt from accepted catalogue facts;
   * planned effects stay inside the existing durable Asset Refresh workflow.
   */
  fulfillInformation(input: {
    readonly selection: InformationSubjectSelection;
    readonly requirement: InformationRequirement;
    /** Application-internal provenance from an accepted parent execution. */
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
   * Prevents further fulfillment starts. The injected invocation supervisor
   * owns settlement and is drained by the outer composition first.
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
   * A fulfillment-ready artifact must have at least one managed location.
   * An observed path establishes local provenance, not durable delivery bytes.
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
   * A readiness reference is only pending while its durable execution (and
   * any Domain-owned Source Refresh Run it coordinates) is non-terminal.
   * Once terminal, preserve a stable unavailable/blocked result instead of
   * allowing ordinary delivery polling to replay the same source request.
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
   * Current source lineage can change an artifact candidate even when its
   * metadata Change Set is otherwise unchanged. Only a terminal successful
   * Source Refresh therefore invalidates a prior terminal artifact memo; a
   * page refresh alone never becomes an implicit retry.
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
      targetDispositions: execution.targetDispositions?.map((target) => ({
        ...target,
        status: "completed" as const,
      })),
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
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
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
      targetDispositions: execution.targetDispositions?.map((target) => ({
        ...target,
        status: "completed" as const,
      })),
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

  /** Production filesystem scan boundary: callers never supply a server path. */
  async scanObservedScope(input: {
    readonly registrationId: string;
    readonly relativeScope: string;
    readonly acceptTrusted: boolean;
    readonly informationRequirement?: InformationRequirement;
    readonly executionId?: string;
    readonly automationIntentId?: string;
    readonly trigger?: WorkflowExecutionTrigger;
    readonly initiatedBy?: string;
    readonly configurationReferences?: readonly string[];
    readonly requestedAt?: string;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
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
   * Resolves the current server-owned refresh coordinates for one exact
   * subject. Delivery callers must not reconstruct these from catalogue trees
   * or accept a client-provided current source association.
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
   * Reads the delivery-safe current facts for one exact accepted subject.
   * This is intentionally not implemented by browsing Workflow History.
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
        // Metadata Refresh never makes a Recognition Decision. Source Refresh
        // Run review policy belongs to the Domain process it references.
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
        // A reviewer or cancellation request may have terminally coordinated
        // this same execution while a collector was still in flight.  The
        // authoritative Run disposition owns that outcome, so this stale
        // coordinator must return it rather than attempt another transition.
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
          // The Domain-owned Run is the only authority while a Change Set is
          // awaiting review.  Keep this execution running at its durable
          // application checkpoint; it will be coordinated again after the
          // disposition makes every referenced Run terminal.
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
   * An explicitly configured, post-recognition enrichment run. It creates no
   * recognition decision and treats each source result independently. Calling
   * this from ordinary metadata refresh keeps enrichment on the same product
   * path rather than adding a provider-specific CLI operation.
   */
  private async enrichAcceptedSubjectsInExecution(input: {
    readonly execution: WorkflowExecution;
    readonly selection: ResolvedAssetRefreshSelection;
    readonly informationRequirement: InformationRequirement;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
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
        // A later configured enrichment may already be inside an external
        // effect when this process exits. Persist this ordinary failure before
        // continuing so recovery never treats it as an unattempted candidate.
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
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
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

  /** Internal coordinator owned only by the filesystem entrypoints. */
  private async runFilesystemRecognition(input: {
    readonly scope: BoundObservedScope;
    readonly acceptTrusted: boolean;
    readonly informationRequirement?: InformationRequirement;
    readonly intent?: "scan-now" | "metadata-refresh";
    readonly directedSourceAddress?: string;
    readonly directedSourceIdentity?: string;
    readonly executionId?: string;
    readonly automationIntentId?: string;
    readonly trigger?: WorkflowExecutionTrigger;
    readonly initiatedBy?: string;
    readonly configurationReferences?: readonly string[];
    readonly requestedAt?: string;
    readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
    readonly operationKind: WorkflowExecution["operationKind"];
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
    const directory = input.resolvedSelection.filesystemScopes[0].root;
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
         * A format inspector establishes facts about one Artifact, not every
         * Location of that Artifact. A reliable observer may prove that
         * several locators are one filesystem object, so inspect one stable
         * representative while retaining every alias in the same boundary.
         * This avoids duplicate Assets/Revisions and avoids pretending that
         * duplicate alias evidence is independent source evidence.
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
            return {
              representative: ordered[0],
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
    const plannedWorkItems =
      input.intent === "metadata-refresh"
        ? []
        : input.directedSourceAddress === undefined
          ? planRecognitionWorkItems(snapshot, interpretations)
          : [
              {
                key: "directed-recognition",
                relativePaths: snapshot.files.map((file) => file.relativePath),
                ...(packageBoundary === undefined ? {} : packageBoundary),
                evidence: [
                  {
                    kind: "directed-source-address",
                    sourceIdentity: input.directedSourceIdentity,
                    sourceAddress: input.directedSourceAddress,
                    explanation: "用户指定精确来源地址",
                    producer: directedRecognitionEvidenceCapability,
                  },
                ],
              },
            ];
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
          reason:
            collectionFailures.length > 0
              ? blockingCollectionFailures.length > 0
                ? "当前信息需求所需的官方来源工作项未完成"
                : partialCollectionReason(collectionFailures)
              : undefined,
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
      const proposal = proposals[0];
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
      // Reuse may have missed solely because a capability or requested
      // information coordinate advanced. Only a changed ordinary observation
      // or evidence baseline turns an otherwise stable identity into a
      // reevaluation; directed recognition retains its own no-change path.
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
          storedExecution = {
            ...acquiredExecution,
            stage: "source-artifacts-stored",
            managedSourceArtifacts: storedArtifacts,
            dispositions: acquiredExecution.dispositions.map((item) =>
              item.key.startsWith("source-artifact.store:")
                ? {
                    ...item,
                    status: "completed" as const,
                    effectReference: storedArtifacts.find(
                      (artifact) =>
                        item.key === `source-artifact.store:${artifact.role}`,
                    )?.location.address,
                  }
                : item,
            ),
          };
          await this.transition(acquiredExecution, storedExecution);
          notifyDurableCheckpoint(input, storedExecution);
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
        objectIdentityContract:
          this.ports.observedRootRegistrations.objectIdentityContract,
        ...(currentAccepted === undefined ? {} : { current: currentAccepted }),
      });
      // Acceptance establishes the immutable recognition identity, but this
      // parent execution deliberately remains running while configured
      // optional sources supplement it.  A supplement is never a second
      // metadata-refresh execution.
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
      // A conditional commit may have succeeded even if a later inspection
      // failed.  Never rewrite that accepted history as a failure.
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
      /** The same descriptor-bound authority that produced `initial`. */
      readonly scope?: BoundObservedScope;
      readonly acceptTrusted: boolean;
      readonly informationRequirement?: InformationRequirement;
      readonly onProgress?: (message: string) => void;
      readonly onCheckpoint?: (execution: WorkflowExecution) => void;
      readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
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
    /** A source-declared artifact for one exact resolved Entity is one fact. */
    const committedSharedArtifactServeKeys = new Set<string>();
    /**
     * One execution may plan several boundaries that depend on the same
     * declared source scope.  Sharing is deliberately limited to this frozen
     * execution: it avoids repeated external reads without becoming a stale
     * cross-execution collector cache or a provider-specific workflow branch.
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
      const item = durable.workItems?.find(
        (candidate) => candidate.key === key,
      );
      if (item === undefined)
        throw new Error(`Unknown recognition work item ${key}`);
      const next = {
        ...this.retainCapabilityParticipation(durable, [capability]),
        workItems: durable.workItems?.map((candidate) =>
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
          // A no-change execution derives its result from the reused item,
          // so it must retain that item's complete actual dependency closure.
          // Otherwise it becomes a newer but weaker candidate which can hide
          // an upgrade of collector/interpreter/recognizer/acquirer work.
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
        const proposal = proposals[0];
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
                resumeClaim,
              },
            );
            notifyDurableCheckpoint(input, execution, false);
            continue;
          }
        }
        // A trusted explicit work item may checkpoint effects, but it must
        // not commit its Recognition Proposal before the same transaction can
        // commit the Recognition Decision and all accepted facts. Recovery
        // rederives the proposal from its retained Source Records instead.
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
          execution = checkpointWorkItem(execution, plan.key, {
            sourceRecordIds: recordIds,
            proposalId: proposal.id,
            sourceArtifactAcquisitions: execution.workItems?.find(
              (item) => item.key === plan.key,
            )?.sourceArtifactAcquisitions,
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
          objectIdentityContract:
            this.ports.observedRootRegistrations.objectIdentityContract,
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
      // Checkpoint callbacks model process interruption and intentionally
      // leave a resumable execution. Candidate planning is an ordinary port
      // failure, so it must instead terminally record the latest durable form.
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
   * Cross-root reuse is allowed only when every observed file is backed by
   * the observer's reliable opaque object-identity contract.  The persistence
   * port resolves those deterministic Artifact IDs through current material
   * associations; it has no license to infer continuity from names or bytes.
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
   * Work-item recognition remains deliberately explicit about its nested
   * interpreter/recognizer semantics, while callers supply the durable
   * checkpoint that must precede each concrete invocation.
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

  /** Identifies only the acquirers selected for concrete requested candidates. */
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
   * Explicitly stop one running Workflow Execution. Source Refresh Run owns
   * its uncommitted scopes, so cancel those first without projecting their
   * domain outcome back through the public Source Refresh Run coordinator.
   * Durable records already committed by either process remain history.
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

    // Source Refresh cancellation is separately durable. Re-read the complete
    // Workflow Execution audit before its terminal CAS, so a late worker can
    // win neither this cancellation nor any subsequent formal commit.
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
   * Delivery-safe permanent Workflow History query. The adapter first chooses
   * a bounded audit page, then hydrates each selected structured record; it
   * never rebuilds the page from all executions in Application.
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

  /**
   * Compatibility-only complete history query. New Delivery callers use the
   * bounded page contract above.
   */
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
   * Current Catalogue remains distinct from Workflow History. It projects one
   * authoritative, bounded accepted-subject page through Application, never
   * an ORM row or persistence handle.
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
   * Rebuildable present-tense review conditions. Ordinary terminal audit
   * outcomes alone are intentionally not inferred as Attention.
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

  /** Compatibility-only complete Current Catalogue projection. */
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
   * Refreshing follows an accepted association, never directory recognition.
   * The neutral association evidence is intentionally produced here rather
   * than asking an integration to search or reinterpret a filesystem name.
   */
  private async refreshKnownAssociation(
    initial: WorkflowExecution,
    input: {
      readonly directory: string;
      readonly onProgress?: (message: string) => void;
      readonly onCheckpoint?: (execution: WorkflowExecution) => void;
      readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
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
      readonly onProgress?: (message: string) => void;
      readonly informationRequirement?: InformationRequirement;
      readonly initiatedBy?: string;
      readonly reviewPolicy?: "automatic" | "review";
      readonly onCheckpoint?: (execution: WorkflowExecution) => void;
      readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
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
    const evidence: import("@digital/domain").RecognitionEvidence[] = [
      {
        kind: "source-association",
        sourceIdentity: sourceAssociation.sourceIdentity,
        sourceAddress: sourceAssociation.nativeAddress,
        explanation: "使用当前来源关联重新获取元数据",
        producer: knownSourceAssociationEvidenceCapability,
      },
    ];
    let expectedLineageHeads: MetadataRefreshSubmission["expectedLineageHeads"];
    const applicableCollectors = this.ports.collectors.filter((candidate) =>
      candidate.canCollect(evidence[0]),
    );
    try {
      const coverageIds = [
        ...new Set(
          applicableCollectors.flatMap((collector) => {
            if (collector.coverageScopeIds === undefined) {
              throw new Error("来源采集器未声明刷新覆盖范围");
            }
            return collector.coverageScopeIds(evidence[0]);
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
      const interpretation = interpretations[0];
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
   * Production refreshes keep the Workflow Execution at the coordination
   * boundary.  Source Refresh Run owns the per-coverage candidate, review,
   * compare-and-append, and terminal result.
   */
  private async refreshAcceptedAssociationThroughSourceRefreshRun(
    initial: WorkflowExecution,
    existing: {
      readonly accepted: AcceptedAssetState;
      readonly execution: WorkflowExecution;
    },
    input: {
      readonly onProgress?: (message: string) => void;
      readonly informationRequirement?: InformationRequirement;
      readonly initiatedBy?: string;
      readonly reviewPolicy?: "automatic" | "review";
      readonly onCheckpoint?: (execution: WorkflowExecution) => void;
      readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
    },
    targetKey: string | undefined,
    sourceAssociation: SourceAssociation,
  ): Promise<AssetRefreshInspection> {
    const authority = this.ports.sourceRefreshRuns;
    if (authority === undefined) {
      throw new Error("Source Refresh Run authority is not configured");
    }
    const evidence: readonly RecognitionEvidence[] = [
      {
        kind: "source-association",
        sourceIdentity: sourceAssociation.sourceIdentity,
        sourceAddress: sourceAssociation.nativeAddress,
        explanation: "使用当前来源关联重新获取元数据",
        producer: knownSourceAssociationEvidenceCapability,
      },
    ];
    const applicableCollectors = this.ports.collectors.filter((collector) =>
      collector.canCollect(evidence[0]),
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
        const declaredCoverageIds = collector.coverageScopeIds(evidence[0]);
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
      // Legacy/unscoped failure diagnostics are intentionally conservative:
      // a returned record proves that its exact declared scope succeeded, so
      // the diagnostic can only close the collector's still-unmet scopes.
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
        // This follows the source-run acquisition checkpoint and precedes the
        // external request, so recovery records the real collector without
        // freezing any merely configured sibling.
        const beforeConnectionBinding =
          await this.ports.executionQueries.inspectExecution(initial.id);
        if (beforeConnectionBinding === undefined)
          throw new Error("刷新记录在提交后不可读取");
        await this.bindCollectorConfiguration(
          beforeConnectionBinding.execution,
          item.collector,
          evidence[0],
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
            evidence[0],
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
        const interpretation = interpretations[0];
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
   * A Change Set disposition changes Domain-owned Run state first.  Once all
   * runs referenced by its still-running metadata-refresh execution are
   * terminal, this coordinator projects the actual Application outcome.  It
   * never writes a provisional domain outcome into Workflow Execution.
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

  /** Approves/rejects one whole Change Set, then conditionally appends only an approval. */
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

  /** Cancels only uncommitted Source Refresh scopes; committed siblings remain history. */
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

  /** Confirmation is intentionally separate from acquisition and previewing. */
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
    const projectedArtifacts = projected.artifacts.map((artifact, index) => ({
      artifact,
      location: projected.locations[index],
      blob: projected.blobs[index],
      revision: projected.revisions[index],
      association: projected.associations[index],
    }));
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
          ...(projectedArtifacts.find(
            (item) => item.association.role === "asset.primary-cover",
          ) === undefined
            ? {}
            : {
                primaryCoverArtifactId: projectedArtifacts.find(
                  (item) => item.association.role === "asset.primary-cover",
                )!.artifact.id,
              }),
        },
        blockingConditions,
        status: "awaiting-confirmation",
      },
    };
  }

  /** Continues the same compatible non-terminal execution; this is not retry. */
  async resume(input: {
    readonly executionId: string;
    readonly onProgress?: (message: string) => void;
    readonly onCheckpoint?: (execution: WorkflowExecution) => void;
    readonly onHostCheckpoint?: (execution: WorkflowExecution) => void;
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
        // Binding is the last authority check before recovery work. A frozen
        // logical Location is never reopened as a substitute for this step.
        interruptionReason = errorMessage(error);
      }
    }
    // ADR-0072 only permits a Domain-owned review wait after the frozen
    // execution has proved decodable and compatible. An incompatible waiting
    // Run must be explicitly closed/interrupted rather than left running.
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
        const proposal = proposals[0];
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
                      item.key.startsWith("source-artifact.store:")
                        ? {
                            ...item,
                            status: "completed" as const,
                            effectReference: storedArtifacts.find(
                              (artifact) =>
                                item.key ===
                                `source-artifact.store:${artifact.role}`,
                            )?.location.address,
                          }
                        : item,
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
                    item.key.startsWith("source-artifact.store:")
                      ? {
                          ...item,
                          status: "completed" as const,
                          effectReference: storedArtifacts.find(
                            (artifact) =>
                              item.key ===
                              `source-artifact.store:${artifact.role}`,
                          )?.location.address,
                        }
                      : item,
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
            objectIdentityContract:
              this.ports.observedRootRegistrations.objectIdentityContract,
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
   * ADR-0072 permits a no-op startup result only for a compatible execution
   * whose every still-open Source Refresh Run is awaiting human review. This
   * deliberately reads no lease and performs no Domain or Execution write.
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
   * Runs only after this process owns the Workflow Execution resume lease.
   * A referenced Source Refresh Run remains authoritative: all-terminal Runs
   * are projected through the normal coordinator, while an acquiring or
   * applying Run has no safe collector-resume protocol and is explicitly
   * closed before its parent is interrupted.
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
      await this.continueSourceRefreshRunExecution(runs[0].id, resumeClaim);
      return await this.inspectResumedPublic(execution.id);
    }
    return await this.interruptRecovery(
      inspection.execution,
      "Source Refresh Run 在采集或应用检查点中断，当前版本无法安全继续",
      resumeClaim,
    );
  }

  /**
   * Reconciles every durable non-terminal execution after process startup.
   * The versioned persisted input envelope is the only replay authority.
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
        // A retained non-expired claim is neither resumed, review-waiting nor
        // terminal. Do not report startup ready while it remains unclassified.
        // The single-process Host consequently keeps its admission barrier
        // closed until an operator or the claim owner resolves it.
        if (error instanceof ResumeExecutionBusyError) {
          const current = await this.ports.executionQueries.inspectExecution(
            execution.id,
          );
          if (current?.execution.status === "running") {
            lifecycle?.onWaitingExecution?.(execution.id);
          }
          continue;
        }
        // A competing owner can also terminalize between this startup scan and
        // the claim attempt. `resume()` preserves its public error for an
        // explicit caller, but startup recovery treats the now-terminal row
        // as already reconciled instead of failing the whole host.
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
   * Starts an execution with no plugin coordinates. Coordinates are appended
   * only after a concrete Port participates, so a configured-but-inapplicable
   * integration cannot become part of a durable resume contract.
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

  /** Adds only durable coordinate values, never a runtime Port or its secrets. */
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
    // A legacy item never proved its own participating coordinates. Do not
    // manufacture that proof while resuming it; it remains ineligible for
    // cross-execution reuse.
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
   * Capability invocation is preceded by a durable execution-coordinate
   * checkpoint.  This is deliberately a small execution-record primitive,
   * not a universal capability pipeline: each workflow still owns its own
   * planning, checkpoints, effects, and failure semantics.
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
   * Freeze only the private Source Connection of the collector that will run.
   * The opaque reference is durable audit input; the secret remains behind
   * the outer capability-specific handle and is resolved again per request.
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

  /** Deployment-wide availability is compared with prior frozen participation. */
  private availableCompatibility(): WorkflowCompatibility {
    return {
      ...this.compatibility(),
      capabilityCoordinates: this.availableCapabilityCoordinates(),
    };
  }

  /**
   * Descriptor scopes are opaque adapter capabilities.  The workflow may use
   * their frozen location as evidence, but every byte open and release returns
   * to the Observed Root authority that bound the scope.
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
   * A durable execution retains a frozen root snapshot, not a live handle.
   * Recovery therefore obtains a fresh adapter-bound scope from that exact
   * snapshot before it can read an observed byte again.  There is no fallback
   * to the persisted logical Location.
   */
  private async rebindObservedScopeForResume(
    execution: WorkflowExecution,
  ): Promise<BoundObservedScope | undefined> {
    const scopes = execution.resolvedSelection?.filesystemScopes ?? [];
    if (scopes.length === 0) return undefined;
    if (scopes.length !== 1) {
      throw new Error("刷新记录包含无法安全恢复的多个冻结文件范围");
    }
    const scope = scopes[0];
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
   * Old durable rows may retain a logical directory or a former `{ root }`
   * selection, but never a registration snapshot that can safely be rebound.
   * Such rows remain inspectable history; ADR-0068 and ADR-0072 require an
   * explicit terminal interruption instead of adopting a current root or
   * reopening the saved path.
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
    // No frozen configuration means there is nothing to resolve. This keeps
    // legacy-neutral executions compatible without inventing a configuration
    // dependency at recovery time.
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
   * Restart recovery never silently replans a frozen execution. When its
   * checkpoint or compatibility coordinate cannot be honored, retain the
   * complete existing audit and append only an explicit terminal outcome.
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
   * An interrupted Application recovery must not strand an active
   * Domain-owned Source Refresh Run. Domain cancellation is forward-only, so
   * it retains every already committed fact and closes only uncommitted
   * scopes before the Workflow Execution receives its interrupted outcome.
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
   * Candidate planning happens after its capability coordinate has been
   * durably frozen but before it can form a Source Enrichment checkpoint.
   * There is consequently no honest resumable candidate intent to invent on
   * an interpreter throw.  Read back the authoritative execution first so a
   * preceding freeze/target transition is preserved, then terminally record
   * the ordinary port failure.
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

export class AssetRefreshAutomation {
  constructor(
    private readonly workflow: Pick<
      AssetRefreshWorkflow,
      "scanObservedScope" | "recoverRunningExecutions" | "fulfillInformation"
    >,
    private readonly ports: {
      readonly executionQueries: WorkflowExecutionQueries;
      readonly automationQueries: AutomationQueries;
      readonly automationCommands: AutomationCommands;
      /**
       * Authorization is checked before an Automation Intent becomes durable.
       * This remains an Application-owned boundary: scheduling does not infer
       * filesystem authority and never receives a host path mapping.
       */
      readonly observedRootRegistrations: Pick<
        ObservedRootRegistrations,
        "resolveActiveScope" | "closeBoundScope"
      >;
      readonly recognitionPolicyVersion: string;
      /** Legacy static neutral demand; never persisted on the intent. */
      readonly informationRequirement?: InformationRequirement;
      /**
       * Rebuilt by the outer composition for each accepted subject. It is an
       * opaque neutral-requirement callback here: Application never receives
       * an Asset View, component, route, or provider-specific model.
       */
      readonly informationRequirementForAcceptedSubject?: AutomationInformationRequirementResolver;
    },
  ) {}

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
    // Resolve immediately before the first durable write. A later trigger
    // resolves again through scanObservedScope, so a configuration change
    // between this preflight and a run cannot authorize filesystem work.
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
      // The preflight proves that the configured scope can be bound right
      // now; it grants no authority to the later timer. Release its
      // short-lived descriptor before the durable configuration write.
      await this.ports.observedRootRegistrations.closeBoundScope(
        preflight.scope,
      );
    }
    const intent: AutomationIntent = {
      id: id("automation-intent"),
      scope: {
        // Persist the registration coordinate returned by the authority
        // boundary, not the caller's unnormalised spelling of it. The
        // atomic persistence Port will still prove that this exact frozen
        // coordinate is current when it writes the intent.
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
      readonly onExecutionStarted?: (execution: WorkflowExecution) => void;
      readonly onCheckpoint?: (execution: WorkflowExecution) => void;
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
        // View-specific demand is unavailable before recognition. Keep the
        // scan input neutral and rebuild demand from the accepted subject.
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
        // A recurring timer must not turn one still-unavailable root into an
        // unbounded history of equivalent failed executions. The durable
        // intent remains the audit coordinate and an operator explicitly
        // re-enables it after the mount or permissions have been repaired.
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

  /** Automation contributes only runtime-owner release after generic recovery. */
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
   * A parent scan can finish before its Host-owned Information Fulfillment
   * child.  A later timer tick must inspect that durable graph before it
   * creates another parent; a running child is a waiting classification, and
   * a terminal typed prerequisite failure is the same durable degradation as
   * the synchronous path above.
   */
  private async classifyPriorInformationFulfillment(
    intent: AutomationIntent,
  ): Promise<"waiting" | "unavailable" | undefined> {
    // Production persistence exposes this required query. A few narrow
    // in-process legacy tests intentionally only provide inspection.
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
 * Information fulfillment consumes only candidates from the current durable
 * Source Refresh interpretation. A historical Recognition Proposal never
 * substitutes for that lineage.
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
 * A failed enrichment remains resumable audit evidence, even when its error
 * occurred before collection created a retained-record checkpoint.  The
 * failed union intentionally records an empty collection baseline in that
 * case rather than manufacturing a Source Record or retry instruction.
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
 * A supplementary source may fill only an unmet requested role. Existing
 * materializations remain authoritative for that use context, so enrichment
 * never downloads a backdrop or replaces an already available primary cover.
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
 * The workflow, not a bibliographic provider, projects local format facts
 * into an accepted proposal. Work-item boundaries make these opaque evidence
 * references unambiguous and keep providers replaceable.
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

/** A candidate id is only unique in its full serving semantics. */
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

/** Resolve Domain's ordinary omitted-subject shorthand before any effect key. */
function resolveSourceArtifactSubject(
  candidate: SourceArtifactCandidate,
  acceptedAssetId: string,
): SourceArtifactCandidate {
  return candidate.subjectId === undefined
    ? { ...candidate, subjectId: acceptedAssetId }
    : candidate;
}

/**
 * A newly accepted asset has no durable identity before its first commit.
 * A complete pending checkpoint is therefore also the durable record of the
 * already chosen implicit serving subject.  Anything less complete must not
 * revive that identity or its staged bytes.
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
    return matches.length === 1 ? matches[0].subjectId : undefined;
  });
  if (subjects.some((subjectId) => subjectId === undefined)) return undefined;
  const resolved = new Set(subjects);
  return resolved.size === 1 ? subjects[0] : undefined;
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
 * Candidate identifiers are source-record scoped, so their acquisition
 * definition must remain stable across work items and process restarts.
 * Serving subject and role deliberately remain in the cache key: the same
 * downloadable material can validly serve different subjects without sharing
 * an association or managed-artifact checkpoint.
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
  /** Allocated before external artifact effects so omitted subjects stay stable. */
  readonly asset?: DigitalAsset;
  /** Same accepted source identity: preserve its identity-bearing facts. */
  readonly current?: AcceptedRecognition;
  readonly observedArtifactBoundary?: "filesystem-package";
  readonly objectIdentityContract?: FilesystemObjectIdentityContract;
}): AcceptedRecognition {
  const asset: DigitalAsset = options.current?.entity ??
    options.asset ?? {
      id: id("entity"),
      kind: "digital-asset",
    };
  // ADR0030 / ADR0036: an observed pathname is a locator, not an identity
  // continuity proof.  In the absence of an observer-supplied opaque object
  // identity, a later accepted observation receives a new Artifact even if
  // its address, size, timestamps, or content digest happen to match.  Blob
  // identity is deliberately handled separately by digest at persistence.
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
            // A filesystem-package boundary is one technical Artifact. It
            // deliberately does not derive file-object continuity from its
            // members, because the package interpreter owns that boundary.
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
 * Snapshot-local identity remains intentionally ephemeral: it can group two
 * alias Locations in one result, but cannot manufacture a durable Artifact
 * identifier. A durable value is valid only when the configured observer
 * explicitly declares the exact capability that supplied it.
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
 * A cross-location lookup needs a complete, exact set.  If even one observed
 * file lacks the explicitly declared durable identity capability, no part of
 * this snapshot may be used to infer an existing Asset.
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
 * An Asset-scoped relationship is an acceptance-local fact.  A relationship
 * explicitly between sourced Entities, however, can be projected by multiple
 * Assets in one package.  Give the latter a semantic identity so persistence
 * records it once rather than manufacturing one relation per episode.
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
 * A collector owns the meaning of its scopes.  Application merely shares an
 * identical declared scope within one execution and never inspects provider
 * addresses or payloads.
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
 * Recovery reconstructs execution-local sharing from durable work-item
 * planning evidence and immutable retained Source Records. It asks only the
 * collector for its opaque scope coordinate; Application never interprets a
 * provider address or payload.
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
 * A compatibility or information-requirement change can require another
 * evaluation without itself being a new File Observation. Identity-preserving
 * reevaluation is reserved for the latter (or new directory evidence), so a
 * capability upgrade does not manufacture a fresh Artifact episode merely by
 * recollecting the same ordinary scope.
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
 * Snapshot-local identities are deliberately opaque across observations, but
 * their alias equivalence relation is still useful input to a reuse baseline.
 * Replace the random per-snapshot token with a deterministic class token
 * derived from the sorted logical paths in that one alias class.  This keeps
 * a stable same-root scan reusable while a hardlink/symlink grouping change
 * still changes the fingerprint. Durable identities retain their capability
 * and value verbatim.
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
