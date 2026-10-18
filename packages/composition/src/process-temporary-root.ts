import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ProcessTemporaryRootOwner = {
  readonly directory: string;
  close(): Promise<void>;
  closeAfterSuccessful<Result>(operation: Promise<Result>): Promise<Result>;
};

/**
 * 可执行 bootstrap 的低层资源算法。这个精确 subpath 不装入产品 runtime，且不进入
 * ProductConfiguration/runProduct；调用者仍独占进程级 owner 的创建与最终释放时机。
 */
export async function claimProcessTemporaryRoot(
  environment: NodeJS.ProcessEnv,
  options: {
    readonly prefix:
      | "digital-cli-process-"
      | "digital-web-process-"
      | "digital-product-service-process-";
    readonly parentDirectory?: string;
  },
): Promise<ProcessTemporaryRootOwner> {
  const hadPrevious = Object.hasOwn(environment, "TMPDIR");
  const previous = environment.TMPDIR;
  const directory = await mkdtemp(
    path.join(options.parentDirectory ?? tmpdir(), options.prefix),
  );
  let identity: Awaited<ReturnType<typeof lstat>>;
  try {
    await chmod(directory, 0o700);
    identity = await lstat(directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  environment.TMPDIR = directory;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const current = await lstat(directory);
      if (current.dev !== identity.dev || current.ino !== identity.ino)
        throw new Error("进程临时根身份已改变，拒绝删除");
      await rm(directory, { recursive: true });
      if (environment.TMPDIR === directory) {
        if (hadPrevious) environment.TMPDIR = previous;
        else delete environment.TMPDIR;
      }
    })();
    return closing;
  };
  return {
    directory,
    close,
    async closeAfterSuccessful<Result>(operation: Promise<Result>) {
      const result = await operation;
      await close();
      return result;
    },
  };
}
