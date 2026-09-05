import {
  requestIntake,
  sendAction,
  type IntakeContent,
  type IntakeSnapshot,
} from "@digital/web-delivery/client";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { toast } from "vue-sonner";

export function useIntake() {
  const snapshot = ref<IntakeSnapshot>({ roots: [], files: [], contents: [] });
  const rootId = ref("");
  const selected = ref<string[]>([]);
  const contents = ref<IntakeContent[]>([]);
  const error = ref("");
  const loading = ref(true);
  const starting = ref(false);
  const preparing = ref(false);
  const saving = ref(false);
  const contentErrors = ref<Record<string, string>>({});
  const scanning = computed(
    () => starting.value || snapshot.value.execution?.status === "running",
  );
  const busy = computed(() => preparing.value || saving.value);
  const drafts = computed(() =>
    contents.value.filter((content) => content.status === "proposed"),
  );
  const usedPaths = computed(
    () => new Set(contents.value.flatMap((content) => content.relativePaths)),
  );
  const remaining = computed(() =>
    snapshot.value.files.filter(
      (file) =>
        file.assetIds.length === 0 && !usedPaths.value.has(file.relativePath),
    ),
  );
  let version = 0;
  let disposed = false;
  let poll: ReturnType<typeof setTimeout> | undefined;

  function remember() {
    try {
      sessionStorage.setItem(
        `digital.intake.${rootId.value}`,
        JSON.stringify(contents.value.map((content) => content.executionId)),
      );
    } catch {
      /* 会话存储不可用时仍可操作；资产与提案的权威始终在产品中。 */
    }
  }

  async function restore(requestRoot: string) {
    let references: unknown;
    try {
      references = JSON.parse(
        sessionStorage.getItem(`digital.intake.${requestRoot}`) ?? "[]",
      );
    } catch {
      return [];
    }
    if (
      !Array.isArray(references) ||
      !references.every((value: unknown) => typeof value === "string")
    )
      return [];
    const restored = await Promise.allSettled(
      references.map(async (reference: string) => {
        const response = await fetch(
          `/api/intake/reviews/${encodeURIComponent(reference)}`,
        );
        if (!response.ok) throw new Error("未找到整理记录");
        return (await response.json()) as IntakeContent;
      }),
    );
    return restored.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
  }

  async function load(
    requestRoot?: string,
    executionId?: string,
    restoreContents = false,
  ) {
    const requestVersion = ++version;
    clearTimeout(poll);
    try {
      const result = await requestIntake({
        ...(requestRoot ? { rootId: requestRoot } : {}),
        ...(executionId ? { executionId } : {}),
      });
      const restored =
        restoreContents && result.rootId
          ? await restore(result.rootId)
          : undefined;
      if (disposed || requestVersion !== version) return;
      snapshot.value = result;
      rootId.value = result.rootId ?? "";
      error.value = "";
      if (restored !== undefined) contents.value = restored;
      const available = new Set(
        remaining.value
          .filter((file) => !file.problem)
          .map((file) => file.relativePath),
      );
      selected.value = selected.value.filter((reference) =>
        available.has(reference),
      );
      if (result.execution?.status === "running")
        poll = setTimeout(
          () => void load(result.rootId, result.execution?.id),
          800,
        );
    } catch (cause) {
      if (!disposed && requestVersion === version)
        error.value = message(cause, "暂时无法读取文件");
    } finally {
      if (!disposed && requestVersion === version) loading.value = false;
    }
  }

  async function chooseRoot(value: string) {
    rootId.value = value;
    selected.value = [];
    contents.value = [];
    loading.value = true;
    await load(value, undefined, true);
  }

  async function scan() {
    if (!rootId.value || scanning.value || busy.value) return;
    starting.value = true;
    error.value = "";
    try {
      const execution = await sendAction<{ id: string }>("/api/refresh", {
        observedRootId: rootId.value,
        relativeScope: ".",
      });
      await load(rootId.value, execution.id);
    } catch (cause) {
      error.value = message(cause, "检查未能开始，请重试");
    } finally {
      starting.value = false;
    }
  }

  function select(references: string[], checked: boolean) {
    selected.value = checked
      ? [...new Set([...selected.value, ...references])]
      : selected.value.filter((reference) => !references.includes(reference));
  }

  async function prepare(
    name: string,
    classification: string,
  ): Promise<boolean> {
    if (!snapshot.value.execution || preparing.value) return false;
    preparing.value = true;
    try {
      const content = await sendAction<IntakeContent>("/api/intake", {
        action: "prepare",
        executionId: snapshot.value.execution.id,
        relativePaths: selected.value,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(classification === "unknown" ? {} : { classification }),
      });
      contents.value.push(content);
      selected.value = [];
      remember();
      return true;
    } catch (cause) {
      toast.error(message(cause, "这些文件暂时无法组成内容"));
      return false;
    } finally {
      preparing.value = false;
    }
  }

  function remove(executionId: string) {
    contents.value = contents.value.filter(
      (content) =>
        content.executionId !== executionId || content.status === "accepted",
    );
    remember();
  }

  async function save() {
    if (saving.value) return;
    saving.value = true;
    let saved = 0;
    for (const content of drafts.value) {
      try {
        const accepted = await sendAction<IntakeContent>("/api/intake", {
          action: "confirm",
          executionId: content.executionId,
        });
        contents.value = contents.value.map((item) =>
          item.executionId === content.executionId ? accepted : item,
        );
        delete contentErrors.value[content.executionId];
        saved += 1;
      } catch (cause) {
        contentErrors.value[content.executionId] = message(
          cause,
          "添加未完成，请重试",
        );
      }
    }
    remember();
    saving.value = false;
    if (saved) toast.success(`已添加 ${saved} 项内容`);
    if (drafts.value.length) toast.error("部分内容尚未添加，请检查后继续");
    await load(rootId.value, snapshot.value.execution?.id);
  }

  onMounted(() => void load(undefined, undefined, true));
  onBeforeUnmount(() => {
    disposed = true;
    version += 1;
    clearTimeout(poll);
  });
  return {
    snapshot,
    rootId,
    selected,
    contents,
    drafts,
    remaining,
    contentErrors,
    error,
    loading,
    scanning,
    preparing,
    saving,
    busy,
    load,
    chooseRoot,
    scan,
    select,
    prepare,
    remove,
    save,
  };
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
