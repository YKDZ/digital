import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AssetRefreshInspection } from "@digital/application";
import type { RawFilesystemSnapshot } from "@digital/test-support";

import {
  assertFixedCorpusContentBaselineSubset,
  captureFixedCorpusSnapshots,
  fixedCorpusContentDigestsFromSnapshots,
  type FixedCorpusContentDigest,
  type FixedCorpusRoot,
} from "../fixed-corpus.ts";
import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

const bloomLogicalRoot = "media/番剧/终将成为你 (2018)";
const frierenLogicalRoot = "media/番剧/葬送的芙莉莲 (2023)";
const liveProductDataEnvironment = "DIGITAL_BANGUMI_LIVE_PRODUCT_DATA";
const bangumiOracleReviewStatus = "reviewed-current-official-source";

type BangumiJourneyState = {
  readonly roots: readonly FixedCorpusRoot[];
  readonly before: ReadonlyMap<string, RawFilesystemSnapshot>;
  readonly deepBefore?: ReadonlyMap<string, FixedCorpusContentDigest>;
  readonly bloom: BangumiEpisodicRootOracle;
  readonly frieren: BangumiEpisodicRootOracle;
};

const stateByWorkDirectory = new Map<string, BangumiJourneyState>();

export type BangumiEpisodicRootOracle = {
  readonly title: string;
  readonly subjects: readonly {
    readonly season: number;
    readonly sourceAddress: string;
  }[];
  readonly episodes: readonly {
    readonly season: number;
    readonly seasonPosition: number;
    readonly continuousPosition: number;
    readonly sourceAddress: string;
  }[];
};

function object(value: unknown, label: string): Record<string, unknown> {
  assert.equal(
    typeof value === "object" && value !== null && !Array.isArray(value),
    true,
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok((value as string).length > 0, `${label} must not be empty`);
  return value as string;
}

function pair(value: unknown, label: string): readonly [number, number] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.equal(value.length, 2, `${label} must have two bounds`);
  assert.ok(
    value.every((item) => Number.isSafeInteger(item) && item > 0),
    `${label} must contain positive integers`,
  );
  return [value[0] as number, value[1] as number];
}

function addresses(value: unknown, label: string): readonly string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => text(item, `${label}[${String(index)}]`));
}

function episodesFromSeason(
  value: unknown,
  season: number,
  label: string,
): readonly BangumiEpisodicRootOracle["episodes"][number][] {
  const seasonOracle = object(value, label);
  const local = pair(
    seasonOracle.localEpisodeNumbers,
    `${label}.localEpisodeNumbers`,
  );
  const official = pair(
    seasonOracle.officialEpisodeNumbers,
    `${label}.officialEpisodeNumbers`,
  );
  const continuous = pair(
    seasonOracle.officialSeriesSort,
    `${label}.officialSeriesSort`,
  );
  const sourceAddresses = addresses(
    seasonOracle.episodeSourceAddresses,
    `${label}.episodeSourceAddresses`,
  );
  const count = local[1] - local[0] + 1;
  assert.equal(official[1] - official[0] + 1, count);
  assert.equal(continuous[1] - continuous[0] + 1, count);
  assert.equal(sourceAddresses.length, count);
  return sourceAddresses.map((sourceAddress, index) => ({
    season,
    seasonPosition: official[0] + index,
    continuousPosition: continuous[0] + index,
    sourceAddress,
  }));
}

