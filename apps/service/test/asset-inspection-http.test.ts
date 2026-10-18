import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { ProductConfiguration } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import {
  createPublicApiClient,
  type PublicCurrentAsset,
} from "@digital/public-api";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
} from "@digital/test-support/source-io";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { createProductService } from "../src/service.ts";
import {
  startInteractiveTerminal,
  type InteractiveTerminalSession,
} from "./interactive-terminal.ts";

const running: Array<{
  readonly server: Awaited<ReturnType<typeof serve>>;
  readonly abort: () => Promise<void>;
}> = [];
const temporaryRoots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
const materialFixture = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/material"),
);
const sourceManifest = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/manifest.json"),
);
const movieMaterialFixture = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/publication-screen/material"),
);
const animeMaterialFixture = path.join(movieMaterialFixture, "anime");
const movieSourceManifest = fileURLToPath(
  import.meta
    .resolve("@digital/preview-corpus/publication-screen/manifest.json"),
);
const movieSourceResponses = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/publication-screen/responses"),
);
const serviceRoot = fileURLToPath(new URL("../", import.meta.url));

afterEach(async () => {
  for (const child of children.splice(0).reverse()) {
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
  for (const item of running.splice(0).reverse()) {
    await item.server.close(true);
    await item.abort();
  }
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("经真实服务检查普通目录形成的资产及依据、修订与历史", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc08-asset-inspection-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialRoot = path.join(root, "我的收藏");
  const workDirectory = path.join(materialRoot, "声音", "2025", "RJ01029383");
  await mkdir(path.dirname(workDirectory), { recursive: true });
  await cp(path.join(materialFixture, "RJ01029383"), workDirectory, {
    recursive: true,
  });
  const ordinaryNotes = path.join(materialRoot, "普通文件夹", "说明.txt");
  await mkdir(path.dirname(ordinaryNotes), { recursive: true });
  await writeFile(ordinaryNotes, "这是与作品并存的普通目录说明。\n");

  const bookRoot = path.join(root, "普通出版物");
  await mkdir(bookRoot, { recursive: true });
  await writeFile(
    path.join(bookRoot, "一本书.pdf"),
    syntheticPdf({ author: "普通目录中的作者", pageCount: 1 }),
  );

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

  const library = await client.saveAssetLibrary({
    displayName: "资料检查普通目录",
    directories: [materialRoot],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const started = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(started.parentExecutionId))
          .status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");

  const assetPage = await client.listAssets({
    assetLibraryId: library.id,
    limit: 100,
  });
  const asset = assetPage.items.find(({ locations }) =>
    locations.some(({ address }) => address.includes("RJ01029383")),
  );
  expect(asset).toBeDefined();
  const assetId = asset!.id;

  const overview = await client.inspectAssetEvidence(assetId);
  expect(overview.sections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "local-observations",
        status: "available",
      }),
      expect.objectContaining({ kind: "source-records", status: "available" }),
      expect.objectContaining({
        kind: "interpreted-facts",
        status: "available",
      }),
      expect.objectContaining({ kind: "current-values", status: "available" }),
    ]),
  );

  const readAll = async (
    kind: Parameters<typeof client.listAssetEvidence>[1]["kind"],
  ) => {
    const items: Array<
      Awaited<ReturnType<typeof client.listAssetEvidence>>["items"][number]
    > = [];
    let cursor: string | undefined;
    do {
      const page = await client.listAssetEvidence(assetId, {
        kind,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  };
  const [
    observations,
    formats,
    sourceRecords,
    interpretedFacts,
    currentValues,
  ] = await Promise.all([
    readAll("local-observations"),
    readAll("format-results"),
    readAll("source-records"),
    readAll("interpreted-facts"),
    readAll("current-values"),
  ]);
  expect(observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "local-observation",
        relativePath: expect.stringContaining("RJ01029383"),
      }),
    ]),
  );
  expect(formats).toEqual([]);
  expect(
    interpretedFacts.some((item) => item.kind === "interpreted-fact"),
  ).toBe(true);
  expect(currentValues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "current-value" }),
    ]),
  );
  expect(sourceRecords).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "source-record", status: "available" }),
    ]),
  );

  const books = await client.saveAssetLibrary({
    displayName: "格式检查资料库",
    directories: [bookRoot],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  const bookScan = await client.startAssetLibraryScan(books.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(bookScan.parentExecutionId))
          .status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");
  const book = await client.listAssets({ assetLibraryId: books.id, limit: 10 });
  expect(book.items).toHaveLength(1);
  const bookFormats = await client.listAssetEvidence(book.items[0]!.id, {
    kind: "format-results",
    limit: 100,
  });
  expect(bookFormats.status).toBe("available");
  expect(bookFormats.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "format-result",
        format: "artifact-format-inspection",
        detail: expect.objectContaining({ kind: "metadata" }),
      }),
    ]),
  );

  const firstSource = sourceRecords.find(
    (item) => item.kind === "source-record" && item.status === "available",
  );
  expect(firstSource?.kind).toBe("source-record");
  if (firstSource?.kind !== "source-record")
    throw new Error("扫描没有留下可读的来源记录");
  const firstChunk = await client.readAssetSourceRecord(
    assetId,
    firstSource.id,
    {
      offset: 0,
      limit: 23,
    },
  );
  expect(firstChunk.record.id).toBe(firstSource.id);
  expect(firstChunk.content.length).toBeGreaterThan(0);
  expect(firstChunk).not.toHaveProperty("record.body");

  const historyEntries: Awaited<
    ReturnType<typeof client.listWorkflowHistory>
  >["items"][number][] = [];
  let historyCursor: string | undefined;
  do {
    const page = await client.listWorkflowHistory({
      limit: 1,
      ...(historyCursor === undefined ? {} : { cursor: historyCursor }),
    });
    historyEntries.push(...page.items);
    historyCursor = page.nextCursor;
  } while (historyCursor !== undefined);
  expect(historyEntries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        resultReferences: expect.objectContaining({
          acceptedAssetIds: expect.arrayContaining([assetId]),
        }),
      }),
    ]),
  );
  const attention = await client.listCurrentAttention({ limit: 1 });
  expect(attention.items).toBeDefined();

  const missingAsset = await fetch(
    new URL("/api/v1/assets/no-such-asset/inspection", baseUrl),
  );
  expect(missingAsset.status).toBe(404);
  const invalidPage = await fetch(
    new URL(
      `/api/v1/assets/${encodeURIComponent(assetId)}/inspection/evidence/local-observations?limit=0`,
      baseUrl,
    ),
  );
  expect(invalidPage.status).toBe(400);
  const unrelatedSource = await fetch(
    new URL(
      `/api/v1/assets/${encodeURIComponent(assetId)}/inspection/source-records/not-linked`,
      baseUrl,
    ),
  );
  expect(unrelatedSource.status).toBe(404);

  const titleItem = currentValues.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  if (titleItem?.kind !== "current-value")
    throw new Error("普通目录样例没有标题裁决");
  const pinDecision = await client.prepareMetadataDecision(assetId, {
    kind: "pin",
    property: "asset.title",
    value: "普通目录人工标题",
  });
  await expect(
    client.confirmMetadataDecision(pinDecision.previewId),
  ).resolves.toMatchObject({ status: "applied" });
  const clearDecision = await client.prepareMetadataDecision(assetId, {
    kind: "clear",
    property: "asset.title",
  });
  await expect(
    client.confirmMetadataDecision(clearDecision.previewId),
  ).resolves.toMatchObject({ status: "applied" });
  await expect(
    client.listAssetEvidence(assetId, {
      kind: "metadata-decisions",
      limit: 20,
    }),
  ).resolves.toMatchObject({
    items: [
      expect.objectContaining({ decision: "pin", current: false }),
      expect.objectContaining({ decision: "clear", current: true }),
    ],
  });
}, 180_000);

