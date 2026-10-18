import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicApiClient } from "@digital/public-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deleteEnvironment,
  inspectEnvironment,
  prepareEnvironment,
  rebuildEnvironment,
  startEnvironment,
  stopEnvironment,
  type InspectEnvironmentResult,
  type JsonValue,
  type StartOperationResult,
  type StopOperationResult,
} from "../src/index.ts";
import { recordFileName } from "../src/internal/paths.ts";
import {
  createLibraryAndScan,
  currentAssetCount,
  workflowHistoryIds,
} from "./product-service.ts";

/**
 * 04 保留修改与显式重建/删除：正式写入的产品状态必须跨停止与启动保留；只有使用者
 * 显式发出 rebuild/delete 才回到初态或回收该环境自有资源。其他环境、原始素材、
 * 不兼容现场与不可认领的记录都必须原样保留并被明确报告。
 */

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const environmentCli = path.join("packages", "environment", "dist", "cli.js");
/** 正式 Web 交付入口：用作「管理器之外的真实写入者」，不由本管理器启动也不受其锁约束。 */
const serviceEntry = path.join("apps", "service", "dist", "main.js");
/** 受控端口区间由门禁环境给出；本合同只用 33001 起的第一批空闲端口。 */
const portFloor =
  process.env.DIGITAL_04_PORT_BASE === undefined
    ? 33001
    : Number(process.env.DIGITAL_04_PORT_BASE);
const ledgerPath =
  process.env.DIGITAL_04_LEDGER ??
  path.resolve(workspaceRoot, "..", "04-start-ledger.ndjson");
/** 每个用例都要跑真实构建、迁移、读取与一次或多次服务世代。 */
const realRunTimeout = 300_000;

type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type OwnedEnv = {
  readonly name: string;
  readonly port: number;
  readonly containerDirectory: string;
  readonly recordPath: string;
  readonly productDataRoot: string;
};

type LibraryView = {
  readonly id: string;
  readonly displayName: string;
  readonly configVersion: number;
};

const ownedEnvironments: OwnedEnv[] = [];
const temporaryDirectories: string[] = [];
/** 每一发 start 在请求离开之前登记；收尾只按登记走公开停止接口。 */
type StartAttempt = {
  readonly label: string;
  readonly environment: string;
  readonly issuedAt: string;
  status?: string;
  runId?: string | null;
};
const startAttempts: StartAttempt[] = [];

async function run(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}): Promise<CommandResult> {
  const child = spawn(input.command, [...input.args], {
    cwd: workspaceRoot,
    env: input.env ?? {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
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
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

function cleanEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
}

async function cli(
  args: readonly string[],
): Promise<CommandResult & { readonly payload: Record<string, unknown> }> {
  const result = await run({
    command: process.execPath,
    args: [path.join(workspaceRoot, environmentCli), ...args],
  });
  let payload: Record<string, unknown> = {};
  // 成功结果打印到 stdout，拒绝与失败结果打印到 stderr，两者都是公开 CLI 的结构化载荷。
  for (const stream of [result.stdout, result.stderr]) {
    try {
      payload = JSON.parse(stream) as Record<string, unknown>;
      break;
    } catch {
      // 退出码与非 JSON 输出本身就是断言对象。
    }
  }
  return { ...result, payload };
}

/** 状态载荷：成功走 data，失败走 error/顶层状态，两种形状都取实际 status。 */
function reportedStatus(payload: Record<string, unknown>): string {
  const data = payload["data"];
  if (typeof data === "object" && data !== null) {
    const status = (data as Record<string, unknown>)["status"];
    if (typeof status === "string") return status;
  }
  const status = payload["status"];
  return typeof status === "string" ? status : "无结构化状态";
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** 端口此刻能否被绑定：只按 TCP 监听实测，验证完立即释放给产品使用。 */
async function portAvailable(port: number): Promise<boolean> {
  const probe = createServer();
  const available = await new Promise<boolean>((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1" }, () => resolve(true));
  });
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return available;
}

/** 空闲端口只按 TCP 绑定实际验证，验证完立即释放给产品使用。 */
async function freePort(): Promise<number> {
  for (let candidate = portFloor; candidate < portFloor + 200; candidate += 1) {
    if (await portAvailable(candidate)) return candidate;
  }
  throw new Error(`端口区间 ${String(portFloor)} 起没有空闲端口`);
}

async function ledger(entry: Record<string, unknown>): Promise<void> {
  await writeFile(
    ledgerPath,
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    { flag: "a" },
  );
}

/** 素材清单：递归列出相对路径与内容摘要，用于证明原始素材不被触碰。 */
async function materialManifest(directory: string): Promise<string> {
  const entries = await collectFiles(directory, "");
  return entries
    .map((entry) => `${entry.relative} ${entry.digest}`)
    .toSorted()
    .join("\n");
}

async function collectFiles(
  directory: string,
  prefix: string,
): Promise<{ readonly relative: string; readonly digest: string }[]> {
  const found: { relative: string; digest: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${prefix === "" ? "" : "/"}${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectFiles(absolute, relative)));
      continue;
    }
    found.push({
      relative,
      digest: createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex"),
    });
  }
  return found;
}

async function readRecordFile(env: OwnedEnv): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(env.recordPath, "utf8")) as Record<
    string,
    unknown
  >;
}

