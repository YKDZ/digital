import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  chown,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { ProductConfiguration } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import { createPublicApiClient } from "@digital/public-api";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
  resolveSourceIoFromEnvironment,
} from "@digital/test-support/source-io";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { createProductService } from "../src/service.ts";
import { interactiveTerminalEnvironment } from "./interactive-terminal.ts";

const openServers: Array<Awaited<ReturnType<typeof serve>>> = [];
const bootstraps: Array<Awaited<ReturnType<typeof createProductService>>> = [];
const temporaryRoots: string[] = [];
const terminalChildren: Array<ReturnType<typeof spawn>> = [];
const servicePackageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureMaterialDirectory = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/material"),
);
const fixtureManifestPath = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/manifest.json"),
);

afterEach(async () => {
  for (const child of terminalChildren.splice(0).reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
    }
  }
  for (const server of openServers.splice(0).reverse())
    await server.close(true);
  for (const bootstrap of bootstraps.splice(0).reverse())
    await bootstrap.abort();
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("serves empty libraries, assets and unrecognized pages over the real HTTP/SQLite path", async () => {
  const baseUrl = await startEmptyProductService();

  const ready = await eventuallyReady(baseUrl);
  expect(ready).toBe(true);
  const client = createPublicApiClient({ baseUrl });
  const [libraries, assets, unrecognized] = await Promise.all([
    client.listAssetLibraries(),
    client.listAssets({ limit: 20 }),
    client.listUnrecognizedMaterials({ limit: 20 }),
  ]);
  expect(libraries.items).toEqual([]);
  expect(assets.items).toEqual([]);
  expect(unrecognized.items).toEqual([]);

  const invalidLibraryCursor = await fetch(
    new URL("/api/v1/asset-libraries?cursor=not-a-cursor", baseUrl),
  );
  expect(invalidLibraryCursor.status).toBe(400);
  await expect(invalidLibraryCursor.json()).resolves.toMatchObject({
    error: { code: "invalid-request" },
  });
  const emptyLibraryCursor = await fetch(
    new URL("/api/v1/asset-libraries?cursor=", baseUrl),
  );
  expect(emptyLibraryCursor.status).toBe(400);
  await expect(emptyLibraryCursor.json()).resolves.toMatchObject({
    error: { code: "invalid-request" },
  });
  const invalidPageCursorResponses = await Promise.all(
    ["assets", "unrecognized-materials"].map((endpoint) =>
      fetch(new URL(`/api/v1/${endpoint}?cursor=not-a-cursor`, baseUrl)),
    ),
  );
  expect(invalidPageCursorResponses.map(({ status }) => status)).toEqual([
    400, 400,
  ]);
  for (const response of invalidPageCursorResponses)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid-request" },
    });

  const invalid = await fetch(new URL("/api/v1/assets?limit=0", baseUrl));
  expect(invalid.status).toBe(400);
  await expect(invalid.json()).resolves.toMatchObject({
    error: { code: "invalid-request" },
  });

  const missingLibrary = await fetch(
    new URL("/api/v1/assets?assetLibraryId=missing", baseUrl),
  );
  expect(missingLibrary.status).toBe(404);
  await expect(missingLibrary.json()).resolves.toMatchObject({
    error: { code: "not-found" },
  });

  const invalidUnrecognized = await fetch(
    new URL("/api/v1/unrecognized-materials?limit=0", baseUrl),
  );
  expect(invalidUnrecognized.status).toBe(400);
  await expect(invalidUnrecognized.json()).resolves.toMatchObject({
    error: { code: "invalid-request" },
  });

  const missingUnrecognizedLibrary = await fetch(
    new URL("/api/v1/unrecognized-materials?assetLibraryId=missing", baseUrl),
  );
  expect(missingUnrecognizedLibrary.status).toBe(404);
  await expect(missingUnrecognizedLibrary.json()).resolves.toMatchObject({
    error: { code: "not-found" },
  });
});

