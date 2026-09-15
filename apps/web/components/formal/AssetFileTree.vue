<script setup lang="ts">
import type { AssetFileTreeNode } from "@digital/presentation";
import {
  ChevronRight,
  File,
  FileArchive,
  Film,
  Folder,
  Image,
} from "@lucide/vue";
import { ref } from "vue";

import { Button } from "#/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";

withDefaults(
  defineProps<{
    readonly nodes: readonly AssetFileTreeNode[];
    readonly pathPrefix?: string;
  }>(),
  { pathPrefix: "" },
);
const opened = ref<Record<string, boolean>>({});

function isOpen(path: string) {
  return opened.value[path] ?? true;
}
function setOpen(path: string, value: boolean) {
  opened.value = { ...opened.value, [path]: value };
}
function size(bytes: number | undefined) {
  if (bytes === undefined) return;
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
function icon(format: string | undefined) {
  if (format === "MP4") return Film;
  if (format && ["JPG", "JPEG", "PNG", "WEBP", "GIF"].includes(format))
    return Image;
  if (format && ["ZIP", "RAR", "7Z"].includes(format)) return FileArchive;
  return File;
}
</script>

<template>
  <ul class="grid gap-0.5">
    <li v-for="node in nodes" :key="`${pathPrefix}/${node.name}`">
      <Collapsible
        v-if="node.children"
        :open="isOpen(`${pathPrefix}/${node.name}`)"
        @update:open="setOpen(`${pathPrefix}/${node.name}`, $event)"
      >
        <CollapsibleTrigger
          class="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm font-medium hover:bg-muted"
        >
          <ChevronRight
            class="size-4 transition-transform group-data-[state=open]:rotate-90"
          />
          <Folder class="size-4 text-muted-foreground" />
          <span class="min-w-0 truncate">{{ node.name }}</span>
        </CollapsibleTrigger>
        <CollapsibleContent class="ml-4 border-l pl-2">
          <AssetFileTree
            :nodes="node.children"
            :path-prefix="`${pathPrefix}/${node.name}`"
          />
        </CollapsibleContent>
      </Collapsible>

      <Button
        v-else-if="node.downloadUrl"
        as-child
        variant="ghost"
        class="h-auto w-full justify-start gap-2 px-1.5 py-1.5 text-left"
      >
        <a :href="node.downloadUrl">
          <component
            :is="icon(node.format)"
            class="size-4 shrink-0 text-muted-foreground"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm">{{ node.name }}</span>
            <span class="block text-xs text-muted-foreground">{{
              [node.format, size(node.byteLength)].filter(Boolean).join(" · ")
            }}</span>
          </span>
        </a>
      </Button>

      <div v-else class="flex gap-2 rounded-md px-1.5 py-1.5">
        <component
          :is="icon(node.format)"
          class="size-4 shrink-0 text-muted-foreground"
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm">{{ node.name }}</span>
          <span class="block text-xs text-muted-foreground">{{
            [node.format, size(node.byteLength)].filter(Boolean).join(" · ")
          }}</span>
        </span>
      </div>
    </li>
  </ul>
</template>
