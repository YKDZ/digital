import { publicRefreshExecutionIdSchema } from "./execution-contract.ts";
import type {
  PublicApiJsonRequest,
  PublicApiJsonRequestOptions,
  PublicApiRequestValidation,
} from "./source-connection-client.ts";
import {
  localContentExecutionRequestSchema,
  localContentReviewSchema,
  localIntakeRequestSchema,
  localIntakeSnapshotSchema,
  directedRecognitionRequestSchema,
  prepareLocalContentRequestSchema,
  retryableSourceEnrichmentListSchema,
  sourceAssociationCandidateSelectionSchema,
  sourceAssociationDecisionInspectionSchema,
  sourceAssociationDecisionRequestSchema,
  sourceAssociationDecisionStartSchema,
  sourceEnrichmentInspectionSchema,
  sourceEnrichmentRequestSchema,
  sourceEnrichmentRetryRequestSchema,
  sourceInputRequirementsSchema,
  type PrepareLocalContentRequest,
  type PublicLocalContentReview,
  type PublicLocalIntakeRequest,
  type PublicLocalIntakeSnapshot,
  type PublicSourceInputRequirement,
  type DirectedRecognitionRequest,
  type SourceAssociationDecisionInspection,
  type SourceAssociationDecisionRequest,
  type SourceEnrichmentInspection,
  type SourceEnrichmentRequest,
  type SourceEnrichmentRetryRequest,
} from "./source-recognition-contract.ts";

export type PublicSourceRecognitionClientMethods = {
  listSourceInputRequirements(): Promise<
    readonly PublicSourceInputRequirement[]
  >;
  startDirectedRecognition(
    input: DirectedRecognitionRequest,
  ): Promise<{ readonly id: string }>;
  inspectLocalIntake(
    input: PublicLocalIntakeRequest,
  ): Promise<PublicLocalIntakeSnapshot>;
  prepareLocalContent(
    input: PrepareLocalContentRequest,
  ): Promise<PublicLocalContentReview>;
  inspectLocalContent(executionId: string): Promise<PublicLocalContentReview>;
  confirmLocalContent(executionId: string): Promise<PublicLocalContentReview>;
  listRetryableSourceEnrichments(subjectId: string): Promise<
    readonly {
      readonly executionId: string;
      readonly subjectId: string;
      readonly sourceIdentity: string;
      readonly canRetry: boolean;
    }[]
  >;
  startSourceEnrichment(
    input: SourceEnrichmentRequest,
  ): Promise<{ readonly id: string }>;
  inspectSourceEnrichment(
    executionId: string,
  ): Promise<SourceEnrichmentInspection>;
  retrySourceEnrichment(
    input: SourceEnrichmentRetryRequest,
  ): Promise<{ readonly id: string }>;
  startSourceAssociationDecision(
    input: SourceAssociationDecisionRequest,
  ): Promise<{ readonly executionId: string }>;
  inspectSourceAssociationDecision(
    executionId: string,
  ): Promise<SourceAssociationDecisionInspection>;
  selectSourceAssociationCandidate(
    executionId: string,
    candidateReference: string,
  ): Promise<SourceAssociationDecisionInspection>;
  retrySourceAssociationDecision(
    executionId: string,
  ): Promise<SourceAssociationDecisionInspection>;
};

