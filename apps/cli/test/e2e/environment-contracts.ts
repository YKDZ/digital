/**
 * 本票的环境归属与负向证据套件：全部通过正式 CLI 生产入口与环境包的公开接口运行，
 * 不用替身代替产品，也不改动产品语义。逐项检查彼此独立，任一失败都不会掩盖其它检查。
 *
 * 覆盖：自有环境的成功回收、失败保留与可显式重启、必需产物用途缺位时的拒绝、
 * 提供中的环境在写入者被拒或被取消后仍由所有者持有、父终端遗留配置不会进入生产入口、
 * 信号中断只停止并保留自有环境、正式入口收到真实 SIGINT/SIGTERM 后的晚到收尾、
 * 运行器主失败保留的世代仍可公开重启、服务在运行时删除的实际分类、并行世代互不重叠。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  appendStartLedger,
  confirmOwnerExit,
  deleteScenarioEnvironment,
  fingerprintDifference,
  fingerprintEnvironment,
  openProvidedEnvironment,
  prepareScenarioEnvironment,
  journeyEvidenceDirectory,
  processStartTimeTicks,
  recycleOwnedEnvironment,
  reserveFreePort,
  scenarioEnvironmentName,
  scenarioRunId,
  startLedgerPath,
  startScenarioEnvironment,
  stopScenarioEnvironment,
} from "./environment-runtime.ts";
import type {
  CliJourney,
  CliJourneyCommand,
  CliJourneyMode,
  CliJourneyResult,
} from "./journey.ts";
import {
  ownedEnvironmentLifecycle,
  providedEnvironmentLifecycle,
  runJourney,
} from "./run-journeys.ts";

const e2eRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(e2eRoot, "..", "..");
const workspaceRoot = path.resolve(packageRoot, "..", "..");
const cliEntry = path.join(packageRoot, "dist", "cli.js");
const fixtureRoot = path.resolve(
  workspaceRoot,
  "fixtures",
  "controlled-source-io",
);
/** 所属证据根；正式子进程各自分配独立目录和交接台账。 */
const evidenceRoot = journeyEvidenceDirectory;

/** 本套件自己拥有的环境一律带 completion-02- 前缀，端口只取 53001—53999 内的空闲结果。 */
function nameFor(purpose: string): { runId: string; environment: string } {
  const runId = scenarioRunId();
  return {
    runId,
    environment: scenarioEnvironmentName({ purpose, runId }),
  };
}

type CommandOutput = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * 取消只以 SIGINT 转达给子进程：正式入口按自己的信号语义收尾，调用方不硬杀产品。
 * 子进程的退出结论原样返回，由检查判断它是否真的停下来了。
 */
function forwardCancellation(
  child: ChildProcess,
  signal: AbortSignal | undefined,
): void {
  if (signal === undefined) return;
  const abort = (): void => {
    child.kill("SIGINT");
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  child.once("close", () => {
    signal.removeEventListener("abort", abort);
  });
}

async function runCli(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env: { ...environment },
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
    forwardCancellation(child, signal);
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function runNode(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<CommandOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: workspaceRoot,
      env: { ...environment },
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
    forwardCancellation(child, signal);
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/** 自有世代的启动登记：先记意图（工作区/环境/端口），启动后再记结果（PID/启动时刻）。 */
async function ledgerIntent(input: {
  readonly runId: string;
  readonly environment: string;
  readonly port: number;
}): Promise<void> {
  await appendStartLedger(startLedgerPath, {
    phase: "intent",
    workspacePath: workspaceRoot,
    environment: input.environment,
    port: input.port,
    at: new Date().toISOString(),
    runId: input.runId,
  });
}

async function ledgerStartResult(input: {
  readonly runId: string;
  readonly environment: string;
  readonly port: number;
  readonly status: string;
  readonly pid: number | null;
}): Promise<void> {
  await appendStartLedger(startLedgerPath, {
    phase: "result",
    workspacePath: workspaceRoot,
    environment: input.environment,
    port: input.port,
    at: new Date().toISOString(),
    runId: input.runId,
    status: input.status,
    pid: input.pid,
    startTimeTicks:
      input.pid === null ? null : await processStartTimeTicks(input.pid),
  });
}

/**
 * 检查结束时对自己拥有的世代收尾：未收到取消时按公开操作停止后删除；一旦取消到达，
 * 只停止并保留现场，好让外部验收脚本还能核对被保留的数据与日志。
 */
async function finalizeOwnedEnvironment(
  environment: string,
  signal: AbortSignal,
): Promise<void> {
  const input = { workspacePath: workspaceRoot, environment };
  await stopScenarioEnvironment(input);
  if (signal.aborted) return;
  await deleteScenarioEnvironment(input);
}

/** 等到取消到达；超时即返回 false，由检查自己报告真实信号从未送达。 */
function waitForAbort(
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(false);
    }, timeoutMs);
    const abort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * 等到正式入口真正开始使用自己的世代：新容器出现且产品已经打开目录数据库。
 * 这样随后送去的 SIGINT 一定落在场景进行中，而不是入口还没拥有任何资源之前。
 */
async function waitForOwnedSceneInFlight(
  environmentsRoot: string,
  handoffLedger: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const entry of await childOwnedEnvironments(handoffLedger)) {
      const opened = await stat(
        path.join(environmentsRoot, entry, "product-data", "catalogue.sqlite"),
      ).then(
        () => true,
        () => false,
      );
      if (opened) return entry;
    }
    if (Date.now() >= deadline)
      throw new Error(
        "等待正式入口真正使用自有世代超时：容器或目录数据库没有出现",
      );
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
  }
}

/** 素材的逐字节指纹：并行世代只读观察作者夹具，任何改动都会在这里显形。 */
async function materialDigests(root: string): Promise<readonly string[]> {
  const snapshot = await captureRawFilesystemSnapshot(root, {
    contentDigests: true,
  });
  return snapshot.entries
    .filter((entry) => entry.relativePath !== ".")
    .map((entry) =>
      entry.kind === "directory"
        ? `${entry.relativePath}/`
        : `${entry.relativePath}:${entry.byteLength}:${entry.contentDigest ?? ""}`,
    )
    .toSorted();
}

type JsonObject = Record<string, unknown>;

function jsonObject(text: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `${label} 的 stdout 不是机器可读结果：${text.slice(0, 400)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${label} 的 stdout 不是 JSON 对象：${text.slice(0, 400)}`);
  return parsed as JsonObject;
}

function objectField(
  object: JsonObject,
  field: string,
): JsonObject | undefined {
  const value = object[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} 不是对象`);
  return value as JsonObject;
}

function arrayField(object: JsonObject, field: string): readonly JsonObject[] {
  const value = object[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 不是数组`);
  return value as readonly JsonObject[];
}

function stringField(object: JsonObject, field: string): string | undefined {
  const value = object[field];
  return typeof value === "string" ? value : undefined;
}

async function exists(target: string): Promise<boolean> {
  return await stat(target).then(
    () => true,
    () => false,
  );
}

async function walk(
  root: string,
  directory: string,
): Promise<readonly string[]> {
  const found: string[] = [];
  const entries = await readdir(path.join(root, directory), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(root, relative)));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

async function ordinaryCopy(workDir: string): Promise<string> {
  const target = path.join(workDir, "ordinary-library", "RJ01668691");
  await cp(path.join(fixtureRoot, "material", "RJ01668691"), target, {
    recursive: true,
  });
  return target;
}

async function scanRequiringCover(
  environment: Readonly<Record<string, string>>,
  workDir: string,
  rootId: string,
  signal?: AbortSignal,
): Promise<CommandOutput> {
  return await runCli(
    [
      "scan",
      rootId,
      "--scope",
      ".",
      "--require-artifact-role",
      "asset.primary-cover",
      "--json",
    ],
    environment,
    workDir,
    signal,
  );
}

