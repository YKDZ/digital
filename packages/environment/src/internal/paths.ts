import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { privateRunDirectoryName } from "./launch-contract.ts";
import type { JsonValue } from "./record.ts";

/** 工作区管理布局：记录与锁独立于输入素材，容器由管理器独占创建。 */
export const managementDirectorySegments = [
  ".digital",
  "environments",
] as const;
export const lockDirectorySegments = [".digital", "locks"] as const;
export const recordFileName = "record.json";
export const productDataDirectorySegment = "product-data";
export const initialConfigurationDirectorySegment = "initial-configuration";
export const logsDirectorySegment = "logs";

const environmentNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type EnvironmentLayout = {
  readonly workspacePath: string;
  readonly environment: string;
  readonly environmentsRoot: string;
  readonly containerDirectory: string;
  readonly recordPath: string;
  readonly productDataRoot: string;
  readonly initialConfigurationDirectory: string;
  readonly logsRoot: string;
  readonly lockDirectory: string;
  readonly lockPath: string;
};

export type LayoutFailure = {
  readonly reason: string;
};

/** 以 realpath 后的工作区路径作为工作区身份；不能用分支名或环境名替代。 */
export function resolveWorkspacePath(candidate: string): string {
  const absolute = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(process.cwd(), candidate);
  return realpathSync(absolute);
}

/** CLI 默认当前仓库工作区：从给定目录向上寻找包含 .git 的最近目录。 */
export function findRepositoryWorkspace(startPath: string): string | undefined {
  let current = realpathSync(startPath);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function createLayout(
  workspacePath: string,
  environment: string,
): EnvironmentLayout | LayoutFailure {
  if (!environmentNamePattern.test(environment))
    return {
      reason: `环境名只能由字母、数字、点、下划线和连字符组成（当前：${environment}）`,
    };
  if (!path.isAbsolute(workspacePath))
    return { reason: `工作区路径必须是绝对路径（当前：${workspacePath}）` };
  const environmentsRoot = path.join(
    workspacePath,
    ...managementDirectorySegments,
  );
  const containerDirectory = path.join(environmentsRoot, environment);
  const lockDirectory = path.join(workspacePath, ...lockDirectorySegments);
  return {
    workspacePath,
    environment,
    environmentsRoot,
    containerDirectory,
    recordPath: path.join(containerDirectory, recordFileName),
    productDataRoot: path.join(containerDirectory, productDataDirectorySegment),
    initialConfigurationDirectory: path.join(
      containerDirectory,
      initialConfigurationDirectorySegment,
    ),
    logsRoot: path.join(containerDirectory, logsDirectorySegment),
    lockDirectory,
    // 固定锁文件位于工作区管理级锁区，不随单个环境删除。
    lockPath: path.join(lockDirectory, `${environment}.flock`),
  };
}

export function createOperationId(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/** 正式产品服务入口与 Turbo 目标：start 只消费已准备好的产物。 */
export const serviceEntrySegments = [
  "apps",
  "service",
  "dist",
  "main.js",
] as const;
/** 开发世代直接运行服务源码；依赖包由 Turbo 的 `dev:build` 输出供 Node 条件解析。 */
export const developmentServiceEntrySegments = [
  "apps",
  "service",
  "src",
  "main.ts",
] as const;
export const serviceTurboTarget = "@digital/service";

export function serviceEntryPath(workspacePath: string): string {
  return path.join(workspacePath, ...serviceEntrySegments);
}

export function developmentServiceEntryPath(workspacePath: string): string {
  return path.join(workspacePath, ...developmentServiceEntrySegments);
}

/**
 * 环境自有的确定缺省端口：由 environmentId 稳定派生，不从父终端继承，也不在
 * 冲突时自动换端口。配置里的 webPort 优先，两者都会写进运行分支。
 */
export function defaultWebPort(environmentId: string): number {
  const digest = createHash("sha256")
    .update(`${environmentId}\ndigital-environment-port-v1`)
    .digest();
  return 20_000 + (digest.readUInt16BE(0) % 20_000);
}

export function webPortProblem(config: {
  readonly [key: string]: JsonValue;
}): string | undefined {
  if (!("webPort" in config)) return undefined;
  const port = config.webPort;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    return `运行配置 webPort 不是 1—65535 的整数：${JSON.stringify(port)}`;
  return undefined;
}

/**
 * 私有运行目录落在系统临时区的自有前缀下，目录名只由身份哈希构成：容器目录绝对
 * 路径已接近 Unix socket 的长度上限，用哈希名才能稳定容纳 socket。
 */
export function createPrivateRunDirectory(
  workspacePath: string,
  environmentId: string,
  runId: string,
): { readonly directory: string } | { readonly reason: string } {
  const directory = path.join(
    tmpdir(),
    "digital-environments",
    privateRunDirectoryName(workspacePath, environmentId, runId),
  );
  const socket = path.join(directory, "control.sock");
  // Linux 的 sun_path 上限为 108 字节（含结束符）。
  if (Buffer.byteLength(socket, "utf8") > 106)
    return {
      reason: `私有控制地址超出 Unix socket 长度限制：${socket}`,
    };
  return { directory };
}

/**
 * 输入目录核验：绝对路径、存在且为目录；realpath 解析后的路径与环境容器和
 * 产品根均不重叠（相等或互为嵌套都算重叠）。
 */
export function normalizeInputDirectories(
  candidates: readonly string[],
  layout: EnvironmentLayout,
): { readonly inputs: readonly string[] } | { readonly reason: string } {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate))
      return { reason: `输入目录必须是绝对路径（当前：${candidate}）` };
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      return { reason: `输入目录不存在或不可解析：${candidate}` };
    }
    if (!lstatSync(resolved).isDirectory())
      return { reason: `输入目录不是目录：${resolved}` };
    for (const owned of [layout.containerDirectory, layout.productDataRoot]) {
      if (overlaps(resolved, owned))
        return {
          reason: `输入目录与环境自有目录重叠：${resolved} ↔ ${owned}`,
        };
    }
    seen.add(resolved);
  }
  return { inputs: [...seen].toSorted() };
}

