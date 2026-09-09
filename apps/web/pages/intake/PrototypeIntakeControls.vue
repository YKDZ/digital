<script setup lang="ts">
const development = import.meta.env.DEV;
</script>
<template>
  <div
    v-if="development"
    aria-label="原型控制"
    class="fixed inset-x-3 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-center gap-2 rounded-xl bg-stone-900 px-3 py-2 text-white shadow-xl"
  >
    <span class="text-xs text-stone-300">原型 · 示例资料，不会保存</span
    ><span class="text-sm">A · 同屏整理</span><slot />
  </div>
</template>