/** 只改记录里被故意留下的中断现场，其余字段原样写回。 */
async function mutateRecord(
  env: OwnedEnv,
  change: (record: Record<string, unknown>) => void,
): Promise<void> {
  const record = await readRecordFile(env);
  change(record);
  await writeFile(env.recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

function prepareInput(
  env: OwnedEnv,
  inputs: readonly string[],
): {
  readonly workspacePath: string;
  readonly environment: string;
  readonly inputs: readonly string[];
  readonly config: { readonly [key: string]: JsonValue };
} {
  return {
    workspacePath: workspaceRoot,
    environment: env.name,
    inputs,
    config: { profile: env.name, webPort: env.port },
  };
}

/** 登记一个本轮自有环境：分配空闲端口并登记待回收的容器位置。 */
async function claimEnvironment(): Promise<OwnedEnv> {
  const name = `t04-${randomUUID().slice(0, 8)}`;
  const port = await freePort();
  const containerDirectory = path.join(
    workspaceRoot,
    ".digital",
    "environments",
    name,
  );
  const env: OwnedEnv = {
    name,
    port,
    containerDirectory,
    recordPath: path.join(containerDirectory, recordFileName),
    productDataRoot: path.join(containerDirectory, "product-data"),
  };
  ownedEnvironments.push(env);
  return env;
}

/** 在登记的自有环境上完成正式准备。 */
async function bringUp(inputs: readonly string[]): Promise<OwnedEnv> {
  const env = await claimEnvironment();
  const prepared = await prepareEnvironment(prepareInput(env, inputs));
  expect(
    prepared.status,
    `准备 ${env.name} 失败：${JSON.stringify(prepared.failure ?? {})}`,
  ).toBe("prepared");
  return env;
}

/** 该环境自有日志目录里的操作目录名。 */
async function logDirectories(env: OwnedEnv): Promise<string[]> {
  return readdir(path.join(env.containerDirectory, "logs"));
}

function lockFile(env: OwnedEnv): string {
  return path.join(workspaceRoot, ".digital", "locks", `${env.name}.flock`);
}

/** 记录里的私有运行目录；缺失即视为现场无法核验。 */
async function privateRunDirectory(env: OwnedEnv): Promise<string> {
  const record = await readRecordFile(env);
  const run = record["run"] as { privateDirectory?: string } | undefined;
  const directory = run?.privateDirectory;
  if (typeof directory !== "string")
    throw new Error(`环境 ${env.name} 的记录没有私有运行目录`);
  return directory;
}

async function startEnv(
  label: string,
  env: OwnedEnv,
): Promise<StartOperationResult> {
  // 授权区间落在系统临时端口区间内，本机其他连接也可能占用它：发起之前重新实测，
  // 给短暂的外部连接一个释放窗口，仍被占用就如实报告，不把明知被抢占的端口交给产品去撞。
  for (let probe = 1; probe <= 5; probe += 1) {
    if (await portAvailable(env.port)) break;
    if (probe === 5)
      throw new Error(
        `端口抢占：${env.name}／${label} 的端口 ${String(env.port)} 在发起启动前仍被外部连接占用；按已接受设计本环境不接管也不自动换端口`,
      );
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
  }
  const issuedAt = new Date().toISOString();
  const attempt: StartAttempt = { label, environment: env.name, issuedAt };
  startAttempts.push(attempt);
  await ledger({
    direction: "issued",
    label,
    environment: env.name,
    workspacePath: workspaceRoot,
    port: env.port,
    owner: "04 切片（worktree-04 作者树）",
    issuedAt,
  });
  const result = await startEnvironment({
    workspacePath: workspaceRoot,
    environment: env.name,
  });
  attempt.status = result.status;
  attempt.runId = result.run.runId;
  await ledger({
    direction: "result",
    label,
    environment: env.name,
    workspacePath: workspaceRoot,
    port: env.port,
    status: result.status,
    runId: result.run.runId,
    pid: result.run.pid,
    address: result.run.address,
  });
  return result;
}

async function stopEnv(env: OwnedEnv): Promise<StopOperationResult> {
  const result = await stopEnvironment({
    workspacePath: workspaceRoot,
    environment: env.name,
  });
  return result;
}

/** 生命周期结论断言：失败时把公开结果里的真实阶段与报文一起交出。 */
function expectLifecycleStatus(
  result: StartOperationResult | StopOperationResult,
  status: "ready" | "stopped",
): void {
  expect(result.status, JSON.stringify(result.failure ?? {})).toBe(status);
}

/**
 * 回收本行动自有、从未启动成功的准备现场：走公开删除接口，确认删除后才解除登记；
 * 未确认的现场一律留给 afterAll 按公开停止职责处理。
 */
async function discardPrepared(env: OwnedEnv): Promise<void> {
  const discarded = await deleteEnvironment(targetRequest(env));
  if (discarded.status !== "deleted") return;
  const index = ownedEnvironments.indexOf(env);
  if (index >= 0) ownedEnvironments.splice(index, 1);
}

/**
 * 准备并启动首个服务世代。授权端口区间与系统临时端口区间重叠，实测空闲的端口仍可能在
 * 产品绑定之前被本机其他连接占用；产品按已接受设计不接管也不自动换端口，因此如实登记
 * 占用事件、回收这个从未启动的自有现场，另起新环境名与重新实测空闲的端口重试一次。
 */
async function bringUpServing(
  label: string,
  inputs: readonly string[],
): Promise<{
  readonly env: OwnedEnv;
  readonly started: StartOperationResult;
}> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const env = await bringUp(inputs);
    try {
      const started = await startEnv(label, env);
      if (started.status === "ready") return { env, started };
      if (started.failure?.stage !== "port" || attempt === 2)
        throw new Error(
          `${label} 未就绪：${JSON.stringify(started.failure ?? {})}｜诊断 ${started.diagnostics.join("；") || "无"}`,
        );
      await ledger({
        direction: "port-squatted",
        label,
        environment: env.name,
        port: env.port,
        stage: "product-bind",
        message: started.failure.message,
      });
      await discardPrepared(env);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("端口抢占：") ||
        attempt === 2
      )
        throw error;
      await ledger({
        direction: "port-squatted",
        label,
        environment: env.name,
        port: env.port,
        stage: "before-start",
      });
      await discardPrepared(env);
    }
  }
  throw new Error(`${label} 未能建立服务世代`);
}

async function librarySummaries(port: number): Promise<LibraryView[]> {
  const listed = await createPublicApiClient({
    baseUrl: `http://127.0.0.1:${String(port)}`,
  }).listAssetLibraries({ limit: 100 });
  return listed.items.map(({ id, displayName, configVersion }) => ({
    id,
    displayName,
    configVersion,
  }));
}

/** 环境平台公开记录里的数据根；产品公共 API 不泄漏本地文件系统路径。 */
async function serviceDataDirectory(environment: string): Promise<string> {
  const inspection = await inspectEnvironment({
    workspacePath: workspaceRoot,
    environment,
  });
  return inspection.environment.productDataRoot;
}

