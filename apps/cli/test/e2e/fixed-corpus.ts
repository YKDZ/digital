import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  captureRawFilesystemSnapshot,
  type RawFilesystemSnapshot,
} from "@digital/test-support";

import type { CliJourneyContext } from "./journey.ts";

export type FixedCorpusRoot = {
  readonly logicalRoot: string;
  readonly directory: string;
};

export type FixedCorpusInventory = {
  readonly logicalRoot: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly byteLength: number;
  readonly inventoryDigest: string;
};

export type FixedCorpusContentDigest = {
  readonly logicalRoot: string;
  readonly contentDigest: string;
};

export type FixedCorpusDedicatedIntegrationStatus =
  | "implemented"
  | "external-gated"
  | "pending";

/**
 * 仅用于本地验收路由。所有权指明最终负责证明某个根满足验收标准的议题；
 * 绝不表示所有者已经完成其闸门。
 */
export type FixedCorpusDedicatedIntegrationOwnershipGroup = {
  readonly ownerTicket: string;
  readonly journey?: string;
  readonly status: FixedCorpusDedicatedIntegrationStatus;
  readonly roots: readonly FixedCorpusRoot[];
};

type FixedCorpusInventoryBaseline = {
  readonly schemaVersion: 2;
  readonly roots: readonly (FixedCorpusInventory & FixedCorpusContentDigest)[];
  readonly totals: Omit<
    FixedCorpusInventory,
    "logicalRoot" | "inventoryDigest"
  >;
};

function normalizeLogicalRoot(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\/+$/u, ""));
  if (
    normalized.length === 0 ||
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`invalid fixed-corpus logical root: ${value}`);
  }
  return normalized;
}

export async function fixedCorpusRoots(
  context: CliJourneyContext,
): Promise<readonly FixedCorpusRoot[]> {
  const corpusDirectory = path.resolve(
    context.packageRoot,
    "../..",
    "fixtures/live-corpus",
  );
  const selection = await readFile(
    path.join(corpusDirectory, "files-from.txt"),
    "utf8",
  );
  return selection
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((logicalRoot) => {
      const normalized = normalizeLogicalRoot(logicalRoot);
      return {
        logicalRoot: normalized,
        directory: path.resolve(
          context.packageRoot,
          "../..",
          ".scratch/acceptance-corpus/assets",
          ...normalized.split("/"),
        ),
      };
    });
}

/**
 * 在真实语料旅程开始前，验证单独审核且与位置无关的清单。这里刻意绝不写入或重新生成基线：
 * 接受变化后的语料是有意的本地审核动作，而不是测试副作用。
 */
export async function assertFixedCorpusInventoryBaseline(
  context: CliJourneyContext,
  snapshots?: ReadonlyMap<string, RawFilesystemSnapshot>,
): Promise<void> {
  const corpusDirectory = path.resolve(
    context.packageRoot,
    "../..",
    "fixtures/live-corpus",
  );
  const baseline = JSON.parse(
    await readFile(
      path.join(
        corpusDirectory,
        "references/fixed-corpus-inventory-baseline.json",
      ),
      "utf8",
    ),
  ) as FixedCorpusInventoryBaseline;
  if (baseline.schemaVersion !== 2)
    throw new Error("unsupported fixed-corpus inventory baseline schema");
  const roots = await fixedCorpusRoots(context);
  if (roots.length !== baseline.roots.length)
    throw new Error("fixed corpus inventory baseline root count drifted");
  let totalFiles = 0;
  let totalDirectories = 0;
  let totalByteLength = 0;
  for (const [index, root] of roots.entries()) {
    const expected = baseline.roots[index];
    if (expected?.logicalRoot !== root.logicalRoot)
      throw new Error(
        `fixed corpus inventory baseline root drifted: ${root.logicalRoot}`,
      );
    const actual =
      snapshots === undefined
        ? await fixedCorpusInventory(root)
        : fixedCorpusInventoryFromSnapshot(
            root,
            requiredSnapshot(snapshots, root.logicalRoot),
          );
    assertInventoryMatchesBaseline(actual, expected);
    totalFiles = safeAdd(totalFiles, actual.fileCount, "file count");
    totalDirectories = safeAdd(
      totalDirectories,
      actual.directoryCount,
      "directory count",
    );
    totalByteLength = safeAdd(
      totalByteLength,
      actual.byteLength,
      "byte length",
    );
  }
  assertSafeNonnegative(baseline.totals.fileCount, "baseline file count");
  assertSafeNonnegative(
    baseline.totals.directoryCount,
    "baseline directory count",
  );
  assertSafeNonnegative(baseline.totals.byteLength, "baseline byte length");
  if (
    baseline.totals.fileCount !== totalFiles ||
    baseline.totals.directoryCount !== totalDirectories ||
    baseline.totals.byteLength !== totalByteLength
  )
    throw new Error("fixed corpus inventory baseline totals drifted");
}

