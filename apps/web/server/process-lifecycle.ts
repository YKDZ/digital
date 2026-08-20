export type ProcessShutdownReason = "replacement" | "terminal";

export type ProcessResourceOwner = {
  shutdown(reason: ProcessShutdownReason): Promise<void>;
};

export type ProcessLifecycleControl = {
  addSignalListener(
    signal: NodeJS.Signals,
    listener: () => void | Promise<void>,
  ): void;
  removeSignalListener(
    signal: NodeJS.Signals,
    listener: () => void | Promise<void>,
  ): void;
  resendSignal(signal: NodeJS.Signals): void;
  forceExit(code: number): void;
  reportShutdownError?(error: unknown): void;
};

export type ProcessOwnerRegistration = {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
};

export type ProcessLifecycleRegistry = {
  register(owner: ProcessResourceOwner): ProcessOwnerRegistration;
  assertMayStart(): void;
};

const signals = ["SIGINT", "SIGTERM"] as const;

export function createProcessLifecycleRegistry(
  control: ProcessLifecycleControl,
  options: { readonly terminalGraceMilliseconds?: number } = {},
): ProcessLifecycleRegistry {
  let current:
    | { readonly owner: ProcessResourceOwner; readonly identity: symbol }
    | undefined;
  let queue = Promise.resolve();
  let terminal = false;
  const terminalGraceMilliseconds = options.terminalGraceMilliseconds ?? 30_000;
  if (
    !Number.isFinite(terminalGraceMilliseconds) ||
    terminalGraceMilliseconds <= 0
  )
    throw new Error("进程关闭等待时间必须为正数");

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  };
  const closeOwner = async (
    owner: ProcessResourceOwner,
    reason: ProcessShutdownReason,
  ): Promise<void> => await owner.shutdown(reason);

  const handlers = new Map<NodeJS.Signals, () => Promise<void>>();
  for (const signal of signals) {
    const handler = async (): Promise<void> => {
      if (terminal) {
        control.forceExit(signal === "SIGINT" ? 130 : 143);
        return;
      }
      terminal = true;
      const exitCode = signal === "SIGINT" ? 130 : 143;
      const graceTimer = setTimeout(() => {
        // 工作活跃时 Persistence 仍由进程持有。终止超时后进程退出；不会在旧工作下
        // 关闭 SQLite。
        control.forceExit(exitCode);
      }, terminalGraceMilliseconds);
      graceTimer.unref();
      try {
        await enqueue(async () => {
          const owned = current;
          if (owned !== undefined) {
            try {
              await closeOwner(owned.owner, "terminal");
            } catch (error) {
              control.reportShutdownError?.(error);
            }
            if (current?.identity === owned.identity) current = undefined;
          }
        });
      } catch (error) {
        control.reportShutdownError?.(error);
      } finally {
        clearTimeout(graceTimer);
        for (const [registeredSignal, registeredHandler] of handlers) {
          control.removeSignalListener(registeredSignal, registeredHandler);
        }
        control.resendSignal(signal);
      }
    };
    handlers.set(signal, handler);
    control.addSignalListener(signal, handler);
  }

  return {
    register(owner) {
      const identity = Symbol("process-resource-owner");
      const ready = enqueue(async () => {
        if (terminal) throw new Error("进程正在关闭，不能启动内容目录");
        const previous = current;
        if (previous !== undefined) {
          await closeOwner(previous.owner, "replacement");
          if (current?.identity === previous.identity) current = undefined;
        }
        if (terminal) throw new Error("进程正在关闭，不能启动内容目录");
        current = { owner, identity };
      });
      return {
        ready,
        async dispose() {
          await ready.catch(() => undefined);
          await enqueue(async () => {
            if (current?.identity !== identity) return;
            await closeOwner(owner, "replacement");
            if (current?.identity === identity) current = undefined;
          });
        },
      };
    },
    assertMayStart() {
      if (terminal) throw new Error("进程正在关闭，不能启动内容目录");
    },
  };
}

const registrySymbol = Symbol.for("digital.web.process-lifecycle");
const processGlobal = globalThis as typeof globalThis & {
  [registrySymbol]?: ProcessLifecycleRegistry;
};

export const processLifecycle =
  processGlobal[registrySymbol] ??
  (processGlobal[registrySymbol] = createProcessLifecycleRegistry(
    {
      addSignalListener(signal, listener) {
        process.on(signal, listener);
      },
      removeSignalListener(signal, listener) {
        process.off(signal, listener);
      },
      resendSignal(signal) {
        process.kill(process.pid, signal);
      },
      forceExit(code) {
        process.exit(code);
      },
      reportShutdownError(error) {
        console.error("内容目录未能正常关闭", error);
      },
    },
    {
      terminalGraceMilliseconds: Number(
        process.env.DIGITAL_PROCESS_SHUTDOWN_GRACE_MILLISECONDS ?? 30_000,
      ),
    },
  ));
