import { createHash, randomUUID } from "node:crypto";
/**
 * 预览业务验收：通过公开环境操作准备一次性服务，再通过正式产品 HTTP 入口验证目录流程。
 *
 * 日常环境生命周期由 @digital/environment 的正式 CLI 管理。此处只保留既有产品场景验收，
 * 直到迁移到正式服务验收入口；准备、服务就绪与工作流完成仍分别报告。
 *
 * 验收默认使用受控资料与来源。自建环境按调用方约定收尾（成功后停止并回收，失败后停止
 * 并保留可重启现场）；由他人提供的环境无论成功、失败还是中断都不被本入口收尾。
 */
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import {
  deleteEnvironment,
  inspectEnvironment,
  prepareEnvironment,
  rebuildEnvironment,
  startEnvironment,
  stopEnvironment,
  type InspectEnvironmentResult,
  type PrepareOperationResult,
  type StartOperationResult,
} from "@digital/environment";
import type { PublicApiClient, PublicCurrentAsset } from "@digital/public-api";
import { loadControlledSourceIo } from "@digital/test-support/source-io";

import {
  artifactRoleAddress,
  createCorpusClient,
  findAsset,
  intakeDirectories,
  listAllAssetLibraries,
  listAllAssets,
  waitForAssetLibraryScan,
  waitForProductReady,
  waitForPublicExecution,
  waitForSourceEnrichment,
  type IntakeOutcome,
} from "./corpus-verification.ts";
import { requireInput } from "./inputs.ts";
import { digestDirectory } from "./material-digest.ts";

const defaultWorkspace = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
const sourceDirectory = requireInput("DIGITAL_AUTOMATION_SOURCE_DIRECTORY");
const defaultMaterial = path.join(sourceDirectory, "material", "RJ01668691");
const defaultManifest = path.join(sourceDirectory, "manifest.json");
const defaultCoverResponse = path.join(
  sourceDirectory,
  "responses",
  "dlsite-cover.png",
);
const previewPortFirst = 52_001;
const previewPortLast = 52_999;
const defaultWorkflowTimeoutMs = 300_000;
const defaultVerifyEnvironment = "completion-01-verify";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** 退出码只描述本入口的结论阶段；主错误与收尾错误始终分别可见。 */
export const exitCodes = {
  okay: 0,
  operationFailed: 1,
  invalidUsage: 2,
  configIncompatible: 3,
  unmanaged: 4,
  environmentRejected: 5,
  intakeFailed: 6,
  interrupted: 130,
  terminated: 143,
} as const;

/** 收到哪个信号就按哪个信号退：SIGINT→130、SIGTERM→143。 */
export function interruptedExitCode(signal: NodeJS.Signals | null): number {
  return signal === "SIGTERM" ? exitCodes.terminated : exitCodes.interrupted;
}

export type PreconditionKind = "absent" | "recover" | "provided" | "refuse";

/**
 * 归属的前提分类，按 `inspectEnvironment` 的真实状态词汇判定：`unprepared`（还没有任何环境
 * 记录）才允许本入口从零自建；`failed`（上次准备失败）允许本入口恢复运行，但那条记录与它的
 * 日志、数据载体是上一次运行留下的，不因此变成本次运行的私有财产（见 `planOwnership`）；
 * `provided` 继续只读协调；其余状态（`prepared`／`preparing`／`config-incompatible`／
 * `unmanaged`）都在本次运行之前由他人建立，本入口绝不复用、覆盖或删除它们。
 */
export function classifyEnvironmentPrecondition(
  state: string,
  provided: boolean,
): PreconditionKind {
  if (provided) return "provided";
  if (state === "unprepared") return "absent";
  return state === "failed" ? "recover" : "refuse";
}

/**
 * 归属决定分两件事：本入口是否拥有自己启动的服务（失败与取消时要由它停止），以及成功路径
 * 能不能连环境记录一起删除。只有本次运行之前连记录都不存在时，记录、数据与私有现场才是本次
 * 运行建立的，可删除；恢复一条 `failed` 记录时本入口只拥有自己启动的服务，删除仍归原使用者
 * 经公共生命周期命令决定——不能因为「不是 provided」就取得既有状态的删除权。
 */
export function planOwnership(kind: PreconditionKind): {
  readonly ownsService: boolean;
  readonly recycle: "delete" | "stop" | "none";
} {
  switch (kind) {
    case "absent": {
      return { ownsService: true, recycle: "delete" };
    }
    case "recover": {
      return { ownsService: true, recycle: "stop" };
    }
    default: {
      return { ownsService: false, recycle: "none" };
    }
  }
}

export type PreviewSourceMode = "controlled" | "real" | "offline";

export type PreviewRequest = {
  readonly command: "verify" | "help";
  readonly workspacePath: string;
  readonly environment: string;
  readonly materials: readonly string[];
  readonly sourceMode: PreviewSourceMode;
  readonly manifestPath: string;
  readonly expectedContentIdentity?: string;
  readonly allowRealSource: boolean;
  readonly realConditions: readonly string[];
  readonly port?: number;
  readonly timeoutMs: number;
  readonly workflowTimeoutMs: number;
  readonly libraryName: string;
  readonly provided: boolean;
  readonly cases: readonly string[];
  readonly evidencePath?: string;
  /** CI 成功运行先停服留存，上传核验后的删除仍由公共环境入口完成。 */
  readonly handoffDirectory?: string;
  /** 信号取消条件：由入口持有，贯穿环境操作与产品 HTTP 轮询。 */
  readonly signal?: AbortSignal | undefined;
};

export class PreviewUsageError extends Error {}

/** 入口在一次运行内真正拥有与启动的服务，是失败收尾的作用域。 */
export type RunningState = {
  ownsService: boolean;
  startedHere: boolean;
  /** 失败/取消收尾只执行一次，避免业务出口与顶层出口重复停止。 */
  failureFinished: boolean;
};

export const usage = `用法：pnpm preview:verify [选项]

此入口只运行既有产品场景验收；日常环境使用 pnpm environment。

选项：
  --workspace-path <目录>       代码检出根目录，默认当前工作区
  --environment <名称>          验收环境名，默认每次分配独立名称
  --material <目录>             普通资料目录，可重复；默认受控代表目录
  --source-mode <模式>          controlled（默认）| real | offline
  --manifest <路径>             受控来源清单绝对路径
  --content-identity <身份>     期望的清单内容身份，缺省按清单重算
  --allow-real-source           真实来源显式开关，必须同时给出 --real-condition
  --real-condition <条件>       真实来源成立条件，可重复
  --port <端口>                 只允许 ${String(previewPortFirst)}—${String(previewPortLast)}，缺省选择空闲端口
  --timeout-ms <毫秒>           单次环境操作期限
  --workflow-timeout-ms <毫秒>  等待产品工作流终态的期限
  --library <名称>              产品资产库显示名
  --provided                    由调用方提供环境；只读查看并运行业务断言
  --case <名称>                 只运行指定验收场景，可重复
  --evidence <路径>             把结构化结果写入该文件`;

const booleanFlags = ["--provided", "--allow-real-source"] as const;

const valueOptions = [
  "--workspace-path",
  "--workspace",
  "--environment",
  "--material",
  "--source-mode",
  "--manifest",
  "--content-identity",
  "--real-condition",
  "--port",
  "--timeout-ms",
  "--workflow-timeout-ms",
  "--library",
  "--case",
  "--evidence",
] as const;