async function readBangumiOracles(
  context: Parameters<CliJourney["setup"]>[0],
): Promise<{
  readonly bloom: BangumiEpisodicRootOracle;
  readonly frieren: BangumiEpisodicRootOracle;
}> {
  const raw = object(
    JSON.parse(
      await readFile(
        path.resolve(
          context.packageRoot,
          "../..",
          ".scratch/acceptance-corpus/references/reviewed-oracle.json",
        ),
        "utf8",
      ),
    ) as unknown,
    "reviewed oracle",
  );
  const reviews = object(raw.reviews, "reviewed oracle reviews");
  const review = object(reviews.bangumi, "Bangumi oracle review");
  assert.equal(
    review.status,
    bangumiOracleReviewStatus,
    "Bangumi live oracle must retain its completed current official review",
  );
  const video = object(raw.video, "reviewed oracle video");
  const bloomRaw = object(video.series, "reviewed oracle video.series");
  const bloomAssociations = object(
    bloomRaw.sourceAssociations,
    "reviewed oracle video.series.sourceAssociations",
  );
  const bloomAddresses = addresses(
    bloomRaw.episodeSourceAddresses,
    "reviewed oracle video.series.episodeSourceAddresses",
  );
  assert.equal(bloomRaw.seasonCount, 1);
  assert.equal(bloomRaw.episodeCount, bloomAddresses.length);
  const bloom: BangumiEpisodicRootOracle = {
    title: text(bloomRaw.title, "reviewed oracle Bloom title"),
    subjects: [
      {
        season: 1,
        sourceAddress: text(
          bloomAssociations.Bangumi,
          "reviewed oracle Bloom subject",
        ),
      },
    ],
    episodes: bloomAddresses.map((sourceAddress, index) => ({
      season: 1,
      seasonPosition: index + 1,
      continuousPosition: index + 1,
      sourceAddress,
    })),
  };
  const frierenRaw = object(
    video.multiSeasonSeries,
    "reviewed oracle video.multiSeasonSeries",
  );
  const frierenAssociations = object(
    frierenRaw.sourceAssociations,
    "reviewed oracle Frieren sourceAssociations",
  );
  const frieren: BangumiEpisodicRootOracle = {
    title: text(frierenRaw.title, "reviewed oracle Frieren title"),
    subjects: [
      {
        season: 1,
        sourceAddress: text(
          frierenAssociations.BangumiSeason1,
          "reviewed oracle Frieren season 1 subject",
        ),
      },
      {
        season: 2,
        sourceAddress: text(
          frierenAssociations.BangumiSeason2,
          "reviewed oracle Frieren season 2 subject",
        ),
      },
    ],
    episodes: [
      ...episodesFromSeason(frierenRaw.season1, 1, "Frieren season1"),
      ...episodesFromSeason(frierenRaw.season2, 2, "Frieren season2"),
    ],
  };
  return { bloom, frieren };
}

function currentRecordIds(value: AssetRefreshInspection): ReadonlySet<string> {
  assert.ok(
    value.sourceRecords.length > 0,
    "live acceptance must capture records",
  );
  for (const record of value.sourceRecords) {
    assert.equal(record.sourceIdentity, "bangumi");
    assert.equal(record.coverage.authority, "official");
    assert.equal(record.coverage.completeness, "complete");
  }
  return new Set(value.sourceRecords.map((record) => record.id));
}

function assertCurrentReferences(
  ids: readonly string[],
  current: ReadonlySet<string>,
  label: string,
): void {
  assert.ok(ids.length > 0, `${label} must cite current Source Records`);
  assert.ok(
    ids.every((id) => current.has(id)),
    `${label} must cite only current Source Records`,
  );
}

/**
 * 实时旅程按来源地址核对逐项结果；数组位置不携带身份语义。
 */
