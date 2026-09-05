<script setup lang="ts">
import { sendAction } from "@digital/web-delivery/client";
import { computed, ref } from "vue";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Switch } from "#/components/ui/switch";
import { useCatalogue } from "#/composables/use-catalogue";

const observedRootId = ref("");
const relativeScope = ref(".");
const interval = ref("3600000");
const acceptTrusted = ref(true);
const message = ref<string>();
const executionId = ref<string>();
const { catalogue, reload } = useCatalogue();
const intervalLabel = computed(
  () =>
    ({ "900000": "每 15 分钟", "3600000": "每小时", "86400000": "每天" })[
      interval.value
    ] ?? "自定义",
);

async function enable() {
  try {
    const result = await sendAction<{
      readonly initialStatus?: "started" | "skipped" | "disabled";
      readonly initialExecution?: {
        readonly id: string;
        readonly status: string;
      };
    }>("/api/automation", {
      action: "enable",
      observedRootId: observedRootId.value,
      relativeScope: relativeScope.value.trim() || ".",
      intervalMilliseconds: Number(interval.value),
      acceptTrusted: acceptTrusted.value,
    });
    message.value =
      result.initialStatus === "skipped"
        ? "已启用自动刷新；首次检查已跳过，当前处理完成后会按计划继续。"
        : result.initialExecution
          ? `已启用自动刷新；首次检查已完成，可查看刷新记录。`
          : "已启用自动刷新。";
    executionId.value = result.initialExecution?.id;
    await reload();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "暂时无法保存设置";
  }
}
async function action(intentId: string, name: "disable" | "scan-now") {
  try {
    const result = await sendAction<{
      readonly status?: string;
      readonly execution?: { readonly id: string };
    }>("/api/automation", { action: name, intentId });
    message.value =
      name === "disable"
        ? "已停止后续自动刷新；正在进行的处理不会取消。"
        : result.status === "skipped"
          ? "本次触发已跳过：当前仍有处理进行中。"
          : result.execution
            ? "已完成立即刷新，可查看刷新记录。"
            : "立即刷新没有创建新的记录。";
    executionId.value = result.execution?.id;
    await reload();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "暂时无法完成操作";
  }
}
</script>

<template>
  <section class="mx-auto grid max-w-3xl gap-6">
    <header>
      <h1 class="text-3xl font-bold tracking-tight">自动刷新</h1>
      <p class="mt-2 text-muted-foreground">
        定期检查已登记文件位置中的指定范围；重叠触发会跳过，下次仍会按计划进行。
      </p>
    </header>
    <Alert v-if="message"
      ><AlertTitle>自动刷新</AlertTitle
      ><AlertDescription>{{ message }}</AlertDescription></Alert
    ><Card
      ><CardHeader><CardTitle>新增自动刷新</CardTitle></CardHeader
      ><CardContent class="grid gap-5"
        ><label class="grid gap-2"
          ><span class="font-medium">文件位置</span
          ><Select v-model="observedRootId"
            ><SelectTrigger aria-label="文件位置"
              ><SelectValue placeholder="选择文件位置" /></SelectTrigger
            ><SelectContent
              ><SelectItem
                v-for="root in catalogue.observedRoots"
                :key="root.id"
                :value="root.id"
                >{{ root.displayName }}</SelectItem
              ></SelectContent
            ></Select
          ><span
            v-if="catalogue.observedRoots.length === 0"
            class="text-sm text-muted-foreground"
            >还没有可用的文件位置。</span
          ></label
        ><label class="grid gap-2"
          ><span class="font-medium">范围（相对路径）</span
          ><Input
            v-model="relativeScope"
            aria-label="范围（相对路径）"
            placeholder="例如：轻小说" /></label
        ><label class="grid gap-2"
          ><span class="font-medium">刷新间隔</span
          ><Select v-model="interval"
            ><SelectTrigger aria-label="刷新间隔"
              ><SelectValue :placeholder="intervalLabel" /></SelectTrigger
            ><SelectContent
              ><SelectItem value="900000">每 15 分钟</SelectItem
              ><SelectItem value="3600000">每小时</SelectItem
              ><SelectItem value="86400000">每天</SelectItem></SelectContent
            ></Select
          ></label
        ><label class="flex items-center justify-between gap-4"
          ><span
            ><span class="block font-medium">自动接受明确匹配的结果</span
            ><span class="text-sm text-muted-foreground"
              >关闭后，每个结果都会进入“需要处理”。</span
            ></span
          ><Switch
            v-model="acceptTrusted"
            aria-label="自动接受明确匹配的结果" /></label></CardContent
      ><CardFooter
        ><Button :disabled="!observedRootId" @click="enable"
          >启用自动刷新</Button
        ></CardFooter
      ></Card
    >
    <a
      v-if="executionId"
      :href="`/inspection?record=${executionId}`"
      class="w-fit underline underline-offset-4"
      >查看刷新记录</a
    >
    <section class="grid gap-3">
      <h2 class="text-xl font-semibold">已设置的范围</h2>
      <Card v-for="item in catalogue.automation" :key="item.id"
        ><CardHeader
          ><CardTitle class="text-base">{{
            item.folder
          }}</CardTitle></CardHeader
        ><CardContent class="text-sm text-muted-foreground"
          >{{
            item.enabled
              ? `已启用 · ${item.intervalMilliseconds === 86400000 ? "每天" : item.intervalMilliseconds === 3600000 ? "每小时" : "每 15 分钟"}`
              : "已停用"
          }}
          ·
          {{
            item.acceptTrusted ? "明确匹配会自动完成" : "所有结果都需要查看"
          }}</CardContent
        ><CardFooter class="gap-3"
          ><Button variant="outline" @click="action(item.id, 'scan-now')"
            >立即刷新</Button
          ><Button
            v-if="item.enabled"
            variant="ghost"
            @click="action(item.id, 'disable')"
            >停用</Button
          ></CardFooter
        ></Card
      >
      <p
        v-if="catalogue.automation.length === 0"
        class="rounded-lg border bg-background p-6 text-muted-foreground"
      >
        还没有自动刷新设置。
      </p>
    </section>
  </section>
</template>
