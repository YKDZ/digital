import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
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

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const environmentCli = path.join("packages", "environment", "dist", "cli.js");
const productCli = path.join("apps", "cli", "dist", "cli.js");
/** 03-2 需要另一个 realpath 的完整工作区现场，由门禁环境显式提供。 */
const secondWorkspace =
  process.env.DIGITAL_03_SECOND_WORKSPACE === undefined
    ? undefined
    : path.resolve(process.env.DIGITAL_03_SECOND_WORKSPACE);
/** 受控端口区间由门禁环境给出；没有给出时退回系统分配的临时空闲端口。 */
const portFloor =
  process.env.DIGITAL_03_PORT_BASE === undefined
    ? undefined
    : Number(process.env.DIGITAL_03_PORT_BASE);
const portCeiling =
  process.env.DIGITAL_03_PORT_CEILING === undefined
    ? undefined
    : Number(process.env.DIGITAL_03_PORT_CEILING);
const startLedgerPath =
  process.env.DIGITAL_03_LEDGER ??
  path.join(tmpdir(), "digital-03-start-ledger.ndjson");

const suffix = randomUUID().slice(0, 8);
const nameA = `t03-a-${suffix}`;
const nameB = `t03-b-${suffix}`;
const sharedName = `t03-shared-${suffix}`;

const realRunTimeout = 600_000;
const prepareTimeout = 720_000;

type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type ClosableListener = {
  requests(): number;
  close(): Promise<void>;
};

/** 一个已准备环境对外可见的全部可寻址事实。 */
type Site = {
  readonly label: string;
  readonly workspacePath: string;
  readonly environment: string;
  readonly port: number;
  readonly productDataRoot: string;
  readonly containerDirectory: string;
  readonly recordPath: string;
  readonly inputs: readonly string[];
  runId: string | null;
};

const createdContainers: string[] = [];
const temporaryDirectories: string[] = [];
const openListeners: ClosableListener[] = [];
const startedSites: Site[] = [];
const sites: Record<string, Site> = {};

/**
 * 每一发公开 start 在请求离开之前先落到持久账本：环境、工作区、端口与预期归属
 * 都在那一刻被记录，后续结果、抛错或断言失败都不能让世代变成没人认领的现场。
 */
type StartAttempt = {
  readonly label: string;
  readonly environment: string;
  readonly workspacePath: string;
  readonly port: number;
  readonly issuedAt: string;
  status?: string;
  runId?: string | null;
};

const startAttempts: StartAttempt[] = [];

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function appendLedger(fields: Record<string, unknown>): void {
  appendFileSync(startLedgerPath, `${JSON.stringify(fields)}\n`);
}

function recordStartAttempt(attempt: StartAttempt): void {
  startAttempts.push(attempt);
  appendLedger({ event: "start-issued", owner: "03 行动", ...attempt });
}

function observeStart(
  attempt: StartAttempt,
  result: { readonly status: string; readonly run: { runId: string | null } },
): void {
  attempt.status = result.status;
  attempt.runId = result.run.runId;
  appendLedger({
    event: "start-result",
    label: attempt.label,
    status: result.status,
    runId: result.run.runId,
  });
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
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<CommandResult> {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd ?? workspaceRoot,
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
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

/** 独立 CLI 进程：从所处工作区出发管理该工作区里的环境。 */
async function cliAt(
  cwd: string,
  args: readonly string[],
): Promise<CommandResult> {
  return await run({
    command: process.execPath,
    args: [environmentCli, ...args],
    cwd,
  });
}

async function cli(args: readonly string[]): Promise<CommandResult> {
  return await cliAt(workspaceRoot, args);
}

/** 正式产品 CLI：只在没有服务持有单写入者锁时对选定数据根发起。 */
async function productRead(
  cwd: string,
  productDataRoot: string,
  args: readonly string[],
): Promise<CommandResult> {
  return await run({
    command: process.execPath,
    args: [path.join(cwd, productCli), ...args],
    cwd,
    env: { ...cleanEnvironment(), DIGITAL_PRODUCT_DATA: productDataRoot },
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function materialDirectory(
  prefix: string,
  fileName: string,
  content: string,
): Promise<string> {
  const directory = await temporaryDirectory(prefix);
  await writeFile(path.join(directory, fileName), content, "utf8");
  return directory;
}

/** 材料目录指纹：文件清单与内容一起比较，用于证明素材只被读取。 */
function materialFingerprint(directory: string): string {
  return createHash("sha256")
    .update(
      readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) =>
          entry.isFile()
            ? `${entry.name}:${createHash("sha256")
                .update(readFileSync(path.join(directory, entry.name)))
                .digest("hex")}`
            : `${entry.name}:<dir>`,
        )
        .join("\n"),
    )
    .digest("hex");
}

let lastUsedPort = 0;

/** 端口先真实验证空闲再登记使用；受控区间用尽就直接失败，不越界占别人的端口。 */
async function allocatePort(): Promise<number> {
  if (portFloor === undefined) {
    const probe = createNetServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
    });
    const address = probe.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });
    lastUsedPort = port;
    return port;
  }
  const ceiling = portCeiling ?? portFloor + 50;
  for (
    let candidate = lastUsedPort === 0 ? portFloor : lastUsedPort + 1;
    candidate <= ceiling;
    candidate += 1
  ) {
    if (await portOpen(candidate)) continue;
    lastUsedPort = candidate;
    return candidate;
  }
  throw new Error(
    `受控端口区间 ${String(portFloor)}—${String(ceiling)} 已用尽`,
  );
}

