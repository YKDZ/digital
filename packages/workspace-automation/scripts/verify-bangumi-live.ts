import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectEnvironment,
  startEnvironment,
  stopEnvironment,
  type StartOperationResult,
} from "@digital/environment";
import {
  PublicApiClientError,
  type PublicApiClient,
  type PublicAssetLibrary,
  type PublicAssetLibraryScan,
  type PublicCurrentAsset,
  type PublicExecutionInspection,
} from "@digital/public-api";

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

type EpisodeOracle = {
  readonly season: number;
  readonly seasonPosition: number;
  readonly continuousPosition: number;
  readonly sourceAddress: string;
};

type SeriesOracle = {
  readonly title: string;
  readonly subjects: readonly {
    readonly season: number;
    readonly sourceAddress: string;
  }[];
  readonly episodes: readonly EpisodeOracle[];
};

type BangumiOracle = {
  readonly bloom: SeriesOracle;
  readonly frieren: SeriesOracle;
};

type MaterialRoot = {
  readonly label: "Bloom" | "Frieren";
  readonly path: string;
  readonly realPath: string;
  readonly oracle: SeriesOracle;
};

type SourceRecordEvidence = {
  readonly kind: "source-record";
  readonly id: string;
  readonly status: "available" | "missing";
  readonly sourceIdentity?: string | undefined;
  readonly nativeAddress?: string | undefined;
  readonly mediaType?: string | undefined;
  readonly coverage?:
    | {
        readonly id: string;
        readonly completeness: "complete" | "incomplete";
        readonly authority: "official";
      }
    | undefined;
  readonly digest?: string | undefined;
};

type SafeFailureCause = {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly cause?: SafeFailureCause;
};

type SafeFailure = {
  readonly name: string;
  readonly message: string;
  readonly kind?: string;
  readonly status?: number;
  readonly cause?: SafeFailureCause;
};

export type BangumiLiveInput = {
  readonly workspacePath: string;
  readonly environment: string;
  readonly evidencePath: string;
  readonly bloomMaterialRoot: string;
  readonly frierenMaterialRoot: string;
  readonly signal?: AbortSignal;
};

export type BangumiLiveResult = {
  readonly outcome: "passed" | "condition-missing" | "failed" | "cancelled";
  readonly evidencePath?: string;
  readonly conditionMissing?: readonly string[];
  readonly failure?: SafeFailure;
  readonly cleanupErrors?: readonly {
    readonly phase: string;
    readonly failure: SafeFailure;
  }[];
};

class ConditionMissingError extends Error {
  readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super(items.join("；"));
    this.name = "ConditionMissingError";
    this.items = items;
  }
}

const libraryName = "Bangumi 番剧实况验收";
const workflowTimeoutMs = 15 * 60_000;
const episodeMediaPattern = /\.(?:mkv|mp4)$/iu;
const subtitlePattern = /\.(?:ass|srt|ssa|sup)$/iu;
const acceptanceSteps = [
  "独立复核预期、工作区和两组素材已核对",
  "真实环境已启动且 Bangumi 来源可用",
  "初次扫描、逐集身份、作品关系和当前来源记录已核验",
  "普通停止、SQLite 重开和无变化重扫已核验",
  "指定单集精确刷新及新来源记录已核验",
  "验收前后素材完整字节摘要一致",
] as const;

function asObject(value: unknown, label: string): Record<string, unknown> {
  assert.equal(
    typeof value === "object" && value !== null && !Array.isArray(value),
    true,
    `${label} 必须是对象`,
  );
  return value as Record<string, unknown>;
}

function asText(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} 必须是文本`);
  assert.notEqual((value as string).trim(), "", `${label} 不能为空`);
  return value as string;
}

function positivePair(
  value: unknown,
  label: string,
): readonly [number, number] {
  assert.ok(Array.isArray(value), `${label} 必须是数字范围`);
  assert.equal(value.length, 2, `${label} 必须有两个边界`);
  assert.ok(
    value.every((entry) => Number.isSafeInteger(entry) && entry > 0),
    `${label} 必须是正整数范围`,
  );
  return [value[0] as number, value[1] as number];
}

function addressList(value: unknown, label: string): readonly string[] {
  assert.ok(Array.isArray(value), `${label} 必须是地址列表`);
  return value.map((entry, index) =>
    asText(entry, `${label}[${String(index)}]`),
  );
}

function episodesFromSeason(
  value: unknown,
  season: number,
  label: string,
): readonly EpisodeOracle[] {
  const section = asObject(value, label);
  const local = positivePair(
    section.localEpisodeNumbers,
    `${label}.localEpisodeNumbers`,
  );
  const official = positivePair(
    section.officialEpisodeNumbers,
    `${label}.officialEpisodeNumbers`,
  );
  const seriesSort = positivePair(
    section.officialSeriesSort,
    `${label}.officialSeriesSort`,
  );
  const addresses = addressList(
    section.episodeSourceAddresses,
    `${label}.episodeSourceAddresses`,
  );
  const count = local[1] - local[0] + 1;
  assert.equal(official[1] - official[0] + 1, count);
  assert.equal(seriesSort[1] - seriesSort[0] + 1, count);
  assert.equal(addresses.length, count);
  return addresses.map((sourceAddress, index) => ({
    season,
    seasonPosition: official[0] + index,
    continuousPosition: seriesSort[0] + index,
    sourceAddress,
  }));
}

async function loadOracle(): Promise<BangumiOracle> {
  const oraclePath = fileURLToPath(
    import.meta.resolve("@digital/preview-corpus/live/reviewed-oracle.json"),
  );
  const raw = asObject(
    JSON.parse(await readFile(oraclePath, "utf8")) as unknown,
    "Bangumi 已复核预期",
  );
  const reviews = asObject(raw.reviews, "预期复核记录");
  const bangumiReview = asObject(reviews.bangumi, "Bangumi 复核记录");
  assert.equal(
    bangumiReview.status,
    "reviewed-current-official-source",
    "Bangumi 预期必须来自当前官方来源复核",
  );
  const video = asObject(raw.video, "预期作品");
  const bloomRaw = asObject(video.series, "终将成为你预期");
  const bloomSources = asObject(
    bloomRaw.sourceAssociations,
    "终将成为你来源身份",
  );
  const bloomEpisodes = addressList(
    bloomRaw.episodeSourceAddresses,
    "终将成为你剧集地址",
  );
  assert.equal(bloomRaw.seasonCount, 1);
  assert.equal(bloomRaw.episodeCount, bloomEpisodes.length);
  const bloom: SeriesOracle = {
    title: asText(bloomRaw.title, "终将成为你标题"),
    subjects: [
      {
        season: 1,
        sourceAddress: asText(
          bloomSources.Bangumi,
          "终将成为你 Bangumi 作品地址",
        ),
      },
    ],
    episodes: bloomEpisodes.map((sourceAddress, index) => ({
      season: 1,
      seasonPosition: index + 1,
      continuousPosition: index + 1,
      sourceAddress,
    })),
  };

  const frierenRaw = asObject(video.multiSeasonSeries, "葬送的芙莉莲预期");
  const frierenSources = asObject(
    frierenRaw.sourceAssociations,
    "葬送的芙莉莲来源身份",
  );
  const frieren: SeriesOracle = {
    title: asText(frierenRaw.title, "葬送的芙莉莲标题"),
    subjects: [
      {
        season: 1,
        sourceAddress: asText(
          frierenSources.BangumiSeason1,
          "葬送的芙莉莲第一季 Bangumi 作品地址",
        ),
      },
      {
        season: 2,
        sourceAddress: asText(
          frierenSources.BangumiSeason2,
          "葬送的芙莉莲第二季 Bangumi 作品地址",
        ),
      },
    ],
    episodes: [
      ...episodesFromSeason(frierenRaw.season1, 1, "葬送的芙莉莲第一季"),
      ...episodesFromSeason(frierenRaw.season2, 2, "葬送的芙莉莲第二季"),
    ],
  };
  assert.equal(bloom.episodes.length, 13);
  assert.equal(frieren.episodes.length, 38);
  return { bloom, frieren };
}

function parseEpisodePath(
  relativePaths: readonly string[],
  root: MaterialRoot,
): EpisodeOracle {
  const mediaPaths = relativePaths.filter((relative) =>
    episodeMediaPattern.test(relative),
  );
  assert.equal(mediaPaths.length, 1, "每个单集边界必须恰好含一个视频文件");
  for (const relative of relativePaths)
    if (!mediaPaths.includes(relative))
      assert.match(
        relative,
        subtitlePattern,
        "单集边界中的附加文件只能是已确认字幕格式",
      );
  const match =
    /^Season ([1-9]\d*)\/(.+) - S(\d{2})E(\d{2})(?: - 第 (\d+) 集)?(?: - .+)?\.(?:mkv|mp4)$/u.exec(
      mediaPaths[0]!,
    );
  assert.ok(match, "剧集文件必须使用经确认的季集命名格式");
  assert.equal(match[2], root.oracle.title, "剧集标题必须对应独立预期");
  const season = Number(match[1]);
  const seasonPosition = Number(match[4]);
  assert.equal(Number(match[3]), season, "目录季号与文件季号必须一致");
  if (match[5] !== undefined)
    assert.equal(
      Number(match[5]),
      seasonPosition,
      "中文集号必须与文件季集号一致",
    );
  const expected = root.oracle.episodes.find(
    (episode) =>
      episode.season === season && episode.seasonPosition === seasonPosition,
  );
  assert.ok(
    expected,
    `素材中的 S${String(season).padStart(2, "0")}E${String(seasonPosition).padStart(2, "0")} 不在独立预期中`,
  );
  return expected;
}

function resolvedFacts(
  asset: PublicCurrentAsset,
  property: string,
): readonly {
  readonly value: string;
  readonly sourceIdentity: string;
  readonly sourceRecordIds: readonly string[];
}[] {
  return asset.descriptions.flatMap((description) =>
    description.metadata
      .filter((metadata) => metadata.property === property)
      .flatMap((metadata) =>
        metadata.result.status === "resolved"
          ? metadata.result.values.map((value) => ({
              value: value.value,
              sourceIdentity: value.sourceIdentity,
              sourceRecordIds: value.sourceRecordIds,
            }))
          : [],
      ),
  );
}

function assertBangumiFact(
  asset: PublicCurrentAsset,
  property: string,
  expectedValue: string,
  currentRecordIds: ReadonlySet<string>,
): void {
  const facts = resolvedFacts(asset, property).filter(
    (fact) => fact.sourceIdentity === "bangumi",
  );
  assert.equal(facts.length, 1, `必须恰有一条 Bangumi ${property} 事实`);
  assert.equal(facts[0]!.value, expectedValue, `${property} 与复核预期不符`);
  assert.ok(
    facts[0]!.sourceRecordIds.length > 0 &&
      facts[0]!.sourceRecordIds.every((id) => currentRecordIds.has(id)),
    `${property} 必须引用当前公开 Bangumi 来源记录`,
  );
}

function exactSet(
  actual: readonly string[],
  expected: readonly string[],
): void {
  assert.deepEqual([...actual].toSorted(), [...expected].toSorted());
}

function expectedCoverage(oracle: BangumiOracle): ReadonlySet<string> {
  const coverage = new Set(["bangumi.subject-search"]);
  for (const root of [oracle.bloom, oracle.frieren]) {
    for (const subject of root.subjects) {
      coverage.add(`bangumi.subject:${subject.sourceAddress}`);
      coverage.add(`bangumi.relationships:${subject.sourceAddress}`);
      coverage.add(`bangumi.ordinary-episodes:${subject.sourceAddress}:0`);
    }
    for (const episode of root.episodes)
      coverage.add(`bangumi.episode:${episode.sourceAddress}`);
  }
  return coverage;
}

function expectedNativeAddress(coverageId: string): string | undefined {
  const episode = /^bangumi\.episode:(\d+)$/u.exec(coverageId)?.[1];
  if (episode !== undefined) return `https://bgm.tv/episode/${episode}`;
  const subject =
    /^bangumi\.(?:subject|relationships|ordinary-episodes):(\d+)/u.exec(
      coverageId,
    )?.[1];
  return subject === undefined
    ? undefined
    : `https://bgm.tv/subject/${subject}`;
}

