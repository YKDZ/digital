import type { BaseIssue, BaseSchema, InferOutput } from "valibot";

import {
  bangumiAuthorizationAttemptRequestSchema,
  bangumiAuthorizationStartSchema,
  bangumiOAuthClientConfigurationRequestSchema,
  bangumiOAuthClientConfigurationSchema,
  createFanboxConnectionRequestRequestSchema,
  createFanboxConnectionRequestResponseSchema,
  fanboxConnectionRequestCompletionRequestSchema,
  fanboxConnectionRequestIdRequestSchema,
  fanboxConnectionRequestPairingRequestSchema,
  fanboxSourceConnectionRevocationRequestSchema,
  publicFanboxConnectionRequestSchema,
  publicBangumiAuthorizationAttemptSchema,
  publicSourceConnectionListSchema,
  sourceConnectionIdRequestSchema,
  sourceConnectionMutationRequestSchema,
  sourceConnectionRevocationRequestSchema,
  sourceConnectionRevokedSchema,
  sourceConnectionStateResponseSchema,
  sourceConnectionVerificationSchema,
  type BangumiAuthorizationStart,
  type PublicBangumiAuthorizationAttempt,
  type PublicSourceConnectionClientMethods,
} from "./source-connection-contract.ts";

type PublicApiSchema = BaseSchema<unknown, unknown, BaseIssue<unknown>>;

export type PublicApiJsonRequest = <Schema extends PublicApiSchema>(
  url: URL,
  init: RequestInit,
  schema: Schema,
) => Promise<InferOutput<Schema>>;

export type PublicApiRequestValidation = <Schema extends PublicApiSchema>(
  schema: Schema,
  input: unknown,
  message?: string,
) => InferOutput<Schema>;

export type PublicApiJsonRequestOptions = (
  method: "POST" | "PUT" | "DELETE",
  body: unknown,
) => RequestInit;

