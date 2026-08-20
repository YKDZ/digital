<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    readonly src?: string;
    readonly title: string;
    readonly placement?: "card" | "detail";
  }>(),
  { placement: "card" },
);

const containerClass = computed(() =>
  props.placement === "card"
    ? "flex h-52 items-center justify-center overflow-hidden bg-muted p-2"
    : "flex min-h-52 max-h-[32rem] items-center justify-center overflow-hidden rounded-xl bg-muted p-3",
);

const imageClass = computed(() =>
  props.placement === "card"
    ? "max-h-full max-w-full object-contain"
    : "max-h-[30rem] max-w-full object-contain",
);
</script>

<template>
  <div data-testid="asset-cover" :class="containerClass">
    <img v-if="src" :src="src" :alt="`${title}的封面`" :class="imageClass" />
    <span v-else class="text-sm text-muted-foreground">暂无封面</span>
  </div>
</template>
