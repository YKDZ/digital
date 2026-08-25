import path from "node:path";

import {
  decodeObservedRootSnapshot,
  normalizeObservedRelativeScope,
} from "./observed-root-authority.ts";
import type { ObservedRootSnapshot } from "./observed-root-registrations.ts";

export const assetRefreshSelectionVersion = "asset-refresh-selection/1";

export type AssetRefreshSelectionExplanation = {
  readonly path: readonly string[];
};

/**
 * 文件系统选择是权威边界的耐久证据，而不是调用方提供的路径。因此新工作流输入必须
 * 同时保留冻结的注册快照及其规范化范围。
 */
export type RegisteredFilesystemScope = {
  /** 为审计保留的逻辑位置证据；绝不是权威授予。 */
  readonly root: string;
  readonly observedRoot: ObservedRootSnapshot;
  readonly relativeScope: string;
  readonly explanations: readonly AssetRefreshSelectionExplanation[];
};

export type AssetRefreshSelection = {
  readonly version: typeof assetRefreshSelectionVersion;
  readonly subjects: readonly {
    readonly subjectId: string;
    readonly explanations: readonly AssetRefreshSelectionExplanation[];
  }[];
  /** 每个新文件系统范围都已经绑定到注册观察根。 */
  readonly filesystemScopes: readonly RegisteredFilesystemScope[];
};

export type ResolvedAssetRefreshSelection = AssetRefreshSelection;

/**
 * 为冻结的注册范围生成唯一耐久位置拼写。该拼写只作为证据；允许未来绑定描述符的
 * 权威仍是快照与相对范围。
 */
export function derivedRegisteredFilesystemScopeRoot(input: {
  readonly observedRoot: ObservedRootSnapshot;
  readonly relativeScope: string;
}): string {
  return path.resolve(input.observedRoot.containerPath, input.relativeScope);
}

export function assertAssetRefreshSelection(
  value: unknown,
): asserts value is AssetRefreshSelection {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== assetRefreshSelectionVersion
  ) {
    throw new Error("Unsupported Asset Refresh Selection version");
  }
  const candidate = value as {
    subjects?: unknown;
    filesystemScopes?: unknown;
  };
  if (
    !Array.isArray(candidate.subjects) ||
    !Array.isArray(candidate.filesystemScopes)
  ) {
    throw new Error("Asset Refresh Selection targets are invalid");
  }

  if (
    !candidate.subjects.every(
      (target) =>
        typeof target === "object" &&
        target !== null &&
        typeof (target as { subjectId?: unknown }).subjectId === "string" &&
        (target as { subjectId: string }).subjectId.length > 0 &&
        validExplanations((target as { explanations?: unknown }).explanations),
    ) ||
    !candidate.filesystemScopes.every(
      (target) =>
        typeof target === "object" &&
        target !== null &&
        typeof (target as { root?: unknown }).root === "string" &&
        (target as { root: string }).root.length > 0 &&
        decodeObservedRootScope(target) !== undefined &&
        validExplanations((target as { explanations?: unknown }).explanations),
    ) ||
    (candidate.subjects.length === 0 && candidate.filesystemScopes.length === 0)
  ) {
    throw new Error("Asset Refresh Selection targets are invalid");
  }
}

