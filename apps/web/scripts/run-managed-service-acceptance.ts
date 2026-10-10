import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  appendLedger,
  claimFreePort,
  environmentCliRelativePath,
  fileCommandJournal,
  lifecycleResult,
  nestedRun,
  runCommand,
  statusFact,
  type LifecycleResult,
} from "./environment-lifecycle.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const webPackageRoot = path.resolve(import.meta.dirname, "..");
const environmentCliPath = path.join(
  repositoryRoot,
  environmentCliRelativePath,
);
const fixtureDirectory = path.join(
  repositoryRoot,
  "fixtures",
  "controlled-source-io",
);
const acceptanceConfig = "playwright.acceptance.config.ts";
const productChainSpec = "test/e2e/managed-service-product-chain.spec.ts";
const providedVerificationSpec =
  "test/e2e/provided-service-verification.spec.ts";
const readyPath = "/api/ready";
/** 直接运行本包的 Playwright CLI，让浏览器场景自成可取消的进程组。 */
const playwrightCli = path.join(
  webPackageRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

/** 浏览器在取消后仍可能收尾较慢；超过这个时限就强制结束整个子进程。 */
const browserCancelGraceMs = 30_000;

type Mode = "owned" | "provided";

type Options = {
  readonly mode: Mode;
  readonly environment: string;
  readonly workspacePath: string;
  readonly ledgerPath: string;
  readonly artifactsDirectory: string;
  readonly materialDirectory: string;
  readonly manifestPath: string;
  readonly contentIdentity: string;
  readonly sourceMode: string;
  readonly baseUrl?: string;
  readonly keepOnSuccess: boolean;
  readonly prepareTimeoutMs: number;
  readonly startTimeoutMs: number;
};

type Failure = {
  readonly phase: string;
  readonly stage: string;
  readonly message: string;
  readonly exitCode: number | null;
};

/** 证据保存失败单列一类：它既不是业务执行失败，也不是资源清理失败。 */
type SaveError = {
  readonly stage: string;
  readonly target: string;
  readonly message: string;
};

function requireFact(value: string, label: string): string {
  if (value.length === 0)
    throw new Error(`公开生命周期结果里没有可用的${label}`);
  return value;
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined)
      throw new Error(`参数必须成对出现：${argv.slice(index).join(" ")}`);
    flags.set(key.slice(2), value);
  }
  const mode = flags.get("mode");
  if (mode !== "owned" && mode !== "provided")
    throw new Error("必须给出 --mode owned 或 --mode provided");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const defaultArtifacts = path.join(
    repositoryRoot,
    ".scratch",
    "acceptance",
    `${mode}-${stamp}`,
  );
  const providedBaseUrl =
    flags.get("base-url") ?? process.env.DIGITAL_ACCEPTANCE_BASE_URL;
  return {
    mode,
    environment: flags.get("environment") ?? `completion-03-${mode}-${stamp}`,
    workspacePath: path.resolve(flags.get("workspace") ?? repositoryRoot),
    ledgerPath: path.resolve(
      flags.get("ledger") ??
        process.env.DIGITAL_ACCEPTANCE_LEDGER ??
        path.join(defaultArtifacts, "ledger.ndjson"),
    ),
    artifactsDirectory: path.resolve(
      flags.get("artifacts") ??
        process.env.DIGITAL_ACCEPTANCE_ARTIFACTS ??
        defaultArtifacts,
    ),
    materialDirectory: path.resolve(
      flags.get("material") ??
        path.join(fixtureDirectory, "material", "RJ01668691"),
    ),
    manifestPath: path.resolve(
      flags.get("manifest") ?? path.join(fixtureDirectory, "manifest.json"),
    ),
    contentIdentity:
      flags.get("identity") ??
      "sha256:0595bf9c66f739a60b67ac434391e7e274d5f268df5509637c48b73c4fefa6e8",
    sourceMode: flags.get("source-mode") ?? "controlled",
    ...(providedBaseUrl === undefined ? {} : { baseUrl: providedBaseUrl }),
    keepOnSuccess: flags.get("keep-on-success") === "true",
    prepareTimeoutMs: Number(flags.get("prepare-timeout-ms") ?? 900_000),
    startTimeoutMs: Number(flags.get("start-timeout-ms") ?? 300_000),
  };
}

