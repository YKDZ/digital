import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectEnvironment,
  startEnvironment,
  stopEnvironment,
  type StartOperationResult,
} from "@digital/environment";
import {
  type PublicApiClient,
  type PublicAssetLibrary,
  type PublicAssetLibraryScan,
  type PublicCurrentAsset,
} from "@digital/public-api";
import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  artifactRoleAddress,
  createCorpusClient,
  hasArtifactRole,
  listAllAssetLibraries,
  listAllAssets,
  waitForAssetLibraryScan,
  waitForProductReady,
  waitForPublicExecution,
} from "./corpus-verification.ts";
import { requireInput } from "./inputs.ts";
import { digestDirectory } from "./material-digest.ts";

type FanboxPost = {
  readonly logicalRoot: string;
  readonly directoryDate: string;
  readonly sourceNativeAddress: string;
  readonly title: string;
  readonly publishedDatetime: string;
  readonly postType: "text" | "file" | "image" | "video" | "article";
  readonly creatorId: string;
  readonly entitlement: "available" | "restricted";
  readonly cover: "present" | "absent";
  readonly body:
    | {
        readonly status: "available";
        readonly text: string;
        readonly blocks: readonly {
          readonly ordinal: number;
          readonly type: string;
          readonly value: Readonly<Record<string, unknown>>;
        }[];
      }
    | { readonly status: "restricted"; readonly blocks: readonly [] };
  readonly attachments: readonly {
    readonly ordinal: number;
    readonly kind: "file" | "image";
    readonly name?: string;
    readonly byteLength?: string;
  }[];
};

type ReviewedOracle = {
  readonly creatorPosts: readonly FanboxPost[];
  readonly reviews: {
    readonly fanbox: {
      readonly status: string;
      readonly observedAt: string;
    };
  };
};

type Root = {
  readonly post: FanboxPost;
  readonly path: string;
  readonly realPath: string;
};

type SourceRecord = Extract<
  Awaited<ReturnType<PublicApiClient["listAssetEvidence"]>>["items"][number],
  { kind: "source-record" }
>;

type SourceValue = {
  readonly value: string;
  readonly sourceIdentity: string;
  readonly sourceSlot: string;
  readonly sourceRecordIds: readonly string[];
};

const workspacePath = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
const environment = process.argv[2];
const evidenceArgument = process.argv[3];
const materialsRootArgument = process.argv[4];
assert(
  environment !== undefined &&
    evidenceArgument !== undefined &&
    evidenceArgument.length > 0 &&
    !path.isAbsolute(evidenceArgument) &&
    materialsRootArgument !== undefined &&
    path.isAbsolute(materialsRootArgument),
  "用法：pnpm verify:fanbox-five-live <已准备且已停止的真实环境名> <证据文件> <五帖完整资料根绝对路径>",
);

class ConditionMissingError extends Error {
  readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super(items.join("；"));
    this.name = "ConditionMissingError";
    this.items = items;
  }
}

const evidencePath = path.resolve(workspacePath, evidenceArgument);
const materialsRoot = path.resolve(materialsRootArgument);
function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
assert(
  !pathContains(materialsRoot, evidencePath) &&
    !pathContains(evidencePath, materialsRoot),
  "证据文件不得与真实资料根重叠",
);
const oraclePath = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/live/reviewed-oracle.json"),
);
const selectionPath = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/live/files-from.txt"),
);
const oracle = JSON.parse(await readFile(oraclePath, "utf8")) as ReviewedOracle;
const selection = (await readFile(selectionPath, "utf8"))
  .split(/\r?\n/u)
  .map((line) => line.trim().replace(/\/+$/u, ""))
  .filter((line) => line.length > 0 && !line.startsWith("#"));
assert.equal(
  oracle.reviews.fanbox.status,
  "reviewed-current-official-source",
  "FANBOX 五帖必须使用当前官方来源复核记录",
);
assert.equal(oracle.creatorPosts.length, 5);
assert(oracle.creatorPosts.every((post) => post.creatorId === "customudon"));
for (const post of oracle.creatorPosts)
  assert(selection.includes(post.logicalRoot));

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  environment,
  journey: "fanbox-five-live",
  status: "running",
  oracle: {
    reviewStatus: oracle.reviews.fanbox.status,
    observedAt: oracle.reviews.fanbox.observedAt,
    posts: oracle.creatorPosts.map((post) => ({
      logicalRoot: post.logicalRoot,
      sourceNativeAddress: post.sourceNativeAddress,
    })),
  },
  cleanupErrors: [],
};

