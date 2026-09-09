<script setup lang="ts">
import { BookOpen, LoaderCircle } from "@lucide/vue";
import { computed, ref, watch } from "vue";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";

import type { PrototypeSourceMatch } from "./prototype-intake-model";
const props = defineProps<{
  name: string;
  current?: PrototypeSourceMatch;
  input?: Pick<PrototypeSourceMatch, "source" | "identity">;
  outcome: string;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [match: PrototypeSourceMatch];
  input: [value: Pick<PrototypeSourceMatch, "source" | "identity">];
}>();
const source = ref(props.input?.source ?? props.current?.source ?? "isbn");
const identity = ref(props.input?.identity ?? props.current?.identity ?? "");
const results = ref<PrototypeSourceMatch[]>([]);
const selectedResult = ref("");
const choice = computed(() =>
  results.value.find((_, index) => String(index) === selectedResult.value),
);
const busy = ref(false);
const error = ref("");
const queried = ref(false);
const labels: Record<string, string> = {
  isbn: "ISBN 书籍资料",
  bangumi: "Bangumi",
  dlsite: "DLsite",
  tmdb: "TMDB",
};
const field = computed(() =>
  source.value === "isbn" ? "ISBN" : "编号或页面地址",
);
watch([source, identity], () => {
  results.value = [];
  selectedResult.value = "";
  queried.value = false;
  error.value = "";
  emit("input", { source: source.value, identity: identity.value });
});
async function lookup() {
  if (!identity.value.trim()) {
    error.value = `请填写${field.value}`;
    return;
  }
  error.value = "";
  results.value = [];
  selectedResult.value = "";
  queried.value = false;
  busy.value = true;
  await new Promise((resolve) => setTimeout(resolve, 650));
  busy.value = false;
  if (props.outcome === "failed") {
    error.value = "暂时无法查询，输入已保留，可以重试。";
    return;
  }
  queried.value = true;
  if (props.outcome === "empty") return;
  const result: PrototypeSourceMatch = {
    source: source.value,
    identity: identity.value.trim(),
    title: source.value === "isbn" ? "山间来信" : "夏日回声",
    description:
      source.value === "isbn"
        ? "林溪 · 示例出版社 · 2025"
        : `${labels[source.value]} · 示例资料`,
  };
  results.value =
    props.outcome === "multiple"
      ? [
          result,
          {
            ...result,
            title: `${result.title}：往返书简`,
            description: "林溪 · 示例书目记录 · 2025",
          },
        ]
      : [result];
  if (results.value.length === 1) selectedResult.value = "0";
}
function confirm() {
  if (choice.value) emit("confirm", choice.value);
}
</script>
<template>
  <Dialog open @update:open="!$event && emit('close')"
    ><DialogContent
      :aria-describedby="undefined"
      class="max-h-[85dvh] gap-4 overflow-y-auto p-4 sm:max-w-xl"
    >
      <DialogHeader
        ><DialogTitle
          >补充资料 · {{ name || "未命名" }}</DialogTitle
        ></DialogHeader
      >
      <form class="grid gap-4" @submit.prevent="lookup">
        <label class="grid gap-2 text-sm font-medium"
          >来源<Select v-model="source" :disabled="busy"
            ><SelectTrigger aria-label="资料来源"><SelectValue /></SelectTrigger
            ><SelectContent
              ><SelectItem
                v-for="(label, key) in labels"
                :key="key"
                :value="key"
                >{{ label }}</SelectItem
              ></SelectContent
            ></Select
          ></label
        >
        <label class="grid gap-2 text-sm font-medium"
          >{{ field }}
          <div class="flex gap-2">
            <Input
              v-model="identity"
              :aria-label="field"
              :disabled="busy"
              :placeholder="
                source === 'isbn' ? '输入 ISBN' : '输入编号或页面地址'
              "
            /><Button :disabled="busy"
              ><LoaderCircle v-if="busy" class="size-4 animate-spin" />{{
                busy ? "正在查询" : "查询"
              }}</Button
            >
          </div></label
        >
        <p v-if="error" role="alert" class="text-sm text-destructive">
          {{ error }}
        </p>
        <p
          v-if="queried && !results.length"
          class="rounded-lg bg-muted p-3 text-sm"
        >
          没有找到对应资料，请检查编号或更换来源。
        </p>
        <RadioGroup
          v-if="results.length"
          v-model="selectedResult"
          aria-label="选择对应的资料"
          class="gap-2"
          ><p v-if="results.length > 1" class="text-sm font-medium">
            选择对应的资料
          </p>
          <label
            v-for="(result, index) in results"
            :key="index"
            class="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
            :class="choice === result && 'border-primary bg-muted/40'"
            ><RadioGroupItem
              :value="String(index)"
              :aria-label="result.title"
              class="mt-1"
            /><BookOpen class="size-7 shrink-0 text-muted-foreground" /><span
              ><span class="block font-medium">{{ result.title }}</span
              ><span class="mt-1 block text-sm text-muted-foreground">{{
                result.description
              }}</span
              ><span class="mt-1 block text-sm text-muted-foreground">{{
                result.identity
              }}</span></span
            ></label
          ></RadioGroup
        >
        <p
          v-if="
            choice &&
            current &&
            (choice.source !== current.source ||
              choice.identity !== current.identity)
          "
          class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
        >
          将从“{{ current.title }}”（{{ current.identity }}）改为“{{
            choice.title
          }}”（{{ choice.identity }}）。
        </p>
        <DialogFooter
          ><Button type="button" variant="outline" @click="emit('close')"
            >暂不补充</Button
          ><Button type="button" :disabled="!choice || busy" @click="confirm">{{
            current ? "确认更改" : "使用这份资料"
          }}</Button></DialogFooter
        >
      </form>
    </DialogContent></Dialog
  >
</template>
