<script setup lang="ts">
import type { AssetViewModel } from "@digital/presentation";
import { ExternalLink } from "@lucide/vue";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

import AssetCover from "./AssetCover.vue";

defineProps<{ readonly asset: AssetViewModel }>();
</script>

<template>
  <article
    v-if="asset.dlsite"
    class="grid gap-6 lg:grid-cols-[minmax(14rem,24rem)_minmax(0,1fr)]"
  >
    <div class="grid content-start gap-4">
      <AssetCover
        :src="asset.dlsite.cover"
        :title="asset.dlsite.title"
        placement="detail"
      />
      <Button
        v-if="asset.officialPage"
        as="a"
        :href="asset.officialPage"
        target="_blank"
        rel="noreferrer"
        variant="outline"
        ><ExternalLink />官方页面</Button
      >
    </div>
    <div class="grid content-start gap-6">
      <header class="grid gap-4">
        <div class="flex flex-wrap gap-2">
          <Badge v-if="asset.dlsite.releaseDate" variant="secondary">{{
            asset.dlsite.releaseDate
          }}</Badge>
          <Badge v-if="asset.dlsite.priceJpy" variant="outline"
            >{{ asset.dlsite.priceJpy }} JPY</Badge
          >
          <Badge
            v-for="classification in asset.dlsite.classifications"
            :key="classification"
            variant="outline"
            >{{ classification }}</Badge
          >
        </div>
        <div class="grid gap-2">
          <h1 class="text-3xl font-bold tracking-tight">
            {{ asset.dlsite.title }}
          </h1>
          <p v-if="asset.dlsite.circle" class="text-muted-foreground">
            {{ asset.dlsite.circle }}
          </p>
        </div>
      </header>
      <Card v-if="asset.dlsite.introduction"
        ><CardHeader><CardTitle>简介</CardTitle></CardHeader
        ><CardContent class="leading-7 whitespace-pre-wrap">{{
          asset.dlsite.introduction
        }}</CardContent></Card
      >
      <Card v-if="asset.dlsite.credits.length || asset.dlsite.languages.length">
        <CardHeader><CardTitle>制作</CardTitle></CardHeader>
        <CardContent class="grid gap-4">
          <div
            v-if="asset.dlsite.languages.length"
            class="flex flex-wrap gap-2"
          >
            <Badge
              v-for="language in asset.dlsite.languages"
              :key="language"
              variant="secondary"
              >{{ language }}</Badge
            >
          </div>
          <dl class="grid gap-3">
            <div
              v-for="group in asset.dlsite.credits"
              :key="group.heading"
              class="grid gap-1 sm:grid-cols-[5rem_1fr]"
            >
              <dt class="text-sm text-muted-foreground">{{ group.heading }}</dt>
              <dd>{{ group.names.join("、") }}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card v-if="asset.dlsite.series"
        ><CardHeader><CardTitle>系列</CardTitle></CardHeader
        ><CardContent>
          {{ asset.dlsite.series.name
          }}<span
            v-if="asset.dlsite.series.position"
            class="ml-2 text-sm text-muted-foreground"
            >{{ asset.dlsite.series.position }}</span
          >
        </CardContent></Card
      >
      <slot name="actions" />
    </div>
  </article>
</template>
