import {
  createLayout,
  normalizeInputDirectories,
  webPortProblem,
} from "./paths.ts";
import type { ControlState } from "./private-control.ts";
import {
  canonicalJson,
  type EnvironmentRecord,
  type EnvironmentRunRecord,
  type JsonValue,
  type RecordedLogHealth,
} from "./record.ts";
import { validateSourceSelection } from "./source-selection.ts";

export const operationMarker = "DIGITAL_ENVIRONMENT_RESULT_V1" as const;

/**
 * 公开操作的取消条件。`signal` 是调用方持有的取消条件，`timeoutMs` 是本次操作的
 * 期限；期限在发起时刻换算为绝对终点随载荷交给持锁操作进程，因此执行进程自己也会
 * 真实到期，而不是只有父端放弃等待。
 */
export type PublicCancellation = {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
};

/** 载荷与操作进程之间约定的绝对期限（epoch 毫秒）。 */
export type DeadlineRequest = {
  /** 本次操作的绝对期限；缺失表示调用方没有施加期限。 */
  readonly deadlineAt?: number | undefined;
};

/** 内核实际需要的取消条件：换算后的绝对期限与调用方持有的取消。 */
export type KernelCancellation = {
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAt?: number | undefined;
};

export type PrepareRequest = {
  readonly kind: "prepare";
  readonly workspacePath: string;
  readonly environment: string;
  readonly inputs: readonly string[];
  readonly sourceMode: string;
  readonly config: { readonly [key: string]: JsonValue };
} & DeadlineRequest;

export type StartRequest = {
  readonly kind: "start";
  readonly runtime?: "production" | "development";
  readonly developmentSession?: string;
  readonly workspacePath: string;
  readonly environment: string;
} & DeadlineRequest;

export type StopRequest = {
  readonly kind: "stop";
  readonly developmentSession?: string;
  readonly workspacePath: string;
  readonly environment: string;
} & DeadlineRequest;

export type RebuildRequest = {
  readonly kind: "rebuild";
  readonly workspacePath: string;
  readonly environment: string;
} & DeadlineRequest;

export type DeleteRequest = {
  readonly kind: "delete";
  readonly workspacePath: string;
  readonly environment: string;
} & DeadlineRequest;

export type OperationRequest =
  | PrepareRequest
  | StartRequest
  | StopRequest
  | RebuildRequest
  | DeleteRequest;

export type EnvironmentFacts = {
  readonly workspacePath: string;
  readonly environment: string;
  readonly environmentId: string | null;
  readonly containerDirectory: string;
  readonly productDataRoot: string;
  readonly inputs: readonly string[];
  readonly sourceMode: string;
  readonly config: { readonly [key: string]: JsonValue };
  readonly dataGeneration: string | null;
};

export type PrepareFailure = {
  readonly stage:
    | "request"
    | "claim"
    | "build"
    | "migrate"
    | "read"
    | "operation";
  readonly message: string;
  readonly exitCode: number | null;
};

export type PrepareCleanup = {
  readonly state: "not-started" | "stopped" | "unknown";
  readonly errors: readonly string[];
};

export type PrepareLogs = {
  readonly directory: string | null;
  readonly files: readonly string[];
};

export type PrepareOperationResult = {
  readonly kind: "prepare";
  readonly status:
    | "prepared"
    | "failed"
    | "config-incompatible"
    | "invalid-request"
    | "unmanaged";
  readonly environment: EnvironmentFacts;
  readonly failure?: PrepareFailure;
  readonly incompatibility?: readonly string[];
  readonly cleanup: PrepareCleanup;
  readonly logs: PrepareLogs;
  readonly interruptedOperationIds?: readonly string[];
  /**
   * 首因之外的独立诊断（日志写入、失败记录保存、日志目录列举等）。这些错误不掩盖
   * 原始失败，也不能被用来宣称诊断完整。
   */
  readonly diagnostics: readonly string[];
};

export function invalidEnvironmentFacts(
  workspacePath: string,
  environment: string,
): EnvironmentFacts {
  const layout = createLayout(workspacePath, environment);
  const derived =
    "reason" in layout
      ? {
          containerDirectory: `${workspacePath}/.digital/environments/${environment}`,
          productDataRoot: `${workspacePath}/.digital/environments/${environment}/product-data`,
        }
      : {
          containerDirectory: layout.containerDirectory,
          productDataRoot: layout.productDataRoot,
        };
  return {
    workspacePath,
    environment,
    environmentId: null,
    containerDirectory: derived.containerDirectory,
    productDataRoot: derived.productDataRoot,
    inputs: [],
    sourceMode: "unknown",
    config: {},
    dataGeneration: null,
  };
}

