import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import {
  handoffMarkerTag,
  launchConfigEnvironmentVariable,
  launchConfigProblem,
  type LaunchConfig,
} from "./launch-contract.ts";
import {
  listenPrivateControl,
  type ControlLogHealth,
  type ControlPhase,
} from "./private-control.ts";
import { observeProcessIdentity } from "./process-identity.ts";
import { createDiagnosticRedactor } from "./redact.ts";

/**
 * 只被环境启动的产品进程通过 `node --import` 加载的外层引导：建立本世代私有控制
 * 通道、把本产品进程的 stdout/stderr 完整脱敏后同步落盘、向父操作提交真实进程身份，
 * 并在取得许可后才让 Node 加载正式入口。它不导入产品实现，不扫描进程或数据库。
 */
type ChildProcessChannel = {
  send(message: Record<string, unknown>): boolean;
  disconnect(): void;
};

const channel = process as NodeJS.Process & ChildProcessChannel;
const launchConfigPath = process.env[launchConfigEnvironmentVariable];

function requireLaunchConfig(): LaunchConfig {
  if (launchConfigPath === undefined || launchConfigPath.length === 0)
    throw new Error("环境引导缺少启动配置路径");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(launchConfigPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `环境引导无法读取启动配置：${error instanceof Error ? error.message : "未知错误"}`,
      { cause: error },
    );
  }
  const problem = launchConfigProblem(parsed);
  if (problem !== undefined)
    throw new Error(`环境引导启动配置无效：${problem}`);
  return parsed as LaunchConfig;
}

const config = requireLaunchConfig();
const logFd = openSync(config.productLogFile, "a", 0o600);

let phase: ControlPhase = "handshake";
let logHealth: ControlLogHealth = "recording";
let logProblem: string | undefined;

/**
 * 同步写入并处理短写；日志自身的失败只改变健康事实，绝不抛出覆盖业务首因。
 */
function appendLog(line: string): boolean {
  if (logHealth === "incomplete") return false;
  const buffer = Buffer.from(line, "utf8");
  try {
    let written = 0;
    while (written < buffer.length)
      written += writeSync(logFd, buffer, written);
    return true;
  } catch (error) {
    logHealth = "incomplete";
    logProblem = `运行日志写入被拒绝：${error instanceof Error ? error.message : "未知错误"}`;
    return false;
  }
}

type OutputSink = {
  readonly decoder: StringDecoder;
  readonly redactor: ReturnType<typeof createDiagnosticRedactor>;
  readonly label: string;
};

/** 安装接收端之前捕获的原始写出，只用于双流交接标记。 */
type ThroughWrite = (chunk: string, encoding?: BufferEncoding) => boolean;

function captureWrite(stream: NodeJS.WriteStream): ThroughWrite {
  const write = stream.write.bind(stream);
  return (chunk, encoding) => write(chunk, encoding);
}

const stdoutStream = process.stdout;
const stderrStream = process.stderr;
const originalStdoutWrite = captureWrite(stdoutStream);
const originalStderrWrite = captureWrite(stderrStream);
const sinks: Record<"stdout" | "stderr", OutputSink> = {
  stdout: {
    decoder: new StringDecoder("utf8"),
    redactor: createDiagnosticRedactor([config.readyKey, config.controlKey]),
    label: "out ",
  },
  stderr: {
    decoder: new StringDecoder("utf8"),
    redactor: createDiagnosticRedactor([config.readyKey, config.controlKey]),
    label: "err ",
  },
};

/**
 * 按 Node Writable 的重载形状接管写出：编码与回调都可能处在第二个参数位置，
 * 缓冲区忽略编码，字符串按调用方声明的编码取字节。落盘仍统一按 UTF-8 行记录。
 */
