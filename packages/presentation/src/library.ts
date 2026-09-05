import type { AssetViewModel, BangumiSeriesViewModel } from "./index.ts";

/** 浏览类别属于展示选择，不是数字资产的领域子类型。 */
export const libraryCategories = {
  book: "书籍",
  film: "影片",
  dlsite: "音声",
  fanbox: "帖子",
  bangumi: "剧集",
  generic: "未分类",
} as const;
export type LibraryCategory = keyof typeof libraryCategories;

/** 检索只需要名称、书籍署名和展示判定所用的事实，正文和文件图无需进入索引。 */
export const libraryIndexMetadataProperties = [
  "asset.title",
  "asset.content-classification",
  "asset.title.zh-hans",
  "book.contributor",
  "book.isbn-13",
  "book.publisher",
  "bangumi.episode.season-position",
  "bangumi.episode.continuous-position",
  "bangumi.subject.name",
  "bangumi.subject.name.zh-hans",
] as const;

export function projectLibraryAsset(
  asset: AssetViewModel | BangumiSeriesViewModel,
) {
  if ("works" in asset)
    return {
      id: asset.id,
      title: asset.title,
      cover: asset.cover,
      category: "bangumi" as const,
      creator: undefined,
      fileCount: undefined,
      description: asset.summary,
      publisher: undefined,
      date: asset.date,
    };
  const creators =
    asset.book?.contributors ??
    asset.film?.directors ??
    asset.relationships
      .filter((item) => item.heading === "参与者")
      .map((item) => item.label);
  return {
    id: asset.id,
    title: asset.title,
    cover:
      asset.cover ??
      asset.book?.cover ??
      asset.film?.cover ??
      asset.dlsite?.cover ??
      asset.fanbox?.cover,
    category: asset.cardComponent,
    creator:
      asset.fanbox?.creator ??
      asset.dlsite?.circle ??
      (creators.length ? creators.join("、") : undefined),
    fileCount: asset.book?.files.length,
    description: asset.summary ?? asset.introduction,
    publisher: asset.book?.publisher,
    date:
      asset.book?.publicationDate ??
      asset.releaseDate ??
      asset.publicationDateTime,
  };
}
