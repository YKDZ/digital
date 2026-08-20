import type {
  AssetRefreshSelection,
  OrdinaryScanReusePlan,
  WorkflowExecution,
} from "@digital/application";
import {
  assertAssetRefreshSelection,
  decodeAssetRefreshWorkflowInput,
} from "@digital/application";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";

import {
  workflowExecutions,
  workflowExecutionAuditLegacyMarker,
  workflowExecutionAuditVersion,
  type VersionedJson,
} from "./schema.js";

/**
 * Internal structural subsets. They are deliberately not Application Ports
 * and exist only to keep Drizzle inside the SQLite Adapter implementation.
 */
type DrizzleWriteTransaction = Pick<
  ReturnType<typeof drizzle>,
  "delete" | "insert" | "select" | "update"
>;

type DrizzleReadQuery = Pick<ReturnType<typeof drizzle>, "select">;

type ExecutionRow = {
  readonly id: string;
  readonly selection_directory: string | null;
  readonly selection_intent:
    | "scan-now"
    | "metadata-refresh"
    | "directed-recognition";
  readonly information_requirement_json: string;
  readonly snapshot_json: string | null;
  readonly status: WorkflowExecution["status"];
  readonly stage: WorkflowExecution["stage"];
  readonly outcome: NonNullable<WorkflowExecution["outcome"]> | null;
  readonly source_record_ids_json: string;
  readonly source_refresh_run_ids_json?: string;
  readonly proposal_id: string | null;
  readonly accepted_asset_id: string | null;
  readonly reason: string | null;
  readonly reuse_plan_json: string | null;
  readonly reused_execution_id: string | null;
  readonly compatibility_json: string;
  readonly dispositions_json: string;
  readonly work_items_json: string;
  readonly cover_acquisition_json: string | null;
  readonly managed_cover_json: string | null;
  readonly automation_intent_id: string | null;
  /** Legacy compatibility column; new executions use workflow_input_json. */
  readonly trigger_kind: string | null;
  readonly operation_kind?: WorkflowExecution["operationKind"] | null;
  readonly requested_selection_json?: string | null;
  readonly resolved_selection_json?: string | null;
  readonly target_dispositions_json?: string | null;
  readonly filesystem_snapshots_json?: string | null;
  readonly source_enrichments_json?: string | null;
  /** NULL is the explicit legacy fallback before frozen input existed. */
  readonly workflow_input_json?: string | null;
  /** NULL is the explicitly supported pre-audit legacy fallback. */
  readonly audit_json: string | null;
  /** NULL means the Workflow Execution was not explicitly cancelled. */
  readonly cancellation_json?: string | null;
};

/**
 * Pre-registered-root persisted input. It is intentionally private to this
 * historical SQLite reader: no new Application caller can name or construct
 * it, and it never becomes an executable AssetRefreshSelection.
 */
type LegacyPersistedFilesystemSelection = {
  readonly version: "asset-refresh-selection/1";
  readonly subjects: AssetRefreshSelection["subjects"];
  readonly filesystemScopes: readonly {
    readonly root: string;
    readonly explanations: AssetRefreshSelection["filesystemScopes"][number]["explanations"];
  }[];
};

type DecodedPersistedAssetRefreshSelection =
  | { readonly kind: "current"; readonly selection: AssetRefreshSelection }
  | {
      readonly kind: "legacy-root-only";
      readonly selection: LegacyPersistedFilesystemSelection;
    };

type DecodedExecutionColumns = {
  readonly execution: WorkflowExecution;
  readonly legacySelections: Readonly<
    Partial<
      Record<
        "requestedSelection" | "resolvedSelection",
        LegacyPersistedFilesystemSelection
      >
    >
  >;
};

const legacyFilesystemSelectionRecoveryReason =
  "刷新记录使用旧版未登记文件位置范围，无法安全继续；请重新选择范围并刷新";

