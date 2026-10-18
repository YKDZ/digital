import type { SourceAssociationDecisionInspection } from "@digital/application";
import { LocalContentReviewError } from "@digital/application";
import type { ProductApplication } from "@digital/product-application";
import { productGeneralAutomationInformationRequirement } from "@digital/product-application";
import {
  localContentExecutionRequestSchema,
  localContentReviewSchema,
  localIntakeRequestSchema,
  localIntakeSnapshotSchema,
  directedRecognitionRequestSchema,
  prepareLocalContentRequestSchema,
  publicApiErrorResponseSchema,
  publicRefreshExecutionIdSchema,
  retryableSourceEnrichmentListSchema,
  sourceAssociationCandidateSelectionSchema,
  sourceAssociationDecisionInspectionSchema,
  sourceAssociationDecisionRequestSchema,
  sourceAssociationDecisionStartSchema,
  sourceEnrichmentInspectionSchema,
  sourceEnrichmentRequestSchema,
  sourceEnrichmentRetryRequestSchema,
  sourceInputRequirementsSchema,
} from "@digital/public-api";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

import { publicAsset } from "./public-asset.ts";

/** 公开来源自身声明的寻址字段，核心只转交来源身份和输入要求。 */
export function createSourceRecognitionHttpApi(
  application: ProductApplication,
): Hono {
  const api = new Hono();
  api.post("/directed-recognitions", async (context) => {
    const parsed = safeParse(
      directedRecognitionRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return error(context, "invalid-request", "指定来源识别请求无效", 400);
    if (
      parsed.output.registrationId.trim().length === 0 ||
      parsed.output.relativeScope.trim().length === 0 ||
      parsed.output.sourceIdentity.trim().length === 0
    )
      return error(context, "invalid-request", "指定来源识别请求无效", 400);
    try {
      if (
        !application.workflow.acceptsSourceInput(
          parsed.output.sourceIdentity,
          parsed.output.sourceInput,
        )
      )
        return error(context, "invalid-request", "来源输入不符合要求", 400);
    } catch {
      return error(context, "unavailable", "暂时无法验证来源输入", 503);
    }
    try {
      const started = await application.execution.invoke(async (control) => {
        await application.workflow.directedRecognitionSourceInputObservedScope({
          ...parsed.output,
          informationRequirement:
            productGeneralAutomationInformationRequirement,
          onExecutionStarted(execution) {
            control.executionStarted(execution.id);
          },
          onHostCheckpoint() {
            control.safeCheckpoint();
          },
        });
      });
      const result = safeParse(publicRefreshExecutionIdSchema, started);
      if (!result.success) throw new Error("识别执行编号无效");
      return context.json(result.output, 202);
    } catch {
      return error(context, "unavailable", "暂时无法发起指定来源识别", 503);
    }
  });

  api.get("/source-input-requirements", (context) => {
    try {
      const parsed = safeParse(
        sourceInputRequirementsSchema,
        application.workflow.sourceInputRequirements(),
      );
      if (!parsed.success) throw new Error("来源输入要求无效");
      return context.json(parsed.output);
    } catch {
      return context.json(
        {
          error: {
            code: "unavailable",
            message: "暂时无法读取来源输入要求",
          },
        },
        503,
      );
    }
  });

  api.get("/assets/:assetId/source-enrichment-retries", async (context) => {
    const assetId = context.req.param("assetId");
    if (assetId.trim().length === 0)
      return error(context, "invalid-request", "资产编号无效", 400);
    try {
      const results =
        await application.workflow.inspectRetryableSourceEnrichments(assetId);
      const parsed = safeParse(retryableSourceEnrichmentListSchema, results);
      if (!parsed.success) throw new Error("来源补充重试候选无效");
      return context.json(parsed.output);
    } catch {
      return error(context, "unavailable", "暂时无法读取来源补充重试候选", 503);
    }
  });

  api.post("/source-enrichments", async (context) => {
    const parsed = safeParse(
      sourceEnrichmentRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return error(context, "invalid-request", "来源补充请求无效", 400);
    if (
      parsed.output.subjectId.trim().length === 0 ||
      parsed.output.sourceIdentity.trim().length === 0
    )
      return error(context, "invalid-request", "来源补充请求无效", 400);
    try {
      if (
        (await application.workflow.inspectAssetEvidence(
          parsed.output.subjectId,
        )) === undefined
      )
        return error(context, "not-found", "没有找到要补充的内容", 404);
      if (
        parsed.output.assetLibraryId !== undefined &&
        (await application.workflow.assetLibraries.get(
          parsed.output.assetLibraryId,
        )) === undefined
      )
        return error(context, "not-found", "资产库不存在或已移除", 404);
      if (
        !application.workflow.acceptsSourceInput(
          parsed.output.sourceIdentity,
          parsed.output.sourceInput,
        )
      )
        return error(context, "invalid-request", "来源输入不符合要求", 400);
    } catch {
      return error(context, "unavailable", "暂时无法检查来源补充条件", 503);
    }
    try {
      const started = await application.execution.invoke(async (control) => {
        await application.workflow.enrichSource({
          ...parsed.output,
          informationRequirement:
            productGeneralAutomationInformationRequirement,
          onExecutionStarted(execution) {
            control.executionStarted(execution.id);
          },
          onHostCheckpoint() {
            control.safeCheckpoint();
          },
        });
      });
      return context.json({ executionId: started.id }, 202);
    } catch {
      return error(context, "unavailable", "暂时无法发起来源补充", 503);
    }
  });

  api.get("/source-enrichments/:executionId", async (context) => {
    const executionId = context.req.param("executionId");
    try {
      const inspection = await application.workflow.inspect(executionId);
      if (
        inspection === undefined ||
        inspection.sourceEnrichments === undefined
      )
        return error(context, "not-found", "没有找到来源补充记录", 404);
      const parsed = safeParse(sourceEnrichmentInspectionSchema, {
        executionId,
        status: inspection.execution.status,
        ...(inspection.execution.outcome === undefined
          ? {}
          : { outcome: inspection.execution.outcome }),
        ...(inspection.execution.reason === undefined
          ? {}
          : { reason: inspection.execution.reason }),
        items: inspection.sourceEnrichments,
        sourceAssociations: inspection.accepted?.sourceAssociations ?? [],
      });
      if (!parsed.success) throw new Error("来源补充检查结果无效");
      return context.json(parsed.output);
    } catch {
      return error(context, "unavailable", "暂时无法读取来源补充结果", 503);
    }
  });

  api.post("/source-enrichment-retries", async (context) => {
    const parsed = safeParse(
      sourceEnrichmentRetryRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return error(context, "invalid-request", "来源补充重试请求无效", 400);
    if (
      parsed.output.executionId.trim().length === 0 ||
      parsed.output.subjectId.trim().length === 0 ||
      parsed.output.sourceIdentity.trim().length === 0
    )
      return error(context, "invalid-request", "来源补充重试请求无效", 400);
    try {
      const previous = await application.workflow.inspect(
        parsed.output.executionId,
      );
      if (previous?.sourceEnrichments === undefined)
        return error(context, "not-found", "没有找到来源补充记录", 404);
      if (previous.execution.status === "running")
        return error(context, "conflict", "正在进行的来源补充不能重试", 409);
      if (
        !previous.sourceEnrichments.some(
          (item) =>
            item.subjectId === parsed.output.subjectId &&
            item.sourceIdentity === parsed.output.sourceIdentity &&
            item.status === "failed" &&
            item.canRetry,
        )
      )
        return error(context, "conflict", "当前没有可重试的来源补充项", 409);
    } catch {
      return error(context, "unavailable", "暂时无法检查来源补充重试条件", 503);
    }
    try {
      const started = await application.execution.invoke(async (control) => {
        await application.workflow.retrySourceEnrichment({
          ...parsed.output,
          onExecutionStarted(execution) {
            control.executionStarted(execution.id);
          },
          onHostCheckpoint() {
            control.safeCheckpoint();
          },
        });
      });
      return context.json({ executionId: started.id }, 202);
    } catch {
      return error(context, "unavailable", "暂时无法重试来源补充", 503);
    }
  });

  api.post("/source-association-decisions", async (context) => {
    const parsed = safeParse(
      sourceAssociationDecisionRequestSchema,
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return error(context, "invalid-request", "来源关联决定请求无效", 400);
    if (
      parsed.output.assetId.trim().length === 0 ||
      parsed.output.initiatedBy.trim().length === 0 ||
      (parsed.output.intent === "retract" &&
        parsed.output.reason.trim().length === 0)
    )
      return error(context, "invalid-request", "来源关联决定请求无效", 400);
    try {
      if (
        (await application.workflow.inspectAssetEvidence(
          parsed.output.assetId,
        )) === undefined
      )
        return error(context, "not-found", "没有找到要处理的内容", 404);
      if (parsed.output.intent === "establish") {
        if (
          !application.workflow.acceptsSourceInput(
            parsed.output.sourceIdentity,
            parsed.output.sourceInput,
          )
        )
          return error(context, "invalid-request", "来源输入不符合要求", 400);
      } else {
        const predecessorAssociationId = parsed.output.predecessorAssociationId;
        const history = await application.workflow.inspectCorrectionSubject(
          parsed.output.assetId,
        );
        const predecessor = history?.current.find(
          ({ id }) => id === predecessorAssociationId,
        );
        if (predecessor === undefined)
          return error(context, "conflict", "所选来源关联已不再生效", 409);
        if (
          parsed.output.intent === "replace" &&
          !application.workflow.acceptsSourceInput(
            predecessor.sourceIdentity,
            parsed.output.sourceInput,
          )
        )
          return error(context, "invalid-request", "来源输入不符合要求", 400);
      }
    } catch {
      return error(context, "unavailable", "暂时无法检查来源关联条件", 503);
    }
    try {
      const started = await application.execution.invoke(async (control) => {
        const common = {
          assetId: parsed.output.assetId,
          initiatedBy: parsed.output.initiatedBy,
          onExecutionStarted(execution: { readonly id: string }) {
            control.executionStarted(execution.id);
          },
          onHostCheckpoint() {
            control.safeCheckpoint();
          },
        };
        if (parsed.output.intent === "establish")
          await application.workflow.prepareConflictedEstablishment({
            ...common,
            sourceIdentity: parsed.output.sourceIdentity,
            sourceInput: parsed.output.sourceInput,
          });
        else if (parsed.output.intent === "replace")
          await application.workflow.prepareReplacement({
            ...common,
            predecessorAssociationId: parsed.output.predecessorAssociationId,
            sourceInput: parsed.output.sourceInput,
          });
        else
          await application.workflow.prepareRetraction({
            ...common,
            predecessorAssociationId: parsed.output.predecessorAssociationId,
            reason: parsed.output.reason,
          });
      });
      const result = safeParse(sourceAssociationDecisionStartSchema, {
        executionId: started.id,
      });
      if (!result.success) throw new Error("来源关联决定编号无效");
      return context.json(result.output, 202);
    } catch {
      return error(context, "unavailable", "暂时无法准备来源关联决定", 503);
    }
  });

  api.get("/source-association-decisions/:executionId", async (context) => {
    try {
      const inspection =
        await application.workflow.inspectSourceAssociationDecision(
          context.req.param("executionId"),
        );
      if (inspection === undefined)
        return error(context, "not-found", "没有找到来源关联决定", 404);
      return sourceAssociationDecisionResponse(context, inspection);
    } catch {
      return error(context, "unavailable", "暂时无法读取来源关联决定", 503);
    }
  });

  api.post(
    "/source-association-decisions/:executionId/select",
    async (context) => {
      const parsed = safeParse(
        sourceAssociationCandidateSelectionSchema,
        await context.req.json().catch(() => undefined),
      );
      if (!parsed.success)
        return error(context, "invalid-request", "来源候选选择无效", 400);
      const executionId = context.req.param("executionId");
      try {
        const current =
          await application.workflow.inspectSourceAssociationDecision(
            executionId,
          );
        if (current === undefined)
          return error(context, "not-found", "没有找到来源关联决定", 404);
        if (
          !current.availableActions.includes("select") ||
          !current.candidates.some(
            ({ reference }) => reference === parsed.output.candidateReference,
          )
        )
          return error(context, "conflict", "当前不能选择这项来源候选", 409);
      } catch {
        return error(context, "unavailable", "暂时无法检查来源候选", 503);
      }
      try {
        const inspection =
          await application.workflow.selectSourceAssociationCandidate({
            executionId,
            candidateReference: parsed.output.candidateReference,
          });
        return sourceAssociationDecisionResponse(context, inspection);
      } catch {
        return error(context, "unavailable", "暂时无法选择来源候选", 503);
      }
    },
  );

  api.post(
    "/source-association-decisions/:executionId/retry",
    async (context) => {
      const executionId = context.req.param("executionId");
      try {
        const current =
          await application.workflow.inspectSourceAssociationDecision(
            executionId,
          );
        if (current === undefined)
          return error(context, "not-found", "没有找到来源关联决定", 404);
        if (!current.availableActions.includes("retry"))
          return error(context, "conflict", "当前来源关联决定不能重试", 409);
      } catch {
        return error(
          context,
          "unavailable",
          "暂时无法检查来源关联重试条件",
          503,
        );
      }
      try {
        const started = await application.execution.invoke(async (control) => {
          await application.workflow.retrySourceAssociationDecision({
            executionId,
            onExecutionStarted(execution) {
              control.executionStarted(execution.id);
            },
            onHostCheckpoint() {
              control.safeCheckpoint();
            },
          });
        });
        const inspection =
          await application.workflow.inspectSourceAssociationDecision(
            started.id,
          );
        if (inspection === undefined)
          return error(context, "unavailable", "暂时无法读取重试结果", 503);
        return sourceAssociationDecisionResponse(context, inspection);
      } catch {
        return error(context, "unavailable", "暂时无法重新判断来源关联", 503);
      }
    },
  );

  api.get("/asset-libraries/:assetLibraryId/local-intake", async (context) => {
    const query = context.req.query();
    const request = safeParse(localIntakeRequestSchema, {
      assetLibraryId: context.req.param("assetLibraryId"),
      ...(query.directoryId === undefined
        ? {}
        : { directoryId: query.directoryId }),
      ...(query.parentExecutionId === undefined
        ? {}
        : { parentExecutionId: query.parentExecutionId }),
    });
    if (
      !request.success ||
      !Object.keys(query).every((key) =>
        ["directoryId", "parentExecutionId"].includes(key),
      )
    )
      return error(context, "invalid-request", "本地材料检查范围无效", 400);

    try {
      const library = await application.workflow.assetLibraries.get(
        request.output.assetLibraryId,
      );
      if (library === undefined)
        return error(context, "not-found", "资产库不存在或已移除", 404);
      const directories =
        await application.workflow.assetLibraries.directoryViews(library.id);
      const selected =
        request.output.directoryId === undefined
          ? undefined
          : directories.find(
              (directory) =>
                directory.directoryId === request.output.directoryId,
            );
      if (
        request.output.directoryId !== undefined &&
        (selected === undefined || selected.status !== "active")
      )
        return error(context, "not-found", "资产库目录不存在或已移除", 404);

      let files: readonly unknown[] = [];
      let contents: readonly unknown[] = [];
      let execution:
        | {
            readonly id: string;
            readonly status: "running" | "completed" | "failed";
            readonly outcome?: string;
            readonly reason?: string;
          }
        | undefined;
      if (request.output.parentExecutionId !== undefined) {
        if (selected === undefined)
          return error(context, "invalid-request", "请选择要检查的目录", 400);
        const scan = await application.workflow.inspectAssetLibraryScan(
          request.output.parentExecutionId,
        );
        if (scan === undefined || scan.assetLibraryId !== library.id)
          return error(context, "not-found", "没有找到该目录的扫描记录", 404);
        const directoryScan = scan.directories.find(
          (item) => item.directoryKey === selected.observedRootId,
        );
        if (
          directoryScan === undefined ||
          directoryScan.childExecutionId === undefined
        )
          return error(context, "conflict", "该目录尚未完成文件检查", 409);
        const intake = await application.workflow.inspectLocalIntake({
          registrationId: selected.observedRootId,
          executionId: directoryScan.childExecutionId,
        });
        files = intake.files;
        contents = await Promise.all(
          intake.contents.map(async (content) =>
            publicAsset(application, content),
          ),
        );
        const result = intake.execution?.execution;
        execution =
          result === undefined
            ? undefined
            : {
                id: result.id,
                status: result.status,
                ...(result.outcome === undefined
                  ? {}
                  : { outcome: result.outcome }),
                ...(result.reason === undefined
                  ? {}
                  : { reason: result.reason }),
              };
      }
      const response = safeParse(localIntakeSnapshotSchema, {
        assetLibraryId: library.id,
        directories: directories.map((directory) => ({
          id: directory.directoryId,
          displayName: directory.displayName,
          status: directory.status,
        })),
        ...(selected === undefined
          ? {}
          : { directoryId: selected.directoryId }),
        files,
        contents,
        ...(execution === undefined ? {} : { execution }),
      });
      if (!response.success) throw new Error("本地材料检查结果无效");
      return context.json(response.output);
    } catch {
      return error(context, "unavailable", "暂时无法读取本地材料检查", 503);
    }
  });

  api.post("/local-content-reviews", async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return error(context, "invalid-request", "本地内容整理请求无效", 400);
    const input = body as Record<string, unknown>;
    if (input.action !== "prepare")
      return error(context, "invalid-request", "本地内容整理请求无效", 400);
    const parsed = safeParse(prepareLocalContentRequestSchema, input);
    if (!parsed.success)
      return error(
        context,
        "invalid-request",
        "请选择本次检查中要整理的文件",
        400,
      );
    try {
      const observed = await application.workflow.inspect(
        parsed.output.executionId,
      );
      if (observed === undefined)
        return error(context, "not-found", "没有找到本次文件检查", 404);
      if (observed.execution.status === "running")
        return error(context, "conflict", "文件检查尚未完成", 409);
      const scope = observed.execution.resolvedSelection?.filesystemScopes[0];
      if (
        scope?.observedRoot === undefined ||
        scope.relativeScope === undefined
      )
        return error(context, "conflict", "文件位置已失效，请重新检查", 409);
      const intake = await application.workflow.inspectLocalIntake({
        registrationId: scope.observedRoot.id,
        executionId: parsed.output.executionId,
      });
      const availablePaths = new Set(
        intake.files
          .filter((file) => file.problem === undefined)
          .map((file) => file.relativePath),
      );
      if (
        parsed.output.relativePaths.length === 0 ||
        new Set(parsed.output.relativePaths).size !==
          parsed.output.relativePaths.length ||
        parsed.output.relativePaths.some((file) => !availablePaths.has(file))
      )
        return error(
          context,
          "invalid-request",
          "请选择本次检查中可用的完整文件",
          400,
        );
    } catch {
      return error(context, "unavailable", "暂时无法检查本地材料", 503);
    }
    try {
      const review = await application.workflow.prepareLocalContent(
        parsed.output,
      );
      return localContentReviewResponse(application, context, review);
    } catch (cause) {
      if (cause instanceof LocalContentReviewError)
        return localContentReviewFailure(context, cause);
      return error(context, "unavailable", "暂时无法准备本地内容", 503);
    }
  });

  api.get("/local-content-reviews/:executionId", async (context) => {
    const request = safeParse(localContentExecutionRequestSchema, {
      executionId: context.req.param("executionId"),
    });
    if (!request.success)
      return error(context, "invalid-request", "本地内容检查编号无效", 400);
    try {
      const prepared = await application.workflow.inspect(
        request.output.executionId,
      );
      if (
        prepared === undefined ||
        prepared.execution.outcome !== "proposal" ||
        prepared.execution.plannedAssetId === undefined
      )
        return error(context, "not-found", "没有找到待确认的本地内容", 404);
      const review = await application.workflow.inspectLocalContent(
        request.output.executionId,
      );
      return localContentReviewResponse(application, context, review);
    } catch {
      return error(context, "unavailable", "暂时无法读取本地内容", 503);
    }
  });

  api.post("/local-content-reviews/:executionId/confirm", async (context) => {
    const request = safeParse(localContentExecutionRequestSchema, {
      executionId: context.req.param("executionId"),
    });
    if (!request.success)
      return error(context, "invalid-request", "本地内容检查编号无效", 400);
    try {
      const prepared = await application.workflow.inspect(
        request.output.executionId,
      );
      if (
        prepared === undefined ||
        prepared.execution.outcome !== "proposal" ||
        prepared.execution.plannedAssetId === undefined
      )
        return error(context, "not-found", "没有找到待确认的本地内容", 404);
      const review = await application.workflow.confirmLocalContent(
        request.output,
      );
      return localContentReviewResponse(application, context, review);
    } catch (cause) {
      if (cause instanceof LocalContentReviewError)
        return localContentReviewFailure(context, cause);
      return error(context, "unavailable", "暂时无法确认本地内容", 503);
    }
  });
  return api;
}

function localContentReviewResponse(
  application: ProductApplication,
  context: Context,
  review: Awaited<
    ReturnType<ProductApplication["workflow"]["prepareLocalContent"]>
  >,
) {
  const parsed = safeParse(localContentReviewSchema, {
    executionId: review.executionId,
    status: review.status,
    relativePaths: review.relativePaths,
    content: publicAsset(application, review.content.facts),
  });
  if (!parsed.success)
    return error(context, "unavailable", "本地内容结果无法读取", 503);
  return context.json(parsed.output);
}

function localContentReviewFailure(
  context: Context,
  cause: LocalContentReviewError,
) {
  switch (cause.kind) {
    case "invalid-request":
      return error(
        context,
        "invalid-request",
        "请选择本次检查中可用的完整文件",
        400,
      );
    case "not-found":
      return error(context, "not-found", "没有找到待确认的本地内容", 404);
    case "conflict":
      return error(context, "conflict", "文件依据已变化，请重新检查", 409);
  }
}

function publicSourceAssociation(association: {
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

function sourceAssociationDecisionResponse(
  context: Context,
  inspection: SourceAssociationDecisionInspection,
) {
  const result = safeParse(sourceAssociationDecisionInspectionSchema, {
    executionId: inspection.executionId,
    status: inspection.status,
    state: inspection.state,
    assetId: inspection.assetId,
    intent: inspection.intent,
    ...(inspection.predecessor === undefined
      ? {}
      : { predecessor: publicSourceAssociation(inspection.predecessor) }),
    currentAssociations: inspection.currentAssociations.map(
      publicSourceAssociation,
    ),
    historicalAssociations: inspection.historicalAssociations.map((item) => ({
      association: publicSourceAssociation(item.association),
      status: item.status,
      ...(item.authorizedBy === undefined
        ? {}
        : {
            authorizedBy: {
              kind: item.authorizedBy.kind,
              id:
                "decisionId" in item.authorizedBy
                  ? item.authorizedBy.decisionId
                  : "supersessionId" in item.authorizedBy
                    ? item.authorizedBy.supersessionId
                    : item.authorizedBy.retractionId,
            },
          }),
    })),
    inputRequirements: inspection.inputRequirements,
    candidates: inspection.candidates,
    ...(inspection.failure === undefined
      ? {}
      : { failure: inspection.failure }),
    ...(inspection.preview === undefined
      ? {}
      : {
          preview: {
            previewId: inspection.preview.id,
            assetId: inspection.preview.assetId,
            status: inspection.preview.status,
            blockingConditions: inspection.preview.blockingConditions,
          },
        }),
    availableActions: inspection.availableActions,
  });
  if (!result.success)
    return error(context, "unavailable", "来源关联决定结果无法读取", 503);
  return context.json(result.output);
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
