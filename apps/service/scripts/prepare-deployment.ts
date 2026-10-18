import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type CommandRecord = {
  readonly arguments: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

type ImageRecord = {
  readonly reference: string;
  readonly id: string;
  readonly version: string | null;
};

const workspacePath = path.resolve(import.meta.dirname, "../../..");
const deploymentDirectory = path.resolve(
  process.env.DIGITAL_DEPLOYMENT_ARTIFACTS ??
    process.env.DIGITAL_CI_EVIDENCE ??
    path.join(import.meta.dirname, "../.turbo/deployment"),
);
const preparedPath = path.join(deploymentDirectory, "prepared.json");
const dockerCommand = process.env.DIGITAL_DEPLOYMENT_DOCKER_COMMAND ?? "docker";
const dockerArguments = JSON.parse(
  process.env.DIGITAL_DEPLOYMENT_DOCKER_ARGUMENTS ?? "[]",
) as string[];
const endpoint = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";
const providedStandaloneImage = process.env.DIGITAL_DEPLOYMENT_STANDALONE_IMAGE;
const providedRuntimeImage = process.env.DIGITAL_DEPLOYMENT_RUNTIME_IMAGE;
const suppliedImages =
  providedStandaloneImage !== undefined || providedRuntimeImage !== undefined;
if (suppliedImages && (!providedStandaloneImage || !providedRuntimeImage))
  throw new Error("显式部署需要同时提供独立准备与仅运行镜像");

const runId = createHash("sha256")
  .update(`${workspacePath}\0${process.pid}\0${Date.now()}\0${randomUUID()}`)
  .digest("hex")
  .slice(0, 16);
const imagePrefix = `digital-service-check-${runId}`;
const standaloneImage = providedStandaloneImage ?? `${imagePrefix}:standalone`;
const runtimeImage = providedRuntimeImage ?? `${imagePrefix}:runtime`;
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));
const commands: CommandRecord[] = [];

async function docker(arguments_: readonly string[]): Promise<CommandRecord> {
  if (controller.signal.aborted) throw new Error("部署准备已取消");
  const startedAt = new Date().toISOString();
  const child = spawn(
    dockerCommand,
    [...dockerArguments, "--host", endpoint, ...arguments_],
    {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  const cancel = (): void => {
    child.kill("SIGTERM");
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  const result = await new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  controller.signal.removeEventListener("abort", cancel);
  const record: CommandRecord = {
    arguments: [
      dockerCommand,
      ...dockerArguments,
      "--host",
      endpoint,
      ...arguments_,
    ],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    signal: result.signal,
    stdout,
    stderr,
  };
  commands.push(record);
  if (result.exitCode !== 0 || controller.signal.aborted)
    throw new Error(
      `Docker 部署准备失败：${arguments_[0]}，退出码 ${String(result.exitCode)}`,
    );
  return record;
}

async function image(reference: string): Promise<ImageRecord> {
  const result = await docker([
    "image",
    "inspect",
    "--format",
    "{{json .}}",
    reference,
  ]);
  const inspected = JSON.parse(result.stdout) as {
    readonly Id: string;
    readonly Config?: { readonly Labels?: Record<string, string> | null };
  };
  return {
    reference,
    id: inspected.Id,
    version:
      inspected.Config?.Labels?.["org.opencontainers.image.version"] ?? null,
  };
}

async function main(): Promise<void> {
  await mkdir(deploymentDirectory, { recursive: true, mode: 0o700 });
  const daemon = await docker(["info", "--format", "{{.ID}}"]);
  if (daemon.stdout.trim().length === 0)
    throw new Error("Docker daemon 未返回实例标识");
  const compose = await docker(["compose", "version", "--short"]);
  const revision = (
    await dockerFromWorkspace("git", ["rev-parse", "HEAD"])
  ).trim();

  if (suppliedImages) {
    await docker(["image", "inspect", standaloneImage, runtimeImage]);
  } else {
    for (const [target, tag] of [
      ["standalone", standaloneImage],
      ["runtime", runtimeImage],
    ] as const) {
      await docker([
        "build",
        ...(process.env.DIGITAL_DEPLOYMENT_BUILD_NETWORK === undefined
          ? []
          : ["--network", process.env.DIGITAL_DEPLOYMENT_BUILD_NETWORK]),
        "--build-arg",
        `DEPLOYMENT_BUILD_ID=${revision}`,
        "--file",
        "apps/service/Dockerfile",
        "--target",
        target,
        "--tag",
        tag,
        workspacePath,
      ]);
    }
  }

  const images = [await image(standaloneImage), await image(runtimeImage)];
  const prepared = {
    workspacePath,
    revision,
    endpoint,
    daemonId: daemon.stdout.trim(),
    composeVersion: compose.stdout.trim(),
    standaloneImage,
    runtimeImage,
    images,
    commands,
    preparedAt: new Date().toISOString(),
  };
  const temporary = `${preparedPath}.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(prepared, null, 2), {
    mode: 0o600,
  });
  await rename(temporary, preparedPath);
}

function dockerFromWorkspace(
  command: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: workspacePath,
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
    child.once("close", (exitCode) => {
      if (exitCode !== 0)
        reject(new Error(`读取工作区版本失败：${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

try {
  await main();
} catch (error) {
  await mkdir(deploymentDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(deploymentDirectory, `preparation-${runId}.json`),
    JSON.stringify(
      {
        workspacePath,
        endpoint,
        standaloneImage,
        runtimeImage,
        commands,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.error("产品服务镜像准备失败", error);
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
