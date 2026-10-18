import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deleteEnvironment,
  inspectEnvironment,
  prepareEnvironment,
  startEnvironment,
  stopEnvironment,
} from "@digital/environment";
import { createPublicApiClient } from "@digital/public-api";
import { loadControlledSourceIo } from "@digital/test-support/source-io";

import { requireInput } from "./inputs.ts";

type CorpusCoverage = {
  readonly roots: readonly {
    readonly id: string;
    readonly batch: "audio-posts" | "publication-screen";
    readonly directory: string;
    readonly recognition: "required" | "unrecognized";
  }[];
};

type PublicationCases = {
  readonly cases: readonly {
    readonly id: string;
    readonly tmdbFacts?: readonly {
      readonly property: string;
      readonly value: string;
    }[];
  }[];
};

type CommandRequest = {
  readonly command: "initialize" | "verify";
  readonly environment?: string;
};

const defaultWorkflowTimeoutMs = 15 * 60_000;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      try {
        signal.throwIfAborted();
        resolve();
      } catch (error) {
        reject(error);
      }
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error("受控默认流程已取消"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function fetchWithCancellation(signal: AbortSignal): typeof globalThis.fetch {
  const request = globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    signal.throwIfAborted();
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const combinedSignal =
      requestSignal === undefined
        ? signal
        : AbortSignal.any([signal, requestSignal]);
    return await request(input, { ...init, signal: combinedSignal });
  };
}

function parseRequest(argv: readonly string[]): CommandRequest {
  const [command, ...rawOptions] = argv;
  const options = rawOptions[0] === "--" ? rawOptions.slice(1) : rawOptions;
  if (command !== "initialize" && command !== "verify")
    throw new Error(
      "用法：pnpm development:controlled -- initialize --environment <名称>；正式验收由 pnpm verify:controlled-default 运行。",
    );
  let environment: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option !== "--environment" || environment !== undefined)
      throw new Error("只接受一次 --environment <名称>");
    const value = options[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error("--environment 缺少环境名");
    environment = value;
    index += 1;
  }
  if (command === "initialize" && environment === undefined)
    throw new Error("初始化必须显式提供 --environment <名称>");
  return {
    command,
    ...(environment === undefined ? {} : { environment }),
  };
}

function resolvedAsset(pathname: string): string {
  return fileURLToPath(import.meta.resolve(pathname));
}

async function configureKeyConnection(
  client: ReturnType<typeof createPublicApiClient>,
  sourceId: "tmdb" | "omdb",
  secret: string,
): Promise<void> {
  const current = await client.getSourceConnection(sourceId);
  assert.equal(
    current.credentialStatus,
    "unconfigured",
    `${sourceId} 来源必须由空白环境上的明确初始化配置`,
  );
  const configured = await client.configureSourceConnection({
    sourceId,
    expectedVersion: current.version,
    secret,
  });
  assert.equal(configured.verification, "verified");
  assert.equal(configured.connection.availability, "available");
}

async function configureBangumi(
  client: ReturnType<typeof createPublicApiClient>,
  baseUrl: string,
  fetchRequest: typeof globalThis.fetch,
): Promise<void> {
  const callbackUrl = new URL(
    "/api/v1/source-connections/bangumi/callback",
    baseUrl,
  );
  await client.configureBangumiOAuthClient({
    clientId: "synthetic-controlled-client",
    clientSecret: "synthetic-controlled-client-secret",
    redirectUri: callbackUrl.toString(),
  });
  const authorization = await client.beginBangumiAuthorization();
  const state = new URL(authorization.authorizationUrl).searchParams.get(
    "state",
  );
  assert(state, "受控 Bangumi 授权必须生成一次性 state");
  callbackUrl.searchParams.set("code", "synthetic-code");
  callbackUrl.searchParams.set("state", state);
  const callback = await fetchRequest(callbackUrl);
  assert.equal(callback.status, 200, "受控 Bangumi OAuth 回调必须成功");
  const result = await client.getBangumiAuthorizationAttempt(
    authorization.attemptId,
  );
  assert.equal(result.status, "succeeded");
  const connection = await client.getSourceConnection("bangumi");
  assert.equal(connection.credentialStatus, "configured");
  assert.equal(connection.availability, "available");
}

