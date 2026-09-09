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
  DialogDescription,
  DialogFooter,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
const props = defineProps<{
  source: string;
  connection?: SettingsSnapshot["sources"][number];
  revoke?: boolean;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const secret = ref("");
const clientId = ref("");
const redirectUri = ref(
  `${window.location.origin}/api/source-connections/bangumi/callback`,
);
const creatorId = ref(props.connection?.id.split("/")[1] ?? "");
const file = ref<File>();
const busy = ref(false);
const error = ref("");
const names: Record<string, string> = {
  tmdb: "TMDB",
  omdb: "OMDb",
  fanbox: "FANBOX",
  bangumi: "Bangumi",
};
async function save() {
  busy.value = true;
  error.value = "";
  try {
    const base = {
      source: props.source,
      expectedVersion: props.connection?.version,
      creatorId: creatorId.value,
    };
    if (props.revoke) {
      await sendAction("/api/settings/connections", {
        ...base,
        action: "revoke",
      });
      toast.success("已断开连接");
      emit("saved");
      return;
    }
    if (props.source === "bangumi") {
      if (clientId.value || secret.value)
        await sendAction("/api/settings/connections", {
          ...base,
          action: "configure-client",
          clientId: clientId.value,
          clientSecret: secret.value,
          redirectUri: redirectUri.value,
        });
      secret.value = "";
      const result = await sendAction<{ authorizationUrl: string }>(
        "/api/settings/connections",
        { ...base, action: "authorize" },
      );
      window.location.assign(result.authorizationUrl);
      return;
    }
    let browserCredential: unknown;
    if (props.source === "fanbox") {
      if (!file.value) throw new Error("请选择登录信息文件");
      try {
        browserCredential = JSON.parse(await file.value.text());
      } catch {
        throw new Error("登录信息文件不是有效的 JSON");
      }
    }
    const result = await sendAction<SettingsSnapshot["sources"][number]>(
      "/api/settings/connections",
      {
        ...base,
        action:
          props.connection?.credentialStatus === "configured"
            ? "replace"
            : "configure",
        secret: secret.value,
        browserCredential,
      },
    );
    secret.value = "";
    file.value = undefined;
    if (result.availability === "available")
      toast.success(`${names[props.source]} 已连接`);
    else toast.error("连接信息已保存，但验证未通过");
    emit("saved");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "来源操作未完成";
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
      <DialogHeader
        ><DialogTitle
          >{{ revoke ? "断开" : "连接" }} {{ names[source]
          }}{{ revoke ? "？" : "" }}</DialogTitle
        ><DialogDescription v-if="revoke"
          >已有内容和资料会保留。再次获取此来源的资料前，需要重新连接。</DialogDescription
        ></DialogHeader
      >
      <form class="grid gap-4" @submit.prevent="save">
        <template v-if="!revoke">
          <template v-if="source === 'bangumi'"
            ><p class="text-sm text-muted-foreground">
              已有应用配置可直接继续授权；需要更换时填写下方信息。
            </p>
            <label class="grid gap-2 text-sm font-medium"
              >应用 ID<Input
                v-model="clientId"
                :disabled="busy"
                autocomplete="off" /></label
            ><label class="grid gap-2 text-sm font-medium"
              >应用密钥<Input
                v-model="secret"
                :disabled="busy"
                type="password"
                autocomplete="new-password" /></label
            ><label class="grid gap-2 text-sm font-medium"
              >回调地址<Input v-model="redirectUri" :disabled="busy" /></label
          ></template>
          <template v-else-if="source === 'fanbox'"
            ><label class="grid gap-2 text-sm font-medium"
              >创作者 ID<Input
                v-model="creatorId"
                :disabled="busy || !!connection"
                required
                placeholder="创作者页面地址中的名称" /></label
            ><label class="grid gap-2 text-sm font-medium"
              >登录信息文件<Input
                type="file"
                accept="application/json,.json"
                :disabled="busy"
                @change="
                  file = ($event.target as HTMLInputElement).files?.[0]
                " /></label
          ></template>
          <label v-else class="grid gap-2 text-sm font-medium"
            >{{ source === "tmdb" ? "API 读取访问令牌" : "API Key"
            }}<Input
              v-model="secret"
              :disabled="busy"
              type="password"
              autocomplete="new-password"
              required
          /></label>
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
            busy
              ? "正在处理"
              : revoke
                ? "断开连接"
                : source === "bangumi"
                  ? "继续授权"
                  : "验证并连接"
          }}</Button></DialogFooter
        >
      </form>
    </DialogContent></Dialog
  >
</template>
