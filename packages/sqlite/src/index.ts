import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AcceptedAssetState,
  AssetRefreshReuseQueries,
  AutomationCommands,
  AutomationIntent,
  AutomationIntentCreationResult,
  AutomationObservedRootAuthorization,
  AutomationQueries,
  AutomationTrigger,
  ChangeImpactCommands,
  ChangeImpactPreview,
  RecognitionSupersessionPlan,
  ChangeImpactQueries,
  CurrentAttentionItem,
  CurrentAttentionPage,
  CurrentAttentionPageRequest,
  CurrentAttentionQueries,
  CurrentCataloguePageRequest,
  CurrentCatalogueIndexFacts,
  CurrentCataloguePersistencePage,
  CurrentCatalogueQueries,
  WorkflowHistoryPageRequest,
  WorkflowHistoryPersistencePage,
  WorkflowHistoryQueries,
  InformationSubjectFactsQueries,
  CurrentSourceArtifactQueries,
  CreateSourceRefreshRunInputForExecution,
  ExecutionStartDisposition,
  ExecutionInspection,
  MetadataRefreshPersistence,
  MetadataRefreshSubmission,
  ManagedSourceArtifactPersistence,
  ArtifactRevisionAccessQueries,
  ArtifactRevisionAccessFacts,
  ArtifactContentProofMetadata,
  ArtifactContentProofCommands,
  ObservedFileConfirmationFacts,
  ObservedFileConfirmationQueries,
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
  WorkflowExecutionCommands,
  WorkflowExecutionQueries,
  WorkflowRecoveryLease,
  WorkflowExecution,
} from "@digital/application";
import {
  createObservedRootAuthorityIndex,
  decodeObservedRootRegistration,
  isAutomationObservedRootAuthorizationCurrent,
  isObservedRootAutomationScope,
  observedRootIdsDependingOn,
  workflowCompatibilityCanReuse,
  artifactProofConditionalBaseline,
} from "@digital/application";
import type {
  AcceptedRecognition,
  Artifact,
  ArtifactAssociation,
  ArtifactAssociationRetraction,
  ArtifactRevision,
  Blob,
  CapabilityCoordinate,
  EntityMention,
  EntityResolutionDecision,
  EntityRelationship,
  Location,
  MetadataAssertion,
  RecognitionDecision,
  RecognitionProposal,
  SourceRecord,
  SourceRefreshChangeSet,
  SourceRefreshRun,
  SourceCoverageScope,
  SourceInterpretationBatch,
  SourcedEntity,
} from "@digital/domain";
import {
  beginSourceRefreshScopeAcquisition as beginDomainSourceRefreshScopeAcquisition,
  cancelSourceRefreshRun as cancelDomainSourceRefreshRun,
  completeSourceRefreshChangeSet as completeDomainSourceRefreshChangeSet,
  createSourceRefreshRun as createDomainSourceRefreshRun,
  deriveSourceSlotLifecycleChanges,
  failSourceRefreshScope as failDomainSourceRefreshScope,
  projectSourceRefreshRun,
  reviewSourceRefreshChangeSet as reviewDomainSourceRefreshChangeSet,
  stageSourceRefreshChangeSet as stageDomainSourceRefreshChangeSet,
  validateAcceptedRecognition,
  validateArtifactAssociationRetraction,
  validateReevaluatedRecognition,
  validateSourceInterpretationBatch,
  recognitionSourceInterpretation,
} from "@digital/domain";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
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
  assertProductionCatalogueReady,
  inspectProductionCatalogueReadiness,
  productionCatalogueMigrationPlan,
} from "./production-readiness.ts";
import { matchesReviewedCatalogueSchema } from "./schema-contract.ts";
import {
  artifactAssociationRetractions,
  artifactAssociationSupersessions,
  artifactAssociations,
  artifactRevisions,
  artifactContentProofs,
  artifacts,
  automationIntents,
  automationRuntime,
  blobs,
  changeImpactPreviews,
  currentFileObservations,
  currentSourceArtifactCandidateLineages,
  currentSourceAssociations,
  entities,
  entityMentions,
  entityRelationships,
  entityResolutionDecisions,
  locations,
  metadataAssertionLifecycles,
  metadataAssertionRetractions,
  metadataAssertionSources,
  metadataAssertions,
  metadataPolicyEnrollments,
  observedRootRegistrations,
  observedRevisionConfirmations,
  recognitionDecisions,
  recognitionDecisionSupersessions,
  recognitionProposals,
  sourceLineageHeads,
  relationshipLifecycles,
  relationshipRetractions,
  relationshipSources,
  recognitionHeads,
  sourceAssociations,
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
  readonly entities: readonly (typeof entities.$inferSelect)[];
  readonly heads: readonly (typeof recognitionHeads.$inferSelect)[];
  readonly associations: readonly (typeof sourceAssociations.$inferSelect)[];
  readonly currentAssociations: readonly (typeof currentSourceAssociations.$inferSelect)[];
  readonly decisions: readonly (typeof recognitionDecisions.$inferSelect)[];
  readonly proposals: readonly (typeof recognitionProposals.$inferSelect)[];
  readonly artifactAssociations: readonly (typeof artifactAssociations.$inferSelect)[];
  readonly artifactSupersessions: readonly (typeof artifactAssociationSupersessions.$inferSelect)[];
  readonly artifactRetractions: readonly (typeof artifactAssociationRetractions.$inferSelect)[];
  readonly metadata: readonly (typeof metadataAssertions.$inferSelect)[];
  readonly metadataLifecycles: readonly (typeof metadataAssertionLifecycles.$inferSelect)[];
  readonly metadataRetractions: readonly (typeof metadataAssertionRetractions.$inferSelect)[];
  readonly relationships: readonly (typeof entityRelationships.$inferSelect)[];
  readonly relationshipLifecycles: readonly (typeof relationshipLifecycles.$inferSelect)[];
  readonly relationshipRetractions: readonly (typeof relationshipRetractions.$inferSelect)[];
  readonly policies: readonly (typeof metadataPolicyEnrollments.$inferSelect)[];
  readonly sourceRecords: readonly Pick<
    typeof sourceRecords.$inferSelect,
    "id" | "sourceIdentity" | "nativeAddress"
  >[];
  readonly artifacts: readonly (typeof artifacts.$inferSelect)[];
  readonly locations: readonly (typeof locations.$inferSelect)[];
  readonly revisions: readonly (typeof artifactRevisions.$inferSelect)[];
  readonly blobs: readonly (typeof blobs.$inferSelect)[];
  readonly sourcedEntities: readonly (typeof sourcedEntities.$inferSelect)[];
  readonly resolutions: readonly (typeof entityResolutionDecisions.$inferSelect)[];
  readonly mentions: readonly (typeof entityMentions.$inferSelect)[];
};

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

