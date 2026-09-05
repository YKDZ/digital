<script setup lang="ts">
import { sendAction } from "@digital/web-delivery/client";
import { ref } from "vue";

import { Button } from "#/components/ui/button";

const props = defineProps<{
  readonly target: { readonly subjectId: string };
}>();
const emit = defineEmits<{ done: [] }>();
const message = ref<string>();
const executionId = ref<string>();
const pending = ref<"metadata-refresh" | "rescrape">();

async function refresh(kind: "metadata-refresh" | "rescrape") {
  pending.value = kind;
  message.value = undefined;
  try {
    const execution = await sendAction<{ readonly id: string }>(
      "/api/refresh",
      {
        target: props.target,
        operation: kind,
      },
    );
    executionId.value = execution.id;
    message.value = "已创建刷新记录，正在处理。";
    emit("done");
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "暂时无法开始处理";
  } finally {
    pending.value = undefined;
  }
}
</script>

<template>
  <div class="grid gap-2">
    <div class="flex flex-wrap gap-2">
      <Button
        variant="outline"
        :disabled="pending !== undefined"
        @click="refresh('metadata-refresh')"
        >{{
          pending === "metadata-refresh" ? "正在刷新…" : "刷新元数据"
        }}</Button
      ><Button
        variant="ghost"
        :disabled="pending !== undefined"
        @click="refresh('rescrape')"
        >{{ pending === "rescrape" ? "正在重新刮削…" : "重新刮削" }}</Button
      >
    </div>
    <p v-if="message" class="text-sm text-muted-foreground" role="status">
      {{ message }}
      <a
        v-if="executionId"
        :href="`/inspection?record=${executionId}`"
        class="underline underline-offset-4"
        >查看刷新记录</a
      >
    </p>
  </div>
</template>
