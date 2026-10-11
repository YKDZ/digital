import { access } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  decodeObservedMaterialAssociationCheckpoint,
  decodeRecognitionBasis,
  decodeSourceAssociationChangeProposal,
  decodeSourceAssociationDecisionCheckpoint,
  decodeSourceInterpretationBatch,
  decodeSourcedEntity,
  decodeWorkflowExecutionInput,
  isExactLegacySourceEnrichmentExecutionAuthority,
  isObservedRootAutomationScope,
  type WorkflowExecution,
  validateSourceAssociationDecisionEnvelope,
  validateSourceAssociationDecisionPriorExecution,
} from "@digital/application";
import {
  type DescriptionTarget,
  artifactRoleDecisionKey,
} from "@digital/domain";

import { readDerivedEntityCoverReadiness } from "./derived-entity-cover-history.ts";
import { matchesReviewedCatalogueSchema } from "./schema-contract.ts";
import { workflowExecutionAuditVersion } from "./schema.ts";
import { canonicalJson } from "./workflow-execution-persistence.ts";

export const productionCatalogueMigrationHead =
  "20261007030000_library_scan_fulfillment";
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
    id: "20260908000000_current_user_interactions",
    checksum:
      "f38d3d1a6a1e16ed98081e21ec99f7c3e56fa15f705ccc1686b761b5f2900424",
  },
  {
    id: "20260909000000_current_file_observation_supports",
    checksum:
      "71c7e999e5b76b3983fbadf6b404a217c25823a8d116126dadcbd3349edf4394",
  },
  {
    id: "20260910000000_description_targets",
    checksum:
      "3ac373d5c3df37bb273a861cb9110c600e5231f1bf27bede5d06989b7d6f7364",
  },
  {
    id: "20260913010000_named_relationship_participants",
    checksum:
      "44b251bdd24c119cf3e6a946831890a86e506bb09ea7b16254fa07cefd6f11b7",
  },
  {
    id: "20260913020000_entity_kind_assertions",
    checksum:
      "82a9a4e75702cde19ea45c80eb507c966ea43055fdb6a883af3e743663b7c8c2",
  },
  {
    id: "20260913030000_entity_kind_lifecycles",
    checksum:
      "bd6998c459bfd1bad7dd33d6f4b0091bb005ad99d909ecd5f724a981ee5cb10a",
  },
  {
    id: "20260913035000_observed_entity_graph",
    checksum:
      "340a0789e19fc3c800ad674e27bb862674db2313a42b0523644ff3835d518ab2",
  },
  {
    id: "20260913040000_effective_relationship_decisions",
    checksum:
      "edd166f906da5f4453ca4e2ec21101e4849aada49bd6d2bb0882719376a912a1",
  },
  {
    id: "20260913050000_entity_identity_merges",
    checksum:
      "d70617a53f869449007dc548c71c4ca00f95b2976ea3ab357d58e20145bb9129",
  },
  {
    id: "20260915000000_named_relationship_snapshots",
    checksum:
      "d6341f130ae1f9f1c81bf4b79be0f56c54bb9afa2bec2439d6ccbf40f21e064a",
  },
  {
    id: "20260920000000_selected_relationship_targets",
    checksum:
      "e75a92ec15b4b2d8e5dd1f02c55db83cf9458f84f315d9d1baee31e88274f0cd",
  },
  {
    id: "20261003000000_current_observed_material_supports",
    checksum:
      "79c8c8cf63e2a9425dedae6060facc3d31a3634443db1d0553bc542137be85ef",
  },
  {
    id: "20261003000000_unbind_local_user",
    checksum:
      "2cec585f48aac97ed78c2d4a3b825754c279ac05290ce53ef170d460a95cc45e",
  },
  {
    id: "20261003010000_ordinary_people_and_personas",
    checksum:
      "497ace5c5beefc14c1a4255990e1e7c52ea9e05d4e14ae45d1a7c8b033a3eb9a",
  },
  {
    id: "20261006000000_persistent_asset_boundaries",
    checksum:
      "19cc3920013cfc9ad398cc7059862e172953f79e0e608a4e1a35c435d421a815",
  },
  {
    id: "20261006010000_asset_libraries",
    checksum:
      "7315e59bc5c6de089e46186c1bbec2da20649e564869d251c0b5d74af3a4df37",
  },
  {
    id: "20261006020000_local_observation_support_evidence",
    checksum:
      "920997c4c702276cd244a898eb0f8ddfc3928f6eb125b1dac303945762b09d65",
  },
  {
    id: "20261007000000_artifact_role_decisions",
    checksum:
      "ac68c0fa5aa1b1ff9cfe22a0dbfa57aa32ef30ad4450f6c61dfea82857c1fbf0",
  },
  {
    id: "20261007000000_library_scan_directory_control",
    checksum:
      "a836eec944a7437357888a09ce9db8643af31b20b16327bed8fffa26fe306b69",
  },
  {
    id: "20261007010000_library_directory_grants",
    checksum:
      "45fa0681764fd4e19edd7d26850016fc1d6155f2229adabc2bf26b2cc9b007ce",
  },
  {
    id: "20261007020000_library_grant_awaiting_observation",
    checksum:
      "a87461eb27f3d80ca84855149e8156e1927fafe94b1fed49fc1c80044e14cecc",
  },
  {
    id: productionCatalogueMigrationHead,
    checksum:
      "02051a927ee19bfae68b095bb3bb8a8c4fac0e75a879f644143a55dd9b9d36e0",
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
    if (!hasValidDefaultLocalUser(database)) {
      return {
        state: "catalogue-integrity-failed",
        message:
          "Catalogue 本地用户身份不完整或冲突；重新运行匹配版本的部署工具或从离线备份恢复",
      };
    }
    if (!hasValidAssetLibraryConfiguration(database)) {
      return {
        state: "catalogue-integrity-failed",
        message:
          "Catalogue 资产库配置或目录引用不完整或相互矛盾；从离线备份恢复或联系部署维护者",
      };
    }
    if (
      !hasValidObservedMaterialCheckpoints(database) ||
      !hasValidObservedMaterialSupports(database) ||
      !hasValidCurrentObservedMaterialRecords(database) ||
      !hasValidSourceAssociationState(database)
    ) {
      return {
        state: "catalogue-integrity-failed",
        message:
          "Catalogue 观察材料决定支持链损坏；从离线备份恢复或联系部署维护者",
      };
    }
    if (!hasValidArtifactRoleDecisionHeads(database)) {
      return {
        state: "catalogue-integrity-failed",
        message:
          "Catalogue 人工产物角色决定头损坏或同一坐标存在多个当前头；从离线备份恢复或联系部署维护者",
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

function hasValidArtifactRoleDecisionHeads(database: DatabaseSync): boolean {
  const rows = database
    .prepare(
      `SELECT head.target_key AS target_key, head.decision_id AS decision_id,
              decision.role AS role, decision.target_kind AS target_kind,
              decision.target_entity_id AS target_entity_id,
              decision.target_artifact_id AS target_artifact_id,
              decision.target_revision_id AS target_revision_id,
              (SELECT COUNT(*) FROM artifact_role_decision_heads AS other
                WHERE other.decision_id = head.decision_id) AS head_count
       FROM artifact_role_decision_heads AS head
       LEFT JOIN artifact_role_decisions AS decision
         ON decision.id = head.decision_id`,
    )
    .all() as Array<{
    readonly target_key: string;
    readonly decision_id: string;
    readonly role: string | null;
    readonly target_kind: string | null;
    readonly target_entity_id: string | null;
    readonly target_artifact_id: string | null;
    readonly target_revision_id: string | null;
    readonly head_count: number;
  }>;
  return rows.every((row) => {
    if (row.role === null || row.head_count !== 1) return false;
    let target: DescriptionTarget | undefined;
    if (
      row.target_kind === "entity" &&
      row.target_entity_id !== null &&
      row.target_artifact_id === null &&
      row.target_revision_id === null
    )
      target = { kind: "entity", entityId: row.target_entity_id };
    else if (
      row.target_kind === "artifact-revision" &&
      row.target_entity_id === null &&
      row.target_artifact_id !== null &&
      row.target_revision_id !== null
    )
      target = {
        kind: "artifact-revision",
        artifactId: row.target_artifact_id,
        revisionId: row.target_revision_id,
      };
    return (
      target !== undefined &&
      artifactRoleDecisionKey(target, row.role) === row.target_key
    );
  });
}

function hasValidAssetLibraryConfiguration(database: DatabaseSync): boolean {
  const rootStatuses = new Map(
    (
      database
        .prepare("SELECT id, status FROM observed_root_registrations")
        .all() as Array<{ readonly id: string; readonly status: string }>
    ).map((row) => [row.id, row.status]),
  );
  const libraries = database
    .prepare(
      `SELECT id, display_name AS displayName, config_version AS configVersion, status,
              root_ids_json AS rootIdsJson, recognition_profile_ids_json AS recognitionProfileIdsJson,
              source_identities_json AS sourceIdentitiesJson
       FROM asset_libraries`,
    )
    .all() as Array<{
    readonly id: string;
    readonly displayName: string;
    readonly configVersion: number;
    readonly status: string;
    readonly rootIdsJson: string;
    readonly recognitionProfileIdsJson: string;
    readonly sourceIdentitiesJson: string;
  }>;
  const rootIdsByLibrary = new Map<string, readonly string[]>();
  for (const library of libraries) {
    if (
      library.displayName.trim().length === 0 ||
      !Number.isSafeInteger(library.configVersion) ||
      library.configVersion < 1 ||
      (library.status !== "active" && library.status !== "removed")
    )
      return false;
    const lists = [
      library.rootIdsJson,
      library.recognitionProfileIdsJson,
      library.sourceIdentitiesJson,
    ].map((value) => JSON.parse(value) as unknown);
    if (
      lists.some(
        (list) =>
          !Array.isArray(list) ||
          list.some(
            (item: unknown) => typeof item !== "string" || item.length === 0,
          ) ||
          new Set(list).size !== list.length,
      )
    )
      return false;
    const rootIds = lists[0] as readonly string[];
    rootIdsByLibrary.set(library.id, rootIds);
    if (library.status === "active") {
      if (
        rootIds.length === 0 ||
        rootIds.some((id) => rootStatuses.get(id) !== "active")
      )
        return false;
      continue;
    }
    if (rootIds.some((id) => !rootStatuses.has(id))) return false;
  }
  const intents = database
    .prepare(
      "SELECT scope_json AS scopeJson, enabled AS enabled, disabled_reason AS disabledReason FROM automation_intents",
    )
    .all() as Array<{
    readonly scopeJson: string;
    readonly enabled: number;
    readonly disabledReason: string | null;
  }>;
  const grants = new Set(
    (
      database
        .prepare(
          "SELECT library_id AS libraryId, observed_root_id AS observedRootId FROM library_directory_grants",
        )
        .all() as Array<{
        readonly libraryId: string;
        readonly observedRootId: string;
      }>
    ).map((grant) => `${grant.libraryId}\u0000${grant.observedRootId}`),
  );
  for (const intent of intents) {
    let scope: unknown;
    try {
      scope = JSON.parse(intent.scopeJson) as unknown;
    } catch {
      return false;
    }
    // 沿运行时解码使用的同一观察根 scope 契约校验，缺字段或非法拼写都不算有效归属。
    if (!isObservedRootAutomationScope(scope)) return false;
    if (scope.assetLibraryId === undefined) return false;
    const rootIds = rootIdsByLibrary.get(scope.assetLibraryId);
    if (rootIds === undefined) return false;
    const inCurrentLibrary = rootIds.includes(scope.observedRootId);
    // 仍可触发的计划必须落在本库今日授权的目录集合内，否则它会在触发时才暴露归属缺失。
    if (intent.enabled === 1 && !inCurrentLibrary) return false;
    if (inCurrentLibrary) continue;
    // 已停用且目录已移出本库的计划只是历史：它不能再运行，但必须继续耐久保留并给出停用原因，
    // 因此这里只要求它指向本库确有记录的目录授权，而不是今日仍在观察的那批目录。
    if (intent.disabledReason === null || intent.disabledReason.trim() === "")
      return false;
    if (!grants.has(`${scope.assetLibraryId}\u0000${scope.observedRootId}`))
      return false;
  }
  return true;
}

function hasValidDefaultLocalUser(database: DatabaseSync): boolean {
  const users = database
    .prepare("SELECT user_id AS userId FROM local_users")
    .all() as Array<{ readonly userId: string }>;
  return users.length === 1 && users[0]?.userId === "local-user";
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

/**
 * 每个执行自己冻结的观察根坐标与完整 snapshot。耐久材料行只由这两个来源写入（正式迁移
 * 回放与运行时接受），所以它们的根、snapshot、时刻与授权闭包必须能在同源坐标里解释。
 */
const observedMaterialFrozenCoordinates = `
	frozen_roots AS (
		SELECT executions.id AS execution_id,
					 json_extract(root.value, '$.id') AS root_id,
					 CAST(json_extract(root.value, '$.configVersion') AS INTEGER) AS root_version,
					 json_extract(root.value, '$.containerPath') AS root_path,
					 COALESCE(json_extract(root.value, '$.authorizedTargetRoots'), '[]')
					 AS authorized_targets_json
		FROM workflow_executions AS executions
		CROSS JOIN json_each(
			COALESCE(json_extract(executions.workflow_input_json, '$.observedRoots'), '[]')
		) AS root
		UNION ALL
		-- 追加材料的 workflow input 不带根，只取该执行 resolved selection 的冻结根。
		SELECT executions.id,
					 json_extract(scope.value, '$.observedRoot.id'),
					 CAST(json_extract(scope.value, '$.observedRoot.configVersion') AS INTEGER),
					 json_extract(scope.value, '$.observedRoot.containerPath'),
					 COALESCE(
						 json_extract(scope.value, '$.observedRoot.authorizedTargetRoots'), '[]')
		FROM workflow_executions AS executions
		CROSS JOIN json_each(
			COALESCE(
				json_extract(executions.resolved_selection_json, '$.filesystemScopes'), '[]')
		) AS scope
		WHERE json_extract(executions.material_association_json, '$.version') =
					'observed-material-association-checkpoint/1'
			AND json_extract(executions.material_association_json, '$.state') = 'accepted'
	),
	frozen_snapshots AS (
		SELECT executions.id AS execution_id,
					 json_extract(snapshot.value, '$.id') AS snapshot_id,
					 json_extract(snapshot.value, '$.root') AS snapshot_root,
					 json_extract(snapshot.value, '$.observedAt') AS observed_at,
					 json_extract(snapshot.value, '$.complete') AS complete
		FROM workflow_executions AS executions
		CROSS JOIN json_each(COALESCE(executions.filesystem_snapshots_json, '[]')) AS snapshot
		UNION ALL
		SELECT executions.id,
					 json_extract(executions.snapshot_json, '$.id'),
					 json_extract(executions.snapshot_json, '$.root'),
					 json_extract(executions.snapshot_json, '$.observedAt'),
					 json_extract(executions.snapshot_json, '$.complete')
		FROM workflow_executions AS executions
		WHERE executions.snapshot_json IS NOT NULL
			AND executions.filesystem_snapshots_json IS NULL
	)
`;

/**
 * 三张当前材料表的耐久内容闭锁。只校验已依赖的固定关系与本执行冻结的根、snapshot
 * 坐标同源；没有正向支持、旧根版本与 inactive 登记都是健康状态，不在这里判坏。
 */
function hasValidCurrentObservedMaterialRecords(
  database: DatabaseSync,
): boolean {
  const invalidBoundary = database
    .prepare(
      `
      SELECT 1
      FROM observed_material_boundaries AS boundary
      LEFT JOIN locations AS location ON location.id = boundary.location_id
      WHERE location.kind IS NOT 'observed'
         OR location.artifact_id IS NOT boundary.artifact_id
         OR boundary.material_kind NOT IN ('file', 'directory')
         OR boundary.derivation_kind NOT IN
            ('accepted-exact', 'legacy-exact', 'legacy-kind-equivalent')
      LIMIT 1
    `,
    )
    .get();
  if (invalidBoundary !== undefined) return false;

  const invalidAcceptance = database
    .prepare(
      `
      WITH ${observedMaterialFrozenCoordinates}
      SELECT 1
      FROM observed_material_acceptances AS acceptance
      LEFT JOIN locations AS location ON location.id = acceptance.location_id
      LEFT JOIN artifact_associations AS association
        ON association.id = acceptance.association_id
      LEFT JOIN workflow_executions AS execution ON execution.id = acceptance.execution_id
      LEFT JOIN recognition_proposals AS proposal ON proposal.id = acceptance.proposal_id
      LEFT JOIN observed_material_boundaries AS boundary
        ON boundary.location_id = acceptance.location_id
      WHERE location.kind IS NOT 'observed'
         OR location.artifact_id IS NOT acceptance.artifact_id
         OR (association.id IS NULL
             OR association.artifact_id IS NOT acceptance.artifact_id
             OR association.role IS NOT 'asset.material-delivered'
             OR association.target_kind IS NOT 'entity'
             OR association.subject_id IS NOT acceptance.asset_id)
         OR execution.id IS NULL
         OR proposal.id IS NULL
         -- 沿 acceptance_kind 校验该记录自己的载体来源：a-work-item 的 key、proposal、
         -- acceptedAsset 必须落在同一执行 work_items_json 的同一个 item 上，没有工作项的
         -- 受信接受则必须由该执行自己的顶层 proposal／acceptedAsset 解释；b-local 取顶层
         -- manual-boundary 执行自身；c-association 取同执行 accepted checkpoint 的
         -- submission；a-preview 取自己那条已确认应用的识别取代预演。
         OR (acceptance.acceptance_kind = 'a-work-item'
             AND acceptance.work_item_key <> ''
             AND NOT EXISTS (
               SELECT 1 FROM json_each(COALESCE(execution.work_items_json, '[]')) AS item
               WHERE json_extract(item.value, '$.key') IS acceptance.work_item_key
                 AND json_extract(item.value, '$.proposalId') IS acceptance.proposal_id
                 AND json_extract(item.value, '$.acceptedAssetId') IS acceptance.asset_id))
         OR (acceptance.acceptance_kind = 'a-work-item'
             AND acceptance.work_item_key = ''
             AND (execution.proposal_id IS NOT acceptance.proposal_id
                  OR execution.accepted_asset_id IS NOT acceptance.asset_id))
         OR (acceptance.acceptance_kind = 'b-local'
             AND (execution.proposal_id IS NOT acceptance.proposal_id
                  OR execution.accepted_asset_id IS NOT acceptance.asset_id
                  OR json_extract(proposal.basis_json, '$.kind') IS NOT 'manual-boundary'))
         OR (acceptance.acceptance_kind = 'c-association'
             AND (json_extract(execution.material_association_json, '$.version')
                    IS NOT 'observed-material-association-checkpoint/1'
                  OR json_extract(execution.material_association_json, '$.state')
                       IS NOT 'accepted'
                  OR json_extract(execution.material_association_json,
                       '$.submission.proposal.id') IS NOT acceptance.proposal_id
                  OR json_extract(execution.material_association_json,
                       '$.submission.recognitionDecision.assetId') IS NOT acceptance.asset_id
                  OR json_extract(execution.material_association_json, '$.snapshot.id')
                       IS NOT acceptance.snapshot_id
                  OR NOT EXISTS (
                    SELECT 1 FROM json_each(
                      json_extract(execution.material_association_json,
                        '$.submission.projections')) AS projection
                    WHERE json_extract(projection.value, '$.locationId')
                            IS acceptance.location_id
                      AND json_extract(projection.value, '$.associationId')
                            IS acceptance.association_id
                      AND json_extract(projection.value, '$.artifactId')
                            IS acceptance.artifact_id
                      AND json_extract(projection.value, '$.observedArtifactReference')
                            IS acceptance.observed_reference)))
         OR (acceptance.acceptance_kind = 'a-preview'
             AND NOT EXISTS (
               SELECT 1 FROM change_impact_previews AS preview
               WHERE preview.execution_id IS acceptance.execution_id
                 AND preview.status = 'applied'
                 AND preview.asset_id IS acceptance.asset_id
                 AND json_extract(preview.preview_json, '$.change.kind')
                       IN ('recognition-supersession', 'recognition-scope-amendment')
                 AND json_extract(preview.preview_json, '$.change.proposal.id')
                       IS acceptance.proposal_id
                 AND EXISTS (
                   SELECT 1 FROM json_each(
                     json_extract(preview.preview_json, '$.projected.locations'))
                     AS projected_location
                   WHERE json_extract(projected_location.value, '$.id')
                           IS acceptance.location_id)
                 AND NOT EXISTS (
                   SELECT 1 FROM json_each(
                     json_extract(preview.preview_json, '$.current.locations'))
                     AS current_location
                   WHERE json_extract(current_location.value, '$.id')
                           IS acceptance.location_id)
                 AND EXISTS (
                   SELECT 1 FROM json_each(
                     json_extract(preview.preview_json, '$.projected.artifactAssociations'))
                     AS projected_association
                   WHERE json_extract(projected_association.value, '$.id')
                           IS acceptance.association_id)
                 AND NOT EXISTS (
                   SELECT 1 FROM json_each(
                     json_extract(preview.preview_json, '$.current.artifactAssociations'))
                     AS current_association
                   WHERE json_extract(current_association.value, '$.id')
                           IS acceptance.association_id)))
         OR (acceptance.acceptance_kind <> 'a-work-item'
             AND acceptance.work_item_key <> '')
         OR boundary.location_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM frozen_snapshots AS snapshot
           WHERE snapshot.execution_id IS acceptance.execution_id
             AND snapshot.snapshot_id IS acceptance.snapshot_id
             AND snapshot.complete = 1
             AND location.address = CASE acceptance.observed_reference
               WHEN '.' THEN snapshot.snapshot_root
               ELSE snapshot.snapshot_root || '/' || acceptance.observed_reference
             END
         )
      LIMIT 1
    `,
    )
    .get();
  if (invalidAcceptance !== undefined) return false;

  const invalidSupport = database
    .prepare(
      `
      WITH ${observedMaterialFrozenCoordinates}
      SELECT 1
      FROM current_observed_material_supports AS support
      LEFT JOIN locations AS location ON location.id = support.location_id
      LEFT JOIN observed_material_boundaries AS boundary
        ON boundary.location_id = support.location_id
      WHERE location.kind IS NOT 'observed'
         OR boundary.location_id IS NULL
         OR boundary.material_kind IS NOT support.material_kind
         OR support.material_kind NOT IN ('file', 'directory')
         OR json_valid(support.authorized_targets_json) <> 1
         OR json_type(support.authorized_targets_json) <> 'array'
         OR NOT EXISTS (
           SELECT 1
           FROM frozen_roots AS root
           INNER JOIN frozen_snapshots AS snapshot
             ON snapshot.execution_id IS root.execution_id
            AND snapshot.snapshot_id IS support.snapshot_id
            AND snapshot.observed_at IS support.observed_at
            AND snapshot.complete = 1
            AND (snapshot.snapshot_root = root.root_path
              OR substr(snapshot.snapshot_root, 1, length(root.root_path) + 1) =
                 root.root_path || '/')
            AND (location.address = snapshot.snapshot_root
              OR substr(location.address, 1, length(snapshot.snapshot_root) + 1) =
                 snapshot.snapshot_root || '/')
           WHERE root.root_id IS support.observed_root_id
             AND root.root_version = support.observed_root_version
             AND root.root_path IS support.observed_root_path
             AND json_array_length(root.authorized_targets_json) =
                 json_array_length(support.authorized_targets_json)
             AND NOT EXISTS (
               SELECT 1 FROM json_each(support.authorized_targets_json) AS stored
               WHERE NOT EXISTS (
                 SELECT 1 FROM json_each(root.authorized_targets_json) AS frozen
                 WHERE json_extract(frozen.value, '$.id') IS json_extract(stored.value, '$.id')
                   AND CAST(json_extract(frozen.value, '$.configVersion') AS INTEGER) =
                       CAST(json_extract(stored.value, '$.configVersion') AS INTEGER)
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM json_each(root.authorized_targets_json) AS frozen
               WHERE NOT EXISTS (
                 SELECT 1 FROM json_each(support.authorized_targets_json) AS stored
                 WHERE json_extract(stored.value, '$.id') IS json_extract(frozen.value, '$.id')
                   AND CAST(json_extract(stored.value, '$.configVersion') AS INTEGER) =
                       CAST(json_extract(frozen.value, '$.configVersion') AS INTEGER)
               )
             )
         )
      LIMIT 1
    `,
    )
    .get();
  return invalidSupport === undefined;
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

/**
 * 带精确观察证据的本地关联支持的当前资格，就绪检查里的 SQL 形式。它与 SQLite 读写
 * 路径共用的 `isCurrentLocalObservationEvidence` 表达同一条规则：关联必须属于该决定
 * 的资产产物图，记录的位置仍是当前观察成员，且文件（含 part 的载体）修订仍与当前
 * 确认修订相交。过期证据在这里只是否定当前资格，绝不使已经完整落库的历史失效；
 * 就绪的其他分支继续按原执行、快照与载体回查历史结构完整性。
 * 引用的表别名固定为 `support`、`association`、`decision`。
 */
export const currentLocalObservationSupportSql = `
  support.observation_location_id IS NOT NULL
  AND support.observation_execution_id IS NOT NULL
  AND support.observation_snapshot_id IS NOT NULL
  AND support.observation_material_kind IN ('file', 'directory')
  AND association.subject_id = decision.asset_id
  AND EXISTS (
    SELECT 1 FROM locations AS material_location
    WHERE material_location.id = support.observation_location_id
      AND material_location.kind = 'observed'
      AND material_location.artifact_id = COALESCE(
        json_extract(association.observed_artifact_part_json, '$.artifactId'),
        association.artifact_id
      )
      AND (
        (
          support.observation_material_kind = 'directory'
          AND support.observation_revision_id IS NULL
          AND EXISTS (
            SELECT 1 FROM current_observed_material_supports AS positive
            WHERE positive.location_id = material_location.id
          )
        )
        OR (
          support.observation_material_kind = 'file'
          AND support.observation_revision_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM current_file_observations AS current
            JOIN observed_revision_confirmations AS confirmed
              ON confirmed.location_id = current.location_id
             AND confirmed.snapshot_id = current.snapshot_id
             AND confirmed.observed_at = current.observed_at
             AND confirmed.size = current.size
             AND confirmed.modified_at = current.modified_at
             AND confirmed.conditional_baseline = current.conditional_baseline
            WHERE current.location_id = material_location.id
              AND confirmed.revision_id = support.observation_revision_id
          )
          AND (
            association.observed_artifact_part_json IS NULL
            OR json_extract(association.observed_artifact_part_json, '$.revisionId') =
               support.observation_revision_id
          )
        )
      )
  )
`;

function hasValidObservedMaterialSupports(database: DatabaseSync): boolean {
  /**
   * 派生实体封面（entity 目标、primary-cover、带观察部件）的支持不走下面的 SQL 结构臂：
   * 它必须先通过只读图加载的完整历史校验，通过的精确 support 键组再作为绑定值接回历史
   * OR 分支。任一这类封面校验不成立即整体 integrity-failed；未通过的键也不会被 SQL 其他
   * 分支放行，因此 current proof 臂不能替这类封面跳过结构校验。
   */
  const derivedCovers = readDerivedEntityCoverReadiness(database);
  if (derivedCovers.some((item) => !item.verdict.historicallySupported))
    return false;
  const supportedCoverKeys = JSON.stringify(
    derivedCovers.map((item) => item.supportKey),
  );
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
        OR (support.observation_location_id IS NULL AND (
              association.target_kind <> 'entity'
              OR association.target_entity_id <> decision.asset_id))
        OR NOT (
          CASE
            WHEN association.role = 'asset.primary-cover'
              AND association.target_kind = 'entity'
              AND association.observed_artifact_part_json IS NOT NULL
            THEN (
              support.association_id || char(31) || support.recognition_decision_id ||
              char(31) || COALESCE(support.observation_execution_id, '') ||
              char(31) || COALESCE(support.observation_snapshot_id, '') ||
              char(31) || COALESCE(support.observation_location_id, '') ||
              char(31) || COALESCE(support.observation_revision_id, '') IN
              (SELECT value FROM json_each(?))
            )
            ELSE (
          (${currentLocalObservationSupportSql})
          OR (json_extract(execution.material_association_json, '$.version') =
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
                  AND json_extract(submitted_association.value, '$.target.kind') = association.target_kind
                  AND json_extract(submitted_association.value, '$.target.entityId') = association.target_entity_id
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
          -- 边界内材料刷新沿用同一份决定，新支持的权威来自本次 a-work-item 收录的交付载体：
          -- 每个角色关联不会各自拥有接受行，接受行只属于同执行、同快照、同位置、同产物、
          -- 同 reference 的 asset.material-delivered 载体关联。因此按支持自己的观察坐标精确
          -- 回查该载体接受，再要求原提案在同一 reference 上明确声明待验证角色与该修订 blob，
          -- 修订被替换后旧关联虽不再 current，其历史结构仍然合法。
          OR EXISTS (
            SELECT 1
            FROM observed_material_acceptances AS accepted
            JOIN workflow_executions AS accepted_execution
              ON accepted_execution.id = accepted.execution_id
            JOIN recognition_proposals AS accepted_proposal
              ON accepted_proposal.id = accepted.proposal_id
            JOIN artifact_associations AS accepted_carrier
              ON accepted_carrier.id = accepted.association_id
            JOIN locations AS accepted_location
              ON accepted_location.id = support.observation_location_id
            JOIN artifact_revisions AS accepted_revision
              ON accepted_revision.id = support.observation_revision_id
            JOIN blobs AS accepted_blob
              ON accepted_blob.digest = accepted_revision.blob_digest
            WHERE accepted.acceptance_kind = 'a-work-item'
              AND accepted.work_item_key <> ''
              AND support.observation_execution_id IS NOT NULL
              AND support.observation_snapshot_id IS NOT NULL
              AND support.observation_location_id IS NOT NULL
              AND support.observation_revision_id IS NOT NULL
              AND support.observation_material_kind = 'file'
              AND accepted_carrier.role = 'asset.material-delivered'
              AND accepted_carrier.subject_id = accepted.asset_id
              AND accepted_carrier.artifact_id = accepted.artifact_id
              AND association.subject_id = decision.asset_id
              AND accepted.asset_id = decision.asset_id
              AND accepted.execution_id = support.observation_execution_id
              AND accepted.snapshot_id = support.observation_snapshot_id
              AND accepted.location_id = support.observation_location_id
              AND accepted.artifact_id = association.artifact_id
              AND accepted_revision.artifact_id = association.artifact_id
              AND accepted_location.kind = 'observed'
              AND accepted_location.artifact_id = association.artifact_id
              AND accepted_location.address =
                json_extract(accepted_execution.snapshot_json, '$.root') || '/' ||
                accepted.observed_reference
              AND json_extract(accepted_execution.snapshot_json, '$.id') =
                support.observation_snapshot_id
              AND EXISTS (
                SELECT 1
                FROM json_each(COALESCE(accepted_execution.work_items_json, '[]')) AS work_item
                WHERE json_extract(work_item.value, '$.key') = accepted.work_item_key
                  AND json_extract(work_item.value, '$.proposalId') = accepted.proposal_id
                  AND json_extract(work_item.value, '$.acceptedAssetId') = accepted.asset_id
              )
              AND EXISTS (
                SELECT 1
                FROM json_each(json_extract(accepted_proposal.observed_material_interpretation_json,
                  '$.observedArtifactAssociations')) AS candidate
                WHERE json_extract(candidate.value, '$.observedArtifactReference') =
                    accepted.observed_reference
                  AND json_extract(candidate.value, '$.role') = association.role
              )
              AND EXISTS (
                SELECT 1
                FROM json_each(json_extract(accepted_proposal.observed_material_interpretation_json,
                  '$.observedArtifactRevisions')) AS proposed_revision
                WHERE json_extract(proposed_revision.value, '$.observedArtifactReference') =
                    accepted.observed_reference
                  AND json_extract(proposed_revision.value, '$.blob.digest') =
                      accepted_revision.blob_digest
                  AND json_extract(proposed_revision.value, '$.blob.mediaType') =
                      accepted_blob.media_type
                  AND json_extract(proposed_revision.value, '$.blob.byteLength') =
                      accepted_blob.byte_length
              )
          )
          -- 整包目录没有单一文件修订。目录消失只结束当前正向支持，不能把原先按
          -- filesystem-package 工作项接受的目录历史判成损坏；历史依据必须仍精确落在
          -- 同一接受行、执行、快照根、产物和该工作项声明的整包边界上。
          OR EXISTS (
            SELECT 1
            FROM observed_material_acceptances AS accepted
            JOIN workflow_executions AS accepted_execution
              ON accepted_execution.id = accepted.execution_id
            JOIN recognition_proposals AS accepted_proposal
              ON accepted_proposal.id = accepted.proposal_id
             AND accepted_proposal.execution_id = accepted.execution_id
            JOIN locations AS accepted_location
              ON accepted_location.id = accepted.location_id
            WHERE accepted.acceptance_kind = 'a-work-item'
              AND accepted.work_item_key <> ''
              AND accepted.observed_reference = '.'
              AND support.observation_material_kind = 'directory'
              AND support.observation_revision_id IS NULL
              AND association.observed_artifact_part_json IS NULL
              AND association.role = 'asset.material-delivered'
              AND association.target_kind = 'entity'
              AND association.target_entity_id = decision.asset_id
              AND association.subject_id = decision.asset_id
              AND accepted.asset_id = decision.asset_id
              AND accepted.association_id = association.id
              AND accepted.artifact_id = association.artifact_id
              AND accepted.execution_id = support.observation_execution_id
              AND accepted.snapshot_id = support.observation_snapshot_id
              AND accepted.location_id = support.observation_location_id
              AND accepted_location.kind = 'observed'
              AND accepted_location.artifact_id = association.artifact_id
              AND accepted_location.address = json_extract(accepted_execution.snapshot_json, '$.root')
              AND json_extract(accepted_execution.snapshot_json, '$.id') = accepted.snapshot_id
              AND json_extract(accepted_execution.snapshot_json, '$.complete') = 1
              AND EXISTS (
                SELECT 1
                FROM json_each(COALESCE(accepted_execution.work_items_json, '[]')) AS work_item
                WHERE json_extract(work_item.value, '$.key') = accepted.work_item_key
                  AND json_extract(work_item.value, '$.proposalId') = accepted.proposal_id
                  AND json_extract(work_item.value, '$.acceptedAssetId') = accepted.asset_id
                  AND json_extract(work_item.value, '$.observedArtifactBoundary') = 'filesystem-package'
              )
          )
          -- 有界本地部分（例如 PDF 首页图）自己没有载体交付接受行：它的权威来自同一执行里
          -- 交付其载体那份 a-work-item 或 b-local 接受，载体产物/修订与部分坐标必须逐字相符，且该次
          -- 观察的提案确实以相同 reference、角色与 locator 声明过这个部分。
          OR EXISTS (
            SELECT 1
            FROM observed_material_acceptances AS accepted
            JOIN workflow_executions AS accepted_execution
              ON accepted_execution.id = accepted.execution_id
            JOIN recognition_proposals AS accepted_proposal
              ON accepted_proposal.id = accepted.proposal_id
            JOIN locations AS accepted_location
              ON accepted_location.id = support.observation_location_id
            JOIN artifact_revisions AS accepted_revision
              ON accepted_revision.id = support.observation_revision_id
            JOIN blobs AS accepted_blob
              ON accepted_blob.digest = accepted_revision.blob_digest
            WHERE support.observation_execution_id IS NOT NULL
              AND support.observation_snapshot_id IS NOT NULL
              AND support.observation_location_id IS NOT NULL
              AND support.observation_revision_id IS NOT NULL
              AND support.observation_material_kind = 'file'
              AND association.observed_artifact_part_json IS NOT NULL
              AND association.subject_id = decision.asset_id
              AND json_extract(association.observed_artifact_part_json, '$.artifactId') =
                  accepted.artifact_id
              AND json_extract(association.observed_artifact_part_json, '$.revisionId') =
                  support.observation_revision_id
              AND accepted.asset_id = decision.asset_id
              AND accepted.execution_id = support.observation_execution_id
              AND accepted.snapshot_id = support.observation_snapshot_id
              AND accepted.location_id = support.observation_location_id
              AND accepted.artifact_id = accepted_revision.artifact_id
              AND accepted_location.kind = 'observed'
              AND accepted_location.artifact_id = accepted.artifact_id
              AND accepted_location.address =
                json_extract(accepted_execution.snapshot_json, '$.root') || '/' ||
                accepted.observed_reference
              AND json_extract(accepted_execution.snapshot_json, '$.id') =
                  support.observation_snapshot_id
              AND (
                (accepted.acceptance_kind = 'a-work-item'
                 AND accepted.work_item_key <> ''
                 AND EXISTS (
                   SELECT 1
                   FROM json_each(COALESCE(accepted_execution.work_items_json, '[]')) AS work_item
                   WHERE json_extract(work_item.value, '$.key') = accepted.work_item_key
                     AND json_extract(work_item.value, '$.proposalId') = accepted.proposal_id
                     AND json_extract(work_item.value, '$.acceptedAssetId') = accepted.asset_id
                 ))
                OR (accepted.acceptance_kind = 'b-local'
                    AND accepted.work_item_key = ''
                    AND accepted_execution.proposal_id = accepted.proposal_id
                    AND accepted_execution.accepted_asset_id = accepted.asset_id
                    AND json_extract(accepted_proposal.basis_json, '$.kind') = 'manual-boundary'
                    AND EXISTS (
                      SELECT 1
                      FROM json_each(json_extract(accepted_proposal.basis_json, '$.materialReferences')) AS reference
                      WHERE reference.value = accepted.observed_reference
                    ))
              )
              AND EXISTS (
                SELECT 1
                FROM json_each(json_extract(accepted_proposal.observed_material_interpretation_json,
                  '$.observedArtifactParts')) AS part
                WHERE json_extract(part.value, '$.observedArtifactReference') =
                    accepted.observed_reference
                  AND json_extract(part.value, '$.role') = association.role
                  AND json_extract(part.value, '$.locator') =
                      json_extract(association.observed_artifact_part_json, '$.locator')
              )
              AND EXISTS (
                SELECT 1
                FROM json_each(json_extract(accepted_proposal.observed_material_interpretation_json,
                  '$.observedArtifactRevisions')) AS proposed_revision
                WHERE json_extract(proposed_revision.value, '$.observedArtifactReference') =
                    accepted.observed_reference
                  AND json_extract(proposed_revision.value, '$.blob.digest') =
                      accepted_revision.blob_digest
                  AND json_extract(proposed_revision.value, '$.blob.mediaType') =
                      accepted_blob.media_type
                  AND json_extract(proposed_revision.value, '$.blob.byteLength') =
                      accepted_blob.byte_length
              )
          )
            )
          END
          )
      LIMIT 1
    `)
    .get(supportedCoverKeys);
  if (invalid !== undefined) return false;
  const missing = database
    .prepare(`
      WITH expected(asset_id, decision_id, proposal_id, execution_id, reference, digest, root, association_id, location_id, revision_id, role) AS (
        SELECT head.subject_id, decision.id, proposal.id, execution.id,
               json_extract(revision.value, '$.observedArtifactReference'),
               json_extract(revision.value, '$.blob.digest'),
               json_extract(execution.snapshot_json, '$.root'), NULL, NULL, NULL, NULL
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
               json_extract(execution.snapshot_json, '$.root'), NULL, NULL, NULL, NULL
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
               json_extract(execution.snapshot_json, '$.root'), NULL, NULL, NULL, NULL
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
               json_extract(projection.value, '$.revisionId'),
               submitted.role
        FROM recognition_decisions AS decision
        JOIN recognition_proposals AS proposal ON proposal.id = decision.proposal_id
        JOIN workflow_executions AS execution ON execution.id = proposal.execution_id
        JOIN json_each(json_extract(execution.material_association_json, '$.submission.projections')) AS projection
        JOIN artifact_associations AS submitted
          ON submitted.id = json_extract(projection.value, '$.associationId')
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
       AND association.role = COALESCE(expected.role, 'asset.material-delivered')
       AND association.source_record_ids_json = '[]'
       AND association.source_association_id IS NULL
       AND (expected.association_id IS NULL OR association.id = expected.association_id)
       -- 已应用的范围修订只为其完整 projected 事实要求新决定支持；同址、同字节的
       -- 旧交付关联仍由上面的历史支持校验，不能仅因新 head 而被强挂到新决定。
       AND NOT EXISTS (
         SELECT 1 FROM change_impact_previews AS preview
         WHERE preview.execution_id = expected.execution_id
           AND preview.asset_id = expected.asset_id
           AND preview.status = 'applied'
           AND json_extract(preview.preview_json, '$.change.kind') =
               'recognition-scope-amendment'
           AND json_extract(preview.preview_json, '$.change.proposal.id') =
               expected.proposal_id
           AND NOT EXISTS (
             SELECT 1 FROM json_each(
               json_extract(preview.preview_json, '$.projected.artifactAssociations'))
               AS projected_association
             WHERE json_extract(projected_association.value, '$.id') = association.id
           )
       )
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

/** 固定点持久来源解释快照中每个实体条目的旧严格形状。 */
const retiredSourcedEntityKeys = [
  "id",
  "identityNamespace",
  "kind",
  "label",
  "sourceIdentity",
  "sourceKey",
  "sourceRecordIds",
] as const;

/**
 * E02 迁移需要证明依据的全部已知持久载体。每个载体按自身版本、discriminator 与
 * 必需／可选关系专属验证：先按固定点旧合同逐条校验旧 `entities` 条目，再仅在内存
 * 深副本上精确删除已通过校验的 `kind`，把归一化后的完整 typed carrier 交给既有严格
 * decoder。不修造持久数据，也不使用缺省即返回的通用路径遍历。
 */
function isRetiredRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 先按旧合同校验旧实体条目，再返回仅精确删除其 `kind` 的内存深副本。 */
function normalizedRetiredEntities(
  entities: unknown,
  sourceRecordExists: (recordId: string) => boolean,
): readonly unknown[] {
  if (!Array.isArray(entities))
    throw new Error("持久来源解释的实体容器类型无效");
  return entities.map((entity) => {
    assertRetiredSourcedEntity(entity, sourceRecordExists);
    const normalized = structuredClone(entity) as Record<string, unknown>;
    delete normalized.kind;
    return normalized;
  });
}

/** 整份 `SourceInterpretationBatch` 归一化旧实体条目后按既有严格规则完整解码。 */
function assertStrictSourceInterpretationBatchCarrier(
  value: unknown,
  sourceRecordExists: (recordId: string) => boolean,
): void {
  if (!isRetiredRecord(value)) throw new Error("持久来源解释批次必须是对象");
  const document = structuredClone(value);
  if (document.entities !== undefined)
    document.entities = normalizedRetiredEntities(
      document.entities,
      sourceRecordExists,
    );
  const decoded = decodeSourceInterpretationBatch(document);
  if (!decoded.valid)
    throw new Error(`持久来源解释批次不满足固定点必需结构：${decoded.reason}`);
}

/** 旧 `RecognitionBasis` union：只有 source-interpretation 分支携带本迁移拥有的解释。 */
function assertRetiredRecognitionBasisCarrier(
  value: unknown,
  sourceRecordExists: (recordId: string) => boolean,
): void {
  if (!isRetiredRecord(value)) throw new Error("持久识别 basis 必须是对象");
  if (value.kind !== "source-interpretation") {
    // manual-boundary 与 observed-evidence 是不含解释的合法分支，不顺带重验分支内
    // 无关字段；但正式 SQL 只看解释路径是否实际存在，所以必须证明该不相容成员
    // 真的不存在（含 null 与错形），未知 kind 也无法证明，一律拒绝。
    if (value.kind !== "manual-boundary" && value.kind !== "observed-evidence")
      throw new Error("持久识别 basis kind 未知，无法证明不含来源解释");
    if (Object.hasOwn(value, "interpretation"))
      throw new Error("持久识别 basis 的无解释分支携带来源解释成员");
    return;
  }
  const basis = structuredClone(value);
  if (
    isRetiredRecord(basis.interpretation) &&
    basis.interpretation.entities !== undefined
  )
    basis.interpretation.entities = normalizedRetiredEntities(
      basis.interpretation.entities,
      sourceRecordExists,
    );
  const decoded = decodeRecognitionBasis(basis);
  if (!decoded.valid)
    throw new Error(`来源解释 basis 不满足固定点必需结构：${decoded.reason}`);
}

/**
 * 预演按 `ChangeImpactPreview/2` 的 union 定位解释；projection 条目只按实体边界验证。
 * change 的 union 与识别提议／basis 成员互斥：非识别取代分支必须证明它们不存在。
 */
function assertChangeImpactPreviewCarrier(
  value: unknown,
  sourceRecordExists: (recordId: string) => boolean,
): void {
  if (!isRetiredRecord(value) || value.version !== "change-impact-preview/2")
    throw new Error("持久变更预演的版本或容器形状无效");
  for (const key of ["current", "projected"] as const) {
    const projection = value[key];
    if (!isRetiredRecord(projection))
      throw new Error("持久变更预演的状态投影必须是对象");
    // AssetStateProjection 的 entities 是必需数组；它不是解释批次，
    // 不要求批次 producer／sourceAddress 等字段。
    for (const entity of normalizedRetiredEntities(
      projection.entities,
      sourceRecordExists,
    )) {
      const decoded = decodeSourcedEntity(entity);
      if (!decoded.valid)
        throw new Error(
          `持久预演投影的实体条目不满足固定点形状：${decoded.reason}`,
        );
    }
  }
  const change = value.change;
  if (!isRetiredRecord(change))
    throw new Error("持久变更预演的 change 必须是对象");
  if (
    change.kind === "recognition-supersession" ||
    change.kind === "recognition-scope-amendment"
  ) {
    if (value.proposal !== undefined)
      assertPreviewRecognitionProposalBasis(
        value.proposal,
        sourceRecordExists,
        "$.proposal",
      );
    assertPreviewRecognitionProposalBasis(
      change.proposal,
      sourceRecordExists,
      "$.change.proposal",
    );
    return;
  }
  // 识别取代与范围修订预演携带识别提议与其兼容视图；来源关联的提议是
  // SourceAssociationChangeProposal，撤回只携带 intent，人工角色决定只携带冻结的
  // 三元组与期望头。正式 SQL 仍只看 `$.proposal.basis`／`$.change.proposal` 路径是否
  // 存在，因此这些分支必须证明该不相容成员确实不存在，未知 change kind 同样拒绝。
  if (
    change.kind !== "source-association" &&
    change.kind !== "recognition-retraction" &&
    change.kind !== "artifact-role-decision"
  )
    throw new Error("持久预演 change kind 未知，无法证明不含识别 basis");
  if (Object.hasOwn(value, "proposal"))
    throw new Error("持久变更预演的非识别取代分支携带识别提议兼容视图");
  if (change.kind === "artifact-role-decision") {
    if (Object.hasOwn(change, "proposal"))
      throw new Error("持久变更预演的角色决定分支携带识别提议");
    const decision = change.decision;
    if (
      !isRetiredRecord(decision) ||
      (decision.kind !== "select" && decision.kind !== "clear") ||
      typeof decision.role !== "string" ||
      decision.role.length === 0 ||
      !isRetiredRecord(decision.target) ||
      !(
        change.expectedHeadDecisionId === null ||
        typeof change.expectedHeadDecisionId === "string"
      ) ||
      Object.hasOwn(decision, "selected") !== (decision.kind === "select")
    )
      throw new Error("持久预演的角色决定缺少冻结坐标或期望头");
    return;
  }
  if (change.kind === "recognition-retraction") {
    if (Object.hasOwn(change, "proposal"))
      throw new Error("持久变更预演的撤回分支携带识别提议");
    return;
  }
  if (
    isRetiredRecord(change.proposal) &&
    Object.hasOwn(change.proposal, "basis")
  )
    throw new Error("持久变更预演的来源关联提议携带识别 basis");
}

function assertPreviewRecognitionProposalBasis(
  proposal: unknown,
  sourceRecordExists: (recordId: string) => boolean,
  location: string,
): void {
  if (!isRetiredRecord(proposal) || !isRetiredRecord(proposal.basis))
    throw new Error(`持久变更预演 ${location} 的 basis 容器形状无效`);
  assertRetiredRecognitionBasisCarrier(proposal.basis, sourceRecordExists);
}

const retiredInterpretedSourceEnrichmentStages = new Set([
  "association-interpreted",
  "source-artifact-acquired",
  "source-artifact-stored",
  "applied",
]);
const retiredUninterpretedSourceEnrichmentStages = new Set([
  "candidate-interpreted",
  "source-records-retained",
  "failed",
]);

/**
 * 只按 stage union 判断解释是否必需，不顺带重验无关恢复字段。
 * `failedSourceEnrichmentCheckpoint` 从解释后阶段失败时会合法保留 interpretation，
 * 因此三个可选阶段只要字段实际存在，仍沿同一已知路径做旧实体先验、内存删 kind
 * 与完整批次解码；不对 stage 外层做 exact-keys 审查。
 */
function assertSourceEnrichmentCheckpointCarrier(
  value: unknown,
  sourceRecordExists: (recordId: string) => boolean,
): void {
  if (!Array.isArray(value))
    throw new Error("持久来源补充 checkpoint 必须是数组");
  for (const checkpoint of value) {
    if (!isRetiredRecord(checkpoint) || typeof checkpoint.stage !== "string")
      throw new Error("持久来源补充 checkpoint 容器形状无效");
    if (
      !retiredInterpretedSourceEnrichmentStages.has(checkpoint.stage) &&
      !retiredUninterpretedSourceEnrichmentStages.has(checkpoint.stage)
    )
      throw new Error("持久来源补充 checkpoint stage 已超出退出前的封闭词汇");
    if (
      checkpoint.interpretation === undefined &&
      retiredUninterpretedSourceEnrichmentStages.has(checkpoint.stage)
    )
      continue;
    assertStrictSourceInterpretationBatchCarrier(
      checkpoint.interpretation,
      sourceRecordExists,
    );
  }
}

/**
 * 旧 pending checkpoint 可能仍携带正式 SQL 将移除并重派生的 candidate
 * `reference`，因此不调用完整新 checkpoint decoder；只按版本、candidates 数组
 * 与逐 interpretation 的完整批次严格解码。
 */
function assertSourceAssociationDecisionCarrier(
  value: unknown,
  sourceRecordExists: (recordId: string) => boolean,
): void {
  if (
    !isRetiredRecord(value) ||
    value.version !== "source-association-decision-checkpoint/1"
  )
    throw new Error("持久来源关联决定 checkpoint 的版本或容器形状无效");
  if (!Array.isArray(value.candidates))
    throw new Error("持久来源关联决定的候选集合容器类型无效");
  for (const candidate of value.candidates) {
    if (!isRetiredRecord(candidate))
      throw new Error("持久来源关联决定候选必须是对象");
    assertStrictSourceInterpretationBatchCarrier(
      candidate.interpretation,
      sourceRecordExists,
    );
  }
}

const ordinaryEntityMigrationCarriers = [
  {
    documents: "SELECT basis_json AS document FROM recognition_proposals",
    assertDocument: assertRetiredRecognitionBasisCarrier,
  },
  {
    documents:
      "SELECT interpretation_json AS document FROM source_refresh_change_sets",
    assertDocument: assertStrictSourceInterpretationBatchCarrier,
  },
  {
    documents:
      "SELECT interpretation_json AS document FROM current_source_artifact_candidate_lineages",
    assertDocument: assertStrictSourceInterpretationBatchCarrier,
  },
  {
    documents: "SELECT preview_json AS document FROM change_impact_previews",
    assertDocument: assertChangeImpactPreviewCarrier,
  },
  {
    documents:
      "SELECT source_enrichments_json AS document FROM workflow_executions",
    assertDocument: assertSourceEnrichmentCheckpointCarrier,
  },
  {
    documents: `
      SELECT source_association_decision_json AS document FROM workflow_executions
      WHERE source_association_decision_json IS NOT NULL`,
    assertDocument: assertSourceAssociationDecisionCarrier,
  },
] as const;

/**
 * 人物／活动身份迁移前的窄权威预检。每个已知持久载体按实际旧 union、版本与必需／
 * 可选关系严格验证：旧实体条目先经 `assertRetiredSourcedEntity` 验证身份、来源坐标
 * 与 Source Record 依据，再仅在内存深副本上精确删除 `kind`，由既有严格 decoder 验证
 * 完整必需结构；audit 镜像先验版本再与主列 canonical 等值。缺省的可选成员通过；
 * 合法无解释 union 分支还必须按自身 discriminator 证明本迁移拥有的解释／识别提议
 * 成员确实不存在，因为正式 SQL 只看路径是否存在。解析、旧形状、必需结构、
 * union／版本或镜像任一失败都抛错，让正式 prepare 整体回滚。该检查只服务这次
 * 迁移，运行时没有第二套兼容解码入口。
 */
export function assertOrdinaryEntityMigrationAuthority(
  database: DatabaseSync,
): void {
  const existingSourceRecord = database.prepare(
    "SELECT 1 FROM source_records WHERE id = ?",
  );
  const sourceRecordExists = (recordId: string) =>
    existingSourceRecord.get(recordId) !== undefined;
  for (const carrier of ordinaryEntityMigrationCarriers) {
    for (const { document } of database
      .prepare(carrier.documents)
      .all() as Array<{
      readonly document: string | null;
    }>) {
      if (document === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(document);
      } catch {
        throw new Error("持久来源解释文档无法解析");
      }
      carrier.assertDocument(parsed, sourceRecordExists);
    }
  }
  const mirrors = database
    .prepare(`
      SELECT audit_json AS audit,
             source_enrichments_json AS source_enrichments,
             source_association_decision_json AS source_association_decision
      FROM workflow_executions WHERE audit_json IS NOT NULL
    `)
    .all() as Array<{
    readonly audit: string;
    readonly source_enrichments: string;
    readonly source_association_decision: string | null;
  }>;
  if (
    mirrors.some(
      ({ audit, source_enrichments, source_association_decision }) => {
        try {
          const envelope = JSON.parse(audit) as {
            readonly version?: unknown;
            readonly payload?: Record<string, unknown>;
          };
          if (
            envelope.version !== workflowExecutionAuditVersion ||
            typeof envelope.payload !== "object" ||
            envelope.payload === null
          )
            return true;
          if (
            "sourceEnrichments" in envelope.payload &&
            canonicalJson(envelope.payload.sourceEnrichments) !==
              canonicalJson(JSON.parse(source_enrichments))
          )
            return true;
          return (
            source_association_decision !== null &&
            "sourceAssociationDecision" in envelope.payload &&
            canonicalJson(envelope.payload.sourceAssociationDecision) !==
              canonicalJson(JSON.parse(source_association_decision))
          );
        } catch {
          return true;
        }
      },
    )
  )
    throw new Error("工作流执行审计镜像与持久列不再一致");
}

function assertRetiredSourcedEntity(
  value: unknown,
  sourceRecordExists: (recordId: string) => boolean,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactRetiredKeys(
      value as Record<string, unknown>,
      retiredSourcedEntityKeys,
      ["producer"],
    )
  )
    throw new Error("持久来源解释实体形状未知");
  const entity = value as Record<string, unknown>;
  if (
    entity.kind !== "entity" &&
    entity.kind !== "person" &&
    entity.kind !== "persona"
  )
    throw new Error("持久来源解释实体种类已超出退出前的封闭词汇");
  if (
    ![
      entity.id,
      entity.identityNamespace,
      entity.label,
      entity.sourceIdentity,
      entity.sourceKey,
    ].every(isNonEmptyText)
  )
    throw new Error("持久来源解释实体缺少身份或来源坐标");
  const sourceRecordIds = entity.sourceRecordIds;
  if (
    !Array.isArray(sourceRecordIds) ||
    !sourceRecordIds.every(isNonEmptyText) ||
    new Set(sourceRecordIds).size !== sourceRecordIds.length
  )
    throw new Error("持久来源解释实体的来源记录坐标无效");
  if (
    entity.producer !== undefined &&
    !isRetiredCapabilityCoordinate(entity.producer)
  )
    throw new Error("持久来源解释实体的生产者坐标无效");
  if (
    (entity.kind === "person" || entity.kind === "persona") &&
    (sourceRecordIds.length === 0 ||
      !sourceRecordIds.every((recordId: string) =>
        sourceRecordExists(recordId),
      ))
  )
    throw new Error("人物或活动身份的来源依据不可追溯");
}

function hasExactRetiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowed.has(key)) &&
    required.every((key) => keys.includes(key))
  );
}

function isNonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isRetiredCapabilityCoordinate(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const coordinate = value as Record<string, unknown>;
  return (
    hasExactRetiredKeys(
      coordinate,
      ["capabilityId", "capabilityVersion", "contractVersion"],
      [
        "identity",
        "implementationVersion",
        "kind",
        "interpretationContractVersions",
      ],
    ) &&
    [
      coordinate.capabilityId,
      coordinate.capabilityVersion,
      coordinate.contractVersion,
    ].every(isNonEmptyText) &&
    [
      coordinate.identity,
      coordinate.implementationVersion,
      coordinate.kind,
    ].every((item) => item === undefined || isNonEmptyText(item)) &&
    (coordinate.interpretationContractVersions === undefined ||
      (Array.isArray(coordinate.interpretationContractVersions) &&
        coordinate.interpretationContractVersions.every(isNonEmptyText) &&
        new Set(coordinate.interpretationContractVersions).size ===
          coordinate.interpretationContractVersions.length))
  );
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