async function configureFanbox(
  client: ReturnType<typeof createPublicApiClient>,
): Promise<void> {
  const fixturePath = resolvedAsset(
    "@digital/preview-corpus/audio-posts/connections/synthetic-customudon.json",
  );
  const browserCredential: unknown = JSON.parse(
    await readFile(fixturePath, "utf8"),
  );
  const created = await client.createFanboxConnectionRequest({
    creatorId: "customudon",
  });
  const pairing = await client.getFanboxConnectionRequestForPairing({
    requestId: created.request.id,
    pairingCode: created.pairingCode,
  });
  assert.equal(pairing.status, "waiting");
  const completed = await client.completeFanboxConnectionRequest({
    requestId: created.request.id,
    pairingCode: created.pairingCode,
    browserCredential,
  });
  assert.equal(completed.status, "succeeded");
}

async function waitForLibraryScan(
  client: ReturnType<typeof createPublicApiClient>,
  executionId: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof client.inspectAssetLibraryScan>>> {
  const deadline = Date.now() + defaultWorkflowTimeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const inspection = await client.inspectAssetLibraryScan(executionId);
    signal.throwIfAborted();
    if (inspection.status !== "running") return inspection;
    await delay(250, signal);
  }
  throw new Error(`资产库扫描超过 ${String(defaultWorkflowTimeoutMs)} 毫秒`);
}

async function waitForExecution(
  client: ReturnType<typeof createPublicApiClient>,
  executionId: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof client.inspectExecution>>> {
  const deadline = Date.now() + defaultWorkflowTimeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const inspection = await client.inspectExecution(executionId);
    signal.throwIfAborted();
    if (inspection.status !== "running") return inspection;
    await delay(250, signal);
  }
  throw new Error(`正式执行超过 ${String(defaultWorkflowTimeoutMs)} 毫秒`);
}