/**
 * The private Workflow Execution persistence core.
 *
 * Its small Interface accepts only the caller-owned Drizzle session needed to
 * hydrate, establish a full audit baseline, and insert or replace a durable
 * execution. SqliteCatalogue retains transaction orchestration, lease policy,
 * automation ownership, and cross-aggregate inspection composition.
 */
export class WorkflowExecutionPersistence {
  readExecutionWithDrizzle(
    query: DrizzleReadQuery,
    id: string,
  ): WorkflowExecution | undefined {
    return this.readExecutionWithAuditWithDrizzle(query, id)?.execution;
  }

  readExecutionWithAuditWithDrizzle(
    query: DrizzleReadQuery,
    id: string,
  ):
    | {
        readonly execution: WorkflowExecution;
        readonly auditJson: string | null;
      }
    | undefined {
    const row = query
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, id))
      .get();
    const executionRow =
      row === undefined ? undefined : executionRowFromDrizzle(row);
    return executionRow === undefined
      ? undefined
      : {
          execution: executionFromRow(executionRow),
          auditJson: executionRow.audit_json,
        };
  }

  /**
   * A checkpoint or terminal write starts from the complete frozen audit
   * payload. Cross-aggregate transactions use this exact same CAS baseline.
   */
  runningExecutionBaseline(
    query: DrizzleReadQuery,
    expected: WorkflowExecution,
    next: WorkflowExecution,
  ): {
    readonly execution: WorkflowExecution;
    readonly auditJson: string | null;
  } {
    const baseline = this.readExecutionWithAuditWithDrizzle(query, expected.id);
    if (
      next.id !== expected.id ||
      expected.status !== "running" ||
      baseline?.execution.status !== "running" ||
      baseline === undefined ||
      canonicalJson(
        withoutLegacyFilesystemSelectionRecoveryBarrier(baseline.execution),
      ) !== canonicalJson(executionFromColumns(executionColumnRow(expected)))
    ) {
      throw new Error(
        `Workflow Execution ${expected.id} execution baseline is stale or terminal`,
      );
    }
    return baseline;
  }

  replaceExecutionWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
    expected: { readonly auditJson: string | null },
  ): void {
    const condition = and(
      eq(workflowExecutions.id, execution.id),
      eq(workflowExecutions.status, "running"),
      expected.auditJson === null
        ? isNull(workflowExecutions.auditJson)
        : eq(workflowExecutions.auditJson, expected.auditJson),
    );
    const result = transaction
      .update(workflowExecutions)
      .set(drizzleExecutionValues(execution))
      .where(condition)
      .run();
    if (result.changes !== 1) {
      throw new Error(
        `Workflow Execution ${execution.id} execution baseline is stale`,
      );
    }
  }

  insertExecutionWithDrizzle(
    transaction: DrizzleWriteTransaction,
    execution: WorkflowExecution,
  ): void {
    transaction
      .insert(workflowExecutions)
      .values({
        id: execution.id,
        ...drizzleExecutionValues(execution),
      })
      .run();
  }

  executionFromDrizzle(
    row: typeof workflowExecutions.$inferSelect,
  ): WorkflowExecution {
    return executionFromRow(executionRowFromDrizzle(row));
  }
}

/**
 * The compatibility reader's recovery barrier is deliberately ephemeral: it
 * is not a new durable workflow-input shape and disappears when Application
 * records the required terminal interruption.
 */
function withoutLegacyFilesystemSelectionRecoveryBarrier(
  execution: WorkflowExecution,
): WorkflowExecution {
  if (
    execution.workflowInput === undefined ||
    execution.workflowInputInvalid?.reason !==
      legacyFilesystemSelectionRecoveryReason
  ) {
    return execution;
  }
  const { workflowInputInvalid: _legacyBarrier, ...withoutBarrier } = execution;
  return withoutBarrier;
}

