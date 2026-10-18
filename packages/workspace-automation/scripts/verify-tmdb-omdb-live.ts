import assert from "node:assert/strict";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  inspectEnvironment,
  startEnvironment,
  stopEnvironment,
  type StartOperationResult,
  type StopOperationResult,
} from "@digital/environment";
import {
  createPublicApiClient,
  type PublicAssetLibrary,
  type PublicAssetLibraryScan,
  type PublicCurrentAsset,
  type PublicExecutionInspection,
} from "@digital/public-api";
import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  intakeDirectories,
  createCorpusClient,
  listAllAssets,
  listAllAssetLibraries,
  waitForAssetLibraryScan,
  waitForProductReady,
  waitForPublicExecution,
} from "./corpus-verification.ts";
import { requireInput } from "./inputs.ts";

type ReviewedFilm = {
  readonly title: string;
  readonly sourceAssociations: {
    readonly Tmdb: string;
    readonly Imdb: string;
  };
  readonly container?: "Blu-ray package";
  readonly packageFileCount?: number;
};

type ReviewedOracle = {
  readonly video: {
    readonly film: ReviewedFilm;
    readonly collectorFilm: ReviewedFilm;
  };
};

type SourceRecord = {
  readonly id: string;
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
  readonly status: string;
};

type PublicEvidenceItem = Awaited<
  ReturnType<ReturnType<typeof createPublicApiClient>["listAssetEvidence"]>
>["items"][number];

type PublicCurrentValue = Extract<
  PublicEvidenceItem,
  { kind: "current-value" }
>;

type PublicWorkflowHistoryItem = Awaited<
  ReturnType<ReturnType<typeof createPublicApiClient>["listWorkflowHistory"]>
>["items"][number];

const workspacePath = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
const environment = process.argv[2];
const evidenceArgument = process.argv[3];
const strictFilmArgument = process.argv[4];
const bdmvArgument = process.argv[5];
assert(
  environment !== undefined &&
    evidenceArgument !== undefined &&
    evidenceArgument.length > 0 &&
    !path.isAbsolute(evidenceArgument) &&
    strictFilmArgument !== undefined &&
    path.isAbsolute(strictFilmArgument) &&
    bdmvArgument !== undefined &&
    path.isAbsolute(bdmvArgument),
  "用法：pnpm verify:tmdb-omdb-live <已授权且已停止的环境名> <证据文件> <恐怖直播资料根绝对路径> <怒火救援BDMV资料根绝对路径>",
);

const evidencePath = path.resolve(workspacePath, evidenceArgument);
const strictFilmRoot = path.resolve(strictFilmArgument);
const bdmvRoot = path.resolve(bdmvArgument);
const packageRequire = createRequire(import.meta.url);
const oraclePath = packageRequire.resolve(
  "@digital/preview-corpus/live/reviewed-oracle.json",
);
const selectionPath = packageRequire.resolve(
  "@digital/preview-corpus/live/files-from.txt",
);
const oracle = JSON.parse(await readFile(oraclePath, "utf8")) as ReviewedOracle;
const selection = (await readFile(selectionPath, "utf8"))
  .split(/\r?\n/u)
  .map((line) => line.trim().replace(/\/+$/u, ""))
  .filter((line) => line.length > 0 && !line.startsWith("#"));
const strictLogicalRoot = "media/电影/恐怖直播 (2013)";
const bdmvLogicalRoot =
  "media/电影/[怒火救援].Man.on.Fire.2004.Blu-ray.1080p.AVC.DTS-HD.MA5.1-CMCT";
