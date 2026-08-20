<script setup lang="ts">
import { TabsList, TabsTrigger } from "#/components/ui/tabs";
import type { BangumiWorkViewModel } from "#/lib/catalogue";

defineProps<{
  readonly works: readonly BangumiWorkViewModel[];
}>();
</script>

<template>
  <TabsList class="h-auto max-w-full justify-start overflow-x-auto">
    <TabsTrigger
      v-for="work in works"
      :key="work.id"
      :value="work.id"
      class="whitespace-nowrap"
    >
      {{ work.title }}
    </TabsTrigger>
  </TabsList>
</template>