/** 必需产物用途缺位时，正式入口必须交出可见拒绝，且不得留下封面修订或二进制。 */
async function assertCoverRequirementRefused(
  scanned: CommandOutput,
  label: string,
): Promise<void> {
  assert.equal(scanned.exitCode, 1, `${label} 的刷新必须非零退出`);
  assert.match(
    scanned.stderr,
    /^error: .+/mu,
    `${label} 必须由产品自己交出错误行：${scanned.stderr.slice(0, 300)}`,
  );
  const outcome = jsonObject(scanned.stdout, `${label} scan`);
  const execution = objectField(outcome, "execution");
  assert.equal(
    stringField(execution ?? {}, "outcome"),
    "partially-succeeded",
    `${label} 的执行结论应部分成功而非接受`,
  );
  for (const item of arrayField(outcome, "itemResults")) {
    const accepted = objectField(item, "accepted");
    if (accepted === undefined) continue;
    const roles = arrayField(accepted, "artifactAssociations").map(
      (association) => stringField(association, "role") ?? "",
    );
    assert.ok(
      !roles.includes("asset.primary-cover"),
      `${label} 不该在没有封面资料时交出 asset.primary-cover 关联`,
    );
    assert.equal(
      arrayField(accepted, "artifactRevisions").length,
      0,
      `${label} 不该交出任何产物修订`,
    );
    assert.equal(
      arrayField(accepted, "blobs").length,
      0,
      `${label} 不该落任何二进制`,
    );
  }
}

type Check = {
  readonly name: string;
  /**
   * 需要外部条件才可能真实执行的检查：条件不满足时按未执行报告，
   * 既不写成通过，也不冒充失败。返回 undefined 表示条件已满足。
   */
  readonly requires?: () => string | undefined;
  /** 取消上下文：真实信号到达后各检查只停止并保留自有现场，不再启动新资源。 */
  run(options: { readonly signal: AbortSignal }): Promise<readonly string[]>;
};

