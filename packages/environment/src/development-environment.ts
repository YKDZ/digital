import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync, type Stats } from "node:fs";
import { lstat, mkdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  developmentSessionCommand,
  releaseDevelopmentControl,
} from "./internal/development-client.ts";
import { directoryIdentity } from "./internal/operation-support.ts";
import {
  createLayout,
  createPrivateRunDirectory,
  resolveWorkspacePath,
  verifyLogsOwnership,
} from "./internal/paths.ts";
import { listenPrivateControl } from "./internal/private-control.ts";
import {
  observeProcessIdentity,
  observeProcessLifecycle,
  type ProcessIdentity,
} from "./internal/process-identity.ts";
import { filteredEnvironment } from "./internal/processes.ts";
import { readRecord } from "./internal/record.ts";
import { createDiagnosticRedactor } from "./internal/redact.ts";
import { stopEnvironment } from "./stop-environment.ts";

export type DevelopmentEnvironmentResult = {
  readonly status: "stopped" | "failed" | "not-confirmed";
  readonly sessionId: string;
  readonly logFile: string | null;
  readonly watchExit: {
    readonly code: number | null;
    readonly signal: string | null;
  } | null;
  readonly failure?: string;
  readonly cleanupErrors: readonly string[];
};

/**
 * 前台开发会话：只拥有一个 Turbo watch 及其收尾。编译图和文件传播均由 Turbo 持有，
 * 每次服务重入仍使用公开 stop/start 与真实产品 ready；不做资料接入或数据重建。
 */
