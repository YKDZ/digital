import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  mergeCommandEnvironment,
  prepareScenarioEnvironment,
  recycleOwnedEnvironment,
  reserveFreePort,
  retainProvidedEnvironment,
  scenarioEnvironmentName,
  scenarioRunId,
  type AcceptanceEnvironment,
  type OwnedRecycling,
  type ProvidedEnvironment,
  type ScenarioSource,
} from "./environment-runtime.ts";
import type {
  CliJourney,
  CliJourneyCommand,
  CliJourneyContext,
  CliJourneyMode,
  CliJourneyResult,
} from "./journey.ts";

const e2eRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(e2eRoot, "..", "..");
const workspaceRoot = path.resolve(packageRoot, "..", "..");

function assertNever(value: never): never {
  throw new Error(`unsupported journey mode: ${String(value)}`);
}

type JourneyRunTarget = {
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
};

const journeyRunnerUsage = [
  "Usage:",
  "  run-journeys.ts <source|distribution> [source|distribution ...]",
  "  run-journeys.ts packed <bin-path>",
].join("\n");

function invalidArguments(message: string): never {
  throw new Error(`${message}\n${journeyRunnerUsage}`);
}

const privateEnvironmentName = /(?:TOKEN|KEY|SECRET|OAUTH|COOKIE|CREDENTIAL)/iu;

function privateValues(
  commands: readonly CliJourneyCommand[],
): readonly string[] {
  return [
    ...new Set(
      commands.flatMap((command) =>
        Object.entries(command.env ?? {}).flatMap(([name, value]) =>
          privateEnvironmentName.test(name) && value.trim().length > 0
            ? [value]
            : [],
        ),
      ),
    ),
  ].toSorted((left, right) => right.length - left.length);
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 绝不让旅程配置的凭据值进入失败诊断。 */
export function redactJourneyDiagnostic(
  value: string,
  commands: readonly CliJourneyCommand[],
): string {
  let redacted = value;
  for (const privateValue of privateValues(commands)) {
    redacted = redacted.replaceAll(
      new RegExp(escaped(privateValue), "gu"),
      "[REDACTED]",
    );
  }
  return redacted
    .replace(/(Bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(
      /([?&;](?:api[-_]?key|token|key|secret|oauth|cookie|credential)=[^&\s;]+)/giu,
      "[REDACTED]",
    )
    .replace(
      /((?:authorization|cookie)\s*:\s*(?:Bearer\s+)?)[^\s]+/giu,
      "$1[REDACTED]",
    );
}

function diagnosticText(
  value: string,
  commands: readonly CliJourneyCommand[],
): string {
  const redacted = redactJourneyDiagnostic(value, commands);
  const limit = 2_000;
  return redacted.length <= limit
    ? redacted
    : `${redacted.slice(0, limit)}\n… ${redacted.length - limit} diagnostic characters omitted`;
}

/**
 * 某些实时命令会生成后续每条命令都需要的标识符。如果其中一项前置条件失败，
 * 应显示其自身的安全诊断，而不是让依赖命令在解码缺失标识符时失败。
 */
export function assertHaltedJourneyCommand(
  command: CliJourneyCommand,
  result: CliJourneyResult,
): void {
  if (command.haltOnFailure !== true || result.exitCode === 0) return;
  throw new Error(
    `${result.commandName} failed with exit ${result.exitCode}\nstdout: ${diagnosticText(result.stdout, [command])}\nstderr: ${diagnosticText(result.stderr, [command])}`,
  );
}

export function formatJourneyAssertionFailure(input: {
  readonly mode: CliJourneyMode;
  readonly journeyName: string;
  readonly commands: readonly CliJourneyCommand[];
  readonly results: readonly CliJourneyResult[];
  readonly error: unknown;
}): Error {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  const sanitizedMessage = redactJourneyDiagnostic(message, input.commands);
  const sanitizedCause = new Error(sanitizedMessage);
  return new Error(
    `${input.mode}:${input.journeyName} assertion failed\n${input.results
      .map((result, index) => {
        const command = input.commands[index];
        return `${result.commandName}: exit ${result.exitCode}\nstdout: ${diagnosticText(result.stdout, command === undefined ? input.commands : [command])}\nstderr: ${diagnosticText(result.stderr, command === undefined ? input.commands : [command])}`;
      })
      .join("\n")}` + `\n${sanitizedMessage}`,
    { cause: sanitizedCause },
  );
}

function parseJourneyRunTargets(
  args: readonly string[],
): readonly JourneyRunTarget[] {
  const first = args[0];
  if (first === undefined) {
    invalidArguments("missing journey mode");
  }

  if (first === "packed") {
    if (args.length === 1) {
      invalidArguments("packed journey mode requires exactly one bin path");
    }
    if (args.length !== 2) {
      invalidArguments(
        "packed journey mode accepts exactly one bin path and cannot be combined with other modes",
      );
    }
    const packedBin = args[1]!;
    if (
      packedBin === "source" ||
      packedBin === "distribution" ||
      packedBin === "packed"
    ) {
      invalidArguments(
        `packed bin path cannot be journey mode ${JSON.stringify(packedBin)}`,
      );
    }
    return [{ mode: "packed", packedBin }];
  }

  const seen = new Set<CliJourneyMode>();
  const targets: JourneyRunTarget[] = [];
  for (const argument of args) {
    switch (argument) {
      case "source":
      case "distribution":
        if (seen.has(argument)) {
          invalidArguments(
            `duplicate journey mode ${JSON.stringify(argument)}; each mode may be specified once`,
          );
        }
        seen.add(argument);
        targets.push({ mode: argument });
        break;
      case "packed":
        invalidArguments(
          "packed journey mode cannot be combined with source or distribution",
        );
      default:
        invalidArguments(
          `unknown journey mode ${JSON.stringify(argument)}; expected source, distribution, or packed`,
        );
    }
  }
  return targets;
}

async function discoverJourneys(): Promise<readonly CliJourney[]> {
  const journeyRoot = path.join(e2eRoot, "journeys");
  const entries = await readdir(journeyRoot, { withFileTypes: true });
  const journeyFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".journey.ts") ||
          entry.name.endsWith(".journey.js")),
    )
    .map((entry) => entry.name)
    .toSorted();
  const journeys = await Promise.all(
    journeyFiles.map(async (fileName) => {
      const loaded = (await import(
        pathToFileURL(path.join(journeyRoot, fileName)).href
      )) as { default: CliJourney };
      return loaded.default;
    }),
  );
  const selection = process.env.DIGITAL_E2E_JOURNEY;
  if (selection === undefined) return journeys;
  const selected = journeys.filter((journey) => journey.name === selection);
  if (selected.length === 0)
    throw new Error(`unknown DIGITAL_E2E_JOURNEY ${JSON.stringify(selection)}`);
  return selected;
}

