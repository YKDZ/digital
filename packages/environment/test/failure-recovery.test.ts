import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  createReadStream,
  readdirSync,
  readFileSync,
} from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import {
  connect as netConnect,
  createServer as createNetServer,
} from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspectEnvironment,
  prepareEnvironment,
  startEnvironment,
  stopEnvironment,
  type InspectEnvironmentResult,
  type PrepareOperationResult,
  type StartOperationResult,
  type StopOperationResult,
} from "../src/index.ts";
import {
  productDataDirectorySegment,
  recordFileName,
} from "../src/internal/paths.ts";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const environmentCli = path.join("packages", "environment", "dist", "cli.js");
const productCli = path.join("apps", "cli", "dist", "cli.js");
/** 本回合可控端口只取 34001–34999，先确认真实空闲再登记使用。 */
const portFloor = 34_001;
const portCeiling = 34_999;
const realRunTimeout = 600_000;
/** 产品自身的终止宽限是 30 秒；确认收尾按同一预算加余量有界等待，不降低产品阈值。 */
const productCloseAllowanceMilliseconds = 50_000;
/**
 * 一个世代从启动到取得发布确认的真实耗时并不可控（同一环境里既观察到半秒，也观察到
 * 三十秒），所以所有「打断进行中的操作」都按事件触发并允许有界重试：抢不过真实完成的
 * 那一次如实记下，收回现场后重来，绝不把已经完成的启动说成被打断。
 */
const interruptRounds = 5;
/**
 * 就绪事实的提交在毫秒级窗口内完成：这组用例按事件触发中断并允许更多轮次，抢不过那一侧
 * 的轮次只如实记下事实，绝不把没抓到说成没有发生。
 */
const boundaryRounds = 8;
/** 本产品进程未经发布确认时的自行收尾界限，用于证明补齐后的世代不再被它关闭。 */
const leftoverSelfStopGraceMilliseconds = 5_000;

type CommandResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** 独立 CLI 进程：与测试进程内的公开接口调用完全分离，可被真实信号中断。 */
type LaunchedCli = {
  readonly child: ChildProcess;
  readonly done: Promise<CommandResult>;
};

type CliEnvelope = {
  status: string;
  failure?: { stage: string; message: string };
  cleanup?: { state: string };
  run?: { runId: string | null; state: string; processLiveness: string };
  diagnostics?: string[];
};

type RecordFile = {
  environmentId: string;
  createdAt: string;
  containerIdentity: { device: number; inode: number };
  preparation: {
    state: string;
    lastOperationId: string;
    lastFailure?: { stage: string; message: string; cleanup: string };
  };
  run?: {
    runId: string;
    state: string;
    processIdentity?: { pid: number };
    productLogFile: string;
    startOperationId?: string;
    ended?: { at: string; code: number | null; signal: string | null };
    lastFailure?: { stage: string; message: string };
  };
};

type Scene = {
  readonly name: string;
  readonly port: number;
  readonly containerDirectory: string;
  readonly productDataRoot: string;
};

const createdContainers: string[] = [];
const temporaryDirectories: string[] = [];
let scene!: Scene;
/** 现场里写入的一条真实业务记录：每次中断与重启都按它核对产品数据不被重置。 */
let businessRecord = { scanId: "", libraryId: "", executionId: "" };

/** 只引用现场登记的工作区与环境名，公开接口调用都从这里取。 */
function sceneRef(): {
  readonly workspacePath: string;
  readonly environment: string;
} {
  return { workspacePath: workspaceRoot, environment: scene.name };
}

function scenePrepare(): {
  readonly workspacePath: string;
  readonly environment: string;
  readonly config: {
    readonly profile: "running-service";
    readonly webPort: number;
  };
} {
  return {
    ...sceneRef(),
    config: { profile: "running-service", webPort: scene.port },
  };
}

/**
 * 本文件发出的每一发 start 都必须在请求离开之前登记：后续取消、抛错或断言失败
 * 都不能让世代变成没人认领的现场。收尾只按登记走公开停止接口。
 */
type StartAttempt = {
  readonly label: string;
  readonly environment: string;
  readonly issuedAt: string;
  status?: string;
  runId?: string | null;
};

const startAttempts: StartAttempt[] = [];

function beginStart(label: string, environment: string): StartAttempt {
  const attempt: StartAttempt = {
    label,
    environment,
    issuedAt: new Date().toISOString(),
  };
  startAttempts.push(attempt);
  return attempt;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function observeStart(
  attempt: StartAttempt,
  result: { readonly status: string; readonly run: { runId: string | null } },
): void {
  attempt.status = result.status;
  attempt.runId = result.run.runId;
}

async function startRegistered(label: string): Promise<StartOperationResult> {
  const attempt = beginStart(label, scene.name);
  try {
    const result = await startEnvironment(sceneRef());
    observeStart(attempt, result);
    return result;
  } catch (error) {
    attempt.status = `调用抛出：${describeFailure(error)}`;
    throw error;
  }
}

function cleanEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
}

async function run(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}): Promise<CommandResult> {
  const child = spawn(input.command, [...input.args], {
    cwd: workspaceRoot,
    env: input.env ?? cleanEnvironment(),
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
  const { code, signal } = await new Promise<CommandResult>((resolve) => {
    child.once("close", (exitCode, exitSignal) =>
      resolve({ code: exitCode, signal: exitSignal, stdout, stderr }),
    );
  });
  return { code, signal, stdout, stderr };
}

/**
 * 以独立进程启动环境 CLI。`detached` 让它自成一个进程组，因此可以对整组发出真实
 * 终止信号，模拟终端 Ctrl-C 同时命中外层命令与持锁操作进程。
 */
function launchEnvironmentCli(
  args: readonly string[],
  options: { readonly detached?: boolean } = {},
): LaunchedCli {
  const child = spawn(process.execPath, [environmentCli, ...args], {
    cwd: workspaceRoot,
    env: cleanEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: options.detached === true,
  });
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
  const done = new Promise<CommandResult>((resolve) => {
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  return { child, done };
}

/**
 * 只向本回合自己启动的进程组发真实终止信号，绝不按端口或猜测的 PID 发信号。
 * 交出信号是否真的送达：整组已经不存在时不伪造中断。
 */
function signalOwnProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  const groupId = child.pid;
  if (groupId === undefined) return false;
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    )
      return false;
    throw error;
  }
}

/**
 * 等到本回合自己启动的独立进程确实成为组长：`setsid` 之后 `kill(-pid, 0)` 才找得到该
 * 进程组。未成组时绝不发组信号，既不向尚未独立的进程伪造中断，也不会误及测试进程自己
 * 的进程组。
 */
async function ownGroupReady(child: ChildProcess): Promise<boolean> {
  const groupId = child.pid;
  if (groupId === undefined) return false;
  return await waitFor(
    async () => {
      try {
        process.kill(-groupId, 0);
        return true;
      } catch {
        return false;
      }
    },
    5_000,
    2,
  );
}

/** CLI 的结构化结果只有一行：成功走标准输出，失败走标准错误。两条通道都读。 */
function tryEnvelope(answer: CommandResult): CliEnvelope | undefined {
  const line = [
    ...answer.stdout.split("\n"),
    ...answer.stderr.split("\n"),
  ].find((item) => item.startsWith("{"));
  if (line === undefined) return undefined;
  try {
    return (JSON.parse(line) as { data: CliEnvelope }).data;
  } catch {
    return undefined;
  }
}

function envelope(answer: CommandResult, context: string): CliEnvelope {
  const data = tryEnvelope(answer);
  if (data === undefined)
    throw new Error(
      `独立 CLI 未交出结构化结果：${context}\n标准输出 ${answer.stdout}\n标准错误 ${answer.stderr}`,
    );
  return data;
}

/** 原始输出可能很长：重试记录只留足以核对的两端片段。 */
function shorten(answer: CommandResult): string {
  const text = `${answer.stdout}${answer.stderr}`.replace(/\s+/gu, " ");
  return text.length <= 400
    ? text
    : `${text.slice(0, 200)} … ${text.slice(-180)}`;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function portOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = netConnect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function freePortInRange(): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const port =
      portFloor + Math.floor(Math.random() * (portCeiling - portFloor + 1));
    if (await portOpen(port)) continue;
    const probe = createNetServer();
    const usable = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen({ port, host: "127.0.0.1" }, () => {
        resolve(true);
      });
    });
    if (!usable) continue;
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });
    return port;
  }
  throw new Error("34001–34999 端口区间内没有可用空闲端口");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readRecordFileAt(
  containerDirectory: string,
): Promise<RecordFile> {
  return JSON.parse(
    await readFile(path.join(containerDirectory, recordFileName), "utf8"),
  ) as RecordFile;
}

async function readRecordFile(): Promise<RecordFile> {
  return await readRecordFileAt(scene.containerDirectory);
}

/** 阶段日志的起始行由命令自己写下：ISO 时间戳固定 24 个字符。 */
const stageRunLine = /^.{24} run /mu;

/**
 * 本回合是否已把第一个阶段命令交给系统：记录写下本次操作，其构建日志记下起始行。
 * 起始行与 spawn 处在同一个同步块内，因此看到它就说明自有子进程已经存在，此时取消
 * 才会落在真实收尾路径上，而不是落在「尚未启动」的空档里。
 */
async function buildStageChildStarted(): Promise<boolean> {
  const record = await readRecordFileAt(scene.containerDirectory).catch(
    () => undefined,
  );
  if (record?.preparation.lastOperationId === undefined) return false;
  const content = await readFile(
    path.join(
      scene.containerDirectory,
      "logs",
      record.preparation.lastOperationId,
      "build.log",
    ),
    "utf8",
  ).catch(() => "");
  return stageRunLine.test(content);
}

