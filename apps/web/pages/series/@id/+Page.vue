<script setup lang="ts">
import { computed } from "vue";

import AssetDetail from "#/components/formal/AssetDetail.vue";
import { Button } from "#/components/ui/button";
import { useCatalogue } from "#/composables/use-catalogue";

const { catalogue, error, loading } = useCatalogue();
const seriesId =
  typeof window === "undefined"
    ? ""
    : decodeURIComponent(window.location.pathname.split("/").at(-1) ?? "");
const series = computed(() =>
  catalogue.value.assets.find(
    (item) =>
      "component" in item &&
      item.component === "bangumi" &&
      item.id === seriesId,
  ),
);
</script>

<template>
  <p v-if="loading" role="status" class="text-muted-foreground">
    正在读取内容…
  </p>
  <p v-else-if="error" role="alert" class="text-destructive">{{ error }}</p>
  <section v-else-if="series">
    <AssetDetail :asset="series" />
  </section>
  <section v-else class="grid gap-4">
    <h1 class="text-3xl font-bold">未找到作品系列</h1>
    <p class="text-muted-foreground">它可能尚未确认，或已不再可浏览。</p>
    <Button as="a" href="/" class="w-fit">返回全部内容</Button>
  </section>
</template>
