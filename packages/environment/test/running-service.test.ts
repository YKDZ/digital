import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  readdir,
  realpath,
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

import { createPublicApiClient } from "@digital/public-api";
import { loadControlledSourceIo } from "@digital/test-support/source-io";
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
import {
  observeProcessIdentity,
  observeProcessLifecycle,
} from "../src/internal/process-identity.ts";
import {
  createLibraryAndScan,
  startCompetingProductService,
  workflowHistoryIds as readWorkflowHistoryIds,
} from "./product-service.ts";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const environmentCli = path.join("packages", "environment", "dist", "cli.js");
const fixtureMaterialDirectory = await realpath(
  fileURLToPath(
    import.meta.resolve("@digital/preview-corpus/audio-posts/material"),
  ),
);
const fixtureManifestPath = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/manifest.json"),
);
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
      service: "digital-product-service",
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

async function directoryDigest(directory: string): Promise<string> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  await visit(directory);
  const digest = createHash("sha256");
  for (const file of files.toSorted()) {
    digest.update(path.relative(directory, file).split(path.sep).join("/"));
    digest.update("\0");
    digest.update(await readFile(file));
  }
  return digest.digest("hex");
}

async function readOperationLog(result: StartOperationResult): Promise<string> {
  return (
    await Promise.all(
      result.logs.files.map((file) => readFile(file, "utf8").catch(() => "")),
    )
  ).join("\n");
}

async function recordLibraryScan(
  environment: string,
  label: string,
): Promise<{
  readonly libraryId: string;
  readonly executionId: string;
  readonly outcome: string | undefined;
}> {
  const material = await temporaryDirectory("digital-02-material-");
  return await createLibraryAndScan({
    workspacePath: workspaceRoot,
    environment,
    displayName: label,
    directory: material,
  });
}

