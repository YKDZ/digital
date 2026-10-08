import type {
  AssetLibraryRecognitionProfile,
  AssetLibrarySource,
  SourceConnectionInspection,
} from "@digital/application";
import type {
  AssetViewModel,
  BangumiSeriesViewModel,
} from "@digital/presentation";

export type IntakeContent = {
  readonly executionId: string;
  readonly status: "proposed" | "accepted";
  readonly relativePaths: readonly string[];
  readonly asset: AssetViewModel;
};

export type IntakeSnapshot = {
  readonly roots: readonly {
    readonly id: string;
    readonly displayName: string;
  }[];
  readonly rootId?: string;
  readonly execution?: ExecutionViewModel;
  readonly files: readonly {
    readonly relativePath: string;
    readonly size: number;
    readonly assetIds: readonly string[];
    readonly problem?: string;
  }[];
  readonly contents: readonly AssetViewModel[];
};

export async function requestIntake(
  input: { rootId?: string; executionId?: string } = {},
): Promise<IntakeSnapshot> {
  const query = new URLSearchParams();
  if (input.rootId) query.set("rootId", input.rootId);
  if (input.executionId) query.set("executionId", input.executionId);
  const response = await fetch(`/api/intake?${query}`);
  const result = await response.json();
  if (!response.ok)
    throw new Error((result as { error?: string }).error ?? "暂时无法检查文件");
  return result as IntakeSnapshot;
}

/**
 * 交付层展示的一条目录：只给友好名、用户自己的目录路径、本库授权状态与本次可达性。
 * 授权 ID、权威版本、链接策略与允许目标都不进入这份 DTO，UI 因此无从显示内部机制。
 */
export type SettingsDirectoryView = {
  readonly directoryId: string;
  readonly observedRootId: string;
  readonly displayName: string;
  readonly containerPath: string;
  readonly status: "active" | "removed";
  readonly reachable: boolean;
  readonly problem?: string;
};

export type SettingsLibrary = {
  readonly id: string;
  readonly displayName: string;
  readonly configVersion: number;
  readonly recognitionProfileIds: readonly string[];
  readonly sourceIdentities: readonly string[];
  readonly directories: readonly string[];
  readonly directoryViews: readonly SettingsDirectoryView[];
};

export type SettingsSnapshot = {
  readonly libraries: readonly SettingsLibrary[];
  readonly recognitionProfiles: readonly AssetLibraryRecognitionProfile[];
  readonly librarySources: readonly AssetLibrarySource[];
  readonly configured: boolean;
  readonly productDataDirectory?: string;
  readonly sources: readonly SourceConnectionInspection[];
  readonly automation: readonly AutomationViewModel[];
  readonly recovery: readonly AutomationRecoveryViewModel[];
};

export type AssetLibraryView = {
  readonly id: string;
  readonly displayName: string;
};

export async function requestAssetLibraries(): Promise<
  readonly AssetLibraryView[]
> {
  const response = await fetch("/api/libraries");
  if (!response.ok) throw new Error("暂时无法读取资产库");
  return (await response.json()) as readonly AssetLibraryView[];
}

export async function requestSettings(): Promise<SettingsSnapshot> {
  const response = await fetch("/api/settings");
  if (!response.ok) throw new Error("暂时无法读取设置");
  return (await response.json()) as SettingsSnapshot;
}

export type {
  AssetViewModel,
  BangumiEpisodeViewModel,
  BangumiSeriesViewModel,
  BangumiWorkViewModel,
} from "@digital/presentation";
export type CatalogueAssetViewModel = AssetViewModel | BangumiSeriesViewModel;
export {
  libraryCategories,
  projectLibraryAsset,
} from "@digital/presentation/library";
export type { LibraryCategory } from "@digital/presentation";

export type LibraryQuery = {
  readonly assetLibraryId?: string;
  readonly text?: string;
  readonly category?: string;
  readonly sort?: "recent" | "name";
};

export type CatalogueSubjectSourceRetry = {
  readonly executionId: string;
  readonly sourceIdentity: string;
  readonly canRetry: boolean;
};

/** 多库共享主体的友好归属库选项：只带可展示名称，绝不外显内部坐标。 */
export type CatalogueSubjectLibraryChoice = {
  readonly id: string;
  readonly displayName: string;
};

export type CatalogueSubjectResponse = {
  readonly asset: CatalogueAssetViewModel;
  readonly selectedEpisodeId?: string;
  readonly sourceRetries?: readonly CatalogueSubjectSourceRetry[];
  readonly libraryChoices?: readonly CatalogueSubjectLibraryChoice[];
};

