import { readFile } from "node:fs/promises";
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
    path.join(corpusDirectory, "files-from.txt"),
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
 * This ordinary acceptance check deliberately avoids hashing the 123 GiB
 * private corpus on every root check.  It freezes every entry's type, path,
 * device/inode where available, mode, size, mtime and ctime around a
 * read-only observation.  Normal writes change ctime (and generally size or
 * mtime), while the separate CLI deep-integrity task opts into full hashes.
 */
