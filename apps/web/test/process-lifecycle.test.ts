import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ExecutionHost } from "@digital/application";
import { describe, expect, it, vi } from "vitest";

import {
  createProcessLifecycleRegistry,
  type ProcessLifecycleControl,
} from "#/server/process-lifecycle";

class FakeProcessControl
  extends EventEmitter
  implements ProcessLifecycleControl
{
  readonly resent: NodeJS.Signals[] = [];
  readonly forced: number[] = [];
  readonly shutdownErrors: unknown[] = [];

  addSignalListener(
    signal: NodeJS.Signals,
    listener: () => void | Promise<void>,
  ): void {
    this.on(signal, listener);
  }

  removeSignalListener(
    signal: NodeJS.Signals,
    listener: () => void | Promise<void>,
  ): void {
    this.off(signal, listener);
  }

  resendSignal(signal: NodeJS.Signals): void {
    this.resent.push(signal);
  }

  forceExit(code: number): void {
    this.forced.push(code);
  }

  reportShutdownError(error: unknown): void {
    this.shutdownErrors.push(error);
  }
}

describe("process lifecycle registry", () => {
  it("closes the old HMR owner before publishing the replacement without adding listeners", async () => {
    const processControl = new FakeProcessControl();
    const registry = createProcessLifecycleRegistry(processControl);
    const closed: string[] = [];
    const oldOwner = registry.register({
      async shutdown(reason) {
        closed.push(`old:${reason}`);
      },
    });
    await oldOwner.ready;
    const replacement = registry.register({
      async shutdown(reason) {
        closed.push(`new:${reason}`);
      },
    });
    await replacement.ready;

    expect(closed).toEqual(["old:replacement"]);
    expect(processControl.listenerCount("SIGINT")).toBe(1);
    expect(processControl.listenerCount("SIGTERM")).toBe(1);
    await oldOwner.dispose();
    expect(closed).toEqual(["old:replacement"]);
    await replacement.dispose();
    expect(closed).toEqual(["old:replacement", "new:replacement"]);
  });

  it("waits for the current owner to close before restoring the signal's default exit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "digital-web-signal-"));
    const marker = path.join(directory, "closed");
    const moduleUrl = new URL("../server/process-lifecycle.ts", import.meta.url)
      .href;
    const source = `
      import { writeFile } from "node:fs/promises";
      import { processLifecycle } from ${JSON.stringify(moduleUrl)};
      const keepAlive = setInterval(() => undefined, 1000);
      const registration = processLifecycle.register({
        async shutdown(reason) {
          await writeFile(${JSON.stringify(marker)}, reason);
          clearInterval(keepAlive);
        }
      });
      await registration.ready;
      process.stdout.write("ready\\n");
    `;
    const child = spawn(
      process.execPath,
      ["--conditions=digital-source", "--input-type=module", "--eval", source],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("ready\n")) resolve();
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          reject(
            new Error(
              `child exited before signal: ${String(code)}/${String(signal)}: ${stderr}`,
            ),
          );
        });
      });
      child.kill("SIGTERM");
      const outcome = await new Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect(await readFile(marker, "utf8")).toBe("terminal");
      expect(outcome).toEqual({ code: null, signal: "SIGTERM" });
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a second signal to force exit while graceful shutdown is pending", async () => {
    const processControl = new FakeProcessControl();
    const registry = createProcessLifecycleRegistry(processControl);
    let entered!: () => void;
    let release!: () => void;
    const shutdownEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registration = registry.register({
      async shutdown() {
        entered();
        await barrier;
      },
    });
    await registration.ready;
    const handler = processControl.listeners(
      "SIGTERM",
    )[0] as () => Promise<void>;
    const graceful = handler();
    await shutdownEntered;
    await handler();
    expect(processControl.forced).toEqual([143]);
    release();
    await graceful;
    expect(processControl.resent).toEqual(["SIGTERM"]);
  });

  it("force exits a stuck SQLite owner and lets a new Host recover its non-terminal execution", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "digital-web-grace-"));
    const databasePath = path.join(directory, "catalogue.sqlite");
    const moduleUrl = new URL("../server/process-lifecycle.ts", import.meta.url)
      .href;
    const source = `
      import { DatabaseSync } from "node:sqlite";
      import { processLifecycle } from ${JSON.stringify(moduleUrl)};
      const database = new DatabaseSync(${JSON.stringify(databasePath)});
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("CREATE TABLE executions (id TEXT PRIMARY KEY, status TEXT NOT NULL, cancelled_at TEXT)");
      database.exec("CREATE TABLE effects (id TEXT PRIMARY KEY)");
      database.prepare("INSERT INTO executions VALUES (?, 'running', NULL)").run("execution-1");
      database.prepare("INSERT INTO effects VALUES (?)").run("effect-1");
      const registration = processLifecycle.register({
        async shutdown() { await new Promise(() => undefined); }
      });
      await registration.ready;
      process.stdout.write("ready\\n");
      setInterval(() => undefined, 1000);
    `;
    const child = spawn(
      process.execPath,
      ["--conditions=digital-source", "--input-type=module", "--eval", source],
      {
        env: {
          ...process.env,
          DIGITAL_PROCESS_SHUTDOWN_GRACE_MILLISECONDS: "50",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("ready\n")) resolve();
        });
        child.once("error", reject);
      });
      const startedAt = Date.now();
      child.kill("SIGTERM");
      const outcome = await new Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(outcome).toEqual({ code: 143, signal: null });

      const reopened = new DatabaseSync(databasePath);
      try {
        expect(
          reopened.prepare("SELECT * FROM executions").get(),
        ).toMatchObject({
          id: "execution-1",
          status: "running",
          cancelled_at: null,
        });
        const recoveryHost = new ExecutionHost();
        await recoveryHost.run(() => {
          reopened
            .prepare("UPDATE executions SET status = 'completed' WHERE id = ?")
            .run("execution-1");
        });
        await recoveryHost.close();
        expect(
          reopened.prepare("SELECT COUNT(*) AS count FROM effects").get(),
        ).toEqual({ count: 1 });
      } finally {
        reopened.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("force exits after the bounded terminal grace without releasing the active owner", async () => {
    vi.useFakeTimers();
    try {
      const processControl = new FakeProcessControl();
      const registry = createProcessLifecycleRegistry(processControl, {
        terminalGraceMilliseconds: 25,
      });
      let release!: () => void;
      const active = new Promise<void>((resolve) => {
        release = resolve;
      });
      let released = false;
      const registration = registry.register({
        async shutdown() {
          await active;
          released = true;
        },
      });
      await registration.ready;

      const handler = processControl.listeners(
        "SIGTERM",
      )[0] as () => Promise<void>;
      const shutdown = handler();
      await vi.advanceTimersByTimeAsync(25);

      expect(processControl.forced).toEqual([143]);
      expect(released).toBe(false);
      release();
      await shutdown;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an HMR replacement and retains the old owner when its shutdown fails", async () => {
    const processControl = new FakeProcessControl();
    const registry = createProcessLifecycleRegistry(processControl);
    const failure = new Error("old owner close failed");
    let oldCloseAttempts = 0;
    const oldOwner = registry.register({
      async shutdown() {
        oldCloseAttempts += 1;
        if (oldCloseAttempts === 1) throw failure;
      },
    });
    await oldOwner.ready;
    let replacementClosed = false;
    const replacement = registry.register({
      async shutdown() {
        replacementClosed = true;
      },
    });

    await expect(replacement.ready).rejects.toBe(failure);
    await expect(replacement.dispose()).resolves.toBeUndefined();
    expect(replacementClosed).toBe(false);

    await expect(oldOwner.dispose()).resolves.toBeUndefined();
    expect(oldCloseAttempts).toBe(2);
    const retry = registry.register({
      async shutdown() {
        replacementClosed = true;
      },
    });
    await expect(retry.ready).resolves.toBeUndefined();
    await expect(retry.dispose()).resolves.toBeUndefined();
    expect(replacementClosed).toBe(true);
    expect(processControl.shutdownErrors).toEqual([]);
  });

  it("reports a terminal owner failure and still restores signal exit", async () => {
    const processControl = new FakeProcessControl();
    const registry = createProcessLifecycleRegistry(processControl);
    const failure = new Error("terminal owner close failed");
    const owner = registry.register({
      async shutdown() {
        throw failure;
      },
    });
    await owner.ready;

    const handler = processControl.listeners(
      "SIGTERM",
    )[0] as () => Promise<void>;
    await handler();

    expect(processControl.shutdownErrors).toEqual([failure]);
    expect(processControl.resent).toEqual(["SIGTERM"]);
  });
});
