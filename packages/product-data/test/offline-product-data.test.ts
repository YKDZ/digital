import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fileSystemFault = vi.hoisted(() => ({
  failStagingOpen: false,
  failRestoreStagingCleanup: false,
  failCopyWrite: false,
  failCopyDestinationClose: false,
  directoryOpenTarget: "",
  directoryOpenAttempts: 0,
  failSecondDirectoryOpen: false,
  directoryHandleTarget: "",
  directoryCloseTarget: "",
  failDirectoryReaddir: false,
  failDirectoryChmod: false,
  failDirectoryClose: false,
  failDirectoryFsync: false,
  failDirectorySyncClose: false,
  failRestoreMarkerWrite: false,
  failRestoreMarkerFileClose: false,
  armDirectoryFsyncAfterMarkerClose: false,
  directoryHandleDescriptors: new Set<number>(),
  directoryCloseAttempts: new Set<number>(),
  syncDirectoryDescriptors: new Set<number>(),
  restoreMarkerFileDescriptors: new Set<number>(),
  destinationFileDescriptors: new Set<number>(),
  sourceFileDescriptors: new Set<number>(),
  sourceFileCloseAttempts: new Set<number>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fileSystem = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    open: async (...arguments_: Parameters<typeof actual.open>) => {
      const [candidate, flags] = arguments_;
      const candidateName =
        typeof candidate === "string" ? path.basename(candidate) : "";
      if (
        fileSystemFault.failStagingOpen &&
        typeof candidate === "string" &&
        candidate.includes("/staging")
      ) {
        throw Object.assign(new Error("staging open failed"), { code: "EIO" });
      }
      if (
        candidateName === fileSystemFault.directoryOpenTarget &&
        candidateName.length > 0 &&
        typeof flags === "number" &&
        (flags & fileSystem.constants.O_DIRECTORY) !== 0
      ) {
        fileSystemFault.directoryOpenAttempts += 1;
        if (
          fileSystemFault.failSecondDirectoryOpen &&
          fileSystemFault.directoryOpenAttempts === 2
        ) {
          fileSystemFault.failSecondDirectoryOpen = false;
          throw Object.assign(new Error("destination child open failed"), {
            code: "EIO",
          });
        }
      }
      const handle = await actual.open(...arguments_);
      if (
        candidateName.length > 0 &&
        candidateName === fileSystemFault.directoryHandleTarget
      ) {
        const descriptor = handle.fd;
        fileSystemFault.directoryHandleDescriptors.add(descriptor);
        const chmod = handle.chmod.bind(handle);
        handle.chmod = async (...chmodArguments) => {
          if (fileSystemFault.failDirectoryChmod) {
            fileSystemFault.failDirectoryChmod = false;
            throw new Error("directory chmod failed");
          }
          return await chmod(...chmodArguments);
        };
      }
      if (
        candidateName.length > 0 &&
        candidateName ===
          (fileSystemFault.directoryCloseTarget ||
            fileSystemFault.directoryHandleTarget)
      ) {
        const descriptor = handle.fd;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          fileSystemFault.directoryCloseAttempts.add(descriptor);
          const result = await close();
          if (fileSystemFault.failDirectoryClose) {
            fileSystemFault.failDirectoryClose = false;
            throw new Error("directory close failed");
          }
          return result;
        };
      }
      if (
        typeof candidate === "string" &&
        candidate.endsWith("/catalogue.sqlite") &&
        typeof flags === "number"
      ) {
        const isDestination = (flags & fileSystem.constants.O_WRONLY) !== 0;
        if (isDestination)
          fileSystemFault.destinationFileDescriptors.add(handle.fd);
        else fileSystemFault.sourceFileDescriptors.add(handle.fd);
        const descriptor = handle.fd;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          if (!isDestination)
            fileSystemFault.sourceFileCloseAttempts.add(descriptor);
          const result = await close();
          if (isDestination && fileSystemFault.failCopyDestinationClose) {
            fileSystemFault.failCopyDestinationClose = false;
            throw new Error("destination file close failed");
          }
          return result;
        };
      }
      return handle;
    },
    readdir: async (...arguments_: Parameters<typeof actual.readdir>) => {
      const descriptor =
        typeof arguments_[0] === "string"
          ? Number(/\/proc\/self\/fd\/(\d+)/.exec(arguments_[0])?.[1])
          : Number.NaN;
      if (
        fileSystemFault.directoryHandleDescriptors.has(descriptor) &&
        fileSystemFault.failDirectoryReaddir
      ) {
        fileSystemFault.failDirectoryReaddir = false;
        throw new Error("directory readdir failed");
      }
      return await actual.readdir(...arguments_);
    },
    rm: async (...arguments_: Parameters<typeof actual.rm>) => {
      if (
        fileSystemFault.failRestoreStagingCleanup &&
        typeof arguments_[0] === "string" &&
        arguments_[0].includes("/proc/self/fd/") &&
        path.basename(arguments_[0]).startsWith("restore-")
      ) {
        throw new Error("staging cleanup failed");
      }
      return await actual.rm(...arguments_);
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...arguments_: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...arguments_);
      if (
        typeof arguments_[0] === "string" &&
        path.basename(arguments_[0]) === "runtime-state"
      ) {
        fileSystemFault.syncDirectoryDescriptors.add(descriptor);
      }
      if (
        typeof arguments_[0] === "string" &&
        arguments_[0].includes("offline-restore-in-progress.json.") &&
        arguments_[0].endsWith(".tmp")
      ) {
        fileSystemFault.restoreMarkerFileDescriptors.add(descriptor);
      }
      return descriptor;
    },
    fsyncSync: (descriptor: number) => {
      if (
        fileSystemFault.syncDirectoryDescriptors.has(descriptor) &&
        fileSystemFault.failDirectoryFsync
      ) {
        fileSystemFault.failDirectoryFsync = false;
        throw new Error("directory fsync failed");
      }
      return actual.fsyncSync(descriptor);
    },
    writeFileSync: (...arguments_: Parameters<typeof actual.writeFileSync>) => {
      if (
        typeof arguments_[0] === "number" &&
        fileSystemFault.restoreMarkerFileDescriptors.has(arguments_[0]) &&
        fileSystemFault.failRestoreMarkerWrite
      ) {
        fileSystemFault.failRestoreMarkerWrite = false;
        throw new Error("restore marker write failed");
      }
      return actual.writeFileSync(...arguments_);
    },
    closeSync: (descriptor: number) => {
      const isTarget =
        fileSystemFault.syncDirectoryDescriptors.delete(descriptor);
      const isRestoreMarker =
        fileSystemFault.restoreMarkerFileDescriptors.delete(descriptor);
      const result = actual.closeSync(descriptor);
      if (
        isRestoreMarker &&
        fileSystemFault.armDirectoryFsyncAfterMarkerClose
      ) {
        fileSystemFault.armDirectoryFsyncAfterMarkerClose = false;
        fileSystemFault.failDirectoryFsync = true;
        fileSystemFault.failDirectorySyncClose = true;
      }
      if (isRestoreMarker && fileSystemFault.failRestoreMarkerFileClose) {
        fileSystemFault.failRestoreMarkerFileClose = false;
        throw new Error("restore marker file close failed");
      }
      if (isTarget && fileSystemFault.failDirectorySyncClose) {
        fileSystemFault.failDirectorySyncClose = false;
        throw new Error("directory close failed");
      }
      return result;
    },
  };
});

