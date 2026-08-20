import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
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
      // This is the real Issue-08-compatible Drizzle baseline with data, but
      // its fingerprint is intentionally damaged so replay reaches DDL that
      // conflicts with the existing catalogue.
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