/**
 * 本世代是否已进入「自有子进程存在、发布确认尚未取得」的在途窗口：环境记录里出现一个
 * 与先前不同的 `starting` 世代身份，就是这一刻的真实证据。
 */
async function unpublishedGenerationUnderWay(
  priorRunId: string | null,
): Promise<boolean> {
  const record = await readRecordFile().catch(() => undefined);
  return (
    record?.run !== undefined &&
    record.run.runId !== priorRunId &&
    record.run.state === "starting" &&
    record.run.processIdentity !== undefined
  );
}

/**
 * 就绪事实的原子发布只有一个瞬间：`rename`。同目录临时文件里先出现 `ready`（它之前），
 * 正式记录里随后出现同一世代（它之后）。判定落在哪一侧就断言哪一条合同。
 */
type CommitSide = "before-rename" | "after-rename";

function readTextQuietly(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** 只认记录里真实存在的就绪世代，读不出或还没写完都算「此刻看不到」。 */
function readyGeneration(
  text: string | undefined,
  priorRunId: string | null,
): string | undefined {
  if (text === undefined) return undefined;
  let parsed: RecordFile;
  try {
    parsed = JSON.parse(text) as RecordFile;
  } catch {
    return undefined;
  }
  return parsed.run !== undefined &&
    parsed.run.state === "ready" &&
    parsed.run.runId !== priorRunId
    ? parsed.run.runId
    : undefined;
}

/** 紧贴事件边界的同步轮询：只用于把中断压进毫秒级窗口，不代替真实等待。 */
async function spinUntil(
  observe: () => boolean,
  deadlineMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMilliseconds;
  for (;;) {
    if (observe()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * 打开管道让被挡住的写方得以继续，并把它写下的每一行原样交出（写方关闭句柄即读到结尾）。
 * 只用于本测试自己建立的延迟边界：有界等待，绝不把「读不到」当成「没写过」。
 */
function drainStagePipe(
  filePath: string,
  deadlineMilliseconds: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const chunks: string[] = [];
    const timer = setTimeout(() => {
      stream.destroy();
      reject(
        new Error(
          `${filePath}：放行读者之后 ${String(
            deadlineMilliseconds,
          )} 毫秒内没有读到写方结束`,
        ),
      );
    }, deadlineMilliseconds);
    timer.unref();
    stream.on("data", (chunk) => {
      chunks.push(chunk.toString());
    });
    stream.on("end", () => {
      clearTimeout(timer);
      resolve(chunks.join(""));
    });
    stream.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * 观察一次公开启动里就绪事实的提交瞬间：先按 20 毫秒轮询等本世代身份进入记录，再按 25
 * 毫秒轮询等产品自己回答 `/api/ready`（产品只在被准许进入正式入口之后才回答就绪，所以
 * 这一步把紧贴轮询对准了提交之前的一小段），最后同步轮询 `rename` 两侧。全程只读公开
 * 落盘事实，不干预操作本身。
 */
async function catchReadyCommit(
  priorRunId: string | null,
  stopAt: CommitSide,
): Promise<
  | { readonly side: CommitSide; readonly runId: string }
  | { readonly side: "missed" }
> {
  if (
    !(await waitFor(
      () => unpublishedGenerationUnderWay(priorRunId),
      90_000,
      20,
    ))
  )
    return { side: "missed" };
  const serving = await waitFor(
    async () => (await readyProbeStatus(scene.port)) === 200,
    90_000,
    25,
  );
  if (!serving) return { side: "missed" };
  const recordPath = path.join(scene.containerDirectory, recordFileName);
  let caught: { side: CommitSide; runId: string } | undefined;
  await spinUntil(() => {
    const committed = readyGeneration(readTextQuietly(recordPath), priorRunId);
    if (committed !== undefined) {
      caught = { side: "after-rename", runId: committed };
      return true;
    }
    if (stopAt === "after-rename") return false;
    let names: string[];
    try {
      names = readdirSync(scene.containerDirectory);
    } catch {
      return false;
    }
    for (const name of names) {
      if (!name.startsWith(`${recordFileName}.`) || !name.endsWith(".tmp"))
        continue;
      const staged = readyGeneration(
        readTextQuietly(path.join(scene.containerDirectory, name)),
        priorRunId,
      );
      if (staged === undefined) continue;
      caught = { side: "before-rename", runId: staged };
      return true;
    }
    return false;
  }, 3_000);
  return caught ?? { side: "missed" };
}

async function readOperationLog(result: {
  readonly logs: { readonly files: readonly string[] };
}): Promise<string> {
  return (
    await Promise.all(
      result.logs.files.map((file) => readFile(file, "utf8").catch(() => "")),
    )
  ).join("\n");
}

/** 有界等待真实世界状态成立；到点仍不成立就是失败，不做无界等待。 */
async function waitFor(
  observe: () => Promise<boolean>,
  deadlineMilliseconds: number,
  intervalMilliseconds = 250,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMilliseconds;
  for (;;) {
    if (await observe()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMilliseconds));
  }
}

async function closePort(port: number): Promise<boolean> {
  return await waitFor(
    async () => !(await portOpen(port)),
    productCloseAllowanceMilliseconds,
  );
}

/** 只按记录里已核验归属的进程身份确认本世代是否还在，不按端口推断。 */
async function processPresent(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 写入一条真实业务记录，交出后续从公开接口读回它所需的定位信息。 */
async function recordLibraryScan(
  label: string,
): Promise<typeof businessRecord> {
  const material = await temporaryDirectory("digital-05-material-");
  const created = await run({
    command: process.execPath,
    args: [
      path.join(workspaceRoot, productCli),
      "library-create",
      label,
      "--directory",
      material,
      "--json",
    ],
    env: { ...cleanEnvironment(), DIGITAL_PRODUCT_DATA: scene.productDataRoot },
  });
  expect(created.code, created.stderr).toBe(0);
  const library = (JSON.parse(created.stdout) as { id: string }).id;
  const scan = await run({
    command: process.execPath,
    args: [
      path.join(workspaceRoot, productCli),
      "scan-library",
      library,
      "--preview",
      "--json",
    ],
    env: { ...cleanEnvironment(), DIGITAL_PRODUCT_DATA: scene.productDataRoot },
  });
  expect(scan.code, scan.stderr).toBe(0);
  const recorded = JSON.parse(scan.stdout) as {
    parentExecutionId: string;
    assetLibraryId: string;
    directories: { childExecutionId?: string }[];
  };
  const executionId = recorded.directories.find(
    (directory) => directory.childExecutionId !== undefined,
  )?.childExecutionId;
  expect(executionId, scan.stdout).not.toBeUndefined();
  return {
    scanId: recorded.parentExecutionId,
    libraryId: recorded.assetLibraryId,
    executionId: executionId!,
  };
}

async function workflowHistoryIds(): Promise<string[]> {
  const read = await run({
    command: process.execPath,
    args: [
      path.join(workspaceRoot, productCli),
      "catalogue-surface",
      "--surface",
      "workflow-history",
    ],
    env: { ...cleanEnvironment(), DIGITAL_PRODUCT_DATA: scene.productDataRoot },
  });
  expect(read.code, read.stderr).toBe(0);
  const page = JSON.parse(read.stdout) as {
    items: { execution: { id: string } }[];
  };
  return page.items.map((item) => item.execution.id);
}

async function httpGet(
  port: number,
  requestPath: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const handle = request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
        agent: false,
      },
      (incoming) => {
        const chunks: string[] = [];
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          chunks.push(chunk);
        });
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: chunks.join(""),
          }),
        );
      },
    );
    handle.on("error", reject);
    handle.end();
  });
}

/** 每一次打断之后都按公开接口把现场收干净，再形成下一次在途窗口。 */
async function convergeScene(notes: string[], label: string): Promise<void> {
  const stopped = await stopEnvironment(sceneRef());
  notes.push(
    `${label}：公开停止 ${stopped.status} 记录 ${stopped.run.state} 进程 ${
      stopped.run.processLiveness
    } 收尾 ${stopped.cleanup.state}`,
  );
  expect(
    await closePort(scene.port),
    `${label}：公开停止之后约定端口 ${String(scene.port)} 仍未收回`,
  ).toBe(true);
}

/**
 * 产品数据只在没有并发写入者的时候读回：先按公开接口收回仍归产品持有的世代，再核对
 * 现场一项不动，不把「服务还在运行」当成读取失败的理由。
 */
async function stopAndReadProductData(label: string): Promise<string[]> {
  const closed = await stopEnvironment(sceneRef());
  console.log(
    `05 ${label}：公开停止 ${closed.status} 记录 ${closed.run.state} 进程 ${
      closed.run.processLiveness
    } 收尾 ${closed.cleanup.state}`,
  );
  expect(
    await closePort(scene.port),
    `${label}：公开停止之后约定端口 ${String(scene.port)} 仍未收回`,
  ).toBe(true);
  return await workflowHistoryIds();
}

/**
 * 公开准备接口施加真实绝对期限：期限由持锁操作进程按同一绝对终点自己执行。只有期限
 * 确实落在已经把阶段命令交给系统的窗口里才算形成证据；先一步完成的那一次如实记下再试。
 */
