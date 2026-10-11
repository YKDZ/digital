import { runStartUnderLock } from "./internal/locked-operation.ts";
import {
  invalidEnvironmentFacts,
  noRunFacts,
  publicCancellationProblem,
  resolveDeadlineAt,
  type KernelCancellation,
  type StartOperationResult,
  type StartRequest,
} from "./internal/operation-contract.ts";
import { resolveWorkspacePath } from "./internal/paths.ts";

export type {
  EnvironmentRunFacts,
  ProcessLiveness,
  RunObservation,
  StartOperationResult,
} from "./internal/operation-contract.ts";

/**
 * 启动已准备环境的真实产品 Web 服务。只有本世代同时通过私有控制认证与真实
 * `/api/ready` 签名证明才报告就绪；已就绪的同一世代返回同一标识与地址，不创建
 * 第二个进程，也无法确认时绝不猜测接管。
 */
export async function startEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
  /** 开发入口与生产入口明确区分；切换入口前必须显式停止现有世代。 */
  readonly runtime?: "production" | "development";
  /** 仅由当前开发会话包装持有，迟到包装不能复活已结束的会话。 */
  readonly developmentSession?: string;
  /**
   * 本次启动的取消条件：`signal` 由调用方持有，`timeoutMs` 是本次操作的期限。
   * 取消只中止本次尚未发布的等待，绝不撤销已发布并成功应答的世代。
   */
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<StartOperationResult> {
  const invalid = (message: string): StartOperationResult => ({
    kind: "start",
    status: "invalid-request",
    environment: invalidEnvironmentFacts(
      input.workspacePath ?? "",
      input.environment ?? "",
    ),
    run: noRunFacts,
    failure: { stage: "request", message, exitCode: null },
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  });
  if (
    typeof input.workspacePath !== "string" ||
    input.workspacePath.length === 0
  )
    return invalid("必须提供显式工作区绝对路径");
  if (typeof input.environment !== "string" || input.environment.length === 0)
    return invalid("必须提供环境名");
  const cancellationProblem = publicCancellationProblem({
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  if (cancellationProblem !== undefined) return invalid(cancellationProblem);
  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(input.workspacePath);
  } catch {
    return invalid(`工作区路径不存在或不可解析：${input.workspacePath}`);
  }
  const request: StartRequest = {
    kind: "start",
    runtime: input.runtime ?? "production",
    ...(input.developmentSession === undefined
      ? {}
      : { developmentSession: input.developmentSession }),
    workspacePath,
    environment: input.environment,
  };
  const cancellation: KernelCancellation = {
    signal: input.signal,
    deadlineAt: resolveDeadlineAt({ timeoutMs: input.timeoutMs }),
  };
  return await runStartUnderLock(request, cancellation);
}
