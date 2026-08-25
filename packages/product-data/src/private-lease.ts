import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type ProductPrivateLeaseRecord = {
  readonly schema: "product-private-lease/1";
  readonly version: string;
  readonly instanceNonce: string;
  readonly leaseNonce: string;
  readonly fingerprint: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
};

/**
 * 已持有租约世代的精确 Linux 进程证据。产品级租约可附加 PID 命名空间和 UID
 * 证明后才回收缺失进程；普通私有租约只保留最小的 PID/启动时间证明。
 */
export type ProductPrivateLeaseOwner = {
  readonly pid: number;
  /** Linux /proc/<pid>/stat 的启动时间，防止 PID 复用。 */
  readonly startTimeTicks: string;
  readonly pidNamespace?: string;
  readonly uid?: number;
};

type PrivatePathState =
  | "missing"
  | "permissions-unsafe"
  | "storage-invalid"
  | "usable";

type LeaseEnvelope<T extends ProductPrivateLeaseRecord> = {
  readonly schema: "product-private-lease-namespace/1";
  readonly slot: string;
  readonly generation: string;
  readonly record: T;
  /**
   * `record` 保留墙钟时间供诊断；脱离进程的待处理记录使用此 Linux 启动期
   * 单调截止时间。当前启动期中精确进程身份仍存在的持有者始终具备权威。
   */
  readonly clock: {
    readonly bootId: string;
    readonly expiresAtMonotonicMilliseconds: number;
  };
  /** 仅当本地进程正在持有临界区时存在。 */
  readonly owner?: ProductPrivateLeaseOwner;
  readonly publishedAt: string;
};

type LeaseClosedMarker = {
  readonly schema: "product-private-lease-closed/1";
  readonly slot: string;
  readonly generation: string;
  readonly reason: "released" | "expired" | "invalid";
};

type NamespaceState<T extends ProductPrivateLeaseRecord> = {
  readonly highestGeneration: bigint;
  readonly active: LeaseEnvelope<T> | undefined;
  /** 所有有效世代，包含已关闭的前代。 */
  readonly records: readonly LeaseEnvelope<T>[];
  readonly corruptGenerations: readonly string[];
  readonly closed: ReadonlySet<string>;
};

type ProductPrivateLeaseInput<T extends ProductPrivateLeaseRecord> = {
  readonly directory: string;
  /**
   * 稳定逻辑租约标识。它自身从不作为可变状态被打开、改名或删除；记录存放在
   * 旁侧不可变命名空间中。
   */
  readonly path: string;
  /** 让关联的待处理/处理中槽位复用一个耐久命名空间。 */
  readonly namespacePath?: string;
  readonly now: () => Date;
  /** Linux 启动期单调时间，仅供确定性测试注入。 */
  readonly monotonicNow?: () => number;
  /** Linux 启动标识，仅供确定性测试注入。 */
  readonly bootId?: () => string;
  /** 仅供确定性存活性测试注入。 */
  readonly isOwnerAlive?: (owner: {
    readonly pid: number;
    readonly startTimeTicks: string;
    readonly pidNamespace?: string;
    readonly uid?: number;
  }) => boolean;
  /** 为需要更强命名空间证明的租约提供持有者身份。 */
  readonly processOwner?: () => ProductPrivateLeaseOwner;
  readonly isRecord: (value: unknown) => value is T;
  readonly failureMessage: string;
  /** 产品级权威可要求损坏状态始终硬失败。 */
  readonly reclaimCorrupt?: boolean;
  /** 仅供测试：不可变发布前的确定性交错点。 */
  readonly beforePublish?: () => void;
  /** 仅供测试：关闭过期世代前的确定性交错点。 */
  readonly beforeRetire?: () => void;
};