const save = async (): Promise<void> => {
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, undefined, 2)}\n`);
};

function object(value: unknown, label: string): Record<string, unknown> {
  assert.equal(
    typeof value === "object" && value !== null && !Array.isArray(value),
    true,
    `${label} 必须为对象`,
  );
  return value as Record<string, unknown>;
}

function sameStrings(left: readonly string[], right: readonly string[]): void {
  assert.deepEqual([...left].toSorted(), [...right].toSorted());
}

function sourceValues(
  asset: PublicCurrentAsset,
  property: string,
): SourceValue[] {
  return asset.descriptions.flatMap((description) =>
    description.metadata
      .filter((metadata) => metadata.property === property)
      .flatMap((metadata) =>
        metadata.result.status === "resolved"
          ? metadata.result.values.map((value) => ({
              value: value.value,
              sourceIdentity: value.sourceIdentity,
              sourceSlot: value.sourceSlot,
              sourceRecordIds: value.sourceRecordIds,
            }))
          : [],
      ),
  );
}

function exactFanboxValue(
  asset: PublicCurrentAsset,
  property: string,
  expected: string,
  recordIds: ReadonlySet<string>,
): SourceValue {
  const values = sourceValues(asset, property).filter(
    (value) => value.sourceIdentity === "fanbox" && value.value === expected,
  );
  assert.equal(values.length, 1, `${property} 必须有唯一的 FANBOX 当前值`);
  const [value] = values;
  assert(value);
  assert(value.sourceRecordIds.length > 0);
  assert(value.sourceRecordIds.every((id) => recordIds.has(id)));
  return value;
}

async function allSourceRecords(
  client: PublicApiClient,
  assetId: string,
): Promise<SourceRecord[]> {
  const items: SourceRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAssetEvidence(assetId, {
      kind: "source-records",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of page.items)
      if (item.kind === "source-record") items.push(item);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

async function sourceRecordContent(
  client: PublicApiClient,
  assetId: string,
  record: SourceRecord,
): Promise<string> {
  assert.equal(record.status, "available");
  let content = "";
  let offset = 0;
  let complete = false;
  while (!complete) {
    controller.signal.throwIfAborted();
    const chunk = await client.readAssetSourceRecord(assetId, record.id, {
      offset,
      limit: 4096,
    });
    assert.equal(chunk.assetId, assetId);
    assert.equal(chunk.record.id, record.id);
    assert.equal(chunk.record.sourceIdentity, "fanbox");
    content += chunk.content;
    complete = chunk.complete;
    if (!complete) {
      assert(chunk.nextOffset > offset);
      offset = chunk.nextOffset;
    }
  }
  assert.notEqual(content.length, 0);
  return content;
}

async function assetForRoot(
  client: PublicApiClient,
  library: PublicAssetLibrary,
  scan: PublicAssetLibraryScan,
  root: Root,
  assets: readonly PublicCurrentAsset[],
): Promise<PublicCurrentAsset> {
  assert.equal(scan.status, "completed");
  assert.equal(scan.assetLibraryId, library.id);
  const directory = library.directories.find(
    (candidate) => path.resolve(candidate.path) === root.realPath,
  );
  assert(directory, "复核资料根必须出现在正式资产库中");
  assert.equal(directory.status, "active");
  assert.equal(directory.reachable, true);
  const intake = await client.inspectLocalIntake({
    assetLibraryId: library.id,
    directoryId: directory.id,
    parentExecutionId: scan.parentExecutionId,
  });
  assert.equal(intake.execution?.status, "completed");
  assert(intake.execution?.id, "正式本地检查必须给出该授权目录的子执行身份");
  assert(intake.files.length > 0, "每个 FANBOX 根必须有正式本地观察");
  assert(intake.files.every((file) => file.problem === undefined));
  const inspectedChild = await waitForPublicExecution(
    client,
    intake.execution.id,
    300_000,
  );
  assert.equal(inspectedChild.kind, "execution");
  assert.equal(inspectedChild.id, intake.execution.id);
  assert.equal(
    inspectedChild.outcome === "accepted" ||
      inspectedChild.outcome === "no-change",
    true,
    "本地扫描子执行必须已接受或无变化",
  );
  assert.equal(intake.execution.outcome, inspectedChild.outcome);
  assert(inspectedChild.progress.workItems.length > 0);
  const intakeFiles = new Map(
    intake.files.map((file) => [file.relativePath, file]),
  );
  const workItemPaths: string[] = [];
  for (const item of inspectedChild.progress.workItems) {
    assert.equal(
      item.outcome === "accepted" || item.outcome === "no-change",
      true,
      "每个本地工作项都必须已接受或无变化",
    );
    assert(item.relativePaths.length > 0);
    const itemFiles = item.relativePaths.map((relativePath) => {
      const file = intakeFiles.get(relativePath);
      assert(file, `正式子执行材料不属于当前授权目录：${relativePath}`);
      workItemPaths.push(relativePath);
      return file;
    });
    const itemAssetIds = [
      ...new Set(itemFiles.flatMap((file) => file.assetIds)),
    ].toSorted();
    const executionAssetId = item.acceptedAssetId ?? item.retainedAssetId;
    assert(executionAssetId, "正式子执行必须保留此材料的资产身份");
    assert.deepEqual(itemAssetIds, [executionAssetId]);
  }
  assert.deepEqual(
    [...workItemPaths].toSorted(),
    [...intakeFiles.keys()].toSorted(),
    "正式子执行必须覆盖本次授权目录读回的全部材料路径",
  );

  const expectedAddress = `https://www.fanbox.cc/@${root.post.creatorId}/posts/${root.post.sourceNativeAddress}`;
  const matches = assets.filter((asset) =>
    asset.sourceAssociations.some(
      (association) =>
        association.sourceIdentity === "fanbox" &&
        association.nativeAddress === expectedAddress,
    ),
  );
  assert.equal(matches.length, 1, "每帖应只有一个精确官方来源关联的资产");
  const [asset] = matches;
  assert(asset);
  assert.deepEqual(asset.sourceAssociations, [
    { sourceIdentity: "fanbox", nativeAddress: expectedAddress },
  ]);
  assert.deepEqual(asset.recognitionSourceAssociation, {
    sourceIdentity: "fanbox",
    nativeAddress: expectedAddress,
  });
  const localAssetIds = new Set(intake.files.flatMap((file) => file.assetIds));
  assert(localAssetIds.has(asset.id), "官方来源资产必须关联此根的本地材料");
  assert.deepEqual([...localAssetIds], [asset.id]);
  for (const file of intake.files)
    assert(file.assetIds.includes(asset.id), "每个已登记材料都必须归属该帖子");
  return asset;
}

