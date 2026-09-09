<script setup lang="ts">
import {
  Check,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Minus,
  CircleAlert,
} from "@lucide/vue";
import { computed } from "vue";

import { Checkbox } from "#/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";

import type { PrototypeMaterial } from "./prototype-intake-model";

const props = withDefaults(
  defineProps<{
    files: PrototypeMaterial[];
    selected: string[];
    base?: string;
  }>(),
  { base: "" },
);
const emit = defineEmits<{ select: [ids: string[], checked: boolean] }>();
const folders = computed(() =>
  [
    ...new Set(
      props.files
        .filter((file) => file.folder !== props.base)
        .map((file) => {
          const relative = props.base
            ? file.folder.slice(props.base.length + 1)
            : file.folder;
          return relative.split("/")[0]!;
        }),
    ),
  ].toSorted(),
);
const directFiles = computed(() =>
  props.files.filter((file) => file.folder === props.base),
);
const folderPath = (name: string) =>
  props.base ? `${props.base}/${name}` : name;
const children = (name: string) =>
  props.files.filter(
    (file) =>
      file.folder === folderPath(name) ||
      file.folder.startsWith(`${folderPath(name)}/`),
  );
const selectable = (name: string) =>
  children(name)
    .filter((file) => !file.broken)
    .map((file) => file.id);
function checked(name: string): boolean | "indeterminate" {
  const ids = selectable(name);
  const count = ids.filter((id) => props.selected.includes(id)).length;
  return count === 0 ? false : count === ids.length ? true : "indeterminate";
}
</script>
<template>
  <ul
    :aria-label="base ? undefined : '文件树'"
    data-file-tree
    class="min-w-0 space-y-0.5"
  >
    <li v-for="folder in folders" :key="folderPath(folder)">
      <Collapsible v-slot="{ open }" :default-open="true">
        <div
          class="flex h-9 items-center gap-2 rounded-md px-2 hover:bg-muted/70"
        >
          <CollapsibleTrigger
            :aria-label="`${open ? '收起' : '展开'} ${folderPath(folder)}`"
            class="grid size-5 shrink-0 place-content-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            ><ChevronRight
              class="size-3.5 transition-transform"
              :class="open && 'rotate-90'"
          /></CollapsibleTrigger>
          <Checkbox
            :aria-label="`选择文件夹 ${folderPath(folder)}`"
            :model-value="checked(folder)"
            :disabled="!selectable(folder).length"
            @update:model-value="
              emit('select', selectable(folder), $event === true)
            "
            ><Minus
              v-if="checked(folder) === 'indeterminate'"
              class="size-3" /><Check v-else class="size-3"
          /></Checkbox>
          <CollapsibleTrigger
            class="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            ><component
              :is="open ? FolderOpen : Folder"
              class="size-4 shrink-0 text-muted-foreground"
            /><span class="truncate text-sm">{{
              folder
            }}</span></CollapsibleTrigger
          >
        </div>
        <CollapsibleContent class="ml-[18px] border-l pl-2">
          <PrototypeFileTree
            :files="children(folder)"
            :selected="selected"
            :base="folderPath(folder)"
            @select="(ids, value) => emit('select', ids, value)"
          />
        </CollapsibleContent>
      </Collapsible>
    </li>
    <li v-for="file in directFiles" :key="file.id">
      <label
        class="flex min-h-9 cursor-pointer items-center gap-2 rounded-md py-1.5 pl-2 pr-3 hover:bg-muted/70"
        :class="selected.includes(file.id) && 'bg-muted/70'"
      >
        <span class="size-5 shrink-0" />
        <Checkbox
          :aria-label="`选择 ${file.folder}/${file.name}`"
          :model-value="selected.includes(file.id)"
          :disabled="file.broken"
          @update:model-value="emit('select', [file.id], $event === true)"
        />
        <File class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate text-sm" :title="file.name">{{
          file.name
        }}</span>
        <CircleAlert
          v-if="file.broken"
          :aria-label="file.detail"
          class="size-4 shrink-0 text-destructive"
        />
        <span
          class="shrink-0 text-xs max-sm:hidden"
          :class="file.broken ? 'text-destructive' : 'text-muted-foreground'"
          >{{ file.detail }}</span
        >
      </label>
    </li>
  </ul>
</template>