/** 解析并校验操作入口收到的载荷；载荷在持锁进程内再次完整核验。 */
export function parsePreparePayload(
  raw: string,
): { request: PrepareRequest } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: "准备载荷不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { reason: "准备载荷不是对象" };
  const value = parsed as Record<string, unknown>;
  if (value.kind !== "prepare") return { reason: "准备载荷类型未知" };
  if (
    typeof value.workspacePath !== "string" ||
    value.workspacePath.length === 0
  )
    return { reason: "工作区路径缺失" };
  if (typeof value.environment !== "string" || value.environment.length === 0)
    return { reason: "环境名缺失" };
  if (
    !Array.isArray(value.inputs) ||
    value.inputs.some((item) => typeof item !== "string")
  )
    return { reason: "输入目录列表缺失或包含非字符串项" };
  if (typeof value.sourceMode !== "string") return { reason: "来源模式缺失" };
  if (
    typeof value.config !== "object" ||
    value.config === null ||
    Array.isArray(value.config)
  )
    return { reason: "运行配置不是对象" };
  const deadline = parseDeadlineAt(value.deadlineAt);
  if (deadline !== undefined && "reason" in deadline) return deadline;
  return {
    request: {
      kind: "prepare",
      workspacePath: value.workspacePath,
      environment: value.environment,
      inputs: [...(value.inputs as string[])],
      sourceMode: value.sourceMode,
      config: value.config as { readonly [key: string]: JsonValue },
      ...(deadline === undefined ? {} : { deadlineAt: deadline.deadlineAt }),
    },
  };
}

/**
 * 共享核验：输入目录、来源装配选择与请求形状。环境只核验选择的完整性与归属并传递
 * 字符串；清单内容与响应字节由可执行根读取，环境不认识来源。
 */
export function validatePrepareRequest(
  request: PrepareRequest,
): { readonly reason: string; readonly stage: "request" } | undefined {
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout) return { reason: layout.reason, stage: "request" };
  const sourceSelection = validateSourceSelection({
    sourceMode: request.sourceMode,
    config: request.config,
    workspacePath: request.workspacePath,
  });
  if ("reason" in sourceSelection)
    return { reason: sourceSelection.reason, stage: "request" };
  const inputs = normalizeInputDirectories(request.inputs, layout);
  if ("reason" in inputs) return { reason: inputs.reason, stage: "request" };
  // 端口是被准备的环境配置的一部分：start 只使用已记录的值，不在启动时改选。
  const port = webPortProblem(request.config);
  if (port !== undefined) return { reason: port, stage: "request" };
  return undefined;
}

export function validateStartOrStopRequest(
  request: StartRequest | StopRequest,
): { readonly reason: string; readonly stage: "request" } | undefined {
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout) return { reason: layout.reason, stage: "request" };
  if (
    request.kind === "start" &&
    request.runtime !== undefined &&
    request.runtime !== "production" &&
    request.runtime !== "development"
  )
    return {
      reason: "启动入口必须是 production 或 development",
      stage: "request",
    };
  return undefined;
}

/** 公开取消条件的形状核验；无效时给出可直接报告的原因。 */
export function publicCancellationProblem(
  cancellation: PublicCancellation | undefined,
): string | undefined {
  if (cancellation === undefined) return undefined;
  if (
    cancellation.signal !== undefined &&
    !(cancellation.signal instanceof AbortSignal)
  )
    return "取消条件必须是 AbortSignal，或者省略该字段";
  if (
    cancellation.timeoutMs !== undefined &&
    (typeof cancellation.timeoutMs !== "number" ||
      !Number.isFinite(cancellation.timeoutMs) ||
      cancellation.timeoutMs <= 0)
  )
    return "操作期限必须是有限的正毫秒数";
  return undefined;
}

/** 期限在发起时刻换算为绝对终点；没有期限就是没有期限，不给默认值。 */
export function resolveDeadlineAt(
  cancellation: PublicCancellation | undefined,
): number | undefined {
  if (cancellation?.timeoutMs === undefined) return undefined;
  return Date.now() + Math.round(cancellation.timeoutMs);
}

