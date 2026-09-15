<script setup lang="ts">
import { usePageContext } from "vike-vue/usePageContext";
import { computed } from "vue";

import AssetDetail from "#/components/formal/AssetDetail.vue";
import { Button } from "#/components/ui/button";
import { useCatalogueSubject } from "#/composables/use-catalogue-subject";

const pageContext = usePageContext();
const selectedWorkId = computed(() => pageContext.urlParsed.search.season);
const { selected, error, loading, reload } = useCatalogueSubject(
  () => pageContext.routeParams.id ?? "",
);
</script>

<template>
  <p v-if="loading" role="status" class="text-muted-foreground">
    正在读取内容…
  </p>
  <p v-else-if="error" role="alert" class="text-destructive">
    {{ error }} <Button variant="link" @click="reload">重试</Button>
  </p>
  <section v-else-if="selected">
    <AssetDetail :asset="selected.asset" :selected-work-id="selectedWorkId" />
  </section>
  <section v-else class="grid gap-4">
    <h1 class="text-3xl font-bold">未找到作品系列</h1>
    <p class="text-muted-foreground">它可能尚未确认，或已不再可浏览。</p>
    <Button as="a" href="/" class="w-fit">返回全部内容</Button>
  </section>
</template>
