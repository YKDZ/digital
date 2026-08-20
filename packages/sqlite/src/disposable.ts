import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { matchesReviewedCatalogueSchema } from "./schema-contract.js";
export type DisposableCatalogueTarget = {
  readonly root: string;
  readonly databasePath: string;
};

const disposableRootPrefix = "digital-disposable-";
const disposableCatalogueEnvironment = "DIGITAL_DISPOSABLE_CATALOGUE_ROOT";
const disposableProductDataEnvironment = "DIGITAL_DISPOSABLE_PRODUCT_DATA_ROOT";

/**
 * Resolves the only database target accepted by the Drizzle development
 * tooling. It intentionally permits neither a general product-data path nor
 * an arbitrary user directory: callers must create a fresh, clearly named
 * directory directly beneath the operating system temporary directory.
 */
export function disposableCatalogueTarget(options: {
  readonly root: string;
  readonly productDataDirectory?: string;
}): DisposableCatalogueTarget {
  const root = path.resolve(options.root);
  const temporaryDirectory = path.resolve(tmpdir());
  if (
    path.dirname(root) !== temporaryDirectory ||
    !path.basename(root).startsWith(disposableRootPrefix)
  ) {
    throw new Error(
      `Disposable catalogue root must be a ${disposableRootPrefix} directory directly under ${temporaryDirectory}`,
    );
  }

  const productDataDirectory = options.productDataDirectory?.trim();
  if (
    productDataDirectory !== undefined &&
    productDataDirectory.length > 0 &&
    pathsOverlap(root, path.resolve(productDataDirectory))
  ) {
    throw new Error("Disposable catalogue root must not overlap product data");
  }

  return {
    root,
    databasePath: path.join(root, "catalogue.sqlite"),
  };
}

/**
 * The Drizzle config is also executable on its own. Keep its target guard in
 * this module so `drizzle-kit push` cannot accidentally be pointed at product
 * data by a shell environment.
 */
export function disposableCatalogueTargetFromEnvironment(): DisposableCatalogueTarget {
  const root = process.env[disposableCatalogueEnvironment];
  if (root === undefined || root.trim().length === 0) {
    throw new Error(
      `${disposableCatalogueEnvironment} is required for a Drizzle disposable push`,
    );
  }
  const productDataDirectory = process.env.DIGITAL_PRODUCT_DATA;
  const target = disposableCatalogueTarget({
    root,
    ...(productDataDirectory === undefined ? {} : { productDataDirectory }),
  });
  // Drizzle Kit evaluates its config synchronously. Repeat the canonical
  // guard here rather than relying on the async prepare wrapper: otherwise a
  // `/tmp/digital-disposable-*` symlink can point at product data before the
  // wrapper gets a chance to inspect it.
  assertCanonicalDisposableTargetSync(target, productDataDirectory);
  return target;
}

/**
 * Resolves a test-only product-data target. Unlike `disposableCatalogueTarget`,
 * this target deliberately is product data; its safety boundary is instead a
 * canonical `/tmp/digital-disposable-*` ancestor. Application code must never
 * call this helper or set its environment variable.
 */
export function disposableProductDataCatalogueTarget(options: {
  readonly productDataDirectory: string;
}): DisposableCatalogueTarget {
  const root = path.resolve(options.productDataDirectory);
  return {
    root,
    databasePath: path.join(root, "catalogue.sqlite"),
  };
}

/**
 * Drizzle Kit's synchronous configuration entrypoint for the isolated
 * test-only product-data preparation channel.
 */
export function disposableProductDataCatalogueTargetFromEnvironment(): DisposableCatalogueTarget {
  const productDataDirectory = process.env[disposableProductDataEnvironment];
  if (
    productDataDirectory === undefined ||
    productDataDirectory.trim() === ""
  ) {
    throw new Error(
      `${disposableProductDataEnvironment} is required for a test-only Drizzle disposable push`,
    );
  }
  const target = disposableProductDataCatalogueTarget({ productDataDirectory });
  assertCanonicalDisposableProductDataTargetSync(target);
  return target;
}

