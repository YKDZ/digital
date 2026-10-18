import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureRawFilesystemSnapshot } from "@digital/test-support";
import { describe, expect, it } from "vitest";

import { observeRoot } from "./observed-scope.ts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const corpusDirectory = path.join(workspaceRoot, ".scratch/acceptance-corpus");
const corpusAssetsDirectory = path.join(corpusDirectory, "assets");
const packageRequire = createRequire(import.meta.url);

function logicalRootDirectory(logicalRoot: string): string {
  const normalized = path.posix.normalize(logicalRoot.replace(/\/+$/u, ""));
  if (
    normalized.length === 0 ||
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`invalid fixed-corpus logical root: ${logicalRoot}`);
  }
  return path.join(corpusAssetsDirectory, ...normalized.split("/"));
}

async function fixedLogicalRoots(): Promise<readonly string[]> {
  const manifest = await readFile(
    packageRequire.resolve("@digital/preview-corpus/live/files-from.txt"),
    "utf8",
  );
  return manifest
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("fixed acceptance corpus observation", () => {
  it("observes every configured logical root without changing its entries or metadata", async () => {
    const roots = await fixedLogicalRoots();
    expect(roots).toHaveLength(29);
    const directories = roots.map(logicalRootDirectory);
    const before = await Promise.all(
      directories.map(
        async (directory) => await captureRawFilesystemSnapshot(directory),
      ),
    );
    const snapshots = await Promise.all(
      directories.map(async (directory) => await observeRoot(directory)),
    );

    const after = await Promise.all(
      directories.map(
        async (directory) => await captureRawFilesystemSnapshot(directory),
      ),
    );
    expect(after).toEqual(before);
    for (const [index, snapshot] of snapshots.entries()) {
      const fingerprint = before[index]?.entries ?? [];
      const regularFiles = fingerprint.filter(
        (entry) => entry.kind === "regular-file",
      );
      expect(snapshot.files).toHaveLength(regularFiles.length);
      expect(
        snapshot.files
          .map((file) => file.relativePath)
          .toSorted(compareCodeUnits),
      ).toEqual(
        regularFiles
          .map((entry) => entry.relativePath)
          .filter((relativePath) => relativePath !== ".")
          .toSorted(compareCodeUnits),
      );
      expect(
        snapshot.directories?.map((directory) => directory.relativePath),
      ).toEqual(
        fingerprint
          .filter((entry) => entry.kind === "directory")
          .map((entry) => entry.relativePath)
          .toSorted(compareCodeUnits),
      );
    }
    const observedPaths = snapshots.flatMap((snapshot) =>
      snapshot.files.map((file) => file.relativePath),
    );
    expect(observedPaths.some((entry) => entry.endsWith(".nfo"))).toBe(true);
    expect(observedPaths.some((entry) => entry.endsWith("poster.jpg"))).toBe(
      true,
    );
  });
});

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 这项显式真实验收避免哈希全部 123 GiB 私有语料。它围绕一次只读观察，
 * 冻结每个条目的类型、路径、可用时的设备/inode、模式、大小、修改时间和状态变化时间。
 * 普通写入会更改状态变化时间（通常也会更改大小或修改时间）；独立 CLI 深度完整性任务
 * 才会选择完整哈希。
 */