async function allAssets(
  client: PublicApiClient,
  assetLibraryId: string,
): Promise<PublicCurrentAsset[]> {
  return [...(await listAllAssets(client, assetLibraryId))];
}

async function sourceRecordsForAsset(
  client: PublicApiClient,
  assetId: string,
): Promise<SourceRecordEvidence[]> {
  const items: SourceRecordEvidence[] = [];
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

async function readSourceRecordDigest(
  client: PublicApiClient,
  assetId: string,
  recordId: string,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  let offset = 0;
  let byteLength = 0;
  let complete = false;
  while (!complete) {
    const chunk = await client.readAssetSourceRecord(assetId, recordId, {
      offset,
      limit: 4096,
    });
    assert.equal(chunk.assetId, assetId);
    assert.equal(chunk.record.id, recordId);
    assert.equal(chunk.record.sourceIdentity, "bangumi");
    assert.equal(chunk.record.coverage.authority, "official");
    assert.equal(chunk.record.coverage.completeness, "complete");
    hash.update(chunk.content, "utf8");
    byteLength += Buffer.byteLength(chunk.content, "utf8");
    complete = chunk.complete;
    if (!complete) {
      assert.ok(
        chunk.nextOffset > offset,
        `Bangumi 来源记录 ${recordId} 的公开读取没有推进`,
      );
      offset = chunk.nextOffset;
    }
  }
  assert.ok(byteLength > 0, `Bangumi 来源记录 ${recordId} 内容不能为空`);
  return { byteLength, sha256: hash.digest("hex") };
}

function directoryForRoot(
  library: PublicAssetLibrary,
  root: MaterialRoot,
): PublicAssetLibrary["directories"][number] {
  const directory = library.directories.find((candidate) => {
    try {
      return path.resolve(candidate.path) === root.realPath;
    } catch {
      return false;
    }
  });
  assert.ok(directory, `${root.label} 根目录没有正式登记到资产库`);
  assert.equal(directory.status, "active");
  assert.equal(directory.reachable, true, `${root.label} 根目录当前不可达`);
  return directory;
}

async function inspectScanFiles(
  client: PublicApiClient,
  scan: PublicAssetLibraryScan,
  library: PublicAssetLibrary,
  roots: readonly MaterialRoot[],
  allowedOutcomes: readonly string[],
): Promise<
  Map<string, { readonly root: MaterialRoot; readonly assetId: string }>
> {
  type LocalFile = Awaited<
    ReturnType<PublicApiClient["inspectLocalIntake"]>
  >["files"][number];
  type LocalIntake = {
    readonly root: MaterialRoot;
    readonly files: ReadonlyMap<string, LocalFile>;
    readonly assets: ReadonlyMap<string, PublicCurrentAsset>;
  };
  const accepted = new Map<
    string,
    { readonly root: MaterialRoot; readonly assetId: string }
  >();
  const rootByRelativePath = new Map<string, LocalIntake>();
  assert.equal(scan.status, "completed", "资产库扫描必须完成");
  assert.equal(scan.directories.length, roots.length);
  for (const root of roots) {
    const registered = directoryForRoot(library, root);
    const snapshot = await client.inspectLocalIntake({
      assetLibraryId: library.id,
      directoryId: registered.id,
      parentExecutionId: scan.parentExecutionId,
    });
    assert.equal(snapshot.assetLibraryId, library.id);
    assert.equal(snapshot.directoryId, registered.id);
    assert.equal(snapshot.execution?.status, "completed");
    const files = new Map<string, LocalFile>();
    for (const file of snapshot.files) {
      assert.equal(file.problem, undefined, `${root.label} 本地材料检查失败`);
      assert.equal(files.has(file.relativePath), false, "公开本地材料路径重复");
      files.set(file.relativePath, file);
    }
    const intake: LocalIntake = {
      root,
      files,
      assets: new Map(snapshot.contents.map((asset) => [asset.id, asset])),
    };
    for (const relativePath of files.keys()) {
      if (!episodeMediaPattern.test(relativePath)) continue;
      assert.equal(
        rootByRelativePath.has(relativePath),
        false,
        `多个库目录包含相同相对材料路径：${relativePath}`,
      );
      rootByRelativePath.set(relativePath, intake);
    }
  }

  const observedRootLabels = new Set<string>();
  const expectedEpisodesByRoot = new Map(
    roots.map((root) => [
      root.label,
      new Map(
        root.oracle.episodes.map((episode) => [
          `${String(episode.season)}:${String(episode.seasonPosition)}`,
          episode,
        ]),
      ),
    ]),
  );
  const uniqueAssetIds = new Set<string>();
  for (const observed of scan.directories) {
    const directoryRootLabels = new Set<string>();
    for (const file of observed.files) {
      assert.ok(
        file.outcome !== undefined && allowedOutcomes.includes(file.outcome),
        `扫描到未接受的工作项：${String(file.outcome)}`,
      );
      const mediaPaths = file.relativePaths.filter((relative) =>
        episodeMediaPattern.test(relative),
      );
      assert.equal(
        mediaPaths.length,
        1,
        "每个扫描工作项必须恰好含一个视频文件",
      );
      const mediaPath = mediaPaths[0]!;
      const intake = rootByRelativePath.get(mediaPath);
      assert.ok(intake, `扫描结果不属于任何已登记目录：${mediaPath}`);
      const { root } = intake;
      directoryRootLabels.add(root.label);
      for (const relativePath of file.relativePaths) {
        assert.equal(
          intake.files.has(relativePath),
          true,
          `扫描工作项跨越了已登记目录：${relativePath}`,
        );
      }
      const episode = parseEpisodePath(file.relativePaths, root);
      const expected = expectedEpisodesByRoot.get(root.label)!;
      const key = `${String(episode.season)}:${String(episode.seasonPosition)}`;
      assert.equal(expected.has(key), true, `${root.label} 出现重复单集边界`);
      expected.delete(key);

      const localMedia = intake.files.get(mediaPath)!;
      assert.equal(
        localMedia.assetIds.length,
        1,
        `${root.label} 当前材料查询必须唯一回读单集资产身份`,
      );
      const assetId = localMedia.assetIds[0]!;
      assert.equal(
        intake.assets.has(assetId),
        true,
        `${root.label} 当前材料查询缺少资产详情`,
      );
      if (file.assetId !== undefined)
        assert.equal(
          file.assetId,
          assetId,
          "扫描提供的资产身份必须与公开当前材料查询一致",
        );
      assert.equal(
        uniqueAssetIds.has(assetId),
        false,
        "每个单集必须是独立 Digital Asset",
      );
      uniqueAssetIds.add(assetId);
      const address = `https://bgm.tv/episode/${episode.sourceAddress}`;
      assert.equal(accepted.has(address), false, `重复扫描到 ${address}`);
      accepted.set(address, { root, assetId });
    }
    assert.equal(
      directoryRootLabels.size,
      1,
      "每个扫描目录结果必须只包含一个已登记材料根",
    );
    const [rootLabel] = directoryRootLabels;
    assert.ok(rootLabel);
    assert.equal(
      observedRootLabels.has(rootLabel),
      false,
      `同一材料根出现在多个扫描目录结果中：${rootLabel}`,
    );
    observedRootLabels.add(rootLabel);
  }
  assert.equal(observedRootLabels.size, roots.length);
  for (const root of roots) {
    const expected = expectedEpisodesByRoot.get(root.label)!;
    assert.equal(
      expected.size,
      0,
      `${root.label} 缺少 ${String(expected.size)} 个独立预期单集`,
    );
  }
  assert.equal(
    accepted.size,
    roots.reduce((count, root) => count + root.oracle.episodes.length, 0),
  );
  return accepted;
}

function stableAsset(asset: PublicCurrentAsset): unknown {
  return {
    id: asset.id,
    sourceAssociations: [...asset.sourceAssociations].toSorted((a, b) =>
      `${a.sourceIdentity}:${a.nativeAddress}`.localeCompare(
        `${b.sourceIdentity}:${b.nativeAddress}`,
      ),
    ),
    recognitionSourceAssociation: asset.recognitionSourceAssociation,
    descriptions: asset.descriptions
      .map((description) => ({
        target: description.target,
        metadataUsageContext: description.metadataUsageContext,
        metadata: description.metadata
          .map((metadata) => ({
            property: metadata.property,
            result: metadata.result,
          }))
          .toSorted((a, b) => a.property.localeCompare(b.property)),
        artifactRoles: description.artifactRoles
          .map((role) => ({
            role: role.role,
            artifactId: role.artifactId,
            address: role.address,
          }))
          .toSorted((a, b) => a.role.localeCompare(b.role)),
      }))
      .toSorted((a, b) =>
        JSON.stringify(a.target).localeCompare(JSON.stringify(b.target)),
      ),
    relatedEntities: [...asset.relatedEntities].toSorted((a, b) =>
      `${a.sourceIdentity ?? ""}:${a.identityNamespace ?? ""}:${a.sourceKey ?? ""}`.localeCompare(
        `${b.sourceIdentity ?? ""}:${b.identityNamespace ?? ""}:${b.sourceKey ?? ""}`,
      ),
    ),
    relationships: asset.relationships
      .map((relationship) => ({
        type: relationship.type,
        participants: [...relationship.participants].toSorted((a, b) =>
          `${a.role}:${a.entityId}`.localeCompare(`${b.role}:${b.entityId}`),
        ),
        sourceRecordIds: [...relationship.sourceRecordIds].toSorted(),
        qualifiers: [...(relationship.qualifiers ?? [])].toSorted((a, b) =>
          `${a.key}:${a.value}`.localeCompare(`${b.key}:${b.value}`),
        ),
      }))
      .toSorted((a, b) =>
        `${a.type}:${JSON.stringify(a.participants)}`.localeCompare(
          `${b.type}:${JSON.stringify(b.participants)}`,
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
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}

function relationshipsForEpisode(input: {
  readonly asset: PublicCurrentAsset;
  readonly root: SeriesOracle;
  readonly episode: EpisodeOracle;
  readonly seasonSubjectId: string;
  readonly subjectIds: ReadonlyMap<string, string>;
  readonly currentRecordIds: ReadonlySet<string>;
}): void {
  const {
    asset,
    root,
    episode,
    seasonSubjectId,
    subjectIds,
    currentRecordIds,
  } = input;
  const bangumiEntities = asset.relatedEntities.filter(
    (entity) => entity.sourceIdentity === "bangumi",
  );
  exactSet(
    bangumiEntities.map(
      (entity) => `${entity.identityNamespace}:${entity.sourceKey}`,
    ),
    root.subjects.map((subject) => `bangumi.subject:${subject.sourceAddress}`),
  );
  for (const entity of bangumiEntities) {
    assert.equal(entity.identityNamespace, "bangumi.subject");
    assert.ok(entity.sourceKey);
  }
  const memberships = asset.relationships.filter(
    (relationship) =>
      relationship.type === "asset.membership" &&
      relationship.participants.some(
        (participant) =>
          participant.entityId === asset.id && participant.role === "asset",
      ) &&
      relationship.participants.some(
        (participant) =>
          participant.entityId === seasonSubjectId &&
          participant.role === "bangumi.subject.ordinary-episode",
      ),
  );
  assert.equal(memberships.length, 1, "每集必须隶属其确切 Bangumi 季作品");
  const membership = memberships[0]!;
  assert.deepEqual(
    [...(membership.qualifiers ?? [])]
      .map(({ key, value }) => ({ key, value }))
      .toSorted((a, b) => a.key.localeCompare(b.key)),
    [
      {
        key: "bangumi.episode.continuous-position",
        value: String(episode.continuousPosition),
      },
      {
        key: "bangumi.episode.season-position",
        value: String(episode.seasonPosition),
      },
    ].toSorted((a, b) => a.key.localeCompare(b.key)),
    "季内次序与全系列次序必须分别保留",
  );
  assert.ok(
    membership.sourceRecordIds.length > 0 &&
      membership.sourceRecordIds.every((id) => currentRecordIds.has(id)),
    "剧集成员关系必须引用当前来源记录",
  );
  const sequels = asset.relationships.filter(
    (relationship) => relationship.type === "bangumi.subject.related",
  );
  assert.equal(
    sequels.length,
    Math.max(0, root.subjects.length - 1),
    "作品季之间只能保留预期的续作关系",
  );
  if (root.subjects.length > 1) {
    const predecessorId = subjectIds.get(root.subjects[0]!.sourceAddress)!;
    const sequelId = subjectIds.get(root.subjects[1]!.sourceAddress)!;
    const sequel = sequels.find(
      (relationship) =>
        relationship.participants.some(
          (participant) =>
            participant.entityId === predecessorId &&
            participant.role === "bangumi.subject.predecessor",
        ) &&
        relationship.participants.some(
          (participant) =>
            participant.entityId === sequelId &&
            participant.role === "bangumi.subject.sequel",
        ),
    );
    assert.ok(sequel, "两季作品之间缺少精确的 Bangumi 续作关系");
    assert.ok(
      sequel.sourceRecordIds.length > 0 &&
        sequel.sourceRecordIds.every((id) => currentRecordIds.has(id)),
      "续作关系必须引用当前来源记录",
    );
  }
}

function assertEpisodeAsset(input: {
  readonly asset: PublicCurrentAsset;
  readonly root: SeriesOracle;
  readonly episode: EpisodeOracle;
  readonly currentRecordIds: ReadonlySet<string>;
  readonly subjectIds: ReadonlyMap<string, string>;
}): void {
  const { asset, root, episode, currentRecordIds, subjectIds } = input;
  const address = `https://bgm.tv/episode/${episode.sourceAddress}`;
  assert.deepEqual(asset.sourceAssociations, [
    { sourceIdentity: "bangumi", nativeAddress: address },
  ]);
  assert.deepEqual(asset.recognitionSourceAssociation, {
    sourceIdentity: "bangumi",
    nativeAddress: address,
  });
  assertBangumiFact(
    asset,
    "bangumi.episode.season-position",
    String(episode.seasonPosition),
    currentRecordIds,
  );
  assertBangumiFact(
    asset,
    "bangumi.episode.continuous-position",
    String(episode.continuousPosition),
    currentRecordIds,
  );
  const seasonSubject = root.subjects.find(
    (subject) => subject.season === episode.season,
  );
  const seasonSubjectId =
    seasonSubject === undefined
      ? undefined
      : subjectIds.get(seasonSubject.sourceAddress);
  assert.ok(seasonSubjectId, `缺少第 ${String(episode.season)} 季作品身份`);
  relationshipsForEpisode({
    asset,
    root,
    episode,
    seasonSubjectId,
    subjectIds,
    currentRecordIds,
  });
}

async function verifyRelatedSubjects(input: {
  readonly client: PublicApiClient;
  readonly roots: readonly MaterialRoot[];
  readonly subjectIds: ReadonlyMap<string, string>;
  readonly assets: readonly PublicCurrentAsset[];
  readonly signal: AbortSignal;
}): Promise<readonly Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  for (const root of input.roots) {
    for (const subject of root.oracle.subjects) {
      const subjectId = input.subjectIds.get(subject.sourceAddress);
      assert.ok(subjectId);
      const visitKey = `${root.label}:${subjectId}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const inspection = await input.client.inspectRelatedEntity(subjectId);
      assert.equal(inspection.entity.sourceIdentity, "bangumi");
      assert.equal(inspection.entity.identityNamespace, "bangumi.subject");
      assert.equal(inspection.entity.sourceKey, subject.sourceAddress);
      assert.ok(
        inspection.relationships.some((relationship) =>
          relationship.sources.some(
            (source) =>
              source.sourceIdentity === "bangumi" &&
              source.nativeAddress ===
                `https://bgm.tv/subject/${subject.sourceAddress}`,
          ),
        ),
        "公开作品关系必须保留确切 Bangumi subject 地址",
      );
      const names = inspection.metadata.filter(
        (metadata) =>
          metadata.property === "bangumi.subject.name.zh-hans" &&
          metadata.sourceIdentity === "bangumi",
      );
      assert.equal(names.length, 1, "Bangumi 作品必须保留官方中文标题");
      if (subject.season === 1)
        assert.equal(names[0]!.value, root.oracle.title);
      const descriptions = inspection.metadata.filter(
        (metadata) =>
          metadata.property === "bangumi.subject.description" &&
          metadata.sourceIdentity === "bangumi",
      );
      assert.equal(descriptions.length, 1, "Bangumi 作品必须保留官方简介");
      assert.notEqual(descriptions[0]!.value.trim(), "");

      const coverAsset =
        inspection.accepted.find((asset) =>
          hasArtifactRole(asset, "asset.primary-cover"),
        ) ??
        input.assets.find(
          (asset) =>
            asset.relatedEntities.some((entity) => entity.id === subjectId) &&
            hasArtifactRole(asset, "asset.primary-cover"),
        );
      assert.ok(coverAsset, "Bangumi 作品必须公开正式封面角色");
      const coverAddress = artifactRoleAddress(
        coverAsset,
        "asset.primary-cover",
      );
      assert.ok(coverAddress);
      const digest = coverAddress.split("/").at(-1);
      assert.ok(digest);
      const cover = await input.client.readManagedArtifact(digest);
      assert.equal(cover.status, 200);
      assert.ok(
        ["image/jpeg", "image/png"].includes(
          cover.headers.get("content-type")?.split(";", 1)[0] ?? "",
        ),
        "Bangumi 封面必须是正式管理的 JPEG 或 PNG",
      );
      const coverBytes = new Uint8Array(await cover.arrayBuffer());
      assert.ok(coverBytes.length > 0);
      input.signal.throwIfAborted();
      results.push({
        season: subject.season,
        sourceAddress: subject.sourceAddress,
        entityId: subjectId,
        title: names[0]!.value,
        descriptionByteLength: Buffer.byteLength(descriptions[0]!.value),
        cover: {
          status: cover.status,
          mediaType: cover.headers.get("content-type")?.split(";", 1)[0],
          byteLength: coverBytes.length,
          sha256: createHash("sha256").update(coverBytes).digest("hex"),
        },
      });
    }
  }
  return results;
}

