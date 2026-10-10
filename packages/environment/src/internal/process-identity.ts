import { readFileSync, readlinkSync } from "node:fs";

/**
 * Linux 原生进程身份观察：只用于判断“记录里的进程是否还是当初那一个”，不构成
 * 任何信号授权。跨机器、非 Linux 或 /proc 不可读时如实返回不可观察。
 */
export type ProcessIdentity = {
  readonly pid: number;
  /** `/proc/<pid>/stat` 第 22 字段：进程在本机本 boot 内的启动刻度。 */
  readonly startTimeTicks: string;
  readonly pidNamespace: string;
  readonly uid: number;
  readonly bootId: string;
};

export type LifecycleObservation = "alive" | "exited" | "unknown";

export function observeProcessIdentity(
  pid: number,
): { readonly identity: ProcessIdentity } | { readonly reason: string } {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return { reason: `进程号无效：${String(pid)}` };
  try {
    return {
      identity: {
        pid,
        startTimeTicks: readStartTimeTicks(pid),
        pidNamespace: readNamespace(pid, "pid"),
        uid: readUid(pid),
        bootId: readBootId(),
      },
    };
  } catch (error) {
    return { reason: `无法读取进程 ${String(pid)} 身份：${describe(error)}` };
  }
}

/**
 * 身份核验：任何一项不一致或无法读取都不算同一个进程。ENOENT 是唯一可以断定
 * “已退出”的证据；权限、挂载或解析问题只能是未知。
 */
export function observeProcessLifecycle(
  identity: ProcessIdentity,
): LifecycleObservation {
  try {
    if (readBootId() !== identity.bootId) return "exited";
    const startTimeTicks = readStartTimeTicks(identity.pid);
    if (startTimeTicks !== identity.startTimeTicks) return "exited";
    if (readNamespace(identity.pid, "pid") !== identity.pidNamespace)
      return "exited";
    if (readUid(identity.pid) !== identity.uid) return "exited";
    return "alive";
  } catch (error) {
    return isNotFound(error) ? "exited" : "unknown";
  }
}

export function sameProcessIdentity(
  left: ProcessIdentity,
  right: ProcessIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.startTimeTicks === right.startTimeTicks &&
    left.pidNamespace === right.pidNamespace &&
    left.uid === right.uid &&
    left.bootId === right.bootId
  );
}

export function processIdentityProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "进程身份不是对象";
  const identity = value as Record<string, unknown>;
  if (!Number.isSafeInteger(identity.pid) || (identity.pid as number) <= 0)
    return "进程身份缺少有效 PID";
  if (
    typeof identity.startTimeTicks !== "string" ||
    !/^[0-9]+$/u.test(identity.startTimeTicks)
  )
    return "进程身份缺少启动刻度";
  if (
    typeof identity.pidNamespace !== "string" ||
    identity.pidNamespace.length === 0
  )
    return "进程身份缺少 PID 命名空间";
  if (!Number.isSafeInteger(identity.uid)) return "进程身份缺少 UID";
  if (
    typeof identity.bootId !== "string" ||
    !/^[A-Za-z0-9-]{8,128}$/u.test(identity.bootId)
  )
    return "进程身份缺少 boot 标识";
  return undefined;
}

function readStartTimeTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // comm 可含空格与括号，因此从最后一个 `)` 之后开始切分；其后的字段从第 3 个起算。
  const closing = stat.lastIndexOf(")");
  if (closing < 0) throw new Error("进程 stat 缺少 comm 结束符");
  const fields = stat
    .slice(closing + 1)
    .trim()
    .split(/\s+/u);
  const startTimeTicks = fields[19];
  if (startTimeTicks === undefined || !/^[0-9]+$/u.test(startTimeTicks))
    throw new Error("进程 stat 缺少启动刻度");
  return startTimeTicks;
}

/** 命名空间条目是 magic symlink，只能 readlink，读取内容会失败。 */
function readNamespace(pid: number, kind: "pid"): string {
  const value = readlinkSync(`/proc/${pid}/ns/${kind}`);
  if (!/^[a-z]+:\[[0-9]+\]$/u.test(value))
    throw new Error(`进程 ${String(pid)} 的 ${kind} 命名空间不可识别`);
  return value;
}

function readUid(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const line = status
    .split("\n")
    .find((candidate) => candidate.startsWith("Uid:"));
  const first = line?.split(/\s+/u)[1];
  if (first === undefined || !/^[0-9]+$/u.test(first))
    throw new Error("进程 status 缺少 Uid");
  return Number(first);
}

function readBootId(): string {
  const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[A-Za-z0-9-]{8,128}$/u.test(value)) throw new Error("boot 标识不可读");
  return value;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
