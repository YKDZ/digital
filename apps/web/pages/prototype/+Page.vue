<!-- 可删除原型：唯一方案通过 ?screen=... 固定当前界面，便于分享和逐项评审。 -->
<script setup lang="ts">
import { Command as CommandIcon, CornerDownLeft } from "@lucide/vue";
import { onMounted, onUnmounted, reactive, ref } from "vue";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "#/components/ui/command";

import {
  prototypeScreens,
  type PrototypeScreen,
  type PrototypeState,
} from "./prototype-data";
import VariantA from "./VariantA.vue";

const screen = ref<PrototypeScreen>("overview");
const commandOpen = ref(false);
const state = reactive<PrototypeState>({
  attentionResolved: false,
  automaticRecognition: true,
  automationEnabled: true,
  exportApplied: false,
  exportPlanned: false,
  previewMode: "applied",
  refreshRunning: true,
});

function isScreen(value: string | null): value is PrototypeScreen {
  return prototypeScreens.some((item) => item.id === value);
}

async function setScreen(next: PrototypeScreen) {
  screen.value = next;
  commandOpen.value = false;

  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("screen", next);
  const { navigate } = await import("vike/client/router");
  await navigate(`${url.pathname}${url.search}`, {
    keepScrollPosition: false,
    overwriteLastHistoryEntry: true,
  });
}

function updateState(update: Partial<PrototypeState>) {
  Object.assign(state, update);
}

function startRefresh() {
  state.refreshRunning = true;
  void setScreen("inspection");
}

function onGlobalKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    commandOpen.value = !commandOpen.value;
  }
}

onMounted(() => {
  const requestedScreen = new URLSearchParams(window.location.search).get(
    "screen",
  );
  if (isScreen(requestedScreen)) screen.value = requestedScreen;
  window.addEventListener("keydown", onGlobalKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
});
</script>

<template>
  <div class="fixed inset-0 z-50 overflow-hidden bg-background text-foreground">
    <VariantA
      :screen="screen"
      :state="state"
      @navigate="setScreen"
      @open-command="commandOpen = true"
      @start-refresh="startRefresh"
      @update-state="updateState"
    />

    <CommandDialog
      v-model:open="commandOpen"
      title="快速前往"
      description="搜索内容或前往其他页面"
    >
      <CommandInput placeholder="搜索内容或页面…" />
      <CommandList>
        <CommandEmpty>没有匹配结果。</CommandEmpty>
        <CommandGroup heading="页面">
          <CommandItem
            v-for="item in prototypeScreens.filter(
              (entry) => entry.id !== 'asset',
            )"
            :key="item.id"
            :value="item.label"
            @select="setScreen(item.id)"
          >
            <component :is="item.icon" />
            {{ item.label }}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="操作">
          <CommandItem value="添加内容" @select="setScreen('drop')">
            <CommandIcon />
            添加内容
          </CommandItem>
          <CommandItem value="刷新元数据" @select="startRefresh">
            <CommandIcon />
            刷新元数据
            <CommandShortcut>
              <CornerDownLeft class="size-3" />
            </CommandShortcut>
          </CommandItem>
          <CommandItem
            value="预览整理与导出"
            @select="
              updateState({ exportPlanned: true });
              setScreen('export');
            "
          >
            <CommandIcon />
            预览整理与导出
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  </div>
</template>