export async function fixedCorpusContentDigests(
  roots: readonly FixedCorpusRoot[],
): Promise<ReadonlyMap<string, FixedCorpusContentDigest>> {
  const snapshots = await captureFixedCorpusSnapshots(roots, true);
  return fixedCorpusContentDigestsFromSnapshots(roots, snapshots);
}

export async function fixedCorpusContentDigest(
  root: FixedCorpusRoot,
): Promise<FixedCorpusContentDigest> {
  return fixedCorpusContentDigestFromSnapshot(
    root,
    await captureRawFilesystemSnapshot(root.directory, {
      contentDigests: true,
    }),
  );
}

export function fixedCorpusContentDigestFromSnapshot(
  root: FixedCorpusRoot,
  snapshot: RawFilesystemSnapshot,
): FixedCorpusContentDigest {
  const rootDigest = createHash("sha256");
  for (const entry of snapshot.entries) {
    if (entry.kind !== "regular-file") continue;
    if (entry.contentDigest === undefined)
      throw new Error(
        `fixed corpus content digest was not captured: ${root.logicalRoot}/${entry.relativePath}`,
      );
    rootDigest.update(entry.relativePath);
    rootDigest.update("\0");
    rootDigest.update(entry.contentDigest);
    rootDigest.update("\n");
  }
  return {
    logicalRoot: root.logicalRoot,
    contentDigest: rootDigest.digest("hex"),
  };
}

export function fixedCorpusContentDigestsFromSnapshots(
  roots: readonly FixedCorpusRoot[],
  snapshots: ReadonlyMap<string, RawFilesystemSnapshot>,
): ReadonlyMap<string, FixedCorpusContentDigest> {
  return new Map(
    roots.map((root) => [
      root.logicalRoot,
      fixedCorpusContentDigestFromSnapshot(
        root,
        requiredSnapshot(snapshots, root.logicalRoot),
      ),
    ]),
  );
}

export async function captureFixedCorpusSnapshots(
  roots: readonly FixedCorpusRoot[],
  contentDigests: boolean,
): Promise<ReadonlyMap<string, RawFilesystemSnapshot>> {
  return new Map(
    await Promise.all(
      roots.map(
        async (root) =>
          [
            root.logicalRoot,
            await captureRawFilesystemSnapshot(root.directory, {
              contentDigests,
            }),
          ] as const,
      ),
    ),
  );
}

export async function assertFixedCorpusContentBaseline(
  context: CliJourneyContext,
  actual: ReadonlyMap<string, FixedCorpusContentDigest>,
): Promise<void> {
  const baseline = await readFixedCorpusBaseline(context);
  if (actual.size !== baseline.roots.length)
    throw new Error("fixed corpus content baseline root count drifted");
  await assertFixedCorpusContentBaselineSubset(context, actual);
}

/** 将单个真实门的有限根集合与同一份人工批准内容摘要比较。 */
export async function assertFixedCorpusContentBaselineSubset(
  context: CliJourneyContext,
  actual: ReadonlyMap<string, FixedCorpusContentDigest>,
): Promise<void> {
  const baseline = await readFixedCorpusBaseline(context);
  const expectedByRoot = new Map(
    baseline.roots.map((expected) => [expected.logicalRoot, expected]),
  );
  for (const observed of actual.values()) {
    const expected = expectedByRoot.get(observed.logicalRoot);
    if (expected === undefined)
      throw new Error(
        `fixed corpus content baseline root missing: ${observed.logicalRoot}`,
      );
    assertContentDigestMatchesBaseline(observed, expected);
  }
}

export function assertContentDigestMatchesBaseline(
  actual: FixedCorpusContentDigest,
  expected: FixedCorpusContentDigest,
): void {
  if (
    actual.logicalRoot !== expected.logicalRoot ||
    actual.contentDigest !== expected.contentDigest
  )
    throw new Error(
      `fixed corpus content baseline drifted: ${actual.logicalRoot}`,
    );
}