async function parsePostRecords(
  client: PublicApiClient,
  asset: PublicCurrentAsset,
  post: FanboxPost,
): Promise<{
  readonly records: SourceRecord[];
  readonly summary: Record<string, unknown>;
  readonly detail: Record<string, unknown>;
  readonly summaryRecord: SourceRecord;
  readonly detailRecord: SourceRecord;
}> {
  const records = (await allSourceRecords(client, asset.id)).filter(
    (record) =>
      record.sourceIdentity === "fanbox" &&
      record.nativeAddress ===
        `https://www.fanbox.cc/@${post.creatorId}/posts/${post.sourceNativeAddress}`,
  );
  const summaries = records.filter(
    (record) =>
      record.status === "available" &&
      record.coverage?.id === "fanbox.creator-post-summaries",
  );
  const details = records.filter(
    (record) =>
      record.status === "available" &&
      record.coverage?.id === "fanbox.post-detail",
  );
  assert(summaries.length > 0, "缺少官方创作者帖子摘要来源记录");
  assert(details.length > 0, "缺少官方帖子详情来源记录");
  const acquiredAt = (record: SourceRecord): string => {
    assert(record.acquiredAt, "正式来源记录必须保留采集时间");
    return record.acquiredAt;
  };
  const summaryRecord = [...summaries]
    .toSorted((left, right) =>
      acquiredAt(left).localeCompare(acquiredAt(right)),
    )
    .at(-1)!;
  const detailRecord = [...details]
    .toSorted((left, right) =>
      acquiredAt(left).localeCompare(acquiredAt(right)),
    )
    .at(-1)!;
  assert.equal(summaryRecord.coverage?.authority, "official");
  assert.equal(detailRecord.coverage?.authority, "official");
  assert.equal(summaryRecord.coverage?.completeness, "complete");
  assert.equal(
    detailRecord.coverage?.completeness,
    post.entitlement === "restricted" ? "incomplete" : "complete",
  );
  const [summaryContent, detailContent] = await Promise.all([
    sourceRecordContent(client, asset.id, summaryRecord),
    sourceRecordContent(client, asset.id, detailRecord),
  ]);
  const summaryEnvelope = object(
    JSON.parse(summaryContent) as unknown,
    "摘要响应",
  );
  const summaryBody = object(summaryEnvelope.body, "摘要响应主体");
  assert(Array.isArray(summaryBody.posts), "摘要响应必须包含帖子列表");
  const summaryMatches = summaryBody.posts
    .map((candidate) => object(candidate, "摘要帖子"))
    .filter((candidate) => candidate.id === post.sourceNativeAddress);
  assert.equal(summaryMatches.length, 1, "官方摘要必须唯一指向该帖子");
  const summary = summaryMatches[0]!;
  assert.equal(summary.creatorId, post.creatorId);
  assert.equal(summary.title, post.title);
  assert.equal(summary.publishedDatetime, post.publishedDatetime);

  const detailEnvelope = object(
    JSON.parse(detailContent) as unknown,
    "详情响应",
  );
  const detailBody = object(detailEnvelope.body, "详情响应主体");
  const detail = object(detailBody.post, "详情帖子");
  assert.equal(detail.id, post.sourceNativeAddress);
  assert.equal(detail.creatorId, post.creatorId);
  assert.equal(detail.title, post.title);
  assert.equal(detail.publishedDatetime, post.publishedDatetime);
  assert.equal(detail.type, post.postType);
  const restricted =
    detail.isRestricted === true ||
    (typeof detail.restrictedFor === "string" &&
      detail.restrictedFor.length > 0 &&
      detail.restrictedFor !== "none");
  assert.equal(restricted ? "restricted" : "available", post.entitlement);
  if (post.body.status === "restricted") {
    assert.equal(detail.body, undefined);
  } else {
    const body = object(detail.body, "帖子正文");
    if (Object.hasOwn(body, "text")) assert.equal(body.text, post.body.text);
    if (post.postType === "article") {
      assert(Array.isArray(body.blocks));
      assert.equal(body.blocks.length, post.body.blocks.length);
      for (const [index, expected] of post.body.blocks.entries()) {
        assert.equal(expected.ordinal, index);
        assert.deepEqual(body.blocks[index], expected.value);
      }
    }
  }
  return { records, summary, detail, summaryRecord, detailRecord };
}

