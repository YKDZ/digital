/**
 * 取消只作用于当前有界操作的执行条件：期限到期或操作进程被要求终止。清理不使用这个
 * 条件，而是各自有界的等待，因此取消永远不会跳过收尾。
 */
export type OperationCancellation = {
  readonly triggered: () => boolean;
  /** 已成立时如实说明观察到的取消来源；未成立时为空字符串。 */
  readonly reason: () => string;
  /**
   * 让一个仍在执行的等待在取消成立时先交出「已取消」分支。被让开的原等待继续自行走到
   * 有界终点，其结果被如实丢弃，而不是被伪造。
   */
  readonly watch: <T>(
    pending: Promise<T>,
  ) => Promise<
    | { readonly cancelled: false; readonly value: T }
    | { readonly cancelled: true }
  >;
  /** 取消成立时回调一次；已经成立时立即回调。 */
  readonly onTrigger: (listener: (reason: string) => void) => () => void;
  readonly dispose: () => void;
};

const terminateSignals = ["SIGINT", "SIGTERM"] as const;

/** 在持锁操作进程内建立本次操作的取消条件。 */
export function createOperationCancellation(input: {
  readonly deadlineAt: number | undefined;
}): OperationCancellation {
  const listeners = new Set<(reason: string) => void>();
  let reason = "";

  const triggerListeners = (cause: string): void => {
    for (const listener of listeners) {
      listeners.delete(listener);
      listener(cause);
    }
  };
  const trigger = (cause: string): void => {
    if (reason.length > 0) return;
    reason = cause;
    triggerListeners(cause);
  };

  const timer =
    input.deadlineAt === undefined
      ? undefined
      : setTimeout(
          () => {
            trigger(
              `操作期限到期（约定终点 ${new Date(input.deadlineAt as number).toISOString()} UTC）`,
            );
          },
          Math.max(0, input.deadlineAt - Date.now()),
        );
  timer?.unref();

  const onSignal = (signal: NodeJS.Signals): void => {
    trigger(`操作进程收到 ${signal}`);
  };
  for (const signal of terminateSignals) process.on(signal, onSignal);

  return {
    triggered: () => reason.length > 0,
    reason: () => reason,
    onTrigger: (listener) => {
      if (reason.length > 0) {
        listener(reason);
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch: <T>(
      pending: Promise<T>,
    ): Promise<
      | { readonly cancelled: false; readonly value: T }
      | { readonly cancelled: true }
    > =>
      new Promise((resolve, reject) => {
        let settled = false;
        const off = (): void => {
          listeners.delete(onCancel);
        };
        const onCancel = (): void => {
          if (settled) return;
          settled = true;
          off();
          resolve({ cancelled: true });
        };
        if (reason.length > 0) {
          resolve({ cancelled: true });
          return;
        }
        listeners.add(onCancel);
        pending.then(
          (value) => {
            if (settled) return;
            settled = true;
            off();
            resolve({ cancelled: false, value });
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            off();
            reject(error);
          },
        );
      }),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const signal of terminateSignals)
        process.removeListener(signal, onSignal);
      listeners.clear();
    },
  };
}