function drizzleExecutionValues(execution: WorkflowExecution) {
  const row = executionColumnRow(execution);
  return {
    selectionDirectory: row.selection_directory,
    selectionIntent: row.selection_intent,
    informationRequirementJson: row.information_requirement_json,
    snapshotJson: row.snapshot_json,
    status: row.status,
    stage: row.stage,
    outcome: row.outcome,
    sourceRecordIdsJson: row.source_record_ids_json,
    sourceRefreshRunIdsJson: row.source_refresh_run_ids_json,
    proposalId: row.proposal_id,
    acceptedAssetId: row.accepted_asset_id,
    reason: row.reason,
    reusePlanJson: row.reuse_plan_json,
    reusedExecutionId: row.reused_execution_id,
    compatibilityJson: row.compatibility_json,
    dispositionsJson: row.dispositions_json,
    workItemsJson: row.work_items_json,
    coverAcquisitionJson: row.cover_acquisition_json,
    managedCoverJson: row.managed_cover_json,
    automationIntentId: row.automation_intent_id,
    triggerKind: row.trigger_kind,
    operationKind: row.operation_kind,
    requestedSelectionJson: row.requested_selection_json,
    resolvedSelectionJson: row.resolved_selection_json,
    targetDispositionsJson: row.target_dispositions_json,
    filesystemSnapshotsJson: row.filesystem_snapshots_json,
    sourceEnrichmentsJson: row.source_enrichments_json,
    workflowInputJson: row.workflow_input_json,
    auditJson: executionAuditJson(executionFromColumns(row)),
    cancellationJson: row.cancellation_json,
  };
}

function executionColumnRow(execution: WorkflowExecution) {
  return {
    id: execution.id,
    selection_directory: execution.selection.directory ?? null,
    selection_intent: execution.selection.intent ?? "scan-now",
    information_requirement_json: JSON.stringify(
      execution.selection.informationRequirement ?? {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        artifactRoles: [],
        relationshipTypes: [],
      },
    ),
    snapshot_json:
      execution.snapshot === undefined
        ? null
        : JSON.stringify(execution.snapshot),
    status: execution.status,
    stage: execution.stage,
    outcome: execution.outcome ?? null,
    source_record_ids_json: JSON.stringify(execution.sourceRecordIds),
    source_refresh_run_ids_json: JSON.stringify(
      execution.sourceRefreshRunIds ?? [],
    ),
    proposal_id: execution.proposalId ?? null,
    accepted_asset_id: execution.acceptedAssetId ?? null,
    reason: execution.reason ?? null,
    reuse_plan_json:
      execution.reusePlan === undefined
        ? null
        : JSON.stringify(execution.reusePlan),
    reused_execution_id: execution.reusedExecutionId ?? null,
    compatibility_json: JSON.stringify(
      execution.compatibility ?? {
        workflowVersion: "asset-refresh/2",
        policyVersion: "legacy",
        capabilityCoordinates: [],
      },
    ),
    dispositions_json: JSON.stringify(execution.dispositions ?? []),
    work_items_json: JSON.stringify(execution.workItems ?? []),
    cover_acquisition_json:
      execution.sourceArtifactAcquisitions === undefined &&
      execution.coverAcquisition === undefined
        ? null
        : JSON.stringify(
            execution.sourceArtifactAcquisitions ?? execution.coverAcquisition,
          ),
    managed_cover_json:
      execution.managedSourceArtifacts === undefined &&
      execution.managedCover === undefined
        ? null
        : JSON.stringify(
            execution.managedSourceArtifacts ?? execution.managedCover,
          ),
    automation_intent_id: execution.automationIntentId ?? null,
    trigger_kind: execution.trigger ?? null,
    operation_kind: execution.operationKind ?? null,
    requested_selection_json:
      execution.requestedSelection === undefined
        ? null
        : JSON.stringify(execution.requestedSelection),
    resolved_selection_json:
      execution.resolvedSelection === undefined
        ? null
        : JSON.stringify(execution.resolvedSelection),
    target_dispositions_json:
      execution.targetDispositions === undefined
        ? null
        : JSON.stringify(execution.targetDispositions),
    filesystem_snapshots_json:
      execution.filesystemSnapshots === undefined
        ? null
        : JSON.stringify(execution.filesystemSnapshots),
    source_enrichments_json: JSON.stringify(execution.sourceEnrichments ?? []),
    workflow_input_json:
      execution.workflowInput === undefined
        ? (execution.workflowInputInvalid?.raw ?? null)
        : JSON.stringify(execution.workflowInput),
    audit_json: null,
    cancellation_json:
      execution.cancellation === undefined
        ? null
        : JSON.stringify(execution.cancellation),
  } satisfies ExecutionRow;
}

