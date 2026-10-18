import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createPublicApiClient,
  type PublicApiClient,
  type PublicCurrentAsset,
  type PublicUnrecognizedMaterial,
} from "@digital/public-api";

export type PreviewCorpusCase = {
  readonly id: string;
  readonly kind:
    | "audio"
    | "post"
    | "unrecognized"
    | "epub"
    | "pdf"
    | "anime"
    | "film";
  readonly directory: string;
  readonly directed?: boolean;
  readonly tmdb?: number;
  readonly sourceFailures?: readonly {
    readonly sourceIdentity: string;
    readonly reason: string;
  }[];
  readonly official?: { readonly isbn: string };
};

export type IntakeOutcome = {
  readonly assetLibraryId: string;
  readonly observedRootIds: readonly string[];
  readonly executionId: string;
  readonly executionStatus: string;
  readonly executionOutcome: string | undefined;
  readonly assetIds: readonly string[];
  readonly reused: boolean;
  readonly unrecognizedMaterials: readonly PublicUnrecognizedMaterial[];
  readonly directories: readonly {
    readonly path: string;
    readonly id: string;
    readonly observedRootId?: string;
  }[];
};

export type CurrentMetadataValue = {
  readonly property: string;
  readonly value: string;
  readonly sourceIdentity: string;
  readonly sourceSlot: string;
};

export function currentMetadataValues(
  asset: PublicCurrentAsset,
  property: string,
): CurrentMetadataValue[] {
  return asset.descriptions.flatMap((description) =>
    description.metadata
      .filter((metadata) => metadata.property === property)
      .flatMap((metadata) =>
        metadata.result.status === "resolved"
          ? metadata.result.values.map(
              ({ value, sourceIdentity, sourceSlot }) => ({
                property,
                value,
                sourceIdentity,
                sourceSlot,
              }),
            )
          : [],
      ),
  );
}

export function hasArtifactRole(
  asset: PublicCurrentAsset,
  role: string,
): boolean {
  return asset.descriptions.some((description) =>
    description.artifactRoles.some((artifact) => artifact.role === role),
  );
}

export function artifactRoleAddress(
  asset: PublicCurrentAsset,
  role: string,
): string | undefined {
  return asset.descriptions
    .flatMap((description) => description.artifactRoles)
    .find((artifact) => artifact.role === role)?.address;
}

export function createCorpusClient(
  address: string,
  signal: AbortSignal,
): PublicApiClient {
  const fetchWithCancellation: typeof globalThis.fetch = async (
    input,
    init,
  ) => {
    signal.throwIfAborted();
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return await globalThis.fetch(input, {
      ...init,
      signal:
        requestSignal === undefined
          ? signal
          : AbortSignal.any([signal, requestSignal]),
    });
  };
  return createPublicApiClient({
    baseUrl: address,
    fetch: fetchWithCancellation,
  });
}

export async function waitForProductReady(
  address: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = "尚未收到就绪响应";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(new URL("/api/ready", address), { signal });
      const body: unknown = await response.json().catch(() => undefined);
      if (
        response.ok &&
        typeof body === "object" &&
        body !== null &&
        "ok" in body &&
        body.ok === true
      )
        return;
      lastResponse = `HTTP ${String(response.status)} ${JSON.stringify(body)}`;
    } catch (error) {
      signal.throwIfAborted();
      lastResponse = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `产品服务在 ${String(timeoutMs)} ms 内未就绪：${lastResponse}`,
  );
}

