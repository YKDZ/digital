<script setup lang="ts">
import {
  ArrowRight,
  Check,
  CircleAlert,
  Link2,
  LoaderCircle,
  PencilLine,
  Plus,
  RefreshCw,
} from "@lucide/vue";
import { usePageContext } from "vike-vue/usePageContext";
import { computed, onMounted, ref, watch } from "vue";
import { toast } from "vue-sonner";

import "vue-sonner/style.css";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Separator } from "#/components/ui/separator";
import { Skeleton } from "#/components/ui/skeleton";
import { Toaster } from "#/components/ui/sonner";
import { useCatalogue } from "#/composables/use-catalogue";
import { useIntake } from "#/composables/use-intake";

import IntakeFileTree from "./IntakeFileTree.vue";

type Intent = "add" | "correct" | "material";
type SourceRequirement = {
  readonly sourceIdentity: string;
  readonly displayName: string;
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly required: boolean;
    readonly acceptedInput: string;
    readonly example?: string;
  }[];
};
type SourceAssociation = {
  readonly id: string;
  readonly subjectId: string;
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
};
type CorrectionSubject = {
  readonly recognitionState: "recognized" | "unresolved";
  readonly current: readonly SourceAssociation[];
};
type SourceCandidate = {
  readonly reference: string;
  readonly outcome: "accepted" | "contradicted";
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
  readonly explanation: string;
};
type SourceDecision = {
  readonly executionId: string;
  readonly status: "running" | "completed" | "failed";
  readonly state:
    | "awaiting-selection"
    | "awaiting-confirmation"
    | "no-change"
    | "applied"
    | "rejected"
    | "stale"
    | "failed"
    | "cancelled"
    | "interrupted"
    | string;
  readonly predecessor?: SourceAssociation;
  readonly currentAssociations: readonly SourceAssociation[];
  readonly candidates: readonly SourceCandidate[];
  readonly failure?: string;
  readonly preview?: {
    readonly id: string;
    readonly status: "awaiting-confirmation" | "rejected" | "applied" | "stale";
    readonly sourceAssociations: readonly {
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
    }[];
    readonly current: {
      readonly metadata: readonly {
        readonly property: string;
        readonly value: string;
      }[];
    };
    readonly projected: {
      readonly metadata: readonly {
        readonly property: string;
        readonly value: string;
      }[];
    };
    readonly evidenceComparison: { readonly conflicts: readonly string[] };
    readonly blockingConditions: readonly string[];
  };
};
type MaterialInspection = {
  readonly executionId: string;
  readonly status: string;
  readonly reason?: string;
  readonly files: readonly {
    readonly relativePath: string;
    readonly disposition: "new-artifact" | "existing-artifact";
    readonly formatValid: boolean;
  }[];
};
type ContentOption = {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly detail: string;
  readonly fileCount?: number;
};

const actor = "web-user";
const pageContext = usePageContext();
const actions: { id: Intent; title: string; icon: typeof Plus }[] = [
  { id: "add", title: "添加元数据来源", icon: Plus },
  { id: "correct", title: "更正已有来源", icon: PencilLine },
  { id: "material", title: "关联其他文件", icon: Link2 },
];
const categoryLabels: Record<string, string> = {
  book: "书籍",
  film: "影片",
  dlsite: "音声",
  fanbox: "帖子",
  bangumi: "剧集",
  generic: "未分类",
};

const { catalogue, loading, error, reload } = useCatalogue();
const {
  snapshot,
  rootId,
  selected: selectedFiles,
  loading: filesLoading,
  scanning,
  chooseRoot,
  scan,
  select: selectFiles,
  load: loadFiles,
} = useIntake();
const intent = ref<Intent>("add");
const selectedAssetId = ref("");
const requirements = ref<readonly SourceRequirement[]>([]);
const requirementsError = ref("");
const sourceId = ref("");
const form = ref<Record<string, string>>({});
const correction = ref<CorrectionSubject>();
const correctionLoading = ref(false);
const correctionId = ref("");
const decision = ref<SourceDecision>();
const operationError = ref("");
const busy = ref(false);
const materialPreviewOpen = ref(false);
const availableActions = computed(() =>
  actions.filter(
    ({ id }) =>
      id !== "correct" ||
      correctionLoading.value ||
      (correction.value?.current.length ?? 0) > 0,
  ),
);

