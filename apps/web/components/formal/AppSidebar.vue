<script setup lang="ts">
import {
  CircleAlert,
  History,
  Library,
  Plus,
  Settings2,
  Waypoints,
} from "@lucide/vue";
import { usePageContext } from "vike-vue/usePageContext";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "#/components/ui/sidebar";
const pageContext = usePageContext();
const { setOpenMobile } = useSidebar();
const navigation = [
  { href: "/", label: "全部内容", icon: Library, id: "home" },
  { href: "/attention", label: "需要处理", icon: CircleAlert, id: "attention" },
  { href: "/inspection", label: "刷新记录", icon: History, id: "inspection" },
];
function isCurrent(href: string) {
  const path = pageContext.urlParsed.pathname;
  return href === "/" ? path === href : path.startsWith(href);
}
</script>

<template>
  <Sidebar collapsible="icon" class="border-r border-stone-200/70">
    <SidebarHeader class="px-3 pt-5 pb-4 group-data-[collapsible=icon]:px-2">
      <SidebarMenu
        ><SidebarMenuItem>
          <SidebarMenuButton
            as="a"
            href="/"
            size="lg"
            tooltip="Digital"
            aria-label="Digital，全部内容"
            class="gap-3 hover:bg-transparent"
            @click="setOpenMobile(false)"
          >
            <span
              data-testid="sidebar-logo-mark"
              class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-stone-800 text-white"
              ><Waypoints class="size-[18px]" :stroke-width="1.7"
            /></span>
            <span
              class="text-xl font-semibold tracking-tight group-data-[collapsible=icon]:hidden"
              >Digital</span
            >
          </SidebarMenuButton>
        </SidebarMenuItem></SidebarMenu
      >
    </SidebarHeader>
    <SidebarContent class="gap-4">
      <SidebarGroup class="px-3 group-data-[collapsible=icon]:px-2">
        <SidebarMenu
          ><SidebarMenuItem>
            <SidebarMenuButton
              as="a"
              href="/intake"
              tooltip="添加内容"
              aria-label="添加内容"
              data-testid="sidebar-intake-button"
              class="h-10 justify-center rounded-lg bg-stone-800 text-white hover:bg-stone-700 hover:text-white"
              @click="setOpenMobile(false)"
            >
              <Plus /><span class="group-data-[collapsible=icon]:hidden"
                >添加内容</span
              >
            </SidebarMenuButton>
          </SidebarMenuItem></SidebarMenu
        >
      </SidebarGroup>
      <SidebarGroup class="px-3 group-data-[collapsible=icon]:px-2">
        <SidebarMenu class="gap-1.5"
          ><SidebarMenuItem v-for="item in navigation" :key="item.href">
            <SidebarMenuButton
              as="a"
              :href="item.href"
              :tooltip="item.label"
              :aria-label="item.label"
              :aria-current="isCurrent(item.href) ? 'page' : undefined"
              :is-active="isCurrent(item.href)"
              :data-testid="`sidebar-nav-${item.id}`"
              class="h-10 text-stone-600"
              @click="setOpenMobile(false)"
            >
              <component :is="item.icon" /><span>{{ item.label }}</span>
            </SidebarMenuButton>
          </SidebarMenuItem></SidebarMenu
        >
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter class="px-3 pb-5 group-data-[collapsible=icon]:px-2">
      <SidebarMenu
        ><SidebarMenuItem>
          <SidebarMenuButton
            as="a"
            href="/settings/automation"
            tooltip="设置"
            aria-label="设置"
            :is-active="isCurrent('/settings')"
            :aria-current="isCurrent('/settings') ? 'page' : undefined"
            class="h-10 text-stone-600"
            @click="setOpenMobile(false)"
            ><Settings2 /><span>设置</span></SidebarMenuButton
          >
        </SidebarMenuItem></SidebarMenu
      >
    </SidebarFooter>
  </Sidebar>
</template>
