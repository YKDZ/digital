import { expect, it, vi } from "vitest";

import { createAssetInspectionMethods } from "../src/inspection-client.ts";

it("通过规范化 API 基址读取资产分层和待处理、历史页面", async () => {
  const paths: string[] = [];
  const fetch = vi.fn(async (input: URL | RequestInfo) => {
    const url =
      input instanceof URL
        ? new URL(input)
        : input instanceof Request
          ? new URL(input.url)
          : new URL(input);
    paths.push(`${url.pathname}${url.search}`);
    const body = url.pathname.endsWith("/inspection")
      ? {
          assetId: "asset/a",
          entity: { id: "asset/a", kind: "digital-asset" },
          sections: [
            {
              kind: "source-records",
              count: 1,
              status: "available",
            },
          ],
        }
      : url.pathname.endsWith("/attention") ||
          url.pathname.endsWith("/workflow-history")
        ? { items: [] }
        : {
            assetId: "asset/a",
            kind: "source-records",
            status: "available",
            items: [],
            nextCursor: "next",
          };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const methods = createAssetInspectionMethods({
    apiBaseUrl: new URL("http://127.0.0.1:4200/product/api/v1/"),
    fetch,
  });

  await methods.inspectAssetEvidence("asset/a");
  await methods.listAssetEvidence("asset/a", {
    kind: "source-records",
    limit: 12,
    cursor: "next page",
  });
  await methods.listCurrentAttention({ limit: 4 });
  await methods.listWorkflowHistory({ limit: 3 });

  expect(paths).toEqual([
    "/product/api/v1/assets/asset%2Fa/inspection",
    "/product/api/v1/assets/asset%2Fa/inspection/evidence/source-records?limit=12&cursor=next+page",
    "/product/api/v1/attention?limit=4",
    "/product/api/v1/workflow-history?limit=3",
  ]);
});

it("按代码点分页原始来源正文，并拒绝无法识别的成功响应", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          assetId: "asset-1",
          record: {
            id: "record-1",
            sourceIdentity: "source-1",
            nativeAddress: "作品/1",
            mediaType: "text/plain",
            acquiredAt: "2026-10-16T00:00:00.000Z",
            coverage: {
              id: "coverage-1",
              completeness: "complete",
              authority: "official",
            },
            digest: "digest-1",
          },
          offset: 0,
          nextOffset: 2,
          complete: false,
          content: "甲🙂",
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ items: "not-a-page" }), { status: 200 }),
    );
  const methods = createAssetInspectionMethods({
    apiBaseUrl: new URL("http://127.0.0.1:4200/"),
    fetch,
  });

  await expect(
    methods.readAssetSourceRecord("asset-1", "record-1", {
      offset: 0,
      limit: 2,
    }),
  ).resolves.toMatchObject({ nextOffset: 2, content: "甲🙂" });
  await expect(methods.listCurrentAttention()).rejects.toMatchObject({
    kind: "protocol",
  });
});
