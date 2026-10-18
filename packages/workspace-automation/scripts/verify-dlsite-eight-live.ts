import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectEnvironment,
  startEnvironment,
  stopEnvironment,
  type StartOperationResult,
  type StopOperationResult,
} from "@digital/environment";
import {
  type PublicApiClient,
  type PublicAssetLibrary,
  type PublicAssetLibraryScan,
  type PublicCurrentAsset,
  type PublicExecutionInspection,
  type AssetEvidenceItem,
} from "@digital/public-api";

import {
  createCorpusClient,
  listAllAssetLibraries,
  listAllAssets,
  waitForAssetLibraryScan,
  waitForProductReady,
  waitForPublicExecution,
} from "./corpus-verification.ts";
import { requireInput } from "./inputs.ts";
import { digestDirectory } from "./material-digest.ts";

type CreditField = "voice" | "scenario" | "illustration" | "author";

type ReviewedAudioWork = {
  readonly logicalRoot: string;
  readonly directory: string;
  readonly sourceNativeAddress: string;
  readonly title: string;
  readonly language: string;
  readonly priceJpy: string;
  readonly releaseDate: string;
  readonly circle: string;
  readonly circleSourceKey: string;
  readonly credits: Readonly<Record<CreditField, readonly string[]>>;
  readonly reviewedSeries?: {
    readonly identityNamespace: string;
    readonly sourceKey: string;
    readonly label: string;
    readonly relationshipType: string;
    readonly relationshipRole: string;
    readonly officialCoverage: string;
    readonly officialIdField: string;
    readonly officialNameField: string;
  };
};

type ReviewedOracle = {
  readonly reviews: {
    readonly dlsite: {
      readonly status: string;
      readonly reviewedAt: string;
      readonly reviewMethod: string;
    };
  };
  readonly audioWorks: readonly ReviewedAudioWork[];
};

type MaterialRoot = {
  readonly work: ReviewedAudioWork;
  readonly path: string;
  readonly realPath: string;
  readonly digestBefore: string;
};

type Failure = {
  readonly name: string;
  readonly message: string;
  readonly cause?: Failure;
};

export type DlsiteLiveInput = {
  readonly workspacePath: string;
  readonly environment: string;
  readonly evidencePath: string;
  readonly voiceWorkRoot: string;
  readonly signal?: AbortSignal;
};

export type DlsiteLiveResult = {
  readonly outcome: "passed" | "condition-missing" | "failed" | "cancelled";
  readonly evidencePath?: string;
  readonly conditionMissing?: readonly string[];
  readonly failure?: Failure;
  readonly cleanupErrors?: readonly Failure[];
};

class ConditionMissingError extends Error {
  readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super(items.join("；"));
    this.name = "ConditionMissingError";
    this.items = items;
  }
}

class MaterialPathMissingError extends Error {
  constructor() {
    super("指定的 DLsite 真实素材根不存在或不可读");
    this.name = "MaterialPathMissingError";
  }
}

const workspacePath = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
const environmentArgument = process.argv[2];
const evidenceArgument = process.argv[3];
const voiceWorkArgument = process.argv[4];
const workflowTimeoutMs = 15 * 60_000;
const expectedSourceIdentities = ["dlsite"];
const expectedProfiles = ["dlsite-voice"];

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function safeFailure(error: unknown): Failure {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const safeMessage = message
    .replace(
      /(authorization|cookie|token|secret|password|api[_-]?key|client[_-]?secret)=([^&\s]+)/giu,
      "$1=[已省略]",
    )
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [已省略]");
  return {
    name,
    message: safeMessage,
    ...(cause === undefined ? {} : { cause: safeFailure(cause) }),
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
      address: operation.run.address,
      port: operation.run.port,
    },
    failure:
      operation.failure === undefined
        ? undefined
        : {
            stage: operation.failure.stage,
            message: safeFailure(operation.failure.message).message,
            exitCode: operation.failure.exitCode,
          },
    cleanup: {
      state: operation.cleanup.state,
      errors: operation.cleanup.errors.map(
        (message) => safeFailure(message).message,
      ),
    },
    diagnostics: operation.diagnostics.map(
      (message) => safeFailure(message).message,
    ),
  };
}

function ownedRunFromStart(input: {
  readonly result: StartOperationResult;
  readonly previousRunId: string | null;
  readonly environmentId: string;
  readonly dataGeneration: string;
}):
  | {
      readonly runId: string;
      readonly environmentId: string;
      readonly dataGeneration: string;
    }
  | undefined {
  const result = input.result;
  const mayOwnRun =
    result.status === "ready" ||
    (result.status === "failed" && result.cleanup.state === "unknown");
  if (
    !mayOwnRun ||
    result.run.runId === null ||
    result.run.runId === input.previousRunId ||
    result.environment.environmentId !== input.environmentId ||
    result.environment.dataGeneration !== input.dataGeneration
  )
    return undefined;
  return {
    runId: result.run.runId,
    environmentId: input.environmentId,
    dataGeneration: input.dataGeneration,
  };
}

async function readOracle(): Promise<ReviewedOracle> {
  const oraclePath = fileURLToPath(
    import.meta.resolve("@digital/preview-corpus/live/reviewed-oracle.json"),
  );
  return JSON.parse(await readFile(oraclePath, "utf8")) as ReviewedOracle;
}

async function resolveRoots(
  voiceWorkRoot: string,
  works: readonly ReviewedAudioWork[],
): Promise<MaterialRoot[]> {
  let rootContainer: string;
  try {
    rootContainer = await realpath(voiceWorkRoot);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      throw new MaterialPathMissingError();
    throw error;
  }
  if (!(await stat(rootContainer)).isDirectory())
    throw new MaterialPathMissingError();
  const roots: MaterialRoot[] = [];
  for (const work of works) {
    const candidate = path.resolve(voiceWorkRoot, work.directory);
    let root: string;
    try {
      root = await realpath(candidate);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        throw new MaterialPathMissingError();
      throw error;
    }
    let details;
    try {
      details = await stat(root);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        throw new MaterialPathMissingError();
      throw error;
    }
    if (!details.isDirectory()) throw new MaterialPathMissingError();
    if (!isWithin(rootContainer, root))
      throw new ConditionMissingError([
        "验收素材不能通过符号链接跳出指定素材根",
      ]);
    roots.push({
      work,
      path: candidate,
      realPath: root,
      digestBefore: await digestDirectory(root),
    });
  }
  for (let left = 0; left < roots.length; left += 1)
    for (let right = left + 1; right < roots.length; right += 1)
      if (
        isWithin(roots[left]!.realPath, roots[right]!.realPath) ||
        isWithin(roots[right]!.realPath, roots[left]!.realPath)
      )
        throw new ConditionMissingError(["八组验收素材根必须互不重叠"]);
  return roots;
}

