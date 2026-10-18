import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import path from "node:path";

import type {
  AssetLibraryInitialConfiguration,
  AssetLibraryInitialConfigurationPersistence,
  SourceConnectionPrivateLease,
  SourceConnectionPrivateLeaseOwnership,
  SourceConnectionPrivateLeaseRecord,
  SourceConnectionPrivateStateListing,
  SourceConnectionPrivateStatePort,
  SourceConnectionPrivateStateRead,
} from "@digital/application";

import {
  ProductPrivateLease,
  errorCode,
  inspectPrivatePath,
  isCanonicalTimestamp,
  linuxProcessStartTimeTicks,
  writePrivateJsonDurably,
  type ProductPrivateLeaseOwnership,
  type ProductPrivateLeaseOwner,
  type ProductPrivateLeaseRecord,
} from "./private-lease.ts";

export {
  ProductPrivateLease,
  inspectPrivatePath,
  writePrivateJsonDurably,
} from "./private-lease.ts";
export type {
  ProductPrivateLeaseOwnership,
  ProductPrivateLeaseRecord,
} from "./private-lease.ts";

export {
  createOfflineProductDataBackup,
  restoreOfflineProductDataBackup,
} from "./offline-product-data.ts";
export type { ProductDataRestoreStage } from "./offline-product-data.ts";

const sourceConnectionPrivateDirectory = "private-source-connections";
const initialConfigurationFileName = "asset-library-initial-configuration.json";

/** 产品数据基础设施保存可跨环境数据世代保留的非秘密资产库基线。 */
export class ProductAssetLibraryInitialConfiguration implements AssetLibraryInitialConfigurationPersistence {
  readonly #directory: string;
  readonly #file: string;

  private constructor(directory: string) {
    this.#directory = path.resolve(directory);
    this.#file = path.join(this.#directory, initialConfigurationFileName);
  }

  static forDirectory(
    directory: string,
  ): ProductAssetLibraryInitialConfiguration {
    return new ProductAssetLibraryInitialConfiguration(directory);
  }

  async read(): Promise<AssetLibraryInitialConfiguration | undefined> {
    const directoryState = inspectPrivatePath(this.#directory, "directory");
    if (directoryState === "missing") return undefined;
    if (directoryState !== "usable")
      throw new Error("初始资产库配置目录不可用");
    const fileState = inspectPrivatePath(this.#file, "file");
    if (fileState === "missing") return undefined;
    if (fileState !== "usable") throw new Error("初始资产库配置文件不可用");
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.#file, "utf8"));
    } catch (error) {
      throw new Error("初始资产库配置无法读取", { cause: error });
    }
    if (!isInitialConfiguration(value))
      throw new Error("初始资产库配置格式无效");
    return value;
  }

  async write(configuration: AssetLibraryInitialConfiguration): Promise<void> {
    if (!isInitialConfiguration(configuration))
      throw new Error("初始资产库配置格式无效");
    writePrivateJsonDurably({
      directory: this.#directory,
      target: this.#file,
      value: configuration,
      failureMessage: "初始资产库配置无法持久保存",
    });
  }
}

function isInitialConfiguration(
  value: unknown,
): value is AssetLibraryInitialConfiguration {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["version", "appliedDataGeneration", "libraries"]) ||
    value.version !== 1 ||
    (value.appliedDataGeneration !== null &&
      typeof value.appliedDataGeneration !== "string") ||
    !Array.isArray(value.libraries)
  )
    return false;
  return value.libraries.every(isInitialLibrary);
}

function isInitialLibrary(value: unknown): boolean {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "displayName",
      "directories",
      "recognitionProfileIds",
      "sourceIdentities",
    ]) ||
    !isNonEmptyString(value.displayName) ||
    !Array.isArray(value.directories) ||
    value.directories.length === 0 ||
    !isStringList(value.recognitionProfileIds) ||
    !isStringList(value.sourceIdentities)
  )
    return false;
  return value.directories.every(isInitialDirectory);
}

function isInitialDirectory(value: unknown): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, ["path", "symlinkMode", "targetDirectories"]) &&
    isNonEmptyString(value.path) &&
    (value.symlinkMode === "do-not-follow" ||
      value.symlinkMode === "follow-file-links" ||
      value.symlinkMode === "follow-file-and-directory-links") &&
    isStringList(value.targetDirectories)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => key in value)
  );
}

function isStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => isNonEmptyString(entry))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 产品数据对来源连接私密状态端口的唯一文件系统 Adapter。 */
export class ProductSourceConnectionPrivateState implements SourceConnectionPrivateStatePort {
  readonly #directory: string;