/** 自有无关监听：只统计被请求次数，用于证明旧端口既不被接管也不被串用。 */
async function startOwnListener(port: number): Promise<ClosableListener> {
  let requests = 0;
  const server = createServer((_incoming, outgoing) => {
    requests += 1;
    outgoing.writeHead(200, { "content-type": "text/plain" });
    outgoing.end("03 自有无关监听");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1" }, resolve);
  });
  const handle: ClosableListener = {
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  openListeners.push(handle);
  return handle;
}

async function httpRequest(input: {
  readonly port: number;
  readonly pathname: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<{ readonly status: number; readonly body: string }> {
  return await new Promise((resolve, reject) => {
    const payload =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    const handle = request(
      {
        host: "127.0.0.1",
        port: input.port,
        path: input.pathname,
        method: input.method ?? "GET",
        agent: false,
        headers:
          payload === undefined
            ? (input.headers ?? {})
            : {
                ...input.headers,
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              },
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body }),
        );
      },
    );
    handle.on("error", reject);
    if (payload !== undefined) handle.write(payload);
    handle.end();
  });
}

async function jsonAt(port: number, pathname: string): Promise<unknown> {
  const response = await httpRequest({ port, pathname });
  expect(response.status, `${pathname} → ${response.body}`).toBe(200);
  return JSON.parse(response.body);
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

async function waitPortClosed(port: number, attempts = 100): Promise<boolean> {
  for (let index = 0; index < attempts; index += 1) {
    if (!(await portOpen(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await portOpen(port));
}

function readRecord(site: Site): {
  run: { address: string; port: number; productLogFile: string | null };
} {
  return JSON.parse(readFileSync(site.recordPath, "utf8")) as ReturnType<
    typeof readRecord
  >;
}

function processAlive(pid: number): boolean {
  return existsSync(`/proc/${String(pid)}`);
}

function processCommandLine(pid: number): string {
  return (
    readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0")[0] ?? ""
  );
}

function processEnvironment(pid: number): readonly string[] {
  return readFileSync(`/proc/${String(pid)}/environ`, "utf8").split("\0");
}

/** 轮询公开 HTTP：整个并发窗口持续要求同一世代给出认证就绪。 */
function pollService(site: Site): {
  halt(): Promise<{ polls: number; failures: string[]; runIds: string[] }>;
} {
  let stopped = false;
  const failures: string[] = [];
  const runIds = new Set<string>();
  let polls = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        const response = await httpRequest({
          port: site.port,
          pathname: "/api/ready",
          headers: {
            "digital-environment-nonce": randomUUID().replace(/-/g, ""),
          },
        });
        if (response.status !== 200) {
          failures.push(`状态 ${String(response.status)}`);
        } else {
          const body = JSON.parse(response.body) as { runId?: string };
          if (typeof body.runId === "string") runIds.add(body.runId);
          else failures.push("本世代认证缺失");
        }
      } catch (error) {
        failures.push(describeFailure(error));
      }
      polls += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  })();
  return {
    halt: async () => {
      stopped = true;
      await loop;
      return { polls, failures, runIds: [...runIds] };
    },
  };
}

function unwrap<T>(stdout: string): T {
  return (JSON.parse(stdout) as { data: T }).data;
}

function siteOf(
  label: string,
  workspacePath: string,
  prepared: PrepareOperationResult,
  port: number,
): Site {
  const containerDirectory = prepared.environment.containerDirectory;
  return {
    label,
    workspacePath,
    environment: prepared.environment.environment,
    port,
    productDataRoot: prepared.environment.productDataRoot,
    containerDirectory,
    recordPath: path.join(containerDirectory, "record.json"),
    inputs: prepared.environment.inputs,
    runId: null,
  };
}

function registerSite(site: Site): Site {
  createdContainers.push(site.containerDirectory);
  startedSites.push(site);
  sites[site.label] = site;
  return site;
}

async function startRegistered(
  site: Site,
  label: string,
): Promise<StartOperationResult> {
  const attempt: StartAttempt = {
    label,
    environment: site.environment,
    workspacePath: site.workspacePath,
    port: site.port,
    issuedAt: new Date().toISOString(),
  };
  recordStartAttempt(attempt);
  try {
    const result = await startEnvironment({
      workspacePath: site.workspacePath,
      environment: site.environment,
    });
    observeStart(attempt, result);
    if (result.status === "ready" || result.status === "already-ready")
      site.runId = result.run.runId;
    return result;
  } catch (error) {
    attempt.status = `调用抛出：${describeFailure(error)}`;
    throw error;
  }
}

function libraryRequest(displayName: string, directory: string) {
  return {
    action: "save",
    displayName,
    directories: [directory],
    recognitionProfileIds: ["books"],
    sourceIdentities: ["dlsite"],
  };
}

type SettingsProjection = {
  productDataDirectory?: string;
  libraries: { displayName: string; directories: string[] }[];
};

async function settingsProjection(site: Site): Promise<SettingsProjection> {
  return (await jsonAt(site.port, "/api/settings")) as SettingsProjection;
}

async function libraryViews(site: Site): Promise<unknown> {
  return await jsonAt(site.port, "/api/libraries");
}

async function historyText(site: Site): Promise<string> {
  const response = await httpRequest({
    port: site.port,
    pathname: "/api/catalogue?surface=workflow-history&limit=50",
  });
  return `${String(response.status)}:${response.body}`;
}

beforeAll(async () => {
  if (
    secondWorkspace !== undefined &&
    (secondWorkspace === workspaceRoot ||
      secondWorkspace.startsWith(`${workspaceRoot}${path.sep}`))
  )
    throw new Error("第二工作区必须是与本树 realpath 不同的独立工作区现场");
}, 60_000);

afterAll(async () => {
  for (const listener of openListeners)
    await listener.close().catch(() => undefined);
  const issued = startAttempts.map(
    (attempt) =>
      `${attempt.label}：环境 ${attempt.environment}（工作区 ${attempt.workspacePath}，端口 ${String(attempt.port)}）于 ${attempt.issuedAt} 发出，结果 ${
        attempt.status ?? "未提交"
      }，世代 ${attempt.runId ?? "无"}`,
  );
  const retained: string[] = [];
  const stopped: string[] = [];
  for (const site of startedSites) {
    let stop: StopOperationResult;
    try {
      stop = await stopEnvironment({
        workspacePath: site.workspacePath,
        environment: site.environment,
      });
    } catch (error) {
      retained.push(
        `${site.workspacePath} :: ${site.environment}：公开停止调用本身抛出（${describeFailure(error)}），按未知保留记录、启动配置、产品数据与日志，请再次发出公开停止：stop --environment ${site.environment} --workspace-path ${site.workspacePath}`,
      );
      continue;
    }
    let confirmed: InspectEnvironmentResult;
    try {
      confirmed = await inspectEnvironment({
        workspacePath: site.workspacePath,
        environment: site.environment,
      });
    } catch (error) {
      retained.push(
        `${site.workspacePath} :: ${site.environment}：公开停止返回 ${stop.status} 后独立查看抛出（${describeFailure(error)}），按未知保留记录、启动配置、产品数据与日志（运行日志 ${stop.run.productLogFile ?? "无"}），请再次发出公开停止：stop --environment ${site.environment} --workspace-path ${site.workspacePath}`,
      );
      continue;
    }
    const closed =
      (stop.status === "stopped" || stop.status === "already-stopped") &&
      (confirmed.run.processLiveness === "exited" ||
        confirmed.run.processLiveness === "absent") &&
      confirmed.serviceReadiness !== "ready";
    stopped.push(
      `${site.workspacePath} :: ${site.environment}（端口 ${String(site.port)}）：${stop.status} / 记录 ${stop.run.state}（结束事实 ${stop.run.endedAt ?? "无"}）/ 独立查看进程 ${confirmed.run.processLiveness} / 就绪 ${confirmed.serviceReadiness} / 收尾 ${stop.cleanup.state} / 运行日志 ${stop.run.productLogFile ?? "无"}`,
    );
    if (!closed)
      retained.push(
        `${site.workspacePath} :: ${site.environment}：公开停止返回 ${stop.status}，独立查看显示进程 ${confirmed.run.processLiveness}、就绪 ${confirmed.serviceReadiness}，按未知保留记录、启动配置、产品数据与日志（运行日志 ${stop.run.productLogFile ?? "无"}），请再次发出公开停止：stop --environment ${site.environment} --workspace-path ${site.workspacePath}`,
      );
  }
  console.log(
    `[并发环境现场账本 · ${startLedgerPath}]\n发出的 start：\n${
      issued.length === 0 ? "无" : issued.join("\n")
    }\n公开停止：\n${stopped.join("\n") || "无"}\n保留待收尾：\n${
      retained.length === 0 ? "无" : retained.join("\n")
    }`,
  );
  if (retained.length > 0)
    throw new Error(
      `本世代未按公开停止确认真实退出，保留现场：\n${retained.join("\n")}`,
    );
  for (const container of createdContainers)
    await rm(container, { recursive: true, force: true });
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
}, prepareTimeout);

describe("同一工作区与跨工作区环境的真实并发隔离", () => {
  it(
    "同工作区两个环境并行准备与公开启动，各自持有独立数据根、端口、日志与记录并同时可服务",
    async () => {
      const portA = await allocatePort();
      const portB = await allocatePort();
      const inputA = await materialDirectory(
        "digital-03-material-a-",
        "并发甲.txt",
        "只有环境甲看得到这份材料\n",
      );
      const inputB = await materialDirectory(
        "digital-03-material-b-",
        "并发乙.txt",
        "只有环境乙看得到这份材料\n",
      );
      const [preparedA, preparedB] = await Promise.all([
        prepareEnvironment({
          workspacePath: workspaceRoot,
          environment: nameA,
          inputs: [inputA],
          config: { profile: "concurrent-environments", webPort: portA },
        }),
        prepareEnvironment({
          workspacePath: workspaceRoot,
          environment: nameB,
          inputs: [inputB],
          config: { profile: "concurrent-environments", webPort: portB },
        }),
      ]);
      expect(preparedA.status, preparedA.failure?.message).toBe("prepared");
      expect(preparedB.status, preparedB.failure?.message).toBe("prepared");

      const siteA = registerSite(siteOf("甲", workspaceRoot, preparedA, portA));
      const siteB = registerSite(siteOf("乙", workspaceRoot, preparedB, portB));
      expect(siteA.inputs).toEqual([inputA]);
      expect(siteB.inputs).toEqual([inputB]);
      expect(siteA.productDataRoot).not.toBe(siteB.productDataRoot);
      expect(siteA.containerDirectory).not.toBe(siteB.containerDirectory);
      expect(siteA.recordPath).not.toBe(siteB.recordPath);

      const [startA, startB] = await Promise.all([
        startRegistered(siteA, "并行首次 start 甲"),
        startRegistered(siteB, "并行首次 start 乙"),
      ]);
      expect(startA.status, startA.failure?.message).toBe("ready");
      expect(startB.status, startB.failure?.message).toBe("ready");
      expect(startA.run.pid).not.toBe(startB.run.pid);
      expect(startA.run.runId).not.toBe(startB.run.runId);
      expect(startA.run.address).toBe(`http://127.0.0.1:${String(portA)}`);
      expect(startB.run.address).toBe(`http://127.0.0.1:${String(portB)}`);
      expect(startA.run.productLogFile).not.toBe(startB.run.productLogFile);

      // 两个真实进程同时提供 HTTP，各自报告自己的数据根。
      const settingsA = await settingsProjection(siteA);
      const settingsB = await settingsProjection(siteB);
      expect(settingsA.productDataDirectory).toBeDefined();
      expect(settingsB.productDataDirectory).toBeDefined();
      expect(settingsA.productDataDirectory).not.toBe(
        settingsB.productDataDirectory,
      );
      expect(await jsonAt(portA, "/api/ready")).toEqual({
        ok: true,
        service: "digital-web",
      });
      expect(await jsonAt(portB, "/api/ready")).toEqual({
        ok: true,
        service: "digital-web",
      });

      // 归属只属于各自进程：从 /proc 读真实进程的自有环境。
      const pidA = startA.run.pid;
      const pidB = startB.run.pid;
      expect(pidA).not.toBeNull();
      expect(pidB).not.toBeNull();
      expect(processEnvironment(pidA!)).toContain(
        `DIGITAL_PRODUCT_DATA=${siteA.productDataRoot}`,
      );
      expect(processEnvironment(pidB!)).toContain(
        `DIGITAL_PRODUCT_DATA=${siteB.productDataRoot}`,
      );
      expect(processEnvironment(pidA!)).toContain(`PORT=${String(portA)}`);
      expect(processEnvironment(pidB!)).toContain(`PORT=${String(portB)}`);

      // 独立 CLI 进程同时点名两个环境，报告的是各自的真实世代。
      const inspectedA = await cli(["inspect", "--environment", nameA]);
      const inspectedB = await cli(["inspect", "--environment", nameB]);
      expect(inspectedA.code, inspectedA.stderr).toBe(0);
      expect(inspectedB.code, inspectedB.stderr).toBe(0);
      expect(
        unwrap<InspectEnvironmentResult>(inspectedA.stdout).run.runId,
      ).toBe(startA.run.runId);
      expect(
        unwrap<InspectEnvironmentResult>(inspectedB.stdout).run.runId,
      ).toBe(startB.run.runId);
      expect(
        unwrap<InspectEnvironmentResult>(inspectedA.stdout).serviceReadiness,
      ).toBe("ready");
      expect(
        unwrap<InspectEnvironmentResult>(inspectedB.stdout).serviceReadiness,
      ).toBe("ready");
    },
    prepareTimeout,
  );

  it(
    "停启甲不影响乙：乙在整个窗口持续 HTTP 可访问且产品读取值逐项不变",
    async () => {
      const siteA = sites["甲"]!;
      const siteB = sites["乙"]!;
      const baselineB = {
        settings: await settingsProjection(siteB),
        libraries: await libraryViews(siteB),
        history: await historyText(siteB),
      };
      const poller = pollService(siteB);
      const previousRunIdA = siteA.runId;

      const inspected = await cli(["inspect", "--environment", nameA]);
      expect(inspected.code, inspected.stderr).toBe(0);
      expect(
        unwrap<InspectEnvironmentResult>(inspected.stdout).serviceReadiness,
      ).toBe("ready");

      const stopped = await cli(["stop", "--environment", nameA]);
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(unwrap<StopOperationResult>(stopped.stdout).status).toBe(
        "stopped",
      );
      expect(await waitPortClosed(siteA.port)).toBe(true);

      const restarted = await startRegistered(siteA, "并发窗口内重启 start 甲");
      expect(restarted.status, restarted.failure?.message).toBe("ready");
      expect(restarted.run.runId).not.toBe(previousRunIdA);
      expect(restarted.run.port).toBe(siteA.port);

      const observed = await poller.halt();
      expect(observed.polls).toBeGreaterThan(2);
      expect(observed.failures).toEqual([]);
      // 乙在整个窗口只由同一个世代作答，没有被甲的停启换掉。
      expect(observed.runIds).toEqual([siteB.runId]);
      expect(await settingsProjection(siteB)).toEqual(baselineB.settings);
      expect(await libraryViews(siteB)).toEqual(baselineB.libraries);
      expect(await historyText(siteB)).toBe(baselineB.history);

      const stillB = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: nameB,
      });
      expect(stillB.serviceReadiness).toBe("ready");
      expect(stillB.run.runId).not.toBe(restarted.run.runId);
    },
    realRunTimeout,
  );

  it(
    "输入目录与来源配置按环境生效：改甲不动乙，业务结果与素材归属各自独立",
    async () => {
      const siteA = sites["甲"]!;
      const siteB = sites["乙"]!;
      const baselineB = {
        settings: await settingsProjection(siteB),
        libraries: await libraryViews(siteB),
        history: await historyText(siteB),
      };
      const fingerprintA = materialFingerprint(siteA.inputs[0]!);
      const fingerprintB = materialFingerprint(siteB.inputs[0]!);

      const created = await httpRequest({
        port: siteA.port,
        pathname: "/api/settings/libraries",
        method: "POST",
        body: libraryRequest(`并发甲库-${suffix}`, siteA.inputs[0]!),
      });
      expect(created.status, created.body).toBe(200);
      const libraryId = (JSON.parse(created.body) as { id: string }).id;
      expect(libraryId).toBeTruthy();

      // 甲的正式入口立刻看到这条配置，乙的正式入口一项不变。
      const settingsA = await settingsProjection(siteA);
      expect(
        settingsA.libraries.some(
          (entry) => entry.displayName === `并发甲库-${suffix}`,
        ),
      ).toBe(true);
      expect(await settingsProjection(siteB)).toEqual(baselineB.settings);
      expect(await libraryViews(siteB)).toEqual(baselineB.libraries);

      // 公开停服后，正式产品 CLI 只在甲的数据根上做真实扫描与读取。
      const stopped = await stopEnvironment({
        workspacePath: workspaceRoot,
        environment: nameA,
      });
      expect(stopped.status).toBe("stopped");
      const scan = await productRead(workspaceRoot, siteA.productDataRoot, [
        "scan-library",
        libraryId,
        "--preview",
        "--json",
      ]);
      expect(scan.code, `${scan.stdout}${scan.stderr}`).toBe(0);
      const executionId = (
        JSON.parse(scan.stdout) as {
          directories: { childExecutionId: string }[];
        }
      ).directories[0]!.childExecutionId;
      const historyA = await productRead(workspaceRoot, siteA.productDataRoot, [
        "catalogue-surface",
        "--surface",
        "workflow-history",
      ]);
      expect(historyA.code, historyA.stderr).toBe(0);
      expect(historyA.stdout).toContain(executionId);

      // 乙仍在服务：正式 CLI 写入者锁拒绝跨根并发，业务读取因此走乙自己的 HTTP 入口。
      const blockedB = await productRead(workspaceRoot, siteB.productDataRoot, [
        "catalogue-surface",
        "--surface",
        "workflow-history",
      ]);
      expect(blockedB.code).not.toBe(0);
      expect(`${blockedB.stdout}${blockedB.stderr}`).toContain(
        "拒绝并发启动另一个产品写入者",
      );
      expect(await historyText(siteB)).toBe(baselineB.history);
      expect(await historyText(siteB)).not.toContain(executionId);
      expect(await settingsProjection(siteB)).toEqual(baselineB.settings);
      expect(await libraryViews(siteB)).toEqual(baselineB.libraries);

      // 素材只被读取，不被产品改写。
      expect(materialFingerprint(siteA.inputs[0]!)).toBe(fingerprintA);
      expect(materialFingerprint(siteB.inputs[0]!)).toBe(fingerprintB);
    },
    realRunTimeout,
  );

  it.runIf(secondWorkspace !== undefined)(
    "两个 realpath 不同的工作区使用同名环境：命令只选自己，停止一个不影响另一个",
    async () => {
      const otherWorkspace = secondWorkspace!;
      const portOne = await allocatePort();
      const portTwo = await allocatePort();
      const inputOne = await materialDirectory(
        "digital-03-material-shared-one-",
        "同名甲.txt",
        "工作区甲的同名环境材料\n",
      );
      const inputTwo = await materialDirectory(
        "digital-03-material-shared-two-",
        "同名乙.txt",
        "工作区乙的同名环境材料\n",
      );
      // 各工作区自己的 CLI 进程，从自己的目录出发准备同名环境。
      const [preparedOne, preparedTwo] = await Promise.all([
        cli([
          "prepare",
          "--environment",
          sharedName,
          "--input",
          inputOne,
          "--config-json",
          JSON.stringify({
            profile: "concurrent-environments",
            webPort: portOne,
          }),
        ]),
        cliAt(otherWorkspace, [
          "prepare",
          "--environment",
          sharedName,
          "--workspace-path",
          otherWorkspace,
          "--input",
          inputTwo,
          "--config-json",
          JSON.stringify({
            profile: "concurrent-environments",
            webPort: portTwo,
          }),
        ]),
      ]);
      expect(preparedOne.code, preparedOne.stderr).toBe(0);
      expect(preparedTwo.code, preparedTwo.stderr).toBe(0);
      const dataOne = unwrap<PrepareOperationResult>(preparedOne.stdout);
      const dataTwo = unwrap<PrepareOperationResult>(preparedTwo.stdout);
      expect(dataOne.status, dataOne.failure?.message).toBe("prepared");
      expect(dataTwo.status, dataTwo.failure?.message).toBe("prepared");
      const siteOne = registerSite(
        siteOf("同名·工作区甲", workspaceRoot, dataOne, portOne),
      );
      const siteTwo = registerSite(
        siteOf("同名·工作区乙", otherWorkspace, dataTwo, portTwo),
      );
      expect(siteOne.environment).toBe(siteTwo.environment);
      expect(siteOne.workspacePath).not.toBe(siteTwo.workspacePath);
      expect(siteOne.productDataRoot).not.toBe(siteTwo.productDataRoot);

      const [startOne, startTwo] = await Promise.all([
        startRegistered(siteOne, "同名并行 start 甲"),
        startRegistered(siteTwo, "同名并行 start 乙"),
      ]);
      expect(startOne.status, startOne.failure?.message).toBe("ready");
      expect(startTwo.status, startTwo.failure?.message).toBe("ready");
      expect(startOne.run.pid).not.toBe(startTwo.run.pid);
      expect(
        processEnvironment(startTwo.run.pid!)
          .join("\n")
          .includes(siteOne.productDataRoot),
      ).toBe(false);

      // 两个同名环境各自报告自己的数据根与自己的配置，互不串用。
      const saveTwo = await httpRequest({
        port: siteTwo.port,
        pathname: "/api/settings/libraries",
        method: "POST",
        body: libraryRequest(`同名乙库-${suffix}`, inputTwo),
      });
      expect(saveTwo.status, saveTwo.body).toBe(200);
      const settingsOne = await settingsProjection(siteOne);
      const settingsTwo = await settingsProjection(siteTwo);
      expect(settingsOne.productDataDirectory).not.toBe(
        settingsTwo.productDataDirectory,
      );
      expect(settingsTwo.libraries.map((entry) => entry.displayName)).toContain(
        `同名乙库-${suffix}`,
      );
      expect(
        settingsOne.libraries.map((entry) => entry.displayName),
      ).not.toContain(`同名乙库-${suffix}`);

      // 每个工作区的命令只选自己的目标：不带 --workspace-path 时按所处目录解析。
      const inspectedOne = await cli(["inspect", "--environment", sharedName]);
      const inspectedTwo = await cliAt(otherWorkspace, [
        "inspect",
        "--environment",
        sharedName,
      ]);
      expect(inspectedOne.code, inspectedOne.stderr).toBe(0);
      expect(inspectedTwo.code, inspectedTwo.stderr).toBe(0);
      expect(
        unwrap<InspectEnvironmentResult>(inspectedOne.stdout).run.runId,
      ).toBe(startOne.run.runId);
      expect(
        unwrap<InspectEnvironmentResult>(inspectedTwo.stdout).run.runId,
      ).toBe(startTwo.run.runId);

      // 停掉甲：乙继续由同一世代服务，甲的端口与记录都不影响乙。
      const stoppedOne = await cli(["stop", "--environment", sharedName]);
      expect(stoppedOne.code, stoppedOne.stderr).toBe(0);
      expect(unwrap<StopOperationResult>(stoppedOne.stdout).status).toBe(
        "stopped",
      );
      expect(await waitPortClosed(siteOne.port)).toBe(true);
      const poller = pollService(siteTwo);
      const observed = await poller.halt();
      expect(observed.failures).toEqual([]);
      expect(observed.runIds).toEqual([startTwo.run.runId]);
      expect(await settingsProjection(siteTwo)).toEqual(settingsTwo);
      const stoppedOneInspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: sharedName,
      });
      expect(stoppedOneInspection.serviceReadiness).not.toBe("ready");
      expect(stoppedOneInspection.run.processLiveness).toBe("exited");

      // 甲的真实数据根在停止后仍可被甲自己的正式 CLI 读取，乙的数据完全独立。
      const historyOne = await productRead(
        workspaceRoot,
        siteOne.productDataRoot,
        ["catalogue-surface", "--surface", "workflow-history"],
      );
      expect(historyOne.code, historyOne.stderr).toBe(0);
      const settingsOneAfter = await settingsProjection(siteTwo);
      expect(settingsOneAfter.productDataDirectory).not.toBe(
        siteOne.productDataRoot,
      );
    },
    prepareTimeout,
  );

  it(
    "陈旧运行事实不被误报为就绪也不被接管：真实退出世代、被占旧端口与可达旧记录",
    async () => {
      const siteA = sites["甲"]!;
      const siteB = sites["乙"]!;

      // 甲上一轮公开停止后是真实退出的世代：查看只报告结束事实。
      const exitedRunId = siteA.runId;
      expect(exitedRunId).not.toBeNull();
      const exited = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: nameA,
      });
      expect(exited.run.runId).toBe(exitedRunId);
      expect(exited.run.processLiveness).toBe("exited");
      expect(exited.serviceReadiness).toBe("not-ready");

      // 旧端口被另一个自有服务占据：不接管、不换端口、不串用。
      const occupier = await startOwnListener(siteA.port);
      const failed = await startRegistered(siteA, "端口被占 start 甲");
      expect(failed.status).toBe("failed");
      expect(failed.failure?.stage).toBe("port");
      expect(failed.failure?.message).toContain("不接管");
      expect(failed.cleanup.state).toBe("not-started");
      expect(occupier.requests()).toBe(0);
      expect(await portOpen(siteA.port)).toBe(true);
      await occupier.close();
      expect(await waitPortClosed(siteA.port)).toBe(true);
      expect(
        (
          await inspectEnvironment({
            workspacePath: workspaceRoot,
            environment: nameA,
          })
        ).run.runId,
      ).toBe(exitedRunId);

      // 端口恢复空闲后公开启动，甲带着自己的数据与配置重新服务。
      const started = await startRegistered(siteA, "端口空闲后 start 甲");
      expect(started.status, started.failure?.message).toBe("ready");
      expect(started.run.runId).not.toBe(exitedRunId);
      expect(started.run.port).toBe(siteA.port);
      const settingsA = await settingsProjection(siteA);
      expect(settingsA.productDataDirectory).toBe(siteA.productDataRoot);
      expect(settingsA.libraries.map((entry) => entry.displayName)).toContain(
        `并发甲库-${suffix}`,
      );

      // 陈旧可达记录：把甲记录里的服务地址与端口指到乙正在服务的真实端口。
      // 世代身份与私有现场都不动，因此这只检验本环境的观察是否会被别处的活服务蒙混。
      const recordOriginal = await readFile(siteA.recordPath, "utf8");
      const record = readRecord(siteA);
      try {
        record.run.address = `http://127.0.0.1:${String(siteB.port)}`;
        record.run.port = siteB.port;
        await writeFile(
          siteA.recordPath,
          `${JSON.stringify(record, null, 2)}\n`,
        );
        const stale = await inspectEnvironment({
          workspacePath: workspaceRoot,
          environment: nameA,
        });
        expect(stale.serviceReadiness).toBe("not-ready");
        expect(stale.runProblem ?? "").toContain("世代不符");
        // 可达的活服务属于乙：甲既不复用它的就绪，也不借它启动。
        const refused = await startRegistered(siteA, "陈旧可达记录 start 甲");
        expect(refused.status).toBe("refused");
        expect(refused.failure?.stage).toBe("generation");
        expect(refused.cleanup.state).toBe("not-started");
        // 乙照常由自己的世代服务，没有被甲的查看或启动动过。
        const stillB = await inspectEnvironment({
          workspacePath: workspaceRoot,
          environment: nameB,
        });
        expect(stillB.serviceReadiness).toBe("ready");
        expect(stillB.run.runId).toBe(siteB.runId);
        expect(stillB.run.pid).not.toBe(started.run.pid);
      } finally {
        await writeFile(siteA.recordPath, recordOriginal);
      }

      const restored = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: nameA,
      });
      expect(restored.serviceReadiness).toBe("ready");
      expect(restored.run.runId).toBe(started.run.runId);
    },
    realRunTimeout,
  );

  it(
    "全部控制都落在真实进程与公开接口上：公开查看、公开停止、退出事实与完整日志",
    async () => {
      const liveSites = [
        sites["甲"],
        sites["乙"],
        sites["同名·工作区乙"],
      ].filter((site): site is Site => site !== undefined);
      expect(liveSites.length).toBeGreaterThanOrEqual(2);
      const live: { site: Site; pid: number; secrets: readonly string[] }[] =
        [];
      for (const site of liveSites) {
        const inspected = await cliAt(site.workspacePath, [
          "inspect",
          "--environment",
          site.environment,
        ]);
        expect(inspected.code, inspected.stderr).toBe(0);
        const facts = unwrap<InspectEnvironmentResult>(inspected.stdout);
        expect(facts.serviceReadiness).toBe("ready");
        expect(facts.run.runId).toBe(site.runId);
        const pid = facts.run.pid;
        expect(pid).not.toBeNull();
        expect(processAlive(pid!)).toBe(true);
        expect(processCommandLine(pid!)).toContain("node");
        expect(processEnvironment(pid!)).toContain(
          `DIGITAL_PRODUCT_DATA=${site.productDataRoot}`,
        );
        // 停止前只在本进程内读取本世代启动配置，用来事后核对日志不泄露秘密。
        const launchFile = path.join(
          path.dirname(readRecord(site).run.productLogFile!),
          "launch.json",
        );
        const launch = JSON.parse(readFileSync(launchFile, "utf8")) as {
          controlKey: string;
          readyKey: string;
        };
        live.push({
          site,
          pid: pid!,
          secrets: [launch.controlKey, launch.readyKey],
        });
      }
      expect(live.length).toBeGreaterThanOrEqual(2);

      for (const { site, pid, secrets } of live) {
        const stopped = await cliAt(site.workspacePath, [
          "stop",
          "--environment",
          site.environment,
        ]);
        expect(stopped.code, stopped.stderr).toBe(0);
        const data = unwrap<StopOperationResult>(stopped.stdout);
        expect(data.status).toBe("stopped");
        expect(await waitPortClosed(site.port)).toBe(true);
        expect(processAlive(pid)).toBe(false);
        const productLogFile = data.run.productLogFile;
        expect(productLogFile).not.toBeNull();
        const productLog = await readFile(productLogFile!, "utf8");
        expect(productLog.length).toBeGreaterThan(0);
        expect(secrets.some((secret) => productLog.includes(secret))).toBe(
          false,
        );
        const confirmed = await cliAt(site.workspacePath, [
          "inspect",
          "--environment",
          site.environment,
        ]);
        expect(confirmed.code, confirmed.stderr).toBe(0);
        const confirmedFacts = unwrap<InspectEnvironmentResult>(
          confirmed.stdout,
        );
        expect(confirmedFacts.run.processLiveness).toBe("exited");
        expect(confirmedFacts.serviceReadiness).not.toBe("ready");
      }
      // 本文件没有为并发新开任何控制通道：每一次公开 start 都有公开接口的结果。
      expect(startAttempts.length).toBeGreaterThan(0);
      expect(
        startAttempts.every((attempt) => attempt.status !== undefined),
      ).toBe(true);
    },
    realRunTimeout,
  );
});
