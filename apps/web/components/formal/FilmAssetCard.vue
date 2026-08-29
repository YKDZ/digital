<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery";
import { Film } from "@lucide/vue";

import { Badge } from "#/components/ui/badge";
import { Card, CardContent } from "#/components/ui/card";

defineProps<{ readonly asset: AssetViewModel }>();
</script>

<template>
  <a
    v-if="asset.film"
    :href="`/assets/${asset.id}`"
    class="mb-4 block break-inside-avoid focus:outline-none"
    data-testid="film-card"
  >
    <Card
      class="group overflow-hidden py-0 transition-colors hover:bg-accent/30"
    >
      <div class="relative aspect-2/3 overflow-hidden bg-muted">
        <img
          v-if="asset.film.cover"
          :src="asset.film.cover"
          :alt="`${asset.film.title}的海报`"
          class="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
        />
        <div
          v-else
          class="flex size-full flex-col items-center justify-center gap-2 bg-linear-to-br from-muted to-muted-foreground/20 text-muted-foreground"
        >
          <Film class="size-10" />
          <span class="text-sm">暂无海报</span>
        </div>
        <div
          class="absolute inset-x-0 bottom-0 h-1/3 bg-linear-to-t from-black/75 to-transparent"
        />
        <Badge
          v-if="asset.film.ratings[0]"
          class="absolute right-3 bottom-3 border-0 bg-black/65 text-white"
        >
          {{ asset.film.ratings[0].label }}
          {{ asset.film.ratings[0].value }}
        </Badge>
      </div>
      <CardContent class="grid gap-1 p-4">
        <h2 class="line-clamp-2 font-semibold">{{ asset.film.title }}</h2>
        <p class="text-sm text-muted-foreground">
          {{ asset.film.year ?? "上映年份未知" }}
          <template v-if="asset.film.runtimeMinutes">
            · {{ asset.film.runtimeMinutes }} 分钟
          </template>
        </p>
      </CardContent>
    </Card>
  </a>
</template>