export function assertBangumiAcceptedEpisodeSet(
  value: AssetRefreshInspection,
  oracle: BangumiEpisodicRootOracle,
): void {
  assert.equal(value.execution.outcome, "accepted");
  const current = currentRecordIds(value);
  const expectedCoverage = new Set(["bangumi.subject-search"]);
  for (const subject of oracle.subjects) {
    expectedCoverage.add(`bangumi.subject:${subject.sourceAddress}`);
    expectedCoverage.add(`bangumi.relationships:${subject.sourceAddress}`);
    expectedCoverage.add(
      `bangumi.ordinary-episodes:${subject.sourceAddress}:0`,
    );
  }
  for (const episode of oracle.episodes)
    expectedCoverage.add(`bangumi.episode:${episode.sourceAddress}`);
  assert.deepEqual(
    value.sourceRecords.map((record) => record.coverage.id).toSorted(),
    [...expectedCoverage].toSorted(),
    "live execution Source Record coverage must match the reviewed subjects and episodes",
  );
  for (const record of value.sourceRecords) {
    const address = record.coverage.id.match(/^bangumi\.episode:(\d+)$/u)?.[1];
    if (address !== undefined)
      assert.equal(record.nativeAddress, `https://bgm.tv/episode/${address}`);
    const subject = record.coverage.id.match(
      /^bangumi\.(?:subject|relationships|ordinary-episodes):(\d+)/u,
    )?.[1];
    if (subject !== undefined)
      assert.equal(record.nativeAddress, `https://bgm.tv/subject/${subject}`);
  }
  const items = value.itemResults ?? [];
  assert.equal(items.length, oracle.episodes.length);
  const byAddress = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    const address = item.accepted?.recognitionSourceAssociation?.nativeAddress;
    if (address === undefined || !address.startsWith("https://bgm.tv/episode/"))
      throw new Error(
        "accepted work item must expose an exact Bangumi episode address",
      );
    assert.equal(
      byAddress.has(address),
      false,
      "each exact Bangumi episode address must occur once",
    );
    byAddress.set(address, item);
  }
  const acceptedEntityIds = new Set<string>();
  for (const expected of oracle.episodes) {
    const address = `https://bgm.tv/episode/${expected.sourceAddress}`;
    const item = byAddress.get(address);
    assert.ok(
      item !== undefined,
      `missing exact Bangumi episode address ${expected.sourceAddress}`,
    );
    assert.equal(item.outcome, "accepted");
    const accepted = item.accepted!;
    assert.equal(accepted.entity.kind, "digital-asset");
    assert.equal(
      acceptedEntityIds.has(accepted.entity.id),
      false,
      "each local episode boundary must produce one independent Digital Asset",
    );
    acceptedEntityIds.add(accepted.entity.id);
    assert.deepEqual(accepted.sourceAssociations, [
      { sourceIdentity: "bangumi", nativeAddress: address },
    ]);
    assert.ok(
      accepted.recognitionSourceAssociation,
      "accepted Bangumi episode must retain its recognition source",
    );
    assert.deepEqual(accepted.recognitionSourceAssociation, {
      sourceIdentity: "bangumi",
      nativeAddress: address,
    });
    assert.equal(
      item.key,
      `bangumi:season-${expected.season}:episode-${expected.seasonPosition}`,
    );
    assert.equal(item.relativePaths.length, 1);
    const pathMatch =
      /^Season ([1-9]\d*)\/(.+) - S(\d{2})E(\d{2})(?: - 第 (\d+) 集)?\.(?:mkv|mp4)$/u.exec(
        item.relativePaths[0]!,
      );
    assert.ok(
      pathMatch,
      "episode boundary must contain exactly one media file",
    );
    assert.equal(Number(pathMatch[1]), expected.season);
    assert.equal(pathMatch[2], oracle.title);
    assert.equal(Number(pathMatch[3]), expected.season);
    assert.equal(Number(pathMatch[4]), expected.seasonPosition);
    if (pathMatch[5] !== undefined)
      assert.equal(Number(pathMatch[5]), expected.seasonPosition);
    const position = (property: string, label: string): string => {
      const matches = accepted.metadata.filter(
        (metadata) =>
          metadata.subjectId === accepted.entity.id &&
          metadata.property === property,
      );
      assert.equal(matches.length, 1, `episode must retain one ${label}`);
      assertCurrentReferences(matches[0]!.sourceRecordIds, current, label);
      return matches[0]!.value;
    };
    assert.equal(
      position("bangumi.episode.season-position", "season position"),
      String(expected.seasonPosition),
      "episode season position drifted",
    );
    assert.equal(
      position("bangumi.episode.continuous-position", "continuous position"),
      String(expected.continuousPosition),
      "episode continuous position drifted",
    );
    const observed = accepted.locations.filter(
      (location) => location.kind === "observed",
    );
    assert.equal(
      observed.length,
      1,
      "each work item must retain one observed episode artifact",
    );
    assert.equal(
      accepted.artifactAssociations.filter(
        (association) =>
          association.artifactId === observed[0]!.artifactId &&
          association.role === "asset.material-delivered",
      ).length,
      1,
      "observed episode bytes must be delivered material",
    );
    assert.equal(
      accepted.artifactAssociations.some(
        (association) =>
          association.artifactId === observed[0]!.artifactId &&
          association.role === "asset.primary-cover",
      ),
      false,
      "observed writeback material must not become a primary cover",
    );
    const expectedSubjects = oracle.subjects;
    const entities = accepted.entities ?? [];
    assert.deepEqual(
      entities
        .map((entity) => `${entity.identityNamespace}:${entity.sourceKey}`)
        .toSorted(),
      expectedSubjects
        .map((subject) => `bangumi.subject:${subject.sourceAddress}`)
        .toSorted(),
      "only exact reviewed Bangumi subjects may become related identities",
    );
    for (const entity of entities) {
      assert.equal(entity.sourceIdentity, "bangumi");
      assertCurrentReferences(
        entity.sourceRecordIds,
        current,
        "Bangumi subject identity",
      );
    }
    const seasonSubject = oracle.subjects.find(
      (subject) => subject.season === expected.season,
    )!;
    const seasonEntity = entities.find(
      (entity) => entity.sourceKey === seasonSubject.sourceAddress,
    )!;
    const relationships = accepted.relationships ?? [];
    const memberships = relationships.filter(
      (relationship) =>
        relationship.type === "asset.membership" &&
        relationship.role === "bangumi.subject.ordinary-episode",
    );
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]!.subjectId, accepted.entity.id);
    assert.equal(memberships[0]!.participantId, seasonEntity.id);
    assert.equal(
      memberships[0]!.sourceSlot,
      `bangumi.subject.ordinary-episode:${seasonSubject.sourceAddress}:${expected.sourceAddress}`,
    );
    assert.deepEqual(
      (memberships[0]!.qualifiers ?? [])
        .map((qualifier) => ({ key: qualifier.key, value: qualifier.value }))
        .toSorted((left, right) => left.key.localeCompare(right.key)),
      [
        {
          key: "bangumi.episode.continuous-position",
          value: String(expected.continuousPosition),
        },
        {
          key: "bangumi.episode.season-position",
          value: String(expected.seasonPosition),
        },
      ],
      "episode membership must retain both relationship ordering qualifiers",
    );
    assertCurrentReferences(
      memberships[0]!.sourceRecordIds,
      current,
      "episode membership",
    );
    const sequels = relationships.filter(
      (relationship) =>
        relationship.type === "bangumi.subject.related" &&
        relationship.role === "bangumi.subject.sequel",
    );
    assert.equal(
      sequels.length,
      Math.max(0, expectedSubjects.length - 1),
      "reviewed Bangumi sequel relationship count drifted",
    );
    for (let index = 1; index < expectedSubjects.length; index += 1) {
      const predecessor = entities.find(
        (entity) =>
          entity.sourceKey === expectedSubjects[index - 1]!.sourceAddress,
      )!;
      const successor = entities.find(
        (entity) => entity.sourceKey === expectedSubjects[index]!.sourceAddress,
      )!;
      const sequel = sequels.find(
        (relationship) =>
          relationship.subjectId === predecessor.id &&
          relationship.participantId === successor.id,
      );
      assert.ok(sequel, "reviewed Bangumi season sequel relation is missing");
      assert.notEqual(sequel.subjectId, sequel.participantId);
      assert.equal(
        sequel.sourceSlot,
        `bangumi.subject.sequel:${expectedSubjects[index - 1]!.sourceAddress}:${expectedSubjects[index]!.sourceAddress}`,
      );
      assertCurrentReferences(
        sequel.sourceRecordIds,
        current,
        "season sequel relationship",
      );
    }
  }
}