function safeMessage(rawMessage: string): string {
  return rawMessage
    .replace(
      /(authorization|cookie|token|secret|code)=([^&\s]+)/giu,
      "$1=[已省略]",
    )
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [已省略]");
}

function safeFailureCause(
  error: unknown,
  depth = 0,
): SafeFailureCause | undefined {
  if (!(error instanceof Error)) return undefined;
  const code =
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : undefined;
  const cause =
    depth === 0 ? safeFailureCause(error.cause, depth + 1) : undefined;
  return {
    name: error.name,
    message: safeMessage(error.message),
    ...(code === undefined ? {} : { code }),
    ...(cause === undefined ? {} : { cause }),
  };
}

function safeFailure(error: unknown): SafeFailure {
  const name = error instanceof Error ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error ? safeFailureCause(error.cause) : undefined;
  if (error instanceof PublicApiClientError)
    return {
      name,
      message: safeMessage(rawMessage),
      kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(cause === undefined ? {} : { cause }),
    };
  return {
    name,
    message: safeMessage(rawMessage),
    ...(cause === undefined ? {} : { cause }),
  };
}

function startOperationEvidence(
  started: StartOperationResult,
): Record<string, unknown> {
  return {
    status: started.status,
    environment: {
      environmentId: started.environment.environmentId,
      dataGeneration: started.environment.dataGeneration,
    },
    run: {
      runId: started.run.runId,
      state: started.run.state,
      processLiveness: started.run.processLiveness,
      serviceReady: started.run.serviceReady,
      address: started.run.address,
      port: started.run.port,
    },
    failure:
      started.failure === undefined
        ? undefined
        : {
            stage: started.failure.stage,
            message: safeFailure(started.failure.message).message,
            exitCode: started.failure.exitCode,
          },
    cleanup: {
      state: started.cleanup.state,
      errors: started.cleanup.errors.map(
        (message) => safeFailure(message).message,
      ),
    },
  };
}

