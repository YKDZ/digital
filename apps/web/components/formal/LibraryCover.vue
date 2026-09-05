<script setup lang="ts">
import { Files } from "@lucide/vue";
import { ref, watch } from "vue";

import type { LibraryAsset } from "#/lib/library";
const props = defineProps<{ asset: LibraryAsset; natural?: boolean }>();
const emit = defineEmits<{ ratio: [value: number] }>();
const failed = ref(false);
watch(
  () => props.asset.cover,
  () => {
    failed.value = false;
  },
);
function loaded(event: Event) {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.naturalWidth > 0)
    emit("ratio", image.naturalHeight / image.naturalWidth);
}
</script>

<template>
  <div
    data-testid="asset-cover"
    class="flex size-full items-center justify-center overflow-hidden rounded-lg bg-stone-100/80"
  >
    <img
      v-if="asset.cover && !failed"
      :src="asset.cover"
      :alt="`${asset.title}的封面`"
      class="max-h-full w-full object-contain"
      :class="natural ? 'h-auto' : 'h-full'"
      loading="lazy"
      referrerpolicy="no-referrer"
      @load="loaded"
      @error="failed = true"
    />
    <Files
      v-else
      class="size-1/4 max-h-9 max-w-9 text-stone-400"
      :stroke-width="1.25"
      aria-hidden="true"
    />
  </div>
</template>
