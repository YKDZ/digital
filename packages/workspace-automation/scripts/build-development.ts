import { spawn } from "node:child_process";

import {
  stopEnvironment,
  updateDevelopmentEnvironment,
} from "@digital/environment";

const workspacePath = process.env.DIGITAL_DEVELOPMENT_WORKSPACE;
const environment = process.env.DIGITAL_DEVELOPMENT_ENVIRONMENT;
const sessionId = process.env.DIGITAL_DEVELOPMENT_SESSION;
const [packageName, ...extraArguments] = process.argv.slice(2);
if (packageName === undefined || extraArguments.length > 0)
  throw new Error("用法：pnpm development:build <所属工作区包名>");
if (
  workspacePath === undefined ||
  environment === undefined ||
  sessionId === undefined
)
  throw new Error("开发编译必须由环境开发入口启动");
const stopped = await stopEnvironment({
  workspacePath,
  environment,
  developmentSession: sessionId,
});
if (stopped.status !== "stopped" && stopped.status !== "already-stopped")
  throw new Error(
    stopped.failure?.message ?? "旧开发世代无法确认停止，拒绝覆盖其模块",
  );
// 根只协调共享开发世代；包自己拥有编译命令与输出，依赖顺序由 Turbo 决定。
const child = spawn(
  "pnpm",
  ["--filter", packageName, "--fail-if-no-match", "run", "dev:compile"],
  { cwd: workspacePath, stdio: "inherit" },
);
const exit = await new Promise<{
  code: number | null;
  signal: string | null;
  failure?: string;
}>((resolve) => {
  child.once("error", (error) =>
    resolve({ code: null, signal: null, failure: error.message }),
  );
  child.once("close", (code, signal) => resolve({ code, signal }));
});
if (exit.code !== 0) {
  await updateDevelopmentEnvironment({
    workspacePath,
    environment,
    sessionId,
    update: "failed",
    failure: `开发编译 ${packageName} 退出 ${String(exit.code)} / ${String(exit.signal)}${exit.failure === undefined ? "" : `：${exit.failure}`}；完整首因见开发日志`,
  });
}
process.exitCode =
  exit.code ??
  (exit.signal === "SIGINT" ? 130 : exit.signal === "SIGTERM" ? 143 : 1);