async function readReady(
  baseUrl: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(new URL(readyPath, baseUrl), {
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.text() };
}

/** 产品就绪只由 `/api/ready` 的成功应答决定，不用首页可达或进程存活代替。 */
async function awaitProductReady(
  baseUrl: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 0, body: "" };
  while (Date.now() < deadline) {
    try {
      last = await readReady(baseUrl);
      if (last.status === 200 && last.body.includes('"ok":true')) return last;
    } catch (cause) {
      last = { status: 0, body: String(cause) };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

/**
 * 自有进程的启动时刻（`/proc/<pid>/stat` 第 22 字段），与 workspace / environment /
 * run / PID / port 一起登记到台账；读不到时如实记下原因而不是留空。
 */
function processStartTimeTicks(pid: number | undefined): string {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return "未取得 PID";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fieldsAfterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fieldsAfterName[19] ?? "字段缺失";
  } catch (error) {
    return `进程已退出或不可读：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * 浏览器场景连接正在服务的真实进程；取消信号直接转发给 Playwright 子进程，
 * 保证只对本 runner 发信号时正在执行的扫描、编辑等真实操作也会真的结束。
 */
async function runBrowserScenario(input: {
  readonly handoffPath: string;
  readonly baseUrl: string;
  readonly spec: string;
  readonly journal: ReturnType<typeof fileCommandJournal>;
  readonly outputDirectory: string;
  readonly signal: AbortSignal;
  readonly saveErrors: SaveError[];
  readonly onPid: (pid: number | undefined) => void;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  outputDirectory: string;
}> {
  const argv = [
    "test",
    "--config",
    acceptanceConfig,
    input.spec,
    `--output=${input.outputDirectory}`,
    "--reporter=list",
  ];
  const startedAt = new Date().toISOString();
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    forced: boolean;
  }>((resolve) => {
    // 直接以 node 运行 Playwright CLI 并让它自成进程组：只对本 runner 发信号时，
    // 取消会确实转发到正在执行扫描/编辑的浏览器进程组。
    const child = spawn(process.execPath, [playwrightCli, ...argv], {
      cwd: webPackageRoot,
      detached: true,
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_EXTERNAL_BASE_URL: input.baseUrl,
        DIGITAL_ACCEPTANCE_HANDOFF: input.handoffPath,
      },
    });
    input.onPid(child.pid);
    let settled = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // 进程组已经退出；不把它当作新的失败。
        try {
          child.kill(signal);
        } catch {
          // 子进程已不存在。
        }
      }
    };
    const settle = (
      code: number | null,
      signal: NodeJS.Signals | null,
      forced: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      if (escalate !== undefined) clearTimeout(escalate);
      input.signal.removeEventListener("abort", cancel);
      resolve({ code, signal, forced });
    };
    function cancel(): void {
      killTree("SIGINT");
      escalate = setTimeout(() => {
        killTree("SIGKILL");
        settle(null, "SIGKILL", true);
      }, browserCancelGraceMs);
    }
    child.once("error", (error) => {
      console.error(`浏览器场景子进程无法启动：${error.message}`);
      settle(null, null, false);
    });
    child.once("exit", (code, signal) => settle(code, signal, false));
    if (input.signal.aborted) cancel();
    else input.signal.addEventListener("abort", cancel, { once: true });
  });
  const entry = {
    phase: "browser",
    cwd: webPackageRoot,
    argv: [process.execPath, playwrightCli, ...argv],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: exit.code,
    signal: exit.signal,
    cancelled: input.signal.aborted,
    stdoutTail: "",
    stderrTail: "",
  };
  try {
    await input.journal.record(entry);
  } catch (error) {
    input.saveErrors.push({
      stage: "journal",
      target: "commands.ndjson",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    exitCode: exit.code,
    signal: exit.signal,
    cancelled: exit.forced,
    outputDirectory: input.outputDirectory,
  };
}

/** 逐个复制登记的日志；失败不再被吞掉，现存载体保留，未保存文件与原因单列。 */
async function copyLogs(
  files: readonly string[],
  targetDirectory: string,
): Promise<{ copied: string[]; failures: SaveError[] }> {
  const copied: string[] = [];
  const failures: SaveError[] = [];
  try {
    await mkdir(targetDirectory, { recursive: true });
  } catch (error) {
    failures.push({
      stage: "logDirectory",
      target: targetDirectory,
      message: describeError(error),
    });
  }
  for (const file of new Set(files)) {
    // 不同世代/阶段会给出同名文件（operation.log 等），用上一级目录名前缀保持每份诊断各自可见。
    const owner = path.basename(path.dirname(file));
    const target = path.join(
      targetDirectory,
      owner.length === 0 ? file : `${owner}--${path.basename(file)}`,
    );
    try {
      await copyFile(file, target);
      copied.push(target);
    } catch (error) {
      failures.push({
        stage: "logCopy",
        target: file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { copied, failures };
}

function logFilesOf(result: LifecycleResult): string[] {
  const logs = result.record.logs;
  if (logs === null || typeof logs !== "object" || Array.isArray(logs))
    return [];
  const files = (logs as Record<string, unknown>).files;
  return Array.isArray(files)
    ? files.filter((f): f is string => typeof f === "string")
    : [];
}

function failureOf(result: LifecycleResult, phase: string): Failure {
  const failure = result.record.failure;
  const detail =
    failure !== null && typeof failure === "object" && !Array.isArray(failure)
      ? (failure as Record<string, unknown>)
      : {};
  const run = nestedRun(result.record);
  const lastFailure =
    run.lastFailure !== null && typeof run.lastFailure === "object"
      ? (run.lastFailure as Record<string, unknown>)
      : {};
  return {
    phase,
    stage:
      typeof detail.stage === "string"
        ? detail.stage
        : statusFact(lastFailure, ["stage"]),
    message:
      typeof detail.message === "string"
        ? detail.message
        : statusFact(result.record, ["status", "reason"]),
    exitCode: result.exitCode,
  };
}

function cleanupErrorsOf(result: LifecycleResult, phase: string): string[] {
  const cleanup = result.record.cleanup;
  if (cleanup === null || typeof cleanup !== "object" || Array.isArray(cleanup))
    return [];
  const errors = (cleanup as Record<string, unknown>).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((error): error is string => typeof error === "string")
    .map((error) => `${phase}: ${error}`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const journal = fileCommandJournal(
    path.join(options.artifactsDirectory, "commands.ndjson"),
  );
  await mkdir(options.artifactsDirectory, { recursive: true });
  // 每次运行都有独立的浏览器诊断目录；后续运行不会覆盖或清空前一次的 trace。
  const browserOutputDirectory = path.join(
    options.artifactsDirectory,
    "browser",
  );
  const logsDirectory = path.join(options.artifactsDirectory, "logs");
  const outcomePath = path.join(options.artifactsDirectory, "outcome.json");
  const cancellation = new AbortController();
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = true;
    console.error(
      `收到 ${signal}：取消正在运行的浏览器场景，随后仍独立执行自有环境收尾。`,
    );
    cancellation.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const outcome: Record<string, unknown> = {
    mode: options.mode,
    environment: options.environment,
    workspacePath: options.workspacePath,
    startedAt: new Date().toISOString(),
    lifecycleCalls: [] as string[],
    browserDiagnosticsDirectory: browserOutputDirectory,
  };
  let mainError: Failure | null = null;
  const cleanupErrors: string[] = [];
  const saveErrors: SaveError[] = [];
  let baseUrl = "";
  let productDataRoot = "";
  let retainedLogs: string[] = [];
  let readyConfirmation: Record<string, unknown> | undefined;
  let ownerConfirmation: Record<string, unknown> | undefined;
  let startedRun: Record<string, unknown> = {};
  let serviceStartTimeTicks = "未取得 PID";
  let browserStartTimeTicks = "未取得 PID";
  let browser:
    | {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        cancelled: boolean;
        outputDirectory: string;
      }
    | undefined;
  const lifecycleLogFiles: string[] = [];
  // 只有真正取得过的资源才需要收尾；未准备好的环境不能折算成清理失败。
  let environmentPrepared = false;
  let serviceStartAttempted = false;

  const lifecycle = async (
    phase: "prepare" | "start" | "stop" | "inspect" | "delete",
    extra: readonly string[] = [],
    bounded: boolean = true,
  ): Promise<LifecycleResult | undefined> => {
    const record = await runCommand({
      phase,
      command: process.execPath,
      args: [
        environmentCliPath,
        phase,
        "--environment",
        options.environment,
        "--workspace-path",
        options.workspacePath,
        ...extra,
        "--output-format",
        "structured",
      ],
      cwd: options.workspacePath,
      // 有界等待跟随取消信号；收尾调用使用独立时限，取消后仍可观察与回收自有环境。
      signal: bounded ? cancellation.signal : AbortSignal.timeout(180_000),
      journal,
    });
    (outcome.lifecycleCalls as string[]).push(phase);
    if (record.journalError !== undefined) {
      // journal 记账失败单列为保存错误：已取得的公开生命周期结果照常可用，不折算成清理失败。
      saveErrors.push({
        stage: "journal",
        target: "commands.ndjson",
        message: `${phase}：${record.journalError}`,
      });
    }
    try {
      const result = lifecycleResult(record);
      lifecycleLogFiles.push(...logFilesOf(result));
      return result;
    } catch (error) {
      mainError ??= {
        phase,
        stage: "envelope",
        message: describeError(error),
        exitCode: record.exitCode,
      };
      return undefined;
    }
  };

  const logSourceFiles = (observed: LifecycleResult | undefined): string[] =>
    [
      ...new Set([
        ...lifecycleLogFiles,
        statusFact(nestedRun(observed?.record ?? {}), [
          "productLogFile",
          "productLog",
          "logFile",
        ]),
        statusFact(startedRun, ["productLogFile", "productLog", "logFile"]),
      ]),
    ].filter((file) => file.length > 0);

  console.log(`验收模式：${options.mode}；环境名：${options.environment}`);

  // 取得环境与执行链路：任何一处抛出的异常都折算成主错误，不再跳过后续收尾。
  try {
    if (options.mode === "owned") {
      const port = await claimFreePort();
      await appendLedger(options.ledgerPath, {
        event: "intent",
        mode: options.mode,
        workspacePath: options.workspacePath,
        environment: options.environment,
        port,
        note: "端口经真实 bind 探测确认空闲；运行身份与 PID 在随后的 start 结果里登记",
      });
      outcome.port = port;
      const prepared = await lifecycle("prepare", [
        "--input",
        options.materialDirectory,
        "--source-mode",
        options.sourceMode,
        "--config-json",
        JSON.stringify({
          webPort: port,
          sourceIo: {
            manifestPath: options.manifestPath,
            contentIdentity: options.contentIdentity,
          },
        }),
        "--timeout-ms",
        String(options.prepareTimeoutMs),
      ]);
      if (prepared === undefined || prepared.status !== "prepared") {
        mainError ??=
          prepared === undefined
            ? {
                phase: "prepare",
                stage: "envelope",
                message: "准备调用没有返回结构化结果",
                exitCode: null,
              }
            : failureOf(prepared, "prepare");
        if (prepared !== undefined)
          cleanupErrors.push(...cleanupErrorsOf(prepared, "prepare"));
      } else {
        environmentPrepared = true;
        productDataRoot = requireFact(
          statusFact(
            (prepared.record.environment as Record<string, unknown>) ?? {},
            ["productDataRoot", "productDataDirectory"],
          ) ||
            statusFact(prepared.record, [
              "productDataRoot",
              "productDataDirectory",
            ]),
          "准备结果里的产品数据根",
        );
        serviceStartAttempted = true;
        const started = await lifecycle("start", [
          "--timeout-ms",
          String(options.startTimeoutMs),
        ]);
        const startedRunRecord = nestedRun(started?.record ?? {});
        const servicePid = startedRunRecord["pid"];
        const knownServicePid =
          typeof servicePid === "number" && Number.isInteger(servicePid)
            ? servicePid
            : undefined;
        serviceStartTimeTicks = processStartTimeTicks(knownServicePid);
        await appendLedger(options.ledgerPath, {
          event: "result",
          mode: options.mode,
          workspacePath: options.workspacePath,
          environment: options.environment,
          port,
          phase: "start",
          status: started?.status ?? "no-result",
          run: startedRunRecord,
          runId: startedRunRecord["runId"] ?? null,
          pid: knownServicePid ?? null,
          startTimeTicks: serviceStartTimeTicks,
          exitCode: started?.exitCode ?? null,
        });
        if (
          started === undefined ||
          (started.status !== "ready" && started.status !== "already-ready")
        ) {
          mainError ??=
            started === undefined
              ? {
                  phase: "start",
                  stage: "envelope",
                  message: "启动调用没有返回结构化结果",
                  exitCode: null,
                }
              : failureOf(started, "start");
          if (started !== undefined)
            cleanupErrors.push(...cleanupErrorsOf(started, "start"));
        } else {
          const run = nestedRun(started.record);
          startedRun = run;
          const address = statusFact(run, ["address", "baseUrl"]);
          baseUrl = /^https?:/u.test(address) ? address : `http://${address}`;
          readyConfirmation = await readReady(baseUrl);
          outcome.run = run;
          outcome.baseUrl = baseUrl;
        }
      }
    } else {
      if (options.baseUrl === undefined)
        throw new Error("provided 模式必须给出 --base-url");
      baseUrl = options.baseUrl;
      readyConfirmation = await awaitProductReady(baseUrl, 120_000);
      const settings = await fetch(new URL("/api/settings", baseUrl), {
        signal: AbortSignal.timeout(30_000),
      });
      const snapshot = (await settings.json()) as Record<string, unknown>;
      productDataRoot = requireFact(
        statusFact(snapshot, ["productDataDirectory", "productDataRoot"]),
        "外部服务自报的产品数据根",
      );
      outcome.baseUrl = baseUrl;
    }
  } catch (error) {
    mainError ??= {
      phase: options.mode === "owned" ? "lifecycle" : "provided",
      stage: "exception",
      message: describeError(error),
      exitCode: null,
    };
  }

  const ready =
    readyConfirmation !== undefined &&
    readyConfirmation.status === 200 &&
    String(readyConfirmation.body).includes('"ok":true');

  if (baseUrl !== "" && ready) {
    const handoffPath = path.join(options.artifactsDirectory, "handoff.json");
    const handoff = {
      mode: options.mode,
      baseUrl,
      environment: options.environment,
      workspacePath: options.workspacePath,
      productDataRoot,
      materialDirectory: options.materialDirectory,
      manifestPath: options.manifestPath,
      contentIdentity: options.contentIdentity,
      ...(options.mode === "owned"
        ? { sourceMode: options.sourceMode }
        : { sourceMode: "由外部服务自行决定" }),
      productLogFile: statusFact(startedRun, [
        "productLogFile",
        "productLog",
        "logFile",
      ]),
      run: startedRun,
      ledgerPath: options.ledgerPath,
      artifactsDirectory: options.artifactsDirectory,
      browserOutputDirectory,
    };
    try {
      await writeFile(
        handoffPath,
        `${JSON.stringify(handoff, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      const failure: SaveError = {
        stage: "handoff",
        target: handoffPath,
        message: describeError(error),
      };
      saveErrors.push(failure);
      mainError ??= {
        phase: "handoff",
        stage: "save",
        message: `无法写出真实服务交接记录，浏览器场景没有可连接的地址：${failure.message}`,
        exitCode: null,
      };
    }
    if (mainError === null) {
      try {
        browser = await runBrowserScenario({
          handoffPath,
          baseUrl,
          spec:
            options.mode === "owned"
              ? productChainSpec
              : providedVerificationSpec,
          journal,
          outputDirectory: browserOutputDirectory,
          signal: cancellation.signal,
          saveErrors,
          onPid: (pid) => {
            outcome.browserPid = pid ?? null;
            browserStartTimeTicks = processStartTimeTicks(pid);
          },
        });
        if (browser.exitCode !== 0)
          mainError = {
            phase: "browser",
            stage: "scenario",
            message: `浏览器产品链路未通过（退出码 ${String(browser.exitCode)}，信号 ${String(browser.signal)}）`,
            exitCode: browser.exitCode,
          };
      } catch (error) {
        mainError ??= {
          phase: "browser",
          stage: "exception",
          message: describeError(error),
          exitCode: null,
        };
      }
    }
  } else if (mainError === null && baseUrl !== "") {
    mainError = {
      phase: "readiness",
      stage: "ready",
      message: `产品未通过 ${readyPath} 就绪确认：${JSON.stringify(readyConfirmation)}`,
      exitCode: null,
    };
  } else if (mainError === null) {
    mainError = {
      phase: "readiness",
      stage: "unreachable",
      message: `没有可用的服务地址，无法进行 ${readyPath} 就绪确认`,
      exitCode: null,
    };
  }

  const executionSucceeded = mainError === null && !interrupted;

  const summarizeObserved = (
    observed: LifecycleResult | undefined,
  ): Record<string, unknown> =>
    observed === undefined
      ? {}
      : {
          status: observed.status,
          state: observed.record["state"] ?? null,
          serviceReadiness: observed.record["serviceReadiness"] ?? null,
          run: nestedRun(observed.record),
        };

  /** 把执行结果与要求的证据落到本票证据目录；失败逐项累积，不静默降级。 */
  const saveExecutionEvidence = async (): Promise<{ copied: string[] }> => {
    const logCopy = await copyLogs(logSourceFiles(undefined), logsDirectory);
    saveErrors.push(...logCopy.failures);
    retainedLogs = [...new Set([...retainedLogs, ...logCopy.copied])];
    try {
      await appendLedger(options.ledgerPath, {
        event: "execution",
        mode: options.mode,
        workspacePath: options.workspacePath,
        environment: options.environment,
        port: outcome.port ?? null,
        baseUrl: outcome.baseUrl ?? null,
        runId: startedRun["runId"] ?? null,
        servicePid: startedRun["pid"] ?? null,
        serviceStartTimeTicks,
        browserPid: outcome.browserPid ?? null,
        browserStartTimeTicks,
        succeeded: executionSucceeded,
        interrupted,
        mainError,
        browser,
        browserDiagnosticsDirectory: browserOutputDirectory,
        retainedLogs,
      });
    } catch (error) {
      saveErrors.push({
        stage: "ledger",
        target: options.ledgerPath,
        message: describeError(error),
      });
    }
    await writeOutcome("execution");
    return { copied: logCopy.copied };
  };

  const writeOutcome = async (stage: string): Promise<void> => {
    outcome.finishedAt = new Date().toISOString();
    outcome.interrupted = interrupted;
    outcome.browser = browser;
    outcome.mainError = mainError;
    outcome.cleanupErrors = cleanupErrors;
    outcome.saveErrors = saveErrors;
    outcome.readyConfirmation = readyConfirmation;
    outcome.ownerConfirmation = ownerConfirmation;
    outcome.execution = {
      succeeded: executionSucceeded,
      interrupted,
    };
    outcome.retention = {
      dataRetained,
      serviceLeftRunning,
      reclaimed,
      ownerPreserved,
      productDataRoot,
      retainedLogs,
      keepOnSuccess: options.keepOnSuccess,
      browserDiagnosticsDirectory: browserOutputDirectory,
    };
    try {
      await writeFile(
        outcomePath,
        `${JSON.stringify(outcome, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      saveErrors.push({
        stage: `outcome:${stage}`,
        target: outcomePath,
        message: describeError(error),
      });
    }
  };

  let dataRetained = false;
  let serviceLeftRunning = false;
  let reclaimed = false;
  const ownerPreserved = options.mode === "provided";

  // 先保存执行结果与证据，再停止/删除自有资源。
  // 收尾序列自身的异常也必须留下可辨认的记录，不能把自有服务丢成无人认领的活进程。
  try {
    if (options.mode === "owned") {
      const evidence = await saveExecutionEvidence();
      dataRetained = evidence.copied.length > 0 || !executionSucceeded;

      if (!environmentPrepared) {
        // 环境从未建立（端口占用、准备调用失败或早期异常）：没有自有资源需要收尾。
        ownerConfirmation = { note: "没有取得自有环境，无需停止或删除" };
      } else if (!serviceStartAttempted) {
        // 准备好但从未启动：保留可显式重启的数据载体，不谎报清理成功。
        dataRetained = true;
        const observed = await lifecycle("inspect", [], false);
        ownerConfirmation = summarizeObserved(observed);
      } else if (executionSucceeded && options.keepOnSuccess) {
        // 调用方有意把自己拥有的服务留作外部提供方便：不调用 stop/delete，只如实记录实况。
        serviceLeftRunning = true;
        dataRetained = true;
        const observed = await lifecycle("inspect", [], false);
        ownerConfirmation = summarizeObserved(observed);
      } else {
        const stopped = await lifecycle("stop", [], false);
        if (stopped !== undefined)
          cleanupErrors.push(...cleanupErrorsOf(stopped, "stop"));
        const unconfirmed =
          stopped === undefined ||
          stopped.status === "not-confirmed" ||
          (stopped.status !== "stopped" &&
            stopped.status !== "already-stopped");
        if (unconfirmed)
          cleanupErrors.push(
            stopped === undefined
              ? "stop 没有返回结构化结果"
              : `stop 返回 ${stopped.status}：停止未确认，现场按未知存活如实保留`,
          );
        const observed = await lifecycle("inspect", [], false);
        ownerConfirmation = summarizeObserved(observed);
        const observedRun =
          (ownerConfirmation?.run as Record<string, unknown> | undefined) ?? {};
        const liveness = statusFact(observedRun, ["processLiveness"]);
        const readiness = statusFact(observed?.record ?? {}, [
          "serviceReadiness",
        ]);
        // 停止后服务还会写入收尾日志；在删除载体之前再补一次复制。
        const tailCopy = await copyLogs(
          logSourceFiles(observed),
          logsDirectory,
        );
        saveErrors.push(...tailCopy.failures);
        retainedLogs = [...new Set([...retainedLogs, ...tailCopy.copied])];

        if (!executionSucceeded) {
          // 失败：停止自有服务，保留可显式重启的产品数据与完整脱敏日志。
          dataRetained = true;
        } else if (saveErrors.length > 0) {
          // 证据保存失败：只停止自有服务，不删除任何证据载体，保存失败单列。
          dataRetained = true;
        } else if (unconfirmed) {
          dataRetained = true;
        } else if (liveness !== "exited" && liveness !== "absent") {
          cleanupErrors.push(
            `独立退出确认未通过：进程存活 ${liveness || "未知"}`,
          );
          dataRetained = true;
        } else if (readiness === "ready") {
          cleanupErrors.push("独立退出确认未通过：服务仍报告就绪");
          dataRetained = true;
        } else {
          const deleted = await lifecycle("delete", [], false);
          if (deleted !== undefined)
            cleanupErrors.push(...cleanupErrorsOf(deleted, "delete"));
          if (
            deleted === undefined ||
            (deleted.status !== "deleted" &&
              deleted.status !== "already-deleted")
          ) {
            cleanupErrors.push(
              deleted === undefined
                ? "delete 没有返回结构化结果"
                : `delete 返回 ${deleted.status}`,
            );
            dataRetained = true;
          } else {
            reclaimed = true;
            dataRetained = false;
            const afterDelete = await lifecycle("inspect", [], false);
            ownerConfirmation = {
              ...summarizeObserved(observed),
              afterDelete: summarizeObserved(afterDelete),
            };
          }
        }
      }
    } else {
      await saveExecutionEvidence();
      ownerConfirmation = {
        lifecycleCalls: (outcome.lifecycleCalls as string[]).length,
        readyAfterRun:
          baseUrl === ""
            ? { status: 0, body: "没有可用的服务地址，提供方实况未观察" }
            : await awaitProductReady(baseUrl, 10_000),
      };
    }
  } catch (error) {
    cleanupErrors.push(`收尾阶段异常：${describeError(error)}`);
    dataRetained = true;
    try {
      if (
        options.mode === "owned" &&
        environmentPrepared &&
        serviceStartAttempted
      ) {
        // 兜底：收尾序列中断时仍要对自己的服务给出一次停止调用，实况由 inspect 记录。
        const lastResort = await lifecycle("stop", [], false);
        cleanupErrors.push(
          lastResort === undefined
            ? "兜底 stop 没有返回结构化结果：自有服务实况未知"
            : `兜底 stop 返回 ${lastResort.status}`,
        );
        ownerConfirmation ??= summarizeObserved(
          await lifecycle("inspect", [], false),
        );
      }
    } catch (fallbackError) {
      // 兜底自身再失败也如实入账：异常不能穿透到最终 ledger/outcome 与退出分类之前。
      cleanupErrors.push(`兜底收尾自身异常：${describeError(fallbackError)}`);
    }
  }

  // 收尾结果单独入账：执行成功与停止、删除、证据保存失败必须分别可辨。
  if (options.mode === "owned") {
    try {
      await appendLedger(options.ledgerPath, {
        event: "outcome",
        mode: options.mode,
        environment: options.environment,
        port: outcome.port ?? null,
        executionSucceeded,
        interrupted,
        dataRetained,
        serviceLeftRunning,
        reclaimed,
        mainError,
        cleanupErrors,
        saveErrors,
      });
    } catch (error) {
      saveErrors.push({
        stage: "ledger:outcome",
        target: options.ledgerPath,
        message: describeError(error),
      });
    }
  } else {
    try {
      await appendLedger(options.ledgerPath, {
        event: "outcome",
        mode: options.mode,
        baseUrl,
        executionSucceeded,
        interrupted,
        lifecycleCalls: (outcome.lifecycleCalls as string[]).length,
        ownerPreserved,
        mainError,
        saveErrors,
      });
    } catch (error) {
      saveErrors.push({
        stage: "ledger:outcome",
        target: options.ledgerPath,
        message: describeError(error),
      });
    }
  }
  await writeOutcome("final");

  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  if (interrupted) return 3;
  if (!executionSucceeded) return 1;
  if (cleanupErrors.length > 0) return 4;
  if (saveErrors.length > 0) return 5;
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(describeError(error));
    process.exitCode = 2;
  });
