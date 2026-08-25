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
 * 只解析调用方提供的有限投影。它没有查询或图依赖，因此无法静默扩大所选集合。
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
    // 展示投影无权从节点重建已观察文件系统范围。文件系统动作只能经由已注册根入口进入应用层；
    // 这些入口会在自身边界解析并冻结该权威。
    filesystemScopes: [],
  };
}