async function readFixedCorpusBaseline(
  context: CliJourneyContext,
): Promise<FixedCorpusInventoryBaseline> {
  const corpusDirectory = path.resolve(
    context.packageRoot,
    "../..",
    "fixtures/live-corpus",
  );
  const baseline = JSON.parse(
    await readFile(
      path.join(
        corpusDirectory,
        "references/fixed-corpus-inventory-baseline.json",
      ),
      "utf8",
    ),
  ) as FixedCorpusInventoryBaseline;
  if (baseline.schemaVersion !== 2)
    throw new Error("unsupported fixed-corpus inventory baseline schema");
  return baseline;
}

function assertSafeNonnegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`fixed corpus ${label} is outside the safe integer range`);
}

function safeAdd(total: number, value: number, label: string): number {
  assertSafeNonnegative(total, label);
  assertSafeNonnegative(value, label);
  const result = total + value;
  assertSafeNonnegative(result, label);
  return result;
}

export function assertInventoryMatchesBaseline(
  actual: FixedCorpusInventory,
  expected: FixedCorpusInventory,
): void {
  if (
    expected.logicalRoot !== actual.logicalRoot ||
    expected.fileCount !== actual.fileCount ||
    expected.directoryCount !== actual.directoryCount ||
    expected.byteLength !== actual.byteLength ||
    expected.inventoryDigest !== actual.inventoryDigest
  )
    throw new Error(
      `fixed corpus inventory baseline drifted: ${actual.logicalRoot}`,
    );
}

export async function fixedCorpusInventory(
  root: FixedCorpusRoot,
): Promise<FixedCorpusInventory> {
  return fixedCorpusInventoryFromSnapshot(
    root,
    await captureRawFilesystemSnapshot(root.directory),
  );
}

export function fixedCorpusInventoryFromSnapshot(
  root: FixedCorpusRoot,
  snapshot: RawFilesystemSnapshot,
): FixedCorpusInventory {
  let fileCount = 0;
  let directoryCount = 0;
  let byteLength = 0;
  const serialized: string[] = [];
  for (const entry of snapshot.entries) {
    serialized.push(
      `${entry.relativePath}\0${entry.kind}\0${entry.byteLength}${entry.symbolicLinkTarget === undefined ? "" : `\0${entry.symbolicLinkTarget}`}\n`,
    );
    if (entry.kind === "regular-file") {
      fileCount += 1;
      byteLength += entry.byteLength;
      if (!Number.isSafeInteger(byteLength))
        throw new Error(
          `fixed corpus total size is unsafe: ${root.logicalRoot}`,
        );
    } else if (entry.kind === "directory") directoryCount += 1;
  }
  return {
    logicalRoot: root.logicalRoot,
    fileCount,
    directoryCount,
    byteLength,
    inventoryDigest: createHash("sha256")
      .update(serialized.join(""))
      .digest("hex"),
  };
}

function requiredSnapshot(
  snapshots: ReadonlyMap<string, RawFilesystemSnapshot>,
  logicalRoot: string,
): RawFilesystemSnapshot {
  const snapshot = snapshots.get(logicalRoot);
  if (snapshot === undefined)
    throw new Error(`fixed corpus raw snapshot missing: ${logicalRoot}`);
  return snapshot;
}

type DedicatedIntegrationOwnershipContract = {
  readonly ownerTicket: string;
  readonly rootCount: number;
  readonly status: FixedCorpusDedicatedIntegrationStatus;
  readonly journey?: string;
};

const dedicatedIntegrationOwnershipContracts: readonly DedicatedIntegrationOwnershipContract[] =
  [
    {
      ownerTicket: "v1-live-acceptance/issues/01-dlsite-eight-live-gate.md",
      journey: "dlsite-eight-live",
      status: "implemented",
      rootCount: 8,
    },
    {
      ownerTicket: "v1-live-acceptance/issues/02-fanbox-five-live-gate.md",
      journey: "fanbox-five-live",
      status: "external-gated",
      rootCount: 5,
    },
    {
      ownerTicket: "v1-live-acceptance/issues/03-epub-publication-live-gate.md",
      journey: "epub-publication-live",
      status: "implemented",
      rootCount: 6,
    },
    {
      ownerTicket: "v1-live-acceptance/issues/04-pdf-series-live-gate.md",
      journey: "pdf-publication-live",
      status: "implemented",
      rootCount: 1,
    },
    {
      ownerTicket: "v1-live-acceptance/issues/05-bangumi-episodic-live-gate.md",
      journey: "bangumi-episodic-live",
      status: "implemented",
      rootCount: 2,
    },
    {
      ownerTicket: "v1-live-acceptance/issues/06-film-tmdb-omdb-live-gate.md",
      journey: "tmdb-omdb-live",
      status: "implemented",
      rootCount: 2,
    },
  ];

