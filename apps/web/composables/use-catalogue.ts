import {
  emptyCatalogue,
  requestCatalogue,
  type CatalogueSnapshot,
} from "@digital/web-delivery";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

export function useCatalogue() {
  const catalogue = ref<CatalogueSnapshot>(emptyCatalogue);
  const loading = ref(true);
  const error = ref<string>();
  let pollingTimer: ReturnType<typeof setTimeout> | undefined;
  const hasLoaded = ref(false);
  const cataloguePageLoading = ref(false);
  const historyPageLoading = ref(false);
  const attentionPageLoading = ref(false);
  const cataloguePageEnd = computed(
    () =>
      hasLoaded.value &&
      catalogue.value.pagination.currentCatalogue.nextCursor === undefined,
  );
  const historyPageEnd = computed(
    () =>
      hasLoaded.value &&
      catalogue.value.pagination.workflowHistory.nextCursor === undefined,
  );
  const attentionPageEnd = computed(
    () =>
      hasLoaded.value &&
      catalogue.value.pagination.currentAttention.nextCursor === undefined,
  );
  const catalogueEmpty = computed(
    () => hasLoaded.value && catalogue.value.assets.length === 0,
  );
  const historyEmpty = computed(
    () => hasLoaded.value && catalogue.value.executions.length === 0,
  );
  const attentionEmpty = computed(
    () => hasLoaded.value && catalogue.value.attention.length === 0,
  );

  async function reload() {
    if (pollingTimer !== undefined) {
      clearTimeout(pollingTimer);
      pollingTimer = undefined;
    }
    if (!hasLoaded.value) loading.value = true;
    error.value = undefined;
    try {
      catalogue.value = await requestCatalogue();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "暂时无法读取内容";
    } finally {
      loading.value = false;
      hasLoaded.value = true;
      if (
        catalogue.value.executions.some((item) => item.status === "running")
      ) {
        pollingTimer = setTimeout(() => void reload(), 1_000);
      }
    }
  }

  async function loadMoreCatalogue() {
    const cursor = catalogue.value.pagination.currentCatalogue.nextCursor;
    if (cursor === undefined || cataloguePageLoading.value) return;
    cataloguePageLoading.value = true;
    try {
      const page = await requestCatalogue({
        surface: "current-catalogue",
        page: { cursor },
      });
      catalogue.value = {
        ...catalogue.value,
        assets: [...catalogue.value.assets, ...page.assets],
        pagination: {
          ...catalogue.value.pagination,
          currentCatalogue: page.pagination,
        },
      };
    } finally {
      cataloguePageLoading.value = false;
    }
  }

  async function loadMoreHistory() {
    const cursor = catalogue.value.pagination.workflowHistory.nextCursor;
    if (cursor === undefined || historyPageLoading.value) return;
    historyPageLoading.value = true;
    try {
      const page = await requestCatalogue({
        surface: "workflow-history",
        page: { cursor },
      });
      catalogue.value = {
        ...catalogue.value,
        executions: [...catalogue.value.executions, ...page.executions],
        pagination: {
          ...catalogue.value.pagination,
          workflowHistory: page.pagination,
        },
      };
    } finally {
      historyPageLoading.value = false;
    }
  }

  async function loadMoreAttention() {
    const cursor = catalogue.value.pagination.currentAttention.nextCursor;
    if (cursor === undefined || attentionPageLoading.value) return;
    attentionPageLoading.value = true;
    try {
      const page = await requestCatalogue({
        surface: "current-attention",
        page: { cursor },
      });
      catalogue.value = {
        ...catalogue.value,
        attention: [...catalogue.value.attention, ...page.attention],
        pagination: {
          ...catalogue.value.pagination,
          currentAttention: page.pagination,
        },
      };
    } finally {
      attentionPageLoading.value = false;
    }
  }

  onMounted(() => void reload());
  onBeforeUnmount(() => {
    if (pollingTimer !== undefined) clearTimeout(pollingTimer);
  });

  return {
    catalogue,
    error,
    loading,
    reload,
    loadMoreCatalogue,
    loadMoreHistory,
    loadMoreAttention,
    cataloguePageLoading,
    historyPageLoading,
    attentionPageLoading,
    cataloguePageEnd,
    historyPageEnd,
    attentionPageEnd,
    catalogueEmpty,
    historyEmpty,
    attentionEmpty,
  };
}
