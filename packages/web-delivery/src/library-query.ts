import type { CurrentCatalogueIndexEntry } from "@digital/application";
import {
  libraryCategories,
  projectCatalogue,
  projectLibraryAsset,
} from "@digital/presentation";

import type { CataloguePageRequest, LibraryQuery } from "./catalogue.ts";

type Key = {
  readonly id: string;
  readonly name: string;
  readonly additionOrder: number;
};
const collator = new Intl.Collator("zh-CN", { numeric: true });

/** 先形成完整展示分组，再分页；同一剧集不会因底层主体分页而重复出现。 */
export function libraryItems(entries: readonly CurrentCatalogueIndexEntry[]) {
  const orders = new Map(
    entries.map((entry) => [entry.id, entry.additionOrder]),
  );
  return projectCatalogue(entries).map((view) => {
    const subjectIds =
      "works" in view
        ? [...new Set(view.episodes.map((episode) => episode.assetId))]
        : [view.id];
    return {
      view,
      subjectIds,
      additionOrder: Math.max(
        0,
        ...subjectIds.map((id) => orders.get(id) ?? 0),
      ),
    };
  });
}

/** 完整检索轻量当前索引；只把所选页交给后续文件与封面投影。 */
export function selectLibraryPage(
  entries: readonly CurrentCatalogueIndexEntry[],
  input: LibraryQuery,
  page: CataloguePageRequest = {},
) {
  const limit = page.limit ?? 24;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("分页数量无效");
  const query = {
    assetLibraryId: input.assetLibraryId ?? "",
    text: input.text?.trim().toLocaleLowerCase() ?? "",
    category: input.category ?? "all",
    sort: input.sort ?? "recent",
  };
  if (
    query.text.length > 200 ||
    !["recent", "name"].includes(query.sort) ||
    (query.category !== "all" &&
      !Object.hasOwn(libraryCategories, query.category))
  )
    throw new Error("浏览条件无效");
  const signature = JSON.stringify(query);
  const compare = (left: Key, right: Key) =>
    (query.sort === "name"
      ? collator.compare(left.name, right.name)
      : right.additionOrder - left.additionOrder) ||
    left.id.localeCompare(right.id);
  let anchor: Key | undefined;
  if (page.cursor !== undefined) {
    try {
      if (!/^[\w-]{1,4096}$/u.test(page.cursor)) throw new Error();
      const decoded: unknown = JSON.parse(
        Buffer.from(page.cursor, "base64url").toString("utf8"),
      );
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        !("signature" in decoded) ||
        decoded.signature !== signature ||
        !("key" in decoded) ||
        typeof decoded.key !== "object" ||
        decoded.key === null
      )
        throw new Error();
      const key = decoded.key;
      if (
        !("id" in key) ||
        typeof key.id !== "string" ||
        !("name" in key) ||
        typeof key.name !== "string" ||
        !("additionOrder" in key) ||
        typeof key.additionOrder !== "number" ||
        !Number.isSafeInteger(key.additionOrder)
      )
        throw new Error();
      anchor = { id: key.id, name: key.name, additionOrder: key.additionOrder };
    } catch {
      throw new Error("浏览续页信息无效，请重新加载");
    }
  }
  const summaries = libraryItems(entries).map((entry) => {
    const view = projectLibraryAsset(entry.view);
    return {
      ...view,
      name: view.title,
      additionOrder: entry.additionOrder,
      subjectIds: entry.subjectIds,
    };
  });
  const categories = [...new Set(summaries.map((item) => item.category))].map(
    (id) => ({ id, label: libraryCategories[id] }),
  );
  const filtered = summaries
    .filter(
      (item) =>
        (query.category === "all" || item.category === query.category) &&
        (!query.text ||
          `${item.title} ${item.creator ?? ""}`
            .toLocaleLowerCase()
            .includes(query.text)),
    )
    .toSorted(compare);
  const remaining =
    anchor === undefined
      ? filtered
      : filtered.filter((item) => compare(item, anchor) > 0);
  const selected = remaining.slice(0, limit);
  const last = selected.at(-1);
  return {
    ids: selected.map((item) => item.id),
    subjectIds: [...new Set(selected.flatMap((item) => item.subjectIds))],
    total: filtered.length,
    categories,
    pagination:
      remaining.length <= limit || last === undefined
        ? {}
        : {
            nextCursor: Buffer.from(
              JSON.stringify({
                signature,
                key: {
                  id: last.id,
                  name: last.name,
                  additionOrder: last.additionOrder,
                },
              }),
            ).toString("base64url"),
          },
  };
}
