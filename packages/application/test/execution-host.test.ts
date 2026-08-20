import { describe, expect, it, vi } from "vitest";

import { ExecutionHost } from "../src/index.ts";

describe("Execution Host", () => {
  it("rejects closed admission without starting the workflow invocation", async () => {
    const host = new ExecutionHost();
    await host.close();
    const invoke = vi.fn(async () => undefined);

    await expect(host.invoke(invoke)).rejects.toThrow("执行服务正在关闭");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the durable identity without waiting for workflow completion", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const host = new ExecutionHost();

    await expect(
      host.invoke(async (control) => {
        control.executionStarted("execution-1");
        await work;
      }),
    ).resolves.toEqual({ id: "execution-1" });

    const closing = host.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await expect(closing).resolves.toBeUndefined();
  });

  it("owns the invocation before its factory can begin shutdown", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const host = new ExecutionHost();
    let closing!: Promise<void>;

    await expect(
      host.invoke((control) => {
        control.executionStarted("execution-owned-first");
        closing = host.close();
        return work;
      }),
    ).resolves.toEqual({ id: "execution-owned-first" });
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await expect(closing).resolves.toBeUndefined();
  });

  it("accepts a repeated durable identity but synchronously rejects a different one", async () => {
    const host = new ExecutionHost();
    let conflict: unknown;

    await expect(
      host.invoke((control) => {
        control.executionStarted("execution-stable");
        control.executionStarted("execution-stable");
        try {
          control.executionStarted("execution-conflict");
        } catch (error) {
          conflict = error;
        }
      }),
    ).resolves.toEqual({ id: "execution-stable" });

    expect(conflict).toMatchObject({
      message: "同一执行调用不能声明不同的刷新记录",
    });
    await expect(host.close()).resolves.toBeUndefined();
  });

  it("surfaces a workflow failure that happens before durable creation", async () => {
    const host = new ExecutionHost();
    const failure = new Error("无法建立刷新记录");

    await expect(
      host.invoke(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(host.close()).resolves.toBeUndefined();
  });

  it("keeps an accepted identity valid when supervised work later fails", async () => {
    let fail!: (error: unknown) => void;
    const work = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const host = new ExecutionHost();

    await expect(
      host.invoke(async (control) => {
        control.executionStarted("execution-failed-later");
        await work;
      }),
    ).resolves.toEqual({ id: "execution-failed-later" });
    const closing = host.close();
    fail(new Error("已由工作流持久化的失败"));
    await expect(closing).resolves.toBeUndefined();
  });

  it("asks active work to stop at its next safe durable checkpoint", async () => {
    let reachCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      reachCheckpoint = resolve;
    });
    let continuedAfterCheckpoint = false;
    let passedOpenCheckpoint = false;
    const host = new ExecutionHost();
    await host.invoke(async (control) => {
      control.executionStarted("execution-2");
      control.safeCheckpoint();
      passedOpenCheckpoint = true;
      await checkpoint;
      control.safeCheckpoint();
      continuedAfterCheckpoint = true;
    });

    expect(passedOpenCheckpoint).toBe(true);
    const closing = host.close();
    reachCheckpoint();
    await expect(closing).resolves.toBeUndefined();
    expect(continuedAfterCheckpoint).toBe(false);
  });

  it("reports an expired grace period without releasing active work", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const work = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const expired = vi.fn();
      const host = new ExecutionHost({
        graceMilliseconds: 25,
        onGraceExpired: expired,
      });
      await host.invoke(async (control) => {
        control.executionStarted("execution-3");
        await work;
      });

      const closing = host.close();
      let released = false;
      void closing.then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(expired).toHaveBeenCalledOnce();
      expect(released).toBe(false);

      finish();
      await expect(closing).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("supervises interactive and automatic invocations in one active set", async () => {
    let finishInteractive!: () => void;
    let finishAutomatic!: () => void;
    const interactive = new Promise<void>((resolve) => {
      finishInteractive = resolve;
    });
    const automatic = new Promise<void>((resolve) => {
      finishAutomatic = resolve;
    });
    const host = new ExecutionHost();
    await host.invoke(async (control) => {
      control.executionStarted("interactive-execution");
      await interactive;
    });
    void host.run(async () => await automatic);

    const closing = host.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    finishInteractive();
    await Promise.resolve();
    expect(closed).toBe(false);
    finishAutomatic();
    await expect(closing).resolves.toBeUndefined();
  });
});
