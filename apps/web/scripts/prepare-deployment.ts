import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { acceptanceInputs } from "./acceptance-inputs.ts";
import { preparedDeploymentPath } from "./deployment-preparation.ts";

const { workspacePath, sourceDirectory, composeFile } =
  await acceptanceInputs();
const endpoint = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";
if (!endpoint.startsWith("unix://"))
  throw new Error("受控部署验收需要可访问本工作区挂载的 Unix Docker daemon");
const dockerCommand = process.env.DIGITAL_DEPLOYMENT_DOCKER_COMMAND ?? "docker";
const dockerArguments = JSON.parse(
  process.env.DIGITAL_DEPLOYMENT_DOCKER_ARGUMENTS ?? "[]",
) as string[];
const identity = createHash("sha256")
  .update(workspacePath)
  .digest("hex")
  .slice(0, 16);
const standaloneImage =
  process.env.DIGITAL_DEPLOYMENT_STANDALONE_IMAGE ??
  `digital-check-${identity}:standalone`;
const runtimeImage =
  process.env.DIGITAL_DEPLOYMENT_RUNTIME_IMAGE ??
  `digital-check-${identity}:runtime`;
const suppliedImages =
  process.env.DIGITAL_DEPLOYMENT_STANDALONE_IMAGE !== undefined ||
  process.env.DIGITAL_DEPLOYMENT_RUNTIME_IMAGE !== undefined;
if (
  suppliedImages &&
  (!process.env.DIGITAL_DEPLOYMENT_STANDALONE_IMAGE ||
    !process.env.DIGITAL_DEPLOYMENT_RUNTIME_IMAGE)
)
  throw new Error("显式部署需要同时提供 standalone 与 runtime 两份镜像引用");
const cancellation = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => cancellation.abort(signal));

async function docker(args: readonly string[]): Promise<void> {
  if (cancellation.signal.aborted) throw new Error("部署准备已取消");
  const child = spawn(
    dockerCommand,
    [...dockerArguments, "--host", endpoint, ...args],
    {
      cwd: workspacePath,
      stdio: "inherit",
    },
  );
  const cancel = (): void => {
    child.kill("SIGTERM");
  };
  cancellation.signal.addEventListener("abort", cancel, { once: true });
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    if (status !== 0 || cancellation.signal.aborted)
      throw new Error(
        `Docker 部署准备失败：${args[0]}，退出码 ${String(status)}`,
      );
  } finally {
    cancellation.signal.removeEventListener("abort", cancel);
  }
}

await docker(["info", "--format", "{{.ID}}"]);
await docker(["compose", "version"]);
if (suppliedImages) {
  await docker(["image", "inspect", standaloneImage, runtimeImage]);
} else
  for (const [target, tag] of [
    ["standalone", standaloneImage],
    ["runtime", runtimeImage],
  ] as const)
    await docker([
      "build",
      ...(process.env.DIGITAL_DEPLOYMENT_BUILD_NETWORK === undefined
        ? []
        : ["--network", process.env.DIGITAL_DEPLOYMENT_BUILD_NETWORK]),
      "--file",
      path.resolve(import.meta.dirname, "../Dockerfile"),
      "--target",
      target,
      "--tag",
      tag,
      workspacePath,
    ]);
await mkdir(path.dirname(preparedDeploymentPath), { recursive: true });
const temporary = `${preparedDeploymentPath}.${process.pid}`;
await writeFile(
  temporary,
  JSON.stringify(
    {
      workspacePath,
      sourceDirectory,
      composeFile,
      standaloneImage,
      runtimeImage,
    },
    null,
    2,
  ),
);
await rename(temporary, preparedDeploymentPath);
