import path from "node:path";

import { runPrepareUnderLock } from "./internal/locked-operation.ts";
import {
  invalidEnvironmentFacts,
  publicCancellationProblem,
  resolveDeadlineAt,
  type KernelCancellation,
  type PrepareOperationResult,
  type PrepareRequest,
} from "./internal/operation-contract.ts";
import { resolveWorkspacePath } from "./internal/paths.ts";
import type { JsonValue } from "./internal/record.ts";

export type PrepareEnvironmentRequest = {
  /** 显式工作区绝对路径；环境身份由 realpath 后的工作区路径与环境名共同选定。 */
  readonly workspacePath: string;
  readonly environment: string;
  /** 普通素材目录列表（绝对路径）；只记录归属，不复制素材。 */
  readonly inputs?: readonly string[];
  /**
   * 来源装配选择：offline（缺省，无清单，产品世代得到全拒绝的来源依赖）、
   * controlled（必须同时在 config.sourceIo 给出调用方选择的清单绝对路径与 sha256
   * 内容身份）或 real。缺省不等于未选择：环境总会把所选模式显式传给产品进程。
   */
  readonly sourceMode?: string;
  /** 非秘密运行配置；秘密应另行按次传入，不写入持久记录。 */
  readonly config?: { readonly [key: string]: JsonValue };
  /**
   * 本次准备的取消条件：`signal` 由调用方持有，`timeoutMs` 是本次操作的期限。
   * 取消只中止本次有界操作，不会跳过本次已持有资源的收尾。
   */
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
};

export type { JsonValue };

export type {
  EnvironmentFacts,
  PrepareCleanup,
  PrepareFailure,
  PrepareLogs,
  PrepareOperationResult,
} from "./internal/operation-contract.ts";

/**
 * 为选定环境构建真实产品交付目标、执行正式迁移并通过正式产品读取核验，
 * 得到明确区分的准备结果。已准备从不等于服务就绪。
 */
export async function prepareEnvironment(
  request: PrepareEnvironmentRequest,
): Promise<PrepareOperationResult> {
  const invalid = (message: string): PrepareOperationResult => ({
    kind: "prepare",
    status: "invalid-request",
    environment: invalidEnvironmentFacts(
      request.workspacePath ?? "",
      request.environment ?? "",
    ),
    failure: { stage: "request", message, exitCode: null },
    cleanup: { state: "not-started", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  });
  if (
    typeof request.workspacePath !== "string" ||
    request.workspacePath.length === 0
  )
    return invalid("必须提供显式工作区绝对路径");
  if (
    typeof request.environment !== "string" ||
    request.environment.length === 0
  )
    return invalid("必须提供环境名");
  if (
    request.config !== undefined &&
    (typeof request.config !== "object" ||
      request.config === null ||
      Array.isArray(request.config))
  )
    return invalid("运行配置必须是 JSON 对象");
  const cancellationProblem = publicCancellationProblem({
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  });
  if (cancellationProblem !== undefined) return invalid(cancellationProblem);
  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(request.workspacePath);
  } catch {
    return invalid(`工作区路径不存在或不可解析：${request.workspacePath}`);
  }
  const payload: PrepareRequest = {
    kind: "prepare",
    workspacePath,
    environment: request.environment,
    inputs: (request.inputs ?? []).map((input) =>
      path.isAbsolute(input) ? input : path.resolve(workspacePath, input),
    ),
    sourceMode: request.sourceMode ?? "offline",
    config: request.config ?? {},
  };
  const cancellation: KernelCancellation = {
    signal: request.signal,
    deadlineAt: resolveDeadlineAt({ timeoutMs: request.timeoutMs }),
  };
  return await runPrepareUnderLock(payload, cancellation);
}