async function listAllAssets(
  client: ReturnType<typeof createPublicApiClient>,
  assetLibraryId: string,
): Promise<Awaited<ReturnType<typeof client.listAssets>>["items"]> {
  const items: Array<
    Awaited<ReturnType<typeof client.listAssets>>["items"][number]
  > = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAssets({
      assetLibraryId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

async function listAllUnrecognizedMaterials(
  client: ReturnType<typeof createPublicApiClient>,
  assetLibraryId: string,
): Promise<
  Awaited<ReturnType<typeof client.listUnrecognizedMaterials>>["items"]
> {
  const items: Array<
    Awaited<
      ReturnType<typeof client.listUnrecognizedMaterials>
    >["items"][number]
  > = [];
  let cursor: string | undefined;
  do {
    const page = await client.listUnrecognizedMaterials({
      assetLibraryId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

function countObservedReferenceRoots(input: {
  readonly coverage: CorpusCoverage;
  readonly scan: Awaited<
    ReturnType<
      ReturnType<typeof createPublicApiClient>["inspectAssetLibraryScan"]
    >
  >;
  readonly unrecognized: Awaited<
    ReturnType<
      ReturnType<typeof createPublicApiClient>["listUnrecognizedMaterials"]
    >
  >["items"];
  readonly audioPostsDirectory: string;
  readonly publicationScreenDirectory: string;
}): {
  readonly safetyRoots: number;
  readonly automaticallyAcceptedRoots: number;
  readonly unrecognizedRoots: number;
  readonly missingObservedRoots: readonly string[];
  readonly missingUnrecognizedRoots: readonly string[];
  readonly observedRoots: readonly string[];
  readonly automaticallyAcceptedRootIds: readonly string[];
  readonly pendingRecognitionRootIds: readonly string[];
  readonly unrecognizedRootIds: readonly string[];
  readonly scanAssetIdsByRoot: Readonly<Record<string, readonly string[]>>;
  readonly unrecognizedObservedRootIdsByRoot: Readonly<
    Record<string, readonly string[]>
  >;
} {
  const observedRoots: string[] = [];
  const missingObservedRoots: string[] = [];
  const automaticallyAcceptedRootIds: string[] = [];
  const pendingRecognitionRootIds: string[] = [];
  const unrecognizedRootIds: string[] = [];
  const missingUnrecognizedRoots: string[] = [];
  const scanAssetIdsByRoot: Record<string, string[]> = {};
  const unrecognizedObservedRootIdsByRoot: Record<string, string[]> = {};
  const scanFiles = input.scan.directories.flatMap(({ files }) => files);
  const unrecognizedPaths = input.unrecognized.flatMap(
    ({ relativeScope, relativePaths }) =>
      relativePaths.map((relativePath) =>
        path.resolve(relativeScope, relativePath),
      ),
  );
  for (const root of input.coverage.roots) {
    const registeredDirectory =
      root.batch === "audio-posts"
        ? input.audioPostsDirectory
        : input.publicationScreenDirectory;
    const relativeRoot = path.relative(
      registeredDirectory,
      path.join(registeredDirectory, ...root.directory.split("/").slice(2)),
    );
    const matchesRoot = (candidate: string): boolean => {
      const normalizedRoot = path.resolve(relativeRoot);
      const normalizedCandidate = path.resolve(candidate);
      return (
        normalizedCandidate === normalizedRoot ||
        normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
      );
    };
    const rootFiles = scanFiles.filter(({ relativePaths }) =>
      relativePaths.some((relativePath) => matchesRoot(relativePath)),
    );
    const wasObserved =
      rootFiles.length > 0 ||
      unrecognizedPaths.some((relativePath) => matchesRoot(relativePath));
    const rootUnrecognizedItems = input.unrecognized.filter(
      ({ relativeScope, relativePaths }) =>
        relativePaths.some((relativePath) =>
          matchesRoot(path.resolve(relativeScope, relativePath)),
        ),
    );
    const wasUnrecognized = rootUnrecognizedItems.length > 0;
    unrecognizedObservedRootIdsByRoot[root.id] = [
      ...new Set(
        rootUnrecognizedItems.map(({ observedRootId }) => observedRootId),
      ),
    ];
    const acceptedByScan = rootFiles.some(
      ({ assetId }) => assetId !== undefined,
    );
    scanAssetIdsByRoot[root.id] = [
      ...new Set(
        rootFiles.flatMap(({ assetId }) =>
          assetId === undefined ? [] : [assetId],
        ),
      ),
    ];
    (wasObserved ? observedRoots : missingObservedRoots).push(root.id);
    if (root.recognition === "required") {
      if (acceptedByScan) automaticallyAcceptedRootIds.push(root.id);
      else if (wasUnrecognized) pendingRecognitionRootIds.push(root.id);
    } else if (wasUnrecognized) {
      unrecognizedRootIds.push(root.id);
    } else {
      missingUnrecognizedRoots.push(root.id);
    }
  }
  const observed = new Set(observedRoots);
  const observedCoverage = input.coverage.roots.filter(({ id }) =>
    observed.has(id),
  );
  return {
    safetyRoots: observedCoverage.length,
    automaticallyAcceptedRoots: automaticallyAcceptedRootIds.length,
    unrecognizedRoots: unrecognizedRootIds.length,
    observedRoots,
    automaticallyAcceptedRootIds,
    pendingRecognitionRootIds,
    unrecognizedRootIds,
    scanAssetIdsByRoot,
    unrecognizedObservedRootIdsByRoot,
    missingObservedRoots,
    missingUnrecognizedRoots,
  };
}

async function runControlledDefault(request: CommandRequest): Promise<void> {
  const workspacePath = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
  const audioPostsDirectory = await realpath(
    resolvedAsset("@digital/preview-corpus/audio-posts/material"),
  );
  const publicationScreenDirectory = await realpath(
    resolvedAsset("@digital/preview-corpus/publication-screen/material"),
  );
  const manifestPath = await realpath(
    resolvedAsset("@digital/preview-corpus/manifest.json"),
  );
  const coveragePath = await realpath(
    resolvedAsset("@digital/preview-corpus/coverage.json"),
  );
  const publicationCasesPath = await realpath(
    resolvedAsset("@digital/preview-corpus/publication-screen/cases.json"),
  );
  const coverage = JSON.parse(
    await readFile(coveragePath, "utf8"),
  ) as CorpusCoverage;
  const publicationCases = JSON.parse(
    await readFile(publicationCasesPath, "utf8"),
  ) as PublicationCases;
  const referenceCoverage = {
    safetyRoots: coverage.roots.length,
    recognitionRoots: coverage.roots.filter(
      ({ recognition }) => recognition === "required",
    ).length,
    unrecognizedRoots: coverage.roots.filter(
      ({ recognition }) => recognition === "unrecognized",
    ).length,
  };
  const environment =
    request.environment ?? `controlled-default-${randomUUID().slice(0, 8)}`;
  const prior = await inspectEnvironment({ workspacePath, environment });
  if (prior.status !== "ok" || prior.state !== "unprepared")
    throw new Error(
      `默认资料初始化要求尚未准备的独立环境；${environment} 当前为 ${prior.status === "ok" ? prior.state : prior.status}。已有环境请只用 environment enter 重入。`,
    );

  const cancellation = new AbortController();
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let operationCommitted = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      if (!operationCommitted) cancellation.abort(new Error(`收到 ${signal}`));
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  let prepared = false;
  let serviceReady = false;
  let initialized = false;
  let verificationPassed = false;
  let operationFailure: Error | undefined;
  let cleanupFailure: Error | undefined;
  const details: Record<string, unknown> = {
    command: request.command,
    environment,
    workspacePath,
    referenceManifestCounts: referenceCoverage,
    corpusDirectories: [audioPostsDirectory, publicationScreenDirectory],
    sourceMode: "controlled",
  };
  try {
    const controlled = await loadControlledSourceIo({ manifestPath });
    details["controlledSourceIo"] = {
      contentIdentity: controlled.contentIdentity,
      declaredRequests: controlled.entryIds.length,
      unknownRequests: "明确拒绝，不回退真实网络",
    };
    const preparation = await prepareEnvironment({
      workspacePath,
      environment,
      inputs: [audioPostsDirectory, publicationScreenDirectory],
      sourceMode: "controlled",
      config: {
        sourceIo: {
          manifestPath,
          contentIdentity: controlled.contentIdentity,
        },
      },
      signal: cancellation.signal,
    });
    details["preparation"] = preparation;
    assert.equal(preparation.status, "prepared");
    prepared = true;

    const started = await startEnvironment({
      workspacePath,
      environment,
      signal: cancellation.signal,
    });
    details["service"] = {
      status: started.status,
      runId: started.run.runId,
      address: started.run.address,
    };
    assert.equal(started.status, "ready");
    assert(started.run.address);
    serviceReady = true;
    const fetchRequest = fetchWithCancellation(cancellation.signal);
    const readiness = await fetchRequest(
      new URL("/api/ready", started.run.address),
    );
    assert.equal(readiness.status, 200, "真实产品服务 readiness 必须成功");
    details["readiness"] = "服务已就绪，初始资料尚未建立";

    const client = createPublicApiClient({
      baseUrl: started.run.address,
      fetch: fetchRequest,
    });
    await configureKeyConnection(client, "tmdb", "synthetic-tmdb-token");
    await configureKeyConnection(client, "omdb", "synthetic-omdb-key");
    await configureBangumi(client, started.run.address, fetchRequest);
    await configureFanbox(client);
    details["controlledConnections"] = {
      tmdb: "verified",
      omdb: "verified",
      bangumi: "authorized-by-controlled-oauth-flow",
      fanbox: "connected-by-controlled-pairing-flow",
      secretsExposedInEvidence: false,
    };

    const library = await client.saveAssetLibrary({
      displayName: "完整受控开发资料",
      directories: [audioPostsDirectory, publicationScreenDirectory],
      recognitionProfileIds: [
        "dlsite-voice",
        "fanbox",
        "books",
        "anime",
        "movies",
      ],
      sourceIdentities: [
        "dlsite",
        "fanbox",
        "nbinet",
        "bangumi",
        "tmdb",
        "omdb",
      ],
    });
    assert.equal(library.directories.length, 2);
    details["assetLibrary"] = {
      id: library.id,
      displayName: library.displayName,
      directoryCount: library.directories.length,
      directoryPaths: library.directories.map(({ path: directoryPath }) =>
        path.relative(workspacePath, directoryPath),
      ),
      recognitionProfileIds: library.recognitionProfileIds,
      sourceIdentities: library.sourceIdentities,
    };

    const scanStart = await client.startAssetLibraryScan(library.id);
    const scan = await waitForLibraryScan(
      client,
      scanStart.parentExecutionId,
      cancellation.signal,
    );
    details["scan"] = {
      parentExecutionId: scan.parentExecutionId,
      status: scan.status,
      outcome: scan.outcome,
      directories: scan.directories.map((directory) => ({
        id: directory.id,
        stage: directory.stage,
        outcome: directory.outcome,
        workItemCount: directory.workItemCount,
        unresolvedCount: directory.unresolvedCount,
        failedCount: directory.failedCount,
        filesWithAcceptedAssets: directory.files.filter(
          ({ assetId }) => assetId !== undefined,
        ).length,
      })),
    };
    assert.equal(scan.status, "completed", "正式资产库扫描必须完成");
    const [scanAssets, unrecognized] = await Promise.all([
      listAllAssets(client, library.id),
      listAllUnrecognizedMaterials(client, library.id),
    ]);
    const roots = countObservedReferenceRoots({
      coverage,
      scan,
      unrecognized,
      audioPostsDirectory,
      publicationScreenDirectory,
    });
    details["initialReferenceRootObservation"] = roots;
    assert.deepEqual(roots.missingObservedRoots, []);
    assert.deepEqual(roots.missingUnrecognizedRoots, []);
    assert.deepEqual(
      {
        safetyRoots: roots.safetyRoots,
        unrecognizedRoots: roots.unrecognizedRoots,
      },
      { safetyRoots: 29, unrecognizedRoots: 5 },
      "正式扫描与未识别材料查询必须分别实际覆盖29根安全观察和5根明确未识别",
    );
    assert.equal(
      roots.automaticallyAcceptedRoots,
      23,
      "受控整套扫描应直接接受其余23根正式识别资料",
    );
    assert.deepEqual(
      roots.pendingRecognitionRootIds,
      ["film-directed"],
      "film-directed 必须保留为待手工定向识别步骤",
    );
    const acceptedAssetIds = new Set(scanAssets.map(({ id }) => id));
    for (const [rootId, assetIds] of Object.entries(roots.scanAssetIdsByRoot))
      for (const assetId of assetIds)
        assert(
          acceptedAssetIds.has(assetId),
          `${rootId} 的正式扫描资产必须能够通过公开资产查询读回`,
        );
    for (const root of coverage.roots.filter(
      ({ recognition }) => recognition === "unrecognized",
    ))
      assert.deepEqual(
        roots.scanAssetIdsByRoot[root.id],
        [],
        `${root.id} 不得由正式扫描伪造成资产`,
      );

    const directedRoot = coverage.roots.find(
      ({ id }) => id === "film-directed",
    );
    assert(directedRoot);
    const directedRegistrationIds =
      roots.unrecognizedObservedRootIdsByRoot[directedRoot.id] ?? [];
    assert.equal(
      directedRegistrationIds.length,
      1,
      "film-directed 必须对应一个由公开未识别查询返回的真实目录授权",
    );
    const directedRelativeScope = path.relative(
      publicationScreenDirectory,
      path.join(
        publicationScreenDirectory,
        ...directedRoot.directory.split("/").slice(2),
      ),
    );
    assert(
      directedRelativeScope !== "" &&
        !directedRelativeScope.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(directedRelativeScope),
      "定向识别只能使用已登记出版影视目录下的嵌套范围",
    );
    const directedStart = await client.startDirectedRecognition({
      registrationId: directedRegistrationIds[0]!,
      relativeScope: directedRelativeScope,
      sourceIdentity: "tmdb",
      sourceInput: { movie: "9509" },
    });
    const directedExecution = await waitForExecution(
      client,
      directedStart.id,
      cancellation.signal,
    );
    assert(
      directedExecution.kind === "execution",
      "定向识别必须返回正式工作流执行，而非资产库扫描汇总",
    );
    assert.equal(
      directedExecution.status,
      "completed",
      "TMDB 定向识别必须完成正式执行",
    );
    assert(
      directedExecution.outcome === "accepted" ||
        directedExecution.outcome === "partially-succeeded",
      `TMDB 定向识别必须产生接受结局，实际为 ${String(directedExecution.outcome)}`,
    );
    const directedAssetIds = [
      ...new Set(
        directedExecution.progress.workItems.flatMap(({ acceptedAssetId }) =>
          acceptedAssetId === undefined ? [] : [acceptedAssetId],
        ),
      ),
    ];
    assert(directedAssetIds.length > 0, "定向识别正式执行必须返回已接受资产");
    const [assets, finalUnrecognized] = await Promise.all([
      listAllAssets(client, library.id),
      listAllUnrecognizedMaterials(client, library.id),
    ]);
    const finalAcceptedAssetIds = new Set(assets.map(({ id }) => id));
    for (const assetId of directedAssetIds)
      assert(
        finalAcceptedAssetIds.has(assetId),
        "定向识别接受的资产必须能由公开资产查询读回",
      );
    const finalRoots = countObservedReferenceRoots({
      coverage,
      scan,
      unrecognized: finalUnrecognized,
      audioPostsDirectory,
      publicationScreenDirectory,
    });
    assert.deepEqual(finalRoots.missingUnrecognizedRoots, []);
    assert.equal(
      finalRoots.unrecognizedRoots,
      5,
      "完成定向识别后，5根预期未识别资料仍须由正式未识别查询证实",
    );
    const handledRequiredRootIds = [
      ...new Set([...roots.automaticallyAcceptedRootIds, directedRoot.id]),
    ].sort();
    const expectedRequiredRootIds = coverage.roots
      .filter(({ recognition }) => recognition === "required")
      .map(({ id }) => id)
      .sort();
    assert.deepEqual(
      handledRequiredRootIds,
      expectedRequiredRootIds,
      "真实扫描与定向识别执行必须共同处理全部正式识别根",
    );

    const filmCase = publicationCases.cases.find(
      ({ id }) => id === "film-strict",
    );
    assert(filmCase, "独立出版与影视参考必须包含 film-strict");
    const expectedFilmTitle = filmCase.tmdbFacts?.find(
      ({ property }) => property === "asset.title",
    )?.value;
    const expectedFilmIntroduction = filmCase.tmdbFacts?.find(
      ({ property }) => property === "asset.introduction",
    )?.value;
    assert(expectedFilmTitle);
    assert(expectedFilmIntroduction);
    const directedCase = publicationCases.cases.find(
      ({ id }) => id === directedRoot.id,
    );
    assert(directedCase, "独立出版与影视参考必须包含 film-directed");
    const expectedDirectedTitle = directedCase.tmdbFacts?.find(
      ({ property }) => property === "asset.title",
    )?.value;
    const expectedDirectedIntroduction = directedCase.tmdbFacts?.find(
      ({ property }) => property === "asset.introduction",
    )?.value;
    assert(expectedDirectedTitle);
    assert(expectedDirectedIntroduction);
    const directedFilmAsset = assets.find(({ id }) =>
      directedAssetIds.includes(id),
    );
    assert(directedFilmAsset, "定向识别接受的影片资产必须可读回");
    const resolvedDirectedValues = directedFilmAsset.descriptions.flatMap(
      ({ metadata }) =>
        metadata.flatMap(({ property, result }) =>
          property !== "asset.title" && property !== "asset.introduction"
            ? []
            : result.status === "resolved"
              ? result.values.map(({ value }) => ({ property, value }))
              : [],
        ),
    );
    assert(
      resolvedDirectedValues.some(
        ({ property, value }) =>
          property === "asset.title" && value === expectedDirectedTitle,
      ),
      "定向识别必须从受控 TMDB 响应读回独立案例中的真实标题",
    );
    assert(
      resolvedDirectedValues.some(
        ({ property, value }) =>
          property === "asset.introduction" &&
          value === expectedDirectedIntroduction,
      ),
      "定向识别必须从受控 TMDB 响应读回独立案例中的真实简介",
    );
    assert(
      directedFilmAsset.sourceAssociations.some(
        ({ sourceIdentity, nativeAddress }) =>
          sourceIdentity === "tmdb" && nativeAddress.includes("/movie/9509"),
      ),
      "定向影片资产必须保留 TMDB 9509 的来源关联",
    );
    const filmAsset = assets.find(({ sourceAssociations }) =>
      sourceAssociations.some(
        ({ sourceIdentity, nativeAddress }) =>
          sourceIdentity === "tmdb" && nativeAddress.includes("/movie/209764"),
      ),
    );
    assert(filmAsset, "正式扫描必须读回 film-strict 的 TMDB 资产");
    const resolvedFilmValues = filmAsset.descriptions.flatMap(({ metadata }) =>
      metadata.flatMap(({ property, result }) =>
        property !== "asset.title" && property !== "asset.introduction"
          ? []
          : result.status === "resolved"
            ? result.values.map(({ value }) => ({ property, value }))
            : [],
      ),
    );
    assert(
      resolvedFilmValues.some(
        ({ property, value }) =>
          property === "asset.title" && value === expectedFilmTitle,
      ),
      "正式扫描应从受控官方响应读取真实影片标题",
    );
    assert(
      resolvedFilmValues.some(
        ({ property, value }) =>
          property === "asset.introduction" &&
          value === expectedFilmIntroduction,
      ),
      "正式扫描应从受控官方响应读取真实影片简介",
    );
    assert(
      filmAsset.descriptions.some((description) =>
        description.artifactRoles.some(
          ({ role }) => role === "asset.primary-cover",
        ),
      ),
      "正式扫描必须为影片建立主封面产物关联",
    );
    assert(
      filmAsset.sourceArtifacts?.some(
        ({ role }) => role === "asset.primary-cover",
      ),
      "正式扫描必须读取并持久化影片主封面来源产物",
    );
    details["directedRecognition"] = {
      rootId: directedRoot.id,
      registrationId: directedRegistrationIds[0],
      relativeScope: directedRelativeScope,
      sourceIdentity: "tmdb",
      submittedInput: { movie: "9509" },
      executionId: directedExecution.id,
      status: directedExecution.status,
      outcome: directedExecution.outcome,
      acceptedAssetIds: directedAssetIds,
    };
    details["finalReferenceRootObservation"] = {
      safetyRoots: roots.safetyRoots,
      automaticallyAcceptedRoots: roots.automaticallyAcceptedRoots,
      directedAcceptedRoots: 1,
      recognizedRequiredRoots: handledRequiredRootIds.length,
      explicitlyUnrecognizedRoots: finalRoots.unrecognizedRoots,
      unrecognizedRootIds: finalRoots.unrecognizedRootIds,
      initialUnrecognizedMaterialCount: unrecognized.length,
      finalUnrecognizedMaterialCount: finalUnrecognized.length,
      assetCount: assets.length,
    };
    details["productResults"] = {
      assetCount: assets.length,
      unrecognizedMaterialCount: finalUnrecognized.length,
      checkedOfficialMovieTitle: expectedFilmTitle,
      checkedOfficialMovieIntroduction: true,
      checkedDirectedMovieTitle: expectedDirectedTitle,
      checkedDirectedMovieIntroduction: true,
      checkedManagedPrimaryCover: true,
      libraryId: library.id,
      scanExecutionId: scan.parentExecutionId,
      directedExecutionId: directedExecution.id,
    };

    details["completionBoundary"] =
      "真实受控服务和 SQLite 已完成两父目录扫描、TMDB 定向识别及公开结果读回；启动 ready 与资料业务完成分别报告。";
    cancellation.signal.throwIfAborted();
    operationCommitted = true;
    initialized = true;
    verificationPassed = request.command === "verify";
  } catch (error) {
    const failure =
      error instanceof Error ? error : new Error("默认受控资料初始化失败");
    const cancellationFailure = cancellation.signal.aborted
      ? cancellation.signal.reason instanceof Error
        ? cancellation.signal.reason
        : new Error("默认受控资料初始化已取消")
      : undefined;
    if (cancellationFailure !== undefined) {
      details["cancellation"] = cancellationFailure.message;
      operationFailure =
        failure === cancellationFailure
          ? cancellationFailure
          : new Error(cancellationFailure.message, { cause: failure });
    } else {
      operationFailure = failure;
    }
    details["failure"] = operationFailure.message;
    details["environmentRetainedForInspection"] = prepared;
  } finally {
    try {
      if (serviceReady && (!initialized || verificationPassed)) {
        const stopped = await stopEnvironment({
          workspacePath,
          environment,
        });
        details["stop"] = stopped.status;
        assert(
          stopped.status === "stopped" || stopped.status === "already-stopped",
          stopped.failure?.message ?? "停止受控环境失败",
        );
        if (verificationPassed) {
          const deleted = await deleteEnvironment({
            workspacePath,
            environment,
          });
          details["delete"] = deleted.status;
          assert.equal(deleted.status, "deleted");
        }
        if (!initialized)
          details["cleanupExplanation"] =
            `已停止本次启动的服务并保留环境 ${environment} 供排查。`;
      }
    } catch (error) {
      cleanupFailure =
        error instanceof Error ? error : new Error("环境收尾失败");
      details["cleanupFailure"] = cleanupFailure.message;
    }
    for (const [signal, handler] of signalHandlers)
      process.removeListener(signal, handler);
    process.stdout.write(`${JSON.stringify(details, null, 2)}\n`);
  }
  if (operationFailure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError(
      [operationFailure, cleanupFailure],
      "受控默认流程失败，且环境收尾也失败",
    );
  if (operationFailure !== undefined) throw operationFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

const request = parseRequest(process.argv.slice(2));
await runControlledDefault(request);