/**
 * Builds an empty test/development catalogue from the reviewed Drizzle
 * schema and enables WAL. It is intentionally a disposable-only developer
 * tool: application persistence never invokes it and it never accepts a
 * product-data target.
 */
export async function prepareDisposableCatalogue(options: {
  readonly root: string;
  readonly productDataDirectory?: string;
}): Promise<DisposableCatalogueTarget> {
  const productDataDirectory =
    options.productDataDirectory ?? process.env.DIGITAL_PRODUCT_DATA;
  const target = disposableCatalogueTarget({
    root: options.root,
    ...(productDataDirectory === undefined ? {} : { productDataDirectory }),
  });
  await assertCanonicalDisposableTarget(target, productDataDirectory);
  await mkdir(target.root, { recursive: true });
  await runDrizzlePush(target, {
    kind: "disposable-catalogue",
    productDataDirectory,
  });
  enableDisposableWal(target);
  return target;
}

/**
 * Explicitly prepares a disposable product-data directory for tests and local
 * tooling. This is intentionally separate from `prepareDisposableCatalogue`:
 * the normal helper retains its strict rule that a disposable database must
 * not overlap `DIGITAL_PRODUCT_DATA`.
 */
export async function prepareDisposableProductDataCatalogue(options: {
  readonly productDataDirectory: string;
}): Promise<DisposableCatalogueTarget> {
  const target = disposableProductDataCatalogueTarget(options);
  await assertCanonicalDisposableProductDataTarget(target);
  await mkdir(target.root, { recursive: true });
  await runDrizzlePush(target, { kind: "test-product-data" });
  enableDisposableWal(target);
  return target;
}

/**
 * Path-based tooling check for a prepared catalogue. The physical schema
 * signature and native SQLite handle remain private to this infrastructure
 * package rather than becoming part of its root Interface.
 */
export function isPreparedCatalogue(databasePath: string): boolean {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    return matchesReviewedCatalogueSchema(database);
  } catch (error) {
    if (isSqliteCantOpen(error)) return false;
    throw error;
  } finally {
    database?.close();
  }
}

