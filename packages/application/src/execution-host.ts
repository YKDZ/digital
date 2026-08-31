export type ExecutionInvocationControl = {
  /** 仅在工作流执行已经耐久化后公布其身份。 */
  executionStarted(executionId: string): void;
  /** 仅在最新状态已经耐久化后停止进程持有的工作。 */
  safeCheckpoint(): void;
};

export type BackgroundExecutionControl = Pick<
  ExecutionInvocationControl,
  "safeCheckpoint"
>;

export type OperationCancellation = {
  readonly cancelled: boolean;
  readonly reason: "shutdown" | "observed-root-invalidated" | undefined;
  onCancel(listener: () => void): () => void;
};

export type OperationLease = {
  readonly cancellation: OperationCancellation;
  /** 将已经持有的顶层 reservation 绑定到查询后解析出的当前观察根。 */
  bindObservedRoot(input: {
    readonly registrationId: string;
    readonly registrationVersion: number;
  }): { release(): void };
  release(): void;
};

export class OperationLeaseInvalidated extends Error {
  constructor() {
    super("文件位置授权版本已经失效");
    this.name = "OperationLeaseInvalidated";
  }
}

class StopAtSafeCheckpoint extends Error {}

export type ExecutionInvocation = (
  control: ExecutionInvocationControl,
) => void | Promise<void>;

/**
 * 对长时间运行的应用工作流调用提供进程级监督。耐久工作流状态仍由工作流及其
 * 端口持有。
 */
export class ExecutionHost {
  private readonly graceMilliseconds: number;
  private readonly onGraceExpired: () => void;
  private accepting = true;
  private readonly active = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private readonly operationLeases = new Set<{
    registrationId?: string;
    registrationVersion?: number;
    generation: number;
    bindingSerial: number;
    readonly cancel: (reason: "shutdown" | "observed-root-invalidated") => void;
  }>();
  private readonly observedRootGenerations = new Map<
    string,
    { readonly generation: number; readonly keepVersion: number | undefined }
  >();

  constructor(
    options: {
      readonly graceMilliseconds?: number;
      readonly onGraceExpired?: () => void;
    } = {},
  ) {
    this.graceMilliseconds = options.graceMilliseconds ?? 30_000;
    if (!Number.isFinite(this.graceMilliseconds) || this.graceMilliseconds <= 0)
      throw new Error("执行服务关闭等待时间必须为正数");
    this.onGraceExpired = options.onGraceExpired ?? (() => undefined);
  }

  invoke(invocation: ExecutionInvocation): Promise<{ readonly id: string }> {
    if (!this.accepting)
      return Promise.reject(new Error("执行服务正在关闭，请稍后重试"));

    let announce!: (value: { readonly id: string }) => void;
    let rejectStart!: (error: unknown) => void;
    let announced = false;
    let declaredExecutionId: string | undefined;
    const started = new Promise<{ readonly id: string }>((resolve, reject) => {
      announce = resolve;
      rejectStart = reject;
    });
    const control: ExecutionInvocationControl = {
      executionStarted(executionId) {
        if (announced) {
          if (executionId !== declaredExecutionId)
            throw new Error("同一执行调用不能声明不同的刷新记录");
          return;
        }
        announced = true;
        declaredExecutionId = executionId;
        announce({ id: executionId });
      },
      safeCheckpoint: () => {
        if (!this.accepting) throw new StopAtSafeCheckpoint();
      },
    };

    const active = this.reserveActive();
    let work: Promise<void>;
    try {
      work = Promise.resolve(invocation(control));
    } catch (error) {
      rejectStart(error);
      active.release();
      return started;
    }
    void work
      .then(
        () => {
          if (!announced)
            rejectStart(new Error("执行未能建立可跟踪的刷新记录"));
        },
        (error: unknown) => {
          if (!announced) rejectStart(error);
          if (error instanceof StopAtSafeCheckpoint) return;
        },
      )
      .finally(active.release);
    return started;
  }

  /** 监督没有身份响应、且与交付层无关的工作。 */
  run<Result>(invocation: () => Result | Promise<Result>): Promise<Result> {
    return this.runWithControl(invocation);
  }

  runWithControl<Result>(
    invocation: (
      control: BackgroundExecutionControl,
    ) => Result | Promise<Result>,
  ): Promise<Result> {
    if (!this.accepting)
      return Promise.reject(new Error("执行服务正在关闭，请稍后重试"));
    const active = this.reserveActive();
    const control: BackgroundExecutionControl = {
      safeCheckpoint: () => {
        if (!this.accepting) throw new StopAtSafeCheckpoint();
      },
    };
    let work: Promise<Result>;
    try {
      work = Promise.resolve(invocation(control));
    } catch (error) {
      active.release();
      return Promise.reject(error);
    }
    const supervised = work.catch((error: unknown) => {
      if (error instanceof StopAtSafeCheckpoint) return undefined as Result;
      throw error;
    });
    void supervised.then(active.release, active.release);
    return supervised;
  }

