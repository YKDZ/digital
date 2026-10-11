import {
  type ProcessIdentity,
  processIdentityProblem,
} from "./process-identity.ts";

/** 开发会话只保有调用方归属和更新意图，不含产品业务状态。 */
export type DevelopmentSessionRecord = {
  readonly sessionId: string;
  readonly state: "active" | "ending" | "ended";
  readonly update: "starting" | "updating" | "failed" | "ready";
  readonly updatedAt: string;
  readonly owner: ProcessIdentity;
  readonly watcher?: ProcessIdentity;
  readonly watchPending: boolean;
  readonly privateDirectory: string;
  readonly privateIdentity: { readonly device: number; readonly inode: number };
  readonly controlSocket: string;
  readonly controlConfigFile: string;
  readonly logFile: string;
  readonly runId?: string;
  /** Turbo 完整任务图的版本；只用于识别已就绪世代。 */
  readonly taskHash?: string;
  readonly failure?: string;
};

export function developmentSessionProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "开发会话不是对象";
  const session = value as Record<string, unknown>;
  for (const field of [
    "sessionId",
    "updatedAt",
    "privateDirectory",
    "controlSocket",
    "controlConfigFile",
    "logFile",
  ])
    if (typeof session[field] !== "string" || session[field].length === 0)
      return `开发会话缺少 ${field}`;
  if (!["active", "ending", "ended"].includes(String(session.state)))
    return "开发会话停止意图未知";
  if (
    !["starting", "updating", "failed", "ready"].includes(
      String(session.update),
    )
  )
    return "开发会话更新状态未知";
  if (typeof session.watchPending !== "boolean")
    return "开发会话缺少在途watch启动事实";
  const ownerProblem = processIdentityProblem(session.owner);
  if (ownerProblem !== undefined) return ownerProblem;
  if (session.watcher !== undefined) {
    const watcherProblem = processIdentityProblem(session.watcher);
    if (watcherProblem !== undefined) return watcherProblem;
  }
  const identity = session.privateIdentity as
    | Record<string, unknown>
    | undefined;
  if (
    identity === undefined ||
    typeof identity.device !== "number" ||
    typeof identity.inode !== "number"
  )
    return "开发会话缺少私有目录身份";
  if (session.runId !== undefined && typeof session.runId !== "string")
    return "开发会话世代引用无效";
  if (session.taskHash !== undefined && typeof session.taskHash !== "string")
    return "开发任务版本无效";
  if (session.failure !== undefined && typeof session.failure !== "string")
    return "开发会话失败原因无效";
  return undefined;
}
