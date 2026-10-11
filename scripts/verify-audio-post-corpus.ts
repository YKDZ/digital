import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  deleteEnvironment,
  inspectEnvironment,
  prepareEnvironment,
  startEnvironment,
  stopEnvironment,
} from "../packages/environment/src/index.ts";
import { loadControlledSourceIo } from "../packages/test-support/src/source-io.ts";
import {
  configureAudioPostSources,
  intakeAudioPostCase,
} from "./preview-corpus.ts";
import {
  createProductClient,
  digestDirectory,
  type JsonObject,
  type JsonValue,
} from "./preview-product.ts";

/** 资料调用方只提交普通目录和来源配置，通过正式 HTTP 核对独立预期。 */
type CorpusCase = {
  readonly id: string;
  readonly kind: "audio" | "post" | "unrecognized";
  readonly directory: string;
  readonly title?: string;
  readonly circle?: string;
  readonly releaseDate?: string;
  readonly publishedDatetime?: string;
  readonly bodyText?: string;
  readonly cover?: "present" | "absent";
  readonly credits?: Readonly<Record<string, readonly string[]>>;
  readonly creditLabels?: readonly string[];
  readonly series?: { readonly label: string };
  readonly attachments?: readonly {
    readonly name: string;
    readonly byteLength: string;
  }[];
};

const workspacePath = path.resolve(import.meta.dirname, "..");
const fixture = path.join(workspacePath, "fixtures/preview-corpus/audio-posts");
const environment = process.argv[2];
const evidencePath = process.argv[3];
const port = Number(process.argv[4]);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));
assert(
  environment && evidencePath && Number.isInteger(port),
  "用法：node scripts/verify-audio-post-corpus.ts <独立环境名> <证据文件> <空闲端口> [资料ID…]",
);
const all = JSON.parse(
  await readFile(path.join(fixture, "cases.json"), "utf8"),
) as {
  readonly cases: readonly CorpusCase[];
};
const selected = process.argv.slice(5);
const cases =
  selected.length === 0
    ? all.cases
    : all.cases.filter((item) => selected.includes(item.id));
assert(
  cases.length > 0 &&
    selected.every((id) => cases.some((item) => item.id === id)),
  "资料选择包含未知ID",
);
const material = path.join(fixture, "material");
const before = await digestDirectory(material);
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  environment,
  workspacePath,
  selected: cases.map((item) => item.id),
  materialsBefore: before,
  cases: [],
};
const results: Record<string, unknown>[] = [];
evidence["cases"] = results;
const save = async (): Promise<void> => {
  await mkdir(path.dirname(path.resolve(evidencePath)), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, undefined, 2)}\n`);
};
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
const sleep = async (): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, 100));
let owned = false;
let passed = false;
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
    inputs: cases.map((item) => path.join(fixture, item.directory)),
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
  await configureAudioPostSources(client, fixture, cases);
  if (cases.some((item) => item.kind === "post"))
    evidence["sessionConfigured"] = true;
  for (const item of cases) {
    const intake = await intakeAudioPostCase(client, fixture, item);
    const rootId = intake.observedRootIds[0];
    assert(rootId);
    const observed = await client.get("/intake", { rootId });
    assert.equal(observed.status, 200);
    const files = array(object(observed.body)["files"]);
    assert(files.length > 0, `${item.id} 没有安全观察到文件`);
    const result: Record<string, unknown> = {
      id: item.id,
      kind: item.kind,
      intake,
      observed: observed.body,
    };
    results.push(result);
    await save();
    if (item.kind === "unrecognized") {
      assert.equal(
        intake.assetIds.length,
        0,
        `${item.id} 不应制造通用类别资产`,
      );
      assert(
        files.every((file) => array(object(file)["assetIds"]).length === 0),
      );
      result["unresolved"] = true;
    } else {
      assert.equal(
        intake.assetIds.length,
        1,
        `${item.id} 应由来源建立一个内容主体`,
      );
      const subjectId = intake.assetIds[0]!;
      let asset: JsonObject = {};
      // 内容读取可能发起正式信息履行；等待同一主体的所需封面，不能改选其他主体。
      const until = Date.now() + 300_000;
      do {
        const detail = await client.get(`/catalogue/${subjectId}`);
        assert.equal(detail.status, 200);
        asset = object(object(detail.body)["asset"]);
        if (item.cover !== "present" || typeof asset["cover"] === "string")
          break;
        await sleep();
      } while (Date.now() < until);
      assert.equal(asset["title"], item.title);
      const source = object(asset[item.kind === "audio" ? "dlsite" : "fanbox"]);
      assert.equal(source["title"], item.title);
      if (item.kind === "audio") {
        assert.equal(source["circle"], item.circle);
        assert.equal(source["releaseDate"], item.releaseDate);
        const displayed = JSON.stringify(source["credits"]);
        for (const name of item.creditLabels ??
          Object.values(item.credits ?? {}).flat())
          assert(
            displayed.includes(JSON.stringify(name)),
            `${item.id} 缺少来源参与者 ${name}`,
          );
        if (item.series)
          assert(JSON.stringify(source["series"]).includes(item.series.label));
        assert(
          JSON.stringify(asset["fileTree"]).includes(".wav"),
          `${item.id} 没有材料树`,
        );
      } else {
        assert.equal(source["publicationDateTime"], item.publishedDatetime);
        if (item.bodyText) assert.equal(source["body"], item.bodyText);
        const attachments = array(source["attachments"]).map(object);
        assert.deepEqual(
          attachments.map((a) => ({
            name: a["name"],
            byteLength: a["byteLength"],
          })),
          item.attachments?.map((a) => ({
            name: a.name,
            byteLength: a.byteLength,
          })),
        );
      }
      if (item.cover === "present") {
        assert.equal(typeof asset["cover"], "string");
        const image = await client.bytes(
          (asset["cover"] as string).replace(/^\/api/u, ""),
        );
        assert.equal(image.status, 200);
        assert(image.mediaType?.startsWith("image/png"));
        assert.deepEqual(
          Buffer.from(image.bytes),
          await readFile(path.join(fixture, "responses/cover.png")),
        );
        result["managedCoverRead"] = {
          status: image.status,
          mediaType: image.mediaType,
          byteLength: image.bytes.length,
        };
      } else {
        assert.equal(source["hasOfficialCover"], false);
      }
      result["subjectId"] = subjectId;
      result["asset"] = asset;
    }
    result["passed"] = true;
    await save();
    process.stdout.write(`通过：${item.id}\n`);
  }
  const stopBeforeRestart = await stopEnvironment({
    workspacePath,
    environment,
  });
  evidence["stopBeforeRestart"] = stopBeforeRestart;
  assert(
    stopBeforeRestart.status === "stopped" ||
      stopBeforeRestart.status === "already-stopped",
    "重开前必须确认自有服务已停止",
  );
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
  for (const result of results) {
    if (typeof result["subjectId"] !== "string") continue;
    const detail = await client.get(`/catalogue/${result["subjectId"]}`);
    assert.equal(detail.status, 200);
    assert.equal(
      object(object(detail.body)["asset"])["title"],
      object(result["asset"] as JsonValue)["title"],
    );
    result["restartReadable"] = true;
  }
  evidence["materialsAfter"] = await digestDirectory(material);
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
        const deleted = await deleteEnvironment({
          workspacePath,
          environment,
        });
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
  evidence["completedAt"] = new Date().toISOString();
  await saveDuringCleanup("最终结果");
}
