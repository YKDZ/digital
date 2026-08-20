<script setup lang="ts">
import { ExternalLink, FileArchive, Heart, MessageCircle } from "@lucide/vue";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Separator } from "#/components/ui/separator";
import type { AssetViewModel } from "#/lib/catalogue";

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
  <article v-if="asset.fanbox" class="mx-auto grid max-w-4xl gap-6">
    <AssetCover
      :src="asset.fanbox.cover"
      :title="asset.fanbox.title"
      placement="detail"
    />
    <section class="grid gap-5 rounded-xl border bg-card p-6 shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-sm text-muted-foreground">
          {{ asset.fanbox.publicationDateTime ?? "发布时间未知" }}
        </p>
        <Badge variant="secondary">{{
          asset.fanbox.entitlement === "restricted"
            ? "未开放"
            : asset.fanbox.entitlement === "available"
              ? "可查看"
              : "状态未确认"
        }}</Badge>
      </div>
      <div class="grid gap-2">
        <h1 class="text-3xl font-bold tracking-tight">
          {{ asset.fanbox.title }}
        </h1>
        <p v-if="asset.fanbox.creator" class="text-muted-foreground">
          {{ asset.fanbox.creator }}
        </p>
      </div>
      <p
        v-if="asset.fanbox.body"
        class="leading-7 whitespace-pre-wrap text-card-foreground"
      >
        {{ asset.fanbox.body }}
      </p>
      <p v-else class="text-sm text-muted-foreground">
        当前采集结果没有完整正文。
      </p>
      <div
        v-if="asset.fanbox.commentCount || asset.fanbox.likeCount"
        class="flex items-center justify-end gap-5 text-sm text-muted-foreground"
      >
        <span
          v-if="asset.fanbox.commentCount"
          class="inline-flex items-center gap-1"
          ><MessageCircle class="size-4" />{{ asset.fanbox.commentCount }}</span
        >
        <span
          v-if="asset.fanbox.likeCount"
          class="inline-flex items-center gap-1"
          ><Heart class="size-4" />{{ asset.fanbox.likeCount }}</span
        >
      </div>
      <Separator />
      <div v-if="asset.fanbox.attachments.length" class="grid gap-3">
        <h2 class="text-base font-semibold">附件</h2>
        <ul class="grid gap-2">
          <li
            v-for="(attachment, index) in asset.fanbox.attachments"
            :key="`${attachment.name ?? '附件'}-${index}`"
            class="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2"
          >
            <span class="inline-flex min-w-0 items-center gap-2"
              ><FileArchive class="size-4 shrink-0 text-muted-foreground" />
              <span class="truncate">{{
                attachment.name ?? "未命名附件"
              }}</span>
            </span>
            <span
              v-if="attachment.byteLength"
              class="shrink-0 text-sm text-muted-foreground"
              >{{ attachment.byteLength }} bytes</span
            >
          </li>
        </ul>
      </div>
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
    </section>
  </article>
</template>
