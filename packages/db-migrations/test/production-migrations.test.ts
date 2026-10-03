import { spawn } from "node:child_process";
import {
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
      await expect(
        prepareProductionCatalogue({ productDataDirectory }),
      ).resolves.toMatchObject({ applied: 0 });
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
      await expect(
        prepareProductionCatalogue({ productDataDirectory }),
      ).resolves.toEqual({ applied: 10 });
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
      legacy
        .prepare(`INSERT INTO current_source_artifact_candidate_lineages
        (subject_id, source_association_id, source_identity, native_address, coverage_id, source_record_id, interpretation_json)
        VALUES ('asset', 'association', 'fixture', 'address', 'coverage', 'record', ?)`)
        .run(
          JSON.stringify({
            relationships: [credit, sequel],
            artifactCandidates: [{ id: "retained-cover" }],
          }),
        );
      legacy
        .prepare(`INSERT INTO change_impact_previews (id, execution_id, asset_id, preview_json)
        VALUES ('preview', 'execution', 'asset', ?)`)
        .run(
          JSON.stringify({
            projected: {
              relationships: [{ ...credit, id: "credit", subjectId: "asset" }],
            },
          }),
        );
      legacy.close();

      await expect(
        prepareProductionCatalogue({ productDataDirectory }),
      ).resolves.toEqual({ applied: 9 });
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
        artifactCandidates: [{ id: "retained-cover" }],
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
      await expect(
        prepareProductionCatalogue({ productDataDirectory: valid }),
      ).resolves.toEqual({ applied: 13 });
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
      await expect(
        prepareProductionCatalogue({ productDataDirectory: corrupt }),
      ).rejects.toThrow("生产迁移");
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
        await expect(
          prepareProductionCatalogue({ productDataDirectory: root }),
        ).rejects.toThrow("生产迁移");
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
      await expect(
        prepareProductionCatalogue({ productDataDirectory: terminated }),
      ).resolves.toEqual({ applied: 14 });
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
        sourceRecordIds: [],
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
      await expect(
        prepareProductionCatalogue({ productDataDirectory }),
      ).resolves.toEqual({ applied: 16 });
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
});

async function temporaryProductData(): Promise<string> {
  return await mkdtemp(
    path.join(tmpdir(), "digital-disposable-production-migrations-"),
  );
}

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
