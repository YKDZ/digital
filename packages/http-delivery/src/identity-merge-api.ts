import {
  CatalogueDecisionConflict,
  InvalidIdentityOperation,
  RelatedEntityNotFound,
} from "@digital/application";
import type { ProductApplication } from "@digital/product-application";
import {
  applyEntityIdentityMergeRequestSchema,
  entityIdentityMergeRequestSchema,
  publicApiErrorResponseSchema,
  publicEntityIdentityMergePreviewSchema,
  relationshipStatusSchema,
} from "@digital/public-api";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

/** 将身份合并预演、采用和指定撤销送入正式 ProductApplication。 */
export function createIdentityMergeApi(application: ProductApplication): Hono {
  const api = new Hono();

  api.post("/identity/preview", async (context) => {
    const request = await requestBody(
      context,
      entityIdentityMergeRequestSchema,
    );
    if (!request.success)
      return errorResponse(context, "invalid-request", "身份合并信息无效", 400);
    try {
      const preview = await application.workflow.previewEntityIdentityMerge(
        request.output,
      );
      const result = safeParse(publicEntityIdentityMergePreviewSchema, preview);
      if (!result.success)
        throw new Error("identity preview contract mismatch");
      return context.json(result.output);
    } catch (error) {
      return businessError(
        context,
        error,
        "身份合并预演暂时不可用，请稍后重试",
      );
    }
  });

  api.post("/identity/apply", async (context) => {
    const request = await requestBody(
      context,
      applyEntityIdentityMergeRequestSchema,
    );
    if (!request.success)
      return errorResponse(context, "invalid-request", "身份合并信息无效", 400);
    try {
      const status = await application.workflow.applyEntityIdentityMerge({
        ...request.output,
        preview: request.output.preview,
      });
      return decisionResult(context, status, "身份合并预演已过期，请重新检查");
    } catch (error) {
      return businessError(
        context,
        error,
        "身份合并操作暂时不可用，请稍后重试",
      );
    }
  });

  api.post("/identity/undo", async (context) => {
    const request = await requestBody(
      context,
      applyEntityIdentityMergeRequestSchema,
    );
    if (!request.success)
      return errorResponse(
        context,
        "invalid-request",
        "身份合并撤销信息无效",
        400,
      );
    try {
      const status = await application.workflow.undoEntityIdentityMerge({
        ...request.output,
        preview: request.output.preview,
      });
      return decisionResult(context, status, "身份合并状态已变化，请重新检查");
    } catch (error) {
      return businessError(
        context,
        error,
        "身份合并撤销暂时不可用，请稍后重试",
      );
    }
  });

  return api;
}

async function requestBody<Schema extends Parameters<typeof safeParse>[0]>(
  context: Context,
  schema: Schema,
) {
  const body = await context.req.json().catch(() => undefined);
  return safeParse(schema, body);
}

function decisionResult(
  context: Context,
  status: "applied" | "stale",
  staleMessage: string,
) {
  if (status === "stale")
    return errorResponse(context, "conflict", staleMessage, 409);
  const result = safeParse(relationshipStatusSchema, { status });
  if (!result.success) throw new Error("identity result contract mismatch");
  return context.json(result.output);
}

type ErrorCode = "invalid-request" | "conflict" | "not-found" | "unavailable";

function businessError(
  context: Context,
  error: unknown,
  unavailableMessage: string,
) {
  if (error instanceof InvalidIdentityOperation)
    return errorResponse(context, "invalid-request", "身份合并条件无效", 400);
  if (error instanceof RelatedEntityNotFound)
    return errorResponse(context, "not-found", "关联实体不存在", 404);
  if (error instanceof CatalogueDecisionConflict)
    return errorResponse(
      context,
      "conflict",
      "相关事实已变化，请重新检查",
      409,
    );
  return errorResponse(context, "unavailable", unavailableMessage, 503);
}

function errorResponse(
  context: Context,
  code: ErrorCode,
  message: string,
  status: 400 | 404 | 409 | 503,
) {
  return context.json(
    safeParse(publicApiErrorResponseSchema, { error: { code, message } })
      .output,
    status,
  );
}
