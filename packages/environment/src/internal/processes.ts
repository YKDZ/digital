import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { createDiagnosticRedactor } from "./redact.ts";

/**
 * 子进程白名单环境：只传递系统工具运行所需变量；父终端的 DIGITAL_*、PORT、
 * NODE_OPTIONS 等可改变目标或注入代码的残留值一律清除。
 * COREPACK_HOME、PNPM_HOME 是定位本机已安装的包管理器所必需，缺失会让
 * Corepack 回退到在线下载而不是复用冻结的 pnpm。
 */
const passthroughVariables = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "COREPACK_HOME",
  "PNPM_HOME",
] as const;

export function filteredEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of passthroughVariables) {
    const value = source[name];
    if (value !== undefined && value.length > 0) environment[name] = value;
  }
  return { ...environment, ...overrides };
}

export type CommandRun = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: string | undefined;
  readonly stdout: string | undefined;
  readonly stdoutOverflowed: boolean;
  /**
   * 子进程自己交出的 stderr，与管理日志条目分开：调用方据此判断结论来自被运行命令的
   * 输出，而不是本管理器写下的命令、cwd 等运行元数据。捕获到上限后只停止继续追加，
   * 仍然交出已捕获的开头部分，因此依赖它的判断必须锚定在自己看得到的那段文字上，
   * 不能把「后面还有没看到的内容」当成任何结论。
   */
  readonly stderr: string | undefined;
  /**
   * 阶段日志未能完整持久化时的结果：`cause` 是首个持久化问题（例如写入被文件系统
   * 拒绝），`problems` 是其后的丢弃统计与句柄关闭错误。两者都不掩盖命令自身的退出状态。
   */
  readonly logFailure:
    | {
        readonly cause: string;
        readonly problems: readonly string[];
        /** 本次运行是因日志无法持久化而被主动收尾，而非命令自行退出。 */
        readonly endedByLogFailure: boolean;
      }
    | undefined;
  /**
   * 本次调用没有把命令交给系统的原因（取消在阶段取得资源期间成立）。缺少这一事实
   * 就把空持有集合当成「自有子进程已收尾」，会把尚未发生的启动说成已经结束。
   */
  readonly neverStarted?: string;
};

const capturedOutputLimit = 2 * 1024 * 1024;

/** 一次命令运行的收尾方式：自然退出，或因日志无法持久化而主动收尾自有子进程。 */
type RunEnd =
  | {
      readonly kind: "closed";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: "write-rejected" };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

/** 一个自有命令的收尾结果：是否确认退出，以及发信号本身的真实失败。 */
type ChildClose = { readonly closed: boolean; readonly problem?: string };

/**
 * 待决的启动：阶段命令在把进程交给系统之前先在这里挂号。收尾必须等它做出决定，
 * 不能把「此刻还没有活着的子进程」当成在途启动已经结束。
 */
type StartReservation = {
  /** 阶段做出决定：交出真实子进程，或承认没有把它交给系统。 */
  decide(child: ChildProcess | undefined): void;
  readonly settled: Promise<ChildProcess | undefined>;
};

/** 待决启动做出决定的有界等待；到期只如实保持 unknown，不假装收尾完成。 */
const startDecisionAllowanceMilliseconds = 5_000;

/** 记录本次操作持有且尚未退出的子进程，用于普通失败的可靠收尾。 */
export class HeldCommands {
  private readonly held = new Map<ChildProcess, boolean>();
  /** 同一子进程的收尾只发一次信号；后续调用共用同一次观察结果。 */
  private readonly closing = new Map<ChildProcess, Promise<ChildClose>>();
  private readonly pendingStarts = new Map<number, StartReservation>();
  private startSequence = 0;

  reserveStart(): StartReservation {
    const id = ++this.startSequence;
    let decide!: (child: ChildProcess | undefined) => void;
    const settled = new Promise<ChildProcess | undefined>((resolve) => {
      decide = resolve;
    });
    const reservation: StartReservation = {
      settled,
      decide: (child: ChildProcess | undefined): void => {
        this.pendingStarts.delete(id);
        decide(child);
      },
    };
    this.pendingStarts.set(id, reservation);
    return reservation;
  }

  register(child: ChildProcess): void {
    this.held.set(child, false);
    child.once("exit", () => this.held.set(child, true));
  }

