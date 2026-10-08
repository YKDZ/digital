import { DatabaseSync } from "node:sqlite";

/**
 * SQLite 连接调优属于基础设施，而不是 Catalogue 持久化。把窄原生 PRAGMA 例外留在
 * Drizzle 适配器之外，使每个应用端口查询和变更都继续受 schema 约束。
 */
export function enableCatalogueWal(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  // 同一 product-data 上会有多个生产连接或进程。写锁被短暂持有时用原生有限等待代替
  // 即时失败，单事务内的 CAS 仍然只让一个编辑成功。
  database.exec("PRAGMA busy_timeout = 5000");
}
