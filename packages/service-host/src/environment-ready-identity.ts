import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * 环境外层启动本产品时只交来一个私有启动配置路径；这里在产品侧核验最小身份字段，
 * 用于对真实 ready 响应签名。产品不认识环境的其他结构，也不依赖环境实现。
 */
const launchConfigVariable = "DIGITAL_ENVIRONMENT_LAUNCH_CONFIG";
const launchProtocol = "digital-environment-launch-v1";
const readyTag = "digital-environment-ready-v1";

/** 认证请求带来一次性 nonce；没有这个请求头时 ready 响应与无环境运行时完全一致。 */
export const readyNonceHeader = "digital-environment-nonce";

export type ReadyIdentity = {
  readonly environmentId: string;
  readonly runId: string;
  readonly readyKey: string;
};

export type ReadyIdentityResolution =
  | { readonly identity: ReadyIdentity }
  | { readonly absent: true }
  | { readonly problem: string };

/** 缺少启动配置是常态（独立部署），只有指向配置却读不出可信身份才算问题。 */
export function resolveReadyIdentity(
  environment: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ReadyIdentityResolution {
  const configPath = environment[launchConfigVariable];
  if (configPath === undefined || configPath.length === 0)
    return { absent: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(configPath)) as unknown;
  } catch (error) {
    return {
      problem: `无法读取环境启动配置：${error instanceof Error ? error.message : "未知错误"}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { problem: "环境启动配置不是对象" };
  const config = parsed as Record<string, unknown>;
  if (config.protocol !== launchProtocol)
    return { problem: "环境启动配置协议未知" };
  const { environmentId, runId } = config;
  if (typeof environmentId !== "string" || environmentId.length === 0)
    return { problem: "环境启动配置字段 environmentId 缺失" };
  if (typeof runId !== "string" || runId.length === 0)
    return { problem: "环境启动配置字段 runId 缺失" };
  const readyKey = config.readyKey;
  if (typeof readyKey !== "string" || !/^[a-f0-9]{32,128}$/u.test(readyKey))
    return { problem: "环境启动配置字段 readyKey 不是合法密钥" };
  return {
    identity: {
      environmentId,
      runId,
      readyKey,
    },
  };
}

/** 签名对固定字段 JSON 数组计算，编码无歧义；nonce 由请求方每次重新生成。 */
export function readyAttestation(
  identity: ReadyIdentity,
  nonce: string,
): { readonly runId: string; readonly attestation: string } {
  return {
    runId: identity.runId,
    attestation: createHmac("sha256", identity.readyKey)
      .update(
        JSON.stringify([
          readyTag,
          identity.environmentId,
          identity.runId,
          nonce,
        ]),
      )
      .digest("hex"),
  };
}
