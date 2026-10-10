import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  invalidEnvironmentFacts,
  noRunFacts,
  operationMarker,
  type KernelCancellation,
  type DeleteOperationResult,
  type DeleteRequest,
  type OperationRequest,
  type OperationResult,
  type PrepareRequest,
  type PrepareOperationResult,
  type RebuildOperationResult,
  type RebuildRequest,
  type StartRequest,
  type StartOperationResult,
  type StopRequest,
  type StopOperationResult,
} from "./operation-contract.ts";
import { createLayout, type EnvironmentLayout } from "./paths.ts";
import { filteredEnvironment } from "./processes.ts";
import { createDiagnosticRedactor } from "./redact.ts";

const stderrExcerptLimit = 4_000;

/**
 * 取消成立后留给持锁操作进程完成自有收尾的有界宽限：覆盖握手、就绪确认、私有控制
 * 自停与产品 30 秒关闭宽限的最坏组合。宽限本身是一次全新的计时，不复用已取消的条件。
 */
const cleanupAllowanceMilliseconds = 90_000;

/** 内核向持锁操作进程转发的终止信号。 */
const forwardedSignals = ["SIGINT", "SIGTERM"] as const;

function forwardedSignal(signal: AbortSignal | undefined): NodeJS.Signals {
  const reason: unknown = signal?.reason;
  return (
    forwardedSignals.find((candidate) => candidate === reason) ?? "SIGTERM"
  );
}

/** API 与 CLI 共用的准备内核。 */
export async function runPrepareUnderLock(
  request: PrepareRequest,
  cancellation: KernelCancellation = {},
): Promise<PrepareOperationResult> {
  const result = await runUnderLock(request, cancellation);
  return result.kind === "prepare" ? result : kernelFailure(request);
}

/** API 与 CLI 共用的启动内核。 */
export async function runStartUnderLock(
  request: StartRequest,
  cancellation: KernelCancellation = {},
): Promise<StartOperationResult> {
  const result = await runUnderLock(request, cancellation);
  return result.kind === "start" ? result : kernelFailure(request);
}

/** API 与 CLI 共用的停止内核。 */
export async function runStopUnderLock(
  request: StopRequest,
  cancellation: KernelCancellation = {},
): Promise<StopOperationResult> {
  const result = await runUnderLock(request, cancellation);
  return result.kind === "stop" ? result : kernelFailure(request);
}

/** API 与 CLI 共用的重建内核。 */
export async function runRebuildUnderLock(
  request: RebuildRequest,
  cancellation: KernelCancellation = {},
): Promise<RebuildOperationResult> {
  const result = await runUnderLock(request, cancellation);
  return result.kind === "rebuild" ? result : kernelFailure(request);
}

/** API 与 CLI 共用的删除内核。 */
export async function runDeleteUnderLock(
  request: DeleteRequest,
  cancellation: KernelCancellation = {},
): Promise<DeleteOperationResult> {
  const result = await runUnderLock(request, cancellation);
  return result.kind === "delete" ? result : kernelFailure(request);
}

/**
 * 变更命令统一经 `flock --no-fork` 执行包内有界操作入口：执行操作的进程继承锁
 * 描述符并持锁至退出，因此同一环境的准备、启动、停止、重建与删除互相串行。内核锁
 * 只约束经公开接口发起的同环境变更命令，被启动的产品进程本身长期存活且不受该锁约束。
 *
 * 取消条件只负责把执行意图交给持锁操作进程：调用方的 signal 换成一次终止信号转发，
 * 期限由操作进程按同一绝对终点自行到期。转发之后内核改用一份全新的有界宽限等待操作
 * 进程交出真实的收尾结果，绝不因为条件已取消而放弃等待或跳过清理。
 */
