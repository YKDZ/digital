import {
  safeParse,
  type BaseIssue,
  type BaseSchema,
  type InferOutput,
} from "valibot";

import { publicApiErrorResponseSchema } from "./contract.ts";
import type { PublicApiError } from "./contract.ts";
import {
  publicExecutionCancellationRequestSchema,
  publicExecutionCancellationSchema,
  publicExecutionInspectionSchema,
  publicRefreshExecutionIdSchema,
  publicRefreshOperationRequestSchema,
  type PublicExecutionCancellation,
  type PublicExecutionCancellationRequest,
  type PublicExecutionInspection,
  type PublicRefreshExecutionId,
  type PublicRefreshOperationRequest,
} from "./execution-contract.ts";

export type PublicExecutionClientErrorKind =
  | PublicApiError["code"]
  | "transport"
  | "protocol";

/** 内部错误保留已知执行身份；查询传输失败不表示后台执行失败。 */
export class PublicExecutionClientError extends Error {
  readonly kind: PublicExecutionClientErrorKind;
  readonly status?: number | undefined;
  readonly executionId?: string | undefined;

  constructor(
    kind: PublicExecutionClientErrorKind,
    message: string,
    executionId?: string,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublicExecutionClientError";
    this.kind = kind;
    this.status = status;
    this.executionId = executionId;
  }
}

export type PublicExecutionClientMethods = {
  startCurrentScopeRescrape(input: {
    readonly subjectId: string;
  }): Promise<PublicRefreshExecutionId>;
  startMetadataRefresh(input: {
    readonly subjectId: string;
    readonly reviewPolicy?: "automatic" | "review";
  }): Promise<PublicRefreshExecutionId>;
  inspectExecution(executionId: string): Promise<PublicExecutionInspection>;
  cancelExecution(
    executionId: string,
    input?: PublicExecutionCancellationRequest,
  ): Promise<PublicExecutionCancellation>;
};

export type PublicExecutionClientOptions = {
  /** 由唯一公共客户端工厂提供的、以 `/api/v1/` 结尾的 URL。 */
  readonly apiBaseUrl: URL;
  readonly fetch: typeof globalThis.fetch;
};

/** 供唯一 PublicApiClient 工厂合并方法的内部构造器，不单独导出为客户端工厂。 */
export function createExecutionClientMethods(
  options: PublicExecutionClientOptions,
): PublicExecutionClientMethods {
  const request = options.fetch;

  return {
    async startCurrentScopeRescrape(input) {
      return await postJson(
        request,
        new URL("refreshes", options.apiBaseUrl),
        validateRequest(publicRefreshOperationRequestSchema, {
          operation: "rescrape",
          subjectId: input.subjectId,
        }),
        publicRefreshExecutionIdSchema,
      );
    },

    async startMetadataRefresh(input) {
      return await postJson(
        request,
        new URL("refreshes", options.apiBaseUrl),
        validateRequest(publicRefreshOperationRequestSchema, {
          operation: "metadata-refresh",
          subjectId: input.subjectId,
          ...(input.reviewPolicy === undefined
            ? {}
            : { reviewPolicy: input.reviewPolicy }),
        }),
        publicRefreshExecutionIdSchema,
      );
    },

    async inspectExecution(executionId) {
      const id = validateExecutionId(executionId);
      return await getJson(
        request,
        new URL(`executions/${encodeURIComponent(id)}`, options.apiBaseUrl),
        publicExecutionInspectionSchema,
        id,
      );
    },

    async cancelExecution(executionId, input = {}) {
      const id = validateExecutionId(executionId);
      const body = validateRequest(
        publicExecutionCancellationRequestSchema,
        input,
      );
      return await postJson(
        request,
        new URL(
          `executions/${encodeURIComponent(id)}/cancel`,
          options.apiBaseUrl,
        ),
        body,
        publicExecutionCancellationSchema,
        id,
      );
    },
  };
}

function validateExecutionId(value: string): string {
  const result = safeParse(publicRefreshExecutionIdSchema, { id: value });
  if (!result.success)
    throw new PublicExecutionClientError("invalid-request", "执行标识无效");
  return result.output.id;
}

function validateRequest<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(schema: Schema, input: unknown): InferOutput<Schema> {
  const result = safeParse(schema, input);
  if (!result.success)
    throw new PublicExecutionClientError("invalid-request", "执行请求无效");
  return result.output;
}

async function getJson<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(
  fetch: typeof globalThis.fetch,
  url: URL,
  schema: Schema,
  executionId: string,
): Promise<InferOutput<Schema>> {
  return await requestJson(fetch, url, { method: "GET" }, schema, executionId);
}

async function postJson<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(
  fetch: typeof globalThis.fetch,
  url: URL,
  body: PublicRefreshOperationRequest | PublicExecutionCancellationRequest,
  schema: Schema,
  executionId?: string,
): Promise<InferOutput<Schema>> {
  return await requestJson(
    fetch,
    url,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    schema,
    executionId,
  );
}

async function requestJson<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(
  fetch: typeof globalThis.fetch,
  url: URL,
  init: RequestInit,
  schema: Schema,
  executionId?: string,
): Promise<InferOutput<Schema>> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    response = await fetch(url, {
      ...init,
      headers,
    });
  } catch (cause) {
    throw new PublicExecutionClientError(
      "transport",
      "无法连接当前产品服务，执行结局仍未知",
      executionId,
      undefined,
      { cause },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new PublicExecutionClientError(
      "protocol",
      "服务响应无法读取",
      executionId,
      response.status,
      { cause },
    );
  }

  if (!response.ok) {
    const error = safeParse(publicApiErrorResponseSchema, body);
    if (!error.success)
      throw new PublicExecutionClientError(
        "protocol",
        "服务返回了无法识别的错误",
        executionId,
        response.status,
      );
    throw new PublicExecutionClientError(
      error.output.error.code,
      error.output.error.message,
      executionId,
      response.status,
    );
  }

  const result = safeParse(schema, body);
  if (!result.success)
    throw new PublicExecutionClientError(
      "protocol",
      "服务返回的执行数据无法识别",
      executionId,
      response.status,
    );
  return result.output;
}
