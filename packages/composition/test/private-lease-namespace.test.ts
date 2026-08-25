import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ProductPrivateLease,
  type ProductPrivateLeaseRecord,
} from "@digital/product-data";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Product-private immutable lease namespaces", () => {
  it("never lets delayed stale cleanup retire a later generation", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "refresh.lease.json");
    let wallNow = new Date("2026-08-12T00:00:00.000Z");
    let monotonicNow = 1_000;
    const old = testLease("old", "2026-08-12T00:00:01.000Z");
    const middle = testLease("middle", "2026-08-12T00:01:00.000Z");
    const later = testLease("later", "2026-08-12T00:02:00.000Z");
    const ordinary = privateLease({
      directory,
      leasePath,
      now: () => wallNow,
      monotonic: () => monotonicNow,
    });
    const winningCleanup = privateLease({
      directory,
      leasePath,
      now: () => wallNow,
      monotonic: () => monotonicNow,
    });
    let interleaved = false;
    const delayedCleanup = privateLease({
      directory,
      leasePath,
      now: () => wallNow,
      monotonic: () => monotonicNow,
      beforeRetire: () => {
        if (interleaved) return;
        interleaved = true;
        expect(winningCleanup.reclaimStale()).toBe(true);
        expect(winningCleanup.tryAcquire(middle)).toBe(true);
        expect(winningCleanup.retireExact(middle)).toBe(true);
        expect(winningCleanup.tryAcquire(later)).toBe(true);
      },
    });

    expect(ordinary.tryAcquire(old)).toBe(true);
    monotonicNow = 2_000;

    // 两条清理路径都观察到了 L。第一条路径退役 L、认领并退役 N，再认领 M；
    // 此时延迟路径恰好暂停在记录 L 退役之前。延迟路径最终完成时，
    // 已没有可供它触碰的后续世代可变路径名。
    delayedCleanup.reclaimStale();

    expect(
      delayedCleanup.tryAcquire(testLease("third", "2026-08-12T00:02:00.000Z")),
    ).toBe(false);
    expect(ordinary.currentRecord()).toMatchObject({ leaseNonce: "later" });
  });

  it("keeps Q's later M after P loses publication and crashes, without a withdrawal path", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "callback.lease.json");
    const now = () => new Date("2026-08-12T00:00:00.000Z");
    const monotonic = () => 1_000;
    const publishedByQ = testLease("q", "2026-08-12T00:01:00.000Z");
    const publishedByP = testLease("p", "2026-08-12T00:01:00.000Z");
    const finalM = testLease("m", "2026-08-12T00:02:00.000Z");
    const q = privateLease({ directory, leasePath, now, monotonic });
    let interleaved = false;
    const p = privateLease({
      directory,
      leasePath,
      now,
      monotonic,
      beforePublish: () => {
        if (interleaved) return;
        interleaved = true;
        expect(q.tryAcquire(publishedByQ)).toBe(true);
      },
    });

    expect(p.tryAcquire(publishedByP)).toBe(false);
    expect(q.currentRecord()).toMatchObject({ leaseNonce: "q" });
    // P 此时消失。旧设计中，这是危险的撤回后崩溃窗口。不可变失败发布不会给 P 留下
    // 可恢复或破坏后续工作的可变补偿路径。
    expect(q.retireExact(publishedByQ)).toBe(true);
    expect(q.tryAcquire(finalM)).toBe(true);
    expect(q.currentRecord()).toMatchObject({ leaseNonce: "m" });

    const names = await namespaceNames(leasePath);
    expect(names.some((name) => name.includes("reclaim"))).toBe(false);
    expect(names.some((name) => name.includes("retired"))).toBe(false);
  });

  it("keeps an executing holder across a wall-clock jump and bounds recovery with the Linux monotonic clock", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "mutation.lease.json");
    let wallNow = new Date("2026-08-12T00:00:00.000Z");
    let monotonicNow = 1_000;
    let ownerAlive = true;
    const holderLease = privateLease({
      directory,
      leasePath,
      now: () => wallNow,
      monotonic: () => monotonicNow,
      ownerAlive: () => ownerAlive,
    });
    const reclaimer = privateLease({
      directory,
      leasePath,
      now: () => wallNow,
      monotonic: () => monotonicNow,
      ownerAlive: () => ownerAlive,
    });
    const held = holderLease.acquire(
      testLease("active", "2026-08-12T00:00:02.000Z"),
    );
    expect(held).toBeDefined();

    // 墙钟可以向任一方向跳变，但不会因此把进行中持有者的权威授予另一进程。
    wallNow = new Date("2027-08-12T00:00:00.000Z");
    expect(reclaimer.reclaimStale()).toBe(false);
    expect(
      reclaimer.tryAcquire(testLease("other", "2027-08-12T00:01:00.000Z")),
    ).toBe(false);
    expect(held!.isCurrent()).toBe(true);

    wallNow = new Date("2025-08-12T00:00:00.000Z");
    monotonicNow = 4_000;
    ownerAlive = false;
    expect(reclaimer.reclaimStale()).toBe(true);
    expect(held!.isCurrent()).toBe(false);
    expect(
      reclaimer.tryAcquire(testLease("recovered", "2026-08-12T00:01:00.000Z")),
    ).toBe(true);
  });

  it("keeps a same-boot exact live owner authoritative after its monotonic deadline", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "active-owner.lease.json");
    let monotonicNow = 1_000;
    // 仍拥有精确 `/proc` 身份的进程继续作为其世代权威。不能仅因为持有者等待时间超过
    // 原始估计，就让单调 TTL 允许另一进程与其变更重叠。
    const holder = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => monotonicNow,
    });
    const reclaimer = privateLease({
      directory,
      leasePath,
      now: () => new Date("2025-08-12T00:00:00.000Z"),
      monotonic: () => monotonicNow,
    });
    const active = holder.acquire(
      testLease("active", "2026-08-12T00:00:02.000Z"),
    );
    expect(active).toBeDefined();

    monotonicNow = 3_000;

    expect(reclaimer.reclaimStale()).toBe(false);
    expect(active!.isCurrent()).toBe(true);
    expect(
      reclaimer.tryAcquire(
        testLease("replacement", "2026-08-12T00:01:00.000Z"),
      ),
    ).toBe(false);
    active!.retire();
  });

  it("immediately recovers an owned generation when its process disappears", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "owner-dead.lease.json");
    let ownerAlive = true;
    const first = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      ownerAlive: () => ownerAlive,
    });
    const recovered = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      ownerAlive: () => ownerAlive,
    });
    const ownership = first.acquire(
      testLease("dead-owner", "2026-08-12T00:10:00.000Z"),
    );
    expect(ownership).toBeDefined();

    ownerAlive = false;

    expect(recovered.reclaimStale()).toBe(true);
    expect(ownership!.isCurrent()).toBe(false);
    expect(
      recovered.tryAcquire(
        testLease("after-death", "2026-08-12T00:10:00.000Z"),
      ),
    ).toBe(true);
  });

  it("immediately recovers an owned generation after PID reuse changes its start time", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "owner-reused.lease.json");
    let reportedStartTime: string | undefined;
    const ownerAlive = (owner: {
      readonly pid: number;
      readonly startTimeTicks: string;
    }): boolean => {
      reportedStartTime ??= owner.startTimeTicks;
      return owner.startTimeTicks === reportedStartTime;
    };
    const first = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      ownerAlive,
    });
    const recovered = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      ownerAlive,
    });
    const ownership = first.acquire(
      testLease("reused-owner", "2026-08-12T00:10:00.000Z"),
    );
    expect(ownership).toBeDefined();
    expect(ownership!.isCurrent()).toBe(true);

    // PID 可能再次存在，但不同的 `/proc/<pid>/stat` 启动时间证明它不是发布本世代的进程。
    reportedStartTime = `${reportedStartTime!}1`;

    expect(recovered.reclaimStale()).toBe(true);
    expect(ownership!.isCurrent()).toBe(false);
    expect(
      recovered.tryAcquire(
        testLease("after-reuse", "2026-08-12T00:10:00.000Z"),
      ),
    ).toBe(true);
  });

  it("immediately recovers an owner generation after a boot change", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "owner-boot.lease.json");
    let bootId = "test-linux-boot";
    const first = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      bootId: () => bootId,
      ownerAlive: () => true,
    });
    const recovered = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      bootId: () => bootId,
      ownerAlive: () => true,
    });
    const ownership = first.acquire(
      testLease("old-boot", "2026-08-12T00:10:00.000Z"),
    );
    expect(ownership).toBeDefined();

    bootId = "test-linux-boot-next";

    expect(recovered.reclaimStale()).toBe(true);
    expect(ownership!.isCurrent()).toBe(false);
    expect(
      recovered.tryAcquire(testLease("new-boot", "2026-08-12T00:10:00.000Z")),
    ).toBe(true);
  });

  it("writes no periodic heartbeat artifacts for a live owner", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "no-heartbeats.lease.json");
    const lease = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      ownerAlive: () => true,
    });
    const ownership = lease.acquire(
      testLease("no-heartbeats", "2026-08-12T00:00:02.000Z"),
    );
    expect(ownership).toBeDefined();

    expect(ownership!.isCurrent()).toBe(true);
    expect(ownership!.isCurrent()).toBe(true);
    expect(
      (await namespaceNames(leasePath)).some((name) => name.includes(".beat-")),
    ).toBe(false);
    ownership!.retire();
  });

  it("does not let a legacy heartbeat artifact keep a dead owner generation live", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "legacy-heartbeat.lease.json");
    let ownerAlive = true;
    const holder = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      ownerAlive: () => ownerAlive,
    });
    const recovered = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      ownerAlive: () => ownerAlive,
    });
    expect(
      holder.acquire(testLease("legacy-heartbeat", "2026-08-12T00:00:02.000Z")),
    ).toBeDefined();
    const recordName = (await namespaceNames(leasePath)).find((name) =>
      name.endsWith(".lease.json"),
    )!;
    await writeFile(
      path.join(
        `${leasePath}.namespace`,
        recordName.replace(
          ".lease.json",
          ".beat-00000000-0000-4000-8000-000000000000.json",
        ),
      ),
      JSON.stringify({
        schema: "product-private-lease-heartbeat/1",
        expiresAtMonotonicMilliseconds: Number.MAX_SAFE_INTEGER,
      }),
      { mode: 0o600 },
    );

    ownerAlive = false;

    expect(recovered.reclaimStale()).toBe(true);
    expect(
      recovered.tryAcquire(
        testLease("after-legacy-heartbeat", "2026-08-12T00:10:00.000Z"),
      ),
    ).toBe(true);
  });

  it("bounds detached pending recovery by monotonic time when the wall clock moves backward", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "pending.lease.json");
    let wallNow = new Date("2026-08-12T00:00:00.000Z");
    let monotonicNow = 1_000;
    const first = privateLease({
      directory,
      leasePath,
      now: () => wallNow,
      monotonic: () => monotonicNow,
    });
    const resumed = privateLease({
      directory,
      leasePath,
      now: () => wallNow,
      monotonic: () => monotonicNow,
    });
    expect(
      first.tryAcquire(testLease("pending", "2026-08-12T00:00:02.000Z")),
    ).toBe(true);

    // 墙钟向未来跳变不会回收真实待处理状态。
    wallNow = new Date("2027-08-12T00:00:00.000Z");
    expect(resumed.reclaimStale()).toBe(false);
    // 随后的向后跳变不能让脱离进程的记录永久存在：启动期单调时间仍已越过其有界截止点。
    wallNow = new Date("2025-08-12T00:00:00.000Z");
    monotonicNow = 3_000;
    expect(resumed.reclaimStale()).toBe(true);
    expect(
      resumed.tryAcquire(testLease("replacement", "2026-08-12T00:01:00.000Z")),
    ).toBe(true);
  });

  it("does not compare a detached pending deadline across boots", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "pending-boot.lease.json");
    let bootId = "test-linux-boot";
    const first = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
      bootId: () => bootId,
    });
    const recovered = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_001,
      bootId: () => bootId,
    });
    expect(
      first.tryAcquire(
        testLease("pending-old-boot", "2026-08-12T00:10:00.000Z"),
      ),
    ).toBe(true);

    bootId = "test-linux-boot-next";

    expect(recovered.reclaimStale()).toBe(true);
    expect(
      recovered.tryAcquire(
        testLease("pending-new-boot", "2026-08-12T00:10:00.000Z"),
      ),
    ).toBe(true);
  });

  it("does not transfer a pending callback state after its detached deadline", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const namespacePath = path.join(directory, "callback.namespace");
    let monotonicNow = 1_000;
    const pending = privateLease({
      directory,
      leasePath: path.join(directory, "pending.lease.json"),
      namespacePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => monotonicNow,
    });
    const processing = privateLease({
      directory,
      leasePath: path.join(directory, "processing.lease.json"),
      namespacePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => monotonicNow,
    });
    const state = testLease("expired-one-time", "2026-08-12T00:00:02.000Z");
    expect(pending.tryAcquire(state)).toBe(true);

    monotonicNow = 3_000;

    expect(pending.consumeToActive(state, processing)).toBeUndefined();
    expect(processing.currentRecord()).toBeUndefined();
  });

  it("transfers a pending generation once and holds processing through the callback", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const namespacePath = path.join(directory, "callback.namespace");
    const now = () => new Date("2026-08-12T00:00:00.000Z");
    const monotonic = () => 1_000;
    const pending = privateLease({
      directory,
      leasePath: path.join(directory, "pending.lease.json"),
      namespacePath,
      now,
      monotonic,
    });
    const processing = privateLease({
      directory,
      leasePath: path.join(directory, "processing.lease.json"),
      namespacePath,
      now,
      monotonic,
    });
    const state = testLease("one-time", "2026-08-12T00:10:00.000Z");

    expect(pending.tryAcquire(state)).toBe(true);
    const ownership = pending.consumeToActive(state, processing);
    expect(ownership).toBeDefined();
    expect(pending.consumeToActive(state, processing)).toBeUndefined();
    expect(pending.currentRecord()).toBeUndefined();
    expect(processing.currentRecord()).toMatchObject({
      leaseNonce: "one-time",
    });
    expect(ownership!.isCurrent()).toBe(true);
    ownership!.retire();
    expect(processing.currentRecord()).toBeUndefined();
  });

  it("does not replay pending after a crashed processor had already published its immutable generation", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const namespacePath = path.join(directory, "callback.namespace");
    let monotonicNow = 1_000;
    let processorAlive = true;
    const state = testLease("one-time-crash", "2026-08-12T00:00:02.000Z");
    const pending = privateLease({
      directory,
      leasePath: path.join(directory, "pending.lease.json"),
      namespacePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => monotonicNow,
    });
    const processing = privateLease({
      directory,
      leasePath: path.join(directory, "processing.lease.json"),
      namespacePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => monotonicNow,
      ownerAlive: () => processorAlive,
    });

    expect(pending.tryAcquire(state)).toBe(true);
    // P 已发布处理世代，随后在关闭待处理状态前崩溃。即使之后的清理退役了 P 的活跃持有者，
    // 已发布不可变证据也必须让重试以关闭方式失败。
    expect(processing.acquire(state)).toBeDefined();
    processorAlive = false;
    monotonicNow = 3_000;
    expect(processing.reclaimStale()).toBe(true);

    expect(pending.consumeToActive(state, processing)).toBeUndefined();
    expect(pending.currentRecord()).toBeUndefined();
    expect(processing.currentRecord()).toBeUndefined();
  });

  it("fails closed rather than following a symlinked namespace", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "private");
    const leasePath = path.join(directory, "unsafe.lease.json");
    const namespacePath = `${leasePath}.namespace`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await symlink(path.join(root, "outside"), namespacePath);
    const lease = privateLease({
      directory,
      leasePath,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      monotonic: () => 1_000,
    });

    expect(() =>
      lease.tryAcquire(testLease("unsafe", "2026-08-12T00:00:01.000Z")),
    ).toThrow("private lease unavailable");
  });
});

