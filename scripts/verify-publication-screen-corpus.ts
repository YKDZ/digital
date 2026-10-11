import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  deleteEnvironment,
  inspectEnvironment,
  prepareEnvironment,
  startEnvironment,
  stopEnvironment,
} from "../packages/environment/src/index.ts";
import { loadControlledSourceIo } from "../packages/test-support/src/source-io.ts";
import {
  configurePublicationScreenSources,
  intakePublicationScreenCase,
} from "./preview-corpus.ts";
import {
  createProductClient,
  digestDirectory,
  type JsonObject,
  type JsonValue,
  type ProductClient,
} from "./preview-product.ts";

type CorpusCase = {
  readonly id: string;
  readonly kind: "epub" | "pdf" | "anime" | "film";
  readonly directory: string;
  readonly title?: string;
  readonly formatFacts?: readonly {
    readonly property: string;
    readonly value: string;
  }[];
  readonly publications?: readonly {
    readonly relativePath: string;
    readonly pageCount: number;
    readonly documentAuthor: string;
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
  readonly tmdbOverview?: string;
  readonly omdbAwards?: string;
};
const workspacePath = path.resolve(import.meta.dirname, "..");
const fixture = path.join(
  workspacePath,
  "fixtures/preview-corpus/publication-screen",
);
const environment = process.argv[2];
const evidencePath = process.argv[3];
const port = Number(process.argv[4]);
assert(
  environment && evidencePath && Number.isInteger(port),
  "用法：node scripts/verify-publication-screen-corpus.ts <独立环境名> <证据文件> <空闲端口> [资料ID…]",
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
const object = (value: JsonValue | undefined): JsonObject => {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "产品结果应为对象",
  );
  return value as JsonObject;
};
const array = (value: JsonValue | undefined): readonly JsonValue[] => {
  assert(Array.isArray(value), "产品结果应为数组");
  return value;
};
const string = (value: JsonValue | undefined): string => {
  assert.equal(typeof value, "string");
  return value as string;
};
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

function acceptedItems(inspection: JsonObject): readonly JsonObject[] {
  return array(inspection["itemResults"])
    .map(object)
    .map((item) => object(item["accepted"]));
}
function facts(accepted: JsonObject): readonly JsonObject[] {
  return array(object(accepted["facts"])["descriptions"])
    .map(object)
    .flatMap((description) =>
      array(description["metadata"])
        .map(object)
        .flatMap((m) => {
          const result = object(m["result"]);
          return result["status"] === "resolved"
            ? array(result["values"]).map(object)
            : [];
        }),
    );
}
function assertFact(
  actual: readonly JsonObject[],
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
async function checkCover(
  client: ProductClient,
  asset: JsonObject,
  expectedBytes?: Buffer,
): Promise<JsonObject> {
  const cover = string(asset["cover"]);
  const image = await client.bytes(cover.replace(/^\/api/u, ""));
  assert.equal(image.status, 200);
  assert(image.mediaType === "image/png" || image.mediaType === "image/jpeg");
  assert(image.bytes.length > 0);
  if (expectedBytes) assert.deepEqual(Buffer.from(image.bytes), expectedBytes);
  return {
    status: image.status,
    mediaType: image.mediaType,
    byteLength: image.bytes.length,
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
  let client = createProductClient(started.run.address, {
    signal: controller.signal,
  });
  assert.equal((await client.readiness()).ready, true);
  evidence["connections"] = await configurePublicationScreenSources(
    client,
    cases,
    port,
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
    const rootId = intake.observedRootIds[0];
    assert(rootId);
    if (c.directed)
      assert.equal(intake.assetIds.length, 0, "非规范收藏包不应自动制造资产");
    const observed = await client.get("/intake", { rootId });
    assert.equal(observed.status, 200);
    const files = array(object(observed.body)["files"]).map(object);
    assert(files.length > 0);
    result["observed"] = observed.body;
    const assetIds = [
      ...new Set(files.flatMap((file) => array(file["assetIds"]).map(string))),
    ];
    assert.equal(
      assetIds.length,
      c.kind === "pdf"
        ? c.publications?.length
        : c.kind === "anime"
          ? c.episodes?.length
          : 1,
      `${c.id} 的正式材料归属数量错误`,
    );
    result["assetIds"] = assetIds;
    await save();
  }
  // Web 与 CLI 顺序持有同一产品数据，沿正式扫描入口请求封面并读回格式和来源事实。
  evidence["stopForCli"] = await stopEnvironment({
    workspacePath,
    environment,
  });
  assert.equal(
    (evidence["stopForCli"] as { status: string }).status,
    "stopped",
  );
  for (const [index, c] of cases.entries()) {
    const result = results[index]!;
    const intake = result["intake"] as {
      observedRootIds: readonly string[];
      assetLibraryId: string;
    };
    const args = [
      "apps/cli/dist/cli.js",
      "scan",
      intake.observedRootIds[0]!,
      "--scope",
      ".",
      "--library",
      intake.assetLibraryId,
      ...(c.kind === "anime"
        ? []
        : ["--require-artifact-role", "asset.primary-cover"]),
      "--json",
    ];
    const cli = await promisify(execFile)(process.execPath, args, {
      cwd: workspacePath,
      signal: controller.signal,
      env: {
        ...process.env,
        DIGITAL_PRODUCT_DATA: prepared.environment.productDataRoot,
        DIGITAL_SOURCE_IO_MODE: "controlled",
        DIGITAL_SOURCE_IO_CONFIG: manifestPath,
        DIGITAL_SOURCE_IO_IDENTITY: controlled.contentIdentity,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    const inspection = object(JSON.parse(cli.stdout) as JsonValue);
    result["cli"] = { args, stderr: cli.stderr, inspection };
    await save();
    const accepted = acceptedItems(inspection);
    assert.equal(accepted.length, (result["assetIds"] as string[]).length);
    for (const a of accepted) {
      const actual = facts(a);
      if (c.kind === "epub") {
        for (const expected of c.formatFacts ?? [])
          assertFact(
            actual,
            expected.property,
            String(expected.value),
            "local-observed",
          );
        if (c.official)
          for (const expected of c.official.expectedMetadata)
            assertFact(actual, expected.property, expected.value, "nbinet");
      } else if (c.kind === "pdf") {
        assertFact(
          actual,
          "pdf.document-author",
          c.publications![0]!.documentAuthor,
          "local-observed",
        );
        assertFact(actual, "pdf.page-count", "1", "local-observed");
      } else if (c.kind === "film") {
        assertFact(actual, "asset.introduction", c.tmdbOverview!, "tmdb");
        assertFact(actual, "asset.awards", c.omdbAwards!, "omdb");
        assertFact(actual, "external.imdb-id", c.imdb!, "tmdb");
      } else {
        const associations = array(
          object(a["facts"])["sourceAssociations"],
        ).map(object);
        const episode = c.episodes!.find((ep) =>
          associations.some(
            (s) =>
              s["sourceIdentity"] === "bangumi" &&
              s["nativeAddress"] ===
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
        const relationships = array(object(a["facts"])["relationships"]).map(
          object,
        );
        assert(relationships.length > 0, "剧集必须保留作品关系");
        if (episode.season === 2) {
          const related = array(object(a["facts"])["relatedEntities"]).map(
            object,
          );
          const predecessor = related.find(
            (e) =>
              e["sourceIdentity"] === "bangumi" &&
              e["identityNamespace"] === "bangumi.subject" &&
              e["sourceKey"] === "400602",
          );
          const sequel = related.find(
            (e) =>
              e["sourceIdentity"] === "bangumi" &&
              e["identityNamespace"] === "bangumi.subject" &&
              e["sourceKey"] === "515759",
          );
          assert(predecessor && sequel);
          assert(
            relationships.some(
              (r) =>
                r["type"] === "bangumi.subject.related" &&
                array(r["participants"])
                  .map(object)
                  .some(
                    (p) =>
                      p["role"] === "bangumi.subject.predecessor" &&
                      p["entityId"] === predecessor["id"],
                  ) &&
                array(r["participants"])
                  .map(object)
                  .some(
                    (p) =>
                      p["role"] === "bangumi.subject.sequel" &&
                      p["entityId"] === sequel["id"],
                  ),
            ),
            "第二季必须保留精确跨季作品关系",
          );
        }
      }
    }
    result["parsedFactsVerified"] = true;
  }
  const restarted = await startEnvironment({
    workspacePath,
    environment,
    signal: controller.signal,
  });
  evidence["restart"] = restarted;
  assert.equal(restarted.status, "ready");
  assert(restarted.run.address);
  client = createProductClient(restarted.run.address, {
    signal: controller.signal,
  });
  for (const [index, c] of cases.entries()) {
    const result = results[index]!;
    const details: JsonValue[] = [];
    for (const id of result["assetIds"] as string[]) {
      const detail = await client.get(`/catalogue/${id}`);
      assert.equal(detail.status, 200);
      const asset = object(object(detail.body)["asset"]);
      if (c.kind === "epub")
        assert.equal(asset["title"], c.official?.title ?? c.title);
      if (c.kind === "film") assert.equal(asset["title"], c.title);
      const expected =
        c.kind === "epub" || c.kind === "film"
          ? await readFile(path.join(fixture, "responses/cover.png"))
          : c.kind === "anime"
            ? await readFile(path.join(fixture, "responses/cover.jpg"))
            : undefined;
      details.push({
        asset,
        ...(c.kind === "anime"
          ? {}
          : { coverRead: await checkCover(client, asset, expected) }),
      });
    }
    if (c.kind === "anime") {
      const catalogue = await client.get("/catalogue");
      assert.equal(catalogue.status, 200);
      const groups = array(object(catalogue.body)["assets"])
        .map(object)
        .filter((g) => g["component"] === "bangumi");
      const works = groups.flatMap((g) => array(g["works"]).map(object));
      const currentWorks: JsonValue[] = [];
      for (const subject of new Set(c.episodes!.map((ep) => ep.subject))) {
        const matches = works.filter(
          (w) =>
            w["officialPage"] === `https://bgm.tv/subject/${String(subject)}`,
        );
        assert.equal(matches.length, 1, "每个官方作品应有唯一浏览投影");
        const work = matches[0]!;
        const episodes = array(work["episodes"]).map(object);
        for (const ep of c.episodes!.filter((ep) => ep.subject === subject)) {
          const matches = episodes.filter(
            (e) =>
              e["officialPage"] ===
              `https://bgm.tv/episode/${String(ep.episode)}`,
          );
          assert.equal(matches.length, 1);
          assert.equal(matches[0]!["localPosition"], ep.local);
          assert.equal(matches[0]!["continuousPosition"], ep.sort);
          assert(
            (result["assetIds"] as string[]).includes(
              string(matches[0]!["assetId"]),
            ),
          );
        }
        currentWorks.push({
          work,
          coverRead: await checkCover(
            client,
            work,
            await readFile(path.join(fixture, "responses/cover.jpg")),
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
