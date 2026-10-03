import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  ProductDataOperations,
  type ProductDataRestoreStage,
} from "@digital/product-data";
import { SqliteCatalogue } from "@digital/sqlite";

const migrationDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

export type ProductionMigrationArtifact = {
  readonly id: string;
  readonly checksum: string;
};

export type ProductionCatalogueReadiness = Awaited<
  ReturnType<typeof SqliteCatalogue.inspectProductionReadiness>
>;

export const productionMigrationArtifacts: readonly ProductionMigrationArtifact[] =
  SqliteCatalogue.productionMigrationPlan;

export async function inspectProductionCatalogueReadiness(options: {
  readonly productDataDirectory: string;
}): Promise<ProductionCatalogueReadiness> {
  return await SqliteCatalogue.inspectProductionReadiness(options);
}

/**
 * 正式生产准备流程。这里刻意作为生产迁移账本的唯一写入者；运行时代码既不
 * 导入本包，也不导入其产物。
 */
export async function prepareProductionCatalogue(options: {
  readonly productDataDirectory: string;
}): Promise<{ readonly applied: number }> {
  const productDataDirectory = path.resolve(options.productDataDirectory);
  return await prepareWithWriterAdmission(productDataDirectory);
}

/**
 * 恢复命令仅在产品数据模块持有的维护阶段内调用此入口。阶段对象拥有运行时私有
 * 字段，伪造的同形对象不能交出目录；迁移实现也不会通过环境变量或磁盘标记授权。
 */
export async function prepareRestoredProductionCatalogue(
  stage: ProductDataRestoreStage,
): Promise<{ readonly applied: number }> {
  return await stage.withDirectory(
    async (productDataDirectory) =>
      await prepareProductionCatalogueWithWriter(productDataDirectory),
  );
}