function decodeObservedRootScope(
  value: object,
):
  | Pick<RegisteredFilesystemScope, "root" | "observedRoot" | "relativeScope">
  | undefined {
  const target = value as Record<string, unknown>;
  const rootInput = target.root;
  const observedRoot = target.observedRoot;
  const relativeScopeInput = target.relativeScope;
  if (typeof rootInput !== "string" || rootInput.length === 0) return undefined;
  if (observedRoot === undefined) return undefined;
  if (typeof relativeScopeInput !== "string") return undefined;
  const root = decodeObservedRootSnapshot(observedRoot);
  if (!root.valid) return undefined;
  try {
    const relativeScope = normalizeObservedRelativeScope(relativeScopeInput);
    if (relativeScope !== relativeScopeInput) return undefined;
    const derivedRoot = derivedRegisteredFilesystemScopeRoot({
      observedRoot: root.value,
      relativeScope,
    });
    if (rootInput !== derivedRoot) return undefined;
    return { root: derivedRoot, observedRoot: root.value, relativeScope };
  } catch {
    return undefined;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergeExplanations(
  values: readonly AssetRefreshSelectionExplanation[],
): readonly AssetRefreshSelectionExplanation[] {
  const byPath = new Map<string, AssetRefreshSelectionExplanation>();
  for (const explanation of values) {
    if (
      explanation.path.length === 0 ||
      explanation.path.some((label) => label.length === 0)
    ) {
      throw new Error("Asset Refresh Selection explanation path is invalid");
    }
    byPath.set(JSON.stringify(explanation.path), {
      path: [...explanation.path],
    });
  }
  return [...byPath.entries()]
    .toSorted(([left], [right]) => compareCodeUnits(left, right))
    .map(([, explanation]) => explanation);
}

export async function freezeAssetRefreshSelection(
  requested: AssetRefreshSelection,
): Promise<ResolvedAssetRefreshSelection> {
  assertAssetRefreshSelection(requested);
  const subjects = new Map<string, AssetRefreshSelectionExplanation[]>();
  for (const target of requested.subjects) {
    if (target.subjectId.length === 0) {
      throw new Error("Asset Refresh Selection subject is empty");
    }
    subjects.set(target.subjectId, [
      ...(subjects.get(target.subjectId) ?? []),
      ...target.explanations,
    ]);
  }
  const filesystemScopes = new Map<
    string,
    {
      readonly root: string;
      readonly observedRoot: ObservedRootSnapshot;
      readonly relativeScope: string;
      readonly explanations: AssetRefreshSelectionExplanation[];
    }
  >();
  for (const target of requested.filesystemScopes) {
    if (target.root.length === 0) {
      throw new Error("Asset Refresh Selection filesystem scope is empty");
    }
    const observedRootScope = decodeObservedRootScope(target);
    if (observedRootScope === undefined) {
      throw new Error("Asset Refresh Selection targets are invalid");
    }
    const root = observedRootScope.root;
    const key = JSON.stringify([
      observedRootScope.observedRoot.id,
      observedRootScope.observedRoot.configVersion,
      observedRootScope.relativeScope,
      root,
    ]);
    const current = filesystemScopes.get(key);
    filesystemScopes.set(key, {
      root,
      observedRoot: observedRootScope.observedRoot,
      relativeScope: observedRootScope.relativeScope,
      explanations: [...(current?.explanations ?? []), ...target.explanations],
    });
  }
  if (subjects.size === 0 && filesystemScopes.size === 0) {
    throw new Error("Asset Refresh Selection is empty");
  }
  return {
    version: assetRefreshSelectionVersion,
    subjects: [...subjects.entries()]
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .map(([subjectId, explanations]) => ({
        subjectId,
        explanations: mergeExplanations(explanations),
      })),
    filesystemScopes: [...filesystemScopes.entries()]
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .map(([, target]) => ({
        root: target.root,
        observedRoot: target.observedRoot,
        relativeScope: target.relativeScope,
        explanations: mergeExplanations(target.explanations),
      })),
  };
}

const validExplanations = (explanations: unknown) =>
  Array.isArray(explanations) &&
  explanations.length > 0 &&
  explanations.every(
    (explanation) =>
      typeof explanation === "object" &&
      explanation !== null &&
      Array.isArray((explanation as { path?: unknown }).path) &&
      (explanation as { path: unknown[] }).path.length > 0 &&
      (explanation as { path: unknown[] }).path.every(
        (label) => typeof label === "string" && label.length > 0,
      ),
  );
