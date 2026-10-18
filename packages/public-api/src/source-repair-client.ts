import {
  sourceRefreshRunSchema,
  type PublicSourceRefreshRun,
} from "./execution-contract.ts";
import type {
  PublicApiJsonRequest,
  PublicApiJsonRequestOptions,
  PublicApiRequestValidation,
} from "./source-connection-client.ts";
import {
  artifactRoleCoverInspectionSchema,
  artifactRoleDecisionRequestSchema,
  changeImpactConfirmationRequestSchema,
  changeImpactPreviewIdRequestSchema,
  changeImpactPreviewSchema,
  changeImpactRejectionRequestSchema,
  observedMaterialAssociationInspectionSchema,
  observedMaterialAssociationRequestSchema,
  observedMaterialAssociationStartSchema,
  observedMaterialConfirmationRequestSchema,
  recognitionRetractionRequestSchema,
  recognitionScopeAmendmentRequestSchema,
  sourceRefreshChangeSetReviewRequestSchema,
  sourceRefreshRunIdRequestSchema,
  sourceAssociationHistorySchema,
  type ArtifactRoleDecisionRequest,
  type ObservedMaterialAssociationRequest,
  type PublicArtifactRoleCoverInspection,
  type PublicChangeImpactPreview,
  type PublicObservedMaterialAssociationInspection,
  type PublicSourceAssociationHistory,
  type RecognitionRetractionRequest,
  type RecognitionScopeAmendmentRequest,
  type SourceRefreshChangeSetReviewRequest,
} from "./source-repair-contract.ts";

export type PublicSourceRepairClientMethods = {
  inspectSourceAssociationHistory(
    assetId: string,
  ): Promise<PublicSourceAssociationHistory>;
  prepareRecognitionRetraction(
    input: RecognitionRetractionRequest,
  ): Promise<PublicChangeImpactPreview>;
  prepareRecognitionScopeAmendment(
    input: RecognitionScopeAmendmentRequest,
  ): Promise<PublicChangeImpactPreview>;
  inspectChangeImpactPreview(
    previewId: string,
  ): Promise<PublicChangeImpactPreview>;
  confirmChangeImpactPreview(
    previewId: string,
    confirmedBy: string,
  ): Promise<PublicChangeImpactPreview>;
  rejectChangeImpactPreview(
    previewId: string,
    rejectedBy: string,
  ): Promise<PublicChangeImpactPreview>;
  inspectArtifactRoleCovers(
    entityId: string,
  ): Promise<PublicArtifactRoleCoverInspection>;
  prepareArtifactRoleDecision(
    entityId: string,
    input: ArtifactRoleDecisionRequest,
  ): Promise<PublicChangeImpactPreview>;
  prepareObservedMaterialAssociation(
    input: ObservedMaterialAssociationRequest,
  ): Promise<{ readonly executionId: string }>;
  inspectObservedMaterialAssociation(
    executionId: string,
  ): Promise<PublicObservedMaterialAssociationInspection>;
  confirmObservedMaterialAssociation(
    executionId: string,
    confirmedBy: string,
  ): Promise<PublicObservedMaterialAssociationInspection>;
  inspectSourceRefreshRun(runId: string): Promise<PublicSourceRefreshRun>;
  reviewSourceRefreshChangeSet(
    runId: string,
    input: SourceRefreshChangeSetReviewRequest,
  ): Promise<PublicSourceRefreshRun>;
};

