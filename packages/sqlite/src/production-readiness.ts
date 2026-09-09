import { access } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  decodeObservedMaterialAssociationCheckpoint,
  decodeRecognitionBasis,
  decodeSourceAssociationChangeProposal,
  decodeSourceAssociationDecisionCheckpoint,
  decodeWorkflowExecutionInput,
  isExactLegacySourceEnrichmentExecutionAuthority,
  type WorkflowExecution,
  validateSourceAssociationDecisionEnvelope,
  validateSourceAssociationDecisionPriorExecution,
} from "@digital/application";

import { matchesReviewedCatalogueSchema } from "./schema-contract.ts";
import { canonicalJson } from "./workflow-execution-persistence.ts";

export const productionCatalogueMigrationHead =
  "20260909000000_current_file_observation_supports";
export const productionCatalogueMigrationPlan = [
  {
    id: "20260820000000_v1_catalogue_baseline",
    checksum:
      "ac1142567144de5a8fdaa379d9a905624c8a7ee93e9f62106cfdf253c99060be",
  },
  {
    id: "20260829000000_observed_revision_confirmations",
    checksum:
      "467fd203a11dbebd861955351a00afab3baab52c8fefc0eb20adf5466f294e3d",
  },
  {
    id: "20260830000000_workflow_planned_asset_identity",
    checksum:
      "c9bb262d857134d5d14472843140ea80070b159f9d54cfb3c0b5a4d9dbb6d553",
  },
  {
    id: "20260830010000_recognition_basis_heads",
    checksum:
      "ae98fd168398e6de560826765eb0dc71c99b919a6fff6b4d0f8e7756a50a1683",
  },
  {
    id: "20260905000000_manual_metadata_provenance",
    checksum:
      "7282224c344292790837fbe01cfafd4008e3e93a96797c37152f8a3ee36052be",
  },
  {
    id: "20260906000000_observed_material_association",
    checksum:
      "94a89ac720d4d32e036a2ccd03b73326e5ce712486522b8a533ff4287c5ad1de",
  },
  {
    id: "20260906010000_source_identity_correction",
    checksum:
      "10453ffe9e48d3a925a294ae2f88656be7ad4e9b34ae891b56b6749e9832c10c",
  },
  {
    id: productionCatalogueMigrationHead,
    checksum:
      "71c7e999e5b76b3983fbadf6b404a217c25823a8d116126dadcbd3349edf4394",
  },
] as const;

export type ProductionCatalogueReadiness =
  | { readonly state: "ready" }
  | {
      readonly state: "product-data-directory-missing";
      readonly message: string;
    }
  | { readonly state: "catalogue-not-prepared"; readonly message: string }
  | {
      readonly state: "schema-newer-than-application";
      readonly message: string;
    }
  | { readonly state: "migration-failed"; readonly message: string }
  | { readonly state: "catalogue-integrity-failed"; readonly message: string }
  | { readonly state: "local-dependency-missing"; readonly message: string };

/**
 * 仅供运行时使用的生产准入检查。它绝不创建目录、写入账本或调用迁移工具。
 */
export async function inspectProductionCatalogueReadiness(options: {
  readonly productDataDirectory: string;
}): Promise<ProductionCatalogueReadiness> {
  const productDataDirectory = path.resolve(options.productDataDirectory);
  try {
    await access(productDataDirectory);
  } catch {
    return {
      state: "product-data-directory-missing",
      message: "产品数据目录不存在；先运行 digital-db-migrate prepare-only",
    };
  }
  const databasePath = path.join(productDataDirectory, "catalogue.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return {
      state: "catalogue-not-prepared",
      message: "Catalogue 尚未准备；运行 digital-db-migrate prepare-only",
    };
  }
  try {
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { readonly name: string }).name),
    );
    if (!tables.has("__digital_catalogue_migrations")) {
      return {
        state: "catalogue-not-prepared",
        message:
          "Catalogue 缺少生产迁移账本；运行 digital-db-migrate prepare-only",
      };
    }
    try {
      await access(path.join(productDataDirectory, "managed-artifacts"));
    } catch {
      return {
        state: "local-dependency-missing",
        message:
          "产品托管产物目录不存在；重新运行 digital-db-migrate prepare-only",
      };
    }
    if (tables.has("__digital_catalogue_migration_failures")) {
      const failure = database
        .prepare(
          "SELECT id FROM __digital_catalogue_migration_failures ORDER BY occurred_at DESC LIMIT 1",
        )
        .get() as { readonly id: string } | undefined;
      if (failure !== undefined) {
        return {
          state: "migration-failed",
          message: `迁移 ${failure.id} 曾失败；修复后重新运行 digital-db-migrate prepare-only`,
        };
      }
    }
    const migrations = database
      .prepare(
        "SELECT id, checksum FROM __digital_catalogue_migrations ORDER BY id",
      )
      .all() as Array<{ readonly id: string; readonly checksum: string }>;
    const exactPlan =
      migrations.length === productionCatalogueMigrationPlan.length &&
      migrations.every(
        (migration, index) =>
          migration.id === productionCatalogueMigrationPlan[index]?.id &&
          migration.checksum ===
            productionCatalogueMigrationPlan[index]?.checksum,
      );
    const future = migrations.find(
      ({ id }) => id > productionCatalogueMigrationHead,
    );
    if (future !== undefined) {
      return {
        state: "schema-newer-than-application",
        message: `Catalogue 已迁移到 ${future.id}，高于此应用支持的 ${productionCatalogueMigrationHead}；请升级应用，不能降级启动`,
      };
    }
    if (!exactPlan) {
      return {
        state: "catalogue-integrity-failed",
        message:
          "Catalogue 生产迁移账本缺失、乱序或校验和不匹配；从离线备份恢复或运行匹配版本的部署工具",
      };
    }
    if (!matchesCatalogueSchemaWithProductionLedger(database)) {
      return {
        state: "catalogue-integrity-failed",
        message:
          "Catalogue 结构或完整性不符合已审阅 schema；从离线备份恢复或联系部署维护者",
      };
    }
    if (
      !hasValidObservedMaterialCheckpoints(database) ||
      !hasValidObservedMaterialSupports(database) ||
      !hasValidSourceAssociationState(database)
    ) {
      return {
        state: "catalogue-integrity-failed",
        message:
          "Catalogue 观察材料决定支持链损坏；从离线备份恢复或联系部署维护者",
      };
    }
    return { state: "ready" };
  } catch {
    return {
      state: "catalogue-integrity-failed",
      message: "无法验证 Catalogue 完整性；从离线备份恢复或联系部署维护者",
    };
  } finally {
    database?.close();
  }
}