/** Keep the Application audit decoder independent of Drizzle column casing. */
function executionRowFromDrizzle(
  row: typeof workflowExecutions.$inferSelect,
): ExecutionRow {
  return {
    id: row.id,
    selection_directory: row.selectionDirectory,
    selection_intent: row.selectionIntent as ExecutionRow["selection_intent"],
    information_requirement_json: row.informationRequirementJson,
    snapshot_json: row.snapshotJson,
    status: row.status as WorkflowExecution["status"],
    stage: row.stage as WorkflowExecution["stage"],
    outcome: row.outcome as ExecutionRow["outcome"],
    source_record_ids_json: row.sourceRecordIdsJson,
    source_refresh_run_ids_json: row.sourceRefreshRunIdsJson,
    proposal_id: row.proposalId,
    accepted_asset_id: row.acceptedAssetId,
    reason: row.reason,
    reuse_plan_json: row.reusePlanJson,
    reused_execution_id: row.reusedExecutionId,
    compatibility_json: row.compatibilityJson,
    dispositions_json: row.dispositionsJson,
    work_items_json: row.workItemsJson,
    cover_acquisition_json: row.coverAcquisitionJson,
    managed_cover_json: row.managedCoverJson,
    automation_intent_id: row.automationIntentId,
    trigger_kind: row.triggerKind,
    operation_kind: row.operationKind as ExecutionRow["operation_kind"],
    requested_selection_json: row.requestedSelectionJson,
    resolved_selection_json: row.resolvedSelectionJson,
    target_dispositions_json: row.targetDispositionsJson,
    filesystem_snapshots_json: row.filesystemSnapshotsJson,
    source_enrichments_json: row.sourceEnrichmentsJson,
    workflow_input_json: row.workflowInputJson,
    audit_json: row.auditJson,
    cancellation_json: row.cancellationJson,
  };
}

function executionAuditJson(execution: WorkflowExecution): string {
  const audit: VersionedJson<WorkflowExecution> = {
    version: workflowExecutionAuditVersion,
    payload: execution,
  };
  return JSON.stringify(audit);
}

function executionFromRow(row: ExecutionRow): WorkflowExecution {
  return executionFromAudit(row.audit_json, decodeExecutionColumns(row));
}

function workflowInputFromJson(
  raw: string | null | undefined,
): Pick<WorkflowExecution, "workflowInput" | "workflowInputInvalid"> {
  if (raw == null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      workflowInputInvalid: {
        raw,
        reason: "刷新版本化输入 JSON 损坏",
      },
    };
  }
  const decoded = decodeAssetRefreshWorkflowInput(parsed);
  return decoded.valid
    ? { workflowInput: decoded.input }
    : { workflowInputInvalid: { raw, reason: decoded.reason } };
}

function executionFromColumns(row: ExecutionRow): WorkflowExecution {
  return decodeExecutionColumns(row).execution;
}

