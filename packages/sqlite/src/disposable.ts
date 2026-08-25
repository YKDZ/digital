import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { matchesReviewedCatalogueSchema } from "./schema-contract.ts";
export type DisposableCatalogueTarget = {
  readonly root: string;
  readonly databasePath: string;
};

const disposableRootPrefix = "digital-disposable-";
const disposableCatalogueEnvironment = "DIGITAL_DISPOSABLE_CATALOGUE_ROOT";
const disposableProductDataEnvironment = "DIGITAL_DISPOSABLE_PRODUCT_DATA_ROOT";

/**
 * 解析 Drizzle 开发工具唯一接受的数据库目标。它刻意不允许通用产品数据路径或任意用户
 * 目录：调用方必须在操作系统临时目录正下方创建全新且命名明确的目录。
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
 * Drizzle 配置也可以独立执行。把目标保护留在本模块，使 shell 环境不能误将
 * `drizzle-kit push` 指向产品数据。
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
  // Drizzle Kit 同步求值配置。这里重复规范保护，而不依赖异步准备包装器；否则在包装器
  // 有机会检查前，`/tmp/digital-disposable-*` 符号链接就可能指向产品数据。
  assertCanonicalDisposableTargetSync(target, productDataDirectory);
  return target;
}

/**
 * 解析仅供测试的产品数据目标。不同于 `disposableCatalogueTarget`，该目标刻意就是
 * 产品数据；其安全边界改为规范 `/tmp/digital-disposable-*` 祖先。Application 代码
 * 绝不能调用该辅助函数或设置其环境变量。
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

/** Drizzle Kit 为隔离的仅测试产品数据准备通道提供的同步配置入口。 */
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
 * 从已审阅 Drizzle schema 构建空测试／开发 Catalogue 并启用 WAL。它刻意只作为一次性
 * 开发工具：应用持久化绝不调用，也绝不接受产品数据目标。
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
 * 为测试和本地工具明确准备一次性产品数据目录。它刻意与 `prepareDisposableCatalogue`
 * 分离：普通辅助函数继续严格要求一次性数据库不得与 `DIGITAL_PRODUCT_DATA` 重叠。
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
 * 工具使用的按路径已准备 Catalogue 检查。物理 schema 签名和原生 SQLite 句柄仍为该
 * 基础设施包私有，而不会成为根接口的一部分。
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
    // 该通道刻意独立于任何真实产品数据进程配置。不要让继承变量成为 Drizzle 配置目标，
    // 也不要放宽标准重叠保护。
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

/** WAL 属于操作设置，保留在持久化适配器和 DDL 之外。 */
function enableDisposableWal(target: DisposableCatalogueTarget): void {
  const database = new DatabaseSync(target.databasePath);
  try {
    database.exec("PRAGMA journal_mode = WAL");
  } finally {
    database.close();
  }
}