/**
 * 持有一个耐久租约世代在进程内的一次执行。
 *
 * 持有者记录保持耐久，以供崩溃恢复。同一启动期内的 PID／启动时间证明可以区分仍在
 * 执行的持有者、已崩溃进程和 PID 复用。进程身份而非猜测的经过时长始终具有权威，
 * 直到它被释放或不再精确。每次耐久变更仍须在提交前立即检查 `isCurrent()`。
 */
export class ProductPrivateLeaseOwnership<T extends ProductPrivateLeaseRecord> {
  private readonly lease: ProductPrivateLease<T>;
  private readonly envelope: LeaseEnvelope<T>;
  private closed = false;

  constructor(input: {
    readonly lease: ProductPrivateLease<T>;
    readonly envelope: LeaseEnvelope<T>;
  }) {
    this.lease = input.lease;
    this.envelope = input.envelope;
  }

  /** 本进程持有的记录；它绝不是能力边界。 */
  record(): T {
    return this.envelope.record;
  }

  /**
   * 检查精确的不可变世代持有权。任何异步等待结束后，都应在耐久业务变更前立即调用。
   */
  isCurrent(): boolean {
    return !this.closed && this.lease.isCurrent(this.envelope);
  }

  /** 结束该世代，且不触碰任何后续世代。 */
  retire(): boolean {
    if (this.closed) return false;
    this.closed = true;
    return this.lease.closeExactEnvelope(this.envelope, "released");
  }
}

/**
 * 按世代隔离的不可变私有租约命名空间。
 *
 * 这里刻意不存在可复用的 `.reclaim`、`.retired` 或固定租约路径名。每次取得租约都把
 * 一条已经完整 `fsync` 的不可变世代记录链接到下一个确定名称；每次释放或回收只为
 * 该世代写入独立且不可变的关闭标记。竞争发布者只在一个世代名称的 `link(2)` 上竞态；
 * 延迟清理最多重复写入同一个旧标记，因此不能删除、改名或覆盖后续世代，从而消除
 * 先前的 ABA 缺陷类型。
 */
export class ProductPrivateLease<T extends ProductPrivateLeaseRecord> {
  private readonly input: Required<
    Pick<
      ProductPrivateLeaseInput<T>,
      | "directory"
      | "path"
      | "now"
      | "isRecord"
      | "failureMessage"
      | "beforePublish"
      | "beforeRetire"
      | "reclaimCorrupt"
    >
  > & {
    readonly namespacePath: string;
    readonly monotonicNow: () => number;
    readonly bootId: () => string;
    readonly isOwnerAlive: (owner: {
      readonly pid: number;
      readonly startTimeTicks: string;
      readonly pidNamespace?: string;
      readonly uid?: number;
    }) => boolean;
    readonly processOwner: () => ProductPrivateLeaseOwner;
  };
  private readonly namespaceDirectory: string;
  private readonly slot: string;

  constructor(input: ProductPrivateLeaseInput<T>) {
    this.namespaceDirectory = input.namespacePath ?? `${input.path}.namespace`;
    this.slot = createHash("sha256")
      .update(path.resolve(input.path))
      .digest("hex")
      .slice(0, 24);
    this.input = {
      directory: input.directory,
      path: input.path,
      namespacePath: this.namespaceDirectory,
      now: input.now,
      monotonicNow: input.monotonicNow ?? linuxMonotonicMilliseconds,
      bootId: input.bootId ?? linuxBootId,
      isOwnerAlive: input.isOwnerAlive ?? linuxOwnerAlive,
      processOwner: input.processOwner ?? linuxProcessOwner,
      isRecord: input.isRecord,
      failureMessage: input.failureMessage,
      reclaimCorrupt: input.reclaimCorrupt ?? true,
      beforePublish: input.beforePublish ?? (() => undefined),
      beforeRetire: input.beforeRetire ?? (() => undefined),
    };
  }

  /** 发布一条耐久记录，并立即使其脱离进程持有。 */
  tryAcquire(candidate: T): boolean {
    return this.publish(candidate, false) !== undefined;
  }

