/**
 * 开发预览仓库入口：显式组合公开环境操作与正式产品目录接入。
 *
 * 一条命令得到有资料、可浏览的开发预览；prepare / start / inspect / stop / rebuild /
 * delete 仍可单独执行。准备、服务就绪与工作流完成分别报告：本入口只在环境报告就绪
 * 之后通过正常产品 HTTP 入口发起目录接入，并按产品工作流结果判断接入，绝不用就绪
 * 掩盖接入失败，也不按资产数量代产品宣布成功。
 *
 * 来源默认受控：受控清单由使用者显式选择；真实来源必须显式启用并说明成立条件。
 * 自建环境按调用方约定收尾（成功后停止并回收，失败后停止并保留可重启现场）；由他人
 * 提供的环境无论成功、失败还是中断都不被本入口收尾。
 */

import { createHash } from "node:crypto";
import {
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
} from "../packages/environment/src/index.ts";
import { loadControlledSourceIo } from "../packages/test-support/src/source-io.ts";
import {
  createProductClient,
  digestDirectory,
  intakeDirectories,
  type IntakeOutcome,
  type JsonObject,
  type JsonValue,
  type ProductClient,
} from "./preview-product.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
/**
 * 环境把工作区视为一份代码检出：构建产物与产品入口都相对它解析，容器落在
 * `<工作区>/.digital/environments/<环境>`。默认取本仓根，因此换工作区必须换一份检出。
 */
const defaultWorkspace = repositoryRoot;
const defaultMaterial = path.join(
  repositoryRoot,
  "fixtures",
  "controlled-source-io",
  "material",
  "RJ01668691",
);
const defaultManifest = path.join(
  repositoryRoot,
  "fixtures",
  "controlled-source-io",
  "manifest.json",
);
const defaultCoverResponse = path.join(
  repositoryRoot,
  "fixtures",
  "controlled-source-io",
  "responses",
  "dlsite-cover.png",
);
const previewPortFirst = 49_001;
const previewPortLast = 49_999;
const defaultWorkflowTimeoutMs = 300_000;

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
} as const;

export type PreviewSourceMode = "controlled" | "real" | "offline";

export type PreviewRequest = {
  readonly command: string;
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
  readonly skipIntake: boolean;
  readonly cases: readonly string[];
  readonly evidencePath?: string;
};

export class PreviewUsageError extends Error {}

export const usage = `用法：node scripts/preview-environment.ts <命令> [选项]

命令：
  up        准备并启动预览，再通过产品入口完成目录接入（服务保持运行）
  prepare   只执行准备：记录普通输入目录与运行配置，建立产品数据
  start     只启动已准备的环境并等待产品就绪，报告实际地址与日志位置
  inspect   只查看环境的实际状态、输入、来源模式与就绪结论
  intake    只对已就绪的环境执行正式目录接入，不改动环境
  stop      只停止本环境持有的服务，保留数据与日志
  rebuild   只对已停止环境按相同输入与配置重新准备
  delete    只删除已停止环境的自有运行数据与记录
  verify    以一次性自建环境自动跑完预览场景断言，并按归属收尾
  help      打印这份说明后结束，不触碰任何环境

选项：
  --workspace <目录>          代码检出根目录，默认本仓根；运行数据落在 <工作区>/.digital/environments/<环境>
  --environment <名称>        环境名，默认 t07-preview
  --material <目录>           普通资料目录，可重复；默认 06 代表目录
  --source-mode <模式>        controlled（默认）| real | offline
  --manifest <路径>           受控来源清单绝对路径，由使用者显式选择
  --content-identity <身份>   期望的清单内容身份，缺省按清单重算
  --allow-real-source         真实来源的显式开关，必须同时给出 --real-condition
  --real-condition <条件>     真实来源成立条件，可重复
  --port <端口>               只允许 ${String(previewPortFirst)}—${String(previewPortLast)}，缺省取该区间第一个空闲端口
  --timeout-ms <毫秒>         单次环境操作期限
  --workflow-timeout-ms <毫秒> 等待产品工作流终态的期限
  --library <名称>            产品资产库显示名
  --provided                  环境由调用方提供：绝不准备、启动、停止、重建或删除
  --no-intake                 只到服务就绪为止，不发起目录接入
  --case <名称>               只运行指定 verify 场景，可重复
  --evidence <路径>           把结构化结果写入该文件`;

