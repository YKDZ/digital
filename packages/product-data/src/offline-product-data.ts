import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { ProductDataOperations } from "./index.js";

const disposableProductRootEntries = new Set([
  "cache",
  "runtime-state",
  "staging",
]);

/** 在维护世代内复制耐久根布局；新增根项默认耐久，只有明示的可再生区会排除。 */
export async function createOfflineProductDataBackup(input: {
  readonly productDataDirectory: string;
  readonly backupDirectory: string;
}): Promise<void> {
  const source = path.resolve(input.productDataDirectory);
  const destination = path.resolve(input.backupDirectory);
  assertDistinctRoots(source, destination);
  await assertNoSymlinkAncestors(source, false);
  await assertNoSymlinkAncestors(destination, true);
  const maintenance = ProductDataOperations.forRoot(source).startMaintenance();
  try {
    ProductDataOperations.forRoot(source).assertRestoreCanStart();
    await assertEmptyDirectory(destination, "备份目录");
    await copyDurableProductRoot(source, destination);
  } finally {
    maintenance.close();
  }
}

/**
 * 只在既有产品根内暂存并发布耐久项。`runtime-state` 从取得维护权到释放始终
 * 保留，因此恢复失败不会制造写入者可趁入的窗口。
 */
export async function restoreOfflineProductDataBackup(input: {
  readonly backupDirectory: string;
  readonly productDataDirectory: string;
  readonly prepareProductionCatalogue: (
    stage: ProductDataRestoreStage,
  ) => Promise<void>;
}): Promise<void> {
  const source = path.resolve(input.backupDirectory);
  const destination = path.resolve(input.productDataDirectory);
  assertDistinctRoots(source, destination);
  await assertNoSymlinkAncestors(source, false);
  await assertNoSymlinkAncestors(destination, true);
  ProductDataOperations.forRoot(destination).assertRestoreCanStart();
  // 在取得维护生命周期前检查，避免把已有数据误当成可发布的空目标。
  await assertEmptyDirectory(destination, "目标产品数据目录");
  const maintenance =
    ProductDataOperations.forRoot(destination).startMaintenance();
  let destinationRoot: Awaited<ReturnType<typeof open>> | undefined;
  let stagingRoot: Awaited<ReturnType<typeof open>> | undefined;
  let stage: Awaited<ReturnType<typeof open>> | undefined;
  const stageName = `restore-${cryptoRandomName()}`;
  try {
    destinationRoot = await openVerifiedDirectory(
      destination,
      "目标产品数据目录",
    );
    writeRestoreInProgressMarker(destinationRoot.fd, stageName);
    stagingRoot = await createChildVerifiedDirectory(
      destinationRoot.fd,
      "staging",
      0o700,
      true,
    );
    stage = await createChildVerifiedDirectory(
      stagingRoot.fd,
      stageName,
      0o700,
    );
    await copyDurableProductRoot(source, undefined, stage);
    const restoreStage = new ProductDataRestoreStage(stage);
    try {
      await input.prepareProductionCatalogue(restoreStage);
    } finally {
      restoreStage.close();
    }
    await assertDescriptorIdentity(
      path.join(descriptorPath(stagingRoot.fd), stageName),
      stage,
      "迁移回调改变了暂存目录；拒绝发布",
    );
    await assertDescriptorIdentity(
      destination,
      destinationRoot,
      "迁移回调改变了产品根；拒绝发布",
    );
    await publishDurableEntries(stage, destinationRoot);
    removeRestoreInProgressMarker(destinationRoot.fd);
  } catch (error) {
    // 只通过已经验证的父描述符清理仍在原位的暂存项；遭重绑的路径绝不触碰。
    if (stagingRoot !== undefined) {
      await rm(path.join(descriptorPath(stagingRoot.fd), stageName), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await stage?.close();
    await stagingRoot?.close();
    await destinationRoot?.close();
    maintenance.close();
  }
}

/** 恢复阶段的能力对象；私有字段使结构伪造在运行时也无法取得暂存目录。 */
export class ProductDataRestoreStage {
  readonly #directory: Awaited<ReturnType<typeof open>>;
  #closed = false;
  constructor(directory: Awaited<ReturnType<typeof open>>) {
    this.#directory = directory;
  }
  async withDirectory<Result>(
    operation: (directory: string) => Promise<Result>,
  ): Promise<Result> {
    if (this.#closed) throw new Error("恢复暂存阶段已关闭");
    return await operation(descriptorPath(this.#directory.fd));
  }
  close(): void {
    this.#closed = true;
  }
}

async function copyDurableProductRoot(
  source: string,
  destination: string | undefined,
  existingDestination?: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const sourceRoot = await openVerifiedDirectory(source, "备份源产品数据目录");
  try {
    const names = await readdir(descriptorPath(sourceRoot.fd));
    if (!names.includes("catalogue.sqlite"))
      throw new Error("备份源缺少产品 Catalogue；拒绝创建不完整副本");
    const destinationRoot =
      existingDestination ??
      (await createVerifiedDirectory(destination!, 0o700));
    try {
      for (const name of names) {
        if (disposableProductRootEntries.has(name)) continue;
        await copyEntry(sourceRoot.fd, destinationRoot.fd, name);
      }
    } finally {
      if (existingDestination === undefined) await destinationRoot.close();
    }
  } finally {
    await sourceRoot.close();
  }
}

/**
 * `/proc/self/fd/<n>` keeps traversal anchored at an already-open Linux
 * directory descriptor. A later ancestor rename or symlink swap therefore
 * cannot redirect this copy to an attacker-controlled tree.
 */
function descriptorPath(descriptor: number): string {
  return `/proc/self/fd/${descriptor}`;
}

async function openVerifiedDirectory(
  candidate: string,
  label: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  const components = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((component) => component.length > 0);
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(
      parsed.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    for (const component of components) {
      const next = await open(
        path.join(descriptorPath(directory.fd), component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = next;
    }
    return directory;
  } catch {
    await directory?.close();
    throw new Error(`${label}无法安全打开`);
  }
}

async function createVerifiedDirectory(
  candidate: string,
  mode: number,
): Promise<Awaited<ReturnType<typeof open>>> {
  const absolute = path.resolve(candidate);
  const parent = await openVerifiedDirectory(
    path.dirname(absolute),
    "复制目标目录的父目录",
  );
  const name = path.basename(absolute);
  const childPath = path.join(descriptorPath(parent.fd), name);
  try {
    await mkdir(childPath, { recursive: false, mode });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      await parent.close();
      throw error;
    }
  }
  let child: Awaited<ReturnType<typeof open>> | undefined;
  try {
    child = await open(
      childPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if ((await readdir(descriptorPath(child.fd))).length !== 0)
      throw new Error("复制目标目录必须为空");
    await child.chmod(mode);
    return child;
  } catch (error) {
    await child?.close();
    if (error instanceof Error && error.message === "复制目标目录必须为空")
      throw error;
    throw new Error("复制目标目录必须是非符号链接目录");
  } finally {
    await parent.close();
  }
}

async function createChildVerifiedDirectory(
  parentDescriptor: number,
  name: string,
  mode: number,
  allowExisting = false,
): Promise<Awaited<ReturnType<typeof open>>> {
  const childPath = path.join(descriptorPath(parentDescriptor), name);
  try {
    await mkdir(childPath, { recursive: false, mode });
  } catch (error) {
    if (!allowExisting || errorCode(error) !== "EEXIST") throw error;
  }
  const child = await openAnchoredDirectory(childPath, "复制目标目录项");
  try {
    if ((await readdir(descriptorPath(child.fd))).length !== 0)
      throw new Error("复制目标目录必须为空");
    await child.chmod(mode);
    return child;
  } catch (error) {
    await child.close();
    throw error;
  }
}

async function copyEntry(
  sourceDirectoryDescriptor: number,
  destinationDirectoryDescriptor: number,
  name: string,
): Promise<void> {
  if (name.includes("/") || name === "." || name === "..")
    throw new Error("产品数据包含无效目录项；拒绝复制");
  const source = path.join(descriptorPath(sourceDirectoryDescriptor), name);
  const destination = path.join(
    descriptorPath(destinationDirectoryDescriptor),
    name,
  );
  const status = await lstat(source);
  if (status.isSymbolicLink())
    throw new Error("产品数据包含符号链接；拒绝复制");
  if (status.isDirectory()) {
    await mkdir(destination, { mode: status.mode & 0o777 });
    const sourceChild = await openAnchoredDirectory(source, "产品数据目录项");
    const destinationChild = await openAnchoredDirectory(
      destination,
      "复制目标目录项",
    );
    try {
      await assertSameIdentity(
        status,
        await sourceChild.stat(),
        "产品数据目录项在复制期间改变；拒绝复制",
      );
      await destinationChild.chmod(status.mode & 0o777);
      for (const child of await readdir(descriptorPath(sourceChild.fd)))
        await copyEntry(sourceChild.fd, destinationChild.fd, child);
    } finally {
      await destinationChild.close();
      await sourceChild.close();
    }
    return;
  }
  if (!status.isFile())
    throw new Error("产品数据包含不安全的文件类型；拒绝复制");
  const sourceFile = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let destinationFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const sourceStatus = await sourceFile.stat();
    if (!sourceStatus.isFile())
      throw new Error("产品数据文件在复制期间改变；拒绝复制");
    await assertSameIdentity(
      status,
      sourceStatus,
      "产品数据文件在复制期间改变；拒绝复制",
    );
    destinationFile = await open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      sourceStatus.mode & 0o777,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await sourceFile.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationFile.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten === 0)
          throw new Error("产品数据文件复制短写；拒绝发布不完整副本");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const finishedStatus = await sourceFile.stat();
    if (
      finishedStatus.size !== sourceStatus.size ||
      finishedStatus.mtimeMs !== sourceStatus.mtimeMs
    )
      throw new Error("产品数据文件在复制期间改变；拒绝复制");
    const destinationStatus = await destinationFile.stat();
    if (destinationStatus.size !== sourceStatus.size)
      throw new Error("产品数据文件复制大小不一致；拒绝发布不完整副本");
    await destinationFile.chmod(sourceStatus.mode & 0o777);
  } finally {
    await destinationFile?.close();
    await sourceFile.close();
  }
}

async function openAnchoredDirectory(
  candidate: string,
  label: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(
      candidate,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new Error(`${label}无法安全打开`);
  }
}

async function assertEmptyDirectory(
  directory: string,
  label: string,
): Promise<void> {
  try {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error(`${label}必须是非符号链接目录`);
    const entries = await readdir(directory);
    const permitted = await Promise.all(
      entries.map(async (entry) => {
        if (entry === "runtime-state") return true;
        if (entry !== "staging") return false;
        return (await readdir(path.join(directory, entry))).length === 0;
      }),
    );
    if (!permitted.every(Boolean)) {
      throw new Error(`${label}必须为空；恢复不会覆盖已有产品数据`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function assertNoSymlinkAncestors(
  candidate: string,
  allowMissingLeaf: boolean,
): Promise<void> {
  const absolute = path.resolve(candidate);
  let current = absolute;
  let missingLeaf = false;
  for (;;) {
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink()) throw new Error("路径祖先不能是符号链接");
      if (!status.isDirectory() && current !== absolute)
        throw new Error("路径祖先必须是目录");
      if (!status.isDirectory() && current === absolute && !allowMissingLeaf)
        throw new Error("产品数据目录必须是目录");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      if (current !== absolute || !allowMissingLeaf)
        throw new Error("路径祖先不存在；拒绝离线维护");
      missingLeaf = true;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    if (missingLeaf) {
      current = parent;
      missingLeaf = false;
    } else {
      current = parent;
    }
  }
}

async function publishDurableEntries(
  stage: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const published: string[] = [];
  try {
    for (const name of await readdir(descriptorPath(stage.fd))) {
      if (disposableProductRootEntries.has(name)) continue;
      const source = path.join(descriptorPath(stage.fd), name);
      const target = path.join(descriptorPath(destination.fd), name);
      const before = await lstat(source);
      if (before.isSymbolicLink())
        throw new Error("恢复暂存包含符号链接；拒绝发布");
      await rename(source, target);
      fsyncDirectory(descriptorPath(stage.fd));
      fsyncDirectory(descriptorPath(destination.fd));
      const after = await lstat(target);
      await assertSameIdentity(
        before,
        after,
        "发布期间目录项身份改变；拒绝完成恢复",
      );
      published.push(name);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const name of published.reverse()) {
      try {
        await rename(
          path.join(descriptorPath(destination.fd), name),
          path.join(descriptorPath(stage.fd), name),
        );
        fsyncDirectory(descriptorPath(destination.fd));
        fsyncDirectory(descriptorPath(stage.fd));
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error("恢复发布未完成；回滚失败，删除失败目标后从备份恢复", {
        cause: error,
      });
    }
    throw error;
  }
}

function writeRestoreInProgressMarker(
  destinationDescriptor: number,
  generation: string,
): void {
  const directory = descriptorPath(destinationDescriptor);
  const marker = path.join(
    directory,
    "runtime-state",
    "offline-restore-in-progress.json",
  );
  const temporary = `${marker}.${randomUUID()}.tmp`;
  const contents = JSON.stringify({
    schema: "offline-restore-in-progress/1",
    generation,
  });
  const file = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(file, contents, "utf8");
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, marker);
  fsyncDirectory(path.dirname(marker));
}

function removeRestoreInProgressMarker(destinationDescriptor: number): void {
  const directory = descriptorPath(destinationDescriptor);
  const marker = path.join(
    directory,
    "runtime-state",
    "offline-restore-in-progress.json",
  );
  unlinkSync(marker);
  fsyncDirectory(path.dirname(marker));
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function assertDescriptorIdentity(
  pathname: string,
  descriptor: Awaited<ReturnType<typeof open>>,
  message: string,
): Promise<void> {
  const named = await lstat(pathname);
  if (named.isSymbolicLink()) throw new Error(message);
  await assertSameIdentity(named, await descriptor.stat(), message);
}

async function assertSameIdentity(
  expected: { readonly dev: number; readonly ino: number },
  actual: { readonly dev: number; readonly ino: number },
  message: string,
): Promise<void> {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino)
    throw new Error(message);
}

function cryptoRandomName(): string {
  return randomUUID();
}

function assertDistinctRoots(source: string, destination: string): void {
  if (
    source === destination ||
    destination.startsWith(`${source}${path.sep}`) ||
    source.startsWith(`${destination}${path.sep}`)
  ) {
    throw new Error("备份目录不能与产品数据目录重叠");
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? ((error as { readonly code?: unknown }).code as string | undefined)
    : undefined;
}
