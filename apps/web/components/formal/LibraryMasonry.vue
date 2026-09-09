<script setup lang="ts">
import { useResizeObserver } from "@vueuse/core";
import { computed, onBeforeUnmount, ref } from "vue";

import LibraryCover from "#/components/formal/LibraryCover.vue";
import type { LibraryAsset } from "#/lib/library";
const props = defineProps<{ assets: readonly LibraryAsset[] }>();
defineEmits<{ select: [asset: LibraryAsset] }>();
const container = ref<HTMLElement>();
const width = ref(0);
let resizeFrame: number | undefined;
useResizeObserver(container, ([entry]) => {
  if (!entry || entry.contentRect.width === width.value) return;
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    width.value = entry.contentRect.width;
  });
});
onBeforeUnmount(() => {
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
});
const ratios = ref<Record<string, number>>({});
const layout = computed(() => {
  const columns = Math.max(2, Math.min(6, Math.floor(width.value / 210)));
  const cardWidth = Math.max(0, (width.value - (columns - 1) * 20) / columns);
  const heights: number[] = Array.from({ length: columns }, () => 0);
  // 封面比例取自真实图片；按最短列追加，不在续页时重新平衡已有内容。
  const cards = props.assets.map((asset) => {
    const top = Math.min(...heights);
    const column = heights.indexOf(top);
    const coverHeight = cardWidth * (ratios.value[asset.cover ?? ""] ?? 1);
    heights[column] = top + coverHeight + 58 + 32;
    return {
      asset,
      coverHeight,
      style: {
        width: `${cardWidth}px`,
        left: `${column * (cardWidth + 20)}px`,
        top: `${top}px`,
      },
    };
  });
  return { cards, height: Math.max(0, ...heights) - 32 };
});
</script>

<template>
  <div
    ref="container"
    class="relative"
    :style="{ height: `${Math.max(0, layout.height)}px` }"
    role="list"
    aria-label="内容"
  >
    <div
      v-for="{ asset, style, coverHeight } in layout.cards"
      :key="asset.id"
      class="absolute"
      :style="style"
      role="listitem"
    >
      <button
        type="button"
        class="group w-full min-w-0 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
        :aria-label="`查看 ${asset.title}`"
        @click="$emit('select', asset)"
      >
        <div :style="{ height: `${coverHeight}px` }">
          <LibraryCover
            :asset="asset"
            natural
            class="transition-opacity group-hover:opacity-90"
            @ratio="ratios[asset.cover ?? ''] = $event"
          />
        </div>
        <h2
          class="mt-3 h-6 truncate text-[15px] leading-6 font-medium"
          :title="asset.title"
        >
          {{ asset.title }}
        </h2>
        <p class="mt-0.5 h-5 truncate text-sm leading-5 text-muted-foreground">
          {{
            [
              asset.creator ??
                (asset.fileCount === undefined
                  ? undefined
                  : `${asset.fileCount} 个文件`),
              asset.classification,
            ]
              .filter(Boolean)
              .join(" · ")
          }}
        </p>
      </button>
    </div>
  </div>
</template>