const commandNames = [
  "up",
  "prepare",
  "start",
  "inspect",
  "intake",
  "stop",
  "rebuild",
  "delete",
  "verify",
  "help",
] as const;

const booleanFlags = [
  "--provided",
  "--no-intake",
  "--allow-real-source",
] as const;

const valueOptions = [
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
  const command = argv[0] === "--help" ? "help" : (argv[0] ?? "");
  if (command.length === 0) throw new PreviewUsageError(usage);
  if (!(commandNames as readonly string[]).includes(command))
    throw new PreviewUsageError(`未知命令：${command}\n\n${usage}`);

  const values: Partial<Record<(typeof valueOptions)[number], string>> = {};
  const materials: string[] = [];
  const realConditions: string[] = [];
  const cases: string[] = [];
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if ((booleanFlags as readonly string[]).includes(argument)) {
      flags.add(argument);
      continue;
    }
    if (!(valueOptions as readonly string[]).includes(argument))
      throw new PreviewUsageError(`无法理解的参数：${argument}\n\n${usage}`);
    const value = argv[index + 1];
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
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 0)
      throw new PreviewUsageError(`选项 ${option} 需要非负整数：${raw}`);
    return parsed;
  };
  const sourceMode = values["--source-mode"] ?? "controlled";
  if (!["controlled", "real", "offline"].includes(sourceMode))
    throw new PreviewUsageError(
      `来源模式只能是 controlled、real 或 offline：${sourceMode}`,
    );
  // 输入路径按用户给的字面值校验：静默 resolve 会把相对路径伪装成显式绝对选择。
  const requireAbsolute = (option: string, raw: string): string => {
    if (!path.isAbsolute(raw))
      throw new PreviewUsageError(
        `${option} 需要绝对路径，本入口不按父终端工作目录猜测：${raw}`,
      );
    return raw;
  };
  const requestedPort = readNumber("--port", values["--port"]);
  if (requestedPort !== 0) assertPreviewPort(requestedPort);

  return {
    command,
    workspacePath: path.resolve(values["--workspace"] ?? defaultWorkspace),
    environment: values["--environment"] ?? "t07-preview",
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
    skipIntake: flags.has("--no-intake"),
    cases,
    ...(values["--evidence"] === undefined
      ? {}
      : { evidencePath: path.resolve(values["--evidence"]) }),
  };
}

/** 预览只使用约定的预览端口区间，避免撞上其他并行任务的资源。 */
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
    throw new PreviewUsageError("至少要有一个普通资料目录");
  for (const material of request.materials)
    if (!path.isAbsolute(material))
      throw new PreviewUsageError(`资料目录必须是绝对路径：${material}`);
}

/** 收尾归属判断：只有自己建立且未声明 provided 的环境才被本入口回收。 */
export function planRecycle(input: {
  readonly provided: boolean;
  readonly owned: boolean;
}): boolean {
  return input.owned && !input.provided;
}

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
    profile: "t07-preview",
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
  readonly client?: ProductClient;
}> {
  const inspect = await inspectEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
  });
  reporter.section("查看");
  reporter.fact("环境状态", inspect.state);
  reporter.fact("服务就绪结论", inspect.serviceReadiness);
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
  return { inspect, client: createProductClient(address) };
}

async function runIntake(
  request: PreviewRequest,
  client: ProductClient,
  reporter: PreviewReporter,
  directories: readonly string[] = request.materials,
  libraryName = request.libraryName,
): Promise<IntakeOutcome> {
  reporter.section("目录接入（正式产品入口）");
  const readiness = await client.readiness();
  reporter.fact(
    "产品 /api/ready",
    readiness.ready ? "已就绪" : `未就绪（HTTP ${String(readiness.status)}）`,
  );
  const intake = await intakeDirectories(client, {
    displayName: libraryName,
    directories,
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
    workflowTimeoutMs: request.workflowTimeoutMs,
  });
  reporter.fact("资产库标识", intake.assetLibraryId);
  reporter.fact("观察根", [...intake.observedRootIds]);
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

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
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
): Promise<void> {
  await ownedStop(request, reporter);
  const result = await deleteEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
  });
  for (const line of describeLifecycleResult(result)) reporter.say(line);
  if (result.status === "not-confirmed")
    reporter.fail("无法确认自有数据已清理，保留现场而不宣称回收成功。");
}

