import type {
  AssetRefreshInspection,
  AssetLibrary as ApplicationAssetLibrary,
} from "@digital/application";
import {
  AssetLibraryConfigurationConflict,
  AssetLibraryNotFound,
  InvalidAssetLibraryConfiguration,
  InvalidAssetLibraryPageRequest,
  InvalidObservedRootDirectory,
  ObservedRootConfigurationConflict,
  InvalidPageRequest,
} from "@digital/application";
import type {
  ProductApplication,
  ProductRefreshInspection,
} from "@digital/product-application";
import {
  InvalidProductRefreshRequest,
  ProductRefreshTargetNotFound,
  ProductRefreshTargetNotReady,
} from "@digital/product-application";
import {
  assetLibraryOptionsSchema,
  assetLibraryRemovalSchema,
  initialAssetLibraryConfigurationSavedSchema,
  initialAssetLibraryConfigurationRestoreStatusSchema,
  assetLibraryScanSchema,
  assetLibraryScanStartSchema,
  assetLibraryListSchema,
  assetPageSchema,
  createAssetLibraryRequestSchema,
  listAssetLibrariesRequestSchema,
  listAssetsRequestSchema,
  listUnrecognizedMaterialsRequestSchema,
  removeAssetLibraryRequestSchema,
  publicApiErrorResponseSchema,
  publicExecutionCancellationRequestSchema,
  publicExecutionCancellationSchema,
  publicExecutionInspectionSchema,
  publicRefreshExecutionIdSchema,
  publicRefreshOperationRequestSchema,
  updateAssetLibraryRequestSchema,
  unrecognizedMaterialPageSchema,
} from "@digital/public-api";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

import { createAutomationHttpApi } from "./automation.ts";
import { createFanboxConnectionRequestsHttpApi } from "./fanbox-connection-requests.ts";
import { createIdentityMergeApi } from "./identity-merge-api.ts";
import { mountAssetInspectionRoutes } from "./inspection.ts";
import { createMediaHttpApi } from "./media.ts";
import { createMetadataDecisionsHttpApi } from "./metadata-decisions.ts";
import { publicAsset } from "./public-asset.ts";
import { createRelationshipApi } from "./relationship-api.ts";
import { createSourceConnectionsHttpApi } from "./source-connections.ts";
import { createSourceRecognitionHttpApi } from "./source-recognition.ts";
import { createSourceRepairHttpApi } from "./source-repair.ts";

type ApiCode =
  | "invalid-request"
  | "conflict"
  | "not-found"
  | "not-ready"
  | "unavailable"
  | "internal";

type PageQuery = {
  readonly assetLibraryId?: string;
  readonly parentExecutionId?: string;
  readonly limit?: number;
  readonly cursor?: string;
};