it("从当前两季作品关系追溯来源记录，且不开放无关资产的来源资料", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc08-sequel-provenance-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialRoot = path.join(root, "anime");
  await mkdir(materialRoot, { recursive: true });
  const bloomDirectory = "终将成为你 (2018)";
  const frierenDirectory = "葬送的芙莉莲 (2023)";
  await cp(
    path.join(animeMaterialFixture, bloomDirectory),
    path.join(materialRoot, bloomDirectory),
    { recursive: true },
  );
  await cp(
    path.join(animeMaterialFixture, frierenDirectory, "Season 1"),
    path.join(materialRoot, frierenDirectory, "Season 1"),
    { recursive: true },
  );

  const controlled = await loadControlledSourceIo({
    manifestPath: movieSourceManifest,
  });
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: controlled.request,
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  const baseUrl = await startInspectionService(productDataDirectory, sourceIo);
  const client = createPublicApiClient({ baseUrl });
  const callbackUrl = new URL(
    "/api/v1/source-connections/bangumi/callback",
    baseUrl,
  );
  await client.configureBangumiOAuthClient({
    clientId: "controlled-sequel-provenance-client",
    clientSecret: "controlled-sequel-provenance-secret",
    redirectUri: callbackUrl.toString(),
  });
  const authorization = await client.beginBangumiAuthorization();
  const state = new URL(authorization.authorizationUrl).searchParams.get(
    "state",
  );
  if (state === null) throw new Error("授权请求没有返回状态值");
  callbackUrl.searchParams.set("code", "controlled-sequel-provenance-code");
  callbackUrl.searchParams.set("state", state);
  expect((await fetch(callbackUrl)).status).toBe(200);
  await expect(client.getSourceConnection("bangumi")).resolves.toMatchObject({
    availability: "available",
  });

  const library = await client.saveAssetLibrary({
    displayName: "两季关系来源依据",
    directories: [materialRoot],
    recognitionProfileIds: ["anime"],
    sourceIdentities: ["bangumi"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");
  await cp(
    path.join(animeMaterialFixture, frierenDirectory, "Season 2"),
    path.join(materialRoot, frierenDirectory, "Season 2"),
    { recursive: true },
  );
  const nextScan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(nextScan.parentExecutionId))
          .status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");

  const assets = await client.listAssets({
    assetLibraryId: library.id,
    limit: 100,
  });
  const relatedAsset = assets.items.find(
    (asset) =>
      asset.locations.some(({ address }) => address.includes("S01E01")) &&
      asset.relationships.some(
        (relationship) =>
          relationship.type === "bangumi.subject.related" &&
          relationship.participants.some(
            ({ role }) => role === "bangumi.subject.predecessor",
          ) &&
          relationship.participants.some(
            ({ role }) => role === "bangumi.subject.sequel",
          ),
      ),
  );
  expect(relatedAsset).toBeDefined();
  if (relatedAsset === undefined)
    throw new Error("控制语料没有形成跨季作品关系");
  const sequel = relatedAsset.relationships.find(
    (relationship) =>
      relationship.type === "bangumi.subject.related" &&
      relationship.participants.some(
        ({ role }) => role === "bangumi.subject.predecessor",
      ) &&
      relationship.participants.some(
        ({ role }) => role === "bangumi.subject.sequel",
      ),
  );
  expect(sequel).toBeDefined();
  if (sequel === undefined) throw new Error("跨季作品关系没有公开投影");
  expect(sequel.sourceRecordIds.length).toBeGreaterThan(0);

  const relatedSourceRecords = await client.listAssetEvidence(relatedAsset.id, {
    kind: "source-records",
    limit: 100,
  });
  expect(relatedSourceRecords.status).toBe("available");
  const sequelAsset = assets.items.find((asset) =>
    asset.locations.some(({ address }) => address.includes("S02E01")),
  );
  expect(sequelAsset).toBeDefined();
  if (sequelAsset === undefined)
    throw new Error("当前关系没有对应的第二季目标资产");
  const sequelEvidence = await client.listAssetEvidence(sequelAsset.id, {
    kind: "source-records",
    limit: 100,
  });
  expect(sequelEvidence.items).toEqual(
    expect.arrayContaining(
      sequel.sourceRecordIds.map((id) =>
        expect.objectContaining({
          kind: "source-record",
          id,
          status: "available",
        }),
      ),
    ),
  );
  const assetSourceRecordIds = new Set(
    relatedSourceRecords.items.flatMap((item) =>
      item.kind === "source-record" ? [item.id] : [],
    ),
  );
  expect([...assetSourceRecordIds]).toEqual(
    expect.arrayContaining(sequel.sourceRecordIds),
  );
  for (const sourceRecordId of sequel.sourceRecordIds) {
    const chunk = await client.readAssetSourceRecord(
      relatedAsset.id,
      sourceRecordId,
      { offset: 0, limit: 64 },
    );
    expect(chunk.record.id).toBe(sourceRecordId);
    expect(chunk.content.length).toBeGreaterThan(0);
  }

  const unrelatedAsset = assets.items.find((asset) =>
    asset.locations.some(({ address }) => address.includes("终将成为你")),
  );
  expect(unrelatedAsset).toBeDefined();
  if (unrelatedAsset === undefined)
    throw new Error("同一扫描没有形成无关作品资产");
  const unrelatedEvidence = await client.listAssetEvidence(unrelatedAsset.id, {
    kind: "source-records",
    limit: 100,
  });
  const unrelatedRecordId = unrelatedEvidence.items.find(
    (item) =>
      item.kind === "source-record" && !assetSourceRecordIds.has(item.id),
  );
  expect(unrelatedRecordId?.kind).toBe("source-record");
  if (unrelatedRecordId?.kind !== "source-record")
    throw new Error("无关资产没有独立来源记录");
  const unrelatedRead = await fetch(
    new URL(
      `/api/v1/assets/${encodeURIComponent(relatedAsset.id)}/inspection/source-records/${encodeURIComponent(unrelatedRecordId.id)}`,
      baseUrl,
    ),
  );
  expect(unrelatedRead.status).toBe(404);
}, 180_000);

it("经已验证的正式来源扫描和刷新读取当前采用依据、未采用候选与历史记录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc08-fact-history-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const controlledDirectory = path.join(root, "controlled-source");
  await mkdir(controlledDirectory, { recursive: true });
  await cp(movieSourceResponses, path.join(controlledDirectory, "responses"), {
    recursive: true,
  });

  const tmdbToken = "controlled-tmdb-fact-history-token";
  const omdbKey = "controlled-omdb-fact-history-key";
  let controlled = await loadMovieSourceIo({
    controlledDirectory,
    tmdbToken,
    omdbKey,
    tmdbTitle: "恐怖直播",
  });
  let nextSourceGate:
    | {
        readonly markEntered: () => void;
        readonly released: Promise<void>;
        readonly release: () => void;
      }
    | undefined;
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: async (input, init) => {
      const gate = nextSourceGate;
      if (gate !== undefined) {
        nextSourceGate = undefined;
        gate.markEntered();
        await gate.released;
      }
      return await controlled.request(input, init);
    },
    sessionTransport: refusingSessionTransport(),
  };

  await prepareProductionCatalogue({ productDataDirectory });
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

  await expect(
    client.configureSourceConnection({
      sourceId: "tmdb",
      expectedVersion: 0,
      secret: tmdbToken,
    }),
  ).resolves.toMatchObject({ verification: "verified" });
  await expect(
    client.configureSourceConnection({
      sourceId: "omdb",
      expectedVersion: 0,
      secret: omdbKey,
    }),
  ).resolves.toMatchObject({ verification: "verified" });

  const materialDirectory = path.join(root, "普通影视目录", "恐怖直播 (2013)");
  await cp(
    path.join(movieMaterialFixture, "films", "恐怖直播 (2013)"),
    materialDirectory,
    { recursive: true },
  );
  const library = await client.saveAssetLibrary({
    displayName: "正式来源证据影视库",
    directories: [path.dirname(materialDirectory)],
    recognitionProfileIds: ["movies"],
    sourceIdentities: ["tmdb", "omdb"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");
  const scanInspection = await client.inspectExecution(scan.parentExecutionId);
  if (scanInspection.kind !== "asset-library-scan")
    throw new Error("正式扫描没有形成资产库扫描检查记录");
  const scanChild = scanInspection.children.find(
    (child) => child.status === "available",
  );
  if (scanChild?.status !== "available")
    throw new Error("正式扫描没有可检查的子执行");

  const listed = await client.listAssets({
    assetLibraryId: library.id,
    limit: 20,
  });
  expect(listed.items).toHaveLength(1);
  const assetId = listed.items[0]!.id;
  const initialFacts = await client.listAssetEvidence(assetId, {
    kind: "interpreted-facts",
    limit: 100,
  });
  const initialTitleFact = initialFacts.items.find(
    (item) =>
      item.kind === "interpreted-fact" &&
      item.property === "asset.title" &&
      item.value === "恐怖直播",
  );
  expect(initialTitleFact).toMatchObject({
    kind: "interpreted-fact",
    property: "asset.title",
    value: "恐怖直播",
    sourceIdentity: "tmdb",
    sourceSlot: "tmdb.movie.title",
    sourceRecordIds: [expect.any(String)],
  });
  if (initialTitleFact?.kind !== "interpreted-fact")
    throw new Error("正式扫描没有解释 TMDB 标题事实");
  const initialTitleRecordId = initialTitleFact.sourceRecordIds[0]!;

  const staleDecision = await client.prepareMetadataDecision(assetId, {
    kind: "pin",
    property: "asset.title",
    value: "不应覆盖来源更新的预演值",
  });
  expect(staleDecision).toMatchObject({
    status: "awaiting-confirmation",
    current: {
      status: "resolved",
      values: [{ value: "恐怖直播", sourceIdentity: "tmdb" }],
    },
    projected: {
      status: "resolved",
      values: [{ value: "不应覆盖来源更新的预演值", sourceIdentity: "user" }],
    },
  });

  const initialCurrent = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  const initialTitle = initialCurrent.items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(initialTitle).toMatchObject({
    kind: "current-value",
    evidence: {
      property: "asset.title",
      result: {
        status: "resolved",
        values: [
          {
            property: "asset.title",
            value: "恐怖直播",
            sourceIdentity: "tmdb",
            reasoning: { kind: "source-preference", preferredSource: "tmdb" },
            sourceRecordIds: [initialTitleRecordId],
          },
        ],
        notSelected: [
          {
            value: "The Terror Live",
            sourceIdentity: "omdb",
            exclusion: {
              kind: "source-preference",
              selectedSource: "tmdb",
              disagreesWithSelected: true,
            },
          },
        ],
      },
    },
  });
  const initialRecords = await client.listAssetEvidence(assetId, {
    kind: "source-records",
    limit: 100,
  });
  expect(initialRecords.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "source-record",
        id: initialTitleRecordId,
        status: "available",
        sourceIdentity: "tmdb",
        nativeAddress: "https://www.themoviedb.org/movie/209764",
        coverage: expect.objectContaining({
          completeness: "complete",
          authority: "official",
        }),
      }),
    ]),
  );
  const priorHistory = await client.listWorkflowHistory({ limit: 100 });
  const initialScanHistory = priorHistory.items.find(
    ({ execution }) => execution.id === scanChild.executionId,
  );
  expect(initialScanHistory).toMatchObject({
    execution: { id: scanChild.executionId, operationKind: "scan-filesystem" },
    resultReferences: {
      acceptedAssetIds: expect.arrayContaining([assetId]),
      sourceRecordIds: expect.arrayContaining([initialTitleRecordId]),
    },
  });

  controlled = await loadMovieSourceIo({
    controlledDirectory,
    tmdbToken,
    omdbKey,
    tmdbTitle: "恐怖直播·资料复核",
  });
  const refresh = await client.startMetadataRefresh({ subjectId: assetId });
  await expect
    .poll(async () => (await client.inspectExecution(refresh.id)).status, {
      timeout: 120_000,
      interval: 200,
    })
    .toBe("completed");

  await expect(
    client.confirmMetadataDecision(staleDecision.previewId),
  ).resolves.toMatchObject({ status: "stale" });

  const updatedCurrent = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  const updatedTitle = updatedCurrent.items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(updatedTitle).toMatchObject({
    kind: "current-value",
    evidence: {
      property: "asset.title",
      result: {
        status: "resolved",
        values: [
          {
            property: "asset.title",
            value: "恐怖直播·资料复核",
            sourceIdentity: "tmdb",
            reasoning: { kind: "source-preference", preferredSource: "tmdb" },
          },
        ],
        notSelected: [expect.objectContaining({ value: "The Terror Live" })],
      },
    },
  });
  const currentRecords = await client.listAssetEvidence(assetId, {
    kind: "source-records",
    limit: 100,
  });
  const updatedTitleFact = (
    await client.listAssetEvidence(assetId, {
      kind: "interpreted-facts",
      limit: 100,
    })
  ).items.find(
    (item) =>
      item.kind === "interpreted-fact" &&
      item.property === "asset.title" &&
      item.value === "恐怖直播·资料复核",
  );
  expect(updatedTitleFact).toMatchObject({
    kind: "interpreted-fact",
    sourceIdentity: "tmdb",
    sourceRecordIds: [expect.any(String)],
  });
  if (updatedTitleFact?.kind !== "interpreted-fact")
    throw new Error("正式刷新没有保留更新后的解释事实");
  const updatedTitleRecordId = updatedTitleFact.sourceRecordIds[0]!;
  expect(updatedTitleRecordId).not.toBe(initialTitleRecordId);
  expect(updatedTitle).toMatchObject({
    kind: "current-value",
    evidence: {
      property: "asset.title",
      result: {
        values: [
          {
            value: "恐怖直播·资料复核",
            sourceIdentity: "tmdb",
            reasoning: { kind: "source-preference", preferredSource: "tmdb" },
            sourceRecordIds: [updatedTitleRecordId],
          },
        ],
        notSelected: [
          {
            value: "The Terror Live",
            sourceIdentity: "omdb",
            exclusion: {
              kind: "source-preference",
              selectedSource: "tmdb",
              disagreesWithSelected: true,
            },
          },
        ],
      },
    },
  });
  expect(currentRecords.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: updatedTitleRecordId,
        sourceIdentity: "tmdb",
      }),
    ]),
  );
  const originalRecordAfterRefresh = currentRecords.items.find(
    (item) => item.kind === "source-record" && item.id === initialTitleRecordId,
  );
  expect(originalRecordAfterRefresh).toMatchObject({
    kind: "source-record",
    status: "available",
    sourceIdentity: "tmdb",
  });
  const priorSource = await client.readAssetSourceRecord(
    assetId,
    initialTitleRecordId,
    { offset: 0, limit: 2048 },
  );
  expect(priorSource.content).toContain('"title":"恐怖直播"');
  expect(priorSource).not.toHaveProperty("record.body");
  const updatedSource = await client.readAssetSourceRecord(
    assetId,
    updatedTitleRecordId,
    { offset: 0, limit: 2048 },
  );
  expect(updatedSource.content).toContain('"title":"恐怖直播·资料复核"');

  const invalidAdoption = await fetch(
    new URL(
      `/api/v1/assets/${encodeURIComponent(assetId)}/metadata-decisions/previews`,
      baseUrl,
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "adopt",
        property: "asset.title",
        candidateReference: "metadata-candidate_not-a-current-conflict",
      }),
    },
  );
  expect(invalidAdoption.status).toBe(409);

  const emptyValue = await fetch(
    new URL(
      `/api/v1/assets/${encodeURIComponent(assetId)}/metadata-decisions/previews`,
      baseUrl,
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pin",
        property: "asset.title",
        value: "   ",
      }),
    },
  );
  expect(emptyValue.status).toBe(400);
  await expect(
    client.listAssetEvidence(assetId, {
      kind: "metadata-decisions",
      limit: 20,
    }),
  ).resolves.toMatchObject({ items: [] });

  const cancelledDecision = await client.prepareMetadataDecision(assetId, {
    kind: "pin",
    property: "asset.title",
    value: "取消后不能生效",
  });
  await expect(
    client.cancelMetadataDecision(cancelledDecision.previewId),
  ).resolves.toMatchObject({ status: "rejected" });
  await expect(
    client.listAssetEvidence(assetId, {
      kind: "metadata-decisions",
      limit: 20,
    }),
  ).resolves.toMatchObject({ items: [] });

  const failedPreparationDatabase = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  failedPreparationDatabase.exec(`
    CREATE TRIGGER reject_metadata_preview_insert
    BEFORE INSERT ON change_impact_previews
    WHEN json_extract(NEW.preview_json, '$.change.kind') = 'metadata-decision'
    BEGIN
      SELECT RAISE(ABORT, '数据库写入必须保密标记');
    END;
  `);
  expect(() =>
    failedPreparationDatabase
      .prepare(
        "INSERT INTO change_impact_previews (id, execution_id, asset_id, preview_json) VALUES (?, ?, ?, ?)",
      )
      .run(
        "trigger-check",
        "trigger-check",
        assetId,
        JSON.stringify({ change: { kind: "metadata-decision" } }),
      ),
  ).toThrow("数据库写入必须保密标记");
  try {
    const failedPreparation = await fetch(
      new URL(
        `/api/v1/assets/${encodeURIComponent(assetId)}/metadata-decisions/previews`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "pin",
          property: "asset.title",
          value: "数据库故障不能变成输入错误",
        }),
      },
    );
    const body = await failedPreparation.text();
    expect(failedPreparation.status).toBe(503);
    expect(body).toContain("暂时无法形成属性修订预演");
    expect(body).not.toContain("数据库写入必须保密标记");
    expect(body).not.toContain("SQLITE_CONSTRAINT_TRIGGER");
  } finally {
    failedPreparationDatabase.exec(
      "DROP TRIGGER reject_metadata_preview_insert",
    );
    failedPreparationDatabase.close();
  }

  const pinDecision = await client.prepareMetadataDecision(assetId, {
    kind: "pin",
    property: "asset.title",
    value: "固定人工标题",
  });
  expect(pinDecision).toMatchObject({
    current: {
      status: "resolved",
      values: [{ value: "恐怖直播·资料复核", sourceIdentity: "tmdb" }],
    },
    projected: {
      status: "resolved",
      values: [{ value: "固定人工标题", sourceIdentity: "user" }],
    },
  });
  const failedConfirmationDatabase = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  failedConfirmationDatabase.exec(`
    CREATE TRIGGER reject_metadata_decision_insert
    BEFORE INSERT ON metadata_decisions
    BEGIN
      SELECT RAISE(ABORT, '数据库决定写入必须保密标记');
    END;
  `);
  expect(() =>
    failedConfirmationDatabase
      .prepare(
        "INSERT INTO metadata_decisions (id, target_kind, target_entity_id, property, metadata_usage_context, kind, value, initiated_by) VALUES (?, 'entity', ?, 'asset.title', 'asset.ordinary', 'pin', '标题', 'tester')",
      )
      .run("trigger-check", assetId),
  ).toThrow("数据库决定写入必须保密标记");
  try {
    const failedConfirmation = await fetch(
      new URL(
        `/api/v1/metadata-decision-previews/${encodeURIComponent(pinDecision.previewId)}/confirm`,
        baseUrl,
      ),
      { method: "POST" },
    );
    const body = await failedConfirmation.text();
    expect(failedConfirmation.status).toBe(503);
    expect(body).toContain("暂时无法确认属性修订");
    expect(body).not.toContain("数据库决定写入必须保密标记");
    expect(body).not.toContain("SQLITE_CONSTRAINT_TRIGGER");
  } finally {
    failedConfirmationDatabase.exec(
      "DROP TRIGGER reject_metadata_decision_insert",
    );
    failedConfirmationDatabase.close();
  }
  await expect(
    client.confirmMetadataDecision(pinDecision.previewId),
  ).resolves.toMatchObject({ status: "applied" });
  const pinnedCurrent = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  expect(pinnedCurrent.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "current-value",
        evidence: {
          property: "asset.title",
          result: {
            status: "resolved",
            values: [
              expect.objectContaining({
                value: "固定人工标题",
                sourceIdentity: "user",
              }),
            ],
            notSelected: [],
          },
        },
      }),
    ]),
  );
  await expect(
    client.listAssetEvidence(assetId, {
      kind: "metadata-decisions",
      limit: 20,
    }),
  ).resolves.toMatchObject({
    items: [
      expect.objectContaining({
        kind: "metadata-decision",
        property: "asset.title",
        decision: "pin",
        value: "固定人工标题",
        current: true,
      }),
    ],
  });

  controlled = await loadMovieSourceIo({
    controlledDirectory,
    tmdbToken,
    omdbKey,
    tmdbTitle: "恐怖直播·再次更新",
  });
  const refreshWhilePinned = await client.startMetadataRefresh({
    subjectId: assetId,
  });
  await expect
    .poll(
      async () => (await client.inspectExecution(refreshWhilePinned.id)).status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");
  const refreshedWhilePinned = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  const refreshedPinnedTitle = refreshedWhilePinned.items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(refreshedPinnedTitle?.kind).toBe("current-value");
  if (refreshedPinnedTitle?.kind !== "current-value")
    throw new Error("来源刷新后没有读取到标题裁决");
  expect(refreshedPinnedTitle.evidence.result.status).toBe("resolved");
  if (refreshedPinnedTitle.evidence.result.status !== "resolved")
    throw new Error("固定人工标题没有维持为有效值");
  expect(
    refreshedPinnedTitle.evidence.result.values.map(
      ({ value, sourceIdentity }) => ({
        value,
        sourceIdentity,
      }),
    ),
  ).toEqual([{ value: "固定人工标题", sourceIdentity: "user" }]);

  const clearDecision = await client.prepareMetadataDecision(assetId, {
    kind: "clear",
    property: "asset.title",
  });
  expect(clearDecision).toMatchObject({
    kind: "clear",
    current: {
      status: "resolved",
      values: [{ value: "固定人工标题", sourceIdentity: "user" }],
    },
    projected: {
      status: "resolved",
      values: [{ value: "恐怖直播·再次更新", sourceIdentity: "tmdb" }],
    },
  });
  await expect(
    client.confirmMetadataDecision(clearDecision.previewId),
  ).resolves.toMatchObject({ status: "applied" });
  const afterClear = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  const clearedTitle = afterClear.items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(clearedTitle?.kind).toBe("current-value");
  if (clearedTitle?.kind !== "current-value")
    throw new Error("撤回修订后没有读取到标题裁决");
  expect(clearedTitle.evidence.result.status).toBe("resolved");
  if (clearedTitle.evidence.result.status !== "resolved")
    throw new Error("撤回修订后来源标题没有恢复");
  expect(
    clearedTitle.evidence.result.values.map(({ value, sourceIdentity }) => ({
      value,
      sourceIdentity,
    })),
  ).toEqual([{ value: "恐怖直播·再次更新", sourceIdentity: "tmdb" }]);
  await expect(
    client.listAssetEvidence(assetId, {
      kind: "metadata-decisions",
      limit: 20,
    }),
  ).resolves.toMatchObject({
    items: [
      expect.objectContaining({ decision: "pin", current: false }),
      expect.objectContaining({ decision: "clear", current: true }),
    ],
  });
  const sourceRecordAfterDecisions = await client.readAssetSourceRecord(
    assetId,
    initialTitleRecordId,
    { offset: 0, limit: 2048 },
  );
  expect(sourceRecordAfterDecisions.content).toContain('"title":"恐怖直播"');

  const historyAfterRefresh = await client.listWorkflowHistory({ limit: 100 });
  const initialHistoryAfterRefresh = historyAfterRefresh.items.find(
    ({ execution }) => execution.id === scanChild.executionId,
  );
  expect(initialHistoryAfterRefresh).toMatchObject({
    execution: { id: scanChild.executionId, operationKind: "scan-filesystem" },
    resultReferences: {
      acceptedAssetIds: expect.arrayContaining([assetId]),
      sourceRecordIds: expect.arrayContaining([initialTitleRecordId]),
    },
  });
  const refreshHistory = historyAfterRefresh.items.find(
    ({ execution }) => execution.id === refresh.id,
  );
  expect(refreshHistory).toMatchObject({
    execution: { id: refresh.id, operationKind: "refresh-metadata" },
    resultReferences: {
      acceptedAssetIds: expect.arrayContaining([assetId]),
      sourceRecordIds: expect.arrayContaining([updatedTitleRecordId]),
    },
  });

  let markSourceEntered!: () => void;
  let releaseSource!: () => void;
  const entered = new Promise<void>((resolve) => {
    markSourceEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseSource = resolve;
  });
  nextSourceGate = {
    markEntered: markSourceEntered,
    released,
    release: releaseSource,
  };
  const cancelledRefresh = await client.startMetadataRefresh({
    subjectId: assetId,
  });
  try {
    await entered;
    const cancellation = await client.cancelExecution(cancelledRefresh.id, {
      reason: "验证历史保留实际取消结局",
    });
    expect(cancellation.requestStatus).toBe("requested");
  } finally {
    releaseSource();
  }
  await expect
    .poll(
      async () => (await client.inspectExecution(cancelledRefresh.id)).outcome,
    )
    .toBe("cancelled");
  const cancelledHistory = await client.listWorkflowHistory({ limit: 100 });
  const cancelledHistoryIndex = cancelledHistory.items.findIndex(
    ({ execution }) => execution.id === cancelledRefresh.id,
  );
  expect(cancelledHistoryIndex).toBeGreaterThanOrEqual(0);
  expect(
    cancelledHistory.items[cancelledHistoryIndex]?.execution,
  ).toMatchObject({
    status: "failed",
    stage: "failed",
    outcome: "cancelled",
  });
}, 180_000);

