import type { ReadOnlyFilesystemObserver } from "./index.ts";

/** 仅供文件系统契约测试在 lstat 后制造确定性竞态。 */
export type FilesystemObservationTestHooks = {
  afterEntryLstat?(input: {
    readonly relativePath: string;
  }): void | Promise<void>;
};

const hooksByObserver = new WeakMap<
  ReadOnlyFilesystemObserver,
  FilesystemObservationTestHooks
>();

/** 这个内部 seam 不属于 @digital/filesystem 的生产包根接口。 */
export function installFilesystemObservationTestHooks(
  observer: ReadOnlyFilesystemObserver,
  hooks: FilesystemObservationTestHooks,
): ReadOnlyFilesystemObserver {
  hooksByObserver.set(observer, hooks);
  return observer;
}

export function filesystemObservationTestHooksFor(
  observer: ReadOnlyFilesystemObserver,
): FilesystemObservationTestHooks | undefined {
  return hooksByObserver.get(observer);
}
