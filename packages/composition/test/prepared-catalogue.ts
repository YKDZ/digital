import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { prepareDisposableCatalogue } from "@digital/sqlite/testing";

let templateRoot: string | undefined;
let templatePreparation: Promise<string> | undefined;

/**
 * Creates a per-test product-data root from one explicitly Drizzle-pushed
 * disposable schema. The template is an OS-temporary test artifact, never a
 * runtime asset, and every caller gets an isolated SQLite database file.
 */
export async function preparedCatalogueRoot(): Promise<string> {
  const template = await preparedTemplateRoot();
  const root = await mkdtemp(path.join(tmpdir(), "digital-disposable-test-"));
  await copyPreparedCatalogueTo(template, root);
  return root;
}

/** Explicitly provision a nested test product-data directory from the same template. */
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

/** Releases the file-local template when the owning test suite finishes. */
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
    // A closed, checkpointed template can be copied as one SQLite file; test
    // instances then open their own WAL sidecars independently.
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
