import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deleteEnvironment,
  inspectEnvironment,
  prepareEnvironment,
  startEnvironment,
  stopEnvironment,
  type DeleteOperationResult,
  type EnvironmentFacts,
  type EnvironmentRunFacts,
  type InspectEnvironmentResult,
  type JsonValue,
  type PrepareEnvironmentRequest,
  type PrepareOperationResult,
  type StartOperationResult,
  type StopOperationResult,
} from "@digital/environment";
import { loadControlledSourceIo } from "@digital/test-support/source-io";

/** 场景自己声明的来源装配选择；环境只转达，不代替场景选择来源。 */
export type ScenarioSource =
  | { readonly mode: "offline" }
  | { readonly mode: "real" }
  | { readonly mode: "controlled"; readonly manifestPath: string };

/** 交给验收运行器的环境：产品根、来源选择与子进程基础环境都来自记录的事实。 */
export type AcceptanceEnvironment = {
  readonly workspacePath: string;
  readonly environment: string;
  readonly productDataRoot: string;
  readonly facts: EnvironmentFacts;
  /** 正式 CLI 子进程的基础环境：白名单变量加上本环境记录的产品根与来源选择。 */
  readonly baseEnvironment: Readonly<Record<string, string>>;
};

/** 自有场景世代：由调用方经公开准备接口得到，回收责任也在调用方。 */
export type ScenarioEnvironment = AcceptanceEnvironment & {
  readonly preparation: PrepareOperationResult;
};

/** 一次公开环境操作给出的失败；保留阶段、退出码与日志，供调用方与首因并列报告。 */
export type EnvironmentOperationProblem = {
  readonly operation: "prepare" | "start" | "stop" | "delete" | "inspect";
  readonly status: string;
  readonly stage?: string;
  readonly message: string;
  readonly exitCode: number | null;
  readonly logs: readonly string[];
  readonly diagnostics: readonly string[];
};

export class EnvironmentOperationError extends Error {
  readonly problem: EnvironmentOperationProblem;

  constructor(problem: EnvironmentOperationProblem) {
    super(
      `环境 ${problem.operation} 未成功：status=${problem.status}` +
        `${problem.stage === undefined ? "" : ` stage=${problem.stage}`} ` +
        `exit=${String(problem.exitCode)} ${problem.message}`,
    );
    this.name = "EnvironmentOperationError";
    this.problem = problem;
  }
}

const environmentNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** 调用方自有前缀的环境名：并行场景与开发环境靠名字与容器目录互不重叠。 */
export function scenarioEnvironmentName(input: {
  readonly purpose: string;
  readonly runId: string;
}): string {
  const slug = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9._-]/gu, "-");
  const runId = slug(input.runId);
  const purpose = slug(input.purpose);
  const budget = 64 - `t11--${runId}`.length;
  const kept =
    purpose.length <= budget
      ? purpose
      : `${purpose.slice(0, Math.max(1, budget - 9))}-${digest8(purpose)}`;
  const candidate = `t11-${kept}-${runId}`;
  if (candidate.length > 64)
    throw new Error(`环境名超出 64 个字符上限：${candidate}`);
  if (!environmentNamePattern.test(candidate))
    throw new Error(`环境名不符合环境包命名规则：${candidate}`);
  return candidate;
}

function digest8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

async function sourceSelectionConfig(
  source: ScenarioSource,
): Promise<Record<string, JsonValue>> {
  if (source.mode !== "controlled") return {};
  const manifestPath = path.resolve(source.manifestPath);
  const loaded = await loadControlledSourceIo({ manifestPath });
  return {
    sourceIo: {
      manifestPath,
      contentIdentity: loaded.contentIdentity,
    },
  };
}

/**
 * 从环境记录的事实派生子进程来源选择变量。托管世代的每一种选择都必须显式声明：
 * 缺失即视为父终端遗留配置，直接拒绝而不是落回真实来源。
 */
