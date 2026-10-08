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

/** 署名和集数来自生效关系；索引只载入名称与展示判定需要的描述。 */
export const libraryIndexMetadataProperties = [
  "asset.title",
  "asset.content-classification",
  "asset.title.zh-hans",
  "book.isbn-13",
  "book.publisher",
  "bangumi.subject.name",
  "bangumi.subject.name.zh-hans",
] as const;

export function projectLibraryAsset(
  asset: AssetViewModel | BangumiSeriesViewModel,
) {
  // 首页卡片必须保留生效读取的问题与状态，否则缺失／冲突资产只显示标题。
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
      factProblems: asset.factProblems,
      informationReadiness: undefined,
      missingFacts: undefined,
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
    factProblems: asset.factProblems,
    informationReadiness: asset.informationReadiness,
    missingFacts: asset.missingFacts,
  };
}
