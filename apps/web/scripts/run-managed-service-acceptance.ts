import { spawn } from "node:child_process";
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
const productChainSpec = "test/e2e/managed-service-product-chain.spec.ts";
const providedVerificationSpec =
  "test/e2e/provided-service-verification.spec.ts";
const readyPath = "/api/ready";

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
    environment: flags.get("environment") ?? `t12-${mode}-${stamp}`,
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

async function runBrowserScenario(input: {
  readonly handoffPath: string;
  readonly baseUrl: string;
  readonly spec: string;
  readonly journal: ReturnType<typeof fileCommandJournal>;
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      ["exec", "playwright", "test", input.spec, "--reporter=list"],
      {
        cwd: webPackageRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          PLAYWRIGHT_EXTERNAL_BASE_URL: input.baseUrl,
          DIGITAL_ACCEPTANCE_HANDOFF: input.handoffPath,
        },
      },
    );
    const startedAt = new Date().toISOString();
    child.once("exit", async (exitCode, signal) => {
      await input.journal.record({
        phase: "browser",
        cwd: webPackageRoot,
        argv: ["pnpm", "exec", "playwright", "test", input.spec],
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        signal,
        cancelled: false,
        stdoutTail: "",
        stderrTail: "",
      });
      resolve({ exitCode, signal });
    });
  });
}

