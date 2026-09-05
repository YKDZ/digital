<script setup lang="ts">
import {
  Check,
  ChevronRight,
  CircleAlert,
  File,
  Folder,
  LoaderCircle,
  Plus,
  X,
} from "@lucide/vue";
import { computed, ref } from "vue";

import "vue-sonner/style.css";

import IntakeFileTree from "#/components/formal/IntakeFileTree.vue";
import LibraryCover from "#/components/formal/LibraryCover.vue";
import { Button } from "#/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Toaster } from "#/components/ui/sonner";
import { useIntake } from "#/composables/use-intake";
import { libraryAsset } from "#/lib/library";

const {
  snapshot,
  rootId,
  selected,
  contents,
  drafts,
  remaining,
  contentErrors,
  error,
  loading,
  scanning,
  preparing,
  saving,
  busy,
  load,
  chooseRoot,
  scan,
  select,
  prepare,
  remove,
  save,
} = useIntake();
const search = ref("");
const dialog = ref(false);
const name = ref("");
const category = ref("unknown");
const visible = computed(() =>
  remaining.value.filter((file) =>
    file.relativePath
      .toLocaleLowerCase()
      .includes(search.value.trim().toLocaleLowerCase()),
  ),
);
const existing = computed(() =>
  snapshot.value.contents.filter(
    (asset) => !contents.value.some((content) => content.asset.id === asset.id),
  ),
);
const failedFiles = computed(
  () => snapshot.value.files.filter((file) => file.problem).length,
);
const pendingResults = computed(
  () =>
    snapshot.value.execution?.items?.filter(
      (item) =>
        item.acceptedAssetId === undefined &&
        (item.outcome === "proposal" ||
          item.outcome === "unresolved" ||
          item.outcome === "failed"),
    ) ?? [],
);
const classifications: Record<string, string> = {
  book: "书籍",
  audio: "音频",
  video: "视频",
};
function beginGroup() {
  name.value = "";
  category.value = "unknown";
  dialog.value = true;
}
async function finishGroup() {
  if (await prepare(name.value, category.value)) dialog.value = false;
}
</script>