type ScenarioContext = {
  readonly request: PreviewRequest;
  readonly reporter: PreviewReporter;
  readonly subsetDirectory: string;
  client: ProductClient;
  subject?: string;
  manualCoverReference?: string;
};

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
  return context.subject;
}

async function scenarioFirstRun(context: ScenarioContext): Promise<void> {
  const { client, reporter } = context;
  const subjectId = await resolveSubject(context);
  const subject = await client.inspectSubject(subjectId);
  check(
    reporter,
    "first-run",
    subject["recognitionState"] === "recognized",
    `产品把代表目录自然识别为已识别内容（实际 ${text(subject["recognitionState"]) ?? "非文本结论"}）`,
  );
  check(
    reporter,
    "first-run",
    JSON.stringify(subject["current"] ?? null).includes("RJ01668691"),
    "浏览用内容携带资料编号 RJ01668691 的真实投影",
  );
  const browse = await client.get("/catalogue", {
    surface: "current-catalogue",
    limit: 50,
  });
  check(
    reporter,
    "first-run",
    browse.status === 200 && JSON.stringify(browse.body).includes(subjectId),
    "内容目录页可浏览到本次接入的主体",
  );
  const detail = await client.get(`/catalogue/${subjectId}`);
  check(
    reporter,
    "first-run",
    detail.status === 200,
    `主体详情返回 HTTP ${String(detail.status)}`,
  );
  const refresh = await client.startRefresh(
    (await client.libraries()).find((library) =>
      library.directories.some((directory) =>
        context.request.materials.includes(directory),
      ),
    )?.id ?? "",
  );
  const execution = await client.awaitExecution(
    refresh,
    context.request.workflowTimeoutMs,
  );
  reporter.fact(
    "再次刷新结论",
    `${execution.status}／${execution.outcome ?? "无"}`,
  );
  check(
    reporter,
    "first-run",
    execution.status === "completed" &&
      (execution.outcome === "accepted" || execution.outcome === "no-change"),
    "再次刷新仍由产品工作流给出终态结论（相同目录不重复收录）",
  );
  const cover = await readManagedCover(client, subjectId, reporter);
  check(reporter, "first-run", cover.ok, cover.detail);
}

/** 封面读取必须逐字节等于清单内已核验的响应，并且来自当前产品数据根。 */
async function readManagedCover(
  client: ProductClient,
  subjectId: string,
  reporter: PreviewReporter,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const choice = await client.coverCandidates(subjectId);
  const candidates = asArray(choice["candidates"]);
  reporter.fact("封面候选", candidates.length);
  const imageUrl = text(
    asObject(
      candidates.find(
        (item) => (text(asObject(item)?.["imageUrl"]) ?? "").length > 0,
      ),
    )?.["imageUrl"],
  );
  if (imageUrl === undefined)
    return {
      ok: false,
      detail: `封面候选 ${String(candidates.length)} 个都没有给出可浏览的图片地址`,
    };
  const delivered = await client.bytes(imageUrl.replace(/^\/api/u, ""));
  if (delivered.status !== 200)
    return {
      ok: false,
      detail: `封面交付 ${imageUrl} 返回 HTTP ${String(delivered.status)}`,
    };
  const expected = await readFile(defaultCoverResponse);
  const digest = createHash("sha256").update(delivered.bytes).digest("hex");
  reporter.fact("封面交付地址", imageUrl);
  reporter.fact("封面交付摘要", `sha256:${digest}`);
  const same =
    delivered.bytes.byteLength === expected.byteLength &&
    delivered.bytes.every(
      (byte, index) => byte === (expected as Uint8Array)[index],
    );
  return same
    ? {
        ok: true,
        detail: `受管封面可读，且与清单响应逐字节相同（${String(delivered.bytes.byteLength)} 字节，${delivered.mediaType ?? "未知类型"}）`,
      }
    : {
        ok: false,
        detail: `封面交付与清单响应不一致（交付 ${String(delivered.bytes.byteLength)} 字节，清单 ${String(expected.byteLength)} 字节）`,
      };
}