function assertPostProjection(
  asset: PublicCurrentAsset,
  post: FanboxPost,
  recordIds: ReadonlySet<string>,
): void {
  exactFanboxValue(asset, "asset.title", post.title, recordIds);
  exactFanboxValue(
    asset,
    "asset.publication-datetime",
    post.publishedDatetime,
    recordIds,
  );
  exactFanboxValue(
    asset,
    "fanbox.post.entitlement",
    post.entitlement,
    recordIds,
  );
  exactFanboxValue(asset, "fanbox.post.form", post.postType, recordIds);

  const bodyValues = sourceValues(asset, "asset.body").filter(
    (value) => value.sourceIdentity === "fanbox",
  );
  if (post.body.status === "available") {
    assert.equal(bodyValues.length, 1, "正文应有唯一官方正文当前值");
    assert.equal(bodyValues[0]!.value, post.body.text);
    assert(bodyValues[0]!.sourceRecordIds.every((id) => recordIds.has(id)));
  } else {
    assert.equal(bodyValues.length, 0, "受限帖子不得暴露正文");
  }
  const blockFacts = sourceValues(asset, "fanbox.post.body-block").filter(
    (value) => value.sourceIdentity === "fanbox",
  );
  assert.equal(blockFacts.length, post.body.blocks.length);
  for (const block of post.body.blocks) {
    const slot = `fanbox.post.body-block:${String(block.ordinal)}`;
    const fact = blockFacts.find((candidate) => candidate.sourceSlot === slot);
    assert(fact, `缺少第 ${String(block.ordinal)} 个正文块来源事实`);
    assert(fact.sourceRecordIds.length > 0);
    assert(fact.sourceRecordIds.every((id) => recordIds.has(id)));
    const projection = object(JSON.parse(fact.value) as unknown, "正文块事实");
    assert.equal(projection.type, block.type);
    if (block.type === "p" || block.type === "header")
      assert.equal(projection.text, block.value.text);
  }

  const expectedAttachments = [...post.attachments].toSorted(
    (left, right) => left.ordinal - right.ordinal,
  );
  const actualAttachments = (asset.sourceArtifacts ?? [])
    .filter((candidate) => candidate.role.startsWith("fanbox.attachment."))
    .map((candidate) => ({
      role: candidate.role,
      selectionEvidence: candidate.selectionEvidence,
    }));
  assert.equal(actualAttachments.length, expectedAttachments.length);
  for (const [index, expected] of expectedAttachments.entries()) {
    const candidate = actualAttachments[index];
    assert(candidate);
    assert.equal(candidate.role, `fanbox.attachment.${expected.kind}`);
    const selectionEvidence = object(
      candidate.selectionEvidence,
      "附件来源选择依据",
    );
    if (expected.name !== undefined)
      assert.equal(selectionEvidence.suggestedFilename, expected.name);
    if (expected.byteLength !== undefined)
      assert.equal(
        selectionEvidence.declaredByteLength,
        Number(expected.byteLength),
      );
    assert.equal(selectionEvidence.sourceOrdinal, expected.ordinal);
  }
  assert.equal(
    hasArtifactRole(asset, "asset.primary-cover"),
    post.cover === "present",
    "封面角色必须符合逐帖独立预期",
  );
  const creators = asset.relatedEntities.filter(
    (entity) =>
      entity.sourceIdentity === "fanbox" &&
      entity.identityNamespace === "fanbox.creator" &&
      entity.sourceKey === post.creatorId,
  );
  assert.equal(creators.length, 1, "每帖应唯一关联正式 FANBOX 创作者身份");
  const contribution = asset.relationships.filter(
    (relationship) =>
      relationship.type === "asset.contribution" &&
      relationship.participants.some(
        (participant) =>
          participant.entityId === asset.id && participant.role === "asset",
      ) &&
      relationship.participants.some(
        (participant) =>
          participant.entityId === creators[0]!.id &&
          participant.role === "fanbox.post.creator",
      ),
  );
  assert.equal(contribution.length, 1, "帖子必须保留创作者贡献关系");
  assert(contribution[0]!.sourceRecordIds.length > 0);
  assert(contribution[0]!.sourceRecordIds.every((id) => recordIds.has(id)));
}

