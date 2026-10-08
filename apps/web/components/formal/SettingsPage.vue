<script setup lang="ts">
import {
  requestSettings,
  sendAction,
  type SettingsSnapshot,
} from "@digital/web-delivery/client";
import {
  Folder,
  Link,
  RefreshCw,
  ShieldCheck,
  Plus,
  LoaderCircle,
} from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";

import "vue-sonner/style.css";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { Switch } from "#/components/ui/switch";
import { useLibraryNavigation } from "#/composables/use-library-navigation";

import AutomationSettingsDialog from "./AutomationSettingsDialog.vue";
import LibrarySettingsDialog from "./LibrarySettingsDialog.vue";
import SourceConnectionDialog from "./SourceConnectionDialog.vue";
const sections = [
  { id: "libraries", label: "资产库", icon: Folder },
  { id: "sources", label: "来源连接", icon: Link },
  { id: "automation", label: "自动刷新", icon: RefreshCw },
  { id: "storage", label: "产品数据", icon: ShieldCheck },
];
const section = ref("libraries");
const data = ref<SettingsSnapshot>();
const libraryNavigation = useLibraryNavigation();
const loading = ref(true);
const error = ref("");
const pending = ref(new Set<string>());
const libraryDialog = ref<{
  library?: SettingsSnapshot["libraries"][number];
}>();
const sourceDialog = ref<{
  source: string;
  connection?: SettingsSnapshot["sources"][number];
  revoke?: boolean;
}>();
const planDialog = ref<{ plan?: SettingsSnapshot["automation"][number] }>();
const names: Record<string, string> = {
  tmdb: "TMDB",
  omdb: "OMDb",
  fanbox: "FANBOX",
  bangumi: "Bangumi",
};
const descriptions: Record<string, string> = {
  tmdb: "影片与剧集资料",
  omdb: "影片评分与补充资料",
  fanbox: "创作者帖子与附件",
  bangumi: "动画与分集资料",
};
const sources = computed(() => data.value?.sources ?? []);
function sourceName(id: string) {
  const [name, creator] = id.split("/");
  return `${names[name!] ?? name}${creator ? ` · ${creator}` : ""}`;
}
function status(source: SettingsSnapshot["sources"][number]) {
  if (source.credentialStatus === "revoked") return "已断开";
  if (source.credentialStatus === "unconfigured") return "未连接";
  if (source.availability === "available") return "已连接";
  return source.reason === "authorization-failed"
    ? "需要重新登录"
    : "连接不可用";
}
async function reload() {
  error.value = "";
  try {
    data.value = await requestSettings();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法读取设置";
  } finally {
    loading.value = false;
  }
}
onMounted(async () => {
  const url = new URL(window.location.href);
  const authorization = url.searchParams.get("authorization");
  if (authorization) {
    section.value = "sources";
    if (authorization === "complete") toast.success("Bangumi 已连接");
    else toast.error("Bangumi 授权未完成，请重试");
    url.searchParams.delete("authorization");
    window.history.replaceState(window.history.state, "", url);
  }
  await reload();
});
async function perform(
  key: string,
  action: () => Promise<unknown>,
  success: string,
) {
  if (pending.value.has(key)) return;
  pending.value.add(key);
  try {
    await action();
    toast.success(success);
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : "操作未完成");
  } finally {
    await reload();
    pending.value.delete(key);
  }
}
function saved() {
  libraryDialog.value = undefined;
  sourceDialog.value = undefined;
  planDialog.value = undefined;
  void reload();
}
async function librarySaved() {
  libraryDialog.value = undefined;
  await libraryNavigation.refresh();
  await reload();
}
async function removeLibrary(library: SettingsSnapshot["libraries"][number]) {
  await perform(
    library.id,
    async () => {
      await sendAction("/api/settings/libraries", {
        action: "remove",
        id: library.id,
        expectedVersion: library.configVersion,
      });
      await libraryNavigation.refresh();
    },
    "资产库已移除，内容与历史记录已保留",
  );
}
async function scanLibrary(library: SettingsSnapshot["libraries"][number]) {
  await perform(
    library.id,
    () =>
      sendAction("/api/refresh", {
        assetLibraryId: library.id,
        acceptTrusted: true,
      }),
    "已开始扫描资产库",
  );
}
type SettingsDirectory =
  SettingsSnapshot["libraries"][number]["directoryViews"][number];
