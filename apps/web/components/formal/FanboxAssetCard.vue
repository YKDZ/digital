<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery";
import { MessageCircle, Heart } from "@lucide/vue";

import { Badge } from "#/components/ui/badge";
import { Card, CardContent } from "#/components/ui/card";

import AssetCover from "./AssetCover.vue";

defineProps<{ readonly asset: AssetViewModel }>();
</script>

<template>
  <a
    v-if="asset.fanbox"
    :href="`/assets/${asset.id}`"
    class="mb-4 block break-inside-avoid focus:outline-none"
  >
    <Card class="overflow-hidden bg-white transition-colors hover:bg-accent/30">
      <AssetCover
        :src="asset.fanbox.cover"
        :title="asset.fanbox.title"
        placement="card"
      />
      <CardContent class="grid gap-4 p-5">
        <div class="flex items-center justify-between gap-3 text-sm">
          <span class="text-muted-foreground">{{
            asset.fanbox.publicationDateTime ?? "发布时间未知"
          }}</span>
          <Badge variant="secondary">{{
            asset.fanbox.entitlement === "restricted"
              ? "未开放"
              : asset.fanbox.entitlement === "available"
                ? "可查看"
                : "状态未确认"
          }}</Badge>
        </div>
        <div class="grid gap-2">
          <h2 class="line-clamp-2 text-xl font-bold tracking-tight">
            {{ asset.fanbox.title }}
          </h2>
          <p v-if="asset.fanbox.creator" class="text-sm text-muted-foreground">
            {{ asset.fanbox.creator }}
          </p>
        </div>
        <div
          v-if="asset.fanbox.commentCount || asset.fanbox.likeCount"
          class="flex items-center justify-end gap-5 text-sm text-muted-foreground"
        >
          <span
            v-if="asset.fanbox.commentCount"
            class="inline-flex items-center gap-1"
            ><MessageCircle class="size-4" />{{
              asset.fanbox.commentCount
            }}</span
          >
          <span
            v-if="asset.fanbox.likeCount"
            class="inline-flex items-center gap-1"
            ><Heart class="size-4" />{{ asset.fanbox.likeCount }}</span
          >
        </div>
      </CardContent>
    </Card>
  </a>
</template>
