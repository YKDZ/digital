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

export async function atPublicWorkflowBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkflowLifecycleInterruption) throw error.cause;
    throw error;
  }
}
