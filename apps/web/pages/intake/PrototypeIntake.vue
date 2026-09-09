<script setup lang="ts">
import {
  Check,
  ChevronRight,
  File,
  Folder,
  Music,
  Plus,
  X,
  CircleAlert,
} from "@lucide/vue";
// Drop 原型：保留用户确认的 A 同屏整理。身份补充只展示后续入口，操作均为内存示例。
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";

import "vue-sonner/style.css";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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

import type {
  PrototypeMaterial as Material,
  PrototypeSourceMatch,
} from "./prototype-intake-model";
import PrototypeFileTree from "./PrototypeFileTree.vue";
import PrototypeIdentityDialog from "./PrototypeIdentityDialog.vue";
import PrototypeIntakeControls from "./PrototypeIntakeControls.vue";
type Content = {
  id: number;
  name: string;
  category: string;
  files: Material[];
  saved: boolean;
  sourceMatch?: PrototypeSourceMatch;
  lookup?: Pick<PrototypeSourceMatch, "source" | "identity">;
};
const materials = ref<Material[]>([]);
const contents = ref<Content[]>([]);
let nextId = 0;
const candidateResolved = ref(false);
const selected = ref<string[]>([]);
const scene = ref("normal");
const scanned = ref(true);
const scanning = ref(false);
const saving = ref(false);
const automatic = ref(true);
const showAutomatic = ref(false);
const dialog = ref(false);
const name = ref("");
const category = ref("unknown");
const location = ref("新增内容");
const search = ref("");
const identityContent = ref<Content>();
const lookupOutcome = ref("found");
// 这里只隐藏本次已整理材料，不是领域独占规则；整体与独立成员可使用共同材料。
const used = computed(
  () =>
    new Set(
      contents.value.flatMap((content) => content.files.map((file) => file.id)),
    ),
);
const remaining = computed(() =>
  materials.value.filter((file) => !used.value.has(file.id)),
);
const visible = computed(() =>
  remaining.value.filter((file) =>
    `${file.folder}/${file.name}`.includes(search.value),
  ),
);
const draft = computed(() =>
  contents.value.filter((content) => !content.saved),
);
const formFiles = ref<Material[]>([]);
const chosen = computed(() =>
  materials.value.filter((file) => selected.value.includes(file.id)),
);
function reset() {
  candidateResolved.value = false;
  showAutomatic.value = scene.value === "source-failed";
  contents.value = [];
  selected.value = [];
  dialog.value = false;
  identityContent.value = undefined;
  search.value = "";
  toast.dismiss();
  scanned.value = scene.value !== "first";
  automatic.value = !["unknown", "first", "empty"].includes(scene.value);
  materials.value =
    scene.value === "empty"
      ? []
      : [
          {
            id: "a",
            folder: "阅读/山间来信",
            name: "上册.pdf",
            detail: "PDF · 28 MB",
          },
          {
            id: "b",
            folder: "阅读/山间来信",
            name: "下册.pdf",
            detail: "PDF · 31 MB",
          },
          { id: "c", folder: "阅读", name: "随笔.epub", detail: "EPUB · 4 MB" },
          {
            id: "d",
            folder: "现场录音/音轨",
            name: "01 开场.flac",
            detail: "音频 · 42 MB",
          },
          {
            id: "e",
            folder: "现场录音/音轨",
            name: "02 返场.flac",
            detail: "音频 · 56 MB",
          },
          {
            id: "f",
            folder: "现场录音/照片",
            name: "演出照片.jpg",
            detail: "图片 · 3 MB",
          },
        ];
  if (scene.value === "partial")
    materials.value.push({
      id: "broken",
      folder: "阅读",
      name: "损坏的扫描件.pdf",
      detail: "文件无法读取",
      broken: true,
    });
}
watch(scene, reset, { immediate: true });
async function scan() {
  scanning.value = true;
  await new Promise((resolve) => setTimeout(resolve, 650));
  scanned.value = true;
  scanning.value = false;
}
function selectMaterials(ids: string[], checked: boolean) {
  selected.value = checked
    ? [...new Set([...selected.value, ...ids])]
    : selected.value.filter((id) => !ids.includes(id));
}
function title(content: Content) {
  return content.name || content.sourceMatch?.title || "未命名";
}
function useSourceMatch(match: PrototypeSourceMatch) {
  if (!identityContent.value) return;
  identityContent.value.sourceMatch = match;
  if (identityContent.value.category === "unknown" && match.source === "isbn")
    identityContent.value.category = "books";
  identityContent.value = undefined;
  toast.success("资料已选用");
}
function beginGroup() {
  formFiles.value = [...chosen.value];
  name.value = "";
  category.value = "unknown";
  dialog.value = true;
}
function addGroup() {
  contents.value.push({
    id: ++nextId,
    name: name.value.trim(),
    category: category.value,
    files: [...formFiles.value],
    saved: false,
  });
  selected.value = [];
  dialog.value = false;
}
function removeGroup(id: number) {
  contents.value = contents.value.filter((content) => content.id !== id);
}
function chooseCandidate(separate: boolean) {
  const files = materials.value.filter((file) => ["a", "b"].includes(file.id));
  for (const group of separate ? files.map((file) => [file]) : [files]) {
    contents.value.push({
      id: ++nextId,
      name: "",
      category: "unknown",
      files: group,
      saved: false,
    });
  }
  candidateResolved.value = true;
  selected.value = selected.value.filter((id) => !["a", "b"].includes(id));
}
async function save() {
  saving.value = true;
  await new Promise((resolve) => setTimeout(resolve, 650));
  saving.value = false;
  if (scene.value === "failed") {
    toast.error("未能保存，请重试");
    return;
  }
  if (scene.value === "conflict") {
    toast.error("部分文件的归属已变化，请重新检查");
    return;
  }
  for (const content of draft.value) content.saved = true;
  toast.success("内容已添加");
}
</script>

