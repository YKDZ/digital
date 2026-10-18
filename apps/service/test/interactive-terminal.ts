import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export function interactiveTerminalEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete environment.CI;
  delete environment.CONTINUOUS_INTEGRATION;
  return environment;
}

export type InteractiveTerminalMarkers = string | readonly string[];

export interface InteractiveTerminalSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: string;
  readonly errors: string;
  waitForOutput(markers: InteractiveTerminalMarkers): Promise<void>;
  sendAndWait(
    input: string,
    markers: InteractiveTerminalMarkers,
  ): Promise<void>;
  closeAndWait(): Promise<number | null>;
}

export function startInteractiveTerminal(
  terminalCommand: string,
  options: {
    readonly cwd: string;
    readonly columns: number;
    readonly rows: number;
    readonly timeoutMs: number;
  },
): InteractiveTerminalSession {
  const child = spawn("script", ["-qfec", terminalCommand, "/dev/null"], {
    cwd: options.cwd,
    env: interactiveTerminalEnvironment({
      TERM: "xterm-256color",
      COLUMNS: String(options.columns),
      LINES: String(options.rows),
    }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const outputChunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  let closed = false;
  let exitCode: number | null = null;
  let spawnError: Error | undefined;

  child.stdout.on("data", (chunk: Buffer) => outputChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", (code) => {
    closed = true;
    exitCode = code;
  });

  const output = (): string => Buffer.concat(outputChunks).toString("utf8");
  const errors = (): string => Buffer.concat(errorChunks).toString("utf8");

  const waitForOutputSince = (
    offset: number,
    expected: InteractiveTerminalMarkers,
  ): Promise<void> => {
    const markers = typeof expected === "string" ? [expected] : expected;
    const hasMarkers = (): boolean => {
      const newOutput = output().slice(offset);
      return markers.every((marker) => newOutput.includes(marker));
    };

    if (hasMarkers()) return Promise.resolve();
    if (spawnError !== undefined) return Promise.reject(spawnError);
    if (closed)
      return Promise.reject(
        new Error(
          `交互终端在输出 ${markers.join("、")} 前退出（exit=${String(exitCode)}）\n${errors()}\n${output()}`,
        ),
      );

    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        child.stdout.off("data", checkOutput);
        child.off("close", checkClosed);
        child.off("error", checkError);
        if (error === undefined) resolve();
        else reject(error);
      };
      const checkOutput = (): void => {
        if (hasMarkers()) finish();
      };
      const checkClosed = (code: number | null): void => {
        finish(
          new Error(
            `交互终端在输出 ${markers.join("、")} 前退出（exit=${String(code)}）\n${errors()}\n${output()}`,
          ),
        );
      };
      const checkError = (error: Error): void => finish(error);
      const timeout = setTimeout(() => {
        finish(
          new Error(
            `等待交互终端输出 ${markers.join("、")} 超时（${options.timeoutMs}ms）\n${errors()}\n${output()}`,
          ),
        );
      }, options.timeoutMs);
      child.stdout.on("data", checkOutput);
      child.once("close", checkClosed);
      child.once("error", checkError);
      checkOutput();
    });
  };

  return {
    child,
    get output() {
      return output();
    },
    get errors() {
      return errors();
    },
    waitForOutput(markers) {
      return waitForOutputSince(0, markers);
    },
    sendAndWait(input, markers) {
      const wait = waitForOutputSince(output().length, markers);
      child.stdin.write(input);
      return wait;
    },
    closeAndWait() {
      if (!child.stdin.destroyed) child.stdin.end();
      if (closed) return Promise.resolve(exitCode);
      return new Promise<number | null>((resolve, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(timeout);
          child.off("close", checkClosed);
          child.off("error", checkError);
          if (error === undefined) resolve(exitCode);
          else reject(error);
        };
        const checkClosed = (code: number | null): void => {
          exitCode = code;
          closed = true;
          finish();
        };
        const checkError = (error: Error): void => finish(error);
        const timeout = setTimeout(() => {
          finish(
            new Error(
              `等待交互终端退出超时（${options.timeoutMs}ms）\n${errors()}\n${output()}`,
            ),
          );
        }, options.timeoutMs);
        child.once("close", checkClosed);
        child.once("error", checkError);
      });
    },
  };
}