  /** 发布一条耐久记录，同时保留进程内执行持有权。 */
  acquire(candidate: T): ProductPrivateLeaseOwnership<T> | undefined {
    const envelope = this.publish(candidate, true);
    if (envelope === undefined) return undefined;
    return new ProductPrivateLeaseOwnership({ lease: this, envelope });
  }

  private publish(
    candidate: T,
    withOwner: boolean,
  ): LeaseEnvelope<T> | undefined {
    const observed = this.readExistingNamespaceState();
    if (
      observed?.active !== undefined &&
      this.isLiveEnvelope(observed.active)
    ) {
      // 同一启动期的精确持有者仍具权威时，竞争调用方甚至不能触碰私有目录元数据。
      return undefined;
    }
    this.reclaimStale();
    this.assertNamespaceWritable();
    const state = this.scan();
    if (state.active !== undefined) return undefined;
    const generation = formatGeneration(state.highestGeneration + 1n);
    const duration = this.durationMilliseconds(candidate);
    const monotonicNow = this.monotonicNow();
    const expiresAtMonotonicMilliseconds = monotonicNow + duration;
    if (
      !Number.isSafeInteger(monotonicNow) ||
      !Number.isSafeInteger(expiresAtMonotonicMilliseconds)
    ) {
      throw this.failure();
    }
    const envelope: LeaseEnvelope<T> = {
      schema: "product-private-lease-namespace/1",
      slot: this.slot,
      generation,
      record: candidate,
      clock: {
        bootId: this.bootId(),
        expiresAtMonotonicMilliseconds,
      },
      ...(withOwner ? { owner: this.processOwner() } : {}),
      publishedAt: canonicalNow(this.input.now, this.input.failureMessage),
    };
    this.input.beforePublish();
    if (!this.writeImmutable(this.recordPath(generation), envelope))
      return undefined;

    const current = this.scan().active;
    if (
      current === undefined ||
      current.generation !== generation ||
      !samePrivateLease(current.record, candidate)
    ) {
      // 不可变记录仍可安全审计；这里不尝试删除它。
      return undefined;
    }
    return envelope;
  }

  /**
   * 仅通过写入各自的不可变关闭标记，回收已脱离且过期、持有者死亡或被复用、启动期
   * 已改变、或已经损坏的世代。它绝不删除或改名可能被其他进程复用的索引。
   */
  reclaimStale(): boolean {
    const observed = this.readExistingNamespaceState();
    if (observed === undefined) return false;
    const observedCorrupt = observed.corruptGenerations.find(
      (generation) => !observed.closed.has(generation),
    );
    if (observedCorrupt !== undefined && !this.input.reclaimCorrupt)
      throw this.failure();
    if (
      observedCorrupt === undefined &&
      (observed.active === undefined || this.isLiveEnvelope(observed.active))
    ) {
      // 常见竞争路径保持只读。尤其不能仅为发现精确持有者仍存活，就对命名空间执行
      // `chmod` 或 `fsync`。
      return false;
    }
    this.assertNamespaceWritable();
    let changed = false;
    for (let attempts = 0; attempts < 8; attempts += 1) {
      const state = this.scan();
      const corrupt = state.corruptGenerations.find(
        (generation) => !state.closed.has(generation),
      );
      if (corrupt !== undefined) {
        if (!this.input.reclaimCorrupt) throw this.failure();
        changed = this.closeGeneration(corrupt, "invalid") || changed;
        continue;
      }
      const active = state.active;
      if (active === undefined || this.isLiveEnvelope(active)) return changed;
      this.input.beforeRetire();
      const refreshed = this.scan();
      const current = refreshed.active;
      if (
        current === undefined ||
        current.generation !== active.generation ||
        this.isLiveEnvelope(current)
      ) {
        continue;
      }
      changed = this.closeGeneration(active.generation, "expired") || changed;
    }
    if (this.scan().active !== undefined) return changed;
    throw this.failure();
  }

