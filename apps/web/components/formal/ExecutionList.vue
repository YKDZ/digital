<script setup lang="ts">
import {
  executionOutcomeLabel,
  type ExecutionViewModel,
} from "@digital/web-delivery";

import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

defineProps<{ readonly executions: readonly ExecutionViewModel[] }>();

function label(execution: ExecutionViewModel): string {
  if (execution.outcome !== undefined)
    return executionOutcomeLabel(execution.outcome);
  return execution.status === "failed" ? "未完成" : "进行中";
}
</script>

<template>
  <div v-if="executions.length" class="grid gap-3">
    <Card v-for="execution in executions" :key="execution.id"
      ><CardHeader class="flex-row items-center justify-between gap-4"
        ><CardTitle class="text-base">{{
          execution.intent === "metadata-refresh"
            ? "刷新元数据"
            : execution.intent === "directed-recognition"
              ? "重新刮削"
              : "添加内容"
        }}</CardTitle
        ><Badge variant="secondary">{{ label(execution) }}</Badge></CardHeader
      ><CardContent class="grid gap-2 text-sm text-muted-foreground"
        ><p>{{ execution.reason ?? `文件夹：${execution.folder}` }}</p>
        <ul v-if="execution.dispositions.length" class="flex flex-wrap gap-2">
          <li
            v-for="(item, index) in execution.dispositions"
            :key="item.key"
            class="rounded bg-muted px-2 py-1"
          >
            {{
              item.status === "no-change"
                ? "没有变化"
                : item.status === "failed"
                  ? "未完成"
                  : item.status === "skipped"
                    ? "已跳过"
                    : item.status === "reused"
                      ? "已复用"
                      : item.status === "completed"
                        ? "已完成"
                        : "进行中"
            }}<span v-if="item.reason">：{{ item.reason }}</span
            ><span v-if="item.output">（{{ item.output }}）</span>
          </li>
        </ul>
        <ul v-if="execution.targets?.length" class="grid gap-1">
          <li v-for="target in execution.targets" :key="target.key">
            {{ target.label }}：{{
              target.status === "completed"
                ? "已完成"
                : target.status === "blocked"
                  ? "无法处理"
                  : target.status === "failed"
                    ? "未完成"
                    : target.status === "no-change"
                      ? "没有变化"
                      : target.status === "reused"
                        ? "已复用"
                        : target.status === "skipped"
                          ? "已跳过"
                          : "进行中"
            }}<span v-if="target.reason">（{{ target.reason }}）</span>
          </li>
        </ul>
        <a
          :href="`/inspection?record=${execution.id}`"
          class="w-fit text-foreground underline underline-offset-4"
          >查看本次记录</a
        ></CardContent
      ></Card
    >
  </div>
  <p v-else class="rounded-lg border bg-background p-6 text-muted-foreground">
    还没有刷新记录。
  </p>
</template>
