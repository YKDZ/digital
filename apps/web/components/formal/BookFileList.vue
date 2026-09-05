<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery/client";

import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

defineProps<{ readonly asset: AssetViewModel }>();
</script>

<template>
  <Card v-if="asset.book?.files.length">
    <CardHeader><CardTitle>本地文件</CardTitle></CardHeader>
    <CardContent class="grid gap-2">
      <div
        v-for="file in asset.book.files"
        :key="file.name"
        class="flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2"
      >
        <span class="min-w-0 truncate">{{ file.name }}</span
        ><Badge variant="secondary">{{ file.format }}</Badge>
      </div>
    </CardContent>
  </Card>
</template>
