import path from "node:path";

import type {
  LibraryScanDirectoryCoverage,
  LibraryScanDirectoryMode,
  LibraryScanDirectoryPlan,
  LibraryScanDirectoryUnavailable,
  LibraryScanPlan,
} from "@digital/domain";

import type {
  AssetRefreshInspection,
  AssetRefreshOutcome,
  AssetRefreshWorkItem,
  FilesystemPackageSnapshot,
} from "./index.ts";
import type {
  AuthorizedObservedRootTarget,
  ObservedRootSymlinkMode,
} from "./observed-root-registrations.ts";

/**
 * 库扫描目录计划的输入：来自父创建时一次冻结读取的观察根快照。包含与等价一律用冻结的
 * canonical 实际根与完整授权闭包判断，绝不用容器拼写或原始直接 allowedTargetRootIds。
 * `containerPath` 只用于把失败原因中的服务器路径替换成友好文本。
 */
export type LibraryScanDirectoryCandidate = {
  readonly id: string;
  readonly configVersion: number;
  readonly containerPath: string;
  readonly canonicalPath: string;
  readonly symlinkMode: ObservedRootSymlinkMode;
  /** 冻结时求得的完整活动授权闭包，是观察策略等价的一部分。 */
  readonly authorizedTargetRoots: readonly AuthorizedObservedRootTarget[];
  /** 该配置目录在冻结读取时不可观察的诚实类别，独立成条、绝不参与归并。 */
  readonly unavailable?: LibraryScanDirectoryUnavailable;
};

/**
 * 观察策略等价键：链接策略与完整授权闭包（每个目标以稳定 ID、版本与规范身份参与）。
 * 别名或拼写不同但闭包等价的根归为同一策略；闭包不同则必须分别物理执行。
 */
export function libraryScanObservationPolicyKey(root: {
  readonly symlinkMode: ObservedRootSymlinkMode;
  readonly authorizedTargetRoots: readonly AuthorizedObservedRootTarget[];
}): string {
  return JSON.stringify([
    root.symlinkMode,
    [...root.authorizedTargetRoots]
      .map((target) => [target.id, target.configVersion, target.canonicalPath])
      .toSorted((left, right) =>
        left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0,
      ),
  ]);
}