it("真实 HTTP 通过当前 nbinet 多值冲突明确采纳候选并拒绝过期候选", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc09-metadata-conflict-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const controlledDirectory = path.join(root, "controlled-source");
  const responseDirectory = path.join(controlledDirectory, "responses");
  await mkdir(controlledDirectory, { recursive: true });
  await cp(movieSourceResponses, responseDirectory, { recursive: true });
  const controlledManifestPath = path.join(
    controlledDirectory,
    "manifest.json",
  );
  await cp(movieSourceManifest, controlledManifestPath);
  const nbinetResponsePath = path.join(responseDirectory, "epub-5-nbinet.json");
  const setNbinetTitles = async (titles: readonly string[]) => {
    const body = JSON.parse(await readFile(nbinetResponsePath, "utf8")) as {
      docs: Array<{ pnx: { display: { title: readonly string[] } } }>;
    };
    const first = body.docs[0];
    if (first === undefined) throw new Error("受控书目资料缺少记录");
    first.pnx.display.title = [...titles];
    await writeFile(nbinetResponsePath, JSON.stringify(body));
  };
  await setNbinetTitles(["幼女战记 第一册", "幼女战记·第一册"]);
  let controlled = await loadControlledSourceIo({
    manifestPath: controlledManifestPath,
  });
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: (input, init) => controlled.request(input, init),
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };

  await prepareProductionCatalogue({ productDataDirectory });
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

  const materialDirectory = path.join(root, "普通出版物", "幼女战记(1)");
  await cp(
    path.join(movieMaterialFixture, "books", "幼女战记(1)"),
    materialDirectory,
    { recursive: true },
  );
  const library = await client.saveAssetLibrary({
    displayName: "书目冲突受控变体",
    directories: [path.dirname(materialDirectory)],
    recognitionProfileIds: ["books"],
    sourceIdentities: ["nbinet"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");
  const assets = await client.listAssets({
    assetLibraryId: library.id,
    limit: 10,
  });
  expect(assets.items).toHaveLength(1);
  const assetId = assets.items[0]!.id;
  const initialValues = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  const initialTitle = initialValues.items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(initialTitle?.kind).toBe("current-value");
  if (
    initialTitle?.kind !== "current-value" ||
    initialTitle.evidence.result.status !== "conflict"
  )
    throw new Error("受控书目变体没有形成同一来源的真实标题冲突");
  expect(initialTitle.evidence.result).toMatchObject({
    kind: "metadata-value-conflict",
    candidates: [
      expect.objectContaining({
        value: "幼女战记 第一册",
        sourceIdentity: "nbinet",
      }),
      expect.objectContaining({
        value: "幼女战记·第一册",
        sourceIdentity: "nbinet",
      }),
    ],
  });
  const initialCandidate = initialTitle.evidence.result.candidates.find(
    (candidate) => candidate.value === "幼女战记·第一册",
  );
  if (initialCandidate?.reference === undefined)
    throw new Error("当前标题冲突候选缺少选择引用");
  const cancelledAdoption = await client.prepareMetadataDecision(assetId, {
    kind: "adopt",
    property: "asset.title",
    candidateReference: initialCandidate.reference,
  });
  await expect(
    client.cancelMetadataDecision(cancelledAdoption.previewId),
  ).resolves.toMatchObject({ status: "rejected" });
  const unchangedAfterCancellation = (
    await client.listAssetEvidence(assetId, {
      kind: "current-values",
      limit: 100,
    })
  ).items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(unchangedAfterCancellation).toMatchObject({
    kind: "current-value",
    evidence: { property: "asset.title", result: { status: "conflict" } },
  });
  const staleAdoption = await client.prepareMetadataDecision(assetId, {
    kind: "adopt",
    property: "asset.title",
    candidateReference: initialCandidate.reference,
  });
  expect(staleAdoption).toMatchObject({
    status: "awaiting-confirmation",
    current: { status: "conflict" },
    projected: {
      status: "resolved",
      values: [{ value: "幼女战记·第一册", sourceIdentity: "user" }],
    },
    adoptedFromSourceIdentity: "nbinet",
  });
  const adoptedFirstCandidate = await client.prepareMetadataDecision(assetId, {
    kind: "adopt",
    property: "asset.title",
    candidateReference: initialCandidate.reference,
  });
  await expect(
    client.confirmMetadataDecision(adoptedFirstCandidate.previewId),
  ).resolves.toMatchObject({ status: "applied" });

  await setNbinetTitles(["幼女战记 第一册新版", "幼女战记·第一册新版"]);
  controlled = await loadControlledSourceIo({
    manifestPath: controlledManifestPath,
  });
  const refresh = await client.startMetadataRefresh({ subjectId: assetId });
  await expect
    .poll(async () => (await client.inspectExecution(refresh.id)).status, {
      timeout: 120_000,
      interval: 200,
    })
    .toBe("completed");
  await expect(
    client.confirmMetadataDecision(staleAdoption.previewId),
  ).resolves.toMatchObject({ status: "stale" });

  const clearFirstCandidate = await client.prepareMetadataDecision(assetId, {
    kind: "clear",
    property: "asset.title",
  });
  expect(clearFirstCandidate).toMatchObject({
    current: { status: "resolved" },
    projected: { status: "conflict" },
  });
  await expect(
    client.confirmMetadataDecision(clearFirstCandidate.previewId),
  ).resolves.toMatchObject({ status: "applied" });

  const refreshedValues = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  const refreshedTitle = refreshedValues.items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(refreshedTitle?.kind).toBe("current-value");
  if (
    refreshedTitle?.kind !== "current-value" ||
    refreshedTitle.evidence.result.status !== "conflict"
  )
    throw new Error("来源刷新后没有形成新的标题冲突候选");
  const currentCandidate = refreshedTitle.evidence.result.candidates.find(
    (candidate) => candidate.value === "幼女战记·第一册新版",
  );
  if (
    currentCandidate?.reference === undefined ||
    currentCandidate.sourceRecordIds.length === 0
  )
    throw new Error("刷新后的标题候选缺少选择引用");
  const adopted = await client.prepareMetadataDecision(assetId, {
    kind: "adopt",
    property: "asset.title",
    candidateReference: currentCandidate.reference,
  });
  expect(adopted.projected).toMatchObject({
    status: "resolved",
    values: [{ value: "幼女战记·第一册新版", sourceIdentity: "user" }],
  });
  await expect(
    client.confirmMetadataDecision(adopted.previewId),
  ).resolves.toMatchObject({ status: "applied" });
  const adoptedValues = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  const adoptedTitle = adoptedValues.items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(adoptedTitle?.kind).toBe("current-value");
  if (
    adoptedTitle?.kind !== "current-value" ||
    adoptedTitle.evidence.result.status !== "resolved"
  )
    throw new Error("确认后没有读到已固定的冲突候选");
  expect(
    adoptedTitle.evidence.result.values.map(({ value, sourceIdentity }) => ({
      value,
      sourceIdentity,
    })),
  ).toEqual([{ value: "幼女战记·第一册新版", sourceIdentity: "user" }]);
  const decisionHistory = await client.listAssetEvidence(assetId, {
    kind: "metadata-decisions",
    limit: 20,
  });
  expect(decisionHistory.items).toEqual([
    expect.objectContaining({
      decisionId: expect.any(String),
      initiatedBy: "local-user",
      decision: "pin",
      value: "幼女战记·第一册",
      current: false,
      adoptedFrom: {
        sourceIdentity: "nbinet",
        sourceSlot: initialCandidate.sourceSlot,
        sourceRecordIds: initialCandidate.sourceRecordIds,
      },
    }),
    expect.objectContaining({
      decision: "clear",
      predecessorDecisionId: expect.any(String),
      current: false,
    }),
    expect.objectContaining({
      decisionId: expect.any(String),
      initiatedBy: "local-user",
      decision: "pin",
      value: "幼女战记·第一册新版",
      predecessorDecisionId: expect.any(String),
      adoptedFrom: {
        sourceIdentity: "nbinet",
        sourceSlot: currentCandidate.sourceSlot,
        sourceRecordIds: currentCandidate.sourceRecordIds,
      },
      current: true,
    }),
  ]);
  const [firstDecision, clearDecisionHistory, latestDecision] =
    decisionHistory.items;
  expect(firstDecision?.kind).toBe("metadata-decision");
  expect(clearDecisionHistory?.kind).toBe("metadata-decision");
  expect(latestDecision?.kind).toBe("metadata-decision");
  if (
    firstDecision?.kind !== "metadata-decision" ||
    clearDecisionHistory?.kind !== "metadata-decision" ||
    latestDecision?.kind !== "metadata-decision"
  )
    throw new Error("元数据决定历史缺少一次修订动作");
  expect(clearDecisionHistory.predecessorDecisionId).toBe(
    firstDecision.decisionId,
  );
  expect(latestDecision.predecessorDecisionId).toBe(
    clearDecisionHistory.decisionId,
  );
  for (const [decision, candidate] of [
    [firstDecision, initialCandidate],
    [latestDecision, currentCandidate],
  ] as const) {
    if (decision.adoptedFrom === undefined)
      throw new Error("已采纳修订缺少候选来源依据");
    expect(decision.adoptedFrom.sourceRecordIds).toEqual(
      candidate.sourceRecordIds,
    );
    for (const recordId of decision.adoptedFrom.sourceRecordIds) {
      const source = await client.readAssetSourceRecord(assetId, recordId, {
        offset: 0,
        limit: 2048,
      });
      expect(source.content).toContain(candidate.value);
    }
  }
  const evidenceRecords = await client.listAssetEvidence(assetId, {
    kind: "source-records",
    limit: 100,
  });
  const latestNbinetRecord = evidenceRecords.items.find(
    (item) =>
      item.kind === "source-record" &&
      currentCandidate.sourceRecordIds.includes(item.id),
  );
  if (latestNbinetRecord?.kind !== "source-record")
    throw new Error("冲突候选没有指向可检查的正式来源记录");
  const unchangedSource = await client.readAssetSourceRecord(
    assetId,
    latestNbinetRecord.id,
    { offset: 0, limit: 2048 },
  );
  expect(unchangedSource.content).toContain("幼女战记·第一册新版");
  expect(unchangedSource.content).toContain("幼女战记 第一册新版");
}, 180_000);

it("真实 HTTP 取消扫描后，历史详情优先显示父子取消结局", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc08-cancelled-scan-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const controlledDirectory = path.join(root, "controlled-source");
  await mkdir(controlledDirectory, { recursive: true });
  await cp(movieSourceResponses, path.join(controlledDirectory, "responses"), {
    recursive: true,
  });

  const tmdbToken = "controlled-tmdb-cancelled-scan-token";
  const omdbKey = "controlled-omdb-cancelled-scan-key";
  const controlled = await loadMovieSourceIo({
    controlledDirectory,
    tmdbToken,
    omdbKey,
    tmdbTitle: "恐怖直播",
  });
  let nextSourceGate:
    | {
        readonly markEntered: () => void;
        readonly released: Promise<void>;
        readonly release: () => void;
      }
    | undefined;
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: async (input, init) => {
      const gate = nextSourceGate;
      if (gate !== undefined) {
        nextSourceGate = undefined;
        gate.markEntered();
        await gate.released;
      }
      return await controlled.request(input, init);
    },
    sessionTransport: refusingSessionTransport(),
  };

  await prepareProductionCatalogue({ productDataDirectory });
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
  await expect(
    client.configureSourceConnection({
      sourceId: "tmdb",
      expectedVersion: 0,
      secret: tmdbToken,
    }),
  ).resolves.toMatchObject({ verification: "verified" });

  const materialDirectory = path.join(root, "普通影视目录", "恐怖直播 (2013)");
  await cp(
    path.join(movieMaterialFixture, "films", "恐怖直播 (2013)"),
    materialDirectory,
    { recursive: true },
  );
  const library = await client.saveAssetLibrary({
    displayName: "取消验证影视库",
    directories: [path.dirname(materialDirectory)],
    recognitionProfileIds: ["movies"],
    sourceIdentities: ["tmdb"],
  });

  let markSourceEntered!: () => void;
  let releaseSource!: () => void;
  const entered = new Promise<void>((resolve) => {
    markSourceEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseSource = resolve;
  });
  nextSourceGate = {
    markEntered: markSourceEntered,
    released,
    release: releaseSource,
  };
  const scan = await client.startAssetLibraryScan(library.id);
  try {
    const sourceRequestStarted = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10_000);
      void entered.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    expect(sourceRequestStarted).toBe(true);
    const cancellation = await client.cancelExecution(scan.parentExecutionId, {
      reason: "验证历史父子执行状态",
    });
    expect(cancellation.requestStatus).toBe("requested");
  } finally {
    releaseSource();
  }

  await expect
    .poll(
      async () =>
        (await client.inspectExecution(scan.parentExecutionId)).outcome,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("cancelled");
  const inspection = await client.inspectExecution(scan.parentExecutionId);
  expect(inspection).toMatchObject({
    kind: "asset-library-scan",
    status: "failed",
    outcome: "cancelled",
    children: [
      {
        status: "available",
        execution: {
          status: "failed",
          stage: "failed",
          outcome: "cancelled",
        },
      },
    ],
  });
  const history = await client.listWorkflowHistory({ limit: 100 });
  const historyIndex = history.items.findIndex(
    ({ execution }) => execution.id === scan.parentExecutionId,
  );
  expect(historyIndex).toBeGreaterThanOrEqual(0);
  expect(history.items[historyIndex]?.execution).toMatchObject({
    status: "failed",
    stage: "failed",
    outcome: "cancelled",
  });
}, 180_000);

