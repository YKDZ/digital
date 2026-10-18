import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  inspectEnvironment,
  startEnvironment,
  stopEnvironment,
  updateDevelopmentEnvironment,
} from "@digital/environment";

const workspacePath = process.env.DIGITAL_DEVELOPMENT_WORKSPACE;
const environment = process.env.DIGITAL_DEVELOPMENT_ENVIRONMENT;
const sessionId = process.env.DIGITAL_DEVELOPMENT_SESSION;
if (
  workspacePath === undefined ||
  environment === undefined ||
  sessionId === undefined
)
  throw new Error("开发任务必须由环境开发入口启动");
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => abort.abort(signal));
let failed = false;
let retainReady = false;
try {
  // watch 的局部执行图会裁去未变的非缓存上游。由 Turbo 自己计算完整图版本，
  // 不枚举包、不分析源码，也不从这个只读查询执行任何构建或服务任务。
  const dry = await promisify(execFile)(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "dev:serve",
      "--filter=@digital/service",
      "--dry=json",
      "--env-mode=loose",
    ],
    { cwd: workspacePath, signal: abort.signal, maxBuffer: 16 * 1024 * 1024 },
  );
  const graph = JSON.parse(dry.stdout) as {
    tasks?: { taskId?: string; hash?: string }[];
  };
  const taskHash = graph.tasks?.find(
    (task) => task.taskId === "@digital/service#dev:serve",
  )?.hash;
  if (typeof taskHash !== "string" || taskHash.length === 0)
    throw new Error("Turbo 未返回开发入口完整任务版本");
  const current = await inspectEnvironment({ workspacePath, environment });
  if (
    !abort.signal.aborted &&
    current.development?.sessionId === sessionId &&
    current.development.state === "active" &&
    current.development.update === "ready" &&
    current.development.taskHash === taskHash &&
    current.serviceReadiness === "ready" &&
    current.run.runtime === "development" &&
    current.development.runId === current.run.runId
  ) {
    retainReady = true;
    console.log(
      JSON.stringify({
        state: "unchanged",
        sessionId,
        taskHash,
        runId: current.run.runId,
      }),
    );
  } else {
    const updating = await stopEnvironment({
      workspacePath,
      environment,
      developmentSession: sessionId,
    });
    if (updating.status !== "stopped" && updating.status !== "already-stopped")
      throw new Error(updating.failure?.message ?? "旧开发世代关闭无法确认");
    if (!abort.signal.aborted) {
      const marked = await updateDevelopmentEnvironment({
        workspacePath,
        environment,
        sessionId,
        update: "starting",
      });
      if (marked.status !== "ok")
        throw new Error(marked.failure ?? "开发会话不再允许更新");
      const started = await startEnvironment({
        workspacePath,
        environment,
        runtime: "development",
        developmentSession: sessionId,
        signal: abort.signal,
      });
      if (started.status !== "ready" && started.status !== "already-ready")
        throw new Error(started.failure?.message ?? "新开发世代尚未就绪");
      if (!abort.signal.aborted) {
        const ready = await updateDevelopmentEnvironment({
          workspacePath,
          environment,
          sessionId,
          update: "ready",
          taskHash,
        });
        if (ready.status !== "ok")
          throw new Error(ready.failure ?? "开发会话就绪无法保存");
        retainReady = true;
        console.log(
          JSON.stringify({
            state: "ready",
            sessionId,
            taskHash,
            runId: started.run.runId,
            address: started.run.address,
          }),
        );
      }
    }
  }
} catch (error) {
  failed = !abort.signal.aborted;
  if (failed) {
    const message = error instanceof Error ? error.message : "开发服务更新失败";
    console.error(message);
    await updateDevelopmentEnvironment({
      workspacePath,
      environment,
      sessionId,
      update: "failed",
      failure: message,
    });
  }
} finally {
  // 成功的一次性任务把服务留给开发会话持有；独立 stop 终结会话和 Turbo。
  if (!retainReady || abort.signal.aborted) {
    const stopped = await stopEnvironment({
      workspacePath,
      environment,
      developmentSession: sessionId,
    });
    if (stopped.status !== "stopped" && stopped.status !== "already-stopped") {
      const current = await inspectEnvironment({ workspacePath, environment });
      if (
        current.development?.sessionId === sessionId &&
        current.development.state === "active"
      ) {
        failed = true;
        console.error(stopped.failure?.message ?? "开发更新收尾无法确认");
      }
    }
  }
}
process.exitCode = failed ? 1 : 0;
