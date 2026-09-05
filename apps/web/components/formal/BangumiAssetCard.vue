<script setup lang="ts">
import type { BangumiSeriesViewModel } from "@digital/web-delivery/client";

import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

import AssetCover from "./AssetCover.vue";

defineProps<{ readonly asset: BangumiSeriesViewModel }>();
</script>

<template>
  <a
    :href="`/series/${encodeURIComponent(asset.id)}`"
    class="mb-4 block break-inside-avoid focus:outline-none"
    data-testid="bangumi-card"
  >
    <Card class="overflow-hidden transition-colors hover:bg-accent/30">
      <AssetCover :src="asset.cover" :title="asset.title" placement="card" />
      <CardHeader class="gap-2">
        <CardTitle class="line-clamp-2 text-base">{{ asset.title }}</CardTitle>
        <p v-if="asset.date" class="text-sm text-muted-foreground">
          {{ asset.date }}
        </p>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <Badge variant="secondary">{{ asset.works.length }} 部作品</Badge>
        <Badge variant="outline">{{ asset.episodes.length }} 集本地内容</Badge>
      </CardContent>
    </Card>
  </a>
</template>
