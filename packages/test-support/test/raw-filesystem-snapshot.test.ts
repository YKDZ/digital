import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureRawFilesystemSnapshot } from "../src/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("raw filesystem snapshot", () => {
  it("captures an immutable ordered tree with file digests and unfollowed symlinks", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "digital-raw-snapshot-"));
    temporaryRoots.push(parent);
    const root = path.join(parent, "root");
    await mkdir(path.join(root, "empty"), { recursive: true });
    await writeFile(path.join(root, "z.txt"), "z");
    await writeFile(path.join(root, "A.txt"), "alpha");
    await symlink("empty", path.join(root, "linked-directory"));

    const snapshot = await captureRawFilesystemSnapshot(root, {
      contentDigests: true,
    });

    expect(snapshot.entries.map((entry) => entry.relativePath)).toEqual([
      ".",
      "A.txt",
      "empty",
      "linked-directory",
      "z.txt",
    ]);
    expect(
      snapshot.entries.map((entry) => ({
        path: entry.relativePath,
        kind: entry.kind,
        target: entry.symbolicLinkTarget,
      })),
    ).toEqual([
      { path: ".", kind: "directory", target: undefined },
      { path: "A.txt", kind: "regular-file", target: undefined },
      { path: "empty", kind: "directory", target: undefined },
      {
        path: "linked-directory",
        kind: "symbolic-link",
        target: "empty",
      },
      { path: "z.txt", kind: "regular-file", target: undefined },
    ]);
    expect(snapshot.entries[1]?.contentDigest).toBe(
      "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
    );
    expect(snapshot.entries[3]?.contentDigest).toBeUndefined();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(snapshot.entries.every(Object.isFrozen)).toBe(true);
  });

  it("does not digest bytes by default and classifies a special entry without opening it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-raw-snapshot-"));
    temporaryRoots.push(root);
    await writeFile(
      path.join(root, "ordinary.bin"),
      new Uint8Array([4, 8, 15]),
    );
    const socketPath = path.join(root, "evidence.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const snapshot = await captureRawFilesystemSnapshot(root);

      const ordinary = snapshot.entries.find(
        (entry) => entry.relativePath === "ordinary.bin",
      );
      expect(ordinary).toMatchObject({
        kind: "regular-file",
        byteLength: 3,
      });
      expect(ordinary?.contentDigest).toBeUndefined();
      expect(
        snapshot.entries.find((entry) => entry.relativePath === "evidence.sock")
          ?.kind,
      ).toBe("special");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
});
