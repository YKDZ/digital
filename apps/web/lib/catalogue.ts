import type {
  AssetViewModel,
  BangumiSeriesViewModel,
} from "@digital/presentation";

export type {
  AssetViewModel,
  BangumiEpisodeViewModel,
  BangumiSeriesViewModel,
  BangumiWorkViewModel,
} from "@digital/presentation";
export type CatalogueAssetViewModel = AssetViewModel | BangumiSeriesViewModel;

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
  readonly intent: "scan-now" | "metadata-refresh" | "directed-recognition";
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
  readonly id: string;
  readonly folder: string;
  readonly observedRootId: string;
  readonly relativeScope: string;
  readonly enabled: boolean;
  readonly intervalMilliseconds: number;
  readonly acceptTrusted: boolean;
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
    if (input.surface !== "automation") {
      if (input.page?.cursor !== undefined)
        query.set("cursor", input.page.cursor);
      if (input.page?.limit !== undefined)
        query.set("limit", String(input.page.limit));
    }
  }
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  const response = await fetch(`/api/catalogue${suffix}`);
  if (!response.ok) throw new Error("暂时无法读取内容");
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
  endpoint: "/api/refresh" | "/api/automation" | "/api/preview",
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
