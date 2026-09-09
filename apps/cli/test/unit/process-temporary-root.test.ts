import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { claimProcessTemporaryRoot } from "@digital/composition/process-temporary-root";
import { afterEach, expect, it } from "vitest";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

it("CLI process owner sets its environment to one 0700 root and closes it idempotently", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "digital-cli-owner-test-"));
  cleanup.push(parent);
  const environment: NodeJS.ProcessEnv = { TMPDIR: "/previous" };

  const owner = await claimProcessTemporaryRoot(environment, {
    prefix: "digital-cli-process-",
    parentDirectory: parent,
  });

  expect(environment.TMPDIR).toBe(owner.directory);
  expect((await lstat(owner.directory)).mode & 0o777).toBe(0o700);
  const firstClose = owner.close();
  expect(owner.close()).toBe(firstClose);
  await firstClose;
  expect(environment.TMPDIR).toBe("/previous");
  await expect(lstat(owner.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("CLI process owner is deleted only after its child operation succeeds", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "digital-cli-parent-test-"));
  cleanup.push(parent);
  const environment: NodeJS.ProcessEnv = {};
  const failedOwner = await claimProcessTemporaryRoot(environment, {
    prefix: "digital-cli-process-",
    parentDirectory: parent,
  });
  const failure = new Error("product close failed");

  await expect(
    failedOwner.closeAfterSuccessful(Promise.reject(failure)),
  ).rejects.toBe(failure);
  await expect(lstat(failedOwner.directory)).resolves.toBeDefined();
  expect(environment.TMPDIR).toBe(failedOwner.directory);

  await failedOwner.close();
  const successfulOwner = await claimProcessTemporaryRoot(environment, {
    prefix: "digital-cli-process-",
    parentDirectory: parent,
  });
  await expect(
    successfulOwner.closeAfterSuccessful(Promise.resolve(7)),
  ).resolves.toBe(7);
  await expect(lstat(successfulOwner.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
