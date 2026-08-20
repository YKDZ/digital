<script setup lang="ts">
import type { AssetViewModel } from "#/lib/catalogue";

import AssetActions from "./AssetActions.vue";
import AssetCover from "./AssetCover.vue";
import BookFacts from "./BookFacts.vue";
import BookFileList from "./BookFileList.vue";

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
    v-if="asset.book"
    class="grid gap-6 lg:grid-cols-[minmax(13rem,21rem)_minmax(0,1fr)]"
  >
    <div class="grid content-start gap-4">
      <AssetCover
        :src="asset.book.cover"
        :title="asset.book.title"
        placement="detail"
      />
    </div>
    <div class="grid min-w-0 content-start gap-6">
      <header class="grid gap-2">
        <h1 class="text-3xl font-bold tracking-tight">
          {{ asset.book.title }}
        </h1>
        <p v-if="asset.book.contributors.length" class="text-muted-foreground">
          {{ asset.book.contributors.join("、") }}
        </p>
      </header>
      <BookFacts :asset="asset" />
      <BookFileList :asset="asset" />
      <AssetActions
        v-if="showActions"
        :target="asset.refreshTarget"
        @done="emit('refreshed')"
      />
      <footer v-if="asset.officialPage" class="text-xs text-muted-foreground">
        元数据来源：<a
          :href="asset.officialPage"
          target="_blank"
          rel="noreferrer"
          class="underline underline-offset-2 hover:text-foreground"
          >{{ asset.sourceLabel ?? "来源页面" }}</a
        >
      </footer>
    </div>
  </article>
</template>
