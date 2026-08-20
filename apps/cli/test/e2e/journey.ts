export type CliJourneyMode = "source" | "distribution" | "packed";

export type CliJourneyCommand = {
  readonly name: string;
  readonly args:
    | readonly string[]
    | ((previousResults: readonly CliJourneyResult[]) => readonly string[]);
  readonly env?: Readonly<Record<string, string>>;
  /** A live prerequisite failed: stop before later dependent commands obscure it. */
  readonly haltOnFailure?: boolean;
};

export type CliJourneyResult = {
  readonly commandName: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Read the identity returned by the CLI's formal observed-root registration. */
export function registeredObservedRootId(
  result: CliJourneyResult | undefined,
): string {
  let output: unknown;
  try {
    output = JSON.parse(result?.stdout ?? "{}");
  } catch {
    throw new Error(
      `root-create did not return JSON\nstdout: ${result?.stdout ?? ""}\nstderr: ${result?.stderr ?? ""}`,
    );
  }
  if (
    typeof output !== "object" ||
    output === null ||
    !("id" in output) ||
    typeof output.id !== "string" ||
    output.id.trim().length === 0
  ) {
    throw new Error(
      `root-create did not expose an observed-root id\nstdout: ${result?.stdout ?? ""}\nstderr: ${result?.stderr ?? ""}`,
    );
  }
  return output.id;
}

export type CliJourneyContext = {
  readonly mode: CliJourneyMode;
  readonly packageRoot: string;
  readonly workDir: string;
};

export type CliJourney = {
  readonly name: string;
  readonly modes: readonly CliJourneyMode[];
  setup(context: CliJourneyContext): Promise<void>;
  commands(context: CliJourneyContext): readonly CliJourneyCommand[];
  assertions(options: {
    readonly context: CliJourneyContext;
    readonly results: readonly CliJourneyResult[];
  }): Promise<void>;
};