/** 载荷中的期限字段核验；内核换算出的值必然是正的有限数。 */
function parseDeadlineAt(
  value: unknown,
): { readonly deadlineAt: number } | undefined | { readonly reason: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return { reason: "操作期限载荷不是有限的正毫秒数" };
  return { deadlineAt: value };
}

export function samePrepareInput(
  request: PrepareRequest,
  existing: {
    readonly inputs: readonly string[];
    readonly sourceMode: string;
    readonly config: { readonly [key: string]: JsonValue };
  },
): readonly string[] {
  const differences: string[] = [];
  const requestInputs = [...request.inputs].toSorted();
  if (
    canonicalJson(requestInputs) !==
    canonicalJson([...existing.inputs].toSorted())
  )
    differences.push("输入目录列表");
  if (request.sourceMode !== existing.sourceMode) differences.push("来源模式");
  if (canonicalJson(request.config) !== canonicalJson(existing.config))
    differences.push("运行配置");
  return differences;
}

/** 解析持锁操作入口收到的载荷；载荷在本进程内再次完整核验。 */
export function parseOperationPayload(
  raw: string,
): { readonly request: OperationRequest } | { readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: "操作载荷不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { reason: "操作载荷不是对象" };
  const value = parsed as Record<string, unknown>;
  if (value.kind === "prepare") return parsePreparePayload(raw);
  const kind = value.kind;
  if (
    kind === "start" ||
    kind === "stop" ||
    kind === "rebuild" ||
    kind === "delete"
  ) {
    const workspacePath = value.workspacePath;
    const environment = value.environment;
    if (typeof workspacePath !== "string" || workspacePath.length === 0)
      return { reason: `${kind} 载荷缺少工作区路径` };
    if (typeof environment !== "string" || environment.length === 0)
      return { reason: `${kind} 载荷缺少环境名` };
    const deadline = parseDeadlineAt(value.deadlineAt);
    if (deadline !== undefined && "reason" in deadline) return deadline;
    return {
      request: {
        kind,
        workspacePath,
        environment,
        ...((kind === "start" || kind === "stop") &&
        typeof value.developmentSession === "string"
          ? { developmentSession: value.developmentSession }
          : {}),
        ...(kind === "start"
          ? {
              runtime:
                value.runtime === undefined
                  ? "production"
                  : (value.runtime as "production" | "development"),
            }
          : {}),
        ...(deadline === undefined ? {} : { deadlineAt: deadline.deadlineAt }),
      },
    };
  }
  return { reason: "操作载荷类型未知" };
}

export type ProcessLiveness = "alive" | "exited" | "unknown" | "absent";

/**
 * 启动与停止对本次自持资源的收尾结论。`released` 只用于成功就绪：世代按记录
 * 继续运行，本次操作释放的是自己的进程句柄，不是把服务停下。
 */
export type LifecycleCleanup = {
  readonly state: "not-started" | "stopped" | "unknown" | "released";
  readonly errors: readonly string[];
};

/** 运行事实：记录内的事实加上本次可核验的实时观察，全部为非秘密引用。 */
export type EnvironmentRunFacts = {
  readonly runId: string | null;
  readonly runtime?: "production" | "development";
  readonly state: "absent" | EnvironmentRunRecord["state"];
  readonly address: string | null;
  readonly port: number | null;
  readonly productLogFile: string | null;
  readonly logHealth: RecordedLogHealth | null;
  readonly pid: number | null;
  readonly processLiveness: ProcessLiveness;
  readonly controlReachable: boolean;
  readonly serviceReady: boolean | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly endedAt: string | null;
  readonly lastFailure?: { readonly stage: string; readonly message: string };
};

/** 一次实时观察：记录事实之外，还带上控制通道状态与不可成立时的原因。 */
export type RunObservation = EnvironmentRunFacts & {
  readonly controlState?: ControlState;
  readonly refusalReason?: string;
  readonly readyReason?: string;
};

export type StartFailureStage =
  | "request"
  | "claim"
  | "generation"
  | "artifacts"
  | "port"
  | "intent"
  | "spawn"
  | "handshake"
  | "ready"
  | "operation";

export type StartOperationResult = {
  readonly kind: "start";
  readonly status:
    | "ready"
    | "already-ready"
    | "failed"
    | "refused"
    | "unmanaged"
    | "invalid-request";
  readonly environment: EnvironmentFacts;
  readonly run: EnvironmentRunFacts;
  readonly failure?: {
    readonly stage: StartFailureStage;
    readonly message: string;
    readonly exitCode: number | null;
  };
  readonly cleanup: LifecycleCleanup;
  readonly logs: PrepareLogs;
  readonly diagnostics: readonly string[];
};

