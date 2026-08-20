import {
  assetRefreshSelectionVersion,
  type AssetRefreshSelection,
  type AssetRefreshSelectionExplanation,
} from "@digital/application";

export type AssetRefreshSelectionNode = {
  readonly key: string;
  readonly label: string;
  readonly subjectId?: string;
  readonly children: readonly AssetRefreshSelectionNode[];
};

/**
 * Resolves only the finite projection supplied by the caller. It has no query
 * or graph dependency and therefore cannot silently expand the selected set.
 */
export function resolveAssetRefreshSelection(
  selectedRoots: readonly AssetRefreshSelectionNode[],
): AssetRefreshSelection {
  const subjects = new Map<string, AssetRefreshSelectionExplanation[]>();
  const visit = (
    node: AssetRefreshSelectionNode,
    labels: readonly string[],
    active: ReadonlySet<AssetRefreshSelectionNode>,
  ) => {
    if (active.has(node)) {
      throw new Error("Asset Refresh projection contains a cycle");
    }
    if (node.key.length === 0 || node.label.length === 0) {
      throw new Error("Asset Refresh projection node is invalid");
    }
    const path = [...labels, node.label];
    const nextActive = new Set(active).add(node);
    if (node.subjectId !== undefined) {
      subjects.set(node.subjectId, [
        ...(subjects.get(node.subjectId) ?? []),
        { path },
      ]);
    }
    for (const child of node.children) visit(child, path, nextActive);
  };
  for (const root of selectedRoots) visit(root, [], new Set());
  return {
    version: assetRefreshSelectionVersion,
    subjects: [...subjects].map(([subjectId, explanations]) => ({
      subjectId,
      explanations,
    })),
    // A presentation projection has no authority to reconstruct an observed
    // filesystem scope from a node. Filesystem actions enter Application only
    // through the registered-root entrypoints, which resolve and freeze that
    // authority at their own boundary.
    filesystemScopes: [],
  };
}
