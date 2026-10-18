import type { BaseIssue, BaseSchema, InferOutput } from "valibot";

import {
  metadataDecisionPreviewSchema,
  prepareMetadataDecisionRequestSchema,
  type PublicMetadataDecisionClientMethods,
} from "./metadata-decision-contract.ts";
import type {
  PublicApiJsonRequest,
  PublicApiJsonRequestOptions,
  PublicApiRequestValidation,
} from "./source-connection-client.ts";

type PublicApiSchema = BaseSchema<unknown, unknown, BaseIssue<unknown>>;

/** 把修订预演接入唯一公共客户端，并保留准备与确认的调用边界。 */
export function metadataDecisionClientMethods(input: {
  readonly apiBaseUrl: URL;
  readonly requestJson: PublicApiJsonRequest;
  readonly validateRequest: PublicApiRequestValidation;
  readonly jsonRequest: PublicApiJsonRequestOptions;
}): PublicMetadataDecisionClientMethods {
  return {
    async prepareMetadataDecision(assetId, request) {
      ensureCoordinate(assetId);
      const body = input.validateRequest(
        prepareMetadataDecisionRequestSchema,
        request,
        "人工属性修订条件无效",
      );
      return await input.requestJson(
        new URL(
          `assets/${encodeURIComponent(assetId)}/metadata-decisions/previews`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", body),
        metadataDecisionPreviewSchema,
      );
    },
    async confirmMetadataDecision(previewId) {
      ensureCoordinate(previewId);
      return await input.requestJson(
        decisionPreviewUrl(previewId, input.apiBaseUrl, "confirm"),
        input.jsonRequest("POST", {}),
        metadataDecisionPreviewSchema,
      );
    },
    async cancelMetadataDecision(previewId) {
      ensureCoordinate(previewId);
      return await input.requestJson(
        decisionPreviewUrl(previewId, input.apiBaseUrl, "cancel"),
        input.jsonRequest("POST", {}),
        metadataDecisionPreviewSchema,
      );
    },
  };
}

function decisionPreviewUrl(
  previewId: string,
  apiBaseUrl: URL,
  action: "confirm" | "cancel",
): URL {
  return new URL(
    `metadata-decision-previews/${encodeURIComponent(previewId)}/${action}`,
    apiBaseUrl,
  );
}

function ensureCoordinate(value: string): void {
  if (value.trim().length === 0) throw new Error("修订编号无效");
}

export type MetadataDecisionClientSchema = PublicApiSchema;
export type MetadataDecisionClientOutput<Schema extends PublicApiSchema> =
  InferOutput<Schema>;
