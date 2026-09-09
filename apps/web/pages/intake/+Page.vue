<script setup lang="ts">
import { usePageContext } from "vike-vue/usePageContext";
import { computed, defineAsyncComponent } from "vue";

import IntakePage from "#/components/formal/IntakePage.vue";

const pageContext = usePageContext();
const prototype = computed(
  () => import.meta.env.DEV && pageContext.urlParsed.search.variant === "A",
);
const PrototypeIntake = import.meta.env.DEV
  ? defineAsyncComponent(() => import("./PrototypeIntake.vue"))
  : undefined;
</script>

<template>
  <component :is="PrototypeIntake" v-if="prototype" />
  <IntakePage v-else />
</template>