function sourceVariables(
  facts: EnvironmentFacts,
): Readonly<Record<string, string>> {
  if (facts.sourceMode === "offline")
    return { DIGITAL_SOURCE_IO_MODE: "offline" };
  if (facts.sourceMode === "real") return { DIGITAL_SOURCE_IO_MODE: "real" };
  if (facts.sourceMode !== "controlled")
    throw new Error(
      `环境记录了无法转达的来源模式：${JSON.stringify(facts.sourceMode)}`,
    );
  const manifestPath = recordedText(facts.config.sourceIo, "manifestPath");
  const contentIdentity = recordedText(
    facts.config.sourceIo,
    "contentIdentity",
  );
  if (manifestPath === undefined || contentIdentity === undefined)
    throw new Error("受控环境的记录缺少清单路径或内容身份");
  return {
    DIGITAL_SOURCE_IO_MODE: "controlled",
    DIGITAL_SOURCE_IO_CONFIG: manifestPath,
    DIGITAL_SOURCE_IO_IDENTITY: contentIdentity,
  };
}

/** 从记录的 JSON 配置里读取一个字符串字段；数组与非对象一律视为缺失。 */
function recordedText(
  value: JsonValue | undefined,
  field: string,
): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  for (const [name, item] of Object.entries(value)) {
    if (name !== field) continue;
    return typeof item === "string" ? item : undefined;
  }
  return undefined;
}

/**
 * 交给正式 CLI 子进程的环境：只带白名单变量。父终端的产品根、来源模式、端口与
 * NODE_OPTIONS 一律不继承，避免遗留配置让场景意外使用其他产品数据或真实来源。
 */
export function scenarioCommandEnvironment(
  facts: EnvironmentFacts,
): Readonly<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    DIGITAL_PRODUCT_DATA: facts.productDataRoot,
    ...sourceVariables(facts),
  };
}

const authoritativeVariables = [
  "DIGITAL_PRODUCT_DATA",
  "DIGITAL_SOURCE_IO_MODE",
  "DIGITAL_SOURCE_IO_CONFIG",
  "DIGITAL_SOURCE_IO_IDENTITY",
] as const;

export type MergedCommandEnvironment = {
  readonly env: Readonly<Record<string, string>>;
  /** 场景声明的变量与环境记录不一致的键：产品资源归属始终属于环境。 */
  readonly overridden: readonly string[];
};

export function mergeCommandEnvironment(
  environment: AcceptanceEnvironment,
  extra: Readonly<Record<string, string>> | undefined,
): MergedCommandEnvironment {
  const merged: Record<string, string> = { ...environment.baseEnvironment };
  const overridden: string[] = [];
  for (const [key, value] of Object.entries(extra ?? {})) {
    if ((authoritativeVariables as readonly string[]).includes(key)) {
      if (merged[key] !== value) overridden.push(key);
      continue;
    }
    merged[key] = value;
  }
  return { env: merged, overridden };
}

function prepareProblem(
  result: PrepareOperationResult,
): EnvironmentOperationProblem {
  const failure = result.failure;
  return {
    operation: "prepare",
    status: result.status,
    ...(failure === undefined
      ? { message: result.incompatibility?.join("；") ?? "", exitCode: null }
      : {
          stage: failure.stage,
          message: failure.message,
          exitCode: failure.exitCode,
        }),
    logs: result.logs.files,
    diagnostics: result.diagnostics,
  };
}

