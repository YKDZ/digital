import type {
  ChangeImpactPreviewInspection,
  ObservedMaterialAssociationInspection,
} from "@digital/application";
import { RecognitionRepairPreparationError } from "@digital/application";
import type { ProductApplication } from "@digital/product-application";
import {
  artifactRoleCoverInspectionSchema,
  artifactRoleDecisionRequestSchema,
  changeImpactConfirmationRequestSchema,
  changeImpactPreviewSchema,
  changeImpactRejectionRequestSchema,
  observedMaterialAssociationInspectionSchema,
  observedMaterialAssociationRequestSchema,
  observedMaterialAssociationStartSchema,
  observedMaterialConfirmationRequestSchema,
  publicApiErrorResponseSchema,
  recognitionRetractionRequestSchema,
  recognitionScopeAmendmentRequestSchema,
  sourceRefreshChangeSetReviewRequestSchema,
  sourceRefreshRunIdRequestSchema,
  sourceRefreshRunSchema,
  sourceAssociationHistorySchema,
} from "@digital/public-api";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

/** 统一公开来源修复流程；确认始终复用应用预演的版本和条件比较。 */
export function createSourceRepairHttpApi(
  application: ProductApplication,
): Hono {
  const api = new Hono();

  api.get("/assets/:assetId/source-association-history", async (context) => {
    try {
      const history = await application.workflow.inspectCorrectionSubject(
        context.req.param("assetId"),
      );
      if (history === undefined)
        return error(context, "not-found", "没有找到当前内容", 404);
      const result = safeParse(sourceAssociationHistorySchema, {
        ...history,
        current: history.current.map(publicAssociation),
        historical: history.historical.map((item) => ({
          association: publicAssociation(item.association),
          status: item.status,
          ...(item.authorizedBy === undefined
            ? {}
            : { authorizedBy: authorizationReference(item.authorizedBy) }),
        })),
      });
      if (!result.success) throw new Error("来源历史结果无效");
      return context.json(result.output);
    } catch {
      return error(context, "unavailable", "暂时无法读取来源关联历史", 503);
    }
  });

  api.post("/recognition-retractions", async (context) => {
    const request = safeParse(
      recognitionRetractionRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return error(context, "invalid-request", "身份撤回请求无效", 400);
    try {
      const preview = await application.workflow.prepareRecognitionRetraction(
        request.output,
      );
      return previewResponse(context, preview);
    } catch (cause) {
      if (cause instanceof RecognitionRepairPreparationError)
        return recognitionRepairPreparationFailure(context, cause, "撤回");
      return error(context, "unavailable", "暂时无法形成身份撤回预演", 503);
    }
  });

  api.post("/recognition-scope-amendments", async (context) => {
    const request = safeParse(
      recognitionScopeAmendmentRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return error(context, "invalid-request", "识别范围调整请求无效", 400);
    try {
      const preview =
        await application.workflow.prepareRecognitionScopeAmendment(
          request.output,
        );
      return previewResponse(context, preview);
    } catch (cause) {
      if (cause instanceof RecognitionRepairPreparationError)
        return recognitionRepairPreparationFailure(context, cause, "范围调整");
      return error(context, "unavailable", "暂时无法调整识别范围", 503);
    }
  });

  api.get("/change-impact-previews/:previewId", async (context) => {
    const previewId = context.req.param("previewId");
    try {
      const preview =
        await application.workflow.inspectChangeImpactPreview(previewId);
      return preview === undefined
        ? error(context, "not-found", "没有找到变更影响预演", 404)
        : previewResponse(context, preview);
    } catch {
      return error(context, "unavailable", "暂时无法读取变更影响预演", 503);
    }
  });

  api.post("/change-impact-previews/:previewId/confirm", async (context) => {
    const request = safeParse(
      changeImpactConfirmationRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return error(context, "invalid-request", "变更确认者无效", 400);
    if (request.output.confirmedBy.trim().length === 0)
      return error(context, "invalid-request", "变更确认者无效", 400);
    const previewId = context.req.param("previewId");
    try {
      const current =
        await application.workflow.inspectChangeImpactPreview(previewId);
      if (current === undefined)
        return error(context, "not-found", "没有找到变更影响预演", 404);
      await application.workflow.applyChangeImpactPreview({
        previewId,
        confirmedBy: request.output.confirmedBy,
      });
      const applied =
        await application.workflow.inspectChangeImpactPreview(previewId);
      if (applied === undefined)
        return error(context, "unavailable", "暂时无法读取确认结果", 503);
      return previewResponse(context, applied);
    } catch {
      return error(context, "unavailable", "暂时无法确认变更影响", 503);
    }
  });

  api.post("/change-impact-previews/:previewId/reject", async (context) => {
    const request = safeParse(
      changeImpactRejectionRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return error(context, "invalid-request", "变更拒绝者无效", 400);
    if (request.output.rejectedBy.trim().length === 0)
      return error(context, "invalid-request", "变更拒绝者无效", 400);
    const previewId = context.req.param("previewId");
    try {
      const current =
        await application.workflow.inspectChangeImpactPreview(previewId);
      if (current === undefined)
        return error(context, "not-found", "没有找到变更影响预演", 404);
      if (current.status !== "awaiting-confirmation")
        return error(context, "conflict", "这份预演当前不能拒绝", 409);
      const preview = await application.workflow.rejectChangeImpactPreview({
        previewId,
        rejectedBy: request.output.rejectedBy,
      });
      return previewResponse(context, preview);
    } catch {
      return error(context, "unavailable", "暂时无法拒绝变更影响", 503);
    }
  });

  api.get("/assets/:entityId/artifact-role-covers", async (context) => {
    try {
      if (
        (await application.workflow.inspectAssetEvidence(
          context.req.param("entityId"),
        )) === undefined
      )
        return error(context, "not-found", "没有找到当前内容", 404);
      const inspection = await application.workflow.inspectArtifactRoleCovers({
        entityId: context.req.param("entityId"),
      });
      const result = safeParse(artifactRoleCoverInspectionSchema, {
        entityId: inspection.entityId,
        candidates: inspection.candidates.map((candidate) => ({
          reference: candidate.reference,
          kind: candidate.kind,
          title: coverTitle(candidate.address),
        })),
        ...(inspection.effectiveReference === undefined
          ? {}
          : { effectiveReference: inspection.effectiveReference }),
        ...(inspection.decision === undefined
          ? {}
          : { decision: inspection.decision }),
        problems: inspection.problems,
      });
      if (!result.success) throw new Error("封面候选检查结果无效");
      return context.json(result.output);
    } catch {
      return error(context, "unavailable", "暂时无法检查封面候选", 503);
    }
  });

  api.post("/assets/:entityId/artifact-role-decisions", async (context) => {
    const request = safeParse(
      artifactRoleDecisionRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return error(context, "invalid-request", "封面决定请求无效", 400);
    if (request.output.initiatedBy.trim().length === 0)
      return error(context, "invalid-request", "封面决定请求无效", 400);
    try {
      const entityId = context.req.param("entityId");
      if (
        (await application.workflow.inspectAssetEvidence(entityId)) ===
        undefined
      )
        return error(context, "not-found", "没有找到当前内容", 404);
      const covers = await application.workflow.inspectArtifactRoleCovers({
        entityId,
      });
      if (
        request.output.candidateReference === undefined
          ? covers.decision === undefined
          : !covers.candidates.some(
              ({ reference }) =>
                reference === request.output.candidateReference,
            )
      )
        return error(context, "conflict", "当前封面选择条件已变化", 409);
      const preview = await application.workflow.prepareArtifactRoleDecision({
        entityId,
        ...request.output,
      });
      return previewResponse(context, preview);
    } catch {
      return error(context, "unavailable", "暂时无法准备封面决定", 503);
    }
  });

  api.post("/observed-material-associations", async (context) => {
    const request = safeParse(
      observedMaterialAssociationRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return error(context, "invalid-request", "观察材料关联请求无效", 400);
    if (request.output.initiatedBy.trim().length === 0)
      return error(context, "invalid-request", "观察材料关联请求无效", 400);
    try {
      const library = await application.workflow.assetLibraries.get(
        request.output.assetLibraryId,
      );
      if (library === undefined)
        return error(context, "not-found", "资产库不存在或已移除", 404);
      const directories =
        await application.workflow.assetLibraries.directoryViews(library.id);
      const directory = directories.find(
        (candidate) => candidate.directoryId === request.output.directoryId,
      );
      if (directory === undefined || directory.status !== "active")
        return error(context, "not-found", "资产库目录不存在或已移除", 404);
      if (
        (await application.workflow.inspectAssetEvidence(
          request.output.targetAssetId,
        )) === undefined
      )
        return error(context, "not-found", "没有找到要关联材料的内容", 404);
      const started = await application.execution.invoke(async (control) => {
        await application.workflow.prepareObservedMaterialAssociation({
          targetAssetId: request.output.targetAssetId,
          registrationId: directory.observedRootId,
          relativeScope: request.output.relativeScope,
          relativePaths: request.output.relativePaths,
          initiatedBy: request.output.initiatedBy,
          onExecutionStarted(execution) {
            control.executionStarted(execution.id);
          },
          onHostCheckpoint() {
            control.safeCheckpoint();
          },
        });
      });
      const result = safeParse(observedMaterialAssociationStartSchema, {
        executionId: started.id,
      });
      if (!result.success) throw new Error("观察材料关联编号无效");
      return context.json(result.output, 202);
    } catch {
      return error(context, "unavailable", "暂时无法准备材料关联", 503);
    }
  });

  api.get("/observed-material-associations/:executionId", async (context) => {
    const parsed = safeParse(observedMaterialAssociationStartSchema, {
      executionId: context.req.param("executionId"),
    });
    if (!parsed.success)
      return error(context, "invalid-request", "材料关联执行编号无效", 400);
    try {
      const generic = await application.workflow.inspect(
        parsed.output.executionId,
      );
      if (
        generic === undefined ||
        generic.execution.materialAssociation === undefined
      )
        return error(context, "not-found", "没有找到观察材料关联记录", 404);
      const inspection =
        await application.workflow.inspectObservedMaterialAssociation(
          parsed.output.executionId,
        );
      return observedMaterialAssociationResponse(context, inspection);
    } catch {
      return error(context, "unavailable", "暂时无法读取材料关联", 503);
    }
  });

  api.post(
    "/observed-material-associations/:executionId/confirm",
    async (context) => {
      const parsed = safeParse(
        observedMaterialConfirmationRequestSchema,
        await context.req.json().catch(() => undefined),
      );
      if (!parsed.success)
        return error(context, "invalid-request", "材料关联确认请求无效", 400);
      if (parsed.output.confirmedBy.trim().length === 0)
        return error(context, "invalid-request", "材料关联确认请求无效", 400);
      const executionId = context.req.param("executionId");
      try {
        const generic = await application.workflow.inspect(executionId);
        if (
          generic === undefined ||
          generic.execution.materialAssociation === undefined
        )
          return error(context, "not-found", "没有找到观察材料关联记录", 404);
        if (
          ![
            "awaiting-confirmation",
            "confirmation-recorded",
            "revalidating",
          ].includes(generic.execution.materialAssociation.state)
        )
          return error(context, "conflict", "这项材料关联当前不能确认", 409);
        const inspection =
          await new Promise<ObservedMaterialAssociationInspection>(
            (resolve, reject) => {
              void application.execution
                .invoke(async (control) => {
                  control.executionStarted(executionId);
                  try {
                    resolve(
                      await application.workflow.confirmObservedMaterialAssociation(
                        {
                          executionId,
                          confirmedBy: parsed.output.confirmedBy,
                          onHostCheckpoint() {
                            control.safeCheckpoint();
                          },
                        },
                      ),
                    );
                  } catch (cause) {
                    reject(cause);
                    throw cause;
                  }
                })
                .catch(reject);
            },
          );
        return observedMaterialAssociationResponse(context, inspection);
      } catch {
        return error(context, "unavailable", "暂时无法确认材料关联", 503);
      }
    },
  );

  api.get("/source-refresh-runs/:runId", async (context) => {
    const parsed = safeParse(sourceRefreshRunIdRequestSchema, {
      runId: context.req.param("runId"),
    });
    if (!parsed.success)
      return error(context, "invalid-request", "来源刷新编号无效", 400);
    try {
      const run = await application.workflow.inspectSourceRefreshRun(
        parsed.output.runId,
      );
      if (run === undefined)
        return error(context, "not-found", "没有找到来源刷新记录", 404);
      const result = safeParse(sourceRefreshRunSchema, run);
      if (!result.success) throw new Error("来源刷新检查结果无效");
      return context.json(result.output);
    } catch {
      return error(context, "unavailable", "暂时无法读取来源刷新记录", 503);
    }
  });

  api.post(
    "/source-refresh-runs/:runId/change-sets/:changeSetId/review",
    async (context) => {
      const body: unknown = await context.req.json().catch(() => undefined);
      if (typeof body !== "object" || body === null || Array.isArray(body))
        return error(context, "invalid-request", "来源更新审核请求无效", 400);
      const parsed = safeParse(sourceRefreshChangeSetReviewRequestSchema, {
        changeSetId: context.req.param("changeSetId"),
        ...body,
      });
      if (!parsed.success)
        return error(context, "invalid-request", "来源更新审核请求无效", 400);
      try {
        const run = await application.workflow.inspectSourceRefreshRun(
          context.req.param("runId"),
        );
        if (run === undefined)
          return error(context, "not-found", "没有找到来源刷新记录", 404);
        const changeSet = run.changeSets.find(
          ({ id }) => id === parsed.output.changeSetId,
        );
        if (changeSet === undefined)
          return error(context, "conflict", "没有找到来源更新变更集", 409);
        if (changeSet.disposition !== "pending")
          return error(context, "conflict", "这组来源更新已经处理", 409);
      } catch {
        return error(context, "unavailable", "暂时无法检查来源更新", 503);
      }
      try {
        const run = await application.workflow.reviewSourceRefreshChangeSet({
          runId: context.req.param("runId"),
          changeSetId: parsed.output.changeSetId,
          disposition: parsed.output.disposition,
        });
        const result = safeParse(sourceRefreshRunSchema, run);
        if (!result.success) throw new Error("来源更新审核结果无效");
        return context.json(result.output);
      } catch {
        return error(context, "unavailable", "暂时无法处理来源更新", 503);
      }
    },
  );

  return api;
}

function previewResponse(
  context: Context,
  preview: ChangeImpactPreviewInspection,
) {
  const result = safeParse(changeImpactPreviewSchema, {
    previewId: preview.id,
    executionId: preview.executionId,
    assetId: preview.assetId,
    status: preview.status,
    current: previewProjection(preview.current),
    projected: previewProjection(preview.projected),
    evidenceConflicts: preview.evidenceComparison.conflicts,
    blockingConditions: preview.blockingConditions,
    ...(preview.primaryCoverArtifactId === undefined
      ? {}
      : { primaryCoverArtifactId: preview.primaryCoverArtifactId }),
  });
  if (!result.success)
    return error(context, "unavailable", "变更影响预演结果无效", 503);
  return context.json(result.output);
}

function previewProjection(
  projection: ChangeImpactPreviewInspection["current"],
) {
  return {
    ...(projection.recognitionState === undefined
      ? {}
      : { recognitionState: projection.recognitionState }),
    ...(projection.recognitionDecisionId === undefined
      ? {}
      : { recognitionDecisionId: projection.recognitionDecisionId }),
    sourceAssociations: projection.sourceAssociations,
    ...(projection.recognitionSourceAssociation === undefined
      ? {}
      : {
          recognitionSourceAssociation: projection.recognitionSourceAssociation,
        }),
  };
}

function observedMaterialAssociationResponse(
  context: Context,
  inspection: ObservedMaterialAssociationInspection,
) {
  const parsed = safeParse(
    observedMaterialAssociationInspectionSchema,
    inspection,
  );
  if (!parsed.success)
    return error(context, "unavailable", "观察材料关联结果无效", 503);
  return context.json(parsed.output);
}

function publicAssociation(association: {
  readonly id: string;
  readonly subjectId: string;
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
}) {
  return {
    id: association.id,
    subjectId: association.subjectId,
    sourceIdentity: association.sourceIdentity,
    nativeAddress: association.nativeAddress,
  };
}

function authorizationReference(
  authorization: NonNullable<
    Awaited<
      ReturnType<ProductApplication["workflow"]["inspectCorrectionSubject"]>
    >
  >["historical"][number]["authorizedBy"],
) {
  if (authorization === undefined) return undefined;
  return {
    kind: authorization.kind,
    id:
      "decisionId" in authorization
        ? authorization.decisionId
        : "supersessionId" in authorization
          ? authorization.supersessionId
          : "retractionId" in authorization
            ? authorization.retractionId
            : undefined,
  };
}

function coverTitle(address: string): string {
  const name = (address.split(/[\\/]/u).at(-1) ?? "").trim();
  return /^[0-9a-f]{32,}(?:\.(?:jpe?g|png|webp|avif|gif))?$/iu.test(name) ||
    name.length === 0
    ? "封面候选"
    : name;
}

function error(
  context: Context,
  code: "invalid-request" | "conflict" | "not-found" | "unavailable",
  message: string,
  status: 400 | 404 | 409 | 503,
) {
  const parsed = safeParse(publicApiErrorResponseSchema, {
    error: { code, message },
  });
  if (!parsed.success)
    return context.json(
      { error: { code: "unavailable", message: "服务暂时不可用" } },
      503,
    );
  return context.json(parsed.output, status);
}

function recognitionRepairPreparationFailure(
  context: Context,
  failure: RecognitionRepairPreparationError,
  operation: "撤回" | "范围调整",
) {
  switch (failure.kind) {
    case "invalid-request":
      return error(
        context,
        "invalid-request",
        operation === "撤回" ? "身份撤回请求无效" : "识别范围调整请求无效",
        400,
      );
    case "not-found":
      return error(
        context,
        "not-found",
        operation === "撤回"
          ? "没有找到可撤回的识别记录"
          : "没有找到形成范围决定的识别记录",
        404,
      );
    case "conflict":
      return error(
        context,
        "conflict",
        operation === "撤回"
          ? "识别依据已变化，请重新检查"
          : "识别范围依据已变化，请重新检查",
        409,
      );
  }
}
