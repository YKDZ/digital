export type CliJourneyMode = "source" | "distribution" | "packed";

export type CliJourneyCommand = {
  readonly name: string;
  readonly args:
    | readonly string[]
    | ((previousResults: readonly CliJourneyResult[]) => readonly string[]);
  readonly env?: Readonly<Record<string, string>>;
  /** 实时前置条件失败：在后续依赖命令掩盖它之前停止。 */
  readonly haltOnFailure?: boolean;
};

export type CliJourneyResult = {
  readonly commandName: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** 读取 CLI 正式观察根注册返回的身份。 */
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
  /** 基线已建立后无论主路径结果如何都执行，只核对外部不变量并释放登记状态。 */
  teardown?(options: {
    readonly context: CliJourneyContext;
    readonly results: readonly CliJourneyResult[];
  }): Promise<void>;
};
