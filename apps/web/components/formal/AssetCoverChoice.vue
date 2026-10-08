<script setup lang="ts">
import {
  requestCoverChoice,
  sendAction,
  type CoverChoiceView,
} from "@digital/web-delivery/client";
import { onMounted, ref } from "vue";

import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

const props = defineProps<{ readonly subjectId: string }>();
const emit = defineEmits<{ refreshed: [] }>();
const actor = "web-user";
const choice = ref<CoverChoiceView>();
const message = ref<string>();
const pendingReference = ref<string>();
const waitingPreview = ref<{
  readonly id: string;
  readonly withdraw: boolean;
}>();
const busy = ref(false);

async function load() {
  try {
    choice.value = await requestCoverChoice(props.subjectId);
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "暂时无法读取封面";
  }
}

async function start(withdraw: boolean, reference?: string) {
  busy.value = true;
  message.value = undefined;
  try {
    const result = await sendAction<{ readonly previewId: string }>(
      "/api/cover-decisions",
      {
        entityId: props.subjectId,
        initiatedBy: actor,
        ...(withdraw ? {} : { candidateReference: reference }),
      },
    );
    waitingPreview.value = { id: result.previewId, withdraw };
    pendingReference.value = reference;
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "暂时无法开始处理";
  } finally {
    busy.value = false;
  }
}

async function settle(action: "apply" | "reject") {
  const preview = waitingPreview.value;
  if (preview === undefined) return;
  busy.value = true;
  message.value = undefined;
  try {
    const result = await sendAction<{
      readonly status:
        | "awaiting-confirmation"
        | "rejected"
        | "applied"
        | "stale";
    }>("/api/preview", { action, previewId: preview.id, actorId: actor });
    waitingPreview.value = undefined;
    pendingReference.value = undefined;
    message.value =
      action === "reject"
        ? "已取消，当前封面保持不变。"
        : result.status === "stale"
          ? "封面的可用依据已变化，请重新选择。"
          : preview.withdraw
            ? "已撤回人工选择，封面回到既有依据。"
            : "已按你的选择更新封面。";
    emit("refreshed");
    await load();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "暂时无法完成确认";
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <Card v-if="choice" data-testid="cover-choice">
    <CardHeader
      ><CardTitle>封面</CardTitle>
      <p v-if="choice.currentImageUrl" class="text-sm text-muted-foreground">
        当前封面
      </p></CardHeader
    >
    <CardContent class="grid gap-3">
      <img
        v-if="choice.currentImageUrl"
        :src="choice.currentImageUrl"
        alt="当前封面"
        class="max-h-48 w-fit max-w-full object-contain"
      />
      <ul v-if="choice.candidates.length" class="grid gap-3 sm:grid-cols-2">
        <li
          v-for="candidate in choice.candidates"
          :key="candidate.reference"
          class="grid gap-2"
        >
          <img
            v-if="candidate.imageUrl"
            :src="candidate.imageUrl"
            :alt="candidate.title"
            class="max-h-36 w-fit max-w-full object-contain"
          />
          <span class="text-sm text-muted-foreground">{{
            candidate.title
          }}</span>
          <span
            v-if="candidate.reference === choice.manualReference"
            class="text-sm text-muted-foreground"
            >这是你选的封面</span
          >
          <Button
            v-if="candidate.reference !== choice.manualReference"
            variant="outline"
            class="w-fit"
            :disabled="busy"
            @click="start(false, candidate.reference)"
            >选择此封面</Button
          >
        </li>
      </ul>
      <p v-else class="text-sm text-muted-foreground">
        这项内容还没有可用的封面依据。
      </p>
      <Button
        v-if="choice.manualReference || choice.manualStale"
        variant="ghost"
        class="w-fit"
        :disabled="busy"
        @click="start(true)"
        >撤回选择</Button
      >
      <div v-if="waitingPreview" class="grid gap-2">
        <p class="text-sm">
          {{
            waitingPreview.withdraw
              ? "撤回后，封面回到既有本地与来源依据。"
              : "确认后，这张封面将优先于本地与来源依据。"
          }}
        </p>
        <div class="flex flex-wrap gap-2">
          <Button :disabled="busy" @click="settle('apply')">确认使用</Button>
          <Button variant="ghost" :disabled="busy" @click="settle('reject')"
            >不使用</Button
          >
        </div>
      </div>
      <ul
        v-if="choice.problems.length"
        class="grid gap-1 text-sm text-destructive"
        role="status"
      >
        <li v-for="problem in choice.problems" :key="problem">{{ problem }}</li>
      </ul>
      <p v-if="message" class="text-sm text-muted-foreground" role="status">
        {{ message }}
      </p>
    </CardContent>
  </Card>
</template>
