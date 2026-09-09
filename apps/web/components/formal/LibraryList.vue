<script setup lang="ts">
import { PanelRight, X } from "@lucide/vue";
import { useElementBounding, useWindowSize } from "@vueuse/core";
import { computed, ref, watch } from "vue";

import LibraryCover from "#/components/formal/LibraryCover.vue";
import LibraryPreview from "#/components/formal/LibraryPreview.vue";
import { Button } from "#/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import type { LibraryAsset } from "#/lib/library";
const props = defineProps<{
  assets: readonly LibraryAsset[];
  selected?: LibraryAsset;
  previewOpen: boolean;
}>();
const emit = defineEmits<{
  select: [asset: LibraryAsset, event?: MouseEvent];
  open: [asset: LibraryAsset];
  togglePreview: [];
}>();
const previewPanel = ref<HTMLElement>();
const previewContent = ref<HTMLElement>();
watch(
  () => props.selected?.id,
  () => {
    if (previewContent.value) previewContent.value.scrollTop = 0;
  },
);
const { top } = useElementBounding(previewPanel, {
  updateTiming: "next-frame",
});
const { height: windowHeight } = useWindowSize();
// 初始位置和吸顶位置都只使用当前屏幕的剩余高度。
const previewHeight = computed(() =>
  Math.max(0, windowHeight.value - Math.max(top.value, 96) - 24),
);
function moveSelection(event: KeyboardEvent, index: number, step: number) {
  const nextIndex = Math.max(
    0,
    Math.min(props.assets.length - 1, index + step),
  );
  const asset = props.assets[nextIndex];
  if (!asset || !(event.currentTarget instanceof HTMLElement)) return;
  event.currentTarget
    .closest("tbody")
    ?.querySelectorAll<HTMLButtonElement>("button")
    [nextIndex]?.focus();
  emit("select", asset);
}
</script>

<template>
  <div class="flex items-start gap-8">
    <div class="min-w-0 flex-1">
      <div class="mb-3 hidden justify-end lg:flex">
        <Button
          variant="ghost"
          size="sm"
          :aria-pressed="previewOpen"
          @click="$emit('togglePreview')"
          ><PanelRight class="size-4" />预览</Button
        >
      </div>
      <Table class="table-fixed">
        <TableCaption class="sr-only">内容</TableCaption>
        <TableHeader
          ><TableRow class="hover:bg-transparent"
            ><TableHead class="pl-2">名称</TableHead
            ><TableHead class="hidden w-28 md:table-cell"
              >类型</TableHead
            ></TableRow
          ></TableHeader
        >
        <TableBody
          ><TableRow
            v-for="(asset, index) in assets"
            :key="asset.id"
            :data-state="
              selected?.id === asset.id && previewOpen ? 'selected' : undefined
            "
            class="cursor-pointer"
            :aria-selected="selected?.id === asset.id"
            @click="$emit('select', asset, $event)"
            @dblclick="$emit('open', asset)"
          >
            <TableCell class="py-3 pl-2"
              ><button
                type="button"
                class="flex w-full min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :aria-label="`查看 ${asset.title}`"
                :tabindex="selected?.id === asset.id ? 0 : -1"
                @click.stop="$emit('select', asset, $event)"
                @keydown.enter.prevent="$emit('open', asset)"
                @keydown.up.prevent="moveSelection($event, index, -1)"
                @keydown.down.prevent="moveSelection($event, index, 1)"
              >
                <span class="size-12 shrink-0"
                  ><LibraryCover :asset="asset" /></span
                ><span class="min-w-0"
                  ><span class="block truncate text-[15px] font-medium">{{
                    asset.title
                  }}</span
                  ><span
                    v-if="asset.creator || asset.fileCount !== undefined"
                    class="mt-1 block truncate text-sm text-muted-foreground"
                    >{{ asset.creator ?? `${asset.fileCount} 个文件` }}</span
                  ></span
                >
              </button></TableCell
            >
            <TableCell
              class="hidden truncate text-sm text-muted-foreground md:table-cell"
              >{{ asset.classification ?? "—" }}</TableCell
            >
          </TableRow></TableBody
        >
      </Table>
    </div>
    <aside
      ref="previewPanel"
      v-if="previewOpen && selected"
      class="sticky top-24 hidden w-72 shrink-0 flex-col overflow-hidden border-l pl-8 lg:flex 2xl:w-80"
      :style="{ maxHeight: `${previewHeight}px` }"
      aria-label="预览"
    >
      <div class="mb-5 flex h-8 shrink-0 items-center justify-between">
        <h2 class="text-sm font-medium">预览</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="收起预览"
          @click="$emit('togglePreview')"
          ><X class="size-4"
        /></Button>
      </div>
      <div
        ref="previewContent"
        class="min-h-0 overflow-y-auto overscroll-contain pr-2"
        role="region"
        aria-label="预览内容"
        tabindex="0"
      >
        <LibraryPreview :asset="selected" />
      </div>
    </aside>
  </div>
</template>