function invocation(
  mode: CliJourneyMode,
  packedBin: string | undefined,
): { readonly executable: string; readonly prefix: readonly string[] } {
  switch (mode) {
    case "source":
      return {
        executable: process.execPath,
        prefix: [
          "--conditions=digital-source",
          path.join(packageRoot, "src", "cli.ts"),
        ],
      };
    case "distribution":
      return {
        executable: process.execPath,
        prefix: [path.join(packageRoot, "dist", "cli.js")],
      };
    case "packed":
      if (packedBin === undefined) {
        throw new Error(
          "packed journey mode requires a package-manager bin path",
        );
      }
      return { executable: packedBin, prefix: [] };
    default:
      return assertNever(mode);
  }
}

async function runCommand(options: {
  readonly mode: CliJourneyMode;
  readonly packedBin: string | undefined;
  readonly command: CliJourneyCommand;
  readonly previousResults: readonly CliJourneyResult[];
  readonly cwd: string;
  /** 正式 CLI 子进程的环境完全来自本次场景环境；不继承父终端。 */
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}): Promise<CliJourneyResult> {
  const target = invocation(options.mode, options.packedBin);
  const args =
    typeof options.command.args === "function"
      ? options.command.args(options.previousResults)
      : options.command.args;
  return await new Promise((resolve, reject) => {
    const child = spawn(target.executable, [...target.prefix, ...args], {
      cwd: options.cwd,
      env: options.environment,
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
    const signal = options.signal;
    if (signal !== undefined) {
      const abort = () => {
        child.kill("SIGINT");
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      child.once("close", () => {
        signal.removeEventListener("abort", abort);
      });
    }
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        commandName: options.command.name,
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

type JourneyCommandExecutor = typeof runCommand;

function errorDiagnostic(
  error: unknown,
  commands: readonly CliJourneyCommand[],
): string {
  return diagnosticText(
    error instanceof Error ? error.message : String(error),
    commands,
  );
}

function formatJourneyLifecycleFailure(input: {
  readonly mode: CliJourneyMode;
  readonly journeyName: string;
  readonly commands: readonly CliJourneyCommand[];
  readonly results: readonly CliJourneyResult[];
  readonly primaryFailed: boolean;
  readonly primaryError?: unknown;
  readonly teardownFailed: boolean;
  readonly teardownError?: unknown;
  /** 信号中断独立可见：自有环境只停止并保留，绝不报告为成功。 */
  readonly interrupted: boolean;
  /** 自有环境收尾各环节的独立问题：与主失败并列，不替换首因。 */
  readonly recyclingProblems: readonly string[];
  /** 证据保存环节自身的独立问题：与收尾错误可辨。 */
  readonly evidenceProblems: readonly string[];
  readonly cleanupFailed: boolean;
  readonly cleanupError?: unknown;
}): Error {
  const failures = [
    ...(!input.primaryFailed
      ? []
      : [
          `main failure: ${errorDiagnostic(input.primaryError, input.commands)}`,
        ]),
    ...(!input.teardownFailed
      ? []
      : [
          `teardown failure: ${errorDiagnostic(input.teardownError, input.commands)}`,
        ]),
    ...(!input.interrupted
      ? []
      : [
          "interruption failure: 场景被信号中断，自有环境只停止并保留可重启数据",
        ]),
    ...input.recyclingProblems.map(
      (problem) => `environment recycling failure: ${problem}`,
    ),
    ...input.evidenceProblems.map(
      (problem) => `evidence persistence failure: ${problem}`,
    ),
    ...(!input.cleanupFailed
      ? []
      : [
          `workDir cleanup failure: ${errorDiagnostic(input.cleanupError, input.commands)}`,
        ]),
  ];
  const commandDiagnostics = input.results.map((result, index) => {
    const command = input.commands[index];
    const applicable = command === undefined ? input.commands : [command];
    return `${result.commandName}: exit ${result.exitCode}\nstdout: ${diagnosticText(result.stdout, applicable)}\nstderr: ${diagnosticText(result.stderr, applicable)}`;
  });
  const sanitized = [...commandDiagnostics, ...failures].join("\n");
  return new Error(
    `${input.mode}:${input.journeyName} journey failed${sanitized.length === 0 ? "" : `\n${sanitized}`}`,
    { cause: new Error(failures.join("\n")) },
  );
}

/** 旅程未声明来源即离线：绝不因父终端遗留配置使用真实来源。 */
function journeySource(journey: CliJourney): ScenarioSource {
  return journey.source ?? { mode: "offline" };
}

/** 一次旅程世代的环境生命周期：准备由环境包公开接口完成，回收同样复用公开能力。 */
export type JourneyEnvironmentLifecycle = {
  open(options: {
    readonly journey: CliJourney;
    readonly mode: CliJourneyMode;
    readonly runId: string;
  }): Promise<AcceptanceEnvironment>;
  close(options: {
    readonly environment: AcceptanceEnvironment;
    readonly outcome: OwnedRecycling["outcome"];
    /** 清理上下文：收尾期间的取消必须阻止删除，只停止并保留现场。 */
    readonly signal?: AbortSignal;
  }): Promise<OwnedRecycling>;
};

const evidenceRoot = path.join(workspaceRoot, "run", "02-evidence");

/**
 * 自有场景世代：环境容器由环境包公开布局放在本树工作区内（`.digital/environments/`），
 * 名字始终带 completion-02- 前缀；调用方只在 `run/` 下保存证据，绝不把工作区当成临时目录删除。
 * 世代记录里的 Web 端口一律先在本票区间内实际探测空闲：宁可显式给一个探测过的端口，
 * 也不让环境包按名字哈希算出区间外的监听口。
 */
export function ownedEnvironmentLifecycle(
  options: {
    readonly webPort?: number;
  } = {},
): JourneyEnvironmentLifecycle {
  return {
    async open({ journey, mode, runId }) {
      const environment = scenarioEnvironmentName({
        purpose: `${journey.name}-${mode}`,
        runId,
      });
      return await prepareScenarioEnvironment({
        workspacePath: workspaceRoot,
        environment,
        source: journeySource(journey),
        webPort: options.webPort ?? (await reserveFreePort({ runId })),
      });
    },
    async close({ environment, outcome, signal }) {
      return await recycleOwnedEnvironment({
        workspacePath: environment.workspacePath,
        environment: environment.environment,
        outcome,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}

/**
 * 使用调用方提供的环境：场景操作与断言完全相同，但世代归属留在提供者。成功、失败
 * 或中断都只执行公开查看，绝不停止、重建或删除；无法确认归属时才报告问题，
 * 绝不把未确认写成已回收。
 */
export function providedEnvironmentLifecycle(
  provided: ProvidedEnvironment,
): JourneyEnvironmentLifecycle {
  return {
    async open() {
      return provided;
    },
    async close({ outcome }) {
      return await retainProvidedEnvironment({
        workspacePath: provided.workspacePath,
        environment: provided.environment,
        outcome,
      });
    },
  };
}

type JourneyEvidence = {
  readonly journey: string;
  readonly mode: CliJourneyMode;
  readonly environment: string;
  readonly workspacePath: string;
  readonly productDataRoot: string;
  readonly sourceMode: string;
  readonly callerWorkDir: string;
  readonly outcome: OwnedRecycling["outcome"];
  readonly stopStatus: string | null;
  readonly exitConfirmation: {
    readonly confirmed: boolean;
    readonly state: string;
    readonly processLiveness: string;
    readonly serviceReadiness: string;
    readonly detail: string;
  } | null;
  readonly deleteStatus: string | null;
  readonly recyclingProblems: readonly string[];
  /** 公开环境操作给出的收尾叙述：如实记录，不据此判定失败。 */
  readonly recyclingDiagnostics: readonly string[];
  readonly retainedDataRoot: string | null;
  readonly retainedLogs: readonly string[];
  readonly overriddenAuthoritative: readonly string[];
  readonly commands: readonly {
    readonly name: string;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }[];
  readonly failures: readonly string[];
};

/** 保存结果早于任何收尾动作：失败诊断一律先脱敏再落盘。 */
async function writeJourneyEvidence(
  evidence: JourneyEvidence,
  commands: readonly CliJourneyCommand[],
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const sanitized: JourneyEvidence = {
    ...evidence,
    commands: evidence.commands.map((command) => ({
      ...command,
      stdout: redactJourneyDiagnostic(command.stdout, commands),
      stderr: redactJourneyDiagnostic(command.stderr, commands),
    })),
    failures: evidence.failures.map((failure) =>
      redactJourneyDiagnostic(failure, commands),
    ),
    recyclingProblems: evidence.recyclingProblems.map((problem) =>
      redactJourneyDiagnostic(problem, commands),
    ),
    recyclingDiagnostics: evidence.recyclingDiagnostics.map((diagnostic) =>
      redactJourneyDiagnostic(diagnostic, commands),
    ),
  };
  await writeFile(
    path.join(directory, `${evidence.environment}.json`),
    `${JSON.stringify(sanitized, null, 2)}\n`,
    "utf8",
  );
}

/**
 * 取消状态的实时重读：`await` 之后取消才到达也要读得出来。先前 `interruptedNow`
 * 的别名条件会把 `signal.aborted` 收窄成永不为 true，所以这里隔一层函数调用，
 * 而不是放弃晚到取消的收尾。
 */
function cancellationReceived(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function runJourney(options: {
  readonly journey: CliJourney;
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
  readonly executeCommand?: JourneyCommandExecutor;
  readonly lifecycle?: JourneyEnvironmentLifecycle;
  readonly evidenceDirectory?: string;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const lifecycle = options.lifecycle ?? ownedEnvironmentLifecycle();
  const evidenceDirectory = options.evidenceDirectory ?? evidenceRoot;
  const workDir = await mkdtemp(
    path.join(
      tmpdir(),
      `digital-disposable-cli-${options.journey.name}-${options.mode}-`,
    ),
  );
  const runId = scenarioRunId();
  const results: CliJourneyResult[] = [];
  const overriddenAuthoritative: string[] = [];
  let commands: readonly CliJourneyCommand[] = [];
  let primaryFailed = false;
  let primaryError: unknown;
  let interruptedDuringRun = false;
  let environment: AcceptanceEnvironment | undefined;
  let context: CliJourneyContext | undefined;
  try {
    environment = await lifecycle.open({
      journey: options.journey,
      mode: options.mode,
      runId,
    });
    const scenario: CliJourneyContext = {
      mode: options.mode,
      packageRoot,
      workDir,
      productDataDirectory: environment.productDataRoot,
      environmentName: environment.environment,
      commandEnvironment: environment.baseEnvironment,
    };
    context = scenario;
    await options.journey.setup(scenario);
    commands = options.journey.commands(scenario);
    for (const command of commands) {
      // 取消一旦到达就不再追加新的正式命令：中断结局由收尾与证据表达。
      if (options.signal?.aborted === true) {
        interruptedDuringRun = true;
        break;
      }
      const merged = mergeCommandEnvironment(environment, command.env);
      for (const key of merged.overridden)
        if (!overriddenAuthoritative.includes(key))
          overriddenAuthoritative.push(key);
      const result = await (options.executeCommand ?? runCommand)({
        mode: options.mode,
        packedBin: options.packedBin,
        command,
        previousResults: results,
        cwd: workDir,
        environment: merged.env,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      results.push(result);
      assertHaltedJourneyCommand(command, result);
    }
    // 中断到达后不再执行断言：缺失的结果只会伪造出一个掩盖中断的“主失败”。
    if (!interruptedDuringRun)
      await options.journey.assertions({ context: scenario, results });
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  let teardownFailed = false;
  let teardownError: unknown;
  if (context !== undefined)
    try {
      await options.journey.teardown?.({ context, results });
    } catch (error) {
      teardownFailed = true;
      teardownError = error;
    }

  // 先保存结果，再停止、由独立查看确认退出、按结局删除或保留。
  // 取消可能在保存与收尾的等待期间到达：每个环节前重读，绝不沿用过期快照。
  const interrupted = options.signal?.aborted === true || interruptedDuringRun;
  const succeeded = !primaryFailed && !teardownFailed && !interrupted;
  const outcome: OwnedRecycling["outcome"] = interrupted
    ? "interrupted"
    : succeeded
      ? "success"
      : "failure";
  const commandEvidence = commands.map((command, index) => ({
    name: command.name,
    exitCode: results[index]?.exitCode ?? -1,
    stdout: results[index]?.stdout ?? "",
    stderr: results[index]?.stderr ?? "",
  }));
  const buildFailureEvidence = (interruptedNow: boolean): string[] => [
    ...(!primaryFailed
      ? []
      : [`main failure: ${errorDiagnostic(primaryError, commands)}`]),
    ...(!teardownFailed
      ? []
      : [`teardown failure: ${errorDiagnostic(teardownError, commands)}`]),
    ...(interruptedNow ? ["journey interrupted by signal"] : []),
  ];
  let recycling: OwnedRecycling | undefined;
  let recyclingError: unknown;
  const evidenceSaveProblems: string[] = [];
  if (environment !== undefined) {
    const draft: JourneyEvidence = {
      journey: options.journey.name,
      mode: options.mode,
      environment: environment.environment,
      workspacePath: environment.workspacePath,
      productDataRoot: environment.productDataRoot,
      sourceMode: environment.facts.sourceMode,
      callerWorkDir: workDir,
      outcome,
      stopStatus: null,
      exitConfirmation: null,
      deleteStatus: null,
      recyclingProblems: [],
      recyclingDiagnostics: [],
      retainedDataRoot: null,
      retainedLogs: [],
      overriddenAuthoritative,
      commands: commandEvidence,
      failures: buildFailureEvidence(interrupted),
    };
    const saveJourneyEvidence = async (
      evidence: JourneyEvidence,
    ): Promise<boolean> => {
      try {
        await writeJourneyEvidence(evidence, commands, evidenceDirectory);
        return true;
      } catch (error) {
        evidenceSaveProblems.push(
          `证据保存失败：${errorDiagnostic(error, commands)}`,
        );
        return false;
      }
    };
    const savedDraft = await saveJourneyEvidence(draft);
    // 结果未能落盘时绝不交出可删除的 success 结局：证据载体只停止并保留。
    const outcomeAtClose =
      savedDraft || outcome !== "success" ? outcome : "failure";
    try {
      recycling = await lifecycle.close({
        environment,
        outcome: outcomeAtClose,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      recyclingError = error;
    }
    const interruptedNow =
      options.signal?.aborted === true || interruptedDuringRun;
    const finalEvidence: JourneyEvidence = {
      ...draft,
      outcome: interruptedNow ? "interrupted" : outcomeAtClose,
      failures: buildFailureEvidence(interruptedNow),
      stopStatus: recycling?.stop?.status ?? null,
      exitConfirmation: recycling?.exitConfirmation ?? null,
      deleteStatus: recycling?.deletion?.status ?? null,
      recyclingProblems: recycling?.problems ?? [],
      recyclingDiagnostics: recycling?.recyclingDiagnostics ?? [],
      retainedDataRoot: recycling?.retainedDataRoot ?? null,
      retainedLogs: recycling?.retainedLogs ?? [],
    };
    await saveJourneyEvidence(finalEvidence);
    // 取消允许在最终保存的异步写入期间才到达，此时上面那份载荷已按未取消构造。
    // 磁盘上的最终结局必须与调用方收到的中断一致：重写为 interrupted，
    // 已提交的公开删除不假定可逆转，这里只纠正证据，不新增删除动作。
    if (
      !interruptedNow &&
      (cancellationReceived(options.signal) || interruptedDuringRun)
    )
      await saveJourneyEvidence({
        ...finalEvidence,
        outcome: "interrupted",
        failures: [
          ...buildFailureEvidence(true),
          "取消在最终证据保存期间到达：持久结局按中断记录",
        ],
      });
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    // 只回收调用方自己的临时工作目录；环境容器由公开删除操作负责。
    await rm(workDir, { recursive: true, force: true });
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  const recyclingProblems = [
    ...(recycling === undefined ? [] : recycling.problems),
    ...(recyclingError === undefined
      ? []
      : [`环境收尾抛出异常：${errorDiagnostic(recyclingError, commands)}`]),
  ];
  const evidenceProblems = [...new Set(evidenceSaveProblems)];
  const interruptedFinal =
    options.signal?.aborted === true || interruptedDuringRun;
  if (
    primaryFailed ||
    teardownFailed ||
    cleanupFailed ||
    interruptedFinal ||
    recyclingProblems.length > 0 ||
    evidenceProblems.length > 0
  )
    throw formatJourneyLifecycleFailure({
      mode: options.mode,
      journeyName: options.journey.name,
      commands,
      results,
      primaryFailed,
      primaryError,
      teardownFailed,
      teardownError,
      interrupted: interruptedFinal,
      recyclingProblems,
      evidenceProblems,
      cleanupFailed,
      cleanupError,
    });
  return `${options.mode}:${options.journey.name}:passed`;
}

export async function runJourneys(options: {
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
  readonly signal?: AbortSignal;
}): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const journey of await discoverJourneys()) {
    if (!journey.modes.includes(options.mode)) continue;
    passed.push(
      await runJourney({
        journey,
        mode: options.mode,
        ...(options.packedBin === undefined
          ? {}
          : { packedBin: options.packedBin }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  }
  return passed;
}

async function runJourneyTargets(
  targets: readonly JourneyRunTarget[],
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const target of targets) {
    const options =
      target.packedBin === undefined ? {} : { packedBin: target.packedBin };
    switch (target.mode) {
      case "source":
      case "distribution":
        passed.push(
          ...(await runJourneys({
            mode: target.mode,
            ...options,
            ...(signal === undefined ? {} : { signal }),
          })),
        );
        break;
      case "packed":
        passed.push(
          ...(await runJourneys({
            mode: target.mode,
            ...options,
            ...(signal === undefined ? {} : { signal }),
          })),
        );
        break;
      default:
        assertNever(target.mode);
    }
  }
  return passed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cancellation = new AbortController();
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    process.on(signalName, () => {
      // 中断只取消进行中的操作；自有环境的停止、确认与保留仍由收尾路径完成。
      cancellation.abort(new Error(`received ${signalName}`));
    });
  }
  try {
    const passed = await runJourneyTargets(
      parseJourneyRunTargets(process.argv.slice(2)),
      cancellation.signal,
    );
    process.stdout.write(`${passed.join("\n")}\n`);
    if (cancellation.signal.aborted) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}