export function parseRequest(argv: readonly string[]): PreviewRequest {
  const rawCommand = argv[0];
  const command =
    rawCommand === "help" ||
    rawCommand === "--help" ||
    (rawCommand === "verify" && argv.includes("--help"))
      ? "help"
      : rawCommand;
  if (command !== "verify" && command !== "help")
    throw new PreviewUsageError(
      `此入口只支持 verify 验收；日常环境请使用 pnpm environment。\n\n${usage}`,
    );

  const values: Partial<Record<(typeof valueOptions)[number], string>> = {};
  const materials: string[] = [];
  const realConditions: string[] = [];
  const cases: string[] = [];
  const flags = new Set<string>();
  const options = command === "verify" ? argv.slice(1) : [];
  for (let index = 0; index < options.length; index += 1) {
    const argument = options[index] ?? "";
    if ((booleanFlags as readonly string[]).includes(argument)) {
      flags.add(argument);
      continue;
    }
    if (!(valueOptions as readonly string[]).includes(argument))
      throw new PreviewUsageError(
        `无法理解的验收参数：${argument}\n\n${usage}`,
      );
    const value = options[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new PreviewUsageError(`选项 ${argument} 缺少取值`);
    index += 1;
    if (argument === "--material") {
      materials.push(value);
      continue;
    }
    if (argument === "--real-condition") {
      realConditions.push(value);
      continue;
    }
    if (argument === "--case") {
      cases.push(value);
      continue;
    }
    values[argument as keyof typeof values] = value;
  }
  const readNumber = (option: string, raw: string | undefined): number => {
    if (raw === undefined) return 0;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0)
      throw new PreviewUsageError(`选项 ${option} 需要非负整数：${raw}`);
    return parsed;
  };
  const sourceMode = values["--source-mode"] ?? "controlled";
  if (!["controlled", "real", "offline"].includes(sourceMode))
    throw new PreviewUsageError(
      `来源模式只能是 controlled、real 或 offline：${sourceMode}`,
    );
  const requireAbsolute = (option: string, raw: string): string => {
    if (!path.isAbsolute(raw))
      throw new PreviewUsageError(
        `${option} 需要绝对路径，本入口不按父终端工作目录猜测：${raw}`,
      );
    return raw;
  };
  const requestedPort = readNumber("--port", values["--port"]);
  if (requestedPort !== 0) assertPreviewPort(requestedPort);
  const environment =
    values["--environment"] ??
    (command === "verify"
      ? `${defaultVerifyEnvironment}-${randomUUID()}`
      : "help");
  const ciEvidence = process.env.DIGITAL_CI_EVIDENCE;
  const handoffDirectory =
    command === "verify" && ciEvidence !== undefined && ciEvidence.length > 0
      ? path.resolve(ciEvidence)
      : undefined;
  const evidencePath =
    values["--evidence"] ??
    (handoffDirectory === undefined
      ? undefined
      : path.join(handoffDirectory, "preview", environment, "outcome.json"));
  const workspace = values["--workspace-path"] ?? values["--workspace"] ?? ".";

  return {
    command,
    workspacePath: path.resolve(defaultWorkspace, workspace),
    environment,
    materials:
      materials.length === 0
        ? [defaultMaterial]
        : materials.map((item) => requireAbsolute("--material", item)),
    sourceMode: sourceMode as PreviewSourceMode,
    manifestPath:
      values["--manifest"] === undefined
        ? defaultManifest
        : requireAbsolute("--manifest", values["--manifest"]),
    ...(values["--content-identity"] === undefined
      ? {}
      : { expectedContentIdentity: values["--content-identity"] }),
    allowRealSource: flags.has("--allow-real-source"),
    realConditions,
    ...(requestedPort === 0 ? {} : { port: requestedPort }),
    timeoutMs: readNumber("--timeout-ms", values["--timeout-ms"]),
    workflowTimeoutMs:
      readNumber("--workflow-timeout-ms", values["--workflow-timeout-ms"]) ||
      defaultWorkflowTimeoutMs,
    libraryName: values["--library"] ?? "开发预览资料",
    provided: flags.has("--provided"),
    cases,
    ...(evidencePath === undefined
      ? {}
      : { evidencePath: path.resolve(defaultWorkspace, evidencePath) }),
    ...(handoffDirectory === undefined ? {} : { handoffDirectory }),
  };
}

export function assertPreviewPort(port: number): void {
  if (port < previewPortFirst || port > previewPortLast)
    throw new PreviewUsageError(
      `预览端口必须落在 ${String(previewPortFirst)}—${String(previewPortLast)} 内：${String(port)}`,
    );
}

/**
 * 请求阶段核验来源选择与输入边界：真实来源默认关闭且必须说明条件；受控清单与资料
 * 目录都必须是绝对路径，绝不从父终端遗留配置里猜测。
 */
export function assertSourceSelection(request: {
  readonly sourceMode: PreviewSourceMode;
  readonly allowRealSource: boolean;
  readonly realConditions: readonly string[];
  readonly manifestPath: string;
  readonly materials: readonly string[];
}): void {
  if (request.sourceMode === "real") {
    if (!request.allowRealSource)
      throw new PreviewUsageError(
        "真实来源默认关闭：必须显式加上 --allow-real-source 才能启用",
      );
    if (request.realConditions.length === 0)
      throw new PreviewUsageError(
        "真实来源需要说明成立条件：至少一个 --real-condition（凭据、网络与素材前提）",
      );
  }
  if (
    request.sourceMode === "controlled" &&
    !path.isAbsolute(request.manifestPath)
  )
    throw new PreviewUsageError("受控来源清单必须是绝对路径");
  if (request.materials.length === 0)
    throw new PreviewUsageError(
      "请通过 --material 明确选择至少一个普通资料目录",
    );
  for (const material of request.materials)
    if (!path.isAbsolute(material))
      throw new PreviewUsageError(`资料目录必须是绝对路径：${material}`);
}

/**
 * 收尾归属判断：只有本次运行真正创建、且未声明 provided 的环境才归本入口回收。
 * 复用他人早已准备的环境不构成归属——本次没有创建它，就不能取得删除其状态的权力。
 */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/** 端口只在真正交给环境之前做一次实际 bind 与释放，不据此推断任何已有服务。 */
