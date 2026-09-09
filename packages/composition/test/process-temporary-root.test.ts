import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { claimProcessTemporaryRoot } from "../src/process-temporary-root.ts";

it("refuses to delete a replacement at the owned process-root path", async () => {
  const parent = await mkdtemp(
    path.join(tmpdir(), "digital-process-owner-identity-test-"),
  );
  const environment: NodeJS.ProcessEnv = {};
  try {
    const owner = await claimProcessTemporaryRoot(environment, {
      prefix: "digital-cli-process-",
      parentDirectory: parent,
    });
    const movedOwner = `${owner.directory}-moved`;
    await rename(owner.directory, movedOwner);
    await mkdir(owner.directory, { mode: 0o700 });

    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    await expect(closing).rejects.toThrow("进程临时根身份已改变，拒绝删除");
    await expect(lstat(owner.directory)).resolves.toBeDefined();
    expect(environment.TMPDIR).toBe(owner.directory);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
