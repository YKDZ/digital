<script setup lang="ts">
import type { AssetViewModel } from "@digital/web-delivery";

import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

defineProps<{ readonly asset: AssetViewModel }>();
</script>

<template>
  <Card v-if="asset.book">
    <CardHeader><CardTitle>出版信息</CardTitle></CardHeader>
    <CardContent>
      <dl class="grid gap-3 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
        <template v-if="asset.book.publisher"
          ><dt class="text-muted-foreground">出版社</dt>
          <dd>{{ asset.book.publisher }}</dd></template
        >
        <template v-if="asset.book.publicationDate"
          ><dt class="text-muted-foreground">出版日期</dt>
          <dd>{{ asset.book.publicationDate }}</dd></template
        >
        <template v-if="asset.book.language"
          ><dt class="text-muted-foreground">语言</dt>
          <dd>{{ asset.book.language }}</dd></template
        >
        <template v-if="asset.book.isbn13"
          ><dt class="text-muted-foreground">ISBN</dt>
          <dd class="break-all">{{ asset.book.isbn13 }}</dd></template
        >
      </dl>
    </CardContent>
  </Card>
</template>