const checks: readonly Check[] = [
  {
    name: "owned-success-recycles-through-public-operations",
    async run({ signal }) {
      const { environment } = nameFor("owned-success");
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
      });
      const workDir = await mkdtemp(path.join(tmpdir(), "02-owned-success-"));
      try {
        const surface = await runCli(
          ["catalogue-surface", "--surface", "current-catalogue"],
          prepared.baseEnvironment,
          workDir,
          signal,
        );
        assert.equal(surface.exitCode, 0, `只读面应成功：${surface.stderr}`);
        const recycling = await recycleOwnedEnvironment({
          workspacePath: prepared.workspacePath,
          environment: prepared.environment,
          outcome: "success",
          signal,
        });
        assert.deepEqual(
          [...recycling.problems],
          [],
          `成功收尾不该留下问题：${recycling.problems.join("；")}`,
        );
        assert.ok(
          ["stopped", "already-stopped"].includes(recycling.stop?.status ?? ""),
        );
        assert.equal(recycling.exitConfirmation?.confirmed, true);
        assert.equal(
          recycling.deletion?.status,
          "deleted",
          `未收到取消的成功收尾必须删除：delete=${String(recycling.deletion?.status)} 取消已到达=${String(signal.aborted)}`,
        );
        assert.equal(
          await exists(
            path.join(workspaceRoot, ".digital", "environments", environment),
          ),
          false,
          "删除后容器目录不应存在",
        );
        const inspected = await fingerprintEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(
          inspected.state,
          "unprepared",
          "删除后应回到没有已准备世代的结论",
        );
        return [
          `stop=${recycling.stop?.status} 退出确认=${String(recycling.exitConfirmation?.confirmed)} ` +
            `delete=${recycling.deletion?.status} 收尾后 state=${inspected.state}`,
          `公开收尾叙述：${recycling.recyclingDiagnostics.join(" / ") || "无"}`,
        ];
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "owned-failure-retains-restartable-data-and-logs",
    async run({ signal }) {
      const { runId, environment } = nameFor("owned-failure");
      const port = await reserveFreePort({ runId });
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
        webPort: port,
      });
      const workDir = await mkdtemp(path.join(tmpdir(), "02-owned-failure-"));
      const ordinary = await ordinaryCopy(workDir);
      try {
        const created = await runCli(
          [
            "library-create",
            "失败保留库",
            "--directory",
            ordinary,
            "--profile",
            "dlsite-voice",
            "--source",
            "dlsite",
            "--json",
          ],
          prepared.baseEnvironment,
          workDir,
          signal,
        );
        assert.equal(created.exitCode, 0, `登记应成功：${created.stderr}`);
        const scanned = await scanRequiringCover(
          prepared.baseEnvironment,
          workDir,
          rootIdOf(created),
          signal,
        );
        await assertCoverRequirementRefused(scanned, "离线失败保留");
        const recycling = await recycleOwnedEnvironment({
          workspacePath: prepared.workspacePath,
          environment: prepared.environment,
          outcome: "failure",
          signal,
        });
        assert.equal(recycling.deletion, undefined, "失败结局绝不删除");
        assert.equal(recycling.retainedDataRoot, prepared.productDataRoot);
        const catalogue = path.join(
          prepared.productDataRoot,
          "catalogue.sqlite",
        );
        assert.ok(await exists(catalogue), "失败保留必须留下可重启的产品数据");
        const container = path.join(
          workspaceRoot,
          ".digital",
          "environments",
          environment,
        );
        const logs = (await walk(container, ".")).filter((file) =>
          file.startsWith("logs/"),
        );
        assert.ok(logs.length > 0, "失败保留必须留下日志目录");
        const leaked: string[] = [];
        for (const file of logs) {
          const text = await readFile(path.join(container, file), "utf8").catch(
            () => "",
          );
          for (const marker of [
            "authorization:",
            "Bearer ",
            "api_key=",
            "launch.json",
          ])
            if (text.includes(marker)) leaked.push(`${file} 含 ${marker}`);
        }
        assert.deepEqual(
          leaked,
          [],
          `保留日志不该携带凭据材料：${leaked.join("；")}`,
        );
        // 取消已到达就不再接管新的自有服务：保留的现场交给收尾环节统一停止。
        if (signal.aborted)
          return [
            `失败收尾：stop=${recycling.stop?.status} 保留数据根=${recycling.retainedDataRoot} 日志 ${logs.length} 份`,
            "取消已到达：不再启动新的自有服务，保留现场只停止不删除",
          ];
        // 重启同样按本票资源规则登记：先写意图（工作区/环境/端口），再执行启动。
        await ledgerIntent({ runId, environment, port });
        const restarted = await startScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        await ledgerStartResult({
          runId,
          environment,
          port: restarted.run.port ?? 0,
          status: restarted.status,
          pid: restarted.run.pid,
        });
        assert.ok(
          ["ready", "already-ready"].includes(restarted.status),
          `保留的数据必须可显式重启：status=${restarted.status} ${restarted.failure?.message ?? ""}`,
        );
        const stopped = await stopScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        const closed = await recycleOwnedEnvironment({
          workspacePath: workspaceRoot,
          environment,
          outcome: "success",
          signal,
        });
        assert.equal(stopped.status, "stopped");
        if (signal.aborted)
          assert.equal(
            closed.deletion,
            undefined,
            "取消在重启之后到达：只停止并保留现场，绝不删除",
          );
        else
          assert.equal(
            closed.deletion?.status,
            "deleted",
            `显式重启后由所有者回收应删除：delete=${String(closed.deletion?.status)} 问题=${closed.problems.join("；")}`,
          );
        return [
          `失败收尾：stop=${recycling.stop?.status} 保留数据根=${recycling.retainedDataRoot} 日志 ${logs.length} 份`,
          `显式重启：start=${restarted.status} 端口=${String(restarted.run.port)}；随后停止=${stopped.status} 删除=${String(closed.deletion?.status)}`,
        ];
      } finally {
        await rm(workDir, { recursive: true, force: true });
        await finalizeOwnedEnvironment(environment, signal);
      }
    },
  },
  {
    name: "required-role-refusal-offline",
    async run({ signal }) {
      const { environment } = nameFor("refusal-offline");
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
      });
      const workDir = await mkdtemp(path.join(tmpdir(), "02-refusal-offline-"));
      try {
        const ordinary = await ordinaryCopy(workDir);
        const created = await runCli(
          [
            "library-create",
            "离线必需用途库",
            "--directory",
            ordinary,
            "--profile",
            "dlsite-voice",
            "--source",
            "dlsite",
            "--json",
          ],
          prepared.baseEnvironment,
          workDir,
          signal,
        );
        assert.equal(created.exitCode, 0, `登记应成功：${created.stderr}`);
        const scanned = await scanRequiringCover(
          prepared.baseEnvironment,
          workDir,
          rootIdOf(created),
          signal,
        );
        await assertCoverRequirementRefused(scanned, "离线");
        assert.match(
          scanned.stderr,
          /来源补充未完成/u,
          "拒绝必须点明来源补充未完成",
        );
        return [
          `离线环境缺少资料时刷新被拒：exit=${String(scanned.exitCode)} ${scanned.stderr.split("\n")[0]}`,
        ];
      } finally {
        await rm(workDir, { recursive: true, force: true });
        await finalizeOwnedEnvironment(environment, signal);
      }
    },
  },
  {
    name: "required-role-refusal-controlled-without-cover",
    async run({ signal }) {
      const { environment } = nameFor("refusal-no-cover");
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: {
          mode: "controlled",
          manifestPath: path.join(fixtureRoot, "manifest-without-cover.json"),
        },
      });
      const workDir = await mkdtemp(
        path.join(tmpdir(), "02-refusal-no-cover-"),
      );
      try {
        const ordinary = await ordinaryCopy(workDir);
        const created = await runCli(
          [
            "library-create",
            "受控无封面库",
            "--directory",
            ordinary,
            "--profile",
            "dlsite-voice",
            "--source",
            "dlsite",
            "--json",
          ],
          prepared.baseEnvironment,
          workDir,
          signal,
        );
        assert.equal(created.exitCode, 0, `登记应成功：${created.stderr}`);
        const scanned = await scanRequiringCover(
          prepared.baseEnvironment,
          workDir,
          rootIdOf(created),
          signal,
        );
        await assertCoverRequirementRefused(scanned, "受控无封面");
        return [
          `受控清单缺少封面时刷新被拒：exit=${String(scanned.exitCode)} ${scanned.stderr.split("\n")[0]}`,
        ];
      } finally {
        await rm(workDir, { recursive: true, force: true });
        await finalizeOwnedEnvironment(environment, signal);
      }
    },
  },
  {
    name: "provided-served-keeps-owner-and-refuses-writers",
    async run({ signal }) {
      const { runId, environment } = nameFor("provided-served");
      const port = await reserveFreePort({ runId });
      await ledgerIntent({ runId, environment, port });
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
        webPort: port,
      });
      const started = await startScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
      });
      await ledgerStartResult({
        runId,
        environment,
        port: started.run.port ?? port,
        status: started.status,
        pid: started.run.pid,
      });
      assert.equal(
        started.status,
        "ready",
        `提供中的环境应就绪：${started.status}`,
      );
      const before = await fingerprintEnvironment({
        workspacePath: workspaceRoot,
        environment,
      });
      const evidenceDirectory = await mkdtemp(
        path.join(tmpdir(), "02-provided-evidence-"),
      );
      const workDir = await mkdtemp(path.join(tmpdir(), "02-provided-work-"));
      let outcomeLines: readonly string[] = [];
      try {
        const ordinary = await ordinaryCopy(workDir);
        const write = await runCli(
          [
            "library-create",
            "并发写入者库",
            "--directory",
            ordinary,
            "--profile",
            "dlsite-voice",
            "--source",
            "dlsite",
            "--json",
          ],
          prepared.baseEnvironment,
          workDir,
          signal,
        );
        assert.equal(write.exitCode, 1, "服务中的产品根必须拒绝并发写入者");
        assert.match(
          write.stderr,
          /^error: 产品正在写入；拒绝并发启动另一个产品写入者/u,
          `拒绝应由产品自己交出：${write.stderr.slice(0, 300)}`,
        );
        const read = await runCli(
          ["catalogue-surface", "--surface", "current-catalogue"],
          prepared.baseEnvironment,
          workDir,
          signal,
        );
        assert.equal(read.exitCode, 1, "同一产品根被服务时只读面也应拒绝");
        const maintenance = await runCli(
          ["offline-backup", await mkdtemp(path.join(tmpdir(), "02-backup-"))],
          prepared.baseEnvironment,
          workDir,
          signal,
        );
        assert.equal(maintenance.exitCode, 1, "离线维护必须被租约准入拒绝");
        assert.match(maintenance.stderr, /^error: 产品正在运行；/u);

        // 同一世代交给验收运行器：旅程照常发起接入，失败可见，但世代归属留在提供者。
        const journey = await loadControlledJourney();
        const provided = await openProvidedEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        let journeyFailure = "";
        try {
          await runJourney({
            journey,
            mode: "distribution",
            lifecycle: providedEnvironmentLifecycle(provided),
            evidenceDirectory,
            signal,
          });
        } catch (error) {
          journeyFailure =
            error instanceof Error ? error.message : String(error);
        }
        assert.match(journeyFailure, /main failure: /u, "主失败必须独立可见");
        assert.match(journeyFailure, /产品正在写入/u, "拒绝原因应原样进入首因");
        assert.ok(
          !journeyFailure.includes(":passed"),
          "被拒绝的场景绝不报告为通过",
        );
        const evidence = await readSingleEvidence(evidenceDirectory);
        assert.equal(stringField(evidence, "outcome"), "failure");
        assert.equal(evidence["stopStatus"], null, "provided 收尾绝不调用停止");
        assert.equal(evidence["deleteStatus"], null, "provided 收尾绝不删除");
        assert.equal(
          evidence["exitConfirmation"],
          null,
          "provided 不需要退出确认",
        );
        assert.equal(
          stringField(evidence, "retainedDataRoot"),
          provided.productDataRoot,
          "证据应记录数据根仍由所有者持有",
        );
        const diagnostics = JSON.stringify(evidence["recyclingDiagnostics"]);
        assert.match(diagnostics, /未停止、未重建、未删除/u);

        const after = await fingerprintEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.deepEqual(
          [...fingerprintDifference(before, after)].filter(
            (difference) => !difference.startsWith("容器内文件清单"),
          ),
          [],
          "调用方不得改变提供中世代任何运行事实",
        );
        assert.equal(after.serviceReadiness, "ready");
        assert.equal(after.processLiveness, "alive");
        assert.equal(after.port, started.run.port);

        // 只有环境的所有者显式收尾；停止后立即确认这一产品根从未收到场景数据。
        const stopped = await stopScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        const confirmation = await confirmOwnerExit({
          workspacePath: workspaceRoot,
          environment,
        });
        const surface = await runCli(
          ["catalogue-surface", "--surface", "current-catalogue"],
          provided.baseEnvironment,
          workDir,
          signal,
        );
        assert.equal(
          surface.exitCode,
          0,
          `所有者停止后应可读：${surface.stderr}`,
        );
        assert.deepEqual(
          arrayField(jsonObject(surface.stdout, "catalogue-surface"), "items"),
          [],
          "并行场景的数据绝不进入被服务环境",
        );

        await appendStartLedger(startLedgerPath, {
          phase: "release",
          workspacePath: workspaceRoot,
          environment,
          port: after.port ?? port,
          at: new Date().toISOString(),
          runId,
          status: `stop=${stopped.status} exit=${String(confirmation.confirmed)}`,
          pid: null,
        });
        const deleted = await deleteScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(deleted.status, "deleted", "所有者显式回收后容器应删除");
        outcomeLines = [
          `写入者拒绝：library-create exit=${String(write.exitCode)}；offline-backup exit=${String(maintenance.exitCode)}`,
          `旅程失败可见而世代保留：stopStatus=${String(evidence["stopStatus"])} deleteStatus=${String(evidence["deleteStatus"])} readiness=${after.serviceReadiness}`,
          `所有者收尾：stop=${stopped.status} 退出确认=${String(confirmation.confirmed)} delete=${deleted.status}`,
        ];
        return outcomeLines;
      } finally {
        await rm(workDir, { recursive: true, force: true });
        await rm(evidenceDirectory, { recursive: true, force: true });
        await finalizeOwnedEnvironment(environment, signal);
      }
    },
  },
  {
    name: "polluted-parent-terminal-never-reaches-production-entry",
    async run({ signal }) {
      const pollutedRoot = await mkdtemp(path.join(tmpdir(), "02-polluted-"));
      await mkdir(evidenceRoot, { recursive: true });
      const evidenceDirectory = await mkdtemp(
        path.join(evidenceRoot, "parent-pollution-"),
      );
      const polluted = {
        ...process.env,
        DIGITAL_E2E_JOURNEY: "controlled-ordinary-library",
        DIGITAL_PRODUCT_DATA: pollutedRoot,
        DIGITAL_SOURCE_IO_MODE: "real",
        DIGITAL_SOURCE_IO_CONFIG: path.join(
          pollutedRoot,
          "not-a-manifest.json",
        ),
        DIGITAL_SOURCE_IO_IDENTITY:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      } as Record<string, string>;
      try {
        const result = await runNode(
          [
            "--conditions=digital-source",
            path.join(e2eRoot, "run-journeys.ts"),
            "distribution",
            "--evidence-directory",
            evidenceDirectory,
          ],
          polluted,
          signal,
        );
        assert.equal(
          result.exitCode,
          0,
          `遗留配置下的正式入口应仍按记录运行：${result.stderr.slice(0, 600)}`,
        );
        assert.match(
          result.stdout,
          /distribution:controlled-ordinary-library:passed/u,
        );
        const written = await readdir(pollutedRoot);
        assert.deepEqual(
          [...written],
          [],
          `父终端遗留的产品根不得被写入：${written.join("、")}`,
        );
        const evidence = await readSingleEvidence(evidenceDirectory);
        assert.equal(stringField(evidence, "sourceMode"), "controlled");
        assert.match(
          stringField(evidence, "productDataRoot") ?? "",
          /\.digital[/\\]environments[/\\]completion-02-/u,
        );
        return [
          `遗留 DIGITAL_SOURCE_IO_MODE=real 与遗留产品根都被忽略：exit=${String(result.exitCode)} 遗留根内容=${written.length}`,
          `证据世代：sourceMode=${String(evidence["sourceMode"])} 数据根=${String(evidence["productDataRoot"])}`,
        ];
      } finally {
        await rm(pollutedRoot, { recursive: true, force: true });
      }
    },
  },
  {
    name: "signal-interruption-retains-owned-environment",
    async run({ signal }) {
      const journey = await loadControlledJourney();
      const evidenceDirectory = await mkdtemp(
        path.join(tmpdir(), "02-interrupt-evidence-"),
      );
      const cancellation = new AbortController();
      let issued = 0;
      const executor = async (options: {
        readonly mode: CliJourneyMode;
        readonly packedBin: string | undefined;
        readonly command: CliJourneyCommand;
        readonly previousResults: readonly CliJourneyResult[];
        readonly cwd: string;
        readonly environment: Readonly<Record<string, string>>;
        readonly signal?: AbortSignal;
      }): Promise<CliJourneyResult> => {
        issued += 1;
        const output = await runCli(
          commandArgs(options.command, options.previousResults),
          options.environment,
          options.cwd,
          options.signal,
        );
        if (issued === 1)
          cancellation.abort(new Error("验收在首条命令后注入信号中断"));
        return {
          commandName: options.command.name,
          exitCode: output.exitCode,
          stdout: output.stdout,
          stderr: output.stderr,
        };
      };
      let failure = "";
      try {
        await runJourney({
          journey,
          mode: "distribution",
          lifecycle: ownedEnvironmentLifecycle(),
          evidenceDirectory,
          executeCommand: executor,
          signal: cancellation.signal,
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      try {
        assert.match(
          failure,
          /interruption failure: /u,
          "中断结局必须独立可见",
        );
        assert.ok(!failure.includes(":passed"), "中断绝不报告为通过");
        const evidence = await readSingleEvidence(evidenceDirectory);
        assert.equal(stringField(evidence, "outcome"), "interrupted");
        assert.equal(
          stringField(evidence, "retainedDataRoot") !== undefined,
          true,
          "中断只停止并保留自有数据根",
        );
        assert.equal(evidence["deleteStatus"], null, "中断结局绝不删除");
        const retained = stringField(evidence, "retainedDataRoot") ?? "";
        assert.match(
          retained,
          /\.digital[/\\]environments[/\\]completion-02-/u,
        );
        const environmentName = path.basename(path.dirname(retained));
        assert.equal(
          path.dirname(retained),
          path.join(workspaceRoot, ".digital", "environments", environmentName),
          `保留的数据根应指向环境容器：${retained}`,
        );
        assert.ok(
          await exists(path.join(retained, "catalogue.sqlite")),
          `中断必须保留可重启的产品数据：${JSON.stringify(evidence)}`,
        );
        const confirmation = await confirmOwnerExit({
          workspacePath: workspaceRoot,
          environment: environmentName,
        });
        assert.equal(
          confirmation.confirmed,
          true,
          `保留前应确认进程退出：${confirmation.detail}`,
        );
        const closed = await recycleOwnedEnvironment({
          workspacePath: workspaceRoot,
          environment: environmentName,
          outcome: "success",
          signal,
        });
        if (signal.aborted)
          assert.equal(
            closed.deletion,
            undefined,
            "正式入口已收到取消：中断保留的世代只停止不删除",
          );
        else
          assert.equal(
            closed.deletion?.status,
            "deleted",
            `诊断：删除结论=${String(closed.deletion?.status)} 收尾问题=${closed.problems.join("；")} 中断失败全文=${failure.slice(0, 3000)} 证据=${JSON.stringify(evidence)}`,
          );
        return [
          `中断结局：outcome=${String(evidence["outcome"])} deleteStatus=${String(evidence["deleteStatus"])} 退出确认=${String(confirmation.confirmed)}`,
          `所有者随后的显式回收：delete=${closed.deletion?.status} 叙述=${closed.recyclingDiagnostics.join(" / ") || "无"}`,
        ];
      } finally {
        await rm(evidenceDirectory, { recursive: true, force: true });
      }
    },
  },
  {
    /**
     * 取消落在“正被服务”的提供方世代上：调用方只执行公开查看，绝不停止、绝不删除，
     * 提供方服务照常就绪、身份与端口不变；只有所有者自己收尾时才停止并读取。
     */
    name: "provided-generation-survives-cancelled-scene",
    async run({ signal }) {
      const { runId, environment } = nameFor("provided-cancel");
      const port = await reserveFreePort({ runId });
      await ledgerIntent({ runId, environment, port });
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
        webPort: port,
      });
      const started = await startScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
      });
      await ledgerStartResult({
        runId,
        environment,
        port: started.run.port ?? port,
        status: started.status,
        pid: started.run.pid,
      });
      assert.equal(
        started.status,
        "ready",
        `提供中的环境应就绪：${started.status}`,
      );
      const before = await fingerprintEnvironment({
        workspacePath: workspaceRoot,
        environment,
      });
      const provided = await openProvidedEnvironment({
        workspacePath: workspaceRoot,
        environment,
      });
      const evidenceDirectory = await mkdtemp(
        path.join(tmpdir(), "02-provided-cancel-evidence-"),
      );
      const cancellation = new AbortController();
      let issued = 0;
      const executor = async (options: {
        readonly mode: CliJourneyMode;
        readonly packedBin: string | undefined;
        readonly command: CliJourneyCommand;
        readonly previousResults: readonly CliJourneyResult[];
        readonly cwd: string;
        readonly environment: Readonly<Record<string, string>>;
        readonly signal?: AbortSignal;
      }): Promise<CliJourneyResult> => {
        issued += 1;
        const output = await runCli(
          commandArgs(options.command, options.previousResults),
          options.environment,
          options.cwd,
          options.signal,
        );
        if (issued === 1)
          cancellation.abort(new Error("提供方场景在首条命令后收到取消"));
        return {
          commandName: options.command.name,
          exitCode: output.exitCode,
          stdout: output.stdout,
          stderr: output.stderr,
        };
      };
      let failure = "";
      try {
        await runJourney({
          journey: await loadControlledJourney(),
          mode: "distribution",
          lifecycle: providedEnvironmentLifecycle(provided),
          evidenceDirectory,
          executeCommand: executor,
          signal: cancellation.signal,
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      try {
        assert.match(
          failure,
          /interruption failure: /u,
          "取消结局必须独立可见",
        );
        assert.ok(!failure.includes(":passed"), "被取消的场景绝不报告为通过");
        const evidence = await readSingleEvidence(evidenceDirectory);
        assert.equal(stringField(evidence, "outcome"), "interrupted");
        assert.equal(evidence["stopStatus"], null, "取消不得触碰提供方的停止");
        assert.equal(evidence["deleteStatus"], null, "取消不得删除提供方世代");
        assert.equal(
          evidence["exitConfirmation"],
          null,
          "调用方无权确认提供方退出",
        );
        const after = await fingerprintEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.deepEqual(
          [...fingerprintDifference(before, after)].filter(
            (difference) => !difference.startsWith("容器内文件清单"),
          ),
          [],
          "取消后的调用方不得改变提供方任何运行事实",
        );
        assert.equal(after.serviceReadiness, "ready");
        assert.equal(after.processLiveness, "alive");
        assert.equal(after.port, started.run.port);
        const stopped = await stopScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        const confirmation = await confirmOwnerExit({
          workspacePath: workspaceRoot,
          environment,
        });
        const surface = await runCli(
          ["catalogue-surface", "--surface", "current-catalogue"],
          prepared.baseEnvironment,
          await mkdtemp(path.join(tmpdir(), "02-provided-cancel-read-")),
          signal,
        );
        assert.equal(
          surface.exitCode,
          0,
          `所有者停止后该世代仍可读取：${surface.stderr.slice(0, 300)}`,
        );
        const deleted = await deleteScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(deleted.status, "deleted", "所有者显式回收后容器应删除");
        return [
          `取消打在提供中的世代：outcome=${String(evidence["outcome"])} ` +
            `stop=${String(evidence["stopStatus"])} delete=${String(evidence["deleteStatus"])}`,
          `提供方继续归所有者：readiness=${after.serviceReadiness} ` +
            `liveness=${after.processLiveness} 端口=${String(after.port)}`,
          `所有者自己收尾：stop=${stopped.status} ` +
            `退出确认=${String(confirmation.confirmed)} delete=${deleted.status} ` +
            `只读面 exit=${String(surface.exitCode)}`,
        ];
      } finally {
        await rm(evidenceDirectory, { recursive: true, force: true });
        await finalizeOwnedEnvironment(environment, signal);
      }
    },
  },
  {
    /**
     * 真实信号打在正式入口自己身上：外部验收脚本读到就绪标记后向本进程发送 SIGINT。
     * 窗口内确实有一个由本票拥有的产品服务在运行；取消到达后只停止并保留现场，
     * 保留的世代随后仍由所有者公开重启、读取并删除。
     */
    name: "formal-entry-signal-window-retains-own-scene",
    requires: () =>
      process.env.DIGITAL_T02_SIGNAL_WINDOW === "1"
        ? undefined
        : "需要外部脚手架先读取就绪标记再向正式入口发送真实 SIGINT（DIGITAL_T02_SIGNAL_WINDOW=1）",
    async run({ signal }) {
      const { runId, environment } = nameFor("signal-window");
      const port = await reserveFreePort({ runId });
      await ledgerIntent({ runId, environment, port });
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
        webPort: port,
      });
      const workDir = await mkdtemp(path.join(tmpdir(), "02-signal-window-"));
      try {
        const ordinary = await ordinaryCopy(workDir);
        const created = await runCli(
          [
            "library-create",
            "信号窗口库",
            "--directory",
            ordinary,
            "--profile",
            "dlsite-voice",
            "--source",
            "dlsite",
            "--json",
          ],
          prepared.baseEnvironment,
          workDir,
          signal,
        );
        assert.equal(created.exitCode, 0, `登记应成功：${created.stderr}`);
        const root = rootIdOf(created);
        const started = await startScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        await ledgerStartResult({
          runId,
          environment,
          port: started.run.port ?? port,
          status: started.status,
          pid: started.run.pid,
        });
        assert.equal(
          started.status,
          "ready",
          `窗口内应有真实服务在运行：status=${started.status} ${started.failure?.message ?? ""}`,
        );
        process.stdout.write(
          `SIGNAL-WINDOW-READY environment=${environment} ` +
            `port=${String(started.run.port ?? port)} pid=${String(started.run.pid)}\n`,
        );
        const interrupted = await waitForAbort(signal, 300_000);
        assert.ok(
          interrupted,
          "信号窗口超时：外部脚本没有向正式入口发出真实 SIGINT",
        );
        // 取消在停止与删除之间到达：绝不沿用窗口开头的成功结局去删除现场。
        const recycling = await recycleOwnedEnvironment({
          workspacePath: prepared.workspacePath,
          environment: prepared.environment,
          outcome: "success",
          signal,
        });
        assert.deepEqual(
          [...recycling.problems],
          [],
          `收尾不该留下问题：${recycling.problems.join("；")}`,
        );
        assert.equal(
          recycling.exitConfirmation?.confirmed,
          true,
          `保留前必须确认服务真的退出：${recycling.exitConfirmation?.detail ?? ""}`,
        );
        const deletionAtCancel = recycling.deletion?.status ?? null;
        assert.equal(deletionAtCancel, null, "取消到达后绝不删除现场");
        const cancellationNarrative =
          recycling.recyclingDiagnostics.join(" / ");
        assert.match(
          cancellationNarrative,
          /取消在收尾期间到达/u,
          "收尾叙述要写明取消阻止了删除",
        );
        assert.ok(
          await exists(path.join(prepared.productDataRoot, "catalogue.sqlite")),
          "取消保留的世代必须留下可显式重启的产品数据",
        );
        // 被取消的检查不会走到 passed 明细，收尾观察必须在建立时就直接写出。
        process.stdout.write(
          `  - formal-entry-signal-window-retains-own-scene: ` +
            `真实信号后停止并保留：stop=${recycling.stop?.status} ` +
            `退出确认=${String(recycling.exitConfirmation?.confirmed)} ` +
            `删除=${String(deletionAtCancel)} 保留根=${prepared.productDataRoot} ` +
            `收尾叙述=${cancellationNarrative}\n`,
        );
        await ledgerIntent({ runId, environment, port });
        const restarted = await startScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        await ledgerStartResult({
          runId,
          environment,
          port: restarted.run.port ?? port,
          status: restarted.status,
          pid: restarted.run.pid,
        });
        assert.ok(
          ["ready", "already-ready"].includes(restarted.status),
          `保留的世代仍可公开重启：status=${restarted.status} ${restarted.failure?.message ?? ""}`,
        );
        const stopped = await stopScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(stopped.status, "stopped");
        // 取消已如实收尾；公开重启与读取是所有者此刻发起的新动作，
        // 不能沿用中断上下文，否则只会让本票自己的取消转发杀掉产品子进程。
        const reread = await scanRequiringCover(
          prepared.baseEnvironment,
          workDir,
          root,
        );
        await assertCoverRequirementRefused(reread, "取消保留后重启");
        const deleted = await deleteScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(
          deleted.status,
          "deleted",
          `只有所有者显式回收才删除：delete=${deleted.status}`,
        );
        return [
          `保留的世代重启后仍被产品识别：start=${restarted.status} ` +
            `端口=${String(restarted.run.port)}；观察根 ${root} 的必需用途拒绝照常交出；随后删除=${deleted.status}`,
        ];
      } finally {
        await rm(workDir, { recursive: true, force: true });
        await finalizeOwnedEnvironment(environment, signal);
      }
    },
  },
  {
    /**
     * 真实信号打在旅程入口子进程上：本检查向自己启动的正式 run-journeys 进程发送 SIGINT，
     * 核验入口按公开收尾停止并保留世代，父侧只按公开查看确认没有留下仍在运行的进程。
     */
    name: "child-formal-entry-signal-retains-owned-scene",
    async run({ signal }) {
      const environmentsRoot = path.join(
        workspaceRoot,
        ".digital",
        "environments",
      );
      await mkdir(evidenceRoot, { recursive: true });
      const evidenceDirectory = await mkdtemp(
        path.join(evidenceRoot, "formal-entry-signal-"),
      );
      const handoffLedger = path.join(evidenceDirectory, "owners.ndjson");
      const child = spawn(
        process.execPath,
        [
          "--conditions=digital-source",
          path.join(e2eRoot, "run-journeys.ts"),
          "distribution",
          "--evidence-directory",
          evidenceDirectory,
          "--handoff-ledger",
          handoffLedger,
        ],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            DIGITAL_E2E_JOURNEY: "controlled-ordinary-library",
          },
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
      forwardCancellation(child, signal);
      const exitCode = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          resolve(code ?? 1);
        });
      });
      let observed = "";
      try {
        observed = await Promise.race([
          waitForOwnedSceneInFlight(environmentsRoot, handoffLedger, 120_000),
          exitCode.then((code) => {
            throw new Error(
              `正式入口在收到信号前就结束了（exit=${String(code)}），窗口不足以证明中断收尾：\n${stdout}\n${stderr}`,
            );
          }),
        ]);
        child.kill("SIGINT");
        const exited = await exitCode;
        assert.notEqual(exited, 0, "被信号中断的正式入口不得报告成功");
        const evidence = await readSingleEvidence(evidenceDirectory);
        assert.equal(stringField(evidence, "outcome"), "interrupted");
        assert.equal(
          evidence["deleteStatus"],
          null,
          "中断结局绝不删除自有世代",
        );
        assert.equal(
          stringField(evidence, "sourceMode"),
          "controlled",
          "证据要记录本票选择的受控来源",
        );
        const failures = JSON.stringify(evidence["failures"]);
        assert.match(failures, /journey interrupted by signal/u);
        const environment = stringField(evidence, "environment") ?? "";
        const productDataRoot = stringField(evidence, "productDataRoot") ?? "";
        assert.ok(
          environment.startsWith("completion-02-") &&
            productDataRoot.endsWith("product-data"),
          `中断的世代归属可辨：environment=${environment} root=${productDataRoot}`,
        );
        assert.ok(
          environment === observed,
          `子进程自有的世代应与实际观察到的容器一致：观察=${observed} 证据=${environment}`,
        );
        assert.ok(
          await exists(path.join(productDataRoot, "catalogue.sqlite")),
          "被中断的入口必须留下可重启的产品数据",
        );
        const confirmation = await confirmOwnerExit({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(
          confirmation.confirmed,
          true,
          `入口收尾后不得留下仍在运行的进程：${confirmation.detail}`,
        );
        const closed = await recycleOwnedEnvironment({
          workspacePath: workspaceRoot,
          environment,
          outcome: "success",
          signal,
        });
        assert.deepEqual(
          [...closed.problems],
          [],
          `所有者收尾不该留下问题：${closed.problems.join("；")}`,
        );
        assert.equal(
          signal.aborted || closed.deletion?.status === "deleted",
          true,
          `所有者显式回收应删除：delete=${String(closed.deletion?.status)} 取消已到达=${String(signal.aborted)}`,
        );
        return [
          `真实 SIGINT 打在正式旅程入口：子进程 exit=${String(exited)} 结局=${String(evidence["outcome"])} 删除=${String(evidence["deleteStatus"])}`,
          `入口自己完成收尾：退出确认=${String(confirmation.confirmed)} 产品数据保留于 ${productDataRoot}`,
          `所有者显式回收：delete=${String(closed.deletion?.status)} 叙述=${closed.recyclingDiagnostics.join(" / ") || "无"}`,
        ];
      } finally {
        // 收尾只针对本票自己启动的子进程与它新建的世代：仍未退出就再转达一次 SIGINT，
        // 世代一律经公开停止与删除处理，不用 rm 直接抹掉容器。
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGINT");
        await exitCode.catch(() => undefined);
        for (const environment of await childOwnedEnvironments(handoffLedger))
          await finalizeOwnedEnvironment(environment, signal);
      }
    },
  },
  {
    /**
     * 运行器把主失败交回调用方之后，保留的世代仍能通过环境包公开入口重启并被产品读取；
     * 这条路径全程使用真实的 runJourney 与真实正式 CLI，不用替身代替收尾。
     */
    name: "runner-failure-retained-scene-restarts-through-public-entry",
    async run({ signal }) {
      const runId = scenarioRunId();
      const port = await reserveFreePort({ runId });
      const evidenceDirectory = await mkdtemp(
        path.join(tmpdir(), "02-runner-failure-"),
      );
      // 观察根放在检查自己拥有的目录里：运行器的临时工作目录会被回收，
      // 重启后要读回的必须是仍然存在的同一份现场，而不是悬空引用。
      const sceneStore = await mkdtemp(path.join(tmpdir(), "02-runner-scene-"));
      const scene = await ordinaryCopy(sceneStore);
      const journey: CliJourney = {
        name: "runner-failure-retention",
        modes: ["distribution"],
        source: { mode: "offline" },
        async setup() {},
        commands() {
          return [
            {
              name: "library-create registers the scene root",
              args: [
                "library-create",
                "运行器失败保留",
                "--directory",
                scene,
                "--json",
              ],
              haltOnFailure: true,
            },
            {
              name: "library-create on a missing directory",
              args: [
                "library-create",
                "不存在的目录",
                "--directory",
                "does-not-exist-completion-02",
                "--json",
              ],
              haltOnFailure: true,
            },
          ];
        },
        async assertions() {
          throw new Error("主命令失败后不应执行普通断言");
        },
      };
      let failure = "";
      let owned = "";
      try {
        await runJourney({
          journey,
          mode: "distribution",
          lifecycle: ownedEnvironmentLifecycle({ webPort: port }),
          evidenceDirectory,
          signal,
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      try {
        assert.match(failure, /main failure: /u, "主失败必须独立可见");
        assert.ok(!failure.includes(":passed"), "被拒绝的世代绝不报告为通过");
        const evidence = await readSingleEvidence(evidenceDirectory);
        assert.equal(stringField(evidence, "outcome"), "failure");
        assert.equal(
          evidence["deleteStatus"],
          null,
          "运行器主失败后绝不删除可重启数据",
        );
        const productDataRoot = stringField(evidence, "retainedDataRoot") ?? "";
        const environment = stringField(evidence, "environment") ?? "";
        owned = environment;
        assert.match(productDataRoot, /completion-02-/u);
        assert.ok(
          await exists(path.join(productDataRoot, "catalogue.sqlite")),
          `主失败必须留下可显式重启的产品数据：${JSON.stringify(evidence)}`,
        );
        const confirmation = await confirmOwnerExit({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(
          confirmation.confirmed,
          true,
          `保留前确认没有残留进程：${confirmation.detail}`,
        );
        if (signal.aborted)
          return [
            `运行器主失败保留世代：outcome=${String(evidence["outcome"])} 删除=${String(evidence["deleteStatus"])} 保留根=${productDataRoot}`,
            "取消已到达：不再启动新的自有服务，保留的世代只停止不删除",
          ];
        await ledgerIntent({ runId, environment, port });
        const restarted = await startScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        await ledgerStartResult({
          runId,
          environment,
          port: restarted.run.port ?? port,
          status: restarted.status,
          pid: restarted.run.pid,
        });
        assert.ok(
          ["ready", "already-ready"].includes(restarted.status),
          `运行器保留的世代可经公开入口重启：status=${restarted.status} ${restarted.failure?.message ?? ""}`,
        );
        const stopped = await stopScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(stopped.status, "stopped");
        const reopened = await openProvidedEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        const surface = await runCli(
          ["catalogue-surface", "--surface", "current-catalogue"],
          reopened.baseEnvironment,
          await mkdtemp(path.join(tmpdir(), "02-runner-failure-read-")),
          signal,
        );
        assert.equal(
          surface.exitCode,
          0,
          `重启后的产品数据仍由正式 CLI 读取：${surface.stderr.slice(0, 300)}`,
        );
        const closed = await recycleOwnedEnvironment({
          workspacePath: workspaceRoot,
          environment,
          outcome: "success",
          signal,
        });
        assert.equal(
          closed.deletion?.status,
          "deleted",
          `所有者显式回收应删除：delete=${String(closed.deletion?.status)} 问题=${closed.problems.join("；")}`,
        );
        return [
          `运行器主失败保留世代：outcome=${String(evidence["outcome"])} 删除=${String(evidence["deleteStatus"])} 保留根=${productDataRoot}`,
          `公开重启并读取：start=${restarted.status} 端口=${String(restarted.run.port)} 停止=${stopped.status} 只读面 exit=${String(surface.exitCode)}`,
          `所有者收尾：delete=${String(closed.deletion?.status)} 退出确认=${String(closed.exitConfirmation?.confirmed)}`,
        ];
      } finally {
        await rm(evidenceDirectory, { recursive: true, force: true });
        await rm(sceneStore, { recursive: true, force: true });
        if (owned.length > 0) await finalizeOwnedEnvironment(owned, signal);
      }
    },
  },
  {
    /**
     * 删除的真实分类：服务仍在运行时公开删除必须给出被拒绝的实际结论，既不删一半，
     * 也不把仍在运行的进程写成已退出；停止之后才由所有者完成删除。
     */
    name: "delete-refused-while-own-service-is-running",
    async run({ signal }) {
      const { runId, environment } = nameFor("delete-refused");
      const port = await reserveFreePort({ runId });
      await ledgerIntent({ runId, environment, port });
      await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
        webPort: port,
      });
      try {
        const started = await startScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        await ledgerStartResult({
          runId,
          environment,
          port: started.run.port ?? port,
          status: started.status,
          pid: started.run.pid,
        });
        assert.equal(
          started.status,
          "ready",
          `需要真实在运行的服务：status=${started.status} ${started.failure?.message ?? ""}`,
        );
        const refused = await deleteScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(
          refused.status,
          "refused",
          `运行中的删除要给出实际分类：delete=${refused.status} ${refused.failure?.message ?? ""}`,
        );
        assert.equal(
          refused.cleanup.state,
          "not-started",
          "被拒绝的删除不得开始清理",
        );
        const container = path.join(
          workspaceRoot,
          ".digital",
          "environments",
          environment,
        );
        assert.ok(await exists(container), "被拒绝的删除不得留下半删的容器");
        const confirmation = await confirmOwnerExit({
          workspacePath: workspaceRoot,
          environment,
        });
        assert.equal(
          confirmation.confirmed,
          false,
          `仍在运行时不得伪造退出确认：${confirmation.detail}`,
        );
        const stopped = await stopScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        const closed = await recycleOwnedEnvironment({
          workspacePath: workspaceRoot,
          environment,
          outcome: "success",
          signal,
        });
        assert.equal(stopped.status, "stopped");
        assert.equal(
          signal.aborted || closed.deletion?.status === "deleted",
          true,
          `停止后由所有者删除：delete=${String(closed.deletion?.status)} 取消已到达=${String(signal.aborted)}`,
        );
        return [
          `运行中的删除按实际分类拒绝：delete=${refused.status} ` +
            `清理=${refused.cleanup.state} 退出确认=${String(confirmation.confirmed)}`,
          `停止后收尾：stop=${stopped.status} ` +
            `退出确认=${String(closed.exitConfirmation?.confirmed)} 删除=${String(closed.deletion?.status)}`,
        ];
      } finally {
        await finalizeOwnedEnvironment(environment, signal);
      }
    },
  },
  {
    /**
     * 票内并行运行隔离：两个交付模式各自拥有独立的世代与产品数据根，互不重叠，
     * 作者夹具素材在并行期间逐字节不变。
     */
    name: "concurrent-owned-scenes-share-nothing",
    async run({ signal }) {
      const journey = await loadControlledJourney();
      const material = path.join(fixtureRoot, "material", "RJ01668691");
      const before = await materialDigests(material);
      const runId = scenarioRunId();
      // 端口逐个实际探测并显式分配给各世代：并行双方绝不共用同一个监听口。
      const firstPort = await reserveFreePort({ runId });
      const secondPort = await reserveFreePort({ runId, exclude: [firstPort] });
      assert.notEqual(firstPort, secondPort, "并行世代不得共用同一个预留端口");
      const ports = { distribution: firstPort, source: secondPort };
      const evidenceDirectory = await mkdtemp(
        path.join(tmpdir(), "02-concurrent-evidence-"),
      );
      try {
        const passed = await Promise.all(
          (["distribution", "source"] as const).map((mode) =>
            runJourney({
              journey,
              mode,
              lifecycle: ownedEnvironmentLifecycle({ webPort: ports[mode] }),
              evidenceDirectory,
              signal,
            }),
          ),
        );
        const entries = (await readdir(evidenceDirectory))
          .filter((entry) => entry.endsWith(".json"))
          .toSorted();
        assert.equal(
          entries.length,
          2,
          `两个并行世代各留一份证据：${entries.join("、")}`,
        );
        const evidences: JsonObject[] = [];
        for (const entry of entries)
          evidences.push(
            jsonObject(
              await readFile(path.join(evidenceDirectory, entry), "utf8"),
              `并行证据 ${entry}`,
            ),
          );
        const names = evidences.map(
          (evidence) => stringField(evidence, "environment") ?? "",
        );
        assert.equal(
          new Set(names).size,
          2,
          `并行世代的名字不得重叠：${names.join("、")}`,
        );
        const roots = evidences.map(
          (evidence) => stringField(evidence, "productDataRoot") ?? "",
        );
        for (const root of roots)
          assert.ok(
            root.length > 0 && root.includes("completion-02-"),
            `并行世代各自拥有独立的产品数据根：${roots.join(" 与 ")}`,
          );
        assert.ok(
          path.relative(roots[0] ?? "", roots[1] ?? "").startsWith("..") &&
            path.relative(roots[1] ?? "", roots[0] ?? "").startsWith(".."),
          `并行世代的数据根互不嵌套：${roots[0]} 与 ${roots[1]}`,
        );
        const workDirs = evidences.map(
          (evidence) => stringField(evidence, "callerWorkDir") ?? "",
        );
        assert.equal(
          new Set(workDirs).size,
          2,
          `并行世代各自的调用方工作区不重叠：${workDirs.join("、")}`,
        );
        for (const evidence of evidences) {
          assert.equal(stringField(evidence, "outcome"), "success");
          assert.equal(
            evidence["deleteStatus"],
            "deleted",
            "并行世代的成功收尾各自删除自己的容器",
          );
        }
        const after = await materialDigests(material);
        assert.deepEqual(
          after,
          before,
          "并行世代改变了作者夹具素材的逐字节内容",
        );
        return [
          `并行两个交付模式各自通过：${passed.join(" / ")}`,
          `世代互不重叠：${names.join(" / ")} 端口=${String(ports.distribution)} 与 ${String(ports.source)}`,
          `素材哈希不变：${String(after.length)} 份文件的摘要与长度逐一相同`,
        ];
      } finally {
        await rm(evidenceDirectory, { recursive: true, force: true });
      }
    },
  },
];

function rootIdOf(created: CommandOutput): string {
  const parsed = jsonObject(created.stdout, "library-create");
  const rootIds = parsed["rootIds"];
  if (!Array.isArray(rootIds) || typeof rootIds[0] !== "string")
    throw new Error("library-create 未交出一个观察根编号");
  return rootIds[0];
}

function commandArgs(
  command: CliJourneyCommand,
  previousResults: readonly CliJourneyResult[],
): readonly string[] {
  return typeof command.args === "function"
    ? command.args(previousResults)
    : command.args;
}

async function loadControlledJourney(): Promise<CliJourney> {
  const loaded = (await import(
    pathToFileURL(
      path.join(e2eRoot, "journeys", "controlled-ordinary-library.journey.ts"),
    ).href
  )) as { default: CliJourney };
  return loaded.default;
}

/** 只采信本次正式子进程在 prepare 前交出的资源归属，不认领目录增量。 */
async function childOwnedEnvironments(
  ledgerPath: string,
): Promise<readonly string[]> {
  let contents: string;
  try {
    contents = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // 写入尚未完成的末行没有交接意义；prepare 只在完整追加成功后开始。
  return contents
    .split("\n")
    .slice(0, -1)
    .map((line) => {
      const owner = jsonObject(line, "子进程交接台账");
      const environment = stringField(owner, "environment");
      assert.equal(owner["workspacePath"], workspaceRoot);
      assert(typeof environment === "string");
      assert(environment.startsWith("completion-02-"));
      return environment;
    });
}

async function readSingleEvidence(directory: string): Promise<JsonObject> {
  const entries = await readdir(directory);
  const files = entries.filter((entry) => entry.endsWith(".json"));
  const [name] = files;
  assert.ok(
    name !== undefined && files.length === 1,
    `${directory} 应只有一份证据，实际 ${files.length} 份`,
  );
  const text = await readFile(path.join(directory, name), "utf8");
  return jsonObject(text, "证据");
}

export async function runEnvironmentContractChecks(
  selection: readonly string[],
  signal: AbortSignal = new AbortController().signal,
): Promise<readonly string[]> {
  const summary: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const passed: string[] = [];
  const notRun: string[] = [];
  const report = (lines: readonly string[]): void => {
    for (const line of lines) {
      summary.push(line);
      process.stdout.write(`${line}\n`);
    }
  };
  for (const check of checks) {
    if (selection.length > 0 && !selection.includes(check.name)) continue;
    // 外部条件不满足的检查根本没有执行：如实报未执行，绝不冒充第 N 项业务通过。
    const unmetRequirement = check.requires?.();
    if (unmetRequirement !== undefined) {
      notRun.push(check.name);
      report([
        `${check.name}: not-run 未执行：${unmetRequirement}；不计通过也不计失败`,
      ]);
      continue;
    }
    // 取消到达后不再启动新的检查：每一项都会拥有自己的端口与世代。
    if (signal.aborted) {
      skipped.push(check.name);
      report([
        `${check.name}: skipped-cancellation 正式入口已收到取消，未启动`,
      ]);
      continue;
    }
    const startedAt = new Date().toISOString();
    try {
      const observations = await check.run({ signal });
      const detail = observations.map(
        (observation) => `  - ${check.name}: ${observation}`,
      );
      // 取消之后才跑完的检查体只留观察，不写成通过。
      if (signal.aborted)
        report([
          `${check.name}: interrupted @ ${startedAt} 检查体在取消之后完成，其观察不构成通过`,
          ...detail,
        ]);
      else {
        passed.push(check.name);
        report([`${check.name}: passed @ ${startedAt}`, ...detail]);
      }
    } catch (error) {
      failed.push(
        `${check.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      report([`${check.name}: FAILED @ ${startedAt}`]);
    }
  }
  if (signal.aborted) {
    report([
      `cancellation: 正式入口收到取消，${String(skipped.length)} 项检查未启动；` +
        "已启动的世代只停止并保留现场",
    ]);
    // 取消就是未完成：即使选中的检查恰好全部跑完，也绝不把被取消的运行写成通过。
    failed.push(
      skipped.length === 0
        ? "cancellation: 本次运行被取消，按未完成收尾而不报通过"
        : `cancellation: 未启动的检查 ${skipped.join("、")}`,
    );
  }
  report([
    `summary: 实际执行并通过 ${String(passed.length)} 项、未执行 ${String(notRun.length)} 项` +
      (notRun.length === 0 ? "" : `（${notRun.join("、")}）`) +
      "；未执行不计入通过",
  ]);
  if (failed.length > 0)
    throw new Error(`环境归属检查失败：\n${failed.join("\n\n")}`);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cancellation = new AbortController();
  const handlers: [NodeJS.Signals, () => void][] = [];
  const received: string[] = [];
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      // 只中止验收流程：默认终止会让本票拥有的服务在父进程之后继续运行。
      if (cancellation.signal.aborted) return;
      received.push(signalName);
      cancellation.abort(
        new Error(`正式入口收到 ${signalName}：自有环境只停止并保留现场`),
      );
    };
    handlers.push([signalName, handler]);
    process.on(signalName, handler);
  }
  try {
    await runEnvironmentContractChecks(
      process.argv.slice(2),
      cancellation.signal,
    );
  } catch (error) {
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (received.length > 0)
      process.stdout.write(
        `cancellation-received: ${received.join("+")}：取消上下文已交给收尾路径\n`,
      );
    for (const [signalName, handler] of handlers)
      process.removeListener(signalName, handler);
  }
}