assert(selection.includes(strictLogicalRoot));
assert(selection.includes(bdmvLogicalRoot));
assert.equal(
  path.basename(strictFilmRoot),
  path.posix.basename(strictLogicalRoot),
);
assert.equal(path.basename(bdmvRoot), path.posix.basename(bdmvLogicalRoot));
assert.equal(oracle.video.film.sourceAssociations.Tmdb, "209764");
assert.equal(oracle.video.collectorFilm.sourceAssociations.Tmdb, "9509");
assert.equal(oracle.video.collectorFilm.container, "Blu-ray package");

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  environment,
  status: "running",
  materials: [strictLogicalRoot, bdmvLogicalRoot],
  sourceConnections: [],
};
const save = async (): Promise<void> => {
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, undefined, 2)}\n`);
};

async function materialRootExists(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

function safeOperationMessage(message: string): string {
  return message
    .replace(
      /(authorization|cookie|token|secret|password|api[_-]?key|client[_-]?secret|code)=([^&\s]+)/giu,
      "$1=[已省略]",
    )
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [已省略]");
}

function safeThrownFailure(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  return {
    name:
      error instanceof Error && error.name.length > 0 ? error.name : "Error",
    message: safeOperationMessage(
      error instanceof Error ? error.message : String(error),
    ),
  };
}

function operationEvidence(
  operation: StartOperationResult | StopOperationResult,
): Record<string, unknown> {
  return {
    status: operation.status,
    environment: {
      environmentId: operation.environment.environmentId,
      dataGeneration: operation.environment.dataGeneration,
    },
    run: {
      runId: operation.run.runId,
      state: operation.run.state,
      processLiveness: operation.run.processLiveness,
      serviceReady: operation.run.serviceReady,
    },
    failure:
      operation.failure === undefined
        ? undefined
        : {
            stage: operation.failure.stage,
            message: safeOperationMessage(operation.failure.message),
            exitCode: operation.failure.exitCode,
          },
    cleanup: {
      state: operation.cleanup.state,
      errors: operation.cleanup.errors.map(safeOperationMessage),
    },
    diagnostics: operation.diagnostics.map(safeOperationMessage),
  };
}

type OwnedEnvironmentRun = {
  readonly runId: string;
  readonly environmentId: string;
  readonly dataGeneration: string;
};

function ownedRunFromStart(input: {
  readonly started: StartOperationResult;
  readonly previousRunId: string | null;
  readonly environmentId: string;
  readonly dataGeneration: string;
}): OwnedEnvironmentRun | undefined {
  const mayOwnRun =
    input.started.status === "ready" ||
    (input.started.status === "failed" &&
      input.started.cleanup.state === "unknown");
  if (
    !mayOwnRun ||
    input.started.run.runId === null ||
    input.started.run.runId === input.previousRunId ||
    input.started.environment.environmentId !== input.environmentId ||
    input.started.environment.dataGeneration !== input.dataGeneration
  )
    return undefined;
  return {
    runId: input.started.run.runId,
    environmentId: input.environmentId,
    dataGeneration: input.dataGeneration,
  };
}

async function assertNoChangeMaterialReadback(input: {
  readonly client: ReturnType<typeof createPublicApiClient>;
  readonly library: PublicAssetLibrary;
  readonly scan: PublicAssetLibraryScan;
  readonly directoryPath: string;
  readonly asset: PublicCurrentAsset;
}): Promise<void> {
  const directories = input.library.directories.filter(
    (directory) => path.resolve(directory.path) === input.directoryPath,
  );
  assert.equal(directories.length, 1, "资料根必须唯一关联正式目录授权");
  const [directory] = directories;
  assert(directory);
  assert.equal(input.scan.status, "completed");
  assert.equal(input.scan.assetLibraryId, input.library.id);

  const intake = await input.client.inspectLocalIntake({
    assetLibraryId: input.library.id,
    directoryId: directory.id,
    parentExecutionId: input.scan.parentExecutionId,
  });
  assert.equal(intake.assetLibraryId, input.library.id);
  assert.equal(intake.directoryId, directory.id);
  assert.equal(intake.execution?.status, "completed");
  assert(intake.execution?.id, "本地材料检查必须返回正式扫描子执行身份");
  assert(intake.files.length > 0, "无变化扫描后必须能读回本地材料");
  assert(intake.files.every((file) => file.problem === undefined));
  const child = await waitForPublicExecution(
    input.client,
    intake.execution.id,
    300_000,
  );
  assert.equal(child.kind, "execution");
  assert.equal(child.id, intake.execution.id);
  assert.equal(child.outcome, "no-change");
  assert(child.progress.workItems.length > 0);
  const filesByPath = new Map(
    intake.files.map((file) => [file.relativePath, file]),
  );
  const workItemPaths: string[] = [];
  for (const item of child.progress.workItems) {
    assert.equal(item.outcome, "no-change");
    assert(item.relativePaths.length > 0);
    const retainedAssetId = item.retainedAssetId;
    assert(retainedAssetId, "无变化工作项必须保留原资产身份");
    const itemFiles = item.relativePaths.map((relativePath) => {
      const file = filesByPath.get(relativePath);
      assert(file, `扫描工作项超出当前授权目录：${relativePath}`);
      workItemPaths.push(relativePath);
      return file;
    });
    assert.deepEqual(
      [...new Set(itemFiles.flatMap((file) => file.assetIds))].toSorted(),
      [retainedAssetId],
    );
  }
  assert.deepEqual(
    [...workItemPaths].toSorted(),
    [...filesByPath.keys()].toSorted(),
    "扫描子执行必须覆盖本次授权目录读回的全部材料路径",
  );
  const assetIds = [
    ...new Set(intake.files.flatMap((file) => file.assetIds)),
  ].toSorted();
  assert.deepEqual(
    assetIds,
    [input.asset.id],
    "无变化扫描不含资产身份；正式本地材料读回必须保留唯一资产关联",
  );
}

async function stopOwnedRun(input: {
  readonly owned: OwnedEnvironmentRun;
  readonly evidenceKey: string;
}): Promise<Awaited<ReturnType<typeof inspectEnvironment>>> {
  const before = await inspectEnvironment({
    workspacePath,
    environment: environment!,
  });
  assert.equal(before.status, "ok");
  assert.equal(before.environment.environmentId, input.owned.environmentId);
  assert.equal(before.environment.dataGeneration, input.owned.dataGeneration);
  assert.equal(
    before.run.runId,
    input.owned.runId,
    "环境运行世代已变化；拒绝停止当前服务",
  );
  const stopped = await stopEnvironment({
    workspacePath,
    environment: environment!,
  });
  evidence[input.evidenceKey] = operationEvidence(stopped);
  assert(
    stopped.status === "stopped" || stopped.status === "already-stopped",
    "无法确认本次服务世代已停止",
  );
  const after = await inspectEnvironment({
    workspacePath,
    environment: environment!,
  });
  assert.equal(after.status, "ok");
  assert.equal(after.state, "prepared");
  assert.equal(after.environment.environmentId, input.owned.environmentId);
  assert.equal(after.environment.dataGeneration, input.owned.dataGeneration);
  assert(after.run.state === "stopped" || after.run.state === "absent");
  assert(
    after.run.processLiveness === "exited" ||
      after.run.processLiveness === "absent",
  );
  return after;
}

async function sourceRecords(
  client: ReturnType<typeof createPublicApiClient>,
  assetId: string,
): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAssetEvidence(assetId, {
      kind: "source-records",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of page.items)
      if (
        item.kind === "source-record" &&
        item.sourceIdentity !== undefined &&
        item.nativeAddress !== undefined
      )
        records.push({
          id: item.id,
          sourceIdentity: item.sourceIdentity,
          nativeAddress: item.nativeAddress,
          status: item.status,
        });
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return records;
}

async function currentValues(
  client: ReturnType<typeof createPublicApiClient>,
  assetId: string,
): Promise<PublicCurrentValue[]> {
  const items: PublicEvidenceItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAssetEvidence(assetId, {
      kind: "current-values",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items.filter(
    (item): item is PublicCurrentValue => item.kind === "current-value",
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    JSON.stringify([...left].toSorted()) ===
    JSON.stringify([...right].toSorted())
  );
}

async function workflowHistory(
  client: ReturnType<typeof createPublicApiClient>,
  executionId: string,
): Promise<PublicWorkflowHistoryItem> {
  let cursor: string | undefined;
  do {
    const page = await client.listWorkflowHistory({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const matching = page.items.find(
      (item) => item.execution.id === executionId,
    );
    if (matching) return matching;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  throw new Error(`公开执行历史中缺少本次刷新：${executionId}`);
}

function sourceAddresses(film: ReviewedFilm): readonly {
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
}[] {
  return [
    {
      sourceIdentity: "tmdb",
      nativeAddress: `https://www.themoviedb.org/movie/${film.sourceAssociations.Tmdb}`,
    },
    {
      sourceIdentity: "omdb",
      nativeAddress: `omdb:imdb:${film.sourceAssociations.Imdb}`,
    },
  ];
}

