<script lang="ts" setup>
import type { HTMLAttributes } from "vue";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <nav aria-label="面包屑导航" data-slot="breadcrumb" :class="props.class">
    <slot />
  </nav>
</template>
