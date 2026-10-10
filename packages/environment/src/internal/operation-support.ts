import { appendFile, lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  operationMarker,
  type EnvironmentFacts,
  type OperationRequest,
  type OperationResult,
} from "./operation-contract.ts";
import type { EnvironmentLayout } from "./paths.ts";
import {
  readRecord,
  writeRecordAtomic,
  type EnvironmentOperationRecord,
  type EnvironmentRecord,
  type EnvironmentRunRecord,
} from "./record.ts";
import { createDiagnosticRedactor } from "./redact.ts";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

/** 持久写入前完成脱敏；写入失败返回可报告的问题，交由调用方独立记录。 */
export async function writeOperationLog(
  operationLog: string,
  message: string,
): Promise<string | undefined> {
  const redacted = createDiagnosticRedactor([])(message);
  try {
    await appendFile(
      operationLog,
      `${new Date().toISOString()} ${redacted}\n`,
      "utf8",
    );
    return undefined;
  } catch (error) {
    return `操作日志写入失败：${describeError(error)}`;
  }
}

/** 操作日志是旁路诊断：写入问题独立累积，绝不掩盖业务首因。 */
export async function note(
  operationLog: string,
  logErrors: string[],
  message: string,
): Promise<void> {
  const problem = await writeOperationLog(operationLog, message);
  if (problem !== undefined) logErrors.push(problem);
}

/**
 * 日志目录清单只报告确实是文件且可枚举到的路径；列举或判定失败作为独立诊断上报，
 * 不静默把不完整清单说成完整。
 */
export async function listFiles(
  directory: string,
  diagnostics: string[],
): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory, { recursive: true });
  } catch (error) {
    diagnostics.push(`日志目录无法列举：${describeError(error)}`);
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const absolute = path.join(directory, entry);
    try {
      if ((await lstat(absolute)).isFile()) files.push(absolute);
    } catch (error) {
      diagnostics.push(
        `日志文件无法确认：${absolute}（${describeError(error)}）`,
      );
    }
  }
  return files;
}

export type DirectoryIdentity = {
  readonly device: number;
  readonly inode: number;
};

/** 目录身份核验：真实路径仍在原位（不是符号链接跳转）且可取得 dev/ino。 */
export async function directoryIdentity(
  directory: string,
): Promise<DirectoryIdentity | undefined> {
  try {
    const [resolved, stat] = await Promise.all([
      realpath(directory),
      lstat(directory),
    ]);
    if (resolved !== directory) return undefined;
    return { device: stat.dev, inode: stat.ino };
  } catch {
    return undefined;
  }
}

/** 写入失败记录并返回可报告的保存问题；不掩盖原始失败。 */
export async function saveRecord(
  recordPath: string,
  record: EnvironmentRecord,
  commitGate?: () => string | undefined,
): Promise<string | undefined> {
  try {
    await writeRecordAtomic(recordPath, record, commitGate);
    return undefined;
  } catch (error) {
    return `记录未能保存：${describeError(error)}`;
  }
}

export function environmentFacts(
  record: EnvironmentRecord,
  layout: EnvironmentLayout,
): EnvironmentFacts {
  return {
    workspacePath: record.workspacePath,
    environment: record.environment,
    environmentId: record.environmentId,
    containerDirectory: layout.containerDirectory,
    productDataRoot: layout.productDataRoot,
    inputs: record.inputs,
    sourceMode: record.sourceMode,
    config: record.config,
    dataGeneration: record.dataGeneration,
  };
}

export function derivedFacts(
  request: OperationRequest,
  layout: EnvironmentLayout,
): EnvironmentFacts {
  return {
    workspacePath: layout.workspacePath,
    environment: layout.environment,
    environmentId: null,
    containerDirectory: layout.containerDirectory,
    productDataRoot: layout.productDataRoot,
    inputs: "inputs" in request ? [...request.inputs] : [],
    sourceMode: "sourceMode" in request ? request.sourceMode : "offline",
    config: "config" in request ? request.config : {},
    dataGeneration: null,
  };
}

/** 找不到结果时的兜底：从记录中取最近一次操作，以便给出可用日志位置。 */
export async function latestOperation(
  layout: EnvironmentLayout,
): Promise<string | undefined> {
  const read = await readRecord(layout.recordPath);
  return read.kind === "record"
    ? read.record.preparation.lastOperationId
    : undefined;
}

/** 追加一条本次操作历史；已确认结束的操作可同时带上结果。 */
export function withOperation(
  record: EnvironmentRecord,
  entry: EnvironmentOperationRecord,
  outcome?: EnvironmentOperationRecord["outcome"],
): EnvironmentRecord {
  const finished =
    outcome === undefined
      ? entry
      : { ...entry, finishedAt: new Date().toISOString(), outcome };
  return { ...record, operations: [...record.operations, finished] };
}

/** 按操作标识写入结束事实；标识不存在时原样返回，不虚构历史。 */
export function finishOperation(
  record: EnvironmentRecord,
  operationId: string,
  outcome: NonNullable<EnvironmentOperationRecord["outcome"]>,
): EnvironmentRecord {
  return {
    ...record,
    operations: record.operations.map((operation) =>
      operation.id === operationId
        ? { ...operation, finishedAt: new Date().toISOString(), outcome }
        : operation,
    ),
  };
}

/**
 * 世代确认退出后只释放本世代自有的秘密与失联控制 socket：产品日志与目录都保留。
 * 只有仍位于已核验私有目录直接下层的文件才被删除。
 */
export async function releaseRunSecrets(
  run: EnvironmentRunRecord,
): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const [label, file] of [
    ["启动配置", run.launchConfigFile],
    ["控制地址", run.controlSocket],
  ] as const) {
    if (path.dirname(file) !== run.privateDirectory) {
      problems.push(`${label}路径不属于本世代私有目录，未释放：${file}`);
      continue;
    }
    try {
      await rm(file, { force: true });
    } catch (error) {
      problems.push(`${label}未能释放：${file}（${describeError(error)}）`);
    }
  }
  return problems;
}

/** 结构化结果由持锁操作进程经标准输出交出，父内核按标记取回。 */
export function emit(result: OperationResult): void {
  process.stdout.write(`${operationMarker} ${JSON.stringify(result)}\n`);
}
