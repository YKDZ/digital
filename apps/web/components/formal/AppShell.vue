<script setup lang="ts">
import {
  BellDot,
  FolderInput,
  FolderSync,
  LibraryBig,
  Settings2,
  Waypoints,
} from "@lucide/vue";
import { ref } from "vue";

import { Button } from "#/components/ui/button";
import { Separator } from "#/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "#/components/ui/sidebar";

const currentPath =
  typeof window === "undefined" ? "/" : window.location.pathname;
const sidebarOpen = ref(true);

const navigation = [
  {
    label: "浏览",
    items: [{ href: "/", label: "全部内容", icon: LibraryBig }],
  },
  {
    label: "状态",
    items: [
      { href: "/inspection", label: "刷新记录", icon: FolderSync },
      { href: "/attention", label: "需要处理", icon: BellDot },
    ],
  },
  {
    label: "管理",
    items: [
      {
        href: "/settings/automation",
        label: "自动刷新",
        icon: Settings2,
      },
    ],
  },
] as const;

function isCurrent(href: string): boolean {
  return href === "/" ? currentPath === href : currentPath.startsWith(href);
}
</script>

<template>
  <SidebarProvider v-model:open="sidebarOpen">
    <Sidebar collapsible="icon">
      <SidebarHeader class="gap-3 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton as="a" href="/" size="lg" tooltip="数字资产">
              <span
                data-testid="sidebar-logo-mark"
                class="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
              >
                <Waypoints class="size-4" />
              </span>
              <span class="grid flex-1 text-left text-sm leading-tight">
                <span class="truncate font-semibold">数字资产</span>
                <span class="truncate text-xs text-muted-foreground">
                  本地内容
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <Button
          as="a"
          href="/intake"
          data-testid="sidebar-intake-button"
          class="w-full group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:px-0"
        >
          <FolderInput />
          <span class="group-data-[collapsible=icon]:hidden">添加内容</span>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup v-for="group in navigation" :key="group.label">
          <SidebarGroupLabel>{{ group.label }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="item in group.items" :key="item.href">
                <SidebarMenuButton
                  as="a"
                  :href="item.href"
                  :tooltip="item.label"
                  :is-active="isCurrent(item.href)"
                  :data-testid="`sidebar-nav-${item.href === '/' ? 'home' : item.href.slice(1).replaceAll('/', '-')}`"
                >
                  <component :is="item.icon" />
                  <span>{{ item.label }}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter class="p-3 text-xs text-muted-foreground">
        <span class="group-data-[collapsible=icon]:hidden">内容管理</span>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <SidebarInset class="min-w-0 bg-muted/30">
      <header
        class="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur"
      >
        <SidebarTrigger />
        <Separator orientation="vertical" class="h-4" />
        <span class="text-sm text-muted-foreground">数字资产</span>
      </header>
      <main class="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6"><slot /></main>
    </SidebarInset>
  </SidebarProvider>
</template>
