<script setup lang="ts">
import type { BangumiEpisodeViewModel } from "@digital/web-delivery/client";

import BangumiEpisodeRow from "./BangumiEpisodeRow.vue";

defineProps<{
  readonly episodes: readonly BangumiEpisodeViewModel[];
  readonly selectedEpisodeId?: string;
  readonly showActions?: boolean;
}>();
</script>

<template>
  <div class="grid gap-3">
    <BangumiEpisodeRow
      v-for="episode in episodes"
      :key="episode.assetId"
      :episode="episode"
      :selected="episode.assetId === selectedEpisodeId"
      :show-actions="showActions"
    />
  </div>
</template>
