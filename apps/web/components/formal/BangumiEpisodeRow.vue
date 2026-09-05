<script setup lang="ts">
import type { BangumiEpisodeViewModel } from "@digital/web-delivery/client";

import AssetActions from "./AssetActions.vue";

defineProps<{
  readonly episode: BangumiEpisodeViewModel;
  readonly selected?: boolean;
  readonly showActions?: boolean;
}>();
</script>

<template>
  <article
    :id="`episode-${episode.assetId}`"
    class="grid gap-3 rounded-lg border p-3 sm:grid-cols-[5rem_1fr_auto] sm:items-start"
    :class="{ 'border-primary bg-accent/30': selected }"
    data-testid="bangumi-episode"
  >
    <div
      class="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted"
    >
      <img
        v-if="episode.artwork"
        :src="episode.artwork"
        :alt="`${episode.title}的图片`"
        class="h-full w-full object-cover"
      />
      <span v-else class="text-xs text-muted-foreground">暂无单集图片</span>
    </div>
    <div class="grid gap-1">
      <a
        :href="`/assets/${episode.assetId}`"
        class="font-medium underline-offset-4 hover:underline"
      >
        第 {{ episode.localPosition }} 集 · {{ episode.title }}
      </a>
      <p class="text-xs text-muted-foreground">
        连续第 {{ episode.continuousPosition }} 集
        <span v-if="episode.date"> · {{ episode.date }}</span>
      </p>
      <p
        v-if="episode.summary"
        class="line-clamp-2 text-sm text-muted-foreground"
      >
        {{ episode.summary }}
      </p>
    </div>
    <AssetActions
      v-if="showActions"
      :target="episode.actionTarget"
      class="sm:justify-self-end"
    />
  </article>
</template>