function installSink(stream: NodeJS.WriteStream, sink: OutputSink): void {
  stream.write = (
    chunk: unknown,
    encodingOrCallback?: unknown,
    callbackOrUndefined?: unknown,
  ): boolean => {
    const encoding =
      typeof encodingOrCallback === "function" ? undefined : encodingOrCallback;
    const callback =
      typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callbackOrUndefined;
    try {
      const buffer = toBuffer(chunk, encoding);
      const text = sink.decoder.write(buffer);
      if (text.length > 0) {
        const redacted = sink.redactor.write(text);
        if (redacted.length > 0) sinkWrite(sink, redacted);
      }
    } catch (error) {
      noteSinkFailure(error);
    }
    if (typeof callback === "function") {
      const invoke = callback as (error?: Error) => void;
      // 流合同要求回调异步触发；同步写入已完成，不制造未等待的 Promise。
      queueMicrotask(() => invoke());
    }
    return true;
  };
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string")
    return Buffer.from(
      chunk,
      typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
    );
  return Buffer.from(String(chunk));
}

/**
 * 行脱敏器只交出已完结的行且不带行尾：每条产品输出各占一条日志记录，直接拼接会让
 * 后续记录接在同一行上，破坏日志的行语义。
 */
function sinkWrite(sink: OutputSink, text: string): void {
  const at = new Date().toISOString();
  for (const line of text.split("\n"))
    appendLog(`${at} ${sink.label}${line}\n`);
}

function flushSinkTail(sink: OutputSink): void {
  const trailing = `${sink.decoder.end()}${sink.redactor.end()}`;
  if (trailing.length > 0)
    sinkWrite(sink, trailing.endsWith("\n") ? trailing.slice(0, -1) : trailing);
}

function noteSinkFailure(error: unknown): void {
  if (logHealth !== "incomplete") {
    logHealth = "incomplete";
    logProblem = `运行日志接收端异常：${error instanceof Error ? error.message : "未知错误"}`;
  }
}

installSink(stdoutStream, sinks.stdout);
installSink(stderrStream, sinks.stderr);

/**
 * 只观察，不接管：普通 JS 加载错误与未捕获异常仍由 Node 默认终止。这里在终止前
 * 把可定位诊断（来源、名称、消息、栈、cause、AggregateError 子错误）脱敏落入日志。
 */
process.on("uncaughtExceptionMonitor", (error: unknown, origin: string) => {
  persistException(error, origin);
});

/**
 * 本世代的持久出口只有这一份：异常诊断在落盘前必须同时应用通用凭据规则与本世代
 * 显式秘密，否则默认终止前留下的就是可读的失败现场。
 */
const generationSecrets = [
  config.controlKey,
  config.readyKey,
  config.handoff.stdout,
  config.handoff.stderr,
];

function persistException(error: unknown, origin: string): void {
  const at = new Date().toISOString();
  let diagnostic: string;
  try {
    diagnostic = formatDiagnostic(error);
  } catch (formatFailure) {
    // 描述失败不能覆盖首因，也不再递归描述：只保留已知的来源、原始抛出值与该失败。
    diagnostic = `异常诊断未能完整描述（${
      formatFailure instanceof Error ? formatFailure.message : "未知错误"
    }）；${salvageThrown(error)}`;
  }
  for (const line of createDiagnosticRedactor(generationSecrets)(
    diagnostic,
  ).split("\n"))
    if (line !== "") appendLog(`${at} err 未捕获异常来源=${origin} ${line}\n`);
}

/**
 * 完整描述失败时，首因里可读的部分（名称与消息）仍要单独取出来；任何一次读取自身
 * 失败都只是少一条事实，不能反过来掩盖原始抛出。
 */
function salvageThrown(error: unknown): string {
  if (typeof error !== "object" || error === null)
    return `抛出值 ${describeValue(error)}`;
  const parts: string[] = [];
  for (const field of ["name", "message"] as const) {
    try {
      const value = (error as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length > 0)
        parts.push(`${field}=${value}`);
    } catch {
      parts.push(`${field}不可读取`);
    }
  }
  return parts.length > 0
    ? parts.join("；")
    : "抛出对象没有可读出的名称或消息字段";
}

process.on("exit", () => {
  try {
    flushSinkTail(sinks.stdout);
    flushSinkTail(sinks.stderr);
    // 先定健康事实再落盘，日志文件、控制回音与记录中的收尾标记才不会互相矛盾。
    if (logHealth === "recording") logHealth = "complete";
    appendLog(
      `${new Date().toISOString()} exit 运行日志收尾 health=${logHealth}${
        logProblem === undefined ? "" : ` problem=${logProblem}`
      }\n`,
    );
  } catch {
    // 收尾失败不能改变进程退出，也不能宣称日志完整。
  }
  try {
    closeSync(logFd);
  } catch {
    // 句柄已失效时保留已知事实即可。
  }
});