function decodeExecutionColumns(row: ExecutionRow): DecodedExecutionColumns {
  const workItems = JSON.parse(row.work_items_json) as NonNullable<
    WorkflowExecution["workItems"]
  >;
  const workflowInput = workflowInputFromJson(row.workflow_input_json);
  const requestedSelection =
    row.requested_selection_json == null
      ? undefined
      : parsePersistedAssetRefreshSelection(
          row.requested_selection_json,
          "requested_selection_json",
        );
  const resolvedSelection =
    row.resolved_selection_json == null
      ? undefined
      : parsePersistedAssetRefreshSelection(
          row.resolved_selection_json,
          "resolved_selection_json",
        );
  const legacySelections = {
    ...(requestedSelection?.kind === "legacy-root-only"
      ? { requestedSelection: requestedSelection.selection }
      : {}),
    ...(resolvedSelection?.kind === "legacy-root-only"
      ? { resolvedSelection: resolvedSelection.selection }
      : {}),
  };
  const legacyFilesystemSelection = Object.keys(legacySelections).length > 0;
  return {
    legacySelections,
    execution: {
      id: row.id,
      selection: {
        ...(row.selection_directory === null
          ? {}
          : { directory: row.selection_directory }),
        intent: row.selection_intent,
        informationRequirement: JSON.parse(
          row.information_requirement_json,
        ) as NonNullable<
          WorkflowExecution["selection"]["informationRequirement"]
        >,
      },
      ...(row.snapshot_json === null
        ? {}
        : {
            snapshot: JSON.parse(row.snapshot_json) as NonNullable<
              WorkflowExecution["snapshot"]
            >,
          }),
      ...(row.operation_kind == null
        ? {}
        : { operationKind: row.operation_kind }),
      ...(requestedSelection?.kind === "current"
        ? { requestedSelection: requestedSelection.selection }
        : {}),
      ...(resolvedSelection?.kind === "current"
        ? { resolvedSelection: resolvedSelection.selection }
        : {}),
      ...(row.target_dispositions_json == null
        ? {}
        : {
            targetDispositions: parseTargetDispositions(
              row.target_dispositions_json,
            ),
          }),
      ...(row.filesystem_snapshots_json == null
        ? {}
        : {
            filesystemSnapshots: parseFilesystemSnapshots(
              row.filesystem_snapshots_json,
            ),
          }),
      ...(row.source_enrichments_json == null
        ? {}
        : {
            sourceEnrichments: JSON.parse(
              row.source_enrichments_json,
            ) as NonNullable<WorkflowExecution["sourceEnrichments"]>,
          }),
      ...workflowInput,
      ...(legacyFilesystemSelection
        ? {
            // The public WorkflowExecution retains only a sanitized reason. The
            // private legacy payload above is used solely to verify durable
            // audit consistency while this row is read.
            workflowInputInvalid: {
              raw: JSON.stringify(legacySelections),
              reason: legacyFilesystemSelectionRecoveryReason,
            },
          }
        : {}),
      status: row.status,
      stage: row.stage,
      ...(row.outcome === null ? {} : { outcome: row.outcome }),
      sourceRecordIds: JSON.parse(row.source_record_ids_json) as string[],
      ...(row.source_refresh_run_ids_json === undefined
        ? {}
        : {
            sourceRefreshRunIds: JSON.parse(
              row.source_refresh_run_ids_json,
            ) as string[],
          }),
      ...(row.proposal_id === null ? {} : { proposalId: row.proposal_id }),
      ...(row.accepted_asset_id === null
        ? {}
        : { acceptedAssetId: row.accepted_asset_id }),
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.cancellation_json == null
        ? {}
        : {
            cancellation: JSON.parse(row.cancellation_json) as NonNullable<
              WorkflowExecution["cancellation"]
            >,
          }),
      ...(row.reuse_plan_json === null
        ? {}
        : {
            reusePlan: JSON.parse(row.reuse_plan_json) as OrdinaryScanReusePlan,
          }),
      ...(row.reused_execution_id === null
        ? {}
        : { reusedExecutionId: row.reused_execution_id }),
      compatibility: JSON.parse(
        row.compatibility_json,
      ) as WorkflowExecution["compatibility"],
      dispositions: JSON.parse(
        row.dispositions_json,
      ) as WorkflowExecution["dispositions"],
      ...(workItems.length === 0 ? {} : { workItems }),
      ...sourceArtifactCheckpointsFromJson(row.cover_acquisition_json),
      ...managedSourceArtifactsFromJson(row.managed_cover_json),
      ...(row.automation_intent_id === null
        ? {}
        : { automationIntentId: row.automation_intent_id }),
      ...(row.trigger_kind === null ? {} : { trigger: row.trigger_kind }),
    },
  };
}

