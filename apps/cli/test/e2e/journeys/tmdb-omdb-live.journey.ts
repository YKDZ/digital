import assert from "node:assert/strict";
import path from "node:path";

import type {
  AssetRefreshInspection,
  SelectedMetadataRead,
} from "@digital/application";
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

const strictFilmLogicalRoot = "media/电影/恐怖直播 (2013)";
const directedBdmvLogicalRoot =
  "media/电影/[怒火救援].Man.on.Fire.2004.Blu-ray.1080p.AVC.DTS-HD.MA5.1-CMCT";
const strictFilmAddress = "https://www.themoviedb.org/movie/209764";
const directedBdmvAddress = "https://www.themoviedb.org/movie/9509";
const strictFilmOmdbAddress = "omdb:imdb:tt2990738";
const directedBdmvOmdbAddress = "omdb:imdb:tt0328107";

type MovieJourneyState = {
  readonly roots: readonly FixedCorpusRoot[];
  readonly before: ReadonlyMap<string, RawFilesystemSnapshot>;
  readonly deepBefore?: ReadonlyMap<string, FixedCorpusContentDigest>;
};

type JourneyInspection = AssetRefreshInspection & {
  readonly executionId?: string;
};
type AcceptedProjection = NonNullable<AssetRefreshInspection["accepted"]>;
export type InspectionProjection = "legacy" | "itemized";

const stateByWorkDirectory = new Map<string, MovieJourneyState>();

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length !== 0;
}

function stateKey(context: Parameters<CliJourney["setup"]>[0]): string {
  return `${context.mode}:${context.workDir}`;
}

function currentState(
  context: Parameters<CliJourney["setup"]>[0],
): MovieJourneyState {
  const state = stateByWorkDirectory.get(stateKey(context));
  if (state === undefined)
    throw new Error("TMDB and OMDb movie journey setup did not run");
  return state;
}

function movieRoots(
  context: Parameters<CliJourney["setup"]>[0],
): readonly FixedCorpusRoot[] {
  const assetsDirectory = path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus/assets",
  );
  return [strictFilmLogicalRoot, directedBdmvLogicalRoot].map(
    (logicalRoot) => ({
      logicalRoot,
      directory: path.join(assetsDirectory, ...logicalRoot.split("/")),
    }),
  );
}

function selectedRoot(
  state: MovieJourneyState,
  logicalRoot: string,
): FixedCorpusRoot {
  const root = state.roots.find(
    (candidate) => candidate.logicalRoot === logicalRoot,
  );
  if (root === undefined)
    throw new Error(
      `required live acceptance corpus is missing: ${logicalRoot}`,
    );
  return root;
}

function inspection(result: CliJourneyResult | undefined): JourneyInspection {
  return JSON.parse(result?.stdout ?? "") as JourneyInspection;
}

/**
 * 在显式包工作逐项列出时，应用层公开检查刻意保留旧版单边界投影。
 * 旅程必须验证每个公开工作流实际发出的结构。
 */
export function acceptedProjection(
  value: JourneyInspection,
  projection: InspectionProjection,
): AcceptedProjection {
  if (projection === "legacy") {
    assert.equal(
      value.itemResults,
      undefined,
      "legacy single-boundary inspection must not be read as an explicit work-item result",
    );
    assert.ok(
      value.accepted !== undefined,
      "legacy single-boundary inspection must expose its accepted projection at top level",
    );
    return value.accepted;
  }
  assert.ok(
    value.itemResults !== undefined,
    "explicit work-item inspection must expose itemResults",
  );
  assert.equal(
    value.itemResults.length,
    1,
    "directed BDMV acceptance must have exactly one explicit work item",
  );
  const item = value.itemResults[0];
  assert.ok(
    item?.accepted !== undefined,
    "explicit work item must be accepted",
  );
  return item.accepted;
}

function acceptedAssetId(
  result: CliJourneyResult | undefined,
  projection: InspectionProjection,
): string {
  return acceptedProjection(inspection(result), projection).entity.id;
}

function executionId(result: CliJourneyResult | undefined): string {
  const value = inspection(result);
  return value.executionId ?? value.execution.id;
}

function currentSourceAssociations(accepted: AcceptedProjection): readonly {
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
}[] {
  return accepted.sourceAssociations
    .map((association) => ({
      sourceIdentity: association.sourceIdentity,
      nativeAddress: association.nativeAddress,
    }))
    .toSorted((left, right) =>
      `${left.sourceIdentity}:${left.nativeAddress}`.localeCompare(
        `${right.sourceIdentity}:${right.nativeAddress}`,
      ),
    );
}