export async function prepareScenarioEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly source: ScenarioSource;
  readonly inputs?: readonly string[];
  readonly webPort?: number;
  readonly signal?: AbortSignal;
}): Promise<ScenarioEnvironment> {
  const config: Record<string, JsonValue> = await sourceSelectionConfig(
    input.source,
  );
  if (input.webPort !== undefined) config.webPort = input.webPort;
  const request: PrepareEnvironmentRequest = {
    workspacePath: input.workspacePath,
    environment: input.environment,
    sourceMode: input.source.mode,
    config,
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const preparation = await prepareEnvironment(request);
  if (preparation.status !== "prepared")
    throw new EnvironmentOperationError(prepareProblem(preparation));
  return {
    workspacePath: preparation.environment.workspacePath,
    environment: preparation.environment.environment,
    productDataRoot: preparation.environment.productDataRoot,
    facts: preparation.environment,
    baseEnvironment: scenarioCommandEnvironment(preparation.environment),
    preparation,
  };
}

export async function startScenarioEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly signal?: AbortSignal;
}): Promise<StartOperationResult> {
  return await startEnvironment({
    workspacePath: input.workspacePath,
    environment: input.environment,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export function stopScenarioEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<StopOperationResult> {
  return stopEnvironment(input);
}

export function deleteScenarioEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<DeleteOperationResult> {
  return deleteEnvironment(input);
}

export function inspectScenarioEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<InspectEnvironmentResult> {
  return inspectEnvironment(input);
}

/**
 * 独立确认收尾：只采信公开查看给出的进程存活与就绪结论。端口能否连上、记录里是否
 * 写了 ended 都不算退出证明；无法确认时保留为未确认，绝不改写成已退出。
 */
export type OwnerExitConfirmation = {
  readonly confirmed: boolean;
  readonly state: InspectEnvironmentResult["state"];
  readonly processLiveness: string;
  readonly serviceReadiness: InspectEnvironmentResult["serviceReadiness"];
  readonly detail: string;
};

export async function confirmOwnerExit(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<OwnerExitConfirmation> {
  const inspected = await inspectEnvironment(input);
  const exited =
    inspected.run.state === "absent" ||
    inspected.run.processLiveness === "exited" ||
    inspected.run.processLiveness === "absent";
  const notServing =
    inspected.serviceReadiness === "not-ready" ||
    inspected.serviceReadiness === "not-evaluated";
  // 没有记录的世代（未准备/非本管理器）没有任何可确认的进程，一律回到未确认。
  const recorded =
    inspected.state === "prepared" || inspected.state === "failed";
  return {
    confirmed: recorded && exited && notServing,
    state: inspected.state,
    processLiveness: inspected.run.processLiveness,
    serviceReadiness: inspected.serviceReadiness,
    detail:
      `state=${inspected.state} run.state=${inspected.run.state} ` +
      `liveness=${inspected.run.processLiveness} readiness=${inspected.serviceReadiness}` +
      (inspected.runProblem === undefined
        ? ""
        : ` runProblem=${inspected.runProblem}`),
  };
}

/**
 * 调用方提供的（provided）环境：只按公开查看接受既有世代，绝不准备、启动、停止、
 * 重建或删除。数据根、来源选择与运行分支都取自环境包记录的事实。
 */
export type ProvidedEnvironment = AcceptanceEnvironment & {
  readonly inspection: InspectEnvironmentResult;
};

export class ProvidedEnvironmentUnavailable extends Error {
  readonly inspection: InspectEnvironmentResult;

  constructor(inspection: InspectEnvironmentResult) {
    super(
      `提供的环境不可采信：status=${inspection.status} state=${inspection.state}` +
        `${inspection.reason === undefined ? "" : ` ${inspection.reason}`}`,
    );
    this.name = "ProvidedEnvironmentUnavailable";
    this.inspection = inspection;
  }
}

export async function openProvidedEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<ProvidedEnvironment> {
  const inspection = await inspectScenarioEnvironment(input);
  if (
    inspection.status !== "ok" ||
    inspection.state === "unmanaged" ||
    inspection.environment.productDataRoot.length === 0
  )
    throw new ProvidedEnvironmentUnavailable(inspection);
  return {
    workspacePath: inspection.environment.workspacePath,
    environment: inspection.environment.environment,
    productDataRoot: inspection.environment.productDataRoot,
    facts: inspection.environment,
    baseEnvironment: scenarioCommandEnvironment(inspection.environment),
    inspection,
  };
}

/**
 * 一次 provided 收尾：只有查看，并如实指出无法确认的部分。它复用自己的环境的
 * 收尾形状，但停止、退出确认与删除一律缺席，好让证据无法把 provided 写成已回收。
 */
export type ProvidedRetention = OwnedRecycling & {
  /** 调用方对 provided 环境实际执行过的公开操作：只可能是查看。 */
  readonly performedOperations: readonly string[];
  readonly fingerprint: EnvironmentFingerprint;
  readonly serviceReadiness: string;
};

export async function retainProvidedEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly outcome: OwnedRecycling["outcome"];
}): Promise<ProvidedRetention> {
  const inspection = await inspectScenarioEnvironment(input);
  const fingerprint = await fingerprintEnvironment(input);
  const problems: string[] = [];
  if (inspection.status !== "ok" || inspection.state === "unmanaged")
    problems.push(
      `提供的环境收尾无法确认归属：status=${inspection.status} state=${inspection.state}`,
    );
  if (inspection.runProblem !== undefined)
    problems.push(
      `提供的环境运行分支未能确认：readiness=${inspection.serviceReadiness} ${inspection.runProblem}`,
    );
  return {
    outcome: input.outcome,
    problems,
    recyclingDiagnostics: [
      `provided 环境只执行查看：readiness=${inspection.serviceReadiness} ` +
        `liveness=${inspection.run.processLiveness} port=${String(inspection.run.port)}；` +
        "未停止、未重建、未删除，世代由所有者继续持有",
    ],
    retainedDataRoot: inspection.environment.productDataRoot,
    retainedLogs: [],
    performedOperations: ["inspect"],
    fingerprint,
    serviceReadiness: inspection.serviceReadiness,
  };
}

/** 供归属核验的环境快照：身份、数据世代、运行分支与容器内文件清单。 */
export type EnvironmentFingerprint = {
  readonly state: string;
  readonly environmentId: string | null;
  readonly dataGeneration: string | null;
  readonly sourceMode: string;
  readonly runId: string | null;
  readonly runState: string;
  readonly processLiveness: string;
  readonly serviceReadiness: string;
  readonly port: number | null;
  readonly logFiles: readonly string[];
};

export async function fingerprintEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<EnvironmentFingerprint> {
  const inspected = await inspectEnvironment(input);
  return {
    state: inspected.state,
    environmentId: inspected.environment.environmentId,
    dataGeneration: inspected.environment.dataGeneration,
    sourceMode: inspected.environment.sourceMode,
    runId: inspected.run.runId,
    runState: inspected.run.state,
    processLiveness: inspected.run.processLiveness,
    serviceReadiness: inspected.serviceReadiness,
    port: inspected.run.port,
    logFiles: await listFiles(inspected.environment.containerDirectory),
  };
}

async function listFiles(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) found.push(path.relative(root, next));
    }
  }
  await walk(root);
  return found.toSorted();
}

