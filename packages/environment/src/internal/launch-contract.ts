import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";

/** 跨进程线格式：启动配置、控制通道证明与实际 ready 实例签名。 */
export const launchProtocol = "digital-environment-launch-v1" as const;
export const controlTag = "digital-environment-control-v1" as const;
export const readyTag = "digital-environment-ready-v1" as const;
export const handoffMarkerTag =
  "DIGITAL_ENVIRONMENT_STREAM_HANDOFF_V1" as const;
/** 私有启动配置只通过环境变量传路径，秘密本身不进 argv。 */
export const launchConfigEnvironmentVariable =
  "DIGITAL_ENVIRONMENT_LAUNCH_CONFIG" as const;

export type LaunchConfig = {
  readonly protocol: typeof launchProtocol;
  readonly environmentId: string;
  readonly runId: string;
  readonly controlSocket: string;
  readonly productLogFile: string;
  /** 控制通道认证密钥；只存在于 0700 目录内的 0600 文件。 */
  readonly controlKey: string;
  /** 实际 ready 响应签名密钥；只在产品进程内使用。 */
  readonly readyKey: string;
  readonly handoff: { readonly stdout: string; readonly stderr: string };
  /**
   * 发布界限（绝对时刻，毫秒）：父操作必须在此之前把就绪事实写入记录并确认发布。
   * 逾期未发布的世代由引导自行收尾，不会留下无人引用的后台服务。
   */
  readonly publishDeadlineAt: number;
};

export function createLaunchConfig(input: {
  readonly environmentId: string;
  readonly runId: string;
  readonly controlSocket: string;
  readonly productLogFile: string;
  readonly publishDeadlineAt: number;
}): LaunchConfig {
  return {
    protocol: launchProtocol,
    environmentId: input.environmentId,
    runId: input.runId,
    controlSocket: input.controlSocket,
    productLogFile: input.productLogFile,
    publishDeadlineAt: input.publishDeadlineAt,
    controlKey: randomBytes(32).toString("hex"),
    readyKey: randomBytes(32).toString("hex"),
    handoff: {
      stdout: randomBytes(16).toString("hex"),
      stderr: randomBytes(16).toString("hex"),
    },
  };
}

/** 原子写私有启动配置：同目录临时文件、flush、rename，权限 0600。 */
export async function writeLaunchConfig(
  filePath: string,
  config: LaunchConfig,
): Promise<void> {
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

export type LaunchConfigRead =
  | { readonly config: LaunchConfig }
  | { readonly reason: string };

/** 读取并核验启动配置；任何形状不符都按不可信处理，不做修复。 */
export async function readLaunchConfig(
  filePath: string,
): Promise<LaunchConfigRead> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    return {
      reason: `无法读取启动配置：${error instanceof Error ? error.message : "未知错误"}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "启动配置不是合法 JSON" };
  }
  const problem = launchConfigProblem(parsed);
  return problem === undefined
    ? { config: parsed as LaunchConfig }
    : { reason: problem };
}

export function launchConfigProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "启动配置不是对象";
  const config = value as Record<string, unknown>;
  if (config.protocol !== launchProtocol)
    return `启动配置协议未知：${String(config.protocol)}`;
  for (const key of [
    "environmentId",
    "runId",
    "controlSocket",
    "productLogFile",
  ])
    if (typeof config[key] !== "string" || config[key] === "")
      return `启动配置字段 ${key} 缺失`;
  if (
    typeof config.publishDeadlineAt !== "number" ||
    !Number.isInteger(config.publishDeadlineAt) ||
    config.publishDeadlineAt <= 0
  )
    return "启动配置字段 publishDeadlineAt 不是绝对时刻";
  for (const key of ["controlKey", "readyKey"]) {
    const secret = config[key];
    if (typeof secret !== "string" || !/^[a-f0-9]{32,128}$/u.test(secret))
      return `启动配置字段 ${key} 不是合法密钥`;
  }
  const handoff = config.handoff;
  if (
    typeof handoff !== "object" ||
    handoff === null ||
    !/^[a-f0-9]{16,64}$/u.test(
      String((handoff as Record<string, unknown>).stdout),
    ) ||
    !/^[a-f0-9]{16,64}$/u.test(
      String((handoff as Record<string, unknown>).stderr),
    )
  )
    return "启动配置缺少双流交接标记";
  return undefined;
}

/**
 * 证明与签名都使用固定字段 JSON 数组编码，避免字符串拼接歧义；比较使用常量时间。
 */
export function signEnvelope(
  key: string,
  fields: readonly (string | number)[],
): string {
  return createHmac("sha256", key).update(JSON.stringify(fields)).digest("hex");
}

export function controlProof(
  key: string,
  kind: "query" | "stop" | "publish",
  runId: string,
  nonce: string,
): string {
  return signEnvelope(key, [controlTag, kind, runId, nonce]);
}

export function readySignature(
  key: string,
  environmentId: string,
  runId: string,
  nonce: string,
): string {
  return signEnvelope(key, [readyTag, environmentId, runId, nonce]);
}

export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/** 该环境在私有运行命名空间下的目录名：同一环境的每个世代都是它的子目录。 */
export function privateRunScopeName(
  workspacePath: string,
  environmentId: string,
): string {
  return createHash("sha256")
    .update(`${workspacePath}\n${environmentId}`)
    .digest("hex")
    .slice(0, 16);
}

/** 私有运行目录名只使用哈希，避免绝对路径过长而无法承载 Unix socket。 */
export function privateRunDirectoryName(
  workspacePath: string,
  environmentId: string,
  runId: string,
): string {
  const scope = privateRunScopeName(workspacePath, environmentId);
  const generation = createHash("sha256")
    .update(`${workspacePath}\n${environmentId}\n${runId}`)
    .digest("hex")
    .slice(0, 12);
  return `${scope}/${generation}`;
}
