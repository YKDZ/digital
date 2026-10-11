import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  stopEnvironment,
  updateDevelopmentEnvironment,
} from "../packages/environment/src/index.ts";

const workspacePath = process.env.DIGITAL_DEVELOPMENT_WORKSPACE;
const environment = process.env.DIGITAL_DEVELOPMENT_ENVIRONMENT;
const sessionId = process.env.DIGITAL_DEVELOPMENT_SESSION;
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
const sourceOnly = process.argv.includes("--source");
const directory = path.resolve(".turbo/development");
if (!sourceOnly) await rm(directory, { recursive: true, force: true });
const args = [
  "exec",
  "tsc",
  "-p",
  sourceOnly ? "tsconfig.json" : "tsconfig.build.json",
  "--customConditions",
  "digital-development",
  "--pretty",
  "false",
  ...(sourceOnly
    ? ["--noEmit"]
    : [
        "--incremental",
        "--outDir",
        path.join(directory, "dist"),
        "--tsBuildInfoFile",
        path.join(directory, "build.tsbuildinfo"),
      ]),
];
const child = spawn("pnpm", args, { stdio: "inherit" });
const exit = await new Promise<{ code: number | null; signal: string | null }>(
  (resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  },
);
if (exit.code !== 0) {
  await updateDevelopmentEnvironment({
    workspacePath,
    environment,
    sessionId,
    update: "failed",
    failure: `开发编译 ${path.relative(workspacePath, process.cwd())} 退出 ${String(exit.code)} / ${String(exit.signal)}；完整首因见开发日志`,
  });
}
process.exitCode = exit.code ?? 1;