/** 由各个窄化资产刷新持久化端口共用的 SQLite 实现。 */
export class SqliteCatalogue
  implements
    WorkflowExecutionCommands,
    WorkflowExecutionQueries,
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
    ObservedRootRegistrationQueries
{
  private database: DatabaseSync | undefined;
  private readonly productDataDirectory: string;
  private readonly clock: SqliteCatalogueClock;
  private readonly workflowExecutionPersistence: WorkflowExecutionPersistence;

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
          locationKind: location.kind as "managed" | "observed",
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
            if (confirmation !== undefined)
              return confirmation.snapshotId ===
                input.expected.observation.snapshotId &&
                confirmation.observedAt ===
                  input.expected.observation.observedAt &&
                confirmation.size === input.expected.observation.size &&
                confirmation.modifiedAt ===
                  input.expected.observation.modifiedAt &&
                confirmation.conditionalBaseline ===
                  input.expected.conditionalBaseline
                ? ("already-committed" as const)
                : ("stale" as const);
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
            persistedBlob.mediaType !== input.blob.mediaType
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
            .select({ proposalId: sourceAssociations.proposalId })
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
                proposalId: association.proposalId,
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
        const trigger = execution.workflowInput?.trigger ?? execution.trigger;
        if (
          trigger !== "initial" &&
          trigger !== "interval" &&
          trigger !== "scan-now"
        ) {
          throw new Error("Automation execution requires its trigger");
        }
        const intent = transaction
          .select()
          .from(automationIntents)
          .where(eq(automationIntents.id, automationIntentId))
          .get();
        if (
          intent === undefined ||
          (trigger !== "scan-now" && intent.enabled === 0)
        ) {
          outcome = "disabled";
          return;
        }
        const runtime = transaction
          .select()
          .from(automationRuntime)
          .where(eq(automationRuntime.intentId, automationIntentId))
          .get();
        if (runtime === undefined) {
          throw new Error("Automation intent lacks runtime state");
        }
        if (runtime.activeExecutionId !== null) {
          const active = transaction
            .select({ status: workflowExecutions.status })
            .from(workflowExecutions)
            .where(eq(workflowExecutions.id, runtime.activeExecutionId))
            .get();
          if (active?.status === "running") {
            outcome = "skipped";
            return;
          }
          transaction
            .update(automationRuntime)
            .set({ activeExecutionId: null })
            .where(
              and(
                eq(automationRuntime.intentId, automationIntentId),
                eq(
                  automationRuntime.activeExecutionId,
                  runtime.activeExecutionId,
                ),
              ),
            )
            .run();
        }
        if (
          trigger === "interval" &&
          runtime.lastAutomaticTriggerAt !== null &&
          Date.parse(requestedAt) - Date.parse(runtime.lastAutomaticTriggerAt) <
            intent.intervalMilliseconds
        ) {
          outcome = "skipped";
          return;
        }
        this.workflowExecutionPersistence.insertExecutionWithDrizzle(
          transaction,
          execution,
        );
        const claimed = transaction
          .update(automationRuntime)
          .set({ activeExecutionId: execution.id })
          .where(
            and(
              eq(automationRuntime.intentId, automationIntentId),
              isNull(automationRuntime.activeExecutionId),
            ),
          )
          .run();
        if (claimed.changes !== 1) {
          throw new Error("Automation execution could not acquire its claim");
        }
      },
      { behavior: "immediate" },
    );
    return outcome;
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
      },
      { behavior: "immediate" },
    );
  }

  async transitionExecution(
    expected: WorkflowExecution,
    next: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ): Promise<void> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    query.transaction(
      (transaction) => {
        const baseline =
          this.workflowExecutionPersistence.runningExecutionBaseline(
            transaction,
            expected,
            next,
          );
        this.assertResumeMutationClaim(transaction, expected.id, resumeClaim);
        this.workflowExecutionPersistence.replaceExecutionWithDrizzle(
          transaction,
          next,
          {
            auditJson: baseline.auditJson,
          },
        );
      },
      { behavior: "immediate" },
    );
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
      input.preview.proposal.id !== input.proposal.id
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
              previewJson: JSON.stringify(input.preview),
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
    readonly metadataPolicyIds?: readonly string[];
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
          this.insertProposalWithDrizzle(
            transaction,
            input.execution.id,
            input.accepted.proposal,
          );
          this.insertAcceptedFactsWithDrizzle(transaction, input.accepted);
          this.projectCurrentFileObservationsWithDrizzle(
            transaction,
            input.execution,
            input.accepted.locations,
          );
          this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
            input.accepted.entity.id,
          ]);
          for (const policyId of new Set(input.metadataPolicyIds ?? [])) {
            if (policyId.length === 0)
              throw new Error("Metadata Policy enrollment identifier is empty");
            transaction
              .insert(metadataPolicyEnrollments)
              .values({
                subjectId: input.accepted.entity.id,
                policyId,
                executionId: input.execution.id,
              })
              .onConflictDoNothing()
              .run();
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
      // 旧版公开适配器会直接暴露 SQLite 约束或触发器消息。保留该契约，
      // 同时仍由 Drizzle 拥有事务和查询构造。
      throw originalPersistenceError(error);
    }
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
              proposalId: sourceAssociations.proposalId,
              subjectId: sourceAssociations.subjectId,
            })
            .from(sourceAssociations)
            .where(inArray(sourceAssociations.proposalId, proposalIds))
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

    const prerequisiteFailure = sql<boolean>`
      exists (
        select 1
        from json_each(${workflowExecutions.dispositionsJson}) as disposition
        where json_extract(disposition.value, '$.failureClassification.kind') = 'prerequisite-unavailable'
      )
      or exists (
        select 1
        from json_each(${workflowExecutions.workItemsJson}) as work_item
        where json_extract(work_item.value, '$.failureClassification.kind') = 'prerequisite-unavailable'
      )
    `;
    // 在应用游标和限制之前，先用 SQL 为每个持久意图选出最新的一条有类型降级记录。
    // 若在限制之后才用 JavaScript 去重，A@5、A@3 可能占满一页并使 B@4 无法返回。
    const prerequisiteIsLatestForIntent = sql<boolean>`
      not exists (
        select 1
        from workflow_executions as newer_execution
        where newer_execution.automation_intent_id = ${workflowExecutions.automationIntentId}
          and newer_execution.rowid > ${workflowExecutions}.rowid
          and (
            exists (
              select 1
              from json_each(newer_execution.dispositions_json) as newer_disposition
              where json_extract(newer_disposition.value, '$.failureClassification.kind') = 'prerequisite-unavailable'
            )
            or exists (
              select 1
              from json_each(newer_execution.work_items_json) as newer_work_item
              where json_extract(newer_work_item.value, '$.failureClassification.kind') = 'prerequisite-unavailable'
            )
          )
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
      .innerJoin(
        entities,
        and(
          eq(entities.id, recognitionHeads.subjectId),
          eq(entities.kind, "digital-asset"),
        ),
      )
      .where(
        and(
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
  ): Promise<readonly CurrentCatalogueIndexFacts[]> {
    const query = drizzle({ client: await this.ensure() });
    const heads = await query
      .select({
        id: recognitionHeads.subjectId,
        additionOrder: sql<number>`${recognitionHeads}.rowid`,
      })
      .from(recognitionHeads)
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
          metadataPolicyIds: item.metadataPolicyIds ?? [],
          metadataSourceRecords: item.metadataSourceRecords ?? [],
          sourceAssociations: item.sourceAssociations,
          ...(item.recognitionSourceAssociation === undefined
            ? {}
            : {
                recognitionSourceAssociation: item.recognitionSourceAssociation,
              }),
          entities: item.entities ?? [],
          relationships: item.relationships ?? [],
        });
    }
    return result;
  }

  /**
   * 仅用于兼容的完整投影。交付路径使用 `listCurrentCataloguePage`，
   * 使常规浏览始终有界。
   */
  async listCurrentCatalogue(): Promise<readonly AcceptedAssetState[]> {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const currentHeads = await query
      .select({ assetId: recognitionHeads.subjectId })
      .from(recognitionHeads)
      .innerJoin(
        entities,
        and(
          eq(entities.id, recognitionHeads.subjectId),
          eq(entities.kind, "digital-asset"),
        ),
      )
      .orderBy(asc(recognitionHeads.subjectId));
    const assetIds = [
      ...new Set(currentHeads.map((current) => current.assetId)),
    ];
    const hydrated = await Promise.all(
      assetIds.map(async (assetId) =>
        this.readCurrentAcceptedWithDrizzle(query, assetId),
      ),
    );
    return hydrated.flatMap((accepted) =>
      accepted === undefined ? [] : [accepted],
    );
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

  async findAcceptedForDirectory(directory: string): Promise<
    | {
        readonly accepted: AcceptedRecognition;
        readonly execution: WorkflowExecution;
      }
    | undefined
  > {
    const database = await this.ensure();
    const rows = drizzle({ client: database })
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
        return {
          execution: inspection.execution,
          accepted: inspection.accepted,
        };
      }
      const itemAccepted = inspection?.workItemInspections?.find(
        (item) => item.accepted !== undefined,
      )?.accepted;
      if (itemAccepted !== undefined) {
        return {
          execution: inspection!.execution,
          accepted: itemAccepted,
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
          association.subjectId === candidate.subjectId &&
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
   * 只投影各个已选当前主体拥有的事实。`readAccepted` 会刻意为目录用途装配一个
   * 有界的相关实体图；该履约端口会在它跨越应用层之前剥离此图。
   */
  async readCurrentInformationSubjectFacts(input: {
    readonly subjectIds: readonly string[];
  }) {
    const database = await this.ensure();
    const query = drizzle({ client: database });
    const facts = [];
    for (const subjectId of input.subjectIds) {
      const accepted = await this.readCurrentAcceptedWithDrizzle(
        query,
        subjectId,
      );
      if (accepted === undefined) continue;
      const sourceAssociations = accepted.sourceAssociations
        .filter((association) => association.subjectId === subjectId)
        .map(({ id, sourceIdentity }) => ({ id, sourceIdentity }));
      facts.push({
        subjectId,
        sourceAssociations,
        metadata: accepted.metadata
          .filter((fact) => fact.subjectId === subjectId)
          .map(({ property }) => ({
            subjectId,
            property,
          })),
        relationships: (accepted.relationships ?? [])
          .filter((fact) => fact.subjectId === subjectId)
          .map(({ subjectId: factSubjectId, type }) => ({
            subjectId: factSubjectId,
            type,
          })),
        artifactAssociations: accepted.artifactAssociations
          .filter((association) => association.subjectId === subjectId)
          .map(
            ({
              id,
              subjectId: associationSubjectId,
              artifactId,
              role,
              sourceAssociationId,
              sourceRecordIds,
            }) => ({
              id,
              subjectId: associationSubjectId,
              artifactId,
              role,
              ...(sourceAssociationId === undefined
                ? {}
                : { sourceAssociationId }),
              ...(sourceAssociationId === undefined
                ? {}
                : {
                    currentSourceArtifact:
                      this.isCurrentSourceArtifactAssociation(query, {
                        subjectId: associationSubjectId,
                        sourceAssociationId,
                        sourceRecordIds,
                      }),
                  }),
              managedLocations: accepted.locations
                .filter(
                  (location) =>
                    location.artifactId === artifactId &&
                    location.kind === "managed",
                )
                .map(({ address }) => ({ address })),
            }),
          ),
      });
    }
    return facts;
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
        proposalId: sourceAssociations.proposalId,
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
        proposalId: identity.proposalId,
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
          const association = this.assertManagedSourceArtifactCommitInputs(
            transaction,
            input,
          );
          this.insertOrVerifyArtifactFactsWithDrizzle(transaction, {
            artifacts: input.managedArtifacts.artifacts,
            locations: input.managedArtifacts.locations,
            blobs: input.managedArtifacts.blobs,
            artifactRevisions: input.managedArtifacts.revisions,
            artifactAssociations: input.managedArtifacts.associations,
          });
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
            proposalId: association.proposalId,
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
    readonly proposalId: string;
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
        proposalId: sourceAssociations.proposalId,
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
          artifactAssociation.subjectId !== input.expectedIdentity.subjectId ||
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
          association.subjectId === sourceAssociation.subjectId &&
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
    const expectedPaths = JSON.stringify(
      [...input.relativePaths].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    );
    const rows = query
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.selectionDirectory, input.directory),
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
          JSON.stringify(
            [...current.relativePaths].toSorted((left, right) =>
              left.localeCompare(right),
            ),
          ) === expectedPaths,
      );
      const legacyMatchesBoundary =
        (execution.workItems === undefined ||
          execution.workItems.length === 0) &&
        execution.snapshot !== undefined &&
        execution.snapshot.complete &&
        JSON.stringify(
          execution.snapshot.files
            .map((file) => file.relativePath)
            .toSorted((left, right) => left.localeCompare(right)),
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

  async refreshAcceptedRecognition(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly current: AcceptedRecognition;
    readonly accepted: AcceptedRecognition;
    readonly sourceRecords: readonly SourceRecord[];
    readonly expectedLineageHeads: MetadataRefreshSubmission["expectedLineageHeads"];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<void> {
    // 刷新会追加来自新提案的事实，但保留建立当前身份的不可变关联和决定。
    // 对直接调用方，在任何事务开始前再次执行领域边界检查。
    validateReevaluatedRecognition({
      current: input.current,
      accepted: input.accepted,
    });
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
          this.projectCurrentFileObservationsWithDrizzle(
            transaction,
            input.execution,
            input.accepted.locations,
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
                proposalId: association.proposalId,
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
                proposalId: association.proposalId,
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
            this.insertOrVerifyArtifactFactsWithDrizzle(transaction, {
              artifacts: input.managedArtifacts.artifacts,
              locations: input.managedArtifacts.locations,
              blobs: input.managedArtifacts.blobs,
              artifactRevisions: input.managedArtifacts.revisions,
              artifactAssociations: input.managedArtifacts.associations,
            });
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
                proposalId: association.proposalId,
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

  /**
   * 在丰富操作能够创建可选来源关联之前拒绝无效请求。应用层已经要求存在已接受的关联解释；
   * 此持久化边界会在第一条 DML 语句之前，重新检查冻结的识别头、保留证据和精确来源坐标。
   */
  private assertSourceEnrichmentApplyInputs(
    query: DrizzleReadQuery,
    input: Parameters<SqliteCatalogue["applySourceEnrichment"]>[0],
  ): {
    readonly id: string;
    readonly proposalId: string;
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
            association.subjectId !== input.assetId ||
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
        proposalId: sourceAssociations.proposalId,
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
        proposalId: sourceAssociations.proposalId,
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
        proposalId: existing.proposalId,
        shouldInsert: false,
        metadataRefreshPreflight,
      };
    }
    return {
      id: input.sourceAssociation.id,
      proposalId: input.sourceAssociation.proposalId,
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
          proposalId: sourceAssociations.proposalId,
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
          input.submission.sourceAssociation.nativeAddress ||
        associationCurrent.proposalId !==
          input.submission.sourceAssociation.proposalId
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
              relationship.subjectId ?? input.submission.assetId,
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

  async saveChangeImpactPreview(preview: ChangeImpactPreview): Promise<void> {
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
      head.recognitionDecisionId !== input.recognitionDecisionId
    ) {
      throw new Error("Change Impact Preview lost its identity baseline");
    }
    return this.currentChangeImpactBaselineWithDrizzle(query, input.assetId);
  }

  async rejectChangeImpactPreview(
    previewId: string,
  ): Promise<"rejected" | "stale"> {
    const database = await this.ensure();
    let result: "rejected" | "stale" = "stale";
    drizzle({ client: database }).transaction(
      (transaction) => {
        const stored = transaction
          .select({ previewJson: changeImpactPreviews.previewJson })
          .from(changeImpactPreviews)
          .where(eq(changeImpactPreviews.id, previewId))
          .get();
        if (stored === undefined) return;
        const preview = JSON.parse(stored.previewJson) as ChangeImpactPreview;
        if (preview.status !== "awaiting-confirmation") return;
        transaction
          .update(changeImpactPreviews)
          .set({
            previewJson: JSON.stringify({ ...preview, status: "rejected" }),
          })
          .where(eq(changeImpactPreviews.id, previewId))
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
          currentHead === undefined
            ? undefined
            : transaction
                .select({
                  proposalId: recognitionDecisions.proposalId,
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
        const projectedInterpretation = recognitionSourceInterpretation(
          currentPreview.proposal,
        );
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
              plan.recognitionSourceAssociation.proposalId ===
                currentPreview.proposal.id &&
              plan.recognitionSourceAssociation.sourceIdentity ===
                projectedInterpretation.sourceIdentity &&
              plan.recognitionSourceAssociation.nativeAddress ===
                projectedInterpretation.sourceAddress &&
              projectedSourceAssociation.sourceIdentity ===
                projectedInterpretation.sourceIdentity &&
              projectedSourceAssociation.nativeAddress ===
                projectedInterpretation.sourceAddress;
        if (
          plan.successorDecision.proposalId !== currentPreview.proposal.id ||
          plan.successorDecision.assetId !== currentPreview.assetId ||
          JSON.stringify(plan.successorDecision.acceptedRuleResults) !==
            JSON.stringify(currentPreview.proposal.ruleResults) ||
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
              isCurrent: 1,
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
          })
          .run();
        transaction
          .insert(recognitionDecisionSupersessions)
          .values({
            ...plan.supersession,
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
        // 识别更正会使所有独立丰富的关联失效，直到常规丰富路径依据新身份重新验证它们。
        // 不可变来源记录和事实仍保留为历史。
        transaction
          .delete(currentSourceAssociations)
          .where(
            eq(currentSourceAssociations.subjectId, currentPreview.assetId),
          )
          .run();
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
            proposal: currentPreview.proposal,
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
          };
          this.insertReevaluatedArtifactFactsWithDrizzle(
            transaction,
            currentAccepted,
            nextAccepted,
          );
          this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
            currentPreview.assetId,
          ]);
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
        if (currentInterpretation !== undefined) {
          if (
            currentHead.sourceIdentity === null ||
            currentHead.nativeAddress === null
          )
            throw new Error(
              "Source recognition predecessor requires exact source coordinates",
            );
          this.retractIdentityFactsWithDrizzle(transaction, {
            assetId: currentPreview.assetId,
            sourceIdentity: currentHead.sourceIdentity,
            nativeAddress: currentHead.nativeAddress,
            sourceRecordId: replacementSourceRecordId,
          });
        }
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
        this.insertProjectedRelationshipsAndMentionsWithDrizzle(
          transaction,
          currentPreview,
        );
        this.applyProjectedArtifactsWithDrizzle(
          transaction,
          currentPreview,
          currentHead.recognitionDecisionId,
          decisionId,
        );
        this.invalidateStaleChangeImpactPreviewsWithDrizzle(transaction, [
          currentPreview.assetId,
        ]);
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
    let revoked = false;
    drizzle({ client: database }).transaction(
      (transaction) => {
        const replaced = transaction
          .update(observedRootRegistrations)
          .set(observedRootRegistrationToDrizzle(input.registration))
          .where(
            and(
              eq(observedRootRegistrations.id, input.registration.id),
              eq(
                observedRootRegistrations.configVersion,
                input.expectedVersion,
              ),
            ),
          )
          .run();
        if (replaced.changes !== 1) return;

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
        revoked = true;
      },
      { behavior: "immediate" },
    );
    return revoked;
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
          relationship.subjectId ?? input.assetId,
          relationship.sourceSlot,
        ),
      );
      if (
        current !== undefined &&
        relationshipMatchesCurrent(current, relationship)
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
            relationship.subjectId ?? input.assetId,
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
          subjectId: entityRelationships.subjectId,
        })
        .from(entityRelationships)
        .where(inArray(entityRelationships.subjectId, sqliteTextSet(assetIds)))
        .orderBy(asc(entityRelationships.id))
        .all(),
      query
        .select({
          id: artifactAssociations.id,
          subjectId: artifactAssociations.subjectId,
        })
        .from(artifactAssociations)
        .where(inArray(artifactAssociations.subjectId, sqliteTextSet(assetIds)))
        .orderBy(asc(artifactAssociations.id))
        .all(),
    ];
    const decisionIds = uniqueStrings(
      heads.map((head) => head.recognitionDecisionId),
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
              ? [{ id: row.id }]
              : [],
          ),
        }),
      ]),
    );
    const valid = new Set<string>();
    for (const { previewId, preview } of previews) {
      const head = headByAsset.get(preview.assetId);
      const decision =
        head === undefined
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

  private currentChangeImpactBaselineWithDrizzle(
    query: DrizzleReadQuery,
    assetId: string,
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
      .from(entityRelationships)
      .where(eq(entityRelationships.subjectId, assetId))
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
      .select({ id: artifactAssociations.id })
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
    const artifacts = artifactRows.filter(
      (row) =>
        !supersededArtifacts.has(row.id) && !retractedArtifacts.has(row.id),
    );
    return JSON.stringify({ lineage, metadata, relationships, artifacts });
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
    const ruleResults = JSON.stringify(proposal.ruleResults);
    const existing = transaction
      .select({
        executionId: recognitionProposals.executionId,
        basisJson: recognitionProposals.basisJson,
        ruleResultsJson: recognitionProposals.ruleResultsJson,
      })
      .from(recognitionProposals)
      .where(eq(recognitionProposals.id, proposal.id))
      .get();
    if (existing !== undefined) {
      if (
        existing.executionId !== executionId ||
        existing.basisJson !== basis ||
        existing.ruleResultsJson !== ruleResults
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
        ruleResultsJson: ruleResults,
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
          basis: JSON.parse(row.basisJson) as RecognitionProposal["basis"],
          ruleResults: JSON.parse(
            row.ruleResultsJson,
          ) as RecognitionProposal["ruleResults"],
        };
  }

  private insertAcceptedFactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    accepted: AcceptedRecognition,
  ): void {
    transaction
      .insert(entities)
      .values({ id: accepted.entity.id, kind: accepted.entity.kind })
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
          proposalId: recognitionSourceAssociation.proposalId,
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

    this.insertOrVerifyArtifactFactsWithDrizzle(transaction, accepted);
    this.attachAcceptedSourceArtifactAssociationProvenanceWithDrizzle(
      transaction,
      accepted,
    );

    for (const assertion of accepted.metadata) {
      const primary = assertion.sourceRecordIds[0];
      const subjectId = assertion.subjectId ?? accepted.entity.id;
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
          property: assertion.property,
          value: assertion.value,
          sourceRecordIdsJson: JSON.stringify(assertion.sourceRecordIds),
          qualifiersJson: JSON.stringify(assertion.qualifiers ?? []),
          sourceSlot: assertion.sourceSlot,
          observedArtifactPartJson:
            assertion.observedArtifactPart === undefined
              ? null
              : JSON.stringify(assertion.observedArtifactPart),
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
          existing.subjectId !== relationship.subjectId ||
          existing.participantId !== relationship.participantId ||
          existing.type !== relationship.type ||
          existing.role !== relationship.role ||
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
          subjectId: relationship.subjectId,
          participantId: relationship.participantId,
          type: relationship.type,
          role: relationship.role,
          sourceRecordIdsJson: JSON.stringify(relationship.sourceRecordIds),
          qualifiersJson: JSON.stringify(relationship.qualifiers ?? []),
          producerJson: producerJson(relationship.producer),
        })
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
  }

  /**
   * 保持身份的重新评估会追加不可变物料事实，并结束被新完整解释取代的来源所有关联。
   */
  private insertReevaluatedArtifactFactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    current: AcceptedRecognition,
    accepted: AcceptedRecognition,
  ): void {
    this.insertOrVerifyArtifactFactsWithDrizzle(transaction, accepted);
    this.attachAcceptedSourceArtifactAssociationProvenanceWithDrizzle(
      transaction,
      accepted,
    );
    this.replaceLocalObservedMetadataWithDrizzle(
      transaction,
      current,
      accepted,
    );

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
        (ownedBy(association, currentSourceRecordIds) ||
          association.observedArtifactPart !== undefined),
    );
    const successors = accepted.artifactAssociations.filter(
      (association) =>
        ownedBy(association, nextSourceRecordIds) ||
        association.observedArtifactPart !== undefined,
    );
    for (const predecessor of removed) {
      const sameCoordinatePredecessors = removed.filter(
        (association) =>
          association.subjectId === predecessor.subjectId &&
          association.role === predecessor.role,
      );
      const sameCoordinateSuccessors = successors.filter(
        (association) =>
          association.subjectId === predecessor.subjectId &&
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
      } else if (predecessor.observedArtifactPart !== undefined) {
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
            `${item.subjectId ?? accepted.entity.id}\u0000${item.property}\u0000${item.sourceSlot}`,
        ),
    );
    for (const next of accepted.metadata.filter(local)) {
      const subject = next.subjectId ?? accepted.entity.id;
      const result = transaction
        .insert(metadataAssertions)
        .values({
          subjectId: subject,
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
          (previous.subjectId ?? current.entity.id) === subject &&
          previous.property === next.property &&
          previous.sourceSlot === next.sourceSlot,
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
      const subject = previous.subjectId ?? current.entity.id;
      const coordinate = `${subject}\u0000${previous.property}\u0000${previous.sourceSlot}`;
      if (nextCoordinates.has(coordinate)) continue;
      const row = transaction
        .select({ id: metadataAssertions.id })
        .from(metadataAssertions)
        .where(
          and(
            eq(metadataAssertions.subjectId, subject),
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
            subjectId: association.subjectId,
            artifactId: association.artifactId,
            role: association.role,
            sourceRecordIdsJson: sourceRecordIds,
            observedArtifactPartJson: observedArtifactPart,
            producerJson: producerJson(association.producer),
            sourceAssociationId,
          })
          .run();
      } else if (
        existing.subjectId !== association.subjectId ||
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
   * 普通刷新把本次有界 snapshot 规范化到 Location 键控的当前观察投影。热消费查询
   * 只读该投影，不扫描保留的 WorkflowExecution JSON。
   */
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
        const explicitlyUnavailable = snapshots.some(
          (snapshot) =>
            snapshot.complete &&
            path
              .relative(
                path.resolve(snapshot.root),
                path.resolve(previous.address),
              )
              .split(path.sep)[0] !== "..",
        );
        if (explicitlyUnavailable)
          transaction
            .delete(currentFileObservations)
            .where(eq(currentFileObservations.locationId, previous.id))
            .run();
      }
    }
    for (const location of acceptedLocations) {
      if (location.kind !== "observed") continue;
      const matches = snapshots.flatMap((snapshot) =>
        snapshot.files
          .filter(
            (file) =>
              path.resolve(snapshot.root, file.relativePath) ===
              path.resolve(location.address),
          )
          .map((file) => ({ snapshot, file })),
      );
      const current = matches.toSorted((left, right) =>
        right.snapshot.observedAt.localeCompare(left.snapshot.observedAt),
      )[0];
      if (current === undefined) {
        const explicitlyUnavailable = snapshots.some(
          (snapshot) =>
            snapshot.complete &&
            path
              .relative(
                path.resolve(snapshot.root),
                path.resolve(location.address),
              )
              .split(path.sep)[0] !== "..",
        );
        if (explicitlyUnavailable)
          transaction
            .delete(currentFileObservations)
            .where(eq(currentFileObservations.locationId, location.id))
            .run();
        continue;
      }
      const conditionalBaseline = currentObservationConditionalBaseline(
        transaction,
        {
          artifactId: location.artifactId,
          locationId: location.id,
          snapshotId: current.snapshot.id,
          observedAt: current.snapshot.observedAt,
          size: current.file.size,
          modifiedAt: current.file.modifiedAt,
        },
      );
      transaction
        .insert(currentFileObservations)
        .values({
          locationId: location.id,
          snapshotId: current.snapshot.id,
          observedAt: current.snapshot.observedAt,
          size: current.file.size,
          modifiedAt: current.file.modifiedAt,
          conditionalBaseline,
        })
        .onConflictDoUpdate({
          target: currentFileObservations.locationId,
          set: {
            snapshotId: current.snapshot.id,
            observedAt: current.snapshot.observedAt,
            size: current.file.size,
            modifiedAt: current.file.modifiedAt,
            conditionalBaseline,
          },
        })
        .run();
    }
  }

  private insertOrReuseSourcedEntityWithDrizzle(
    transaction: DrizzleWriteTransaction,
    entity: SourcedEntity,
  ): void {
    const existing = transaction
      .select({
        kind: entities.kind,
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
        existing.kind !== entity.kind ||
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

    transaction
      .insert(entities)
      .values({ id: entity.id, kind: entity.kind })
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
    readonly participant_id: string;
    readonly type: string;
    readonly role: string;
    readonly qualifiers_json: string;
  }> {
    const candidates = query
      .select({
        relationshipId: relationshipLifecycles.relationshipId,
        subjectId: entityRelationships.subjectId,
        sourceSlot: relationshipLifecycles.sourceSlot,
        participant_id: entityRelationships.participantId,
        type: entityRelationships.type,
        role: entityRelationships.role,
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

  /**
   * 更正时的事实撤回与识别头推进属于同一个即时 CAS 事务。在保留历史范围语义的同时，
   * 通过事务的 Drizzle 查询构建器表达每一次读写。
   */
  private retractIdentityFactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    input: {
      readonly assetId: string;
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
      readonly sourceRecordId: string;
    },
  ): void {
    const coverageIds = transaction
      .select({ coverageId: sourceLineageHeads.coverageId })
      .from(sourceLineageHeads)
      .where(
        and(
          eq(sourceLineageHeads.subjectId, input.assetId),
          eq(sourceLineageHeads.sourceIdentity, input.sourceIdentity),
          eq(sourceLineageHeads.nativeAddress, input.nativeAddress),
        ),
      )
      .all()
      .map((row) => row.coverageId);
    const supersededMetadata = new Set(
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
    const retractedMetadata = new Set(
      transaction
        .select({ assertionId: metadataAssertionRetractions.assertionId })
        .from(metadataAssertionRetractions)
        .all()
        .map((row) => row.assertionId),
    );
    const supersededRelationships = new Set(
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
    const retractedRelationships = new Set(
      transaction
        .select({ relationshipId: relationshipRetractions.relationshipId })
        .from(relationshipRetractions)
        .all()
        .map((row) => row.relationshipId),
    );
    for (const coverageId of coverageIds) {
      const metadata = transaction
        .select({
          assertionId: metadataAssertionLifecycles.assertionId,
          subjectId: metadataAssertions.subjectId,
          sourceSlot: metadataAssertionLifecycles.sourceSlot,
        })
        .from(metadataAssertionLifecycles)
        .innerJoin(
          metadataAssertions,
          eq(metadataAssertions.id, metadataAssertionLifecycles.assertionId),
        )
        .where(
          and(
            eq(
              metadataAssertionLifecycles.sourceIdentity,
              input.sourceIdentity,
            ),
            eq(metadataAssertionLifecycles.nativeAddress, input.nativeAddress),
            eq(metadataAssertionLifecycles.coverageId, coverageId),
          ),
        )
        .all()
        .filter(
          (row) =>
            !supersededMetadata.has(row.assertionId) &&
            !retractedMetadata.has(row.assertionId),
        );
      const metadataChanges = deriveSourceSlotLifecycleChanges({
        currentSlots: metadata.map((item) =>
          sourceFactCoordinate(item.subjectId, item.sourceSlot),
        ),
        nextSlots: [],
        coverageCompleteness: "complete",
      });
      const metadataSlots = new Set(metadataChanges.retracted);
      for (const item of metadata) {
        if (
          !metadataSlots.has(
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

      const relationships = transaction
        .select({
          relationshipId: relationshipLifecycles.relationshipId,
          subjectId: entityRelationships.subjectId,
          sourceSlot: relationshipLifecycles.sourceSlot,
        })
        .from(relationshipLifecycles)
        .innerJoin(
          entityRelationships,
          eq(entityRelationships.id, relationshipLifecycles.relationshipId),
        )
        .where(
          and(
            eq(relationshipLifecycles.sourceIdentity, input.sourceIdentity),
            eq(relationshipLifecycles.nativeAddress, input.nativeAddress),
            eq(relationshipLifecycles.coverageId, coverageId),
          ),
        )
        .all()
        .filter(
          (row) =>
            !supersededRelationships.has(row.relationshipId) &&
            !retractedRelationships.has(row.relationshipId),
        );
      const relationshipChanges = deriveSourceSlotLifecycleChanges({
        currentSlots: relationships.map((item) =>
          sourceFactCoordinate(item.subjectId, item.sourceSlot),
        ),
        nextSlots: [],
        coverageCompleteness: "complete",
      });
      const relationshipSlots = new Set(relationshipChanges.retracted);
      for (const item of relationships) {
        if (
          !relationshipSlots.has(
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
        metadataAssertionMatchesCurrent(previous, assertion)
      ) {
        continue;
      }
      const result = transaction
        .insert(metadataAssertions)
        .values({
          subjectId: assertion.subjectId ?? submission.assetId,
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
        .values({ id: entity.id, kind: entity.kind })
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
      const subjectId = relationship.subjectId ?? submission.assetId;
      const candidates = transaction
        .select({
          relationship_id: relationshipLifecycles.relationshipId,
          participant_id: entityRelationships.participantId,
          type: entityRelationships.type,
          role: entityRelationships.role,
          qualifiers_json: entityRelationships.qualifiersJson,
        })
        .from(relationshipLifecycles)
        .innerJoin(
          entityRelationships,
          eq(entityRelationships.id, relationshipLifecycles.relationshipId),
        )
        .where(
          and(
            eq(entityRelationships.subjectId, subjectId),
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
        relationshipMatchesCurrent(previous, relationship)
      ) {
        continue;
      }
      const relationshipId = `source-refresh-relationship_${randomUUID()}`;
      transaction
        .insert(entityRelationships)
        .values({
          id: relationshipId,
          subjectId,
          participantId: relationship.participantId,
          type: relationship.type,
          role: relationship.role,
          sourceRecordIdsJson: JSON.stringify(relationship.sourceRecordIds),
          qualifiersJson: JSON.stringify(relationship.qualifiers ?? []),
          producerJson: producerJson(relationship.producer),
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
        })
        .run();
    }
  }

  private insertProjectedRelationshipsAndMentionsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    preview: ChangeImpactPreview,
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
        .values({ id: entity.id, kind: entity.kind })
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
          subjectId: relationship.subjectId,
          participantId: relationship.participantId,
          type: relationship.type,
          role: relationship.role,
          sourceRecordIdsJson: JSON.stringify(relationship.sourceRecordIds),
          qualifiersJson: JSON.stringify(relationship.qualifiers ?? []),
          producerJson: producerJson(relationship.producer),
        })
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
        })
        .run();
    }
  }

  private applyProjectedArtifactsWithDrizzle(
    transaction: DrizzleWriteTransaction,
    preview: ChangeImpactPreview,
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
          association.subjectId !== preview.assetId ||
          !artifactIds.has(association.artifactId),
      )
    ) {
      throw new Error("Projected artifact graph is inconsistent");
    }
    const projectedCover = preview.projected.artifactAssociations.filter(
      (association) => association.role === "asset.primary-cover",
    );
    if (
      (preview.projected.primaryCoverArtifactId === undefined &&
        projectedCover.length !== 0) ||
      (preview.projected.primaryCoverArtifactId !== undefined &&
        (projectedCover.length !== 1 ||
          projectedCover[0]?.artifactId !==
            preview.projected.primaryCoverArtifactId))
    ) {
      throw new Error(
        "Projected primary-cover Information Requirement is unmet",
      );
    }
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

    this.insertOrVerifyArtifactFactsWithDrizzle(transaction, preview.projected);
    const projectedIds = new Set(
      preview.projected.artifactAssociations.map(
        (association) => association.id,
      ),
    );
    for (const current of currentAssociations) {
      if (projectedIds.has(current.id)) continue;
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
  ): Promise<readonly AcceptedAssetState[]> {
    if (assetIds.length === 0) return [];
    const [
      assetEntities,
      heads,
      associations,
      currentAssociationsRows,
      decisions,
      policies,
    ] = await Promise.all([
      query
        .select()
        .from(entities)
        .where(
          and(
            inArray(entities.id, sqliteTextSet(assetIds)),
            eq(entities.kind, "digital-asset"),
          ),
        ),
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
        .select()
        .from(metadataPolicyEnrollments)
        .where(
          inArray(metadataPolicyEnrollments.subjectId, sqliteTextSet(assetIds)),
        )
        .orderBy(asc(sql<number>`${metadataPolicyEnrollments}.rowid`)),
    ]);
    const proposalIds = uniqueStrings(
      decisions.map((decision) => decision.proposalId),
    );
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
        basis: JSON.parse(row.basisJson) as RecognitionProposal["basis"],
        ruleResults: JSON.parse(
          row.ruleResultsJson,
        ) as RecognitionProposal["ruleResults"],
      } satisfies RecognitionProposal,
    }));
    const factSubjectIds = uniqueStrings([
      ...assetIds,
      ...parsedProposals.flatMap(
        ({ proposal }) =>
          recognitionSourceInterpretation(proposal)?.entities?.map(
            (entity) => entity.id,
          ) ?? [],
      ),
    ]);
    const [artifactAssociationRows, metadataRows, relationshipRows] =
      await Promise.all([
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
                sqliteTextSet(factSubjectIds),
              ),
              indexMetadataProperties === undefined
                ? undefined
                : inArray(
                    metadataAssertions.property,
                    sqliteTextSet(indexMetadataProperties),
                  ),
            ),
          ),
        query
          .select()
          .from(entityRelationships)
          .where(
            inArray(
              entityRelationships.subjectId,
              sqliteTextSet(factSubjectIds),
            ),
          )
          .orderBy(asc(sql<number>`${entityRelationships}.rowid`)),
      ]);
    const artifactAssociationIds = artifactAssociationRows.map((row) => row.id);
    const metadataIds = metadataRows.map((row) => row.id);
    const relationshipIds = relationshipRows.map((row) => row.id);
    const sourceRecordIds = uniqueStrings([
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
      artifactRetractionsRows,
      metadataLifecyclesRows,
      metadataRetractionsRows,
      relationshipLifecyclesRows,
      relationshipRetractionsRows,
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
      relationshipIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(relationshipLifecycles)
            .where(
              inArray(
                relationshipLifecycles.relationshipId,
                sqliteTextSet(relationshipIds),
              ),
            ),
      relationshipIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(relationshipRetractions)
            .where(
              inArray(
                relationshipRetractions.relationshipId,
                sqliteTextSet(relationshipIds),
              ),
            ),
      sourceRecordIds.length === 0
        ? Promise.resolve([])
        : query
            .select({
              id: sourceRecords.id,
              sourceIdentity: sourceRecords.sourceIdentity,
              nativeAddress: sourceRecords.nativeAddress,
            })
            .from(sourceRecords)
            .where(inArray(sourceRecords.id, sqliteTextSet(sourceRecordIds)))
            .orderBy(asc(sql<number>`${sourceRecords}.rowid`)),
    ]);
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
    const digests = uniqueStrings(revisionRows.map((row) => row.blobDigest));
    const blobRows =
      digests.length === 0
        ? []
        : await query
            .select()
            .from(blobs)
            .where(inArray(blobs.digest, sqliteTextSet(digests)))
            .orderBy(asc(blobs.digest));
    const participantIds = uniqueStrings(
      relationshipRows.map((row) => row.participantId),
    );
    const [participantEntities, sourcedEntityRows, resolutionRows] =
      participantIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            query
              .select()
              .from(entities)
              .where(inArray(entities.id, sqliteTextSet(participantIds)))
              .orderBy(asc(entities.id)),
            query
              .select()
              .from(sourcedEntities)
              .where(
                inArray(sourcedEntities.id, sqliteTextSet(participantIds)),
              ),
            query
              .select()
              .from(entityResolutionDecisions)
              .where(
                inArray(
                  entityResolutionDecisions.entityId,
                  sqliteTextSet(participantIds),
                ),
              )
              .orderBy(asc(sql<number>`${entityResolutionDecisions}.rowid`)),
          ]);
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

    return assetIds.flatMap((assetId) => {
      const accepted = this.projectCurrentAcceptedFromRows(assetId, {
        entities: [...assetEntities, ...participantEntities],
        heads,
        associations,
        currentAssociations: currentAssociationsRows,
        decisions,
        proposals: proposalRows,
        artifactAssociations: artifactAssociationRows,
        artifactSupersessions,
        artifactRetractions: artifactRetractionsRows,
        metadata: metadataRows,
        metadataLifecycles: metadataLifecyclesRows,
        metadataRetractions: metadataRetractionsRows,
        relationships: relationshipRows,
        relationshipLifecycles: relationshipLifecyclesRows,
        relationshipRetractions: relationshipRetractionsRows,
        policies,
        sourceRecords: sourceRecordRows,
        artifacts: artifactRows,
        locations: locationRows,
        revisions: revisionRows,
        blobs: blobRows,
        sourcedEntities: sourcedEntityRows,
        resolutions: resolutionRows,
        mentions: mentionRows,
      });
      return accepted === undefined ? [] : [accepted];
    });
  }

  private projectCurrentAcceptedFromRows(
    assetId: string,
    rows: CurrentCatalogueHydrationRows,
  ): AcceptedAssetState | undefined {
    const entity = rows.entities.find(
      (item) => item.id === assetId && item.kind === "digital-asset",
    );
    const head = rows.heads.find((item) => item.subjectId === assetId);
    if (entity === undefined || head === undefined) return undefined;
    const recognitionSourceAssociationRow = rows.associations.find(
      (association) =>
        association.id === head.recognitionSourceAssociationId &&
        association.subjectId === assetId,
    );
    const decision = rows.decisions.find(
      (item) =>
        item.id === head.recognitionDecisionId && item.assetId === assetId,
    );
    if (
      decision === undefined ||
      (recognitionSourceAssociationRow !== undefined &&
        decision.proposalId !== recognitionSourceAssociationRow.proposalId)
    )
      return undefined;
    const proposalRow = rows.proposals.find(
      (item) => item.id === decision.proposalId,
    );
    if (proposalRow === undefined) return undefined;
    const proposal: RecognitionProposal = {
      id: proposalRow.id,
      basis: JSON.parse(proposalRow.basisJson) as RecognitionProposal["basis"],
      ruleResults: JSON.parse(
        proposalRow.ruleResultsJson,
      ) as RecognitionProposal["ruleResults"],
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
      proposalId: association.proposalId,
    });
    const recognitionSourceAssociation =
      recognitionSourceAssociationRow === undefined
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
    const factSubjectIds = new Set([
      assetId,
      ...relatedEntities.map((item) => item.id),
    ]);
    const artifactAssociationRows = rows.artifactAssociations.filter((row) =>
      factSubjectIds.has(row.subjectId),
    );
    const metadataRows = rows.metadata.filter((row) =>
      factSubjectIds.has(row.subjectId),
    );
    const relationshipRows = rows.relationships.filter((row) =>
      factSubjectIds.has(row.subjectId),
    );
    const sourceRecordsById = new Map(
      rows.sourceRecords.map((record) => [record.id, record]),
    );
    const factLineages = new Set([
      ...(interpretation?.sourceRecordIds ?? []).flatMap((id) => {
        const record = sourceRecordsById.get(id);
        return record === undefined
          ? []
          : [sourceLineageKey(record.sourceIdentity, record.nativeAddress)];
      }),
      ...currentAssociations.map((association) =>
        sourceLineageKey(association.sourceIdentity, association.nativeAddress),
      ),
    ]);
    const supersededArtifactAssociationIds = new Set(
      rows.artifactSupersessions.map((item) => item.predecessorAssociationId),
    );
    const retractedArtifactAssociationIds = new Set(
      rows.artifactRetractions.map((item) => item.associationId),
    );
    const currentArtifactAssociationRows = artifactAssociationRows.filter(
      (row) => {
        if (
          supersededArtifactAssociationIds.has(row.id) ||
          retractedArtifactAssociationIds.has(row.id)
        )
          return false;
        const recordIds = jsonStringArray(
          row.sourceRecordIdsJson,
          "artifact association source records",
        );
        if (recordIds.length === 0) return row.subjectId === assetId;
        return recordIds.some((id) => {
          const record = sourceRecordsById.get(id);
          return (
            record !== undefined &&
            factLineages.has(
              sourceLineageKey(record.sourceIdentity, record.nativeAddress),
            )
          );
        });
      },
    );
    const metadataLifecycleById = new Map(
      rows.metadataLifecycles.map((item) => [item.assertionId, item]),
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
      const livesOnCurrentLineage =
        lifecycle !== undefined &&
        factLineages.has(
          sourceLineageKey(lifecycle.sourceIdentity, lifecycle.nativeAddress),
        );
      const isLocalObservedFact =
        recordIds.length === 0 && row.observedArtifactPartJson !== null;
      if (!livesOnCurrentLineage && !isLocalObservedFact) return [];
      return [
        {
          subjectId: row.subjectId,
          property: row.property,
          sourceSlot: lifecycle?.sourceSlot ?? row.sourceSlot ?? "",
          value: row.value,
          sourceRecordIds: recordIds,
          ...(row.qualifiersJson === "[]"
            ? {}
            : {
                qualifiers: JSON.parse(row.qualifiersJson) as NonNullable<
                  MetadataAssertion["qualifiers"]
                >,
              }),
          ...(row.observedArtifactPartJson === null
            ? {}
            : {
                observedArtifactPart: JSON.parse(
                  row.observedArtifactPartJson,
                ) as NonNullable<MetadataAssertion["observedArtifactPart"]>,
              }),
          ...(row.producerJson === null
            ? {}
            : { producer: producerFromJson(row.producerJson) }),
        },
      ];
    });
    const metadataRecordIds = new Set(
      metadata.flatMap((assertion) => assertion.sourceRecordIds),
    );
    const metadataSourceRecords = rows.sourceRecords.flatMap((record) =>
      metadataRecordIds.has(record.id)
        ? [{ id: record.id, sourceIdentity: record.sourceIdentity }]
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
    const relationshipLifecycleById = new Map(
      rows.relationshipLifecycles.map((item) => [item.relationshipId, item]),
    );
    const supersededRelationshipIds = new Set(
      rows.relationshipLifecycles.flatMap((item) =>
        item.predecessorRelationshipId === null
          ? []
          : [item.predecessorRelationshipId],
      ),
    );
    const retractedRelationshipIds = new Set(
      rows.relationshipRetractions.map((item) => item.relationshipId),
    );
    const currentRelationshipRows = relationshipRows.filter((row) => {
      if (
        supersededRelationshipIds.has(row.id) ||
        retractedRelationshipIds.has(row.id)
      )
        return false;
      const lifecycle = relationshipLifecycleById.get(row.id);
      return (
        lifecycle !== undefined &&
        factLineages.has(
          sourceLineageKey(lifecycle.sourceIdentity, lifecycle.nativeAddress),
        )
      );
    });
    const participantIds = new Set(
      currentRelationshipRows.map((item) => item.participantId),
    );
    const entityById = new Map(rows.entities.map((item) => [item.id, item]));
    const sourcedEntityById = new Map(
      rows.sourcedEntities.map((item) => [item.id, item]),
    );
    const relationshipEntities = [...participantIds].flatMap(
      (participantId): SourcedEntity[] => {
        const relatedEntity = entityById.get(participantId);
        const sourcedEntity = sourcedEntityById.get(participantId);
        if (relatedEntity === undefined || sourcedEntity === undefined)
          return [];
        return [
          {
            id: relatedEntity.id,
            kind: relatedEntity.kind as SourcedEntity["kind"],
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
    const currentEntities = [
      ...new Map(
        [...relationshipEntities, ...relatedEntities].map((item) => [
          item.id,
          item,
        ]),
      ).values(),
    ];
    const relationships = currentRelationshipRows.map(
      (row): EntityRelationship => {
        const lifecycle = relationshipLifecycleById.get(row.id);
        if (lifecycle === undefined)
          throw new Error("Current relationship requires a lifecycle");
        return {
          id: row.id,
          subjectId: row.subjectId,
          participantId: row.participantId,
          type: row.type,
          role: row.role,
          sourceSlot: lifecycle.sourceSlot,
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
    const activeAssetRelationshipRows = relationshipRows.filter(
      (row) =>
        row.subjectId === assetId &&
        !supersededRelationshipIds.has(row.id) &&
        !retractedRelationshipIds.has(row.id),
    );
    const eligibleResolutionRows = rows.resolutions.filter((resolution) => {
      const resolutionRecordIds = jsonStringArray(
        resolution.sourceRecordIdsJson,
        "entity resolution source records",
      );
      return activeAssetRelationshipRows.some(
        (relationship) =>
          relationship.participantId === resolution.entityId &&
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
      sourceAssociations: currentAssociations,
      ...(recognitionSourceAssociation === undefined
        ? {}
        : { recognitionSourceAssociation }),
      metadataPolicyIds: rows.policies.flatMap((item) =>
        item.subjectId === assetId ? [item.policyId] : [],
      ),
      metadataSourceRecords,
      recognitionDecision: {
        id: decision.id,
        proposalId: decision.proposalId,
        assetId: decision.assetId,
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
      artifactAssociations: currentArtifactAssociationRows.map(
        (row): ArtifactAssociation => {
          const recordIds = jsonStringArray(
            row.sourceRecordIdsJson,
            "artifact association source records",
          );
          return {
            id: row.id,
            subjectId: row.subjectId,
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
      metadata,
      entities: currentEntities,
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
  ): Promise<AcceptedAssetState | undefined> {
    const [entity] = await query
      .select()
      .from(entities)
      .where(and(eq(entities.id, assetId), eq(entities.kind, "digital-asset")));
    if (entity === undefined) return undefined;

    const [head] = await query
      .select()
      .from(recognitionHeads)
      .where(eq(recognitionHeads.subjectId, assetId));
    if (head === undefined) return undefined;

    const [recognitionSourceAssociation] = await query
      .select({
        id: sourceAssociations.id,
        subjectId: sourceAssociations.subjectId,
        sourceIdentity: sourceAssociations.sourceIdentity,
        nativeAddress: sourceAssociations.nativeAddress,
        proposalId: sourceAssociations.proposalId,
      })
      .from(sourceAssociations)
      .where(
        and(
          eq(sourceAssociations.id, head.recognitionSourceAssociationId ?? ""),
          eq(sourceAssociations.subjectId, assetId),
        ),
      );
    const currentAssociationRows = await query
      .select({
        id: sourceAssociations.id,
        subjectId: sourceAssociations.subjectId,
        sourceIdentity: sourceAssociations.sourceIdentity,
        nativeAddress: sourceAssociations.nativeAddress,
        proposalId: sourceAssociations.proposalId,
      })
      .from(currentSourceAssociations)
      .innerJoin(
        sourceAssociations,
        eq(currentSourceAssociations.associationId, sourceAssociations.id),
      )
      .where(
        and(
          eq(currentSourceAssociations.subjectId, assetId),
          eq(sourceAssociations.subjectId, assetId),
        ),
      )
      .orderBy(asc(sql<number>`${sourceAssociations}.rowid`));
    const currentAssociations = [
      ...new Map(
        currentAssociationRows.map((association) => [
          association.id,
          association,
        ]),
      ).values(),
    ];
    const [decision] = await query
      .select()
      .from(recognitionDecisions)
      .where(
        and(
          eq(recognitionDecisions.id, head.recognitionDecisionId),
          eq(recognitionDecisions.assetId, assetId),
        ),
      );
    if (
      decision === undefined ||
      (recognitionSourceAssociation !== undefined &&
        decision.proposalId !== recognitionSourceAssociation.proposalId)
    )
      return undefined;
    const [proposalRow] = await query
      .select()
      .from(recognitionProposals)
      .where(eq(recognitionProposals.id, decision.proposalId));
    if (proposalRow === undefined) return undefined;
    const proposal: RecognitionProposal = {
      id: proposalRow.id,
      basis: JSON.parse(proposalRow.basisJson) as RecognitionProposal["basis"],
      ruleResults: JSON.parse(
        proposalRow.ruleResultsJson,
      ) as RecognitionProposal["ruleResults"],
    };

    const interpretation = recognitionSourceInterpretation(proposal);
    const relatedEntities = interpretation?.entities ?? [];
    const artifactSubjectIds = uniqueStrings([
      assetId,
      ...relatedEntities.map((item) => item.id),
    ]);
    const primaryRecordIds = interpretation?.sourceRecordIds ?? [];
    const [
      artifactAssociationRows,
      metadataRows,
      relationshipRows,
      policyRows,
    ] = await Promise.all([
      query
        .select()
        .from(artifactAssociations)
        .where(inArray(artifactAssociations.subjectId, artifactSubjectIds))
        .orderBy(asc(artifactAssociations.id)),
      query
        .select()
        .from(metadataAssertions)
        .where(inArray(metadataAssertions.subjectId, artifactSubjectIds)),
      query
        .select()
        .from(entityRelationships)
        .where(inArray(entityRelationships.subjectId, artifactSubjectIds))
        .orderBy(asc(sql<number>`${entityRelationships}.rowid`)),
      query
        .select({ policyId: metadataPolicyEnrollments.policyId })
        .from(metadataPolicyEnrollments)
        .where(eq(metadataPolicyEnrollments.subjectId, assetId))
        .orderBy(asc(sql<number>`${metadataPolicyEnrollments}.rowid`)),
    ]);

    const artifactAssociationIds = artifactAssociationRows.map((row) => row.id);
    const metadataAssertionIds = metadataRows.map((row) => row.id);
    const relationshipIds = relationshipRows.map((row) => row.id);
    const sourceRecordIds = uniqueStrings([
      ...primaryRecordIds,
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
      artifactRetractions,
      metadataLifecycles,
      metadataRetractions,
      relationshipLifecyclesRows,
      relationshipRetractionRows,
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
                artifactAssociationIds,
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
                artifactAssociationIds,
              ),
            ),
      metadataAssertionIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(metadataAssertionLifecycles)
            .where(
              inArray(
                metadataAssertionLifecycles.assertionId,
                metadataAssertionIds,
              ),
            ),
      metadataAssertionIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(metadataAssertionRetractions)
            .where(
              inArray(
                metadataAssertionRetractions.assertionId,
                metadataAssertionIds,
              ),
            ),
      relationshipIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(relationshipLifecycles)
            .where(
              inArray(relationshipLifecycles.relationshipId, relationshipIds),
            ),
      relationshipIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(relationshipRetractions)
            .where(
              inArray(relationshipRetractions.relationshipId, relationshipIds),
            ),
      sourceRecordIds.length === 0
        ? Promise.resolve([])
        : query
            .select()
            .from(sourceRecords)
            .where(inArray(sourceRecords.id, sourceRecordIds))
            .orderBy(asc(sql<number>`${sourceRecords}.rowid`)),
    ]);

    const sourceRecordsById = new Map(
      sourceRecordRows.map((record) => [record.id, record]),
    );
    const factLineages = new Set([
      ...primaryRecordIds.flatMap((id) => {
        const record = sourceRecordsById.get(id);
        return record === undefined
          ? []
          : [sourceLineageKey(record.sourceIdentity, record.nativeAddress)];
      }),
      ...currentAssociations.map((association) =>
        sourceLineageKey(association.sourceIdentity, association.nativeAddress),
      ),
    ]);
    const supersededArtifactAssociationIds = new Set(
      artifactSupersessions.map((row) => row.predecessorAssociationId),
    );
    const retractedArtifactAssociationIds = new Set(
      artifactRetractions.map((row) => row.associationId),
    );
    const currentArtifactAssociationRows = artifactAssociationRows.filter(
      (row) => {
        if (
          supersededArtifactAssociationIds.has(row.id) ||
          retractedArtifactAssociationIds.has(row.id)
        )
          return false;
        const associationRecordIds = jsonStringArray(
          row.sourceRecordIdsJson,
          "artifact association source records",
        );
        if (associationRecordIds.length === 0) return row.subjectId === assetId;
        return associationRecordIds.some((id) => {
          const record = sourceRecordsById.get(id);
          return (
            record !== undefined &&
            factLineages.has(
              sourceLineageKey(record.sourceIdentity, record.nativeAddress),
            )
          );
        });
      },
    );

    const metadataLifecycleByAssertionId = new Map(
      metadataLifecycles.map((row) => [row.assertionId, row]),
    );
    const supersededMetadataAssertionIds = new Set(
      metadataLifecycles.flatMap((row) =>
        row.predecessorAssertionId === null ? [] : [row.predecessorAssertionId],
      ),
    );
    const retractedMetadataAssertionIds = new Set(
      metadataRetractions.map((row) => row.assertionId),
    );
    const metadata = metadataRows.flatMap((row): MetadataAssertion[] => {
      if (
        supersededMetadataAssertionIds.has(row.id) ||
        retractedMetadataAssertionIds.has(row.id)
      )
        return [];
      const lifecycle = metadataLifecycleByAssertionId.get(row.id);
      const sourceRecordIdsForAssertion = jsonStringArray(
        row.sourceRecordIdsJson,
        "metadata assertion source records",
      );
      const livesOnCurrentLineage =
        lifecycle !== undefined &&
        factLineages.has(
          sourceLineageKey(lifecycle.sourceIdentity, lifecycle.nativeAddress),
        );
      const isLocalObservedFact =
        sourceRecordIdsForAssertion.length === 0 &&
        row.observedArtifactPartJson !== null;
      if (!livesOnCurrentLineage && !isLocalObservedFact) return [];
      return [
        {
          subjectId: row.subjectId,
          property: row.property,
          sourceSlot: lifecycle?.sourceSlot ?? row.sourceSlot ?? "",
          value: row.value,
          sourceRecordIds: sourceRecordIdsForAssertion,
          ...(row.qualifiersJson === "[]"
            ? {}
            : {
                qualifiers: JSON.parse(row.qualifiersJson) as NonNullable<
                  MetadataAssertion["qualifiers"]
                >,
              }),
          ...(row.observedArtifactPartJson === null
            ? {}
            : {
                observedArtifactPart: JSON.parse(
                  row.observedArtifactPartJson,
                ) as NonNullable<MetadataAssertion["observedArtifactPart"]>,
              }),
          ...(row.producerJson === null
            ? {}
            : { producer: producerFromJson(row.producerJson) }),
        },
      ];
    });
    const metadataRecordIds = uniqueStrings(
      metadata.flatMap((assertion) => assertion.sourceRecordIds),
    );
    const metadataRecordIdSet = new Set(metadataRecordIds);
    const metadataSourceRecords = sourceRecordRows.flatMap((record) =>
      metadataRecordIdSet.has(record.id)
        ? [{ id: record.id, sourceIdentity: record.sourceIdentity }]
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
    const artifactIds = uniqueStrings([
      ...currentArtifactAssociationRows.map(
        (association) => association.artifactId,
      ),
      ...observedArtifactIds,
    ]).toSorted();
    const [artifactRows, locationRows, revisionRows] =
      artifactIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            query
              .select()
              .from(artifacts)
              .where(inArray(artifacts.id, artifactIds))
              .orderBy(asc(artifacts.id)),
            query
              .select()
              .from(locations)
              .where(inArray(locations.artifactId, artifactIds))
              .orderBy(asc(locations.id)),
            query
              .select()
              .from(artifactRevisions)
              .where(inArray(artifactRevisions.artifactId, artifactIds))
              .orderBy(asc(artifactRevisions.id)),
          ]);
    const digests = uniqueStrings(
      revisionRows.map((revision) => revision.blobDigest),
    );
    const blobRows =
      digests.length === 0
        ? []
        : await query
            .select()
            .from(blobs)
            .where(inArray(blobs.digest, digests))
            .orderBy(asc(blobs.digest));

    const relationshipLifecycleById = new Map(
      relationshipLifecyclesRows.map((row) => [row.relationshipId, row]),
    );
    const supersededRelationshipIds = new Set(
      relationshipLifecyclesRows.flatMap((row) =>
        row.predecessorRelationshipId === null
          ? []
          : [row.predecessorRelationshipId],
      ),
    );
    const retractedRelationshipIds = new Set(
      relationshipRetractionRows.map((row) => row.relationshipId),
    );
    const currentRelationshipRows = relationshipRows.filter((row) => {
      if (
        supersededRelationshipIds.has(row.id) ||
        retractedRelationshipIds.has(row.id)
      )
        return false;
      const lifecycle = relationshipLifecycleById.get(row.id);
      return (
        lifecycle !== undefined &&
        factLineages.has(
          sourceLineageKey(lifecycle.sourceIdentity, lifecycle.nativeAddress),
        )
      );
    });
    const relationshipParticipantIds = uniqueStrings(
      currentRelationshipRows.map((row) => row.participantId),
    ).toSorted();
    const [relatedEntityRows, sourcedEntityRows] =
      relationshipParticipantIds.length === 0
        ? [[], []]
        : await Promise.all([
            query
              .select()
              .from(entities)
              .where(inArray(entities.id, relationshipParticipantIds))
              .orderBy(asc(entities.id)),
            query
              .select()
              .from(sourcedEntities)
              .where(inArray(sourcedEntities.id, relationshipParticipantIds)),
          ]);
    const relatedEntityById = new Map(
      relatedEntityRows.map((row) => [row.id, row]),
    );
    const sourcedEntityById = new Map(
      sourcedEntityRows.map((row) => [row.id, row]),
    );
    const relationshipEntities = relationshipParticipantIds.flatMap(
      (participantId): SourcedEntity[] => {
        const relatedEntity = relatedEntityById.get(participantId);
        const sourcedEntity = sourcedEntityById.get(participantId);
        if (relatedEntity === undefined || sourcedEntity === undefined)
          return [];
        return [
          {
            id: relatedEntity.id,
            kind: relatedEntity.kind as SourcedEntity["kind"],
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
    const currentEntities = [
      ...new Map(
        [...relationshipEntities, ...relatedEntities].map((item) => [
          item.id,
          item,
        ]),
      ).values(),
    ];
    const relationships = currentRelationshipRows.map(
      (row): EntityRelationship => {
        const lifecycle = relationshipLifecycleById.get(row.id);
        if (lifecycle === undefined)
          throw new Error("Current relationship requires a lifecycle");
        return {
          id: row.id,
          subjectId: row.subjectId,
          participantId: row.participantId,
          type: row.type,
          role: row.role,
          sourceSlot: lifecycle.sourceSlot,
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

    const activeAssetRelationshipRows = relationshipRows.filter(
      (row) =>
        row.subjectId === assetId &&
        !supersededRelationshipIds.has(row.id) &&
        !retractedRelationshipIds.has(row.id),
    );
    const assetRelationshipParticipantIds = uniqueStrings(
      activeAssetRelationshipRows.map((row) => row.participantId),
    );
    const resolutionRows =
      assetRelationshipParticipantIds.length === 0
        ? []
        : await query
            .select()
            .from(entityResolutionDecisions)
            .where(
              inArray(
                entityResolutionDecisions.entityId,
                assetRelationshipParticipantIds,
              ),
            )
            .orderBy(asc(sql<number>`${entityResolutionDecisions}.rowid`));
    const eligibleResolutionRows = resolutionRows.filter((resolution) => {
      const resolutionSourceRecordIds = jsonStringArray(
        resolution.sourceRecordIdsJson,
        "entity resolution source records",
      );
      return activeAssetRelationshipRows.some(
        (relationship) =>
          relationship.participantId === resolution.entityId &&
          jsonStringArray(
            relationship.sourceRecordIdsJson,
            "relationship source records",
          ).some((id) => resolutionSourceRecordIds.includes(id)),
      );
    });
    const mentionIds = uniqueStrings(
      eligibleResolutionRows.map((resolution) => resolution.mentionId),
    );
    const mentionRows =
      mentionIds.length === 0
        ? []
        : await query
            .select()
            .from(entityMentions)
            .where(inArray(entityMentions.id, mentionIds))
            .orderBy(asc(sql<number>`${entityMentions}.rowid`));
    const entityMentionsForView = mentionRows.map(
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
    );
    const entityResolutionDecisionsForView = eligibleResolutionRows.map(
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
    );

    return {
      proposal,
      entity: { id: entity.id, kind: "digital-asset" },
      sourceAssociations: currentAssociations,
      ...(recognitionSourceAssociation === undefined
        ? {}
        : { recognitionSourceAssociation }),
      metadataPolicyIds: policyRows.map((row) => row.policyId),
      metadataSourceRecords,
      recognitionDecision: {
        id: decision.id,
        proposalId: decision.proposalId,
        assetId: decision.assetId,
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
      artifactAssociations: currentArtifactAssociationRows.map(
        (row): ArtifactAssociation => {
          const sourceRecordIdsForAssociation = jsonStringArray(
            row.sourceRecordIdsJson,
            "artifact association source records",
          );
          return {
            id: row.id,
            subjectId: row.subjectId,
            artifactId: row.artifactId,
            role: row.role,
            ...(row.sourceAssociationId === null
              ? {}
              : { sourceAssociationId: row.sourceAssociationId }),
            ...(sourceRecordIdsForAssociation.length === 0
              ? {}
              : { sourceRecordIds: sourceRecordIdsForAssociation }),
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
      metadata,
      entities: currentEntities,
      entityMentions: entityMentionsForView,
      entityResolutionDecisions: entityResolutionDecisionsForView,
      relationships,
    };
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** 使用一个绑定的 JSON 值，避免展开页面触及 SQLite 变量上限。 */
function sqliteTextSet<T extends string | number>(values: readonly T[]) {
  return sql<T>`(select value from json_each(${JSON.stringify(values)}))`;
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

function metadataAssertionMatchesCurrent(
  current: {
    readonly property: string;
    readonly value: string;
    readonly qualifiers_json: string;
  },
  assertion: MetadataAssertion,
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
    readonly participant_id: string;
    readonly type: string;
    readonly role: string;
    readonly qualifiers_json: string;
  },
  relationship: NonNullable<SourceInterpretationBatch["relationships"]>[number],
): boolean {
  return (
    current.participant_id === relationship.participantId &&
    current.type === relationship.type &&
    current.role === relationship.role &&
    normalizedStoredQualifiers(current.qualifiers_json) ===
      normalizedQualifiers(relationship.qualifiers)
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

function producerFromJson(value: string): CapabilityCoordinate {
  return JSON.parse(value) as CapabilityCoordinate;
}

function assertCompatibleProducer(
  persisted: string | null,
  candidate: CapabilityCoordinate | undefined,
  fact: string,
): void {
  const encoded = producerJson(candidate);
  if (persisted !== null && encoded !== null && persisted !== encoded) {
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
