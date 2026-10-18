import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  deleteEnvironment,
  inspectEnvironment,
  prepareEnvironment,
  startEnvironment,
  stopEnvironment,
} from "@digital/environment";
import {
  createPublicApiClient,
  type PublicCurrentAsset,
  type PublicExecutionInspection,
} from "@digital/public-api";
import { loadControlledSourceIo } from "@digital/test-support/source-io";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import {
  artifactRoleAddress,
  configurePublicationScreenSources,
  createCorpusClient,
  currentMetadataValues,
  hasArtifactRole,
  intakePublicationScreenCase,
  listAllAssets,
  waitForAssetLibraryScan,
  waitForProductReady,
  type CurrentMetadataValue,
  type IntakeOutcome,
} from "./corpus-verification.ts";
import { requireInput } from "./inputs.ts";
import { digestDirectory } from "./material-digest.ts";

type CorpusCase = {
  readonly id: string;
  readonly kind: "epub" | "pdf" | "anime" | "film";
  readonly directory: string;
  readonly title?: string;
  readonly coverBytes?: string;
  readonly formatFacts?: readonly {
    readonly property: string;
    readonly value: string;
  }[];
  readonly publications?: readonly {
    readonly relativePath: string;
    readonly pageCount: number;
    readonly documentAuthor: string;
    readonly coverReferenceImage: string;
  }[];
  readonly bangumiSubjects?: readonly {
    readonly subject: number;
    readonly title: string;
    readonly summary: string;
    readonly coverBytes: string;
  }[];
  readonly official?: {
    readonly isbn: string;
    readonly title: string;
    readonly expectedMetadata: readonly {
      readonly property: string;
      readonly value: string;
    }[];
  };
  readonly episodes?: readonly {
    readonly path: string;
    readonly subject: number;
    readonly episode: number;
    readonly season: number;
    readonly local: number;
    readonly sort: number;
  }[];
  readonly directed?: boolean;
  readonly tmdb?: number;
  readonly imdb?: string;
  readonly date?: string;
  readonly year?: number;
  readonly files?: readonly string[];
  readonly tmdbOverview?: string;
  readonly tmdbFacts?: readonly {
    readonly property: string;
    readonly value: string;
  }[];
  readonly directors?: readonly string[];
  readonly omdbAwards?: string;
  readonly sourceFailures?: readonly {
    readonly sourceIdentity: string;
    readonly reason: string;
  }[];
};
const workspacePath = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
const fixture = requireInput("DIGITAL_AUTOMATION_SOURCE_DIRECTORY");
const environment = process.argv[2];
const evidenceArgument = process.argv[3];
const evidencePath =
  evidenceArgument === undefined
    ? undefined
    : path.resolve(workspacePath, evidenceArgument);
const port = Number(process.argv[4]);
assert(
  environment && evidencePath && Number.isInteger(port),
  "用法：pnpm verify:publication-screen <独立环境名> <证据文件> <空闲端口> [资料ID…]",
);
const selected = process.argv.slice(5);
const all = JSON.parse(
  await readFile(path.join(fixture, "cases.json"), "utf8"),
) as { readonly cases: readonly CorpusCase[] };
const cases =
  selected.length === 0
    ? all.cases
    : all.cases.filter((c) => selected.includes(c.id));
