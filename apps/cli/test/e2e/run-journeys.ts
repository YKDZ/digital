import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareCliProductData } from "../prepare-catalogue.ts";
import type {
  CliJourney,
  CliJourneyCommand,
  CliJourneyMode,
  CliJourneyResult,
} from "./journey.ts";

const e2eRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(e2eRoot, "..", "..");

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
}): Promise<CliJourneyResult> {
  const target = invocation(options.mode, options.packedBin);
  const args =
    typeof options.command.args === "function"
      ? options.command.args(options.previousResults)
      : options.command.args;
  return await new Promise((resolve, reject) => {
    const child = spawn(target.executable, [...target.prefix, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.command.env },
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

export async function runJourney(options: {
  readonly journey: CliJourney;
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
  readonly executeCommand?: JourneyCommandExecutor;
  readonly prepareProductData?: typeof prepareCliProductData;
}): Promise<string> {
  const workDir = await mkdtemp(
    path.join(
      tmpdir(),
      `digital-disposable-cli-${options.journey.name}-${options.mode}-`,
    ),
  );
  const context = { mode: options.mode, packageRoot, workDir };
  const results: CliJourneyResult[] = [];
  let commands: readonly CliJourneyCommand[] = [];
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    await options.journey.setup(context);
    commands = options.journey.commands(context);
    const preparedProductDataDirectories = new Set<string>();
    for (const command of commands) {
      const productDataDirectory = command.env?.DIGITAL_PRODUCT_DATA;
      if (
        productDataDirectory !== undefined &&
        productDataDirectory.trim().length > 0 &&
        !preparedProductDataDirectories.has(productDataDirectory)
      ) {
        await (options.prepareProductData ?? prepareCliProductData)(
          productDataDirectory,
        );
        preparedProductDataDirectories.add(productDataDirectory);
      }
      const result = await (options.executeCommand ?? runCommand)({
        mode: options.mode,
        packedBin: options.packedBin,
        command,
        previousResults: results,
        cwd: workDir,
      });
      results.push(result);
      assertHaltedJourneyCommand(command, result);
    }
    await options.journey.assertions({ context, results });
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  let teardownFailed = false;
  let teardownError: unknown;
  try {
    await options.journey.teardown?.({ context, results });
  } catch (error) {
    teardownFailed = true;
    teardownError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (primaryFailed || teardownFailed || cleanupFailed)
    throw formatJourneyLifecycleFailure({
      mode: options.mode,
      journeyName: options.journey.name,
      commands,
      results,
      primaryFailed,
      primaryError,
      teardownFailed,
      teardownError,
      cleanupFailed,
      cleanupError,
    });
  return `${options.mode}:${options.journey.name}:passed`;
}

export async function runJourneys(options: {
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
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
      }),
    );
  }
  return passed;
}

async function runJourneyTargets(
  targets: readonly JourneyRunTarget[],
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const target of targets) {
    switch (target.mode) {
      case "source":
      case "distribution":
        passed.push(...(await runJourneys({ mode: target.mode })));
        break;
      case "packed":
        passed.push(
          ...(await runJourneys({
            mode: target.mode,
            ...(target.packedBin === undefined
              ? {}
              : { packedBin: target.packedBin }),
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
  try {
    const passed = await runJourneyTargets(
      parseJourneyRunTargets(process.argv.slice(2)),
    );
    process.stdout.write(`${passed.join("\n")}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}
