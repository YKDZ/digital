<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery/client";

import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

import AssetCover from "./AssetCover.vue";

defineProps<{ readonly asset: AssetViewModel }>();
</script>

<template>
  <a
    :href="`/assets/${asset.id}`"
    class="mb-4 block break-inside-avoid focus:outline-none"
  >
    <Card class="h-full overflow-hidden transition-colors hover:bg-accent/40">
      <AssetCover v-if="asset.cover" :src="asset.cover" :title="asset.title" />
      <CardHeader class="gap-2"
        ><CardTitle class="line-clamp-2">{{ asset.title }}</CardTitle>
        <p v-if="asset.releaseDate" class="text-sm text-muted-foreground">
          {{ asset.releaseDate }}
        </p></CardHeader
      >
      <CardContent v-if="asset.language">
        <span class="text-sm text-muted-foreground">{{ asset.language }}</span>
      </CardContent>
    </Card>
  </a>
</template>
