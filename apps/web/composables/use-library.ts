import { requestCatalogue } from "@digital/web-delivery/client";
import { useDebounceFn } from "@vueuse/core";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { libraryAsset, type LibraryAsset } from "#/lib/library";

export function useLibrary() {
  const assets = ref<LibraryAsset[]>([]);
  const query = ref("");
  const category = ref("all");
  const sort = ref("recent");
  const total = ref<number>();
  const categories = ref<
    readonly { readonly id: string; readonly label: string }[]
  >([]);
  const loading = ref(true);
  const loadingMore = ref(false);
  const error = ref(false);
  const pageError = ref(false);
  const cursor = ref<string>();
  let version = 0;
  let disposed = false;
  let controller: AbortController | undefined;

  function reset() {
    version += 1;
    controller?.abort();
    assets.value = [];
    total.value = undefined;
    cursor.value = undefined;
    loading.value = true;
    loadingMore.value = false;
    error.value = false;
    pageError.value = false;
  }
  async function load(append: boolean) {
    if (
      disposed ||
      (append &&
        (loading.value || loadingMore.value || cursor.value === undefined))
    )
      return;
    const requestVersion = version;
    controller = new AbortController();
    if (append) loadingMore.value = true;
    pageError.value = false;
    try {
      const page = await requestCatalogue({
        surface: "current-catalogue",
        query: {
          text: query.value,
          category: category.value,
          sort: sort.value === "name" ? "name" : "recent",
        },
        page: { limit: 24, ...(append ? { cursor: cursor.value } : {}) },
        signal: controller.signal,
      });
      // 输入一变就使旧请求失效，不等防抖结束；取消请求之外仍核对代次。
      if (requestVersion !== version || disposed) return;
      const next = page.assets.map(libraryAsset);
      assets.value = append ? [...assets.value, ...next] : next;
      cursor.value = page.pagination.nextCursor;
      total.value = page.total;
      categories.value = page.categories ?? [];
    } catch {
      if (requestVersion !== version || disposed) return;
      if (append) pageError.value = true;
      else error.value = true;
    } finally {
      if (requestVersion === version && !disposed) {
        loading.value = false;
        loadingMore.value = false;
      }
    }
  }
  function reload() {
    reset();
    return load(false);
  }
  const debouncedLoad = useDebounceFn(() => load(false), 250);
  watch(
    [query, category, sort],
    () => {
      reset();
      void debouncedLoad();
    },
    { flush: "sync" },
  );
  onMounted(() => void reload());
  onBeforeUnmount(() => {
    disposed = true;
    version += 1;
    controller?.abort();
  });
  return {
    assets,
    query,
    category,
    sort,
    total,
    categories,
    loading,
    loadingMore,
    error,
    pageError,
    hasMore: computed(() => cursor.value !== undefined),
    reload,
    loadMore: () => load(true),
  };
}