export async function developEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly signal?: AbortSignal;
  readonly onOutput?: (text: string) => void;
}): Promise<DevelopmentEnvironmentResult> {
  const sessionId = randomUUID();
  let logFile: string | null = null;
  let watchExit: DevelopmentEnvironmentResult["watchExit"] = null;
  const cleanupErrors: string[] = [];
  const failed = (failure: string): DevelopmentEnvironmentResult => ({
    status: "failed",
    sessionId,
    logFile,
    watchExit,
    failure,
    cleanupErrors,
  });
  const workspacePath = resolveWorkspacePath(input.workspacePath);
  const environment = input.environment;
  const layout = createLayout(workspacePath, environment);
  if ("reason" in layout) return failed(layout.reason);
  const initial = await readRecord(layout.recordPath);
  if (initial.kind !== "record")
    return failed("开发会话要求先显式 prepare 环境");
  const record = initial.record;
  const container = await directoryIdentity(layout.containerDirectory);
  if (
    container?.device !== record.containerIdentity.device ||
    container.inode !== record.containerIdentity.inode ||
    record.workspacePath !== workspacePath ||
    record.environment !== environment
  )
    return failed("环境容器归属无法确认");
  const logs = await verifyLogsOwnership(layout, record.inputs);
  if ("reason" in logs) return failed(logs.reason);
  if (record.development !== undefined && record.development.state !== "ended")
    return failed("开发会话尚未结束；请先独立 stop");
  if (record.run !== undefined && record.run.state !== "stopped")
    return failed("请先显式 stop 当前服务，再进入开发会话");
  const owner = observeProcessIdentity(process.pid);
  if (!("identity" in owner)) return failed(owner.reason);
  const privateRun = createPrivateRunDirectory(
    workspacePath,
    record.environmentId,
    sessionId,
  );
  if ("reason" in privateRun) return failed(privateRun.reason);
  const directory = privateRun.directory;
  const controlKey = randomBytes(32).toString("hex");
  const controlConfigFile = path.join(directory, "development.json");
  const controlSocket = path.join(directory, "control.sock");
  const logDirectory = path.join(layout.logsRoot, `development-${sessionId}`);
  let privateDirectoryCreated = false;
  let privateInfo: Stats | undefined;
  let controlConfigCreated = false;
  let logFd: number | undefined;
  let control: Awaited<ReturnType<typeof listenPrivateControl>> | undefined;
  let controlClosed = true;
  const cancellation = new AbortController();
  const abort = (): void => cancellation.abort();
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) process.on(signal, abort);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  let active = false;
  let child: ChildProcess | undefined;
  let childExit:
    | Promise<NonNullable<DevelopmentEnvironmentResult["watchExit"]>>
    | undefined;
  let watcher: ProcessIdentity | undefined;
  let closed = false;
  let logProblem: string | undefined;
  let failure: string | undefined;
  const append = (text: string): void => {
    if (logFd === undefined || logProblem !== undefined) return;
    try {
      const buffer = Buffer.from(text);
      let written = 0;
      while (written < buffer.length)
        written += writeSync(logFd, buffer, written);
      input.onOutput?.(text);
    } catch (error) {
      logProblem = `开发日志持久化或输出失败：${error instanceof Error ? error.message : "未知错误"}`;
      abort();
    }
  };
  const stopWatch = (): void => {
    if (child === undefined || closed || watcher === undefined) return;
    if (observeProcessLifecycle(watcher) !== "alive") {
      cleanupErrors.push("Turbo watch 身份无法确认，拒绝按进程号发送信号");
      return;
    }
    try {
      process.kill(-watcher.pid, "SIGINT");
    } catch (error) {
      cleanupErrors.push(
        `Turbo watch 停止请求失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  };
  try {
    // 取消处理先于所有资源分配；任何 setup 失败也经过同一个 finally。
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    privateDirectoryCreated = true;
    privateInfo = await lstat(directory);
    await writeFile(
      controlConfigFile,
      JSON.stringify({
        environmentId: record.environmentId,
        sessionId,
        controlKey,
      }),
      { mode: 0o600, flag: "wx" },
    );
    controlConfigCreated = true;
    await mkdir(logDirectory, { mode: 0o700 });
    logFile = path.join(logDirectory, "turbo.log");
    logFd = openSync(logFile, "ax", 0o600);
    control = await listenPrivateControl({
      socketPath: controlSocket,
      environmentId: record.environmentId,
      runId: sessionId,
      controlKey,
      timeoutMilliseconds: 5000,
      readState: () => ({
        phase: cancellation.signal.aborted ? "stopping" : "serving",
        pid: process.pid,
        logHealth: logProblem === undefined ? "recording" : "incomplete",
        published: true,
        ...(logProblem === undefined ? {} : { logProblem }),
      }),
      requestSelfTerminate: () => {
        const already = cancellation.signal.aborted;
        if (!already) process.kill(process.pid, "SIGTERM");
        return { accepted: true, already };
      },
      requestPublish: () => ({ accepted: true, already: true }),
    });
    controlClosed = false;
    const begun = await developmentSessionCommand({
      workspacePath,
      environment,
      sessionId,
      action: "begin",
      session: {
        sessionId,
        state: "active",
        update: "starting",
        updatedAt: new Date().toISOString(),
        owner: owner.identity,
        watchPending: true,
        privateDirectory: directory,
        privateIdentity: { device: privateInfo.dev, inode: privateInfo.ino },
        controlSocket,
        controlConfigFile,
        logFile,
      },
    });
    if (begun.status !== "ok") {
      throw new Error(begun.failure ?? "开发会话无法建立");
    }
    active = true;
    if (!cancellation.signal.aborted) {
      const args = [
        "exec",
        "turbo",
        "watch",
        "dev:serve",
        "--filter=@digital/service",
        "--ui=stream",
        "--env-mode=loose",
      ];
      append(`${new Date().toISOString()} command pnpm ${args.join(" ")}\n`);
      child = spawn("pnpm", args, {
        cwd: workspacePath,
        env: filteredEnvironment(process.env, {
          DIGITAL_DEVELOPMENT_SESSION: sessionId,
          DIGITAL_DEVELOPMENT_WORKSPACE: workspacePath,
          DIGITAL_DEVELOPMENT_ENVIRONMENT: environment,
        }),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      childExit = new Promise<
        NonNullable<DevelopmentEnvironmentResult["watchExit"]>
      >((resolve) => {
        child!.once("error", (error) => {
          failure = error.message;
        });
        child!.once("close", (code, signal) => {
          closed = true;
          resolve({ code, signal });
        });
      });
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8");
        const redact = createDiagnosticRedactor([controlKey]);
        stream?.on("data", (chunk: Buffer) =>
          append(redact.write(decoder.write(chunk))),
        );
        stream?.on("end", () =>
          append(redact.write(decoder.end()) + redact.end()),
        );
      }
      if (child.pid === undefined)
        throw new Error("Turbo watch 没有交出进程身份");
      const observed = observeProcessIdentity(child.pid);
      if (!("identity" in observed)) throw new Error(observed.reason);
      watcher = observed.identity;
      const attached = await developmentSessionCommand({
        workspacePath,
        environment,
        sessionId,
        action: "watcher",
        watcher,
      });
      if (attached.status !== "ok") {
        failure = attached.failure ?? "Turbo watch 归属无法保存";
        abort();
      }
      cancellation.signal.addEventListener("abort", stopWatch, { once: true });
      if (cancellation.signal.aborted) stopWatch();
      watchExit = await childExit;
      if (!cancellation.signal.aborted && watchExit.code !== 0)
        failure ??= `Turbo watch 退出 ${String(watchExit.code)} / ${String(watchExit.signal)}`;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : "开发会话异常";
    abort();
    stopWatch();
  } finally {
    if (childExit !== undefined && !closed) {
      stopWatch();
      watchExit = await childExit;
    }
    cancellation.signal.removeEventListener("abort", stopWatch);
    if (active && (child === undefined || closed)) {
      const settled = await developmentSessionCommand({
        workspacePath,
        environment,
        sessionId,
        action: "watch-settled",
      });
      if (settled.status !== "ok")
        cleanupErrors.push(settled.failure ?? "watch终态无法保存");
    }
    if (active) {
      const stopped = await stopEnvironment({ workspacePath, environment });
      if (stopped.status !== "stopped" && stopped.status !== "already-stopped")
        cleanupErrors.push(stopped.failure?.message ?? "产品世代停止无法确认");
      cleanupErrors.push(...stopped.cleanup.errors);
    }
    if (control !== undefined) {
      try {
        await control.close();
        controlClosed = true;
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error.message : "开发控制监听关闭失败",
        );
      }
    }
    if (
      active &&
      cleanupErrors.length === 0 &&
      (child === undefined || closed)
    ) {
      const finished = await developmentSessionCommand({
        workspacePath,
        environment,
        sessionId,
        action: "finish",
      });
      if (finished.status !== "ok")
        cleanupErrors.push(finished.failure ?? "开发会话结束无法保存");
    }
    const current = await readRecord(layout.recordPath);
    if (
      controlClosed &&
      privateInfo !== undefined &&
      controlConfigCreated &&
      (!active ||
        (current.kind === "record" &&
          current.record.development?.sessionId === sessionId &&
          current.record.development.state === "ended"))
    ) {
      try {
        await releaseDevelopmentControl({
          ...record,
          development: {
            sessionId,
            state: "ended",
            update: "updating",
            updatedAt: new Date().toISOString(),
            owner: owner.identity,
            watchPending: false,
            privateDirectory: directory,
            privateIdentity: {
              device: privateInfo.dev,
              inode: privateInfo.ino,
            },
            controlSocket,
            controlConfigFile,
            logFile: logFile ?? path.join(logDirectory, "turbo.log"),
          },
        });
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error.message : "开发控制现场回收失败",
        );
      }
    }
    if (privateDirectoryCreated && !controlConfigCreated && controlClosed) {
      try {
        const actual = await lstat(directory);
        if (
          privateInfo === undefined ||
          actual.dev !== privateInfo.dev ||
          actual.ino !== privateInfo.ino ||
          actual.uid !== process.getuid?.()
        )
          cleanupErrors.push("开发 setup 私有目录身份无法确认；保留现场");
        else await rmdir(directory);
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error.message : "开发 setup 目录回收失败",
        );
      }
    }
    append(
      `${new Date().toISOString()} watch-exit ${JSON.stringify(watchExit)} cleanup ${JSON.stringify(cleanupErrors)}\n`,
    );
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error.message : "开发日志关闭失败",
        );
      }
    }
    for (const signal of signals) process.off(signal, abort);
    input.signal?.removeEventListener("abort", abort);
  }
  failure ??= logProblem;
  return {
    status:
      cleanupErrors.length > 0
        ? "not-confirmed"
        : failure === undefined
          ? "stopped"
          : "failed",
    sessionId,
    logFile,
    watchExit,
    ...(failure === undefined ? {} : { failure }),
    cleanupErrors,
  };
}

/** 编译任务报告实际开始/失败；不解析 Turbo 文本，也不调度其他包。 */
export async function updateDevelopmentEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly sessionId: string;
  readonly update: "starting" | "failed" | "ready";
  readonly failure?: string;
  readonly taskHash?: string;
}): Promise<{ readonly status: "ok" | "refused"; readonly failure?: string }> {
  return await developmentSessionCommand({
    workspacePath: input.workspacePath,
    environment: input.environment,
    sessionId: input.sessionId,
    action: "update",
    update: input.update,
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    ...(input.taskHash === undefined ? {} : { taskHash: input.taskHash }),
  });
}