export function overlaps(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`)
  );
}

export type OwnershipFailure = { readonly reason: string };

/**
 * 核验产品数据根实际仍属于所选环境：自有目录本身不是符号链接或其他非目录对象，
 * 解析后的位置就是容器内的规范路径，并且不与任何已归一化的输入素材重叠。
 * 数据根尚未创建是正常初始状态；一旦被预先重定向，正式命令会把产品数据写到环境
 * 之外（素材或其他外部根），必须在任何正式命令前拒绝并原样保留两侧内容。
 */
export async function verifyDataOwnership(
  layout: EnvironmentLayout,
  inputs: readonly string[],
): Promise<{ readonly productDataRoot: string } | OwnershipFailure> {
  const owned = await verifyOwnedDirectory(
    layout.productDataRoot,
    "产品数据根",
    inputs,
  );
  return "reason" in owned ? owned : { productDataRoot: owned.directory };
}

/**
 * 日志根的同一判据。操作日志目录按 `<日志根>/<操作>` 建立，因此预先将日志根重定向
 * 到素材或其他环境目录时，第一个日志写入就已经把诊断产物投到该环境之外——即使随后
 * 的核验拒绝，素材清单也已被改动。破坏性操作必须在建立第一个操作日志目录之前拒绝。
 */
export async function verifyLogsOwnership(
  layout: EnvironmentLayout,
  inputs: readonly string[],
): Promise<{ readonly ok: true } | OwnershipFailure> {
  const owned = await verifyOwnedDirectory(layout.logsRoot, "日志目录", inputs);
  return "reason" in owned ? owned : { ok: true };
}

/**
 * 容器内一个自有目录根的归属判据：未被重定向、仍是规范路径、不与输入素材重叠。
 * 目标尚未创建是正常状态，按归属成立处理。
 */
async function verifyOwnedDirectory(
  directory: string,
  label: string,
  inputs: readonly string[],
): Promise<{ readonly directory: string } | OwnershipFailure> {
  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    existing = await lstat(directory);
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return { directory };
    return {
      reason: `无法核验${label}归属：${directory}（${
        error instanceof Error ? error.message : "未知错误"
      }）`,
    };
  }
  if (!existing.isDirectory())
    return {
      reason: `${label}不是环境自有目录，可能已被重定向：${directory}`,
    };
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch (error) {
    return {
      reason: `${label}无法解析：${directory}（${
        error instanceof Error ? error.message : "未知错误"
      }）`,
    };
  }
  if (resolved !== directory)
    return {
      reason: `${label}已指向所选环境之外的位置：${directory} → ${resolved}`,
    };
  for (const input of inputs)
    if (overlaps(resolved, input))
      return {
        reason: `${label}与输入素材重叠：${resolved} ↔ ${input}`,
      };
  return { directory: resolved };
}