async function assertFilmProjection(
  client: ReturnType<typeof createPublicApiClient>,
  asset: PublicCurrentAsset,
  expected: ReviewedFilm,
): Promise<void> {
  const expectedSources = sourceAddresses(expected);
  const associations = asset.sourceAssociations
    .map(({ sourceIdentity, nativeAddress }) => ({
      sourceIdentity,
      nativeAddress,
    }))
    .toSorted((left, right) =>
      `${left.sourceIdentity}:${left.nativeAddress}`.localeCompare(
        `${right.sourceIdentity}:${right.nativeAddress}`,
      ),
    );
  assert.deepEqual(
    associations,
    [...expectedSources].toSorted((left, right) =>
      `${left.sourceIdentity}:${left.nativeAddress}`.localeCompare(
        `${right.sourceIdentity}:${right.nativeAddress}`,
      ),
    ),
  );
  assert.deepEqual(asset.recognitionSourceAssociation, expectedSources[0]);
  const values = await currentValues(client, asset.id);
  const titleEvidence = values.find(
    (item) =>
      item.target.kind === "entity" &&
      item.target.entityId === asset.id &&
      item.evidence.property === "asset.title",
  );
  assert(titleEvidence, "TMDB 当前标题必须可从公开依据检查");
  assert.equal(titleEvidence.evidence.result.status, "resolved");
  if (titleEvidence.evidence.result.status !== "resolved")
    throw new Error("TMDB 当前标题没有确定的公开值");
  const selectedTitle = titleEvidence.evidence.result.values.find(
    (value) => value.sourceIdentity === "tmdb",
  );
  const records = await sourceRecords(client, asset.id);
  assert(selectedTitle, "TMDB 必须提供当前选定标题");
  assert.equal(selectedTitle.value, expected.title);
  assert.deepEqual(selectedTitle.reasoning, {
    kind: "source-preference",
    preferredSource: "tmdb",
  });
  assert.equal(
    new Set(selectedTitle.sourceRecordIds).size,
    selectedTitle.sourceRecordIds.length,
    "当前标题来源记录不能重复",
  );
  assert(
    selectedTitle.assertions.every(
      (assertion) => assertion.sourceSlot === selectedTitle.sourceSlot,
    ),
    "当前标题断言必须引用自己的来源槽",
  );
  assert(
    selectedTitle.sourceRecordIds.every((id) =>
      records.some(
        (record) =>
          record.id === id &&
          record.sourceIdentity === "tmdb" &&
          record.status === "available",
      ),
    ),
    "当前 TMDB 标题必须可追溯到可读的 TMDB 来源记录",
  );
  const unselectedOmdbTitle = titleEvidence.evidence.result.notSelected.find(
    (value) => value.sourceIdentity === "omdb",
  );
  assert(unselectedOmdbTitle, "公开当前值依据必须保留未选用的 OMDb 标题断言");
  assert(
    unselectedOmdbTitle.sourceRecordIds.every(
      (id) =>
        !selectedTitle.sourceRecordIds.includes(id) &&
        records.some(
          (record) =>
            record.id === id &&
            record.sourceIdentity === "omdb" &&
            record.status === "available",
        ),
    ),
    "未选用标题必须引用独立、可读的 OMDb 来源记录",
  );

  const ratingEvidence = values.find(
    (item) =>
      item.target.kind === "entity" &&
      item.target.entityId === asset.id &&
      item.evidence.property.startsWith("rating."),
  );
  assert(ratingEvidence, "OMDb 评分必须可从公开依据检查");
  assert.equal(ratingEvidence.evidence.result.status, "resolved");
  if (ratingEvidence.evidence.result.status !== "resolved")
    throw new Error("OMDb 评分没有确定的公开值");
  assert(
    ratingEvidence.evidence.result.values.some(
      (value) =>
        value.sourceIdentity === "omdb" && (value.qualifiers?.length ?? 0) > 0,
    ),
    "OMDb 当前评分必须保留原生来源限定",
  );
  const primaryCovers = asset.descriptions.flatMap((description) =>
    description.artifactRoles.filter(
      (role) => role.role === "asset.primary-cover",
    ),
  );
  assert.equal(primaryCovers.length, 1, "影片应有且仅有一个主封面角色");
  const coverLocation = asset.locations.find(
    (location) => location.artifactId === primaryCovers[0]?.artifactId,
  );
  assert.equal(coverLocation?.kind, "managed", "主封面应由服务托管");
}

