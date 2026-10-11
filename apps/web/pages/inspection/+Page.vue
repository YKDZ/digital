<script setup lang="ts">
import {
  requestExecution,
  type ExecutionViewModel,
} from "@digital/web-delivery/client";
import { onMounted, ref } from "vue";

import ExecutionInspection from "#/components/formal/ExecutionInspection.vue";
import ExecutionList from "#/components/formal/ExecutionList.vue";
import { Button } from "#/components/ui/button";
import { useCatalogue } from "#/composables/use-catalogue";

const recordId =
  typeof window === "undefined"
    ? ""
    : (new URLSearchParams(window.location.search).get("record") ?? "");

const {
  catalogue,
  error,
  loading,
  reload,
  loadMoreHistory,
  historyPageLoading,
} = useCatalogue();

const target = ref<ExecutionViewModel>();
const targetStatus = ref<"loading" | "ready" | "missing" | "error">("loading");
const targetError = ref("");

async function loadTarget() {
  targetStatus.value = "loading";
  targetError.value = "";
  try {
    const found = await requestExecution(recordId);
    target.value = found;
    targetStatus.value = found === undefined ? "missing" : "ready";
  } catch (cause) {
    targetStatus.value = "error";
    targetError.value =
      cause instanceof Error ? cause.message : "暂时无法读取记录";
  }
}

onMounted(() => {
  if (recordId.length > 0) void loadTarget();
});
</script>

<template>
  <section class="grid gap-6">
    <template v-if="recordId">
      <p
        v-if="targetStatus === 'loading' && !target"
        role="status"
        class="text-muted-foreground"
      >
        正在读取记录…
      </p>
      <div
        v-else-if="targetStatus === 'missing'"
        class="grid min-h-40 place-content-center justify-items-center gap-4 rounded-xl border border-dashed text-center"
      >
        <p class="text-muted-foreground">
          未找到这条刷新记录，它可能已被清理。
        </p>
        <Button as="a" href="/inspection" variant="outline"
          >返回刷新记录</Button
        >
      </div>
      <p
        v-else-if="targetStatus === 'error'"
        role="alert"
        class="text-destructive"
      >
        {{ targetError }}
      </p>
      <ExecutionInspection
        v-else-if="target"
        :execution="target"
        @changed="loadTarget"
      />
    </template>
    <template v-else>
      <header>
        <h1 class="text-3xl font-bold tracking-tight">刷新记录</h1>
        <p class="mt-2 text-muted-foreground">
          查看已完成、没有变化、跳过、未完成或等待处理的结果。
        </p>
      </header>
      <p v-if="loading" role="status" class="text-muted-foreground">
        正在读取记录…
      </p>
      <p v-else-if="error" role="alert" class="text-destructive">{{ error }}</p>
      <ExecutionList v-else :executions="catalogue.executions" />
      <Button
        v-if="
          !loading && !error && catalogue.pagination.workflowHistory.nextCursor
        "
        variant="outline"
        :disabled="historyPageLoading"
        class="mx-auto"
        @click="loadMoreHistory"
        >{{ historyPageLoading ? "正在加载…" : "加载更多" }}</Button
      >
    </template>
  </section>
</template>
