import {
  safeParse,
  type BaseIssue,
  type BaseSchema,
  type InferOutput,
} from "valibot";

import { PublicApiClientError } from "./client.ts";
import { publicApiErrorResponseSchema } from "./contract.ts";
import {
  assetEvidencePageSchema,
  assetInspectionOverviewSchema,
  assetSourceRecordChunkRequestSchema,
  assetSourceRecordChunkSchema,
  currentAttentionPageSchema,
  inspectionPageRequestSchema,
  listAssetEvidenceRequestSchema,
  workflowHistoryPageSchema,
  type AssetEvidencePage,
  type AssetInspectionOverview,
  type AssetSourceRecordChunk,
  type AssetSourceRecordChunkRequest,
  type CurrentAttentionPage,
  type InspectionPageRequest,
  type ListAssetEvidenceRequest,
  type WorkflowHistoryPage,
} from "./inspection-contract.ts";

export type AssetInspectionMethods = {
  inspectAssetEvidence(assetId: string): Promise<AssetInspectionOverview>;
  listAssetEvidence(
    assetId: string,
    input: ListAssetEvidenceRequest,
  ): Promise<AssetEvidencePage>;
  readAssetSourceRecord(
    assetId: string,
    sourceRecordId: string,
    input?: AssetSourceRecordChunkRequest,
  ): Promise<AssetSourceRecordChunk>;
  listCurrentAttention(
    input?: InspectionPageRequest,
  ): Promise<CurrentAttentionPage>;
  listWorkflowHistory(
    input?: InspectionPageRequest,
  ): Promise<WorkflowHistoryPage>;
};

export function createAssetInspectionMethods(input: {
  readonly apiBaseUrl: URL;
  readonly fetch: typeof globalThis.fetch;
}): AssetInspectionMethods {
  const baseUrl = new URL(input.apiBaseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
    throw new PublicApiClientError("invalid-request", "服务地址无效");
  const path = baseUrl.pathname.replace(/\/+$/u, "");
  baseUrl.pathname = path.endsWith("/api/v1") ? `${path}/` : `${path}/api/v1/`;

  return {
    async inspectAssetEvidence(assetId) {
      ensureCoordinate(assetId, "资产编号无效");
      return await getJson(
        input.fetch,
        new URL(`assets/${encodeURIComponent(assetId)}/inspection`, baseUrl),
        assetInspectionOverviewSchema,
      );
    },
    async listAssetEvidence(assetId, request) {
      ensureCoordinate(assetId, "资产编号无效");
      const page = validateRequest(
        listAssetEvidenceRequestSchema,
        request,
        "资料检查分页条件无效",
      );
      const url = new URL(
        `assets/${encodeURIComponent(assetId)}/inspection/evidence/${page.kind}`,
        baseUrl,
      );
      addPageParameters(url, page);
      return await getJson(input.fetch, url, assetEvidencePageSchema);
    },
    async readAssetSourceRecord(assetId, sourceRecordId, request = {}) {
      ensureCoordinate(assetId, "资产编号无效");
      ensureCoordinate(sourceRecordId, "来源记录编号无效");
      const page = validateRequest(
        assetSourceRecordChunkRequestSchema,
        request,
        "来源资料读取范围无效",
      );
      const url = new URL(
        `assets/${encodeURIComponent(assetId)}/inspection/source-records/${encodeURIComponent(sourceRecordId)}`,
        baseUrl,
      );
      url.searchParams.set("offset", String(page.offset ?? 0));
      url.searchParams.set("limit", String(page.limit ?? 1200));
      return await getJson(input.fetch, url, assetSourceRecordChunkSchema);
    },
    async listCurrentAttention(request = {}) {
      const page = validateRequest(
        inspectionPageRequestSchema,
        request,
        "待处理事项分页条件无效",
      );
      const url = new URL("attention", baseUrl);
      addPageParameters(url, page);
      return await getJson(input.fetch, url, currentAttentionPageSchema);
    },
    async listWorkflowHistory(request = {}) {
      const page = validateRequest(
        inspectionPageRequestSchema,
        request,
        "工作流历史分页条件无效",
      );
      const url = new URL("workflow-history", baseUrl);
      addPageParameters(url, page);
      return await getJson(input.fetch, url, workflowHistoryPageSchema);
    },
  };
}

function ensureCoordinate(value: string, message: string): void {
  if (value.trim().length === 0)
    throw new PublicApiClientError("invalid-request", message);
}

function addPageParameters(
  url: URL,
  input: {
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  },
): void {
  if (input.limit !== undefined)
    url.searchParams.set("limit", String(input.limit));
  if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
}

function validateRequest<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(schema: Schema, value: unknown, message: string) {
  const parsed = safeParse(schema, value);
  if (!parsed.success)
    throw new PublicApiClientError("invalid-request", message);
  return parsed.output;
}

async function getJson<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(
  fetch: typeof globalThis.fetch,
  url: URL,
  schema: Schema,
): Promise<InferOutput<Schema>> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new PublicApiClientError(
      "transport",
      "无法连接当前产品服务",
      undefined,
      { cause },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new PublicApiClientError(
      "protocol",
      "服务响应无法读取",
      response.status,
      { cause },
    );
  }
  if (!response.ok) {
    const error = safeParse(publicApiErrorResponseSchema, body);
    if (!error.success)
      throw new PublicApiClientError(
        "protocol",
        "服务返回了无法识别的错误",
        response.status,
      );
    throw new PublicApiClientError(
      error.output.error.code,
      error.output.error.message,
      response.status,
    );
  }
  const parsed = safeParse(schema, body);
  if (!parsed.success)
    throw new PublicApiClientError(
      "protocol",
      "服务返回的数据无法识别",
      response.status,
    );
  return parsed.output;
}
