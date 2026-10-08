<script setup lang="ts">
import {
  ArrowDownWideNarrow,
  CircleAlert,
  LayoutGrid,
  Library,
  List,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "@lucide/vue";
import {
  useInfiniteScroll,
  useLocalStorage,
  useMediaQuery,
  useMounted,
  useResizeObserver,
} from "@vueuse/core";
import { usePageContext } from "vike-vue/usePageContext";
import { navigate } from "vike/client/router";
import { computed, onMounted, ref, watch } from "vue";

import LibraryList from "#/components/formal/LibraryList.vue";
import LibraryMasonry from "#/components/formal/LibraryMasonry.vue";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Skeleton } from "#/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { useLibrary } from "#/composables/use-library";
import type { LibraryAsset } from "#/lib/library";

const {
  assetLibraryId,
  libraryName,
  libraryMissing,
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
  hasMore,
  reload,
  loadMore,
} = useLibrary();
const pageContext = usePageContext();
const rememberedView = useLocalStorage("digital.library.view", "covers", {
  initOnMounted: true,
});
const view = computed(() => {
  const explicit = pageContext.urlParsed.search.view;
  return explicit === "list" || explicit === "covers"
    ? explicit
    : rememberedView.value === "list"
      ? "list"
      : "covers";
});
function rememberExplicitView() {
  const explicit = pageContext.urlParsed.search.view;
  if (explicit === "list" || explicit === "covers")
    rememberedView.value = explicit;
}
onMounted(rememberExplicitView);
watch(() => pageContext.urlParsed.search.view, rememberExplicitView);
const toggleViewLabel = computed(() =>
  view.value === "covers" ? "切换为列表模式" : "切换为封面模式",
);
const content = ref<HTMLElement>();
const mounted = useMounted();
const selectedId = ref<string>();
const selected = computed(
  () =>
    assets.value.find((asset) => asset.id === selectedId.value) ??
    assets.value[0],
);
const previewOpen = ref(true);
const isWide = useMediaQuery("(min-width: 1024px)");
const { reset: checkScroll } = useInfiniteScroll(
  () => (typeof window === "undefined" ? undefined : window),
  loadMore,
  {
    distance: 300,
    canLoadMore: () =>
      mounted.value &&
      hasMore.value &&
      !loading.value &&
      !loadingMore.value &&
      !pageError.value,
  },
);
useResizeObserver(content, () => requestAnimationFrame(checkScroll));
watch([query, category, sort], () => {
  selectedId.value = undefined;
});
function clearFilters() {
  query.value = "";
  category.value = "all";
}
async function toggleView() {
  const next = view.value === "covers" ? "list" : "covers";
  rememberedView.value = next;
  const url = new URL(window.location.href);
  url.searchParams.set("view", next);
  await navigate(`${url.pathname}${url.search}`, {
    overwriteLastHistoryEntry: true,
    keepScrollPosition: true,
  });
}
function open(asset: LibraryAsset) {
  // 库内浏览保留库语境，详情据此用该库自己的冻结配置补充资料。
  void navigate(
    assetLibraryId.value === undefined
      ? asset.href
      : `${asset.href}?library=${encodeURIComponent(assetLibraryId.value)}`,
  );
}
function select(asset: LibraryAsset, event?: MouseEvent) {
  if (
    !isWide.value ||
    (event instanceof PointerEvent && event.pointerType === "touch")
  ) {
    open(asset);
    return;
  }
  selectedId.value = asset.id;
  previewOpen.value = true;
}
</script>

