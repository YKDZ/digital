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

const fileSystemFault = vi.hoisted(() => ({ failStagingOpen: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...arguments_: Parameters<typeof actual.open>) => {
      if (
        fileSystemFault.failStagingOpen &&
        typeof arguments_[0] === "string" &&
        arguments_[0].includes("/staging")
      ) {
        throw Object.assign(new Error("staging open failed"), { code: "EIO" });
      }
      return await actual.open(...arguments_);
    },
  };
});

import {
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
  await Promise.allSettled(inFlightOperations);
  for (const root of temporaryRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("offline product-data layout", () => {
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
