import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { captureRawFilesystemSnapshot } from "@digital/test-support";

import { requireInput } from "./inputs.ts";

type BaselineRoot = {
  readonly logicalRoot: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly byteLength: number;
  readonly contentDigest: string;
};

type InventoryBaseline = {
  readonly schemaVersion: 2;
  readonly roots: readonly BaselineRoot[];
  readonly totals: {
    readonly fileCount: number;
    readonly directoryCount: number;
    readonly byteLength: number;
  };
};

const workspacePath = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
const assetsArgument = process.argv[2];
const evidenceArgument = process.argv[3];
assert(
  assetsArgument !== undefined &&
    path.isAbsolute(assetsArgument) &&
    evidenceArgument !== undefined &&
    evidenceArgument.length > 0 &&
    !path.isAbsolute(evidenceArgument),
  "用法：pnpm verify:deep-integrity <完整资料根绝对路径> <证据文件>",
);

const assetsDirectory = path.resolve(assetsArgument);
const evidencePath = path.resolve(workspacePath, evidenceArgument);
const packageRequire = createRequire(import.meta.url);
const selectionPath = packageRequire.resolve(
  "@digital/preview-corpus/live/files-from.txt",
);
const baselinePath = packageRequire.resolve(
  "@digital/preview-corpus/live/references/fixed-corpus-inventory-baseline.json",
);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort(new Error(`收到 ${signal}`)));

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  assetsRoot: "已提供完整资料根",
  status: "running",
  processedRoots: [],
};
const save = async (): Promise<void> => {
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, undefined, 2)}\n`);
};

function logicalRoots(selection: string): string[] {
  return selection
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\/+$/u, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

async function rootContentDigest(directory: string): Promise<{
  readonly contentDigest: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly byteLength: number;
}> {
  const snapshot = await captureRawFilesystemSnapshot(directory, {
    contentDigests: true,
  });
  const files = snapshot.entries
    .filter((entry) => entry.kind === "regular-file")
    .toSorted((left, right) =>
      compareCodeUnits(left.relativePath, right.relativePath),
    );
  const directories = snapshot.entries.filter(
    (entry) => entry.kind === "directory",
  );
  const digest = createHash("sha256");
  let byteLength = 0;
  for (const file of files) {
    assert(file.contentDigest, `完整字节摘要缺失：${file.relativePath}`);
    digest.update(file.relativePath);
    digest.update("\0");
    digest.update(file.contentDigest);
    digest.update("\n");
    byteLength += file.byteLength;
  }
  return {
    contentDigest: digest.digest("hex"),
    fileCount: files.length,
    directoryCount: directories.length,
    byteLength,
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

try {
  const selection = await readFile(selectionPath, "utf8");
  const baseline = JSON.parse(
    await readFile(baselinePath, "utf8"),
  ) as InventoryBaseline;
  assert.equal(baseline.schemaVersion, 2, "真实资料基线版本无效");
  const roots = logicalRoots(selection);
  assert.equal(roots.length, 29, "真实资料清单必须包含29个根");
  assert.equal(
    roots.length,
    baseline.roots.length,
    "资料清单与字节基线范围不一致",
  );

  const missing: string[] = [];
  for (const root of roots)
    if (
      !(await directoryExists(path.join(assetsDirectory, ...root.split("/"))))
    )
      missing.push(root);
  if (missing.length > 0) {
    evidence["status"] = "condition-missing";
    evidence["missingRoots"] = missing;
    evidence["finishedAt"] = new Date().toISOString();
    await save();
    process.stderr.write(
      `条件缺失：完整资料根缺少 ${String(missing.length)} 个目录，未执行字节校验。\n`,
    );
    process.exitCode = 2;
  } else {
    const actualRoots: {
      readonly logicalRoot: string;
      readonly fileCount: number;
      readonly directoryCount: number;
      readonly byteLength: number;
      readonly contentDigest: string;
    }[] = [];
    let totalByteLength = 0;
    let totalFileCount = 0;
    let totalDirectoryCount = 0;
    const actualEvidence = evidence["processedRoots"] as unknown[];
    for (const [index, logicalRoot] of roots.entries()) {
      controller.signal.throwIfAborted();
      const expected = baseline.roots[index];
      assert.equal(
        expected?.logicalRoot,
        logicalRoot,
        `字节基线根顺序变化：${logicalRoot}`,
      );
      const actual = await rootContentDigest(
        path.join(assetsDirectory, ...logicalRoot.split("/")),
      );
      const item = { logicalRoot, ...actual };
      actualRoots.push(item);
      actualEvidence.push(item);
      totalByteLength += actual.byteLength;
      totalFileCount += actual.fileCount;
      totalDirectoryCount += actual.directoryCount;
      await save();
      assert.equal(
        actual.fileCount,
        expected.fileCount,
        `${logicalRoot} 文件数变化`,
      );
      assert.equal(
        actual.directoryCount,
        expected.directoryCount,
        `${logicalRoot} 目录数变化`,
      );
      assert.equal(
        actual.byteLength,
        expected.byteLength,
        `${logicalRoot} 字节数变化`,
      );
      assert.equal(
        actual.contentDigest,
        expected.contentDigest,
        `${logicalRoot} 完整字节摘要变化`,
      );
    }
    assert.deepEqual(
      {
        fileCount: totalFileCount,
        directoryCount: totalDirectoryCount,
        byteLength: totalByteLength,
      },
      baseline.totals,
      "完整资料总量与审核基线不一致",
    );
    evidence["status"] = "passed";
    evidence["totals"] = baseline.totals;
    evidence["finishedAt"] = new Date().toISOString();
    await save();
    process.stdout.write(
      `完整字节校验通过：${String(actualRoots.length)} 根。\n`,
    );
  }
} catch (error) {
  evidence["status"] = controller.signal.aborted ? "cancelled" : "failed";
  evidence["failure"] = error instanceof Error ? error.message : String(error);
  evidence["finishedAt"] = new Date().toISOString();
  await save();
  process.stderr.write(`完整字节校验失败：${String(evidence["failure"])}\n`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
