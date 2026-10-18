import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deleteEnvironment,
  inspectEnvironment,
  prepareEnvironment,
  rebuildEnvironment,
  startEnvironment,
  stopEnvironment,
} from "@digital/environment";
import { createPublicApiClient } from "@digital/public-api";
import { loadControlledSourceIo } from "@digital/test-support/source-io";
import { afterEach, expect, it } from "vitest";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const fanboxFixture = path.join(
  workspaceRoot,
  "fixtures",
  "controlled-fanbox-session",
);
const manifestPath = path.join(fanboxFixture, "manifest.json");
const credentialPath = path.join(
  fanboxFixture,
  "connections",
  "synthetic-customudon.json",
);
const environments: string[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const environment of environments.splice(0).reverse()) {
    const target = { workspacePath: workspaceRoot, environment };
    const stopped = await stopEnvironment(target);
    if (stopped.status !== "stopped" && stopped.status !== "already-stopped")
      throw new Error(
        `第15票验收环境 ${environment} 未能经公开入口停止：${JSON.stringify(stopped.failure ?? {})}`,
      );
    const deleted = await deleteEnvironment(target);
    if (deleted.status !== "deleted")
      throw new Error(
        `第15票验收环境 ${environment} 未能经公开入口删除：${JSON.stringify(deleted.failure ?? {})}`,
      );
    expect((await inspectEnvironment(target)).state).toBe("unmanaged");
  }
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("重建时一个目录暂时离线仍可启动服务并使用其他已恢复目录", async () => {
  const materialsRoot = await mkdtemp(
    path.join(tmpdir(), "ewc15-offline-directory-materials-"),
  );
  temporaryRoots.push(materialsRoot);
  const firstDirectory = path.join(materialsRoot, "A");
  const secondDirectory = path.join(materialsRoot, "B");
  const parkedDirectory = path.join(materialsRoot, "B-temporarily-offline");
  await Promise.all(
    [firstDirectory, secondDirectory].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );

  const environment = `ewc15-offline-${randomUUID().slice(0, 8)}`;
  environments.push(environment);
  const port = await freePort();
  const controlled = await loadControlledSourceIo({ manifestPath });
  await controlled.sessionTransport?.close();
  const prepared = await prepareEnvironment({
    workspacePath: workspaceRoot,
    environment,
    inputs: [firstDirectory, secondDirectory],
    sourceMode: "controlled",
    config: {
      profile: environment,
      webPort: port,
      sourceIo: {
        manifestPath,
        contentIdentity: controlled.contentIdentity,
      },
    },
  });
  expect(prepared.status, JSON.stringify(prepared.failure ?? {})).toBe(
    "prepared",
  );

  const initial = await startEnvironment({
    workspacePath: workspaceRoot,
    environment,
  });
  expect(initial.status, JSON.stringify(initial.failure ?? {})).toBe("ready");
  if (initial.status !== "ready") throw new Error("初次启动没有就绪");
  if (initial.run.address === null) throw new Error("初次启动结果缺少地址");
  const initialClient = createPublicApiClient({ baseUrl: initial.run.address });
  await initialClient.saveAssetLibrary({
    displayName: "可恢复资产库",
    directories: [firstDirectory, secondDirectory],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  await initialClient.saveInitialAssetLibraryConfiguration();
  await stopEnvironment({ workspacePath: workspaceRoot, environment });
  const rebuilt = await rebuildEnvironment({
    workspacePath: workspaceRoot,
    environment,
  });
  expect(rebuilt.status, JSON.stringify(rebuilt.failure ?? {})).toBe("rebuilt");
  await rename(secondDirectory, parkedDirectory);

  const degraded = await startEnvironment({
    workspacePath: workspaceRoot,
    environment,
  });
  expect(degraded.status, JSON.stringify(degraded.failure ?? {})).toBe("ready");
  if (degraded.status !== "ready") throw new Error("目录离线时服务没有就绪");
  if (degraded.run.address === null)
    throw new Error("目录离线时服务启动结果缺少地址");
  const degradedClient = createPublicApiClient({
    baseUrl: degraded.run.address,
  });
  await expect(degradedClient.listAssetLibraries()).resolves.toMatchObject({
    items: [
      expect.objectContaining({
        displayName: "可恢复资产库",
        directories: [
          expect.objectContaining({
            path: firstDirectory,
            status: "active",
            reachable: true,
          }),
        ],
      }),
    ],
  });

  await expect(
    degradedClient.inspectInitialAssetLibraryConfiguration(),
  ).resolves.toMatchObject({
    status: "pending",
    pendingDirectories: [
      { libraryName: "可恢复资产库", path: secondDirectory },
    ],
  });

  await rename(parkedDirectory, secondDirectory);
  await expect(
    degradedClient.restoreInitialAssetLibraryConfiguration(),
  ).resolves.toMatchObject({ status: "applied", pendingDirectories: [] });
  await expect(degradedClient.listAssetLibraries()).resolves.toMatchObject({
    items: [
      expect.objectContaining({
        displayName: "可恢复资产库",
        directories: expect.arrayContaining([
          expect.objectContaining({ path: firstDirectory }),
          expect.objectContaining({ path: secondDirectory }),
        ]),
      }),
    ],
  });
}, 600_000);

it("公开环境重建恢复显式更新的资产库基线并清空执行、人工决定与 FANBOX 授权", async () => {
  const materialsRoot = await mkdtemp(
    path.join(tmpdir(), "ewc15-environment-materials-"),
  );
  temporaryRoots.push(materialsRoot);
  const firstDirectory = path.join(materialsRoot, "收藏", "FANBOX-甲");
  const secondDirectory = path.join(materialsRoot, "收藏", "FANBOX-乙");
  const booksDirectory = path.join(materialsRoot, "阅读", "书籍");
  await Promise.all(
    [firstDirectory, secondDirectory, booksDirectory].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  await cp(
    path.join(fanboxFixture, "material", "customudon"),
    path.join(firstDirectory, "customudon"),
    { recursive: true },
  );
  const materialDigest = await digestDirectories([
    firstDirectory,
    secondDirectory,
    booksDirectory,
  ]);

  const environment = `ewc15-${randomUUID().slice(0, 8)}`;
  environments.push(environment);
  const containerDirectory = path.join(
    workspaceRoot,
    ".digital",
    "environments",
    environment,
  );
  const port = await freePort();
  const controlled = await loadControlledSourceIo({ manifestPath });
  await controlled.sessionTransport?.close();
  const prepared = await prepareEnvironment({
    workspacePath: workspaceRoot,
    environment,
    inputs: [firstDirectory, secondDirectory, booksDirectory],
    sourceMode: "controlled",
    config: {
      profile: environment,
      webPort: port,
      sourceIo: {
        manifestPath,
        contentIdentity: controlled.contentIdentity,
      },
    },
  });
  expect(prepared.status, JSON.stringify(prepared.failure ?? {})).toBe(
    "prepared",
  );

  const start = async () => {
    const result = await startEnvironment({
      workspacePath: workspaceRoot,
      environment,
    });
    expect(result.status, JSON.stringify(result.failure ?? {})).toBe("ready");
    if (result.run.address === null) throw new Error("服务启动结果缺少地址");
    return createPublicApiClient({ baseUrl: result.run.address });
  };
  const client = await start();
  const firstLibrary = await client.saveAssetLibrary({
    displayName: "初始 FANBOX 库",
    directories: [firstDirectory, secondDirectory],
    recognitionProfileIds: ["fanbox"],
    sourceIdentities: ["fanbox"],
  });
  await client.saveAssetLibrary({
    displayName: "初始书籍库",
    directories: [booksDirectory],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  expect(await client.saveInitialAssetLibraryConfiguration()).toEqual({
    libraryCount: 2,
  });

  const browserCredential = JSON.parse(
    await readFile(credentialPath, "utf8"),
  ) as unknown;
  const connectedRequest = await client.createFanboxConnectionRequest({
    creatorId: "customudon",
  });
  await expect(
    client.completeFanboxConnectionRequest({
      requestId: connectedRequest.request.id,
      pairingCode: connectedRequest.pairingCode,
      browserCredential,
    }),
  ).resolves.toMatchObject({ status: "succeeded" });
  expect(
    (await client.listSourceConnections()).items.filter(({ id }) =>
      id.startsWith("fanbox/"),
    ),
  ).toEqual([
    expect.objectContaining({
      id: "fanbox/customudon",
      credentialStatus: "configured",
      availability: "available",
    }),
  ]);
  const retainedConfiguration = await readFile(
    path.join(
      containerDirectory,
      "initial-configuration",
      "asset-library-initial-configuration.json",
    ),
    "utf8",
  );
  expect(retainedConfiguration).not.toContain("FANBOXSESSID");
  expect(retainedConfiguration).not.toContain(
    "synthetic-controlled-session-not-a-real-credential",
  );

  const scan = await client.startAssetLibraryScan(firstLibrary.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");
  const assets = await client.listAssets({
    assetLibraryId: firstLibrary.id,
    limit: 20,
  });
  expect(assets.items).toHaveLength(1);
  const assetId = assets.items[0]!.id;
  const manualDecision = await client.prepareMetadataDecision(assetId, {
    kind: "pin",
    property: "asset.title",
    value: "用户修正标题",
  });
  await expect(
    client.confirmMetadataDecision(manualDecision.previewId),
  ).resolves.toMatchObject({ status: "applied" });
  await expectPinnedTitle(client, assetId, "用户修正标题");
  const changed = await client.saveAssetLibrary({
    id: firstLibrary.id,
    expectedVersion: firstLibrary.configVersion,
    displayName: "停止前当前配置",
    directories: [firstDirectory, secondDirectory],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  expect(changed.displayName).toBe("停止前当前配置");
  const stopped = await stopEnvironment({
    workspacePath: workspaceRoot,
    environment,
  });
  expect(stopped.status, JSON.stringify(stopped.failure ?? {})).toBe("stopped");

  const restartedClient = await start();
  await expect(restartedClient.listAssetLibraries()).resolves.toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({
        id: firstLibrary.id,
        displayName: "停止前当前配置",
        recognitionProfileIds: ["books"],
        sourceIdentities: [],
      }),
    ]),
  });
  await expectPinnedTitle(restartedClient, assetId, "用户修正标题");
  await expect(
    restartedClient.inspectExecution(scan.parentExecutionId),
  ).resolves.toMatchObject({
    status: "completed",
  });
  expect(
    (await restartedClient.listSourceConnections()).items.filter(({ id }) =>
      id.startsWith("fanbox/"),
    ),
  ).toEqual([
    expect.objectContaining({
      id: "fanbox/customudon",
      credentialStatus: "configured",
      availability: "available",
    }),
  ]);
  const staleRequest = await restartedClient.createFanboxConnectionRequest({
    creatorId: "customudon",
  });
  expect(staleRequest.request.status).toBe("waiting");
  await expect(
    restartedClient.getFanboxConnectionRequest(staleRequest.request.id),
  ).resolves.toMatchObject({ status: "waiting" });

  await stopEnvironment({ workspacePath: workspaceRoot, environment });
  const firstRebuild = await rebuildEnvironment({
    workspacePath: workspaceRoot,
    environment,
  });
  expect(firstRebuild.status, JSON.stringify(firstRebuild.failure ?? {})).toBe(
    "rebuilt",
  );
  expect(
    await digestDirectories([firstDirectory, secondDirectory, booksDirectory]),
  ).toBe(materialDigest);

  const firstRebuiltClient = await start();
  const restored = await firstRebuiltClient.listAssetLibraries();
  expect(restored.items).toHaveLength(2);
  expect(restored.items).toContainEqual(
    expect.objectContaining({
      displayName: "初始 FANBOX 库",
      recognitionProfileIds: ["fanbox"],
      sourceIdentities: ["fanbox"],
      directories: expect.arrayContaining([
        expect.objectContaining({ path: firstDirectory, status: "active" }),
        expect.objectContaining({ path: secondDirectory, status: "active" }),
      ]),
    }),
  );
  expect(restored.items).toContainEqual(
    expect.objectContaining({
      displayName: "初始书籍库",
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
      directories: expect.arrayContaining([
        expect.objectContaining({ path: booksDirectory, status: "active" }),
      ]),
    }),
  );
  await expect(
    firstRebuiltClient.listAssets({ limit: 20 }),
  ).resolves.toMatchObject({
    items: [],
  });
  await expect(
    firstRebuiltClient.listWorkflowHistory({ limit: 20 }),
  ).resolves.toMatchObject({
    items: [],
  });
  expect(
    (await firstRebuiltClient.listSourceConnections()).items.filter(({ id }) =>
      id.startsWith("fanbox/"),
    ),
  ).toEqual([]);
  await expect(
    firstRebuiltClient.getFanboxConnectionRequest(connectedRequest.request.id),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });
  await expect(
    firstRebuiltClient.getFanboxConnectionRequest(staleRequest.request.id),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });
  await expect(
    firstRebuiltClient.completeFanboxConnectionRequest({
      requestId: staleRequest.request.id,
      pairingCode: staleRequest.pairingCode,
      browserCredential,
    }),
  ).rejects.toMatchObject({ kind: "not-found", status: 404 });
  expect(
    await digestDirectories([firstDirectory, secondDirectory, booksDirectory]),
  ).toBe(materialDigest);

  await stopEnvironment({ workspacePath: workspaceRoot, environment });

  const restoredVoice = restored.items.find(
    ({ displayName }) => displayName === "初始 FANBOX 库",
  );
  const restoredBooks = restored.items.find(
    ({ displayName }) => displayName === "初始书籍库",
  );
  if (restoredVoice === undefined || restoredBooks === undefined)
    throw new Error("首次重建后初始资产库缺失");
  const updateClient = await start();
  await updateClient.saveAssetLibrary({
    id: restoredVoice.id,
    expectedVersion: restoredVoice.configVersion,
    displayName: "更新后的初始 FANBOX 库",
    directories: [firstDirectory, secondDirectory],
    recognitionProfileIds: ["fanbox"],
    sourceIdentities: ["fanbox"],
  });
  expect(await updateClient.saveInitialAssetLibraryConfiguration()).toEqual({
    libraryCount: 2,
  });
  const currentVoice = (await updateClient.listAssetLibraries()).items.find(
    ({ id }) => id === restoredVoice.id,
  );
  const currentBooks = (await updateClient.listAssetLibraries()).items.find(
    ({ id }) => id === restoredBooks.id,
  );
  if (currentVoice === undefined || currentBooks === undefined)
    throw new Error("显式更新初始配置后资产库缺失");
  await updateClient.saveAssetLibrary({
    id: currentVoice.id,
    expectedVersion: currentVoice.configVersion,
    displayName: "重建前任意改动",
    directories: [secondDirectory],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  await updateClient.removeAssetLibrary({
    id: currentBooks.id,
    expectedVersion: currentBooks.configVersion,
  });
  await stopEnvironment({ workspacePath: workspaceRoot, environment });

  const secondRebuild = await rebuildEnvironment({
    workspacePath: workspaceRoot,
    environment,
  });
  expect(
    secondRebuild.status,
    JSON.stringify(secondRebuild.failure ?? {}),
  ).toBe("rebuilt");
  const secondRebuiltClient = await start();
  const updatedRestoration = await secondRebuiltClient.listAssetLibraries();
  expect(updatedRestoration.items).toHaveLength(2);
  expect(updatedRestoration.items).toContainEqual(
    expect.objectContaining({
      displayName: "更新后的初始 FANBOX 库",
      recognitionProfileIds: ["fanbox"],
      sourceIdentities: ["fanbox"],
      directories: expect.arrayContaining([
        expect.objectContaining({ path: firstDirectory, status: "active" }),
        expect.objectContaining({ path: secondDirectory, status: "active" }),
      ]),
    }),
  );
  expect(
    updatedRestoration.items.map(({ displayName }) => displayName),
  ).not.toContain("重建前任意改动");
  await expect(
    secondRebuiltClient.listAssets({ limit: 20 }),
  ).resolves.toMatchObject({
    items: [],
  });
  expect(
    await digestDirectories([firstDirectory, secondDirectory, booksDirectory]),
  ).toBe(materialDigest);
}, 600_000);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("未能分配本机验收端口");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function expectPinnedTitle(
  client: ReturnType<typeof createPublicApiClient>,
  assetId: string,
  expected: string,
): Promise<void> {
  const page = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  const title = page.items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(title?.kind).toBe("current-value");
  if (title?.kind !== "current-value") throw new Error("当前值中没有资产标题");
  expect(title.evidence.result.status).toBe("resolved");
  if (title.evidence.result.status !== "resolved")
    throw new Error("人工标题没有维持为采用值");
  expect(
    title.evidence.result.values.map(({ value, sourceIdentity }) => ({
      value,
      sourceIdentity,
    })),
  ).toEqual([{ value: expected, sourceIdentity: "user" }]);
}

async function digestDirectories(
  directories: readonly string[],
): Promise<string> {
  const files: string[] = [];
  for (const directory of directories)
    await collectFiles(directory, directory, files);
  return files.toSorted().join("\n");
}

async function collectFiles(
  directory: string,
  root: string,
  files: string[],
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolute, root, files);
      continue;
    }
    const digest = createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex");
    files.push(`${path.relative(root, absolute)} ${digest}`);
  }
}