  /** 关闭仍活着的自有命令并等待退出；无法确认时如实返回 unknown。 */
  async close(graceMilliseconds = 10_000): Promise<{
    state: "stopped" | "unknown";
    errors: readonly string[];
  }> {
    const errors: string[] = [];
    let state: "stopped" | "unknown" = "stopped";
    const pending = [...this.pendingStarts.values()];
    if (pending.length > 0) {
      const awaiting = Promise.all(pending.map((item) => item.settled));
      const settled = await Promise.race([
        awaiting.then(() => true),
        delay(startDecisionAllowanceMilliseconds).then(() => false),
      ]);
      if (!settled) {
        state = "unknown";
        errors.push(
          `${String(pending.length)} 个阶段启动在 ${String(
            startDecisionAllowanceMilliseconds,
          )} 毫秒内没有决定是否把命令交给系统，收尾状态如实保持未知`,
        );
      }
    }
    for (const [child, exited] of this.held) {
      if (exited) continue;
      const outcome = await this.closeOne(child, graceMilliseconds);
      if (outcome.closed) this.held.set(child, true);
      else state = "unknown";
      if (outcome.problem !== undefined && !errors.includes(outcome.problem))
        errors.push(outcome.problem);
    }
    return { state, errors };
  }

  private closeOne(
    child: ChildProcess,
    graceMilliseconds: number,
  ): Promise<ChildClose> {
    const ongoing = this.closing.get(child);
    if (ongoing !== undefined) return ongoing;
    const pid = child.pid;
    if (pid === undefined) {
      this.held.set(child, true);
      return Promise.resolve({ closed: true });
    }
    const pending = new Promise<ChildClose>((resolve) => {
      const timer = setTimeout(
        () => resolve({ closed: false }),
        graceMilliseconds,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolve({ closed: true });
      });
      try {
        child.kill("SIGTERM");
      } catch (error) {
        clearTimeout(timer);
        resolve({
          closed: false,
          problem: `关闭自有子进程 ${String(pid)} 失败：${
            error instanceof Error ? error.message : "未知错误"
          }`,
        });
      }
    });
    this.closing.set(child, pending);
    return pending;
  }
}

/**
 * 运行一条命令：stdout/stderr 经按行增量脱敏后完整写入阶段日志，不截断；
 * 显式 stdio 列表启动，产物子进程不继承操作进程的锁描述符。
 *
 * 每个写入 Promise 在创建时就挂上拒绝处理器，因此磁盘配额、文件大小上限等普通
 * 写入错误只成为本操作内的受控失败，不会在等待子进程退出期间变成未处理拒绝而令
 * 整个持锁进程异常终止。一旦持久化被拒绝，后续行不再尝试写入（不要求保存已被
 * 文件系统拒绝的字节），并立即经 HeldCommands 真实收尾自有子进程后再交出结果。
 */