/** 把来源识别能力接到唯一公共 API 客户端。 */
export function sourceRecognitionClientMethods(input: {
  readonly apiBaseUrl: URL;
  readonly requestJson: PublicApiJsonRequest;
  readonly validateRequest: PublicApiRequestValidation;
  readonly jsonRequest: PublicApiJsonRequestOptions;
}): PublicSourceRecognitionClientMethods {
  return {
    async startDirectedRecognition(inputValue) {
      const request = input.validateRequest(
        directedRecognitionRequestSchema,
        inputValue,
        "指定来源识别请求无效",
      );
      return await input.requestJson(
        new URL("directed-recognitions", input.apiBaseUrl),
        input.jsonRequest("POST", request),
        publicRefreshExecutionIdSchema,
      );
    },
    async listSourceInputRequirements() {
      const result = await input.requestJson(
        new URL("source-input-requirements", input.apiBaseUrl),
        { headers: { accept: "application/json" } },
        sourceInputRequirementsSchema,
      );
      return result;
    },
    async inspectLocalIntake(inputValue) {
      const request = input.validateRequest(
        localIntakeRequestSchema,
        inputValue,
        "本地材料检查范围无效",
      );
      const url = new URL(
        `asset-libraries/${encodeURIComponent(request.assetLibraryId)}/local-intake`,
        input.apiBaseUrl,
      );
      if (request.directoryId !== undefined)
        url.searchParams.set("directoryId", request.directoryId);
      if (request.parentExecutionId !== undefined)
        url.searchParams.set("parentExecutionId", request.parentExecutionId);
      return await input.requestJson(
        url,
        { headers: { accept: "application/json" } },
        localIntakeSnapshotSchema,
      );
    },
    async prepareLocalContent(inputValue) {
      const request = input.validateRequest(
        prepareLocalContentRequestSchema,
        inputValue,
        "请选择本次检查中要整理的文件",
      );
      return await input.requestJson(
        new URL("local-content-reviews", input.apiBaseUrl),
        input.jsonRequest("POST", { action: "prepare", ...request }),
        localContentReviewSchema,
      );
    },
    async inspectLocalContent(executionId) {
      const request = input.validateRequest(
        localContentExecutionRequestSchema,
        { executionId },
        "本地内容检查编号无效",
      );
      return await input.requestJson(
        new URL(
          `local-content-reviews/${encodeURIComponent(request.executionId)}`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        localContentReviewSchema,
      );
    },
    async confirmLocalContent(executionId) {
      const request = input.validateRequest(
        localContentExecutionRequestSchema,
        { executionId },
        "本地内容检查编号无效",
      );
      return await input.requestJson(
        new URL(
          `local-content-reviews/${encodeURIComponent(request.executionId)}/confirm`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", {}),
        localContentReviewSchema,
      );
    },
    async listRetryableSourceEnrichments(subjectId) {
      const request = input.validateRequest(
        localContentExecutionRequestSchema,
        { executionId: subjectId },
        "资产编号无效",
      );
      return await input.requestJson(
        new URL(
          `assets/${encodeURIComponent(request.executionId)}/source-enrichment-retries`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        retryableSourceEnrichmentListSchema,
      );
    },
    async startSourceEnrichment(inputValue) {
      const request = input.validateRequest(
        sourceEnrichmentRequestSchema,
        inputValue,
        "来源补充请求无效",
      );
      return await input
        .requestJson(
          new URL("source-enrichments", input.apiBaseUrl),
          input.jsonRequest("POST", request),
          sourceAssociationDecisionStartSchema,
        )
        .then(({ executionId }) => ({ id: executionId }));
    },
    async inspectSourceEnrichment(executionId) {
      const request = input.validateRequest(
        localContentExecutionRequestSchema,
        { executionId },
        "来源补充编号无效",
      );
      return await input.requestJson(
        new URL(
          `source-enrichments/${encodeURIComponent(request.executionId)}`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        sourceEnrichmentInspectionSchema,
      );
    },
    async retrySourceEnrichment(inputValue) {
      const request = input.validateRequest(
        sourceEnrichmentRetryRequestSchema,
        inputValue,
        "来源补充重试请求无效",
      );
      return await input
        .requestJson(
          new URL("source-enrichment-retries", input.apiBaseUrl),
          input.jsonRequest("POST", request),
          sourceAssociationDecisionStartSchema,
        )
        .then(({ executionId }) => ({ id: executionId }));
    },
    async startSourceAssociationDecision(inputValue) {
      const request = input.validateRequest(
        sourceAssociationDecisionRequestSchema,
        inputValue,
        "来源关联决定请求无效",
      );
      return await input.requestJson(
        new URL("source-association-decisions", input.apiBaseUrl),
        input.jsonRequest("POST", request),
        sourceAssociationDecisionStartSchema,
      );
    },
    async inspectSourceAssociationDecision(executionId) {
      const request = input.validateRequest(
        localContentExecutionRequestSchema,
        { executionId },
        "来源关联决定编号无效",
      );
      return await input.requestJson(
        new URL(
          `source-association-decisions/${encodeURIComponent(request.executionId)}`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        sourceAssociationDecisionInspectionSchema,
      );
    },
    async selectSourceAssociationCandidate(executionId, candidateReference) {
      const request = input.validateRequest(
        sourceAssociationCandidateSelectionSchema,
        { candidateReference },
        "来源候选引用无效",
      );
      return await input.requestJson(
        new URL(
          `source-association-decisions/${encodeURIComponent(executionId)}/select`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", request),
        sourceAssociationDecisionInspectionSchema,
      );
    },
    async retrySourceAssociationDecision(executionId) {
      const request = input.validateRequest(
        localContentExecutionRequestSchema,
        { executionId },
        "来源关联决定编号无效",
      );
      return await input.requestJson(
        new URL(
          `source-association-decisions/${encodeURIComponent(request.executionId)}/retry`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", {}),
        sourceAssociationDecisionInspectionSchema,
      );
    },
  };
}
