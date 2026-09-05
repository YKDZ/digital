<script setup lang="ts">
import type { IntakeSnapshot } from "@digital/web-delivery/client";
import {
  Check,
  ChevronRight,
  CircleAlert,
  File,
  Folder,
  FolderOpen,
  Minus,
} from "@lucide/vue";
import { computed } from "vue";

import { Checkbox } from "#/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";

const props = withDefaults(
  defineProps<{
    files: IntakeSnapshot["files"];
    selected: readonly string[];
    base?: string;
    disabled?: boolean;
  }>(),
  { base: "", disabled: false },
);
const emit = defineEmits<{
  select: [references: string[], checked: boolean];
}>();
const relative = (reference: string) =>
  props.base ? reference.slice(props.base.length + 1) : reference;
const folders = computed(() =>
  [
    ...new Set(
      props.files.flatMap((file) =>
        relative(file.relativePath).includes("/")
          ? [relative(file.relativePath).split("/")[0]!]
          : [],
      ),
    ),
  ].toSorted(),
);
const directFiles = computed(() =>
  props.files.filter((file) => !relative(file.relativePath).includes("/")),
);
const folderPath = (name: string) =>
  props.base ? `${props.base}/${name}` : name;
const children = (name: string) =>
  props.files.filter((file) =>
    file.relativePath.startsWith(`${folderPath(name)}/`),
  );
const selectable = (name: string) =>
  children(name)
    .filter((file) => !file.problem)
    .map((file) => file.relativePath);
function checked(name: string): boolean | "indeterminate" {
  const references = selectable(name);
  const count = references.filter((reference) =>
    props.selected.includes(reference),
  ).length;
  return count === 0
    ? false
    : count === references.length
      ? true
      : "indeterminate";
}
function fileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
</script>

<template>
  <ul :aria-label="base ? undefined : '文件树'" class="min-w-0 space-y-0.5">
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
            :disabled="disabled || !selectable(folder).length"
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
        <CollapsibleContent class="ml-[18px] border-l pl-2"
          ><IntakeFileTree
            :files="children(folder)"
            :selected="selected"
            :base="folderPath(folder)"
            :disabled="disabled"
            @select="(references, value) => emit('select', references, value)"
        /></CollapsibleContent>
      </Collapsible>
    </li>
    <li v-for="file in directFiles" :key="file.relativePath">
      <label
        class="flex min-h-9 cursor-pointer items-center gap-2 rounded-md py-1.5 pl-2 pr-3 hover:bg-muted/70"
        :class="selected.includes(file.relativePath) && 'bg-muted/70'"
      >
        <span class="size-5 shrink-0" /><Checkbox
          :aria-label="`选择 ${file.relativePath}`"
          :model-value="selected.includes(file.relativePath)"
          :disabled="disabled || !!file.problem"
          @update:model-value="
            emit('select', [file.relativePath], $event === true)
          "
        /><File class="size-4 shrink-0 text-muted-foreground" />
        <span
          class="min-w-0 flex-1 truncate text-sm"
          :title="file.relativePath"
          >{{ relative(file.relativePath) }}</span
        ><CircleAlert
          v-if="file.problem"
          :aria-label="file.problem"
          class="size-4 shrink-0 text-destructive"
        /><span
          class="shrink-0 text-xs max-sm:hidden"
          :class="file.problem ? 'text-destructive' : 'text-muted-foreground'"
          >{{ file.problem ?? fileSize(file.size) }}</span
        >
      </label>
    </li>
  </ul>
</template>
