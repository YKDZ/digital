<script setup lang="ts">
import { sendAction } from "@digital/web-delivery/client";
import { usePageContext } from "vike-vue/usePageContext";
import { computed, ref } from "vue";

import { Button } from "#/components/ui/button";
import { libraryContext, withLibraryContext } from "#/lib/library";

const props = defineProps<{
  readonly target: { readonly subjectId: string };
  readonly showEnrichment?: boolean;
}>();
const emit = defineEmits<{ done: [] }>();
const message = ref<string>();
const executionId = ref<string>();
const pending = ref<"metadata-refresh" | "rescrape">();
// 整理页须沿用详情页当前的库语境，避免库内浏览后重新退回多库阻塞。
const pageContext = usePageContext();
const enrichHref = computed(() =>
  withLibraryContext(
    `/intake/enrich?asset=${encodeURIComponent(props.target.subjectId)}`,
    libraryContext(pageContext.urlParsed.search),
  ),
);

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
      <Button v-if="showEnrichment !== false" as="a" :href="enrichHref"
        >整理内容</Button
      >
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