async function reconnectDirectory(
  library: SettingsSnapshot["libraries"][number],
  directory: SettingsDirectory,
) {
  await perform(
    directory.directoryId,
    () =>
      sendAction("/api/settings/libraries", {
        action: "reconnect",
        id: library.id,
        directoryId: directory.directoryId,
      }),
    "目录已重新连接，等待下一次扫描确认文件",
  );
}
function planDirectory(plan: SettingsSnapshot["automation"][number]) {
  return data.value?.libraries
    .find((library) => library.id === plan.assetLibraryId)
    ?.directoryViews.find(
      (directory) => directory.observedRootId === plan.observedRootId,
    );
}
async function verify(source: SettingsSnapshot["sources"][number]) {
  await perform(
    source.id,
    async () => {
      const result = await sendAction<SettingsSnapshot["sources"][number]>(
        "/api/settings/connections",
        {
          source: source.id.split("/")[0],
          creatorId: source.id.split("/")[1],
          action: "verify",
        },
      );
      if (result.availability !== "available")
        throw new Error(`${sourceName(source.id)} 暂时无法连接`);
    },
    `${sourceName(source.id)} 连接正常`,
  );
}
function intervalLabel(milliseconds: number) {
  return milliseconds === 86400000
    ? "每天"
    : milliseconds === 3600000
      ? "每小时"
      : `每 ${milliseconds / 60000} 分钟`;
}
async function togglePlan(
  plan: SettingsSnapshot["automation"][number],
  enabled: boolean,
) {
  await perform(
    plan.id,
    () =>
      sendAction(
        "/api/automation",
        enabled
          ? {
              action: "enable",
              assetLibraryId: plan.assetLibraryId,
              observedRootId: plan.observedRootId,
              relativeScope: plan.relativeScope,
              intervalMilliseconds: plan.intervalMilliseconds,
              acceptTrusted: plan.acceptTrusted,
            }
          : { action: "disable", intentId: plan.id },
      ),
    enabled ? "已启用自动刷新" : "已停止后续自动刷新；正在进行的处理不会取消。",
  );
}
async function checkNow(plan: SettingsSnapshot["automation"][number]) {
  pending.value.add(plan.id);
  try {
    const result = await sendAction<{
      status: string;
      execution?: { id: string };
    }>("/api/automation", { action: "scan-now", intentId: plan.id });
    if (result.status === "skipped")
      toast.info("本次触发已跳过：当前仍有处理进行中。");
    else if (result.execution)
      toast.success("已开始刷新", {
        action: {
          label: "查看刷新记录",
          onClick: () =>
            window.location.assign(
              `/inspection?record=${encodeURIComponent(result.execution!.id)}`,
            ),
        },
      });
    else toast.info("计划已停用，未开始检查");
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : "无法开始检查");
  } finally {
    await reload();
    pending.value.delete(plan.id);
  }
}
</script>
<template>
  <section class="pb-12">
    <Toaster />
    <header class="mb-5">
      <h1 class="text-2xl font-semibold tracking-tight">设置</h1>
    </header>
    <div class="grid gap-4 lg:grid-cols-[144px_minmax(0,1fr)] lg:gap-6">
      <nav class="flex gap-1 overflow-x-auto lg:flex-col" aria-label="设置分类">
        <Button
          v-for="item in sections"
          :key="item.id"
          :variant="section === item.id ? 'secondary' : 'ghost'"
          :disabled="loading"
          class="h-9 shrink-0 justify-start gap-2 px-3"
          @click="section = item.id"
          ><component :is="item.icon" class="size-4" />{{ item.label }}</Button
        >
      </nav>
      <div class="min-w-0">
        <div class="mb-3 flex items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ sections.find((item) => item.id === section)?.label }}
          </h2>
          <Button
            v-if="section === 'libraries' && data"
            size="sm"
            @click="libraryDialog = {}"
            ><Plus class="size-4" />添加资产库</Button
          ><Button
            v-if="
              section === 'automation' &&
              data?.libraries.some((library) =>
                library.directoryViews.some(
                  (directory) => directory.status === 'active',
                ),
              )
            "
            size="sm"
            @click="planDialog = {}"
            ><Plus class="size-4" />添加计划</Button
          ><Button
            v-if="section === 'sources' && data"
            size="sm"
            @click="sourceDialog = { source: 'fanbox' }"
            ><Plus class="size-4" />连接 FANBOX 创作者</Button
          >
        </div>
        <p
          v-if="loading"
          class="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle class="size-4 animate-spin" />正在读取设置
        </p>
        <div v-if="error" role="alert" class="mb-3 text-sm text-destructive">
          {{ error
          }}<Button variant="ghost" size="sm" @click="reload">重试</Button>
        </div>
        <template v-if="data">
          <template v-if="section === 'libraries'">
            <div
              v-if="!data.libraries.length"
              class="rounded-lg border border-dashed p-6 text-center"
            >
              <p>创建资产库，读取你整理好的内容</p>
              <Button class="mt-4" @click="libraryDialog = {}"
                >添加资产库</Button
              >
            </div>
            <div
              v-for="library in data.libraries"
              :key="library.id"
              class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-3"
            >
              <Folder class="size-5 shrink-0 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <a
                  :href="`/?library=${encodeURIComponent(library.id)}`"
                  class="font-medium hover:underline"
                  >{{ library.displayName }}</a
                >
                <div
                  v-for="directory in library.directoryViews"
                  :key="directory.directoryId"
                  class="mt-1 flex flex-wrap items-center gap-x-2"
                >
                  <p class="break-all text-sm text-muted-foreground">
                    {{ directory.containerPath }}
                  </p>
                  <template v-if="directory.status === 'removed'">
                    <span class="text-sm text-destructive">{{
                      directory.problem ?? "已从资产库移除，等待重新连接"
                    }}</span>
                    <Button
                      variant="link"
                      size="sm"
                      class="h-auto p-0"
                      :disabled="pending.has(directory.directoryId)"
                      @click="reconnectDirectory(library, directory)"
                      >重新连接</Button
                    >
                  </template>
                  <p
                    v-else-if="!directory.reachable"
                    role="alert"
                    class="text-sm text-destructive"
                  >
                    {{ directory.problem ?? "目录当前不可访问" }}
                  </p>
                </div>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{
                    data.recognitionProfiles
                      .filter((profile) =>
                        library.recognitionProfileIds.includes(profile.id),
                      )
                      .map((profile) => profile.displayName)
                      .join("、")
                  }}
                </p>
              </div>
              <div class="flex flex-wrap gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  :disabled="pending.has(library.id)"
                  @click="libraryDialog = { library }"
                  >编辑</Button
                ><Button
                  variant="outline"
                  size="sm"
                  :disabled="pending.has(library.id)"
                  @click="scanLibrary(library)"
                  >扫描</Button
                ><Button
                  variant="ghost"
                  size="sm"
                  :disabled="pending.has(library.id)"
                  @click="removeLibrary(library)"
                  >移除</Button
                >
              </div>
            </div>
          </template>
          <template v-else-if="section === 'sources'">
            <div
              v-for="source in sources"
              :key="source.id"
              class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3 first:pt-0"
            >
              <div class="min-w-[180px] flex-1">
                <h3 class="font-medium">{{ sourceName(source.id) }}</h3>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ descriptions[source.id.split("/")[0]!] }}
                </p>
              </div>
              <span
                class="text-sm"
                :class="
                  source.credentialStatus === 'configured' &&
                  source.availability !== 'available'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                "
                >{{
                  pending.has(source.id) ? "正在验证" : status(source)
                }}</span
              >
              <div class="flex flex-wrap gap-1">
                <Button
                  v-if="source.credentialStatus === 'configured'"
                  variant="outline"
                  size="sm"
                  :disabled="pending.has(source.id)"
                  @click="verify(source)"
                  >验证连接</Button
                ><Button
                  variant="ghost"
                  size="sm"
                  :disabled="pending.has(source.id)"
                  @click="
                    sourceDialog = {
                      source: source.id.split('/')[0]!,
                      connection: source,
                    }
                  "
                  >{{
                    source.credentialStatus === "configured"
                      ? ["tmdb", "omdb"].includes(source.id)
                        ? "更换密钥"
                        : "重新登录"
                      : "连接"
                  }}</Button
                ><Button
                  v-if="source.credentialStatus === 'configured'"
                  variant="ghost"
                  size="sm"
                  :disabled="pending.has(source.id)"
                  @click="
                    sourceDialog = {
                      source: source.id.split('/')[0]!,
                      connection: source,
                      revoke: true,
                    }
                  "
                  >断开</Button
                >
              </div>
            </div>
          </template>
          <template v-else-if="section === 'automation'">
            <ul
              v-if="data.recovery.length"
              class="mb-4 grid gap-2 rounded-lg bg-stone-50 p-3"
            >
              <li
                v-for="(item, index) in data.recovery"
                :key="`recovery-${index}`"
                class="text-sm"
              >
                <span class="font-medium">{{ item.subject }}</span>
                · {{ item.status }}
                <template v-if="item.reason">：{{ item.reason }}</template>
                <template v-if="item.nextAction">
                  {{ item.nextAction }}</template
                >
              </li>
            </ul>
            <p
              v-if="!data.automation.length"
              class="text-sm text-muted-foreground"
            >
              还没有自动刷新计划。
            </p>
            <div
              v-for="plan in data.automation"
              :key="plan.id"
              class="mb-2 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-3"
            >
              <div class="min-w-0 flex-1">
                <h3 class="font-medium">{{ plan.folder }}</h3>
                <p class="mt-1 break-all text-sm text-muted-foreground">
                  {{
                    plan.relativeScope === "."
                      ? "整个目录"
                      : `目录内的 ${plan.relativeScope}`
                  }}
                  · {{ intervalLabel(plan.intervalMilliseconds) }}
                  ·
                  {{
                    plan.enabled ? "启用中" : (plan.disabledReason ?? "已停用")
                  }}
                </p>
              </div>
              <Switch
                :aria-label="`${plan.folder}自动刷新`"
                :model-value="plan.enabled"
                :disabled="
                  pending.has(plan.id) ||
                  planDirectory(plan)?.status !== 'active'
                "
                @update:model-value="togglePlan(plan, $event)"
              />
              <Button
                variant="outline"
                size="sm"
                :disabled="
                  pending.has(plan.id) ||
                  planDirectory(plan)?.status !== 'active'
                "
                @click="planDialog = { plan }"
                >调整计划</Button
              ><Button
                variant="ghost"
                size="sm"
                :disabled="pending.has(plan.id) || !plan.enabled"
                @click="checkNow(plan)"
                >立即检查</Button
              >
            </div>
          </template>
          <div v-else class="rounded-lg border p-4">
            <h3 class="font-medium">数据目录</h3>
            <p
              class="mt-2 break-all rounded-lg bg-stone-50 p-3 font-mono text-sm"
            >
              {{ data.productDataDirectory ?? "未配置" }}
            </p>
            <p class="mt-3 text-sm text-muted-foreground">
              备份前请先停止 Digital；原始媒体需单独备份。
            </p>
          </div>
        </template>
      </div>
    </div>
    <LibrarySettingsDialog
      v-if="libraryDialog && data"
      v-bind="libraryDialog"
      :profiles="data.recognitionProfiles"
      :sources="data.librarySources"
      @close="libraryDialog = undefined"
      @saved="librarySaved"
    />
    <SourceConnectionDialog
      v-if="sourceDialog"
      v-bind="sourceDialog"
      @close="sourceDialog = undefined"
      @saved="saved"
    />
    <AutomationSettingsDialog
      v-if="planDialog && data"
      v-bind="planDialog"
      :libraries="data.libraries"
      @close="planDialog = undefined"
      @saved="saved"
    />
  </section>
</template>
