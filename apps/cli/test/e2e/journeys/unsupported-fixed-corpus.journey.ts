import assert from "node:assert/strict";
import path from "node:path";

import type {
  RawFilesystemEntry,
  RawFilesystemSnapshot,
} from "@digital/test-support";

import {
  assertFixedCorpusContentBaseline,
  assertFixedCorpusInventoryBaseline,
  captureFixedCorpusSnapshots,
  fixedCorpusContentDigestsFromSnapshots,
  fixedCorpusRoots,
  unsupportedFixedCorpusRoots,
  type FixedCorpusContentDigest,
  type FixedCorpusRoot,
} from "../fixed-corpus.ts";
import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyResult,
} from "../journey.ts";

type CorpusState = {
  readonly corpusAssetsDirectory: string;
  readonly allRoots: readonly FixedCorpusRoot[];
  readonly unsupportedRoots: readonly FixedCorpusRoot[];
  readonly before: ReadonlyMap<string, RawFilesystemSnapshot>;
  readonly deepBefore?: ReadonlyMap<string, FixedCorpusContentDigest>;
};

const stateByMode = new Map<string, CorpusState>();

function stateKey(context: Parameters<CliJourney["setup"]>[0]): string {
  return `${context.mode}:${context.workDir}`;
}

function currentState(
  context: Parameters<CliJourney["setup"]>[0],
): CorpusState {
  const state = stateByMode.get(stateKey(context));
  if (state === undefined)
    throw new Error("fixed corpus journey setup did not run");
  return state;
}

function expectedFileCount(fingerprint: readonly RawFilesystemEntry[]): number {
  return fingerprint.filter((entry) => entry.kind === "regular-file").length;
}

function expectedDirectoryPaths(
  fingerprint: readonly RawFilesystemEntry[],
): readonly string[] {
  return fingerprint
    .filter((entry) => entry.kind === "directory")
    .map((entry) => entry.relativePath)
    .toSorted(compareCodeUnits);
}

function expectedTotalSize(fingerprint: readonly RawFilesystemEntry[]): number {
  return fingerprint
    .filter((entry) => entry.kind === "regular-file")
    .reduce((total, entry) => safeAdd(total, entry.byteLength), 0);
}

function expectedRepresentativePaths(
  fingerprint: readonly RawFilesystemEntry[],
): readonly string[] {
  return fingerprint
    .filter(
      (entry) => entry.kind === "regular-file" && entry.relativePath !== ".",
    )
    .map((entry) => entry.relativePath)
    .toSorted(compareCodeUnits)
    .slice(0, 8);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeAdd(total: number, value: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(
      "fixed corpus total size is outside the safe integer range",
    );
  return result;
}

function corpusAssetsDirectory(
  context: Parameters<CliJourney["setup"]>[0],
): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus/assets",
  );
}

function assertScopesBelongToCommonCorpusRoot(
  rootDirectory: string,
  roots: readonly FixedCorpusRoot[],
): void {
  for (const root of roots) {
    const scope = path.relative(rootDirectory, root.directory);
    assert.equal(
      scope.replaceAll(path.sep, "/"),
      root.logicalRoot,
      `${root.logicalRoot} must remain a bounded relative scope of the fixed corpus root`,
    );
  }
}

