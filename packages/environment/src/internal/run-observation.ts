import { lstat, realpath, stat } from "node:fs/promises";
import { request, type ClientRequest } from "node:http";
import path from "node:path";

import {
  constantTimeEquals,
  newNonce,
  readLaunchConfig,
  readySignature,
} from "./launch-contract.ts";
import {
  recordedRunFacts,
  type ProcessLiveness,
  type RunObservation,
} from "./operation-contract.ts";
import { requestPrivateControl } from "./private-control.ts";
import {
  observeProcessLifecycle,
  type ProcessIdentity,
} from "./process-identity.ts";
import type { EnvironmentRecord, EnvironmentRunRecord } from "./record.ts";

export type RunTarget = {
  readonly run: EnvironmentRunRecord;
  readonly environmentId: string;
  readonly controlKey: string;
  readonly readyKey: string;
};

/**
 * 核验记录指向的私有运行现场仍是本环境自己创建的那一份：目录身份与权限、控制
 * socket 位置、启动配置内容与世代身份都必须成立；否则视为不可信，不连接也不发信号。
 */
export async function verifyRunTarget(
  record: EnvironmentRecord,
): Promise<
  | { readonly target: RunTarget }
  | { readonly reason: string; readonly liveness: ProcessLiveness }
> {
  const run = record.run;
  if (run === undefined)
    return { reason: "该环境记录没有受管理的运行分支", liveness: "absent" };
  const directory = await runDirectoryIdentity(run);
  if (directory !== "match")
    return {
      reason:
        directory === "unreadable"
          ? `私有运行目录不可核验：${run.privateDirectory}`
          : `私有运行目录身份或权限与记录不一致：${run.privateDirectory}`,
      liveness: "unknown",
    };
  const liveness = observeLiveness(run.processIdentity);
  if (path.dirname(run.controlSocket) !== run.privateDirectory)
    return {
      reason: `私有控制地址不属于本世代目录：${run.controlSocket}`,
      liveness,
    };
  const socket = await stat(run.controlSocket).catch(() => undefined);
  if (socket !== undefined && !socket.isSocket())
    return {
      reason: `私有控制地址不是本世代自有 socket：${run.controlSocket}`,
      liveness,
    };
  const config = await readLaunchConfig(run.launchConfigFile);
  if ("reason" in config) return { reason: config.reason, liveness };
  if (
    config.config.environmentId !== record.environmentId ||
    config.config.runId !== run.runId
  )
    return {
      reason: "启动配置身份与运行分支不一致，拒绝连接控制通道",
      liveness,
    };
  return {
    target: {
      run,
      environmentId: record.environmentId,
      controlKey: config.config.controlKey,
      readyKey: config.config.readyKey,
    },
  };
}

async function runDirectoryIdentity(
  run: EnvironmentRunRecord,
): Promise<"match" | "mismatch" | "unreadable"> {
  let resolved: string;
  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    [resolved, existing] = await Promise.all([
      realpath(run.privateDirectory),
      lstat(run.privateDirectory),
    ]);
  } catch {
    return "unreadable";
  }
  if (!existing.isDirectory() || resolved !== run.privateDirectory)
    return "mismatch";
  if ((existing.mode & 0o777) !== 0o700) return "mismatch";
  return existing.dev === run.privateDirectoryIdentity.device &&
    existing.ino === run.privateDirectoryIdentity.inode
    ? "match"
    : "mismatch";
}

export function observeLiveness(
  identity: ProcessIdentity | undefined,
): ProcessLiveness {
  if (identity === undefined) return "unknown";
  return observeProcessLifecycle(identity);
}

/**
 * 对本世代做一次实时观察：进程生存、私有控制通道查询与真实 ready 认证。
 * 控制通道失联或认证不成立都不改变已记录事实，只作为本次观察的拒绝原因返回。
 */
