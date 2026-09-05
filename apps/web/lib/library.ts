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