/** 建立供 API 客户端使用的中立 HTTP 业务入口。 */
export function createPublicHttpApi(application: ProductApplication): Hono {
  const api = new Hono();
  api.route("/", createRelationshipApi(application));
  api.route("/", createIdentityMergeApi(application));
  api.route("/", createMediaHttpApi(application));
  mountAssetInspectionRoutes(api, application);
  api.route("/", createMetadataDecisionsHttpApi(application));
  api.route("/", createSourceConnectionsHttpApi(application));
  api.route("/", createSourceRecognitionHttpApi(application));
  api.route("/", createSourceRepairHttpApi(application));
  api.route("/", createFanboxConnectionRequestsHttpApi(application));
  api.route("/", createAutomationHttpApi(application));

  api.get("/asset-library-options", (context) => {
    try {
      const libraries = application.workflow.assetLibraries;
      const result = safeParse(assetLibraryOptionsSchema, {
        recognitionProfiles: libraries.recognitionProfiles.map(
          ({ id, displayName }) => ({ id, displayName }),
        ),
        sources: libraries.sources.map(({ id, displayName }) => ({
          id,
          displayName,
        })),
      });
      if (!result.success) throw new Error("资产库选项无效");
      return context.json(result.output);
    } catch {
      return context.json(
        errorResponse("unavailable", "暂时无法读取资产库选项"),
        503,
      );
    }
  });

  api.post("/asset-library-initial-configuration", async (context) => {
    const initialAssetLibraries = application.initialAssetLibraries;
    if (initialAssetLibraries === undefined)
      return context.json(
        errorResponse("unavailable", "当前环境不支持保存初始资产库配置"),
        503,
      );
    try {
      const result = safeParse(
        initialAssetLibraryConfigurationSavedSchema,
        await initialAssetLibraries.save(),
      );
      if (!result.success) throw new Error("初始资产库配置保存结果无效");
      return context.json(result.output);
    } catch {
      return context.json(
        errorResponse("unavailable", "初始资产库配置暂时无法保存"),
        503,
      );
    }
  });

  api.get("/asset-library-initial-configuration", async (context) => {
    const initialAssetLibraries = application.initialAssetLibraries;
    if (initialAssetLibraries === undefined)
      return context.json(
        errorResponse("unavailable", "当前环境不支持检查初始资产库配置"),
        503,
      );
    try {
      const result = safeParse(
        initialAssetLibraryConfigurationRestoreStatusSchema,
        await initialAssetLibraries.inspectRestoreStatus(),
      );
      if (!result.success) throw new Error("初始资产库配置状态无效");
      return context.json(result.output);
    } catch {
      return context.json(
        errorResponse("unavailable", "初始资产库配置状态暂时无法读取"),
        503,
      );
    }
  });

  api.post("/asset-library-initial-configuration/restore", async (context) => {
    const initialAssetLibraries = application.initialAssetLibraries;
    if (initialAssetLibraries === undefined)
      return context.json(
        errorResponse("unavailable", "当前环境不支持恢复初始资产库配置"),
        503,
      );
    try {
      const result = safeParse(
        initialAssetLibraryConfigurationRestoreStatusSchema,
        await initialAssetLibraries.restoreForDataGeneration(),
      );
      if (!result.success) throw new Error("初始资产库配置恢复结果无效");
      return context.json(result.output);
    } catch {
      return context.json(
        errorResponse("unavailable", "初始资产库配置暂时无法恢复"),
        503,
      );
    }
  });

  api.get("/asset-libraries", async (context) => {
    const query = parseAssetLibraryPageQuery(context.req.query());
    if (query === undefined)
      return context.json(
        errorResponse("invalid-request", "资产库查询条件无效"),
        400,
      );
    try {
      const page = await application.workflow.assetLibraries.listPage(query);
      const items = await Promise.all(
        page.items.map(
          async (library) => await publicAssetLibrary(application, library),
        ),
      );
      const result = safeParse(assetLibraryListSchema, {
        items,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      });
      if (!result.success) throw new Error("资产库结果无效");
      return context.json(result.output);
    } catch (error) {
      if (error instanceof InvalidAssetLibraryPageRequest)
        return context.json(
          errorResponse("invalid-request", "资产库查询条件无效"),
          400,
        );
      return context.json(
        errorResponse("unavailable", "暂时无法读取资产库"),
        503,
      );
    }
  });

  api.post("/asset-libraries", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const input = safeParse(createAssetLibraryRequestSchema, body);
    if (!input.success)
      return context.json(
        errorResponse("invalid-request", "资产库配置无效"),
        400,
      );
    try {
      const library = await application.workflow.assetLibraries.save(
        input.output,
      );
      return context.json(await publicAssetLibrary(application, library), 201);
    } catch (error) {
      return assetLibraryMutationError(context, error);
    }
  });

  api.put("/asset-libraries/:id", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const input = safeParse(updateAssetLibraryRequestSchema, body);
    if (!input.success)
      return context.json(
        errorResponse("invalid-request", "资产库配置无效"),
        400,
      );
    try {
      const library = await application.workflow.assetLibraries.save({
        id: context.req.param("id"),
        expectedVersion: input.output.expectedVersion,
        displayName: input.output.displayName,
        directories: input.output.directories,
        recognitionProfileIds: input.output.recognitionProfileIds,
        sourceIdentities: input.output.sourceIdentities,
      });
      return context.json(await publicAssetLibrary(application, library));
    } catch (error) {
      return assetLibraryMutationError(context, error);
    }
  });

  api.delete("/asset-libraries/:id", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const input = safeParse(removeAssetLibraryRequestSchema, body);
    if (!input.success)
      return context.json(
        errorResponse("invalid-request", "资产库配置无效"),
        400,
      );
    try {
      await application.workflow.assetLibraries.remove({
        id: context.req.param("id"),
        expectedVersion: input.output.expectedVersion,
      });
      const result = safeParse(assetLibraryRemovalSchema, { removed: true });
      if (!result.success) throw new Error("资产库移除结果无效");
      return context.json(result.output);
    } catch (error) {
      return assetLibraryMutationError(context, error);
    }
  });

  api.post("/asset-libraries/:id/scans", async (context) => {
    const assetLibraryId = context.req.param("id");
    try {
      if (
        (await application.workflow.assetLibraries.get(assetLibraryId)) ===
        undefined
      )
        return context.json(
          errorResponse("not-found", "资产库不存在或已移除"),
          404,
        );
      const execution = await application.refresh.startLibraryScan({
        libraryId: assetLibraryId,
        acceptTrusted: true,
        initiatedBy: "public-api",
      });
      const result = safeParse(assetLibraryScanStartSchema, {
        parentExecutionId: execution.id,
      });
      if (!result.success) throw new Error("扫描记录无效");
      return context.json(result.output, 202);
    } catch (error) {
      return assetLibraryMutationError(context, error);
    }
  });

  api.get("/asset-library-scans/:id", async (context) => {
    try {
      const scan = await application.workflow.inspectAssetLibraryScan(
        context.req.param("id"),
      );
      if (scan === undefined)
        return context.json(
          errorResponse("not-found", "没有这次扫描记录"),
          404,
        );
      const result = safeParse(assetLibraryScanSchema, {
        parentExecutionId: scan.parentExecutionId,
        assetLibraryId: scan.assetLibraryId,
        configVersion: scan.configVersion,
        status: scan.status,
        ...(scan.outcome === undefined ? {} : { outcome: scan.outcome }),
        directories: scan.directories.map((directory) => ({
          id: directory.directoryKey,
          displayName: directory.displayName,
          stage: directory.stage,
          mode: directory.mode,
          ...(directory.outcome === undefined
            ? {}
            : { outcome: directory.outcome }),
          ...(directory.reason === undefined
            ? {}
            : { reason: directory.reason }),
          workItemCount: directory.workItemCount,
          unresolvedCount: directory.unresolvedCount,
          failedCount: directory.failedCount,
          files: directory.workItems.map((item) => ({
            relativePaths: item.relativePaths,
            ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
            ...(item.outcome === "accepted" &&
            (item.acceptedAssetId ?? item.retainedAssetId) !== undefined
              ? { assetId: item.acceptedAssetId ?? item.retainedAssetId }
              : {}),
          })),
        })),
      });
      if (!result.success) throw new Error("扫描结果无效");
      return context.json(result.output);
    } catch {
      return context.json(
        errorResponse("unavailable", "暂时无法读取扫描结果"),
        503,
      );
    }
  });

  api.post("/refreshes", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const input = safeParse(publicRefreshOperationRequestSchema, body);
    if (!input.success)
      return context.json(
        errorResponse("invalid-request", "刷新请求无效"),
        400,
      );
    try {
      const execution =
        input.output.operation === "rescrape"
          ? await application.refresh.startCurrentScopeRescrape({
              subjectId: input.output.subjectId,
            })
          : await application.refresh.startMetadataRefresh({
              subjectId: input.output.subjectId,
              initiatedBy: "public-api",
              ...(input.output.reviewPolicy === undefined
                ? {}
                : { reviewPolicy: input.output.reviewPolicy }),
            });
      const result = safeParse(publicRefreshExecutionIdSchema, execution);
      if (!result.success) throw new Error("刷新执行身份无效");
      return context.json(result.output, 202);
    } catch (error) {
      return refreshMutationError(context, error);
    }
  });

  api.get("/executions/:id", async (context) => {
    try {
      const inspection = await application.refresh.inspect(
        context.req.param("id"),
      );
      if (inspection === undefined)
        return context.json(
          errorResponse("not-found", "没有这次执行记录"),
          404,
        );
      const result = safeParse(
        publicExecutionInspectionSchema,
        publicExecutionInspection(inspection),
      );
      if (!result.success) throw new Error("执行检查结果无效");
      return context.json(result.output);
    } catch {
      return context.json(
        errorResponse("unavailable", "暂时无法读取执行状态"),
        503,
      );
    }
  });

  api.post("/executions/:id/cancel", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const input = safeParse(publicExecutionCancellationRequestSchema, body);
    if (!input.success)
      return context.json(
        errorResponse("invalid-request", "取消请求无效"),
        400,
      );
    try {
      const cancellation = await application.refresh.cancel({
        executionId: context.req.param("id"),
        requestedBy: "public-api",
        requestedAt: new Date().toISOString(),
        ...(input.output.reason === undefined
          ? {}
          : { reason: input.output.reason }),
      });
      const result = safeParse(publicExecutionCancellationSchema, {
        requestStatus: cancellation.status,
        inspection: publicExecutionInspection(cancellation.inspection),
      });
      if (!result.success) throw new Error("取消检查结果无效");
      return context.json(result.output);
    } catch (error) {
      return refreshMutationError(context, error);
    }
  });

  api.get("/assets", async (context) => {
    const query = parsePageQuery(context.req.query(), listAssetsRequestSchema);
    if (query === undefined)
      return context.json(
        errorResponse("invalid-request", "资产查询条件无效"),
        400,
      );
    try {
      if (
        query.assetLibraryId !== undefined &&
        (await application.workflow.assetLibraries.get(
          query.assetLibraryId,
        )) === undefined
      )
        return context.json(
          errorResponse("not-found", "资产库不存在或已移除"),
          404,
        );
      const page = await application.workflow.listCurrentCataloguePage({
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.assetLibraryId === undefined
          ? {}
          : { assetLibraryId: query.assetLibraryId }),
      });
      const result = safeParse(assetPageSchema, {
        items: page.items.map((asset) =>
          publicAsset(application, asset, query.assetLibraryId),
        ),
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      });
      if (!result.success) throw new Error("资产读取结果无效");
      return context.json(result.output);
    } catch (error) {
      if (error instanceof InvalidPageRequest)
        return context.json(
          errorResponse("invalid-request", "资产查询条件无效"),
          400,
        );
      return context.json(
        errorResponse("unavailable", "暂时无法读取资产"),
        503,
      );
    }
  });

  api.get("/unrecognized-materials", async (context) => {
    const query = parsePageQuery(
      context.req.query(),
      listUnrecognizedMaterialsRequestSchema,
      true,
    );
    if (query === undefined)
      return context.json(
        errorResponse("invalid-request", "未识别材料查询条件无效"),
        400,
      );
    try {
      if (
        query.assetLibraryId !== undefined &&
        (await application.workflow.assetLibraries.get(
          query.assetLibraryId,
        )) === undefined
      )
        return context.json(
          errorResponse("not-found", "资产库不存在或已移除"),
          404,
        );
      const page =
        await application.workflow.listUnrecognizedLibraryScanObservationPage({
          ...(query.assetLibraryId === undefined
            ? {}
            : { assetLibraryId: query.assetLibraryId }),
          ...(query.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: query.parentExecutionId }),
          currentOnly: true,
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
      const result = safeParse(unrecognizedMaterialPageSchema, page);
      if (!result.success) throw new Error("未识别材料读取结果无效");
      return context.json(result.output);
    } catch (error) {
      if (error instanceof InvalidPageRequest)
        return context.json(
          errorResponse("invalid-request", "未识别材料查询条件无效"),
          400,
        );
      return context.json(
        errorResponse("unavailable", "暂时无法读取未识别材料"),
        503,
      );
    }
  });

  return api;
}

