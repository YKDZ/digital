import { closeWebProcessTemporaryRoot } from "./process-temporary-root.ts";

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
  forceExit(code: number): void;
  reportShutdownError?(error: unknown): void;
};

export type ProcessOwnerRegistration = {
  readonly ready: Promise<void>;
  publish(): void;
  abort(): Promise<void>;
  dispose(): Promise<void>;
};

export type ProcessLifecycleRegistry = {
  register(owner: ProcessResourceOwner): ProcessOwnerRegistration;
  assertMayStart(): void;
  hasCleanupIncomplete(error: unknown): boolean;
};

const signals = ["SIGINT", "SIGTERM"] as const;

export function createProcessLifecycleRegistry(
  control: ProcessLifecycleControl,
  options: {
    readonly terminalGraceMilliseconds?: number;
    readonly closeTerminalProcessResources?: () => Promise<void>;
  } = {},
): ProcessLifecycleRegistry {
  type Owned = {
    readonly owner: ProcessResourceOwner;
    readonly identity: symbol;
    state: "candidate" | "current" | "debt" | "closed";
  };
  let current: Owned | undefined;
  let reservation: Owned | undefined;
  const candidates = new Set<Owned>();
  const cleanupDebts = new Set<Owned>();
  const failedOwners = new Set<Owned>();
  const cleanupEvidence = new WeakMap<object, ReadonlySet<Owned>>();
  let queue = Promise.resolve();
  let terminal = false;
  let exitRequested = false;
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
    owned: Owned,
    reason: ProcessShutdownReason,
  ): Promise<void> => {
    try {
      await owned.owner.shutdown(reason);
    } catch (error) {
      failedOwners.add(owned);
      if (owned.state === "candidate") {
        candidates.delete(owned);
        owned.state = "debt";
        cleanupDebts.add(owned);
      }
      throw error;
    }
    failedOwners.delete(owned);
    if (current?.identity === owned.identity) current = undefined;
    candidates.delete(owned);
    cleanupDebts.delete(owned);
    owned.state = "closed";
  };
  const makeCleanupIncomplete = (
    errors: readonly unknown[],
  ): AggregateError => {
    const failure = new AggregateError(errors, "Web 产品所有者清理未完成");
    cleanupEvidence.set(failure, new Set(failedOwners));
    return failure;
  };
  const hasCleanupIncomplete = (error: unknown): boolean => {
    const visited = new WeakSet<object>();
    const visit = (candidate: unknown): boolean => {
      if (
        (typeof candidate !== "object" && typeof candidate !== "function") ||
        candidate === null ||
        visited.has(candidate)
      )
        return false;
      visited.add(candidate);
      const owners = cleanupEvidence.get(candidate);
      if (
        owners !== undefined &&
        [...owners].some((owner) => failedOwners.has(owner))
      )
        return true;
      return (
        candidate instanceof AggregateError && candidate.errors.some(visit)
      );
    };
    return visit(error);
  };
  const closeMany = async (
    owners: readonly Owned[],
    reason: ProcessShutdownReason,
  ): Promise<unknown[]> => {
    const errors: unknown[] = [];
    for (const owned of owners) {
      try {
        await closeOwner(owned, reason);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };
  const exitOnce = (code: number): void => {
    if (exitRequested) return;
    exitRequested = true;
    control.forceExit(code);
  };

  const handlers = new Map<NodeJS.Signals, () => Promise<void>>();
  for (const signal of signals) {
    const handler = async (): Promise<void> => {
      if (terminal) {
        exitOnce(signal === "SIGINT" ? 130 : 143);
        return;
      }
      terminal = true;
      const exitCode = signal === "SIGINT" ? 130 : 143;
      const graceTimer = setTimeout(() => {
        // 工作活跃时 Persistence 仍由进程持有。终止超时后进程退出；不会在旧工作下
        // 关闭 SQLite。
        exitOnce(exitCode);
      }, terminalGraceMilliseconds);
      graceTimer.unref();
      try {
        await enqueue(async () => {
          const errors = await closeMany(
            [
              ...(current === undefined ? [] : [current]),
              ...cleanupDebts,
              ...candidates,
            ],
            "terminal",
          );
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1)
            throw new AggregateError(errors, "Web 产品所有者终止清理未完成");
        });
        await (
          options.closeTerminalProcessResources ?? closeWebProcessTemporaryRoot
        )();
      } catch (error) {
        control.reportShutdownError?.(error);
      } finally {
        clearTimeout(graceTimer);
        for (const [registeredSignal, registeredHandler] of handlers) {
          control.removeSignalListener(registeredSignal, registeredHandler);
        }
        exitOnce(exitCode);
      }
    };
    handlers.set(signal, handler);
    control.addSignalListener(signal, handler);
  }

  return {
    register(owner) {
      if (terminal) throw new Error("进程正在关闭，不能启动内容目录");
      const identity = Symbol("process-resource-owner");
      const candidate: Owned = {
        owner,
        identity,
        state: "candidate",
      };
      candidates.add(candidate);
      let status: "pending" | "ready" | "published" | "aborting" | "failed" =
        "pending";
      let resolveReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      let resolveDecision!: (decision: "publish" | "abort") => void;
      const decision = new Promise<"publish" | "abort">((resolve) => {
        resolveDecision = resolve;
      });
      const isAborting = (): boolean => status === "aborting";
      let finalCleanupFailure: AggregateError | undefined;
      const closeAbortedCandidate = async (
        precedingErrors: readonly unknown[] = [],
      ): Promise<void> => {
        const errors = [...precedingErrors];
        try {
          await closeOwner(candidate, terminal ? "terminal" : "replacement");
        } catch (error) {
          errors.push(error);
        }
        status = "failed";
        if (errors.length > 0) {
          const failure = makeCleanupIncomplete(errors);
          finalCleanupFailure = failure;
          rejectReady(failure);
          throw failure;
        }
        rejectReady(new Error("进程产品登记已中止"));
      };
      const completion = enqueue(async () => {
        if (isAborting()) {
          await closeAbortedCandidate();
          return;
        }
        const admissionErrors: unknown[] = [];
        if (!terminal) {
          admissionErrors.push(
            ...(await closeMany([...cleanupDebts], "replacement")),
          );
          if (isAborting()) {
            await closeAbortedCandidate(admissionErrors);
            return;
          }
          if (admissionErrors.length === 0 && current !== undefined) {
            // shutdown 一旦调用便不可撤销；期间到达的 abort 只能在它返回后关闭候选。
            try {
              await closeOwner(current, "replacement");
            } catch (error) {
              admissionErrors.push(error);
            }
          }
        }
        const terminalError = terminal
          ? new Error("进程正在关闭，不能启动内容目录")
          : undefined;
        if (admissionErrors.length > 0 || terminalError !== undefined) {
          const abortRequested = isAborting();
          const errors = [
            ...admissionErrors,
            ...(terminalError === undefined ? [] : [terminalError]),
          ];
          try {
            await closeOwner(candidate, terminal ? "terminal" : "replacement");
          } catch (error) {
            errors.push(error);
          }
          const cleanupFailure =
            admissionErrors.length > 0 || candidate.state === "debt"
              ? makeCleanupIncomplete(errors)
              : undefined;
          const failure = cleanupFailure ?? terminalError;
          rejectReady(failure);
          finalCleanupFailure = cleanupFailure;
          status = "failed";
          if (abortRequested && cleanupFailure !== undefined)
            throw cleanupFailure;
          return;
        }
        if (isAborting()) {
          await closeAbortedCandidate();
          return;
        }
        reservation = candidate;
        status = "ready";
        resolveReady();
        const outcome = await decision;
        if (outcome === "publish") return;
        if (reservation?.identity === identity) reservation = undefined;
        try {
          await closeOwner(candidate, terminal ? "terminal" : "replacement");
        } catch (error) {
          throw makeCleanupIncomplete([error]);
        }
      });
      void completion.catch(() => undefined);
      let aborting: Promise<void> | undefined;
      return {
        ready,
        publish() {
          if (status === "published") return;
          if (status !== "ready" || reservation?.identity !== identity)
            throw new Error("进程产品登记尚未取得发布权");
          if (terminal) throw new Error("进程正在关闭，不能发布内容目录");
          candidates.delete(candidate);
          candidate.state = "current";
          current = candidate;
          reservation = undefined;
          status = "published";
          resolveDecision("publish");
        },
        abort() {
          if (aborting !== undefined) return aborting;
          if (status === "failed") {
            if (finalCleanupFailure === undefined) return Promise.resolve();
            aborting = Promise.reject(finalCleanupFailure);
            return aborting;
          }
          if (status === "published") {
            status = "aborting";
            aborting = enqueue(async () => {
              if (candidate.state === "closed") return;
              try {
                await closeOwner(candidate, "replacement");
              } catch (error) {
                throw makeCleanupIncomplete([error]);
              }
            });
            return aborting;
          }
          if (status !== "pending" && status !== "ready")
            return Promise.reject(new Error("进程产品登记不能再次中止"));
          status = "aborting";
          resolveDecision("abort");
          aborting = completion;
          return aborting;
        },
        dispose() {
          return this.abort();
        },
      };
    },
    assertMayStart() {
      if (terminal) throw new Error("进程正在关闭，不能启动内容目录");
    },
    hasCleanupIncomplete,
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
