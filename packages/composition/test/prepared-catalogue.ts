import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { prepareDisposableCatalogue } from "@digital/sqlite/testing";

let templateRoot: string | undefined;
let templatePreparation: Promise<string> | undefined;

/**
 * 从一份由 Drizzle 显式推送的一次性模式创建逐测试产品数据根。模板是操作系统临时测试产物，
 * 绝不是运行时资产；每个调用方都会得到隔离的 SQLite 数据库文件。
 */
export async function preparedCatalogueRoot(): Promise<string> {
  const template = await preparedTemplateRoot();
  const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-test-"));
  await copyPreparedCatalogueTo(template, root);
  return root;
}

/** 从同一个模板显式配置嵌套测试产品数据目录。 */
export async function prepareCatalogueAt(root: string): Promise<void> {
  const template = await preparedTemplateRoot();
  await copyPreparedCatalogueTo(template, root);
}

async function copyPreparedCatalogueTo(
  template: string,
  root: string,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await copyFile(
    path.join(template, "catalogue.sqlite"),
    path.join(root, "catalogue.sqlite"),
  );
}

/** 所属测试套件结束时释放文件本地模板。 */
export async function disposePreparedCatalogueTemplate(): Promise<void> {
  if (templateRoot !== undefined) {
    await rm(templateRoot, { recursive: true, force: true });
    templateRoot = undefined;
  }
  templatePreparation = undefined;
}

async function preparedTemplateRoot(): Promise<string> {
  templatePreparation ??= createPreparedTemplate();
  return await templatePreparation;
}

async function createPreparedTemplate(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-template-"),
  );
  try {
    const target = await prepareDisposableCatalogue({ root });
    // 已关闭且已设置检查点的模板可作为单个 SQLite 文件复制；
    // 随后各测试实例独立打开自己的 WAL 伴随文件。
    const database = new DatabaseSync(target.databasePath);
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
    templateRoot = root;
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
