<script setup lang="ts">
import { ref } from "vue";

import ExecutionList from "#/components/formal/ExecutionList.vue";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { useCatalogue } from "#/composables/use-catalogue";
import { sendAction } from "#/lib/catalogue";

const observedRootId = ref("");
const relativeScope = ref(".");
const message = ref<string>();
const executionId = ref<string>();
const busy = ref(false);
const { catalogue, reload } = useCatalogue();

async function submit() {
  busy.value = true;
  message.value = undefined;
  try {
    const execution = await sendAction<{ readonly id: string }>(
      "/api/refresh",
      {
        observedRootId: observedRootId.value,
        relativeScope: relativeScope.value.trim() || ".",
      },
    );
    executionId.value = execution.id;
    message.value = "已创建刷新记录，正在处理。";
    await reload();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "暂时无法开始处理";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="mx-auto grid max-w-2xl gap-6">
    <header>
      <h1 class="text-3xl font-bold tracking-tight">添加内容</h1>
      <p class="mt-2 text-muted-foreground">
        选择已登记的文件位置和范围。原始文件不会被移动或修改。
      </p>
    </header>
    <form
      class="grid gap-4 rounded-xl border bg-background p-5"
      @submit.prevent="submit"
    >
      <label class="grid gap-2"
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
          required
          placeholder="例如：作品/RJ01668691" /></label
      ><Button type="submit" :disabled="busy || !observedRootId">{{
        busy ? "正在开始…" : "开始处理"
      }}</Button>
    </form>
    <Alert
      v-if="message"
      :variant="message.startsWith('已创建') ? 'default' : 'destructive'"
      ><AlertTitle>{{
        message.startsWith("已创建") ? "已创建刷新记录" : "无法开始"
      }}</AlertTitle
      ><AlertDescription>{{ message }}</AlertDescription></Alert
    >
    <a
      v-if="executionId"
      :href="`/inspection?record=${executionId}`"
      class="w-fit underline underline-offset-4"
      >查看刷新记录</a
    >
    <section>
      <h2 class="mb-3 text-xl font-semibold">最近记录</h2>
      <ExecutionList :executions="catalogue.executions.slice(0, 3)" />
    </section>
  </section>
</template>