function sourceIdentityByRecord(
  value: JourneyInspection,
): ReadonlyMap<string, string> {
  return new Map(
    value.sourceRecords.map((record) => [record.id, record.sourceIdentity]),
  );
}

function assertSourceRecordIdentity(
  value: JourneyInspection,
  sourceIdentity: string,
  nativeAddress: string,
): void {
  assert.ok(
    value.sourceRecords.some(
      (record) =>
        record.sourceIdentity === sourceIdentity &&
        record.nativeAddress === nativeAddress,
    ),
    `${sourceIdentity} record at ${nativeAddress} must remain inspectable`,
  );
}

/** 普通读取只给出资产自身实体目标上已生效的选定值。 */
function effectiveMetadataReads(
  accepted: AcceptedProjection,
): readonly SelectedMetadataRead[] {
  return accepted.facts.descriptions
    .filter(
      (description) =>
        description.target.kind === "entity" &&
        description.target.entityId === accepted.facts.id,
    )
    .flatMap((description) =>
      description.metadata.flatMap((entry) =>
        entry.result.status === "resolved" ? entry.result.values : [],
      ),
    );
}

function assertEffectiveTmdbTitle(
  value: JourneyInspection,
  accepted: AcceptedProjection,
): void {
  const title = effectiveMetadataReads(accepted).find(
    (metadata) => metadata.property === "asset.title",
  );
  assert.ok(title !== undefined, "an effective title must be readable");
  assert.ok(title.value.trim().length);
  assert.equal(title.sourceIdentity, "tmdb");
  const citedRecords = new Set(
    title.assertions.flatMap((assertion) => assertion.sourceRecordIds),
  );
  assert.equal(title.sourceRecordIds.length, citedRecords.size);
  assert.ok(
    title.sourceRecordIds.every((id) => citedRecords.has(id)),
    "the effective title must cite exactly its own assertion records",
  );
  assert.ok(
    title.assertions.every(
      (assertion) => assertion.sourceSlot === title.sourceSlot,
    ),
    "the effective title must cite only its own source slot",
  );
  const currentExecutionSourceIdentities = sourceIdentityByRecord(value);
  assert.ok(
    title.sourceRecordIds.every((id) => {
      const sourceIdentity = currentExecutionSourceIdentities.get(id);
      // 未变化的刷新可以继续引用更早的来源记录；公开执行检查只携带本次记录，
      // 因而只有当前可见的记录 ID 能在这里再次核对身份。
      return sourceIdentity === undefined || sourceIdentity === "tmdb";
    }),
    "the effective title must not cite a visible non-TMDB source record",
  );
  assert.deepEqual(title.reasoning, {
    kind: "source-preference",
    preferredSource: "tmdb",
  });
  // 生效读取不再携带策略备选值；未被选中的 OMDb 断言只能在已接受原始断言中复核。
  const omdbTitleAssertion = accepted.metadata.find(
    (assertion) =>
      assertion.property === "asset.title" &&
      assertion.sourceRecordIds.some(
        (id) => currentExecutionSourceIdentities.get(id) === "omdb",
      ),
  );
  assert.ok(
    omdbTitleAssertion !== undefined,
    "the accepted projection must retain OMDb's unselected title assertion",
  );
  const selectedRecordIds = new Set(title.sourceRecordIds);
  assert.ok(
    omdbTitleAssertion.sourceRecordIds.every(
      (id) => !selectedRecordIds.has(id),
    ),
    "the selected TMDB title must not cite OMDb's source records",
  );
}

function assertEffectiveOmdbRating(accepted: AcceptedProjection): void {
  const rating = effectiveMetadataReads(accepted).find(
    (metadata) =>
      metadata.property.startsWith("rating.") &&
      metadata.sourceIdentity === "omdb",
  );
  assert.ok(
    rating !== undefined,
    "OMDb must contribute an effective native rating",
  );
  assert.ok(
    (rating.qualifiers ?? []).length > 0,
    "an OMDb rating must retain its native qualifiers",
  );
}

