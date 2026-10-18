import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { createPublicApiClient } from "@digital/public-api";

import {
  inspectEnvironment,
  startEnvironment,
  stopEnvironment,
} from "../src/index.ts";

type ProductAddress = {
  readonly workspacePath: string;
  readonly environment: string;
};

export async function withPublicApiClient<T>(
  input: ProductAddress,
  use: (client: ReturnType<typeof createPublicApiClient>) => Promise<T>,
): Promise<T> {
  const started = await startEnvironment(input);
  if (
    (started.status !== "ready" && started.status !== "already-ready") ||
    started.run.address === null
  )
    throw new Error(
      `无法启动正式产品服务：${JSON.stringify(started.failure ?? {})}`,
    );
  const ownsRun = started.status === "ready";
  const operation = await Promise.resolve()
    .then(() => use(createPublicApiClient({ baseUrl: started.run.address! })))
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
  let cleanupFailure: Error | undefined;
  if (ownsRun) {
    try {
      const stopped = await stopEnvironment(input);
      if (stopped.status !== "stopped" && stopped.status !== "already-stopped")
        cleanupFailure = new Error(
          `无法停止正式产品服务：${JSON.stringify(stopped.failure ?? {})}`,
        );
    } catch (error) {
      cleanupFailure =
        error instanceof Error
          ? error
          : new Error(`无法停止正式产品服务：${String(error)}`);
    }
  }
  if (operation.status === "rejected") throw operation.reason;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return operation.value;
}

export async function createLibraryAndScan(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly displayName: string;
  readonly directory: string;
}): Promise<{
  readonly libraryId: string;
  readonly executionId: string;
  readonly outcome: string | undefined;
}> {
  return await withPublicApiClient(input, async (client) => {
    const library = await client.saveAssetLibrary({
      displayName: input.displayName,
      directories: [input.directory],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const scan = await scanWithClient(client, library.id);
    if (scan.status !== "completed")
      throw new Error(`正式资产库扫描未完成：${JSON.stringify(scan)}`);
    return {
      libraryId: library.id,
      executionId: scan.parentExecutionId,
      outcome: scan.outcome,
    };
  });
}

async function scanWithClient(
  client: ReturnType<typeof createPublicApiClient>,
  assetLibraryId: string,
): Promise<Awaited<ReturnType<typeof client.inspectAssetLibraryScan>>> {
  const started = await client.startAssetLibraryScan(assetLibraryId);
  const deadline = Date.now() + 60_000;
  let scan = await client.inspectAssetLibraryScan(started.parentExecutionId);
  while (scan.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    scan = await client.inspectAssetLibraryScan(started.parentExecutionId);
  }
  return scan;
}

export async function workflowHistoryIds(
  input: ProductAddress,
): Promise<string[]> {
  const inspected = await inspectEnvironment(input);
  if (inspected.status !== "ok")
    throw new Error("无法查看环境的正式工作流历史");
  if (
    inspected.serviceReadiness === "ready" &&
    inspected.run.address !== null
  ) {
    const history = await createPublicApiClient({
      baseUrl: inspected.run.address,
    }).listWorkflowHistory({ limit: 100 });
    return history.items.map(({ execution }) => execution.id);
  }
  return await workflowHistoryIdsFromPreparationProbe({
    workspacePath: input.workspacePath,
    productDataDirectory: inspected.environment.productDataRoot,
  });
}

async function workflowHistoryIdsFromPreparationProbe(input: {
  readonly workspacePath: string;
  readonly productDataDirectory: string;
}): Promise<string[]> {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@digital/service",
      "exec",
      "node",
      "./dist/verify-prepared.js",
      "--workflow-history",
    ],
    {
      cwd: input.workspacePath,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        DIGITAL_PRODUCT_DATA: input.productDataDirectory,
        DIGITAL_SOURCE_IO_MODE: "offline",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0)
    throw new Error(
      `无法通过正式只读服务读取工作流历史：${stderr.trim() || `退出码 ${String(code)}`}`,
    );
  try {
    const value: unknown = JSON.parse(stdout);
    if (
      !Array.isArray(value) ||
      !value.every((id): id is string => typeof id === "string")
    )
      throw new Error("工作流历史结果无效");
    return value;
  } catch (error) {
    throw new Error("正式只读服务没有返回工作流历史", { cause: error });
  }
}

export async function currentAssetCount(
  input: ProductAddress,
): Promise<number> {
  return await withPublicApiClient(input, async (client) => {
    const assets = await client.listAssets({ limit: 100 });
    return assets.items.length;
  });
}

export async function startCompetingProductService(
  productDataDirectory: string,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn("pnpm", ["--filter", "@digital/service", "start"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      DIGITAL_PRODUCT_DATA: productDataDirectory,
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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
  const terminateProcessGroup = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  const timeout = setTimeout(terminateProcessGroup, 10_000);
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      terminateProcessGroup();
      await new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
    }
  }
}