  /** 短应用操作与现有宿主共用排空、关闭和取消生命周期。 */
  lease(
    input: {
      readonly registrationId?: string;
      readonly registrationVersion?: number;
    } = {},
  ): OperationLease {
    if (!this.accepting) throw new Error("执行服务正在关闭，请稍后重试");
    const observedState =
      input.registrationId === undefined
        ? undefined
        : this.observedRootGenerations.get(input.registrationId);
    if (
      input.registrationId !== undefined &&
      (input.registrationVersion === undefined ||
        (observedState !== undefined &&
          observedState.keepVersion !== input.registrationVersion))
    )
      throw new OperationLeaseInvalidated();
    const active = this.reserveActive();
    let cancelled = false;
    let cancellationReason: OperationCancellation["reason"];
    const listeners = new Set<() => void>();
    const entry = {
      ...input,
      generation: observedState?.generation ?? 0,
      bindingSerial: input.registrationId === undefined ? 0 : 1,
      cancel: (reason: "shutdown" | "observed-root-invalidated") => {
        if (cancelled) return;
        cancelled = true;
        cancellationReason = reason;
        for (const listener of listeners) listener();
      },
    };
    this.operationLeases.add(entry);
    let released = false;
    const bindObservedRoot = (coordinate: {
      readonly registrationId: string;
      readonly registrationVersion: number;
    }) => {
      if (released || cancelled) throw new OperationLeaseInvalidated();
      if (entry.registrationId !== undefined)
        throw new OperationLeaseInvalidated();
      const current = this.observedRootGenerations.get(
        coordinate.registrationId,
      );
      if (
        current !== undefined &&
        current.keepVersion !== coordinate.registrationVersion
      )
        throw new OperationLeaseInvalidated();
      entry.registrationId = coordinate.registrationId;
      entry.registrationVersion = coordinate.registrationVersion;
      entry.generation = current?.generation ?? 0;
      entry.bindingSerial += 1;
      const bindingSerial = entry.bindingSerial;
      let bindingReleased = false;
      return {
        release: () => {
          if (bindingReleased) return;
          bindingReleased = true;
          if (entry.bindingSerial !== bindingSerial) return;
          delete entry.registrationId;
          delete entry.registrationVersion;
          entry.generation = 0;
        },
      };
    };
    return {
      cancellation: {
        get cancelled() {
          return cancelled;
        },
        get reason() {
          return cancellationReason;
        },
        onCancel(listener) {
          listeners.add(listener);
          if (cancelled) listener();
          return () => listeners.delete(listener);
        },
      },
      bindObservedRoot,
      release: () => {
        if (released) return;
        released = true;
        this.operationLeases.delete(entry);
        active.release();
      },
    };
  }

  invalidateObservedRoot(input: {
    readonly registrationId: string;
    readonly keepVersion?: number;
  }): void {
    const previous = this.observedRootGenerations.get(input.registrationId);
    const generation = (previous?.generation ?? 0) + 1;
    this.observedRootGenerations.set(input.registrationId, {
      generation,
      keepVersion: input.keepVersion,
    });
    for (const lease of this.operationLeases) {
      if (lease.registrationId !== input.registrationId) continue;
      if (lease.generation >= generation) continue;
      if (
        input.keepVersion !== undefined &&
        lease.registrationVersion === input.keepVersion
      )
        continue;
      lease.cancel("observed-root-invalidated");
    }
  }

  private reserveActive(): { readonly release: () => void } {
    let resolve!: () => void;
    const settlement = new Promise<void>((settled) => {
      resolve = settled;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active.delete(settlement);
      resolve();
    };
    this.active.add(settlement);
    return { release };
  }

  close(): Promise<void> {
    this.accepting = false;
    for (const lease of this.operationLeases) lease.cancel("shutdown");
    this.closing ??= this.drainWithGraceNotification();
    return this.closing;
  }

  private async drainWithGraceNotification(): Promise<void> {
    if (this.active.size === 0) return;
    const timer = setTimeout(this.onGraceExpired, this.graceMilliseconds);
    try {
      await this.drain();
    } finally {
      clearTimeout(timer);
    }
  }

  private async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.all(this.active);
  }
}
