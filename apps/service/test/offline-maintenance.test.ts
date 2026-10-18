import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProductSourceIo } from "@digital/composition";
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

const roots: string[] = [];
const services: Array<{
  readonly server: Awaited<ReturnType<typeof serve>>;
  readonly abort: () => Promise<void>;
}> = [];
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const maintenanceEntry = fileURLToPath(
  import.meta.resolve("@digital/product-maintenance/cli"),
);
const repositoryRoot = path.resolve(packageDirectory, "../..");
const controlledManifestPath = path.join(
  repositoryRoot,
  "fixtures/controlled-source-io/manifest.json",
);
const controlledMaterialDirectory = path.join(
  repositoryRoot,
  "fixtures/controlled-source-io/material/RJ01668691",
);

afterEach(async () => {
  for (const service of services.splice(0).reverse()) {
    await service.server.close(true);
    await service.abort();
  }
  for (const root of roots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("运行中的真实 HTTP 产品占用数据根时，正式维护入口拒绝离线备份", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "digital-offline-maintenance-"),
  );
  roots.push(workspace);
  const productDataDirectory = path.join(workspace, "product-data");
  const backupDirectory = path.join(workspace, "backup");
  await prepareProductionCatalogue({ productDataDirectory });

  const sourceIo = await resolveSourceIoFromEnvironment({
    DIGITAL_SOURCE_MODE: "offline",
  });
  const bootstrap = await createProductService({
    productDataDirectory,
    environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
    sourceIo,
  });
  const server = serve({
    fetch: bootstrap.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  services.push({ server, abort: () => bootstrap.abort() });
  await server.ready();
  bootstrap.publish();
  const baseUrl = new URL(server.url!);
  await expect
    .poll(
      async () => {
        const response = await fetch(new URL("/api/ready", baseUrl), {
          signal: AbortSignal.timeout(1_000),
        });
        return {
          status: response.status,
          body: await response.json(),
        };
      },
      { timeout: 30_000, interval: 100 },
    )
    .toMatchObject({ status: 200, body: { ok: true } });

  const maintenance = await runMaintenance([
    "offline-backup",
    "--product-data",
    productDataDirectory,
    "--backup-directory",
    backupDirectory,
  ]);
  expect(maintenance.code).toBe(1);
  expect(maintenance.stderr).toContain("产品正在运行");
}, 45_000);

it("正式业务操作形成的状态可经停止服务后的维护产物恢复，并由真实 HTTP 服务读回", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "digital-offline-maintenance-round-trip-"),
  );
  roots.push(workspace);
  const sourceProductData = path.join(workspace, "source-product-data");
  const backupDirectory = path.join(workspace, "offline-backup");
  const restoredProductData = path.join(workspace, "restored-product-data");
  const observedRoot = path.join(workspace, "observed-media");
  const observedWork = path.join(observedRoot, "RJ01668691");
  const secret = "offline-maintenance-private-test-token";
  await cp(controlledMaterialDirectory, observedWork, { recursive: true });
  const observedDigest = await digestDirectory(observedRoot);
  await prepareProductionCatalogue({
    productDataDirectory: sourceProductData,
  });

  const controlled = await loadControlledSourceIo({
    manifestPath: controlledManifestPath,
  });
  const sourceIo: ProductSourceIo = {
    mode: "controlled",
    async request(input, init) {
      const url = new URL(input);
      if (
        url.host === "api.themoviedb.org" &&
        url.pathname === "/3/authentication"
      ) {
        const headers = new Headers(init?.headers as HeadersInit | undefined);
        expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
        return new Response(null, { status: 200 });
      }
      return await controlled.request(input, init);
    },
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };

  let service = await startProductService(sourceProductData, sourceIo);
  let client = createPublicApiClient({ baseUrl: service.baseUrl });
  const library = await client.saveAssetLibrary({
    displayName: "离线维护恢复演练",
    directories: [observedRoot],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const startedScan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(startedScan.parentExecutionId))
          .status,
      { timeout: 120_000 },
    )
    .toBe("completed");
  const acceptedScan = await client.inspectAssetLibraryScan(
    startedScan.parentExecutionId,
  );
  expect(acceptedScan).toMatchObject({
    assetLibraryId: library.id,
    outcome: "accepted",
    status: "completed",
  });
  const sourceAssets = await client.listAssets({
    assetLibraryId: library.id,
    limit: 100,
  });
  expect(sourceAssets.items.length).toBeGreaterThan(0);
  const readPrimaryCover = async (assets: typeof sourceAssets) => {
    const asset = assets.items.find(({ descriptions }) =>
      descriptions.some(({ artifactRoles }) =>
        artifactRoles.some(({ role }) => role === "asset.primary-cover"),
      ),
    );
    const role = asset?.descriptions
      .flatMap(({ artifactRoles }) => artifactRoles)
      .find(({ role }) => role === "asset.primary-cover");
    expect(role?.address).toMatch(
      /^\/api\/v1\/media\/managed-artifacts\/[a-f0-9]{64}$/u,
    );
    const digest = role!.address!.split("/").at(-1)!;
    const response = await client.readManagedArtifact(digest);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const location = asset!.locations.find(({ id }) => id === role!.locationId);
    expect(location?.content.status).toBe("confirmed");
    if (location?.content.status !== "confirmed")
      throw new Error("封面没有确认的正式产物修订");
    const revisionResponse = await client.readArtifactRevision(
      location.content.target.revisionId,
      { assetLibraryId: library.id },
    );
    expect(revisionResponse.status).toBe(200);
    return {
      address: role!.address!,
      bytes,
      revisionBytes: Buffer.from(await revisionResponse.arrayBuffer()),
    };
  };
  const sourceCover = await readPrimaryCover(sourceAssets);
  expect(sourceCover.revisionBytes).toEqual(sourceCover.bytes);
  const acceptedExecution = await client.inspectExecution(
    startedScan.parentExecutionId,
  );

  const configuredConnection = await client.configureSourceConnection({
    sourceId: "tmdb",
    expectedVersion: 0,
    secret,
  });
  expect(configuredConnection.verification).toBe("verified");
  const sourceConnections = await client.listSourceConnections();
  expect(JSON.stringify(sourceConnections)).not.toContain(secret);
  expect(sourceConnections.items).toContainEqual(
    expect.objectContaining({
      id: "tmdb",
      credentialStatus: "configured",
      availability: "available",
    }),
  );

  const privateSecretPath = path.join(
    sourceProductData,
    "private-source-connections",
    "tmdb.json",
  );
  const privateSecretBytes = await readFile(privateSecretPath);
  await chmod(privateSecretPath, 0o600);
  await mkdir(path.join(sourceProductData, "cache"), { recursive: true });
  await writeFile(
    path.join(sourceProductData, "cache", "rebuildable"),
    "cache",
  );
  await mkdir(path.join(sourceProductData, "future-durable-area"));
  await writeFile(
    path.join(sourceProductData, "future-durable-area", "state"),
    "future durable state",
  );
  const managedArtifactPath = path.join(
    sourceProductData,
    "managed-artifacts",
    "maintenance-rehearsal.bin",
  );
  const managedArtifactBytes = new Uint8Array([7, 6, 5, 4]);
  await writeFile(managedArtifactPath, managedArtifactBytes);
  await chmod(managedArtifactPath, 0o640);

  const busyBackup = await runMaintenance([
    "offline-backup",
    "--product-data",
    sourceProductData,
    "--backup-directory",
    backupDirectory,
  ]);
  expect(busyBackup.code).toBe(1);
  expect(busyBackup.stderr).toContain("产品正在运行");
  expect(busyBackup.stdout).not.toContain("完成");

  await service.close();
  const backup = await runMaintenance([
    "offline-backup",
    "--product-data",
    sourceProductData,
    "--backup-directory",
    backupDirectory,
  ]);
  expect(backup.code).toBe(0);
  expect(backup.stdout).toContain("离线备份完成");
  expect(`${backup.stdout}\n${backup.stderr}`).not.toContain(secret);
  await expect(
    lstat(path.join(backupDirectory, "cache")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(
      path.join(backupDirectory, "future-durable-area", "state"),
      "utf8",
    ),
  ).resolves.toBe("future durable state");
  await expect(
    lstat(path.join(backupDirectory, "observed-media")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(
      path.join(backupDirectory, "private-source-connections", "tmdb.json"),
    ),
  ).resolves.toEqual(privateSecretBytes);
  expect(
    (
      await lstat(
        path.join(backupDirectory, "private-source-connections", "tmdb.json"),
      )
    ).mode & 0o777,
  ).toBe(0o600);
  expect(
    await readFile(
      path.join(
        backupDirectory,
        "managed-artifacts",
        "maintenance-rehearsal.bin",
      ),
    ),
  ).toEqual(Buffer.from(managedArtifactBytes));
  expect(
    (
      await lstat(
        path.join(
          backupDirectory,
          "managed-artifacts",
          "maintenance-rehearsal.bin",
        ),
      )
    ).mode & 0o777,
  ).toBe(0o640);

  await mkdir(restoredProductData);
  await writeFile(path.join(restoredProductData, "keep"), "do not replace");
  const invalidRestore = await runMaintenance([
    "offline-restore",
    "--backup-directory",
    backupDirectory,
    "--product-data",
    restoredProductData,
  ]);
  expect(invalidRestore.code).toBe(1);
  expect(invalidRestore.stdout).not.toContain("离线恢复完成");
  await expect(
    readFile(path.join(restoredProductData, "keep"), "utf8"),
  ).resolves.toBe("do not replace");
  await rm(restoredProductData, { recursive: true });

  const incompleteBackup = path.join(workspace, "incomplete-backup");
  const failedProductData = path.join(workspace, "failed-product-data");
  await mkdir(incompleteBackup);
  await mkdir(failedProductData);
  const failedRestore = await runMaintenance([
    "offline-restore",
    "--backup-directory",
    incompleteBackup,
    "--product-data",
    failedProductData,
  ]);
  expect(failedRestore.code).toBe(1);
  expect(failedRestore.stderr).toContain("备份源缺少产品 Catalogue");
  expect(failedRestore.stdout).not.toContain("离线恢复完成");
  expect(await readdir(failedProductData)).toEqual([
    "runtime-state",
    "staging",
  ]);
  await rm(failedProductData, { recursive: true });

  await mkdir(restoredProductData);

  const restored = await runMaintenance([
    "offline-restore",
    "--backup-directory",
    backupDirectory,
    "--product-data",
    restoredProductData,
  ]);
  expect(restored.code).toBe(0);
  expect(restored.stdout).toContain("离线恢复完成");
  expect(`${restored.stdout}\n${restored.stderr}`).not.toContain(secret);
  expect(
    await readFile(
      path.join(
        restoredProductData,
        "managed-artifacts",
        "maintenance-rehearsal.bin",
      ),
    ),
  ).toEqual(Buffer.from(managedArtifactBytes));
  expect(
    (
      await lstat(
        path.join(
          restoredProductData,
          "managed-artifacts",
          "maintenance-rehearsal.bin",
        ),
      )
    ).mode & 0o777,
  ).toBe(0o640);
  expect(await digestDirectory(observedRoot)).toBe(observedDigest);
  await rm(sourceProductData, { recursive: true });

  service = await startProductService(restoredProductData, sourceIo);
  client = createPublicApiClient({ baseUrl: service.baseUrl });
  await expect(client.listAssetLibraries()).resolves.toMatchObject({
    items: [library],
  });
  const restoredAssets = await client.listAssets({
    assetLibraryId: library.id,
    limit: 100,
  });
  const restoredCover = await readPrimaryCover(restoredAssets);
  expect(restoredCover.address).toBe(sourceCover.address);
  expect(restoredCover.bytes).toEqual(sourceCover.bytes);
  expect(restoredCover.revisionBytes).toEqual(sourceCover.revisionBytes);
  expect(restoredAssets).toEqual(sourceAssets);
  await expect(
    client.inspectAssetLibraryScan(startedScan.parentExecutionId),
  ).resolves.toEqual(acceptedScan);
  await expect(
    client.inspectExecution(startedScan.parentExecutionId),
  ).resolves.toEqual(acceptedExecution);
  const restoredConnections = await client.listSourceConnections();
  expect(restoredConnections).toEqual(sourceConnections);
  expect(JSON.stringify(restoredConnections)).not.toContain(secret);

  const refreshed = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(refreshed.parentExecutionId))
          .status,
      { timeout: 120_000 },
    )
    .toBe("completed");
  const refreshedScan = await client.inspectAssetLibraryScan(
    refreshed.parentExecutionId,
  );
  expect(refreshedScan).toMatchObject({ outcome: "no-change" });
  await expect(
    client.listAssets({ assetLibraryId: library.id, limit: 100 }),
  ).resolves.toEqual(sourceAssets);
  await service.close();
}, 180_000);

async function startProductService(
  productDataDirectory: string,
  sourceIo: ProductSourceIo,
): Promise<{ readonly baseUrl: URL; close(): Promise<void> }> {
  const bootstrap = await createProductService({
    productDataDirectory,
    environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
    sourceIo,
  });
  const server = serve({
    fetch: bootstrap.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  const service = { server, abort: () => bootstrap.abort() };
  services.push(service);
  await server.ready();
  bootstrap.publish();
  const baseUrl = new URL(server.url!);
  await expect
    .poll(
      async () => {
        const response = await fetch(new URL("/api/ready", baseUrl), {
          signal: AbortSignal.timeout(1_000),
        });
        return {
          status: response.status,
          body: await response.json(),
        };
      },
      { timeout: 30_000, interval: 100 },
    )
    .toMatchObject({ status: 200, body: { ok: true } });
  return {
    baseUrl,
    async close() {
      const index = services.indexOf(service);
      if (index !== -1) services.splice(index, 1);
      await server.close(true);
      await bootstrap.abort();
    },
  };
}

async function runMaintenance(args: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [maintenanceEntry, ...args], {
    cwd: packageDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function digestDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  await visit(directory);
  for (const file of files.toSorted()) {
    hash.update(path.relative(directory, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}