async function preparePastDeadline(timeoutMs: number): Promise<{
  readonly result: PrepareOperationResult;
  readonly notes: string[];
}> {
  const notes: string[] = [];
  for (let round = 1; round <= interruptRounds; round += 1) {
    const issuedAt = new Date().toISOString();
    const result = await prepareEnvironment({
      ...scenePrepare(),
      timeoutMs,
    });
    const message = result.failure?.message ?? "";
    notes.push(
      `第 ${String(round)} 次：发起 ${issuedAt} 约定 ${String(
        timeoutMs,
      )} 毫秒期限，结果 ${result.status} 阶段 ${
        result.failure?.stage ?? ""
      } 首因 ${message || "无"}`,
    );
    if (
      result.status === "failed" &&
      message.includes("操作期限到期") &&
      message.includes("已确认退出")
    )
      return { result, notes };
  }
  throw new Error(
    `连续 ${String(interruptRounds)} 次都没能让 ${String(
      timeoutMs,
    )} 毫秒期限落在已交给系统的阶段命令上：\n${notes.join("\n")}`,
  );
}

/**
 * 公开启动接口施加真实绝对期限：只有期限确实落在「本世代已存在且尚未发布」的窗口里、
 * 并由本次收尾确认自有进程退出时才算形成证据。沿用本文件的自有进程暂停边界，
 * 只在新世代身份已记录且尚未发布时暂停产品，期限到达后恢复，让公开启动自己收尾。
 * 抢在暂停之前完成发布的那一次如实记下，按公开停止收回现场后重来。
 */
async function startPastDeadline(timeoutMs: number): Promise<{
  readonly result: StartOperationResult;
  readonly notes: string[];
}> {
  const notes: string[] = [];
  for (let round = 1; round <= interruptRounds; round += 1) {
    const attempt = beginStart(
      `期限到期 start 第 ${String(round)} 次`,
      scene.name,
    );
    const issuedAt = new Date().toISOString();
    const priorRunId = (await readRecordFile()).run?.runId ?? null;
    const pending = startEnvironment({
      ...sceneRef(),
      timeoutMs,
    });
    let pausedPid: number | undefined;
    let resume: ReturnType<typeof setTimeout> | undefined;
    const resumeProduct = (): void => {
      if (pausedPid === undefined) return;
      const pid = pausedPid;
      pausedPid = undefined;
      process.kill(pid, "SIGCONT");
      notes.push(
        `本次自有产品 ${String(pid)} 于 ${new Date().toISOString()} 恢复响应`,
      );
    };
    let result: StartOperationResult;
    try {
      await waitFor(
        async () => {
          const record = await readRecordFile();
          if (record.run?.runId === priorRunId) return false;
          if (record.run?.state !== "starting") return true;
          const pid = record.run.processIdentity?.pid;
          if (pid === undefined) return false;
          process.kill(pid, "SIGSTOP");
          pausedPid = pid;
          notes.push(
            `未发布世代 ${record.run.runId} 的自有产品 ${String(pid)} 已暂停`,
          );
          // 期限由操作进程执行；恢复只让已到期操作的既有收尾能得到产品回应。
          resume = setTimeout(resumeProduct, timeoutMs + 500);
          return true;
        },
        timeoutMs,
        5,
      );
      result = await pending;
    } finally {
      if (resume !== undefined) clearTimeout(resume);
      resumeProduct();
    }
    observeStart(attempt, result);
    const message = result.failure?.message ?? "";
    notes.push(
      `第 ${String(round)} 次：发起 ${issuedAt} 约定 ${String(
        timeoutMs,
      )} 毫秒期限，结果 ${result.status} 阶段 ${
        result.failure?.stage ?? ""
      } 首因 ${message || "无"}`,
    );
    if (
      result.status === "failed" &&
      message.includes("操作期限到期") &&
      message.includes("本世代尚未")
    )
      return { result, notes };
    await convergeScene(notes, `第 ${String(round)} 次`);
  }
  throw new Error(
    `连续 ${String(interruptRounds)} 次都没能让 ${String(
      timeoutMs,
    )} 毫秒期限落在未发布世代的在途窗口里：\n${notes.join("\n")}`,
  );
}

/**
 * 独立 CLI 的启动操作被真实终止信号打断：先等到环境记录提交一个未发布世代身份，再对
 * 本回合自己启动的进程（或整个进程组）发出信号。只有外层确实带着操作进程自己的信号
 * 结论退出才算形成证据；抢不过发布的那一次收回现场后重来。
 */
async function interruptStartCli(input: {
  readonly label: string;
  readonly signal: NodeJS.Signals;
  readonly group: boolean;
  readonly accepted: (
    answer: CommandResult,
    data: CliEnvelope | undefined,
  ) => boolean;
}): Promise<{
  readonly answer: CommandResult;
  readonly data: CliEnvelope | undefined;
  readonly notes: string[];
}> {
  const notes: string[] = [];
  for (let round = 1; round <= interruptRounds; round += 1) {
    const priorRunId = (await readRecordFile().catch(() => undefined))?.run
      ?.runId;
    const attempt = beginStart(
      `${input.label} 第 ${String(round)} 次`,
      scene.name,
    );
    const launched = launchEnvironmentCli(
      ["start", "--environment", scene.name, "--timeout-ms", "60000"],
      { detached: input.group },
    );
    const formed = await waitFor(
      () => unpublishedGenerationUnderWay(priorRunId ?? null),
      45_000,
      20,
    );
    const label = `第 ${String(round)} 次`;
    if (!formed) {
      const answer = await launched.done;
      notes.push(
        `${label}：没有观察到未发布的新世代（退出码 ${String(
          answer.code,
        )} 信号 ${String(answer.signal)} 输出 ${shorten(answer)}）`,
      );
      attempt.status = "未形成在途窗口";
      await convergeScene(notes, label);
      continue;
    }
    if (input.group && !(await ownGroupReady(launched.child))) {
      // 没能成组就没有整组可中断：等它自己走完，再按公开停止收尾，绝不伪造中断。
      await launched.done;
      notes.push(`${label}：独立 CLI 没有成为自己的进程组组长`);
      attempt.status = "未能成组";
      await convergeScene(notes, label);
      continue;
    }
    const delivered =
      input.group === true
        ? signalOwnProcessGroup(launched.child, input.signal)
        : launched.child.kill(input.signal);
    const answer = await launched.done;
    const data = tryEnvelope(answer);
    attempt.status = `${data?.status ?? "没有结构化结果"}（退出码 ${String(
      answer.code,
    )} 信号 ${String(answer.signal)}）`;
    attempt.runId = data?.run?.runId ?? null;
    notes.push(
      `${label}：在未发布窗口内对${
        input.group ? "整个进程组" : "外层 CLI"
      }发出 ${input.signal}，送达 ${String(
        delivered,
      )}，退出码 ${String(answer.code)} 信号 ${String(
        answer.signal,
      )} 结果 ${data?.status ?? "无"} 首因 ${data?.failure?.message ?? "无"}`,
    );
    if (delivered && input.accepted(answer, data))
      return { answer, data, notes };
    await convergeScene(notes, label);
  }
  throw new Error(
    `连续 ${String(
      interruptRounds,
    )} 次都没能形成「本世代未发布且信号真实送达」的在途中断：\n${notes.join(
      "\n",
    )}`,
  );
}

beforeAll(async () => {
  const port = await freePortInRange();
  const name = `t05-${randomUUID().slice(0, 8)}`;
  const containerDirectory = path.join(
    workspaceRoot,
    ".digital",
    "environments",
    name,
  );
  createdContainers.push(containerDirectory);
  scene = {
    name,
    port,
    containerDirectory,
    productDataRoot: path.join(containerDirectory, productDataDirectorySegment),
  };
  // 现场账本先记录工作区、环境名与端口，后续结论都只引用这一份登记。
  console.log(
    `05 现场登记：工作区 ${workspaceRoot} / 环境 ${name} / 端口 ${String(port)}`,
  );
}, realRunTimeout);

afterAll(async () => {
  const issued = startAttempts.map(
    (attempt) =>
      `${attempt.label}：环境 ${attempt.environment} 于 ${attempt.issuedAt} 发出，结果 ${
        attempt.status ?? "未提交"
      }，世代 ${attempt.runId ?? "无"}`,
  );
  const retained: string[] = [];
  const stopped: string[] = [];
  for (const environment of new Set(
    startAttempts.map((attempt) => attempt.environment),
  )) {
    let stop: StopOperationResult;
    try {
      stop = await stopEnvironment({
        workspacePath: workspaceRoot,
        environment,
      });
    } catch (error) {
      retained.push(
        `${environment}：公开停止调用本身抛出（${describeFailure(error)}），按未知保留记录、启动配置、产品数据与日志，请再次对同一环境发出公开停止：stop --environment ${environment}`,
      );
      continue;
    }
    // 关闭结论来自另一次独立公开查看的真实进程观察，不采信记录投影里的默认值。
    let confirmed: InspectEnvironmentResult;
    try {
      confirmed = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment,
      });
    } catch (error) {
      retained.push(
        `${environment}：公开停止返回 ${stop.status} 后独立查看抛出（${describeFailure(error)}），按未知保留记录、启动配置、产品数据与日志（运行日志 ${stop.run.productLogFile ?? "无"}），请再次对同一环境发出公开停止：stop --environment ${environment}`,
      );
      continue;
    }
    const confirmedClosed =
      (stop.status === "stopped" || stop.status === "already-stopped") &&
      (confirmed.run.processLiveness === "exited" ||
        confirmed.run.processLiveness === "absent") &&
      confirmed.serviceReadiness !== "ready";
    stopped.push(
      `${environment}：${stop.status} / 记录 ${stop.run.state}（结束事实 ${
        stop.run.endedAt ?? "无"
      }）/ 独立查看进程 ${confirmed.run.processLiveness} / 就绪 ${
        confirmed.serviceReadiness
      } / 收尾 ${stop.cleanup.state} / 运行日志 ${
        stop.run.productLogFile ?? "无"
      }`,
    );
    if (!confirmedClosed)
      retained.push(
        `${environment}：公开停止返回 ${stop.status}，独立查看显示进程 ${
          confirmed.run.processLiveness
        }、就绪 ${
          confirmed.serviceReadiness
        }，按未知保留记录、启动配置、产品数据与日志（运行日志 ${
          stop.run.productLogFile ?? "无"
        }），请再次对同一环境发出公开停止：stop --environment ${environment}`,
      );
  }
  console.log(
    `05 现场账本\n发出过的启动：\n${
      issued.length === 0 ? "无" : issued.join("\n")
    }\n公开停止：\n${stopped.join("\n") || "无"}\n保留待收尾：\n${
      retained.length === 0 ? "无" : retained.join("\n")
    }`,
  );
  if (retained.length > 0)
    throw new Error(
      `本世代未按公开停止确认真实退出，保留现场：\n${retained.join("\n")}`,
    );
  // 已确认真实退出的世代才回收本轮自有容器；产品停止自己保留的运行日志留在原地。
  for (const container of createdContainers)
    await rm(container, { recursive: true, force: true });
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
}, realRunTimeout);

