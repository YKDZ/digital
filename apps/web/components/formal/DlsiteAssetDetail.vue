<script setup lang="ts">
import type { AssetFileTreeNode, AssetViewModel } from "@digital/presentation";
import { savePlaybackInteraction } from "@digital/web-delivery/client";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  Volume1,
  Volume2,
  VolumeX,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { toast } from "vue-sonner";

import AssetCover from "#/components/formal/AssetCover.vue";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { ScrollArea } from "#/components/ui/scroll-area";
import { Separator } from "#/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "#/components/ui/sheet";
import { Slider } from "#/components/ui/slider";

import DlsiteFileTree from "./DlsiteFileTree.vue";

type Selection = {
  readonly node: AssetFileTreeNode;
  readonly siblings: readonly AssetFileTreeNode[];
};
type Mode = "order" | "all-repeat" | "repeat-one" | "shuffle";
const props = defineProps<{ readonly asset: AssetViewModel }>();
const tree = computed(() => props.asset.dlsite?.fileTree ?? []);
const audio = ref<HTMLAudioElement>();
const selected = ref<AssetFileTreeNode>();
const queue = ref<AssetFileTreeNode[]>([]);
const playing = ref(false);
const currentTime = ref(0);
const mediaDuration = ref(0);
const volume = ref(1);
const muted = ref(false);
const mode = ref<Mode>("order");
const sleepActive = ref(false);
const durations = ref<Record<string, number>>({});
const urls = new Map<string, string>();
let sleepTimer: ReturnType<typeof setTimeout> | undefined;
let lastSavedRevisionId: string | undefined;
let lastSavedBucket = -1;