async function scenarioManualEdit(context: ScenarioContext): Promise<void> {
  const { client, reporter } = context;
  reporter.section("编辑（人工封面决定）");
  const subjectId = await resolveSubject(context);
  const choice = await client.coverCandidates(subjectId);
  const reference = text(
    asObject(asArray(choice["candidates"])[0])?.["reference"],
  );
  if (reference === undefined) throw new Error("封面候选为空，无法演示编辑");
  const preview = await client.chooseCover({
    entityId: subjectId,
    candidateReference: reference,
  });
  await client.applyPreview(preview.previewId, "开发预览");
  const after = await client.coverCandidates(subjectId);
  check(
    reporter,
    "edit",
    text(after["manualReference"]) === reference,
    `人工封面决定已写入并可回读（${reference}）`,
  );
  context.manualCoverReference = reference;
}

async function scenarioSubset(context: ScenarioContext): Promise<void> {
  const { client, reporter, request } = context;
  reporter.section("同一资料集的子集目录");
  const before = await client.libraries();
  const defaultLibrary = before.find((library) =>
    library.directories.some((directory) =>
      request.materials.includes(directory),
    ),
  );
  const assetsBefore = defaultLibrary?.observedRootIds.length ?? 0;
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
  const observations = await client.get("/observations/unrecognized", {
    limit: 50,
  });
  reporter.fact(
    "未识别观察条目",
    asArray(asObject(observations.body)?.["observations"]).length,
  );
  const after = await client.libraries();
  const stillThere = after.find((library) => library.id === defaultLibrary?.id);
  check(
    reporter,
    "subset",
    stillThere !== undefined &&
      stillThere.observedRootIds.length === assetsBefore &&
      JSON.stringify(stillThere.directories) ===
        JSON.stringify(defaultLibrary?.directories),
    "新增子集目录不改动代表目录的库与观察范围",
  );
}

