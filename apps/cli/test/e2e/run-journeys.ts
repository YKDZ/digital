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

/** Never let a journey's configured credential values reach a failure diagnostic. */
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
 * Some live commands produce identifiers required by every following command.
 * If one of those prerequisites fails, surface its own safe diagnostic instead
 * of letting a dependent command fail while decoding a missing identifier.
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
          "--conditions=source",
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

export async function runJourneys(options: {
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
}): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const journey of await discoverJourneys()) {
    if (!journey.modes.includes(options.mode)) continue;
    const workDir = await mkdtemp(
      path.join(
        tmpdir(),
        `digital-disposable-cli-${journey.name}-${options.mode}-`,
      ),
    );
    const context = { mode: options.mode, packageRoot, workDir };
    try {
      await journey.setup(context);
      const results: CliJourneyResult[] = [];
      const commands = journey.commands(context);
      const preparedProductDataDirectories = new Set<string>();
      for (const command of commands) {
        const productDataDirectory = command.env?.DIGITAL_PRODUCT_DATA;
        if (
          productDataDirectory !== undefined &&
          productDataDirectory.trim().length > 0 &&
          !preparedProductDataDirectories.has(productDataDirectory)
        ) {
          await prepareCliProductData(productDataDirectory);
          preparedProductDataDirectories.add(productDataDirectory);
        }
        const result = await runCommand({
          mode: options.mode,
          packedBin: options.packedBin,
          command,
          previousResults: results,
          cwd: workDir,
        });
        results.push(result);
        assertHaltedJourneyCommand(command, result);
      }
      try {
        await journey.assertions({ context, results });
      } catch (error) {
        throw formatJourneyAssertionFailure({
          mode: options.mode,
          journeyName: journey.name,
          commands,
          results,
          error,
        });
      }
      passed.push(`${options.mode}:${journey.name}:passed`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
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
