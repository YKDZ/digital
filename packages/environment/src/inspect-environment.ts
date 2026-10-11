import { lstat, readdir, realpath } from "node:fs/promises";

import type { DevelopmentSessionRecord } from "./internal/development-state.ts";
import type {
  EnvironmentFacts,
  EnvironmentRunFacts,
} from "./internal/operation-contract.ts";
import { noRunFacts, recordedRunFacts } from "./internal/operation-contract.ts";
import {
  createLayout,
  resolveWorkspacePath,
  verifyDataOwnership,
  type EnvironmentLayout,
} from "./internal/paths.ts";
import { observeProcessLifecycle } from "./internal/process-identity.ts";
import {
  canonicalJson,
  readRecord,
  type EnvironmentRecord,
  type RecordedOperationKind,
  type RecordedOperationOutcome,
} from "./internal/record.ts";
import { observeRun, verifyRunTarget } from "./internal/run-observation.ts";

export type EnvironmentState =
  | "unprepared"
  | "preparing"
  | "prepared"
  | "failed"
  | "config-incompatible"
  | "unmanaged";

/**
 * 就绪观察只由私有控制认证与真实 `/api/ready` 签名成立支持：`ready` 与
 * `not-ready` 都是本次实时结论，`unknown` 表示无法核验，`not-evaluated` 表示
 * 该环境记录没有受管理的运行分支，绝不由已准备或进程存活推导出就绪。
 */
export type ServiceReadiness =
  | "not-evaluated"
  | "ready"
  | "not-ready"
  | "unknown";

export type InspectEnvironmentResult = {
  readonly development?: DevelopmentSessionRecord & {
    readonly ownerLiveness: "alive" | "exited" | "unknown";
    readonly watcherLiveness: "alive" | "exited" | "unknown" | "absent";
  };
  readonly status: "ok" | "invalid-request";
  readonly state: EnvironmentState;
  readonly environment: EnvironmentFacts;
  readonly reason?: string;
  readonly preparation?: {
    readonly updatedAt: string;
    readonly lastOperationId: string;
    readonly lastFailure?: {
      readonly stage: string;
      readonly message: string;
      readonly cleanup: "stopped" | "unknown";
    };
  };
  readonly operations?: readonly {
    readonly id: string;
    readonly kind: RecordedOperationKind;
    readonly startedAt: string;
    readonly finishedAt?: string;
    readonly outcome?: RecordedOperationOutcome;
    readonly logDirectory: string;
  }[];
  /**
   * 已持久但尚未收敛的显式破坏性意图：查看只如实指出该用哪个命令继续，绝不代替
   * 使用者清理或回滚。
   */
  readonly pendingIntent?: {
    readonly kind: "rebuild" | "delete";
    readonly operationId: string;
    readonly startedAt: string;
    readonly targetDataGeneration: string;
  };
  /** 记录内运行分支事实，尽可能叠加本次实时观察。 */
  readonly run: EnvironmentRunFacts;
  /** 无法取得或采信实时观察时的具体原因；就绪为 `ready` 时没有此项。 */
  readonly runProblem?: string;
  readonly serviceReadiness: ServiceReadiness;
};

/** 查看是只读动作：控制查询与 ready 探测都有界，超时只如实报告。 */
const observationTimeoutMilliseconds = 3_000;

const unknownFacts = (
  workspacePath: string,
  environment: string,
): EnvironmentFacts => ({
  workspacePath,
  environment,
  environmentId: null,
  containerDirectory: `${workspacePath}/.digital/environments/${environment}`,
  productDataRoot: `${workspacePath}/.digital/environments/${environment}/product-data`,
  inputs: [],
  sourceMode: "unknown",
  config: {},
  dataGeneration: null,
});

/**
 * 只读查看所选环境的实际状态、输入归属、来源模式、产品数据位置与日志位置。
 * 不因陈旧记录自动迁移、清数据或接管任何进程。
 */
