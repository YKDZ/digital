import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

const bloomRelative = "assets/media/番剧/终将成为你 (2018)";
const frierenRelative = "assets/media/番剧/葬送的芙莉莲 (2023)";
const baselines = new Map<string, ReadonlyMap<string, readonly string[]>>();
const liveProductDataEnvironment = "DIGITAL_BANGUMI_LIVE_PRODUCT_DATA";

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

function acceptedCount(value: {
  readonly execution: {
    readonly workItems?: readonly { readonly outcome?: string }[];
  };
}): number {
  return (
    value.execution.workItems?.filter((item) => item.outcome === "accepted")
      .length ?? 0
  );
}

function noChangeCount(value: {
  readonly execution: {
    readonly workItems?: readonly { readonly outcome?: string }[];
  };
}): number {
  return (
    value.execution.workItems?.filter((item) => item.outcome === "no-change")
      .length ?? 0
  );
}

function firstAcceptedAssetId(result: CliJourneyResult | undefined): string {
  const output = JSON.parse(result?.stdout ?? "{}") as {
    readonly itemResults?: readonly {
      readonly accepted?: { readonly entity?: { readonly id?: string } };
    }[];
  };
  const id = output.itemResults?.find(
    (item) => item.accepted?.entity?.id !== undefined,
  )?.accepted?.entity?.id;
  if (id === undefined)
    throw new Error(`expected accepted episode id in ${result?.stdout ?? ""}`);
  return id;
}

async function sourceTree(root: string): Promise<readonly string[]> {
  return (
    await captureRawFilesystemSnapshot(root, { contentDigests: true })
  ).entries
    .filter((entry) => entry.relativePath !== ".")
    .map(
      (entry) =>
        `${entry.relativePath}:${entry.kind}:${entry.byteLength}:${entry.modifiedAtNanoseconds}:${entry.symbolicLinkTarget ?? ""}:${entry.contentDigest ?? ""}`,
    );
}

const journey: CliJourney = {
  name: "bangumi-episodic-live",
  modes: ["source", "distribution"],
  async setup(context) {
    await seedDisposableDigitalConnections(context);
    const corpus = corpusRoot(context);
    baselines.set(
      context.workDir,
      new Map(
        await Promise.all(
          [bloomRelative, frierenRelative].map(
            async (relative) =>
              [
                relative,
                await sourceTree(path.join(corpus, relative)),
              ] as const,
          ),
        ),
      ),
    );
  },
  commands(context) {
    const corpus = corpusRoot(context);
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
        args: [
          "root-create",
          "终将成为你 验收语料",
          path.join(corpus, bloomRelative),
        ],
        env: env("bloom"),
        haltOnFailure: true,
      },
      {
        name: "register live Frieren root",
        args: [
          "root-create",
          "葬送的芙莉莲 验收语料",
          path.join(corpus, frierenRelative),
        ],
        env: env("frieren"),
        haltOnFailure: true,
      },
      scan(0, "live accept Bloom", "bloom", true),
      scan(0, "live no-change Bloom", "bloom"),
      {
        name: "live metadata refresh Bloom episode",
        args: (results) => [
          "refresh-metadata",
          firstAcceptedAssetId(results[2]),
          "--json",
        ],
        env: env("bloom"),
      },
      scan(1, "live accept Frieren", "frieren"),
      scan(1, "live no-change Frieren", "frieren"),
    ];
  },
  async assertions({ context, results: allResults }) {
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
        /access_token|refresh_token|client_secret|oauth\.json/iu,
        "private Bangumi configuration leaked through delivery output",
      );
    }
    const parsed = results.map(
      (result) =>
        JSON.parse(result.stdout) as {
          readonly execution: {
            readonly outcome: string;
            readonly reason?: string;
            readonly workItems?: readonly { readonly outcome?: string }[];
          };
          readonly sourceRecords: readonly {
            readonly coverage: { readonly id: string };
          }[];
        },
    );
    assert.equal(parsed[0]!.execution.outcome, "accepted");
    assert.equal(acceptedCount(parsed[0]!), 13);
    assert.equal(parsed[1]!.execution.outcome, "no-change");
    assert.equal(noChangeCount(parsed[1]!), 13);
    assert.equal(parsed[1]!.sourceRecords.length, 0);
    assert.equal(parsed[2]!.execution.outcome, "accepted");
    assert.deepEqual(
      parsed[2]!.sourceRecords.map((record) => record.coverage.id),
      ["bangumi.episode:831401"],
    );
    assert.equal(parsed[3]!.execution.outcome, "accepted");
    assert.equal(acceptedCount(parsed[3]!), 38);
    assert.equal(parsed[4]!.execution.outcome, "no-change");
    assert.equal(noChangeCount(parsed[4]!), 38);
    assert.equal(parsed[4]!.sourceRecords.length, 0);
    const baseline = baselines.get(context.workDir);
    assert.ok(baseline);
    for (const relative of [bloomRelative, frierenRelative]) {
      assert.deepEqual(
        await sourceTree(path.join(corpusRoot(context), relative)),
        baseline.get(relative),
        `${relative} source tree changed during the live journey`,
      );
    }
  },
};

export default journey;
