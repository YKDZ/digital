/**
 * 11 票的环境归属与负向证据套件：全部通过正式 CLI 生产入口与环境包的公开接口运行，
 * 不用替身代替产品，也不改动产品语义。逐项检查彼此独立，任一失败都不会掩盖其它检查。
 *
 * 覆盖：自有环境的成功回收、失败保留与可显式重启、必需产物用途缺位时的拒绝、
 * 提供中的环境在写入者被拒后仍由所有者持有、父终端遗留配置不会进入生产入口、
 * 信号中断只停止并保留自有环境。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  appendStartLedger,
  confirmOwnerExit,
  deleteScenarioEnvironment,
  fingerprintDifference,
  fingerprintEnvironment,
  openProvidedEnvironment,
  prepareScenarioEnvironment,
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
/** 与验收运行器共用的证据目录：父终端污染检查据此核对本次新增的那一份。 */
const evidenceRoot = path.join(workspaceRoot, "run", "t11-evidence");

/** 本套件自己拥有的环境一律带 t11- 前缀，端口只取 50001—50999 内的空闲结果。 */
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

async function runCli(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  cwd: string,
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
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function runNode(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
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
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
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

type Check = { readonly name: string; run(): Promise<readonly string[]> };

const checks: readonly Check[] = [
  {
    name: "owned-success-recycles-through-public-operations",
    async run() {
      const { environment } = nameFor("owned-success");
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
      });
      const workDir = await mkdtemp(path.join(tmpdir(), "t11-owned-success-"));
      try {
        const surface = await runCli(
          ["catalogue-surface", "--surface", "current-catalogue"],
          prepared.baseEnvironment,
          workDir,
        );
        assert.equal(surface.exitCode, 0, `只读面应成功：${surface.stderr}`);
        const recycling = await recycleOwnedEnvironment({
          workspacePath: prepared.workspacePath,
          environment: prepared.environment,
          outcome: "success",
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
        assert.equal(recycling.deletion?.status, "deleted");
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
    async run() {
      const { runId, environment } = nameFor("owned-failure");
      const port = await reserveFreePort({ runId });
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
        webPort: port,
      });
      const workDir = await mkdtemp(path.join(tmpdir(), "t11-owned-failure-"));
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
        );
        assert.equal(created.exitCode, 0, `登记应成功：${created.stderr}`);
        const scanned = await scanRequiringCover(
          prepared.baseEnvironment,
          workDir,
          rootIdOf(created),
        );
        await assertCoverRequirementRefused(scanned, "离线失败保留");
        const recycling = await recycleOwnedEnvironment({
          workspacePath: prepared.workspacePath,
          environment: prepared.environment,
          outcome: "failure",
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
        // 重启同样按本票资源规则登记：先写意图（工作区/环境/端口），再执行启动。
        await appendStartLedger(startLedgerPath, {
          phase: "intent",
          workspacePath: workspaceRoot,
          environment,
          port,
          at: new Date().toISOString(),
          runId,
        });
        const restarted = await startScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        await appendStartLedger(startLedgerPath, {
          phase: "result",
          workspacePath: workspaceRoot,
          environment,
          port: restarted.run.port ?? 0,
          at: new Date().toISOString(),
          runId,
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
        });
        assert.equal(stopped.status, "stopped");
        assert.equal(
          closed.deletion?.status,
          "deleted",
          `显式重启后由所有者回收应删除：delete=${String(closed.deletion?.status)} 问题=${closed.problems.join("；")}`,
        );
        return [
          `失败收尾：stop=${recycling.stop?.status} 保留数据根=${recycling.retainedDataRoot} 日志 ${logs.length} 份`,
          `显式重启：start=${restarted.status} 端口=${String(restarted.run.port)}；随后停止=${stopped.status} 删除=${closed.deletion?.status}`,
        ];
      } finally {
        await rm(workDir, { recursive: true, force: true });
        await deleteScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
      }
    },
  },
  {
    name: "required-role-refusal-offline",
    async run() {
      const { environment } = nameFor("refusal-offline");
      const prepared = await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: { mode: "offline" },
      });
      const workDir = await mkdtemp(
        path.join(tmpdir(), "t11-refusal-offline-"),
      );
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
        );
        assert.equal(created.exitCode, 0, `登记应成功：${created.stderr}`);
        const scanned = await scanRequiringCover(
          prepared.baseEnvironment,
          workDir,
          rootIdOf(created),
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
        await stopScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        await deleteScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
      }
    },
  },
  {
    name: "required-role-refusal-controlled-without-cover",
    async run() {
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
        path.join(tmpdir(), "t11-refusal-no-cover-"),
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
        );
        assert.equal(created.exitCode, 0, `登记应成功：${created.stderr}`);
        const scanned = await scanRequiringCover(
          prepared.baseEnvironment,
          workDir,
          rootIdOf(created),
        );
        await assertCoverRequirementRefused(scanned, "受控无封面");
        return [
          `受控清单缺少封面时刷新被拒：exit=${String(scanned.exitCode)} ${scanned.stderr.split("\n")[0]}`,
        ];
      } finally {
        await rm(workDir, { recursive: true, force: true });
        await stopScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        await deleteScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
      }
    },
  },
  {
    name: "provided-served-keeps-owner-and-refuses-writers",
    async run() {
      const { runId, environment } = nameFor("provided-served");
      const port = await reserveFreePort({ runId });
      await appendStartLedger(startLedgerPath, {
        phase: "intent",
        workspacePath: workspaceRoot,
        environment,
        port,
        at: new Date().toISOString(),
        runId,
      });
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
      await appendStartLedger(startLedgerPath, {
        phase: "result",
        workspacePath: workspaceRoot,
        environment,
        port: started.run.port ?? port,
        at: new Date().toISOString(),
        runId,
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
        path.join(tmpdir(), "t11-provided-evidence-"),
      );
      const workDir = await mkdtemp(path.join(tmpdir(), "t11-provided-work-"));
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
        );
        assert.equal(read.exitCode, 1, "同一产品根被服务时只读面也应拒绝");
        const maintenance = await runCli(
          ["offline-backup", await mkdtemp(path.join(tmpdir(), "t11-backup-"))],
          prepared.baseEnvironment,
          workDir,
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
        await stopScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
        await deleteScenarioEnvironment({
          workspacePath: workspaceRoot,
          environment,
        });
      }
    },
  },
  {
    name: "polluted-parent-terminal-never-reaches-production-entry",
    async run() {
      const pollutedRoot = await mkdtemp(path.join(tmpdir(), "t11-polluted-"));
      const beforeEvidence = new Set(await readdir(evidenceRoot));
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
            "apps/cli/test/e2e/run-journeys.ts",
            "distribution",
          ],
          polluted,
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
        const evidence = await readNewestEvidence(evidenceRoot, beforeEvidence);
        assert.equal(stringField(evidence, "sourceMode"), "controlled");
        assert.match(
          stringField(evidence, "productDataRoot") ?? "",
          /\.digital[/\\]environments[/\\]t11-/u,
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
    async run() {
      const journey = await loadControlledJourney();
      const evidenceDirectory = await mkdtemp(
        path.join(tmpdir(), "t11-interrupt-evidence-"),
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
        assert.match(retained, /\.digital[/\\]environments[/\\]t11-/u);
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
        });
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

/** 共享证据目录会累积历次结果：只采信本次运行新增的那一份。 */
async function readNewestEvidence(
  directory: string,
  before: ReadonlySet<string>,
): Promise<JsonObject> {
  const entries = await readdir(directory);
  const fresh = entries.filter(
    (entry) => entry.endsWith(".json") && !before.has(entry),
  );
  const [name] = fresh;
  assert.ok(
    name !== undefined && fresh.length === 1,
    `本次运行应只新增一份证据，实际 ${fresh.length} 份`,
  );
  const text = await readFile(path.join(directory, name), "utf8");
  return jsonObject(text, "证据");
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
): Promise<readonly string[]> {
  const summary: string[] = [];
  const failed: string[] = [];
  for (const check of checks) {
    if (selection.length > 0 && !selection.includes(check.name)) continue;
    const startedAt = new Date().toISOString();
    try {
      const observations = await check.run();
      summary.push(`${check.name}: passed @ ${startedAt}`);
      for (const observation of observations)
        summary.push(`  - ${check.name}: ${observation}`);
    } catch (error) {
      failed.push(
        `${check.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      summary.push(`${check.name}: FAILED @ ${startedAt}`);
    }
  }
  process.stdout.write(`${summary.join("\n")}\n`);
  if (failed.length > 0)
    throw new Error(`环境归属检查失败：\n${failed.join("\n\n")}`);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runEnvironmentContractChecks(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