function executionFromAudit(
  auditJson: string | null,
  decodedColumns: DecodedExecutionColumns,
): WorkflowExecution {
  const { execution: fromColumns, legacySelections } = decodedColumns;
  // 0031 adds a nullable column specifically so existing durable executions
  // continue to reopen through the old column representation. A short-lived
  // prerelease default marker receives the same constrained fallback.
  if (auditJson === null || auditJson === workflowExecutionAuditLegacyMarker)
    return fromColumns;

  let parsed: unknown;
  try {
    parsed = JSON.parse(auditJson);
  } catch {
    throw new Error("Workflow execution audit_json is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Workflow execution audit_json must be an envelope");
  const envelope = parsed as {
    readonly version?: unknown;
    readonly payload?: unknown;
  };
  if (envelope.version !== workflowExecutionAuditVersion)
    throw new Error("Workflow execution audit_json has an unknown version");
  if (
    typeof envelope.payload !== "object" ||
    envelope.payload === null ||
    Array.isArray(envelope.payload)
  )
    throw new Error("Workflow execution audit_json payload must be an object");
  if (fromColumns.workflowInputInvalid !== undefined) {
    // Only the damaged input coordinate is exempt from the audit comparison.
    // All other columns still have to match the original complete audit, so a
    // malformed envelope cannot hide unrelated durable-row tampering.
    const {
      workflowInputInvalid: _invalidInput,
      workflowInput: _columnInput,
      ...columnCoordinates
    } = fromColumns;
    const auditCoordinates = {
      ...(envelope.payload as Record<string, unknown>),
    };
    delete auditCoordinates.workflowInput;
    delete auditCoordinates.workflowInputInvalid;
    for (const [key, legacySelection] of Object.entries(legacySelections)) {
      if (
        canonicalJson((envelope.payload as Record<string, unknown>)[key]) !==
        canonicalJson(legacySelection)
      ) {
        throw new Error(
          "Workflow execution audit_json conflicts with persisted columns",
        );
      }
      delete auditCoordinates[key];
    }
    if (canonicalJson(auditCoordinates) !== canonicalJson(columnCoordinates))
      throw new Error(
        "Workflow execution audit_json conflicts with persisted columns",
      );
    return fromColumns;
  }
  if (
    envelope.payload === undefined ||
    canonicalJson(envelope.payload) !== canonicalJson(fromColumns)
  )
    throw new Error(
      "Workflow execution audit_json conflicts with persisted columns",
    );
  return fromColumns;
}

/** Shared by execution audit CAS and Adapter-owned canonical fact checks. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Audit payload must be JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Audit payload must be JSON");
}

function parseNewAuditJson(value: string, column: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Malformed Asset Refresh audit column ${column}`);
  }
}

function parsePersistedAssetRefreshSelection(
  value: string,
  column: string,
): DecodedPersistedAssetRefreshSelection {
  // Known fields are recursively strict. Unknown fields remain tolerated for
  // forward-compatible readers, matching the repository's JSON audit policy.
  const parsed = parseNewAuditJson(value, column);
  try {
    assertAssetRefreshSelection(parsed);
    return { kind: "current", selection: parsed };
  } catch {
    const legacy = decodeLegacyPersistedFilesystemSelection(parsed);
    if (legacy !== undefined)
      return { kind: "legacy-root-only", selection: legacy };
    throw new Error(`Malformed Asset Refresh audit column ${column}`);
  }
}

/**
 * The sole compatibility reader for pre-registration selection rows. It
 * recognizes a former root-only scope only so the row remains inspectable;
 * callers never receive this shape as an executable Application selection.
 */
function decodeLegacyPersistedFilesystemSelection(
  value: unknown,
): LegacyPersistedFilesystemSelection | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const candidate = value as {
    readonly version?: unknown;
    readonly subjects?: unknown;
    readonly filesystemScopes?: unknown;
  };
  if (
    candidate.version !== "asset-refresh-selection/1" ||
    !Array.isArray(candidate.subjects) ||
    !Array.isArray(candidate.filesystemScopes) ||
    candidate.filesystemScopes.length === 0
  ) {
    return undefined;
  }
  try {
    // Reuse the public strict validator for all non-filesystem coordinates.
    // A legacy filesystem row still needs at least one valid subject or its
    // original scopes must be the only non-empty target set.
    assertAssetRefreshSelection({
      ...candidate,
      filesystemScopes: [],
      subjects:
        candidate.subjects.length === 0
          ? [
              {
                subjectId: "legacy-persisted-filesystem-selection",
                explanations: [{ path: ["legacy", "filesystem"] }],
              },
            ]
          : candidate.subjects,
    });
  } catch {
    return undefined;
  }
  if (!candidate.filesystemScopes.every(isLegacyRootOnlyFilesystemScope)) {
    return undefined;
  }
  return value as LegacyPersistedFilesystemSelection;
}

