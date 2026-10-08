<script setup lang="ts">
import {
  requestCatalogueSubject,
  requestConflictEvidence,
  type CatalogueAssetViewModel,
  type ConflictEvidence,
} from "@digital/web-delivery/client";
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
import { assetFactNotice, friendlyCoordinate } from "#/lib/asset-fact-notice";
import { libraryContext } from "#/lib/library";

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
  readonly historical: readonly {
    readonly association: SourceAssociation;
    readonly status: "superseded" | "retracted" | "legacy-retired";
  }[];
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
const HISTORY_LABELS: Record<
  "superseded" | "retracted" | "legacy-retired",
  string
> = {
  superseded: "已被新记录取代",
  retracted: "已撤回",
  "legacy-retired": "已停用",
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
const conflictEvidence = ref<readonly ConflictEvidence[]>([]);
const decision = ref<SourceDecision>();
const operationError = ref("");
const busy = ref(false);
// 主体已终止的失败来源补充：由普通主体读取无采集地投影，重开页面与刷新均据此展示友好入口。
// canRetry 为真表示具备可靠当前证据、可再次获取；为假须诚实引导新的定向补充，绝不外显地址或坐标。
const sourceRetries = ref<
  readonly {
    executionId: string;
    subjectId: string;
    sourceIdentity: string;
    canRetry: boolean;
  }[]
>([]);
const retryableFailures = computed(() =>
  sourceRetries.value.filter((item) => item.canRetry),
);
const unreliableFailures = computed(() =>
  sourceRetries.value.filter((item) => !item.canRetry),
);
// 多库共享主体的定向补充须显式选定归属库：只呈现友好名称，绝不任选其一或外显内部坐标；
// 唯一或零归属时不出现选择器，沿用路由库语境或由耐久唯一归属自动解析。
const ownedLibraries = ref<readonly { id: string; displayName: string }[]>([]);
const selectedLibraryId = ref("");
const activeLibraryId = computed(() => {
  if (routeLibraryId.length > 0) return routeLibraryId;
  if (ownedLibraries.value.length >= 2)
    return selectedLibraryId.value || undefined;
  return undefined;
});
const needsLibrarySelection = computed(
  () =>
    ownedLibraries.value.length >= 2 &&
    routeLibraryId.length === 0 &&
    selectedLibraryId.value === "",
);
const materialPreviewOpen = ref(false);
const availableActions = computed(() =>
  actions.filter(
    ({ id }) =>
      id !== "correct" ||
      correctionLoading.value ||
      (correction.value?.current.length ?? 0) > 0,
  ),
);

const requestedAssetId = (() => {
  const value = pageContext.urlParsed.search.asset;
  return typeof value === "string" ? value.trim() : "";
})();
// 沿用既有库路由参数：从库内进入整理页时即带来明确库语境，定向补充据此携带而不强迫再选。
const routeLibraryId = libraryContext(pageContext.urlParsed.search) ?? "";
const directSubject = ref<CatalogueAssetViewModel>();
const directLoading = ref(false);
const directMissing = ref(false);

function assetOption(entry: CatalogueAssetViewModel): ContentOption[] {
  if ("component" in entry)
    return entry.episodes.map((episode) => ({
      id: episode.assetId,
      title: episode.title,
      category: "bangumi",
      detail: entry.title,
    }));
  const detail =
    entry.book?.contributors.join("、") ||
    entry.dlsite?.circle ||
    entry.fanbox?.creator ||
    entry.film?.directors.join("、") ||
    entry.releaseDate ||
    "";
  return [
    {
      id: entry.id,
      title: entry.title,
      category: entry.cardComponent,
      detail,
      fileCount: entry.files?.length ?? entry.book?.files.length,
    },
  ];
}

const assets = computed<ContentOption[]>(() =>
  catalogue.value.assets.flatMap(assetOption),
);
const options = computed<ContentOption[]>(() => {
  const seen = new Set<string>();
  const merged: ContentOption[] = [];
  for (const option of [
    ...(directSubject.value === undefined
      ? []
      : assetOption(directSubject.value)),
    ...assets.value,
  ]) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    merged.push(option);
  }
  return merged;
});
const selectedAssetView = computed<CatalogueAssetViewModel | undefined>(() => {
  const id = selectedAssetId.value;
  if (!id) return undefined;
  if (
    directSubject.value !== undefined &&
    assetOption(directSubject.value).some((option) => option.id === id)
  )
    return directSubject.value;
  return catalogue.value.assets.find((entry) =>
    assetOption(entry).some((option) => option.id === id),
  );
});
const asset = computed(() =>
  options.value.find((item) => item.id === selectedAssetId.value),
);
const basis = computed(() =>
  selectedAssetView.value === undefined
    ? undefined
    : assetFactNotice(selectedAssetView.value),
);
const basisRecords = computed(() => {
  const history = correction.value;
  if (history === undefined) return [];
  return [
    ...history.current.map((item) => ({
      key: `current-${item.id}`,
      sourceIdentity: item.sourceIdentity,
      nativeAddress: item.nativeAddress,
      state: "当前采用",
    })),
    ...history.historical.map((item) => ({
      key: `historical-${item.association.id}`,
      sourceIdentity: item.association.sourceIdentity,
      nativeAddress: item.association.nativeAddress,
      state: HISTORY_LABELS[item.status],
    })),
  ];
});
// 仅展示已报告资料冲突的真实候选值及其来源；来源关联历史另行呈现，不充当冲突证据。
const conflictEvidenceView = computed(() =>
  conflictEvidence.value.map((conflict) => ({
    property: conflict.property,
    label: friendlyCoordinate(conflict.property),
    candidates: conflict.candidates.map((candidate) => ({
      key: `${candidate.sourceIdentity}\u0000${candidate.sourceRecordIds.join("\u0000")}\u0000${candidate.value}`,
      value: candidate.value,
      source: evidenceSourceLabel(candidate.sourceIdentity),
    })),
  })),
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
// 生效读取会为本地材料保留合成来源身份；这些不是可展示的技术坐标，须映射为友好说法。
function evidenceSourceLabel(identity: string) {
  if (identity === "user") return "本人填写";
  if (identity === "local-observed") return "本地文件";
  return sourceName(identity);
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
    correction.value = {
      recognitionState: "unresolved",
      current: [],
      historical: [],
    };
    correctionId.value = "";
  } finally {
    correctionLoading.value = false;
  }
}
// 依据按当前所选主体异步读取；用请求代次守卫，确保乱序返回、404 或异常都不会覆盖更新的选择或留下旧值。
let conflictEvidenceGeneration = 0;
async function loadConflictEvidence() {
  const generation = ++conflictEvidenceGeneration;
  const target = selectedAssetId.value;
  conflictEvidence.value = [];
  if (!target) return;
  try {
    const evidence = await requestConflictEvidence(target);
    if (generation === conflictEvidenceGeneration)
      conflictEvidence.value = evidence ?? [];
  } catch {
    if (generation === conflictEvidenceGeneration) conflictEvidence.value = [];
  }
}
// 可重试失败项随当前所选主体读取；沿用请求代次守卫，确保乱序返回或异常都不覆盖新的选择。
// 这条普通主体读取绝不触发采集，也不会自动重试；只提供友好的"再次获取"或新定向引导。
let sourceRetriesGeneration = 0;
async function loadSourceRetries() {
  const generation = ++sourceRetriesGeneration;
  const target = selectedAssetId.value;
  sourceRetries.value = [];
  ownedLibraries.value = [];
  if (!target) return;
  try {
    const result = await requestCatalogueSubject(target);
    if (generation !== sourceRetriesGeneration) return;
    sourceRetries.value = (result?.sourceRetries ?? []).map((item) => ({
      executionId: item.executionId,
      subjectId: target,
      sourceIdentity: item.sourceIdentity,
      canRetry: item.canRetry,
    }));
    ownedLibraries.value = result?.libraryChoices ?? [];
  } catch {
    if (generation === sourceRetriesGeneration) {
      sourceRetries.value = [];
      ownedLibraries.value = [];
    }
  }
}
async function addSource() {
  if (
    !asset.value ||
    !requirement.value ||
    !inputsComplete.value ||
    needsLibrarySelection.value ||
    busy.value
  )
    return;
  busy.value = true;
  operationError.value = "";
  try {
    const library = activeLibraryId.value;
    const started = await post<{ readonly id: string }>(
      "/api/source-enrichments",
      {
        subjectId: asset.value.id,
        sourceIdentity: requirement.value.sourceIdentity,
        sourceInput: form.value,
        ...(library === undefined ? {} : { assetLibraryId: library }),
      },
    );
    await settleEnrichment(started.id);
  } catch (cause) {
    operationError.value = message(cause, "元数据来源暂时无法添加");
  } finally {
    busy.value = false;
  }
}
// 补充执行落定：成功/无变化提示并刷新；已终止失败则重新无采集读取主体，令友好的"再次获取"从耐久
// 事实出现（重开页面与刷新同样如此），而非只依赖本次操作的瞬态。
async function settleEnrichment(executionId: string) {
  const result = await poll<{
    readonly status: string;
    readonly outcome?: string;
    readonly reason?: string;
  }>(
    `/api/source-enrichments/${encodeURIComponent(executionId)}`,
    (value) => value.status !== "running",
  );
  if (result.outcome === "accepted") {
    toast.success("元数据来源已添加");
    await Promise.all([
      reload(),
      loadCorrection(),
      loadConflictEvidence(),
      loadSourceRetries(),
    ]);
    return;
  }
  // no-change 分两类：无原因是这项来源确已存在的幂等结果；带原因是候选消失或不再兼容，
  // 须如实给出新的定向引导，绝不谎称来源已存在，并据无采集投影压住旧的"再次获取"。
  if (result.outcome === "no-change") {
    if (result.reason === undefined) {
      toast.success("这项来源已经存在");
      await Promise.all([
        reload(),
        loadCorrection(),
        loadConflictEvidence(),
        loadSourceRetries(),
      ]);
      return;
    }
    await Promise.all([loadCorrection(), loadSourceRetries()]);
    toast.info(result.reason);
    return;
  }
  await loadSourceRetries();
  throw new Error(result.reason ?? "没有找到可采用的元数据");
}
async function retryEnrichment(target: {
  executionId: string;
  subjectId: string;
  sourceIdentity: string;
}) {
  if (busy.value) return;
  busy.value = true;
  operationError.value = "";
  try {
    const started = await post<{ readonly id: string }>(
      "/api/source-enrichments/retry",
      target,
    );
    await settleEnrichment(started.id);
  } catch (cause) {
    operationError.value = message(cause, "暂时无法再次获取");
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
    if (action === "apply")
      await Promise.all([reload(), loadCorrection(), loadConflictEvidence()]);
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

async function loadDirectTarget() {
  if (requestedAssetId.length === 0) return;
  directLoading.value = true;
  directMissing.value = false;
  try {
    const result = await requestCatalogueSubject(requestedAssetId);
    if (result === undefined) {
      directMissing.value = true;
      return;
    }
    directSubject.value = result.asset;
    const candidates = assetOption(result.asset);
    const wanted = result.selectedEpisodeId ?? requestedAssetId;
    selectedAssetId.value =
      candidates.find((option) => option.id === wanted)?.id ??
      candidates.find((option) => option.id === requestedAssetId)?.id ??
      candidates[0]?.id ??
      requestedAssetId;
  } catch {
    directMissing.value = true;
  } finally {
    directLoading.value = false;
  }
}

watch(
  assets,
  (items) => {
    // 带明确 URL 目标时只按稳定 ID 装载，绝不因列表未包含而回退首项。
    if (requestedAssetId.length > 0) return;
    if (
      !items.length ||
      items.some((item) => item.id === selectedAssetId.value)
    )
      return;
    selectedAssetId.value = items[0]!.id;
  },
  { immediate: true },
);
watch(selectedAssetId, () => {
  decision.value = undefined;
  operationError.value = "";
  selectedFiles.value = [];
  selectedLibraryId.value = "";
  void loadCorrection();
  void loadConflictEvidence();
  void loadSourceRetries();
});
watch(requirement, resetForm);
onMounted(() => {
  void loadRequirements();
  void loadDirectTarget();
});
</script>

<template>
  <section class="mx-auto w-full max-w-5xl">
    <header class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight">整理内容</h1>
      <div
        v-if="directLoading || (loading && requestedAssetId.length > 0)"
        class="mt-4 flex items-center gap-3 rounded-xl border p-3"
      >
        <Skeleton class="h-9 flex-1" /><Skeleton class="h-6 w-14" />
      </div>
      <div
        v-else-if="directMissing"
        class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/[0.04] p-3"
      >
        <span class="text-sm text-destructive"
          >没有找到要整理的内容，它可能已被移除。</span
        >
        <Button as="a" href="/intake" size="sm" variant="outline"
          >返回内容库</Button
        >
      </div>
      <div
        v-else-if="loading"
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
        v-else-if="options.length"
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
            <SelectItem v-for="item in options" :key="item.id" :value="item.id">
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
      v-if="
        !directLoading &&
        !directMissing &&
        !loading &&
        !error &&
        !options.length
      "
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

      <Alert v-if="sourceRetries.length" class="mt-4">
        <CircleAlert />
        <AlertTitle>有元数据上次没有取到</AlertTitle>
        <AlertDescription>
          <template v-if="retryableFailures.length">
            <span>以下来源可以再获取一次；这不会改动本地已经确认的内容。</span>
            <div class="mt-2 flex flex-wrap gap-2">
              <Button
                v-for="item in retryableFailures"
                :key="`${item.executionId}-${item.sourceIdentity}`"
                size="sm"
                variant="outline"
                :disabled="busy"
                @click="retryEnrichment(item)"
                ><RefreshCw />再次获取{{
                  sourceName(item.sourceIdentity)
                }}</Button
              >
            </div>
          </template>
          <p v-if="unreliableFailures.length" class="mt-2">
            {{
              unreliableFailures
                .map((item) => sourceName(item.sourceIdentity))
                .join("、")
            }}
            的旧记录已缺少可靠依据，无法自动再次获取；请重新填写来源发起定向补充。
          </p>
        </AlertDescription>
      </Alert>

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
                v-if="
                  intent === 'add' &&
                  ownedLibraries.length >= 2 &&
                  routeLibraryId.length === 0
                "
                class="grid gap-2 text-sm font-medium"
              >
                <span>这项内容存在于多个资产库，请选择要依据的资产库</span>
                <Select
                  :model-value="selectedLibraryId"
                  @update:model-value="
                    (value) => (selectedLibraryId = String(value))
                  "
                >
                  <SelectTrigger class="w-full"
                    ><SelectValue placeholder="选择资产库"
                  /></SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="item in ownedLibraries"
                      :key="item.id"
                      :value="item.id"
                      >{{ item.displayName }}</SelectItem
                    >
                  </SelectContent>
                </Select>
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
                :disabled="!inputsComplete || needsLibrarySelection || busy"
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
          <div
            v-if="
              conflictEvidenceView.length ||
              basis?.conflictReasons.length ||
              basis?.problemReasons.length
            "
            class="space-y-2 rounded-lg border bg-background p-3"
          >
            <p class="text-sm font-medium">资料依据</p>
            <ul
              v-if="basis?.conflictFields.length"
              class="flex flex-wrap gap-1.5"
            >
              <li
                v-for="field in basis.conflictFields"
                :key="field"
                class="rounded bg-secondary px-2 py-0.5 text-xs"
              >
                {{ field }}
              </li>
            </ul>
            <div
              v-for="conflict in conflictEvidenceView"
              :key="conflict.property"
              class="space-y-1"
            >
              <p class="text-xs font-medium">{{ conflict.label }}的实际候选</p>
              <ul class="grid gap-1 text-xs">
                <li
                  v-for="candidate in conflict.candidates"
                  :key="candidate.key"
                  class="flex flex-wrap items-baseline gap-x-1.5"
                >
                  <span class="break-all font-medium">{{
                    candidate.value
                  }}</span>
                  <span class="text-muted-foreground"
                    >（来自 {{ candidate.source }}）</span
                  >
                </li>
              </ul>
            </div>
            <ul v-if="basis?.conflictReasons.length" class="grid gap-1 text-xs">
              <li
                v-for="reason in basis.conflictReasons"
                :key="reason"
                class="text-muted-foreground"
              >
                {{ reason }}
              </li>
            </ul>
            <ul v-if="basis?.problemReasons.length" class="grid gap-1 text-xs">
              <li
                v-for="reason in basis.problemReasons"
                :key="reason"
                class="text-muted-foreground"
              >
                {{ reason }}
              </li>
            </ul>
          </div>
          <div
            v-if="basisRecords.length"
            class="space-y-2 rounded-lg border bg-background p-3"
          >
            <p class="text-sm font-medium">来源关联</p>
            <p class="text-xs text-muted-foreground">
              这些记录只用于查看来源关联，并不代表资料冲突的依据。
            </p>
            <ul class="grid gap-2 text-xs">
              <li
                v-for="record in basisRecords"
                :key="record.key"
                class="grid gap-0.5"
              >
                <span class="font-medium">{{
                  sourceName(record.sourceIdentity)
                }}</span>
                <span class="text-muted-foreground">{{ record.state }}</span>
                <span class="break-all text-muted-foreground">{{
                  record.nativeAddress
                }}</span>
              </li>
            </ul>
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
