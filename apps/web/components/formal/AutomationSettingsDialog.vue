<script setup lang="ts">
import {
  sendAction,
  type SettingsSnapshot,
} from "@digital/web-delivery/client";
import { ref } from "vue";
import { toast } from "vue-sonner";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "#/components/ui/select";
import { Switch } from "#/components/ui/switch";
const props = defineProps<{
  roots: SettingsSnapshot["roots"];
  plan?: SettingsSnapshot["automation"][number];
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const rootId = ref(
  props.plan?.observedRootId ??
    props.roots.find((root) => root.status === "active")?.id ??
    "",
);
const scope = ref(props.plan?.relativeScope ?? ".");
const interval = ref(String(props.plan?.intervalMilliseconds ?? 3600000));
const trusted = ref(props.plan?.acceptTrusted ?? true);
const busy = ref(false);
const error = ref("");
async function save() {
  busy.value = true;
  error.value = "";
  try {
    await sendAction("/api/automation", {
      action: "enable",
      observedRootId: rootId.value,
      relativeScope: scope.value,
      intervalMilliseconds: Number(interval.value),
      acceptTrusted: trusted.value,
    });
    toast.success("自动刷新计划已保存");
    emit("saved");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法保存计划";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Dialog open @update:open="!$event && !busy && emit('close')"
    ><DialogContent
      :aria-describedby="undefined"
      class="max-h-[85dvh] gap-4 overflow-y-auto p-4 sm:max-w-xl"
    >
      <DialogHeader><DialogTitle>自动刷新计划</DialogTitle></DialogHeader>
      <form class="grid gap-4" @submit.prevent="save">
        <label class="grid gap-2 text-sm font-medium"
          >文件位置<Select v-model="rootId" :disabled="busy || !!plan"
            ><SelectTrigger aria-label="计划文件位置"
              ><SelectValue /></SelectTrigger
            ><SelectContent
              ><SelectItem
                v-for="root in roots.filter((item) => item.status === 'active')"
                :key="root.id"
                :value="root.id"
                >{{ root.displayName }}</SelectItem
              ></SelectContent
            ></Select
          ></label
        >
        <label class="grid gap-2 text-sm font-medium"
          >范围（相对路径）<Input
            v-model="scope"
            :disabled="busy || !!plan"
            required
        /></label>
        <label class="grid gap-2 text-sm font-medium"
          >刷新间隔<Select v-model="interval" :disabled="busy"
            ><SelectTrigger aria-label="刷新间隔"><SelectValue /></SelectTrigger
            ><SelectContent
              ><SelectItem value="900000">每 15 分钟</SelectItem
              ><SelectItem value="3600000">每小时</SelectItem
              ><SelectItem value="86400000">每天</SelectItem
              ><SelectItem
                v-if="!['900000', '3600000', '86400000'].includes(interval)"
                :value="interval"
                >{{ Number(interval) / 60000 }} 分钟</SelectItem
              ></SelectContent
            ></Select
          ></label
        >
        <label
          class="flex items-center justify-between gap-3 text-sm font-medium"
          >自动接受明确匹配的结果<Switch v-model="trusted" :disabled="busy"
        /></label>
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
          ><Button :disabled="busy || !rootId">{{
            busy ? "正在保存" : "保存并启用"
          }}</Button></DialogFooter
        >
      </form>
    </DialogContent></Dialog
  >
</template>