import {
  ProductDataMaintenanceLifecycle,
  ProductDataOperations,
  createOfflineProductDataBackup as copyOfflineProductDataBackup,
  restoreOfflineProductDataBackup as copyOfflineProductDataRestore,
} from "../src/index.ts";

const temporaryRoots: string[] = [];
/**
 * 自有操作账本：被框架超时放弃的用例仍可能继续写入它自己的工作区。清理必须先等这些
 * Promise 真正结束，否则 `rm -r` 与复制交错，产生与备份语义无关的 ENOTEMPTY 次生失败。
 */
const inFlightOperations = new Set<Promise<void>>();

function trackProductDataOperation(operation: Promise<void>): Promise<void> {
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  inFlightOperations.add(settled);
  void settled.then(() => inFlightOperations.delete(settled));
  return operation;
}

function createOfflineProductDataBackup(
  input: Parameters<typeof copyOfflineProductDataBackup>[0],
): Promise<void> {
  return trackProductDataOperation(copyOfflineProductDataBackup(input));
}

function restoreOfflineProductDataBackup(
  input: Parameters<typeof copyOfflineProductDataRestore>[0],
): Promise<void> {
  return trackProductDataOperation(copyOfflineProductDataRestore(input));
}

/**
 * 清理必须等自有操作真正落盘后再删：被框架放弃的用例仍会继续写它自己的工作区，早先的
 * ENOTEMPTY 与 `Hook timed out` 都来自「仍在写入的根被并发 rm」这个顺序，而不是备份语义。
 */