async function resolveEvidencePath(
  workspace: string,
  evidenceArgumentValue: string,
  roots: readonly MaterialRoot[],
): Promise<string> {
  if (path.isAbsolute(evidenceArgumentValue))
    throw new ConditionMissingError(["证据文件必须位于工作区内"]);
  const target = path.resolve(workspace, evidenceArgumentValue);
  if (!isWithin(workspace, target))
    throw new ConditionMissingError(["证据文件必须位于工作区内"]);
  for (const root of roots)
    if (isWithin(root.realPath, target))
      throw new ConditionMissingError(["证据文件不能写入素材根目录"]);
  await mkdir(path.dirname(target), { recursive: true });
  const parent = await realpath(path.dirname(target));
  if (!isWithin(workspace, parent))
    throw new ConditionMissingError(["证据目录不能越出工作区"]);
  try {
    if ((await lstat(target)).isSymbolicLink())
      throw new ConditionMissingError(["证据文件不能是符号链接"]);
  } catch (error) {
    if (error instanceof ConditionMissingError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return target;
}

function directoryForRoot(
  library: PublicAssetLibrary,
  root: MaterialRoot,
): PublicAssetLibrary["directories"][number] {
  const matches = library.directories.filter(
    (directory) =>
      directory.status === "active" &&
      path.resolve(directory.path) === root.realPath,
  );
  assert.equal(
    matches.length,
    1,
    `${root.work.sourceNativeAddress} 目录授权应唯一`,
  );
  assert.equal(matches[0]!.reachable, true);
  return matches[0]!;
}

async function findOrCreateLibrary(input: {
  readonly client: PublicApiClient;
  readonly roots: readonly MaterialRoot[];
}): Promise<{
  readonly library: PublicAssetLibrary;
  readonly created: boolean;
}> {
  const libraries = await listAllAssetLibraries(input.client);
  const overlaps = libraries.filter((library) =>
    library.directories.some((directory) =>
      input.roots.some(
        (root) => path.resolve(directory.path) === root.realPath,
      ),
    ),
  );
  if (overlaps.length > 1)
    throw new ConditionMissingError([
      "DLsite 八作素材已分散到多个资产库，验收不会改动既有配置",
    ]);
  if (overlaps.length === 1) {
    const library = overlaps[0]!;
    const configuredPaths = library.directories
      .filter(({ status }) => status === "active")
      .map(({ path: directoryPath }) => path.resolve(directoryPath))
      .toSorted();
    const expectedPaths = input.roots
      .map(({ realPath }) => realPath)
      .toSorted();
    if (
      JSON.stringify(configuredPaths) !== JSON.stringify(expectedPaths) ||
      JSON.stringify(library.recognitionProfileIds.toSorted()) !==
        JSON.stringify(expectedProfiles) ||
      JSON.stringify(library.sourceIdentities.toSorted()) !==
        JSON.stringify(expectedSourceIdentities)
    )
      throw new ConditionMissingError([
        "DLsite 八作素材已登记到非专用资产库，验收不会改写既有配置",
      ]);
    for (const root of input.roots) directoryForRoot(library, root);
    return { library, created: false };
  }
  const options = await input.client.listAssetLibraryOptions();
  assert(options.recognitionProfiles.some(({ id }) => id === "dlsite-voice"));
  assert(options.sources.some(({ id }) => id === "dlsite"));
  const library = await input.client.saveAssetLibrary({
    displayName: "DLsite 八作真实来源验收",
    directories: input.roots.map(({ realPath }) => realPath),
    recognitionProfileIds: [...expectedProfiles],
    sourceIdentities: [...expectedSourceIdentities],
  });
  return { library, created: true };
}

async function listEvidence(
  client: PublicApiClient,
  assetId: string,
  kind: "source-records" | "interpreted-facts",
): Promise<AssetEvidenceItem[]> {
  const items: AssetEvidenceItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAssetEvidence(assetId, {
      kind,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

async function inspectRoot(input: {
  readonly client: PublicApiClient;
  readonly library: PublicAssetLibrary;
  readonly scan: PublicAssetLibraryScan;
  readonly root: MaterialRoot;
  readonly allAssets: readonly PublicCurrentAsset[];
}): Promise<{
  readonly asset: PublicCurrentAsset;
  readonly execution: PublicExecutionInspection;
  readonly materialFiles: readonly {
    readonly relativePath: string;
    readonly size: number;
  }[];
}> {
  const directory = directoryForRoot(input.library, input.root);
  const intake = await input.client.inspectLocalIntake({
    assetLibraryId: input.library.id,
    directoryId: directory.id,
    parentExecutionId: input.scan.parentExecutionId,
  });
  assert.equal(intake.assetLibraryId, input.library.id);
  assert.equal(intake.directoryId, directory.id);
  assert.equal(intake.execution?.status, "completed");
  assert(intake.execution?.id);
  assert(intake.files.length > 0);
  assert(intake.files.every(({ problem }) => problem === undefined));
  const execution = await waitForPublicExecution(
    input.client,
    intake.execution.id,
    workflowTimeoutMs,
  );
  assert.equal(execution.kind, "execution");
  if (execution.kind !== "execution")
    throw new Error("本地材料检查必须返回正式子执行");
  assert(execution.outcome === "accepted" || execution.outcome === "no-change");
  assert(execution.progress.workItems.length > 0);
  const intakeByPath = new Map(
    intake.files.map((file) => [file.relativePath, file] as const),
  );
  const workPaths: string[] = [];
  const rootAssetIds = new Set<string>();
  for (const item of execution.progress.workItems) {
    assert(item.outcome === "accepted" || item.outcome === "no-change");
    assert(item.relativePaths.length > 0);
    const itemAssetIds = new Set<string>();
    for (const relativePath of item.relativePaths) {
      const file = intakeByPath.get(relativePath);
      assert(file, `扫描结果引用了未授权材料：${relativePath}`);
      workPaths.push(relativePath);
      file.assetIds.forEach((assetId) => itemAssetIds.add(assetId));
    }
    const executionAssetId = item.acceptedAssetId ?? item.retainedAssetId;
    assert(executionAssetId, "扫描结果必须保留材料资产身份");
    assert.deepEqual([...itemAssetIds], [executionAssetId]);
    rootAssetIds.add(executionAssetId);
  }
  assert.deepEqual(
    workPaths.toSorted(),
    [...intakeByPath.keys()].toSorted(),
    "扫描工作项必须覆盖当前授权根的所有文件",
  );
  assert.equal(rootAssetIds.size, 1, "每个官方作品根应形成一个资产");
  const [assetId] = rootAssetIds;
  assert(assetId);
  const asset = input.allAssets.find((candidate) => candidate.id === assetId);
  assert(asset, `公开资产列表缺少 ${input.root.work.sourceNativeAddress}`);
  assert.equal(intake.contents.length, 1);
  assert.equal(intake.contents[0]?.id, assetId);
  const intakeAssets = new Set(
    intake.files.flatMap(({ assetIds }) => assetIds),
  );
  assert.deepEqual([...intakeAssets], [assetId]);
  for (const file of intake.files) {
    const expectedAddress = path.resolve(
      input.root.realPath,
      file.relativePath,
    );
    const locations: PublicCurrentAsset["locations"] = asset.locations.filter(
      (location) => path.resolve(location.address) === expectedAddress,
    );
    assert.equal(
      locations.length,
      1,
      `本地材料 ${file.relativePath} 必须唯一对应当前公开位置`,
    );
    const [location] = locations;
    assert(location);
    assert.equal(location.kind, "observed");
    assert.equal(location.byteLength, file.size);
    assert.equal(location.content.status, "confirmed");
    if (location.content.status !== "confirmed")
      throw new Error(`本地材料 ${file.relativePath} 尚未确认修订版`);
    assert.equal(location.content.target.kind, "artifact-revision");
    assert.equal(location.content.target.artifactId, location.artifactId);
  }
  const expectedPaths = [...intakeByPath.keys()].toSorted();
  const matchingScanDirectories = input.scan.directories.filter((entry) => {
    const observedPaths = entry.files
      .flatMap((file) => file.relativePaths)
      .toSorted();
    return (
      JSON.stringify(observedPaths) === JSON.stringify(expectedPaths) &&
      entry.files.every(
        (file) => file.assetId === undefined || file.assetId === assetId,
      )
    );
  });
  assert.equal(
    matchingScanDirectories.length,
    1,
    "正式扫描目录必须由精确材料路径和当前资产唯一对应",
  );
  assert(
    matchingScanDirectories[0]!.files.every(
      (file) => file.outcome === "accepted" || file.outcome === "no-change",
    ),
    "正式扫描结果必须读回当前材料唯一资产",
  );
  return {
    asset,
    execution,
    materialFiles: intake.files.map(({ relativePath, size }) => ({
      relativePath,
      size,
    })),
  };
}

function metadataFacts(asset: PublicCurrentAsset) {
  const facts = asset.descriptions.flatMap((description) =>
    description.metadata.flatMap((metadata) =>
      metadata.result.status === "resolved"
        ? metadata.result.values.map((value) => ({
            property: metadata.property,
            value: value.value,
            sourceIdentity: value.sourceIdentity,
            sourceRecordIds: value.sourceRecordIds,
          }))
        : [],
    ),
  );
  return [
    ...new Map(facts.map((fact) => [JSON.stringify(fact), fact])).values(),
  ];
}

function exactOne<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  label: string,
): T {
  const matches = values.filter(predicate);
  assert.equal(matches.length, 1, `${label} 必须恰好有一项`);
  return matches[0]!;
}

async function verifyWork(input: {
  readonly client: PublicApiClient;
  readonly root: MaterialRoot;
  readonly scannedAsset: PublicCurrentAsset;
  readonly materialFiles: readonly {
    readonly relativePath: string;
    readonly size: number;
  }[];
  readonly signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { root, scannedAsset, materialFiles, client, signal } = input;
  const work = root.work;
  assert.deepEqual(
    scannedAsset.sourceAssociations.map(
      ({ sourceIdentity, nativeAddress }) => ({
        sourceIdentity,
        nativeAddress,
      }),
    ),
    [
      {
        sourceIdentity: "dlsite",
        nativeAddress: `https://www.dlsite.com/${work.sourceNativeAddress.startsWith("VJ") ? "soft" : "maniax"}/work/=/product_id/${work.sourceNativeAddress}.html`,
      },
    ],
  );
  assert.deepEqual(scannedAsset.recognitionSourceAssociation, {
    sourceIdentity: "dlsite",
    nativeAddress: `https://www.dlsite.com/${work.sourceNativeAddress.startsWith("VJ") ? "soft" : "maniax"}/work/=/product_id/${work.sourceNativeAddress}.html`,
  });
  const recordItems = await listEvidence(
    client,
    scannedAsset.id,
    "source-records",
  );
  const sourceRecords = recordItems.filter(
    (
      item,
    ): item is Extract<AssetEvidenceItem, { readonly kind: "source-record" }> =>
      item.kind === "source-record",
  );
  assert.equal(sourceRecords.length, 2);
  assert(
    sourceRecords.every(
      (record) =>
        record.status === "available" && record.sourceIdentity === "dlsite",
    ),
  );
  assert.deepEqual(
    sourceRecords
      .map((record) => record.coverage?.id ?? "")
      .toSorted((left, right) => left.localeCompare(right)),
    ["dlsite.product-html", "dlsite.product-json"],
  );
  assert(
    sourceRecords.every(
      (record) =>
        record.coverage?.authority === "official" &&
        record.coverage.completeness === "complete",
    ),
  );
  const jsonRecord = exactOne(
    sourceRecords,
    (record) => record.coverage?.id === "dlsite.product-json",
    `${work.sourceNativeAddress} JSON 来源记录`,
  );
  const htmlRecord = exactOne(
    sourceRecords,
    (record) => record.coverage?.id === "dlsite.product-html",
    `${work.sourceNativeAddress} HTML 来源记录`,
  );
  const recordIds = new Set([jsonRecord.id, htmlRecord.id]);
  const facts = metadataFacts(scannedAsset);
  for (const expected of [
    { property: "asset.title", value: work.title },
    { property: "asset.declared-language", value: work.language },
    { property: "dlsite.product.price-jpy", value: work.priceJpy },
  ]) {
    const fact = exactOne(
      facts,
      (candidate) =>
        candidate.property === expected.property &&
        candidate.value === expected.value &&
        candidate.sourceIdentity === "dlsite",
      `${work.sourceNativeAddress} ${expected.property}`,
    );
    assert.equal(fact.sourceRecordIds.length, 1);
    assert.equal(fact.sourceRecordIds[0], jsonRecord.id);
  }
  const releaseDate = exactOne(
    facts,
    (candidate) =>
      candidate.property === "asset.release-date" &&
      candidate.value.startsWith(work.releaseDate) &&
      candidate.sourceIdentity === "dlsite",
    `${work.sourceNativeAddress} release date`,
  );
  assert.deepEqual(releaseDate.sourceRecordIds, [jsonRecord.id]);

  const circle = exactOne(
    scannedAsset.relatedEntities,
    (entity) =>
      entity.identityNamespace === "dlsite.circle" &&
      entity.sourceKey === work.circleSourceKey &&
      entity.label === work.circle,
    `${work.sourceNativeAddress} 社团`,
  );
  const expectedDlsiteEntityIds = new Set([circle.id]);
  const htmlFacts: Extract<
    AssetEvidenceItem,
    { readonly kind: "interpreted-fact" }
  >[] = (
    await listEvidence(client, scannedAsset.id, "interpreted-facts")
  ).filter(
    (
      item,
    ): item is Extract<
      AssetEvidenceItem,
      { readonly kind: "interpreted-fact" }
    > => item.kind === "interpreted-fact",
  );
  const circleEvidence = htmlFacts.filter(
    (item) =>
      item.target.kind === "entity" &&
      item.target.entityId === circle.id &&
      item.sourceIdentity === "dlsite",
  );
  assert(circleEvidence.length > 0);
  assert(
    circleEvidence.every(
      (item) =>
        JSON.stringify(item.sourceRecordIds) ===
        JSON.stringify([htmlRecord.id]),
    ),
  );

  for (const [field, credits] of Object.entries(work.credits) as [
    CreditField,
    readonly string[],
  ][]) {
    const namespace = `dlsite.credit.${field}.${field}.occurrence-local`;
    const entities: PublicCurrentAsset["relatedEntities"] =
      scannedAsset.relatedEntities.filter(
        (entity) => entity.identityNamespace === namespace,
      );
    assert.deepEqual(
      entities.map(({ label }) => label).toSorted(),
      [...credits].toSorted(),
      `${work.sourceNativeAddress} ${field} credit projection drifted`,
    );
    const recognitionAddress: string | undefined =
      scannedAsset.recognitionSourceAssociation?.nativeAddress;
    assert(recognitionAddress);
    const occurrencePrefix: string = `occurrence:${recognitionAddress}\u0000${field}\u0000${field}\u0000`;
    const occurrenceIndexes = entities.map((persona) => {
      assert(persona.sourceKey?.startsWith(occurrencePrefix));
      const occurrenceIndex = persona.sourceKey?.slice(occurrencePrefix.length);
      assert(occurrenceIndex && /^[1-9]\d*$/u.test(occurrenceIndex));
      return occurrenceIndex;
    });
    assert.equal(new Set(occurrenceIndexes).size, entities.length);
    for (const persona of entities) {
      const credit = persona.label;
      expectedDlsiteEntityIds.add(persona.id);
      const sourceFacts: Extract<
        AssetEvidenceItem,
        { readonly kind: "interpreted-fact" }
      >[] = htmlFacts.filter(
        (item) =>
          item.target.kind === "entity" &&
          item.target.entityId === persona.id &&
          item.sourceIdentity === "dlsite",
      );
      assert(sourceFacts.length > 0);
      assert(
        sourceFacts.every(
          (item) =>
            item.sourceRecordIds.length === 1 &&
            recordIds.has(item.sourceRecordIds[0]!),
        ),
      );
      const creditRecordIds: Set<string> = new Set(
        sourceFacts.flatMap(({ sourceRecordIds }) => sourceRecordIds),
      );
      assert.equal(creditRecordIds.size, 1);
      const creditRecordId = [...creditRecordIds][0];
      assert(creditRecordId);
      assert(
        scannedAsset.relationships.some(
          (relationship) =>
            relationship.sourceRecordIds.includes(creditRecordId) &&
            relationship.participants.some(
              (participant) =>
                participant.entityId === persona.id &&
                participant.role === field,
            ),
        ),
        `${work.sourceNativeAddress} ${field} credit must be related to its asset`,
      );
      const creditRelationships = scannedAsset.relationships.filter(
        (relationship) =>
          relationship.sourceRecordIds.includes(creditRecordId) &&
          relationship.participants.some(
            (participant) =>
              participant.entityId === persona.id && participant.role === field,
          ),
      );
      const mentionIds = [
        ...new Set(
          creditRelationships.flatMap((relationship) =>
            relationship.participants.flatMap((participant) =>
              participant.entityId === persona.id && participant.role === field
                ? (participant.mentionIds ?? [])
                : [],
            ),
          ),
        ),
      ];
      assert(mentionIds.length > 0);
      const mentionResolutions = await Promise.all(
        mentionIds.map((mentionId) => {
          signal.throwIfAborted();
          return client.inspectEntityMentionResolution(mentionId);
        }),
      );
      for (const mention of mentionResolutions) {
        assert.equal(mention.label, credit);
        assert.equal(mention.entityId, persona.id);
        assert.equal(mention.basis, "source");
        assert.ok(mention.decisionId);
        assert.deepEqual(mention.sourceRecordIds, [creditRecordId]);
      }
    }
  }

  assert(
    !scannedAsset.relatedEntities.some(
      ({ label }) => label.toUpperCase() === "N/A",
    ),
    "无效占位文本不得成为公开实体",
  );
  assert(
    scannedAsset.relationships.every((relationship) =>
      relationship.sourceRecordIds.every((id) => recordIds.has(id)),
    ),
    "公开关系必须引用本次保留的官方来源记录",
  );
  assert(
    htmlFacts.every(
      (item) =>
        item.sourceIdentity !== "dlsite" ||
        item.sourceRecordIds.every((id) => recordIds.has(id)),
    ),
    "公开来源事实不能引用不存在的官方来源记录",
  );
  const sourceSeries = work.reviewedSeries;
  if (sourceSeries !== undefined) {
    const series = exactOne(
      scannedAsset.relatedEntities,
      (entity) =>
        entity.identityNamespace === sourceSeries.identityNamespace &&
        entity.sourceKey === sourceSeries.sourceKey &&
        entity.label === sourceSeries.label,
      `${work.sourceNativeAddress} 系列实体`,
    );
    const officialRecord = exactOne(
      sourceRecords,
      (record) => record.coverage?.id === sourceSeries.officialCoverage,
      `${work.sourceNativeAddress} 系列官方依据`,
    );
    expectedDlsiteEntityIds.add(series.id);
    const seriesFacts = htmlFacts.filter(
      (item) =>
        item.target.kind === "entity" &&
        item.target.entityId === series.id &&
        item.sourceIdentity === "dlsite",
    );
    assert(seriesFacts.length > 0);
    assert(
      seriesFacts.every((item) =>
        item.sourceRecordIds.includes(officialRecord.id),
      ),
    );
    assert(
      scannedAsset.relationships.some(
        (relationship) =>
          relationship.type === sourceSeries.relationshipType &&
          relationship.sourceRecordIds.length === 1 &&
          relationship.sourceRecordIds[0] === officialRecord.id &&
          relationship.participants.some(
            (participant) =>
              participant.entityId === series.id &&
              participant.role === sourceSeries.relationshipRole,
          ),
      ),
      `${work.sourceNativeAddress} 系列关系必须引用对应官方来源记录`,
    );
  }

  const roles = scannedAsset.descriptions.flatMap(
    (description) => description.artifactRoles,
  );
  assert.equal(
    roles.filter(({ role }) => role === "asset.primary-cover").length,
    1,
    "每个 DLsite 作品必须有一个封面角色",
  );
  const materialLocations = materialFiles.map((file) => {
    const expectedAddress = path.resolve(root.realPath, file.relativePath);
    const location = exactOne(
      scannedAsset.locations,
      ({ address }) => path.resolve(address) === expectedAddress,
      `${work.sourceNativeAddress} 本地材料 ${file.relativePath}`,
    );
    assert.equal(location.kind, "observed");
    assert.equal(location.byteLength, file.size);
    assert.equal(location.content.status, "confirmed");
    if (location.content.status !== "confirmed")
      throw new Error(`本地材料 ${file.relativePath} 尚未确认修订版`);
    assert.equal(location.content.target.kind, "artifact-revision");
    assert.equal(location.content.target.artifactId, location.artifactId);
    return location;
  });
  assert.equal(materialLocations.length, materialFiles.length);
  assert.equal(
    new Set(materialLocations.map(({ id }) => id)).size,
    materialFiles.length,
    "多文件材料必须保留逐文件公开位置",
  );
  assert.deepEqual(
    scannedAsset.relatedEntities
      .filter(({ sourceIdentity }) => sourceIdentity === "dlsite")
      .map(({ id }) => id)
      .toSorted((left, right) => left.localeCompare(right)),
    [...expectedDlsiteEntityIds].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    "所有公开来源实体都必须属于复核的社团、署名或系列预期",
  );
  assert(
    !scannedAsset.relationships.some(
      (relationship) =>
        relationship.participants.some(
          (participant) =>
            participant.entityId === scannedAsset.id &&
            participant.role === "dlsite.series.member",
        ) && !facts.some((fact) => fact.property === "asset.series-position"),
    ),
  );
  signal.throwIfAborted();
  return {
    sourceNativeAddress: work.sourceNativeAddress,
    assetId: scannedAsset.id,
    sources: sourceRecords
      .map(({ id, coverage }) => ({ id, coverage: coverage?.id }))
      .toSorted((left, right) =>
        String(left.coverage).localeCompare(String(right.coverage)),
      ),
    metadata: facts.filter(({ sourceIdentity }) => sourceIdentity === "dlsite"),
    relatedEntities: scannedAsset.relatedEntities.map(
      ({ id: _id, ...entity }) => entity,
    ),
    relationships: scannedAsset.relationships.map(
      ({ id: _id, ...relationship }) => relationship,
    ),
    materialPathCount: materialFiles.length,
    materialLocationCount: materialLocations.length,
    coverRoleCount: 1,
  };
}

async function verifySharedCircleIdentities(input: {
  readonly client: PublicApiClient;
  readonly roots: readonly MaterialRoot[];
  readonly assetsBySourceAddress: ReadonlyMap<string, PublicCurrentAsset>;
}): Promise<readonly Record<string, unknown>[]> {
  const groups = new Map<
    string,
    { readonly label: string; readonly works: ReviewedAudioWork[] }
  >();
  for (const { work } of input.roots) {
    const previous = groups.get(work.circleSourceKey);
    if (previous === undefined)
      groups.set(work.circleSourceKey, { label: work.circle, works: [work] });
    else {
      assert.equal(previous.label, work.circle);
      previous.works.push(work);
    }
  }
  const verified: Record<string, unknown>[] = [];
  for (const [sourceKey, group] of groups) {
    const expectedAssets = group.works.map((work) => {
      const asset = input.assetsBySourceAddress.get(work.sourceNativeAddress);
      assert(asset);
      return asset;
    });
    const expectedIds = expectedAssets
      .map(({ id }) => id)
      .toSorted((a, b) => a.localeCompare(b));
    const details = await Promise.all(
      (await input.client.findRelatedEntities(group.label)).map(({ id }) =>
        input.client.inspectRelatedEntity(id),
      ),
    );
    const matches = details.filter(
      ({ entity }) =>
        entity.sourceIdentity === "dlsite" &&
        entity.identityNamespace === "dlsite.circle" &&
        entity.sourceKey === sourceKey,
    );
    assert.equal(matches.length, 1, `${group.label} 必须复用唯一来源身份`);
    const [circle] = matches;
    assert(circle);
    assert.deepEqual(
      circle.accepted
        .map(({ id }) => id)
        .toSorted((a, b) => a.localeCompare(b)),
      expectedIds,
      `${group.label} 当前作品集合必须与官方圆社身份一致`,
    );
    assert(
      expectedAssets.every((asset) =>
        asset.relatedEntities.some((entity) => entity.id === circle.entity.id),
      ),
    );
    verified.push({
      sourceKey,
      entityId: circle.entity.id,
      assetIds: expectedIds,
    });
  }
  return verified;
}

async function verifyOccurrenceLocalCredits(input: {
  readonly client: PublicApiClient;
  readonly roots: readonly MaterialRoot[];
  readonly assetsBySourceAddress: ReadonlyMap<string, PublicCurrentAsset>;
}): Promise<readonly Record<string, unknown>[]> {
  const uses = new Map<
    string,
    {
      readonly field: CreditField;
      readonly label: string;
      readonly works: ReviewedAudioWork[];
    }
  >();
  for (const { work } of input.roots)
    for (const [field, credits] of Object.entries(work.credits) as [
      CreditField,
      readonly string[],
    ][]) {
      for (const label of credits) {
        const key = `${field}\0${label}`;
        const previous = uses.get(key);
        if (previous === undefined)
          uses.set(key, { field, label, works: [work] });
        else previous.works.push(work);
      }
    }
  const verified: Record<string, unknown>[] = [];
  for (const { field, label, works } of uses.values()) {
    if (works.length < 2) continue;
    const expectedAssets = works.map((work) => {
      const asset = input.assetsBySourceAddress.get(work.sourceNativeAddress);
      assert(asset);
      return { work, asset };
    });
    const expectedIds = new Set(expectedAssets.map(({ asset }) => asset.id));
    const details = await Promise.all(
      (await input.client.findRelatedEntities(label)).map(({ id }) =>
        input.client.inspectRelatedEntity(id),
      ),
    );
    const matching = details.filter(
      ({ entity, accepted }) =>
        entity.identityNamespace ===
          `dlsite.credit.${field}.${field}.occurrence-local` &&
        accepted.some(({ id }) => expectedIds.has(id)),
    );
    assert.equal(matching.length, works.length);
    const identityKeys = new Set(
      matching.map(({ entity }) => entity.sourceKey),
    );
    assert.equal(identityKeys.size, works.length);
    for (const { work, asset } of expectedAssets) {
      const identity = matching.find(({ entity }) =>
        entity.sourceKey?.includes(work.sourceNativeAddress),
      );
      assert(
        identity,
        `${label} 必须保留 ${work.sourceNativeAddress} 的单次身份`,
      );
      assert.deepEqual(
        identity.accepted.map(({ id }) => id),
        [asset.id],
      );
    }
    verified.push({
      field,
      label,
      sourceNativeAddresses: works.map(
        ({ sourceNativeAddress }) => sourceNativeAddress,
      ),
      identities: [...identityKeys].toSorted((left, right) =>
        String(left).localeCompare(String(right)),
      ),
    });
  }
  return verified;
}

export async function runDlsiteLive(
  input: DlsiteLiveInput,
): Promise<DlsiteLiveResult> {
  const signalController = new AbortController();
  const upstreamAbort = (): void =>
    signalController.abort(input.signal?.reason);
  if (input.signal?.aborted) upstreamAbort();
  else input.signal?.addEventListener("abort", upstreamAbort, { once: true });
  const evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    environment: input.environment,
    outcome: "running",
  };
  let evidencePath = path.resolve(input.workspacePath, input.evidencePath);
  let evidencePathSafe = false;
  const save = async (): Promise<void> => {
    if (!evidencePathSafe) throw new Error("证据路径尚未通过工作区边界检查");
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify(evidence, undefined, 2)}\n`,
    );
  };
  let outcome: DlsiteLiveResult["outcome"] = "failed";
  let conditionMissing: readonly string[] | undefined;
  let failure: Failure | undefined;
  let cleanupErrors: Failure[] = [];
  let ownedRun: ReturnType<typeof ownedRunFromStart>;
  let roots: MaterialRoot[] = [];
  try {
    evidencePath = await resolveEvidencePath(
      input.workspacePath,
      input.evidencePath,
      [],
    );
    evidencePathSafe = true;
    const oracle = await readOracle();
    assert.equal(
      oracle.reviews.dlsite.status,
      "reviewed-current-official-source",
    );
    assert.equal(oracle.reviews.dlsite.reviewedAt, "2026-08-29");
    assert.match(
      oracle.reviews.dlsite.reviewMethod,
      /Independently fetched and compared each current official DLsite product JSON and HTML page/u,
    );
    assert.equal(oracle.audioWorks.length, 8);
    assert.equal(
      new Set(
        oracle.audioWorks.map(({ sourceNativeAddress }) => sourceNativeAddress),
      ).size,
      8,
    );
    roots = await resolveRoots(input.voiceWorkRoot, oracle.audioWorks);
    if (roots.some((root) => isWithin(root.realPath, evidencePath)))
      throw new ConditionMissingError(["证据文件不能写入素材根目录"]);
    evidence["evidencePath"] = evidencePath;
    evidence["oracle"] = {
      status: oracle.reviews.dlsite.status,
      reviewedAt: oracle.reviews.dlsite.reviewedAt,
      workCount: oracle.audioWorks.length,
    };
    evidence["materialsBefore"] = roots.map(
      ({ work, realPath, digestBefore }) => ({
        sourceNativeAddress: work.sourceNativeAddress,
        directoryName: path.basename(realPath),
        digest: digestBefore,
      }),
    );
    await save();

    const prior = await inspectEnvironment({
      workspacePath: input.workspacePath,
      environment: input.environment,
    });
    evidence["priorEnvironment"] = {
      status: prior.status,
      state: prior.state,
      sourceMode: prior.environment.sourceMode,
      runState: prior.run.state,
      runLiveness: prior.run.processLiveness,
    };
    if (prior.status !== "ok" || prior.state !== "prepared")
      throw new ConditionMissingError(["指定环境必须先由正式命令准备完成"]);
    if (prior.environment.sourceMode !== "real")
      throw new ConditionMissingError(["指定环境必须明确配置为 real 来源模式"]);
    if (
      prior.environment.environmentId === null ||
      prior.environment.dataGeneration === null
    )
      throw new ConditionMissingError(["指定环境缺少可核对的数据世代"]);
    if (
      (prior.run.processLiveness !== "exited" &&
        prior.run.processLiveness !== "absent") ||
      (prior.run.state !== "stopped" && prior.run.state !== "absent") ||
      prior.serviceReadiness === "ready"
    )
      throw new ConditionMissingError([
        "专用真实来源环境必须在开始前已停止；脚本不会接管调用方进程",
      ]);

    const started = await startEnvironment({
      workspacePath: input.workspacePath,
      environment: input.environment,
      runtime: "production",
      signal: signalController.signal,
    });
    ownedRun = ownedRunFromStart({
      result: started,
      previousRunId: prior.run.runId,
      environmentId: prior.environment.environmentId,
      dataGeneration: prior.environment.dataGeneration,
    });
    evidence["start"] = operationEvidence(started);
    if (started.status === "already-ready")
      throw new ConditionMissingError([
        "环境启动前置检查后被其他进程启动；脚本未接管该服务",
      ]);
    if (started.status !== "ready")
      throw new Error(
        started.failure === undefined
          ? `环境启动未成功：${started.status}`
          : `环境启动失败（阶段 ${started.failure.stage}）：${started.failure.message}`,
      );
    assert.equal(
      started.environment.environmentId,
      prior.environment.environmentId,
    );
    assert.equal(
      started.environment.dataGeneration,
      prior.environment.dataGeneration,
    );
    assert(started.run.runId);
    assert(started.run.address);
    await save();
    await waitForProductReady(started.run.address, signalController.signal);
    const client = createCorpusClient(
      started.run.address,
      signalController.signal,
    );

    const libraryResult = await findOrCreateLibrary({ client, roots });
    const { library } = libraryResult;
    evidence["assetLibrary"] = {
      id: library.id,
      created: libraryResult.created,
      directoryCount: library.directories.length,
      recognitionProfileIds: library.recognitionProfileIds,
      sourceIdentities: library.sourceIdentities,
    };
    const scanStart = await client.startAssetLibraryScan(library.id);
    const scan = await waitForAssetLibraryScan(
      client,
      scanStart.parentExecutionId,
      workflowTimeoutMs,
    );
    evidence["scan"] = {
      parentExecutionId: scan.parentExecutionId,
      status: scan.status,
      outcome: scan.outcome,
      directoryCount: scan.directories.length,
    };
    assert.equal(scan.status, "completed");
    assert.equal(scan.directories.length, roots.length);
    assert(
      scan.directories.every(
        (directory) =>
          directory.mode === "execute" &&
          (directory.outcome === "accepted" ||
            directory.outcome === "no-change"),
      ),
      "八个互不重叠的 DLsite 素材根必须各自扫描并保留来源资产",
    );
    assert(
      scan.outcome === "accepted" || scan.outcome === "no-change",
      "DLsite 真实扫描必须完整接受或复用已有来源资产",
    );
    const allAssets = await listAllAssets(client, library.id);
    const results: Record<string, unknown>[] = [];
    const assetsBySourceAddress = new Map<string, PublicCurrentAsset>();
    for (const root of roots) {
      signalController.signal.throwIfAborted();
      const { asset, materialFiles } = await inspectRoot({
        client,
        library,
        scan,
        root,
        allAssets,
      });
      assetsBySourceAddress.set(root.work.sourceNativeAddress, asset);
      results.push(
        await verifyWork({
          client,
          root,
          scannedAsset: asset,
          materialFiles,
          signal: signalController.signal,
        }),
      );
    }
    assert.equal(
      new Set(results.map(({ assetId }) => assetId)).size,
      roots.length,
    );
    const sharedCircles = await verifySharedCircleIdentities({
      client,
      roots,
      assetsBySourceAddress,
    });
    const occurrenceLocalCredits = await verifyOccurrenceLocalCredits({
      client,
      roots,
      assetsBySourceAddress,
    });
    assert(occurrenceLocalCredits.length > 0);
    const entityIdsBySourceIdentity = new Map<string, string>();
    for (const asset of assetsBySourceAddress.values())
      for (const entity of asset.relatedEntities) {
        if (entity.sourceIdentity !== "dlsite") continue;
        assert(entity.identityNamespace);
        assert(entity.sourceKey);
        const identity = `${entity.identityNamespace}\0${entity.sourceKey}`;
        const previousId = entityIdsBySourceIdentity.get(identity);
        if (previousId === undefined)
          entityIdsBySourceIdentity.set(identity, entity.id);
        else assert.equal(entity.id, previousId);
      }
    evidence["sharedCircles"] = sharedCircles;
    evidence["occurrenceLocalCredits"] = occurrenceLocalCredits;
    assert.equal(
      roots.some(({ work }) => work.sourceNativeAddress.startsWith("RJ")),
      true,
    );
    assert.equal(
      roots.some(({ work }) => work.sourceNativeAddress.startsWith("VJ")),
      true,
    );
    assert(
      roots.some(({ work }) =>
        Object.values(work.credits).some((credits) => credits.length > 1),
      ),
      "八作预期必须覆盖多位贡献者",
    );
    assert(roots.some(({ work }) => work.reviewedSeries !== undefined));
    assert(
      results.some(
        ({ materialLocationCount }) =>
          typeof materialLocationCount === "number" &&
          materialLocationCount > 1,
      ),
      "八作预期必须覆盖多文件本地材料位置",
    );
    evidence["works"] = results;
    const passedDigests = await Promise.all(
      roots.map(({ realPath }) => digestDirectory(realPath)),
    );
    signalController.signal.throwIfAborted();
    assert.deepEqual(
      passedDigests,
      roots.map(({ digestBefore }) => digestBefore),
      "DLsite 真实扫描不得改动已复核素材字节",
    );
    evidence["materialsAfter"] = roots.map((root, index) => ({
      sourceNativeAddress: root.work.sourceNativeAddress,
      digest: passedDigests[index],
      unchanged: true,
    }));
    outcome = "passed";
  } catch (error) {
    if (
      error instanceof ConditionMissingError ||
      error instanceof MaterialPathMissingError
    ) {
      outcome = "condition-missing";
      conditionMissing =
        error instanceof ConditionMissingError ? error.items : [error.message];
      evidence["conditionMissing"] = conditionMissing;
    } else if (signalController.signal.aborted) {
      outcome = "cancelled";
      failure = safeFailure(error);
      evidence["failure"] = failure;
    } else {
      outcome = "failed";
      failure = safeFailure(error);
      evidence["failure"] = failure;
    }
  } finally {
    if (ownedRun !== undefined) {
      try {
        const before = await inspectEnvironment({
          workspacePath: input.workspacePath,
          environment: input.environment,
        });
        if (
          before.status !== "ok" ||
          before.environment.environmentId !== ownedRun.environmentId ||
          before.environment.dataGeneration !== ownedRun.dataGeneration ||
          before.run.runId !== ownedRun.runId
        ) {
          cleanupErrors.push({
            name: "OwnershipCheckError",
            message: "结束时无法核对本次环境运行归属，保留现有运行",
          });
        } else {
          const stopped = await stopEnvironment({
            workspacePath: input.workspacePath,
            environment: input.environment,
          });
          evidence["stop"] = operationEvidence(stopped);
          if (
            stopped.status !== "stopped" &&
            stopped.status !== "already-stopped"
          )
            cleanupErrors.push({
              name: "StopOperationError",
              message: `停止本次运行未成功：${stopped.status}`,
            });
          if (stopped.cleanup.errors.length > 0)
            cleanupErrors.push(
              ...stopped.cleanup.errors.map((message) =>
                safeFailure(new Error(message)),
              ),
            );
          const afterStop = await inspectEnvironment({
            workspacePath: input.workspacePath,
            environment: input.environment,
          });
          assert.equal(afterStop.status, "ok");
          assert.equal(afterStop.state, "prepared");
          assert.equal(
            afterStop.environment.environmentId,
            ownedRun.environmentId,
          );
          assert.equal(
            afterStop.environment.dataGeneration,
            ownedRun.dataGeneration,
          );
          assert(
            afterStop.run.state === "stopped" ||
              afterStop.run.state === "absent",
          );
          assert(
            afterStop.run.processLiveness === "exited" ||
              afterStop.run.processLiveness === "absent",
          );
        }
      } catch (error) {
        cleanupErrors.push(safeFailure(error));
      }
    }
    const afterDigests = await Promise.all(
      roots.map(async (root) => ({
        sourceNativeAddress: root.work.sourceNativeAddress,
        digest: await digestDirectory(root.realPath).catch((error: unknown) => {
          cleanupErrors.push(safeFailure(error));
          return "unavailable";
        }),
        digestBefore: root.digestBefore,
      })),
    );
    evidence["finalMaterialDigests"] = afterDigests;
    if (signalController.signal.aborted && outcome === "passed") {
      outcome = "cancelled";
      failure = safeFailure(
        signalController.signal.reason ?? new Error("验收已取消"),
      );
      evidence["failure"] = failure;
    }
    if (
      afterDigests.some(({ digest, digestBefore }) => digest !== digestBefore)
    ) {
      outcome = "failed";
      failure ??= {
        name: "MaterialChangedError",
        message: "DLsite 真实扫描前后素材完整字节摘要不同",
      };
      evidence["failure"] = failure;
    }
    evidence["cleanupErrors"] = cleanupErrors;
    evidence["outcome"] =
      cleanupErrors.length > 0 && outcome === "passed" ? "failed" : outcome;
    evidence["finishedAt"] = new Date().toISOString();
    try {
      await save();
    } catch (error) {
      cleanupErrors.push(safeFailure(error));
      evidence["cleanupErrors"] = cleanupErrors;
    }
    input.signal?.removeEventListener("abort", upstreamAbort);
  }
  return {
    outcome:
      cleanupErrors.length > 0 && outcome === "passed" ? "failed" : outcome,
    evidencePath,
    ...(conditionMissing === undefined ? {} : { conditionMissing }),
    ...(failure === undefined ? {} : { failure }),
    ...(cleanupErrors.length === 0 ? {} : { cleanupErrors }),
  };
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = (signal: NodeJS.Signals): void =>
    controller.abort(new Error(`收到 ${signal}`));
  const onSigint = (): void => onInterrupt("SIGINT");
  const onSigterm = (): void => onInterrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    if (
      environmentArgument === undefined ||
      evidenceArgument === undefined ||
      voiceWorkArgument === undefined
    ) {
      process.stderr.write(
        "用法：pnpm verify:dlsite-eight-live <已准备的 real 环境> <工作区内证据路径> <VoiceWork 素材根>\n",
      );
      process.exitCode = 2;
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(environmentArgument)) {
      process.stderr.write("条件未满足：环境名格式无效\n");
      process.exitCode = 2;
      return;
    }
    const result = await runDlsiteLive({
      workspacePath,
      environment: environmentArgument,
      evidencePath: evidenceArgument,
      voiceWorkRoot: path.resolve(voiceWorkArgument),
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome === "condition-missing") process.exitCode = 2;
    else if (result.outcome === "cancelled") process.exitCode = 130;
    else if (result.outcome === "failed") process.exitCode = 1;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === new URL(`file://${invokedPath}`).href
)
  await main();
