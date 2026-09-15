<script setup lang="ts">
import type { AssetFileTreeNode } from "@digital/presentation";
import {
  ChevronRight,
  File,
  Folder,
  ListPlus,
  MoreHorizontal,
  Play,
  Rows3,
} from "@lucide/vue";
import { ref } from "vue";

import { Button } from "#/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";

defineProps<{
  readonly nodes: readonly AssetFileTreeNode[];
  readonly selectedRevisionId?: string;
  readonly detailsByName?: Readonly<
    Record<string, { readonly image?: string; readonly byteLength?: number }>
  >;
  readonly durations?: Readonly<Record<string, number>>;
}>();
type TreeSelection = {
  readonly node: AssetFileTreeNode;
  readonly siblings: readonly AssetFileTreeNode[];
};

const emit = defineEmits<{
  enqueue: [node: AssetFileTreeNode];
  playNext: [node: AssetFileTreeNode];
  select: [selection: TreeSelection];
}>();
const opened = ref<Record<string, boolean>>({});

function isOpen(name: string) {
  return opened.value[name] ?? true;
}

function setOpen(name: string, value: boolean) {
  opened.value = { ...opened.value, [name]: value };
}

function sizeLabel(bytes: number | undefined) {
  if (bytes === undefined) return undefined;
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function timeLabel(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}
</script>

<template>
  <ul class="grid gap-0.5">
    <li
      v-for="node in nodes"
      :key="`${node.name}-${node.revisionId ?? 'group'}`"
    >
      <Collapsible
        v-if="node.children"
        :open="isOpen(node.name)"
        @update:open="setOpen(node.name, $event)"
      >
        <CollapsibleTrigger
          class="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium hover:bg-muted"
        >
          <ChevronRight
            class="size-4 transition-transform group-data-[state=open]:rotate-90"
          />
          <Folder class="size-4 text-muted-foreground" />
          <span class="min-w-0 truncate">{{ node.name }}</span>
        </CollapsibleTrigger>
        <CollapsibleContent class="ml-4 border-l pl-2">
          <DlsiteFileTree
            :nodes="node.children"
            :selected-revision-id="selectedRevisionId"
            :details-by-name="detailsByName"
            :durations="durations"
            @enqueue="emit('enqueue', $event)"
            @play-next="emit('playNext', $event)"
            @select="emit('select', $event)"
          />
        </CollapsibleContent>
      </Collapsible>
      <div
        v-else
        class="group/row flex min-h-10 items-stretch rounded-md hover:bg-muted"
        :class="
          node.revisionId === selectedRevisionId
            ? 'bg-accent text-accent-foreground'
            : ''
        "
      >
        <Button
          variant="ghost"
          class="h-auto min-w-0 flex-1 justify-start gap-2 rounded-r-none px-1.5 py-1 text-left font-normal hover:bg-transparent"
          :disabled="!node.revisionId"
          @click="emit('select', { node, siblings: nodes })"
        >
          <img
            v-if="detailsByName?.[node.name]?.image"
            :src="detailsByName[node.name]?.image"
            alt=""
            class="size-9 shrink-0 rounded object-cover"
          />
          <span
            v-else
            class="grid size-7 shrink-0 place-items-center rounded bg-muted"
          >
            <Play v-if="node.revisionId" class="size-3.5" />
            <File v-else class="size-3.5 text-muted-foreground" />
          </span>
          <span class="grid min-w-0 flex-1 gap-0.5">
            <span class="truncate text-sm">{{ node.name }}</span>
            <span class="flex gap-2 text-xs text-muted-foreground">
              <span v-if="node.format">{{ node.format }}</span>
              <span
                v-if="
                  timeLabel(
                    node.revisionId ? durations?.[node.revisionId] : undefined,
                  )
                "
              >
                {{
                  timeLabel(
                    node.revisionId ? durations?.[node.revisionId] : undefined,
                  )
                }}
              </span>
              <span
                v-else-if="sizeLabel(detailsByName?.[node.name]?.byteLength)"
              >
                {{ sizeLabel(detailsByName?.[node.name]?.byteLength) }}
              </span>
              <span v-if="node.interaction?.positionMilliseconds">
                已听
                {{ timeLabel(node.interaction.positionMilliseconds / 1000) }}
              </span>
            </span>
          </span>
        </Button>
        <DropdownMenu v-if="node.revisionId">
          <DropdownMenuTrigger as-child>
            <Button
              variant="ghost"
              class="h-auto w-8 rounded-l-none opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
              aria-label="更多播放选项"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem @select="emit('playNext', node)">
              <Rows3 />下一首播放
            </DropdownMenuItem>
            <DropdownMenuItem @select="emit('enqueue', node)">
              <ListPlus />添加到队列
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  </ul>
</template>
