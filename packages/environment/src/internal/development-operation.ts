import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  developmentSessionProblem,
  type DevelopmentSessionRecord,
} from "./development-state.ts";
import { directoryIdentity, saveRecord } from "./operation-support.ts";
import { createLayout, createPrivateRunDirectory } from "./paths.ts";
import {
  observeProcessLifecycle,
  type ProcessIdentity,
} from "./process-identity.ts";
import { readRecord } from "./record.ts";

export type DevelopmentRequest = {
  readonly workspacePath: string;
  readonly environment: string;
  readonly sessionId: string;
} & (
  | { readonly action: "begin"; readonly session: DevelopmentSessionRecord }
  | { readonly action: "watcher"; readonly watcher: ProcessIdentity }
  | {
      readonly action: "update";
      readonly update: DevelopmentSessionRecord["update"];
      readonly failure?: string;
      readonly taskHash?: string;
    }
  | { readonly action: "finish" }
  | { readonly action: "watch-settled" }
);
export type DevelopmentOperationResult = {
  readonly status: "ok" | "refused";
  readonly session?: DevelopmentSessionRecord;
  readonly failure?: string;
};

/** 调用方经既有环境 flock 进入；不持锁覆盖 Turbo watch 的等待期。 */
export async function runDevelopmentOperation(
  request: DevelopmentRequest,
): Promise<DevelopmentOperationResult> {
  const refused = (failure: string): DevelopmentOperationResult => ({
    status: "refused",
    failure,
  });
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout) return refused(layout.reason);
  const read = await readRecord(layout.recordPath);
  if (read.kind !== "record") return refused("开发会话要求现有完整准备记录");
  const record = read.record;
  const container = await directoryIdentity(layout.containerDirectory);
  if (
    container?.device !== record.containerIdentity.device ||
    container.inode !== record.containerIdentity.inode ||
    record.workspacePath !== layout.workspacePath ||
    record.environment !== layout.environment
  )
    return refused("环境容器归属无法确认");
  let session: DevelopmentSessionRecord;
  if (request.action === "begin") {
    if (
      record.preparation.state !== "prepared" ||
      record.destructive !== undefined
    )
      return refused("环境尚未准备或有未收敛的破坏性意图");
    if (
      record.development !== undefined &&
      record.development.state !== "ended"
    )
      return refused("现有开发会话尚未确认结束；请先使用独立 stop 收尾");
    if (record.run !== undefined && record.run.state !== "stopped")
      return refused("请先停止现有服务再进入开发会话");
    const problem = developmentSessionProblem(request.session);
    if (problem !== undefined) return refused(problem);
    session = request.session;
    if (session.sessionId !== request.sessionId || session.state !== "active")
      return refused("开发会话启动意图不一致");
    const expected = createPrivateRunDirectory(
      layout.workspacePath,
      record.environmentId,
      session.sessionId,
    );
    if (
      "reason" in expected ||
      expected.directory !== session.privateDirectory ||
      session.controlSocket !==
        path.join(session.privateDirectory, "control.sock") ||
      session.controlConfigFile !==
        path.join(session.privateDirectory, "development.json")
    )
      return refused("开发会话私有现场不属于本环境");
    const identity = await lstat(session.privateDirectory);
    if (
      !identity.isDirectory() ||
      identity.dev !== session.privateIdentity.device ||
      identity.ino !== session.privateIdentity.inode ||
      identity.uid !== process.getuid?.() ||
      (identity.mode & 0o777) !== 0o700
    )
      return refused("开发会话私有目录身份不成立");
    const config = JSON.parse(
      await readFile(session.controlConfigFile, "utf8"),
    ) as { sessionId?: string; environmentId?: string };
    if (
      config.sessionId !== session.sessionId ||
      config.environmentId !== record.environmentId ||
      observeProcessLifecycle(session.owner) !== "alive"
    )
      return refused("开发会话调用方身份不成立");
  } else {
    const existing = record.development;
    if (existing === undefined || existing.sessionId !== request.sessionId)
      return refused("开发会话引用已失效");
    session = existing;
    if (
      request.action !== "finish" &&
      request.action !== "watch-settled" &&
      session.state !== "active"
    )
      return refused("开发会话已在结束，不再允许更新或启动");
    if (request.action === "watcher")
      session = { ...session, watcher: request.watcher, watchPending: false };
    if (request.action === "update") {
      if (
        request.update === "ready" &&
        (record.run?.state !== "ready" || record.run.runtime !== "development")
      )
        return refused("新开发世代没有通过正式就绪协议");
      const { failure: _previousFailure, ...remaining } = session;
      session = {
        ...remaining,
        update: request.update,
        ...(request.failure === undefined ? {} : { failure: request.failure }),
        ...(request.update === "ready" && request.taskHash !== undefined
          ? { taskHash: request.taskHash }
          : {}),
        ...(request.update === "ready" && record.run !== undefined
          ? { runId: record.run.runId }
          : {}),
      };
    }
    if (request.action === "watch-settled")
      session = { ...session, watchPending: false };
    if (request.action === "finish") {
      if (session.watchPending)
        return refused("Turbo watch 启动仍在途，不能把空已持有集合当成已结束");
      if (record.run !== undefined && record.run.state !== "stopped")
        return refused("产品世代尚未确认停止");
      if (
        session.watcher !== undefined &&
        observeProcessLifecycle(session.watcher) !== "exited"
      )
        return refused("Turbo watch 尚未确认退出");
      session = { ...session, state: "ended" };
    }
  }
  session = { ...session, updatedAt: new Date().toISOString() };
  const problem = await saveRecord(layout.recordPath, {
    ...record,
    development: session,
  });
  return problem === undefined
    ? { status: "ok", session }
    : refused(`开发会话记录无法保存：${problem}`);
}