function ownedRunFromStart(input: {
  readonly started: StartOperationResult;
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
  const { started } = input;
  const mayOwnRun =
    started.status === "ready" ||
    (started.status === "failed" && started.cleanup.state === "unknown");
  if (
    !mayOwnRun ||
    started.run.runId === null ||
    started.run.runId === input.previousRunId ||
    started.environment.environmentId !== input.environmentId ||
    started.environment.dataGeneration !== input.dataGeneration
  )
    return undefined;
  return {
    runId: started.run.runId,
    environmentId: input.environmentId,
    dataGeneration: input.dataGeneration,
  };
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function resolveEvidencePath(
  workspacePath: string,
  evidenceArgument: string,
): string {
  if (evidenceArgument.trim().length === 0)
    throw new ConditionMissingError(["证据文件相对路径为空"]);
  if (path.isAbsolute(evidenceArgument))
    throw new ConditionMissingError(["证据文件必须位于工作区内"]);
  const resolved = path.resolve(workspacePath, evidenceArgument);
  if (!isWithin(workspacePath, resolved))
    throw new ConditionMissingError(["证据文件必须位于工作区内"]);
  return resolved;
}

async function assertEvidenceOutsideInputDirectories(
  evidencePath: string,
  inputDirectories: readonly string[],
): Promise<void> {
  for (const candidate of inputDirectories) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const directory = await realpath(candidate);
      if (isWithin(directory, evidencePath))
        throw new ConditionMissingError(["证据文件不能写入素材根目录"]);
    } catch (error) {
      if (error instanceof ConditionMissingError) throw error;
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
}

function assertDisjoint(left: string, right: string, label: string): void {
  if (isWithin(left, right) || isWithin(right, left))
    throw new ConditionMissingError([`${label}路径不能重叠`]);
}

async function resolveMaterialRoot(
  label: MaterialRoot["label"],
  argument: string,
  oracle: SeriesOracle,
): Promise<MaterialRoot> {
  assert.ok(path.isAbsolute(argument), `${label} 素材根必须是绝对路径`);
  const rootPath = await realpath(argument);
  assert.equal((await stat(rootPath)).isDirectory(), true, `${label} 不是目录`);
  return { label, path: argument, realPath: rootPath, oracle };
}

async function assertEvidenceDestination(
  workspacePath: string,
  evidenceArgument: string,
  roots: readonly MaterialRoot[],
): Promise<string> {
  const resolved = resolveEvidencePath(workspacePath, evidenceArgument);
  for (const root of roots)
    if (isWithin(root.realPath, resolved))
      throw new ConditionMissingError(["证据文件不能写入素材根目录"]);
  let existingParent = path.dirname(resolved);
  while (true) {
    try {
      const canonical = await realpath(existingParent);
      if (!isWithin(workspacePath, canonical))
        throw new ConditionMissingError(["证据目录不能越出工作区"]);
      break;
    } catch (error) {
      if (error instanceof ConditionMissingError) throw error;
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
      const nextParent = path.dirname(existingParent);
      if (nextParent === existingParent)
        throw new ConditionMissingError(["证据目录无法定位"]);
      existingParent = nextParent;
    }
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const parent = await realpath(path.dirname(resolved));
  if (!isWithin(workspacePath, parent))
    throw new ConditionMissingError(["证据目录不能越出工作区"]);
  try {
    if ((await lstat(resolved)).isSymbolicLink())
      throw new ConditionMissingError(["证据文件不能是符号链接"]);
  } catch (error) {
    if (error instanceof ConditionMissingError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return resolved;
}

function safeSnapshot(asset: PublicCurrentAsset): unknown {
  return stableAsset(asset);
}

async function verifyCurrentSourceLineage(input: {
  readonly client: PublicApiClient;
  readonly assets: readonly PublicCurrentAsset[];
  readonly expectedCoverage: ReadonlySet<string>;
  readonly signal: AbortSignal;
}): Promise<{
  readonly recordIdsByAsset: ReadonlyMap<string, ReadonlySet<string>>;
  readonly coverage: readonly string[];
  readonly recordsRead: readonly Record<string, unknown>[];
}> {
  const recordsByAsset = new Map<string, SourceRecordEvidence[]>();
  const recordIdsByAsset = new Map<string, ReadonlySet<string>>();
  const allBangumiRecords = new Map<string, SourceRecordEvidence>();
  for (const asset of input.assets) {
    input.signal.throwIfAborted();
    const records = await sourceRecordsForAsset(input.client, asset.id);
    recordsByAsset.set(asset.id, records);
    const localBangumi = records.filter(
      (record) => record.sourceIdentity === "bangumi",
    );
    for (const record of localBangumi) {
      assert.equal(record.status, "available");
      assert.ok(record.nativeAddress !== undefined);
      assert.ok(record.coverage);
      assert.equal(record.coverage.authority, "official");
      assert.equal(record.coverage.completeness, "complete");
      const expectedAddress = expectedNativeAddress(record.coverage.id);
      if (expectedAddress !== undefined)
        assert.equal(record.nativeAddress, expectedAddress);
      const previous = allBangumiRecords.get(record.id);
      if (previous !== undefined)
        assert.deepEqual(record, previous, "同一来源记录的公开证据必须一致");
      allBangumiRecords.set(record.id, record);
    }
    recordIdsByAsset.set(
      asset.id,
      new Set(localBangumi.map((record) => record.id)),
    );
  }
  assert.ok(allBangumiRecords.size > 0, "真实扫描必须保留 Bangumi 来源记录");
  const observedCoverage = new Set(
    [...allBangumiRecords.values()].map((record) => record.coverage!.id),
  );
  exactSet([...observedCoverage], [...input.expectedCoverage]);
  const readRecords: Record<string, unknown>[] = [];
  const readIds = new Set<string>();
  for (const [assetId, records] of recordsByAsset) {
    for (const record of records) {
      if (
        record.sourceIdentity !== "bangumi" ||
        record.status !== "available" ||
        readIds.has(record.id)
      )
        continue;
      input.signal.throwIfAborted();
      const content = await readSourceRecordDigest(
        input.client,
        assetId,
        record.id,
      );
      readIds.add(record.id);
      readRecords.push({
        id: record.id,
        nativeAddress: record.nativeAddress,
        coverage: record.coverage!.id,
        digest: record.digest,
        readContent: content,
      });
    }
  }
  return {
    recordIdsByAsset,
    coverage: [...observedCoverage].toSorted(),
    recordsRead: readRecords,
  };
}

async function findOrCreateLibrary(input: {
  readonly client: PublicApiClient;
  readonly roots: readonly MaterialRoot[];
}): Promise<{
  readonly library: PublicAssetLibrary;
  readonly created: boolean;
}> {
  const existing = await listAllAssetLibraries(input.client);
  const sameName = existing.find(
    (library) => library.displayName === libraryName,
  );
  if (sameName !== undefined) {
    const configuredPaths = sameName.directories
      .filter((directory) => directory.status === "active")
      .map((directory) => path.resolve(directory.path));
    if (
      JSON.stringify([...configuredPaths].toSorted()) !==
      JSON.stringify(input.roots.map((root) => root.realPath).toSorted())
    )
      throw new ConditionMissingError([
        "同名资产库已指向其他目录；请使用专用空闲环境",
      ]);
    if (
      JSON.stringify([...sameName.recognitionProfileIds].toSorted()) !==
        JSON.stringify(["anime"]) ||
      JSON.stringify([...sameName.sourceIdentities].toSorted()) !==
        JSON.stringify(["bangumi"])
    )
      throw new ConditionMissingError([
        "同名资产库使用了不同识别或来源配置；请使用专用空闲环境",
      ]);
    for (const root of input.roots) directoryForRoot(sameName, root);
    return { library: sameName, created: false };
  }
  for (const library of existing)
    for (const directory of library.directories) {
      if (directory.status !== "active") continue;
      let registeredPath: string;
      try {
        registeredPath = await realpath(directory.path);
      } catch {
        registeredPath = path.resolve(directory.path);
      }
      for (const root of input.roots)
        if (
          isWithin(registeredPath, root.realPath) ||
          isWithin(root.realPath, registeredPath)
        )
          throw new ConditionMissingError([
            `素材根已属于其他资产库 ${library.displayName}`,
          ]);
    }
  const options = await input.client.listAssetLibraryOptions();
  assert.ok(
    options.recognitionProfiles.some(({ id }) => id === "anime"),
    "正式产品未提供 anime 识别配置",
  );
  assert.ok(
    options.sources.some(({ id }) => id === "bangumi"),
    "正式产品未提供 Bangumi 来源",
  );
  const library = await input.client.saveAssetLibrary({
    displayName: libraryName,
    directories: input.roots.map((root) => root.realPath),
    recognitionProfileIds: ["anime"],
    sourceIdentities: ["bangumi"],
  });
  exactSet(library.recognitionProfileIds, ["anime"]);
  exactSet(library.sourceIdentities, ["bangumi"]);
  for (const root of input.roots) directoryForRoot(library, root);
  return { library, created: true };
}

async function inspectOwnedRun(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly runId: string;
}): Promise<Awaited<ReturnType<typeof inspectEnvironment>>> {
  const current = await inspectEnvironment({
    workspacePath: input.workspacePath,
    environment: input.environment,
  });
  assert.equal(current.status, "ok");
  assert.equal(
    current.run.runId,
    input.runId,
    "环境当前运行世代已变化；拒绝停止或替换他人服务",
  );
  return current;
}

async function stopOwnedRun(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly runId: string;
  readonly expectedEnvironmentId: string;
  readonly expectedDataGeneration: string | null;
}): Promise<Awaited<ReturnType<typeof inspectEnvironment>>> {
  const before = await inspectOwnedRun(input);
  const stopped = await stopEnvironment({
    workspacePath: input.workspacePath,
    environment: input.environment,
  });
  assert.ok(
    stopped.status === "stopped" || stopped.status === "already-stopped",
    `无法确认自有环境已停止：${stopped.status}`,
  );
  const after = await inspectEnvironment({
    workspacePath: input.workspacePath,
    environment: input.environment,
  });
  assert.equal(after.status, "ok");
  assert.equal(after.state, "prepared");
  assert.equal(after.environment.environmentId, input.expectedEnvironmentId);
  assert.equal(
    after.environment.dataGeneration,
    input.expectedDataGeneration,
    "SQLite 数据世代在普通停止后发生变化",
  );
  assert.ok(
    after.run.processLiveness === "exited" ||
      after.run.processLiveness === "absent",
    "自有服务停止后必须确认进程已退出",
  );
  assert.ok(after.run.state === "stopped" || after.run.state === "absent");
  assert.equal(
    before.environment.environmentId,
    after.environment.environmentId,
  );
  return after;
}

function rootEvidence(
  root: MaterialRoot,
  digest: string,
): Record<string, unknown> {
  return {
    label: root.label,
    directoryName: path.basename(root.realPath),
    digest,
  };
}

async function runBangumiLiveWithEvidence(
  input: BangumiLiveInput,
): Promise<BangumiLiveResult> {
  const environmentArg = input.environment;
  const evidenceArg = input.evidencePath;
  const bloomArg = input.bloomMaterialRoot;
  const frierenArg = input.frierenMaterialRoot;
  if (!path.isAbsolute(input.workspacePath))
    throw new ConditionMissingError([
      "工作区必须通过 DIGITAL_AUTOMATION_WORKSPACE 提供绝对路径",
    ]);
  let workspacePath: string;
  try {
    workspacePath = await realpath(input.workspacePath);
    if (!(await stat(workspacePath)).isDirectory())
      throw new Error("workspace is not a directory");
  } catch {
    throw new ConditionMissingError([
      "DIGITAL_AUTOMATION_WORKSPACE 必须是现存目录",
    ]);
  }
  const evidencePath = resolveEvidencePath(workspacePath, evidenceArg);
  await assertEvidenceOutsideInputDirectories(evidencePath, [
    bloomArg,
    frierenArg,
  ]);
  await assertEvidenceDestination(workspacePath, evidenceArg, []);
  const evidence: Record<string, unknown> = {
    formatVersion: 1,
    startedAt: new Date().toISOString(),
    environment: environmentArg,
    materials: [
      { label: "Bloom", directoryName: path.basename(bloomArg!) },
      { label: "Frieren", directoryName: path.basename(frierenArg!) },
    ],
    privateCredentialsRead: false,
    oauthCreated: false,
    executedSteps: [] as string[],
    outcome: "running",
    cleanupErrors: [] as {
      readonly phase: string;
      readonly failure: SafeFailure;
    }[],
  };
  const save = async (): Promise<void> => {
    await writeFile(
      evidencePath,
      `${JSON.stringify(evidence, undefined, 2)}\n`,
      {
        mode: 0o600,
      },
    );
  };
  const executedSteps = evidence["executedSteps"] as string[];
  const completeStep = (step: (typeof acceptanceSteps)[number]): void => {
    if (!executedSteps.includes(step)) executedSteps.push(step);
  };
  const signalController = new AbortController();
  const abortFromCaller = (): void =>
    signalController.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const onInterrupt = (signal: NodeJS.Signals): void => {
    signalController.abort(new Error(`收到 ${signal}`));
  };
  const onSigint = (): void => onInterrupt("SIGINT");
  const onSigterm = (): void => onInterrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const roots: MaterialRoot[] = [];
  let oracle: BangumiOracle | undefined;
  let conditionMissing: readonly string[] | undefined;
  let ownedRunId: string | undefined;
  let ownedEnvironmentId: string | undefined;
  let ownedDataGeneration: string | null | undefined;
  let environmentId: string | undefined;
  let dataGeneration: string | null = null;
  let businessFailure: SafeFailure | undefined;
  let businessPassed = false;
  let finalOutcome: BangumiLiveResult["outcome"] = "failed";
  let beforeDigests: readonly string[] | undefined;
  let client: PublicApiClient | undefined;
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(environmentArg!))
      throw new ConditionMissingError(["环境名格式无效"]);
    await save();
    try {
      oracle = await loadOracle();
    } catch {
      throw new ConditionMissingError([
        "公开的 Bangumi 当前官方来源复核预期不可用",
      ]);
    }
    try {
      roots.push(await resolveMaterialRoot("Bloom", bloomArg!, oracle.bloom));
    } catch {
      throw new ConditionMissingError(["Bloom 素材根必须存在且是可读目录"]);
    }
    try {
      roots.push(
        await resolveMaterialRoot("Frieren", frierenArg!, oracle.frieren),
      );
    } catch {
      throw new ConditionMissingError(["Frieren 素材根必须存在且是可读目录"]);
    }
    assertDisjoint(
      roots[0]!.realPath,
      roots[1]!.realPath,
      "Bloom 与 Frieren 素材根",
    );
    await assertEvidenceDestination(workspacePath, evidenceArg!, roots);
    evidence["oracle"] = {
      status: "reviewed-current-official-source",
      bloomEpisodes: oracle.bloom.episodes.length,
      frierenEpisodes: oracle.frieren.episodes.length,
      reviewedCoverage: [...expectedCoverage(oracle)].toSorted(),
    };
    completeStep(acceptanceSteps[0]);
    beforeDigests = await Promise.all(
      roots.map(({ realPath }) => digestDirectory(realPath)),
    );
    evidence["materialsBefore"] = roots.map((root, index) =>
      rootEvidence(root, beforeDigests![index]!),
    );
    evidence["materials"] = roots.map((root) => ({
      label: root.label,
      directoryName: path.basename(root.realPath),
    }));
    await save();

    const prior = await inspectEnvironment({
      workspacePath,
      environment: environmentArg!,
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
        "专用真实来源环境必须在验收开始前已停止；脚本不会接管调用方进程",
      ]);
    environmentId = prior.environment.environmentId;
    dataGeneration = prior.environment.dataGeneration;

    signalController.signal.throwIfAborted();
    const started = await startEnvironment({
      workspacePath,
      environment: environmentArg!,
      runtime: "production",
      signal: signalController.signal,
    });
    const initialOwnedRun = ownedRunFromStart({
      started,
      previousRunId: prior.run.runId,
      environmentId,
      dataGeneration,
    });
    const startEvidence = startOperationEvidence(started);
    startEvidence["cleanupDisposition"] =
      started.cleanup.state !== "unknown"
        ? "start-result-recorded"
        : initialOwnedRun === undefined
          ? "unknown-retained-because-run-ownership-could-not-be-proven"
          : "public-stop-will-be-attempted-for-owned-run";
    evidence["start"] = startEvidence;
    if (started.status === "already-ready")
      throw new ConditionMissingError([
        "环境在启动前置检查后被其他进程启动；脚本未接管该服务",
      ]);
    if (initialOwnedRun !== undefined) {
      ownedRunId = initialOwnedRun.runId;
      ownedEnvironmentId = initialOwnedRun.environmentId;
      ownedDataGeneration = initialOwnedRun.dataGeneration;
    }
    if (started.status !== "ready") {
      const detail =
        started.failure === undefined
          ? `环境启动未成功：${started.status}`
          : `环境启动失败（阶段 ${started.failure.stage}）：${started.failure.message}`;
      throw new Error(detail);
    }
    assert.equal(started.environment.environmentId, environmentId);
    assert.equal(started.environment.dataGeneration, dataGeneration);
    assert.ok(started.run.runId);
    assert.ok(started.run.address);
    await save();
    await waitForProductReady(started.run.address, signalController.signal);
    client = createCorpusClient(started.run.address, signalController.signal);
    const connection = await client.getSourceConnection("bangumi");
    evidence["bangumiConnection"] = {
      credentialStatus: connection.credentialStatus,
      availability: connection.availability,
      verifiedAt: connection.verifiedAt,
    };
    if (
      connection.credentialStatus !== "configured" ||
      connection.availability !== "available"
    )
      throw new ConditionMissingError([
        "指定 real 环境尚无可用的 Bangumi 授权连接",
      ]);
    completeStep(acceptanceSteps[1]);
    const libraryResult = await findOrCreateLibrary({ client, roots });
    const library = libraryResult.library;
    evidence["assetLibrary"] = {
      id: library.id,
      displayName: library.displayName,
      created: libraryResult.created,
      directoryCount: library.directories.length,
      recognitionProfileIds: library.recognitionProfileIds,
      sourceIdentities: library.sourceIdentities,
    };
    const initialScanStart = await client.startAssetLibraryScan(library.id);
    evidence["initialScanExecutionId"] = initialScanStart.parentExecutionId;
    const initialScan = await waitForAssetLibraryScan(
      client,
      initialScanStart.parentExecutionId,
      workflowTimeoutMs,
    );
    evidence["initialScan"] = {
      status: initialScan.status,
      outcome: initialScan.outcome,
      directoryCount: initialScan.directories.length,
    };
    const expectedInitialOutcomes = libraryResult.created
      ? ["accepted"]
      : ["accepted", "no-change"];
    const initialEpisodes = await inspectScanFiles(
      client,
      initialScan,
      library,
      roots,
      expectedInitialOutcomes,
    );
    assert.ok(
      libraryResult.created
        ? initialScan.outcome === "accepted"
        : initialScan.outcome === "accepted" ||
            initialScan.outcome === "no-change",
      "初次扫描必须完整接受新材料或复用已有资产",
    );
    const currentAssets = await allAssets(client, library.id);
    assert.equal(currentAssets.length, initialEpisodes.size);
    const assetsById = new Map(currentAssets.map((asset) => [asset.id, asset]));
    const subjectIds = new Map<string, string>();
    for (const root of roots) {
      for (const subject of root.oracle.subjects) {
        const matches = currentAssets.flatMap((asset) =>
          asset.relatedEntities.filter(
            (entity) =>
              entity.sourceIdentity === "bangumi" &&
              entity.identityNamespace === "bangumi.subject" &&
              entity.sourceKey === subject.sourceAddress,
          ),
        );
        const unique = new Map(matches.map((entity) => [entity.id, entity]));
        assert.equal(unique.size, 1, "每个官方 subject 必须对应唯一来源实体");
        const entity = unique.values().next().value as
          | (typeof matches)[number]
          | undefined;
        assert.ok(entity);
        subjectIds.set(subject.sourceAddress, entity.id);
      }
      for (const episode of root.oracle.episodes) {
        const address = `https://bgm.tv/episode/${episode.sourceAddress}`;
        const found = initialEpisodes.get(address);
        assert.ok(found);
        const asset = assetsById.get(found.assetId);
        assert.ok(asset, `公共资产列表缺少 ${address}`);
        const records = await sourceRecordsForAsset(client, asset.id);
        const bangumiIds = new Set(
          records
            .filter(
              (record) =>
                record.kind === "source-record" &&
                record.status === "available" &&
                record.sourceIdentity === "bangumi",
            )
            .map((record) => record.id),
        );
        assertEpisodeAsset({
          asset,
          root: root.oracle,
          episode,
          currentRecordIds: bangumiIds,
          subjectIds,
        });
      }
    }
    const sourceLineage = await verifyCurrentSourceLineage({
      client,
      assets: currentAssets,
      expectedCoverage: expectedCoverage(oracle),
      signal: signalController.signal,
    });
    evidence["sourceLineage"] = {
      coverage: sourceLineage.coverage,
      coverageCount: sourceLineage.coverage.length,
      uniqueRecordCount: sourceLineage.recordsRead.length,
      recordsRead: sourceLineage.recordsRead,
    };
    const subjectResults = await verifyRelatedSubjects({
      client,
      roots,
      subjectIds,
      assets: currentAssets,
      signal: signalController.signal,
    });
    evidence["subjects"] = subjectResults;
    evidence["initialAssets"] = currentAssets
      .map(safeSnapshot)
      .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    completeStep(acceptanceSteps[2]);
    await save();

    const stopped = await stopOwnedRun({
      workspacePath,
      environment: environmentArg!,
      runId: ownedRunId!,
      expectedEnvironmentId: ownedEnvironmentId!,
      expectedDataGeneration: ownedDataGeneration ?? null,
    });
    evidence["stoppedBeforeReopen"] = {
      state: stopped.state,
      processLiveness: stopped.run.processLiveness,
      runId: stopped.run.runId,
    };
    ownedRunId = undefined;
    ownedEnvironmentId = undefined;
    ownedDataGeneration = undefined;
    const reopenedStart = await startEnvironment({
      workspacePath,
      environment: environmentArg!,
      runtime: "production",
      signal: signalController.signal,
    });
    const reopenedOwnedRun = ownedRunFromStart({
      started: reopenedStart,
      previousRunId: stopped.run.runId,
      environmentId,
      dataGeneration,
    });
    const reopenedStartEvidence = startOperationEvidence(reopenedStart);
    reopenedStartEvidence["cleanupDisposition"] =
      reopenedStart.cleanup.state !== "unknown"
        ? "start-result-recorded"
        : reopenedOwnedRun === undefined
          ? "unknown-retained-because-run-ownership-could-not-be-proven"
          : "public-stop-will-be-attempted-for-owned-run";
    evidence["reopenedStart"] = reopenedStartEvidence;
    if (reopenedStart.status === "already-ready")
      throw new ConditionMissingError([
        "重开前环境被其他进程启动；脚本没有接管该服务",
      ]);
    if (reopenedOwnedRun !== undefined) {
      ownedRunId = reopenedOwnedRun.runId;
      ownedEnvironmentId = reopenedOwnedRun.environmentId;
      ownedDataGeneration = reopenedOwnedRun.dataGeneration;
    }
    if (reopenedStart.status !== "ready") {
      const detail =
        reopenedStart.failure === undefined
          ? `环境重开未成功：${reopenedStart.status}`
          : `环境重开失败（阶段 ${reopenedStart.failure.stage}）：${reopenedStart.failure.message}`;
      throw new Error(detail);
    }
    assert.equal(reopenedStart.environment.environmentId, environmentId);
    assert.equal(reopenedStart.environment.dataGeneration, dataGeneration);
    assert.ok(reopenedStart.run.runId);
    assert.ok(reopenedStart.run.address);
    await save();
    await waitForProductReady(
      reopenedStart.run.address,
      signalController.signal,
    );
    client = createCorpusClient(
      reopenedStart.run.address,
      signalController.signal,
    );
    const reopenedScanStart = await client.startAssetLibraryScan(library.id);
    evidence["reopenedScanExecutionId"] = reopenedScanStart.parentExecutionId;
    const reopenedScan = await waitForAssetLibraryScan(
      client,
      reopenedScanStart.parentExecutionId,
      workflowTimeoutMs,
    );
    assert.equal(reopenedScan.outcome, "no-change");
    const reopenedEpisodes = await inspectScanFiles(
      client,
      reopenedScan,
      library,
      roots,
      ["no-change"],
    );
    assert.deepEqual(
      [...reopenedEpisodes.entries()]
        .map(([address, result]) => [address, result.assetId])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [...initialEpisodes.entries()]
        .map(([address, result]) => [address, result.assetId])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const reopenedAssets = await allAssets(client, library.id);
    assert.equal(reopenedAssets.length, currentAssets.length);
    assert.deepEqual(
      reopenedAssets
        .map(safeSnapshot)
        .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      currentAssets
        .map(safeSnapshot)
        .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      "普通停止、SQLite 重开与无变化扫描必须保留当前身份、关系和来源记录",
    );
    evidence["reopenedScan"] = {
      status: reopenedScan.status,
      outcome: reopenedScan.outcome,
      assetCount: reopenedAssets.length,
      identityStable: true,
    };
    completeStep(acceptanceSteps[3]);
    await save();

    const refreshTarget = oracle.bloom.episodes[0]!;
    const refreshAssetId = initialEpisodes.get(
      `https://bgm.tv/episode/${refreshTarget.sourceAddress}`,
    )!.assetId;
    const beforeRefreshRecords = await sourceRecordsForAsset(
      client,
      refreshAssetId,
    );
    const beforeRefreshBangumiRecords = beforeRefreshRecords.filter(
      (record) =>
        record.sourceIdentity === "bangumi" && record.status === "available",
    );
    const refresh = await client.startMetadataRefresh({
      subjectId: refreshAssetId,
    });
    evidence["targetedRefreshExecutionId"] = refresh.id;
    await save();
    const refreshInspection: PublicExecutionInspection =
      await waitForPublicExecution(client, refresh.id, workflowTimeoutMs);
    assert.equal(refreshInspection.kind, "execution");
    if (refreshInspection.kind !== "execution")
      throw new Error("单集刷新必须返回正式工作流执行");
    assert.equal(refreshInspection.outcome, "accepted");
    assert.equal(refreshInspection.sourceRefreshRuns.length, 1);
    const refreshRun = refreshInspection.sourceRefreshRuns[0]!;
    assert.equal(refreshRun.outcome, "succeeded");
    assert.equal(refreshRun.requestedSelection.subjectId, refreshAssetId);
    assert.equal(refreshRun.requestedSelection.sourceIdentity, "bangumi");
    assert.equal(
      refreshRun.requestedSelection.nativeAddress,
      `https://bgm.tv/episode/${refreshTarget.sourceAddress}`,
    );
    assert.equal(refreshRun.scopes.length, 1);
    const refreshScope = refreshRun.scopes[0]!;
    assert.equal(refreshScope.coverage.sourceIdentity, "bangumi");
    assert.equal(
      refreshScope.coverage.nativeAddress,
      `https://bgm.tv/episode/${refreshTarget.sourceAddress}`,
    );
    assert.equal(
      refreshScope.coverage.coverageId,
      `bangumi.episode:${refreshTarget.sourceAddress}`,
    );
    assert.ok(
      refreshScope.outcome === "applied" ||
        refreshScope.outcome === "unchanged",
      "单集刷新范围必须成功",
    );
    assert.ok(refreshScope.candidateSourceRecordId);
    assert.equal(
      beforeRefreshBangumiRecords.some(
        (record) => record.id === refreshScope.candidateSourceRecordId,
      ),
      false,
      "单集刷新必须保留新来源记录，而不是复用旧记录冒充刷新",
    );
    const refreshedAssets = await allAssets(client, library.id);
    const refreshedAsset = refreshedAssets.find(
      (asset) => asset.id === refreshAssetId,
    );
    assert.ok(refreshedAsset, "单集刷新后资产身份必须稳定");
    const afterRefreshRecords = await sourceRecordsForAsset(
      client,
      refreshAssetId,
    );
    const freshRecord = afterRefreshRecords.find(
      (record) => record.id === refreshScope.candidateSourceRecordId,
    );
    assert.ok(freshRecord, "新来源记录必须通过正式资产证据读取");
    assert.equal(freshRecord.kind, "source-record");
    assert.equal(freshRecord.status, "available");
    assert.equal(freshRecord.sourceIdentity, "bangumi");
    assert.equal(
      freshRecord.nativeAddress,
      `https://bgm.tv/episode/${refreshTarget.sourceAddress}`,
    );
    assert.equal(freshRecord.coverage?.authority, "official");
    assert.equal(freshRecord.coverage?.completeness, "complete");
    const refreshRecordDigest = await readSourceRecordDigest(
      client,
      refreshAssetId,
      freshRecord.id,
    );
    const currentRefreshIds = new Set(
      afterRefreshRecords
        .filter(
          (record) =>
            record.sourceIdentity === "bangumi" &&
            record.status === "available",
        )
        .map((record) => record.id),
    );
    assertEpisodeAsset({
      asset: refreshedAsset,
      root: oracle.bloom,
      episode: refreshTarget,
      currentRecordIds: currentRefreshIds,
      subjectIds,
    });
    evidence["targetedRefresh"] = {
      status: refreshInspection.status,
      outcome: refreshInspection.outcome,
      scopeOutcome: refreshScope.outcome,
      requestedAddress: refreshRun.requestedSelection.nativeAddress,
      scopeCount: refreshRun.scopes.length,
      coverageId: refreshScope.coverage.coverageId,
      baselineRecordCount: beforeRefreshBangumiRecords.length,
      newSourceRecord: {
        id: freshRecord.id,
        nativeAddress: freshRecord.nativeAddress,
        coverage: freshRecord.coverage?.id,
        digest: freshRecord.digest,
        readContent: refreshRecordDigest,
      },
      assetIdStable: refreshedAsset.id === refreshAssetId,
    };
    completeStep(acceptanceSteps[4]);
    signalController.signal.throwIfAborted();
    businessPassed = true;
    evidence["outcome"] = "passed";
    evidence["finishedAt"] = new Date().toISOString();
    await save();
  } catch (error) {
    if (error instanceof ConditionMissingError) {
      conditionMissing = error.items;
      evidence["conditionMissing"] = {
        items: conditionMissing,
        notExecuted: acceptanceSteps.filter(
          (step) => !executedSteps.includes(step),
        ),
      };
      evidence["outcome"] = "condition-missing";
      evidence["finishedAt"] = new Date().toISOString();
    } else {
      businessFailure = safeFailure(error);
      evidence["failure"] = businessFailure;
      evidence["outcome"] = signalController.signal.aborted
        ? "cancelled"
        : "failed";
      evidence["finishedAt"] = new Date().toISOString();
    }
    try {
      await save();
    } catch (saveError) {
      evidence["cleanupErrors"] = [
        ...(evidence["cleanupErrors"] as {
          phase: string;
          failure: SafeFailure;
        }[]),
        { phase: "记录主失败", failure: safeFailure(saveError) },
      ];
    }
  } finally {
    const cleanupErrors = evidence["cleanupErrors"] as {
      phase: string;
      failure: SafeFailure;
    }[];
    try {
      await save();
    } catch (error) {
      cleanupErrors.push({
        phase: "停止前保存证据",
        failure: safeFailure(error),
      });
    }
    if (ownedRunId !== undefined && ownedEnvironmentId !== undefined) {
      try {
        const finalStop = await stopOwnedRun({
          workspacePath,
          environment: environmentArg!,
          runId: ownedRunId,
          expectedEnvironmentId: ownedEnvironmentId,
          expectedDataGeneration: ownedDataGeneration ?? null,
        });
        evidence["finalStop"] = {
          status: "stopped",
          state: finalStop.state,
          processLiveness: finalStop.run.processLiveness,
          runId: finalStop.run.runId,
        };
      } catch (error) {
        cleanupErrors.push({
          phase: "停止本次服务",
          failure: safeFailure(error),
        });
      }
    }
    if (beforeDigests !== undefined) {
      try {
        const afterDigests = await Promise.all(
          roots.map(({ realPath }) => digestDirectory(realPath)),
        );
        evidence["materialsAfter"] = roots.map((root, index) =>
          rootEvidence(root, afterDigests[index]!),
        );
        assert.deepEqual(
          afterDigests,
          beforeDigests,
          "实况验收前后真实素材字节必须完整一致",
        );
        completeStep(acceptanceSteps[5]);
      } catch (error) {
        if (businessFailure === undefined) businessFailure = safeFailure(error);
        evidence["materialsFailure"] = safeFailure(error);
        evidence["failure"] ??= businessFailure;
      }
    }
    evidence["cleanupErrors"] = cleanupErrors;
    const passed =
      businessPassed &&
      businessFailure === undefined &&
      conditionMissing === undefined &&
      cleanupErrors.length === 0 &&
      executedSteps.length === acceptanceSteps.length;
    evidence["outcome"] =
      cleanupErrors.length > 0 || businessFailure !== undefined
        ? signalController.signal.aborted
          ? "cancelled"
          : "failed"
        : conditionMissing !== undefined
          ? "condition-missing"
          : passed
            ? "passed"
            : "failed";
    evidence["finishedAt"] = new Date().toISOString();
    try {
      await save();
    } catch (error) {
      cleanupErrors.push({
        phase: "最终保存证据",
        failure: safeFailure(error),
      });
    }
    finalOutcome =
      cleanupErrors.length > 0
        ? signalController.signal.aborted
          ? "cancelled"
          : "failed"
        : (evidence["outcome"] as BangumiLiveResult["outcome"]);
    evidence["outcome"] = finalOutcome;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
  const cleanupErrors = evidence["cleanupErrors"] as {
    phase: string;
    failure: SafeFailure;
  }[];
  const result: BangumiLiveResult = { outcome: finalOutcome, evidencePath };
  if (conditionMissing !== undefined)
    return {
      ...result,
      conditionMissing,
      ...(cleanupErrors.length > 0
        ? { cleanupErrors: [...cleanupErrors] }
        : {}),
    };
  if (businessFailure !== undefined)
    return {
      ...result,
      failure: businessFailure,
      ...(cleanupErrors.length > 0
        ? { cleanupErrors: [...cleanupErrors] }
        : {}),
    };
  if (cleanupErrors.length > 0)
    return {
      ...result,
      failure: cleanupErrors[0]!.failure,
      cleanupErrors: [...cleanupErrors],
    };
  return result;
}

export async function runBangumiLive(
  input: BangumiLiveInput,
): Promise<BangumiLiveResult> {
  try {
    return await runBangumiLiveWithEvidence(input);
  } catch (error) {
    return {
      outcome:
        error instanceof ConditionMissingError ? "condition-missing" : "failed",
      ...(error instanceof ConditionMissingError
        ? { conditionMissing: error.items }
        : { failure: safeFailure(error) }),
    };
  }
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4)
    throw new ConditionMissingError([
      "用法：pnpm verify:bangumi-live <专用已准备环境名> <证据文件相对workspace路径> <Bloom素材根绝对路径> <Frieren素材根绝对路径>",
    ]);
  const [environment, evidencePath, bloomMaterialRoot, frierenMaterialRoot] =
    args as [string, string, string, string];
  let workspacePath: string;
  try {
    workspacePath = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
  } catch {
    throw new ConditionMissingError([
      "必须通过 DIGITAL_AUTOMATION_WORKSPACE 提供现存工作区绝对路径",
    ]);
  }
  const result = await runBangumiLive({
    workspacePath,
    environment,
    evidencePath,
    bloomMaterialRoot,
    frierenMaterialRoot,
  });
  if (result.outcome === "passed") {
    process.stdout.write("Bangumi 实况验收通过\n");
    return;
  }
  if (result.outcome === "condition-missing") {
    process.stderr.write(
      `condition-missing：${result.conditionMissing?.join("；") ?? "验收前置条件不足"}\n`,
    );
    process.exitCode = 2;
    return;
  }
  process.stderr.write(
    `Bangumi 实况验收${result.outcome === "cancelled" ? "已取消" : "失败"}：${result.failure?.message ?? "请检查安全验收记录"}\n`,
  );
  process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await runCli();
  } catch (error) {
    const failure = safeFailure(error);
    if (error instanceof ConditionMissingError) {
      process.stderr.write(`condition-missing：${failure.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`Bangumi 实况验收失败：${failure.message}\n`);
      process.exitCode = 1;
    }
  }
}
