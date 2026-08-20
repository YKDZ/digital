<script setup lang="ts">
import { computed } from "vue";

import AssetDetail from "#/components/formal/AssetDetail.vue";
import { Button } from "#/components/ui/button";
import { useCatalogue } from "#/composables/use-catalogue";

const { catalogue, error, loading, reload } = useCatalogue();
const assetId =
  typeof window === "undefined"
    ? ""
    : (window.location.pathname.split("/").at(-1) ?? "");
const selected = computed(() => {
  const direct = catalogue.value.assets.find((item) => item.id === assetId);
  if (direct !== undefined) return { asset: direct };
  const parent = catalogue.value.assets.find(
    (item) =>
      "component" in item &&
      item.component === "bangumi" &&
      item.episodes.some((episode) => episode.assetId === assetId),
  );
  return parent === undefined
    ? undefined
    : { asset: parent, selectedEpisodeId: assetId };
});
</script>

<template>
  <p v-if="loading" role="status" class="text-muted-foreground">
    正在读取内容…
  </p>
  <p v-else-if="error" role="alert" class="text-destructive">{{ error }}</p>
  <section v-else-if="selected">
    <AssetDetail
      :asset="selected.asset"
      :selected-episode-id="selected.selectedEpisodeId"
      @refreshed="reload"
    />
  </section>
  <section v-else class="grid gap-4">
    <h1 class="text-3xl font-bold">未找到内容</h1>
    <p class="text-muted-foreground">它可能尚未确认，或已不再可浏览。</p>
    <Button as="a" href="/" class="w-fit">返回全部内容</Button>
  </section>
</template>
