<script setup lang="ts">
import AssetCard from "#/components/formal/AssetCard.vue";
import { Button } from "#/components/ui/button";
import { useCatalogue } from "#/composables/use-catalogue";

const {
  catalogue,
  error,
  loading,
  reload,
  loadMoreCatalogue,
  cataloguePageLoading,
} = useCatalogue();
</script>

<template>
  <section class="grid gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">全部内容</h1>
        <p class="mt-2 text-muted-foreground">
          浏览已经确认并保留在本地的内容。
        </p>
      </div>
      <Button as="a" href="/intake">添加内容</Button>
    </header>
    <p v-if="loading" class="text-muted-foreground" role="status">
      正在读取内容…
    </p>
    <div
      v-else-if="error"
      role="alert"
      class="rounded-lg border border-destructive/40 p-4 text-destructive"
    >
      {{ error }} <Button variant="link" @click="reload">重试</Button>
    </div>
    <div
      v-else-if="!catalogue.configured"
      class="rounded-lg border bg-background p-6 text-muted-foreground"
    >
      还没有连接内容目录。配置完成后，这里会显示已经确认的内容。
    </div>
    <div
      v-else-if="catalogue.assets.length === 0"
      class="rounded-lg border bg-background p-6 text-muted-foreground"
    >
      暂时没有可浏览的内容。你可以先从已登记的文件位置添加内容。
    </div>
    <div v-else class="columns-1 gap-4 sm:columns-2 xl:columns-3">
      <AssetCard
        v-for="asset in catalogue.assets"
        :key="asset.id"
        :asset="asset"
      />
    </div>
    <Button
      v-if="catalogue.pagination.currentCatalogue.nextCursor"
      variant="outline"
      :disabled="cataloguePageLoading"
      class="mx-auto"
      @click="loadMoreCatalogue"
      >{{ cataloguePageLoading ? "正在加载…" : "加载更多" }}</Button
    >
  </section>
</template>