const dedicatedIntegrationOwnershipContractByTicket = new Map(
  dedicatedIntegrationOwnershipContracts.map((contract) => [
    contract.ownerTicket,
    contract,
  ]),
);

function fixedCorpusDirectory(context: CliJourneyContext): string {
  return path.resolve(context.packageRoot, "../..", "fixtures/live-corpus");
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`fixed corpus routing ${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value))
    throw new Error(`fixed corpus routing ${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`fixed corpus routing ${label} must be a non-empty string`);
  return value;
}

function requiredStatus(
  value: unknown,
  label: string,
): FixedCorpusDedicatedIntegrationStatus {
  switch (value) {
    case "implemented":
    case "external-gated":
    case "pending":
      return value;
    default:
      throw new Error(`fixed corpus routing ${label} has an unknown status`);
  }
}

function knownRootsByLogicalRoot(
  roots: readonly FixedCorpusRoot[],
): ReadonlyMap<string, FixedCorpusRoot> {
  const known = new Map<string, FixedCorpusRoot>();
  for (const root of roots) {
    if (known.has(root.logicalRoot))
      throw new Error(
        `fixed corpus routing selection contains a duplicate root: ${root.logicalRoot}`,
      );
    known.set(root.logicalRoot, root);
  }
  return known;
}

function resolveKnownRoots(
  value: unknown,
  label: string,
  known: ReadonlyMap<string, FixedCorpusRoot>,
): readonly FixedCorpusRoot[] {
  const roots: FixedCorpusRoot[] = [];
  const seen = new Set<string>();
  for (const [index, rawRoot] of requiredArray(value, label).entries()) {
    const logicalRoot = normalizeLogicalRoot(
      requiredString(rawRoot, `${label}[${index}]`),
    );
    if (seen.has(logicalRoot))
      throw new Error(
        `fixed corpus routing ${label} contains a duplicate root: ${logicalRoot}`,
      );
    seen.add(logicalRoot);
    const root = known.get(logicalRoot);
    if (root === undefined)
      throw new Error(
        `fixed corpus routing ${label} contains an unknown root: ${logicalRoot}`,
      );
    roots.push(root);
  }
  return roots;
}

export function fixedCorpusHistoricallyReviewedRootsFromOracle(
  rawOracle: unknown,
  roots: readonly FixedCorpusRoot[],
): readonly FixedCorpusRoot[] {
  const oracle = requiredRecord(rawOracle, "oracle");
  const known = knownRootsByLogicalRoot(roots);
  return resolveKnownRoots(
    oracle.reviewedSupportedRoots,
    "reviewedSupportedRoots",
    known,
  );
}

