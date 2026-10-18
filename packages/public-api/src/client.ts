import {
  safeParse,
  type BaseIssue,
  type BaseSchema,
  type InferOutput,
} from "valibot";

import { automationClientMethods } from "./automation-client.ts";
import type { PublicAutomationClientMethods } from "./automation-client.ts";
import {
  assetLibraryOptionsSchema,
  assetLibraryRemovalSchema,
  initialAssetLibraryConfigurationSavedSchema,
  initialAssetLibraryConfigurationRestoreStatusSchema,
  assetLibraryScanSchema,
  assetLibraryScanStartSchema,
  assetLibrarySchema,
  assetLibraryListSchema,
  assetPageSchema,
  removeAssetLibraryRequestSchema,
  saveAssetLibraryRequestSchema,
  listAssetsRequestSchema,
  listUnrecognizedMaterialsRequestSchema,
  listAssetLibrariesRequestSchema,
  publicApiErrorResponseSchema,
  unrecognizedMaterialPageSchema,
  type ListAssetsRequest,
  type ListAssetLibrariesRequest,
  type ListUnrecognizedMaterialsRequest,
  type PublicApiError,
  type PublicCurrentAsset,
  type PublicPage,
  type PublicUnrecognizedMaterial,
  type PublicAssetLibrary,
  type PublicAssetLibraryOptions,
  type InitialAssetLibraryConfigurationRestoreStatus,
  type PublicAssetLibraryScan,
  type RemoveAssetLibraryRequest,
  type SaveAssetLibraryRequest,
} from "./contract.ts";
import {
  createExecutionClientMethods,
  type PublicExecutionClientMethods,
} from "./execution-client.ts";
import {
  createAssetInspectionMethods,
  type AssetInspectionMethods,
} from "./inspection-client.ts";
import { mediaClientMethods } from "./media-client.ts";
import type { PublicMediaClientMethods } from "./media-client.ts";
import { metadataDecisionClientMethods } from "./metadata-decision-client.ts";
import type { PublicMetadataDecisionClientMethods } from "./metadata-decision-contract.ts";
import {
  relationshipClientMethods,
  type PublicRelationshipClientMethods,
} from "./relationship-client.ts";
import { sourceConnectionClientMethods } from "./source-connection-client.ts";
import type { PublicSourceConnectionClientMethods } from "./source-connection-contract.ts";
import { sourceRecognitionClientMethods } from "./source-recognition-client.ts";
import type { PublicSourceRecognitionClientMethods } from "./source-recognition-client.ts";
import { sourceRepairClientMethods } from "./source-repair-client.ts";
import type { PublicSourceRepairClientMethods } from "./source-repair-client.ts";

export type PublicApiClientErrorKind =
  | PublicApiError["code"]
  | "transport"
  | "protocol";

export class PublicApiClientError extends Error {
  readonly kind: PublicApiClientErrorKind;
  readonly status?: number | undefined;

  constructor(
    kind: PublicApiClientErrorKind,
    message: string,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublicApiClientError";
    this.kind = kind;
    this.status = status;
  }
}

export type PublicApiClient = PublicExecutionClientMethods &
  PublicAutomationClientMethods &
  PublicSourceConnectionClientMethods & {
    listAssetLibraryOptions(): Promise<PublicAssetLibraryOptions>;
    listAssetLibraries(
      input?: ListAssetLibrariesRequest,
    ): Promise<PublicPage<PublicAssetLibrary>>;
    saveAssetLibrary(
      input: SaveAssetLibraryRequest & {
        readonly id?: string;
        readonly expectedVersion?: number;
      },
    ): Promise<PublicAssetLibrary>;
    removeAssetLibrary(
      input: RemoveAssetLibraryRequest & { readonly id: string },
    ): Promise<void>;
    saveInitialAssetLibraryConfiguration(): Promise<{
      readonly libraryCount: number;
    }>;
    inspectInitialAssetLibraryConfiguration(): Promise<InitialAssetLibraryConfigurationRestoreStatus>;
    restoreInitialAssetLibraryConfiguration(): Promise<InitialAssetLibraryConfigurationRestoreStatus>;
    startAssetLibraryScan(
      assetLibraryId: string,
    ): Promise<{ readonly parentExecutionId: string }>;
    inspectAssetLibraryScan(
      parentExecutionId: string,
    ): Promise<PublicAssetLibraryScan>;
    listAssets(
      input?: ListAssetsRequest,
    ): Promise<PublicPage<PublicCurrentAsset>>;
    listUnrecognizedMaterials(
      input?: ListUnrecognizedMaterialsRequest,
    ): Promise<PublicPage<PublicUnrecognizedMaterial>>;
  } & AssetInspectionMethods &
  PublicRelationshipClientMethods &
  PublicMetadataDecisionClientMethods &
  PublicMediaClientMethods &
  PublicSourceRecognitionClientMethods &
  PublicSourceRepairClientMethods;