export async function inspectEnvironment(input: {
  readonly workspacePath: string;
  readonly environment: string;
}): Promise<InspectEnvironmentResult> {
  if (
    typeof input.workspacePath !== "string" ||
    input.workspacePath.length === 0 ||
    typeof input.environment !== "string" ||
    input.environment.length === 0
  )
    return {
      status: "invalid-request",
      state: "unmanaged",
      environment: unknownFacts(
        input.workspacePath ?? "",
        input.environment ?? "",
      ),
      reason: "查看必须提供工作区路径与环境名",
      run: noRunFacts,
      serviceReadiness: "not-evaluated",
    };
  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(input.workspacePath);
  } catch {
    return {
      status: "invalid-request",
      state: "unmanaged",
      environment: unknownFacts(input.workspacePath, input.environment),
      reason: `工作区路径不存在或不可解析：${input.workspacePath}`,
      run: noRunFacts,
      serviceReadiness: "not-evaluated",
    };
  }
  const layout = createLayout(workspacePath, input.environment);
  if ("reason" in layout)
    return {
      status: "invalid-request",
      state: "unmanaged",
      environment: unknownFacts(workspacePath, input.environment),
      reason: layout.reason,
      run: noRunFacts,
      serviceReadiness: "not-evaluated",
    };

  const unmanaged = (reason: string): InspectEnvironmentResult => ({
    status: "ok",
    state: "unmanaged",
    environment: factsFromLayout(layout),
    reason,
    run: noRunFacts,
    serviceReadiness: "not-evaluated",
  });

  const read = await readRecord(layout.recordPath);
  if (read.kind === "corrupt")
    return unmanaged(`环境记录损坏或版本未知，保留原件：${read.reason}`);
  if (read.kind === "absent") {
    const containerExists = await directoryExists(layout.containerDirectory);
    if (
      containerExists &&
      (await directoryIsNotEmpty(layout.containerDirectory))
    )
      return unmanaged("存在无记录的同名非空容器，拒绝认领");
    return {
      status: "ok",
      state: "unprepared",
      environment: factsFromLayout(layout),
      run: noRunFacts,
      serviceReadiness: "not-evaluated",
    };
  }
  const record = read.record;
  if (record.workspacePath !== layout.workspacePath)
    return unmanaged("环境记录的工作区身份与当前工作区不一致");
  const identity = await containerIdentityMatches(layout, record);
  if (identity !== "match")
    return unmanaged(
      identity === "unreadable"
        ? "环境容器不存在或不可核验"
        : "环境容器目录身份与记录不一致",
    );
  // 数据根被重定向到容器之外时，记录里的“已准备”不再描述本环境自有数据。
  const ownership = await verifyDataOwnership(layout, record.inputs);
  if ("reason" in ownership) return unmanaged(ownership.reason);

  const operations = await Promise.all(
    record.operations.map(async (operation) => ({
      ...operation,
      logDirectory: await realpathSafe(
        `${layout.containerDirectory}/${operation.logDirectory}`,
      ),
    })),
  );
  const observation = await observeService(record, layout);
  return {
    status: "ok",
    state:
      record.preparation.state === "incompatible"
        ? "config-incompatible"
        : record.preparation.state,
    environment: {
      workspacePath: record.workspacePath,
      environment: record.environment,
      environmentId: record.environmentId,
      containerDirectory: layout.containerDirectory,
      productDataRoot: layout.productDataRoot,
      inputs: record.inputs,
      sourceMode: record.sourceMode,
      config: record.config,
      dataGeneration: record.dataGeneration,
    },
    ...(record.development === undefined
      ? {}
      : {
          development: {
            ...record.development,
            ownerLiveness: observeProcessLifecycle(record.development.owner),
            watcherLiveness:
              record.development.watcher === undefined
                ? ("absent" as const)
                : observeProcessLifecycle(record.development.watcher),
          },
        }),
    preparation: {
      updatedAt: record.preparation.updatedAt,
      lastOperationId: record.preparation.lastOperationId,
      ...(record.preparation.lastFailure === undefined
        ? {}
        : { lastFailure: record.preparation.lastFailure }),
    },
    operations,
    ...(record.destructive === undefined
      ? {}
      : {
          pendingIntent: {
            kind: record.destructive.kind,
            operationId: record.destructive.operationId,
            startedAt: record.destructive.startedAt,
            targetDataGeneration: record.destructive.targetDataGeneration,
          },
        }),
    run: observation.run,
    ...(observation.problem === undefined
      ? {}
      : { runProblem: observation.problem }),
    serviceReadiness: observation.readiness,
  };
}

