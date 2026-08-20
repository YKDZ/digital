import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

async function fingerprintTree(root: string): Promise<readonly string[]> {
  return (
    await captureRawFilesystemSnapshot(root, { contentDigests: true })
  ).entries
    .filter((entry) => entry.relativePath !== ".")
    .map((entry) =>
      entry.kind === "directory"
        ? `${entry.relativePath}/`
        : `${entry.relativePath}:${entry.kind}:${entry.byteLength}:${entry.modifiedAtNanoseconds}:${entry.symbolicLinkTarget ?? ""}:${entry.contentDigest ?? ""}`,
    );
}

const baselineByWorkDirectory = new Map<string, readonly string[]>();

function sourceDirectory(context: Parameters<CliJourney["setup"]>[0]): string {
  return path.join(context.workDir, "unresolved-source");
}

function executionId(result: CliJourneyResult | undefined): string {
  const output = JSON.parse(result?.stdout ?? "{}") as {
    readonly executionId?: string;
  };
  if (output.executionId === undefined)
    throw new Error(`scan did not return an execution id: ${result?.stdout}`);
  return output.executionId;
}

const journey: CliJourney = {
  name: "unresolved-inspection",
  modes: ["source", "distribution"],
  async setup(context) {
    const source = sourceDirectory(context);
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(
      path.join(source, "ordinary.txt"),
      "ordinary source bytes\n",
    );
    await writeFile(
      path.join(source, "nested", "unknown.bin"),
      new Uint8Array([4, 8, 15]),
    );
    baselineByWorkDirectory.set(context.workDir, await fingerprintTree(source));
  },
  commands(context) {
    const source = sourceDirectory(context);
    const data = path.join(context.workDir, "product-data");
    return [
      {
        name: "register unknown directory root",
        args: ["root-create", "未识别测试目录", source],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      {
        name: "scan unknown directory",
        args: (results) => [
          "scan",
          registeredObservedRootId(results[0]),
          "--scope",
          ".",
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      {
        name: "inspect unresolved execution in a later process",
        args: (results) => ["inspect", executionId(results[1]), "--json"],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
      {
        name: "render unresolved inspection in Simplified Chinese",
        args: (results) => ["inspect", executionId(results[1])],
        env: { DIGITAL_PRODUCT_DATA: data },
      },
    ];
  },
  async assertions({ context, results: allResults }) {
    assert.equal(allResults[0]?.exitCode, 0, allResults[0]?.stderr);
    registeredObservedRootId(allResults[0]);
    const results = allResults.slice(1);
    const scanned = JSON.parse(results[0]?.stdout ?? "{}") as {
      readonly format?: string;
      readonly unstable?: boolean;
      readonly executionId?: string;
      readonly execution?: {
        readonly status?: string;
        readonly outcome?: string;
        readonly snapshot?: {
          readonly complete?: boolean;
          readonly files?: readonly { readonly relativePath: string }[];
        };
      };
      readonly accepted?: unknown;
      readonly recognition?: unknown;
      readonly sourceRecords?: readonly unknown[];
    };
    const inspected = JSON.parse(results[1]?.stdout ?? "{}") as typeof scanned;
    assert.equal(results[0]?.exitCode, 0, results[0]?.stderr);
    assert.equal(results[1]?.exitCode, 0, results[1]?.stderr);
    assert.equal(scanned.format, "temporary-asset-refresh-inspection/v1");
    assert.equal(scanned.unstable, true);
    assert.equal(scanned.execution?.status, "completed");
    assert.equal(scanned.execution?.outcome, "unresolved");
    assert.equal(scanned.execution?.snapshot?.complete, true);
    assert.deepEqual(
      scanned.execution?.snapshot?.files?.map((file) => file.relativePath),
      ["nested/unknown.bin", "ordinary.txt"],
    );
    assert.equal(scanned.accepted, undefined);
    assert.equal(scanned.recognition, undefined);
    assert.deepEqual(scanned.sourceRecords, []);
    assert.equal(inspected.executionId, scanned.executionId);
    assert.deepEqual(inspected.execution, scanned.execution);
    assert.equal(results[2]?.exitCode, 0, results[2]?.stderr);
    assert.match(results[2]?.stdout ?? "", /结果：未识别/u);
    assert.match(results[2]?.stdout ?? "", /观察范围：/u);
    assert.match(results[2]?.stdout ?? "", /代表文件：/u);
    assert.match(
      results[2]?.stdout ?? "",
      /directory-interpretation：completed/u,
    );
    assert.deepEqual(
      await fingerprintTree(sourceDirectory(context)),
      baselineByWorkDirectory.get(context.workDir),
    );
  },
};

export default journey;
