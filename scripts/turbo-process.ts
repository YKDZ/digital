import { spawn } from "node:child_process";
import { resolve } from "node:path";

export function runVisible(
  cwd: string,
  args: readonly string[],
): Promise<number> {
  return new Promise((resolveStatus) => {
    const command =
      process.platform === "win32"
        ? "pnpm"
        : resolve(cwd, "node_modules/.bin/turbo");
    const commandArgs =
      process.platform === "win32" ? ["exec", "turbo", ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    let interruptedBy: NodeJS.Signals | undefined;
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) {
        interruptedBy = signal;
        const turboSignal = signal === "SIGTERM" ? "SIGINT" : signal;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, turboSignal);
          } catch {
            child.kill(turboSignal);
          }
        } else {
          child.kill(turboSignal);
        }
      }
    };
    const forwardInterrupt = (): void => forward("SIGINT");
    const forwardTerminate = (): void => forward("SIGTERM");
    const removeSignalHandlers = (): void => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    };

    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);
    child.once("error", (error) => {
      removeSignalHandlers();
      process.stderr.write(
        `无法启动 Turbo 执行 ${args.join(" ")}：${error.message}\n`,
      );
      resolveStatus(1);
    });
    child.once("close", (code, signal) => {
      removeSignalHandlers();
      if (interruptedBy !== undefined) {
        resolveStatus(interruptedBy === "SIGINT" ? 130 : 143);
      } else if (code !== null) {
        resolveStatus(code);
      } else {
        resolveStatus(
          signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1,
        );
      }
    });
  });
}
