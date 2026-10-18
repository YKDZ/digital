import {
  EntityMentionNotFound,
  InvalidIdentityOperation,
  InvalidRelationshipOperation,
  RelatedEntityNotFound,
  RelationshipTargetNotFound,
  CatalogueDecisionConflict,
} from "@digital/application";
import type { ProductApplication } from "@digital/product-application";
import {
  applyRelationshipChangeRequestSchema,
  createRelatedEntityRequestSchema,
  entityMentionIdRequestSchema,
  listRelatedEntitiesRequestSchema,
  publicApiErrorResponseSchema,
  publicEntityMentionResolutionSchema,
  publicRelatedEntityIdentitySchema,
  relatedEntityIdRequestSchema,
  relatedEntityIdentityListSchema,
  relatedEntityInspectionSchema,
  relationshipChangePreviewSchema,
  relationshipChangeRequestSchema,
  relationshipStatusSchema,
  relationshipTypeDefinitionListSchema,
  resolveEntityMentionRequestSchema,
  retractEntityMentionRequestSchema,
} from "@digital/public-api";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

import { publicAsset } from "./public-asset.ts";

/** 将关系与实体指称操作送入正式 ProductApplication。 */
export function createRelationshipApi(application: ProductApplication): Hono {
  const api = new Hono();

  api.get("/relationships/types", (context) => {
    try {
      const result = safeParse(
        relationshipTypeDefinitionListSchema,
        application.workflow.relationshipTypeDefinitions(),
      );
      if (!result.success) throw new Error("relationship contract mismatch");
      return context.json(result.output);
    } catch {
      return unavailable(context);
    }
  });

  api.get("/relationships/entities", async (context) => {
    const query = safeParse(listRelatedEntitiesRequestSchema, {
      label: context.req.query("label"),
    });
    if (!query.success)
      return errorResponse(
        context,
        "invalid-request",
        "关联实体查询条件无效",
        400,
      );
    try {
      const entities = await application.workflow.findRelatedEntities(
        query.output.label,
      );
      const result = safeParse(relatedEntityIdentityListSchema, entities);
      if (!result.success) throw new Error("related entity contract mismatch");
      return context.json(result.output);
    } catch {
      return unavailable(context);
    }
  });

  api.get("/relationships/entities/:id", async (context) => {
    const request = safeParse(relatedEntityIdRequestSchema, {
      entityId: context.req.param("id"),
    });
    if (!request.success)
      return errorResponse(context, "invalid-request", "关联实体编号无效", 400);
    try {
      const inspection =
        await application.workflow.inspectCurrentCatalogueEntity(
          request.output.entityId,
        );
      if (inspection === undefined)
        return errorResponse(context, "not-found", "关联实体不存在", 404);
      const result = safeParse(relatedEntityInspectionSchema, {
        ...inspection,
        accepted: inspection.accepted.map((asset) =>
          publicAsset(application, asset),
        ),
      });
      if (!result.success)
        throw new Error("related entity inspection mismatch");
      return context.json(result.output);
    } catch (error) {
      return businessError(context, error, "关系查询暂时不可用，请稍后重试");
    }
  });

  api.post("/relationships/entities", async (context) => {
    const request = await requestBody(
      context,
      createRelatedEntityRequestSchema,
    );
    if (!request.success)
      return errorResponse(
        context,
        "invalid-request",
        "本地关联实体信息无效",
        400,
      );
    try {
      const entity = await application.workflow.createLocalRelatedEntity(
        request.output,
      );
      const result = safeParse(publicRelatedEntityIdentitySchema, entity);
      if (!result.success) throw new Error("related entity contract mismatch");
      return context.json(result.output, 201);
    } catch (error) {
      return businessError(context, error, "关系操作暂时不可用，请稍后重试");
    }
  });

  api.post("/relationships/preview", async (context) => {
    const request = await requestBody(context, relationshipChangeRequestSchema);
    if (!request.success)
      return errorResponse(context, "invalid-request", "关系修改信息无效", 400);
    try {
      const preview = await application.workflow.previewRelationshipChange({
        changes: request.output.changes,
      });
      const result = safeParse(relationshipChangePreviewSchema, preview);
      if (!result.success) throw new Error("relationship preview mismatch");
      return context.json(result.output);
    } catch (error) {
      return businessError(context, error, "关系预演暂时不可用，请稍后重试");
    }
  });

  api.post("/relationships/apply", async (context) => {
    const request = await requestBody(
      context,
      applyRelationshipChangeRequestSchema,
    );
    if (!request.success)
      return errorResponse(context, "invalid-request", "关系修改信息无效", 400);
    try {
      const status = await application.workflow.applyRelationshipChange({
        actorId: request.output.actorId,
        preview: request.output.preview,
      });
      if (status === "stale")
        return errorResponse(
          context,
          "conflict",
          "关系预演已过期，请重新检查",
          409,
        );
      const result = safeParse(relationshipStatusSchema, { status });
      if (!result.success) throw new Error("relationship result mismatch");
      return context.json(result.output);
    } catch (error) {
      return businessError(context, error, "关系操作暂时不可用，请稍后重试");
    }
  });

  api.get("/entity-mentions/:mentionId/resolution", async (context) => {
    const request = safeParse(entityMentionIdRequestSchema, {
      mentionId: context.req.param("mentionId"),
    });
    if (!request.success)
      return errorResponse(context, "invalid-request", "实体指称编号无效", 400);
    try {
      const resolution =
        await application.workflow.inspectEntityMentionResolution(
          request.output.mentionId,
        );
      const result = safeParse(publicEntityMentionResolutionSchema, resolution);
      if (!result.success) throw new Error("entity mention contract mismatch");
      return context.json(result.output);
    } catch (error) {
      return businessError(context, error, "实体指称暂时不可用，请稍后重试");
    }
  });

  api.post("/entity-mentions/:mentionId/resolution", async (context) => {
    const id = safeParse(entityMentionIdRequestSchema, {
      mentionId: context.req.param("mentionId"),
    });
    const request = await requestBody(
      context,
      resolveEntityMentionRequestSchema,
    );
    if (!id.success || !request.success)
      return errorResponse(
        context,
        "invalid-request",
        "实体指称解析信息无效",
        400,
      );
    try {
      const status = await application.workflow.resolveEntityMentionManually({
        mentionId: id.output.mentionId,
        ...request.output,
      });
      return decisionResult(context, status, "实体指称解析已变化，请重新检查");
    } catch (error) {
      return businessError(
        context,
        error,
        "实体指称操作暂时不可用，请稍后重试",
      );
    }
  });

  api.delete("/entity-mentions/:mentionId/resolution", async (context) => {
    const id = safeParse(entityMentionIdRequestSchema, {
      mentionId: context.req.param("mentionId"),
    });
    const request = await requestBody(
      context,
      retractEntityMentionRequestSchema,
    );
    if (!id.success || !request.success)
      return errorResponse(
        context,
        "invalid-request",
        "实体指称撤回信息无效",
        400,
      );
    try {
      const status = await application.workflow.retractEntityMentionResolution({
        mentionId: id.output.mentionId,
        ...request.output,
      });
      return decisionResult(context, status, "实体指称解析已变化，请重新检查");
    } catch (error) {
      return businessError(
        context,
        error,
        "实体指称操作暂时不可用，请稍后重试",
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
  if (!result.success) throw new Error("decision result mismatch");
  return context.json(result.output);
}

type ErrorCode = "invalid-request" | "conflict" | "not-found" | "unavailable";

function businessError(
  context: Context,
  error: unknown,
  unavailableMessage: string,
) {
  if (
    error instanceof InvalidRelationshipOperation ||
    error instanceof InvalidIdentityOperation
  )
    return errorResponse(
      context,
      "invalid-request",
      "请求内容与当前业务约束不符",
      400,
    );
  if (
    error instanceof RelationshipTargetNotFound ||
    error instanceof RelatedEntityNotFound ||
    error instanceof EntityMentionNotFound
  )
    return errorResponse(context, "not-found", "请求的关系目标已不存在", 404);
  if (error instanceof CatalogueDecisionConflict)
    return errorResponse(
      context,
      "conflict",
      "相关事实已变化，请重新检查",
      409,
    );
  return errorResponse(context, "unavailable", unavailableMessage, 503);
}

function unavailable(context: Context) {
  return errorResponse(
    context,
    "unavailable",
    "关系资料暂时不可用，请稍后重试",
    503,
  );
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
