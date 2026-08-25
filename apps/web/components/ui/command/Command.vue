<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import type { ListboxRootEmits, ListboxRootProps } from "reka-ui";
import { ListboxRoot, useFilter, useForwardPropsEmits } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactive, ref, watch } from "vue";

import { cn } from "#/lib/utils";

import { provideCommandContext } from ".";

const props = withDefaults(
  defineProps<ListboxRootProps & { class?: HTMLAttributes["class"] }>(),
  {
    modelValue: "",
    highlightOnHover: true,
  },
);

const emits = defineEmits<ListboxRootEmits>();

const delegatedProps = reactiveOmit(props, "class");

const forwarded = useForwardPropsEmits(delegatedProps, emits);

const allItems = ref<Map<string, string>>(new Map());
const allGroups = ref<Map<string, Set<string>>>(new Map());

const { contains } = useFilter({ sensitivity: "base" });
const filterState = reactive({
  search: "",
  filtered: {
    /** 所有可见项目的数量。 */
    count: 0,
    /** 从可见项目 ID 到搜索分数的映射。 */
    items: new Map() as Map<string, number>,
    /** 至少包含一个可见项目的分组集合。 */
    groups: new Set() as Set<string>,
  },
});

function filterItems() {
  if (!filterState.search) {
    filterState.filtered.count = allItems.value.size;
    // 无需操作；搜索为空时，每个项目都知道应显示自身。
    return;
  }

  // 重置分组。
  filterState.filtered.groups = new Set();
  let itemCount = 0;

  // 检查应包含哪些项目。
  for (const [id, value] of allItems.value) {
    const score = contains(value, filterState.search);
    filterState.filtered.items.set(id, score ? 1 : 0);
    if (score) itemCount++;
  }

  // 检查哪些分组至少显示一个项目。
  for (const [groupId, group] of allGroups.value) {
    for (const itemId of group) {
      if (filterState.filtered.items.get(itemId)! > 0) {
        filterState.filtered.groups.add(groupId);
        break;
      }
    }
  }

  filterState.filtered.count = itemCount;
}

watch(
  () => filterState.search,
  () => {
    filterItems();
  },
);

provideCommandContext({
  allItems,
  allGroups,
  filterState,
});
</script>

<template>
  <ListboxRoot
    data-slot="command"
    v-bind="forwarded"
    :class="
      cn(
        'bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md',
        props.class,
      )
    "
  >
    <slot />
  </ListboxRoot>
</template>
