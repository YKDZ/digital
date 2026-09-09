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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "#/components/ui/select";
const props = defineProps<{
  roots: SettingsSnapshot["roots"];
  root?: SettingsSnapshot["roots"][number];
  reconnect?: boolean;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const name = ref(props.root?.displayName ?? "");
const path = ref(props.root?.containerPath ?? "");
const links = ref(props.root?.symlinkMode ?? "do-not-follow");
const targets = ref([...(props.root?.allowedTargetRootIds ?? [])]);
const advanced = ref(false);
const busy = ref(false);
const error = ref("");
async function save() {
  busy.value = true;
  error.value = "";
  try {
    await sendAction("/api/settings/roots", {
      action: props.reconnect ? "reconnect" : props.root ? "update" : "create",
      id: props.root?.id,
      expectedVersion: props.root?.configVersion,
      displayName: name.value,
      containerPath: path.value,
      symlinkMode: links.value,
      allowedTargetRootIds: targets.value,
    });
    toast.success("文件位置已保存");
    emit("saved");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法保存文件位置";
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
          reconnect
            ? "重新连接文件位置"
            : root
              ? "编辑文件位置"
              : "添加文件位置"
        }}</DialogTitle></DialogHeader
      >
      <form class="grid gap-4" @submit.prevent="save">
        <label class="grid gap-2 text-sm font-medium"
          >名称<Input v-model="name" :disabled="busy || reconnect" required
        /></label>
        <label class="grid gap-2 text-sm font-medium"
          >文件夹路径<Input
            v-model="path"
            :disabled="busy || (!!root && !reconnect)"
            placeholder="/media/books"
            required
        /></label>
        <template v-if="!reconnect">
          <Button
            type="button"
            variant="ghost"
            class="justify-start px-0"
            @click="advanced = !advanced"
            >{{ advanced ? "收起链接设置" : "链接设置" }}</Button
          >
          <div v-if="advanced" class="grid gap-3">
            <Select v-model="links" :disabled="busy"
              ><SelectTrigger aria-label="链接策略"
                ><SelectValue /></SelectTrigger
              ><SelectContent
                ><SelectItem value="do-not-follow">不跟随链接</SelectItem
                ><SelectItem value="follow-file-links"
                  >只跟随文件链接</SelectItem
                ><SelectItem value="follow-file-and-directory-links"
                  >跟随文件和目录链接</SelectItem
                ></SelectContent
              ></Select
            >
            <template v-if="links !== 'do-not-follow'"
              ><p class="text-sm font-medium">允许的目标位置</p>
              <label
                v-for="target in roots.filter(
                  (item) =>
                    item.id !== root?.id &&
                    (item.status === 'active' || targets.includes(item.id)),
                )"
                :key="target.id"
                class="flex items-center gap-2 text-sm"
                ><Checkbox
                  :model-value="targets.includes(target.id)"
                  :disabled="busy"
                  @update:model-value="
                    targets =
                      $event === true
                        ? [...targets, target.id]
                        : targets.filter((id) => id !== target.id)
                  "
                />{{ target.displayName
                }}{{ target.status === "revoked" ? "（已停用）" : "" }}</label
              ></template
            >
          </div>
        </template>
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