function isLegacyRootOnlyFilesystemScope(scope: unknown): boolean {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope))
    return false;
  const candidate = scope as Record<string, unknown>;
  if (
    typeof candidate.root !== "string" ||
    candidate.root.length === 0 ||
    candidate.observedRoot !== undefined ||
    candidate.relativeScope !== undefined ||
    !Array.isArray(candidate.explanations) ||
    candidate.explanations.length === 0
  ) {
    return false;
  }
  return candidate.explanations.every((explanation) => {
    if (
      typeof explanation !== "object" ||
      explanation === null ||
      Array.isArray(explanation)
    ) {
      return false;
    }
    const path = (explanation as Record<string, unknown>).path;
    return (
      Array.isArray(path) &&
      path.length > 0 &&
      path.every((label) => typeof label === "string" && label.length > 0)
    );
  });
}

function parseTargetDispositions(
  value: string,
): NonNullable<WorkflowExecution["targetDispositions"]> {
  // Validate every known nested element; tolerate unknown fields so a newer
  // writer does not make an older reader discard an otherwise readable audit.
  const parsed = parseNewAuditJson(value, "target_dispositions_json");
  const statuses = new Set([
    "running",
    "completed",
    "reused",
    "skipped",
    "blocked",
    "failed",
    "no-change",
  ]);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as {
        key?: unknown;
        target?: unknown;
        status?: unknown;
        reason?: unknown;
        sourceRecordIds?: unknown;
        outputReferences?: unknown;
      };
      if (
        typeof candidate.key !== "string" ||
        candidate.key.length === 0 ||
        typeof candidate.status !== "string" ||
        !statuses.has(candidate.status) ||
        typeof candidate.target !== "object" ||
        candidate.target === null ||
        (candidate.reason !== undefined &&
          typeof candidate.reason !== "string") ||
        (candidate.sourceRecordIds !== undefined &&
          (!Array.isArray(candidate.sourceRecordIds) ||
            !candidate.sourceRecordIds.every(
              (recordId) => typeof recordId === "string" && recordId.length > 0,
            ))) ||
        (candidate.outputReferences !== undefined &&
          (!Array.isArray(candidate.outputReferences) ||
            !candidate.outputReferences.every(
              (reference) =>
                typeof reference === "string" && reference.length > 0,
            )))
      )
        return false;
      const target = candidate.target as {
        kind?: unknown;
        subjectId?: unknown;
        root?: unknown;
      };
      return target.kind === "subject"
        ? typeof target.subjectId === "string" && target.subjectId.length > 0
        : target.kind === "filesystem-scope" &&
            typeof target.root === "string" &&
            target.root.length > 0;
    })
  ) {
    throw new Error(
      "Malformed Asset Refresh audit column target_dispositions_json",
    );
  }
  return parsed as NonNullable<WorkflowExecution["targetDispositions"]>;
}

