import { appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

/** 公开生命周期入口：只消费 `digital-environment` 已构建的 CLI 交付物。 */
export const environmentCliRelativePath = path.join(
  "packages",
  "environment",
  "dist",
  "cli.js",
);

export const ownedPortRange = { first: 51_001, last: 51_999 } as const;

export type StructuredEnvelope = {
  readonly schemaVersion: string;
  readonly command: string;
  readonly kind: string;
  readonly variant?: string;
  readonly data?: Record<string, unknown>;
  readonly issues?: unknown;
};

export type SpawnRecord = {
  readonly phase: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cancelled: boolean;
  readonly envelope?: StructuredEnvelope;
  readonly stdoutTail: string;
  readonly stderrTail: string;
};

export type CommandJournal = {
  record(entry: SpawnRecord): Promise<void>;
};

export function fileCommandJournal(filePath: string): CommandJournal {
  return {
    async record(entry) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    },
  };
}

/**
 * 运行一次公开 CLI 调用：终止信号转发给子进程，由它自己完成有界收尾；
 * 父进程只等待退出，绝不代替管理器回收产品世代。
 */
export async function runCommand(input: {
  readonly phase: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly journal?: CommandJournal;
}): Promise<SpawnRecord> {
  const { spawn } = await import("node:child_process");
  const startedAt = new Date().toISOString();
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let cancelled = false;
  const forward = (): void => {
    cancelled = true;
    child.kill("SIGTERM");
  };
  if (input.signal !== undefined) {
    if (input.signal.aborted) forward();
    else input.signal.addEventListener("abort", forward, { once: true });
  }
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (input.signal !== undefined)
    input.signal.removeEventListener("abort", forward);
  const envelope = parseEnvelope(stdout);
  const record: SpawnRecord = {
    phase: input.phase,
    cwd: input.cwd,
    argv: [input.command, ...input.args],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: exit.code,
    signal: exit.signal,
    cancelled,
    ...(envelope === undefined ? {} : { envelope }),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
  await input.journal?.record(record);
  return record;
}

function parseEnvelope(stdout: string): StructuredEnvelope | undefined {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  for (const line of lines.toReversed()) {
    try {
      return JSON.parse(line) as StructuredEnvelope;
    } catch {
      // 结构输出之外的行不参与解析。
    }
  }
  return undefined;
}

function tail(text: string): string {
  return text.slice(-4_000);
}

export type LifecycleResult = {
  readonly status: string;
  readonly record: Record<string, unknown>;
  readonly exitCode: number | null;
  readonly cancelled: boolean;
};

/** 把一次生命周期调用折算成公开结果对象；用法与帮助错误直接抛出，不静默降级。 */
export function lifecycleResult(record: SpawnRecord): LifecycleResult {
  const envelope = record.envelope;
  if (envelope === undefined)
    throw new Error(
      `${record.phase} 没有返回结构化结果（退出码 ${String(record.exitCode)}）：${record.stdoutTail}`,
    );
  const data = envelope.data;
  if (data === undefined || data === null || typeof data !== "object")
    throw new Error(
      `${record.phase} 返回 ${envelope.kind}/${String(envelope.variant ?? "")}（退出码 ${String(record.exitCode)}）：${JSON.stringify(envelope.issues ?? {})}`,
    );
  const status = data.status;
  if (typeof status !== "string")
    throw new Error(
      `${record.phase} 的结构化结果缺少 status：${JSON.stringify(data)}`,
    );
  return {
    status,
    record: data,
    exitCode: record.exitCode,
    cancelled: record.cancelled,
  };
}

/** 公开结果里的事实可能是字符串，也可能是 `{status}` 形式的对象；按键顺序读取文本。 */
export function statusFact(
  record: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  for (const key of keys) {
    const value = record[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>).status;
      if (typeof nested === "string" && nested.length > 0) return nested;
    }
  }
  return "";
}

export function nestedRun(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const run = record.run;
  return run !== null && typeof run === "object" && !Array.isArray(run)
    ? (run as Record<string, unknown>)
    : {};
}

/** 只在自有端口段内真实 bind 后立即释放，把空闲结论交给环境管理器。 */
export async function claimFreePort(
  range: { readonly first: number; readonly last: number } = ownedPortRange,
): Promise<number> {
  for (let port = range.first; port <= range.last; port += 1) {
    const available = await probePort(port);
    if (available) return port;
  }
  throw new Error(`自有端口段 ${range.first}—${range.last} 内没有可用端口`);
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const settle = (value: boolean): void => {
      server.close(() => {
        resolve(value);
      });
    };
    server.once("error", () => resolve(false));
    server.once("listening", () => settle(true));
    server.listen(port, "127.0.0.1");
  });
}

export async function appendLedger(
  ledgerPath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(
    ledgerPath,
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    "utf8",
  );
}