type TestLease = ProductPrivateLeaseRecord & {
  readonly version: "test-private-lease/1";
};

function privateLease(input: {
  readonly directory: string;
  readonly leasePath: string;
  readonly namespacePath?: string;
  readonly now: () => Date;
  readonly monotonic: () => number;
  readonly bootId?: () => string;
  readonly ownerAlive?: (owner: {
    readonly pid: number;
    readonly startTimeTicks: string;
  }) => boolean;
  readonly beforePublish?: () => void;
  readonly beforeRetire?: () => void;
}): ProductPrivateLease<TestLease> {
  return new ProductPrivateLease({
    directory: input.directory,
    path: input.leasePath,
    ...(input.namespacePath === undefined
      ? {}
      : { namespacePath: input.namespacePath }),
    now: input.now,
    monotonicNow: input.monotonic,
    bootId: input.bootId ?? (() => "test-linux-boot"),
    ...(input.ownerAlive === undefined
      ? {}
      : { isOwnerAlive: input.ownerAlive }),
    isRecord: isTestLease,
    failureMessage: "private lease unavailable",
    ...(input.beforePublish === undefined
      ? {}
      : { beforePublish: input.beforePublish }),
    ...(input.beforeRetire === undefined
      ? {}
      : { beforeRetire: input.beforeRetire }),
  });
}

function testLease(leaseNonce: string, expiresAt: string): TestLease {
  return {
    schema: "product-private-lease/1",
    version: "test-private-lease/1",
    instanceNonce: "test-instance",
    leaseNonce,
    fingerprint: leaseNonce,
    acquiredAt: "2026-08-12T00:00:00.000Z",
    expiresAt,
  };
}

function isTestLease(value: unknown): value is TestLease {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === "product-private-lease/1" &&
    candidate.version === "test-private-lease/1" &&
    typeof candidate.instanceNonce === "string" &&
    typeof candidate.leaseNonce === "string" &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.acquiredAt === "string" &&
    typeof candidate.expiresAt === "string"
  );
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "digital-private-lease-"));
  temporaryRoots.push(root);
  return root;
}

async function namespaceNames(leasePath: string): Promise<readonly string[]> {
  const directory = `${leasePath}.namespace`;
  return await readdir(directory);
}