function acceptedItemsByAddress(
  value: AssetRefreshInspection,
): ReadonlyMap<
  string,
  NonNullable<AssetRefreshInspection["itemResults"]>[number]
> {
  const byAddress = new Map<
    string,
    NonNullable<AssetRefreshInspection["itemResults"]>[number]
  >();
  for (const item of value.itemResults ?? []) {
    const address = item.accepted?.recognitionSourceAssociation?.nativeAddress;
    assert.ok(address, "reopened work item must retain its source address");
    assert.equal(byAddress.has(address), false);
    byAddress.set(address, item);
  }
  return byAddress;
}

function stableAcceptedIdentity(
  accepted: NonNullable<
    NonNullable<AssetRefreshInspection["itemResults"]>[number]["accepted"]
  >,
): unknown {
  return {
    entity: accepted.entity,
    recognitionSourceAssociation: accepted.recognitionSourceAssociation,
    sourceAssociations: accepted.sourceAssociations,
    entities: (accepted.entities ?? [])
      .map((entity) => ({
        id: entity.id,
        identityNamespace: entity.identityNamespace,
        sourceKey: entity.sourceKey,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    artifacts: accepted.artifacts.map((artifact) => artifact.id).toSorted(),
    locations: accepted.locations
      .map((location) => ({
        id: location.id,
        artifactId: location.artifactId,
        address: location.address,
        kind: location.kind,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    artifactRevisions: accepted.artifactRevisions
      .map((revision) => revision.id)
      .toSorted(),
    artifactAssociations: accepted.artifactAssociations
      .map((association) => ({
        id: association.id,
        subjectId: association.subjectId,
        artifactId: association.artifactId,
        role: association.role,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    metadata: accepted.metadata
      .map((metadata) => ({
        subjectId: metadata.subjectId,
        property: metadata.property,
        value: metadata.value,
        sourceSlot: metadata.sourceSlot,
        sourceRecordIds: metadata.sourceRecordIds,
      }))
      .toSorted((left, right) =>
        `${left.subjectId ?? ""}:${left.property}:${left.sourceSlot}`.localeCompare(
          `${right.subjectId ?? ""}:${right.property}:${right.sourceSlot}`,
        ),
      ),
    relationships: (accepted.relationships ?? [])
      .map((relationship) => ({
        id: relationship.id,
        subjectId: relationship.subjectId,
        participantId: relationship.participantId,
        type: relationship.type,
        role: relationship.role,
        sourceSlot: relationship.sourceSlot,
        sourceRecordIds: relationship.sourceRecordIds,
        qualifiers: relationship.qualifiers,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

/** 每条 CLI 命令都会重开同一个 SQLite 产品目录；按地址比较，绝不按数组顺序比较。 */
export function assertBangumiReopenedEpisodeSet(
  initial: AssetRefreshInspection,
  reopened: AssetRefreshInspection,
  oracle: BangumiEpisodicRootOracle,
): void {
  assert.equal(reopened.execution.outcome, "no-change");
  assert.deepEqual(reopened.sourceRecords, []);
  const initialByAddress = acceptedItemsByAddress(initial);
  const reopenedByAddress = acceptedItemsByAddress(reopened);
  assert.equal(initialByAddress.size, oracle.episodes.length);
  assert.equal(reopenedByAddress.size, oracle.episodes.length);
  for (const expected of oracle.episodes) {
    const address = `https://bgm.tv/episode/${expected.sourceAddress}`;
    const prior = initialByAddress.get(address);
    const current = reopenedByAddress.get(address);
    assert.ok(prior?.accepted, `initial episode ${address} is missing`);
    assert.ok(current?.accepted, `reopened episode ${address} is missing`);
    assert.equal(current.outcome, "no-change");
    assert.deepEqual(current.relativePaths, prior.relativePaths);
    assert.deepEqual(
      stableAcceptedIdentity(current.accepted),
      stableAcceptedIdentity(prior.accepted),
      `episode ${address} must retain stable identity after SQLite reopen`,
    );
  }
}

/**
 * 人工检查点提供一个一次性 Digital 产品数据根，它已通过 Digital 自己的开始/回调流程授权。
 * 本旅程绝不读取或导入其他产品的 OAuth 导出内容。
 */
function liveProductDataDirectory(): string {
  const productData = process.env[liveProductDataEnvironment]?.trim();
  if (productData === undefined || productData.length === 0) {
    throw new Error(
      "Bangumi live journey requires a disposable Digital product-data directory with an authorized Bangumi connection",
    );
  }
  return productData;
}

async function seedDisposableDigitalConnections(
  context: Parameters<CliJourney["setup"]>[0],
): Promise<void> {
  const source = path.join(
    liveProductDataDirectory(),
    "private-source-connections",
    "bangumi-oauth.json",
  );
  try {
    await access(source);
  } catch {
    throw new Error(
      "Bangumi live journey Digital OAuth connection is unavailable",
    );
  }
  // 这是把 Digital 自身授权短暂复制到两个一次性产品数据根中，每个来源/分发旅程各一个。
  // 它随 `context.workDir` 一起删除，且绝不导入其他产品的 OAuth 导出内容。
  await Promise.all(
    ["bloom", "frieren"].map(async (name) => {
      const privateDirectory = path.join(
        context.workDir,
        name,
        "private-source-connections",
      );
      await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
      await chmod(privateDirectory, 0o700);
      const destination = path.join(privateDirectory, "bangumi-oauth.json");
      await copyFile(source, destination);
      await chmod(destination, 0o600);
    }),
  );
}

function corpusRoot(context: Parameters<CliJourney["setup"]>[0]): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus",
  );
}

function stateKey(context: Parameters<CliJourney["setup"]>[0]): string {
  return `${context.mode}:${context.workDir}`;
}

function currentState(
  context: Parameters<CliJourney["setup"]>[0],
): BangumiJourneyState {
  const state = stateByWorkDirectory.get(stateKey(context));
  if (state === undefined)
    throw new Error("Bangumi live journey setup did not run");
  return state;
}

function fixedRoots(
  context: Parameters<CliJourney["setup"]>[0],
): readonly FixedCorpusRoot[] {
  const assets = path.join(corpusRoot(context), "assets");
  return [bloomLogicalRoot, frierenLogicalRoot].map((logicalRoot) => ({
    logicalRoot,
    directory: path.join(assets, ...logicalRoot.split("/")),
  }));
}

function inspection(
  result: CliJourneyResult | undefined,
): AssetRefreshInspection {
  return JSON.parse(result?.stdout ?? "") as AssetRefreshInspection;
}

function acceptedAssetIdForAddress(
  result: CliJourneyResult | undefined,
  sourceAddress: string,
): string {
  const value = inspection(result);
  const address = `https://bgm.tv/episode/${sourceAddress}`;
  const id = value.itemResults?.find(
    (item) =>
      item.accepted?.recognitionSourceAssociation?.nativeAddress === address,
  )?.accepted?.entity.id;
  if (id === undefined)
    throw new Error(
      `expected accepted episode ${address} in public inspection`,
    );
  return id;
}

function assertObservedInventory(
  snapshots: ReadonlyMap<string, RawFilesystemSnapshot>,
  oracles: readonly {
    readonly logicalRoot: string;
    readonly oracle: BangumiEpisodicRootOracle;
  }[],
): void {
  for (const { logicalRoot, oracle } of oracles) {
    const snapshot = snapshots.get(logicalRoot);
    assert.ok(snapshot, `missing fixed corpus snapshot ${logicalRoot}`);
    const files = snapshot.entries.filter(
      (entry) => entry.kind === "regular-file",
    );
    const episodicMedia = files.filter((entry) =>
      /\.(?:mkv|mp4)$/iu.test(entry.relativePath),
    );
    assert.equal(
      episodicMedia.length,
      oracle.episodes.length,
      `${logicalRoot} episodic media count drifted`,
    );
  }
}

function assertEpisodeRefresh(
  value: AssetRefreshInspection,
  sourceAddress: string,
  expectedAssetId: string,
): void {
  const address = `https://bgm.tv/episode/${sourceAddress}`;
  assert.equal(value.execution.outcome, "accepted");
  assert.equal(value.execution.selection.intent, "metadata-refresh");
  assert.equal(value.accepted?.entity.id, expectedAssetId);
  assert.ok(
    value.accepted?.recognitionSourceAssociation,
    "refreshed Bangumi episode must retain its recognition source",
  );
  assert.deepEqual(value.accepted.recognitionSourceAssociation, {
    sourceIdentity: "bangumi",
    nativeAddress: address,
  });
  assert.deepEqual(
    value.sourceRecords.map((record) => ({
      sourceIdentity: record.sourceIdentity,
      nativeAddress: record.nativeAddress,
      coverage: record.coverage.id,
    })),
    [
      {
        sourceIdentity: "bangumi",
        nativeAddress: address,
        coverage: `bangumi.episode:${sourceAddress}`,
      },
    ],
    "single-episode refresh must reacquire only its exact current address",
  );
}

const journey: CliJourney = {
  name: "bangumi-episodic-live",
  modes: ["source", "distribution"],
  async setup(context) {
    await seedDisposableDigitalConnections(context);
    const { bloom, frieren } = await readBangumiOracles(context);
    const roots = fixedRoots(context);
    const deepIntegrity = process.env.DIGITAL_DEEP_CORPUS_INTEGRITY === "1";
    const before = await captureFixedCorpusSnapshots(roots, deepIntegrity);
    assertObservedInventory(before, [
      { logicalRoot: bloomLogicalRoot, oracle: bloom },
      { logicalRoot: frierenLogicalRoot, oracle: frieren },
    ]);
    const deepBefore = deepIntegrity
      ? fixedCorpusContentDigestsFromSnapshots(roots, before)
      : undefined;
    if (deepBefore !== undefined)
      await assertFixedCorpusContentBaselineSubset(context, deepBefore);
    stateByWorkDirectory.set(stateKey(context), {
      roots,
      before,
      bloom,
      frieren,
      ...(deepBefore === undefined ? {} : { deepBefore }),
    });
  },
  commands(context) {
    const state = currentState(context);
    const env = (name: string) => ({
      DIGITAL_PRODUCT_DATA: path.join(context.workDir, name),
    });
    const scan = (
      rootResultIndex: number,
      name: string,
      data: string,
      haltOnFailure = false,
    ) => ({
      name,
      args: (results: readonly CliJourneyResult[]) => [
        "scan",
        registeredObservedRootId(results[rootResultIndex]),
        "--scope",
        ".",
        "--require-artifact-role",
        "asset.primary-cover",
        "--json",
      ],
      env: env(data),
      ...(haltOnFailure ? { haltOnFailure: true as const } : {}),
    });
    return [
      {
        name: "register live Bloom root",
        args: ["root-create", "终将成为你 验收语料", state.roots[0]!.directory],
        env: env("bloom"),
        haltOnFailure: true,
      },
      {
        name: "register live Frieren root",
        args: [
          "root-create",
          "葬送的芙莉莲 验收语料",
          state.roots[1]!.directory,
        ],
        env: env("frieren"),
        haltOnFailure: true,
      },
      scan(0, "live accept Bloom", "bloom", true),
      scan(0, "live no-change Bloom after SQLite reopen", "bloom", true),
      {
        name: "live metadata refresh Bloom episode",
        args: (results) => [
          "refresh-metadata",
          acceptedAssetIdForAddress(
            results[2],
            state.bloom.episodes[0]!.sourceAddress,
          ),
          "--json",
        ],
        env: env("bloom"),
        haltOnFailure: true,
      },
      scan(1, "live accept Frieren", "frieren"),
      scan(1, "live no-change Frieren after SQLite reopen", "frieren", true),
    ];
  },
  async assertions({ context, results: allResults }) {
    const state = currentState(context);
    try {
      for (const registeredRoot of allResults.slice(0, 2)) {
        assert.equal(registeredRoot.exitCode, 0, registeredRoot.stderr);
        registeredObservedRootId(registeredRoot);
      }
      const results = allResults.slice(2);
      assert.equal(results.length, 5);
      for (const result of results) {
        assert.equal(result.exitCode, 0, `${result.commandName} failed`);
        assert.doesNotMatch(
          `${result.stdout}\n${result.stderr}`,
          /access_token|refresh_token|client_secret|oauth\.json|authorization\s*:|bearer\s+|cookie\s*:/iu,
          "private Bangumi configuration leaked through delivery output",
        );
      }
      const parsed = results.map(inspection);
      assertBangumiAcceptedEpisodeSet(parsed[0]!, state.bloom);
      assertBangumiReopenedEpisodeSet(parsed[0]!, parsed[1]!, state.bloom);
      const refreshedAddress = state.bloom.episodes[0]!.sourceAddress;
      assertEpisodeRefresh(
        parsed[2]!,
        refreshedAddress,
        acceptedAssetIdForAddress(results[0], refreshedAddress),
      );
      assertBangumiAcceptedEpisodeSet(parsed[3]!, state.frieren);
      assertBangumiReopenedEpisodeSet(parsed[3]!, parsed[4]!, state.frieren);

      const deepIntegrity = state.deepBefore !== undefined;
      const after = await captureFixedCorpusSnapshots(
        state.roots,
        deepIntegrity,
      );
      assertObservedInventory(after, [
        { logicalRoot: bloomLogicalRoot, oracle: state.bloom },
        { logicalRoot: frierenLogicalRoot, oracle: state.frieren },
      ]);
      assert.deepEqual(
        after,
        state.before,
        "Bangumi fixed roots changed during the live journey",
      );
      if (state.deepBefore !== undefined) {
        const deepAfter = fixedCorpusContentDigestsFromSnapshots(
          state.roots,
          after,
        );
        await assertFixedCorpusContentBaselineSubset(context, deepAfter);
        assert.deepEqual(deepAfter, state.deepBefore);
      }
    } finally {
      stateByWorkDirectory.delete(stateKey(context));
    }
  },
};

export default journey;
