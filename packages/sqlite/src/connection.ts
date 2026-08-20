import { DatabaseSync } from "node:sqlite";

/**
 * SQLite connection tuning is infrastructure, not catalogue persistence.
 * Keep the narrow native PRAGMA exception outside the Drizzle-backed adapter
 * so every application Port query and mutation remains schema-bound.
 */
export function enableCatalogueWal(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
}