  /** 返回当前可见世代是否仍然有效。 */
  isLive(): boolean {
    if (this.namespaceMissing()) return false;
    this.assertNamespaceReadable();
    const state = this.scan();
    return state.active !== undefined && this.isLiveEnvelope(state.active);
  }

  /** 返回活动的耐久记录，但不授予持有权。 */
  currentRecord(): T | undefined {
    if (this.namespaceMissing()) return undefined;
    this.assertNamespaceReadable();
    return this.scan().active?.record;
  }

  /** 释放一条精确记录，绝不触碰后续世代。 */
  release(expected: T): void {
    this.retireExact(expected);
  }

  /** 仅当当前记录仍表示 `expected` 时，精确结束该记录。 */
  retireExact(expected: T): boolean {
    this.assertNamespaceWritable();
    const state = this.scan();
    const active = state.active;
    if (active === undefined || !samePrivateLease(active.record, expected))
      return false;
    return this.closeGeneration(active.generation, "released");
  }

  /**
   * 把一个精确来源世代消费进目标槽位。由已崩溃前序进程发布的目标刻意不恢复：调用方
   * 失败闭合，而不是重放可能已经交付的 OAuth 授权码。
   */
  consumeToActive(
    expected: T,
    target: ProductPrivateLease<T>,
  ): ProductPrivateLeaseOwnership<T> | undefined {
    this.assertNamespaceWritable();
    target.assertNamespaceWritable();
    const source = this.scan().active;
    if (source === undefined || !samePrivateLease(source.record, expected))
      return undefined;
    // 发布处理中世代是 OAuth 授权码的不可逆点。如果进程在发布后、关闭待处理世代前
    // 崩溃，后续回调必须把待处理世代消费为终态关闭，而不是再次发布处理中世代并重放
    // 可能已经交付的授权码。已关闭世代保持为不可变证据，正是为了支持该恢复决策。
    if (target.hasPublishedExact(expected)) {
      this.closeExactEnvelope(source, "released");
      return undefined;
    }
    if (!this.isLiveEnvelope(source)) return undefined;
    const ownership = target.acquire(expected);
    if (ownership === undefined) return undefined;
    if (!this.closeExactEnvelope(source, "released")) {
      ownership.retire();
      return undefined;
    }
    return ownership;
  }

  /** `ProductPrivateLeaseOwnership` 使用的内部持有权检查。 */
  isCurrent(envelope: LeaseEnvelope<T>): boolean {
    try {
      this.assertNamespaceReadable();
      const state = this.scan();
      return (
        state.active !== undefined &&
        state.active.generation === envelope.generation &&
        samePrivateLease(state.active.record, envelope.record) &&
        this.isLiveEnvelope(state.active)
      );
    } catch {
      return false;
    }
  }

  /** 持有权句柄使用的内部精确关闭。 */
  closeExactEnvelope(
    envelope: LeaseEnvelope<T>,
    reason: LeaseClosedMarker["reason"],
  ): boolean {
    this.assertNamespaceWritable();
    const state = this.scan();
    const current = state.active;
    if (
      current === undefined ||
      current.generation !== envelope.generation ||
      !samePrivateLease(current.record, envelope.record)
    ) {
      return false;
    }
    return this.closeGeneration(envelope.generation, reason);
  }

  durationMilliseconds(record: T): number {
    const acquiredAt = Date.parse(record.acquiredAt);
    const expiresAt = Date.parse(record.expiresAt);
    const duration = expiresAt - acquiredAt;
    if (!Number.isSafeInteger(duration) || duration <= 0) throw this.failure();
    return duration;
  }

