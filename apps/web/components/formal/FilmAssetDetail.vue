<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery";
import { ExternalLink, Film, Star } from "@lucide/vue";

import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
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
</script>

<template>
  <article v-if="asset.film" class="grid gap-8" data-testid="film-detail">
    <section
      class="relative isolate overflow-hidden rounded-2xl border bg-card shadow-sm"
    >
      <div
        v-if="asset.film.cover"
        class="absolute inset-0 -z-20 overflow-hidden"
      >
        <img
          :src="asset.film.cover"
          alt=""
          class="size-full scale-110 object-cover opacity-35 blur-2xl"
        />
      </div>
      <div
        class="absolute inset-0 -z-10 bg-linear-to-r from-background via-background/94 to-background/70"
      />

      <div
        class="grid gap-7 p-5 sm:p-7 lg:grid-cols-[15rem_minmax(0,1fr)] lg:p-10"
      >
        <div
          class="mx-auto flex aspect-2/3 w-full max-w-60 items-center justify-center overflow-hidden rounded-xl bg-muted shadow-xl lg:mx-0"
        >
          <img
            v-if="asset.film.cover"
            :src="asset.film.cover"
            :alt="`${asset.film.title}的海报`"
            class="size-full object-cover"
          />
          <div
            v-else
            class="flex flex-col items-center gap-3 text-muted-foreground"
          >
            <Film class="size-12" />
            <span>暂无海报</span>
          </div>
        </div>

        <div class="grid content-center gap-5">
          <div class="grid gap-3">
            <p class="text-sm font-medium text-muted-foreground">电影</p>
            <h1 class="text-3xl font-bold tracking-tight sm:text-5xl">
              {{ asset.film.title }}
            </h1>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <span v-if="asset.film.year">{{ asset.film.year }}</span>
              <span v-if="asset.film.runtimeMinutes">
                {{ asset.film.runtimeMinutes }} 分钟
              </span>
              <Badge
                v-for="genre in asset.film.genres"
                :key="genre"
                variant="secondary"
              >
                {{ genre }}
              </Badge>
            </div>
          </div>

          <p
            v-if="asset.film.introduction"
            class="max-w-3xl text-base leading-7 text-muted-foreground"
          >
            {{ asset.film.introduction }}
          </p>
          <p v-else class="text-muted-foreground">暂无简介。</p>

          <div v-if="asset.film.directors.length" class="text-sm">
            <span class="text-muted-foreground">导演</span>
            <span class="ml-3 font-medium">{{
              asset.film.directors.join("、")
            }}</span>
          </div>

          <AssetActions
            v-if="showActions"
            :target="asset.refreshTarget"
            @done="emit('refreshed')"
          />
        </div>
      </div>
    </section>

    <section
      v-if="asset.film.cast.length || asset.film.ratings.length"
      class="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(16rem,0.7fr)]"
    >
      <Card v-if="asset.film.cast.length">
        <CardHeader><CardTitle>演员</CardTitle></CardHeader>
        <CardContent>
          <div class="flex flex-wrap gap-2">
            <Badge
              v-for="person in asset.film.cast"
              :key="person"
              variant="outline"
              class="px-3 py-1.5 text-sm font-normal"
            >
              {{ person }}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card v-if="asset.film.ratings.length">
        <CardHeader><CardTitle>评分</CardTitle></CardHeader>
        <CardContent class="grid gap-3">
          <div
            v-for="rating in asset.film.ratings"
            :key="`${rating.label}-${rating.value}`"
            class="flex items-center justify-between gap-4"
          >
            <span class="flex items-center gap-2 text-sm text-muted-foreground">
              <Star class="size-4" />{{ rating.label }}
            </span>
            <span class="font-semibold">{{ rating.value }}</span>
          </div>
        </CardContent>
      </Card>
    </section>

    <Card v-if="asset.film.awards || asset.film.boxOffice">
      <CardHeader><CardTitle>更多资料</CardTitle></CardHeader>
      <CardContent class="grid gap-4 sm:grid-cols-2">
        <div v-if="asset.film.awards" class="grid gap-1">
          <span class="text-sm text-muted-foreground">获奖情况</span>
          <span>{{ asset.film.awards }}</span>
        </div>
        <div v-if="asset.film.boxOffice" class="grid gap-1">
          <span class="text-sm text-muted-foreground">票房</span>
          <span>{{ asset.film.boxOffice }}</span>
        </div>
      </CardContent>
    </Card>

    <footer v-if="asset.film.sources.length" class="grid gap-3">
      <Separator />
      <p
        class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      >
        <span>元数据来源：</span>
        <component
          v-for="source in asset.film.sources"
          :key="`${source.label}-${source.officialPage}`"
          :is="source.officialPage ? 'a' : 'span'"
          v-bind="
            source.officialPage
              ? {
                  href: source.officialPage,
                  target: '_blank',
                  rel: 'noreferrer',
                }
              : {}
          "
          class="inline-flex items-center gap-1 underline-offset-4"
          :class="source.officialPage ? 'hover:underline' : ''"
        >
          {{ source.label
          }}<ExternalLink v-if="source.officialPage" class="size-3" />
        </component>
      </p>
    </footer>
  </article>
</template>