function assetForAddress(
  assets: readonly PublicCurrentAsset[],
  sourceIdentity: string,
  nativeAddress: string,
): PublicCurrentAsset {
  const matches = assets.filter((asset) =>
    asset.sourceAssociations.some(
      (association) =>
        association.sourceIdentity === sourceIdentity &&
        association.nativeAddress === nativeAddress,
    ),
  );
  assert.equal(
    matches.length,
    1,
    `来源地址必须唯一关联当前影片：${nativeAddress}`,
  );
  return matches[0]!;
}

async function assertIndependentRefresh(
  client: ReturnType<typeof createPublicApiClient>,
  refresh: PublicExecutionInspection,
  expected: ReviewedFilm,
  priorRecordIds: ReadonlySet<string>,
  currentRecords: readonly SourceRecord[],
): Promise<void> {
  if (refresh.kind !== "execution")
    throw new Error("元数据刷新必须返回正式业务执行检查");
  assert.equal(refresh.status, "completed");
  assert.equal(refresh.outcome, "accepted");
  const expectedSources = sourceAddresses(expected);
  const runs = refresh.sourceRefreshRuns;
  assert.equal(runs.length, 2, "每个当前来源都必须独立建立一次刷新运行");
  assert.deepEqual(
    runs
      .map((run) => ({
        sourceIdentity: run.requestedSelection.sourceIdentity,
        nativeAddress: run.requestedSelection.nativeAddress,
      }))
      .toSorted((left, right) =>
        `${left.sourceIdentity}:${left.nativeAddress}`.localeCompare(
          `${right.sourceIdentity}:${right.nativeAddress}`,
        ),
      ),
    [...expectedSources].toSorted((left, right) =>
      `${left.sourceIdentity}:${left.nativeAddress}`.localeCompare(
        `${right.sourceIdentity}:${right.nativeAddress}`,
      ),
    ),
  );
  for (const run of runs) {
    assert.equal(run.phase, "terminal");
    assert.equal(run.outcome, "succeeded");
    const candidates = run.scopes
      .map((scope) => scope.candidateSourceRecordId)
      .filter((id): id is string => id !== undefined);
    assert(
      candidates.length > 0,
      `${run.requestedSelection.sourceIdentity} 没有新记录候选`,
    );
    for (const id of candidates) {
      assert.equal(priorRecordIds.has(id), false, "刷新不得复用旧来源记录");
      assert(
        currentRecords.some(
          (record) => record.id === id && record.status === "available",
        ),
        "公开来源记录列表必须读回刷新产生的新记录",
      );
    }
  }
  const history = await workflowHistory(client, refresh.id);
  assert.deepEqual(
    history.resultReferences.sourceRefreshRunIds.toSorted(),
    runs.map((run) => run.id).toSorted(),
    "正式执行历史必须引用全部独立来源刷新运行",
  );
  assert(
    refresh.progress.dispositions.every(
      (disposition) => !disposition.key.startsWith("source-refresh:"),
    ),
    "执行进度不得复制来源刷新运行权威",
  );
}