async function resolvePreviewPort(request: PreviewRequest): Promise<number> {
  if (request.port !== undefined) {
    if (!(await portIsFree(request.port)))
      throw new PreviewUsageError(
        `端口 ${String(request.port)} 已被占用，无法确认它属于本预览；请改用其他端口或先由占用者自行收尾`,
      );
    return request.port;
  }
  for (let port = previewPortFirst; port <= previewPortLast; port += 1)
    if (await portIsFree(port)) return port;
  throw new PreviewUsageError(
    `预览端口区间 ${String(previewPortFirst)}—${String(previewPortLast)} 没有空闲端口`,
  );
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

type LifecycleOutcome = {
  readonly status: string;
  readonly failure?: {
    readonly stage: string;
    readonly message: string;
    readonly exitCode: number | null;
  };
  readonly cleanup: {
    readonly state: string;
    readonly errors: readonly string[];
  };
  readonly logs: {
    readonly directory: string | null;
    readonly files: readonly string[];
  };
  readonly diagnostics: readonly string[];
};

/** 主错误与收尾错误分开转述：收尾问题永远不掩盖最初原因。 */
export function describeLifecycleResult(
  result: LifecycleOutcome,
): readonly string[] {
  const lines: string[] = [`操作结论：${result.status}`];
  if (result.failure !== undefined)
    lines.push(
      `主错误（阶段 ${result.failure.stage}，子进程退出码 ${String(result.failure.exitCode ?? "无")}）：${result.failure.message}`,
    );
  lines.push(`自有资源清理状态：${result.cleanup.state}`);
  for (const error of result.cleanup.errors)
    lines.push(`收尾错误（不覆盖主错误）：${error}`);
  if (result.logs.directory !== null)
    lines.push(`日志目录：${result.logs.directory}`);
  for (const file of result.logs.files) lines.push(`日志文件：${file}`);
  for (const diagnostic of result.diagnostics)
    lines.push(`诊断：${diagnostic}`);
  return lines;
}

export function mapEnvironmentStatus(status: string): number {
  if (
    [
      "prepared",
      "ready",
      "already-ready",
      "stopped",
      "already-stopped",
      "rebuilt",
      "deleted",
      "already-deleted",
      "ok",
    ].includes(status)
  )
    return exitCodes.okay;
  if (status === "invalid-request") return exitCodes.environmentRejected;
  if (status === "config-incompatible") return exitCodes.configIncompatible;
  if (status === "unmanaged") return exitCodes.unmanaged;
  return exitCodes.operationFailed;
}

export class PreviewReporter {
  readonly lines: string[] = [];
  readonly failures: string[] = [];
  readonly facts: Record<string, JsonValue> = {};

  section(title: string): void {
    this.lines.push("", `【${title}】`);
  }

  say(line: string): void {
    this.lines.push(`  ${line}`);
  }

  fact(key: string, value: JsonValue): void {
    this.facts[key] = value;
    this.say(
      `${key}：${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  }

  fail(message: string): void {
    this.failures.push(message);
    this.lines.push(`  失败：${message}`);
  }

  print(): void {
    process.stdout.write(`${this.lines.join("\n")}\n`);
  }
}

function recordEnvironmentFacts(
  facts: InspectEnvironmentResult["environment"],
  reporter: PreviewReporter,
): void {
  reporter.fact("环境标识", facts.environmentId ?? "尚未建立");
  reporter.fact("容器目录", facts.containerDirectory);
  reporter.fact("产品数据根", facts.productDataRoot);
  reporter.fact("输入目录", [...facts.inputs]);
  reporter.fact("来源模式", facts.sourceMode);
  reporter.fact("运行配置", facts.config as JsonValue);
  reporter.fact("数据世代", facts.dataGeneration ?? "无");
}

async function runPrepare(
  request: PreviewRequest,
  reporter: PreviewReporter,
): Promise<PrepareOperationResult> {
  assertSourceSelection(request);
  for (const material of request.materials)
    if (!(await isDirectory(material)))
      throw new PreviewUsageError(`资料目录不存在或不是目录：${material}`);
  const controlled =
    request.sourceMode === "controlled"
      ? await loadControlledSourceIo({
          manifestPath: request.manifestPath,
          ...(request.expectedContentIdentity === undefined
            ? {}
            : { expectedContentIdentity: request.expectedContentIdentity }),
        })
      : undefined;
  if (controlled !== undefined)
    reporter.say(
      `受控清单已核验：${request.manifestPath}（内容身份 ${controlled.contentIdentity}，收录 ${String(controlled.entryIds.length)} 条来源响应）`,
    );
  if (request.sourceMode === "real")
    reporter.say(
      `真实来源已显式启用，声明条件：${request.realConditions.join("；")}`,
    );
  if (!(await isDirectory(request.workspacePath)))
    throw new PreviewUsageError(
      `预览工作区不存在或不是目录：${request.workspacePath}（工作区必须是一份代码检出）`,
    );
  const port = await resolvePreviewPort(request);
  const config: Record<string, JsonValue> = {
    profile: "completion-01-preview",
    webPort: port,
    ...(controlled === undefined
      ? {}
      : {
          sourceIo: {
            manifestPath: request.manifestPath,
            contentIdentity: controlled.contentIdentity,
          },
        }),
  };
  reporter.section("准备");
  const result = await prepareEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
    inputs: [...request.materials],
    sourceMode: request.sourceMode,
    config,
    signal: request.signal,
    ...(request.timeoutMs === 0 ? {} : { timeoutMs: request.timeoutMs }),
  });
  for (const line of describeLifecycleResult(result)) reporter.say(line);
  recordEnvironmentFacts(result.environment, reporter);
  if (result.status === "config-incompatible")
    reporter.fail(
      "已保留的数据与当前输入或来源配置不兼容，需要使用者显式重建；本入口不会自动清空。",
    );
  return result;
}

async function runStart(
  request: PreviewRequest,
  reporter: PreviewReporter,
): Promise<StartOperationResult> {
  reporter.section("启动");
  const result = await startEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
    signal: request.signal,
    ...(request.timeoutMs === 0 ? {} : { timeoutMs: request.timeoutMs }),
  });
  reporter.fact("就绪结论", result.status);
  reporter.fact("运行世代", result.run.runId || "无");
  reporter.fact("实际地址", result.run.address || "未取得");
  reporter.fact("实际端口", result.run.port ?? 0);
  reporter.fact("产品日志位置", result.run.productLogFile || "未取得");
  for (const line of describeLifecycleResult(result)) reporter.say(line);
  return result;
}

function reportText(value: string | null | undefined): string {
  return value === null || value === undefined || value.length === 0
    ? "未取得"
    : value;
}

/** 只在环境明确给出可核验地址时才建立产品入口客户端。 */
function observedAddress(address: string | null): string | undefined {
  return address === null || address.length === 0 ? undefined : address;
}

async function readEnvironmentState(
  request: PreviewRequest,
  reporter: PreviewReporter,
): Promise<{
  readonly inspect: InspectEnvironmentResult;
  readonly client?: PublicApiClient;
}> {
  const inspect = await inspectEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
  });
  reporter.section("查看");
  reporter.fact("环境状态", inspect.state);
  reporter.fact("服务就绪结论", inspect.serviceReadiness);
  if (inspect.development !== undefined) {
    reporter.fact("开发会话", inspect.development.state);
    reporter.fact("开发更新", inspect.development.update);
    reporter.fact("开发日志", inspect.development.logFile);
    if (inspect.development.failure !== undefined)
      reporter.say(`开发更新失败：${inspect.development.failure}`);
  }
  reporter.fact("运行世代", reportText(inspect.run.runId));
  reporter.fact("实际地址", reportText(inspect.run.address));
  reporter.fact("产品日志位置", reportText(inspect.run.productLogFile));
  reporter.fact("进程存活观察", inspect.run.processLiveness);
  if (inspect.runProblem !== undefined)
    reporter.say(`就绪观察原因：${inspect.runProblem}`);
  if (inspect.pendingIntent !== undefined)
    reporter.say(
      `存在尚未收敛的 ${inspect.pendingIntent.kind} 意图（操作 ${inspect.pendingIntent.operationId}）；查看不代替收尾，请用对应命令继续。`,
    );
  if (inspect.preparation !== undefined)
    reporter.say(
      `准备记录：${inspect.preparation.lastOperationId}（${inspect.preparation.updatedAt}）`,
    );
  recordEnvironmentFacts(inspect.environment, reporter);
  const address =
    inspect.serviceReadiness === "ready"
      ? observedAddress(inspect.run.address)
      : undefined;
  if (address === undefined) return { inspect };
  await waitForProductReady(
    address,
    request.signal ?? new AbortController().signal,
  );
  return {
    inspect,
    client: createCorpusClient(
      address,
      request.signal ?? new AbortController().signal,
    ),
  };
}

async function runIntake(
  request: PreviewRequest,
  client: PublicApiClient,
  reporter: PreviewReporter,
  options: {
    readonly directories?: readonly string[];
    readonly libraryName?: string;
  } = {},
): Promise<IntakeOutcome> {
  reporter.section("目录接入（正式产品入口）");
  const directories = options.directories ?? request.materials;
  reporter.fact("本次接入目录", [...directories]);
  const intake = await intakeDirectories(client, {
    displayName: options.libraryName ?? request.libraryName,
    directories,
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
    workflowTimeoutMs: request.workflowTimeoutMs,
  });
  reporter.fact("资产库标识", intake.assetLibraryId);
  reporter.fact(
    "登记目录",
    intake.directories.map((directory) => directory.path),
  );
  reporter.fact(
    "刷新工作流",
    `${intake.executionId}=${intake.executionStatus}`,
  );
  reporter.fact("工作流结论", intake.executionOutcome ?? "无");
  reporter.fact("接入产生的资产", [...intake.assetIds]);
  if (intake.reused)
    reporter.say("该普通目录已在资产库内，本次只复核当前状态而不重复接入。");
  return intake;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error) ?? "未知错误";
}

function check(
  reporter: PreviewReporter,
  caseName: string,
  condition: boolean,
  detail: string,
): void {
  if (condition) reporter.say(`通过（${caseName}）：${detail}`);
  else reporter.fail(`断言失败（${caseName}）：${detail}`);
}

async function ownedStop(
  request: PreviewRequest,
  reporter: PreviewReporter,
): Promise<void> {
  const result = await stopEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
  });
  for (const line of describeLifecycleResult(result)) reporter.say(line);
  if (result.status === "not-confirmed")
    reporter.fail("无法确认自有服务已退出，保留记录而不宣称停止成功。");
}

async function recycleOwned(
  request: PreviewRequest,
  reporter: PreviewReporter,
  running: RunningState,
): Promise<void> {
  await ownedStop(request, reporter);
  running.startedHere = false;
  if (request.signal?.aborted === true) {
    // 取消在等待停止期间到达：已取消的运行不能把删除当成功收尾。
    reporter.say(
      "等待停止期间收到取消，按取消语义收尾：环境记录、数据与日志载体原样保留，本入口不删除。停止与删除仍由使用者经公共生命周期命令决定。",
    );
    running.startedHere = false;
    running.failureFinished = true;
    return;
  }
  const result = await deleteEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
  });
  for (const line of describeLifecycleResult(result)) reporter.say(line);
  if (result.status === "not-confirmed")
    reporter.fail("无法确认自有数据已清理，保留现场而不宣称回收成功。");
}

/**
 * 失败与取消共用的收尾：停止本次真正启动的服务，数据、日志与证据载体保持可重启。
 * 服务启动责任按「本次是否真的启动了服务」判定，而不是按环境记录的归属判定：既有已停止
 * 环境由本次启动新服务后，本次就该停止它，但那条记录与它的数据仍归原使用者，绝不删除。
 */
async function finishOwnedFailure(
  request: PreviewRequest,
  reporter: PreviewReporter,
  ownsService: boolean,
  startedHere: boolean,
): Promise<readonly string[]> {
  const cleanupErrors: string[] = [];
  if (!ownsService && !startedHere) {
    reporter.say(
      "环境不归本入口所有，本次也没有启动服务（调用方提供或复用既有就绪世代），未做任何收尾。",
    );
    return cleanupErrors;
  }
  if (startedHere) {
    try {
      const stop = await stopEnvironment({
        workspacePath: request.workspacePath,
        environment: request.environment,
      });
      for (const line of describeLifecycleResult(stop)) reporter.say(line);
      if (["failed", "not-confirmed"].includes(stop.status))
        cleanupErrors.push(`停止自有服务：${stop.status}`);
    } catch (error) {
      cleanupErrors.push(`停止自有服务异常：${describeError(error)}`);
    }
  } else reporter.say("服务不是本次启动的（复用或已停止），只保留现状。");
  reporter.say(
    "失败或取消现场的数据与日志已保留，可用 start 显式重启查看；本入口不宣称已回收，也不删除证据载体。",
  );
  return cleanupErrors;
}

type ScenarioContext = {
  readonly request: PreviewRequest;
  readonly reporter: PreviewReporter;
  serviceAddress: string;
  readonly subsetDirectory: string;
  readonly multiLeftDirectory: string;
  readonly multiRightDirectory: string;
  client: PublicApiClient;
  subject?: string;
  assetLibraryId?: string;
  manualCoverReference?: string;
};

function requestSignal(request: PreviewRequest): AbortSignal {
  return request.signal ?? new AbortController().signal;
}

async function resolveSubject(context: ScenarioContext): Promise<string> {
  if (context.subject !== undefined) return context.subject;
  const intake = await runIntake(
    context.request,
    context.client,
    context.reporter,
  );
  if (intake.assetIds.length === 0)
    throw new Error("产品没有从普通目录自然产生任何资产");
  context.subject = intake.assetIds[0] ?? "";
  context.assetLibraryId = intake.assetLibraryId;
  return context.subject;
}

async function resolveAssetLibrary(context: ScenarioContext): Promise<string> {
  if (context.assetLibraryId !== undefined) return context.assetLibraryId;
  const library = (await listAllAssetLibraries(context.client)).find(
    (candidate) =>
      candidate.directories.some((directory) =>
        context.request.materials.includes(directory.path),
      ),
  );
  if (library === undefined) throw new Error("找不到代表资料所属资产库");
  context.assetLibraryId = library.id;
  return library.id;
}

async function scenarioFirstRun(context: ScenarioContext): Promise<void> {
  const { client, reporter } = context;
  const subjectId = await resolveSubject(context);
  const libraryId = await resolveAssetLibrary(context);
  const recognition = await client.inspectSourceAssociationHistory(subjectId);
  check(
    reporter,
    "first-run",
    recognition.recognitionState === "recognized",
    "产品把代表目录自然识别为已识别内容（实际 " +
      recognition.recognitionState +
      "）",
  );
  const asset = await findAsset(client, libraryId, subjectId);
  check(
    reporter,
    "first-run",
    JSON.stringify(asset).includes("RJ01668691"),
    "浏览用内容携带资料编号 RJ01668691 的真实投影",
  );
  const before = await listAllAssets(client, libraryId);
  check(
    reporter,
    "first-run",
    before.some((item) => item.id === subjectId),
    "内容目录页可浏览到本次接入的主体",
  );
  const detail = await client.inspectAssetEvidence(subjectId);
  check(
    reporter,
    "first-run",
    detail.assetId === subjectId,
    "主体详情通过正式资料检查入口返回",
  );
  const beforeIds = new Set(before.map((item) => item.id));
  const started = await client.startAssetLibraryScan(libraryId);
  const scan = await waitForAssetLibraryScan(
    client,
    started.parentExecutionId,
    context.request.workflowTimeoutMs,
  );
  const after = await listAllAssets(client, libraryId);
  reporter.fact("再次刷新结论", scan.status + "／" + (scan.outcome ?? "无"));
  check(
    reporter,
    "first-run",
    scan.status === "completed" &&
      (scan.outcome === "accepted" || scan.outcome === "no-change") &&
      after.length === beforeIds.size &&
      after.every((item) => beforeIds.has(item.id)),
    "再次刷新仍由正式扫描给出终态结论，且相同目录没有重复收录资产",
  );
  const cover = await readManagedCover(client, asset, reporter);
  check(reporter, "first-run", cover.ok, cover.detail);
}

/** 当前封面字节来自公共当前资产的 primary-cover 角色，并与受控响应逐字节一致。 */
async function readManagedCover(
  client: PublicApiClient,
  asset: PublicCurrentAsset,
  reporter: PreviewReporter,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const choice = await client.inspectArtifactRoleCovers(asset.id);
  reporter.fact("封面候选", choice.candidates.length);
  const address = artifactRoleAddress(asset, "asset.primary-cover");
  if (address === undefined)
    return { ok: false, detail: "当前资产没有 primary-cover 角色" };
  const digest = address.split("/").at(-1);
  if (digest === undefined)
    return { ok: false, detail: "当前封面角色没有可读取的受管摘要" };
  const response = await client.readManagedArtifact(digest);
  if (!response.ok)
    return {
      ok: false,
      detail: "封面交付返回 HTTP " + String(response.status),
    };
  const delivered = new Uint8Array(await response.arrayBuffer());
  const expected = await readFile(defaultCoverResponse);
  const digestValue = createHash("sha256").update(delivered).digest("hex");
  reporter.fact("封面交付摘要", "sha256:" + digestValue);
  reporter.fact(
    "封面媒体类型",
    response.headers.get("content-type") ?? "未知类型",
  );
  const same =
    delivered.byteLength === expected.byteLength &&
    delivered.every((byte, index) => byte === expected[index]);
  return same
    ? {
        ok: true,
        detail:
          "受管封面可读，且与清单响应逐字节相同（" +
          String(delivered.byteLength) +
          " 字节）",
      }
    : {
        ok: false,
        detail:
          "封面交付与清单响应不一致（交付 " +
          String(delivered.byteLength) +
          " 字节，清单 " +
          String(expected.byteLength) +
          " 字节）",
      };
}

async function scenarioManualEdit(context: ScenarioContext): Promise<void> {
  const { client, reporter } = context;
  reporter.section("编辑（人工封面决定）");
  const subjectId = await resolveSubject(context);
  const choice = await client.inspectArtifactRoleCovers(subjectId);
  const reference = choice.candidates[0]?.reference;
  if (reference === undefined) throw new Error("封面候选为空，无法演示编辑");
  if (choice.decision?.reference !== reference) {
    const preview = await client.prepareArtifactRoleDecision(subjectId, {
      initiatedBy: "开发预览",
      candidateReference: reference,
    });
    if (preview.status === "awaiting-confirmation")
      await client.confirmChangeImpactPreview(preview.previewId, "开发预览");
  } else reporter.say("该候选已是当前人工选择，回读确认其结论。");
  const after = await client.inspectArtifactRoleCovers(subjectId);
  check(
    reporter,
    "edit",
    after.decision?.reference === reference,
    "人工封面决定已写入并可回读（" + reference + "）",
  );
  context.manualCoverReference = reference;
}

async function scenarioSubset(context: ScenarioContext): Promise<void> {
  const { client, reporter, request } = context;
  reporter.section("同一资料集的子集目录");
  const before = await listAllAssetLibraries(client);
  const defaultLibrary = before.find((library) =>
    library.directories.some((directory) =>
      request.materials.includes(directory.path),
    ),
  );
  const beforeDirectories = defaultLibrary?.directories;
  const intake = await intakeDirectories(client, {
    displayName: "开发预览子集目录",
    directories: [context.subsetDirectory],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
    workflowTimeoutMs: request.workflowTimeoutMs,
  });
  check(
    reporter,
    "subset",
    intake.executionStatus === "completed",
    "自选普通子集目录的刷新按产品自身结论到达终态",
  );
  reporter.fact("子集接入资产", [...intake.assetIds]);
  reporter.fact("未识别观察条目", intake.unrecognizedMaterials.length);
  const stillThere = (await listAllAssetLibraries(client)).find(
    (library) => library.id === defaultLibrary?.id,
  );
  check(
    reporter,
    "subset",
    stillThere !== undefined &&
      JSON.stringify(stillThere.directories) ===
        JSON.stringify(beforeDirectories),
    "新增子集目录不改动代表目录的库与登记范围",
  );
}

async function scenarioMultiDirectory(context: ScenarioContext): Promise<void> {
  const { client, reporter, request } = context;
  reporter.section("多个普通目录一次接入");
  const leftOnly = await intakeDirectories(client, {
    displayName: "开发预览多目录甲",
    directories: [context.multiLeftDirectory],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
    workflowTimeoutMs: request.workflowTimeoutMs,
  });
  const intake = await intakeDirectories(client, {
    displayName: "开发预览多目录",
    directories: [context.multiLeftDirectory, context.multiRightDirectory],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
    workflowTimeoutMs: request.workflowTimeoutMs,
  });
  const libraries = await listAllAssetLibraries(client);
  const held = (directory: string): boolean =>
    libraries.some((library) =>
      library.directories.some((entry) => entry.path === directory),
    );
  check(
    reporter,
    "multi-directory",
    held(context.multiLeftDirectory) && held(context.multiRightDirectory),
    "两个请求目录都在资产库配置中有明确归属，没有被静默丢弃",
  );
  const newRoots = intake.observedRootIds.filter(
    (id) => !leftOnly.observedRootIds.includes(id),
  );
  check(
    reporter,
    "multi-directory",
    newRoots.length > 0 &&
      JSON.stringify(intake.observedRootIds) !==
        JSON.stringify(leftOnly.observedRootIds),
    "第二次接入为目录乙实际建立了新的观察根（" +
      String(newRoots.length) +
      " 个），而非只刷新甲的旧库结果",
  );
  check(
    reporter,
    "multi-directory",
    intake.assetIds.length > 0,
    "两次接入累计由产品自然产生 " + String(intake.assetIds.length) + " 个资产",
  );
}

async function scenarioRefusedSourceRequest(
  context: ScenarioContext,
): Promise<void> {
  const { client, reporter, request } = context;
  reporter.section("未列入受控清单的来源请求");
  const subjectId = await resolveSubject(context);
  const started = await client.startSourceEnrichment({
    subjectId,
    sourceIdentity: "dlsite",
    sourceInput: { product: "RJ01497788" },
    assetLibraryId: await resolveAssetLibrary(context),
  });
  const execution = await waitForSourceEnrichment(
    client,
    started.id,
    request.workflowTimeoutMs,
  );
  check(
    reporter,
    "refused-source-request",
    execution.status === "failed" &&
      execution.reason === "明确来源补充未完成；已确认内容保持有效" &&
      !execution.reason.includes("受控来源拒绝") &&
      !execution.reason.includes("请求键") &&
      execution.items.length > 0 &&
      execution.items.every((item) => item.status === "failed"),
    "未列入的来源请求在产品工作流里失败，业务结论保持清晰且执行细节单独留在来源明细中",
  );
}

async function scenarioRestartRetention(
  context: ScenarioContext,
): Promise<void> {
  const { client, reporter, request } = context;
  reporter.section("再次启动保留修改");
  if (request.provided) {
    reporter.say("环境由调用方提供，本场景不停止也不重启对方的服务。");
    return;
  }
  const subjectId = context.subject ?? (await resolveSubject(context));
  const libraryId = await resolveAssetLibrary(context);
  const library = (await listAllAssetLibraries(client)).find(
    (item) => item.id === libraryId,
  );
  if (library === undefined) {
    reporter.fail("重启保留场景找不到本预览登记的资产库，无法写入设置状态。");
    return;
  }
  const renamedTo = "预览改名保留";
  const updated = await client.saveAssetLibrary({
    id: library.id,
    expectedVersion: library.configVersion,
    displayName: renamedTo,
    directories: library.directories.map(({ path: directory }) => directory),
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const directory = updated.directories.find((entry) =>
    request.materials.includes(entry.path),
  );
  if (directory === undefined) {
    reporter.fail("资产库没有代表目录，无法建立自动刷新设置。");
    return;
  }
  const enable = await client.enableAutomationIntent({
    assetLibraryId: library.id,
    directoryId: directory.id,
    relativeScope: ".",
    intervalMilliseconds: 86_400_000,
    acceptTrusted: true,
  });
  check(
    reporter,
    "restart-retention",
    enable.intent.enabled && enable.intent.intervalMilliseconds === 86_400_000,
    "自动刷新设置由正式自动化入口受理",
  );
  if (enable.initial?.status !== "started") {
    reporter.fail("自动刷新没有返回初始执行，无法建立稳定的重启保留基线。");
    return;
  }
  const initialExecution = await waitForPublicExecution(
    client,
    enable.initial.executionId,
    request.workflowTimeoutMs,
  );
  check(
    reporter,
    "restart-retention",
    initialExecution.kind === "asset-library-scan" &&
      initialExecution.status === "completed",
    "自动刷新初始执行已完成（实际 " + initialExecution.status + "）",
  );
  if (initialExecution.status !== "completed") return;
  const asset = await findAsset(client, library.id, subjectId);
  const location = asset.locations.find(
    (candidate) =>
      candidate.kind === "observed" &&
      candidate.content.status === "unconfirmed" &&
      /\.(wav|mp3|m4a|flac|ogg)$/iu.test(candidate.address),
  );
  if (location === undefined) {
    reporter.fail("当前资产没有未确认的音频材料，无法保存播放进度。");
    return;
  }
  const firstRead = await client.readObservedMaterial(subjectId, location.id, {
    assetLibraryId: library.id,
    signal: requestSignal(request),
  });
  const deliveredAudio = new Uint8Array(await firstRead.arrayBuffer());
  check(
    reporter,
    "restart-retention",
    firstRead.status === 200 && deliveredAudio.byteLength > 0,
    "观察音频由正式媒体入口完整交付（HTTP " +
      String(firstRead.status) +
      "，" +
      String(deliveredAudio.byteLength) +
      " 字节）",
  );
  if (firstRead.status !== 200 || deliveredAudio.byteLength === 0) return;
  const confirmed = await client.confirmObservedMaterial(
    subjectId,
    location.id,
    library.id,
  );
  const revisionId = confirmed.artifactRevisionId;
  const revisionRead = await client.readArtifactRevision(revisionId, {
    assetLibraryId: library.id,
    range: "bytes=0-0",
    signal: requestSignal(request),
  });
  check(
    reporter,
    "restart-retention",
    revisionRead.status === 206,
    "已确认材料修订可从正式受管版本入口读取（HTTP " +
      String(revisionRead.status) +
      "）",
  );
  if (revisionRead.status !== 206) return;
  await revisionRead.body?.cancel();
  let interactionSaved = false;
  try {
    await client.savePlaybackInteraction({
      artifactRevisionId: revisionId,
      positionMilliseconds: 90_210,
      completed: false,
    });
    interactionSaved = true;
  } catch {
    // 验收报告只记录公共 API 的业务结果，不输出底层响应或存储错误。
  }
  check(
    reporter,
    "restart-retention",
    interactionSaved,
    "播放进度写入由公共媒体 API 受理",
  );
  if (!interactionSaved) return;
  const failuresBeforeEdit = reporter.failures.length;
  await scenarioManualEdit(context);
  if (reporter.failures.length > failuresBeforeEdit) return;
  await ownedStop(request, reporter);
  if (request.signal?.aborted === true) {
    reporter.say(
      "等待停止期间收到取消：本场景不再重启，保留停止前的数据世代与现场。",
    );
    return;
  }
  const started = await startEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
    signal: request.signal,
    ...(request.timeoutMs === 0 ? {} : { timeoutMs: request.timeoutMs }),
  });
  reporter.fact("重启结论", started.status);
  reporter.fact("重启后实际地址", started.run.address || "未取得");
  reporter.fact("重启后产品日志位置", started.run.productLogFile || "未取得");
  for (const line of describeLifecycleResult(started)) reporter.say(line);
  if (mapEnvironmentStatus(started.status) !== exitCodes.okay) {
    reporter.fail("重启后未取得就绪结论，无法证明修改保留。");
    return;
  }
  context.serviceAddress =
    observedAddress(started.run.address) ?? context.serviceAddress;
  await waitForProductReady(context.serviceAddress, requestSignal(request));
  context.client = createCorpusClient(
    context.serviceAddress,
    requestSignal(request),
  );
  const restartedClient = context.client;
  const retained = (await listAllAssetLibraries(restartedClient)).find(
    (item) => item.id === library.id,
  );
  check(
    reporter,
    "restart-retention",
    retained !== undefined,
    "未重新接入即仍能在资产库里看到本预览的普通目录",
  );
  check(
    reporter,
    "restart-retention",
    retained?.displayName === renamedTo,
    "资产库改名保留为「" +
      renamedTo +
      "」（实际 " +
      (retained?.displayName ?? "缺失") +
      "）",
  );
  const retainedAutomation = (
    await restartedClient.listAutomationIntents()
  ).items.find(
    (intent) =>
      intent.scope.assetLibraryId === library.id &&
      intent.scope.directoryId === directory.id &&
      intent.scope.relativeScope === ".",
  );
  check(
    reporter,
    "restart-retention",
    retainedAutomation?.enabled === true &&
      retainedAutomation.intervalMilliseconds === 86_400_000,
    "自动刷新意图重启后仍为开启且间隔不变",
  );
  const recognition =
    await restartedClient.inspectSourceAssociationHistory(subjectId);
  check(
    reporter,
    "restart-retention",
    recognition.recognitionState === "recognized",
    "重启后内容仍按既有识别结果可浏览",
  );
  const retainedInteraction = (
    await restartedClient.readPlaybackInteractions([revisionId])
  ).find((interaction) => interaction.artifactRevisionId === revisionId);
  check(
    reporter,
    "restart-retention",
    retainedInteraction?.positionMilliseconds === 90_210 &&
      retainedInteraction.completed === false,
    "播放进度重启后由公共媒体 API 回读（90210 毫秒、未完成）",
  );
  if (context.manualCoverReference !== undefined) {
    const choice = await restartedClient.inspectArtifactRoleCovers(subjectId);
    check(
      reporter,
      "restart-retention",
      choice.decision?.reference === context.manualCoverReference,
      "人工封面决定保留为 " + context.manualCoverReference,
    );
  }
}

async function scenarioRebuild(context: ScenarioContext): Promise<void> {
  const { reporter, request } = context;
  reporter.section("显式重建");
  if (request.provided) {
    reporter.say("环境由调用方提供，本场景不重建对方的状态。");
    return;
  }
  const before: Record<string, string> = {};
  for (const material of request.materials)
    before[path.basename(material)] = await digestDirectory(material);
  await ownedStop(request, reporter);
  if (request.signal?.aborted === true) {
    reporter.say(
      "等待停止期间收到取消：本场景不重建，保留原数据世代与私有现场。",
    );
    return;
  }
  const rebuild = await rebuildEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
  });
  for (const line of describeLifecycleResult(rebuild)) reporter.say(line);
  check(
    reporter,
    "rebuild-inputs-preserved",
    rebuild.status === "rebuilt",
    "按相同输入与配置重新建立了新的数据世代",
  );
  if (rebuild.status !== "rebuilt") return;
  request.signal?.throwIfAborted();
  const started = await startEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
    signal: request.signal,
    ...(request.timeoutMs === 0 ? {} : { timeoutMs: request.timeoutMs }),
  });
  reporter.fact("重建后就绪结论", started.status);
  for (const line of describeLifecycleResult(started)) reporter.say(line);
  if (mapEnvironmentStatus(started.status) !== exitCodes.okay) {
    reporter.fail("重建后未能取得就绪结论。");
    return;
  }
  context.serviceAddress =
    observedAddress(started.run.address) ?? context.serviceAddress;
  await waitForProductReady(context.serviceAddress, requestSignal(request));
  context.client = createCorpusClient(
    context.serviceAddress,
    requestSignal(request),
  );
  const intake = await runIntake(request, context.client, reporter);
  check(
    reporter,
    "rebuild-inputs-preserved",
    intake.assetIds.length > 0,
    "重建后由预览调用方以同一条正常接入路径重新取得资料",
  );
  const after: Record<string, string> = {};
  for (const material of request.materials)
    after[path.basename(material)] = await digestDirectory(material);
  check(
    reporter,
    "rebuild-inputs-preserved",
    JSON.stringify(before) === JSON.stringify(after),
    "被观察素材的字节保持不变",
  );
}

/** 验收前置条件的负项用例：不创建环境、不触达产品服务。 */
export function requestValidationCases(): readonly {
  readonly name: string;
  readonly detail: string;
  run: () => void;
}[] {
  const base = {
    sourceMode: "controlled" as PreviewSourceMode,
    allowRealSource: false,
    realConditions: [] as readonly string[],
    manifestPath: defaultManifest,
    materials: [defaultMaterial],
  };
  const expectRefusal = (action: () => void, expected: string): void => {
    let message = "";
    try {
      action();
    } catch (error) {
      message = describeError(error);
    }
    if (message.length === 0) throw new Error(`预期拒绝 ${expected}，却通过了`);
    if (!message.includes(expected))
      throw new Error(`预期拒绝理由 ${expected}，实际 ${message}`);
  };
  return [
    {
      name: "受控验收使用代表资料",
      detail: "默认验收目录、清单与来源模式保持为受控代表组合",
      run: () => {
        const verify = parseRequest(["verify"]);
        if (
          verify.materials.length !== 1 ||
          verify.materials[0] !== defaultMaterial ||
          verify.manifestPath !== defaultManifest ||
          verify.sourceMode !== "controlled"
        )
          throw new Error("受控代表verify必须保持原代表目录及清单");
      },
    },
    {
      name: "真实来源默认关闭",
      detail: "没有显式开关就拒绝，不触达任何来源",
      run: () =>
        expectRefusal(
          () => assertSourceSelection({ ...base, sourceMode: "real" }),
          "真实来源默认关闭",
        ),
    },
    {
      name: "真实来源必须说明条件",
      detail: "只有开关而没有条件同样被拒",
      run: () =>
        expectRefusal(
          () =>
            assertSourceSelection({
              ...base,
              sourceMode: "real",
              allowRealSource: true,
            }),
          "需要说明成立条件",
        ),
    },
    {
      name: "受控清单必须绝对",
      detail: "相对清单路径被拒，不静默落回真实装配",
      run: () =>
        expectRefusal(
          () =>
            assertSourceSelection({
              ...base,
              manifestPath: "fixtures/controlled-source-io/manifest.json",
            }),
          "必须是绝对路径",
        ),
    },
    {
      name: "资料目录必须绝对",
      detail: "相对资料目录被拒，不继承父终端工作目录",
      run: () =>
        expectRefusal(
          () => assertSourceSelection({ ...base, materials: ["fixtures"] }),
          "资料目录必须是绝对路径",
        ),
    },
    {
      name: "预览端口越界被拒",
      detail: "只允许约定的预览端口区间",
      run: () =>
        expectRefusal(() => assertPreviewPort(45_001), "预览端口必须落在"),
    },
    {
      name: "提供的环境不被收尾",
      detail: "--provided 时服务归属与回收路径必须整体关闭",
      run: () => {
        const provided = planOwnership("provided");
        if (provided.ownsService || provided.recycle !== "none")
          throw new Error("调用方提供的环境被安排停止或删除");
      },
    },
    {
      name: "恢复失败记录不取得删除权",
      detail:
        "只有本次运行之前没有记录（unprepared）才排删除；failed 记录可恢复运行、可停自己启动的服务，但记录与载体仍归原使用者",
      run: () => {
        const built = planOwnership("absent");
        if (!built.ownsService || built.recycle !== "delete")
          throw new Error("本次自建环境没有被安排完整回收");
        const recovered = planOwnership("recover");
        if (!recovered.ownsService)
          throw new Error(
            "恢复运行的入口没有取得服务归属，失败时不会停止自有服务",
          );
        if (recovered.recycle !== "stop")
          throw new Error("把上次失败留下的记录与载体当成私有财产删除或复用");
        if (planOwnership("refuse").recycle !== "none")
          throw new Error("他人既有状态被安排回收");
      },
    },
    {
      name: "已有环境按前提拒绝",
      detail:
        "自建与归属只按 inspect 的真实状态判定：无记录（unprepared）才自建，上次准备失败（failed）只按恢复处理，已有世代或他人接管的状态一律拒绝",
      run: () => {
        if (classifyEnvironmentPrecondition("unprepared", false) !== "absent")
          throw new Error("无记录环境没有被判为可自建");
        if (classifyEnvironmentPrecondition("failed", false) !== "recover")
          throw new Error("上次失败的环境没有按恢复处理，删除权会被误取得");
        for (const existing of [
          "prepared",
          "preparing",
          "config-incompatible",
          "unmanaged",
        ] as const)
          if (classifyEnvironmentPrecondition(existing, false) !== "refuse")
            throw new Error(`既有环境 ${existing} 没有被拒绝，可能被删除`);
        if (classifyEnvironmentPrecondition("prepared", true) !== "provided")
          throw new Error("provided 环境被当成了自建环境");
      },
    },
  ];
}

async function runVerify(
  request: PreviewRequest,
  reporter: PreviewReporter,
  running: RunningState,
): Promise<number> {
  const selected = (name: string): boolean =>
    request.cases.length === 0 || request.cases.includes(name);
  if (selected("request-validation"))
    for (const item of requestValidationCases()) {
      try {
        item.run();
        reporter.say(`负项用例通过：${item.name}（${item.detail}）`);
      } catch (error) {
        reporter.fail(`负项用例失败：${item.name}（${describeError(error)}）`);
      }
    }
  const lifecycleCases = request.cases.filter(
    (item) => item !== "request-validation",
  );
  if (request.cases.length > 0 && lifecycleCases.length === 0)
    return reporter.failures.length === 0
      ? exitCodes.okay
      : exitCodes.intakeFailed;

  const staging =
    request.handoffDirectory === undefined
      ? path.join(
          defaultWorkspace,
          ".scratch",
          "preview-verification",
          randomUUID(),
        )
      : path.join(
          request.handoffDirectory,
          "preview",
          request.environment,
          "inputs",
        );
  const subsetDirectory = path.join(staging, "预览子集");
  const multiLeftDirectory = path.join(staging, "多目录甲");
  const multiRightDirectory = path.join(staging, "多目录乙");
  const precondition = await inspectEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
  });
  const kind = classifyEnvironmentPrecondition(
    precondition.state,
    request.provided,
  );
  if (kind === "refuse") {
    reporter.section("归属前提");
    reporter.fact("既有环境状态", precondition.state);
    reporter.fail(
      `环境 ${request.environment} 在本次运行之前已存在（状态 ${precondition.state}），不归本入口所有；verify 绝不复用并删除他人状态，请改用全新环境名，或显式以 --provided 只读协调它。停止与删除仍归原使用者经公共生命周期命令决定。`,
    );
    return exitCodes.operationFailed;
  }
  const ownership = planOwnership(kind);
  running.ownsService = ownership.ownsService;
  const recycle = ownership.recycle;
  if (kind === "recover") {
    reporter.section("归属前提");
    reporter.fact("既有环境状态", precondition.state);
    reporter.say(
      `环境 ${request.environment} 在本次运行之前留下上次准备失败的记录（状态 failed）：本入口按恢复处理——重新准备并拥有本次启动的服务，但那条记录与它的日志、数据载体仍归原使用者，本次成功也不删除它。`,
    );
  }
  if (request.handoffDirectory !== undefined && recycle === "delete") {
    await mkdir(request.handoffDirectory, { recursive: true, mode: 0o700 });
    await appendFile(
      path.join(request.handoffDirectory, "owners.ndjson"),
      `${JSON.stringify({ workspacePath: request.workspacePath, environment: request.environment })}\n`,
      { mode: 0o600 },
    );
  }
  let result: number | undefined;
  try {
    await mkdir(path.dirname(subsetDirectory), { recursive: true });
    await copySubsetMaterial(subsetDirectory);
    await copyMaterialForDirectory(multiLeftDirectory);
    await copyMaterialForDirectory(multiRightDirectory);
    result = await runLifecycleScenarios(
      request,
      reporter,
      running,
      recycle,
      lifecycleCases,
      { subsetDirectory, multiLeftDirectory, multiRightDirectory },
    );
    return result;
  } finally {
    if (
      result === exitCodes.okay &&
      reporter.failures.length === 0 &&
      recycle === "delete" &&
      request.handoffDirectory === undefined &&
      request.signal?.aborted !== true
    )
      await rm(staging, { recursive: true, force: true });
    else reporter.fact("保留验收输入（与环境现场一同供复现）", staging);
  }
}

async function runLifecycleScenarios(
  request: PreviewRequest,
  reporter: PreviewReporter,
  running: RunningState,
  recycle: "delete" | "stop" | "none",
  lifecycleCases: readonly string[],
  staging: {
    readonly subsetDirectory: string;
    readonly multiLeftDirectory: string;
    readonly multiRightDirectory: string;
  },
): Promise<number> {
  let address: string | undefined;
  const ownsService = running.ownsService;
  if (ownsService) {
    reporter.section("建立一次性预览环境");
    const prepared = await runPrepare(request, reporter);
    if (mapEnvironmentStatus(prepared.status) !== exitCodes.okay)
      return mapEnvironmentStatus(prepared.status);
    const started = await runStart(request, reporter);
    running.startedHere = started.status === "ready";
    if (mapEnvironmentStatus(started.status) !== exitCodes.okay)
      return mapEnvironmentStatus(started.status);
    address = observedAddress(started.run.address);
  } else {
    const state = await readEnvironmentState(request, reporter);
    address =
      state.client === undefined
        ? undefined
        : observedAddress(state.inspect.run.address);
    if (address === undefined) {
      reporter.fail("提供的环境没有就绪结论，业务场景未执行。");
      return exitCodes.operationFailed;
    }
  }
  if (address === undefined) {
    reporter.fail("环境报告就绪却没有给出可核验的服务地址，业务场景未执行。");
    return exitCodes.operationFailed;
  }
  await waitForProductReady(address, requestSignal(request));
  const context: ScenarioContext = {
    request,
    reporter,
    serviceAddress: address,
    client: createCorpusClient(address, requestSignal(request)),
    ...staging,
  };
  const assertionCountBefore = reporter.failures.length;
  const wants = (names: readonly string[]): boolean =>
    lifecycleCases.length === 0 ||
    names.some((name) => lifecycleCases.includes(name));
  const steps = [
    {
      when: wants(["first-run"]),
      label: "首次接入与浏览",
      run: scenarioFirstRun,
    },
    {
      when: wants(["first-run", "restart-retention"]),
      label: "人工封面选择",
      run: scenarioManualEdit,
    },
    { when: wants(["subset"]), label: "子集接入", run: scenarioSubset },
    {
      when: wants(["multi-directory"]),
      label: "多目录接入",
      run: scenarioMultiDirectory,
    },
    {
      when: wants(["refused-source-request"]),
      label: "未列入受控清单的来源请求",
      run: scenarioRefusedSourceRequest,
    },
    {
      when: wants(["restart-retention"]),
      label: "重启保留（停止并重启服务）",
      run: scenarioRestartRetention,
    },
    {
      when: wants(["rebuild-inputs-preserved"]),
      label: "显式重建（删除自有产品数据根并提交下一数据世代）",
      run: scenarioRebuild,
    },
  ].filter((step) => step.when);
  try {
    for (const step of steps) {
      if (request.signal?.aborted === true) {
        reporter.say(`已收到取消，剩余场景（从「${step.label}」起）不再执行。`);
        break;
      }
      if (reporter.failures.length > assertionCountBefore) {
        reporter.say(
          `已有未通过的断言，本入口停止后续有副作用的场景（不执行「${step.label}」），保留出现失败时的数据世代与现场供排查与重启。`,
        );
        break;
      }
      await step.run(context);
    }
  } catch (error) {
    // 抛出的失败（含取消）与断言失败走同一个失败保留出口，见下统一判定。
    reporter.fail(`场景执行中断：${describeError(error)}`);
  }
  const failed =
    reporter.failures.length > assertionCountBefore ||
    (request.signal?.aborted ?? false);
  if (failed) {
    reporter.section("按归属收尾（失败或取消保留现场）");
    const cleanupErrors = await finishOwnedFailure(
      request,
      reporter,
      ownsService,
      running.startedHere,
    );
    for (const error of cleanupErrors)
      reporter.say(`收尾错误（不覆盖主错误）：${error}`);
    running.failureFinished = true;
    if (request.signal?.aborted ?? false) {
      // 主结论是被中断：保留现场，不把业务失败码覆盖信号退出码。
      return 0;
    }
    return exitCodes.intakeFailed;
  }
  if (request.evidencePath !== undefined) {
    try {
      await writeEvidence(request, reporter, exitCodes.okay, undefined);
      reporter.say(
        `结构化结果已在任何成功回收之前保存：${request.evidencePath}（最终退出时仍会按真实退出码复写一次）`,
      );
    } catch (error) {
      reporter.fail(
        `结果保存失败（保存错误，不覆盖主错误）：${describeError(error)}。本入口因此不做成功删除，保留原数据世代与现场。`,
      );
      const cleanupErrors = await finishOwnedFailure(
        request,
        reporter,
        ownsService,
        running.startedHere,
      );
      for (const cleanupError of cleanupErrors)
        reporter.say(`收尾错误（不覆盖主错误）：${cleanupError}`);
      running.failureFinished = true;
      return exitCodes.operationFailed;
    }
  }
  if (recycle === "delete") {
    reporter.section("按归属收尾（自建环境）");
    if (request.handoffDirectory === undefined)
      await recycleOwned(request, reporter, running);
    else {
      await ownedStop(request, reporter);
      running.startedHere = false;
      reporter.say(
        "自建环境已停止并保留数据、日志与输入；CI 核实上传后再经公共删除入口回收。",
      );
    }
  } else if (recycle === "stop") {
    reporter.section("按归属收尾（恢复上次失败记录）");
    await ownedStop(request, reporter);
    running.startedHere = false;
    reporter.say(
      "本次运行只停止自己启动的服务；那条失败记录与它的日志、数据载体不属于本入口，未删除，停止与删除仍归原使用者经公共生命周期命令决定。",
    );
  } else reporter.say("环境由调用方提供，本入口未停止、重建或删除它。");
  return exitCodes.okay;
}

async function copySubsetMaterial(target: string): Promise<void> {
  const entries = await readdir(defaultMaterial);
  if (entries.length === 0)
    throw new PreviewUsageError(`代表资料目录为空：${defaultMaterial}`);
  await cp(path.join(defaultMaterial, entries[0] ?? ""), target, {
    recursive: true,
  });
}

/**
 * 多目录场景的每个请求目录都必须让产品自己的目录解释器认得出来源标识：`dlsite.exact-directory`
 * 只认 `RJ…`／`VJ…` 形状的目录名（可为被扫描根本身或其下一层）。把代表资料整体改名叫
 * 「多目录甲」会让两级都不带编号，产品合理地什么都识别不出来，接入断言就成了假的失败，
 * 因此这里保留编号那一层，只在其外面套一层普通目录。
 */
async function copyMaterialForDirectory(targetRoot: string): Promise<void> {
  await mkdir(targetRoot, { recursive: true });
  await cp(
    defaultMaterial,
    path.join(targetRoot, path.basename(defaultMaterial)),
    { recursive: true },
  );
}

export async function writeEvidence(
  request: PreviewRequest,
  reporter: PreviewReporter,
  exit: number,
  mainError: unknown,
): Promise<void> {
  if (request.evidencePath === undefined) return;
  await mkdir(path.dirname(request.evidencePath), { recursive: true });
  await writeFile(
    request.evidencePath,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        command: request.command,
        request: { ...request },
        exit,
        failures: reporter.failures,
        facts: reporter.facts,
        ...(mainError !== undefined
          ? { mainError: describeError(mainError) }
          : {}),
      },
      undefined,
      2,
    )}\n`,
  );
}

export async function main(
  argv: readonly string[],
  cancellation: { readonly signal: AbortSignal } = {
    signal: new AbortController().signal,
  },
): Promise<number> {
  let request: PreviewRequest;
  try {
    request = parseRequest(argv);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return exitCodes.invalidUsage;
  }
  const reporter = new PreviewReporter();
  const running: RunningState = {
    ownsService: false,
    startedHere: false,
    failureFinished: false,
  };
  if (request.command === "help") reporter.lines.push("", usage);
  else
    reporter.say(
      `命令 ${request.command}｜环境 ${request.environment}｜工作区 ${request.workspacePath}`,
    );
  const requestWithSignal: PreviewRequest = {
    ...request,
    signal: cancellation.signal,
  };
  let exit: number = exitCodes.okay;
  let mainError: unknown;
  if (request.command === "verify") {
    try {
      exit = await runVerify(requestWithSignal, reporter, running);
    } catch (error) {
      mainError = error;
      exit =
        error instanceof PreviewUsageError
          ? exitCodes.invalidUsage
          : exitCodes.operationFailed;
    }
  }
  if (mainError !== undefined) reporter.fail(describeError(mainError));
  let cancellationFinished = false;
  // 保存也可能被首次取消打断；已观察取消时独立收尾，保留本次启动的数据与日志。
  const finishCancellation = async (): Promise<boolean> => {
    if (!cancellation.signal.aborted || cancellationFinished) return false;
    cancellationFinished = true;
    const needsEntryCleanup =
      !running.failureFinished && request.command === "verify";
    if (needsEntryCleanup) {
      const cleanupErrors = await finishOwnedFailure(
        requestWithSignal,
        reporter,
        running.ownsService,
        running.startedHere,
      );
      running.failureFinished = true;
      for (const error of cleanupErrors)
        reporter.say(`收尾错误（不覆盖主错误）：${error}`);
    }
    if (mainError === undefined) {
      mainError = new Error("收到中断信号，业务已取消");
      reporter.fail(describeError(mainError));
    }
    exit = interruptedExitCode(cancellation.signal.reason as NodeJS.Signals);
    return true;
  };
  await finishCancellation();
  if (exit === exitCodes.okay && reporter.failures.length > 0) {
    exit = exitCodes.intakeFailed;
  }
  const saveResult = async (): Promise<void> => {
    try {
      await writeEvidence(requestWithSignal, reporter, exit, mainError);
    } catch (error) {
      reporter.fail(
        `结果保存失败（保存错误，不覆盖主错误）：${describeError(error)}`,
      );
      if (exit === exitCodes.okay) exit = exitCodes.operationFailed;
      if (!running.failureFinished && running.startedHere) {
        const cleanupErrors = await finishOwnedFailure(
          requestWithSignal,
          reporter,
          running.ownsService,
          running.startedHere,
        );
        for (const cleanupError of cleanupErrors)
          reporter.say(`收尾错误（不覆盖主错误）：${cleanupError}`);
        running.failureFinished = true;
      }
    }
  };
  await saveResult();
  if (await finishCancellation()) await saveResult();
  reporter.print();
  return exit;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      // 收尾阶段仍被再次中断属于人工最后手段：如实打印后按最近信号立即退出。
      process.stdout.write(
        `收尾仍在进行，再次收到 ${signal}：立即退出（现场可能未收尾，请按归属手动处理）\n`,
      );
      process.exit(interruptedExitCode(signal));
    }
    process.stdout.write(
      `收到 ${signal}：中止进行中的等待，按归属停止本次自有服务并保留数据与日志\n`,
    );
    controller.abort(signal);
  };
  for (const name of ["SIGINT", "SIGTERM"] as const)
    process.on(name, () => onSignal(name));
  try {
    process.exitCode = await main(process.argv.slice(2), {
      signal: controller.signal,
    });
  } finally {
    for (const name of ["SIGINT", "SIGTERM"] as const)
      process.removeAllListeners(name);
  }
}
