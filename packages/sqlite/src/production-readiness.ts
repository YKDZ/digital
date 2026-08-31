import { access } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { matchesReviewedCatalogueSchema } from "./schema-contract.ts";

export const productionCatalogueMigrationHead =
  "20260830010000_recognition_basis_heads";
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
    id: productionCatalogueMigrationHead,
    checksum:
      "ae98fd168398e6de560826765eb0dc71c99b919a6fff6b4d0f8e7756a50a1683",
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
