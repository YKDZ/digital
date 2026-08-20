<script setup lang="ts">
import type { DlsiteCardRendererProjection } from "@digital/presentation/renderer-contracts";

import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

import AssetCover from "./AssetCover.vue";

defineProps<{ readonly asset: DlsiteCardRendererProjection }>();
</script>

<template>
  <a
    v-if="asset.dlsite"
    :href="`/assets/${asset.id}`"
    class="mb-4 block break-inside-avoid focus:outline-none"
  >
    <Card class="overflow-hidden transition-colors hover:bg-accent/30">
      <AssetCover
        :src="asset.dlsite.cover"
        :title="asset.dlsite.title"
        placement="card"
      />
      <CardHeader class="gap-2">
        <CardTitle class="line-clamp-2 text-base">{{
          asset.dlsite.title
        }}</CardTitle>
        <p v-if="asset.dlsite.circle" class="text-sm text-muted-foreground">
          {{ asset.dlsite.circle }}
        </p>
      </CardHeader>
      <CardContent class="grid gap-3">
        <div class="flex flex-wrap gap-2">
          <Badge v-if="asset.dlsite.releaseDate" variant="secondary">{{
            asset.dlsite.releaseDate
          }}</Badge>
          <Badge v-if="asset.dlsite.priceJpy" variant="outline"
            >{{ asset.dlsite.priceJpy }} JPY</Badge
          >
        </div>
        <p
          v-if="asset.dlsite.credits.length"
          class="line-clamp-1 text-sm text-muted-foreground"
        >
          {{ asset.dlsite.credits[0]?.heading }}：{{
            asset.dlsite.credits[0]?.names.join("、")
          }}
        </p>
      </CardContent>
    </Card>
  </a>
</template>