export async function listAllAssetLibraries(client: PublicApiClient) {
  const items: Awaited<
    ReturnType<typeof client.listAssetLibraries>
  >["items"][number][] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAssetLibraries({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

async function assets(client: PublicApiClient, assetLibraryId: string) {
  const items: Awaited<
    ReturnType<typeof client.listAssets>
  >["items"][number][] = [];
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

async function unrecognizedMaterials(
  client: PublicApiClient,
  assetLibraryId: string,
  parentExecutionId: string,
): Promise<PublicUnrecognizedMaterial[]> {
  const items: PublicUnrecognizedMaterial[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listUnrecognizedMaterials({
      assetLibraryId,
      parentExecutionId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

export async function waitForAssetLibraryScan(
  client: PublicApiClient,
  executionId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let scan = await client.inspectAssetLibraryScan(executionId);
  while (scan.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    scan = await client.inspectAssetLibraryScan(executionId);
  }
  if (scan.status !== "completed")
    throw new Error(`目录扫描未正常完成：${scan.status}`);
  return scan;
}

export async function waitForPublicExecution(
  client: PublicApiClient,
  executionId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let execution = await client.inspectExecution(executionId);
  while (execution.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    execution = await client.inspectExecution(executionId);
  }
  if (execution.status !== "completed")
    throw new Error(`产品工作流未正常完成：${execution.status}`);
  return execution;
}

export async function waitForSourceEnrichment(
  client: PublicApiClient,
  executionId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let inspection = await client.inspectSourceEnrichment(executionId);
  while (inspection.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    inspection = await client.inspectSourceEnrichment(executionId);
  }
  return inspection;
}

/** 已存在（包括撤销、不可用）的配置由使用者持有，预览不能暗中替换或恢复。 */
async function connectionNeedsConfiguration(
  client: PublicApiClient,
  id: "tmdb" | "omdb" | "bangumi",
): Promise<boolean> {
  return (
    (await client.getSourceConnection(id)).credentialStatus === "unconfigured"
  );
}

export async function configureAudioPostSources(
  client: PublicApiClient,
  fixture: string,
  cases: readonly PreviewCorpusCase[],
): Promise<void> {
  if (!cases.some((item) => item.kind === "post")) return;
  const created = await client.createFanboxConnectionRequest({
    creatorId: "customudon",
  });
  const pairing = await client.getFanboxConnectionRequestForPairing({
    requestId: created.request.id,
    pairingCode: created.pairingCode,
  });
  assert.equal(pairing.status, "waiting");
  const browserCredential: unknown = JSON.parse(
    await readFile(
      path.join(fixture, "connections/synthetic-customudon.json"),
      "utf8",
    ),
  );
  const completed = await client.completeFanboxConnectionRequest({
    requestId: created.request.id,
    pairingCode: created.pairingCode,
    browserCredential,
  });
  assert.equal(completed.status, "succeeded");
}

export async function configurePublicationScreenSources(
  client: PublicApiClient,
  cases: readonly PreviewCorpusCase[],
  address: string,
  signal: AbortSignal,
): Promise<readonly unknown[]> {
  const configured: unknown[] = [];
  if (cases.some((c) => c.kind === "film")) {
    for (const sourceId of ["tmdb", "omdb"] as const) {
      const current = await client.getSourceConnection(sourceId);
      if (current.credentialStatus !== "unconfigured") continue;
      const result = await client.configureSourceConnection({
        sourceId,
        expectedVersion: current.version,
        secret:
          sourceId === "tmdb" ? "synthetic-tmdb-token" : "synthetic-omdb-key",
      });
      assert.equal(result.verification, "verified");
      configured.push({ source: sourceId, inspection: result.connection });
    }
  }
  if (
    cases.some((c) => c.kind === "anime") &&
    (await connectionNeedsConfiguration(client, "bangumi"))
  ) {
    const callbackUrl = new URL(
      "/api/v1/source-connections/bangumi/callback",
      address,
    );
    await client.configureBangumiOAuthClient({
      clientId: "synthetic-client",
      clientSecret: "synthetic-client-secret",
      redirectUri: callbackUrl.toString(),
    });
    const authorization = await client.beginBangumiAuthorization();
    callbackUrl.searchParams.set(
      "state",
      new URL(authorization.authorizationUrl).searchParams.get("state") ?? "",
    );
    callbackUrl.searchParams.set("code", "synthetic-code");
    const callback = await fetch(callbackUrl, { signal });
    assert.equal(callback.status, 200);
    const attempt = await client.getBangumiAuthorizationAttempt(
      authorization.attemptId,
    );
    assert.equal(attempt.status, "succeeded");
    configured.push({ source: "bangumi", inspection: attempt });
  }
  return configured;
}

export async function intakeAudioPostCase(
  client: PublicApiClient,
  fixture: string,
  item: PreviewCorpusCase,
  workflowTimeoutMs = 300_000,
  displayName = `轻量资料 ${item.id}`,
): Promise<IntakeOutcome> {
  return await intakeDirectories(client, {
    displayName,
    directories: [path.join(fixture, item.directory)],
    recognitionProfileIds:
      item.kind === "audio"
        ? ["dlsite-voice"]
        : item.kind === "post"
          ? ["fanbox"]
          : ["dlsite-voice", "fanbox", "books", "anime", "movies"],
    sourceIdentities: ["dlsite", "fanbox"],
    workflowTimeoutMs,
  });
}

export async function intakePublicationScreenCase(
  client: PublicApiClient,
  fixture: string,
  item: PreviewCorpusCase,
  workflowTimeoutMs = 300_000,
  displayName = `出版物与影视资料 ${item.id}`,
): Promise<{
  readonly intake: IntakeOutcome;
  readonly operations: Readonly<Record<string, unknown>>;
}> {
  const intake = await intakeDirectories(client, {
    displayName,
    directories: [path.join(fixture, item.directory)],
    recognitionProfileIds: [
      item.kind === "anime"
        ? "anime"
        : item.kind === "film"
          ? "movies"
          : "books",
    ],
    sourceIdentities:
      item.kind === "anime"
        ? ["bangumi"]
        : item.kind === "film"
          ? ["tmdb", "omdb"]
          : ["nbinet"],
    workflowTimeoutMs,
  });
  const operations: Record<string, unknown> = {};
  const rootId = intake.observedRootIds[0];
  if (item.kind === "anime" && !intake.reused) {
    const assetId = intake.assetIds[0];
    assert(assetId, "Bangumi 正式刷新需要一个已接受的 episode asset");
    const refresh = await client.startMetadataRefresh({ subjectId: assetId });
    operations["normalSourceRefresh"] = refresh;
    const execution = await waitForPublicExecution(
      client,
      refresh.id,
      workflowTimeoutMs,
    );
    operations["normalSourceRefreshExecution"] = execution;
    assert(
      execution.outcome === "accepted" || execution.outcome === "no-change",
      `正常来源 metadata refresh 必须完成并保留原资产身份：${JSON.stringify(execution)}`,
    );
  }
  if (item.directed) {
    assert.equal(intake.assetIds.length, 0, "非规范收藏包不应自动制造资产");
    assert(rootId, "定向识别必须有正式未识别材料登记");
    const directed = await client.startDirectedRecognition({
      registrationId: rootId,
      relativeScope: ".",
      sourceIdentity: "tmdb",
      sourceInput: { movie: String(item.tmdb) },
    });
    operations["directed"] = directed;
    const execution = await waitForPublicExecution(
      client,
      directed.id,
      workflowTimeoutMs,
    );
    operations["directedExecution"] = execution;
    assert(
      execution.outcome === "accepted" ||
        execution.outcome === "partially-succeeded",
      "定向采集必须明确受理或部分完成",
    );
  }
  if (item.official && !intake.reused) {
    const assetId = intake.assetIds[0];
    assert(assetId, "国家图书馆补充需要正式扫描建立的资产");
    const enrichment = await client.startSourceEnrichment({
      subjectId: assetId,
      sourceIdentity: "nbinet",
      sourceInput: { isbn: item.official.isbn },
      assetLibraryId: intake.assetLibraryId,
    });
    operations["enrichment"] = enrichment;
    const execution = await waitForSourceEnrichment(
      client,
      enrichment.id,
      workflowTimeoutMs,
    );
    operations["enrichmentExecution"] = execution;
    assert.equal(execution.status, "completed");
    assert(
      execution.outcome === "accepted" || execution.outcome === "no-change",
      "国家图书馆资料应被采纳，或该来源已处于当前状态",
    );
  }
  return { intake, operations };
}

/**
 * 正式目录接入：按正式配置建立或扩充资产库、扫描并经公共检查读取当前材料归属。
 * 已被某库覆盖的路径继续沿用该库；其余路径按完整输入并入同一登记，不伪造观察或资产。
 */
export async function intakeDirectories(
  client: PublicApiClient,
  input: {
    readonly displayName: string;
    readonly directories: readonly string[];
    readonly recognitionProfileIds: readonly string[];
    readonly sourceIdentities: readonly string[];
    readonly workflowTimeoutMs: number;
  },
): Promise<IntakeOutcome> {
  const allLibraries = await listAllAssetLibraries(client);
  const wanted = [...new Set(input.directories)];
  const covered = allLibraries.filter((library) =>
    library.directories.some((directory) => wanted.includes(directory.path)),
  );
  const missing = wanted.filter(
    (directory) =>
      !covered.some((library) =>
        library.directories.some((entry) => entry.path === directory),
      ),
  );
  let assetLibraryId: string;
  if (covered.length === 0) {
    const library = await client.saveAssetLibrary({
      displayName: input.displayName,
      directories: wanted,
      recognitionProfileIds: [...input.recognitionProfileIds],
      sourceIdentities: [...input.sourceIdentities],
    });
    assetLibraryId = library.id;
  } else {
    const target = covered[0]!;
    if (missing.length > 0) {
      const library = await client.saveAssetLibrary({
        id: target.id,
        expectedVersion: target.configVersion,
        displayName: target.displayName,
        directories: [
          ...target.directories.map((directory) => directory.path),
          ...missing,
        ],
        recognitionProfileIds: [...input.recognitionProfileIds],
        sourceIdentities: [...input.sourceIdentities],
      });
      assetLibraryId = library.id;
    } else {
      assetLibraryId = target.id;
    }
  }
  const refreshedLibraries = await listAllAssetLibraries(client);
  const stillCovering = refreshedLibraries.filter((library) =>
    library.directories.some((directory) => wanted.includes(directory.path)),
  );
  const scans = [];
  const allUnrecognized: PublicUnrecognizedMaterial[] = [];
  const registeredDirectories: IntakeOutcome["directories"][number][] = [];
  const allAssetIds = new Set<string>();
  for (const library of stillCovering) {
    const started = await client.startAssetLibraryScan(library.id);
    const scan = await waitForAssetLibraryScan(
      client,
      started.parentExecutionId,
      input.workflowTimeoutMs,
    );
    scans.push(scan);
    allUnrecognized.push(
      ...(await unrecognizedMaterials(
        client,
        library.id,
        scan.parentExecutionId,
      )),
    );
    for (const directory of library.directories) {
      if (!wanted.includes(directory.path)) continue;
      const localIntake = await client.inspectLocalIntake({
        assetLibraryId: library.id,
        directoryId: directory.id,
        parentExecutionId: scan.parentExecutionId,
      });
      const matchingScanDirectories = scan.directories.filter(
        (entry) => entry.displayName === directory.displayName,
      );
      registeredDirectories.push({
        path: directory.path,
        id: directory.id,
        ...(matchingScanDirectories.length !== 1
          ? {}
          : { observedRootId: matchingScanDirectories[0]!.id }),
      });
      for (const file of localIntake.files)
        for (const assetId of file.assetIds) allAssetIds.add(assetId);
    }
  }
  const observedRootIds = [
    ...new Set(scans.flatMap((scan) => scan.directories.map(({ id }) => id))),
  ];
  const primaryScan = scans[0];
  assert(primaryScan, "目录接入必须产生正式扫描");
  return {
    assetLibraryId,
    observedRootIds,
    executionId: primaryScan.parentExecutionId,
    executionStatus: primaryScan.status,
    executionOutcome: primaryScan.outcome,
    assetIds: [...allAssetIds],
    reused: covered.length > 0 && missing.length === 0,
    unrecognizedMaterials: allUnrecognized,
    directories: registeredDirectories,
  };
}

export async function listAllAssets(
  client: PublicApiClient,
  assetLibraryId: string,
): Promise<PublicCurrentAsset[]> {
  return await assets(client, assetLibraryId);
}

export async function findAsset(
  client: PublicApiClient,
  assetLibraryId: string,
  assetId: string,
): Promise<PublicCurrentAsset> {
  const asset = (await listAllAssets(client, assetLibraryId)).find(
    (candidate) => candidate.id === assetId,
  );
  assert(asset, `正式资产列表缺少 ${assetId}`);
  return asset;
}

export async function sourceRecordContents(
  client: PublicApiClient,
  assetId: string,
): Promise<
  readonly {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
    readonly content: string;
  }[]
> {
  const records = await client.listAssetEvidence(assetId, {
    kind: "source-records",
    limit: 100,
  });
  const result: {
    sourceIdentity: string;
    nativeAddress: string;
    content: string;
  }[] = [];
  for (const record of records.items) {
    if (record.kind !== "source-record" || record.status !== "available")
      continue;
    let content = "";
    let offset = 0;
    let complete = false;
    while (!complete) {
      const chunk = await client.readAssetSourceRecord(assetId, record.id, {
        offset,
        limit: 4096,
      });
      content += chunk.content;
      offset = chunk.nextOffset;
      complete = chunk.complete;
    }
    result.push({
      sourceIdentity: record.sourceIdentity ?? "",
      nativeAddress: record.nativeAddress ?? "",
      content,
    });
  }
  return result;
}