it("公共资产读取保留 PDF 与 EPUB 封面所依据的精确父修订版", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc08-cover-provenance-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialRoot = path.join(root, "实际出版物");
  const pdfName = "终将成为你 佐伯沙弥香的追忆.pdf";
  const epubName = "幼女战记(1).epub";
  const pdfSource = path.join(
    movieMaterialFixture,
    "books",
    "やがて君になる 佐伯沙弥香について",
    "01. ",
    "终将成为你 佐伯沙弥香的追忆",
    pdfName,
  );
  const epubSource = path.join(
    movieMaterialFixture,
    "books",
    "幼女战记(1)",
    "publication.epub",
  );
  const pdfPath = path.join(materialRoot, "漫画", "佐伯沙弥香", pdfName);
  const epubPath = path.join(materialRoot, "漫画", "幼女战记(1)", epubName);
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await mkdir(path.dirname(epubPath), { recursive: true });
  await cp(pdfSource, pdfPath);
  await cp(epubSource, epubPath);

  const controlled = await loadControlledSourceIo({
    manifestPath: movieSourceManifest,
  });
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: controlled.request,
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  const baseUrl = await startInspectionService(productDataDirectory, sourceIo);
  const client = createPublicApiClient({ baseUrl });
  const library = await client.saveAssetLibrary({
    displayName: "出版物封面依据",
    directories: [materialRoot],
    recognitionProfileIds: ["books"],
    sourceIdentities: [],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");

  const assets = await client.listAssets({
    assetLibraryId: library.id,
    limit: 20,
  });
  const readCoverPart = (fileName: string, locator: string) => {
    const asset = assets.items.find(({ locations }) =>
      locations.some(({ address }) => address.endsWith(fileName)),
    );
    expect(asset).toBeDefined();
    if (asset === undefined) throw new Error(`没有读取到 ${fileName} 对应资产`);
    const cover = asset.descriptions
      .flatMap(({ artifactRoles }) => artifactRoles)
      .find(({ role }) => role === "asset.primary-cover");
    expect(cover).toBeDefined();
    if (cover === undefined) throw new Error(`${fileName} 没有当前封面角色`);

    expect(cover.observedArtifactParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          associationId: expect.any(String),
          artifactId: expect.any(String),
          revisionId: expect.any(String),
          locator,
        }),
      ]),
    );
    const parts = cover.observedArtifactParts ?? [];
    expect(parts.length).toBeGreaterThan(0);
    expect(
      parts.every(({ associationId }) =>
        cover.associationIds.includes(associationId),
      ),
    ).toBe(true);
    const part = parts.find((candidate) => candidate.locator === locator);
    expect(part).toBeDefined();
    if (part === undefined) throw new Error(`${fileName} 封面没有精确材料依据`);
    expect(cover.associationIds).toContain(part.associationId);
    const parentLocation = asset.locations.find(
      ({ artifactId }) => artifactId === part.artifactId,
    );
    expect(parentLocation).toMatchObject({
      content: {
        status: "confirmed",
        target: {
          kind: "artifact-revision",
          artifactId: part.artifactId,
          revisionId: part.revisionId,
        },
      },
    });
    return asset;
  };

  readCoverPart(pdfName, "pdf:page[1]");
  const epubAsset = readCoverPart(
    epubName,
    "epub:item/standard.opf#/manifest/item[@id='cover'][@properties~='cover-image']->entry:item/image/i-001.jpg",
  );
  const representativeBody = epubAsset.descriptions
    .flatMap(({ artifactRoles }) => artifactRoles)
    .find(({ role }) => role === "asset.representative-body");
  expect(representativeBody).toBeDefined();
  expect(representativeBody).not.toHaveProperty("observedArtifactParts");
}, 180_000);