async function prepareWithWriterAdmission(
  productDataDirectory: string,
): Promise<{ readonly applied: number }> {
  const operations = ProductDataOperations.forRoot(productDataDirectory);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await operations.withWriter(
        async () =>
          await prepareProductionCatalogueWithWriter(productDataDirectory),
      );
    } catch (error) {
      // 同一部署的两个 prepare-only 可以串行；维护持有者绝不能被等待掩盖。
      if (
        !(error instanceof Error) ||
        !error.message.includes("另一个产品写入者")
      )
        throw error;
      if (Date.now() >= deadline)
        throw new Error("生产数据库准备等待现有写入者超时", { cause: error });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function prepareProductionCatalogueWithWriter(
  productDataDirectory: string,
): Promise<{ readonly applied: number }> {
  await mkdir(productDataDirectory, { recursive: true });
  await mkdir(path.join(productDataDirectory, "managed-artifacts"), {
    recursive: true,
  });
  await mkdir(path.join(productDataDirectory, "configuration"), {
    recursive: true,
  });
  await mkdir(path.join(productDataDirectory, "source-connections"), {
    recursive: true,
  });
  const database = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  try {
    database.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL");
    // 这些运行账本必须在迁移事务回滚后仍保留，运行时才能区分中断部署与未准备的
    // catalogue。获取迁移事务前先创建它们。
    database.exec(`
      CREATE TABLE IF NOT EXISTS __digital_catalogue_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS __digital_catalogue_migration_failures (
        id TEXT PRIMARY KEY NOT NULL,
        message TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);
    database.exec("BEGIN IMMEDIATE");
    let applied = 0;
    const hasLedgerRows =
      database
        .prepare("SELECT 1 FROM __digital_catalogue_migrations LIMIT 1")
        .get() !== undefined;
    if (!hasLedgerRows && schemaCanAdoptBaseline(database)) {
      establishDefaultLocalUser(database);
      const insert = database.prepare(
        "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
      );
      for (const artifact of productionMigrationArtifacts)
        insert.run(artifact.id, artifact.checksum, new Date().toISOString());
      database.exec("COMMIT");
      await cleanupUnreferencedArtifactProofs(productDataDirectory, database);
      return { applied: 0 };
    }
    // 迁移产物用连接级 TEMP context 区分“本次 prepare 从空目录运行完整冻结历史”
    // 与既有 catalogue。它来自耐久账本，不进入 catalogue schema。
    database.exec(
      "CREATE TEMP TABLE __digital_prepare_context (fresh_catalogue INTEGER NOT NULL)",
    );
    database
      .prepare(
        "INSERT INTO __digital_prepare_context (fresh_catalogue) VALUES (?)",
      )
      .run(hasLedgerRows ? 0 : 1);
    for (const artifact of productionMigrationArtifacts) {
      const sql = await readArtifactSql(artifact.id);
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (artifact.checksum !== checksum) {
        throw new Error(
          `迁移 ${artifact.id} 的已审阅校验和不匹配；拒绝执行未审阅产物`,
        );
      }
      const existing = database
        .prepare(
          "SELECT checksum FROM __digital_catalogue_migrations WHERE id = ?",
        )
        .get(artifact.id) as { readonly checksum: string } | undefined;
      if (existing !== undefined) {
        if (existing.checksum !== checksum) {
          throw new Error(
            `迁移 ${artifact.id} 的已应用校验和不匹配；不要在原地修改已发布迁移`,
          );
        }
        continue;
      }
      try {
        if (artifact.id === "20260906010000_source_identity_correction")
          SqliteCatalogue.assertExactLegacySourceEnrichmentAuthority(database);
        database.exec(sql);
        database
          .prepare(
            "INSERT INTO __digital_catalogue_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
          )
          .run(artifact.id, checksum, new Date().toISOString());
        database
          .prepare(
            "DELETE FROM __digital_catalogue_migration_failures WHERE id = ?",
          )
          .run(artifact.id);
        applied += 1;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // BEGIN 本身失败时，SQLite 会报告当前没有活动事务。
        }
        database.exec("BEGIN IMMEDIATE");
        database
          .prepare(
            "INSERT OR REPLACE INTO __digital_catalogue_migration_failures (id, message, occurred_at) VALUES (?, ?, ?)",
          )
          .run(
            artifact.id,
            sanitizedMigrationError(error),
            new Date().toISOString(),
          );
        database.exec("COMMIT");
        throw new Error(`生产迁移 ${artifact.id} 失败；Web 不会启动`, {
          cause: error,
        });
      }
    }
    database.exec("COMMIT");
    const readiness = await inspectProductionCatalogueReadiness({
      productDataDirectory,
    });
    if (readiness.state !== "ready") throw new Error(readiness.message);
    await cleanupUnreferencedArtifactProofs(productDataDirectory, database);
    return { applied };
  } finally {
    database.close();
  }
}

/** 已审阅结构整体认领账本时，仍需补上迁移所含的本地用户注册。 */
function establishDefaultLocalUser(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO local_users (user_id)
    SELECT 'local-user'
    WHERE NOT EXISTS (SELECT 1 FROM local_users WHERE user_id = 'local-user');
  `);
}

/** 只在离线 prepare 持有 product-data writer lock 时清理 proof 派生索引。 */
async function cleanupUnreferencedArtifactProofs(
  productDataDirectory: string,
  database: DatabaseSync,
): Promise<void> {
  const proofRoot = path.join(productDataDirectory, "artifact-proofs");
  const staging = path.join(proofRoot, ".staging");
  for (const entry of await readdir(staging, { withFileTypes: true }).catch(
    () => [],
  )) {
    const target = path.join(staging, entry.name);
    if (entry.isDirectory()) await rm(target, { recursive: true, force: true });
    else await unlink(target).catch(() => undefined);
  }

  const referenced = new Set(
    (
      database
        .prepare(
          "SELECT manifest_digest AS manifestDigest FROM artifact_content_proofs",
        )
        .all() as Array<{ readonly manifestDigest: string }>
    ).map((row) => row.manifestDigest),
  );
  const finalRoot = path.join(proofRoot, "sha256");
  for (const prefix of await readdir(finalRoot, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
    const prefixDirectory = path.join(finalRoot, prefix.name);
    for (const sidecar of await readdir(prefixDirectory, {
      withFileTypes: true,
    }).catch(() => [])) {
      const match = /^([a-f0-9]{64})\.fproof$/u.exec(sidecar.name);
      if (!sidecar.isFile() || match === null || referenced.has(match[1]!))
        continue;
      await unlink(path.join(prefixDirectory, sidecar.name));
    }
  }
}

function schemaCanAdoptBaseline(database: DatabaseSync): boolean {
  // 账本表刚刚创建；将仅属于 catalogue 的结构复制到内存，使经过审阅的 schema
  // 指纹继续作为权威。
  const catalogue = new DatabaseSync(":memory:");
  try {
    for (const { sql } of database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__digital_catalogue_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ readonly sql: string | null }>) {
      if (sql === null) return false;
      catalogue.exec(sql);
    }
    for (const { sql } of database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name NOT LIKE '__digital_catalogue_%' ORDER BY name",
      )
      .all() as Array<{ readonly sql: string | null }>) {
      if (sql === null) return false;
      catalogue.exec(sql);
    }
    return SqliteCatalogue.matchesReviewedSchema(catalogue);
  } finally {
    catalogue.close();
  }
}

async function readArtifactSql(id: string): Promise<string> {
  return await readFile(
    path.join(migrationDirectory, id, "migration.sql"),
    "utf8",
  );
}

function sanitizedMigrationError(error: unknown): string {
  return error instanceof Error ? error.name : "unknown migration failure";
}