export function fingerprintDifference(
  before: EnvironmentFingerprint,
  after: EnvironmentFingerprint,
): readonly string[] {
  const differences: string[] = [];
  for (const key of [
    "state",
    "environmentId",
    "dataGeneration",
    "sourceMode",
    "runId",
    "runState",
    "processLiveness",
    "serviceReadiness",
    "port",
  ] as const) {
    const left = before[key];
    const right = after[key];
    if (left !== right)
      differences.push(`${key}: ${String(left)} → ${String(right)}`);
  }
  if (before.logFiles.join("\n") !== after.logFiles.join("\n"))
    differences.push("容器内文件清单发生变化");
  return differences;
}

export const reservedPortRange = { min: 50_001, max: 50_999 } as const;

/**
 * 端口只在真正要启动一个由本工单拥有的服务时按空闲结果选定：先真实 bind 再释放，
 * 让环境包自己占有它，避免与其他并行工单的私有端口重叠。
 */
export async function reserveFreePort(input: {
  readonly exclude?: readonly number[];
  readonly runId: string;
}): Promise<number> {
  const excluded = new Set(input.exclude ?? []);
  const span = reservedPortRange.max - reservedPortRange.min + 1;
  const offset = hashInt(input.runId) % span;
  for (let attempt = 0; attempt < span; attempt += 1) {
    const candidate = reservedPortRange.min + ((offset + attempt * 37) % span);
    if (excluded.has(candidate)) continue;
    if (await portIsFree(candidate)) return candidate;
  }
  throw new Error(`在 50001—50999 区间内找不到可用端口（轮次 ${input.runId}）`);
}

