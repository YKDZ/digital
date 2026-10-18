import type { ProductApplication } from "@digital/product-application";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";

import { mountAssetInspectionRoutes } from "../src/inspection.ts";

const overview = {
  assetId: "asset-1",
  entity: { id: "asset-1", kind: "digital-asset" as const },
  sections: [
    { kind: "source-records" as const, count: 1, status: "available" as const },
  ],
};

function createTestApi(workflow: Record<string, unknown>) {
  const api = new Hono();
  mountAssetInspectionRoutes(api, {
    workflow,
  } as unknown as ProductApplication);
  return api;
}

it("按资产分页返回检查资料，并把原始正文按完整 Unicode 代码点续读", async () => {
  const body = "甲🙂乙";
  const api = createTestApi({
    inspectAssetEvidence: vi.fn(async () => overview),
    listAssetEvidence: vi.fn(async () => ({
      assetId: "asset-1",
      kind: "source-records",
      status: "available",
      items: [{ kind: "source-record", id: "record-1", status: "available" }],
    })),
    inspectAssetSourceRecord: vi.fn(async () => ({
      id: "record-1",
      sourceIdentity: "source-1",
      nativeAddress: "作品/1",
      mediaType: "text/plain",
      acquiredAt: "2026-10-16T00:00:00.000Z",
      acquisition: {
        requestedAddress: "public-record",
        method: "GET",
        authorized: false,
      },
      coverage: {
        id: "coverage-1",
        completeness: "complete",
        authority: "official",
      },
      digest: "digest-1",
      body,
    })),
    listCurrentAttentionPage: vi.fn(async () => ({ items: [] })),
    listWorkflowHistoryPage: vi.fn(async () => ({ items: [] })),
  });

  const first = await api.request(
    "/assets/asset-1/inspection/source-records/record-1?offset=1&limit=1",
  );
  const firstChunk = await first.json();
  expect(firstChunk).toMatchObject({
    offset: 1,
    nextOffset: 2,
    complete: false,
    content: "🙂",
  });

  const second = await api.request(
    "/assets/asset-1/inspection/source-records/record-1?offset=2&limit=1",
  );
  const secondChunk = await second.json();
  expect(secondChunk).toMatchObject({
    offset: 2,
    nextOffset: 3,
    complete: true,
    content: "乙",
  });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
});

it("区分未找到、分页错误和读取故障，错误文案不透出秘密", async () => {
  const api = createTestApi({
    inspectAssetEvidence: vi.fn(async () => undefined),
    listAssetEvidence: vi.fn(async () => {
      throw new Error("token=secret-value");
    }),
    inspectAssetSourceRecord: vi.fn(async () => undefined),
    listCurrentAttentionPage: vi.fn(async () => ({ items: [] })),
    listWorkflowHistoryPage: vi.fn(async () => ({ items: [] })),
  });

  const missing = await api.request("/assets/missing/inspection");
  expect(missing.status).toBe(404);
  const invalid = await api.request(
    "/assets/asset-1/inspection/evidence/source-records?limit=0",
  );
  expect(invalid.status).toBe(400);
  const failed = await api.request(
    "/assets/asset-1/inspection/evidence/source-records",
  );
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("secret-value");
});

it("保留已有待处理事项与分页工作流历史入口", async () => {
  const calls: string[] = [];
  const api = createTestApi({
    inspectAssetEvidence: vi.fn(async () => overview),
    listAssetEvidence: vi.fn(async () => ({
      assetId: "asset-1",
      kind: "current-values",
      status: "missing",
      items: [],
    })),
    inspectAssetSourceRecord: vi.fn(async () => undefined),
    listCurrentAttentionPage: vi.fn(async (request) => {
      calls.push(`attention:${JSON.stringify(request)}`);
      return { items: [], nextCursor: "attention-next" };
    }),
    listWorkflowHistoryPage: vi.fn(async (request) => {
      calls.push(`history:${JSON.stringify(request)}`);
      return { items: [], nextCursor: "history-next" };
    }),
  });

  const attention = await api.request("/attention?limit=3&cursor=att-next");
  const history = await api.request(
    "/workflow-history?limit=2&cursor=hist-next",
  );
  expect(attention.status).toBe(200);
  expect(history.status).toBe(200);
  expect(await attention.json()).toEqual({
    items: [],
    nextCursor: "attention-next",
  });
  expect(await history.json()).toEqual({
    items: [],
    nextCursor: "history-next",
  });
  expect(calls).toEqual([
    'attention:{"limit":3,"cursor":"att-next"}',
    'history:{"limit":2,"cursor":"hist-next"}',
  ]);
});