async function runUnderLock(
  request: OperationRequest,
  cancellation: KernelCancellation,
): Promise<OperationResult> {
  const layout = createLayout(request.workspacePath, request.environment);
  if ("reason" in layout) return invalidRequest(request, layout.reason);

  await ensureLockArea(layout);
  const outbound: OperationRequest =
    cancellation.deadlineAt === undefined
      ? request
      : { ...request, deadlineAt: cancellation.deadlineAt };
  const child = spawn(
    "flock",
    [
      "--no-fork",
      layout.lockPath,
      process.execPath,
      operationEntryPath(),
      request.kind,
      JSON.stringify(outbound),
    ],
    {
      cwd: layout.workspacePath,
      env: filteredEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let cancelNote: string | undefined;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < stderrExcerptLimit * 2) stderr += chunk;
  });
  let spawnError: string | undefined;
  child.on("error", (error) => {
    spawnError = error.message;
  });

  const close = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    allowanceExpired: boolean;
  }>((resolve) => {
    let settled = false;
    let allowance: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      allowanceExpired = false,
    ): void => {
      if (settled) return;
      settled = true;
      for (const timer of [allowance, deadline])
        if (timer !== undefined) clearTimeout(timer);
      if (abortListener !== undefined)
        cancellation.signal?.removeEventListener("abort", abortListener);
      resolve({ code, signal, allowanceExpired });
    };
    child.once("close", (code, signal) => finish(code, signal));
    /** 取消只转发一次终止信号；后续等待交给全新的宽限计时。 */
    const forward = (cause: string): void => {
      if (settled || cancelNote !== undefined) return;
      cancelNote = cause;
      allowance = setTimeout(
        () => finish(null, null, true),
        cleanupAllowanceMilliseconds,
      );
      allowance.unref();
      try {
        child.kill(forwardedSignal(cancellation.signal));
      } catch (error) {
        cancelNote = `${cause}（转发失败：${
          error instanceof Error ? error.message : "未知错误"
        }）`;
      }
    };
    abortListener = (): void => {
      const observed = cancellation.signal?.reason;
      forward(
        `调用方取消本次操作${
          typeof observed === "string" ? `（${observed}）` : ""
        }`,
      );
    };
    if (cancellation.signal !== undefined) {
      cancellation.signal.addEventListener("abort", abortListener, {
        once: true,
      });
      if (cancellation.signal.aborted) abortListener();
    }
    if (cancellation.deadlineAt !== undefined) {
      deadline = setTimeout(
        () => {
          forward(
            `操作期限到期（约定终点 ${new Date(
              cancellation.deadlineAt as number,
            ).toISOString()} UTC）`,
          );
        },
        Math.max(0, cancellation.deadlineAt - Date.now()),
      );
      deadline.unref();
    }
  });

  const result = parseOperationResult(stdout, request.kind);
  if (result !== undefined)
    // 操作进程在有界宽限内交出了真实的取消收尾结果：把内核观察到的取消来源并列进入
    // 诊断，既不覆盖操作内部记录的首因，也不把它说成已经完成收尾。
    return cancelNote === undefined
      ? result
      : {
          ...result,
          diagnostics: [...result.diagnostics, `取消来源：${cancelNote}`],
        };
  // 操作进程没有交出结构化结果：它已退出（锁随之释放），但其内部可能仍有未确认
  // 退出的子进程或已受影响的状态，如实报告 unknown 而不是宣称收尾完成。
  const cancellationFacts =
    cancelNote === undefined
      ? ""
      : ` 取消已转发（${cancelNote}），${
          close.allowanceExpired
            ? `操作进程在 ${String(
                cleanupAllowanceMilliseconds,
              )} 毫秒收尾宽限内没有交出结果`
            : "操作进程在收尾宽限内退出但没有交出结果"
        }`;
  const message = createDiagnosticRedactor([])(
    `环境操作进程未交出结果（退出码 ${String(close.code)} 信号 ${String(
      close.signal,
    )}${spawnError === undefined ? "" : ` 启动错误 ${spawnError}`}）：${
      cancellationFacts === ""
        ? stderr.slice(-stderrExcerptLimit) || "无标准错误输出"
        : `${cancellationFacts}；标准错误 ${
            stderr.slice(-stderrExcerptLimit) || "无"
          }`
    }`,
  );
  const cleanup = {
    state: spawnError === undefined ? "unknown" : "not-started",
    errors:
      spawnError === undefined
        ? []
        : [`无法启动互斥操作（flock 或 Node 入口不可执行）：${spawnError}`],
  } as const;
  const environment = invalidEnvironmentFacts(
    request.workspacePath,
    request.environment,
  );
  if (request.kind === "prepare")
    return {
      kind: "prepare",
      status: "failed",
      environment,
      failure: { stage: "operation", message, exitCode: close.code },
      cleanup,
      logs: { directory: layout.logsRoot, files: [] },
      diagnostics: [],
    };
  if (request.kind === "start")
    return {
      kind: "start",
      status: "failed",
      environment,
      run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
      failure: { stage: "operation", message, exitCode: close.code },
      cleanup,
      logs: { directory: layout.logsRoot, files: [] },
      diagnostics: [],
    };
  // 破坏性操作没有交出结果时，意图与部分回收都可能已发生：只能报未确认。
  if (request.kind === "rebuild")
    return {
      kind: "rebuild",
      status: "not-confirmed",
      environment,
      run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
      failure: { stage: "operation", message, exitCode: close.code },
      cleanup,
      logs: { directory: layout.logsRoot, files: [] },
      diagnostics: [],
    };
  if (request.kind === "delete")
    return {
      kind: "delete",
      status: "not-confirmed",
      environment,
      run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
      failure: { stage: "operation", message, exitCode: close.code },
      cleanup,
      logs: { directory: layout.logsRoot, files: [] },
      diagnostics: [],
    };
  return {
    kind: "stop",
    status: "not-confirmed",
    environment,
    run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
    failure: { stage: "operation", message, exitCode: close.code },
    cleanup,
    logs: { directory: layout.logsRoot, files: [] },
    diagnostics: [],
  };
}