function hasValidSourceAssociationState(database: DatabaseSync): boolean {
  const proposalRows = database
    .prepare(`SELECT id, subject_id, kind, payload_json, proposed_by_json, evidence_json
              FROM source_association_change_proposals`)
    .all() as Array<{
    readonly id: string;
    readonly subject_id: string;
    readonly kind: string;
    readonly payload_json: string;
    readonly proposed_by_json: string;
    readonly evidence_json: string;
  }>;
  if (
    proposalRows.some((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        const proposedBy = JSON.parse(row.proposed_by_json) as unknown;
        const evidence = JSON.parse(row.evidence_json) as unknown;
        if (
          payload === null ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          !["establish", "replace", "retract"].includes(row.kind)
        )
          return true;
        const payloadKeys = Object.keys(payload).toSorted();
        const bodyKeys = (
          row.kind === "retract"
            ? ["predecessorAssociationId", "reason"]
            : [
                ...(row.kind === "replace" ? ["predecessorAssociationId"] : []),
                "sourceRecordIds",
                "successor",
              ]
        ).toSorted();
        const fullKeys = [
          ...bodyKeys,
          "evidence",
          "id",
          "kind",
          "proposedBy",
          "subjectId",
        ].toSorted();
        const bodyOnly =
          JSON.stringify(payloadKeys) === JSON.stringify(bodyKeys);
        const complete =
          JSON.stringify(payloadKeys) === JSON.stringify(fullKeys);
        if (!bodyOnly && !complete) return true;
        const candidate = bodyOnly
          ? {
              ...(payload as Readonly<Record<string, unknown>>),
              id: row.id,
              subjectId: row.subject_id,
              kind: row.kind,
              proposedBy,
              evidence,
            }
          : payload;
        const decoded = decodeSourceAssociationChangeProposal(candidate);
        return (
          !decoded.valid ||
          decoded.value.id !== row.id ||
          decoded.value.subjectId !== row.subject_id ||
          decoded.value.kind !== row.kind ||
          canonicalJson(decoded.value.proposedBy) !==
            canonicalJson(proposedBy) ||
          canonicalJson(decoded.value.evidence) !== canonicalJson(evidence)
        );
      } catch {
        return true;
      }
    })
  )
    return false;
  const checkpoints = database
    .prepare(`SELECT id, status, workflow_input_json AS workflow_input, source_record_ids_json AS source_records,
                     compatibility_json AS compatibility,
                     accepted_asset_id, source_association_decision_json AS raw FROM workflow_executions
      WHERE source_association_decision_json IS NOT NULL`)
    .all() as Array<{
    readonly id: string;
    readonly status: "running" | "completed" | "failed";
    readonly workflow_input: string | null;
    readonly source_records: string;
    readonly compatibility: string;
    readonly accepted_asset_id: string | null;
    readonly raw: string;
  }>;
  if (
    checkpoints.some((row) => {
      try {
        const checkpoint = decodeSourceAssociationDecisionCheckpoint(
          JSON.parse(row.raw),
        );
        const workflowInput = decodeWorkflowExecutionInput(
          JSON.parse(row.workflow_input ?? "null"),
        );
        const priorId =
          workflowInput.valid &&
          workflowInput.input.version === "source-association-decision-input/1"
            ? workflowInput.input.priorExecutionId
            : undefined;
        const priorRow = checkpoints.find(({ id }) => id === priorId);
        const priorInput =
          priorRow === undefined
            ? undefined
            : decodeWorkflowExecutionInput(
                JSON.parse(priorRow.workflow_input ?? "null"),
              );
        const priorCheckpoint =
          priorRow === undefined
            ? undefined
            : decodeSourceAssociationDecisionCheckpoint(
                JSON.parse(priorRow.raw),
              );
        return (
          !checkpoint.valid ||
          !workflowInput.valid ||
          !validateSourceAssociationDecisionEnvelope({
            id: row.id,
            workflowInput: workflowInput.input,
            compatibility: JSON.parse(
              row.compatibility,
            ) as WorkflowExecution["compatibility"],
            ...(row.accepted_asset_id === null
              ? {}
              : { acceptedAssetId: row.accepted_asset_id }),
            sourceRecordIds: JSON.parse(row.source_records) as string[],
            sourceAssociationDecision: checkpoint.value,
          }) ||
          !validateSourceAssociationDecisionPriorExecution(
            { id: row.id, workflowInput: workflowInput.input },
            priorRow === undefined ||
              priorInput?.valid !== true ||
              priorCheckpoint?.valid !== true
              ? undefined
              : {
                  id: priorRow.id,
                  status: priorRow.status,
                  workflowInput: priorInput.input,
                  sourceAssociationDecision: priorCheckpoint.value,
                },
          )
        );
      } catch {
        return true;
      }
    })
  )
    return false;
  const terminationBases = database
    .prepare(`
      SELECT DISTINCT proposal.basis_json AS raw
      FROM recognition_proposals AS proposal
      JOIN recognition_decisions AS decision ON decision.proposal_id = proposal.id
      WHERE decision.id IN (
        SELECT predecessor_decision_id FROM recognition_decision_supersessions
        UNION
        SELECT successor_decision_id FROM recognition_decision_supersessions
        UNION
        SELECT predecessor_decision_id FROM recognition_decision_retractions
      )
    `)
    .all() as Array<{ readonly raw: string }>;
  if (
    terminationBases.some(({ raw }) => {
      try {
        return !decodeRecognitionBasis(JSON.parse(raw)).valid;
      } catch {
        return true;
      }
    })
  )
    return false;
  const invalid = database
    .prepare(`
      SELECT 1
      FROM source_associations AS association
      LEFT JOIN source_association_establishment_supports AS support
        ON support.association_id = association.id
      LEFT JOIN recognition_decisions AS recognition
        ON recognition.id = support.recognition_decision_id
      LEFT JOIN recognition_proposals AS recognition_proposal
        ON recognition_proposal.id = recognition.proposal_id
      LEFT JOIN source_association_decisions AS source_decision
        ON source_decision.id = support.source_association_decision_id
      LEFT JOIN source_association_change_proposals AS source_proposal
        ON source_proposal.id = source_decision.proposal_id
      WHERE support.association_id IS NULL
         OR ((support.recognition_decision_id IS NOT NULL) =
             (support.source_association_decision_id IS NOT NULL))
         OR (support.recognition_decision_id IS NOT NULL AND
             (recognition.id IS NULL OR recognition_proposal.id IS NULL OR
              recognition.asset_id IS NOT association.subject_id OR
              json_extract(recognition_proposal.basis_json, '$.kind') IS NOT 'source-interpretation' OR
              json_extract(recognition_proposal.basis_json, '$.interpretation.sourceIdentity') IS NOT association.source_identity OR
              json_extract(recognition_proposal.basis_json, '$.interpretation.sourceAddress') IS NOT association.native_address))
         OR (support.source_association_decision_id IS NOT NULL AND
             (source_decision.id IS NULL OR source_proposal.id IS NULL OR
              source_decision.subject_id IS NOT association.subject_id OR
              source_proposal.subject_id IS NOT association.subject_id OR
              source_proposal.kind NOT IN ('establish', 'replace') OR
              json_extract(source_proposal.payload_json, '$.successor.id') IS NOT association.id OR
              json_extract(source_proposal.payload_json, '$.successor.subjectId') IS NOT association.subject_id OR
              json_extract(source_proposal.payload_json, '$.successor.sourceIdentity') IS NOT association.source_identity OR
              json_extract(source_proposal.payload_json, '$.successor.nativeAddress') IS NOT association.native_address))
      LIMIT 1
    `)
    .get();
  if (invalid !== undefined) return false;
  const duplicateCoordinate = database
    .prepare(`
      SELECT 1 FROM current_source_associations AS current
      JOIN source_associations AS association ON association.id = current.association_id
      GROUP BY association.source_identity, association.native_address
      HAVING COUNT(DISTINCT association.subject_id) > 1 OR
             COUNT(*) <> COUNT(DISTINCT association.id)
      LIMIT 1
    `)
    .get();
  const invalidLifecycle = database
    .prepare(`
      SELECT 1 FROM source_association_supersessions AS supersession
      JOIN source_associations AS predecessor ON predecessor.id = supersession.predecessor_association_id
      JOIN source_associations AS successor ON successor.id = supersession.successor_association_id
      LEFT JOIN source_association_decisions AS source_decision
        ON source_decision.id = supersession.source_association_decision_id
      LEFT JOIN source_association_change_proposals AS source_proposal
        ON source_proposal.id = source_decision.proposal_id
      LEFT JOIN recognition_decisions AS recognition
        ON recognition.id = supersession.recognition_decision_id
      LEFT JOIN source_association_establishment_supports AS successor_support
        ON successor_support.association_id = successor.id
      WHERE predecessor.subject_id IS NOT successor.subject_id OR
            predecessor.source_identity IS NOT successor.source_identity OR
            predecessor.native_address = successor.native_address OR
            ((supersession.source_association_decision_id IS NOT NULL) =
             (supersession.recognition_decision_id IS NOT NULL)) OR
            EXISTS (SELECT 1 FROM source_association_retractions AS retraction
                    WHERE retraction.association_id = predecessor.id) OR
            (supersession.source_association_decision_id IS NOT NULL AND
              (source_decision.id IS NULL OR source_proposal.kind IS NOT 'replace' OR
               source_proposal.subject_id IS NOT predecessor.subject_id OR
               json_extract(source_proposal.payload_json, '$.predecessorAssociationId') IS NOT predecessor.id OR
               json_extract(source_proposal.payload_json, '$.successor.id') IS NOT successor.id OR
               successor_support.source_association_decision_id IS NULL OR
               successor_support.source_association_decision_id IS NOT source_decision.id OR
               successor_support.recognition_decision_id IS NOT NULL)) OR
            (supersession.recognition_decision_id IS NOT NULL AND
              (recognition.id IS NULL OR recognition.asset_id IS NOT predecessor.subject_id OR
               successor_support.recognition_decision_id IS NULL OR
               successor_support.recognition_decision_id IS NOT recognition.id OR
               successor_support.source_association_decision_id IS NOT NULL))
      LIMIT 1
    `)
    .get();
  const invalidRetraction = database
    .prepare(`
      SELECT 1 FROM source_association_retractions AS retraction
      JOIN source_associations AS association ON association.id = retraction.association_id
      LEFT JOIN source_association_decisions AS source_decision
        ON source_decision.id = retraction.source_association_decision_id
      LEFT JOIN source_association_change_proposals AS source_proposal
        ON source_proposal.id = source_decision.proposal_id
      LEFT JOIN recognition_decision_retractions AS recognition_retraction
        ON recognition_retraction.id = retraction.recognition_decision_retraction_id
      LEFT JOIN recognition_decision_supersessions AS recognition_supersession
        ON recognition_supersession.id = retraction.recognition_decision_supersession_id
      LEFT JOIN recognition_decisions AS supersession_predecessor
        ON supersession_predecessor.id = recognition_supersession.predecessor_decision_id
      LEFT JOIN recognition_decisions AS supersession_successor
        ON supersession_successor.id = recognition_supersession.successor_decision_id
      LEFT JOIN recognition_proposals AS supersession_successor_proposal
        ON supersession_successor_proposal.id = supersession_successor.proposal_id
      LEFT JOIN source_association_establishment_supports AS support
        ON support.association_id = association.id
      WHERE ((retraction.source_association_decision_id IS NOT NULL) +
             (retraction.recognition_decision_supersession_id IS NOT NULL) +
             (retraction.recognition_decision_retraction_id IS NOT NULL)) <> 1
         OR (retraction.source_association_decision_id IS NOT NULL AND
              (source_proposal.kind IS NOT 'retract' OR
              source_proposal.subject_id IS NOT association.subject_id OR
              json_extract(source_proposal.payload_json, '$.predecessorAssociationId') IS NOT association.id))
         OR (retraction.recognition_decision_supersession_id IS NOT NULL AND
             (recognition_supersession.id IS NULL OR
              support.recognition_decision_id IS NULL OR
              support.recognition_decision_id IS NOT recognition_supersession.predecessor_decision_id OR
              support.source_association_decision_id IS NOT NULL OR
              supersession_predecessor.asset_id IS NOT association.subject_id OR
              supersession_successor.asset_id IS NOT association.subject_id OR
              recognition_supersession.predecessor_decision_id = recognition_supersession.successor_decision_id OR
              supersession_successor_proposal.id IS NULL OR
              json_extract(supersession_successor_proposal.basis_json, '$.kind') = 'source-interpretation'))
         OR (retraction.recognition_decision_retraction_id IS NOT NULL AND
             (recognition_retraction.id IS NULL OR
              support.recognition_decision_id IS NULL OR
              support.recognition_decision_id IS NOT recognition_retraction.predecessor_decision_id OR
              support.source_association_decision_id IS NOT NULL))
         OR EXISTS (SELECT 1 FROM source_association_supersessions AS supersession
                    WHERE supersession.predecessor_association_id = association.id)
      LIMIT 1
    `)
    .get();
  const currentProjectionMismatch = database
    .prepare(`
      WITH derived AS (
        SELECT association.subject_id, association.id AS association_id
        FROM source_associations AS association
        JOIN source_association_establishment_supports AS support
          ON support.association_id = association.id
        WHERE NOT EXISTS (
          SELECT 1 FROM source_association_supersessions AS supersession
          WHERE supersession.predecessor_association_id = association.id
        ) AND NOT EXISTS (
          SELECT 1 FROM source_association_retractions AS retraction
          WHERE retraction.association_id = association.id
        ) AND NOT EXISTS (
          SELECT 1 FROM source_association_legacy_retirements AS retirement
          WHERE retirement.association_id = association.id
        )
      )
      SELECT 1 FROM (
        SELECT subject_id, association_id FROM current_source_associations
        EXCEPT SELECT subject_id, association_id FROM derived
      )
      UNION ALL
      SELECT 1 FROM (
        SELECT subject_id, association_id FROM derived
        EXCEPT SELECT subject_id, association_id FROM current_source_associations
      )
      LIMIT 1
    `)
    .get();
  const invalidDecision = database
    .prepare(`
      SELECT 1
      FROM source_association_decisions AS decision
      JOIN source_association_change_proposals AS proposal
        ON proposal.id = decision.proposal_id
      WHERE decision.subject_id IS NOT proposal.subject_id
         OR decision.decided_by_coordinate = ''
         OR json_valid(proposal.payload_json) <> 1
         OR json_valid(proposal.proposed_by_json) <> 1
         OR json_valid(proposal.evidence_json) <> 1
         OR json_extract(proposal.proposed_by_json, '$.kind') NOT IN ('user', 'capability')
         OR (proposal.kind IN ('establish', 'replace') AND
             (json_extract(proposal.payload_json, '$.successor.subjectId') IS NOT proposal.subject_id OR
              json_extract(proposal.payload_json, '$.successor.sourceIdentity') IS NULL OR
              json_extract(proposal.payload_json, '$.successor.nativeAddress') IS NULL))
      LIMIT 1
    `)
    .get();
  return (
    duplicateCoordinate === undefined &&
    invalidLifecycle === undefined &&
    invalidRetraction === undefined &&
    currentProjectionMismatch === undefined &&
    invalidDecision === undefined
  );
}

