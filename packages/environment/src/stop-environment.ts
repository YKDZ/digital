import { runStopUnderLock } from "./internal/locked-operation.ts";
import {
  invalidEnvironmentFacts,
  noRunFacts,
  type StopOperationResult,
  type StopRequest,
} from "./internal/operation-contract.ts";
import { resolveWorkspacePath } from "./internal/paths.ts";

export type { StopOperationResult } from "./internal/operation-contract.ts";

/**
 * 停止已准备环境当前登记的运行世代。只通过经认证的私有控制通道请求该世代自行
 * 收到一次 SIGTERM，并尊重产品自身宽限；无法确认退出时保留现场与秘密，绝不按
 * PID 或端口猜测接管，也不删除任何产品数据、配置或日志。
 */
export async function stopEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<StopOperationResult> {
  const invalid = (message: string): StopOperationResult => ({
    kind: "stop",
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
  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(input.workspacePath);
  } catch {
    return invalid(`工作区路径不存在或不可解析：${input.workspacePath}`);
  }
  const request: StopRequest = {
    kind: "stop",
    workspacePath,
    environment: input.environment,
  };
  return await runStopUnderLock(request);
}
