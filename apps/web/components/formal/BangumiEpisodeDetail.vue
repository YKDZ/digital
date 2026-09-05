<script setup lang="ts">
import type {
  BangumiEpisodeViewModel,
  BangumiSeriesViewModel,
  BangumiWorkViewModel,
} from "@digital/web-delivery/client";
import { ArrowLeft } from "@lucide/vue";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";

import AssetActions from "./AssetActions.vue";

const emit = defineEmits<{ refreshed: [] }>();
withDefaults(
  defineProps<{
    readonly series: BangumiSeriesViewModel;
    readonly work: BangumiWorkViewModel;
    readonly episode: BangumiEpisodeViewModel;
    readonly showActions?: boolean;
  }>(),
  { showActions: true },
);
</script>

<template>
  <article class="grid gap-8" data-testid="bangumi-episode-detail">
    <Button
      as="a"
      :href="`/series/${encodeURIComponent(series.id)}`"
      variant="ghost"
      class="w-fit"
    >
      <ArrowLeft />
      返回{{ work.title }}
    </Button>

    <div class="grid gap-6 lg:grid-cols-[minmax(16rem,28rem)_minmax(0,1fr)]">
      <div
        class="flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-muted"
      >
        <img
          v-if="episode.artwork"
          :src="episode.artwork"
          :alt="`${episode.title}的图片`"
          class="h-full w-full object-cover"
        />
        <span v-else class="text-sm text-muted-foreground">暂无单集图片</span>
      </div>

      <div class="grid min-w-0 content-start gap-5">
        <header class="grid gap-3">
          <p class="text-sm text-muted-foreground">
            {{ work.title }} · 第 {{ episode.localPosition }} 集
          </p>
          <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">
            {{ episode.title }}
          </h1>
          <div class="flex flex-wrap gap-2">
            <Badge v-if="episode.date" variant="secondary">
              {{ episode.date }}
            </Badge>
            <Badge
              v-if="episode.continuousPosition !== episode.localPosition"
              variant="outline"
            >
              连续第 {{ episode.continuousPosition }} 集
            </Badge>
          </div>
        </header>

        <p
          v-if="episode.summary"
          class="max-w-3xl leading-7 whitespace-pre-wrap text-muted-foreground"
        >
          {{ episode.summary }}
        </p>
        <p v-else class="text-muted-foreground">暂无简介。</p>

        <AssetActions
          v-if="showActions"
          :target="episode.actionTarget"
          @done="emit('refreshed')"
        />

        <footer class="text-xs text-muted-foreground">
          元数据来源：<a
            :href="episode.officialPage"
            target="_blank"
            rel="noreferrer"
            class="underline underline-offset-2 hover:text-foreground"
            >Bangumi</a
          >
        </footer>
      </div>
    </div>
  </article>
</template>
