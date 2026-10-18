import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const maintenanceEntry = fileURLToPath(
  import.meta.resolve("@digital/product-maintenance/cli"),
);

it("要求维护命令显式提供绝对产品数据根和备份根", async () => {
  const missingPaths = await runMaintenance(["offline-backup"]);
  expect(missingPaths.code).toBe(1);
  expect(missingPaths.stderr).toContain("用法：");
  expect(missingPaths.stdout).not.toContain("完成");

  const relativePath = await runMaintenance([
    "offline-backup",
    "--product-data",
    "relative-product-data",
    "--backup-directory",
    "/tmp/backup",
  ]);
  expect(relativePath.code).toBe(1);
  expect(relativePath.stderr).toContain("维护路径必须是绝对路径");
  expect(relativePath.stdout).not.toContain("完成");
});

async function runMaintenance(args: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [maintenanceEntry, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}
