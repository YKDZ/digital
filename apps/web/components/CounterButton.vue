<script setup lang="ts">
import { onMounted, ref } from "vue";

import { Button } from "#/components/ui/button";

const count = ref(0);
const mounted = ref(false);

onMounted(() => {
  mounted.value = true;
});
</script>

<template>
  <Button type="button" :disabled="!mounted" @click="count += 1">
    计数：{{ count }}
  </Button>
</template>
