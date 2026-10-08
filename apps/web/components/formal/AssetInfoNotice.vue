<script setup lang="ts">
import { TriangleAlert } from "@lucide/vue";
import { computed } from "vue";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
  assetFactNotice,
  type AssetFactNoticeInput,
} from "#/lib/asset-fact-notice";

// 界面只消费共同事实分类，绝不渲染内部坐标、来源记录或策略身份。
const props = withDefaults(
  defineProps<{
    readonly asset: AssetFactNoticeInput;
    readonly variant?: "card" | "detail";
  }>(),
  { variant: "detail" },
);

const notice = computed(() => assetFactNotice(props.asset));
</script>

<template>
  <Badge
    v-if="variant === 'card' && notice.hasProblem"
    variant="outline"
    class="mb-1"
  >
    资料待完善
  </Badge>
  <Collapsible v-else-if="variant === 'detail' && notice.hasProblem">
    <Alert>
      <TriangleAlert />
      <AlertTitle>资料状态</AlertTitle>
      <AlertDescription>
        <p>这项内容还有需要留意的资料问题。</p>
        <CollapsibleTrigger
          class="mt-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          查看依据
        </CollapsibleTrigger>
        <CollapsibleContent class="mt-2 grid gap-3">
          <div v-if="notice.missingLabels.length" class="grid gap-1">
            <p class="text-sm font-medium">资料缺失</p>
            <ul class="grid gap-1 text-sm text-muted-foreground">
              <li v-for="label in notice.missingLabels" :key="label">
                暂时缺少{{ label }}。
              </li>
            </ul>
          </div>
          <div v-if="notice.conflictReasons.length" class="grid gap-1">
            <p class="text-sm font-medium">资料冲突</p>
            <ul class="grid gap-1 text-sm text-muted-foreground">
              <li v-for="reason in notice.conflictReasons" :key="reason">
                {{ reason }}
              </li>
            </ul>
          </div>
          <div v-if="notice.problemReasons.length" class="grid gap-1">
            <p class="text-sm font-medium">需要留意</p>
            <ul class="grid gap-1 text-sm text-muted-foreground">
              <li v-for="reason in notice.problemReasons" :key="reason">
                {{ reason }}
              </li>
            </ul>
          </div>
          <div v-if="notice.fulfillmentReasons.length" class="grid gap-1">
            <p class="text-sm font-medium">获取状态</p>
            <ul class="grid gap-1 text-sm text-muted-foreground">
              <li v-for="reason in notice.fulfillmentReasons" :key="reason">
                {{ reason }}
              </li>
            </ul>
          </div>
          <div class="grid gap-1">
            <p class="text-sm font-medium">依据</p>
            <ul class="grid gap-1 text-sm">
              <li>
                <a
                  :href="notice.evidence.correctionHref"
                  class="text-primary underline underline-offset-4"
                  >核对来源与依据</a
                >
              </li>
              <li
                v-for="page in notice.evidence.sourcePages"
                :key="page.url"
                class="truncate"
              >
                <a
                  :href="page.url"
                  target="_blank"
                  rel="noreferrer"
                  class="text-primary underline underline-offset-4"
                  >查看{{ page.label }}原始资料</a
                >
              </li>
              <li v-for="href in notice.evidence.refreshHrefs" :key="href">
                <a
                  :href="href"
                  class="text-primary underline underline-offset-4"
                  >查看获取进度</a
                >
              </li>
            </ul>
          </div>
        </CollapsibleContent>
      </AlertDescription>
    </Alert>
  </Collapsible>
</template>