/** 操作进程交出与请求不符的结果：按没有结果处理，不猜测其含义。 */
function kernelFailure(request: PrepareRequest): PrepareOperationResult;
function kernelFailure(request: StartRequest): StartOperationResult;
function kernelFailure(request: StopRequest): StopOperationResult;
function kernelFailure(request: RebuildRequest): RebuildOperationResult;
function kernelFailure(request: DeleteRequest): DeleteOperationResult;
function kernelFailure(request: OperationRequest): OperationResult {
  const message = createDiagnosticRedactor([])(
    `环境操作进程交出的结果种类与请求不符：${request.kind}`,
  );
  const environment = invalidEnvironmentFacts(
    request.workspacePath,
    request.environment,
  );
  if (request.kind === "prepare")
    return {
      kind: "prepare",
      status: "failed",
      environment,
      failure: { stage: "operation", message, exitCode: null },
      cleanup: { state: "unknown", errors: [] },
      logs: { directory: null, files: [] },
      diagnostics: [],
    };
  if (request.kind === "start")
    return {
      kind: "start",
      status: "failed",
      environment,
      run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
      failure: { stage: "operation", message, exitCode: null },
      cleanup: { state: "unknown", errors: [] },
      logs: { directory: null, files: [] },
      diagnostics: [],
    };
  if (request.kind === "rebuild")
    return {
      kind: "rebuild",
      status: "not-confirmed",
      environment,
      run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
      failure: { stage: "operation", message, exitCode: null },
      cleanup: { state: "unknown", errors: [] },
      logs: { directory: null, files: [] },
      diagnostics: [],
    };
  if (request.kind === "delete")
    return {
      kind: "delete",
      status: "not-confirmed",
      environment,
      run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
      failure: { stage: "operation", message, exitCode: null },
      cleanup: { state: "unknown", errors: [] },
      logs: { directory: null, files: [] },
      diagnostics: [],
    };
  return {
    kind: "stop",
    status: "not-confirmed",
    environment,
    run: { ...noRunFacts, lastFailure: { stage: "operation", message } },
    failure: { stage: "operation", message, exitCode: null },
    cleanup: { state: "unknown", errors: [] },
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

function invalidRequest(
  request: OperationRequest,
  reason: string,
): OperationResult {
  const message = createDiagnosticRedactor([])(reason);
  const environment = invalidEnvironmentFacts(
    request.workspacePath,
    request.environment,
  );
  const cleanup = { state: "not-started", errors: [] } as const;
  if (request.kind === "prepare")
    return {
      kind: "prepare",
      status: "invalid-request",
      environment,
      failure: { stage: "request", message, exitCode: null },
      cleanup,
      logs: { directory: null, files: [] },
      diagnostics: [],
    };
  if (request.kind === "start")
    return {
      kind: "start",
      status: "invalid-request",
      environment,
      run: noRunFacts,
      failure: { stage: "request", message, exitCode: null },
      cleanup,
      logs: { directory: null, files: [] },
      diagnostics: [],
    };
  if (request.kind === "rebuild")
    return {
      kind: "rebuild",
      status: "invalid-request",
      environment,
      run: noRunFacts,
      failure: { stage: "request", message, exitCode: null },
      cleanup,
      logs: { directory: null, files: [] },
      diagnostics: [],
    };
  if (request.kind === "delete")
    return {
      kind: "delete",
      status: "invalid-request",
      environment,
      run: noRunFacts,
      failure: { stage: "request", message, exitCode: null },
      cleanup,
      logs: { directory: null, files: [] },
      diagnostics: [],
    };
  return {
    kind: "stop",
    status: "invalid-request",
    environment,
    run: noRunFacts,
    failure: { stage: "request", message, exitCode: null },
    cleanup,
    logs: { directory: null, files: [] },
    diagnostics: [],
  };
}

async function ensureLockArea(layout: EnvironmentLayout): Promise<void> {
  await mkdir(layout.lockDirectory, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(layout.lockPath, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      await chmod(layout.lockPath, 0o600).catch(() => undefined);
      return;
    }
    throw error;
  }
}

function operationEntryPath(): string {
  const current = fileURLToPath(import.meta.url);
  // 源码运行（.ts）与构建产物运行（.js）都交给同目录、同扩展名的操作入口。
  const extension = path.extname(current) === ".ts" ? "ts" : "js";
  return path.join(path.dirname(current), `operation-entry.${extension}`);
}

function parseOperationResult(
  stdout: string,
  kind: OperationRequest["kind"],
): OperationResult | undefined {
  const prefix = `${operationMarker} `;
  for (const line of stdout.split("\n").toReversed()) {
    if (!line.startsWith(prefix)) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(prefix.length));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { kind?: unknown }).kind === kind
      )
        return parsed as OperationResult;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
