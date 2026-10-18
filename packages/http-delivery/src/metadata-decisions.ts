import {
  MetadataDecisionError,
  type ChangeImpactPreviewFacts,
  type ChangeImpactPreviewInspection,
} from "@digital/application";
import type { ProductApplication } from "@digital/product-application";
import {
  metadataDecisionPreviewSchema,
  prepareMetadataDecisionRequestSchema,
  publicApiErrorResponseSchema,
} from "@digital/public-api";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

type ErrorCode = "invalid-request" | "conflict" | "not-found" | "unavailable";

/** 把人工元数据修订接到既有变更预演与确认链路。 */
export function createMetadataDecisionsHttpApi(
  application: ProductApplication,
): Hono {
  const api = new Hono();

  api.post("/assets/:assetId/metadata-decisions/previews", async (context) => {
    const parsed = safeParse(
      prepareMetadataDecisionRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return errorResponse(
        context,
        "invalid-request",
        "人工属性修订条件无效",
        400,
      );

    const assetId = context.req.param("assetId");
    try {
      const inspection =
        await application.workflow.inspectAssetEvidence(assetId);
      if (inspection === undefined)
        return errorResponse(context, "not-found", "没有找到这项资产", 404);
      const request = parsed.output;
      const preview = await application.workflow.prepareMetadataDecision({
        entityId: assetId,
        property: request.property,
        ...(request.metadataUsageContext === undefined
          ? {}
          : { metadataUsageContext: request.metadataUsageContext }),
        initiatedBy: "local-user",
        kind: request.kind === "clear" ? "clear" : "pin",
        ...(request.kind === "pin" ? { value: request.value } : {}),
        ...(request.kind === "adopt"
          ? { candidateReference: request.candidateReference }
          : {}),
      });
      return publicPreview(context, preview, impactFor(preview));
    } catch (error) {
      if (error instanceof MetadataDecisionError) {
        const status =
          error.kind === "invalid-request"
            ? 400
            : error.kind === "not-found"
              ? 404
              : 409;
        return errorResponse(context, error.kind, error.message, status);
      }
      return errorResponse(
        context,
        "unavailable",
        "暂时无法形成属性修订预演",
        503,
      );
    }
  });

  api.post(
    "/metadata-decision-previews/:previewId/confirm",
    async (context) => {
      const previewId = context.req.param("previewId");
      try {
        const before =
          await application.workflow.inspectChangeImpactPreview(previewId);
        if (before?.metadataDecision === undefined)
          return errorResponse(
            context,
            "not-found",
            "没有找到待确认的属性修订",
            404,
          );
        const applied = await application.workflow.applyChangeImpactPreview({
          previewId,
          confirmedBy: "local-user",
        });
        const preview = await application.workflow.inspectChangeImpactPreview(
          applied.id,
        );
        if (preview === undefined || preview.metadataDecision === undefined)
          return errorResponse(
            context,
            "unavailable",
            "暂时无法读取属性修订结果",
            503,
          );
        return publicPreview(context, preview, impactFor(preview));
      } catch (error) {
        if (error instanceof MetadataDecisionError) {
          const status =
            error.kind === "invalid-request"
              ? 400
              : error.kind === "not-found"
                ? 404
                : 409;
          return errorResponse(context, error.kind, error.message, status);
        }
        return errorResponse(
          context,
          "unavailable",
          "暂时无法确认属性修订",
          503,
        );
      }
    },
  );

  api.post("/metadata-decision-previews/:previewId/cancel", async (context) => {
    const previewId = context.req.param("previewId");
    try {
      const before =
        await application.workflow.inspectChangeImpactPreview(previewId);
      if (before?.metadataDecision === undefined)
        return errorResponse(
          context,
          "not-found",
          "没有找到待取消的属性修订",
          404,
        );
      const preview = await application.workflow.rejectChangeImpactPreview({
        previewId,
        rejectedBy: "local-user",
      });
      return publicPreview(context, preview, "已取消，资料没有改变");
    } catch {
      return errorResponse(context, "unavailable", "暂时无法取消属性修订", 503);
    }
  });

  return api;
}

function publicPreview(
  context: Context,
  preview: ChangeImpactPreviewInspection,
  impact: string,
) {
  const decision = preview.metadataDecision;
  if (decision === undefined)
    return errorResponse(context, "not-found", "没有找到属性修订", 404);
  const result = safeParse(metadataDecisionPreviewSchema, {
    previewId: preview.id,
    assetId: preview.assetId,
    property: decision.property,
    metadataUsageContext: decision.metadataUsageContext,
    kind: decision.kind,
    ...(decision.value === undefined ? {} : { value: decision.value }),
    ...(decision.adoptedFromSourceIdentity === undefined
      ? {}
      : { adoptedFromSourceIdentity: decision.adoptedFromSourceIdentity }),
    status: preview.status,
    current: metadataState(preview.facts?.current, preview.assetId, decision),
    projected: metadataState(
      preview.facts?.projected,
      preview.assetId,
      decision,
    ),
    impact,
    blockingConditions: preview.blockingConditions,
  });
  if (!result.success)
    return errorResponse(context, "unavailable", "属性修订结果无效", 503);
  return context.json(result.output);
}

function metadataState(
  facts: ChangeImpactPreviewFacts | undefined,
  assetId: string,
  decision: NonNullable<ChangeImpactPreviewInspection["metadataDecision"]>,
) {
  const result = facts?.descriptions
    .find(
      (description) =>
        description.target.kind === "entity" &&
        description.target.entityId === assetId &&
        description.metadataUsageContext === decision.metadataUsageContext,
    )
    ?.metadata.find((item) => item.property === decision.property)?.result;
  if (result === undefined || result.status === "missing")
    return { status: "missing" as const, values: [] };
  if (result.status === "conflict")
    return { status: "conflict" as const, values: [] };
  return {
    status: "resolved" as const,
    values: result.values.map(({ value, sourceIdentity }) => ({
      value,
      sourceIdentity,
    })),
  };
}

function impactFor(preview: ChangeImpactPreviewInspection): string {
  const decision = preview.metadataDecision;
  if (decision === undefined) return "";
  return decision.kind === "clear"
    ? "确认后撤下当前人工修订，并按当前来源及原有人工依据重新求值"
    : decision.adoptedFromSourceIdentity === undefined
      ? "确认后固定人工输入值；后续来源刷新不会改写这项修订"
      : `确认后固定所选值，并保留来自 ${decision.adoptedFromSourceIdentity} 的采纳依据`;
}

function errorResponse(
  context: Context,
  code: ErrorCode,
  message: string,
  status: 400 | 404 | 409 | 503,
) {
  const result = safeParse(publicApiErrorResponseSchema, {
    error: { code, message },
  });
  if (!result.success) throw new Error("公共 API 错误响应无效");
  return context.json(result.output, status);
}
