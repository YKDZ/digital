import {
  requestAssetLibraries,
  type AssetLibraryView,
} from "@digital/web-delivery/client";
import { inject, provide, ref, type Ref } from "vue";

/** 侧栏、库标题与设置页共用的窄库导航状态。 */
export type LibraryNavigation = {
  readonly items: Ref<readonly AssetLibraryView[]>;
  readonly loading: Ref<boolean>;
  readonly error: Ref<string | undefined>;
  refresh(): Promise<void>;
};

const libraryNavigationKey = Symbol("asset-library-navigation");

export function createLibraryNavigation(): LibraryNavigation {
  const items = ref<readonly AssetLibraryView[]>([]);
  const loading = ref(true);
  const error = ref<string>();
  let generation = 0;
  return {
    items,
    loading,
    error,
    async refresh() {
      const request = ++generation;
      loading.value = true;
      error.value = undefined;
      try {
        const next = await requestAssetLibraries();
        // 只有最新一次刷新能提交结果，晚到的旧列表不会回退保存或移除后的状态。
        if (request !== generation) return;
        items.value = next;
      } catch (cause) {
        if (request !== generation) return;
        // 失败时保留已知列表，用户仍可继续浏览并可重试。
        error.value =
          cause instanceof Error ? cause.message : "暂时无法读取资产库";
      } finally {
        if (request === generation) loading.value = false;
      }
    },
  };
}

export function provideLibraryNavigation(navigation: LibraryNavigation): void {
  provide(libraryNavigationKey, navigation);
}

export function useLibraryNavigation(): LibraryNavigation {
  const navigation = inject(libraryNavigationKey, undefined);
  if (navigation !== undefined) return navigation;
  return createLibraryNavigation();
}