/**
 * 唯一完整可用诊断：聚合自身的名称、消息、栈与 cause 都保留，全部子错误逐项展开，
 * 不做固定项数或深度截断。只有循环引用会被停止，因为继续展开不会产生新信息。
 */
function formatDiagnostic(error: unknown): string {
  const lines: string[] = [];
  describeThrown(error, "", lines, new WeakSet<object>());
  return lines.join("\n");
}

function describeThrown(
  error: unknown,
  prefix: string,
  lines: string[],
  seen: WeakSet<object>,
): void {
  if (typeof error !== "object" || error === null) {
    lines.push(`${prefix}抛出值 ${describeValue(error)}`);
    return;
  }
  if (seen.has(error)) {
    lines.push(`${prefix}同一错误对象已在上文展开`);
    return;
  }
  seen.add(error);
  if (error instanceof Error) {
    lines.push(
      `${prefix}${error.name}: ${error.message}；stack ${String(error.stack)}`,
    );
    if (error instanceof AggregateError)
      for (const [index, item] of error.errors.entries())
        describeThrown(item, `${prefix}子错误[${String(index)}] `, lines, seen);
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined)
      describeThrown(cause, `${prefix}cause `, lines, seen);
    return;
  }
  lines.push(`${prefix}抛出值 ${describeValue(error)}`);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function readState(): {
  phase: ControlPhase;
  pid: number;
  logHealth: ControlLogHealth;
  logProblem?: string;
  published: boolean;
} {
  return {
    phase,
    pid: process.pid,
    logHealth,
    ...(logProblem === undefined ? {} : { logProblem }),
    published,
  };
}

/** 停止只让目标进程向自身发出一次 SIGTERM，后续收尾沿用产品既有生命周期。 */
let terminateRequested = false;
function requestSelfTerminate(): { accepted: boolean; already: boolean } {
  if (terminateRequested) return { accepted: true, already: true };
  terminateRequested = true;
  phase = "stopping";
  try {
    process.kill(process.pid, "SIGTERM");
    return { accepted: true, already: false };
  } catch {
    return { accepted: false, already: false };
  }
}

/**
 * 发布确认有两个来源：本世代的父操作经 IPC 交出，或同一记录的公开命令经私有控制通道
 * 重新确认。只有已取得进入许可且尚未开始收尾的世代接受确认；确认一旦成立就撤销尚未
 * 发布时的自行收尾计时，本世代从此由产品自己长期持有。声明在控制通道建立之前，因此
 * 任何一次查询读到的都是同一个事实。
 */
let published = false;
let publishDeadline: ReturnType<typeof setTimeout> | undefined;
let publishGrace: ReturnType<typeof setTimeout> | undefined;

function requestPublish(): {
  accepted: boolean;
  already: boolean;
  reason?: string;
} {
  if (published) return { accepted: true, already: true };
  if (phase !== "serving")
    return {
      accepted: false,
      already: false,
      reason: "本世代尚未取得进入正式入口的许可",
    };
  if (terminateRequested)
    return {
      accepted: false,
      already: false,
      reason: "本世代已在自行收尾，发布确认不再成立",
    };
  published = true;
  stopPublicationWatch();
  appendLog(
    `${new Date().toISOString()} run 发布确认经私有控制通道重新成立，本世代继续作为受管理服务运行\n`,
  );
  return { accepted: true, already: false };
}

function send(message: Record<string, unknown>): void {
  try {
    channel.send(message);
  } catch {
    // 父操作已断开时由 disconnect 处理。
  }
}

send({ type: "sinks-ready", runId: config.runId });
// 交接标记必须绕过接收端，使用安装前捕获的原始写出直达父操作管道。
originalStdoutWrite(`${handoffMarkerTag} ${config.handoff.stdout}\n`);
originalStderrWrite(`${handoffMarkerTag} ${config.handoff.stderr}\n`);

