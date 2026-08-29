<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery";

import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

import AssetCover from "./AssetCover.vue";

defineProps<{ readonly asset: AssetViewModel }>();
</script>

<template>
  <a
    v-if="asset.book"
    :href="`/assets/${asset.id}`"
    class="mb-4 block break-inside-avoid focus:outline-none"
  >
    <Card class="overflow-hidden transition-colors hover:bg-accent/30">
      <AssetCover
        :src="asset.book.cover"
        :title="asset.book.title"
        placement="card"
      />
      <CardHeader class="gap-2">
        <CardTitle class="line-clamp-2 text-base">{{
          asset.book.title
        }}</CardTitle>
        <p
          v-if="asset.book.contributors.length"
          class="line-clamp-1 text-sm text-muted-foreground"
        >
          {{ asset.book.contributors.join("、") }}
        </p>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <Badge v-if="asset.book.format" variant="secondary">{{
          asset.book.format
        }}</Badge>
        <Badge v-if="asset.book.publicationDate" variant="outline">{{
          asset.book.publicationDate
        }}</Badge>
      </CardContent>
    </Card>
  </a>
</template>