export function assertSourceEnrichedFilm(
  value: JourneyInspection,
  expectedTmdbAddress: string,
  expectedOmdbAddress: string,
  projection: InspectionProjection,
): void {
  const accepted = acceptedProjection(value, projection);
  assert.equal(value.execution.outcome, "accepted");
  assert.equal(accepted.entity.kind, "digital-asset");
  assert.ok(
    accepted.recognitionSourceAssociation,
    "accepted TMDB film must retain its recognition source",
  );
  assert.deepEqual(accepted.recognitionSourceAssociation, {
    sourceIdentity: "tmdb",
    nativeAddress: expectedTmdbAddress,
  });
  assert.deepEqual(currentSourceAssociations(accepted), [
    { sourceIdentity: "omdb", nativeAddress: expectedOmdbAddress },
    { sourceIdentity: "tmdb", nativeAddress: expectedTmdbAddress },
  ]);
  assertSourceRecordIdentity(value, "tmdb", expectedTmdbAddress);
  assertSourceRecordIdentity(value, "omdb", expectedOmdbAddress);
  assertEffectiveTmdbTitle(value, accepted);
  assertEffectiveOmdbRating(accepted);

  const primaryCover = accepted.artifactAssociations.filter(
    (association) => association.role === "asset.primary-cover",
  );
  assert.equal(
    primaryCover.length,
    1,
    "one effective primary cover is required",
  );
  const coverLocation = accepted.locations.find(
    (location) => location.artifactId === primaryCover[0]?.artifactId,
  );
  assert.equal(coverLocation?.kind, "managed");
}

function assertSameAcceptedProjection(
  initial: AcceptedProjection,
  reused: AcceptedProjection,
): void {
  assert.equal(reused.entity.id, initial.entity.id);
  assert.deepEqual(
    reused.artifacts.map((artifact) => artifact.id).toSorted(),
    initial.artifacts.map((artifact) => artifact.id).toSorted(),
  );
  assert.deepEqual(
    reused.artifactAssociations
      .map((association) => `${association.artifactId}:${association.role}`)
      .toSorted(),
    initial.artifactAssociations
      .map((association) => `${association.artifactId}:${association.role}`)
      .toSorted(),
  );
}

function assertMetadataRefresh(
  value: JourneyInspection,
  expectedTmdbAddress: string,
  expectedOmdbAddress: string,
  priorSourceRecordIds: readonly string[],
): void {
  const accepted = acceptedProjection(value, "legacy");
  assert.equal(value.execution.outcome, "accepted");
  assert.equal(value.execution.selection.intent, "metadata-refresh");
  assert.ok(
    accepted.recognitionSourceAssociation,
    "refreshed TMDB film must retain its recognition source",
  );
  assert.equal(
    accepted.recognitionSourceAssociation.nativeAddress,
    expectedTmdbAddress,
  );
  assert.deepEqual(currentSourceAssociations(accepted), [
    { sourceIdentity: "omdb", nativeAddress: expectedOmdbAddress },
    { sourceIdentity: "tmdb", nativeAddress: expectedTmdbAddress },
  ]);
  assert.deepEqual(
    new Set(value.sourceRecords.map((record) => record.sourceIdentity)),
    new Set(["omdb", "tmdb"]),
    "ordinary metadata refresh must follow each current Source Association",
  );
  assert.ok(
    value.sourceRecords.some((record) => record.sourceIdentity === "tmdb"),
    "metadata refresh must retain at least one new TMDB record",
  );
  assert.ok(
    value.sourceRecords.some((record) => record.sourceIdentity === "omdb"),
    "metadata refresh must retain one new OMDb record",
  );
  assert.ok(
    value.sourceRecords.every(
      (record) => !priorSourceRecordIds.includes(record.id),
    ),
    "each refresh source record must be new rather than reused history",
  );
  const sourceRefreshRuns = value.sourceRefreshRuns ?? [];
  assert.equal(
    sourceRefreshRuns.length,
    2,
    "metadata refresh must retain one independent domain run for each current source",
  );
  assert.ok(
    sourceRefreshRuns.every(
      (run) => run.phase === "terminal" && run.outcome === "succeeded",
    ),
    "each current source refresh run must succeed independently",
  );
  assert.deepEqual(
    new Set(value.execution.sourceRefreshRunIds ?? []),
    new Set(sourceRefreshRuns.map((run) => run.id)),
    "workflow execution must reference every authoritative source refresh run",
  );
  assert.ok(
    value.execution.dispositions.every(
      (disposition) => !disposition.key.startsWith("source-refresh:"),
    ),
    "workflow dispositions must not duplicate Source Refresh Run authority",
  );
}

