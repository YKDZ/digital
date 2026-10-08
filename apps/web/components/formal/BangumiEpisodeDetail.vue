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
const props = withDefaults(
  defineProps<{
    readonly series: BangumiSeriesViewModel;
    readonly work: BangumiWorkViewModel;
    readonly episode: BangumiEpisodeViewModel;
    readonly showActions?: boolean;
  }>(),
  { showActions: true },
);

const returnHref = `/series/${encodeURIComponent(props.series.id)}?season=${encodeURIComponent(props.work.id)}`;
</script>

<template>
  <article class="grid gap-8" data-testid="bangumi-episode-detail">
    <Button as="a" :href="returnHref" variant="ghost" class="w-fit">
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

        <section
          v-if="episode.materials.length"
          class="grid gap-2"
          aria-label="本集材料"
        >
          <h2 class="text-sm font-medium text-muted-foreground">本集材料</h2>
          <ul class="grid gap-1">
            <li
              v-for="material in episode.materials"
              :key="`${material.name}-${material.revisionId ?? ''}`"
              class="flex items-center gap-2 text-sm"
            >
              <span class="min-w-0 truncate">{{ material.name }}</span>
              <Badge variant="outline">{{ material.format }}</Badge>
            </li>
          </ul>
        </section>

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
