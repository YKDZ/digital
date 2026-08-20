import {
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertRootsDoNotOverlap,
  ReadOnlyFilesystemObserver,
} from "../src/index.ts";
import { installFilesystemObservationTestHooks } from "../src/testing-hooks.ts";
import { bindObservedScope, observeRoot } from "./observed-scope.ts";

const cleanup: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "digital-safety-"));
  cleanup.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("observed-root storage safety", () => {
  it.each([
    "do-not-follow",
    "follow-file-links",
    "follow-file-and-directory-links",
  ] as const)(
    "does not turn a resolved logical root into authority after replacement (%s)",
    async (symlinkMode) => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      await writeFile(path.join(root, "inside.txt"), "inside");
      await writeFile(path.join(outside, "outside.txt"), "outside");
      const { filesystem, scope } = await bindObservedScope(root, {
        symlinkMode,
      });
      const movedRoot = `${root}-moved`;
      cleanup.push(movedRoot);
      await rename(root, movedRoot);
      await symlink(outside, root, "dir");
      try {
        const snapshot = await filesystem.observe(scope);
        expect(snapshot.complete).toBe(true);
        expect(snapshot.files.map((file) => file.relativePath)).toEqual([
          "inside.txt",
        ]);
        expect(snapshot.files.map((file) => file.relativePath)).not.toContain(
          "outside.txt",
        );
      } finally {
        await filesystem.closeScope(scope);
      }
    },
  );

  it("keeps a frozen target root on its own descriptor after target replacement", async () => {
    const root = await temporaryRoot();
    const target = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(path.join(target, "inside.txt"), "inside");
    await writeFile(path.join(outside, "outside.txt"), "outside");
    await symlink(target, path.join(root, "linked"), "dir");
    const { filesystem, scope } = await bindObservedScope(root, {
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetPaths: [target],
    });
    const movedTarget = `${target}-moved`;
    cleanup.push(movedTarget);
    await rename(target, movedTarget);
    await symlink(outside, target, "dir");
    try {
      const snapshot = await filesystem.observe(scope);
      expect(snapshot.files.map((file) => file.relativePath)).toEqual([
        "linked/inside.txt",
      ]);
      expect(snapshot.files.map((file) => file.relativePath)).not.toContain(
        "linked/outside.txt",
      );
    } finally {
      await filesystem.closeScope(scope);
    }
  });

  it("opens an already-bound root file after root replacement without reopening its pathname", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(path.join(root, "track.flac"), "inside-audio");
    await writeFile(path.join(outside, "track.flac"), "outside-audio");
    const { filesystem, scope } = await bindObservedScope(root);
    const movedRoot = `${root}-moved`;
    cleanup.push(movedRoot);
    await rename(root, movedRoot);
    await symlink(outside, root, "dir");
    try {
      const source = await filesystem.openByteSource({
        scope,
        relativePath: "track.flac",
      });
      try {
        await expect(source.read()).resolves.toEqual(
          new TextEncoder().encode("inside-audio"),
        );
      } finally {
        await source.close();
      }
    } finally {
      await filesystem.closeScope(scope);
    }
  });

  it("opens a bound target-root file after target replacement without reopening its pathname", async () => {
    const root = await temporaryRoot();
    const target = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(path.join(target, "track.flac"), "inside-target-audio");
    await writeFile(path.join(outside, "track.flac"), "outside-target-audio");
    await symlink(
      path.join(target, "track.flac"),
      path.join(root, "track.flac"),
    );
    const { filesystem, scope } = await bindObservedScope(root, {
      symlinkMode: "follow-file-links",
      allowedTargetPaths: [target],
    });
    const movedTarget = `${target}-moved`;
    cleanup.push(movedTarget);
    await rename(target, movedTarget);
    await symlink(outside, target, "dir");
    try {
      const source = await filesystem.openByteSource({
        scope,
        relativePath: "track.flac",
      });
      try {
        await expect(source.read()).resolves.toEqual(
          new TextEncoder().encode("inside-target-audio"),
        );
      } finally {
        await source.close();
      }
    } finally {
      await filesystem.closeScope(scope);
    }
  });

  it.each([
    {
      mode: "follow-file-links" as const,
      linkName: "file-link.flac",
      linkTarget: (targetAlias: string) => path.join(targetAlias, "track.flac"),
      linkKind: "file" as const,
      readPath: "file-link.flac",
    },
    {
      mode: "follow-file-and-directory-links" as const,
      linkName: "directory-link",
      linkTarget: (targetAlias: string) => targetAlias,
      linkKind: "dir" as const,
      readPath: "directory-link/track.flac",
    },
  ])(
    "opens a registered target alias byte source on its frozen descriptor (%s)",
    async ({ mode, linkName, linkTarget, linkKind, readPath }) => {
      const root = await temporaryRoot();
      const target = await temporaryRoot();
      const outside = await temporaryRoot();
      const targetAlias = `${target}-registered-alias`;
      cleanup.push(targetAlias);
      await writeFile(path.join(target, "track.flac"), "inside-target-audio");
      await writeFile(path.join(outside, "track.flac"), "outside-audio");
      await symlink(target, targetAlias, "dir");
      await symlink(
        linkTarget(targetAlias),
        path.join(root, linkName),
        linkKind,
      );
      const { filesystem, scope } = await bindObservedScope(root, {
        symlinkMode: mode,
        allowedTargetPaths: [targetAlias],
      });
      await rm(targetAlias);
      await symlink(outside, targetAlias, "dir");
      try {
        const source = await filesystem.openByteSource({
          scope,
          relativePath: readPath,
        });
        expect(source.logicalLocation).toBe(path.join(root, readPath));
        try {
          await expect(source.read()).resolves.toEqual(
            new TextEncoder().encode("inside-target-audio"),
          );
        } finally {
          await source.close();
        }
      } finally {
        await filesystem.closeScope(scope);
      }
    },
  );

  it("rejects a target alias that was repointed before its frozen scope binds", async () => {
    const source = await temporaryRoot();
    const target = await temporaryRoot();
    const outside = await temporaryRoot();
    const targetAlias = `${target}-registered-alias`;
    cleanup.push(targetAlias);
    await symlink(target, targetAlias, "dir");
    const filesystem = new ReadOnlyFilesystemObserver();
    const sourceRoot = await filesystem.inspectReadableDirectory(source);
    const targetRoot = await filesystem.inspectReadableDirectory(targetAlias);
    await rm(targetAlias);
    await symlink(outside, targetAlias, "dir");

    await expect(
      filesystem.bindScope({
        root: {
          version: "observed-root-snapshot/1",
          id: "source",
          configVersion: 1,
          containerPath: sourceRoot.absolutePath,
          canonicalPath: sourceRoot.canonicalPath,
          readOnly: true,
          symlinkMode: "follow-file-links",
          allowedTargetRootIds: ["target"],
          authorizedTargetRoots: [
            {
              id: "target",
              configVersion: 1,
              containerPath: targetAlias,
              canonicalPath: targetRoot.canonicalPath,
            },
          ],
        },
        relativeScope: ".",
      }),
    ).rejects.toThrow("bound authority no longer matches its frozen identity");
  });

  it("authorizes a later byte read with the same link policy as observation", async () => {
    const root = await temporaryRoot();
    const authorized = await temporaryRoot();
    const outside = await temporaryRoot();
    const targetFile = path.join(authorized, "track.flac");
    await writeFile(targetFile, "audio");
    await writeFile(path.join(outside, "outside.flac"), "outside");
    await symlink(targetFile, path.join(root, "file-link.flac"));
    await symlink(authorized, path.join(root, "directory-link"), "dir");
    await symlink(
      path.join(outside, "outside.flac"),
      path.join(root, "outside-link.flac"),
    );
    const read = async (
      symlinkMode:
        | "do-not-follow"
        | "follow-file-links"
        | "follow-file-and-directory-links",
      relativePath: string,
    ) => {
      const { filesystem, scope } = await bindObservedScope(root, {
        symlinkMode,
        allowedTargetPaths: [authorized],
      });
      try {
        const source = await filesystem.openByteSource({
          scope,
          relativePath,
        });
        try {
          return new TextDecoder().decode(await source.read());
        } finally {
          await source.close();
        }
      } finally {
        await filesystem.closeScope(scope);
      }
    };

    await expect(read("do-not-follow", "file-link.flac")).rejects.toThrow(
      "symbolic-link-not-followed",
    );
    await expect(read("follow-file-links", "file-link.flac")).resolves.toBe(
      "audio",
    );
    await expect(
      read("follow-file-links", "directory-link/track.flac"),
    ).rejects.toThrow("directory-link-not-allowed");
    await expect(
      read("follow-file-and-directory-links", "directory-link/track.flac"),
    ).resolves.toBe("audio");
    await expect(
      read("follow-file-links", "outside-link.flac"),
    ).rejects.toThrow("outside-authorized-roots");
  });

  it("records a disappeared entry and continues observing healthy siblings", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "healthy.txt"), "healthy");
    await writeFile(path.join(root, "vanishing.txt"), "vanishing");
    const filesystem = installFilesystemObservationTestHooks(
      new ReadOnlyFilesystemObserver(),
      {
        afterEntryLstat: async ({ relativePath }) => {
          if (relativePath === "vanishing.txt")
            await rm(path.join(root, relativePath));
        },
      },
    );
    const { scope } = await bindObservedScope(root, {}, filesystem);
    try {
      const snapshot = await filesystem.observe(scope);
      expect(snapshot.complete).toBe(false);
      expect(snapshot.files.map((file) => file.relativePath)).toEqual([
        "healthy.txt",
      ]);
      expect(snapshot.excluded).toContainEqual({
        relativePath: "vanishing.txt",
        kind: "unavailable",
      });
      expect(snapshot.diagnostics).toContainEqual({
        relativePath: "vanishing.txt",
        kind: "entry-missing",
      });
    } finally {
      await filesystem.closeScope(scope);
    }
  });

  it("records an inaccessible entry and continues observing healthy siblings", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "healthy.txt"), "healthy");
    await writeFile(path.join(root, "denied.txt"), "denied");
    const filesystem = installFilesystemObservationTestHooks(
      new ReadOnlyFilesystemObserver(),
      {
        afterEntryLstat({ relativePath }) {
          if (relativePath === "denied.txt") {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
        },
      },
    );
    const { scope } = await bindObservedScope(root, {}, filesystem);
    try {
      const snapshot = await filesystem.observe(scope);
      expect(snapshot.complete).toBe(false);
      expect(snapshot.files.map((file) => file.relativePath)).toEqual([
        "healthy.txt",
      ]);
      expect(snapshot.excluded).toContainEqual({
        relativePath: "denied.txt",
        kind: "unavailable",
      });
      expect(snapshot.diagnostics).toContainEqual({
        relativePath: "denied.txt",
        kind: "entry-inaccessible",
      });
    } finally {
      await filesystem.closeScope(scope);
    }
  });

  it("records a replaced entry identity and continues observing healthy siblings", async () => {
    const root = await temporaryRoot();
    const replaced = path.join(root, "replaced.txt");
    await writeFile(path.join(root, "healthy.txt"), "healthy");
    await writeFile(replaced, "before");
    const filesystem = installFilesystemObservationTestHooks(
      new ReadOnlyFilesystemObserver(),
      {
        afterEntryLstat: async ({ relativePath }) => {
          if (relativePath !== "replaced.txt") return;
          await rename(replaced, `${replaced}.old`);
          await writeFile(replaced, "after");
        },
      },
    );
    const { scope } = await bindObservedScope(root, {}, filesystem);
    try {
      const snapshot = await filesystem.observe(scope);
      expect(snapshot.complete).toBe(false);
      expect(snapshot.files.map((file) => file.relativePath)).toEqual([
        "healthy.txt",
      ]);
      expect(snapshot.excluded).toContainEqual({
        relativePath: "replaced.txt",
        kind: "unavailable",
      });
      expect(snapshot.diagnostics).toContainEqual({
        relativePath: "replaced.txt",
        kind: "entry-identity-changed",
      });
    } finally {
      await filesystem.closeScope(scope);
    }
  });

  it("does not dereference a broken link in do-not-follow mode", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "healthy.txt"), "healthy");
    await symlink(
      path.join(root, "missing.txt"),
      path.join(root, "broken.txt"),
    );
    const snapshot = await observeRoot(root, { symlinkMode: "do-not-follow" });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "healthy.txt",
    ]);
    expect(snapshot.diagnostics).toContainEqual({
      relativePath: "broken.txt",
      kind: "symbolic-link-not-followed",
    });
    expect(snapshot.diagnostics).not.toContainEqual({
      relativePath: "broken.txt",
      kind: "broken-symbolic-link",
    });
  });

  it("follows an authorized file link as a distinct observed path in file-link mode", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "target.txt"), "target");
    await symlink(path.join(root, "target.txt"), path.join(root, "alias.txt"));

    const snapshot = await observeRoot(root, {
      symlinkMode: "follow-file-links",
      allowedTargetPaths: [root],
    });

    expect(snapshot.complete).toBe(true);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "alias.txt",
      "target.txt",
    ]);
  });

  it("gives a hardlink and an allowed file alias one opaque object identity", async () => {
    const root = await temporaryRoot();
    const original = path.join(root, "original.flac");
    await writeFile(original, "audio");
    await link(original, path.join(root, "hardlink.flac"));
    await symlink(original, path.join(root, "alias.flac"));

    const snapshot = await observeRoot(root, {
      symlinkMode: "follow-file-links",
      allowedTargetPaths: [root],
    });

    expect(snapshot.complete).toBe(true);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "alias.flac",
      "hardlink.flac",
      "original.flac",
    ]);
    const identities = snapshot.files.map((file) => file.objectIdentity);
    expect(identities).toEqual([
      expect.objectContaining({
        version: "filesystem-object-identity/2",
        kind: "snapshot-local",
        value: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      identities[0],
      identities[0],
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('"ino"');
    expect(JSON.stringify(snapshot)).not.toContain('"dev"');

    const later = await observeRoot(root, {
      symlinkMode: "follow-file-links",
      allowedTargetPaths: [root],
    });
    expect(later.files[0]?.objectIdentity).not.toEqual(identities[0]);
  });

  it("keeps a directory link auditable rather than following it in file-link mode", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "inside.txt"), "inside");
    await symlink(target, path.join(root, "linked"), "dir");

    const snapshot = await observeRoot(root, {
      symlinkMode: "follow-file-links",
      allowedTargetPaths: [root],
    });

    expect(snapshot.complete).toBe(false);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "target/inside.txt",
    ]);
    expect(snapshot.diagnostics).toEqual([
      { relativePath: "linked", kind: "directory-link-not-allowed" },
    ]);
  });

  it("follows an authorized directory link in all-link mode while retaining its logical alias", async () => {
    const root = await temporaryRoot();
    const authorized = await temporaryRoot();
    await writeFile(path.join(authorized, "inside.txt"), "inside");
    await symlink(authorized, path.join(root, "linked"), "dir");

    const snapshot = await observeRoot(root, {
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetPaths: [root, authorized],
    });

    expect(snapshot.complete).toBe(true);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "linked/inside.txt",
    ]);
    expect(
      snapshot.directories?.map((directory) => directory.relativePath),
    ).toEqual([".", "linked"]);
  });

  it("rejects an out-of-bound link without expanding the root authority", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(path.join(outside, "outside.txt"), "outside");
    await symlink(
      path.join(outside, "outside.txt"),
      path.join(root, "outside.txt"),
    );

    const snapshot = await observeRoot(root, {
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetPaths: [root],
    });

    expect(snapshot.complete).toBe(false);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      {
        relativePath: "outside.txt",
        kind: "link-target-outside-authorized-roots",
      },
    ]);
  });

  it("records broken links, directory cycles and repeated targets without recursing forever", async () => {
    const root = await temporaryRoot();
    const target = await temporaryRoot();
    await writeFile(path.join(target, "inside.txt"), "inside");
    await symlink(
      path.join(root, "missing.txt"),
      path.join(root, "broken.txt"),
    );
    await symlink(root, path.join(root, "cycle"), "dir");
    await symlink(target, path.join(root, "first"), "dir");
    await symlink(target, path.join(root, "second"), "dir");

    const snapshot = await observeRoot(root, {
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetPaths: [root, target],
    });

    expect(snapshot.complete).toBe(false);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "first/inside.txt",
    ]);
    expect(snapshot.diagnostics).toEqual([
      { relativePath: "broken.txt", kind: "broken-symbolic-link" },
      { relativePath: "cycle", kind: "symbolic-link-cycle" },
      { relativePath: "second", kind: "repeated-directory-target" },
    ]);
  });

  it("rejects a product-data directory inside an observed tree", async () => {
    const root = await temporaryRoot();
    await expect(
      assertRootsDoNotOverlap(root, path.join(root, "data")),
    ).rejects.toThrow("must not overlap");
  });

  it("rejects an observed root nested inside an existing product-data tree", async () => {
    const root = await temporaryRoot();
    const observed = path.join(root, "product-data", "observed");
    await expect(assertRootsDoNotOverlap(observed, root)).rejects.toThrow(
      "must not overlap",
    );
  });

  it("rejects a symlink alias of an observed tree before it exists as product data", async () => {
    const root = await temporaryRoot();
    const alias = path.join(tmpdir(), `digital-safety-alias-${Date.now()}`);
    cleanup.push(alias);
    await symlink(root, alias, "dir");
    await expect(
      assertRootsDoNotOverlap(root, path.join(alias, "data")),
    ).rejects.toThrow("must not overlap");
  });

  it("rejects an observed root beneath a symlink alias of product data", async () => {
    const root = await temporaryRoot();
    const product = path.join(root, "product-data");
    await writeFile(path.join(root, "placeholder"), "placeholder");
    await (await import("node:fs/promises")).mkdir(product);
    const alias = path.join(tmpdir(), `digital-safety-product-${Date.now()}`);
    cleanup.push(alias);
    await symlink(product, alias, "dir");

    await expect(
      assertRootsDoNotOverlap(path.join(alias, "observed"), product),
    ).rejects.toThrow("must not overlap");
  });

  it("records excluded symlinks instead of claiming a silently incomplete snapshot", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "target.txt"), "target");
    await symlink(path.join(root, "target.txt"), path.join(root, "alias.txt"));

    const snapshot = await observeRoot(root);

    expect(snapshot).toMatchObject({
      complete: false,
      files: [{ relativePath: "target.txt" }],
      excluded: [{ relativePath: "alias.txt", kind: "symbolic-link" }],
      diagnostics: [
        { relativePath: "alias.txt", kind: "symbolic-link-not-followed" },
      ],
    });
  });

  it.each([
    ["do-not-follow", false],
    ["follow-file-links", true],
    ["follow-file-and-directory-links", true],
  ] as const)(
    "uses the registered source-root alias as a bounded link target (%s)",
    async (symlinkMode, follows) => {
      const root = await temporaryRoot();
      const alias = `${root}-registered-alias`;
      cleanup.push(alias);
      await writeFile(path.join(root, "inside.txt"), "inside");
      await symlink(root, alias, "dir");
      await symlink(
        path.join(alias, "inside.txt"),
        path.join(root, "absolute-registered-alias.txt"),
      );

      const snapshot = await observeRoot(alias, { symlinkMode });

      expect(snapshot.root).toBe(alias);
      expect(snapshot.files.map((file) => file.relativePath)).toEqual(
        follows
          ? ["absolute-registered-alias.txt", "inside.txt"]
          : ["inside.txt"],
      );
      expect(snapshot.diagnostics).toEqual(
        follows
          ? undefined
          : [
              {
                relativePath: "absolute-registered-alias.txt",
                kind: "symbolic-link-not-followed",
              },
            ],
      );
    },
  );

  it("keeps separately registered spellings of one canonical target as distinct logical locations", async () => {
    const source = await temporaryRoot();
    const target = await temporaryRoot();
    const firstAlias = `${target}-registered-first`;
    const secondAlias = `${target}-registered-second`;
    cleanup.push(firstAlias, secondAlias);
    await writeFile(path.join(target, "track.txt"), "target");
    await symlink(target, firstAlias, "dir");
    await symlink(target, secondAlias, "dir");
    await symlink(
      path.join(firstAlias, "track.txt"),
      path.join(source, "first-location.txt"),
    );
    await symlink(
      path.join(secondAlias, "track.txt"),
      path.join(source, "second-location.txt"),
    );

    const snapshot = await observeRoot(source, {
      symlinkMode: "follow-file-links",
      allowedTargetPaths: [firstAlias, secondAlias],
    });

    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "first-location.txt",
      "second-location.txt",
    ]);
    expect(snapshot.files.map((file) => file.objectIdentity)).toEqual([
      snapshot.files[0]?.objectIdentity,
      snapshot.files[0]?.objectIdentity,
    ]);
  });

  it.each([
    [
      "do-not-follow",
      [],
      ["symbolic-link-not-followed", "symbolic-link-not-followed"],
    ],
    [
      "follow-file-links",
      ["file-via-target-alias.txt"],
      ["directory-link-not-allowed"],
    ],
    [
      "follow-file-and-directory-links",
      [
        "directory-via-target-alias/folder/nested.txt",
        "directory-via-target-alias/track.txt",
        "file-via-target-alias.txt",
      ],
      [],
    ],
  ] as const)(
    "uses only the registered target-root alias in %s mode",
    async (symlinkMode, files, diagnosticKinds) => {
      const source = await temporaryRoot();
      const target = await temporaryRoot();
      const targetAlias = `${target}-registered-alias`;
      cleanup.push(targetAlias);
      await mkdir(path.join(target, "folder"));
      await writeFile(path.join(target, "track.txt"), "file target");
      await writeFile(
        path.join(target, "folder", "nested.txt"),
        "directory target",
      );
      await symlink(target, targetAlias, "dir");
      await symlink(
        path.join(targetAlias, "track.txt"),
        path.join(source, "file-via-target-alias.txt"),
      );
      await symlink(
        targetAlias,
        path.join(source, "directory-via-target-alias"),
        "dir",
      );

      const snapshot = await observeRoot(source, {
        symlinkMode,
        allowedTargetPaths: [targetAlias],
      });

      expect(snapshot.files.map((file) => file.relativePath)).toEqual(files);
      expect(
        snapshot.diagnostics?.map((diagnostic) => diagnostic.kind) ?? [],
      ).toEqual(diagnosticKinds);
    },
  );

  it("routes relative, canonical, and registered target spellings without admitting sibling aliases", async () => {
    const source = await temporaryRoot();
    const target = await temporaryRoot();
    const registeredAlias = `${target}-registered-alias`;
    const unregisteredAlias = `${target}-unregistered-alias`;
    const segmentCollision = `${registeredAlias}-collision`;
    cleanup.push(registeredAlias, unregisteredAlias, segmentCollision);
    await writeFile(path.join(source, "inside.txt"), "source");
    await writeFile(path.join(target, "evidence.txt"), "target");
    await symlink(target, registeredAlias, "dir");
    await symlink(target, unregisteredAlias, "dir");
    await symlink(target, segmentCollision, "dir");
    await symlink("inside.txt", path.join(source, "relative-in-root.txt"));
    await symlink(
      path.relative(source, path.join(target, "evidence.txt")),
      path.join(source, "relative-parent-target.txt"),
    );
    await symlink(
      path.join(target, "evidence.txt"),
      path.join(source, "absolute-canonical.txt"),
    );
    await symlink(
      path.join(registeredAlias, "evidence.txt"),
      path.join(source, "absolute-registered-alias.txt"),
    );
    await symlink(
      path.join(unregisteredAlias, "evidence.txt"),
      path.join(source, "absolute-unregistered-alias.txt"),
    );
    await symlink(
      path.join(segmentCollision, "evidence.txt"),
      path.join(source, "registered-prefix-collision.txt"),
    );

    const snapshot = await observeRoot(source, {
      symlinkMode: "follow-file-and-directory-links",
      allowedTargetPaths: [registeredAlias],
    });

    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "absolute-canonical.txt",
      "absolute-registered-alias.txt",
      "inside.txt",
      "relative-in-root.txt",
      "relative-parent-target.txt",
    ]);
    const targetAliases = snapshot.files.filter((file) =>
      [
        "absolute-canonical.txt",
        "absolute-registered-alias.txt",
        "relative-parent-target.txt",
      ].includes(file.relativePath),
    );
    expect(targetAliases.map((file) => file.objectIdentity)).toEqual([
      targetAliases[0]?.objectIdentity,
      targetAliases[0]?.objectIdentity,
      targetAliases[0]?.objectIdentity,
    ]);
    expect(snapshot.diagnostics).toEqual([
      {
        relativePath: "absolute-unregistered-alias.txt",
        kind: "link-target-outside-authorized-roots",
      },
      {
        relativePath: "registered-prefix-collision.txt",
        kind: "link-target-outside-authorized-roots",
      },
    ]);
  });
});
