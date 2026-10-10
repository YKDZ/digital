import { runDeleteUnderLock } from "./internal/locked-operation.ts";
import {
  invalidEnvironmentFacts,
  noRunFacts,
  type DeleteOperationResult,
  type DeleteRequest,
} from "./internal/operation-contract.ts";
import { resolveWorkspacePath } from "./internal/paths.ts";

export type { DeleteOperationResult } from "./internal/operation-contract.ts";

/**
 * 删除一个已停止的所选环境：只回收该环境自有的记录、日志、产品数据与私有运行现场，
 * 全部确认回收后才移除环境记录；重复删除给出明确的已删除。运行中、启动中、停止未
 * 确认、身份未知或归属不明一律拒绝破坏，绝不按 PID 或端口猜测接管，也不触碰输入素材、
 * 其他环境或工作区管理级锁文件。
 */
export async function deleteEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<DeleteOperationResult> {
  const invalid = (message: string): DeleteOperationResult => ({
    kind: "delete",
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
  const request: DeleteRequest = {
    kind: "delete",
    workspacePath,
    environment: input.environment,
  };
  return await runDeleteUnderLock(request);
}
