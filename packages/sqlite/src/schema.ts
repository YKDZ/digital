import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Drizzle Kit intentionally omits `.notNull()` from every one-column INTEGER
// primary key because SQLite usually implies it. This historical table was
// explicitly `INTEGER PRIMARY KEY NOT NULL`; preserve that observable SQLite
// contract by placing the constraint in its reviewed physical type fragment.
const explicitlyRequiredInteger = customType<{
  data: number;
  driverData: number;
}>({
  dataType: () => "INTEGER NOT NULL",
});

/**
 * Every persistent payload that is retained as a whole carries a stable
 * format coordinate. The Drizzle adapter owns its current read/write shape;
 * historical payload versions remain explicit data, not a runtime migration
 * compatibility path.
 */
export type VersionedJson<T = unknown> = {
  readonly version: string;
  readonly payload: T;
};

export const workflowExecutionAuditVersion = "workflow-execution-audit/1";
/**
 * Compatibility marker written by the short-lived pre-release 0031 shape.
 * Real 0031 upgrades leave historical rows NULL; new production writes always
 * replace this coordinate with a complete versioned execution payload.
 */
export const workflowExecutionAuditLegacyMarker = JSON.stringify({
  version: workflowExecutionAuditVersion,
  payload: {},
});

/**
 * The reviewed, complete catalogue structure.  It deliberately lives beside
 * the infrastructure adapter: Domain, Application, Presentation, and
 * Delivery import only their own use-case contracts.
 *
 * Keep this list exhaustive. `schema_migrations` remains a historical
 * physical ledger so a reviewed existing catalogue retains its shape, but
 * SqliteCatalogue never reads or writes it. Formal generated-migration
 * readiness is intentionally owned outside this adapter.
 */
export const schemaMigrations = sqliteTable(
  "schema_migrations",
  {
    id: text().notNull(),
    appliedAt: text("applied_at").notNull(),
  },
  (table) => [
    primaryKey({ name: "schema_migrations_pk", columns: [table.id] }),
  ],
);