const assets = computed<ContentOption[]>(() => {
  const result: ContentOption[] = [];
  for (const entry of catalogue.value.assets) {
    if ("component" in entry) {
      result.push(
        ...entry.episodes.map((episode) => ({
          id: episode.assetId,
          title: episode.title,
          category: "bangumi",
          detail: entry.title,
        })),
      );
      continue;
    }
    const detail =
      entry.book?.contributors.join("、") ||
      entry.dlsite?.circle ||
      entry.fanbox?.creator ||
      entry.film?.directors.join("、") ||
      entry.releaseDate ||
      "";
    result.push({
      id: entry.id,
      title: entry.title,
      category: entry.cardComponent,
      detail,
      fileCount: entry.files?.length ?? entry.book?.files.length,
    });
  }
  return result;
});
const asset = computed(() =>
  assets.value.find((item) => item.id === selectedAssetId.value),
);
const selectedCorrection = computed(() =>
  correction.value?.current.find((item) => item.id === correctionId.value),
);
const requirement = computed(() =>
  requirements.value.find(
    (item) =>
      item.sourceIdentity ===
      (intent.value === "correct"
        ? selectedCorrection.value?.sourceIdentity
        : sourceId.value),
  ),
);
const selectableFiles = computed(() =>
  snapshot.value.files.filter(
    (file) => !file.assetIds.includes(selectedAssetId.value),
  ),
);
const previewTitle = computed(
  () =>
    decision.value?.preview?.projected.metadata.find(
      (item) => item.property === "asset.title",
    )?.value,
);
const currentTitle = computed(
  () =>
    decision.value?.preview?.current.metadata.find(
      (item) => item.property === "asset.title",
    )?.value,
);
const proposedAssociation = computed(() => {
  const predecessor = decision.value?.predecessor;
  if (predecessor === undefined) return undefined;
  const retained = new Set(
    decision.value?.currentAssociations
      .filter((item) => item.id !== predecessor.id)
      .map((item) => `${item.sourceIdentity}\u0000${item.nativeAddress}`),
  );
  return decision.value?.preview?.sourceAssociations.find(
    (item) =>
      item.sourceIdentity === predecessor.sourceIdentity &&
      !retained.has(`${item.sourceIdentity}\u0000${item.nativeAddress}`),
  );
});
const inputsComplete = computed(
  () =>
    requirement.value !== undefined &&
    requirement.value.fields.every(
      (field) => !field.required || form.value[field.key]?.trim(),
    ),
);

