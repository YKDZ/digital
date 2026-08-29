<script setup lang="ts">
import type { BangumiSeriesViewModel } from "@digital/web-delivery";
import { computed, ref } from "vue";

import { Tabs, TabsContent } from "#/components/ui/tabs";

import AssetCover from "./AssetCover.vue";
import BangumiEpisodeList from "./BangumiEpisodeList.vue";
import BangumiWorkNav from "./BangumiWorkNav.vue";

const props = withDefaults(
  defineProps<{
    readonly asset: BangumiSeriesViewModel;
    readonly selectedEpisodeId?: string;
    readonly showActions?: boolean;
  }>(),
  { showActions: true },
);
const selectedWorkFromEpisode = computed(() =>
  props.asset.works.find((work) =>
    work.episodes.some(
      (episode) => episode.assetId === props.selectedEpisodeId,
    ),
  ),
);
const activeWork = ref(
  selectedWorkFromEpisode.value?.id ?? props.asset.works[0]?.id ?? "",
);
</script>

<template>
  <article class="grid gap-8" data-testid="bangumi-detail">
    <header class="grid gap-6 lg:grid-cols-[minmax(15rem,22rem)_1fr]">
      <AssetCover
        :src="asset.works.find((work) => work.id === activeWork)?.cover"
        :title="
          asset.works.find((work) => work.id === activeWork)?.title ??
          asset.title
        "
        placement="detail"
      />
      <div class="grid content-start gap-4">
        <p class="text-sm text-muted-foreground">番剧</p>
        <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">
          {{
            asset.works.find((work) => work.id === activeWork)?.title ??
            asset.title
          }}
        </h1>
        <p
          v-if="asset.works.find((work) => work.id === activeWork)?.date"
          class="text-muted-foreground"
        >
          {{ asset.works.find((work) => work.id === activeWork)?.date }}
        </p>
        <p class="max-w-3xl leading-7 text-muted-foreground">
          {{
            asset.works.find((work) => work.id === activeWork)?.summary ??
            "暂无简介。"
          }}
        </p>
      </div>
    </header>

    <Tabs v-model="activeWork" class="grid gap-5">
      <BangumiWorkNav :works="asset.works" />
      <TabsContent
        v-for="work in asset.works"
        :key="work.id"
        :value="work.id"
        class="grid gap-5"
      >
        <BangumiEpisodeList
          :episodes="work.episodes"
          :selected-episode-id="selectedEpisodeId"
          :show-actions="showActions"
        />
        <p class="text-xs text-muted-foreground">
          元数据来源：
          <a
            v-if="work.officialPage"
            :href="work.officialPage"
            rel="noreferrer"
            class="underline underline-offset-4"
            >Bangumi</a
          >
          <span v-else>Bangumi</span>
        </p>
      </TabsContent>
    </Tabs>
  </article>
</template>