export const workflowExecutions = sqliteTable(
  "workflow_executions",
  {
    id: text().notNull(),
    selectionDirectory: text("selection_directory"),
    snapshotJson: text("snapshot_json"),
    status: text().notNull(),
    stage: text().notNull(),
    outcome: text(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull(),
    proposalId: text("proposal_id"),
    acceptedAssetId: text("accepted_asset_id"),
    reason: text(),
    reusePlanJson: text("reuse_plan_json"),
    reusedExecutionId: text("reused_execution_id"),
    selectionIntent: text("selection_intent").notNull().default("scan-now"),
    compatibilityJson: text("compatibility_json").notNull(),
    dispositionsJson: text("dispositions_json").notNull().default("[]"),
    coverAcquisitionJson: text("cover_acquisition_json"),
    managedCoverJson: text("managed_cover_json"),
    automationIntentId: text("automation_intent_id"),
    triggerKind: text("trigger_kind"),
    informationRequirementJson: text("information_requirement_json").notNull(),
    resumeClaimToken: text("resume_claim_token"),
    resumeClaimExpiresAt: text("resume_claim_expires_at"),
    workItemsJson: text("work_items_json").notNull().default("[]"),
    operationKind: text("operation_kind"),
    requestedSelectionJson: text("requested_selection_json"),
    resolvedSelectionJson: text("resolved_selection_json"),
    targetDispositionsJson: text("target_dispositions_json"),
    filesystemSnapshotsJson: text("filesystem_snapshots_json"),
    sourceEnrichmentsJson: text("source_enrichments_json")
      .notNull()
      .default("[]"),
    sourceRefreshRunIdsJson: text("source_refresh_run_ids_json")
      .notNull()
      .default("[]"),
    auditJson: text("audit_json"),
    /** Complete non-secret input retained for restart-safe Asset Refresh. */
    workflowInputJson: text("workflow_input_json"),
    /** Explicit actor-attributed terminal Workflow Execution cancellation. */
    cancellationJson: text("cancellation_json"),
  },
  (table) => [
    primaryKey({ name: "workflow_executions_pk", columns: [table.id] }),
    index("workflow_executions_reuse").on(
      table.outcome,
      table.reusedExecutionId,
    ),
    index("workflow_executions_accepted_asset").on(table.acceptedAssetId),
    index("workflow_executions_automation_running").on(
      table.automationIntentId,
      table.status,
    ),
  ],
);

export const sourceRecords = sqliteTable(
  "source_records",
  {
    id: text().notNull(),
    executionId: text("execution_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    mediaType: text("media_type").notNull(),
    acquiredAt: text("acquired_at").notNull(),
    acquisitionJson: text("acquisition_json").notNull(),
    coverageJson: text("coverage_json").notNull(),
    digest: text().notNull(),
    body: text().notNull(),
    producerJson: text("producer_json"),
  },
  (table) => [
    primaryKey({ name: "source_records_pk", columns: [table.id] }),
    index("source_records_execution").on(table.executionId),
    index("source_records_lineage").on(
      table.sourceIdentity,
      table.nativeAddress,
    ),
  ],
);

export const recognitionProposals = sqliteTable(
  "recognition_proposals",
  {
    id: text().notNull(),
    executionId: text("execution_id").notNull(),
    interpretationJson: text("interpretation_json").notNull(),
    ruleResultsJson: text("rule_results_json").notNull(),
  },
  (table) => [
    primaryKey({ name: "recognition_proposals_pk", columns: [table.id] }),
    index("recognition_proposals_execution").on(table.executionId),
  ],
);

export const entities = sqliteTable(
  "entities",
  {
    id: text().notNull(),
    kind: text().notNull(),
  },
  (table) => [primaryKey({ name: "entities_pk", columns: [table.id] })],
);

export const sourceAssociations = sqliteTable(
  "source_associations",
  {
    id: text().notNull(),
    subjectId: text("subject_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    proposalId: text("proposal_id").notNull(),
    isCurrent: integer("is_current").notNull().default(1),
  },
  (table) => [
    primaryKey({ name: "source_associations_pk", columns: [table.id] }),
    index("source_associations_subject").on(table.subjectId),
    index("source_associations_address").on(
      table.sourceIdentity,
      table.nativeAddress,
    ),
  ],
);

export const recognitionDecisions = sqliteTable(
  "recognition_decisions",
  {
    id: text().notNull(),
    proposalId: text("proposal_id").notNull(),
    assetId: text("asset_id").notNull(),
    acceptedRuleResultsJson: text("accepted_rule_results_json").notNull(),
  },
  (table) => [
    primaryKey({ name: "recognition_decisions_pk", columns: [table.id] }),
    uniqueIndex("recognition_decisions_proposal").on(table.proposalId),
    index("recognition_decisions_asset").on(table.assetId),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  { id: text().notNull() },
  (table) => [primaryKey({ name: "artifacts_pk", columns: [table.id] })],
);

export const locations = sqliteTable(
  "locations",
  {
    id: text().notNull(),
    artifactId: text("artifact_id").notNull(),
    address: text().notNull(),
    kind: text().notNull(),
  },
  (table) => [
    primaryKey({ name: "locations_pk", columns: [table.id] }),
    index("locations_artifact").on(table.artifactId),
    index("locations_address").on(table.address),
  ],
);

export const blobs = sqliteTable(
  "blobs",
  {
    digest: text().notNull(),
    mediaType: text("media_type").notNull(),
    byteLength: integer("byte_length").notNull(),
  },
  (table) => [primaryKey({ name: "blobs_pk", columns: [table.digest] })],
);

export const artifactRevisions = sqliteTable(
  "artifact_revisions",
  {
    id: text().notNull(),
    artifactId: text("artifact_id").notNull(),
    blobDigest: text("blob_digest").notNull(),
    producerJson: text("producer_json"),
  },
  (table) => [
    primaryKey({ name: "artifact_revisions_pk", columns: [table.id] }),
    index("artifact_revisions_artifact").on(table.artifactId),
    index("artifact_revisions_blob").on(table.blobDigest),
  ],
);

export const artifactAssociations = sqliteTable(
  "artifact_associations",
  {
    id: text().notNull(),
    subjectId: text("subject_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    role: text().notNull(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull().default("[]"),
    observedArtifactPartJson: text("observed_artifact_part_json"),
    producerJson: text("producer_json"),
    sourceAssociationId: text("source_association_id"),
  },
  (table) => [
    primaryKey({ name: "artifact_associations_pk", columns: [table.id] }),
    index("artifact_associations_subject").on(table.subjectId),
    index("artifact_associations_source_association_role").on(
      table.subjectId,
      table.sourceAssociationId,
      table.role,
    ),
  ],
);

export const metadataAssertions = sqliteTable(
  "metadata_assertions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    subjectId: text("subject_id").notNull(),
    property: text().notNull(),
    value: text().notNull(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull(),
    isCurrent: integer("is_current").notNull().default(1),
    sourceSlot: text("source_slot"),
    observedArtifactPartJson: text("observed_artifact_part_json"),
    qualifiersJson: text("qualifiers_json").notNull().default("[]"),
    producerJson: text("producer_json"),
  },
  (table) => [
    index("metadata_assertions_subject_property").on(
      table.subjectId,
      table.property,
    ),
  ],
);

export const sourcedEntities = sqliteTable(
  "sourced_entities",
  {
    id: text().notNull(),
    sourceIdentity: text("source_identity").notNull(),
    sourceKey: text("source_key").notNull(),
    identityNamespace: text("identity_namespace").notNull(),
    label: text().notNull(),
    role: text(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull(),
    producerJson: text("producer_json"),
  },
  (table) => [
    primaryKey({ name: "sourced_entities_pk", columns: [table.id] }),
    uniqueIndex("sourced_entities_exact_identity").on(
      table.sourceIdentity,
      table.identityNamespace,
      table.sourceKey,
    ),
  ],
);

export const entityRelationships = sqliteTable(
  "entity_relationships",
  {
    id: text().notNull(),
    subjectId: text("subject_id").notNull(),
    participantId: text("participant_id").notNull(),
    type: text().notNull(),
    role: text().notNull(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull(),
    isCurrent: integer("is_current").notNull().default(1),
    qualifiersJson: text("qualifiers_json").notNull().default("[]"),
    producerJson: text("producer_json"),
  },
  (table) => [
    primaryKey({ name: "entity_relationships_pk", columns: [table.id] }),
    index("entity_relationships_subject").on(table.subjectId),
    index("entity_relationships_participant").on(table.participantId),
    index("entity_relationships_subject_type").on(table.subjectId, table.type),
  ],
);

export const entityMentions = sqliteTable(
  "entity_mentions",
  {
    id: text().notNull(),
    sourceIdentity: text("source_identity").notNull(),
    field: text().notNull(),
    role: text().notNull(),
    label: text().notNull(),
    identityNamespace: text("identity_namespace").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull(),
    producerJson: text("producer_json"),
  },
  (table) => [
    primaryKey({ name: "entity_mentions_pk", columns: [table.id] }),
    index("entity_mentions_source_key").on(
      table.sourceIdentity,
      table.sourceKey,
    ),
  ],
);

export const entityResolutionDecisions = sqliteTable(
  "entity_resolution_decisions",
  {
    id: text().notNull(),
    mentionId: text("mention_id").notNull(),
    entityId: text("entity_id").notNull(),
    rule: text().notNull(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull(),
    producerJson: text("producer_json"),
  },
  (table) => [
    primaryKey({ name: "entity_resolution_decisions_pk", columns: [table.id] }),
    index("entity_resolution_decisions_mention").on(table.mentionId),
    index("entity_resolution_decisions_entity").on(table.entityId),
  ],
);

/** The compare-and-append head for one exact source coverage coordinate. */
export const sourceLineageHeads = sqliteTable(
  "source_lineage_heads",
  {
    subjectId: text("subject_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    coverageId: text("coverage_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.subjectId,
        table.sourceIdentity,
        table.nativeAddress,
        table.coverageId,
      ],
    }),
    index("source_lineage_heads_record").on(table.sourceRecordId),
  ],
);

export const sourceRefreshChanges = sqliteTable(
  "source_refresh_changes",
  {
    id: text().notNull(),
    executionId: text("execution_id").notNull(),
    subjectId: text("subject_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    coverageId: text("coverage_id").notNull(),
    baselineSourceRecordId: text("baseline_source_record_id"),
    sourceRecordId: text("source_record_id").notNull(),
    completeness: text().notNull(),
  },
  (table) => [
    primaryKey({ name: "source_refresh_changes_pk", columns: [table.id] }),
    index("source_refresh_changes_execution").on(table.executionId),
    index("source_refresh_changes_scope").on(
      table.subjectId,
      table.sourceIdentity,
      table.nativeAddress,
      table.coverageId,
    ),
  ],
);

export const changeImpactPreviews = sqliteTable(
  "change_impact_previews",
  {
    id: text().notNull(),
    executionId: text("execution_id").notNull(),
    assetId: text("asset_id").notNull(),
    previewJson: text("preview_json").notNull(),
    status: text().generatedAlwaysAs(
      sql`json_extract(preview_json, '$.status')`,
      { mode: "virtual" },
    ),
  },
  (table) => [
    primaryKey({ name: "change_impact_previews_pk", columns: [table.id] }),
    index("change_impact_previews_execution").on(table.executionId),
    index("change_impact_previews_asset").on(table.assetId),
    index("change_impact_previews_status").on(table.status),
  ],
);

export const automationIntents = sqliteTable(
  "automation_intents",
  {
    id: text().notNull(),
    scopeJson: text("scope_json").notNull(),
    enabled: integer().notNull(),
    disabledReason: text("disabled_reason"),
    intervalMilliseconds: integer("interval_milliseconds").notNull(),
    workflowInputVersion: text("workflow_input_version").notNull(),
    policyReferencesJson: text("policy_references_json").notNull(),
    acceptTrusted: integer("accept_trusted").notNull(),
    runInitial: integer("run_initial").notNull().default(1),
  },
  (table) => [
    primaryKey({ name: "automation_intents_pk", columns: [table.id] }),
  ],
);

export const automationRuntime = sqliteTable(
  "automation_runtime",
  {
    intentId: text("intent_id").notNull(),
    activeExecutionId: text("active_execution_id"),
    lastAutomaticTriggerAt: text("last_automatic_trigger_at"),
  },
  (table) => [
    primaryKey({ name: "automation_runtime_pk", columns: [table.intentId] }),
  ],
);

/** Application configuration; deliberately independent of Automation Intent. */
export const observedRootRegistrations = sqliteTable(
  "observed_root_registrations",
  {
    id: text().notNull(),
    displayName: text("display_name").notNull(),
    containerPath: text("container_path").notNull(),
    canonicalPath: text("canonical_path").notNull(),
    status: text().notNull(),
    configVersion: integer("config_version").notNull(),
    readOnly: integer("read_only").notNull(),
    symlinkMode: text("symlink_mode").notNull(),
    allowedTargetRootIdsJson: text("allowed_target_root_ids_json").notNull(),
  },
  (table) => [
    primaryKey({ name: "observed_root_registrations_pk", columns: [table.id] }),
    index("observed_root_registrations_container_path").on(table.containerPath),
    index("observed_root_registrations_canonical_path").on(table.canonicalPath),
    index("observed_root_registrations_status").on(table.status),
  ],
);

/** One current recognition authority for each accepted subject. */
export const sourceAssociationHeads = sqliteTable(
  "source_association_heads",
  {
    subjectId: text("subject_id").notNull(),
    associationId: text("association_id").notNull(),
    recognitionDecisionId: text("recognition_decision_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "source_association_heads_pk",
      columns: [table.subjectId],
    }),
  ],
);

export const recognitionDecisionSupersessions = sqliteTable(
  "recognition_decision_supersessions",
  {
    id: text().notNull(),
    predecessorDecisionId: text("predecessor_decision_id").notNull(),
    successorDecisionId: text("successor_decision_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "recognition_decision_supersessions_pk",
      columns: [table.id],
    }),
    uniqueIndex("recognition_decision_supersessions_predecessor").on(
      table.predecessorDecisionId,
    ),
    uniqueIndex("recognition_decision_supersessions_successor").on(
      table.successorDecisionId,
    ),
  ],
);

export const metadataAssertionSources = sqliteTable(
  "metadata_assertion_sources",
  {
    assertionId: integer("assertion_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.assertionId, table.sourceRecordId] }),
  ],
);

/** Source slot continuity makes metadata supersession auditable and atomic. */
export const metadataAssertionLifecycles = sqliteTable(
  "metadata_assertion_lifecycles",
  {
    assertionId: explicitlyRequiredInteger("assertion_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    coverageId: text("coverage_id").notNull(),
    sourceSlot: text("source_slot").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    predecessorAssertionId: integer("predecessor_assertion_id"),
  },
  (table) => [
    primaryKey({
      name: "metadata_assertion_lifecycles_pk",
      columns: [table.assertionId],
    }),
    index("metadata_assertion_lifecycles_scope_slot").on(
      table.sourceIdentity,
      table.nativeAddress,
      table.coverageId,
      table.sourceSlot,
    ),
    uniqueIndex("metadata_assertion_lifecycles_predecessor").on(
      table.predecessorAssertionId,
    ),
  ],
);

export const metadataAssertionRetractions = sqliteTable(
  "metadata_assertion_retractions",
  {
    id: text().notNull(),
    assertionId: integer("assertion_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "metadata_assertion_retractions_pk",
      columns: [table.id],
    }),
    uniqueIndex("metadata_assertion_retractions_assertion").on(
      table.assertionId,
    ),
  ],
);

export const relationshipSources = sqliteTable(
  "relationship_sources",
  {
    relationshipId: text("relationship_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.relationshipId, table.sourceRecordId] }),
  ],
);

export const relationshipLifecycles = sqliteTable(
  "relationship_lifecycles",
  {
    relationshipId: text("relationship_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    coverageId: text("coverage_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    sourceSlot: text("source_slot").notNull().default(""),
    predecessorRelationshipId: text("predecessor_relationship_id"),
  },
  (table) => [
    primaryKey({
      name: "relationship_lifecycles_pk",
      columns: [table.relationshipId],
    }),
    index("relationship_lifecycles_scope_slot").on(
      table.sourceIdentity,
      table.nativeAddress,
      table.coverageId,
      table.sourceSlot,
    ),
    uniqueIndex("relationship_lifecycles_predecessor").on(
      table.predecessorRelationshipId,
    ),
  ],
);

export const relationshipRetractions = sqliteTable(
  "relationship_retractions",
  {
    id: text().notNull(),
    relationshipId: text("relationship_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
  },
  (table) => [
    primaryKey({ name: "relationship_retractions_pk", columns: [table.id] }),
    uniqueIndex("relationship_retractions_relationship").on(
      table.relationshipId,
    ),
  ],
);

export const artifactAssociationSupersessions = sqliteTable(
  "artifact_association_supersessions",
  {
    id: text().notNull(),
    predecessorAssociationId: text("predecessor_association_id").notNull(),
    successorAssociationId: text("successor_association_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "artifact_association_supersessions_pk",
      columns: [table.id],
    }),
    uniqueIndex("artifact_association_supersessions_predecessor").on(
      table.predecessorAssociationId,
    ),
    uniqueIndex("artifact_association_supersessions_successor").on(
      table.successorAssociationId,
    ),
  ],
);

export const artifactAssociationRetractions = sqliteTable(
  "artifact_association_retractions",
  {
    id: text().notNull(),
    associationId: text("association_id").notNull(),
    recognitionDecisionId: text("recognition_decision_id"),
    proposalId: text("proposal_id"),
    sourceRecordIdsJson: text("source_record_ids_json").notNull().default("[]"),
  },
  (table) => [
    primaryKey({
      name: "artifact_association_retractions_pk",
      columns: [table.id],
    }),
    uniqueIndex("artifact_association_retractions_association").on(
      table.associationId,
    ),
  ],
);

export const currentSourceAssociations = sqliteTable(
  "current_source_associations",
  {
    subjectId: text("subject_id").notNull(),
    associationId: text("association_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subjectId, table.associationId] })],
);

export const metadataPolicyEnrollments = sqliteTable(
  "metadata_policy_enrollments",
  {
    subjectId: text("subject_id").notNull(),
    policyId: text("policy_id").notNull(),
    executionId: text("execution_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subjectId, table.policyId] })],
);

/** Domain-owned Source Refresh Run authority; executions retain only IDs. */
export const sourceRefreshRuns = sqliteTable(
  "source_refresh_runs",
  {
    id: text().notNull(),
    workflowExecutionId: text("workflow_execution_id").notNull(),
    initiatedBy: text("initiated_by").notNull(),
    initiatedAt: text("initiated_at").notNull(),
    requestedSelectionJson: text("requested_selection_json").notNull(),
    reviewPolicy: text("review_policy").notNull(),
  },
  (table) => [
    primaryKey({ name: "source_refresh_runs_pk", columns: [table.id] }),
    index("source_refresh_runs_execution").on(table.workflowExecutionId),
  ],
);

export const sourceRefreshScopes = sqliteTable(
  "source_refresh_scopes",
  {
    runId: text("run_id").notNull(),
    ordinal: integer().notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    coverageId: text("coverage_id").notNull(),
    baselineSourceRecordId: text("baseline_source_record_id"),
    state: text().notNull(),
    changeSetId: text("change_set_id"),
    candidateSourceRecordId: text("candidate_source_record_id"),
    outcome: text(),
    reason: text(),
    acquisitionAttempt: integer("acquisition_attempt").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [
        table.runId,
        table.sourceIdentity,
        table.nativeAddress,
        table.coverageId,
      ],
    }),
    index("source_refresh_scopes_run_ordinal").on(table.runId, table.ordinal),
  ],
);

export const sourceRefreshChangeSets = sqliteTable(
  "source_refresh_change_sets",
  {
    id: text().notNull(),
    runId: text("run_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    coverageId: text("coverage_id").notNull(),
    baselineSourceRecordId: text("baseline_source_record_id"),
    candidateSourceRecordId: text("candidate_source_record_id").notNull(),
    changesJson: text("changes_json").notNull(),
    interpretationJson: text("interpretation_json").notNull(),
    requiresReview: integer("requires_review").notNull(),
    disposition: text().notNull(),
  },
  (table) => [
    primaryKey({ name: "source_refresh_change_sets_pk", columns: [table.id] }),
    uniqueIndex("source_refresh_change_sets_scope").on(
      table.runId,
      table.sourceIdentity,
      table.nativeAddress,
      table.coverageId,
    ),
    index("source_refresh_change_sets_run").on(table.runId),
  ],
);

/** Current source-artifact candidates are tied to one exact source lineage. */
export const currentSourceArtifactCandidateLineages = sqliteTable(
  "current_source_artifact_candidate_lineages",
  {
    subjectId: text("subject_id").notNull(),
    sourceAssociationId: text("source_association_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    coverageId: text("coverage_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    interpretationJson: text("interpretation_json").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.subjectId,
        table.sourceAssociationId,
        table.sourceIdentity,
        table.nativeAddress,
        table.coverageId,
      ],
    }),
    index("current_source_artifact_candidate_lineages_current").on(
      table.subjectId,
      table.sourceAssociationId,
      table.sourceIdentity,
      table.nativeAddress,
      table.sourceRecordId,
    ),
  ],
);

/** The complete schema object passed to the node:sqlite Drizzle query builder. */
export const catalogueSchema = {
  schemaMigrations,
  workflowExecutions,
  sourceRecords,
  recognitionProposals,
  entities,
  sourceAssociations,
  recognitionDecisions,
  artifacts,
  locations,
  blobs,
  artifactRevisions,
  artifactAssociations,
  metadataAssertions,
  sourcedEntities,
  entityRelationships,
  entityMentions,
  entityResolutionDecisions,
  sourceLineageHeads,
  sourceRefreshChanges,
  changeImpactPreviews,
  automationIntents,
  automationRuntime,
  observedRootRegistrations,
  sourceAssociationHeads,
  recognitionDecisionSupersessions,
  metadataAssertionSources,
  metadataAssertionLifecycles,
  metadataAssertionRetractions,
  relationshipSources,
  relationshipLifecycles,
  relationshipRetractions,
  artifactAssociationSupersessions,
  artifactAssociationRetractions,
  currentSourceAssociations,
  metadataPolicyEnrollments,
  sourceRefreshRuns,
  sourceRefreshScopes,
  sourceRefreshChangeSets,
  currentSourceArtifactCandidateLineages,
} as const;