async function copyLogs(
  files: readonly string[],
  targetDirectory: string,
): Promise<string[]> {
  const copied = new Set<string>();
  await mkdir(targetDirectory, { recursive: true });
  for (const file of new Set(files)) {
    // 不同世代/阶段会给出同名文件（operation.log 等），用上一级目录名前缀保持每份诊断各自可见。
    const owner = path.basename(path.dirname(file));
    const target = path.join(
      targetDirectory,
      owner.length === 0 ? file : `${owner}--${path.basename(file)}`,
    );
    try {
      await copyFile(file, target);
      copied.add(target);
    } catch {
      // 日志文件可能已被管理器的收尾回收，保留已成功复制的部分。
    }
  }
  return [...copied];
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

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const journal = fileCommandJournal(
    path.join(options.artifactsDirectory, "commands.ndjson"),
  );
  await mkdir(options.artifactsDirectory, { recursive: true });
  const cancellation = new AbortController();
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    interrupted = true;
    console.error(`收到 ${signal}，只取消本次调用方的有界等待。`);
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
    mainError: null,
    cleanupErrors: [] as string[],
  };
  let mainError: Failure | null = null;
  const cleanupErrors: string[] = [];
  let baseUrl = "";
  let productDataRoot = "";
  let retainedLogs: string[] = [];
  let readyConfirmation: Record<string, unknown> | undefined;
  let ownerConfirmation: Record<string, unknown> | undefined;
  let startedRun: Record<string, unknown> = {};
  let browser:
    | { exitCode: number | null; signal: NodeJS.Signals | null }
    | undefined;
  const lifecycleLogFiles: string[] = [];

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
    try {
      const result = lifecycleResult(record);
      lifecycleLogFiles.push(...logFilesOf(result));
      return result;
    } catch (error) {
      mainError ??= {
        phase,
        stage: "envelope",
        message: error instanceof Error ? error.message : String(error),
        exitCode: record.exitCode,
      };
      return undefined;
    }
  };

  console.log(`验收模式：${options.mode}；环境名：${options.environment}`);

  if (options.mode === "owned") {
    const port = await claimFreePort();
    await appendLedger(options.ledgerPath, {
      event: "intent",
      mode: options.mode,
      workspacePath: options.workspacePath,
      environment: options.environment,
      port,
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
      const started = await lifecycle("start", [
        "--timeout-ms",
        String(options.startTimeoutMs),
      ]);
      await appendLedger(options.ledgerPath, {
        event: "result",
        mode: options.mode,
        environment: options.environment,
        port,
        phase: "start",
        status: started?.status ?? "no-result",
        run: nestedRun(started?.record ?? {}),
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
    };
    await writeFile(
      handoffPath,
      `${JSON.stringify(handoff, null, 2)}\n`,
      "utf8",
    );
    if (mainError === null) {
      browser = await runBrowserScenario({
        handoffPath,
        baseUrl,
        spec:
          options.mode === "owned"
            ? productChainSpec
            : providedVerificationSpec,
        journal,
      });
      if (browser.exitCode !== 0)
        mainError = {
          phase: "browser",
          stage: "scenario",
          message: `浏览器产品链路未通过（退出码 ${String(browser.exitCode)}，信号 ${String(browser.signal)}）`,
          exitCode: browser.exitCode,
        };
    }
  } else if (mainError === null) {
    mainError = {
      phase: "readiness",
      stage: "ready",
      message: `产品未通过 ${readyPath} 就绪确认：${JSON.stringify(readyConfirmation)}`,
      exitCode: null,
    };
  }

  const succeeded = mainError === null && !interrupted;
  let dataRetained = false;
  let serviceLeftRunning = false;
  let reclaimed = false;
  const ownerPreserved = options.mode === "provided";

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

  const retainLogs = async (
    observed: LifecycleResult | undefined,
  ): Promise<void> => {
    dataRetained = true;
    retainedLogs = await copyLogs(
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
      ].filter((file) => file.length > 0),
      path.join(options.artifactsDirectory, "logs"),
    );
  };

  if (options.mode === "owned") {
    if (succeeded && options.keepOnSuccess) {
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
        (stopped.status !== "stopped" && stopped.status !== "already-stopped");
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
      if (!succeeded) {
        // 失败：保留可重启的产品数据与完整脱敏日志，主错误与清理错误分别可见。
        await retainLogs(observed);
      } else if (unconfirmed) {
        await retainLogs(observed);
      } else if (liveness !== "exited" && liveness !== "absent") {
        cleanupErrors.push(
          `独立退出确认未通过：进程存活 ${liveness || "未知"}`,
        );
        await retainLogs(observed);
      } else if (readiness === "ready") {
        cleanupErrors.push("独立退出确认未通过：服务仍报告就绪");
        await retainLogs(observed);
      } else {
        const deleted = await lifecycle("delete", [], false);
        if (deleted !== undefined)
          cleanupErrors.push(...cleanupErrorsOf(deleted, "delete"));
        if (
          deleted === undefined ||
          (deleted.status !== "deleted" && deleted.status !== "already-deleted")
        ) {
          cleanupErrors.push(
            deleted === undefined
              ? "delete 没有返回结构化结果"
              : `delete 返回 ${deleted.status}`,
          );
          await retainLogs(observed);
        } else {
          reclaimed = true;
          const afterDelete = await lifecycle("inspect", [], false);
          ownerConfirmation = {
            ...summarizeObserved(observed),
            afterDelete: summarizeObserved(afterDelete),
          };
        }
      }
    }
    await appendLedger(options.ledgerPath, {
      event: "outcome",
      mode: options.mode,
      environment: options.environment,
      port: outcome.port ?? null,
      succeeded,
      dataRetained,
      serviceLeftRunning,
      reclaimed,
      mainError,
      cleanupErrors,
    });
  } else {
    const afterRun = await awaitProductReady(baseUrl, 10_000);
    ownerConfirmation = {
      lifecycleCalls: (outcome.lifecycleCalls as string[]).length,
      readyAfterRun: afterRun,
    };
    await appendLedger(options.ledgerPath, {
      event: "outcome",
      mode: options.mode,
      baseUrl,
      succeeded,
      lifecycleCalls: (outcome.lifecycleCalls as string[]).length,
      mainError,
    });
  }

  outcome.finishedAt = new Date().toISOString();
  outcome.interrupted = interrupted;
  outcome.browser = browser;
  outcome.mainError = mainError;
  outcome.cleanupErrors = cleanupErrors;
  outcome.readyConfirmation = readyConfirmation;
  outcome.ownerConfirmation = ownerConfirmation;
  outcome.retention = {
    dataRetained,
    serviceLeftRunning,
    reclaimed,
    ownerPreserved,
    productDataRoot,
    retainedLogs,
    keepOnSuccess: options.keepOnSuccess,
  };
  await writeFile(
    path.join(options.artifactsDirectory, "outcome.json"),
    `${JSON.stringify(outcome, null, 2)}\n`,
    "utf8",
  );
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  if (succeeded) return 0;
  if (interrupted) return 3;
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