export async function requestCatalogueSubject(
  id: string,
  signal?: AbortSignal,
  assetLibraryId?: string,
): Promise<CatalogueSubjectResponse | undefined> {
  const query = new URLSearchParams();
  if (assetLibraryId) query.set("library", assetLibraryId);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  const response = await fetch(
    `/api/catalogue/${encodeURIComponent(id)}${suffix}`,
    signal === undefined ? undefined : { signal },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("暂时无法读取内容");
  return (await response.json()) as CatalogueSubjectResponse;
}

/** 封面卡只需要的友好视图：候选图、当前封面、人工意图与可理解的问题。 */
export type CoverChoiceView = {
  readonly candidates: readonly {
    readonly reference: string;
    readonly title: string;
    /** 无法授权交付的候选不给地址，只保留标题与选择操作。 */
    readonly imageUrl?: string;
  }[];
  readonly currentImageUrl?: string;
  readonly manualReference?: string;
  readonly manualStale?: boolean;
  readonly problems: readonly string[];
};

/** 读取一张封面卡的候选、当前封面、人工意图与问题。 */
export async function requestCoverChoice(
  subjectId: string,
): Promise<CoverChoiceView> {
  const response = await fetch(
    `/api/cover-choice/${encodeURIComponent(subjectId)}`,
  );
  if (!response.ok) throw new Error("暂时无法读取封面候选");
  return (await response.json()) as CoverChoiceView;
}

/** 一项资料冲突候选的可核对依据：保留值、来源身份及支持记录标识。 */
export type ConflictCandidateEvidence = {
  readonly value: string;
  readonly sourceIdentity: string;
  readonly sourceRecordIds: readonly string[];
};

/** 所选内容一项属性的已报告资料冲突候选，来源关联历史不在此列。 */
export type ConflictEvidence = {
  readonly property: string;
  readonly kind: "policy-conflict" | "metadata-value-conflict";
  readonly candidates: readonly ConflictCandidateEvidence[];
};

/** 按稳定内容 ID 只读核对真正导致资料冲突的候选值；不存在返回 undefined。 */
export async function requestConflictEvidence(
  id: string,
): Promise<readonly ConflictEvidence[] | undefined> {
  const response = await fetch(
    `/api/conflict-evidence/${encodeURIComponent(id)}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("暂时无法读取资料依据");
  const result = (await response.json()) as {
    readonly conflicts: readonly ConflictEvidence[];
  };
  return result.conflicts;
}

/** 按稳定执行 ID 读取单条刷新记录；目标不存在返回 undefined，不退回其它记录。 */
export async function requestExecution(
  id: string,
): Promise<ExecutionViewModel | undefined> {
  const response = await fetch(`/api/executions/${encodeURIComponent(id)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("暂时无法读取记录");
  return (await response.json()) as ExecutionViewModel;
}

/** 保存当前本地用户对一个明确产物修订版的播放交互。 */
export async function savePlaybackInteraction(input: {
  readonly revisionId: string;
  readonly positionMilliseconds: number;
  readonly completed: boolean;
}): Promise<void> {
  const response = await fetch("/api/playback-interactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.ok) return;
  const result = (await response.json()) as { readonly error?: string };
  throw new Error(result.error ?? "暂时无法保存播放状态");
}

/**
 * 交付层对应用层终态结果完整且用户可见的视图。保持该显式边界类型与应用层模型分离，
 * 同时让标签覆盖可由机械方式穷尽检查。
 */
export type ExecutionOutcome =
  | "unresolved"
  | "proposal"
  | "accepted"
  | "partially-succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "no-change";

const executionOutcomeLabels = {
  unresolved: "未能确认",
  proposal: "等待处理",
  accepted: "已完成",
  "partially-succeeded": "部分完成",
  failed: "未完成",
  interrupted: "已中断",
  cancelled: "已取消",
  "no-change": "没有变化",
} satisfies Record<ExecutionOutcome, string>;

export function executionOutcomeLabel(outcome: ExecutionOutcome): string {
  return executionOutcomeLabels[outcome];
}

export type ExecutionViewModel = {
  readonly id: string;
  readonly folder: string;
  readonly intent:
    | "scan-now"
    | "metadata-refresh"
    | "directed-recognition"
    | "source-enrichment";
  readonly status: "running" | "completed" | "failed";
  readonly outcome?: ExecutionOutcome;
  readonly reason?: string;
  readonly acceptedAssetId?: string;
  readonly dispositions: readonly {
    readonly key: string;
    readonly status:
      | "running"
      | "completed"
      | "failed"
      | "skipped"
      | "reused"
      | "no-change";
    readonly reason?: string;
    readonly output?: string;
  }[];
  readonly targets?: readonly {
    readonly key: string;
    readonly label: string;
    readonly status:
      | "running"
      | "completed"
      | "failed"
      | "skipped"
      | "reused"
      | "blocked"
      | "no-change";
    readonly reason?: string;
    readonly sourceRecordIds?: readonly string[];
    readonly outputReferences?: readonly string[];
  }[];
  readonly items?: readonly {
    readonly key: string;
    readonly relativePaths: readonly string[];
    readonly outcome?: ExecutionOutcome;
    readonly reason?: string;
    readonly recognition?: {
      readonly explanation: string;
      readonly status: "proposed" | "accepted";
    };
    readonly acceptedAssetId?: string;
    readonly acceptedSource?: string;
  }[];
  readonly recognition?: {
    readonly explanation: string;
    readonly status: "proposed" | "accepted";
  };
  readonly preview?: {
    readonly id: string;
    readonly status: "awaiting-confirmation" | "rejected" | "applied" | "stale";
    readonly blockingConditions: readonly string[];
    readonly current: AssetViewModel;
    readonly proposed: AssetViewModel;
  };
};

export type AutomationViewModel = {
  readonly assetLibraryId?: string;
  readonly id: string;
  /** 计划标题：资产库名与目录名的组合，绝不含内部编号或容器路径。 */
  readonly folder: string;
  readonly observedRootId: string;
  readonly relativeScope: string;
  readonly enabled: boolean;
  readonly intervalMilliseconds: number;
  readonly acceptTrusted: boolean;
  /** 系统代为停用时的中文原因；用户自己停用则没有。 */
  readonly disabledReason?: string;
};

/** 本次启动逐条接续的结果：只用中文说明状态、原因与下一步。 */
export type AutomationRecoveryViewModel = {
  readonly status: string;
  readonly subject: string;
  readonly reason?: string;
  readonly nextAction?: string;
};

/** 安全的交付投影；容器路径保留在应用边界。 */
export type ObservedRootViewModel = {
  readonly id: string;
  readonly displayName: string;
};

/** 应用层当前可重建审核条件的交付映射。 */
export type AttentionViewModel = {
  readonly id: string;
  readonly kind:
    | "recognition-review"
    | "change-impact-review"
    | "source-refresh-review"
    | "prerequisite-unavailable";
  readonly executionId?: string;
  readonly assetId?: string;
  readonly summary: string;
  readonly recognitionProposalId?: string;
  readonly changeImpactPreviewId?: string;
  readonly sourceRefreshChangeSetId?: string;
  readonly automationIntentId?: string;
};

export type CataloguePagination = {
  readonly currentCatalogue: { readonly nextCursor?: string };
  readonly workflowHistory: { readonly nextCursor?: string };
  readonly currentAttention: { readonly nextCursor?: string };
};

export type CatalogueSnapshot = {
  readonly configured: boolean;
  readonly assets: readonly CatalogueAssetViewModel[];
  readonly executions: readonly ExecutionViewModel[];
  readonly attention: readonly AttentionViewModel[];
  readonly automation: readonly AutomationViewModel[];
  readonly observedRoots: readonly ObservedRootViewModel[];
  readonly pagination: CataloguePagination;
};

export const emptyCatalogue: CatalogueSnapshot = {
  configured: false,
  assets: [],
  executions: [],
  attention: [],
  automation: [],
  observedRoots: [],
  pagination: {
    currentCatalogue: {},
    workflowHistory: {},
    currentAttention: {},
  },
};

export type CataloguePageRequest = {
  readonly cursor?: string;
  readonly limit?: number;
};

export type CatalogueSurface =
  | "current-catalogue"
  | "workflow-history"
  | "current-attention"
  | "automation";

export type CatalogueSurfaceRequest =
  | {
      readonly surface: "current-catalogue";
      readonly page?: CataloguePageRequest;
      readonly query?: LibraryQuery;
      readonly signal?: AbortSignal;
    }
  | {
      readonly surface: "workflow-history";
      readonly page?: CataloguePageRequest;
    }
  | {
      readonly surface: "current-attention";
      readonly page?: CataloguePageRequest;
    }
  | { readonly surface: "automation" };

export type CatalogueSurfaceResponse =
  | {
      readonly surface: "current-catalogue";
      readonly configured: boolean;
      readonly assets: readonly CatalogueAssetViewModel[];
      readonly pagination: { readonly nextCursor?: string };
      readonly total?: number;
      readonly categories?: readonly {
        readonly id: string;
        readonly label: string;
      }[];
    }
  | {
      readonly surface: "workflow-history";
      readonly configured: boolean;
      readonly executions: readonly ExecutionViewModel[];
      readonly pagination: { readonly nextCursor?: string };
    }
  | {
      readonly surface: "current-attention";
      readonly configured: boolean;
      readonly attention: readonly AttentionViewModel[];
      readonly pagination: { readonly nextCursor?: string };
    }
  | {
      readonly surface: "automation";
      readonly configured: boolean;
      readonly automation: readonly AutomationViewModel[];
    };

export function requestCatalogue(): Promise<CatalogueSnapshot>;
export function requestCatalogue(
  input: Extract<
    CatalogueSurfaceRequest,
    { readonly surface: "current-catalogue" }
  >,
): Promise<
  Extract<CatalogueSurfaceResponse, { readonly surface: "current-catalogue" }>
>;
export function requestCatalogue(
  input: Extract<
    CatalogueSurfaceRequest,
    { readonly surface: "workflow-history" }
  >,
): Promise<
  Extract<CatalogueSurfaceResponse, { readonly surface: "workflow-history" }>
>;
export function requestCatalogue(
  input: Extract<
    CatalogueSurfaceRequest,
    { readonly surface: "current-attention" }
  >,
): Promise<
  Extract<CatalogueSurfaceResponse, { readonly surface: "current-attention" }>
>;
export function requestCatalogue(
  input: Extract<CatalogueSurfaceRequest, { readonly surface: "automation" }>,
): Promise<
  Extract<CatalogueSurfaceResponse, { readonly surface: "automation" }>
>;
export async function requestCatalogue(
  input?: CatalogueSurfaceRequest,
): Promise<CatalogueSnapshot | CatalogueSurfaceResponse> {
  const query = new URLSearchParams();
  if (input !== undefined) {
    query.set("surface", input.surface);
    if (input.surface === "current-catalogue" && input.query !== undefined) {
      query.set("sort", input.query.sort ?? "recent");
      if (input.query.text) query.set("q", input.query.text);
      if (input.query.assetLibraryId)
        query.set("library", input.query.assetLibraryId);
      if (input.query.category && input.query.category !== "all")
        query.set("category", input.query.category);
    }
    if (input.surface !== "automation") {
      if (input.page?.cursor !== undefined)
        query.set("cursor", input.page.cursor);
      if (input.page?.limit !== undefined)
        query.set("limit", String(input.page.limit));
    }
  }
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  const response = await fetch(
    `/api/catalogue${suffix}`,
    input?.surface === "current-catalogue" && input.signal !== undefined
      ? { signal: input.signal }
      : undefined,
  );
  if (!response.ok) {
    // 服务端会说明具体原因（例如资产库已失效），必须原样传给页面显示。
    const failure = (await response.json().catch(() => undefined)) as
      | { readonly error?: string }
      | undefined;
    throw new Error(failure?.error ?? "暂时无法读取内容");
  }
  if (input !== undefined) {
    const page = (await response.json()) as CatalogueSurfaceResponse;
    if (page.surface !== input.surface)
      throw new Error("内容目录 surface 响应不匹配");
    return page;
  }
  const page = (await response.json()) as Partial<CatalogueSnapshot>;
  return {
    configured: page.configured ?? false,
    assets: page.assets ?? [],
    executions: page.executions ?? [],
    attention: page.attention ?? [],
    automation: page.automation ?? [],
    observedRoots: page.observedRoots ?? [],
    pagination: {
      currentCatalogue: page.pagination?.currentCatalogue ?? {},
      workflowHistory: page.pagination?.workflowHistory ?? {},
      currentAttention: page.pagination?.currentAttention ?? {},
    },
  };
}

export async function sendAction<T>(
  endpoint:
    | "/api/intake"
    | "/api/refresh"
    | "/api/automation"
    | "/api/preview"
    | "/api/cover-decisions"
    | "/api/settings/libraries"
    | "/api/settings/connections",
  body: object,
): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(data.error ?? "操作暂时无法完成");
  return data;
}
