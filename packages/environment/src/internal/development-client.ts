import { spawn } from "node:child_process";
import { lstat, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DevelopmentOperationResult,
  DevelopmentRequest,
} from "./development-operation.ts";
import type { DevelopmentSessionRecord } from "./development-state.ts";
import { createLayout, createPrivateRunDirectory } from "./paths.ts";
import { requestPrivateControl } from "./private-control.ts";
import {
  observeProcessIdentity,
  observeProcessLifecycle,
  sameProcessIdentity,
} from "./process-identity.ts";
import { filteredEnvironment } from "./processes.ts";
import { readRecord, type EnvironmentRecord } from "./record.ts";

/** 只传递有限开发会话命令；锁仍为既有环境锁。 */
export async function developmentSessionCommand(
  request: DevelopmentRequest,
): Promise<DevelopmentOperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout) return { status: "refused", failure: layout.reason };
  const extension =
    path.extname(fileURLToPath(import.meta.url)) === ".ts" ? "ts" : "js";
  const child = spawn(
    "flock",
    [
      "--no-fork",
      layout.lockPath,
      process.execPath,
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        `development-operation-entry.${extension}`,
      ),
      JSON.stringify(request),
    ],
    {
      cwd: layout.workspacePath,
      env: filteredEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < 1_000_000) stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 4000) stderr += chunk;
  });
  const failure = await new Promise<string | undefined>((resolve) => {
    child.once("error", (error) => resolve(error.message));
    child.once("close", () => resolve(undefined));
  });
  const line = stdout
    .split("\n")
    .find((value) => value.startsWith("DIGITAL_DEVELOPMENT_RESULT "));
  if (line === undefined)
    return {
      status: "refused",
      failure: failure ?? stderr ?? "开发会话操作未交出结果",
    };
  return JSON.parse(
    line.slice("DIGITAL_DEVELOPMENT_RESULT ".length),
  ) as DevelopmentOperationResult;
}

export async function verifyDevelopmentControl(
  record: EnvironmentRecord,
): Promise<
  { controlKey: string; session: DevelopmentSessionRecord } | { reason: string }
> {
  const session = record.development;
  if (session === undefined) return { reason: "没有开发会话" };
  const expected = createPrivateRunDirectory(
    record.workspacePath,
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
    return { reason: "开发会话控制现场归属不成立" };
  try {
    const info = await lstat(session.privateDirectory);
    if (
      !info.isDirectory() ||
      info.dev !== session.privateIdentity.device ||
      info.ino !== session.privateIdentity.inode ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      return { reason: "开发会话私有目录身份不成立" };
    const configInfo = await lstat(session.controlConfigFile);
    if (
      !configInfo.isFile() ||
      configInfo.uid !== info.uid ||
      (configInfo.mode & 0o777) !== 0o600
    )
      return { reason: "开发会话控制配置归属不成立" };
    const value: unknown = JSON.parse(
      await readFile(session.controlConfigFile, "utf8"),
    );
    if (typeof value !== "object" || value === null)
      return { reason: "开发会话控制配置无效" };
    const config = value as Record<string, unknown>;
    if (
      config.sessionId !== session.sessionId ||
      config.environmentId !== record.environmentId ||
      typeof config.controlKey !== "string" ||
      config.controlKey.length < 32
    )
      return { reason: "开发会话控制身份不一致" };
    return { session, controlKey: config.controlKey };
  } catch {
    return { reason: "无法读取开发会话私有控制现场；保留现场" };
  }
}

export async function releaseDevelopmentControl(
  record: EnvironmentRecord,
): Promise<void> {
  const target = await verifyDevelopmentControl(record);
  if ("reason" in target) throw new Error(target.reason);
  await rm(target.session.controlConfigFile);
  await rm(target.session.controlSocket, { force: true });
  await rmdir(target.session.privateDirectory);
}

/** 产品停止内核已先持久结束更新意图；此处才通知前台，并确认其持有的 watch 收尾。 */
export async function closeDevelopmentFrontend(
  workspacePath: string,
  environment: string,
): Promise<string | undefined> {
  const layout = createLayout(workspacePath, environment);
  if ("reason" in layout) return layout.reason;
  const read = await readRecord(layout.recordPath);
  if (read.kind !== "record")
    return read.kind === "absent" ? undefined : "开发会话记录不可读";
  const record = read.record;
  const session = record.development;
  if (session === undefined || session.state === "ended") return undefined;
  const self = observeProcessIdentity(process.pid);
  // 前台自己的 finally 在 watch 退出后提交 ended；不能等待自己退出而造成互锁。
  if ("identity" in self && sameProcessIdentity(self.identity, session.owner))
    return undefined;
  if (observeProcessLifecycle(session.owner) === "exited") {
    if (session.watchPending)
      return "开发前台退出时watch启动仍在途，保留现场，不猜测已关闭";
    if (
      session.watcher !== undefined &&
      observeProcessLifecycle(session.watcher) !== "exited"
    )
      return "开发前台已退出，但 Turbo watch 的退出无法确认；保留现场，不擅自接管";
    const target = await verifyDevelopmentControl(record);
    if ("reason" in target) return target.reason;
    const finished = await developmentSessionCommand({
      workspacePath,
      environment,
      sessionId: session.sessionId,
      action: "finish",
    });
    if (finished.status !== "ok") return finished.failure;
    await releaseDevelopmentControl(record);
    return undefined;
  }
  const target = await verifyDevelopmentControl(record);
  if ("reason" in target) return target.reason;
  const response = await requestPrivateControl({
    socketPath: session.controlSocket,
    environmentId: record.environmentId,
    runId: session.sessionId,
    controlKey: target.controlKey,
    kind: "stop",
    timeoutMilliseconds: 5000,
  });
  if ("reason" in response) return response.reason;
  if (response.reply.accepted !== true) return "开发前台没有接受停止";
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const current = await readRecord(layout.recordPath);
    if (current.kind !== "record") return "等待开发收尾时记录不可读";
    if (current.record.development?.sessionId !== session.sessionId)
      return "等待开发收尾时会话引用改变";
    if (current.record.development.state === "ended") return undefined;
    if (observeProcessLifecycle(session.owner) === "unknown")
      return "开发前台身份变得不可核验；保留现场";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "开发前台未在收尾宽限内确认 watch 结束；保留现场";
}
