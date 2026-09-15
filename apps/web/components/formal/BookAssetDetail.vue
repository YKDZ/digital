<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery/client";
import { Download, ExternalLink, FileText, MoreHorizontal } from "@lucide/vue";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { Separator } from "#/components/ui/separator";

import AssetActions from "./AssetActions.vue";

const emit = defineEmits<{ refreshed: [] }>();
withDefaults(
  defineProps<{
    readonly asset: AssetViewModel;
    readonly showActions?: boolean;
  }>(),
  { showActions: true },
);

function fileSize(byteLength: number | undefined): string | undefined {
  if (byteLength === undefined) return undefined;
  if (byteLength < 1024 * 1024)
    return `${Math.max(1, Math.round(byteLength / 1024))} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <article v-if="asset.book" class="mx-auto max-w-6xl space-y-7 pb-24">
    <header
      class="relative min-h-[26rem] overflow-hidden rounded-2xl bg-zinc-900 text-white"
    >
      <img
        v-if="asset.book.cover"
        :src="asset.book.cover"
        alt=""
        class="absolute inset-0 size-full scale-110 object-cover opacity-30 blur-2xl"
      />
      <div
        class="absolute inset-0 bg-gradient-to-r from-black/90 via-black/70 to-black/20"
      />
      <div class="relative flex min-h-[26rem] items-end gap-7 p-6 sm:p-10">
        <div
          class="hidden aspect-[2/3] w-48 shrink-0 overflow-hidden rounded-lg bg-white/10 shadow-2xl sm:block"
        >
          <img
            v-if="asset.book.cover"
            :src="asset.book.cover"
            :alt="asset.book.title"
            class="size-full object-cover"
          />
          <div v-else class="grid size-full place-items-center">
            <FileText class="size-12 opacity-60" />
          </div>
        </div>
        <div class="max-w-2xl space-y-4">
          <div class="flex flex-wrap gap-2">
            <Badge class="border-white/20 bg-white/15 text-white">
              {{ asset.book.files[0]?.format ?? "出版物" }}
            </Badge>
            <Badge
              v-if="asset.book.publicationDate"
              class="border-white/20 bg-white/15 text-white"
            >
              {{ asset.book.publicationDate }}
            </Badge>
          </div>
          <h1
            class="text-3xl leading-tight font-semibold tracking-tight sm:text-5xl"
          >
            {{ asset.book.title }}
          </h1>
          <p
            v-if="asset.book.contributors.length"
            class="text-lg text-white/75"
          >
            {{ asset.book.contributors.join("、") }}
          </p>
          <div class="flex flex-wrap gap-2 pt-2">
            <Button
              v-if="asset.book.files[0]?.downloadUrl"
              as-child
              size="lg"
              variant="secondary"
            >
              <a :href="asset.book.files[0].downloadUrl">
                <Download class="size-4" />下载原文件
              </a>
            </Button>
            <Popover v-if="showActions">
              <PopoverTrigger as-child>
                <Button
                  variant="outline"
                  size="icon-lg"
                  class="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                  aria-label="更多操作"
                >
                  <MoreHorizontal class="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-auto">
                <AssetActions
                  :target="asset.refreshTarget"
                  @done="emit('refreshed')"
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
    </header>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section class="space-y-4">
        <h2 class="text-xl font-semibold">简介</h2>
        <p
          v-if="asset.introduction"
          class="whitespace-pre-line leading-7 text-foreground/85"
        >
          {{ asset.introduction }}
        </p>
        <p v-else class="text-muted-foreground">暂无简介</p>
      </section>
      <aside class="space-y-5">
        <Card class="shadow-none">
          <CardHeader>
            <CardTitle class="text-base">出版信息</CardTitle>
          </CardHeader>
          <CardContent>
            <dl class="space-y-4 text-sm">
              <div v-if="asset.book.publisher">
                <dt class="text-muted-foreground">出版社</dt>
                <dd class="mt-1">{{ asset.book.publisher }}</dd>
              </div>
              <div v-if="asset.book.publicationDate">
                <dt class="text-muted-foreground">出版日期</dt>
                <dd class="mt-1">{{ asset.book.publicationDate }}</dd>
              </div>
              <div v-if="asset.book.isbn13">
                <dt class="text-muted-foreground">ISBN</dt>
                <dd class="mt-1 break-all">{{ asset.book.isbn13 }}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Card v-if="asset.book.files.length" class="shadow-none">
          <CardHeader>
            <CardTitle class="text-base">文件</CardTitle>
          </CardHeader>
          <CardContent class="space-y-3">
            <div
              v-for="file in asset.book.files"
              :key="file.name"
              class="space-y-2"
            >
              <p class="break-words text-sm font-medium">{{ file.name }}</p>
              <div
                class="flex items-center justify-between gap-3 text-xs text-muted-foreground"
              >
                <span>
                  {{
                    [file.format, fileSize(file.byteLength)]
                      .filter(Boolean)
                      .join(" · ")
                  }}
                </span>
                <Button
                  v-if="file.downloadUrl"
                  as-child
                  size="icon"
                  variant="ghost"
                  aria-label="下载"
                >
                  <a :href="file.downloadUrl"><Download class="size-4" /></a>
                </Button>
              </div>
              <Separator />
            </div>
          </CardContent>
        </Card>
        <a
          v-if="asset.officialPage"
          :href="asset.officialPage"
          target="_blank"
          rel="noreferrer"
          class="inline-flex items-center gap-1 px-1 text-sm text-muted-foreground hover:text-foreground"
        >
          {{ asset.sourceLabel ?? "来源页面" }}
          <ExternalLink class="size-3.5" />
        </a>
      </aside>
    </div>
  </article>
</template>