function hashInt(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

async function portIsFree(port: number): Promise<boolean> {
  const server = net.createServer();
  return await new Promise((resolve) => {
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

export type OwnedRecycling = {
  readonly outcome: "success" | "failure" | "interrupted";
  readonly stop?: StopOperationResult;
  readonly exitConfirmation?: OwnerExitConfirmation;
  readonly deletion?: DeleteOperationResult;
  /** 收尾各环节的独立可见问题；不与首因合并，也不掩盖首因。 */
  readonly problems: readonly string[];
  /** 公开环境操作给出的收尾叙述；如实记录但不算失败。 */
  readonly recyclingDiagnostics: readonly string[];
  readonly retainedDataRoot?: string;
  readonly retainedLogs: readonly string[];
};

function recyclingProblems(
  stopped: StopOperationResult,
  confirmation: OwnerExitConfirmation,
): string[] {
  const problems: string[] = [];
  const failure = stopped.failure;
  if (stopped.status === "not-confirmed" || !confirmation.confirmed)
    problems.push(
      `收尾停止未确认：stop=${stopped.status} ${confirmation.detail}` +
        (failure === undefined ? "" : ` ${failure.message}`),
    );
  if (stopped.status === "invalid-request" || stopped.status === "unmanaged")
    problems.push(
      `收尾停止未被接受：stop=${stopped.status}` +
        (failure === undefined ? "" : ` ${failure.message}`),
    );
  for (const error of stopped.cleanup.errors)
    problems.push(`收尾停止的清理错误：${error}`);
  return problems;
}

/**
 * 自有环境的回收：保存结果之后先停止，再由独立查看确认退出，成功才删除。
 * 失败或中断只停止并保留可显式重启的数据与日志；无法确认退出时既不删除，
 * 也绝不把未确认写成已退出。
 */
export async function recycleOwnedEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly outcome: OwnedRecycling["outcome"];
}): Promise<OwnedRecycling> {
  const stopped = await stopScenarioEnvironment(input);
  const confirmation = await confirmOwnerExit(input);
  const problems = recyclingProblems(stopped, confirmation);
  const retainedLogs = stopped.logs.files;
  const diagnostics = [...stopped.diagnostics];
  if (input.outcome !== "success")
    return {
      outcome: input.outcome,
      stop: stopped,
      exitConfirmation: confirmation,
      problems,
      recyclingDiagnostics: diagnostics,
      retainedDataRoot: stopped.environment.productDataRoot,
      retainedLogs,
    };
  if (!confirmation.confirmed)
    return {
      outcome: input.outcome,
      stop: stopped,
      exitConfirmation: confirmation,
      problems,
      recyclingDiagnostics: diagnostics,
      retainedDataRoot: stopped.environment.productDataRoot,
      retainedLogs,
    };
  const deletion = await deleteScenarioEnvironment(input);
  if (deletion.status !== "deleted" && deletion.status !== "already-deleted")
    problems.push(
      `临时数据删除未完成：delete=${deletion.status} ${deletion.failure?.message ?? ""}`,
    );
  for (const error of deletion.cleanup.errors)
    problems.push(`删除自有环境的清理错误：${error}`);
  return {
    outcome: input.outcome,
    stop: stopped,
    exitConfirmation: confirmation,
    deletion,
    problems,
    recyclingDiagnostics: [...diagnostics, ...deletion.diagnostics],
    retainedLogs,
  };
}

/** 每次启动前必须登记的资源归属；先写 intent（工作区/环境/端口），再写 result。 */
export type StartLedgerRecord = {
  readonly phase: "intent" | "result" | "release";
  readonly workspacePath: string;
  readonly environment: string;
  readonly port: number;
  readonly at: string;
  readonly runId?: string;
  readonly status?: string;
  readonly pid?: number | null;
  readonly exitCode?: number | null;
};

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));