  private constructor(productDataDirectory: string) {
    this.#directory = path.join(
      path.resolve(productDataDirectory),
      sourceConnectionPrivateDirectory,
    );
  }

  static forRoot(
    productDataDirectory: string,
  ): ProductSourceConnectionPrivateState {
    return new ProductSourceConnectionPrivateState(productDataDirectory);
  }

  read(key: string): SourceConnectionPrivateStateRead {
    const target = this.#recordPath(key);
    const directory = inspectPrivatePath(this.#directory, "directory");
    if (directory !== "usable") return { status: directory };
    const file = inspectPrivatePath(target, "file");
    if (file !== "usable") return { status: file };
    try {
      return {
        status: "usable",
        value: JSON.parse(readFileSync(target, "utf8")),
      };
    } catch {
      return { status: "storage-invalid" };
    }
  }

  write(input: {
    readonly key: string;
    readonly value: unknown;
    readonly failureMessage: string;
  }): void {
    writePrivateJsonDurably({
      directory: this.#directory,
      target: this.#recordPath(input.key),
      value: input.value,
      failureMessage: input.failureMessage,
    });
  }

  list(): SourceConnectionPrivateStateListing {
    const status = inspectPrivatePath(this.#directory, "directory");
    if (status !== "usable") return { status, keys: [] };
    try {
      return {
        status: "usable",
        keys: readdirSync(this.#directory)
          .flatMap((name) =>
            name.endsWith(".json") ? [name.slice(0, -".json".length)] : [],
          )
          .toSorted(),
      };
    } catch {
      return { status: "storage-invalid", keys: [] };
    }
  }

  lease<Record extends SourceConnectionPrivateLeaseRecord>(input: {
    readonly key: string;
    readonly namespaceKey?: string;
    readonly now: () => Date;
    readonly monotonicNow?: () => number;
    readonly bootId?: () => string;
    readonly isRecord: (value: unknown) => value is Record;
    readonly failureMessage: string;
  }): SourceConnectionPrivateLease<Record> {
    const key = privateStateKey(input.key);
    const namespaceKey =
      input.namespaceKey === undefined
        ? undefined
        : privateStateKey(input.namespaceKey);
    return new ProductSourceConnectionPrivateLeaseAdapter(
      new ProductPrivateLease({
        directory: this.#directory,
        path: path.join(this.#directory, `${key}.json`),
        ...(namespaceKey === undefined
          ? {}
          : {
              namespacePath: path.join(
                this.#directory,
                `${namespaceKey}.lease-namespace`,
              ),
            }),
        now: input.now,
        ...(input.monotonicNow === undefined
          ? {}
          : { monotonicNow: input.monotonicNow }),
        ...(input.bootId === undefined ? {} : { bootId: input.bootId }),
        isRecord: input.isRecord,
        failureMessage: input.failureMessage,
      }),
    );
  }

  #recordPath(key: string): string {
    return path.join(this.#directory, `${privateStateKey(key)}.json`);
  }
}

class ProductSourceConnectionPrivateLeaseAdapter<
  Record extends SourceConnectionPrivateLeaseRecord,
> implements SourceConnectionPrivateLease<Record> {
  readonly #lease: ProductPrivateLease<Record>;

  constructor(lease: ProductPrivateLease<Record>) {
    this.#lease = lease;
  }

  tryAcquire(candidate: Record): boolean {
    return this.#lease.tryAcquire(candidate);
  }

  acquire(
    candidate: Record,
  ): SourceConnectionPrivateLeaseOwnership<Record> | undefined {
    return this.#lease.acquire(candidate);
  }

  reclaimStale(): boolean {
    return this.#lease.reclaimStale();
  }

  isLive(): boolean {
    return this.#lease.isLive();
  }

  currentRecord(): Record | undefined {
    return this.#lease.currentRecord();
  }

  retireExact(expected: Record): boolean {
    return this.#lease.retireExact(expected);
  }

  consumeToActive(
    expected: Record,
    target: SourceConnectionPrivateLease<Record>,
  ): SourceConnectionPrivateLeaseOwnership<Record> | undefined {
    if (!(target instanceof ProductSourceConnectionPrivateLeaseAdapter)) {
      throw new Error("来源连接私密租约 Adapter 不兼容");
    }
    return this.#lease.consumeToActive(expected, target.#lease);
  }
}

function privateStateKey(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) {
    throw new Error("来源连接私密状态键无效");
  }
  return value;
}

const productOperationStateSuffix = ".digital-operation-state";
const productOperationLeaseFileName = "product-operation.lease.json";
const operationLeaseLifetimeMilliseconds = 24 * 60 * 60 * 1_000;

type ProductOperation = "writer" | "maintenance";

type ProductOperationLeaseRecord = ProductPrivateLeaseRecord & {
  readonly schema: "product-private-lease/1";
  readonly version: "product-operation-lease/1";
  readonly fingerprint: "product-operation";
  readonly operation: ProductOperation;
};

/**
 * 不可结构伪造的产品写入世代。它只由 ProductDataOperations 创建；组合根从不
 * 接受此对象作为输入，因此测试也不能绕过真实的跨进程准入。
 */
class ProductOperationGeneration {
  readonly #ownership: ProductPrivateLeaseOwnership<ProductOperationLeaseRecord>;
  #released = false;

  constructor(
    ownership: ProductPrivateLeaseOwnership<ProductOperationLeaseRecord>,
  ) {
    this.#ownership = ownership;
  }

  isCurrent(): boolean {
    return !this.#released && this.#ownership.isCurrent();
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#ownership.retire();
  }
}

/**
 * 在构造任何可改写 Catalogue、托管产物或私有连接的生产对象前取得全产品写入权。
 * 它与维护共享同一权威，因此维护不能插入检查与真实写入之间。
 */
export class ProductDataWriterLifecycle {
  readonly #generation: ProductOperationGeneration;
  constructor(generation: ProductOperationGeneration) {
    this.#generation = generation;
  }
  isCurrent(): boolean {
    return this.#generation.isCurrent();
  }
  close(): void {
    this.#generation.release();
  }
}

export class ProductDataMaintenanceLifecycle {
  readonly #generation: ProductOperationGeneration;
  constructor(generation: ProductOperationGeneration) {
    this.#generation = generation;
  }
  isCurrent(): boolean {
    return this.#generation.isCurrent();
  }
  close(): void {
    this.#generation.release();
  }
}

/** 产品根布局、跨进程准入与维护授权的唯一高层 Interface。 */
export class ProductDataOperations {
  readonly #root: string;
  private constructor(root: string) {
    this.#root = path.resolve(root);
  }
  static forRoot(root: string): ProductDataOperations {
    return new ProductDataOperations(root);
  }
  startWriter(): ProductDataWriterLifecycle {
    const generation = acquireProductOperationLease(this.#root, "writer");
    try {
      assertNoInterruptedRestore(this.#root);
      return new ProductDataWriterLifecycle(generation);
    } catch (error) {
      generation.release();
      throw error;
    }
  }
  startMaintenance(): ProductDataMaintenanceLifecycle {
    return new ProductDataMaintenanceLifecycle(
      acquireProductOperationLease(this.#root, "maintenance"),
    );
  }
  async withWriter<Result>(operation: () => Promise<Result>): Promise<Result> {
    const lifecycle = this.startWriter();
    try {
      return await operation();
    } finally {
      lifecycle.close();
    }
  }
  async assertOffline(): Promise<void> {
    const lease = productOperationLease(this.#root);
    if (!lease.isLive()) return;
    throw operationConflict(lease.currentRecord()?.operation, "maintenance");
  }
  assertRestoreCanStart(): void {
    assertNoInterruptedRestore(this.#root);
  }
}

/**
 * 恢复发布在进程中断后不会猜测目录是否完整。维护者必须删除该目标并从原备份
 * 恢复到新的空根；此前拒绝任何写入者取得权威。
 */
function assertNoInterruptedRestore(productDataDirectory: string): void {
  const marker = path.join(
    path.resolve(productDataDirectory),
    "runtime-state",
    "offline-restore-in-progress.json",
  );
  try {
    const status = lstatSync(marker);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(
        "离线恢复中断状态不可信；拒绝写入，删除失败目标后从备份恢复",
      );
    }
    readFileSync(marker, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    if (error instanceof Error && error.message.includes("离线恢复中断状态"))
      throw error;
    throw new Error(
      "离线恢复中断状态不可信；拒绝写入，删除失败目标后从备份恢复",
      { cause: error },
    );
  }
  throw new Error("离线恢复曾中断；拒绝写入，删除失败目标后从备份恢复");
}

function acquireProductOperationLease(
  productDataDirectory: string,
  operation: ProductOperation,
): ProductOperationGeneration {
  const lease = productOperationLease(productDataDirectory);
  const ownership = lease.acquire(newOperationRecord(operation));
  if (ownership === undefined) {
    throw operationConflict(lease.currentRecord()?.operation, operation);
  }
  return ownedOperationLease(ownership);
}

function ownedOperationLease(
  ownership: ProductPrivateLeaseOwnership<ProductOperationLeaseRecord>,
): ProductOperationGeneration {
  return new ProductOperationGeneration(ownership);
}

function operationConflict(
  active: ProductOperation | undefined,
  requested: ProductOperation,
): Error {
  if (active === "writer") {
    return new Error(
      requested === "maintenance"
        ? "产品正在运行；产品正在写入。停止 Web、自动刷新宿主和 CLI 写入后再执行离线维护"
        : "产品正在写入；拒绝并发启动另一个产品写入者",
    );
  }
  if (active === "maintenance") {
    return new Error(
      requested === "writer"
        ? "产品正在维护；离线备份或恢复完成前拒绝启动写入者"
        : "产品正在维护；拒绝并发执行另一个维护操作",
    );
  }
  return new Error("产品运行维护状态不可信；拒绝并发写入或离线维护");
}

function productOperationLease(
  productDataDirectory: string,
): ProductPrivateLease<ProductOperationLeaseRecord> {
  const directory = productOperationStateDirectory(productDataDirectory);
  return new ProductPrivateLease({
    directory,
    path: path.join(directory, productOperationLeaseFileName),
    now: () => new Date(),
    isRecord: isProductOperationLeaseRecord,
    failureMessage: "产品运行维护状态不可信；拒绝并发写入或离线维护",
    reclaimCorrupt: false,
    processOwner: productOperationOwner,
    isOwnerAlive: productOperationOwnerAlive,
  });
}

/**
 * 运行维护状态属于部署卷：容器中的 /data 与宿主机维护命令看见同一记录，且
 * 非 root 用户只需有产品根的写权限。离线备份显式排除此可重建区域。
 */
function productOperationStateDirectory(productDataDirectory: string): string {
  const root = path.resolve(productDataDirectory);
  return path.join(root, "runtime-state", productOperationStateSuffix);
}

function newOperationRecord(
  operation: ProductOperation,
): ProductOperationLeaseRecord {
  const acquiredAt = new Date();
  return {
    schema: "product-private-lease/1",
    version: "product-operation-lease/1",
    // 即使 Linux 复用 PID，实例随机值仍可区分一次重启。
    instanceNonce: randomUUID(),
    leaseNonce: randomUUID(),
    fingerprint: "product-operation",
    operation,
    acquiredAt: acquiredAt.toISOString(),
    expiresAt: new Date(
      acquiredAt.getTime() + operationLeaseLifetimeMilliseconds,
    ).toISOString(),
  };
}

function isProductOperationLeaseRecord(
  value: unknown,
): value is ProductOperationLeaseRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === "product-private-lease/1" &&
    record.version === "product-operation-lease/1" &&
    isNonce(record.instanceNonce) &&
    isNonce(record.leaseNonce) &&
    record.fingerprint === "product-operation" &&
    (record.operation === "writer" || record.operation === "maintenance") &&
    isCanonicalTimestamp(record.acquiredAt) &&
    isCanonicalTimestamp(record.expiresAt) &&
    Date.parse(record.expiresAt) > Date.parse(record.acquiredAt)
  );
}

function isNonce(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

/** ProductPrivateLease 记录启动标识；无法证明 PID 命名空间和 UID 相同时一律拒绝回收。 */
function productOperationOwner(): ProductPrivateLeaseOwner {
  const uid = process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error("cannot establish process UID");
  return {
    pid: process.pid,
    startTimeTicks: linuxProcessStartTimeTicks(process.pid),
    pidNamespace: linuxPidNamespace(),
    uid,
  };
}

function productOperationOwnerAlive(owner: ProductPrivateLeaseOwner): boolean {
  if (owner.pidNamespace === undefined || owner.uid === undefined)
    throw new Error("owner namespace identity is incomplete");
  const self = productOperationOwner();
  if (owner.pidNamespace !== self.pidNamespace || owner.uid !== self.uid) {
    throw new Error("owner PID namespace or UID is not provably shared");
  }
  try {
    return linuxProcessStartTimeTicks(owner.pid) === owner.startTimeTicks;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function linuxPidNamespace(): string {
  const value = readlinkSync("/proc/self/ns/pid");
  if (!/^pid:\[[0-9]+\]$/u.test(value))
    throw new Error("invalid PID namespace");
  return value;
}
