import { sql } from "drizzle-orm";
import {
  customType,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Drizzle Kit 刻意在每个单列 INTEGER 主键上省略 `.notNull()`，因为 SQLite 通常隐含
// 该约束。这个历史表明确使用 `INTEGER PRIMARY KEY NOT NULL`；把约束放进已审阅物理
// 类型片段，以保留可观察 SQLite 契约。
const explicitlyRequiredInteger = customType<{
  data: number;
  driverData: number;
}>({
  dataType: () => "INTEGER NOT NULL",
});

/**
 * 每个整体保留的持久载荷都携带稳定格式坐标。Drizzle 适配器持有其当前读写形状；历史
 * 载荷版本保留为明确数据，而不是运行时迁移兼容路径。
 */
export type VersionedJson<T = unknown> = {
  readonly version: string;
  readonly payload: T;
};

export const workflowExecutionAuditVersion = "workflow-execution-audit/1";
/**
 * 短期预发布 0031 形状写入的兼容标记。真实 0031 升级让历史行保持 NULL；新的生产
 * 写入始终以完整版本化执行载荷替换该坐标。
 */
export const workflowExecutionAuditLegacyMarker = JSON.stringify({
  version: workflowExecutionAuditVersion,
  payload: {},
});

/**
 * 已审阅的完整 Catalogue 结构。它刻意与基础设施适配器并置：领域、Application、
 * Presentation 和交付层只导入各自的用例契约。
 *
 * 该清单必须完整。`schema_migrations` 保留为历史物理账本，使已审阅既有 Catalogue
 * 保持形状，但 `SqliteCatalogue` 绝不读写它。正式生成迁移的就绪权威刻意位于该适配器之外。
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
    /** 为重启安全资产刷新保留的完整非秘密输入。 */
    workflowInputJson: text("workflow_input_json"),
    /** 明确归因于行为主体的终态工作流执行取消。 */
    cancellationJson: text("cancellation_json"),
    /** 新识别原子接受前可跨中断恢复的预分配主体身份。 */
    plannedAssetId: text("planned_asset_id"),
    /** 观察材料关联的版本化输入、检查点与终态审计。 */
    materialAssociationJson: text("material_association_json"),
    /** 来源关联决定的严格版本化检查点。 */
    sourceAssociationDecisionJson: text("source_association_decision_json"),
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
    basisJson: text("basis_json").notNull(),
    ruleResultsJson: text("rule_results_json").notNull(),
    /** candidate 与观察 Revision 必须作为一个不可变解释整体保存。 */
    observedMaterialInterpretationJson: text(
      "observed_material_interpretation_json",
    ),
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
  },
  (table) => [primaryKey({ name: "entities_pk", columns: [table.id] })],
);