async function coverDigest(
  client: PublicApiClient,
  asset: PublicCurrentAsset,
): Promise<string | null> {
  const address = artifactRoleAddress(asset, "asset.primary-cover");
  if (address === undefined) return null;
  const digest = address.split("/").at(-1);
  assert(digest);
  const response = await client.readManagedArtifact(digest, controller.signal);
  assert.equal(response.status, 200, "当前封面制品必须可由正式媒体读取");
  assert.match(response.headers.get("content-type") ?? "", /^image\//u);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  assert(bytes > 0, "托管封面制品必须包含图像字节");
  return hash.digest("hex");
}

function stableProjection(asset: PublicCurrentAsset): unknown {
  return {
    id: asset.id,
    sourceAssociations: asset.sourceAssociations,
    recognitionSourceAssociation: asset.recognitionSourceAssociation,
    metadata: asset.descriptions
      .map((description) => ({
        target: description.target,
        metadata: description.metadata
          .map(({ property, result }) => ({ property, result }))
          .toSorted((left, right) =>
            left.property.localeCompare(right.property),
          ),
      }))
      .toSorted((left, right) =>
        JSON.stringify(left.target).localeCompare(JSON.stringify(right.target)),
      ),
    artifacts: asset.descriptions
      .flatMap((description) =>
        description.artifactRoles.map(({ role, artifactId, address }) => ({
          role,
          artifactId,
          address,
        })),
      )
      .toSorted((left, right) => left.role.localeCompare(right.role)),
    relatedEntities: asset.relatedEntities
      .map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        label: entity.label,
        sourceIdentity: entity.sourceIdentity,
        identityNamespace: entity.identityNamespace,
        sourceKey: entity.sourceKey,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    relationships: asset.relationships
      .map((relationship) => ({
        type: relationship.type,
        participants: [...relationship.participants].toSorted((left, right) =>
          `${left.role}:${left.entityId}`.localeCompare(
            `${right.role}:${right.entityId}`,
          ),
        ),
        sourceRecordIds: [...relationship.sourceRecordIds].toSorted(),
        qualifiers: [...(relationship.qualifiers ?? [])].toSorted(
          (left, right) =>
            `${left.key}:${left.value}`.localeCompare(
              `${right.key}:${right.value}`,
            ),
        ),
      }))
      .toSorted((left, right) =>
        `${left.type}:${JSON.stringify(left.participants)}`.localeCompare(
          `${right.type}:${JSON.stringify(right.participants)}`,
        ),
      ),
    locations: [...asset.locations]
      .map((location) => ({
        id: location.id,
        artifactId: location.artifactId,
        kind: location.kind,
        address: location.address,
        content: location.content,
        byteLength: location.byteLength,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    sourceArtifacts: asset.sourceArtifacts ?? [],
  };
}

async function prepareLibrary(
  client: PublicApiClient,
  roots: readonly Root[],
): Promise<{
  readonly library: PublicAssetLibrary;
  readonly created: boolean;
}> {
  const paths = roots.map((root) => root.realPath);
  const wanted = new Set(paths);
  const libraries = await listAllAssetLibraries(client);
  const overlapping = libraries.filter((library) =>
    library.directories.some((directory) =>
      wanted.has(path.resolve(directory.path)),
    ),
  );
  if (overlapping.length > 1)
    throw new ConditionMissingError([
      "五帖资料根已分散在多个资产库，验收不会改写其他库配置",
    ]);
  if (overlapping.length === 1) {
    const library = overlapping[0]!;
    const configuredPaths = library.directories.map((directory) =>
      path.resolve(directory.path),
    );
    const sortedConfiguredPaths = configuredPaths.toSorted();
    const sortedRequestedPaths = paths.toSorted();
    if (
      sortedConfiguredPaths.length !== sortedRequestedPaths.length ||
      !sortedConfiguredPaths.every(
        (value, index) => value === sortedRequestedPaths[index],
      ) ||
      library.recognitionProfileIds.length !== 1 ||
      library.recognitionProfileIds[0] !== "fanbox" ||
      library.sourceIdentities.length !== 1 ||
      library.sourceIdentities[0] !== "fanbox"
    )
      throw new ConditionMissingError([
        "五帖资料根已登记到非专用 FANBOX 配置，验收不会改写既有库",
      ]);
    for (const root of roots) {
      const directory = library.directories.find(
        (candidate) => path.resolve(candidate.path) === root.realPath,
      );
      if (
        directory === undefined ||
        directory.status !== "active" ||
        !directory.reachable
      )
        throw new ConditionMissingError([
          "FANBOX 验收资料根必须全部处于可达状态",
        ]);
    }
    return { library, created: false };
  }
  const displayName = "FANBOX 五帖真实来源验收";
  if (libraries.some((library) => library.displayName === displayName))
    throw new ConditionMissingError([
      "验收专用资产库名称已被其他目录使用，验收不会替换其配置",
    ]);
  const options = await client.listAssetLibraryOptions();
  assert(options.recognitionProfiles.some(({ id }) => id === "fanbox"));
  assert(options.sources.some(({ id }) => id === "fanbox"));
  const library = await client.saveAssetLibrary({
    displayName,
    directories: paths,
    recognitionProfileIds: ["fanbox"],
    sourceIdentities: ["fanbox"],
  });
  return { library, created: true };
}

async function stopOwnedRun(input: {
  readonly runId: string;
  readonly environmentId: string;
  readonly dataGeneration: string;
}): Promise<void> {
  const before = await inspectEnvironment({
    workspacePath,
    environment: environment!,
  });
  assert.equal(before.status, "ok");
  assert.equal(before.environment.environmentId, input.environmentId);
  assert.equal(before.environment.dataGeneration, input.dataGeneration);
  assert.equal(before.run.runId, input.runId);
  const stopped = await stopEnvironment({
    workspacePath,
    environment: environment!,
  });
  evidence["stopOperation"] = operationEvidence(stopped);
  assert(stopped.status === "stopped" || stopped.status === "already-stopped");
  const after = await inspectEnvironment({
    workspacePath,
    environment: environment!,
  });
  assert.equal(after.status, "ok");
  assert.equal(after.state, "prepared");
  assert.equal(after.environment.environmentId, input.environmentId);
  assert.equal(after.environment.dataGeneration, input.dataGeneration);
  assert(after.run.state === "stopped" || after.run.state === "absent");
  assert(
    after.run.processLiveness === "exited" ||
      after.run.processLiveness === "absent",
  );
}

function safeOperationMessage(message: string): string {
  return message
    .replace(
      /(authorization|cookie|token|secret|password|api[_-]?key|client[_-]?secret|code)=([^&\s]+)/giu,
      "$1=[已省略]",
    )
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [已省略]");
}

function operationEvidence(
  operation: StartOperationResult | Awaited<ReturnType<typeof stopEnvironment>>,
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

function ownedRunFromStart(input: {
  readonly started: StartOperationResult;
  readonly previousRunId: string | null;
  readonly environmentId: string;
  readonly dataGeneration: string;
}): { readonly runId: string } | undefined {
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
  return { runId: input.started.run.runId };
}

function safeFailure(error: unknown): {
  readonly type: string;
  readonly message: string;
} {
  return {
    type:
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      typeof error.name === "string"
        ? error.name
        : "UnknownError",
    message:
      error instanceof ConditionMissingError
        ? "验收所需条件不满足"
        : "公开业务核验或环境操作未完成",
  };
}

let ownedRunId: string | undefined;
let ownedEnvironmentId: string | undefined;
let ownedDataGeneration: string | undefined;
let roots: Root[] | undefined;
let materialsBefore: string[] | undefined;
let filesystemBefore:
  | Awaited<ReturnType<typeof captureRawFilesystemSnapshot>>[]
  | undefined;
let outcome: "passed" | "condition-missing" | "failed" | "cancelled" = "failed";
let conditionMissing: readonly string[] | undefined;
let businessFailure: ReturnType<typeof safeFailure> | undefined;

try {
  const missingRoots: string[] = [];
  for (const post of oracle.creatorPosts) {
    const candidate = path.join(materialsRoot, ...post.logicalRoot.split("/"));
    try {
      if (!(await lstat(candidate)).isDirectory())
        missingRoots.push(post.logicalRoot);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        missingRoots.push(post.logicalRoot);
      else throw error;
    }
  }
  if (missingRoots.length > 0)
    throw new ConditionMissingError(
      missingRoots.map((root) => `缺少完整本地资料根：${root}`),
    );
  roots = await Promise.all(
    oracle.creatorPosts.map(async (post) => {
      const candidate = path.join(
        materialsRoot,
        ...post.logicalRoot.split("/"),
      );
      return { post, path: candidate, realPath: await realpath(candidate) };
    }),
  );
  assert.equal(new Set(roots.map((root) => root.realPath)).size, 5);
  materialsBefore = await Promise.all(
    roots.map(({ realPath: directory }) => digestDirectory(directory)),
  );
  filesystemBefore = await Promise.all(
    roots.map(({ realPath: directory }) =>
      captureRawFilesystemSnapshot(directory),
    ),
  );
  evidence["materialsBefore"] = roots.map((root, index) => ({
    logicalRoot: root.post.logicalRoot,
    directoryName: path.basename(root.realPath),
    digest: materialsBefore![index],
  }));
  await save();

  const prior = await inspectEnvironment({
    workspacePath,
    environment: environment!,
  });
  evidence["priorEnvironment"] = {
    status: prior.status,
    state: prior.state,
    sourceMode: prior.environment.sourceMode,
    runState: prior.run.state,
    runLiveness: prior.run.processLiveness,
    serviceReadiness: prior.serviceReadiness,
  };
  if (prior.status !== "ok" || prior.state !== "prepared")
    throw new ConditionMissingError(["指定真实来源环境必须先由正式命令准备"]);
  if (prior.environment.sourceMode !== "real")
    throw new ConditionMissingError(["指定环境必须明确配置为 real 来源模式"]);
  if (
    prior.environment.environmentId === null ||
    prior.environment.dataGeneration === null
  )
    throw new ConditionMissingError(["指定真实来源环境缺少可核对的数据世代"]);
  if (prior.pendingIntent !== undefined)
    throw new ConditionMissingError(["指定环境仍有未完成的正式管理意图"]);
  if (
    (prior.run.processLiveness !== "exited" &&
      prior.run.processLiveness !== "absent") ||
    (prior.run.state !== "stopped" && prior.run.state !== "absent") ||
    prior.serviceReadiness === "ready"
  )
    throw new ConditionMissingError([
      "专用真实来源环境必须在验收开始前已停止；脚本不会接管现有进程",
    ]);
  const environmentId = prior.environment.environmentId;
  const dataGeneration = prior.environment.dataGeneration;

  const started = await startEnvironment({
    workspacePath,
    environment: environment!,
    runtime: "production",
    signal: controller.signal,
  });
  evidence["start"] = operationEvidence(started);
  const initialOwnedRun = ownedRunFromStart({
    started,
    previousRunId: prior.run.runId,
    environmentId,
    dataGeneration,
  });
  if (initialOwnedRun !== undefined) {
    ownedRunId = initialOwnedRun.runId;
    ownedEnvironmentId = environmentId;
    ownedDataGeneration = dataGeneration;
  }
  if (started.status === "already-ready")
    throw new ConditionMissingError(["启动前置检查后环境已由其他进程启动"]);
  assert.equal(started.status, "ready", "真实来源服务必须正常启动");
  assert(ownedRunId, "必须确认本次启动拥有新的服务世代");
  assert(started.run.address);
  await waitForProductReady(started.run.address, controller.signal);
  let client = createCorpusClient(started.run.address, controller.signal);

  const connection = (await client.listSourceConnections()).items.find(
    (item) => item.id === "fanbox/customudon",
  );
  if (
    connection === undefined ||
    connection.credentialStatus === "unconfigured"
  )
    throw new ConditionMissingError([
      "尚未由正式 FANBOX 连接流程配置 customudon 来源",
    ]);
  evidence["sourceConnection"] = {
    id: connection.id,
    credentialStatus: connection.credentialStatus,
    availability: connection.availability,
    reason: connection.reason,
  };
  assert.equal(connection.credentialStatus, "configured");
  assert.equal(connection.availability, "available");

  const preparedLibrary = await prepareLibrary(client, roots);
  let library = preparedLibrary.library;
  evidence["assetLibrary"] = {
    id: library.id,
    reused: !preparedLibrary.created,
    directoryCount: library.directories.length,
  };

  const initialStart = await client.startAssetLibraryScan(library.id);
  const initialScan = await waitForAssetLibraryScan(
    client,
    initialStart.parentExecutionId,
    15 * 60_000,
  );
  assert.equal(initialScan.status, "completed");
  assert(
    initialScan.outcome === "accepted" || initialScan.outcome === "no-change",
  );
  assert.equal(initialScan.directories.length, roots.length);
  let assets = await listAllAssets(client, library.id);
  const postAssets = new Map<string, PublicCurrentAsset>();
  const initialRecordIds = new Map<string, readonly string[]>();
  const stableByAddress = new Map<string, unknown>();
  const coversBefore = new Map<string, string | null>();
  const postSummaries: Record<string, unknown>[] = [];
  for (const root of roots) {
    const asset = await assetForRoot(
      client,
      library,
      initialScan,
      root,
      assets,
    );
    const parsed = await parsePostRecords(client, asset, root.post);
    const recordIds = new Set(parsed.records.map((record) => record.id));
    assertPostProjection(asset, root.post, recordIds);
    assert.equal(parsed.summaryRecord.id === parsed.detailRecord.id, false);
    assert.equal(
      parsed.summaryRecord.nativeAddress,
      parsed.detailRecord.nativeAddress,
    );
    assert.equal(parsed.summary.creatorId, root.post.creatorId);
    const cover = await coverDigest(client, asset);
    if (root.post.cover === "present") assert(cover !== null);
    else assert.equal(cover, null);
    postAssets.set(root.post.sourceNativeAddress, asset);
    initialRecordIds.set(
      root.post.sourceNativeAddress,
      [...recordIds].toSorted(),
    );
    stableByAddress.set(root.post.sourceNativeAddress, stableProjection(asset));
    coversBefore.set(root.post.sourceNativeAddress, cover);
    postSummaries.push({
      logicalRoot: root.post.logicalRoot,
      sourceNativeAddress: root.post.sourceNativeAddress,
      assetId: asset.id,
      sourceRecordCount: parsed.records.length,
      summaryCoverage: parsed.summaryRecord.coverage?.id,
      detailCoverage: parsed.detailRecord.coverage?.id,
      coverDigest: cover,
    });
  }
  evidence["initialScan"] = {
    outcome: initialScan.outcome,
    directoryCount: initialScan.directories.length,
    posts: postSummaries,
  };
  await save();

  const stoppedRunId = ownedRunId;
  await stopOwnedRun({ runId: stoppedRunId, environmentId, dataGeneration });
  evidence["stoppedBeforeReopen"] = true;
  ownedRunId = undefined;
  ownedEnvironmentId = undefined;
  ownedDataGeneration = undefined;
  const reopened = await startEnvironment({
    workspacePath,
    environment: environment!,
    runtime: "production",
    signal: controller.signal,
  });
  evidence["reopen"] = operationEvidence(reopened);
  const reopenedOwnedRun = ownedRunFromStart({
    started: reopened,
    previousRunId: stoppedRunId,
    environmentId,
    dataGeneration,
  });
  if (reopened.status === "already-ready")
    throw new ConditionMissingError([
      "重开前环境被其他进程启动；脚本没有接管该服务",
    ]);
  if (reopenedOwnedRun !== undefined) {
    ownedRunId = reopenedOwnedRun.runId;
    ownedEnvironmentId = environmentId;
    ownedDataGeneration = dataGeneration;
  }
  assert.equal(reopened.status, "ready");
  assert.equal(reopened.environment.environmentId, environmentId);
  assert.equal(reopened.environment.dataGeneration, dataGeneration);
  assert(reopened.run.runId !== null && reopened.run.runId !== stoppedRunId);
  assert(reopened.run.address);
  assert(ownedRunId, "必须确认重开创建了本次拥有的新服务世代");
  await waitForProductReady(reopened.run.address, controller.signal);
  client = createCorpusClient(reopened.run.address, controller.signal);
  library = (await listAllAssetLibraries(client)).find(
    (candidate) => candidate.id === library.id,
  )!;
  assert(library);
  const reopenedAssets = await listAllAssets(client, library.id);
  for (const root of roots) {
    const asset = await assetForRoot(
      client,
      library,
      initialScan,
      root,
      reopenedAssets,
    );
    const parsed = await parsePostRecords(client, asset, root.post);
    assert.deepEqual(
      parsed.records.map((record) => record.id).toSorted(),
      initialRecordIds.get(root.post.sourceNativeAddress),
      "SQLite 重开后原来源记录 ID 必须保持",
    );
    assert.deepEqual(
      stableProjection(asset),
      stableByAddress.get(root.post.sourceNativeAddress),
    );
    assert.equal(
      await coverDigest(client, asset),
      coversBefore.get(root.post.sourceNativeAddress),
    );
  }
  const repeatStart = await client.startAssetLibraryScan(library.id);
  const repeatScan = await waitForAssetLibraryScan(
    client,
    repeatStart.parentExecutionId,
    15 * 60_000,
  );
  assert.equal(repeatScan.outcome, "no-change");
  assert(
    repeatScan.directories.every(
      (directory) =>
        directory.mode === "execute" && directory.outcome === "no-change",
    ),
    "重启后五个独立目录必须逐目录重扫并确认资料无变化",
  );
  assets = await listAllAssets(client, library.id);
  for (const root of roots) {
    const asset = await assetForRoot(client, library, repeatScan, root, assets);
    const parsed = await parsePostRecords(client, asset, root.post);
    assert.deepEqual(
      parsed.records.map((record) => record.id).toSorted(),
      initialRecordIds.get(root.post.sourceNativeAddress),
      "无变化重扫不得产生新来源记录",
    );
  }
  evidence["sqliteReopenAndNoChangeScan"] = {
    reopenedRunId: reopened.run.runId,
    outcome: repeatScan.outcome,
    directoryCount: repeatScan.directories.length,
  };
  await save();

  const refreshes: Record<string, unknown>[] = [];
  for (const root of roots) {
    controller.signal.throwIfAborted();
    const beforeAsset = (await listAllAssets(client, library.id)).find(
      (asset) => asset.id === postAssets.get(root.post.sourceNativeAddress)?.id,
    );
    assert(beforeAsset);
    const beforeRecords = await allSourceRecords(client, beforeAsset.id);
    const beforeIds = new Set(beforeRecords.map((record) => record.id));
    const startedRefresh = await client.startMetadataRefresh({
      subjectId: beforeAsset.id,
    });
    const execution = await waitForPublicExecution(
      client,
      startedRefresh.id,
      15 * 60_000,
    );
    assert.equal(execution.kind, "execution");
    assert.equal(execution.outcome, "accepted");
    assert.equal(execution.sourceRefreshRuns.length, 1);
    const refreshRun = execution.sourceRefreshRuns[0]!;
    assert.equal(refreshRun.outcome, "succeeded");
    assert.equal(refreshRun.requestedSelection.subjectId, beforeAsset.id);
    assert.equal(refreshRun.requestedSelection.sourceIdentity, "fanbox");
    assert.equal(
      refreshRun.requestedSelection.nativeAddress,
      `https://www.fanbox.cc/@${root.post.creatorId}/posts/${root.post.sourceNativeAddress}`,
    );
    sameStrings(
      refreshRun.scopes.map((scope) => scope.coverage.coverageId),
      ["fanbox.creator-post-summaries", "fanbox.post-detail"],
    );
    assert(
      refreshRun.scopes.every(
        (scope) =>
          scope.coverage.sourceIdentity === "fanbox" &&
          scope.coverage.nativeAddress ===
            refreshRun.requestedSelection.nativeAddress &&
          (scope.outcome === "applied" || scope.outcome === "unchanged"),
      ),
      "每帖刷新必须成功取得摘要和详情两类官方来源记录",
    );
    const afterRecords = await allSourceRecords(client, beforeAsset.id);
    const added = afterRecords.filter((record) => !beforeIds.has(record.id));
    assert.equal(added.length, 2, "每次刷新必须新增摘要和详情两份来源记录");
    sameStrings(
      added.map((record) => record.coverage?.id ?? ""),
      ["fanbox.creator-post-summaries", "fanbox.post-detail"],
    );
    for (const scope of refreshRun.scopes)
      assert(
        added.some((record) => record.id === scope.candidateSourceRecordId),
      );
    const updated = (await listAllAssets(client, library.id)).find(
      (asset) => asset.id === beforeAsset.id,
    );
    assert(updated, "来源刷新不得改变原资产身份");
    const updatedRecords = new Set(afterRecords.map((record) => record.id));
    const parsed = await parsePostRecords(client, updated, root.post);
    assertPostProjection(updated, root.post, updatedRecords);
    const cover = await coverDigest(client, updated);
    assert.equal(cover, coversBefore.get(root.post.sourceNativeAddress));
    refreshes.push({
      logicalRoot: root.post.logicalRoot,
      outcome: execution.outcome,
      refreshRunOutcome: refreshRun.outcome,
      scopes: refreshRun.scopes.map((scope) => ({
        coverageId: scope.coverage.coverageId,
        outcome: scope.outcome,
        recordAvailable: added.some(
          (record) => record.id === scope.candidateSourceRecordId,
        ),
      })),
      newSourceRecordCount: added.length,
      currentSourceRecordCount: parsed.records.length,
    });
    await save();
  }
  evidence["metadataRefreshes"] = refreshes;

  const afterDigests = await Promise.all(
    roots.map(({ realPath: directory }) => digestDirectory(directory)),
  );
  assert.deepEqual(
    afterDigests,
    materialsBefore,
    "完整真实资料在验收期间必须保持只读",
  );
  const filesystemAfter = await Promise.all(
    roots.map(({ realPath: directory }) =>
      captureRawFilesystemSnapshot(directory),
    ),
  );
  assert.deepEqual(
    filesystemAfter,
    filesystemBefore,
    "真实资料目录与文件元数据在验收期间必须保持只读",
  );
  evidence["materialsAfter"] = roots.map((root, index) => ({
    logicalRoot: root.post.logicalRoot,
    digest: afterDigests[index],
  }));
  outcome = "passed";
} catch (error) {
  if (error instanceof ConditionMissingError) {
    conditionMissing = error.items;
    outcome = "condition-missing";
    evidence["conditionMissing"] = conditionMissing;
  } else {
    businessFailure = safeFailure(error);
    outcome = controller.signal.aborted ? "cancelled" : "failed";
    evidence["failure"] = businessFailure;
  }
} finally {
  const cleanupErrors = evidence["cleanupErrors"] as {
    phase: string;
    failure: ReturnType<typeof safeFailure>;
  }[];
  try {
    await save();
  } catch (error) {
    cleanupErrors.push({ phase: "停止前保存", failure: safeFailure(error) });
  }
  if (
    ownedRunId !== undefined &&
    ownedEnvironmentId !== undefined &&
    ownedDataGeneration !== undefined
  ) {
    try {
      await stopOwnedRun({
        runId: ownedRunId,
        environmentId: ownedEnvironmentId,
        dataGeneration: ownedDataGeneration,
      });
      evidence["finalStop"] = "stopped-owned-run";
    } catch (error) {
      cleanupErrors.push({
        phase: "停止本次服务",
        failure: safeFailure(error),
      });
    }
  }
  if (
    roots !== undefined &&
    materialsBefore !== undefined &&
    filesystemBefore !== undefined
  ) {
    try {
      const after = await Promise.all(
        roots.map(({ realPath: directory }) => digestDirectory(directory)),
      );
      assert.deepEqual(after, materialsBefore, "真实资料必须保持只读");
      const filesystemAfter = await Promise.all(
        roots.map(({ realPath: directory }) =>
          captureRawFilesystemSnapshot(directory),
        ),
      );
      assert.deepEqual(
        filesystemAfter,
        filesystemBefore,
        "本地资料目录与文件元数据必须保持只读",
      );
      evidence["materialsAfter"] = roots.map((root, index) => ({
        logicalRoot: root.post.logicalRoot,
        digest: after[index],
      }));
    } catch (error) {
      cleanupErrors.push({
        phase: "核对资料只读",
        failure: safeFailure(error),
      });
    }
  }
  if (cleanupErrors.length > 0)
    outcome = controller.signal.aborted ? "cancelled" : "failed";
  evidence["cleanupErrors"] = cleanupErrors;
  evidence["status"] = outcome;
  evidence["finishedAt"] = new Date().toISOString();
  try {
    await save();
  } catch {
    outcome = "failed";
  }
}

if (outcome === "passed") {
  process.stdout.write("通过：FANBOX 五帖真实来源、重开与刷新验收\n");
} else if (outcome === "condition-missing") {
  process.stderr.write("条件缺失：FANBOX 五帖实况验收未执行完整。\n");
  process.exitCode = 2;
} else {
  process.stderr.write("未通过：FANBOX 五帖实况验收未完成。\n");
  process.exitCode = 1;
}