export function fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle(
  rawOracle: unknown,
  roots: readonly FixedCorpusRoot[],
): readonly FixedCorpusDedicatedIntegrationOwnershipGroup[] {
  const oracle = requiredRecord(rawOracle, "oracle");
  const known = knownRootsByLogicalRoot(roots);
  const rawGroups = requiredArray(
    oracle.dedicatedIntegrationOwnershipGroups,
    "dedicatedIntegrationOwnershipGroups",
  );
  if (rawGroups.length !== dedicatedIntegrationOwnershipContracts.length)
    throw new Error(
      "fixed corpus routing dedicated integration ownership group count drifted",
    );

  const seenOwners = new Set<string>();
  const seenOwnedRoots = new Set<string>();
  const ownershipGroups: FixedCorpusDedicatedIntegrationOwnershipGroup[] = [];
  for (const [index, rawGroup] of rawGroups.entries()) {
    const group = requiredRecord(
      rawGroup,
      `dedicatedIntegrationOwnershipGroups[${index}]`,
    );
    const ownerTicket = requiredString(
      group.ownerTicket,
      `dedicatedIntegrationOwnershipGroups[${index}].ownerTicket`,
    );
    if (seenOwners.has(ownerTicket))
      throw new Error(
        `fixed corpus routing has a duplicate owner ticket ${ownerTicket}`,
      );
    seenOwners.add(ownerTicket);
    const contract =
      dedicatedIntegrationOwnershipContractByTicket.get(ownerTicket);
    if (contract === undefined)
      throw new Error(
        `fixed corpus routing has an unknown owner ticket ${ownerTicket}`,
      );
    const status = requiredStatus(
      group.status,
      `dedicatedIntegrationOwnershipGroups[${index}].status`,
    );
    if (status !== contract.status)
      throw new Error(
        `fixed corpus routing owner ticket ${ownerTicket} status must be ${contract.status}`,
      );

    const hasJourney = Object.hasOwn(group, "journey");
    if (contract.journey === undefined) {
      if (hasJourney)
        throw new Error(
          `fixed corpus routing owner ticket ${ownerTicket} must not declare a journey while pending`,
        );
    } else if (
      requiredString(
        group.journey,
        `dedicatedIntegrationOwnershipGroups[${index}].journey`,
      ) !== contract.journey
    )
      throw new Error(
        `fixed corpus routing owner ticket ${ownerTicket} journey must be ${contract.journey}`,
      );

    const groupRoots = resolveKnownRoots(
      group.roots,
      `dedicatedIntegrationOwnershipGroups[${index}].roots`,
      known,
    );
    if (groupRoots.length !== contract.rootCount)
      throw new Error(
        `fixed corpus routing owner ticket ${ownerTicket} root count must be ${contract.rootCount}`,
      );
    for (const root of groupRoots) {
      if (seenOwnedRoots.has(root.logicalRoot))
        throw new Error(
          `fixed corpus routing has a duplicate owned root: ${root.logicalRoot}`,
        );
      seenOwnedRoots.add(root.logicalRoot);
    }
    ownershipGroups.push({
      ownerTicket,
      status,
      roots: groupRoots,
      ...(contract.journey === undefined ? {} : { journey: contract.journey }),
    });
  }
  for (const contract of dedicatedIntegrationOwnershipContracts) {
    if (!seenOwners.has(contract.ownerTicket))
      throw new Error(
        `fixed corpus routing is missing owner ticket ${contract.ownerTicket}`,
      );
  }
  return ownershipGroups.toSorted((left, right) =>
    left.ownerTicket < right.ownerTicket
      ? -1
      : left.ownerTicket > right.ownerTicket
        ? 1
        : 0,
  );
}

async function fixedCorpusRoutingInput(context: CliJourneyContext): Promise<{
  readonly roots: readonly FixedCorpusRoot[];
  readonly rawOracle: unknown;
}> {
  const [roots, rawOracle] = await Promise.all([
    fixedCorpusRoots(context),
    readFile(
      path.join(
        fixedCorpusDirectory(context),
        "references/reviewed-oracle.json",
      ),
      "utf8",
    ).then((contents) => JSON.parse(contents) as unknown),
  ]);
  return { roots, rawOracle };
}

/**
 * 历史审核保持为独立本地参考材料。它可以帮助人类选择要检查的案例，
 * 但绝不授予集成所有者，也不记录实时验收结果。
 */
export async function fixedCorpusHistoricallyReviewedRoots(
  context: CliJourneyContext,
): Promise<readonly FixedCorpusRoot[]> {
  const { roots, rawOracle } = await fixedCorpusRoutingInput(context);
  return fixedCorpusHistoricallyReviewedRootsFromOracle(rawOracle, roots);
}

/**
 * 返回五个显式集成所有权组。路由是责任边界，不是对其议题已经通过验收标准的断言。
 */
export async function fixedCorpusDedicatedIntegrationOwnershipGroups(
  context: CliJourneyContext,
): Promise<readonly FixedCorpusDedicatedIntegrationOwnershipGroup[]> {
  const { roots, rawOracle } = await fixedCorpusRoutingInput(context);
  return fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle(
    rawOracle,
    roots,
  );
}

/**
 * 安全旅程只接收显式路由根的补集。它根据专属所有权派生，绝不根据历史审核数据派生。
 */
export async function unsupportedFixedCorpusRoots(
  context: CliJourneyContext,
): Promise<readonly FixedCorpusRoot[]> {
  const { roots, rawOracle } = await fixedCorpusRoutingInput(context);
  const ownershipGroups =
    fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle(rawOracle, roots);
  const ownedLogicalRoots = new Set(
    ownershipGroups.flatMap((group) =>
      group.roots.map((root) => root.logicalRoot),
    ),
  );
  return roots.filter((root) => !ownedLogicalRoots.has(root.logicalRoot));
}
