import { describe, expect, it, vi } from "vitest";

import { createPublicApiClient, PublicApiClientError } from "../src/index.ts";

describe("公共产品客户端", () => {
  it("按服务端游标读取资产库并可点名历史扫描", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [] }));
    const client = createPublicApiClient({
      baseUrl: "http://127.0.0.1:4321/",
      fetch,
    });

    await expect(
      client.listAssetLibraries({ limit: 1, cursor: "library-page-2" }),
    ).resolves.toMatchObject({ items: [] });
    await client.listUnrecognizedMaterials({
      assetLibraryId: "library-1",
      parentExecutionId: "old-scan",
      limit: 10,
    });

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:4321/api/v1/asset-libraries?limit=1&cursor=library-page-2",
    );
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      "http://127.0.0.1:4321/api/v1/unrecognized-materials?assetLibraryId=library-1&parentExecutionId=old-scan&limit=10",
    );
  });

  it("按服务端分页读取当前资产事实", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "asset-1",
            sourceAssociations: [],
            descriptions: [],
            relatedEntities: [],
            relationships: [],
            locations: [],
          },
        ],
        nextCursor: "cursor-2",
      }),
    );
    const client = createPublicApiClient({
      baseUrl: "http://127.0.0.1:4321/",
      fetch,
    });

    const page = await client.listAssets({
      assetLibraryId: "库 1",
      limit: 20,
      cursor: "cursor-1",
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:4321/api/v1/assets?assetLibraryId=%E5%BA%93+1&limit=20&cursor=cursor-1",
    );
    expect(page.items[0]?.id).toBe("asset-1");
    expect(page.nextCursor).toBe("cursor-2");
  });

  it("区分未决工作项与未被工作项代表的文件系统观察", async () => {
    const client = createPublicApiClient({
      baseUrl: "http://localhost",
      fetch: async () =>
        Response.json({
          items: [
            {
              kind: "work-item",
              parentExecutionId: "parent-1",
              directoryKey: "root-1",
              childExecutionId: "child-1",
              workItemKey: "work-1",
              observedRootId: "root-1",
              relativeScope: ".",
              relativePaths: ["pending/book.pdf"],
            },
            {
              kind: "filesystem-observation",
              parentExecutionId: "parent-1",
              directoryKey: "root-1",
              childExecutionId: "child-1",
              observationId: "snapshot-1:ordinary.txt",
              observedRootId: "root-1",
              relativeScope: ".",
              relativePaths: ["ordinary.txt"],
            },
          ],
        }),
    });

    await expect(client.listUnrecognizedMaterials()).resolves.toMatchObject({
      items: [
        { kind: "work-item", workItemKey: "work-1" },
        {
          kind: "filesystem-observation",
          observationId: "snapshot-1:ordinary.txt",
        },
      ],
    });
  });

  it("在客户端拒绝超出服务端上限的分页请求", async () => {
    const fetch = vi.fn();
    const client = createPublicApiClient({
      baseUrl: "http://localhost",
      fetch,
    });

    await expect(client.listAssets({ limit: 101 })).rejects.toMatchObject({
      kind: "invalid-request",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("把服务端错误转换成稳定的公共错误", async () => {
    const client = createPublicApiClient({
      baseUrl: "http://localhost",
      fetch: async () =>
        Response.json(
          { error: { code: "not-found", message: "资产库不存在" } },
          { status: 404 },
        ),
    });

    const result = client.listAssets({ assetLibraryId: "missing" });
    await expect(result).rejects.toBeInstanceOf(PublicApiClientError);
    await expect(result).rejects.toMatchObject({
      kind: "not-found",
      message: "资产库不存在",
    });
  });

  it("通过 OAuth 公共操作保存 Bangumi 应用配置而不回传私密值", async () => {
    const fetch = vi.fn(async () => Response.json({ configured: true }));
    const client = createPublicApiClient({
      baseUrl: "http://127.0.0.1:4321/",
      fetch,
    });

    await expect(
      client.configureBangumiOAuthClient({
        clientId: "controlled-client",
        clientSecret: "private-client-secret",
        redirectUri:
          "http://127.0.0.1:4321/api/v1/source-connections/bangumi/callback",
      }),
    ).resolves.toEqual({ configured: true });

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:4321/api/v1/source-connections/bangumi/client-configuration",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        clientId: "controlled-client",
        clientSecret: "private-client-secret",
        redirectUri:
          "http://127.0.0.1:4321/api/v1/source-connections/bangumi/callback",
      }),
    });
  });

  it("在客户端拒绝不受支持的 Bangumi OAuth 回调地址", async () => {
    const fetch = vi.fn();
    const client = createPublicApiClient({
      baseUrl: "http://127.0.0.1:4321/",
      fetch,
    });

    await expect(
      client.configureBangumiOAuthClient({
        clientId: "controlled-client",
        clientSecret: "private-client-secret",
        redirectUri: "http://example.com/callback",
      }),
    ).rejects.toMatchObject({ kind: "invalid-request" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
