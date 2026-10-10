import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

const journeyDirectory = path.dirname(fileURLToPath(import.meta.url));
/** 受控来源夹具与作品目录都在作者树内，默认执行不读取私人语料也不触碰真实来源。 */
const fixtureRoot = path.resolve(
  journeyDirectory,
  "..",
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "controlled-source-io",
);
const controlledManifest = path.join(fixtureRoot, "manifest.json");

const oraclePath = path.join(
  fixtureRoot,
  "expectations",
  "RJ01668691.reviewed-oracle.json",
);
const coverResponse = path.join(fixtureRoot, "responses", "dlsite-cover.png");

type Oracle = {
  readonly status: string;
  readonly selection: {
    readonly identity: string;
    readonly sourceNativeAddress: string;
  };
  readonly projection: {
    readonly title: string;
    readonly introduction: string;
    readonly releaseDate: string;
    readonly declaredLanguage: string;
    readonly contentClassification: string;
    readonly circle: { readonly sourceKey: string; readonly label: string };
    readonly credits: {
      readonly voice: readonly string[];
      readonly scenario: readonly string[];
      readonly illustration: readonly string[];
    };
    readonly relationshipRoles: readonly string[];
    readonly cover: { readonly role: string };
  };
};

type AcceptedProjection = {
  readonly entity: { readonly id: string; readonly kind: string };
  readonly sourceAssociations: readonly {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  }[];
  readonly recognitionSourceAssociation?: { readonly nativeAddress: string };
  readonly metadata: readonly {
    readonly property: string;
    readonly value: string;
    readonly sourceRecordIds: readonly string[];
  }[];
  readonly currentRelatedEntities?: readonly RelatedEntity[];
  readonly relationships?: readonly {
    readonly type: string;
    readonly participants: readonly { readonly role: string }[];
  }[];
  readonly artifactAssociations?: readonly {
    readonly artifactId: string;
    readonly role: string;
  }[];
  readonly artifactRevisions?: readonly {
    readonly artifactId: string;
    readonly blobDigest: string;
  }[];
  readonly blobs?: readonly { readonly digest: string }[];
};

type RelatedEntity = {
  readonly id: string;
  readonly identityNamespace: string;
  readonly sourceKey: string;
  readonly label: string;
};

type RefreshOutcome = {
  readonly format: string;
  readonly executionId?: string;
  readonly execution: { readonly id: string; readonly outcome: string };
  readonly sourceRecords?: readonly {
    readonly sourceIdentity: string;
    readonly coverage: { readonly id: string };
    readonly nativeAddress: string;
  }[];
  readonly itemResults?: readonly {
    readonly outcome?: string;
    readonly accepted?: AcceptedProjection;
  }[];
};

type CataloguePage = {
  readonly items: readonly Record<string, unknown>[];
  readonly nextCursor?: string;
};

async function tree(root: string): Promise<readonly string[]> {
  const snapshot = await captureRawFilesystemSnapshot(root, {
    contentDigests: true,
  });
  return snapshot.entries
    .filter((entry) => entry.relativePath !== ".")
    .map((entry) =>
      entry.kind === "directory"
        ? `${entry.relativePath}/`
        : `${entry.relativePath}:${entry.byteLength}:${entry.contentDigest ?? ""}`,
    );
}

function parse<T>(result: CliJourneyResult | undefined, label: string): T {
  assert.notEqual(result, undefined, `${label} 没有执行结果`);
  try {
    return JSON.parse(result?.stdout ?? "{}") as T;
  } catch {
    throw new Error(
      `${label} 未返回机器可读结果\nstdout: ${result?.stdout ?? ""}\nstderr: ${result?.stderr ?? ""}`,
    );
  }
}

function acceptedWork(
  value: RefreshOutcome,
  label: string,
): AcceptedProjection {
  const accepted = (value.itemResults ?? []).filter(
    (item) => item.outcome === "accepted",
  );
  assert.equal(
    accepted.length,
    1,
    `${label} 必须给出恰好一个已接受的主体：${JSON.stringify(
      (value.itemResults ?? []).map((item) => item.outcome),
    )}`,
  );
  const projection = accepted[0]?.accepted;
  assert.ok(projection !== undefined, `${label} 缺少已接受投影`);
  return projection;
}

/** 普通场景目录：每个交付模式各自拥有一份副本，产品数据根绝不落在素材里。 */
function ordinaryDirectory(context: { readonly workDir: string }): string {
  return path.join(context.workDir, "ordinary-library", "RJ01668691");
}

const baselines = new Map<string, readonly string[]>();