function hasValidObservedMaterialCheckpoints(database: DatabaseSync): boolean {
  const rows = database
    .prepare(`
      SELECT material_association_json AS raw
      FROM workflow_executions
      WHERE material_association_json IS NOT NULL
    `)
    .all() as Array<{ readonly raw: string }>;
  return rows.every(({ raw }) => {
    try {
      return decodeObservedMaterialAssociationCheckpoint(JSON.parse(raw)).valid;
    } catch {
      return false;
    }
  });
}

function hasValidObservedMaterialSupports(database: DatabaseSync): boolean {
  const invalid = database
    .prepare(`
      SELECT 1
      FROM artifact_association_recognition_supports AS support
      LEFT JOIN artifact_associations AS association
        ON association.id = support.association_id
      LEFT JOIN recognition_decisions AS decision
        ON decision.id = support.recognition_decision_id
      LEFT JOIN recognition_proposals AS proposal
        ON proposal.id = decision.proposal_id
      LEFT JOIN workflow_executions AS execution
        ON execution.id = proposal.execution_id
      WHERE association.id IS NULL OR decision.id IS NULL OR proposal.id IS NULL
        OR association.subject_id <> decision.asset_id
        OR NOT (
          (json_extract(execution.material_association_json, '$.version') =
             'observed-material-association-checkpoint/1'
           AND json_extract(execution.material_association_json, '$.submission.proposal.id') = proposal.id
           AND json_extract(execution.material_association_json, '$.submission.recognitionDecision.id') = decision.id
           AND json_extract(execution.material_association_json, '$.submission.recognitionDecision.proposalId') = proposal.id
           AND json_extract(execution.material_association_json, '$.submission.proposal.basis.observationSnapshotId') =
               json_extract(execution.material_association_json, '$.snapshot.id')
           AND EXISTS (
            SELECT 1
            FROM json_each(json_extract(execution.material_association_json, '$.submission.projections')) AS projection
            JOIN json_each(json_extract(proposal.observed_material_interpretation_json, '$.observedArtifactAssociations')) AS candidate
              ON json_extract(candidate.value, '$.observedArtifactReference') =
                 json_extract(projection.value, '$.observedArtifactReference')
             AND json_extract(candidate.value, '$.role') = association.role
            WHERE json_extract(projection.value, '$.associationId') = association.id
              AND json_extract(projection.value, '$.artifactId') = association.artifact_id
              AND EXISTS (
                SELECT 1 FROM json_each(json_extract(execution.material_association_json, '$.submission.proposal.basis.materialReferences')) AS submitted_reference
                WHERE submitted_reference.value = json_extract(projection.value, '$.observedArtifactReference')
              )
              AND EXISTS (
                SELECT 1 FROM json_each(json_extract(execution.material_association_json, '$.submission.proposal.observedArtifactAssociations')) AS submitted_candidate
                WHERE json_extract(submitted_candidate.value, '$.observedArtifactReference') =
                    json_extract(projection.value, '$.observedArtifactReference')
                  AND json_extract(submitted_candidate.value, '$.role') = association.role
              )
              AND EXISTS (
                SELECT 1 FROM json_each(json_extract(execution.material_association_json, '$.submission.artifacts')) AS submitted_artifact
                WHERE json_extract(submitted_artifact.value, '$.id') = association.artifact_id
              )
              AND EXISTS (
                SELECT 1 FROM json_each(json_extract(execution.material_association_json, '$.submission.artifactAssociations')) AS submitted_association
                WHERE json_extract(submitted_association.value, '$.id') = association.id
                  AND json_extract(submitted_association.value, '$.subjectId') = association.subject_id
                  AND json_extract(submitted_association.value, '$.artifactId') = association.artifact_id
                  AND json_extract(submitted_association.value, '$.role') = association.role
              )
              AND EXISTS (
                SELECT 1 FROM json_each(json_extract(execution.material_association_json, '$.submission.supports')) AS submitted_support
                WHERE json_extract(submitted_support.value, '$.associationId') = association.id
                  AND json_extract(submitted_support.value, '$.recognitionDecisionId') = decision.id
              )
              AND EXISTS (
                SELECT 1 FROM locations AS explicit_location
                JOIN artifact_revisions AS explicit_revision
                  ON explicit_revision.id = json_extract(projection.value, '$.revisionId')
                 AND explicit_revision.artifact_id = association.artifact_id
                JOIN blobs AS explicit_blob ON explicit_blob.digest = explicit_revision.blob_digest
                WHERE explicit_location.id = json_extract(projection.value, '$.locationId')
                  AND explicit_location.artifact_id = association.artifact_id
                  AND explicit_location.kind = 'observed'
                  AND explicit_location.address =
                    json_extract(execution.material_association_json, '$.snapshot.root') || '/' ||
                    json_extract(projection.value, '$.observedArtifactReference')
                  AND EXISTS (
                    SELECT 1
                    FROM json_each(json_extract(execution.material_association_json, '$.submission.locations')) AS submitted_location
                    WHERE json_extract(submitted_location.value, '$.id') = explicit_location.id
                      AND json_extract(submitted_location.value, '$.artifactId') = association.artifact_id
                      AND json_extract(submitted_location.value, '$.kind') = 'observed'
                      AND json_extract(submitted_location.value, '$.address') = explicit_location.address
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM json_each(json_extract(execution.material_association_json, '$.submission.artifactRevisions')) AS submitted_revision
                    JOIN json_each(json_extract(execution.material_association_json, '$.submission.blobs')) AS submitted_blob
                      ON json_extract(submitted_blob.value, '$.digest') = explicit_revision.blob_digest
                    JOIN json_each(json_extract(proposal.observed_material_interpretation_json, '$.observedArtifactRevisions')) AS proposed_revision
                      ON json_extract(proposed_revision.value, '$.observedArtifactReference') =
                         json_extract(projection.value, '$.observedArtifactReference')
                     AND json_extract(proposed_revision.value, '$.blob.digest') = explicit_revision.blob_digest
                    WHERE json_extract(submitted_revision.value, '$.id') = explicit_revision.id
                      AND json_extract(submitted_revision.value, '$.artifactId') = association.artifact_id
                      AND json_extract(submitted_revision.value, '$.blobDigest') = explicit_revision.blob_digest
                      AND json_extract(submitted_blob.value, '$.mediaType') = explicit_blob.media_type
                      AND json_extract(submitted_blob.value, '$.byteLength') = explicit_blob.byte_length
                      AND json_extract(proposed_revision.value, '$.blob.mediaType') = explicit_blob.media_type
                      AND json_extract(proposed_revision.value, '$.blob.byteLength') = explicit_blob.byte_length
                  )
              )
          ))
          OR (execution.material_association_json IS NULL AND (EXISTS (
            SELECT 1
            FROM json_each(json_extract(proposal.observed_material_interpretation_json, '$.observedArtifactAssociations')) AS projected_candidate
            JOIN json_each(json_extract(proposal.observed_material_interpretation_json, '$.observedArtifactRevisions')) AS projected_revision
              ON json_extract(projected_revision.value, '$.observedArtifactReference') =
                 json_extract(projected_candidate.value, '$.observedArtifactReference')
            JOIN locations AS projected_location
              ON projected_location.artifact_id = association.artifact_id
             AND projected_location.kind = 'observed'
             AND projected_location.address = json_extract(execution.snapshot_json, '$.root') || '/' ||
                 json_extract(projected_candidate.value, '$.observedArtifactReference')
            JOIN artifact_revisions AS durable_revision
              ON durable_revision.artifact_id = association.artifact_id
             AND durable_revision.blob_digest = json_extract(projected_revision.value, '$.blob.digest')
            WHERE json_extract(projected_candidate.value, '$.role') = association.role
          )
          OR EXISTS (
            SELECT 1
            FROM locations AS location
            JOIN artifact_revisions AS revision
              ON revision.artifact_id = association.artifact_id
            WHERE location.artifact_id = association.artifact_id
              AND location.kind = 'observed'
              AND (
                (json_extract(proposal.basis_json, '$.kind') = 'observed-evidence'
                 AND EXISTS (
                   SELECT 1 FROM json_each(json_extract(proposal.basis_json, '$.artifactRevisions')) AS material
                   WHERE location.address = json_extract(execution.snapshot_json, '$.root') || '/' ||
                     json_extract(material.value, '$.observedArtifactReference')
                     AND revision.blob_digest = json_extract(material.value, '$.blob.digest')
                 ))
                OR
                (json_extract(proposal.basis_json, '$.kind') = 'manual-boundary'
                 AND EXISTS (
                   SELECT 1
                   FROM json_each(json_extract(proposal.basis_json, '$.materialReferences')) AS material
                   JOIN json_each(json_extract(proposal.basis_json, '$.evidence')) AS evidence
                     ON json_extract(evidence.value, '$.inspection.observedArtifactReference') = material.value
                   WHERE location.address = json_extract(execution.snapshot_json, '$.root') || '/' || material.value
                     AND revision.blob_digest = json_extract(evidence.value, '$.inspection.revision.digest')
                 ))
              )
          )))
        )
      LIMIT 1
    `)
    .get();
  if (invalid !== undefined) return false;
  const missing = database
    .prepare(`
      WITH expected(asset_id, decision_id, proposal_id, execution_id, reference, digest, root, association_id, location_id, revision_id) AS (
        SELECT head.subject_id, decision.id, proposal.id, execution.id,
               json_extract(revision.value, '$.observedArtifactReference'),
               json_extract(revision.value, '$.blob.digest'),
               json_extract(execution.snapshot_json, '$.root'), NULL, NULL, NULL
        FROM recognition_heads AS head
        JOIN recognition_decisions AS decision ON decision.id = head.recognition_decision_id
        JOIN recognition_proposals AS proposal ON proposal.id = decision.proposal_id
        JOIN workflow_executions AS execution ON execution.id = proposal.execution_id
        JOIN json_each(json_extract(proposal.observed_material_interpretation_json, '$.observedArtifactRevisions')) AS revision
        JOIN json_each(json_extract(proposal.observed_material_interpretation_json, '$.observedArtifactAssociations')) AS candidate
          ON json_extract(candidate.value, '$.observedArtifactReference') =
             json_extract(revision.value, '$.observedArtifactReference')
         AND json_extract(candidate.value, '$.role') = 'asset.material-delivered'
        WHERE execution.material_association_json IS NULL
          AND json_extract(proposal.basis_json, '$.kind') = 'manual-boundary'
        UNION
        SELECT head.subject_id, decision.id, proposal.id, execution.id,
               json_extract(revision.value, '$.observedArtifactReference'),
               json_extract(revision.value, '$.blob.digest'),
               json_extract(execution.snapshot_json, '$.root'), NULL, NULL, NULL
        FROM recognition_heads AS head
        JOIN recognition_decisions AS decision ON decision.id = head.recognition_decision_id
        JOIN recognition_proposals AS proposal ON proposal.id = decision.proposal_id
        JOIN workflow_executions AS execution ON execution.id = proposal.execution_id
        JOIN json_each(json_extract(proposal.basis_json, '$.artifactRevisions')) AS revision
        JOIN json_each(json_extract(proposal.observed_material_interpretation_json, '$.observedArtifactAssociations')) AS candidate
          ON json_extract(candidate.value, '$.observedArtifactReference') =
             json_extract(revision.value, '$.observedArtifactReference')
         AND json_extract(candidate.value, '$.role') = 'asset.material-delivered'
        WHERE json_extract(proposal.basis_json, '$.kind') = 'observed-evidence'
          AND execution.material_association_json IS NULL
        UNION
        SELECT head.subject_id, decision.id, proposal.id, execution.id, material.value,
               json_extract(evidence.value, '$.inspection.revision.digest'),
               json_extract(execution.snapshot_json, '$.root'), NULL, NULL, NULL
        FROM recognition_heads AS head
        JOIN recognition_decisions AS decision ON decision.id = head.recognition_decision_id
        JOIN recognition_proposals AS proposal ON proposal.id = decision.proposal_id
        JOIN workflow_executions AS execution ON execution.id = proposal.execution_id
        JOIN json_each(json_extract(proposal.basis_json, '$.materialReferences')) AS material
        JOIN json_each(json_extract(proposal.basis_json, '$.evidence')) AS evidence
          ON json_extract(evidence.value, '$.inspection.observedArtifactReference') = material.value
        JOIN json_each(json_extract(proposal.observed_material_interpretation_json, '$.observedArtifactAssociations')) AS candidate
          ON json_extract(candidate.value, '$.observedArtifactReference') = material.value
         AND json_extract(candidate.value, '$.role') = 'asset.material-delivered'
        WHERE json_extract(proposal.basis_json, '$.kind') = 'manual-boundary'
          AND execution.material_association_json IS NULL
        UNION
        SELECT decision.asset_id, decision.id, proposal.id, execution.id,
               json_extract(projection.value, '$.observedArtifactReference'),
               revision.blob_digest, json_extract(execution.snapshot_json, '$.root'),
               json_extract(projection.value, '$.associationId'),
               json_extract(projection.value, '$.locationId'),
               json_extract(projection.value, '$.revisionId')
        FROM recognition_decisions AS decision
        JOIN recognition_proposals AS proposal ON proposal.id = decision.proposal_id
        JOIN workflow_executions AS execution ON execution.id = proposal.execution_id
        JOIN json_each(json_extract(execution.material_association_json, '$.submission.projections')) AS projection
        JOIN artifact_revisions AS revision
          ON revision.id = json_extract(projection.value, '$.revisionId')
        WHERE json_extract(execution.material_association_json, '$.version') =
          'observed-material-association-checkpoint/1'
      )
      SELECT 1 FROM expected
      JOIN locations AS location
        ON ((expected.location_id IS NULL AND
             location.address = expected.root || '/' || expected.reference)
            OR location.id = expected.location_id)
       AND location.kind = 'observed'
      JOIN artifact_revisions AS revision
        ON revision.artifact_id = location.artifact_id
       AND revision.blob_digest = expected.digest
       AND (expected.revision_id IS NULL OR revision.id = expected.revision_id)
      JOIN artifact_associations AS association
        ON association.artifact_id = location.artifact_id
       AND association.subject_id = expected.asset_id
       AND association.role = 'asset.material-delivered'
       AND association.source_record_ids_json = '[]'
       AND association.source_association_id IS NULL
       AND (expected.association_id IS NULL OR association.id = expected.association_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM artifact_association_retractions AS ending
        WHERE ending.association_id = association.id
      ) AND NOT EXISTS (
        SELECT 1 FROM artifact_association_supersessions AS ending
        WHERE ending.predecessor_association_id = association.id
      ) AND NOT EXISTS (
        SELECT 1 FROM artifact_association_recognition_supports AS support
        WHERE support.association_id = association.id
          AND support.recognition_decision_id = expected.decision_id
      )
      LIMIT 1
    `)
    .get();
  return missing === undefined;
}

