import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  createWebProcessTemporaryRoot,
  createWebProcessTemporaryRootClaimRegistry,
} from "#/server/process-temporary-root";

it("Web process owner uses an isolated environment and deletes only its unchanged identity", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "digital-web-owner-test-"));
  const environment: NodeJS.ProcessEnv = {};
  try {
    const owner = await createWebProcessTemporaryRoot(environment, parent);
    expect(environment.TMPDIR).toBe(owner.directory);
    expect((await lstat(owner.directory)).mode & 0o777).toBe(0o700);
    const firstClose = owner.close();
    expect(owner.close()).toBe(firstClose);
    await firstClose;
    expect(environment.TMPDIR).toBeUndefined();
    await expect(lstat(owner.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("deletes the Web process root only after every overlapping claim rolls back", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "digital-web-claim-test-"));
  const environment: NodeJS.ProcessEnv = {};
  try {
    const registry = createWebProcessTemporaryRootClaimRegistry(
      environment,
      parent,
    );
    const initial = await registry.claim();
    const directory = environment.TMPDIR!;
    const replacement = await registry.claim();

    await initial.rollback();
    expect(environment.TMPDIR).toBe(directory);
    await expect(lstat(directory)).resolves.toBeDefined();

    await replacement.rollback();
    expect(environment.TMPDIR).toBeUndefined();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("keeps an overlapping committed Web claim until terminal close", async () => {
  const parent = await mkdtemp(
    path.join(tmpdir(), "digital-web-overlap-test-"),
  );
  const environment: NodeJS.ProcessEnv = {};
  try {
    const registry = createWebProcessTemporaryRootClaimRegistry(
      environment,
      parent,
    );
    const initial = await registry.claim();
    const directory = environment.TMPDIR!;
    const successor = await registry.claim();

    successor.beginInitialization();
    successor.commit();
    successor.commit();
    await initial.rollback();
    await initial.rollback();
    expect(environment.TMPDIR).toBe(directory);
    await expect(lstat(directory)).resolves.toBeDefined();

    const stableReplacement = await registry.claim();
    await stableReplacement.rollback();
    expect(environment.TMPDIR).toBe(directory);
    await expect(lstat(directory)).resolves.toBeDefined();

    const late = await registry.claim();
    let closeSettled = false;
    const closing = registry.close();
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    expect(registry.close()).toBe(closing);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(environment.TMPDIR).toBe(directory);
    await expect(lstat(directory)).resolves.toBeDefined();
    expect(() => late.beginInitialization()).toThrow(
      "Web 进程临时根已关闭，不能开始初始化",
    );
    await closing;
    expect(environment.TMPDIR).toBeUndefined();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => late.commit()).toThrow("Web 进程临时根 claim 未开始初始化");
    await late.rollback();
    successor.commit();
    await successor.rollback();
    await expect(registry.claim()).rejects.toThrow(
      "Web 进程临时根已关闭，不能再 claim",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("keeps a retained failed-bootstrap claim until terminal close", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "digital-web-retain-test-"));
  const environment: NodeJS.ProcessEnv = {};
  try {
    const registry = createWebProcessTemporaryRootClaimRegistry(
      environment,
      parent,
    );
    const claim = await registry.claim();
    const directory = environment.TMPDIR!;

    claim.beginInitialization();
    claim.retain();
    claim.retain();
    await claim.rollback();
    expect(environment.TMPDIR).toBe(directory);
    await expect(lstat(directory)).resolves.toBeDefined();

    await registry.close();
    expect(environment.TMPDIR).toBeUndefined();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("poisons the Web process-root registry after retirement identity failure", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "digital-web-poison-test-"));
  const environment: NodeJS.ProcessEnv = {};
  try {
    const registry = createWebProcessTemporaryRootClaimRegistry(
      environment,
      parent,
    );
    const claim = await registry.claim();
    const directory = environment.TMPDIR!;
    await rename(directory, `${directory}-owned`);
    await mkdir(directory, { mode: 0o700 });

    const retirement = claim.rollback();
    await expect(retirement).rejects.toThrow("进程临时根身份已改变，拒绝删除");
    await expect(registry.claim()).rejects.toThrow(
      "进程临时根身份已改变，拒绝删除",
    );
    await expect(registry.close()).rejects.toThrow(
      "进程临时根身份已改变，拒绝删除",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