afterEach(async () => {
  vi.restoreAllMocks();
  fileSystemFault.failStagingOpen = false;
  fileSystemFault.directoryOpenTarget = "";
  fileSystemFault.directoryOpenAttempts = 0;
  fileSystemFault.failSecondDirectoryOpen = false;
  fileSystemFault.directoryHandleTarget = "";
  fileSystemFault.directoryCloseTarget = "";
  fileSystemFault.failDirectoryReaddir = false;
  fileSystemFault.failDirectoryChmod = false;
  fileSystemFault.failDirectoryClose = false;
  fileSystemFault.failDirectoryFsync = false;
  fileSystemFault.failDirectorySyncClose = false;
  fileSystemFault.failRestoreMarkerWrite = false;
  fileSystemFault.failRestoreMarkerFileClose = false;
  fileSystemFault.armDirectoryFsyncAfterMarkerClose = false;
  fileSystemFault.directoryHandleDescriptors.clear();
  fileSystemFault.directoryCloseAttempts.clear();
  fileSystemFault.syncDirectoryDescriptors.clear();
  fileSystemFault.restoreMarkerFileDescriptors.clear();
  await Promise.allSettled(inFlightOperations);
  for (const root of temporaryRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("offline product-data layout", () => {
  it("保留备份主失败与维护租约释放失败", async () => {
    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(workspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    await mkdir(productDataDirectory);
    vi.spyOn(
      ProductDataMaintenanceLifecycle.prototype,
      "close",
    ).mockImplementation(() => {
      throw new Error("maintenance lease release failed");
    });

    await expect(
      createOfflineProductDataBackup({ productDataDirectory, backupDirectory }),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: "备份源缺少产品 Catalogue；拒绝创建不完整副本",
        }),
        expect.objectContaining({
          message: "maintenance lease release failed",
        }),
      ],
    });
  });

  it("fails closed during maintenance when a restore marker exists, without copying product data", async () => {
    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(workspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    await writeProductRoot(productDataDirectory);
    const marker = path.join(
      productDataDirectory,
      "runtime-state",
      "offline-restore-in-progress.json",
    );
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, '{"schema":"offline-restore-in-progress/1"}');

    await expect(
      createOfflineProductDataBackup({ productDataDirectory, backupDirectory }),
    ).rejects.toThrow("离线恢复曾中断");
    expect((await lstat(marker)).isFile()).toBe(true);
    await expect(lstat(backupDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains SQLite WAL/SHM and unknown durable root entries while excluding only disposable areas", async () => {
    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(workspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    await writeProductRoot(productDataDirectory);
    await mkdir(path.join(productDataDirectory, "future-durable-area"));
    await writeFile(
      path.join(productDataDirectory, "future-durable-area", "state"),
      "future durable state",
    );
    for (const area of ["cache", "runtime-state", "staging"]) {
      await mkdir(path.join(productDataDirectory, area));
      await writeFile(path.join(productDataDirectory, area, "discard"), area);
    }

    await createOfflineProductDataBackup({
      productDataDirectory,
      backupDirectory,
    });

    await expect(
      readFile(path.join(backupDirectory, "catalogue.sqlite-wal"), "utf8"),
    ).resolves.toBe("wal bytes");
    await expect(
      readFile(path.join(backupDirectory, "catalogue.sqlite-shm"), "utf8"),
    ).resolves.toBe("shm bytes");
    await expect(
      readFile(
        path.join(backupDirectory, "future-durable-area", "state"),
        "utf8",
      ),
    ).resolves.toBe("future durable state");
    for (const area of ["cache", "runtime-state", "staging"]) {
      await expect(
        lstat(path.join(backupDirectory, area)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("retries a partial FileHandle.write and publishes the exact copied size", async () => {
    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(workspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    await writeProductRoot(productDataDirectory);
    const probe = await open(
      path.join(productDataDirectory, "catalogue.sqlite"),
      "r",
    );
    const prototype = Object.getPrototypeOf(probe) as {
      write: (...arguments_: readonly unknown[]) => Promise<unknown>;
    };
    const originalWrite = prototype.write;
    let shortened = false;
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: FileHandle,
      ...arguments_
    ) {
      const length = arguments_[2];
      if (!shortened && typeof length === "number" && length > 1) {
        shortened = true;
        const partial = [...arguments_];
        partial[2] = length - 1;
        return await originalWrite.apply(this, partial);
      }
      return await originalWrite.apply(this, arguments_);
    });
    try {
      await createOfflineProductDataBackup({
        productDataDirectory,
        backupDirectory,
      });
    } finally {
      vi.restoreAllMocks();
      await probe.close();
    }
    expect(shortened).toBe(true);
    await expect(
      readFile(path.join(backupDirectory, "catalogue.sqlite")),
    ).resolves.toEqual(
      await readFile(path.join(productDataDirectory, "catalogue.sqlite")),
    );
  });

  it("fails rather than publishing a file when FileHandle.write reports zero bytes", async () => {
    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(workspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    await writeProductRoot(productDataDirectory);
    const probe = await open(
      path.join(productDataDirectory, "catalogue.sqlite"),
      "r",
    );
    const prototype = Object.getPrototypeOf(probe) as {
      write: (...arguments_: readonly unknown[]) => Promise<unknown>;
    };
    vi.spyOn(prototype, "write").mockResolvedValue({ bytesWritten: 0 });
    try {
      await expect(
        createOfflineProductDataBackup({
          productDataDirectory,
          backupDirectory,
        }),
      ).rejects.toThrow("复制短写");
    } finally {
      vi.restoreAllMocks();
      await probe.close();
    }
  });

  it("保留复制写入主失败和目标文件句柄收尾失败，并继续关闭源句柄", async () => {
    fileSystemFault.destinationFileDescriptors.clear();
    fileSystemFault.sourceFileDescriptors.clear();
    fileSystemFault.sourceFileCloseAttempts.clear();
    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(workspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    await writeProductRoot(productDataDirectory);
    const probe = await open(
      path.join(productDataDirectory, "catalogue.sqlite"),
      "r",
    );
    const prototype = Object.getPrototypeOf(probe) as {
      write: (...arguments_: readonly unknown[]) => Promise<unknown>;
    };
    const originalWrite = prototype.write;
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: FileHandle,
      ...arguments_
    ) {
      if (
        fileSystemFault.failCopyWrite &&
        fileSystemFault.destinationFileDescriptors.has(this.fd)
      ) {
        fileSystemFault.failCopyWrite = false;
        throw new Error("copy write failed");
      }
      return await originalWrite.apply(this, arguments_);
    });
    fileSystemFault.failCopyWrite = true;
    fileSystemFault.failCopyDestinationClose = true;
    try {
      await expect(
        createOfflineProductDataBackup({
          productDataDirectory,
          backupDirectory,
        }),
      ).rejects.toMatchObject({
        errors: [
          expect.objectContaining({ message: "copy write failed" }),
          expect.objectContaining({
            message: "destination file close failed",
          }),
        ],
      });
      expect(fileSystemFault.sourceFileDescriptors.size).toBeGreaterThan(0);
      for (const descriptor of fileSystemFault.sourceFileDescriptors)
        expect(fileSystemFault.sourceFileCloseAttempts.has(descriptor)).toBe(
          true,
        );
    } finally {
      fileSystemFault.failCopyWrite = false;
      fileSystemFault.failCopyDestinationClose = false;
      vi.restoreAllMocks();
      await probe.close();
      fileSystemFault.destinationFileDescriptors.clear();
      fileSystemFault.sourceFileDescriptors.clear();
      fileSystemFault.sourceFileCloseAttempts.clear();
    }
  });

  it("保留恢复暂存目录读取主失败和目录句柄收尾失败", async () => {
    fileSystemFault.directoryCloseAttempts.clear();
    fileSystemFault.directoryHandleTarget = "staging";
    fileSystemFault.failDirectoryReaddir = true;
    fileSystemFault.failDirectoryClose = true;
    const workspace = await temporaryRoot();
    const backupDirectory = path.join(workspace, "backup");
    const productDataDirectory = path.join(workspace, "product-data");
    await writeProductRoot(backupDirectory);
    let failure: unknown;
    try {
      await restoreOfflineProductDataBackup({
        backupDirectory,
        productDataDirectory,
        prepareProductionCatalogue: async () => undefined,
      });
    } catch (error) {
      failure = error;
    } finally {
      fileSystemFault.directoryHandleTarget = "";
      fileSystemFault.directoryCloseTarget = "";
      fileSystemFault.failDirectoryReaddir = false;
      fileSystemFault.failDirectoryClose = false;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({ message: "directory readdir failed" }),
        expect.objectContaining({ message: "directory close failed" }),
      ],
    });
    expect(fileSystemFault.directoryCloseAttempts.size).toBe(1);
  });

  it("保留恢复暂存目录权限主失败和目录句柄收尾失败", async () => {
    fileSystemFault.directoryCloseAttempts.clear();
    fileSystemFault.directoryHandleTarget = "staging";
    fileSystemFault.failDirectoryChmod = true;
    fileSystemFault.failDirectoryClose = true;
    const workspace = await temporaryRoot();
    const backupDirectory = path.join(workspace, "backup");
    const productDataDirectory = path.join(workspace, "product-data");
    await writeProductRoot(backupDirectory);
    let failure: unknown;
    try {
      await restoreOfflineProductDataBackup({
        backupDirectory,
        productDataDirectory,
        prepareProductionCatalogue: async () => undefined,
      });
    } catch (error) {
      failure = error;
    } finally {
      fileSystemFault.directoryHandleTarget = "";
      fileSystemFault.directoryCloseTarget = "";
      fileSystemFault.failDirectoryChmod = false;
      fileSystemFault.failDirectoryClose = false;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({ message: "directory chmod failed" }),
        expect.objectContaining({ message: "directory close failed" }),
      ],
    });
    expect(fileSystemFault.directoryCloseAttempts.size).toBe(1);
  });

  it("保留备份目标目录读取主失败和目录句柄收尾失败", async () => {
    fileSystemFault.directoryCloseAttempts.clear();
    fileSystemFault.directoryHandleTarget = "backup";
    fileSystemFault.failDirectoryReaddir = true;
    fileSystemFault.failDirectoryClose = true;
    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(workspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    await writeProductRoot(productDataDirectory);
    let failure: unknown;
    try {
      await createOfflineProductDataBackup({
        productDataDirectory,
        backupDirectory,
      });
    } catch (error) {
      failure = error;
    } finally {
      fileSystemFault.directoryHandleTarget = "";
      fileSystemFault.directoryCloseTarget = "";
      fileSystemFault.failDirectoryReaddir = false;
      fileSystemFault.failDirectoryClose = false;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({
          cause: expect.objectContaining({
            message: "directory readdir failed",
          }),
        }),
        expect.objectContaining({ message: "directory close failed" }),
      ],
    });
    expect(fileSystemFault.directoryCloseAttempts.size).toBe(1);
  });

  it("目标子目录打开失败后仍关闭已打开源句柄并保留两种失败", async () => {
    fileSystemFault.directoryOpenTarget = "copy-child";
    fileSystemFault.directoryOpenAttempts = 0;
    fileSystemFault.failSecondDirectoryOpen = true;
    fileSystemFault.directoryCloseTarget = "copy-child";
    fileSystemFault.directoryCloseAttempts.clear();
    fileSystemFault.failDirectoryClose = true;

    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(workspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    const child = path.join(productDataDirectory, "copy-child");
    await writeProductRoot(productDataDirectory);
    await mkdir(child);
    await writeFile(path.join(child, "durable-state"), "state");

    let failure: unknown;
    try {
      await createOfflineProductDataBackup({
        productDataDirectory,
        backupDirectory,
      });
    } catch (error) {
      failure = error;
    } finally {
      fileSystemFault.directoryOpenTarget = "";
      fileSystemFault.directoryOpenAttempts = 0;
      fileSystemFault.failSecondDirectoryOpen = false;
      fileSystemFault.directoryCloseTarget = "";
      fileSystemFault.failDirectoryClose = false;
    }

    expect(fileSystemFault.directoryCloseAttempts.size).toBe(1);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({
          message: "复制目标目录项无法安全打开",
        }),
        expect.objectContaining({ message: "directory close failed" }),
      ],
    });
  });

  it("保留备份目标初始化主失败和父目录句柄收尾失败", async () => {
    const workspace = await temporaryRoot();
    const sourceWorkspace = await temporaryRoot();
    const productDataDirectory = path.join(sourceWorkspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    await writeProductRoot(productDataDirectory);
    fileSystemFault.directoryHandleTarget = "backup";
    fileSystemFault.directoryCloseTarget = path.basename(workspace);
    fileSystemFault.failDirectoryReaddir = true;
    fileSystemFault.failDirectoryClose = true;
    let failure: unknown;
    try {
      await createOfflineProductDataBackup({
        productDataDirectory,
        backupDirectory,
      });
    } catch (error) {
      failure = error;
    } finally {
      fileSystemFault.directoryHandleTarget = "";
      fileSystemFault.directoryCloseTarget = "";
      fileSystemFault.failDirectoryReaddir = false;
      fileSystemFault.failDirectoryClose = false;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({
          cause: expect.objectContaining({
            message: "directory readdir failed",
          }),
        }),
        expect.objectContaining({ message: "directory close failed" }),
      ],
    });
    expect(fileSystemFault.directoryCloseAttempts.size).toBe(1);
  });

  it("保留产品根打开主失败和祖先目录句柄收尾失败", async () => {
    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(
      workspace,
      "staging",
      "product-data",
    );
    const backupDirectory = path.join(workspace, "backup");
    await writeProductRoot(productDataDirectory);
    fileSystemFault.directoryHandleTarget = path.basename(workspace);
    fileSystemFault.failDirectoryClose = true;
    fileSystemFault.failStagingOpen = true;
    let failure: unknown;
    try {
      await createOfflineProductDataBackup({
        productDataDirectory,
        backupDirectory,
      });
    } catch (error) {
      failure = error;
    } finally {
      fileSystemFault.directoryHandleTarget = "";
      fileSystemFault.directoryCloseTarget = "";
      fileSystemFault.failDirectoryClose = false;
      fileSystemFault.failStagingOpen = false;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({
          message: "备份源产品数据目录无法安全打开",
          cause: expect.objectContaining({ message: "staging open failed" }),
        }),
        expect.objectContaining({ message: "directory close failed" }),
      ],
    });
    expect(fileSystemFault.directoryCloseAttempts.size).toBe(1);
  });

  it("保留恢复标记目录同步主失败和文件描述符收尾失败", async () => {
    fileSystemFault.syncDirectoryDescriptors.clear();
    fileSystemFault.armDirectoryFsyncAfterMarkerClose = true;
    const workspace = await temporaryRoot();
    const backupDirectory = path.join(workspace, "backup");
    const productDataDirectory = path.join(workspace, "product-data");
    await writeProductRoot(backupDirectory);
    let failure: unknown;
    try {
      await restoreOfflineProductDataBackup({
        backupDirectory,
        productDataDirectory,
        prepareProductionCatalogue: async () => undefined,
      });
    } catch (error) {
      failure = error;
    } finally {
      fileSystemFault.failDirectoryFsync = false;
      fileSystemFault.failDirectorySyncClose = false;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({ message: "directory fsync failed" }),
        expect.objectContaining({ message: "directory close failed" }),
      ],
    });
    const marker = path.join(
      productDataDirectory,
      "runtime-state",
      "offline-restore-in-progress.json",
    );
    expect((await lstat(marker)).isFile()).toBe(true);
    expect(() =>
      ProductDataOperations.forRoot(productDataDirectory).startWriter(),
    ).toThrow("离线恢复曾中断");
  });

  it("保留恢复标记写入主失败和文件句柄收尾失败", async () => {
    fileSystemFault.restoreMarkerFileDescriptors.clear();
    fileSystemFault.failRestoreMarkerWrite = true;
    fileSystemFault.failRestoreMarkerFileClose = true;
    const workspace = await temporaryRoot();
    const backupDirectory = path.join(workspace, "backup");
    const productDataDirectory = path.join(workspace, "product-data");
    await writeProductRoot(backupDirectory);
    let failure: unknown;
    try {
      await restoreOfflineProductDataBackup({
        backupDirectory,
        productDataDirectory,
        prepareProductionCatalogue: async () => undefined,
      });
    } catch (error) {
      failure = error;
    } finally {
      fileSystemFault.failRestoreMarkerWrite = false;
      fileSystemFault.failRestoreMarkerFileClose = false;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({ message: "restore marker write failed" }),
        expect.objectContaining({
          message: "restore marker file close failed",
        }),
      ],
    });
    const marker = path.join(
      productDataDirectory,
      "runtime-state",
      "offline-restore-in-progress.json",
    );
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepares a private staging root then publishes after a successful migration", async () => {
    const workspace = await temporaryRoot();
    const backupDirectory = path.join(workspace, "backup");
    const productDataDirectory = path.join(workspace, "product-data");
    await writeProductRoot(backupDirectory);
    const secretPath = path.join(
      backupDirectory,
      "private-source-connections",
      "source.json",
    );
    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(secretPath, "secret bytes");
    await chmod(secretPath, 0o600);
    let preparedAt: string | undefined;

    await restoreOfflineProductDataBackup({
      backupDirectory,
      productDataDirectory,
      prepareProductionCatalogue: async (stage) =>
        await stage.withDirectory(async (stagingDirectory) => {
          preparedAt = stagingDirectory;
          expect(() =>
            ProductDataOperations.forRoot(productDataDirectory).startWriter(),
          ).toThrow("产品正在维护");
          await writeFile(
            path.join(stagingDirectory, "migration-proof"),
            "ready",
          );
        }),
    });

    expect(preparedAt).not.toBe(productDataDirectory);
    await expect(
      readFile(path.join(productDataDirectory, "migration-proof"), "utf8"),
    ).resolves.toBe("ready");
    await expect(readFile(secretPathAfterRestore(), "utf8")).resolves.toBe(
      "secret bytes",
    );
    expect((await lstat(secretPathAfterRestore())).mode & 0o777).toBe(0o600);
    expect((await lstat(productDataDirectory)).mode & 0o777).toBe(0o700);
    expect(
      (await readdir(workspace)).some((name) => name.includes("restore-")),
    ).toBe(false);

    function secretPathAfterRestore(): string {
      return path.join(
        productDataDirectory,
        "private-source-connections",
        "source.json",
      );
    }
  });

  it("marks an interrupted restore fail-closed until the maintainer recreates an empty target", async () => {
    const workspace = await temporaryRoot();
    const backupDirectory = path.join(workspace, "backup");
    const productDataDirectory = path.join(workspace, "product-data");
    await writeProductRoot(backupDirectory);

    await expect(
      restoreOfflineProductDataBackup({
        backupDirectory,
        productDataDirectory,
        prepareProductionCatalogue: async () => {
          throw new Error("migration failed");
        },
      }),
    ).rejects.toThrow("migration failed");
    await expect(readdir(productDataDirectory)).resolves.toEqual([
      "runtime-state",
      "staging",
    ]);
    expect(
      (await readdir(workspace)).some((name) => name.includes("restore-")),
    ).toBe(false);

    await expect(
      restoreOfflineProductDataBackup({
        backupDirectory,
        productDataDirectory,
        prepareProductionCatalogue: async () => undefined,
      }),
    ).rejects.toThrow("离线恢复曾中断");
    expect(() =>
      ProductDataOperations.forRoot(productDataDirectory).startWriter(),
    ).toThrow("离线恢复曾中断");
    await rm(productDataDirectory, { recursive: true, force: true });
    await mkdir(productDataDirectory, { recursive: true });
    await restoreOfflineProductDataBackup({
      backupDirectory,
      productDataDirectory,
      prepareProductionCatalogue: async () => undefined,
    });
    await expect(
      readFile(path.join(productDataDirectory, "catalogue.sqlite"), "utf8"),
    ).resolves.toBe("catalogue bytes");
  });

  it("保留恢复主失败与暂存清理失败，并继续以中断标记阻止写入", async () => {
    const workspace = await temporaryRoot();
    const backupDirectory = path.join(workspace, "backup");
    const productDataDirectory = path.join(workspace, "product-data");
    await writeProductRoot(backupDirectory);
    fileSystemFault.failRestoreStagingCleanup = true;
    let failure: unknown;
    try {
      await restoreOfflineProductDataBackup({
        backupDirectory,
        productDataDirectory,
        prepareProductionCatalogue: async () => {
          throw new Error("production migration failed");
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      fileSystemFault.failRestoreStagingCleanup = false;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: "离线恢复主操作失败，且 1 项收尾失败；所有失败均已保留",
      errors: [
        expect.objectContaining({ message: "production migration failed" }),
        expect.objectContaining({ message: "staging cleanup failed" }),
      ],
    });
    const marker = path.join(
      productDataDirectory,
      "runtime-state",
      "offline-restore-in-progress.json",
    );
    expect((await lstat(marker)).isFile()).toBe(true);
    expect(() =>
      ProductDataOperations.forRoot(productDataDirectory).startWriter(),
    ).toThrow("离线恢复曾中断");
  });

  it("releases maintenance when staging initialization fails so a later writer can acquire the root", async () => {
    const workspace = await temporaryRoot();
    const backupDirectory = path.join(workspace, "backup");
    const productDataDirectory = path.join(workspace, "product-data");
    await writeProductRoot(backupDirectory);
    await mkdir(productDataDirectory, { recursive: true });
    fileSystemFault.failStagingOpen = true;
    try {
      await expect(
        restoreOfflineProductDataBackup({
          backupDirectory,
          productDataDirectory,
          prepareProductionCatalogue: async () => undefined,
        }),
      ).rejects.toThrow("复制目标目录项无法安全打开");
    } finally {
      fileSystemFault.failStagingOpen = false;
    }

    expect(() =>
      ProductDataOperations.forRoot(productDataDirectory).startWriter(),
    ).toThrow("离线恢复曾中断");
  });

  it("fails closed when a migration callback renames the stage and rebinds it through a symlink", async () => {
    const workspace = await temporaryRoot();
    const backupDirectory = path.join(workspace, "backup");
    const productDataDirectory = path.join(workspace, "product-data");
    const diverted = path.join(workspace, "diverted");
    await writeProductRoot(backupDirectory);
    await mkdir(diverted);

    await expect(
      restoreOfflineProductDataBackup({
        backupDirectory,
        productDataDirectory,
        prepareProductionCatalogue: async (stage) =>
          await stage.withDirectory(async (stageDirectory) => {
            // 模拟恶意回调刻意解析描述符链接后重绑原有暂存名。
            const namedStage = await readlink(stageDirectory);
            const moved = `${namedStage}-moved`;
            await rename(namedStage, moved);
            await symlink(diverted, namedStage);
          }),
      }),
    ).rejects.toThrow("迁移回调改变了暂存目录；拒绝发布");
    await expect(readdir(productDataDirectory)).resolves.toEqual([
      "runtime-state",
      "staging",
    ]);
    await expect(
      lstat(path.join(diverted, "catalogue.sqlite")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed for source, destination, and nested product-data symlinks", async () => {
    const workspace = await temporaryRoot();
    const productDataDirectory = path.join(workspace, "product-data");
    const backupDirectory = path.join(workspace, "backup");
    const outside = path.join(workspace, "outside");
    await writeProductRoot(productDataDirectory);
    await mkdir(outside);
    await writeFile(path.join(outside, "never-copy"), "outside bytes");
    await symlink(outside, path.join(productDataDirectory, "linked-state"));

    await expect(
      createOfflineProductDataBackup({ productDataDirectory, backupDirectory }),
    ).rejects.toThrow("产品数据包含符号链接");
    await expect(
      lstat(path.join(backupDirectory, "linked-state")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const cleanBackup = path.join(workspace, "clean-backup");
    await writeProductRoot(cleanBackup);
    const linkedDestination = path.join(workspace, "linked-destination");
    await symlink(outside, linkedDestination);
    await expect(
      restoreOfflineProductDataBackup({
        backupDirectory: cleanBackup,
        productDataDirectory: linkedDestination,
        prepareProductionCatalogue: async () => undefined,
      }),
    ).rejects.toThrow("路径祖先不能是符号链接");
    await expect(
      readFile(path.join(outside, "never-copy"), "utf8"),
    ).resolves.toBe("outside bytes");

    const ancestorAlias = path.join(workspace, "ancestor-alias");
    const cleanSource = path.join(workspace, "clean-source");
    await writeProductRoot(cleanSource);
    await symlink(workspace, ancestorAlias);
    await expect(
      createOfflineProductDataBackup({
        productDataDirectory: path.join(ancestorAlias, "clean-source"),
        backupDirectory: path.join(workspace, "ancestor-alias-backup"),
      }),
    ).rejects.toThrow("路径祖先不能是符号链接");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "completion-07-offline-layout-"),
  );
  temporaryRoots.push(root);
  return root;
}

async function writeProductRoot(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "catalogue.sqlite"), "catalogue bytes");
  await writeFile(path.join(directory, "catalogue.sqlite-wal"), "wal bytes");
  await writeFile(path.join(directory, "catalogue.sqlite-shm"), "shm bytes");
}