/** 在同一迁移事务内，以 Application 的递归精确 decoder 守住旧来源补充重放。 */
export function assertExactLegacySourceEnrichmentAuthority(
  database: DatabaseSync,
): void {
  const authorities = database
    .prepare(`
      SELECT execution.id,
             execution.workflow_input_json AS workflow_input,
             execution.compatibility_json AS compatibility,
             execution.source_record_ids_json AS source_record_ids,
             execution.source_enrichments_json AS source_enrichments,
             execution.accepted_asset_id,
             checkpoint.value AS authority_checkpoint
      FROM workflow_executions AS execution,
           json_each(execution.source_enrichments_json) AS checkpoint
      WHERE json_extract(checkpoint.value, '$.stage') = 'applied'
    `)
    .all() as Array<{
    readonly id: string;
    readonly workflow_input: string | null;
    readonly compatibility: string;
    readonly source_record_ids: string;
    readonly source_enrichments: string;
    readonly accepted_asset_id: string | null;
    readonly authority_checkpoint: string;
  }>;
  if (
    authorities.some((row) => {
      try {
        return !isExactLegacySourceEnrichmentExecutionAuthority({
          executionId: row.id,
          workflowInput: JSON.parse(row.workflow_input ?? "null"),
          compatibility: JSON.parse(row.compatibility),
          sourceRecordIds: JSON.parse(row.source_record_ids),
          sourceEnrichments: JSON.parse(row.source_enrichments),
          acceptedAssetId: row.accepted_asset_id,
          authorityCheckpoint: JSON.parse(row.authority_checkpoint),
        });
      } catch {
        return true;
      }
    })
  )
    throw new Error("旧来源补充权威结构无效");
}