function isSqliteCantOpen(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_SQLITE_ERROR" &&
    "errcode" in error &&
    error.errcode === 14
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`)
  );
}

async function assertCanonicalDisposableTarget(
  target: DisposableCatalogueTarget,
  productDataDirectory: string | undefined,
): Promise<void> {
  const canonicalRoot = await canonicalPath(target.root);
  const canonicalTemporaryDirectory = await canonicalPath(tmpdir());
  if (
    path.dirname(canonicalRoot) !== canonicalTemporaryDirectory ||
    !path.basename(canonicalRoot).startsWith(disposableRootPrefix)
  ) {
    throw new Error(
      "Disposable catalogue root escapes the system temporary directory",
    );
  }
  if (
    productDataDirectory === undefined ||
    productDataDirectory.trim().length === 0
  )
    return;
  if (pathsOverlap(canonicalRoot, await canonicalPath(productDataDirectory))) {
    throw new Error("Disposable catalogue root must not overlap product data");
  }
}

function assertCanonicalDisposableTargetSync(
  target: DisposableCatalogueTarget,
  productDataDirectory: string | undefined,
): void {
  const canonicalRoot = canonicalPathSync(target.root);
  const canonicalTemporaryDirectory = canonicalPathSync(tmpdir());
  if (
    path.dirname(canonicalRoot) !== canonicalTemporaryDirectory ||
    !path.basename(canonicalRoot).startsWith(disposableRootPrefix)
  ) {
    throw new Error(
      "Disposable catalogue root escapes the system temporary directory",
    );
  }
  if (
    productDataDirectory === undefined ||
    productDataDirectory.trim().length === 0
  )
    return;
  if (pathsOverlap(canonicalRoot, canonicalPathSync(productDataDirectory))) {
    throw new Error("Disposable catalogue root must not overlap product data");
  }
}

async function assertCanonicalDisposableProductDataTarget(
  target: DisposableCatalogueTarget,
): Promise<void> {
  const canonicalRoot = await canonicalPath(target.root);
  const canonicalTemporaryDirectory = await canonicalPath(tmpdir());
  if (
    !hasDisposableTemporaryAncestor(canonicalRoot, canonicalTemporaryDirectory)
  ) {
    throw new Error(
      "Disposable test product-data root escapes the system temporary directory",
    );
  }
}

function assertCanonicalDisposableProductDataTargetSync(
  target: DisposableCatalogueTarget,
): void {
  const canonicalRoot = canonicalPathSync(target.root);
  const canonicalTemporaryDirectory = canonicalPathSync(tmpdir());
  if (
    !hasDisposableTemporaryAncestor(canonicalRoot, canonicalTemporaryDirectory)
  ) {
    throw new Error(
      "Disposable test product-data root escapes the system temporary directory",
    );
  }
}

function hasDisposableTemporaryAncestor(
  candidate: string,
  temporaryDirectory: string,
): boolean {
  const relative = path.relative(temporaryDirectory, candidate);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  const [temporaryChild] = relative.split(path.sep);
  return temporaryChild?.startsWith(disposableRootPrefix) ?? false;
}

async function canonicalPath(candidate: string): Promise<string> {
  const unresolved: string[] = [];
  let current = path.resolve(candidate);
  for (;;) {
    try {
      const resolved = await realpath(current);
      return path.join(resolved, ...unresolved.toReversed());
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      unresolved.push(path.basename(current));
      current = parent;
    }
  }
}

function canonicalPathSync(candidate: string): string {
  const unresolved: string[] = [];
  let current = path.resolve(candidate);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...unresolved.toReversed());
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      unresolved.push(path.basename(current));
      current = parent;
    }
  }
}

type DrizzlePushPreparation =
  | {
      readonly kind: "disposable-catalogue";
      readonly productDataDirectory: string | undefined;
    }
  | { readonly kind: "test-product-data" };

async function runDrizzlePush(
  target: DisposableCatalogueTarget,
  preparation: DrizzlePushPreparation,
): Promise<void> {
  const packageRoot = await workspaceSqlitePackageRoot();
  const drizzleKit = path.join(
    packageRoot,
    "node_modules",
    "drizzle-kit",
    "bin.cjs",
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [drizzleKit, "push", "--config", "drizzle.config.ts"],
      {
        cwd: packageRoot,
        env: drizzlePushEnvironment(target, preparation),
        stdio: "pipe",
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`Drizzle disposable push failed (${code}): ${output}`),
        );
    });
  });
}

function drizzlePushEnvironment(
  target: DisposableCatalogueTarget,
  preparation: DrizzlePushPreparation,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment[disposableCatalogueEnvironment];
  delete environment[disposableProductDataEnvironment];
  if (preparation.kind === "test-product-data") {
    // This channel is intentionally independent of any real product-data
    // process configuration. Do not let an inherited variable become a
    // Drizzle config target or relax the standard overlap guard.
    delete environment.DIGITAL_PRODUCT_DATA;
    environment[disposableProductDataEnvironment] = target.root;
    return environment;
  }
  environment[disposableCatalogueEnvironment] = target.root;
  if (preparation.productDataDirectory !== undefined) {
    environment.DIGITAL_PRODUCT_DATA = preparation.productDataDirectory;
  } else {
    delete environment.DIGITAL_PRODUCT_DATA;
  }
  return environment;
}

async function workspaceSqlitePackageRoot(): Promise<string> {
  let current = path.resolve(process.cwd());
  for (;;) {
    const candidates = [
      path.join(current, "drizzle.config.ts"),
      path.join(current, "packages", "sqlite", "drizzle.config.ts"),
    ];
    for (const configPath of candidates) {
      try {
        await access(configPath);
        return path.dirname(configPath);
      } catch (error: unknown) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        "Unable to locate packages/sqlite/drizzle.config.ts for a disposable push",
      );
    }
    current = parent;
  }
}

/** WAL is operational setup, kept outside the persistence adapter and DDL. */
function enableDisposableWal(target: DisposableCatalogueTarget): void {
  const database = new DatabaseSync(target.databasePath);
  try {
    database.exec("PRAGMA journal_mode = WAL");
  } finally {
    database.close();
  }
}
