import {
  InvalidPageRequest,
  type AssetEvidencePageRequest,
} from "@digital/application";
import type { ProductApplication } from "@digital/product-application";
import {
  assetEvidenceKindSchema,
  assetEvidencePageSchema,
  assetInspectionOverviewSchema,
  assetSourceRecordChunkRequestSchema,
  assetSourceRecordChunkSchema,
  currentAttentionPageSchema,
  inspectionPageRequestSchema,
  listAssetEvidenceRequestSchema,
  publicApiErrorResponseSchema,
  workflowHistoryPageSchema,
} from "@digital/public-api";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

type ApiCode = "invalid-request" | "not-found" | "unavailable";

/** 把资产资料、待处理事项和历史入口挂到唯一公共 API。 */
export function mountAssetInspectionRoutes(
  api: Hono,
  application: ProductApplication,
): void {
  api.get("/assets/:assetId/inspection", async (context) => {
    try {
      const overview = await application.workflow.inspectAssetEvidence(
        context.req.param("assetId"),
      );
      if (overview === undefined)
        return errorResponse(context, "not-found", "没有找到这项资产", 404);
      const result = safeParse(assetInspectionOverviewSchema, overview);
      if (!result.success)
        throw new Error("Asset inspection result is invalid");
      return context.json(result.output);
    } catch {
      return errorResponse(context, "unavailable", "暂时无法读取资产资料", 503);
    }
  });

  api.get("/assets/:assetId/inspection/evidence/:kind", async (context) => {
    const kind = safeParse(assetEvidenceKindSchema, context.req.param("kind"));
    const query = context.req.query();
    const request = safeParse(listAssetEvidenceRequestSchema, {
      kind: kind.success ? kind.output : context.req.param("kind"),
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    if (!request.success)
      return errorResponse(
        context,
        "invalid-request",
        "资料检查分页条件无效",
        400,
      );
    try {
      const page = await application.workflow.listAssetEvidence(
        context.req.param("assetId"),
        request.output as AssetEvidencePageRequest,
      );
      if (page === undefined)
        return errorResponse(context, "not-found", "没有找到这项资产", 404);
      const result = safeParse(assetEvidencePageSchema, page);
      if (!result.success) throw new Error("Asset evidence page is invalid");
      return context.json(result.output);
    } catch (error) {
      if (error instanceof InvalidPageRequest)
        return errorResponse(
          context,
          "invalid-request",
          "资料检查分页条件无效",
          400,
        );
      return errorResponse(context, "unavailable", "暂时无法读取这层资料", 503);
    }
  });

  api.get(
    "/assets/:assetId/inspection/source-records/:recordId",
    async (context) => {
      const query = context.req.query();
      const request = safeParse(assetSourceRecordChunkRequestSchema, {
        ...(query.offset === undefined ? {} : { offset: Number(query.offset) }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
      if (!request.success)
        return errorResponse(
          context,
          "invalid-request",
          "来源资料读取范围无效",
          400,
        );
      try {
        const record = await application.workflow.inspectAssetSourceRecord(
          context.req.param("assetId"),
          context.req.param("recordId"),
        );
        if (record === undefined)
          return errorResponse(
            context,
            "not-found",
            "没有找到这项来源资料",
            404,
          );
        const offset = request.output.offset ?? 0;
        const limit = request.output.limit ?? 1200;
        const chunk = sourceRecordChunk(record, offset, limit);
        if (chunk === undefined)
          return errorResponse(
            context,
            "invalid-request",
            "来源资料读取范围无效",
            400,
          );
        const result = safeParse(assetSourceRecordChunkSchema, {
          assetId: context.req.param("assetId"),
          record: {
            id: record.id,
            sourceIdentity: record.sourceIdentity,
            nativeAddress: record.nativeAddress,
            mediaType: record.mediaType,
            acquiredAt: record.acquiredAt,
            coverage: record.coverage,
            digest: record.digest,
          },
          ...chunk,
        });
        if (!result.success) throw new Error("Source record chunk is invalid");
        return context.json(result.output);
      } catch (error) {
        if (error instanceof InvalidPageRequest)
          return errorResponse(
            context,
            "invalid-request",
            "来源资料读取范围无效",
            400,
          );
        return errorResponse(
          context,
          "unavailable",
          "暂时无法读取这项来源资料",
          503,
        );
      }
    },
  );

  api.get("/attention", async (context) => {
    const request = parsePageRequest(context.req.query());
    if (request === undefined)
      return errorResponse(
        context,
        "invalid-request",
        "待处理事项分页条件无效",
        400,
      );
    try {
      const page = await application.workflow.listCurrentAttentionPage(request);
      const result = safeParse(currentAttentionPageSchema, page);
      if (!result.success) throw new Error("Current attention page is invalid");
      return context.json(result.output);
    } catch (error) {
      if (error instanceof InvalidPageRequest)
        return errorResponse(
          context,
          "invalid-request",
          "待处理事项分页条件无效",
          400,
        );
      return errorResponse(
        context,
        "unavailable",
        "暂时无法读取待处理事项",
        503,
      );
    }
  });

  api.get("/workflow-history", async (context) => {
    const request = parsePageRequest(context.req.query());
    if (request === undefined)
      return errorResponse(
        context,
        "invalid-request",
        "工作流历史分页条件无效",
        400,
      );
    try {
      const page = await application.workflow.listWorkflowHistoryPage(request);
      const result = safeParse(
        workflowHistoryPageSchema,
        compactWorkflowHistory(page),
      );
      if (!result.success) throw new Error("Workflow history page is invalid");
      return context.json(result.output);
    } catch (error) {
      if (error instanceof InvalidPageRequest)
        return errorResponse(
          context,
          "invalid-request",
          "工作流历史分页条件无效",
          400,
        );
      return errorResponse(
        context,
        "unavailable",
        "暂时无法读取工作流历史",
        503,
      );
    }
  });
}

function parsePageRequest(
  query: Record<string, string>,
): { readonly limit?: number; readonly cursor?: string } | undefined {
  const result = safeParse(inspectionPageRequestSchema, {
    ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  return result.success ? result.output : undefined;
}

function sourceRecordChunk(
  record: { readonly body: string },
  offset: number,
  limit: number,
):
  | {
      readonly offset: number;
      readonly nextOffset: number;
      readonly complete: boolean;
      readonly content: string;
    }
  | undefined {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 4096
  )
    return undefined;
  let index = 0;
  let codePoints = 0;
  while (index < record.body.length && codePoints < offset) {
    index += sourceCodePointLength(record.body, index);
    codePoints += 1;
  }
  if (codePoints !== offset) return undefined;
  const start = index;
  let length = 0;
  while (index < record.body.length && length < limit) {
    index += sourceCodePointLength(record.body, index);
    length += 1;
  }
  return {
    offset,
    nextOffset: offset + length,
    complete: index >= record.body.length,
    content: record.body.slice(start, index),
  };
}

function sourceCodePointLength(value: string, offset: number): 1 | 2 {
  const first = value.charCodeAt(offset);
  const second = value.charCodeAt(offset + 1);
  return first >= 0xd800 &&
    first <= 0xdbff &&
    second >= 0xdc00 &&
    second <= 0xdfff
    ? 2
    : 1;
}

function compactWorkflowHistory(page: {
  readonly items: readonly {
    readonly execution: {
      readonly id: string;
      readonly status: "running" | "completed" | "failed";
      readonly stage: string;
      readonly outcome?: string;
      readonly operationKind?: string;
      readonly automationIntentId?: string;
    };
    readonly resultReferences: {
      readonly acceptedAssetIds: readonly string[];
      readonly affectedSubjectIds: readonly string[];
      readonly sourceRecordIds: readonly string[];
      readonly sourceRefreshRunIds: readonly string[];
      readonly changeImpactPreviewIds: readonly string[];
    };
    readonly recognitionResults: readonly {
      readonly proposalId: string;
      readonly explanation: string;
      readonly status: "proposed" | "accepted";
    }[];
  }[];
  readonly nextCursor?: string;
}) {
  return {
    items: page.items.map(
      ({ execution, resultReferences, recognitionResults }) => ({
        execution: {
          id: execution.id,
          status: execution.status,
          stage: execution.stage,
          ...(execution.outcome === undefined
            ? {}
            : { outcome: execution.outcome }),
          ...(execution.operationKind === undefined
            ? {}
            : { operationKind: execution.operationKind }),
          ...(execution.automationIntentId === undefined
            ? {}
            : { automationIntentId: execution.automationIntentId }),
        },
        resultReferences: {
          acceptedAssetIds: resultReferences.acceptedAssetIds,
          affectedSubjectIds: resultReferences.affectedSubjectIds,
          sourceRecordIds: resultReferences.sourceRecordIds,
          sourceRefreshRunIds: resultReferences.sourceRefreshRunIds,
          changeImpactPreviewIds: resultReferences.changeImpactPreviewIds,
        },
        recognitionResults,
      }),
    ),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

function errorResponse(
  context: Context,
  code: ApiCode,
  message: string,
  status: 400 | 404 | 503,
) {
  const result = safeParse(publicApiErrorResponseSchema, {
    error: { code, message },
  });
  if (!result.success) throw new Error("Public API error response is invalid");
  return context.json(result.output, status);
}