it("已安装 TUI 翻查资料历史并完成标题修订【安装客户端】", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc08-inspection-tui-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialRoot = path.join(root, "我的收藏");
  const workDirectory = path.join(materialRoot, "声音", "2025", "RJ01029383");
  await mkdir(path.dirname(workDirectory), { recursive: true });
  await cp(path.join(materialFixture, "RJ01029383"), workDirectory, {
    recursive: true,
  });
  await writeFile(
    path.join(materialRoot, "普通说明.txt"),
    "普通目录中的说明材料。\n",
  );

  const controlled = await loadControlledSourceIo({
    manifestPath: sourceManifest,
  });
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: controlled.request,
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  const tuiRequests: string[] = [];
  const baseUrl = await startInspectionService(
    productDataDirectory,
    sourceIo,
    tuiRequests,
  );
  const client = createPublicApiClient({ baseUrl });
  const library = await client.saveAssetLibrary({
    displayName: "资料检查普通目录",
    directories: [materialRoot],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
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
  const currentValues = await client.listAssetEvidence(asset!.id, {
    kind: "current-values",
    limit: 100,
  });
  const titleProperties = currentValues.items.map((item) =>
    item.kind === "current-value" ? item.evidence.property : "",
  );
  const titleIndex = currentValues.items.findIndex(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(titleIndex).toBeGreaterThanOrEqual(0);
  const titleBeforeTui = currentValues.items[titleIndex];
  if (titleBeforeTui?.kind !== "current-value")
    throw new Error("普通目录样例没有标题裁决");

  await verifyInstalledTui(baseUrl, asset!, library.displayName, tuiRequests);
  await verifyMetadataDecisionTui(
    baseUrl,
    library.displayName,
    asset!,
    titleIndex,
    titleProperties,
  );
  const titleAfterTui = (
    await client.listAssetEvidence(asset!.id, {
      kind: "current-values",
      limit: 100,
    })
  ).items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(titleAfterTui).toEqual(titleBeforeTui);
}, 180_000);

it("已安装 TUI 取消冲突采纳且保留当前来源候选【安装客户端】", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc09-conflict-tui-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const controlledDirectory = path.join(root, "controlled-source");
  const responseDirectory = path.join(controlledDirectory, "responses");
  await mkdir(controlledDirectory, { recursive: true });
  await cp(movieSourceResponses, responseDirectory, { recursive: true });
  const controlledManifestPath = path.join(
    controlledDirectory,
    "manifest.json",
  );
  await cp(movieSourceManifest, controlledManifestPath);
  const nbinetResponsePath = path.join(responseDirectory, "epub-5-nbinet.json");
  const body = JSON.parse(await readFile(nbinetResponsePath, "utf8")) as {
    docs: Array<{ pnx: { display: { title: readonly string[] } } }>;
  };
  const firstRecord = body.docs[0];
  if (firstRecord === undefined) throw new Error("受控书目资料缺少记录");
  firstRecord.pnx.display.title = ["幼女战记 第一册", "幼女战记·第一册"];
  await writeFile(nbinetResponsePath, JSON.stringify(body));

  const controlled = await loadControlledSourceIo({
    manifestPath: controlledManifestPath,
  });
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: controlled.request,
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  const baseUrl = await startInspectionService(productDataDirectory, sourceIo);
  const client = createPublicApiClient({ baseUrl });
  const materialDirectory = path.join(root, "普通出版物", "幼女战记(1)");
  await cp(
    path.join(movieMaterialFixture, "books", "幼女战记(1)"),
    materialDirectory,
    { recursive: true },
  );
  const library = await client.saveAssetLibrary({
    displayName: "书目冲突受控变体",
    directories: [path.dirname(materialDirectory)],
    recognitionProfileIds: ["books"],
    sourceIdentities: ["nbinet"],
  });
  const scan = await client.startAssetLibraryScan(library.id);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(scan.parentExecutionId)).status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");
  const assets = await client.listAssets({
    assetLibraryId: library.id,
    limit: 10,
  });
  expect(assets.items).toHaveLength(1);
  const assetId = assets.items[0]!.id;
  const values = await client.listAssetEvidence(assetId, {
    kind: "current-values",
    limit: 100,
  });
  const title = values.items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(title?.kind).toBe("current-value");
  if (title?.kind !== "current-value")
    throw new Error("受控书目变体没有返回标题资料");
  expect(title.evidence.result.status).toBe("conflict");
  const titleProperties = values.items.map((item) =>
    item.kind === "current-value" ? item.evidence.property : "",
  );
  await verifyConflictCancellationTui(
    baseUrl,
    library.displayName,
    assets.items[0]!,
    values.items.findIndex((item) => item === title),
    titleProperties,
  );
  const titleAfterTui = (
    await client.listAssetEvidence(assetId, {
      kind: "current-values",
      limit: 100,
    })
  ).items.find(
    (item) =>
      item.kind === "current-value" && item.evidence.property === "asset.title",
  );
  expect(titleAfterTui).toMatchObject({
    kind: "current-value",
    evidence: { property: "asset.title", result: { status: "conflict" } },
  });
}, 120_000);

