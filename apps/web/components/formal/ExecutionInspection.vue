<script setup lang="ts">
import { computed, ref } from "vue";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  executionOutcomeLabel,
  sendAction,
  type ExecutionViewModel,
} from "#/lib/catalogue";

import AssetDetail from "./AssetDetail.vue";

const props = defineProps<{ readonly execution: ExecutionViewModel }>();
const emit = defineEmits<{ changed: [] }>();
const message = ref<string>();
const preview = computed(() => props.execution.preview);

async function decide(action: "apply" | "reject") {
  if (!preview.value) return;
  try {
    const result = await sendAction<{ readonly status: string }>(
      "/api/preview",
      {
        action,
        previewId: preview.value.id,
      },
    );
    message.value =
      result.status === "applied"
        ? "已使用建议内容。"
        : result.status === "stale"
          ? "建议内容已经过期，请重新查看。"
          : "已保留当前内容。";
    emit("changed");
  } catch (error) {
    message.value =
      error instanceof Error ? error.message : "暂时无法处理建议内容";
  }
}

function dispositionLabel(
  status:
    | ExecutionViewModel["dispositions"][number]["status"]
    | NonNullable<ExecutionViewModel["targets"]>[number]["status"],
) {
  return {
    running: "进行中",
    completed: "已完成",
    failed: "未完成",
    blocked: "无法处理",
    skipped: "已跳过",
    reused: "已复用",
    "no-change": "没有变化",
  }[status];
}
</script>

<template>
  <section class="grid gap-6">
    <header>
      <h1 class="text-3xl font-bold tracking-tight">刷新详情</h1>
      <p class="mt-2 text-muted-foreground">文件夹：{{ execution.folder }}</p>
    </header>
    <Alert v-if="message"
      ><AlertTitle>处理结果</AlertTitle
      ><AlertDescription>{{ message }}</AlertDescription></Alert
    >
    <Card>
      <CardHeader><CardTitle>本次结果</CardTitle></CardHeader>
      <CardContent class="grid gap-2">
        <p>
          状态：{{
            execution.outcome === undefined
              ? "进行中"
              : executionOutcomeLabel(execution.outcome)
          }}
        </p>
        <p>{{ execution.reason ?? "已记录本次处理结果。" }}</p>
        <ul class="grid gap-2 text-sm text-muted-foreground">
          <li v-for="item in execution.dispositions" :key="item.key">
            {{ dispositionLabel(item.status)
            }}<span v-if="item.reason">：{{ item.reason }}</span
            ><span v-if="item.output">（{{ item.output }}）</span>
          </li>
        </ul>
        <ul
          v-if="execution.targets?.length"
          class="grid gap-2 text-sm text-muted-foreground"
        >
          <li v-for="target in execution.targets" :key="target.key">
            {{ target.label }}：{{ dispositionLabel(target.status)
            }}<span v-if="target.reason">（{{ target.reason }}）</span>
          </li>
        </ul>
      </CardContent>
    </Card>
    <Card v-if="execution.items?.length">
      <CardHeader><CardTitle>逐项结果</CardTitle></CardHeader>
      <CardContent>
        <ul class="grid gap-3 text-sm">
          <li v-for="item in execution.items" :key="item.key">
            <p class="font-medium">
              {{ item.key }}：{{
                item.outcome === undefined
                  ? "进行中"
                  : executionOutcomeLabel(item.outcome)
              }}
            </p>
            <p class="text-muted-foreground">
              {{ item.relativePaths.join("、") }}
            </p>
            <p v-if="item.reason" class="text-muted-foreground">
              {{ item.reason }}
            </p>
            <p v-if="item.recognition" class="text-muted-foreground">
              {{ item.recognition.explanation }}
            </p>
            <p v-if="item.acceptedAssetId" class="text-muted-foreground">
              已接受：{{ item.acceptedAssetId
              }}<span v-if="item.acceptedSource"
                >（{{ item.acceptedSource }}）</span
              >
            </p>
          </li>
        </ul>
      </CardContent>
    </Card>
    <template v-if="preview">
      <p class="font-medium">建议内容尚未使用；请比较后决定。</p>
      <div class="grid gap-6 xl:grid-cols-2">
        <section class="grid gap-3">
          <h2 class="text-xl font-semibold">当前内容</h2>
          <AssetDetail :asset="preview.current" :show-actions="false" />
        </section>
        <section class="grid gap-3">
          <h2 class="text-xl font-semibold">建议内容</h2>
          <AssetDetail :asset="preview.proposed" :show-actions="false" />
        </section>
      </div>
      <p v-if="preview.blockingConditions.length" class="text-destructive">
        {{ preview.blockingConditions.join("；") }}
      </p>
      <div
        v-else-if="preview.status === 'awaiting-confirmation'"
        class="flex flex-wrap gap-3"
      >
        <Button @click="decide('apply')">确认使用</Button
        ><Button variant="outline" @click="decide('reject')">不使用</Button>
      </div>
    </template>
  </section>
</template>