function matchesCatalogueSchemaWithProductionLedger(
  database: DatabaseSync,
): boolean {
  // 生产账本是部署元数据，不是 Application 持久化。只移除两个明确命名的账本表，
  // 同时继续严格审阅 Catalogue 管理的每个结构。
  const ledgers = [
    "__digital_catalogue_migrations",
    "__digital_catalogue_migration_failures",
  ];
  const statements = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
    )
    .all(...ledgers) as Array<{ readonly sql: string | null }>;
  if (
    statements.length !== ledgers.length ||
    statements.some(({ sql }) => sql === null)
  )
    return false;
  const copies = new DatabaseSync(":memory:");
  try {
    for (const { sql } of database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__digital_catalogue_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ readonly sql: string | null }>) {
      if (sql === null) return false;
      copies.exec(sql);
    }
    for (const { sql } of database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name NOT LIKE '__digital_catalogue_%' ORDER BY name",
      )
      .all() as Array<{ readonly sql: string | null }>) {
      if (sql === null) return false;
      copies.exec(sql);
    }
    return matchesReviewedCatalogueSchema(copies);
  } finally {
    copies.close();
  }
}

export function assertProductionCatalogueReady(
  readiness: ProductionCatalogueReadiness,
): void {
  if (readiness.state !== "ready")
    throw new Error(
      `SQLite catalogue schema is not prepared; ${readiness.message}`,
    );
}
