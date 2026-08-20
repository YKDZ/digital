import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { observeRoot } from "./observed-scope.ts";

const cleanup: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "digital-snapshot-"));
  cleanup.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async (root) =>
      (await import("node:fs/promises")).rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("filesystem package structure", () => {
  it("retains the root and empty directories in a complete snapshot", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "empty", "nested"), { recursive: true });
    await writeFile(path.join(root, "ordinary.txt"), "ordinary");

    const snapshot = await observeRoot(root);

    expect(snapshot.complete).toBe(true);
    expect(
      snapshot.directories?.map((directory) => directory.relativePath),
    ).toEqual([".", "empty", "empty/nested"]);
  });

  it("uses stable code-unit order for file and directory observations", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "Z"));
    await mkdir(path.join(root, "a"));
    await writeFile(path.join(root, "Z.txt"), "Z");
    await writeFile(path.join(root, "a.txt"), "a");

    const snapshot = await observeRoot(root);

    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "Z.txt",
      "a.txt",
    ]);
    expect(
      snapshot.directories?.map((directory) => directory.relativePath),
    ).toEqual([".", "Z", "a"]);
  });
});
