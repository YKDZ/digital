import { describe, expect, it, vi } from "vitest";

import { ExecutionHost } from "../src/index.ts";

describe("Execution Host", () => {
  it("在观察根撤销和进程关闭时取消同一宿主的短操作租约", async () => {
    const host = new ExecutionHost();
    const lease = host.lease({
      registrationId: "root-1",
      registrationVersion: 1,
    });
    let cancellations = 0;
    lease.cancellation.onCancel(() => {
      cancellations += 1;
    });

    host.invalidateObservedRoot({ registrationId: "root-1" });

    expect(lease.cancellation.cancelled).toBe(true);
    expect(cancellations).toBe(1);
    lease.release();
    await host.close();
  });
  it("拒绝在配置失效之后才登记的旧观察根版本", async () => {
    const host = new ExecutionHost();
    host.invalidateObservedRoot({ registrationId: "root-1", keepVersion: 2 });

    expect(() =>
      host.lease({ registrationId: "root-1", registrationVersion: 1 }),
    ).toThrow("文件位置授权版本已经失效");
    const current = host.lease({
      registrationId: "root-1",
      registrationVersion: 2,
    });
    expect(current.cancellation.cancelled).toBe(false);
    current.release();
    host.invalidateObservedRoot({ registrationId: "root-1" });
    expect(() =>
      host.lease({ registrationId: "root-1", registrationVersion: 2 }),
    ).toThrow("文件位置授权版本已经失效");
    await host.close();
  });
  it("把同一个顶层短操作在查询后原子绑定到当前观察根代次", async () => {
    const host = new ExecutionHost();
    const stale = host.lease();
    host.invalidateObservedRoot({ registrationId: "root-1", keepVersion: 2 });

    expect(() =>
      stale.bindObservedRoot({
        registrationId: "root-1",
        registrationVersion: 1,
      }),
    ).toThrow("文件位置授权版本已经失效");
    stale.release();

    const current = host.lease();
    current.bindObservedRoot({
      registrationId: "root-1",
      registrationVersion: 2,
    });
    host.invalidateObservedRoot({ registrationId: "root-1" });
    expect(current.cancellation).toMatchObject({
      cancelled: true,
      reason: "observed-root-invalidated",
    });
    current.release();
    await host.close();
  });
  it("只在候选关闭后解绑观察根，并允许同一操作绑定下一候选", async () => {
    const host = new ExecutionHost();
    const operation = host.lease();
    const first = operation.bindObservedRoot({
      registrationId: "root-a",
      registrationVersion: 1,
    });

    first.release();
    host.invalidateObservedRoot({ registrationId: "root-a" });
    const second = operation.bindObservedRoot({
      registrationId: "root-b",
      registrationVersion: 1,
    });

    expect(operation.cancellation.cancelled).toBe(false);
    host.invalidateObservedRoot({ registrationId: "root-b" });
    expect(operation.cancellation).toMatchObject({
      cancelled: true,
      reason: "observed-root-invalidated",
    });
    second.release();
    operation.release();
    await host.close();
  });
  it("同一 operation 在短候选释放前拒绝再次绑定观察根", async () => {
    const host = new ExecutionHost();
    const operation = host.lease();
    const first = operation.bindObservedRoot({
      registrationId: "root-one-binding",
      registrationVersion: 1,
    });

    expect(() =>
      operation.bindObservedRoot({
        registrationId: "root-one-binding",
        registrationVersion: 1,
      }),
    ).toThrow("文件位置授权版本已经失效");

    first.release();
    operation.release();
    await host.close();
  });
  it("不让先发生的根失效因候选解绑而复活操作", async () => {
    const host = new ExecutionHost();
    const operation = host.lease();
    const binding = operation.bindObservedRoot({
      registrationId: "root-a",
      registrationVersion: 1,
    });

    host.invalidateObservedRoot({ registrationId: "root-a" });
    binding.release();

    expect(() =>
      operation.bindObservedRoot({
        registrationId: "root-b",
        registrationVersion: 1,
      }),
    ).toThrow("文件位置授权版本已经失效");
    operation.release();
    await host.close();
  });
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
