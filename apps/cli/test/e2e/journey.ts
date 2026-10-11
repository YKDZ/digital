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

/**
 * 读取 CLI 正式库登记返回的目录归属身份，用于既有按单一目录扫描的验收路径。
 * `library-create` 输出的资产库携带该目录对应的观察根编号。
 */
export function registeredObservedRootId(
  result: CliJourneyResult | undefined,
): string {
  let output: unknown;
  try {
    output = JSON.parse(result?.stdout ?? "{}");
  } catch {
    throw new Error(
      `library-create did not return JSON\nstdout: ${result?.stdout ?? ""}\nstderr: ${result?.stderr ?? ""}`,
    );
  }
  if (
    typeof output !== "object" ||
    output === null ||
    !("rootIds" in output) ||
    !Array.isArray(output.rootIds) ||
    output.rootIds.length !== 1 ||
    typeof output.rootIds[0] !== "string" ||
    output.rootIds[0].trim().length === 0
  ) {
    throw new Error(
      `library-create did not expose exactly one observed-root id\nstdout: ${result?.stdout ?? ""}\nstderr: ${result?.stderr ?? ""}`,
    );
  }
  return output.rootIds[0];
}

export type CliJourneyContext = {
  readonly mode: CliJourneyMode;
  readonly packageRoot: string;
  readonly workDir: string;
  /**
   * 本次场景的产品数据根：由环境包公开接口准备出来的自有世代根。旅程不再自建
   * 迁移或写入，接入与刷新仍由被测 CLI 命令完成。
   */
  readonly productDataDirectory: string;
  /** 本次场景环境的名字，用于把结果与归属证据对应到同一个环境。 */
  readonly environmentName: string;
  /** 交给正式 CLI 子进程的基础环境；旅程自管子进程时复用它，而不是继承父终端。 */
  readonly commandEnvironment: Readonly<Record<string, string>>;
};

export type CliJourney = {
  readonly name: string;
  readonly modes: readonly CliJourneyMode[];
  /** 私有真实语料旅程只在显式入口运行，普通受控检查保留独立业务覆盖。 */
  readonly realCorpus?: boolean;
  /**
   * 旅程显式选定的来源装配。省略即离线：绝不因父终端遗留配置使用真实来源。
   * `controlled` 的清单由旅程给出，环境只转达选择，不读取清单内容。
   */
  readonly source?:
    | { readonly mode: "offline" }
    | { readonly mode: "real" }
    | { readonly mode: "controlled"; readonly manifestPath: string };
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
