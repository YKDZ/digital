<script setup lang="ts">
import {
  sendAction,
  type SettingsSnapshot,
} from "@digital/web-delivery/client";
import { ref } from "vue";
import { toast } from "vue-sonner";

import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";

const props = defineProps<{
  library?: SettingsSnapshot["libraries"][number];
  profiles: SettingsSnapshot["recognitionProfiles"];
  sources: SettingsSnapshot["librarySources"];
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const name = ref(props.library?.displayName ?? "");
const directories = ref(props.library?.directories.join("\n") ?? "");
const profiles = ref([...(props.library?.recognitionProfileIds ?? [])]);
const sources = ref([
  ...(props.library?.sourceIdentities ??
    props.sources.map((source) => source.id)),
]);
const busy = ref(false);
const error = ref("");
async function save() {
  busy.value = true;
  error.value = "";
  try {
    await sendAction("/api/settings/libraries", {
      action: "save",
      id: props.library?.id,
      expectedVersion: props.library?.configVersion,
      displayName: name.value,
      directories: directories.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      recognitionProfileIds: profiles.value,
      sourceIdentities: sources.value,
    });
    toast.success("资产库已保存");
    emit("saved");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法保存资产库";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Dialog open @update:open="!$event && !busy && emit('close')">
    <DialogContent
      :aria-describedby="undefined"
      class="max-h-[85dvh] gap-4 overflow-y-auto p-4 sm:max-w-xl"
    >
      <DialogHeader
        ><DialogTitle>{{
          library ? "编辑资产库" : "添加资产库"
        }}</DialogTitle></DialogHeader
      >
      <form class="grid gap-4" @submit.prevent="save">
        <label class="grid gap-2 text-sm font-medium"
          >名称<Input v-model="name" :disabled="busy" required
        /></label>
        <label class="grid gap-2 text-sm font-medium"
          >实际资产目录<Textarea
            v-model="directories"
            :disabled="busy"
            placeholder="/media/books"
            required
          /><span class="text-xs font-normal text-muted-foreground"
            >每行一个目录。Digital 只读取你整理好的文件。</span
          ></label
        >
        <fieldset class="grid gap-2">
          <legend class="mb-2 text-sm font-medium">资产类型</legend>
          <label
            v-for="profile in props.profiles"
            :key="profile.id"
            class="flex items-center gap-2 text-sm"
            ><Checkbox
              :model-value="profiles.includes(profile.id)"
              :disabled="busy"
              @update:model-value="
                profiles =
                  $event === true
                    ? [...profiles, profile.id]
                    : profiles.filter((id) => id !== profile.id)
              "
            />{{ profile.displayName }}</label
          >
          <p class="text-xs text-muted-foreground">
            可选多种类型。资产内的台本、封面等文件仍会单独读取。
          </p>
        </fieldset>
        <fieldset class="grid gap-2">
          <legend class="mb-2 text-sm font-medium">资料来源</legend>
          <label
            v-for="source in props.sources"
            :key="source.id"
            class="flex items-center gap-2 text-sm"
            ><Checkbox
              :model-value="sources.includes(source.id)"
              :disabled="busy"
              @update:model-value="
                sources =
                  $event === true
                    ? [...sources, source.id]
                    : sources.filter((id) => id !== source.id)
              "
            />{{ source.displayName }}</label
          >
        </fieldset>
        <p v-if="error" role="alert" class="text-sm text-destructive">
          {{ error }}
        </p>
        <DialogFooter
          ><Button
            type="button"
            variant="outline"
            :disabled="busy"
            @click="emit('close')"
            >取消</Button
          ><Button :disabled="busy">{{
            busy ? "正在保存" : "保存"
          }}</Button></DialogFooter
        >
      </form>
    </DialogContent>
  </Dialog>
</template>
