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
