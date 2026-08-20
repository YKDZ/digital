<script setup lang="ts">
import {
  ArrowRight,
  BellDot,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock3,
  Eye,
  File,
  FolderInput,
  FolderOpen,
  FolderSync,
  HardDrive,
  Languages,
  LibraryBig,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  SquareArrowOutUpRight,
  TimerReset,
  TriangleAlert,
  Waypoints,
} from "@lucide/vue";
import { computed, ref } from "vue";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "#/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "#/components/ui/alert-dialog";
import { Badge } from "#/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "#/components/ui/breadcrumb";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { Progress } from "#/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import { ScrollArea, ScrollBar } from "#/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Separator } from "#/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import { Switch } from "#/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { Textarea } from "#/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";

import {
  assets,
  attentionItems,
  prototypeScreens,
  refreshWorkItems,
  type PrototypeScreen,
  type PrototypeState,
} from "./prototype-data";

const props = defineProps<{
  screen: PrototypeScreen;
  state: PrototypeState;
}>();

const emit = defineEmits<{
  navigate: [screen: PrototypeScreen];
  "open-command": [];
  "start-refresh": [];
  "update-state": [update: Partial<PrototypeState>];
}>();

const searchTerm = ref("");
const sidebarOpen = ref(true);
const selectedAsset = ref<(typeof assets)[number]>(assets[0]);
const selectedAttention = ref("identity");
const selectedSeason = ref("第一季");
const exportStrategy = ref("硬链接");
const folderPath = ref("/opt/dev/digital/新内容");

const visibleAssets = computed(() => {
  const value = searchTerm.value.trim().toLocaleLowerCase();
  if (value.length === 0) return assets;
  return assets.filter((asset) =>
    `${asset.title} ${asset.subtitle} ${asset.year}`
      .toLocaleLowerCase()
      .includes(value),
  );
});

const screenLabel = computed(
  () =>
    prototypeScreens.find((item) => item.id === props.screen)?.label ?? "总览",
);

const primaryNavigation = prototypeScreens.filter((item) =>
  ["overview", "assets"].includes(item.id),
);
const statusNavigation = prototypeScreens.filter((item) =>
  ["attention", "inspection"].includes(item.id),
);
const managementNavigation = prototypeScreens.filter((item) =>
  ["automation", "export"].includes(item.id),
);

const seasonOneEpisodes = [
  {
    number: 1,
    title: "冒险结束",
    description: "勇者一行结束十年旅程，芙莉莲开始重新认识时间。",
  },
  {
    number: 2,
    title: "不一定非得是魔法",
    description: "新的旅途从一段留下的记忆与约定开始。",
  },
  {
    number: 3,
    title: "杀人魔法",
    description: "过去的魔法再次出现，新的同行者迎来第一次考验。",
  },
  {
    number: 4,
    title: "灵魂安眠之地",
    description: "一行人继续向北，寻找关于灵魂与告别的答案。",
  },
  {
    number: 5,
    title: "死者的幻影",
    description: "记忆化作眼前的景象，每个人都必须作出选择。",
  },
  {
    number: 6,
    title: "村子的英雄",
    description: "一段被遗忘的往事，让旅途中的关系逐渐清晰。",
  },
] as const;

const seasonTwoEpisodes = [
  {
    number: 1,
    title: "新的北方旅程",
    description: "芙莉莲一行继续前往更遥远的北方。",
  },
  {
    number: 2,
    title: "旅途中的魔法",
    description: "微小的魔法与新的相遇构成旅途的日常。",
  },
] as const;

const episodes = computed(() =>
  selectedSeason.value === "第一季" ? seasonOneEpisodes : seasonTwoEpisodes,
);

function openAsset(asset: (typeof assets)[number]) {
  selectedAsset.value = asset;
  emit("navigate", "asset");
}
</script>

