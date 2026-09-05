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
      ).resolves.toEqual({ applied: 2 });
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