function assertBdmvPackage(accepted: AcceptedProjection): void {
  const primaryCover = accepted.artifactAssociations.filter(
    (item) => item.role === "asset.primary-cover",
  );
  const delivered = accepted.artifactAssociations.filter(
    (item) => item.role === "asset.material-delivered",
  );
  assert.equal(primaryCover.length, 1, "BDMV must retain one managed cover");
  assert.equal(
    delivered.length,
    1,
    "BDMV must retain one delivered package Artifact",
  );
  const observed = accepted.locations.filter(
    (item) => item.kind === "observed",
  );
  assert.equal(observed.length, 1, "BDMV is one observed package Artifact");
  assert.equal(observed[0]?.artifactId, delivered[0]?.artifactId);
  assert.equal(
    accepted.artifacts.length,
    2,
    "no isolated artifacts may be admitted beside the managed cover and observed package",
  );
  assert.deepEqual(
    new Set(accepted.artifacts.map((item) => item.id)),
    new Set([primaryCover[0]?.artifactId, delivered[0]?.artifactId]),
  );
}

const journey: CliJourney = {
  name: "tmdb-omdb-live",
  modes: ["source", "distribution"],
  async setup(context) {
    if (
      !present(process.env.DIGITAL_TMDB_ACCESS_TOKEN) ||
      !present(process.env.DIGITAL_OMDB_API_KEY)
    )
      throw new Error(
        "TMDB and OMDb live journey requires DIGITAL_TMDB_ACCESS_TOKEN and DIGITAL_OMDB_API_KEY",
      );
    const roots = movieRoots(context);
    const deepIntegrity = process.env.DIGITAL_DEEP_CORPUS_INTEGRITY === "1";
    const before = await captureFixedCorpusSnapshots(roots, deepIntegrity);
    const deepBefore = deepIntegrity
      ? fixedCorpusContentDigestsFromSnapshots(roots, before)
      : undefined;
    if (deepBefore !== undefined)
      await assertFixedCorpusContentBaselineSubset(context, deepBefore);
    stateByWorkDirectory.set(stateKey(context), {
      roots,
      before,
      ...(deepBefore === undefined ? {} : { deepBefore }),
    });
  },
  commands(context) {
    const state = currentState(context);
    const strict = selectedRoot(state, strictFilmLogicalRoot);
    const directed = selectedRoot(state, directedBdmvLogicalRoot);
    const env = {
      DIGITAL_PRODUCT_DATA: path.join(context.workDir, "product-data"),
      DIGITAL_TMDB_ACCESS_TOKEN: process.env.DIGITAL_TMDB_ACCESS_TOKEN!,
      DIGITAL_OMDB_API_KEY: process.env.DIGITAL_OMDB_API_KEY!,
    };
    const live = { env, haltOnFailure: true as const };
    return [
      {
        ...live,
        name: "register strict TMDB film root",
        args: [
          "library-create",
          "恐怖直播 验收语料",
          "--directory",
          strict.directory,
          "--json",
        ],
      },
      {
        ...live,
        name: "register directed BDMV film root",
        args: [
          "library-create",
          "怒火救援 验收语料",
          "--directory",
          directed.directory,
          "--json",
        ],
      },
      {
        ...live,
        name: "live accept strict TMDB film with OMDb enrichment",
        args: (results) => [
          "scan",
          registeredObservedRootId(results[0]),
          "--scope",
          ".",
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
      },
      {
        ...live,
        name: "live no-change strict TMDB film after SQLite restart",
        args: (results) => [
          "scan",
          registeredObservedRootId(results[0]),
          "--scope",
          ".",
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
      },
      {
        ...live,
        name: "live refresh strict film metadata from current sources",
        args: (results) => [
          "refresh-metadata",
          acceptedAssetId(results[2], "legacy"),
          "--json",
        ],
      },
      {
        ...live,
        name: "live inspect refreshed strict film projection",
        args: (results) => ["inspect", executionId(results[4]), "--json"],
      },
      {
        ...live,
        name: "live accept directed BDMV film with OMDb enrichment",
        args: (results) => [
          "scrape-source",
          registeredObservedRootId(results[1]),
          "tmdb",
          JSON.stringify({ movie: directedBdmvAddress }),
          "--scope",
          ".",
          "--json",
        ],
      },
      {
        ...live,
        name: "live inspect directed BDMV film projection after SQLite restart",
        args: (results) => ["inspect", executionId(results[6]), "--json"],
      },
      {
        ...live,
        name: "live refresh directed BDMV film metadata from current sources",
        args: (results) => [
          "refresh-metadata",
          acceptedAssetId(results[6], "itemized"),
          "--json",
        ],
      },
      {
        ...live,
        name: "live inspect refreshed directed BDMV film projection",
        args: (results) => ["inspect", executionId(results[8]), "--json"],
      },
    ];
  },
  async assertions({ context, results: allResults }) {
    for (const registeredRoot of allResults.slice(0, 2)) {
      assert.equal(registeredRoot.exitCode, 0, registeredRoot.stderr);
      registeredObservedRootId(registeredRoot);
    }
    const results = allResults.slice(2);
    assert.equal(results.length, 8);
    for (const result of results) {
      assert.equal(
        result.exitCode,
        0,
        `${result.commandName} failed: ${result.stderr}`,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      for (const secret of [
        process.env.DIGITAL_TMDB_ACCESS_TOKEN,
        process.env.DIGITAL_OMDB_API_KEY,
      ]) {
        if (secret !== undefined && secret.length > 0)
          assert.doesNotMatch(
            output,
            new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
          );
      }
      assert.doesNotMatch(output, /Bearer\s+[^\s]+/u);
    }

    const strict = inspection(results[0]);
    assertSourceEnrichedFilm(
      strict,
      strictFilmAddress,
      strictFilmOmdbAddress,
      "legacy",
    );
    const strictAccepted = acceptedProjection(strict, "legacy");
    const strictRecordIds = strict.sourceRecords.map((record) => record.id);

    const strictNoChange = inspection(results[1]);
    assert.equal(strictNoChange.execution.outcome, "no-change");
    assert.equal(
      strictNoChange.execution.reusedExecutionId,
      strict.execution.id,
    );
    assert.deepEqual(strictNoChange.sourceRecords, []);
    assertSameAcceptedProjection(
      strictAccepted,
      acceptedProjection(strictNoChange, "legacy"),
    );

    const strictRefresh = inspection(results[2]);
    assertMetadataRefresh(
      strictRefresh,
      strictFilmAddress,
      strictFilmOmdbAddress,
      strictRecordIds,
    );
    const strictInspection = inspection(results[3]);
    assertSourceEnrichedFilm(
      strictInspection,
      strictFilmAddress,
      strictFilmOmdbAddress,
      "legacy",
    );
    assert.equal(strictInspection.execution.id, strictRefresh.execution.id);

    const directed = inspection(results[4]);
    assertSourceEnrichedFilm(
      directed,
      directedBdmvAddress,
      directedBdmvOmdbAddress,
      "itemized",
    );
    assert.equal(directed.execution.snapshot?.files.length, 105);
    const directedAccepted = acceptedProjection(directed, "itemized");
    assertBdmvPackage(directedAccepted);
    const directedRecordIds = directed.sourceRecords.map((record) => record.id);

    const directedInspection = inspection(results[5]);
    assertSourceEnrichedFilm(
      directedInspection,
      directedBdmvAddress,
      directedBdmvOmdbAddress,
      "itemized",
    );
    assert.equal(directedInspection.execution.id, directed.execution.id);
    const directedRefresh = inspection(results[6]);
    assertMetadataRefresh(
      directedRefresh,
      directedBdmvAddress,
      directedBdmvOmdbAddress,
      directedRecordIds,
    );
    const refreshedDirectedInspection = inspection(results[7]);
    assertSourceEnrichedFilm(
      refreshedDirectedInspection,
      directedBdmvAddress,
      directedBdmvOmdbAddress,
      "legacy",
    );
    assert.equal(
      refreshedDirectedInspection.execution.id,
      directedRefresh.execution.id,
    );

    const state = currentState(context);
    const after = await captureFixedCorpusSnapshots(
      state.roots,
      state.deepBefore !== undefined,
    );
    assert.deepEqual(
      after,
      state.before,
      "live journey must not alter either source tree",
    );
    if (state.deepBefore !== undefined) {
      assert.deepEqual(
        fixedCorpusContentDigestsFromSnapshots(state.roots, after),
        state.deepBefore,
      );
    }
  },
};

export default journey;
