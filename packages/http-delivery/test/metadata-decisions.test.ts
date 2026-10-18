import { MetadataDecisionError } from "@digital/application";
import type { ProductApplication } from "@digital/product-application";
import { expect, it } from "vitest";

import { createMetadataDecisionsHttpApi } from "../src/metadata-decisions.ts";

it("把含有输入词的未知存储错误保留为通用服务不可用", async () => {
  const workflow = {
    async inspectAssetEvidence() {
      return {};
    },
    async prepareMetadataDecision() {
      throw new Error("数据库写入必须保密标记");
    },
    async inspectChangeImpactPreview() {
      return {
        metadataDecision: {
          property: "asset.title",
          metadataUsageContext: "asset.ordinary",
          kind: "pin",
          value: "标题",
        },
      };
    },
    async applyChangeImpactPreview() {
      throw new Error("数据库确认必须保密标记");
    },
  };
  const api = createMetadataDecisionsHttpApi({
    workflow,
  } as unknown as ProductApplication);

  const preparation = await api.request(
    "/assets/asset-1/metadata-decisions/previews",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pin",
        property: "asset.title",
        value: "人工标题",
      }),
    },
  );
  expect(preparation.status).toBe(503);
  expect(await preparation.text()).toBe(
    JSON.stringify({
      error: {
        code: "unavailable",
        message: "暂时无法形成属性修订预演",
      },
    }),
  );

  const confirmation = await api.request(
    "/metadata-decision-previews/preview-1/confirm",
    { method: "POST" },
  );
  expect(confirmation.status).toBe(503);
  expect(await confirmation.text()).toBe(
    JSON.stringify({
      error: { code: "unavailable", message: "暂时无法确认属性修订" },
    }),
  );
});

it("把已知预演冲突作为明确的确认失败返回", async () => {
  const workflow = {
    async inspectChangeImpactPreview() {
      return {
        metadataDecision: {
          property: "asset.title",
          metadataUsageContext: "asset.ordinary",
          kind: "pin",
          value: "标题",
        },
      };
    },
    async applyChangeImpactPreview() {
      throw new MetadataDecisionError("conflict", "属性修订已过期");
    },
  };
  const api = createMetadataDecisionsHttpApi({
    workflow,
  } as unknown as ProductApplication);

  const response = await api.request(
    "/metadata-decision-previews/preview-1/confirm",
    {
      method: "POST",
    },
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: { code: "conflict", message: "属性修订已过期" },
  });
});
