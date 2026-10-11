import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

async function entryState(root: string): Promise<readonly string[]> {
  return (await captureRawFilesystemSnapshot(root)).entries
    .filter((entry) => entry.relativePath !== ".")
    .map(
      (entry) =>
        `${entry.relativePath}:${entry.kind}:${entry.byteLength}:${entry.modifiedAtNanoseconds}:${entry.symbolicLinkTarget ?? ""}`,
    );
}

const baselineByWorkDirectory = new Map<string, readonly string[]>();

function sourceDirectory(context: Parameters<CliJourney["setup"]>[0]): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus/assets/kikoeru/VoiceWork/RJ01668691",
  );
}

function executionId(result: CliJourneyResult | undefined): string {
  const output = JSON.parse(result?.stdout ?? "{}") as {
    readonly executionId?: string;
  };
  if (output.executionId === undefined)
    throw new Error(`expected execution id in ${result?.stdout ?? ""}`);
  return output.executionId;
}

function acceptedAssetId(result: CliJourneyResult | undefined): string {
  const output = JSON.parse(result?.stdout ?? "{}") as {
    readonly accepted?: { readonly entity?: { readonly id?: string } };
  };
  const id = output.accepted?.entity?.id;
  if (id === undefined)
    throw new Error(`expected accepted asset id in ${result?.stdout ?? ""}`);
  return id;
}

function printedExecutionId(result: CliJourneyResult | undefined): string {
  const id = /^刷新记录：([^\s]+)/mu.exec(result?.stdout ?? "")?.[1];
  if (id === undefined)
    throw new Error(`expected printed execution id in ${result?.stdout ?? ""}`);
  return id;
}

const journey: CliJourney = {
  name: "inspection-and-metadata-refresh",
  realCorpus: true,
  modes: ["source", "distribution"],
  async setup(context) {
    const source = sourceDirectory(context);
    if (!(await stat(source)).isDirectory())
      throw new Error(`required live acceptance corpus is missing: ${source}`);
    baselineByWorkDirectory.set(context.workDir, await entryState(source));
  },
  commands(context) {
    const source = sourceDirectory(context);
    const data = context.productDataDirectory;
    return [
      {
        name: "register official work inspection root",
        args: [
          "library-create",
          "RJ01668691 检查语料",
          "--directory",
          source,
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      {
        name: "accept one official work for inspection",
        args: (results) => [
          "scan",
          registeredObservedRootId(results[0]),
          "--scope",
          ".",
          "--require-artifact-role",
          "asset.primary-cover",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      {
        name: "inspect accepted work in Simplified Chinese",
        args: (results) => ["inspect", executionId(results[1])],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "refresh metadata in Simplified Chinese",
        args: (results) => ["refresh-metadata", acceptedAssetId(results[1])],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      {
        name: "inspect structured metadata refresh evidence",
        args: (results) => [
          "inspect",
          printedExecutionId(results[3]),
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
    ];
  },
  async assertions({ context, results: allResults }) {
    assert.equal(allResults[0]?.exitCode, 0, allResults[0]?.stderr);
    registeredObservedRootId(allResults[0]);
    const results = allResults.slice(1);
    const accepted = JSON.parse(results[0]?.stdout ?? "{}") as {
      readonly format?: string;
      readonly unstable?: boolean;
      readonly execution?: { readonly outcome?: string };
      readonly sourceRecords?: readonly Record<string, unknown>[];
      readonly accepted?: {
        readonly sourceAssociations: readonly unknown[];
        readonly recognitionSourceAssociation?: unknown;
      };
    };
    assert.equal(results[0]?.exitCode, 0, results[0]?.stderr);
    assert.equal(accepted.format, "temporary-asset-refresh-inspection/v1");
    assert.equal(accepted.unstable, true);
    assert.equal(accepted.execution?.outcome, "accepted");
    assert.ok(
      accepted.accepted?.recognitionSourceAssociation,
      "accepted inspection is missing its recognition source",
    );
    assert.ok((accepted.sourceRecords?.length ?? 0) > 0);
    assert.ok(
      accepted.sourceRecords?.every(
        (record) => !("body" in record) && !("acquisition" in record),
      ),
    );

    const humanInspection = results[1]?.stdout ?? "";
    assert.equal(results[1]?.exitCode, 0, results[1]?.stderr);
    assert.match(humanInspection, /结果：已接受/u);
    assert.match(humanInspection, /作品：/u);
    assert.match(humanInspection, /来源：/u);
    assert.match(humanInspection, /工作项：/u);
    assert.doesNotMatch(
      humanInspection,
      /workflow_executions|source_records|acquisition_json|sqlite|drizzle|"body"/iu,
    );

    const humanMetadataRefresh = results[2]?.stdout ?? "";
    assert.equal(results[2]?.exitCode, 0, results[2]?.stderr);
    assert.match(humanMetadataRefresh, /操作：刷新元数据/u);
    assert.match(humanMetadataRefresh, /结果：已接受/u);
    assert.match(
      humanMetadataRefresh,
      /作品：塩対応な義妹ちゃん、大好きな兄さんの濃厚快感責めでメロ堕ち♡〜逆転イチャあま同棲ASMR〜/u,
    );
    assert.match(humanMetadataRefresh, /来源：/u);
    assert.doesNotMatch(
      results[2]?.stderr ?? "",
      /正在识别目录|正在获取主封面/u,
    );

    const structuredMetadataRefresh = JSON.parse(
      results[3]?.stdout ?? "{}",
    ) as {
      readonly execution?: {
        readonly outcome?: string;
        readonly selection?: { readonly intent?: string };
      };
      readonly sourceRecords?: readonly {
        readonly coverage?: { readonly id?: string };
      }[];
    };
    assert.equal(results[3]?.exitCode, 0, results[3]?.stderr);
    assert.equal(structuredMetadataRefresh.execution?.outcome, "accepted");
    assert.equal(
      structuredMetadataRefresh.execution?.selection?.intent,
      "metadata-refresh",
    );
    assert.deepEqual(
      structuredMetadataRefresh.sourceRecords?.map(
        (record) => record.coverage?.id,
      ),
      ["dlsite.product-json", "dlsite.product-html"],
    );
    assert.deepEqual(
      await entryState(sourceDirectory(context)),
      baselineByWorkDirectory.get(context.workDir),
    );
  },
};

export default journey;