assert(
  cases.length > 0 && selected.every((id) => cases.some((c) => c.id === id)),
  "资料选择包含未知ID",
);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));
const before = await digestDirectory(path.join(fixture, "material"));
const results: Record<string, unknown>[] = [];
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  workspacePath,
  environment,
  selected: cases.map((c) => c.id),
  materialsBefore: before,
  cases: results,
};
const save = async (): Promise<void> => {
  await mkdir(path.dirname(path.resolve(evidencePath)), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, undefined, 2)}\n`);
};
let owned = false;
let passed = false;

function facts(asset: PublicCurrentAsset): readonly CurrentMetadataValue[] {
  const properties = [
    ...new Set(
      asset.descriptions.flatMap(({ metadata }) =>
        metadata.map(({ property }) => property),
      ),
    ),
  ];
  return properties.flatMap((property) =>
    currentMetadataValues(asset, property),
  );
}
function assertFact(
  actual: readonly CurrentMetadataValue[],
  property: string,
  value: string,
  source?: string,
): void {
  assert(
    actual.some(
      (f) =>
        f["property"] === property &&
        f["value"] === value &&
        (source === undefined || f["sourceIdentity"] === source),
    ),
    `缺少独立预期事实 ${property}=${value}（${source ?? "任意来源"}）`,
  );
}
function assertLocalFormatFact(
  actual: readonly CurrentMetadataValue[],
  property: string,
  value: string,
  sourceSlotPrefix: "opf." | "pdf.",
): void {
  assert(
    actual.some(
      (fact) =>
        fact.property === property &&
        fact.value === value &&
        fact.sourceIdentity === "local-observed" &&
        fact.sourceSlot.startsWith(sourceSlotPrefix),
    ),
    `缺少独立预期本地格式事实 ${property}=${value}（${sourceSlotPrefix}）`,
  );
}
async function checkCover(
  client: ReturnType<typeof createPublicApiClient>,
  asset: PublicCurrentAsset,
  expectedBytes?: Buffer,
): Promise<Record<string, unknown>> {
  const address = artifactRoleAddress(asset, "asset.primary-cover");
  assert(address, `${asset.id} 没有公开的封面角色地址`);
  const digest = address.split("/").at(-1);
  assert(digest);
  const image = await client.readManagedArtifact(digest);
  assert.equal(image.status, 200);
  const mediaType = image.headers.get("content-type")?.split(";", 1)[0];
  assert(mediaType === "image/png" || mediaType === "image/jpeg");
  const bytes = new Uint8Array(await image.arrayBuffer());
  assert(bytes.length > 0);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedBytes)
    assert.equal(
      sha256,
      createHash("sha256").update(expectedBytes).digest("hex"),
      "正式封面字节必须与独立参考摘要相同",
    );
  return {
    status: image.status,
    mediaType,
    byteLength: bytes.length,
    sha256,
  };
}
async function checkPdfCover(
  client: ReturnType<typeof createPublicApiClient>,
  asset: PublicCurrentAsset,
  publication: NonNullable<CorpusCase["publications"]>[number],
  publications: NonNullable<CorpusCase["publications"]>,
): Promise<Record<string, unknown>> {
  const address = artifactRoleAddress(asset, "asset.primary-cover");
  assert(address, `${asset.id} 没有公开的封面角色地址`);
  const digest = address.split("/").at(-1);
  assert(digest);
  const image = await client.readManagedArtifact(digest);
  assert.equal(image.status, 200);
  assert.equal(
    image.headers.get("content-type")?.split(";", 1)[0],
    "image/png",
  );
  const imageBytes = Buffer.from(await image.arrayBuffer());
  assert(imageBytes.length > 0);
  const actual = await loadImage(imageBytes);
  const references = await Promise.all(
    publications.map(async (candidate) => ({
      publication: candidate,
      image: await loadImage(
        await readFile(path.join(fixture, candidate.coverReferenceImage)),
      ),
    })),
  );
  const expected = references.find(
    (candidate) =>
      candidate.publication.coverReferenceImage ===
      publication.coverReferenceImage,
  );
  assert(expected, "PDF 册必须有唯一独立渲染参考");
  const width = expected.image.width;
  const height = expected.image.height;
  assert(width > 0 && height > 0);
  assert.equal(actual.width, width, "托管 PDF PNG 宽度必须匹配独立首页渲染");
  assert.equal(actual.height, height, "托管 PDF PNG 高度必须匹配独立首页渲染");
  const pixels = (source: typeof actual): Uint8ClampedArray => {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  };
  const actualPixels = pixels(actual);
  const meanRgbDifference = (reference: typeof actual): number => {
    const referencePixels = pixels(reference);
    let difference = 0;
    let channels = 0;
    for (let index = 0; index < actualPixels.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        difference += Math.abs(
          actualPixels[index + channel]! - referencePixels[index + channel]!,
        );
        channels += 1;
      }
    }
    return difference / channels;
  };
  const differences = references.map((candidate) => ({
    reference: candidate.publication.coverReferenceImage,
    meanRgbDifference: meanRgbDifference(candidate.image),
  }));
  const correct = differences.find(
    (candidate) => candidate.reference === publication.coverReferenceImage,
  );
  assert(correct);
  assert(
    correct.meanRgbDifference <= 12,
    `托管 PDF PNG 与本册独立首页的 RGB 均差过大：${correct.meanRgbDifference}`,
  );
  const wrongBooks = differences.filter(
    (candidate) => candidate.reference !== publication.coverReferenceImage,
  );
  assert.equal(wrongBooks.length, publications.length - 1);
  for (const wrongBook of wrongBooks)
    assert(
      wrongBook.meanRgbDifference > 12,
      `托管 PDF PNG 不得被错误册参考接受：${wrongBook.reference}`,
    );
  return {
    status: image.status,
    mediaType: image.headers.get("content-type"),
    byteLength: imageBytes.length,
    sha256: createHash("sha256").update(imageBytes).digest("hex"),
    width,
    height,
    reference: publication.coverReferenceImage,
    meanRgbDifference: correct.meanRgbDifference,
    wrongBookDifferences: wrongBooks,
  };
}
async function checkMaterialRange(
  client: ReturnType<typeof createPublicApiClient>,
  asset: PublicCurrentAsset,
  assetLibraryId: string,
  relativePath: string,
): Promise<Record<string, unknown>> {
  const expected = await readFile(path.join(fixture, relativePath));
  assert(expected.byteLength > 0, `${relativePath} 必须保留有效媒体字节`);
  const end = Math.min(63, expected.byteLength - 1);
  const location = asset.locations.find(({ address }) =>
    address.endsWith(relativePath),
  );
  assert(location, `${asset.id} 缺少公开材料位置 ${relativePath}`);
  const byteRange = `bytes=0-${String(end)}`;
  let revisionId: string;
  let observedRange: Record<string, unknown> | undefined;
  if (location.content.status === "unconfirmed") {
    const observed = await client.readObservedMaterial(asset.id, location.id, {
      assetLibraryId,
      range: byteRange,
      signal: controller.signal,
    });
    if (observed.status !== 206)
      assert.fail(
        `${relativePath} 的观察材料应支持 HTTP 字节范围：${observed.status} ${await observed.text()}`,
      );
    assert.equal(
      observed.headers.get("content-range"),
      `bytes 0-${String(end)}/${String(expected.byteLength)}`,
    );
    const observedBytes = Buffer.from(await observed.arrayBuffer());
    assert.deepEqual(observedBytes, expected.subarray(0, end + 1));
    observedRange = {
      status: observed.status,
      contentRange: observed.headers.get("content-range"),
      byteLength: observedBytes.byteLength,
      sha256: createHash("sha256").update(observedBytes).digest("hex"),
    };
    const confirmed = await client.confirmObservedMaterial(
      asset.id,
      location.id,
      assetLibraryId,
    );
    assert.equal(confirmed.byteLength, expected.byteLength);
    revisionId = confirmed.artifactRevisionId;
  } else {
    revisionId = location.content.target.revisionId;
  }
  const response = await client.readArtifactRevision(revisionId, {
    assetLibraryId,
    range: byteRange,
    signal: controller.signal,
  });
  if (response.status !== 206)
    assert.fail(
      `${relativePath} 应支持 HTTP 字节范围：${response.status} ${await response.text()}`,
    );
  assert.equal(
    response.headers.get("content-range"),
    `bytes 0-${String(end)}/${String(expected.byteLength)}`,
  );
  const actual = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(actual, expected.subarray(0, end + 1));
  return {
    ...(observedRange === undefined ? {} : { observedRange }),
    status: response.status,
    contentRange: response.headers.get("content-range"),
    byteLength: actual.byteLength,
    sha256: createHash("sha256").update(actual).digest("hex"),
  };
}
try {
  const prior = await inspectEnvironment({ workspacePath, environment });
  evidence["prior"] = prior;
  assert.equal(prior.status, "ok");
  assert.equal(prior.state, "unprepared", "资料验证必须使用独立新环境");
  owned = true;
  const manifestPath = path.join(fixture, "manifest.json");
  const controlled = await loadControlledSourceIo({ manifestPath });
  evidence["contentIdentity"] = controlled.contentIdentity;
  const prepared = await prepareEnvironment({
    workspacePath,
    environment,
    inputs: cases.map((c) => path.join(fixture, c.directory)),
    sourceMode: "controlled",
    signal: controller.signal,
    config: {
      webPort: port,
      sourceIo: { manifestPath, contentIdentity: controlled.contentIdentity },
    },
  });
  evidence["prepare"] = prepared;
  await save();
  assert.equal(prepared.status, "prepared");
  const started = await startEnvironment({
    workspacePath,
    environment,
    signal: controller.signal,
  });
  evidence["start"] = started;
  await save();
  assert.equal(started.status, "ready");
  assert(started.run.address);
  await waitForProductReady(started.run.address, controller.signal);
  let client = createCorpusClient(started.run.address, controller.signal);
  assert(
    (await client.listAssetLibraryOptions()).recognitionProfiles.length > 0,
  );
  evidence["connections"] = await configurePublicationScreenSources(
    client,
    cases,
    started.run.address,
    controller.signal,
  );
  for (const c of cases) {
    const { intake, operations } = await intakePublicationScreenCase(
      client,
      fixture,
      c,
    );
    const result: Record<string, unknown> = {
      id: c.id,
      kind: c.kind,
      intake,
      ...operations,
    };
    results.push(result);
    await save();
    if (c.directed)
      assert.equal(intake.assetIds.length, 0, "非规范收藏包不应自动制造资产");
    if (c.sourceFailures) {
      const execution = result[
        "directedExecution"
      ] as PublicExecutionInspection;
      assert.equal(execution.status, "completed");
      assert.equal(execution.outcome, "partially-succeeded");
      assert.equal(execution.kind, "execution");
      if (execution.kind !== "execution")
        throw new Error("定向识别应返回正式执行检查结果");
      for (const expected of c.sourceFailures) {
        const failedSource = execution.progress.dispositions.find(
          (target) =>
            target.key.includes(expected.sourceIdentity) &&
            target.status === "failed",
        );
        assert(
          failedSource?.reason?.includes(expected.reason),
          `${expected.sourceIdentity} 应保留可核对的来源失败处置`,
        );
      }
      result["expectedSourceFailures"] = c.sourceFailures;
    }
    const directory = intake.directories.find(
      ({ path: directoryPath }) =>
        directoryPath === path.join(fixture, c.directory),
    );
    assert(directory, `${c.id} 缺少公开登记的素材目录`);
    const observed = await client.inspectLocalIntake({
      assetLibraryId: intake.assetLibraryId,
      directoryId: directory.id,
      parentExecutionId: intake.executionId,
    });
    const files = observed.files;
    assert(files.length > 0);
    result["observed"] = observed;
    const assetIds = new Set(files.flatMap((file) => file.assetIds));
    if (c.directed) {
      const targetDirectory = path.resolve(fixture, c.directory);
      for (const asset of await listAllAssets(client, intake.assetLibraryId))
        if (
          asset.locations.some((location) =>
            decodeURIComponent(location.address).includes(targetDirectory),
          )
        )
          assetIds.add(asset.id);
    }
    const selectedAssetIds = [...assetIds];
    assert.equal(
      selectedAssetIds.length,
      c.kind === "pdf"
        ? c.publications?.length
        : c.kind === "anime"
          ? c.episodes?.length
          : 1,
      `${c.id} 的正式材料归属数量错误`,
    );
    result["assetIds"] = selectedAssetIds;
    await save();
  }
  // 旧 CLI 的第二次正式扫描已收敛到唯一公共客户端，继续验证重扫后的当前结果。
  for (const [index, c] of cases.entries()) {
    const result = results[index]!;
    const intake = result["intake"] as IntakeOutcome;
    const scanStart = await client.startAssetLibraryScan(intake.assetLibraryId);
    const rescan = await waitForAssetLibraryScan(
      client,
      scanStart.parentExecutionId,
      300_000,
    );
    assert.equal(rescan.status, "completed");
    result["publicRescan"] = rescan;
    await save();
    const currentAssets = await listAllAssets(client, intake.assetLibraryId);
    const assetIds = result["assetIds"] as string[];
    const accepted = assetIds.map((assetId) => {
      const asset = currentAssets.find((candidate) => candidate.id === assetId);
      assert(asset, `${c.id} 公共重扫后缺少资产 ${assetId}`);
      return asset;
    });
    assert.equal(accepted.length, assetIds.length);
    result["publicScanAssets"] = accepted;
    for (const a of accepted) {
      const actual = facts(a);
      if (c.kind === "epub") {
        for (const expected of c.formatFacts ?? [])
          assertLocalFormatFact(
            actual,
            expected.property,
            String(expected.value),
            "opf.",
          );
        if (c.official)
          for (const expected of c.official.expectedMetadata)
            assertFact(actual, expected.property, expected.value, "nbinet");
      } else if (c.kind === "pdf") {
        assertLocalFormatFact(
          actual,
          "pdf.document-author",
          c.publications![0]!.documentAuthor,
          "pdf.",
        );
        assertLocalFormatFact(actual, "pdf.page-count", "1", "pdf.");
      } else if (c.kind === "film") {
        for (const expected of c.tmdbFacts ?? [])
          assertFact(actual, expected.property, expected.value, "tmdb");
        assertFact(actual, "external.imdb-id", c.imdb!, "tmdb");
        if (c.omdbAwards)
          assertFact(actual, "asset.awards", c.omdbAwards, "omdb");
        if (c.sourceFailures?.length) {
          assert.equal(
            actual.some(
              (fact) =>
                fact.property === "asset.awards" &&
                fact.sourceIdentity === "omdb",
            ),
            false,
            "未获取的 OMDb 记录不得提供奖项事实",
          );
          assert(
            !a.sourceAssociations.some(
              (association) => association.sourceIdentity === "omdb",
            ),
            "未获取的 OMDb 记录不得制造当前来源关联",
          );
          result["sourceFailureVerified"] = true;
        }
      } else {
        const associations = a.sourceAssociations;
        const episode = c.episodes!.find((ep) =>
          associations.some(
            (s) =>
              s.sourceIdentity === "bangumi" &&
              s.nativeAddress ===
                `https://bgm.tv/episode/${String(ep.episode)}`,
          ),
        );
        assert(episode, "剧集必须关联独立预期的官方身份");
        assertFact(
          actual,
          "bangumi.episode.season-position",
          String(episode.local),
          "bangumi",
        );
        assertFact(
          actual,
          "bangumi.episode.continuous-position",
          String(episode.sort),
          "bangumi",
        );
        const relationships = a.relationships;
        assert(relationships.length > 0, "剧集必须保留作品关系");
        if (episode.season === 2) {
          const related = a.relatedEntities;
          const predecessor = related.find(
            (e) =>
              e.sourceIdentity === "bangumi" &&
              e.identityNamespace === "bangumi.subject" &&
              e.sourceKey === "400602",
          );
          const sequel = related.find(
            (e) =>
              e.sourceIdentity === "bangumi" &&
              e.identityNamespace === "bangumi.subject" &&
              e.sourceKey === "515759",
          );
          assert(predecessor && sequel);
          assert(
            relationships.some(
              (r) =>
                r.type === "bangumi.subject.related" &&
                r.participants.some(
                  (p) =>
                    p.role === "bangumi.subject.predecessor" &&
                    p.entityId === predecessor.id,
                ) &&
                r.participants.some(
                  (p) =>
                    p.role === "bangumi.subject.sequel" &&
                    p.entityId === sequel.id,
                ),
            ),
            "第二季必须保留精确跨季作品关系",
          );
        }
      }
    }
    result["parsedFactsVerified"] = true;
  }
  const stopBeforeRestart = await stopEnvironment({
    workspacePath,
    environment,
  });
  evidence["stopBeforeRestart"] = stopBeforeRestart;
  assert(
    stopBeforeRestart.status === "stopped" ||
      stopBeforeRestart.status === "already-stopped",
    "重启前必须确认自有服务已停止",
  );
  const restarted = await startEnvironment({
    workspacePath,
    environment,
    signal: controller.signal,
  });
  evidence["restart"] = restarted;
  assert.equal(restarted.status, "ready");
  assert(restarted.run.address);
  await waitForProductReady(restarted.run.address, controller.signal);
  client = createCorpusClient(restarted.run.address, controller.signal);
  for (const [index, c] of cases.entries()) {
    const result = results[index]!;
    const intake = result["intake"] as IntakeOutcome;
    const assetLibraryId = intake.assetLibraryId;
    const details: unknown[] = [];
    const assets = await listAllAssets(client, assetLibraryId);
    const selectedAssets = (result["assetIds"] as string[]).map((id) => {
      const asset = assets.find((candidate) => candidate.id === id);
      assert(asset, `${c.id} 重启后缺少正式资产 ${id}`);
      return asset;
    });
    for (const asset of selectedAssets) {
      const actual = facts(asset);
      if (c.kind === "epub") {
        assertFact(actual, "asset.title", c.official?.title ?? c.title!);
        const introduction = c.formatFacts?.find(
          (fact) => fact.property === "asset.introduction",
        );
        if (introduction)
          assertFact(actual, "asset.introduction", introduction.value);
      }
      if (c.kind === "film") assertFact(actual, "asset.title", c.title!);
      const files = asset.locations;
      const publication =
        c.kind === "pdf"
          ? c.publications!.find((item) =>
              files.some((file) => file.address.endsWith(item.relativePath)),
            )
          : undefined;
      if (c.kind === "pdf")
        assert(publication, "PDF 资产必须匹配独立页封面预期");
      if (c.kind !== "anime") {
        const expected =
          c.kind === "epub" || c.kind === "film"
            ? await readFile(path.join(fixture, c.coverBytes!))
            : undefined;
        details.push({
          asset,
          coverRead:
            c.kind === "pdf"
              ? await checkPdfCover(
                  client,
                  asset,
                  publication!,
                  c.publications!,
                )
              : await checkCover(client, asset, expected),
        });
      }
      const materialPaths =
        c.kind === "epub"
          ? ["publication.epub"]
          : c.kind === "pdf"
            ? [publication!.relativePath]
            : c.kind === "anime"
              ? c
                  .episodes!.filter((episode) =>
                    files.some(
                      (file) =>
                        path.posix.basename(file.address) ===
                        path.posix.basename(episode.path),
                    ),
                  )
                  .map((episode) => episode.path)
              : c.files!;
      assert(materialPaths.length > 0, `${c.id} 没有匹配的正式材料路径`);
      const rangeReads: Record<string, unknown>[] = [];
      for (const relativePath of materialPaths)
        rangeReads.push(
          await checkMaterialRange(
            client,
            asset,
            assetLibraryId,
            path.join(c.directory, relativePath),
          ),
        );
      details.push({ rangeReads });
      if (c.kind === "film") {
        assertFact(actual, "asset.introduction", c.tmdbOverview!, "tmdb");
        assertFact(actual, "asset.release-date", c.date!, "tmdb");
        assert(
          actual.some(
            ({ property, value, sourceIdentity }) =>
              property === "asset.release-date" &&
              value.startsWith(String(c.year)) &&
              sourceIdentity === "tmdb",
          ),
        );
        assertFact(actual, "external.imdb-id", c.imdb!, "tmdb");
        for (const expected of c.tmdbFacts ?? [])
          if (expected.property === "asset.genre")
            assertFact(actual, expected.property, expected.value, "tmdb");
        const directorIds = asset.relationships
          .filter((relationship) => relationship.type === "asset.contribution")
          .flatMap((relationship) =>
            relationship.participants
              .filter((participant) => participant.role === "director")
              .map((participant) => participant.entityId),
          );
        const directors = asset.relatedEntities
          .filter(
            (entity) =>
              directorIds.includes(entity.id) &&
              entity.sourceIdentity === "tmdb",
          )
          .map(({ label }) => label);
        for (const director of c.directors ?? [])
          assert(directors.includes(director));
        if (c.omdbAwards)
          assertFact(actual, "asset.awards", c.omdbAwards, "omdb");
        if (c.sourceFailures?.length) {
          assert.equal(
            actual.some(
              ({ property, sourceIdentity }) =>
                (property === "asset.awards" ||
                  property.startsWith("rating.")) &&
                sourceIdentity === "omdb",
            ),
            false,
            "未获取的 OMDb 记录不得提供奖项或评分事实",
          );
          assert(
            !asset.sourceAssociations.some(
              ({ sourceIdentity }) => sourceIdentity === "omdb",
            ),
            "未获取 OMDb 记录不得制造当前来源关联",
          );
        }
      }
    }
    if (c.kind === "anime") {
      const currentWorks: unknown[] = [];
      for (const subject of new Set(
        c.episodes!.map((episode) => episode.subject),
      )) {
        const related = selectedAssets.flatMap(
          (asset) => asset.relatedEntities,
        );
        const work = related.find(
          (entity) =>
            entity.identityNamespace === "bangumi.subject" &&
            entity.sourceKey === String(subject),
        );
        assert(work, "每个官方作品应有唯一来源实体");
        const inspection = await client.inspectRelatedEntity(work.id);
        const expectedSubject = c.bangumiSubjects!.find(
          (expected) => expected.subject === subject,
        );
        assert(expectedSubject);
        assert(
          inspection.metadata.some(
            ({ property, value }) =>
              property === "bangumi.subject.name.zh-hans" &&
              value === expectedSubject.title,
          ),
        );
        assert(
          inspection.metadata.some(
            ({ property, value }) =>
              property === "bangumi.subject.description" &&
              value === expectedSubject.summary,
          ),
        );
        for (const episode of c.episodes!.filter(
          (entry) => entry.subject === subject,
        )) {
          const asset = selectedAssets.find((candidate) =>
            candidate.sourceAssociations.some(
              ({ sourceIdentity, nativeAddress }) =>
                sourceIdentity === "bangumi" &&
                nativeAddress ===
                  `https://bgm.tv/episode/${String(episode.episode)}`,
            ),
          );
          assert(asset, "每集必须关联独立预期的官方身份");
          assertFact(
            facts(asset),
            "bangumi.episode.season-position",
            String(episode.local),
            "bangumi",
          );
          assertFact(
            facts(asset),
            "bangumi.episode.continuous-position",
            String(episode.sort),
            "bangumi",
          );
          assert(
            asset.relationships.some(
              (relationship) =>
                relationship.type === "asset.membership" &&
                relationship.participants.some(
                  (participant) =>
                    participant.entityId === work.id &&
                    participant.role === "bangumi.subject.ordinary-episode",
                ),
            ),
            "剧集必须保留所属作品关系",
          );
        }
        const coverAsset =
          inspection.accepted.find((asset) =>
            hasArtifactRole(asset, "asset.primary-cover"),
          ) ??
          selectedAssets.find(
            (asset) =>
              asset.relatedEntities.some((entity) => entity.id === work.id) &&
              hasArtifactRole(asset, "asset.primary-cover"),
          );
        assert(coverAsset, "官方作品封面必须由公开当前资产角色读取");
        currentWorks.push({
          work: inspection,
          coverRead: await checkCover(
            client,
            coverAsset,
            await readFile(path.join(fixture, expectedSubject.coverBytes)),
          ),
        });
      }
      result["currentWorks"] = currentWorks;
    }
    result["details"] = details;
    result["restartReadable"] = true;
    result["passed"] = true;
    await save();
    process.stdout.write(`通过：${c.id}\n`);
  }
  evidence["materialsAfter"] = await digestDirectory(
    path.join(fixture, "material"),
  );
  assert.equal(evidence["materialsAfter"], before);
  passed = true;
} catch (error) {
  evidence["failure"] =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : String(error);
  process.stderr.write(`原始失败：${String(error)}\n`);
  process.exitCode = 1;
} finally {
  const saveErrors: { phase: string; message: string }[] = [];
  const cleanupErrors: { phase: string; message: string }[] = [];
  evidence["saveErrors"] = saveErrors;
  evidence["cleanupErrors"] = cleanupErrors;
  const saveDuringCleanup = async (phase: string): Promise<void> => {
    try {
      await save();
    } catch (error) {
      saveErrors.push({ phase, message: String(error) });
      process.stderr.write(`保存证据失败（${phase}）：${String(error)}\n`);
      process.exitCode = 1;
    }
  };
  evidence["passed"] = passed;
  await saveDuringCleanup("停止前");
  if (owned) {
    try {
      const stopped = await stopEnvironment({ workspacePath, environment });
      evidence["finalStop"] = stopped;
      if (stopped.status !== "stopped" && stopped.status !== "already-stopped")
        process.exitCode = 1;
    } catch (error) {
      cleanupErrors.push({ phase: "停止", message: String(error) });
      process.stderr.write(`停止服务失败：${String(error)}\n`);
      process.exitCode = 1;
    }
    await saveDuringCleanup("停止后");
    if (passed && process.exitCode !== 1) {
      try {
        const deleted = await deleteEnvironment({ workspacePath, environment });
        evidence["delete"] = deleted;
        if (
          deleted.status !== "deleted" &&
          deleted.status !== "already-deleted"
        )
          process.exitCode = 1;
      } catch (error) {
        cleanupErrors.push({ phase: "删除", message: String(error) });
        process.stderr.write(`删除环境失败：${String(error)}\n`);
        process.exitCode = 1;
      }
    }
  }
  evidence["materialsAfterCleanup"] = await digestDirectory(
    path.join(fixture, "material"),
  );
  if (evidence["materialsAfterCleanup"] !== before) {
    evidence["materialsChanged"] = true;
    process.exitCode = 1;
  }
  await saveDuringCleanup("结束");
}
