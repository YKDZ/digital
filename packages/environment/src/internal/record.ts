import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";

import {
  developmentSessionProblem,
  type DevelopmentSessionRecord,
} from "./development-state.ts";
import {
  processIdentityProblem,
  type ProcessIdentity,
} from "./process-identity.ts";

/** 环境持久记录（版本 1）：只含非秘密的输入、配置与准备事实。 */
export const environmentRecordVersion = 1 as const;

/** 环境可持久化的来源装配选择；具体清单内容不由环境解释。 */
export const supportedSourceModes = ["offline", "controlled", "real"] as const;

export type SupportedSourceMode = (typeof supportedSourceModes)[number];

export type EnvironmentPreparationState =
  | "preparing"
  | "prepared"
  | "failed"
  | "incompatible";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type RecordedOperationKind =
  | "prepare"
  | "start"
  | "stop"
  | "rebuild"
  | "delete";

export type RecordedOperationOutcome =
  | "prepared"
  | "ready"
  | "already-ready"
  | "stopped"
  | "already-stopped"
  | "failed"
  | "refused"
  | "not-confirmed"
  | "interrupted"
  | "rebuilt"
  | "deleted"
  | "already-deleted";

export type EnvironmentOperationRecord = {
  readonly id: string;
  readonly kind: RecordedOperationKind;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome?: RecordedOperationOutcome;
  readonly logDirectory: string;
};

/**
 * 破坏性操作意图：在删除任何自有数据之前持久写入，只有对应的显式命令
 * （rebuild 意图由 rebuild 收敛，delete 意图由 delete 收敛）才允许清除。
 */
export type DestructiveIntent = {
  readonly kind: "rebuild" | "delete";
  readonly operationId: string;
  readonly startedAt: string;
  readonly targetDataGeneration: string;
  readonly targetRunId: string | null;
};

export type EnvironmentRunState = "starting" | "ready" | "stopping" | "stopped";

export const recordedLogHealthValues = [
  "recording",
  "complete",
  "incomplete",
  "unknown",
] as const;

export type RecordedLogHealth = (typeof recordedLogHealthValues)[number];

/**
 * 运行分支：本次被本记录管理的服务事实。秘密（控制与 ready 认证密钥）只存在于
 * 私有目录内的 0600 文件，记录里只有路径与非秘密引用。
 */
export type EnvironmentRunRecord = {
  readonly runId: string;
  readonly runtime?: "production" | "development";
  readonly state: EnvironmentRunState;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly port: number;
  readonly address: string;
  readonly privateDirectory: string;
  readonly privateDirectoryIdentity: {
    readonly device: number;
    readonly inode: number;
  };
  readonly controlSocket: string;
  readonly launchConfigFile: string;
  readonly productLogFile: string;
  readonly startOperationId: string;
  readonly processIdentity?: ProcessIdentity;
  readonly logHealth?: RecordedLogHealth;
  readonly lastFailure?: { readonly stage: string; readonly message: string };
  /** 只在确认目标进程真实退出后写入。 */
  readonly ended?: {
    readonly at: string;
    readonly code: number | null;
    readonly signal: string | null;
  };
};

export type EnvironmentRecord = {
  readonly development?: DevelopmentSessionRecord;
  readonly version: typeof environmentRecordVersion;
  readonly environmentId: string;
  readonly workspacePath: string;
  readonly environment: string;
  readonly createdAt: string;
  readonly containerIdentity: {
    readonly device: number;
    readonly inode: number;
  };
  readonly inputs: readonly string[];
  readonly sourceMode: SupportedSourceMode;
  readonly config: { readonly [key: string]: JsonValue };
  readonly dataGeneration: string;
  readonly preparation: {
    readonly state: EnvironmentPreparationState;
    readonly updatedAt: string;
    readonly lastOperationId: string;
    readonly lastFailure?: {
      readonly stage: string;
      readonly message: string;
      readonly cleanup: "stopped" | "unknown";
    };
  };
  readonly operations: readonly EnvironmentOperationRecord[];
  /** 缺少运行分支的合法记录表示“尚无被本记录管理的服务”，不是“任何可见服务都可认领”。 */
  readonly run?: EnvironmentRunRecord;
  /** 未收敛的破坏性操作意图；存在时普通 prepare/start 一律拒绝改动环境。 */
  readonly destructive?: DestructiveIntent;
};

export type RecordRead =
  | { readonly kind: "record"; readonly record: EnvironmentRecord }
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt"; readonly reason: string };