<template>
  <section ref="content">
    <div class="mb-8 flex items-center gap-3">
      <h1 class="text-[28px] font-semibold tracking-tight sm:text-[32px]">
        {{ libraryName }}
      </h1>
      <span
        v-if="total !== undefined && !loading && !error"
        class="mt-1 text-sm tabular-nums text-muted-foreground"
        >{{ total }}</span
      >
    </div>
    <div
      v-if="
        !libraryMissing &&
        (loading || error || assets.length || query || category !== 'all')
      "
      class="sticky top-0 z-20 mb-8 flex flex-wrap items-center gap-3 bg-background/95 py-3 backdrop-blur"
    >
      <div class="relative w-full sm:max-w-xs sm:flex-1">
        <Search
          class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          v-model="query"
          :disabled="!mounted"
          aria-label="搜索内容"
          placeholder="搜索名称、创作者"
          class="h-10 rounded-lg bg-stone-50/60 pr-9 pl-9 shadow-none"
        />
        <Button
          v-if="query"
          variant="ghost"
          size="icon-xs"
          class="absolute top-1/2 right-2 -translate-y-1/2"
          aria-label="清除搜索"
          @click="query = ''"
          ><X class="size-3.5"
        /></Button>
      </div>
      <Select v-model="category" :disabled="!mounted"
        ><SelectTrigger
          aria-label="筛选内容"
          class="h-10 min-w-28 rounded-lg shadow-none"
          ><SelectValue /></SelectTrigger
        ><SelectContent
          ><SelectItem value="all">全部类型</SelectItem
          ><SelectItem
            v-for="item in categories"
            :key="item.id"
            :value="item.id"
            >{{ item.label }}</SelectItem
          ></SelectContent
        ></Select
      >
      <Select v-model="sort" :disabled="!mounted"
        ><SelectTrigger
          aria-label="排序方式"
          class="ml-auto h-10 gap-2 border-0 px-2 shadow-none"
          ><ArrowDownWideNarrow
            class="size-4 text-muted-foreground" /><SelectValue /></SelectTrigger
        ><SelectContent align="end"
          ><SelectItem value="recent">最近添加</SelectItem
          ><SelectItem value="name">名称排序</SelectItem></SelectContent
        ></Select
      >
      <Tooltip
        ><TooltipTrigger as-child
          ><Button
            variant="outline"
            size="icon"
            class="size-10 shrink-0 rounded-lg shadow-none"
            :aria-label="toggleViewLabel"
            :disabled="!mounted"
            @click="toggleView"
            ><List v-if="view === 'covers'" class="size-4" /><LayoutGrid
              v-else
              class="size-4" /></Button></TooltipTrigger
        ><TooltipContent>{{ toggleViewLabel }}</TooltipContent></Tooltip
      >
    </div>
    <div
      v-if="libraryMissing"
      class="flex min-h-[45vh] flex-col items-center justify-center gap-5 text-center"
      role="alert"
    >
      <div class="rounded-2xl bg-stone-100 p-5">
        <CircleAlert class="size-8 text-stone-400" :stroke-width="1.3" />
      </div>
      <h2 class="text-lg font-medium">这个资产库已不可用</h2>
      <p class="max-w-md text-sm text-muted-foreground">
        它可能已被移除，或链接已经过期。
      </p>
      <div class="flex flex-wrap items-center justify-center gap-3">
        <Button as="a" href="/">查看全部内容</Button>
        <Button variant="outline" as="a" href="/settings/automation"
          >管理资产库</Button
        >
      </div>
    </div>
    <div
      v-else-if="error"
      class="flex min-h-[45vh] flex-col items-center justify-center gap-5 text-center"
      role="alert"
    >
      <div class="rounded-2xl bg-stone-100 p-5">
        <CircleAlert class="size-8 text-stone-400" :stroke-width="1.3" />
      </div>
      <h2 class="text-lg font-medium">暂时无法加载内容</h2>
      <p class="max-w-md text-sm text-muted-foreground">{{ error }}</p>
      <Button variant="outline" @click="reload">重试</Button>
    </div>
    <div
      v-else-if="loading"
      role="status"
      aria-label="正在加载内容"
      class="grid grid-cols-2 gap-5 lg:grid-cols-4"
    >
      <div v-for="index in 8" :key="index" class="space-y-3">
        <Skeleton class="h-52 rounded-lg" /><Skeleton
          class="h-4 w-3/4"
        /><Skeleton class="h-3 w-1/2" />
      </div>
    </div>
    <div
      v-else-if="!assets.length && (query || category !== 'all')"
      class="flex min-h-[40vh] flex-col items-center justify-center gap-5 text-center"
    >
      <Search class="size-8 text-stone-300" :stroke-width="1.3" />
      <h2 class="text-lg font-medium">没有找到内容</h2>
      <Button variant="outline" @click="clearFilters">清除筛选</Button>
    </div>
    <div
      v-else-if="!assets.length && assetLibraryId !== undefined"
      class="flex min-h-[45vh] flex-col items-center justify-center gap-5 text-center"
    >
      <div class="rounded-2xl bg-stone-100 p-5">
        <Library class="size-8 text-stone-400" :stroke-width="1.3" />
      </div>
      <h2 class="text-lg font-medium">这个资产库还没有内容</h2>
      <p class="max-w-md text-sm text-muted-foreground">
        目录已连接，但尚未发现可显示的内容。可以扫描该目录，或调整资产库设置。
      </p>
      <div class="flex flex-wrap items-center justify-center gap-3">
        <Button as="a" href="/settings/automation">扫描或调整资产库</Button>
        <Button variant="outline" as="a" href="/">查看全部内容</Button>
      </div>
    </div>
    <div
      v-else-if="!assets.length"
      class="flex min-h-[45vh] flex-col items-center justify-center gap-5 text-center"
    >
      <div class="rounded-2xl bg-stone-100 p-5">
        <Library class="size-8 text-stone-400" :stroke-width="1.3" />
      </div>
      <h2 class="text-lg font-medium">还没有内容</h2>
      <Button as="a" href="/intake"><Plus class="size-4" />添加内容</Button>
    </div>
    <template v-else>
      <LibraryMasonry
        v-if="view === 'covers'"
        :assets="assets"
        @select="open"
      />
      <LibraryList
        v-else
        :assets="assets"
        :selected="selected"
        :preview-open="previewOpen"
        @select="select"
        @open="open"
        @toggle-preview="previewOpen = !previewOpen"
      />
      <div
        class="mt-10 flex min-h-10 flex-col items-center gap-3"
        aria-live="polite"
      >
        <template v-if="pageError"
          ><p class="text-sm text-muted-foreground" role="alert">
            下一页未能加载：{{ pageError }}
          </p>
          <Button variant="outline" @click="loadMore">重试</Button></template
        >
        <p
          v-else-if="loadingMore"
          class="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle class="size-4 animate-spin" />正在加载
        </p>
        <p v-else-if="!hasMore" class="text-sm text-muted-foreground">
          已显示全部内容
        </p>
      </div>
    </template>
  </section>
</template>