async function workflowHistoryIds(environment: string): Promise<string[]> {
  return await readWorkflowHistoryIds({
    workspacePath: workspaceRoot,
    environment,
  });
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
  businessExecutionId = (await recordLibraryScan(env.name, "真实服务"))
    .executionId;
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

describe("正式产品服务的独立启动、查看与停止", () => {
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
        service: "digital-product-service",
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
    "运行记录属于其他 PID 命名空间时只报告未知",
    async () => {
      const initial = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      let startedHere = false;
      if (initial.serviceReadiness !== "ready") {
        const started = await startRegistered(
          "其他 PID 命名空间观察 start",
          env.name,
        );
        expect(started.status).toBe("ready");
        startedHere = true;
      }

      const original = await readFile(env.recordPath, "utf8");
      const record = JSON.parse(original) as {
        run: { processIdentity: { pidNamespace: string } };
      };
      const currentNamespace = record.run.processIdentity.pidNamespace;
      // 这是受控的分类输入；它不启动或模拟另一个 PID 命名空间中的真实进程。
      record.run.processIdentity.pidNamespace =
        currentNamespace === "pid:[1]" ? "pid:[2]" : "pid:[1]";
      try {
        await writeFile(env.recordPath, `${JSON.stringify(record, null, 2)}\n`);
        const observed = await inspectEnvironment({
          workspacePath: workspaceRoot,
          environment: env.name,
        });
        expect(observed.run.processLiveness).toBe("unknown");
        expect(observed.serviceReadiness).toBe("unknown");
        expect(await portOpen(env.port)).toBe(true);
      } finally {
        await writeFile(env.recordPath, original);
      }

      const restored = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(restored.run.processLiveness).toBe("alive");
      expect(restored.serviceReadiness).toBe("ready");
      if (startedHere) {
        const stopped = await stopEnvironment({
          workspacePath: workspaceRoot,
          environment: env.name,
        });
        expect(stopped.status).toBe("stopped");
      }
    },
    realRunTimeout,
  );

  it("原生进程身份能区分真实子进程存活与退出", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    let childClosed = false;
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        childClosed = true;
        resolve();
      });
    });
    try {
      if (child.pid === undefined) throw new Error("测试子进程没有 PID");
      const observed = observeProcessIdentity(child.pid);
      if (!("identity" in observed)) throw new Error(observed.reason);
      expect(observeProcessLifecycle(observed.identity)).toBe("alive");
      child.kill("SIGTERM");
      await closed;
      expect(observeProcessLifecycle(observed.identity)).toBe("exited");
    } finally {
      if (!childClosed) {
        child.kill("SIGTERM");
        await closed;
      }
    }
  });

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
      const initial = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      if (initial.serviceReadiness !== "ready") {
        const preparedRun = await startRegistered(
          "停止语义用例准备服务世代",
          env.name,
        );
        expect(preparedRun.status).toBe("ready");
      }
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
      expect(await workflowHistoryIds(env.name)).toContain(businessExecutionId);

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
      const whileLive = await startCompetingProductService(env.productDataRoot);
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
      expect(await workflowHistoryIds(env.name)).toContain(businessExecutionId);
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
      expect(await workflowHistoryIds(env.name)).toContain(businessExecutionId);
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

  it("正式 enter 首次准备后重入沿用保存配置且不追加刷新", async () => {
    const name = `t05-${randomUUID().slice(0, 8)}`;
    const containerDirectory = path.join(
      workspaceRoot,
      ".digital",
      "environments",
      name,
    );
    createdContainers.push(containerDirectory);
    const port = await freePort();
    const controlledSource = await loadControlledSourceIo({
      manifestPath: fixtureManifestPath,
    });
    const config = {
      profile: "t05-entry",
      webPort: port,
      sourceIo: {
        manifestPath: fixtureManifestPath,
        contentIdentity: controlledSource.contentIdentity,
      },
    };
    const originalMaterialDigest = await directoryDigest(
      fixtureMaterialDirectory,
    );
    const enter = async (
      label: string,
      args: readonly string[],
    ): Promise<{
      readonly result: CommandResult;
      readonly elapsedMs: number;
      readonly data: {
        readonly environment: {
          readonly productDataRoot: string;
          readonly sourceMode: string;
          readonly inputs: readonly string[];
          readonly config: Readonly<Record<string, unknown>>;
        };
        readonly run: {
          readonly runId: string | null;
          readonly address: string | null;
        };
        readonly inspection: { readonly elapsedMs: number };
        readonly preparation: {
          readonly status: string;
          readonly elapsedMs: number;
        };
        readonly service: {
          readonly status: string;
          readonly elapsedMs: number;
        };
        readonly business: {
          readonly status: string;
          readonly explanation: string;
        };
      };
    }> => {
      const attempt = beginStart(label, name);
      try {
        const startedAt = performance.now();
        const result = await cli(["enter", "--environment", name, ...args]);
        const elapsedMs = Math.max(
          0,
          Math.round(performance.now() - startedAt),
        );
        attempt.status = `CLI 退出 ${String(result.code)}`;
        const rawOutput = result.stdout.trim() || result.stderr.trim();
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawOutput) as unknown;
        } catch (error) {
          throw new Error(
            `enter 未返回 JSON（退出 ${String(result.code)}）：${result.stderr || result.stdout}`,
            { cause: error },
          );
        }
        if (result.code !== 0) {
          const failure = parsed as {
            readonly data?: {
              readonly logs?: {
                readonly prepare?: { readonly files?: readonly string[] };
              };
            };
          };
          const readLogs = await Promise.all(
            (failure.data?.logs?.prepare?.files ?? [])
              .filter((file) => file.endsWith("/read.log"))
              .map(async (file) => ({
                file,
                content: await readFile(file, "utf8").catch((error: unknown) =>
                  String(error),
                ),
              })),
          );
          throw new Error(
            `enter 失败，退出 ${String(result.code)}：${JSON.stringify(parsed)}\n正式读取日志：${JSON.stringify(readLogs)}`,
          );
        }
        const envelope = parsed as {
          readonly data: {
            readonly environment: {
              readonly productDataRoot: string;
              readonly sourceMode: string;
              readonly inputs: readonly string[];
              readonly config: Readonly<Record<string, unknown>>;
            };
            readonly run: {
              readonly runId: string | null;
              readonly address: string | null;
            };
            readonly inspection: { readonly elapsedMs: number };
            readonly preparation: {
              readonly status: string;
              readonly elapsedMs: number;
            };
            readonly service: {
              readonly status: string;
              readonly elapsedMs: number;
            };
            readonly business: {
              readonly status: string;
              readonly explanation: string;
            };
          };
        };
        attempt.runId = envelope.data.run.runId;
        return { result, elapsedMs, data: envelope.data };
      } catch (error) {
        attempt.status = `调用失败：${describeFailure(error)}`;
        throw error;
      }
    };

    const first = await enter("正式 enter 首次准备", [
      "--source-mode",
      "controlled",
      "--input",
      fixtureMaterialDirectory,
      "--workspace-path",
      workspaceRoot,
      "--config-json",
      JSON.stringify(config),
      "--timeout-ms",
      String(realRunTimeout),
    ]);
    expect(first.result.code, first.result.stderr).toBe(0);
    expect(first.data.preparation.status).toBe("prepared");
    expect(first.data.preparation.elapsedMs).toBeGreaterThan(0);
    expect(first.data.service.status).toBe("ready");
    expect(first.data.service.elapsedMs).toBeGreaterThan(0);
    expect(first.data.run.address).toBe(`http://127.0.0.1:${String(port)}`);
    expect(first.data.business.status).toBe("not-requested");
    expect(first.data.business.explanation).toContain(
      "没有发起资料接入或全库刷新",
    );
    expect(first.data.environment.sourceMode).toBe("controlled");
    expect(first.data.environment.inputs).toEqual([fixtureMaterialDirectory]);
    expect(first.data.environment.config).toEqual(config);
    const baseUrl = first.data.run.address;
    if (baseUrl === null) throw new Error("enter 未返回服务地址");
    const client = createPublicApiClient({ baseUrl });
    const firstInspection = await inspectEnvironment({
      workspacePath: workspaceRoot,
      environment: name,
    });
    expect(firstInspection.state).toBe("prepared");
    expect(firstInspection.environment.sourceMode).toBe("controlled");
    expect(firstInspection.environment.inputs).toEqual([
      fixtureMaterialDirectory,
    ]);
    expect(firstInspection.environment.productDataRoot).toBe(
      first.data.environment.productDataRoot,
    );
    expect(firstInspection.environment.config).toEqual(config);
    expect(firstInspection.serviceReadiness).toBe("ready");

    const alreadyReady = await enter("正式 enter 重入已就绪世代", [
      "--workspace-path",
      workspaceRoot,
      "--timeout-ms",
      String(realRunTimeout),
    ]);
    expect(alreadyReady.result.code, alreadyReady.result.stderr).toBe(0);
    expect(alreadyReady.data.preparation.status).toBe("reused");
    expect(alreadyReady.data.service.status).toBe("already-ready");
    expect(alreadyReady.data.run.runId).toBe(first.data.run.runId);

    const firstDirectory = await temporaryDirectory(
      "digital-05-material-first-",
    );
    await cp(fixtureMaterialDirectory, firstDirectory, { recursive: true });
    await writeFile(path.join(firstDirectory, "ordinary.txt"), "普通材料\n");
    const additionalDirectory = await temporaryDirectory(
      "digital-05-material-additional-",
    );
    await writeFile(
      path.join(additionalDirectory, "additional.txt"),
      "另一份普通材料\n",
    );
    const secondLibraryDirectory = await temporaryDirectory(
      "digital-05-material-second-library-",
    );
    await writeFile(
      path.join(secondLibraryDirectory, "second-library.txt"),
      "第二资料库材料\n",
    );
    const saveLibrary = async (input: {
      readonly displayName: string;
      readonly directories: readonly string[];
    }): Promise<{ readonly id: string; readonly configVersion: number }> => {
      const saved = await client.saveAssetLibrary({
        displayName: input.displayName,
        directories: [...input.directories],
        recognitionProfileIds: ["dlsite-voice"],
        sourceIdentities: ["dlsite"],
      });
      return { id: saved.id, configVersion: saved.configVersion };
    };
    const primaryLibrary = await saveLibrary({
      displayName: "正式进入保留甲",
      directories: [firstDirectory, additionalDirectory],
    });
    const secondLibrary = await saveLibrary({
      displayName: "正式进入保留乙",
      directories: [secondLibraryDirectory],
    });
    expect(primaryLibrary.id).not.toBe(secondLibrary.id);

    const explicitRefresh = async (
      assetLibraryId: string,
    ): Promise<{ readonly id: string; readonly elapsedMs: number }> => {
      const startedAt = performance.now();
      const { parentExecutionId } =
        await client.startAssetLibraryScan(assetLibraryId);
      await expect
        .poll(
          async () => {
            const execution =
              await client.inspectAssetLibraryScan(parentExecutionId);
            return execution.status;
          },
          { timeout: 180_000 },
        )
        .toBe("completed");
      return {
        id: parentExecutionId,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    };
    const firstRefresh = await explicitRefresh(primaryLibrary.id);
    const secondRefresh = await explicitRefresh(secondLibrary.id);

    const manualName = "已人工改名的资料库";
    const renamedLibrary = await client.saveAssetLibrary({
      id: primaryLibrary.id,
      expectedVersion: primaryLibrary.configVersion,
      displayName: manualName,
      directories: [firstDirectory, additionalDirectory],
      recognitionProfileIds: ["dlsite-voice"],
      sourceIdentities: ["dlsite"],
    });
    expect(renamedLibrary.configVersion).toBeGreaterThan(
      primaryLibrary.configVersion,
    );

    const syntheticClientSecret = "t05-synthetic-bangumi-client-secret";
    const configuredSource = await client.configureBangumiOAuthClient({
      clientId: "t05-synthetic-bangumi-client",
      clientSecret: syntheticClientSecret,
      redirectUri:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    });
    expect(configuredSource.configured).toBe(true);
    expect(JSON.stringify(configuredSource)).not.toContain(
      syntheticClientSecret,
    );
    const publicSourceConnectionFacts = async () => {
      const connections = await client.listSourceConnections();
      return connections.items.map(
        ({ id, version, credentialStatus, availability, reason }) => ({
          id,
          version,
          credentialStatus,
          availability,
          ...(reason === undefined ? {} : { reason }),
        }),
      );
    };
    const sourcesBeforeReentry = await publicSourceConnectionFacts();
    expect(
      sourcesBeforeReentry.find(({ id }) => id === "bangumi"),
    ).toMatchObject({
      credentialStatus: "revoked",
      availability: "unavailable",
      reason: "revoked",
    });

    const librariesBeforeReentry = await client.listAssetLibraries({
      limit: 100,
    });
    expect(librariesBeforeReentry.items).toHaveLength(2);
    const primaryLibraryBeforeReentry = librariesBeforeReentry.items.find(
      ({ id }) => id === primaryLibrary.id,
    );
    expect(primaryLibraryBeforeReentry).toMatchObject({
      displayName: manualName,
    });
    expect(primaryLibraryBeforeReentry?.directories).toHaveLength(2);
    const assetsBeforeReentry = await client.listAssets({
      assetLibraryId: primaryLibrary.id,
      limit: 100,
    });
    expect(assetsBeforeReentry.items.length).toBeGreaterThan(0);
    const unrecognizedBeforeReentry = await client.listUnrecognizedMaterials({
      assetLibraryId: primaryLibrary.id,
      limit: 100,
    });
    expect(
      unrecognizedBeforeReentry.items.flatMap(
        ({ relativePaths }) => relativePaths,
      ),
    ).toContain("ordinary.txt");

    const stopped = await stopEnvironment({
      workspacePath: workspaceRoot,
      environment: name,
    });
    expect(stopped.status).toBe("stopped");
    const workflowsBeforeReentry = await workflowHistoryIds(name);
    expect(workflowsBeforeReentry.length).toBeGreaterThan(0);

    const reentered = await enter("正式 enter 保存配置重入", [
      "--workspace-path",
      workspaceRoot,
      "--timeout-ms",
      String(realRunTimeout),
    ]);
    expect(reentered.result.code, reentered.result.stderr).toBe(0);
    expect(reentered.data.preparation.status).toBe("reused");
    expect(reentered.data.preparation.elapsedMs).toBe(0);
    expect(reentered.data.service.status).toBe("ready");
    expect(reentered.data.run.runId).not.toBe(first.data.run.runId);
    expect(reentered.data.environment.productDataRoot).toBe(
      firstInspection.environment.productDataRoot,
    );
    expect(reentered.data.environment.sourceMode).toBe("controlled");
    expect(reentered.data.environment.inputs).toEqual([
      fixtureMaterialDirectory,
    ]);
    expect(reentered.data.environment.config).toEqual(config);
    const retainedLibraries = await client.listAssetLibraries({ limit: 100 });
    expect(retainedLibraries.items).toEqual(librariesBeforeReentry.items);
    const retainedAssets = await client.listAssets({
      assetLibraryId: primaryLibrary.id,
      limit: 100,
    });
    expect(retainedAssets.items).toEqual(assetsBeforeReentry.items);
    const retainedUnrecognized = await client.listUnrecognizedMaterials({
      assetLibraryId: primaryLibrary.id,
      limit: 100,
    });
    expect(retainedUnrecognized.items).toEqual(unrecognizedBeforeReentry.items);
    const retainedSources = await publicSourceConnectionFacts();
    expect(retainedSources).toEqual(sourcesBeforeReentry);
    const authorization = await client.beginBangumiAuthorization();
    const authorizationUrl = new URL(authorization.authorizationUrl);
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "t05-synthetic-bangumi-client",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://digital.example.test/api/source-connections/bangumi/callback",
    );
    expect(authorizationUrl.toString()).not.toContain(syntheticClientSecret);
    expect(await directoryDigest(fixtureMaterialDirectory)).toBe(
      originalMaterialDigest,
    );

    const stoppedAgain = await stopEnvironment({
      workspacePath: workspaceRoot,
      environment: name,
    });
    expect(stoppedAgain.status).toBe("stopped");
    await expect(workflowHistoryIds(name)).resolves.toEqual(
      workflowsBeforeReentry,
    );
    console.info(
      `EWC-05_ACCEPTANCE_TIMING ${JSON.stringify({
        conditions: {
          node: process.version,
          sourceMode: "controlled",
          productService: "apps/service via environment enter",
          filesystem: "temporary ordinary-directory copies",
        },
        firstEnter: {
          wallMs: first.elapsedMs,
          inspectMs: first.data.inspection.elapsedMs,
          prepareMs: first.data.preparation.elapsedMs,
          serviceReadyMs: first.data.service.elapsedMs,
        },
        alreadyReadyReentry: {
          wallMs: alreadyReady.elapsedMs,
          preparationMs: alreadyReady.data.preparation.elapsedMs,
          serviceMs: alreadyReady.data.service.elapsedMs,
        },
        stoppedReentry: {
          wallMs: reentered.elapsedMs,
          inspectMs: reentered.data.inspection.elapsedMs,
          preparationMs: reentered.data.preparation.elapsedMs,
          serviceReadyMs: reentered.data.service.elapsedMs,
        },
        explicitRefreshes: [firstRefresh, secondRefresh],
        sourceMaterialDigest: originalMaterialDigest,
      })}`,
    );
  }, 1_200_000);

  it(
    "正式 enter 启动失败时报告具体阶段且不接管占用端口",
    async () => {
      const occupier = await startImpostor(env.port);
      const before = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      const attempt = beginStart("正式 enter 端口冲突", env.name);
      try {
        const result = await cli([
          "enter",
          "--environment",
          env.name,
          "--workspace-path",
          workspaceRoot,
          "--timeout-ms",
          String(realRunTimeout),
        ]);
        attempt.status = `CLI 退出 ${String(result.code)}`;
        const envelope = JSON.parse(
          result.stdout.trim() || result.stderr.trim(),
        ) as {
          readonly data: {
            readonly status: string;
            readonly phase: string;
            readonly service: { readonly status: string };
            readonly failure: {
              readonly stage: string;
              readonly message: string;
            };
            readonly cleanup: { readonly state: string };
            readonly logs: {
              readonly service: { readonly directory: string | null };
            };
          };
        };
        expect(result.code).toBe(1);
        expect(envelope.data.status).toBe("failed");
        expect(envelope.data.phase).toBe("start");
        expect(envelope.data.service.status).toBe("failed");
        expect(envelope.data.failure.stage).toBe("port");
        expect(envelope.data.failure.message).toContain("不接管");
        expect(envelope.data.cleanup.state).toBe("not-started");
        expect(envelope.data.logs.service.directory).toBeNull();
        expect(occupier.requests()).toBe(0);
      } finally {
        await occupier.close();
      }

      const after = await inspectEnvironment({
        workspacePath: workspaceRoot,
        environment: env.name,
      });
      expect(after.run.runId).toBe(before.run.runId);
      expect(after.run.processLiveness).toBe(before.run.processLiveness);
      expect(after.serviceReadiness).toBe(before.serviceReadiness);
    },
    realRunTimeout,
  );
});