export type PublicApiClientOptions = {
  readonly baseUrl: string | URL;
  readonly fetch?: typeof globalThis.fetch;
};

export function createPublicApiClient(
  options: PublicApiClientOptions,
): PublicApiClient {
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl);
  } catch (cause) {
    throw new PublicApiClientError(
      "invalid-request",
      "服务地址无效",
      undefined,
      { cause },
    );
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
    throw new PublicApiClientError("invalid-request", "服务地址无效");
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/api/v1/`;
  const request = options.fetch ?? globalThis.fetch;

  return {
    ...createExecutionClientMethods({ apiBaseUrl: baseUrl, fetch: request }),
    ...automationClientMethods({
      apiBaseUrl: baseUrl,
      requestJson: (url, init, schema) =>
        requestJson(request, url, init, schema),
      validateRequest,
      jsonRequest,
    }),
    ...createAssetInspectionMethods({ apiBaseUrl: baseUrl, fetch: request }),
    ...sourceConnectionClientMethods({
      apiBaseUrl: baseUrl,
      requestJson: (url, init, schema) =>
        requestJson(request, url, init, schema),
      validateRequest,
      jsonRequest,
    }),
    ...sourceRecognitionClientMethods({
      apiBaseUrl: baseUrl,
      requestJson: (url, init, schema) =>
        requestJson(request, url, init, schema),
      validateRequest,
      jsonRequest,
    }),
    ...sourceRepairClientMethods({
      apiBaseUrl: baseUrl,
      requestJson: (url, init, schema) =>
        requestJson(request, url, init, schema),
      validateRequest,
      jsonRequest,
    }),
    ...relationshipClientMethods({
      apiBaseUrl: baseUrl,
      requestJson: (url, init, schema) =>
        requestJson(request, url, init, schema),
      validateRequest,
      jsonRequest,
    }),
    ...metadataDecisionClientMethods({
      apiBaseUrl: baseUrl,
      requestJson: (url, init, schema) =>
        requestJson(request, url, init, schema),
      validateRequest,
      jsonRequest,
    }),
    ...mediaClientMethods({
      apiBaseUrl: baseUrl,
      fetch: request,
      requestJson: (url, init, schema) =>
        requestJson(request, url, init, schema),
      validateRequest,
      jsonRequest,
    }),
    async listAssetLibraryOptions() {
      return await getJson(
        request,
        new URL("asset-library-options", baseUrl),
        assetLibraryOptionsSchema,
      );
    },
    async listAssetLibraries(input = {}) {
      const validated = validateRequest(listAssetLibrariesRequestSchema, input);
      const url = new URL("asset-libraries", baseUrl);
      addPageParameters(url, validated);
      return await getJson(request, url, assetLibraryListSchema);
    },
    async saveAssetLibrary(input) {
      const { id, expectedVersion, ...configuration } = input;
      const validated = validateRequest(
        saveAssetLibraryRequestSchema,
        configuration,
        "资产库配置无效",
      );
      if (id === undefined && expectedVersion !== undefined)
        throw new PublicApiClientError("invalid-request", "资产库配置无效");
      if (id !== undefined && (!id || !Number.isSafeInteger(expectedVersion)))
        throw new PublicApiClientError("invalid-request", "资产库配置无效");
      const url =
        id === undefined
          ? new URL("asset-libraries", baseUrl)
          : new URL(`asset-libraries/${encodeURIComponent(id)}`, baseUrl);
      return await requestJson(
        request,
        url,
        id === undefined
          ? jsonRequest("POST", validated)
          : jsonRequest("PUT", {
              ...validated,
              expectedVersion,
            }),
        assetLibrarySchema,
      );
    },
    async removeAssetLibrary(input) {
      const { id, ...requestInput } = input;
      if (!id)
        throw new PublicApiClientError("invalid-request", "资产库编号无效");
      const body = validateRequest(
        removeAssetLibraryRequestSchema,
        requestInput,
        "资产库配置无效",
      );
      await requestJson(
        request,
        new URL(`asset-libraries/${encodeURIComponent(id)}`, baseUrl),
        jsonRequest("DELETE", body),
        assetLibraryRemovalSchema,
      );
    },
    async saveInitialAssetLibraryConfiguration() {
      return await requestJson(
        request,
        new URL("asset-library-initial-configuration", baseUrl),
        jsonRequest("POST", {}),
        initialAssetLibraryConfigurationSavedSchema,
      );
    },
    async inspectInitialAssetLibraryConfiguration() {
      return await getJson(
        request,
        new URL("asset-library-initial-configuration", baseUrl),
        initialAssetLibraryConfigurationRestoreStatusSchema,
      );
    },
    async restoreInitialAssetLibraryConfiguration() {
      return await requestJson(
        request,
        new URL("asset-library-initial-configuration/restore", baseUrl),
        jsonRequest("POST", {}),
        initialAssetLibraryConfigurationRestoreStatusSchema,
      );
    },
    async startAssetLibraryScan(assetLibraryId) {
      if (assetLibraryId.trim().length === 0)
        throw new PublicApiClientError(
          "invalid-request",
          "请选择要扫描的资产库",
        );
      return await requestJson(
        request,
        new URL(
          `asset-libraries/${encodeURIComponent(assetLibraryId)}/scans`,
          baseUrl,
        ),
        jsonRequest("POST", {}),
        assetLibraryScanStartSchema,
      );
    },
    async inspectAssetLibraryScan(parentExecutionId) {
      if (parentExecutionId.trim().length === 0)
        throw new PublicApiClientError("invalid-request", "扫描记录编号无效");
      return await getJson(
        request,
        new URL(
          `asset-library-scans/${encodeURIComponent(parentExecutionId)}`,
          baseUrl,
        ),
        assetLibraryScanSchema,
      );
    },
    async listAssets(input = {}) {
      const validated = validateRequest(listAssetsRequestSchema, input);
      const url = new URL("assets", baseUrl);
      addPageParameters(url, validated);
      return await getJson(request, url, assetPageSchema);
    },
    async listUnrecognizedMaterials(input = {}) {
      const validated = validateRequest(
        listUnrecognizedMaterialsRequestSchema,
        input,
      );
      const url = new URL("unrecognized-materials", baseUrl);
      addPageParameters(url, validated);
      return await getJson(request, url, unrecognizedMaterialPageSchema);
    },
  };
}

function addPageParameters(
  url: URL,
  input: {
    readonly assetLibraryId?: string | undefined;
    readonly parentExecutionId?: string | undefined;
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  },
): void {
  if (input.assetLibraryId !== undefined)
    url.searchParams.set("assetLibraryId", input.assetLibraryId);
  if (input.parentExecutionId !== undefined)
    url.searchParams.set("parentExecutionId", input.parentExecutionId);
  if (input.limit !== undefined)
    url.searchParams.set("limit", String(input.limit));
  if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
}

function validateRequest<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(
  schema: Schema,
  input: unknown,
  message = "分页请求无效",
): InferOutput<Schema> {
  const result = safeParse(schema, input);
  if (!result.success)
    throw new PublicApiClientError("invalid-request", message);
  return result.output;
}

function jsonRequest(
  method: "POST" | "PUT" | "DELETE",
  body: unknown,
): RequestInit {
  return {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function getJson<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(
  fetch: typeof globalThis.fetch,
  url: URL,
  schema: Schema,
): Promise<InferOutput<Schema>> {
  return await requestJson(
    fetch,
    url,
    { headers: { accept: "application/json" } },
    schema,
  );
}

async function requestJson<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(
  fetch: typeof globalThis.fetch,
  url: URL,
  init: RequestInit,
  schema: Schema,
): Promise<InferOutput<Schema>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new PublicApiClientError(
      "transport",
      "无法连接当前产品服务",
      undefined,
      { cause },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new PublicApiClientError(
      "protocol",
      "服务响应无法读取",
      response.status,
      { cause },
    );
  }
  if (!response.ok) {
    const error = safeParse(publicApiErrorResponseSchema, body);
    if (!error.success)
      throw new PublicApiClientError(
        "protocol",
        "服务返回了无法识别的错误",
        response.status,
      );
    throw new PublicApiClientError(
      error.output.error.code,
      error.output.error.message,
      response.status,
    );
  }
  const result = safeParse(schema, body);
  if (!result.success)
    throw new PublicApiClientError(
      "protocol",
      "服务返回的数据无法识别",
      response.status,
    );
  return result.output;
}
