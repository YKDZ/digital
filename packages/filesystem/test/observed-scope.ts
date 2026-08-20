import { ReadOnlyFilesystemObserver } from "../src/index.ts";

export type TestSymlinkMode =
  | "do-not-follow"
  | "follow-file-links"
  | "follow-file-and-directory-links";

export async function bindObservedScope(
  rootPath: string,
  input: {
    readonly symlinkMode?: TestSymlinkMode;
    readonly allowedTargetPaths?: readonly string[];
    readonly relativeScope?: string;
  } = {},
  filesystem = new ReadOnlyFilesystemObserver(),
) {
  const root = await filesystem.inspectReadableDirectory(rootPath);
  const targets = await Promise.all(
    (input.allowedTargetPaths ?? []).map(async (candidate, index) => {
      const inspected = await filesystem.inspectReadableDirectory(candidate);
      return {
        id: `test-target-${index}`,
        configVersion: 1,
        containerPath: inspected.absolutePath,
        canonicalPath: inspected.canonicalPath,
      };
    }),
  );
  const scope = await filesystem.bindScope({
    root: {
      version: "observed-root-snapshot/1",
      id: "test-root",
      configVersion: 1,
      containerPath: root.absolutePath,
      canonicalPath: root.canonicalPath,
      readOnly: true,
      symlinkMode: input.symlinkMode ?? "do-not-follow",
      allowedTargetRootIds: targets.map((target) => target.id),
      ...(targets.length === 0 ? {} : { authorizedTargetRoots: targets }),
    },
    relativeScope: input.relativeScope ?? ".",
  });
  return { filesystem, scope };
}

export async function observeRoot(
  rootPath: string,
  input: {
    readonly symlinkMode?: TestSymlinkMode;
    readonly allowedTargetPaths?: readonly string[];
    readonly relativeScope?: string;
  } = {},
) {
  const { filesystem, scope } = await bindObservedScope(rootPath, input);
  try {
    return await filesystem.observe(scope);
  } finally {
    await filesystem.closeScope(scope);
  }
}