/** 本票独占的启动登记表：位于作者树 run/ 下，前缀 11-。 */
export const startLedgerPath = path.resolve(
  runtimeRoot,
  "..",
  "..",
  "..",
  "..",
  "run",
  "11-start-ledger.ndjson",
);

export async function appendStartLedger(
  ledgerPath: string,
  record: StartLedgerRecord,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
}

/** 一次场景世代短标识：进入环境名，也让并行场景互不重叠。 */
export function scenarioRunId(): string {
  return `${Date.now().toString(36)}${createHash("sha256")
    .update(String(process.pid) + Math.random())
    .digest("hex")
    .slice(0, 4)}`;
}

/**
 * 只给验收单元/归属测试构造一个不经环境包的场景环境形状：用于检查调用方的归属与
 * 收尾分支，不用于任何正式 CLI 运行。
 */
export function stubScenarioEnvironment(input: {
  readonly workspacePath: string;
  readonly environment?: string;
  readonly sourceMode?: ScenarioSource["mode"];
}): ScenarioEnvironment {
  const environment = input.environment ?? "t11-stub";
  const facts: EnvironmentFacts = {
    workspacePath: input.workspacePath,
    environment,
    environmentId: null,
    containerDirectory: path.join(
      input.workspacePath,
      ".digital",
      "environments",
      environment,
    ),
    productDataRoot: path.join(
      input.workspacePath,
      ".digital",
      "environments",
      environment,
      "product-data",
    ),
    inputs: [],
    sourceMode: input.sourceMode ?? "offline",
    config: {},
    dataGeneration: null,
  };
  return {
    workspacePath: input.workspacePath,
    environment,
    productDataRoot: facts.productDataRoot,
    facts,
    baseEnvironment: scenarioCommandEnvironment(facts),
    preparation: {
      kind: "prepare",
      status: "prepared",
      environment: facts,
      cleanup: { state: "not-started", errors: [] },
      logs: { directory: null, files: [] },
      diagnostics: [],
    },
  };
}

/** 一次成功的自有环境收尾形状，供只关心主路径与错误分离的测试复用。 */
export function stubRecycling(
  outcome: OwnedRecycling["outcome"],
  overrides: Partial<OwnedRecycling> = {},
): OwnedRecycling {
  return {
    outcome,
    problems: [],
    recyclingDiagnostics: [],
    retainedLogs: [],
    ...overrides,
  };
}

/** 构造一个已删除的公开结果形状，供只核验调用方收尾分支的单元测试复用。 */
export const stubRunFacts: EnvironmentRunFacts = {
  runId: null,
  state: "absent",
  address: null,
  port: null,
  productLogFile: null,
  logHealth: null,
  pid: null,
  processLiveness: "exited",
  controlReachable: false,
  serviceReady: null,
  startedAt: null,
  updatedAt: null,
  endedAt: null,
};

export function stubDeletion(
  environment: EnvironmentFacts,
): DeleteOperationResult {
  return {
    kind: "delete",
    status: "deleted",
    environment,
    run: stubRunFacts,
    cleanup: { state: "released", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}