const journey: CliJourney = {
  name: "controlled-ordinary-library",
  modes: ["source", "distribution", "packed"],
  source: { mode: "controlled", manifestPath: controlledManifest },
  async setup(context) {
    const source = path.join(fixtureRoot, "material", "RJ01668691");
    assert.equal(
      (await stat(source).catch(() => undefined))?.isDirectory() === true,
      true,
      `受控夹具作品目录缺失：${source}`,
    );
    assert.equal(
      (await stat(oraclePath).catch(() => undefined))?.isFile() === true,
      true,
      `受控夹具人工复核期望缺失：${oraclePath}`,
    );
    const target = ordinaryDirectory(context);
    await cp(source, target, { recursive: true });
    baselines.set(target, await tree(target));
  },
  commands(context) {
    const directory = ordinaryDirectory(context);
    return [
      {
        name: "catalogue surface before the CLI admits the directory",
        args: ["catalogue-surface", "--surface", "current-catalogue"],
        haltOnFailure: true,
      },
      {
        name: "CLI admits the ordinary directory into an asset library",
        args: [
          "library-create",
          "受控普通目录验收库",
          "--directory",
          directory,
          "--profile",
          "dlsite-voice",
          "--source",
          "dlsite",
          "--json",
        ],
        haltOnFailure: true,
      },
      {
        name: "CLI refreshes the admitted directory through the controlled source",
        args: (results) => [
          "scan",
          registeredObservedRootId(results[1]),
          "--scope",
          ".",
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
        haltOnFailure: true,
      },
      {
        name: "catalogue surface after the CLI admitted the directory",
        args: ["catalogue-surface", "--surface", "current-catalogue"],
      },
      {
        name: "CLI inspects the applied refresh execution",
        args: (results) => [
          "inspect",
          parse<RefreshOutcome>(results[2], "scan").execution.id,
          "--json",
        ],
      },
      {
        name: "CLI refreshes metadata for the admitted subject",
        args: (results) => [
          "refresh-metadata",
          acceptedWork(parse<RefreshOutcome>(results[2], "scan"), "scan").entity
            .id,
          "--json",
        ],
      },
    ];
  },
  async assertions({ context, results }) {
    for (const [index, result] of results.entries())
      assert.equal(
        result?.exitCode,
        0,
        `命令 ${index + 1}（${result?.commandName ?? ""}）未成功：\nstdout: ${
          result?.stdout ?? ""
        }\nstderr: ${result?.stderr ?? ""}`,
      );

    const oracle = JSON.parse(await readFile(oraclePath, "utf8")) as Oracle;
    assert.equal(oracle.status, "official-source-and-filesystem-reviewed");

    const directory = ordinaryDirectory(context);

    // 合同②：接入前该目录未被任何资产库观察，交付页面里没有这个作品。
    const before = parse<CataloguePage>(results[0], "接入前 current 页面");
    assert.deepEqual(
      before.items.filter((item) =>
        JSON.stringify(item).includes(oracle.projection.title),
      ),
      [],
      "环境准备不得代替被测 CLI 完成接入：接入前目录已出现在当前目录页",
    );

    const registered = parse<{
      readonly id: string;
      readonly configVersion: number;
      readonly status: string;
      readonly recognitionProfileIds: readonly string[];
      readonly sourceIdentities: readonly string[];
    }>(results[1], "资产库接入");
    assert.equal(registered.status, "active");
    assert.equal(registered.configVersion, 1);
    assert.deepEqual(registered.sourceIdentities, ["dlsite"]);
    assert.deepEqual(registered.recognitionProfileIds, ["dlsite-voice"]);

    const scan = parse<RefreshOutcome>(results[2], "扫描刷新");
    assert.equal(scan.execution.outcome, "accepted", "受控刷新未被接受");
    const work = acceptedWork(scan, "受控刷新");
    assert.equal(
      work.entity.kind,
      "digital-asset",
      `受控刷新的主体类型异常：${work.entity.kind}`,
    );

    const after = parse<CataloguePage>(results[3], "接入后 current 页面");
    assert.equal(
      after.items.some((item) =>
        JSON.stringify(item).includes(oracle.projection.title),
      ),
      true,
      "被测 CLI 完成接入与刷新后，当前目录页仍看不到该作品",
    );

    const inspection = parse<RefreshOutcome>(results[4], "刷新查看");
    assert.equal(inspection.execution.outcome, "accepted");
    assert.equal(
      inspection.execution.id,
      scan.execution.id,
      "查看的执行与本次刷新不是同一次",
    );
    const applied = acceptedWork(inspection, "刷新查看");
    assert.equal(
      applied.sourceAssociations.some(
        (association) =>
          association.sourceIdentity === "dlsite" &&
          association.nativeAddress === oracle.selection.sourceNativeAddress,
      ),
      true,
      `缺少人工复核的 DLsite 来源地址：${oracle.selection.sourceNativeAddress}`,
    );
    for (const expected of [
      { property: "asset.title", value: oracle.projection.title },
      {
        property: "asset.introduction",
        value: oracle.projection.introduction,
      },
      {
        property: "asset.release-date",
        value: oracle.projection.releaseDate.slice(0, 10),
        prefix: true,
      },
      {
        property: "asset.declared-language",
        value: oracle.projection.declaredLanguage,
      },
      {
        property: "asset.content-classification",
        value: oracle.projection.contentClassification,
      },
    ])
      assert.equal(
        applied.metadata.some(
          (item) =>
            item.property === expected.property &&
            (expected.prefix === true
              ? item.value.startsWith(expected.value)
              : item.value === expected.value),
        ),
        true,
        `缺少人工复核的 ${expected.property}（期望 ${expected.value}）：${JSON.stringify(
          applied.metadata.filter(
            (item) => item.property === expected.property,
          ),
        )}`,
      );

    // 夹具里的协议代表值同样经由两份普通响应读取，而不是调用方写入。
    for (const property of ["dlsite.product.price-jpy", "dlsite.product.genre"])
      assert.equal(
        applied.metadata.some((item) => item.property === property),
        true,
        `受控夹具的协议代表值未进入交付投影：${property}`,
      );
    assert.equal(
      (inspection.sourceRecords ?? []).every(
        (record) => record.sourceIdentity === "dlsite",
      ),
      true,
      "受控刷新读到了 DLsite 之外的来源记录",
    );
    assert.deepEqual(
      [
        ...new Set(
          (inspection.sourceRecords ?? []).map((record) => record.coverage.id),
        ),
      ].toSorted(),
      ["dlsite.product-html", "dlsite.product-json"],
      "受控刷新没有同时读取作品接口与普通页面两份响应",
    );

    const related = applied.currentRelatedEntities ?? [];
    const circle = related.find(
      (entity) =>
        entity.identityNamespace === "dlsite.circle" &&
        entity.sourceKey === oracle.projection.circle.sourceKey,
    );
    assert.ok(
      circle !== undefined,
      `缺少人工复核的圈：${oracle.projection.circle.sourceKey}`,
    );
    assert.equal(circle.label, oracle.projection.circle.label);
    for (const credited of [
      ...oracle.projection.credits.voice,
      ...oracle.projection.credits.scenario,
      ...oracle.projection.credits.illustration,
    ])
      assert.equal(
        related.some((entity) => entity.label === credited),
        true,
        `缺少人工复核的制作人员：${credited}`,
      );
    const roles = new Set(
      (applied.relationships ?? []).flatMap((relationship) =>
        relationship.participants.map((p) => p.role),
      ),
    );
    for (const role of [
      "circle",
      ...oracle.projection.relationshipRoles.filter(
        (value) => value !== "circle",
      ),
    ])
      assert.equal(
        roles.has(role),
        true,
        `缺少人工复核的关系角色：${[...roles].join("、")}`,
      );

    // 必需产物用途由受控来源的真实封面字节满足，而不是由调用方写入。
    const coverId = (applied.artifactAssociations ?? [])
      .filter(
        (association) => association.role === oracle.projection.cover.role,
      )
      .map((association) => association.artifactId);
    assert.equal(
      coverId.length,
      1,
      `必需的封面产物用途应有恰好一个：${JSON.stringify(
        applied.artifactAssociations ?? [],
      )}`,
    );
    const revision = (applied.artifactRevisions ?? []).find(
      (item) => item.artifactId === coverId[0],
    );
    assert.ok(revision !== undefined, "封面产物缺少修订");
    const expectedCoverDigest = createHash("sha256")
      .update(await readFile(coverResponse))
      .digest("hex");
    assert.equal(
      revision.blobDigest,
      expectedCoverDigest,
      "封面产物字节与受控夹具的普通响应不一致",
    );
    assert.equal(
      (applied.blobs ?? []).some((blob) => blob.digest === expectedCoverDigest),
      true,
      "产品数据里没有登记该封面 blob",
    );

    const deliveredViews = [results[0], results[3], results[4], results[5]]
      .map((result) => `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`)
      .join("\n");
    for (const marker of [
      "受控来源拒绝",
      "请求键",
      "controlled-source-io",
      "DIGITAL_SOURCE_IO",
      "manifestPath",
      "sha256:",
    ])
      assert.equal(
        deliveredViews.includes(marker),
        false,
        `交付视图泄漏了受控装配细节：${marker}`,
      );

    // 被测 CLI 只读观察输入：场景目录在接入与刷新后逐字节保持不变。
    assert.deepEqual(
      await tree(directory),
      baselines.get(directory),
      "受控场景目录被产品写入改动",
    );

    // 产品数据归属本场景环境：正式 CLI 的工作区落在环境自己的产品数据根内。
    assert.equal(
      (
        await stat(path.join(context.productDataDirectory, "catalogue.sqlite"))
      ).isFile(),
      true,
      `产品数据不在环境产品数据根内：${context.productDataDirectory}`,
    );
    assert.ok(
      path.relative(context.productDataDirectory, directory).startsWith(".."),
      "场景输入目录不应位于环境产品数据根之内",
    );
  },
};

export default journey;