async function scenarioRefusedSourceRequest(
  context: ScenarioContext,
): Promise<void> {
  const { client, reporter, request } = context;
  reporter.section("未列入受控清单的来源请求");
  const subjectId = await resolveSubject(context);
  const refusal = await client.post("/source-enrichments", {
    subjectId,
    sourceIdentity: "dlsite",
    sourceInput: { product: "RJ01497788" },
  });
  const executionId = text(asObject(refusal.body)?.["id"]);
  if (executionId === undefined)
    throw new Error(`来源补充请求未被受理：${JSON.stringify(refusal.body)}`);
  const execution = await client.awaitExecution(
    executionId,
    request.workflowTimeoutMs,
  );
  const delivered = JSON.stringify(execution.reply);
  check(
    reporter,
    "refused-source-request",
    execution.status === "failed" &&
      !delivered.includes("受控来源拒绝") &&
      !delivered.includes("请求键"),
    "未列入的来源请求在产品工作流里失败，交付视图只给业务原因而不泄露内部边界标识",
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
  await ownedStop(request, reporter);
  const started = await startEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
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
  const libraries = await client.libraries();
  check(
    reporter,
    "restart-retention",
    libraries.some((library) =>
      library.directories.some((directory) =>
        request.materials.includes(directory),
      ),
    ),
    "未重新接入即仍能在资产库里看到本预览的普通目录",
  );
  const subjectId = context.subject ?? "";
  const subject = await client.inspectSubject(subjectId);
  check(
    reporter,
    "restart-retention",
    subject["recognitionState"] === "recognized",
    "重启后内容仍按既有识别结果可浏览",
  );
  if (context.manualCoverReference !== undefined) {
    const choice = await client.coverCandidates(subjectId);
    check(
      reporter,
      "restart-retention",
      text(choice["manualReference"]) === context.manualCoverReference,
      `人工封面决定保留为 ${context.manualCoverReference}`,
    );
  }
}

async function scenarioRebuild(context: ScenarioContext): Promise<void> {
  const { client, reporter, request } = context;
  reporter.section("显式重建");
  if (request.provided) {
    reporter.say("环境由调用方提供，本场景不重建对方的状态。");
    return;
  }
  const before: Record<string, string> = {};
  for (const material of request.materials)
    before[path.basename(material)] = await digestDirectory(material);
  await ownedStop(request, reporter);
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
  const started = await startEnvironment({
    workspacePath: request.workspacePath,
    environment: request.environment,
    ...(request.timeoutMs === 0 ? {} : { timeoutMs: request.timeoutMs }),
  });
  reporter.fact("重建后就绪结论", started.status);
  for (const line of describeLifecycleResult(started)) reporter.say(line);
  if (mapEnvironmentStatus(started.status) !== exitCodes.okay) {
    reporter.fail("重建后未能取得就绪结论。");
    return;
  }
  const intake = await runIntake(request, client, reporter);
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

/** 请求阶段的负项用例：全部在触达任何环境操作之前完成，可无成本重复执行。 */
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
      name: "命令与用法边界",
      detail: "help 是正常命令；缺命令与未知命令按用法失败",
      run: () => {
        if (parseRequest(["help"]).command !== "help")
          throw new Error("help 没有被当作可正常收尾的命令");
        if (parseRequest(["--help"]).command !== "help")
          throw new Error("--help 没有归一到 help");
        expectRefusal(() => parseRequest([]), "用法：node scripts");
        expectRefusal(() => parseRequest(["run"]), "未知命令：run");
        expectRefusal(
          () => parseRequest(["up", "--port", "48999"]),
          "预览端口必须落在",
        );
        expectRefusal(
          () => parseRequest(["up", "--source-mode", "live"]),
          "来源模式只能是",
        );
        expectRefusal(() => parseRequest(["up", "--manifest"]), "缺少取值");
      },
    },
    {
      name: "提供的环境不被收尾",
      detail: "--provided 时回收路径必须整体关闭",
      run: () => {
        if (planRecycle({ provided: true, owned: true }))
          throw new Error("计划回收了调用方提供的环境");
      },
    },
    {
      name: "自建环境才回收",
      detail: "只有 owned 且非 provided 才收尾",
      run: () => {
        if (!planRecycle({ provided: false, owned: true }))
          throw new Error("自建环境没有被安排回收");
        if (planRecycle({ provided: true, owned: false }))
          throw new Error("没有归属却计划回收");
        if (planRecycle({ provided: false, owned: false }))
          throw new Error("没有归属却计划回收");
      },
    },
  ];
}

async function runVerify(
  request: PreviewRequest,
  reporter: PreviewReporter,
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

  const subsetDirectory = path.join(
    repositoryRoot,
    ".scratch",
    "t07-subset",
    "预览子集",
  );
  const owned = planRecycle({ provided: request.provided, owned: true });
  try {
    await rm(path.dirname(subsetDirectory), { recursive: true, force: true });
    await mkdir(path.dirname(subsetDirectory), { recursive: true });
    await copySubsetMaterial(subsetDirectory);
    return await runLifecycleScenarios(
      request,
      reporter,
      owned,
      lifecycleCases,
      subsetDirectory,
    );
  } finally {
    await rm(path.dirname(subsetDirectory), { recursive: true, force: true });
  }
}

