import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type ObservedFilesystemCapability,
  type ObservedRootSnapshot,
} from "@digital/application";
import { InMemoryObservedFilesystemCapability } from "@digital/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { ReadOnlyFilesystemObserver } from "../src/index.ts";

const cleanup: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-observed-filesystem-"),
  );
  cleanup.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

async function exerciseObservedFilesystemCapability(
  filesystem: ObservedFilesystemCapability,
  root: ObservedRootSnapshot,
): Promise<{ readonly files: readonly string[]; readonly text: string }> {
  const scope = await filesystem.bindScope({ root, relativeScope: "." });
  try {
    const snapshot = await filesystem.observe(scope);
    const source = await filesystem.openByteSource({
      scope,
      relativePath: "track.txt",
    });
    try {
      return {
        files: snapshot.files.map((file) => file.relativePath),
        text: new TextDecoder().decode(await source.read()),
      };
    } finally {
      await source.close();
    }
  } finally {
    await filesystem.closeScope(scope);
  }
}

describe("Observed filesystem capability contract", () => {
  it("lets a real descriptor adapter and an in-memory adapter bind, observe, read, and close through one contract", async () => {
    const directory = await temporaryRoot();
    await writeFile(path.join(directory, "track.txt"), "descriptor-audio");
    const filesystem = new ReadOnlyFilesystemObserver();
    const inspected = await filesystem.inspectReadableDirectory(directory);
    const root: ObservedRootSnapshot = {
      version: "observed-root-snapshot/1",
      id: "observed-root",
      configVersion: 1,
      containerPath: inspected.absolutePath,
      canonicalPath: inspected.canonicalPath,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    };

    await expect(
      exerciseObservedFilesystemCapability(filesystem, root),
    ).resolves.toEqual({ files: ["track.txt"], text: "descriptor-audio" });
    const inMemory: ObservedFilesystemCapability =
      new InMemoryObservedFilesystemCapability({
        bytes: { "track.txt": "in-memory-audio" },
        observe: ({ scope }) => ({
          id: "memory-snapshot",
          root: scope.logicalLocation,
          complete: true,
          files: [
            {
              relativePath: "track.txt",
              size: 15,
              modifiedAt: "2026-08-03T00:00:00.000Z",
            },
          ],
          excluded: [],
          observedAt: "2026-08-03T00:00:00.000Z",
        }),
      });
    await expect(
      exerciseObservedFilesystemCapability(inMemory, root),
    ).resolves.toEqual({
      files: ["track.txt"],
      text: "in-memory-audio",
    });
  });
});
