import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  deleteEnvironment,
  inspectEnvironment,
  prepareEnvironment,
  startEnvironment,
  stopEnvironment,
} from "@digital/environment";
import { loadControlledSourceIo } from "@digital/test-support/source-io";

import {
  artifactRoleAddress,
  configureAudioPostSources,
  createCorpusClient,
  currentMetadataValues,
  hasArtifactRole,
  intakeAudioPostCase,
  listAllAssets,
  sourceRecordContents,
  waitForProductReady,
  type IntakeOutcome,
} from "./corpus-verification.ts";
import { requireInput } from "./inputs.ts";
import { digestDirectory } from "./material-digest.ts";

/** 资料调用方只提交普通目录和来源配置，通过正式 HTTP 核对独立预期。 */
type CorpusCase = {
  readonly id: string;
  readonly kind: "audio" | "post" | "unrecognized";
  readonly logicalRoot: string;
  readonly directory: string;
  readonly files: readonly {
    readonly reference: string;
    readonly input: string;
  }[];
  readonly sourceNativeAddress?: string;
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
type CorpusReference = {
  readonly logicalRoot: string;
  readonly sourceNativeAddress?: string;
  readonly title?: string;
  readonly releaseDate?: string;
  readonly circle?: string;
  readonly credits?: Readonly<Record<string, readonly string[]>>;
  readonly reviewedSeries?: { readonly label: string };
  readonly publishedDatetime?: string;
  readonly body?: { readonly text?: string };
  readonly attachments?: readonly {
    readonly name: string;
    readonly byteLength: string;
  }[];
  readonly officialPageSnapshot?: {
    readonly observedAt: string;
    readonly releaseDate?: string;
    readonly introduction?: string;
    readonly pageTitle?: string;
    readonly cover?:
      | {
          readonly status: "present";
          readonly sourceUrl: string;
          readonly mediaType: string;
          readonly sha256: string;
          readonly byteLength: number;
        }
      | {
          readonly status: "absent";
          readonly pageOgImageUrl?: string;
          readonly reason: string;
        };
  };
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
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));
assert(
  environment && evidencePath && Number.isInteger(port),
  "用法：pnpm verify:audio-posts <独立环境名> <证据文件> <空闲端口> [资料ID…]",
);
const all = JSON.parse(
  await readFile(path.join(fixture, "cases.json"), "utf8"),
) as {
  readonly cases: readonly CorpusCase[];
};
const references = JSON.parse(
  await readFile(path.join(fixture, "references.json"), "utf8"),
) as {
  readonly audioWorks: readonly CorpusReference[];
  readonly creatorPosts: readonly CorpusReference[];
  readonly music: readonly CorpusReference[];
  readonly unresolvedPressureCases: readonly CorpusReference[];
};
assert.equal(all.cases.length, 18, "音声、帖子与未识别资料必须完整覆盖18根");
assert.equal(all.cases.filter((item) => item.kind === "audio").length, 8);
assert.equal(all.cases.filter((item) => item.kind === "post").length, 5);
assert.equal(
  all.cases.filter((item) => item.kind === "unrecognized").length,
  5,
);
assert.equal(
  references.audioWorks.length + references.creatorPosts.length,
  13,
  "来源识别预期必须逐根提供独立参考",
);
assert.equal(
  references.music.length + references.unresolvedPressureCases.length,
  5,
  "未识别根必须逐根映射到审阅参考",
);
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
  await waitForProductReady(started.run.address, controller.signal);
  let client = createCorpusClient(started.run.address, controller.signal);
  assert.equal(
    (await client.listAssetLibraryOptions()).sources.length > 0,
    true,
  );
  await configureAudioPostSources(client, fixture, cases);
  if (cases.some((item) => item.kind === "post"))
    evidence["sessionConfigured"] = true;
  for (const item of cases) {
    const reference =
      item.kind === "audio"
        ? references.audioWorks.find(
            (candidate) => candidate.logicalRoot === item.logicalRoot,
          )
        : item.kind === "post"
          ? references.creatorPosts.find(
              (candidate) => candidate.logicalRoot === item.logicalRoot,
            )
          : (references.music.find(
              (candidate) => candidate.logicalRoot === item.logicalRoot,
            ) ??
            references.unresolvedPressureCases.find(
              (candidate) => candidate.logicalRoot === item.logicalRoot,
            ));
    if (item.kind !== "unrecognized") {
      assert(reference, `${item.id} 缺少独立参考记录`);
      assert.equal(item.sourceNativeAddress, reference.sourceNativeAddress);
      assert.equal(item.title, reference.title);
      if (item.kind === "audio") {
        assert.equal(item.releaseDate, reference.releaseDate);
        assert.equal(item.circle, reference.circle);
        assert.deepEqual(item.credits, reference.credits);
      } else {
        assert.equal(item.publishedDatetime, reference.publishedDatetime);
        assert.equal(
          reference.officialPageSnapshot?.pageTitle?.split("｜", 1)[0],
          reference.title,
          `${item.id} 官方页面标题须与独立审阅标题相符`,
        );
        assert.deepEqual(
          item.attachments?.map(({ name, byteLength }) => ({
            name,
            byteLength,
          })),
          reference.attachments?.map(({ name, byteLength }) => ({
            name: name,
            byteLength: byteLength,
          })),
        );
        assert.equal(item.cover, reference.officialPageSnapshot?.cover?.status);
      }
    } else {
      assert(reference, `${item.id} 缺少未识别参考记录`);
      assert.equal(reference.logicalRoot, item.logicalRoot);
    }
    const intake = await intakeAudioPostCase(client, fixture, item);
    const directory = intake.directories.find(
      ({ path: directoryPath }) =>
        directoryPath === path.join(fixture, item.directory),
    );
    assert(directory, `${item.id} 缺少公开登记的素材目录`);
    const observed = await client.inspectLocalIntake({
      assetLibraryId: intake.assetLibraryId,
      directoryId: directory.id,
      parentExecutionId: intake.executionId,
    });
    const files = observed.files;
    assert(files.length > 0, `${item.id} 没有安全观察到文件`);
    assert.deepEqual(
      files.map((file) => file.relativePath).toSorted(),
      item.files.map((file) => file.input).toSorted(),
      `${item.id} 的正式目录观察必须对应独立参考与缩减文件映射`,
    );
    const result: Record<string, unknown> = {
      id: item.id,
      kind: item.kind,
      logicalRoot: item.logicalRoot,
      reference,
      intake,
      observed,
    };
    results.push(result);
    await save();
    if (item.kind === "unrecognized") {
      assert.equal(
        intake.assetIds.length,
        0,
        `${item.id} 不应制造通用类别资产`,
      );
      assert(files.every((file) => file.assetIds.length === 0));
      result["unresolved"] = true;
    } else {
      assert.equal(
        intake.assetIds.length,
        1,
        `${item.id} 应由来源建立一个内容主体`,
      );
      const subjectId = intake.assetIds[0]!;
      assert(
        files.every((file) => file.assetIds.includes(subjectId)),
        `${item.id} 的全部目录材料必须属于已识别主体`,
      );
      let asset = (await listAllAssets(client, intake.assetLibraryId)).find(
        (candidate) => candidate.id === subjectId,
      );
      assert(asset, `${item.id} 的正式资产应可由公共资产列表读取`);
      // 内容读取可能发起正式信息履行；等待同一主体的所需封面，不能改选其他主体。
      const until = Date.now() + 300_000;
      do {
        asset = (await listAllAssets(client, intake.assetLibraryId)).find(
          (candidate) => candidate.id === subjectId,
        );
        assert(asset, `${item.id} 的正式资产不可再读取`);
        if (
          item.cover !== "present" ||
          hasArtifactRole(asset, "asset.primary-cover")
        )
          break;
        await sleep();
      } while (Date.now() < until);
      result["asset"] = asset;
      await save();
      assert(
        currentMetadataValues(asset, "asset.title").some(
          ({ value }) => value === item.title,
        ),
      );
      const sourceIdentity = item.kind === "audio" ? "dlsite" : "fanbox";
      const sourceAddressSuffix =
        item.kind === "audio"
          ? `/product_id/${item.sourceNativeAddress}.html`
          : `/posts/${item.sourceNativeAddress}`;
      assert(
        asset.sourceAssociations.some(
          (association) =>
            association.sourceIdentity === sourceIdentity &&
            new URL(association.nativeAddress).pathname.endsWith(
              sourceAddressSuffix,
            ),
        ),
        `${item.id} 的来源身份必须与独立预期相同`,
      );
      const sources = await sourceRecordContents(client, subjectId);
      const sourceDocument = sources
        .filter((record) => record.sourceIdentity === sourceIdentity)
        .map((record) => record.content)
        .join("\n");
      if (item.kind === "audio") {
        assert(reference);
        assert(
          currentMetadataValues(asset, "asset.introduction").some(
            ({ value }) =>
              value === reference.officialPageSnapshot?.introduction,
          ),
        );
        assert.equal(
          currentMetadataValues(asset, "asset.release-date").find(
            ({ sourceIdentity: source }) => source === "dlsite",
          )?.value,
          reference.officialPageSnapshot?.releaseDate ?? reference.releaseDate,
        );
        const dlsiteEntities = asset.relatedEntities.filter(
          ({ sourceIdentity: source }) => source === "dlsite",
        );
        assert(
          dlsiteEntities.some(
            ({ identityNamespace, label }) =>
              identityNamespace === "dlsite.circle" &&
              label === reference.circle,
          ),
        );
        for (const name of item.creditLabels ??
          Object.values(reference.credits ?? {}).flat())
          assert(
            dlsiteEntities.some(
              ({ identityNamespace, label }) =>
                identityNamespace?.startsWith("dlsite.credit.") &&
                label === name,
            ),
            `${item.id} 缺少来源参与者 ${name}`,
          );
        if (reference.reviewedSeries)
          assert(
            dlsiteEntities.some(
              ({ identityNamespace, label }) =>
                identityNamespace === "dlsite.series" &&
                label === reference.reviewedSeries!.label,
            ),
          );
        assert(
          asset.locations.some(({ address }) => address.endsWith(".wav")),
          `${item.id} 没有材料树`,
        );
      } else {
        assert(reference);
        assert.equal(
          currentMetadataValues(asset, "asset.publication-datetime").find(
            ({ sourceIdentity: source }) => source === "fanbox",
          )?.value,
          reference.publishedDatetime,
        );
        if (item.bodyText !== undefined)
          assert(
            currentMetadataValues(asset, "asset.body").some(
              ({ value }) => value === item.bodyText,
            ),
          );
        const sourceFacts = JSON.stringify(sourceDocument);
        for (const attachment of reference.attachments ?? []) {
          assert(sourceFacts.includes(attachment.name));
          assert(sourceFacts.includes(attachment.byteLength));
        }
      }
      if (item.cover === "present") {
        const coverAddress = artifactRoleAddress(asset, "asset.primary-cover");
        assert(coverAddress);
        const digest = coverAddress.split("/").at(-1);
        assert(digest);
        const image = await client.readManagedArtifact(
          digest,
          controller.signal,
        );
        const imageBytes = new Uint8Array(await image.arrayBuffer());
        assert.equal(image.status, 200);
        assert(reference);
        const coverReference = reference.officialPageSnapshot?.cover;
        assert(
          coverReference?.status === "present",
          `${item.id} 缺少封面独立预期`,
        );
        assert.equal(
          image.headers.get("content-type")?.split(";", 1)[0],
          coverReference.mediaType,
        );
        assert.equal(imageBytes.length, coverReference.byteLength);
        assert.equal(
          createHash("sha256").update(imageBytes).digest("hex"),
          coverReference.sha256,
        );
        result["managedCoverRead"] = {
          status: image.status,
          mediaType: image.headers.get("content-type"),
          byteLength: imageBytes.length,
        };
      } else {
        assert.equal(
          reference.officialPageSnapshot?.cover?.status,
          "absent",
          `${item.id} 缺少官方无封面参考记录`,
        );
        assert.equal(hasArtifactRole(asset, "asset.primary-cover"), false);
      }
      result["subjectId"] = subjectId;
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
  await waitForProductReady(restarted.run.address, controller.signal);
  client = createCorpusClient(restarted.run.address, controller.signal);
  for (const result of results) {
    if (typeof result["subjectId"] !== "string") continue;
    const intake = result["intake"] as IntakeOutcome;
    const asset = (await listAllAssets(client, intake.assetLibraryId)).find(
      (candidate) => candidate.id === result["subjectId"],
    );
    assert(asset);
    assert.deepEqual(
      currentMetadataValues(asset, "asset.title"),
      currentMetadataValues(
        result["asset"] as Parameters<typeof currentMetadataValues>[0],
        "asset.title",
      ),
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