function parseFilesystemSnapshots(
  value: string,
): NonNullable<WorkflowExecution["filesystemSnapshots"]> {
  const parsed = parseNewAuditJson(value, "filesystem_snapshots_json");
  const validFile = (value: unknown) => {
    if (typeof value !== "object" || value === null) return false;
    const file = value as {
      relativePath?: unknown;
      size?: unknown;
      modifiedAt?: unknown;
    };
    return (
      typeof file.relativePath === "string" &&
      file.relativePath.length > 0 &&
      typeof file.size === "number" &&
      Number.isFinite(file.size) &&
      file.size >= 0 &&
      typeof file.modifiedAt === "string" &&
      file.modifiedAt.length > 0
    );
  };
  const validDirectory = (value: unknown) => {
    if (typeof value !== "object" || value === null) return false;
    const directory = value as {
      relativePath?: unknown;
      modifiedAt?: unknown;
    };
    return (
      typeof directory.relativePath === "string" &&
      directory.relativePath.length > 0 &&
      typeof directory.modifiedAt === "string" &&
      directory.modifiedAt.length > 0
    );
  };
  const validExclusion = (value: unknown) => {
    if (typeof value !== "object" || value === null) return false;
    const exclusion = value as { relativePath?: unknown; kind?: unknown };
    return (
      typeof exclusion.relativePath === "string" &&
      exclusion.relativePath.length > 0 &&
      (exclusion.kind === "symbolic-link" || exclusion.kind === "special")
    );
  };
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (snapshot) =>
        typeof snapshot === "object" &&
        snapshot !== null &&
        typeof (snapshot as { id?: unknown }).id === "string" &&
        (snapshot as { id: string }).id.length > 0 &&
        typeof (snapshot as { root?: unknown }).root === "string" &&
        (snapshot as { root: string }).root.length > 0 &&
        typeof (snapshot as { complete?: unknown }).complete === "boolean" &&
        Array.isArray((snapshot as { files?: unknown }).files) &&
        (snapshot as { files: unknown[] }).files.every(validFile) &&
        ((snapshot as { directories?: unknown }).directories === undefined ||
          (Array.isArray((snapshot as { directories?: unknown }).directories) &&
            (snapshot as { directories: unknown[] }).directories.every(
              validDirectory,
            ))) &&
        Array.isArray((snapshot as { excluded?: unknown }).excluded) &&
        (snapshot as { excluded: unknown[] }).excluded.every(validExclusion) &&
        typeof (snapshot as { observedAt?: unknown }).observedAt === "string" &&
        (snapshot as { observedAt: string }).observedAt.length > 0,
    )
  ) {
    throw new Error(
      "Malformed Asset Refresh audit column filesystem_snapshots_json",
    );
  }
  return parsed as NonNullable<WorkflowExecution["filesystemSnapshots"]>;
}

function sourceArtifactCheckpointsFromJson(
  value: string | null,
): Pick<WorkflowExecution, "coverAcquisition" | "sourceArtifactAcquisitions"> {
  if (value === null) return {};
  const parsed = JSON.parse(value) as
    | NonNullable<WorkflowExecution["coverAcquisition"]>
    | NonNullable<WorkflowExecution["sourceArtifactAcquisitions"]>;
  return Array.isArray(parsed)
    ? {
        sourceArtifactAcquisitions: parsed as NonNullable<
          WorkflowExecution["sourceArtifactAcquisitions"]
        >,
      }
    : {
        coverAcquisition: parsed as NonNullable<
          WorkflowExecution["coverAcquisition"]
        >,
      };
}

function managedSourceArtifactsFromJson(
  value: string | null,
): Pick<WorkflowExecution, "managedCover" | "managedSourceArtifacts"> {
  if (value === null) return {};
  const parsed = JSON.parse(value) as
    | NonNullable<WorkflowExecution["managedCover"]>
    | NonNullable<WorkflowExecution["managedSourceArtifacts"]>;
  return Array.isArray(parsed)
    ? {
        managedSourceArtifacts: parsed as NonNullable<
          WorkflowExecution["managedSourceArtifacts"]
        >,
      }
    : {
        managedCover: parsed as NonNullable<WorkflowExecution["managedCover"]>,
      };
}
