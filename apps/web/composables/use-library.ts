import { requestCatalogue } from "@digital/web-delivery/client";
import { useDebounceFn } from "@vueuse/core";
import { usePageContext } from "vike-vue/usePageContext";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { useLibraryNavigation } from "#/composables/use-library-navigation";
import { libraryAsset, type LibraryAsset } from "#/lib/library";

export function useLibrary() {
  const pageContext = usePageContext();
  const assetLibraryId = computed(() =>
    typeof pageContext.urlParsed.search.library === "string"
      ? pageContext.urlParsed.search.library
      : undefined,
  );
  const {
    items: libraries,
    loading: librariesLoading,
    error: librariesError,
  } = useLibraryNavigation();
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
  const error = ref<string>();
  const pageError = ref<string>();
  const cursor = ref<string>();
  let version = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  const library = computed(() =>
    assetLibraryId.value === undefined
      ? undefined
      : libraries.value.find((item) => item.id === assetLibraryId.value),
  );
  // 导航已成功读取过资产库列表却找不到该 ID，才判定链接指向已失效的库。
  const libraryMissing = computed(
    () =>
      assetLibraryId.value !== undefined &&
      !librariesLoading.value &&
      librariesError.value === undefined &&
      library.value === undefined,
  );

  function reset() {
    version += 1;
    controller?.abort();
    assets.value = [];
    total.value = undefined;
    cursor.value = undefined;
    loading.value = true;
    loadingMore.value = false;
    error.value = undefined;
    pageError.value = undefined;
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
    pageError.value = undefined;
    try {
      const page = await requestCatalogue({
        surface: "current-catalogue",
        query: {
          ...(assetLibraryId.value === undefined
            ? {}
            : { assetLibraryId: assetLibraryId.value }),
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
    } catch (cause) {
      if (requestVersion !== version || disposed) return;
      const message =
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "暂时无法读取内容";
      if (append) pageError.value = message;
      else error.value = message;
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
    [query, category, sort, assetLibraryId],
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
    assetLibraryId,
    libraryName: computed(() =>
      assetLibraryId.value === undefined
        ? "全部内容"
        : (library.value?.displayName ?? "未知资产库"),
    ),
    library,
    libraryMissing,
    libraryUnreachable: computed(
      () =>
        assetLibraryId.value !== undefined &&
        librariesError.value !== undefined,
    ),
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
