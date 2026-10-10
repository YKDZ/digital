/**
 * 打包模式交付物：用包管理器的官方 deploy 生成只含生产依赖的闭包，再返回其中的 CLI
 * 可执行入口。闭包必须不含环境包——正式业务不依赖验收环境（合同⑥），打包模式因此
 * 与源码、构建产物模式共用同一个场景，却走真正不同的启动方式。
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(e2eRoot, "..", "..", "..", "..");

export type PackedCli = {
  readonly deployDirectory: string;
  readonly binPath: string;
  /** 生产闭包里的 `@digital` 成员：用于证明环境包没有被打包进正式业务。 */
  readonly digitalPackages: readonly string[];
};

async function runPnpm(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `pnpm ${args.join(" ")} 以退出码 ${String(code)} 失败\n${stdout}\n${stderr}`,
          ),
        );
    });
  });
}

async function digitalPackages(
  deployDirectory: string,
): Promise<readonly string[]> {
  const scope = path.join(deployDirectory, "node_modules", "@digital");
  const entries = await readdir(scope, { withFileTypes: true }).catch(
    () => undefined,
  );
  if (entries === undefined) return [];
  return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
}

/** 生成一份新的打包闭包；调用方负责在用完后删除该目录。 */
export async function packCli(options: {
  readonly runId: string;
}): Promise<PackedCli> {
  const outputRoot = path.join(workspaceRoot, "run", "t11-packed");
  await mkdir(outputRoot, { recursive: true });
  const deployDirectory = await mkdtemp(
    path.join(outputRoot, `deploy-${options.runId}-`),
  );
  await runPnpm([
    "--config.inject-workspace-packages=true",
    "--filter",
    "./apps/cli",
    "deploy",
    "--prod",
    deployDirectory,
  ]);
  // 部署目录就是可执行包本身：官方 bin 入口带 shebang 与可执行位。
  const binPath = path.join(deployDirectory, "dist", "cli.js");
  const members = await digitalPackages(deployDirectory);
  if (members.includes("environment"))
    throw new Error(
      `打包闭包不应包含验收环境包：${deployDirectory}\n@digital=${members.join("、")}`,
    );
  return { deployDirectory, binPath, digitalPackages: members };
}

export async function removePackedCli(deployDirectory: string): Promise<void> {
  await rm(deployDirectory, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const packed = await packCli({ runId: Date.now().toString(36) });
  process.stdout.write(`${packed.binPath}\n`);
}