describe("超时与中断后的收尾和失败现场恢复", () => {
  const stageOrder: readonly string[] = ["build", "migrate", "read"];

  it(
    "05-1 准备被取消：取消不跳过收尾，已交给系统的阶段命令被真实终止且首因不被覆盖",
    async () => {
      const controller = new AbortController();
      const issuedAt = new Date().toISOString();
      const running = prepareEnvironment({
        ...scenePrepare(),
        signal: controller.signal,
      });
      // 只在阶段命令确实交给系统之后取消：这样本次取消必然落在真实收尾路径上。
      const handedOver = await waitFor(buildStageChildStarted, 60_000, 50);
      expect(handedOver, "准备未能把第一个阶段命令交给系统").toBe(true);
      controller.abort("SIGTERM");
      const result = await running;
      const stage = result.failure?.stage ?? "";
      console.log(
        `05 准备取消：发起 ${issuedAt} 结果 ${result.status} 阶段 ${stage} 收尾 ${result.cleanup.state} 首因 ${result.failure?.message}`,
      );

      // 取消永远不会变成静默成功。
      expect(result.status, JSON.stringify(result)).toBe("failed");
      expect(stageOrder).toContain(stage);
      // 取消本身就是首因，并如实带上本次真实观察到的自有子进程退出事实。
      expect(result.failure?.message).toContain("操作进程收到 SIGTERM");
      expect(result.failure?.message).toContain("已确认退出");
      expect(result.cleanup.state).toBe("stopped");

      const stageLog = await readFile(
        path.join(result.logs.directory!, `${stage}.log`),
        "utf8",
      );
      const exitLine = /exit code=(\S+) signal=(\S+)/u.exec(stageLog);
      expect(exitLine, stageLog).not.toBeNull();
      // 操作结果里的退出事实与该阶段日志自己记下的一字不差，不靠转述。
      expect(result.failure?.message).toContain(
        `已确认退出（退出码 ${exitLine![1]} 信号 ${exitLine![2]}）`,
      );
      expect(
        exitLine![2] === "SIGTERM" || exitLine![1] !== "0",
        `阶段子进程没有经本次收尾结束，而是自行正常退出：${exitLine![0]}`,
      ).toBe(true);
      // 取消成立之后不再启动新的阶段命令：失败阶段之后不应出现任何阶段日志。
      const present = stageOrder.filter((candidate) =>
        result.logs.files.some((file) => file.endsWith(`${candidate}.log`)),
      );
      expect(
        present.filter(
          (candidate) =>
            stageOrder.indexOf(candidate) > stageOrder.indexOf(stage),
        ),
        `取消之后仍出现了后续阶段日志：${present.join("、")}`,
      ).toEqual([]);

      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.state).toBe("failed");
      // 记录里的首因就是操作结果里那一句；收尾错误没有覆盖原始原因。
      expect(inspection.preparation?.lastFailure?.message).toBe(
        result.failure?.message,
      );
      expect(inspection.preparation?.lastFailure?.cleanup).toBe("stopped");
      expect(inspection.run.state).toBe("absent");
      // 中断不留下任何后台服务：约定端口从未被占用。
      expect(await portOpen(scene.port)).toBe(false);
    },
    realRunTimeout,
  );

  it(
    "05-1 准备超时：绝对期限由持锁操作进程自己执行，取消之后仍确认自有阶段命令退出",
    async () => {
      const { result, notes } = await preparePastDeadline(600);
      console.log(
        `05 准备超时：约定 600 毫秒期限\n${notes.join(
          "\n",
        )}\n采用本次：结果 ${result.status} 阶段 ${
          result.failure?.stage ?? ""
        } 收尾 ${result.cleanup.state} 首因 ${result.failure?.message ?? ""}`,
      );
      expect(result.status, JSON.stringify(result.failure)).toBe("failed");
      // 期限由操作进程按同一绝对终点自己到期，不是外层替它宣布。
      expect(result.failure?.message).toContain("操作期限到期（约定终点");
      expect(result.failure?.message).toContain("已确认退出");
      expect(result.cleanup.state).toBe("stopped");

      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.state).toBe("failed");
      expect(inspection.preparation?.lastFailure?.message).toBe(
        result.failure?.message,
      );
      expect(await portOpen(scene.port)).toBe(false);
    },
    realRunTimeout,
  );

  it(
    "05-4 中断后的现场可经公开入口修复：启动按归属明确拒绝，修复式重准备不隐式重置记录",
    async () => {
      const before = await readRecordFile();
      const refused = await startEnvironment(sceneRef());
      expect(refused.status, JSON.stringify(refused.failure)).toBe("refused");
      expect(refused.failure?.stage).toBe("generation");
      expect(refused.failure?.message).toContain("尚未处于已准备状态");
      expect(refused.cleanup.state).toBe("not-started");

      const repaired = await prepareEnvironment(scenePrepare());
      expect(repaired.status, JSON.stringify(repaired.failure)).toBe(
        "prepared",
      );
      const after = await readRecordFile();
      // 修复式重准备沿用同一容器与同一数据代次，不重建归属、不隐式清空。
      expect(after.environmentId).toBe(before.environmentId);
      expect(after.createdAt).toBe(before.createdAt);
      expect(after.containerIdentity).toEqual(before.containerIdentity);
      expect(after.preparation.state).toBe("prepared");
      expect(after.run).toBeUndefined();

      // 现场里写入真实业务记录，供后续中断与重启核对数据不被重置。
      businessRecord = await recordLibraryScan("取消现场修复后写入");
      expect(await workflowHistoryIds()).toContain(businessRecord.executionId);
    },
    realRunTimeout,
  );

  it(
    "05-1 启动期限到期：未发布世代由本次启动确认收尾，诊断位置明确且产品数据不动",
    async () => {
      const { result: cancelled, notes } = await startPastDeadline(1_500);
      console.log(
        `05 启动期限到期\n${notes.join("\n")}\n采用本次：结果 ${
          cancelled.status
        } 阶段 ${cancelled.failure?.stage ?? ""} 世代 ${
          cancelled.run.runId ?? "无"
        } 收尾 ${cancelled.cleanup.state} 首因 ${
          cancelled.failure?.message ?? ""
        }`,
      );

      expect(cancelled.status, JSON.stringify(cancelled.failure)).toBe(
        "failed",
      );
      // 取消之后仍完成自有资源收尾：收尾结论是本次亲自启动的进程已确认退出。
      expect(cancelled.failure?.message).toContain("进程事实：退出码");
      expect(cancelled.cleanup.state).toBe("stopped");
      expect(cancelled.cleanup.errors).toEqual([]);

      // 关闭结论来自另一次独立公开查看的真实进程观察。
      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.run.runId).toBe(cancelled.run.runId);
      expect(inspection.run.state).toBe("stopped");
      expect(inspection.run.processLiveness).not.toBe("alive");
      // 从未提交进程身份的世代没有可探测的服务：公开查看只会如实说不成立或无法确认，
      // 绝不把「没有确认」粉饰成已就绪。
      console.log(
        `05 期限到期后的独立查看：进程 ${
          inspection.run.processLiveness
        } 就绪 ${inspection.serviceReadiness} 运行问题 ${
          inspection.runProblem ?? "无"
        }`,
      );
      expect(inspection.serviceReadiness).not.toBe("ready");
      expect(inspection.run.lastFailure?.message).toBe(
        cancelled.failure?.message,
      );
      expect(await closePort(scene.port)).toBe(true);

      // 05-3 失败现场明确告知日志位置：操作日志与运行日志都留在原位且可读。
      expect(cancelled.logs.directory).not.toBeNull();
      const operationLog = await readOperationLog(cancelled);
      expect(operationLog).toContain("启动失败");
      expect(operationLog).toContain("操作期限到期");
      const productLogFile = cancelled.run.productLogFile;
      expect(productLogFile).not.toBeNull();
      expect(await exists(productLogFile!)).toBe(true);
      expect((await readFile(productLogFile!, "utf8")).length).toBeGreaterThan(
        0,
      );

      // 取消不重置产品数据：修复现场前写入的业务记录仍然读得到。
      expect(await workflowHistoryIds()).toContain(businessRecord.executionId);
    },
    realRunTimeout,
  );

  it(
    "05-1 单独中断外层 CLI：转交取消后持锁操作进程按自己收到的 SIGTERM 收尾并交出结果",
    async () => {
      const { answer, data, notes } = await interruptStartCli({
        label: "SIGTERM 中断 start",
        signal: "SIGTERM",
        group: false,
        accepted: (cliAnswer, structured) =>
          cliAnswer.code === 1 &&
          structured?.status === "failed" &&
          (structured.failure?.message ?? "").includes("操作进程收到 SIGTERM"),
      });
      const structured = envelope(
        answer,
        `环境 ${scene.name} 被 SIGTERM 中断的独立 CLI 启动`,
      );
      console.log(
        `05 CLI 单独中断\n${notes.join(
          "\n",
        )}\n采用本次：退出码 ${String(answer.code)} 结果 ${
          structured.status
        } 首因 ${structured.failure?.message ?? ""}`,
      );

      expect(answer.code).toBe(1);
      expect(data?.status).toBe("failed");
      // 操作进程按自己收到的信号如实说明首因，内核并列记录取消来源，两者互不覆盖。
      expect(structured.failure?.message).toContain("操作进程收到 SIGTERM");
      expect(
        structured.diagnostics?.some((item) =>
          item.includes("取消来源：调用方取消本次操作（SIGTERM）"),
        ),
      ).toBe(true);
      expect(structured.cleanup?.state).toBe("stopped");

      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.serviceReadiness).toBe("not-ready");
      expect(inspection.run.processLiveness).not.toBe("alive");
    },
    realRunTimeout,
  );

  it(
    "05-1 整个调用进程组收到 SIGINT：外层与持锁操作进程同时被打断，首因仍是操作进程自己的信号",
    async () => {
      const { answer, data, notes } = await interruptStartCli({
        label: "进程组 SIGINT start",
        signal: "SIGINT",
        group: true,
        accepted: (cliAnswer, structured) =>
          cliAnswer.code === 1 &&
          structured?.status === "failed" &&
          (structured.failure?.message ?? "").includes("操作进程收到 SIGINT"),
      });
      const structured = envelope(
        answer,
        `环境 ${scene.name} 被进程组 SIGINT 中断的独立 CLI 启动`,
      );
      console.log(
        `05 进程组中断\n${notes.join(
          "\n",
        )}\n采用本次：退出码 ${String(answer.code)} 结果 ${
          structured.status
        } 首因 ${structured.failure?.message ?? ""}`,
      );

      expect(answer.code).toBe(1);
      expect(data?.status).toBe("failed");
      // 外层与操作进程同时被中断时，首因仍是操作进程自己观察到的终止信号。
      expect(structured.failure?.message).toContain("操作进程收到 SIGINT");
      expect(structured.cleanup?.state).toBe("stopped");

      expect(await closePort(scene.port)).toBe(true);
      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.serviceReadiness).toBe("not-ready");
      expect(inspection.run.processLiveness).not.toBe("alive");
    },
    realRunTimeout,
  );

  it(
    "05-4 中断后的现场经公开启动入口重新可用：服务真实就绪且旧业务记录由产品自己读回",
    async () => {
      const recovered = await startRegistered("中断后恢复 start");
      expect(recovered.status, JSON.stringify(recovered.failure)).toBe("ready");
      expect(await portOpen(scene.port)).toBe(true);
      expect(recovered.run.pid, "就绪结论没有交出真实进程身份").not.toBeNull();
      expect(
        await httpGet(scene.port, "/api/ready").then((read) => read.status),
      ).toBe(200);
      // 产品数据是单一写入者：就绪期间由该世代自己持有，旧值请运行中的产品经公开接口读回。
      const readBack = await httpGet(
        scene.port,
        `/api/scans/library/${businessRecord.scanId}`,
      );
      console.log(
        `05 公开读回：GET /api/scans/library/${businessRecord.scanId} 状态 ${String(
          readBack.status,
        )} 正文 ${readBack.body.slice(0, 900)}`,
      );
      expect(readBack.status, readBack.body).toBe(200);
      const stored = JSON.parse(readBack.body) as {
        id?: string;
        status?: string;
        directories?: { id?: string; stage?: string }[];
      };
      expect(stored.id).toBe(businessRecord.scanId);
      expect(
        stored.directories?.length ?? 0,
        `产品没有交出该次扫描的目录账本：${readBack.body}`,
      ).toBeGreaterThan(0);
      expect(
        stored.directories!.every(
          (directory) =>
            typeof directory.id === "string" &&
            directory.id.length > 0 &&
            typeof directory.stage === "string",
        ),
        `读回的目录账本缺少持久阶段事实：${readBack.body}`,
      ).toBe(true);
      // 反证：同一个公开入口查一个没有落库的世代，产品不会凭 URL 编造结果，
      // 因此上面读到的确实是本世代从自己的持久数据里取回的旧业务记录。
      const absent = await httpGet(
        scene.port,
        "/api/scans/library/execution_00000000-0000-4000-8000-000000000000",
      );
      expect(absent.status).not.toBe(200);
    },
    realRunTimeout,
  );

  it(
    "05-5 已发布世代不受无关命令信号影响：只读查看被中断也不会停止服务",
    async () => {
      const published = await readRecordFile();
      expect(published.run?.state).toBe("ready");
      const launched = launchEnvironmentCli(
        ["inspect", "--environment", scene.name],
        { detached: true },
      );
      const spawnedAt = Date.now();
      // 只读查看可能在一两百毫秒内自行完成：等到它确实独立成组就立刻发出信号。本用例
      // 要证明的是已发布世代与无关命令的信号无关，而不是这只 CLI 运行多久。
      expect(
        await ownGroupReady(launched.child),
        "独立 CLI 尚未成为自己的进程组组长，无法向本回合启动的进程组发出 SIGINT",
      ).toBe(true);
      const delivered = signalOwnProcessGroup(launched.child, "SIGINT");
      expect(delivered, "SIGINT 没有送达本次自己启动的只读查看进程组").toBe(
        true,
      );
      const answer = await launched.done;
      console.log(
        `05 无关命令中断：只读查看进程 ${String(
          launched.child.pid,
        )} 用时 ${String(Date.now() - spawnedAt)} 毫秒，退出码 ${String(
          answer.code,
        )} 信号 ${String(answer.signal)}，被保护的已发布世代 ${
          published.run?.runId
        } 进程 ${String(published.run?.processIdentity?.pid)}`,
      );
      // 只读命令保持终端默认行为：要么交出正常结果，要么按收到的信号结束。
      expect(
        answer.code === 0 || answer.signal === "SIGINT",
        `只读查看交出未预期结果：退出码 ${String(answer.code)} 信号 ${String(
          answer.signal,
        )} 输出 ${answer.stdout}${answer.stderr}`,
      ).toBe(true);
      if (answer.code === 0)
        expect(envelope(answer, `环境 ${scene.name} 的只读查看`).status).toBe(
          "ok",
        );
      // 世代一旦发布并成功应答就归产品自己持有：无关命令的信号与它无关。
      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.serviceReadiness).toBe("ready");
      expect(inspection.run.runId).toBe(published.run?.runId);
      expect(inspection.run.pid).toBe(published.run?.processIdentity?.pid);
      expect(await readyProbeStatus(scene.port)).toBe(200);
    },
    realRunTimeout,
  );

  it(
    "05-3 运行中的产品分别收到 SIGINT 与 SIGTERM：都按既有归属自行关闭，公开接口如实收敛",
    async () => {
      // 上一个用例把已发布世代留给了产品自己持有：本用例先按公开停止收敛现场，才能
      // 启动属于自己的新世代，观察产品真实收到的终止信号。
      const opening: string[] = [];
      await convergeScene(opening, "05-3 开始前");
      console.log(`05 产品自终止开始前的收敛\n${opening.join("\n")}`);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const running = await startRegistered(`产品收到 ${signal} start`);
        expect(running.status, JSON.stringify(running.failure)).toBe("ready");
        // 这份身份来自本世代发布后记录里的自有进程身份，不是按端口猜测的进程。
        const owned = await readRecordFile();
        const pid = owned.run?.processIdentity?.pid;
        expect(
          pid,
          `就绪世代没有交出记录内的进程身份（${signal}）`,
        ).not.toBeNull();
        const productLogFile = owned.run?.productLogFile;
        expect(productLogFile, `就绪世代没有交出运行日志位置`).not.toBeNull();
        const terminatedAt = new Date().toISOString();
        process.kill(pid!, signal);

        expect(await closePort(scene.port)).toBe(true);
        expect(await readFile(productLogFile!, "utf8")).toContain(
          "run 已取得进入正式入口的许可",
        );

        // 管理器没有代产品退出：记录仍指向该世代，公开停止据已退出事实收敛。
        const stopped = await stopEnvironment(sceneRef());
        console.log(
          `05 产品自终止 ${signal}：发出 ${terminatedAt} 停止结果 ${
            stopped.status
          } 记录 ${stopped.run.state} 结束事实 ${
            stopped.run.endedAt ?? "无"
          } 收尾 ${stopped.cleanup.state} 进程 ${stopped.run.processLiveness}`,
        );
        expect(
          ["stopped", "already-stopped"],
          JSON.stringify(stopped.failure),
        ).toContain(stopped.status);
        const inspection = await inspectEnvironment(sceneRef());
        expect(inspection.serviceReadiness).toBe("not-ready");
        expect(inspection.run.processLiveness).toBe("exited");
        expect(await portOpen(scene.port)).toBe(false);
        // 停止只收回外层资源：产品数据一项不动，运行日志留在原地。
        expect(await exists(productLogFile!)).toBe(true);
      }
      expect(await workflowHistoryIds()).toContain(businessRecord.executionId);
    },
    realRunTimeout,
  );

  it(
    "05-1 未经发布的世代在父操作被 SIGKILL 后自行收尾，不留待人工排查的后台服务",
    async () => {
      const notes: string[] = [];
      let killed!: CommandResult;
      let selfClosed = false;
      for (let round = 1; round <= interruptRounds; round += 1) {
        const priorRunId = (await readRecordFile().catch(() => undefined))?.run
          ?.runId;
        const attempt = beginStart(
          `父操作 SIGKILL start 第 ${String(round)} 次`,
          scene.name,
        );
        const launched = launchEnvironmentCli(
          ["start", "--environment", scene.name, "--timeout-ms", "60000"],
          { detached: true },
        );
        // 等到新世代的精确进程身份进入记录再中断：此时世代已真实存在但尚未发布。
        const formed = await waitFor(
          () => unpublishedGenerationUnderWay(priorRunId ?? null),
          45_000,
          20,
        );
        const label = `第 ${String(round)} 次`;
        if (!formed) {
          const answer = await launched.done;
          notes.push(
            `${label}：没有观察到未发布的新世代（退出码 ${String(
              answer.code,
            )} 输出 ${shorten(answer)}）`,
          );
          attempt.status = "未形成在途窗口";
          await convergeScene(notes, label);
          continue;
        }
        expect(
          await ownGroupReady(launched.child),
          `${label}：独立 CLI 没有成为自己的进程组组长`,
        ).toBe(true);
        const beforeKill = await readRecordFile();
        expect(beforeKill.run?.state).toBe("starting");
        expect(
          signalOwnProcessGroup(launched.child, "SIGKILL"),
          `${label}：SIGKILL 没有送达本次自己启动的启动进程组`,
        ).toBe(true);
        const answer = await launched.done;
        attempt.status = `父端被 SIGKILL（信号 ${String(answer.signal)}）`;
        attempt.runId = beforeKill.run?.runId ?? null;
        notes.push(
          `${label}：世代 ${beforeKill.run?.runId} 尚未发布，父进程组收到 SIGKILL（外层信号 ${String(
            answer.signal,
          )}）`,
        );
        selfClosed = await waitFor(
          async () =>
            (
              await readFile(beforeKill.run!.productLogFile, "utf8").catch(
                () => "",
              )
            ).includes("本世代未经发布确认，引导自行收尾"),
          productCloseAllowanceMilliseconds,
        );
        if (!selfClosed) {
          notes.push(`${label}：运行日志里没有本世代未经发布自行收尾的记录`);
          await convergeScene(notes, label);
          continue;
        }
        killed = answer;
        break;
      }
      console.log(
        `05 未发布世代收尾\n${notes.join(
          "\n",
        )}\n外层信号 ${String(killed.signal)}`,
      );
      expect(selfClosed, notes.join("\n")).toBe(true);

      const record = await readRecordFile();
      // 从未取得发布确认，记录不会把它标成已就绪。
      expect(record.run?.state).toBe("starting");
      const stopped = await stopEnvironment(sceneRef());
      console.log(
        `05 未发布世代公开停止：结果 ${stopped.status} 进程 ${
          stopped.run.processLiveness
        } 收尾 ${stopped.cleanup.state} 首因 ${
          stopped.failure?.message ?? "无"
        }`,
      );
      expect(stopped.status, JSON.stringify(stopped.failure)).toBe("stopped");
      expect(stopped.run.processLiveness).toBe("exited");
      expect(stopped.cleanup.state).toBe("stopped");
      // 再次停止同一个已收敛现场：如实报告已停止，不重复发信号、不改动现场。
      const again = await stopEnvironment(sceneRef());
      expect(again.status, JSON.stringify(again.failure)).toBe(
        "already-stopped",
      );
      expect(again.cleanup.state).toBe("not-started");
    },
    realRunTimeout,
  );

  it(
    "05-2 无法确认退出时如实报告真实状态：恢复可响应后由新的独立停止完成收尾且首因不被改写",
    async () => {
      // 最小外部受控条件：把本回合按记录内身份确认的自有世代进程暂停，使它无法对私有
      // 控制通道作出任何回应。「停止请求已发出但退出无法确认」在自然运行中难以稳定产生。
      const running = await startRegistered("暂停自有世代 start");
      expect(running.status, JSON.stringify(running.failure)).toBe("ready");
      const owned = await readRecordFile();
      const ownedPid = owned.run?.processIdentity?.pid;
      expect(ownedPid, "就绪世代没有交出记录内的进程身份").not.toBeNull();
      expect(owned.run?.state).toBe("ready");
      const suspendedAt = new Date().toISOString();
      process.kill(ownedPid!, "SIGSTOP");

      const unconfirmed = await stopEnvironment(sceneRef());
      console.log(
        `05 无法确认退出：暂停于 ${suspendedAt} 停止结果 ${
          unconfirmed.status
        } 阶段 ${unconfirmed.failure?.stage ?? ""} 进程 ${
          unconfirmed.run.processLiveness
        } 记录 ${unconfirmed.run.state} 收尾 ${
          unconfirmed.cleanup.state
        } 首因 ${unconfirmed.failure?.message ?? ""} 收尾错误 ${unconfirmed.cleanup.errors.join(
          "；",
        )}`,
      );
      expect(unconfirmed.status, JSON.stringify(unconfirmed.failure)).toBe(
        "not-confirmed",
      );
      // 主执行错误：停止请求没能经本世代私有控制通道成立。
      expect(unconfirmed.failure?.stage).toBe("control");
      // 无法确认就如实报告现场：进程仍存活、记录保留停止中事实、收尾状态未知。
      expect(unconfirmed.run.processLiveness).toBe("alive");
      expect(unconfirmed.run.state).toBe("stopping");
      expect(unconfirmed.cleanup.state).toBe("unknown");
      // 收尾未能确认单独成句保留，不覆盖主执行错误。
      expect(unconfirmed.cleanup.errors).toContain(
        "未能确认本世代退出，已保留私有运行现场与秘密以便再次停止",
      );
      expect(await readOperationLog(unconfirmed)).toContain(
        "保留停止中事实与私有现场以便后续停止",
      );

      const during = await inspectEnvironment(sceneRef());
      expect(during.run.state).toBe("stopping");
      expect(during.run.processLiveness).toBe("alive");
      // 公开查看与本次结果引用同一句原始原因，没有被别的信息顶替。
      expect(during.run.lastFailure?.message).toBe(
        unconfirmed.failure?.message,
      );
      expect((await readRecordFile()).run?.state).toBe("stopping");

      // 恢复最小原因：让进程重新可以响应。第一次停止请求从未抵达本世代，因此它不会
      // 自行收尾；现场保持存活并再次可认证，收尾交给一次全新的独立公开停止。
      process.kill(ownedPid!, "SIGCONT");
      const responsive = await waitFor(
        async () =>
          (await inspectEnvironment(sceneRef())).run.controlReachable === true,
        productCloseAllowanceMilliseconds,
      );
      expect(responsive, "恢复响应后本世代的私有控制通道仍不可认证").toBe(true);
      expect(
        await processPresent(ownedPid!),
        "恢复响应后本世代进程不在了，但没有任何一次停止请求抵达它",
      ).toBe(true);
      const closed = await stopEnvironment(sceneRef());
      console.log(
        `05 恢复后独立停止：结果 ${closed.status} 记录 ${
          closed.run.state
        } 进程 ${closed.run.processLiveness} 结束事实 ${
          closed.run.endedAt ?? "无"
        } 收尾 ${closed.cleanup.state} 收尾错误 ${
          closed.cleanup.errors.join("；") || "无"
        }`,
      );
      expect(closed.status, JSON.stringify(closed.failure)).toBe("stopped");
      expect(closed.run.processLiveness).toBe("exited");
      expect(closed.cleanup.state).toBe("stopped");
      expect(closed.cleanup.errors).toEqual([]);
      expect(await portOpen(scene.port)).toBe(false);
      // 完成收尾只追加已停止事实，不改写第一次停止留下的原始原因。
      const after = await inspectEnvironment(sceneRef());
      expect(after.run.state).toBe("stopped");
      expect(after.run.lastFailure?.message).toBe(unconfirmed.failure?.message);
      // 现场的产品数据一项不动。
      expect(await workflowHistoryIds()).toContain(businessRecord.executionId);
    },
    realRunTimeout,
  );

  it(
    "R05-01 取消落在就绪事实提交之前：不提交也不发布，本世代真实结束且产品数据不动",
    async () => {
      const notes: string[] = [];
      let hit:
        | {
            readonly runId: string;
            readonly data: CliEnvelope;
            readonly at: string;
          }
        | undefined;
      for (
        let round = 1;
        round <= boundaryRounds && hit === undefined;
        round += 1
      ) {
        const label = `第 ${String(round)} 次`;
        await convergeScene(notes, `${label} 开始前`);
        const priorRunId = (await readRecordFile().catch(() => undefined))?.run
          ?.runId;
        const attempt = beginStart(`提交截止点 start ${label}`, scene.name);
        const launched = launchEnvironmentCli(
          ["start", "--environment", scene.name, "--timeout-ms", "60000"],
          { detached: true },
        );
        expect(
          await ownGroupReady(launched.child),
          `${label}：独立 CLI 没有成为自己的进程组组长`,
        ).toBe(true);
        const caught = await catchReadyCommit(
          priorRunId ?? null,
          "before-rename",
        );
        if (caught.side === "missed") {
          const answer = await launched.done;
          attempt.status = "没有观察到就绪事实的提交瞬间";
          notes.push(
            `${label}：没抓到提交瞬间（外层退出码 ${String(
              answer.code,
            )} 信号 ${String(answer.signal)} 输出 ${shorten(answer)}）`,
          );
          continue;
        }
        const cancelledAt = new Date().toISOString();
        const delivered = signalOwnProcessGroup(launched.child, "SIGTERM");
        const answer = await launched.done;
        const data = tryEnvelope(answer);
        attempt.status = `${data?.status ?? "没有结构化结果"}（截止点 ${caught.side}）`;
        attempt.runId = data?.run?.runId ?? caught.runId;
        notes.push(
          `${label}：世代 ${caught.runId} 的提交在 ${caught.side} 一侧被观察到，${cancelledAt} 对自有进程组送达 SIGTERM ${String(
            delivered,
          )}，外层退出码 ${String(answer.code)}，结果 ${
            data?.status ?? "无"
          } 首因 ${data?.failure?.message ?? "无"}`,
        );
        if (
          caught.side !== "before-rename" ||
          !delivered ||
          data?.status !== "failed"
        )
          continue;
        hit = { runId: caught.runId, data, at: cancelledAt };
      }
      console.log(`05 提交截止点（取消在提交之前）\n${notes.join("\n")}`);
      if (hit === undefined)
        throw new Error(
          `连续 ${String(
            boundaryRounds,
          )} 次都没能把取消落在就绪事实 rename 之前：\n${notes.join("\n")}`,
        );

      const { data } = hit;
      expect(data.failure?.stage).toBe("ready");
      // 首因仍是操作进程自己收到的取消；提交截止点的结论并列在同一句里，不被收尾事实顶替。
      expect(data.failure?.message).toContain("操作进程收到 SIGTERM");
      expect(data.failure?.message).toContain("就绪事实未提交");
      expect(data.failure?.message).toContain("本世代尚未发布");
      expect(
        data.diagnostics?.some((item) => item.includes("取消来源：")),
        "取消已经转交，但内核没有并列交出取消来源",
      ).toBe(true);
      expect(data.cleanup?.state).toBe("stopped");

      // 这一世代从未取得持久提交：记录留下的是未提交的首因与真实结束事实，不是就绪。
      const record = await readRecordFile();
      expect(record.run?.runId).toBe(hit.runId);
      expect(record.run?.state).toBe("stopped");
      expect(record.run?.lastFailure?.message).toContain("就绪事实未提交");
      expect(record.run?.ended, JSON.stringify(record.run)).not.toBeUndefined();
      const operationLog =
        readTextQuietly(
          path.join(
            scene.containerDirectory,
            "logs",
            record.run?.startOperationId ?? "",
            "operation.log",
          ),
        ) ?? "";
      expect(operationLog).toContain("启动失败（阶段 ready）");
      expect(operationLog).toContain("就绪事实未提交");
      // 真实就绪过但没有发布：本世代经私有控制通道自行收尾，不留下无人认领的后台服务。
      const productLog = await readFile(
        record.run?.productLogFile ?? "/dev/null",
        "utf8",
      ).catch(() => "");
      expect(productLog).toContain("已取得进入正式入口的许可");
      expect(await portOpen(scene.port)).toBe(false);
      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.run.processLiveness).not.toBe("alive");
      expect(inspection.serviceReadiness).not.toBe("ready");
      expect(await workflowHistoryIds()).toContain(businessRecord.executionId);
    },
    realRunTimeout,
  );

  it(
    "R05-01 就绪事实已提交之后的迟到取消不回滚：同一世代继续认证就绪",
    async () => {
      const notes: string[] = [];
      let hit:
        | { readonly runId: string; readonly data: CliEnvelope }
        | undefined;
      for (
        let round = 1;
        round <= boundaryRounds && hit === undefined;
        round += 1
      ) {
        const label = `第 ${String(round)} 次`;
        await convergeScene(notes, `${label} 开始前`);
        const priorRunId = (await readRecordFile().catch(() => undefined))?.run
          ?.runId;
        const attempt = beginStart(`提交之后取消 start ${label}`, scene.name);
        const launched = launchEnvironmentCli(
          ["start", "--environment", scene.name, "--timeout-ms", "60000"],
          { detached: true },
        );
        expect(
          await ownGroupReady(launched.child),
          `${label}：独立 CLI 没有成为自己的进程组组长`,
        ).toBe(true);
        const caught = await catchReadyCommit(
          priorRunId ?? null,
          "after-rename",
        );
        if (caught.side === "missed") {
          const answer = await launched.done;
          attempt.status = "没有观察到已提交就绪";
          notes.push(
            `${label}：没抓到已提交的就绪事实（外层退出码 ${String(
              answer.code,
            )} 信号 ${String(answer.signal)} 输出 ${shorten(answer)}）`,
          );
          continue;
        }
        const delivered = signalOwnProcessGroup(launched.child, "SIGTERM");
        const answer = await launched.done;
        const data = tryEnvelope(answer);
        attempt.status = `${data?.status ?? "没有结构化结果"}（世代 ${caught.runId}）`;
        attempt.runId = data?.run?.runId ?? caught.runId;
        notes.push(
          `${label}：世代 ${caught.runId} 已提交就绪后对自有进程组送达 SIGTERM ${String(
            delivered,
          )}，外层退出码 ${String(answer.code)}，结果 ${
            data?.status ?? "无"
          } 世代 ${data?.run?.runId ?? "无"} 取消来源 ${
            data?.diagnostics?.find((item) => item.includes("取消来源：")) ??
            "无"
          }`,
        );
        if (
          !delivered ||
          data?.status !== "ready" ||
          !data.diagnostics?.some((item) => item.includes("取消来源："))
        )
          continue;
        hit = { runId: caught.runId, data };
      }
      console.log(`05 提交截止点（取消在提交之后）\n${notes.join("\n")}`);
      if (hit === undefined)
        throw new Error(
          `连续 ${String(
            boundaryRounds,
          )} 次都没能在取消确实迟到于持久提交之后收下就绪结果：\n${notes.join(
            "\n",
          )}`,
        );

      const { data } = hit;
      // 提交是既成事实：迟到的取消既不撤销记录，也不把已经归产品持有的世代说成失败。
      expect(data.run?.runId).toBe(hit.runId);
      expect(data.run?.state).toBe("ready");
      expect(data.cleanup?.state).toBe("released");
      const record = await readRecordFile();
      expect(record.run?.runId).toBe(hit.runId);
      expect(record.run?.state).toBe("ready");
      expect(record.run?.ended).toBeUndefined();
      const pid = record.run?.processIdentity?.pid;
      expect(pid, JSON.stringify(record.run)).not.toBeUndefined();
      // 越过未发布世代的遗留自停界限之后仍然存活：提交完成的世代不会被补一个自杀计时。
      await new Promise((resolve) =>
        setTimeout(resolve, leftoverSelfStopGraceMilliseconds + 3_000),
      );
      expect(await processPresent(pid!)).toBe(true);
      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.run.runId).toBe(hit.runId);
      expect(inspection.serviceReadiness).toBe("ready");
      expect(inspection.run.controlReachable).toBe(true);
      expect(await readyProbeStatus(scene.port)).toBe(200);
      expect(await stopAndReadProductData("迟到取消世代收回")).toContain(
        businessRecord.executionId,
      );
    },
    realRunTimeout,
  );

  it(
    "R05-02 就绪已提交而发布确认未送达：下一次公开启动经同一私有通道补齐，世代不再被遗留计时关闭",
    async () => {
      const notes: string[] = [];
      let restored:
        | {
            readonly runId: string;
            readonly killedAt: string;
            readonly revived: StartOperationResult;
            readonly productLog: string;
          }
        | undefined;
      for (
        let round = 1;
        round <= boundaryRounds && restored === undefined;
        round += 1
      ) {
        const label = `第 ${String(round)} 次`;
        await convergeScene(notes, `${label} 开始前`);
        const priorRunId = (await readRecordFile().catch(() => undefined))?.run
          ?.runId;
        const attempt = beginStart(`发布确认补齐 start ${label}`, scene.name);
        const launched = launchEnvironmentCli(
          ["start", "--environment", scene.name, "--timeout-ms", "60000"],
          { detached: true },
        );
        expect(
          await ownGroupReady(launched.child),
          `${label}：独立 CLI 没有成为自己的进程组组长`,
        ).toBe(true);
        const caught = await catchReadyCommit(
          priorRunId ?? null,
          "after-rename",
        );
        if (caught.side === "missed") {
          const answer = await launched.done;
          attempt.status = "没有观察到已提交就绪";
          notes.push(
            `${label}：没抓到已提交就绪（外层退出码 ${String(
              answer.code,
            )} 输出 ${shorten(answer)}）`,
          );
          continue;
        }
        const killedAt = new Date().toISOString();
        const delivered = signalOwnProcessGroup(launched.child, "SIGKILL");
        const answer = await launched.done;
        attempt.status = `就绪已提交，外层进程组被 SIGKILL（信号 ${String(
          answer.signal,
        )}）`;
        attempt.runId = caught.runId;
        notes.push(
          `${label}：世代 ${caught.runId} 于 ${killedAt} 提交就绪，随后 SIGKILL 送达 ${String(
            delivered,
          )}（外层信号 ${String(answer.signal)}）`,
        );
        if (!delivered) continue;
        // 外层回执可能停在半路：下一次公开启动必须把同一世代的发布确认补齐，而不是
        // 先报正常就绪再让遗留计时把它关掉。
        const revived = await startRegistered(`${label} 补齐发布确认`);
        notes.push(
          `${label}：下一次公开启动结果 ${revived.status} 世代 ${
            revived.run.runId ?? "无"
          } 进程 ${revived.run.processLiveness} 控制 ${String(
            revived.run.controlReachable,
          )} 真实就绪 ${String(revived.run.serviceReady)}`,
        );
        if (
          revived.status !== "already-ready" ||
          revived.run.runId !== caught.runId
        ) {
          notes.push(
            `${label}：这一轮没有落在「已提交就绪且本世代仍可认证」的窗口内，按公开停止收回现场`,
          );
          await convergeScene(notes, label);
          continue;
        }
        const productLog = revived.run.productLogFile;
        expect(productLog, JSON.stringify(revived.run)).not.toBeNull();
        const reestablished = await waitFor(
          async () =>
            (await readFile(productLog!, "utf8").catch(() => "")).includes(
              "发布确认经私有控制通道重新成立",
            ),
          10_000,
          100,
        );
        if (!reestablished) {
          // 外层回执其实已经送达：这是「已 published 的世代被 SIGKILL」的对照轮，
          // 记录里只留观察事实，不把它当成发布确认补齐的证据。
          notes.push(
            `${label}：本世代此前已收到发布确认（对照轮），按公开停止收回现场`,
          );
          await convergeScene(notes, label);
          continue;
        }
        restored = {
          runId: caught.runId,
          killedAt,
          revived,
          productLog: productLog!,
        };
      }
      console.log(`05 发布确认补齐\n${notes.join("\n")}`);
      if (restored === undefined)
        throw new Error(
          `连续 ${String(
            boundaryRounds,
          )} 次都没能形成「就绪已提交而发布确认未送达」的现场：\n${notes.join(
            "\n",
          )}`,
        );

      const { revived } = restored;
      expect(revived.status).toBe("already-ready");
      expect(revived.run.runId).toBe(restored.runId);
      expect(revived.run.state).toBe("ready");
      expect(revived.run.serviceReady).toBe(true);
      expect(revived.run.controlReachable).toBe(true);
      // 补齐不创建第二个进程，也不改写记录指向：同一世代持续可被重新确认。
      const record = await readRecordFile();
      expect(record.run?.runId).toBe(restored.runId);
      expect(record.run?.state).toBe("ready");
      const pid = record.run?.processIdentity?.pid;
      expect(pid, JSON.stringify(record.run)).not.toBeUndefined();
      const productLog = await readFile(restored.productLog, "utf8");
      expect(productLog).toContain("发布确认经私有控制通道重新成立");
      expect(productLog).not.toContain("本世代未经发布确认，引导自行收尾");
      // 真实越过遗留自停界限（含补齐请求本身的耗时）之后本世代仍然存活并可认证。
      const waited = Date.now() - Date.parse(restored.killedAt);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          leftoverSelfStopGraceMilliseconds + 5_000 - Math.min(waited, 5_000),
        ),
      );
      expect(await processPresent(pid!)).toBe(true);
      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.run.runId).toBe(restored.runId);
      expect(inspection.serviceReadiness).toBe("ready");
      expect(inspection.run.controlReachable).toBe(true);
      expect(await readyProbeStatus(scene.port)).toBe(200);
      expect(await stopAndReadProductData("补齐发布确认世代收回")).toContain(
        businessRecord.executionId,
      );
    },
    realRunTimeout,
  );

  it(
    "R05-03 阶段取得日志资源的途中取消：尚未交给系统的命令不迟到启动，收尾不超出真实事实",
    async () => {
      const notes: string[] = [];
      // 活着的世代会把准备挡住：先按公开停止收回现场，再形成资源取得窗口。
      await convergeScene(notes, "开始前");
      const priorOperationId = (await readRecordFile().catch(() => undefined))
        ?.preparation.lastOperationId;
      const launched = launchEnvironmentCli(
        [
          "prepare",
          "--environment",
          scene.name,
          "--config-json",
          JSON.stringify({ profile: "running-service", webPort: scene.port }),
        ],
        { detached: true },
      );
      expect(
        await ownGroupReady(launched.child),
        "独立 CLI 没有成为自己的进程组组长",
      ).toBe(true);
      // 本次操作的意图记录与日志目录都先于阶段命令建立：按这两份公开落盘事实拿到操作身份。
      let operationId = "";
      const claimed = await waitFor(
        async () => {
          const candidate = (await readRecordFile().catch(() => undefined))
            ?.preparation.lastOperationId;
          if (candidate === undefined || candidate === priorOperationId)
            return false;
          operationId = candidate;
          return true;
        },
        60_000,
        20,
      );
      if (!claimed) {
        const answer = await launched.done;
        throw new Error(
          `本次准备没有留下操作身份（退出码 ${String(
            answer.code,
          )} 输出 ${shorten(answer)}）`,
        );
      }
      const logDirectory = path.join(
        scene.containerDirectory,
        "logs",
        operationId,
      );
      const stageLogFile = path.join(logDirectory, "migrate.log");
      if (!(await waitFor(() => exists(logDirectory), 60_000, 20))) {
        const answer = await launched.done;
        throw new Error(
          `本次准备没有建立日志目录 ${operationId}（退出码 ${String(
            answer.code,
          )} 输出 ${shorten(answer)}）`,
        );
      }
      // 延迟边界只由本测试放行：迁移阶段要打开的日志目标换成管道之后，「日志目录已取得、
      // 命令尚未交给系统」这一段会停在那次打开上，而不是靠抢毫秒级空档。
      const staged = await run({ command: "mkfifo", args: [stageLogFile] });
      expect(staged.code, staged.stderr).toBe(0);
      // 迁移阶段的打开没有读者就不会结束：构建完成的说明写下之后，本阶段只能停在那里。
      const operationLog = path.join(logDirectory, "operation.log");
      const blocked = await waitFor(
        async () =>
          (readTextQuietly(operationLog) ?? "").includes("阶段 build 完成"),
        realRunTimeout,
        20,
      );
      if (!blocked) {
        const answer = await launched.done;
        throw new Error(
          `构建阶段没有交出「阶段 build 完成」说明（退出码 ${String(
            answer.code,
          )} 输出 ${shorten(answer)}）`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        (readTextQuietly(operationLog) ?? "").includes("阶段 migrate 完成"),
        "延迟边界没有挡住迁移阶段：没有读者的情况下它已经走完",
      ).toBe(false);
      const cancelledAt = new Date().toISOString();
      const delivered = signalOwnProcessGroup(launched.child, "SIGTERM");
      expect(delivered, "没有向自有进程组送达 SIGTERM").toBe(true);
      // 取消成立之后才放行读者：那次打开得以结束，但提交截止点必须把命令挡在交给系统之前。
      const stageLog = await drainStagePipe(stageLogFile, 60_000);
      const answer = await launched.done;
      const data = envelope(answer, "阶段取得日志资源途中取消");
      notes.push(
        `取消于 ${cancelledAt} 送达自有进程组；放行读者之后本阶段交出「${stageLog.trim()}」，外层退出码 ${String(
          answer.code,
        )} 信号 ${String(answer.signal)}，结果 ${data.status} 阶段 ${
          data.failure?.stage ?? ""
        } 首因 ${data.failure?.message ?? "无"} 收尾 ${
          data.cleanup?.state ?? "无"
        }`,
      );
      console.log(`05 阶段取得日志资源途中取消\n${notes.join("\n")}`);

      // 阶段日志里只有「没有交给系统」这一行事实：打开结束不允许变成迟到的启动。
      expect(stageLog).toMatch(/^.{24} skip /mu);
      expect(stageRunLine.test(stageLog)).toBe(false);
      expect(data.status).toBe("failed");
      expect(data.failure?.stage).toBe("migrate");
      expect(data.failure?.message).toContain("操作进程收到 SIGTERM");
      // 收尾如实说明本阶段没有自有子进程，而不是把空持有集合说成已停止。
      expect(data.failure?.message).toContain(
        "阶段 migrate 尚未把命令交给系统",
      );
      expect(data.cleanup?.state).toBe("stopped");
      // 待决启动收敛之后才交出收尾结论，第三个阶段没有因此被启动。
      expect(
        await exists(path.join(logDirectory, "read.log")),
        "取消之后仍然出现了后续阶段日志",
      ).toBe(false);
      const record = await readRecordFile();
      expect(record.preparation.state).toBe("failed");
      expect(record.preparation.lastFailure?.message).toBe(
        data.failure?.message,
      );
      expect(record.preparation.lastFailure?.cleanup).toBe("stopped");
      const inspection = await inspectEnvironment(sceneRef());
      expect(inspection.state).toBe("failed");
      expect(inspection.preparation?.lastFailure?.message).toBe(
        data.failure?.message,
      );
      expect(inspection.preparation?.lastFailure?.cleanup).toBe("stopped");
      expect(await portOpen(scene.port)).toBe(false);
      expect(await workflowHistoryIds()).toContain(businessRecord.executionId);
    },
    realRunTimeout,
  );
});

/**
 * `/api/ready` 的一次真实探测：只取状态码。端口还没听、连接被拒都只表示「此刻没有回答」，
 * 不能终止对提交瞬间的观察。
 */
async function readyProbeStatus(port: number): Promise<number> {
  return await httpGet(port, "/api/ready").then(
    (answer) => answer.status,
    () => 0,
  );
}