/**
 * 只读观察受管理的运行分支：私有现场无法核验时连控制通道也不连接；观察之后重读
 * 记录，运行分支在此期间被并发变更就说明本次结论已不可采信，只报告未知。
 */
async function observeService(
  record: EnvironmentRecord,
  layout: EnvironmentLayout,
): Promise<{
  run: EnvironmentRunFacts;
  readiness: ServiceReadiness;
  problem?: string;
}> {
  if (record.run === undefined)
    return { run: noRunFacts, readiness: "not-evaluated" };
  const recorded = recordedRunFacts(record);
  const target = await verifyRunTarget(record);
  if ("reason" in target)
    return {
      run: {
        ...recorded,
        processLiveness: target.liveness,
        serviceReady: target.liveness === "exited" ? false : null,
      },
      readiness: target.liveness === "exited" ? "not-ready" : "unknown",
      problem: target.reason,
    };
  const observed = await observeRun(record, target.target, {
    controlTimeoutMilliseconds: observationTimeoutMilliseconds,
    readyTimeoutMilliseconds: observationTimeoutMilliseconds,
  });
  const reloaded = await readRecord(layout.recordPath);
  const unchanged =
    reloaded.kind === "record" &&
    canonicalJson(reloaded.record.run) === canonicalJson(record.run);
  if (!unchanged)
    return {
      run: { ...recorded, processLiveness: "unknown", serviceReady: null },
      readiness: "unknown",
      problem:
        reloaded.kind === "record"
          ? "观察期间该环境的运行分支已被改写，本次实时结论不可采信"
          : reloaded.kind === "corrupt"
            ? `观察期间记录变得不可读：${reloaded.reason}`
            : "观察期间记录已不存在，本次实时结论不可采信",
    };
  if (observed.serviceReady === true)
    return { run: observed, readiness: "ready" };
  const problem = observed.refusalReason ?? observed.readyReason;
  return {
    run: observed,
    readiness: observed.processLiveness === "unknown" ? "unknown" : "not-ready",
    ...(problem === undefined ? {} : { problem }),
  };
}

function factsFromLayout(layout: EnvironmentLayout): EnvironmentFacts {
  return {
    workspacePath: layout.workspacePath,
    environment: layout.environment,
    environmentId: null,
    containerDirectory: layout.containerDirectory,
    productDataRoot: layout.productDataRoot,
    inputs: [],
    sourceMode: "unknown",
    config: {},
    dataGeneration: null,
  };
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await realpath(directory)) === directory;
  } catch {
    return false;
  }
}

async function directoryIsNotEmpty(directory: string): Promise<boolean> {
  const entries = await readdir(directory).catch(() => ["<unreadable>"]);
  return entries.length > 0;
}

/** 容器身份核验：真实路径仍在容器位且 dev/ino 与记录一致。 */
async function containerIdentityMatches(
  layout: EnvironmentLayout,
  record: EnvironmentRecord,
): Promise<"match" | "mismatch" | "unreadable"> {
  try {
    const resolved = await realpath(layout.containerDirectory);
    if (resolved !== layout.containerDirectory) return "mismatch";
    const stat = await lstat(layout.containerDirectory);
    return stat.dev === record.containerIdentity.device &&
      stat.ino === record.containerIdentity.inode
      ? "match"
      : "mismatch";
  } catch {
    return "unreadable";
  }
}

async function realpathSafe(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}