export async function readRecord(recordPath: string): Promise<RecordRead> {
  let text: string;
  try {
    text = await readFile(recordPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { kind: "absent" };
    return { kind: "corrupt", reason: describeReadFailure(error) };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const record = validateRecord(parsed);
    if (!("record" in record))
      return { kind: "corrupt", reason: record.reason };
    return { kind: "record", record: record.record };
  } catch {
    return { kind: "corrupt", reason: "记录不是合法 JSON" };
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function describeReadFailure(error: unknown): string {
  return error instanceof Error ? error.message : "记录读取失败";
}

/**
 * 原子发布：同目录写临时文件、flush 后 rename。损坏或未知版本由调用方保留
 * 原件并报告不可管理，这里只做校验，不做修复。
 *
 * 提交边界是一个不含事件循环轮次的同步块：核对取消闸门与 rename 落在同一个同步块里，
 * 取消来源（信号回调与期限定时器）只能在该块之外被观察，因此「取消已经成立」与「正式
 * 记录已经提交」不会互相越过对方。同步块之前成立就交出原因、不发生 rename，磁盘上仍是
 * 提交前的记录；已经完成的提交是既成事实，其后才成立的迟到取消不撤销它。
 */
export async function writeRecordAtomic(
  recordPath: string,
  record: EnvironmentRecord,
  commitGate?: () => string | undefined,
): Promise<void> {
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const aborted = commitGate?.();
  if (aborted !== undefined) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(aborted);
  }
  try {
    renameSync(temporary, recordPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function validateRecord(
  value: unknown,
): { record: EnvironmentRecord } | { reason: string } {
  if (!isRecordObject(value)) return { reason: "记录不是对象" };
  if (value.version !== environmentRecordVersion)
    return { reason: `未知记录版本：${String(value.version)}` };
  const strings = [
    "environmentId",
    "workspacePath",
    "environment",
    "createdAt",
    "dataGeneration",
  ] as const;
  for (const key of strings)
    if (typeof value[key] !== "string" || value[key].length === 0)
      return { reason: `记录字段 ${key} 缺失或不是非空字符串` };
  if (!supportedSourceModes.includes(value.sourceMode as SupportedSourceMode))
    return { reason: `记录来源模式不受支持：${String(value.sourceMode)}` };
  if (
    !Array.isArray(value.inputs) ||
    value.inputs.some((item) => typeof item !== "string")
  )
    return { reason: "记录输入目录不是字符串数组" };
  if (!isRecordObject(value.config) || !hasJsonValues(value.config))
    return { reason: "记录运行配置不是 JSON 对象" };
  if (
    !isRecordObject(value.containerIdentity) ||
    typeof value.containerIdentity.device !== "number" ||
    typeof value.containerIdentity.inode !== "number"
  )
    return { reason: "记录目录身份凭据缺失" };
  if (!isRecordObject(value.preparation)) return { reason: "记录准备事实缺失" };
  const preparation = value.preparation;
  if (
    preparation.state !== "preparing" &&
    preparation.state !== "prepared" &&
    preparation.state !== "failed" &&
    preparation.state !== "incompatible"
  )
    return { reason: `记录准备状态未知：${String(preparation.state)}` };
  if (
    typeof preparation.updatedAt !== "string" ||
    typeof preparation.lastOperationId !== "string"
  )
    return { reason: "记录准备时间或最后操作标识缺失" };
  if (preparation.lastFailure !== undefined) {
    if (!isRecordObject(preparation.lastFailure))
      return { reason: "记录最近失败事实缺失" };
    if (
      typeof preparation.lastFailure.stage !== "string" ||
      typeof preparation.lastFailure.message !== "string" ||
      (preparation.lastFailure.cleanup !== "stopped" &&
        preparation.lastFailure.cleanup !== "unknown")
    )
      return { reason: "记录最近失败字段不完整" };
  }
  if (!Array.isArray(value.operations))
    return { reason: "记录操作历史不是数组" };
  for (const operation of value.operations) {
    if (
      !isRecordObject(operation) ||
      typeof operation.id !== "string" ||
      !recordedOperationKinds.includes(operation.kind as never) ||
      typeof operation.startedAt !== "string" ||
      typeof operation.logDirectory !== "string" ||
      (operation.finishedAt !== undefined &&
        typeof operation.finishedAt !== "string") ||
      (operation.outcome !== undefined &&
        !recordedOperationOutcomes.includes(operation.outcome as never))
    )
      return { reason: "记录操作历史条目不完整" };
  }
  if (value.development !== undefined) {
    const problem = developmentSessionProblem(value.development);
    if (problem !== undefined) return { reason: problem };
  }
  if (value.run !== undefined) {
    const problem = runProblem(value.run);
    if (problem !== undefined) return { reason: problem };
  }
  if (value.destructive !== undefined) {
    const problem = destructiveProblem(value.destructive);
    if (problem !== undefined) return { reason: problem };
  }
  return { record: value as unknown as EnvironmentRecord };
}

const recordedOperationKinds: readonly RecordedOperationKind[] = [
  "prepare",
  "start",
  "stop",
  "rebuild",
  "delete",
];
const recordedOperationOutcomes: readonly RecordedOperationOutcome[] = [
  "prepared",
  "ready",
  "already-ready",
  "stopped",
  "already-stopped",
  "failed",
  "refused",
  "not-confirmed",
  "interrupted",
  "rebuilt",
  "deleted",
  "already-deleted",
];
const recordedRunStates = ["starting", "ready", "stopping", "stopped"] as const;

/** 破坏意图只按结构核验；无法识别的意图同样当作记录损坏，不猜测其目标。 */
function destructiveProblem(value: unknown): string | undefined {
  if (!isRecordObject(value)) return "记录破坏意图不是对象";
  if (value.kind !== "rebuild" && value.kind !== "delete")
    return `记录破坏意图种类未知：${String(value.kind)}`;
  for (const key of [
    "operationId",
    "startedAt",
    "targetDataGeneration",
  ] as const)
    if (typeof value[key] !== "string" || value[key].length === 0)
      return `记录破坏意图字段 ${key} 缺失或不是非空字符串`;
  if (typeof value.targetRunId !== "string" && value.targetRunId !== null)
    return "记录破坏意图的目标世代必须是标识或 null";
  return undefined;
}

/** 运行分支只按结构核验；任何缺失或类型不符都当作记录损坏，不做修复。 */
function runProblem(value: unknown): string | undefined {
  if (!isRecordObject(value)) return "记录运行分支不是对象";
  for (const key of [
    "runId",
    "startedAt",
    "updatedAt",
    "address",
    "privateDirectory",
    "controlSocket",
    "launchConfigFile",
    "productLogFile",
    "startOperationId",
  ] as const)
    if (typeof value[key] !== "string" || value[key].length === 0)
      return `记录运行分支字段 ${key} 缺失或不是非空字符串`;
  if (
    value.runtime !== undefined &&
    value.runtime !== "production" &&
    value.runtime !== "development"
  )
    return "记录运行入口未知";
  if (!recordedRunStates.includes(value.state as never))
    return `记录运行分支状态未知：${String(value.state)}`;
  if (
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  )
    return "记录运行分支端口不是合法整数";
  if (
    !isRecordObject(value.privateDirectoryIdentity) ||
    typeof value.privateDirectoryIdentity.device !== "number" ||
    typeof value.privateDirectoryIdentity.inode !== "number"
  )
    return "记录运行分支缺少私有目录身份凭据";
  if (value.processIdentity !== undefined) {
    const problem = processIdentityProblem(value.processIdentity);
    if (problem !== undefined) return `记录运行分支进程身份无效：${problem}`;
  }
  if (
    value.logHealth !== undefined &&
    !recordedLogHealthValues.includes(value.logHealth as never)
  )
    return `记录运行分支日志健康未知：${
      typeof value.logHealth === "string" ? value.logHealth : "非文本取值"
    }`;
  if (value.lastFailure !== undefined) {
    if (
      !isRecordObject(value.lastFailure) ||
      typeof value.lastFailure.stage !== "string" ||
      typeof value.lastFailure.message !== "string"
    )
      return "记录运行分支最近失败不完整";
  }
  if (value.ended !== undefined) {
    if (
      !isRecordObject(value.ended) ||
      typeof value.ended.at !== "string" ||
      (typeof value.ended.code !== "number" && value.ended.code !== null) ||
      (typeof value.ended.signal !== "string" && value.ended.signal !== null)
    )
      return "记录运行分支退出事实不完整";
  }
  return undefined;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasJsonValues(value: Record<string, unknown>): boolean {
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return true;
    case "object":
      return Array.isArray(value)
        ? value.every(isJsonValue)
        : isRecordObject(value) && hasJsonValues(value);
    default:
      return false;
  }
}

/** 配置等价比较用稳定序列化；键序不影响归属判断。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : 1));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
