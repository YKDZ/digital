import { expect, it, vi } from "vitest";

import { createPublicApiClient } from "../src/client.ts";
import {
  createExecutionClientMethods,
  PublicExecutionClientError,
} from "../src/execution-client.ts";

function executionResponse(
  input: Partial<{
    readonly id: string;
    readonly status: "running" | "completed" | "failed";
    readonly outcome: "accepted" | "cancelled";
  }> = {},
) {
  return new Response(
    JSON.stringify({
      kind: "execution",
      id: input.id ?? "execution-original",
      operationKind: "rescrape",
      status: input.status ?? "completed",
      stage: "completed",
      ...(input.outcome === undefined ? { outcome: "accepted" } : input),
      progress: { dispositions: [], workItems: [], targets: [] },
      sourceRefreshRuns: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function methods(fetch: typeof globalThis.fetch) {
  return createExecutionClientMethods({
    apiBaseUrl: new URL("http://127.0.0.1:48080/api/v1/"),
    fetch,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.href;
  return typeof input === "string" ? input : input.url;
}

it("只为当前主体刷新提交两种明确操作", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ id: "execution-new" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = methods(fetch);

  await expect(
    client.startCurrentScopeRescrape({ subjectId: "subject-1" }),
  ).resolves.toEqual({ id: "execution-new" });
  await expect(
    client.startMetadataRefresh({
      subjectId: "subject-2",
      reviewPolicy: "review",
    }),
  ).resolves.toEqual({ id: "execution-new" });
  expect(
    fetch.mock.calls.map(([input, init]) => ({
      url: requestUrl(input),
      method: init?.method,
      body: init?.body,
    })),
  ).toEqual([
    {
      url: "http://127.0.0.1:48080/api/v1/refreshes",
      method: "POST",
      body: JSON.stringify({ operation: "rescrape", subjectId: "subject-1" }),
    },
    {
      url: "http://127.0.0.1:48080/api/v1/refreshes",
      method: "POST",
      body: JSON.stringify({
        operation: "metadata-refresh",
        subjectId: "subject-2",
        reviewPolicy: "review",
      }),
    },
  ]);
});

it("执行方法并入唯一公共客户端工厂", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ id: "execution-from-factory" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = createPublicApiClient({
    baseUrl: "http://127.0.0.1:48080",
    fetch,
  });

  await expect(
    client.startCurrentScopeRescrape({ subjectId: "subject-1" }),
  ).resolves.toEqual({ id: "execution-from-factory" });
  expect(requestUrl(fetch.mock.calls[0]![0]!)).toBe(
    "http://127.0.0.1:48080/api/v1/refreshes",
  );
});

it("刷新受理结果未知时不自动重新提交", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new TypeError("fetch failed", {
      cause: new Error("socket closed after request body"),
    });
  });

  await expect(
    methods(fetch).startMetadataRefresh({ subjectId: "subject-unknown" }),
  ).rejects.toMatchObject({
    kind: "transport",
    executionId: undefined,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(requestUrl(fetch.mock.calls[0]![0]!)).toBe(
    "http://127.0.0.1:48080/api/v1/refreshes",
  );
});

it("查询传输失败保留原执行身份，后续查询继续读取同一记录", async () => {
  let calls = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    calls += 1;
    if (calls === 1)
      throw new TypeError("fetch failed", {
        cause: new Error("read ECONNRESET"),
      });
    return executionResponse({ id: "execution-original" });
  });
  const client = methods(fetch);

  let queryError: unknown;
  try {
    await client.inspectExecution("execution-original");
  } catch (error) {
    queryError = error;
  }
  expect(queryError).toBeInstanceOf(PublicExecutionClientError);
  expect(queryError).toMatchObject({
    kind: "transport",
    executionId: "execution-original",
  });
  if (!(queryError instanceof PublicExecutionClientError))
    throw new Error("查询错误没有保留公共执行错误类型");
  expect(queryError.cause).toMatchObject({
    cause: expect.objectContaining({ message: "read ECONNRESET" }),
  });

  await expect(
    client.inspectExecution(queryError.executionId!),
  ).resolves.toMatchObject({
    kind: "execution",
    id: "execution-original",
    status: "completed",
    outcome: "accepted",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([
    "http://127.0.0.1:48080/api/v1/executions/execution-original",
    "http://127.0.0.1:48080/api/v1/executions/execution-original",
  ]);
});

it("将取消请求受理与执行的持久终态分开返回", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        JSON.stringify({
          requestStatus: "requested",
          inspection: {
            kind: "execution",
            id: "execution-to-cancel",
            operationKind: "refresh-metadata",
            status: "failed",
            stage: "failed",
            outcome: "cancelled",
            cancellation: {
              requestedBy: "public-api",
              requestedAt: "2026-10-16T00:00:00.000Z",
            },
            progress: { dispositions: [], workItems: [], targets: [] },
            sourceRefreshRuns: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  await expect(
    methods(fetch).cancelExecution("execution-to-cancel", {
      reason: "测试取消",
    }),
  ).resolves.toMatchObject({
    requestStatus: "requested",
    inspection: {
      kind: "execution",
      id: "execution-to-cancel",
      status: "failed",
      outcome: "cancelled",
    },
  });
  expect(requestUrl(fetch.mock.calls[0]![0]!)).toBe(
    "http://127.0.0.1:48080/api/v1/executions/execution-to-cancel/cancel",
  );
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ reason: "测试取消" }),
  });
});

it("库扫描父执行保留每个子执行状态及来源运行变更集身份", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        JSON.stringify({
          kind: "asset-library-scan",
          id: "parent-execution",
          status: "running",
          cancellationRequested: {
            requestedBy: "public-api",
            requestedAt: "2026-10-16T00:00:00.000Z",
          },
          children: [
            { executionId: "missing-child", status: "missing" },
            {
              executionId: "child-execution",
              status: "available",
              execution: {
                status: "completed",
                stage: "completed",
                outcome: "accepted",
                progress: { dispositions: [], workItems: [], targets: [] },
                sourceRefreshRuns: [
                  {
                    id: "source-run",
                    initiatedBy: "public-api",
                    initiatedAt: "2026-10-16T00:00:00.000Z",
                    requestedSelection: {
                      subjectId: "subject-1",
                      sourceAssociationId: "association-1",
                      sourceIdentity: "source-a",
                      nativeAddress: "https://source.invalid/item/1",
                      selectors: [
                        { kind: "metadata-property", property: "asset.title" },
                      ],
                    },
                    reviewPolicy: "automatic",
                    phase: "terminal",
                    outcome: "succeeded",
                    scopes: [
                      {
                        coverage: {
                          sourceIdentity: "source-a",
                          nativeAddress: "https://source.invalid/item/1",
                          coverageId: "coverage-1",
                        },
                        state: "terminal",
                        acquisitionAttempt: 1,
                        changeSetId: "change-set-1",
                        candidateSourceRecordId: "record-2",
                        outcome: "applied",
                      },
                    ],
                    changeSets: [
                      {
                        id: "change-set-1",
                        runId: "source-run",
                        coverage: {
                          sourceIdentity: "source-a",
                          nativeAddress: "https://source.invalid/item/1",
                          coverageId: "coverage-1",
                        },
                        candidateSourceRecordId: "record-2",
                        changes: [
                          { kind: "established", factReference: "fact-1" },
                        ],
                        requiresReview: false,
                        disposition: "automatic",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  await expect(
    methods(fetch).inspectExecution("parent-execution"),
  ).resolves.toMatchObject({
    kind: "asset-library-scan",
    id: "parent-execution",
    status: "running",
    cancellationRequested: { requestedBy: "public-api" },
    children: [
      { executionId: "missing-child", status: "missing" },
      {
        executionId: "child-execution",
        status: "available",
        execution: {
          status: "completed",
          outcome: "accepted",
          sourceRefreshRuns: [
            {
              id: "source-run",
              scopes: [{ changeSetId: "change-set-1" }],
              changeSets: [
                { id: "change-set-1", candidateSourceRecordId: "record-2" },
              ],
            },
          ],
        },
      },
    ],
  });
});
