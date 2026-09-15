<script setup lang="ts">
import type { BangumiSeriesViewModel } from "@digital/web-delivery/client";
import { Film, Play, Rows3 } from "@lucide/vue";
import { navigate } from "vike/client/router";
import { computed } from "vue";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs";

const props = defineProps<{
  readonly asset: BangumiSeriesViewModel;
  readonly selectedEpisodeId?: string;
  readonly selectedWorkId?: string;
  readonly showActions?: boolean;
}>();

const selectedWorkId = computed(() => {
  if (props.asset.works.some((work) => work.id === props.selectedWorkId))
    return props.selectedWorkId;
  return (
    props.asset.works.find((work) =>
      work.episodes.some(
        (episode) => episode.assetId === props.selectedEpisodeId,
      ),
    )?.id ??
    props.asset.works[0]?.id ??
    ""
  );
});
const activeWork = computed(
  () =>
    props.asset.works.find((work) => work.id === selectedWorkId.value) ??
    props.asset.works[0],
);
const nextEpisode = computed(() =>
  activeWork.value?.episodes.find((episode) => episode.available),
);

function episodeHref(id: string) {
  return `/assets/${encodeURIComponent(id)}`;
}

function workHref(id: string) {
  return `/series/${encodeURIComponent(props.asset.id)}?season=${encodeURIComponent(id)}`;
}

function selectWork(id: string | number) {
  void navigate(workHref(String(id)), { keepScrollPosition: true });
}

function scrollToEpisodes() {
  document
    .querySelector("#bangumi-episodes")
    ?.scrollIntoView({ behavior: "smooth" });
}
</script>

<template>
  <article v-if="activeWork" class="grid gap-8" data-testid="bangumi-detail">
    <header
      class="grid items-start gap-7 lg:grid-cols-[minmax(14rem,20rem)_1fr]"
    >
      <div
        class="mx-auto w-full max-w-80 overflow-hidden rounded-xl bg-muted shadow-sm"
      >
        <img
          v-if="activeWork.cover"
          :src="activeWork.cover"
          :alt="`${activeWork.title}的封面`"
          class="block h-auto w-full"
        />
        <div
          v-else
          class="flex aspect-[2/3] items-center justify-center text-sm text-muted-foreground"
        >
          暂无封面
        </div>
      </div>

      <div class="grid content-start gap-5 pt-1">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">番剧</Badge>
          <span v-if="activeWork.date" class="text-sm text-muted-foreground">
            {{ activeWork.date }}
          </span>
        </div>
        <h1 class="text-4xl font-bold tracking-tight">
          {{ activeWork.title }}
        </h1>
        <p class="max-w-3xl leading-7 text-muted-foreground">
          {{ activeWork.summary || "暂无简介。" }}
        </p>
        <div class="flex flex-wrap gap-3">
          <Button
            v-if="nextEpisode"
            as="a"
            :href="episodeHref(nextEpisode.assetId)"
          >
            <Play />播放第 {{ nextEpisode.localPosition }} 集
          </Button>
          <Button variant="outline" @click="scrollToEpisodes">
            <Rows3 />查看分集
          </Button>
        </div>
      </div>
    </header>

    <section v-if="asset.works.length > 1" class="grid gap-3">
      <h2 class="text-lg font-semibold">季度</h2>
      <Tabs :model-value="selectedWorkId" @update:model-value="selectWork">
        <TabsList class="h-auto max-w-full justify-start overflow-x-auto">
          <TabsTrigger
            v-for="work in asset.works"
            :key="work.id"
            :value="work.id"
            class="whitespace-nowrap"
          >
            {{ work.title }}
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </section>

    <section id="bangumi-episodes" class="grid gap-4">
      <div>
        <h2 class="text-2xl font-semibold">分集</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ activeWork.episodes.length }} 集
        </p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <a
          v-for="episode in activeWork.episodes"
          :key="episode.assetId"
          :href="episodeHref(episode.assetId)"
          class="group flex min-w-0 items-center gap-3 rounded-xl border p-3 transition-colors hover:bg-accent/60"
          data-testid="bangumi-episode-card"
        >
          <div
            class="flex aspect-video w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted sm:w-36"
          >
            <img
              v-if="episode.artwork"
              :src="episode.artwork"
              :alt="`${episode.title}的图片`"
              class="h-full w-full object-cover"
            />
            <Film v-else class="size-7 text-muted-foreground/60" />
          </div>
          <div class="min-w-0 flex-1 py-0.5">
            <p class="text-xs text-muted-foreground">
              第 {{ episode.localPosition }} 集
            </p>
            <h3 class="mt-1 truncate font-medium">{{ episode.title }}</h3>
            <p
              v-if="episode.summary"
              class="mt-1 line-clamp-2 text-xs text-muted-foreground"
            >
              {{ episode.summary }}
            </p>
          </div>
        </a>
      </div>
    </section>
  </article>
</template>