<template>
  <SidebarProvider v-model:open="sidebarOpen">
    <Sidebar collapsible="icon">
      <SidebarHeader class="gap-3 p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="数字资产"
              @click="emit('navigate', 'overview')"
            >
              <div
                class="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
              >
                <Waypoints class="size-4" />
              </div>
              <div class="grid flex-1 text-left text-sm leading-tight">
                <span class="truncate font-semibold">数字资产</span>
                <span class="truncate text-xs text-muted-foreground">
                  本地内容
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <Button
          class="w-full group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:px-0"
          @click="emit('navigate', 'drop')"
        >
          <Plus />
          <span class="group-data-[collapsible=icon]:hidden">添加内容</span>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>浏览</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="item in primaryNavigation" :key="item.id">
                <SidebarMenuButton
                  :tooltip="item.label"
                  :is-active="screen === item.id"
                  @click="emit('navigate', item.id)"
                >
                  <component :is="item.icon" />
                  <span>{{ item.label }}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>状态</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="item in statusNavigation" :key="item.id">
                <SidebarMenuButton
                  :tooltip="item.label"
                  :is-active="screen === item.id"
                  @click="emit('navigate', item.id)"
                >
                  <component :is="item.icon" />
                  <span>{{ item.label }}</span>
                </SidebarMenuButton>
                <SidebarMenuBadge
                  v-if="item.id === 'attention' && !state.attentionResolved"
                >
                  3
                </SidebarMenuBadge>
                <SidebarMenuBadge
                  v-if="item.id === 'inspection' && state.refreshRunning"
                >
                  <span class="relative flex size-2">
                    <span
                      class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"
                    />
                    <span
                      class="relative inline-flex size-2 rounded-full bg-emerald-500"
                    />
                  </span>
                </SidebarMenuBadge>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>管理</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem
                v-for="item in managementNavigation"
                :key="item.id"
              >
                <SidebarMenuButton
                  :tooltip="item.label"
                  :is-active="screen === item.id"
                  @click="emit('navigate', item.id)"
                >
                  <component :is="item.icon" />
                  <span>{{ item.label }}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <div class="p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="设置"
              :is-active="screen === 'settings'"
              @click="emit('navigate', 'settings')"
            >
              <Settings2 />
              <span>设置</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>
      <SidebarRail />
    </Sidebar>

    <SidebarInset class="min-w-0 bg-stone-50/70">
      <header
        class="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur"
      >
        <SidebarTrigger />
        <Separator orientation="vertical" class="h-4" />
        <Breadcrumb class="min-w-0">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage class="truncate">
                {{ screenLabel }}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div class="ml-auto">
          <Button
            variant="outline"
            class="hidden min-w-64 justify-start text-muted-foreground sm:flex"
            @click="emit('open-command')"
          >
            <Search />
            搜索内容或前往页面
            <kbd
              class="ml-auto rounded border bg-muted px-1.5 py-0.5 text-[10px]"
            >
              ⌘ K
            </kbd>
          </Button>
          <Button
            variant="outline"
            size="icon"
            class="sm:hidden"
            aria-label="搜索"
            @click="emit('open-command')"
          >
            <Search />
          </Button>
        </div>
      </header>

      <ScrollArea class="h-[calc(100svh-3.5rem)]">
        <main class="mx-auto w-full max-w-[1500px] p-4 pb-20 sm:p-6 lg:p-8">
          <!-- 总览 -->
          <div v-if="screen === 'overview'" class="grid gap-8">
            <section
              class="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"
            >
              <div>
                <h1 class="text-3xl font-semibold tracking-tight">总览</h1>
                <p class="mt-2 text-muted-foreground">最近添加和更新的内容。</p>
              </div>
              <Button @click="emit('navigate', 'drop')">
                <FolderInput />
                添加内容
              </Button>
            </section>

            <div
              v-if="state.refreshRunning || !state.attentionResolved"
              class="grid gap-3 md:grid-cols-2"
            >
              <Button
                v-if="state.refreshRunning"
                variant="outline"
                class="h-auto justify-start rounded-2xl bg-background p-4 text-left"
                @click="emit('navigate', 'inspection')"
              >
                <LoaderCircle class="animate-spin text-emerald-600" />
                <span class="grid gap-1">
                  <span class="font-medium">正在刷新元数据</span>
                  <span class="text-xs text-muted-foreground">
                    已完成 9 / 13
                  </span>
                </span>
                <ChevronRight class="ml-auto" />
              </Button>
              <Button
                v-if="!state.attentionResolved"
                variant="outline"
                class="h-auto justify-start rounded-2xl bg-background p-4 text-left"
                @click="emit('navigate', 'attention')"
              >
                <CircleAlert class="text-amber-600" />
                <span class="grid gap-1">
                  <span class="font-medium">3 项需要处理</span>
                  <span class="text-xs text-muted-foreground">
                    其中 1 项无法自动继续
                  </span>
                </span>
                <ChevronRight class="ml-auto" />
              </Button>
            </div>

            <section class="grid gap-4">
              <div class="flex items-center justify-between">
                <div>
                  <h2 class="text-xl font-semibold">最近添加</h2>
                  <p class="mt-1 text-sm text-muted-foreground">
                    按最近变化排序。
                  </p>
                </div>
                <Button variant="ghost" @click="emit('navigate', 'assets')">
                  查看全部
                  <ArrowRight />
                </Button>
              </div>
              <div class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
                <Card
                  v-for="asset in assets.slice(0, 8)"
                  :key="asset.id"
                  class="group cursor-pointer overflow-hidden pt-0 transition hover:-translate-y-0.5 hover:shadow-lg"
                  @click="openAsset(asset)"
                >
                  <div
                    :class="['aspect-[16/10] bg-gradient-to-br', asset.tone]"
                  />
                  <CardHeader class="gap-1 p-4">
                    <CardTitle class="line-clamp-1 text-base">
                      {{ asset.title }}
                    </CardTitle>
                    <CardDescription class="line-clamp-1">
                      {{ asset.subtitle }}
                    </CardDescription>
                  </CardHeader>
                </Card>
              </div>
            </section>
          </div>

          <!-- 浏览 -->
          <div v-else-if="screen === 'assets'" class="grid gap-6">
            <section
              class="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"
            >
              <div>
                <h1 class="text-3xl font-semibold tracking-tight">全部内容</h1>
                <p class="mt-2 text-muted-foreground">
                  {{ assets.length }} 项内容
                </p>
              </div>
              <div class="relative w-full sm:w-80">
                <Search
                  class="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  v-model="searchTerm"
                  class="pl-9"
                  placeholder="搜索标题或作者…"
                />
              </div>
            </section>

            <div
              v-if="visibleAssets.length > 0"
              class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4"
            >
              <Card
                v-for="asset in visibleAssets"
                :key="asset.id"
                class="group cursor-pointer overflow-hidden pt-0 transition hover:-translate-y-0.5 hover:shadow-lg"
                @click="openAsset(asset)"
              >
                <div
                  :class="['aspect-[16/10] bg-gradient-to-br', asset.tone]"
                />
                <CardHeader class="gap-1 p-4">
                  <CardTitle class="line-clamp-1 text-base">
                    {{ asset.title }}
                  </CardTitle>
                  <CardDescription class="line-clamp-1">
                    {{ asset.subtitle }}
                  </CardDescription>
                  <div
                    class="flex items-center justify-between pt-2 text-xs text-muted-foreground"
                  >
                    <span>{{ asset.year }}</span>
                    <span>{{ asset.summary }}</span>
                  </div>
                </CardHeader>
              </Card>
            </div>
            <Card v-else class="border-dashed">
              <CardContent
                class="grid place-items-center gap-3 py-16 text-center"
              >
                <Search class="size-7 text-muted-foreground" />
                <div>
                  <div class="font-medium">没有找到匹配内容</div>
                  <p class="mt-1 text-sm text-muted-foreground">
                    尝试更短的标题或原文名称。
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          <!-- 资产详情 -->
          <div v-else-if="screen === 'asset'" class="grid min-w-0 gap-8">
            <template v-if="selectedAsset.id === 'frieren'">
              <section
                class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-violet-950 via-violet-800 to-fuchsia-500 text-white shadow-xl"
              >
                <div
                  class="absolute inset-0 bg-[radial-gradient(circle_at_75%_30%,rgba(255,255,255,0.18),transparent_35%)]"
                />
                <div
                  class="relative grid min-h-[390px] items-end gap-8 p-6 sm:p-10 lg:grid-cols-[1fr_auto]"
                >
                  <div class="max-w-3xl">
                    <p class="text-sm text-violet-100">
                      葬送のフリーレン · 2023–2026
                    </p>
                    <h1
                      class="mt-2 text-4xl font-semibold tracking-tight sm:text-6xl"
                    >
                      葬送的芙莉莲
                    </h1>
                    <p
                      class="mt-5 max-w-2xl text-base leading-7 text-violet-50/90"
                    >
                      勇者一行击败魔王后，精灵魔法使芙莉莲踏上理解时间、记忆与同行者的新旅程。
                    </p>
                    <div class="mt-7 flex flex-wrap gap-3">
                      <Button
                        class="bg-white text-violet-950 hover:bg-white/90"
                      >
                        <Play />
                        播放
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                          <Button
                            variant="outline"
                            size="icon"
                            class="border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                            aria-label="更多操作"
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" class="w-52">
                          <DropdownMenuLabel>更多操作</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem @select="emit('start-refresh')">
                            <RefreshCcw />
                            刷新元数据
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <RotateCcw />
                            重新刮削
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            @select="emit('navigate', 'export')"
                          >
                            <Waypoints />
                            整理与导出
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  <div
                    class="rounded-2xl border border-white/20 bg-black/20 p-4 text-sm backdrop-blur"
                  >
                    <div class="text-violet-100">本地可用</div>
                    <div class="mt-1 text-2xl font-semibold">38 集</div>
                  </div>
                </div>
              </section>

              <section class="grid min-w-0 gap-4">
                <div
                  class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"
                >
                  <div>
                    <h2 class="text-2xl font-semibold">{{ selectedSeason }}</h2>
                    <p class="mt-1 text-sm text-muted-foreground">
                      {{
                        selectedSeason === "第一季"
                          ? "第 1–28 集"
                          : "第 29–38 集"
                      }}
                    </p>
                  </div>
                  <Tabs v-model="selectedSeason">
                    <TabsList>
                      <TabsTrigger value="第一季">第一季</TabsTrigger>
                      <TabsTrigger value="第二季">第二季</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>

                <ScrollArea class="w-full min-w-0 max-w-full whitespace-nowrap">
                  <div class="flex w-max gap-4 pb-4">
                    <Card
                      v-for="episode in episodes"
                      :key="`${selectedSeason}-${episode.number}`"
                      class="w-[280px] shrink-0 overflow-hidden pt-0"
                    >
                      <div
                        class="relative aspect-video bg-gradient-to-br from-stone-800 via-violet-900 to-violet-500"
                      >
                        <Button
                          size="icon"
                          class="absolute right-3 bottom-3 rounded-full"
                          :aria-label="`播放第 ${episode.number} 集`"
                        >
                          <Play />
                        </Button>
                      </div>
                      <CardHeader class="whitespace-normal">
                        <CardTitle class="text-base">
                          第 {{ episode.number }} 集 · {{ episode.title }}
                        </CardTitle>
                        <CardDescription class="line-clamp-2 leading-5">
                          {{ episode.description }}
                        </CardDescription>
                      </CardHeader>
                      <CardFooter>
                        <Button variant="ghost" class="px-0">
                          查看本集
                          <ArrowRight />
                        </Button>
                      </CardFooter>
                    </Card>
                  </div>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              </section>

              <section class="grid gap-4 lg:grid-cols-[1fr_360px]">
                <Card>
                  <CardHeader>
                    <CardTitle>相关内容</CardTitle>
                  </CardHeader>
                  <CardContent class="grid gap-3 sm:grid-cols-2">
                    <Button
                      variant="outline"
                      class="h-auto justify-start p-4 text-left"
                    >
                      <span class="grid gap-1">
                        <span class="font-medium">第一季</span>
                        <span class="text-xs text-muted-foreground">
                          28 集 · 2023–2024
                        </span>
                      </span>
                      <ChevronRight class="ml-auto" />
                    </Button>
                    <Button
                      variant="outline"
                      class="h-auto justify-start p-4 text-left"
                    >
                      <span class="grid gap-1">
                        <span class="font-medium">第二季</span>
                        <span class="text-xs text-muted-foreground">
                          10 集 · 2026
                        </span>
                      </span>
                      <ChevronRight class="ml-auto" />
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>文件信息</CardTitle>
                  </CardHeader>
                  <CardContent class="grid gap-3 text-sm">
                    <div class="flex items-center justify-between">
                      <span class="text-muted-foreground">视频</span>
                      <span>38 个文件</span>
                    </div>
                    <div class="flex items-center justify-between">
                      <span class="text-muted-foreground">格式</span>
                      <span>Matroska</span>
                    </div>
                    <Accordion type="single" collapsible>
                      <AccordionItem value="path" class="border-0">
                        <AccordionTrigger class="py-2">
                          显示文件位置
                        </AccordionTrigger>
                        <AccordionContent
                          class="break-all text-xs text-muted-foreground"
                        >
                          /opt/dev/digital/葬送的芙莉莲/
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </CardContent>
                </Card>
              </section>

              <footer
                class="flex items-center gap-2 border-t pt-5 text-xs text-muted-foreground"
              >
                <span>资料来源</span>
                <Button variant="link" size="sm" class="h-auto px-1" as-child>
                  <a
                    href="https://bangumi.tv/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Bangumi
                    <SquareArrowOutUpRight />
                  </a>
                </Button>
              </footer>
            </template>

            <template v-else>
              <section
                :class="[
                  'relative min-h-[360px] overflow-hidden rounded-3xl bg-gradient-to-br text-white shadow-xl',
                  selectedAsset.tone,
                ]"
              >
                <div class="absolute inset-0 bg-black/15" />
                <div class="relative flex min-h-[360px] items-end p-7 sm:p-10">
                  <div class="max-w-2xl">
                    <p class="text-sm text-white/75">
                      {{ selectedAsset.subtitle }} · {{ selectedAsset.year }}
                    </p>
                    <h1 class="mt-2 text-4xl font-semibold tracking-tight">
                      {{ selectedAsset.title }}
                    </h1>
                    <p class="mt-4 text-white/80">
                      {{ selectedAsset.summary }} ·
                      {{ selectedAsset.availability }}
                    </p>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button
                          variant="outline"
                          size="icon"
                          class="mt-6 border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                          aria-label="更多操作"
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem @select="emit('start-refresh')">
                          <RefreshCcw />
                          刷新元数据
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <RotateCcw />
                          重新刮削
                        </DropdownMenuItem>
                        <DropdownMenuItem @select="emit('navigate', 'export')">
                          <Waypoints />
                          整理与导出
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </section>
              <Card>
                <CardHeader>
                  <CardTitle>文件信息</CardTitle>
                </CardHeader>
                <CardContent class="flex items-center gap-3">
                  <File class="text-muted-foreground" />
                  <div>
                    <div class="font-medium">{{ selectedAsset.title }}</div>
                    <div class="text-sm text-muted-foreground">
                      {{ selectedAsset.availability }}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </template>
          </div>

          <!-- 添加内容 -->
          <div v-else-if="screen === 'drop'" class="grid gap-6">
            <section>
              <h1 class="text-3xl font-semibold tracking-tight">
                选择文件或文件夹
              </h1>
              <p class="mt-2 text-muted-foreground">
                系统不会移动或修改原文件。
              </p>
            </section>

            <div class="grid gap-6 xl:grid-cols-[1fr_380px]">
              <Card>
                <CardHeader>
                  <CardTitle>添加位置</CardTitle>
                  <CardDescription>
                    选择现有目录，或粘贴可以访问的本地路径。
                  </CardDescription>
                </CardHeader>
                <CardContent class="grid gap-5">
                  <div class="flex gap-2">
                    <Input v-model="folderPath" />
                    <Button variant="outline">
                      <FolderOpen />
                      选择
                    </Button>
                  </div>
                  <div class="rounded-2xl border bg-muted/30 p-4">
                    <div class="flex items-start gap-3">
                      <FolderInput class="mt-0.5 text-muted-foreground" />
                      <div class="min-w-0">
                        <div class="font-medium">新内容</div>
                        <div
                          class="mt-1 truncate text-sm text-muted-foreground"
                        >
                          {{ folderPath }}
                        </div>
                        <div class="mt-4 grid gap-2 text-sm">
                          <div class="flex items-center gap-2">
                            <File class="size-4" />
                            Movie | ひみつ.mkv
                          </div>
                          <div class="flex items-center gap-2">
                            <File class="size-4" />
                            cover.jpg
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div
                    class="flex items-center justify-between rounded-xl border p-4"
                  >
                    <div>
                      <div class="font-medium">添加后自动刮削</div>
                      <p class="mt-1 text-sm text-muted-foreground">
                        无法确定身份时会出现在“需要处理”。
                      </p>
                    </div>
                    <Switch :default-value="true" />
                  </div>
                </CardContent>
                <CardFooter class="justify-end">
                  <Button @click="emit('start-refresh')">
                    <Plus />
                    添加内容
                  </Button>
                </CardFooter>
              </Card>

              <Card class="h-fit">
                <CardHeader>
                  <CardTitle>将会发生什么</CardTitle>
                </CardHeader>
                <CardContent class="grid gap-4 text-sm">
                  <div class="flex gap-3">
                    <Check class="size-4 text-emerald-600" />
                    <span>检查选中的文件与文件夹</span>
                  </div>
                  <div class="flex gap-3">
                    <Check class="size-4 text-emerald-600" />
                    <span>尝试刮削尚未识别的内容</span>
                  </div>
                  <div class="flex gap-3">
                    <Check class="size-4 text-emerald-600" />
                    <span>把过程和结果保存在刷新记录中</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <!-- 刷新记录 -->
          <div v-else-if="screen === 'inspection'" class="grid gap-6">
            <section
              class="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"
            >
              <div>
                <h1 class="text-3xl font-semibold tracking-tight">正在刷新</h1>
                <p class="mt-2 text-muted-foreground">
                  由你手动开始 · 今天 02:18
                </p>
              </div>
              <Badge class="w-fit bg-emerald-600">
                <LoaderCircle class="animate-spin" />
                进行中
              </Badge>
            </section>

            <div class="grid gap-6 xl:grid-cols-[300px_1fr]">
              <Card class="h-fit">
                <CardHeader>
                  <CardTitle>刷新记录</CardTitle>
                </CardHeader>
                <CardContent class="grid gap-2">
                  <Button
                    variant="secondary"
                    class="h-auto justify-start p-3 text-left"
                  >
                    <span class="grid gap-1">
                      <span class="font-medium">正在刷新元数据</span>
                      <span class="text-xs text-muted-foreground">
                        今天 02:18 · 进行中
                      </span>
                    </span>
                  </Button>
                  <Button
                    variant="ghost"
                    class="h-auto justify-start p-3 text-left"
                  >
                    <span class="grid gap-1">
                      <span class="font-medium">自动刷新完成</span>
                      <span class="text-xs text-muted-foreground">
                        昨天 18:00 · 没有发现更新
                      </span>
                    </span>
                  </Button>
                  <Button
                    variant="ghost"
                    class="h-auto justify-start p-3 text-left"
                  >
                    <span class="grid gap-1">
                      <span class="font-medium">添加内容</span>
                      <span class="text-xs text-muted-foreground">
                        7 月 27 日 · 新增 7 项
                      </span>
                    </span>
                  </Button>
                </CardContent>
              </Card>

              <div class="grid gap-5">
                <Card>
                  <CardHeader>
                    <CardTitle>刷新进度</CardTitle>
                    <CardDescription>
                      已完成 3 个步骤，正在更新在线资料。
                    </CardDescription>
                  </CardHeader>
                  <CardContent class="grid gap-5">
                    <Progress :model-value="64" />
                    <div class="grid gap-2 sm:grid-cols-4">
                      <div class="rounded-xl bg-muted p-3">
                        <div class="text-xs text-muted-foreground">新增</div>
                        <div class="mt-1 text-2xl font-semibold">7</div>
                      </div>
                      <div class="rounded-xl bg-muted p-3">
                        <div class="text-xs text-muted-foreground">更新</div>
                        <div class="mt-1 text-2xl font-semibold">2</div>
                      </div>
                      <div class="rounded-xl bg-muted p-3">
                        <div class="text-xs text-muted-foreground">未变化</div>
                        <div class="mt-1 text-2xl font-semibold">17</div>
                      </div>
                      <div class="rounded-xl bg-amber-50 p-3">
                        <div class="text-xs text-amber-700">需要处理</div>
                        <div class="mt-1 text-2xl font-semibold">1</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>当前步骤</CardTitle>
                  </CardHeader>
                  <CardContent class="grid gap-1">
                    <div
                      v-for="item in refreshWorkItems"
                      :key="item.title"
                      class="grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-xl px-3 py-4"
                    >
                      <CircleCheck
                        v-if="item.state === '已完成'"
                        class="mt-0.5 size-5 text-emerald-600"
                      />
                      <LoaderCircle
                        v-else-if="item.state === '进行中'"
                        class="mt-0.5 size-5 animate-spin text-sky-600"
                      />
                      <CircleDashed
                        v-else
                        class="mt-0.5 size-5 text-muted-foreground"
                      />
                      <div>
                        <div class="font-medium">{{ item.title }}</div>
                        <div class="mt-1 text-sm text-muted-foreground">
                          {{ item.detail }}
                        </div>
                      </div>
                      <span class="text-xs text-muted-foreground">
                        {{ item.outcome }}
                      </span>
                    </div>
                  </CardContent>
                </Card>

                <Accordion type="single" collapsible>
                  <AccordionItem
                    value="technical"
                    class="rounded-xl border px-4"
                  >
                    <AccordionTrigger>技术详情</AccordionTrigger>
                    <AccordionContent>
                      <Table>
                        <TableBody>
                          <TableRow>
                            <TableCell class="text-muted-foreground">
                              记录编号
                            </TableCell>
                            <TableCell>#0842</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell class="text-muted-foreground">
                              文件快照
                            </TableCell>
                            <TableCell>#310 · 1,014 个文件</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell class="text-muted-foreground">
                              匹配插件
                            </TableCell>
                            <TableCell>
                              DLsite 1.2 · FANBOX 0.4 · Bangumi 0.7
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </div>
          </div>

          <!-- 需要处理 -->
          <div v-else-if="screen === 'attention'" class="grid gap-6">
            <section
              class="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"
            >
              <div>
                <h1 class="text-3xl font-semibold tracking-tight">需要处理</h1>
                <p class="mt-2 text-muted-foreground">
                  比较证据、修改处理方式并预览结果。
                </p>
              </div>
              <Badge
                :variant="state.attentionResolved ? 'secondary' : 'destructive'"
              >
                {{ state.attentionResolved ? "0 项" : "3 项" }}
              </Badge>
            </section>

            <Alert
              v-if="state.attentionResolved"
              class="border-emerald-200 bg-emerald-50"
            >
              <CircleCheck class="text-emerald-700" />
              <AlertTitle>当前没有需要处理的问题</AlertTitle>
              <AlertDescription>
                刚才的修改已经应用，相关内容也已重新检查。
              </AlertDescription>
            </Alert>

            <div
              v-else
              class="grid min-h-[680px] gap-4 xl:grid-cols-[300px_1fr_360px]"
            >
              <Card class="h-fit">
                <CardHeader>
                  <CardTitle>当前问题</CardTitle>
                </CardHeader>
                <CardContent class="grid gap-2">
                  <Button
                    v-for="item in attentionItems"
                    :key="item.id"
                    :variant="
                      selectedAttention === item.id ? 'secondary' : 'ghost'
                    "
                    class="h-auto justify-start gap-3 p-3 text-left"
                    @click="selectedAttention = item.id"
                  >
                    <CircleAlert class="shrink-0 text-amber-600" />
                    <span class="min-w-0 grid gap-1">
                      <span class="line-clamp-2 font-medium">
                        {{ item.title }}
                      </span>
                      <span class="truncate text-xs text-muted-foreground">
                        {{ item.scope }}
                      </span>
                    </span>
                  </Button>
                </CardContent>
              </Card>

              <div class="grid content-start gap-4">
                <Card class="border-red-200 bg-red-50/40">
                  <CardHeader>
                    <Badge variant="destructive" class="mb-2 w-fit">
                      无法自动继续
                    </Badge>
                    <CardTitle>两个匹配规则给出了不同结果</CardTitle>
                    <CardDescription>
                      Boku no Risou no Isekai Seikatsu - 04
                    </CardDescription>
                  </CardHeader>
                  <CardContent class="grid gap-4">
                    <div class="rounded-xl border bg-background p-4">
                      <div class="font-medium">当前文件</div>
                      <div class="mt-2 break-all text-sm text-muted-foreground">
                        /opt/dev/digital/Boku no Risou no Isekai Seikatsu - 04/
                      </div>
                      <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
                        <div class="rounded-lg bg-muted p-3">
                          <div class="text-xs text-muted-foreground">文件</div>
                          <div class="mt-1 font-medium">18 个</div>
                        </div>
                        <div class="rounded-lg bg-muted p-3">
                          <div class="text-xs text-muted-foreground">大小</div>
                          <div class="mt-1 font-medium">2.8 GB</div>
                        </div>
                      </div>
                    </div>

                    <div class="grid gap-3 md:grid-cols-2">
                      <Card class="border-2 border-primary">
                        <CardHeader>
                          <Badge class="mb-2 w-fit">建议使用</Badge>
                          <CardTitle class="text-base">
                            候选结果 782943
                          </CardTitle>
                          <CardDescription>
                            标题、集数和目录结构一致
                          </CardDescription>
                        </CardHeader>
                        <CardContent
                          class="aspect-video rounded-xl bg-gradient-to-br from-violet-950 to-violet-500"
                        />
                      </Card>
                      <Card>
                        <CardHeader>
                          <Badge variant="outline" class="mb-2 w-fit">
                            另一个结果
                          </Badge>
                          <CardTitle class="text-base">
                            候选结果 794221
                          </CardTitle>
                          <CardDescription>
                            标题近似，但集数不同
                          </CardDescription>
                        </CardHeader>
                        <CardContent
                          class="aspect-video rounded-xl bg-gradient-to-br from-stone-950 to-stone-500"
                        />
                      </Card>
                    </div>

                    <Card class="border-violet-200 bg-violet-50/40">
                      <CardHeader>
                        <CardTitle class="text-base">预览更改</CardTitle>
                        <CardDescription>
                          使用候选结果 782943，并重新检查另外 4 项受影响内容。
                        </CardDescription>
                      </CardHeader>
                      <CardContent class="grid grid-cols-3 gap-2 text-center">
                        <div class="rounded-lg bg-background p-3">
                          <div class="text-2xl font-semibold">1</div>
                          <div class="text-xs text-muted-foreground">
                            使用新结果
                          </div>
                        </div>
                        <div class="rounded-lg bg-background p-3">
                          <div class="text-2xl font-semibold">4</div>
                          <div class="text-xs text-muted-foreground">
                            重新检查
                          </div>
                        </div>
                        <div class="rounded-lg bg-background p-3">
                          <div class="text-2xl font-semibold">0</div>
                          <div class="text-xs text-muted-foreground">
                            新问题
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </CardContent>
                </Card>
              </div>

              <div class="grid content-start gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle>匹配依据</CardTitle>
                  </CardHeader>
                  <CardContent class="grid gap-3 text-sm">
                    <div class="rounded-xl border p-3">
                      <div class="font-medium">文件名与目录</div>
                      <p class="mt-1 text-muted-foreground">
                        标题和第 4 卷编号与候选结果 782943 一致。
                      </p>
                    </div>
                    <div class="rounded-xl border p-3">
                      <div class="font-medium">匹配规则</div>
                      <p class="mt-1 text-muted-foreground">
                        目录名称匹配 · 版本 0.4
                      </p>
                    </div>
                    <div class="rounded-xl border p-3">
                      <div class="font-medium">另一个匹配规则</div>
                      <p class="mt-1 text-muted-foreground">
                        组合名称匹配 · 版本 0.7
                      </p>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>处理方式</CardTitle>
                  </CardHeader>
                  <CardContent class="grid gap-3">
                    <RadioGroup default-value="use">
                      <label class="flex gap-3 rounded-xl border p-3">
                        <RadioGroupItem value="use" />
                        <span>
                          <span class="block font-medium">
                            使用候选结果 782943
                          </span>
                          <span
                            class="mt-1 block text-xs text-muted-foreground"
                          >
                            以后仍允许匹配规则自动处理其他内容
                          </span>
                        </span>
                      </label>
                      <label class="flex gap-3 rounded-xl border p-3">
                        <RadioGroupItem value="exclude" />
                        <span>
                          <span class="block font-medium">
                            使用此结果，并停用自动采用
                          </span>
                          <span
                            class="mt-1 block text-xs text-muted-foreground"
                          >
                            此匹配规则以后仍会提供候选结果，但需要检查
                          </span>
                        </span>
                      </label>
                    </RadioGroup>
                    <AlertDialog>
                      <AlertDialogTrigger as-child>
                        <Button class="w-full">
                          <Check />
                          本次使用这个结果
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle
                            >应用这个刮削结果？</AlertDialogTitle
                          >
                          <AlertDialogDescription>
                            系统会再次确认相关文件没有变化，然后重新检查另外 4
                            项内容。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>继续比较</AlertDialogCancel>
                          <AlertDialogAction
                            @click="
                              emit('update-state', {
                                attentionResolved: true,
                              })
                            "
                          >
                            确认使用
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </CardContent>
                </Card>

                <Accordion type="single" collapsible>
                  <AccordionItem
                    value="technical"
                    class="rounded-xl border px-4"
                  >
                    <AccordionTrigger>技术详情</AccordionTrigger>
                    <AccordionContent class="grid gap-2 text-xs">
                      <div>问题编号：recognition-conflict-194</div>
                      <div>插件：目录识别 0.7.0</div>
                      <div>诊断标识：rule-result:794221:5</div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </div>
          </div>

          <!-- 自动刷新 -->
          <div v-else-if="screen === 'automation'" class="grid gap-6">
            <section
              class="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"
            >
              <div>
                <h1 class="text-3xl font-semibold tracking-tight">自动刷新</h1>
                <p class="mt-2 text-muted-foreground">
                  定期检查已有目录中的新增和更新内容。
                </p>
              </div>
              <Button @click="emit('start-refresh')">
                <RefreshCcw />
                立即刷新
              </Button>
            </section>

            <div class="grid gap-6 xl:grid-cols-[1fr_360px]">
              <Card>
                <CardHeader>
                  <CardTitle>本地内容</CardTitle>
                  <CardDescription>/opt/dev/digital</CardDescription>
                  <CardAction>
                    <Switch
                      :model-value="state.automationEnabled"
                      @update:model-value="
                        emit('update-state', { automationEnabled: $event })
                      "
                    />
                  </CardAction>
                </CardHeader>
                <CardContent class="grid gap-5">
                  <div class="grid gap-2">
                    <label class="text-sm font-medium">刷新间隔</label>
                    <Select default-value="6">
                      <SelectTrigger>
                        <SelectValue placeholder="选择刷新间隔" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="3">每 3 小时</SelectItem>
                        <SelectItem value="6">每 6 小时</SelectItem>
                        <SelectItem value="12">每 12 小时</SelectItem>
                        <SelectItem value="24">每天</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div
                    class="flex items-center justify-between rounded-xl border p-4"
                  >
                    <div>
                      <div class="font-medium">自动刮削新增内容</div>
                      <p class="mt-1 text-sm text-muted-foreground">
                        无法确定身份时进入“需要处理”。
                      </p>
                    </div>
                    <Switch
                      :model-value="state.automaticRecognition"
                      @update:model-value="
                        emit('update-state', {
                          automaticRecognition: $event,
                        })
                      "
                    />
                  </div>
                  <Alert>
                    <Clock3 />
                    <AlertTitle>下次刷新：今天 18:00</AlertTitle>
                    <AlertDescription>
                      当前刷新结束前，不会同时启动另一轮。
                    </AlertDescription>
                  </Alert>
                </CardContent>
              </Card>

              <Card class="h-fit">
                <CardHeader>
                  <CardTitle>最近刷新</CardTitle>
                </CardHeader>
                <CardContent class="grid gap-3">
                  <div class="rounded-xl bg-muted p-4">
                    <div class="font-medium">正在刷新元数据</div>
                    <div class="mt-1 text-sm text-muted-foreground">
                      已完成 64%
                    </div>
                    <Progress :model-value="64" class="mt-3" />
                  </div>
                  <Button
                    variant="outline"
                    @click="emit('navigate', 'inspection')"
                  >
                    查看刷新记录
                    <ArrowRight />
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>

          <!-- 整理与导出 -->
          <div v-else-if="screen === 'export'" class="grid gap-6">
            <section>
              <h1 class="text-3xl font-semibold tracking-tight">整理与导出</h1>
              <p class="mt-2 text-muted-foreground">
                创建适合其他应用使用的目录，原文件不会被移动或修改。
              </p>
            </section>

            <div class="grid gap-6 xl:grid-cols-[380px_1fr]">
              <Card class="h-fit">
                <CardHeader>
                  <CardTitle>导出设置</CardTitle>
                </CardHeader>
                <CardContent class="grid gap-5">
                  <div class="grid gap-2">
                    <label class="text-sm font-medium">目录结构</label>
                    <Select default-value="portable">
                      <SelectTrigger>
                        <SelectValue placeholder="选择目录结构" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="portable">便携目录</SelectItem>
                        <SelectItem value="emby">Emby 兼容目录</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="grid gap-2">
                    <label class="text-sm font-medium" for="export-path">
                      保存位置
                    </label>
                    <Input
                      id="export-path"
                      model-value="/opt/dev/digital-export"
                    />
                  </div>
                  <div class="grid gap-2">
                    <label class="text-sm font-medium">文件处理方式</label>
                    <Select v-model="exportStrategy">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="硬链接">硬链接</SelectItem>
                        <SelectItem value="软链接">软链接</SelectItem>
                        <SelectItem value="复制">复制</SelectItem>
                      </SelectContent>
                    </Select>
                    <p class="text-xs text-muted-foreground">
                      当前选择：{{ exportStrategy }}
                    </p>
                  </div>
                  <div class="flex items-start gap-3 rounded-xl border p-3">
                    <Checkbox :default-value="true" />
                    <span class="text-sm">
                      同时生成一份可供本产品重新读取的内容清单
                    </span>
                  </div>
                  <Button
                    class="w-full"
                    @click="emit('update-state', { exportPlanned: true })"
                  >
                    <Eye />
                    预览更改
                  </Button>
                </CardContent>
              </Card>

              <div class="grid content-start gap-5">
                <Card v-if="state.exportPlanned">
                  <CardHeader>
                    <CardTitle>导出预览</CardTitle>
                    <CardDescription>
                      101 个链接 · 1 份内容清单
                    </CardDescription>
                  </CardHeader>
                  <CardContent class="grid gap-5">
                    <div
                      class="rounded-2xl bg-zinc-950 p-5 font-mono text-xs text-zinc-300"
                    >
                      <div class="text-zinc-500">/opt/dev/digital-export/</div>
                      <div class="mt-2">├── 恐怖直播 (2013)/恐怖直播.mkv</div>
                      <div>├── 葬送的芙莉莲/第一季/第 01 集.mkv</div>
                      <div>├── 葬送的芙莉莲/第二季/第 01 集.mkv</div>
                      <div>├── 妹妹人生/01 - 上.epub</div>
                      <div>└── 内容清单.json</div>
                    </div>
                    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div class="rounded-xl bg-emerald-50 p-3">
                        <div class="text-xs text-emerald-700">保持不变</div>
                        <div class="mt-1 text-2xl font-semibold">93</div>
                      </div>
                      <div class="rounded-xl bg-sky-50 p-3">
                        <div class="text-xs text-sky-700">调整格式</div>
                        <div class="mt-1 text-2xl font-semibold">3</div>
                      </div>
                      <div class="rounded-xl bg-amber-50 p-3">
                        <div class="text-xs text-amber-700">不会导出</div>
                        <div class="mt-1 text-2xl font-semibold">2</div>
                      </div>
                      <div class="rounded-xl bg-red-50 p-3">
                        <div class="text-xs text-red-700">无法继续</div>
                        <div class="mt-1 text-2xl font-semibold">0</div>
                      </div>
                    </div>
                    <Accordion type="single" collapsible>
                      <AccordionItem value="omissions">
                        <AccordionTrigger>查看不会导出的内容</AccordionTrigger>
                        <AccordionContent class="grid gap-2 text-sm">
                          <div class="rounded-lg bg-muted p-3">
                            电影评分不会写入当前目录格式。
                          </div>
                          <div class="rounded-lg bg-muted p-3">
                            蓝光菜单结构会记录在内容清单中。
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </CardContent>
                  <CardFooter class="justify-end">
                    <AlertDialog>
                      <AlertDialogTrigger as-child>
                        <Button :disabled="state.exportApplied">
                          <Waypoints />
                          {{ state.exportApplied ? "导出已开始" : "开始导出" }}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>开始导出？</AlertDialogTitle>
                          <AlertDialogDescription>
                            文件只会写入所选保存位置，原文件不会被移动或修改。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>继续检查</AlertDialogCancel>
                          <AlertDialogAction
                            @click="
                              emit('update-state', { exportApplied: true })
                            "
                          >
                            开始导出
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </CardFooter>
                </Card>

                <Card v-else class="border-dashed">
                  <CardContent
                    class="grid place-items-center gap-3 py-20 text-center"
                  >
                    <Waypoints class="size-7 text-muted-foreground" />
                    <div>
                      <div class="font-medium">尚未生成预览</div>
                      <p class="mt-1 text-sm text-muted-foreground">
                        选择导出设置后预览目录和不会导出的内容。
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>

          <!-- 设置 -->
          <div v-else class="grid gap-6">
            <section>
              <h1 class="text-3xl font-semibold tracking-tight">设置</h1>
              <p class="mt-2 text-muted-foreground">
                调整显示、自动刮削和本地文件相关选项。
              </p>
            </section>

            <Tabs default-value="display" class="gap-5">
              <TabsList class="w-full justify-start overflow-x-auto">
                <TabsTrigger value="display">显示语言</TabsTrigger>
                <TabsTrigger value="scraping">自动刮削</TabsTrigger>
                <TabsTrigger value="files">文件与存储</TabsTrigger>
              </TabsList>

              <TabsContent value="display">
                <Card>
                  <CardHeader>
                    <CardTitle>显示语言</CardTitle>
                    <CardDescription>
                      有多种可用名称时，优先使用更靠前的语言。
                    </CardDescription>
                  </CardHeader>
                  <CardContent class="grid max-w-xl gap-2">
                    <div
                      v-for="(language, index) in [
                        '简体中文',
                        '繁體中文',
                        '原始语言',
                        '英语',
                      ]"
                      :key="language"
                      class="flex items-center gap-3 rounded-xl border p-3"
                    >
                      <div
                        class="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold"
                      >
                        {{ index + 1 }}
                      </div>
                      <Languages class="size-4 text-muted-foreground" />
                      <span class="font-medium">{{ language }}</span>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="scraping">
                <Card>
                  <CardHeader>
                    <CardTitle>自动刮削</CardTitle>
                    <CardDescription>
                      只有经过产品验证的匹配规则才能自动使用结果。
                    </CardDescription>
                    <CardAction>
                      <Switch
                        :model-value="state.automaticRecognition"
                        @update:model-value="
                          emit('update-state', {
                            automaticRecognition: $event,
                          })
                        "
                      />
                    </CardAction>
                  </CardHeader>
                  <CardContent class="grid gap-3">
                    <div
                      v-for="rule in [
                        ['DLsite', '作品编号匹配', '版本 1.2'],
                        ['FANBOX', '创作者与发布日期匹配', '版本 0.4'],
                        ['电影刮削', '标题与年份匹配', '版本 0.7'],
                      ]"
                      :key="rule[0]"
                      class="grid gap-3 rounded-xl border p-4 sm:grid-cols-[1fr_auto] sm:items-center"
                    >
                      <div>
                        <div class="font-medium">{{ rule[0] }}</div>
                        <div class="mt-1 text-sm text-muted-foreground">
                          {{ rule[1] }} · {{ rule[2] }}
                        </div>
                      </div>
                      <Switch :default-value="true" />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="files">
                <Card>
                  <CardHeader>
                    <CardTitle>文件与存储</CardTitle>
                    <CardDescription>
                      原文件始终保持不变，下载的封面和其他辅助文件保存在产品管理的位置。
                    </CardDescription>
                  </CardHeader>
                  <CardContent class="grid max-w-2xl gap-5">
                    <div class="grid gap-2">
                      <label class="text-sm font-medium">辅助文件位置</label>
                      <Input model-value="/opt/dev/digital-managed" />
                    </div>
                    <div
                      class="flex items-center justify-between rounded-xl border p-4"
                    >
                      <div>
                        <div class="font-medium">保留下载历史</div>
                        <p class="mt-1 text-sm text-muted-foreground">
                          更新图片时保留之前使用过的版本。
                        </p>
                      </div>
                      <Switch :default-value="true" />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        </main>
      </ScrollArea>
    </SidebarInset>
  </SidebarProvider>
</template>
