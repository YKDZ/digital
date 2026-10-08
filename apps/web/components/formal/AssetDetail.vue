<script setup lang="ts">
import type { CatalogueAssetViewModel } from "@digital/web-delivery/client";
import { computed } from "vue";

import AssetActions from "./AssetActions.vue";
import AssetInfoNotice from "./AssetInfoNotice.vue";
import BangumiAssetDetail from "./BangumiAssetDetail.vue";
import BangumiEpisodeDetail from "./BangumiEpisodeDetail.vue";
import BookAssetDetail from "./BookAssetDetail.vue";
import DlsiteAssetDetail from "./DlsiteAssetDetail.vue";
import FanboxAssetDetail from "./FanboxAssetDetail.vue";
import FilmAssetDetail from "./FilmAssetDetail.vue";
import GenericAssetDetail from "./GenericAssetDetail.vue";

const emit = defineEmits<{ refreshed: [] }>();
const props = withDefaults(
  defineProps<{
    readonly asset: CatalogueAssetViewModel;
    readonly selectedEpisodeId?: string;
    readonly selectedWorkId?: string;
    readonly library?: string;
    readonly showActions?: boolean;
  }>(),
  { showActions: true },
);
const bangumiAsset = computed(() =>
  "component" in props.asset && props.asset.component === "bangumi"
    ? props.asset
    : undefined,
);
const ordinaryAsset = computed(() =>
  "component" in props.asset ? undefined : props.asset,
);
const selectedBangumiEpisode = computed(() => {
  if (bangumiAsset.value === undefined || props.selectedEpisodeId === undefined)
    return undefined;
  for (const work of bangumiAsset.value.works) {
    const episode = work.episodes.find(
      (item) => item.assetId === props.selectedEpisodeId,
    );
    if (episode !== undefined) return { work, episode };
  }
  return undefined;
});
</script>

<template>
  <AssetInfoNotice v-if="ordinaryAsset" :asset="ordinaryAsset" />
  <BangumiEpisodeDetail
    v-if="bangumiAsset && selectedBangumiEpisode"
    :series="bangumiAsset"
    :work="selectedBangumiEpisode.work"
    :episode="selectedBangumiEpisode.episode"
    :show-actions="showActions"
    @refreshed="emit('refreshed')"
  />
  <BangumiAssetDetail
    v-else-if="bangumiAsset"
    :asset="bangumiAsset"
    :selected-work-id="selectedWorkId"
    :library="library"
    :show-actions="showActions"
  />
  <FanboxAssetDetail
    v-else-if="ordinaryAsset?.detailComponent === 'fanbox'"
    :asset="ordinaryAsset"
    :show-actions="showActions"
    @refreshed="emit('refreshed')"
  />
  <DlsiteAssetDetail
    v-else-if="ordinaryAsset?.detailComponent === 'dlsite'"
    :asset="ordinaryAsset"
  >
    <template v-if="showActions" #actions>
      <AssetActions
        :target="ordinaryAsset.refreshTarget"
        @done="emit('refreshed')"
      />
    </template>
  </DlsiteAssetDetail>
  <FilmAssetDetail
    v-else-if="ordinaryAsset?.detailComponent === 'film'"
    :asset="ordinaryAsset"
    :show-actions="showActions"
    @refreshed="emit('refreshed')"
  />
  <BookAssetDetail
    v-else-if="ordinaryAsset?.detailComponent === 'book'"
    :asset="ordinaryAsset"
    :show-actions="showActions"
    @refreshed="emit('refreshed')"
  />
  <GenericAssetDetail
    v-else-if="ordinaryAsset"
    :asset="ordinaryAsset"
    :show-actions="showActions"
    @refreshed="emit('refreshed')"
  />
</template>