export async function observeRun(
  record: EnvironmentRecord,
  target: RunTarget,
  input: {
    readonly controlTimeoutMilliseconds: number;
    readonly readyTimeoutMilliseconds: number;
  },
): Promise<RunObservation> {
  const facts = recordedRunFacts(record);
  const liveness = observeLiveness(target.run.processIdentity);
  if (liveness !== "alive") return { ...facts, processLiveness: liveness };
  const control = await requestPrivateControl({
    socketPath: target.run.controlSocket,
    environmentId: target.environmentId,
    runId: target.run.runId,
    controlKey: target.controlKey,
    kind: "query",
    timeoutMilliseconds: input.controlTimeoutMilliseconds,
  });
  if ("reason" in control)
    return {
      ...facts,
      processLiveness: liveness,
      refusalReason: control.reason,
    };
  const state = control.reply.state;
  const observed: RunObservation = {
    ...facts,
    processLiveness: liveness,
    controlReachable: true,
    logHealth: state?.logHealth ?? facts.logHealth,
    ...(state === undefined ? {} : { controlState: state }),
  };
  const ready = await probeReady(target, input.readyTimeoutMilliseconds);
  if ("reason" in ready)
    return { ...observed, serviceReady: false, readyReason: ready.reason };
  return { ...observed, serviceReady: true };
}

export type ReadyProbe =
  | { readonly attested: true }
  | { readonly reason: string };

/**
 * 只按显式端口构造地址、不跟随重定向、不经代理地请求真实 `/api/ready`。
 * 成功要求 200、正确的服务字段、本世代 runId，以及用本次 nonce 算出的签名相符。
 */
export async function probeReady(
  target: RunTarget,
  timeoutMilliseconds: number,
): Promise<ReadyProbe> {
  const nonce = newNonce();
  const url = new URL(target.run.address);
  const response = await new Promise<
    | { readonly status: number; readonly body: string }
    | { readonly reason: string }
  >((resolve) => {
    let settled = false;
    let handle: ClientRequest | undefined;
    const finish = (
      value:
        | { readonly status: number; readonly body: string }
        | { readonly reason: string },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 无论超时、请求失败还是已经读完，都收回自有 HTTP 句柄：探测留下的socket
      // 会把调用进程吊住，让人误以为一次有限探测仍在进行。
      handle?.destroy();
      resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish({
          reason: `ready 探测超过 ${String(timeoutMilliseconds)} 毫秒`,
        }),
      timeoutMilliseconds,
    );
    handle = request(
      {
        host: url.hostname,
        port: url.port === "" ? target.run.port : Number(url.port),
        path: "/api/ready",
        method: "GET",
        agent: false,
        headers: { "digital-environment-nonce": nonce },
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          if (body.length < 65_536) body += chunk;
        });
        incoming.on("end", () =>
          finish({ status: incoming.statusCode ?? 0, body }),
        );
        incoming.on("error", (error) =>
          finish({ reason: `ready 响应读取失败：${error.message}` }),
        );
      },
    );
    handle.on("error", (error) =>
      finish({ reason: `ready 请求失败：${error.message}` }),
    );
    handle.end();
  });
  if ("reason" in response) return response;
  if (response.status !== 200)
    return { reason: `ready 返回状态 ${String(response.status)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { reason: "ready 响应不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { reason: "ready 响应不是对象" };
  const value = parsed as Record<string, unknown>;
  if (value.ok !== true || value.service !== "digital-product-service")
    return { reason: "ready 响应不表示服务就绪" };
  if (typeof value.runId !== "string" || value.runId !== target.run.runId)
    return { reason: `ready 响应世代不符：${String(value.runId)}` };
  if (typeof value.attestation !== "string")
    return { reason: "ready 响应缺少本世代认证签名" };
  const expected = readySignature(
    target.readyKey,
    target.environmentId,
    target.run.runId,
    nonce,
  );
  if (!constantTimeEquals(expected, value.attestation))
    return { reason: "ready 认证签名与本世代不符" };
  return { attested: true };
}
