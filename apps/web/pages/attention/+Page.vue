<script setup lang="ts">
import { sendAction } from "@digital/web-delivery";
import { ref } from "vue";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { useCatalogue } from "#/composables/use-catalogue";

const {
  catalogue,
  error,
  loading,
  reload,
  loadMoreAttention,
  attentionPageLoading,
} = useCatalogue();
const message = ref<string>();

async function decide(previewId: string, action: "apply" | "reject") {
  try {
    const result = await sendAction<{ readonly status: string }>(
      "/api/preview",
      { action, previewId },
    );
    message.value =
      result.status === "applied"
        ? "已使用刮削结果。"
        : result.status === "stale"
          ? "结果已经过期，请重新查看。"
          : "已保留当前内容，并拒绝这个结果。";
    await reload();
  } catch (cause) {
    message.value =
      cause instanceof Error ? cause.message : "暂时无法处理这个结果";
  }
}
</script>

<template>
  <section class="grid gap-6">
    <header>
      <h1 class="text-3xl font-bold tracking-tight">需要处理</h1>
      <p class="mt-2 text-muted-foreground">
        只有无法自动确认的结果会出现在这里。
      </p>
    </header>
    <Alert v-if="message">
      <AlertTitle>处理结果</AlertTitle>
      <AlertDescription>{{ message }}</AlertDescription>
    </Alert>
    <p v-if="loading" role="status" class="text-muted-foreground">
      正在读取结果…
    </p>
    <p v-else-if="error" role="alert" class="text-destructive">{{ error }}</p>
    <div v-else-if="catalogue.attention.length" class="grid gap-4">
      <Card v-for="item in catalogue.attention" :key="item.id">
        <CardHeader>
          <CardTitle>{{
            item.kind === "recognition-review"
              ? "识别结果"
              : item.kind === "change-impact-review"
                ? "刮削变更"
                : "来源刷新变更"
          }}</CardTitle>
          <p class="text-sm text-muted-foreground">
            {{ item.summary }}
          </p>
        </CardHeader>
        <CardContent class="grid gap-2">
          <a
            :href="'/inspection?record=' + item.executionId"
            class="w-fit underline underline-offset-4"
            >查看变更</a
          >
        </CardContent>
        <CardFooter v-if="item.changeImpactPreviewId" class="gap-3">
          <Button @click="decide(item.changeImpactPreviewId, 'apply')"
            >确认使用</Button
          >
          <Button
            variant="outline"
            @click="decide(item.changeImpactPreviewId, 'reject')"
            >不使用</Button
          >
        </CardFooter>
      </Card>
    </div>
    <p v-else class="rounded-lg border bg-background p-6 text-muted-foreground">
      当前没有需要处理的问题。
    </p>
    <Button
      v-if="catalogue.pagination.currentAttention.nextCursor"
      variant="outline"
      :disabled="attentionPageLoading"
      class="mx-auto"
      @click="loadMoreAttention"
      >{{ attentionPageLoading ? "正在加载…" : "加载更多" }}</Button
    >
  </section>
</template>
