import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOperationCancellation } from "../src/internal/cancellation.ts";
import { IpcInbox, type IpcExit } from "../src/internal/start-operation.ts";

const cancellations: ReturnType<typeof createOperationCancellation>[] = [];

function cancellation(deadlineAt?: number) {
  const value = createOperationCancellation({ deadlineAt });
  cancellations.push(value);
  return value;
}

afterEach(() => {
  for (const value of cancellations.splice(0)) value.dispose();
  vi.useRealTimers();
});

describe("启动引导 IPC 等待", () => {
  it("收到进程身份后释放超时与退出等待", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    const inbox = new IpcInbox(child as unknown as ChildProcess);
    const exit: IpcExit = { terminated: () => false };
    const operation = cancellation();
    const listenersBeforeTake = {
      message: child.listenerCount("message"),
      exit: child.listenerCount("exit"),
      close: child.listenerCount("close"),
    };

    const pending = inbox.take("identity", 30_000, exit, operation);
    child.emit("message", { type: "identity", identity: { pid: 42 } });

    await expect(pending).resolves.toEqual({
      type: "identity",
      identity: { pid: 42 },
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("message")).toBe(
      listenersBeforeTake.message - 1,
    );
    expect(child.listenerCount("exit")).toBe(listenersBeforeTake.exit - 1);
    expect(child.listenerCount("close")).toBe(listenersBeforeTake.close - 1);
  });

  it("真实等待超时后返回失败并移除 IPC 监听", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    const inbox = new IpcInbox(child as unknown as ChildProcess);
    const exit: IpcExit = { terminated: () => false };
    const operation = cancellation();
    const pending = inbox.take("identity", 250, exit, operation);

    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("message")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("子进程退出后立即失败并取消身份期限", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    let terminated = false;
    child.once("exit", () => {
      terminated = true;
    });
    const inbox = new IpcInbox(child as unknown as ChildProcess);
    const exit: IpcExit = { terminated: () => terminated };
    const operation = cancellation();
    const pending = inbox.take("identity", 30_000, exit, operation);

    child.emit("exit", 1, null);

    await expect(pending).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("message")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("取消握手等待时交出取消结果并清除其余收尾", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    const inbox = new IpcInbox(child as unknown as ChildProcess);
    const exit: IpcExit = { terminated: () => false };
    const operation = cancellation(Date.now() + 250);
    const pending = operation.watch(
      inbox.take("identity", 30_000, exit, operation),
    );

    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("message")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });
});
