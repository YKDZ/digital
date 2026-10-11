import { AsyncLocalStorage } from "node:async_hooks";

export type WorkflowInvocationLifecycle<Checkpoint> = {
  readonly onCheckpoint?: ((checkpoint: Checkpoint) => void) | undefined;
  readonly onHostCheckpoint?: ((checkpoint: Checkpoint) => void) | undefined;
};

export class WorkflowLifecycleInterruption extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

export function notifyWorkflowCheckpoint<Checkpoint>(
  lifecycle: WorkflowInvocationLifecycle<Checkpoint>,
  checkpoint: Checkpoint,
  notifyCaller = true,
): void {
  try {
    if (notifyCaller) lifecycle.onCheckpoint?.(checkpoint);
    lifecycle.onHostCheckpoint?.(checkpoint);
  } catch (error) {
    throw new WorkflowLifecycleInterruption(error);
  }
}

export function rethrowWorkflowLifecycle(error: unknown): void {
  if (error instanceof WorkflowLifecycleInterruption) throw error;
}

// 内部目录新扫描和续跑都可能再次经过公开接缝：wrapper 须留到最外调用，
// 父账本才能把生命周期中断与真正的目录失败分开。
const publicWorkflowInvocation = new AsyncLocalStorage<boolean>();

export async function atPublicWorkflowBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  if (publicWorkflowInvocation.getStore() === true) return await operation();
  return await publicWorkflowInvocation.run(true, async () => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WorkflowLifecycleInterruption) throw error.cause;
      throw error;
    }
  });
}