it("已安装 TUI 查看正式取消的来源刷新历史【安装客户端】", async () => {
  const scenario = await prepareMovieHistoryTuiScenario();
  const { baseUrl, client, libraryId, libraryName } = scenario;
  const initialScan = await client.startAssetLibraryScan(libraryId);
  await expect
    .poll(
      async () =>
        (await client.inspectAssetLibraryScan(initialScan.parentExecutionId))
          .status,
      { timeout: 120_000, interval: 200 },
    )
    .toBe("completed");
  const assets = await client.listAssets({
    assetLibraryId: libraryId,
    limit: 10,
  });
  expect(assets.items).toHaveLength(1);
  const assetId = assets.items[0]!.id;
  const refreshId = await cancelAtSourceRequest(
    client,
    scenario.gateNextSourceRequest,
    async () => (await client.startMetadataRefresh({ subjectId: assetId })).id,
    "验证 TUI 刷新取消历史",
  );
  const history = await client.listWorkflowHistory({ limit: 100 });
  const historyIndex = history.items.findIndex(
    ({ execution }) => execution.id === refreshId,
  );
  expect(historyIndex).toBeGreaterThanOrEqual(0);

  await verifyCancelledHistoryTui(
    baseUrl,
    libraryName,
    historyIndex,
    "资料更新 · 已取消",
    undefined,
  );
}, 180_000);

it("已安装 TUI 查看正式取消的资产库扫描历史【安装客户端】", async () => {
  const scenario = await prepareMovieHistoryTuiScenario();
  const { baseUrl, client, libraryId, libraryName } = scenario;
  const cancelledScanId = await cancelAtSourceRequest(
    client,
    scenario.gateNextSourceRequest,
    async () =>
      (await client.startAssetLibraryScan(libraryId)).parentExecutionId,
    "验证 TUI 扫描取消历史",
  );
  const history = await client.listWorkflowHistory({ limit: 100 });
  const historyIndex = history.items.findIndex(
    ({ execution }) => execution.id === cancelledScanId,
  );
  expect(historyIndex).toBeGreaterThanOrEqual(0);

  await verifyCancelledHistoryTui(
    baseUrl,
    libraryName,
    historyIndex,
    "资料库扫描 · 已取消",
    "目录状态：已取消 1",
  );
}, 180_000);

