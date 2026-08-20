export type WorkflowInvocationLifecycle<Checkpoint> = {
  readonly onCheckpoint?: (checkpoint: Checkpoint) => void;
  readonly onHostCheckpoint?: (checkpoint: Checkpoint) => void;
};

export class WorkflowLifecycleInterruption extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
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