function segments(value: string): readonly string[] {
  return path.posix
    .normalize(value.split(path.sep).join(path.posix.sep).replace(/\/+$/, ""))
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * 路径段级前缀判断：`books` 包含 `books/RJ001`，但绝不包含 `books2`。
 * 返回相对前缀，`"."` 表示同一目录。
 */
export function relativeWithinRoot(
  outer: string,
  inner: string,
): string | undefined {
  const left = segments(outer);
  const right = segments(inner);
  if (right.length < left.length) return undefined;
  for (const [index, segment] of left.entries())
    if (right[index] !== segment) return undefined;
  return right.slice(left.length).join("/") || ".";
}

/**
 * 同库同冻结配置内归并重复与包含物理范围：每个配置目录都保留一条逻辑条目，只有代表目录
 * 产生一次物理观察，其余条目按相对前缀标记为已覆盖。包含与等价一律以冻结的 canonical
 * 实际根判断——符号链接别名指向的真实嵌套只观察一次；容器拼写看似嵌套但规范身份在外部的
 * 目录独立执行，绝不被误覆盖漏扫。嵌套时选最外层，同路径按稳定根 ID 选代表，数组换序不改变计划。
 * 冻结读取时不可用的根作为独立 execute 条目如实保留，绝不覆盖或被覆盖。
 */
export function planLibraryScanDirectories(input: {
  readonly assetLibraryId: string;
  readonly configVersion: number;
  readonly roots: readonly LibraryScanDirectoryCandidate[];
}): LibraryScanPlan {
  const ordered = input.roots.toSorted(
    (left, right) =>
      Number(left.unavailable !== undefined) -
        Number(right.unavailable !== undefined) ||
      segments(left.canonicalPath).length -
        segments(right.canonicalPath).length ||
      left.canonicalPath.localeCompare(right.canonicalPath) ||
      left.id.localeCompare(right.id),
  );
  const entries: {
    readonly plan: LibraryScanDirectoryPlan;
    readonly canonicalPath: string;
    readonly policyKey: string;
  }[] = [];
  for (const root of ordered) {
    if (root.unavailable !== undefined) {
      entries.push({
        canonicalPath: root.canonicalPath,
        policyKey: libraryScanObservationPolicyKey(root),
        plan: {
          directoryKey: root.id,
          scopeReference: root.id,
          rootVersion: root.configVersion,
          relativeScope: ".",
          mode: "execute",
          unavailable: root.unavailable,
        },
      });
      continue;
    }
    const policyKey = libraryScanObservationPolicyKey(root);
    const representative = entries.find(
      (entry) =>
        entry.plan.mode === "execute" &&
        entry.plan.unavailable === undefined &&
        entry.policyKey === policyKey &&
        relativeWithinRoot(entry.canonicalPath, root.canonicalPath) !==
          undefined,
    );
    const prefix =
      representative === undefined
        ? undefined
        : relativeWithinRoot(representative.canonicalPath, root.canonicalPath);
    entries.push({
      canonicalPath: root.canonicalPath,
      policyKey,
      plan:
        prefix === undefined
          ? {
              directoryKey: root.id,
              scopeReference: root.id,
              rootVersion: root.configVersion,
              relativeScope: ".",
              mode: "execute",
            }
          : {
              directoryKey: root.id,
              scopeReference: root.id,
              rootVersion: root.configVersion,
              relativeScope: ".",
              mode: "covered",
              executedByDirectoryKey: representative!.plan.directoryKey,
              coveredByReference: prefix,
            },
    });
  }
  return {
    version: "library-scan-plan/1",
    assetLibraryId: input.assetLibraryId,
    configVersion: input.configVersion,
    directories: entries.map((entry) => entry.plan),
  };
}

/** 只读覆盖投影：用于范围比较、缺失结束与结果归属，不授予 I/O，也不成为领域事实。 */
export type StableRootCoverage = {
  readonly scopeReference: string;
  readonly rootVersion: number;
  readonly sourceSnapshotId: string;
  readonly relativePrefix: string;
  /** 覆盖范围在实际坐标上的位置，用于缺失结束与结果归属。 */
  readonly coveredAddress: string;
  /** 只有精确完整覆盖该子树，缺失才可能结束原坐标的旧支持。 */
  readonly preciselyComplete: boolean;
};

function withinPrefix(prefix: string, relativePath: string): boolean {
  if (prefix === ".") return true;
  const value = relativeWithinRoot(prefix, relativePath);
  return value !== undefined && value !== "";
}

/**
 * 由代表根的同一次快照形成覆盖投影。前缀相对代表根的冻结容器路径，因此覆盖地址在
 * 实际坐标上比较；快照不完整，或被覆盖子树内仍有排除项与诊断，都不构成精确覆盖。
 */
export function stableRootCoverages(input: {
  readonly snapshots: readonly FilesystemPackageSnapshot[];
  readonly representativeRootPath: string;
  readonly covered: readonly LibraryScanDirectoryCoverage[];
}): readonly StableRootCoverage[] {
  return input.covered.map((coverage) => {
    const coveredAddress = path.resolve(
      input.representativeRootPath,
      coverage.relativePrefix,
    );
    const covering = input.snapshots.filter(
      (snapshot) =>
        snapshot.complete &&
        isAddressWithin(coveredAddress, path.resolve(snapshot.root)),
    );
    const gaps = covering.flatMap((snapshot) =>
      [
        ...snapshot.excluded.map((item) => item.relativePath),
        ...(snapshot.diagnostics ?? []).map((item) => item.relativePath),
      ]
        .map((relativePath) => path.resolve(snapshot.root, relativePath))
        .filter((address) => isAddressWithin(coveredAddress, address)),
    );
    return {
      scopeReference: coverage.scopeReference,
      rootVersion: coverage.rootVersion,
      sourceSnapshotId: covering[0]?.id ?? "",
      relativePrefix: coverage.relativePrefix,
      coveredAddress,
      preciselyComplete: covering.length > 0 && gaps.length === 0,
    };
  });
}

/** `address` 是否落在 `directory` 内（含同址）。 */
function isAddressWithin(directory: string, address: string): boolean {
  const relative = path.relative(directory, address);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** 覆盖与结果投影只用到工作项的相对路径与业务结果，公开检查与耐久审计都满足该形状。 */
export type LibraryScanProjectedWorkItem = {
  readonly relativePaths: readonly string[];
  readonly outcome?: AssetRefreshOutcome;
};

/** 覆盖目录的结果只取属于其前缀的工作项，绝不复制代表的全部结果。 */
export function coveredWorkItems<Item extends LibraryScanProjectedWorkItem>(
  workItems: readonly Item[],
  prefix: string,
): readonly Item[] {
  if (prefix === ".") return workItems;
  return workItems.filter(
    (item) =>
      item.relativePaths.length > 0 &&
      item.relativePaths.every((relativePath) =>
        withinPrefix(prefix, relativePath),
      ),
  );
}

export type LibraryScanEntryOutcome = {
  readonly outcome: AssetRefreshOutcome;
  readonly workItemCount: number;
  readonly unresolvedCount: number;
  readonly failedCount: number;
};

/**
 * 单个目录条目的结果投影：观察前失败没有工作项时如实记为失败，不虚构工作项；任一工作项
 * 未完成都不会被同目录里已接受的工作项掩盖。沿用既有 AssetRefreshOutcome，不新造父级状态。
 */
export function libraryScanEntryOutcome(input: {
  readonly error?: string | undefined;
  readonly cancelled?: boolean | undefined;
  readonly workItems?: readonly LibraryScanProjectedWorkItem[] | undefined;
}): LibraryScanEntryOutcome {
  if (input.error !== undefined)
    return {
      outcome: "failed",
      workItemCount: 0,
      unresolvedCount: 0,
      failedCount: 0,
    };
  if (input.cancelled === true)
    return {
      outcome: "cancelled",
      workItemCount: 0,
      unresolvedCount: 0,
      failedCount: 0,
    };
  const items = input.workItems ?? [];
  const failedCount = items.filter((item) => item.outcome === "failed").length;
  // 没有明确结果的工作项按未解决计入，绝不被已接受项掩盖。
  const unresolvedCount = items.filter(
    (item) => item.outcome === "unresolved" || item.outcome === undefined,
  ).length;
  const incompleteCount = failedCount + unresolvedCount;
  const succeededCount = items.length - incompleteCount;
  const outcome: AssetRefreshOutcome =
    incompleteCount > 0
      ? succeededCount > 0
        ? "partially-succeeded"
        : failedCount > 0
          ? "failed"
          : "unresolved"
      : items.some((item) => item.outcome === "accepted")
        ? "accepted"
        : items.every((item) => item.outcome === "no-change")
          ? "no-change"
          : items.some((item) => item.outcome === "proposal")
            ? "proposal"
            : "unresolved";
  return {
    outcome,
    workItemCount: items.length,
    unresolvedCount,
    failedCount,
  };
}

export type LibraryScanSummary = {
  readonly outcome: AssetRefreshOutcome;
  readonly directoryCount: number;
  readonly workItemCount: number;
  readonly unresolvedCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
};

/** 父级汇总按全部条目投影，一个成功条目不能掩盖失败或未解决。 */
export function summarizeLibraryScan(
  entries: readonly LibraryScanEntryOutcome[],
): LibraryScanSummary {
  const counts = {
    workItemCount: 0,
    unresolvedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
  };
  const outcomes = entries.map((entry) => {
    counts.workItemCount += entry.workItemCount;
    counts.unresolvedCount += entry.unresolvedCount;
    counts.failedCount += entry.failedCount;
    return entry.outcome;
  });
  counts.cancelledCount = outcomes.filter(
    (outcome) => outcome === "cancelled",
  ).length;
  const succeeded = outcomes.some(
    (outcome) =>
      outcome === "accepted" ||
      outcome === "partially-succeeded" ||
      outcome === "proposal" ||
      outcome === "no-change",
  );
  // 真实失败与未解决分档：没有真实 failed 的全未解决保持既有 unresolved，不被误报为 failed。
  const failed = outcomes.some((outcome) => outcome === "failed");
  const unresolved = outcomes.some((outcome) => outcome === "unresolved");
  const incomplete = failed || unresolved;
  const outcome: AssetRefreshOutcome =
    outcomes.length === 0
      ? "no-change"
      : counts.cancelledCount === outcomes.length
        ? "cancelled"
        : incomplete && succeeded
          ? "partially-succeeded"
          : incomplete
            ? failed
              ? "failed"
              : "unresolved"
            : counts.cancelledCount > 0
              ? "partially-succeeded"
              : outcomes.every((item) => item === "no-change")
                ? "no-change"
                : outcomes.some((item) => item === "proposal")
                  ? "proposal"
                  : outcomes.some((item) => item === "partially-succeeded")
                    ? "partially-succeeded"
                    : "accepted";
  return { outcome, directoryCount: entries.length, ...counts };
}

/** 交付原因只保留业务文本；服务器路径与目录拼写一律不出现在用户界面。 */
export function sanitizeScanReason(
  message: string,
  containerPaths: readonly string[],
): string {
  let reason = message;
  for (const containerPath of containerPaths)
    if (containerPath.length > 0)
      reason = reason.split(containerPath).join("该目录");
  return reason.replace(/(?:\/[^\s/]+){2,}/g, "该目录").slice(0, 400);
}

/**
 * 目录条目的耐久阶段。`settled` 只表示该条目的结果已完整写下，其业务结果仍是
 * `outcome` 里的既有 AssetRefreshOutcome。
 */
export type LibraryScanDirectoryStage =
  | "queued"
  | "running"
  | "settled"
  | "cancelled";

export type LibraryScanDirectoryRecord = {
  readonly directoryKey: string;
  readonly scopeReference: string;
  readonly rootVersion: number;
  readonly relativeScope: string;
  readonly mode: LibraryScanDirectoryMode;
  readonly executedByDirectoryKey?: string;
  readonly coveredPrefix?: string;
  readonly childExecutionId?: string;
  readonly stage: LibraryScanDirectoryStage;
  readonly outcome?: AssetRefreshOutcome;
  readonly reason?: string;
  readonly workItemCount: number;
  readonly unresolvedCount: number;
  readonly failedCount: number;
};

/** 一次库扫描父执行的完整有界投影：全部目录条目与已登记的子引用。 */
export type LibraryScanInspection = {
  readonly parentExecutionId: string;
  readonly assetLibraryId: string;
  readonly configVersion: number;
  readonly status: "running" | "completed" | "failed";
  readonly outcome?: AssetRefreshOutcome;
  readonly cancellationRequested?: {
    readonly requestedBy: string;
    readonly requestedAt: string;
    readonly reason?: string;
  };
  readonly directories: readonly LibraryScanDirectoryRecord[];
};

/**
 * 一个目录条目对交付层的完整结果：账本归属、友好名与其所属工作项。covered 的工作项
 * 只按其前缀从代表的子执行投影。
 */
export type LibraryScanDirectoryInspection = LibraryScanDirectoryRecord & {
  readonly displayName: string;
  readonly workItems: readonly LibraryScanDirectoryWorkItem[];
};

/** 父检查的完整展开：全部目录条目都有结果，调用方不需要再逐个查子。 */
export type LibraryScanInspectionDetail = Omit<
  LibraryScanInspection,
  "directories"
> & {
  readonly directories: readonly LibraryScanDirectoryInspection[];
};

export function libraryScanDirectoryFromPlan(
  directory: LibraryScanDirectoryPlan,
): LibraryScanDirectoryRecord {
  return {
    directoryKey: directory.directoryKey,
    scopeReference: directory.scopeReference,
    rootVersion: directory.rootVersion,
    relativeScope: directory.relativeScope,
    mode: directory.mode,
    ...(directory.executedByDirectoryKey === undefined
      ? {}
      : { executedByDirectoryKey: directory.executedByDirectoryKey }),
    ...(directory.coveredByReference === undefined
      ? {}
      : { coveredPrefix: directory.coveredByReference }),
    stage: "queued",
    workItemCount: 0,
    unresolvedCount: 0,
    failedCount: 0,
  };
}

/**
 * 目录子携带的父归属坐标。`coverage` 是本次物理观察对同父其他目录的只读覆盖映射，
 * 随执行冻结，绝不从今日配置重建。
 */
export type LibraryScanChildCoordinates = {
  readonly parentExecutionId: string;
  readonly directoryKey: string;
  readonly coverage: readonly LibraryScanDirectoryCoverage[];
};

/**
 * 一次未识别观察的可核对归属：材料由哪个目录子在同一次物理观察中发现，人工入口据此
 * 校验确切范围，绝不按“第一个活动位置”猜测。
 */
export type UnrecognizedLibraryScanObservation = {
  readonly parentExecutionId: string;
  readonly directoryKey: string;
  readonly childExecutionId: string;
  readonly workItemKey: string;
  /** 形成该观察的实际冻结根坐标：covered 目录的材料由代表根观察。 */
  readonly observedRootId: string;
  readonly relativeScope: string;
  readonly relativePaths: readonly string[];
};

/** 未形成任何决定或提案的观察材料：既无 accepted 也无 proposal 归属。 */
export function isUnrecognizedObservationWorkItem(
  item: AssetRefreshWorkItem,
): boolean {
  return (
    item.outcome === undefined ||
    item.outcome === "unresolved" ||
    item.outcome === "failed"
  );
}

/** 目录结果沿用普通扫描检查的公开工作项形状，交付层不需要第二种渲染规则。 */
export type LibraryScanDirectoryWorkItem = NonNullable<
  AssetRefreshInspection["execution"]["workItems"]
>[number];

/**
 * 一个配置目录在本次库扫描中的完整结果。covered 目录的工作项由其自身前缀投影，
 * 归属仍是代表目录的子执行；服务器路径不出现在这里。
 */
export type LibraryScanDirectoryResult = {
  readonly directoryKey: string;
  readonly displayName: string;
  readonly mode: LibraryScanDirectoryMode;
  readonly executedByDirectoryKey?: string;
  readonly childExecutionId?: string;
  readonly outcome: AssetRefreshOutcome;
  readonly reason?: string;
  readonly workItems: readonly LibraryScanDirectoryWorkItem[];
};

export type LibraryScanRun = {
  readonly parentExecutionId: string;
  readonly assetLibraryId: string;
  readonly configVersion: number;
  readonly outcome: AssetRefreshOutcome;
  readonly cancelled: boolean;
  readonly directories: readonly LibraryScanDirectoryResult[];
};

/** 目录条目的耐久账本结果与交付结果共用同一次投影，避免账本计数与交付投影分叉。 */
export function libraryScanDirectoryResult(input: {
  readonly entry: LibraryScanDirectoryRecord;
  readonly displayName: string;
  readonly summary: LibraryScanEntryOutcome;
  readonly workItems?: readonly LibraryScanDirectoryWorkItem[] | undefined;
  readonly reason?: string | undefined;
}): LibraryScanDirectoryResult {
  return {
    directoryKey: input.entry.directoryKey,
    displayName: input.displayName,
    mode: input.entry.mode,
    ...(input.entry.executedByDirectoryKey === undefined
      ? {}
      : { executedByDirectoryKey: input.entry.executedByDirectoryKey }),
    ...(input.entry.childExecutionId === undefined
      ? {}
      : { childExecutionId: input.entry.childExecutionId }),
    outcome: input.summary.outcome,
    ...(input.reason === undefined || input.reason.length === 0
      ? {}
      : { reason: input.reason }),
    workItems: input.workItems ?? [],
  };
}

/** 账本写下与交付投影共用的一次目录条目结算。 */
export function libraryScanLedgerWrite(input: {
  readonly parentExecutionId: string;
  readonly result: LibraryScanDirectoryResult;
  readonly summary: LibraryScanEntryOutcome;
}): {
  readonly parentExecutionId: string;
  readonly directoryKey: string;
  readonly stage: LibraryScanDirectoryStage;
  readonly outcome: AssetRefreshOutcome;
  readonly reason?: string;
  readonly workItemCount: number;
  readonly unresolvedCount: number;
  readonly failedCount: number;
} {
  return {
    parentExecutionId: input.parentExecutionId,
    directoryKey: input.result.directoryKey,
    stage: input.summary.outcome === "cancelled" ? "cancelled" : "settled",
    outcome: input.summary.outcome,
    ...(input.result.reason === undefined
      ? {}
      : { reason: input.result.reason }),
    workItemCount: input.summary.workItemCount,
    unresolvedCount: input.summary.unresolvedCount,
    failedCount: input.summary.failedCount,
  };
}