const journey: CliJourney = {
  name: "unsupported-fixed-corpus",
  modes: ["source", "distribution"],
  async setup(context) {
    const [allRoots, unsupportedRoots] = await Promise.all([
      fixedCorpusRoots(context),
      unsupportedFixedCorpusRoots(context),
    ]);
    assert.equal(allRoots.length, 29, "files-from selection drifted");
    assert.equal(unsupportedRoots.length, 5, "safety root scope drifted");
    const deepIntegrity = process.env.DIGITAL_DEEP_CORPUS_INTEGRITY === "1";
    const before = await captureFixedCorpusSnapshots(allRoots, deepIntegrity);
    await assertFixedCorpusInventoryBaseline(context, before);
    const deepBefore = deepIntegrity
      ? fixedCorpusContentDigestsFromSnapshots(allRoots, before)
      : undefined;
    if (deepBefore !== undefined)
      await assertFixedCorpusContentBaseline(context, deepBefore);
    const assetsDirectory = corpusAssetsDirectory(context);
    assertScopesBelongToCommonCorpusRoot(assetsDirectory, allRoots);
    stateByMode.set(stateKey(context), {
      corpusAssetsDirectory: assetsDirectory,
      allRoots,
      unsupportedRoots,
      before,
      ...(deepBefore === undefined ? {} : { deepBefore }),
    });
  },
  commands(context) {
    const { corpusAssetsDirectory, unsupportedRoots } = currentState(context);
    const data = path.join(context.workDir, "product-data");
    return [
      {
        name: "register fixed corpus root",
        args: ["root-create", "固定语料", corpusAssetsDirectory],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      },
      ...unsupportedRoots.map((root) => ({
        name: `observe unresolved ${root.logicalRoot}`,
        args: (results: readonly CliJourneyResult[]) => [
          "preview",
          registeredObservedRootId(results[0]),
          "--scope",
          root.logicalRoot,
          "--json",
        ],
        env: { DIGITAL_PRODUCT_DATA: data },
        haltOnFailure: true,
      })),
    ];
  },
  async assertions({ context, results }) {
    const state = currentState(context);
    assert.equal(results.length, state.unsupportedRoots.length + 1);
    const [rootCreateResult, ...previewResults] = results;
    assert.equal(rootCreateResult?.exitCode, 0, rootCreateResult?.stderr);
    registeredObservedRootId(rootCreateResult);
    for (const [index, root] of state.unsupportedRoots.entries()) {
      const result: CliJourneyResult | undefined = previewResults[index];
      assert.equal(result?.exitCode, 0, result?.stderr);
      const inspection = JSON.parse(result?.stdout ?? "") as {
        readonly execution: {
          readonly outcome?: string;
          readonly snapshot: {
            readonly complete: boolean;
            readonly files: readonly { readonly relativePath: string }[];
            readonly directories?: readonly { readonly relativePath: string }[];
          };
        };
        readonly sourceRecords: readonly unknown[];
        readonly recognition?: unknown;
        readonly accepted?: unknown;
        readonly unresolvedObservation?: {
          readonly observedRoot: string;
          readonly fileCount: number;
          readonly totalSize: number;
          readonly representativePaths: readonly string[];
        };
      };
      assert.equal(
        inspection.execution.outcome,
        "unresolved",
        `${root.logicalRoot} must remain unresolved until its own integration exists`,
      );
      const before = state.before.get(root.logicalRoot)?.entries;
      assert.notEqual(before, undefined);
      assert.deepEqual(
        inspection.execution.snapshot.directories?.map(
          (directory) => directory.relativePath,
        ),
        expectedDirectoryPaths(before ?? []),
        `${root.logicalRoot} must retain complete directory observations including empty directories`,
      );
      assert.equal(inspection.accepted, undefined);
      assert.equal(inspection.recognition, undefined);
      assert.deepEqual(inspection.sourceRecords, []);
      assert.equal(
        inspection.execution.snapshot.complete,
        true,
        `${root.logicalRoot} must retain a complete Filesystem Package Snapshot`,
      );
      assert.equal(
        inspection.execution.snapshot.files.length,
        expectedFileCount(before ?? []),
        `${root.logicalRoot} must retain a complete regular-file observation`,
      );
      assert.deepEqual(
        inspection.unresolvedObservation,
        {
          observedRoot: root.directory,
          fileCount: expectedFileCount(before ?? []),
          totalSize: expectedTotalSize(before ?? []),
          representativePaths: expectedRepresentativePaths(before ?? []),
        },
        `${root.logicalRoot} must expose an inspectable unresolved file summary`,
      );
    }

    const after = await captureFixedCorpusSnapshots(
      state.allRoots,
      state.deepBefore !== undefined,
    );
    assert.deepEqual(after, state.before);
    if (state.deepBefore !== undefined) {
      const deepAfter = fixedCorpusContentDigestsFromSnapshots(
        state.allRoots,
        after,
      );
      await assertFixedCorpusContentBaseline(context, deepAfter);
      assert.deepEqual(deepAfter, state.deepBefore);
    }

    const allFingerprints = [...state.before.values()].flatMap(
      (snapshot) => snapshot.entries,
    );
    assert.ok(
      allFingerprints.some((entry) => entry.relativePath.endsWith(".nfo")),
      "legacy NFO must remain observable material",
    );
    assert.ok(
      allFingerprints.some((entry) =>
        entry.relativePath.endsWith("poster.jpg"),
      ),
      "legacy manager poster must remain observable material",
    );
    assert.ok(
      allFingerprints.some((entry) => entry.relativePath.endsWith(".epub")),
      "container-based book must remain one opaque observation",
    );
    assert.equal(
      allFingerprints.some((entry) => entry.relativePath.includes("OEBPS/")),
      false,
      "the observer must not recursively inspect EPUB archive entries",
    );
    assert.equal(
      state.unsupportedRoots.some((root) =>
        (state.before.get(root.logicalRoot)?.entries ?? []).some((entry) =>
          entry.relativePath.endsWith(".nfo"),
        ),
      ),
      false,
      "the legacy NFO counterexample belongs to the dedicated TMDB/OMDb recognition journey rather than the unresolved safety gate",
    );
    assert.equal(
      state.unsupportedRoots.some((root) =>
        (state.before.get(root.logicalRoot)?.entries ?? []).some((entry) =>
          entry.relativePath.endsWith("poster.jpg"),
        ),
      ),
      false,
      "the legacy manager poster belongs to the dedicated TMDB/OMDb recognition journey rather than the unresolved safety gate",
    );
  },
};

export default journey;