const identityObservation = observeProcessIdentity(process.pid);
if (!("identity" in identityObservation)) {
  appendLog(
    `${new Date().toISOString()} err 无法建立本世代进程身份：${identityObservation.reason}\n`,
  );
  process.exit(1);
}

const control = await listenPrivateControl({
  socketPath: config.controlSocket,
  environmentId: config.environmentId,
  runId: config.runId,
  controlKey: config.controlKey,
  timeoutMilliseconds: 5_000,
  readState,
  requestSelfTerminate,
  requestPublish,
});

send({
  type: "identity",
  runId: config.runId,
  environmentId: config.environmentId,
  pid: process.pid,
  identity: identityObservation.identity,
  controlSocket: config.controlSocket,
});

/**
 * 未取得进入正式入口的许可就绝不加载产品：准许前断开或超时都只收尾无产品资源的
 * 引导，控制通道随之关闭。
 */
const admission = await new Promise<"admit" | "refuse" | "lost" | "timeout">(
  (resolve) => {
    let settled = false;
    const finish = (outcome: "admit" | "refuse" | "lost" | "timeout"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("message", onMessage);
      process.removeListener("disconnect", onDisconnect);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), 120_000);
    const onMessage = (message: unknown): void => {
      const value = message as { type?: string; reason?: string };
      if (value?.type === "admit") finish("admit");
      else if (value?.type === "refuse") {
        appendLog(
          `${new Date().toISOString()} err 父操作不准许进入产品：${String(
            value.reason ?? "原因未说明",
          )}\n`,
        );
        finish("refuse");
      }
    };
    const onDisconnect = (): void => finish("lost");
    process.on("message", onMessage);
    process.on("disconnect", onDisconnect);
  },
);

if (admission !== "admit") {
  const reason =
    admission === "timeout"
      ? "启动握手超过期限没有取得许可"
      : admission === "lost"
        ? "父操作在准许前断开"
        : "父操作拒绝本世代进入正式入口";
  appendLog(`${new Date().toISOString()} exit 引导未完成握手：${reason}\n`);
  await control.close();
  process.exit(1);
}

// 准许后父操作随即退出并关闭原管道读端。此后所有 stdout/stderr 都经由已安装的接收
// 端落入本世代自有日志，不再向继承的管道写出，也不留下绕过脱敏的持久出口。
phase = "serving";
appendLog(
  `${new Date().toISOString()} run 已取得进入正式入口的许可，日志由本产品进程持有\n`,
);

/**
 * 只有取得发布确认，本世代才允许作为受管理后台服务长期存活。确认来自父操作写入就绪
 * 事实后经 IPC 交出的那一条，或来自同一记录在下一次公开启动命令里经私有控制通道的
 * 重新确认。两者都没有到达时，失联（父操作退出）或发布界限到期都让本进程向自身发出
 * 一次 SIGTERM，沿用产品既有的收尾宽限自行结束，不留下无人引用的服务等待人工排查。
 * 已发出的发布确认可能仍在管道里，因此断开后先给一次短暂宽限。
 */
const publishGraceMilliseconds = 5_000;

function closeUnpublished(reason: string): void {
  if (published || terminateRequested) return;
  appendLog(
    `${new Date().toISOString()} exit 本世代未经发布确认，引导自行收尾：${reason}\n`,
  );
  requestSelfTerminate();
}

function stopPublicationWatch(): void {
  for (const timer of [publishDeadline, publishGrace])
    if (timer !== undefined) clearTimeout(timer);
  publishDeadline = undefined;
  publishGrace = undefined;
}

publishDeadline = setTimeout(
  () => closeUnpublished("已到约定的发布界限"),
  Math.max(0, config.publishDeadlineAt - Date.now()),
);
process.on("message", (message: unknown) => {
  const value = message as { type?: string };
  if (value?.type !== "published") return;
  published = true;
  stopPublicationWatch();
  try {
    channel.disconnect();
  } catch {
    // 引用已释放时不再处理。
  }
});
process.on("disconnect", () => {
  if (published || publishGrace !== undefined) return;
  publishGrace = setTimeout(
    () => closeUnpublished("父操作在发布就绪事实之前断开"),
    publishGraceMilliseconds,
  );
});
