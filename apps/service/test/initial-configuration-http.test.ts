import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductSourceIo } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import { createPublicApiClient } from "@digital/public-api";
import { createProcessLifecycleRegistry } from "@digital/service-host";
import { refusingSessionTransport } from "@digital/test-support/source-io";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { createProductService } from "../src/service.ts";

type RunningService = {
  readonly client: ReturnType<typeof createPublicApiClient>;
  readonly server: Awaited<ReturnType<typeof serve>>;
  readonly bootstrap: Awaited<ReturnType<typeof createProductService>>;
};
const services: RunningService[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const service of services.splice(0).reverse()) {
    await service.server.close(true);
    await service.bootstrap.abort();
  }
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("显式保存的资产库配置会在新数据世代通过产品业务恢复", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "ewc15-initial-configuration-"),
  );
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const initialConfigurationDirectory = path.join(
    root,
    "retained-configuration",
  );
  const directories = [
    path.join(root, "资料", "声音", "2025"),
    path.join(root, "资料", "声音", "2026"),
    path.join(root, "资料", "书籍"),
  ];
  await Promise.all(
    directories.map((directory) => mkdir(directory, { recursive: true })),
  );
  await prepareProductionCatalogue({ productDataDirectory });

  const first = await startService({
    productDataDirectory,
    initialConfigurationDirectory,
    dataGeneration: "g1",
  });
  const options = await first.client.listAssetLibraryOptions();
  const voice = await first.client.saveAssetLibrary({
    displayName: "初始声音库",
    directories: directories.slice(0, 2),
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const books = await first.client.saveAssetLibrary({
    displayName: "初始书库",
    directories: [directories[2]!],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  const saved = await first.client.saveInitialAssetLibraryConfiguration();
  expect(saved).toEqual({ libraryCount: 2 });

  await first.client.saveAssetLibrary({
    id: voice.id,
    expectedVersion: voice.configVersion,
    displayName: "临时声音库",
    directories: [directories[0]!],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: [],
  });
  await first.client.removeAssetLibrary({
    id: books.id,
    expectedVersion: books.configVersion,
  });
  expect(options.recognitionProfiles.map(({ id }) => id)).toContain("books");
  await stopService(first);

  const restarted = await startService({
    productDataDirectory,
    initialConfigurationDirectory,
    dataGeneration: "g1",
  });
  const unchangedGeneration = await restarted.client.listAssetLibraries();
  expect(unchangedGeneration.items).toHaveLength(1);
  expect(unchangedGeneration.items[0]?.displayName).toBe("临时声音库");
  await stopService(restarted);

  await rm(productDataDirectory, { recursive: true, force: true });
  await prepareProductionCatalogue({ productDataDirectory });
  const second = await startService({
    productDataDirectory,
    initialConfigurationDirectory,
    dataGeneration: "g2",
  });
  const restored = await second.client.listAssetLibraries();
  expect(restored.items).toHaveLength(2);
  expect(restored.items).toContainEqual(
    expect.objectContaining({
      displayName: "初始声音库",
      recognitionProfileIds: ["dlsite-voice"],
      sourceIdentities: ["dlsite"],
      directories: expect.arrayContaining([
        expect.objectContaining({ path: directories[0], status: "active" }),
        expect.objectContaining({ path: directories[1], status: "active" }),
      ]),
    }),
  );
  expect(restored.items).toContainEqual(
    expect.objectContaining({
      displayName: "初始书库",
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
      directories: expect.arrayContaining([
        expect.objectContaining({ path: directories[2], status: "active" }),
      ]),
    }),
  );

  const restoredVoice = restored.items.find(
    ({ displayName }) => displayName === "初始声音库",
  );
  const restoredBooks = restored.items.find(
    ({ displayName }) => displayName === "初始书库",
  );
  if (restoredVoice === undefined || restoredBooks === undefined)
    throw new Error("未恢复初始资产库");
  await second.client.saveAssetLibrary({
    id: restoredVoice.id,
    expectedVersion: restoredVoice.configVersion,
    displayName: "更新后的初始声音库",
    directories: directories.slice(0, 2),
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  expect(await second.client.saveInitialAssetLibraryConfiguration()).toEqual({
    libraryCount: 2,
  });
  const changedAfterUpdate = await second.client.listAssetLibraries();
  const changedVoice = changedAfterUpdate.items.find(
    ({ id }) => id === restoredVoice.id,
  );
  const changedBooks = changedAfterUpdate.items.find(
    ({ id }) => id === restoredBooks.id,
  );
  if (changedVoice === undefined || changedBooks === undefined)
    throw new Error("更新初始配置后资产库缺失");
  await second.client.saveAssetLibrary({
    id: changedVoice.id,
    expectedVersion: changedVoice.configVersion,
    displayName: "重建前的任意声音库",
    directories: [directories[0]!],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: [],
  });
  await second.client.removeAssetLibrary({
    id: changedBooks.id,
    expectedVersion: changedBooks.configVersion,
  });
  await stopService(second);

  await rm(productDataDirectory, { recursive: true, force: true });
  await prepareProductionCatalogue({ productDataDirectory });
  const third = await startService({
    productDataDirectory,
    initialConfigurationDirectory,
    dataGeneration: "g3",
  });
  const updatedRestoration = await third.client.listAssetLibraries();
  expect(updatedRestoration.items).toHaveLength(2);
  expect(updatedRestoration.items).toContainEqual(
    expect.objectContaining({
      displayName: "更新后的初始声音库",
      recognitionProfileIds: ["dlsite-voice"],
      sourceIdentities: ["dlsite"],
      directories: expect.arrayContaining([
        expect.objectContaining({ path: directories[0], status: "active" }),
        expect.objectContaining({ path: directories[1], status: "active" }),
      ]),
    }),
  );
  expect(
    updatedRestoration.items.map(({ displayName }) => displayName),
  ).not.toContain("重建前的任意声音库");
});

async function startService(input: {
  readonly productDataDirectory: string;
  readonly initialConfigurationDirectory: string;
  readonly dataGeneration: string;
}): Promise<{
  readonly client: ReturnType<typeof createPublicApiClient>;
  readonly server: Awaited<ReturnType<typeof serve>>;
  readonly bootstrap: Awaited<ReturnType<typeof createProductService>>;
}> {
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    async request() {
      throw new Error("本验收不允许访问外部来源");
    },
    sessionTransport: refusingSessionTransport(),
  };
  const bootstrap = await createProductService(
    {
      productDataDirectory: input.productDataDirectory,
      initialAssetLibraryConfigurationDirectory:
        input.initialConfigurationDirectory,
      dataGeneration: input.dataGeneration,
      environment: { DIGITAL_PRODUCT_DATA: input.productDataDirectory },
      sourceIo,
    },
    { lifecycle: isolatedLifecycle() },
  );
  const server = serve({
    fetch: bootstrap.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  await server.ready();
  bootstrap.publish();
  const service: RunningService = {
    client: createPublicApiClient({ baseUrl: server.url! }),
    server,
    bootstrap,
  };
  services.push(service);
  return service;
}

async function stopService(service: RunningService): Promise<void> {
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
  await service.server.close(true);
  await service.bootstrap.abort();
}

function isolatedLifecycle() {
  return createProcessLifecycleRegistry({
    addSignalListener() {},
    removeSignalListener() {},
    forceExit() {},
  });
}