/** 正式 HTTP 写入一项可读设置：新建资产库并绑定普通素材目录。 */
async function createLibrary(
  port: number,
  displayName: string,
  directory: string,
): Promise<LibraryView> {
  const created = await createPublicApiClient({
    baseUrl: `http://127.0.0.1:${String(port)}`,
  }).saveAssetLibrary({
    displayName,
    directories: [directory],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  return {
    id: created.id,
    displayName: created.displayName,
    configVersion: created.configVersion,
  };
}

/** 正式 HTTP 编辑同一项设置：改名后服务端版本号推进。 */
async function renameLibrary(
  port: number,
  library: LibraryView,
  displayName: string,
  directory: string,
): Promise<LibraryView> {
  const renamed = await createPublicApiClient({
    baseUrl: `http://127.0.0.1:${String(port)}`,
  }).saveAssetLibrary({
    id: library.id,
    expectedVersion: library.configVersion,
    displayName,
    directories: [directory],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  return {
    id: renamed.id,
    displayName: renamed.displayName,
    configVersion: renamed.configVersion,
  };
}

function expectStoppedObservation(
  observed: InspectEnvironmentResult,
  runId: string | null,
): void {
  expect(observed.state).toBe("prepared");
  expect(observed.run.runId).toBe(runId);
  expect(observed.run.state).toBe("stopped");
  expect(observed.run.processLiveness).toBe("exited");
  expect(observed.serviceReadiness).not.toBe("ready");
}

beforeAll(() => {
  for (const name of [
    "DIGITAL_PRODUCT_DATA",
    "DIGITAL_TMDB_ACCESS_TOKEN",
    "PORT",
    "NODE_OPTIONS",
  ])
    delete process.env[name];
});

afterAll(async () => {
  // 每个被启动过的世代都先经公开 stop 收尾，再用独立 inspect 确认真实退出。
  const unresolved: string[] = [];
  for (const name of new Set(startAttempts.map((a) => a.environment))) {
    const stop = await stopEnvironment({
      workspacePath: workspaceRoot,
      environment: name,
    });
    const observed = await inspectEnvironment({
      workspacePath: workspaceRoot,
      environment: name,
    });
    const confirmed =
      stop.status === "stopped" ||
      stop.status === "already-stopped" ||
      observed.state === "unmanaged";
    if (!confirmed)
      unresolved.push(
        `${name}：stop ${stop.status}，inspect ${observed.state} / ${observed.run.state} / ${observed.run.processLiveness}，日志 ${stop.logs.directory ?? "无"}`,
      );
  }
  // 只有确认收尾的环境才回收本轮自有容器；未知现场一律保留。
  for (const env of ownedEnvironments) {
    if (unresolved.some((line) => line.startsWith(`${env.name}：`))) continue;
    await rm(env.containerDirectory, { recursive: true, force: true });
  }
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
  if (unresolved.length > 0)
    throw new Error(
      `未能确认收尾的 04 世代（现场已保留）：${unresolved.join("；")}`,
    );
});

function cliTarget(env: OwnedEnv): string[] {
  return ["--environment", env.name, "--workspace-path", workspaceRoot];
}

function targetRequest(env: OwnedEnv) {
  return { workspacePath: workspaceRoot, environment: env.name };
}

describe("04-1 产品状态跨停止与启动保留", () => {
  it(
    "HTTP 设置写入与停机期间的正式产品写入在同配置准备后由重启服务读到同一值",
    async () => {
      const material = await temporaryDirectory("04-1-material-");
      const stoppedMaterial = await temporaryDirectory(
        "04-1-stopped-material-",
      );
      await writeFile(path.join(material, "保留素材.txt"), "保留内容");
      await writeFile(path.join(stoppedMaterial, "停机写入.txt"), "停机内容");
      const { env, started: first } = await bringUpServing("04-1 首次启动", [
        material,
      ]);
      expect(await realpath(await serviceDataDirectory(env.name))).toBe(
        await realpath(env.productDataRoot),
      );
      const created = await createLibrary(env.port, "04保留库", material);
      const edited = await renameLibrary(
        env.port,
        created,
        "04保留库已改名",
        material,
      );
      expect(edited.id).toBe(created.id);
      expect(edited.configVersion).toBeGreaterThan(created.configVersion);

      const stopped = await stopEnv(env);
      expect(stopped.status, JSON.stringify(stopped.failure ?? {})).toBe(
        "stopped",
      );
      const afterStop = await inspectEnvironment(targetRequest(env));
      expectStoppedObservation(afterStop, first.run.runId);
      // 停止只回收进程：产品数据与操作日志留在该环境自有容器内。
      expect(await logDirectories(env)).not.toEqual([]);

      // 停服后由调用方显式启动正式服务，经公开 API 写入并读回业务记录。
      const recorded = await createLibraryAndScan({
        workspacePath: workspaceRoot,
        environment: env.name,
        displayName: "04停机业务写入",
        directory: stoppedMaterial,
      });
      const executionId = recorded.executionId;
      expect(
        await workflowHistoryIds({
          workspacePath: workspaceRoot,
          environment: env.name,
        }),
      ).toContain(executionId);

      const reprepared = await prepareEnvironment(
        prepareInput(env, [material]),
      );
      expect(reprepared.status, JSON.stringify(reprepared.failure ?? {})).toBe(
        "prepared",
      );
      expect(reprepared.environment.environmentId).toBe(
        afterStop.environment.environmentId,
      );
      expect(reprepared.environment.dataGeneration).toBe(
        afterStop.environment.dataGeneration,
      );

      const restarted = await startEnv("04-1 重启", env);
      expect(restarted.status, JSON.stringify(restarted.failure ?? {})).toBe(
        "ready",
      );
      const kept = (await librarySummaries(env.port)).find(
        (item) => item.id === created.id,
      );
      expect(kept?.displayName).toBe("04保留库已改名");
      expect(kept?.configVersion).toBe(edited.configVersion);

      const closed = await stopEnv(env);
      expect(closed.status, JSON.stringify(closed.failure ?? {})).toBe(
        "stopped",
      );
      expectStoppedObservation(
        await inspectEnvironment(targetRequest(env)),
        restarted.run.runId,
      );
      expect(
        await workflowHistoryIds({
          workspacePath: workspaceRoot,
          environment: env.name,
        }),
      ).toContain(executionId);
    },
    realRunTimeout,
  );
});

describe("04-2 显式重建回到初态", () => {
  it(
    "已停止环境的重建保留普通输入与运行配置，回收自有数据并从空根完成正式构建、迁移与读取",
    async () => {
      const material = await temporaryDirectory("04-2-material-");
      const scanMaterial = await temporaryDirectory("04-2-scan-material-");
      await writeFile(path.join(material, "重建素材.txt"), "重建内容");
      await writeFile(path.join(scanMaterial, "待扫描.txt"), "待扫描内容");
      const { env } = await bringUpServing("04-2 写入前启动", [material]);
      const library = await createLibrary(env.port, "04待重建库", material);
      const stopped = await stopEnv(env);
      expectLifecycleStatus(stopped, "stopped");

      // 停服后由调用方显式启动正式服务扫描，作为重建前存在的产品数据。
      const recorded = await createLibraryAndScan({
        workspacePath: workspaceRoot,
        environment: env.name,
        displayName: "04重建前扫描",
        directory: scanMaterial,
      });
      const executionId = recorded.executionId;
      expect(
        await workflowHistoryIds({
          workspacePath: workspaceRoot,
          environment: env.name,
        }),
      ).toContain(executionId);

      const before = await inspectEnvironment(targetRequest(env));
      const logsBefore = await logDirectories(env);
      const rebuilt = await rebuildEnvironment(targetRequest(env));
      expect(rebuilt.status, JSON.stringify(rebuilt.failure ?? {})).toBe(
        "rebuilt",
      );
      expect(rebuilt.environment.inputs).toEqual(before.environment.inputs);
      expect(rebuilt.environment.config).toEqual(before.environment.config);
      expect(rebuilt.environment.environmentId).toBe(
        before.environment.environmentId,
      );
      expect(rebuilt.environment.dataGeneration).not.toBe(
        before.environment.dataGeneration,
      );
      // 重建只回收自有产品数据：原始素材与既有操作日志保留。
      expect(await materialManifest(material)).not.toBe("");
      expect(await materialManifest(scanMaterial)).not.toBe("");
      const logsAfter = await logDirectories(env);
      expect(logsAfter).toEqual(expect.arrayContaining(logsBefore));

      const afterRebuild = await startEnv("04-2 重建后启动", env);
      expect(
        afterRebuild.status,
        JSON.stringify(afterRebuild.failure ?? {}),
      ).toBe("ready");
      const listed = await librarySummaries(env.port);
      expect(listed.some((item) => item.id === library.id)).toBe(false);
      // 重建后的资料接入仍由调用方经正式入口发起，平台不自动写业务表。
      const fresh = await createLibrary(env.port, "04重建后新库", material);
      expect(fresh.id).not.toBe(library.id);

      const closed = await stopEnv(env);
      expectLifecycleStatus(closed, "stopped");
      // 正式产品读取确认回到空初态：旧设置与旧执行记录都不再存在。
      expect(
        await workflowHistoryIds({
          workspacePath: workspaceRoot,
          environment: env.name,
        }),
      ).toEqual([]);
      expect(
        await currentAssetCount({
          workspacePath: workspaceRoot,
          environment: env.name,
        }),
      ).toBe(0);
    },
    realRunTimeout,
  );

  it(
    "运行中的环境拒绝显式重建与删除，服务与数据原样保留",
    async () => {
      const material = await temporaryDirectory("04-2-busy-material-");
      await writeFile(path.join(material, "运行中素材.txt"), "运行中内容");
      const { env } = await bringUpServing("04-2 运行中拒绝", [material]);
      const library = await createLibrary(env.port, "04运行中库", material);

      const generationBefore = (await inspectEnvironment(targetRequest(env)))
        .environment.dataGeneration;
      const refusedRebuild = await rebuildEnvironment(targetRequest(env));
      expect(refusedRebuild.status).toBe("refused");
      expect(refusedRebuild.failure?.stage).toBe("generation");
      expect(refusedRebuild.failure?.message).toContain("先停止再重建");

      const refusedDelete = await deleteEnvironment(targetRequest(env));
      expect(refusedDelete.status).toBe("refused");
      expect(refusedDelete.failure?.stage).toBe("generation");
      expect(refusedDelete.failure?.message).toContain("先停止再删除");

      // 拒绝不改动任何保留内容：服务仍就绪、设置仍可读、世代未推进。
      const listed = await librarySummaries(env.port);
      expect(listed.find((item) => item.id === library.id)?.displayName).toBe(
        "04运行中库",
      );
      expect(await realpath(await serviceDataDirectory(env.name))).toBe(
        await realpath(env.productDataRoot),
      );
      const observed = await inspectEnvironment(targetRequest(env));
      expect(observed.serviceReadiness).toBe("ready");
      expect(observed.environment.dataGeneration).toBe(generationBefore);

      const closed = await stopEnv(env);
      expectLifecycleStatus(closed, "stopped");
    },
    realRunTimeout,
  );
});

describe("04-3 显式删除只回收该环境自有资源", () => {
  it(
    "已停止环境的删除回收记录、数据、日志与私有运行现场，重复删除结论明确",
    async () => {
      const material = await temporaryDirectory("04-3-material-");
      await writeFile(path.join(material, "删除素材.txt"), "删除内容");
      const { env } = await bringUpServing("04-3 删除前启动", [material]);
      const stopped = await stopEnv(env);
      expectLifecycleStatus(stopped, "stopped");

      const firstGeneration = await privateRunDirectory(env);
      expect(existsSync(firstGeneration)).toBe(true);
      expect(existsSync(env.productDataRoot)).toBe(true);

      // 停止保留的世代日志是删除要一并收回的对象：再起再停一个世代，制造两个私有运行目录。
      expectLifecycleStatus(await startEnv("04-3 删除前再起", env), "ready");
      expectLifecycleStatus(await stopEnv(env), "stopped");
      const secondGeneration = await privateRunDirectory(env);
      expect(secondGeneration).not.toBe(firstGeneration);
      expect(existsSync(firstGeneration)).toBe(true);
      expect(existsSync(secondGeneration)).toBe(true);

      const deleted = await deleteEnvironment(targetRequest(env));
      expect(deleted.status, JSON.stringify(deleted.failure ?? {})).toBe(
        "deleted",
      );
      // 成功的删除不夹带失败诊断：结论必须自洽。
      expect(
        deleted.diagnostics.filter((line) => line.includes("失败")),
        deleted.diagnostics.join("；"),
      ).toEqual([]);
      expect(existsSync(env.containerDirectory)).toBe(false);
      // 该环境私有运行命名空间内的每个世代目录都随删除收回。
      expect(existsSync(firstGeneration)).toBe(false);
      expect(existsSync(secondGeneration)).toBe(false);
      expect(existsSync(path.dirname(secondGeneration))).toBe(false);
      expect(existsSync(env.productDataRoot)).toBe(false);
      // 原始素材与工作区管理级锁文件不在回收范围内。
      expect(await materialManifest(material)).not.toBe("");
      expect(existsSync(lockFile(env))).toBe(true);

      const repeated = await deleteEnvironment(targetRequest(env));
      expect(repeated.status, JSON.stringify(repeated.failure ?? {})).toBe(
        "already-deleted",
      );
      const observed = await inspectEnvironment(targetRequest(env));
      expect(observed.state).toBe("unprepared");
    },
    realRunTimeout,
  );

  it(
    "收尾未确认的停止现场拒绝破坏，独立停止确认后才允许删除",
    async () => {
      const material = await temporaryDirectory("04-3-stopping-material-");
      await writeFile(path.join(material, "未确认素材.txt"), "未确认内容");
      const { env } = await bringUpServing("04-3 未确认现场", [material]);
      await stopEnv(env);
      // 人工把运行分支留在“正在停止”，模拟收尾未确认的现场。
      await mutateRecord(env, (record) => {
        (record["run"] as Record<string, unknown>)["state"] = "stopping";
      });

      const refusedRebuild = await rebuildEnvironment(targetRequest(env));
      expect(refusedRebuild.status).toBe("refused");
      expect(refusedRebuild.failure?.message).toContain("正在停止");
      const refusedDelete = await deleteEnvironment(targetRequest(env));
      expect(refusedDelete.status).toBe("refused");
      expect(refusedDelete.failure?.message).toContain("正在停止");
      // 拒绝即保留整个现场，不清空数据也不接管进程。
      expect(existsSync(env.recordPath)).toBe(true);
      expect(existsSync(env.productDataRoot)).toBe(true);

      const confirmed = await stopEnv(env);
      expect(["stopped", "already-stopped"]).toContain(confirmed.status);
      const deleted = await deleteEnvironment(targetRequest(env));
      expect(deleted.status, JSON.stringify(deleted.failure ?? {})).toBe(
        "deleted",
      );
    },
    realRunTimeout,
  );

  it(
    "未收敛的删除意图让启动与重建拒绝并被明确报出，显式删除完成收敛",
    async () => {
      const material = await temporaryDirectory("04-3-intent-material-");
      await writeFile(path.join(material, "意图素材.txt"), "意图内容");
      const env = await bringUp([material]);
      await mutateRecord(env, (record) => {
        record["destructive"] = {
          kind: "delete",
          operationId: "handset-delete",
          startedAt: new Date().toISOString(),
          targetDataGeneration: record["dataGeneration"],
          targetRunId: null,
        };
      });

      const observed = await inspectEnvironment(targetRequest(env));
      expect(observed.state).toBe("prepared");
      expect(observed.pendingIntent?.kind).toBe("delete");
      expect(observed.pendingIntent?.operationId).toBe("handset-delete");

      const refusedStart = await startEnvironment(targetRequest(env));
      expect(refusedStart.status).toBe("refused");
      expect(refusedStart.failure?.message).toContain("删除意图");
      const refusedRebuild = await rebuildEnvironment(targetRequest(env));
      expect(refusedRebuild.status).toBe("refused");
      expect(refusedRebuild.failure?.message).toContain("删除意图");
      expect(existsSync(env.recordPath)).toBe(true);

      const deleted = await deleteEnvironment(targetRequest(env));
      expect(deleted.status, JSON.stringify(deleted.failure ?? {})).toBe(
        "deleted",
      );
      expect(existsSync(env.containerDirectory)).toBe(false);
    },
    realRunTimeout,
  );
});

describe("04-4 跨归属隔离与原始素材不动", () => {
  it(
    "对 A 的重建与删除不影响仍在服务的 B，也不改动任何原始素材",
    async () => {
      const materialA = await temporaryDirectory("04-4-material-a-");
      const materialB = await temporaryDirectory("04-4-material-b-");
      await writeFile(path.join(materialA, "A素材.txt"), "A 内容");
      await writeFile(path.join(materialB, "B素材.txt"), "B 内容");
      const manifestA = await materialManifest(materialA);
      const manifestB = await materialManifest(materialB);

      const { env: envA } = await bringUpServing("04-4 A 首代", [materialA]);
      const { env: envB, started: startedB } = await bringUpServing(
        "04-4 B 持续服务",
        [materialB],
      );
      const libraryB = await createLibrary(envB.port, "04跨归属B库", materialB);
      await createLibrary(envA.port, "04待回收A库", materialA);
      const generationB = (await inspectEnvironment(targetRequest(envB)))
        .environment.dataGeneration;
      expectLifecycleStatus(await stopEnv(envA), "stopped");

      const rebuilt = await rebuildEnvironment(targetRequest(envA));
      expect(rebuilt.status, JSON.stringify(rebuilt.failure ?? {})).toBe(
        "rebuilt",
      );
      const deleted = await deleteEnvironment(targetRequest(envA));
      expect(deleted.status, JSON.stringify(deleted.failure ?? {})).toBe(
        "deleted",
      );

      // B 的真实服务持续且业务状态不变，读取仍来自 B 自有的产品数据根。
      const peer = await inspectEnvironment(targetRequest(envB));
      expect(peer.serviceReadiness).toBe("ready");
      expect(peer.environment.dataGeneration).toBe(generationB);
      expect(
        (await librarySummaries(envB.port)).find(
          (item) => item.id === libraryB.id,
        )?.displayName,
      ).toBe("04跨归属B库");
      expect(await realpath(await serviceDataDirectory(envB.name))).toBe(
        await realpath(envB.productDataRoot),
      );
      // 两侧的原始素材清单逐项不变。
      expect(await materialManifest(materialA)).toBe(manifestA);
      expect(await materialManifest(materialB)).toBe(manifestB);
      expect(existsSync(envB.containerDirectory)).toBe(true);

      expectLifecycleStatus(await stopEnv(envB), "stopped");
      expectStoppedObservation(
        await inspectEnvironment(targetRequest(envB)),
        startedB.run.runId,
      );
    },
    realRunTimeout,
  );
});

describe("04-5 不兼容与不可认领现场保留", () => {
  it(
    "输入配置不兼容与素材内容变化都保留旧状态，只有显式重建回到初态",
    async () => {
      const material = await temporaryDirectory("04-5-material-");
      await writeFile(path.join(material, "兼容素材.txt"), "兼容内容");
      const { env } = await bringUpServing("04-5 写入与拒绝", [material]);
      const library = await createLibrary(env.port, "04不兼容前写入", material);
      expectLifecycleStatus(await stopEnv(env), "stopped");
      const before = await inspectEnvironment(targetRequest(env));

      // 运行配置与已准备记录不一致：明示差异并保留旧状态。
      const incompatible = await prepareEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
        inputs: [material],
        config: { profile: "另一个配置", webPort: env.port },
      });
      expect(incompatible.status).toBe("config-incompatible");
      expect(incompatible.incompatibility).toContain("运行配置");
      const afterIncompatible = await inspectEnvironment(targetRequest(env));
      expect(afterIncompatible.state).toBe("prepared");
      expect(afterIncompatible.environment.dataGeneration).toBe(
        before.environment.dataGeneration,
      );

      // 素材内容变化不构成重建理由：同配置准备仍保留同一数据世代。
      await writeFile(path.join(material, "新增素材.txt"), "新增内容");
      const reprepared = await prepareEnvironment(
        prepareInput(env, [material]),
      );
      expect(reprepared.status, JSON.stringify(reprepared.failure ?? {})).toBe(
        "prepared",
      );
      expect(reprepared.environment.dataGeneration).toBe(
        before.environment.dataGeneration,
      );

      const restarted = await startEnv("04-5 保留后重启", env);
      expectLifecycleStatus(restarted, "ready");
      expect(
        (await librarySummaries(env.port)).find(
          (item) => item.id === library.id,
        )?.displayName,
      ).toBe("04不兼容前写入");
      expectLifecycleStatus(await stopEnv(env), "stopped");

      const rebuilt = await rebuildEnvironment(targetRequest(env));
      expect(rebuilt.status, JSON.stringify(rebuilt.failure ?? {})).toBe(
        "rebuilt",
      );
      expect(rebuilt.environment.dataGeneration).not.toBe(
        before.environment.dataGeneration,
      );
      const afterRebuild = await startEnv("04-5 重建后启动", env);
      expectLifecycleStatus(afterRebuild, "ready");
      expect(
        (await librarySummaries(env.port)).some(
          (item) => item.id === library.id,
        ),
      ).toBe(false);
      expectLifecycleStatus(await stopEnv(env), "stopped");
    },
    realRunTimeout,
  );

  it(
    "损坏或版本未知的记录被拒绝认领，原件、数据与容器一律保留",
    async () => {
      const material = await temporaryDirectory("04-5-corrupt-material-");
      await writeFile(path.join(material, "损坏素材.txt"), "损坏内容");
      const env = await bringUp([material]);
      const original = "这不是环境记录\n";
      await writeFile(env.recordPath, original);

      const observed = await inspectEnvironment(targetRequest(env));
      expect(observed.state).toBe("unmanaged");
      expect(observed.reason).toContain("损坏或版本未知");

      const prepared = await prepareEnvironment(prepareInput(env, [material]));
      expect(prepared.status).toBe("unmanaged");
      expect(prepared.failure?.message).toContain("保留原件不接管");
      const rebuilt = await rebuildEnvironment(targetRequest(env));
      expect(rebuilt.status).toBe("unmanaged");
      const deleted = await deleteEnvironment(targetRequest(env));
      expect(deleted.status).toBe("unmanaged");

      // 不自动清空、不认领：坏记录原件与产品数据都原样在位。
      expect(await readFile(env.recordPath, "utf8")).toBe(original);
      expect(existsSync(env.productDataRoot)).toBe(true);
      expect(await materialManifest(material)).not.toBe("");
    },
    realRunTimeout,
  );
});

describe("04-6 公开 API 与独立 CLI 全流程", () => {
  it(
    "独立 CLI 完成准备、启动、拒绝、停止、重建、删除与重复删除并给出稳定退出码",
    async () => {
      const material = await temporaryDirectory("04-6-material-");
      await writeFile(path.join(material, "CLI素材.txt"), "CLI 内容");
      const manifest = await materialManifest(material);
      const env = await claimEnvironment();
      const config = JSON.stringify({ profile: env.name, webPort: env.port });

      const prepared = await cli([
        "prepare",
        ...cliTarget(env),
        "--input",
        material,
        "--config-json",
        config,
      ]);
      expect(prepared.code, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
      expect(reportedStatus(prepared.payload)).toBe("prepared");

      const started = await cli(["start", ...cliTarget(env)]);
      expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
      expect(reportedStatus(started.payload)).toBe("ready");
      startAttempts.push({
        label: "04-6 CLI 启动",
        environment: env.name,
        issuedAt: new Date().toISOString(),
        status: "ready",
      });

      const busy = await cli(["rebuild", ...cliTarget(env)]);
      expect(busy.code, `${busy.stdout}\n${busy.stderr}`).toBe(1);
      expect(reportedStatus(busy.payload)).toBe("refused");
      expect(existsSync(path.join(material, "CLI素材.txt"))).toBe(true);

      const stopped = await cli(["stop", ...cliTarget(env)]);
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      expect(reportedStatus(stopped.payload)).toBe("stopped");

      const rebuilt = await cli(["rebuild", ...cliTarget(env)]);
      expect(rebuilt.code, `${rebuilt.stdout}\n${rebuilt.stderr}`).toBe(0);
      expect(reportedStatus(rebuilt.payload)).toBe("rebuilt");

      const deleted = await cli(["delete", ...cliTarget(env)]);
      expect(deleted.code, `${deleted.stdout}\n${deleted.stderr}`).toBe(0);
      expect(reportedStatus(deleted.payload)).toBe("deleted");
      expect(existsSync(env.containerDirectory)).toBe(false);

      const repeated = await cli(["delete", ...cliTarget(env)]);
      expect(repeated.code, `${repeated.stdout}\n${repeated.stderr}`).toBe(0);
      expect(reportedStatus(repeated.payload)).toBe("already-deleted");

      const observed = await cli(["inspect", ...cliTarget(env)]);
      expect(observed.code, `${observed.stdout}\n${observed.stderr}`).toBe(0);
      expect(
        ((observed.payload["data"] ?? {}) as Record<string, unknown>)["state"],
      ).toBe("unprepared");

      // 素材不受影响，用法错误与无效来源模式各自给出明确结论。
      expect(await materialManifest(material)).toBe(manifest);
      const missingArgument = await cli(["rebuild"]);
      expect(missingArgument.code).toBe(2);
      const unsupportedSource = await cli([
        "prepare",
        ...cliTarget(env),
        "--source-mode",
        "controlled",
        "--config-json",
        config,
      ]);
      expect(unsupportedSource.code, unsupportedSource.stdout).toBe(5);
      expect(reportedStatus(unsupportedSource.payload)).toBe("invalid-request");
    },
    realRunTimeout,
  );
});

describe("04-R 修复反例：日志根重定向与部分回收后的重入", () => {
  /** 把删除或重建意图写进记录，形状与 04-3 的未收敛意图用例一致。 */
  async function plantIntent(
    env: OwnedEnv,
    kind: "delete" | "rebuild",
  ): Promise<void> {
    await mutateRecord(env, (record) => {
      record["destructive"] = {
        kind,
        operationId: `repair-1-${kind}`,
        startedAt: new Date().toISOString(),
        targetDataGeneration: record["dataGeneration"],
        targetRunId: null,
      };
    });
  }

  /** 按候选里 `rm(root,{recursive:true})` 留下的形状构造残余：catalogue 已消失、根尚有子项。 */
  async function makeResidueRoot(env: OwnedEnv): Promise<string> {
    const catalogue = path.join(env.productDataRoot, "catalogue.sqlite");
    await rm(catalogue, { force: true });
    const residue = path.join(env.productDataRoot, "回收未完成子项");
    await mkdir(residue, { recursive: true, mode: 0o700 });
    await writeFile(path.join(residue, "剩余.txt"), "上次回收未完成的残余");
    return catalogue;
  }

  it(
    "日志根被预先重定向到输入素材时，重建与删除都在第一次日志写入之前拒绝且素材不变",
    async () => {
      const material = await temporaryDirectory("04-r-c01-material-");
      await writeFile(path.join(material, "重定向素材.txt"), "重定向内容");
      const env = await bringUp([material]);
      const manifestBefore = await materialManifest(material);
      // 容器与记录身份都仍然可信，只有日志根被换成指向素材的符号链接。
      const logsRoot = path.join(env.containerDirectory, "logs");
      await rm(logsRoot, { recursive: true, force: true });
      await symlink(material, logsRoot);
      const recordBefore = await readRecordFile(env);

      const rebuilt = await rebuildEnvironment(targetRequest(env));
      expect(rebuilt.status, JSON.stringify(rebuilt.failure ?? {})).toBe(
        "unmanaged",
      );
      expect(rebuilt.failure?.stage).toBe("claim");
      expect(rebuilt.failure?.message).toContain("日志目录");
      expect(rebuilt.logs.directory).toBeNull();

      const deleted = await deleteEnvironment(targetRequest(env));
      expect(deleted.status, JSON.stringify(deleted.failure ?? {})).toBe(
        "unmanaged",
      );
      expect(deleted.failure?.stage).toBe("claim");
      expect(deleted.failure?.message).toContain("日志目录");

      // 两次拒绝都发生在任何日志写入之前：素材清单逐项不变，记录与产品数据原样保留。
      expect(await materialManifest(material)).toBe(manifestBefore);
      expect(await readRecordFile(env)).toEqual(recordBefore);
      expect(existsSync(env.productDataRoot)).toBe(true);
      // 重定向链接本身不被认领也不被跟进清理；恢复成自有目录后显式删除照常收敛。
      expect(await realpath(logsRoot)).toBe(await realpath(material));
      await unlink(logsRoot);
      await mkdir(logsRoot, { mode: 0o700 });
      const discarded = await deleteEnvironment(targetRequest(env));
      expect(discarded.status, JSON.stringify(discarded.failure ?? {})).toBe(
        "deleted",
      );
    },
    realRunTimeout,
  );

  it(
    "自有数据根被上次回收删成残余后，重复显式重建与重复显式删除都能从公开入口收敛",
    async () => {
      const material = await temporaryDirectory("04-r-f1-material-");
      await writeFile(path.join(material, "残余素材.txt"), "残余内容");
      const { env } = await bringUpServing("04-R F1 残余前写入", [material]);
      const library = await createLibrary(env.port, "04残余前库", material);
      expectLifecycleStatus(await stopEnv(env), "stopped");
      const generationBefore = (await inspectEnvironment(targetRequest(env)))
        .environment.dataGeneration;
      const manifestBefore = await materialManifest(material);

      // 正式迁移建立的 catalogue 先在位，再按候选同一回收失败后的形状只剩残余。
      const catalogue = await makeResidueRoot(env);
      expect(existsSync(catalogue)).toBe(false);
      await plantIntent(env, "rebuild");

      const rebuilt = await rebuildEnvironment(targetRequest(env));
      expect(rebuilt.status, JSON.stringify(rebuilt.failure ?? {})).toBe(
        "rebuilt",
      );
      expect(rebuilt.environment.dataGeneration).not.toBe(generationBefore);
      // 初态由正式构建/迁移/读取重新建立：catalogue 由产品自己写回，平台不补表。
      expect(existsSync(catalogue)).toBe(true);
      const afterRebuild = await startEnv("04-R F1 重建后启动", env);
      expectLifecycleStatus(afterRebuild, "ready");
      expect(
        (await librarySummaries(env.port)).some(
          (item) => item.id === library.id,
        ),
      ).toBe(false);
      expectLifecycleStatus(await stopEnv(env), "stopped");

      // 同一形状的残余交给重复显式删除：收回残余与记录，重复删除结论明确。
      await makeResidueRoot(env);
      await plantIntent(env, "delete");
      const deleted = await deleteEnvironment(targetRequest(env));
      expect(deleted.status, JSON.stringify(deleted.failure ?? {})).toBe(
        "deleted",
      );
      expect(existsSync(env.containerDirectory)).toBe(false);
      const repeated = await deleteEnvironment(targetRequest(env));
      expect(repeated.status, JSON.stringify(repeated.failure ?? {})).toBe(
        "already-deleted",
      );
      expect(await materialManifest(material)).toBe(manifestBefore);
    },
    realRunTimeout,
  );

  it(
    "已有删除意图但产品根被重定向到无 Catalogue 的外部目录时拒绝认领，外部目录未被回收",
    async () => {
      const material = await temporaryDirectory("04-r-f1-foreign-material-");
      await writeFile(path.join(material, "外部归属素材.txt"), "外部归属内容");
      const external = await temporaryDirectory("04-r-f1-external-root-");
      await writeFile(path.join(external, "外部自有.txt"), "外部内容");
      const env = await bringUp([material]);
      await rm(env.productDataRoot, { recursive: true, force: true });
      await symlink(external, env.productDataRoot);
      await plantIntent(env, "delete");

      const refused = await deleteEnvironment(targetRequest(env));
      expect(refused.status, JSON.stringify(refused.failure ?? {})).toBe(
        "refused",
      );
      expect(refused.failure?.stage).toBe("offline");
      // 残余分支不因为「缺 catalogue」就跳过归属：外部目录一个字节都没被改动。
      expect(await readdir(external)).toEqual(["外部自有.txt"]);
      expect(await readFile(path.join(external, "外部自有.txt"), "utf8")).toBe(
        "外部内容",
      );
      expect(existsSync(env.recordPath)).toBe(true);

      await unlink(env.productDataRoot);
      await mkdir(env.productDataRoot, { mode: 0o700 });
      const deleted = await deleteEnvironment(targetRequest(env));
      expect(deleted.status, JSON.stringify(deleted.failure ?? {})).toBe(
        "deleted",
      );
    },
    realRunTimeout,
  );

  it(
    "真实外部写入者存活时即使已有删除意图仍明确拒绝，其退出后同一命令才收敛",
    async () => {
      const material = await temporaryDirectory("04-r-writer-material-");
      await writeFile(path.join(material, "写入者素材.txt"), "写入者内容");
      const env = await bringUp([material]);
      const manifestBefore = await materialManifest(material);
      await plantIntent(env, "delete");

      const port = await freePort();
      const writer = spawn(
        process.execPath,
        [path.join(workspaceRoot, serviceEntry)],
        {
          cwd: workspaceRoot,
          env: {
            ...cleanEnvironment(),
            DIGITAL_PRODUCT_DATA: env.productDataRoot,
            PORT: String(port),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let writerOutput = "";
      writer.stdout.setEncoding("utf8");
      writer.stderr.setEncoding("utf8");
      writer.stdout.on("data", (chunk: string) => {
        writerOutput += chunk;
      });
      writer.stderr.on("data", (chunk: string) => {
        writerOutput += chunk;
      });
      const listeningBefore = Date.now();
      while (!/Listening on|已就绪/u.test(writerOutput)) {
        if (Date.now() - listeningBefore > 60_000) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }
      await ledger({
        direction: "external-writer",
        label: "04-R 管理器外写入者",
        environment: env.name,
        workspacePath: workspaceRoot,
        port,
        phase: "started",
        outputExcerpt: writerOutput.slice(0, 200),
      });

      const refused = await deleteEnvironment(targetRequest(env));
      expect(refused.status, JSON.stringify(refused.failure ?? {})).toBe(
        "refused",
      );
      expect(refused.failure?.stage).toBe("offline");
      expect(refused.failure?.message).toContain("离线核验未成功");
      // 拒绝保留整个现场：记录、数据与素材都不动，日志按正常归属写在自己的容器里。
      expect(existsSync(env.recordPath)).toBe(true);
      expect(existsSync(env.productDataRoot)).toBe(true);
      expect(await logDirectories(env)).not.toEqual([]);
      expect(await materialManifest(material)).toBe(manifestBefore);

      writer.kill("SIGTERM");
      const writerExit = await new Promise<number | null>((resolve) => {
        writer.once("close", resolve);
      });
      await ledger({
        direction: "external-writer",
        label: "04-R 管理器外写入者",
        environment: env.name,
        workspacePath: workspaceRoot,
        port,
        phase: "exited",
        exitCode: writerExit,
      });

      // 唯一变化是写入者退出：同一条显式删除随即完成收敛，证明拒绝原因就是活跃使用。
      const deleted = await deleteEnvironment(targetRequest(env));
      expect(deleted.status, JSON.stringify(deleted.failure ?? {})).toBe(
        "deleted",
      );
      expect(existsSync(env.containerDirectory)).toBe(false);
      expect(await materialManifest(material)).toBe(manifestBefore);
    },
    realRunTimeout,
  );
});
