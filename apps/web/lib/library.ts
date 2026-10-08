import {
  libraryCategories,
  projectLibraryAsset,
  type CatalogueAssetViewModel,
} from "@digital/web-delivery/client";

/** 路由属于 Web，类别和摘要复用检索采用的展示投影。 */
export function libraryAsset(asset: CatalogueAssetViewModel) {
  const projected = projectLibraryAsset(asset);
  return {
    ...projected,
    href: `${"works" in asset ? "/series/" : "/assets/"}${encodeURIComponent(asset.id)}`,
    classification:
      projected.category === "generic"
        ? undefined
        : libraryCategories[projected.category],
  };
}
export type LibraryAsset = ReturnType<typeof libraryAsset>;

/** 详情只有在 URL 明确带有库筛选时才携带库语境。 */
export function libraryContext(
  search: Record<string, unknown>,
): string | undefined {
  return typeof search.library === "string" && search.library !== ""
    ? search.library
    : undefined;
}

/** 详情页内部导航必须把当前库语境带到下一跳，否则共享资产会重新退回多库阻塞。 */
export function withLibraryContext(
  href: string,
  library: string | undefined,
): string {
  if (library === undefined) return href;
  return `${href}${href.includes("?") ? "&" : "?"}library=${encodeURIComponent(library)}`;
}