/** 来源和人工种类断言都是事实；实体本身刻意没有判别列。 */
export const entityKindAssertions = sqliteTable(
  "entity_kind_assertions",
  {
    id: text().notNull(),
    entityId: text("entity_id").notNull(),
    kind: text().notNull(),
    basis: text().notNull(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull().default("[]"),
    actorId: text("actor_id"),
    producerJson: text("producer_json"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("entity_kind_assertions_entity").on(table.entityId),
    check(
      "entity_kind_assertions_kind",
      sql`kind IN ('digital-asset', 'person', 'persona')`,
    ),
  ],
);

export const entityKindDecisions = sqliteTable(
  "entity_kind_decisions",
  {
    id: text().notNull(),
    entityId: text("entity_id").notNull(),
    selectedKind: text("selected_kind"),
    basis: text().notNull(),
    replacesDecisionId: text("replaces_decision_id"),
    actorId: text("actor_id"),
    operation: text().notNull().default("select"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("entity_kind_decisions_entity").on(table.entityId),
    check(
      "entity_kind_decisions_kind",
      sql`selected_kind IS NULL OR selected_kind IN ('digital-asset', 'person', 'persona')`,
    ),
  ],
);

/** 本地实体无需外部身份也可被明确寻址。 */
export const localEntityNames = sqliteTable(
  "local_entity_names",
  {
    entityId: text("entity_id").notNull(),
    label: text().notNull(),
    actorId: text("actor_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entityId] }),
    index("local_entity_names_label").on(table.label),
  ],
);

/** 本地身份提交的窄幂等坐标；后续种类决定绝不改变原提交内容。 */
export const localEntityCommitments = sqliteTable(
  "local_entity_commitments",
  {
    actorId: text("actor_id").notNull(),
    commitmentId: text("commitment_id").notNull(),
    entityId: text("entity_id").notNull(),
    label: text().notNull(),
    submittedKind: text("submitted_kind").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.actorId, table.commitmentId] }),
    check(
      "local_entity_commitments_kind",
      sql`submitted_kind IN ('entity', 'person', 'persona')`,
    ),
  ],
);

/** 来源实体种类的不可变支持；当前性由每个谱系的末叶投影。 */
export const entityKindSourceSupports = sqliteTable(
  "entity_kind_source_supports",
  {
    id: text().notNull(),
    entityId: text("entity_id").notNull(),
    sourceSubjectId: text("source_subject_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
    coverageId: text("coverage_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    assertionId: text("assertion_id"),
    predecessorId: text("predecessor_id"),
    operation: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("entity_kind_source_support_predecessor").on(
      table.predecessorId,
    ),
    index("entity_kind_source_support_scope").on(
      table.entityId,
      table.sourceSubjectId,
      table.sourceIdentity,
      table.nativeAddress,
      table.coverageId,
    ),
    check(
      "entity_kind_source_support_operation",
      sql`operation IN ('assert', 'retract')`,
    ),
  ],
);

/** 当前部署的单一本地用户注册；它只承载操作归属与交互状态。 */
export const localUsers = sqliteTable(
  "local_users",
  {
    userId: text("user_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId] })],
);

export const sourceAssociations = sqliteTable(
  "source_associations",
  {
    id: text().notNull(),
    subjectId: text("subject_id").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    nativeAddress: text("native_address").notNull(),
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

export const sourceAssociationChangeProposals = sqliteTable(
  "source_association_change_proposals",
  {
    id: text().notNull(),
    subjectId: text("subject_id").notNull(),
    kind: text().notNull(),
    payloadJson: text("payload_json").notNull(),
    proposedByJson: text("proposed_by_json").notNull(),
    evidenceJson: text("evidence_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    check(
      "source_association_change_proposals_kind",
      sql`kind IN ('establish', 'replace', 'retract')`,
    ),
  ],
);

export const sourceAssociationDecisions = sqliteTable(
  "source_association_decisions",
  {
    id: text().notNull(),
    proposalId: text("proposal_id").notNull(),
    subjectId: text("subject_id").notNull(),
    decidedByKind: text("decided_by_kind").notNull(),
    decidedByCoordinate: text("decided_by_coordinate").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("source_association_decisions_proposal").on(table.proposalId),
    foreignKey({
      columns: [table.proposalId],
      foreignColumns: [sourceAssociationChangeProposals.id],
    }),
    check(
      "source_association_decisions_authority_kind",
      sql`decided_by_kind IN ('user', 'application-policy')`,
    ),
  ],
);

export const sourceAssociationEstablishmentSupports = sqliteTable(
  "source_association_establishment_supports",
  {
    associationId: text("association_id").notNull(),
    recognitionDecisionId: text("recognition_decision_id"),
    sourceAssociationDecisionId: text("source_association_decision_id"),
  },
  (table) => [
    primaryKey({ columns: [table.associationId] }),
    foreignKey({
      columns: [table.associationId],
      foreignColumns: [sourceAssociations.id],
    }),
    foreignKey({
      columns: [table.recognitionDecisionId],
      foreignColumns: [recognitionDecisions.id],
    }),
    foreignKey({
      columns: [table.sourceAssociationDecisionId],
      foreignColumns: [sourceAssociationDecisions.id],
    }),
    check(
      "source_association_establishment_supports_exactly_one",
      sql`(recognition_decision_id IS NOT NULL) <> (source_association_decision_id IS NOT NULL)`,
    ),
  ],
);

export const sourceAssociationSupersessions = sqliteTable(
  "source_association_supersessions",
  {
    id: text().notNull(),
    predecessorAssociationId: text("predecessor_association_id").notNull(),
    successorAssociationId: text("successor_association_id").notNull(),
    sourceAssociationDecisionId: text("source_association_decision_id"),
    recognitionDecisionId: text("recognition_decision_id"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("source_association_supersessions_predecessor").on(
      table.predecessorAssociationId,
    ),
    uniqueIndex("source_association_supersessions_successor").on(
      table.successorAssociationId,
    ),
    foreignKey({
      columns: [table.predecessorAssociationId],
      foreignColumns: [sourceAssociations.id],
    }),
    foreignKey({
      columns: [table.successorAssociationId],
      foreignColumns: [sourceAssociations.id],
    }),
    foreignKey({
      columns: [table.sourceAssociationDecisionId],
      foreignColumns: [sourceAssociationDecisions.id],
    }),
    foreignKey({
      columns: [table.recognitionDecisionId],
      foreignColumns: [recognitionDecisions.id],
    }),
    check(
      "source_association_supersessions_exactly_one",
      sql`(source_association_decision_id IS NOT NULL) <> (recognition_decision_id IS NOT NULL)`,
    ),
  ],
);

export const sourceAssociationRetractions = sqliteTable(
  "source_association_retractions",
  {
    id: text().notNull(),
    associationId: text("association_id").notNull(),
    sourceAssociationDecisionId: text("source_association_decision_id"),
    recognitionDecisionSupersessionId: text(
      "recognition_decision_supersession_id",
    ),
    recognitionDecisionRetractionId: text("recognition_decision_retraction_id"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("source_association_retractions_association").on(
      table.associationId,
    ),
    foreignKey({
      columns: [table.associationId],
      foreignColumns: [sourceAssociations.id],
    }),
    foreignKey({
      columns: [table.sourceAssociationDecisionId],
      foreignColumns: [sourceAssociationDecisions.id],
    }),
    foreignKey({
      columns: [table.recognitionDecisionSupersessionId],
      foreignColumns: [recognitionDecisionSupersessions.id],
    }),
    foreignKey({
      columns: [table.recognitionDecisionRetractionId],
      foreignColumns: [recognitionDecisionRetractions.id],
    }),
    check(
      "source_association_retractions_exactly_one",
      sql`(source_association_decision_id IS NOT NULL) + (recognition_decision_supersession_id IS NOT NULL) + (recognition_decision_retraction_id IS NOT NULL) = 1`,
    ),
  ],
);

export const sourceAssociationLegacyRetirements = sqliteTable(
  "source_association_legacy_retirements",
  {
    associationId: text("association_id").notNull(),
    migrationId: text("migration_id").notNull(),
    basis: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.associationId] }),
    foreignKey({
      columns: [table.associationId],
      foreignColumns: [sourceAssociations.id],
    }),
    check(
      "source_association_legacy_retirements_basis",
      sql`basis = 'legacy-current-projection'`,
    ),
  ],
);

export const recognitionDecisionRetractions = sqliteTable(
  "recognition_decision_retractions",
  {
    id: text().notNull(),
    predecessorDecisionId: text("predecessor_decision_id").notNull(),
    proposedBy: text("proposed_by").notNull(),
    decidedBy: text("decided_by").notNull(),
    reason: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("recognition_decision_retractions_predecessor").on(
      table.predecessorDecisionId,
    ),
    foreignKey({
      columns: [table.predecessorDecisionId],
      foreignColumns: [recognitionDecisions.id],
    }),
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

/** 当前用户对精确产物修订版的播放状态。 */
export const artifactInteractionStates = sqliteTable(
  "artifact_interaction_states",
  {
    userId: text("user_id").notNull(),
    revisionId: text("revision_id").notNull(),
    positionMilliseconds: integer("position_milliseconds").notNull(),
    completed: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.revisionId] }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [localUsers.userId],
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [artifactRevisions.id],
    }),
    check(
      "artifact_interaction_states_position",
      sql`position_milliseconds >= 0`,
    ),
    check("artifact_interaction_states_completed", sql`completed IN (0, 1)`),
    index("artifact_interaction_states_revision").on(table.revisionId),
  ],
);

/** 渐进确认把普通修订版证据绑定到当时已有的观察；它不是选择 token 或授权状态。 */
export const observedRevisionConfirmations = sqliteTable(
  "observed_revision_confirmations",
  {
    revisionId: text("revision_id").notNull(),
    locationId: text("location_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    observedAt: text("observed_at").notNull(),
    size: integer().notNull(),
    modifiedAt: text("modified_at").notNull(),
    conditionalBaseline: text("conditional_baseline").notNull(),
  },
  (table) => [
    primaryKey({
      name: "observed_revision_confirmations_pk",
      columns: [table.revisionId, table.locationId],
    }),
    index("observed_revision_confirmations_revision").on(table.revisionId),
    index("observed_revision_confirmations_location").on(table.locationId),
  ],
);

/** 普通刷新维护的当前位置观察投影；不是 selection/token/session 状态。 */
export const currentFileObservations = sqliteTable(
  "current_file_observations",
  {
    locationId: text("location_id").notNull(),
    address: text().notNull(),
    snapshotId: text("snapshot_id").notNull(),
    observedAt: text("observed_at").notNull(),
    size: integer().notNull(),
    modifiedAt: text("modified_at").notNull(),
    conditionalBaseline: text("conditional_baseline").notNull(),
  },
  (table) => [
    primaryKey({
      name: "current_file_observations_pk",
      columns: [table.locationId],
    }),
    index("current_file_observations_snapshot").on(table.snapshotId),
    uniqueIndex("current_file_observations_address").on(table.address),
  ],
);

/** 每次成功扫描对当前位置的登记权威支持；同一位置可由重叠根独立支持。 */
export const currentFileObservationSupports = sqliteTable(
  "current_file_observation_supports",
  {
    locationId: text("location_id").notNull(),
    observedRootId: text("observed_root_id").notNull(),
    observedRootVersion: integer("observed_root_version").notNull(),
    observedRootPath: text("observed_root_path").notNull(),
    authorizedTargetsJson: text("authorized_targets_json")
      .notNull()
      .default("[]"),
  },
  (table) => [
    primaryKey({
      name: "current_file_observation_supports_pk",
      columns: [
        table.locationId,
        table.observedRootId,
        table.observedRootVersion,
      ],
    }),
    index("current_file_observation_supports_root").on(
      table.observedRootId,
      table.observedRootVersion,
    ),
  ],
);

/** Blob 级持久分帧证明坐标；sidecar 字节本身位于 product-data proof store。 */
export const artifactContentProofs = sqliteTable(
  "artifact_content_proofs",
  {
    blobDigest: text("blob_digest").notNull(),
    scheme: text().notNull(),
    byteLength: integer("byte_length").notNull(),
    frameSize: integer("frame_size").notNull(),
    frameCount: integer("frame_count").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
  },
  (table) => [
    primaryKey({
      name: "artifact_content_proofs_pk",
      columns: [table.blobDigest],
    }),
    uniqueIndex("artifact_content_proofs_manifest").on(table.manifestDigest),
    check(
      "artifact_content_proofs_scheme",
      sql`scheme = 'artifact-frame-manifest/1'`,
    ),
    check("artifact_content_proofs_frame_size", sql`frame_size = 1048576`),
    check("artifact_content_proofs_length", sql`byte_length >= 0`),
    check(
      "artifact_content_proofs_count",
      sql`frame_count = (byte_length + 1048575) / 1048576`,
    ),
    check(
      "artifact_content_proofs_blob_digest",
      sql`length(blob_digest) = 64 AND blob_digest NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "artifact_content_proofs_manifest_digest",
      sql`length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
);

export const artifactAssociations = sqliteTable(
  "artifact_associations",
  {
    id: text().notNull(),
    targetKind: text("target_kind").notNull(),
    targetEntityId: text("target_entity_id"),
    targetArtifactId: text("target_artifact_id"),
    targetRevisionId: text("target_revision_id"),
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
    check(
      "artifact_associations_target",
      sql.raw(
        "(target_kind = 'entity' AND target_entity_id IS NOT NULL AND target_artifact_id IS NULL AND target_revision_id IS NULL) OR (target_kind = 'artifact-revision' AND target_entity_id IS NULL AND target_artifact_id IS NOT NULL AND target_revision_id IS NOT NULL)",
      ),
    ),
    index("artifact_associations_subject").on(table.subjectId),
    index("artifact_associations_source_association_role").on(
      table.subjectId,
      table.sourceAssociationId,
      table.role,
    ),
  ],
);

export const artifactAssociationRecognitionSupports = sqliteTable(
  "artifact_association_recognition_supports",
  {
    associationId: text("association_id").notNull(),
    recognitionDecisionId: text("recognition_decision_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "artifact_association_recognition_supports_pk",
      columns: [table.associationId, table.recognitionDecisionId],
    }),
    index("artifact_association_recognition_supports_decision").on(
      table.recognitionDecisionId,
    ),
  ],
);

export const metadataAssertions = sqliteTable(
  "metadata_assertions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    targetKind: text("target_kind").notNull(),
    targetEntityId: text("target_entity_id"),
    targetArtifactId: text("target_artifact_id"),
    targetRevisionId: text("target_revision_id"),
    subjectId: text("subject_id").notNull(),
    property: text().notNull(),
    value: text().notNull(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull(),
    isCurrent: integer("is_current").notNull().default(1),
    sourceSlot: text("source_slot"),
    observedArtifactPartJson: text("observed_artifact_part_json"),
    qualifiersJson: text("qualifiers_json").notNull().default("[]"),
    producerJson: text("producer_json"),
    authoredByJson: text("authored_by_json"),
    recognitionDecisionId: text("recognition_decision_id"),
  },
  (table) => [
    check(
      "metadata_assertions_target",
      sql.raw(
        "(target_kind = 'entity' AND target_entity_id IS NOT NULL AND target_artifact_id IS NULL AND target_revision_id IS NULL) OR (target_kind = 'artifact-revision' AND target_entity_id IS NULL AND target_artifact_id IS NOT NULL AND target_revision_id IS NOT NULL)",
      ),
    ),
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
    type: text().notNull(),
    participantsJson: text("participants_json").notNull(),
    sourceRecordIdsJson: text("source_record_ids_json").notNull(),
    qualifiersJson: text("qualifiers_json").notNull().default("[]"),
    producerJson: text("producer_json"),
  },
  (table) => [
    primaryKey({ name: "entity_relationships_pk", columns: [table.id] }),
  ],
);

export const entityRelationshipParticipants = sqliteTable(
  "entity_relationship_participants",
  {
    relationshipId: text("relationship_id").notNull(),
    entityId: text("entity_id").notNull(),
    role: text().notNull(),
    mentionIdsJson: text("mention_ids_json").notNull().default("[]"),
  },
  (table) => [
    primaryKey({
      name: "entity_relationship_participants_pk",
      columns: [table.relationshipId, table.entityId, table.role],
    }),
    index("entity_relationship_participants_entity").on(table.entityId),
    index("entity_relationship_participants_relationship").on(
      table.relationshipId,
    ),
  ],
);

/** 仅追加的人工关系决定；决定头按稳定支持范围指向当前决定，来源事实保持不变。 */
export const relationshipDecisions = sqliteTable(
  "relationship_decisions",
  {
    id: text().notNull(),
    targetJson: text("target_json").notNull(),
    kind: text().notNull(),
    definitionId: text("definition_id"),
    manualRelationshipId: text("manual_relationship_id"),
    actorId: text("actor_id").notNull(),
  },
  (table) => [
    primaryKey({ name: "relationship_decisions_pk", columns: [table.id] }),
  ],
);

export const relationshipDecisionHeads = sqliteTable(
  "relationship_decision_heads",
  {
    targetKey: text("target_key").notNull(),
    decisionId: text("decision_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "relationship_decision_heads_pk",
      columns: [table.targetKey],
    }),
  ],
);

/** 人工关系是由决定支持的不可变事实，绝不是伪造的来源记录。 */
export const relationshipManualSupports = sqliteTable(
  "relationship_manual_supports",
  {
    relationshipId: text("relationship_id").notNull(),
    decisionId: text("decision_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "relationship_manual_supports_pk",
      columns: [table.relationshipId],
    }),
    index("relationship_manual_supports_decision").on(table.decisionId),
  ],
);

/** 仅追加的相关实体身份合并；事实的原始主体不随之改写。 */
export const entityIdentityMerges = sqliteTable(
  "entity_identity_merges",
  {
    id: text().notNull(),
    retainedEntityId: text("retained_entity_id").notNull(),
    mergedEntityId: text("merged_entity_id").notNull(),
    actorId: text("actor_id").notNull(),
    commitmentId: text("commitment_id").notNull(),
    impactFingerprint: text("impact_fingerprint").notNull(),
  },
  (table) => [
    primaryKey({ name: "entity_identity_merges_pk", columns: [table.id] }),
    uniqueIndex("entity_identity_merges_commitment").on(
      table.actorId,
      table.commitmentId,
    ),
  ],
);

/** 撤销只指向一条精确合并，不回滚后续事实。 */
export const entityIdentityMergeRetractions = sqliteTable(
  "entity_identity_merge_retractions",
  {
    id: text().notNull(),
    mergeId: text("merge_id").notNull(),
    actorId: text("actor_id").notNull(),
    commitmentId: text("commitment_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "entity_identity_merge_retractions_pk",
      columns: [table.id],
    }),
    uniqueIndex("entity_identity_merge_retractions_merge").on(table.mergeId),
    uniqueIndex("entity_identity_merge_retractions_commitment").on(
      table.actorId,
      table.commitmentId,
    ),
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
    basis: text().notNull().default("source"),
    replacesDecisionId: text("replaces_decision_id"),
    actorId: text("actor_id"),
    operation: text().notNull().default("select"),
  },
  (table) => [
    primaryKey({ name: "entity_resolution_decisions_pk", columns: [table.id] }),
    index("entity_resolution_decisions_mention").on(table.mentionId),
    index("entity_resolution_decisions_entity").on(table.entityId),
  ],
);

/** 格式观察产生的本地实体；刻意不借用外部来源身份列。 */
export const observedEntities = sqliteTable(
  "observed_entities",
  {
    id: text().notNull(),
    assetId: text("asset_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    producerJson: text("producer_json").notNull(),
    coverageId: text("coverage_id").notNull(),
    occurrenceSlot: text("occurrence_slot").notNull(),
    preservedValue: text("preserved_value").notNull(),
    label: text().notNull(),
    locator: text().notNull(),
  },
  (table) => [
    primaryKey({ name: "observed_entities_pk", columns: [table.id] }),
    uniqueIndex("observed_entities_local_identity").on(
      table.assetId,
      table.artifactId,
      table.producerJson,
      table.coverageId,
      table.occurrenceSlot,
      table.preservedValue,
    ),
  ],
);

export const observedEntityMentions = sqliteTable(
  "observed_entity_mentions",
  {
    id: text().notNull(),
    entityId: text("entity_id").notNull(),
    revisionId: text("revision_id").notNull(),
    sourceSlot: text("source_slot").notNull(),
    field: text().notNull(),
    role: text().notNull(),
    label: text().notNull(),
    locator: text().notNull(),
  },
  (table) => [
    primaryKey({ name: "observed_entity_mentions_pk", columns: [table.id] }),
    index("observed_entity_mentions_entity").on(table.entityId),
  ],
);

export const observedEntityResolutions = sqliteTable(
  "observed_entity_resolutions",
  {
    mentionId: text("mention_id").notNull(),
    entityId: text("entity_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.mentionId, table.entityId] })],
);

export const observedEntityGraphSupports = sqliteTable(
  "observed_entity_graph_supports",
  {
    id: text().notNull(),
    recognitionDecisionId: text("recognition_decision_id").notNull(),
    assetId: text("asset_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    revisionId: text("revision_id").notNull(),
    producerJson: text("producer_json").notNull(),
    coverageId: text("coverage_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    foreignKey({
      columns: [table.recognitionDecisionId],
      foreignColumns: [recognitionDecisions.id],
    }),
    foreignKey({ columns: [table.assetId], foreignColumns: [entities.id] }),
    foreignKey({ columns: [table.artifactId], foreignColumns: [artifacts.id] }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [artifactRevisions.id],
    }),
    uniqueIndex("observed_entity_graph_supports_exact").on(
      table.recognitionDecisionId,
      table.artifactId,
      table.revisionId,
      table.producerJson,
      table.coverageId,
    ),
    index("observed_entity_graph_supports_current").on(
      table.assetId,
      table.recognitionDecisionId,
    ),
  ],
);

/** 一份观察图精确拥有的实体；同一 Artifact 的不同 revision 绝不共享成员边界。 */
export const observedEntityGraphEntities = sqliteTable(
  "observed_entity_graph_entities",
  {
    graphId: text("graph_id").notNull(),
    entityId: text("entity_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.graphId, table.entityId] }),
    foreignKey({
      columns: [table.graphId],
      foreignColumns: [observedEntityGraphSupports.id],
    }),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [observedEntities.id],
    }),
    index("observed_entity_graph_entities_entity").on(table.entityId),
  ],
);

export const observedEntityGraphRelationships = sqliteTable(
  "observed_entity_graph_relationships",
  {
    graphId: text("graph_id").notNull(),
    relationshipId: text("relationship_id").notNull(),
    sourceSlot: text("source_slot").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.graphId, table.relationshipId] }),
    foreignKey({
      columns: [table.graphId],
      foreignColumns: [observedEntityGraphSupports.id],
    }),
    foreignKey({
      columns: [table.relationshipId],
      foreignColumns: [entityRelationships.id],
    }),
    index("observed_entity_graph_relationships_relationship").on(
      table.relationshipId,
    ),
  ],
);

/** 一个精确来源覆盖坐标的比较并追加头。 */
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

/** Application 配置；刻意独立于自动化意图。 */
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

/** 每个已接受主体对应一个当前识别权威。 */
export const recognitionHeads = sqliteTable(
  "recognition_heads",
  {
    subjectId: text("subject_id").notNull(),
    recognitionDecisionId: text("recognition_decision_id"),
    recognitionSourceAssociationId: text("recognition_source_association_id"),
  },
  (table) => [
    primaryKey({
      name: "recognition_heads_pk",
      columns: [table.subjectId],
    }),
    foreignKey({
      columns: [table.recognitionDecisionId],
      foreignColumns: [recognitionDecisions.id],
    }),
    foreignKey({
      columns: [table.recognitionSourceAssociationId],
      foreignColumns: [sourceAssociations.id],
    }),
    check(
      "recognition_heads_source_requires_decision",
      sql`recognition_decision_id IS NOT NULL OR recognition_source_association_id IS NULL`,
    ),
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

/** 来源槽位连续性使元数据取代可审计且具原子性。 */
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
    sourceSubjectId: text("source_subject_id").notNull().default(""),
  },
  (table) => [
    primaryKey({
      name: "relationship_lifecycles_pk",
      columns: [table.relationshipId],
    }),
    index("relationship_lifecycles_scope_slot").on(
      table.sourceSubjectId,
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

/** 领域持有的来源刷新运行权威；执行只保留 ID。 */
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

/** 当前来源产物候选绑定到一个精确来源 lineage。 */
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

/** 传给 node:sqlite Drizzle 查询构建器的完整 schema 对象。 */
export const catalogueSchema = {
  schemaMigrations,
  workflowExecutions,
  sourceRecords,
  recognitionProposals,
  entities,
  entityKindAssertions,
  entityKindDecisions,
  entityKindSourceSupports,
  localEntityCommitments,
  localEntityNames,
  localUsers,
  artifactInteractionStates,
  sourceAssociations,
  sourceAssociationChangeProposals,
  sourceAssociationDecisions,
  sourceAssociationEstablishmentSupports,
  sourceAssociationSupersessions,
  sourceAssociationRetractions,
  sourceAssociationLegacyRetirements,
  recognitionDecisionRetractions,
  recognitionDecisions,
  artifacts,
  locations,
  blobs,
  artifactRevisions,
  observedRevisionConfirmations,
  currentFileObservations,
  currentFileObservationSupports,
  artifactContentProofs,
  artifactAssociations,
  artifactAssociationRecognitionSupports,
  metadataAssertions,
  sourcedEntities,
  entityRelationships,
  entityRelationshipParticipants,
  relationshipDecisions,
  relationshipDecisionHeads,
  relationshipManualSupports,
  entityIdentityMerges,
  entityIdentityMergeRetractions,
  entityMentions,
  entityResolutionDecisions,
  observedEntities,
  observedEntityMentions,
  observedEntityResolutions,
  observedEntityGraphSupports,
  observedEntityGraphEntities,
  observedEntityGraphRelationships,
  sourceLineageHeads,
  sourceRefreshChanges,
  changeImpactPreviews,
  automationIntents,
  automationRuntime,
  observedRootRegistrations,
  recognitionHeads,
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
  sourceRefreshRuns,
  sourceRefreshScopes,
  sourceRefreshChangeSets,
  currentSourceArtifactCandidateLineages,
} as const;
