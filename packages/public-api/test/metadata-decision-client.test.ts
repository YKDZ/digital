import { expect, it, vi } from "vitest";

import { createPublicApiClient } from "../src/index.ts";

it("由唯一公共客户端准备、确认并取消人工属性修订", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      input instanceof URL
        ? new URL(input)
        : input instanceof Request
          ? new URL(input.url)
          : new URL(input);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      url: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      ...(body === undefined ? {} : { body }),
    });
    return Response.json({
      previewId: "preview-1",
      assetId: "asset/1",
      property: "asset.title",
      metadataUsageContext: "asset.ordinary",
      kind: "pin",
      value: "人工标题",
      status: "awaiting-confirmation",
      current: {
        status: "resolved",
        values: [{ value: "旧标题", sourceIdentity: "tmdb" }],
      },
      projected: {
        status: "resolved",
        values: [{ value: "人工标题", sourceIdentity: "user" }],
      },
      impact: "确认后固定人工输入值",
      blockingConditions: [],
    });
  });
  const client = createPublicApiClient({
    baseUrl: "http://127.0.0.1:4321/product/",
    fetch,
  });

  const preview = await client.prepareMetadataDecision("asset/1", {
    kind: "pin",
    property: "asset.title",
    value: "人工标题",
  });
  await client.confirmMetadataDecision(preview.previewId);
  await client.cancelMetadataDecision(preview.previewId);

  expect(preview).toMatchObject({
    property: "asset.title",
    current: { values: [{ value: "旧标题" }] },
    projected: { values: [{ value: "人工标题", sourceIdentity: "user" }] },
  });
  expect(requests).toEqual([
    {
      url: "/product/api/v1/assets/asset%2F1/metadata-decisions/previews",
      method: "POST",
      body: { kind: "pin", property: "asset.title", value: "人工标题" },
    },
    {
      url: "/product/api/v1/metadata-decision-previews/preview-1/confirm",
      method: "POST",
      body: {},
    },
    {
      url: "/product/api/v1/metadata-decision-previews/preview-1/cancel",
      method: "POST",
      body: {},
    },
  ]);
});