export function sourceRepairClientMethods(input: {
  readonly apiBaseUrl: URL;
  readonly requestJson: PublicApiJsonRequest;
  readonly validateRequest: PublicApiRequestValidation;
  readonly jsonRequest: PublicApiJsonRequestOptions;
}): PublicSourceRepairClientMethods {
  return {
    async inspectSourceAssociationHistory(assetId) {
      const id = input.validateRequest(
        changeImpactPreviewIdRequestSchema,
        { previewId: assetId },
        "资产编号无效",
      ).previewId;
      return await input.requestJson(
        new URL(
          `assets/${encodeURIComponent(id)}/source-association-history`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        sourceAssociationHistorySchema,
      );
    },
    async prepareRecognitionRetraction(inputValue) {
      const request = input.validateRequest(
        recognitionRetractionRequestSchema,
        inputValue,
        "身份撤回请求无效",
      );
      return await input.requestJson(
        new URL("recognition-retractions", input.apiBaseUrl),
        input.jsonRequest("POST", request),
        changeImpactPreviewSchema,
      );
    },
    async prepareRecognitionScopeAmendment(inputValue) {
      const request = input.validateRequest(
        recognitionScopeAmendmentRequestSchema,
        inputValue,
        "识别范围调整请求无效",
      );
      return await input.requestJson(
        new URL("recognition-scope-amendments", input.apiBaseUrl),
        input.jsonRequest("POST", request),
        changeImpactPreviewSchema,
      );
    },
    async inspectChangeImpactPreview(previewId) {
      const request = input.validateRequest(
        changeImpactPreviewIdRequestSchema,
        { previewId },
        "变更预演编号无效",
      );
      return await input.requestJson(
        new URL(
          `change-impact-previews/${encodeURIComponent(request.previewId)}`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        changeImpactPreviewSchema,
      );
    },
    async confirmChangeImpactPreview(previewId, confirmedBy) {
      const id = input.validateRequest(
        changeImpactPreviewIdRequestSchema,
        { previewId },
        "变更预演编号无效",
      ).previewId;
      const body = input.validateRequest(
        changeImpactConfirmationRequestSchema,
        { confirmedBy },
        "变更确认者无效",
      );
      return await input.requestJson(
        new URL(
          `change-impact-previews/${encodeURIComponent(id)}/confirm`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", body),
        changeImpactPreviewSchema,
      );
    },
    async rejectChangeImpactPreview(previewId, rejectedBy) {
      const id = input.validateRequest(
        changeImpactPreviewIdRequestSchema,
        { previewId },
        "变更预演编号无效",
      ).previewId;
      const body = input.validateRequest(
        changeImpactRejectionRequestSchema,
        { rejectedBy },
        "变更拒绝者无效",
      );
      return await input.requestJson(
        new URL(
          `change-impact-previews/${encodeURIComponent(id)}/reject`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", body),
        changeImpactPreviewSchema,
      );
    },
    async inspectArtifactRoleCovers(entityId) {
      const id = input.validateRequest(
        changeImpactPreviewIdRequestSchema,
        { previewId: entityId },
        "实体编号无效",
      ).previewId;
      return await input.requestJson(
        new URL(
          `assets/${encodeURIComponent(id)}/artifact-role-covers`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        artifactRoleCoverInspectionSchema,
      );
    },
    async prepareArtifactRoleDecision(entityId, inputValue) {
      const id = input.validateRequest(
        changeImpactPreviewIdRequestSchema,
        { previewId: entityId },
        "实体编号无效",
      ).previewId;
      const body = input.validateRequest(
        artifactRoleDecisionRequestSchema,
        inputValue,
        "封面决定请求无效",
      );
      return await input.requestJson(
        new URL(
          `assets/${encodeURIComponent(id)}/artifact-role-decisions`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", body),
        changeImpactPreviewSchema,
      );
    },
    async prepareObservedMaterialAssociation(inputValue) {
      const request = input.validateRequest(
        observedMaterialAssociationRequestSchema,
        inputValue,
        "观察材料关联请求无效",
      );
      return await input.requestJson(
        new URL("observed-material-associations", input.apiBaseUrl),
        input.jsonRequest("POST", request),
        observedMaterialAssociationStartSchema,
      );
    },
    async inspectObservedMaterialAssociation(executionId) {
      const request = input.validateRequest(
        sourceRefreshRunIdRequestSchema,
        { runId: executionId },
        "材料关联执行编号无效",
      );
      return await input.requestJson(
        new URL(
          `observed-material-associations/${encodeURIComponent(request.runId)}`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        observedMaterialAssociationInspectionSchema,
      );
    },
    async confirmObservedMaterialAssociation(executionId, confirmedBy) {
      const id = input.validateRequest(
        sourceRefreshRunIdRequestSchema,
        { runId: executionId },
        "材料关联执行编号无效",
      ).runId;
      const body = input.validateRequest(
        observedMaterialConfirmationRequestSchema,
        { confirmedBy },
        "材料关联确认者无效",
      );
      return await input.requestJson(
        new URL(
          `observed-material-associations/${encodeURIComponent(id)}/confirm`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", body),
        observedMaterialAssociationInspectionSchema,
      );
    },
    async inspectSourceRefreshRun(runId) {
      const request = input.validateRequest(
        sourceRefreshRunIdRequestSchema,
        { runId },
        "来源刷新编号无效",
      );
      return await input.requestJson(
        new URL(
          `source-refresh-runs/${encodeURIComponent(request.runId)}`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        sourceRefreshRunSchema,
      );
    },
    async reviewSourceRefreshChangeSet(runId, inputValue) {
      const id = input.validateRequest(
        sourceRefreshRunIdRequestSchema,
        { runId },
        "来源刷新编号无效",
      ).runId;
      const body = input.validateRequest(
        sourceRefreshChangeSetReviewRequestSchema,
        inputValue,
        "来源更新审核请求无效",
      );
      return await input.requestJson(
        new URL(
          `source-refresh-runs/${encodeURIComponent(id)}/change-sets/${encodeURIComponent(body.changeSetId)}/review`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", { disposition: body.disposition }),
        sourceRefreshRunSchema,
      );
    },
  };
}