function leaves(nodes: readonly AssetFileTreeNode[]): AssetFileTreeNode[] {
  return nodes.flatMap((node) =>
    node.children ? leaves(node.children) : [node],
  );
}
function isPlayable(node: AssetFileTreeNode) {
  return !!node.revisionId && ["MP3", "WAV"].includes(node.format ?? "");
}
function containingQueue(
  nodes: readonly AssetFileTreeNode[],
  revisionId: string | undefined,
): AssetFileTreeNode[] | undefined {
  if (!revisionId) return undefined;
  if (nodes.some((node) => node.revisionId === revisionId))
    return nodes.filter(isPlayable);
  for (const node of nodes) {
    const found = node.children
      ? containingQueue(node.children, revisionId)
      : undefined;
    if (found) return found;
  }
  return undefined;
}
const playable = computed(() => leaves(tree.value).filter(isPlayable));
const current = computed(() => selected.value ?? playable.value[0]);
const queueIndex = computed(() =>
  queue.value.findIndex(
    (node) => node.revisionId === current.value?.revisionId,
  ),
);
const shownDuration = computed(() =>
  mediaDuration.value > 0
    ? mediaDuration.value
    : current.value?.revisionId
      ? (durations.value[current.value.revisionId] ?? 0)
      : 0,
);
const detailsByName = computed(() => {
  const files = props.asset.files ?? [];
  return Object.fromEntries(
    files.flatMap((file) =>
      files.filter((item) => item.name === file.name).length === 1
        ? [[file.name, { image: file.image, byteLength: file.byteLength }]]
        : [],
    ),
  );
});
const modeLabel = computed(
  () =>
    ({
      order: "顺序播放",
      "all-repeat": "列表循环",
      "repeat-one": "单曲循环",
      shuffle: "随机播放",
    })[mode.value],
);
function timeLabel(value: number) {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    rest = String(seconds % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}
async function mediaUrl(node: AssetFileTreeNode) {
  if (!node.revisionId) return;
  const cached = urls.get(node.revisionId);
  if (cached) return cached;
  const response = await fetch(
    `/api/playback-plans/${encodeURIComponent(node.revisionId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consumer: {
          contractVersion: "consumer-playback/1",
          supportsByteRanges: true,
          media: [
            { mediaType: "audio/wav", codecs: ["pcm"] },
            { mediaType: "audio/mpeg", codecs: ["mp3"] },
          ],
        },
        preferences: {},
      }),
    },
  );
  const plan = (await response.json()) as {
    readonly status: string;
    readonly mediaUrl?: string;
  };
  if (plan.status !== "ready" || !plan.mediaUrl) return;
  urls.set(node.revisionId, plan.mediaUrl);
  return plan.mediaUrl;
}
async function playNode(node: AssetFileTreeNode): Promise<void> {
  if (!audio.value || !isPlayable(node)) return;
  try {
    if (selected.value && selected.value.revisionId !== node.revisionId)
      void persistPlayback();
    const url = await mediaUrl(node);
    if (!url) throw new Error("播放计划尚未就绪");
    const href = new URL(url, location.href).href;
    if (audio.value.src !== href) {
      selected.value = node;
      currentTime.value = 0;
      mediaDuration.value = durations.value[node.revisionId ?? ""] ?? 0;
      audio.value.src = url;
      const resumeAt = node.interaction?.completed
        ? 0
        : (node.interaction?.positionMilliseconds ?? 0) / 1000;
      if (resumeAt > 0)
        audio.value.addEventListener(
          "loadedmetadata",
          () => {
            if (audio.value)
              audio.value.currentTime = Math.min(
                resumeAt,
                audio.value.duration,
              );
          },
          { once: true },
        );
    } else selected.value = node;
    await audio.value.play();
  } catch {
    toast.error("暂时无法播放这段声音");
  }
}
async function select(value: Selection) {
  queue.value = value.siblings.filter(isPlayable);
  if (!queue.value.length) queue.value = [value.node];
  await playNode(value.node);
}
async function togglePlayback() {
  if (!audio.value) return;
  if (!audio.value.src && current.value) {
    if (!queue.value.length)
      queue.value = containingQueue(tree.value, current.value.revisionId) ?? [
        current.value,
      ];
    await playNode(current.value);
  } else if (audio.value.paused) await audio.value.play();
  else audio.value.pause();
}
async function move(step: number, wrap = false) {
  if (!queue.value.length) return;
  let next = Math.max(0, queueIndex.value) + step;
  if (wrap) next = (next + queue.value.length) % queue.value.length;
  const node = queue.value[next];
  if (node) await playNode(node);
}
function seekBy(seconds: number) {
  if (audio.value)
    audio.value.currentTime = Math.max(
      0,
      Math.min(shownDuration.value, audio.value.currentTime + seconds),
    );
}
function seek(value: number[] | undefined) {
  if (audio.value && value?.[0] !== undefined)
    audio.value.currentTime = value[0];
}
function setVolume(value: number[] | undefined) {
  if (!audio.value || value?.[0] === undefined) return;
  volume.value = value[0];
  audio.value.volume = volume.value;
  audio.value.muted = false;
  muted.value = false;
}
function toggleMute() {
  if (!audio.value) return;
  audio.value.muted = !audio.value.muted;
  muted.value = audio.value.muted;
}
function enqueue(node: AssetFileTreeNode) {
  if (
    isPlayable(node) &&
    !queue.value.some((item) => item.revisionId === node.revisionId)
  )
    queue.value = [...queue.value, node];
}
function playNext(node: AssetFileTreeNode) {
  if (!isPlayable(node)) return;
  const next = queue.value.filter(
    (item) => item.revisionId !== node.revisionId,
  );
  next.splice(
    Math.max(
      0,
      next.findIndex((item) => item.revisionId === current.value?.revisionId),
    ) + 1,
    0,
    node,
  );
  queue.value = next;
}
function reorder(index: number, step: number) {
  const target = index + step;
  if (target < 0 || target >= queue.value.length) return;
  const next = [...queue.value],
    [node] = next.splice(index, 1);
  if (node) next.splice(target, 0, node);
  queue.value = next;
}
function remove(index: number) {
  queue.value = queue.value.filter((_, itemIndex) => itemIndex !== index);
}
function clearQueue() {
  audio.value?.pause();
  queue.value = [];
  selected.value = undefined;
}
function cycleMode() {
  const modes: Mode[] = ["order", "all-repeat", "repeat-one", "shuffle"];
  mode.value = modes[(modes.indexOf(mode.value) + 1) % modes.length] ?? "order";
}
async function ended() {
  await persistPlayback(true);
  if (mode.value === "repeat-one" && audio.value) {
    audio.value.currentTime = 0;
    await audio.value.play();
  } else if (mode.value === "shuffle" && queue.value.length > 1) {
    const choices = queue.value.filter(
        (_, index) => index !== queueIndex.value,
      ),
      node = choices[Math.floor(Math.random() * choices.length)];
    if (node) await playNode(node);
  } else if (queueIndex.value < queue.value.length - 1) await move(1);
  else if (mode.value === "all-repeat") await move(1, true);
}
async function persistPlayback(completed = false, reportFailure = false) {
  const revisionId = current.value?.revisionId;
  if (!revisionId || !audio.value) return;
  const previousRevisionId = lastSavedRevisionId;
  const previousBucket = lastSavedBucket;
  lastSavedRevisionId = revisionId;
  lastSavedBucket = Math.floor(audio.value.currentTime / 10);
  try {
    await savePlaybackInteraction({
      revisionId,
      positionMilliseconds: Math.max(
        0,
        Math.round(audio.value.currentTime * 1000),
      ),
      completed,
    });
  } catch {
    lastSavedRevisionId = previousRevisionId;
    lastSavedBucket = previousBucket;
    if (reportFailure) toast.error("暂时无法保存播放位置");
  }
}
function updatePlaybackTime() {
  currentTime.value = audio.value?.currentTime ?? 0;
  const revisionId = current.value?.revisionId;
  const bucket = Math.floor(currentTime.value / 10);
  if (
    revisionId &&
    bucket > 0 &&
    (revisionId !== lastSavedRevisionId || bucket !== lastSavedBucket)
  )
    void persistPlayback();
}
function pausePlayback() {
  playing.value = false;
  void persistPlayback(false, true);
}
function setSleep(minutes?: number) {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepActive.value = !!minutes;
  if (minutes)
    sleepTimer = setTimeout(() => {
      audio.value?.pause();
      sleepActive.value = false;
    }, minutes * 60_000);
}
function keydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, [contenteditable='true']")) return;
  if (event.code === "Space") {
    event.preventDefault();
    void togglePlayback();
  } else if (event.key === "ArrowLeft") seekBy(-5);
  else if (event.key === "ArrowRight") seekBy(30);
}
function waveDuration(bytes: ArrayBuffer): number | undefined {
  const view = new DataView(bytes);
  if (view.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return;
  let offset = 12,
    rate: number | undefined;
  while (offset + 8 <= view.byteLength) {
    const type = view.getUint32(offset, false),
      size = view.getUint32(offset + 4, true);
    if (type === 0x666d7420 && offset + 16 <= view.byteLength)
      rate = view.getUint32(offset + 12, true);
    if (type === 0x64617461 && rate) return size / rate;
    offset += 8 + size + (size % 2);
  }
  return undefined;
}
async function loadDuration(node: AssetFileTreeNode) {
  if (!node.revisionId || node.format !== "WAV") return;
  const url = await mediaUrl(node);
  if (!url) return;
  const response = await fetch(url, { headers: { range: "bytes=0-65535" } }),
    duration = waveDuration(await response.arrayBuffer());
  if (duration)
    durations.value = { ...durations.value, [node.revisionId]: duration };
}
onMounted(() => {
  window.addEventListener("keydown", keydown);
  for (const node of playable.value) void loadDuration(node);
});
onBeforeUnmount(() => {
  void persistPlayback();
  window.removeEventListener("keydown", keydown);
  if (sleepTimer) clearTimeout(sleepTimer);
});
</script>

<template>
  <article v-if="asset.dlsite" class="pb-24">
    <audio
      ref="audio"
      preload="metadata"
      @play="playing = true"
      @pause="pausePlayback"
      @timeupdate="updatePlaybackTime"
      @durationchange="mediaDuration = audio?.duration ?? 0"
      @ended="ended"
    />
    <header class="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <AssetCover
        :src="asset.dlsite.cover"
        :title="asset.title"
        placement="detail"
      />
      <div class="flex flex-col justify-end gap-3 py-1">
        <div class="flex flex-wrap gap-1.5">
          <Badge v-if="asset.dlsite.releaseDate" variant="secondary">{{
            asset.dlsite.releaseDate
          }}</Badge
          ><Badge v-if="asset.dlsite.priceJpy" variant="outline"
            >{{
              Number(asset.dlsite.priceJpy).toLocaleString("ja-JP")
            }}
            JPY</Badge
          >
        </div>
        <div class="grid gap-1">
          <h1 class="max-w-5xl text-3xl leading-tight font-bold tracking-tight">
            {{ asset.title }}
          </h1>
          <p v-if="asset.dlsite.circle" class="text-muted-foreground">
            {{ asset.dlsite.circle }}
          </p>
        </div>
        <div class="flex gap-2">
          <Button size="sm" :disabled="!current" @click="togglePlayback"
            ><Play />开始播放</Button
          ><Button
            v-if="asset.officialPage"
            as="a"
            :href="asset.officialPage"
            target="_blank"
            size="sm"
            variant="outline"
            ><ExternalLink />作品页面</Button
          >
        </div>
      </div>
    </header>
    <Separator class="my-5" />
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(17rem,0.65fr)]">
      <Card
        ><CardHeader class="px-4 py-3"
          ><CardTitle class="text-base">内容</CardTitle></CardHeader
        ><CardContent class="px-3 pb-3"
          ><ScrollArea class="h-[38rem] pr-2"
            ><DlsiteFileTree
              :nodes="tree"
              :selected-revision-id="current?.revisionId"
              :details-by-name="detailsByName"
              :durations="durations"
              @enqueue="enqueue"
              @play-next="playNext"
              @select="select" /></ScrollArea></CardContent
      ></Card>
      <div class="grid content-start gap-4">
        <Card v-if="asset.dlsite.genres.length">
          <CardHeader class="px-4 py-3"
            ><CardTitle class="text-base">标签</CardTitle></CardHeader
          >
          <CardContent class="flex flex-wrap gap-1.5 px-4 pb-4">
            <Badge
              v-for="genre in asset.dlsite.genres"
              :key="`${genre.vocabulary}:${genre.termId}:${genre.label}`"
              variant="secondary"
              >{{ genre.label }}</Badge
            >
          </CardContent>
        </Card>
        <Card v-if="asset.dlsite.introduction"
          ><CardHeader class="px-4 py-3"
            ><CardTitle class="text-base">作品简介</CardTitle></CardHeader
          ><CardContent
            class="line-clamp-[14] px-4 pb-4 text-sm leading-6 whitespace-pre-wrap"
            >{{ asset.dlsite.introduction }}</CardContent
          ></Card
        >
        <Card v-if="asset.dlsite.series.length"
          ><CardHeader class="px-4 py-3"
            ><CardTitle class="text-base">系列</CardTitle></CardHeader
          ><CardContent class="px-4 pb-4"
            ><ul class="grid gap-2 text-sm">
              <li
                v-for="entry in asset.dlsite.series"
                :key="entry.relationshipId"
                class="flex items-baseline justify-between gap-3"
              >
                <span>{{ entry.name }}</span>
                <span
                  v-if="entry.position"
                  class="shrink-0 text-muted-foreground"
                  >{{ entry.position }}</span
                >
              </li>
            </ul></CardContent
          ></Card
        >
        <Card v-if="asset.dlsite.credits.length"
          ><CardHeader class="px-4 py-3"
            ><CardTitle class="text-base">制作</CardTitle></CardHeader
          ><CardContent class="px-4 pb-4"
            ><dl class="grid gap-2 text-sm">
              <div
                v-for="group in asset.dlsite.credits"
                :key="group.heading"
                class="grid grid-cols-[4rem_1fr] gap-2"
              >
                <dt class="text-muted-foreground">{{ group.heading }}</dt>
                <dd>{{ group.names.join("、") }}</dd>
              </div>
            </dl></CardContent
          ></Card
        >
        <slot name="actions" />
      </div>
    </div>
    <div
      class="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 shadow-2xl backdrop-blur"
    >
      <div class="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2 sm:px-6">
        <div class="flex items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="上一首"
            :disabled="queueIndex <= 0"
            @click="move(-1)"
            ><SkipBack /></Button
          ><Button
            size="icon-sm"
            variant="ghost"
            aria-label="后退五秒"
            @click="seekBy(-5)"
            ><span class="text-xs font-semibold">−5</span></Button
          ><Button
            size="icon"
            class="size-9 rounded-full"
            :disabled="!current"
            :aria-label="playing ? '暂停' : '播放'"
            @click="togglePlayback"
            ><Pause v-if="playing" /><Play v-else /></Button
          ><Button
            size="icon-sm"
            variant="ghost"
            aria-label="前进三十秒"
            @click="seekBy(30)"
            ><span class="text-xs font-semibold">+30</span></Button
          ><Button
            size="icon-sm"
            variant="ghost"
            aria-label="下一首"
            :disabled="queueIndex < 0 || queueIndex >= queue.length - 1"
            @click="move(1)"
            ><SkipForward
          /></Button>
        </div>
        <div class="grid min-w-0 flex-1 gap-1">
          <div class="flex min-w-0 items-center justify-between gap-3 text-xs">
            <p class="truncate font-medium">
              {{ current?.name ?? "选择一段声音" }}
            </p>
            <p class="shrink-0 tabular-nums text-muted-foreground">
              {{ timeLabel(currentTime) }} / {{ timeLabel(shownDuration) }}
            </p>
          </div>
          <Slider
            aria-label="播放进度"
            class="cursor-pointer"
            :min="0"
            :max="Math.max(0, shownDuration)"
            :step="0.1"
            :model-value="[currentTime]"
            @update:model-value="seek"
          />
        </div>
        <div class="flex items-center gap-0.5">
          <Popover
            ><PopoverTrigger as-child
              ><Button size="icon-sm" variant="ghost" aria-label="音量"
                ><VolumeX v-if="muted || volume === 0" /><Volume1
                  v-else-if="volume < 0.55" /><Volume2
                  v-else /></Button></PopoverTrigger
            ><PopoverContent class="w-44 p-2" align="end"
              ><div class="flex items-center gap-3">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  :aria-label="muted ? '恢复声音' : '静音'"
                  @click="toggleMute"
                  ><VolumeX v-if="muted" /><Volume2 v-else /></Button
                ><Slider
                  aria-label="调整音量"
                  class="min-w-0 flex-1 cursor-pointer"
                  :min="0"
                  :max="1"
                  :step="0.01"
                  :model-value="[volume]"
                  @update:model-value="setVolume"
                /><span class="w-9 text-right text-xs tabular-nums">{{
                  Math.round(volume * 100)
                }}</span>
              </div></PopoverContent
            ></Popover
          >
          <Sheet
            ><SheetTrigger as-child
              ><Button size="icon-sm" variant="ghost" aria-label="播放队列"
                ><ListMusic /></Button></SheetTrigger
            ><SheetContent class="flex w-full flex-col p-4 sm:max-w-md"
              ><SheetHeader
                ><SheetTitle>播放队列</SheetTitle
                ><SheetDescription class="sr-only"
                  >调整接下来播放的声音</SheetDescription
                ></SheetHeader
              >
              <div class="flex items-center gap-2">
                <Button variant="outline" size="sm" @click="cycleMode"
                  ><Repeat1 v-if="mode === 'repeat-one'" /><Shuffle
                    v-else-if="mode === 'shuffle'"
                  /><Repeat v-else />{{ modeLabel }}</Button
                ><Popover
                  ><PopoverTrigger as-child
                    ><Button variant="outline" size="sm">{{
                      sleepActive ? "定时已开启" : "定时停止"
                    }}</Button></PopoverTrigger
                  ><PopoverContent class="w-52" align="start"
                    ><div class="grid grid-cols-2 gap-2">
                      <Button size="sm" variant="outline" @click="setSleep(15)"
                        >15 分钟</Button
                      ><Button size="sm" variant="outline" @click="setSleep(30)"
                        >30 分钟</Button
                      ><Button size="sm" variant="outline" @click="setSleep(60)"
                        >60 分钟</Button
                      ><Button size="sm" variant="ghost" @click="setSleep()"
                        >关闭</Button
                      >
                    </div></PopoverContent
                  ></Popover
                ><Button
                  class="ml-auto"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="清空队列"
                  @click="clearQueue"
                  ><Trash2
                /></Button>
              </div>
              <ScrollArea class="min-h-0 flex-1 pr-3"
                ><ol v-if="queue.length" class="grid gap-1 py-2">
                  <li
                    v-for="(node, index) in queue"
                    :key="`${node.revisionId}-${index}`"
                    class="flex items-center gap-1 rounded-md px-2 py-1.5"
                    :class="
                      node.revisionId === current?.revisionId ? 'bg-accent' : ''
                    "
                  >
                    <Button
                      variant="ghost"
                      class="h-auto min-w-0 flex-1 justify-start px-1 text-left"
                      @click="playNode(node)"
                      ><span class="truncate">{{ node.name }}</span></Button
                    ><Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="上移"
                      :disabled="index === 0"
                      @click="reorder(index, -1)"
                      ><ChevronUp /></Button
                    ><Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="下移"
                      :disabled="index === queue.length - 1"
                      @click="reorder(index, 1)"
                      ><ChevronDown /></Button
                    ><Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="移出队列"
                      @click="remove(index)"
                      ><Trash2
                    /></Button>
                  </li>
                </ol>
                <p
                  v-else
                  class="py-12 text-center text-sm text-muted-foreground"
                >
                  选择一段声音后，它所在目录会出现在这里。
                </p></ScrollArea
              ></SheetContent
            ></Sheet
          >
        </div>
      </div>
    </div>
  </article>
</template>