it("通过公开客户端创建、修改、移除用户命名的多目录资产库并读回持久配置", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc06-library-http-"));
  temporaryRoots.push(root);
  const firstDirectory = path.join(root, "收藏", "声音", "2025");
  const secondDirectory = path.join(root, "收藏", "声音", "2026");
  const thirdDirectory = path.join(root, "另一个书架");
  await Promise.all(
    [firstDirectory, secondDirectory, thirdDirectory].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const baseUrl = await startEmptyProductService();
  const client = createPublicApiClient({ baseUrl });

  const options = await client.listAssetLibraryOptions();
  expect(options.recognitionProfiles.map(({ id }) => id)).toContain(
    "dlsite-voice",
  );
  expect(options.sources.map(({ id }) => id)).toContain("dlsite");
  await expect(
    client.saveAssetLibrary({
      displayName: "错误目录配置",
      directories: [path.join(root, "尚不存在的目录")],
      recognitionProfileIds: ["dlsite-voice"],
      sourceIdentities: ["dlsite"],
    }),
  ).rejects.toMatchObject({
    kind: "invalid-request",
    status: 400,
    message: "文件位置必须是当前可读的目录",
  });
  await expect(client.listAssetLibraries()).resolves.toMatchObject({
    items: [],
  });
  const created = await client.saveAssetLibrary({
    displayName: "我的中文声音库",
    directories: [firstDirectory, secondDirectory],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  expect(created).toMatchObject({
    displayName: "我的中文声音库",
    configVersion: 1,
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  expect(created.directories.map(({ path }) => path).toSorted()).toEqual(
    [firstDirectory, secondDirectory].toSorted(),
  );
  expect(created.directories.every(({ status }) => status === "active")).toBe(
    true,
  );

  const updated = await client.saveAssetLibrary({
    id: created.id,
    expectedVersion: created.configVersion,
    displayName: "我的更新声音库",
    directories: [firstDirectory, thirdDirectory],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: [],
  });
  expect(updated).toMatchObject({
    id: created.id,
    displayName: "我的更新声音库",
    configVersion: 2,
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: [],
  });
  expect(
    updated.directories
      .filter(({ status }) => status === "active")
      .map(({ path }) => path)
      .toSorted(),
  ).toEqual([firstDirectory, thirdDirectory].toSorted());
  expect(updated.directories).toContainEqual(
    expect.objectContaining({ path: secondDirectory, status: "removed" }),
  );
  await expect(client.listAssetLibraries()).resolves.toMatchObject({
    items: [updated],
  });
  await expect(
    client.saveAssetLibrary({
      id: "missing-asset-library",
      expectedVersion: 1,
      displayName: "缺失库不能修改",
      directories: [firstDirectory],
      recognitionProfileIds: ["dlsite-voice"],
      sourceIdentities: ["dlsite"],
    }),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });
  await expect(
    client.removeAssetLibrary({
      id: "missing-asset-library",
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });
  await expect(
    client.saveAssetLibrary({
      id: created.id,
      expectedVersion: created.configVersion,
      displayName: "过期配置不能覆盖新版本",
      directories: [firstDirectory],
      recognitionProfileIds: ["dlsite-voice"],
      sourceIdentities: ["dlsite"],
    }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });

  await client.removeAssetLibrary({
    id: updated.id,
    expectedVersion: updated.configVersion,
  });
  await expect(client.listAssetLibraries()).resolves.toMatchObject({
    items: [],
  });
}, 30_000);

it("把 SQLite 写入故障作为服务不可用返回，不向用户泄露存储错误", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "ewc06-library-storage-error-"),
  );
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialDirectory = path.join(root, "源材料");
  await mkdir(materialDirectory, { recursive: true });
  await prepareProductionCatalogue({ productDataDirectory });
  const service = await startProductServiceWithData(
    productDataDirectory,
    undefined,
  );
  const database = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  try {
    database.exec(`
      CREATE TRIGGER ewc06_reject_asset_library_insert
      BEFORE INSERT ON asset_libraries
      BEGIN
        SELECT RAISE(ABORT, 'ewc06 storage write failure');
      END;
    `);
  } finally {
    database.close();
  }

  const response = await fetch(
    new URL("/api/v1/asset-libraries", service.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "存储错误验证库",
        directories: [materialDirectory],
        recognitionProfileIds: ["dlsite-voice"],
        sourceIdentities: ["dlsite"],
      }),
    },
  );
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    error: {
      code: "unavailable",
      message: "资产库操作暂时不可用，请稍后重试",
    },
  });
});

it("查询缺失目录与撤销的访问权限，并在扫描结果中保留具体失败原因", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc06-directory-errors-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const missingDirectory = path.join(root, "已不可用");
  const revokedDirectory = path.join(root, "权限已撤销");
  const inaccessibleDirectory = path.join(root, "暂不可读");
  await Promise.all(
    [missingDirectory, revokedDirectory, inaccessibleDirectory].map(
      (directory) => mkdir(directory, { recursive: true }),
    ),
  );
  await writeFile(path.join(missingDirectory, "说明.txt"), "之后移除\n");
  await writeFile(path.join(revokedDirectory, "说明.txt"), "之后撤销权限\n");
  await writeFile(path.join(inaccessibleDirectory, "说明.txt"), "无权限读取\n");
  if (process.platform !== "win32") await chmod(inaccessibleDirectory, 0o000);

  const serviceUser =
    process.platform !== "win32" && process.getuid?.() === 0
      ? { uid: 65_534, gid: 65_534 }
      : undefined;
  if (serviceUser !== undefined) await chmod(root, 0o755);
  const baseUrl = await startInstalledProductService({
    productDataDirectory,
    manifestPath: fixtureManifestPath,
    port: await reserveEwc06Port(),
    ...(serviceUser === undefined ? {} : { serviceUser }),
  });
  const client = createPublicApiClient({ baseUrl });
  if (process.platform !== "win32") {
    try {
      const inaccessible = await fetch(
        new URL("/api/v1/asset-libraries", baseUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            displayName: "不可读目录不能保存",
            directories: [inaccessibleDirectory],
            recognitionProfileIds: ["dlsite-voice"],
            sourceIdentities: ["dlsite"],
          }),
        },
      );
      expect(inaccessible.status).toBe(400);
      await expect(inaccessible.json()).resolves.toEqual({
        error: {
          code: "invalid-request",
          message: "文件位置必须是当前可读的目录",
        },
      });
    } finally {
      await chmod(inaccessibleDirectory, 0o755);
    }
  }
  const library = await client.saveAssetLibrary({
    displayName: "目录故障观察",
    directories: [missingDirectory, revokedDirectory],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  await rm(missingDirectory, { recursive: true });
  await chmod(revokedDirectory, 0o000);
  try {
    const listed = await client.listAssetLibraries();
    const states = new Map(
      listed.items[0]!.directories.map((directory) => [
        directory.path,
        directory,
      ]),
    );
    expect(states.get(missingDirectory)).toMatchObject({
      reachable: false,
      problem: expect.stringContaining("文件位置当前缺失、不可读"),
    });
    expect(states.get(revokedDirectory)).toMatchObject({
      reachable: false,
      problem: expect.stringContaining("文件位置当前缺失、不可读"),
    });

    const { parentExecutionId } = await client.startAssetLibraryScan(
      library.id,
    );
    await expect
      .poll(
        async () =>
          (await client.inspectAssetLibraryScan(parentExecutionId)).status,
        { timeout: 30_000 },
      )
      .not.toBe("running");
    const scan = await client.inspectAssetLibraryScan(parentExecutionId);
    expect(scan).toMatchObject({ status: "failed", outcome: "failed" });
    expect(scan.directories).toHaveLength(2);
    for (const directory of scan.directories) {
      expect(directory.outcome).toBe("failed");
      expect(directory.reason).toContain(
        "冻结文件位置当前不可用，无法安全继续",
      );
    }
  } finally {
    await chmod(revokedDirectory, 0o755);
  }
}, 90_000);

