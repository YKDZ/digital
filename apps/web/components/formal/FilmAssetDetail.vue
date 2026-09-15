<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery/client";
import {
  ExternalLink,
  Film,
  MoreHorizontal,
  Play,
  Star,
  Users,
} from "@lucide/vue";
import { computed } from "vue";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Separator } from "#/components/ui/separator";

import AssetActions from "./AssetActions.vue";

const emit = defineEmits<{ refreshed: [] }>();
const props = withDefaults(
  defineProps<{
    readonly asset: AssetViewModel;
    readonly showActions?: boolean;
  }>(),
  { showActions: true },
);
const media = computed(
  () =>
    props.asset.files?.filter(
      (file) => !["JPG", "JPEG", "PNG", "NFO"].includes(file.format),
    ) ?? [],
);
</script>

<template>
  <article v-if="asset.film" data-testid="film-detail">
    <section
      class="relative isolate -mx-4 -mt-4 overflow-hidden border-b bg-card sm:-mx-6 lg:-mx-8"
    >
      <img
        v-if="asset.film.cover"
        :src="asset.film.cover"
        alt=""
        class="absolute inset-0 -z-20 size-full scale-110 object-cover opacity-25 blur-3xl"
      />
      <div
        class="absolute inset-0 -z-10 bg-linear-to-b from-background/40 via-background/80 to-background"
      />
      <div
        class="mx-auto grid max-w-7xl gap-8 px-5 py-9 md:grid-cols-[15rem_minmax(0,1fr)] md:px-8 md:py-12"
      >
        <div
          class="mx-auto aspect-2/3 w-full max-w-60 overflow-hidden rounded-md bg-muted shadow-2xl md:mx-0"
        >
          <img
            v-if="asset.film.cover"
            :src="asset.film.cover"
            :alt="`${asset.film.title}的海报`"
            class="size-full object-cover"
          />
          <div v-else class="flex size-full items-center justify-center">
            <Film class="size-12 text-muted-foreground" />
          </div>
        </div>
        <div class="flex min-w-0 flex-col justify-end pb-1">
          <p class="mb-2 text-sm font-medium text-muted-foreground">电影</p>
          <h1 class="text-4xl font-semibold tracking-tight sm:text-6xl">
            {{ asset.film.title }}
          </h1>
          <p class="mt-3 text-base text-muted-foreground">
            {{ asset.film.year
            }}<template v-if="asset.film.runtimeMinutes">
              · {{ asset.film.runtimeMinutes }} 分钟</template
            >
          </p>
          <div
            v-if="asset.film.genres.length"
            class="mt-4 flex flex-wrap gap-2"
          >
            <Badge
              v-for="genre in asset.film.genres"
              :key="genre"
              variant="outline"
              >{{ genre }}</Badge
            >
          </div>
          <div class="mt-6 flex flex-wrap items-center gap-2">
            <Button size="lg"><Play class="size-5 fill-current" />播放</Button>
            <Badge
              v-for="rating in asset.film.ratings"
              :key="rating.label"
              variant="secondary"
              class="h-9 gap-1.5 px-3"
              ><Star class="size-3.5 fill-current" />{{ rating.label }}
              {{ rating.value }}</Badge
            >
            <Button size="icon" variant="ghost" aria-label="更多操作"
              ><MoreHorizontal class="size-5"
            /></Button>
          </div>
          <p v-if="asset.film.directors.length" class="mt-4 text-sm">
            <span class="text-muted-foreground">导演</span>
            <span class="ml-3">{{ asset.film.directors.join("、") }}</span>
          </p>
        </div>
      </div>
    </section>

    <main
      class="mx-auto grid max-w-7xl gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_19rem]"
    >
      <div class="min-w-0">
        <section>
          <h2 class="mb-3 text-xl font-semibold">剧情简介</h2>
          <p class="max-w-4xl text-base leading-8">
            {{ asset.film.introduction || "暂无简介" }}
          </p>
        </section>
        <Separator class="my-8" />
        <section v-if="asset.film.cast.length">
          <h2 class="mb-4 text-xl font-semibold">演职人员</h2>
          <div class="flex gap-3 overflow-x-auto pb-3">
            <div
              v-for="person in asset.film.cast"
              :key="person"
              class="w-32 shrink-0 overflow-hidden rounded-md border bg-card"
            >
              <div
                class="flex aspect-square items-center justify-center bg-muted"
              >
                <Users class="size-8 text-muted-foreground/60" />
              </div>
              <p class="truncate px-3 py-2.5 text-sm font-medium">
                {{ person }}
              </p>
            </div>
          </div>
        </section>
        <Separator v-if="asset.film.cast.length" class="my-8" />
        <section>
          <h2 class="mb-4 text-xl font-semibold">可观看版本</h2>
          <div class="divide-y rounded-lg border bg-card/70">
            <div
              v-for="file in media"
              :key="file.name"
              class="flex items-center gap-4 px-4 py-3.5"
            >
              <Film class="size-5 shrink-0 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium">{{ file.name }}</p>
                <p class="mt-0.5 text-sm text-muted-foreground">
                  {{ file.format }}
                </p>
              </div>
              <Button
                v-if="file.revisionId"
                size="icon"
                variant="ghost"
                aria-label="播放这个版本"
                ><Play class="size-4 fill-current"
              /></Button>
            </div>
          </div>
        </section>
      </div>

      <aside class="grid content-start gap-6">
        <section v-if="asset.film.awards || asset.film.boxOffice">
          <h2 class="mb-3 text-sm font-medium text-muted-foreground">
            更多信息
          </h2>
          <div class="grid gap-3 text-sm">
            <p v-if="asset.film.awards">{{ asset.film.awards }}</p>
            <p v-if="asset.film.boxOffice">
              <span class="text-muted-foreground">票房</span>
              <span class="ml-2">{{ asset.film.boxOffice }}</span>
            </p>
          </div>
        </section>
        <Separator
          v-if="
            (asset.film.awards || asset.film.boxOffice) &&
            asset.film.sources.length
          "
        />
        <section v-if="asset.film.sources.length">
          <h2 class="mb-3 text-sm font-medium text-muted-foreground">
            资料来源
          </h2>
          <div class="flex flex-wrap gap-2">
            <Button
              v-for="source in asset.film.sources"
              :key="source.label"
              :as="source.officialPage ? 'a' : 'button'"
              :href="source.officialPage"
              size="sm"
              variant="outline"
              >{{ source.label
              }}<ExternalLink v-if="source.officialPage" class="size-3.5"
            /></Button>
          </div>
        </section>
        <Separator v-if="showActions" />
        <AssetActions
          v-if="showActions"
          :target="asset.refreshTarget"
          :show-enrichment="false"
          @done="emit('refreshed')"
        />
      </aside>
    </main>
  </article>
</template>
