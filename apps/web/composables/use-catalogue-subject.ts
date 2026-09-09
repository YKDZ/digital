import {
  requestCatalogueSubject,
  type CatalogueSubjectResponse,
} from "@digital/web-delivery/client";
import {
  onBeforeUnmount,
  onMounted,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from "vue";

export function useCatalogueSubject(id: MaybeRefOrGetter<string>) {
  const selected = ref<CatalogueSubjectResponse>();
  const loading = ref(true);
  const error = ref<string>();
  let version = 0;
  let controller: AbortController | undefined;
  async function reload() {
    const requestVersion = ++version;
    controller?.abort();
    controller = new AbortController();
    loading.value = selected.value === undefined;
    error.value = undefined;
    try {
      const result = await requestCatalogueSubject(
        toValue(id),
        controller.signal,
      );
      if (requestVersion === version) selected.value = result;
    } catch {
      if (requestVersion === version) error.value = "暂时无法读取内容";
    } finally {
      if (requestVersion === version) loading.value = false;
    }
  }
  onMounted(() => void reload());
  watch(
    () => toValue(id),
    () => {
      selected.value = undefined;
      void reload();
    },
  );
  onBeforeUnmount(() => {
    version += 1;
    controller?.abort();
  });
  return { selected, loading, error, reload };
}