it("从普通父目录发现多部作品、处理中间目录和未知材料，并以增量扫描保留身份", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc06-library-scan-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialRoot = path.join(root, "我的收藏");
  const workDirectories = [
    ["RJ01029383", path.join(materialRoot, "作者甲", "2024", "RJ01029383")],
    [
      "RJ01196709",
      path.join(materialRoot, "作者乙", "2025", "已归档", "RJ01196709"),
    ],
    ["RJ01497788", path.join(materialRoot, "作者丙", "新作", "RJ01497788")],
  ] as const;
  await Promise.all(
    workDirectories.map(([, directory]) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  for (const [workName, directory] of workDirectories)
    await cp(path.join(fixtureMaterialDirectory, workName), directory, {
      recursive: true,
    });
  const notesDirectory = path.join(materialRoot, "普通文件夹", "杂项");
  await mkdir(notesDirectory, { recursive: true });
  await writeFile(
    path.join(notesDirectory, "材料列表.txt"),
    "用户自己的说明\n",
  );
  await prepareProductionCatalogue({ productDataDirectory });
  const controlled = await loadControlledSourceIo({
    manifestPath: fixtureManifestPath,
  });
  const sourceIo = {
    mode: "controlled" as const,
    request: controlled.request,
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  let service = await startProductServiceWithData(
    productDataDirectory,
    sourceIo,
  );
  let client = createPublicApiClient({ baseUrl: service.baseUrl });
  const created = await client.saveAssetLibrary({
    displayName: "普通目录声音库",
    directories: [materialRoot],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  expect(created.directories.map(({ path }) => path)).toContain(materialRoot);
  const preparedMaterialDigest = await digestDirectories([materialRoot]);

  const scan = async () => {
    const started = await client.startAssetLibraryScan(created.id);
    await expect
      .poll(
        async () =>
          (await client.inspectAssetLibraryScan(started.parentExecutionId))
            .status,
        { timeout: 120_000 },
      )
      .toBe("completed");
    return await client.inspectAssetLibraryScan(started.parentExecutionId);
  };
  const firstScan = await scan();
  expect(await digestDirectories([materialRoot])).toBe(preparedMaterialDigest);
  expect(firstScan).toMatchObject({
    assetLibraryId: created.id,
    status: "completed",
  });
  expect(firstScan.directories).toHaveLength(1);
  const firstUnrecognized = await client.listUnrecognizedMaterials({
    assetLibraryId: created.id,
    limit: 100,
  });
  expect(
    firstUnrecognized.items.some((item) =>
      item.relativePaths.some((relativePath) =>
        relativePath.includes("材料列表.txt"),
      ),
    ),
  ).toBe(true);

  const firstAssets: Awaited<
    ReturnType<typeof client.listAssets>
  >["items"][number][] = [];
  let assetCursor: string | undefined;
  do {
    const page = await client.listAssets({
      assetLibraryId: created.id,
      limit: 100,
      ...(assetCursor === undefined ? {} : { cursor: assetCursor }),
    });
    firstAssets.push(...page.items);
    assetCursor = page.nextCursor;
  } while (assetCursor !== undefined);
  const firstAssetByWork = new Map<string, string>();
  for (const [workName] of workDirectories) {
    const matching = firstAssets.filter((asset) =>
      asset.locations.some(({ address }) => address.includes(`/${workName}/`)),
    );
    expect(
      matching,
      `普通父目录中应发现 ${workName} 对应的实际作品`,
    ).toHaveLength(1);
    firstAssetByWork.set(workName, matching[0]!.id);
  }
  expect(new Set(firstAssetByWork.values()).size).toBe(3);
  for (const [workName, assetId] of firstAssetByWork) {
    expect(
      firstScan.directories[0]!.files.some(
        (file) =>
          file.assetId === assetId &&
          file.relativePaths.some((relativePath) =>
            relativePath.includes(workName),
          ),
      ),
    ).toBe(true);
  }

  const addedWorkName = "RJ01115164";
  const addedWorkDirectory = path.join(
    materialRoot,
    "作者丁",
    "2026",
    addedWorkName,
  );
  const beforeAddingMaterialDigest = await digestDirectories([materialRoot]);
  await mkdir(path.dirname(addedWorkDirectory), { recursive: true });
  await cp(
    path.join(fixtureMaterialDirectory, addedWorkName),
    addedWorkDirectory,
    {
      recursive: true,
    },
  );
  const afterAddingMaterialDigest = await digestDirectories([materialRoot]);
  expect(afterAddingMaterialDigest).not.toBe(beforeAddingMaterialDigest);
  const secondScan = await scan();
  expect(await digestDirectories([materialRoot])).toBe(
    afterAddingMaterialDigest,
  );
  expect(secondScan.parentExecutionId).not.toBe(firstScan.parentExecutionId);
  const secondAssets: typeof firstAssets = [];
  assetCursor = undefined;
  do {
    const page = await client.listAssets({
      assetLibraryId: created.id,
      limit: 100,
      ...(assetCursor === undefined ? {} : { cursor: assetCursor }),
    });
    secondAssets.push(...page.items);
    assetCursor = page.nextCursor;
  } while (assetCursor !== undefined);
  for (const [workName, id] of firstAssetByWork)
    expect(
      secondAssets
        .filter((asset) =>
          asset.locations.some(({ address }) =>
            address.includes(`/${workName}/`),
          ),
        )
        .map(({ id: currentId }) => currentId),
    ).toEqual([id]);
  const addedAssets = secondAssets.filter((asset) =>
    asset.locations.some(({ address }) =>
      address.includes(`/${addedWorkName}/`),
    ),
  );
  expect(addedAssets).toHaveLength(1);
  expect(addedAssets[0]!.id).not.toBe(firstAssetByWork.get("RJ01115164"));
  expect(new Set(secondAssets.map(({ id }) => id)).size).toBe(
    secondAssets.length,
  );

  await service.close();
  service = await startProductServiceWithData(productDataDirectory, sourceIo);
  client = createPublicApiClient({ baseUrl: service.baseUrl });
  const persistedLibraries = await client.listAssetLibraries();
  expect(persistedLibraries.items).toHaveLength(1);
  expect(persistedLibraries.items[0]).toMatchObject({
    id: created.id,
    displayName: "普通目录声音库",
    configVersion: 1,
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  await expect(
    client.inspectAssetLibraryScan(secondScan.parentExecutionId),
  ).resolves.toMatchObject({
    parentExecutionId: secondScan.parentExecutionId,
    status: "completed",
  });
  const persistedAssets = await client.listAssets({
    assetLibraryId: created.id,
    limit: 100,
  });
  for (const id of secondAssets.map(({ id }) => id))
    expect(persistedAssets.items.map(({ id }) => id)).toContain(id);
  const persistedUnrecognized = await client.listUnrecognizedMaterials({
    assetLibraryId: created.id,
    limit: 100,
  });
  expect(
    persistedUnrecognized.items.some((item) =>
      item.relativePaths.includes("普通文件夹/杂项/材料列表.txt"),
    ),
  ).toBe(true);
}, 240_000);

it("正式扫描普通目录后经公共 HTTP 客户端分页读取资产和未识别材料", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-service-normal-http-"),
  );
  temporaryRoots.push(root);
  const material = path.join(root, "material");
  await cp(fixtureMaterialDirectory, material, { recursive: true });
  await writeFile(path.join(material, "ordinary.txt"), "普通材料\n");
  await writeFile(path.join(material, "ordinary-2.txt"), "另一份普通材料\n");
  const controlled = await loadControlledSourceIo({
    manifestPath: fixtureManifestPath,
  });
  const baseUrl = await startProductService({
    mode: "controlled",
    request: controlled.request,
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  });
  const client = createPublicApiClient({ baseUrl });
  const options = await client.listAssetLibraryOptions();
  expect(options.recognitionProfiles.map(({ id }) => id)).toContain(
    "dlsite-voice",
  );
  expect(options.sources.map(({ id }) => id)).toContain("dlsite");
  const created = await client.saveAssetLibrary({
    displayName: "普通目录资料库",
    directories: [material],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const secondLibrary = await client.saveAssetLibrary({
    displayName: "第二资料库",
    directories: [material],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const scan = await client.startAssetLibraryScan(created.id);
  await expect
    .poll(
      async () => await client.inspectAssetLibraryScan(scan.parentExecutionId),
      { timeout: 120_000 },
    )
    .toMatchObject({ status: "completed" });

  const firstLibraryPage = await client.listAssetLibraries({ limit: 1 });
  expect(firstLibraryPage.items).toHaveLength(1);
  expect(firstLibraryPage.nextCursor).toBeTypeOf("string");
  const secondLibraryPage = await client.listAssetLibraries({
    limit: 1,
    cursor: firstLibraryPage.nextCursor,
  });
  expect(secondLibraryPage.items).toHaveLength(1);
  expect(secondLibraryPage.nextCursor).toBeUndefined();
  expect(
    [
      ...firstLibraryPage.items.map(({ displayName }) => displayName),
      ...secondLibraryPage.items.map(({ displayName }) => displayName),
    ].toSorted(),
  ).toEqual(["普通目录资料库", "第二资料库"].toSorted());
  const assets = await client.listAssets({
    assetLibraryId: created.id,
    limit: 3,
  });
  expect(assets.items).toHaveLength(3);
  expect(assets.nextCursor).toBeTypeOf("string");
  const nextAssets = await client.listAssets({
    assetLibraryId: created.id,
    limit: 3,
    cursor: assets.nextCursor,
  });
  expect(nextAssets.items).toHaveLength(3);
  expect(nextAssets.items.map(({ id }) => id)).not.toEqual(
    assets.items.map(({ id }) => id),
  );

  const unrecognized = await client.listUnrecognizedMaterials({
    assetLibraryId: created.id,
    limit: 3,
  });
  expect(unrecognized.items).toHaveLength(3);
  expect(unrecognized.nextCursor).toBeTypeOf("string");
  const firstUnrecognizedCursor = unrecognized.nextCursor!;
  const unrecognizedPages = [unrecognized];
  let nextCursor = unrecognized.nextCursor;
  while (nextCursor !== undefined && unrecognizedPages.length < 20) {
    const nextPage = await client.listUnrecognizedMaterials({
      assetLibraryId: created.id,
      limit: 3,
      cursor: nextCursor,
    });
    unrecognizedPages.push(nextPage);
    nextCursor = nextPage.nextCursor;
  }
  expect(nextCursor).toBeUndefined();
  const observations = unrecognizedPages.flatMap(({ items }) => items);
  expect(
    observations.every(({ kind }) => kind === "filesystem-observation"),
  ).toBe(true);
  const paths = observations.flatMap(({ relativePaths }) => relativePaths);
  expect(paths).toContain("ordinary.txt");
  expect(paths).toContain("ordinary-2.txt");
  expect(
    paths.some((relativePath) => relativePath.startsWith("RJ01029383/")),
  ).toBe(false);
  expect(new Set(paths).size).toBe(paths.length);

  const wrongScopeAssetCursor = new URL("/api/v1/assets", baseUrl);
  wrongScopeAssetCursor.searchParams.set("assetLibraryId", secondLibrary.id);
  wrongScopeAssetCursor.searchParams.set("cursor", firstUnrecognizedCursor);
  const wrongScopeAssetResponse = await fetch(wrongScopeAssetCursor);
  expect(wrongScopeAssetResponse.status).toBe(400);
  await expect(wrongScopeAssetResponse.json()).resolves.toMatchObject({
    error: { code: "invalid-request" },
  });

  const wrongScopeUnrecognizedCursor = new URL(
    "/api/v1/unrecognized-materials",
    baseUrl,
  );
  wrongScopeUnrecognizedCursor.searchParams.set(
    "assetLibraryId",
    secondLibrary.id,
  );
  wrongScopeUnrecognizedCursor.searchParams.set(
    "cursor",
    firstUnrecognizedCursor,
  );
  const wrongScopeUnrecognizedResponse = await fetch(
    wrongScopeUnrecognizedCursor,
  );
  expect(
    wrongScopeUnrecognizedResponse.status,
    await wrongScopeUnrecognizedResponse.clone().text(),
  ).toBe(400);
  await expect(wrongScopeUnrecognizedResponse.json()).resolves.toMatchObject({
    error: { code: "invalid-request" },
  });
}, 180_000);

it("默认未识别列表只读当前完成扫描，不重复展示同一路径的旧观察", async () => {
  const materialRoot = await mkdtemp(
    path.join(tmpdir(), "digital-service-current-observation-"),
  );
  temporaryRoots.push(materialRoot);
  await writeFile(path.join(materialRoot, "ordinary.txt"), "旧普通材料\n");
  await writeFile(path.join(materialRoot, "stable.txt"), "仍然存在\n");
  const baseUrl = await startEmptyProductService();
  const client = createPublicApiClient({ baseUrl });
  const { id: assetLibraryId } = await client.saveAssetLibrary({
    displayName: "当前观察资料库",
    directories: [materialRoot],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });

  const scan = async (): Promise<string> => {
    const { parentExecutionId } =
      await client.startAssetLibraryScan(assetLibraryId);
    await expect
      .poll(
        async () => await client.inspectAssetLibraryScan(parentExecutionId),
        { timeout: 30_000 },
      )
      .toMatchObject({ status: "completed" });
    return parentExecutionId;
  };
  const historicalExecutionId = await scan();
  const historicalPage = await client.listUnrecognizedMaterials({
    assetLibraryId,
    limit: 1,
  });
  expect(historicalPage.items).toHaveLength(1);
  expect(historicalPage.nextCursor).toBeTypeOf("string");
  const removedPath = historicalPage.items[0]!.relativePaths[0]!;
  await unlink(path.join(materialRoot, removedPath));
  await writeFile(path.join(materialRoot, "current.txt"), "当前普通材料\n");
  const currentExecutionId = await scan();

  const page = await client.listUnrecognizedMaterials({
    assetLibraryId,
    limit: 20,
  });
  const currentPaths = page.items.flatMap(({ relativePaths }) => relativePaths);
  expect(currentPaths).toHaveLength(2);
  expect(currentPaths).toContain("current.txt");
  expect(currentPaths).not.toContain(removedPath);
  expect(
    page.items.every(
      ({ parentExecutionId }) => parentExecutionId === currentExecutionId,
    ),
  ).toBe(true);
  await expect(
    client.listUnrecognizedMaterials({
      assetLibraryId,
      cursor: historicalPage.nextCursor,
      limit: 1,
    }),
  ).resolves.toMatchObject({
    items: [
      {
        parentExecutionId: historicalExecutionId,
        relativePaths: ["stable.txt"],
      },
    ],
  });
  await expect(
    client.listUnrecognizedMaterials({
      assetLibraryId,
      parentExecutionId: historicalExecutionId,
      limit: 20,
    }),
  ).resolves.toMatchObject({
    items: [
      {
        parentExecutionId: historicalExecutionId,
        relativePaths: expect.arrayContaining(["ordinary.txt"]),
      },
      expect.objectContaining({ relativePaths: ["stable.txt"] }),
    ],
  });
}, 90_000);

it("在真实就绪服务前运行正式 TUI 命令并通过独占窄终端退出【安装客户端】", async () => {
  const materialRoot = await mkdtemp(
    path.join(tmpdir(), "digital-service-tui-unrecognized-"),
  );
  temporaryRoots.push(materialRoot);
  const productDataDirectory = await mkdtemp(
    path.join(tmpdir(), "digital-service-tui-product-data-"),
  );
  temporaryRoots.push(productDataDirectory);
  await cp(fixtureMaterialDirectory, materialRoot, { recursive: true });
  await writeFile(path.join(materialRoot, "ordinary.txt"), "普通材料\n");
  const baseUrl = await startInstalledProductService({
    productDataDirectory,
    manifestPath: fixtureManifestPath,
  });
  const publicClient = createPublicApiClient({ baseUrl });
  const library = await publicClient.saveAssetLibrary({
    displayName: "窄终端资料库",
    directories: [materialRoot],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const scan = await publicClient.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        await publicClient.inspectAssetLibraryScan(scan.parentExecutionId),
      { timeout: 30_000 },
    )
    .toMatchObject({ status: "completed" });
  const assetPage = await publicClient.listAssets({
    assetLibraryId: library.id,
    limit: 20,
  });
  const firstAsset = assetPage.items[0];
  expect(firstAsset).toBeDefined();
  const knownTitle = firstAsset!.descriptions
    .filter(
      (description) =>
        description.target.kind === "entity" &&
        description.target.entityId === firstAsset!.id,
    )
    .flatMap((description) => description.metadata)
    .find(
      (metadata) =>
        metadata.property === "asset.title" &&
        metadata.result.status === "resolved",
    )?.result;
  const title =
    knownTitle?.status === "resolved" ? knownTitle.values[0]?.value : undefined;
  expect(title).toBeTypeOf("string");
  const visibleTitlePrefix = Array.from(title!).slice(0, 12).join("");
  const terminalCommand = `stty cols 34 rows 10 -icanon -echo; terminalModeBefore=$(stty -g); pnpm --filter @digital/service exec digital-tui --url ${baseUrl.origin}; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const keyInput =
    "{ sleep 0.6; printf '\\r'; sleep 0.6; printf 3; sleep 0.6; printf '/'; sleep 0.3; printf 'ordinary.txt'; sleep 0.6; printf '\\r'; sleep 0.4; printf q; }";
  const command = `set -o pipefail; ${keyInput} | script -qfec ${shellQuote(terminalCommand)} /dev/null`;
  const child = spawn("bash", ["-lc", command], {
    cwd: servicePackageRoot,
    env: interactiveTerminalEnvironment({
      TERM: "xterm-256color",
      COLUMNS: "34",
      LINES: "10",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  terminalChildren.push(child);
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    const timer = setTimeout(() => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else child.kill("SIGTERM");
    }, 10_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const terminalOutput = Buffer.concat(output).toString("utf8");
  expect(
    exitCode,
    `${Buffer.concat(errors).toString("utf8")}\n${terminalOutput}`,
  ).toBe(0);
  expect(terminalOutput).toContain("数字资料库");
  expect(terminalOutput).toContain("窄终端资料库");
  expect(terminalOutput).toContain(visibleTitlePrefix);
  expect(terminalOutput).toContain("ordinary.txt");
  expect(terminalOutput).not.toContain("无法连接当前产品服务");
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  await expect
    .poll(async () => {
      const response = await fetch(new URL("/api/ready", baseUrl));
      return response.status;
    })
    .toBe(200);
  await expect(publicClient.listAssetLibraries()).resolves.toMatchObject({
    items: [expect.objectContaining({ id: library.id })],
  });
}, 15_000);

it("通过安装的 TUI 修正路径错误、配置多目录库、扫描并查看识别与未识别结果【安装客户端】", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc06-tui-library-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialRoot = path.join(root, "普通收藏");
  const supplementalRoot = path.join(root, "另一目录");
  const invalidRoot = path.join(root, "ewc06-missing-directory");
  const works = [
    ["RJ01029383", path.join(materialRoot, "作者甲", "2024", "RJ01029383")],
    [
      "RJ01196709",
      path.join(materialRoot, "作者乙", "2025", "已归档", "RJ01196709"),
    ],
  ] as const;
  for (const [workName, destination] of works) {
    await mkdir(destination, { recursive: true });
    await cp(path.join(fixtureMaterialDirectory, workName), destination, {
      recursive: true,
    });
  }
  await mkdir(path.join(materialRoot, "普通文件夹", "杂项"), {
    recursive: true,
  });
  await writeFile(
    path.join(materialRoot, "普通文件夹", "杂项", "材料列表.txt"),
    "验收准备：普通未知材料\n",
  );
  await mkdir(supplementalRoot, { recursive: true });
  await writeFile(
    path.join(supplementalRoot, "补充说明.txt"),
    "另一目录中的说明\n",
  );

  const baseUrl = await startInstalledProductService({
    productDataDirectory,
    manifestPath: fixtureManifestPath,
    port: await reserveEwc06Port(),
  });
  const materialDigest = await digestDirectories([
    materialRoot,
    supplementalRoot,
  ]);
  const terminalCommand = `stty cols 48 rows 12 -icanon -echo; terminalModeBefore=$(stty -g); pnpm --filter @digital/service exec digital-tui --url ${shellQuote(baseUrl.origin)}; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const child = spawn("script", ["-qfec", terminalCommand, "/dev/null"], {
    cwd: servicePackageRoot,
    env: interactiveTerminalEnvironment({
      TERM: "xterm-256color",
      COLUMNS: "48",
      LINES: "12",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childClosed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  terminalChildren.push(child);
  let terminalOutput = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk: Buffer) => {
    terminalOutput += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString("utf8");
  });
  const waitFor = async (
    predicate: () => boolean,
    description: string,
    timeoutMs = 15_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `TUI 提前退出，等待${description}失败：${errorOutput}\n${terminalOutput.slice(-3000)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `TUI 未显示${description}：${errorOutput}\n${terminalOutput.slice(-3000)}`,
    );
  };
  const waitForText = async (value: string, after = 0, timeoutMs?: number) =>
    await waitFor(
      () => terminalOutput.slice(after).includes(value),
      `“${value}”`,
      timeoutMs,
    );
  const send = async (value: string) => {
    const after = terminalOutput.length;
    child.stdin.write(value);
    await new Promise((resolve) => setTimeout(resolve, 160));
    return after;
  };
  const sendAndWait = async (value: string, nextScreen: string) => {
    const after = await send(value);
    await waitForText(nextScreen, after);
    return after;
  };

  await waitForText("还没有资产库");
  await sendAndWait("c", "新建资产库：资产库名称");
  await send("终端收藏库");
  await sendAndWait("\r", "新建资产库：服务端目录");
  await send(invalidRoot);
  await sendAndWait("\r", "ewc06-missing");
  await send(materialRoot);
  await sendAndWait("\r", "普通收藏");
  await send(supplementalRoot);
  await sendAndWait("\r", "另一目录");
  await sendAndWait("\r", "识别能力");
  await send(" ");
  await sendAndWait("\r", "新建资产库：来源");
  await send(" ");
  await sendAndWait("\r", "文件位置必须是当前可读的目录");

  await send("b");
  await sendAndWait("b", "新建资产库：服务端目录");
  await send(`-${invalidRoot}`);
  await sendAndWait("\r", "路径输入：");
  await sendAndWait("\r", "识别能力");
  await sendAndWait("\r", "新建资产库：来源");
  await sendAndWait("\r", "已保存「终端收藏库」");

  const client = createPublicApiClient({ baseUrl });
  const savedLibraries = await client.listAssetLibraries();
  expect(savedLibraries.items).toHaveLength(1);
  const savedLibrary = savedLibraries.items[0]!;
  expect(savedLibrary).toMatchObject({
    displayName: "终端收藏库",
    configVersion: 1,
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  expect(
    savedLibrary.directories
      .filter(({ status }) => status === "active")
      .map(({ path: directoryPath }) => directoryPath)
      .toSorted(),
  ).toEqual([materialRoot, supplementalRoot].toSorted());

  await sendAndWait("s", "扫描执行编号");
  const escape = String.fromCharCode(27);
  const plainTerminalOutput = terminalOutput
    .replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "gu"), "")
    .replace(/[\r\n]/gu, "");
  const executionId = plainTerminalOutput.match(
    /execution_[0-9a-f-]{36}/u,
  )?.[0];
  expect(executionId, terminalOutput.slice(-3000)).toBeTypeOf("string");
  await expect
    .poll(
      async () => (await client.inspectAssetLibraryScan(executionId!)).status,
      { timeout: 120_000 },
    )
    .toBe("completed");
  const scan = await client.inspectAssetLibraryScan(executionId!);
  expect(scan).toMatchObject({
    parentExecutionId: executionId,
    assetLibraryId: savedLibrary.id,
    configVersion: 1,
    status: "completed",
  });
  expect(scan.directories).toHaveLength(2);

  const assets = await client.listAssets({
    assetLibraryId: savedLibrary.id,
    limit: 100,
  });
  const assetIdByWork = new Map<string, string>();
  for (const [workName] of works) {
    const matching = assets.items.filter((asset) =>
      asset.locations.some(({ address }) => address.includes(`/${workName}/`)),
    );
    expect(matching, `扫描结果应将${workName}归属到唯一资产`).toHaveLength(1);
    assetIdByWork.set(workName, matching[0]!.id);
    expect(
      scan.directories.some((directory) =>
        directory.files.some(
          (file) =>
            file.assetId === matching[0]!.id &&
            file.relativePaths.some((relativePath) =>
              relativePath.includes(workName),
            ),
        ),
      ),
    ).toBe(true);
  }
  expect(new Set(assetIdByWork.values()).size).toBe(works.length);
  const unrecognized = await client.listUnrecognizedMaterials({
    assetLibraryId: savedLibrary.id,
    limit: 100,
  });
  const unrecognizedPaths = unrecognized.items.flatMap(
    ({ relativePaths }) => relativePaths,
  );
  expect(unrecognizedPaths).toContain("普通文件夹/杂项/材料列表.txt");
  expect(unrecognizedPaths).toContain("补充说明.txt");

  await waitForText("结果：已完成");
  const assetsModeOffset = await sendAndWait("2", "›2 资产");
  const firstAsset = assets.items[0]!;
  const firstTitle = firstAsset.descriptions
    .filter(
      (description) =>
        description.target.kind === "entity" &&
        description.target.entityId === firstAsset.id,
    )
    .flatMap((description) => description.metadata)
    .find(
      (metadata) =>
        metadata.property === "asset.title" &&
        metadata.result.status === "resolved",
    )?.result;
  const visibleTitle =
    firstTitle?.status === "resolved"
      ? firstTitle.values[0]?.value
      : (firstAsset.relatedEntities.find(
          (entity) => entity.id === firstAsset.id,
        )?.label ?? "未命名资产");
  await waitForText(
    Array.from(visibleTitle ?? "未命名资产")
      .slice(0, 10)
      .join(""),
    assetsModeOffset,
  );
  const unrecognizedModeOffset = await sendAndWait("3", "›3 未识别材料");
  await waitForText("材料列表.txt", unrecognizedModeOffset);
  await sendAndWait("1", "›1 资产库");
  await sendAndWait("e", "修改资产库：资产库名称");
  await send("已更新");
  await sendAndWait("\r", "修改资产库：服务端目录");
  await sendAndWait("\r", "修改资产库：识别能力");
  await sendAndWait("\r", "修改资产库：来源");
  await sendAndWait("\r", "已保存「终端收藏库已更新」");

  const updatedLibraries = await client.listAssetLibraries();
  expect(updatedLibraries.items).toMatchObject([
    {
      id: savedLibrary.id,
      displayName: "终端收藏库已更新",
      configVersion: 2,
      recognitionProfileIds: ["dlsite-voice"],
      sourceIdentities: ["dlsite"],
    },
  ]);
  await sendAndWait("d", "确认移除「终端收藏库已更新」");
  await sendAndWait("y", "已移除「终端收藏库已更新」");
  await expect(client.listAssetLibraries()).resolves.toMatchObject({
    items: [],
  });
  expect(await digestDirectories([materialRoot, supplementalRoot])).toBe(
    materialDigest,
  );

  await send("q");
  const exitTimer = setTimeout(() => child.kill("SIGTERM"), 10_000);
  const exitCode = await childClosed;
  clearTimeout(exitTimer);
  expect(exitCode, `${errorOutput}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(terminalOutput).not.toContain("TERMINAL_NOT_RESTORED");
}, 120_000);

async function startEmptyProductService(): Promise<URL> {
  const sourceIo = await resolveSourceIoFromEnvironment({
    DIGITAL_SOURCE_MODE: "offline",
  });
  return await startProductService(sourceIo);
}

async function startInstalledProductService(input: {
  readonly productDataDirectory: string;
  readonly manifestPath: string;
  readonly port?: number;
  readonly serviceUser?: { readonly uid: number; readonly gid: number };
}): Promise<URL> {
  await prepareProductionCatalogue({
    productDataDirectory: input.productDataDirectory,
  });
  if (input.serviceUser !== undefined)
    await chownTree(
      path.dirname(input.productDataDirectory),
      input.serviceUser,
    );
  const controlled = await loadControlledSourceIo({
    manifestPath: input.manifestPath,
  });
  const sourceIdentity = controlled.contentIdentity;
  const port = input.port ?? (await reservePort());
  const child = spawn(process.execPath, ["./dist/main.js"], {
    cwd: servicePackageRoot,
    env: {
      ...process.env,
      DIGITAL_PRODUCT_DATA: input.productDataDirectory,
      DIGITAL_SOURCE_IO_CONFIG: input.manifestPath,
      DIGITAL_SOURCE_IO_IDENTITY: sourceIdentity,
      DIGITAL_SOURCE_IO_MODE: "controlled",
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    ...(input.serviceUser === undefined
      ? {}
      : { uid: input.serviceUser.uid, gid: input.serviceUser.gid }),
  });
  terminalChildren.push(child);
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));

  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `正式产品服务提前退出\n${Buffer.concat(output).toString("utf8")}\n${Buffer.concat(errors).toString("utf8")}`,
      );
    try {
      const response = await fetch(new URL("/api/ready", baseUrl));
      if (response.ok) return baseUrl;
    } catch {
      // 服务尚未绑定端口，继续等待公开就绪接口。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `正式产品服务未就绪\n${Buffer.concat(output).toString("utf8")}\n${Buffer.concat(errors).toString("utf8")}`,
  );
}

async function chownTree(
  directory: string,
  user: { readonly uid: number; readonly gid: number },
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await chownTree(entryPath, user);
    await chown(entryPath, user.uid, user.gid);
  }
  await chown(directory, user.uid, user.gid);
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("临时 HTTP 端口未分配");
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function reserveEwc06Port(): Promise<number> {
  for (let port = 48606; port <= 48699; port += 1) {
    const server = createNetServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
      return port;
    } catch {
      server.close();
    }
  }
  throw new Error("ewc06 专用端口段没有可用端口");
}

async function digestDirectories(
  directories: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  for (const directory of directories) await visit(directory);
  for (const file of files.toSorted()) {
    hash.update(path.relative(path.dirname(directories[0]!), file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function startProductService(
  sourceIo: ProductConfiguration["sourceIo"],
): Promise<URL> {
  const root = await mkdtemp(path.join(tmpdir(), "digital-service-http-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  await prepareProductionCatalogue({ productDataDirectory });
  const service = await startProductServiceWithData(
    productDataDirectory,
    sourceIo,
  );
  return service.baseUrl;
}

async function startProductServiceWithData(
  productDataDirectory: string,
  sourceIo: ProductConfiguration["sourceIo"],
): Promise<{ readonly baseUrl: URL; readonly close: () => Promise<void> }> {
  const bootstrap = await createProductService({
    productDataDirectory,
    environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
    ...(sourceIo === undefined ? {} : { sourceIo }),
  });
  bootstraps.push(bootstrap);
  const server = serve({
    fetch: bootstrap.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  openServers.push(server);
  await server.ready();
  bootstrap.publish();
  const baseUrl = new URL(server.url!);
  expect(await eventuallyReady(baseUrl)).toBe(true);
  return {
    baseUrl,
    async close() {
      const serverIndex = openServers.indexOf(server);
      if (serverIndex >= 0) openServers.splice(serverIndex, 1);
      const bootstrapIndex = bootstraps.indexOf(bootstrap);
      if (bootstrapIndex >= 0) bootstraps.splice(bootstrapIndex, 1);
      await server.close(true);
      await bootstrap.abort();
    },
  };
}

async function eventuallyReady(baseUrl: URL): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/api/ready", baseUrl));
    if (response.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
