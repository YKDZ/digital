<script setup lang="ts">
import { computed } from "vue";

import type { CatalogueAssetViewModel } from "#/lib/catalogue";

import BangumiAssetCard from "./BangumiAssetCard.vue";
import BookAssetCard from "./BookAssetCard.vue";
import DlsiteAssetCard from "./DlsiteAssetCard.vue";
import FanboxAssetCard from "./FanboxAssetCard.vue";
import FilmAssetCard from "./FilmAssetCard.vue";
import GenericAssetCard from "./GenericAssetCard.vue";

const props = defineProps<{ readonly asset: CatalogueAssetViewModel }>();
const bangumiAsset = computed(() =>
  "component" in props.asset && props.asset.component === "bangumi"
    ? props.asset
    : undefined,
);
const ordinaryAsset = computed(() =>
  "component" in props.asset ? undefined : props.asset,
);
</script>

<template>
  <BangumiAssetCard v-if="bangumiAsset" :asset="bangumiAsset" />
  <FanboxAssetCard
    v-else-if="ordinaryAsset?.cardComponent === 'fanbox'"
    :asset="ordinaryAsset"
  />
  <DlsiteAssetCard
    v-else-if="ordinaryAsset?.cardComponent === 'dlsite'"
    :asset="ordinaryAsset"
  />
  <FilmAssetCard
    v-else-if="ordinaryAsset?.cardComponent === 'film'"
    :asset="ordinaryAsset"
  />
  <BookAssetCard
    v-else-if="ordinaryAsset?.cardComponent === 'book'"
    :asset="ordinaryAsset"
  />
  <GenericAssetCard v-else-if="ordinaryAsset" :asset="ordinaryAsset" />
</template>