<template>
  <section class="pb-32">
    <Toaster />
    <header class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">添加内容</h1>
      <div class="flex items-center gap-2">
        <Select v-model="location"
          ><SelectTrigger class="h-9 w-36" aria-label="文件位置"
            ><Folder class="size-4" /><SelectValue /></SelectTrigger
          ><SelectContent
            ><SelectItem value="新增内容">新增内容</SelectItem
            ><SelectItem value="下载">下载</SelectItem></SelectContent
          ></Select
        ><Button
          variant="outline"
          size="sm"
          :disabled="scanning"
          @click="scan"
          >{{ scanning ? "正在检查" : "检查文件" }}</Button
        >
      </div>
    </header>
    <div
      v-if="!scanned"
      class="grid min-h-64 place-content-center justify-items-center gap-4 rounded-xl border border-dashed"
    >
      <Folder class="size-9 text-muted-foreground" />
      <h2 class="text-lg font-medium">选择一个文件夹开始</h2>
      <Button :disabled="scanning" @click="scan">{{
        scanning ? "正在检查" : "检查文件"
      }}</Button>
    </div>
    <template v-else>
      <div v-if="automatic" class="mb-4 rounded-lg border px-4 py-3">
        <button
          class="flex w-full items-center gap-3 text-left"
          @click="showAutomatic = !showAutomatic"
        >
          <Check class="size-4 text-emerald-600" /><span
            class="flex-1 text-sm font-medium"
            >已自动添加 1 项内容</span
          ><ChevronRight class="size-4" :class="showAutomatic && 'rotate-90'" />
        </button>
        <div v-if="showAutomatic" class="mt-3 flex gap-3 border-t pt-3">
          <div
            class="grid size-12 place-content-center rounded-md bg-stone-100"
          >
            <Music class="size-6 text-stone-500" />
          </div>
          <div class="text-sm">
            <p class="font-medium">雨夜的陪伴</p>
            <p class="mt-1 text-muted-foreground">RJ01234567 · 12 个文件</p>
            <p class="mt-1 text-muted-foreground">音轨、封面、台本</p>
            <p v-if="scene === 'source-failed'" class="mt-2 text-amber-700">
              资料获取失败
              <Button
                variant="link"
                size="sm"
                class="h-auto p-0"
                @click="toast.info('已保留内容，可稍后补充资料')"
                >稍后补充</Button
              >
            </p>
          </div>
        </div>
      </div>
      <div
        v-if="scene === 'conflict'"
        role="alert"
        class="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm"
      >
        <CircleAlert
          class="size-4 shrink-0"
        />部分文件已有不同的归属，确认前需要重新检查。<Button
          variant="outline"
          size="sm"
          class="ml-auto"
          @click="scene = 'normal'"
          >重新检查</Button
        >
      </div>
      <div
        v-if="scene === 'candidate' && !candidateResolved"
        class="mb-4 rounded-lg border border-amber-200 p-4"
      >
        <h2 class="font-medium">这两个文件是一项内容，还是两项？</h2>
        <p class="mt-2 text-sm text-muted-foreground">
          阅读 / 山间来信 / 上册.pdf · 下册.pdf
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="chooseCandidate(false)"
            >保留为一项内容</Button
          ><Button variant="outline" size="sm" @click="chooseCandidate(true)"
            >分别保留</Button
          ><Button variant="ghost" size="sm" @click="candidateResolved = true"
            >自行选择文件</Button
          >
        </div>
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
              {{ materials.length ? "文件已全部整理" : "没有发现新文件" }}
            </div>
            <PrototypeFileTree
              v-if="visible.length"
              :files="visible"
              :selected="selected"
              class="p-2"
              @select="selectMaterials"
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
            ><Button :disabled="!selected.length" @click="beginGroup"
              ><Plus class="size-4" />组成一项内容</Button
            >
          </div>
        </section>
        <section class="min-w-0">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-base font-semibold">
              {{
                contents.some((content) => content.saved)
                  ? "本次内容"
                  : "准备添加"
              }}
              <span class="ml-1 font-normal text-muted-foreground">{{
                contents.length
              }}</span>
            </h2>
          </div>
          <div
            v-if="!contents.length"
            class="grid min-h-64 place-content-center justify-items-center gap-3 rounded-lg border border-dashed text-sm text-muted-foreground"
          >
            <File class="size-8 text-stone-300" />整理好的内容会显示在这里
          </div>
          <div class="max-h-[60dvh] space-y-3 overflow-y-auto">
            <article
              v-for="content in contents"
              :key="content.id"
              class="rounded-lg border p-4"
            >
              <div class="flex gap-3">
                <div
                  class="grid h-20 w-16 shrink-0 place-content-center rounded-md bg-stone-100"
                >
                  <component
                    :is="content.category === 'audio' ? Music : File"
                    class="size-7 text-stone-400"
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <h3 class="text-lg font-medium">
                    {{ title(content) }}
                  </h3>
                  <p
                    v-if="content.category !== 'unknown'"
                    class="mt-1 text-sm text-muted-foreground"
                  >
                    {{
                      content.category === "audio"
                        ? "音频"
                        : content.category === "books"
                          ? "书籍"
                          : "视频"
                    }}
                  </p>
                  <p class="mt-2 text-sm text-muted-foreground">
                    {{ content.files.length }} 个文件
                  </p>
                  <p
                    v-if="content.sourceMatch"
                    class="mt-1 text-sm text-muted-foreground"
                  >
                    {{ content.sourceMatch.description }}
                  </p>
                  <p
                    v-if="content.sourceMatch"
                    class="mt-1 break-all text-sm text-muted-foreground"
                  >
                    {{
                      content.sourceMatch.source === "isbn"
                        ? "ISBN"
                        : content.sourceMatch.source.toUpperCase()
                    }}
                    {{ content.sourceMatch.identity }}
                  </p>
                </div>
                <span
                  v-if="content.saved"
                  class="flex h-fit items-center gap-1 text-sm text-emerald-700"
                  ><Check class="size-4" />已添加</span
                ><Button
                  v-else
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="`撤回 ${title(content)}`"
                  @click="removeGroup(content.id)"
                  ><X
                /></Button>
              </div>
              <ul class="mt-3 border-t pt-2">
                <li
                  v-for="file in content.files"
                  :key="file.id"
                  class="flex items-center gap-2 py-1 text-sm text-muted-foreground"
                >
                  <File class="size-3.5 shrink-0" /><span class="truncate"
                    >{{ file.folder }}/{{ file.name }}</span
                  >
                </li>
              </ul>
              <div class="mt-3 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  @click="identityContent = content"
                  >{{ content.sourceMatch ? "更换资料" : "补充资料" }}</Button
                >
              </div>
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
            <Button :disabled="!draft.length || saving" @click="save">{{
              saving
                ? "正在添加"
                : draft.length
                  ? `添加 ${draft.length} 项内容`
                  : "已添加"
            }}</Button>
          </div>
        </section>
      </div>
    </template>
    <Dialog :open="dialog" @update:open="dialog = $event"
      ><DialogContent
        :aria-describedby="undefined"
        class="gap-4 p-4 sm:max-w-md"
        ><DialogHeader><DialogTitle>组成一项内容</DialogTitle></DialogHeader>
        <form class="grid gap-4" @submit.prevent="addGroup">
          <p class="text-sm text-muted-foreground">
            {{ formFiles.length }} 个文件
          </p>
          <label class="grid gap-2 text-sm font-medium"
            >名称<Input v-model="name" placeholder="未命名" /></label
          ><label class="grid gap-2 text-sm font-medium"
            >类别<Select v-model="category"
              ><SelectTrigger aria-label="内容类别"
                ><SelectValue /></SelectTrigger
              ><SelectContent
                ><SelectItem value="unknown">暂不确定</SelectItem
                ><SelectItem value="books">书籍</SelectItem
                ><SelectItem value="audio">音频</SelectItem
                ><SelectItem value="video">视频</SelectItem></SelectContent
              ></Select
            ></label
          ><DialogFooter
            ><Button type="button" variant="outline" @click="dialog = false"
              >取消</Button
            ><Button>完成整理</Button></DialogFooter
          >
        </form></DialogContent
      ></Dialog
    >
    <PrototypeIdentityDialog
      v-if="identityContent"
      :name="title(identityContent)"
      :current="identityContent.sourceMatch"
      :input="identityContent.lookup"
      :outcome="lookupOutcome"
      @input="identityContent.lookup = $event"
      @close="identityContent = undefined"
      @confirm="useSourceMatch"
    />
    <PrototypeIntakeControls>
      <Select v-model="scene"
        ><SelectTrigger
          aria-label="示例状态"
          class="h-8 w-32 border-white/25 bg-transparent text-xs"
          ><SelectValue /></SelectTrigger
        ><SelectContent
          ><SelectItem value="normal">正常</SelectItem
          ><SelectItem value="candidate">范围判断不一致</SelectItem
          ><SelectItem value="first">首次添加</SelectItem
          ><SelectItem value="unknown">无法自动识别</SelectItem
          ><SelectItem value="empty">没有新文件</SelectItem
          ><SelectItem value="conflict">归属冲突</SelectItem
          ><SelectItem value="partial">部分文件损坏</SelectItem
          ><SelectItem value="source-failed">来源获取失败</SelectItem
          ><SelectItem value="failed">保存失败</SelectItem></SelectContent
        ></Select
      >
      <Select v-model="lookupOutcome"
        ><SelectTrigger
          aria-label="资料查询示例"
          class="h-8 w-36 border-white/25 bg-transparent text-xs"
          ><SelectValue /></SelectTrigger
        ><SelectContent
          ><SelectItem value="found">查询：找到资料</SelectItem
          ><SelectItem value="multiple">查询：多个结果</SelectItem
          ><SelectItem value="empty">查询：未找到</SelectItem
          ><SelectItem value="failed">查询：连接失败</SelectItem></SelectContent
        ></Select
      >
    </PrototypeIntakeControls>
  </section>
</template>