<template>
  <section class="mx-auto w-full max-w-6xl">
    <header class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">添加内容</h1>
      <div class="flex items-center gap-2">
        <Select
          :model-value="rootId"
          :disabled="loading || scanning || busy"
          @update:model-value="(value) => chooseRoot(String(value))"
          ><SelectTrigger class="h-9 w-40" aria-label="文件位置"
            ><Folder class="size-4 shrink-0" /><SelectValue
              placeholder="选择文件位置" /></SelectTrigger
          ><SelectContent
            ><SelectItem
              v-for="root in snapshot.roots"
              :key="root.id"
              :value="root.id"
              >{{ root.displayName }}</SelectItem
            ></SelectContent
          ></Select
        >
        <Button
          variant="outline"
          size="sm"
          :disabled="!rootId || loading || scanning || busy"
          @click="scan"
          ><LoaderCircle v-if="scanning" class="size-4 animate-spin" />{{
            scanning ? "正在检查" : "检查文件"
          }}</Button
        >
      </div>
    </header>
    <div
      v-if="error"
      role="alert"
      class="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 px-3 py-3 text-sm text-destructive"
    >
      <CircleAlert class="size-4 shrink-0" /><span class="flex-1">{{
        error
      }}</span
      ><Button variant="outline" size="sm" @click="load(rootId)">重试</Button>
    </div>
    <div
      v-if="loading"
      class="grid min-h-64 place-content-center text-sm text-muted-foreground"
    >
      正在读取文件位置
    </div>
    <div
      v-else-if="!snapshot.roots.length"
      class="grid min-h-64 place-content-center justify-items-center gap-4 rounded-xl border border-dashed"
    >
      <Folder class="size-9 text-muted-foreground" />
      <h2 class="text-lg font-medium">先添加一个文件位置</h2>
      <Button as-child><a href="/settings/automation">添加位置</a></Button>
    </div>
    <div
      v-else-if="!snapshot.execution"
      class="grid min-h-64 place-content-center justify-items-center gap-4 rounded-xl border border-dashed"
    >
      <Folder class="size-9 text-muted-foreground" />
      <h2 class="text-lg font-medium">检查文件，开始整理</h2>
      <Button :disabled="scanning" @click="scan">{{
        scanning ? "正在检查" : "检查文件"
      }}</Button>
    </div>
    <template v-else>
      <Collapsible
        v-if="existing.length"
        v-slot="{ open }"
        class="mb-4 rounded-lg border px-4 py-3"
      >
        <CollapsibleTrigger class="flex w-full items-center gap-3 text-left"
          ><Check class="size-4 text-emerald-600" /><span
            class="flex-1 text-sm font-medium"
            >已添加 {{ existing.length }} 项内容</span
          ><ChevronRight class="size-4" :class="open && 'rotate-90'"
        /></CollapsibleTrigger>
        <CollapsibleContent
          class="mt-3 grid max-h-72 gap-3 overflow-y-auto border-t pt-3 sm:grid-cols-2"
          ><a
            v-for="asset in existing"
            :key="asset.id"
            :href="`/assets/${asset.id}`"
            class="flex min-w-0 items-center gap-3 rounded-md p-1 hover:bg-muted"
            ><div class="h-16 w-12 shrink-0">
              <LibraryCover :asset="libraryAsset(asset)" />
            </div>
            <div class="min-w-0 text-sm">
              <p class="truncate font-medium">{{ asset.title }}</p>
              <p v-if="asset.sourceLabel" class="mt-1 text-muted-foreground">
                {{ asset.sourceLabel }}
              </p>
            </div></a
          ></CollapsibleContent
        >
      </Collapsible>
      <div
        v-if="failedFiles || snapshot.execution.status === 'failed'"
        role="alert"
        class="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 px-3 py-3 text-sm"
      >
        <CircleAlert class="size-4 shrink-0 text-amber-600" /><span>{{
          failedFiles
            ? `${failedFiles} 个位置未能完成检查，其余文件仍可整理。`
            : "检查未完成，可以重新检查后继续。"
        }}</span>
      </div>
      <div
        v-if="pendingResults.length"
        class="mb-4 rounded-lg border px-4 py-3"
      >
        <h2 class="text-sm font-medium">
          有 {{ pendingResults.length }} 项内容需要确认
        </h2>
        <ul class="mt-2 space-y-1 text-sm text-muted-foreground">
          <li v-for="item in pendingResults" :key="item.key" class="break-all">
            {{ item.relativePaths.join(" · ") }}
          </li>
        </ul>
      </div>
      <div class="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section class="min-w-0">
          <div class="mb-3 flex items-center justify-between gap-2">
            <h2 class="text-base font-semibold">
              待整理的文件
              <span class="ml-1 font-normal text-muted-foreground">{{
                remaining.length
              }}</span>
            </h2>
            <Input
              v-model="search"
              placeholder="查找文件"
              aria-label="查找文件"
              class="h-8 w-40"
            />
          </div>
          <div class="max-h-[60dvh] overflow-y-auto rounded-lg border">
            <div
              v-if="!remaining.length"
              class="px-4 py-12 text-center text-sm text-muted-foreground"
            >
              {{
                scanning
                  ? "正在检查文件"
                  : snapshot.files.length
                    ? "文件已全部整理"
                    : "没有发现新文件"
              }}
            </div>
            <IntakeFileTree
              v-if="visible.length"
              :files="visible"
              :selected="selected"
              :disabled="scanning || busy"
              class="p-2"
              @select="select"
            />
            <p
              v-if="remaining.length && !visible.length"
              class="p-6 text-center text-sm text-muted-foreground"
            >
              没有匹配的文件
            </p>
          </div>
          <div class="mt-3 flex items-center justify-between gap-3">
            <span class="text-sm text-muted-foreground">{{
              selected.length
                ? `已选 ${selected.length} 个文件`
                : "选择属于同一项内容的文件"
            }}</span
            ><Button
              :disabled="!selected.length || scanning || busy"
              @click="beginGroup"
              ><Plus class="size-4" />组成一项内容</Button
            >
          </div>
        </section>
        <section class="min-w-0">
          <h2 class="mb-3 text-base font-semibold">
            {{
              contents.some((content) => content.status === "accepted")
                ? "本次内容"
                : "准备添加"
            }}
            <span class="ml-1 font-normal text-muted-foreground">{{
              contents.length
            }}</span>
          </h2>
          <div
            v-if="!contents.length"
            class="grid min-h-64 place-content-center justify-items-center gap-3 rounded-lg border border-dashed text-sm text-muted-foreground"
          >
            <File class="size-8 text-stone-300" />整理好的内容会显示在这里
          </div>
          <div class="max-h-[60dvh] space-y-3 overflow-y-auto">
            <article
              v-for="content in contents"
              :key="content.executionId"
              class="rounded-lg border p-4"
            >
              <div class="flex gap-3">
                <div class="h-20 w-16 shrink-0">
                  <LibraryCover :asset="libraryAsset(content.asset)" />
                </div>
                <div class="min-w-0 flex-1">
                  <h3 class="text-lg font-medium">
                    <a
                      v-if="content.status === 'accepted'"
                      :href="`/assets/${content.asset.id}`"
                      class="hover:underline"
                      >{{ content.asset.title }}</a
                    ><template v-else>{{ content.asset.title }}</template>
                  </h3>
                  <p
                    v-if="content.asset.classifications.length"
                    class="mt-1 text-sm text-muted-foreground"
                  >
                    {{
                      content.asset.classifications
                        .map((value) => classifications[value] ?? value)
                        .join(" · ")
                    }}
                  </p>
                  <p class="mt-2 text-sm text-muted-foreground">
                    {{ content.relativePaths.length }} 个文件
                  </p>
                </div>
                <span
                  v-if="content.status === 'accepted'"
                  class="flex h-fit shrink-0 items-center gap-1 text-sm text-emerald-700"
                  ><Check class="size-4" />已添加</span
                ><Button
                  v-else
                  variant="ghost"
                  size="icon-sm"
                  :disabled="saving"
                  :aria-label="`撤回 ${content.asset.title}`"
                  @click="remove(content.executionId)"
                  ><X
                /></Button>
              </div>
              <ul class="mt-3 border-t pt-2">
                <li
                  v-for="reference in content.relativePaths"
                  :key="reference"
                  class="flex items-center gap-2 py-1 text-sm text-muted-foreground"
                >
                  <File class="size-3.5 shrink-0" /><span
                    class="truncate"
                    :title="reference"
                    >{{ reference }}</span
                  >
                </li>
              </ul>
              <p
                v-if="contentErrors[content.executionId]"
                role="alert"
                class="mt-3 text-sm text-destructive"
              >
                {{ contentErrors[content.executionId] }}
              </p>
            </article>
          </div>
          <div
            v-if="contents.length"
            class="mt-4 flex items-center justify-between gap-3"
          >
            <p class="text-sm text-muted-foreground">
              {{
                remaining.length
                  ? `还有 ${remaining.length} 个文件未整理`
                  : "所有文件已整理"
              }}
            </p>
            <Button
              :disabled="!drafts.length || saving || scanning"
              @click="save"
              >{{
                saving
                  ? "正在添加"
                  : drafts.length
                    ? `添加 ${drafts.length} 项内容`
                    : "已添加"
              }}</Button
            >
          </div>
        </section>
      </div>
    </template>
    <Dialog
      :open="dialog"
      @update:open="
        (value) => {
          if (!preparing) dialog = value;
        }
      "
      ><DialogContent
        :aria-describedby="undefined"
        class="gap-4 p-4 sm:max-w-md"
        ><DialogHeader><DialogTitle>组成一项内容</DialogTitle></DialogHeader>
        <form class="grid gap-4" @submit.prevent="finishGroup">
          <p class="text-sm text-muted-foreground">
            {{ selected.length }} 个文件
          </p>
          <label class="grid gap-2 text-sm font-medium"
            >名称<Input
              v-model="name"
              placeholder="未命名"
              :disabled="preparing" /></label
          ><label class="grid gap-2 text-sm font-medium"
            >类别<Select v-model="category" :disabled="preparing"
              ><SelectTrigger aria-label="内容类别"
                ><SelectValue /></SelectTrigger
              ><SelectContent
                ><SelectItem value="unknown">暂不确定</SelectItem
                ><SelectItem value="book">书籍</SelectItem
                ><SelectItem value="audio">音频</SelectItem
                ><SelectItem value="video">视频</SelectItem></SelectContent
              ></Select
            ></label
          ><DialogFooter
            ><Button
              type="button"
              variant="outline"
              :disabled="preparing"
              @click="dialog = false"
              >取消</Button
            ><Button :disabled="preparing">{{
              preparing ? "正在检查" : "完成整理"
            }}</Button></DialogFooter
          >
        </form></DialogContent
      ></Dialog
    >
    <Toaster />
  </section>
</template>