async function runLifecycleScenarios(
  request: PreviewRequest,
  reporter: PreviewReporter,
  owned: boolean,
  lifecycleCases: readonly string[],
  subsetDirectory: string,
): Promise<number> {
  let address: string | undefined;
  if (owned) {
    reporter.section("建立一次性预览环境");
    const prepared = await runPrepare(request, reporter);
    if (mapEnvironmentStatus(prepared.status) !== exitCodes.okay)
      return mapEnvironmentStatus(prepared.status);
    const started = await runStart(request, reporter);
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
  const context: ScenarioContext = {
    request,
    reporter,
    client: createProductClient(address),
    subsetDirectory,
  };
  try {
    if (lifecycleCases.length === 0 || lifecycleCases.includes("first-run"))
      await scenarioFirstRun(context);
    if (
      lifecycleCases.length === 0 ||
      lifecycleCases.includes("first-run") ||
      lifecycleCases.includes("restart-retention")
    )
      await scenarioManualEdit(context);
    if (lifecycleCases.length === 0 || lifecycleCases.includes("subset"))
      await scenarioSubset(context);
    if (
      lifecycleCases.length === 0 ||
      lifecycleCases.includes("refused-source-request")
    )
      await scenarioRefusedSourceRequest(context);
    if (
      lifecycleCases.length === 0 ||
      lifecycleCases.includes("restart-retention")
    )
      await scenarioRestartRetention(context);
    if (
      lifecycleCases.length === 0 ||
      lifecycleCases.includes("rebuild-inputs-preserved")
    )
      await scenarioRebuild(context);
    if (owned) {
      reporter.section("按归属收尾（自建环境）");
      await recycleOwned(request, reporter);
    } else reporter.say("环境由调用方提供，本入口未停止、重建或删除它。");
  } catch (error) {
    if (owned) {
      reporter.section("按归属收尾（失败保留现场）");
      try {
        await ownedStop(request, reporter);
      } catch (cleanupError) {
        reporter.fail(
          `停止自有服务失败（不覆盖主错误）：${describeError(cleanupError)}`,
        );
      }
      reporter.say(
        "失败现场的数据与日志按调用方约定保留，可用 start 显式重启查看，不宣称已回收。",
      );
    }
    throw error;
  }
  return reporter.failures.length === 0
    ? exitCodes.okay
    : exitCodes.intakeFailed;
}

async function copySubsetMaterial(target: string): Promise<void> {
  const entries = await readdir(defaultMaterial);
  if (entries.length === 0)
    throw new PreviewUsageError(`代表资料目录为空：${defaultMaterial}`);
  await cp(path.join(defaultMaterial, entries[0] ?? ""), target, {
    recursive: true,
  });
}

function reportPreviewHandoff(
  request: PreviewRequest,
  client: ProductClient,
  intake: IntakeOutcome,
  reporter: PreviewReporter,
): void {
  reporter.section("开发预览可用");
  reporter.fact("浏览地址", client.address);
  reporter.fact(
    "资产库",
    `${intake.assetLibraryId}（接入资产 ${String(intake.assetIds.length)} 个）`,
  );
  reporter.say(
    "停止服务：node scripts/preview-environment.ts stop --workspace " +
      `${request.workspacePath} --environment ${request.environment}`,
  );
  reporter.say(
    "再次启动（保留修改，无需重新接入）：node scripts/preview-environment.ts start --workspace " +
      `${request.workspacePath} --environment ${request.environment}`,
  );
}

async function runSingleCommand(
  request: PreviewRequest,
  reporter: PreviewReporter,
): Promise<number> {
  switch (request.command) {
    case "prepare": {
      if (request.provided)
        throw new PreviewUsageError(
          "--provided 表示环境由调用方管理，本入口不准备",
        );
      const prepared = await runPrepare(request, reporter);
      return mapEnvironmentStatus(prepared.status);
    }
    case "start": {
      if (request.provided)
        throw new PreviewUsageError(
          "--provided 表示环境由调用方管理，本入口不启动",
        );
      return mapEnvironmentStatus((await runStart(request, reporter)).status);
    }
    case "stop": {
      if (request.provided)
        throw new PreviewUsageError("--provided 的环境不由本入口停止");
      const result = await stopEnvironment({
        workspacePath: request.workspacePath,
        environment: request.environment,
      });
      for (const line of describeLifecycleResult(result)) reporter.say(line);
      return mapEnvironmentStatus(result.status);
    }
    case "rebuild": {
      if (request.provided)
        throw new PreviewUsageError("--provided 的环境不由本入口重建");
      const result = await rebuildEnvironment({
        workspacePath: request.workspacePath,
        environment: request.environment,
      });
      for (const line of describeLifecycleResult(result)) reporter.say(line);
      return mapEnvironmentStatus(result.status);
    }
    case "delete": {
      if (request.provided)
        throw new PreviewUsageError("--provided 的环境不由本入口删除");
      const result = await deleteEnvironment({
        workspacePath: request.workspacePath,
        environment: request.environment,
      });
      for (const line of describeLifecycleResult(result)) reporter.say(line);
      return mapEnvironmentStatus(result.status);
    }
    case "inspect":
      return mapEnvironmentStatus(
        (await readEnvironmentState(request, reporter)).inspect.status ?? "ok",
      );
    case "intake": {
      const { client } = await readEnvironmentState(request, reporter);
      if (client === undefined) {
        reporter.fail(
          "服务没有就绪结论，本入口不发起目录接入，也不代替产品判定成功。",
        );
        return exitCodes.operationFailed;
      }
      const intake = await runIntake(request, client, reporter);
      return intake.assetIds.length === 0
        ? exitCodes.intakeFailed
        : exitCodes.okay;
    }
    case "up": {
      let client: ProductClient | undefined;
      if (!request.provided) {
        const prepared = await runPrepare(request, reporter);
        if (mapEnvironmentStatus(prepared.status) !== exitCodes.okay)
          return mapEnvironmentStatus(prepared.status);
        const started = await runStart(request, reporter);
        if (mapEnvironmentStatus(started.status) !== exitCodes.okay)
          return mapEnvironmentStatus(started.status);
        const address = observedAddress(started.run.address);
        if (address === undefined) {
          reporter.fail(
            "环境报告就绪却没有给出可核验的服务地址，接入阶段未执行。",
          );
          return exitCodes.operationFailed;
        }
        client = createProductClient(address);
      } else {
        const state = await readEnvironmentState(request, reporter);
        client = state.client;
        if (client === undefined) {
          reporter.fail("提供的环境没有就绪结论，接入阶段未执行。");
          return exitCodes.operationFailed;
        }
      }
      if (request.skipIntake) return exitCodes.okay;
      const intake = await runIntake(request, client, reporter);
      reportPreviewHandoff(request, client, intake, reporter);
      return intake.assetIds.length === 0
        ? exitCodes.intakeFailed
        : exitCodes.okay;
    }
    case "help":
      reporter.lines.push("", usage);
      return exitCodes.okay;
    default:
      throw new PreviewUsageError(`未知命令：${request.command}`);
  }
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

export async function main(argv: readonly string[]): Promise<number> {
  let request: PreviewRequest;
  try {
    request = parseRequest(argv);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return exitCodes.invalidUsage;
  }
  const reporter = new PreviewReporter();
  reporter.say(
    `命令 ${request.command}｜环境 ${request.environment}｜工作区 ${request.workspacePath}`,
  );
  let exit: number = exitCodes.okay;
  let mainError: unknown;
  try {
    exit =
      request.command === "verify"
        ? await runVerify(request, reporter)
        : await runSingleCommand(request, reporter);
  } catch (error) {
    mainError = error;
    exit =
      error instanceof PreviewUsageError
        ? exitCodes.invalidUsage
        : exitCodes.operationFailed;
  }
  if (mainError !== undefined) reporter.fail(describeError(mainError));
  await writeEvidence(request, reporter, exit, mainError);
  reporter.print();
  if (exit === exitCodes.okay && reporter.failures.length > 0) {
    process.stderr.write("存在未通过的断言或收尾告警\n");
    return exitCodes.intakeFailed;
  }
  return exit;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const signals = new Set<string>();
  for (const name of ["SIGINT", "SIGTERM"] as const)
    process.on(name, () => {
      // 信号只中止本次尚未完成的等待：已完成并发布的环境世代继续由环境记录持有。
      process.stdout.write(
        `收到 ${name}：本入口不撤销已发布的服务；若需要停止自有服务请随后执行 stop\n`,
      );
      if (signals.has(name)) process.exit(exitCodes.interrupted);
      signals.add(name);
      process.exitCode = name === "SIGINT" ? exitCodes.interrupted : 143;
    });
  process.exitCode = await main(process.argv.slice(2));
}
