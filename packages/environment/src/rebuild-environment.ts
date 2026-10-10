import { runRebuildUnderLock } from "./internal/locked-operation.ts";
import {
  invalidEnvironmentFacts,
  noRunFacts,
  type RebuildOperationResult,
  type RebuildRequest,
} from "./internal/operation-contract.ts";
import { resolveWorkspacePath } from "./internal/paths.ts";

export type { RebuildOperationResult } from "./internal/operation-contract.ts";

/**
 * 显式重建一个已停止的所选环境：保留普通 inputs、来源模式与运行配置，回收该环境
 * 自有的产品数据根，再从空根走与准备完全相同的正式构建、正式迁移与正式读取，成功
 * 后发布新的数据世代初态。运行中、启动中、停止未确认、归属不明或存在未收敛的删除
 * 意图都拒绝改动；绝不扫描输入、不接入资料、不写业务表。
 */
export async function rebuildEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<RebuildOperationResult> {
  const invalid = (message: string): RebuildOperationResult => ({
    kind: "rebuild",
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
  const request: RebuildRequest = {
    kind: "rebuild",
    workspacePath,
    environment: input.environment,
  };
  return await runRebuildUnderLock(request);
}