export async function runLoggedCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly logFile: string;
  readonly captureStdout?: boolean;
  readonly captureStderr?: boolean;
  readonly secretValues: readonly string[];
  readonly held: HeldCommands;
  /** 交出原因就不把命令交给系统：取消在日志资源取得期间成立时，迟到的启动不允许越过它。 */
  readonly abortBeforeSpawn?: () => string | undefined;
}): Promise<CommandRun> {
  const reservation = input.held.reserveStart();
  let handle: FileHandle;
  try {
    await mkdir(path.dirname(input.logFile), { recursive: true, mode: 0o700 });
    handle = await open(input.logFile, "a", 0o600);
  } catch (error) {
    // 日志资源没能取得：本次决定就是「没有把命令交给系统」，待决挂号必须随之收敛。
    reservation.decide(undefined);
    throw error;
  }
  const stdoutLines = createDiagnosticRedactor(input.secretValues);
  const stderrLines = createDiagnosticRedactor(input.secretValues);
  const writes: Promise<unknown>[] = [];
  const problems: string[] = [];
  let cause: string | undefined;
  let droppedLines = 0;
  let droppedBytes = 0;
  let rejectedWriteObserved: () => void = () => {};
  const writeRejected = new Promise<void>((resolve) => {
    rejectedWriteObserved = resolve;
  });
  /** 首个持久化问题作为首因，其余按发生顺序并列且不重复，不覆盖首因。 */
  const noteProblem = (message: string): void => {
    if (cause === undefined) cause = message;
    else if (!problems.includes(message)) problems.push(message);
  };
  const logRaw = (line: string): void => {
    const text = line.endsWith("\n") ? line : `${line}\n`;
    if (cause !== undefined) {
      droppedLines += 1;
      droppedBytes += Buffer.byteLength(text);
      return;
    }
    writes.push(
      handle.write(text).then(
        () => undefined,
        (error: unknown) => {
          noteProblem(`阶段日志写入被拒绝：${describeError(error)}`);
          rejectedWriteObserved();
        },
      ),
    );
  };
  const log = (label: string, text: string): void =>
    logRaw(`${new Date().toISOString()} ${label}${text}`);

  const refusal = input.abortBeforeSpawn?.();
  if (refusal !== undefined) {
    // 取消在取得日志资源期间成立：本阶段绝不迟到启动，待决挂号在此收敛，
    // 阶段日志留下一条明确事实，说明这一阶段没有把命令交给系统。
    reservation.decide(undefined);
    log("skip ", refusal);
    await Promise.all(writes);
    await handle.close().catch((error: unknown) => {
      noteProblem(`阶段日志句柄关闭失败：${describeError(error)}`);
    });
    return {
      exitCode: null,
      signal: null,
      spawnError: undefined,
      stdout: undefined,
      stdoutOverflowed: false,
      stderr: undefined,
      logFailure:
        cause === undefined
          ? undefined
          : { cause, problems: [...problems], endedByLogFailure: false },
      neverStarted: refusal,
    };
  }

  log("run ", `${input.command} ${input.args.join(" ")} (cwd: ${input.cwd})`);

  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  input.held.register(child);
  reservation.decide(child);

  let stdout = "";
  let stdoutOverflowed = false;
  let stderr = "";
  let stderrOverflowed = false;
  let spawnError: string | undefined;
  child.on("error", (error) => {
    spawnError = error.message;
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  const readStdout = (chunk: string): void => {
    if (input.captureStdout === true && !stdoutOverflowed) {
      if (stdout.length + chunk.length > capturedOutputLimit)
        stdoutOverflowed = true;
      else stdout += chunk;
    }
    const redacted = stdoutLines.write(chunk);
    if (redacted.length > 0) log("out ", redacted);
  };
  const readStderr = (chunk: string): void => {
    if (input.captureStderr === true && !stderrOverflowed) {
      if (stderr.length + chunk.length > capturedOutputLimit)
        stderrOverflowed = true;
      else stderr += chunk;
    }
    const redacted = stderrLines.write(chunk);
    if (redacted.length > 0) log("err ", redacted);
  };
  child.stdout?.on("data", readStdout);
  child.stderr?.on("data", readStderr);

  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const end = await Promise.race([
    closed.then((value): RunEnd => ({ kind: "closed", ...value })),
    writeRejected.then((): RunEnd => ({ kind: "write-rejected" })),
  ]);
  let exitCode: number | null;
  let exitSignal: NodeJS.Signals | null;
  let endedByLogFailure = false;
  if (end.kind === "closed") {
    exitCode = end.code;
    exitSignal = end.signal;
  } else {
    // 持久化已被拒绝：继续运行只会留下无法核验诊断的产物进程，先真实收尾自有子进程
    // 再交出结果；无法确认退出时如实保持未知。
    endedByLogFailure = true;
    const cleanup = await input.held.close();
    if (cleanup.state === "stopped") {
      const exit = await closed;
      exitCode = exit.code;
      exitSignal = exit.signal;
    } else {
      exitCode = null;
      exitSignal = null;
    }
  }
  const pending = `${stdoutLines.end()}${stderrLines.end()}`;
  if (pending.length > 0) log("out ", pending);
  log(
    "exit ",
    `code=${String(exitCode)} signal=${String(exitSignal)}${
      spawnError === undefined ? "" : ` spawnError=${spawnError}`
    }`,
  );
  await Promise.all(writes);
  if (droppedLines > 0)
    noteProblem(
      `日志未完整保存：写入被拒绝后另有 ${String(droppedLines)} 行（${String(droppedBytes)} 字节）未再持久化`,
    );
  try {
    await handle.close();
  } catch (error) {
    noteProblem(`阶段日志句柄关闭失败：${describeError(error)}`);
  }
  child.stdout?.removeListener("data", readStdout);
  child.stderr?.removeListener("data", readStderr);
  return {
    exitCode,
    signal: exitSignal,
    spawnError,
    stdout: input.captureStdout === true ? stdout : undefined,
    stdoutOverflowed,
    stderr: input.captureStderr === true ? stderr : undefined,
    logFailure:
      cause === undefined
        ? undefined
        : { cause, problems: [...problems], endedByLogFailure },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
