<script setup lang="ts">
import { provideSSRWidth, useMounted } from "@vueuse/core";
import { usePageContext } from "vike-vue/usePageContext";
import { computed, onMounted, ref } from "vue";

import AppSidebar from "#/components/formal/AppSidebar.vue";
import { SidebarProvider, SidebarTrigger } from "#/components/ui/sidebar";
import {
  createLibraryNavigation,
  provideLibraryNavigation,
} from "#/composables/use-library-navigation";
const pageContext = usePageContext();
const home = computed(() => pageContext.urlParsed.pathname === "/");
const settings = computed(
  () => pageContext.urlParsed.pathname === "/settings/automation",
);
const sidebarOpen = ref(true);
const mounted = useMounted();
const libraryNavigation = createLibraryNavigation();
provideLibraryNavigation(libraryNavigation);
onMounted(() => void libraryNavigation.refresh());
provideSSRWidth(1280);
</script>

<template>
  <SidebarProvider
    v-model:open="sidebarOpen"
    class="app-shell"
    style="--sidebar-width: 14rem"
  >
    <AppSidebar />
    <main class="min-w-0 flex-1 bg-background pb-16">
      <header
        class="flex items-center gap-4 px-5 sm:px-9"
        :class="settings ? 'h-14 sm:px-5' : 'h-20'"
      >
        <SidebarTrigger
          :disabled="!mounted"
          class="size-9 -ml-2 text-muted-foreground"
        />
        <span class="text-sm text-muted-foreground">我的内容</span>
      </header>
      <div
        class="mx-auto"
        :class="
          settings
            ? 'px-4 pt-2 sm:px-5'
            : [
                'px-5 pt-4 sm:px-9 sm:pt-5',
                home ? 'max-w-[1600px]' : 'max-w-6xl',
              ]
        "
      >
        <slot />
      </div>
    </main>
  </SidebarProvider>
</template>

<style scoped>
.app-shell {
  --sidebar: #f7f7f5;
  --sidebar-accent: #eaeae6;
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    "PingFang SC",
    "Microsoft YaHei",
    sans-serif;
}
</style>
