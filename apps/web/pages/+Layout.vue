<script setup lang="ts">
import AppShell from "#/components/formal/AppShell.vue";

const useFormalShell =
  typeof window === "undefined" ||
  !window.location.pathname.startsWith("/prototype");
</script>

<template>
  <AppShell v-if="useFormalShell">
    <slot />
  </AppShell>
  <slot v-else />
</template>
