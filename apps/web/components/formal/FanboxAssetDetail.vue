<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery/client";
import {
  ExternalLink,
  FileArchive,
  Heart,
  ImageOff,
  MessageCircle,
  Paperclip,
} from "@lucide/vue";
import { computed } from "vue";

import { Avatar, AvatarFallback } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { ScrollArea } from "#/components/ui/scroll-area";
import { Separator } from "#/components/ui/separator";

import AssetActions from "./AssetActions.vue";
import AssetFileTree from "./AssetFileTree.vue";

const emit = defineEmits<{ refreshed: [] }>();
const props = withDefaults(
  defineProps<{
    readonly asset: AssetViewModel;
    readonly showActions?: boolean;
  }>(),
  { showActions: true },
);
const post = computed(() => props.asset.fanbox!);
const paragraphs = computed(
  () => post.value.body?.split(/\n{2,}/u).filter(Boolean) ?? [],
);

function date(value: string | undefined) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(new Date(value))
    : undefined;
}
function size(value: string | undefined) {
  if (value === undefined) return;
  const bytes = Number(value);
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
function extension(name: string | undefined) {
  return name?.match(/\.([^.]+)$/u)?.[1]?.toUpperCase();
}
</script>

<template>
  <article
    v-if="asset.fanbox"
    class="mx-auto grid max-w-6xl items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]"
  >
    <main class="min-w-0 max-w-3xl">
      <header class="mb-6 flex items-center gap-3">
        <Avatar class="size-11">
          <AvatarFallback>{{
            post.creator?.slice(0, 1) ?? "F"
          }}</AvatarFallback>
        </Avatar>
        <div class="min-w-0">
          <p v-if="post.creator" class="truncate font-medium">
            {{ post.creator }}
          </p>
          <p class="text-sm text-muted-foreground">
            {{ date(post.publicationDateTime) }}
          </p>
        </div>
        <Button
          v-if="asset.officialPage"
          as="a"
          :href="asset.officialPage"
          target="_blank"
          rel="noreferrer"
          variant="ghost"
          size="icon"
          class="ml-auto"
          aria-label="打开原帖"
          ><ExternalLink
        /></Button>
      </header>

      <div class="mb-7 overflow-hidden rounded-2xl bg-muted">
        <img
          v-if="post.cover"
          :src="post.cover"
          :alt="post.title"
          class="max-h-[32rem] w-full object-contain"
        />
        <div
          v-else
          class="grid aspect-[16/7] place-items-center text-muted-foreground"
        >
          <ImageOff class="size-9" />
        </div>
      </div>

      <h1 class="text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
        {{ post.title }}
      </h1>
      <div
        v-if="paragraphs.length"
        class="mt-7 space-y-5 text-[1.05rem] leading-8"
      >
        <p
          v-for="(paragraph, index) in paragraphs"
          :key="index"
          class="whitespace-pre-line"
        >
          {{ paragraph }}
        </p>
      </div>

      <template v-if="post.attachments.length">
        <Separator class="my-8" />
        <section class="space-y-3">
          <h2 class="flex items-center gap-2 text-lg font-semibold">
            <Paperclip class="size-4" />随帖附件
          </h2>
          <div class="grid gap-2 sm:grid-cols-2">
            <Card
              v-for="(item, index) in post.attachments"
              :key="index"
              class="shadow-none"
            >
              <CardContent class="flex items-center gap-3 p-3">
                <FileArchive class="size-5 shrink-0 text-muted-foreground" />
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">
                    {{ item.name ?? "未命名附件" }}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    {{
                      [extension(item.name), size(item.byteLength)]
                        .filter(Boolean)
                        .join(" · ")
                    }}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </template>

      <div class="mt-7 flex justify-end gap-5 text-sm text-muted-foreground">
        <span v-if="post.likeCount" class="flex items-center gap-1.5"
          ><Heart class="size-4" />{{ post.likeCount }}</span
        >
        <span v-if="post.commentCount" class="flex items-center gap-1.5"
          ><MessageCircle class="size-4" />{{ post.commentCount }}</span
        >
      </div>
      <AssetActions
        v-if="showActions"
        class="mt-7"
        :target="asset.refreshTarget"
        @done="emit('refreshed')"
      />
    </main>

    <aside v-if="asset.fileTree?.length" class="lg:sticky lg:top-6">
      <Card class="shadow-none">
        <CardHeader class="pb-3"
          ><CardTitle class="text-base">本地内容</CardTitle></CardHeader
        >
        <CardContent class="px-2 pb-2">
          <ScrollArea class="max-h-[calc(100vh-8rem)] pr-2">
            <AssetFileTree :nodes="asset.fileTree" />
          </ScrollArea>
        </CardContent>
      </Card>
    </aside>
  </article>
</template>