/** 只为正式公共客户端补入来源连接方法，不创建第二个客户端入口。 */
export function sourceConnectionClientMethods(input: {
  readonly apiBaseUrl: URL;
  readonly requestJson: PublicApiJsonRequest;
  readonly validateRequest: PublicApiRequestValidation;
  readonly jsonRequest: PublicApiJsonRequestOptions;
}): PublicSourceConnectionClientMethods {
  const collectionUrl = new URL("source-connections", input.apiBaseUrl);
  const fanboxRequestUrl = new URL(
    "fanbox-connection-requests",
    input.apiBaseUrl,
  );
  const bangumiAuthorizationUrl = new URL(
    "source-connections/bangumi/authorize",
    input.apiBaseUrl,
  );
  return {
    async listSourceConnections() {
      return await input.requestJson(
        collectionUrl,
        { headers: { accept: "application/json" } },
        publicSourceConnectionListSchema,
      );
    },
    async getSourceConnection(id) {
      const request = input.validateRequest(
        sourceConnectionIdRequestSchema,
        { sourceId: id },
        "来源连接编号无效",
      );
      return await input.requestJson(
        sourceConnectionUrl(request.sourceId, input.apiBaseUrl),
        { headers: { accept: "application/json" } },
        sourceConnectionStateResponseSchema,
      );
    },
    async configureSourceConnection(inputValue) {
      const { sourceId, ...requestInput } = inputValue;
      const request = input.validateRequest(
        sourceConnectionMutationRequestSchema,
        requestInput,
        "来源连接配置无效",
      );
      return await input.requestJson(
        sourceConnectionUrl(sourceId, input.apiBaseUrl),
        input.jsonRequest("POST", request),
        sourceConnectionVerificationSchema,
      );
    },
    async replaceSourceConnection(inputValue) {
      const { sourceId, ...requestInput } = inputValue;
      const request = input.validateRequest(
        sourceConnectionMutationRequestSchema,
        requestInput,
        "来源连接配置无效",
      );
      return await input.requestJson(
        sourceConnectionUrl(sourceId, input.apiBaseUrl),
        input.jsonRequest("PUT", request),
        sourceConnectionVerificationSchema,
      );
    },
    async revokeSourceConnection(inputValue) {
      const { sourceId, ...requestInput } = inputValue;
      const request = input.validateRequest(
        sourceConnectionRevocationRequestSchema,
        requestInput,
        "来源连接配置无效",
      );
      return await input.requestJson(
        sourceConnectionUrl(sourceId, input.apiBaseUrl),
        input.jsonRequest("DELETE", request),
        sourceConnectionRevokedSchema,
      );
    },
    async configureBangumiOAuthClient(inputValue) {
      const request = input.validateRequest(
        bangumiOAuthClientConfigurationRequestSchema,
        inputValue,
        "Bangumi OAuth 应用配置无效",
      );
      return await input.requestJson(
        new URL(
          "source-connections/bangumi/client-configuration",
          input.apiBaseUrl,
        ),
        input.jsonRequest("PUT", request),
        bangumiOAuthClientConfigurationSchema,
      );
    },
    async beginBangumiAuthorization(): Promise<BangumiAuthorizationStart> {
      return await input.requestJson(
        bangumiAuthorizationUrl,
        input.jsonRequest("POST", {}),
        bangumiAuthorizationStartSchema,
      );
    },
    async getBangumiAuthorizationAttempt(
      attemptId: string,
    ): Promise<PublicBangumiAuthorizationAttempt> {
      const request = input.validateRequest(
        bangumiAuthorizationAttemptRequestSchema,
        { attemptId },
        "Bangumi 授权请求编号无效",
      );
      return await input.requestJson(
        bangumiAuthorizationAttemptUrl(request.attemptId, input.apiBaseUrl),
        { headers: { accept: "application/json" } },
        publicBangumiAuthorizationAttemptSchema,
      );
    },
    async cancelBangumiAuthorization(
      attemptId: string,
    ): Promise<PublicBangumiAuthorizationAttempt> {
      const request = input.validateRequest(
        bangumiAuthorizationAttemptRequestSchema,
        { attemptId },
        "Bangumi 授权请求编号无效",
      );
      return await input.requestJson(
        new URL(
          `source-connections/bangumi/authorizations/${encodeURIComponent(request.attemptId)}/cancel`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", {}),
        publicBangumiAuthorizationAttemptSchema,
      );
    },
    async revokeBangumiSourceConnection(inputValue) {
      const request = input.validateRequest(
        sourceConnectionRevocationRequestSchema,
        inputValue,
        "Bangumi 来源连接版本无效",
      );
      return await input.requestJson(
        sourceConnectionUrl("bangumi", input.apiBaseUrl),
        input.jsonRequest("DELETE", request),
        sourceConnectionRevokedSchema,
      );
    },
    async createFanboxConnectionRequest(inputValue) {
      const request = input.validateRequest(
        createFanboxConnectionRequestRequestSchema,
        inputValue,
        "FANBOX 连接请求无效",
      );
      return await input.requestJson(
        fanboxRequestUrl,
        input.jsonRequest("POST", request),
        createFanboxConnectionRequestResponseSchema,
      );
    },
    async getFanboxConnectionRequest(requestId) {
      const request = input.validateRequest(
        fanboxConnectionRequestIdRequestSchema,
        { requestId },
        "FANBOX 连接请求编号无效",
      );
      return await input.requestJson(
        new URL(
          `fanbox-connection-requests/${encodeURIComponent(request.requestId)}`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        publicFanboxConnectionRequestSchema,
      );
    },
    async getFanboxConnectionRequestForPairing(inputValue) {
      const request = input.validateRequest(
        fanboxConnectionRequestPairingRequestSchema,
        inputValue,
        "FANBOX 配对信息无效",
      );
      return await input.requestJson(
        new URL(
          `fanbox-connection-requests/${encodeURIComponent(request.requestId)}/pairing`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", { pairingCode: request.pairingCode }),
        publicFanboxConnectionRequestSchema,
      );
    },
    async completeFanboxConnectionRequest(inputValue) {
      const request = input.validateRequest(
        fanboxConnectionRequestCompletionRequestSchema,
        inputValue,
        "FANBOX 浏览器连接信息无效",
      );
      return await input.requestJson(
        new URL(
          `fanbox-connection-requests/${encodeURIComponent(request.requestId)}/complete`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", request),
        publicFanboxConnectionRequestSchema,
      );
    },
    async cancelFanboxConnectionRequest(inputValue) {
      const request = input.validateRequest(
        fanboxConnectionRequestPairingRequestSchema,
        inputValue,
        "FANBOX 配对信息无效",
      );
      return await input.requestJson(
        new URL(
          `fanbox-connection-requests/${encodeURIComponent(request.requestId)}/cancel`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", { pairingCode: request.pairingCode }),
        publicFanboxConnectionRequestSchema,
      );
    },
    async revokeFanboxSourceConnection(inputValue) {
      const request = input.validateRequest(
        fanboxSourceConnectionRevocationRequestSchema,
        inputValue,
        "FANBOX 来源连接版本无效",
      );
      return await input.requestJson(
        new URL(
          `source-connections/fanbox/${encodeURIComponent(request.creatorId)}`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("DELETE", request),
        sourceConnectionRevokedSchema,
      );
    },
  };
}

function sourceConnectionUrl(id: string, apiBaseUrl: URL): URL {
  return new URL(`source-connections/${encodeURIComponent(id)}`, apiBaseUrl);
}

function bangumiAuthorizationAttemptUrl(
  attemptId: string,
  apiBaseUrl: URL,
): URL {
  return new URL(
    `source-connections/bangumi/authorizations/${encodeURIComponent(attemptId)}`,
    apiBaseUrl,
  );
}
