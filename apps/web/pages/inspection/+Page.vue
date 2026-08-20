<script setup lang="ts">
import ExecutionInspection from "#/components/formal/ExecutionInspection.vue";
import ExecutionList from "#/components/formal/ExecutionList.vue";
import { Button } from "#/components/ui/button";
import { useCatalogue } from "#/composables/use-catalogue";

const {
  catalogue,
  error,
  loading,
  reload,
  loadMoreHistory,
  historyPageLoading,
} = useCatalogue();
const recordId =
  typeof window === "undefined"
    ? ""
    : new URLSearchParams(window.location.search).get("record");
</script>

<template>
  <section class="grid gap-6">
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
    <ExecutionInspection
      v-else-if="
        recordId && catalogue.executions.find((item) => item.id === recordId)
      "
      :execution="catalogue.executions.find((item) => item.id === recordId)!"
      @changed="reload"
    />
    <ExecutionList v-else :executions="catalogue.executions" />
    <Button
      v-if="!recordId && catalogue.pagination.workflowHistory.nextCursor"
      variant="outline"
      :disabled="historyPageLoading"
      class="mx-auto"
      @click="loadMoreHistory"
      >{{ historyPageLoading ? "正在加载…" : "加载更多" }}</Button
    >
  </section>
</template>
