import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  inspectProductionCatalogueReadiness,
  prepareProductionCatalogue,
  productionMigrationArtifacts,
} from "@digital/db-migrations";
import { ProductDataOperations } from "@digital/product-data";
import { SqliteCatalogue } from "@digital/sqlite";
import { prepareDisposableProductDataCatalogue } from "@digital/sqlite/testing";
import { describe, expect, it } from "vitest";

describe("production catalogue preparation", () => {
  it("makes the formal prepare-only child reject maintenance, retain no ledger, then succeed after release", async () => {
    const productDataDirectory = await temporaryProductData();
    const maintenance =
      ProductDataOperations.forRoot(productDataDirectory).startMaintenance();
    try {
      await expect(runFormalCli(productDataDirectory)).resolves.toBe(1);
      await expect(
        lstat(path.join(productDataDirectory, "catalogue.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "catalogue-not-prepared" });
    } finally {
      maintenance.close();
    }
    await expect(runFormalCli(productDataDirectory)).resolves.toBe(0);
    await rm(productDataDirectory, { recursive: true, force: true });
  });

  it("prepares an empty real SQLite product root in artifact version order and is repeatable", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      expect(productionMigrationArtifacts.map(({ id }) => id)).toEqual(
        productionMigrationArtifacts.map(({ id }) => id).toSorted(),
      );
      await prepareProductionCatalogue({ productDataDirectory });
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });
      await expectDerivedPrepareApplied(productDataDirectory);
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("preserves a populated catalogue when an already-applied plan is prepared again", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      await prepareProductionCatalogue({ productDataDirectory });
      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      database
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run("real-catalogue-row", "2026-08-20T00:00:00.000Z");
      database.close();

      await prepareProductionCatalogue({ productDataDirectory });
      const verified = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        verified
          .prepare("SELECT id FROM schema_migrations WHERE id = ?")
          .get("real-catalogue-row"),
      ).toEqual({ id: "real-catalogue-row" });
      verified.close();
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("hard-migrates local description targets and coalesces one current address", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      await prepareCatalogueBeforeDescriptionTargets(productDataDirectory);
      await expectDerivedPrepareApplied(productDataDirectory);
      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        database
          .prepare(
            "SELECT target_kind, target_artifact_id, target_revision_id, role FROM artifact_associations WHERE role = 'asset.material-image'",
          )
          .get(),
      ).toEqual({
        target_kind: "artifact-revision",
        target_artifact_id: "observed-artifact",
        target_revision_id: "observed-revision",
        role: "asset.material-image",
      });
      expect(
        database
          .prepare(
            "SELECT target_kind, target_entity_id, artifact_id, role FROM artifact_associations WHERE role = 'asset.primary-cover'",
          )
          .get(),
      ).toEqual({
        target_kind: "entity",
        target_entity_id: "asset",
        artifact_id: "image",
        role: "asset.primary-cover",
      });
      expect(
        database
          .prepare(
            "SELECT target_kind, target_artifact_id, target_revision_id FROM metadata_assertions",
          )
          .get(),
      ).toEqual({
        target_kind: "artifact-revision",
        target_artifact_id: "observed-artifact",
        target_revision_id: "observed-revision",
      });
      expect(
        database
          .prepare(
            "SELECT address, count(*) AS count FROM current_file_observations",
          )
          .get(),
      ).toEqual({ address: "/media/book.epub", count: 1 });
      database.close();
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("preserves an old sourced-entity relationship lifecycle subject while naming every participant", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      await prepareCatalogueBeforeNamedRelationshipParticipants(
        productDataDirectory,
      );
      const legacy = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      legacy
        .prepare(
          `INSERT INTO entity_relationships
            (id, subject_id, participant_id, type, role, source_record_ids_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "bangumi-sequel",
          "bangumi-subject-1",
          "bangumi-subject-2",
          "bangumi.subject.related",
          "bangumi.subject.sequel",
          '["bangumi-record"]',
        );
      legacy
        .prepare(
          `INSERT INTO relationship_lifecycles
            (relationship_id, source_identity, native_address, coverage_id, source_record_id, source_slot)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "bangumi-sequel",
          "bangumi",
          "bangumi:subject:1",
          "bangumi.relationships",
          "bangumi-record",
          "bangumi.subject.sequel:1:2",
        );
      const credit = {
        type: "asset.contribution",
        participantId: "creator",
        role: "voice",
        sourceSlot: "credit",
        sourceRecordIds: ["record"],
        participantMentionIds: ["mention"],
      };
      const sequel = {
        type: "bangumi.subject.related",
        subjectId: "season-1",
        participantId: "season-2",
        role: "bangumi.subject.sequel",
        sourceSlot: "sequel",
        sourceRecordIds: ["record"],
      };
      // 命名参与者迁移只重写 relationships 条目，同一份解释文档其余结构必须仍是运行期
      // 写入的完整来源解释批次；实体条目保留退休 kind，交给 E02 预检与硬迁移处理。
      const batchEnvelope = {
        id: "lineage-interpretation",
        metadata: [],
        producer: {
          capabilityId: "fixture-interpreter",
          capabilityVersion: "1",
          contractVersion: "fixture/1",
        },
        sourceAddress: "address",
        sourceArtifacts: [
          {
            acquisitionReference: "address",
            id: "retained-cover",
            mediaType: "image/png",
            role: "asset.primary-cover",
            sourceRecordId: "record",
          },
        ],
        sourceIdentity: "fixture",
        sourceRecordIds: ["record"],
        entityMentions: [
          {
            field: "credits",
            id: "mention",
            identityNamespace: "fixture-namespace",
            label: "creator",
            role: "voice",
            sourceIdentity: "fixture",
            sourceKey: "key:mention",
            sourceRecordIds: ["record"],
          },
        ],
        entityResolutionDecisions: [
          {
            entityId: "creator",
            id: "decision",
            mentionId: "mention",
            rule: "source-field-role-exact",
            sourceRecordIds: ["record"],
          },
        ],
      };
      const ordinaryEntity = (id: string) => ({
        id,
        identityNamespace: "fixture-namespace",
        label: id,
        sourceIdentity: "fixture",
        sourceKey: `key:${id}`,
        sourceRecordIds: ["record"],
      });
      legacy
        .prepare(`INSERT INTO current_source_artifact_candidate_lineages
        (subject_id, source_association_id, source_identity, native_address, coverage_id, source_record_id, interpretation_json)
        VALUES ('asset', 'association', 'fixture', 'address', 'coverage', 'record', ?)`)
        .run(
          JSON.stringify({
            ...batchEnvelope,
            entities: [
              { ...ordinaryEntity("creator"), kind: "entity" },
              { ...ordinaryEntity("season-1"), kind: "entity" },
              { ...ordinaryEntity("season-2"), kind: "entity" },
            ],
            relationships: [credit, sequel],
          }),
        );
      legacy
        .prepare(`INSERT INTO change_impact_previews (id, execution_id, asset_id, preview_json)
        VALUES ('preview', 'execution', 'asset', ?)`)
        .run(
          JSON.stringify({
            version: "change-impact-preview/2",
            change: { kind: "recognition-retraction" },
            current: { entities: [] },
            projected: {
              entities: [],
              relationships: [{ ...credit, id: "credit", subjectId: "asset" }],
            },
          }),
        );
      legacy.close();

      await expectDerivedPrepareApplied(productDataDirectory);
      const migrated = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        migrated
          .prepare(
            "SELECT source_subject_id FROM relationship_lifecycles WHERE relationship_id = 'bangumi-sequel'",
          )
          .get(),
      ).toEqual({ source_subject_id: "bangumi-subject-1" });
      expect(
        migrated
          .prepare(
            "SELECT entity_id, role FROM entity_relationship_participants WHERE relationship_id = 'bangumi-sequel' ORDER BY role",
          )
          .all(),
      ).toEqual([
        {
          entity_id: "bangumi-subject-1",
          role: "bangumi.subject.predecessor",
        },
        { entity_id: "bangumi-subject-2", role: "bangumi.subject.sequel" },
      ]);
      const stored = migrated
        .prepare(
          "SELECT interpretation_json AS json FROM current_source_artifact_candidate_lineages",
        )
        .get()!;
      expect(JSON.parse(String(stored.json))).toEqual({
        ...batchEnvelope,
        entities: [
          ordinaryEntity("creator"),
          ordinaryEntity("season-1"),
          ordinaryEntity("season-2"),
        ],
        relationships: [
          {
            type: "asset.contribution",
            subjectRole: "asset",
            participants: [
              { entityId: "creator", role: "voice", mentionIds: ["mention"] },
            ],
            sourceSlot: "credit",
            sourceRecordIds: ["record"],
          },
          {
            type: "bangumi.subject.related",
            sourceSubjectId: "season-1",
            participants: [
              { entityId: "season-1", role: "bangumi.subject.predecessor" },
              { entityId: "season-2", role: "bangumi.subject.sequel" },
            ],
            sourceSlot: "sequel",
            sourceRecordIds: ["record"],
          },
        ],
      });
      const preview = migrated
        .prepare(
          "SELECT preview_json AS json FROM change_impact_previews WHERE id = 'preview'",
        )
        .get()!;
      expect(JSON.parse(String(preview.json)).projected.relationships).toEqual([
        {
          type: "asset.contribution",
          id: "credit",
          sourceSubjectId: "asset",
          participants: [
            { entityId: "asset", role: "asset" },
            { entityId: "creator", role: "voice", mentionIds: ["mention"] },
          ],
          sourceSlot: "credit",
          sourceRecordIds: ["record"],
        },
      ]);
      migrated.close();
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("migrates only a source enrichment whose execution, checkpoint, captured record, interpretation, and frozen authority agree", async () => {
    const valid = await temporaryProductData();
    const corrupt = await temporaryProductData();
    try {
      await prepareLegacySourceEnrichmentCatalogue(valid, false);
      await expectDerivedPrepareApplied(valid);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory: valid }),
      ).resolves.toMatchObject({ state: "ready" });
      const migrated = new DatabaseSync(path.join(valid, "catalogue.sqlite"), {
        readOnly: true,
      });
      expect(
        migrated
          .prepare(
            `SELECT decided_by_kind, decided_by_coordinate
             FROM source_association_decisions`,
          )
          .get(),
      ).toMatchObject({
        decided_by_kind: "user",
        decided_by_coordinate: "operator",
      });
      migrated.close();

      await prepareLegacySourceEnrichmentCatalogue(corrupt, true);
      await expectLegacySourceAuthorityLockout(
        prepareProductionCatalogue({ productDataDirectory: corrupt }),
        corrupt,
      );
    } finally {
      await rm(valid, { recursive: true, force: true });
      await rm(corrupt, { recursive: true, force: true });
    }
  });

  it("rejects missing, duplicated, or wrong-coordinate legacy source authority", async () => {
    const roots = await Promise.all([
      temporaryProductData(),
      temporaryProductData(),
      temporaryProductData(),
    ]);
    try {
      for (const root of roots)
        await prepareLegacySourceEnrichmentCatalogue(root, false);
      const missing = new DatabaseSync(path.join(roots[0], "catalogue.sqlite"));
      missing.exec("UPDATE workflow_executions SET workflow_input_json = NULL");
      missing.close();
      const duplicated = new DatabaseSync(
        path.join(roots[1], "catalogue.sqlite"),
      );
      duplicated.exec(
        "UPDATE workflow_executions SET source_enrichments_json = json_array(json_extract(source_enrichments_json, '$[0]'), json_extract(source_enrichments_json, '$[0]'))",
      );
      duplicated.close();
      const wrongCoordinate = new DatabaseSync(
        path.join(roots[2], "catalogue.sqlite"),
      );
      wrongCoordinate.exec(
        "UPDATE workflow_executions SET compatibility_json = json_set(compatibility_json, '$.capabilityCoordinates[0].capabilityVersion', '2')",
      );
      wrongCoordinate.close();

      for (const root of roots)
        await expectLegacySourceAuthorityLockout(
          prepareProductionCatalogue({ productDataDirectory: root }),
          root,
        );
    } finally {
      await Promise.all(
        roots.map(
          async (root) => await rm(root, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("rejects recursively malformed legacy workflow and authority evidence atomically", async () => {
    const mutations = [
      "UPDATE workflow_executions SET workflow_input_json = json_remove(workflow_input_json, '$.version')",
      "UPDATE workflow_executions SET workflow_input_json = json_remove(workflow_input_json, '$.acceptTrusted')",
      "UPDATE workflow_executions SET workflow_input_json = json_remove(workflow_input_json, '$.configurationReferences')",
      "UPDATE workflow_executions SET workflow_input_json = json_set(workflow_input_json, '$.observedRoots', 17)",
      "UPDATE workflow_executions SET workflow_input_json = json_set(workflow_input_json, '$.trigger', 'information-fulfillment')",
      "UPDATE workflow_executions SET workflow_input_json = json_set(workflow_input_json, '$.configurationReferences', json_array('config', 'config'))",
      "UPDATE workflow_executions SET workflow_input_json = json_set(workflow_input_json, '$.configurationReferences', json_array(''))",
      "UPDATE workflow_executions SET source_enrichments_json = json_set(source_enrichments_json, '$[0].explicitInput', json('{}'))",
      "UPDATE workflow_executions SET source_enrichments_json = json_remove(source_enrichments_json, '$[0].evidence.kind')",
      "UPDATE workflow_executions SET source_enrichments_json = json_remove(source_enrichments_json, '$[0].evidence.explanation')",
      "UPDATE workflow_executions SET workflow_input_json = json_set(workflow_input_json, '$.observedRoots', json_array(json_object('version','observed-root-snapshot/1','id','root','configVersion',1,'containerPath','relative','canonicalPath','relative','readOnly',json('true'),'symlinkMode','do-not-follow','allowedTargetRootIds',json_array())))",
      "UPDATE workflow_executions SET source_enrichments_json = json_set(source_enrichments_json, '$[0].interpretation.privateCoordinate', 'leak')",
      "UPDATE workflow_executions SET source_enrichments_json = json_set(source_enrichments_json, '$[0].interpretation.sourceArtifacts', json_array(json_object('id','cover','sourceRecordId','record','sourceIdentity','source','role',17,'mediaType','image/jpeg','acquisitionReference','opaque:cover')))",
      "UPDATE workflow_executions SET source_enrichments_json = json_set(source_enrichments_json, '$[0].interpretation.metadata', json_array(json_object('private','accepted')))",
      "UPDATE workflow_executions SET source_enrichments_json = json_remove(source_enrichments_json, '$[0].subject.recognitionDecisionId')",
      "UPDATE workflow_executions SET source_enrichments_json = json_set(source_enrichments_json, '$[0].fulfilledArtifactRoles', json_array(json_object('role','asset.primary-cover','count',1), json_object('role','asset.primary-cover','count',1)))",
    ] as const;
    const roots = await Promise.all(
      mutations.map(() => temporaryProductData()),
    );
    try {
      for (const [index, root] of roots.entries()) {
        await prepareLegacySourceEnrichmentCatalogue(root, false);
        const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
        database.exec(mutations[index]!);
        database.close();
        let rejection: unknown;
        try {
          await prepareProductionCatalogue({ productDataDirectory: root });
        } catch (error) {
          rejection = error;
        }
        expect(rejection, `递归迁移反例 ${String(index + 1)}`).toEqual(
          expect.objectContaining({
            message: expect.stringContaining("生产迁移"),
          }),
        );
        const unchanged = new DatabaseSync(
          path.join(root, "catalogue.sqlite"),
          {
            readOnly: true,
          },
        );
        expect(
          unchanged
            .prepare(
              "SELECT 1 AS present FROM __digital_catalogue_migrations WHERE id = '20260906010000_source_identity_correction'",
            )
            .get(),
        ).toBeUndefined();
        unchanged.close();
      }
    } finally {
      await Promise.all(
        roots.map(
          async (root) => await rm(root, { recursive: true, force: true }),
        ),
      );
    }
  }, 30_000);

  it("实体容器错形时人物硬迁移整体闭锁并在同一库修复后恢复", async () => {
    const migrationId = "20261003010000_ordinary_people_and_personas";
    const artifact = productionMigrationArtifacts.find(
      ({ id }) => id === migrationId,
    );
    if (!artifact) throw new Error("缺少本票正式迁移产物");
    const productDataDirectory = await temporaryProductData();
    try {
      await mkdir(path.join(productDataDirectory, "managed-artifacts"), {
        recursive: true,
      });
      await copyFile(
        new URL(
          "../test/fixtures/entity-model/entity-e02-after-e01.sqlite",
          import.meta.url,
        ),
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      const corrupted = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      const target = corrupted
        .prepare(
          `SELECT id, basis_json FROM recognition_proposals
           WHERE json_type(basis_json, '$.interpretation.entities') = 'array'
             AND json_array_length(basis_json, '$.interpretation.entities') > 0
           ORDER BY id LIMIT 1`,
        )
        .get() as { id: string; basis_json: string };
      corrupted
        .prepare(
          `UPDATE recognition_proposals
           SET basis_json = json_set(
             basis_json, '$.interpretation.entities', json('{}'))
           WHERE id = ?`,
        )
        .run(target.id);
      corrupted.close();

      await expect(
        prepareProductionCatalogue({ productDataDirectory }),
      ).rejects.toThrow(`生产迁移 ${migrationId} 失败；Web 不会启动`);

      const rejected = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        rejected
          .prepare("SELECT 1 FROM __digital_catalogue_migrations WHERE id = ?")
          .get(migrationId),
      ).toBeUndefined();
      expect(
        rejected
          .prepare(
            "SELECT id, message FROM __digital_catalogue_migration_failures WHERE id = ?",
          )
          .get(migrationId),
      ).toEqual({ id: migrationId, message: "Error" });
      expect(
        rejected
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE name = 'entity_kind_decisions'",
          )
          .get(),
      ).toBeDefined();
      expect(
        rejected
          .prepare(
            `SELECT json_type(basis_json, '$.interpretation.entities') AS type
             FROM recognition_proposals WHERE id = ?`,
          )
          .get(target.id),
      ).toEqual({ type: "object" });
      rejected.close();
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "migration-failed" });

      const repaired = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      repaired
        .prepare("UPDATE recognition_proposals SET basis_json = ? WHERE id = ?")
        .run(target.basis_json, target.id);
      repaired.close();

      await expectDerivedPrepareApplied(productDataDirectory);
      const recovered = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        recovered
          .prepare(
            "SELECT checksum FROM __digital_catalogue_migrations WHERE id = ?",
          )
          .get(migrationId),
      ).toEqual({ checksum: artifact.checksum });
      expect(
        recovered
          .prepare(
            "SELECT 1 FROM __digital_catalogue_migration_failures WHERE id = ?",
          )
          .get(migrationId),
      ).toBeUndefined();
      recovered.close();
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });
      await expectDerivedPrepareApplied(productDataDirectory);
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("来源解释缺少必需 producer 时在 DDL 前闭锁并在同一库修复后恢复", async () => {
    const migrationId = "20261003010000_ordinary_people_and_personas";
    const artifact = productionMigrationArtifacts.find(
      ({ id }) => id === migrationId,
    );
    if (!artifact) throw new Error("缺少本票正式迁移产物");
    const productDataDirectory = await ordinaryEntityFixtureRoot();
    try {
      const corrupted = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      const target = requireRetiredSourceInterpretationBasis(corrupted);
      const basis = JSON.parse(target.basis_json) as Record<string, unknown>;
      delete (basis.interpretation as Record<string, unknown>).producer;
      corrupted
        .prepare("UPDATE recognition_proposals SET basis_json = ? WHERE id = ?")
        .run(JSON.stringify(basis), target.id);
      corrupted.close();

      await expect(
        prepareProductionCatalogue({ productDataDirectory }),
      ).rejects.toThrow(`生产迁移 ${migrationId} 失败；Web 不会启动`);
      expectRetiredMigrationBlockedBeforeDdl(productDataDirectory, migrationId);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "migration-failed" });

      const repaired = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      repaired
        .prepare("UPDATE recognition_proposals SET basis_json = ? WHERE id = ?")
        .run(target.basis_json, target.id);
      repaired.close();

      await expectDerivedPrepareApplied(productDataDirectory);
      const recovered = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        recovered
          .prepare(
            "SELECT checksum FROM __digital_catalogue_migrations WHERE id = ?",
          )
          .get(migrationId),
      ).toEqual({ checksum: artifact.checksum });
      expect(
        recovered
          .prepare(
            "SELECT 1 FROM __digital_catalogue_migration_failures WHERE id = ?",
          )
          .get(migrationId),
      ).toBeUndefined();
      recovered.close();
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });
      await expectDerivedPrepareApplied(productDataDirectory);
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("退役解释载体的每一处必需结构缺口都在 DDL 前被拒绝", async () => {
    const migrationId = "20261003010000_ordinary_people_and_personas";
    const holes = [
      {
        name: "独立来源解释批次缺少必需 producer",
        plant: (database: DatabaseSync) => {
          const planted = database
            .prepare(
              `UPDATE source_refresh_change_sets
               SET interpretation_json = json_remove(interpretation_json, '$.producer')
               WHERE json_type(interpretation_json, '$.entities') = 'array'`,
            )
            .run();
          requirePlanted(planted.changes, "独立来源解释批次");
        },
      },
      {
        name: "已解释 checkpoint 缺少整份解释批次",
        plant: (database: DatabaseSync) => {
          mutateRetiredCheckpointColumn(
            database,
            requireRetiredInterpretedExecution(database),
            "source_enrichments_json",
            "sourceEnrichments",
            (document) => {
              delete (
                (document as Record<string, unknown>[])[0] as Record<
                  string,
                  unknown
                >
              ).interpretation;
            },
          );
        },
      },
      {
        name: "失败阶段保留的解释批次缺少必需 producer",
        plant: (database: DatabaseSync) => {
          mutateRetiredCheckpointColumn(
            database,
            requireRetiredInterpretedExecution(database),
            "source_enrichments_json",
            "sourceEnrichments",
            (document) => {
              const checkpoint = (
                document as Record<string, unknown>[]
              )[0] as Record<string, unknown>;
              checkpoint.stage = "failed";
              delete (checkpoint.interpretation as Record<string, unknown>)
                .producer;
            },
          );
        },
      },
      {
        name: "关联决定候选的解释批次缺少必需 sourceAddress",
        plant: (database: DatabaseSync) => {
          mutateRetiredCheckpointColumn(
            database,
            requireRetiredAssociationDecisionExecution(database),
            "source_association_decision_json",
            "sourceAssociationDecision",
            (document) => {
              const candidate = (
                (document as Record<string, unknown>).candidates as Record<
                  string,
                  unknown
                >[]
              )[0] as Record<string, unknown>;
              delete (candidate.interpretation as Record<string, unknown>)
                .sourceAddress;
            },
          );
        },
      },
      {
        name: "预演 supersession 分支的 basis 缺少必需 producer",
        plant: (database: DatabaseSync) => {
          const target = requireRetiredSourceInterpretationBasis(database);
          const basis = JSON.parse(target.basis_json) as Record<
            string,
            unknown
          >;
          delete (basis.interpretation as Record<string, unknown>).producer;
          const planted = database
            .prepare(
              `UPDATE change_impact_previews
               SET preview_json = json_set(
                 preview_json, '$.change',
                 json_object('kind', 'recognition-supersession', 'proposal',
                   json_object('basis', json(?))))`,
            )
            .run(JSON.stringify(basis));
          requirePlanted(planted.changes, "预演 supersession 分支");
        },
      },
      {
        name: "预演投影的实体容器不是数组",
        plant: (database: DatabaseSync) => {
          const planted = database
            .prepare(
              `UPDATE change_impact_previews
               SET preview_json = json_set(
                 preview_json, '$.projected.entities', json('{}'))`,
            )
            .run();
          requirePlanted(planted.changes, "预演投影实体容器");
        },
      },
    ] as const;
    const roots = await Promise.all(
      holes.map(() => ordinaryEntityFixtureRoot()),
    );
    try {
      for (const [index, hole] of holes.entries()) {
        const productDataDirectory = roots[index]!;
        const database = new DatabaseSync(
          path.join(productDataDirectory, "catalogue.sqlite"),
        );
        hole.plant(database);
        database.close();
        await expect(
          prepareProductionCatalogue({ productDataDirectory }),
          `载体反例 ${hole.name}`,
        ).rejects.toThrow(`生产迁移 ${migrationId} 失败；Web 不会启动`);
        expectRetiredMigrationBlockedBeforeDdl(
          productDataDirectory,
          migrationId,
        );
        await expect(
          inspectProductionCatalogueReadiness({ productDataDirectory }),
        ).resolves.toMatchObject({ state: "migration-failed" });
      }
    } finally {
      await Promise.all(
        roots.map(
          async (root) => await rm(root, { recursive: true, force: true }),
        ),
      );
    }
  }, 120_000);

  it("合法可选解释成员缺省时仍可完整迁移", async () => {
    const productDataDirectory = await ordinaryEntityFixtureRoot();
    try {
      const mutated = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      const target = requireRetiredSourceInterpretationBasis(mutated);
      const planted = mutated
        .prepare(
          `UPDATE recognition_proposals
           SET basis_json = json_remove(
             basis_json,
             '$.interpretation.entities',
             '$.interpretation.entityMentions',
             '$.interpretation.entityResolutionDecisions',
             '$.interpretation.relationships')
           WHERE id = ?`,
        )
        .run(target.id);
      requirePlanted(planted.changes, "可选解释成员缺省");
      mutated.close();

      await expectDerivedPrepareApplied(productDataDirectory);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });
      await expectDerivedPrepareApplied(productDataDirectory);
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("合法 union 分支、保留的 failed 解释与镜像都通过退役载体预检", async () => {
    const productDataDirectory = await ordinaryEntityFixtureRoot();
    const database = new DatabaseSync(
      path.join(productDataDirectory, "catalogue.sqlite"),
    );
    try {
      // 正常 fixture：含 manual-boundary 与 source-interpretation、无 entities 的
      // 合法批次、source-association 预演分支与全部合法审计镜像。
      expect(() =>
        SqliteCatalogue.assertOrdinaryEntityMigrationAuthority(database),
      ).not.toThrow();

      database
        .prepare("UPDATE recognition_proposals SET basis_json = ? WHERE id = ?")
        .run(
          JSON.stringify(retiredObservedEvidenceBasis),
          (
            database
              .prepare(
                `SELECT id FROM recognition_proposals
                 WHERE json_extract(basis_json, '$.kind') = 'manual-boundary'
                 ORDER BY id LIMIT 1`,
              )
              .get() as { id: string }
          ).id,
        );
      expect(() =>
        SqliteCatalogue.assertOrdinaryEntityMigrationAuthority(database),
      ).not.toThrow();

      // 公开失败 checkpoint 合法保留整份解释，以及不带解释的合法阶段。
      const interpretedExecution = requireRetiredInterpretedExecution(database);
      mutateRetiredCheckpointColumn(
        database,
        interpretedExecution,
        "source_enrichments_json",
        "sourceEnrichments",
        (document) => {
          const checkpoints = document as Record<string, unknown>[];
          const source = checkpoints[0] as Record<string, unknown>;
          const failed = structuredClone(source);
          failed.stage = "failed";
          const withoutInterpretation = structuredClone(source);
          withoutInterpretation.stage = "candidate-interpreted";
          delete withoutInterpretation.interpretation;
          checkpoints.push(failed, withoutInterpretation);
        },
      );
      expect(() =>
        SqliteCatalogue.assertOrdinaryEntityMigrationAuthority(database),
      ).not.toThrow();

      // 预演 recognition-retraction 分支不含识别 basis。
      database
        .prepare(
          `UPDATE change_impact_previews
           SET preview_json = json_set(
             preview_json, '$.change',
             json_object('kind', 'recognition-retraction', 'intent',
               json_object('id', 'intent', 'assetId', 'asset',
                 'reason', 'retired', 'requestedBy', 'user')))`,
        )
        .run();
      expect(() =>
        SqliteCatalogue.assertOrdinaryEntityMigrationAuthority(database),
      ).not.toThrow();

      // 合法 NULL 审计不参与镜像等值。
      database
        .prepare(
          "UPDATE workflow_executions SET audit_json = NULL WHERE id = ?",
        )
        .run(interpretedExecution);
      expect(() =>
        SqliteCatalogue.assertOrdinaryEntityMigrationAuthority(database),
      ).not.toThrow();
    } finally {
      database.close();
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("闭锁携带隐藏识别成员的无解释 union 分支并在同一库恢复后可迁移", async () => {
    const migrationId = "20261003010000_ordinary_people_and_personas";
    const artifact = productionMigrationArtifacts.find(
      ({ id }) => id === migrationId,
    );
    if (!artifact) throw new Error("缺少本票正式迁移产物");
    // 每个反例都种在正式 SQL 真正改写的已知路径上：合法无解释的 union 分支不能
    // 因 discriminator 而被无条件放行，否则坏 carrier 照样取得一次性成功账本。
    const hiddenMembers = [
      {
        name: "manual-boundary basis 携带来源解释",
        carrier: "basis",
        path: "$.interpretation.entities",
        plant: (database: DatabaseSync) => {
          const source = requireRetiredSourceInterpretationBasis(database);
          const target = requireRetiredManualBoundaryBasis(database);
          pristineManual = target;
          const basis = JSON.parse(target.basis_json) as Record<
            string,
            unknown
          >;
          const interpretation = (
            JSON.parse(source.basis_json) as {
              interpretation: Record<string, unknown>;
            }
          ).interpretation;
          delete interpretation.producer;
          basis.interpretation = interpretation;
          database
            .prepare(
              "UPDATE recognition_proposals SET basis_json = ? WHERE id = ?",
            )
            .run(JSON.stringify(basis), target.id);
          return target.id;
        },
      },
      {
        name: "observed-evidence basis 携带来源解释",
        carrier: "basis",
        path: "$.interpretation.entities",
        plant: (database: DatabaseSync) => {
          const source = requireRetiredSourceInterpretationBasis(database);
          const target = requireRetiredManualBoundaryBasis(database);
          const basis = {
            ...structuredClone(retiredObservedEvidenceBasis),
            interpretation: (
              JSON.parse(source.basis_json) as Record<string, unknown>
            ).interpretation,
          };
          database
            .prepare(
              "UPDATE recognition_proposals SET basis_json = ? WHERE id = ?",
            )
            .run(JSON.stringify(basis), target.id);
          return target.id;
        },
      },
      {
        name: "来源关联预演的提议携带识别 basis",
        carrier: "preview",
        path: "$.change.proposal.basis.interpretation.entities",
        plant: (database: DatabaseSync) => {
          const source = requireRetiredSourceInterpretationBasis(database);
          const target = requireRetiredAssociationPreview(database);
          const planted = database
            .prepare(
              `UPDATE change_impact_previews
               SET preview_json = json_set(
                 preview_json, '$.change.proposal.basis', json(?))
               WHERE id = ?`,
            )
            .run(source.basis_json, target.id);
          requirePlanted(planted.changes, "来源关联预演提议");
          return target.id;
        },
      },
      {
        name: "撤回预演携带识别提议",
        carrier: "preview",
        path: "$.change.proposal.basis.interpretation.entities",
        plant: (database: DatabaseSync) => {
          const source = requireRetiredSourceInterpretationBasis(database);
          const target = requireRetiredAssociationPreview(database);
          const planted = database
            .prepare(
              `UPDATE change_impact_previews
               SET preview_json = json_set(
                 preview_json, '$.change',
                 json_object('kind', 'recognition-retraction', 'intent',
                   json_object('id', 'intent', 'assetId', 'asset',
                     'reason', 'retired', 'requestedBy', 'user'),
                   'proposal', json_object('basis', json(?))))
               WHERE id = ?`,
            )
            .run(source.basis_json, target.id);
          requirePlanted(planted.changes, "撤回预演");
          return target.id;
        },
      },
      {
        name: "来源关联预演携带识别取代兼容视图",
        carrier: "preview",
        path: "$.proposal.basis.interpretation.entities",
        plant: (database: DatabaseSync) => {
          const source = requireRetiredSourceInterpretationBasis(database);
          const target = requireRetiredAssociationPreview(database);
          const planted = database
            .prepare(
              `UPDATE change_impact_previews
               SET preview_json = json_set(
                 preview_json, '$.proposal', json_object('basis', json(?)))
               WHERE id = ?`,
            )
            .run(source.basis_json, target.id);
          requirePlanted(planted.changes, "识别取代兼容视图");
          return target.id;
        },
      },
    ] as const;
    // 记录 manual 分支被破坏前的合法字节，供同一库恢复段原样写回。
    let pristineManual:
      | { readonly id: string; readonly basis_json: string }
      | undefined;
    const roots = await Promise.all(
      hiddenMembers.map(() => ordinaryEntityFixtureRoot()),
    );
    try {
      for (const [index, hidden] of hiddenMembers.entries()) {
        const productDataDirectory = roots[index]!;
        const database = new DatabaseSync(
          path.join(productDataDirectory, "catalogue.sqlite"),
        );
        const targetId = hidden.plant(database);
        requireRetiredSqlPathHit(
          database,
          hidden.carrier,
          targetId,
          hidden.path,
        );
        database.close();
        await expect(
          prepareProductionCatalogue({ productDataDirectory }),
          `相斥反例 ${hidden.name}`,
        ).rejects.toThrow(`生产迁移 ${migrationId} 失败；Web 不会启动`);
        expectRetiredMigrationBlockedBeforeDdl(
          productDataDirectory,
          migrationId,
        );
        await expect(
          inspectProductionCatalogueReadiness({ productDataDirectory }),
        ).resolves.toMatchObject({ state: "migration-failed" });
      }

      // 同一库仅把 manual basis 改回原合法形状：必须按原 checksum 成功并复入 0。
      if (pristineManual === undefined)
        throw new Error("未记录 manual 分支被破坏前的合法字节");
      const recoveryRoot = roots[0]!;
      const recovering = new DatabaseSync(
        path.join(recoveryRoot, "catalogue.sqlite"),
      );
      recovering
        .prepare("UPDATE recognition_proposals SET basis_json = ? WHERE id = ?")
        .run(pristineManual.basis_json, pristineManual.id);
      recovering.close();
      await expectDerivedPrepareApplied(recoveryRoot);
      const migrated = new DatabaseSync(
        path.join(recoveryRoot, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        migrated
          .prepare(
            "SELECT checksum FROM __digital_catalogue_migrations WHERE id = ?",
          )
          .get(migrationId),
      ).toEqual({ checksum: artifact.checksum });
      expect(
        migrated
          .prepare(
            "SELECT 1 FROM __digital_catalogue_migration_failures WHERE id = ?",
          )
          .get(migrationId),
      ).toBeUndefined();
      migrated.close();
      await expect(
        inspectProductionCatalogueReadiness({
          productDataDirectory: recoveryRoot,
        }),
      ).resolves.toMatchObject({ state: "ready" });
      await expectDerivedPrepareApplied(recoveryRoot);

      // 识别取代分支合法携带兼容视图与自身 basis：互斥检查不得误拒。
      const legalRoot = await ordinaryEntityFixtureRoot();
      try {
        const database = new DatabaseSync(
          path.join(legalRoot, "catalogue.sqlite"),
        );
        const source = requireRetiredSourceInterpretationBasis(database);
        const preview = requireRetiredAssociationPreview(database);
        const planted = database
          .prepare(
            `UPDATE change_impact_previews
             SET preview_json = json_set(
               json_set(preview_json, '$.proposal',
                 json_object('basis', json(?))),
               '$.change',
               json_object('kind', 'recognition-supersession', 'proposal',
                 json_object('basis', json(?))))
             WHERE id = ?`,
          )
          .run(source.basis_json, source.basis_json, preview.id);
        requirePlanted(planted.changes, "识别取代预演");
        expect(() =>
          SqliteCatalogue.assertOrdinaryEntityMigrationAuthority(database),
        ).not.toThrow();
        database.close();
        await expectDerivedPrepareApplied(legalRoot);
      } finally {
        await rm(legalRoot, { recursive: true, force: true });
      }
    } finally {
      await Promise.all(
        roots.map(
          async (root) => await rm(root, { recursive: true, force: true }),
        ),
      );
    }
  }, 120_000);

  it("rejects a readiness chain whose source decision no longer projects its association", async () => {
    const root = await temporaryProductData();
    try {
      await prepareLegacySourceEnrichmentCatalogue(root, false);
      await prepareProductionCatalogue({ productDataDirectory: root });
      const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
      database.exec(
        "UPDATE source_association_change_proposals SET payload_json = json_set(payload_json, '$.successor.id', 'other-association')",
      );
      database.close();

      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory: root }),
      ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects NULL holes in a source decision establishment chain", async () => {
    const roots = await Promise.all([
      temporaryProductData(),
      temporaryProductData(),
    ]);
    try {
      for (const root of roots) {
        await prepareLegacySourceEnrichmentCatalogue(root, false);
        await prepareProductionCatalogue({ productDataDirectory: root });
      }
      for (const [index, pathToRemove] of [
        "$.successor.id",
        "$.successor.subjectId",
      ].entries()) {
        const database = new DatabaseSync(
          path.join(roots[index]!, "catalogue.sqlite"),
        );
        database
          .prepare(
            "UPDATE source_association_change_proposals SET payload_json = json_remove(payload_json, ?)",
          )
          .run(pathToRemove);
        database.close();
      }

      for (const root of roots)
        await expect(
          inspectProductionCatalogueReadiness({ productDataDirectory: root }),
        ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
    } finally {
      await Promise.all(
        roots.map(
          async (root) => await rm(root, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("replays every declared initial material while distinguishing terminated and ambiguous object history", async () => {
    const partial = await temporaryProductData();
    const terminated = await temporaryProductData();
    const ambiguous = await temporaryProductData();
    try {
      await prepareLegacyObservedMaterialCatalogue(partial, {
        materialReferences: ["one.txt", "missing.txt"],
        evidenceReferences: ["one.txt"],
        associationCount: 1,
      });
      await expect(
        prepareProductionCatalogue({ productDataDirectory: partial }),
      ).rejects.toThrow();

      await prepareLegacyObservedMaterialCatalogue(terminated, {
        materialReferences: ["one.txt"],
        evidenceReferences: ["one.txt"],
        associationCount: 1,
        terminated: true,
      });
      await expectDerivedPrepareApplied(terminated);
      const terminatedDatabase = new DatabaseSync(
        path.join(terminated, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        terminatedDatabase
          .prepare(
            "SELECT COUNT(*) AS count FROM artifact_association_recognition_supports",
          )
          .get(),
      ).toEqual({ count: 0 });
      terminatedDatabase.close();

      await prepareLegacyObservedMaterialCatalogue(ambiguous, {
        materialReferences: ["one.txt"],
        evidenceReferences: ["one.txt"],
        associationCount: 2,
      });
      await expect(
        prepareProductionCatalogue({ productDataDirectory: ambiguous }),
      ).rejects.toThrow();
    } finally {
      await rm(partial, { recursive: true, force: true });
      await rm(terminated, { recursive: true, force: true });
      await rm(ambiguous, { recursive: true, force: true });
    }
  });

  it("migrates an existing source recognition into the unified basis and recognition head", async () => {
    const productDataDirectory = await temporaryProductData();
    await mkdir(path.join(productDataDirectory, "managed-artifacts"), {
      recursive: true,
    });
    const databasePath = path.join(productDataDirectory, "catalogue.sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE __digital_catalogue_migrations (
          id TEXT PRIMARY KEY NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE __digital_catalogue_migration_failures (
          id TEXT PRIMARY KEY NOT NULL,
          message TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
      `);
      for (const artifact of productionMigrationArtifacts) {
        if (artifact.id === "20260830010000_recognition_basis_heads") break;
        const sql = await readFile(
          new URL(
            `../migrations/${artifact.id}/migration.sql`,
            import.meta.url,
          ),
          "utf8",
        );
        database.exec(sql);
        database
          .prepare(
            "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
          )
          .run(artifact.id, artifact.checksum, "2026-08-30T00:00:00.000Z");
      }
      const interpretation = {
        id: "source-interpretation",
        producer: {
          capabilityId: "test.interpreter",
          capabilityVersion: "1",
          contractVersion: "1",
        },
        sourceRecordIds: ["record"],
        sourceIdentity: "test-source",
        sourceAddress: "test:work",
        metadata: [],
        sourceArtifacts: [],
      };
      database
        .prepare(
          "INSERT INTO recognition_proposals (id, execution_id, interpretation_json, rule_results_json) VALUES (?, ?, ?, ?)",
        )
        .run("proposal", "execution", JSON.stringify(interpretation), "[]");
      database
        .prepare("INSERT INTO entities (id, kind) VALUES (?, ?)")
        .run("asset", "digital-asset");
      database
        .prepare(
          "INSERT INTO source_associations (id, subject_id, source_identity, native_address, proposal_id) VALUES (?, ?, ?, ?, ?)",
        )
        .run("association", "asset", "test-source", "test:work", "proposal");
      database
        .prepare(
          "INSERT INTO recognition_decisions (id, proposal_id, asset_id, accepted_rule_results_json) VALUES (?, ?, ?, ?)",
        )
        .run("decision", "proposal", "asset", "[]");
      database
        .prepare(
          "INSERT INTO source_association_heads (subject_id, association_id, recognition_decision_id) VALUES (?, ?, ?)",
        )
        .run("asset", "association", "decision");
      database
        .prepare(
          "INSERT INTO current_source_associations (subject_id, association_id) VALUES (?, ?)",
        )
        .run("asset", "association");
    } finally {
      database.close();
    }

    try {
      await expectDerivedPrepareApplied(productDataDirectory);
      const reopened = SqliteCatalogue.forProductData(productDataDirectory);
      await expect(reopened.listCurrentCatalogue()).resolves.toMatchObject([
        {
          entity: { id: "asset" },
          proposal: { basis: { kind: "source-interpretation" } },
          recognitionSourceAssociation: { id: "association" },
        },
      ]);
      reopened.close();
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("cleans only unreferenced proof sidecars while the offline writer lock is held", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      await prepareProductionCatalogue({ productDataDirectory });
      const referenced = "a".repeat(64);
      const orphan = "b".repeat(64);
      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      database.exec(`
        INSERT INTO blobs (digest, media_type, byte_length)
          VALUES ('${"c".repeat(64)}', 'application/octet-stream', 0);
        INSERT INTO artifact_content_proofs (
          blob_digest, scheme, byte_length, frame_size, frame_count,
          manifest_digest
        ) VALUES (
          '${"c".repeat(64)}', 'artifact-frame-manifest/1', 0, 1048576, 0,
          '${referenced}'
        );
      `);
      database.close();
      const referencedPath = path.join(
        productDataDirectory,
        "artifact-proofs",
        "sha256",
        referenced.slice(0, 2),
        `${referenced}.fproof`,
      );
      const orphanPath = path.join(
        productDataDirectory,
        "artifact-proofs",
        "sha256",
        orphan.slice(0, 2),
        `${orphan}.fproof`,
      );
      const stagingPath = path.join(
        productDataDirectory,
        "artifact-proofs",
        ".staging",
        "crashed.part",
      );
      await mkdir(path.dirname(referencedPath), { recursive: true });
      await mkdir(path.dirname(orphanPath), { recursive: true });
      await mkdir(path.dirname(stagingPath), { recursive: true });
      await writeFile(referencedPath, "referenced");
      await writeFile(orphanPath, "orphan");
      await writeFile(stagingPath, "partial");

      await prepareProductionCatalogue({ productDataDirectory });

      await expect(lstat(referencedPath)).resolves.toBeDefined();
      await expect(lstat(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(stagingPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("adopts a populated exact Drizzle baseline without replaying its DDL", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      await prepareDisposableProductDataCatalogue({ productDataDirectory });
      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      database
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run("adopted-row", "2026-08-20T00:00:00.000Z");
      database.close();

      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "catalogue-not-prepared" });

      // 采用路径不重放任何 DDL，也不登记迁移台账，因此这条断言钉的正是「零应用」。
      await expect(
        prepareProductionCatalogue({ productDataDirectory }),
      ).resolves.toEqual({ applied: 0 });
      const verified = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        verified
          .prepare("SELECT id FROM schema_migrations WHERE id = 'adopted-row'")
          .get(),
      ).toEqual({ id: "adopted-row" });
      verified.close();
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("serializes two independent formal CLI preparations of one product root", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      const [first, second] = await Promise.all([
        runFormalCli(productDataDirectory),
        runFormalCli(productDataDirectory),
      ]);
      expect(first).toBe(0);
      expect(second).toBe(0);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed for a newer ledger or an interrupted migration", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      await prepareProductionCatalogue({ productDataDirectory });
      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      database.exec(
        "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES ('99999999999999_future', 'future', '2026-08-20T00:00:00.000Z')",
      );
      database.close();
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "schema-newer-than-application" });
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed when a real applied ledger checksum is tampered", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      await prepareProductionCatalogue({ productDataDirectory });
      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      database.exec(
        "UPDATE __digital_catalogue_migrations SET checksum = 'tampered'",
      );
      database.close();
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("rejects runtime access to an unprepared or interrupted real catalogue", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      const unprepared = SqliteCatalogue.forProductData(productDataDirectory);
      await expect(unprepared.listCurrentCatalogue()).rejects.toThrow(
        "运行 digital-db-migrate prepare-only",
      );
      await prepareProductionCatalogue({ productDataDirectory });
      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      database.exec(
        "INSERT INTO __digital_catalogue_migration_failures (id, message, occurred_at) VALUES ('20260820000000_v1_catalogue_baseline', 'failed', '2026-08-20T00:00:00.000Z')",
      );
      database.close();
      const interrupted = SqliteCatalogue.forProductData(productDataDirectory);
      await expect(interrupted.listCurrentCatalogue()).rejects.toThrow(
        "曾失败",
      );
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("reports a missing required local product dependency without treating it as liveness", async () => {
    const productDataDirectory = await temporaryProductData();
    try {
      await prepareProductionCatalogue({ productDataDirectory });
      await rm(path.join(productDataDirectory, "managed-artifacts"), {
        recursive: true,
      });
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "local-dependency-missing" });
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  });

  it("durably records a deployed CLI migration failure without rolling back existing catalogue data", async () => {
    const productDataDirectory = await temporaryProductData();
    const deploymentDirectory = await mkdtemp(
      path.join(tmpdir(), "digital-db-migrations-deploy-"),
    );
    try {
      // 这是包含数据且与议题 08 兼容的真实 Drizzle 基线，但其指纹被刻意损坏，
      // 使重放抵达与现有目录冲突的 DDL。
      await prepareDisposableProductDataCatalogue({ productDataDirectory });
      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      database
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run("preserved-before-failure", "2026-08-20T00:00:00.000Z");
      database.exec("DROP INDEX workflow_executions_reuse");
      database.close();

      await deployFormalCli(deploymentDirectory);
      const result = await runDeployedFormalCli(
        deploymentDirectory,
        productDataDirectory,
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("生产数据库准备失败：生产迁移");
      expect(result.stderr).not.toMatch(/SQLITE|node:sqlite|\bat\s+/u);

      const verified = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      expect(
        verified
          .prepare("SELECT id FROM schema_migrations WHERE id = ?")
          .get("preserved-before-failure"),
      ).toEqual({ id: "preserved-before-failure" });
      expect(
        verified
          .prepare(
            "SELECT id, message FROM __digital_catalogue_migration_failures",
          )
          .get(),
      ).toEqual({
        id: "20260820000000_v1_catalogue_baseline",
        message: "Error",
      });
      verified.close();
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "migration-failed" });
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
      await rm(deploymentDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  it("rebuilds current material membership from a real old-contract catalogue", async () => {
    // fixture 由固定点 911a0c3 的正式装配与公开产品操作生成：注册观察根、普通文件
    // 人工准入、两个 BDMV 目录定向识别，然后删除其中一个已准入文件与其中一个已准入
    // 目录包，再以根完整扫描确认缺失。
    const productDataDirectory = await temporaryProductData();
    const oldContract = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/observed-material-before-current-supports/manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      assets: Record<
        "gone" | "kept" | "directoryPackage" | "directoryPackageGone",
        string
      >;
      baselineCurrentPage: readonly { id: string }[];
    };
    try {
      await mkdir(path.join(productDataDirectory, "managed-artifacts"), {
        recursive: true,
      });
      await copyFile(
        new URL(
          "./fixtures/observed-material-before-current-supports/catalogue.sqlite",
          import.meta.url,
        ),
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      // 旧合同下四者的公开当前页都包含已消失材料的资产。
      expect(oldContract.baselineCurrentPage.map(({ id }) => id)).toEqual(
        expect.arrayContaining([
          oldContract.assets.gone,
          oldContract.assets.kept,
          oldContract.assets.directoryPackage,
          oldContract.assets.directoryPackageGone,
        ]),
      );

      await expectDerivedPrepareApplied(productDataDirectory);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });

      const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
      const migratedIds = (await catalogue.listCurrentCatalogue()).map(
        ({ entity }) => entity.id,
      );
      // 材料仍在的普通文件与目录包各自迁入正向支持；失去唯一文件的旧覆盖支持、以及
      // 被更晚完整扫描确认缺失的目录包历史条目都不提供成员资格。
      expect(migratedIds.toSorted()).toEqual(
        [oldContract.assets.kept, oldContract.assets.directoryPackage].sort(),
      );
      const history = await catalogue.listWorkflowHistoryPage({ limit: 50 });
      for (const exited of [
        oldContract.assets.gone,
        oldContract.assets.directoryPackageGone,
      ])
        expect(
          history.items.some(({ resultReferences }) =>
            resultReferences.acceptedAssetIds.includes(exited),
          ),
        ).toBe(true);
      catalogue.close();

      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      try {
        const goneLocation = database
          .prepare("SELECT id FROM locations WHERE address LIKE '%/gone.txt'")
          .get() as { id: string };
        // 只读核对迁移投影：旧覆盖支持保留，但没有正向材料支持。
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM current_file_observation_supports WHERE location_id = ?",
            )
            .get(goneLocation.id),
        ).toEqual({ count: 1 });
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM current_observed_material_supports WHERE location_id = ?",
            )
            .get(goneLocation.id),
        ).toEqual({ count: 0 });
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM artifact_associations
               WHERE subject_id = ? AND role = 'asset.material-delivered'`,
            )
            .get(oldContract.assets.gone),
        ).toEqual({ count: 1 });

        // 目录包负项同理：更晚的根完整扫描确认缺失后，旧目录条目不迁入正向支持，
        // 但已接受的交付事实与覆盖支持都保留。
        const gonePackage = database
          .prepare("SELECT id FROM locations WHERE address LIKE '%/film-gone'")
          .get() as { id: string };
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM current_file_observation_supports WHERE location_id = ?",
            )
            .get(gonePackage.id),
        ).toEqual({ count: 1 });
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM current_observed_material_supports WHERE location_id = ?",
            )
            .get(gonePackage.id),
        ).toEqual({ count: 0 });
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM artifact_associations
               WHERE subject_id = ? AND role = 'asset.material-delivered'`,
            )
            .get(oldContract.assets.directoryPackageGone),
        ).toEqual({ count: 1 });
        // 仍存在的目录包由最近一次覆盖它的完整扫描迁入目录正向支持。
        const keptPackage = database
          .prepare("SELECT id FROM locations WHERE address LIKE '%/film'")
          .get() as { id: string };
        expect(
          database
            .prepare(
              `SELECT material_kind FROM current_observed_material_supports WHERE location_id = ?`,
            )
            .get(keptPackage.id),
        ).toEqual({ material_kind: "directory" });
      } finally {
        database.close();
      }

      await expectDerivedPrepareApplied(productDataDirectory);
      const reopened = SqliteCatalogue.forProductData(productDataDirectory);
      expect(
        (await reopened.listCurrentCatalogue()).map(({ entity }) => entity.id),
      ).toEqual(migratedIds);
      reopened.close();
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps a healthy legacy duplicate package current without inventing acceptance provenance", async () => {
    // fixture 由固定点 911a0c3 的公开产品操作生成：内层根定向接受一个 BDMV 目录包，外层
    // 重叠根完成一次完整扫描，随后内层根只改动成员 mtime 的公开重扫再次接受同一地址。
    const { productDataDirectory, manifest } = await oldContractFixture(
      "legacy-duplicate-package-before-current-supports",
    );
    try {
      await expectDerivedPrepareApplied(productDataDirectory);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });

      const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
      const current = await catalogue.listCurrentCatalogue();
      catalogue.close();
      // 同 asset 同址的重复 package 不阻断迁移，资产仍公开 current。
      expect(current.map(({ entity }) => entity.id)).toEqual([
        manifest.assets.duplicatePackage,
      ]);

      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      try {
        const locations = database
          .prepare(
            "SELECT id FROM locations WHERE address LIKE '%/media/item' ORDER BY rowid",
          )
          .all() as unknown as readonly { id: string }[];
        expect(locations.map(({ id }) => id).toSorted()).toEqual(
          (current[0]?.locations ?? []).map(({ id }) => id).toSorted(),
        );
        expect(locations).toHaveLength(2);
        // 重复目录只固定形态：两个 Location 都是 legacy-kind-equivalent 的 directory 边界，
        // 且没有任何执行→Location 的接受映射被伪造出来。
        expect(
          database
            .prepare(
              `SELECT material_kind AS kind, derivation_kind AS derivation,
                 COUNT(*) AS count
               FROM observed_material_boundaries
               GROUP BY material_kind, derivation_kind`,
            )
            .all(),
        ).toEqual([
          {
            kind: "directory",
            derivation: "legacy-kind-equivalent",
            count: 2,
          },
        ]);
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM observed_material_acceptances",
            )
            .get(),
        ).toEqual({ count: 0 });
        // 每个等价 Location 在自己的每个覆盖根上各有一行正向支持：内层根的最近接受事件和
        // 外层根更早的完整扫描都不被对方的时间截断。
        expect(
          database
            .prepare(
              `SELECT location_id AS locationId, COUNT(*) AS count
               FROM current_observed_material_supports
               GROUP BY location_id ORDER BY location_id`,
            )
            .all(),
        ).toEqual(
          locations
            .map(({ id }) => ({ locationId: id, count: 2 }))
            .toSorted((a, b) => (a.locationId < b.locationId ? -1 : 1)),
        );
        expect(
          database
            .prepare(
              `SELECT observed_root_id AS rootId, COUNT(DISTINCT location_id) AS locations
               FROM current_observed_material_supports
               GROUP BY observed_root_id ORDER BY observed_root_id`,
            )
            .all(),
        ).toEqual(
          [
            { rootId: manifest.observedRootId, locations: 2 },
            { rootId: manifest.outerRootId, locations: 2 },
          ].toSorted((a, b) => (a.rootId! < b.rootId! ? -1 : 1)),
        );
        expect(supportsOutsideTheirOwnFrozenEvent(database)).toEqual([]);
      } finally {
        database.close();
      }

      await expectDerivedPrepareApplied(productDataDirectory);
      const reopened = SqliteCatalogue.forProductData(productDataDirectory);
      expect(
        (await reopened.listCurrentCatalogue()).map(({ entity }) => entity.id),
      ).toEqual(current.map(({ entity }) => entity.id));
      reopened.close();
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps a healthy legacy top-level A accepted asset current after upgrade", async () => {
    // fixture 由固定点 911a0c3 的真实受信扫描生成：一次 scan-filesystem completed accepted
    // 执行自身持有顶层 proposal 与 acceptedAsset，却没有任何工作项（work_items_json 为空），
    // proposal.observedArtifactAssociations 交付一个 file 材料。真正 C 之前它正常公开 current，
    // 升级后必须仍 current，且不得伪造任何执行→Location 之外的接受出处。
    // 组合计划共 21 条，base911 账本为 17 条，故本次 prepare 实际新增 4 条（而非源 18 计划里的 1）。
    const { productDataDirectory, manifest } = await oldContractFixture(
      "legacy-top-level-a-before-current-supports",
    );
    try {
      await expectDerivedPrepareApplied(productDataDirectory);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });

      const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
      const current = await catalogue.listCurrentCatalogue();
      catalogue.close();
      expect(current.map(({ entity }) => entity.id)).toEqual([
        manifest.assets.topLevelA,
      ]);

      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      let locationId = "";
      try {
        const acceptances = database
          .prepare(
            `SELECT a.acceptance_kind AS kind, a.work_item_key AS key,
               a.execution_id AS executionId, a.proposal_id AS proposalId,
               a.observed_reference AS reference, b.derivation_kind AS derivation,
               b.material_kind AS materialKind
             FROM observed_material_acceptances AS a
             INNER JOIN observed_material_boundaries AS b ON b.location_id = a.location_id`,
          )
          .all() as unknown as readonly {
          kind: string;
          key: string;
          executionId: string;
          proposalId: string;
          reference: string;
          derivation: string;
          materialKind: string;
        }[];
        // 顶层 A 的唯一 file 载体：空 work_item_key、a-work-item 归属、精确 legacy-exact 派生，
        // carrier 坐标就是执行自身的 proposal 与 acceptedAsset，出处来自 observedArtifactAssociations。
        expect(acceptances).toHaveLength(1);
        expect(acceptances[0]).toMatchObject({
          kind: "a-work-item",
          key: "",
          materialKind: "file",
          derivation: "legacy-exact",
          reference: "notes.txt",
        });
        expect(acceptances[0]?.executionId).not.toBe("");
        expect(acceptances[0]?.proposalId).not.toBe("");

        const supports = database
          .prepare(
            `SELECT location_id AS locationId, material_kind AS kind,
               observed_root_id AS rootId
             FROM current_observed_material_supports`,
          )
          .all() as unknown as readonly {
          locationId: string;
          kind: string;
          rootId: string;
        }[];
        expect(supports).toHaveLength(1);
        expect(supports[0]).toMatchObject({ kind: "file" });
        expect(supports[0]?.rootId).toBe(manifest.observedRootId);
        locationId = supports[0]?.locationId ?? "";
        expect(supportRows(database, locationId)).toEqual([
          { rootId: manifest.observedRootId, kind: "file" },
        ]);
        expect(supportsOutsideTheirOwnFrozenEvent(database)).toEqual([]);
      } finally {
        database.close();
      }

      // 重开正确且历史不丢：迁移幂等 applied 0，资产仍 current，账本保留全部历史行。
      await expectDerivedPrepareApplied(productDataDirectory);
      const reopened = SqliteCatalogue.forProductData(productDataDirectory);
      expect(
        (await reopened.listCurrentCatalogue()).map(({ entity }) => entity.id),
      ).toEqual(current.map(({ entity }) => entity.id));
      reopened.close();

      const reopenedDatabase = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      try {
        const ledger = reopenedDatabase
          .prepare("SELECT id, checksum FROM __digital_catalogue_migrations")
          .all() as unknown as readonly { id: string; checksum: string }[];
        expect(ledger).toHaveLength(productionMigrationArtifacts.length);
        const head = ledger.find(
          ({ id }) =>
            id === "20261003000000_current_observed_material_supports",
        );
        expect(head?.checksum).toBe(
          productionMigrationArtifacts.find(
            ({ id }) =>
              id === "20261003000000_current_observed_material_supports",
          )?.checksum,
        );
        // 升级不改写既有 Location/association/artifact 身份，也不伪造新的执行。
        expect(
          reopenedDatabase
            .prepare("SELECT COUNT(*) AS count FROM workflow_executions")
            .get(),
        ).toEqual({ count: 1 });
        expect(supportRows(reopenedDatabase, locationId)).toEqual([
          { rootId: manifest.observedRootId, kind: "file" },
        ]);
      } finally {
        reopenedDatabase.close();
      }
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps each overlapping root's own latest complete observation decisive", async () => {
    // fixture 由固定点 911a0c3 的公开产品操作生成：父根人工准入两份材料，子根覆盖同一
    // 目录；随后同一 inode 的 rename 使子根最近完整扫描缺失 book.txt，父根再次完整扫描
    // 确认它在。dual.txt 是两根最近完整事件都为 present 的正项。
    const { productDataDirectory, manifest } = await oldContractFixture(
      "overlapping-roots-before-current-supports",
    );
    try {
      await expectDerivedPrepareApplied(productDataDirectory);
      const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
      const current = await catalogue.listCurrentCatalogue();
      catalogue.close();
      expect(current.map(({ entity }) => entity.id).toSorted()).toEqual(
        Object.values(manifest.assets).toSorted(),
      );

      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      try {
        const locationId = (suffix: string) =>
          (
            database
              .prepare("SELECT id FROM locations WHERE address LIKE ?")
              .get(`%${suffix}`) as { id: string }
          ).id;
        const rootRole = (rootId: string) =>
          rootId === manifest.parentRootId
            ? "parent"
            : rootId === manifest.childRootId
              ? "child"
              : `unknown:${rootId}`;
        const supports = (suffix: string) =>
          supportRows(database, locationId(suffix))
            .map(({ rootId, kind }) => `${rootRole(rootId)}:${kind}`)
            .toSorted();
        const coverage = (suffix: string) =>
          coverageRows(database, locationId(suffix)).map(rootRole).toSorted();
        // 子根 B 的最近完整事件缺失 book.txt，因此 B 坐标只有覆盖历史而没有正向支持；
        // 父根 A 的最近完整事件为 present，只按 A 自己的坐标给出支持。
        expect(supports("/child/book.txt")).toEqual(["parent:file"]);
        expect(coverage("/child/book.txt")).toEqual(["child", "parent"]);
        // 两根最近完整事件都为 present 的材料各自保留自己的正项，不互相借用。
        expect(supports("/child/dual.txt")).toEqual([
          "child:file",
          "parent:file",
        ]);
        expect(coverage("/child/dual.txt")).toEqual(["child", "parent"]);
        expect(supportsOutsideTheirOwnFrozenEvent(database)).toEqual([]);
      } finally {
        database.close();
      }
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("never promotes a same-address shape change into the other material kind", async () => {
    // fixture 由固定点 911a0c3 的公开产品操作生成：普通文件与 BDMV 目录包各自被人工准入
    // 或定向接受，随后两个地址互换形态，再由一次根完整扫描确认。
    const { productDataDirectory, manifest } = await oldContractFixture(
      "observed-material-shape-swap-before-current-supports",
    );
    try {
      await expectDerivedPrepareApplied(productDataDirectory);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });

      const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
      const current = await catalogue.listCurrentCatalogue();
      const history = await catalogue.listWorkflowHistoryPage({ limit: 50 });
      catalogue.close();
      // 两个互换形态的资产都退出普通 current 查询；形态后来的热观察不能将 file 边界
      // 升级为 directory 支持，目录边界也不能因同址新文件而复活。
      const healthy = fixtureAssetIds(manifest, [
        "keptFile",
        "directoryPackage",
      ]);
      expect(current.map(({ entity }) => entity.id).toSorted()).toEqual(
        healthy.toSorted(),
      );
      for (const exited of fixtureAssetIds(manifest, [
        "fileToDirectory",
        "directoryToFile",
      ]))
        expect(
          history.items.some(({ resultReferences }) =>
            resultReferences.acceptedAssetIds.includes(exited),
          ),
        ).toBe(true);

      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          database
            .prepare(
              `SELECT substr(l.address, instr(l.address, '/media')) AS address,
                 b.material_kind AS kind, b.derivation_kind AS derivation
               FROM observed_material_boundaries AS b
               INNER JOIN locations AS l ON l.id = b.location_id
               ORDER BY l.address`,
            )
            .all(),
        ).toEqual([
          {
            address: "/media/fileToDir",
            kind: "file",
            derivation: "legacy-exact",
          },
          {
            address: "/media/kept.txt",
            kind: "file",
            derivation: "legacy-exact",
          },
          {
            address: "/media/pkgKept",
            kind: "directory",
            derivation: "legacy-exact",
          },
          {
            address: "/media/pkgToFile",
            kind: "directory",
            derivation: "legacy-exact",
          },
        ]);
        expect(
          database
            .prepare(
              `SELECT substr(l.address, instr(l.address, '/media')) AS address,
                 s.material_kind AS kind
               FROM current_observed_material_supports AS s
               INNER JOIN locations AS l ON l.id = s.location_id
               ORDER BY l.address`,
            )
            .all(),
        ).toEqual([
          { address: "/media/kept.txt", kind: "file" },
          { address: "/media/pkgKept", kind: "directory" },
        ]);
        expect(supportsOutsideTheirOwnFrozenEvent(database)).toEqual([]);
      } finally {
        database.close();
      }
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("attributes each material carrier to the execution that created its Location", async () => {
    // fixture 由固定点 911a0c3 的公开产品操作生成：三个 BDMV 目录包各自被定向识别接受，
    // 随后 /media/case 的目录被替换成同址普通文件、由观察材料追加补到同一资产；另外两个
    // 降格包各留下一份尚未 apply 的识别取代预演。
    const { productDataDirectory, manifest } = await oldContractFixture(
      "observed-material-carriers-before-current-supports",
    );
    try {
      await expectDerivedPrepareApplied(productDataDirectory);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });

      const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
      const current = await catalogue.listCurrentCatalogue();
      catalogue.close();
      expect(current.map(({ entity }) => entity.id).toSorted()).toEqual(
        Object.values(manifest.assets).toSorted(),
      );
      // 追加进来的同址普通文件真正新增了一个观察 Location，与原目录包并存而不是被并入它。
      expect(
        (
          current.find(
            ({ entity }) => entity.id === manifest.assets.caseSuperseded,
          )?.locations ?? []
        )
          .filter(({ kind }) => kind === "observed")
          .map(({ address }) => address.slice(address.lastIndexOf("/media")))
          .toSorted(),
      ).toEqual(["/media/case", "/media/case"]);

      const database = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      try {
        // 每个 Location 保留自己那份精确边界：同址重复的 file 与 directory 都是 legacy-exact，
        // 没有一行被降级成 legacy-kind-equivalent 的形态固定。
        expect(
          database
            .prepare(
              `SELECT material_kind AS kind, derivation_kind AS derivation,
                 COUNT(*) AS count
               FROM observed_material_boundaries
               GROUP BY kind, derivation
               ORDER BY kind`,
            )
            .all(),
        ).toEqual([
          { kind: "directory", derivation: "legacy-exact", count: 3 },
          { kind: "file", derivation: "legacy-exact", count: 1 },
        ]);
        expect(
          database
            .prepare(
              `SELECT substr(l.address, instr(l.address, '/media')) AS address,
                 a.acceptance_kind AS acceptanceKind,
                 a.work_item_key AS workItemKey, a.observed_reference AS reference,
                 e.operation_kind AS operation, b.material_kind AS kind
               FROM observed_material_acceptances AS a
               INNER JOIN observed_material_boundaries AS b ON b.location_id = a.location_id
               INNER JOIN locations AS l ON l.id = a.location_id
               INNER JOIN workflow_executions AS e ON e.id = a.execution_id
               ORDER BY address, acceptanceKind`,
            )
            .all(),
        ).toEqual([
          {
            address: "/media/case",
            acceptanceKind: "a-work-item",
            workItemKey: "directed-recognition",
            reference: ".",
            operation: "scan-filesystem",
            kind: "directory",
          },
          {
            address: "/media/case",
            acceptanceKind: "c-association",
            workItemKey: "",
            reference: "case",
            operation: "associate-observed-material",
            kind: "file",
          },
          {
            address: "/media/preview",
            acceptanceKind: "a-work-item",
            workItemKey: "directed-recognition",
            reference: ".",
            operation: "scan-filesystem",
            kind: "directory",
          },
          {
            address: "/media/preview-dual",
            acceptanceKind: "a-work-item",
            workItemKey: "directed-recognition",
            reference: ".",
            operation: "scan-filesystem",
            kind: "directory",
          },
        ]);
        // 两份预演都还停留在未 apply 状态，因此不构成历史接受来源，迁移不写任何 a-preview 绑定。
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM change_impact_previews WHERE status = 'awaiting-confirmation'",
            )
            .get(),
        ).toEqual({ count: 2 });
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM observed_material_acceptances
               WHERE acceptance_kind = 'a-preview'`,
            )
            .get(),
        ).toEqual({ count: 0 });
        // 每个 Location 在自己的那个观察根上各有一行正向支持，形态与自己的边界一致。
        expect(
          database
            .prepare(
              `SELECT substr(l.address, instr(l.address, '/media')) AS address,
                 s.material_kind AS kind, s.observed_root_id AS rootId, COUNT(*) AS count
               FROM current_observed_material_supports AS s
               INNER JOIN locations AS l ON l.id = s.location_id
               GROUP BY s.location_id, s.observed_root_id
               ORDER BY address, kind`,
            )
            .all(),
        ).toEqual([
          {
            address: "/media/case",
            kind: "directory",
            rootId: manifest.observedRootId,
            count: 1,
          },
          {
            address: "/media/case",
            kind: "file",
            rootId: manifest.observedRootId,
            count: 1,
          },
          {
            address: "/media/preview",
            kind: "directory",
            rootId: manifest.observedRootId,
            count: 1,
          },
          {
            address: "/media/preview-dual",
            kind: "directory",
            rootId: manifest.observedRootId,
            count: 1,
          },
        ]);
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS mismatched
               FROM current_observed_material_supports AS s
               INNER JOIN observed_material_boundaries AS b ON b.location_id = s.location_id
               WHERE s.material_kind <> b.material_kind`,
            )
            .get(),
        ).toEqual({ mismatched: 0 });
        expect(supportsOutsideTheirOwnFrozenEvent(database)).toEqual([]);
      } finally {
        database.close();
      }

      await expectDerivedPrepareApplied(productDataDirectory);
      const reopened = SqliteCatalogue.forProductData(productDataDirectory);
      expect(
        (await reopened.listCurrentCatalogue()).map(({ entity }) => entity.id),
      ).toEqual(current.map(({ entity }) => entity.id));
      reopened.close();
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("rolls the material support migration back after its durable DDL and recovers the same database", async () => {
    const { productDataDirectory } = await oldContractFixture(
      "legacy-duplicate-package-before-current-supports",
    );
    const head = productionMigrationArtifacts.find(
      ({ id }) => id === "20261003000000_current_observed_material_supports",
    )!;
    try {
      // 让本迁移在持久 DDL 之后的回填语句上失败：保留的完整快照 JSON 已不可解析。
      const corrupting = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      let snapshots: string | undefined;
      try {
        const row = corrupting
          .prepare(
            `SELECT filesystem_snapshots_json AS json FROM workflow_executions
             WHERE filesystem_snapshots_json IS NOT NULL LIMIT 1`,
          )
          .get() as { json: string };
        snapshots = row.json;
        corrupting
          .prepare(
            `UPDATE workflow_executions SET filesystem_snapshots_json = '['
             WHERE filesystem_snapshots_json = ?`,
          )
          .run(row.json);
      } finally {
        corrupting.close();
      }

      await expect(
        prepareProductionCatalogue({ productDataDirectory }),
      ).rejects.toThrow();
      const closed = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      try {
        // DDL、回填与账本同属一个事务：中断点之后的表与账本行都不留下。
        expect(
          closed
            .prepare(
              `SELECT name FROM sqlite_master WHERE name IN
               ('observed_material_boundaries', 'observed_material_acceptances',
                'current_observed_material_supports')`,
            )
            .all(),
        ).toEqual([]);
        expect(
          closed
            .prepare(
              "SELECT id FROM __digital_catalogue_migrations WHERE id = ?",
            )
            .get(head.id),
        ).toBeUndefined();
        expect(
          closed
            .prepare(
              "SELECT id FROM __digital_catalogue_migration_failures WHERE id = ?",
            )
            .get(head.id),
        ).toEqual({ id: head.id });
      } finally {
        closed.close();
      }
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "migration-failed" });

      const repairing = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
      );
      try {
        repairing
          .prepare(
            `UPDATE workflow_executions SET filesystem_snapshots_json = ?
             WHERE filesystem_snapshots_json = '['`,
          )
          .run(snapshots!);
      } finally {
        repairing.close();
      }
      await expectDerivedPrepareApplied(productDataDirectory);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });
      const ledger = new DatabaseSync(
        path.join(productDataDirectory, "catalogue.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          ledger
            .prepare(
              "SELECT checksum FROM __digital_catalogue_migrations WHERE id = ?",
            )
            .get(head.id),
        ).toEqual({ checksum: head.checksum });
        expect(
          ledger
            .prepare(
              "SELECT id FROM __digital_catalogue_migration_failures WHERE id = ?",
            )
            .get(head.id),
        ).toBeUndefined();
      } finally {
        ledger.close();
      }
      await expectDerivedPrepareApplied(productDataDirectory);
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("当耐久当前材料内容与其冻结坐标不再匹配时闭锁正式 readiness", async () => {
    // 三张新表都是当前资料库查询不可缺的耐久合同。逐表把一行已审阅内容的决定性字段
    // 改成同形但不同源的值，正式 readiness 必须闭锁；恢复原值后同一个库重新 ready。
    const { productDataDirectory } = await oldContractFixture(
      "observed-material-before-current-supports",
    );
    const databasePath = path.join(productDataDirectory, "catalogue.sqlite");
    const corruptions = [
      {
        table: "current_observed_material_supports",
        column: "authorized_targets_json",
        damaged: "{",
      },
      {
        table: "observed_material_boundaries",
        column: "artifact_id",
        damaged: "damaged-artifact",
      },
      {
        table: "observed_material_acceptances",
        column: "association_id",
        damaged: "damaged-association",
      },
    ] as const;
    try {
      await expectDerivedPrepareApplied(productDataDirectory);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });

      for (const { table, column, damaged } of corruptions) {
        const damaging = new DatabaseSync(databasePath);
        let rowId: number;
        let original: string;
        try {
          const row = damaging
            .prepare(
              `SELECT rowid AS row_id, ${column} AS value FROM ${table} ORDER BY rowid LIMIT 1`,
            )
            .get() as { row_id: number; value: string };
          rowId = row.row_id;
          original = row.value;
          damaging
            .prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`)
            .run(damaged, rowId);
        } finally {
          damaging.close();
        }

        await expect(
          inspectProductionCatalogueReadiness({ productDataDirectory }),
        ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
        const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
        try {
          await expect(catalogue.listCurrentCatalogue()).rejects.toThrow(
            "观察材料决定支持链损坏",
          );
        } finally {
          catalogue.close();
        }

        const restored = new DatabaseSync(databasePath);
        try {
          restored
            .prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`)
            .run(original, rowId);
        } finally {
          restored.close();
        }
        await expect(
          inspectProductionCatalogueReadiness({ productDataDirectory }),
        ).resolves.toMatchObject({ state: "ready" });
      }

      // 自身载体一致性：a-work-item 的 proposal 与 work item key 都必须落在它自己执行的
      // work_items_json 上。把它们换成库里另一条真实执行持有的引用后，正式 readiness 必须
      // 闭锁并挡住公开查询；换回原值后同一个库重新 ready。
      const carrierProbe = new DatabaseSync(databasePath, { readOnly: true });
      let carrierRowId: number;
      let foreignProposalId: string;
      let foreignWorkItemKey: string;
      try {
        carrierRowId = (
          carrierProbe
            .prepare(
              `SELECT rowid AS row_id FROM observed_material_acceptances
               WHERE acceptance_kind = 'a-work-item' AND work_item_key <> ''
               ORDER BY rowid LIMIT 1`,
            )
            .get() as { row_id: number }
        ).row_id;
        const foreignProposal = carrierProbe
          .prepare(
            `SELECT (SELECT p.id FROM recognition_proposals p
                      WHERE p.execution_id <> a.execution_id LIMIT 1) AS other_id
             FROM observed_material_acceptances a WHERE a.rowid = ?`,
          )
          .get(carrierRowId) as { other_id: string | null };
        const foreignItem = carrierProbe
          .prepare(
            `SELECT json_extract(item.value, '$.key') AS other_key
             FROM workflow_executions e
             CROSS JOIN json_each(COALESCE(e.work_items_json, '[]')) item
             WHERE e.id <> (SELECT execution_id FROM observed_material_acceptances WHERE rowid = ?)
               AND json_extract(item.value, '$.key') IS NOT NULL
               AND json_extract(item.value, '$.key') <>
                   (SELECT work_item_key FROM observed_material_acceptances WHERE rowid = ?)
             LIMIT 1`,
          )
          .get(carrierRowId, carrierRowId) as { other_key: string | null };
        if (foreignProposal.other_id === null || foreignItem.other_key === null)
          throw new Error(
            "fixture 缺少另一条真实执行持有的 proposal 或 work item 引用",
          );
        foreignProposalId = foreignProposal.other_id;
        foreignWorkItemKey = foreignItem.other_key;
      } finally {
        carrierProbe.close();
      }

      for (const [column, foreignValue] of [
        ["proposal_id", foreignProposalId],
        ["work_item_key", foreignWorkItemKey],
      ] as const) {
        const damaging = new DatabaseSync(databasePath);
        let original: string;
        try {
          original = (
            damaging
              .prepare(
                `SELECT ${column} AS value FROM observed_material_acceptances WHERE rowid = ?`,
              )
              .get(carrierRowId) as { value: string }
          ).value;
          damaging
            .prepare(
              `UPDATE observed_material_acceptances SET ${column} = ? WHERE rowid = ?`,
            )
            .run(foreignValue, carrierRowId);
        } finally {
          damaging.close();
        }
        await expect(
          inspectProductionCatalogueReadiness({ productDataDirectory }),
        ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
        const catalogue = SqliteCatalogue.forProductData(productDataDirectory);
        try {
          await expect(catalogue.listCurrentCatalogue()).rejects.toThrow(
            "观察材料决定支持链损坏",
          );
        } finally {
          catalogue.close();
        }
        const restored = new DatabaseSync(databasePath);
        try {
          restored
            .prepare(
              `UPDATE observed_material_acceptances SET ${column} = ? WHERE rowid = ?`,
            )
            .run(original, carrierRowId);
        } finally {
          restored.close();
        }
        await expect(
          inspectProductionCatalogueReadiness({ productDataDirectory }),
        ).resolves.toMatchObject({ state: "ready" });
      }

      // 自身载体的来源遗漏：清掉真实 work item 的 key，或让不带工作项的 b-local 与
      // c-association 借用另一条真实执行现有的 proposal，都必须被同一份耐久闭锁接住；
      // 换回原值后同一个库重新 ready，公开查询恢复。
      const closesOwnCarrierOmission = async (
        directory: string,
        acceptanceKind: "a-work-item" | "b-local" | "c-association",
        column: "work_item_key" | "proposal_id",
      ) => {
        const target = path.join(directory, "catalogue.sqlite");
        const probe = new DatabaseSync(target, { readOnly: true });
        let rowId: number;
        let damagedValue: string;
        try {
          rowId = (
            probe
              .prepare(
                `SELECT rowid AS row_id FROM observed_material_acceptances
                 WHERE acceptance_kind = ?
                   AND (? <> 'a-work-item' OR work_item_key <> '')
                 ORDER BY rowid LIMIT 1`,
              )
              .get(acceptanceKind, acceptanceKind) as { row_id: number }
          ).row_id;
          if (column === "work_item_key") {
            damagedValue = "";
          } else {
            damagedValue =
              (
                probe
                  .prepare(
                    `SELECT other.proposal_id AS other_id
                   FROM observed_material_acceptances AS other
                   INNER JOIN recognition_proposals AS borrowed
                     ON borrowed.id = other.proposal_id
                   WHERE other.rowid <> ? AND borrowed.execution_id <>
                         (SELECT execution_id FROM observed_material_acceptances WHERE rowid = ?)
                   LIMIT 1`,
                  )
                  .get(rowId, rowId) as { other_id: string | undefined }
              ).other_id ?? "";
          }
        } finally {
          probe.close();
        }
        if (damagedValue === "" && column === "proposal_id")
          throw new Error(
            `fixture 缺少 ${acceptanceKind} 可借用的另一真实执行 proposal`,
          );

        const damaging = new DatabaseSync(target);
        let original: string;
        try {
          original = (
            damaging
              .prepare(
                `SELECT ${column} AS value FROM observed_material_acceptances WHERE rowid = ?`,
              )
              .get(rowId) as { value: string }
          ).value;
          damaging
            .prepare(
              `UPDATE observed_material_acceptances SET ${column} = ? WHERE rowid = ?`,
            )
            .run(damagedValue, rowId);
        } finally {
          damaging.close();
        }
        await expect(
          inspectProductionCatalogueReadiness({
            productDataDirectory: directory,
          }),
        ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
        const catalogue = SqliteCatalogue.forProductData(directory);
        try {
          await expect(catalogue.listCurrentCatalogue()).rejects.toThrow(
            "观察材料决定支持链损坏",
          );
        } finally {
          catalogue.close();
        }
        const restored = new DatabaseSync(target);
        try {
          restored
            .prepare(
              `UPDATE observed_material_acceptances SET ${column} = ? WHERE rowid = ?`,
            )
            .run(original, rowId);
        } finally {
          restored.close();
        }
        await expect(
          inspectProductionCatalogueReadiness({
            productDataDirectory: directory,
          }),
        ).resolves.toMatchObject({ state: "ready" });
      };

      await closesOwnCarrierOmission(
        productDataDirectory,
        "a-work-item",
        "work_item_key",
      );
      await closesOwnCarrierOmission(
        productDataDirectory,
        "b-local",
        "proposal_id",
      );

      // c-association 的自身载体是该执行自己的 accepted checkpoint，逐文件投影精确归属。
      const carriers = await oldContractFixture(
        "observed-material-carriers-before-current-supports",
      );
      try {
        await expectDerivedPrepareApplied(carriers.productDataDirectory);
        await expect(
          inspectProductionCatalogueReadiness({
            productDataDirectory: carriers.productDataDirectory,
          }),
        ).resolves.toMatchObject({ state: "ready" });
        await closesOwnCarrierOmission(
          carriers.productDataDirectory,
          "c-association",
          "proposal_id",
        );
      } finally {
        await rm(carriers.productDataDirectory, {
          recursive: true,
          force: true,
        });
      }
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("当旧合同 Location 同时被见证为文件与目录包时拒绝选定单一材料形态", async () => {
    // 受控损坏副本：只复用该 fixture 已部署 filesystem-package producer 留下的工作项，
    // 把它与它自己冻结的 snapshot root 指向库里真实存在的观察文件 Location，从而在同一
    // Location 上同时留下 file 与 package directory witness。
    const { productDataDirectory, manifest } = await oldContractFixture(
      "observed-material-shape-swap-before-current-supports",
    );
    const head = productionMigrationArtifacts.find(
      ({ id }) => id === "20261003000000_current_observed_material_supports",
    )!;
    const databasePath = path.join(productDataDirectory, "catalogue.sqlite");
    try {
      const damaging = new DatabaseSync(databasePath);
      let frozen: {
        workItems: string;
        snapshot: string;
        filesystemSnapshots: string;
      };
      let packageExecutionId: string;
      try {
        const targetAssetId = manifest.assets["fileToDirectory"];
        if (targetAssetId === undefined)
          throw new Error("fixture manifest 缺少 fileToDirectory 资产");
        const target = damaging
          .prepare(
            `SELECT l.address AS address, aa.subject_id AS assetId,
                    rd.proposal_id AS proposalId
             FROM locations AS l
             INNER JOIN artifact_associations AS aa
               ON aa.artifact_id = l.artifact_id
              AND aa.role = 'asset.material-delivered'
             INNER JOIN recognition_decisions AS rd ON rd.asset_id = aa.subject_id
             WHERE l.kind = 'observed' AND aa.subject_id = ?
               AND l.address LIKE '%/fileToDir'
             LIMIT 1`,
          )
          .get(targetAssetId) as {
          address: string;
          assetId: string;
          proposalId: string;
        };
        const packageExecution = damaging
          .prepare(
            `SELECT id, work_items_json AS workItems, snapshot_json AS snapshot,
                    filesystem_snapshots_json AS filesystemSnapshots
             FROM workflow_executions
             WHERE work_items_json LIKE '%filesystem-package%'
               AND filesystem_snapshots_json IS NOT NULL
             LIMIT 1`,
          )
          .get() as {
          id: string;
          workItems: string;
          snapshot: string;
          filesystemSnapshots: string;
        };
        packageExecutionId = packageExecution.id;
        frozen = {
          workItems: packageExecution.workItems,
          snapshot: packageExecution.snapshot,
          filesystemSnapshots: packageExecution.filesystemSnapshots,
        };
        damaging
          .prepare(
            `UPDATE workflow_executions
             SET work_items_json = json_set(work_items_json,
                   '$[0].proposalId', ?, '$[0].acceptedAssetId', ?,
                   '$[0].outcome', 'accepted', '$[0].key', 'damaged-package-witness'),
                 snapshot_json = json_set(snapshot_json, '$.root', ?),
                 filesystem_snapshots_json = json_set(filesystem_snapshots_json,
                   '$[0].root', ?)
             WHERE id = ?`,
          )
          .run(
            target.proposalId,
            target.assetId,
            target.address,
            target.address,
            packageExecutionId,
          );
      } finally {
        damaging.close();
      }

      let rejection: unknown;
      try {
        await prepareProductionCatalogue({ productDataDirectory });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("生产迁移"),
          cause: expect.objectContaining({
            message: expect.stringContaining(
              "digital_c01_legacy_material_carrier_ambiguous",
            ),
          }),
        }),
      );

      const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
      try {
        // 跨形态 witness 在第 7 步 guard 前不被抹掉：矛盾证据让 DDL、三张新表回填、
        // business 写入与成功账本一起回滚。
        expect(
          rolledBack
            .prepare(
              `SELECT name FROM sqlite_master WHERE name IN
               ('observed_material_boundaries', 'observed_material_acceptances',
                'current_observed_material_supports')`,
            )
            .all(),
        ).toEqual([]);
        expect(
          rolledBack
            .prepare(
              "SELECT id FROM __digital_catalogue_migrations WHERE id = ?",
            )
            .get(head.id),
        ).toBeUndefined();
      } finally {
        rolledBack.close();
      }
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "migration-failed" });

      const repairing = new DatabaseSync(databasePath);
      try {
        repairing
          .prepare(
            `UPDATE workflow_executions
             SET work_items_json = ?, snapshot_json = ?, filesystem_snapshots_json = ?
             WHERE id = ?`,
          )
          .run(
            frozen.workItems,
            frozen.snapshot,
            frozen.filesystemSnapshots,
            packageExecutionId,
          );
      } finally {
        repairing.close();
      }
      await expectDerivedPrepareApplied(productDataDirectory);
      await expect(
        inspectProductionCatalogueReadiness({ productDataDirectory }),
      ).resolves.toMatchObject({ state: "ready" });
      await expectDerivedPrepareApplied(productDataDirectory);
    } finally {
      await rm(productDataDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});

type OldContractManifest = {
  readonly assets: Record<string, string>;
  readonly observedRootId?: string;
  readonly outerRootId?: string;
  readonly parentRootId?: string;
  readonly childRootId?: string;
};

async function oldContractFixture(fixture: string): Promise<{
  readonly productDataDirectory: string;
  readonly manifest: OldContractManifest;
}> {
  const productDataDirectory = await temporaryProductData();
  await mkdir(path.join(productDataDirectory, "managed-artifacts"), {
    recursive: true,
  });
  await copyFile(
    new URL(`./fixtures/${fixture}/catalogue.sqlite`, import.meta.url),
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  return {
    productDataDirectory,
    manifest: JSON.parse(
      await readFile(
        new URL(`./fixtures/${fixture}/manifest.json`, import.meta.url),
        "utf8",
      ),
    ) as OldContractManifest,
  };
}

function fixtureAssetIds(
  manifest: OldContractManifest,
  keys: readonly string[],
): readonly string[] {
  return keys.map((key) => {
    const id = manifest.assets[key];
    if (id === undefined) throw new Error(`fixture manifest 缺少资产 ${key}`);
    return id;
  });
}

function supportRows(database: DatabaseSync, locationId: string) {
  return database
    .prepare(
      `SELECT observed_root_id AS rootId, material_kind AS kind
       FROM current_observed_material_supports WHERE location_id = ?
       ORDER BY observed_root_id`,
    )
    .all(locationId) as unknown as readonly { rootId: string; kind: string }[];
}

function coverageRows(database: DatabaseSync, locationId: string) {
  return (
    database
      .prepare(
        `SELECT observed_root_id AS rootId FROM current_file_observation_supports
         WHERE location_id = ? ORDER BY observed_root_id`,
      )
      .all(locationId) as unknown as readonly { rootId: string }[]
  ).map(({ rootId }) => rootId);
}

/**
 * 每行正向支持必须整体来自同一执行自己的完整冻结事件：snapshot、时刻、根坐标与授权闭包
 * 都出自那一行，任何跨根或跨事件拼接都会出现在结果里。
 */
function supportsOutsideTheirOwnFrozenEvent(database: DatabaseSync) {
  return database
    .prepare(
      `SELECT supports.location_id AS locationId, supports.observed_root_id AS rootId
       FROM current_observed_material_supports AS supports
       WHERE NOT EXISTS (
         SELECT 1 FROM workflow_executions AS executions
         CROSS JOIN json_each(executions.filesystem_snapshots_json) AS snapshot
         CROSS JOIN json_each(
           COALESCE(json_extract(executions.workflow_input_json, '$.observedRoots'), '[]')
         ) AS root
         WHERE json_extract(snapshot.value, '$.id') = supports.snapshot_id
           AND json_extract(snapshot.value, '$.observedAt') = supports.observed_at
           AND json_extract(root.value, '$.id') = supports.observed_root_id
           AND CAST(json_extract(root.value, '$.configVersion') AS INTEGER) =
             supports.observed_root_version
           AND json_extract(root.value, '$.containerPath') = supports.observed_root_path
           AND COALESCE(json_extract(root.value, '$.authorizedTargetRoots'), '[]') =
             supports.authorized_targets_json
       )
       AND NOT EXISTS (
         SELECT 1 FROM workflow_executions AS executions
         CROSS JOIN json_each(executions.filesystem_snapshots_json) AS snapshot
         CROSS JOIN json_each(
           COALESCE(json_extract(executions.resolved_selection_json, '$.filesystemScopes'), '[]')
         ) AS scope
         WHERE json_extract(snapshot.value, '$.id') = supports.snapshot_id
           AND json_extract(snapshot.value, '$.observedAt') = supports.observed_at
           AND json_extract(scope.value, '$.observedRoot.id') = supports.observed_root_id
           AND CAST(json_extract(scope.value, '$.observedRoot.configVersion') AS INTEGER) =
             supports.observed_root_version
           AND json_extract(scope.value, '$.observedRoot.containerPath') =
             supports.observed_root_path
           AND COALESCE(
             json_extract(scope.value, '$.observedRoot.authorizedTargetRoots'), '[]'
           ) = supports.authorized_targets_json
       )
       ORDER BY supports.rowid`,
    )
    .all() as readonly Record<string, string>[];
}

async function temporaryProductData(): Promise<string> {
  return await mkdtemp(
    path.join(tmpdir(), "digital-disposable-production-migrations-"),
  );
}

/**
 * 副本当前台账之外、正式计划之内的产物数，就是这次 prepare 应当应用的迁移数。
 * 计划顺序与内容都取自生产入口自己的 productionMigrationArtifacts，测试不复制常数。
 */
function outstandingMigrations(catalogueFile: string): number {
  const database = new DatabaseSync(catalogueFile);
  try {
    const ledger = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__digital_catalogue_migrations'",
      )
      .get();
    if (ledger === undefined)
      throw new Error(`副本没有可推导的迁移台账：${catalogueFile}`);
    const applied = new Set(
      (
        database
          .prepare("SELECT id FROM __digital_catalogue_migrations")
          .all() as { id: string }[]
      ).map(({ id }) => id),
    );
    return productionMigrationArtifacts.filter(({ id }) => !applied.has(id))
      .length;
  } finally {
    database.close();
  }
}

/** 先按正式计划与副本台账推导本次应应用的迁移数，再要求 prepare 实际返回同一数。 */
async function expectDerivedPrepareApplied(
  productDataDirectory: string,
): Promise<void> {
  const expectedApplied = outstandingMigrations(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  await expect(
    prepareProductionCatalogue({ productDataDirectory }),
  ).resolves.toEqual({ applied: expectedApplied });
}

/** 旧来源补充权威由这条迁移承载：它的完整性前置在 DDL 之前执行。 */
const legacySourceIdentityMigrationId =
  "20260906010000_source_identity_correction";

/**
 * 旧来源补充权威前置的拒绝要钉住该权威所属的产物本身：正式消息带失败的迁移 id，台账
 * 不登记该产物，失败台账记录该产物。只匹配「生产迁移」前缀会让任意其它迁移失败都算通过。
 */
async function expectLegacySourceAuthorityLockout(
  operation: Promise<unknown>,
  productDataDirectory: string,
): Promise<void> {
  await expect(operation).rejects.toThrow(
    `生产迁移 ${legacySourceIdentityMigrationId} 失败；Web 不会启动`,
  );
  const rejected = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
    { readOnly: true },
  );
  try {
    expect(
      rejected
        .prepare("SELECT 1 FROM __digital_catalogue_migrations WHERE id = ?")
        .get(legacySourceIdentityMigrationId),
    ).toBeUndefined();
    expect(
      rejected
        .prepare(
          "SELECT id, message FROM __digital_catalogue_migration_failures WHERE id = ?",
        )
        .get(legacySourceIdentityMigrationId),
    ).toEqual({ id: legacySourceIdentityMigrationId, message: "Error" });
  } finally {
    rejected.close();
  }
}

/** 把退出前固定点 fixture 原样拷入一个新的临时产品数据根。 */
async function ordinaryEntityFixtureRoot(): Promise<string> {
  const productDataDirectory = await temporaryProductData();
  await mkdir(path.join(productDataDirectory, "managed-artifacts"), {
    recursive: true,
  });
  await copyFile(
    new URL(
      "../test/fixtures/entity-model/entity-e02-after-e01.sqlite",
      import.meta.url,
    ),
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  return productDataDirectory;
}

/** 取一份真实携带实体数组的旧来源解释 basis，供定向破坏使用。 */
function requireRetiredSourceInterpretationBasis(database: DatabaseSync): {
  readonly id: string;
  readonly basis_json: string;
} {
  const target = database
    .prepare(
      `SELECT id, basis_json FROM recognition_proposals
       WHERE json_extract(basis_json, '$.kind') = 'source-interpretation'
         AND json_array_length(basis_json, '$.interpretation.entities') > 0
       ORDER BY id LIMIT 1`,
    )
    .get() as { id: string; basis_json: string } | undefined;
  if (!target) throw new Error("fixture 缺少携带实体的旧来源解释 basis");
  return target;
}

/** 取一份真实不含解释的人工边界 basis，供把来源解释藏进该分支使用。 */
function requireRetiredManualBoundaryBasis(database: DatabaseSync): {
  readonly id: string;
  readonly basis_json: string;
} {
  const target = database
    .prepare(
      `SELECT id, basis_json FROM recognition_proposals
       WHERE json_extract(basis_json, '$.kind') = 'manual-boundary'
       ORDER BY id LIMIT 1`,
    )
    .get() as { id: string; basis_json: string } | undefined;
  if (!target) throw new Error("fixture 缺少不含解释的人工边界 basis");
  return target;
}

/** 取一份真实来源关联预演，其 change union 分支本不应携带识别提议或 basis。 */
function requireRetiredAssociationPreview(database: DatabaseSync): {
  readonly id: string;
} {
  const target = database
    .prepare(
      `SELECT id FROM change_impact_previews
       WHERE json_extract(preview_json, '$.change.kind') = 'source-association'
       ORDER BY id LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (!target) throw new Error("fixture 缺少来源关联预演");
  return target;
}

/**
 * 确认反例真的种在正式 SQL 按路径存在性改写的已知位置：该行的该 JSON 路径必须是
 * 数组，否则拒绝只来自测试自定义形状，无法证明迁移前预检与实际硬迁移同源。
 */
function requireRetiredSqlPathHit(
  database: DatabaseSync,
  carrier: "basis" | "preview",
  id: string,
  jsonPath: string,
): void {
  const table =
    carrier === "basis" ? "recognition_proposals" : "change_impact_previews";
  const column = carrier === "basis" ? "basis_json" : "preview_json";
  const hits = database
    .prepare(
      `SELECT COUNT(*) AS n FROM ${table}
       WHERE id = ? AND json_type(${column}, ?) = 'array'`,
    )
    .get(id, jsonPath) as { n: number | bigint };
  if (Number(hits.n) !== 1)
    throw new Error(`反例未命中正式 SQL 路径 ${table}.${column} ${jsonPath}`);
}

function requireRetiredInterpretedExecution(database: DatabaseSync): string {
  const target = database
    .prepare(
      `SELECT id FROM workflow_executions
       WHERE json_type(source_enrichments_json, '$[0].interpretation') = 'object'
       ORDER BY id LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (!target) throw new Error("fixture 缺少携带解释的旧 checkpoint");
  return target.id;
}

function requireRetiredAssociationDecisionExecution(
  database: DatabaseSync,
): string {
  const target = database
    .prepare(
      `SELECT id FROM workflow_executions
       WHERE json_type(
         source_association_decision_json, '$.candidates[0].interpretation'
       ) = 'object'
       ORDER BY id LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (!target) throw new Error("fixture 缺少携带候选解释的旧关联决定");
  return target.id;
}

/**
 * 改旧 checkpoint 主列时同步其 audit 镜像，保证正式 prepare 的拒绝只可能来自
 * 解释批次自身的严格性，而不是镜像等值。
 */
function mutateRetiredCheckpointColumn(
  database: DatabaseSync,
  executionId: string,
  column: "source_enrichments_json" | "source_association_decision_json",
  mirrorKey: "sourceEnrichments" | "sourceAssociationDecision",
  mutate: (document: unknown) => void,
): void {
  const row = database
    .prepare(
      `SELECT ${column} AS document, audit_json AS audit
       FROM workflow_executions WHERE id = ?`,
    )
    .get(executionId) as { document: string; audit: string | null };
  const document = JSON.parse(row.document) as unknown;
  mutate(document);
  const updated = JSON.stringify(document);
  if (row.audit === null) {
    database
      .prepare(`UPDATE workflow_executions SET ${column} = ? WHERE id = ?`)
      .run(updated, executionId);
    return;
  }
  const audit = JSON.parse(row.audit) as { payload: Record<string, unknown> };
  if (mirrorKey in audit.payload) audit.payload[mirrorKey] = document;
  database
    .prepare(
      `UPDATE workflow_executions SET ${column} = ?, audit_json = ? WHERE id = ?`,
    )
    .run(updated, JSON.stringify(audit), executionId);
}

function requirePlanted(changes: number | bigint, carrier: string): void {
  if (Number(changes) === 0)
    throw new Error(`fixture 未能在${carrier}上种下反例`);
}

/** 硬迁移失败必须停在 DDL 与成功账本之前，且只留下脱敏后的失败账本。 */
function expectRetiredMigrationBlockedBeforeDdl(
  productDataDirectory: string,
  migrationId: string,
): void {
  const rejected = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
    { readOnly: true },
  );
  try {
    expect(
      rejected
        .prepare("SELECT 1 FROM __digital_catalogue_migrations WHERE id = ?")
        .get(migrationId),
    ).toBeUndefined();
    expect(
      rejected
        .prepare(
          "SELECT id, message FROM __digital_catalogue_migration_failures WHERE id = ?",
        )
        .get(migrationId),
    ).toEqual({ id: migrationId, message: "Error" });
    expect(
      rejected
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name = 'entity_kind_manual_history'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    rejected.close();
  }
}

/** 退出前合同里合法但不含来源解释的观察证据 basis。 */
const retiredObservedEvidenceBasis = {
  kind: "observed-evidence",
  producer: {
    capabilityId: "epub-inspector",
    capabilityVersion: "1",
    contractVersion: "epub/3",
  },
  evidence: [],
  artifactRevisions: [
    {
      observedArtifactReference: "book.epub",
      blob: {
        digest: "epub-digest",
        mediaType: "application/epub+zip",
        byteLength: 1,
      },
      producer: {
        capabilityId: "epub-inspector",
        capabilityVersion: "1",
        contractVersion: "epub/3",
      },
    },
  ],
} as const;

async function prepareCatalogueBeforeNamedRelationshipParticipants(
  productDataDirectory: string,
): Promise<void> {
  await mkdir(productDataDirectory, { recursive: true });
  await mkdir(path.join(productDataDirectory, "managed-artifacts"), {
    recursive: true,
  });
  const database = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  try {
    database.exec(`
      CREATE TABLE __digital_catalogue_migrations (
        id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      CREATE TABLE __digital_catalogue_migration_failures (
        id TEXT PRIMARY KEY NOT NULL, message TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
    `);
    for (const artifact of productionMigrationArtifacts) {
      if (artifact.id === "20260913010000_named_relationship_participants")
        break;
      database.exec(
        await readFile(
          new URL(
            `../migrations/${artifact.id}/migration.sql`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      database
        .prepare(
          "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
        )
        .run(artifact.id, artifact.checksum, "2026-09-13T00:00:00.000Z");
    }
  } finally {
    database.close();
  }
}

async function prepareCatalogueBeforeDescriptionTargets(
  productDataDirectory: string,
): Promise<void> {
  await mkdir(productDataDirectory, { recursive: true });
  await mkdir(path.join(productDataDirectory, "managed-artifacts"), {
    recursive: true,
  });
  const database = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  try {
    database.exec(`
      CREATE TABLE __digital_catalogue_migrations (
        id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      CREATE TABLE __digital_catalogue_migration_failures (
        id TEXT PRIMARY KEY NOT NULL, message TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
    `);
    for (const artifact of productionMigrationArtifacts) {
      if (artifact.id === "20260910000000_description_targets") break;
      database.exec(
        await readFile(
          new URL(
            `../migrations/${artifact.id}/migration.sql`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      database
        .prepare(
          "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
        )
        .run(artifact.id, artifact.checksum, "2026-09-10T00:00:00.000Z");
    }
    const part = JSON.stringify({
      artifactId: "observed-artifact",
      revisionId: "observed-revision",
      locator: "epub:cover",
    });
    database
      .prepare(
        "INSERT INTO artifact_associations (id, subject_id, artifact_id, role, observed_artifact_part_json) VALUES ('cover', 'asset', 'image', 'asset.primary-cover', ?)",
      )
      .run(part);
    database.exec(`
      INSERT INTO artifact_associations (id, subject_id, artifact_id, role)
        VALUES ('delivered', 'asset', 'observed-artifact', 'asset.material-delivered');
      INSERT INTO blobs (digest, media_type, byte_length)
        VALUES ('observed-digest', 'application/epub+zip', 1);
      INSERT INTO artifact_revisions (id, artifact_id, blob_digest)
        VALUES ('observed-revision', 'observed-artifact', 'observed-digest');
    `);
    database
      .prepare(
        "INSERT INTO metadata_assertions (subject_id, property, value, source_record_ids_json, observed_artifact_part_json) VALUES ('asset', 'asset.title', '书名', '[]', ?)",
      )
      .run(part);
    database.exec(`
      INSERT INTO artifacts(id) VALUES ('observed-artifact'), ('duplicate-artifact');
      INSERT INTO locations(id, artifact_id, address, kind) VALUES
        ('location-old', 'observed-artifact', '/media/book.epub', 'observed'),
        ('location-new', 'observed-artifact', '/media/book.epub', 'observed');
      INSERT INTO current_file_observations(location_id, snapshot_id, observed_at, size, modified_at, conditional_baseline) VALUES
        ('location-old', 'old', '2026-09-01T00:00:00.000Z', 1, 'old', 'old'),
        ('location-new', 'new', '2026-09-02T00:00:00.000Z', 1, 'new', 'new');
    `);
  } finally {
    database.close();
  }
}

async function prepareLegacySourceEnrichmentCatalogue(
  productDataDirectory: string,
  corruptRecord: boolean,
): Promise<void> {
  await mkdir(productDataDirectory, { recursive: true });
  await mkdir(path.join(productDataDirectory, "managed-artifacts"), {
    recursive: true,
  });
  const database = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  try {
    database.exec(`
      CREATE TABLE __digital_catalogue_migrations (
        id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      CREATE TABLE __digital_catalogue_migration_failures (
        id TEXT PRIMARY KEY NOT NULL, message TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
    `);
    for (const artifact of productionMigrationArtifacts) {
      if (artifact.id === "20260906010000_source_identity_correction") break;
      database.exec(
        await readFile(
          new URL(
            `../migrations/${artifact.id}/migration.sql`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      database
        .prepare(
          "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
        )
        .run(artifact.id, artifact.checksum, "2026-09-06T00:00:00.000Z");
    }
    const coordinate = {
      capabilityId: "association-interpreter",
      capabilityVersion: "1",
      contractVersion: "1",
    };
    const evidenceProducer = {
      capabilityId: "addressing",
      capabilityVersion: "1",
      contractVersion: "1",
    };
    const checkpoint = {
      key: "source-enrichment:asset:addressing",
      subjectId: "asset",
      stage: "applied",
      subject: {
        subjectId: "asset",
        recognitionDecisionId: "recognition-decision",
        sourceAssociations: [],
        metadata: [],
        metadataSourceRecords: [],
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [],
          artifactRoles: [],
          relationshipTypes: [],
        },
      },
      evidence: {
        kind: "directed-source-address",
        producer: evidenceProducer,
        sourceIdentity: "source",
        sourceAddress: "source:work",
        explanation: "人工指定来源地址",
      },
      explicitInput: { id: "work" },
      fulfilledArtifactRoles: [],
      metadataPolicyIds: [],
      sourceAssociation: {
        id: "association",
        subjectId: "asset",
        sourceIdentity: "source",
        nativeAddress: "source:work",
        proposalId: "source-enrichment:execution:association-interpreter",
      },
      interpretation: {
        id: "interpretation",
        producer: coordinate,
        sourceRecordIds: ["record"],
        sourceIdentity: "source",
        sourceAddress: "source:work",
        metadata: [],
        sourceArtifacts: [],
      },
      sourceRecordIds: ["record"],
      sourceArtifacts: [],
    };
    database
      .prepare(
        `INSERT INTO workflow_executions (
          id, status, stage, outcome, source_record_ids_json,
          compatibility_json, information_requirement_json,
          workflow_input_json, source_enrichments_json, accepted_asset_id
        ) VALUES (?, 'completed', 'completed', 'accepted', ?, ?, ?, ?, ?, 'asset')`,
      )
      .run(
        "execution",
        JSON.stringify(["record"]),
        JSON.stringify({
          workflowVersion: "asset-refresh/2",
          policyVersion: "policy/1",
          capabilityCoordinates: [coordinate],
        }),
        JSON.stringify({
          metadataUsageContext: "asset.ordinary",
          metadata: [],
          artifactRoles: [],
          relationshipTypes: [],
        }),
        JSON.stringify({
          version: "asset-refresh-input/1",
          trigger: "interactive",
          initiatedBy: "operator",
          acceptTrusted: false,
          configurationReferences: [],
        }),
        JSON.stringify([checkpoint]),
      );
    database.exec(`
      INSERT INTO entities(id, kind) VALUES ('asset', 'digital-asset');
      INSERT INTO recognition_proposals(id, execution_id, basis_json, rule_results_json)
        VALUES ('recognition-proposal', 'execution', '{"kind":"manual-boundary","proposedBy":"operator","observationSnapshotId":"snapshot","materialReferences":[],"revisesProposalIds":[],"metadata":[],"evidence":[]}', '[]');
      INSERT INTO recognition_decisions(id, proposal_id, asset_id, accepted_rule_results_json)
        VALUES ('recognition-decision', 'recognition-proposal', 'asset', '[]');
      INSERT INTO recognition_heads(subject_id, recognition_decision_id)
        VALUES ('asset', 'recognition-decision');
      INSERT INTO source_associations(id, subject_id, source_identity, native_address, proposal_id, is_current)
        VALUES ('association', 'asset', 'source', 'source:work', 'source-enrichment:execution:association-interpreter', 1);
      INSERT INTO current_source_associations(subject_id, association_id)
        VALUES ('asset', 'association');
    `);
    database
      .prepare(
        `INSERT INTO source_records(
          id, execution_id, source_identity, native_address, media_type,
          acquired_at, acquisition_json, coverage_json, digest, body, producer_json
        ) VALUES ('record', 'execution', 'source', ?, 'application/json',
          '2026-09-06T00:00:00.000Z', '{}', '{"id":"complete","completeness":"complete","authority":"official"}',
          ?, '{}', ?)`,
      )
      .run(
        corruptRecord ? "source:other" : "source:work",
        "a".repeat(64),
        JSON.stringify(evidenceProducer),
      );
  } finally {
    database.close();
  }
}

async function prepareLegacyObservedMaterialCatalogue(
  productDataDirectory: string,
  options: {
    readonly materialReferences: readonly string[];
    readonly evidenceReferences: readonly string[];
    readonly associationCount: number;
    readonly terminated?: boolean;
  },
): Promise<void> {
  await mkdir(productDataDirectory, { recursive: true });
  const database = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  try {
    database.exec(`
      CREATE TABLE __digital_catalogue_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE __digital_catalogue_migration_failures (
        id TEXT PRIMARY KEY NOT NULL,
        message TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);
    for (const artifact of productionMigrationArtifacts) {
      if (artifact.id === "20260906000000_observed_material_association") break;
      database.exec(
        await readFile(
          new URL(
            `../migrations/${artifact.id}/migration.sql`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      database
        .prepare(
          "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
        )
        .run(artifact.id, artifact.checksum, "2026-09-06T00:00:00.000Z");
    }
    const digest = "a".repeat(64);
    database
      .prepare(
        `INSERT INTO workflow_executions (
          id, status, stage, outcome, source_record_ids_json,
          compatibility_json, information_requirement_json, snapshot_json,
          accepted_asset_id
        ) VALUES (?, 'completed', 'accepted', 'accepted', '[]', '{}', '{}', ?, ?)`,
      )
      .run("execution", JSON.stringify({ root: "/observed" }), "asset");
    database
      .prepare(
        "INSERT INTO entities (id, kind) VALUES ('asset', 'digital-asset')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO recognition_proposals (id, execution_id, basis_json, rule_results_json) VALUES (?, ?, ?, '[]')",
      )
      .run(
        "proposal",
        "execution",
        JSON.stringify({
          kind: "manual-boundary",
          materialReferences: options.materialReferences,
          evidence: options.evidenceReferences.map((reference) => ({
            inspection: {
              observedArtifactReference: reference,
              revision: { digest },
            },
          })),
        }),
      );
    database
      .prepare(
        "INSERT INTO recognition_decisions (id, proposal_id, asset_id, accepted_rule_results_json) VALUES ('decision', 'proposal', 'asset', '[]')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO recognition_heads (subject_id, recognition_decision_id) VALUES ('asset', 'decision')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO blobs (digest, media_type, byte_length) VALUES (?, 'application/octet-stream', 1)",
      )
      .run(digest);
    for (let index = 0; index < options.associationCount; index += 1) {
      const suffix = String(index);
      database
        .prepare("INSERT INTO artifacts (id) VALUES (?)")
        .run(`artifact-${suffix}`);
      database
        .prepare(
          "INSERT INTO artifact_revisions (id, artifact_id, blob_digest) VALUES (?, ?, ?)",
        )
        .run(`revision-${suffix}`, `artifact-${suffix}`, digest);
      database
        .prepare(
          "INSERT INTO locations (id, artifact_id, address, kind) VALUES (?, ?, '/observed/one.txt', 'observed')",
        )
        .run(`location-${suffix}`, `artifact-${suffix}`);
      database
        .prepare(
          "INSERT INTO artifact_associations (id, subject_id, artifact_id, role, source_record_ids_json) VALUES (?, 'asset', ?, 'asset.material-delivered', '[]')",
        )
        .run(`association-${suffix}`, `artifact-${suffix}`);
    }
    if (options.terminated)
      database
        .prepare(
          "INSERT INTO artifact_association_retractions (id, association_id, recognition_decision_id, source_record_ids_json) VALUES ('retraction', 'association-0', 'decision', '[]')",
        )
        .run();
  } finally {
    database.close();
  }
}

async function runFormalCli(productDataDirectory: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./dist/cli.js", "prepare-only"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        DIGITAL_PRODUCT_DATA: productDataDirectory,
      },
      stdio: "pipe",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function deployFormalCli(deploymentDirectory: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--config.inject-workspace-packages=true",
        "--filter",
        "./packages/db-migrations",
        "deploy",
        "--prod",
        deploymentDirectory,
      ],
      { cwd: path.resolve(import.meta.dirname, "../../.."), stdio: "pipe" },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`正式迁移 deploy 退出码 ${String(code)}`));
    });
  });
}

async function runDeployedFormalCli(
  deploymentDirectory: string,
  productDataDirectory: string,
): Promise<{ readonly code: number; readonly stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./dist/cli.js", "prepare-only"], {
      cwd: deploymentDirectory,
      env: {
        ...process.env,
        NODE_ENV: "production",
        DIGITAL_PRODUCT_DATA: productDataDirectory,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}