let ownedRun: OwnedEnvironmentRun | undefined;
let passed = false;
try {
  const missingMaterials = [];
  if (!(await materialRootExists(strictFilmRoot)))
    missingMaterials.push(strictLogicalRoot);
  if (!(await materialRootExists(bdmvRoot)))
    missingMaterials.push(bdmvLogicalRoot);
  if (missingMaterials.length > 0) {
    evidence["status"] = "condition-missing";
    evidence["missingMaterials"] = missingMaterials;
    throw new Error("条件缺失：缺少指定的影片资料根");
  }

  const prior = await inspectEnvironment({ workspacePath, environment });
  evidence["environmentBefore"] = {
    status: prior.status,
    state: prior.state,
    sourceMode: prior.environment.sourceMode,
    environmentId: prior.environment.environmentId,
    dataGeneration: prior.environment.dataGeneration,
    runState: prior.run.state,
    processLiveness: prior.run.processLiveness,
    serviceReadiness: prior.serviceReadiness,
  };
  if (prior.status !== "ok" || prior.state === "unmanaged") {
    evidence["status"] = "failed";
    evidence["environmentInspectionFailure"] = {
      status: prior.status,
      reason: prior.reason,
    };
    throw new Error("无法可靠检查指定环境的归属和生命周期状态");
  }
  if (
    prior.state !== "prepared" ||
    prior.environment.sourceMode !== "real" ||
    prior.environment.environmentId === null ||
    prior.environment.dataGeneration === null ||
    prior.pendingIntent !== undefined ||
    (prior.run.state !== "absent" && prior.run.state !== "stopped") ||
    (prior.run.processLiveness !== "absent" &&
      prior.run.processLiveness !== "exited") ||
    prior.serviceReadiness === "ready"
  ) {
    evidence["status"] = "condition-missing";
    evidence["conditionMissing"] =
      "需要一个已准备、来源模式为 real 且服务已停止的专用环境";
    throw new Error("条件缺失：环境不满足本次真实来源验收的独立运行条件");
  }
  const environmentId = prior.environment.environmentId;
  const dataGeneration = prior.environment.dataGeneration;

  const started = await startEnvironment({
    workspacePath,
    environment,
    signal: controller.signal,
  });
  evidence["start"] = operationEvidence(started);
  ownedRun = ownedRunFromStart({
    started,
    previousRunId: prior.run.runId,
    environmentId,
    dataGeneration,
  });
  if (started.status === "already-ready") {
    evidence["status"] = "condition-missing";
    evidence["conditionMissing"] =
      "环境在前置检查后被其他进程启动；脚本未接管该服务";
    throw new Error("条件缺失：环境在启动前置检查后已被其他进程启动");
  }
  if (started.status !== "ready") {
    throw new Error("专用环境启动未就绪");
  }
  assert(ownedRun, "必须确认启动创建了本次拥有的新服务世代");
  assert(started.run.address);
  evidence["startedRun"] = {
    status: started.status,
    runId: started.run.runId,
  };
  await waitForProductReady(started.run.address, controller.signal);
  let client = createCorpusClient(started.run.address, controller.signal);
  const connections = await Promise.all(
    (["tmdb", "omdb"] as const).map(async (sourceId) => ({
      sourceId,
      ...(await client.getSourceConnection(sourceId)),
    })),
  );
  evidence["sourceConnections"] = connections;
  const unavailable = connections
    .filter((connection) => connection.credentialStatus !== "configured")
    .map((connection) => connection.sourceId);
  if (unavailable.length > 0) {
    evidence["status"] = "condition-missing";
    evidence["missingConnections"] = unavailable;
    throw new Error(`条件缺失：以下来源连接未配置：${unavailable.join("、")}`);
  }
  const unhealthy = connections
    .filter((connection) => connection.availability !== "available")
    .map((connection) => connection.sourceId);
  if (unhealthy.length > 0) {
    evidence["status"] = "failed";
    evidence["unavailableConnections"] = unhealthy;
    throw new Error(
      `已配置来源当前不可用：${unhealthy.join("、")}；本次真实来源验收失败`,
    );
  }

  const before = await Promise.all([
    captureRawFilesystemSnapshot(strictFilmRoot),
    captureRawFilesystemSnapshot(bdmvRoot),
  ]);
  const existing = await listAllAssetLibraries(client);
  const alreadyCovered = existing.some((library) =>
    library.directories.some(
      (directory) =>
        directory.path === strictFilmRoot || directory.path === bdmvRoot,
    ),
  );
  if (alreadyCovered) {
    evidence["status"] = "condition-missing";
    evidence["conditionMissing"] =
      "专用环境已登记其中一个影片根；请准备不含这些根的专用验收环境";
    throw new Error("条件缺失：本次资料根已属于现有资产库，拒绝改写既有库配置");
  }

  const intake = await intakeDirectories(client, {
    displayName: "影视真实来源验收",
    directories: [strictFilmRoot, bdmvRoot],
    recognitionProfileIds: ["movies"],
    sourceIdentities: ["tmdb", "omdb"],
    workflowTimeoutMs: 300_000,
  });
  evidence["intake"] = {
    assetLibraryId: intake.assetLibraryId,
    executionOutcome: intake.executionOutcome,
    observedRootIds: intake.observedRootIds.length,
  };
  assert.equal(
    intake.assetIds.length,
    1,
    "普通扫描只应接受带明确本地身份的影片",
  );
  const scan = await client.inspectAssetLibraryScan(intake.executionId);
  assert.equal(scan.status, "completed");
  assert.equal(scan.assetLibraryId, intake.assetLibraryId);
  assert.equal(scan.directories.length, 2);
  assert(
    scan.directories.every((directory) => directory.mode === "execute"),
    "两个互不重叠的影片根必须各自执行普通扫描",
  );

  const strictDirectory = intake.directories.find(
    (directory) => path.resolve(directory.path) === strictFilmRoot,
  );
  assert(strictDirectory, "严格影片根必须有正式资产库目录授权");
  const strictSnapshot = await client.inspectLocalIntake({
    assetLibraryId: intake.assetLibraryId,
    directoryId: strictDirectory.id,
    parentExecutionId: intake.executionId,
  });
  assert.equal(strictSnapshot.directoryId, strictDirectory.id);
  assert.equal(strictSnapshot.execution?.status, "completed");
  assert(strictSnapshot.execution?.id, "严格影片检查必须返回正式子执行身份");
  assert(strictSnapshot.files.length > 0);
  assert(strictSnapshot.files.every((file) => file.problem === undefined));
  const strictExecution = await waitForPublicExecution(
    client,
    strictSnapshot.execution.id,
    300_000,
  );
  assert.equal(strictExecution.kind, "execution");
  assert.equal(strictExecution.id, strictSnapshot.execution.id);
  assert.equal(strictExecution.outcome, "accepted");
  assert(strictExecution.progress.workItems.length > 0);
  assert(
    strictExecution.progress.workItems.every(
      (item) => item.outcome === "accepted",
    ),
    "严格影片的每个扫描工作项都必须成功接受",
  );
  const strictPaths = strictSnapshot.files
    .map((file) => file.relativePath)
    .toSorted();
  assert.deepEqual(
    strictExecution.progress.workItems
      .flatMap((item) => item.relativePaths)
      .toSorted(),
    strictPaths,
    "严格影片子执行必须覆盖本授权目录的全部材料路径",
  );
  const strictScanDirectories = scan.directories.filter((directory) =>
    sameStrings(
      directory.files.flatMap((file) => file.relativePaths),
      strictPaths,
    ),
  );
  assert.equal(strictScanDirectories.length, 1);
  const strictScanDirectory = strictScanDirectories[0];
  assert(strictScanDirectory);
  assert.equal(strictScanDirectory.outcome, "accepted");
  assert.equal(strictScanDirectory.unresolvedCount, 0);
  assert.equal(strictScanDirectory.failedCount, 0);

  const bdmvDirectory = intake.directories.find(
    (directory) => path.resolve(directory.path) === bdmvRoot,
  );
  assert(bdmvDirectory, "BDMV根必须有正式资产库目录授权");
  const bdmvSnapshot = await client.inspectLocalIntake({
    assetLibraryId: intake.assetLibraryId,
    directoryId: bdmvDirectory.id,
    parentExecutionId: intake.executionId,
  });
  assert.equal(bdmvSnapshot.directoryId, bdmvDirectory.id);
  assert.equal(bdmvSnapshot.execution?.status, "completed");
  assert(bdmvSnapshot.execution?.id, "BDMV本地检查必须返回子执行身份");
  assert.equal(
    bdmvSnapshot.files.length,
    oracle.video.collectorFilm.packageFileCount,
    "BDMV普通目录应保留审核的包内文件数量",
  );
  const childExecution = await waitForPublicExecution(
    client,
    bdmvSnapshot.execution.id,
    300_000,
  );
  assert.equal(childExecution.kind, "execution");
  assert.equal(childExecution.id, bdmvSnapshot.execution.id);
  assert.equal(childExecution.outcome, "unresolved");
  assert(childExecution.progress.workItems.length > 0);
  assert(
    childExecution.progress.workItems.every(
      (item) => item.outcome === "unresolved",
    ),
    "BDMV定向识别前的普通扫描必须明确保留未识别结果",
  );
  const localPaths = bdmvSnapshot.files
    .map((file) => file.relativePath)
    .toSorted();
  const childPaths = childExecution.progress.workItems
    .flatMap((item) => item.relativePaths)
    .toSorted();
  assert.deepEqual(
    childPaths,
    localPaths,
    "BDMV扫描子执行必须覆盖本授权目录读回的全部材料路径",
  );
  const scanDirectories = scan.directories.filter((directory) =>
    sameStrings(
      directory.files.flatMap((file) => file.relativePaths),
      localPaths,
    ),
  );
  assert.equal(
    scanDirectories.length,
    1,
    "必须用完整材料路径集唯一定位BDMV扫描目录",
  );
  const [bdmvScanDirectory] = scanDirectories;
  assert(bdmvScanDirectory);
  assert.equal(bdmvScanDirectory.mode, "execute");
  assert.equal(bdmvScanDirectory.outcome, "unresolved");
  assert(bdmvScanDirectory.unresolvedCount > 0);
  assert.equal(bdmvScanDirectory.failedCount, 0);
  assert.equal(scan.outcome, "partially-succeeded");
  evidence["ordinaryScan"] = {
    outcome: scan.outcome,
    strictFilm: {
      outcome: strictScanDirectory.outcome,
      childOutcome: strictExecution.outcome,
      workItemCount: strictExecution.progress.workItems.length,
    },
    directedBdmv: {
      outcome: bdmvScanDirectory.outcome,
      childOutcome: childExecution.outcome,
      unresolvedCount: bdmvScanDirectory.unresolvedCount,
    },
  };

  const directed = await client.startDirectedRecognition({
    registrationId: bdmvScanDirectory.id,
    relativeScope: ".",
    sourceIdentity: "tmdb",
    sourceInput: { movie: oracle.video.collectorFilm.sourceAssociations.Tmdb },
  });
  const directedExecution = await waitForPublicExecution(
    client,
    directed.id,
    300_000,
  );
  assert.equal(directedExecution.outcome, "accepted");
  evidence["directedRecognition"] = {
    outcome: directedExecution.outcome,
    assetLibraryId: intake.assetLibraryId,
    inspectedChildOutcome: childExecution.outcome,
    inspectedChildWorkItemCount: childExecution.progress.workItems.length,
    observedRootId: bdmvScanDirectory.id,
  };

  let assets = await listAllAssets(client, intake.assetLibraryId);
  const strictAddress = `https://www.themoviedb.org/movie/${oracle.video.film.sourceAssociations.Tmdb}`;
  const bdmvAddress = `https://www.themoviedb.org/movie/${oracle.video.collectorFilm.sourceAssociations.Tmdb}`;
  const strict = assetForAddress(assets, "tmdb", strictAddress);
  const bdmv = assetForAddress(assets, "tmdb", bdmvAddress);
  assert.notEqual(strict.id, bdmv.id, "两个目录中的影片应维持独立资产身份");
  await assertFilmProjection(client, strict, oracle.video.film);
  await assertFilmProjection(client, bdmv, oracle.video.collectorFilm);
  const bdmvDelivered = bdmv.descriptions.flatMap((description) =>
    description.artifactRoles.filter(
      (role) => role.role === "asset.material-delivered",
    ),
  );
  assert.equal(bdmvDelivered.length, 1, "BDMV影片应保留一个已交付资料角色");
  const bdmvPrimaryCovers = bdmv.descriptions.flatMap((description) =>
    description.artifactRoles.filter(
      (role) => role.role === "asset.primary-cover",
    ),
  );
  assert.equal(bdmvPrimaryCovers.length, 1, "BDMV影片应有一个主封面角色");
  const bdmvObserved = bdmv.locations.filter(
    (location) => location.kind === "observed",
  );
  assert.equal(bdmvObserved.length, 1, "BDMV目录应作为一个观察材料保留");
  assert.equal(
    bdmvObserved[0]?.artifactId,
    bdmvDelivered[0]?.artifactId,
    "BDMV整包观察位置应属于同一已交付材料",
  );
  assert.deepEqual(
    bdmv.locations.map((location) => location.artifactId).toSorted(),
    [bdmvPrimaryCovers[0]!.artifactId, bdmvDelivered[0]!.artifactId].toSorted(),
    "BDMV当前材料只能有托管主封面与整包观察产物",
  );

  const initialRecords = new Map<string, readonly SourceRecord[]>();
  for (const asset of [strict, bdmv]) {
    const records = await sourceRecords(client, asset.id);
    for (const source of sourceAddresses(
      asset === strict ? oracle.video.film : oracle.video.collectorFilm,
    ))
      assert(
        records.some(
          (record) =>
            record.status === "available" &&
            record.sourceIdentity === source.sourceIdentity &&
            record.nativeAddress === source.nativeAddress,
        ),
        `首轮真实采集缺少可检查的 ${source.sourceIdentity} 来源记录`,
      );
    initialRecords.set(asset.id, records);
  }

  const initialAssets = await listAllAssets(client, intake.assetLibraryId);
  assert(ownedRun, "首轮采集必须仍由本次启动的服务世代提供");
  const firstRun = ownedRun;
  const stopped = await stopOwnedRun({
    owned: firstRun,
    evidenceKey: "restartStopOperation",
  });
  evidence["restartStop"] = {
    state: stopped.state,
    processLiveness: stopped.run.processLiveness,
    runId: stopped.run.runId,
  };
  ownedRun = undefined;
  const restarted = await startEnvironment({
    workspacePath,
    environment,
    signal: controller.signal,
  });
  evidence["restart"] = operationEvidence(restarted);
  ownedRun = ownedRunFromStart({
    started: restarted,
    previousRunId: firstRun.runId,
    environmentId,
    dataGeneration,
  });
  if (restarted.status === "already-ready") {
    evidence["status"] = "condition-missing";
    evidence["conditionMissing"] = "重开前环境被其他进程启动；脚本未接管该服务";
    throw new Error("条件缺失：重开前环境已被其他进程启动");
  }
  if (restarted.status !== "ready") {
    throw new Error("持久化检查的服务重启未就绪");
  }
  assert(restarted.run.address);
  assert.notEqual(
    restarted.run.runId,
    firstRun.runId,
    "服务重启必须创建新世代",
  );
  assert.equal(restarted.environment.environmentId, environmentId);
  assert.equal(restarted.environment.dataGeneration, dataGeneration);
  assert(ownedRun, "必须确认重开创建了本次拥有的新服务世代");
  evidence["restartedRun"] = {
    status: restarted.status,
    runId: restarted.run.runId,
  };
  await waitForProductReady(restarted.run.address, controller.signal);
  client = createCorpusClient(restarted.run.address, controller.signal);
  const repeatScanStart = await client.startAssetLibraryScan(
    intake.assetLibraryId,
  );
  const repeatScan = await waitForAssetLibraryScan(
    client,
    repeatScanStart.parentExecutionId,
    300_000,
  );
  assert.equal(repeatScan.outcome, "no-change");
  assert(
    repeatScan.directories.every(
      (directory) =>
        directory.mode === "execute" && directory.outcome === "no-change",
    ),
    "重启后的两个独立目录必须逐目录无变化，不能误作父目录覆盖",
  );
  const persistedAssets = await listAllAssets(client, intake.assetLibraryId);
  assert.deepEqual(
    persistedAssets.toSorted((left, right) => left.id.localeCompare(right.id)),
    initialAssets.toSorted((left, right) => left.id.localeCompare(right.id)),
    "SQLite 重启后当前资产投影必须保持不变",
  );
  const persistedLibrary = (await listAllAssetLibraries(client)).find(
    (candidate) => candidate.id === intake.assetLibraryId,
  );
  assert(persistedLibrary);
  for (const [root, asset] of [
    [strictFilmRoot, strict],
    [bdmvRoot, bdmv],
  ] as const)
    await assertNoChangeMaterialReadback({
      client,
      library: persistedLibrary,
      scan: repeatScan,
      directoryPath: root,
      asset,
    });
  for (const asset of [strict, bdmv]) {
    const beforeRecords = initialRecords.get(asset.id) ?? [];
    const afterRecords = await sourceRecords(client, asset.id);
    assert.deepEqual(
      afterRecords.map((record) => record.id).toSorted(),
      beforeRecords.map((record) => record.id).toSorted(),
      "无变化重扫不得新增来源记录，重启后既有记录必须保留",
    );
  }

  const refreshEvidence: Record<string, unknown>[] = [];
  for (const [asset, expected] of [
    [strict, oracle.video.film],
    [bdmv, oracle.video.collectorFilm],
  ] as const) {
    const priorRecords = initialRecords.get(asset.id) ?? [];
    const refreshStart = await client.startMetadataRefresh({
      subjectId: asset.id,
    });
    const refresh = await waitForPublicExecution(
      client,
      refreshStart.id,
      300_000,
    );
    if (refresh.kind !== "execution")
      throw new Error("元数据刷新必须返回正式业务执行检查");
    const currentRecords = await sourceRecords(client, asset.id);
    await assertIndependentRefresh(
      client,
      refresh,
      expected,
      new Set(priorRecords.map((record) => record.id)),
      currentRecords,
    );
    assets = await listAllAssets(client, intake.assetLibraryId);
    const updated = assets.find((candidate) => candidate.id === asset.id);
    assert(updated, "真实刷新后必须经当前资产列表读回原资产");
    await assertFilmProjection(client, updated, expected);
    refreshEvidence.push({
      sourceAssociations: expectedSourcesForEvidence(expected),
      runCount: refresh.sourceRefreshRuns.length,
      newSourceRecordCount: currentRecords.filter(
        (record) =>
          !priorRecords.some((priorRecord) => priorRecord.id === record.id),
      ).length,
    });
    await save();
  }
  evidence["refreshes"] = refreshEvidence;

  const after = await Promise.all([
    captureRawFilesystemSnapshot(strictFilmRoot),
    captureRawFilesystemSnapshot(bdmvRoot),
  ]);
  assert.deepEqual(after, before, "真实来源验收期间原始资料必须保持只读");
  controller.signal.throwIfAborted();
  evidence["materialsUnchanged"] = true;
  evidence["status"] = "passed";
  passed = true;
} catch (error) {
  if (evidence["status"] === "running")
    evidence["status"] = controller.signal.aborted ? "cancelled" : "failed";
  if (evidence["status"] === "condition-missing") {
    evidence["conditionMissing"] ??= safeThrownFailure(error).message.replace(
      /^条件缺失[：:]\s*/u,
      "",
    );
    process.stderr.write(`条件缺失：${String(evidence["conditionMissing"])}\n`);
    process.exitCode = 2;
  } else {
    const failure = safeThrownFailure(error);
    evidence["failure"] = failure;
    process.stderr.write(`真实影视来源验收失败：${failure.message}\n`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  }
} finally {
  if (ownedRun !== undefined) {
    try {
      const stopped = await stopOwnedRun({
        owned: ownedRun,
        evidenceKey: "finalStopOperation",
      });
      evidence["stop"] = {
        status: "stopped",
        state: stopped.state,
        processLiveness: stopped.run.processLiveness,
        runId: stopped.run.runId,
      };
      ownedRun = undefined;
    } catch (error) {
      evidence["status"] = "failed";
      evidence["cleanupFailure"] =
        error instanceof Error
          ? safeOperationMessage(error.message)
          : "未知错误";
      passed = false;
      process.exitCode = 1;
      process.stderr.write("真实影视来源验收结束后未能确认服务停止。\n");
    }
  }
  evidence["finishedAt"] = new Date().toISOString();
  evidence["passed"] = passed && evidence["status"] === "passed";
  await save();
}

function expectedSourcesForEvidence(expected: ReviewedFilm) {
  return sourceAddresses(expected).map(({ sourceIdentity, nativeAddress }) => ({
    sourceIdentity,
    nativeAddress,
  }));
}