function parsePageQuery<Schema extends Parameters<typeof safeParse>[0]>(
  query: Record<string, string | undefined>,
  schema: Schema,
  allowParentExecutionId = false,
): PageQuery | undefined {
  if (
    !Object.keys(query).every((key) =>
      [
        "assetLibraryId",
        "limit",
        "cursor",
        ...(allowParentExecutionId ? ["parentExecutionId"] : []),
      ].includes(key),
    )
  )
    return undefined;
  const input = {
    ...(query.assetLibraryId === undefined
      ? {}
      : { assetLibraryId: query.assetLibraryId }),
    ...(query.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: query.parentExecutionId }),
    ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
  const result = safeParse(schema, input);
  return result.success ? (result.output as PageQuery) : undefined;
}

function parseAssetLibraryPageQuery(
  query: Record<string, string | undefined>,
): { readonly limit?: number; readonly cursor?: string } | undefined {
  if (!Object.keys(query).every((key) => ["limit", "cursor"].includes(key)))
    return undefined;
  const result = safeParse(listAssetLibrariesRequestSchema, {
    ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  return result.success ? result.output : undefined;
}

function errorResponse(code: ApiCode, message: string) {
  return safeParse(publicApiErrorResponseSchema, { error: { code, message } })
    .output;
}

function publicExecutionDetails(inspection: AssetRefreshInspection) {
  const execution = inspection.execution;
  return {
    status: execution.status,
    stage: execution.stage,
    ...(execution.outcome === undefined ? {} : { outcome: execution.outcome }),
    ...(execution.reason === undefined ? {} : { reason: execution.reason }),
    ...(execution.cancellation === undefined
      ? {}
      : { cancellation: execution.cancellation }),
    progress: {
      dispositions: execution.dispositions.map(({ key, status, reason }) => ({
        key,
        status,
        ...(reason === undefined ? {} : { reason }),
      })),
      workItems: (execution.workItems ?? []).map((item) => ({
        key: item.key,
        relativePaths: item.relativePaths,
        ...(item.retainedAssetId === undefined
          ? {}
          : { retainedAssetId: item.retainedAssetId }),
        ...(item.plannedAssetId === undefined
          ? {}
          : { plannedAssetId: item.plannedAssetId }),
        ...(item.acceptedAssetId === undefined
          ? {}
          : { acceptedAssetId: item.acceptedAssetId }),
        ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
        ...(item.reason === undefined ? {} : { reason: item.reason }),
      })),
      targets: (execution.targetDispositions ?? []).map((target) => ({
        key: target.key,
        kind: target.target.kind,
        ...(target.target.kind === "subject"
          ? { subjectId: target.target.subjectId }
          : {}),
        status: target.status,
        ...(target.reason === undefined ? {} : { reason: target.reason }),
      })),
    },
    sourceRefreshRuns: inspection.sourceRefreshRuns ?? [],
  };
}

function publicExecutionInspection(inspection: ProductRefreshInspection) {
  if (inspection.kind === "execution")
    return {
      kind: "execution" as const,
      id: inspection.execution.execution.id,
      ...(inspection.execution.execution.operationKind === undefined
        ? {}
        : { operationKind: inspection.execution.execution.operationKind }),
      ...publicExecutionDetails(inspection.execution),
    };

  return {
    kind: "asset-library-scan" as const,
    id: inspection.scan.parentExecutionId,
    status: inspection.scan.status,
    ...(inspection.scan.outcome === undefined
      ? {}
      : { outcome: inspection.scan.outcome }),
    ...(inspection.scan.cancellationRequested === undefined
      ? {}
      : { cancellationRequested: inspection.scan.cancellationRequested }),
    children: inspection.children.map((child) =>
      child.status === "missing"
        ? { executionId: child.executionId, status: "missing" as const }
        : {
            executionId: child.executionId,
            status: "available" as const,
            execution: publicExecutionDetails(child.inspection),
          },
    ),
  };
}

function refreshMutationError(context: Context, error: unknown) {
  if (error instanceof InvalidProductRefreshRequest)
    return context.json(errorResponse("invalid-request", error.message), 400);
  if (error instanceof ProductRefreshTargetNotFound)
    return context.json(errorResponse("not-found", error.message), 404);
  if (error instanceof ProductRefreshTargetNotReady)
    return context.json(errorResponse("not-ready", error.message), 409);
  if (error instanceof AssetLibraryNotFound)
    return context.json(errorResponse("not-found", error.message), 404);
  return context.json(
    errorResponse("unavailable", "刷新操作暂时不可用，请稍后重试"),
    503,
  );
}

async function publicAssetLibrary(
  application: ProductApplication,
  library: ApplicationAssetLibrary,
) {
  const directories = await application.workflow.assetLibraries.directoryViews(
    library.id,
  );
  return {
    id: library.id,
    displayName: library.displayName,
    configVersion: library.configVersion,
    recognitionProfileIds: library.recognitionProfileIds,
    sourceIdentities: library.sourceIdentities,
    directories: directories.map((directory) => ({
      id: directory.directoryId,
      displayName: directory.displayName,
      path: directory.containerPath,
      status: directory.status,
      reachable: directory.reachable,
      ...(directory.problem === undefined
        ? {}
        : { problem: directory.problem }),
    })),
  };
}

function assetLibraryMutationError(context: Context, error: unknown) {
  if (error instanceof InvalidAssetLibraryConfiguration)
    return context.json(errorResponse("invalid-request", error.message), 400);
  if (error instanceof InvalidObservedRootDirectory)
    return context.json(errorResponse("invalid-request", error.message), 400);
  if (
    error instanceof AssetLibraryConfigurationConflict ||
    error instanceof ObservedRootConfigurationConflict
  )
    return context.json(
      errorResponse("conflict", "资产库配置已更新，请重新读取后再操作"),
      409,
    );
  if (error instanceof AssetLibraryNotFound)
    return context.json(errorResponse("not-found", error.message), 404);
  return context.json(
    errorResponse("unavailable", "资产库操作暂时不可用，请稍后重试"),
    503,
  );
}
