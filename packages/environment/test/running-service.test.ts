import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
  type StartOperationResult,
  type StopOperationResult,
} from "../src/index.ts";
import { recordFileName } from "../src/internal/paths.ts";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const environmentCli = path.join("packages", "environment", "dist", "cli.js");
const productCli = path.join("apps", "cli", "dist", "cli.js");
/** 合成残留值：只用于证明父终端配置不会进入本世代。 */
const parentCredential = "parent-credential-6a19";
const parentProxy = "http://proxy.invalid:8080";
const pollutedVariables = [
  "DIGITAL_TMDB_ACCESS_TOKEN",
  "DIGITAL_PRODUCT_DATA",
  "PORT",
  "NODE_OPTIONS",
  "HTTPS_PROXY",
] as const;
/** 真实准备、启动与就绪等待都要跑完整产品链路。 */
const realRunTimeout = 420_000;

type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type ClosableServer = {
  requests(): number;
  close(): Promise<void>;
};

const createdContainers: string[] = [];
const temporaryDirectories: string[] = [];
const openServers: ClosableServer[] = [];

let env!: {
  readonly name: string;
  readonly port: number;
  readonly productDataRoot: string;
  readonly containerDirectory: string;
  readonly recordPath: string;
};
let businessExecutionId = "";

/**
 * 本文件发出的每一发 start 都必须在请求离开之前登记：后续结果、抛错或断言失败
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
  result: {
    readonly status: string;
    readonly run: { readonly runId: string | null };
  },
): void {
  attempt.status = result.status;
  attempt.runId = result.run.runId;
}

async function startRegistered(
  label: string,
  environment: string,
): Promise<StartOperationResult> {
  const attempt = beginStart(label, environment);
  try {
    const result = await startEnvironment({
      workspacePath: workspaceRoot,
      environment,
    });
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
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

/** 独立 CLI 进程：与测试进程内的公开接口调用完全分离。 */
async function cli(args: readonly string[]): Promise<CommandResult> {
  return await run({
    command: process.execPath,
    args: [environmentCli, ...args],
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** 空闲端口只用于挑选本轮自有的端口号，探测完立即释放。 */
async function freePort(): Promise<number> {
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
  return port;
}

/** 冒用服务：首页与 `/api/ready` 的形状完全相同，但世代与签名都不属于本环境。 */
async function startImpostor(port: number): Promise<ClosableServer> {
  let requests = 0;
  const server = createServer((_incoming, outgoing) => {
    requests += 1;
    const body = JSON.stringify({
      ok: true,
      service: "digital-web",
      runId: "冒用世代-not-ours",
      attestation: "0".repeat(64),
    });
    outgoing.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });
    outgoing.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1" }, resolve);
  });
  const handle: ClosableServer = {
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  openServers.push(handle);
  return handle;
}

async function httpRequest(input: {
  readonly port: number;
  readonly pathname: string;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<{ readonly status: number; readonly body: string }> {
  return await new Promise((resolve, reject) => {
    const handle = request(
      {
        host: "127.0.0.1",
        port: input.port,
        path: input.pathname,
        method: "GET",
        agent: false,
        headers: input.headers ?? {},
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
    handle.end();
  });
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readOperationLog(result: StartOperationResult): Promise<string> {
  return (
    await Promise.all(
      result.logs.files.map((file) => readFile(file, "utf8").catch(() => "")),
    )
  ).join("\n");
}

async function recordLibraryScan(
  productDataRoot: string,
  label: string,
): Promise<string> {
  const material = await temporaryDirectory("digital-02-material-");
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
    env: { ...cleanEnvironment(), DIGITAL_PRODUCT_DATA: productDataRoot },
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
    env: { ...cleanEnvironment(), DIGITAL_PRODUCT_DATA: productDataRoot },
  });
  expect(scan.code, scan.stderr).toBe(0);
  const recorded = JSON.parse(scan.stdout) as {
    directories: { childExecutionId: string }[];
  };
  return recorded.directories[0]!.childExecutionId;
}

async function workflowHistoryIds(productDataRoot: string): Promise<string[]> {
  const read = await run({
    command: process.execPath,
    args: [
      path.join(workspaceRoot, productCli),
      "catalogue-surface",
      "--surface",
      "workflow-history",
    ],
    env: { ...cleanEnvironment(), DIGITAL_PRODUCT_DATA: productDataRoot },
  });
  expect(read.code, read.stderr).toBe(0);
  const page = JSON.parse(read.stdout) as {
    items: { execution: { id: string } }[];
  };
  return page.items.map((item) => item.execution.id);
}

function inspectData(stdout: string): {
  serviceReadiness: string;
  run: { runId: string | null; pid: number | null; state: string };
} {
  return (
    JSON.parse(stdout) as {
      data: {
        serviceReadiness: string;
        run: { runId: string | null; pid: number | null; state: string };
      };
    }
  ).data;
}

beforeAll(async () => {
  const port = await freePort();
  const name = `t02-${randomUUID().slice(0, 8)}`;
  const containerDirectory = path.join(
    workspaceRoot,
    ".digital",
    "environments",
    name,
  );
  createdContainers.push(containerDirectory);
  const prepared = await prepareEnvironment({
    workspacePath: workspaceRoot,
    environment: name,
    config: { profile: "running-service", webPort: port },
  });
  const preparationDiagnostic =
    prepared.status === "prepared"
      ? ""
      : JSON.stringify({
          preparation: prepared,
          ownerLogs: await Promise.all(
            prepared.logs.files.map(async (file) => ({
              file,
              content: await readFile(file, "utf8").catch((error: unknown) =>
                String(error),
              ),
            })),
          ),
        });
  expect(prepared.status, preparationDiagnostic).toBe("prepared");
  env = {
    name,
    port,
    productDataRoot: prepared.environment.productDataRoot,
    containerDirectory,
    recordPath: path.join(containerDirectory, recordFileName),
  };
  businessExecutionId = await recordLibraryScan(
    env.productDataRoot,
    "真实服务",
  );
}, realRunTimeout);

afterAll(async () => {
  for (const server of openServers) await server.close().catch(() => undefined);
  const issued = startAttempts.map(
    (attempt) =>
      `${attempt.label}：环境 ${attempt.environment} 于 ${attempt.issuedAt} 发出，结果 ${
        attempt.status ?? "未提交"
      }，世代 ${attempt.runId ?? "无"}`,
  );
  const retained: string[] = [];
  const stopped: string[] = [];
  for (const environment of new Set(startAttempts.map((a) => a.environment))) {
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
      `${environment}：${stop.status} / 记录 ${stop.run.state}（结束事实 ${stop.run.endedAt ?? "无"}）/ 独立查看进程 ${confirmed.run.processLiveness} / 就绪 ${confirmed.serviceReadiness} / 收尾 ${stop.cleanup.state} / 运行日志 ${stop.run.productLogFile ?? "无"}`,
    );
    if (!confirmedClosed)
      retained.push(
        `${environment}：公开停止返回 ${stop.status}，独立查看显示进程 ${confirmed.run.processLiveness}、就绪 ${confirmed.serviceReadiness}，按未知保留记录、启动配置、产品数据与日志（运行日志 ${stop.run.productLogFile ?? "无"}），请再次对同一环境发出公开停止：stop --environment ${environment}`,
      );
  }
  // 现场账本先落到门禁输出，之后才允许回收本轮自有资源。
  console.log(
    `[running-service 现场账本]\n发出的 start：\n${
      issued.length === 0 ? "无" : issued.join("\n")
    }\n公开停止：\n${stopped.join("\n") || "无"}\n保留待收尾：\n${
      retained.length === 0 ? "无" : retained.join("\n")
    }`,
  );
  if (retained.length > 0)
    throw new Error(
      `本世代未按公开停止确认真实退出，保留现场：\n${retained.join("\n")}`,
    );
  // 已确认真实退出的世代才回收可丢弃现场；私有运行日志目录按产品停止的原语义保留，
  // 它只是已关闭的诊断文件，不是仍持有的后台资源。
  for (const container of createdContainers)
    await rm(container, { recursive: true, force: true });
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
}, realRunTimeout);

describe("真实产品 Web 服务的独立启动、查看与停止", () => {
  it(
    "公开接口只在本世代认证成立后报告就绪，独立 CLI 进程随后仍能管理同一世代",
    async () => {
      process.env.DIGITAL_TMDB_ACCESS_TOKEN = parentCredential;
      process.env.DIGITAL_PRODUCT_DATA = await temporaryDirectory(
        "digital-02-parent-root-",
      );
      process.env.PORT = String(await freePort());
      process.env.NODE_OPTIONS = "--require /etc/hostname";
      process.env.HTTPS_PROXY = parentProxy;
      let start: StartOperationResult;
      try {
        start = await startRegistered("公开接口首次 start", env.name);
      } finally {
        for (const name of pollutedVariables) delete process.env[name];
      }

      expect(start.status).toBe("ready");
      expect(start.run.state).toBe("ready");
      expect(start.run.runId).not.toBeNull();
      expect(start.run.address).toBe(`http://127.0.0.1:${String(env.port)}`);
      expect(start.run.serviceReady).toBe(true);
      expect(start.run.controlReachable).toBe(true);
      expect(start.run.processLiveness).toBe("alive");
      // 就绪即世代继续由产品自己持有：本次操作只释放自己的句柄。
      expect(start.cleanup.state).toBe("released");
      expect(start.logs.directory).not.toBeNull();
      expect(start.logs.files.length).toBeGreaterThan(0);

      // 就绪事实指向本世代自有的私有现场：目录 0700，日志 0600。
      const productLogFile = start.run.productLogFile;
      expect(productLogFile).not.toBeNull();
      const privateDirectory = path.dirname(productLogFile!);
      expect(
        privateDirectory.startsWith(
          path.join(tmpdir(), "digital-environments"),
        ),
      ).toBe(true);
      expect((lstatSync(privateDirectory).mode & 0o777) === 0o700).toBe(true);
      expect((lstatSync(productLogFile!).mode & 0o777) === 0o600).toBe(true);
      expect(await portOpen(env.port)).toBe(true);

      // 公开 HTTP：没有本次 nonce 时与独立运行的产品形状完全一致。
      const plain = await httpRequest({
        port: env.port,
        pathname: "/api/ready",
      });
      expect(plain.status).toBe(200);
      expect(JSON.parse(plain.body)).toEqual({
        ok: true,
        service: "digital-web",
      });

      // 带上 nonce 才交出本世代签名；换一个 nonce 就必须换一个签名。
      const first = await httpRequest({
        port: env.port,
        pathname: "/api/ready",
        headers: {
          "digital-environment-nonce": randomUUID().replace(/-/g, ""),
        },
      });
      const second = await httpRequest({
        port: env.port,
        pathname: "/api/ready",
        headers: {
          "digital-environment-nonce": randomUUID().replace(/-/g, ""),
        },
      });
      expect(first.status).toBe(200);
      const firstBody = JSON.parse(first.body) as {
        runId: string;
        attestation: string;
      };
      const secondBody = JSON.parse(second.body) as { attestation: string };
      expect(firstBody.runId).toBe(start.run.runId);
      expect(/^[a-f0-9]{64}$/u.test(firstBody.attestation)).toBe(true);
      expect(secondBody.attestation).not.toBe(firstBody.attestation);

      // 首页可访问只说明 HTTP 层活着，就绪结论仍来自上面的认证。
      expect(
        (await httpRequest({ port: env.port, pathname: "/" })).status,
      ).toBeGreaterThan(0);

      // 后续独立 CLI 调用既不需要人工保存 PID，也不复用原调用进程。
      const inspected = await cli(["inspect", "--environment", env.name]);
      expect(inspected.code, inspected.stderr).toBe(0);
      const inspectedRun = inspectData(inspected.stdout);
      expect(inspectedRun.serviceReadiness).toBe("ready");
      expect(inspectedRun.run.runId).toBe(start.run.runId);
      expect(inspectedRun.run.pid).toBe(start.run.pid);

      const repeatedAttempt = beginStart("独立 CLI 重复 start", env.name);
      const repeated = await cli(["start", "--environment", env.name]);
      expect(repeated.code, repeated.stderr).toBe(0);
      const repeatedData = (
        JSON.parse(repeated.stdout) as {
          data: {
            status: string;
            run: {
              runId: string | null;
              pid: number | null;
              productLogFile: string | null;
            };
          };
        }
      ).data;
      observeStart(repeatedAttempt, repeatedData);
      expect(repeatedData.status).toBe("already-ready");
      expect(repeatedData.run.runId).toBe(start.run.runId);
      expect(repeatedData.run.pid).toBe(start.run.pid);

      // 本世代进程的环境只来自白名单与所选环境。
      const pid = start.run.pid;
      expect(pid).not.toBeNull();
      const childEnvironment = (
        await readFile(`/proc/${String(pid)}/environ`, "utf8")
      ).split("\0");
      expect(
        childEnvironment.includes(
          `DIGITAL_PRODUCT_DATA=${env.productDataRoot}`,
        ),
      ).toBe(true);
      expect(childEnvironment.includes(`PORT=${String(env.port)}`)).toBe(true);
      const joined = childEnvironment.join("\n");
      const carriesParentResidue =
        joined.includes(parentCredential) ||
        joined.includes("--require /etc/hostname") ||
        joined.includes(parentProxy);
      expect(carriesParentResidue).toBe(false);

      // 结果、CLI 输出与操作日志都不含启动配置里的秘密。
      const launchConfig = JSON.parse(
        await readFile(path.join(privateDirectory, "launch.json"), "utf8"),
      ) as { controlKey: string; readyKey: string };
      const texts = `${JSON.stringify(start)}${inspected.stdout}${await readOperationLog(start)}`;
      const leaksSecret = [launchConfig.controlKey, launchConfig.readyKey].some(
        (secret) => texts.includes(secret),
      );
      expect(leaksSecret).toBe(false);
    },
    realRunTimeout,
  );

  it(
    "进程存活、首页可访问与其他服务的相同响应都不被当成就绪",
    async () => {
      const before = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(before.serviceReadiness).toBe("ready");
      expect(before.run.processLiveness).toBe("alive");

      const impostorPort = await freePort();
      const impostor = await startImpostor(impostorPort);
      const original = await readFile(env.recordPath, "utf8");
      const record = JSON.parse(original) as {
        run: { address: string; port: number };
      };
      try {
        record.run.address = `http://127.0.0.1:${String(impostorPort)}`;
        record.run.port = impostorPort;
        await writeFile(env.recordPath, `${JSON.stringify(record, null, 2)}\n`);

        const fooled = await inspectEnvironment({
          workspacePath: workspaceRoot,
          environment: env.name,
        });
        expect(fooled.serviceReadiness).toBe("not-ready");
        // 拒绝就绪结论不等于猜测进程消失：真实进程仍然存活。
        expect(fooled.run.processLiveness).toBe("alive");
        expect(fooled.runProblem).toContain("世代不符");
        expect(impostor.requests()).toBeGreaterThan(0);

        const refused = await startRegistered("冒用世代拒绝 start", env.name);
        expect(refused.status).toBe("refused");
        expect(refused.failure?.stage).toBe("generation");
        expect(refused.cleanup.state).toBe("not-started");
      } finally {
        await writeFile(env.recordPath, original);
        await impostor.close();
      }

      const restored = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(restored.serviceReadiness).toBe("ready");
      expect(restored.run.runId).toBe(before.run.runId);
    },
    realRunTimeout,
  );

  it(
    "停止只收回自有外层资源，保留数据与日志；重复停止一致，确认退出后可换新世代",
    async () => {
      const started = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(started.serviceReadiness).toBe("ready");
      const productLogFile = started.run.productLogFile;
      expect(productLogFile).not.toBeNull();
      const privateDirectory = path.dirname(productLogFile!);

      const stopped = await cli(["stop", "--environment", env.name]);
      expect(stopped.code, stopped.stderr).toBe(0);
      const stoppedData = (
        JSON.parse(stopped.stdout) as {
          data: {
            status: string;
            run: { state: string; processLiveness: string };
            cleanup: { state: string };
          };
        }
      ).data;
      expect(stoppedData.status).toBe("stopped");
      expect(stoppedData.run.state).toBe("stopped");
      expect(stoppedData.run.processLiveness).toBe("exited");
      expect(stoppedData.cleanup.state).toBe("stopped");

      expect(await portOpen(env.port)).toBe(false);
      // 收回的只有本世代秘密与失联控制地址；运行日志留在原目录。
      expect(await exists(path.join(privateDirectory, "launch.json"))).toBe(
        false,
      );
      expect(await exists(path.join(privateDirectory, "control.sock"))).toBe(
        false,
      );
      expect(await exists(productLogFile!)).toBe(true);
      const productLog = await readFile(productLogFile!, "utf8");
      expect(productLog).toContain("已取得进入正式入口的许可");
      expect(productLog).toContain("运行日志收尾");
      // 产品数据一项不动：停止前后同一业务记录都可读取。
      expect(await workflowHistoryIds(env.productDataRoot)).toContain(
        businessExecutionId,
      );

      const again = await stopEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(again.status).toBe("already-stopped");
      expect(again.run.state).toBe("stopped");
      expect(again.cleanup.state).toBe("not-started");

      const restarted = await startRegistered("确认后新世代 start", env.name);
      expect(restarted.status).toBe("ready");
      expect(restarted.run.runId).not.toBe(started.run.runId);
      expect(restarted.run.serviceReady).toBe(true);

      // 新世代照样受产品自己的单写入者锁约束：外层启停没有绕过、代替或竞争它。
      const whileLive = await run({
        command: process.execPath,
        args: [
          path.join(workspaceRoot, productCli),
          "catalogue-surface",
          "--surface",
          "workflow-history",
        ],
        env: {
          ...cleanEnvironment(),
          DIGITAL_PRODUCT_DATA: env.productDataRoot,
        },
      });
      expect(whileLive.code).not.toBe(0);
      expect(`${whileLive.stdout}${whileLive.stderr}`).toContain(
        "拒绝并发启动另一个产品写入者",
      );

      const stoppedAgain = await stopEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(stoppedAgain.status).toBe("stopped");
      // 两个世代完整启停之后，同一业务记录仍可读取，产品数据一项不动。
      expect(await workflowHistoryIds(env.productDataRoot)).toContain(
        businessExecutionId,
      );
    },
    realRunTimeout,
  );

  it(
    "端口被他服务占据时明确失败：不换端口、不接管、不串用数据",
    async () => {
      const occupier = await startImpostor(env.port);
      const before = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      const failed = await startRegistered("端口占据失败 start", env.name);
      expect(failed.status).toBe("failed");
      expect(failed.failure?.stage).toBe("port");
      expect(failed.failure?.message).toContain("不接管");
      // 失败发生在写入启动意图与启动任何进程之前。
      expect(failed.cleanup.state).toBe("not-started");
      expect(failed.logs.directory).toBeNull();
      expect(occupier.requests()).toBe(0);
      expect(await portOpen(env.port)).toBe(true);
      await occupier.close();

      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(inspection.state).toBe("prepared");
      // 端口失败没有写下任何新运行分支：查看仍只报告上一个世代的退出事实。
      expect(inspection.run.runId).toBe(before.run.runId);
      expect(inspection.run.processLiveness).toBe("exited");
      expect(inspection.serviceReadiness).toBe("not-ready");
      expect(await workflowHistoryIds(env.productDataRoot)).toContain(
        businessExecutionId,
      );
    },
    realRunTimeout,
  );

  it(
    "无法确认退出时如实报告实际状态、不发信号，恢复现场后仍可再次停止",
    async () => {
      const start = await startRegistered("无法确认退出世代 start", env.name);
      expect(start.status).toBe("ready");
      const launchConfigFile = path.join(
        path.dirname(start.run.productLogFile!),
        "launch.json",
      );
      const hidden = `${launchConfigFile}.hidden`;
      try {
        await rename(launchConfigFile, hidden);
        const unconfirmed = await stopEnvironment({
          workspacePath: workspaceRoot,
          environment: env.name,
        });
        expect(unconfirmed.status).toBe("not-confirmed");
        expect(unconfirmed.failure?.stage).toBe("control");
        expect(unconfirmed.failure?.message).toContain("不发信号");
        // 私有现场无法核验就没有发出任何停止请求：本次操作没有启动也不需要回收。
        expect(unconfirmed.cleanup.state).toBe("not-started");
        expect(unconfirmed.logs.directory).toBeNull();
        expect(unconfirmed.run.processLiveness).toBe("alive");
        // 归属无法确认就不发信号：服务仍在提供本世代认证。
        expect(await portOpen(env.port)).toBe(true);
      } finally {
        await rename(hidden, launchConfigFile);
      }

      const confirmed = await stopEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(confirmed.status).toBe("stopped");
      expect(confirmed.run.processLiveness).toBe("exited");
    },
    realRunTimeout,
  );

  it(
    "普通启动失败回收本次自有的世代并保留完整诊断，不掩盖原始失败",
    async () => {
      // 真实外部条件：所选环境的产品数据库不是产品可用内容，就绪协议不会满足。
      await writeFile(
        path.join(env.productDataRoot, "catalogue.sqlite"),
        "这不是一个 SQLite 数据库",
      );
      const failed = await startRegistered("就绪失败世代 start", env.name);
      expect(failed.status).toBe("failed");
      expect(failed.failure?.stage).toBe("ready");
      expect(failed.failure?.message).toContain("没有确认本世代服务就绪");
      expect(failed.cleanup.state).toBe("stopped");
      expect(failed.run.state).toBe("stopped");
      // 启动结果只交出处置过的事实，不重复观察进程；退出确认由下一次独立查看给出。
      expect(failed.run.processLiveness).toBe("unknown");
      expect(await portOpen(env.port)).toBe(false);

      const inspection = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(inspection.run.lastFailure?.stage).toBe("ready");
      expect(inspection.run.processLiveness).toBe("exited");
      expect(inspection.serviceReadiness).toBe("not-ready");
      expect(await readOperationLog(failed)).toContain("启动失败");

      const stopped = await stopEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(stopped.status).toBe("already-stopped");
    },
    realRunTimeout,
  );
});