export type StopFailureStage =
  | "request"
  | "claim"
  | "generation"
  | "control"
  | "operation";

export type StopOperationResult = {
  readonly kind: "stop";
  readonly status:
    | "stopped"
    | "already-stopped"
    | "not-confirmed"
    | "unmanaged"
    | "invalid-request";
  readonly environment: EnvironmentFacts;
  readonly run: EnvironmentRunFacts;
  readonly failure?: {
    readonly stage: StopFailureStage;
    readonly message: string;
    readonly exitCode: number | null;
  };
  readonly cleanup: LifecycleCleanup;
  readonly logs: PrepareLogs;
  readonly diagnostics: readonly string[];
};

export type OperationResult =
  | PrepareOperationResult
  | StartOperationResult
  | StopOperationResult
  | RebuildOperationResult
  | DeleteOperationResult;

export type RebuildFailureStage =
  | "request"
  | "claim"
  | "generation"
  | "intent"
  | "offline"
  | "purge"
  | "build"
  | "migrate"
  | "read"
  | "operation";

/**
 * 重建结果：`rebuilt` 表示旧自有数据已按显式意图回收并从空根完成正式构建、
 * 迁移与读取，记录发布新数据世代；拒绝与失败都不改动任何保留内容。
 */
export type RebuildOperationResult = {
  readonly kind: "rebuild";
  readonly status:
    | "rebuilt"
    | "refused"
    | "failed"
    | "not-confirmed"
    | "unmanaged"
    | "invalid-request";
  readonly environment: EnvironmentFacts;
  readonly run: EnvironmentRunFacts;
  readonly failure?: {
    readonly stage: RebuildFailureStage;
    readonly message: string;
    readonly exitCode: number | null;
  };
  readonly cleanup: LifecycleCleanup;
  readonly logs: PrepareLogs;
  readonly diagnostics: readonly string[];
};

export type DeleteFailureStage =
  | "request"
  | "claim"
  | "generation"
  | "intent"
  | "offline"
  | "purge"
  | "operation";

/**
 * 删除结果：`deleted` 表示该环境自有的记录、日志、数据与私有运行现场都已回收；
 * `already-deleted` 是重复删除的明确成功，不猜测、不递归清理无法归属的残余。
 */
export type DeleteOperationResult = {
  readonly kind: "delete";
  readonly status:
    | "deleted"
    | "already-deleted"
    | "refused"
    | "failed"
    | "not-confirmed"
    | "unmanaged"
    | "invalid-request";
  readonly environment: EnvironmentFacts;
  readonly run: EnvironmentRunFacts;
  readonly failure?: {
    readonly stage: DeleteFailureStage;
    readonly message: string;
    readonly exitCode: number | null;
  };
  readonly cleanup: LifecycleCleanup;
  readonly logs: PrepareLogs;
  readonly diagnostics: readonly string[];
};

/** 记录中的运行分支投影；实时字段由观察调用方补齐。 */
export function recordedRunFacts(
  record: EnvironmentRecord,
): EnvironmentRunFacts {
  const run = record.run;
  if (run === undefined)
    return {
      runId: null,
      state: "absent",
      address: null,
      port: null,
      productLogFile: null,
      logHealth: null,
      pid: null,
      processLiveness: "absent",
      controlReachable: false,
      serviceReady: null,
      startedAt: null,
      updatedAt: null,
      endedAt: null,
    };
  return {
    runId: run.runId,
    state: run.state,
    runtime: run.runtime ?? "production",
    address: run.address,
    port: run.port,
    productLogFile: run.productLogFile,
    logHealth: run.logHealth ?? null,
    pid: run.processIdentity?.pid ?? null,
    processLiveness: "unknown",
    controlReachable: false,
    serviceReady: null,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    endedAt: run.ended?.at ?? null,
    ...(run.lastFailure === undefined ? {} : { lastFailure: run.lastFailure }),
  };
}

export const noRunFacts: EnvironmentRunFacts = {
  runId: null,
  state: "absent",
  address: null,
  port: null,
  productLogFile: null,
  logHealth: null,
  pid: null,
  processLiveness: "absent",
  controlReachable: false,
  serviceReady: null,
  startedAt: null,
  updatedAt: null,
  endedAt: null,
};
