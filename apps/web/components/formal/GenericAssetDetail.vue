<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery";
import { ExternalLink } from "@lucide/vue";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

import AssetActions from "./AssetActions.vue";
import AssetCover from "./AssetCover.vue";

const emit = defineEmits<{ refreshed: [] }>();
withDefaults(
  defineProps<{
    readonly asset: AssetViewModel;
    readonly showActions?: boolean;
  }>(),
  { showActions: true },
);
</script>

<template>
  <article
    class="grid gap-6 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.6fr)]"
  >
    <AssetCover :src="asset.cover" :title="asset.title" placement="detail" />
    <div class="grid content-start gap-6">
      <header class="grid gap-3">
        <h1 class="text-3xl font-bold tracking-tight">{{ asset.title }}</h1>
        <div class="flex flex-wrap gap-2">
          <Badge v-if="asset.releaseDate" variant="secondary">{{
            asset.releaseDate
          }}</Badge
          ><Badge v-if="asset.publicationDateTime" variant="secondary">{{
            asset.publicationDateTime
          }}</Badge
          ><Badge v-if="asset.language" variant="outline">{{
            asset.language
          }}</Badge
          ><Badge
            v-for="classification in asset.classifications"
            :key="classification"
            variant="outline"
            >{{ classification }}</Badge
          >
        </div>
      </header>
      <Card v-if="asset.introduction"
        ><CardHeader><CardTitle>简介</CardTitle></CardHeader
        ><CardContent class="leading-7 whitespace-pre-wrap">{{
          asset.introduction
        }}</CardContent></Card
      >
      <Card v-if="asset.summary"
        ><CardHeader><CardTitle>摘要</CardTitle></CardHeader
        ><CardContent class="leading-7 whitespace-pre-wrap">{{
          asset.summary
        }}</CardContent></Card
      >
      <Card v-if="asset.body"
        ><CardHeader><CardTitle>正文</CardTitle></CardHeader
        ><CardContent class="leading-7 whitespace-pre-wrap">{{
          asset.body
        }}</CardContent></Card
      >
      <Card v-if="asset.relationships.length"
        ><CardHeader><CardTitle>参与者与相关内容</CardTitle></CardHeader
        ><CardContent
          ><ul class="grid gap-2">
            <li
              v-for="item in asset.relationships"
              :key="`${item.heading}-${item.label}`"
            >
              <span>{{ item.label }}</span
              ><span class="ml-2 text-sm text-muted-foreground">{{
                item.heading
              }}</span>
            </li>
          </ul></CardContent
        ></Card
      >
      <p
        v-if="
          !asset.introduction &&
          !asset.summary &&
          !asset.body &&
          !asset.relationships.length
        "
        class="text-muted-foreground"
      >
        这项内容的可用资料还不完整。
      </p>
      <AssetActions
        v-if="showActions"
        :target="asset.refreshTarget"
        @done="emit('refreshed')"
      />
      <Button
        v-if="asset.officialPage"
        as="a"
        :href="asset.officialPage"
        target="_blank"
        rel="noreferrer"
        variant="ghost"
        class="w-fit text-muted-foreground"
        ><ExternalLink />查看官方页面</Button
      >
    </div>
  </article>
</template>