  private scan(): NamespaceState<T> {
    this.assertNamespaceReadable();
    let names: string[];
    try {
      names = readdirSync(this.namespaceDirectory);
    } catch {
      throw this.failure();
    }
    const records = new Map<string, LeaseEnvelope<T>>();
    const corrupt = new Set<string>();
    const closed = new Set<string>();
    let highestGeneration = 0n;
    for (const name of names) {
      const parsed = this.parseName(name);
      if (parsed === undefined) continue;
      highestGeneration =
        parsed.generation > highestGeneration
          ? parsed.generation
          : highestGeneration;
      const generation = formatGeneration(parsed.generation);
      const candidate = path.join(this.namespaceDirectory, name);
      if (parsed.kind === "record") {
        const value = this.readPrivateJson(candidate);
        if (
          !isLeaseEnvelope(value, this.slot, generation, this.input.isRecord)
        ) {
          corrupt.add(generation);
          continue;
        }
        records.set(generation, value);
        continue;
      }
      if (parsed.kind === "closed") {
        const value = this.readPrivateJson(candidate);
        if (!isClosedMarker(value, this.slot, generation)) throw this.failure();
        closed.add(generation);
        continue;
      }
    }
    const active = [...records.values()].filter(
      (record) => !closed.has(record.generation),
    );
    if (active.length > 1) throw this.failure();
    return {
      highestGeneration,
      active: active[0],
      records: [...records.values()],
      corruptGenerations: [...corrupt],
      closed,
    };
  }

  private hasPublishedExact(expected: T): boolean {
    return this.scan().records.some((record) =>
      samePrivateLease(record.record, expected),
    );
  }