function sourceName(identity: string) {
  return (
    requirements.value.find((item) => item.sourceIdentity === identity)
      ?.displayName ?? identity
  );
}
function resetForm() {
  form.value = Object.fromEntries(
    (requirement.value?.fields ?? []).map((field) => [field.key, ""]),
  );
  decision.value = undefined;
  operationError.value = "";
}
function chooseIntent(value: Intent) {
  intent.value = value;
  decision.value = undefined;
  operationError.value = "";
  materialPreviewOpen.value = false;
  if (value === "correct") {
    correctionId.value = correction.value?.current[0]?.id ?? "";
  }
  resetForm();
}
function chooseSource(value: string) {
  sourceId.value = value;
  resetForm();
}
function chooseCorrection(value: string) {
  correctionId.value = value;
  resetForm();
}
function updateField(key: string, value: string | number) {
  form.value = { ...form.value, [key]: String(value) };
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(data.error ?? "操作暂时无法完成");
  return data;
}
async function post<T>(path: string, body?: object): Promise<T> {
  return await request<T>(path, {
    method: "POST",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function poll<T>(path: string, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = await request<T>(path);
    if (done(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("处理时间较长，请稍后重试");
}
async function loadRequirements() {
  requirementsError.value = "";
  try {
    requirements.value =
      await request<readonly SourceRequirement[]>("/api/source-inputs");
    if (!sourceId.value)
      sourceId.value = requirements.value[0]?.sourceIdentity ?? "";
    resetForm();
  } catch (cause) {
    requirementsError.value = message(cause, "暂时无法读取元数据来源");
  }
}
async function loadCorrection() {
  if (!selectedAssetId.value) return;
  correctionLoading.value = true;
  try {
    correction.value = await request<CorrectionSubject>(
      `/api/correction-subjects/${encodeURIComponent(selectedAssetId.value)}`,
    );
    correctionId.value = correction.value.current[0]?.id ?? "";
    if (intent.value === "correct") {
      if (correction.value.current.length === 0) intent.value = "add";
      resetForm();
    }
  } catch {
    correction.value = { recognitionState: "unresolved", current: [] };
    correctionId.value = "";
  } finally {
    correctionLoading.value = false;
  }
}
async function addSource() {
  if (!asset.value || !requirement.value || !inputsComplete.value || busy.value)
    return;
  busy.value = true;
  operationError.value = "";
  try {
    const started = await post<{ readonly id: string }>(
      "/api/source-enrichments",
      {
        subjectId: asset.value.id,
        sourceIdentity: requirement.value.sourceIdentity,
        sourceInput: form.value,
      },
    );
    const result = await poll<{
      readonly status: string;
      readonly outcome?: string;
      readonly reason?: string;
    }>(
      `/api/source-enrichments/${encodeURIComponent(started.id)}`,
      (value) => value.status !== "running",
    );
    if (result.outcome !== "accepted" && result.outcome !== "no-change")
      throw new Error(result.reason ?? "没有找到可采用的元数据");
    toast.success(
      result.outcome === "no-change" ? "这项来源已经存在" : "元数据来源已添加",
    );
    await Promise.all([reload(), loadCorrection()]);
  } catch (cause) {
    operationError.value = message(cause, "元数据来源暂时无法添加");
  } finally {
    busy.value = false;
  }
}
async function correctSource() {
  if (
    !asset.value ||
    !selectedCorrection.value ||
    !inputsComplete.value ||
    busy.value
  )
    return;
  busy.value = true;
  operationError.value = "";
  try {
    const started = await post<{ readonly id: string }>(
      "/api/source-association-decisions",
      {
        intent: "replace",
        assetId: asset.value.id,
        predecessorAssociationId: selectedCorrection.value.id,
        sourceInput: form.value,
        initiatedBy: actor,
      },
    );
    decision.value = await waitForDecision(started.id);
    if (decision.value.state === "no-change") {
      toast.success("来源信息没有变化");
      decision.value = undefined;
    } else if (decision.value.state === "failed") {
      operationError.value = decision.value.failure ?? "没有找到可采用的元数据";
    }
  } catch (cause) {
    operationError.value = message(cause, "暂时无法更正这个来源");
  } finally {
    busy.value = false;
  }
}
async function waitForDecision(id: string) {
  return await poll<SourceDecision>(
    `/api/source-association-decisions/${encodeURIComponent(id)}`,
    (value) =>
      value.state === "awaiting-selection" ||
      value.state === "awaiting-confirmation" ||
      value.state === "no-change" ||
      value.state === "failed" ||
      value.state === "interrupted" ||
      value.state === "cancelled",
  );
}
async function selectCandidate(reference: string) {
  if (!decision.value || busy.value) return;
  busy.value = true;
  operationError.value = "";
  try {
    decision.value = await post<SourceDecision>(
      `/api/source-association-decisions/${encodeURIComponent(decision.value.executionId)}/select`,
      { candidateReference: reference },
    );
  } catch (cause) {
    operationError.value = message(cause, "暂时无法选择这项结果");
  } finally {
    busy.value = false;
  }
}
async function retryCorrection() {
  if (!decision.value || busy.value) return;
  busy.value = true;
  operationError.value = "";
  try {
    await post(
      `/api/source-association-decisions/${encodeURIComponent(decision.value.executionId)}/retry`,
    );
    decision.value = await waitForDecision(decision.value.executionId);
    if (decision.value.state === "failed")
      operationError.value = decision.value.failure ?? "没有找到可采用的元数据";
  } catch (cause) {
    operationError.value = message(cause, "暂时无法重试");
  } finally {
    busy.value = false;
  }
}
async function cancelCorrection() {
  if (!decision.value || busy.value) return;
  busy.value = true;
  try {
    await post(
      `/api/executions/${encodeURIComponent(decision.value.executionId)}/cancel`,
      { requestedBy: actor },
    );
    decision.value = undefined;
    operationError.value = "";
    toast.success("已取消更正");
  } catch (cause) {
    operationError.value = message(cause, "暂时无法取消这次更正");
  } finally {
    busy.value = false;
  }
}
async function decideCorrection(action: "apply" | "reject") {
  const preview = decision.value?.preview;
  if (!preview || busy.value) return;
  busy.value = true;
  try {
    const result = await post<{ readonly status: string }>("/api/preview", {
      action,
      previewId: preview.id,
      actorId: actor,
    });
    if (result.status === "stale") throw new Error("结果已经变化，请重新查询");
    toast.success(action === "apply" ? "来源已更正" : "已取消更正");
    decision.value = undefined;
    if (action === "apply") await Promise.all([reload(), loadCorrection()]);
  } catch (cause) {
    operationError.value = message(cause, "暂时无法处理这次更正");
  } finally {
    busy.value = false;
  }
}
async function confirmMaterials() {
  if (
    !asset.value ||
    !rootId.value ||
    !selectedFiles.value.length ||
    busy.value
  )
    return;
  busy.value = true;
  operationError.value = "";
  try {
    const started = await post<{ readonly id: string }>(
      "/api/observed-material-associations",
      {
        targetAssetId: asset.value.id,
        registrationId: rootId.value,
        relativeScope: ".",
        relativePaths: selectedFiles.value,
        initiatedBy: actor,
      },
    );
    const prepared = await poll<MaterialInspection>(
      `/api/observed-material-associations/${encodeURIComponent(started.id)}`,
      (value) =>
        value.status === "awaiting-confirmation" ||
        value.status === "accepted" ||
        value.status === "no-change" ||
        value.status === "stale" ||
        value.status === "failed" ||
        value.status === "interrupted",
    );
    if (prepared.status !== "awaiting-confirmation")
      throw new Error(prepared.reason ?? "这些文件暂时无法关联");
    await post(
      `/api/observed-material-associations/${encodeURIComponent(started.id)}/confirm`,
      { confirmedBy: actor },
    );
    const result = await poll<MaterialInspection>(
      `/api/observed-material-associations/${encodeURIComponent(started.id)}`,
      (value) =>
        value.status === "accepted" ||
        value.status === "no-change" ||
        value.status === "stale" ||
        value.status === "failed" ||
        value.status === "interrupted",
    );
    if (result.status !== "accepted" && result.status !== "no-change")
      throw new Error(result.reason ?? "这些文件暂时无法关联");
    materialPreviewOpen.value = false;
    selectedFiles.value = [];
    toast.success(
      result.status === "no-change" ? "这些文件已经关联" : "文件已关联",
    );
    await Promise.all([reload(), loadCorrection(), loadFiles(rootId.value)]);
  } catch (cause) {
    operationError.value = message(cause, "这些文件暂时无法关联");
  } finally {
    busy.value = false;
  }
}
function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

watch(
  assets,
  (items) => {
    if (
      !items.length ||
      items.some((item) => item.id === selectedAssetId.value)
    )
      return;
    const requested = pageContext.urlParsed.search.asset;
    selectedAssetId.value =
      items.find((item) => item.id === requested)?.id ?? items[0]!.id;
  },
  { immediate: true },
);
watch(selectedAssetId, () => {
  decision.value = undefined;
  operationError.value = "";
  selectedFiles.value = [];
  void loadCorrection();
});
watch(requirement, resetForm);
onMounted(() => void loadRequirements());
</script>

<template>
  <section class="mx-auto w-full max-w-5xl">
    <header class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight">整理内容</h1>
      <div
        v-if="loading"
        class="mt-4 flex items-center gap-3 rounded-xl border p-3"
      >
        <Skeleton class="h-9 flex-1" /><Skeleton class="h-6 w-14" />
      </div>
      <div
        v-else-if="error"
        class="mt-4 flex items-center justify-between gap-3 rounded-xl border p-3"
      >
        <span class="text-sm text-destructive">{{ error }}</span>
        <Button size="sm" variant="outline" @click="reload">重试</Button>
      </div>
      <div
        v-else-if="assets.length"
        class="mt-4 flex flex-wrap items-center gap-3 rounded-xl border bg-muted/20 p-3"
      >
        <span class="text-sm font-medium">正在整理</span>
        <Select v-model="selectedAssetId">
          <SelectTrigger
            class="min-w-64 flex-1 bg-background"
            aria-label="正在整理的内容"
            ><SelectValue
          /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="item in assets" :key="item.id" :value="item.id">
              {{ item.title }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Badge variant="secondary">{{
          categoryLabels[asset?.category ?? "generic"]
        }}</Badge>
      </div>
    </header>

    <div
      v-if="!loading && !error && !assets.length"
      class="grid min-h-72 place-content-center justify-items-center gap-4 rounded-xl border border-dashed"
    >
      <p class="text-muted-foreground">还没有可以整理的内容</p>
      <Button as="a" href="/intake">添加内容</Button>
    </div>

    <template v-else-if="asset">
      <div class="grid gap-3 md:grid-cols-3">
        <button
          v-for="action in availableActions"
          :key="action.id"
          class="group rounded-xl border p-4 text-left transition hover:border-foreground/30"
          :class="
            intent === action.id &&
            'border-primary bg-primary/[0.04] ring-1 ring-primary'
          "
          @click="chooseIntent(action.id)"
        >
          <span class="flex items-center gap-3">
            <span
              class="grid size-9 place-content-center rounded-lg bg-secondary"
            >
              <component :is="action.icon" class="size-4" />
            </span>
            <span class="font-medium">{{ action.title }}</span>
            <ArrowRight class="ml-auto size-4 text-muted-foreground" />
          </span>
        </button>
      </div>

      <div class="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <Card class="shadow-none">
          <CardContent class="p-5 sm:p-6">
            <Alert v-if="requirementsError" variant="destructive">
              <CircleAlert />
              <AlertTitle>暂时无法读取元数据来源</AlertTitle>
              <AlertDescription>{{ requirementsError }}</AlertDescription>
              <Button
                class="col-start-2 mt-3 w-fit"
                size="sm"
                variant="outline"
                @click="loadRequirements"
                >重试</Button
              >
            </Alert>

            <div v-else-if="intent === 'material'" class="space-y-4">
              <div class="flex flex-wrap items-end gap-3">
                <label class="grid min-w-52 flex-1 gap-2 text-sm font-medium">
                  文件位置
                  <Select
                    :model-value="rootId"
                    :disabled="filesLoading || scanning || busy"
                    @update:model-value="(value) => chooseRoot(String(value))"
                  >
                    <SelectTrigger
                      ><SelectValue placeholder="选择文件位置"
                    /></SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        v-for="root in snapshot.roots"
                        :key="root.id"
                        :value="root.id"
                        >{{ root.displayName }}</SelectItem
                      >
                    </SelectContent>
                  </Select>
                </label>
                <Button
                  variant="outline"
                  :disabled="!rootId || filesLoading || scanning || busy"
                  @click="scan"
                  ><LoaderCircle v-if="scanning" class="animate-spin" />{{
                    scanning ? "正在检查" : "检查文件"
                  }}</Button
                >
              </div>
              <div
                class="max-h-[48dvh] min-h-56 overflow-y-auto rounded-lg border p-2"
              >
                <p
                  v-if="filesLoading"
                  class="py-16 text-center text-sm text-muted-foreground"
                >
                  正在读取文件
                </p>
                <IntakeFileTree
                  v-else-if="selectableFiles.length"
                  :files="selectableFiles"
                  :selected="selectedFiles"
                  :disabled="scanning || busy"
                  @select="selectFiles"
                />
                <p
                  v-else
                  class="py-16 text-center text-sm text-muted-foreground"
                >
                  {{
                    snapshot.execution
                      ? "没有其他可关联的文件"
                      : "检查文件后即可选择"
                  }}
                </p>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span class="text-sm text-muted-foreground"
                  >已选择 {{ selectedFiles.length }} 个文件</span
                >
                <Button
                  :disabled="!selectedFiles.length || busy"
                  @click="materialPreviewOpen = true"
                  >查看变化</Button
                >
              </div>
            </div>

            <div
              v-else-if="intent === 'correct' && correctionLoading"
              class="space-y-3"
            >
              <Skeleton class="h-16 w-full" /><Skeleton class="h-9 w-full" />
            </div>

            <div
              v-else-if="intent === 'correct' && !correction?.current.length"
              class="grid min-h-64 place-content-center justify-items-center gap-4 text-center"
            >
              <div>
                <h2 class="font-semibold">还没有可更正的来源</h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  可以先为这项内容添加元数据来源。
                </p>
              </div>
              <Button @click="chooseIntent('add')">添加元数据来源</Button>
            </div>

            <div v-else class="space-y-4">
              <div v-if="intent === 'correct'" class="space-y-2">
                <p class="text-sm font-medium">要更正的来源</p>
                <div class="grid gap-2 sm:grid-cols-2">
                  <button
                    v-for="item in correction?.current"
                    :key="item.id"
                    class="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left hover:bg-muted"
                    :class="
                      correctionId === item.id &&
                      'border-primary bg-primary/[0.04] ring-1 ring-primary'
                    "
                    @click="chooseCorrection(item.id)"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block text-sm font-medium">{{
                        sourceName(item.sourceIdentity)
                      }}</span>
                      <span
                        class="block truncate text-sm text-muted-foreground"
                        >{{ item.nativeAddress }}</span
                      >
                    </span>
                    <Check
                      v-if="correctionId === item.id"
                      class="size-4 shrink-0"
                    />
                  </button>
                </div>
              </div>

              <div
                class="grid gap-3"
                :class="intent === 'add' && 'sm:grid-cols-[12rem_1fr]'"
              >
                <label
                  v-if="intent === 'add'"
                  class="grid gap-2 text-sm font-medium"
                >
                  元数据来源
                  <Select
                    :model-value="sourceId"
                    @update:model-value="(value) => chooseSource(String(value))"
                  >
                    <SelectTrigger class="w-full"
                      ><SelectValue placeholder="选择元数据来源"
                    /></SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        v-for="item in requirements"
                        :key="item.sourceIdentity"
                        :value="item.sourceIdentity"
                        >{{ item.displayName }}</SelectItem
                      >
                    </SelectContent>
                  </Select>
                </label>
                <div
                  class="grid gap-3"
                  :class="
                    (requirement?.fields.length ?? 0) > 1 && 'sm:grid-cols-2'
                  "
                >
                  <label
                    v-for="field in requirement?.fields"
                    :key="field.key"
                    class="grid gap-2 text-sm font-medium"
                  >
                    {{
                      intent === "correct" ? `新的 ${field.label}` : field.label
                    }}
                    <Input
                      :model-value="form[field.key]"
                      :placeholder="field.example ?? field.acceptedInput"
                      :disabled="busy"
                      @update:model-value="
                        (value) => updateField(field.key, value)
                      "
                    />
                    <span class="font-normal text-muted-foreground">{{
                      field.acceptedInput
                    }}</span>
                  </label>
                </div>
              </div>

              <Alert v-if="operationError" variant="destructive">
                <CircleAlert />
                <AlertTitle>{{
                  intent === "add" ? "元数据来源未添加" : "更正未完成"
                }}</AlertTitle>
                <AlertDescription>{{ operationError }}</AlertDescription>
                <Button
                  v-if="decision?.state === 'failed'"
                  class="col-start-2 mt-3 w-fit px-3"
                  size="sm"
                  variant="outline"
                  :disabled="busy"
                  @click="retryCorrection"
                  ><RefreshCw />重试</Button
                >
              </Alert>

              <div
                v-if="decision?.state === 'awaiting-selection'"
                class="space-y-2"
              >
                <p class="text-sm font-medium">选择查询结果</p>
                <button
                  v-for="candidate in decision.candidates"
                  :key="candidate.reference"
                  class="flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted"
                  :disabled="busy"
                  @click="selectCandidate(candidate.reference)"
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">{{
                      candidate.nativeAddress
                    }}</span>
                    <span class="mt-1 block text-sm text-muted-foreground">{{
                      candidate.explanation
                    }}</span>
                  </span>
                  <ArrowRight class="size-4 shrink-0" />
                </button>
                <Button
                  class="w-full"
                  variant="outline"
                  :disabled="busy"
                  @click="cancelCorrection"
                  >取消</Button
                >
              </div>

              <Button
                v-if="decision?.state !== 'awaiting-selection'"
                class="w-full"
                :disabled="!inputsComplete || busy"
                @click="intent === 'add' ? addSource() : correctSource()"
              >
                <LoaderCircle v-if="busy" class="animate-spin" />
                {{
                  busy ? "正在查询" : intent === "add" ? "查询并添加" : "查询"
                }}
              </Button>
            </div>
          </CardContent>
        </Card>

        <aside class="space-y-4 rounded-xl bg-muted/35 p-5">
          <div>
            <p class="text-sm text-muted-foreground">当前内容</p>
            <p class="mt-2 font-medium leading-snug">{{ asset.title }}</p>
            <p v-if="asset.detail" class="mt-2 text-sm text-muted-foreground">
              {{ asset.detail }}
            </p>
          </div>
          <div>
            <p class="text-sm text-muted-foreground">元数据来源</p>
            <p class="mt-2 text-sm">
              {{
                correctionLoading
                  ? "正在读取"
                  : correction?.current.length
                    ? `${correction.current.length} 项`
                    : "还没有元数据来源"
              }}
            </p>
          </div>
          <div>
            <p class="text-sm text-muted-foreground">文件</p>
            <p class="mt-2 text-sm">
              {{
                asset.fileCount === undefined ? "—" : `${asset.fileCount} 个`
              }}
            </p>
          </div>
        </aside>
      </div>
    </template>

    <Dialog
      :open="decision?.state === 'awaiting-confirmation'"
      @update:open="(open) => !open && decideCorrection('reject')"
    >
      <DialogContent :aria-describedby="undefined">
        <DialogHeader><DialogTitle>确认更正</DialogTitle></DialogHeader>
        <div class="space-y-4 text-sm">
          <div>
            <p class="text-muted-foreground">当前来源</p>
            <p class="mt-1 font-medium">
              {{ sourceName(decision?.predecessor?.sourceIdentity ?? "") }}
            </p>
            <p class="mt-1 break-all">
              {{ decision?.predecessor?.nativeAddress }}
            </p>
          </div>
          <Separator />
          <div>
            <p class="text-muted-foreground">更正后</p>
            <p class="mt-1 font-medium">
              {{ sourceName(proposedAssociation?.sourceIdentity ?? "") }}
            </p>
            <p class="mt-1 break-all">
              {{ proposedAssociation?.nativeAddress }}
            </p>
          </div>
          <div
            v-if="currentTitle && previewTitle && currentTitle !== previewTitle"
            class="rounded-lg bg-muted p-3"
          >
            <p class="text-muted-foreground">名称</p>
            <p class="mt-1 line-through">{{ currentTitle }}</p>
            <p class="mt-1 font-medium">{{ previewTitle }}</p>
          </div>
          <Alert
            v-for="conflict in decision?.preview?.evidenceComparison.conflicts"
            :key="conflict"
            variant="destructive"
          >
            <CircleAlert /><AlertTitle>发现冲突</AlertTitle
            ><AlertDescription>{{ conflict }}</AlertDescription>
          </Alert>
          <Alert
            v-for="condition in decision?.preview?.blockingConditions"
            :key="condition"
            variant="destructive"
          >
            <CircleAlert /><AlertTitle>不能应用这次更正</AlertTitle
            ><AlertDescription>{{ condition }}</AlertDescription>
          </Alert>
          <p>已有文件与其他来源保持不变。</p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            :disabled="busy"
            @click="decideCorrection('reject')"
            >取消</Button
          >
          <Button
            :disabled="busy || !!decision?.preview?.blockingConditions.length"
            @click="decideCorrection('apply')"
            ><LoaderCircle v-if="busy" class="animate-spin" />确认更正</Button
          >
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="materialPreviewOpen">
      <DialogContent :aria-describedby="undefined">
        <DialogHeader><DialogTitle>关联文件</DialogTitle></DialogHeader>
        <div class="space-y-3 text-sm">
          <p class="font-medium">{{ asset?.title }}</p>
          <p class="text-muted-foreground">
            将增加 {{ selectedFiles.length }} 个文件，已有文件保持不变。
          </p>
          <ul
            class="max-h-52 space-y-1 overflow-y-auto rounded-lg bg-muted/40 p-3"
          >
            <li
              v-for="file in selectedFiles"
              :key="file"
              class="truncate"
              :title="file"
            >
              {{ file }}
            </li>
          </ul>
        </div>
        <Alert v-if="operationError" variant="destructive">
          <CircleAlert /><AlertTitle>关联未完成</AlertTitle
          ><AlertDescription>{{ operationError }}</AlertDescription>
        </Alert>
        <DialogFooter>
          <Button
            variant="outline"
            :disabled="busy"
            @click="materialPreviewOpen = false"
            >取消</Button
          >
          <Button :disabled="busy" @click="confirmMaterials">
            <LoaderCircle v-if="busy" class="animate-spin" />确认关联
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Toaster />
  </section>
</template>
