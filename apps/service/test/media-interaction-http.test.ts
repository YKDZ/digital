import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProductConfiguration } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import { createPublicApiClient } from "@digital/public-api";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
} from "@digital/test-support/source-io";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { createProductService } from "../src/service.ts";

const running: Array<{
  readonly server: Awaited<ReturnType<typeof serve>>;
  readonly abort: () => Promise<void>;
}> = [];
const temporaryRoots: string[] = [];
const materialFixture = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/material"),
);
const sourceManifest = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/manifest.json"),
);
const sourceResponses = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/responses"),
);

afterEach(async () => {
  for (const item of running.splice(0).reverse()) {
    await item.server.close(true);
    await item.abort();
  }
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("通过公共 HTTP 读取正式扫描材料、播放计划、托管封面和实例交互状态", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc19-media-http-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialRoot = path.join(root, "普通收藏");
  await cp(
    path.join(materialFixture, "RJ01029383"),
    path.join(materialRoot, "RJ01029383"),
    { recursive: true },
  );
  const materialPath = path.join(
    materialRoot,
    "RJ01029383",
    "おまけ音声",
    "12++_おまけ。30秒の寝息を30分ループ.wav",
  );
  const fixtureWav = await readFile(materialPath);
  const expandedWav = Buffer.alloc(512 * 1024);
  fixtureWav.copy(expandedWav, 0, 0, 44);
  expandedWav.writeUInt32LE(expandedWav.byteLength - 8, 4);
  expandedWav.writeUInt32LE(expandedWav.byteLength - 44, 40);
  await writeFile(materialPath, expandedWav);
  await prepareProductionCatalogue({ productDataDirectory });
  const controlled = await loadControlledSourceIo({
    manifestPath: sourceManifest,
  });
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: controlled.request,
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
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
  running.push({ server, abort: () => bootstrap.abort() });
  await server.ready();
  bootstrap.publish();
  const baseUrl = new URL(server.url!);
  const client = createPublicApiClient({ baseUrl });
  const missingManagedArtifact = await client.readManagedArtifact(
    "0".repeat(64),
  );
  expect(missingManagedArtifact.status).toBe(503);
  expect(await missingManagedArtifact.json()).toEqual({
    error: { code: "unavailable", message: "媒体服务暂时不可用" },
  });
  const invalidRevision = await fetch(
    new URL("/api/v1/media/artifact-revisions/%5C", baseUrl),
  );
  expect(invalidRevision.status).toBe(400);
  expect(await invalidRevision.json()).toEqual({
    error: { code: "invalid-request", message: "媒体请求格式无效" },
  });
  const library = await client.saveAssetLibrary({
    displayName: "媒体验收普通目录",
    directories: [materialRoot],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () => {
        return (await client.inspectAssetLibraryScan(scan.parentExecutionId))
          .status;
      },
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");
  const assets = await client.listAssets({
    assetLibraryId: library.id,
    limit: 100,
  });
  const asset = assets.items.find(({ locations }) =>
    locations.some(({ address }) => address.includes("RJ01029383")),
  );
  expect(asset).toBeDefined();
  const wavLocation = asset!.locations.find(
    ({ kind, address }) =>
      kind === "observed" &&
      address.endsWith("12++_おまけ。30秒の寝息を30分ループ.wav"),
  );
  expect(wavLocation).toBeDefined();
  const originalWav = await readFile(materialPath);
  const artworkLocation = asset!.locations.find(
    ({ kind, address }) =>
      kind === "observed" && address.endsWith("裏世界少女2_イラスト.png"),
  );
  expect(artworkLocation).toBeDefined();
  const observedArtworkBytes = await readFile(
    path.join(
      materialRoot,
      "RJ01029383",
      "イラスト、台本",
      "裏世界少女2_イラスト.png",
    ),
  );
  const observedResponse = await client.readObservedMaterial(
    asset!.id,
    artworkLocation!.id,
    { assetLibraryId: library.id, range: "bytes=0-3" },
  );
  expect(observedResponse.status).toBe(206);
  expect(Buffer.from(await observedResponse.arrayBuffer())).toEqual(
    observedArtworkBytes.subarray(0, 4),
  );

  const confirmed = await client.confirmObservedMaterial(
    asset!.id,
    wavLocation!.id,
    library.id,
  );
  const revisionId = confirmed.artifactRevisionId;
  const malformedPlaybackDigest = await fetch(
    new URL(
      `/api/v1/media/playback-media/${encodeURIComponent(revisionId)}/invalid`,
      baseUrl,
    ),
  );
  expect(malformedPlaybackDigest.status).toBe(400);
  expect(await malformedPlaybackDigest.json()).toEqual({
    error: { code: "invalid-request", message: "媒体请求格式无效" },
  });

  const plan = await client.createPlaybackPlan(
    revisionId,
    {
      consumer: {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "audio/wav", codecs: ["pcm"] }],
      },
      preferences: {},
    },
    library.id,
  );
  expect(plan).toMatchObject({
    status: "ready",
    blobDigest: expect.any(String),
  });
  const rangeResponse = await client.readArtifactRevision(revisionId, {
    assetLibraryId: library.id,
    range: "bytes=0-43",
  });
  expect(rangeResponse.status).toBe(206);
  expect(Buffer.from(await rangeResponse.arrayBuffer())).toEqual(
    originalWav.subarray(0, 44),
  );

  const playbackRange = await client.readPlaybackMedia(
    revisionId,
    confirmed.blobDigest,
    { assetLibraryId: library.id, range: "bytes=100-107" },
  );
  expect(playbackRange.status).toBe(206);
  expect(playbackRange.headers.get("content-range")).toBe(
    `bytes 100-107/${String(originalWav.byteLength)}`,
  );
  expect(Buffer.from(await playbackRange.arrayBuffer())).toEqual(
    originalWav.subarray(100, 108),
  );
  const etag = `"sha256:${confirmed.blobDigest}"`;
  const notModified = await client.readPlaybackMedia(
    revisionId,
    confirmed.blobDigest,
    { assetLibraryId: library.id, ifNoneMatch: etag },
  );
  expect(notModified.status).toBe(304);
  const preconditionFailed = await client.readPlaybackMedia(
    revisionId,
    confirmed.blobDigest,
    { assetLibraryId: library.id, ifMatch: '"other"' },
  );
  expect(preconditionFailed.status).toBe(412);
  const unsatisfiedRange = await client.readArtifactRevision(revisionId, {
    assetLibraryId: library.id,
    range: `bytes=${String(originalWav.byteLength)}-`,
  });
  expect(unsatisfiedRange.status).toBe(416);

  const cover = asset!.descriptions
    .flatMap(({ artifactRoles }) => artifactRoles)
    .find(({ role, address }) => role === "asset.primary-cover" && address);
  expect(cover).not.toHaveProperty("observedArtifactParts");
  expect(cover?.address).toMatch(
    /^\/api\/v1\/media\/managed-artifacts\/[a-f0-9]{64}$/u,
  );
  const digest = cover!.address!.split("/").at(-1)!;
  const coverResponse = await client.readManagedArtifact(digest);
  expect(coverResponse.status).toBe(200);
  expect(coverResponse.headers.get("content-type")).toBe("image/jpeg");
  const coverBytes = await coverResponse.arrayBuffer();
  expect(Buffer.from(coverBytes)).toEqual(
    await readFile(path.join(sourceResponses, "RJ01029383-cover.jpg")),
  );

  const incompatible = await client.createPlaybackPlan(
    revisionId,
    {
      consumer: {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "audio/wav", codecs: ["unsupported"] }],
      },
      preferences: {},
    },
    library.id,
  );
  expect(incompatible).toMatchObject({
    status: "incompatible",
  });
  const unavailablePreference = await client.createPlaybackPlan(
    revisionId,
    {
      consumer: {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "audio/wav", codecs: ["pcm"] }],
      },
      preferences: { audioTrackId: "missing-track" },
    },
    library.id,
  );
  expect(unavailablePreference).toEqual({
    status: "incompatible",
    reason: "preference-unavailable",
  });

  expect(await client.readPlaybackInteractions([revisionId])).toEqual([]);
  await client.savePlaybackInteraction({
    artifactRevisionId: revisionId,
    positionMilliseconds: 2_500,
    completed: false,
  });
  const anotherClient = createPublicApiClient({ baseUrl });
  expect(await anotherClient.readPlaybackInteractions([revisionId])).toEqual([
    {
      artifactRevisionId: revisionId,
      positionMilliseconds: 2_500,
      completed: false,
    },
  ]);

  const controller = new AbortController();
  const cancellable = await client.readArtifactRevision(revisionId, {
    assetLibraryId: library.id,
    range: "bytes=0-524287",
    signal: controller.signal,
  });
  const reader = cancellable.body!.getReader();
  const firstChunk = await reader.read();
  expect(firstChunk.value!.byteLength).toBeGreaterThan(0);
  controller.abort();
  await expect(reader.read()).rejects.toThrow();

  const changedWav = originalWav.slice();
  changedWav[100] = changedWav[100]! ^ 1;
  await writeFile(materialPath, changedWav);
  const expiredRevision = await client.readArtifactRevision(revisionId, {
    assetLibraryId: library.id,
  });
  expect(expiredRevision.status).toBe(409);
  await writeFile(materialPath, originalWav);
  await client.removeAssetLibrary({
    id: library.id,
    expectedVersion: library.configVersion,
  });
  const revokedRevision = await client.readArtifactRevision(revisionId, {
    assetLibraryId: library.id,
  });
  expect(revokedRevision.status).toBe(409);
});