  private isLiveEnvelope(envelope: LeaseEnvelope<T>): boolean {
    if (envelope.clock.bootId !== this.bootId()) return false;
    if (envelope.owner !== undefined) {
      try {
        const alive = this.input.isOwnerAlive(envelope.owner);
        if (typeof alive !== "boolean") throw this.failure();
        return alive;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === this.input.failureMessage
        )
          throw error;
        throw this.failure();
      }
    }
    return this.monotonicNow() < envelope.clock.expiresAtMonotonicMilliseconds;
  }

  private closeGeneration(
    generation: string,
    reason: LeaseClosedMarker["reason"],
  ): boolean {
    return this.writeImmutable(this.closedPath(generation), {
      schema: "product-private-lease-closed/1",
      slot: this.slot,
      generation,
      reason,
    } satisfies LeaseClosedMarker);
  }

  private recordPath(generation: string): string {
    return path.join(
      this.namespaceDirectory,
      `${this.slot}.g-${generation}.lease.json`,
    );
  }

  private closedPath(generation: string): string {
    return path.join(
      this.namespaceDirectory,
      `${this.slot}.g-${generation}.closed.json`,
    );
  }

  private parseName(name: string):
    | {
        readonly generation: bigint;
        readonly kind: "record" | "closed";
      }
    | undefined {
    const escaped = escapeRegularExpression(this.slot);
    const match = new RegExp(
      `^${escaped}\\.g-([0-9]{20})\\.(lease|closed)\\.json$`,
      "u",
    ).exec(name);
    if (match === null) return undefined;
    const generation = BigInt(match[1]!);
    if (generation <= 0n) throw this.failure();
    return {
      generation,
      kind: match[2] === "lease" ? "record" : "closed",
    };
  }

  private writeImmutable(target: string, value: unknown): boolean {
    const temporary = path.join(
      this.namespaceDirectory,
      `.${this.slot}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, JSON.stringify(value), "utf8");
      chmodSync(temporary, 0o600);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporary, target);
        fsyncPrivateDirectory(
          this.namespaceDirectory,
          this.input.failureMessage,
        );
        return true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw this.failure();
      }
    } catch (error) {
      if (error instanceof Error && error.message === this.input.failureMessage)
        throw error;
      throw this.failure();
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 下方的安全失败仍是唯一可见结果。
        }
      }
      try {
        unlinkSync(temporary);
      } catch {
        // 随机私有临时项绝不是承载权威的名称。把它留给文件系统清理不会改变发布结果，
        // 也不能掩盖成功的耐久世代。
      }
    }
  }

  private readPrivateJson(candidate: string): unknown {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        candidate,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const status = fstatSync(descriptor);
      if (!status.isFile() || (status.mode & 0o077) !== 0) throw this.failure();
      const bytes = readFileSync(descriptor);
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof Error && error.message === this.input.failureMessage)
        throw error;
      throw this.failure();
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 已检查的读取结果是唯一相关结果。
        }
      }
    }
  }

  private assertNamespaceReadable(): void {
    const directory = inspectPrivatePath(this.input.directory, "directory");
    if (directory === "permissions-unsafe" || directory === "storage-invalid")
      throw this.failure();
    const namespace = inspectPrivatePath(this.namespaceDirectory, "directory");
    if (namespace === "permissions-unsafe" || namespace === "storage-invalid")
      throw this.failure();
  }

  private namespaceMissing(): boolean {
    const directory = inspectPrivatePath(this.input.directory, "directory");
    if (directory === "permissions-unsafe" || directory === "storage-invalid")
      throw this.failure();
    if (directory === "missing") return true;
    const namespace = inspectPrivatePath(this.namespaceDirectory, "directory");
    if (namespace === "permissions-unsafe" || namespace === "storage-invalid")
      throw this.failure();
    return namespace === "missing";
  }

  /** 读取既有命名空间，不创建任何内容，也不执行 `chmod`。 */
  private readExistingNamespaceState(): NamespaceState<T> | undefined {
    if (this.namespaceMissing()) return undefined;
    this.assertNamespaceReadable();
    return this.scan();
  }

  private assertNamespaceWritable(): void {
    try {
      ensurePrivateDirectoryDurably(
        this.input.directory,
        this.input.failureMessage,
      );
      ensurePrivateDirectoryDurably(
        this.namespaceDirectory,
        this.input.failureMessage,
      );
      this.assertNamespaceReadable();
    } catch (error) {
      if (error instanceof Error && error.message === this.input.failureMessage)
        throw error;
      throw this.failure();
    }
  }

  private monotonicNow(): number {
    const value = this.input.monotonicNow();
    if (!Number.isSafeInteger(value) || value < 0) throw this.failure();
    return value;
  }

  private bootId(): string {
    try {
      const value = this.input.bootId().trim();
      if (!/^[A-Za-z0-9-]{8,128}$/u.test(value)) throw this.failure();
      return value;
    } catch (error) {
      if (error instanceof Error && error.message === this.input.failureMessage)
        throw error;
      throw this.failure();
    }
  }

  private processOwner(): ProductPrivateLeaseOwner {
    try {
      const owner = this.input.processOwner();
      if (!isLeaseOwner(owner)) throw this.failure();
      return owner;
    } catch (error) {
      if (error instanceof Error && error.message === this.input.failureMessage)
        throw error;
      throw this.failure();
    }
  }

  private failure(): Error {
    return new Error(this.input.failureMessage);
  }
}

export function inspectPrivatePath(
  candidate: string,
  expected: "directory" | "file",
): PrivatePathState {
  try {
    const status = lstatSync(candidate);
    if (
      status.isSymbolicLink() ||
      (expected === "directory" ? !status.isDirectory() : !status.isFile())
    ) {
      return "storage-invalid";
    }
    return (status.mode & 0o077) === 0 ? "usable" : "permissions-unsafe";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    return "storage-invalid";
  }
}

export function writePrivateJsonDurably(input: {
  readonly directory: string;
  readonly target: string;
  readonly value: unknown;
  readonly failureMessage: string;
}): void {
  const directory = inspectPrivatePath(input.directory, "directory");
  if (directory === "permissions-unsafe" || directory === "storage-invalid")
    throw new Error(input.failureMessage);
  const existing = inspectPrivatePath(input.target, "file");
  if (existing === "permissions-unsafe" || existing === "storage-invalid")
    throw new Error(input.failureMessage);
  try {
    ensurePrivateDirectoryDurably(input.directory, input.failureMessage);
    if (inspectPrivatePath(input.directory, "directory") !== "usable")
      throw new Error(input.failureMessage);
    const temporary = `${input.target}.${randomUUID()}.next`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, JSON.stringify(input.value), "utf8");
      chmodSync(temporary, 0o600);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      const temporaryState = inspectPrivatePath(temporary, "file");
      if (temporaryState !== "usable") throw new Error(input.failureMessage);
      renameSync(temporary, input.target);
      chmodSync(input.target, 0o600);
      fsyncPrivateDirectory(input.directory, input.failureMessage);
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 写入失败后仍保持交付边界已净化。
        }
      }
      try {
        unlinkSync(temporary);
      } catch {
        // 随机临时项不具活性，也不授予权威。
      }
      if (error instanceof Error && error.message === input.failureMessage)
        throw error;
      throw new Error(input.failureMessage, { cause: error });
    }
  } catch (error) {
    if (error instanceof Error && error.message === input.failureMessage)
      throw error;
    throw new Error(input.failureMessage, { cause: error });
  }
}

export function samePrivateLease(
  left: ProductPrivateLeaseRecord,
  right: ProductPrivateLeaseRecord,
): boolean {
  return (
    left.version === right.version &&
    left.schema === right.schema &&
    left.instanceNonce === right.instanceNonce &&
    left.leaseNonce === right.leaseNonce &&
    left.fingerprint === right.fingerprint &&
    left.acquiredAt === right.acquiredAt &&
    left.expiresAt === right.expiresAt
  );
}

function isLeaseEnvelope<T extends ProductPrivateLeaseRecord>(
  value: unknown,
  slot: string,
  generation: string,
  isRecord: (value: unknown) => value is T,
): value is LeaseEnvelope<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema !== "product-private-lease-namespace/1" ||
    candidate.slot !== slot ||
    candidate.generation !== generation ||
    !isRecord(candidate.record)
  ) {
    return false;
  }
  const clock = candidate.clock;
  const deadline =
    typeof clock === "object" && clock !== null && !Array.isArray(clock)
      ? (clock as Record<string, unknown>).expiresAtMonotonicMilliseconds
      : undefined;
  return (
    typeof clock === "object" &&
    clock !== null &&
    !Array.isArray(clock) &&
    isBootIdentifier((clock as Record<string, unknown>).bootId) &&
    typeof deadline === "number" &&
    Number.isSafeInteger(deadline) &&
    deadline >= 0 &&
    (candidate.owner === undefined || isLeaseOwner(candidate.owner)) &&
    typeof candidate.publishedAt === "string" &&
    isCanonicalTimestamp(candidate.publishedAt)
  );
}

function isLeaseOwner(value: unknown): value is ProductPrivateLeaseOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const owner = value as Record<string, unknown>;
  const namespace = owner.pidNamespace;
  const uid = owner.uid;
  return (
    Number.isSafeInteger(owner.pid) &&
    (owner.pid as number) > 0 &&
    typeof owner.startTimeTicks === "string" &&
    /^[0-9]+$/u.test(owner.startTimeTicks) &&
    (namespace === undefined ||
      (typeof namespace === "string" && /^pid:\[[0-9]+\]$/u.test(namespace))) &&
    (uid === undefined ||
      (typeof uid === "number" && Number.isSafeInteger(uid) && uid >= 0))
  );
}

function isClosedMarker(
  value: unknown,
  slot: string,
  generation: string,
): value is LeaseClosedMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === "product-private-lease-closed/1" &&
    candidate.slot === slot &&
    candidate.generation === generation &&
    (candidate.reason === "released" ||
      candidate.reason === "expired" ||
      candidate.reason === "invalid")
  );
}

function canonicalNow(now: () => Date, failureMessage: string): string {
  try {
    const value = now().toISOString();
    if (!isCanonicalTimestamp(value)) throw new Error(failureMessage);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === failureMessage) throw error;
    throw new Error(failureMessage, { cause: error });
  }
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isBootIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,128}$/u.test(value);
}

function formatGeneration(generation: bigint): string {
  if (generation <= 0n) throw new Error("invalid generation");
  const formatted = generation.toString().padStart(20, "0");
  if (formatted.length !== 20) throw new Error("invalid generation");
  return formatted;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function linuxBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function linuxMonotonicMilliseconds(): number {
  const [seconds] = readFileSync("/proc/uptime", "utf8").trim().split(/\s+/u);
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid uptime");
  return Math.floor(value * 1_000);
}

function linuxProcessOwner(): ProductPrivateLeaseOwner {
  return {
    pid: process.pid,
    startTimeTicks: linuxProcessStartTimeTicks(process.pid),
  };
}

function linuxOwnerAlive(owner: {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly pidNamespace?: string;
  readonly uid?: number;
}): boolean {
  try {
    return linuxProcessStartTimeTicks(owner.pid) === owner.startTimeTicks;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    // 无法检查 `/proc` 不代表进行中的持有者已经死亡。应失败闭合，不能把基础设施问题
    // 转化为并发刷新或配置变更。
    throw error;
  }
}

export function linuxProcessStartTimeTicks(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid pid");
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParenthesis = stat.lastIndexOf(")");
  if (closingParenthesis < 0) throw new Error("invalid process stat");
  const fields = stat
    .slice(closingParenthesis + 1)
    .trim()
    .split(/\s+/u);
  // `/proc/<pid>/stat` 的第 22 个字段是启动时间；`comm` 后的字段从第 3 个开始。
  const startTimeTicks = fields[19];
  if (startTimeTicks === undefined || !/^[0-9]+$/u.test(startTimeTicks))
    throw new Error("invalid process stat");
  return startTimeTicks;
}

/** 逐级创建私有目录，并对每一级父目录执行 `fsync`。 */
function ensurePrivateDirectoryDurably(
  directory: string,
  failureMessage: string,
): void {
  const missing: string[] = [];
  let existing = path.resolve(directory);
  try {
    for (;;) {
      try {
        const status = lstatSync(existing);
        if (!status.isDirectory() || status.isSymbolicLink())
          throw new Error(failureMessage);
        break;
      } catch (error) {
        if (error instanceof Error && error.message === failureMessage)
          throw error;
        if (errorCode(error) !== "ENOENT")
          throw new Error(failureMessage, { cause: error });
        const parent = path.dirname(existing);
        if (parent === existing)
          throw new Error(failureMessage, { cause: error });
        missing.push(existing);
        existing = parent;
      }
    }
    for (const candidate of missing.toReversed()) {
      try {
        mkdirSync(candidate, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST")
          throw new Error(failureMessage, { cause: error });
      }
      chmodSync(candidate, 0o700);
      if (inspectPrivatePath(candidate, "directory") !== "usable")
        throw new Error(failureMessage);
      fsyncPrivateDirectory(path.dirname(candidate), failureMessage);
    }
    chmodSync(directory, 0o700);
    if (inspectPrivatePath(directory, "directory") !== "usable")
      throw new Error(failureMessage);
    fsyncPrivateDirectory(directory, failureMessage);
  } catch (error) {
    if (error instanceof Error && error.message === failureMessage) throw error;
    throw new Error(failureMessage, { cause: error });
  }
}

function fsyncPrivateDirectory(
  directory: string,
  failureMessage: string,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    // 该辅助函数创建新的私有叶目录时，也会对 `/tmp` 等祖先执行 `fsync`。只有叶目录
    // 本身是权威边界，并且已经检查为 0700；若拒绝带 sticky 位的公共祖先，普通测试或
    // 容器环境中的安全子目录将无法使用。
    if (!status.isDirectory()) throw new Error(failureMessage);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof Error && error.message === failureMessage) throw error;
    throw new Error(failureMessage, { cause: error });
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // `fsync` 结果已经决定了安全结果。
      }
    }
  }
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}
