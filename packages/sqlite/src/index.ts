import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AcceptedAssetState,
  AssetLibrary,
  AssetLibraryDirectoryReconnect,
  AssetLibrarySave,
  AssetLibrarySaveReceipt,
  LibraryDirectoryGrant,
  LibraryDirectoryInvalidation,
  RelationshipReadBasis,
  AssetRefreshReuseQueries,
  EffectiveRecognitionMaterialBoundary,
  MaterialScopeDeclaration,
  AutomationCommands,
  AutomationIntent,
  AutomationIntentCreationResult,
  AutomationObservedRootAuthorization,
  AutomationQueries,
  AutomationTrigger,
  ChangeImpactCommands,
  ChangeImpactPreview,
  RecognitionSupersessionPlan,
  RecognitionScopeAmendmentPlan,
  ChangeImpactQueries,
  CommitSourceRefreshCollectionFailureInput,
  CurrentAttentionItem,
  CurrentAttentionPage,
  CurrentAttentionPageRequest,
  CurrentAttentionQueries,
  CurrentCataloguePageRequest,
  CurrentCatalogueIndexFacts,
  CurrentCataloguePersistencePage,
  CatalogueEntityRelationshipFacts,
  CurrentCatalogueQueries,
  WorkflowHistoryPageRequest,
  WorkflowHistoryPersistencePage,
  WorkflowHistoryQueries,
  InformationSubjectFactsQueries,
  CurrentInformationSubjectFacts,
  CurrentSourceArtifactQueries,
  CurrentUserInteractionPersistence,
  CreateSourceRefreshRunInputForExecution,
  ExecutionStartDisposition,
  ExecutionInspection,
  AssetRefreshOutcome,
  AssetRefreshWorkItem,
  LibraryScanDirectoryRecord,
  LibraryScanDirectoryStage,
  LibraryScanInspection,
  InformationFulfillmentChildRegistration,
  LibraryScanFulfillmentBatchStage,
  LibraryScanFulfillmentBatchWrite,
  LibraryScanFulfillmentCommands,
  LibraryScanFulfillmentInspection,
  LibraryScanFulfillmentOperationDisposition,
  LibraryScanFulfillmentOperationRecord,
  LibraryScanFulfillmentQueries,
  LibraryScanFulfillmentSubjectDisposition,
  LibraryScanFulfillmentSubjectRecord,
  LegacyLibraryScanFulfillmentClosure,
  UnrecognizedLibraryScanObservation,
  MetadataRefreshPersistence,
  MetadataRefreshSubmission,
  ManagedSourceArtifactPersistence,
  ArtifactRevisionAccessQueries,
  ArtifactRevisionAccessFacts,
  ArtifactContentProofMetadata,
  ArtifactContentProofCommands,
  ObservedFileConfirmationFacts,
  ObservedFileConfirmationQueries,
  ObservedMaterialAssociationPersistence,
  ObservedRevisionConfirmationCommands,
  ObservedArtifactReuseMatch,
  OrdinaryScanReusePlan,
  ObservedRootRegistration,
  ObservedRootRegistrationCommands,
  ObservedRootRegistrationQueries,
  RecognitionAcceptancePersistence,
  RecognitionChangeImpactPersistence,
  RecognitionReevaluationPersistence,
  RecoverySourceRefreshRunCommands,
  SourceRefreshRunPersistence,
  StageSourceRefreshChangeSetInput,
  SourceEnrichmentPersistence,
  SourceAssociationTerminationAudit,
  WorkflowExecutionCommands,
  WorkflowExecutionQueries,
  WorkflowRecoveryLease,
  WorkflowExecution,
  RelatedEntityIdentity,
  RelatedEntityIdentityPersistence,
  EntityMentionResolution,
  EntityIdentityMergePreview,
  RelationshipChange,
  RelationshipChangePreview,
  RelationshipDecisionPersistence,
  FilesystemPackageSnapshot,
  ObservedMaterialAcceptanceBinding,
  InformationRequirement,
  LocalMaterialConfirmationCheckpointOutcome,
  LocalMaterialConfirmationCheckpointTarget,
  LocalMaterialConfirmationFrozenEntry,
  LocalMaterialConfirmationObservation,
  LocalMaterialConfirmationObservationCoordinates,
  LocalMaterialConfirmationPlanEntry,
  RequestedLocalMaterialConfirmationTarget,
} from "@digital/application";
import {
  createObservedRootAuthorityIndex,
  decodeObservedRootRegistration,
  isAutomationObservedRootAuthorizationCurrent,
  isObservedRootAutomationScope,
  observedRootIdsDependingOn,
  workflowCompatibilityCanReuse,
  artifactProofConditionalBaseline,
  materialBoundaryIncludesAddress,
  recognitionMaterialBoundaryIntersectsScope,
  recognitionBoundaryBaseline,
  groupMaterialScopeDeclarations,
  materialScopeDeclarationsIntersect,
  materialScopeDeclarationBaseline,
  RecognitionBoundaryBaselineStale,
  isUnrecognizedObservationWorkItem,
  coveredWorkItems,
  stableRootCoverages,
  automatedInformationPlannerNoneCoordinate,
  decodeInformationFulfillmentPlan,
  decodeLibraryScanFulfillmentRequirement,
  encodeInformationFulfillmentPlan,
  encodeLibraryScanFulfillmentRequirement,
  libraryScanFulfillmentVersion,
  attachLocalMaterialConfirmationObservations,
  decodeObservedMaterialConfirmationCheckpoint,
  findObservedMaterialConfirmationCheckpoint,
  localMaterialConfirmationDispositions,
  localMaterialConfirmationStaleCode,
  localMaterialConfirmationTargetKey,
  LocalMaterialConfirmationTerminalStaleError,
  mergeRequestedLocalMaterialConfirmationTargets,
  representativeObservedMaterialReferences,
  staleLocalMaterialConfirmationAddresses,
} from "@digital/application";
import type {
  AcceptedRecognition,
  Artifact,
  ArtifactAssociation,
  ArtifactAssociationRetraction,
  ArtifactRoleDecision,
  ArtifactRevision,
  Blob,
  CapabilityCoordinate,
  DescriptionTarget,
  EntityMention,
  EntityResolutionDecision,
  EntityRelationship,
  EffectiveEntityKind,
  Location,
  MetadataAssertion,
  ObservedMaterialAssociationSubmission,
  ObservedMaterialAssociationProjection,
  ObservedMaterialAssociationAudit,
  RecognitionDecision,
  RecognitionProposal,
  SourceRecord,
  SourceRefreshChangeSet,
  SourceRefreshRun,
  SourceCoverageScope,
  SourceInterpretationBatch,
  SourceAssociation,
  SourceAssociationChangeProposal,
  SourceAssociationDecision,
  SourceAssociationEstablishmentSupport,
  SourceAssociationRetraction,
  SourcedEntity,
  RelationshipDecision,
  RelationshipDecisionTarget,
  RelationshipDraft,
} from "@digital/domain";
import {
  beginSourceRefreshScopeAcquisition as beginDomainSourceRefreshScopeAcquisition,
  cancelSourceRefreshRun as cancelDomainSourceRefreshRun,
  completeSourceRefreshChangeSet as completeDomainSourceRefreshChangeSet,
  createSourceRefreshRun as createDomainSourceRefreshRun,
  deriveSourceSlotLifecycleChanges,
  deriveEffectiveEntityIdentity,
  failSourceRefreshScope as failDomainSourceRefreshScope,
  projectSourceRefreshRun,
  reviewSourceRefreshChangeSet as reviewDomainSourceRefreshChangeSet,
  stageSourceRefreshChangeSet as stageDomainSourceRefreshChangeSet,
  validateAcceptedRecognition,
  validateObservedMaterialAssociationSubmission,
  validateObservedMaterialAssociationAudit,
  validateArtifactAssociationRetraction,
  validateReevaluatedRecognition,
  validateSourceInterpretationBatch,
  validateRecognitionSupersessionSourceRetraction,
  validateSourceAssociationChange,
  recognitionSourceInterpretation,
  canonicalRelationshipDraft,
  deriveEffectiveRelationships,
  relationshipTargetKey,
  artifactRoleDecisionKey,
  validateArtifactRoleDecision,
} from "@digital/domain";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";

import { enableCatalogueWal } from "./connection.ts";
import {
  derivedCoverCurrentlyRepresentative,
  derivedCoverSiblingId,
  isDerivedEntityCover,
  observedPartOf,
  type DerivedCoverCurrentRows,
} from "./derived-entity-cover-history.ts";
import {
  assertExactLegacySourceEnrichmentAuthority,
  assertOrdinaryEntityMigrationAuthority,
  assertProductionCatalogueReady,
  inspectProductionCatalogueReadiness,
  productionCatalogueMigrationPlan,
} from "./production-readiness.ts";
import { matchesReviewedCatalogueSchema } from "./schema-contract.ts";
import {
  artifactAssociationRetractions,
  artifactAssociationRecognitionSupports,
  artifactAssociationSupersessions,
  artifactAssociations,
  artifactRevisions,
  artifactInteractionStates,
  artifactContentProofs,
  artifacts,
  automationIntents,
  automationRuntime,
  blobs,
  changeImpactPreviews,
  currentFileObservations,
  currentFileObservationSupports,
  currentObservedMaterialSupports,
  currentSourceArtifactCandidateLineages,
  currentSourceAssociations,
  entities,
  entityKindAssertions,
  localEntityCommitments,
  localEntityNames,
  localUsers,
  entityMentions,
  entityRelationshipParticipants,
  entityRelationships,
  entityResolutionDecisions,
  observedMaterialAcceptances,
  observedMaterialBoundaries,
  observedEntities,
  observedEntityMentions,
  observedEntityResolutions,
  observedEntityGraphEntities,
  observedEntityGraphRelationships,
  observedEntityGraphSupports,
  locations,
  metadataAssertionLifecycles,
  metadataAssertionRetractions,
  metadataAssertionSources,
  metadataAssertions,
  observedRootRegistrations,
  assetLibraries,
  libraryDirectoryGrants,
  libraryScanCancellations,
  libraryScanDirectories,
  libraryScanFulfillmentBatches,
  libraryScanFulfillmentOperations,
  libraryScanFulfillmentSubjects,
  observedRevisionConfirmations,
  recognitionDecisions,
  recognitionDecisionSupersessions,
  recognitionProposals,
  sourceLineageHeads,
  relationshipLifecycles,
  relationshipRetractions,
  relationshipSources,
  relationshipDecisions,
  relationshipDecisionHeads,
  relationshipManualSupports,
  artifactRoleDecisions,
  artifactRoleDecisionHeads,
  entityIdentityMerges,
  entityIdentityMergeRetractions,
  recognitionHeads,
  sourceAssociations,
  sourceAssociationChangeProposals,
  sourceAssociationDecisions,
  sourceAssociationEstablishmentSupports,
  sourceAssociationSupersessions,
  sourceAssociationRetractions,
  sourceAssociationLegacyRetirements,
  recognitionDecisionRetractions,
  sourceRefreshChanges,
  sourceRefreshChangeSets,
  sourceRefreshRuns,
  sourceRefreshScopes,
  sourceRecords,
  sourcedEntities,
  workflowExecutions,
} from "./schema.ts";
import {
  canonicalJson,
  WorkflowExecutionPersistence,
} from "./workflow-execution-persistence.ts";

/**
 * 应用层通过其窄化的持久化端口拥有事务边界。这个结构子集将 Drizzle
 * 限定在适配器内部，避免经由该端口暴露 ORM 依赖。
 */
type DrizzleWriteTransaction = Pick<
  ReturnType<typeof drizzle>,
  "delete" | "insert" | "select" | "update"
>;

function observedSelectionFacts(
  query: Pick<ReturnType<typeof drizzle>, "select">,
  locationId: string,
  options: { readonly includeConfirmed?: boolean } = {},
): ObservedFileConfirmationFacts | undefined {
  const location = query
    .select({
      id: locations.id,
      artifactId: locations.artifactId,
      address: locations.address,
      kind: locations.kind,
    })
    .from(locations)
    .where(eq(locations.id, locationId))
    .get();
  if (location?.kind !== "observed") return undefined;
  const current = query
    .select()
    .from(currentFileObservations)
    .where(eq(currentFileObservations.locationId, location.id))
    .get();
  if (current === undefined) return undefined;
  if (!options.includeConfirmed) {
    const confirmed = query
      .select({ revisionId: observedRevisionConfirmations.revisionId })
      .from(observedRevisionConfirmations)
      .where(
        and(
          eq(observedRevisionConfirmations.locationId, location.id),
          eq(observedRevisionConfirmations.snapshotId, current.snapshotId),
          eq(observedRevisionConfirmations.observedAt, current.observedAt),
          eq(observedRevisionConfirmations.size, current.size),
          eq(observedRevisionConfirmations.modifiedAt, current.modifiedAt),
          eq(
            observedRevisionConfirmations.conditionalBaseline,
            current.conditionalBaseline,
          ),
        ),
      )
      .get();
    if (confirmed !== undefined) return undefined;
  }
  const facts = {
    artifactId: location.artifactId,
    location: { locationId: location.id, address: location.address },
    observation: {
      snapshotId: current.snapshotId,
      observedAt: current.observedAt,
      size: current.size,
      modifiedAt: current.modifiedAt,
    },
    conditionalBaseline: current.conditionalBaseline,
  };
  return { ...facts, selectionId: observedSelectionId(facts) };
}

function observedSelectionId(
  facts: Omit<ObservedFileConfirmationFacts, "selectionId">,
): string {
  return `observed-file-selection_1_${sha256Text(
    canonicalJson({
      artifactId: facts.artifactId,
      locationId: facts.location.locationId,
      snapshotId: facts.observation.snapshotId,
      observation: facts.observation,
      conditionalBaseline: facts.conditionalBaseline,
    }),
  )}`;
}

function currentObservationConditionalBaseline(
  query: Pick<ReturnType<typeof drizzle>, "select">,
  input: {
    readonly artifactId: string;
    readonly locationId: string;
    readonly snapshotId: string;
    readonly observedAt: string;
    readonly size: number;
    readonly modifiedAt: string;
  },
): string {
  const revisionHeads = query
    .select({
      id: artifactRevisions.id,
      blobDigest: artifactRevisions.blobDigest,
    })
    .from(artifactRevisions)
    .where(eq(artifactRevisions.artifactId, input.artifactId))
    .orderBy(asc(artifactRevisions.id))
    .all();
  return sha256Text(canonicalJson({ ...input, revisionHeads }));
}

/** 仅把当前观察与同一产物的一条精确确认相交为可消费修订版。 */
function currentConfirmedLocationRevisions(
  query: Pick<ReturnType<typeof drizzle>, "select">,
  locationRows: readonly Pick<
    typeof locations.$inferSelect,
    "id" | "artifactId" | "kind"
  >[],
): readonly { readonly locationId: string; readonly revisionId: string }[] {
  return locationRows.flatMap((location) => {
    if (location.kind !== "observed") return [];
    const current = query
      .select()
      .from(currentFileObservations)
      .where(eq(currentFileObservations.locationId, location.id))
      .get();
    if (current === undefined) return [];
    const confirmationIds = query
      .select({ revisionId: observedRevisionConfirmations.revisionId })
      .from(observedRevisionConfirmations)
      .where(
        and(
          eq(observedRevisionConfirmations.locationId, location.id),
          eq(observedRevisionConfirmations.snapshotId, current.snapshotId),
          eq(observedRevisionConfirmations.observedAt, current.observedAt),
          eq(observedRevisionConfirmations.size, current.size),
          eq(observedRevisionConfirmations.modifiedAt, current.modifiedAt),
          eq(
            observedRevisionConfirmations.conditionalBaseline,
            current.conditionalBaseline,
          ),
        ),
      )
      .all()
      .map(({ revisionId }) => revisionId);
    if (confirmationIds.length === 0) return [];
    const revisionIds = query
      .select({ id: artifactRevisions.id })
      .from(artifactRevisions)
      .where(
        and(
          eq(artifactRevisions.artifactId, location.artifactId),
          inArray(artifactRevisions.id, sqliteTextSet(confirmationIds)),
        ),
      )
      .all()
      .map(({ id }) => id);
    return revisionIds.length === 1
      ? [{ locationId: location.id, revisionId: revisionIds[0]! }]
      : [];
  });
}

/**
 * 前置当前观察的 CAS 比较：`null`/`undefined` 都表示「该位置没有观察」，两者相等。定向确认
 * 检查点据此核对准备查询读到的事实（含不存在）仍未变化。
 */
function sameLocalMaterialObservation(
  left: LocalMaterialConfirmationObservationCoordinates | null | undefined,
  right: LocalMaterialConfirmationObservationCoordinates | null | undefined,
): boolean {
  const a = left === undefined ? null : left;
  const b = right === undefined ? null : right;
  if (a === null || b === null) return a === b;
  return (
    a.snapshotId === b.snapshotId &&
    a.observedAt === b.observedAt &&
    a.size === b.size &&
    a.modifiedAt === b.modifiedAt &&
    a.conditionalBaseline === b.conditionalBaseline
  );
}

/**
 * 带精确观察证据的本地关联支持的当前资格唯一判定：运行时逐关联读取与正式当前投影
 * 共用。关联必须属于授权决定的资产，记录的位置仍是该载体产物的观察位置，目录形态
 * 靠该位置的正向根支持，文件形态靠该修订仍是位置当前确认的修订。
 */
type LocalObservationEvidenceCandidate = {
  readonly locationId: string;
  readonly materialKind: string;
  readonly revisionId: string | null;
  /** 授权这条支持的 Recognition Decision 所属资产。 */
  readonly decisionAssetId: string;
  /** 被支持关联的主体。 */
  readonly subjectId: string;
};

function isCurrentLocalObservationEvidence(input: {
  readonly materialArtifactId: string;
  readonly partRevisionId?: string | undefined;
  readonly evidence: readonly LocalObservationEvidenceCandidate[];
  readonly locationOf: (
    locationId: string,
  ) => { readonly kind: string; readonly artifactId: string } | undefined;
  readonly positiveSupportLocationIds: ReadonlySet<string>;
  readonly currentLocationRevisionKeys: ReadonlySet<string>;
}): boolean {
  return input.evidence.some((row) => {
    if (row.subjectId !== row.decisionAssetId) return false;
    const location = input.locationOf(row.locationId);
    if (
      location === undefined ||
      location.kind !== "observed" ||
      location.artifactId !== input.materialArtifactId
    )
      return false;
    if (row.materialKind === "directory")
      return (
        row.revisionId === null &&
        input.positiveSupportLocationIds.has(row.locationId)
      );
    if (row.materialKind !== "file" || row.revisionId === null) return false;
    if (
      input.partRevisionId !== undefined &&
      input.partRevisionId !== row.revisionId
    )
      return false;
    return input.currentLocationRevisionKeys.has(
      `${row.locationId}\u0000${row.revisionId}`,
    );
  });
}

function proofMetadataMatchesBlob(
  proof: ArtifactContentProofMetadata,
  blobDigest: string,
  byteLength: number,
): boolean {
  return (
    proof.blobDigest === blobDigest &&
    proof.scheme === "artifact-frame-manifest/1" &&
    proof.byteLength === byteLength &&
    proof.frameSize === 1_048_576 &&
    proof.frameCount === Math.ceil(byteLength / 1_048_576) &&
    /^[a-f0-9]{64}$/u.test(proof.manifestDigest)
  );
}

function proofRowEquals(
  row: typeof artifactContentProofs.$inferSelect,
  proof: ArtifactContentProofMetadata,
): boolean {
  return (
    row.blobDigest === proof.blobDigest &&
    row.scheme === proof.scheme &&
    row.byteLength === proof.byteLength &&
    row.frameSize === proof.frameSize &&
    row.frameCount === proof.frameCount &&
    row.manifestDigest === proof.manifestDigest
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Drizzle 数据库与事务共用的只读结构子集。 */
type DrizzleReadQuery = Pick<ReturnType<typeof drizzle>, "select">;

/** 一次观察的载体：所属执行、快照与实际注册根路径。 */
type ObservationCarrier = {
  readonly executionId: string;
  readonly snapshotId: string;
  readonly snapshotRoot: string;
};

/**
 * 本地关联支持携带的精确观察证据。目录形态没有单一文件修订；文件 part 的证据
 * 绑定载体修订，因此载体换修订后旧图不再作为当前。
 */
type LocalObservationEvidence = ObservationCarrier & {
  readonly locationId: string;
  readonly materialKind: "file" | "directory";
  readonly revisionId?: string | undefined;
};

type RelationshipLifecycleRow = typeof relationshipLifecycles.$inferSelect;

/** 事实的支持坐标集合：来源生命周期、观察图槽位与人工决定。 */
type RelationshipSupportState = {
  readonly lifecyclesByRelationshipId: ReadonlyMap<
    string,
    RelationshipLifecycleRow
  >;
  readonly retractedRelationshipIds: ReadonlySet<string>;
  readonly supersededRelationshipIds: ReadonlySet<string>;
  readonly observedSourceSlotsByRelationshipId: ReadonlyMap<string, string>;
  readonly manualRelationshipIds: ReadonlySet<string>;
  readonly targetsByRelationshipId: ReadonlyMap<
    string,
    RelationshipDecisionTarget
  >;
  readonly ambiguousRelationshipIds: ReadonlySet<string>;
};

/** 唯一生效投影读取的关系状态。 */
type RelationshipProjectionState = {
  readonly relationships: readonly EntityRelationship[];
  readonly targets: ReadonlyMap<string, RelationshipDecisionTarget>;
  readonly decisions: readonly RelationshipDecision[];
  readonly manualRelationshipIds: ReadonlySet<string>;
  readonly ambiguousRelationshipIds: ReadonlySet<string>;
};

function relationshipSourceTarget(
  lifecycle: RelationshipLifecycleRow,
): RelationshipDecisionTarget {
  return {
    kind: "source",
    sourceSubjectId: lifecycle.sourceSubjectId,
    sourceIdentity: lifecycle.sourceIdentity,
    nativeAddress: lifecycle.nativeAddress,
    coverageId: lifecycle.coverageId,
    sourceSlot: lifecycle.sourceSlot,
  };
}

/** 独立人工目标：由声明与完整语义草稿规范确定，重复预演不会另开决定范围。 */
function manualRelationshipTarget(
  definitionId: string,
  draft: RelationshipDraft,
): RelationshipDecisionTarget {
  return {
    kind: "manual",
    targetId: `manual-${sha256Text(canonicalRelationshipDraft(definitionId, draft)).slice(0, 40)}`,
  };
}

/** 人工事实 ID 含目标、声明、参与者与限定项，因此同类型同参与者的不同目标互不冲突。 */
function manualRelationshipFactId(
  target: RelationshipDecisionTarget,
  definitionId: string,
  draft: RelationshipDraft,
): string {
  return `manual-relationship_${sha256Text(
    JSON.stringify({
      target: relationshipTargetKey(target),
      draft: canonicalRelationshipDraft(definitionId, draft),
    }),
  ).slice(0, 40)}`;
}

function supportedRelationshipCount(
  state: RelationshipProjectionState,
  target: RelationshipDecisionTarget,
): number {
  const key = relationshipTargetKey(target);
  return state.relationships.filter(
    (relationship) =>
      !state.manualRelationshipIds.has(relationship.id) &&
      relationshipTargetKey(state.targets.get(relationship.id)!) === key,
  ).length;
}

/** 一个根资产的生效关系及其真实端点。 */
type EffectiveRelationshipSubjects = {
  readonly relationships: readonly (typeof entityRelationships.$inferSelect)[];
  readonly endpointIds: ReadonlySet<string>;
  readonly factSubjectIds: ReadonlySet<string>;
};

/**
 * 生效关系（生命周期支持、人工与观察决定）及其端点共同决定资料装载与裁剪。
 * 批量装载与单主体投影必须共用此求值，已排除或替换的目标才不会残留在资料里。
 */
function selectEffectiveRelationshipSubjects(input: {
  readonly assetId: string;
  /** 提案实体只作关系查找种子，本身不直接进入资料主体集合。 */
  readonly seedSubjectIds: ReadonlySet<string>;
  readonly relationships: readonly (typeof entityRelationships.$inferSelect)[];
  readonly supports: RelationshipSupportState;
  readonly decisions: readonly RelationshipDecision[];
  readonly participantResolutions: ReadonlyMap<string, string>;
  readonly identityRepresentatives: ReadonlyMap<string, string>;
  readonly factLineages: ReadonlySet<string>;
}): EffectiveRelationshipSubjects {
  const candidates = input.relationships.filter((row) => {
    if (
      input.supports.supersededRelationshipIds.has(row.id) ||
      input.supports.retractedRelationshipIds.has(row.id)
    )
      return false;
    const lifecycle = input.supports.lifecyclesByRelationshipId.get(row.id);
    if (
      !(
        (lifecycle !== undefined &&
          input.factLineages.has(
            sourceLineageKey(lifecycle.sourceIdentity, lifecycle.nativeAddress),
          )) ||
        input.supports.manualRelationshipIds.has(row.id) ||
        input.supports.observedSourceSlotsByRelationshipId.has(row.id)
      )
    )
      return false;
    if (!input.supports.targetsByRelationshipId.has(row.id)) return false;
    return (
      relationshipParticipantsFromJson(row.participantsJson).some(
        (participant) => input.seedSubjectIds.has(participant.entityId),
      ) ||
      (() => {
        const target = input.supports.targetsByRelationshipId.get(row.id);
        return target?.kind === "source"
          ? input.seedSubjectIds.has(target.sourceSubjectId)
          : target?.kind === "observed" && target.assetId === input.assetId;
      })()
    );
  });
  /** 生命周期筛选后仍要按决定头求值：排除或替换的目标不再是生效端点。 */
  const effectiveIds = new Set(
    deriveEffectiveRelationships({
      relationships: candidates.map(
        (row): EntityRelationship => ({
          id: row.id,
          type: row.type,
          participants: relationshipParticipantsFromJson(row.participantsJson),
          sourceSlot:
            input.supports.lifecyclesByRelationshipId.get(row.id)?.sourceSlot ??
            input.supports.observedSourceSlotsByRelationshipId.get(row.id) ??
            "manual",
          sourceRecordIds: jsonStringArray(
            row.sourceRecordIdsJson,
            "relationship source records",
          ),
          qualifiers: JSON.parse(row.qualifiersJson) as NonNullable<
            EntityRelationship["qualifiers"]
          >,
          ...(row.producerJson === null
            ? {}
            : { producer: producerFromJson(row.producerJson) }),
        }),
      ),
      targets: input.supports.targetsByRelationshipId,
      decisions: input.decisions,
      manualRelationshipIds: input.supports.manualRelationshipIds,
    }).map(({ id }) => id),
  );
  const relationships = candidates.filter((row) => effectiveIds.has(row.id));
  const endpointIds = new Set<string>();
  for (const row of relationships)
    for (const participant of relationshipParticipantsFromJson(
      row.participantsJson,
    )) {
      endpointIds.add(participant.entityId);
      for (const mentionId of participant.mentionIds ?? []) {
        const resolved = input.participantResolutions.get(mentionId);
        if (resolved !== undefined) endpointIds.add(resolved);
      }
    }
  for (const endpointId of Array.from(endpointIds))
    endpointIds.add(
      input.identityRepresentatives.get(endpointId) ?? endpointId,
    );
  return {
    relationships,
    endpointIds,
    factSubjectIds: new Set([...endpointIds, input.assetId]),
  };
}

/** 资产自身的当前来源坐标：识别解释记录与仍为当前的关联。 */
function selectAssetFactLineageKeys(input: {
  readonly hasRecognitionSourceAssociation: boolean;
  readonly interpretationSourceRecordIds: readonly string[];
  readonly sourceRecords: ReadonlyMap<
    string,
    { readonly sourceIdentity: string; readonly nativeAddress: string }
  >;
  readonly currentAssociations: readonly {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  }[];
}): Set<string> {
  return new Set([
    ...(input.hasRecognitionSourceAssociation
      ? input.interpretationSourceRecordIds
      : []
    ).flatMap((id) => {
      const record = input.sourceRecords.get(id);
      return record === undefined
        ? []
        : [sourceLineageKey(record.sourceIdentity, record.nativeAddress)];
    }),
    ...input.currentAssociations.map((association) =>
      sourceLineageKey(association.sourceIdentity, association.nativeAddress),
    ),
  ]);
}

type MetadataRefreshInput = {
  readonly expectedExecution: WorkflowExecution;
  readonly execution: WorkflowExecution;
  readonly submission: MetadataRefreshSubmission;
  readonly resumeClaim?: { readonly token: string; readonly now: string };
};

type MetadataRefreshPreflight = {
  readonly records: readonly {
    readonly record: SourceRecord;
    readonly expectedHead: string | undefined;
  }[];
};

type CurrentCatalogueHydrationRows = {
  readonly relationshipSupports: RelationshipSupportState;
  readonly relationshipDecisions: readonly RelationshipDecision[];
  /** 当前生效的人工产物角色决定头，按同一坐标唯一。 */
  readonly artifactRoleDecisions: readonly ArtifactRoleDecision[];
  readonly participantResolutions: ReadonlyMap<string, string>;
  readonly identityRepresentatives: ReadonlyMap<string, string>;
  readonly localNames: readonly (typeof localEntityNames.$inferSelect)[];
  readonly entities: readonly (typeof entities.$inferSelect)[];
  readonly heads: readonly (typeof recognitionHeads.$inferSelect)[];
  /**
   * 主头为空时点名的生效决定：只提供这一次读取的事实依据，投影会明确标记身份未解决。
   */
  readonly namedBasisDecisionId?: string | undefined;
  /** 身份基线读取：忽略主头，强制以点名前驱决定为事实依据。 */
  readonly pinNamedBasisDecision?: boolean | undefined;
  /** 仅参与主体/身份读取点名的描述目标，不扩大资产关系或产物图。 */
  readonly namedMetadataSubjectIds?: readonly string[] | undefined;
  readonly associations: readonly (typeof sourceAssociations.$inferSelect)[];
  readonly currentAssociations: readonly (typeof currentSourceAssociations.$inferSelect)[];
  /** 候选事实 provenance 记录所属的真实来源 owner。 */
  readonly sourceOwnerByRecordId: ReadonlyMap<string, ReadonlySet<string>>;
  /** 产物事实直接引用的来源关联及其 owner 坐标。 */
  readonly sourceAssociationOwnerById: ReadonlyMap<
    string,
    {
      readonly subjectId: string;
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
    }
  >;
  readonly currentSourceOwnerCoordinates: ReadonlySet<string>;
  /** owner 仍为当前的精确来源关联 ID，用于产物资格，不外泄到读取契约。 */
  readonly currentSourceOwnerAssociationIds: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  /** owner 仍占据的精确覆盖头，用于相关目标的元数据资格。 */
  readonly currentSourceOwnerCoverageHeads: ReadonlySet<string>;
  /** owner 仍占据的来源记录头，用于相关目标的产物资格。 */
  readonly currentSourceOwnerRecordHeads: ReadonlySet<string>;
  readonly decisions: readonly (typeof recognitionDecisions.$inferSelect)[];
  readonly proposals: readonly (typeof recognitionProposals.$inferSelect)[];
  /**
   * 派生实体封面的声明提案：身份保持刷新把新观察事实挂在原不可变决定上，声明它们的是那次
   * 观察执行自己的提案，不在 `proposals`（按决定装载）里。只参与封面当前资格判定。
   */
  readonly derivedCoverDeclaringProposals?: readonly (typeof recognitionProposals.$inferSelect)[];
  readonly artifactAssociations: readonly (typeof artifactAssociations.$inferSelect)[];
  readonly artifactSupersessions: readonly (typeof artifactAssociationSupersessions.$inferSelect)[];
  readonly artifactRetractions: readonly (typeof artifactAssociationRetractions.$inferSelect)[];
  readonly artifactRecognitionSupports: readonly (typeof artifactAssociationRecognitionSupports.$inferSelect)[];
  readonly endedRecognitionDecisionIds: ReadonlySet<string>;
  readonly metadata: readonly (typeof metadataAssertions.$inferSelect)[];
  readonly metadataLifecycles: readonly (typeof metadataAssertionLifecycles.$inferSelect)[];
  readonly metadataRetractions: readonly (typeof metadataAssertionRetractions.$inferSelect)[];
  readonly relationships: readonly (typeof entityRelationships.$inferSelect)[];
  readonly sourceRecords: readonly Pick<
    typeof sourceRecords.$inferSelect,
    | "id"
    | "executionId"
    | "sourceIdentity"
    | "nativeAddress"
    | "coverageJson"
    | "producerJson"
  >[];
  readonly artifacts: readonly (typeof artifacts.$inferSelect)[];
  readonly locations: readonly (typeof locations.$inferSelect)[];
  readonly currentLocationRevisions: readonly {
    readonly locationId: string;
    readonly revisionId: string;
  }[];
  /**
   * 支持证据判定要看到自己记录的那些观察位置，包括已经不再当前的位置，因此与
   * `locations`（只保留当前成员）分开预载。
   */
  readonly evidenceLocations: readonly (typeof locations.$inferSelect)[];
  /** 证据位置里仍是当前确认修订的 `${locationId}\u0000${revisionId}` 组合。 */
  readonly evidenceCurrentLocationRevisionKeys: readonly string[];
  /** 拥有正向根支持（当前成员资格）的证据位置。 */
  readonly positiveMaterialSupportLocationIds: readonly string[];
  readonly revisions: readonly (typeof artifactRevisions.$inferSelect)[];
  readonly blobs: readonly (typeof blobs.$inferSelect)[];
  readonly sourcedEntities: readonly (typeof sourcedEntities.$inferSelect)[];
  readonly entityKinds: ReadonlyMap<string, EffectiveEntityKind>;
  readonly resolutions: readonly (typeof entityResolutionDecisions.$inferSelect)[];
  readonly mentions: readonly (typeof entityMentions.$inferSelect)[];
  readonly observedEntities: readonly (typeof observedEntities.$inferSelect)[];
  readonly observedMentions: readonly (typeof observedEntityMentions.$inferSelect)[];
  readonly observedResolutions: readonly (typeof observedEntityResolutions.$inferSelect)[];
  readonly observedEntityGraphSupports: readonly (typeof observedEntityGraphSupports.$inferSelect)[];
  readonly observedEntityGraphEntities: readonly (typeof observedEntityGraphEntities.$inferSelect)[];
  readonly observedEntityGraphRelationships: readonly (typeof observedEntityGraphRelationships.$inferSelect)[];
};

/**
 * 派生实体封面的历史真实性/当前角色判定对外可见：就绪检查与迁移测试都按同一份判定读取，
 * 不在别处复制规则。
 */
export {
  derivedCoverCurrentlyRepresentative,
  readDerivedEntityCoverReadiness,
  validateDerivedEntityCoverHistory,
  type DerivedCoverCurrentRows,
  type DerivedCoverHistoryRows,
  type DerivedCoverReadinessEntry,
  type DerivedCoverSupportRow,
  type DerivedCoverVerdict,
} from "./derived-entity-cover-history.ts";

/**
 * 基础设施层拥有用于判断持久恢复租约是否仍然有效的时钟。它刻意不跨越
 * 应用端口：调用方可以请求租约，但不能提供验证租约时使用的时间。
 */
export type SqliteCatalogueClock = {
  now(): Date;
};

/** 仅供构造时使用的基础设施选项；生产环境默认采用当前 UTC 时间。 */
export type SqliteCatalogueOptions = {
  readonly clock?: SqliteCatalogueClock;
};

const defaultCataloguePageLimit = 24;
const maximumCataloguePageLimit = 100;
const maximumCatalogueCursorLength = 4096;

type CurrentCatalogueCursor = {
  readonly version: 1;
  readonly query: "current-catalogue";
  readonly anchor: string;
};

type WorkflowHistoryCursor = {
  readonly version: 1;
  readonly query: "workflow-history";
  readonly sequence: number;
  readonly id: string;
};

type CurrentAttentionCursor = {
  /**
   * v2 按提案而非执行来标识识别行，因为一次多项目执行可能留下多个
   * 等待审核的提案。
   */
  readonly version: 2;
  readonly query: "current-attention";
  readonly sequence: number;
  readonly kind: 0 | 1 | 2 | 3;
  readonly id: string;
};

type CurrentAttentionCandidate = {
  readonly item: CurrentAttentionItem;
  readonly sequence: number;
  readonly kind: 0 | 1 | 2 | 3;
  /** 仅保留在不透明续传信息中的稳定来源本地身份。 */
  readonly cursorId: string;
};

type ChangeImpactAttentionRow = {
  readonly previewId: string;
  readonly executionId: string;
  readonly assetId: string;
  readonly previewJson: string;
  readonly sequence: number;
};

/**
 * 受观察覆盖历史管理的资产，必须至少有一项仍有效的正向材料支持才留在当前资料库：
 * 某个 active 观察根版本完整确认了其耐久材料边界所固定形态的文件或目录。
 * 覆盖历史本身不证明材料存在；封面等描述／展示产物也不提供成员资格。
 * 没有观察覆盖历史的资产沿用既有来源型／托管型进入规则。
 */
function currentObservedMaterialPredicate(
  observedRootIds?: readonly string[],
  assetLibraryId?: string,
): SQL {
  return sql`(
    (${observedRootIds === undefined ? 1 : 0} = 1 AND NOT EXISTS (
      SELECT 1
      FROM ${artifactAssociations}
      INNER JOIN ${locations}
        ON ${locations.artifactId} = ${artifactAssociations.artifactId}
      WHERE ${artifactAssociations.subjectId} = ${recognitionHeads.subjectId}
        AND ${locations.kind} = 'observed'
        AND EXISTS (
          SELECT 1 FROM ${currentFileObservationSupports}
          WHERE ${currentFileObservationSupports.locationId} = ${locations.id}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${artifactAssociationSupersessions}
          WHERE ${artifactAssociationSupersessions.predecessorAssociationId} = ${artifactAssociations.id}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${artifactAssociationRetractions}
          WHERE ${artifactAssociationRetractions.associationId} = ${artifactAssociations.id}
        )
    ))
    OR EXISTS (
    SELECT 1
    FROM ${artifactAssociations}
    INNER JOIN ${locations}
      ON ${locations.artifactId} = ${artifactAssociations.artifactId}
    INNER JOIN ${currentObservedMaterialSupports}
      ON ${currentObservedMaterialSupports.locationId} = ${locations.id}
    INNER JOIN ${observedMaterialBoundaries}
      ON ${observedMaterialBoundaries.locationId} = ${locations.id}
    INNER JOIN ${observedRootRegistrations}
     ON ${observedRootRegistrations.id} = ${currentObservedMaterialSupports.observedRootId}
     AND ${observedRootRegistrations.configVersion} = ${currentObservedMaterialSupports.observedRootVersion}
     AND ${observedRootRegistrations.status} = 'active'
    WHERE NOT EXISTS (
      SELECT 1
      FROM json_each(${currentObservedMaterialSupports.authorizedTargetsJson}) AS frozen_target
      LEFT JOIN ${observedRootRegistrations} AS current_target
        ON current_target.id = json_extract(frozen_target.value, '$.id')
       AND current_target.config_version = json_extract(frozen_target.value, '$.configVersion')
       AND current_target.status = 'active'
      WHERE current_target.id IS NULL
    )
      AND ${artifactAssociations.subjectId} = ${recognitionHeads.subjectId}
      AND ${locations.kind} = 'observed'
      AND ${observedRootIds === undefined ? sql`1 = 1` : inArray(currentObservedMaterialSupports.observedRootId, sqliteTextSet(observedRootIds))}
      ${
        assetLibraryId === undefined
          ? sql``
          : sql`AND EXISTS (
        SELECT 1
        FROM ${libraryDirectoryGrants}
        WHERE ${libraryDirectoryGrants.libraryId} = ${assetLibraryId}
          AND ${libraryDirectoryGrants.observedRootId} = ${currentObservedMaterialSupports.observedRootId}
          AND ${libraryDirectoryGrants.status} = 'active'
          AND ${libraryDirectoryGrants.awaitingObservation} = 0
      )`
      }
      AND NOT EXISTS (
        SELECT 1
        FROM ${artifactAssociationSupersessions}
        WHERE ${artifactAssociationSupersessions.predecessorAssociationId} = ${artifactAssociations.id}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${artifactAssociationRetractions}
        WHERE ${artifactAssociationRetractions.associationId} = ${artifactAssociations.id}
      )
    )
  )`;
}

function currentCataloguePageLimit(
  input: CurrentCataloguePageRequest | undefined,
): number {
  const limit = input?.limit ?? defaultCataloguePageLimit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximumCataloguePageLimit
  ) {
    throw new Error(
      `Current Catalogue page limit must be between 1 and ${maximumCataloguePageLimit}`,
    );
  }
  return limit;
}

function currentCatalogueCursor(
  cursor: string | undefined,
): string | undefined {
  if (cursor === undefined) return undefined;
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > maximumCatalogueCursorLength ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new Error("Current Catalogue cursor is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Current Catalogue cursor is invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { readonly version?: unknown }).version !== 1 ||
    (parsed as { readonly query?: unknown }).query !== "current-catalogue" ||
    typeof (parsed as { readonly anchor?: unknown }).anchor !== "string" ||
    (parsed as { readonly anchor: string }).anchor.length === 0
  ) {
    throw new Error("Current Catalogue cursor is invalid");
  }
  return (parsed as CurrentCatalogueCursor).anchor;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function encodeCurrentCatalogueCursor(anchor: string): string {
  const cursor: CurrentCatalogueCursor = {
    version: 1,
    query: "current-catalogue",
    anchor,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function workflowHistoryPageLimit(
  input: WorkflowHistoryPageRequest | undefined,
): number {
  const limit = input?.limit ?? defaultCataloguePageLimit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximumCataloguePageLimit
  ) {
    throw new Error(
      `Workflow History page limit must be between 1 and ${maximumCataloguePageLimit}`,
    );
  }
  return limit;
}

function workflowHistoryCursor(
  cursor: string | undefined,
): WorkflowHistoryCursor | undefined {
  if (cursor === undefined) return undefined;
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > maximumCatalogueCursorLength ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new Error("Workflow History cursor is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Workflow History cursor is invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { readonly version?: unknown }).version !== 1 ||
    (parsed as { readonly query?: unknown }).query !== "workflow-history" ||
    !Number.isSafeInteger(
      (parsed as { readonly sequence?: unknown }).sequence,
    ) ||
    (parsed as { readonly sequence: number }).sequence <= 0 ||
    typeof (parsed as { readonly id?: unknown }).id !== "string" ||
    (parsed as { readonly id: string }).id.length === 0
  ) {
    throw new Error("Workflow History cursor is invalid");
  }
  return parsed as WorkflowHistoryCursor;
}

function encodeWorkflowHistoryCursor(
  cursor: Omit<WorkflowHistoryCursor, "version" | "query">,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      query: "workflow-history",
      ...cursor,
    } satisfies WorkflowHistoryCursor),
    "utf8",
  ).toString("base64url");
}

function currentAttentionPageLimit(
  input: CurrentAttentionPageRequest | undefined,
): number {
  const limit = input?.limit ?? defaultCataloguePageLimit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximumCataloguePageLimit
  ) {
    throw new Error(
      `Current Attention page limit must be between 1 and ${maximumCataloguePageLimit}`,
    );
  }
  return limit;
}

function currentAttentionCursor(
  cursor: string | undefined,
): CurrentAttentionCursor | undefined {
  if (cursor === undefined) return undefined;
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > maximumCatalogueCursorLength ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new Error("Current Attention cursor is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Current Attention cursor is invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { readonly version?: unknown }).version !== 2 ||
    (parsed as { readonly query?: unknown }).query !== "current-attention" ||
    !Number.isSafeInteger(
      (parsed as { readonly sequence?: unknown }).sequence,
    ) ||
    (parsed as { readonly sequence: number }).sequence <= 0 ||
    ((parsed as { readonly kind?: unknown }).kind !== 0 &&
      (parsed as { readonly kind?: unknown }).kind !== 1 &&
      (parsed as { readonly kind?: unknown }).kind !== 2 &&
      (parsed as { readonly kind?: unknown }).kind !== 3) ||
    typeof (parsed as { readonly id?: unknown }).id !== "string" ||
    (parsed as { readonly id: string }).id.length === 0
  ) {
    throw new Error("Current Attention cursor is invalid");
  }
  return parsed as CurrentAttentionCursor;
}

function encodeCurrentAttentionCursor(
  cursor: Omit<CurrentAttentionCursor, "version" | "query">,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 2,
      query: "current-attention",
      ...cursor,
    } satisfies CurrentAttentionCursor),
    "utf8",
  ).toString("base64url");
}

function currentAttentionSubjectId(requestedSelectionJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestedSelectionJson);
  } catch {
    throw new Error("Current Attention has malformed Source Refresh selection");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { readonly subjectId?: unknown }).subjectId !==
      "string" ||
    (parsed as { readonly subjectId: string }).subjectId.length === 0
  ) {
    throw new Error("Current Attention has malformed Source Refresh selection");
  }
  return (parsed as { readonly subjectId: string }).subjectId;
}

const systemSqliteCatalogueClock: SqliteCatalogueClock = {
  now: () => new Date(),
};

/** 父执行耐久输入里那一份冻结库快照；缺失或损坏时视为无可核对的父归属。 */
function frozenSnapshotOfParentInput(
  input: string | null,
): Readonly<Record<string, unknown>> | undefined {
  if (input === null) return undefined;
  try {
    const parsed = JSON.parse(input) as { assetLibrary?: unknown };
    return typeof parsed.assetLibrary === "object" &&
      parsed.assetLibrary !== null
      ? (parsed.assetLibrary as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 由各个窄化资产刷新持久化端口共用的 SQLite 实现。 */
export class SqliteCatalogue
  implements
    WorkflowExecutionCommands,
    WorkflowExecutionQueries,
    LibraryScanFulfillmentCommands,
    LibraryScanFulfillmentQueries,
    WorkflowRecoveryLease,
    AssetRefreshReuseQueries,
    RecognitionAcceptancePersistence,
    RecognitionReevaluationPersistence,
    RecognitionChangeImpactPersistence,
    MetadataRefreshPersistence,
    SourceRefreshRunPersistence,
    RecoverySourceRefreshRunCommands,
    SourceEnrichmentPersistence,
    ChangeImpactQueries,
    ChangeImpactCommands,
    AutomationQueries,
    AutomationCommands,
    CurrentCatalogueQueries,
    CurrentAttentionQueries,
    WorkflowHistoryQueries,
    InformationSubjectFactsQueries,
    CurrentSourceArtifactQueries,
    ManagedSourceArtifactPersistence,
    ArtifactRevisionAccessQueries,
    ObservedFileConfirmationQueries,
    ObservedRevisionConfirmationCommands,
    ObservedRootRegistrationCommands,
    ObservedRootRegistrationQueries,
    CurrentUserInteractionPersistence,
    RelatedEntityIdentityPersistence,
    RelationshipDecisionPersistence
{
  private database: DatabaseSync | undefined;
  private readonly productDataDirectory: string;
  private readonly clock: SqliteCatalogueClock;
  private readonly workflowExecutionPersistence: WorkflowExecutionPersistence;

  async previewRelationshipChange(input: {
    readonly changes: readonly RelationshipChange[];
  }): Promise<RelationshipChangePreview> {
    return this.relationshipChangePreviewWithDrizzle(
      drizzle({ client: await this.ensure() }),
      input.changes,
    );
  }

  async applyRelationshipChange(input: {
    readonly id: string;
    readonly actorId: string;
    readonly preview: RelationshipChangePreview;
  }): Promise<"applied" | "stale"> {
    const query = drizzle({ client: await this.ensure() });
    return query.transaction(
      (transaction) => {
        const current = this.relationshipChangePreviewWithDrizzle(
          transaction,
          input.preview.changes,
        );
        if (current.baseline !== input.preview.baseline)
          return "stale" as const;
        const state = this.relationshipProjectionWithDrizzle(transaction);
        const adoptedManualRelationshipIds = new Set<string>();
        for (const [index, change] of input.preview.changes.entries()) {
          const target = this.relationshipChangeTarget(change, state);
          const targetKey = relationshipTargetKey(target);
          const decisionId = `${input.id}:${index}`;
          const correction =
            change.kind === "create" || change.kind === "replace"
              ? {
                  definitionId: change.definitionId,
                  draft: change.relationship,
                }
              : undefined;
          const manualRelationshipId =
            correction === undefined
              ? undefined
              : manualRelationshipFactId(
                  target,
                  correction.definitionId,
                  correction.draft,
                );
          if (manualRelationshipId !== undefined && correction !== undefined) {
            const adopted = state.decisions.find(
              (decision) =>
                relationshipTargetKey(decision.target) === targetKey,
            );
            if (
              adopted?.kind === "fix" &&
              adopted.manualRelationshipId === manualRelationshipId
            )
              continue;
            if (adoptedManualRelationshipIds.has(manualRelationshipId))
              continue;
            const participantIds = [
              ...new Set(
                correction.draft.participants.map(({ entityId }) => entityId),
              ),
            ];
            if (
              transaction
                .select({ id: entities.id })
                .from(entities)
                .where(inArray(entities.id, sqliteTextSet(participantIds)))
                .all().length !== participantIds.length
            )
              throw new Error("更正关系引用了不存在的实体");
            transaction
              .insert(entityRelationships)
              .values({
                id: manualRelationshipId,
                type: correction.draft.type,
                participantsJson: JSON.stringify(correction.draft.participants),
                sourceRecordIdsJson: "[]",
                qualifiersJson: JSON.stringify(
                  correction.draft.qualifiers ?? [],
                ),
                producerJson: null,
              })
              .onConflictDoNothing()
              .run();
            for (const participant of correction.draft.participants)
              transaction
                .insert(entityRelationshipParticipants)
                .values({
                  relationshipId: manualRelationshipId,
                  entityId: participant.entityId,
                  role: participant.role,
                  mentionIdsJson: JSON.stringify(participant.mentionIds ?? []),
                })
                .onConflictDoNothing()
                .run();
            transaction
              .insert(relationshipManualSupports)
              .values({
                relationshipId: manualRelationshipId,
                decisionId,
              })
              .onConflictDoNothing()
              .run();
            adoptedManualRelationshipIds.add(manualRelationshipId);
          }
          transaction
            .insert(relationshipDecisions)
            .values({
              id: decisionId,
              targetJson: JSON.stringify(target),
              kind:
                change.kind === "create" || change.kind === "replace"
                  ? "fix"
                  : change.kind,
              definitionId: correction?.definitionId ?? null,
              manualRelationshipId:
                manualRelationshipId ??
                this.selectedManualEvidence(change, state) ??
                null,
              actorId: input.actorId,
            })
            .run();
          transaction
            .insert(relationshipDecisionHeads)
            .values({ targetKey, decisionId })
            .onConflictDoUpdate({
              target: relationshipDecisionHeads.targetKey,
              set: { decisionId },
            })
            .run();
        }
        return "applied" as const;
      },
      { behavior: "immediate" },
    );
  }

  private relationshipChangePreviewWithDrizzle(
    query: DrizzleReadQuery,
    changes: readonly RelationshipChange[],
  ): RelationshipChangePreview {
    const normalizedChanges = this.normalizeRelationshipChangesWithDrizzle(
      query,
      changes,
    );
    const state = this.relationshipProjectionWithDrizzle(query);
    const relationships = [...state.relationships];
    const targets = new Map(state.targets);
    const manualRelationshipIds = new Set(state.manualRelationshipIds);
    const decisions = new Map(
      state.decisions.map((decision) => [
        relationshipTargetKey(decision.target),
        decision,
      ]),
    );
    for (const change of normalizedChanges) {
      const target = this.relationshipChangeTarget(change, state);
      const key = relationshipTargetKey(target);
      const correction =
        change.kind === "create" || change.kind === "replace"
          ? {
              definitionId: change.definitionId,
              draft: change.relationship,
            }
          : undefined;
      let manualRelationshipId: string | undefined;
      if (correction !== undefined) {
        const participantIds = [
          ...new Set(
            correction.draft.participants.map(({ entityId }) => entityId),
          ),
        ];
        if (
          query
            .select({ id: entities.id })
            .from(entities)
            .where(inArray(entities.id, sqliteTextSet(participantIds)))
            .all().length !== participantIds.length
        )
          throw new Error("更正关系引用了不存在的实体");
        manualRelationshipId = manualRelationshipFactId(
          target,
          correction.definitionId,
          correction.draft,
        );
        if (!relationships.some(({ id }) => id === manualRelationshipId))
          relationships.push({
            id: manualRelationshipId,
            type: correction.draft.type,
            participants: correction.draft.participants,
            sourceSlot: "manual",
            sourceRecordIds: [],
            ...(correction.draft.qualifiers === undefined
              ? {}
              : { qualifiers: correction.draft.qualifiers }),
          });
        targets.set(manualRelationshipId, target);
        manualRelationshipIds.add(manualRelationshipId);
      }
      const evidence =
        manualRelationshipId ?? this.selectedManualEvidence(change, state);
      decisions.set(key, {
        id: `preview:${key}`,
        target,
        kind:
          change.kind === "create" || change.kind === "replace"
            ? "fix"
            : change.kind,
        ...(evidence === undefined ? {} : { manualRelationshipId: evidence }),
      });
    }
    const effective = deriveEffectiveRelationships({
      relationships,
      targets,
      decisions: [...decisions.values()],
      manualRelationshipIds,
    });
    this.assertIdentityFoldedRelationshipStructure(query, effective);
    return {
      baseline: sha256Text(
        JSON.stringify({
          relationships: state.relationships.map(({ id, sourceRecordIds }) => ({
            id,
            sourceRecordIds,
          })),
          targets: state.relationships.map(({ id }) => ({
            id,
            target: state.targets.get(id),
          })),
          decisions: state.decisions,
          merges: query.select().from(entityIdentityMerges).all(),
          retractions: query
            .select()
            .from(entityIdentityMergeRetractions)
            .all(),
        }),
      ),
      changes: normalizedChanges,
      relationships: effective.map((relationship) => ({
        id: relationship.id,
        participants: relationship.participants.map(({ entityId, role }) => ({
          entityId,
          role,
        })),
        type: relationship.type,
        ...(relationship.qualifiers === undefined
          ? {}
          : { qualifiers: relationship.qualifiers }),
        sources: [],
      })),
    };
  }

  /** 关系决定先得出既有生效投影，再以当前身份代表验证最终结构。 */
  private assertIdentityFoldedRelationshipStructure(
    query: DrizzleReadQuery,
    relationships: readonly EntityRelationship[],
  ): void {
    const forest = this.effectiveIdentityForestWithDrizzle(query);
    for (const relationship of relationships) {
      const participants = relationship.participants.map((participant) => ({
        ...participant,
        entityId:
          forest.representativeByEntity.get(participant.entityId) ??
          participant.entityId,
      }));
      if (
        new Set(
          participants.map(({ entityId, role }) => `${entityId}\u0000${role}`),
        ).size !== participants.length ||
        new Set(participants.map(({ entityId }) => entityId)).size < 2
      )
        throw new Error("身份合并会使当前关系结构无效");
    }
  }

  /** 人工关系始终写入当前代表，不改写已有的来源或人工关系事实。 */
  private normalizeRelationshipChangesWithDrizzle(
    query: DrizzleReadQuery,
    changes: readonly RelationshipChange[],
  ): readonly RelationshipChange[] {
    const forest = this.effectiveIdentityForestWithDrizzle(query);
    return changes.map((change) =>
      change.kind === "create" || change.kind === "replace"
        ? {
            ...change,
            relationship: {
              ...change.relationship,
              participants: change.relationship.participants.map(
                (participant) => ({
                  ...participant,
                  entityId:
                    forest.representativeByEntity.get(participant.entityId) ??
                    participant.entityId,
                }),
              ),
            },
          }
        : change,
    );
  }

  /**
   * 选择人工事实时把被点名那一项记为决定证据，使同一目标下的历史人工事实不再生效；
   * 选择来源事实没有人工证据，沿用该目标当前的来源推导。
   */
  private selectedManualEvidence(
    change: RelationshipChange,
    state: RelationshipProjectionState,
  ): string | undefined {
    return change.kind === "select" &&
      state.manualRelationshipIds.has(change.targetRelationshipId)
      ? change.targetRelationshipId
      : undefined;
  }

  /** 决定只作用于被点名事实的稳定支持范围；范围不唯一时绝不批量修改或任选其一。 */
  private relationshipChangeTarget(
    change: RelationshipChange,
    state: RelationshipProjectionState,
  ): RelationshipDecisionTarget {
    if (change.kind === "create")
      return manualRelationshipTarget(change.definitionId, change.relationship);
    const target = state.targets.get(change.targetRelationshipId);
    if (target === undefined) throw new Error("所选关系不是当前可决定的事实");
    if (
      state.ambiguousRelationshipIds.has(change.targetRelationshipId) ||
      supportedRelationshipCount(state, target) > 1
    )
      throw new Error("所选关系范围不唯一");
    return target;
  }

  /**
   * 为给定事实收集既有支持坐标。一项事实可以同时被来源槽位、观察图槽位或人工决定支持；
   * 出现多个不同稳定支持时它无法被决定点名，投影按规范最小坐标归组而绝不合并。
   */
  private relationshipSupportsWithDrizzle(
    query: DrizzleReadQuery,
    relationshipIds: readonly string[],
  ): RelationshipSupportState {
    if (relationshipIds.length === 0)
      return {
        lifecyclesByRelationshipId: new Map(),
        retractedRelationshipIds: new Set(),
        supersededRelationshipIds: new Set(),
        observedSourceSlotsByRelationshipId: new Map(),
        manualRelationshipIds: new Set(),
        targetsByRelationshipId: new Map(),
        ambiguousRelationshipIds: new Set(),
      };
    const ids = sqliteTextSet(relationshipIds);
    const lifecycles = query
      .select()
      .from(relationshipLifecycles)
      .where(inArray(relationshipLifecycles.relationshipId, ids))
      .all();
    const retractedRelationshipIds = new Set(
      query
        .select({ relationshipId: relationshipRetractions.relationshipId })
        .from(relationshipRetractions)
        .where(inArray(relationshipRetractions.relationshipId, ids))
        .all()
        .map((row) => row.relationshipId),
    );
    const supersededRelationshipIds = new Set(
      query
        .select({
          predecessorId: relationshipLifecycles.predecessorRelationshipId,
        })
        .from(relationshipLifecycles)
        .where(inArray(relationshipLifecycles.predecessorRelationshipId, ids))
        .all()
        .flatMap((row) =>
          row.predecessorId === null ? [] : [row.predecessorId],
        ),
    );
    /**
     * 本地格式观察图不走 SourceRecord lifecycle；它只能由图成员、图 support
     * 与该资产当前 RecognitionDecision 共同支持，不能因为实体关系事实仍在而复活。
     */
    const observedSupportRows = query
      .select({
        relationshipId: observedEntityGraphRelationships.relationshipId,
        sourceSlot: observedEntityGraphRelationships.sourceSlot,
        assetId: observedEntityGraphSupports.assetId,
        artifactId: observedEntityGraphSupports.artifactId,
        producerJson: observedEntityGraphSupports.producerJson,
        coverageId: observedEntityGraphSupports.coverageId,
      })
      .from(observedEntityGraphRelationships)
      .innerJoin(
        observedEntityGraphSupports,
        eq(
          observedEntityGraphRelationships.graphId,
          observedEntityGraphSupports.id,
        ),
      )
      .innerJoin(
        recognitionHeads,
        and(
          eq(recognitionHeads.subjectId, observedEntityGraphSupports.assetId),
          eq(
            recognitionHeads.recognitionDecisionId,
            observedEntityGraphSupports.recognitionDecisionId,
          ),
        ),
      )
      .where(inArray(observedEntityGraphRelationships.relationshipId, ids))
      .all();
    const manualSupportRows = query
      .select({
        relationshipId: relationshipManualSupports.relationshipId,
        targetJson: relationshipDecisions.targetJson,
      })
      .from(relationshipManualSupports)
      .innerJoin(
        relationshipDecisions,
        eq(relationshipManualSupports.decisionId, relationshipDecisions.id),
      )
      .where(inArray(relationshipManualSupports.relationshipId, ids))
      .all();
    const candidatesByRelationshipId = new Map<
      string,
      RelationshipDecisionTarget[]
    >();
    const addCandidate = (
      relationshipId: string,
      target: RelationshipDecisionTarget,
    ): void => {
      const candidates = candidatesByRelationshipId.get(relationshipId) ?? [];
      if (
        !candidates.some(
          (candidate) =>
            relationshipTargetKey(candidate) === relationshipTargetKey(target),
        )
      )
        candidates.push(target);
      candidatesByRelationshipId.set(relationshipId, candidates);
    };
    for (const lifecycle of lifecycles)
      addCandidate(
        lifecycle.relationshipId,
        relationshipSourceTarget(lifecycle),
      );
    for (const support of observedSupportRows)
      addCandidate(support.relationshipId, {
        kind: "observed",
        assetId: support.assetId,
        artifactId: support.artifactId,
        capabilityId: producerFromJson(support.producerJson).capabilityId,
        coverageId: support.coverageId,
        sourceSlot: support.sourceSlot,
      });
    for (const support of manualSupportRows)
      addCandidate(
        support.relationshipId,
        JSON.parse(support.targetJson) as RelationshipDecisionTarget,
      );
    const targetsByRelationshipId = new Map<
      string,
      RelationshipDecisionTarget
    >();
    const ambiguousRelationshipIds = new Set<string>();
    for (const [relationshipId, candidates] of candidatesByRelationshipId) {
      if (candidates.length > 1) ambiguousRelationshipIds.add(relationshipId);
      const target = candidates.toSorted((left, right) =>
        relationshipTargetKey(left).localeCompare(relationshipTargetKey(right)),
      )[0];
      if (target !== undefined)
        targetsByRelationshipId.set(relationshipId, target);
    }
    return {
      lifecyclesByRelationshipId: new Map(
        lifecycles.map((lifecycle) => [lifecycle.relationshipId, lifecycle]),
      ),
      retractedRelationshipIds,
      supersededRelationshipIds,
      observedSourceSlotsByRelationshipId: new Map(
        observedSupportRows.map((support) => [
          support.relationshipId,
          support.sourceSlot,
        ]),
      ),
      manualRelationshipIds: new Set(
        manualSupportRows.map((support) => support.relationshipId),
      ),
      targetsByRelationshipId,
      ambiguousRelationshipIds,
    };
  }

  private relationshipProjectionWithDrizzle(
    query: DrizzleReadQuery,
  ): RelationshipProjectionState {
    const rows = query
      .select()
      .from(entityRelationships)
      .orderBy(asc(entityRelationships.id))
      .all();
    const supports = this.relationshipSupportsWithDrizzle(
      query,
      rows.map((row) => row.id),
    );
    const relationships = rows.flatMap((row) => {
      const lifecycle = supports.lifecyclesByRelationshipId.get(row.id);
      const manuallySupported = supports.manualRelationshipIds.has(row.id);
      const observedSupported =
        supports.observedSourceSlotsByRelationshipId.has(row.id);
      const target = supports.targetsByRelationshipId.get(row.id);
      if (
        target === undefined ||
        (lifecycle === undefined && !manuallySupported && !observedSupported) ||
        ((lifecycle !== undefined || manuallySupported) &&
          (supports.retractedRelationshipIds.has(row.id) ||
            supports.supersededRelationshipIds.has(row.id)))
      )
        return [];
      return [
        {
          id: row.id,
          type: row.type,
          participants: relationshipParticipantsFromJson(row.participantsJson),
          sourceSlot:
            lifecycle?.sourceSlot ??
            supports.observedSourceSlotsByRelationshipId.get(row.id) ??
            "manual",
          sourceRecordIds: jsonStringArray(
            row.sourceRecordIdsJson,
            "relationship source records",
          ),
          qualifiers: JSON.parse(row.qualifiersJson) as NonNullable<
            EntityRelationship["qualifiers"]
          >,
          ...(row.producerJson === null
            ? {}
            : { producer: producerFromJson(row.producerJson) }),
        },
      ];
    });
    const decisions = this.relationshipHeadDecisionsWithDrizzle(query);
    return {
      relationships,
      targets: supports.targetsByRelationshipId,
      decisions,
      manualRelationshipIds: supports.manualRelationshipIds,
      ambiguousRelationshipIds: supports.ambiguousRelationshipIds,
    };
  }

  /** 人工产物角色决定的当前头：一个目标加角色坐标最多一条，装载整个小表。 */
  private artifactRoleDecisionsWithDrizzle(
    query: DrizzleReadQuery,
  ): readonly ArtifactRoleDecision[] {
    return query
      .select({ decision: artifactRoleDecisions })
      .from(artifactRoleDecisionHeads)
      .innerJoin(
        artifactRoleDecisions,
        eq(artifactRoleDecisionHeads.decisionId, artifactRoleDecisions.id),
      )
      .all()
      .map(({ decision }) => artifactRoleDecisionFromRow(decision));
  }

  /** 每个决定目标只有一个当前头；种类与目标共同决定该目标的生效事实。 */
  private relationshipHeadDecisionsWithDrizzle(
    query: DrizzleReadQuery,
  ): readonly RelationshipDecision[] {
    return query
      .select({ decision: relationshipDecisions })
      .from(relationshipDecisionHeads)
      .innerJoin(
        relationshipDecisions,
        eq(relationshipDecisionHeads.decisionId, relationshipDecisions.id),
      )
      .all()
      .map(({ decision }) => ({
        id: decision.id,
        target: JSON.parse(decision.targetJson) as RelationshipDecisionTarget,
        kind: decision.kind as RelationshipDecision["kind"],
        ...(decision.manualRelationshipId === null
          ? {}
          : { manualRelationshipId: decision.manualRelationshipId }),
      }));
  }

  /** 批量解析当前关系出现；列表、详情和关系浏览共同使用同一规则。 */
  private relationshipMentionEntitiesWithDrizzle(
    query: DrizzleReadQuery,
    mentionIds: readonly string[],
  ): ReadonlyMap<string, string> {
    if (mentionIds.length === 0) return new Map();
    const observed = query
      .select()
      .from(observedEntityResolutions)
      .where(
        inArray(observedEntityResolutions.mentionId, sqliteTextSet(mentionIds)),
      )
      .all();
    const decisions = query
      .select()
      .from(entityResolutionDecisions)
      .where(
        inArray(entityResolutionDecisions.mentionId, sqliteTextSet(mentionIds)),
      )
      .orderBy(desc(sql<number>`${entityResolutionDecisions}.rowid`))
      .all();
    const result = new Map(
      observed.map((row) => [row.mentionId, row.entityId]),
    );
    for (const mentionId of mentionIds) {
      if (result.has(mentionId)) continue;
      const candidates = decisions.filter((row) => row.mentionId === mentionId);
      const manual = candidates.find((row) => row.basis === "manual");
      const selected =
        manual?.operation === "select"
          ? manual
          : candidates.find(
              (row) => row.basis === "source" && row.operation === "select",
            );
      if (selected !== undefined) result.set(mentionId, selected.entityId);
    }
    return result;
  }

  async createLocalRelatedEntity(input: {
    readonly commitmentId: string;
    readonly id: string;
    readonly label: string;
    readonly actorId: string;
  }): Promise<RelatedEntityIdentity> {
    const query = drizzle({ client: await this.ensure() });
    return query.transaction((transaction) => {
      const existing = transaction
        .select()
        .from(localEntityCommitments)
        .where(
          and(
            eq(localEntityCommitments.actorId, input.actorId),
            eq(localEntityCommitments.commitmentId, input.commitmentId),
          ),
        )
        .get();
      if (existing !== undefined) {
        if (existing.label !== input.label)
          throw new Error("本地身份提交坐标与既有内容冲突");
        return {
          id: existing.entityId,
          label: existing.label,
          kind: this.entityKindStateWithDrizzle(transaction, existing.entityId)
            .effective,
          identity: "local",
        };
      }
      transaction
        .insert(localEntityCommitments)
        .values({
          actorId: input.actorId,
          commitmentId: input.commitmentId,
          entityId: input.id,
          label: input.label,
        })
        .run();
      transaction
        .insert(entities)
        .values({ id: input.id })
        .onConflictDoNothing()
        .run();
      transaction
        .insert(localEntityNames)
        .values({
          entityId: input.id,
          label: input.label,
          actorId: input.actorId,
        })
        .onConflictDoNothing()
        .run();
      return {
        id: input.id,
        label: input.label,
        kind: this.entityKindStateWithDrizzle(transaction, input.id).effective,
        identity: "local",
      };
    });
  }

  async findRelatedEntities(
    label: string,
  ): Promise<readonly RelatedEntityIdentity[]> {
    if (label.trim().length === 0) return [];
    const query = drizzle({ client: await this.ensure() });
    const forest = this.effectiveIdentityForestWithDrizzle(query);
    const local = query
      .select()
      .from(localEntityNames)
      .where(sql`instr(${localEntityNames.label}, ${label}) > 0`)
      .all();
    const sourced = query
      .select()
      .from(sourcedEntities)
      .where(sql`instr(${sourcedEntities.label}, ${label}) > 0`)
      .all();
    const observed = this.currentObservedEntityRowsWithDrizzle(query).filter(
      (row) => row.label.includes(label),
    );
    // 数字资产的显示与别名名称来自正式名称断言，而不是标签列；参与查找但不建立身份等价。
    const names = query
      .select({
        entityId: metadataAssertions.subjectId,
        label: metadataAssertions.value,
      })
      .from(metadataAssertions)
      .where(
        and(
          inArray(metadataAssertions.property, RELATED_ENTITY_NAME_PROPERTIES),
          eq(metadataAssertions.isCurrent, 1),
          sql`instr(${metadataAssertions.value}, ${label}) > 0`,
        ),
      )
      .all();
    const candidates = [
      ...local.map((row) => ({
        id: row.entityId,
        label: row.label,
        identity: "local" as const,
      })),
      ...sourced.map((row) => ({
        id: row.id,
        label: row.label,
        identity: "source" as const,
      })),
      ...observed.map((row) => ({
        id: row.id,
        label: row.label,
        identity: "local" as const,
      })),
    ];
    const found = new Map(
      candidates.map((candidate) => {
        const representativeId =
          forest.representativeByEntity.get(candidate.id) ?? candidate.id;
        return [
          representativeId,
          {
            ...candidate,
            id: representativeId,
            kind: this.relatedEntityKindWithDrizzle(query, representativeId),
          },
        ] as const;
      }),
    );
    for (const name of names) {
      const representativeId =
        forest.representativeByEntity.get(name.entityId) ?? name.entityId;
      if (found.has(representativeId)) continue;
      found.set(representativeId, {
        id: representativeId,
        label: name.label,
        kind: this.relatedEntityKindWithDrizzle(query, representativeId),
        identity: "source" as const,
      });
    }
    return [...found.values()];
  }

  async previewEntityIdentityMerge(input: {
    readonly retainedEntityId: string;
    readonly mergedEntityId: string;
  }): Promise<EntityIdentityMergePreview> {
    const query = drizzle({ client: await this.ensure() });
    return this.entityIdentityMergePreviewWithDrizzle(query, input);
  }

  async findEntityIdentityMergeReplay(input: {
    readonly actorId: string;
    readonly commitmentId: string;
  }): Promise<
    | {
        readonly retainedEntityId: string;
        readonly mergedEntityId: string;
        readonly impactFingerprint: string;
      }
    | undefined
  > {
    const query = drizzle({ client: await this.ensure() });
    return query
      .select({
        retainedEntityId: entityIdentityMerges.retainedEntityId,
        mergedEntityId: entityIdentityMerges.mergedEntityId,
        impactFingerprint: entityIdentityMerges.impactFingerprint,
      })
      .from(entityIdentityMerges)
      .where(
        and(
          eq(entityIdentityMerges.actorId, input.actorId),
          eq(entityIdentityMerges.commitmentId, input.commitmentId),
        ),
      )
      .get();
  }

  async applyEntityIdentityMerge(input: {
    readonly id: string;
    readonly commitmentId: string;
    readonly actorId: string;
    readonly preview: EntityIdentityMergePreview;
    readonly impactFingerprint: string;
  }): Promise<"applied" | "stale"> {
    const query = drizzle({ client: await this.ensure() });
    return query.transaction((transaction) => {
      const replay = transaction
        .select()
        .from(entityIdentityMerges)
        .where(
          and(
            eq(entityIdentityMerges.actorId, input.actorId),
            eq(entityIdentityMerges.commitmentId, input.commitmentId),
          ),
        )
        .get();
      if (replay !== undefined) {
        if (
          replay.retainedEntityId !== input.preview.retainedEntityId ||
          replay.mergedEntityId !== input.preview.mergedEntityId ||
          replay.impactFingerprint !== input.impactFingerprint
        )
          throw new Error("身份合并提交坐标与既有内容冲突");
        return "applied" as const;
      }
      const current = this.entityIdentityMergePreviewWithDrizzle(transaction, {
        retainedEntityId: input.preview.retainedEntityId,
        mergedEntityId: input.preview.mergedEntityId,
      });
      if (current.mergeId !== undefined)
        throw new Error("身份合并已经采用；请重用原提交标识");
      if (current.baseline !== input.preview.baseline) return "stale" as const;
      transaction
        .insert(entityIdentityMerges)
        .values({
          id: input.id,
          retainedEntityId: input.preview.retainedEntityId,
          mergedEntityId: input.preview.mergedEntityId,
          actorId: input.actorId,
          commitmentId: input.commitmentId,
          impactFingerprint: input.impactFingerprint,
        })
        .run();
      return "applied" as const;
    });
  }

  async undoEntityIdentityMerge(input: {
    readonly id: string;
    readonly commitmentId: string;
    readonly actorId: string;
    readonly preview: EntityIdentityMergePreview;
  }): Promise<"applied" | "stale"> {
    const mergeId = input.preview.mergeId;
    if (mergeId === undefined) throw new Error("当前没有可撤销的身份合并");
    const query = drizzle({ client: await this.ensure() });
    return query.transaction((transaction) => {
      const replay = transaction
        .select()
        .from(entityIdentityMergeRetractions)
        .where(
          and(
            eq(entityIdentityMergeRetractions.actorId, input.actorId),
            eq(entityIdentityMergeRetractions.commitmentId, input.commitmentId),
          ),
        )
        .get();
      if (replay !== undefined) {
        if (replay.mergeId !== mergeId)
          throw new Error("身份合并撤销提交坐标与既有内容冲突");
        return "applied" as const;
      }
      const current = this.entityIdentityMergePreviewWithDrizzle(transaction, {
        retainedEntityId: input.preview.retainedEntityId,
        mergedEntityId: input.preview.mergedEntityId,
      });
      // 撤销只能绑定预演实体对精确重算出的当前可撤销合并，调用方不能把预演指向另一目标。
      if (current.mergeId !== mergeId) return "stale" as const;
      if (current.baseline !== input.preview.baseline) return "stale" as const;
      transaction
        .insert(entityIdentityMergeRetractions)
        .values({
          id: input.id,
          mergeId: current.mergeId,
          actorId: input.actorId,
          commitmentId: input.commitmentId,
        })
        .run();
      return "applied" as const;
    });
  }

  private effectiveIdentityForestWithDrizzle(query: DrizzleReadQuery) {
    return deriveEffectiveEntityIdentity({
      entityIds: query
        .select({ id: entities.id })
        .from(entities)
        .all()
        .map(({ id }) => id),
      merges: query
        .select()
        .from(entityIdentityMerges)
        .all()
        .map((merge) => ({
          id: merge.id,
          retainedEntityId: merge.retainedEntityId,
          mergedEntityId: merge.mergedEntityId,
          actorId: merge.actorId,
          commitmentId: merge.commitmentId,
        })),
      retractions: query
        .select()
        .from(entityIdentityMergeRetractions)
        .all()
        .map((retraction) => ({
          id: retraction.id,
          mergeId: retraction.mergeId,
          actorId: retraction.actorId,
          commitmentId: retraction.commitmentId,
        })),
    });
  }

  /**
   * 只沿给定实体反复读取端点触及的合并与其撤回，得到本批所需的代表映射；
   * 身份求值仍由领域森林负责，但装载不再遍历全部实体。
   */
  private identityRepresentativesWithinWithDrizzle(
    query: DrizzleReadQuery,
    entityIds: readonly string[],
  ): ReadonlyMap<string, string> {
    const closure = new Set(entityIds);
    const merges: (typeof entityIdentityMerges.$inferSelect)[] = [];
    const retractions: (typeof entityIdentityMergeRetractions.$inferSelect)[] =
      [];
    let frontier = [...closure];
    while (frontier.length > 0) {
      const reached = query
        .select()
        .from(entityIdentityMerges)
        .where(
          or(
            inArray(
              entityIdentityMerges.retainedEntityId,
              sqliteTextSet(frontier),
            ),
            inArray(
              entityIdentityMerges.mergedEntityId,
              sqliteTextSet(frontier),
            ),
          ),
        )
        .all();
      /** 先按本轮候选桥 ID 有界取撤回，再决定扩张：已撤回的桥不会把闭包带到对面。 */
      const reachedMergeIds = uniqueStrings(reached.map((merge) => merge.id));
      const retractionRows =
        reachedMergeIds.length === 0
          ? []
          : query
              .select()
              .from(entityIdentityMergeRetractions)
              .where(
                inArray(
                  entityIdentityMergeRetractions.mergeId,
                  sqliteTextSet(reachedMergeIds),
                ),
              )
              .all();
      for (const row of retractionRows)
        if (!retractions.some((item) => item.id === row.id))
          retractions.push(row);
      const retractedMergeIds = new Set(
        retractionRows.map((row) => row.mergeId),
      );
      const active = reached.filter(
        (merge) => !retractedMergeIds.has(merge.id),
      );
      for (const merge of active)
        if (!merges.some((item) => item.id === merge.id)) merges.push(merge);
      frontier = uniqueStrings(
        active
          .flatMap((merge) => [merge.retainedEntityId, merge.mergedEntityId])
          .filter((entityId) => !closure.has(entityId)),
      );
      for (const entityId of frontier) closure.add(entityId);
    }
    if (merges.length === 0) return new Map();
    return deriveEffectiveEntityIdentity({
      entityIds: [...closure],
      merges,
      retractions,
    }).representativeByEntity;
  }

  private entityIdentityMergePreviewWithDrizzle(
    query: DrizzleReadQuery,
    input: {
      readonly retainedEntityId: string;
      readonly mergedEntityId: string;
    },
  ): EntityIdentityMergePreview {
    if (input.retainedEntityId === input.mergedEntityId)
      throw new Error("不能将实体合并到自身");
    const entityIds = query
      .select({ id: entities.id })
      .from(entities)
      .all()
      .map(({ id }) => id);
    if (
      !entityIds.includes(input.retainedEntityId) ||
      !entityIds.includes(input.mergedEntityId)
    )
      throw new Error("待合并相关实体不存在");
    if (
      query
        .select()
        .from(recognitionHeads)
        .where(
          inArray(
            recognitionHeads.subjectId,
            sqliteTextSet([input.retainedEntityId, input.mergedEntityId]),
          ),
        )
        .get() !== undefined
    )
      throw new Error("数字资产不能进行身份合并");
    const merges = query.select().from(entityIdentityMerges).all();
    const retractions = query
      .select()
      .from(entityIdentityMergeRetractions)
      .all();
    const forest = deriveEffectiveEntityIdentity({
      entityIds,
      merges,
      retractions,
    });
    const retainedRoot = forest.representativeByEntity.get(
      input.retainedEntityId,
    )!;
    const mergedRoot = forest.representativeByEntity.get(input.mergedEntityId)!;
    const retainedMembers = forest.membersByRepresentative.get(
      retainedRoot,
    ) ?? [retainedRoot];
    const mergedMembers = forest.membersByRepresentative.get(mergedRoot) ?? [
      mergedRoot,
    ];
    const exact = merges.find(
      (merge) =>
        merge.retainedEntityId === input.retainedEntityId &&
        merge.mergedEntityId === input.mergedEntityId &&
        !retractions.some((retraction) => retraction.mergeId === merge.id),
    );
    if (
      retainedRoot !== mergedRoot &&
      (!this.hasCurrentRelatedEntityInGroupWithDrizzle(
        query,
        retainedMembers,
      ) ||
        !this.hasCurrentRelatedEntityInGroupWithDrizzle(query, mergedMembers))
    )
      throw new Error("待合并相关实体不是当前身份");
    if (
      retainedRoot === mergedRoot &&
      exact !== undefined &&
      !this.hasCurrentRelatedEntityInGroupWithDrizzle(query, retainedMembers)
    )
      throw new Error("待合并相关实体不是当前身份");
    const affectedMemberIds = uniqueStrings([
      ...retainedMembers,
      ...mergedMembers,
    ]);
    const metadata = query
      .select({
        entityId: metadataAssertions.targetEntityId,
        property: metadataAssertions.property,
        value: metadataAssertions.value,
        id: metadataAssertions.id,
        sourceRecordIdsJson: metadataAssertions.sourceRecordIdsJson,
        authoredByJson: metadataAssertions.authoredByJson,
        observedArtifactPartJson: metadataAssertions.observedArtifactPartJson,
      })
      .from(metadataAssertions)
      .where(
        and(
          eq(metadataAssertions.targetKind, "entity"),
          inArray(
            metadataAssertions.targetEntityId,
            sqliteTextSet(affectedMemberIds),
          ),
        ),
      )
      .all()
      .map(
        ({
          entityId,
          property,
          value,
          id,
          sourceRecordIdsJson,
          authoredByJson,
          observedArtifactPartJson,
        }) => ({
          entityId: entityId!,
          property,
          value,
          id,
          sourceRecordIdsJson,
          authoredByJson,
          observedArtifactPartJson,
        }),
      );
    const metadataIds = metadata.map(({ id }) => id);
    const metadataLifecycles =
      metadataIds.length === 0
        ? []
        : query
            .select()
            .from(metadataAssertionLifecycles)
            .where(
              inArray(
                metadataAssertionLifecycles.assertionId,
                sqliteTextSet(metadataIds),
              ),
            )
            .all();
    const supersededMetadataIds = new Set(
      metadataIds.length === 0
        ? []
        : query
            .select({
              predecessorAssertionId:
                metadataAssertionLifecycles.predecessorAssertionId,
            })
            .from(metadataAssertionLifecycles)
            .where(
              inArray(
                metadataAssertionLifecycles.predecessorAssertionId,
                sqliteTextSet(metadataIds),
              ),
            )
            .all()
            .flatMap(({ predecessorAssertionId }) =>
              predecessorAssertionId === null ? [] : [predecessorAssertionId],
            ),
    );
    const retractedMetadataIds = new Set(
      metadataIds.length === 0
        ? []
        : query
            .select({ assertionId: metadataAssertionRetractions.assertionId })
            .from(metadataAssertionRetractions)
            .where(
              inArray(
                metadataAssertionRetractions.assertionId,
                sqliteTextSet(metadataIds),
              ),
            )
            .all()
            .map(({ assertionId }) => assertionId),
    );
    const currentSourceRecordIds = new Set(
      query
        .select({ sourceRecordId: sourceLineageHeads.sourceRecordId })
        .from(sourceLineageHeads)
        .all()
        .map(({ sourceRecordId }) => sourceRecordId),
    );
    const currentSourceCoordinates = new Set(
      query
        .select({
          sourceIdentity: sourceAssociations.sourceIdentity,
          nativeAddress: sourceAssociations.nativeAddress,
        })
        .from(currentSourceAssociations)
        .innerJoin(
          sourceAssociations,
          eq(sourceAssociations.id, currentSourceAssociations.associationId),
        )
        .all()
        .map(
          ({ sourceIdentity, nativeAddress }) =>
            `${sourceIdentity}\u0000${nativeAddress}`,
        ),
    );
    const metadataLifecycleById = new Map(
      metadataLifecycles.map((lifecycle) => [lifecycle.assertionId, lifecycle]),
    );
    const currentMetadata = metadata.filter((assertion) => {
      if (
        supersededMetadataIds.has(assertion.id) ||
        retractedMetadataIds.has(assertion.id)
      )
        return false;
      const lifecycle = metadataLifecycleById.get(assertion.id);
      if (lifecycle !== undefined)
        return (
          currentSourceRecordIds.has(lifecycle.sourceRecordId) ||
          currentSourceCoordinates.has(
            `${lifecycle.sourceIdentity}\u0000${lifecycle.nativeAddress}`,
          )
        );
      return (
        assertion.authoredByJson !== null ||
        assertion.observedArtifactPartJson !== null ||
        assertion.sourceRecordIdsJson === "[]"
      );
    });
    const affectedKindStates = this.entityKindStatesWithDrizzle(
      query,
      affectedMemberIds,
    );
    const effectiveKinds = affectedMemberIds
      .map((entityId) => affectedKindStates.get(entityId)!.effective)
      .filter(
        (
          effective,
        ): effective is Extract<EffectiveEntityKind, { status: "effective" }> =>
          effective.status === "effective",
      );
    const relationshipState = this.relationshipProjectionWithDrizzle(query);
    const effectiveRelationshipIds = new Set(
      deriveEffectiveRelationships({
        relationships: relationshipState.relationships,
        targets: relationshipState.targets,
        decisions: relationshipState.decisions,
        manualRelationshipIds: relationshipState.manualRelationshipIds,
      }).map(({ id }) => id),
    );
    const affectedRelationships = relationshipState.relationships.filter(
      (relationship) =>
        effectiveRelationshipIds.has(relationship.id) &&
        relationship.participants.some(({ entityId }) =>
          affectedMemberIds.includes(entityId),
        ),
    );
    const relationshipIds: string[] = [];
    for (const relationship of affectedRelationships) {
      const projectedParticipants = relationship.participants.map(
        (participant) => {
          const root = forest.representativeByEntity.get(participant.entityId)!;
          return {
            ...participant,
            entityId: root === mergedRoot ? retainedRoot : root,
          };
        },
      );
      if (
        relationship.participants.some(({ entityId }) =>
          affectedMemberIds.includes(entityId),
        )
      )
        relationshipIds.push(relationship.id);
      if (
        new Set(
          projectedParticipants.map(
            ({ entityId, role }) => `${entityId}\u0000${role}`,
          ),
        ).size !== projectedParticipants.length ||
        new Set(projectedParticipants.map(({ entityId }) => entityId)).size < 2
      )
        throw new Error("身份合并会使现有关系结构无效");
    }
    if (retainedRoot === mergedRoot && exact === undefined)
      throw new Error("身份合并必须连接两个不同当前根");
    return {
      retainedEntityId: exact?.retainedEntityId ?? retainedRoot,
      mergedEntityId: exact?.mergedEntityId ?? mergedRoot,
      members:
        exact === undefined
          ? affectedMemberIds
          : (forest.membersByRepresentative.get(retainedRoot) ?? []),
      relationshipIds,
      metadata: currentMetadata.map(({ entityId, property, value }) => ({
        entityId,
        property,
        value,
      })),
      metadataConflicts: [],
      metadataPolicyBaseline: "",
      effectiveKind: effectiveKinds[0] ?? { status: "ordinary" },
      baseline: sha256Text(
        JSON.stringify({
          merges,
          retractions,
          members: affectedMemberIds,
          metadata: currentMetadata,
          metadataLifecycles,
          metadataRetractions: [...retractedMetadataIds],
          kinds: affectedMemberIds.map((entityId) => ({
            entityId,
            baseline: affectedKindStates.get(entityId)!.baseline,
          })),
          relationships: affectedRelationships,
          // 只有会影响受关事实投影的决定才让合并预览过期，无关目标上的决定不得连带过期。
          decisions: relationshipState.decisions.filter((decision) =>
            affectedRelationships.some(
              (relationship) =>
                relationshipTargetKey(
                  relationshipState.targets.get(relationship.id)!,
                ) === relationshipTargetKey(decision.target),
            ),
          ),
        }),
      ),
      ...(exact === undefined ? {} : { mergeId: exact.id }),
    };
  }

  async resolveEntityMentionManually(input: {
    readonly id: string;
    readonly mentionId: string;
    readonly entityId: string;
    readonly actorId: string;
    readonly baseline: string;
  }): Promise<"applied" | "stale"> {
    const query = drizzle({ client: await this.ensure() });
    return query.transaction((transaction) => {
      const forest = this.effectiveIdentityForestWithDrizzle(transaction);
      const representativeId =
        forest.representativeByEntity.get(input.entityId) ?? input.entityId;
      if (
        transaction
          .select({ id: entityMentions.id })
          .from(entityMentions)
          .where(eq(entityMentions.id, input.mentionId))
          .get() === undefined
      )
        throw new Error("待消歧实体指称不存在");
      if (
        transaction
          .select({ id: entities.id })
          .from(entities)
          .where(eq(entities.id, representativeId))
          .get() === undefined
      )
        throw new Error("所选相关实体不存在");
      const current = this.entityMentionResolutionWithDrizzle(
        transaction,
        input.mentionId,
      );
      if (current.baseline !== input.baseline) return "stale" as const;
      transaction
        .insert(entityResolutionDecisions)
        .values({
          id: input.id,
          mentionId: input.mentionId,
          entityId: representativeId,
          rule: "manual",
          basis: "manual",
          replacesDecisionId: current.decisionId ?? null,
          sourceRecordIdsJson: "[]",
          producerJson: null,
          actorId: input.actorId,
          operation: "select",
        })
        .run();
      return "applied" as const;
    });
  }

  async inspectEntityMentionResolution(
    mentionId: string,
  ): Promise<EntityMentionResolution> {
    const query = drizzle({ client: await this.ensure() });
    return this.entityMentionResolutionWithDrizzle(query, mentionId);
  }

  async retractEntityMentionResolution(input: {
    readonly id: string;
    readonly mentionId: string;
    readonly actorId: string;
    readonly baseline: string;
  }): Promise<"applied" | "stale"> {
    const query = drizzle({ client: await this.ensure() });
    return query.transaction((transaction) => {
      const current = this.entityMentionResolutionWithDrizzle(
        transaction,
        input.mentionId,
      );
      if (current.baseline !== input.baseline) return "stale" as const;
      if (current.basis !== "manual" || current.entityId === undefined)
        throw new Error("当前没有可撤回的人工实体消歧");
      transaction
        .insert(entityResolutionDecisions)
        .values({
          id: input.id,
          mentionId: input.mentionId,
          entityId: current.entityId,
          rule: "manual",
          basis: "manual",
          replacesDecisionId: current.decisionId ?? null,
          sourceRecordIdsJson: "[]",
          producerJson: null,
          actorId: input.actorId,
          operation: "retract",
        })
        .run();
      return "applied" as const;
    });
  }

  private entityKindStateWithDrizzle(
    query: DrizzleReadQuery,
    entityId: string,
  ): {
    readonly effective: EffectiveEntityKind;
    readonly baseline: string;
  } {
    return this.entityKindStatesWithDrizzle(query, [entityId]).get(entityId)!;
  }

  /** 当前种类的唯一批量投影：只由现有数字资产断言推导。 */
  private entityKindStatesWithDrizzle(
    query: DrizzleReadQuery,
    entityIds: readonly string[],
  ): ReadonlyMap<
    string,
    { readonly effective: EffectiveEntityKind; readonly baseline: string }
  > {
    const ids = uniqueStrings(entityIds);
    if (ids.length === 0) return new Map();
    const assertions = query
      .select()
      .from(entityKindAssertions)
      .where(inArray(entityKindAssertions.entityId, sqliteTextSet(ids)))
      .all();
    const assertionsByEntity = new Map<string, (typeof assertions)[number][]>();
    for (const assertion of assertions)
      (
        assertionsByEntity.get(assertion.entityId) ??
        assertionsByEntity.set(assertion.entityId, []).get(assertion.entityId)!
      ).push(assertion);
    const result = new Map<
      string,
      { readonly effective: EffectiveEntityKind; readonly baseline: string }
    >();
    for (const entityId of ids) {
      const currentAssertions = assertionsByEntity.get(entityId) ?? [];
      const effective: EffectiveEntityKind = currentAssertions.some(
        (assertion) => assertion.kind === "digital-asset",
      )
        ? { status: "effective", kind: "digital-asset", basis: "assertion" }
        : { status: "ordinary" };
      const baseline = createHash("sha256")
        .update(
          JSON.stringify(
            currentAssertions
              .map(({ id, kind, basis }) => ({ id, kind, basis }))
              .toSorted((left, right) => left.id.localeCompare(right.id)),
          ),
        )
        .digest("hex");
      result.set(entityId, { effective, baseline });
    }
    return result;
  }

  private relatedEntityKindWithDrizzle(
    query: DrizzleReadQuery,
    entityId: string,
  ): EffectiveEntityKind {
    return this.effectiveEntityKindStateWithDrizzle(query, entityId).effective;
  }

  /**
   * 观察身份只有在其图成员、图支持和该资产当前识别头同时成立时才可参与公开查询。
   * 历史图保留作审计，但绝不借由实体表本身重新进入当前投影。
   */
  private currentObservedEntityRowsWithDrizzle(
    query: DrizzleReadQuery,
  ): readonly {
    readonly id: string;
    readonly assetId: string;
    readonly label: string;
  }[] {
    return query
      .select({
        id: observedEntities.id,
        assetId: observedEntities.assetId,
        label: observedEntities.label,
      })
      .from(observedEntityGraphEntities)
      .innerJoin(
        observedEntityGraphSupports,
        eq(observedEntityGraphEntities.graphId, observedEntityGraphSupports.id),
      )
      .innerJoin(
        recognitionHeads,
        and(
          eq(recognitionHeads.subjectId, observedEntityGraphSupports.assetId),
          eq(
            recognitionHeads.recognitionDecisionId,
            observedEntityGraphSupports.recognitionDecisionId,
          ),
        ),
      )
      .innerJoin(
        observedEntities,
        eq(observedEntities.id, observedEntityGraphEntities.entityId),
      )
      .all();
  }

  /** 当前观察身份与既有本地／来源身份均可参与相关实体操作。 */
  private hasCurrentRelatedEntityInGroupWithDrizzle(
    query: DrizzleReadQuery,
    entityIds: readonly string[],
  ): boolean {
    if (
      this.currentObservedEntityRowsWithDrizzle(query).some((row) =>
        entityIds.includes(row.id),
      )
    )
      return true;
    return (
      query
        .select({ id: localEntityNames.entityId })
        .from(localEntityNames)
        .where(inArray(localEntityNames.entityId, sqliteTextSet(entityIds)))
        .get() !== undefined ||
      query
        .select({ id: sourcedEntities.id })
        .from(sourcedEntities)
        .where(inArray(sourcedEntities.id, sqliteTextSet(entityIds)))
        .get() !== undefined
    );
  }

  /**
   * 各实体先按原有规则投影种类，再在当前身份成员间汇集；保留者没有优先级。
   */
  private effectiveEntityKindStateWithDrizzle(
    query: DrizzleReadQuery,
    entityId: string,
  ): {
    readonly entityId: string;
    readonly effective: EffectiveEntityKind;
    readonly baseline: string;
  } {
    const forest = this.effectiveIdentityForestWithDrizzle(query);
    const representativeId =
      forest.representativeByEntity.get(entityId) ?? entityId;
    const memberIds = forest.membersByRepresentative.get(representativeId) ?? [
      representativeId,
    ];
    const states = this.entityKindStatesWithDrizzle(query, memberIds);
    const effectiveKinds = memberIds
      .map((memberId) => states.get(memberId)!.effective)
      .filter(
        (
          effective,
        ): effective is Extract<EffectiveEntityKind, { status: "effective" }> =>
          effective.status === "effective",
      );
    return {
      entityId: representativeId,
      effective: effectiveKinds[0] ?? { status: "ordinary" },
      baseline: sha256Text(
        JSON.stringify({
          representativeId,
          members: memberIds,
          states: memberIds.map((memberId) => ({
            entityId: memberId,
            baseline: states.get(memberId)!.baseline,
          })),
          merges: query.select().from(entityIdentityMerges).all(),
          retractions: query
            .select()
            .from(entityIdentityMergeRetractions)
            .all(),
        }),
      ),
    };
  }

  /** 资产读者共享这一批量生效种类投影。 */
  private currentEffectiveDigitalAssetIdsWithDrizzle(
    query: DrizzleReadQuery,
    entityIds: readonly string[],
  ): readonly string[] {
    const states = this.entityKindStatesWithDrizzle(query, entityIds);
    return entityIds.filter((entityId) => {
      const effective = states.get(entityId)?.effective;
      return (
        effective?.status === "effective" && effective.kind === "digital-asset"
      );
    });
  }

  private entityMentionResolutionWithDrizzle(
    query: DrizzleReadQuery,
    mentionId: string,
  ): EntityMentionResolution {
    const mention = query
      .select()
      .from(entityMentions)
      .where(eq(entityMentions.id, mentionId))
      .get();
    if (mention === undefined) throw new Error("待消歧实体指称不存在");
    const decisions = query
      .select()
      .from(entityResolutionDecisions)
      .where(eq(entityResolutionDecisions.mentionId, mentionId))
      .orderBy(desc(sql<number>`${entityResolutionDecisions}.rowid`))
      .all();
    const latestManual = decisions.find((row) => row.basis === "manual");
    const source = decisions.find(
      (row) => row.basis === "source" && row.operation === "select",
    );
    const chosen = latestManual?.operation === "select" ? latestManual : source;
    const baseline = createHash("sha256")
      .update(
        JSON.stringify({
          manual: latestManual?.id ?? null,
          source: source?.id ?? null,
          merges: query.select().from(entityIdentityMerges).all(),
          retractions: query
            .select()
            .from(entityIdentityMergeRetractions)
            .all(),
        }),
      )
      .digest("hex");
    return {
      mentionId,
      label: mention.label,
      ...(chosen === undefined
        ? {}
        : {
            entityId:
              this.effectiveIdentityForestWithDrizzle(
                query,
              ).representativeByEntity.get(chosen.entityId) ?? chosen.entityId,
            basis: chosen.basis as "source" | "manual",
            decisionId: chosen.id,
          }),
      ...(chosen?.actorId === null || chosen?.actorId === undefined
        ? {}
        : { actorId: chosen.actorId }),
      sourceRecordIds:
        chosen === undefined
          ? (JSON.parse(mention.sourceRecordIdsJson) as string[])
          : (JSON.parse(chosen.sourceRecordIdsJson) as string[]),
      baseline,
    };
  }

  async readPlaybackInteractions(revisionIds: readonly string[]) {
    if (revisionIds.length === 0) return [];
    const query = drizzle({ client: await this.ensure() });
    this.requireDefaultLocalUser(query);
    return query
      .select({
        artifactRevisionId: artifactInteractionStates.revisionId,
        positionMilliseconds: artifactInteractionStates.positionMilliseconds,
        completed: artifactInteractionStates.completed,
      })
      .from(artifactInteractionStates)
      .where(
        and(
          eq(artifactInteractionStates.userId, "local-user"),
          inArray(
            artifactInteractionStates.revisionId,
            sqliteTextSet(revisionIds),
          ),
        ),
      )
      .orderBy(asc(artifactInteractionStates.revisionId))
      .all()
      .map((row) => ({ ...row, completed: row.completed === 1 }));
  }

  async savePlaybackInteraction(
    input: import("@digital/domain").AssetInteractionState,
  ): Promise<void> {
    const query = drizzle({ client: await this.ensure() });
    this.requireDefaultLocalUser(query);
    const revision = query
      .select({ id: artifactRevisions.id })
      .from(artifactRevisions)
      .where(eq(artifactRevisions.id, input.artifactRevisionId))
      .get();
    if (revision === undefined) throw new Error("文件修订版不存在");
    query
      .insert(artifactInteractionStates)
      .values({
        userId: "local-user",
        revisionId: input.artifactRevisionId,
        positionMilliseconds: input.positionMilliseconds,
        completed: input.completed ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [
          artifactInteractionStates.userId,
          artifactInteractionStates.revisionId,
        ],
        set: {
          positionMilliseconds: input.positionMilliseconds,
          completed: input.completed ? 1 : 0,
        },
      })
      .run();
  }

  private requireDefaultLocalUser(query: ReturnType<typeof drizzle>): void {
    const users = query
      .select({ userId: localUsers.userId })
      .from(localUsers)
      .all();
    if (users.length !== 1 || users[0]?.userId !== "local-user")
      throw new Error("本地用户身份未准备");
  }

  async readArtifactRevisionAccessFacts(revisionId: string) {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const revision = query
      .select({
        id: artifactRevisions.id,
        artifactId: artifactRevisions.artifactId,
        blobDigest: artifactRevisions.blobDigest,
        byteLength: blobs.byteLength,
        mediaType: blobs.mediaType,
      })
      .from(artifactRevisions)
      .innerJoin(blobs, eq(artifactRevisions.blobDigest, blobs.digest))
      .where(eq(artifactRevisions.id, revisionId))
      .get();
    if (revision === undefined) return undefined;
    const locationRows = query
      .select({
        id: locations.id,
        kind: locations.kind,
        address: locations.address,
      })
      .from(locations)
      .where(eq(locations.artifactId, revision.artifactId))
      .orderBy(asc(locations.id))
      .all();
    const observedConfirmations = query
      .select()
      .from(observedRevisionConfirmations)
      .where(eq(observedRevisionConfirmations.revisionId, revision.id))
      .all();
    const accessLocations: ArtifactRevisionAccessFacts["locations"] =
      locationRows.flatMap(
        (location): ArtifactRevisionAccessFacts["locations"] => {
          if (location.kind === "managed")
            return [
              {
                kind: "managed",
                locationId: location.id,
                address: location.address,
              },
            ];
          if (location.kind !== "observed") return [];
          const confirmation = observedConfirmations.find(
            (candidate) => candidate.locationId === location.id,
          );
          const confirmedObservation =
            confirmation === undefined
              ? undefined
              : {
                  snapshotId: confirmation.snapshotId,
                  observedAt: confirmation.observedAt,
                  size: confirmation.size,
                  modifiedAt: confirmation.modifiedAt,
                };
          if (confirmedObservation === undefined) return [];
          return [
            {
              kind: "observed",
              locationId: location.id,
              address: location.address,
              confirmedObservation,
              confirmationBaseline: confirmation!.conditionalBaseline,
            },
          ];
        },
      );
    return {
      revision: {
        id: revision.id,
        artifactId: revision.artifactId,
        blobDigest: revision.blobDigest,
      },
      blob: {
        digest: revision.blobDigest,
        byteLength: revision.byteLength,
        mediaType: revision.mediaType,
      },
      locations: accessLocations,
    };
  }

  async readArtifactContentProof(
    blobDigest: string,
  ): Promise<ArtifactContentProofMetadata | undefined> {
    const database = await this.ensure();
    const row = drizzle({ client: database })
      .select()
      .from(artifactContentProofs)
      .where(eq(artifactContentProofs.blobDigest, blobDigest))
      .get();
    return row === undefined
      ? undefined
      : {
          blobDigest: row.blobDigest,
          scheme: "artifact-frame-manifest/1",
          byteLength: row.byteLength,
          frameSize: 1_048_576,
          frameCount: row.frameCount,
          manifestDigest: row.manifestDigest,
        };
  }

  async adoptArtifactContentProof(
    input: Parameters<
      ArtifactContentProofCommands["adoptArtifactContentProof"]
    >[0],
  ): Promise<"committed" | "already-committed" | "stale"> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    return query.transaction(
      (transaction) => {
        const revision = transaction
          .select()
          .from(artifactRevisions)
          .where(eq(artifactRevisions.id, input.expected.revisionId))
          .get();
        const blob = transaction
          .select()
          .from(blobs)
          .where(eq(blobs.digest, input.expected.blobDigest))
          .get();
        const location = transaction
          .select()
          .from(locations)
          .where(eq(locations.id, input.expected.locationId))
          .get();
        if (
          revision?.artifactId !== input.expected.artifactId ||
          revision.blobDigest !== input.expected.blobDigest ||
          blob?.byteLength !== input.expected.blobByteLength ||
          location?.artifactId !== input.expected.artifactId ||
          location.kind !== input.expected.locationKind ||
          !proofMetadataMatchesBlob(input.proof, blob.digest, blob.byteLength)
        )
          return "stale" as const;
        const baseline = artifactProofConditionalBaseline({
          revisionId: revision.id,
          artifactId: revision.artifactId,
          blobDigest: blob.digest,
          blobByteLength: blob.byteLength,
          locationId: location.id,
          locationKind: location.kind,
        });
        if (baseline !== input.expected.conditionalBaseline)
          return "stale" as const;
        if (input.expected.locationKind === "observed") {
          const authority = input.expected.observedAuthority;
          const confirmation = transaction
            .select()
            .from(observedRevisionConfirmations)
            .where(
              and(
                eq(observedRevisionConfirmations.revisionId, revision.id),
                eq(observedRevisionConfirmations.locationId, location.id),
              ),
            )
            .get();
          const registration =
            authority === undefined
              ? undefined
              : transaction
                  .select()
                  .from(observedRootRegistrations)
                  .where(
                    eq(observedRootRegistrations.id, authority.registrationId),
                  )
                  .get();
          if (
            authority === undefined ||
            confirmation?.locationId !== location.id ||
            confirmation.conditionalBaseline !==
              authority.confirmationBaseline ||
            registration?.status !== "active" ||
            registration.configVersion !== authority.registrationVersion
          )
            return "stale" as const;
        }
        const existing = transaction
          .select()
          .from(artifactContentProofs)
          .where(eq(artifactContentProofs.blobDigest, blob.digest))
          .get();
        if (existing !== undefined)
          return proofRowEquals(existing, input.proof)
            ? ("already-committed" as const)
            : ("stale" as const);
        transaction.insert(artifactContentProofs).values(input.proof).run();
        return "committed" as const;
      },
      { behavior: "immediate" },
    );
  }

  async observedFileSelectionForLocation(
    locationId: string,
  ): Promise<string | undefined> {
    const database = await this.ensure();
    return observedSelectionFacts(drizzle({ client: database }), locationId)
      ?.selectionId;
  }

  async readObservedFileConfirmationFacts(
    selectionId: string,
  ): Promise<ObservedFileConfirmationFacts | undefined> {
    if (!/^observed-file-selection_1_[a-f0-9]{64}$/u.test(selectionId))
      return undefined;
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const observedLocations = query
      .select({ id: currentFileObservations.locationId })
      .from(currentFileObservations)
      .all();
    for (const location of observedLocations) {
      const facts = observedSelectionFacts(query, location.id, {
        includeConfirmed: true,
      });
      if (facts?.selectionId === selectionId) return facts;
    }
    return undefined;
  }

  async submitConfirmedObservedRevision(input: {
    readonly expected: ObservedFileConfirmationFacts;
    readonly observedAuthority: {
      readonly registrationId: string;
      readonly registrationVersion: number;
      readonly assetLibraryId?: string;
      readonly directoryAuthorityVersion?: number;
    };
    readonly blob: {
      readonly digest: string;
      readonly mediaType: string;
      readonly byteLength: number;
    };
    readonly revision: {
      readonly id: string;
      readonly artifactId: string;
      readonly blobDigest: string;
    };
    readonly proof: ArtifactContentProofMetadata;
  }): Promise<"committed" | "already-committed" | "stale"> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      return query.transaction(
        (transaction) => {
          if (
            input.revision.blobDigest !== input.blob.digest ||
            !proofMetadataMatchesBlob(
              input.proof,
              input.blob.digest,
              input.blob.byteLength,
            )
          )
            return "stale" as const;
          const registration = transaction
            .select()
            .from(observedRootRegistrations)
            .where(
              eq(
                observedRootRegistrations.id,
                input.observedAuthority.registrationId,
              ),
            )
            .get();
          if (
            registration?.status !== "active" ||
            registration.configVersion !==
              input.observedAuthority.registrationVersion
          )
            return "stale" as const;
          // 库语境确认还须在写入 proof/revision/confirmation 的同一 immediate 事务内核该库
          // 对该物理根的目录授权仍 active 且代次相同：明确撤销先提交则整笔 stale、零耐久效果；
          // 确认先提交则后来的 remove 无法回滚既有成果。物理根因共享库仍 active 不能替授权背书。
          if (input.observedAuthority.assetLibraryId !== undefined) {
            const grant = transaction
              .select()
              .from(libraryDirectoryGrants)
              .where(
                and(
                  eq(
                    libraryDirectoryGrants.libraryId,
                    input.observedAuthority.assetLibraryId,
                  ),
                  eq(
                    libraryDirectoryGrants.observedRootId,
                    input.observedAuthority.registrationId,
                  ),
                ),
              )
              .get();
            if (
              grant?.status !== "active" ||
              grant.authorityVersion !==
                input.observedAuthority.directoryAuthorityVersion
            )
              return "stale" as const;
          }
          const current = observedSelectionFacts(
            transaction,
            input.expected.location.locationId,
            { includeConfirmed: true },
          );
          if (
            current?.selectionId !== input.expected.selectionId ||
            current.conditionalBaseline !==
              input.expected.conditionalBaseline ||
            input.revision.artifactId !== current.artifactId ||
            input.blob.byteLength !== current.observation.size
          )
            return "stale" as const;
          const existing = transaction
            .select()
            .from(artifactRevisions)
            .where(eq(artifactRevisions.id, input.revision.id))
            .get();
          if (existing !== undefined) {
            const confirmation = transaction
              .select()
              .from(observedRevisionConfirmations)
              .where(
                and(
                  eq(
                    observedRevisionConfirmations.revisionId,
                    input.revision.id,
                  ),
                  eq(
                    observedRevisionConfirmations.locationId,
                    input.expected.location.locationId,
                  ),
                ),
              )
              .get();
            const proof = transaction
              .select()
              .from(artifactContentProofs)
              .where(eq(artifactContentProofs.blobDigest, input.blob.digest))
              .get();
            if (
              existing.artifactId !== input.revision.artifactId ||
              existing.blobDigest !== input.revision.blobDigest ||
              (proof !== undefined && !proofRowEquals(proof, input.proof))
            )
              return "stale" as const;
            if (
              confirmation !== undefined &&
              confirmation.snapshotId ===
                input.expected.observation.snapshotId &&
              confirmation.observedAt ===
                input.expected.observation.observedAt &&
              confirmation.size === input.expected.observation.size &&
              confirmation.modifiedAt ===
                input.expected.observation.modifiedAt &&
              confirmation.conditionalBaseline ===
                input.expected.conditionalBaseline
            )
              return "already-committed" as const;
            if (
              current.conditionalBaseline !==
              currentObservationConditionalBaseline(transaction, {
                artifactId: current.artifactId,
                locationId: current.location.locationId,
                snapshotId: current.observation.snapshotId,
                observedAt: current.observation.observedAt,
                size: current.observation.size,
                modifiedAt: current.observation.modifiedAt,
              })
            )
              return "stale" as const;
            if (proof === undefined)
              transaction
                .insert(artifactContentProofs)
                .values(input.proof)
                .run();
            if (confirmation === undefined)
              transaction
                .insert(observedRevisionConfirmations)
                .values({
                  revisionId: input.revision.id,
                  locationId: current.location.locationId,
                  snapshotId: current.observation.snapshotId,
                  observedAt: current.observation.observedAt,
                  size: current.observation.size,
                  modifiedAt: current.observation.modifiedAt,
                  conditionalBaseline: current.conditionalBaseline,
                })
                .run();
            // 同一不可变修订被重新观察到新快照：公开确认已在此事务内通过观察根权限、
            // 当前 selection／conditionalBaseline CAS、Artifact／digest／proof／长度一致性
            // 校验，并重新读取真实字节建立 proof。把该修订在该位置的当前确认投影推进到
            // 本次观察坐标，使同一修订在新快照下正常延续；绝不为快照制造新修订、从他处
            // 补确认或放宽上述校验。真正过期的旧 selection 已由前序 CAS 与观察基线判定拒绝。
            else
              transaction
                .update(observedRevisionConfirmations)
                .set({
                  snapshotId: current.observation.snapshotId,
                  observedAt: current.observation.observedAt,
                  size: current.observation.size,
                  modifiedAt: current.observation.modifiedAt,
                  conditionalBaseline: current.conditionalBaseline,
                })
                .where(
                  and(
                    eq(
                      observedRevisionConfirmations.revisionId,
                      input.revision.id,
                    ),
                    eq(
                      observedRevisionConfirmations.locationId,
                      current.location.locationId,
                    ),
                  ),
                )
                .run();
            return "committed" as const;
          }
          if (
            current.conditionalBaseline !==
            currentObservationConditionalBaseline(transaction, {
              artifactId: current.artifactId,
              locationId: current.location.locationId,
              snapshotId: current.observation.snapshotId,
              observedAt: current.observation.observedAt,
              size: current.observation.size,
              modifiedAt: current.observation.modifiedAt,
            })
          )
            return "stale" as const;
          const existingProof = transaction
            .select()
            .from(artifactContentProofs)
            .where(eq(artifactContentProofs.blobDigest, input.blob.digest))
            .get();
          if (
            existingProof !== undefined &&
            !proofRowEquals(existingProof, input.proof)
          )
            return "stale" as const;
          transaction
            .insert(blobs)
            .values(input.blob)
            .onConflictDoNothing()
            .run();
          const persistedBlob = transaction
            .select()
            .from(blobs)
            .where(eq(blobs.digest, input.blob.digest))
            .get();
          if (
            persistedBlob?.byteLength !== input.blob.byteLength ||
            (input.blob.mediaType !== "application/octet-stream" &&
              persistedBlob.mediaType !== input.blob.mediaType)
          )
            return "stale" as const;
          transaction.insert(artifactRevisions).values(input.revision).run();
          transaction
            .insert(observedRevisionConfirmations)
            .values({
              revisionId: input.revision.id,
              locationId: current.location.locationId,
              snapshotId: current.observation.snapshotId,
              observedAt: current.observation.observedAt,
              size: current.observation.size,
              modifiedAt: current.observation.modifiedAt,
              conditionalBaseline: current.conditionalBaseline,
            })
            .run();
          if (existingProof === undefined)
            transaction.insert(artifactContentProofs).values(input.proof).run();
          return "committed" as const;
        },
        { behavior: "immediate" },
      );
    } catch {
      throw new Error("confirmation-commit-failed");
    }
  }

  private constructor(
    productDataDirectory: string,
    options: SqliteCatalogueOptions,
  ) {
    this.productDataDirectory = productDataDirectory;
    this.clock = options.clock ?? systemSqliteCatalogueClock;
    this.workflowExecutionPersistence = new WorkflowExecutionPersistence();
  }

  /** 构造过程无副作用；工作流守卫先于 `ensure()` 运行。 */
  static forProductData(
    productDataDirectory: string,
    options: SqliteCatalogueOptions = {},
  ): SqliteCatalogue {
    return new SqliteCatalogue(productDataDirectory, options);
  }

  /** 运行时准入接缝；不会更改数据库模式。 */
  static async inspectProductionReadiness(options: {
    readonly productDataDirectory: string;
  }) {
    return await inspectProductionCatalogueReadiness(options);
  }

  static readonly productionMigrationPlan = productionCatalogueMigrationPlan;

  static matchesReviewedSchema(database: DatabaseSync): boolean {
    return matchesReviewedCatalogueSchema(database);
  }

  static assertExactLegacySourceEnrichmentAuthority(
    database: DatabaseSync,
  ): void {
    assertExactLegacySourceEnrichmentAuthority(database);
  }

  static assertOrdinaryEntityMigrationAuthority(database: DatabaseSync): void {
    assertOrdinaryEntityMigrationAuthority(database);
  }

  /**
   * 在该适配器的组合生命周期结束时释放其 SQLite 连接。之后持久化能力仍可用，
   * 并会在下一次操作时惰性打开新连接。
   */
  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  async createSourceRefreshRun(
    input: CreateSourceRefreshRunInputForExecution,
  ): Promise<SourceRefreshRun> {
    const run = createDomainSourceRefreshRun(input.run);
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          this.assertSourceRefreshRunStartWithDrizzle(
            transaction,
            input.executionId,
            run,
          );
          this.insertSourceRefreshRunWithDrizzle(
            transaction,
            input.executionId,
            run,
          );
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
    return run;
  }

  async beginSourceRefreshScopeAcquisition(input: {
    readonly runId: string;
    readonly coverage: SourceCoverageScope;
  }): Promise<SourceRefreshRun> {
    const database = await this.ensure();
    let next: SourceRefreshRun | undefined;
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          next = beginDomainSourceRefreshScopeAcquisition(
            this.requiredSourceRefreshRunWithDrizzle(transaction, input.runId),
            input.coverage,
          );
          this.replaceSourceRefreshRunStateWithDrizzle(transaction, next);
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
    if (next === undefined)
      throw new Error("Source Refresh Scope acquisition was not started");
    return next;
  }

  async stageSourceRefreshChangeSet(
    input: StageSourceRefreshChangeSetInput,
  ): Promise<SourceRefreshRun> {
    const database = await this.ensure();
    let staged: SourceRefreshRun | undefined;
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const run = this.requiredSourceRefreshRunWithDrizzle(
            transaction,
            input.runId,
          );
          const runRow = this.requiredSourceRefreshRunRowWithDrizzle(
            transaction,
            input.runId,
          );
          const record = this.sourceRecordWithDrizzle(
            transaction,
            input.candidateSourceRecordId,
          );
          const recordExecution = transaction
            .select({ executionId: sourceRecords.executionId })
            .from(sourceRecords)
            .where(eq(sourceRecords.id, record.id))
            .get();
          if (recordExecution?.executionId !== runRow.workflowExecutionId) {
            throw new Error(
              "Source Refresh candidate Source Record belongs to another Workflow Execution",
            );
          }
          if (
            input.interpretation.sourceIdentity !== record.sourceIdentity ||
            input.interpretation.sourceAddress !== record.nativeAddress ||
            input.interpretation.sourceRecordIds.length !== 1 ||
            input.interpretation.sourceRecordIds[0] !== record.id
          ) {
            throw new Error(
              "Source Refresh Change Set interpretation must describe exactly its candidate Source Record",
            );
          }
          validateSourceInterpretationBatch(input.interpretation);
          const scope = run.scopes.find(
            (candidate) =>
              candidate.coverage.sourceIdentity === record.sourceIdentity &&
              candidate.coverage.nativeAddress === record.nativeAddress &&
              candidate.coverage.coverageId === record.coverage.id,
          );
          if (scope === undefined) {
            throw new Error(
              "Source Refresh Change Set is outside the planned coverage",
            );
          }
          const changes = this.compareSourceRefreshScopeWithDrizzle(
            transaction,
            {
              assetId: run.requestedSelection.subjectId,
              record,
              interpretation: input.interpretation,
              expectedSourceRecordId: scope.baselineSourceRecordId,
            },
          );
          staged = stageDomainSourceRefreshChangeSet(run, {
            id: `source-refresh-change-set_${run.id}_${record.id}`,
            coverage: {
              sourceIdentity: record.sourceIdentity,
              nativeAddress: record.nativeAddress,
              coverageId: record.coverage.id,
            },
            candidateSourceRecordId: record.id,
            changes,
            // 调用方可以提升自动运行的等级，但策略默认值和撤回审核仍属于领域规则。
            ...(input.requiresReview === true ? { requiresReview: true } : {}),
          });
          const changeSet = staged.changeSets.find(
            (candidate) => candidate.candidateSourceRecordId === record.id,
          );
          if (changeSet === undefined) {
            throw new Error("Source Refresh Change Set was not staged");
          }
          this.insertSourceRefreshChangeSetWithDrizzle(
            transaction,
            changeSet,
            input.interpretation,
          );
          this.replaceSourceRefreshRunStateWithDrizzle(transaction, staged);
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
    if (staged === undefined)
      throw new Error("Source Refresh Change Set was not staged");
    return staged;
  }

  async applySourceRefreshChangeSet(input: {
    readonly runId: string;
    readonly changeSetId: string;
  }): Promise<SourceRefreshRun> {
    const database = await this.ensure();
    let next: SourceRefreshRun | undefined;
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const run = this.requiredSourceRefreshRunWithDrizzle(
            transaction,
            input.runId,
          );
          const changeSet = run.changeSets.find(
            (candidate) => candidate.id === input.changeSetId,
          );
          if (changeSet === undefined) {
            throw new Error("Unknown Source Refresh Change Set");
          }
          const record = this.sourceRecordWithDrizzle(
            transaction,
            changeSet.candidateSourceRecordId,
          );
          const interpretation =
            this.sourceRefreshChangeSetInterpretationWithDrizzle(
              transaction,
              changeSet.id,
            );
          if (
            !this.sourceRefreshLineageMatchesWithDrizzle(transaction, {
              assetId: run.requestedSelection.subjectId,
              coverage: changeSet.coverage,
              expectedSourceRecordId: changeSet.baselineSourceRecordId,
            })
          ) {
            next = failDomainSourceRefreshScope(run, {
              coverage: changeSet.coverage,
              outcome: "stale",
              reason: "Source Refresh Change Set lineage baseline is stale",
            });
            this.replaceSourceRefreshRunStateWithDrizzle(transaction, next);
            return;
          }
          const runRow = this.requiredSourceRefreshRunRowWithDrizzle(
            transaction,
            run.id,
          );
          const execution =
            this.workflowExecutionPersistence.readExecutionWithDrizzle(
              transaction,
              runRow.workflowExecutionId,
            );
          if (execution?.status !== "running") {
            throw new Error(
              `Workflow Execution ${runRow.workflowExecutionId} cannot apply a Source Refresh Change Set`,
            );
          }
          const association = transaction
            .select({ id: sourceAssociations.id })
            .from(sourceAssociations)
            .where(
              and(
                eq(
                  sourceAssociations.id,
                  run.requestedSelection.sourceAssociationId,
                ),
                eq(
                  sourceAssociations.subjectId,
                  run.requestedSelection.subjectId,
                ),
                eq(sourceAssociations.sourceIdentity, record.sourceIdentity),
                eq(sourceAssociations.nativeAddress, record.nativeAddress),
              ),
            )
            .get();
          if (association === undefined) {
            throw new Error(
              "Source Refresh lost its current Source Association baseline",
            );
          }
          this.applyMetadataRefreshInTransactionWithDrizzle(transaction, {
            // 来源刷新运行拥有此效果。其父执行会在同一个即时事务中权威读取，
            // 而不是由调用方提供不完整的基线。
            expectedExecution: execution,
            execution,
            submission: {
              assetId: run.requestedSelection.subjectId,
              sourceAssociation: {
                id: run.requestedSelection.sourceAssociationId,
                subjectId: run.requestedSelection.subjectId,
                sourceIdentity: record.sourceIdentity,
                nativeAddress: record.nativeAddress,
              },
              sourceRecords: [record],
              interpretation,
              expectedLineageHeads: [
                {
                  sourceIdentity: record.sourceIdentity,
                  nativeAddress: record.nativeAddress,
                  coverageId: record.coverage.id,
                  ...(changeSet.baselineSourceRecordId === undefined
                    ? {}
                    : { sourceRecordId: changeSet.baselineSourceRecordId }),
                },
              ],
            },
          });
          next = completeDomainSourceRefreshChangeSet(run, {
            changeSetId: changeSet.id,
            outcome:
              changeSet.changes.length === 0 ||
              changeSet.changes.every((change) => change.kind === "unchanged")
                ? "unchanged"
                : "applied",
          });
          this.replaceSourceRefreshRunStateWithDrizzle(transaction, next);
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
    if (next === undefined)
      throw new Error("Source Refresh Change Set was not applied");
    return next;
  }

  async reviewSourceRefreshChangeSet(input: {
    readonly runId: string;
    readonly changeSetId: string;
    readonly disposition: "approved" | "rejected";
  }): Promise<SourceRefreshRun> {
    const database = await this.ensure();
    let next: SourceRefreshRun | undefined;
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          next = reviewDomainSourceRefreshChangeSet(
            this.requiredSourceRefreshRunWithDrizzle(transaction, input.runId),
            {
              changeSetId: input.changeSetId,
              disposition: input.disposition,
            },
          );
          this.replaceSourceRefreshRunStateWithDrizzle(transaction, next);
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
    if (next === undefined)
      throw new Error("Source Refresh Change Set was not reviewed");
    return next;
  }

  async failSourceRefreshScope(input: {
    readonly runId: string;
    readonly coverage: SourceCoverageScope;
    readonly outcome: "failed" | "stale";
    readonly reason: string;
  }): Promise<SourceRefreshRun> {
    const database = await this.ensure();
    let next: SourceRefreshRun | undefined;
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          next = failDomainSourceRefreshScope(
            this.requiredSourceRefreshRunWithDrizzle(transaction, input.runId),
            {
              coverage: input.coverage,
              outcome: input.outcome,
              reason: input.reason,
            },
          );
          this.replaceSourceRefreshRunStateWithDrizzle(transaction, next);
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
    if (next === undefined)
      throw new Error("Source Refresh Scope was not failed");
    return next;
  }

  async cancelSourceRefreshRun(runId: string): Promise<SourceRefreshRun> {
    const database = await this.ensure();
    let next: SourceRefreshRun | undefined;
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          next = cancelDomainSourceRefreshRun(
            this.requiredSourceRefreshRunWithDrizzle(transaction, runId),
          );
          this.replaceSourceRefreshRunStateWithDrizzle(transaction, next);
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
    if (next === undefined)
      throw new Error("Source Refresh Run was not cancelled");
    return next;
  }

  /**
   * 恢复并不是公开的领域取消操作。取消可以更改范围之前，会在同一个即时事务中
   * 检查工作流执行租约、它的持久运行引用以及领域运行状态。
   */
  async cancelUncommittedRun(input: {
    readonly executionId: string;
    readonly runId: string;
    readonly resumeClaim: { readonly token: string; readonly now: string };
  }): Promise<SourceRefreshRun> {
    const database = await this.ensure();
    let next: SourceRefreshRun | undefined;
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          this.assertResumeMutationClaim(
            transaction,
            input.executionId,
            input.resumeClaim,
          );
          const runRow = this.requiredSourceRefreshRunRowWithDrizzle(
            transaction,
            input.runId,
          );
          if (runRow.workflowExecutionId !== input.executionId) {
            throw new Error(
              `Source Refresh Run ${input.runId} does not belong to Workflow Execution ${input.executionId}`,
            );
          }
          const execution =
            this.workflowExecutionPersistence.readExecutionWithDrizzle(
              transaction,
              input.executionId,
            );
          if (!(execution?.sourceRefreshRunIds ?? []).includes(input.runId)) {
            throw new Error(
              `Workflow Execution ${input.executionId} does not reference Source Refresh Run ${input.runId}`,
            );
          }
          next = cancelDomainSourceRefreshRun(
            this.requiredSourceRefreshRunWithDrizzle(transaction, input.runId),
          );
          this.replaceSourceRefreshRunStateWithDrizzle(transaction, next);
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
    if (next === undefined)
      throw new Error("Source Refresh Run was not cancelled during recovery");
    return next;
  }

  async inspectSourceRefreshRun(
    runId: string,
  ): Promise<SourceRefreshRun | undefined> {
    const database = await this.ensure();
    return this.readSourceRefreshRunWithDrizzle(
      drizzle({ client: database }),
      runId,
    );
  }

  async claimResumeExecution(input: {
    readonly executionId: string;
    readonly token: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<"claimed" | "busy" | "terminal"> {
    const database = await this.ensure();
    let disposition: "claimed" | "busy" | "terminal" = "terminal";
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const authoritativeNow = this.authoritativeNow();
        // 为了兼容恢复宿主，应用端口保留了调用方的 `now`，但它绝不是租约有效性输入。
        // 过期进程不得通过重放旧时间戳，让已经失效的租约看起来仍然有效。
        const row = transaction
          .select({
            status: workflowExecutions.status,
            resumeClaimToken: workflowExecutions.resumeClaimToken,
            resumeClaimExpiresAt: workflowExecutions.resumeClaimExpiresAt,
          })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, input.executionId))
          .get();
        if (row?.status !== "running") return;
        if (input.expiresAt <= authoritativeNow) {
          disposition = "busy";
          return;
        }
        if (
          row.resumeClaimToken !== null &&
          row.resumeClaimExpiresAt !== null &&
          row.resumeClaimExpiresAt > authoritativeNow
        ) {
          disposition = "busy";
          return;
        }
        const result = transaction
          .update(workflowExecutions)
          .set({
            resumeClaimToken: input.token,
            resumeClaimExpiresAt: input.expiresAt,
          })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              eq(workflowExecutions.status, "running"),
              or(
                isNull(workflowExecutions.resumeClaimToken),
                // 没有到期时间的令牌不是有效的持久租约。它必须可被恢复，不能在旧版写入
                // 中断后让执行永远停留在忙碌状态。
                isNull(workflowExecutions.resumeClaimExpiresAt),
                lte(workflowExecutions.resumeClaimExpiresAt, authoritativeNow),
              ),
            ),
          )
          .run();
        disposition = result.changes === 1 ? "claimed" : "busy";
      },
      { behavior: "immediate" },
    );
    return disposition;
  }

  async renewResumeExecutionClaim(input: {
    readonly executionId: string;
    readonly token: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<boolean> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    let renewed = false;
    query.transaction(
      (transaction) => {
        const authoritativeNow = this.authoritativeNow();
        if (input.expiresAt <= authoritativeNow) return;
        const result = transaction
          .update(workflowExecutions)
          .set({ resumeClaimExpiresAt: input.expiresAt })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              eq(workflowExecutions.status, "running"),
              eq(workflowExecutions.resumeClaimToken, input.token),
              gt(workflowExecutions.resumeClaimExpiresAt, authoritativeNow),
            ),
          )
          .run();
        renewed = result.changes === 1;
      },
      { behavior: "immediate" },
    );
    return renewed;
  }

  async releaseResumeExecutionClaim(input: {
    readonly executionId: string;
    readonly token: string;
  }): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const authoritativeNow = this.authoritativeNow();
        transaction
          .update(workflowExecutions)
          .set({ resumeClaimToken: null, resumeClaimExpiresAt: null })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              eq(workflowExecutions.resumeClaimToken, input.token),
              gt(workflowExecutions.resumeClaimExpiresAt, authoritativeNow),
            ),
          )
          .run();
      },
      { behavior: "immediate" },
    );
  }

  async createExecution(
    execution: WorkflowExecution,
    requestedAt = new Date().toISOString(),
  ): Promise<ExecutionStartDisposition> {
    const database = await this.ensure();
    let outcome: ExecutionStartDisposition = "started";
    // 普通扫描和定向扫描都走追踪器路径。将其初始执行检查点保留在 Drizzle 内，
    // 不把当前议题扩展到独立的自动化运行时持久化边界。
    const automationIntentId = execution.automationIntentId;
    if (automationIntentId === undefined) {
      const query = drizzle({ client: database });
      query.transaction(
        (transaction) => {
          this.assertAssetLibraryFrozen(transaction, execution);
          this.assertDirectoryAuthorizationsCurrent(transaction, execution);
          this.workflowExecutionPersistence.insertExecutionWithDrizzle(
            transaction,
            execution,
          );
        },
        { behavior: "immediate" },
      );
      return outcome;
    }
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const admission = this.admitAutomationTrigger(
          transaction,
          automationIntentId,
          execution.workflowInput?.trigger ?? execution.trigger,
          requestedAt,
        );
        if (admission !== "admitted") {
          outcome = admission;
          return;
        }
        this.assertAssetLibraryFrozen(transaction, execution);
        this.assertDirectoryAuthorizationsCurrent(transaction, execution);
        this.workflowExecutionPersistence.insertExecutionWithDrizzle(
          transaction,
          execution,
        );
        this.claimAutomationRuntime(
          transaction,
          automationIntentId,
          execution.id,
        );
      },
      { behavior: "immediate" },
    );
    return outcome;
  }

  /**
   * 周期触发在同一条即时事务内核对启用、到期与运行时独占：停用只挡住之后的触发，已经在
   * 进行的执行照常持有其 I/O；`scan-now` 是操作方明确点名，不受开关与到期限制。一个意图
   * 的等待或忙碌绝不牵连同库或其他库的任何意图。
   */
  private admitAutomationTrigger(
    transaction: DrizzleWriteTransaction,
    automationIntentId: string,
    trigger: string | undefined,
    requestedAt: string,
  ): "admitted" | "disabled" | "skipped" {
    if (
      trigger !== "initial" &&
      trigger !== "interval" &&
      trigger !== "scan-now"
    )
      throw new Error("Automation execution requires its trigger");
    const intent = transaction
      .select()
      .from(automationIntents)
      .where(eq(automationIntents.id, automationIntentId))
      .get();
    if (
      intent === undefined ||
      (trigger !== "scan-now" && intent.enabled === 0)
    )
      return "disabled";
    const runtime = transaction
      .select()
      .from(automationRuntime)
      .where(eq(automationRuntime.intentId, automationIntentId))
      .get();
    if (runtime === undefined)
      throw new Error("Automation intent lacks runtime state");
    if (runtime.activeExecutionId !== null) {
      const active = transaction
        .select({ status: workflowExecutions.status })
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, runtime.activeExecutionId))
        .get();
      if (active?.status === "running") return "skipped";
      transaction
        .update(automationRuntime)
        .set({ activeExecutionId: null })
        .where(
          and(
            eq(automationRuntime.intentId, automationIntentId),
            eq(automationRuntime.activeExecutionId, runtime.activeExecutionId),
          ),
        )
        .run();
    }
    if (
      trigger === "interval" &&
      runtime.lastAutomaticTriggerAt !== null &&
      Date.parse(requestedAt) - Date.parse(runtime.lastAutomaticTriggerAt) <
        intent.intervalMilliseconds
    )
      return "skipped";
    return "admitted";
  }

  private claimAutomationRuntime(
    transaction: DrizzleWriteTransaction,
    automationIntentId: string,
    executionId: string,
  ): void {
    const claimed = transaction
      .update(automationRuntime)
      .set({ activeExecutionId: executionId })
      .where(
        and(
          eq(automationRuntime.intentId, automationIntentId),
          isNull(automationRuntime.activeExecutionId),
        ),
      )
      .run();
    if (claimed.changes !== 1)
      throw new Error("Automation execution could not acquire its claim");
  }

  /**
   * 库范围的耐久工作只能在配置仍是解析时那一份时创建。读取活动性与版本和插入执行处在同一
   * 事务，因此并发保存不会让新执行携带过期的冻结值。版本已不是当前值时，只有与父执行冻结输入
   * 逐字一致的派生工作仍可创建：那是同一份旧工作的延续，创建后的编辑不能剥夺它（ADR-0068）。
   */
  private assertAssetLibraryFrozen(
    query: DrizzleReadQuery,
    execution: WorkflowExecution,
  ): void {
    if (this.assetLibraryFrozenStale(query, execution))
      throw new Error("资产库配置已变更或移除，请重新扫描");
  }

  /**
   * 与 assertAssetLibraryFrozen 相同的判据，但把明确的库移除或配置漂移作为布尔值返回，让
   * child 登记事务能在同一事务里耐久中断这份计划而不是回滚重投。数据库读取失败仍在查询处
   * 抛出并回滚，绝不会被当成撤权吞下。
   */
  private assetLibraryFrozenStale(
    query: DrizzleReadQuery,
    execution: WorkflowExecution,
  ): boolean {
    const snapshot = execution.workflowInput?.assetLibrary;
    if (snapshot === undefined) return false;
    const library = query
      .select({
        status: assetLibraries.status,
        configVersion: assetLibraries.configVersion,
      })
      .from(assetLibraries)
      .where(eq(assetLibraries.id, snapshot.id))
      .get();
    if (library === undefined || library.status !== "active") return true;
    if (library.configVersion === snapshot.configVersion) return false;
    const parentExecutionId = execution.workflowInput?.parentExecutionId;
    let parentInput: string | null = null;
    if (parentExecutionId !== undefined)
      parentInput =
        query
          .select({ input: workflowExecutions.workflowInputJson })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, parentExecutionId))
          .get()?.input ?? null;
    const parentSnapshot = frozenSnapshotOfParentInput(parentInput);
    return (
      parentSnapshot === undefined ||
      JSON.stringify(parentSnapshot) !== JSON.stringify(snapshot)
    );
  }

  /**
   * 冻结的库目录授权在同一个 immediate 事务里核对：目录或整库移除、链接授权改变、显式重连
   * 都推进 authorityVersion，携带版本对不上就说明本次工作的 I/O 权威已被收回，新效果与提交
   * 因此持久被拒绝。这里绝不比较库配置版本——普通改名或能力、来源配置编辑不剥夺已授权的工作。
   */
  private directoryAuthorizationsStale(
    query: DrizzleReadQuery,
    execution: WorkflowExecution,
  ): boolean {
    const input = execution.workflowInput;
    const libraryId = input?.assetLibrary?.id;
    if (libraryId === undefined) return false;
    const current = new Map(
      query
        .select({
          observedRootId: libraryDirectoryGrants.observedRootId,
          authorityVersion: libraryDirectoryGrants.authorityVersion,
        })
        .from(libraryDirectoryGrants)
        .where(
          and(
            eq(libraryDirectoryGrants.libraryId, libraryId),
            eq(libraryDirectoryGrants.status, "active"),
          ),
        )
        .all()
        .map((row) => [row.observedRootId, row.authorityVersion]),
    );
    const authorizations = input?.directoryAuthorizations;
    if (authorizations !== undefined)
      return authorizations.some(
        ({ observedRootId, authorityVersion }) =>
          current.get(observedRootId) !== authorityVersion,
      );
    // 本票之前的旧耐久载体若携带库目录工作（冻结了 observedRoots）却没有可证明的授权代次，
    // 绝不以「今日该 root 仍 active」或重连后的新权威补齐——它从未冻结过任何版本，无从核对。
    // 诚实判定过期，让恢复给出 interrupted/failed 终态并保留已提交历史；不带 observedRoots 的
    // 中立旧执行没有目录工作，不进入此分支，继续沿既有兼容边界运行。
    return (input?.observedRoots ?? []).length > 0;
  }

  private assertDirectoryAuthorizationsCurrent(
    query: DrizzleReadQuery,
    execution: WorkflowExecution,
  ): void {
    if (this.directoryAuthorizationsStale(query, execution))
      throw new Error("此目录已从资产库移除或重新连接，本次工作不能继续");
  }

  async retainSourceRecords(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly sourceRecords: readonly SourceRecord[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const baseline =
          this.workflowExecutionPersistence.runningExecutionBaseline(
            transaction,
            input.expectedExecution,
            input.execution,
          );
        const retainedIds = [
          ...new Set([
            ...input.expectedExecution.sourceRecordIds,
            ...input.sourceRecords.map((record) => record.id),
          ]),
        ];
        if (
          JSON.stringify(input.execution.sourceRecordIds) !==
          JSON.stringify(retainedIds)
        )
          throw new Error(
            "Source Record checkpoint must retain the complete expected record set",
          );
        this.assertResumeMutationClaim(
          transaction,
          input.execution.id,
          input.resumeClaim,
        );
        // 来源 collector 返回后的阶段提交同样以 expected execution 冻结的目录授权复核：
        // 移除先提交时新来源记录与阶段被整笔拒绝，结果先提交时既有成果保留。
        this.assertDirectoryAuthorizationsCurrent(
          transaction,
          input.expectedExecution,
        );
        this.insertSourceRecordsWithDrizzle(
          transaction,
          input.execution.id,
          input.sourceRecords,
        );
        this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
          transaction,
          input.execution,
          {
            auditJson: baseline.auditJson,
          },
        );
      },
      { behavior: "immediate" },
    );
  }

  async commitSourceRefreshCollectionFailure(
    input: CommitSourceRefreshCollectionFailureInput,
  ): Promise<{
    readonly execution: WorkflowExecution;
    readonly run: SourceRefreshRun;
  }> {
    if (
      input.sourceFailureCodes !== undefined &&
      (!Array.isArray(input.sourceFailureCodes) ||
        input.sourceFailureCodes.length > 16 ||
        input.sourceFailureCodes.some(
          (item) =>
            typeof item !== "object" ||
            item === null ||
            !hasExactObjectKeys(item, ["capability", "code"]) ||
            typeof item.capability !== "object" ||
            item.capability === null ||
            !hasExactObjectKeys(item.capability, [
              "capabilityId",
              "capabilityVersion",
              "contractVersion",
              "identity",
              "implementationVersion",
              "kind",
              "interpretationContractVersions",
            ]) ||
            typeof item.code !== "string" ||
            item.code.length === 0 ||
            new TextEncoder().encode(item.code).byteLength > 128 ||
            ![
              item.capability.capabilityId,
              item.capability.capabilityVersion,
              item.capability.contractVersion,
              item.capability.identity,
              item.capability.implementationVersion,
              item.capability.kind,
            ].every(
              (value) =>
                typeof value === "string" &&
                value.trim().length > 0 &&
                value.length <= 240,
            ) ||
            !Array.isArray(item.capability.interpretationContractVersions) ||
            item.capability.interpretationContractVersions.length === 0 ||
            !item.capability.interpretationContractVersions.every(
              (value: unknown) =>
                typeof value === "string" &&
                value.trim().length > 0 &&
                value.length <= 240,
            ),
        ))
    )
      throw new Error("Source Refresh collection failure codes are malformed");
    const database = await this.ensure();
    let committed:
      | {
          readonly execution: WorkflowExecution;
          readonly run: SourceRefreshRun;
        }
      | undefined;
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const run = this.requiredSourceRefreshRunWithDrizzle(
          transaction,
          input.runId,
        );
        const runRow = this.requiredSourceRefreshRunRowWithDrizzle(
          transaction,
          input.runId,
        );
        if (runRow.workflowExecutionId !== input.expectedExecution.id)
          throw new Error(
            "Source Refresh collection failure belongs to another execution",
          );
        const scope = run.scopes.find(
          (candidate) =>
            candidate.coverage.sourceIdentity ===
              input.coverage.sourceIdentity &&
            candidate.coverage.nativeAddress === input.coverage.nativeAddress &&
            candidate.coverage.coverageId === input.coverage.coverageId,
        );
        const expectedKey = `source-refresh-failure:${run.id}:${input.coverage.coverageId}:${input.acquisitionAttempt}`;
        if (input.idempotencyKey !== expectedKey)
          throw new Error("Source Refresh collection failure key is invalid");
        const storedExecution =
          this.workflowExecutionPersistence.readExecutionWithAuditWithDrizzle(
            transaction,
            input.expectedExecution.id,
          )?.execution;
        if (
          storedExecution !== undefined &&
          !sourceRefreshFailureDispositionsAreConsistent(run, storedExecution)
        )
          throw new Error("Source Refresh collection failure split state");
        if (
          scope?.state !== "terminal" &&
          storedExecution?.dispositions.some(
            (item) => item.key === expectedKey,
          ) === true
        )
          throw new Error("Source Refresh collection failure split state");
        if (scope?.state === "terminal") {
          this.assertResumeMutationClaim(
            transaction,
            input.expectedExecution.id,
            input.resumeClaim,
          );
          const existing = storedExecution;
          const disposition = existing?.dispositions.find(
            (item) => item.key === expectedKey,
          );
          if (
            scope.acquisitionAttempt === input.acquisitionAttempt &&
            scope.outcome === input.outcome &&
            scope.reason === input.reason &&
            disposition?.status === "failed" &&
            disposition.reason === input.reason &&
            JSON.stringify(disposition.sourceFailureCodes) ===
              JSON.stringify(input.sourceFailureCodes)
          ) {
            committed = { execution: existing!, run };
            return;
          }
          throw new Error("Source Refresh collection failure replay conflicts");
        }
        if (
          scope === undefined ||
          scope.state !== "acquiring" ||
          scope.acquisitionAttempt !== input.acquisitionAttempt ||
          !input.expectedExecution.sourceRefreshRunIds?.includes(run.id)
        )
          throw new Error(
            "Source Refresh collection failure baseline is stale",
          );
        const nextRun = failDomainSourceRefreshScope(run, {
          coverage: input.coverage,
          outcome: input.outcome,
          reason: input.reason,
        });
        const nextExecution: WorkflowExecution = {
          ...input.expectedExecution,
          dispositions: [
            ...input.expectedExecution.dispositions.filter(
              (item) => item.key !== expectedKey,
            ),
            {
              key: expectedKey,
              status: "failed",
              reason: input.reason,
              ...(input.sourceFailureCodes === undefined
                ? {}
                : { sourceFailureCodes: input.sourceFailureCodes }),
            },
          ],
        };
        const baseline =
          this.workflowExecutionPersistence.runningExecutionBaseline(
            transaction,
            input.expectedExecution,
            nextExecution,
          );
        this.assertResumeMutationClaim(
          transaction,
          input.expectedExecution.id,
          input.resumeClaim,
        );
        this.replaceSourceRefreshRunStateWithDrizzle(transaction, nextRun);
        this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
          transaction,
          nextExecution,
          { auditJson: baseline.auditJson },
        );
        committed = { execution: nextExecution, run: nextRun };
      },
      { behavior: "immediate" },
    );
    if (committed === undefined)
      throw new Error("Source Refresh collection failure was not committed");
    return committed;
  }

  private insertSourceRecordsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    executionId: string,
    records: readonly SourceRecord[],
  ): void {
    for (const record of records) {
      if (
        this.isCanonicalSourceRecordRetainedWithDrizzle(
          transaction,
          executionId,
          record,
        )
      )
        continue;
      transaction
        .insert(sourceRecords)
        .values({
          id: record.id,
          executionId,
          sourceIdentity: record.sourceIdentity,
          nativeAddress: record.nativeAddress,
          mediaType: record.mediaType,
          acquiredAt: record.acquiredAt,
          acquisitionJson: JSON.stringify(record.acquisition),
          coverageJson: JSON.stringify(record.coverage),
          digest: record.digest,
          body: record.body,
          producerJson: producerJson(record.producer),
        })
        .run();
    }
  }

  private isCanonicalSourceRecordRetainedWithDrizzle(
    query: DrizzleReadQuery,
    executionId: string,
    candidate: SourceRecord,
  ): boolean {
    const existing = query
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.id, candidate.id))
      .get();
    if (existing === undefined) return false;
    if (
      existing.executionId !== executionId ||
      canonicalJson(sourceRecordFromDrizzle(existing)) !==
        canonicalJson(candidate)
    ) {
      throw new Error(
        `Source Record ${candidate.id} conflicts with durable history`,
      );
    }
    return true;
  }

  async finishExecution(
    expectedExecution: WorkflowExecution,
    execution: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const baseline =
          this.workflowExecutionPersistence.runningExecutionBaseline(
            transaction,
            expectedExecution,
            execution,
          );
        this.assertResumeMutationClaim(transaction, execution.id, resumeClaim);
        this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
          transaction,
          execution,
          {
            auditJson: baseline.auditJson,
          },
        );
        this.projectCompletedFilesystemScanWithDrizzle(transaction, execution);
      },
      { behavior: "immediate" },
    );
  }

  async cancelExecution(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
  }): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const baseline =
          this.workflowExecutionPersistence.runningExecutionBaseline(
            transaction,
            input.expectedExecution,
            input.execution,
          );
        const cancellation = input.execution.cancellation;
        if (
          input.execution.status !== "failed" ||
          input.execution.stage !== "failed" ||
          input.execution.outcome !== "cancelled" ||
          cancellation === undefined ||
          cancellation.requestedBy.trim().length === 0 ||
          cancellation.requestedAt.trim().length === 0 ||
          !Number.isFinite(Date.parse(cancellation.requestedAt))
        ) {
          throw new Error(
            "Workflow Execution cancellation must be terminal and attributable",
          );
        }
        // 取消操作刻意绕过恢复认领所有权：它的 CAS 是发给活跃或已恢复工作进程的
        // 持久停止信号。
        this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
          transaction,
          input.execution,
          {
            auditJson: baseline.auditJson,
          },
        );
        const waitingPreviews = transaction
          .select({
            id: changeImpactPreviews.id,
            previewJson: changeImpactPreviews.previewJson,
          })
          .from(changeImpactPreviews)
          .where(eq(changeImpactPreviews.executionId, input.execution.id))
          .all();
        for (const row of waitingPreviews) {
          const preview = JSON.parse(row.previewJson) as ChangeImpactPreview;
          if (preview.status !== "awaiting-confirmation") continue;
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({
                ...preview,
                status: "rejected",
                rejectedBy: cancellation.requestedBy,
              }),
            })
            .where(eq(changeImpactPreviews.id, row.id))
            .run();
        }
      },
      { behavior: "immediate" },
    );
  }

  /**
   * 现代自动化父的规划结果与原父终态在同一条 immediate／CAS 事务里落下：CAS 失败或恢复声明
   * 过期时，批次、主体、计划与终态一起保持原样，绝不留下一份比父更「新」的处置。
   */
  async finishLibraryScanWithFulfillmentPlan(input: {
    readonly expectedParent: WorkflowExecution;
    readonly finishedParent: WorkflowExecution;
    readonly batch: LibraryScanFulfillmentBatchWrite;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    if (
      input.batch.parentExecutionId !== input.expectedParent.id ||
      input.finishedParent.id !== input.expectedParent.id
    )
      throw new Error("信息履行批次与其库扫描父不一致");
    const dispositions = new Map(
      input.batch.subjects.map((subject) => [
        subject.subjectId,
        subject.disposition,
      ]),
    );
    if (dispositions.size !== input.batch.subjects.length)
      throw new Error("信息履行批次重复登记同一主体");
    for (const operation of input.batch.operations) {
      if (dispositions.get(operation.subjectId) !== "planned")
        throw new Error("信息履行计划缺少已规划的主体处置");
      if (operation.plan.subjectId !== operation.subjectId)
        throw new Error("信息履行计划与所属主体不一致");
    }
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const plannedAt = new Date().toISOString();
    query.transaction(
      (transaction) => {
        const baseline =
          this.workflowExecutionPersistence.runningExecutionBaseline(
            transaction,
            input.expectedParent,
            input.finishedParent,
          );
        this.assertResumeMutationClaim(
          transaction,
          input.finishedParent.id,
          input.resumeClaim,
        );
        const batch = transaction
          .select({ stage: libraryScanFulfillmentBatches.stage })
          .from(libraryScanFulfillmentBatches)
          .where(
            eq(
              libraryScanFulfillmentBatches.parentExecutionId,
              input.batch.parentExecutionId,
            ),
          )
          .get();
        if (batch === undefined) throw new Error("库扫描父缺少信息履行批次");
        if (batch.stage !== "awaiting-results")
          throw new Error("库扫描父的信息履行处置已经耐久写下");
        for (const [position, subject] of input.batch.subjects.entries())
          transaction
            .insert(libraryScanFulfillmentSubjects)
            .values({
              parentExecutionId: input.batch.parentExecutionId,
              subjectId: subject.subjectId,
              disposition: subject.disposition,
              requirementJson:
                subject.requirement === undefined
                  ? null
                  : encodeLibraryScanFulfillmentRequirement(
                      subject.requirement,
                    ),
              reason: subject.reason ?? null,
              position,
            })
            .run();
        for (const [position, operation] of input.batch.operations.entries())
          transaction
            .insert(libraryScanFulfillmentOperations)
            .values({
              parentExecutionId: input.batch.parentExecutionId,
              operationId: operation.operationId,
              subjectId: operation.subjectId,
              planJson: encodeInformationFulfillmentPlan(operation.plan),
              childExecutionId: null,
              disposition: "planned",
              reason: null,
              position,
            })
            .run();
        transaction
          .update(libraryScanFulfillmentBatches)
          .set({
            stage: input.batch.operations.length === 0 ? "closed" : "planned",
            plannedAt,
          })
          .where(
            eq(
              libraryScanFulfillmentBatches.parentExecutionId,
              input.batch.parentExecutionId,
            ),
          )
          .run();
        this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
          transaction,
          input.finishedParent,
          {
            auditJson: baseline.auditJson,
          },
        );
        this.projectCompletedFilesystemScanWithDrizzle(
          transaction,
          input.finishedParent,
        );
      },
      { behavior: "immediate" },
    );
  }

  /** 只从耐久载体读取一个父的处置；损坏载荷如实失败，绝不按今日规则补齐。 */
  async inspectLibraryScanFulfillment(
    parentExecutionId: string,
  ): Promise<LibraryScanFulfillmentInspection | undefined> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const batch = query
      .select()
      .from(libraryScanFulfillmentBatches)
      .where(
        eq(libraryScanFulfillmentBatches.parentExecutionId, parentExecutionId),
      )
      .get();
    if (batch === undefined) return undefined;
    const operations = query
      .select({
        operationId: libraryScanFulfillmentOperations.operationId,
        subjectId: libraryScanFulfillmentOperations.subjectId,
        disposition: libraryScanFulfillmentOperations.disposition,
        planJson: libraryScanFulfillmentOperations.planJson,
        childExecutionId: libraryScanFulfillmentOperations.childExecutionId,
        childStatus: workflowExecutions.status,
        reason: libraryScanFulfillmentOperations.reason,
      })
      .from(libraryScanFulfillmentOperations)
      .leftJoin(
        workflowExecutions,
        eq(
          workflowExecutions.id,
          libraryScanFulfillmentOperations.childExecutionId,
        ),
      )
      .where(
        eq(
          libraryScanFulfillmentOperations.parentExecutionId,
          parentExecutionId,
        ),
      )
      .orderBy(asc(libraryScanFulfillmentOperations.position))
      .all();
    const operationRecords = operations.map(
      (operation): LibraryScanFulfillmentOperationRecord => ({
        operationId: operation.operationId,
        subjectId: operation.subjectId,
        disposition:
          operation.disposition as LibraryScanFulfillmentOperationDisposition,
        ...(operation.planJson === null
          ? {}
          : { plan: decodeInformationFulfillmentPlan(operation.planJson) }),
        ...(operation.childExecutionId === null
          ? {}
          : { childExecutionId: operation.childExecutionId }),
        ...(operation.childStatus === null
          ? {}
          : {
              childStatus: operation.childStatus as WorkflowExecution["status"],
            }),
        ...(operation.reason === null ? {} : { reason: operation.reason }),
      }),
    );
    const subjects = query
      .select()
      .from(libraryScanFulfillmentSubjects)
      .where(
        eq(libraryScanFulfillmentSubjects.parentExecutionId, parentExecutionId),
      )
      .orderBy(asc(libraryScanFulfillmentSubjects.position))
      .all();
    return {
      parentExecutionId,
      stage: batch.stage as LibraryScanFulfillmentBatchStage,
      plannerCoordinate: batch.plannerCoordinate,
      ...(batch.reason === null ? {} : { reason: batch.reason }),
      ...(batch.plannedAt === null ? {} : { plannedAt: batch.plannedAt }),
      subjects: subjects.map(
        (subject): LibraryScanFulfillmentSubjectRecord => ({
          subjectId: subject.subjectId,
          disposition:
            subject.disposition as LibraryScanFulfillmentSubjectDisposition,
          ...(subject.requirementJson === null
            ? {}
            : {
                requirement: decodeLibraryScanFulfillmentRequirement(
                  subject.requirementJson,
                ),
              }),
          ...(subject.reason === null ? {} : { reason: subject.reason }),
          operations: operationRecords.filter(
            (operation) => operation.subjectId === subject.subjectId,
          ),
        }),
      ),
    };
  }

  /**
   * 欠账只由耐久载体决定：仍 awaiting-results 的现代父、还留着未绑定计划的 operation，以及
   * 从未有批次的历史自动化父扫描。按创建顺序返回，因此接续从最早欠账的父开始，新父不能遮蔽它。
   */
  async listTerminalLibraryScanFulfillmentDebt(): Promise<readonly string[]> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const rows = query
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .leftJoin(
        libraryScanFulfillmentBatches,
        eq(
          libraryScanFulfillmentBatches.parentExecutionId,
          workflowExecutions.id,
        ),
      )
      .where(
        and(
          isNotNull(workflowExecutions.automationIntentId),
          eq(workflowExecutions.operationKind, "scan-asset-library"),
          ne(workflowExecutions.status, "running"),
          or(
            isNull(libraryScanFulfillmentBatches.parentExecutionId),
            eq(libraryScanFulfillmentBatches.stage, "awaiting-results"),
            exists(
              query
                .select({ one: sql`1` })
                .from(libraryScanFulfillmentOperations)
                .where(
                  and(
                    eq(
                      libraryScanFulfillmentOperations.parentExecutionId,
                      workflowExecutions.id,
                    ),
                    eq(libraryScanFulfillmentOperations.disposition, "planned"),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(asc(sql<number>`${workflowExecutions}.rowid`))
      .all();
    return rows.map((row) => row.id);
  }

  /**
   * 一个稳定 operation 与唯一 child 的绑定在同一条事务里完成：重复进入返回原执行 ID 而不写
   * 第二份效果，缺原计划或父已不可归属时把该 operation 记为耐久中断。
   */
  async registerInformationFulfillmentChild(input: {
    readonly parentExecutionId: string;
    readonly operationId: string;
    readonly execution: WorkflowExecution;
  }): Promise<InformationFulfillmentChildRegistration> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    let outcome: InformationFulfillmentChildRegistration = {
      status: "interrupted",
      reason: "信息履行所属的库扫描父已不存在",
    };
    query.transaction(
      (transaction) => {
        const operation = transaction
          .select()
          .from(libraryScanFulfillmentOperations)
          .where(
            and(
              eq(
                libraryScanFulfillmentOperations.parentExecutionId,
                input.parentExecutionId,
              ),
              eq(
                libraryScanFulfillmentOperations.operationId,
                input.operationId,
              ),
            ),
          )
          .get();
        if (operation === undefined) {
          outcome = {
            status: "interrupted",
            reason: "信息履行计划不在耐久账本中",
          };
          return;
        }
        if (operation.disposition === "registered") {
          if (operation.childExecutionId === null)
            throw new Error("已登记的信息履行计划缺少 child");
          outcome = {
            status: "existing",
            executionId: operation.childExecutionId,
          };
          return;
        }
        if (operation.disposition === "interrupted") {
          outcome = {
            status: "interrupted",
            reason: operation.reason ?? "该信息履行计划已明确中断",
          };
          return;
        }
        if (operation.planJson === null) {
          transaction
            .update(libraryScanFulfillmentOperations)
            .set({
              disposition: "interrupted",
              reason: "耐久账本缺少该计划的原版本",
            })
            .where(
              and(
                eq(
                  libraryScanFulfillmentOperations.parentExecutionId,
                  input.parentExecutionId,
                ),
                eq(
                  libraryScanFulfillmentOperations.operationId,
                  input.operationId,
                ),
              ),
            )
            .run();
          outcome = {
            status: "interrupted",
            reason: "耐久账本缺少该计划的原版本",
          };
          return;
        }
        const planned = decodeInformationFulfillmentPlan(operation.planJson);
        const coordinates = input.execution.workflowInput?.operation;
        if (
          input.execution.workflowInput?.parentExecutionId !==
            input.parentExecutionId ||
          coordinates === undefined ||
          coordinates.operationId !== input.operationId ||
          coordinates.subjectId !== operation.subjectId ||
          coordinates.subjectId !== planned.subjectId ||
          coordinates.kind !== planned.operation ||
          coordinates.sourceIdentity !== planned.sourceIdentity ||
          (coordinates.sourceAssociationId ?? undefined) !==
            (planned.sourceAssociationId ?? undefined)
        ) {
          transaction
            .update(libraryScanFulfillmentOperations)
            .set({
              disposition: "interrupted",
              reason: "child 与耐久计划坐标不一致，未登记这份效果",
            })
            .where(
              and(
                eq(
                  libraryScanFulfillmentOperations.parentExecutionId,
                  input.parentExecutionId,
                ),
                eq(
                  libraryScanFulfillmentOperations.operationId,
                  input.operationId,
                ),
              ),
            )
            .run();
          outcome = {
            status: "interrupted",
            reason: "child 与耐久计划坐标不一致，未登记这份效果",
          };
          return;
        }
        // 与 createExecution 相同的冻结依据复核：派生 child 沿用父的库快照与目录授权，
        // 已结束的父不遮蔽它欠下的计划，但今日配置漂移不能替它续权。明确的库移除、目录撤权
        // 或重连、缺冻结授权都在这同一事务里把该计划耐久中断（不插 child、不启动效果、不借
        // 今日授权），避免每次启动重复登记尝试；结构损坏与数据库故障仍在下方抛出并回滚。
        const revocationReason = this.assetLibraryFrozenStale(
          transaction,
          input.execution,
        )
          ? "资产库配置已变更或移除，请重新扫描"
          : this.directoryAuthorizationsStale(transaction, input.execution)
            ? "此目录已从资产库移除或重新连接，本次工作不能继续"
            : undefined;
        if (revocationReason !== undefined) {
          transaction
            .update(libraryScanFulfillmentOperations)
            .set({ disposition: "interrupted", reason: revocationReason })
            .where(
              and(
                eq(
                  libraryScanFulfillmentOperations.parentExecutionId,
                  input.parentExecutionId,
                ),
                eq(
                  libraryScanFulfillmentOperations.operationId,
                  input.operationId,
                ),
              ),
            )
            .run();
          outcome = { status: "interrupted", reason: revocationReason };
          return;
        }
        this.workflowExecutionPersistence.insertExecutionWithDrizzle(
          transaction,
          input.execution,
        );
        transaction
          .update(libraryScanFulfillmentOperations)
          .set({
            disposition: "registered",
            childExecutionId: input.execution.id,
          })
          .where(
            and(
              eq(
                libraryScanFulfillmentOperations.parentExecutionId,
                input.parentExecutionId,
              ),
              eq(
                libraryScanFulfillmentOperations.operationId,
                input.operationId,
              ),
            ),
          )
          .run();
        outcome = { status: "registered", executionId: input.execution.id };
      },
      { behavior: "immediate" },
    );
    return outcome;
  }

  /**
   * 未规划收口只适用于迁移前就没有批次的终态自动化父：能定位的接受主体逐条耐久记为中断，
   * 读不到冻结依据时只写批次级原因。这里不调用今日解析器，不回填 no-work 或计划，也不新建 child。
   */
  async closeLegacyLibraryScanFulfillment(
    input: LegacyLibraryScanFulfillmentClosure,
  ): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const reason = "该父扫描没有留下可复验的信息履行规划依据";
    query.transaction(
      (transaction) => {
        const existing = transaction
          .select({ stage: libraryScanFulfillmentBatches.stage })
          .from(libraryScanFulfillmentBatches)
          .where(
            eq(
              libraryScanFulfillmentBatches.parentExecutionId,
              input.parentExecutionId,
            ),
          )
          .get();
        if (existing !== undefined)
          throw new Error("该库扫描父已有耐久信息履行批次");
        const parent = transaction
          .select({
            automationIntentId: workflowExecutions.automationIntentId,
            status: workflowExecutions.status,
          })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, input.parentExecutionId))
          .get();
        if (
          parent === undefined ||
          parent.automationIntentId === undefined ||
          parent.status === "running"
        )
          throw new Error("未规划的收口只适用于已结束的自动化库扫描父");
        transaction
          .insert(libraryScanFulfillmentBatches)
          .values({
            parentExecutionId: input.parentExecutionId,
            version: libraryScanFulfillmentVersion,
            plannerCoordinate: automatedInformationPlannerNoneCoordinate,
            stage:
              input.unreadableReason === undefined ? "closed" : "interrupted",
            reason: input.unreadableReason ?? null,
            plannedAt: null,
          })
          .run();
        if (input.unreadableReason !== undefined) return;
        let position = 0;
        for (const subjectId of input.acceptedSubjectIds) {
          transaction
            .insert(libraryScanFulfillmentSubjects)
            .values({
              parentExecutionId: input.parentExecutionId,
              subjectId,
              disposition: "interrupted",
              requirementJson: null,
              reason,
              position,
            })
            .run();
          position += 1;
        }
      },
      { behavior: "immediate" },
    );
  }

  /**
   * 父执行与全部目录条目在同一条事务里落下：目录子登记之前，归属一定已经耐久存在，
   * 崩溃因此不会留下没有父的孤儿观察。周期触发携带意图时，同一事务还核对启用、到期与
   * 运行时独占，没被接纳就不留下任何行。
   */
  async createLibraryScan(input: {
    readonly execution: WorkflowExecution;
    readonly directories: readonly LibraryScanDirectoryRecord[];
    readonly requestedAt?: string;
    readonly fulfillmentPlannerCoordinate?: string;
  }): Promise<ExecutionStartDisposition> {
    const plan = input.execution.workflowInput?.libraryScan;
    if (
      input.execution.operationKind !== "scan-asset-library" ||
      plan === undefined
    )
      throw new Error("库扫描父执行缺少冻结的目录计划");
    if (
      input.directories.length === 0 ||
      input.directories.some((directory) => directory.stage !== "queued") ||
      JSON.stringify(
        input.directories.map((directory) => directory.directoryKey).toSorted(),
      ) !==
        JSON.stringify(
          plan.directories
            .map((directory) => directory.directoryKey)
            .toSorted(),
        )
    )
      throw new Error("库扫描目录条目与冻结的目录计划不一致");
    const database = await this.ensure();
    const query = drizzle({ client: database });
    let outcome: ExecutionStartDisposition = "started";
    query.transaction(
      (transaction) => {
        const automationIntentId = input.execution.automationIntentId;
        if (automationIntentId !== undefined) {
          const admission = this.admitAutomationTrigger(
            transaction,
            automationIntentId,
            input.execution.workflowInput?.trigger,
            input.requestedAt ?? new Date().toISOString(),
          );
          if (admission !== "admitted") {
            outcome = admission;
            return;
          }
          // 周期新工作必须与此刻的库配置核对；人工父执行沿用 08/09 已接受的创建语义。
          this.assertAssetLibraryFrozen(transaction, input.execution);
        }
        this.assertDirectoryAuthorizationsCurrent(transaction, input.execution);
        this.workflowExecutionPersistence.insertExecutionWithDrizzle(
          transaction,
          input.execution,
        );
        if (automationIntentId !== undefined)
          this.claimAutomationRuntime(
            transaction,
            automationIntentId,
            input.execution.id,
          );
        for (const [position, directory] of input.directories.entries())
          transaction
            .insert(libraryScanDirectories)
            .values({
              parentExecutionId: input.execution.id,
              directoryKey: directory.directoryKey,
              scopeReference: directory.scopeReference,
              rootVersion: directory.rootVersion,
              relativeScope: directory.relativeScope,
              mode: directory.mode,
              executedByKey: directory.executedByDirectoryKey ?? null,
              coveredPrefix: directory.coveredPrefix ?? null,
              childExecutionId: directory.childExecutionId ?? null,
              stage: directory.stage,
              outcome: directory.outcome ?? null,
              reason: directory.reason ?? null,
              workItemCount: directory.workItemCount,
              unresolvedCount: directory.unresolvedCount,
              failedCount: directory.failedCount,
              position,
            })
            .run();
        // 批次壳与父同时落下：它的存在与否就是现代父与历史无规划父的耐久分界。
        if (input.fulfillmentPlannerCoordinate !== undefined)
          transaction
            .insert(libraryScanFulfillmentBatches)
            .values({
              parentExecutionId: input.execution.id,
              version: libraryScanFulfillmentVersion,
              plannerCoordinate: input.fulfillmentPlannerCoordinate,
              stage: "awaiting-results",
              reason: null,
              plannedAt: null,
            })
            .run();
      },
      { behavior: "immediate" },
    );
    return outcome;
  }

  /**
   * 原子登记目录子：比较父仍运行且没有被明确取消，插入子执行并把其 ID 盖到代表条目与
   * 该代表的 covered 条目上。取消与登记的竞争因此只会有一个赢家。
   */
  async registerLibraryScanChild(input: {
    readonly parentExecutionId: string;
    readonly directoryKey: string;
    readonly execution: WorkflowExecution;
    readonly requestedAt?: string;
  }): Promise<"registered" | "cancelled" | "already-registered"> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    let disposition: "registered" | "cancelled" | "already-registered" =
      "cancelled";
    query.transaction(
      (transaction) => {
        const parent = transaction
          .select({ status: workflowExecutions.status })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, input.parentExecutionId))
          .get();
        if (parent === undefined)
          throw new Error("库扫描父执行不存在，不能登记目录子");
        const entry = transaction
          .select()
          .from(libraryScanDirectories)
          .where(
            and(
              eq(
                libraryScanDirectories.parentExecutionId,
                input.parentExecutionId,
              ),
              eq(libraryScanDirectories.directoryKey, input.directoryKey),
            ),
          )
          .get();
        if (entry === undefined)
          throw new Error("库扫描目录条目不属于该父执行");
        if (
          parent.status !== "running" ||
          transaction
            .select({ id: libraryScanCancellations.parentExecutionId })
            .from(libraryScanCancellations)
            .where(
              eq(
                libraryScanCancellations.parentExecutionId,
                input.parentExecutionId,
              ),
            )
            .get() !== undefined
        ) {
          disposition = "cancelled";
          return;
        }
        if (entry.childExecutionId !== null) {
          disposition = "already-registered";
          return;
        }
        if (
          entry.mode !== "execute" ||
          input.execution.workflowInput?.parentExecutionId !==
            input.parentExecutionId ||
          input.execution.workflowInput?.parentDirectoryKey !==
            input.directoryKey
        )
          throw new Error("目录子执行的父归属与登记请求不一致");
        this.assertDirectoryAuthorizationsCurrent(transaction, input.execution);
        this.workflowExecutionPersistence.insertExecutionWithDrizzle(
          transaction,
          input.execution,
        );
        const claimed = transaction
          .update(libraryScanDirectories)
          .set({ childExecutionId: input.execution.id, stage: "running" })
          .where(
            and(
              eq(
                libraryScanDirectories.parentExecutionId,
                input.parentExecutionId,
              ),
              eq(libraryScanDirectories.directoryKey, input.directoryKey),
              isNull(libraryScanDirectories.childExecutionId),
            ),
          )
          .run();
        if (claimed.changes !== 1) throw new Error("库扫描目录条目登记竞争");
        transaction
          .update(libraryScanDirectories)
          .set({ childExecutionId: input.execution.id, stage: "running" })
          .where(
            and(
              eq(
                libraryScanDirectories.parentExecutionId,
                input.parentExecutionId,
              ),
              eq(libraryScanDirectories.executedByKey, input.directoryKey),
              eq(libraryScanDirectories.mode, "covered"),
              isNull(libraryScanDirectories.childExecutionId),
            ),
          )
          .run();
        disposition = "registered";
      },
      { behavior: "immediate" },
    );
    return disposition;
  }

  async recordLibraryScanDirectoryResult(input: {
    readonly parentExecutionId: string;
    readonly directoryKey: string;
    readonly stage: LibraryScanDirectoryStage;
    readonly outcome?: AssetRefreshOutcome;
    readonly reason?: string;
    readonly workItemCount: number;
    readonly unresolvedCount: number;
    readonly failedCount: number;
  }): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const written = transaction
          .update(libraryScanDirectories)
          .set({
            stage: input.stage,
            outcome: input.outcome ?? null,
            reason: input.reason ?? null,
            workItemCount: input.workItemCount,
            unresolvedCount: input.unresolvedCount,
            failedCount: input.failedCount,
          })
          .where(
            and(
              eq(
                libraryScanDirectories.parentExecutionId,
                input.parentExecutionId,
              ),
              eq(libraryScanDirectories.directoryKey, input.directoryKey),
            ),
          )
          .run();
        if (written.changes !== 1) throw new Error("库扫描目录条目不存在");
      },
      { behavior: "immediate" },
    );
  }

  async inspectLibraryScan(
    parentExecutionId: string,
  ): Promise<LibraryScanInspection | undefined> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    return query.transaction((transaction) => {
      const row = transaction
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, parentExecutionId))
        .get();
      if (row === undefined) return undefined;
      const execution =
        this.workflowExecutionPersistence.executionFromDrizzle(row);
      const plan = execution.workflowInput?.libraryScan;
      if (
        execution.operationKind !== "scan-asset-library" ||
        plan === undefined
      )
        return undefined;
      const cancellation = transaction
        .select()
        .from(libraryScanCancellations)
        .where(
          eq(libraryScanCancellations.parentExecutionId, parentExecutionId),
        )
        .get();
      return {
        parentExecutionId,
        assetLibraryId: plan.assetLibraryId,
        configVersion: plan.configVersion,
        status: execution.status,
        ...(execution.outcome === undefined
          ? {}
          : { outcome: execution.outcome }),
        ...(cancellation === undefined
          ? {}
          : {
              cancellationRequested: {
                requestedBy: cancellation.requestedBy,
                requestedAt: cancellation.requestedAt,
                ...(cancellation.reason === null
                  ? {}
                  : { reason: cancellation.reason }),
              },
            }),
        directories: transaction
          .select()
          .from(libraryScanDirectories)
          .where(
            eq(libraryScanDirectories.parentExecutionId, parentExecutionId),
          )
          .orderBy(asc(libraryScanDirectories.position))
          .all()
          .map(libraryScanDirectoryRecordFromRow),
      } satisfies LibraryScanInspection;
    });
  }

  /**
   * 取消意图先CAS写下：此后任何目录子登记都会失败。仍未开始的目录与 covered 条目由
   * 调用方记为取消，已经提交的结果保持不动。
   */
  async requestLibraryScanCancellation(input: {
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
  > {
    if (
      input.requestedBy.trim().length === 0 ||
      !Number.isFinite(Date.parse(input.requestedAt))
    )
      throw new Error("库扫描取消必须明确发起者与时间");
    const database = await this.ensure();
    const query = drizzle({ client: database });
    return query.transaction(
      (transaction) => {
        const parent = transaction
          .select({ status: workflowExecutions.status })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, input.parentExecutionId))
          .get();
        if (parent === undefined) return { status: "absent" } as const;
        if (parent.status !== "running") return { status: "terminal" } as const;
        const inserted = transaction
          .insert(libraryScanCancellations)
          .values({
            parentExecutionId: input.parentExecutionId,
            requestedBy: input.requestedBy,
            requestedAt: input.requestedAt,
            reason: input.reason ?? null,
          })
          .onConflictDoNothing()
          .run();
        transaction
          .update(libraryScanDirectories)
          .set({ stage: "cancelled", outcome: "cancelled" })
          .where(
            and(
              eq(
                libraryScanDirectories.parentExecutionId,
                input.parentExecutionId,
              ),
              eq(libraryScanDirectories.stage, "queued"),
            ),
          )
          .run();
        return {
          status:
            inserted.changes === 1
              ? ("recorded" as const)
              : ("already-requested" as const),
          childExecutionIds: [
            ...new Set(
              transaction
                .select({
                  childExecutionId: libraryScanDirectories.childExecutionId,
                })
                .from(libraryScanDirectories)
                .where(
                  and(
                    eq(
                      libraryScanDirectories.parentExecutionId,
                      input.parentExecutionId,
                    ),
                    isNotNull(libraryScanDirectories.childExecutionId),
                  ),
                )
                .all()
                .map((row) => row.childExecutionId as string),
            ),
          ],
        };
      },
      { behavior: "immediate" },
    );
  }

  /**
   * 未识别观察的有界查询：按父、库或目录范围展开子执行的耐久工作项，归属精确到形成
   * 该观察的冻结根与相对范围，供既有人工确认、关联或定向入口使用。
   */
  async listUnrecognizedLibraryScanObservations(input: {
    readonly parentExecutionId?: string;
    readonly assetLibraryId?: string;
    readonly directoryKey?: string;
    readonly limit: number;
  }): Promise<readonly UnrecognizedLibraryScanObservation[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0)
      throw new Error("未识别观察查询必须有界");
    const database = await this.ensure();
    const query = drizzle({ client: database });
    return query.transaction((transaction) => {
      const parents = transaction
        .select({
          id: workflowExecutions.id,
          workflowInputJson: workflowExecutions.workflowInputJson,
        })
        .from(workflowExecutions)
        .where(eq(workflowExecutions.operationKind, "scan-asset-library"))
        .all()
        .filter((row) => {
          if (input.parentExecutionId !== undefined)
            return row.id === input.parentExecutionId;
          if (input.assetLibraryId === undefined) return true;
          return (
            parseLibraryScanPlanAssetLibraryId(row.workflowInputJson) ===
            input.assetLibraryId
          );
        });
      const observations: UnrecognizedLibraryScanObservation[] = [];
      for (const parent of parents) {
        const entries = transaction
          .select()
          .from(libraryScanDirectories)
          .where(
            and(
              eq(libraryScanDirectories.parentExecutionId, parent.id),
              ...(input.directoryKey === undefined
                ? []
                : [
                    eq(libraryScanDirectories.directoryKey, input.directoryKey),
                  ]),
            ),
          )
          .orderBy(asc(libraryScanDirectories.position))
          .all();
        for (const entry of entries) {
          if (entry.childExecutionId === null) continue;
          const child = transaction
            .select()
            .from(workflowExecutions)
            .where(eq(workflowExecutions.id, entry.childExecutionId))
            .get();
          if (child === undefined) continue;
          const workItems = JSON.parse(
            child.workItemsJson,
          ) as readonly AssetRefreshWorkItem[];
          // 被覆盖目录只报告属于自身前缀的观察，绝不复制代表目录的全部结果。
          const scopedWorkItems = coveredWorkItems(
            workItems,
            entry.coveredPrefix ?? ".",
          );
          const observedRootId =
            parseLibraryScanObservedRootId(child.workflowInputJson) ??
            entry.scopeReference;
          for (const item of scopedWorkItems) {
            if (!isUnrecognizedObservationWorkItem(item)) continue;
            observations.push({
              parentExecutionId: parent.id,
              directoryKey: entry.directoryKey,
              childExecutionId: entry.childExecutionId,
              workItemKey: item.key,
              observedRootId,
              relativeScope: entry.relativeScope,
              relativePaths: [...item.relativePaths],
            });
            if (observations.length >= input.limit) return observations;
          }
        }
      }
      return observations;
    });
  }

  async transitionExecution(
    expected: WorkflowExecution,
    next: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              expected,
              next,
            );
          this.assertResumeMutationClaim(transaction, expected.id, resumeClaim);
          // 终态重核与最终观察投影共用这一个 immediate 事务：核对通过才写回与投影，任何被
          // 取代的已确认目标都让整笔事务回滚，绝不把中间落入的较新观察投出去。
          const staleTerminals =
            next.status === "completed"
              ? this.requestedLocalMaterialStaleTerminalsWithDrizzle(
                  transaction,
                  next,
                )
              : [];
          if (staleTerminals.length > 0)
            throw new LocalMaterialConfirmationTerminalStaleError(
              staleTerminals,
            );
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            next,
            {
              auditJson: baseline.auditJson,
            },
          );
          this.projectCompletedFilesystemScanWithDrizzle(transaction, next);
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  async finishExecutionWithProposal(
    expectedExecution: WorkflowExecution,
    execution: WorkflowExecution,
    proposal: RecognitionProposal,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              expectedExecution,
              execution,
            );
          this.assertResumeMutationClaim(
            transaction,
            execution.id,
            resumeClaim,
          );
          this.insertProposalWithDrizzle(transaction, execution.id, proposal);
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            execution,
            {
              auditJson: baseline.auditJson,
            },
          );
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  async finishExecutionWithChangeImpactPreview(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly proposal: RecognitionProposal;
    readonly preview: ChangeImpactPreview;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    if (
      input.preview.executionId !== input.execution.id ||
      input.preview.change.kind !== "recognition-supersession" ||
      input.preview.change.proposal.id !== input.proposal.id
    )
      throw new Error(
        "Change Impact Preview must describe the terminal proposal execution",
      );
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              input.execution,
            );
          this.assertResumeMutationClaim(
            transaction,
            input.execution.id,
            input.resumeClaim,
          );
          this.insertProposalWithDrizzle(
            transaction,
            input.execution.id,
            input.proposal,
          );
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            input.execution,
            {
              auditJson: baseline.auditJson,
            },
          );
          transaction
            .insert(changeImpactPreviews)
            .values({
              id: input.preview.id,
              executionId: input.preview.executionId,
              assetId: input.preview.assetId,
              previewJson: JSON.stringify(
                this.withOtherLegacyArtifactDeltaBlocked(
                  transaction,
                  input.preview,
                ),
              ),
            })
            .run();
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  async finishExecutionWithSourceAssociationPreview(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly preview: ChangeImpactPreview;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    if (
      input.preview.version !== "change-impact-preview/2" ||
      input.preview.change?.kind !== "source-association" ||
      input.preview.executionId !== input.execution.id
    )
      throw new Error(
        "Source Association Decision requires an exact V2 preview",
      );
    const database = await this.ensure();
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const baseline =
          this.workflowExecutionPersistence.runningExecutionBaseline(
            transaction,
            input.expectedExecution,
            input.execution,
          );
        this.assertResumeMutationClaim(
          transaction,
          input.execution.id,
          input.resumeClaim,
        );
        this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
          transaction,
          input.execution,
          { auditJson: baseline.auditJson },
        );
        transaction
          .insert(changeImpactPreviews)
          .values({
            id: input.preview.id,
            executionId: input.preview.executionId,
            assetId: input.preview.assetId,
            previewJson: JSON.stringify(
              this.withOtherLegacyArtifactDeltaBlocked(
                transaction,
                input.preview,
              ),
            ),
          })
          .run();
      },
      { behavior: "immediate" },
    );
  }

  async finishExecutionWithRecognitionRetractionPreview(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly preview: ChangeImpactPreview;
  }): Promise<void> {
    if (
      input.preview.version !== "change-impact-preview/2" ||
      input.preview.change.kind !== "recognition-retraction" ||
      input.preview.executionId !== input.execution.id
    )
      throw new Error("Recognition retraction requires an exact V2 preview");
    const database = await this.ensure();
    drizzle({ client: database }).transaction(
      (transaction) => {
        const baseline =
          this.workflowExecutionPersistence.runningExecutionBaseline(
            transaction,
            input.expectedExecution,
            input.execution,
          );
        this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
          transaction,
          input.execution,
          { auditJson: baseline.auditJson },
        );
        transaction
          .insert(changeImpactPreviews)
          .values({
            id: input.preview.id,
            executionId: input.preview.executionId,
            assetId: input.preview.assetId,
            previewJson: JSON.stringify(
              this.withOtherLegacyArtifactDeltaBlocked(
                transaction,
                input.preview,
              ),
            ),
          })
          .run();
      },
      { behavior: "immediate" },
    );
  }

  async finishExecutionWithRecognitionScopeAmendmentPreview(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly proposal: RecognitionProposal;
    readonly preview: ChangeImpactPreview;
  }): Promise<void> {
    if (
      input.preview.version !== "change-impact-preview/2" ||
      input.preview.change?.kind !== "recognition-scope-amendment" ||
      input.preview.change.proposal.id !== input.proposal.id ||
      input.preview.executionId !== input.execution.id
    )
      throw new Error(
        "Recognition scope amendment requires an exact V2 preview",
      );
    const database = await this.ensure();
    try {
      drizzle({ client: database }).transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              input.execution,
            );
          // 那次观察的裁剪快照随执行落库，是这份明确决定的证据载体。
          this.insertProposalWithDrizzle(
            transaction,
            input.execution.id,
            input.proposal,
          );
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            input.execution,
            { auditJson: baseline.auditJson },
          );
          transaction
            .insert(changeImpactPreviews)
            .values({
              id: input.preview.id,
              executionId: input.preview.executionId,
              assetId: input.preview.assetId,
              previewJson: JSON.stringify(
                this.withOtherLegacyArtifactDeltaBlocked(
                  transaction,
                  input.preview,
                ),
              ),
            })
            .run();
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  async acceptRecognition(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly accepted: AcceptedRecognition;
    readonly observedMaterialAcceptances?:
      | readonly ObservedMaterialAcceptanceBinding[]
      | undefined;
    readonly expectedUnassignedMaterials?: readonly Pick<
      Location,
      "artifactId" | "address"
    >[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    // 同样确保公开适配器对非应用层调用方安全。该检查发生在事务打开前，
    // 因而无效批次不会产生任何写入。
    validateAcceptedRecognition(input.accepted);
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              input.execution,
            );
          this.assertResumeMutationClaim(
            transaction,
            input.execution.id,
            input.resumeClaim,
          );
          this.assertDirectoryAuthorizationsCurrent(
            transaction,
            input.execution,
          );
          const unassigned = input.expectedUnassignedMaterials;
          if (unassigned !== undefined && unassigned.length > 0) {
            // 只保护本次“从未采用材料建立内容”的旧页面提交。后续显式建立整体／成员
            // 关系可以共享材料，不能把这里变成数据库全局独占约束。
            const claimed = transaction
              .select({ subjectId: artifactAssociations.subjectId })
              .from(artifactAssociations)
              .innerJoin(
                locations,
                eq(locations.artifactId, artifactAssociations.artifactId),
              )
              .where(
                and(
                  eq(locations.kind, "observed"),
                  or(
                    inArray(
                      locations.address,
                      sqliteTextSet(unassigned.map((item) => item.address)),
                    ),
                    inArray(
                      artifactAssociations.artifactId,
                      sqliteTextSet(unassigned.map((item) => item.artifactId)),
                    ),
                  ),
                  notExists(
                    transaction
                      .select({
                        id: artifactAssociationRetractions.associationId,
                      })
                      .from(artifactAssociationRetractions)
                      .where(
                        eq(
                          artifactAssociationRetractions.associationId,
                          artifactAssociations.id,
                        ),
                      ),
                  ),
                  notExists(
                    transaction
                      .select({
                        id: artifactAssociationSupersessions.predecessorAssociationId,
                      })
                      .from(artifactAssociationSupersessions)
                      .where(
                        eq(
                          artifactAssociationSupersessions.predecessorAssociationId,
                          artifactAssociations.id,
                        ),
                      ),
                  ),
                ),
              )
              .get();
            if (claimed !== undefined)
              throw new Error("材料已经归入内容，请重新检查后继续整理");
          }
          this.insertProposalWithDrizzle(
            transaction,
            input.execution.id,
            input.accepted.proposal,
          );
          this.insertAcceptedFactsWithDrizzle(transaction, input.accepted);
          this.recordObservedMaterialAcceptancesWithDrizzle(
            transaction,
            input.execution,
            input.observedMaterialAcceptances ?? [],
          );
          this.writeLocalAssociationSupportsWithDrizzle(
            transaction,
            input.accepted,
          );
          this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
            input.accepted.entity.id,
          ]);
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            input.execution,
            {
              auditJson: baseline.auditJson,
            },
          );
          // 目录资格链要能在同一事务内被观察到，投影必须跑在终态执行、决定与
          // 关联支持都已写入之后。
          this.projectCurrentFileObservationsWithDrizzle(
            transaction,
            input.execution,
            input.accepted.locations,
          );
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      // 旧版公开适配器会直接暴露 SQLite 约束或触发器消息。保留该契约，
      // 同时仍由 Drizzle 拥有事务和查询构造。
      throw originalPersistenceError(error);
    }
  }

  async freezeObservedMaterialAssociationTarget(
    assetId: string,
  ): ReturnType<
    ObservedMaterialAssociationPersistence["freezeObservedMaterialAssociationTarget"]
  > {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const identityBaseline = this.observedMaterialIdentityBaselineWithDrizzle(
      query,
      assetId,
    );
    if (identityBaseline === undefined)
      throw new Error("目标内容不存在或尚未确认");
    return {
      identityBaseline,
      materialBaseline: this.observedMaterialBaselineWithDrizzle(
        query,
        assetId,
      ),
    };
  }

  async commitObservedMaterialAssociation(
    input: Parameters<
      ObservedMaterialAssociationPersistence["commitObservedMaterialAssociation"]
    >[0],
  ): ReturnType<
    ObservedMaterialAssociationPersistence["commitObservedMaterialAssociation"]
  > {
    validateObservedMaterialAssociationSubmission(input.submission);
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      return query.transaction(
        (transaction) => {
          this.assertResumeMutationClaim(
            transaction,
            input.expectedExecution.id,
            input.resumeClaim,
          );
          const identityBaseline =
            this.observedMaterialIdentityBaselineWithDrizzle(
              transaction,
              input.submission.recognitionDecision.assetId,
            );
          const materialBaseline = this.observedMaterialBaselineWithDrizzle(
            transaction,
            input.submission.recognitionDecision.assetId,
          );
          const authority = transaction
            .select({
              status: observedRootRegistrations.status,
              configVersion: observedRootRegistrations.configVersion,
            })
            .from(observedRootRegistrations)
            .where(
              eq(
                observedRootRegistrations.id,
                input.observedAuthority.registrationId,
              ),
            )
            .get();
          const complete =
            this.observedMaterialSubmissionExistsWithDrizzle(
              transaction,
              input.submission,
            ) ||
            this.observedMaterialProjectionAlreadySupportedWithDrizzle(
              transaction,
              input.submission,
            );
          // 目录授权在提交时已不再等于本次工作冻结的那一份：与观察根版本失效一样按
          // 「过期」落下，不抛错、不剥夺同库其他目录已经完成的成果。
          const directoryStale = this.directoryAuthorizationsStale(
            transaction,
            input.expectedExecution,
          );
          let outcome: "accepted" | "no-change" | "stale";
          if (
            identityBaseline !== input.expectedIdentityBaseline ||
            authority?.status !== "active" ||
            directoryStale ||
            authority.configVersion !==
              input.observedAuthority.registrationVersion
          ) {
            outcome = "stale";
          } else if (materialBaseline !== input.expectedMaterialBaseline) {
            outcome = complete ? "no-change" : "stale";
          } else if (complete) {
            outcome = "no-change";
          } else {
            this.insertProposalWithDrizzle(
              transaction,
              input.expectedExecution.id,
              input.submission.proposal,
            );
            transaction
              .insert(recognitionDecisions)
              .values({
                id: input.submission.recognitionDecision.id,
                proposalId: input.submission.recognitionDecision.proposalId,
                assetId: input.submission.recognitionDecision.assetId,
                acceptedRuleResultsJson: JSON.stringify(
                  input.submission.recognitionDecision.acceptedRuleResults,
                ),
                boundariesJson: JSON.stringify(
                  input.submission.recognitionDecision.boundaries,
                ),
              })
              .run();
            this.insertOrVerifyArtifactFactsWithDrizzle(
              transaction,
              input.submission,
              input.submission.recognitionDecision.assetId,
            );
            for (const support of input.submission.supports)
              transaction
                .insert(artifactAssociationRecognitionSupports)
                .values(support)
                .onConflictDoNothing()
                .run();
            this.recordObservedMaterialAcceptancesWithDrizzle(
              transaction,
              input.expectedExecution,
              this.observedMaterialAssociationBindings(input.submission),
            );
            // 追加材料的正向支持依赖已提交的 boundary 与关联，投影因此跑在其后。
            this.projectCurrentFileObservationsWithDrizzle(
              transaction,
              input.expectedExecution,
              input.submission.locations,
            );
            outcome = "accepted";
          }
          const next =
            outcome === "accepted"
              ? input.terminalExecutions.accepted
              : outcome === "no-change"
                ? input.terminalExecutions.noChange
                : input.terminalExecutions.stale;
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              next,
            );
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            next,
            { auditJson: baseline.auditJson },
          );
          return outcome;
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  async auditObservedMaterialAssociations(
    projections: readonly ObservedMaterialAssociationProjection[],
  ): Promise<readonly ObservedMaterialAssociationAudit[]> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const uniqueProjections = [
      ...new Map(
        projections.map((projection) => [projection.associationId, projection]),
      ).values(),
    ];
    return uniqueProjections.map((requestedProjection) => {
      const associationRow = query
        .select()
        .from(artifactAssociations)
        .where(eq(artifactAssociations.id, requestedProjection.associationId))
        .get();
      if (associationRow === undefined)
        throw new Error("观察材料关联审计引用不存在");
      const association: ArtifactAssociation = {
        id: associationRow.id,
        target: descriptionTargetFromColumns(associationRow),
        artifactId: associationRow.artifactId,
        role: associationRow.role,
        sourceRecordIds: JSON.parse(
          associationRow.sourceRecordIdsJson,
        ) as string[],
        ...(associationRow.sourceAssociationId === null
          ? {}
          : { sourceAssociationId: associationRow.sourceAssociationId }),
        ...(associationRow.producerJson === null
          ? {}
          : { producer: JSON.parse(associationRow.producerJson) }),
        ...(associationRow.observedArtifactPartJson === null
          ? {}
          : {
              observedArtifactPart: JSON.parse(
                associationRow.observedArtifactPartJson,
              ),
            }),
      };
      const supportRows = query
        .select()
        .from(artifactAssociationRecognitionSupports)
        .where(
          eq(
            artifactAssociationRecognitionSupports.associationId,
            association.id,
          ),
        )
        .all();
      const audit: ObservedMaterialAssociationAudit = {
        association,
        supports: supportRows.map((support) => {
          const decisionRow = query
            .select()
            .from(recognitionDecisions)
            .where(eq(recognitionDecisions.id, support.recognitionDecisionId))
            .get();
          if (decisionRow === undefined)
            throw new Error("观察材料关联审计决定不存在");
          const proposal = this.readProposalWithDrizzle(
            query,
            decisionRow.proposalId,
          );
          if (proposal === undefined)
            throw new Error("观察材料关联审计提案不存在");
          const proposalRow = query
            .select({ executionId: recognitionProposals.executionId })
            .from(recognitionProposals)
            .where(eq(recognitionProposals.id, proposal.id))
            .get();
          const execution =
            proposalRow === undefined
              ? undefined
              : this.workflowExecutionPersistence.readExecutionWithDrizzle(
                  query,
                  proposalRow.executionId,
                );
          if (execution === undefined)
            throw new Error("观察材料关联审计执行不存在");
          if (execution.materialAssociationInvalid !== undefined)
            throw new Error("观察材料关联审计检查点无效");
          const checkpointProjections =
            execution.materialAssociation?.submission?.projections.filter(
              (item) => item.associationId === association.id,
            ) ?? [];
          const candidateReferences = new Set(
            (proposal.observedArtifactAssociations ?? [])
              .filter((candidate) => candidate.role === association.role)
              .map((candidate) => candidate.observedArtifactReference),
          );
          const revisionCandidates = [
            ...(proposal.observedArtifactRevisions ?? []),
            ...(proposal.basis.kind === "observed-evidence"
              ? proposal.basis.artifactRevisions
              : []),
            ...(proposal.basis.kind === "manual-boundary"
              ? proposal.basis.evidence.flatMap((evidence) =>
                  evidence.inspection === undefined
                    ? []
                    : [
                        {
                          observedArtifactReference:
                            evidence.inspection.observedArtifactReference,
                          blob: evidence.inspection.revision,
                        },
                      ],
                )
              : []),
          ];
          const durableProjections = revisionCandidates.flatMap((candidate) => {
            if (!candidateReferences.has(candidate.observedArtifactReference))
              return [];
            const location = query
              .select()
              .from(locations)
              .where(
                and(
                  eq(locations.artifactId, association.artifactId),
                  eq(locations.kind, "observed"),
                  eq(
                    locations.address,
                    `${execution.snapshot?.root}/${candidate.observedArtifactReference}`,
                  ),
                ),
              )
              .get();
            const revision = query
              .select()
              .from(artifactRevisions)
              .where(
                and(
                  eq(artifactRevisions.artifactId, association.artifactId),
                  eq(artifactRevisions.blobDigest, candidate.blob.digest),
                ),
              )
              .get();
            return location === undefined || revision === undefined
              ? []
              : [
                  {
                    observedArtifactReference:
                      candidate.observedArtifactReference,
                    artifactId: association.artifactId,
                    locationId: location.id,
                    revisionId: revision.id,
                    associationId: association.id,
                  },
                ];
          });
          const projection = (
            execution.materialAssociation === undefined
              ? durableProjections
              : checkpointProjections
          )
            .filter(
              (item) =>
                item.associationId === association.id &&
                item.artifactId === association.artifactId &&
                candidateReferences.has(item.observedArtifactReference),
            )
            .toSorted((left, right) =>
              left.observedArtifactReference.localeCompare(
                right.observedArtifactReference,
              ),
            )[0];
          if (projection === undefined)
            throw new Error("观察材料关联审计投影不存在");
          const location = query
            .select()
            .from(locations)
            .where(eq(locations.id, projection.locationId))
            .get();
          const revision = query
            .select()
            .from(artifactRevisions)
            .where(eq(artifactRevisions.id, projection.revisionId))
            .get();
          const blob =
            revision === undefined
              ? undefined
              : query
                  .select()
                  .from(blobs)
                  .where(eq(blobs.digest, revision.blobDigest))
                  .get();
          if (
            location === undefined ||
            revision === undefined ||
            blob === undefined ||
            location.artifactId !== association.artifactId ||
            location.kind !== "observed" ||
            revision.artifactId !== association.artifactId ||
            (execution.materialAssociation !== undefined &&
              (location.address !==
                `${execution.materialAssociation.snapshot?.root}/${projection.observedArtifactReference}` ||
                execution.materialAssociation.submission?.proposal.id !==
                  proposal.id ||
                execution.materialAssociation.submission?.proposal.basis
                  .kind !== "manual-boundary" ||
                execution.materialAssociation.submission?.proposal.basis
                  .observationSnapshotId !==
                  execution.materialAssociation.snapshot?.id ||
                !execution.materialAssociation.submission?.proposal.basis.materialReferences.includes(
                  projection.observedArtifactReference,
                ) ||
                !execution.materialAssociation.submission?.proposal.observedArtifactAssociations?.some(
                  (item) =>
                    item.observedArtifactReference ===
                      projection.observedArtifactReference &&
                    item.role === association.role,
                ) ||
                !execution.materialAssociation.submission?.proposal.observedArtifactRevisions?.some(
                  (item) =>
                    item.observedArtifactReference ===
                      projection.observedArtifactReference &&
                    item.blob.digest === revision.blobDigest &&
                    item.blob.mediaType === blob.mediaType &&
                    item.blob.byteLength === blob.byteLength,
                ) ||
                !proposal.observedArtifactRevisions?.some(
                  (item) =>
                    item.observedArtifactReference ===
                      projection.observedArtifactReference &&
                    item.blob.digest === blob.digest &&
                    item.blob.mediaType === blob.mediaType &&
                    item.blob.byteLength === blob.byteLength,
                ) ||
                !execution.materialAssociation.submission?.locations.some(
                  (item) =>
                    item.id === projection.locationId &&
                    item.artifactId === projection.artifactId &&
                    item.kind === "observed" &&
                    item.address === location.address,
                ) ||
                !execution.materialAssociation.submission?.artifacts.some(
                  (item) => item.id === projection.artifactId,
                ) ||
                !execution.materialAssociation.submission?.artifactAssociations.some(
                  (item) =>
                    item.id === association.id &&
                    item.artifactId === association.artifactId &&
                    sameDescriptionTarget(item.target, association.target) &&
                    item.role === association.role,
                ) ||
                !execution.materialAssociation.submission?.supports.some(
                  (item) =>
                    item.associationId === association.id &&
                    item.recognitionDecisionId === decisionRow.id,
                ) ||
                !execution.materialAssociation.submission?.artifactRevisions.some(
                  (item) =>
                    item.id === projection.revisionId &&
                    item.artifactId === projection.artifactId &&
                    item.blobDigest === revision.blobDigest,
                ) ||
                !execution.materialAssociation.submission?.blobs.some(
                  (item) =>
                    item.digest === blob.digest &&
                    item.mediaType === blob.mediaType &&
                    item.byteLength === blob.byteLength,
                ))) ||
            !revisionCandidates.some(
              (candidate) =>
                candidate.observedArtifactReference ===
                  projection.observedArtifactReference &&
                candidate.blob.digest === revision.blobDigest &&
                candidate.blob.mediaType === blob.mediaType &&
                candidate.blob.byteLength === blob.byteLength,
            )
          )
            throw new Error("观察材料关联审计材料事实不存在");
          return {
            support,
            decision: {
              id: decisionRow.id,
              boundaries: JSON.parse(
                decisionRow.boundariesJson,
              ) as RecognitionDecision["boundaries"],
              proposalId: decisionRow.proposalId,
              assetId: decisionRow.assetId,
              acceptedRuleResults: JSON.parse(
                decisionRow.acceptedRuleResultsJson,
              ) as RecognitionDecision["acceptedRuleResults"],
            },
            proposal,
            projection,
            location: {
              id: location.id,
              artifactId: location.artifactId,
              address: location.address,
              kind: location.kind,
            },
            revision: {
              id: revision.id,
              artifactId: revision.artifactId,
              blobDigest: revision.blobDigest,
              ...(revision.producerJson === null
                ? {}
                : { producer: JSON.parse(revision.producerJson) }),
            },
            blob,
          };
        }),
      };
      return validateObservedMaterialAssociationAudit(audit);
    });
  }

  async inspectExecution(
    executionId: string,
  ): Promise<ExecutionInspection | undefined> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const execution =
      this.workflowExecutionPersistence.readExecutionWithDrizzle(
        query,
        executionId,
      );
    if (execution === undefined) return undefined;
    const retainedSourceRecords = query
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.executionId, executionId))
      .orderBy(asc(sql<number>`${sourceRecords}.rowid`))
      .all()
      .map(sourceRecordFromDrizzle);
    const proposal =
      execution.proposalId === undefined
        ? undefined
        : this.readProposalWithDrizzle(query, execution.proposalId);
    const accepted =
      execution.acceptedAssetId === undefined
        ? undefined
        : await this.readCurrentAcceptedWithDrizzle(
            query,
            execution.acceptedAssetId,
          );
    const sourceRefreshRuns = (execution.sourceRefreshRunIds ?? []).flatMap(
      (runId) => {
        const run = this.readSourceRefreshRunWithDrizzle(query, runId);
        return run === undefined ? [] : [run];
      },
    );
    const workItemInspections: Array<
      NonNullable<ExecutionInspection["workItemInspections"]>[number]
    > = [];
    for (const workItem of execution.workItems ?? []) {
      const itemProposal =
        workItem.proposalId === undefined
          ? undefined
          : this.readProposalWithDrizzle(query, workItem.proposalId);
      const itemAccepted =
        workItem.acceptedAssetId === undefined || itemProposal === undefined
          ? undefined
          : await this.readCurrentAcceptedWithDrizzle(
              query,
              workItem.acceptedAssetId,
            );
      workItemInspections.push({
        workItem,
        ...(itemProposal === undefined ? {} : { proposal: itemProposal }),
        ...(itemAccepted === undefined ? {} : { accepted: itemAccepted }),
      });
    }
    return {
      execution,
      sourceRecords: retainedSourceRecords,
      ...(sourceRefreshRuns.length === 0 ? {} : { sourceRefreshRuns }),
      ...(proposal === undefined ? {} : { proposal }),
      ...(accepted === undefined ? {} : { accepted }),
      ...(workItemInspections.length === 0 ? {} : { workItemInspections }),
    };
  }

  async listExecutions(): Promise<readonly WorkflowExecution[]> {
    const database = await this.ensure();
    return drizzle({ client: database })
      .select()
      .from(workflowExecutions)
      .orderBy(desc(sql<number>`${workflowExecutions}.rowid`))
      .all()
      .map((row) =>
        this.workflowExecutionPersistence.executionFromDrizzle(row),
      );
  }

  async listRunningExecutions(): Promise<readonly WorkflowExecution[]> {
    const database = await this.ensure();
    return drizzle({ client: database })
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.status, "running"))
      .orderBy(asc(sql<number>`${workflowExecutions}.rowid`))
      .all()
      .map((row) =>
        this.workflowExecutionPersistence.executionFromDrizzle(row),
      );
  }

  /** 使用固定的批量查询计划读取不可变执行结果记录。 */
  async listWorkflowHistoryPage(
    input: WorkflowHistoryPageRequest = {},
  ): Promise<WorkflowHistoryPersistencePage> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const limit = workflowHistoryPageLimit(input);
    const cursor = workflowHistoryCursor(input.cursor);
    const sequence = sql<number>`${workflowExecutions}.rowid`;
    const pageRows = await query
      .select({ execution: workflowExecutions, sequence })
      .from(workflowExecutions)
      .where(
        cursor === undefined
          ? undefined
          : or(
              lt(sequence, cursor.sequence),
              and(
                eq(sequence, cursor.sequence),
                gt(workflowExecutions.id, cursor.id),
              ),
            ),
      )
      .orderBy(desc(sequence), asc(workflowExecutions.id))
      .limit(limit + 1);
    const selected = pageRows.slice(0, limit);
    const executions = selected.map(({ execution }) =>
      this.workflowExecutionPersistence.executionFromDrizzle(execution),
    );
    const executionIds = executions.map(({ id }) => id);
    const proposalIds = [
      ...new Set(
        executions.flatMap((execution) => [
          ...(execution.proposalId === undefined ? [] : [execution.proposalId]),
          ...(execution.workItems ?? []).flatMap((item) =>
            item.proposalId === undefined ? [] : [item.proposalId],
          ),
        ]),
      ),
    ];
    const runIds = [
      ...new Set(
        executions.flatMap((execution) => execution.sourceRefreshRunIds ?? []),
      ),
    ];
    const [
      recordRows,
      proposalRows,
      decisionRows,
      associationRows,
      previewRows,
    ] = [
      executionIds.length === 0
        ? []
        : query
            .select()
            .from(sourceRecords)
            .where(inArray(sourceRecords.executionId, executionIds))
            .orderBy(asc(sql<number>`${sourceRecords}.rowid`))
            .all(),
      proposalIds.length === 0
        ? []
        : query
            .select()
            .from(recognitionProposals)
            .where(inArray(recognitionProposals.id, proposalIds))
            .all(),
      proposalIds.length === 0
        ? []
        : query
            .select({
              id: recognitionDecisions.id,
              proposalId: recognitionDecisions.proposalId,
              assetId: recognitionDecisions.assetId,
            })
            .from(recognitionDecisions)
            .where(inArray(recognitionDecisions.proposalId, proposalIds))
            .all(),
      proposalIds.length === 0
        ? []
        : query
            .select({
              id: sourceAssociations.id,
              proposalId: recognitionDecisions.proposalId,
              subjectId: sourceAssociations.subjectId,
            })
            .from(sourceAssociations)
            .innerJoin(
              sourceAssociationEstablishmentSupports,
              eq(
                sourceAssociationEstablishmentSupports.associationId,
                sourceAssociations.id,
              ),
            )
            .innerJoin(
              recognitionDecisions,
              eq(
                recognitionDecisions.id,
                sourceAssociationEstablishmentSupports.recognitionDecisionId,
              ),
            )
            .where(inArray(recognitionDecisions.proposalId, proposalIds))
            .all(),
      executionIds.length === 0
        ? []
        : query
            .select()
            .from(changeImpactPreviews)
            .where(inArray(changeImpactPreviews.executionId, executionIds))
            .all(),
    ];
    const [runRows, scopeRows, changeSetRows] = [
      runIds.length === 0
        ? []
        : query
            .select()
            .from(sourceRefreshRuns)
            .where(inArray(sourceRefreshRuns.id, runIds))
            .all(),
      runIds.length === 0
        ? []
        : query
            .select()
            .from(sourceRefreshScopes)
            .where(inArray(sourceRefreshScopes.runId, runIds))
            .orderBy(asc(sourceRefreshScopes.ordinal))
            .all(),
      runIds.length === 0
        ? []
        : query
            .select()
            .from(sourceRefreshChangeSets)
            .where(inArray(sourceRefreshChangeSets.runId, runIds))
            .orderBy(asc(sql<number>`${sourceRefreshChangeSets}.rowid`))
            .all(),
    ];
    const proposalsById = new Map(
      proposalRows.map((row) => [
        row.id,
        {
          id: row.id,
          boundaries: JSON.parse(
            row.boundariesJson,
          ) as RecognitionProposal["boundaries"],
          basis: JSON.parse(row.basisJson) as RecognitionProposal["basis"],
          ruleResults: JSON.parse(
            row.ruleResultsJson,
          ) as RecognitionProposal["ruleResults"],
        },
      ]),
    );
    const items = executions.map((execution) => {
      const executionProposalIds = [
        ...new Set([
          ...(execution.proposalId === undefined ? [] : [execution.proposalId]),
          ...(execution.workItems ?? []).flatMap((item) =>
            item.proposalId === undefined ? [] : [item.proposalId],
          ),
        ]),
      ];
      const records = recordRows
        .filter((row) => row.executionId === execution.id)
        .map(sourceRecordFromDrizzle);
      const previews = previewRows
        .filter((row) => row.executionId === execution.id)
        .map((row) => JSON.parse(row.previewJson) as ChangeImpactPreview);
      const decisions = decisionRows.filter((row) =>
        executionProposalIds.includes(row.proposalId),
      );
      const associations = associationRows.filter((row) =>
        executionProposalIds.includes(row.proposalId),
      );
      const acceptedAssetIds = [
        ...new Set([
          ...(execution.acceptedAssetId === undefined
            ? []
            : [execution.acceptedAssetId]),
          ...(execution.workItems ?? []).flatMap((item) =>
            item.acceptedAssetId === undefined ? [] : [item.acceptedAssetId],
          ),
        ]),
      ];
      return {
        execution,
        resultReferences: {
          proposalIds: executionProposalIds,
          acceptedProposalIds: decisions.map(({ proposalId }) => proposalId),
          recognitionDecisionIds: decisions.map(({ id }) => id),
          sourceAssociationIds: associations.map(({ id }) => id),
          acceptedAssetIds,
          sourceRecordIds: records.map(({ id }) => id),
          sourceRefreshRunIds: execution.sourceRefreshRunIds ?? [],
          changeImpactPreviewIds: previewRows
            .filter((row) => row.executionId === execution.id)
            .map(({ id }) => id),
          affectedSubjectIds: [
            ...new Set([
              ...acceptedAssetIds,
              ...decisions.map(({ assetId }) => assetId),
              ...associations.map(({ subjectId }) => subjectId),
              ...previewRows
                .filter((row) => row.executionId === execution.id)
                .map(({ assetId }) => assetId),
            ]),
          ],
        },
        sourceRecords: records,
        proposals: executionProposalIds.flatMap((id) => {
          const proposal = proposalsById.get(id);
          return proposal === undefined ? [] : [proposal];
        }),
        sourceRefreshRuns: runRows
          .filter((row) =>
            (execution.sourceRefreshRunIds ?? []).includes(row.id),
          )
          .map((row) =>
            this.projectSourceRefreshRunRows(
              row,
              scopeRows.filter((scope) => scope.runId === row.id),
              changeSetRows.filter((changeSet) => changeSet.runId === row.id),
            ),
          ),
        changeImpactPreviews: previews,
      };
    });
    const last = selected.at(-1);
    return {
      items,
      ...(pageRows.length <= limit || last === undefined
        ? {}
        : {
            nextCursor: encodeWorkflowHistoryCursor({
              sequence: last.sequence,
              id: last.execution.id,
            }),
          }),
    };
  }

  /**
   * 根据仍可采取行动的持久条件，重建当前的关注事项。它刻意排除普通运行中工作和
   * 终止性失败：二者本身都不是持久审核条件。
   */
  async listCurrentAttentionPage(
    input: CurrentAttentionPageRequest = {},
  ): Promise<CurrentAttentionPage> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const limit = currentAttentionPageLimit(input);
    const cursor = currentAttentionCursor(input.cursor);
    const sequence = sql<number>`${workflowExecutions}.rowid`;

    const recognitionAfter =
      cursor === undefined
        ? undefined
        : cursor.kind === 0
          ? or(
              lt(sequence, cursor.sequence),
              and(
                eq(sequence, cursor.sequence),
                gt(recognitionProposals.id, cursor.id),
              ),
            )
          : lt(sequence, cursor.sequence);
    const changeImpactAfter =
      cursor === undefined
        ? undefined
        : cursor.kind < 1
          ? or(lt(sequence, cursor.sequence), eq(sequence, cursor.sequence))
          : cursor.kind === 1
            ? or(
                lt(sequence, cursor.sequence),
                and(
                  eq(sequence, cursor.sequence),
                  gt(changeImpactPreviews.id, cursor.id),
                ),
              )
            : lt(sequence, cursor.sequence);
    const sourceRefreshAfter =
      cursor === undefined
        ? undefined
        : cursor.kind < 2
          ? or(lt(sequence, cursor.sequence), eq(sequence, cursor.sequence))
          : or(
              lt(sequence, cursor.sequence),
              and(
                eq(sequence, cursor.sequence),
                gt(sourceRefreshChangeSets.id, cursor.id),
              ),
            );
    const prerequisiteAfter =
      cursor === undefined
        ? undefined
        : cursor.kind < 3
          ? or(lt(sequence, cursor.sequence), eq(sequence, cursor.sequence))
          : or(
              lt(sequence, cursor.sequence),
              and(
                eq(sequence, cursor.sequence),
                gt(automationIntents.id, cursor.id),
              ),
            );
    // 绑定前不可用的根没有工作流执行行。将第一个有效关注序列赋给它们稳定的
    // 意图 ID 顺序，使同一个不透明游标在重新打开后仍能跨越这些持久条件前进。
    const prebindSequence = 1;
    const prebindAfter =
      cursor === undefined
        ? undefined
        : cursor.kind < 3
          ? sql<boolean>`${prebindSequence} <= ${cursor.sequence}`
          : cursor.sequence === prebindSequence
            ? gt(automationIntents.id, cursor.id)
            : sql<boolean>`false`;
    const proposalHasChangeImpactPreview = query
      .select({ id: changeImpactPreviews.id })
      .from(changeImpactPreviews)
      .where(
        eq(
          sql<string>`json_extract(${changeImpactPreviews.previewJson}, '$.proposal.id')`,
          recognitionProposals.id,
        ),
      );
    const proposalIsAwaitingRecognitionDecision = or(
      and(
        eq(workflowExecutions.outcome, "proposal"),
        eq(workflowExecutions.proposalId, recognitionProposals.id),
        isNull(workflowExecutions.acceptedAssetId),
      ),
      sql<boolean>`exists (
        select 1
        from json_each(${workflowExecutions.workItemsJson}) as work_item
        where json_extract(work_item.value, '$.proposalId') = ${recognitionProposals.id}
          and json_extract(work_item.value, '$.outcome') = 'proposal'
          and json_extract(work_item.value, '$.acceptedAssetId') is null
      )`,
    );

    const directPrerequisiteFailure = (execution: SQL) => sql<boolean>`
      exists (
        select 1 from json_each(${execution}.dispositions_json) as disposition
        where json_extract(disposition.value, '$.failureClassification.kind') = 'prerequisite-unavailable'
      ) or exists (
        select 1 from json_each(${execution}.work_items_json) as work_item
        where json_extract(work_item.value, '$.failureClassification.kind') = 'prerequisite-unavailable'
      )
    `;
    // 库扫描父保留目录账目，工作项的类型化失败仍由精确目录子权威持有。
    // 用同一谓词选当前及更新记录，避免分页去重漏掉仅子任务降级的父执行。
    const prerequisiteFailureFor = (execution: SQL) => sql<boolean>`
      (${directPrerequisiteFailure(execution)} or exists (
        select 1 from library_scan_directories as directory
        inner join workflow_executions as directory_child
          on directory_child.id = directory.child_execution_id
        where directory.parent_execution_id = ${execution}.id
          and (${directPrerequisiteFailure(sql`directory_child`)})
      ))
    `;
    const prerequisiteFailure = prerequisiteFailureFor(
      sql`${workflowExecutions}`,
    );
    // 在游标和限制之前按耐久意图选最新降级，父及精确子工作项使用相同的分类依据。
    const prerequisiteIsLatestForIntent = sql<boolean>`
      not exists (
        select 1 from workflow_executions as newer_execution
        where newer_execution.automation_intent_id = ${workflowExecutions.automationIntentId}
          and newer_execution.rowid > ${workflowExecutions}.rowid
          and ${prerequisiteFailureFor(sql`newer_execution`)}
      )
    `;
    const [
      recognitionRows,
      changeImpactRows,
      sourceRefreshRows,
      prerequisiteRows,
      prebindRows,
    ] = await Promise.all([
      query
        .select({
          executionId: workflowExecutions.id,
          proposalId: recognitionProposals.id,
          sequence,
        })
        .from(recognitionProposals)
        .innerJoin(
          workflowExecutions,
          eq(workflowExecutions.id, recognitionProposals.executionId),
        )
        .leftJoin(
          recognitionDecisions,
          eq(recognitionDecisions.proposalId, recognitionProposals.id),
        )
        .where(
          and(
            proposalIsAwaitingRecognitionDecision,
            isNull(recognitionDecisions.id),
            notExists(proposalHasChangeImpactPreview),
            sql`not exists (
              with adopted_materials as (
                select material.value from recognition_proposals as adopted
                join recognition_decisions as decision on decision.proposal_id = adopted.id
                join recognition_heads as head on head.recognition_decision_id = decision.id
                join json_each(adopted.basis_json, '$.materialReferences') as material
                where json_extract(adopted.basis_json, '$.kind') = 'manual-boundary'
                  and json_extract(adopted.basis_json, '$.observationSnapshotId') = json_extract(${workflowExecutions.snapshotJson}, '$.id')
                  and exists (
                    select 1 from json_each(adopted.basis_json, '$.revisesProposalIds') as revised
                    where revised.value = ${recognitionProposals.id}
                  )
                )
                select 1 from adopted_materials where not exists (
                  select material.value from json_each(coalesce(
                    json_extract(${recognitionProposals.basisJson}, '$.materialReferences'),
                    (select json_extract(item.value, '$.relativePaths')
                     from json_each(${workflowExecutions.workItemsJson}) as item
                     where json_extract(item.value, '$.proposalId') = ${recognitionProposals.id}),
                    (select json_group_array(json_extract(file.value, '$.relativePath'))
                     from json_each(${workflowExecutions.snapshotJson}, '$.files') as file)
                  )) as material
                  except select value from adopted_materials
                )
            )`,
            recognitionAfter,
          ),
        )
        .orderBy(desc(sequence), asc(recognitionProposals.id))
        .limit(limit + 1),
      this.listCurrentChangeImpactAttentionRows(query, {
        limit,
        initialAfter: changeImpactAfter,
      }),
      query
        .select({
          changeSetId: sourceRefreshChangeSets.id,
          executionId: sourceRefreshRuns.workflowExecutionId,
          requestedSelectionJson: sourceRefreshRuns.requestedSelectionJson,
          sequence,
        })
        .from(sourceRefreshScopes)
        .innerJoin(
          sourceRefreshChangeSets,
          and(
            eq(sourceRefreshChangeSets.id, sourceRefreshScopes.changeSetId),
            eq(sourceRefreshChangeSets.runId, sourceRefreshScopes.runId),
          ),
        )
        .innerJoin(
          sourceRefreshRuns,
          eq(sourceRefreshRuns.id, sourceRefreshScopes.runId),
        )
        .innerJoin(
          workflowExecutions,
          eq(workflowExecutions.id, sourceRefreshRuns.workflowExecutionId),
        )
        .where(
          and(
            eq(sourceRefreshScopes.state, "awaiting-review"),
            eq(sourceRefreshChangeSets.requiresReview, 1),
            eq(sourceRefreshChangeSets.disposition, "pending"),
            sourceRefreshAfter,
          ),
        )
        .orderBy(desc(sequence), asc(sourceRefreshChangeSets.id))
        .limit(limit + 1),
      query
        .select({
          automationIntentId: automationIntents.id,
          executionId: workflowExecutions.id,
          sequence: sql<number>`coalesce(${sequence}, 0)`,
        })
        .from(automationIntents)
        .leftJoin(
          workflowExecutions,
          eq(workflowExecutions.automationIntentId, automationIntents.id),
        )
        .where(
          and(
            eq(automationIntents.enabled, 0),
            inArray(automationIntents.disabledReason, [
              "prerequisite-unavailable",
            ]),
            and(prerequisiteFailure, prerequisiteIsLatestForIntent),
            prerequisiteAfter,
          ),
        )
        .orderBy(desc(sequence), asc(automationIntents.id))
        .limit(limit + 1),
      query
        .select({ automationIntentId: automationIntents.id })
        .from(automationIntents)
        .where(
          and(
            eq(automationIntents.enabled, 0),
            eq(automationIntents.disabledReason, "observed-root-unavailable"),
            prebindAfter,
          ),
        )
        .orderBy(asc(automationIntents.id))
        .limit(limit + 1),
    ]);

    const candidates: CurrentAttentionCandidate[] = [
      ...recognitionRows.map(
        ({ executionId, proposalId, sequence: rowSequence }) => ({
          sequence: rowSequence,
          kind: 0 as const,
          cursorId: proposalId,
          item: {
            id: `recognition-review:${proposalId}`,
            kind: "recognition-review" as const,
            executionId,
            summary: "需要确认识别结果",
            recognitionProposalId: proposalId,
          },
        }),
      ),
      ...changeImpactRows.map(
        ({ previewId, executionId, assetId, sequence: rowSequence }) => ({
          sequence: rowSequence,
          kind: 1 as const,
          cursorId: previewId,
          item: {
            id: `change-impact-review:${previewId}`,
            kind: "change-impact-review" as const,
            executionId,
            assetId,
            summary: "需要确认识别变更影响",
            changeImpactPreviewId: previewId,
          },
        }),
      ),
      ...sourceRefreshRows.map(
        ({
          changeSetId,
          executionId,
          requestedSelectionJson,
          sequence: rowSequence,
        }) => ({
          sequence: rowSequence,
          kind: 2 as const,
          cursorId: changeSetId,
          item: {
            id: `source-refresh-review:${changeSetId}`,
            kind: "source-refresh-review" as const,
            executionId,
            assetId: currentAttentionSubjectId(requestedSelectionJson),
            summary: "需要审核来源刷新变更",
            sourceRefreshChangeSetId: changeSetId,
          },
        }),
      ),
      ...prerequisiteRows.map(
        ({ automationIntentId, executionId, sequence: rowSequence }) => ({
          sequence: rowSequence,
          kind: 3 as const,
          cursorId: automationIntentId,
          item: {
            id: `prerequisite-unavailable:${automationIntentId}`,
            kind: "prerequisite-unavailable" as const,
            ...(executionId === null ? {} : { executionId }),
            summary: "自动刷新所需的文件位置或来源当前不可用，请修复后重新启用",
            automationIntentId,
          },
        }),
      ),
      ...prebindRows.map(({ automationIntentId }) => ({
        sequence: prebindSequence,
        kind: 3 as const,
        cursorId: automationIntentId,
        item: {
          id: `prerequisite-unavailable:${automationIntentId}`,
          kind: "prerequisite-unavailable" as const,
          summary: "自动刷新所需的文件位置或来源当前不可用，请修复后重新启用",
          automationIntentId,
        },
      })),
    ].toSorted(
      (left, right) =>
        right.sequence - left.sequence ||
        left.kind - right.kind ||
        Buffer.compare(
          Buffer.from(left.cursorId, "utf8"),
          Buffer.from(right.cursorId, "utf8"),
        ),
    );
    const selected = candidates.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: selected.map(({ item }) => item),
      ...(candidates.length <= limit || last === undefined
        ? {}
        : {
            nextCursor: encodeCurrentAttentionCursor({
              sequence: last.sequence,
              kind: last.kind,
              id: last.cursorId,
            }),
          }),
    };
  }

  /**
   * 当前目录是已接受主体的投影，而不是工作流执行历史的重放。其完整读取路径
   * （包括已接受图装配器）都保留在 Drizzle 模式构建器内部。
   */
  async listCurrentCataloguePage(
    input: CurrentCataloguePageRequest = {},
  ): Promise<CurrentCataloguePersistencePage> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const limit = currentCataloguePageLimit(input);
    const anchor = currentCatalogueCursor(input.cursor);
    const currentHeads = await query
      .select({ assetId: recognitionHeads.subjectId })
      .from(recognitionHeads)
      .where(
        and(
          currentObservedMaterialPredicate(undefined, input.assetLibraryId),
          sql`EXISTS (
            SELECT 1 FROM entity_kind_assertions assertion
            WHERE assertion.entity_id = ${recognitionHeads.subjectId}
          )`,
          anchor === undefined
            ? undefined
            : gt(recognitionHeads.subjectId, anchor),
          input.subjectIds === undefined
            ? undefined
            : inArray(
                recognitionHeads.subjectId,
                sqliteTextSet(input.subjectIds),
              ),
        ),
      )
      // 已审核的数据库模式保证 `subject_id` 唯一；如果未来的当前来源联接把一个主体
      // 扩展成多条物理行，这里仍是显式的分页边界守卫。
      .groupBy(recognitionHeads.subjectId)
      .orderBy(asc(recognitionHeads.subjectId))
      .limit(limit + 1);
    const pageHeads = currentHeads.slice(0, limit);
    const items = await this.readCurrentAcceptedPageWithDrizzle(
      query,
      pageHeads.map(({ assetId }) => assetId),
      undefined,
      "already-effective",
    );
    const last = pageHeads.at(-1);
    return {
      items,
      ...(currentHeads.length <= limit || last === undefined
        ? {}
        : { nextCursor: encodeCurrentCatalogueCursor(last.assetId) }),
    };
  }

  async listCurrentCatalogueIndex(
    metadataProperties: readonly string[],
    observedRootIds?: readonly string[],
    assetLibraryId?: string,
  ): Promise<readonly CurrentCatalogueIndexFacts[]> {
    const query = drizzle({ client: await this.ensure() });
    const heads = await query
      .select({
        id: recognitionHeads.subjectId,
        additionOrder: sql<number>`${recognitionHeads}.rowid`,
      })
      .from(recognitionHeads)
      .where(currentObservedMaterialPredicate(observedRootIds, assetLibraryId))
      .orderBy(asc(recognitionHeads.subjectId));
    const result: CurrentCatalogueIndexFacts[] = [];
    // 只投影轻量检索事实；完整文件图仍只为最终选中的页面装配。
    for (
      let offset = 0;
      offset < heads.length;
      offset += maximumCataloguePageLimit
    ) {
      const batch = heads.slice(offset, offset + maximumCataloguePageLimit);
      const facts = await this.readCurrentAcceptedPageWithDrizzle(
        query,
        batch.map((head) => head.id),
        metadataProperties,
      );
      const orders = new Map(
        batch.map((head) => [head.id, head.additionOrder]),
      );
      for (const item of facts)
        result.push({
          entity: item.entity,
          additionOrder: orders.get(item.entity.id)!,
          metadata: item.metadata,
          metadataSourceRecords: item.metadataSourceRecords ?? [],
          sourceAssociations: item.sourceAssociations,
          ...(item.recognitionSourceAssociation === undefined
            ? {}
            : {
                recognitionSourceAssociation: item.recognitionSourceAssociation,
              }),
          currentRelatedEntities: item.currentRelatedEntities ?? [],
          relationships: item.relationships ?? [],
          ...(item.relationshipReadBasis === undefined
            ? {}
            : { relationshipReadBasis: item.relationshipReadBasis }),
        });
    }
    return result;
  }

  /**
   * 仅用于兼容的完整投影。交付路径使用 `listCurrentCataloguePage`，
   * 使常规浏览始终有界。
   */
  async listCurrentCatalogue(): Promise<readonly AcceptedAssetState[]> {
    const items: AcceptedAssetState[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listCurrentCataloguePage({
        limit: maximumCataloguePageLimit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }

  async inspectRawSourceRecord(
    executionId: string,
    sourceRecordId: string,
  ): Promise<SourceRecord | undefined> {
    const database = await this.ensure();
    const row = drizzle({ client: database })
      .select()
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.executionId, executionId),
          eq(sourceRecords.id, sourceRecordId),
        ),
      )
      .get();
    return row === undefined ? undefined : sourceRecordFromDrizzle(row);
  }

  async findReusableOrdinaryScan(input: {
    readonly plan: OrdinaryScanReusePlan;
    readonly availableCompatibility: WorkflowExecution["compatibility"];
  }): Promise<WorkflowExecution | undefined> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const rows = query
      .select()
      .from(workflowExecutions)
      .where(
        and(
          inArray(workflowExecutions.outcome, [
            "accepted",
            "partially-succeeded",
          ]),
          eq(workflowExecutions.reusePlanJson, JSON.stringify(input.plan)),
        ),
      )
      .orderBy(desc(sql<number>`${workflowExecutions}.rowid`))
      .all();
    for (const row of rows) {
      const execution =
        this.workflowExecutionPersistence.executionFromDrizzle(row);
      if (
        execution.acceptedAssetId === undefined ||
        query
          .select({ subjectId: recognitionHeads.subjectId })
          .from(recognitionHeads)
          .where(eq(recognitionHeads.subjectId, execution.acceptedAssetId))
          .get() === undefined
      ) {
        continue;
      }
      const proposal =
        execution.proposalId === undefined
          ? undefined
          : this.readProposalWithDrizzle(query, execution.proposalId);
      const accepted =
        execution.acceptedAssetId === undefined
          ? undefined
          : await this.readCurrentAcceptedWithDrizzle(
              query,
              execution.acceptedAssetId,
            );
      // 重新评估拥有新的提案/来源记录基线，而其不可变识别决定仍指向最初建立身份的提案。
      // 因此复用时必须将当前关联与本次执行的提案比较，而不能要求两个不可变提案 ID 相等。
      const recognitionSourceAssociation =
        accepted?.recognitionSourceAssociation;
      if (proposal === undefined || accepted === undefined) continue;
      const proposalInterpretation = recognitionSourceInterpretation(proposal);
      if (proposalInterpretation === undefined) {
        if (
          proposal.basis.kind !== "observed-evidence" ||
          accepted.proposal.basis.kind !== "observed-evidence" ||
          accepted.proposal.id !== proposal.id ||
          recognitionSourceAssociation !== undefined
        )
          continue;
      } else if (
        recognitionSourceAssociation === undefined ||
        recognitionSourceAssociation.sourceIdentity !==
          proposalInterpretation.sourceIdentity ||
        recognitionSourceAssociation.nativeAddress !==
          proposalInterpretation.sourceAddress
      )
        continue;
      if (
        workflowCompatibilityCanReuse(
          execution.compatibility,
          input.availableCompatibility,
        )
      )
        return execution;
    }
    return undefined;
  }

  async listEffectiveMaterialBoundaries(
    input: Parameters<
      AssetRefreshReuseQueries["listEffectiveMaterialBoundaries"]
    >[0],
  ): Promise<readonly EffectiveRecognitionMaterialBoundary[]> {
    const database = await this.ensure();
    const address = path.resolve(
      input.scope.containerPath,
      input.relativeScope,
    );
    // 所有仍生效的支持决定都参与，包括未推进主 head 的人工补充材料。
    const rows = database
      .prepare(`
      SELECT d.asset_id AS assetId, d.id AS decisionId,
             b.value AS boundaryJson,
             COALESCE(r.container_path, json_extract(e.snapshot_json, '$.root'), json_extract(e.material_association_json, '$.snapshot.root')) AS rootPath
      FROM recognition_decisions d, json_each(d.boundaries_json) b
      LEFT JOIN observed_root_registrations r
        ON r.id = json_extract(b.value, '$.scopeReference')
      LEFT JOIN workflow_executions e
        ON 'legacy-execution:' || e.id = json_extract(b.value, '$.scopeReference')
      WHERE COALESCE(r.container_path, json_extract(e.snapshot_json, '$.root'), json_extract(e.material_association_json, '$.snapshot.root')) IS NOT NULL
      AND (
        COALESCE(r.container_path, json_extract(e.snapshot_json, '$.root'), json_extract(e.material_association_json, '$.snapshot.root')) = ?
        OR substr(?, 1, length(rtrim(COALESCE(r.container_path, json_extract(e.snapshot_json, '$.root'), json_extract(e.material_association_json, '$.snapshot.root')), '/')) + 1)
             = rtrim(COALESCE(r.container_path, json_extract(e.snapshot_json, '$.root'), json_extract(e.material_association_json, '$.snapshot.root')), '/') || '/'
        OR substr(COALESCE(r.container_path, json_extract(e.snapshot_json, '$.root'), json_extract(e.material_association_json, '$.snapshot.root')), 1, length(rtrim(?, '/')) + 1) = rtrim(?, '/') || '/'
      ) AND NOT EXISTS (
        SELECT 1 FROM recognition_decision_supersessions s
        WHERE s.predecessor_decision_id = d.id
      ) AND NOT EXISTS (
        SELECT 1 FROM recognition_decision_retractions t
        WHERE t.predecessor_decision_id = d.id
      )
    `)
      .all(address, address, address, address) as unknown as readonly {
      assetId: string;
      decisionId: string;
      boundaryJson: string;
      rootPath: string;
    }[];
    return rows.flatMap(({ boundaryJson, ...row }) => {
      const item: EffectiveRecognitionMaterialBoundary = {
        ...row,
        boundary: JSON.parse(
          boundaryJson,
        ) as EffectiveRecognitionMaterialBoundary["boundary"],
      };
      const overlaps = recognitionMaterialBoundaryIntersectsScope(
        item,
        address,
      );
      return overlaps ? [item] : [];
    });
  }

  async listEffectiveMaterialBoundariesForSubject(input: {
    readonly assetId: string;
  }): Promise<readonly EffectiveRecognitionMaterialBoundary[]> {
    const database = await this.ensure();
    return this.effectiveMaterialBoundariesWithDrizzle(
      drizzle({ client: database }),
      input.assetId,
    );
  }

  async listMaterialScopeDeclarations(input: {
    readonly scopeAddress: string;
  }): Promise<readonly MaterialScopeDeclaration[]> {
    const database = await this.ensure();
    return this.materialScopeDeclarationsWithDrizzle(
      drizzle({ client: database }),
      input.scopeAddress,
    );
  }

  /**
   * 与该范围相交的完整声明：被点名时纳入该决定的全部声明成员（不是只纳入相交的那
   * 几个），并带上主头标识与已经结束的历史决定。Application 冻结范围基线与确认事务内
   * 的重算比较共用这一份推导，绝不各自解释根坐标。
   */
  private materialScopeDeclarationsWithDrizzle(
    query: DrizzleReadQuery,
    scopeAddress: string,
  ): readonly MaterialScopeDeclaration[] {
    const heads = new Set(
      query
        .select({ decisionId: recognitionHeads.recognitionDecisionId })
        .from(recognitionHeads)
        .all()
        .flatMap((head) => (head.decisionId === null ? [] : [head.decisionId])),
    );
    const members: EffectiveRecognitionMaterialBoundary[] = [];
    const ended: {
      readonly assetId: string;
      readonly decisionId: string;
      readonly endedAs: "superseded" | "retracted";
    }[] = [];
    const decisions = query
      .select({
        assetId: recognitionDecisions.assetId,
        decisionId: recognitionDecisions.id,
        boundariesJson: recognitionDecisions.boundariesJson,
      })
      .from(recognitionDecisions)
      .all();
    const declared = new Map<string, EffectiveRecognitionMaterialBoundary[]>();
    const rootPaths = this.recognitionMaterialBoundaryRootPathsWithDrizzle(
      query,
      decisions.flatMap((decision) =>
        (
          JSON.parse(
            decision.boundariesJson,
          ) as RecognitionDecision["boundaries"]
        ).map((boundary) => boundary.scopeReference),
      ),
    );
    for (const decision of decisions) {
      const items = (
        JSON.parse(decision.boundariesJson) as RecognitionDecision["boundaries"]
      )
        .map((boundary) => {
          const rootPath = rootPaths.get(boundary.scopeReference);
          return rootPath === undefined
            ? undefined
            : ({
                assetId: decision.assetId,
                decisionId: decision.decisionId,
                boundary,
                rootPath,
              } satisfies EffectiveRecognitionMaterialBoundary);
        })
        .filter((member) => member !== undefined);
      if (items.length !== 0) declared.set(decision.decisionId, items);
    }
    const endedAs = this.recognitionDecisionEndingsWithDrizzle(
      query,
      decisions.map((decision) => decision.decisionId),
    );
    for (const [decisionId, items] of declared) {
      const reason = endedAs.get(decisionId);
      if (reason !== undefined)
        ended.push({ assetId: items[0]!.assetId, decisionId, endedAs: reason });
      // 任一成员与该范围相交就带上整份声明，绝不只带相交的那几个成员。
      if (
        items.some((member) =>
          recognitionMaterialBoundaryIntersectsScope(member, scopeAddress),
        )
      )
        members.push(...items);
    }
    return groupMaterialScopeDeclarations(members, {
      ended,
      headDecisionIds: [...heads],
    });
  }

  async findAcceptedForDirectory(directory: string): Promise<
    | {
        readonly accepted: AcceptedRecognition;
        readonly execution: WorkflowExecution;
      }
    | undefined
  > {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const rows = query
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.selectionDirectory, directory),
          inArray(workflowExecutions.outcome, [
            "accepted",
            "partially-succeeded",
          ]),
        ),
      )
      .orderBy(desc(sql<number>`${workflowExecutions}.rowid`))
      .all();
    for (const row of rows) {
      const inspection = await this.inspectExecution(row.id);
      if (inspection?.accepted !== undefined) {
        const current = await this.readCurrentAcceptedWithDrizzle(
          query,
          inspection.accepted.entity.id,
        );
        if (current === undefined) continue;
        return {
          execution: inspection.execution,
          accepted: current,
        };
      }
      const itemAccepted = inspection?.workItemInspections?.find(
        (item) => item.accepted !== undefined,
      )?.accepted;
      if (itemAccepted !== undefined) {
        const current = await this.readCurrentAcceptedWithDrizzle(
          query,
          itemAccepted.entity.id,
        );
        if (current === undefined) continue;
        return {
          execution: inspection!.execution,
          accepted: current,
        };
      }
    }
    return undefined;
  }

  async findAcceptedForSubjects(subjectIds: readonly string[]): Promise<
    readonly {
      readonly subjectId: string;
      readonly accepted: AcceptedRecognition;
      readonly execution: WorkflowExecution;
    }[]
  > {
    return this.findAcceptedWithNamedMetadata(subjectIds);
  }

  private async findAcceptedWithNamedMetadata(
    subjectIds: readonly string[],
    namedMetadataSubjectIds: readonly string[] = [],
  ): ReturnType<SqliteCatalogue["findAcceptedForSubjects"]> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const found: Array<{
      readonly subjectId: string;
      readonly accepted: AcceptedRecognition;
      readonly execution: WorkflowExecution;
    }> = [];
    for (const subjectId of subjectIds) {
      const accepted = await this.readCurrentAcceptedWithDrizzle(
        query,
        subjectId,
        undefined,
        false,
        namedMetadataSubjectIds,
      );
      if (accepted === undefined) continue;
      const row = query
        .select({ executionId: recognitionProposals.executionId })
        .from(recognitionHeads)
        .innerJoin(
          recognitionDecisions,
          eq(recognitionDecisions.id, recognitionHeads.recognitionDecisionId),
        )
        .innerJoin(
          recognitionProposals,
          eq(recognitionProposals.id, recognitionDecisions.proposalId),
        )
        .where(eq(recognitionHeads.subjectId, subjectId))
        .get();
      if (row === undefined) continue;
      const executionRow = query
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, row.executionId))
        .get();
      if (executionRow === undefined) continue;
      found.push({
        subjectId,
        accepted,
        execution:
          this.workflowExecutionPersistence.executionFromDrizzle(executionRow),
      });
    }
    return found;
  }

  /**
   * 逐决定复用的读取入口：按被点名的决定返回它自己的提案、形成该决定的观察执行与快照，
   * 以及该主体当前仍有效的已接受投影。主头执行不能替代追加范围的比较基线。
   */
  async findAcceptedForDecision(input: {
    readonly decisionId: string;
  }): Promise<
    | {
        readonly accepted: AcceptedRecognition;
        readonly proposal: RecognitionProposal;
        readonly execution: WorkflowExecution;
      }
    | undefined
  > {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const decision = query
      .select({
        assetId: recognitionDecisions.assetId,
        proposalId: recognitionDecisions.proposalId,
      })
      .from(recognitionDecisions)
      .where(eq(recognitionDecisions.id, input.decisionId))
      .get();
    if (decision === undefined) return undefined;
    const proposalRow = query
      .select({ executionId: recognitionProposals.executionId })
      .from(recognitionProposals)
      .where(eq(recognitionProposals.id, decision.proposalId))
      .get();
    if (proposalRow === undefined) return undefined;
    const proposal = this.readProposalWithDrizzle(query, decision.proposalId);
    if (proposal === undefined) return undefined;
    const executionRow = query
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, proposalRow.executionId))
      .get();
    if (executionRow === undefined) return undefined;
    const accepted = await this.readCurrentAcceptedWithDrizzle(
      query,
      decision.assetId,
      input.decisionId,
    );
    if (accepted === undefined) return undefined;
    return {
      accepted,
      proposal,
      execution:
        this.workflowExecutionPersistence.executionFromDrizzle(executionRow),
    };
  }

  /**
   * 从历史已接受事实里筛出仍具当前材料成员资格的主体。判定复用分页、索引与关系
   * 入口所依据的同一个观察材料谓词，不另立当前性定义；历史读取本身不受影响。
   */
  private currentCatalogueSubjectIdsWithDrizzle(
    query: DrizzleReadQuery,
    subjectIds: readonly string[],
  ): Set<string> {
    if (subjectIds.length === 0) return new Set();
    return new Set(
      query
        .select({ subjectId: recognitionHeads.subjectId })
        .from(recognitionHeads)
        .where(
          and(
            inArray(recognitionHeads.subjectId, sqliteTextSet(subjectIds)),
            isNotNull(recognitionHeads.recognitionDecisionId),
            currentObservedMaterialPredicate(),
          ),
        )
        .all()
        .map(({ subjectId }) => subjectId),
    );
  }

  async findCurrentRelationshipParticipant(
    entityId: string,
  ): Promise<CatalogueEntityRelationshipFacts | undefined> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const forest = this.effectiveIdentityForestWithDrizzle(query);
    const representativeId =
      forest.representativeByEntity.get(entityId) ?? entityId;
    const memberIds = forest.membersByRepresentative.get(representativeId) ?? [
      representativeId,
    ];
    const currentAsset = query
      .select({ id: recognitionHeads.subjectId })
      .from(recognitionHeads)
      .where(
        and(
          eq(recognitionHeads.subjectId, representativeId),
          isNotNull(recognitionHeads.recognitionDecisionId),
          currentObservedMaterialPredicate(),
        ),
      )
      .get();
    if (
      currentAsset === undefined &&
      !this.hasCurrentRelatedEntityInGroupWithDrizzle(query, memberIds)
    )
      return undefined;
    const entity = query
      .select({
        id: entities.id,
        sourceIdentity: sourcedEntities.sourceIdentity,
        sourceKey: sourcedEntities.sourceKey,
        identityNamespace: sourcedEntities.identityNamespace,
        sourcedLabel: sourcedEntities.label,
        observedLabel: observedEntities.label,
        localLabel: localEntityNames.label,
      })
      .from(entities)
      .leftJoin(sourcedEntities, eq(sourcedEntities.id, entities.id))
      .leftJoin(observedEntities, eq(observedEntities.id, entities.id))
      .leftJoin(localEntityNames, eq(localEntityNames.entityId, entities.id))
      .where(eq(entities.id, representativeId))
      .get();
    if (entity === undefined) return undefined;
    const latestManualByMention = new Map<
      string,
      typeof entityResolutionDecisions.$inferSelect
    >();
    for (const decision of query
      .select()
      .from(entityResolutionDecisions)
      .where(eq(entityResolutionDecisions.basis, "manual"))
      .orderBy(desc(sql<number>`${entityResolutionDecisions}.rowid`))
      .all())
      if (!latestManualByMention.has(decision.mentionId))
        latestManualByMention.set(decision.mentionId, decision);
    const manualMentionIds = [...latestManualByMention.values()].flatMap(
      (decision) =>
        decision.operation === "select" &&
        (forest.representativeByEntity.get(decision.entityId) ??
          decision.entityId) === representativeId
          ? [decision.mentionId]
          : [],
    );
    const manualRelationshipIds =
      manualMentionIds.length === 0
        ? []
        : query
            .select()
            .from(entityRelationshipParticipants)
            .all()
            .filter((participant) =>
              (JSON.parse(participant.mentionIdsJson) as string[]).some((id) =>
                manualMentionIds.includes(id),
              ),
            )
            .map((participant) => participant.relationshipId);
    const manuallySupportedRelationshipIds = query
      .select({ relationshipId: relationshipManualSupports.relationshipId })
      .from(entityRelationshipParticipants)
      .innerJoin(
        relationshipManualSupports,
        eq(
          relationshipManualSupports.relationshipId,
          entityRelationshipParticipants.relationshipId,
        ),
      )
      .where(
        inArray(
          entityRelationshipParticipants.entityId,
          sqliteTextSet(memberIds),
        ),
      )
      .all()
      .map(({ relationshipId }) => relationshipId);
    const relationshipRows = [
      ...new Map([
        ...query
          .select({ relationship: entityRelationships })
          .from(entityRelationshipParticipants)
          .innerJoin(
            entityRelationships,
            eq(
              entityRelationships.id,
              entityRelationshipParticipants.relationshipId,
            ),
          )
          .where(
            inArray(
              entityRelationshipParticipants.entityId,
              sqliteTextSet(memberIds),
            ),
          )
          .orderBy(asc(sql<number>`${entityRelationships}.rowid`))
          .all()
          .map(({ relationship }) => [relationship.id, relationship] as const),
        ...(manualRelationshipIds.length === 0
          ? []
          : query
              .select()
              .from(entityRelationships)
              .where(
                inArray(
                  entityRelationships.id,
                  sqliteTextSet(manualRelationshipIds),
                ),
              )
              .all()
              .map((relationship) => [relationship.id, relationship] as const)),
        ...(manuallySupportedRelationshipIds.length === 0
          ? []
          : query
              .select()
              .from(entityRelationships)
              .where(
                inArray(
                  entityRelationships.id,
                  sqliteTextSet(manuallySupportedRelationshipIds),
                ),
              )
              .all()
              .map((relationship) => [relationship.id, relationship] as const)),
      ]).values(),
    ];
    const relationshipIds = uniqueStrings(
      relationshipRows.map((row) => row.id),
    );
    const supports = this.relationshipSupportsWithDrizzle(
      query,
      relationshipIds,
    );
    const lifecycleByRelationshipId = supports.lifecyclesByRelationshipId;
    const observedCurrentRelationshipSourceSlots =
      supports.observedSourceSlotsByRelationshipId;
    const resolvedMentions = this.relationshipMentionEntitiesWithDrizzle(
      query,
      uniqueStrings(
        relationshipRows.flatMap((row) =>
          relationshipParticipantsFromJson(row.participantsJson).flatMap(
            (participant) => participant.mentionIds ?? [],
          ),
        ),
      ),
    );
    const resolvedRelationshipMentionEntityId = (mentionId: string) =>
      resolvedMentions.get(mentionId);
    const currentRelationshipRows = relationshipRows.filter(
      (relationship) =>
        (((lifecycleByRelationshipId.has(relationship.id) ||
          supports.manualRelationshipIds.has(relationship.id)) &&
          !supports.retractedRelationshipIds.has(relationship.id) &&
          !supports.supersededRelationshipIds.has(relationship.id)) ||
          observedCurrentRelationshipSourceSlots.has(relationship.id)) &&
        relationshipParticipantsFromJson(relationship.participantsJson).some(
          (participant) =>
            (participant.mentionIds ?? [participant.entityId]).some(
              (mentionOrEntityId) => {
                const participantEntityId =
                  participant.mentionIds === undefined
                    ? mentionOrEntityId
                    : resolvedRelationshipMentionEntityId(mentionOrEntityId);
                return (
                  (forest.representativeByEntity.get(
                    participantEntityId ?? "",
                  ) ?? participantEntityId) === representativeId
                );
              },
            ),
        ),
    );
    const relationships = currentRelationshipRows.map((relationship) => {
      const lifecycle = lifecycleByRelationshipId.get(relationship.id);
      return {
        id: relationship.id,
        participants: relationshipParticipantsFromJson(
          relationship.participantsJson,
        ).map(({ entityId: participantId, role, mentionIds }) => {
          const resolvedParticipantId =
            mentionIds
              ?.map((mentionId) =>
                resolvedRelationshipMentionEntityId(mentionId),
              )
              .find((resolved) => resolved !== undefined) ?? participantId;
          return {
            entityId:
              forest.representativeByEntity.get(resolvedParticipantId) ??
              resolvedParticipantId,
            role,
          };
        }),
        type: relationship.type,
        qualifiers: JSON.parse(relationship.qualifiersJson) as NonNullable<
          EntityRelationship["qualifiers"]
        >,
        sources:
          lifecycle === undefined
            ? []
            : [
                {
                  sourceIdentity: lifecycle.sourceIdentity,
                  nativeAddress: lifecycle.nativeAddress,
                },
              ],
      };
    });
    const effective = deriveEffectiveRelationships({
      relationships: currentRelationshipRows.map((relationship) => ({
        id: relationship.id,
        participants: relationshipParticipantsFromJson(
          relationship.participantsJson,
        ),
        type: relationship.type,
        sourceSlot:
          lifecycleByRelationshipId.get(relationship.id)?.sourceSlot ??
          observedCurrentRelationshipSourceSlots.get(relationship.id) ??
          "manual",
        sourceRecordIds: jsonStringArray(
          relationship.sourceRecordIdsJson,
          "relationship source records",
        ),
        qualifiers: JSON.parse(relationship.qualifiersJson) as NonNullable<
          EntityRelationship["qualifiers"]
        >,
      })),
      targets: supports.targetsByRelationshipId,
      decisions: this.relationshipHeadDecisionsWithDrizzle(query),
      manualRelationshipIds: supports.manualRelationshipIds,
    });
    const effectiveRelationshipIds = new Set(effective.map(({ id }) => id));
    const effectiveRelationships = relationships.filter(({ id }) =>
      effectiveRelationshipIds.has(id),
    );
    const effectiveRelationshipRows = currentRelationshipRows.filter(({ id }) =>
      effectiveRelationshipIds.has(id),
    );
    const participantRows =
      effectiveRelationshipRows.length === 0
        ? []
        : query
            .select({ entityId: entityRelationshipParticipants.entityId })
            .from(entityRelationshipParticipants)
            .where(
              inArray(
                entityRelationshipParticipants.relationshipId,
                sqliteTextSet(effectiveRelationshipRows.map((row) => row.id)),
              ),
            )
            .all();
    const effectiveRelationshipSourceRecordIds = uniqueStrings(
      effectiveRelationshipRows.flatMap((relationship) => {
        const sourceRecordId = lifecycleByRelationshipId.get(
          relationship.id,
        )?.sourceRecordId;
        return sourceRecordId === undefined ? [] : [sourceRecordId];
      }),
    );
    const sourceAssetIdsFromLineage =
      effectiveRelationshipSourceRecordIds.length === 0
        ? []
        : query
            .select({ subjectId: sourceLineageHeads.subjectId })
            .from(sourceLineageHeads)
            .where(
              inArray(
                sourceLineageHeads.sourceRecordId,
                sqliteTextSet(effectiveRelationshipSourceRecordIds),
              ),
            )
            .all()
            .map(({ subjectId }) => subjectId);
    const effectiveRelationshipSourceCoordinates = new Set(
      effectiveRelationshipRows.flatMap((relationship) => {
        const lifecycle = lifecycleByRelationshipId.get(relationship.id);
        return lifecycle === undefined
          ? []
          : [`${lifecycle.sourceIdentity}\u0000${lifecycle.nativeAddress}`];
      }),
    );
    const sourceAssetIdsFromAssociation =
      effectiveRelationshipSourceCoordinates.size === 0
        ? []
        : query
            .select({
              subjectId: sourceAssociations.subjectId,
              sourceIdentity: sourceAssociations.sourceIdentity,
              nativeAddress: sourceAssociations.nativeAddress,
            })
            .from(currentSourceAssociations)
            .innerJoin(
              sourceAssociations,
              eq(
                sourceAssociations.id,
                currentSourceAssociations.associationId,
              ),
            )
            .all()
            .flatMap(({ subjectId, sourceIdentity, nativeAddress }) =>
              effectiveRelationshipSourceCoordinates.has(
                `${sourceIdentity}\u0000${nativeAddress}`,
              )
                ? [subjectId]
                : [],
            );
    const sourceAssetIds = uniqueStrings([
      ...sourceAssetIdsFromLineage,
      ...sourceAssetIdsFromAssociation,
    ]);
    const candidates = uniqueStrings([
      ...participantRows.map((row) => row.entityId),
      ...sourceAssetIds,
      ...effectiveRelationshipRows.flatMap((relationship) => {
        const sourceSubjectId = lifecycleByRelationshipId.get(
          relationship.id,
        )?.sourceSubjectId;
        return sourceSubjectId === undefined || sourceSubjectId.length === 0
          ? []
          : [sourceSubjectId];
      }),
    ]);
    const currentCandidateIds = this.currentCatalogueSubjectIdsWithDrizzle(
      query,
      candidates,
    );
    const accepted = await this.findAcceptedForSubjects(
      candidates.filter((subjectId) => currentCandidateIds.has(subjectId)),
    );
    // 资料断言的 subject 是原属相关实体，不是数字资产；从当前资产投影反查，不能借用关系邻接。
    const metadataSubjectIds = query
      .select({ subjectId: recognitionHeads.subjectId })
      .from(recognitionHeads)
      .where(sql`${recognitionHeads.recognitionDecisionId} IS NOT NULL`)
      .all()
      .map(({ subjectId }) => subjectId);
    const metadataAccepted = await this.findAcceptedWithNamedMetadata(
      metadataSubjectIds,
      memberIds,
    );
    return {
      entity: {
        id: entity.id,
        kind: this.relatedEntityKindWithDrizzle(query, entity.id),
        label:
          entity.sourcedLabel ??
          entity.observedLabel ??
          entity.localLabel ??
          entity.id,
        ...(entity.sourceIdentity === null
          ? {}
          : { sourceIdentity: entity.sourceIdentity }),
        ...(entity.sourceKey === null ? {} : { sourceKey: entity.sourceKey }),
        ...(entity.identityNamespace === null
          ? {}
          : { identityNamespace: entity.identityNamespace }),
      },
      memberIds,
      relationships: effectiveRelationships,
      metadataAccepted: metadataAccepted.filter(({ accepted: state }) =>
        state.metadata.some(
          (assertion) =>
            assertion.target.kind === "entity" &&
            memberIds.includes(assertion.target.entityId),
        ),
      ),
      accepted: accepted.filter(
        ({ subjectId, accepted: state }) =>
          effectiveRelationshipRows.some((current) =>
            relationshipParticipantsFromJson(current.participantsJson).some(
              (participant) => participant.entityId === subjectId,
            ),
          ) ||
          (state.relationships ?? []).some((relationship) =>
            effectiveRelationshipRows.some(
              (current) => current.id === relationship.id,
            ),
          ) ||
          effectiveRelationshipRows.some(
            (current) =>
              lifecycleByRelationshipId.get(current.id)?.sourceSubjectId ===
              subjectId,
          ) ||
          sourceAssetIds.includes(subjectId),
      ),
    };
  }

  async findCurrentSourceAssociationByCoordinate(input: {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  }): Promise<SourceAssociation | undefined> {
    const database = await this.ensure();
    const row = drizzle({ client: database })
      .select({ association: sourceAssociations })
      .from(currentSourceAssociations)
      .innerJoin(
        sourceAssociations,
        eq(sourceAssociations.id, currentSourceAssociations.associationId),
      )
      .where(
        and(
          eq(sourceAssociations.sourceIdentity, input.sourceIdentity),
          eq(sourceAssociations.nativeAddress, input.nativeAddress),
        ),
      )
      .get();
    return row?.association;
  }

  async inspectSourceAssociationHistory(assetId: string): Promise<
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
  > {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    if (
      !this.currentEffectiveDigitalAssetIdsWithDrizzle(query, [
        assetId,
      ]).includes(assetId)
    )
      return undefined;
    const head = query
      .select({ decisionId: recognitionHeads.recognitionDecisionId })
      .from(recognitionHeads)
      .where(eq(recognitionHeads.subjectId, assetId))
      .get();
    if (head === undefined) return undefined;
    const all = query
      .select()
      .from(sourceAssociations)
      .where(eq(sourceAssociations.subjectId, assetId))
      .orderBy(asc(sql<number>`${sourceAssociations}.rowid`))
      .all();
    const currentIds = new Set(
      query
        .select({ id: currentSourceAssociations.associationId })
        .from(currentSourceAssociations)
        .where(eq(currentSourceAssociations.subjectId, assetId))
        .all()
        .map(({ id: associationId }) => associationId),
    );
    const superseded = new Set(
      query
        .select({ id: sourceAssociationSupersessions.predecessorAssociationId })
        .from(sourceAssociationSupersessions)
        .all()
        .map(({ id: associationId }) => associationId),
    );
    const retracted = new Set(
      query
        .select({ id: sourceAssociationRetractions.associationId })
        .from(sourceAssociationRetractions)
        .all()
        .map(({ id: associationId }) => associationId),
    );
    const retired = new Set(
      query
        .select({ id: sourceAssociationLegacyRetirements.associationId })
        .from(sourceAssociationLegacyRetirements)
        .all()
        .map(({ id: associationId }) => associationId),
    );
    const retractionAuthority = new Map<
      string,
      SourceAssociationTerminationAudit
    >();
    for (const retraction of query
      .select()
      .from(sourceAssociationRetractions)
      .all()) {
      if (retraction.recognitionDecisionSupersessionId !== null) {
        const supersession = query
          .select()
          .from(recognitionDecisionSupersessions)
          .where(
            eq(
              recognitionDecisionSupersessions.id,
              retraction.recognitionDecisionSupersessionId,
            ),
          )
          .get();
        const predecessor =
          supersession === undefined
            ? undefined
            : query
                .select({ proposalId: recognitionDecisions.proposalId })
                .from(recognitionDecisions)
                .where(
                  eq(
                    recognitionDecisions.id,
                    supersession.predecessorDecisionId,
                  ),
                )
                .get();
        const successor =
          supersession === undefined
            ? undefined
            : query
                .select({ proposalId: recognitionDecisions.proposalId })
                .from(recognitionDecisions)
                .where(
                  eq(recognitionDecisions.id, supersession.successorDecisionId),
                )
                .get();
        if (
          supersession !== undefined &&
          predecessor !== undefined &&
          successor !== undefined
        )
          retractionAuthority.set(retraction.associationId, {
            kind: "recognition-decision-supersession",
            supersessionId: supersession.id,
            predecessorDecisionId: supersession.predecessorDecisionId,
            predecessorProposalId: predecessor.proposalId,
            successorDecisionId: supersession.successorDecisionId,
            successorProposalId: successor.proposalId,
          });
      } else if (retraction.sourceAssociationDecisionId !== null) {
        retractionAuthority.set(retraction.associationId, {
          kind: "source-association-decision",
          decisionId: retraction.sourceAssociationDecisionId,
        });
      } else if (retraction.recognitionDecisionRetractionId !== null) {
        retractionAuthority.set(retraction.associationId, {
          kind: "recognition-decision-retraction",
          retractionId: retraction.recognitionDecisionRetractionId,
        });
      }
    }
    return {
      recognitionState: head.decisionId === null ? "unresolved" : "recognized",
      ...(head.decisionId === null
        ? {}
        : { recognitionDecisionId: head.decisionId }),
      current: all.filter(({ id: associationId }) =>
        currentIds.has(associationId),
      ),
      historical: all.flatMap((association) => {
        const status = superseded.has(association.id)
          ? ("superseded" as const)
          : retracted.has(association.id)
            ? ("retracted" as const)
            : retired.has(association.id)
              ? ("legacy-retired" as const)
              : undefined;
        const authorizedBy = retractionAuthority.get(association.id);
        return status === undefined
          ? []
          : [
              {
                association,
                status,
                ...(authorizedBy === undefined ? {} : { authorizedBy }),
              },
            ];
      }),
    };
  }

  /**
   * 仅通过持久的已观察物料事实解析跨位置连续性。这里的产物 ID 是观察者所拥有的
   * 不透明身份的确定性哈希，绝不是文件名或 `Blob` 摘要。下方的当前已接受资产装配
   * 会过滤过期或已撤回的关联。
   */
  async findCurrentAcceptedForObservedArtifacts(input: {
    readonly artifactIds: readonly string[];
  }): Promise<ObservedArtifactReuseMatch> {
    const artifactIds = uniqueStrings(input.artifactIds);
    if (artifactIds.length === 0) return { status: "none" };
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const candidateRows = query
      .select({ subjectId: artifactAssociations.subjectId })
      .from(artifactAssociations)
      .where(
        and(
          inArray(artifactAssociations.artifactId, sqliteTextSet(artifactIds)),
          eq(artifactAssociations.role, "asset.material-delivered"),
        ),
      )
      .all();
    const subjectIds = uniqueStrings(
      candidateRows.map((candidate) => candidate.subjectId),
    );
    if (subjectIds.length === 0) return { status: "none" };

    const current = await this.findAcceptedForSubjects(subjectIds);
    const exact = current.filter((candidate) => {
      const currentObservedMaterial = new Set(
        candidate.accepted.artifactAssociations.flatMap((association) =>
          entityTargetId(association) === candidate.subjectId &&
          association.role === "asset.material-delivered" &&
          association.observedArtifactPart === undefined &&
          (association.sourceRecordIds === undefined ||
            association.sourceRecordIds.length === 0)
            ? [association.artifactId]
            : [],
        ),
      );
      return artifactIds.every((artifactId) =>
        currentObservedMaterial.has(artifactId),
      );
    });
    if (exact.length === 0) return { status: "none" };
    if (exact.length === 1) {
      const match = exact[0]!;
      return {
        status: "one",
        accepted: match.accepted,
        execution: match.execution,
      };
    }
    return {
      status: "ambiguous",
      assetIds: exact.map((candidate) => candidate.subjectId).toSorted(),
    };
  }

  /**
   * 只供应各个已选当前主体拥有的完整事实依据及真实来源头部当前性。生效描述、关系与
   * 图片角色的裁决由应用层共同读取完成，持久层不再投影存在性。
   */
  async readCurrentInformationSubjectFacts(input: {
    readonly subjectIds: readonly string[];
  }): Promise<readonly CurrentInformationSubjectFacts[]> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const facts: CurrentInformationSubjectFacts[] = [];
    for (const subjectId of input.subjectIds) {
      const accepted = await this.readCurrentAcceptedWithDrizzle(
        query,
        subjectId,
      );
      if (accepted === undefined) continue;
      // 只有绑定来源的托管关联需要来源头部当前性；观察与本地关联交由位置可用性判定。
      const sourceArtifactCurrency: {
        readonly associationId: string;
        readonly current: boolean;
      }[] = [];
      for (const association of accepted.artifactAssociations) {
        const sourceAssociationId = association.sourceAssociationId;
        if (sourceAssociationId === undefined) continue;
        if (entityTargetId(association) !== subjectId) continue;
        sourceArtifactCurrency.push({
          associationId: association.id,
          current: this.isCurrentSourceArtifactAssociation(query, {
            subjectId,
            sourceAssociationId,
            sourceRecordIds: association.sourceRecordIds,
          }),
        });
      }
      facts.push({
        subjectId,
        basis: { ...accepted, id: subjectId },
        sourceArtifactCurrency,
      });
    }
    return facts;
  }

  /**
   * 主体当前观察材料引用的活动观察根。库语境解析只读这一事实，绝不据此建立「资产属于库」
   * 的耐久结论；被取代或撤回的关联不再提供成员资格。
   */
  async readCurrentObservedMaterialRootIds(input: {
    readonly subjectIds: readonly string[];
  }): Promise<
    readonly {
      readonly subjectId: string;
      readonly observedRootIds: readonly string[];
    }[]
  > {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    if (input.subjectIds.length === 0) return [];
    const rows = query
      .select({
        subjectId: artifactAssociations.subjectId,
        observedRootId: currentObservedMaterialSupports.observedRootId,
      })
      .from(artifactAssociations)
      .innerJoin(
        locations,
        eq(locations.artifactId, artifactAssociations.artifactId),
      )
      .innerJoin(
        currentObservedMaterialSupports,
        eq(currentObservedMaterialSupports.locationId, locations.id),
      )
      .innerJoin(
        observedRootRegistrations,
        and(
          eq(
            observedRootRegistrations.id,
            currentObservedMaterialSupports.observedRootId,
          ),
          eq(
            observedRootRegistrations.configVersion,
            currentObservedMaterialSupports.observedRootVersion,
          ),
          eq(observedRootRegistrations.status, "active"),
        ),
      )
      .where(
        and(
          eq(locations.kind, "observed"),
          inArray(artifactAssociations.subjectId, input.subjectIds),
          sql`NOT EXISTS (
            SELECT 1 FROM ${artifactAssociationSupersessions}
            WHERE ${artifactAssociationSupersessions.predecessorAssociationId} = ${artifactAssociations.id}
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${artifactAssociationRetractions}
            WHERE ${artifactAssociationRetractions.associationId} = ${artifactAssociations.id}
          )`,
        ),
      )
      .groupBy(
        artifactAssociations.subjectId,
        currentObservedMaterialSupports.observedRootId,
      )
      .all();
    const rootIdsBySubject = new Map<string, string[]>();
    for (const row of rows) {
      const roots = rootIdsBySubject.get(row.subjectId) ?? [];
      roots.push(row.observedRootId);
      rootIdsBySubject.set(row.subjectId, roots);
    }
    return input.subjectIds
      .map((subjectId) => ({
        subjectId,
        observedRootIds: rootIdsBySubject.get(subjectId) ?? [],
      }))
      .filter((entry) => entry.observedRootIds.length > 0);
  }

  /**
   * 只有当托管来源产物至少有一条来源记录仍是其精确来源关联的当前头部时，
   * 它才能满足需求。关联身份可防止一个来源遮蔽同一主体下另一关联提供的更新候选项。
   */
  private isCurrentSourceArtifactAssociation(
    query: DrizzleReadQuery,
    input: {
      readonly subjectId: string;
      readonly sourceAssociationId: string;
      readonly sourceRecordIds: readonly string[] | undefined;
    },
  ): boolean {
    if (
      input.sourceRecordIds === undefined ||
      input.sourceRecordIds.length === 0
    )
      return false;
    const association = query
      .select({
        sourceIdentity: sourceAssociations.sourceIdentity,
        nativeAddress: sourceAssociations.nativeAddress,
      })
      .from(currentSourceAssociations)
      .innerJoin(
        sourceAssociations,
        eq(currentSourceAssociations.associationId, sourceAssociations.id),
      )
      .where(
        and(
          eq(currentSourceAssociations.subjectId, input.subjectId),
          eq(
            currentSourceAssociations.associationId,
            input.sourceAssociationId,
          ),
        ),
      )
      .get();
    if (association === undefined) return false;
    const currentSourceRecordIds = new Set(
      query
        .select({ sourceRecordId: sourceLineageHeads.sourceRecordId })
        .from(sourceLineageHeads)
        .where(
          and(
            eq(sourceLineageHeads.subjectId, input.subjectId),
            eq(sourceLineageHeads.sourceIdentity, association.sourceIdentity),
            eq(sourceLineageHeads.nativeAddress, association.nativeAddress),
          ),
        )
        .all()
        .map((row) => row.sourceRecordId),
    );
    return input.sourceRecordIds.some((id) => currentSourceRecordIds.has(id));
  }

  /** 等价完整来源响应沿真实托管获取证据承接图片支持，不改图片身份或人工决定。 */
  private extendEquivalentManagedSourceArtifactSupportWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly subjectId: string;
      readonly sourceAssociationId: string;
      readonly record: SourceRecord;
      readonly interpretation: SourceInterpretationBatch;
    },
  ): void {
    if (
      input.record.coverage.completeness !== "complete" ||
      input.record.producer === undefined
    )
      return;
    const candidates = input.interpretation.sourceArtifacts.filter(
      (candidate) =>
        candidate.sourceRecordId === input.record.id &&
        (candidate.subjectId ?? input.subjectId) === input.subjectId &&
        candidate.producer !== undefined &&
        candidate.mediaType.startsWith("image/"),
    );
    if (candidates.length === 0) return;
    const associations = transaction
      .select({
        id: artifactAssociations.id,
        role: artifactAssociations.role,
        sourceRecordIdsJson: artifactAssociations.sourceRecordIdsJson,
        producerJson: artifactAssociations.producerJson,
        digest: artifactRevisions.blobDigest,
        revisionProducerJson: artifactRevisions.producerJson,
        mediaType: blobs.mediaType,
        byteLength: blobs.byteLength,
        address: locations.address,
      })
      .from(artifactAssociations)
      .innerJoin(
        artifactRevisions,
        eq(artifactRevisions.artifactId, artifactAssociations.artifactId),
      )
      .innerJoin(blobs, eq(blobs.digest, artifactRevisions.blobDigest))
      .innerJoin(
        locations,
        and(
          eq(locations.artifactId, artifactAssociations.artifactId),
          eq(locations.kind, "managed"),
        ),
      )
      .where(
        and(
          eq(artifactAssociations.subjectId, input.subjectId),
          eq(artifactAssociations.targetKind, "entity"),
          eq(artifactAssociations.targetEntityId, input.subjectId),
          eq(
            artifactAssociations.sourceAssociationId,
            input.sourceAssociationId,
          ),
          sql`EXISTS (SELECT 1 FROM current_source_associations AS current WHERE current.subject_id = ${input.subjectId} AND current.association_id = ${input.sourceAssociationId})
          AND NOT EXISTS (SELECT 1 FROM artifact_association_supersessions AS ended WHERE ended.predecessor_association_id = ${artifactAssociations.id})
          AND NOT EXISTS (SELECT 1 FROM artifact_association_retractions AS ended WHERE ended.association_id = ${artifactAssociations.id})`,
        ),
      )
      .all();
    const { id: _nextId, acquiredAt: _nextTime, ...nextSupport } = input.record;
    for (const association of associations) {
      if (
        association.producerJson === null ||
        association.revisionProducerJson === null
      )
        continue;
      const previousIds = JSON.parse(
        association.sourceRecordIdsJson,
      ) as string[];
      if (previousIds.includes(input.record.id)) continue;
      let equivalent = false;
      for (const previousId of previousIds) {
        const previous = this.sourceRecordWithDrizzle(transaction, previousId);
        const {
          id: _previousId,
          acquiredAt: _previousTime,
          ...previousSupport
        } = previous;
        if (
          previous.coverage.completeness !== "complete" ||
          previous.producer === undefined ||
          canonicalJson(previousSupport) !== canonicalJson(nextSupport)
        )
          continue;
        // 获取可以由来源采集执行以外的正式履行子执行提交；只读这些精确 Record 的真实检查点。
        const rows = transaction
          .select({ id: workflowExecutions.id })
          .from(workflowExecutions)
          .where(sql`EXISTS (SELECT 1 FROM json_tree(COALESCE(${workflowExecutions.managedCoverJson}, '[]')) WHERE key = 'sourceRecordId' AND value = ${previousId})
            OR EXISTS (SELECT 1 FROM json_tree(${workflowExecutions.workItemsJson}) WHERE key = 'sourceRecordId' AND value = ${previousId})
            OR EXISTS (SELECT 1 FROM json_tree(${workflowExecutions.sourceEnrichmentsJson}) WHERE key = 'sourceRecordId' AND value = ${previousId})`)
          .all();
        for (const row of rows) {
          const execution =
            this.workflowExecutionPersistence.readExecutionWithDrizzle(
              transaction,
              row.id,
            );
          if (execution?.status !== "completed") continue;
          const managed = [
            ...(execution.managedSourceArtifacts ?? []),
            ...(execution.workItems ?? []).flatMap(
              (item) => item.managedSourceArtifacts ?? [],
            ),
            ...(execution.sourceEnrichments ?? []).flatMap((item) =>
              "managedSourceArtifacts" in item
                ? (item.managedSourceArtifacts ?? [])
                : [],
            ),
          ];
          equivalent = managed.some(
            (stored) =>
              stored.sourceRecordId === previousId &&
              stored.subjectId === input.subjectId &&
              stored.role === association.role &&
              stored.acquisitionReference !== undefined &&
              stored.sourceArtifactProducer !== undefined &&
              stored.acquisitionProducer !== undefined &&
              stored.blob.digest === association.digest &&
              stored.blob.mediaType === association.mediaType &&
              stored.blob.byteLength === association.byteLength &&
              stored.location.address === association.address &&
              canonicalJson(stored.acquisitionProducer) ===
                canonicalJson(JSON.parse(association.revisionProducerJson!)) &&
              canonicalJson(stored.sourceArtifactProducer) ===
                canonicalJson(JSON.parse(association.producerJson!)) &&
              candidates.some(
                (candidate) =>
                  candidate.role === stored.role &&
                  candidate.acquisitionReference ===
                    stored.acquisitionReference &&
                  candidate.mediaType === stored.blob.mediaType &&
                  canonicalJson(candidate.producer) ===
                    canonicalJson(stored.sourceArtifactProducer),
              ),
          );
          if (equivalent) break;
        }
        if (equivalent) break;
      }
      if (equivalent)
        transaction
          .update(artifactAssociations)
          .set({
            sourceRecordIdsJson: JSON.stringify(
              [...new Set([...previousIds, input.record.id])].toSorted(),
            ),
          })
          .where(eq(artifactAssociations.id, association.id))
          .run();
    }
  }

  private persistCurrentSourceArtifactCandidateLineageWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly subjectId: string;
      readonly sourceAssociation: {
        readonly id: string;
        readonly sourceIdentity: string;
        readonly nativeAddress: string;
      };
      readonly record: SourceRecord;
      readonly interpretation: SourceInterpretationBatch;
    },
  ): void {
    if (
      input.interpretation.sourceIdentity !==
        input.sourceAssociation.sourceIdentity ||
      input.interpretation.sourceAddress !==
        input.sourceAssociation.nativeAddress ||
      input.record.sourceIdentity !== input.sourceAssociation.sourceIdentity ||
      input.record.nativeAddress !== input.sourceAssociation.nativeAddress ||
      !input.interpretation.sourceRecordIds.includes(input.record.id)
    ) {
      throw new Error(
        "Current source-artifact candidate lineage contradicts its Source Association",
      );
    }
    const current = transaction
      .select({ sourceRecordId: sourceLineageHeads.sourceRecordId })
      .from(sourceLineageHeads)
      .where(
        and(
          eq(sourceLineageHeads.subjectId, input.subjectId),
          eq(sourceLineageHeads.sourceIdentity, input.record.sourceIdentity),
          eq(sourceLineageHeads.nativeAddress, input.record.nativeAddress),
          eq(sourceLineageHeads.coverageId, input.record.coverage.id),
        ),
      )
      .get();
    if (current?.sourceRecordId !== input.record.id) {
      throw new Error(
        "Current source-artifact candidate lineage has a stale Source Record head",
      );
    }
    transaction
      .insert(currentSourceArtifactCandidateLineages)
      .values({
        subjectId: input.subjectId,
        sourceAssociationId: input.sourceAssociation.id,
        sourceIdentity: input.sourceAssociation.sourceIdentity,
        nativeAddress: input.sourceAssociation.nativeAddress,
        coverageId: input.record.coverage.id,
        sourceRecordId: input.record.id,
        interpretationJson: JSON.stringify(input.interpretation),
      })
      .onConflictDoUpdate({
        target: [
          currentSourceArtifactCandidateLineages.subjectId,
          currentSourceArtifactCandidateLineages.sourceAssociationId,
          currentSourceArtifactCandidateLineages.sourceIdentity,
          currentSourceArtifactCandidateLineages.nativeAddress,
          currentSourceArtifactCandidateLineages.coverageId,
        ],
        set: {
          sourceRecordId: input.record.id,
          interpretationJson: JSON.stringify(input.interpretation),
        },
      })
      .run();
  }

  /**
   * 对初始已接受解释和已应用的来源刷新，都从同一条持久谱系读取当前来源产物候选项。
   * 识别提案刻意只保留为审计历史，绝不充当候选项缓存。
   */
  async readCurrentSourceArtifactFacts(input: {
    readonly subjectId: string;
    readonly sourceIdentity: string;
    readonly sourceAssociationId?: string;
  }) {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const identity = query
      .select({
        associationId: sourceAssociations.id,
        subjectId: sourceAssociations.subjectId,
        sourceIdentity: sourceAssociations.sourceIdentity,
        nativeAddress: sourceAssociations.nativeAddress,
        recognitionDecisionId: recognitionHeads.recognitionDecisionId,
      })
      .from(recognitionHeads)
      .innerJoin(
        currentSourceAssociations,
        eq(currentSourceAssociations.subjectId, recognitionHeads.subjectId),
      )
      .innerJoin(
        sourceAssociations,
        eq(sourceAssociations.id, currentSourceAssociations.associationId),
      )
      .where(
        and(
          eq(recognitionHeads.subjectId, input.subjectId),
          eq(sourceAssociations.sourceIdentity, input.sourceIdentity),
          ...(input.sourceAssociationId === undefined
            ? []
            : [eq(sourceAssociations.id, input.sourceAssociationId)]),
        ),
      )
      .orderBy(asc(sql<number>`${sourceAssociations}.rowid`))
      .get();
    if (identity === undefined) return undefined;
    if (identity.recognitionDecisionId === null) return undefined;

    const rows = query
      .select({
        coverageId: currentSourceArtifactCandidateLineages.coverageId,
        sourceRecordId: currentSourceArtifactCandidateLineages.sourceRecordId,
        interpretationJson:
          currentSourceArtifactCandidateLineages.interpretationJson,
      })
      .from(currentSourceArtifactCandidateLineages)
      .innerJoin(
        sourceLineageHeads,
        and(
          eq(
            sourceLineageHeads.subjectId,
            currentSourceArtifactCandidateLineages.subjectId,
          ),
          eq(
            sourceLineageHeads.sourceIdentity,
            currentSourceArtifactCandidateLineages.sourceIdentity,
          ),
          eq(
            sourceLineageHeads.nativeAddress,
            currentSourceArtifactCandidateLineages.nativeAddress,
          ),
          eq(
            sourceLineageHeads.coverageId,
            currentSourceArtifactCandidateLineages.coverageId,
          ),
          eq(
            sourceLineageHeads.sourceRecordId,
            currentSourceArtifactCandidateLineages.sourceRecordId,
          ),
        ),
      )
      .where(
        and(
          eq(currentSourceArtifactCandidateLineages.subjectId, input.subjectId),
          eq(
            currentSourceArtifactCandidateLineages.sourceAssociationId,
            identity.associationId,
          ),
          eq(
            currentSourceArtifactCandidateLineages.sourceIdentity,
            identity.sourceIdentity,
          ),
          eq(
            currentSourceArtifactCandidateLineages.nativeAddress,
            identity.nativeAddress,
          ),
        ),
      )
      .orderBy(
        asc(currentSourceArtifactCandidateLineages.coverageId),
        asc(sql<number>`${currentSourceArtifactCandidateLineages}.rowid`),
      )
      .all();
    const candidates = rows.flatMap((row) => {
      let interpretation: SourceInterpretationBatch;
      try {
        interpretation = JSON.parse(
          row.interpretationJson,
        ) as SourceInterpretationBatch;
        validateSourceInterpretationBatch(interpretation);
      } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error("Malformed current Source Refresh interpretation", {
          cause: error,
        });
      }
      if (
        interpretation.sourceIdentity !== identity.sourceIdentity ||
        interpretation.sourceAddress !== identity.nativeAddress
      ) {
        throw new Error(
          "Current source-artifact interpretation contradicts its Source Association",
        );
      }
      if (!interpretation.sourceRecordIds.includes(row.sourceRecordId)) {
        throw new Error(
          "Current source-artifact lineage contradicts its Source Interpretation",
        );
      }
      const sourceRecords = interpretation.sourceRecordIds.map(
        (sourceRecordId) => this.sourceRecordWithDrizzle(query, sourceRecordId),
      );
      const lineageRecord = sourceRecords.find(
        (record) => record.id === row.sourceRecordId,
      );
      if (
        lineageRecord === undefined ||
        lineageRecord.sourceIdentity !== identity.sourceIdentity ||
        lineageRecord.nativeAddress !== identity.nativeAddress ||
        lineageRecord.coverage.id !== row.coverageId
      ) {
        throw new Error(
          "Current source-artifact lineage has invalid Source Record provenance",
        );
      }
      return interpretation.sourceArtifacts
        .filter((candidate) => candidate.sourceRecordId === row.sourceRecordId)
        .map((candidate) => ({
          candidate,
          interpretationSourceRecordIds: interpretation.sourceRecordIds,
          sourceRecords,
        }));
    });
    return {
      subjectId: input.subjectId,
      sourceAssociation: {
        id: identity.associationId,
        subjectId: identity.subjectId,
        sourceIdentity: identity.sourceIdentity,
        nativeAddress: identity.nativeAddress,
      },
      recognitionIdentity: {
        recognitionDecisionId: identity.recognitionDecisionId,
        sourceAssociationId: identity.associationId,
      },
      candidates,
    };
  }

  /**
   * 将托管字节提交为普通产物事实，同时有条件地保留精确的当前识别和来源关联身份。
   * 它刻意不接受识别提案或识别决定输入。
   */
  async submitManagedSourceArtifacts(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly expectedIdentity: {
      readonly subjectId: string;
      readonly recognitionDecisionId: string;
      readonly sourceAssociationId: string;
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
  }): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              input.execution,
            );
          this.assertResumeMutationClaim(
            transaction,
            input.execution.id,
            input.resumeClaim,
          );
          this.assertDirectoryAuthorizationsCurrent(
            transaction,
            input.execution,
          );
          this.assertManagedSourceArtifactCommitInputs(transaction, input);
          this.insertOrVerifyArtifactFactsWithDrizzle(
            transaction,
            {
              artifacts: input.managedArtifacts.artifacts,
              locations: input.managedArtifacts.locations,
              blobs: input.managedArtifacts.blobs,
              artifactRevisions: input.managedArtifacts.revisions,
              artifactAssociations: input.managedArtifacts.associations,
            },
            input.expectedIdentity.subjectId,
          );
          const submittedAssociations =
            this.attachManagedSourceArtifactAssociationProvenanceWithDrizzle(
              transaction,
              {
                subjectId: input.expectedIdentity.subjectId,
                sourceAssociationId: input.expectedIdentity.sourceAssociationId,
                sourceRecordIds: input.sourceRecordIds,
                associationIds: input.managedArtifacts.associations.map(
                  (artifactAssociation) => artifactAssociation.id,
                ),
              },
            );
          this.supersedeCurrentManagedSourceArtifactsWithDrizzle(transaction, {
            subjectId: input.expectedIdentity.subjectId,
            sourceAssociationId: input.expectedIdentity.sourceAssociationId,
            sourceRecordIds: input.sourceRecordIds,
            proposalId: input.expectedIdentity.sourceAssociationId,
            transitionId: input.execution.id,
            submittedAssociations,
          });
          this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
            input.expectedIdentity.subjectId,
          ]);
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            input.execution,
            {
              auditJson: baseline.auditJson,
            },
          );
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  /**
   * 在执行任何产物 DML 之前验证保留的当前来源坐标。来源记录可以由已接受来源执行拥有，
   * 而非由后续的履约执行拥有，但它必须仍是所选关联不可变坐标的精确当前头部。
   */
  private assertManagedSourceArtifactCommitInputs(
    query: DrizzleReadQuery,
    input: Parameters<SqliteCatalogue["submitManagedSourceArtifacts"]>[0],
  ): {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  } {
    if (input.execution.id !== input.expectedExecution.id) {
      throw new Error(
        "Managed source-artifact commit cannot replace another Workflow Execution",
      );
    }
    const current = this.workflowExecutionPersistence.readExecutionWithDrizzle(
      query,
      input.expectedExecution.id,
    );
    if (
      current?.status !== input.expectedExecution.status ||
      current.stage !== input.expectedExecution.stage ||
      current.status !== "running"
    ) {
      throw new Error(
        `Execution ${input.expectedExecution.id} rejected a stale managed source-artifact commit`,
      );
    }
    const identity = query
      .select({
        recognitionDecisionId: recognitionHeads.recognitionDecisionId,
        associationId: currentSourceAssociations.associationId,
      })
      .from(recognitionHeads)
      .innerJoin(
        currentSourceAssociations,
        eq(currentSourceAssociations.subjectId, recognitionHeads.subjectId),
      )
      .where(
        and(
          eq(recognitionHeads.subjectId, input.expectedIdentity.subjectId),
          eq(
            currentSourceAssociations.associationId,
            input.expectedIdentity.sourceAssociationId,
          ),
        ),
      )
      .get();
    if (
      identity?.recognitionDecisionId === null ||
      identity?.recognitionDecisionId !==
        input.expectedIdentity.recognitionDecisionId ||
      identity.associationId !== input.expectedIdentity.sourceAssociationId
    ) {
      throw new Error(
        "Managed source-artifact commit has a stale recognition identity",
      );
    }
    const association = query
      .select({
        sourceIdentity: sourceAssociations.sourceIdentity,
        nativeAddress: sourceAssociations.nativeAddress,
      })
      .from(sourceAssociations)
      .where(
        and(
          eq(sourceAssociations.id, input.expectedIdentity.sourceAssociationId),
          eq(sourceAssociations.subjectId, input.expectedIdentity.subjectId),
        ),
      )
      .get();
    if (association === undefined) {
      throw new Error(
        "Managed source-artifact commit lost its Source Association",
      );
    }
    const sourceRecords = input.sourceRecordIds.map((sourceRecordId) =>
      this.sourceRecordWithDrizzle(query, sourceRecordId),
    );
    if (
      sourceRecords.length === 0 ||
      sourceRecords.some(
        (record) =>
          record.sourceIdentity !== association.sourceIdentity ||
          record.nativeAddress !== association.nativeAddress,
      )
    ) {
      throw new Error(
        "Managed source-artifact commit lacks current Source Record provenance",
      );
    }
    if (
      sourceRecords.some(
        (record) =>
          query
            .select({ sourceRecordId: sourceLineageHeads.sourceRecordId })
            .from(sourceLineageHeads)
            .where(
              and(
                eq(
                  sourceLineageHeads.subjectId,
                  input.expectedIdentity.subjectId,
                ),
                eq(sourceLineageHeads.sourceIdentity, record.sourceIdentity),
                eq(sourceLineageHeads.nativeAddress, record.nativeAddress),
                eq(sourceLineageHeads.coverageId, record.coverage.id),
              ),
            )
            .get()?.sourceRecordId !== record.id,
      )
    ) {
      throw new Error(
        "Managed source-artifact commit lacks a current Source Record head",
      );
    }
    const knownSourceRecords = new Set(input.sourceRecordIds);
    if (
      input.managedArtifacts.associations.some(
        (artifactAssociation) =>
          entityTargetId(artifactAssociation) !==
            input.expectedIdentity.subjectId ||
          artifactAssociation.sourceRecordIds === undefined ||
          artifactAssociation.sourceRecordIds.length === 0 ||
          !artifactAssociation.sourceRecordIds.every((sourceRecordId) =>
            knownSourceRecords.has(sourceRecordId),
          ),
      )
    ) {
      throw new Error(
        "Managed source-artifact association lacks current source provenance",
      );
    }
    return association;
  }

  /** 由 Drizzle 拥有的托管来源产物溯源变更半部。 */
  private attachManagedSourceArtifactAssociationProvenanceWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly subjectId: string;
      readonly sourceAssociationId: string;
      readonly sourceRecordIds: readonly string[];
      readonly associationIds: readonly string[];
    },
  ): readonly { readonly id: string; readonly role: string }[] {
    if (input.associationIds.length === 0) return [];
    const associationIds = [...new Set(input.associationIds)];
    if (associationIds.length !== input.associationIds.length) {
      throw new Error(
        "Managed source-artifact commit repeats an Artifact Association",
      );
    }
    const rows = transaction
      .select()
      .from(artifactAssociations)
      .where(inArray(artifactAssociations.id, associationIds))
      .all();
    if (rows.length !== associationIds.length) {
      throw new Error(
        "Managed source-artifact commit lost an Artifact Association",
      );
    }
    const knownSourceRecords = new Set(input.sourceRecordIds);
    for (const row of rows) {
      const sourceRecordIds = JSON.parse(row.sourceRecordIdsJson) as string[];
      if (
        row.subjectId !== input.subjectId ||
        sourceRecordIds.length === 0 ||
        !sourceRecordIds.every((sourceRecordId) =>
          knownSourceRecords.has(sourceRecordId),
        )
      ) {
        throw new Error(
          "Managed source-artifact association lacks current source provenance",
        );
      }
      if (
        row.sourceAssociationId !== null &&
        row.sourceAssociationId !== input.sourceAssociationId
      ) {
        throw new Error(
          "Managed source-artifact association conflicts with Source Association provenance",
        );
      }
      transaction
        .update(artifactAssociations)
        .set({ sourceAssociationId: input.sourceAssociationId })
        .where(eq(artifactAssociations.id, row.id))
        .run();
    }
    return rows.map(({ id, role }) => ({ id, role }));
  }

  private attachAcceptedSourceArtifactAssociationProvenanceWithDrizzle(
    transaction: DrizzleWriteTransaction,
    accepted: AcceptedRecognition,
  ): void {
    const sourceAssociation = accepted.recognitionSourceAssociation;
    const interpretation = recognitionSourceInterpretation(accepted.proposal);
    if (sourceAssociation === undefined || interpretation === undefined) return;
    const sourceRecordIds = interpretation.sourceRecordIds.filter(
      (sourceRecordId) => {
        const record = this.sourceRecordWithDrizzle(
          transaction,
          sourceRecordId,
        );
        return (
          record.sourceIdentity === sourceAssociation.sourceIdentity &&
          record.nativeAddress === sourceAssociation.nativeAddress
        );
      },
    );
    if (sourceRecordIds.length === 0) return;
    const knownSourceRecords = new Set(sourceRecordIds);
    const associationIds = accepted.artifactAssociations
      .filter(
        (association) =>
          entityTargetId(association) === sourceAssociation.subjectId &&
          association.sourceRecordIds !== undefined &&
          association.sourceRecordIds.length > 0 &&
          association.sourceRecordIds.every((sourceRecordId) =>
            knownSourceRecords.has(sourceRecordId),
          ),
      )
      .map((association) => association.id);
    if (associationIds.length === 0) return;
    const uniqueAssociationIds = [...new Set(associationIds)];
    if (uniqueAssociationIds.length !== associationIds.length)
      throw new Error(
        "Managed source-artifact commit repeats an Artifact Association",
      );
    const rows = transaction
      .select()
      .from(artifactAssociations)
      .where(inArray(artifactAssociations.id, uniqueAssociationIds))
      .all();
    if (rows.length !== uniqueAssociationIds.length)
      throw new Error(
        "Managed source-artifact commit lost an Artifact Association",
      );
    for (const row of rows) {
      const rowSourceRecordIds = JSON.parse(
        row.sourceRecordIdsJson,
      ) as string[];
      if (
        row.subjectId !== sourceAssociation.subjectId ||
        rowSourceRecordIds.length === 0 ||
        !rowSourceRecordIds.every((sourceRecordId) =>
          knownSourceRecords.has(sourceRecordId),
        )
      ) {
        throw new Error(
          "Managed source-artifact association lacks current source provenance",
        );
      }
      if (
        row.sourceAssociationId !== null &&
        row.sourceAssociationId !== sourceAssociation.id
      ) {
        throw new Error(
          "Managed source-artifact association conflicts with Source Association provenance",
        );
      }
      transaction
        .update(artifactAssociations)
        .set({ sourceAssociationId: sourceAssociation.id })
        .where(eq(artifactAssociations.id, row.id))
        .run();
    }
  }

  /** 由 Drizzle 拥有的来源所有产物取代变更半部。 */
  private supersedeCurrentManagedSourceArtifactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly subjectId: string;
      readonly sourceAssociationId: string;
      readonly sourceRecordIds: readonly string[];
      readonly proposalId: string;
      readonly transitionId: string;
      readonly submittedAssociations: readonly {
        readonly id: string;
        readonly role: string;
      }[];
    },
  ): void {
    if (input.submittedAssociations.length === 0) return;
    const submittedByRole = new Map<
      string,
      { readonly id: string; readonly role: string }[]
    >();
    for (const association of input.submittedAssociations) {
      const sameRole = submittedByRole.get(association.role) ?? [];
      sameRole.push(association);
      submittedByRole.set(association.role, sameRole);
    }
    for (const [role, successors] of submittedByRole) {
      if (role === "asset.primary-cover" && successors.length !== 1) {
        throw new Error(
          "Managed source-artifact commit requires one primary-cover successor",
        );
      }
      const superseded = new Set(
        transaction
          .select({
            predecessorId:
              artifactAssociationSupersessions.predecessorAssociationId,
          })
          .from(artifactAssociationSupersessions)
          .all()
          .map((row) => row.predecessorId),
      );
      const retracted = new Set(
        transaction
          .select({
            associationId: artifactAssociationRetractions.associationId,
          })
          .from(artifactAssociationRetractions)
          .all()
          .map((row) => row.associationId),
      );
      const submittedIds = new Set(
        input.submittedAssociations.map((association) => association.id),
      );
      const predecessors = transaction
        .select({ id: artifactAssociations.id })
        .from(artifactAssociations)
        .where(
          and(
            eq(artifactAssociations.subjectId, input.subjectId),
            eq(
              artifactAssociations.sourceAssociationId,
              input.sourceAssociationId,
            ),
            eq(artifactAssociations.role, role),
          ),
        )
        .orderBy(asc(sql<number>`${artifactAssociations}.rowid`))
        .all()
        .filter(
          (association) =>
            !submittedIds.has(association.id) &&
            !superseded.has(association.id) &&
            !retracted.has(association.id),
        );
      const successor = successors[0];
      if (successor === undefined) continue;
      for (const [index, predecessor] of predecessors.entries()) {
        if (index === 0) {
          transaction
            .insert(artifactAssociationSupersessions)
            .values({
              id: `artifact-association-supersession_${input.transitionId}_${predecessor.id}`,
              predecessorAssociationId: predecessor.id,
              successorAssociationId: successor.id,
            })
            .run();
          continue;
        }
        transaction
          .insert(artifactAssociationRetractions)
          .values({
            id: `artifact-association-retraction_${input.transitionId}_${predecessor.id}`,
            associationId: predecessor.id,
            recognitionDecisionId: null,
            proposalId: input.proposalId,
            sourceRecordIdsJson: JSON.stringify(input.sourceRecordIds),
          })
          .run();
      }
    }
  }

  async findReusableWorkItem(input: {
    readonly directory: string;
    readonly relativePaths: readonly string[];
    readonly availableCompatibility: WorkflowExecution["compatibility"];
    readonly reuseFingerprint: string;
  }): Promise<
    | {
        readonly execution: WorkflowExecution;
        readonly accepted: AcceptedRecognition;
        readonly reuseCompatibility: WorkflowExecution["compatibility"];
      }
    | undefined
  > {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    // 无变更项目是派生结果，绝不是其自身原始能力闭包的来源。只选择确实执行或重新评估过
    // 已接受工作的执行；这也避免旧版降级无变更审计行遮蔽实现升级。
    const rows = query
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.selectionDirectory, input.directory),
          inArray(workflowExecutions.outcome, [
            "accepted",
            "partially-succeeded",
          ]),
        ),
      )
      .orderBy(desc(sql<number>`${workflowExecutions}.rowid`))
      .all();
    const expectedPaths = [...input.relativePaths].toSorted();
    for (const row of rows) {
      const execution =
        this.workflowExecutionPersistence.readExecutionWithDrizzle(
          query,
          row.id,
        );
      if (execution === undefined) continue;
      const item = execution.workItems?.find(
        (current) =>
          current.acceptedAssetId !== undefined &&
          current.proposalId !== undefined &&
          current.reuseFingerprint === input.reuseFingerprint &&
          JSON.stringify([...current.relativePaths].toSorted()) ===
            JSON.stringify(expectedPaths),
      );
      if (
        item?.acceptedAssetId === undefined ||
        item.proposalId === undefined ||
        item.reuseCompatibility === undefined ||
        !workflowCompatibilityCanReuse(
          item.reuseCompatibility,
          input.availableCompatibility,
        )
      )
        continue;
      const proposal = this.readProposalWithDrizzle(query, item.proposalId);
      if (proposal === undefined) continue;
      const accepted = await this.readCurrentAcceptedWithDrizzle(
        query,
        item.acceptedAssetId,
      );
      if (accepted !== undefined) {
        return {
          execution,
          accepted,
          reuseCompatibility: item.reuseCompatibility,
        };
      }
    }
    return undefined;
  }

  async findAcceptedForWorkItem(input: {
    readonly directory: string;
    readonly relativePaths: readonly string[];
  }): Promise<
    | {
        readonly execution: WorkflowExecution;
        readonly accepted: AcceptedRecognition;
      }
    | undefined
  > {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    // 同一个已接受范围可从其父目录或自身发起检查。这里归一化范围表达，
    // 不是据位置证明文件身份；Application 仍须比较该范围原有的识别决定。
    const boundary = (directory: string, references: readonly string[]) =>
      JSON.stringify(
        references
          .map((reference) => path.resolve(directory, reference))
          .toSorted((left, right) => left.localeCompare(right)),
      );
    const expectedPaths = boundary(input.directory, input.relativePaths);
    const rows = query
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(
        and(
          inArray(workflowExecutions.outcome, [
            "accepted",
            "partially-succeeded",
            "no-change",
          ]),
        ),
      )
      .orderBy(desc(sql<number>`${workflowExecutions}.rowid`))
      .all();
    for (const row of rows) {
      const execution =
        this.workflowExecutionPersistence.readExecutionWithDrizzle(
          query,
          row.id,
        );
      if (execution === undefined) continue;
      const item = execution.workItems?.find(
        (current) =>
          current.acceptedAssetId !== undefined &&
          current.proposalId !== undefined &&
          execution.selection.directory !== undefined &&
          boundary(execution.selection.directory, current.relativePaths) ===
            expectedPaths,
      );
      const manualProposal =
        execution.proposalId === undefined
          ? undefined
          : this.readProposalWithDrizzle(query, execution.proposalId);
      const manualReferences =
        manualProposal?.basis.kind === "manual-boundary"
          ? manualProposal.basis.materialReferences
          : undefined;
      const legacyMatchesBoundary =
        (execution.workItems === undefined ||
          execution.workItems.length === 0) &&
        execution.snapshot !== undefined &&
        (execution.snapshot.complete || manualReferences !== undefined) &&
        execution.selection.directory !== undefined &&
        boundary(
          execution.selection.directory,
          manualReferences ??
            execution.snapshot.files.map((file) => file.relativePath),
        ) === expectedPaths;
      const acceptedAssetId =
        item?.acceptedAssetId ??
        (legacyMatchesBoundary ? execution.acceptedAssetId : undefined);
      const proposalId =
        item?.proposalId ??
        (legacyMatchesBoundary ? execution.proposalId : undefined);
      if (
        acceptedAssetId === undefined ||
        (!legacyMatchesBoundary && proposalId === undefined)
      )
        continue;
      const proposal =
        proposalId === undefined
          ? undefined
          : this.readProposalWithDrizzle(query, proposalId);
      if (proposalId !== undefined && proposal === undefined) continue;
      const accepted = await this.readCurrentAcceptedWithDrizzle(
        query,
        acceptedAssetId,
      );
      if (accepted !== undefined) return { execution, accepted };
    }
    return undefined;
  }

  /**
   * 沿既有 supersession 前驱链，读取建立当前来源身份的不可变决定，供身份保持刷新在事务
   * 前校验。范围修订把主头推进为 manual successor 后，`current` 携带的是新范围头而非来源
   * 身份起点；这里只把两者分开读取，绝不改变范围头／accepted-boundary 引用／CAS 判定。
   * 找不到可精确匹配现有来源关联的前驱身份依据时诚实拒绝，不据 manual／observed 提案伪造来源。
   */
  private async identityBaselineForRefresh(
    query: DrizzleReadQuery,
    current: AcceptedRecognition,
  ): Promise<AcceptedRecognition> {
    if (
      recognitionSourceInterpretation(current.proposal) !== undefined ||
      current.recognitionSourceAssociation === undefined
    )
      return current;
    const sourceAssociation = current.recognitionSourceAssociation;
    let decisionId: string | undefined = current.recognitionDecision.id;
    const visited = new Set<string>();
    while (decisionId !== undefined && !visited.has(decisionId)) {
      visited.add(decisionId);
      const predecessor = query
        .select({
          decisionId: recognitionDecisionSupersessions.predecessorDecisionId,
        })
        .from(recognitionDecisionSupersessions)
        .where(
          eq(recognitionDecisionSupersessions.successorDecisionId, decisionId),
        )
        .get();
      if (predecessor === undefined) break;
      decisionId = predecessor.decisionId;
      const baseline = await this.readCurrentAcceptedWithDrizzle(
        query,
        current.entity.id,
        decisionId,
        true,
      );
      if (baseline === undefined) continue;
      const interpretation = recognitionSourceInterpretation(baseline.proposal);
      if (interpretation === undefined) continue;
      if (
        interpretation.sourceIdentity !== sourceAssociation.sourceIdentity ||
        interpretation.sourceAddress !== sourceAssociation.nativeAddress ||
        canonicalJson(baseline.recognitionSourceAssociation ?? null) !==
          canonicalJson(sourceAssociation)
      )
        throw new Error(
          "Identity-preserving refresh found a supersession baseline that contradicts the retained Source Association",
        );
      return baseline;
    }
    throw new Error(
      "Identity-preserving refresh cannot resolve the durable Source Association baseline",
    );
  }

  async refreshAcceptedRecognition(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly current: AcceptedRecognition;
    readonly accepted: AcceptedRecognition;
    readonly observedMaterialAcceptances?:
      | readonly ObservedMaterialAcceptanceBinding[]
      | undefined;
    readonly sourceRecords: readonly SourceRecord[];
    readonly expectedLineageHeads: MetadataRefreshSubmission["expectedLineageHeads"];
    /**
     * 冻结时与本次刷新范围相交的全部有效边界基线，连同冻结它时使用的相交范围地址；
     * 提交前在事务内按同一规则重算比较，不一致则本次刷新不产生任何写入。
     */
    readonly expectedBoundary?:
      | { readonly keys: readonly string[]; readonly scopeAddress: string }
      | undefined;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    // 刷新会追加来自新提案的事实，但保留建立当前身份的不可变关联和决定。
    // 范围修订后 manual 范围头与耐久来源身份基线分离：身份校验作用于真实基线，
    // 事务内的范围／accepted-boundary 引用与 CAS 仍作用于当前范围头。
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const identityBaseline = await this.identityBaselineForRefresh(
      query,
      input.current,
    );
    validateReevaluatedRecognition({
      current: input.current,
      identityBaseline,
      accepted: input.accepted,
    });
    try {
      query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              input.execution,
            );
          this.assertResumeMutationClaim(
            transaction,
            input.execution.id,
            input.resumeClaim,
          );
          const identity = transaction
            .select({
              associationId: recognitionHeads.recognitionSourceAssociationId,
              recognitionDecisionId: recognitionHeads.recognitionDecisionId,
            })
            .from(recognitionHeads)
            .where(eq(recognitionHeads.subjectId, input.current.entity.id))
            .get();
          if (identity === undefined) {
            throw new Error(
              "Recognition reevaluation lost its immutable identity baseline",
            );
          }
          if (
            (identity.associationId ?? undefined) !==
            input.current.recognitionSourceAssociation?.id
          )
            throw new Error(
              "Recognition reevaluation lost its Source Association baseline",
            );
          if (
            identity.recognitionDecisionId !==
            input.current.recognitionDecision.id
          )
            throw new Error(
              "Recognition reevaluation lost its Recognition Decision baseline",
            );
          if (input.expectedBoundary !== undefined) {
            const frozen = input.expectedBoundary;
            // 只比较与本次刷新相交的那一份有效边界集合：其他根上的决定不参与这次
            // 刷新，既不能把成功刷新的合法资产判成过期，也仍然检测相交集合内的
            // 新增、取代与撤回。
            const currentBaseline = recognitionBoundaryBaseline(
              this.effectiveMaterialBoundariesWithDrizzle(
                transaction,
                input.current.entity.id,
              ).filter((item) =>
                recognitionMaterialBoundaryIntersectsScope(
                  item,
                  frozen.scopeAddress,
                ),
              ),
            );
            if (
              JSON.stringify(currentBaseline) !==
              JSON.stringify([...frozen.keys].toSorted())
            )
              throw new RecognitionBoundaryBaselineStale();
          }
          const interpretation = recognitionSourceInterpretation(
            input.accepted.proposal,
          );
          let sourceRefresh:
            | {
                readonly input: MetadataRefreshInput;
                readonly preflight: MetadataRefreshPreflight;
              }
            | undefined;
          if (interpretation === undefined) {
            if (
              input.sourceRecords.length > 0 ||
              input.expectedLineageHeads.length > 0
            )
              throw new Error(
                "Observed recognition reevaluation cannot carry source lineage",
              );
          } else {
            const sourceAssociation =
              input.accepted.recognitionSourceAssociation;
            if (sourceAssociation === undefined)
              throw new Error(
                "Source recognition reevaluation requires its Source Association",
              );
            const metadataRefreshInput: MetadataRefreshInput = {
              expectedExecution: input.expectedExecution,
              execution: input.execution,
              submission: {
                assetId: input.current.entity.id,
                sourceAssociation,
                sourceRecords: input.sourceRecords,
                interpretation,
                expectedLineageHeads: input.expectedLineageHeads,
              },
            };
            sourceRefresh = {
              input: metadataRefreshInput,
              preflight: this.preflightMetadataRefreshInputsWithDrizzle(
                transaction,
                metadataRefreshInput,
              ),
            };
          }
          this.insertProposalWithDrizzle(
            transaction,
            input.execution.id,
            input.accepted.proposal,
          );
          if (sourceRefresh !== undefined)
            this.applyMetadataRefreshInTransactionWithDrizzle(
              transaction,
              sourceRefresh.input,
              sourceRefresh.preflight,
            );
          this.insertReevaluatedArtifactFactsWithDrizzle(
            transaction,
            input.current,
            input.accepted,
          );
          this.recordObservedMaterialAcceptancesWithDrizzle(
            transaction,
            input.execution,
            input.observedMaterialAcceptances ?? [],
          );
          // 证据要读本次刚落库的材料形态边界，因此支持写入排在其之后。
          this.writeLocalAssociationSupportsWithDrizzle(
            transaction,
            input.accepted,
          );
          this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
            input.current.entity.id,
          ]);
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            input.execution,
            {
              auditJson: baseline.auditJson,
            },
          );
          this.projectCurrentFileObservationsWithDrizzle(
            transaction,
            input.execution,
            input.accepted.locations,
          );
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  async applyMetadataRefresh(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly submission: MetadataRefreshSubmission;
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              input.execution,
            );
          this.assertResumeMutationClaim(
            transaction,
            input.execution.id,
            input.resumeClaim,
          );
          this.applyMetadataRefreshInTransactionWithDrizzle(transaction, input);
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            input.execution,
            {
              auditJson: baseline.auditJson,
            },
          );
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  async checkpointSourceEnrichmentRecords(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly sourceRecords: readonly SourceRecord[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              input.execution,
            );
          this.assertResumeMutationClaim(
            transaction,
            input.execution.id,
            input.resumeClaim,
          );
          if (input.execution.id !== input.expectedExecution.id) {
            throw new Error(
              "Source Enrichment checkpoint cannot replace another Workflow Execution",
            );
          }
          this.insertSourceRecordsWithDrizzle(
            transaction,
            input.execution.id,
            input.sourceRecords,
          );
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            input.execution,
            {
              auditJson: baseline.auditJson,
            },
          );
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  async applySourceEnrichment(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly expectedRecognitionBaseline: {
      readonly recognitionSourceAssociationId?: string;
      readonly recognitionDecisionId: string;
    };
    readonly assetId: string;
    readonly sourceAssociation: import("@digital/domain").SourceAssociation;
    readonly proposal: SourceAssociationChangeProposal;
    readonly decision: SourceAssociationDecision;
    readonly sourceRecords: readonly SourceRecord[];
    readonly interpretation: import("@digital/domain").SourceInterpretationBatch;
    readonly managedArtifacts?: {
      readonly artifacts: readonly Artifact[];
      readonly locations: readonly Location[];
      readonly blobs: readonly Blob[];
      readonly revisions: readonly ArtifactRevision[];
      readonly associations: readonly ArtifactAssociation[];
    };
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    if (input.proposal.kind !== "establish")
      throw new Error("Source Enrichment requires an establishment proposal");
    const proposal = input.proposal;
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              input.execution,
            );
          this.assertResumeMutationClaim(
            transaction,
            input.execution.id,
            input.resumeClaim,
          );
          const association = this.assertSourceEnrichmentApplyInputs(
            transaction,
            input,
          );
          const metadataRefreshInput: MetadataRefreshInput = {
            expectedExecution: input.expectedExecution,
            execution: input.execution,
            submission: {
              assetId: input.assetId,
              sourceAssociation: {
                ...input.sourceAssociation,
                id: association.id,
              },
              sourceRecords: input.sourceRecords,
              interpretation: input.interpretation,
              expectedLineageHeads: input.sourceRecords.map((record) => ({
                sourceIdentity: record.sourceIdentity,
                nativeAddress: record.nativeAddress,
                coverageId: record.coverage.id,
              })),
            },
          };
          if (association.shouldInsert) {
            transaction
              .insert(sourceAssociations)
              .values({
                id: association.id,
                subjectId: input.assetId,
                sourceIdentity: input.sourceAssociation.sourceIdentity,
                nativeAddress: input.sourceAssociation.nativeAddress,
              })
              .run();
            this.insertSourceAssociationDecisionWithDrizzle(transaction, {
              proposal: {
                ...proposal,
                successor: {
                  ...proposal.successor,
                  id: association.id,
                },
              },
              decision: input.decision,
            });
            transaction
              .insert(sourceAssociationEstablishmentSupports)
              .values({
                associationId: association.id,
                sourceAssociationDecisionId: input.decision.id,
              })
              .run();
          }
          transaction
            .insert(currentSourceAssociations)
            .values({ subjectId: input.assetId, associationId: association.id })
            .onConflictDoNothing()
            .run();
          this.applyMetadataRefreshInTransactionWithDrizzle(
            transaction,
            metadataRefreshInput,
            association.metadataRefreshPreflight,
          );
          if (input.managedArtifacts !== undefined) {
            this.insertOrVerifyArtifactFactsWithDrizzle(
              transaction,
              {
                artifacts: input.managedArtifacts.artifacts,
                locations: input.managedArtifacts.locations,
                blobs: input.managedArtifacts.blobs,
                artifactRevisions: input.managedArtifacts.revisions,
                artifactAssociations: input.managedArtifacts.associations,
              },
              input.assetId,
            );
            const submittedAssociations =
              this.attachManagedSourceArtifactAssociationProvenanceWithDrizzle(
                transaction,
                {
                  subjectId: input.assetId,
                  sourceAssociationId: association.id,
                  sourceRecordIds: input.interpretation.sourceRecordIds,
                  associationIds: input.managedArtifacts.associations.map(
                    (artifactAssociation) => artifactAssociation.id,
                  ),
                },
              );
            this.supersedeCurrentManagedSourceArtifactsWithDrizzle(
              transaction,
              {
                subjectId: input.assetId,
                sourceAssociationId: association.id,
                sourceRecordIds: input.interpretation.sourceRecordIds,
                proposalId: input.proposal.id,
                transitionId: input.execution.id,
                submittedAssociations,
              },
            );
          }
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            input.execution,
            {
              auditJson: baseline.auditJson,
            },
          );
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  private insertSourceAssociationDecisionWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly proposal: SourceAssociationChangeProposal;
      readonly decision: SourceAssociationDecision;
      readonly predecessor?: SourceAssociation;
    },
  ): void {
    validateSourceAssociationChange(input);
    const { proposal, decision } = input;
    transaction
      .insert(sourceAssociationChangeProposals)
      .values({
        id: proposal.id,
        subjectId: proposal.subjectId,
        kind: proposal.kind,
        payloadJson: JSON.stringify(proposal),
        proposedByJson: JSON.stringify(proposal.proposedBy),
        evidenceJson: JSON.stringify(proposal.evidence),
      })
      .run();
    transaction
      .insert(sourceAssociationDecisions)
      .values({
        id: decision.id,
        proposalId: decision.proposalId,
        subjectId: decision.subjectId,
        decidedByKind: decision.decidedBy.kind,
        decidedByCoordinate:
          decision.decidedBy.kind === "user"
            ? decision.decidedBy.actorId
            : decision.decidedBy.policyCoordinate,
      })
      .run();
  }

  /**
   * 在丰富操作能够创建可选来源关联之前拒绝无效请求。应用层已经要求存在已接受的关联解释；
   * 此持久化边界会在第一条 DML 语句之前，重新检查冻结的识别头、保留证据和精确来源坐标。
   */
  private assertSourceEnrichmentApplyInputs(
    query: DrizzleReadQuery,
    input: Parameters<SqliteCatalogue["applySourceEnrichment"]>[0],
  ): {
    readonly id: string;
    readonly shouldInsert: boolean;
    readonly metadataRefreshPreflight: MetadataRefreshPreflight;
  } {
    if (input.execution.id !== input.expectedExecution.id) {
      throw new Error(
        "Source Enrichment cannot replace another Workflow Execution",
      );
    }
    const recognitionHead = query
      .select({
        associationId: recognitionHeads.recognitionSourceAssociationId,
        recognitionDecisionId: recognitionHeads.recognitionDecisionId,
      })
      .from(recognitionHeads)
      .where(eq(recognitionHeads.subjectId, input.assetId))
      .get();
    if (
      recognitionHead === undefined ||
      (recognitionHead.associationId ?? undefined) !==
        input.expectedRecognitionBaseline.recognitionSourceAssociationId ||
      recognitionHead.recognitionDecisionId !==
        input.expectedRecognitionBaseline.recognitionDecisionId
    ) {
      throw new Error(
        "Source Enrichment recognition identity baseline is stale",
      );
    }
    validateSourceInterpretationBatch(input.interpretation);
    validateSourceAssociationChange({
      proposal: input.proposal,
      decision: input.decision,
    });
    if (
      input.sourceAssociation.subjectId !== input.assetId ||
      input.interpretation.sourceIdentity !==
        input.sourceAssociation.sourceIdentity ||
      input.interpretation.sourceAddress !==
        input.sourceAssociation.nativeAddress
    ) {
      throw new Error(
        "Source Enrichment interpretation contradicts its Source Association",
      );
    }
    // 来源关联历史可以保留更正和取代，但独立丰富的规范地址只有一个当前所有者。
    // 第二个当前主体会在常规更正路径来得及审核前，把来源原生身份冲突变成描述性事实，
    // 因此应在该事务发出第一条 DML 前拒绝它。
    const conflictingCurrentCoordinate = query
      .select({ subjectId: currentSourceAssociations.subjectId })
      .from(currentSourceAssociations)
      .innerJoin(
        sourceAssociations,
        eq(sourceAssociations.id, currentSourceAssociations.associationId),
      )
      .where(
        and(
          eq(
            sourceAssociations.sourceIdentity,
            input.sourceAssociation.sourceIdentity,
          ),
          eq(
            sourceAssociations.nativeAddress,
            input.sourceAssociation.nativeAddress,
          ),
          ne(currentSourceAssociations.subjectId, input.assetId),
        ),
      )
      .get();
    if (conflictingCurrentCoordinate !== undefined) {
      throw new Error(
        "Source Enrichment identity conflict: canonical Source Association is current for another subject",
      );
    }
    const knownRecords = new Set(
      input.sourceRecords.map((record) => record.id),
    );
    const interpretationRecords = new Set(input.interpretation.sourceRecordIds);
    if (
      knownRecords.size !== input.sourceRecords.length ||
      input.interpretation.sourceRecordIds.length === 0 ||
      interpretationRecords.size !== knownRecords.size ||
      ![...interpretationRecords].every((id) => knownRecords.has(id))
    ) {
      throw new Error(
        "Source Enrichment lacks retained Source Record provenance",
      );
    }
    for (const record of input.sourceRecords) {
      if (
        record.sourceIdentity !== input.sourceAssociation.sourceIdentity ||
        record.nativeAddress !== input.sourceAssociation.nativeAddress ||
        record.coverage.authority !== "official"
      ) {
        throw new Error(
          "Source Enrichment has an invalid source identity or coverage baseline",
        );
      }
      if (
        !this.isCanonicalSourceRecordRetainedWithDrizzle(
          query,
          input.execution.id,
          record,
        )
      ) {
        throw new Error(
          "Source Enrichment lacks retained Source Record provenance",
        );
      }
      const currentHead = query
        .select({ sourceRecordId: sourceLineageHeads.sourceRecordId })
        .from(sourceLineageHeads)
        .where(
          and(
            eq(sourceLineageHeads.subjectId, input.assetId),
            eq(sourceLineageHeads.sourceIdentity, record.sourceIdentity),
            eq(sourceLineageHeads.nativeAddress, record.nativeAddress),
            eq(sourceLineageHeads.coverageId, record.coverage.id),
          ),
        )
        .get();
      if (currentHead !== undefined) {
        throw new Error("Source Enrichment source lineage baseline is stale");
      }
    }
    if (input.managedArtifacts !== undefined) {
      if (
        input.managedArtifacts.associations.some(
          (association) =>
            entityTargetId(association) !== input.assetId ||
            association.sourceRecordIds === undefined ||
            association.sourceRecordIds.length === 0 ||
            !association.sourceRecordIds.every((sourceRecordId) =>
              interpretationRecords.has(sourceRecordId),
            ),
        )
      ) {
        throw new Error(
          "Source Enrichment artifact lacks current interpretation provenance",
        );
      }
    }
    const existing = query
      .select({
        id: sourceAssociations.id,
      })
      .from(sourceAssociations)
      .where(
        and(
          eq(sourceAssociations.subjectId, input.assetId),
          eq(
            sourceAssociations.sourceIdentity,
            input.sourceAssociation.sourceIdentity,
          ),
          eq(
            sourceAssociations.nativeAddress,
            input.sourceAssociation.nativeAddress,
          ),
        ),
      )
      .get();
    const claimedIdentity = query
      .select({
        subjectId: sourceAssociations.subjectId,
        sourceIdentity: sourceAssociations.sourceIdentity,
        nativeAddress: sourceAssociations.nativeAddress,
      })
      .from(sourceAssociations)
      .where(eq(sourceAssociations.id, input.sourceAssociation.id))
      .get();
    if (
      claimedIdentity !== undefined &&
      (claimedIdentity.subjectId !== input.assetId ||
        claimedIdentity.sourceIdentity !==
          input.sourceAssociation.sourceIdentity ||
        claimedIdentity.nativeAddress !== input.sourceAssociation.nativeAddress)
    ) {
      throw new Error(
        "Source Enrichment Source Association conflicts with durable identity",
      );
    }
    // 丰富操作可能正要建立首个当前关联，因此通用元数据刷新预检刻意尚不要求该关联行存在。
    // 在下方插入关联之前，仍会完成所有批次、所有权、载荷和谱系检查。
    const metadataRefreshPreflight =
      this.preflightMetadataRefreshInputsWithDrizzle(
        query,
        {
          expectedExecution: input.expectedExecution,
          execution: input.execution,
          submission: {
            assetId: input.assetId,
            sourceAssociation: input.sourceAssociation,
            sourceRecords: input.sourceRecords,
            interpretation: input.interpretation,
            expectedLineageHeads: input.sourceRecords.map((record) => ({
              sourceIdentity: record.sourceIdentity,
              nativeAddress: record.nativeAddress,
              coverageId: record.coverage.id,
            })),
          },
        },
        { requireCurrentSourceAssociation: false },
      );
    // 重试可能携带新生成的关联 ID/提案，而先前的持久检查点已经拥有该精确来源坐标。
    // 应复用该不可变坐标及其原始提案引用；只有被另一坐标占用的 ID 才构成冲突。
    if (existing !== undefined) {
      return {
        id: existing.id,
        shouldInsert: false,
        metadataRefreshPreflight,
      };
    }
    return {
      id: input.sourceAssociation.id,
      shouldInsert: true,
      metadataRefreshPreflight,
    };
  }

  /**
   * 在调用方发出 `INSERT`、`UPDATE` 或 `DELETE` 前验证元数据批次的每个成员。
   * 批次不得先局部推进某个覆盖坐标，之后才发现另一成员格式错误、属于外部或已经过期。
   */
  private preflightMetadataRefreshInputsWithDrizzle(
    query: DrizzleReadQuery,
    input: MetadataRefreshInput,
    options: { readonly requireCurrentSourceAssociation?: boolean } = {},
  ): MetadataRefreshPreflight {
    const current = this.workflowExecutionPersistence.readExecutionWithDrizzle(
      query,
      input.execution.id,
    );
    if (current?.status !== "running") {
      throw new Error(
        `Execution ${input.execution.id} is not eligible for a metadata refresh`,
      );
    }
    if (
      input.expectedExecution !== undefined &&
      (current.id !== input.expectedExecution.id ||
        current.status !== input.expectedExecution.status ||
        current.stage !== input.expectedExecution.stage ||
        JSON.stringify(current.targetDispositions) !==
          JSON.stringify(input.expectedExecution.targetDispositions))
    ) {
      throw new Error("Metadata refresh parent target disposition is stale");
    }

    const sourceRecordIds = new Set<string>();
    const sourceCoverageCoordinates = new Set<string>();
    for (const record of input.submission.sourceRecords) {
      if (sourceRecordIds.has(record.id)) {
        throw new Error("Metadata refresh has duplicate Source Record IDs");
      }
      sourceRecordIds.add(record.id);
      const coordinate = `${record.sourceIdentity}\u0000${record.nativeAddress}\u0000${record.coverage.id}`;
      if (sourceCoverageCoordinates.has(coordinate)) {
        throw new Error(
          "Metadata refresh has duplicate source coverage coordinates",
        );
      }
      sourceCoverageCoordinates.add(coordinate);
    }

    const expectedHeads = new Map<string, string | undefined>();
    for (const head of input.submission.expectedLineageHeads) {
      const coordinate = `${head.sourceIdentity}\u0000${head.nativeAddress}\u0000${head.coverageId}`;
      if (expectedHeads.has(coordinate)) {
        throw new Error(
          "Metadata refresh has duplicate expected source lineage baselines",
        );
      }
      expectedHeads.set(coordinate, head.sourceRecordId);
    }
    if (
      expectedHeads.size !== sourceCoverageCoordinates.size ||
      [...sourceCoverageCoordinates].some(
        (coordinate) => !expectedHeads.has(coordinate),
      )
    ) {
      throw new Error(
        "Metadata refresh has an invalid source identity or coverage baseline",
      );
    }

    const interpretationSourceRecordIds =
      input.submission.interpretation.sourceRecordIds;
    const interpretationSourceRecordIdSet = new Set(
      interpretationSourceRecordIds,
    );
    if (
      interpretationSourceRecordIdSet.size !==
      interpretationSourceRecordIds.length
    ) {
      throw new Error(
        "Metadata refresh interpretation has duplicate Source Record IDs",
      );
    }
    if (
      interpretationSourceRecordIds.length === 0 ||
      interpretationSourceRecordIdSet.size !== sourceRecordIds.size ||
      ![...sourceRecordIds].every((recordId) =>
        interpretationSourceRecordIdSet.has(recordId),
      )
    ) {
      throw new Error(
        "Metadata refresh interpretation lacks exact Source Record provenance",
      );
    }
    if (
      input.submission.sourceAssociation.subjectId !==
        input.submission.assetId ||
      input.submission.interpretation.sourceIdentity !==
        input.submission.sourceAssociation.sourceIdentity ||
      input.submission.interpretation.sourceAddress !==
        input.submission.sourceAssociation.nativeAddress
    ) {
      throw new Error(
        "Metadata refresh has an invalid source identity or coverage baseline",
      );
    }
    if (options.requireCurrentSourceAssociation !== false) {
      const associationCurrent = query
        .select({
          currentSubjectId: currentSourceAssociations.subjectId,
          associationId: sourceAssociations.id,
          associationSubjectId: sourceAssociations.subjectId,
          sourceIdentity: sourceAssociations.sourceIdentity,
          nativeAddress: sourceAssociations.nativeAddress,
        })
        .from(currentSourceAssociations)
        .innerJoin(
          sourceAssociations,
          eq(sourceAssociations.id, currentSourceAssociations.associationId),
        )
        .where(
          and(
            eq(currentSourceAssociations.subjectId, input.submission.assetId),
            eq(
              currentSourceAssociations.associationId,
              input.submission.sourceAssociation.id,
            ),
          ),
        )
        .get();
      if (associationCurrent === undefined) {
        throw new Error(
          "Metadata refresh lost its current Source Association baseline",
        );
      }
      if (
        associationCurrent.associationId !==
          input.submission.sourceAssociation.id ||
        associationCurrent.currentSubjectId !== input.submission.assetId ||
        associationCurrent.associationSubjectId !== input.submission.assetId ||
        associationCurrent.sourceIdentity !==
          input.submission.sourceAssociation.sourceIdentity ||
        associationCurrent.nativeAddress !==
          input.submission.sourceAssociation.nativeAddress
      ) {
        throw new Error(
          "Metadata refresh Source Association conflicts with durable current association",
        );
      }
    }

    const records: Array<{
      readonly record: SourceRecord;
      readonly expectedHead: string | undefined;
    }> = [];
    for (const record of input.submission.sourceRecords) {
      const coordinate = `${record.sourceIdentity}\u0000${record.nativeAddress}\u0000${record.coverage.id}`;
      if (
        record.sourceIdentity !==
          input.submission.sourceAssociation.sourceIdentity ||
        record.nativeAddress !==
          input.submission.sourceAssociation.nativeAddress ||
        record.coverage.authority !== "official"
      ) {
        throw new Error(
          "Metadata refresh has an invalid source identity or coverage baseline",
        );
      }
      const recordOwner = query
        .select({ executionId: sourceRecords.executionId })
        .from(sourceRecords)
        .where(eq(sourceRecords.id, record.id))
        .get();
      if (
        recordOwner?.executionId !== input.execution.id ||
        !this.isCanonicalSourceRecordRetainedWithDrizzle(
          query,
          input.execution.id,
          record,
        )
      ) {
        throw new Error("Metadata refresh stale Source Record provenance");
      }
      const head = query
        .select({ sourceRecordId: sourceLineageHeads.sourceRecordId })
        .from(sourceLineageHeads)
        .where(
          and(
            eq(sourceLineageHeads.subjectId, input.submission.assetId),
            eq(sourceLineageHeads.sourceIdentity, record.sourceIdentity),
            eq(sourceLineageHeads.nativeAddress, record.nativeAddress),
            eq(sourceLineageHeads.coverageId, record.coverage.id),
          ),
        )
        .get();
      const expectedHead = expectedHeads.get(coordinate);
      if (head?.sourceRecordId !== expectedHead) {
        throw new Error("Metadata refresh source lineage is stale");
      }
      records.push({ record, expectedHead });
    }
    return { records };
  }

  /**
   * 用于来源范围元数据/关系谱系的事务性 Drizzle 辅助方法。识别重新评估、来源刷新运行和
   * 已接受来源丰富会把它与各自的不可变状态变更组合起来。
   */
  private applyMetadataRefreshInTransactionWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: MetadataRefreshInput,
    preflight?: MetadataRefreshPreflight,
  ): void {
    const planned =
      preflight ??
      this.preflightMetadataRefreshInputsWithDrizzle(transaction, input);
    for (const { record, expectedHead } of planned.records) {
      transaction
        .insert(sourceRefreshChanges)
        .values({
          id: `source-refresh-change_${record.id}`,
          executionId: input.execution.id,
          subjectId: input.submission.assetId,
          sourceIdentity: record.sourceIdentity,
          nativeAddress: record.nativeAddress,
          coverageId: record.coverage.id,
          baselineSourceRecordId: expectedHead ?? null,
          sourceRecordId: record.id,
          completeness: record.coverage.completeness,
        })
        .run();
      // 首条记录会建立新的主体谱系；它没有需要撤回的前驱支持。完整覆盖只能撤回
      // 从该主体精确前驱来源记录链抵达的事实，绝不能撤回共享同一规范地址的另一主体事实。
      if (
        record.coverage.completeness === "complete" &&
        expectedHead !== undefined
      ) {
        const metadataCoordinates = input.submission.interpretation.metadata
          .filter((assertion) => assertion.sourceRecordIds[0] === record.id)
          .map((assertion) =>
            sourceFactCoordinate(
              assertion.subjectId ?? input.submission.assetId,
              assertion.sourceSlot,
            ),
          );
        const relationshipCoordinates = (
          input.submission.interpretation.relationships ?? []
        )
          .filter(
            (relationship) => relationship.sourceRecordIds[0] === record.id,
          )
          .map((relationship) =>
            sourceFactCoordinate(
              relationshipSourceSubjectId(
                input.submission.assetId,
                relationship,
              ),
              relationship.sourceSlot,
            ),
          );
        this.retractScopedFactsWithDrizzle(transaction, {
          assetId: input.submission.assetId,
          sourceIdentity: record.sourceIdentity,
          nativeAddress: record.nativeAddress,
          coverageId: record.coverage.id,
          predecessorSourceRecordId: expectedHead,
          sourceRecordId: record.id,
          coverageCompleteness: record.coverage.completeness,
          nextMetadataCoordinates: metadataCoordinates,
          nextRelationshipCoordinates: relationshipCoordinates,
        });
      }
      const changed =
        expectedHead === undefined
          ? transaction
              .insert(sourceLineageHeads)
              .values({
                subjectId: input.submission.assetId,
                sourceIdentity: record.sourceIdentity,
                nativeAddress: record.nativeAddress,
                coverageId: record.coverage.id,
                sourceRecordId: record.id,
              })
              .onConflictDoNothing()
              .run()
          : transaction
              .update(sourceLineageHeads)
              .set({ sourceRecordId: record.id })
              .where(
                and(
                  eq(sourceLineageHeads.subjectId, input.submission.assetId),
                  eq(sourceLineageHeads.sourceIdentity, record.sourceIdentity),
                  eq(sourceLineageHeads.nativeAddress, record.nativeAddress),
                  eq(sourceLineageHeads.coverageId, record.coverage.id),
                  eq(sourceLineageHeads.sourceRecordId, expectedHead),
                ),
              )
              .run();
      if (changed.changes !== 1) {
        throw new Error("Metadata refresh source lineage is stale");
      }
    }
    for (const record of input.submission.sourceRecords) {
      this.extendEquivalentManagedSourceArtifactSupportWithDrizzle(
        transaction,
        {
          subjectId: input.submission.assetId,
          sourceAssociationId: input.submission.sourceAssociation.id,
          record,
          interpretation: input.submission.interpretation,
        },
      );
      this.persistCurrentSourceArtifactCandidateLineageWithDrizzle(
        transaction,
        {
          subjectId: input.submission.assetId,
          sourceAssociation: input.submission.sourceAssociation,
          record,
          interpretation: input.submission.interpretation,
        },
      );
    }
    this.insertRefreshMetadataWithDrizzle(transaction, input.submission);
    this.insertRefreshRelationshipsWithDrizzle(transaction, input.submission);
    this.insertRefreshMentionsWithDrizzle(transaction, input.submission);
    this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
      input.submission.assetId,
    ]);
  }

  async freezeSourceLineageHeads(input: {
    readonly assetId: string;
    readonly sourceAssociation: import("@digital/domain").SourceAssociation;
    readonly coverageIds: readonly string[];
  }): Promise<MetadataRefreshSubmission["expectedLineageHeads"]> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    return input.coverageIds.map((coverageId) => {
      const head = query
        .select({ sourceRecordId: sourceLineageHeads.sourceRecordId })
        .from(sourceLineageHeads)
        .where(
          and(
            eq(sourceLineageHeads.subjectId, input.assetId),
            eq(
              sourceLineageHeads.sourceIdentity,
              input.sourceAssociation.sourceIdentity,
            ),
            eq(
              sourceLineageHeads.nativeAddress,
              input.sourceAssociation.nativeAddress,
            ),
            eq(sourceLineageHeads.coverageId, coverageId),
          ),
        )
        .get();
      return {
        sourceIdentity: input.sourceAssociation.sourceIdentity,
        nativeAddress: input.sourceAssociation.nativeAddress,
        coverageId,
        ...(head === undefined ? {} : { sourceRecordId: head.sourceRecordId }),
      };
    });
  }

  private finishChangeImpactExecutionWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
    state: "applied" | "rejected" | "stale",
  ): void {
    const terminalExecution: WorkflowExecution = {
      ...execution,
      status: state === "stale" ? "failed" : "completed",
      stage: state === "stale" ? "failed" : "completed",
      outcome:
        state === "applied"
          ? "accepted"
          : state === "rejected"
            ? "cancelled"
            : "failed",
      ...(state === "stale"
        ? { reason: "变更影响预演的当前基线已经变化" }
        : {}),
      ...(execution.sourceAssociationDecision === undefined
        ? {}
        : {
            sourceAssociationDecision: {
              ...execution.sourceAssociationDecision,
              state,
            },
          }),
    };
    const baseline = this.workflowExecutionPersistence.runningExecutionBaseline(
      transaction,
      execution,
      terminalExecution,
    );
    this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
      transaction,
      terminalExecution,
      { auditJson: baseline.auditJson },
    );
  }

  async saveChangeImpactPreview(preview: ChangeImpactPreview): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const guarded = this.withOtherLegacyArtifactDeltaBlocked(query, preview);
    query
      .insert(changeImpactPreviews)
      .values({
        id: preview.id,
        executionId: preview.executionId,
        assetId: preview.assetId,
        previewJson: JSON.stringify(guarded),
      })
      .run();
  }

  async inspectChangeImpactPreview(
    previewId: string,
  ): Promise<ChangeImpactPreview | undefined> {
    const database = await this.ensure();
    const row = drizzle({ client: database })
      .select({ previewJson: changeImpactPreviews.previewJson })
      .from(changeImpactPreviews)
      .where(eq(changeImpactPreviews.id, previewId))
      .get();
    return row === undefined
      ? undefined
      : (JSON.parse(row.previewJson) as ChangeImpactPreview);
  }

  async inspectChangeImpactPreviewForExecution(
    executionId: string,
  ): Promise<ChangeImpactPreview | undefined> {
    const database = await this.ensure();
    const row = drizzle({ client: database })
      .select({ previewJson: changeImpactPreviews.previewJson })
      .from(changeImpactPreviews)
      .where(eq(changeImpactPreviews.executionId, executionId))
      // SQLite 的行顺序属于该历史检查点契约；将它保留为绑定数据库模式的表达式，
      // 而不是手写 SQL。
      .orderBy(desc(sql<number>`${changeImpactPreviews}.rowid`))
      .get();
    return row === undefined
      ? undefined
      : (JSON.parse(row.previewJson) as ChangeImpactPreview);
  }

  async freezeChangeImpactBaseline(input: {
    readonly assetId: string;
    readonly recognitionSourceAssociationId?: string;
    readonly recognitionDecisionId: string;
    readonly scopeDecisionIds?: readonly string[];
  }): Promise<string> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const head = query
      .select()
      .from(recognitionHeads)
      .where(eq(recognitionHeads.subjectId, input.assetId))
      .get();
    if (
      head === undefined ||
      (head.recognitionSourceAssociationId ?? undefined) !==
        input.recognitionSourceAssociationId ||
      // 主头为空时点名的决定只是读取依据，基线钉住的就是那份决定。
      (head.recognitionDecisionId !== null &&
        head.recognitionDecisionId !== input.recognitionDecisionId)
    ) {
      throw new Error("Change Impact Preview lost its identity baseline");
    }
    return this.currentChangeImpactBaselineWithDrizzle(
      query,
      input.assetId,
      input.scopeDecisionIds,
    );
  }

  async rejectChangeImpactPreview(input: {
    readonly previewId: string;
    readonly rejectedBy: string;
  }): Promise<"rejected" | "stale"> {
    const database = await this.ensure();
    let result: "rejected" | "stale" = "stale";
    drizzle({ client: database }).transaction(
      (transaction) => {
        const stored = transaction
          .select({ previewJson: changeImpactPreviews.previewJson })
          .from(changeImpactPreviews)
          .where(eq(changeImpactPreviews.id, input.previewId))
          .get();
        if (stored === undefined) return;
        const preview = JSON.parse(stored.previewJson) as ChangeImpactPreview;
        if (preview.status !== "awaiting-confirmation") return;
        const execution =
          this.workflowExecutionPersistence.readExecutionWithDrizzle(
            transaction,
            preview.executionId,
          );
        if (
          execution?.status !== "running" &&
          execution?.sourceAssociationDecision !== undefined
        ) {
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({ ...preview, status: "stale" }),
            })
            .where(eq(changeImpactPreviews.id, input.previewId))
            .run();
          return;
        }
        if (execution?.status === "running")
          this.finishChangeImpactExecutionWithDrizzle(
            transaction,
            execution,
            "rejected",
          );
        transaction
          .update(changeImpactPreviews)
          .set({
            previewJson: JSON.stringify({
              ...preview,
              status: "rejected",
              rejectedBy: input.rejectedBy,
            }),
          })
          .where(eq(changeImpactPreviews.id, input.previewId))
          .run();
        result = "rejected";
      },
      { behavior: "immediate" },
    );
    return result;
  }

  async applyChangeImpactPreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly plan: RecognitionSupersessionPlan;
  }): Promise<"applied" | "stale"> {
    const { preview, plan } = input;
    const database = await this.ensure();
    let result: "applied" | "stale" = "stale";
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const stored = transaction
          .select({ previewJson: changeImpactPreviews.previewJson })
          .from(changeImpactPreviews)
          .where(eq(changeImpactPreviews.id, preview.id))
          .get();
        if (stored === undefined) return;
        const currentPreview = JSON.parse(
          stored.previewJson,
        ) as ChangeImpactPreview;
        if (currentPreview.status !== "awaiting-confirmation") return;
        if (
          currentPreview.version !== "change-impact-preview/2" ||
          currentPreview.change.kind !== "recognition-supersession"
        )
          return;
        const waitingExecution =
          this.workflowExecutionPersistence.readExecutionWithDrizzle(
            transaction,
            currentPreview.executionId,
          );
        if (currentPreview.blockingConditions.length > 0)
          throw new Error("Change Impact Preview has blocking conditions");
        const replacementProposal = currentPreview.change.proposal;
        const currentHead = transaction
          .select({
            associationId: recognitionHeads.recognitionSourceAssociationId,
            recognitionDecisionId: recognitionHeads.recognitionDecisionId,
            sourceIdentity: sourceAssociations.sourceIdentity,
            nativeAddress: sourceAssociations.nativeAddress,
          })
          .from(recognitionHeads)
          .leftJoin(
            sourceAssociations,
            eq(
              sourceAssociations.id,
              recognitionHeads.recognitionSourceAssociationId,
            ),
          )
          .where(eq(recognitionHeads.subjectId, currentPreview.assetId))
          .get();
        const expectedAssociation = currentPreview.baselines.find(
          (baseline) => baseline.key === "source-association",
        )?.value;
        const expectedDecision = currentPreview.baselines.find(
          (baseline) => baseline.key === "recognition-decision",
        )?.value;
        const expectedSourceRecords = currentPreview.baselines.find(
          (baseline) => baseline.key === "source-records",
        )?.value;
        const expectedCompleteProjection = currentPreview.baselines.find(
          (baseline) => baseline.key === "complete-current-projection",
        )?.value;
        const currentDecision =
          currentHead === undefined ||
          currentHead.recognitionDecisionId === null
            ? undefined
            : transaction
                .select({
                  proposalId: recognitionDecisions.proposalId,
                  boundariesJson: recognitionDecisions.boundariesJson,
                  acceptedRuleResultsJson:
                    recognitionDecisions.acceptedRuleResultsJson,
                })
                .from(recognitionDecisions)
                .where(
                  eq(
                    recognitionDecisions.id,
                    currentHead.recognitionDecisionId,
                  ),
                )
                .get();
        const currentProposal =
          currentDecision === undefined
            ? undefined
            : this.readProposalWithDrizzle(
                transaction,
                currentDecision.proposalId,
              );
        const currentInterpretation =
          currentProposal === undefined
            ? undefined
            : recognitionSourceInterpretation(currentProposal);
        const currentBasisCoordinatesMatch =
          currentInterpretation === undefined
            ? currentHead?.associationId === null &&
              currentHead.sourceIdentity === null &&
              currentHead.nativeAddress === null
            : currentHead?.associationId !== null &&
              currentHead?.associationId !== undefined &&
              currentHead.sourceIdentity ===
                currentInterpretation.sourceIdentity &&
              currentHead.nativeAddress === currentInterpretation.sourceAddress;
        if (!currentBasisCoordinatesMatch)
          throw new Error(
            "Change Impact Preview predecessor basis is inconsistent with its recognition head",
          );
        const projectedInterpretation =
          recognitionSourceInterpretation(replacementProposal);
        const projectedSourceAssociation =
          currentPreview.projected.recognitionSourceAssociation;
        const currentSourceRecords =
          currentInterpretation?.sourceRecordIds.toSorted().join(",") ?? "";
        const currentAssociationId = currentHead?.associationId ?? undefined;
        const projectedCoordinatesMatch =
          projectedInterpretation === undefined
            ? projectedSourceAssociation === undefined &&
              plan.recognitionSourceAssociation === undefined
            : projectedSourceAssociation !== undefined &&
              plan.recognitionSourceAssociation?.subjectId ===
                currentPreview.assetId &&
              plan.recognitionSourceAssociation.sourceIdentity ===
                projectedInterpretation.sourceIdentity &&
              plan.recognitionSourceAssociation.nativeAddress ===
                projectedInterpretation.sourceAddress &&
              projectedSourceAssociation.sourceIdentity ===
                projectedInterpretation.sourceIdentity &&
              projectedSourceAssociation.nativeAddress ===
                projectedInterpretation.sourceAddress;
        if (
          plan.successorDecision.proposalId !== replacementProposal.id ||
          plan.successorDecision.assetId !== currentPreview.assetId ||
          JSON.stringify(plan.successorDecision.acceptedRuleResults) !==
            JSON.stringify(replacementProposal.ruleResults) ||
          plan.supersession.predecessorDecisionId !== expectedDecision ||
          plan.supersession.successorDecisionId !== plan.successorDecision.id ||
          !projectedCoordinatesMatch
        )
          throw new Error(
            "Change Impact Preview replacement plan is inconsistent",
          );
        if (
          currentHead === undefined ||
          currentAssociationId !== expectedAssociation ||
          currentHead.recognitionDecisionId !== expectedDecision ||
          currentSourceRecords !== expectedSourceRecords ||
          this.currentChangeImpactBaselineWithDrizzle(
            transaction,
            currentPreview.assetId,
          ) !== expectedCompleteProjection
        ) {
          if (waitingExecution?.status === "running")
            this.finishChangeImpactExecutionWithDrizzle(
              transaction,
              waitingExecution,
              "stale",
            );
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({
                ...currentPreview,
                status: "stale",
              }),
            })
            .where(eq(changeImpactPreviews.id, currentPreview.id))
            .run();
          return;
        }
        for (const sourceRecordId of projectedInterpretation?.sourceRecordIds ??
          []) {
          const record = transaction
            .select()
            .from(sourceRecords)
            .where(eq(sourceRecords.id, sourceRecordId))
            .get();
          const coverage =
            record === undefined
              ? undefined
              : (JSON.parse(record.coverageJson) as SourceRecord["coverage"]);
          if (
            record === undefined ||
            record.executionId !== currentPreview.executionId ||
            record.sourceIdentity !==
              projectedSourceAssociation?.sourceIdentity ||
            record.nativeAddress !== projectedSourceAssociation.nativeAddress ||
            coverage?.authority !== "official"
          ) {
            throw new Error(
              "Change Impact Preview references an invalid projected Source Record",
            );
          }
        }
        const replacementSourceRecordId =
          projectedInterpretation?.sourceRecordIds[0];
        if (
          projectedInterpretation !== undefined &&
          replacementSourceRecordId === undefined
        ) {
          throw new Error(
            "Change Impact Preview requires Source Record lineage",
          );
        }
        const associationId = plan.recognitionSourceAssociation?.id;
        const decisionId = plan.successorDecision.id;
        if (plan.recognitionSourceAssociation !== undefined)
          transaction
            .insert(sourceAssociations)
            .values({
              ...plan.recognitionSourceAssociation,
            })
            .run();
        transaction
          .insert(recognitionDecisions)
          .values({
            id: plan.successorDecision.id,
            proposalId: plan.successorDecision.proposalId,
            assetId: plan.successorDecision.assetId,
            acceptedRuleResultsJson: JSON.stringify(
              plan.successorDecision.acceptedRuleResults,
            ),
            boundariesJson: JSON.stringify(plan.successorDecision.boundaries),
          })
          .run();
        transaction
          .insert(recognitionDecisionSupersessions)
          .values({
            ...plan.supersession,
          })
          .run();
        if (associationId !== undefined)
          transaction
            .insert(sourceAssociationEstablishmentSupports)
            .values({
              associationId,
              recognitionDecisionId: decisionId,
            })
            .run();
        const advanced = transaction
          .update(recognitionHeads)
          .set({
            recognitionSourceAssociationId: associationId ?? null,
            recognitionDecisionId: decisionId,
          })
          .where(
            and(
              eq(recognitionHeads.subjectId, currentPreview.assetId),
              currentHead.associationId === null
                ? isNull(recognitionHeads.recognitionSourceAssociationId)
                : eq(
                    recognitionHeads.recognitionSourceAssociationId,
                    currentHead.associationId,
                  ),
              eq(
                recognitionHeads.recognitionDecisionId,
                currentHead.recognitionDecisionId,
              ),
            ),
          )
          .run();
        if (advanced.changes !== 1) {
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({
                ...currentPreview,
                status: "stale",
              }),
            })
            .where(eq(changeImpactPreviews.id, currentPreview.id))
            .run();
          return;
        }
        // 识别只拥有前序决定建立的关联；独立补充或更正的关联仍保持当前。
        if (currentAssociationId !== undefined && associationId !== undefined) {
          transaction
            .insert(sourceAssociationSupersessions)
            .values({
              id: `source-association-supersession:${plan.supersession.id}`,
              predecessorAssociationId: currentAssociationId,
              successorAssociationId: associationId,
              recognitionDecisionId: decisionId,
            })
            .run();
          transaction
            .delete(currentSourceAssociations)
            .where(
              and(
                eq(currentSourceAssociations.subjectId, currentPreview.assetId),
                eq(
                  currentSourceAssociations.associationId,
                  currentAssociationId,
                ),
              ),
            )
            .run();
        }
        if (currentAssociationId !== undefined && associationId === undefined) {
          const establishment = transaction
            .select()
            .from(sourceAssociationEstablishmentSupports)
            .where(
              eq(
                sourceAssociationEstablishmentSupports.associationId,
                currentAssociationId,
              ),
            )
            .get();
          if (establishment === undefined)
            throw new Error(
              "Recognition source Association lacks establishment support",
            );
          const association: SourceAssociation = {
            id: currentAssociationId,
            subjectId: currentPreview.assetId,
            sourceIdentity: currentHead.sourceIdentity!,
            nativeAddress: currentHead.nativeAddress!,
          };
          const establishmentSupport: SourceAssociationEstablishmentSupport = {
            associationId: currentAssociationId,
            establishedBy:
              establishment.recognitionDecisionId === null
                ? {
                    kind: "source-association-decision",
                    decisionId: establishment.sourceAssociationDecisionId!,
                  }
                : {
                    kind: "recognition-decision",
                    decisionId: establishment.recognitionDecisionId,
                  },
          };
          const retraction: SourceAssociationRetraction = {
            id: `source-association-retraction:${plan.supersession.id}`,
            associationId: currentAssociationId,
            authorizedBy: {
              kind: "recognition-decision-supersession",
              supersessionId: plan.supersession.id,
            },
          };
          validateRecognitionSupersessionSourceRetraction({
            retraction,
            association,
            establishmentSupport,
            supersession: plan.supersession,
            predecessorDecision: {
              id: currentHead.recognitionDecisionId,
              boundaries: JSON.parse(
                currentDecision!.boundariesJson,
              ) as RecognitionDecision["boundaries"],
              proposalId: currentDecision!.proposalId,
              assetId: currentPreview.assetId,
              acceptedRuleResults: JSON.parse(
                currentDecision!.acceptedRuleResultsJson,
              ) as RecognitionDecision["acceptedRuleResults"],
            },
            successorDecision: plan.successorDecision,
            successorProposal: replacementProposal,
          });
          transaction
            .insert(sourceAssociationRetractions)
            .values({
              id: retraction.id,
              associationId: currentAssociationId,
              recognitionDecisionSupersessionId: plan.supersession.id,
            })
            .run();
          transaction
            .delete(currentSourceAssociations)
            .where(
              and(
                eq(currentSourceAssociations.subjectId, currentPreview.assetId),
                eq(
                  currentSourceAssociations.associationId,
                  currentAssociationId,
                ),
              ),
            )
            .run();
          this.retractArtifactsLosingLastSupportWithDrizzle(
            transaction,
            currentAssociationId,
            replacementProposal.id,
          );
        }
        if (associationId !== undefined)
          transaction
            .insert(currentSourceAssociations)
            .values({ subjectId: currentPreview.assetId, associationId })
            .onConflictDoNothing()
            .run();
        if (projectedInterpretation === undefined) {
          if (currentProposal === undefined || currentDecision === undefined)
            throw new Error(
              "Observed recognition replacement requires a durable predecessor",
            );
          const predecessorRecognitionSourceAssociation =
            currentInterpretation === undefined
              ? undefined
              : {
                  id: currentHead.associationId!,
                  subjectId: currentPreview.assetId,
                  sourceIdentity: currentHead.sourceIdentity!,
                  nativeAddress: currentHead.nativeAddress!,
                  proposalId: currentProposal.id,
                };
          const currentAccepted: AcceptedRecognition = {
            proposal: currentProposal,
            entity: { id: currentPreview.assetId, kind: "digital-asset" },
            sourceAssociations:
              predecessorRecognitionSourceAssociation === undefined
                ? []
                : [predecessorRecognitionSourceAssociation],
            ...(predecessorRecognitionSourceAssociation === undefined
              ? {}
              : {
                  recognitionSourceAssociation:
                    predecessorRecognitionSourceAssociation,
                }),
            recognitionDecision: {
              id: currentHead.recognitionDecisionId,
              boundaries: JSON.parse(
                currentDecision.boundariesJson,
              ) as RecognitionDecision["boundaries"],
              proposalId: currentDecision.proposalId,
              assetId: currentPreview.assetId,
              acceptedRuleResults: JSON.parse(
                currentDecision.acceptedRuleResultsJson,
              ) as AcceptedRecognition["recognitionDecision"]["acceptedRuleResults"],
            },
            metadata: currentPreview.current.metadata,
            entities: currentPreview.current.entities,
            entityMentions: currentPreview.current.entityMentions,
            entityResolutionDecisions:
              currentPreview.current.entityResolutionDecisions,
            relationships: currentPreview.current.relationships,
            artifacts: currentPreview.current.artifacts,
            locations: currentPreview.current.locations,
            blobs: currentPreview.current.blobs,
            artifactRevisions: currentPreview.current.artifactRevisions,
            artifactAssociations: currentPreview.current.artifactAssociations,
          };
          const nextAccepted: AcceptedRecognition = {
            proposal: replacementProposal,
            entity: { id: currentPreview.assetId, kind: "digital-asset" },
            sourceAssociations: [],
            recognitionDecision: plan.successorDecision,
            metadata: currentPreview.projected.metadata,
            entities: currentPreview.projected.entities,
            entityMentions: currentPreview.projected.entityMentions,
            entityResolutionDecisions:
              currentPreview.projected.entityResolutionDecisions,
            relationships: currentPreview.projected.relationships,
            artifacts: currentPreview.projected.artifacts,
            locations: currentPreview.projected.locations,
            blobs: currentPreview.projected.blobs,
            artifactRevisions: currentPreview.projected.artifactRevisions,
            artifactAssociations: currentPreview.projected.artifactAssociations,
            ...(currentPreview.projectedObservedEntityGraphs === undefined
              ? {}
              : {
                  observedEntityGraphs:
                    currentPreview.projectedObservedEntityGraphs,
                }),
          };
          this.insertReevaluatedArtifactFactsWithDrizzle(
            transaction,
            currentAccepted,
            nextAccepted,
          );
          this.applyAppliedPreviewMaterialBindingsWithDrizzle(
            transaction,
            waitingExecution,
            { ...currentPreview, status: "applied" },
          );
          this.writeLocalAssociationSupportsWithDrizzle(
            transaction,
            nextAccepted,
          );
          this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
            currentPreview.assetId,
          ]);
          if (waitingExecution?.status === "running")
            this.finishChangeImpactExecutionWithDrizzle(
              transaction,
              waitingExecution,
              "applied",
            );
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({
                ...currentPreview,
                status: "applied",
              }),
            })
            .where(eq(changeImpactPreviews.id, currentPreview.id))
            .run();
          result = "applied";
          return;
        }
        const sourceAssociation = plan.recognitionSourceAssociation;
        if (
          sourceAssociation === undefined ||
          replacementSourceRecordId === undefined
        )
          throw new Error(
            "Source recognition replacement requires exact source coordinates",
          );
        const submission: MetadataRefreshSubmission = {
          assetId: currentPreview.assetId,
          sourceAssociation,
          sourceRecords: [],
          expectedLineageHeads: [],
          interpretation: projectedInterpretation,
        };
        for (const sourceRecordId of projectedInterpretation.sourceRecordIds) {
          const record = this.sourceRecordWithDrizzle(
            transaction,
            sourceRecordId,
          );
          transaction
            .insert(sourceLineageHeads)
            .values({
              subjectId: currentPreview.assetId,
              sourceIdentity: record.sourceIdentity,
              nativeAddress: record.nativeAddress,
              coverageId: record.coverage.id,
              sourceRecordId,
            })
            .onConflictDoUpdate({
              target: [
                sourceLineageHeads.subjectId,
                sourceLineageHeads.sourceIdentity,
                sourceLineageHeads.nativeAddress,
                sourceLineageHeads.coverageId,
              ],
              set: { sourceRecordId },
            })
            .run();
          this.persistCurrentSourceArtifactCandidateLineageWithDrizzle(
            transaction,
            {
              subjectId: currentPreview.assetId,
              sourceAssociation: submission.sourceAssociation,
              record,
              interpretation: projectedInterpretation,
            },
          );
        }
        this.insertRefreshMetadataWithDrizzle(transaction, submission);
        this.insertProjectedRelationshipsAndMentionsWithDrizzle(transaction, {
          ...currentPreview,
          proposal: replacementProposal,
        });
        this.applyProjectedArtifactsWithDrizzle(
          transaction,
          { ...currentPreview, proposal: replacementProposal },
          currentHead.recognitionDecisionId,
          decisionId,
        );
        this.applyAppliedPreviewMaterialBindingsWithDrizzle(
          transaction,
          waitingExecution,
          { ...currentPreview, status: "applied" },
        );
        this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
          currentPreview.assetId,
        ]);
        if (waitingExecution?.status === "running")
          this.finishChangeImpactExecutionWithDrizzle(
            transaction,
            waitingExecution,
            "applied",
          );
        transaction
          .update(changeImpactPreviews)
          .set({
            previewJson: JSON.stringify({
              ...currentPreview,
              status: "applied",
            }),
          })
          .where(eq(changeImpactPreviews.id, currentPreview.id))
          .run();
        result = "applied";
      },
      { behavior: "immediate" },
    );
    return result;
  }

  async applySourceAssociationChangePreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly decision: SourceAssociationDecision;
    readonly confirmedBy: string;
  }): Promise<"applied" | "stale"> {
    const database = await this.ensure();
    let result: "applied" | "stale" = "stale";
    drizzle({ client: database }).transaction(
      (transaction) => {
        const row = transaction
          .select({ previewJson: changeImpactPreviews.previewJson })
          .from(changeImpactPreviews)
          .where(eq(changeImpactPreviews.id, input.preview.id))
          .get();
        if (row === undefined) return;
        const preview = JSON.parse(row.previewJson) as ChangeImpactPreview;
        if (preview.status !== "awaiting-confirmation") return;
        if (
          preview.version !== "change-impact-preview/2" ||
          preview.change?.kind !== "source-association" ||
          preview.blockingConditions.length > 0
        )
          throw new Error("Source Association preview is not applicable");
        const proposal = preview.change.proposal;
        const execution =
          this.workflowExecutionPersistence.readExecutionWithDrizzle(
            transaction,
            preview.executionId,
          );
        if (
          execution?.status !== "running" &&
          execution?.sourceAssociationDecision !== undefined
        ) {
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({ ...preview, status: "stale" }),
            })
            .where(eq(changeImpactPreviews.id, preview.id))
            .run();
          return;
        }
        const predecessor =
          proposal.kind === "establish"
            ? undefined
            : transaction
                .select()
                .from(sourceAssociations)
                .where(
                  eq(sourceAssociations.id, proposal.predecessorAssociationId),
                )
                .get();
        if (proposal.kind !== "establish") {
          const isCurrent = transaction
            .select({ associationId: currentSourceAssociations.associationId })
            .from(currentSourceAssociations)
            .where(
              and(
                eq(currentSourceAssociations.subjectId, proposal.subjectId),
                eq(
                  currentSourceAssociations.associationId,
                  proposal.predecessorAssociationId,
                ),
              ),
            )
            .get();
          const alreadySuperseded = transaction
            .select({ id: sourceAssociationSupersessions.id })
            .from(sourceAssociationSupersessions)
            .where(
              eq(
                sourceAssociationSupersessions.predecessorAssociationId,
                proposal.predecessorAssociationId,
              ),
            )
            .get();
          const alreadyRetracted = transaction
            .select({ id: sourceAssociationRetractions.id })
            .from(sourceAssociationRetractions)
            .where(
              eq(
                sourceAssociationRetractions.associationId,
                proposal.predecessorAssociationId,
              ),
            )
            .get();
          if (
            predecessor === undefined ||
            predecessor.subjectId !== proposal.subjectId ||
            isCurrent === undefined ||
            alreadySuperseded !== undefined ||
            alreadyRetracted !== undefined
          ) {
            if (execution?.status === "running")
              this.finishChangeImpactExecutionWithDrizzle(
                transaction,
                execution,
                "stale",
              );
            transaction
              .update(changeImpactPreviews)
              .set({
                previewJson: JSON.stringify({ ...preview, status: "stale" }),
              })
              .where(eq(changeImpactPreviews.id, preview.id))
              .run();
            return;
          }
        }
        validateSourceAssociationChange({
          proposal,
          decision: input.decision,
          ...(predecessor === undefined ? {} : { predecessor }),
        });
        const selectedCandidate =
          proposal.kind === "retract"
            ? undefined
            : execution?.sourceAssociationDecision?.candidates.find(
                (candidate) =>
                  candidate.sourceIdentity ===
                    proposal.successor.sourceIdentity &&
                  candidate.nativeAddress ===
                    proposal.successor.nativeAddress &&
                  JSON.stringify(candidate.sourceRecordIds.toSorted()) ===
                    JSON.stringify(proposal.sourceRecordIds.toSorted()),
              );
        if (
          proposal.kind !== "retract" &&
          (selectedCandidate === undefined ||
            selectedCandidate.interpretation.sourceIdentity !==
              proposal.successor.sourceIdentity ||
            selectedCandidate.interpretation.sourceAddress !==
              proposal.successor.nativeAddress)
        )
          throw new Error("Source Association preview lost its interpretation");
        const expectedProjection = preview.baselines.find(
          ({ key }) => key === "complete-current-projection",
        )?.value;
        if (
          expectedProjection === undefined ||
          this.currentChangeImpactBaselineWithDrizzle(
            transaction,
            preview.assetId,
          ) !== expectedProjection
        ) {
          if (execution?.status === "running")
            this.finishChangeImpactExecutionWithDrizzle(
              transaction,
              execution,
              "stale",
            );
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({ ...preview, status: "stale" }),
            })
            .where(eq(changeImpactPreviews.id, preview.id))
            .run();
          return;
        }
        const successor =
          proposal.kind === "retract" ? undefined : proposal.successor;
        if (successor !== undefined) {
          const collision = transaction
            .select({
              subjectId: currentSourceAssociations.subjectId,
              associationId: sourceAssociations.id,
            })
            .from(currentSourceAssociations)
            .innerJoin(
              sourceAssociations,
              eq(
                sourceAssociations.id,
                currentSourceAssociations.associationId,
              ),
            )
            .where(
              and(
                eq(sourceAssociations.sourceIdentity, successor.sourceIdentity),
                eq(sourceAssociations.nativeAddress, successor.nativeAddress),
              ),
            )
            .get();
          if (collision !== undefined) {
            if (execution?.status === "running")
              this.finishChangeImpactExecutionWithDrizzle(
                transaction,
                execution,
                "stale",
              );
            transaction
              .update(changeImpactPreviews)
              .set({
                previewJson: JSON.stringify({ ...preview, status: "stale" }),
              })
              .where(eq(changeImpactPreviews.id, preview.id))
              .run();
            return;
          }
        }
        this.insertSourceAssociationDecisionWithDrizzle(transaction, {
          proposal,
          decision: input.decision,
          ...(predecessor === undefined ? {} : { predecessor }),
        });
        if (successor !== undefined) {
          transaction.insert(sourceAssociations).values(successor).run();
          transaction
            .insert(sourceAssociationEstablishmentSupports)
            .values({
              associationId: successor.id,
              sourceAssociationDecisionId: input.decision.id,
            })
            .run();
          transaction
            .insert(currentSourceAssociations)
            .values({
              subjectId: proposal.subjectId,
              associationId: successor.id,
            })
            .run();
          for (const sourceRecordId of selectedCandidate!.sourceRecordIds) {
            const record = this.sourceRecordWithDrizzle(
              transaction,
              sourceRecordId,
            );
            transaction
              .insert(sourceLineageHeads)
              .values({
                subjectId: proposal.subjectId,
                sourceIdentity: record.sourceIdentity,
                nativeAddress: record.nativeAddress,
                coverageId: record.coverage.id,
                sourceRecordId,
              })
              .onConflictDoUpdate({
                target: [
                  sourceLineageHeads.subjectId,
                  sourceLineageHeads.sourceIdentity,
                  sourceLineageHeads.nativeAddress,
                  sourceLineageHeads.coverageId,
                ],
                set: { sourceRecordId },
              })
              .run();
          }
          const submission: MetadataRefreshSubmission = {
            assetId: proposal.subjectId,
            sourceAssociation: successor,
            sourceRecords: [],
            expectedLineageHeads: [],
            interpretation: selectedCandidate!.interpretation,
          };
          this.insertRefreshMetadataWithDrizzle(transaction, submission);
          this.insertRefreshRelationshipsWithDrizzle(transaction, submission);
          this.insertRefreshMentionsWithDrizzle(transaction, submission);
        }
        if (proposal.kind === "replace") {
          transaction
            .insert(sourceAssociationSupersessions)
            .values({
              id: `source-association-supersession:${input.decision.id}`,
              predecessorAssociationId: proposal.predecessorAssociationId,
              successorAssociationId: proposal.successor.id,
              sourceAssociationDecisionId: input.decision.id,
            })
            .run();
        } else if (proposal.kind === "retract") {
          transaction
            .insert(sourceAssociationRetractions)
            .values({
              id: `source-association-retraction:${input.decision.id}`,
              associationId: proposal.predecessorAssociationId,
              sourceAssociationDecisionId: input.decision.id,
            })
            .run();
        }
        if (proposal.kind !== "establish") {
          transaction
            .delete(currentSourceAssociations)
            .where(
              and(
                eq(currentSourceAssociations.subjectId, proposal.subjectId),
                eq(
                  currentSourceAssociations.associationId,
                  proposal.predecessorAssociationId,
                ),
              ),
            )
            .run();
          this.retractArtifactsLosingLastSupportWithDrizzle(
            transaction,
            proposal.predecessorAssociationId,
            proposal.id,
          );
        }
        if (execution?.status === "running")
          this.finishChangeImpactExecutionWithDrizzle(
            transaction,
            execution,
            "applied",
          );
        transaction
          .update(changeImpactPreviews)
          .set({
            previewJson: JSON.stringify({ ...preview, status: "applied" }),
          })
          .where(eq(changeImpactPreviews.id, preview.id))
          .run();
        result = "applied";
      },
      { behavior: "immediate" },
    );
    return result;
  }

  private retractArtifactsLosingLastSupportWithDrizzle(
    transaction: DrizzleWriteTransaction,
    sourceAssociationId: string,
    proposalId: string,
  ): void {
    const associations = transaction
      .select({
        id: artifactAssociations.id,
        sourceRecordIdsJson: artifactAssociations.sourceRecordIdsJson,
      })
      .from(artifactAssociations)
      .where(eq(artifactAssociations.sourceAssociationId, sourceAssociationId))
      .all();
    for (const association of associations) {
      const hasRecognitionSupport = transaction
        .select({
          id: artifactAssociationRecognitionSupports.recognitionDecisionId,
        })
        .from(artifactAssociationRecognitionSupports)
        .where(
          eq(
            artifactAssociationRecognitionSupports.associationId,
            association.id,
          ),
        )
        .all()
        .some(
          ({ id: decisionId }) =>
            transaction
              .select({
                id: recognitionDecisionSupersessions.predecessorDecisionId,
              })
              .from(recognitionDecisionSupersessions)
              .where(
                eq(
                  recognitionDecisionSupersessions.predecessorDecisionId,
                  decisionId,
                ),
              )
              .get() === undefined &&
            transaction
              .select({
                id: recognitionDecisionRetractions.predecessorDecisionId,
              })
              .from(recognitionDecisionRetractions)
              .where(
                eq(
                  recognitionDecisionRetractions.predecessorDecisionId,
                  decisionId,
                ),
              )
              .get() === undefined,
        );
      if (hasRecognitionSupport) continue;
      transaction
        .insert(artifactAssociationRetractions)
        .values({
          id: `artifact-association-retraction:${proposalId}:${association.id}`,
          associationId: association.id,
          proposalId,
          sourceRecordIdsJson: association.sourceRecordIdsJson,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  /**
   * 点名决定撤回后失去最后一个有效支持的本地关联：还有其他生效决定授权的关联保持
   * 当前，绝不因为一份范围结束就把整批材料撤回。
   */
  private retractAssociationsLosingDecisionSupportWithDrizzle(
    transaction: DrizzleWriteTransaction,
    decisionId: string,
    proposalId: string,
  ): void {
    const associations = transaction
      .select({
        id: artifactAssociations.id,
        sourceRecordIdsJson: artifactAssociations.sourceRecordIdsJson,
      })
      .from(artifactAssociations)
      .innerJoin(
        artifactAssociationRecognitionSupports,
        eq(
          artifactAssociationRecognitionSupports.associationId,
          artifactAssociations.id,
        ),
      )
      .where(
        eq(
          artifactAssociationRecognitionSupports.recognitionDecisionId,
          decisionId,
        ),
      )
      .all();
    for (const association of associations) {
      const otherSupports = transaction
        .select({
          decisionId:
            artifactAssociationRecognitionSupports.recognitionDecisionId,
        })
        .from(artifactAssociationRecognitionSupports)
        .where(
          and(
            eq(
              artifactAssociationRecognitionSupports.associationId,
              association.id,
            ),
            ne(
              artifactAssociationRecognitionSupports.recognitionDecisionId,
              decisionId,
            ),
          ),
        )
        .all()
        .flatMap(({ decisionId: other }) => (other === null ? [] : [other]));
      if (
        this.recognitionDecisionEndingsWithDrizzle(transaction, otherSupports)
          .size < otherSupports.length
      )
        continue;
      transaction
        .insert(artifactAssociationRetractions)
        .values({
          id: `artifact-association-retraction:${proposalId}:${association.id}`,
          associationId: association.id,
          proposalId,
          sourceRecordIdsJson: association.sourceRecordIdsJson,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  async applyRecognitionRetractionPreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly confirmedBy: string;
  }): Promise<"applied" | "stale"> {
    const database = await this.ensure();
    let result: "applied" | "stale" = "stale";
    drizzle({ client: database }).transaction(
      (transaction) => {
        const row = transaction
          .select({ previewJson: changeImpactPreviews.previewJson })
          .from(changeImpactPreviews)
          .where(eq(changeImpactPreviews.id, input.preview.id))
          .get();
        if (row === undefined) return;
        const preview = JSON.parse(row.previewJson) as ChangeImpactPreview;
        if (preview.status !== "awaiting-confirmation") return;
        if (
          preview.version !== "change-impact-preview/2" ||
          preview.change?.kind !== "recognition-retraction" ||
          preview.blockingConditions.length > 0
        )
          throw new Error("Recognition retraction preview is not applicable");
        const intent = preview.change.intent;
        const waitingExecution =
          this.workflowExecutionPersistence.readExecutionWithDrizzle(
            transaction,
            preview.executionId,
          );
        const expectedProjection = preview.baselines.find(
          ({ key }) => key === "complete-current-projection",
        )?.value;
        const expectedScope = preview.baselines.find(
          ({ key }) => key === "recognition-scope-declarations",
        )?.value;
        const expectedScopeDecisions = preview.baselines.find(
          ({ key }) => key === "recognition-scope-decision-ids",
        )?.value;
        const scopeDecisionIds =
          expectedScopeDecisions === undefined
            ? undefined
            : (JSON.parse(expectedScopeDecisions) as readonly string[]);
        const head = transaction
          .select()
          .from(recognitionHeads)
          .where(eq(recognitionHeads.subjectId, preview.assetId))
          .get();
        // 点名任一有效决定都能撤回：主决定撤回清空头，追加撤回只结束自身范围。
        const withdrawsHead =
          head?.recognitionDecisionId === intent.predecessorDecisionId;
        const declarations = groupMaterialScopeDeclarations(
          this.effectiveMaterialBoundariesWithDrizzle(
            transaction,
            preview.assetId,
          ),
          {
            headDecisionIds:
              head?.recognitionDecisionId === null ||
              head === undefined ||
              head.recognitionDecisionId === undefined
                ? []
                : [head.recognitionDecisionId],
          },
        );
        const namedDeclaration = declarations.find(
          (declaration) =>
            declaration.decisionId === intent.predecessorDecisionId,
        );
        const scopeBaseline =
          namedDeclaration === undefined
            ? undefined
            : JSON.stringify(
                materialScopeDeclarationBaseline(
                  declarations.filter((declaration) =>
                    materialScopeDeclarationsIntersect(
                      declaration,
                      namedDeclaration,
                    ),
                  ),
                ),
              );
        if (
          head === undefined ||
          namedDeclaration === undefined ||
          expectedProjection === undefined ||
          this.currentChangeImpactBaselineWithDrizzle(
            transaction,
            preview.assetId,
            scopeDecisionIds,
          ) !== expectedProjection ||
          (expectedScope !== undefined && expectedScope !== scopeBaseline)
        ) {
          if (waitingExecution?.status === "running")
            this.finishChangeImpactExecutionWithDrizzle(
              transaction,
              waitingExecution,
              "stale",
            );
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({ ...preview, status: "stale" }),
            })
            .where(eq(changeImpactPreviews.id, preview.id))
            .run();
          return;
        }
        const retractionId = `recognition-decision-retraction:${preview.id}`;
        transaction
          .insert(recognitionDecisionRetractions)
          .values({
            id: retractionId,
            predecessorDecisionId: intent.predecessorDecisionId,
            proposedBy: intent.proposedBy,
            decidedBy: input.confirmedBy,
            reason: intent.reason,
          })
          .run();
        if (withdrawsHead && head.recognitionSourceAssociationId !== null) {
          const established = transaction
            .select()
            .from(sourceAssociationEstablishmentSupports)
            .where(
              and(
                eq(
                  sourceAssociationEstablishmentSupports.associationId,
                  head.recognitionSourceAssociationId,
                ),
                eq(
                  sourceAssociationEstablishmentSupports.recognitionDecisionId,
                  intent.predecessorDecisionId,
                ),
              ),
            )
            .get();
          if (established !== undefined) {
            transaction
              .insert(sourceAssociationRetractions)
              .values({
                id: `source-association-retraction:${retractionId}`,
                associationId: head.recognitionSourceAssociationId,
                recognitionDecisionRetractionId: retractionId,
              })
              .run();
            transaction
              .delete(currentSourceAssociations)
              .where(
                and(
                  eq(currentSourceAssociations.subjectId, preview.assetId),
                  eq(
                    currentSourceAssociations.associationId,
                    head.recognitionSourceAssociationId,
                  ),
                ),
              )
              .run();
            this.retractArtifactsLosingLastSupportWithDrizzle(
              transaction,
              head.recognitionSourceAssociationId,
              preview.id,
            );
          }
        }
        if (withdrawsHead)
          transaction
            .update(recognitionHeads)
            .set({
              recognitionDecisionId: null,
              recognitionSourceAssociationId: null,
            })
            .where(eq(recognitionHeads.subjectId, preview.assetId))
            .run();
        // 结束被点名决定的支持：只有因此失去最后一个有效支持的关联才退出。
        this.retractAssociationsLosingDecisionSupportWithDrizzle(
          transaction,
          intent.predecessorDecisionId,
          retractionId,
        );
        if (waitingExecution?.status === "running")
          this.finishChangeImpactExecutionWithDrizzle(
            transaction,
            waitingExecution,
            "applied",
          );
        transaction
          .update(changeImpactPreviews)
          .set({
            previewJson: JSON.stringify({ ...preview, status: "applied" }),
          })
          .where(eq(changeImpactPreviews.id, preview.id))
          .run();
        result = "applied";
      },
      { behavior: "immediate" },
    );
    return result;
  }

  /**
   * 确认一次明确范围决定：先按冻结的完整范围声明基线、当前投影与点名决定的生效状态
   * 做范围局部比较，任何变化都只让预演过期；通过后才原子写入新决定、取代与支持。
   */
  async applyRecognitionScopeAmendmentPreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly plan: RecognitionScopeAmendmentPlan;
  }): Promise<"applied" | "stale"> {
    const database = await this.ensure();
    let result: "applied" | "stale" = "stale";
    drizzle({ client: database }).transaction(
      (transaction) => {
        const row = transaction
          .select({ previewJson: changeImpactPreviews.previewJson })
          .from(changeImpactPreviews)
          .where(eq(changeImpactPreviews.id, input.preview.id))
          .get();
        if (row === undefined) return;
        const preview = JSON.parse(row.previewJson) as ChangeImpactPreview;
        if (preview.status !== "awaiting-confirmation") return;
        if (
          preview.version !== "change-impact-preview/2" ||
          preview.change?.kind !== "recognition-scope-amendment" ||
          preview.blockingConditions.length > 0
        )
          throw new Error(
            "Recognition scope amendment preview is not applicable",
          );
        const change = preview.change;
        const plan = input.plan;
        const predecessorDecisionId = preview.baselines.find(
          ({ key }) => key === "recognition-decision",
        )?.value;
        if (
          predecessorDecisionId === undefined ||
          plan.successorDecision.id !== change.successorDecisionId ||
          plan.successorDecision.proposalId !== change.proposal.id ||
          plan.successorDecision.assetId !== preview.assetId ||
          JSON.stringify(plan.successorDecision.boundaries) !==
            JSON.stringify(change.proposal.boundaries) ||
          JSON.stringify(plan.successorDecision.acceptedRuleResults) !==
            JSON.stringify(change.proposal.ruleResults) ||
          plan.supersession.successorDecisionId !== plan.successorDecision.id ||
          plan.supersession.predecessorDecisionId !==
            change.predecessorDecisionId
        )
          throw new Error("Recognition scope amendment plan is inconsistent");
        const waitingExecution =
          this.workflowExecutionPersistence.readExecutionWithDrizzle(
            transaction,
            preview.executionId,
          );
        const head = transaction
          .select()
          .from(recognitionHeads)
          .where(eq(recognitionHeads.subjectId, preview.assetId))
          .get();
        // 同一完整范围重查：被点名决定必须仍然生效，相交集合必须逐字一致。
        const declarations = this.materialScopeDeclarationsWithDrizzle(
          transaction,
          plan.scopeAddress,
        );
        const namedDeclaration = declarations.find(
          (declaration) => declaration.decisionId === predecessorDecisionId,
        );
        const scopeBaseline =
          namedDeclaration === undefined
            ? undefined
            : JSON.stringify(
                materialScopeDeclarationBaseline(
                  declarations.filter((declaration) =>
                    materialScopeDeclarationsIntersect(
                      declaration,
                      namedDeclaration,
                    ),
                  ),
                ),
              );
        const expectedProjection = preview.baselines.find(
          ({ key }) => key === "complete-current-projection",
        )?.value;
        const expectedScope = preview.baselines.find(
          ({ key }) => key === "recognition-scope-declarations",
        )?.value;
        const expectedScopeDecisions = preview.baselines.find(
          ({ key }) => key === "recognition-scope-decision-ids",
        )?.value;
        const scopeDecisionIds =
          expectedScopeDecisions === undefined
            ? undefined
            : (JSON.parse(expectedScopeDecisions) as readonly string[]);
        if (
          head === undefined ||
          namedDeclaration?.status !== "effective" ||
          expectedProjection === undefined ||
          this.currentChangeImpactBaselineWithDrizzle(
            transaction,
            preview.assetId,
            scopeDecisionIds,
          ) !== expectedProjection ||
          (expectedScope !== undefined && expectedScope !== scopeBaseline)
        ) {
          if (waitingExecution?.status === "running")
            this.finishChangeImpactExecutionWithDrizzle(
              transaction,
              waitingExecution,
              "stale",
            );
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({ ...preview, status: "stale" }),
            })
            .where(eq(changeImpactPreviews.id, preview.id))
            .run();
          return;
        }
        result = this.writeRecognitionScopeAmendmentWithDrizzle(transaction, {
          preview,
          plan,
          predecessorDecisionId,
          amendsHead: head.recognitionDecisionId === predecessorDecisionId,
          headDecisionId: head.recognitionDecisionId,
          headAssociationId: head.recognitionSourceAssociationId,
          ...(waitingExecution === undefined ? {} : { waitingExecution }),
        });
      },
      { behavior: "immediate" },
    );
    return result;
  }

  /**
   * 范围修订的原子写入：新决定带着自己的完整边界落库并取代被点名的决定，主头只在被点名的就是主头时
   * 前进；追加不另造身份，只把自身授权与那次观察的证据加到关联支持上。
   */
  private writeRecognitionScopeAmendmentWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly preview: ChangeImpactPreview;
      readonly plan: RecognitionScopeAmendmentPlan;
      readonly predecessorDecisionId: string;
      readonly amendsHead: boolean;
      readonly headDecisionId: string | null;
      readonly headAssociationId: string | null;
      readonly waitingExecution?: WorkflowExecution;
    },
  ): "applied" | "stale" {
    const { preview, plan } = input;
    if (preview.change?.kind !== "recognition-scope-amendment")
      throw new Error("Recognition scope amendment preview is not applicable");
    // 主头为空时，被点名的生效决定本身就是这次写入的事实依据；头保持为空。
    const headDecision = transaction
      .select()
      .from(recognitionDecisions)
      .where(
        eq(
          recognitionDecisions.id,
          input.headDecisionId ?? input.predecessorDecisionId,
        ),
      )
      .get();
    if (headDecision === undefined)
      throw new Error("Recognition scope amendment lacks a durable head");
    transaction
      .insert(recognitionDecisions)
      .values({
        id: plan.successorDecision.id,
        proposalId: plan.successorDecision.proposalId,
        assetId: plan.successorDecision.assetId,
        acceptedRuleResultsJson: JSON.stringify(
          plan.successorDecision.acceptedRuleResults,
        ),
        boundariesJson: JSON.stringify(plan.successorDecision.boundaries),
      })
      .run();
    transaction
      .insert(recognitionDecisionSupersessions)
      .values({ ...plan.supersession })
      .run();
    if (input.amendsHead) {
      const advanced = transaction
        .update(recognitionHeads)
        .set({ recognitionDecisionId: plan.successorDecision.id })
        .where(
          and(
            eq(recognitionHeads.subjectId, preview.assetId),
            // amendsHead 为真即主头正是被点名的前驱决定，比较前驱 ID 等价且非空。
            eq(
              recognitionHeads.recognitionDecisionId,
              input.predecessorDecisionId,
            ),
            input.headAssociationId === null
              ? isNull(recognitionHeads.recognitionSourceAssociationId)
              : eq(
                  recognitionHeads.recognitionSourceAssociationId,
                  input.headAssociationId,
                ),
          ),
        )
        .run();
      // 立即事务已串行化写入者；条件不成立说明身份被并发改动，回滚不留半个决定。
      if (advanced.changes !== 1)
        throw new Error("识别范围修订确认时当前身份已经变化");
    }
    const headProposal = this.readProposalWithDrizzle(
      transaction,
      headDecision.proposalId,
    );
    if (headProposal === undefined)
      throw new Error(
        "Recognition scope amendment predecessor lacks a durable proposal",
      );
    const association =
      input.headAssociationId === null
        ? undefined
        : transaction
            .select({
              id: sourceAssociations.id,
              subjectId: sourceAssociations.subjectId,
              sourceIdentity: sourceAssociations.sourceIdentity,
              nativeAddress: sourceAssociations.nativeAddress,
            })
            .from(sourceAssociations)
            .where(eq(sourceAssociations.id, input.headAssociationId))
            .get();
    const recognitionDecision = (
      id: string,
      proposalId: string,
      boundariesJson: string,
      acceptedRuleResultsJson: string,
    ): RecognitionDecision => ({
      id,
      proposalId,
      assetId: preview.assetId,
      boundaries: JSON.parse(
        boundariesJson,
      ) as RecognitionDecision["boundaries"],
      acceptedRuleResults: JSON.parse(
        acceptedRuleResultsJson,
      ) as RecognitionDecision["acceptedRuleResults"],
    });
    const currentAccepted: AcceptedRecognition = {
      proposal: headProposal,
      entity: { id: preview.assetId, kind: "digital-asset" },
      sourceAssociations: association === undefined ? [] : [association],
      ...(association === undefined
        ? {}
        : { recognitionSourceAssociation: association }),
      recognitionDecision: recognitionDecision(
        headDecision.id,
        headDecision.proposalId,
        headDecision.boundariesJson,
        headDecision.acceptedRuleResultsJson,
      ),
      metadata: preview.current.metadata,
      entities: preview.current.entities,
      entityMentions: preview.current.entityMentions,
      entityResolutionDecisions: preview.current.entityResolutionDecisions,
      relationships: preview.current.relationships,
      artifacts: preview.current.artifacts,
      locations: preview.current.locations,
      blobs: preview.current.blobs,
      artifactRevisions: preview.current.artifactRevisions,
      artifactAssociations: preview.current.artifactAssociations,
    };
    const nextAccepted: AcceptedRecognition = {
      proposal: preview.change.proposal,
      entity: { id: preview.assetId, kind: "digital-asset" },
      sourceAssociations: association === undefined ? [] : [association],
      ...(association === undefined
        ? {}
        : { recognitionSourceAssociation: association }),
      recognitionDecision: plan.successorDecision,
      metadata: preview.projected.metadata,
      entities: preview.projected.entities,
      entityMentions: preview.projected.entityMentions,
      entityResolutionDecisions: preview.projected.entityResolutionDecisions,
      relationships: preview.projected.relationships,
      artifacts: preview.projected.artifacts,
      locations: preview.projected.locations,
      blobs: preview.projected.blobs,
      artifactRevisions: preview.projected.artifactRevisions,
      artifactAssociations: preview.projected.artifactAssociations,
      ...(preview.projectedObservedEntityGraphs === undefined
        ? {}
        : { observedEntityGraphs: preview.projectedObservedEntityGraphs }),
    };
    this.insertReevaluatedArtifactFactsWithDrizzle(
      transaction,
      currentAccepted,
      nextAccepted,
    );
    if (input.waitingExecution !== undefined)
      this.applyAppliedPreviewMaterialBindingsWithDrizzle(
        transaction,
        input.waitingExecution,
        {
          ...preview,
          status: "applied",
        },
      );
    this.writeLocalAssociationSupportsWithDrizzle(transaction, nextAccepted);
    this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
      preview.assetId,
    ]);
    if (input.waitingExecution?.status === "running")
      this.finishChangeImpactExecutionWithDrizzle(
        transaction,
        input.waitingExecution,
        "applied",
      );
    transaction
      .update(changeImpactPreviews)
      .set({
        previewJson: JSON.stringify({ ...preview, status: "applied" }),
      })
      .where(eq(changeImpactPreviews.id, preview.id))
      .run();
    return "applied";
  }

  /**
   * 人工封面决定不属于任何工作流执行：这份预演自身就是它的耐久因果记录。
   */
  async saveArtifactRoleDecisionPreview(
    preview: ChangeImpactPreview,
  ): Promise<void> {
    if (
      preview.version !== "change-impact-preview/2" ||
      preview.change?.kind !== "artifact-role-decision"
    )
      throw new Error("人工封面决定需要一份精确的 V2 预演");
    const decision = preview.change.decision;
    validateArtifactRoleDecision(decision);
    if (
      decision.target.kind === "entity" &&
      decision.target.entityId !== preview.assetId
    )
      throw new Error("人工封面决定的目标实体与预演主体不一致");
    if (
      decision.predecessorDecisionId !==
      (preview.change.expectedHeadDecisionId ?? undefined)
    )
      throw new Error("人工封面决定缺少指向当前头的后继链");
    const database = await this.ensure();
    drizzle({ client: database })
      .insert(changeImpactPreviews)
      .values({
        id: preview.id,
        executionId: preview.executionId,
        assetId: preview.assetId,
        previewJson: JSON.stringify(preview),
      })
      .run();
  }

  /**
   * 在同一事务内比较冻结候选、政策版本、资产完整事实基线与坐标当前头，全部成立才
   * 追加决定并以前进头 CAS 落地；任何一项变化只把预演置为过期，零决定副作用。
   */
  async applyArtifactRoleDecisionPreview(input: {
    readonly preview: ChangeImpactPreview;
    readonly confirmedBy: string;
    readonly currentCandidateBaseline: string | null;
    readonly policyVersion: string;
  }): Promise<"applied" | "stale"> {
    const database = await this.ensure();
    let result: "applied" | "stale" = "stale";
    drizzle({ client: database }).transaction(
      (transaction) => {
        const row = transaction
          .select({ previewJson: changeImpactPreviews.previewJson })
          .from(changeImpactPreviews)
          .where(eq(changeImpactPreviews.id, input.preview.id))
          .get();
        if (row === undefined) return;
        const preview = JSON.parse(row.previewJson) as ChangeImpactPreview;
        // 已 applied 或已 stale 的预演重放只返回既有结果，绝不重复追加决定。
        if (preview.status !== "awaiting-confirmation") return;
        if (
          preview.version !== "change-impact-preview/2" ||
          preview.change?.kind !== "artifact-role-decision" ||
          preview.blockingConditions.length > 0
        )
          throw new Error("Artifact role decision preview is not applicable");
        const decision = preview.change.decision;
        const targetKey = artifactRoleDecisionKey(
          decision.target,
          decision.role,
        );
        const baseline = (key: string) =>
          preview.baselines.find((item) => item.key === key)?.value;
        const head = transaction
          .select({ decisionId: artifactRoleDecisionHeads.decisionId })
          .from(artifactRoleDecisionHeads)
          .where(eq(artifactRoleDecisionHeads.targetKey, targetKey))
          .get();
        const currentHeadDecisionId = head?.decisionId ?? null;
        if (
          baseline("complete-current-projection") === undefined ||
          this.currentChangeImpactBaselineWithDrizzle(
            transaction,
            preview.assetId,
          ) !== baseline("complete-current-projection") ||
          currentHeadDecisionId !== preview.change.expectedHeadDecisionId ||
          baseline("artifact-role-decision-head") !==
            (currentHeadDecisionId ?? "none") ||
          input.currentCandidateBaseline !==
            baseline("artifact-role-candidates") ||
          input.policyVersion !== baseline("artifact-role-policy-version")
        ) {
          transaction
            .update(changeImpactPreviews)
            .set({
              previewJson: JSON.stringify({ ...preview, status: "stale" }),
            })
            .where(eq(changeImpactPreviews.id, preview.id))
            .run();
          return;
        }
        transaction
          .insert(artifactRoleDecisions)
          .values(artifactRoleDecisionRow(decision))
          .run();
        const moved =
          preview.change.expectedHeadDecisionId === null
            ? transaction
                .insert(artifactRoleDecisionHeads)
                .values({ targetKey, decisionId: decision.id })
                .onConflictDoNothing()
                .run()
            : transaction
                .update(artifactRoleDecisionHeads)
                .set({ decisionId: decision.id })
                .where(
                  and(
                    eq(artifactRoleDecisionHeads.targetKey, targetKey),
                    eq(
                      artifactRoleDecisionHeads.decisionId,
                      preview.change.expectedHeadDecisionId,
                    ),
                  ),
                )
                .run();
        // 头被他人抢先推进时整体回滚：这一坐标至多一个预演能成功。
        if (moved.changes !== 1)
          throw new Error("Artifact role decision head moved concurrently");
        this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
          preview.assetId,
        ]);
        transaction
          .update(changeImpactPreviews)
          .set({
            previewJson: JSON.stringify({ ...preview, status: "applied" }),
          })
          .where(eq(changeImpactPreviews.id, preview.id))
          .run();
        result = "applied";
      },
      { behavior: "immediate" },
    );
    return result;
  }

  /**
   * 仅用于夹具设置。产品代码必须使用 `createAutomationIntentForObservedRoot`，
   * 使根授权与意图创建共享同一个事务。
   */
  async createAutomationIntentForTesting(
    intent: AutomationIntent,
  ): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        transaction
          .insert(automationIntents)
          .values({
            id: intent.id,
            scopeJson: JSON.stringify(intent.scope),
            enabled: intent.enabled ? 1 : 0,
            disabledReason: intent.disabledReason ?? null,
            intervalMilliseconds: intent.intervalMilliseconds,
            workflowInputVersion: intent.workflowInputVersion,
            runInitial: intent.runInitial ? 1 : 0,
            policyReferencesJson: JSON.stringify(intent.policyReferences),
            acceptTrusted: intent.acceptTrusted ? 1 : 0,
          })
          .run();
        transaction
          .insert(automationRuntime)
          .values({
            intentId: intent.id,
            activeExecutionId: null,
            lastAutomaticTriggerAt: null,
          })
          .run();
      },
      { behavior: "immediate" },
    );
  }

  async createAutomationIntentForObservedRoot(input: {
    readonly intent: AutomationIntent;
    readonly authorization: AutomationObservedRootAuthorization;
  }): Promise<AutomationIntentCreationResult> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    let result: AutomationIntentCreationResult = { status: "root-unavailable" };
    query.transaction(
      (transaction) => {
        let registrations: readonly ObservedRootRegistration[];
        try {
          registrations = transaction
            .select()
            .from(observedRootRegistrations)
            .all()
            .map(observedRootRegistrationFromDrizzle);
        } catch {
          // 格式错误的持久根必须以关闭方式失败，不能让它成为新周期配置的权威。
          return;
        }
        const index = createObservedRootAuthorityIndex(registrations);
        if (
          !isPersistableAutomationIntent(input.intent) ||
          !isAutomationObservedRootAuthorizationCurrent({
            scope: input.intent.scope,
            authorization: input.authorization,
            index,
          })
        ) {
          return;
        }
        // 周期计划必须有本库目录授权账目支撑：全局根仍 active 不足以证明本库允许该目录
        // 参与自动观察，共享同一物理根的其他库也不能替它续权。
        const library = transaction
          .select({ status: assetLibraries.status })
          .from(assetLibraries)
          .where(eq(assetLibraries.id, input.intent.scope.assetLibraryId))
          .get();
        const grant = transaction
          .select({ id: libraryDirectoryGrants.id })
          .from(libraryDirectoryGrants)
          .where(
            and(
              eq(
                libraryDirectoryGrants.libraryId,
                input.intent.scope.assetLibraryId,
              ),
              eq(
                libraryDirectoryGrants.observedRootId,
                input.intent.scope.observedRootId,
              ),
              eq(libraryDirectoryGrants.status, "active"),
            ),
          )
          .get();
        if (library?.status !== "active" || grant === undefined) return;
        transaction
          .insert(automationIntents)
          .values({
            id: input.intent.id,
            scopeJson: JSON.stringify(input.intent.scope),
            enabled: input.intent.enabled ? 1 : 0,
            disabledReason: input.intent.disabledReason ?? null,
            intervalMilliseconds: input.intent.intervalMilliseconds,
            workflowInputVersion: input.intent.workflowInputVersion,
            runInitial: input.intent.runInitial ? 1 : 0,
            policyReferencesJson: JSON.stringify(input.intent.policyReferences),
            acceptTrusted: input.intent.acceptTrusted ? 1 : 0,
          })
          .run();
        transaction
          .insert(automationRuntime)
          .values({
            intentId: input.intent.id,
            activeExecutionId: null,
            lastAutomaticTriggerAt: null,
          })
          .run();
        result = { status: "created" };
      },
      { behavior: "immediate" },
    );
    return result;
  }

  async createObservedRootRegistration(
    registration: ObservedRootRegistration,
  ): Promise<void> {
    const database = await this.ensure();
    drizzle({ client: database })
      .insert(observedRootRegistrations)
      .values(observedRootRegistrationToDrizzle(registration))
      .run();
  }

  async listAssetLibraries(): Promise<readonly AssetLibrary[]> {
    const database = await this.ensure();
    return drizzle({ client: database })
      .select()
      .from(assetLibraries)
      .orderBy(asc(assetLibraries.id))
      .all()
      .map(assetLibraryFromDrizzle);
  }

  async getAssetLibrary(id: string): Promise<AssetLibrary | undefined> {
    const database = await this.ensure();
    const row = drizzle({ client: database })
      .select()
      .from(assetLibraries)
      .where(eq(assetLibraries.id, id))
      .get();
    return row === undefined ? undefined : assetLibraryFromDrizzle(row);
  }

  async saveAssetLibrary(
    save: AssetLibrarySave,
  ): Promise<AssetLibrarySaveReceipt | undefined> {
    const database = await this.ensure();
    return drizzle({ client: database }).transaction(
      (transaction) => {
        const previous = transaction
          .select()
          .from(assetLibraries)
          .where(eq(assetLibraries.id, save.id))
          .get();
        if (save.expectedVersion === undefined) {
          if (previous !== undefined) return undefined;
        } else if (previous?.configVersion !== save.expectedVersion)
          return undefined;
        const previousRootIds =
          previous === undefined
            ? []
            : (JSON.parse(previous.rootIdsJson) as readonly string[]);
        const previousGrants = transaction
          .select()
          .from(libraryDirectoryGrants)
          .where(eq(libraryDirectoryGrants.libraryId, save.id))
          .all()
          .map(libraryDirectoryGrantFromDrizzle);
        // 失效坐标只描述本库授权的变化；共享同一物理根的其他库不出现在这里。
        // keepVersion 是本笔事务提交后仍然成立的活动授权版本：执行服务据此取消更早代次的
        // 操作并放行这一新代次的新绑定；removed 不带版本，表示该坐标当前没有任何可绑定授权。
        const invalidations = new Map<string, LibraryDirectoryInvalidation>();
        const invalidate = (
          observedRootId: string,
          keepVersion?: number,
        ): void => {
          invalidations.set(observedRootId, {
            assetLibraryId: save.id,
            observedRootId,
            ...(keepVersion === undefined ? {} : { keepVersion }),
          });
        };
        let rootIds = previousRootIds;
        if (save.directories !== undefined) {
          const registrations = transaction
            .select()
            .from(observedRootRegistrations)
            .all()
            .map(observedRootRegistrationFromDrizzle);
          const registrationById = new Map(
            registrations.map((item) => [item.id, item]),
          );
          for (const directory of save.directories) {
            const retained = previousGrants.find(
              (grant) =>
                grant.status === "removed" &&
                registrationById.get(grant.observedRootId)?.canonicalPath ===
                  directory.canonicalPath,
            );
            // 保留的 removed 关系只能由点名它的显式重连接管：重复添加同一路径不能把旧
            // 授权或旧执行悄悄救活。
            if (retained !== undefined)
              throw new Error(
                "该目录此前已从本资产库移除，请使用重新连接而不是重复添加",
              );
          }
          const activeRoots = registrations
            .filter((item) => item.status === "active")
            .map((item) => ({
              id: item.id,
              canonicalPath: item.canonicalPath,
            }));
          const grantByRootId = new Map(
            previousGrants.map((grant) => [grant.observedRootId, grant]),
          );
          // R7/F3 依赖闭包失效：本次被移除或链接授权改变的 grant 是失效种子，新增 grant 不参与
          // 复核（它没有先前执行可冻结）。种子之下所有本库活动 grant 的传递跟随闭包都要一并失效。
          const closureSeeds = new Set<string>();
          const insertedGrantIds = new Set<string>();
          const pending = save.directories.map((directory) => {
            const reused = activeRoots.find(
              (root) => root.canonicalPath === directory.canonicalPath,
            );
            if (reused !== undefined) return { directory, rootId: reused.id };
            const registration: ObservedRootRegistration = {
              id: `observed_root_${randomUUID()}`,
              displayName: directory.displayName,
              containerPath: directory.containerPath,
              canonicalPath: directory.canonicalPath,
              status: "active",
              configVersion: 1,
              readOnly: true,
              symlinkMode: directory.symlinkMode,
              allowedTargetRootIds: [],
            };
            transaction
              .insert(observedRootRegistrations)
              .values(observedRootRegistrationToDrizzle(registration))
              .run();
            activeRoots.push({
              id: registration.id,
              canonicalPath: registration.canonicalPath,
            });
            return { directory, rootId: registration.id };
          });
          const entries = pending.map((entry) => ({
            ...entry,
            grantId:
              grantByRootId.get(entry.rootId)?.id ??
              `library_directory_grant_${randomUUID()}`,
          }));
          const grantIdByCanonicalPath = new Map(
            entries.map((entry) => [
              entry.directory.canonicalPath,
              entry.grantId,
            ]),
          );
          for (const entry of entries) {
            const directory = entry.directory;
            const targetGrantIds = directory.allowedTargetCanonicalPaths
              .map((canonicalPath) => grantIdByCanonicalPath.get(canonicalPath))
              .filter((grantId): grantId is string => grantId !== undefined)
              .toSorted();
            const existing = grantByRootId.get(entry.rootId);
            if (existing === undefined) {
              transaction
                .insert(libraryDirectoryGrants)
                .values({
                  id: entry.grantId,
                  libraryId: save.id,
                  observedRootId: entry.rootId,
                  status: "active",
                  authorityVersion: 1,
                  symlinkMode: directory.symlinkMode,
                  allowedTargetGrantIdsJson: JSON.stringify(targetGrantIds),
                })
                .run();
              insertedGrantIds.add(entry.grantId);
              continue;
            }
            const unchanged =
              existing.symlinkMode === directory.symlinkMode &&
              JSON.stringify(existing.allowedTargetGrantIds) ===
                JSON.stringify(targetGrantIds);
            if (unchanged) continue;
            // 链接授权改变是明确的 I/O 撤销：权威版本推进，旧执行与打开的流被拒绝或关闭。
            const bumped = transaction
              .update(libraryDirectoryGrants)
              .set({
                symlinkMode: directory.symlinkMode,
                allowedTargetGrantIdsJson: JSON.stringify(targetGrantIds),
                authorityVersion: existing.authorityVersion + 1,
              })
              .where(
                and(
                  eq(libraryDirectoryGrants.id, existing.id),
                  eq(
                    libraryDirectoryGrants.authorityVersion,
                    existing.authorityVersion,
                  ),
                ),
              )
              .run();
            if (bumped.changes !== 1)
              throw new Error("该目录的授权已变更，请刷新后重试");
            closureSeeds.add(existing.id);
            invalidate(entry.rootId, existing.authorityVersion + 1);
          }
          rootIds = [
            ...new Set(pending.map((entry) => entry.rootId)),
          ].toSorted();
          for (const grant of previousGrants) {
            if (grant.status !== "active") continue;
            if (rootIds.includes(grant.observedRootId)) continue;
            // 目录移除只停本库授权并推进权威版本；物理根与历史一律保留到最后引用。
            const removed = transaction
              .update(libraryDirectoryGrants)
              .set({
                status: "removed",
                authorityVersion: grant.authorityVersion + 1,
              })
              .where(
                and(
                  eq(libraryDirectoryGrants.id, grant.id),
                  eq(
                    libraryDirectoryGrants.authorityVersion,
                    grant.authorityVersion,
                  ),
                ),
              )
              .run();
            if (removed.changes !== 1)
              throw new Error("该目录的授权已变更，请刷新后重试");
            closureSeeds.add(grant.id);
            invalidate(grant.observedRootId);
          }
          // 从失效种子出发求本库依赖闭包的传递不动点：任一活动授权把某个失效授权列入自己的跟随
          // 目标（直接或间接），其旧闭包就不再成立，必须与种子同样推进权威版本并登记失效坐标，
          // 令沿旧 S→T 闭包冻结的目录子在下一效果或提交时被持久拒绝。其他库的授权不在本库集合中，
          // 其独立授权不因此失效；本次新增 grant 没有先前执行可冻结，不参与推进。
          if (closureSeeds.size > 0) {
            const libraryGrants = transaction
              .select()
              .from(libraryDirectoryGrants)
              .where(eq(libraryDirectoryGrants.libraryId, save.id))
              .all()
              .map(libraryDirectoryGrantFromDrizzle);
            const byId = new Map(
              libraryGrants.map((grant) => [grant.id, grant]),
            );
            const dirty = new Set(closureSeeds);
            let grew = true;
            while (grew) {
              grew = false;
              for (const grant of libraryGrants) {
                if (grant.status !== "active" || dirty.has(grant.id)) continue;
                if (
                  grant.allowedTargetGrantIds.some((target) =>
                    dirty.has(target),
                  )
                ) {
                  dirty.add(grant.id);
                  grew = true;
                }
              }
            }
            for (const grantId of dirty) {
              if (closureSeeds.has(grantId)) continue;
              const grant = byId.get(grantId);
              if (
                grant === undefined ||
                grant.status !== "active" ||
                insertedGrantIds.has(grantId)
              )
                continue;
              const cascaded = transaction
                .update(libraryDirectoryGrants)
                .set({ authorityVersion: grant.authorityVersion + 1 })
                .where(
                  and(
                    eq(libraryDirectoryGrants.id, grant.id),
                    eq(
                      libraryDirectoryGrants.authorityVersion,
                      grant.authorityVersion,
                    ),
                  ),
                )
                .run();
              if (cascaded.changes !== 1)
                throw new Error("该目录的授权已变更，请刷新后重试");
              invalidate(grant.observedRootId, grant.authorityVersion + 1);
            }
          }
        }
        const row = {
          id: save.id,
          displayName: save.displayName,
          configVersion: save.configVersion,
          status: save.status,
          rootIdsJson: JSON.stringify(rootIds),
          recognitionProfileIdsJson: JSON.stringify(save.recognitionProfileIds),
          sourceIdentitiesJson: JSON.stringify(save.sourceIdentities),
        };
        const saved =
          save.expectedVersion === undefined
            ? transaction
                .insert(assetLibraries)
                .values(row)
                .onConflictDoNothing()
                .run().changes === 1
            : transaction
                .update(assetLibraries)
                .set(row)
                .where(
                  and(
                    eq(assetLibraries.id, row.id),
                    eq(assetLibraries.configVersion, save.expectedVersion),
                  ),
                )
                .run().changes === 1;
        if (!saved) return undefined;
        if (save.status !== "active")
          for (const grant of previousGrants) {
            if (grant.status !== "active") continue;
            const removed = transaction
              .update(libraryDirectoryGrants)
              .set({
                status: "removed",
                authorityVersion: grant.authorityVersion + 1,
              })
              .where(
                and(
                  eq(libraryDirectoryGrants.id, grant.id),
                  eq(
                    libraryDirectoryGrants.authorityVersion,
                    grant.authorityVersion,
                  ),
                ),
              )
              .run();
            if (removed.changes === 1) invalidate(grant.observedRootId);
          }
        // 同一物理目录仍可服务其他库；这里只停止已撤销的这个库的计划，并按真实原因分类：
        // 目录仍在、只是不再属于本库（或整库移除）是授权被撤销，范围本身读不出目录才是配置失效。
        const discontinued = new Map<
          "invalid-configuration" | "observed-root-revoked",
          string[]
        >();
        for (const intent of transaction
          .select({
            id: automationIntents.id,
            scopeJson: automationIntents.scopeJson,
          })
          .from(automationIntents)
          .where(
            sql`json_extract(${automationIntents.scopeJson}, '$.assetLibraryId') = ${save.id}`,
          )
          .all()) {
          const rootId = observedRootIdFromAutomationScope(intent.scopeJson);
          if (
            save.status === "active" &&
            rootId !== undefined &&
            rootIds.includes(rootId)
          )
            continue;
          const reason =
            rootId === undefined
              ? "invalid-configuration"
              : "observed-root-revoked";
          discontinued.set(reason, [
            ...(discontinued.get(reason) ?? []),
            intent.id,
          ]);
        }
        for (const [reason, intentIds] of discontinued)
          if (intentIds.length > 0)
            transaction
              .update(automationIntents)
              .set({ enabled: 0, disabledReason: reason })
              .where(inArray(automationIntents.id, sqliteTextSet(intentIds)))
              .run();
        for (const rootId of previousRootIds) {
          if (save.status === "active" && rootIds.includes(rootId)) continue;
          const rootRow = transaction
            .select()
            .from(observedRootRegistrations)
            .where(eq(observedRootRegistrations.id, rootId))
            .get();
          if (rootRow === undefined || rootRow.status !== "active") continue;
          const root = observedRootRegistrationFromDrizzle(rootRow);
          this.revokeObservedRootRegistrationWithDrizzle(transaction, {
            expectedVersion: root.configVersion,
            registration: {
              ...root,
              status: "revoked",
              configVersion: root.configVersion + 1,
            },
          });
        }
        return {
          library: {
            id: row.id,
            displayName: row.displayName,
            configVersion: row.configVersion,
            status: row.status,
            rootIds: [...rootIds],
            recognitionProfileIds: [...save.recognitionProfileIds],
            sourceIdentities: [...save.sourceIdentities],
          } satisfies AssetLibrary,
          invalidations: [...invalidations.values()],
        };
      },
      { behavior: "immediate" },
    );
  }

  async reconnectAssetLibraryDirectory(
    input: AssetLibraryDirectoryReconnect,
  ): Promise<AssetLibrarySaveReceipt | undefined> {
    const database = await this.ensure();
    return drizzle({ client: database }).transaction(
      (transaction) => {
        const library = transaction
          .select()
          .from(assetLibraries)
          .where(
            and(
              eq(assetLibraries.id, input.libraryId),
              eq(assetLibraries.status, "active"),
              eq(assetLibraries.configVersion, input.expectedConfigVersion),
            ),
          )
          .get();
        if (library === undefined) return undefined;
        const grant = transaction
          .select()
          .from(libraryDirectoryGrants)
          .where(eq(libraryDirectoryGrants.id, input.directoryId))
          .get();
        if (
          grant === undefined ||
          grant.libraryId !== input.libraryId ||
          grant.status !== "removed" ||
          grant.authorityVersion !== input.expectedAuthorityVersion
        )
          return undefined;
        const activated = transaction
          .update(libraryDirectoryGrants)
          .set({
            status: "active",
            authorityVersion: grant.authorityVersion + 1,
            awaitingObservation: 1,
          })
          .where(
            and(
              eq(libraryDirectoryGrants.id, grant.id),
              eq(
                libraryDirectoryGrants.authorityVersion,
                input.expectedAuthorityVersion,
              ),
              eq(libraryDirectoryGrants.status, "removed"),
            ),
          )
          .run();
        if (activated.changes !== 1) return undefined;
        // 末引用撤销的物理根与 grant 激活、库引用附接同属这一笔 immediate 事务：以 expected
        // 版本 + revoked 状态做 CAS 把根恢复为 active。规范路径在校验时已确认不变，这里只推进
        // 状态与版本；CAS 落空即整笔回滚，grant 保持 removed、库不附接、根保持 revoked，绝不
        // 留下「根已 active 但库/grant 未跟上」的半恢复。
        if (input.reactivateRegistration !== undefined) {
          const reactivated = transaction
            .update(observedRootRegistrations)
            .set({
              status: "active",
              configVersion: input.reactivateRegistration.expectedVersion + 1,
            })
            .where(
              and(
                eq(
                  observedRootRegistrations.id,
                  input.reactivateRegistration.observedRootId,
                ),
                eq(
                  observedRootRegistrations.configVersion,
                  input.reactivateRegistration.expectedVersion,
                ),
                eq(observedRootRegistrations.status, "revoked"),
              ),
            )
            .run();
          if (reactivated.changes !== 1) return undefined;
        }
        const rootIds = JSON.parse(library.rootIdsJson) as readonly string[];
        const replaced = transaction
          .update(assetLibraries)
          .set({
            rootIdsJson: JSON.stringify(
              [...new Set([...rootIds, grant.observedRootId])].toSorted(),
            ),
            configVersion: library.configVersion + 1,
          })
          .where(
            and(
              eq(assetLibraries.id, library.id),
              eq(assetLibraries.configVersion, input.expectedConfigVersion),
            ),
          )
          .run();
        if (replaced.changes !== 1) return undefined;
        // 重连给出新的权威版本：它不会让旧执行或已打开的来源复活，反而把它们的后续
        // 效果与提交持久拒绝。置位的 awaitingObservation 让本库经此根的历史 Location 在下
        // 一次完整授权观察前不进入本库 current 投影；同一物理根的其他库用自己的授权独立判定。
        return {
          library: assetLibraryFromDrizzle({
            ...library,
            configVersion: library.configVersion + 1,
            rootIdsJson: JSON.stringify(
              [...new Set([...rootIds, grant.observedRootId])].toSorted(),
            ),
          }),
          invalidations: [
            {
              assetLibraryId: input.libraryId,
              observedRootId: grant.observedRootId,
              // 重连提交后的新活动代次就是本库现行授权：旧冻结工作继续被拒，新的完整
              // 授权观察必须能够绑定这一代次。
              keepVersion: grant.authorityVersion + 1,
            },
          ],
        };
      },
      { behavior: "immediate" },
    );
  }

  async listLibraryDirectoryGrants(
    libraryId: string,
  ): Promise<readonly LibraryDirectoryGrant[]> {
    const database = await this.ensure();
    return drizzle({ client: database })
      .select()
      .from(libraryDirectoryGrants)
      .where(eq(libraryDirectoryGrants.libraryId, libraryId))
      .orderBy(asc(libraryDirectoryGrants.observedRootId))
      .all()
      .map(libraryDirectoryGrantFromDrizzle);
  }

  async getObservedRootRegistration(
    id: string,
  ): Promise<ObservedRootRegistration | undefined> {
    const database = await this.ensure();
    const row = drizzle({ client: database })
      .select()
      .from(observedRootRegistrations)
      .where(eq(observedRootRegistrations.id, id))
      .get();
    return row === undefined
      ? undefined
      : observedRootRegistrationFromDrizzle(row);
  }

  async listObservedRootRegistrations(): Promise<
    readonly ObservedRootRegistration[]
  > {
    const database = await this.ensure();
    return drizzle({ client: database })
      .select()
      .from(observedRootRegistrations)
      .orderBy(asc(sql<number>`${observedRootRegistrations}.rowid`))
      .all()
      .map(observedRootRegistrationFromDrizzle);
  }

  async listAuthorizedObservedRootRegistrations(): Promise<
    readonly ObservedRootRegistration[]
  > {
    const database = await this.ensure();
    return drizzle({ client: database })
      .select()
      .from(observedRootRegistrations)
      .where(
        and(
          eq(observedRootRegistrations.status, "active"),
          sql`EXISTS (SELECT 1 FROM ${assetLibraries}, json_each(${assetLibraries.rootIdsJson}) root WHERE ${assetLibraries.status} = 'active' AND root.value = ${observedRootRegistrations.id})`,
        ),
      )
      .all()
      .map(observedRootRegistrationFromDrizzle);
  }

  async replaceObservedRootRegistration(input: {
    readonly expectedVersion: number;
    readonly registration: ObservedRootRegistration;
  }): Promise<boolean> {
    const database = await this.ensure();
    const result = drizzle({ client: database })
      .update(observedRootRegistrations)
      .set(observedRootRegistrationToDrizzle(input.registration))
      .where(
        and(
          eq(observedRootRegistrations.id, input.registration.id),
          eq(observedRootRegistrations.configVersion, input.expectedVersion),
        ),
      )
      .run();
    return result.changes === 1;
  }

  async revokeObservedRootRegistration(input: {
    readonly expectedVersion: number;
    readonly registration: ObservedRootRegistration;
  }): Promise<boolean> {
    const database = await this.ensure();
    return drizzle({ client: database }).transaction(
      (transaction) =>
        this.revokeObservedRootRegistrationWithDrizzle(transaction, input),
      { behavior: "immediate" },
    );
  }

  private revokeObservedRootRegistrationWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly expectedVersion: number;
      readonly registration: ObservedRootRegistration;
    },
  ): boolean {
    const retained = transaction
      .select({ id: assetLibraries.id })
      .from(assetLibraries)
      .where(
        and(
          eq(assetLibraries.status, "active"),
          sql`EXISTS (SELECT 1 FROM json_each(${assetLibraries.rootIdsJson}) WHERE value = ${input.registration.id})`,
        ),
      )
      .get();
    if (retained !== undefined) return false;
    const replaced = transaction
      .update(observedRootRegistrations)
      .set(observedRootRegistrationToDrizzle(input.registration))
      .where(
        and(
          eq(observedRootRegistrations.id, input.registration.id),
          eq(observedRootRegistrations.configVersion, input.expectedVersion),
        ),
      )
      .run();
    if (replaced.changes !== 1) return false;

    const activeSupportLocationIds = new Set(
      transaction
        .select({ locationId: currentFileObservationSupports.locationId })
        .from(currentFileObservationSupports)
        .innerJoin(
          observedRootRegistrations,
          and(
            eq(
              observedRootRegistrations.id,
              currentFileObservationSupports.observedRootId,
            ),
            eq(
              observedRootRegistrations.configVersion,
              currentFileObservationSupports.observedRootVersion,
            ),
            eq(observedRootRegistrations.status, "active"),
          ),
        )
        .all()
        .map(({ locationId }) => locationId),
    );
    // 最终投影只依据持久化的成功扫描支持撤销当前位置。
    const unavailableLocationIds = transaction
      .select({ locationId: currentFileObservationSupports.locationId })
      .from(currentFileObservationSupports)
      .where(
        and(
          eq(
            currentFileObservationSupports.observedRootId,
            input.registration.id,
          ),
          eq(
            currentFileObservationSupports.observedRootVersion,
            input.expectedVersion,
          ),
        ),
      )
      .all()
      .flatMap(({ locationId }) =>
        activeSupportLocationIds.has(locationId) ? [] : [locationId],
      );
    if (unavailableLocationIds.length > 0)
      transaction
        .delete(currentFileObservations)
        .where(
          inArray(
            currentFileObservations.locationId,
            sqliteTextSet(unavailableLocationIds),
          ),
        )
        .run();

    const authorityIndex = createObservedRootAuthorityIndex(
      transaction
        .select()
        .from(observedRootRegistrations)
        .all()
        .map(observedRootRegistrationFromDrizzle),
    );
    const affectedRootIds = observedRootIdsDependingOn(
      authorityIndex,
      input.registration.id,
    );
    const dependentIntentIds = transaction
      .select({
        id: automationIntents.id,
        scopeJson: automationIntents.scopeJson,
      })
      .from(automationIntents)
      .all()
      .flatMap((intent) =>
        affectedRootIds.has(
          observedRootIdFromAutomationScope(intent.scopeJson) ?? "",
        )
          ? [intent.id]
          : [],
      );
    if (dependentIntentIds.length > 0) {
      transaction
        .update(automationIntents)
        .set({
          enabled: 0,
          disabledReason: "observed-root-revoked",
        })
        .where(inArray(automationIntents.id, dependentIntentIds))
        .run();
    }
    return true;
  }

  async inspectAutomationIntent(
    intentId: string,
  ): Promise<AutomationIntent | undefined> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const row = query
      .select()
      .from(automationIntents)
      .where(eq(automationIntents.id, intentId))
      .get();
    if (row === undefined) return undefined;
    try {
      return automationIntentFromDrizzle(row);
    } catch (error) {
      if (!(error instanceof InvalidAutomationIntentConfiguration)) throw error;
      query
        .update(automationIntents)
        .set({ enabled: 0, disabledReason: "invalid-configuration" })
        .where(eq(automationIntents.id, row.id))
        .run();
      return undefined;
    }
  }

  async listAutomationIntents(): Promise<readonly AutomationIntent[]> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const intents: AutomationIntent[] = [];
    query.transaction(
      (transaction) => {
        const rows = transaction
          .select()
          .from(automationIntents)
          .orderBy(asc(sql<number>`${automationIntents}.rowid`))
          .all();
        for (const row of rows) {
          try {
            intents.push(automationIntentFromDrizzle(row));
          } catch (error) {
            if (!(error instanceof InvalidAutomationIntentConfiguration))
              throw error;
            transaction
              .update(automationIntents)
              .set({ enabled: 0, disabledReason: "invalid-configuration" })
              .where(eq(automationIntents.id, row.id))
              .run();
          }
        }
      },
      { behavior: "immediate" },
    );
    return intents;
  }

  async listRunningAutomationExecutions(): Promise<
    readonly WorkflowExecution[]
  > {
    const database = await this.ensure();
    return drizzle({ client: database })
      .select()
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.status, "running"),
          sql`${workflowExecutions.automationIntentId} IS NOT NULL`,
        ),
      )
      .orderBy(asc(sql<number>`${workflowExecutions}.rowid`))
      .all()
      .map((row) =>
        this.workflowExecutionPersistence.executionFromDrizzle(row),
      );
  }

  async setAutomationIntentEnabled(
    intentId: string,
    enabled: boolean,
    disabledReason?: AutomationIntent["disabledReason"],
  ): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const result = query
      .update(automationIntents)
      .set({
        enabled: enabled ? 1 : 0,
        disabledReason: enabled ? null : (disabledReason ?? null),
      })
      .where(eq(automationIntents.id, intentId))
      .run();
    if (result.changes !== 1) throw new Error("未找到自动刷新意图");
  }

  async releaseAutomationTrigger(input: {
    readonly intentId: string;
    readonly executionId: string;
    readonly trigger: AutomationTrigger;
    readonly now: string;
  }): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        transaction
          .update(automationRuntime)
          .set({
            activeExecutionId: null,
            lastAutomaticTriggerAt: sql`CASE WHEN ${input.trigger} = 'scan-now'
              THEN ${automationRuntime.lastAutomaticTriggerAt} ELSE ${input.now} END`,
          })
          .where(
            and(
              eq(automationRuntime.intentId, input.intentId),
              eq(automationRuntime.activeExecutionId, input.executionId),
            ),
          )
          .run();
      },
      { behavior: "immediate" },
    );
  }

  private async ensure(): Promise<DatabaseSync> {
    if (this.database !== undefined) return this.database;
    const readiness = await inspectProductionCatalogueReadiness({
      productDataDirectory: this.productDataDirectory,
    });
    assertProductionCatalogueReady(readiness);
    const database = new DatabaseSync(
      path.join(this.productDataDirectory, "catalogue.sqlite"),
    );
    enableCatalogueWal(database);
    // 该适配器只在已经审核的 Drizzle 数据库模式上运行。绝不能对产品数据重放手写的
    // 历史迁移计划，也不能调用开发用模式工具。显式的一次性准备位于 `disposable.ts`；
    // 正式的生产迁移就绪性刻意由后续迁移工作负责。
    this.database = database;
    return database;
  }

  private assertResumeMutationClaim(
    query: DrizzleReadQuery,
    executionId: string,
    claim?: { readonly token: string; readonly now: string },
  ): void {
    const authoritativeNow = this.authoritativeNow();
    const row = query
      .select({
        status: workflowExecutions.status,
        resumeClaimToken: workflowExecutions.resumeClaimToken,
        resumeClaimExpiresAt: workflowExecutions.resumeClaimExpiresAt,
      })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId))
      .get();
    const hasClaim = row?.resumeClaimToken !== null;
    if (
      row?.status !== "running" ||
      (hasClaim && claim === undefined) ||
      (claim !== undefined &&
        (row?.resumeClaimToken !== claim.token ||
          row.resumeClaimExpiresAt === null ||
          row.resumeClaimExpiresAt <= authoritativeNow))
    ) {
      throw new Error(`Execution ${executionId} rejected a stale resume claim`);
    }
  }

  /** 仅由拥有租约变更的 SQLite 事务调用。 */
  private authoritativeNow(): string {
    const now = this.clock.now();
    if (!Number.isFinite(now.getTime()))
      throw new Error("SqliteCatalogue clock returned an invalid time");
    return now.toISOString();
  }

  private assertSourceRefreshRunStartWithDrizzle(
    query: DrizzleReadQuery,
    executionId: string,
    run: SourceRefreshRun,
  ): void {
    const execution =
      this.workflowExecutionPersistence.readExecutionWithDrizzle(
        query,
        executionId,
      );
    if (execution?.status !== "running") {
      throw new Error(
        `Workflow Execution ${executionId} cannot start a Source Refresh Run`,
      );
    }
    const association = query
      .select({ associationId: sourceAssociations.id })
      .from(currentSourceAssociations)
      .innerJoin(
        sourceAssociations,
        eq(sourceAssociations.id, currentSourceAssociations.associationId),
      )
      .where(
        and(
          eq(
            currentSourceAssociations.subjectId,
            run.requestedSelection.subjectId,
          ),
          eq(
            currentSourceAssociations.associationId,
            run.requestedSelection.sourceAssociationId,
          ),
          eq(
            sourceAssociations.sourceIdentity,
            run.requestedSelection.sourceIdentity,
          ),
          eq(
            sourceAssociations.nativeAddress,
            run.requestedSelection.nativeAddress,
          ),
        ),
      )
      .get();
    if (association === undefined) {
      throw new Error(
        "Source Refresh Run lost its current Source Association baseline",
      );
    }
    for (const scope of run.scopes) {
      if (
        !this.sourceRefreshLineageMatchesWithDrizzle(query, {
          assetId: run.requestedSelection.subjectId,
          coverage: scope.coverage,
          expectedSourceRecordId: scope.baselineSourceRecordId,
        })
      ) {
        throw new Error("Source Refresh Run lineage baseline is stale");
      }
    }
  }

  /**
   * 领域运行及其执行引用共同组成一个持久启动检查点。将两者的写入保留在调用方的
   * Drizzle 即时事务内，使恢复后的执行绝不会观察到只创建了一半的运行。
   */
  private insertSourceRefreshRunWithDrizzle(
    transaction: DrizzleWriteTransaction,
    executionId: string,
    run: SourceRefreshRun,
  ): void {
    transaction
      .insert(sourceRefreshRuns)
      .values({
        id: run.id,
        workflowExecutionId: executionId,
        initiatedBy: run.initiatedBy,
        initiatedAt: run.initiatedAt,
        requestedSelectionJson: JSON.stringify(run.requestedSelection),
        reviewPolicy: run.reviewPolicy,
      })
      .run();
    for (const [ordinal, scope] of run.scopes.entries()) {
      transaction
        .insert(sourceRefreshScopes)
        .values({
          runId: run.id,
          ordinal,
          sourceIdentity: scope.coverage.sourceIdentity,
          nativeAddress: scope.coverage.nativeAddress,
          coverageId: scope.coverage.coverageId,
          baselineSourceRecordId: scope.baselineSourceRecordId ?? null,
          state: scope.state,
          acquisitionAttempt: scope.acquisitionAttempt,
          changeSetId: scope.changeSetId ?? null,
          candidateSourceRecordId: scope.candidateSourceRecordId ?? null,
          outcome: scope.outcome ?? null,
          reason: scope.reason ?? null,
        })
        .run();
    }
    // 此辅助方法拥有它新增的执行引用：它在调用方的即时事务中读取当前行，
    // 再把该行的审计令牌带入最终 CAS。它刻意不接受调用方提供的不完整执行基线。
    const baseline =
      this.workflowExecutionPersistence.readExecutionWithAuditWithDrizzle(
        transaction,
        executionId,
      );
    if (baseline === undefined || baseline.execution.status !== "running") {
      throw new Error(`Unknown Workflow Execution ${executionId}`);
    }
    const execution = baseline.execution;
    if ((execution.sourceRefreshRunIds ?? []).includes(run.id)) {
      throw new Error(
        "Workflow Execution already references this Source Refresh Run",
      );
    }
    this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
      transaction,
      {
        ...execution,
        sourceRefreshRunIds: [...(execution.sourceRefreshRunIds ?? []), run.id],
      },
      { auditJson: baseline.auditJson },
    );
  }

  private insertSourceRefreshChangeSetWithDrizzle(
    transaction: DrizzleWriteTransaction,
    changeSet: SourceRefreshChangeSet,
    interpretation: SourceInterpretationBatch,
  ): void {
    transaction
      .insert(sourceRefreshChangeSets)
      .values({
        id: changeSet.id,
        runId: changeSet.runId,
        sourceIdentity: changeSet.coverage.sourceIdentity,
        nativeAddress: changeSet.coverage.nativeAddress,
        coverageId: changeSet.coverage.coverageId,
        baselineSourceRecordId: changeSet.baselineSourceRecordId ?? null,
        candidateSourceRecordId: changeSet.candidateSourceRecordId,
        changesJson: JSON.stringify(changeSet.changes),
        interpretationJson: JSON.stringify(interpretation),
        requiresReview: changeSet.requiresReview ? 1 : 0,
        disposition: changeSet.disposition,
      })
      .run();
  }

  /**
   * 领域投影会在调用此方法之前计算。Drizzle 条件更新会将每次范围/检查集转换，
   * 连同触发它的事实追加一起持久化，无需打开第二个原始事务。
   */
  private replaceSourceRefreshRunStateWithDrizzle(
    transaction: DrizzleWriteTransaction,
    run: SourceRefreshRun,
  ): void {
    for (const scope of run.scopes) {
      const result = transaction
        .update(sourceRefreshScopes)
        .set({
          state: scope.state,
          acquisitionAttempt: scope.acquisitionAttempt,
          changeSetId: scope.changeSetId ?? null,
          candidateSourceRecordId: scope.candidateSourceRecordId ?? null,
          outcome: scope.outcome ?? null,
          reason: scope.reason ?? null,
        })
        .where(
          and(
            eq(sourceRefreshScopes.runId, run.id),
            eq(
              sourceRefreshScopes.sourceIdentity,
              scope.coverage.sourceIdentity,
            ),
            eq(sourceRefreshScopes.nativeAddress, scope.coverage.nativeAddress),
            eq(sourceRefreshScopes.coverageId, scope.coverage.coverageId),
          ),
        )
        .run();
      if (result.changes !== 1)
        throw new Error("Source Refresh Run has an unknown scope");
    }
    for (const changeSet of run.changeSets) {
      const result = transaction
        .update(sourceRefreshChangeSets)
        .set({ disposition: changeSet.disposition })
        .where(
          and(
            eq(sourceRefreshChangeSets.id, changeSet.id),
            eq(sourceRefreshChangeSets.runId, run.id),
          ),
        )
        .run();
      if (result.changes !== 1)
        throw new Error("Source Refresh Run has an unknown Change Set");
    }
  }

  private requiredSourceRefreshRunWithDrizzle(
    query: DrizzleReadQuery,
    runId: string,
  ): SourceRefreshRun {
    const run = this.readSourceRefreshRunWithDrizzle(query, runId);
    if (run === undefined)
      throw new Error(`Unknown Source Refresh Run ${runId}`);
    return run;
  }

  private requiredSourceRefreshRunRowWithDrizzle(
    query: DrizzleReadQuery,
    runId: string,
  ): { readonly workflowExecutionId: string } {
    const row = query
      .select({ workflowExecutionId: sourceRefreshRuns.workflowExecutionId })
      .from(sourceRefreshRuns)
      .where(eq(sourceRefreshRuns.id, runId))
      .get();
    if (row === undefined)
      throw new Error(`Unknown Source Refresh Run ${runId}`);
    return row;
  }

  private readSourceRefreshRunWithDrizzle(
    query: DrizzleReadQuery,
    runId: string,
  ): SourceRefreshRun | undefined {
    const row = query
      .select()
      .from(sourceRefreshRuns)
      .where(eq(sourceRefreshRuns.id, runId))
      .get();
    if (row === undefined) return undefined;
    const scopes = query
      .select()
      .from(sourceRefreshScopes)
      .where(eq(sourceRefreshScopes.runId, runId))
      .orderBy(asc(sourceRefreshScopes.ordinal))
      .all();
    // SQLite 的隐式 `rowid` 保留一次运行中变更集的历史追加顺序。这个绑定数据库模式的
    // 排序片段没有动态输入，并使旧有持久投影保持稳定。
    const changeSets = query
      .select()
      .from(sourceRefreshChangeSets)
      .where(eq(sourceRefreshChangeSets.runId, runId))
      .orderBy(asc(sql<number>`${sourceRefreshChangeSets}.rowid`))
      .all();
    return this.projectSourceRefreshRunRows(row, scopes, changeSets);
  }

  private projectSourceRefreshRunRows(
    row: typeof sourceRefreshRuns.$inferSelect,
    scopes: readonly (typeof sourceRefreshScopes.$inferSelect)[],
    changeSets: readonly (typeof sourceRefreshChangeSets.$inferSelect)[],
  ): SourceRefreshRun {
    let requestedSelection: SourceRefreshRun["requestedSelection"];
    try {
      requestedSelection = JSON.parse(
        row.requestedSelectionJson,
      ) as SourceRefreshRun["requestedSelection"];
    } catch {
      throw new Error("Malformed Source Refresh Run requested selection");
    }
    return projectSourceRefreshRun({
      id: row.id,
      initiatedBy: row.initiatedBy,
      initiatedAt: row.initiatedAt,
      requestedSelection,
      reviewPolicy: row.reviewPolicy as SourceRefreshRun["reviewPolicy"],
      scopes: scopes.map((scope) => ({
        coverage: {
          sourceIdentity: scope.sourceIdentity,
          nativeAddress: scope.nativeAddress,
          coverageId: scope.coverageId,
        },
        ...(scope.baselineSourceRecordId === null
          ? {}
          : { baselineSourceRecordId: scope.baselineSourceRecordId }),
        state: scope.state as SourceRefreshRun["scopes"][number]["state"],
        acquisitionAttempt: scope.acquisitionAttempt,
        ...(scope.changeSetId === null
          ? {}
          : { changeSetId: scope.changeSetId }),
        ...(scope.candidateSourceRecordId === null
          ? {}
          : { candidateSourceRecordId: scope.candidateSourceRecordId }),
        ...(scope.outcome === null
          ? {}
          : {
              outcome: scope.outcome as NonNullable<
                SourceRefreshRun["scopes"][number]["outcome"]
              >,
            }),
        ...(scope.reason === null ? {} : { reason: scope.reason }),
      })),
      changeSets: changeSets.map((changeSet) => ({
        id: changeSet.id,
        runId: changeSet.runId,
        coverage: {
          sourceIdentity: changeSet.sourceIdentity,
          nativeAddress: changeSet.nativeAddress,
          coverageId: changeSet.coverageId,
        },
        ...(changeSet.baselineSourceRecordId === null
          ? {}
          : { baselineSourceRecordId: changeSet.baselineSourceRecordId }),
        candidateSourceRecordId: changeSet.candidateSourceRecordId,
        changes: parseSourceRefreshChanges(changeSet.changesJson),
        requiresReview: changeSet.requiresReview === 1,
        disposition:
          changeSet.disposition as SourceRefreshChangeSet["disposition"],
      })),
    });
  }

  private sourceRefreshChangeSetInterpretationWithDrizzle(
    query: DrizzleReadQuery,
    changeSetId: string,
  ): SourceInterpretationBatch {
    const row = query
      .select({
        interpretationJson: sourceRefreshChangeSets.interpretationJson,
      })
      .from(sourceRefreshChangeSets)
      .where(eq(sourceRefreshChangeSets.id, changeSetId))
      .get();
    if (row === undefined) throw new Error("Unknown Source Refresh Change Set");
    try {
      const interpretation = JSON.parse(
        row.interpretationJson,
      ) as SourceInterpretationBatch;
      validateSourceInterpretationBatch(interpretation);
      return interpretation;
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error("Malformed Source Refresh Change Set interpretation", {
        cause: error,
      });
    }
  }

  private sourceRefreshLineageMatchesWithDrizzle(
    query: DrizzleReadQuery,
    input: {
      readonly assetId: string;
      readonly coverage: SourceCoverageScope;
      readonly expectedSourceRecordId: string | undefined;
    },
  ): boolean {
    const head = query
      .select({ sourceRecordId: sourceLineageHeads.sourceRecordId })
      .from(sourceLineageHeads)
      .where(
        and(
          eq(sourceLineageHeads.subjectId, input.assetId),
          eq(sourceLineageHeads.sourceIdentity, input.coverage.sourceIdentity),
          eq(sourceLineageHeads.nativeAddress, input.coverage.nativeAddress),
          eq(sourceLineageHeads.coverageId, input.coverage.coverageId),
        ),
      )
      .get();
    return head?.sourceRecordId === input.expectedSourceRecordId;
  }

  private compareSourceRefreshScopeWithDrizzle(
    query: DrizzleReadQuery,
    input: {
      readonly assetId: string;
      readonly record: SourceRecord;
      readonly interpretation: SourceInterpretationBatch;
      readonly expectedSourceRecordId: string | undefined;
    },
  ): SourceRefreshChangeSet["changes"] {
    const predecessorSourceRecordIds =
      input.expectedSourceRecordId === undefined
        ? []
        : this.sourceRecordLineageIdsWithDrizzle(query, {
            assetId: input.assetId,
            sourceIdentity: input.record.sourceIdentity,
            nativeAddress: input.record.nativeAddress,
            coverageId: input.record.coverage.id,
            sourceRecordId: input.expectedSourceRecordId,
          });
    const currentMetadata =
      predecessorSourceRecordIds.length === 0
        ? []
        : this.currentMetadataForSourceRefreshLineageWithDrizzle(
            query,
            input.record,
            predecessorSourceRecordIds,
          );
    const currentMetadataByCoordinate = new Map(
      currentMetadata.map((item) => [
        sourceFactCoordinate(item.subjectId, item.sourceSlot),
        item,
      ]),
    );
    const candidateMetadata = input.interpretation.metadata.filter(
      (assertion) => assertion.sourceRecordIds.includes(input.record.id),
    );
    const changes: SourceRefreshChangeSet["changes"][number][] = [];
    for (const assertion of candidateMetadata) {
      const current = currentMetadataByCoordinate.get(
        sourceFactCoordinate(
          assertion.subjectId ?? input.assetId,
          assertion.sourceSlot,
        ),
      );
      if (
        current !== undefined &&
        metadataAssertionMatchesCurrent(current, assertion)
      ) {
        continue;
      }
      changes.push({
        kind: current === undefined ? "established" : "superseded",
        factReference: `metadata:${assertion.property}`,
      });
    }
    if (input.record.coverage.completeness === "complete") {
      const nextMetadataCoordinates = new Set(
        candidateMetadata.map((assertion) =>
          sourceFactCoordinate(
            assertion.subjectId ?? input.assetId,
            assertion.sourceSlot,
          ),
        ),
      );
      for (const item of currentMetadata) {
        const coordinate = sourceFactCoordinate(
          item.subjectId,
          item.sourceSlot,
        );
        if (!nextMetadataCoordinates.has(coordinate)) {
          changes.push({
            kind: "retracted",
            factReference: sourceFactSlotReference(
              "metadata",
              input.assetId,
              item.subjectId,
              item.sourceSlot,
            ),
          });
        }
      }
    }
    const currentRelationships =
      predecessorSourceRecordIds.length === 0
        ? []
        : this.currentRelationshipsForSourceRefreshLineageWithDrizzle(
            query,
            input.record,
            predecessorSourceRecordIds,
          );
    const currentRelationshipsByCoordinate = new Map(
      currentRelationships.map((item) => [
        sourceFactCoordinate(item.subjectId, item.sourceSlot),
        item,
      ]),
    );
    const candidateRelationships = (
      input.interpretation.relationships ?? []
    ).filter((relationship) =>
      relationship.sourceRecordIds.includes(input.record.id),
    );
    for (const relationship of candidateRelationships) {
      const current = currentRelationshipsByCoordinate.get(
        sourceFactCoordinate(
          relationshipSourceSubjectId(input.assetId, relationship),
          relationship.sourceSlot,
        ),
      );
      if (
        current !== undefined &&
        relationshipMatchesCurrent(current, {
          ...relationship,
          participants: [
            ...(relationship.subjectRole === undefined
              ? []
              : [{ entityId: input.assetId, role: relationship.subjectRole }]),
            ...relationship.participants,
          ],
        })
      ) {
        continue;
      }
      changes.push({
        kind: current === undefined ? "established" : "superseded",
        factReference: `relationship:${relationship.type}:${relationship.sourceSlot}`,
      });
    }
    if (input.record.coverage.completeness === "complete") {
      const nextRelationshipCoordinates = new Set(
        candidateRelationships.map((relationship) =>
          sourceFactCoordinate(
            relationshipSourceSubjectId(input.assetId, relationship),
            relationship.sourceSlot,
          ),
        ),
      );
      for (const item of currentRelationships) {
        const coordinate = sourceFactCoordinate(
          item.subjectId,
          item.sourceSlot,
        );
        if (!nextRelationshipCoordinates.has(coordinate)) {
          changes.push({
            kind: "retracted",
            factReference: sourceFactSlotReference(
              "relationship",
              input.assetId,
              item.subjectId,
              item.sourceSlot,
            ),
          });
        }
      }
    }
    return deduplicateSourceRefreshChanges(changes);
  }

  /**
   * 变更影响预览 CAS 使用的稳定投影指纹。输出的键名刻意与采用 Drizzle 前的 JSON
   * 指纹一致，使已经存储的预览在采用适配器后仍可比较。
   */
  private async listCurrentChangeImpactAttentionRows(
    query: DrizzleReadQuery,
    input: {
      readonly limit: number;
      readonly initialAfter: SQL | undefined;
    },
  ): Promise<readonly ChangeImpactAttentionRow[]> {
    const selected: ChangeImpactAttentionRow[] = [];
    const blockSize = input.limit + 1;
    let rawCursor:
      | { readonly sequence: number; readonly previewId: string }
      | undefined;
    while (selected.length < input.limit + 1) {
      const sequence = sql<number>`${workflowExecutions}.rowid`;
      const after =
        rawCursor === undefined
          ? input.initialAfter
          : or(
              lt(sequence, rawCursor.sequence),
              and(
                eq(sequence, rawCursor.sequence),
                gt(changeImpactPreviews.id, rawCursor.previewId),
              ),
            );
      const rawRows = await query
        .select({
          previewId: changeImpactPreviews.id,
          executionId: changeImpactPreviews.executionId,
          assetId: changeImpactPreviews.assetId,
          previewJson: changeImpactPreviews.previewJson,
          sequence,
        })
        .from(changeImpactPreviews)
        .innerJoin(
          workflowExecutions,
          eq(workflowExecutions.id, changeImpactPreviews.executionId),
        )
        .where(
          and(eq(changeImpactPreviews.status, "awaiting-confirmation"), after),
        )
        .orderBy(desc(sequence), asc(changeImpactPreviews.id))
        .limit(blockSize);
      if (rawRows.length === 0) break;
      const previews = rawRows.map(({ previewId, previewJson }) => ({
        previewId,
        preview: JSON.parse(previewJson) as ChangeImpactPreview,
      }));
      const validPreviewIds = this.currentChangeImpactPreviewIds(
        query,
        previews,
      );
      for (const row of rawRows) {
        if (validPreviewIds.has(row.previewId)) selected.push(row);
        if (selected.length >= input.limit + 1) break;
      }
      if (rawRows.length < blockSize) break;
      const last = rawRows.at(-1);
      if (last === undefined) break;
      rawCursor = { sequence: last.sequence, previewId: last.previewId };
    }
    return selected;
  }

  /** 通过一组有界批量读取重建精确的预览有效性。 */
  private currentChangeImpactPreviewIds(
    query: DrizzleReadQuery,
    previews: readonly {
      readonly previewId: string;
      readonly preview: ChangeImpactPreview;
    }[],
  ): ReadonlySet<string> {
    if (previews.length === 0) return new Set();
    const assetIds = uniqueStrings(
      previews.map(({ preview }) => preview.assetId),
    );
    const [heads, lineageRows, metadataRows, relationshipRows, artifactRows] = [
      query
        .select()
        .from(recognitionHeads)
        .where(inArray(recognitionHeads.subjectId, sqliteTextSet(assetIds)))
        .all(),
      query
        .select({
          subjectId: sourceLineageHeads.subjectId,
          source_identity: sourceLineageHeads.sourceIdentity,
          native_address: sourceLineageHeads.nativeAddress,
          coverage_id: sourceLineageHeads.coverageId,
          source_record_id: sourceLineageHeads.sourceRecordId,
        })
        .from(sourceLineageHeads)
        .where(inArray(sourceLineageHeads.subjectId, sqliteTextSet(assetIds)))
        .orderBy(
          asc(sourceLineageHeads.sourceIdentity),
          asc(sourceLineageHeads.nativeAddress),
          asc(sourceLineageHeads.coverageId),
        )
        .all(),
      query
        .select({
          id: metadataAssertions.id,
          subjectId: metadataAssertions.subjectId,
        })
        .from(metadataAssertions)
        .where(inArray(metadataAssertions.subjectId, sqliteTextSet(assetIds)))
        .orderBy(asc(metadataAssertions.id))
        .all(),
      query
        .select({
          id: entityRelationships.id,
          subjectId: entityRelationshipParticipants.entityId,
        })
        .from(entityRelationshipParticipants)
        .innerJoin(
          entityRelationships,
          eq(
            entityRelationships.id,
            entityRelationshipParticipants.relationshipId,
          ),
        )
        .where(
          inArray(
            entityRelationshipParticipants.entityId,
            sqliteTextSet(assetIds),
          ),
        )
        .orderBy(asc(entityRelationships.id))
        .all(),
      query
        .select({
          id: artifactAssociations.id,
          subjectId: artifactAssociations.subjectId,
          sourceAssociationId: artifactAssociations.sourceAssociationId,
          sourceRecordIdsJson: artifactAssociations.sourceRecordIdsJson,
        })
        .from(artifactAssociations)
        .where(inArray(artifactAssociations.subjectId, sqliteTextSet(assetIds)))
        .orderBy(asc(artifactAssociations.id))
        .all(),
    ];
    const decisionIds = uniqueStrings(
      heads.flatMap((head) =>
        head.recognitionDecisionId === null ? [] : [head.recognitionDecisionId],
      ),
    );
    const metadataIds = metadataRows.map((row) => row.id);
    const relationshipIds = relationshipRows.map((row) => row.id);
    const artifactIds = artifactRows.map((row) => row.id);
    const [
      decisions,
      metadataSupersessions,
      metadataRetractionsRows,
      relationshipSupersessions,
      relationshipRetractionsRows,
      artifactSupersessions,
      artifactRetractionsRows,
    ] = [
      decisionIds.length === 0
        ? []
        : query
            .select({
              id: recognitionDecisions.id,
              proposalId: recognitionDecisions.proposalId,
            })
            .from(recognitionDecisions)
            .where(inArray(recognitionDecisions.id, sqliteTextSet(decisionIds)))
            .all(),
      metadataIds.length === 0
        ? []
        : query
            .select({
              predecessorId: metadataAssertionLifecycles.predecessorAssertionId,
            })
            .from(metadataAssertionLifecycles)
            .where(
              inArray(
                metadataAssertionLifecycles.predecessorAssertionId,
                sqliteTextSet(metadataIds),
              ),
            )
            .all(),
      metadataIds.length === 0
        ? []
        : query
            .select({ assertionId: metadataAssertionRetractions.assertionId })
            .from(metadataAssertionRetractions)
            .where(
              inArray(
                metadataAssertionRetractions.assertionId,
                sqliteTextSet(metadataIds),
              ),
            )
            .all(),
      relationshipIds.length === 0
        ? []
        : query
            .select({
              predecessorId: relationshipLifecycles.predecessorRelationshipId,
            })
            .from(relationshipLifecycles)
            .where(
              inArray(
                relationshipLifecycles.predecessorRelationshipId,
                sqliteTextSet(relationshipIds),
              ),
            )
            .all(),
      relationshipIds.length === 0
        ? []
        : query
            .select({ relationshipId: relationshipRetractions.relationshipId })
            .from(relationshipRetractions)
            .where(
              inArray(
                relationshipRetractions.relationshipId,
                sqliteTextSet(relationshipIds),
              ),
            )
            .all(),
      artifactIds.length === 0
        ? []
        : query
            .select({
              predecessorId:
                artifactAssociationSupersessions.predecessorAssociationId,
            })
            .from(artifactAssociationSupersessions)
            .where(
              inArray(
                artifactAssociationSupersessions.predecessorAssociationId,
                sqliteTextSet(artifactIds),
              ),
            )
            .all(),
      artifactIds.length === 0
        ? []
        : query
            .select({
              associationId: artifactAssociationRetractions.associationId,
            })
            .from(artifactAssociationRetractions)
            .where(
              inArray(
                artifactAssociationRetractions.associationId,
                sqliteTextSet(artifactIds),
              ),
            )
            .all(),
    ];
    const proposalIds = uniqueStrings(
      decisions.map((decision) => decision.proposalId),
    );
    const proposalRows =
      proposalIds.length === 0
        ? []
        : query
            .select({
              id: recognitionProposals.id,
              basisJson: recognitionProposals.basisJson,
              boundariesJson: recognitionProposals.boundariesJson,
            })
            .from(recognitionProposals)
            .where(inArray(recognitionProposals.id, sqliteTextSet(proposalIds)))
            .all();
    const headByAsset = new Map(heads.map((head) => [head.subjectId, head]));
    const decisionById = new Map(
      decisions.map((decision) => [decision.id, decision]),
    );
    const proposalById = new Map(
      proposalRows.map((proposal) => [proposal.id, proposal]),
    );
    const supersededMetadata = new Set(
      metadataSupersessions.flatMap((row) =>
        row.predecessorId === null ? [] : [row.predecessorId],
      ),
    );
    const retractedMetadata = new Set(
      metadataRetractionsRows.map((row) => row.assertionId),
    );
    const supersededRelationships = new Set(
      relationshipSupersessions.flatMap((row) =>
        row.predecessorId === null ? [] : [row.predecessorId],
      ),
    );
    const retractedRelationships = new Set(
      relationshipRetractionsRows.map((row) => row.relationshipId),
    );
    const supersededArtifacts = new Set(
      artifactSupersessions.map((row) => row.predecessorId),
    );
    const retractedArtifacts = new Set(
      artifactRetractionsRows.map((row) => row.associationId),
    );
    const recognitionSupportRows =
      artifactIds.length === 0
        ? []
        : query
            .select({
              associationId:
                artifactAssociationRecognitionSupports.associationId,
              recognitionDecisionId:
                artifactAssociationRecognitionSupports.recognitionDecisionId,
            })
            .from(artifactAssociationRecognitionSupports)
            .where(
              inArray(
                artifactAssociationRecognitionSupports.associationId,
                sqliteTextSet(artifactIds),
              ),
            )
            .all();
    const supportDecisionIds = uniqueStrings(
      recognitionSupportRows.map(
        ({ recognitionDecisionId }) => recognitionDecisionId,
      ),
    );
    const endedRecognitionDecisions = new Set([
      ...(supportDecisionIds.length === 0
        ? []
        : query
            .select({
              id: recognitionDecisionSupersessions.predecessorDecisionId,
            })
            .from(recognitionDecisionSupersessions)
            .where(
              inArray(
                recognitionDecisionSupersessions.predecessorDecisionId,
                sqliteTextSet(supportDecisionIds),
              ),
            )
            .all()
            .map(({ id: decisionId }) => decisionId)),
      ...(supportDecisionIds.length === 0
        ? []
        : query
            .select({
              id: recognitionDecisionRetractions.predecessorDecisionId,
            })
            .from(recognitionDecisionRetractions)
            .where(
              inArray(
                recognitionDecisionRetractions.predecessorDecisionId,
                sqliteTextSet(supportDecisionIds),
              ),
            )
            .all()
            .map(({ id: decisionId }) => decisionId)),
    ]);
    const currentSourceIdsByAsset = new Map<string, Set<string>>();
    for (const row of query
      .select({
        subjectId: currentSourceAssociations.subjectId,
        associationId: currentSourceAssociations.associationId,
      })
      .from(currentSourceAssociations)
      .where(
        inArray(currentSourceAssociations.subjectId, sqliteTextSet(assetIds)),
      )
      .all()) {
      const ids = currentSourceIdsByAsset.get(row.subjectId) ?? new Set();
      ids.add(row.associationId);
      currentSourceIdsByAsset.set(row.subjectId, ids);
    }
    const fingerprintByAsset = new Map(
      assetIds.map((assetId) => [
        assetId,
        JSON.stringify({
          lineage: lineageRows.flatMap((row) =>
            row.subjectId === assetId
              ? [
                  {
                    source_identity: row.source_identity,
                    native_address: row.native_address,
                    coverage_id: row.coverage_id,
                    source_record_id: row.source_record_id,
                  },
                ]
              : [],
          ),
          metadata: metadataRows.flatMap((row) =>
            row.subjectId === assetId &&
            !supersededMetadata.has(row.id) &&
            !retractedMetadata.has(row.id)
              ? [{ id: row.id }]
              : [],
          ),
          relationships: relationshipRows.flatMap((row) =>
            row.subjectId === assetId &&
            !supersededRelationships.has(row.id) &&
            !retractedRelationships.has(row.id)
              ? [{ id: row.id }]
              : [],
          ),
          artifacts: artifactRows.flatMap((row) =>
            row.subjectId === assetId &&
            !supersededArtifacts.has(row.id) &&
            !retractedArtifacts.has(row.id)
              ? [
                  {
                    id: row.id,
                    recognitionDecisionIds: recognitionSupportRows
                      .flatMap((support) =>
                        support.associationId === row.id &&
                        !endedRecognitionDecisions.has(
                          support.recognitionDecisionId,
                        )
                          ? [support.recognitionDecisionId]
                          : [],
                      )
                      .toSorted(),
                    ...(row.sourceAssociationId !== null &&
                    currentSourceIdsByAsset
                      .get(assetId)
                      ?.has(row.sourceAssociationId) === true &&
                    (JSON.parse(row.sourceRecordIdsJson) as readonly string[])
                      .length > 0
                      ? { sourceAssociationId: row.sourceAssociationId }
                      : {}),
                  },
                ]
              : [],
          ),
        }),
      ]),
    );
    const valid = new Set<string>();
    for (const { previewId, preview } of previews) {
      const head = headByAsset.get(preview.assetId);
      const decision =
        head === undefined || head.recognitionDecisionId === null
          ? undefined
          : decisionById.get(head.recognitionDecisionId);
      const proposal =
        decision === undefined
          ? undefined
          : proposalById.get(decision.proposalId);
      const sourceRecordIds =
        proposal === undefined
          ? undefined
          : (
              recognitionSourceInterpretation({
                id: proposal.id,
                boundaries: JSON.parse(
                  proposal.boundariesJson,
                ) as RecognitionProposal["boundaries"],
                basis: JSON.parse(
                  proposal.basisJson,
                ) as RecognitionProposal["basis"],
                ruleResults: [],
              })?.sourceRecordIds ?? []
            )
              .toSorted()
              .join(",");
      const baseline = (key: string) =>
        preview.baselines.find((item) => item.key === key)?.value;
      // 封面决定预演只对冻结的角色头哨兵与整资产完整事实负责：候选资格与适用政策
      // 版本在确认事务内以同一规则重算，读取路径不因识别主头为空被误判 stale。
      if (preview.change.kind === "artifact-role-decision") {
        const sentinel = baseline("artifact-role-decision-head");
        const currentHeadDecisionId =
          query
            .select({ decisionId: artifactRoleDecisionHeads.decisionId })
            .from(artifactRoleDecisionHeads)
            .where(
              eq(
                artifactRoleDecisionHeads.targetKey,
                artifactRoleDecisionKey(
                  preview.change.decision.target,
                  preview.change.decision.role,
                ),
              ),
            )
            .all()[0]?.decisionId ?? null;
        if (
          sentinel !== undefined &&
          sentinel === (currentHeadDecisionId ?? "none") &&
          fingerprintByAsset.get(preview.assetId) ===
            baseline("complete-current-projection")
        )
          valid.add(previewId);
        continue;
      }
      // 范围预演只对自己冻结的相交完整声明负责：以被点名决定的存续与按
      // scopeDecisionIds 精确重算的支持指纹判定有效性，绝不因主头为空或全资产
      // 关联指纹（不相交主体新增）被误判 stale。其余预演沿用整资产共同基线规则。
      const scopeDecisionIdsValue = baseline("recognition-scope-decision-ids");
      if (scopeDecisionIdsValue !== undefined) {
        const namedDecisionId = baseline("recognition-decision");
        if (
          head !== undefined &&
          namedDecisionId !== undefined &&
          !endedRecognitionDecisions.has(namedDecisionId) &&
          this.currentChangeImpactBaselineWithDrizzle(
            query,
            preview.assetId,
            JSON.parse(scopeDecisionIdsValue) as readonly string[],
          ) === baseline("complete-current-projection")
        )
          valid.add(previewId);
        continue;
      }
      if (
        head !== undefined &&
        (head.recognitionSourceAssociationId ?? "") ===
          baseline("source-association") &&
        head.recognitionDecisionId === baseline("recognition-decision") &&
        sourceRecordIds === baseline("source-records") &&
        fingerprintByAsset.get(preview.assetId) ===
          baseline("complete-current-projection")
      )
        valid.add(previewId);
    }
    return valid;
  }

  /**
   * 在权威变更的事务内转换无效的等待中预览。读取路径会防御性地复用同一批次有效性检查，
   * 但绝不执行这一生命周期写入。
   */
  private invalidateStaleChangeImpactPreviewsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    affectedAssetIds: readonly string[],
  ): void {
    const assetIds = uniqueStrings(affectedAssetIds);
    if (assetIds.length === 0) return;
    const previews = transaction
      .select({
        previewId: changeImpactPreviews.id,
        previewJson: changeImpactPreviews.previewJson,
      })
      .from(changeImpactPreviews)
      .where(
        and(
          inArray(changeImpactPreviews.assetId, sqliteTextSet(assetIds)),
          eq(changeImpactPreviews.status, "awaiting-confirmation"),
        ),
      )
      .all()
      .map(({ previewId, previewJson }) => ({
        previewId,
        preview: JSON.parse(previewJson) as ChangeImpactPreview,
      }));
    const validPreviewIds = this.currentChangeImpactPreviewIds(
      transaction,
      previews,
    );
    const stalePreviewIds = previews.flatMap(({ previewId }) =>
      validPreviewIds.has(previewId) ? [] : [previewId],
    );
    if (stalePreviewIds.length === 0) return;
    transaction
      .update(changeImpactPreviews)
      .set({
        previewJson: sql`json_set(${changeImpactPreviews.previewJson}, '$.status', 'stale')`,
      })
      .where(
        and(
          inArray(changeImpactPreviews.id, sqliteTextSet(stalePreviewIds)),
          eq(changeImpactPreviews.status, "awaiting-confirmation"),
        ),
      )
      .run();
  }

  /**
   * 完整投影基线。给出范围决定集合时，产物部分只覆盖这些决定仍生效的精确观察支持
   * （执行、快照、位置、材料种类、修订版）；不相交决定的新增或结束不会改动这份基线。
   */
  private currentChangeImpactBaselineWithDrizzle(
    query: DrizzleReadQuery,
    assetId: string,
    scopeDecisionIds?: readonly string[],
  ): string {
    const lineage = query
      .select({
        source_identity: sourceLineageHeads.sourceIdentity,
        native_address: sourceLineageHeads.nativeAddress,
        coverage_id: sourceLineageHeads.coverageId,
        source_record_id: sourceLineageHeads.sourceRecordId,
      })
      .from(sourceLineageHeads)
      .where(eq(sourceLineageHeads.subjectId, assetId))
      .orderBy(
        asc(sourceLineageHeads.sourceIdentity),
        asc(sourceLineageHeads.nativeAddress),
        asc(sourceLineageHeads.coverageId),
      )
      .all();

    const metadataRows = query
      .select({ id: metadataAssertions.id })
      .from(metadataAssertions)
      .where(eq(metadataAssertions.subjectId, assetId))
      .orderBy(asc(metadataAssertions.id))
      .all();
    const supersededMetadata = new Set(
      query
        .select({
          predecessorId: metadataAssertionLifecycles.predecessorAssertionId,
        })
        .from(metadataAssertionLifecycles)
        .all()
        .flatMap((row) =>
          row.predecessorId === null ? [] : [row.predecessorId],
        ),
    );
    const retractedMetadata = new Set(
      query
        .select({ assertionId: metadataAssertionRetractions.assertionId })
        .from(metadataAssertionRetractions)
        .all()
        .map((row) => row.assertionId),
    );
    const metadata = metadataRows.filter(
      (row) =>
        !supersededMetadata.has(row.id) && !retractedMetadata.has(row.id),
    );

    const relationshipRows = query
      .select({ id: entityRelationships.id })
      .from(entityRelationshipParticipants)
      .innerJoin(
        entityRelationships,
        eq(
          entityRelationships.id,
          entityRelationshipParticipants.relationshipId,
        ),
      )
      .where(eq(entityRelationshipParticipants.entityId, assetId))
      .orderBy(asc(entityRelationships.id))
      .all();
    const supersededRelationships = new Set(
      query
        .select({
          predecessorId: relationshipLifecycles.predecessorRelationshipId,
        })
        .from(relationshipLifecycles)
        .all()
        .flatMap((row) =>
          row.predecessorId === null ? [] : [row.predecessorId],
        ),
    );
    const retractedRelationships = new Set(
      query
        .select({ relationshipId: relationshipRetractions.relationshipId })
        .from(relationshipRetractions)
        .all()
        .map((row) => row.relationshipId),
    );
    const relationships = relationshipRows.filter(
      (row) =>
        !supersededRelationships.has(row.id) &&
        !retractedRelationships.has(row.id),
    );

    const artifactRows = query
      .select({
        id: artifactAssociations.id,
        sourceAssociationId: artifactAssociations.sourceAssociationId,
        sourceRecordIdsJson: artifactAssociations.sourceRecordIdsJson,
      })
      .from(artifactAssociations)
      .where(eq(artifactAssociations.subjectId, assetId))
      .orderBy(asc(artifactAssociations.id))
      .all();
    const supersededArtifacts = new Set(
      query
        .select({
          predecessorId:
            artifactAssociationSupersessions.predecessorAssociationId,
        })
        .from(artifactAssociationSupersessions)
        .all()
        .map((row) => row.predecessorId),
    );
    const retractedArtifacts = new Set(
      query
        .select({ associationId: artifactAssociationRetractions.associationId })
        .from(artifactAssociationRetractions)
        .all()
        .map((row) => row.associationId),
    );
    const endedRecognitionDecisions = new Set([
      ...query
        .select({ id: recognitionDecisionSupersessions.predecessorDecisionId })
        .from(recognitionDecisionSupersessions)
        .all()
        .map(({ id: decisionId }) => decisionId),
      ...query
        .select({ id: recognitionDecisionRetractions.predecessorDecisionId })
        .from(recognitionDecisionRetractions)
        .all()
        .map(({ id: decisionId }) => decisionId),
    ]);
    const currentSourceIds = new Set(
      query
        .select({ id: currentSourceAssociations.associationId })
        .from(currentSourceAssociations)
        .where(eq(currentSourceAssociations.subjectId, assetId))
        .all()
        .map(({ id: associationId }) => associationId),
    );
    if (scopeDecisionIds !== undefined) {
      const scopedSupports =
        scopeDecisionIds.length === 0
          ? []
          : query
              .select({
                associationId:
                  artifactAssociationRecognitionSupports.associationId,
                recognitionDecisionId:
                  artifactAssociationRecognitionSupports.recognitionDecisionId,
                observationExecutionId:
                  artifactAssociationRecognitionSupports.observationExecutionId,
                observationSnapshotId:
                  artifactAssociationRecognitionSupports.observationSnapshotId,
                observationLocationId:
                  artifactAssociationRecognitionSupports.observationLocationId,
                observationMaterialKind:
                  artifactAssociationRecognitionSupports.observationMaterialKind,
                observationRevisionId:
                  artifactAssociationRecognitionSupports.observationRevisionId,
              })
              .from(artifactAssociationRecognitionSupports)
              .where(
                inArray(
                  artifactAssociationRecognitionSupports.recognitionDecisionId,
                  sqliteTextSet(scopeDecisionIds),
                ),
              )
              .all();
      const supportsByAssociation = new Map<string, string[]>();
      for (const support of scopedSupports) {
        if (endedRecognitionDecisions.has(support.recognitionDecisionId))
          continue;
        (
          supportsByAssociation.get(support.associationId) ??
          supportsByAssociation
            .set(support.associationId, [])
            .get(support.associationId)!
        ).push(JSON.stringify(support));
      }
      const scopedArtifacts = artifactRows
        .filter(
          (row) =>
            !supersededArtifacts.has(row.id) &&
            !retractedArtifacts.has(row.id) &&
            supportsByAssociation.has(row.id),
        )
        .map((row) => ({
          id: row.id,
          supports: supportsByAssociation.get(row.id)!.toSorted(),
        }));
      return JSON.stringify({
        lineage,
        metadata,
        relationships,
        artifacts: scopedArtifacts,
      });
    }
    const artifacts = artifactRows
      .filter(
        (row) =>
          !supersededArtifacts.has(row.id) && !retractedArtifacts.has(row.id),
      )
      .map((row) => ({
        id: row.id,
        recognitionDecisionIds: query
          .select({
            id: artifactAssociationRecognitionSupports.recognitionDecisionId,
          })
          .from(artifactAssociationRecognitionSupports)
          .where(
            eq(artifactAssociationRecognitionSupports.associationId, row.id),
          )
          .all()
          .map(({ id: decisionId }) => decisionId)
          .filter((decisionId) => !endedRecognitionDecisions.has(decisionId))
          .toSorted(),
        ...(row.sourceAssociationId !== null &&
        currentSourceIds.has(row.sourceAssociationId) &&
        (JSON.parse(row.sourceRecordIdsJson) as readonly string[]).length > 0
          ? { sourceAssociationId: row.sourceAssociationId }
          : {}),
      }));
    return JSON.stringify({ lineage, metadata, relationships, artifacts });
  }
  /**
   * 02B 无法证明支持的存量关联只能原样保留。只有本次叠加投影改变其
   * 精确 ID/内容/当前性时才阻塞；仅与它同处一个完整投影不构成触及。
   */
  private withOtherLegacyArtifactDeltaBlocked(
    query: DrizzleReadQuery,
    preview: ChangeImpactPreview,
  ): ChangeImpactPreview {
    const projected = new Map(
      preview.projected.artifactAssociations.map((association) => [
        association.id,
        association,
      ]),
    );
    const touchedIds = preview.current.artifactAssociations.flatMap(
      (association) => {
        const successor = projected.get(association.id);
        return successor !== undefined &&
          sameDescriptionTarget(successor.target, association.target) &&
          successor.artifactId === association.artifactId &&
          successor.role === association.role
          ? []
          : [association.id];
      },
    );
    if (touchedIds.length === 0) return preview;
    const currentIds = new Set(
      query
        .select({ id: artifactAssociations.id })
        .from(artifactAssociations)
        .where(
          and(
            eq(artifactAssociations.subjectId, preview.assetId),
            inArray(artifactAssociations.id, sqliteTextSet(touchedIds)),
          ),
        )
        .all()
        .map(({ id: associationId }) => associationId),
    );
    const recognitionSupported = new Set(
      query
        .select({ id: artifactAssociationRecognitionSupports.associationId })
        .from(artifactAssociationRecognitionSupports)
        .where(
          inArray(
            artifactAssociationRecognitionSupports.associationId,
            sqliteTextSet(touchedIds),
          ),
        )
        .all()
        .map(({ id: associationId }) => associationId),
    );
    const sourceSupported = new Set(
      query
        .select({ id: artifactAssociations.id })
        .from(artifactAssociations)
        .where(
          and(
            inArray(artifactAssociations.id, sqliteTextSet(touchedIds)),
            sql`${artifactAssociations.sourceAssociationId} IS NOT NULL`,
          ),
        )
        .all()
        .map(({ id: associationId }) => associationId),
    );
    const touchesOtherLegacy = touchedIds.some(
      (associationId) =>
        currentIds.has(associationId) &&
        !recognitionSupported.has(associationId) &&
        !sourceSupported.has(associationId),
    );
    if (!touchesOtherLegacy) return preview;
    const condition =
      "变更会触及无法证明支持的存量产物关联；请先完成独立数据修复";
    return preview.blockingConditions.includes(condition)
      ? preview
      : {
          ...preview,
          blockingConditions: [...preview.blockingConditions, condition],
        };
  }

  private insertProposalWithDrizzle(
    transaction: DrizzleWriteTransaction,
    executionId: string,
    proposal: RecognitionProposal,
  ): void {
    this.assertProposalSourceRecordOwnershipWithDrizzle(
      transaction,
      executionId,
      proposal,
    );
    const basis = JSON.stringify(proposal.basis);
    const boundaries = JSON.stringify(proposal.boundaries);
    const ruleResults = JSON.stringify(proposal.ruleResults);
    const observedMaterialInterpretation =
      proposal.observedArtifactAssociations === undefined &&
      proposal.observedArtifactRevisions === undefined &&
      proposal.observedMetadata === undefined &&
      proposal.observedArtifactParts === undefined &&
      proposal.observedEntityGraphs === undefined
        ? null
        : JSON.stringify({
            ...(proposal.observedArtifactAssociations === undefined
              ? {}
              : {
                  observedArtifactAssociations:
                    proposal.observedArtifactAssociations,
                }),
            ...(proposal.observedArtifactRevisions === undefined
              ? {}
              : {
                  observedArtifactRevisions: proposal.observedArtifactRevisions,
                }),
            ...(proposal.observedMetadata === undefined
              ? {}
              : { observedMetadata: proposal.observedMetadata }),
            ...(proposal.observedArtifactParts === undefined
              ? {}
              : { observedArtifactParts: proposal.observedArtifactParts }),
            ...(proposal.observedEntityGraphs === undefined
              ? {}
              : { observedEntityGraphs: proposal.observedEntityGraphs }),
          });
    const existing = transaction
      .select({
        executionId: recognitionProposals.executionId,
        basisJson: recognitionProposals.basisJson,
        boundariesJson: recognitionProposals.boundariesJson,
        ruleResultsJson: recognitionProposals.ruleResultsJson,
        observedMaterialInterpretationJson:
          recognitionProposals.observedMaterialInterpretationJson,
      })
      .from(recognitionProposals)
      .where(eq(recognitionProposals.id, proposal.id))
      .get();
    if (existing !== undefined) {
      if (
        existing.executionId !== executionId ||
        existing.basisJson !== basis ||
        existing.boundariesJson !== boundaries ||
        existing.ruleResultsJson !== ruleResults ||
        existing.observedMaterialInterpretationJson !==
          observedMaterialInterpretation
      ) {
        throw new Error(
          `Recognition Proposal ${proposal.id} conflicts with durable history`,
        );
      }
      return;
    }
    transaction
      .insert(recognitionProposals)
      .values({
        id: proposal.id,
        executionId,
        basisJson: basis,
        boundariesJson: boundaries,
        ruleResultsJson: ruleResults,
        observedMaterialInterpretationJson: observedMaterialInterpretation,
      })
      .run();
  }

  /** 每个提案引用都是由其运行中执行拥有的证据。 */
  private assertProposalSourceRecordOwnershipWithDrizzle(
    query: DrizzleReadQuery,
    executionId: string,
    proposal: RecognitionProposal,
  ): void {
    const interpretation = recognitionSourceInterpretation(proposal);
    if (interpretation === undefined) return;
    const sourceRecordIds = new Set([
      ...interpretation.sourceRecordIds,
      ...(interpretation.recognitionEvidenceReferences ?? []).map(
        (reference) => reference.sourceRecordId,
      ),
      ...proposal.ruleResults.flatMap((result) =>
        (result.evidenceReferences ?? []).map(
          (reference) => reference.sourceRecordId,
        ),
      ),
    ]);
    for (const sourceRecordId of sourceRecordIds) {
      const record = query
        .select({ executionId: sourceRecords.executionId })
        .from(sourceRecords)
        .where(eq(sourceRecords.id, sourceRecordId))
        .get();
      if (record?.executionId !== executionId)
        throw new Error(
          "Recognition Proposal references Source Record outside its execution",
        );
    }
  }

  private readProposalWithDrizzle(
    query: DrizzleReadQuery,
    id: string,
  ): RecognitionProposal | undefined {
    const row = query
      .select()
      .from(recognitionProposals)
      .where(eq(recognitionProposals.id, id))
      .get();
    return row === undefined
      ? undefined
      : {
          id: row.id,
          boundaries: JSON.parse(
            row.boundariesJson,
          ) as RecognitionProposal["boundaries"],
          basis: JSON.parse(row.basisJson) as RecognitionProposal["basis"],
          ruleResults: JSON.parse(
            row.ruleResultsJson,
          ) as RecognitionProposal["ruleResults"],
          ...(row.observedMaterialInterpretationJson === null
            ? {}
            : (JSON.parse(row.observedMaterialInterpretationJson) as Pick<
                RecognitionProposal,
                | "observedArtifactAssociations"
                | "observedArtifactRevisions"
                | "observedMetadata"
                | "observedArtifactParts"
                | "observedEntityGraphs"
              >)),
        };
  }

  private observedMaterialIdentityBaselineWithDrizzle(
    query: DrizzleReadQuery,
    assetId: string,
  ): string | undefined {
    const kind = this.entityKindStateWithDrizzle(query, assetId).effective;
    if (kind.status !== "effective" || kind.kind !== "digital-asset")
      return undefined;
    const head = query
      .select({
        subjectId: recognitionHeads.subjectId,
        recognitionDecisionId: recognitionHeads.recognitionDecisionId,
        recognitionSourceAssociationId:
          recognitionHeads.recognitionSourceAssociationId,
      })
      .from(recognitionHeads)
      .where(and(eq(recognitionHeads.subjectId, assetId)))
      .get();
    return head === undefined
      ? undefined
      : createHash("sha256").update(canonicalJson(head)).digest("hex");
  }

  private observedMaterialBaselineWithDrizzle(
    query: DrizzleReadQuery,
    assetId: string,
  ): string {
    const rows = query
      .select({
        id: artifactAssociations.id,
        artifactId: artifactAssociations.artifactId,
        role: artifactAssociations.role,
        sourceRecordIdsJson: artifactAssociations.sourceRecordIdsJson,
        sourceAssociationId: artifactAssociations.sourceAssociationId,
      })
      .from(artifactAssociations)
      .where(eq(artifactAssociations.subjectId, assetId))
      .orderBy(asc(artifactAssociations.id))
      .all();
    const current = rows.filter((row) => {
      const retracted = query
        .select({ id: artifactAssociationRetractions.associationId })
        .from(artifactAssociationRetractions)
        .where(eq(artifactAssociationRetractions.associationId, row.id))
        .get();
      const superseded = query
        .select({
          id: artifactAssociationSupersessions.predecessorAssociationId,
        })
        .from(artifactAssociationSupersessions)
        .where(
          eq(artifactAssociationSupersessions.predecessorAssociationId, row.id),
        )
        .get();
      return retracted === undefined && superseded === undefined;
    });
    const materialArtifacts = [
      ...new Set(current.map((row) => row.artifactId)),
    ];
    const materialFacts = materialArtifacts.map((artifactId) => {
      const materialLocations = query
        .select({
          id: locations.id,
          address: locations.address,
          kind: locations.kind,
        })
        .from(locations)
        .where(eq(locations.artifactId, artifactId))
        .orderBy(asc(locations.id))
        .all();
      const revisions = query
        .select({
          id: artifactRevisions.id,
          blobDigest: artifactRevisions.blobDigest,
          producerJson: artifactRevisions.producerJson,
        })
        .from(artifactRevisions)
        .where(eq(artifactRevisions.artifactId, artifactId))
        .orderBy(asc(artifactRevisions.id))
        .all();
      const materialBlobs = revisions.map((revision) => ({
        revision,
        blob: query
          .select()
          .from(blobs)
          .where(eq(blobs.digest, revision.blobDigest))
          .get(),
      }));
      return {
        artifactId,
        locations: materialLocations,
        revisions: materialBlobs,
      };
    });
    return createHash("sha256")
      .update(canonicalJson({ associations: current, facts: materialFacts }))
      .digest("hex");
  }

  private observedMaterialSubmissionExistsWithDrizzle(
    query: DrizzleReadQuery,
    submission: ObservedMaterialAssociationSubmission,
  ): boolean {
    for (const association of submission.artifactAssociations) {
      const row = query
        .select()
        .from(artifactAssociations)
        .where(eq(artifactAssociations.id, association.id))
        .get();
      if (
        row === undefined ||
        !sameDescriptionTarget(
          descriptionTargetFromColumns(row),
          association.target,
        ) ||
        row.artifactId !== association.artifactId ||
        row.role !== association.role
      )
        return false;
      const hasDecisionSupport =
        this.hasValidObservedMaterialSupportWithDrizzle(query, association);
      const independentlySourced =
        JSON.parse(row.sourceRecordIdsJson).length > 0 ||
        row.sourceAssociationId !== null;
      if (!hasDecisionSupport && !independentlySourced) return false;
    }
    for (const location of submission.locations) {
      const row = query
        .select()
        .from(locations)
        .where(eq(locations.id, location.id))
        .get();
      if (
        row === undefined ||
        row.artifactId !== location.artifactId ||
        row.address !== location.address ||
        row.kind !== location.kind
      )
        return false;
    }
    for (const revision of submission.artifactRevisions) {
      const row = query
        .select()
        .from(artifactRevisions)
        .where(eq(artifactRevisions.id, revision.id))
        .get();
      if (
        row === undefined ||
        row.artifactId !== revision.artifactId ||
        row.blobDigest !== revision.blobDigest
      )
        return false;
    }
    return true;
  }

  private observedMaterialProjectionAlreadySupportedWithDrizzle(
    query: DrizzleReadQuery,
    submission: ObservedMaterialAssociationSubmission,
  ): boolean {
    const targetAssetId = submission.recognitionDecision.assetId;
    for (const proposedLocation of submission.locations) {
      const submittedRevision = submission.artifactRevisions.find(
        (revision) => revision.artifactId === proposedLocation.artifactId,
      );
      const submittedBlob = submission.blobs.find(
        (blob) => blob.digest === submittedRevision?.blobDigest,
      );
      if (submittedRevision === undefined || submittedBlob === undefined)
        return false;
      const matchingLocations = query
        .select({ artifactId: locations.artifactId })
        .from(locations)
        .where(
          and(
            eq(locations.address, proposedLocation.address),
            eq(locations.kind, proposedLocation.kind),
          ),
        )
        .all();
      const supported = matchingLocations.some(({ artifactId }) => {
        const association = query
          .select()
          .from(artifactAssociations)
          .where(
            and(
              eq(artifactAssociations.subjectId, targetAssetId),
              eq(artifactAssociations.artifactId, artifactId),
              eq(artifactAssociations.role, "asset.material-delivered"),
            ),
          )
          .get();
        if (association === undefined) return false;
        if (
          query
            .select({ id: artifactAssociationRetractions.associationId })
            .from(artifactAssociationRetractions)
            .where(
              eq(artifactAssociationRetractions.associationId, association.id),
            )
            .get() !== undefined ||
          query
            .select({
              id: artifactAssociationSupersessions.predecessorAssociationId,
            })
            .from(artifactAssociationSupersessions)
            .where(
              eq(
                artifactAssociationSupersessions.predecessorAssociationId,
                association.id,
              ),
            )
            .get() !== undefined
        )
          return false;
        const support = this.hasValidObservedMaterialSupportWithDrizzle(query, {
          id: association.id,
          target: descriptionTargetFromColumns(association),
          artifactId: association.artifactId,
          role: association.role,
        });
        if (
          !support &&
          JSON.parse(association.sourceRecordIdsJson).length === 0 &&
          association.sourceAssociationId === null
        )
          return false;
        const revision = query
          .select({ blobDigest: artifactRevisions.blobDigest })
          .from(artifactRevisions)
          .where(
            and(
              eq(artifactRevisions.artifactId, artifactId),
              eq(artifactRevisions.blobDigest, submittedRevision.blobDigest),
            ),
          )
          .get();
        if (revision === undefined) return false;
        const blob = query
          .select()
          .from(blobs)
          .where(eq(blobs.digest, revision.blobDigest))
          .get();
        return (
          blob?.mediaType === submittedBlob.mediaType &&
          blob.byteLength === submittedBlob.byteLength
        );
      });
      if (!supported) return false;
    }
    return submission.locations.length > 0;
  }

  private insertAcceptedFactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    accepted: AcceptedRecognition,
  ): void {
    transaction.insert(entities).values({ id: accepted.entity.id }).run();
    transaction
      .insert(entityKindAssertions)
      .values({
        id: `accepted-kind:${accepted.entity.id}`,
        entityId: accepted.entity.id,
        kind: "digital-asset",
        basis: "legacy-migration",
        sourceRecordIdsJson: "[]",
      })
      .onConflictDoNothing()
      .run();
    for (const entity of accepted.entities ?? [])
      this.insertOrReuseSourcedEntityWithDrizzle(transaction, entity);

    const recognitionSourceAssociation = accepted.recognitionSourceAssociation;
    if (recognitionSourceAssociation !== undefined)
      transaction
        .insert(sourceAssociations)
        .values({
          id: recognitionSourceAssociation.id,
          subjectId: recognitionSourceAssociation.subjectId,
          sourceIdentity: recognitionSourceAssociation.sourceIdentity,
          nativeAddress: recognitionSourceAssociation.nativeAddress,
        })
        .run();
    transaction
      .insert(recognitionDecisions)
      .values({
        id: accepted.recognitionDecision.id,
        proposalId: accepted.recognitionDecision.proposalId,
        assetId: accepted.recognitionDecision.assetId,
        acceptedRuleResultsJson: JSON.stringify(
          accepted.recognitionDecision.acceptedRuleResults,
        ),
        boundariesJson: JSON.stringify(accepted.recognitionDecision.boundaries),
      })
      .run();
    if (recognitionSourceAssociation !== undefined)
      transaction
        .insert(sourceAssociationEstablishmentSupports)
        .values({
          associationId: recognitionSourceAssociation.id,
          recognitionDecisionId: accepted.recognitionDecision.id,
        })
        .run();
    transaction
      .insert(recognitionHeads)
      .values({
        subjectId: accepted.entity.id,
        recognitionDecisionId: accepted.recognitionDecision.id,
        recognitionSourceAssociationId:
          recognitionSourceAssociation?.id ?? null,
      })
      .run();
    if (recognitionSourceAssociation !== undefined)
      transaction
        .insert(currentSourceAssociations)
        .values({
          subjectId: accepted.entity.id,
          associationId: recognitionSourceAssociation.id,
        })
        .onConflictDoNothing()
        .run();

    const interpretation = recognitionSourceInterpretation(accepted.proposal);
    for (const sourceRecordId of interpretation?.sourceRecordIds ?? []) {
      const context = this.sourceRecordContextWithDrizzle(
        transaction,
        sourceRecordId,
      );
      if (
        recognitionSourceAssociation === undefined ||
        context.sourceIdentity !==
          recognitionSourceAssociation.sourceIdentity ||
        context.nativeAddress !== recognitionSourceAssociation.nativeAddress
      )
        continue;
      transaction
        .insert(sourceLineageHeads)
        .values({
          subjectId: accepted.entity.id,
          sourceIdentity: context.sourceIdentity,
          nativeAddress: context.nativeAddress,
          coverageId: context.coverageId,
          sourceRecordId,
        })
        .onConflictDoNothing()
        .run();
      const head = transaction
        .select({ sourceRecordId: sourceLineageHeads.sourceRecordId })
        .from(sourceLineageHeads)
        .where(
          and(
            eq(sourceLineageHeads.subjectId, accepted.entity.id),
            eq(sourceLineageHeads.sourceIdentity, context.sourceIdentity),
            eq(sourceLineageHeads.nativeAddress, context.nativeAddress),
            eq(sourceLineageHeads.coverageId, context.coverageId),
          ),
        )
        .get();
      // 重新接受的旧版范围可能已经有更新的头部。绝不能让其旧解释覆盖当前候选谱系。
      if (head?.sourceRecordId !== sourceRecordId) continue;
      this.persistCurrentSourceArtifactCandidateLineageWithDrizzle(
        transaction,
        {
          subjectId: accepted.entity.id,
          sourceAssociation: recognitionSourceAssociation,
          record: this.sourceRecordWithDrizzle(transaction, sourceRecordId),
          interpretation: interpretation!,
        },
      );
    }

    this.insertOrVerifyArtifactFactsWithDrizzle(
      transaction,
      accepted,
      accepted.entity.id,
    );
    this.attachAcceptedSourceArtifactAssociationProvenanceWithDrizzle(
      transaction,
      accepted,
    );

    for (const assertion of accepted.metadata) {
      const primary = assertion.sourceRecordIds[0];
      const subjectId = entityTargetId(assertion) ?? accepted.entity.id;
      // 一个包可以从每个成员资产投影作品事实。只要来源槽相同，该事实仍是同一条
      // 来源所有的断言。
      const context =
        primary === undefined
          ? undefined
          : this.sourceRecordContextWithDrizzle(transaction, primary);
      const existing =
        context === undefined
          ? undefined
          : transaction
              .select({
                id: metadataAssertions.id,
                sourceRecordIdsJson: metadataAssertions.sourceRecordIdsJson,
                producerJson: metadataAssertions.producerJson,
              })
              .from(metadataAssertions)
              .innerJoin(
                metadataAssertionLifecycles,
                eq(
                  metadataAssertionLifecycles.assertionId,
                  metadataAssertions.id,
                ),
              )
              .where(
                and(
                  eq(metadataAssertions.subjectId, subjectId),
                  eq(metadataAssertions.targetKind, assertion.target.kind),
                  assertion.target.kind === "entity"
                    ? eq(
                        metadataAssertions.targetEntityId,
                        assertion.target.entityId,
                      )
                    : and(
                        eq(
                          metadataAssertions.targetArtifactId,
                          assertion.target.artifactId,
                        ),
                        eq(
                          metadataAssertions.targetRevisionId,
                          assertion.target.revisionId,
                        ),
                      ),
                  eq(metadataAssertions.property, assertion.property),
                  eq(metadataAssertions.value, assertion.value),
                  eq(
                    metadataAssertions.qualifiersJson,
                    JSON.stringify(assertion.qualifiers ?? []),
                  ),
                  eq(
                    metadataAssertionLifecycles.sourceSlot,
                    assertion.sourceSlot,
                  ),
                  eq(
                    metadataAssertionLifecycles.sourceIdentity,
                    context.sourceIdentity,
                  ),
                  eq(
                    metadataAssertionLifecycles.nativeAddress,
                    context.nativeAddress,
                  ),
                  eq(
                    metadataAssertionLifecycles.coverageId,
                    context.coverageId,
                  ),
                ),
              )
              .get();
      if (existing !== undefined) {
        assertCompatibleProducer(
          existing.producerJson,
          assertion.producer,
          "Metadata Assertion",
        );
        const provenance = new Set([
          ...(JSON.parse(existing.sourceRecordIdsJson) as string[]),
          ...assertion.sourceRecordIds,
        ]);
        transaction
          .update(metadataAssertions)
          .set({
            sourceRecordIdsJson: JSON.stringify([...provenance].toSorted()),
            producerJson: sql`COALESCE(${metadataAssertions.producerJson}, ${producerJson(assertion.producer)})`,
          })
          .where(eq(metadataAssertions.id, existing.id))
          .run();
        for (const sourceRecordId of assertion.sourceRecordIds)
          transaction
            .insert(metadataAssertionSources)
            .values({ assertionId: existing.id, sourceRecordId })
            .onConflictDoNothing()
            .run();
        continue;
      }
      const result = transaction
        .insert(metadataAssertions)
        .values({
          subjectId,
          ...descriptionTargetColumns(assertion.target),
          recognitionDecisionId: assertion.recognitionDecisionId ?? null,
          property: assertion.property,
          value: assertion.value,
          sourceRecordIdsJson: JSON.stringify(assertion.sourceRecordIds),
          qualifiersJson: JSON.stringify(assertion.qualifiers ?? []),
          sourceSlot: assertion.sourceSlot,
          observedArtifactPartJson:
            assertion.observedArtifactPart === undefined
              ? null
              : JSON.stringify(assertion.observedArtifactPart),
          authoredByJson:
            assertion.authoredBy === undefined
              ? null
              : JSON.stringify(assertion.authoredBy),
          producerJson: producerJson(assertion.producer),
        })
        .run();
      const assertionId = Number(result.lastInsertRowid);
      for (const sourceRecordId of assertion.sourceRecordIds)
        transaction
          .insert(metadataAssertionSources)
          .values({ assertionId, sourceRecordId })
          .onConflictDoNothing()
          .run();
      if (context !== undefined)
        transaction
          .insert(metadataAssertionLifecycles)
          .values({
            assertionId,
            sourceIdentity: context.sourceIdentity,
            nativeAddress: context.nativeAddress,
            coverageId: context.coverageId,
            sourceSlot: assertion.sourceSlot,
            sourceRecordId: primary!,
            predecessorAssertionId: null,
          })
          .run();
    }

    for (const relationship of accepted.relationships ?? []) {
      const existing = transaction
        .select()
        .from(entityRelationships)
        .where(eq(entityRelationships.id, relationship.id))
        .get();
      if (existing !== undefined) {
        if (
          existing.type !== relationship.type ||
          existing.participantsJson !==
            JSON.stringify(relationship.participants) ||
          existing.qualifiersJson !==
            JSON.stringify(relationship.qualifiers ?? [])
        )
          throw new Error(
            `Entity Relationship ${relationship.id} conflicts with an existing semantic fact`,
          );
        assertCompatibleProducer(
          existing.producerJson,
          relationship.producer,
          "Entity Relationship",
        );
        const provenance = new Set([
          ...(JSON.parse(existing.sourceRecordIdsJson) as string[]),
          ...relationship.sourceRecordIds,
        ]);
        transaction
          .update(entityRelationships)
          .set({
            sourceRecordIdsJson: JSON.stringify([...provenance].toSorted()),
            producerJson: sql`COALESCE(${entityRelationships.producerJson}, ${producerJson(relationship.producer)})`,
          })
          .where(eq(entityRelationships.id, relationship.id))
          .run();
        for (const sourceRecordId of relationship.sourceRecordIds)
          transaction
            .insert(relationshipSources)
            .values({ relationshipId: relationship.id, sourceRecordId })
            .onConflictDoNothing()
            .run();
        continue;
      }
      transaction
        .insert(entityRelationships)
        .values({
          id: relationship.id,
          type: relationship.type,
          participantsJson: JSON.stringify(relationship.participants),
          sourceRecordIdsJson: JSON.stringify(relationship.sourceRecordIds),
          qualifiersJson: JSON.stringify(relationship.qualifiers ?? []),
          producerJson: producerJson(relationship.producer),
        })
        .run();
      for (const participant of relationship.participants)
        transaction
          .insert(entityRelationshipParticipants)
          .values({
            relationshipId: relationship.id,
            entityId: participant.entityId,
            role: participant.role,
            mentionIdsJson: JSON.stringify(participant.mentionIds ?? []),
          })
          .onConflictDoNothing()
          .run();
      for (const sourceRecordId of relationship.sourceRecordIds)
        transaction
          .insert(relationshipSources)
          .values({ relationshipId: relationship.id, sourceRecordId })
          .onConflictDoNothing()
          .run();
      const primary = relationship.sourceRecordIds[0];
      if (primary !== undefined) {
        const context = this.sourceRecordContextWithDrizzle(
          transaction,
          primary,
        );
        transaction
          .insert(relationshipLifecycles)
          .values({
            relationshipId: relationship.id,
            sourceSubjectId: relationshipSourceSubjectId(
              accepted.entity.id,
              relationship,
            ),
            sourceIdentity: context.sourceIdentity,
            nativeAddress: context.nativeAddress,
            coverageId: context.coverageId,
            sourceRecordId: primary,
            sourceSlot: relationship.sourceSlot,
            predecessorRelationshipId: null,
          })
          .run();
      }
    }

    for (const mention of accepted.entityMentions ?? [])
      transaction
        .insert(entityMentions)
        .values({
          id: mention.id,
          sourceIdentity: mention.sourceIdentity,
          field: mention.field,
          role: mention.role,
          label: mention.label,
          identityNamespace: mention.identityNamespace,
          sourceKey: mention.sourceKey,
          sourceRecordIdsJson: JSON.stringify(mention.sourceRecordIds),
          producerJson: producerJson(mention.producer),
        })
        .onConflictDoNothing()
        .run();
    for (const decision of accepted.entityResolutionDecisions ?? [])
      transaction
        .insert(entityResolutionDecisions)
        .values({
          id: decision.id,
          mentionId: decision.mentionId,
          entityId: decision.entityId,
          rule: decision.rule,
          sourceRecordIdsJson: JSON.stringify(decision.sourceRecordIds),
          producerJson: producerJson(decision.producer),
        })
        .run();
    this.insertObservedEntityGraphsWithDrizzle(transaction, accepted);
  }

  /**
   * 本地格式图和外部来源图共享关系事实及参与者索引；其支持严格落在产物／修订版
   * 上，因此不能进入 SourceRecord 生命周期。
   */
  private insertObservedEntityGraphsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    accepted: AcceptedRecognition,
  ): void {
    for (const graph of accepted.observedEntityGraphs ?? []) {
      for (const entity of graph.entities) {
        transaction
          .insert(entities)
          .values({ id: entity.id })
          .onConflictDoNothing()
          .run();
        transaction
          .insert(observedEntities)
          .values({
            id: entity.id,
            assetId: graph.assetId,
            artifactId: graph.artifactId,
            producerJson: JSON.stringify(graph.producer),
            coverageId: graph.coverageId,
            occurrenceSlot: entity.occurrenceSlot,
            preservedValue: entity.preservedValue,
            label: entity.label,
            locator: entity.locator,
          })
          .onConflictDoNothing()
          .run();
      }
      for (const mention of graph.mentions)
        transaction
          .insert(observedEntityMentions)
          .values({
            id: mention.id,
            entityId: mention.entityId,
            revisionId: graph.revisionId,
            sourceSlot: mention.sourceSlot,
            field: mention.field,
            role: mention.role,
            label: mention.label,
            locator: mention.locator,
          })
          .onConflictDoNothing()
          .run();
      for (const resolution of graph.resolutions)
        transaction
          .insert(observedEntityResolutions)
          .values(resolution)
          .onConflictDoNothing()
          .run();

      const producer = JSON.stringify(graph.producer);
      const graphId = `observed-entity-graph_${sha256Text(
        JSON.stringify([
          accepted.recognitionDecision.id,
          graph.artifactId,
          graph.revisionId,
          graph.producer,
          graph.coverageId,
        ]),
      )}`;
      transaction
        .insert(observedEntityGraphSupports)
        .values({
          id: graphId,
          recognitionDecisionId: accepted.recognitionDecision.id,
          assetId: graph.assetId,
          artifactId: graph.artifactId,
          revisionId: graph.revisionId,
          producerJson: producer,
          coverageId: graph.coverageId,
        })
        .onConflictDoNothing()
        .run();
      for (const entity of graph.entities)
        transaction
          .insert(observedEntityGraphEntities)
          .values({ graphId, entityId: entity.id })
          .onConflictDoNothing()
          .run();
      for (const relationship of graph.relationships) {
        transaction
          .insert(entityRelationships)
          .values({
            id: relationship.id,
            type: relationship.type,
            participantsJson: JSON.stringify(relationship.participants),
            sourceRecordIdsJson: "[]",
            qualifiersJson: JSON.stringify(relationship.qualifiers ?? []),
            producerJson: producer,
          })
          .onConflictDoNothing()
          .run();
        for (const participant of relationship.participants)
          transaction
            .insert(entityRelationshipParticipants)
            .values({
              relationshipId: relationship.id,
              entityId: participant.entityId,
              role: participant.role,
              mentionIdsJson: JSON.stringify(participant.mentionIds ?? []),
            })
            .onConflictDoNothing()
            .run();
        transaction
          .insert(observedEntityGraphRelationships)
          .values({
            graphId,
            relationshipId: relationship.id,
            sourceSlot: relationship.sourceSlot,
          })
          .onConflictDoNothing()
          .run();
      }
    }
  }

  /**
   * 保持身份的重新评估会追加不可变物料事实，并结束被新完整解释取代的来源所有关联。
   */
  private insertReevaluatedArtifactFactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    current: AcceptedRecognition,
    accepted: AcceptedRecognition,
  ): void {
    this.insertOrVerifyArtifactFactsWithDrizzle(
      transaction,
      accepted,
      accepted.entity.id,
    );
    this.attachAcceptedSourceArtifactAssociationProvenanceWithDrizzle(
      transaction,
      accepted,
    );
    this.replaceLocalObservedMetadataWithDrizzle(
      transaction,
      current,
      accepted,
    );
    this.insertObservedEntityGraphsWithDrizzle(transaction, accepted);

    const retainedIds = new Set(
      accepted.artifactAssociations.map((association) => association.id),
    );
    const currentInterpretation = recognitionSourceInterpretation(
      current.proposal,
    );
    const nextInterpretation = recognitionSourceInterpretation(
      accepted.proposal,
    );
    const currentSourceRecordIds = new Set(
      currentInterpretation?.sourceRecordIds ?? [],
    );
    const nextSourceRecordIds = new Set(
      nextInterpretation?.sourceRecordIds ?? [],
    );
    const ownedBy = (
      association: ArtifactAssociation,
      sourceRecordIds: ReadonlySet<string>,
    ) =>
      association.sourceRecordIds !== undefined &&
      association.sourceRecordIds.length > 0 &&
      association.sourceRecordIds.every((id) => sourceRecordIds.has(id));
    const removed = current.artifactAssociations.filter(
      (association) =>
        !retainedIds.has(association.id) &&
        !this.hasValidObservedMaterialSupportWithDrizzle(
          transaction,
          association,
        ) &&
        ((accepted.proposal.basis.kind !== "accepted-boundary" &&
          ownedBy(association, currentSourceRecordIds)) ||
          association.observedArtifactPart !== undefined ||
          (current.proposal.basis.kind === "manual-boundary" &&
            accepted.proposal.basis.kind === "manual-boundary" &&
            association.role === "asset.material-delivered" &&
            (association.sourceRecordIds?.length ?? 0) === 0)),
    );
    const successors = accepted.artifactAssociations.filter(
      (association) =>
        ownedBy(association, nextSourceRecordIds) ||
        association.observedArtifactPart !== undefined,
    );
    for (const predecessor of removed) {
      const sameCoordinatePredecessors = removed.filter(
        (association) =>
          sameDescriptionTarget(association.target, predecessor.target) &&
          association.role === predecessor.role,
      );
      const sameCoordinateSuccessors = successors.filter(
        (association) =>
          sameDescriptionTarget(association.target, predecessor.target) &&
          association.role === predecessor.role,
      );
      if (
        sameCoordinatePredecessors.length === 1 &&
        sameCoordinateSuccessors.length === 1
      ) {
        transaction
          .insert(artifactAssociationSupersessions)
          .values({
            id: `artifact-association-supersession_${accepted.proposal.id}_${predecessor.id}`,
            predecessorAssociationId: predecessor.id,
            successorAssociationId: sameCoordinateSuccessors[0]!.id,
          })
          .run();
      } else if (
        predecessor.observedArtifactPart !== undefined ||
        (accepted.proposal.basis.kind === "manual-boundary" &&
          (predecessor.sourceRecordIds?.length ?? 0) === 0)
      ) {
        // 本地格式修订可以直接停止暴露某个部分。这是本地生命周期事件，
        // 不是外部来源断言。
        transaction
          .insert(artifactAssociationRetractions)
          .values({
            id: `local-artifact-association-retraction_${accepted.proposal.id}_${predecessor.id}`,
            associationId: predecessor.id,
            recognitionDecisionId: null,
            proposalId: accepted.proposal.id,
            sourceRecordIdsJson: "[]",
          })
          .run();
      } else {
        const predecessorSourceRecords = (
          predecessor.sourceRecordIds ?? []
        ).map((sourceRecordId) =>
          this.sourceRecordWithDrizzle(transaction, sourceRecordId),
        );
        const retractionSourceRecordIds = (
          nextInterpretation?.sourceRecordIds ?? []
        ).filter((sourceRecordId) => {
          const sourceRecord = this.sourceRecordWithDrizzle(
            transaction,
            sourceRecordId,
          );
          return (
            sourceRecord.coverage.completeness === "complete" &&
            sourceRecord.coverage.authority === "official" &&
            predecessorSourceRecords.some(
              (predecessorSourceRecord) =>
                predecessorSourceRecord.sourceIdentity ===
                  sourceRecord.sourceIdentity &&
                predecessorSourceRecord.nativeAddress ===
                  sourceRecord.nativeAddress &&
                predecessorSourceRecord.coverage.id ===
                  sourceRecord.coverage.id,
            )
          );
        });
        const retraction: ArtifactAssociationRetraction = {
          id: `artifact-association-retraction_${accepted.proposal.id}_${predecessor.id}`,
          associationId: predecessor.id,
          proposalId: accepted.proposal.id,
          sourceRecordIds: retractionSourceRecordIds,
        };
        validateArtifactAssociationRetraction({
          retraction,
          predecessor,
          predecessorSourceRecords,
          proposal: accepted.proposal,
          sourceRecords: (nextInterpretation?.sourceRecordIds ?? []).map(
            (sourceRecordId) =>
              this.sourceRecordWithDrizzle(transaction, sourceRecordId),
          ),
        });
        transaction
          .insert(artifactAssociationRetractions)
          .values({
            id: retraction.id,
            associationId: retraction.associationId,
            recognitionDecisionId: null,
            proposalId: retraction.proposalId,
            sourceRecordIdsJson: JSON.stringify(retraction.sourceRecordIds),
          })
          .run();
      }
    }
    const sourceAssociation = accepted.recognitionSourceAssociation;
    if (sourceAssociation !== undefined && nextInterpretation !== undefined) {
      this.supersedeCurrentManagedSourceArtifactsWithDrizzle(transaction, {
        subjectId: accepted.entity.id,
        sourceAssociationId: sourceAssociation.id,
        sourceRecordIds: nextInterpretation.sourceRecordIds,
        proposalId: accepted.proposal.id,
        transitionId: accepted.proposal.id,
        submittedAssociations: accepted.artifactAssociations.flatMap(
          (association) =>
            entityTargetId(association) === accepted.entity.id &&
            ownedBy(association, nextSourceRecordIds)
              ? [{ id: association.id, role: association.role }]
              : [],
        ),
      });
    }
  }

  /**
   * 资产每个决定声明的完整范围成员，并标注该决定是否已被取代／撤回结束。有效范围推导、
   * 相交声明查询与提交基线比较共用这一份根坐标解析。
   */
  private recognitionMaterialBoundaryMembersWithDrizzle(
    query: DrizzleReadQuery,
    assetId: string,
  ): {
    readonly member: EffectiveRecognitionMaterialBoundary;
    readonly endedAs?: "superseded" | "retracted";
  }[] {
    const rows: {
      readonly member: EffectiveRecognitionMaterialBoundary;
      readonly endedAs?: "superseded" | "retracted";
    }[] = [];
    const decisions = query
      .select()
      .from(recognitionDecisions)
      .where(eq(recognitionDecisions.assetId, assetId))
      .all();
    const endedAs = this.recognitionDecisionEndingsWithDrizzle(
      query,
      decisions.map((decision) => decision.id),
    );
    const boundaries = decisions.flatMap((decision) =>
      (
        JSON.parse(decision.boundariesJson) as RecognitionDecision["boundaries"]
      ).map((boundary) => ({ decisionId: decision.id, boundary })),
    );
    const rootPaths = this.recognitionMaterialBoundaryRootPathsWithDrizzle(
      query,
      boundaries.map(({ boundary }) => boundary.scopeReference),
    );
    for (const { decisionId, boundary } of boundaries) {
      const rootPath = rootPaths.get(boundary.scopeReference);
      if (rootPath === undefined) continue;
      const reason = endedAs.get(decisionId);
      rows.push({
        member: { assetId, decisionId, boundary, rootPath },
        ...(reason === undefined ? {} : { endedAs: reason }),
      });
    }
    return rows;
  }

  /**
   * 边界 scopeReference 到实际观察根坐标的唯一解析：注册根优先，其次已知历史执行
   * 快照。逐资产有效范围与相交声明查询共用，绝不各自解释根坐标。
   */
  private recognitionMaterialBoundaryRootPathsWithDrizzle(
    query: DrizzleReadQuery,
    scopeReferences: readonly string[],
  ): Map<string, string> {
    const paths = new Map<string, string>();
    const registered = [
      ...new Set(
        scopeReferences.filter(
          (reference) => !reference.startsWith("legacy-execution:"),
        ),
      ),
    ];
    if (registered.length !== 0)
      for (const row of query
        .select({
          id: observedRootRegistrations.id,
          containerPath: observedRootRegistrations.containerPath,
        })
        .from(observedRootRegistrations)
        .where(inArray(observedRootRegistrations.id, registered))
        .all())
        paths.set(row.id, row.containerPath);
    const legacy = [
      ...new Set(
        scopeReferences
          .filter((reference) => reference.startsWith("legacy-execution:"))
          .map((reference) => reference.slice("legacy-execution:".length)),
      ),
    ];
    if (legacy.length !== 0)
      for (const row of query
        .select({
          id: workflowExecutions.id,
          snapshotJson: workflowExecutions.snapshotJson,
          materialAssociationJson: workflowExecutions.materialAssociationJson,
        })
        .from(workflowExecutions)
        .where(inArray(workflowExecutions.id, legacy))
        .all()) {
        const root =
          (row.snapshotJson == null
            ? undefined
            : (JSON.parse(row.snapshotJson) as FilesystemPackageSnapshot)
                .root) ??
          (row.materialAssociationJson == null
            ? undefined
            : (
                JSON.parse(row.materialAssociationJson) as {
                  snapshot?: FilesystemPackageSnapshot;
                }
              ).snapshot?.root);
        if (root !== undefined) paths.set(`legacy-execution:${row.id}`, root);
      }
    return paths;
  }

  /** 决定的结束原因：被取代优先，其次被撤回；没有结束的不在结果里。 */
  private recognitionDecisionEndingsWithDrizzle(
    query: DrizzleReadQuery,
    decisionIds: readonly string[],
  ): Map<string, "superseded" | "retracted"> {
    const endedAs = new Map<string, "superseded" | "retracted">();
    const ids = [...new Set(decisionIds)];
    if (ids.length === 0) return endedAs;
    for (const row of query
      .select({
        decisionId: recognitionDecisionSupersessions.predecessorDecisionId,
      })
      .from(recognitionDecisionSupersessions)
      .where(
        inArray(recognitionDecisionSupersessions.predecessorDecisionId, ids),
      )
      .all())
      endedAs.set(row.decisionId, "superseded");
    for (const row of query
      .select({
        decisionId: recognitionDecisionRetractions.predecessorDecisionId,
      })
      .from(recognitionDecisionRetractions)
      .where(inArray(recognitionDecisionRetractions.predecessorDecisionId, ids))
      .all())
      if (!endedAs.has(row.decisionId))
        endedAs.set(row.decisionId, "retracted");
    return endedAs;
  }

  /** 资产当前仍生效的规范范围：排除被取代与被撤回的决定。 */
  private effectiveMaterialBoundariesWithDrizzle(
    query: DrizzleReadQuery,
    assetId: string,
  ): EffectiveRecognitionMaterialBoundary[] {
    return this.recognitionMaterialBoundaryMembersWithDrizzle(query, assetId)
      .filter((row) => row.endedAs === undefined)
      .map((row) => row.member);
  }

  /**
   * 本地关联支持的唯一写入接缝：必须在材料形态边界与本次观察都已落库之后运行，
   * 因为证据以形态边界为权威。首次准入按本次决定写一条；范围刷新按每条仍生效的
   * 决定授权各写一条。
   */
  private writeLocalAssociationSupportsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    accepted: AcceptedRecognition,
  ): void {
    if (accepted.proposal.basis.kind === "accepted-boundary") {
      this.attachCurrentBoundarySupportsWithDrizzle(transaction, accepted);
      return;
    }
    if (
      (accepted.proposal.observedArtifactAssociations?.length ?? 0) === 0 &&
      (accepted.proposal.observedArtifactParts?.length ?? 0) === 0
    )
      return;
    const declaredRevisions = [
      ...(accepted.proposal.observedArtifactRevisions ?? []),
      ...(accepted.proposal.basis.kind === "observed-evidence"
        ? accepted.proposal.basis.artifactRevisions
        : []),
      ...(accepted.proposal.basis.kind === "manual-boundary"
        ? accepted.proposal.basis.evidence.flatMap((evidence) =>
            evidence.inspection === undefined
              ? []
              : [
                  {
                    observedArtifactReference:
                      evidence.inspection.observedArtifactReference,
                    blob: evidence.inspection.revision,
                  },
                ],
          )
        : []),
    ];
    // 所有无外部来源的本地关联共用同一条支持路径：直接文件、part、实体与
    // revision 目标都按本次观察写精确证据。
    const carrier = this.proposalObservationCarrierWithDrizzle(
      transaction,
      accepted.proposal.id,
    );
    for (const association of accepted.artifactAssociations) {
      if (
        (association.sourceRecordIds?.length ?? 0) > 0 ||
        association.sourceAssociationId !== undefined
      )
        continue;
      // 同一角色可能服务不同产物，也可能包含同一产物的多个位置；先逐个钉住本关联
      // 自身（或 part 载体）的声明坐标，不能用第一个同角色候选代替其他材料。
      const materialArtifactId =
        association.observedArtifactPart?.artifactId ?? association.artifactId;
      const ownAddresses = accepted.locations
        .filter(
          (item) =>
            item.kind === "observed" && item.artifactId === materialArtifactId,
        )
        .map((item) => path.resolve(item.address));
      const sameRoleCandidates = (
        accepted.proposal.observedArtifactAssociations ?? []
      ).filter((item) => item.role === association.role);
      const pinnedCandidates =
        carrier === undefined
          ? []
          : sameRoleCandidates.filter((item) =>
              ownAddresses.includes(
                path.resolve(
                  carrier.snapshotRoot,
                  item.observedArtifactReference,
                ),
              ),
            );
      if (
        ownAddresses.length > 1 &&
        !ownAddresses.every((address) =>
          pinnedCandidates.some(
            (candidate) =>
              carrier !== undefined &&
              path.resolve(
                carrier.snapshotRoot,
                candidate.observedArtifactReference,
              ) === address,
          ),
        )
      )
        continue;
      const candidates =
        pinnedCandidates.length > 0
          ? pinnedCandidates.toSorted((left, right) =>
              left.observedArtifactReference.localeCompare(
                right.observedArtifactReference,
              ),
            )
          : [
              ownAddresses.length === 0 && sameRoleCandidates.length === 1
                ? sameRoleCandidates[0]
                : undefined,
            ];
      const observations = candidates.map((candidate) => {
        const digests =
          candidate === undefined
            ? []
            : [
                ...new Set(
                  declaredRevisions
                    .filter(
                      (revision) =>
                        revision.observedArtifactReference ===
                        candidate.observedArtifactReference,
                    )
                    .map((revision) => revision.blob.digest),
                ),
              ];
        if (candidates.length > 1 && digests.length !== 1) return undefined;
        return this.localObservationEvidenceWithDrizzle(transaction, {
          association,
          accepted,
          carrier,
          ...(candidate === undefined
            ? {}
            : {
                observedArtifactReference: candidate.observedArtifactReference,
              }),
          ...(digests.length === 1 ? { revisionDigest: digests[0] } : {}),
        });
      });
      const observation = observations[0];
      // 一行支持足以证明同一产物修订；多个位置必须各自证明同一载体和修订，
      // 才能使用排序后的确定坐标。缺失或不同修订不能因有另一条成功而被吞掉。
      if (
        observation === undefined ||
        (observations.length > 1 && observation.revisionId === undefined) ||
        observations.some(
          (item) =>
            item === undefined ||
            item.executionId !== observation.executionId ||
            item.snapshotId !== observation.snapshotId ||
            item.materialKind !== observation.materialKind ||
            item.revisionId !== observation.revisionId,
        )
      )
        continue;
      this.upsertLocalAssociationSupportWithDrizzle(transaction, {
        associationId: association.id,
        decisionId: accepted.recognitionDecision.id,
        observation,
      });
    }
  }

  /**
   * 本地关联支持的唯一写入形状：一个决定的范围授权，加上建立它那次观察的精确证据。
   * 已存在同一授权对时只推进证据，因此新材料或新修订不会被旧行挡住。
   */
  private upsertLocalAssociationSupportWithDrizzle(
    query: DrizzleWriteTransaction,
    input: {
      readonly associationId: string;
      readonly decisionId: string;
      readonly observation: LocalObservationEvidence;
    },
  ): void {
    const values = {
      observationExecutionId: input.observation.executionId,
      observationSnapshotId: input.observation.snapshotId,
      observationLocationId: input.observation.locationId,
      observationMaterialKind: input.observation.materialKind,
      observationRevisionId: input.observation.revisionId ?? null,
    };
    query
      .insert(artifactAssociationRecognitionSupports)
      .values({
        associationId: input.associationId,
        recognitionDecisionId: input.decisionId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          artifactAssociationRecognitionSupports.associationId,
          artifactAssociationRecognitionSupports.recognitionDecisionId,
        ],
        set: values,
      })
      .run();
  }

  /**
   * 一条本地产物关联在这次观察里的精确证据。材料位置按关联自身或 part 的载体定位；
   * part 绑定载体修订，目录形态没有单一文件修订。任何一处不能唯一证明时返回
   * `undefined`，由调用方保留只带授权的历史语义。
   */
  private localObservationEvidenceWithDrizzle(
    query: DrizzleReadQuery,
    input: {
      readonly association: ArtifactAssociation;
      readonly accepted: AcceptedRecognition;
      readonly carrier: ObservationCarrier | undefined;
      readonly observedArtifactReference?: string | undefined;
      readonly revisionDigest?: string | undefined;
      /** 重叠根下同一材料可能有多个位置：只承认授权该范围的那个根的观察位置。 */
      readonly within?: EffectiveRecognitionMaterialBoundary | undefined;
    },
  ): LocalObservationEvidence | undefined {
    if (input.carrier === undefined) return undefined;
    const association = input.association;
    const materialArtifactId =
      association.observedArtifactPart?.artifactId ?? association.artifactId;
    // 材料引用按生产坐标解释：离散文件是快照根内的相对路径，整包目录形态是 "."，
    // 其观察位置地址就是快照根本身。
    const pinnedAddress =
      input.observedArtifactReference === undefined
        ? undefined
        : path.resolve(
            input.carrier.snapshotRoot,
            input.observedArtifactReference,
          );
    const locations = input.accepted.locations.filter(
      (item) =>
        item.kind === "observed" &&
        item.artifactId === materialArtifactId &&
        (input.within === undefined ||
          materialBoundaryIncludesAddress(input.within, item.address)) &&
        (pinnedAddress === undefined ||
          path.resolve(item.address) === pinnedAddress),
    );
    if (locations.length !== 1) return undefined;
    const location = locations[0]!;
    const materialKind = query
      .select({
        materialKind: observedMaterialBoundaries.materialKind,
      })
      .from(observedMaterialBoundaries)
      .where(eq(observedMaterialBoundaries.locationId, location.id))
      .get()?.materialKind;
    if (materialKind !== "file" && materialKind !== "directory")
      return undefined;
    if (materialKind === "directory")
      return { ...input.carrier, locationId: location.id, materialKind };
    const revisions = input.accepted.artifactRevisions.filter((item) => {
      if (item.artifactId !== materialArtifactId) return false;
      if (association.observedArtifactPart !== undefined)
        return item.id === association.observedArtifactPart.revisionId;
      return (
        input.revisionDigest === undefined ||
        item.blobDigest === input.revisionDigest
      );
    });
    if (revisions.length !== 1) return undefined;
    return {
      ...input.carrier,
      locationId: location.id,
      materialKind,
      revisionId: revisions[0]!.id,
    };
  }

  /** 提案所属执行与快照：支持证据只承认这次观察自己的载体。 */
  private proposalObservationCarrierWithDrizzle(
    query: DrizzleReadQuery,
    proposalId: string,
  ):
    | {
        readonly executionId: string;
        readonly snapshotId: string;
        readonly snapshotRoot: string;
      }
    | undefined {
    const row = query
      .select({ executionId: recognitionProposals.executionId })
      .from(recognitionProposals)
      .where(eq(recognitionProposals.id, proposalId))
      .get();
    if (row === undefined) return undefined;
    const execution =
      this.workflowExecutionPersistence.readExecutionWithDrizzle(
        query,
        row.executionId,
      );
    if (execution?.snapshot === undefined) return undefined;
    return {
      executionId: row.executionId,
      snapshotId: execution.snapshot.id,
      snapshotRoot: execution.snapshot.root,
    };
  }

  /** 材料刷新使用所有仍生效的决定支持，不能把补充范围改挂到主 head。 */
  private attachCurrentBoundarySupportsWithDrizzle(
    query: DrizzleWriteTransaction,
    accepted: AcceptedRecognition,
  ): void {
    if (accepted.proposal.basis.kind !== "accepted-boundary") return;
    const effective = this.effectiveMaterialBoundariesWithDrizzle(
      query,
      accepted.entity.id,
    );
    for (const location of accepted.locations.filter(
      (item) => item.kind === "observed",
    ))
      if (
        !effective.some((item) =>
          materialBoundaryIncludesAddress(item, location.address),
        )
      )
        throw new Error("材料刷新超出仍生效的资产范围，请先确认范围变更");
    const carrier = this.proposalObservationCarrierWithDrizzle(
      query,
      accepted.proposal.id,
    );
    for (const association of accepted.artifactAssociations) {
      if (
        (association.sourceRecordIds?.length ?? 0) > 0 ||
        association.sourceAssociationId !== undefined
      )
        continue;
      const materialArtifactId =
        association.observedArtifactPart?.artifactId ?? association.artifactId;
      const locations = accepted.locations.filter(
        (item) =>
          item.kind === "observed" && item.artifactId === materialArtifactId,
      );
      // 逐条仍生效的范围授权各写一行，证据落在该范围自己的根观察位置上。
      for (const boundary of effective.filter((item) =>
        locations.some((location) =>
          materialBoundaryIncludesAddress(item, location.address),
        ),
      )) {
        const observation = this.localObservationEvidenceWithDrizzle(query, {
          association,
          accepted,
          carrier,
          within: boundary,
        });
        if (observation === undefined) continue;
        this.upsertLocalAssociationSupportWithDrizzle(query, {
          associationId: association.id,
          decisionId: boundary.decisionId,
          observation,
        });
      }
    }
  }

  /**
   * 派生实体封面的当前判定行集：按数据库行识别（检查点提交的关联对象不带观察部件），不是
   * 这种封面就返回 undefined 让调用方保持原判定。决定只装载未结束的那些，因此决定结束后
   * 旧封面自然拿不到当前角色。
   */
  private derivedCoverCurrentRowsWithDrizzle(
    query: DrizzleReadQuery,
    associationId: string,
  ): DerivedCoverCurrentRows | undefined {
    const cover = query
      .select()
      .from(artifactAssociations)
      .where(eq(artifactAssociations.id, associationId))
      .get();
    if (
      cover === undefined ||
      cover.role !== "asset.primary-cover" ||
      cover.targetKind !== "entity" ||
      cover.observedArtifactPartJson === null
    )
      return undefined;
    const siblingId = derivedCoverSiblingId(cover.id);
    const associationIds =
      siblingId === undefined ? [cover.id] : [cover.id, siblingId];
    const associations = query
      .select()
      .from(artifactAssociations)
      .where(inArray(artifactAssociations.id, sqliteTextSet(associationIds)))
      .all();
    const supports = query
      .select()
      .from(artifactAssociationRecognitionSupports)
      .where(
        inArray(
          artifactAssociationRecognitionSupports.associationId,
          sqliteTextSet(associationIds),
        ),
      )
      .all();
    const decisionIds = [
      ...new Set(supports.map((row) => row.recognitionDecisionId)),
    ];
    const decisions =
      decisionIds.length === 0
        ? []
        : query
            .select()
            .from(recognitionDecisions)
            .where(
              and(
                inArray(recognitionDecisions.id, sqliteTextSet(decisionIds)),
                sql`NOT EXISTS (
                  SELECT 1 FROM recognition_decision_supersessions AS ended
                  WHERE ended.predecessor_decision_id = ${recognitionDecisions.id}
                )
                AND NOT EXISTS (
                  SELECT 1 FROM recognition_decision_retractions AS ended
                  WHERE ended.predecessor_decision_id = ${recognitionDecisions.id}
                )`,
              ),
            )
            .all();
    const proposalIds = [...new Set(decisions.map((row) => row.proposalId))];
    // 内容变化的身份保持刷新由那次观察执行自己的 accepted-boundary 提案声明新事实，当前资格判定
    // 要读到那一行；装载范围放宽几行不改变判定，仍由 `declaringProposalRow` 逐条确认所属执行、
    // 点名的决定与冻结的观察快照。
    const observationExecutionIds = [
      ...new Set(
        supports
          .map((row) => row.observationExecutionId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const proposalRows = [
      ...(proposalIds.length === 0
        ? []
        : query
            .select()
            .from(recognitionProposals)
            .where(inArray(recognitionProposals.id, sqliteTextSet(proposalIds)))
            .all()),
      ...(observationExecutionIds.length === 0
        ? []
        : query
            .select()
            .from(recognitionProposals)
            .where(
              inArray(
                recognitionProposals.executionId,
                sqliteTextSet(observationExecutionIds),
              ),
            )
            .all()),
    ].filter(
      (row, index, rows) =>
        rows.findIndex((candidate) => candidate.id === row.id) === index,
    );
    const part = observedPartOf(cover);
    const revisions =
      part === undefined
        ? []
        : query
            .select()
            .from(artifactRevisions)
            .where(eq(artifactRevisions.id, part.revisionId))
            .all();
    return {
      associations,
      supports,
      decisions,
      proposals: proposalRows,
      revisions,
    };
  }

  /**
   * 当前读取：主体即决定资产的本地关联带精确观察证据时，只按 `isCurrentLocalObservationEvidence`
   * 判定，与正式当前投影共用同一份规则；其余关联仍由历史载体回查决定。派生实体封面额外
   * 要求修正后的代表规则成立，历史结构完整不等于当前角色。
   */
  private hasCurrentLocalObservationSupportWithDrizzle(
    query: DrizzleReadQuery,
    association: ArtifactAssociation,
  ): boolean {
    const derivedCover = this.derivedCoverCurrentRowsWithDrizzle(
      query,
      association.id,
    );
    if (
      derivedCover !== undefined &&
      derivedCoverCurrentlyRepresentative(derivedCover, association.id) !== true
    )
      return false;
    const rows = query
      .select({
        locationId:
          artifactAssociationRecognitionSupports.observationLocationId,
        materialKind:
          artifactAssociationRecognitionSupports.observationMaterialKind,
        revisionId:
          artifactAssociationRecognitionSupports.observationRevisionId,
        decisionAssetId: recognitionDecisions.assetId,
        subjectId: artifactAssociations.subjectId,
      })
      .from(artifactAssociationRecognitionSupports)
      .innerJoin(
        recognitionDecisions,
        eq(
          recognitionDecisions.id,
          artifactAssociationRecognitionSupports.recognitionDecisionId,
        ),
      )
      .innerJoin(
        artifactAssociations,
        eq(
          artifactAssociations.id,
          artifactAssociationRecognitionSupports.associationId,
        ),
      )
      .where(
        and(
          eq(
            artifactAssociationRecognitionSupports.associationId,
            association.id,
          ),
          isNotNull(
            artifactAssociationRecognitionSupports.observationLocationId,
          ),
          eq(artifactAssociations.subjectId, recognitionDecisions.assetId),
          sql`NOT EXISTS (
            SELECT 1 FROM recognition_decision_supersessions AS ended
            WHERE ended.predecessor_decision_id = ${recognitionDecisions.id}
          )
          AND NOT EXISTS (
            SELECT 1 FROM recognition_decision_retractions AS ended
            WHERE ended.predecessor_decision_id = ${recognitionDecisions.id}
          )`,
        ),
      )
      .all();
    const evidence = rows.flatMap((row) =>
      row.locationId === null || row.materialKind === null
        ? []
        : [
            {
              locationId: row.locationId,
              materialKind: row.materialKind,
              revisionId: row.revisionId,
              decisionAssetId: row.decisionAssetId,
              subjectId: row.subjectId,
            },
          ],
    );
    if (evidence.length === 0) return false;
    const evidenceLocationIds = [
      ...new Set(evidence.map((row) => row.locationId)),
    ];
    const evidenceLocations = query
      .select()
      .from(locations)
      .where(inArray(locations.id, sqliteTextSet(evidenceLocationIds)))
      .all();
    return isCurrentLocalObservationEvidence({
      materialArtifactId:
        association.observedArtifactPart?.artifactId ?? association.artifactId,
      ...(association.observedArtifactPart === undefined
        ? {}
        : { partRevisionId: association.observedArtifactPart.revisionId }),
      evidence,
      locationOf: (locationId) =>
        evidenceLocations.find((item) => item.id === locationId),
      positiveSupportLocationIds: new Set(
        evidenceLocations.length === 0
          ? []
          : query
              .select({
                locationId: currentObservedMaterialSupports.locationId,
              })
              .from(currentObservedMaterialSupports)
              .where(
                inArray(
                  currentObservedMaterialSupports.locationId,
                  sqliteTextSet(evidenceLocations.map((item) => item.id)),
                ),
              )
              .all()
              .map((item) => item.locationId),
      ),
      currentLocationRevisionKeys: new Set(
        currentConfirmedLocationRevisions(query, evidenceLocations).map(
          (item) => `${item.locationId}\u0000${item.revisionId}`,
        ),
      ),
    });
  }

  /**
   * 关联仍被承认的支持：带精确观察证据且主体即决定资产的支持只按当前资格成立，过期
   * 证据不能靠历史结构回查重新冒充当前；没有证据列的合法旧行与 c-association 检查点
   * 仍按原载体回查。
   */
  private hasValidObservedMaterialSupportWithDrizzle(
    query: DrizzleReadQuery,
    association: ArtifactAssociation,
  ): boolean {
    /**
     * 派生实体封面的历史回查臂一律不接管：这类封面只有修正代表规则成立才作数，否则完整的
     * 历史结构也不能在当前读取里复活角色（历史真实性由就绪检查单独判定）。
     */
    const derivedCover = this.derivedCoverCurrentRowsWithDrizzle(
      query,
      association.id,
    );
    if (
      derivedCover !== undefined &&
      derivedCoverCurrentlyRepresentative(derivedCover, association.id) !== true
    )
      return false;
    if (this.hasCurrentLocalObservationSupportWithDrizzle(query, association))
      return true;
    const result =
      query
        .select({ id: artifactAssociationRecognitionSupports.associationId })
        .from(artifactAssociationRecognitionSupports)
        .innerJoin(
          recognitionDecisions,
          eq(
            recognitionDecisions.id,
            artifactAssociationRecognitionSupports.recognitionDecisionId,
          ),
        )
        .innerJoin(
          recognitionProposals,
          eq(recognitionProposals.id, recognitionDecisions.proposalId),
        )
        .innerJoin(
          workflowExecutions,
          eq(workflowExecutions.id, recognitionProposals.executionId),
        )
        .where(
          and(
            eq(
              artifactAssociationRecognitionSupports.associationId,
              association.id,
            ),
            isNull(
              artifactAssociationRecognitionSupports.observationLocationId,
            ),
            eq(recognitionDecisions.assetId, entityTargetId(association) ?? ""),
            sql`(
              EXISTS (
                SELECT 1 FROM json_each(json_extract(${workflowExecutions.materialAssociationJson}, '$.submission.projections')) AS projection
                JOIN json_each(json_extract(${recognitionProposals.observedMaterialInterpretationJson}, '$.observedArtifactAssociations')) AS candidate
                  ON json_extract(candidate.value, '$.observedArtifactReference') = json_extract(projection.value, '$.observedArtifactReference')
                 AND json_extract(candidate.value, '$.role') = ${association.role}
                WHERE json_extract(projection.value, '$.associationId') = ${association.id}
                  AND json_extract(projection.value, '$.artifactId') = ${association.artifactId}
              )
              OR EXISTS (
                SELECT 1
                FROM json_each(json_extract(${recognitionProposals.observedMaterialInterpretationJson}, '$.observedArtifactAssociations')) AS projected_candidate
                JOIN json_each(json_extract(${recognitionProposals.observedMaterialInterpretationJson}, '$.observedArtifactRevisions')) AS projected_revision
                  ON json_extract(projected_revision.value, '$.observedArtifactReference') =
                     json_extract(projected_candidate.value, '$.observedArtifactReference')
                JOIN locations AS projected_location
                  ON projected_location.artifact_id = ${association.artifactId}
                 AND projected_location.kind = 'observed'
                 AND projected_location.address = json_extract(${workflowExecutions.snapshotJson}, '$.root') || '/' ||
                     json_extract(projected_candidate.value, '$.observedArtifactReference')
                JOIN artifact_revisions AS durable_revision
                  ON durable_revision.artifact_id = ${association.artifactId}
                 AND durable_revision.blob_digest = json_extract(projected_revision.value, '$.blob.digest')
                WHERE json_extract(projected_candidate.value, '$.role') = ${association.role}
              )
              OR EXISTS (
                SELECT 1
                FROM locations AS legacy_location
                JOIN artifact_revisions AS legacy_revision
                  ON legacy_revision.artifact_id = ${association.artifactId}
                WHERE legacy_location.artifact_id = ${association.artifactId}
                  AND legacy_location.kind = 'observed'
                  AND (
                    (json_extract(${recognitionProposals.basisJson}, '$.kind') = 'observed-evidence'
                     AND EXISTS (
                       SELECT 1 FROM json_each(json_extract(${recognitionProposals.basisJson}, '$.artifactRevisions')) AS material
                       WHERE legacy_location.address = json_extract(${workflowExecutions.snapshotJson}, '$.root') || '/' ||
                         json_extract(material.value, '$.observedArtifactReference')
                         AND legacy_revision.blob_digest = json_extract(material.value, '$.blob.digest')
                     ))
                    OR
                    (json_extract(${recognitionProposals.basisJson}, '$.kind') = 'manual-boundary'
                     AND EXISTS (
                       SELECT 1
                       FROM json_each(json_extract(${recognitionProposals.basisJson}, '$.materialReferences')) AS material
                       JOIN json_each(json_extract(${recognitionProposals.basisJson}, '$.evidence')) AS evidence
                         ON json_extract(evidence.value, '$.inspection.observedArtifactReference') = material.value
                       WHERE legacy_location.address = json_extract(${workflowExecutions.snapshotJson}, '$.root') || '/' || material.value
                         AND legacy_revision.blob_digest = json_extract(evidence.value, '$.inspection.revision.digest')
                     ))
                  )
              )
            )`,
          ),
        )
        .get() !== undefined;
    return result;
  }

  /** 本地格式事实拥有自己的修订谱系，绝不属于外部来源谱系。 */
  private replaceLocalObservedMetadataWithDrizzle(
    transaction: DrizzleWriteTransaction,
    current: AcceptedRecognition,
    accepted: AcceptedRecognition,
  ): void {
    const local = (value: MetadataAssertion) =>
      value.sourceRecordIds.length === 0 &&
      value.observedArtifactPart !== undefined;
    const nextCoordinates = new Set(
      accepted.metadata
        .filter(local)
        .map(
          (item) =>
            `${canonicalJson(item.target)}\u0000${item.property}\u0000${item.sourceSlot}\u0000${item.observedArtifactPart!.artifactId}\u0000${item.observedArtifactPart!.locator}`,
        ),
    );
    for (const next of accepted.metadata.filter(local)) {
      const subject = entityTargetId(next) ?? accepted.entity.id;
      const result = transaction
        .insert(metadataAssertions)
        .values({
          subjectId: subject,
          ...descriptionTargetColumns(next.target),
          recognitionDecisionId: next.recognitionDecisionId ?? null,
          property: next.property,
          value: next.value,
          sourceRecordIdsJson: "[]",
          qualifiersJson: JSON.stringify(next.qualifiers ?? []),
          sourceSlot: next.sourceSlot,
          observedArtifactPartJson: JSON.stringify(next.observedArtifactPart),
          producerJson: producerJson(next.producer),
        })
        .run();
      const predecessors = current.metadata.filter(
        (previous) =>
          local(previous) &&
          sameDescriptionTarget(previous.target, next.target) &&
          previous.property === next.property &&
          previous.sourceSlot === next.sourceSlot &&
          previous.observedArtifactPart?.artifactId ===
            next.observedArtifactPart?.artifactId &&
          previous.observedArtifactPart?.locator ===
            next.observedArtifactPart?.locator,
      );
      // 旧行最初持久化时没有本地生命周期；按精确溯源查找其持久 ID。
      const predecessor =
        predecessors[0] === undefined
          ? undefined
          : transaction
              .select({ id: metadataAssertions.id })
              .from(metadataAssertions)
              .where(
                and(
                  eq(metadataAssertions.subjectId, subject),
                  eq(metadataAssertions.targetKind, next.target.kind),
                  lt(metadataAssertions.id, Number(result.lastInsertRowid)),
                  eq(metadataAssertions.property, predecessors[0].property),
                  eq(metadataAssertions.sourceSlot, predecessors[0].sourceSlot),
                  eq(
                    metadataAssertions.observedArtifactPartJson,
                    JSON.stringify(predecessors[0].observedArtifactPart),
                  ),
                ),
              )
              .orderBy(desc(metadataAssertions.id))
              .get();
      transaction
        .insert(metadataAssertionLifecycles)
        .values({
          assertionId: Number(result.lastInsertRowid),
          sourceIdentity: "local-observed",
          nativeAddress: subject,
          coverageId: "format-inspection",
          sourceSlot: next.sourceSlot,
          sourceRecordId: "__local__",
          predecessorAssertionId: predecessor?.id ?? null,
        })
        .run();
    }
    for (const previous of current.metadata.filter(local)) {
      const subject = entityTargetId(previous) ?? current.entity.id;
      const coordinate = `${canonicalJson(previous.target)}\u0000${previous.property}\u0000${previous.sourceSlot}\u0000${previous.observedArtifactPart!.artifactId}\u0000${previous.observedArtifactPart!.locator}`;
      if (nextCoordinates.has(coordinate)) continue;
      const row = transaction
        .select({ id: metadataAssertions.id })
        .from(metadataAssertions)
        .where(
          and(
            eq(metadataAssertions.subjectId, subject),
            eq(metadataAssertions.targetKind, previous.target.kind),
            eq(metadataAssertions.property, previous.property),
            eq(metadataAssertions.sourceSlot, previous.sourceSlot),
            eq(
              metadataAssertions.observedArtifactPartJson,
              JSON.stringify(previous.observedArtifactPart),
            ),
          ),
        )
        .orderBy(desc(metadataAssertions.id))
        .get();
      if (row !== undefined)
        transaction
          .insert(metadataAssertionRetractions)
          .values({
            id: `local-metadata-retraction_${accepted.proposal.id}_${row.id}`,
            assertionId: row.id,
            sourceRecordId: "__local__",
          })
          .onConflictDoNothing()
          .run();
    }
  }

  private insertOrVerifyArtifactFactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    facts: Pick<
      AcceptedRecognition,
      | "artifacts"
      | "locations"
      | "blobs"
      | "artifactRevisions"
      | "artifactAssociations"
    >,
    ownerAssetId: string,
  ): void {
    for (const artifact of facts.artifacts) {
      const existing = transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.id, artifact.id))
        .get();
      if (existing === undefined)
        transaction.insert(artifacts).values({ id: artifact.id }).run();
    }
    for (const location of facts.locations) {
      const existing = transaction
        .select({
          artifactId: locations.artifactId,
          address: locations.address,
          kind: locations.kind,
        })
        .from(locations)
        .where(eq(locations.id, location.id))
        .get();
      if (existing === undefined) {
        transaction
          .insert(locations)
          .values({
            id: location.id,
            artifactId: location.artifactId,
            address: location.address,
            kind: location.kind,
          })
          .run();
      } else if (
        existing.artifactId !== location.artifactId ||
        existing.address !== location.address ||
        existing.kind !== location.kind
      ) {
        throw new Error(
          `Stable Location ${location.id} conflicts with durable history`,
        );
      }
    }
    for (const blob of facts.blobs) {
      const existing = transaction
        .select({ mediaType: blobs.mediaType, byteLength: blobs.byteLength })
        .from(blobs)
        .where(eq(blobs.digest, blob.digest))
        .get();
      if (existing === undefined) {
        transaction
          .insert(blobs)
          .values({
            digest: blob.digest,
            mediaType: blob.mediaType,
            byteLength: blob.byteLength,
          })
          .run();
      } else if (
        existing.mediaType !== blob.mediaType ||
        existing.byteLength !== blob.byteLength
      ) {
        throw new Error(
          `Blob digest ${blob.digest} conflicts with durable content facts`,
        );
      }
    }
    for (const revision of facts.artifactRevisions) {
      const existing = transaction
        .select({
          artifactId: artifactRevisions.artifactId,
          blobDigest: artifactRevisions.blobDigest,
          producerJson: artifactRevisions.producerJson,
        })
        .from(artifactRevisions)
        .where(eq(artifactRevisions.id, revision.id))
        .get();
      if (existing === undefined) {
        transaction
          .insert(artifactRevisions)
          .values({
            id: revision.id,
            artifactId: revision.artifactId,
            blobDigest: revision.blobDigest,
            producerJson: producerJson(revision.producer),
          })
          .run();
      } else if (
        existing.artifactId !== revision.artifactId ||
        existing.blobDigest !== revision.blobDigest
      ) {
        throw new Error(
          `Stable Artifact Revision ${revision.id} conflicts with durable history`,
        );
      } else {
        assertCompatibleProducer(
          existing.producerJson,
          revision.producer,
          "Artifact Revision",
        );
        transaction
          .update(artifactRevisions)
          .set({
            producerJson: sql`COALESCE(${artifactRevisions.producerJson}, ${producerJson(revision.producer)})`,
          })
          .where(eq(artifactRevisions.id, revision.id))
          .run();
      }
    }
    for (const association of facts.artifactAssociations) {
      const sourceRecordIds = JSON.stringify(association.sourceRecordIds ?? []);
      const sourceAssociationId = association.sourceAssociationId ?? null;
      const observedArtifactPart =
        association.observedArtifactPart === undefined
          ? null
          : JSON.stringify(association.observedArtifactPart);
      const existing = transaction
        .select()
        .from(artifactAssociations)
        .where(eq(artifactAssociations.id, association.id))
        .get();
      if (existing === undefined) {
        transaction
          .insert(artifactAssociations)
          .values({
            id: association.id,
            subjectId: entityTargetId(association) ?? ownerAssetId,
            ...descriptionTargetColumns(association.target),
            artifactId: association.artifactId,
            role: association.role,
            sourceRecordIdsJson: sourceRecordIds,
            observedArtifactPartJson: observedArtifactPart,
            producerJson: producerJson(association.producer),
            sourceAssociationId,
          })
          .run();
      } else if (
        !sameDescriptionTarget(
          descriptionTargetFromColumns(existing),
          association.target,
        ) ||
        existing.artifactId !== association.artifactId ||
        existing.role !== association.role
      ) {
        throw new Error(
          `Stable Artifact Association ${association.id} conflicts with durable history`,
        );
      } else {
        if (
          existing.observedArtifactPartJson !== null &&
          (observedArtifactPart === null ||
            existing.observedArtifactPartJson !== observedArtifactPart)
        ) {
          throw new Error(
            `Stable Artifact Association ${association.id} conflicts with observed-part provenance`,
          );
        }
        if (
          existing.sourceAssociationId !== null &&
          sourceAssociationId !== null &&
          existing.sourceAssociationId !== sourceAssociationId
        ) {
          throw new Error(
            `Stable Artifact Association ${association.id} conflicts with Source Association provenance`,
          );
        }
        assertCompatibleProducer(
          existing.producerJson,
          association.producer,
          "Artifact Association",
        );
        const provenance = new Set([
          ...(JSON.parse(existing.sourceRecordIdsJson) as string[]),
          ...(association.sourceRecordIds ?? []),
        ]);
        transaction
          .update(artifactAssociations)
          .set({
            sourceRecordIdsJson: JSON.stringify([...provenance].toSorted()),
            observedArtifactPartJson:
              existing.observedArtifactPartJson ?? observedArtifactPart,
            producerJson: sql`COALESCE(${artifactAssociations.producerJson}, ${producerJson(association.producer)})`,
            sourceAssociationId: sql`COALESCE(${artifactAssociations.sourceAssociationId}, ${sourceAssociationId})`,
          })
          .where(eq(artifactAssociations.id, association.id))
          .run();
      }
    }
  }

  /**
   * 唯一的覆盖判断：只有本次执行的完整 snapshot 精确覆盖该地址，缺失才证明它已不在。
   * 接受材料投影与完成扫描投影共用这一条规则。
   */
  private scanPreciselyCoversAddress(
    snapshots: readonly FilesystemPackageSnapshot[],
    address: string,
  ): boolean {
    return snapshots.some(
      (snapshot) => snapshot.complete && pathIsWithin(snapshot.root, address),
    );
  }

  /**
   * 普通刷新把本次有界 snapshot 规范化到 Location 键控的当前观察投影。热消费查询
   * 只读该投影，不扫描保留的 WorkflowExecution JSON。
   */
  /**
   * 单位置正向投影的纯选择：沿用最终投影的快照排序，只认给定快照里与该地址精确同址的文件
   * 条目。定向确认检查点据此先比较后写入，绝不按地址猜另一个位置。
   */
  private currentFileObservationEntryForAddress(
    address: string,
    snapshots: readonly FilesystemPackageSnapshot[],
    options: { readonly requireWithinSnapshotRoot?: boolean } = {},
  ):
    | {
        readonly snapshot: FilesystemPackageSnapshot;
        readonly size: number;
        readonly modifiedAt: string;
      }
    | undefined {
    const matches = snapshots.flatMap((snapshot) =>
      options.requireWithinSnapshotRoot === true &&
      !pathIsWithin(snapshot.root, address)
        ? []
        : snapshot.files
            .filter(
              (file) =>
                path.resolve(snapshot.root, file.relativePath) ===
                path.resolve(address),
            )
            .map((file) => ({
              snapshot,
              size: file.size,
              modifiedAt: file.modifiedAt,
            })),
    );
    return matches.toSorted((left, right) =>
      right.snapshot.observedAt.localeCompare(left.snapshot.observedAt),
    )[0];
  }

  /**
   * 条件基线与当前观察写入只保留一份计算：接受投影、终态完整投影、别名换算与定向确认检查点
   * 共用，避免「检查点算一套、终态再算一套」的两个观察事实版本。
   */
  private writeCurrentFileObservationWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly locationId: string;
      readonly artifactId: string;
      readonly address: string;
      readonly snapshot: FilesystemPackageSnapshot;
      readonly size: number;
      readonly modifiedAt: string;
    },
  ): LocalMaterialConfirmationObservationCoordinates {
    const conditionalBaseline = currentObservationConditionalBaseline(
      transaction,
      {
        artifactId: input.artifactId,
        locationId: input.locationId,
        snapshotId: input.snapshot.id,
        observedAt: input.snapshot.observedAt,
        size: input.size,
        modifiedAt: input.modifiedAt,
      },
    );
    transaction
      .insert(currentFileObservations)
      .values({
        locationId: input.locationId,
        address: input.address,
        snapshotId: input.snapshot.id,
        observedAt: input.snapshot.observedAt,
        size: input.size,
        modifiedAt: input.modifiedAt,
        conditionalBaseline,
      })
      .onConflictDoUpdate({
        target: currentFileObservations.address,
        set: {
          locationId: input.locationId,
          snapshotId: input.snapshot.id,
          observedAt: input.snapshot.observedAt,
          size: input.size,
          modifiedAt: input.modifiedAt,
          conditionalBaseline,
        },
      })
      .run();
    return {
      snapshotId: input.snapshot.id,
      observedAt: input.snapshot.observedAt,
      size: input.size,
      modifiedAt: input.modifiedAt,
      conditionalBaseline,
    };
  }

  /** 某观察位置当前的耐久观察坐标；不存在返回 `null`，供检查点做「含不存在」的 CAS。 */
  private currentFileObservationCoordinatesWithDrizzle(
    query: DrizzleReadQuery,
    locationId: string,
  ): LocalMaterialConfirmationObservationCoordinates | null {
    const row = query
      .select()
      .from(currentFileObservations)
      .where(eq(currentFileObservations.locationId, locationId))
      .get();
    return row === undefined
      ? null
      : {
          snapshotId: row.snapshotId,
          observedAt: row.observedAt,
          size: row.size,
          modifiedAt: row.modifiedAt,
          conditionalBaseline: row.conditionalBaseline,
        };
  }

  /**
   * 单位置正向投影：该位置的既有根/目录授权正向支持，加上本执行冻结条目对应的当前观察与
   * 观察支持。本执行快照不再含该条目时返回 undefined，由调用方决定缺失处理。
   */
  private projectCurrentFileObservationForLocation(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
    location: {
      readonly id: string;
      readonly artifactId: string;
      readonly address: string;
    },
    snapshots: readonly FilesystemPackageSnapshot[],
    materialKind: "file" | "directory" | undefined,
    options: {
      readonly requireWithinSnapshotRoot?: boolean;
      readonly presentEligible?: boolean;
    } = {},
  ): LocalMaterialConfirmationObservationCoordinates | undefined {
    this.projectCurrentObservedMaterialSupportForLocation(
      transaction,
      execution,
      location.address,
      location.id,
      materialKind,
      options.presentEligible ?? true,
    );
    const entry = this.currentFileObservationEntryForAddress(
      location.address,
      snapshots,
      { requireWithinSnapshotRoot: options.requireWithinSnapshotRoot === true },
    );
    if (entry === undefined) return undefined;
    const coordinates = this.writeCurrentFileObservationWithDrizzle(
      transaction,
      {
        locationId: location.id,
        artifactId: location.artifactId,
        address: location.address,
        snapshot: entry.snapshot,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      },
    );
    this.recordCurrentFileObservationSupportsWithDrizzle(
      transaction,
      execution,
      location.id,
    );
    return coordinates;
  }

  /**
   * 本协调器已判定被取代的载体地址：终态单位置正向投影必须跳过这些精确坐标，不能将更新
   * 的事实覆盖回旧确认，也不能由别名第二遍写回绕过。
   */
  private staleLocalMaterialConfirmationAddressSet(
    execution: WorkflowExecution,
  ): ReadonlySet<string> {
    return new Set(
      staleLocalMaterialConfirmationAddresses(execution).map((address) =>
        path.resolve(address),
      ),
    );
  }

  private projectCurrentFileObservationsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
    acceptedLocations: readonly Location[],
  ): void {
    const snapshots =
      execution.filesystemSnapshots ??
      (execution.snapshot === undefined ? [] : [execution.snapshot]);
    const acceptedObservedLocationIds = new Set(
      acceptedLocations
        .filter((location) => location.kind === "observed")
        .map((location) => location.id),
    );
    const boundaries =
      this.observedMaterialBoundaryKindsWithDrizzle(transaction);
    const materialKindFor = (
      locationId: string,
    ): "file" | "directory" | undefined => boundaries.get(locationId);
    const affectedArtifactIds = new Set(
      acceptedLocations.map((location) => location.artifactId),
    );
    for (const artifactId of affectedArtifactIds) {
      const previousLocations = transaction
        .select({ id: locations.id, address: locations.address })
        .from(locations)
        .where(
          and(
            eq(locations.artifactId, artifactId),
            eq(locations.kind, "observed"),
          ),
        )
        .all();
      for (const previous of previousLocations) {
        if (acceptedObservedLocationIds.has(previous.id)) continue;
        if (this.scanPreciselyCoversAddress(snapshots, previous.address)) {
          transaction
            .delete(currentFileObservations)
            .where(eq(currentFileObservations.locationId, previous.id))
            .run();
          this.removeCurrentObservedMaterialSupportsWithDrizzle(
            transaction,
            execution,
            previous.id,
            previous.address,
          );
        }
      }
    }
    const staleAddresses =
      this.staleLocalMaterialConfirmationAddressSet(execution);
    for (const location of acceptedLocations) {
      if (location.kind !== "observed") continue;
      if (staleAddresses.has(path.resolve(location.address))) continue;
      const established = this.projectCurrentFileObservationForLocation(
        transaction,
        execution,
        location,
        snapshots,
        materialKindFor(location.id),
      );
      if (
        established === undefined &&
        this.scanPreciselyCoversAddress(snapshots, location.address)
      )
        transaction
          .delete(currentFileObservations)
          .where(eq(currentFileObservations.locationId, location.id))
          .run();
    }
    // 同一登记以等价容器拼写重连时，旧 Location 事实保留其原地址；以该登记此前
    // 的成功支持路径换算相对地址，才能由新成功扫描重新建立支持。
    for (const root of execution.workflowInput?.observedRoots ?? []) {
      const aliases = transaction
        .select({
          locationId: locations.id,
          artifactId: locations.artifactId,
          address: locations.address,
          priorPath: currentFileObservationSupports.observedRootPath,
        })
        .from(currentFileObservationSupports)
        .innerJoin(
          locations,
          eq(locations.id, currentFileObservationSupports.locationId),
        )
        .where(
          and(
            eq(currentFileObservationSupports.observedRootId, root.id),
            eq(locations.kind, "observed"),
          ),
        )
        .all();
      for (const snapshot of snapshots) {
        if (!pathIsWithin(root.containerPath, snapshot.root)) continue;
        for (const file of snapshot.files) {
          const scopedRelativePath = path.join(
            path.relative(root.containerPath, snapshot.root),
            file.relativePath,
          );
          for (const alias of aliases) {
            if (
              path.relative(alias.priorPath, alias.address) !==
              scopedRelativePath
            )
              continue;
            if (
              staleAddresses.has(path.resolve(snapshot.root, file.relativePath))
            )
              continue;
            this.writeCurrentFileObservationWithDrizzle(transaction, {
              locationId: alias.locationId,
              artifactId: alias.artifactId,
              address: path.resolve(snapshot.root, file.relativePath),
              snapshot,
              size: file.size,
              modifiedAt: file.modifiedAt,
            });
            this.recordCurrentFileObservationSupportsWithDrizzle(
              transaction,
              execution,
              alias.locationId,
            );
            if (
              snapshot.complete &&
              materialKindFor(alias.locationId) === "file"
            )
              this.recordCurrentObservedMaterialSupportsWithDrizzle(
                transaction,
                execution,
                alias.locationId,
                snapshot,
                "file",
              );
          }
        }
        // 目录位置没有文件观察行，但仍需在同一相对换算下由新扫描重新确认存在。
        for (const directory of snapshot.complete
          ? (snapshot.directories ?? [])
          : []) {
          const scopedRelativePath = path.join(
            path.relative(root.containerPath, snapshot.root),
            directory.relativePath,
          );
          for (const alias of aliases) {
            if (
              path.relative(alias.priorPath, alias.address) !==
              scopedRelativePath
            )
              continue;
            if (materialKindFor(alias.locationId) !== "directory") continue;
            this.recordCurrentFileObservationSupportsWithDrizzle(
              transaction,
              execution,
              alias.locationId,
            );
            this.recordCurrentObservedMaterialSupportsWithDrizzle(
              transaction,
              execution,
              alias.locationId,
              snapshot,
              "directory",
            );
            break;
          }
        }
      }
    }
  }

  /**
   * 一次完整授权观察把本库经这些冻结根的 awaitingObservation 清零：只有携带当前权威版本的
   * 活动授权提交才能重开本库经该根的 current 投影；旧执行、未携带授权的流程与共享同一物理根
   * 的其他库都不会被这里改写。
   */
  private clearLibraryGrantAwaitingObservationWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
  ): void {
    const assetLibraryId = execution.workflowInput?.assetLibrary?.id;
    const authorizations = execution.workflowInput?.directoryAuthorizations;
    if (assetLibraryId === undefined || authorizations === undefined) return;
    for (const authorization of authorizations) {
      transaction
        .update(libraryDirectoryGrants)
        .set({ awaitingObservation: 0 })
        .where(
          and(
            eq(libraryDirectoryGrants.libraryId, assetLibraryId),
            eq(
              libraryDirectoryGrants.observedRootId,
              authorization.observedRootId,
            ),
            eq(
              libraryDirectoryGrants.authorityVersion,
              authorization.authorityVersion,
            ),
            eq(libraryDirectoryGrants.status, "active"),
            eq(libraryDirectoryGrants.awaitingObservation, 1),
          ),
        )
        .run();
    }
  }

  /**
   * 只有 Application 已把正式文件系统扫描写成完成终态后，才以其完整快照更新当前
   * 观察投影。失败、取消及不完整覆盖绝不触碰先前成员资格。
   */
  private projectCompletedFilesystemScanWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
  ): void {
    if (
      execution.operationKind !== "scan-filesystem" ||
      execution.status !== "completed"
    )
      return;
    const snapshots = (execution.filesystemSnapshots ?? []).filter(
      (snapshot) => snapshot.complete,
    );
    if (snapshots.length === 0) return;
    const observedLocations = transaction
      .select()
      .from(locations)
      .where(eq(locations.kind, "observed"))
      .all();
    const boundaries =
      this.observedMaterialBoundaryKindsWithDrizzle(transaction);
    const trackedFileLocationByAddress = new Map(
      transaction
        .select({
          address: currentFileObservations.address,
          locationId: currentFileObservations.locationId,
        })
        .from(currentFileObservations)
        .all()
        .map((row) => [path.resolve(row.address), row.locationId]),
    );
    const soleFileLocationByAddress = new Map<string, string | undefined>();
    for (const location of observedLocations) {
      if (boundaries.get(location.id) !== "file") continue;
      const address = path.resolve(location.address);
      soleFileLocationByAddress.set(
        address,
        soleFileLocationByAddress.has(address) ? undefined : location.id,
      );
    }
    const exactFileLocationFor = (address: string): string | undefined => {
      const resolved = path.resolve(address);
      const tracked = trackedFileLocationByAddress.get(resolved);
      return tracked ?? soleFileLocationByAddress.get(resolved);
    };
    const supportRootIds = new Set(
      this.observedSupportRootsFor(execution).map((root) => root.id),
    );
    const supportedLocationIds = new Set(
      transaction
        .select({
          locationId: currentFileObservationSupports.locationId,
          rootId: currentFileObservationSupports.observedRootId,
        })
        .from(currentFileObservationSupports)
        .all()
        .filter((support) => supportRootIds.has(support.rootId))
        .map((support) => support.locationId),
    );
    const staleAddresses =
      this.staleLocalMaterialConfirmationAddressSet(execution);
    for (const location of observedLocations) {
      // 续扫只刷新同一登记已经支持的位置；同址新登记须经自己的材料接受。
      if (!supportedLocationIds.has(location.id)) continue;
      if (staleAddresses.has(path.resolve(location.address))) continue;
      const established = this.projectCurrentFileObservationForLocation(
        transaction,
        execution,
        location,
        snapshots,
        boundaries.get(location.id),
        {
          requireWithinSnapshotRoot: true,
          presentEligible:
            boundaries.get(location.id) === "directory" ||
            exactFileLocationFor(location.address) === location.id,
        },
      );
      if (
        established === undefined &&
        this.scanPreciselyCoversAddress(snapshots, location.address)
      ) {
        this.recordCurrentFileObservationSupportsWithDrizzle(
          transaction,
          execution,
          location.id,
        );
        transaction
          .delete(currentFileObservations)
          .where(eq(currentFileObservations.locationId, location.id))
          .run();
      }
    }
    this.projectCurrentFileObservationsWithDrizzle(transaction, execution, []);
    // awaitingObservation 只由一次完整授权观察（scan-filesystem 完成终态 + complete 快照）清零；
    // 单资产定向接受或部分投影即便携带冻结授权也不得据此重开本库历史 current。
    this.clearLibraryGrantAwaitingObservationWithDrizzle(
      transaction,
      execution,
    );
  }

  /**
   * 第6节操作1：读取这些主体仍有效的决定与本地材料历史支持，返回本次实际需求真正消费的
   * 精确载体目标。这里读的是**保留的接受图**，不是已过滤 current 的接受投影，否则恰好需要
   * 确认的图永远找不到。本次冻结快照里没有对应条目的载体不入选：既不捏造观察，也不推断缺失。
   */
  async findCurrentLocalMaterialObservationExecutions(input: {
    readonly subjectIds: readonly string[];
    readonly informationRequirement: InformationRequirement;
    readonly assetLibraryId?: string;
  }): Promise<readonly WorkflowExecution[]> {
    if (
      input.subjectIds.length === 0 ||
      input.informationRequirement.artifactRoles.length === 0
    )
      return [];
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const currentSnapshots = query
      .selectDistinct({ id: currentFileObservations.snapshotId })
      .from(currentFileObservations)
      .innerJoin(
        artifactAssociationRecognitionSupports,
        eq(
          artifactAssociationRecognitionSupports.observationLocationId,
          currentFileObservations.locationId,
        ),
      )
      .innerJoin(
        artifactAssociations,
        eq(
          artifactAssociations.id,
          artifactAssociationRecognitionSupports.associationId,
        ),
      )
      .where(
        and(
          inArray(
            artifactAssociations.subjectId,
            sqliteTextSet(input.subjectIds),
          ),
          inArray(
            artifactAssociations.role,
            sqliteTextSet(
              input.informationRequirement.artifactRoles.map(
                (item) => item.role,
              ),
            ),
          ),
        ),
      )
      .all();
    const result: WorkflowExecution[] = [];
    for (const { id: snapshotId } of currentSnapshots) {
      const rows = query
        .select({ id: workflowExecutions.id })
        .from(workflowExecutions)
        .where(sql`json_extract(${workflowExecutions.snapshotJson}, '$.id') = ${snapshotId}
          OR EXISTS (SELECT 1 FROM json_each(COALESCE(${workflowExecutions.filesystemSnapshotsJson}, '[]')) AS snapshot WHERE json_extract(snapshot.value, '$.id') = ${snapshotId})`)
        .orderBy(asc(sql<number>`${workflowExecutions}.rowid`))
        .all();
      for (const row of rows) {
        const execution =
          this.workflowExecutionPersistence.readExecutionWithDrizzle(
            query,
            row.id,
          );
        if (
          execution === undefined ||
          execution.operationKind !== "scan-filesystem" ||
          execution.status !== "completed" ||
          (input.assetLibraryId !== undefined &&
            execution.workflowInput?.assetLibrary?.id !==
              input.assetLibraryId) ||
          this.requestedLocalMaterialAuthorityStaleWithDrizzle(query, execution)
        )
          continue;
        const snapshots =
          execution.filesystemSnapshots ??
          (execution.snapshot === undefined ? [] : [execution.snapshot]);
        const entries = await this.planRequestedLocalMaterialConfirmations({
          ...input,
          snapshots,
          currentObservationsOnly: true,
        });
        if (
          entries.some(
            (entry) =>
              entry.target.frozenEntry.snapshotId === snapshotId &&
              !this.observedRevisionConfirmationMatchesWithDrizzle(
                query,
                entry.target,
              ),
          )
        ) {
          if (!result.some((item) => item.id === execution.id))
            result.push(execution);
          break;
        }
      }
    }
    return result;
  }

  async planRequestedLocalMaterialConfirmations(input: {
    readonly subjectIds: readonly string[];
    readonly informationRequirement: InformationRequirement;
    readonly snapshots: readonly FilesystemPackageSnapshot[];
    readonly assetLibraryId?: string | undefined;
    readonly currentObservationsOnly?: boolean;
  }): Promise<readonly LocalMaterialConfirmationPlanEntry[]> {
    // 需求里的角色与数量限制决定「消费哪些本地图片」，必要性不参与筛选：一次只带可选
    // 图片角色的普通刷新同样要把已物化并会被投影的图片保持在当前证据上。候选范围由
    // 本次主体与保留接受图决定，因此可选角色不等于全库请求。
    const requestedRoles = input.informationRequirement.artifactRoles;
    if (
      requestedRoles.length === 0 ||
      input.snapshots.length === 0 ||
      input.subjectIds.length === 0
    )
      return [];
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const candidates = this.requestedLocalMaterialCandidatesWithDrizzle(
      query,
      input.subjectIds,
      requestedRoles.map((item) => item.role),
      input.snapshots,
      input.assetLibraryId,
      input.currentObservationsOnly,
    );
    const targets: RequestedLocalMaterialConfirmationTarget[] = [];
    for (const requirement of requestedRoles) {
      // 数量语义按既有每主体消费选择：一张 material-image 属于每个已接受主体各自一份，
      // 不能把整批主体候选混排后统一 slice 而漏掉其他主体本次实际消费的载体。
      const bySubject = new Map<
        string,
        RequestedLocalMaterialConfirmationTarget[]
      >();
      for (const item of candidates) {
        if (item.role !== requirement.role) continue;
        const bucket = bySubject.get(item.target.subjectId) ?? [];
        bucket.push(item.target);
        bySubject.set(item.target.subjectId, bucket);
      }
      for (const bucket of bySubject.values()) {
        const sorted = bucket.toSorted((left, right) =>
          localMaterialConfirmationTargetKey(left).localeCompare(
            localMaterialConfirmationTargetKey(right),
          ),
        );
        targets.push(
          ...(requirement.maximum === undefined
            ? sorted
            : sorted.slice(0, requirement.maximum)),
        );
      }
    }
    return mergeRequestedLocalMaterialConfirmationTargets(targets).map(
      (target) => {
        const prerequisiteObservation =
          this.currentFileObservationCoordinatesWithDrizzle(
            query,
            target.locationId,
          );
        const facts = input.currentObservationsOnly
          ? observedSelectionFacts(query, target.locationId, {
              includeConfirmed: true,
            })
          : undefined;
        return {
          target,
          prerequisiteObservation,
          ...(facts === undefined
            ? {}
            : {
                establishedObservation: {
                  selectionId: facts.selectionId,
                  conditionalBaseline: facts.conditionalBaseline,
                },
              }),
        };
      },
    );
  }

  /**
   * 第6节操作2：同一条 immediate 事务核对执行 CAS 与恢复 claim、保留接受图与冻结坐标、仍有效
   * 的根与库授权，对本次扫描实际存在的这些精确载体建立单位置正向当前观察，并把检查点连同事务
   * 内算出的精确 facts 一起提交。它不建立 confirmation，不推断其他材料消失，不清库的
   * awaitingObservation，也不把执行提前写成 completed。
   */
  async checkpointRequestedLocalMaterialConfirmations(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly dispositionKey: string;
    readonly entries: readonly LocalMaterialConfirmationPlanEntry[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<{
    readonly execution: WorkflowExecution;
    readonly outcomes: readonly LocalMaterialConfirmationCheckpointOutcome[];
  }> {
    const checkpoint = findObservedMaterialConfirmationCheckpoint(
      input.execution.dispositions,
      input.dispositionKey,
    );
    if (checkpoint === undefined)
      throw new Error("本地材料确认检查点缺少耐久目标列表");
    const database = await this.ensure();
    const query = drizzle({ client: database });
    try {
      return query.transaction(
        (transaction) => {
          const baseline =
            this.workflowExecutionPersistence.runningExecutionBaseline(
              transaction,
              input.expectedExecution,
              input.execution,
            );
          this.assertResumeMutationClaim(
            transaction,
            input.expectedExecution.id,
            input.resumeClaim,
          );
          const authorityStale =
            this.requestedLocalMaterialAuthorityStaleWithDrizzle(
              transaction,
              input.execution,
            );
          const snapshots =
            input.execution.filesystemSnapshots ??
            (input.execution.snapshot === undefined
              ? []
              : [input.execution.snapshot]);
          const outcomes: LocalMaterialConfirmationCheckpointOutcome[] = [];
          const statuses: {
            readonly targetKey: string;
            readonly status: "pending" | "confirmed" | "failed";
            readonly observation?: LocalMaterialConfirmationObservation;
            readonly failureCode?: string;
          }[] = [];
          for (const target of checkpoint.targets) {
            if (target.status !== "pending") continue;
            const targetKey = localMaterialConfirmationTargetKey(target);
            const stale = (): void => {
              // 被取代的目标只按该位置当前的精确事实裁定；没有可观察事实时保留为未完成目标
              // 并记下同一稳定失败码，绝不伪造一份观察。
              const facts = observedSelectionFacts(
                transaction,
                target.locationId,
                { includeConfirmed: true },
              );
              const observation =
                facts === undefined
                  ? undefined
                  : {
                      selectionId: facts.selectionId,
                      conditionalBaseline: facts.conditionalBaseline,
                    };
              outcomes.push({
                kind: "stale",
                target,
                ...(observation === undefined ? {} : { observation }),
              });
              statuses.push(
                observation === undefined
                  ? {
                      targetKey,
                      status: "pending",
                      failureCode: localMaterialConfirmationStaleCode,
                    }
                  : {
                      targetKey,
                      status: "failed",
                      observation,
                      failureCode: localMaterialConfirmationStaleCode,
                    },
              );
            };
            const entry = input.entries.find(
              (item) =>
                localMaterialConfirmationTargetKey(item.target) === targetKey,
            );
            if (authorityStale) {
              stale();
              continue;
            }
            if (
              !this.requestedLocalMaterialGraphIntactWithDrizzle(
                transaction,
                target,
              )
            ) {
              stale();
              continue;
            }
            // 崩溃窗口重入：已随检查点提交过精确事实的项只核对，不再建立或覆盖观察。
            if (target.observation !== undefined) {
              const facts = observedSelectionFacts(
                transaction,
                target.locationId,
                {
                  includeConfirmed: true,
                },
              );
              if (
                facts === undefined ||
                facts.selectionId !== target.observation.selectionId ||
                facts.conditionalBaseline !==
                  target.observation.conditionalBaseline
              )
                stale();
              else
                this.classifyRequestedLocalMaterialConfirmation(
                  transaction,
                  target,
                  facts,
                  outcomes,
                  statuses,
                );
              continue;
            }
            // 无扫描履行只能消费规划时已有的精确观察；缺失时绝不借旧快照建立新观察。
            if (input.execution.operationKind === "refresh-metadata") {
              stale();
              continue;
            }
            const existing = this.currentFileObservationCoordinatesWithDrizzle(
              transaction,
              target.locationId,
            );
            if (
              !sameLocalMaterialObservation(
                existing,
                entry?.prerequisiteObservation ?? null,
              )
            ) {
              stale();
              continue;
            }
            // 已存在的观察比本执行的冻结条目更新时不写回：定向确认绝不取代新事实。
            if (
              existing !== null &&
              existing.observedAt > target.frozenEntry.observedAt
            ) {
              stale();
              continue;
            }
            const established = this.projectCurrentFileObservationForLocation(
              transaction,
              input.execution,
              {
                id: target.locationId,
                artifactId: target.carrierArtifactId,
                address: target.locationAddress,
              },
              snapshots,
              this.observedMaterialBoundaryKindsWithDrizzle(transaction).get(
                target.locationId,
              ),
              { requireWithinSnapshotRoot: true },
            );
            const frozen = snapshots.find(
              (snapshot) => snapshot.id === target.frozenEntry.snapshotId,
            );
            if (
              established === undefined ||
              frozen === undefined ||
              established.snapshotId !== target.frozenEntry.snapshotId ||
              established.observedAt !== target.frozenEntry.observedAt ||
              established.size !== target.frozenEntry.size ||
              established.modifiedAt !== target.frozenEntry.modifiedAt ||
              path.resolve(frozen.root) !==
                path.resolve(target.frozenEntry.snapshotRoot)
            ) {
              stale();
              continue;
            }
            const facts = observedSelectionFacts(
              transaction,
              target.locationId,
              {
                includeConfirmed: true,
              },
            );
            if (
              facts === undefined ||
              facts.conditionalBaseline !== established.conditionalBaseline
            )
              stale();
            else
              this.classifyRequestedLocalMaterialConfirmation(
                transaction,
                target,
                facts,
                outcomes,
                statuses,
              );
          }
          const settled = attachLocalMaterialConfirmationObservations(
            checkpoint,
            statuses,
          );
          const durable: WorkflowExecution = {
            ...input.execution,
            dispositions: localMaterialConfirmationDispositions(
              input.execution.dispositions,
              input.dispositionKey,
              settled,
              "running",
            ),
          };
          this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
            transaction,
            durable,
            { auditJson: baseline.auditJson },
          );
          const persisted =
            this.workflowExecutionPersistence.readExecutionWithDrizzle(
              transaction,
              input.execution.id,
            );
          if (persisted === undefined)
            throw new Error("本地材料确认检查点提交后不可读取");
          return { execution: persisted, outcomes };
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      throw originalPersistenceError(error);
    }
  }

  /**
   * 终态核对：检查点里已确认的目标仍与当前事实逐字相同才保留，被更晚观察、接受或授权变化
   * 取代的返回目标键，由 Application 折算 partial 后重新提交终态，整笔终态事务不写回旧确认。
   */
  async verifyRequestedLocalMaterialConfirmationTerminals(input: {
    readonly execution: WorkflowExecution;
  }): Promise<readonly string[]> {
    if (
      input.execution.dispositions.every(
        (disposition) => disposition.observedMaterialConfirmation === undefined,
      )
    )
      return [];
    const database = await this.ensure();
    return this.requestedLocalMaterialStaleTerminalsWithDrizzle(
      drizzle({ client: database }),
      input.execution,
    );
  }

  /**
   * 核对在同一读取会话内完成，因此既能独立调用，也能被终态事务在自己的 immediate 事务里
   * 复用——终态重核与最终观察投影绝不分居两个事务，否则中间落入的较新观察会被当成已确认。
   * 除逐字观察事实与精确修订确认外，还重核本执行冻结的授权代际与已接受支持：两者任一推进
   * 都只把该目标判为被取代，历史身份本身不在这里修改。
   */
  private requestedLocalMaterialStaleTerminalsWithDrizzle(
    query: DrizzleReadQuery,
    execution: WorkflowExecution,
  ): readonly string[] {
    const withPayload = execution.dispositions.filter(
      (disposition) => disposition.observedMaterialConfirmation !== undefined,
    );
    if (withPayload.length === 0) return [];
    const authorityStale = this.requestedLocalMaterialAuthorityStaleWithDrizzle(
      query,
      execution,
    );
    const stale: string[] = [];
    for (const disposition of withPayload) {
      const checkpoint = decodeObservedMaterialConfirmationCheckpoint(
        disposition.observedMaterialConfirmation,
      );
      for (const target of checkpoint.targets) {
        if (target.status !== "confirmed" || target.observation === undefined)
          continue;
        const targetKey = localMaterialConfirmationTargetKey(target);
        if (authorityStale) {
          stale.push(targetKey);
          continue;
        }
        if (!this.requestedLocalMaterialGraphIntactWithDrizzle(query, target)) {
          stale.push(targetKey);
          continue;
        }
        const facts = observedSelectionFacts(query, target.locationId, {
          includeConfirmed: true,
        });
        if (
          facts === undefined ||
          facts.selectionId !== target.observation.selectionId ||
          facts.conditionalBaseline !== target.observation.conditionalBaseline
        ) {
          stale.push(targetKey);
          continue;
        }
        if (!this.observedRevisionConfirmationMatchesWithDrizzle(query, target))
          stale.push(targetKey);
      }
    }
    return [...new Set(stale)];
  }

  /** 检查点事务内按当前观察与既有严格确认相交规则裁定精确事实。 */
  private classifyRequestedLocalMaterialConfirmation(
    query: DrizzleReadQuery,
    target: LocalMaterialConfirmationCheckpointTarget,
    facts: ObservedFileConfirmationFacts,
    outcomes: LocalMaterialConfirmationCheckpointOutcome[],
    statuses: {
      readonly targetKey: string;
      readonly status: "pending" | "confirmed" | "failed";
      readonly observation?: LocalMaterialConfirmationObservation;
      readonly failureCode?: string;
    }[],
  ): void {
    const observation: LocalMaterialConfirmationObservation = {
      selectionId: facts.selectionId,
      conditionalBaseline: facts.conditionalBaseline,
    };
    const targetKey = localMaterialConfirmationTargetKey(target);
    if (this.observedRevisionConfirmationMatchesWithDrizzle(query, target)) {
      outcomes.push({ kind: "exact-confirmed", target, observation });
      statuses.push({ targetKey, status: "confirmed", observation });
      return;
    }
    if (this.observedRevisionConfirmedWithDrizzle(query, facts)) {
      // 同一次观察确认的是另一个修订：不能把它当成本目标的成果。
      outcomes.push({ kind: "stale", target, observation });
      statuses.push({
        targetKey,
        status: "failed",
        observation,
        failureCode: localMaterialConfirmationStaleCode,
      });
      return;
    }
    outcomes.push({ kind: "needs-confirmation", target, observation });
    statuses.push({ targetKey, status: "pending", observation });
  }

  /** 该次精确观察是否已存在任何修订确认。 */
  private observedRevisionConfirmedWithDrizzle(
    query: DrizzleReadQuery,
    facts: ObservedFileConfirmationFacts,
  ): boolean {
    return (
      query
        .select({ revisionId: observedRevisionConfirmations.revisionId })
        .from(observedRevisionConfirmations)
        .where(
          and(
            eq(
              observedRevisionConfirmations.locationId,
              facts.location.locationId,
            ),
            eq(
              observedRevisionConfirmations.snapshotId,
              facts.observation.snapshotId,
            ),
            eq(
              observedRevisionConfirmations.observedAt,
              facts.observation.observedAt,
            ),
            eq(observedRevisionConfirmations.size, facts.observation.size),
            eq(
              observedRevisionConfirmations.modifiedAt,
              facts.observation.modifiedAt,
            ),
            eq(
              observedRevisionConfirmations.conditionalBaseline,
              facts.conditionalBaseline,
            ),
          ),
        )
        .all().length > 0
    );
  }

  /** 目标载体修订在该位置的当前观察上是否已被精确确认。 */
  private observedRevisionConfirmationMatchesWithDrizzle(
    query: DrizzleReadQuery,
    target: {
      readonly locationId: string;
      readonly expectedRevisionId: string;
      readonly frozenEntry: LocalMaterialConfirmationFrozenEntry;
    },
  ): boolean {
    const current = query
      .select()
      .from(currentFileObservations)
      .where(eq(currentFileObservations.locationId, target.locationId))
      .get();
    if (current === undefined) return false;
    return (
      query
        .select({ revisionId: observedRevisionConfirmations.revisionId })
        .from(observedRevisionConfirmations)
        .where(
          and(
            eq(observedRevisionConfirmations.locationId, target.locationId),
            eq(
              observedRevisionConfirmations.revisionId,
              target.expectedRevisionId,
            ),
            eq(observedRevisionConfirmations.snapshotId, current.snapshotId),
            eq(observedRevisionConfirmations.observedAt, current.observedAt),
            eq(observedRevisionConfirmations.size, current.size),
            eq(observedRevisionConfirmations.modifiedAt, current.modifiedAt),
            eq(
              observedRevisionConfirmations.conditionalBaseline,
              current.conditionalBaseline,
            ),
          ),
        )
        .all().length > 0
    );
  }

  /** 本执行冻结的观察根仍 active 且代次相同，库目录授权也没有被明确撤销或推进。 */
  private requestedLocalMaterialAuthorityStaleWithDrizzle(
    query: DrizzleReadQuery,
    execution: WorkflowExecution,
  ): boolean {
    const roots = execution.workflowInput?.observedRoots ?? [];
    for (const root of roots) {
      const registration = query
        .select({
          status: observedRootRegistrations.status,
          configVersion: observedRootRegistrations.configVersion,
        })
        .from(observedRootRegistrations)
        .where(eq(observedRootRegistrations.id, root.id))
        .get();
      if (
        registration?.status !== "active" ||
        registration.configVersion !== root.configVersion
      )
        return true;
    }
    if (roots.length === 0) return false;
    return this.directoryAuthorizationsStale(query, execution);
  }

  /**
   * 检查点事务内重核保留接受图与冻结载体坐标是否仍逐项相符：决定未结束、主体即决定资产、
   * 关联的载体产物/修订/位置/地址/摘要/长度与检查点完全一致。真实错载体、locator、执行或
   * 工作项在此被拒绝，不给伪 current。
   */
  private requestedLocalMaterialGraphIntactWithDrizzle(
    query: DrizzleReadQuery,
    target: LocalMaterialConfirmationCheckpointTarget,
  ): boolean {
    const decisionEnded = (decisionId: string): boolean =>
      query
        .select({ id: recognitionDecisions.id })
        .from(recognitionDecisions)
        .where(
          and(
            eq(recognitionDecisions.id, decisionId),
            sql`NOT EXISTS (
              SELECT 1 FROM recognition_decision_supersessions AS ended
              WHERE ended.predecessor_decision_id = ${recognitionDecisions.id}
            )
            AND NOT EXISTS (
              SELECT 1 FROM recognition_decision_retractions AS ended
              WHERE ended.predecessor_decision_id = ${recognitionDecisions.id}
            )`,
          ),
        )
        .all().length === 0;
    if (decisionEnded(target.recognitionDecisionId)) return false;
    const location = query
      .select({
        id: locations.id,
        artifactId: locations.artifactId,
        address: locations.address,
        kind: locations.kind,
      })
      .from(locations)
      .where(eq(locations.id, target.locationId))
      .get();
    if (
      location === undefined ||
      location.kind !== "observed" ||
      location.artifactId !== target.carrierArtifactId ||
      path.resolve(location.address) !== path.resolve(target.locationAddress)
    )
      return false;
    const revision = query
      .select({
        id: artifactRevisions.id,
        artifactId: artifactRevisions.artifactId,
        blobDigest: artifactRevisions.blobDigest,
        byteLength: blobs.byteLength,
      })
      .from(artifactRevisions)
      .innerJoin(blobs, eq(blobs.digest, artifactRevisions.blobDigest))
      .where(eq(artifactRevisions.id, target.expectedRevisionId))
      .get();
    if (
      revision === undefined ||
      revision.artifactId !== target.carrierArtifactId ||
      revision.blobDigest !== target.expectedBlobDigest ||
      revision.byteLength !== target.expectedByteLength
    )
      return false;
    for (const associationId of target.associationIds) {
      const association = query
        .select({
          id: artifactAssociations.id,
          subjectId: artifactAssociations.subjectId,
          artifactId: artifactAssociations.artifactId,
          observedArtifactPartJson:
            artifactAssociations.observedArtifactPartJson,
          decisionAssetId: recognitionDecisions.assetId,
          locationId:
            artifactAssociationRecognitionSupports.observationLocationId,
          revisionId:
            artifactAssociationRecognitionSupports.observationRevisionId,
          materialKind:
            artifactAssociationRecognitionSupports.observationMaterialKind,
        })
        .from(artifactAssociations)
        .innerJoin(
          artifactAssociationRecognitionSupports,
          eq(
            artifactAssociationRecognitionSupports.associationId,
            artifactAssociations.id,
          ),
        )
        .innerJoin(
          recognitionDecisions,
          eq(
            recognitionDecisions.id,
            artifactAssociationRecognitionSupports.recognitionDecisionId,
          ),
        )
        .where(
          and(
            eq(artifactAssociations.id, associationId),
            eq(
              artifactAssociationRecognitionSupports.recognitionDecisionId,
              target.recognitionDecisionId,
            ),
          ),
        )
        .all();
      if (association.length === 0) return false;
      for (const row of association) {
        if (row.subjectId !== target.subjectId) return false;
        if (row.decisionAssetId !== target.subjectId) return false;
        if (
          row.locationId !== target.locationId ||
          row.revisionId !== target.expectedRevisionId ||
          row.materialKind !== "file"
        )
          return false;
        const part =
          row.observedArtifactPartJson === null
            ? undefined
            : (JSON.parse(row.observedArtifactPartJson) as {
                readonly artifactId: string;
                readonly revisionId: string;
                readonly locator: string;
              });
        if (
          (part?.artifactId ?? row.artifactId) !== target.carrierArtifactId ||
          (part?.revisionId ?? row.revisionId) !== target.expectedRevisionId
        )
          return false;
      }
    }
    return true;
  }

  /**
   * 保留接受图里本次需求消费的候选：仍有效的决定所支持、载体产物即观察位置产物、本次冻结
   * 快照确有一份对应条目。实体派生封面另按修正后的代表依据判定，规则失败的依据不入选。
   */
  private requestedLocalMaterialCandidatesWithDrizzle(
    query: DrizzleReadQuery,
    subjectIds: readonly string[],
    roles: readonly string[],
    snapshots: readonly FilesystemPackageSnapshot[],
    assetLibraryId?: string,
    currentObservationsOnly = false,
  ): readonly {
    readonly role: string;
    readonly target: RequestedLocalMaterialConfirmationTarget;
  }[] {
    const rows = query
      .select({
        associationId: artifactAssociations.id,
        associationArtifactId: artifactAssociations.artifactId,
        targetKind: artifactAssociations.targetKind,
        subjectId: artifactAssociations.subjectId,
        role: artifactAssociations.role,
        observedArtifactPartJson: artifactAssociations.observedArtifactPartJson,
        decisionId: recognitionDecisions.id,
        proposalId: recognitionDecisions.proposalId,
        locationId:
          artifactAssociationRecognitionSupports.observationLocationId,
        materialKind:
          artifactAssociationRecognitionSupports.observationMaterialKind,
        locationAddress: locations.address,
        locationArtifactId: locations.artifactId,
        revisionId: artifactRevisions.id,
        revisionArtifactId: artifactRevisions.artifactId,
        blobDigest: artifactRevisions.blobDigest,
        byteLength: blobs.byteLength,
      })
      .from(artifactAssociations)
      .innerJoin(
        artifactAssociationRecognitionSupports,
        eq(
          artifactAssociationRecognitionSupports.associationId,
          artifactAssociations.id,
        ),
      )
      .innerJoin(
        recognitionDecisions,
        eq(
          recognitionDecisions.id,
          artifactAssociationRecognitionSupports.recognitionDecisionId,
        ),
      )
      .innerJoin(
        locations,
        and(
          eq(
            locations.id,
            artifactAssociationRecognitionSupports.observationLocationId,
          ),
          eq(locations.kind, "observed"),
        ),
      )
      .innerJoin(
        artifactRevisions,
        eq(
          artifactRevisions.id,
          artifactAssociationRecognitionSupports.observationRevisionId,
        ),
      )
      .innerJoin(blobs, eq(blobs.digest, artifactRevisions.blobDigest))
      .where(
        and(
          inArray(artifactAssociations.subjectId, sqliteTextSet(subjectIds)),
          inArray(artifactAssociations.role, sqliteTextSet(roles)),
          isNotNull(
            artifactAssociationRecognitionSupports.observationLocationId,
          ),
          isNotNull(
            artifactAssociationRecognitionSupports.observationRevisionId,
          ),
          eq(
            artifactAssociationRecognitionSupports.observationMaterialKind,
            "file",
          ),
          eq(artifactAssociations.subjectId, recognitionDecisions.assetId),
          sql`NOT EXISTS (
            SELECT 1 FROM recognition_decision_supersessions AS ended
            WHERE ended.predecessor_decision_id = ${recognitionDecisions.id}
          )
          AND NOT EXISTS (
            SELECT 1 FROM recognition_decision_retractions AS ended
            WHERE ended.predecessor_decision_id = ${recognitionDecisions.id}
          )
          AND NOT EXISTS (
            SELECT 1 FROM artifact_association_supersessions AS ended
            WHERE ended.predecessor_association_id = ${artifactAssociations.id}
          )
          AND NOT EXISTS (
            SELECT 1 FROM artifact_association_retractions AS ended
            WHERE ended.association_id = ${artifactAssociations.id}
          )`,
        ),
      )
      .all();
    const candidates: {
      readonly role: string;
      readonly target: RequestedLocalMaterialConfirmationTarget;
    }[] = [];
    for (const row of rows) {
      if (row.locationId === null || row.materialKind !== "file") continue;
      if (row.locationArtifactId !== row.revisionArtifactId) continue;
      // 保留接受图包含历史载体；同一地址已由本次接受投影到新 Location 时，旧位置不能
      // 再参加当前需求的数量选择，否则 maximum:1 会随机挑到旧摘要并把正常刷新判失败。
      // 没有当前观察仍可建立单位置正向观察，但不能取代该地址已经选定的另一载体。
      const currentLocation = query
        .select({ id: currentFileObservations.locationId })
        .from(currentFileObservations)
        .where(
          eq(
            currentFileObservations.address,
            path.resolve(row.locationAddress),
          ),
        )
        .get();
      if (
        currentLocation !== undefined &&
        currentLocation.id !== row.locationId
      )
        continue;
      const part =
        row.observedArtifactPartJson === null
          ? undefined
          : (JSON.parse(row.observedArtifactPartJson) as {
              readonly artifactId: string;
              readonly revisionId: string;
              readonly locator: string;
            });
      const carrierArtifactId = part?.artifactId ?? row.associationArtifactId;
      if (carrierArtifactId !== row.locationArtifactId) continue;
      if (part !== undefined && part.revisionId !== row.revisionId) continue;
      const entry = this.currentFileObservationEntryForAddress(
        row.locationAddress,
        snapshots,
        { requireWithinSnapshotRoot: true },
      );
      if (entry === undefined) continue;
      if (currentObservationsOnly) {
        const current = this.currentFileObservationCoordinatesWithDrizzle(
          query,
          row.locationId,
        );
        if (
          current === null ||
          current.snapshotId !== entry.snapshot.id ||
          current.observedAt !== entry.snapshot.observedAt ||
          current.size !== entry.size ||
          current.modifiedAt !== entry.modifiedAt
        )
          continue;
      }
      const acceptance = query
        .select({
          observedReference: observedMaterialAcceptances.observedReference,
          artifactId: observedMaterialAcceptances.artifactId,
        })
        .from(observedMaterialAcceptances)
        .where(
          and(
            eq(observedMaterialAcceptances.associationId, row.associationId),
            eq(observedMaterialAcceptances.locationId, row.locationId),
          ),
        )
        .all();
      const mismatchedCarrierAcceptance = acceptance.some(
        (item) => item.artifactId !== carrierArtifactId,
      );
      if (mismatchedCarrierAcceptance) continue;
      const matched = acceptance.find(
        (item) => item.artifactId === carrierArtifactId,
      );
      const observedReference =
        matched?.observedReference ??
        path.relative(entry.snapshot.root, path.resolve(row.locationAddress));
      if (
        row.targetKind === "entity" &&
        row.role === "asset.primary-cover" &&
        !this.observedMaterialReferenceRepresentsWithDrizzle(
          query,
          row.proposalId,
          observedReference,
        )
      )
        continue;
      candidates.push({
        role: row.role,
        target: {
          subjectId: row.subjectId,
          associationIds: [row.associationId],
          recognitionDecisionId: row.decisionId,
          proposalId: row.proposalId,
          observedArtifactReference: observedReference,
          carrierArtifactId,
          locationId: row.locationId,
          locationAddress: row.locationAddress,
          observedReference,
          expectedRevisionId: row.revisionId,
          expectedBlobDigest: row.blobDigest,
          expectedByteLength: row.byteLength,
          frozenEntry: {
            snapshotId: entry.snapshot.id,
            snapshotRoot: entry.snapshot.root,
            observedAt: entry.snapshot.observedAt,
            size: entry.size,
            modifiedAt: entry.modifiedAt,
          },
          ...(assetLibraryId === undefined ? {} : { assetLibraryId }),
        },
      });
    }
    return candidates;
  }

  /** 实体派生封面的当前角色资格：只代表引用集合内的材料才进入本次消费目标。 */
  private observedMaterialReferenceRepresentsWithDrizzle(
    query: DrizzleReadQuery,
    proposalId: string,
    reference: string,
  ): boolean {
    const proposal = this.readProposalWithDrizzle(query, proposalId);
    if (proposal === undefined) return false;
    return representativeObservedMaterialReferences(proposal).has(reference);
  }

  /** 本次执行冻结的观察根坐标；覆盖历史与正向支持共用。 */
  private observedSupportRootsFor(execution: WorkflowExecution): Array<{
    readonly id: string;
    readonly version: number;
    readonly path: string;
    readonly authorizedTargetsJson: string;
  }> {
    const roots: Array<{
      readonly id: string;
      readonly version: number;
      readonly path: string;
      readonly authorizedTargetsJson: string;
    }> = (execution.workflowInput?.observedRoots ?? []).map((root) => ({
      id: root.id,
      version: root.configVersion,
      path: root.containerPath,
      authorizedTargetsJson: JSON.stringify(root.authorizedTargetRoots ?? []),
    }));
    if (
      roots.length === 0 &&
      execution.workflowInput?.version ===
        "observed-material-association-input/1"
    ) {
      const root =
        execution.resolvedSelection?.filesystemScopes[0]?.observedRoot;
      if (root !== undefined)
        roots.push({
          id: root.id,
          version: root.configVersion,
          path: root.containerPath,
          authorizedTargetsJson: JSON.stringify(root.authorizedTargetRoots),
        });
    }
    return roots;
  }

  /**
   * Location 的耐久材料边界：一旦确认，其材料形态不再由同址条目改变。正向支持与
   * current 查询都只读该边界，绝不从保留的 workflow JSON 重新解释形态。
   */
  private observedMaterialBoundaryKindsWithDrizzle(
    transaction: DrizzleWriteTransaction,
  ): Map<string, "file" | "directory"> {
    return new Map(
      transaction
        .select({
          locationId: observedMaterialBoundaries.locationId,
          materialKind: observedMaterialBoundaries.materialKind,
        })
        .from(observedMaterialBoundaries)
        .all()
        .map((row) => [
          row.locationId,
          row.materialKind as "file" | "directory",
        ]),
    );
  }

  /**
   * 接受事务把本次 accepted 对象到 Artifact／Location／association／snapshot 的精确
   * 绑定耐久写下，并建立或核对材料边界。任一事实不一致都让整笔事务回滚；重试按
   * 主键幂等。
   */
  private recordObservedMaterialAcceptancesWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
    bindings: readonly ObservedMaterialAcceptanceBinding[],
  ): void {
    if (bindings.length === 0) return;
    const snapshots =
      execution.filesystemSnapshots ??
      (execution.snapshot === undefined ? [] : [execution.snapshot]);
    for (const binding of bindings) {
      const location = transaction
        .select({
          artifactId: locations.artifactId,
          kind: locations.kind,
          address: locations.address,
        })
        .from(locations)
        .where(eq(locations.id, binding.locationId))
        .get();
      if (location === undefined || location.kind !== "observed")
        throw new Error("观察材料接受缺少已存在的观察 Location");
      if (location.artifactId !== binding.artifactId)
        throw new Error("观察材料接受的 Artifact 与 Location 不一致");
      const association = transaction
        .select({
          subjectId: artifactAssociations.subjectId,
          artifactId: artifactAssociations.artifactId,
          role: artifactAssociations.role,
        })
        .from(artifactAssociations)
        .where(eq(artifactAssociations.id, binding.associationId))
        .get();
      if (
        association === undefined ||
        association.role !== "asset.material-delivered" ||
        association.subjectId !== binding.assetId ||
        association.artifactId !== binding.artifactId
      )
        throw new Error("观察材料接受缺少该内容的 delivered 材料关联");
      const proposal = transaction
        .select({ id: recognitionProposals.id })
        .from(recognitionProposals)
        .where(eq(recognitionProposals.id, binding.proposalId))
        .get();
      if (proposal === undefined) throw new Error("观察材料接受缺少对应提案");
      const snapshot = snapshots.find(
        (candidate) => candidate.id === binding.snapshotId,
      );
      if (snapshot === undefined)
        throw new Error("观察材料接受的 snapshot 不属于本次执行");
      const reference =
        binding.materialKind === "directory"
          ? snapshot.root
          : path.resolve(snapshot.root, binding.observedReference);
      if (reference !== path.resolve(location.address))
        throw new Error("观察材料接受与原始 snapshot 坐标不一致");
      if (
        binding.materialKind === "file" &&
        !snapshot.files.some(
          (file) =>
            path.resolve(snapshot.root, file.relativePath) ===
            path.resolve(snapshot.root, binding.observedReference),
        )
      )
        throw new Error("观察材料接受的文件不在原始 snapshot 中");
      const boundary = transaction
        .select({
          materialKind: observedMaterialBoundaries.materialKind,
        })
        .from(observedMaterialBoundaries)
        .where(eq(observedMaterialBoundaries.locationId, binding.locationId))
        .get();
      if (
        boundary !== undefined &&
        boundary.materialKind !== binding.materialKind
      )
        throw new Error("同一观察位置的材料形态发生冲突");
      transaction
        .insert(observedMaterialBoundaries)
        .values({
          locationId: binding.locationId,
          artifactId: binding.artifactId,
          materialKind: binding.materialKind,
          derivationKind: "accepted-exact",
        })
        .onConflictDoNothing()
        .run();
      transaction
        .insert(observedMaterialAcceptances)
        .values({
          executionId: execution.id,
          proposalId: binding.proposalId,
          workItemKey: binding.workItemKey,
          acceptanceKind: binding.acceptanceKind,
          assetId: binding.assetId,
          artifactId: binding.artifactId,
          locationId: binding.locationId,
          associationId: binding.associationId,
          snapshotId: binding.snapshotId,
          observedReference: binding.observedReference,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  /** 追加材料以版本化 checkpoint 的 submission projections 为逐项权威。 */
  private observedMaterialAssociationBindings(
    submission: ObservedMaterialAssociationSubmission,
  ): ObservedMaterialAcceptanceBinding[] {
    const basis = submission.proposal.basis;
    if (basis.kind !== "manual-boundary")
      throw new Error("观察材料追加必须携带人工边界依据");
    return submission.projections.map((projection) => ({
      workItemKey: "",
      acceptanceKind: "c-association" as const,
      proposalId: submission.proposal.id,
      assetId: submission.recognitionDecision.assetId,
      artifactId: projection.artifactId,
      locationId: projection.locationId,
      associationId: projection.associationId,
      snapshotId: basis.observationSnapshotId,
      observedReference: projection.observedArtifactReference,
      materialKind: "file" as const,
    }));
  }

  /**
   * 已确认应用的识别取代／范围修订 preview 只把 `projected - current` 的精确新增观察
   * Location／关联算作本次接受；preview 自身的 execution／proposal 是坐标来源。
   */
  private observedMaterialPreviewBindings(
    execution: WorkflowExecution | undefined,
    preview: ChangeImpactPreview,
  ): ObservedMaterialAcceptanceBinding[] {
    if (
      execution === undefined ||
      preview.status !== "applied" ||
      (preview.change.kind !== "recognition-supersession" &&
        preview.change.kind !== "recognition-scope-amendment")
    )
      return [];
    const snapshots = (
      execution.filesystemSnapshots ??
      (execution.snapshot === undefined ? [] : [execution.snapshot])
    ).filter((snapshot) => snapshot.complete);
    const currentLocationIds = new Set(
      preview.current.locations.map((location) => location.id),
    );
    const currentAssociationIds = new Set(
      preview.current.artifactAssociations.map((association) => association.id),
    );
    const bindings: ObservedMaterialAcceptanceBinding[] = [];
    for (const location of preview.projected.locations) {
      if (location.kind !== "observed" || currentLocationIds.has(location.id))
        continue;
      const association = preview.projected.artifactAssociations.find(
        (candidate) =>
          !currentAssociationIds.has(candidate.id) &&
          candidate.role === "asset.material-delivered" &&
          candidate.target.kind === "entity" &&
          candidate.target.entityId === preview.assetId &&
          candidate.artifactId === location.artifactId,
      );
      if (association === undefined) continue;
      const snapshot = snapshots.find(
        (candidate) =>
          path.resolve(candidate.root) === path.resolve(location.address) ||
          candidate.files.some(
            (file) =>
              path.resolve(candidate.root, file.relativePath) ===
              path.resolve(location.address),
          ),
      );
      if (snapshot === undefined) continue;
      const isRoot =
        path.resolve(snapshot.root) === path.resolve(location.address);
      bindings.push({
        workItemKey: "",
        acceptanceKind: "a-preview",
        proposalId: preview.change.proposal.id,
        assetId: preview.assetId,
        artifactId: location.artifactId,
        locationId: location.id,
        associationId: association.id,
        snapshotId: snapshot.id,
        observedReference: isRoot
          ? "."
          : path.relative(snapshot.root, location.address),
        materialKind: isRoot ? "directory" : "file",
      });
    }
    return bindings;
  }

  /**
   * 已确认应用的识别取代 preview：写 exact boundary／binding，并以该 preview 执行自己的
   * snapshot 为新增 Location 建立正向事件。
   */
  private applyAppliedPreviewMaterialBindingsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution | undefined,
    preview: ChangeImpactPreview,
  ): void {
    if (execution === undefined) return;
    const bindings = this.observedMaterialPreviewBindings(execution, preview);
    this.recordObservedMaterialAcceptancesWithDrizzle(
      transaction,
      execution,
      bindings,
    );
    const addressByLocation = new Map(
      preview.projected.locations.map((location) => [
        location.id,
        location.address,
      ]),
    );
    for (const binding of bindings) {
      const address = addressByLocation.get(binding.locationId);
      if (address === undefined) continue;
      this.projectCurrentObservedMaterialSupportForLocation(
        transaction,
        execution,
        address,
        binding.locationId,
        binding.materialKind,
      );
    }
    // 本次交付的 observed Location 需建立当前文件观察投影，之后才能经公开字节确认
    // 入口形成 selection 并被普通读取接纳。apply 只声明“该完整观察在此地址看到此
    // 大小/mtime 的文件”，不插入观察修订确认，也不把冻结摘要当作今天仍可消费的字节。
    // 只投影本次 binding 对应的位置，不把范围修订或取代扩大成整库重投影。
    const bindingLocationIds = new Set(
      bindings.map((binding) => binding.locationId),
    );
    this.projectCurrentFileObservationsWithDrizzle(
      transaction,
      execution,
      preview.projected.locations.filter(
        (location) =>
          location.kind === "observed" && bindingLocationIds.has(location.id),
      ),
    );
  }

  /**
   * 正向材料支持表达“该观察根版本在一次成功完整观察中把此 Location 确认为文件或目录”。
   * 只有与本次执行冻结根相交的完整 snapshot 才能建立它。
   */
  private recordCurrentObservedMaterialSupportsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
    locationId: string,
    snapshot: FilesystemPackageSnapshot,
    materialKind: "file" | "directory",
  ): void {
    for (const root of this.observedSupportRootsFor(execution)) {
      if (!pathIsWithin(root.path, snapshot.root)) continue;
      transaction
        .insert(currentObservedMaterialSupports)
        .values({
          locationId,
          observedRootId: root.id,
          observedRootVersion: root.version,
          materialKind,
          snapshotId: snapshot.id,
          observedAt: snapshot.observedAt,
          observedRootPath: root.path,
          authorizedTargetsJson: root.authorizedTargetsJson,
        })
        .onConflictDoUpdate({
          target: [
            currentObservedMaterialSupports.locationId,
            currentObservedMaterialSupports.observedRootId,
            currentObservedMaterialSupports.observedRootVersion,
          ],
          set: {
            materialKind,
            snapshotId: snapshot.id,
            observedAt: snapshot.observedAt,
            observedRootPath: root.path,
            authorizedTargetsJson: root.authorizedTargetsJson,
          },
        })
        .run();
    }
  }

  /**
   * 完整精确覆盖内消失的位置只撤销本次冻结根版本的正向支持。库扫描代表子额外携带
   * 同父其他目录的只读覆盖坐标：只有该前缀被精确完整覆盖（子树无排除与诊断缺口）才
   * 撤销该目录原坐标的正向支持，缺口一律保守保留；绝不写正向支持，也不改写决定自身的
   * scopeReference。
   */
  private removeCurrentObservedMaterialSupportsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
    locationId: string,
    address: string,
  ): void {
    const supportRoots = [
      ...this.observedSupportRootsFor(execution),
      ...this.coveredLibraryScanSupportRootsFor(execution, address),
    ];
    for (const root of supportRoots) {
      transaction
        .delete(currentObservedMaterialSupports)
        .where(
          and(
            eq(currentObservedMaterialSupports.locationId, locationId),
            eq(currentObservedMaterialSupports.observedRootId, root.id),
            eq(
              currentObservedMaterialSupports.observedRootVersion,
              root.version,
            ),
          ),
        )
        .run();
    }
  }

  /**
   * 本次快照对同父 covered 目录的精确覆盖坐标。它是缺失结束的只读证据，不是新的
   * I/O 授权，也不参与正向支持。
   */
  private coveredLibraryScanSupportRootsFor(
    execution: WorkflowExecution,
    address: string,
  ): Array<{ readonly id: string; readonly version: number }> {
    const coverage = execution.workflowInput?.directoryCoverage;
    if (coverage === undefined || coverage.length === 0) return [];
    const representative = (execution.workflowInput?.observedRoots ?? []).find(
      (root) => root.id === execution.workflowInput?.parentDirectoryKey,
    );
    if (representative === undefined) return [];
    const snapshots = (
      execution.filesystemSnapshots ??
      (execution.snapshot === undefined ? [] : [execution.snapshot])
    ).filter((snapshot) => snapshot.complete);
    return stableRootCoverages({
      snapshots,
      representativeRootPath: representative.containerPath,
      covered: coverage,
    })
      .filter(
        (entry) =>
          entry.preciselyComplete &&
          pathIsWithin(entry.coveredAddress, address),
      )
      .map((entry) => ({
        id: entry.scopeReference,
        version: entry.rootVersion,
      }));
  }

  /**
   * 按 Location 的耐久材料边界，用完整 snapshot 的精确条目决定它当前的正向支持。
   * 形态只由 boundary 决定：文件位置的同址目录不升级，目录位置的同址文件不降格。
   * 文件 present 只属于该地址的精确 Location（对象身份／当前观察解析），缺失则撤销
   * 同址全部文件位置，避免按地址把历史同形态 Location 一起复活。
   */
  private projectCurrentObservedMaterialSupportForLocation(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
    address: string,
    locationId: string,
    materialKind: "file" | "directory" | undefined,
    presentEligible = true,
  ): void {
    if (materialKind === undefined) return;
    const snapshots = (
      execution.filesystemSnapshots ??
      (execution.snapshot === undefined ? [] : [execution.snapshot])
    ).filter((snapshot) => snapshot.complete);
    const resolved = path.resolve(address);
    const latest = <T extends { snapshot: FilesystemPackageSnapshot }>(
      matches: readonly T[],
    ): T | undefined =>
      matches.toSorted((left, right) =>
        right.snapshot.observedAt.localeCompare(left.snapshot.observedAt),
      )[0];
    const present = latest(
      snapshots.flatMap((snapshot) =>
        !pathIsWithin(snapshot.root, address)
          ? []
          : (materialKind === "file"
              ? snapshot.files
              : (snapshot.directories ?? [])
            )
              .filter(
                (entry) =>
                  path.resolve(snapshot.root, entry.relativePath) === resolved,
              )
              .map(() => ({ snapshot })),
      ),
    );
    if (present !== undefined) {
      this.recordCurrentFileObservationSupportsWithDrizzle(
        transaction,
        execution,
        locationId,
      );
      if (presentEligible)
        this.recordCurrentObservedMaterialSupportsWithDrizzle(
          transaction,
          execution,
          locationId,
          present.snapshot,
          materialKind,
        );
      return;
    }
    if (this.scanPreciselyCoversAddress(snapshots, address))
      this.removeCurrentObservedMaterialSupportsWithDrizzle(
        transaction,
        execution,
        locationId,
        address,
      );
  }

  private recordCurrentFileObservationSupportsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
    locationId: string,
  ): void {
    for (const root of this.observedSupportRootsFor(execution)) {
      transaction
        .delete(currentFileObservationSupports)
        .where(
          and(
            eq(currentFileObservationSupports.locationId, locationId),
            eq(currentFileObservationSupports.observedRootId, root.id),
            eq(
              currentFileObservationSupports.observedRootVersion,
              root.version,
            ),
          ),
        )
        .run();
      transaction
        .insert(currentFileObservationSupports)
        .values({
          locationId,
          observedRootId: root.id,
          observedRootVersion: root.version,
          observedRootPath: root.path,
          authorizedTargetsJson: root.authorizedTargetsJson,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  private insertOrReuseSourcedEntityWithDrizzle(
    transaction: DrizzleWriteTransaction,
    entity: SourcedEntity,
  ): void {
    const existing = transaction
      .select({
        sourceIdentity: sourcedEntities.sourceIdentity,
        sourceKey: sourcedEntities.sourceKey,
        identityNamespace: sourcedEntities.identityNamespace,
        producerJson: sourcedEntities.producerJson,
      })
      .from(entities)
      .leftJoin(sourcedEntities, eq(sourcedEntities.id, entities.id))
      .where(eq(entities.id, entity.id))
      .get();
    if (existing !== undefined) {
      if (
        existing.sourceIdentity !== entity.sourceIdentity ||
        existing.sourceKey !== entity.sourceKey ||
        existing.identityNamespace !== entity.identityNamespace
      ) {
        throw new Error(
          `Entity ${entity.id} conflicts with an existing sourced identity`,
        );
      }
      assertCompatibleProducer(
        existing.producerJson,
        entity.producer,
        "Sourced Entity",
      );
      transaction
        .update(sourcedEntities)
        .set({
          producerJson: sql`COALESCE(${sourcedEntities.producerJson}, ${producerJson(entity.producer)})`,
        })
        .where(eq(sourcedEntities.id, entity.id))
        .run();
      return;
    }

    transaction.insert(entities).values({ id: entity.id }).run();
    transaction
      .insert(sourcedEntities)
      .values({
        id: entity.id,
        sourceIdentity: entity.sourceIdentity,
        sourceKey: entity.sourceKey,
        identityNamespace: entity.identityNamespace,
        label: entity.label,
        role: null,
        sourceRecordIdsJson: JSON.stringify(entity.sourceRecordIds),
        producerJson: producerJson(entity.producer),
      })
      .run();
  }

  /** 通过同一个 Drizzle 查询所有者解析保留证据。 */
  private sourceRecordWithDrizzle(
    query: DrizzleReadQuery,
    sourceRecordId: string,
  ): SourceRecord {
    const row = query
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.id, sourceRecordId))
      .get();
    if (row === undefined)
      throw new Error("Source fact references an unretained Source Record");
    return sourceRecordFromDrizzle(row);
  }

  private sourceRecordContextWithDrizzle(
    query: DrizzleReadQuery,
    sourceRecordId: string,
  ): {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
    readonly coverageId: string;
  } {
    const record = this.sourceRecordWithDrizzle(query, sourceRecordId);
    return {
      sourceIdentity: record.sourceIdentity,
      nativeAddress: record.nativeAddress,
      coverageId: record.coverage.id,
    };
  }

  private retractScopedFactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly assetId: string;
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
      readonly coverageId: string;
      readonly predecessorSourceRecordId: string;
      readonly sourceRecordId: string;
      readonly coverageCompleteness: "complete" | "incomplete";
      readonly nextMetadataCoordinates: readonly string[];
      readonly nextRelationshipCoordinates: readonly string[];
    },
  ): void {
    const predecessorSourceRecordIds = this.sourceRecordLineageIdsWithDrizzle(
      transaction,
      {
        assetId: input.assetId,
        sourceIdentity: input.sourceIdentity,
        nativeAddress: input.nativeAddress,
        coverageId: input.coverageId,
        sourceRecordId: input.predecessorSourceRecordId,
      },
    );
    if (predecessorSourceRecordIds.length === 0) return;
    const sourceScope = {
      sourceIdentity: input.sourceIdentity,
      nativeAddress: input.nativeAddress,
      coverage: { id: input.coverageId },
    };
    const metadata = this.currentMetadataForSourceRefreshLineageWithDrizzle(
      transaction,
      sourceScope,
      predecessorSourceRecordIds,
    );
    const metadataChanges = deriveSourceSlotLifecycleChanges({
      currentSlots: metadata.map((item) =>
        sourceFactCoordinate(item.subjectId, item.sourceSlot),
      ),
      nextSlots: input.nextMetadataCoordinates,
      coverageCompleteness: input.coverageCompleteness,
    });
    const retractedMetadataSlots = new Set(metadataChanges.retracted);
    for (const item of metadata) {
      if (
        !retractedMetadataSlots.has(
          sourceFactCoordinate(item.subjectId, item.sourceSlot),
        )
      )
        continue;
      transaction
        .insert(metadataAssertionRetractions)
        .values({
          id: `metadata-retraction_${input.sourceRecordId}_${item.assertionId}`,
          assertionId: item.assertionId,
          sourceRecordId: input.sourceRecordId,
        })
        .onConflictDoNothing()
        .run();
    }
    const relationships =
      this.currentRelationshipsForSourceRefreshLineageWithDrizzle(
        transaction,
        sourceScope,
        predecessorSourceRecordIds,
      );
    const relationshipChanges = deriveSourceSlotLifecycleChanges({
      currentSlots: relationships.map((item) =>
        sourceFactCoordinate(item.subjectId, item.sourceSlot),
      ),
      nextSlots: input.nextRelationshipCoordinates,
      coverageCompleteness: input.coverageCompleteness,
    });
    const retractedRelationshipSlots = new Set(relationshipChanges.retracted);
    for (const item of relationships) {
      if (
        !retractedRelationshipSlots.has(
          sourceFactCoordinate(item.subjectId, item.sourceSlot),
        )
      )
        continue;
      transaction
        .insert(relationshipRetractions)
        .values({
          id: `relationship-retraction_${input.sourceRecordId}_${item.relationshipId}`,
          relationshipId: item.relationshipId,
          sourceRecordId: input.sourceRecordId,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  /**
   * 解析与历史递归 CTE 相同的不可变前驱链，但将查找保留在调用方的 Drizzle 查询所有者内。
   * 一条来源记录在其精确主体/来源/覆盖坐标上至多有一个前驱，因此沿该边查找既能保留
   * CTE 的去重结果，也无需暴露原生驱动。
   */
  private sourceRecordLineageIdsWithDrizzle(
    query: DrizzleReadQuery,
    input: {
      readonly assetId: string;
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
      readonly coverageId: string;
      readonly sourceRecordId: string;
    },
  ): readonly string[] {
    const lineage: string[] = [];
    const visited = new Set<string>();
    let current: string | null = input.sourceRecordId;
    while (current !== null && !visited.has(current)) {
      lineage.push(current);
      visited.add(current);
      const change = query
        .select({
          baselineSourceRecordId: sourceRefreshChanges.baselineSourceRecordId,
        })
        .from(sourceRefreshChanges)
        .where(
          and(
            eq(sourceRefreshChanges.sourceRecordId, current),
            eq(sourceRefreshChanges.subjectId, input.assetId),
            eq(sourceRefreshChanges.sourceIdentity, input.sourceIdentity),
            eq(sourceRefreshChanges.nativeAddress, input.nativeAddress),
            eq(sourceRefreshChanges.coverageId, input.coverageId),
          ),
        )
        .get();
      current = change?.baselineSourceRecordId ?? null;
    }
    return lineage;
  }

  private currentMetadataForSourceRefreshLineageWithDrizzle(
    query: DrizzleReadQuery,
    record: Pick<SourceRecord, "sourceIdentity" | "nativeAddress"> & {
      readonly coverage: Pick<SourceRecord["coverage"], "id">;
    },
    sourceRecordIds: readonly string[],
  ): Array<{
    readonly assertionId: number;
    readonly subjectId: string;
    readonly sourceSlot: string;
    readonly property: string;
    readonly value: string;
    readonly qualifiers_json: string;
  }> {
    const candidates = query
      .select({
        assertionId: metadataAssertionLifecycles.assertionId,
        subjectId: metadataAssertions.subjectId,
        sourceSlot: metadataAssertionLifecycles.sourceSlot,
        property: metadataAssertions.property,
        value: metadataAssertions.value,
        qualifiers_json: metadataAssertions.qualifiersJson,
      })
      .from(metadataAssertionLifecycles)
      .innerJoin(
        metadataAssertions,
        eq(metadataAssertions.id, metadataAssertionLifecycles.assertionId),
      )
      .where(
        and(
          eq(metadataAssertionLifecycles.sourceIdentity, record.sourceIdentity),
          eq(metadataAssertionLifecycles.nativeAddress, record.nativeAddress),
          eq(metadataAssertionLifecycles.coverageId, record.coverage.id),
          inArray(metadataAssertionLifecycles.sourceRecordId, sourceRecordIds),
        ),
      )
      .orderBy(asc(metadataAssertionLifecycles.assertionId))
      .all();
    if (candidates.length === 0) return [];
    const assertionIds = candidates.map((candidate) => candidate.assertionId);
    const retracted = new Set(
      query
        .select({ assertionId: metadataAssertionRetractions.assertionId })
        .from(metadataAssertionRetractions)
        .where(inArray(metadataAssertionRetractions.assertionId, assertionIds))
        .all()
        .map((row) => row.assertionId),
    );
    const superseded = new Set(
      query
        .select({
          predecessorAssertionId:
            metadataAssertionLifecycles.predecessorAssertionId,
        })
        .from(metadataAssertionLifecycles)
        .where(
          inArray(
            metadataAssertionLifecycles.predecessorAssertionId,
            assertionIds,
          ),
        )
        .all()
        .flatMap((row) =>
          row.predecessorAssertionId === null
            ? []
            : [row.predecessorAssertionId],
        ),
    );
    return candidates.filter(
      (candidate) =>
        !retracted.has(candidate.assertionId) &&
        !superseded.has(candidate.assertionId),
    );
  }

  private currentRelationshipsForSourceRefreshLineageWithDrizzle(
    query: DrizzleReadQuery,
    record: Pick<SourceRecord, "sourceIdentity" | "nativeAddress"> & {
      readonly coverage: Pick<SourceRecord["coverage"], "id">;
    },
    sourceRecordIds: readonly string[],
  ): Array<{
    readonly relationshipId: string;
    readonly subjectId: string;
    readonly sourceSlot: string;
    readonly participants_json: string;
    readonly type: string;
    readonly qualifiers_json: string;
  }> {
    const candidates = query
      .select({
        relationshipId: relationshipLifecycles.relationshipId,
        subjectId: relationshipLifecycles.sourceSubjectId,
        sourceSlot: relationshipLifecycles.sourceSlot,
        participants_json: entityRelationships.participantsJson,
        type: entityRelationships.type,
        qualifiers_json: entityRelationships.qualifiersJson,
      })
      .from(relationshipLifecycles)
      .innerJoin(
        entityRelationships,
        eq(entityRelationships.id, relationshipLifecycles.relationshipId),
      )
      .where(
        and(
          eq(relationshipLifecycles.sourceIdentity, record.sourceIdentity),
          eq(relationshipLifecycles.nativeAddress, record.nativeAddress),
          eq(relationshipLifecycles.coverageId, record.coverage.id),
          inArray(relationshipLifecycles.sourceRecordId, sourceRecordIds),
        ),
      )
      .orderBy(asc(sql<number>`${entityRelationships}.rowid`))
      .all();
    if (candidates.length === 0) return [];
    const relationshipIds = candidates.map(
      (candidate) => candidate.relationshipId,
    );
    const retracted = new Set(
      query
        .select({ relationshipId: relationshipRetractions.relationshipId })
        .from(relationshipRetractions)
        .where(inArray(relationshipRetractions.relationshipId, relationshipIds))
        .all()
        .map((row) => row.relationshipId),
    );
    const superseded = new Set(
      query
        .select({
          predecessorRelationshipId:
            relationshipLifecycles.predecessorRelationshipId,
        })
        .from(relationshipLifecycles)
        .where(
          inArray(
            relationshipLifecycles.predecessorRelationshipId,
            relationshipIds,
          ),
        )
        .all()
        .flatMap((row) =>
          row.predecessorRelationshipId === null
            ? []
            : [row.predecessorRelationshipId],
        ),
    );
    return candidates.filter(
      (candidate) =>
        !retracted.has(candidate.relationshipId) &&
        !superseded.has(candidate.relationshipId),
    );
  }

  private insertRefreshMetadataWithDrizzle(
    transaction: DrizzleWriteTransaction,
    submission: MetadataRefreshSubmission,
  ): void {
    for (const assertion of submission.interpretation.metadata) {
      const primary = assertion.sourceRecordIds[0];
      if (primary === undefined)
        throw new Error("Metadata Assertion requires Source Record provenance");
      const context = this.sourceRecordContextWithDrizzle(transaction, primary);
      const candidates = transaction
        .select({
          assertion_id: metadataAssertionLifecycles.assertionId,
          property: metadataAssertions.property,
          value: metadataAssertions.value,
          qualifiers_json: metadataAssertions.qualifiersJson,
          source_record_ids_json: metadataAssertions.sourceRecordIdsJson,
          producer_json: metadataAssertions.producerJson,
        })
        .from(metadataAssertionLifecycles)
        .innerJoin(
          metadataAssertions,
          eq(metadataAssertions.id, metadataAssertionLifecycles.assertionId),
        )
        .where(
          and(
            eq(
              metadataAssertions.subjectId,
              assertion.subjectId ?? submission.assetId,
            ),
            eq(
              metadataAssertionLifecycles.sourceIdentity,
              context.sourceIdentity,
            ),
            eq(
              metadataAssertionLifecycles.nativeAddress,
              context.nativeAddress,
            ),
            eq(metadataAssertionLifecycles.coverageId, context.coverageId),
            eq(metadataAssertionLifecycles.sourceSlot, assertion.sourceSlot),
          ),
        )
        .orderBy(desc(metadataAssertionLifecycles.assertionId))
        .all();
      const superseded = new Set(
        transaction
          .select({
            predecessorId: metadataAssertionLifecycles.predecessorAssertionId,
          })
          .from(metadataAssertionLifecycles)
          .all()
          .flatMap((row) =>
            row.predecessorId === null ? [] : [row.predecessorId],
          ),
      );
      const retracted = new Set(
        transaction
          .select({ assertionId: metadataAssertionRetractions.assertionId })
          .from(metadataAssertionRetractions)
          .all()
          .map((row) => row.assertionId),
      );
      const previous = candidates.find(
        (candidate) =>
          !superseded.has(candidate.assertion_id) &&
          !retracted.has(candidate.assertion_id),
      );
      if (
        previous !== undefined &&
        metadataAssertionMatchesCurrent(previous, assertion) &&
        !durableProducerDiverges(previous.producer_json, assertion.producer)
      ) {
        const provenance = new Set([
          ...(JSON.parse(previous.source_record_ids_json) as string[]),
          ...assertion.sourceRecordIds,
        ]);
        transaction
          .update(metadataAssertions)
          .set({
            sourceRecordIdsJson: JSON.stringify([...provenance].toSorted()),
            producerJson: sql`COALESCE(${metadataAssertions.producerJson}, ${producerJson(assertion.producer)})`,
          })
          .where(eq(metadataAssertions.id, previous.assertion_id))
          .run();
        for (const sourceRecordId of assertion.sourceRecordIds)
          transaction
            .insert(metadataAssertionSources)
            .values({
              assertionId: previous.assertion_id,
              sourceRecordId,
            })
            .onConflictDoNothing()
            .run();
        continue;
      }
      const result = transaction
        .insert(metadataAssertions)
        .values({
          subjectId: assertion.subjectId ?? submission.assetId,
          ...descriptionTargetColumns({
            kind: "entity",
            entityId: assertion.subjectId ?? submission.assetId,
          }),
          property: assertion.property,
          value: assertion.value,
          sourceRecordIdsJson: JSON.stringify(assertion.sourceRecordIds),
          qualifiersJson: JSON.stringify(assertion.qualifiers ?? []),
          sourceSlot: assertion.sourceSlot,
          observedArtifactPartJson: null,
          producerJson: producerJson(assertion.producer),
        })
        .run();
      const assertionId = Number(result.lastInsertRowid);
      for (const sourceRecordId of assertion.sourceRecordIds)
        transaction
          .insert(metadataAssertionSources)
          .values({ assertionId, sourceRecordId })
          .run();
      transaction
        .insert(metadataAssertionLifecycles)
        .values({
          assertionId,
          sourceIdentity: context.sourceIdentity,
          nativeAddress: context.nativeAddress,
          coverageId: context.coverageId,
          sourceSlot: assertion.sourceSlot,
          sourceRecordId: primary,
          predecessorAssertionId: previous?.assertion_id ?? null,
        })
        .run();
    }
  }

  private insertRefreshRelationshipsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    submission: MetadataRefreshSubmission,
  ): void {
    for (const entity of submission.interpretation.entities ?? []) {
      transaction
        .insert(entities)
        .values({ id: entity.id })
        .onConflictDoNothing()
        .run();
      transaction
        .insert(sourcedEntities)
        .values({
          id: entity.id,
          sourceIdentity: entity.sourceIdentity,
          sourceKey: entity.sourceKey,
          identityNamespace: entity.identityNamespace,
          label: entity.label,
          role: null,
          sourceRecordIdsJson: JSON.stringify(entity.sourceRecordIds),
          producerJson: producerJson(entity.producer),
        })
        .onConflictDoNothing()
        .run();
    }
    for (const relationship of submission.interpretation.relationships ?? []) {
      const primary = relationship.sourceRecordIds[0];
      if (primary === undefined)
        throw new Error("Relationship requires Source Record provenance");
      const context = this.sourceRecordContextWithDrizzle(transaction, primary);
      const participants = [
        ...(relationship.subjectRole === undefined
          ? []
          : [{ entityId: submission.assetId, role: relationship.subjectRole }]),
        ...relationship.participants,
      ];
      const candidates = transaction
        .select({
          relationship_id: relationshipLifecycles.relationshipId,
          participants_json: entityRelationships.participantsJson,
          type: entityRelationships.type,
          qualifiers_json: entityRelationships.qualifiersJson,
          source_record_ids_json: entityRelationships.sourceRecordIdsJson,
          producer_json: entityRelationships.producerJson,
        })
        .from(relationshipLifecycles)
        .innerJoin(
          entityRelationships,
          eq(entityRelationships.id, relationshipLifecycles.relationshipId),
        )
        .where(
          and(
            eq(
              relationshipLifecycles.sourceSubjectId,
              relationshipSourceSubjectId(submission.assetId, relationship),
            ),
            eq(relationshipLifecycles.sourceIdentity, context.sourceIdentity),
            eq(relationshipLifecycles.nativeAddress, context.nativeAddress),
            eq(relationshipLifecycles.coverageId, context.coverageId),
            eq(relationshipLifecycles.sourceSlot, relationship.sourceSlot),
          ),
        )
        .orderBy(desc(sql<number>`${entityRelationships}.rowid`))
        .all();
      const superseded = new Set(
        transaction
          .select({
            predecessorId: relationshipLifecycles.predecessorRelationshipId,
          })
          .from(relationshipLifecycles)
          .all()
          .flatMap((row) =>
            row.predecessorId === null ? [] : [row.predecessorId],
          ),
      );
      const retracted = new Set(
        transaction
          .select({ relationshipId: relationshipRetractions.relationshipId })
          .from(relationshipRetractions)
          .all()
          .map((row) => row.relationshipId),
      );
      const previous = candidates.find(
        (candidate) =>
          !superseded.has(candidate.relationship_id) &&
          !retracted.has(candidate.relationship_id),
      );
      if (
        previous !== undefined &&
        relationshipMatchesCurrent(previous, {
          ...relationship,
          participants,
        }) &&
        !durableProducerDiverges(previous.producer_json, relationship.producer)
      ) {
        const provenance = new Set([
          ...(JSON.parse(previous.source_record_ids_json) as string[]),
          ...relationship.sourceRecordIds,
        ]);
        transaction
          .update(entityRelationships)
          .set({
            sourceRecordIdsJson: JSON.stringify([...provenance].toSorted()),
            producerJson: sql`COALESCE(${entityRelationships.producerJson}, ${producerJson(relationship.producer)})`,
          })
          .where(eq(entityRelationships.id, previous.relationship_id))
          .run();
        for (const sourceRecordId of relationship.sourceRecordIds)
          transaction
            .insert(relationshipSources)
            .values({
              relationshipId: previous.relationship_id,
              sourceRecordId,
            })
            .onConflictDoNothing()
            .run();
        continue;
      }
      const relationshipId = `source-refresh-relationship_${randomUUID()}`;
      transaction
        .insert(entityRelationships)
        .values({
          id: relationshipId,
          type: relationship.type,
          participantsJson: JSON.stringify(participants),
          sourceRecordIdsJson: JSON.stringify(relationship.sourceRecordIds),
          qualifiersJson: JSON.stringify(relationship.qualifiers ?? []),
          producerJson: producerJson(relationship.producer),
        })
        .run();
      for (const participant of participants)
        transaction
          .insert(entityRelationshipParticipants)
          .values({
            relationshipId,
            entityId: participant.entityId,
            role: participant.role,
            mentionIdsJson: JSON.stringify(participant.mentionIds ?? []),
          })
          .run();
      for (const sourceRecordId of relationship.sourceRecordIds)
        transaction
          .insert(relationshipSources)
          .values({ relationshipId, sourceRecordId })
          .run();
      transaction
        .insert(relationshipLifecycles)
        .values({
          relationshipId,
          sourceSubjectId: relationshipSourceSubjectId(
            submission.assetId,
            relationship,
          ),
          sourceIdentity: context.sourceIdentity,
          nativeAddress: context.nativeAddress,
          coverageId: context.coverageId,
          sourceRecordId: primary,
          sourceSlot: relationship.sourceSlot,
          predecessorRelationshipId: previous?.relationship_id ?? null,
        })
        .run();
    }
  }

  private insertRefreshMentionsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    submission: MetadataRefreshSubmission,
  ): void {
    for (const mention of submission.interpretation.entityMentions ?? []) {
      transaction
        .insert(entityMentions)
        .values({
          id: mention.id,
          sourceIdentity: mention.sourceIdentity,
          field: mention.field,
          role: mention.role,
          label: mention.label,
          identityNamespace: mention.identityNamespace,
          sourceKey: mention.sourceKey,
          sourceRecordIdsJson: JSON.stringify(mention.sourceRecordIds),
          producerJson: producerJson(mention.producer),
        })
        .onConflictDoNothing()
        .run();
    }
    for (const resolution of submission.interpretation
      .entityResolutionDecisions ?? []) {
      transaction
        .insert(entityResolutionDecisions)
        .values({
          id: resolution.id,
          mentionId: resolution.mentionId,
          entityId: resolution.entityId,
          rule: resolution.rule,
          sourceRecordIdsJson: JSON.stringify(resolution.sourceRecordIds),
          producerJson: producerJson(resolution.producer),
          basis: "source",
          operation: "select",
        })
        .onConflictDoNothing()
        .run();
    }
  }

  private insertProjectedRelationshipsAndMentionsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    preview: ChangeImpactPreview & { readonly proposal: RecognitionProposal },
  ): void {
    const replacementSourceRecordIds = new Set(
      recognitionSourceInterpretation(preview.proposal)?.sourceRecordIds ?? [],
    );
    const isReplacementFact = (ids: readonly string[]) =>
      ids.length > 0 &&
      ids.every((sourceRecordId) =>
        replacementSourceRecordIds.has(sourceRecordId),
      );
    for (const entity of preview.projected.entities.filter((item) =>
      isReplacementFact(item.sourceRecordIds),
    )) {
      transaction
        .insert(entities)
        .values({ id: entity.id })
        .onConflictDoNothing()
        .run();
      transaction
        .insert(sourcedEntities)
        .values({
          id: entity.id,
          sourceIdentity: entity.sourceIdentity,
          sourceKey: entity.sourceKey,
          identityNamespace: entity.identityNamespace,
          label: entity.label,
          role: null,
          sourceRecordIdsJson: JSON.stringify(entity.sourceRecordIds),
          producerJson: producerJson(entity.producer),
        })
        .onConflictDoNothing()
        .run();
    }
    for (const relationship of preview.projected.relationships.filter((item) =>
      isReplacementFact(item.sourceRecordIds),
    )) {
      const primary = relationship.sourceRecordIds[0];
      if (primary === undefined)
        throw new Error("Projected relationship requires provenance");
      const context = this.sourceRecordContextWithDrizzle(transaction, primary);
      transaction
        .insert(entityRelationships)
        .values({
          id: relationship.id,
          type: relationship.type,
          participantsJson: JSON.stringify(relationship.participants),
          sourceRecordIdsJson: JSON.stringify(relationship.sourceRecordIds),
          qualifiersJson: JSON.stringify(relationship.qualifiers ?? []),
          producerJson: producerJson(relationship.producer),
        })
        .run();
      for (const participant of relationship.participants)
        transaction
          .insert(entityRelationshipParticipants)
          .values({
            relationshipId: relationship.id,
            entityId: participant.entityId,
            role: participant.role,
            mentionIdsJson: JSON.stringify(participant.mentionIds ?? []),
          })
          .onConflictDoNothing()
          .run();
      for (const sourceRecordId of relationship.sourceRecordIds)
        transaction
          .insert(relationshipSources)
          .values({ relationshipId: relationship.id, sourceRecordId })
          .run();
      transaction
        .insert(relationshipLifecycles)
        .values({
          relationshipId: relationship.id,
          sourceSubjectId: relationship.sourceSubjectId ?? preview.assetId,
          sourceIdentity: context.sourceIdentity,
          nativeAddress: context.nativeAddress,
          coverageId: context.coverageId,
          sourceRecordId: primary,
          sourceSlot: relationship.sourceSlot,
          predecessorRelationshipId: null,
        })
        .run();
    }
    for (const mention of preview.projected.entityMentions.filter((item) =>
      isReplacementFact(item.sourceRecordIds),
    )) {
      transaction
        .insert(entityMentions)
        .values({
          id: mention.id,
          sourceIdentity: mention.sourceIdentity,
          field: mention.field,
          role: mention.role,
          label: mention.label,
          identityNamespace: mention.identityNamespace,
          sourceKey: mention.sourceKey,
          sourceRecordIdsJson: JSON.stringify(mention.sourceRecordIds),
          producerJson: producerJson(mention.producer),
        })
        .onConflictDoNothing()
        .run();
    }
    for (const decision of preview.projected.entityResolutionDecisions.filter(
      (item) => isReplacementFact(item.sourceRecordIds),
    )) {
      transaction
        .insert(entityResolutionDecisions)
        .values({
          id: decision.id,
          mentionId: decision.mentionId,
          entityId: decision.entityId,
          rule: decision.rule,
          sourceRecordIdsJson: JSON.stringify(decision.sourceRecordIds),
          producerJson: producerJson(decision.producer),
          basis: "source",
          operation: "select",
        })
        .run();
    }
  }

  private applyProjectedArtifactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    preview: ChangeImpactPreview & { readonly proposal: RecognitionProposal },
    predecessorDecisionId: string,
    successorDecisionId: string,
  ): void {
    const artifactIds = new Set(
      preview.projected.artifacts.map((artifact) => artifact.id),
    );
    const blobDigests = new Set(
      preview.projected.blobs.map((blob) => blob.digest),
    );
    if (
      preview.projected.locations.some(
        (location) => !artifactIds.has(location.artifactId),
      ) ||
      preview.projected.artifactRevisions.some(
        (revision) =>
          !artifactIds.has(revision.artifactId) ||
          !blobDigests.has(revision.blobDigest),
      ) ||
      preview.projected.artifactAssociations.some(
        (association) =>
          (association.target.kind === "entity"
            ? association.target.entityId !== preview.assetId &&
              !preview.projected.entities.some(
                (entity) =>
                  association.target.kind === "entity" &&
                  entity.id === association.target.entityId,
              )
            : !preview.projected.artifactRevisions.some(
                (revision) =>
                  association.target.kind === "artifact-revision" &&
                  revision.artifactId === association.target.artifactId &&
                  revision.id === association.target.revisionId,
              )) || !artifactIds.has(association.artifactId),
      )
    ) {
      throw new Error("Projected artifact graph is inconsistent");
    }
    // 多个图片候选属于合法事实图；显示选择及冲突由共同生效角色求值持有。
    const allAssociations = transaction
      .select()
      .from(artifactAssociations)
      .where(eq(artifactAssociations.subjectId, preview.assetId))
      .orderBy(asc(sql<number>`${artifactAssociations}.rowid`))
      .all();
    const superseded = new Set(
      transaction
        .select({
          predecessorId:
            artifactAssociationSupersessions.predecessorAssociationId,
        })
        .from(artifactAssociationSupersessions)
        .all()
        .map((row) => row.predecessorId),
    );
    const retracted = new Set(
      transaction
        .select({ associationId: artifactAssociationRetractions.associationId })
        .from(artifactAssociationRetractions)
        .all()
        .map((row) => row.associationId),
    );
    const currentAssociations = allAssociations.filter(
      (association) =>
        !superseded.has(association.id) && !retracted.has(association.id),
    );

    this.insertOrVerifyArtifactFactsWithDrizzle(
      transaction,
      preview.projected,
      preview.assetId,
    );
    const projectedIds = new Set(
      preview.projected.artifactAssociations.map(
        (association) => association.id,
      ),
    );
    for (const projected of preview.projected.artifactAssociations) {
      const currentAssociation = currentAssociations.find(
        (association) => association.id === projected.id,
      );
      const existed = currentAssociation !== undefined;
      const predecessorSupported =
        transaction
          .select({ id: artifactAssociationRecognitionSupports.associationId })
          .from(artifactAssociationRecognitionSupports)
          .where(
            and(
              eq(
                artifactAssociationRecognitionSupports.associationId,
                projected.id,
              ),
              eq(
                artifactAssociationRecognitionSupports.recognitionDecisionId,
                predecessorDecisionId,
              ),
            ),
          )
          .get() !== undefined;
      if (
        preview.proposal.basis.kind !== "source-interpretation" &&
        projected.sourceAssociationId === undefined &&
        (currentAssociation === undefined ||
          currentAssociation.sourceAssociationId === null) &&
        (!existed || predecessorSupported)
      )
        transaction
          .insert(artifactAssociationRecognitionSupports)
          .values({
            associationId: projected.id,
            recognitionDecisionId: successorDecisionId,
          })
          .onConflictDoNothing()
          .run();
    }
    for (const current of currentAssociations) {
      if (projectedIds.has(current.id)) continue;
      const hasRemainingRecognitionSupport = transaction
        .select({
          id: artifactAssociationRecognitionSupports.recognitionDecisionId,
        })
        .from(artifactAssociationRecognitionSupports)
        .where(
          eq(artifactAssociationRecognitionSupports.associationId, current.id),
        )
        .all()
        .some(
          ({ id: supportDecisionId }) =>
            supportDecisionId !== predecessorDecisionId &&
            transaction
              .select({
                id: recognitionDecisionSupersessions.predecessorDecisionId,
              })
              .from(recognitionDecisionSupersessions)
              .where(
                eq(
                  recognitionDecisionSupersessions.predecessorDecisionId,
                  supportDecisionId,
                ),
              )
              .get() === undefined &&
            transaction
              .select({
                id: recognitionDecisionRetractions.predecessorDecisionId,
              })
              .from(recognitionDecisionRetractions)
              .where(
                eq(
                  recognitionDecisionRetractions.predecessorDecisionId,
                  supportDecisionId,
                ),
              )
              .get() === undefined,
        );
      const hasCurrentSourceSupport =
        current.sourceAssociationId !== null &&
        (JSON.parse(current.sourceRecordIdsJson) as readonly string[]).length >
          0 &&
        transaction
          .select({ id: currentSourceAssociations.associationId })
          .from(currentSourceAssociations)
          .where(
            and(
              eq(currentSourceAssociations.subjectId, current.subjectId),
              eq(
                currentSourceAssociations.associationId,
                current.sourceAssociationId,
              ),
            ),
          )
          .get() !== undefined;
      if (hasRemainingRecognitionSupport || hasCurrentSourceSupport) continue;
      const hadAnyRecognitionSupport =
        transaction
          .select({ id: artifactAssociationRecognitionSupports.associationId })
          .from(artifactAssociationRecognitionSupports)
          .where(
            eq(
              artifactAssociationRecognitionSupports.associationId,
              current.id,
            ),
          )
          .get() !== undefined;
      if (!hadAnyRecognitionSupport && current.sourceAssociationId === null)
        throw new Error(
          "Change Impact Preview touches an other-legacy Artifact Association",
        );
      const successor = preview.projected.artifactAssociations.find(
        (association) => association.role === current.role,
      );
      if (successor === undefined) {
        transaction
          .insert(artifactAssociationRetractions)
          .values({
            id: `artifact-association-retraction_${preview.id}_${current.id}`,
            associationId: current.id,
            recognitionDecisionId: null,
            proposalId: preview.proposal.id,
            sourceRecordIdsJson: JSON.stringify(
              recognitionSourceInterpretation(preview.proposal)
                ?.sourceRecordIds ?? [],
            ),
          })
          .run();
      } else {
        transaction
          .insert(artifactAssociationSupersessions)
          .values({
            id: `artifact-association-supersession_${preview.id}_${current.id}`,
            predecessorAssociationId: current.id,
            successorAssociationId: successor.id,
          })
          .run();
      }
    }
    if (predecessorDecisionId.length === 0 || successorDecisionId.length === 0)
      throw new Error("Artifact transition requires recognition decisions");
  }

  /**
   * 通过分阶段集合读取装配一个有界的当前目录页面。后续阶段只以所选页面中发现的标识符
   * 为键，投影仍由内存分组负责。
   */
  private async readCurrentAcceptedPageWithDrizzle(
    query: DrizzleReadQuery,
    assetIds: readonly string[],
    indexMetadataProperties?: readonly string[],
    selection: "filter-current" | "already-effective" = "filter-current",
    namedBasisDecisionId?: string,
    /**
     * 只为身份基线读取开启：强制以点名决定为事实依据，即便主头已前进到 successor、该决定
     * 已被 supersede。用途是把范围修订后的 manual 范围头与建立来源身份的不可变前驱决定分
     * 开读取；不改变任何当前范围/CAS 判定。
     */
    pinNamedBasisDecision = false,
    namedMetadataSubjectIds: readonly string[] = [],
  ): Promise<readonly AcceptedAssetState[]> {
    const effectiveAssetIds =
      selection === "already-effective"
        ? assetIds
        : this.currentEffectiveDigitalAssetIdsWithDrizzle(query, assetIds);
    if (effectiveAssetIds.length === 0) return [];
    const [
      assetEntities,
      heads,
      associations,
      currentAssociationsRows,
      decisions,
      currentLineageHeads,
    ] = await Promise.all([
      query
        .select()
        .from(entities)
        .where(and(inArray(entities.id, sqliteTextSet(effectiveAssetIds)))),
      query
        .select()
        .from(recognitionHeads)
        .where(inArray(recognitionHeads.subjectId, sqliteTextSet(assetIds))),
      query
        .select()
        .from(sourceAssociations)
        .where(inArray(sourceAssociations.subjectId, sqliteTextSet(assetIds)))
        .orderBy(asc(sql<number>`${sourceAssociations}.rowid`)),
      query
        .select()
        .from(currentSourceAssociations)
        .where(
          inArray(currentSourceAssociations.subjectId, sqliteTextSet(assetIds)),
        ),
      query
        .select()
        .from(recognitionDecisions)
        .where(inArray(recognitionDecisions.assetId, sqliteTextSet(assetIds))),
      query
        .select({
          subjectId: sourceLineageHeads.subjectId,
          sourceRecordId: sourceLineageHeads.sourceRecordId,
        })
        .from(sourceLineageHeads)
        .where(inArray(sourceLineageHeads.subjectId, sqliteTextSet(assetIds))),
    ]);
    const proposalIds = uniqueStrings(
      decisions.map((decision) => decision.proposalId),
    );
    const decisionIds = decisions.map((decision) => decision.id);
    const [recognitionSupersessionRows, recognitionRetractionRows] =
      decisionIds.length === 0
        ? [[], []]
        : await Promise.all([
            query
              .select({
                id: recognitionDecisionSupersessions.predecessorDecisionId,
              })
              .from(recognitionDecisionSupersessions)
              .where(
                inArray(
                  recognitionDecisionSupersessions.predecessorDecisionId,
                  sqliteTextSet(decisionIds),
                ),
              ),
            query
              .select({
                id: recognitionDecisionRetractions.predecessorDecisionId,
              })
              .from(recognitionDecisionRetractions)
              .where(
                inArray(
                  recognitionDecisionRetractions.predecessorDecisionId,
                  sqliteTextSet(decisionIds),
                ),
              ),
          ]);
    const endedRecognitionDecisionIds = new Set([
      ...recognitionSupersessionRows.map((row) => row.id),
      ...recognitionRetractionRows.map((row) => row.id),
    ]);
    const proposalRows =
      proposalIds.length === 0
        ? []
        : await query
            .select()
            .from(recognitionProposals)
            .where(
              inArray(recognitionProposals.id, sqliteTextSet(proposalIds)),
            );
    const parsedProposals = proposalRows.map((row) => ({
      row,
      proposal: {
        id: row.id,
        boundaries: JSON.parse(
          row.boundariesJson,
        ) as RecognitionProposal["boundaries"],
        basis: JSON.parse(row.basisJson) as RecognitionProposal["basis"],
        ruleResults: JSON.parse(
          row.ruleResultsJson,
        ) as RecognitionProposal["ruleResults"],
      } satisfies RecognitionProposal,
    }));
    const relationshipSeedSubjectIds = uniqueStrings([
      ...assetIds,
      ...parsedProposals.flatMap(
        ({ proposal }) =>
          recognitionSourceInterpretation(proposal)?.entities?.map(
            (entity) => entity.id,
          ) ?? [],
      ),
    ]);
    const relationshipRowsWithParticipants = await query
      .select({ relationship: entityRelationships })
      .from(entityRelationshipParticipants)
      .innerJoin(
        entityRelationships,
        eq(
          entityRelationships.id,
          entityRelationshipParticipants.relationshipId,
        ),
      )
      .where(
        inArray(
          entityRelationshipParticipants.entityId,
          sqliteTextSet(relationshipSeedSubjectIds),
        ),
      )
      .orderBy(asc(sql<number>`${entityRelationships}.rowid`));
    const relationshipRows = [
      ...new Map(
        relationshipRowsWithParticipants.map(({ relationship }) => [
          relationship.id,
          relationship,
        ]),
      ).values(),
    ];
    const initialRelationshipSupports = this.relationshipSupportsWithDrizzle(
      query,
      relationshipRows.map(({ id }) => id),
    );
    const relationshipDecisionRows =
      this.relationshipHeadDecisionsWithDrizzle(query);
    const artifactRoleDecisionRows =
      this.artifactRoleDecisionsWithDrizzle(query);
    const selectedTargetKeys = new Set(
      [...initialRelationshipSupports.targetsByRelationshipId.values()].map(
        relationshipTargetKey,
      ),
    );
    const additionalManualIds = relationshipDecisionRows.flatMap((decision) =>
      decision.manualRelationshipId !== undefined &&
      selectedTargetKeys.has(relationshipTargetKey(decision.target)) &&
      !relationshipRows.some(({ id }) => id === decision.manualRelationshipId)
        ? [decision.manualRelationshipId]
        : [],
    );
    if (additionalManualIds.length > 0)
      relationshipRows.push(
        ...query
          .select()
          .from(entityRelationships)
          .where(
            inArray(entityRelationships.id, sqliteTextSet(additionalManualIds)),
          )
          .all(),
      );
    const relationshipSupports = this.relationshipSupportsWithDrizzle(
      query,
      relationshipRows.map(({ id }) => id),
    );
    /** 装载前先求每个根的生效关系，资料查询主体只取真实生效端点。 */
    const relationshipMentionIds = uniqueStrings(
      relationshipRows.flatMap((row) =>
        relationshipParticipantsFromJson(row.participantsJson).flatMap(
          (participant) => participant.mentionIds ?? [],
        ),
      ),
    );
    const participantResolutions = this.relationshipMentionEntitiesWithDrizzle(
      query,
      relationshipMentionIds,
    );
    const interpretationRecordIds = uniqueStrings(
      parsedProposals.flatMap(
        ({ proposal }) =>
          recognitionSourceInterpretation(proposal)?.sourceRecordIds ?? [],
      ),
    );
    const interpretationRecords =
      interpretationRecordIds.length === 0
        ? []
        : await query
            .select({
              id: sourceRecords.id,
              sourceIdentity: sourceRecords.sourceIdentity,
              nativeAddress: sourceRecords.nativeAddress,
            })
            .from(sourceRecords)
            .where(
              inArray(sourceRecords.id, sqliteTextSet(interpretationRecordIds)),
            );
    const interpretationRecordById = new Map(
      interpretationRecords.map((record) => [record.id, record]),
    );
    const currentAssociationIdsBySubject = new Map<string, Set<string>>();
    for (const row of currentAssociationsRows) {
      const ids =
        currentAssociationIdsBySubject.get(row.subjectId) ?? new Set<string>();
      ids.add(row.associationId);
      currentAssociationIdsBySubject.set(row.subjectId, ids);
    }
    /**
     * 主头为空时，点名且未结束的决定只提供本次事实读取依据，绝不充当当前身份头。
     */
    const readBasisDecisionId = (headDecisionId?: string | null) =>
      pinNamedBasisDecision && namedBasisDecisionId !== undefined
        ? namedBasisDecisionId
        : (headDecisionId ??
          (namedBasisDecisionId === undefined ||
          endedRecognitionDecisionIds.has(namedBasisDecisionId)
            ? undefined
            : namedBasisDecisionId));
    const selectRootRelationshipSubjects = (
      identityRepresentatives: ReadonlyMap<string, string>,
    ) =>
      effectiveAssetIds.map((assetId) => {
        const head = heads.find((item) => item.subjectId === assetId);
        const decision = decisions.find(
          (item) =>
            item.id === readBasisDecisionId(head?.recognitionDecisionId) &&
            item.assetId === assetId,
        );
        const proposal =
          decision === undefined
            ? undefined
            : parsedProposals.find(({ row }) => row.id === decision.proposalId)
                ?.proposal;
        const interpretation =
          proposal === undefined
            ? undefined
            : recognitionSourceInterpretation(proposal);
        const currentAssociationIds =
          currentAssociationIdsBySubject.get(assetId);
        const currentAssociations = associations.filter(
          (association) =>
            association.subjectId === assetId &&
            currentAssociationIds?.has(association.id) === true,
        );
        const recognitionSourceAssociationCurrent =
          head?.recognitionSourceAssociationId !== undefined &&
          head?.recognitionSourceAssociationId !== null &&
          currentAssociationIds?.has(head.recognitionSourceAssociationId) ===
            true &&
          associations.some(
            (association) =>
              association.id === head?.recognitionSourceAssociationId &&
              association.subjectId === assetId,
          );
        return selectEffectiveRelationshipSubjects({
          assetId,
          seedSubjectIds: new Set([
            assetId,
            ...(interpretation?.entities ?? []).map((entity) => entity.id),
          ]),
          relationships: relationshipRows,
          supports: relationshipSupports,
          decisions: relationshipDecisionRows,
          participantResolutions,
          identityRepresentatives,
          factLineages: selectAssetFactLineageKeys({
            hasRecognitionSourceAssociation:
              recognitionSourceAssociationCurrent,
            interpretationSourceRecordIds:
              interpretation?.sourceRecordIds ?? [],
            sourceRecords: interpretationRecordById,
            currentAssociations,
          }),
        });
      });
    /** 身份代表只沿本批生效端点闭包读取，不遍历全图合并森林。 */
    const provisionalSubjectSets = selectRootRelationshipSubjects(new Map());
    const identityRepresentatives =
      this.identityRepresentativesWithinWithDrizzle(
        query,
        uniqueStrings([
          ...effectiveAssetIds,
          ...provisionalSubjectSets.flatMap((subjects) => [
            ...subjects.endpointIds,
          ]),
        ]),
      );
    const rootSubjectSets = selectRootRelationshipSubjects(
      identityRepresentatives,
    );
    const participantIds = uniqueStrings(
      rootSubjectSets.flatMap((subjects) => [...subjects.endpointIds]),
    );
    const factSubjectIds = uniqueStrings(
      rootSubjectSets.flatMap((subjects) => [...subjects.factSubjectIds]),
    );
    const localNames =
      participantIds.length === 0
        ? []
        : query
            .select()
            .from(localEntityNames)
            .where(
              inArray(localEntityNames.entityId, sqliteTextSet(participantIds)),
            )
            .all();
    const [artifactAssociationRows, metadataRows] = await Promise.all([
      indexMetadataProperties !== undefined
        ? Promise.resolve([])
        : query
            .select()
            .from(artifactAssociations)
            .where(
              inArray(
                artifactAssociations.subjectId,
                sqliteTextSet(factSubjectIds),
              ),
            )
            .orderBy(asc(artifactAssociations.id)),
      query
        .select()
        .from(metadataAssertions)
        .where(
          and(
            inArray(
              metadataAssertions.subjectId,
              sqliteTextSet(
                uniqueStrings([...factSubjectIds, ...namedMetadataSubjectIds]),
              ),
            ),
            indexMetadataProperties === undefined
              ? undefined
              : inArray(
                  metadataAssertions.property,
                  sqliteTextSet(indexMetadataProperties),
                ),
          ),
        ),
    ]);
    const artifactAssociationIds = artifactAssociationRows.map((row) => row.id);
    const metadataIds = metadataRows.map((row) => row.id);
    const sourceRecordIds = uniqueStrings([
      ...currentLineageHeads.map((row) => row.sourceRecordId),
      ...parsedProposals.flatMap(
        ({ proposal }) =>
          recognitionSourceInterpretation(proposal)?.sourceRecordIds ?? [],
      ),
      ...artifactAssociationRows.flatMap((row) =>
        jsonStringArray(
          row.sourceRecordIdsJson,
          "artifact association source records",
        ),
      ),
      ...metadataRows.flatMap((row) =>
        jsonStringArray(
          row.sourceRecordIdsJson,
          "metadata assertion source records",
        ),
      ),
      ...relationshipRows.flatMap((row) =>
        jsonStringArray(row.sourceRecordIdsJson, "relationship source records"),
      ),
    ]);
    const [
      artifactSupersessions,
      artifactRecognitionSupportRows,
      artifactRetractionsRows,
      metadataLifecyclesRows,
      metadataRetractionsRows,
      sourceRecordRows,
    ] = await Promise.all([
      artifactAssociationIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(artifactAssociationSupersessions)
            .where(
              inArray(
                artifactAssociationSupersessions.predecessorAssociationId,
                sqliteTextSet(artifactAssociationIds),
              ),
            ),
      artifactAssociationIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(artifactAssociationRecognitionSupports)
            .where(
              inArray(
                artifactAssociationRecognitionSupports.associationId,
                sqliteTextSet(artifactAssociationIds),
              ),
            ),
      artifactAssociationIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(artifactAssociationRetractions)
            .where(
              inArray(
                artifactAssociationRetractions.associationId,
                sqliteTextSet(artifactAssociationIds),
              ),
            ),
      metadataIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(metadataAssertionLifecycles)
            .where(
              inArray(
                metadataAssertionLifecycles.assertionId,
                sqliteTextSet(metadataIds),
              ),
            ),
      metadataIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(metadataAssertionRetractions)
            .where(
              inArray(
                metadataAssertionRetractions.assertionId,
                sqliteTextSet(metadataIds),
              ),
            ),
      sourceRecordIds.length === 0
        ? Promise.resolve([])
        : query
            .select({
              id: sourceRecords.id,
              executionId: sourceRecords.executionId,
              sourceIdentity: sourceRecords.sourceIdentity,
              nativeAddress: sourceRecords.nativeAddress,
              coverageJson: sourceRecords.coverageJson,
              producerJson: sourceRecords.producerJson,
            })
            .from(sourceRecords)
            .where(inArray(sourceRecords.id, sqliteTextSet(sourceRecordIds)))
            .orderBy(asc(sql<number>`${sourceRecords}.rowid`)),
    ]);
    /**
     * 派生实体封面由身份保持刷新产生时，决定仍指向初始接受的提案，声明新观察事实的是那次刷新
     * 自己的观察执行。当前资格判定必须读到那一行，因此按封面支持的观察执行补装提案；装载放宽
     * 几行不改变判定，「谁声明」仍逐条由所属执行、点名的决定与冻结的观察快照确认。
     */
    const coverAssociationIds = new Set(
      artifactAssociationRows
        .filter((row) => isDerivedEntityCover(row))
        .map((row) => row.id),
    );
    const coverObservationExecutionIds = uniqueStrings(
      artifactRecognitionSupportRows
        .filter((row) => coverAssociationIds.has(row.associationId))
        .map((row) => row.observationExecutionId)
        .filter((id): id is string => id !== null),
    );
    const derivedCoverDeclaringProposalRows =
      coverObservationExecutionIds.length === 0
        ? []
        : await query
            .select()
            .from(recognitionProposals)
            .where(
              inArray(
                recognitionProposals.executionId,
                sqliteTextSet(coverObservationExecutionIds),
              ),
            );
    /**
     * 相关目标的资料只由其 provenance 所属来源 owner 确认资格：owner 必须仍在该精确坐标持有
     * 当前关联，并在该精确覆盖（元数据）或该来源记录（产物）上保留谱系头。owner 的关联被撤回
     * 或替换后，旧谱系头仍在也不能把已撤回的资料重新带回，另一 owner 的同地址当前也不得复活。
     */
    const provenanceRecordById = new Map<
      string,
      Pick<
        typeof sourceRecords.$inferSelect,
        "id" | "executionId" | "sourceIdentity" | "nativeAddress"
      >
    >(sourceRecordRows.map((row) => [row.id, row]));
    const unloadedOriginRecordIds = uniqueStrings(
      metadataLifecyclesRows
        .map((row) => row.sourceRecordId)
        .filter((recordId) => !provenanceRecordById.has(recordId)),
    );
    if (unloadedOriginRecordIds.length > 0)
      for (const row of await query
        .select({
          id: sourceRecords.id,
          executionId: sourceRecords.executionId,
          sourceIdentity: sourceRecords.sourceIdentity,
          nativeAddress: sourceRecords.nativeAddress,
        })
        .from(sourceRecords)
        .where(
          inArray(sourceRecords.id, sqliteTextSet(unloadedOriginRecordIds)),
        ))
        provenanceRecordById.set(row.id, row);
    const originExecutionIds = uniqueStrings(
      [...provenanceRecordById.values()].map((record) => record.executionId),
    );
    const acceptedOwnerByExecutionId = new Map(
      originExecutionIds.length === 0
        ? []
        : query
            .select({
              id: workflowExecutions.id,
              acceptedAssetId: workflowExecutions.acceptedAssetId,
            })
            .from(workflowExecutions)
            .where(
              inArray(workflowExecutions.id, sqliteTextSet(originExecutionIds)),
            )
            .all()
            .flatMap((row) =>
              row.acceptedAssetId === null
                ? []
                : ([[row.id, row.acceptedAssetId]] as const),
            ),
    );
    const sourceOwnerByRecordId = new Map<string, Set<string>>();
    const retainSourceOwner = (recordId: string, owner: string) => {
      const owners = sourceOwnerByRecordId.get(recordId) ?? new Set<string>();
      owners.add(owner);
      sourceOwnerByRecordId.set(recordId, owners);
    };
    for (const [recordId, record] of provenanceRecordById) {
      const owner = acceptedOwnerByExecutionId.get(record.executionId);
      if (owner !== undefined) retainSourceOwner(recordId, owner);
    }
    // 工作项接受不会写顶层 acceptedAssetId；归属必须来自接受项自己保留的精确记录集合。
    if (originExecutionIds.length > 0)
      for (const row of query
        .select({ workItemsJson: workflowExecutions.workItemsJson })
        .from(workflowExecutions)
        .where(
          inArray(workflowExecutions.id, sqliteTextSet(originExecutionIds)),
        )
        .all())
        for (const item of JSON.parse(
          row.workItemsJson,
        ) as readonly AssetRefreshWorkItem[]) {
          if (item.outcome !== "accepted" || item.acceptedAssetId === undefined)
            continue;
          for (const recordId of item.sourceRecordIds)
            if (provenanceRecordById.has(recordId))
              retainSourceOwner(recordId, item.acceptedAssetId);
        }
    /** 刷新执行不重新接受资产，其记录 owner 由该执行写入的来源刷新变化确定。 */
    const ownerlessExecutionIds = uniqueStrings(
      [...provenanceRecordById.values()]
        .map((record) => record.executionId)
        .filter((executionId) => !acceptedOwnerByExecutionId.has(executionId)),
    );
    if (ownerlessExecutionIds.length > 0)
      for (const row of query
        .select({
          subjectId: sourceRefreshChanges.subjectId,
          sourceRecordId: sourceRefreshChanges.sourceRecordId,
        })
        .from(sourceRefreshChanges)
        .where(
          and(
            inArray(
              sourceRefreshChanges.executionId,
              sqliteTextSet(ownerlessExecutionIds),
            ),
            inArray(
              sourceRefreshChanges.sourceRecordId,
              sqliteTextSet([...provenanceRecordById.keys()]),
            ),
          ),
        )
        .all())
        retainSourceOwner(row.sourceRecordId, row.subjectId);
    const artifactSourceAssociationIds = uniqueStrings(
      artifactAssociationRows.flatMap((row) =>
        row.sourceAssociationId === null ? [] : [row.sourceAssociationId],
      ),
    );
    const sourceAssociationOwnerById = new Map(
      artifactSourceAssociationIds.length === 0
        ? []
        : query
            .select({
              id: sourceAssociations.id,
              subjectId: sourceAssociations.subjectId,
              sourceIdentity: sourceAssociations.sourceIdentity,
              nativeAddress: sourceAssociations.nativeAddress,
            })
            .from(sourceAssociations)
            .where(
              inArray(
                sourceAssociations.id,
                sqliteTextSet(artifactSourceAssociationIds),
              ),
            )
            .all()
            .map((row) => [
              row.id,
              {
                subjectId: row.subjectId,
                sourceIdentity: row.sourceIdentity,
                nativeAddress: row.nativeAddress,
              },
            ]),
    );
    const sourceOwnerIds = uniqueStrings([
      ...[...sourceOwnerByRecordId.values()].flatMap((owners) => [...owners]),
      ...Array.from(sourceAssociationOwnerById.values()).map(
        (owner) => owner.subjectId,
      ),
    ]);
    const ownerSourceAssociationRows =
      sourceOwnerIds.length === 0
        ? []
        : query
            .select({
              id: sourceAssociations.id,
              subjectId: sourceAssociations.subjectId,
              sourceIdentity: sourceAssociations.sourceIdentity,
              nativeAddress: sourceAssociations.nativeAddress,
            })
            .from(sourceAssociations)
            .where(
              inArray(
                sourceAssociations.subjectId,
                sqliteTextSet(sourceOwnerIds),
              ),
            )
            .all();
    const ownerCurrentAssociationIds = new Map<string, Set<string>>();
    for (const row of sourceOwnerIds.length === 0
      ? []
      : query
          .select()
          .from(currentSourceAssociations)
          .where(
            inArray(
              currentSourceAssociations.subjectId,
              sqliteTextSet(sourceOwnerIds),
            ),
          )
          .all()) {
      const ids =
        ownerCurrentAssociationIds.get(row.subjectId) ?? new Set<string>();
      ids.add(row.associationId);
      ownerCurrentAssociationIds.set(row.subjectId, ids);
    }
    const ownerLineageHeadRows =
      sourceOwnerIds.length === 0
        ? []
        : query
            .select({
              subjectId: sourceLineageHeads.subjectId,
              sourceIdentity: sourceLineageHeads.sourceIdentity,
              nativeAddress: sourceLineageHeads.nativeAddress,
              coverageId: sourceLineageHeads.coverageId,
              sourceRecordId: sourceLineageHeads.sourceRecordId,
            })
            .from(sourceLineageHeads)
            .where(
              inArray(
                sourceLineageHeads.subjectId,
                sqliteTextSet(sourceOwnerIds),
              ),
            )
            .all();
    const currentSourceOwnerCoordinates = new Set(
      ownerSourceAssociationRows
        .filter(
          (row) =>
            ownerCurrentAssociationIds.get(row.subjectId)?.has(row.id) === true,
        )
        .map((row) =>
          sourceOwnerCoordinateKey(
            row.subjectId,
            row.sourceIdentity,
            row.nativeAddress,
          ),
        ),
    );
    const currentSourceOwnerCoverageHeads = new Set(
      ownerLineageHeadRows.map((row) =>
        sourceOwnerLineageKey(
          row.subjectId,
          row.sourceIdentity,
          row.nativeAddress,
          row.coverageId,
        ),
      ),
    );
    const currentSourceOwnerRecordHeads = new Set(
      ownerLineageHeadRows.map((row) =>
        sourceOwnerLineageKey(
          row.subjectId,
          row.sourceIdentity,
          row.nativeAddress,
          row.sourceRecordId,
        ),
      ),
    );
    const observedArtifactIds = uniqueStrings([
      ...artifactAssociationRows.flatMap((row) =>
        row.observedArtifactPartJson === null
          ? []
          : [
              (
                JSON.parse(row.observedArtifactPartJson) as {
                  readonly artifactId: string;
                }
              ).artifactId,
            ],
      ),
      ...metadataRows.flatMap((row) =>
        row.observedArtifactPartJson === null
          ? []
          : [
              (
                JSON.parse(row.observedArtifactPartJson) as {
                  readonly artifactId: string;
                }
              ).artifactId,
            ],
      ),
    ]);
    const artifactIds = uniqueStrings([
      ...artifactAssociationRows.map((row) => row.artifactId),
      ...observedArtifactIds,
    ]);
    const [artifactRows, locationRows, revisionRows] =
      artifactIds.length === 0 || indexMetadataProperties !== undefined
        ? [[], [], []]
        : await Promise.all([
            query
              .select()
              .from(artifacts)
              .where(inArray(artifacts.id, sqliteTextSet(artifactIds)))
              .orderBy(asc(artifacts.id)),
            query
              .select()
              .from(locations)
              .where(inArray(locations.artifactId, sqliteTextSet(artifactIds)))
              .orderBy(asc(locations.id)),
            query
              .select()
              .from(artifactRevisions)
              .where(
                inArray(
                  artifactRevisions.artifactId,
                  sqliteTextSet(artifactIds),
                ),
              )
              .orderBy(asc(artifactRevisions.id)),
          ]);
    const observedLocationIds = locationRows
      .filter(({ kind }) => kind === "observed")
      .map(({ id }) => id);
    const currentObservedLocationIds = new Set(
      observedLocationIds.length === 0
        ? []
        : (
            await query
              .select({ id: currentFileObservationSupports.locationId })
              .from(currentFileObservationSupports)
              .innerJoin(
                observedRootRegistrations,
                and(
                  eq(
                    observedRootRegistrations.id,
                    currentFileObservationSupports.observedRootId,
                  ),
                  eq(
                    observedRootRegistrations.configVersion,
                    currentFileObservationSupports.observedRootVersion,
                  ),
                  eq(observedRootRegistrations.status, "active"),
                ),
              )
              .where(
                inArray(
                  currentFileObservationSupports.locationId,
                  sqliteTextSet(observedLocationIds),
                ),
              )
          ).map(({ id }) => id),
    );
    const currentLocationRows = locationRows.filter(
      ({ id, kind }) =>
        kind !== "observed" || currentObservedLocationIds.has(id),
    );
    const currentLocationRevisions = currentConfirmedLocationRevisions(
      query,
      currentLocationRows,
    );
    // 证据的当前资格判定要看到支持自己记录的那些位置，包括已经退出当前成员的，
    // 因此单独按证据列预载，不能复用只保留当前成员的 `locations`。
    const evidenceLocationIds = uniqueStrings(
      artifactRecognitionSupportRows.flatMap((support) =>
        support.observationLocationId === null
          ? []
          : [support.observationLocationId],
      ),
    );
    const evidenceLocationRows = locationRows.filter((row) =>
      evidenceLocationIds.includes(row.id),
    );
    const evidenceCurrentLocationRevisionKeys =
      currentConfirmedLocationRevisions(query, evidenceLocationRows).map(
        ({ locationId, revisionId }) => `${locationId}\u0000${revisionId}`,
      );
    const positiveMaterialSupportLocationIds =
      evidenceLocationRows.length === 0
        ? []
        : (
            await query
              .select({
                locationId: currentObservedMaterialSupports.locationId,
              })
              .from(currentObservedMaterialSupports)
              .where(
                inArray(
                  currentObservedMaterialSupports.locationId,
                  sqliteTextSet(evidenceLocationRows.map((row) => row.id)),
                ),
              )
          ).map((row) => row.locationId);
    const digests = uniqueStrings(revisionRows.map((row) => row.blobDigest));
    const blobRows =
      digests.length === 0
        ? []
        : await query
            .select()
            .from(blobs)
            .where(inArray(blobs.digest, sqliteTextSet(digests)))
            .orderBy(asc(blobs.digest));
    const lifecycleSourcedEntityRows =
      sourceRecordIds.length === 0
        ? []
        : await query
            .select()
            .from(sourcedEntities)
            .where(
              sql`EXISTS (
                SELECT 1 FROM json_each(${sourcedEntities.sourceRecordIdsJson}) AS source_id
                WHERE source_id.value IN (${sql.join(
                  sourceRecordIds.map(
                    (sourceRecordId) => sql`${sourceRecordId}`,
                  ),
                  sql`, `,
                )})
              )`,
            );
    const entityIds = uniqueStrings([
      ...participantIds,
      ...lifecycleSourcedEntityRows.map((row) => row.id),
    ]);
    const [participantEntities, sourcedEntityRows, resolutionRows] =
      entityIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            query
              .select()
              .from(entities)
              .where(inArray(entities.id, sqliteTextSet(entityIds)))
              .orderBy(asc(entities.id)),
            query
              .select()
              .from(sourcedEntities)
              .where(inArray(sourcedEntities.id, sqliteTextSet(entityIds)))
              .orderBy(asc(sourcedEntities.id)),
            participantIds.length === 0
              ? Promise.resolve([])
              : query
                  .select()
                  .from(entityResolutionDecisions)
                  .where(
                    inArray(
                      entityResolutionDecisions.entityId,
                      sqliteTextSet(participantIds),
                    ),
                  )
                  .orderBy(
                    asc(sql<number>`${entityResolutionDecisions}.rowid`),
                  ),
          ]);
    const entityKinds = this.entityKindStatesWithDrizzle(query, entityIds);
    const mentionIds = uniqueStrings(
      resolutionRows.map((resolution) => resolution.mentionId),
    );
    const mentionRows =
      mentionIds.length === 0
        ? []
        : await query
            .select()
            .from(entityMentions)
            .where(inArray(entityMentions.id, sqliteTextSet(mentionIds)))
            .orderBy(asc(sql<number>`${entityMentions}.rowid`));
    const observedEntityRows = await query
      .select()
      .from(observedEntities)
      .where(
        inArray(observedEntities.assetId, sqliteTextSet(effectiveAssetIds)),
      );
    const observedEntityIds = observedEntityRows.map((row) => row.id);
    const observedMentionRows =
      observedEntityIds.length === 0
        ? []
        : await query
            .select()
            .from(observedEntityMentions)
            .where(
              inArray(
                observedEntityMentions.entityId,
                sqliteTextSet(observedEntityIds),
              ),
            );
    const observedMentionIds = observedMentionRows.map((row) => row.id);
    const observedResolutionRows =
      observedMentionIds.length === 0
        ? []
        : await query
            .select()
            .from(observedEntityResolutions)
            .where(
              inArray(
                observedEntityResolutions.mentionId,
                sqliteTextSet(observedMentionIds),
              ),
            );
    const observedEntityGraphSupportRows = await query
      .select()
      .from(observedEntityGraphSupports)
      .where(
        inArray(
          observedEntityGraphSupports.assetId,
          sqliteTextSet(effectiveAssetIds),
        ),
      );
    const observedGraphIds = observedEntityGraphSupportRows.map(
      (row) => row.id,
    );
    const observedEntityGraphEntityRows =
      observedGraphIds.length === 0
        ? []
        : await query
            .select()
            .from(observedEntityGraphEntities)
            .where(
              inArray(
                observedEntityGraphEntities.graphId,
                sqliteTextSet(observedGraphIds),
              ),
            );
    const observedEntityGraphRelationshipRows =
      observedGraphIds.length === 0
        ? []
        : await query
            .select()
            .from(observedEntityGraphRelationships)
            .where(
              inArray(
                observedEntityGraphRelationships.graphId,
                sqliteTextSet(observedGraphIds),
              ),
            );
    return effectiveAssetIds.flatMap((assetId) => {
      const accepted = this.projectCurrentAcceptedFromRows(assetId, {
        namedBasisDecisionId,
        pinNamedBasisDecision,
        namedMetadataSubjectIds,
        relationshipSupports,
        relationshipDecisions: relationshipDecisionRows,
        artifactRoleDecisions: artifactRoleDecisionRows,
        participantResolutions,
        identityRepresentatives,
        localNames,
        entities: [...assetEntities, ...participantEntities],
        heads,
        associations,
        currentAssociations: currentAssociationsRows,
        sourceOwnerByRecordId,
        sourceAssociationOwnerById,
        currentSourceOwnerCoordinates,
        currentSourceOwnerAssociationIds: ownerCurrentAssociationIds,
        currentSourceOwnerCoverageHeads,
        currentSourceOwnerRecordHeads,
        decisions,
        proposals: proposalRows,
        derivedCoverDeclaringProposals: derivedCoverDeclaringProposalRows,
        // 载体失去全部当前观察位置后退出当前材料图，耐久事实仍完整保留。
        artifactAssociations: artifactAssociationRows.filter(
          (association) =>
            association.role !== "asset.material-delivered" ||
            !locationRows.some(
              (location) =>
                location.kind === "observed" &&
                location.artifactId === association.artifactId,
            ) ||
            currentLocationRows.some(
              (location) =>
                location.kind === "observed" &&
                location.artifactId === association.artifactId,
            ),
        ),
        artifactSupersessions,
        artifactRetractions: artifactRetractionsRows,
        artifactRecognitionSupports: artifactRecognitionSupportRows,
        endedRecognitionDecisionIds,
        metadata: metadataRows,
        metadataLifecycles: metadataLifecyclesRows,
        metadataRetractions: metadataRetractionsRows,
        relationships: relationshipRows,
        sourceRecords: sourceRecordRows,
        artifacts: artifactRows,
        locations: currentLocationRows,
        currentLocationRevisions,
        evidenceLocations: evidenceLocationRows,
        evidenceCurrentLocationRevisionKeys,
        positiveMaterialSupportLocationIds,
        revisions: revisionRows,
        blobs: blobRows,
        sourcedEntities: sourcedEntityRows,
        entityKinds: new Map(
          [...entityKinds].map(([entityId, state]) => [
            entityId,
            state.effective,
          ]),
        ),
        resolutions: resolutionRows,
        mentions: mentionRows,
        observedEntities: observedEntityRows,
        observedMentions: observedMentionRows,
        observedResolutions: observedResolutionRows,
        observedEntityGraphSupports: observedEntityGraphSupportRows,
        observedEntityGraphEntities: observedEntityGraphEntityRows,
        observedEntityGraphRelationships: observedEntityGraphRelationshipRows,
      });
      return accepted === undefined ? [] : [accepted];
    });
  }

  private projectCurrentAcceptedFromRows(
    assetId: string,
    rows: CurrentCatalogueHydrationRows,
  ): AcceptedAssetState | undefined {
    const entity = rows.entities.find((item) => item.id === assetId);
    const head = rows.heads.find((item) => item.subjectId === assetId);
    if (entity === undefined || head === undefined) return undefined;
    const basisDecisionId = rows.pinNamedBasisDecision
      ? rows.namedBasisDecisionId
      : (head.recognitionDecisionId ??
        (rows.namedBasisDecisionId === undefined ||
        rows.endedRecognitionDecisionIds.has(rows.namedBasisDecisionId)
          ? undefined
          : rows.namedBasisDecisionId));
    const recognitionSourceAssociationRow = rows.associations.find(
      (association) =>
        association.id === head.recognitionSourceAssociationId &&
        association.subjectId === assetId,
    );
    const decision = rows.decisions.find(
      (item) => item.id === basisDecisionId && item.assetId === assetId,
    );
    if (decision === undefined) return undefined;
    const proposalRow = rows.proposals.find(
      (item) => item.id === decision.proposalId,
    );
    if (proposalRow === undefined) return undefined;
    const proposal: RecognitionProposal = {
      id: proposalRow.id,
      boundaries: JSON.parse(
        proposalRow.boundariesJson,
      ) as RecognitionProposal["boundaries"],
      basis: JSON.parse(proposalRow.basisJson) as RecognitionProposal["basis"],
      ruleResults: JSON.parse(
        proposalRow.ruleResultsJson,
      ) as RecognitionProposal["ruleResults"],
      ...(proposalRow.observedMaterialInterpretationJson === null
        ? {}
        : (JSON.parse(proposalRow.observedMaterialInterpretationJson) as Pick<
            RecognitionProposal,
            | "observedArtifactAssociations"
            | "observedArtifactRevisions"
            | "observedMetadata"
            | "observedArtifactParts"
            | "observedEntityGraphs"
          >)),
    };
    const currentAssociationIds = new Set(
      rows.currentAssociations.flatMap((item) =>
        item.subjectId === assetId ? [item.associationId] : [],
      ),
    );
    const projectSourceAssociation = (
      association: typeof sourceAssociations.$inferSelect,
    ) => ({
      id: association.id,
      subjectId: association.subjectId,
      sourceIdentity: association.sourceIdentity,
      nativeAddress: association.nativeAddress,
    });
    const recognitionSourceAssociation =
      recognitionSourceAssociationRow === undefined ||
      !currentAssociationIds.has(recognitionSourceAssociationRow.id)
        ? undefined
        : projectSourceAssociation(recognitionSourceAssociationRow);
    const currentAssociations = [
      ...new Map(
        rows.associations.flatMap((association) =>
          association.subjectId === assetId &&
          currentAssociationIds.has(association.id)
            ? [[association.id, projectSourceAssociation(association)] as const]
            : [],
        ),
      ).values(),
    ];
    const interpretation = recognitionSourceInterpretation(proposal);
    const relatedEntities = interpretation?.entities ?? [];
    const sourceRecordsById = new Map(
      rows.sourceRecords.map((record) => [record.id, record]),
    );
    const factLineages = selectAssetFactLineageKeys({
      hasRecognitionSourceAssociation:
        recognitionSourceAssociation !== undefined,
      interpretationSourceRecordIds: interpretation?.sourceRecordIds ?? [],
      sourceRecords: sourceRecordsById,
      currentAssociations,
    });
    /** 单主体裁剪与批量装载共用同一生效关系求值，被排除或替换的目标不会残留资料。 */
    const effectiveSubjects = selectEffectiveRelationshipSubjects({
      assetId,
      seedSubjectIds: new Set([
        assetId,
        ...relatedEntities.map((item) => item.id),
      ]),
      relationships: rows.relationships,
      supports: rows.relationshipSupports,
      decisions: rows.relationshipDecisions,
      participantResolutions: rows.participantResolutions,
      identityRepresentatives: rows.identityRepresentatives,
      factLineages,
    });
    const relationshipRows = effectiveSubjects.relationships;
    const factSubjectIds = effectiveSubjects.factSubjectIds;
    const artifactAssociationRows = rows.artifactAssociations.filter((row) =>
      factSubjectIds.has(row.subjectId),
    );
    const metadataRows = rows.metadata.filter(
      (row) =>
        factSubjectIds.has(row.subjectId) ||
        rows.namedMetadataSubjectIds?.includes(row.subjectId) === true,
    );
    const supersededArtifactAssociationIds = new Set(
      rows.artifactSupersessions.map((item) => item.predecessorAssociationId),
    );
    const retractedArtifactAssociationIds = new Set(
      rows.artifactRetractions.map((item) => item.associationId),
    );
    // 带精确观察证据的支持按运行时同一份当前资格判定；只由未结束决定的存在来承认
    // 当前性会把已经过期的旧观察当成当前。
    const decisionAssetIdById = new Map(
      rows.decisions.map((row) => [row.id, row.assetId]),
    );
    const evidenceLocationById = new Map(
      rows.evidenceLocations.map((row) => [row.id, row]),
    );
    const currentEvidenceRevisionKeys = new Set(
      rows.evidenceCurrentLocationRevisionKeys,
    );
    const positiveSupportLocationIds = new Set(
      rows.positiveMaterialSupportLocationIds,
    );
    /**
     * 派生实体封面在任何返回路径之前先过修正代表规则：观察证据、未结束决定存在、甚至主体
     * 即资产都不授予它当前角色。旧自然错误图因此仍可整体还原并重开，但不会重新成为当前封面。
     */
    const derivedCoverRows: DerivedCoverCurrentRows = {
      associations: rows.artifactAssociations,
      supports: rows.artifactRecognitionSupports,
      decisions: rows.decisions,
      proposals: [
        ...rows.proposals,
        ...(rows.derivedCoverDeclaringProposals ?? []).filter(
          (row) => !rows.proposals.some((item) => item.id === row.id),
        ),
      ],
      revisions: rows.revisions,
    };
    // 捆绑来源的相关主体没有独立来源关联；本当前提案和当前主来源头共同证明资格。
    const isCurrentBundledRelatedArtifact = (
      row: typeof artifactAssociations.$inferSelect,
    ): boolean => {
      if (
        row.subjectId === assetId ||
        row.sourceAssociationId !== null ||
        interpretation === undefined ||
        recognitionSourceAssociation === undefined ||
        row.producerJson === null
      )
        return false;
      const recordIds = jsonStringArray(
        row.sourceRecordIdsJson,
        "artifact association source records",
      );
      return recordIds.some((recordId) => {
        const record = sourceRecordsById.get(recordId);
        if (
          record === undefined ||
          rows.sourceOwnerByRecordId.get(recordId)?.has(assetId) !== true ||
          !factLineages.has(
            sourceLineageKey(record.sourceIdentity, record.nativeAddress),
          )
        )
          return false;
        const coverage = JSON.parse(
          record.coverageJson,
        ) as SourceRecord["coverage"];
        if (
          coverage.authority !== "official" ||
          coverage.completeness !== "complete"
        )
          return false;
        const declared = interpretation.sourceArtifacts.some(
          (candidate) =>
            candidate.subjectId === row.subjectId &&
            candidate.role === row.role &&
            candidate.sourceRecordId === recordId &&
            producerJson(candidate.producer ?? interpretation.producer) ===
              row.producerJson,
        );
        const described = (interpretation.entities ?? []).some(
          (entity) =>
            entity.id === row.subjectId &&
            entity.sourceRecordIds.includes(recordId) &&
            producerJson(entity.producer ?? interpretation.producer) ===
              row.producerJson,
        );
        if (!declared || !described) return false;
        return interpretation.sourceRecordIds.some((anchorId) => {
          const anchor = sourceRecordsById.get(anchorId);
          if (
            anchor === undefined ||
            anchor.executionId !== record.executionId ||
            anchor.sourceIdentity !==
              recognitionSourceAssociation.sourceIdentity ||
            anchor.nativeAddress !==
              recognitionSourceAssociation.nativeAddress ||
            anchor.producerJson !== record.producerJson
          )
            return false;
          const anchorCoverage = JSON.parse(
            anchor.coverageJson,
          ) as SourceRecord["coverage"];
          return (
            anchorCoverage.authority === "official" &&
            anchorCoverage.completeness === "complete" &&
            rows.currentSourceOwnerRecordHeads.has(
              sourceOwnerLineageKey(
                assetId,
                anchor.sourceIdentity,
                anchor.nativeAddress,
                anchor.id,
              ),
            )
          );
        });
      });
    };
    const currentArtifactAssociationRows = artifactAssociationRows.filter(
      (row) => {
        if (
          supersededArtifactAssociationIds.has(row.id) ||
          retractedArtifactAssociationIds.has(row.id)
        )
          return false;
        if (
          derivedCoverCurrentlyRepresentative(
            derivedCoverRows,
            row.id,
            (decisionId) => rows.endedRecognitionDecisionIds.has(decisionId),
          ) === false
        )
          return false;
        const part =
          row.observedArtifactPartJson === null
            ? undefined
            : (JSON.parse(row.observedArtifactPartJson) as NonNullable<
                ArtifactAssociation["observedArtifactPart"]
              >);
        const evidence: LocalObservationEvidenceCandidate[] =
          row.subjectId === assetId
            ? rows.artifactRecognitionSupports.flatMap((support) => {
                if (
                  support.associationId !== row.id ||
                  support.observationLocationId === null ||
                  support.observationMaterialKind === null ||
                  rows.endedRecognitionDecisionIds.has(
                    support.recognitionDecisionId,
                  )
                )
                  return [];
                const decisionAssetId = decisionAssetIdById.get(
                  support.recognitionDecisionId,
                );
                return decisionAssetId === undefined
                  ? []
                  : [
                      {
                        locationId: support.observationLocationId,
                        materialKind: support.observationMaterialKind,
                        revisionId: support.observationRevisionId,
                        decisionAssetId,
                        subjectId: row.subjectId,
                      },
                    ];
              })
            : [];
        if (evidence.length > 0)
          return isCurrentLocalObservationEvidence({
            materialArtifactId: part?.artifactId ?? row.artifactId,
            ...(part === undefined ? {} : { partRevisionId: part.revisionId }),
            evidence,
            locationOf: (locationId) => evidenceLocationById.get(locationId),
            positiveSupportLocationIds,
            currentLocationRevisionKeys: currentEvidenceRevisionKeys,
          });
        if (isCurrentBundledRelatedArtifact(row)) return true;
        const recordIds = jsonStringArray(
          row.sourceRecordIdsJson,
          "artifact association source records",
        );
        const association =
          row.sourceAssociationId === null
            ? undefined
            : rows.sourceAssociationOwnerById.get(row.sourceAssociationId);
        if (
          row.subjectId !== assetId &&
          recordIds.length > 0 &&
          (association === undefined ||
            !factLineages.has(
              sourceLineageKey(
                association.sourceIdentity,
                association.nativeAddress,
              ),
            ))
        )
          return false;
        const hasActiveRecognitionSupport =
          rows.artifactRecognitionSupports.some(
            (support) =>
              support.associationId === row.id &&
              !rows.endedRecognitionDecisionIds.has(
                support.recognitionDecisionId,
              ),
          );
        if (
          hasActiveRecognitionSupport &&
          (row.subjectId === assetId || recordIds.length === 0)
        )
          return true;
        if (recordIds.length === 0) return row.subjectId === assetId;
        /**
         * 产物只按其直接引用的来源关联判定：该关联必须仍是所属 owner 的当前关联，
         * 且 owner 在同一坐标仍占据这些来源记录头。同坐标被新关联取代后，引用旧关联
         * 的产物不会因为坐标仍被同一 owner 持有而复活。
         */
        if (row.sourceAssociationId === null) return false;
        if (association === undefined) return false;
        const currentForOwner = rows.currentSourceOwnerAssociationIds.get(
          association.subjectId,
        );
        if (currentForOwner?.has(row.sourceAssociationId) !== true)
          return false;
        return recordIds.some((id) =>
          rows.currentSourceOwnerRecordHeads.has(
            sourceOwnerLineageKey(
              association.subjectId,
              association.sourceIdentity,
              association.nativeAddress,
              id,
            ),
          ),
        );
      },
    );
    const metadataLifecycleById = new Map(
      rows.metadataLifecycles.map((item) => [item.assertionId, item]),
    );
    // 代表正文的实体标题也是本地观察事实，其当前资格必须沿授权决定与该修订的精确观察
    // 支持判定：只凭“无来源记录且带观察部件”放行，被替换、不可用或决定已结束后的旧正文
    // 标题会永久留在共同读取里。授权决定只认主头自身的决定：主头为空时点名的决定只提供
    // 那一次读取的事实依据，绝不充当当前身份头，因此也不能把实体标题带进共同读取。
    const supportedObservedRevisionIds = new Set(
      rows.artifactAssociations
        .filter((association) => association.subjectId === assetId)
        .flatMap((association) =>
          rows.locations
            .filter(
              (location) =>
                location.kind === "observed" &&
                location.artifactId === association.artifactId,
            )
            .flatMap((location) =>
              rows.currentLocationRevisions
                .filter((selection) => selection.locationId === location.id)
                .map((selection) => selection.revisionId),
            ),
        ),
    );
    const supersededMetadataIds = new Set(
      rows.metadataLifecycles.flatMap((item) =>
        item.predecessorAssertionId === null
          ? []
          : [item.predecessorAssertionId],
      ),
    );
    const retractedMetadataIds = new Set(
      rows.metadataRetractions.map((item) => item.assertionId),
    );
    const metadata = metadataRows.flatMap((row): MetadataAssertion[] => {
      if (supersededMetadataIds.has(row.id) || retractedMetadataIds.has(row.id))
        return [];
      const lifecycle = metadataLifecycleById.get(row.id);
      const recordIds = jsonStringArray(
        row.sourceRecordIdsJson,
        "metadata assertion source records",
      );
      /**
       * 描述主体与来源 owner 可以不同：相关目标的资料由 provenance 记录所属 owner 是否仍
       * 在当前关联与精确覆盖上决定，未撤回的断言不因后继记录推进谱系头而失效。
       */
      const livesOnCurrentLineage =
        lifecycle !== undefined &&
        (row.subjectId === assetId
          ? factLineages.has(
              sourceLineageKey(
                lifecycle.sourceIdentity,
                lifecycle.nativeAddress,
              ),
            )
          : (() => {
              const owners = rows.sourceOwnerByRecordId.get(
                lifecycle.sourceRecordId,
              );
              return [...(owners ?? [])].some(
                (owner) =>
                  (rows.namedMetadataSubjectIds?.includes(row.subjectId) ===
                  true
                    ? owner === assetId
                    : factLineages.has(
                        sourceLineageKey(
                          lifecycle.sourceIdentity,
                          lifecycle.nativeAddress,
                        ),
                      )) &&
                  rows.currentSourceOwnerCoordinates.has(
                    sourceOwnerCoordinateKey(
                      owner,
                      lifecycle.sourceIdentity,
                      lifecycle.nativeAddress,
                    ),
                  ) &&
                  rows.currentSourceOwnerCoverageHeads.has(
                    sourceOwnerLineageKey(
                      owner,
                      lifecycle.sourceIdentity,
                      lifecycle.nativeAddress,
                      lifecycle.coverageId,
                    ),
                  ),
              );
            })());
      const observedPart =
        row.observedArtifactPartJson === null
          ? undefined
          : (JSON.parse(row.observedArtifactPartJson) as NonNullable<
              MetadataAssertion["observedArtifactPart"]
            >);
      const isLocalObservedFact =
        recordIds.length === 0 &&
        observedPart !== undefined &&
        (row.targetKind !== "entity" ||
          (row.subjectId === assetId &&
            row.recognitionDecisionId !== null &&
            row.recognitionDecisionId === head.recognitionDecisionId &&
            !rows.endedRecognitionDecisionIds.has(row.recognitionDecisionId) &&
            supportedObservedRevisionIds.has(observedPart.revisionId)));
      const isUserFact = recordIds.length === 0 && row.authoredByJson !== null;
      if (!livesOnCurrentLineage && !isLocalObservedFact && !isUserFact)
        return [];
      return [
        {
          target: descriptionTargetFromColumns(row),
          property: row.property,
          sourceSlot: lifecycle?.sourceSlot ?? row.sourceSlot ?? "",
          value: row.value,
          sourceRecordIds: recordIds,
          ...(row.authoredByJson === null
            ? {}
            : {
                authoredBy: JSON.parse(row.authoredByJson) as NonNullable<
                  MetadataAssertion["authoredBy"]
                >,
              }),
          ...(row.qualifiersJson === "[]"
            ? {}
            : {
                qualifiers: JSON.parse(row.qualifiersJson) as NonNullable<
                  MetadataAssertion["qualifiers"]
                >,
              }),
          ...(observedPart === undefined
            ? {}
            : { observedArtifactPart: observedPart }),
          ...(row.producerJson === null
            ? {}
            : { producer: producerFromJson(row.producerJson) }),
          ...(row.recognitionDecisionId === null
            ? {}
            : { recognitionDecisionId: row.recognitionDecisionId }),
        },
      ];
    });
    const metadataRecordIds = new Set(
      metadata.flatMap((assertion) => assertion.sourceRecordIds),
    );
    const metadataSourceRecords = rows.sourceRecords.flatMap((record) =>
      metadataRecordIds.has(record.id)
        ? [
            {
              id: record.id,
              sourceIdentity: record.sourceIdentity,
              nativeAddress: record.nativeAddress,
            },
          ]
        : [],
    );
    const observedArtifactIds = uniqueStrings([
      ...currentArtifactAssociationRows.flatMap((association) =>
        association.observedArtifactPartJson === null
          ? []
          : [
              (
                JSON.parse(association.observedArtifactPartJson) as {
                  readonly artifactId: string;
                }
              ).artifactId,
            ],
      ),
      ...metadata.flatMap((assertion) =>
        assertion.observedArtifactPart === undefined
          ? []
          : [assertion.observedArtifactPart.artifactId],
      ),
    ]);
    const artifactIds = new Set([
      ...currentArtifactAssociationRows.map((item) => item.artifactId),
      ...observedArtifactIds,
    ]);
    const artifactRows = rows.artifacts.filter((item) =>
      artifactIds.has(item.id),
    );
    const locationRows = rows.locations.filter((item) =>
      artifactIds.has(item.artifactId),
    );
    const revisionRows = rows.revisions.filter((item) =>
      artifactIds.has(item.artifactId),
    );
    const digests = new Set(revisionRows.map((item) => item.blobDigest));
    const blobRows = rows.blobs.filter((item) => digests.has(item.digest));
    const observedRevisionByReference = new Map(
      (proposal.observedArtifactRevisions ?? []).map((candidate) => [
        candidate.observedArtifactReference,
        candidate,
      ]),
    );
    const candidateObservedEntityGraphs = (
      proposal.observedEntityGraphs ?? []
    ).flatMap((candidate) => {
      const revisionCandidate = observedRevisionByReference.get(
        candidate.observedArtifactReference,
      );
      const revision =
        revisionCandidate === undefined
          ? undefined
          : revisionRows.find(
              (row) => row.blobDigest === revisionCandidate.blob.digest,
            );
      if (revision === undefined) return [];
      const artifact = artifactRows.find(
        (row) => row.id === revision.artifactId,
      );
      if (artifact === undefined) return [];
      const entityIdByKey = new Map(
        candidate.entities.map((item) => [
          item.key,
          `observed-entity_${sha256Text(JSON.stringify([assetId, artifact.id, candidate.producer, candidate.coverage.id, item.occurrenceSlot, item.preservedValue]))}`,
        ]),
      );
      const mentionIdByKey = new Map(
        candidate.mentions.map((item) => [
          item.key,
          `observed-mention_${sha256Text(JSON.stringify([entityIdByKey.get(item.entityKey), revision.id, item.sourceSlot, item.label]))}`,
        ]),
      );
      return [
        {
          assetId,
          artifactId: artifact.id,
          revisionId: revision.id,
          producer: candidate.producer,
          coverageId: candidate.coverage.id,
          complete: true as const,
          entities: candidate.entities.map((item) => ({
            id: entityIdByKey.get(item.key)!,
            occurrenceSlot: item.occurrenceSlot,
            label: item.label,
            preservedValue: item.preservedValue,
            locator: item.locator,
          })),
          mentions: candidate.mentions.map((item) => ({
            id: mentionIdByKey.get(item.key)!,
            entityId: entityIdByKey.get(item.entityKey)!,
            sourceSlot: item.sourceSlot,
            field: item.field,
            role: item.role,
            label: item.label,
            locator: item.locator,
          })),
          resolutions: candidate.resolutions.map((item) => ({
            mentionId: mentionIdByKey.get(item.mentionKey)!,
            entityId: entityIdByKey.get(item.entityKey)!,
          })),
          relationships: candidate.relationships.map((item) => ({
            id: `observed-relationship_${sha256Text(JSON.stringify([assetId, artifact.id, candidate.producer, candidate.coverage.id, item.sourceSlot, revision.id, item.type, item.subjectRole, item.participants, item.qualifiers]))}`,
            participants: [
              { entityId: assetId, role: item.subjectRole },
              ...item.participants.map((participant) => ({
                entityId: entityIdByKey.get(participant.entityKey)!,
                role: participant.role,
                mentionIds: participant.mentionKeys.map(
                  (key) => mentionIdByKey.get(key)!,
                ),
              })),
            ],
            type: item.type,
            sourceSlot: item.sourceSlot,
            sourceRecordIds: [],
            producer: candidate.producer,
            qualifiers: item.qualifiers,
          })),
        },
      ];
    });
    const currentObservedGraphSupports =
      rows.observedEntityGraphSupports.filter(
        (support) =>
          support.assetId === assetId &&
          support.recognitionDecisionId === basisDecisionId,
      );
    const observedEntityGraphs = currentObservedGraphSupports.map((support) => {
      const graphEntityIds = new Set(
        rows.observedEntityGraphEntities
          .filter((item) => item.graphId === support.id)
          .map((item) => item.entityId),
      );
      const relationshipIds = new Set(
        rows.observedEntityGraphRelationships
          .filter((item) => item.graphId === support.id)
          .map((item) => item.relationshipId),
      );
      const graphEntities = rows.observedEntities.filter((entity) =>
        graphEntityIds.has(entity.id),
      );
      const entityIds = new Set(graphEntities.map((entity) => entity.id));
      const graphMentions = rows.observedMentions.filter(
        (mention) =>
          entityIds.has(mention.entityId) &&
          mention.revisionId === support.revisionId,
      );
      const mentionIds = new Set(graphMentions.map((mention) => mention.id));
      return {
        assetId: support.assetId,
        artifactId: support.artifactId,
        revisionId: support.revisionId,
        producer: producerFromJson(support.producerJson),
        coverageId: support.coverageId,
        complete: true as const,
        entities: graphEntities.map((entity) => ({
          id: entity.id,
          occurrenceSlot: entity.occurrenceSlot,
          label: entity.label,
          preservedValue: entity.preservedValue,
          locator: entity.locator,
        })),
        mentions: graphMentions.map((mention) => ({
          id: mention.id,
          entityId: mention.entityId,
          sourceSlot: mention.sourceSlot,
          field: mention.field,
          role: mention.role,
          label: mention.label,
          locator: mention.locator,
        })),
        resolutions: rows.observedResolutions
          .filter((resolution) => mentionIds.has(resolution.mentionId))
          .map((resolution) => ({
            mentionId: resolution.mentionId,
            entityId: resolution.entityId,
          })),
        relationships: rows.relationships
          .filter((relationship) => relationshipIds.has(relationship.id))
          .map((relationship) => ({
            id: relationship.id,
            participants: relationshipParticipantsFromJson(
              relationship.participantsJson,
            ),
            type: relationship.type,
            sourceSlot: rows.observedEntityGraphRelationships.find(
              (item) =>
                item.graphId === support.id &&
                item.relationshipId === relationship.id,
            )!.sourceSlot,
            sourceRecordIds: [],
            qualifiers: JSON.parse(relationship.qualifiersJson) as NonNullable<
              EntityRelationship["qualifiers"]
            >,
            ...(relationship.producerJson === null
              ? {}
              : { producer: producerFromJson(relationship.producerJson) }),
          })),
      };
    });
    const hydratedObservedEntityGraphs =
      observedEntityGraphs.length === 0
        ? candidateObservedEntityGraphs
        : observedEntityGraphs;
    /** 生效关系与端点已在资料装载前求值，此处不再重复生命周期筛选。 */
    const currentRelationshipRows = relationshipRows;
    const participantIds = effectiveSubjects.endpointIds;
    const entityById = new Map(rows.entities.map((item) => [item.id, item]));
    const sourcedEntityById = new Map(
      rows.sourcedEntities.map((item) => [item.id, item]),
    );
    const sourcedEntityKind = (entityId: string): EffectiveEntityKind =>
      rows.entityKinds.get(entityId) ?? { status: "ordinary" };
    const relationshipEntities = [...participantIds].flatMap(
      (participantId): import("@digital/domain").CurrentRelatedEntity[] => {
        const relatedEntity = entityById.get(participantId);
        const sourcedEntity = sourcedEntityById.get(participantId);
        if (relatedEntity === undefined) return [];
        if (sourcedEntity === undefined) {
          const label =
            rows.localNames.find((row) => row.entityId === participantId)
              ?.label ??
            rows.observedEntities.find((row) => row.id === participantId)
              ?.label;
          return label === undefined
            ? []
            : [
                {
                  id: participantId,
                  kind: sourcedEntityKind(participantId),
                  label,
                } as import("@digital/domain").CurrentRelatedEntity,
              ];
        }
        return [
          {
            id: relatedEntity.id,
            kind: sourcedEntityKind(relatedEntity.id),
            sourceIdentity: sourcedEntity.sourceIdentity,
            sourceKey: sourcedEntity.sourceKey,
            identityNamespace: sourcedEntity.identityNamespace,
            label: sourcedEntity.label,
            sourceRecordIds: jsonStringArray(
              sourcedEntity.sourceRecordIdsJson,
              "sourced entity source records",
            ),
            ...(sourcedEntity.producerJson === null
              ? {}
              : { producer: producerFromJson(sourcedEntity.producerJson) }),
          },
        ];
      },
    );
    const lineageEntities = rows.sourcedEntities.flatMap(
      (sourcedEntity): import("@digital/domain").CurrentRelatedEntity[] => {
        const relatedEntity = entityById.get(sourcedEntity.id);
        if (relatedEntity === undefined) return [];
        const recordIds = jsonStringArray(
          sourcedEntity.sourceRecordIdsJson,
          "sourced entity source records",
        );
        if (
          !recordIds.some((id) => {
            const record = sourceRecordsById.get(id);
            return (
              record !== undefined &&
              factLineages.has(
                sourceLineageKey(record.sourceIdentity, record.nativeAddress),
              )
            );
          })
        )
          return [];
        return [
          {
            id: relatedEntity.id,
            kind: sourcedEntityKind(relatedEntity.id),
            sourceIdentity: sourcedEntity.sourceIdentity,
            sourceKey: sourcedEntity.sourceKey,
            identityNamespace: sourcedEntity.identityNamespace,
            label: sourcedEntity.label,
            sourceRecordIds: recordIds,
            ...(sourcedEntity.producerJson === null
              ? {}
              : { producer: producerFromJson(sourcedEntity.producerJson) }),
          },
        ];
      },
    );
    const currentEntities = [
      ...new Map(
        [
          ...relationshipEntities,
          ...lineageEntities,
          ...rows.observedEntities
            .filter(
              (entity) =>
                entity.assetId === assetId &&
                currentObservedGraphSupports.some(
                  (support) =>
                    support.artifactId === entity.artifactId &&
                    support.producerJson === entity.producerJson &&
                    support.coverageId === entity.coverageId,
                ),
            )
            .map(
              (entity) =>
                ({
                  id: entity.id,
                  kind: sourcedEntityKind(entity.id),
                  label: entity.label,
                }) as import("@digital/domain").CurrentRelatedEntity,
            ),
        ].map((item) => [item.id, item]),
      ).values(),
    ];
    const relationships = currentRelationshipRows.map(
      (row): EntityRelationship => {
        const lifecycle =
          rows.relationshipSupports.lifecyclesByRelationshipId.get(row.id);
        return {
          id: row.id,
          participants: relationshipParticipantsFromJson(row.participantsJson),
          type: row.type,
          sourceSlot:
            lifecycle?.sourceSlot ??
            rows.relationshipSupports.observedSourceSlotsByRelationshipId.get(
              row.id,
            ) ??
            "manual",
          sourceRecordIds: jsonStringArray(
            row.sourceRecordIdsJson,
            "relationship source records",
          ),
          qualifiers: JSON.parse(row.qualifiersJson) as NonNullable<
            EntityRelationship["qualifiers"]
          >,
          ...(row.producerJson === null
            ? {}
            : { producer: producerFromJson(row.producerJson) }),
        };
      },
    );
    const activeAssetRelationshipRows = currentRelationshipRows.filter((row) =>
      relationshipParticipantsFromJson(row.participantsJson).some(
        (participant) => participant.entityId === assetId,
      ),
    );
    const eligibleResolutionRows = rows.resolutions.filter((resolution) => {
      const resolutionRecordIds = jsonStringArray(
        resolution.sourceRecordIdsJson,
        "entity resolution source records",
      );
      return activeAssetRelationshipRows.some(
        (relationship) =>
          relationshipParticipantsFromJson(relationship.participantsJson).some(
            (participant) => participant.entityId === resolution.entityId,
          ) &&
          jsonStringArray(
            relationship.sourceRecordIdsJson,
            "relationship source records",
          ).some((id) => resolutionRecordIds.includes(id)),
      );
    });
    const eligibleMentionIds = new Set(
      eligibleResolutionRows.map((item) => item.mentionId),
    );
    const mentionRows = rows.mentions.filter((item) =>
      eligibleMentionIds.has(item.id),
    );

    return {
      proposal,
      entity: { id: entity.id, kind: "digital-asset" },
      // 主头为空时读到的只是点名决定的事实依据，公开状态必须明确身份未解决。
      ...(head.recognitionDecisionId === null
        ? { recognitionHeadDecisionId: null }
        : {}),
      sourceAssociations: currentAssociations,
      ...(recognitionSourceAssociation === undefined
        ? {}
        : { recognitionSourceAssociation }),
      metadataSourceRecords,
      recognitionDecision: {
        id: decision.id,
        proposalId: decision.proposalId,
        assetId: decision.assetId,
        boundaries: JSON.parse(
          decision.boundariesJson,
        ) as RecognitionDecision["boundaries"],
        acceptedRuleResults: JSON.parse(
          decision.acceptedRuleResultsJson,
        ) as RecognitionDecision["acceptedRuleResults"],
      },
      artifacts: artifactRows.map((row): Artifact => ({ id: row.id })),
      locations: locationRows.map(
        (row): Location => ({
          id: row.id,
          artifactId: row.artifactId,
          address: row.address,
          kind: row.kind as Location["kind"],
        }),
      ),
      blobs: blobRows.map(
        (row): Blob => ({
          digest: row.digest,
          mediaType: row.mediaType,
          byteLength: row.byteLength,
        }),
      ),
      artifactRevisions: revisionRows.map(
        (row): ArtifactRevision => ({
          id: row.id,
          artifactId: row.artifactId,
          blobDigest: row.blobDigest,
          ...(row.producerJson === null
            ? {}
            : { producer: producerFromJson(row.producerJson) }),
        }),
      ),
      ...(rows.currentLocationRevisions.length === 0
        ? {}
        : {
            currentLocationRevisions: rows.currentLocationRevisions.filter(
              ({ locationId }) =>
                locationRows.some(({ id }) => id === locationId),
            ),
          }),
      artifactAssociations: currentArtifactAssociationRows.map(
        (row): ArtifactAssociation => {
          const recordIds = jsonStringArray(
            row.sourceRecordIdsJson,
            "artifact association source records",
          );
          return {
            id: row.id,
            target: descriptionTargetFromColumns(row),
            artifactId: row.artifactId,
            role: row.role,
            ...(row.sourceAssociationId === null
              ? {}
              : { sourceAssociationId: row.sourceAssociationId }),
            ...(recordIds.length === 0 ? {} : { sourceRecordIds: recordIds }),
            ...(row.observedArtifactPartJson === null
              ? {}
              : {
                  observedArtifactPart: JSON.parse(
                    row.observedArtifactPartJson,
                  ) as NonNullable<ArtifactAssociation["observedArtifactPart"]>,
                }),
            ...(row.producerJson === null
              ? {}
              : { producer: producerFromJson(row.producerJson) }),
          };
        },
      ),
      artifactAssociationRecognitionSupports:
        rows.artifactRecognitionSupports.flatMap((support) =>
          rows.endedRecognitionDecisionIds.has(support.recognitionDecisionId)
            ? []
            : [
                {
                  associationId: support.associationId,
                  recognitionDecisionId: support.recognitionDecisionId,
                },
              ],
        ),
      artifactRoleDecisions: rows.artifactRoleDecisions,
      metadata,
      entities: currentEntities.map(({ kind: _kind, ...entity }) => entity),
      currentRelatedEntities: currentEntities,
      entityMentions: mentionRows.map(
        (row): EntityMention => ({
          id: row.id,
          sourceIdentity: row.sourceIdentity,
          field: row.field,
          role: row.role,
          label: row.label,
          identityNamespace: row.identityNamespace,
          sourceKey: row.sourceKey,
          sourceRecordIds: jsonStringArray(
            row.sourceRecordIdsJson,
            "entity mention source records",
          ),
          ...(row.producerJson === null
            ? {}
            : { producer: producerFromJson(row.producerJson) }),
        }),
      ),
      entityResolutionDecisions: eligibleResolutionRows.map(
        (row): EntityResolutionDecision => ({
          id: row.id,
          mentionId: row.mentionId,
          entityId: row.entityId,
          rule: row.rule as EntityResolutionDecision["rule"],
          sourceRecordIds: jsonStringArray(
            row.sourceRecordIdsJson,
            "entity resolution source records",
          ),
          ...(row.producerJson === null
            ? {}
            : { producer: producerFromJson(row.producerJson) }),
        }),
      ),
      relationships,
      relationshipReadBasis: {
        participantResolutions: [...rows.participantResolutions].map(
          ([mentionId, entityId]) => ({ mentionId, entityId }),
        ),
        identityRepresentatives: [...rows.identityRepresentatives].map(
          ([entityId, representativeId]) => ({ entityId, representativeId }),
        ),
        targets: currentRelationshipRows.flatMap(({ id: relationshipId }) => {
          const target =
            rows.relationshipSupports.targetsByRelationshipId.get(
              relationshipId,
            );
          if (target === undefined)
            throw new Error("当前关系缺少稳定的决定目标");
          return [{ relationshipId, target }];
        }),
        decisions: rows.relationshipDecisions,
        manualRelationshipIds: [
          ...rows.relationshipSupports.manualRelationshipIds,
        ],
      } satisfies RelationshipReadBasis,
      ...(hydratedObservedEntityGraphs.length === 0
        ? {}
        : { observedEntityGraphs: hydratedObservedEntityGraphs }),
    };
  }

  /**
   * 仅使用 Drizzle 的公开当前目录投影装配器。
   *
   * 它接收调用方的查询所有者，使检查和履约绝不会逸出到第二条原生驱动查询路径。
   */
  private async readCurrentAcceptedWithDrizzle(
    query: DrizzleReadQuery,
    assetId: string,
    namedBasisDecisionId?: string,
    pinNamedBasisDecision = false,
    namedMetadataSubjectIds: readonly string[] = [],
  ): Promise<AcceptedAssetState | undefined> {
    const [accepted] = await this.readCurrentAcceptedPageWithDrizzle(
      query,
      [assetId],
      undefined,
      "filter-current",
      namedBasisDecisionId,
      pinNamedBasisDecision,
      namedMetadataSubjectIds,
    );
    return accepted;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** 参与实体名称查找的正式名称合同；不泛化到任意元数据值。 */
const RELATED_ENTITY_NAME_PROPERTIES = [
  "asset.title",
  "asset.title.original",
  "asset.title.alternative",
  "asset.title.zh-hans",
] as const;

/** 使用一个绑定的 JSON 值，避免展开页面触及 SQLite 变量上限。 */
function sqliteTextSet<T extends string | number>(values: readonly T[]) {
  return sql<T>`(select value from json_each(${JSON.stringify(values)}))`;
}

function hasExactObjectKeys(
  value: unknown,
  expected: readonly string[],
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actual = Object.keys(value).toSorted();
  const allowed = expected.toSorted();
  return (
    actual.length === allowed.length &&
    actual.every((key, index) => key === allowed[index])
  );
}

function sourceRefreshFailureDispositionsAreConsistent(
  run: SourceRefreshRun,
  execution: WorkflowExecution,
): boolean {
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
    const scope = matches[0]!;
    return (
      scope.state === "terminal" &&
      (scope.outcome === "failed" || scope.outcome === "stale") &&
      disposition.status === "failed" &&
      disposition.reason === scope.reason
    );
  });
}

function originalPersistenceError(error: unknown): unknown {
  if (
    error instanceof Error &&
    error.name === "DrizzleQueryError" &&
    error.cause instanceof Error
  )
    return error.cause;
  return error;
}

type StoredDescriptionTarget = {
  readonly targetKind: string;
  readonly targetEntityId: string | null;
  readonly targetArtifactId: string | null;
  readonly targetRevisionId: string | null;
};

function descriptionTargetColumns(target: DescriptionTarget) {
  return target.kind === "entity"
    ? {
        targetKind: target.kind,
        targetEntityId: target.entityId,
        targetArtifactId: null,
        targetRevisionId: null,
      }
    : {
        targetKind: target.kind,
        targetEntityId: null,
        targetArtifactId: target.artifactId,
        targetRevisionId: target.revisionId,
      };
}

function descriptionTargetFromColumns(
  row: StoredDescriptionTarget,
): DescriptionTarget {
  if (
    row.targetKind === "entity" &&
    row.targetEntityId !== null &&
    row.targetArtifactId === null &&
    row.targetRevisionId === null
  )
    return { kind: "entity", entityId: row.targetEntityId };
  if (
    row.targetKind === "artifact-revision" &&
    row.targetEntityId === null &&
    row.targetArtifactId !== null &&
    row.targetRevisionId !== null
  )
    return {
      kind: "artifact-revision",
      artifactId: row.targetArtifactId,
      revisionId: row.targetRevisionId,
    };
  throw new Error("持久化描述目标无效");
}

function entityTargetId(
  value: Pick<ArtifactAssociation | MetadataAssertion, "target">,
): string | undefined {
  return value.target.kind === "entity" ? value.target.entityId : undefined;
}

function sameDescriptionTarget(
  left: DescriptionTarget,
  right: DescriptionTarget,
): boolean {
  return left.kind === "entity" && right.kind === "entity"
    ? left.entityId === right.entityId
    : left.kind === "artifact-revision" && right.kind === "artifact-revision"
      ? left.artifactId === right.artifactId &&
        left.revisionId === right.revisionId
      : false;
}

function jsonStringArray(value: string, coordinate: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  )
    throw new Error(`${coordinate} must be a JSON string array`);
  return parsed;
}

function sourceLineageKey(
  sourceIdentity: string,
  nativeAddress: string,
): string {
  return `${sourceIdentity}\u0000${nativeAddress}`;
}

/** 来源 owner 在其精确坐标上的当前关联资格键。 */
function sourceOwnerCoordinateKey(
  ownerSubjectId: string,
  sourceIdentity: string,
  nativeAddress: string,
): string {
  return `${ownerSubjectId}\u0000${sourceIdentity}\u0000${nativeAddress}`;
}

/** 来源 owner 在某坐标下占据的覆盖或来源记录头键。 */
function sourceOwnerLineageKey(
  ownerSubjectId: string,
  sourceIdentity: string,
  nativeAddress: string,
  occupiedBy: string,
): string {
  return `${sourceOwnerCoordinateKey(
    ownerSubjectId,
    sourceIdentity,
    nativeAddress,
  )}\u0000${occupiedBy}`;
}

function parseSourceRefreshChanges(
  value: string,
): SourceRefreshChangeSet["changes"] {
  try {
    const parsed = JSON.parse(value) as unknown;
    const kinds = new Set([
      "established",
      "superseded",
      "retracted",
      "unchanged",
      "conflicted",
      "skipped",
      "rejected",
    ]);
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (change) =>
          typeof change === "object" &&
          change !== null &&
          kinds.has((change as { readonly kind?: unknown }).kind as string) &&
          typeof (change as { readonly factReference?: unknown })
            .factReference === "string",
      )
    ) {
      throw new Error("invalid");
    }
    return parsed as SourceRefreshChangeSet["changes"];
  } catch {
    throw new Error("Malformed Source Refresh Change Set changes");
  }
}

function deduplicateSourceRefreshChanges(
  changes: readonly SourceRefreshChangeSet["changes"][number][],
): SourceRefreshChangeSet["changes"] {
  return changes.filter(
    (change, index) =>
      changes.findIndex(
        (candidate) =>
          candidate.kind === change.kind &&
          candidate.factReference === change.factReference,
      ) === index,
  );
}

/**
 * 来源槽只在它描述的主体内部稳定。编码后的二元组用于持久化比较和完整覆盖撤回；
 * 它刻意不作为来源定义的槽对外暴露。
 */
function sourceFactCoordinate(subjectId: string, sourceSlot: string): string {
  return JSON.stringify([subjectId, sourceSlot]);
}

/** 来源生命周期范围只能来自来源声明，缺省时才是本次采用的资产上下文。 */
function relationshipSourceSubjectId(
  assetId: string,
  relationship: Pick<EntityRelationship, "participants"> & {
    readonly subjectRole?: string;
    readonly sourceSubjectId?: string;
  },
): string {
  return relationship.sourceSubjectId ?? assetId;
}

function sourceFactSlotReference(
  kind: "metadata" | "relationship",
  assetId: string,
  subjectId: string,
  sourceSlot: string,
): string {
  return `${kind}-slot:${
    subjectId === assetId ? sourceSlot : `${subjectId}:${sourceSlot}`
  }`;
}

type FactQualifier = { readonly key: string; readonly value: string };

/**
 * 限定符顺序只是生产方的偶然细节。以规范形式比较已持久化事实与候选事实，
 * 避免顺序不同但等价的响应凭空生成后继断言或关系。
 */
function normalizedQualifiers(
  qualifiers: readonly FactQualifier[] | undefined,
): string {
  return JSON.stringify(
    [...(qualifiers ?? [])]
      .map((qualifier) => ({ key: qualifier.key, value: qualifier.value }))
      .toSorted((left, right) => {
        if (left.key !== right.key) return left.key < right.key ? -1 : 1;
        if (left.value !== right.value)
          return left.value < right.value ? -1 : 1;
        return 0;
      }),
  );
}

function normalizedStoredQualifiers(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Malformed persisted fact qualifiers");
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (qualifier) =>
        typeof qualifier === "object" &&
        qualifier !== null &&
        typeof (qualifier as { readonly key?: unknown }).key === "string" &&
        typeof (qualifier as { readonly value?: unknown }).value === "string",
    )
  ) {
    throw new Error("Malformed persisted fact qualifiers");
  }
  return normalizedQualifiers(parsed as readonly FactQualifier[]);
}

function relationshipParticipantsFromJson(
  value: string,
): EntityRelationship["participants"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Malformed persisted relationship participants");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 2 ||
    !parsed.every(
      (participant) =>
        typeof participant === "object" &&
        participant !== null &&
        typeof (participant as { readonly entityId?: unknown }).entityId ===
          "string" &&
        typeof (participant as { readonly role?: unknown }).role === "string" &&
        ((participant as { readonly mentionIds?: unknown }).mentionIds ===
          undefined ||
          (Array.isArray(
            (participant as { readonly mentionIds?: unknown }).mentionIds,
          ) &&
            (
              participant as { readonly mentionIds: unknown[] }
            ).mentionIds.every((id) => typeof id === "string"))),
    )
  )
    throw new Error("Malformed persisted relationship participants");
  return parsed as EntityRelationship["participants"];
}

function metadataAssertionMatchesCurrent(
  current: {
    readonly property: string;
    readonly value: string;
    readonly qualifiers_json: string;
  },
  assertion: Pick<MetadataAssertion, "property" | "value" | "qualifiers">,
): boolean {
  return (
    current.property === assertion.property &&
    current.value === assertion.value &&
    normalizedStoredQualifiers(current.qualifiers_json) ===
      normalizedQualifiers(assertion.qualifiers)
  );
}

function relationshipMatchesCurrent(
  current: {
    readonly participants_json: string;
    readonly type: string;
    readonly qualifiers_json: string;
  },
  relationship: Pick<
    EntityRelationship,
    "participants" | "type" | "qualifiers"
  >,
): boolean {
  return (
    normalizedRelationshipParticipants(current.participants_json) ===
      normalizedRelationshipParticipants(
        JSON.stringify(relationship.participants),
      ) &&
    current.type === relationship.type &&
    normalizedStoredQualifiers(current.qualifiers_json) ===
      normalizedQualifiers(relationship.qualifiers)
  );
}

function normalizedRelationshipParticipants(value: string): string {
  return JSON.stringify(
    [...relationshipParticipantsFromJson(value)].toSorted((left, right) => {
      if (left.entityId !== right.entityId)
        return left.entityId < right.entityId ? -1 : 1;
      return left.role < right.role ? -1 : left.role > right.role ? 1 : 0;
    }),
  );
}

function sourceRecordFromDrizzle(
  row: typeof sourceRecords.$inferSelect,
): SourceRecord {
  return {
    id: row.id,
    sourceIdentity: row.sourceIdentity,
    nativeAddress: row.nativeAddress,
    mediaType: row.mediaType,
    acquiredAt: row.acquiredAt,
    acquisition: JSON.parse(row.acquisitionJson) as SourceRecord["acquisition"],
    coverage: JSON.parse(row.coverageJson) as SourceRecord["coverage"],
    digest: row.digest,
    body: row.body,
    ...(row.producerJson == null
      ? {}
      : { producer: producerFromJson(row.producerJson) }),
  };
}

function producerJson(
  producer: CapabilityCoordinate | undefined,
): string | null {
  return producer === undefined ? null : JSON.stringify(producer);
}

/** 决定行的中立还原：目标与冻结选择必须完整，才承认这是一条人工决定。 */
function artifactRoleDecisionFromRow(
  row: typeof artifactRoleDecisions.$inferSelect,
): ArtifactRoleDecision {
  let target: DescriptionTarget | undefined;
  if (row.targetKind === "entity" && row.targetEntityId !== null)
    target = { kind: "entity", entityId: row.targetEntityId };
  else if (
    row.targetKind === "artifact-revision" &&
    row.targetArtifactId !== null &&
    row.targetRevisionId !== null
  )
    target = {
      kind: "artifact-revision",
      artifactId: row.targetArtifactId,
      revisionId: row.targetRevisionId,
    };
  if (target === undefined)
    throw new Error("人工产物角色决定行缺少完整目标坐标");
  return {
    id: row.id,
    target,
    role: row.role,
    kind: row.kind === "clear" ? "clear" : "select",
    ...(row.selectedAssociationId !== null &&
    row.selectedArtifactId !== null &&
    row.selectedRevisionId !== null
      ? {
          selected: {
            associationId: row.selectedAssociationId,
            artifactId: row.selectedArtifactId,
            revisionId: row.selectedRevisionId,
          },
        }
      : {}),
    ...(row.predecessorDecisionId === null
      ? {}
      : { predecessorDecisionId: row.predecessorDecisionId }),
    initiatedBy: row.initiatedBy,
  };
}

function artifactRoleDecisionRow(
  decision: ArtifactRoleDecision,
): typeof artifactRoleDecisions.$inferInsert {
  const target = decision.target;
  return {
    id: decision.id,
    targetKind: target.kind,
    targetEntityId: target.kind === "entity" ? target.entityId : null,
    targetArtifactId:
      target.kind === "artifact-revision" ? target.artifactId : null,
    targetRevisionId:
      target.kind === "artifact-revision" ? target.revisionId : null,
    role: decision.role,
    kind: decision.kind,
    selectedAssociationId: decision.selected?.associationId ?? null,
    selectedArtifactId: decision.selected?.artifactId ?? null,
    selectedRevisionId: decision.selected?.revisionId ?? null,
    predecessorDecisionId: decision.predecessorDecisionId ?? null,
    initiatedBy: decision.initiatedBy,
  };
}

function producerFromJson(value: string): CapabilityCoordinate {
  return JSON.parse(value) as CapabilityCoordinate;
}
/**
 * 持久出处与新候选都为已知且序列化不相等：这是解释契约/实现版本演进后的重新派生，
 * 不是同一既有事实的再次确认，因此不能走要求出处一致的复用分支。
 */
function durableProducerDiverges(
  persisted: string | null,
  candidate: CapabilityCoordinate | undefined,
): boolean {
  const encoded = producerJson(candidate);
  return persisted !== null && encoded !== null && persisted !== encoded;
}
function assertCompatibleProducer(
  persisted: string | null,
  candidate: CapabilityCoordinate | undefined,
  fact: string,
): void {
  if (durableProducerDiverges(persisted, candidate)) {
    throw new Error(`${fact} conflicts with durable producer provenance`);
  }
}

function automationIntentFromDrizzle(row: {
  readonly id: string;
  readonly scopeJson: string;
  readonly enabled: number;
  readonly disabledReason: string | null;
  readonly intervalMilliseconds: number;
  readonly workflowInputVersion: string;
  readonly runInitial: number;
  readonly policyReferencesJson: string;
  readonly acceptTrusted: number;
}): AutomationIntent {
  if (
    (row.enabled !== 0 && row.enabled !== 1) ||
    (row.runInitial !== 0 && row.runInitial !== 1) ||
    (row.acceptTrusted !== 0 && row.acceptTrusted !== 1)
  ) {
    throw new InvalidAutomationIntentConfiguration();
  }
  let scope: unknown;
  let policyReferences: unknown;
  try {
    scope = JSON.parse(row.scopeJson);
    policyReferences = JSON.parse(row.policyReferencesJson);
  } catch {
    throw new InvalidAutomationIntentConfiguration();
  }
  const intent: AutomationIntent = {
    id: row.id,
    scope: scope as AutomationIntent["scope"],
    enabled: row.enabled === 1,
    ...(row.disabledReason === null
      ? {}
      : {
          disabledReason: row.disabledReason as NonNullable<
            AutomationIntent["disabledReason"]
          >,
        }),
    intervalMilliseconds: row.intervalMilliseconds,
    workflowInputVersion:
      row.workflowInputVersion as AutomationIntent["workflowInputVersion"],
    runInitial: row.runInitial === 1,
    policyReferences: policyReferences as string[],
    acceptTrusted: row.acceptTrusted === 1,
  };
  if (!isPersistableAutomationIntent(intent))
    throw new InvalidAutomationIntentConfiguration();
  return intent;
}

class InvalidAutomationIntentConfiguration extends Error {
  constructor() {
    super("自动刷新配置无效");
    this.name = "InvalidAutomationIntentConfiguration";
  }
}

function isPersistableAutomationIntent(
  value: unknown,
): value is AutomationIntent {
  if (value === null || typeof value !== "object") return false;
  const intent = value as Partial<AutomationIntent>;
  return (
    typeof intent.id === "string" &&
    intent.id.trim().length > 0 &&
    isObservedRootAutomationScope(intent.scope) &&
    typeof intent.enabled === "boolean" &&
    (intent.disabledReason === undefined ||
      intent.disabledReason === "observed-root-revoked" ||
      intent.disabledReason === "observed-root-unavailable" ||
      intent.disabledReason === "prerequisite-unavailable" ||
      intent.disabledReason === "invalid-configuration") &&
    typeof intent.intervalMilliseconds === "number" &&
    Number.isSafeInteger(intent.intervalMilliseconds) &&
    intent.intervalMilliseconds > 0 &&
    intent.workflowInputVersion === "asset-refresh-input/1" &&
    typeof intent.runInitial === "boolean" &&
    Array.isArray(intent.policyReferences) &&
    intent.policyReferences.every(
      (reference) => typeof reference === "string" && reference.length > 0,
    ) &&
    typeof intent.acceptTrusted === "boolean"
  );
}

function observedRootIdFromAutomationScope(
  scopeJson: string,
): string | undefined {
  try {
    const scope = JSON.parse(scopeJson);
    return isObservedRootAutomationScope(scope)
      ? scope.observedRootId
      : undefined;
  } catch {
    // 损坏的配置不得意外获得权威。它会为常规审计/修复而保留，但不能成为此次有界撤销操作中
    // 已知的依赖自动化范围。
    return undefined;
  }
}

function observedRootRegistrationToDrizzle(
  registration: ObservedRootRegistration,
): typeof observedRootRegistrations.$inferInsert {
  return {
    id: registration.id,
    displayName: registration.displayName,
    containerPath: registration.containerPath,
    canonicalPath: registration.canonicalPath,
    status: registration.status,
    configVersion: registration.configVersion,
    readOnly: 1,
    symlinkMode: registration.symlinkMode,
    allowedTargetRootIdsJson: JSON.stringify(registration.allowedTargetRootIds),
  };
}

function assetLibraryFromDrizzle(
  row: typeof assetLibraries.$inferSelect,
): AssetLibrary {
  const rootIds: unknown = JSON.parse(row.rootIdsJson);
  const recognitionProfileIds: unknown = JSON.parse(
    row.recognitionProfileIdsJson,
  );
  const sourceIdentities: unknown = JSON.parse(row.sourceIdentitiesJson);
  const lists = [rootIds, recognitionProfileIds, sourceIdentities];
  if (
    (row.status !== "active" && row.status !== "removed") ||
    row.displayName.trim().length === 0 ||
    !Number.isSafeInteger(row.configVersion) ||
    row.configVersion < 1 ||
    lists.some(
      (list) =>
        !Array.isArray(list) ||
        list.some(
          (item: unknown) => typeof item !== "string" || item.length === 0,
        ) ||
        new Set(list).size !== list.length,
    )
  )
    throw new Error("资产库持久配置无效");
  return {
    id: row.id,
    displayName: row.displayName,
    status: row.status,
    configVersion: row.configVersion,
    rootIds: rootIds as string[],
    recognitionProfileIds: recognitionProfileIds as string[],
    sourceIdentities: sourceIdentities as string[],
  };
}

function libraryDirectoryGrantFromDrizzle(
  row: typeof libraryDirectoryGrants.$inferSelect,
): LibraryDirectoryGrant {
  const allowedTargetGrantIds: unknown = JSON.parse(
    row.allowedTargetGrantIdsJson,
  );
  if (
    (row.status !== "active" && row.status !== "removed") ||
    !Number.isSafeInteger(row.authorityVersion) ||
    row.authorityVersion < 1 ||
    (row.symlinkMode !== "do-not-follow" &&
      row.symlinkMode !== "follow-file-links" &&
      row.symlinkMode !== "follow-file-and-directory-links") ||
    !Array.isArray(allowedTargetGrantIds) ||
    allowedTargetGrantIds.some(
      (item: unknown) => typeof item !== "string" || item.length === 0,
    ) ||
    new Set(allowedTargetGrantIds).size !== allowedTargetGrantIds.length
  )
    throw new Error("库目录授权持久配置无效");
  return {
    id: row.id,
    libraryId: row.libraryId,
    observedRootId: row.observedRootId,
    status: row.status,
    authorityVersion: row.authorityVersion,
    symlinkMode: row.symlinkMode as LibraryDirectoryGrant["symlinkMode"],
    allowedTargetGrantIds: allowedTargetGrantIds as string[],
    awaitingObservation: row.awaitingObservation === 1,
  };
}

function observedRootRegistrationFromDrizzle(
  row: typeof observedRootRegistrations.$inferSelect,
): ObservedRootRegistration {
  let allowedTargetRootIds: unknown;
  try {
    allowedTargetRootIds = JSON.parse(row.allowedTargetRootIdsJson);
  } catch {
    throw new Error("文件位置持久配置无效");
  }
  const decoded = decodeObservedRootRegistration({
    id: row.id,
    displayName: row.displayName,
    containerPath: row.containerPath,
    canonicalPath: row.canonicalPath,
    status: row.status,
    configVersion: row.configVersion,
    readOnly: row.readOnly === 1,
    symlinkMode: row.symlinkMode,
    allowedTargetRootIds,
  });
  if (!decoded.valid) throw new Error("文件位置持久配置无效");
  return decoded.value;
}

/** 目录账本行到 Application 投影的可逆映射；坐标与计数都按耐久值原样返回。 */
function libraryScanDirectoryRecordFromRow(
  row: typeof libraryScanDirectories.$inferSelect,
): LibraryScanDirectoryRecord {
  return {
    directoryKey: row.directoryKey,
    scopeReference: row.scopeReference,
    rootVersion: row.rootVersion,
    relativeScope: row.relativeScope,
    mode: row.mode as LibraryScanDirectoryRecord["mode"],
    ...(row.executedByKey === null
      ? {}
      : { executedByDirectoryKey: row.executedByKey }),
    ...(row.coveredPrefix === null ? {} : { coveredPrefix: row.coveredPrefix }),
    ...(row.childExecutionId === null
      ? {}
      : { childExecutionId: row.childExecutionId }),
    stage: row.stage as LibraryScanDirectoryRecord["stage"],
    ...(row.outcome === null
      ? {}
      : { outcome: row.outcome as AssetRefreshOutcome }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    workItemCount: row.workItemCount,
    unresolvedCount: row.unresolvedCount,
    failedCount: row.failedCount,
  };
}

function parseWorkflowInputObject(
  value: string | null,
): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseLibraryScanPlanAssetLibraryId(
  value: string | null,
): string | undefined {
  const plan = parseWorkflowInputObject(value)?.libraryScan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan))
    return undefined;
  const assetLibraryId = (plan as Record<string, unknown>).assetLibraryId;
  return typeof assetLibraryId === "string" ? assetLibraryId : undefined;
}

function parseLibraryScanObservedRootId(
  value: string | null,
): string | undefined {
  const roots = parseWorkflowInputObject(value)?.observedRoots;
  if (!Array.isArray(roots)) return undefined;
  const first = roots[0];
  if (typeof first !== "object" || first === null || Array.isArray(first))
    return undefined;
  const id = (first as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}
