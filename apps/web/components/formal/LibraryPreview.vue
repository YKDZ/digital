<script setup lang="ts">
import { FileStack } from "@lucide/vue";

import LibraryCover from "#/components/formal/LibraryCover.vue";
import { Separator } from "#/components/ui/separator";
import type { LibraryAsset } from "#/lib/library";
defineProps<{ asset: LibraryAsset }>();
</script>

<template>
  <div class="space-y-7">
    <div
      class="flex h-80 items-center justify-center rounded-xl bg-stone-100/80 p-4"
    >
      <LibraryCover :asset="asset" />
    </div>
    <div>
      <p v-if="asset.classification" class="mb-2 text-sm text-muted-foreground">
        {{ asset.classification }}
      </p>
      <h2 class="text-xl leading-snug font-semibold">{{ asset.title }}</h2>
      <p v-if="asset.creator" class="mt-2 text-sm text-muted-foreground">
        {{ asset.creator }}
      </p>
      <p
        v-if="asset.publisher || asset.date"
        class="mt-2 text-sm text-muted-foreground"
      >
        {{
          [asset.publisher, asset.date?.split("T")[0]]
            .filter(Boolean)
            .join(" · ")
        }}
      </p>
    </div>
    <p
      v-if="asset.description"
      class="line-clamp-8 text-sm leading-6 whitespace-pre-line"
    >
      {{ asset.description }}
    </p>
    <template v-if="asset.fileCount !== undefined"
      ><Separator />
      <div class="flex items-center gap-3">
        <div class="rounded-lg border p-2.5">
          <FileStack class="size-5 text-stone-500" :stroke-width="1.5" />
        </div>
        <p class="text-sm">{{ asset.fileCount }} 个文件</p>
      </div></template
    >
  </div>
</template>