async function prepareMovieHistoryTuiScenario(): Promise<{
  readonly baseUrl: URL;
  readonly client: ReturnType<typeof createPublicApiClient>;
  readonly libraryId: string;
  readonly libraryName: string;
  readonly gateNextSourceRequest: () => {
    readonly hasEntered: () => boolean;
    readonly release: () => void;
  };
}> {
  const root = await mkdtemp(path.join(tmpdir(), "ewc08-history-tui-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const controlledDirectory = path.join(root, "controlled-source");
  await mkdir(controlledDirectory, { recursive: true });
  await cp(movieSourceResponses, path.join(controlledDirectory, "responses"), {
    recursive: true,
  });

  const tmdbToken = "controlled-tmdb-history-tui-token";
  const controlled = await loadMovieSourceIo({
    controlledDirectory,
    tmdbToken,
    omdbKey: "controlled-omdb-history-tui-key",
    tmdbTitle: "恐怖直播",
  });
  let nextSourceGate:
    | {
        readonly markEntered: () => void;
        readonly released: Promise<void>;
        readonly release: () => void;
      }
    | undefined;
  const sourceIo: ProductConfiguration["sourceIo"] = {
    mode: "controlled",
    request: async (input, init) => {
      const gate = nextSourceGate;
      if (gate !== undefined) {
        nextSourceGate = undefined;
        gate.markEntered();
        await gate.released;
      }
      return await controlled.request(input, init);
    },
    sessionTransport: refusingSessionTransport(),
  };
  const baseUrl = await startInspectionService(productDataDirectory, sourceIo);
  const client = createPublicApiClient({ baseUrl });
  await expect(
    client.configureSourceConnection({
      sourceId: "tmdb",
      expectedVersion: 0,
      secret: tmdbToken,
    }),
  ).resolves.toMatchObject({ verification: "verified" });

  const materialDirectory = path.join(root, "普通影视目录", "恐怖直播 (2013)");
  await cp(
    path.join(movieMaterialFixture, "films", "恐怖直播 (2013)"),
    materialDirectory,
    { recursive: true },
  );
  const library = await client.saveAssetLibrary({
    displayName: "取消验证影视库",
    directories: [path.dirname(materialDirectory)],
    recognitionProfileIds: ["movies"],
    sourceIdentities: ["tmdb"],
  });

  return {
    baseUrl,
    client,
    libraryId: library.id,
    libraryName: library.displayName,
    gateNextSourceRequest: () => {
      let requestEntered = false;
      let releaseRequest!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      nextSourceGate = {
        markEntered: () => {
          requestEntered = true;
        },
        released,
        release: releaseRequest,
      };
      return {
        hasEntered: () => requestEntered,
        release: () => {
          nextSourceGate = undefined;
          releaseRequest();
        },
      };
    },
  };
}

async function cancelAtSourceRequest(
  client: ReturnType<typeof createPublicApiClient>,
  gateNextSourceRequest: () => {
    readonly hasEntered: () => boolean;
    readonly release: () => void;
  },
  start: () => Promise<string>,
  reason: string,
): Promise<string> {
  const gate = gateNextSourceRequest();
  let executionId: string | undefined;
  try {
    executionId = await start();
    await expect
      .poll(async () => gate.hasEntered(), { timeout: 10_000 })
      .toBe(true);
    await expect(
      client.cancelExecution(executionId, { reason }),
    ).resolves.toMatchObject({ requestStatus: "requested" });
  } finally {
    gate.release();
  }
  if (executionId === undefined) throw new Error("取消验收没有创建执行");
  await expect
    .poll(async () => (await client.inspectExecution(executionId!)).outcome, {
      timeout: 120_000,
      interval: 200,
    })
    .toBe("cancelled");
  return executionId;
}

async function startInspectionService(
  productDataDirectory: string,
  sourceIo: ProductConfiguration["sourceIo"],
  requestLog?: string[],
): Promise<URL> {
  await prepareProductionCatalogue({ productDataDirectory });
  const bootstrap = await createProductService({
    productDataDirectory,
    environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
    sourceIo,
  });
  const server = serve({
    fetch:
      requestLog === undefined
        ? bootstrap.app.fetch
        : async (request) => {
            requestLog.push(new URL(request.url).pathname);
            return await bootstrap.app.fetch(request);
          },
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  running.push({ server, abort: () => bootstrap.abort() });
  await server.ready();
  bootstrap.publish();
  return new URL(server.url!);
}

async function verifyCancelledHistoryTui(
  baseUrl: URL,
  libraryName: string,
  historyIndex: number,
  historyLabel: string,
  childSummary?: string,
): Promise<void> {
  const terminal = startAssetInspectionTerminal(baseUrl, 58, 16, 15_000);
  await terminal.waitForOutput(libraryName);
  if (historyIndex === 0) {
    await terminal.sendAndWait("6", ["工作流历史", `› ${historyLabel}`]);
  } else {
    await terminal.sendAndWait("6", ["工作流历史", "› "]);
    for (let index = 1; index <= historyIndex; index++)
      await terminal.sendAndWait(
        "j",
        index === historyIndex ? `› ${historyLabel}` : "› ",
      );
  }
  const detailMarkers = ["执行详情", "已取消", historyLabel];
  if (childSummary !== undefined) detailMarkers.push(childSummary);
  await terminal.sendAndWait("v", detailMarkers);
  const terminalOutput = await finishInstalledTui(terminal);
  expect(terminalOutput).toContain("工作流历史");
  expect(terminalOutput).toContain("执行详情");
  expect(terminalOutput).toContain("已取消");
  expect(terminalOutput).toContain(historyLabel);
  if (childSummary !== undefined)
    expect(terminalOutput).toContain(childSummary);
  expect(terminalOutput).not.toContain("资料更新 · 遇到问题");
  expect(terminalOutput).not.toContain("遇到问题 · 失败");
  expect(terminalOutput).not.toContain("失败 · 已停止");
  expect(terminalOutput).not.toContain("已停止");
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(terminalOutput).not.toContain("TERMINAL_NOT_RESTORED");
}

async function verifyInstalledTui(
  baseUrl: URL,
  asset: PublicCurrentAsset,
  libraryName: string,
  requestLog: string[],
): Promise<void> {
  const assetId = asset.id;
  const client = createPublicApiClient({ baseUrl });
  const sourcePage = await client.listAssetEvidence(assetId, {
    kind: "source-records",
    limit: 24,
  });
  const sourceRecords = sourcePage.items.filter(
    (item) => item.kind === "source-record",
  );
  if (sourceRecords.length === 0)
    throw new Error("安装 TUI 检查样例没有来源记录");
  const sourceIndex = Math.min(2, sourceRecords.length - 1);
  const sourceRecord = sourceRecords[sourceIndex];
  if (sourceRecord === undefined)
    throw new Error("安装 TUI 检查样例缺少目标来源记录");
  const sourceAddress = sourceRecord.nativeAddress ?? "来源资料";
  const sourceAddressMarker = sourceAddress.match(/RJ\d+/u)?.[0] ?? "来源资料";
  const sourceChunkLimit = 40;
  const firstChunk = await client.readAssetSourceRecord(
    assetId,
    sourceRecord.id,
    { offset: 0, limit: sourceChunkLimit },
  );
  const nextChunk = firstChunk.complete
    ? undefined
    : await client.readAssetSourceRecord(assetId, sourceRecord.id, {
        offset: firstChunk.nextOffset,
        limit: sourceChunkLimit,
      });

  const terminal = startAssetInspectionTerminal(baseUrl, 34, 10, 30_000);
  await enterAssetLibrary(terminal, libraryName, asset);
  await terminal.sendAndWait("i", ["资产资料检查", "› 本地观察："]);
  await terminal.sendAndWait("j", "› 格式读取结果：");
  await terminal.sendAndWait("j", "› 来源记录：");
  await terminal.sendAndWait("\r", ["来源记录 ·", "› "]);
  for (let index = 0; index < sourceIndex; index++)
    await terminal.sendAndWait("j", "› ");
  const sourceChunkMarker = (chunk: {
    readonly offset: number;
    readonly nextOffset: number;
  }): string => `来源资料 ${chunk.offset + 1}–${chunk.nextOffset} 字符`;
  await terminal.sendAndWait("\r", [
    `来源：`,
    sourceAddressMarker,
    sourceChunkMarker(firstChunk),
  ]);
  if (nextChunk !== undefined) {
    await terminal.sendAndWait("n", sourceChunkMarker(nextChunk));
    await terminal.sendAndWait("p", sourceChunkMarker(firstChunk));
  }
  await terminal.sendAndWait("\x1b", ["来源记录 ·", "› "]);
  await terminal.sendAndWait("\x1b", "› 来源记录：");
  await terminal.sendAndWait("\x1b", "i/Enter检查");

  const attention = await client.listCurrentAttention({ limit: 24 });
  const attentionMarker = attention.items[0]?.summary ?? "目前没有待处理事项";
  await terminal.sendAndWait("5", ["待处理事项", attentionMarker]);
  if (attention.nextCursor !== undefined) {
    const nextAttention = await client.listCurrentAttention({
      limit: 24,
      cursor: attention.nextCursor,
    });
    const nextAttentionMarker =
      nextAttention.items[0]?.summary ?? "目前没有待处理事项";
    await terminal.sendAndWait("n", ["待处理事项", nextAttentionMarker]);
  }
  await terminal.sendAndWait("\x1b", "i/Enter检查");

  const history = await client.listWorkflowHistory({ limit: 24 });
  const selectedHistoryIndex = Math.min(1, history.items.length - 1);
  const selectedExecutionId = history.items[selectedHistoryIndex]?.execution.id;
  if (selectedExecutionId === undefined)
    throw new Error("安装 TUI 检查样例没有工作流历史");
  const requestStart = requestLog.length;
  await terminal.sendAndWait("6", ["工作流历史", "› "]);
  if (history.items.length > 1) await terminal.sendAndWait("j", "› ");
  await terminal.sendAndWait("v", "执行详情");
  expect(requestLog.slice(requestStart)).toContain(
    `/api/v1/executions/${selectedExecutionId}`,
  );
  await terminal.sendAndWait("\x1b", ["工作流历史", "› "]);
  await terminal.sendAndWait("\x1b", "i/Enter检查");
  const terminalOutput = await finishInstalledTui(terminal);
  const visibleOutput = terminalOutput
    .replaceAll(String.fromCharCode(27), "")
    .replace(/\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\r\n]/gu, "");
  expect(terminalOutput).toContain("资产资料检查");
  expect(terminalOutput).toContain("来源记录");
  expect(terminalOutput).toContain("工作流历史");
  expect(terminalOutput).toContain("执行详情");
  expect(visibleOutput).not.toContain(assetId);
  expect(visibleOutput).not.toMatch(/\b(?:entity|execution)_[a-f\d-]{36}\b/u);
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(terminalOutput).not.toContain("TERMINAL_NOT_RESTORED");
}

async function verifyMetadataDecisionTui(
  baseUrl: URL,
  libraryName: string,
  asset: PublicCurrentAsset,
  titleIndex: number,
  titleProperties: readonly string[],
): Promise<void> {
  const terminal = startAssetInspectionTerminal(baseUrl, 48, 16, 30_000);
  await enterAssetLibrary(terminal, libraryName, asset);
  await openCurrentValuesTitle(terminal, titleIndex, titleProperties);
  await terminal.sendAndWait("m", "asset.title 新值：");
  await terminal.sendAndWait("终端取消标题", "终端取消标题");
  await terminal.sendAndWait("\r", "y 确认 · n 取消");
  await terminal.sendAndWait("n", "已取消，没有修改资料");
  await terminal.sendAndWait("\r", "› asset.title");

  await terminal.sendAndWait("m", "asset.title 新值：");
  await terminal.sendAndWait("终端修订标题", "终端修订标题");
  await terminal.sendAndWait("\r", "y 确认 · n 取消");
  await terminal.sendAndWait("y", "已确认");
  await terminal.sendAndWait("\r", `› ${titleProperties[0]}`);
  await moveCurrentValueSelection(terminal, titleIndex, titleProperties);

  await terminal.sendAndWait("x", "撤回修订");
  await terminal.sendAndWait("y", ["已确认", "撤回修订"]);
  await terminal.sendAndWait("\r", `› ${titleProperties[0]}`);
  const output = await finishInstalledTui(terminal);
  expect(output).toContain("资产资料检查");
  expect(output).toContain("终端取消标题");
  expect(output).toContain("已取消，没有修改资料");
  expect(output).toContain("终端修订标题");
  expect(output).toContain("已确认");
  expect(output).toContain("确认后固定人工输入值");
  expect(output).toContain("撤回修订");
  expect(output).toContain("TERMINAL_RESTORED");
  expect(output).not.toContain("TERMINAL_NOT_RESTORED");
}

async function verifyConflictCancellationTui(
  baseUrl: URL,
  libraryName: string,
  asset: PublicCurrentAsset,
  titleIndex: number,
  titleProperties: readonly string[],
): Promise<void> {
  const terminal = startAssetInspectionTerminal(baseUrl, 48, 16, 30_000);
  await enterAssetLibrary(terminal, libraryName, asset);
  await openCurrentValuesTitle(terminal, titleIndex, titleProperties);
  await terminal.sendAndWait("a", [
    "选择要固定的冲突值",
    "幼女战记 第一册",
    "幼女战记·第一册",
  ]);
  await terminal.sendAndWait("\r", "y 确认 · n 取消");
  await terminal.sendAndWait("n", "已取消，没有修改资料");
  await terminal.sendAndWait("\r", `› ${titleProperties[titleIndex]}`);
  await terminal.sendAndWait("\x1b", "› 当前采用值及依据：");
  await terminal.sendAndWait("\x1b", "› ");
  const output = await finishInstalledTui(terminal);
  expect(output).toContain("存在冲突");
  expect(output).toContain("幼女战记 第一册");
  expect(output).toContain("幼女战记·第一册");
  expect(output).toContain("已取消，没有修改资料");
  expect(output).toContain("TERMINAL_RESTORED");
  expect(output).not.toContain("TERMINAL_NOT_RESTORED");
}

function startAssetInspectionTerminal(
  baseUrl: URL,
  columns: number,
  rows: number,
  timeoutMs: number,
): InteractiveTerminalSession {
  const terminalCommand = `stty cols ${columns} rows ${rows} -icanon -echo; terminalModeBefore=$(stty -g); pnpm --filter @digital/service exec digital-tui --url ${shellQuote(baseUrl.origin)}; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const terminal = startInteractiveTerminal(terminalCommand, {
    cwd: serviceRoot,
    columns,
    rows,
    timeoutMs,
  });
  children.push(terminal.child);
  return terminal;
}

async function enterAssetLibrary(
  terminal: InteractiveTerminalSession,
  libraryName: string,
  asset: PublicCurrentAsset,
): Promise<void> {
  await terminal.waitForOutput(libraryName);
  await terminal.sendAndWait("/", "筛选本页：");
  await terminal.sendAndWait(libraryName, [libraryName, "筛选本页："]);
  await terminal.sendAndWait("\r", "（1/1）");
  await terminal.sendAndWait("\r", ["›2 资产", selectedAssetRowMarker(asset)]);
}

function selectedAssetRowMarker(asset: PublicCurrentAsset): string {
  const title = asset.descriptions
    .filter(
      (description) =>
        description.target.kind === "entity" &&
        description.target.entityId === asset.id,
    )
    .flatMap((description) => description.metadata)
    .find(
      (metadata) =>
        metadata.property === "asset.title" &&
        metadata.result.status === "resolved",
    )?.result;
  const name =
    (title?.status === "resolved" ? title.values[0]?.value : undefined) ??
    asset.relatedEntities.find((entity) => entity.id === asset.id)?.label ??
    "未命名资产";
  return `› ${Array.from(name).slice(0, 6).join("")}`;
}

async function openCurrentValuesTitle(
  terminal: InteractiveTerminalSession,
  titleIndex: number,
  titleProperties: readonly string[],
): Promise<void> {
  await terminal.sendAndWait("i", ["资产资料检查", "› 本地观察："]);
  await terminal.sendAndWait("j", "› 格式读取结果：");
  await terminal.sendAndWait("j", "› 来源记录：");
  await terminal.sendAndWait("j", "› 解释事实：");
  await terminal.sendAndWait("j", "› 当前采用值及依据：");
  const firstProperty = titleProperties[0];
  if (firstProperty === undefined || firstProperty.length === 0)
    throw new Error("当前值资料没有可用于选择的属性");
  await terminal.sendAndWait("\r", [
    "当前采用值及依据 ·",
    `› ${firstProperty}`,
  ]);
  await moveCurrentValueSelection(terminal, titleIndex, titleProperties);
}

async function moveCurrentValueSelection(
  terminal: InteractiveTerminalSession,
  titleIndex: number,
  titleProperties: readonly string[],
): Promise<void> {
  const targetProperty = titleProperties[titleIndex];
  if (targetProperty === undefined || targetProperty.length === 0)
    throw new Error("当前值资料中没有目标属性");
  for (let index = 1; index <= titleIndex; index++) {
    const property = titleProperties[index];
    if (property === undefined || property.length === 0)
      throw new Error(`当前值资料缺少第 ${index + 1} 个属性`);
    await terminal.sendAndWait("j", `› ${property}`);
  }
}

async function finishInstalledTui(
  terminal: InteractiveTerminalSession,
): Promise<string> {
  await terminal.sendAndWait("q", "TERMINAL_RESTORED");
  const exitCode = await terminal.closeAndWait();
  expect(exitCode, `${terminal.errors}\n${terminal.output}`).toBe(0);
  expect(terminal.output).toContain("TERMINAL_RESTORED");
  expect(terminal.output).not.toContain("TERMINAL_NOT_RESTORED");
  return terminal.output;
}

async function loadMovieSourceIo(input: {
  readonly controlledDirectory: string;
  readonly tmdbToken: string;
  readonly omdbKey: string;
  readonly tmdbTitle: string;
}) {
  const responseDirectory = path.join(input.controlledDirectory, "responses");
  const movieResponsePath = path.join(
    responseDirectory,
    "tmdb-movie-209764.json",
  );
  const movieResponse = JSON.parse(
    await readFile(movieResponsePath, "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    movieResponsePath,
    JSON.stringify({ ...movieResponse, title: input.tmdbTitle }),
  );

  const manifest = JSON.parse(await readFile(movieSourceManifest, "utf8")) as {
    readonly formatVersion: number;
    readonly ordinary: readonly Record<string, unknown>[];
  };
  const manifestPath = path.join(input.controlledDirectory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      formatVersion: manifest.formatVersion,
      ordinary: manifest.ordinary.map((entry) => ({
        ...entry,
        ...(entry.id === "tmdb-auth"
          ? {
              require: {
                headers: {
                  Authorization: `Bearer ${input.tmdbToken}`,
                },
              },
            }
          : {}),
        ...(typeof entry.url === "string" &&
        entry.url.includes("synthetic-omdb-key")
          ? { url: entry.url.replaceAll("synthetic-omdb-key", input.omdbKey) }
          : {}),
      })),
    }),
  );
  return await loadControlledSourceIo({ manifestPath });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function syntheticPdf(input: {
  readonly author: string;
  readonly pageCount: number;
}): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: input.pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${input.pageCount} >>`,
    ...Array.from(
      { length: input.pageCount },
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>",
    ),
    `<< /Author (${input.author}) >>`,
  ];
  let source = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length + 1} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}
