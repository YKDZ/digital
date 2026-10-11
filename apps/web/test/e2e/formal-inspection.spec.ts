import { expect, test } from "@playwright/test";

import { mockCataloguePage, type CatalogueFixture } from "./catalogue-fixture";

/**
 * 记录详情页除了列表目录，还会按记录号单独请求这条执行的投影。
 * 夹具因此给出与交付 DTO 一致的完整视图：结构化分派、主体、逐项结果与建议内容。
 */
const catalogue: CatalogueFixture = {
  configured: true,
  assets: [],
  automation: [],
  executions: [
    {
      id: "record-1",
      folder: "作品文件夹",
      intent: "directed-recognition",
      status: "completed",
      outcome: "proposal",
      dispositions: [
        {
          key: "official-collection",
          status: "completed",
          output: "已产生结果",
        },
        { key: "recognition", status: "failed", reason: "识别未通过标记" },
      ],
      targets: [
        { key: "subject-1", label: "内容 1", status: "completed" },
        {
          key: "scope-1",
          label: "文件范围 作品文件夹",
          status: "blocked",
          reason: "缺少目录授权标记",
        },
      ],
      items: [
        {
          key: "item-1",
          relativePaths: ["轻小说/第一卷"],
          outcome: "proposal",
          reason: "逐项等待确认标记",
          recognition: {
            status: "proposed",
            explanation: "逐项识别说明标记",
          },
        },
      ],
      recognition: { status: "proposed", explanation: "发现需要确认的变更" },
      preview: {
        id: "preview-1",
        status: "awaiting-confirmation",
        blockingConditions: [],
        current: {
          id: "asset-1",
          refreshTarget: { subjectId: "asset-1" },
          cardComponent: "generic",
          detailComponent: "generic",
          title: "当前内容标题",
          classifications: [],
          available: true,
          relationships: [],
        },
        proposed: {
          id: "asset-1",
          refreshTarget: { subjectId: "asset-1" },
          cardComponent: "generic",
          detailComponent: "generic",
          title: "建议内容标题",
          classifications: [],
          available: true,
          relationships: [],
        },
      },
    },
  ],
};

test("刷新记录按记录号展示结构化结果和同一资产视图", async ({ page }) => {
  await mockCataloguePage(page, catalogue);
  await page.goto("/inspection?record=record-1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByRole("heading", { name: "刷新详情" })).toBeVisible();
  await expect(page.getByText("文件夹：作品文件夹")).toBeVisible();
  await expect(page.getByText("状态：等待处理")).toBeVisible();

  await expect(page.getByText("已产生结果")).toBeVisible();
  await expect(page.getByText("识别未通过标记")).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "逐项结果" }),
  ).toBeVisible();
  await expect(page.getByText("item-1：等待处理")).toBeVisible();
  await expect(page.getByText("轻小说/第一卷")).toBeVisible();
  await expect(page.getByText("逐项等待确认标记")).toBeVisible();
  await expect(page.getByText("逐项识别说明标记")).toBeVisible();
  await expect(page.getByText("内容 1：已完成")).toBeVisible();
  await expect(page.getByText("缺少目录授权标记")).toBeVisible();

  await expect(
    page.getByRole("heading", { level: 2, name: "当前内容" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "建议内容" }),
  ).toBeVisible();
  await expect(page.getByText("当前内容标题")).toBeVisible();
  await expect(page.getByText("建议内容标题")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认使用" })).toBeVisible();
  await expect(page.getByRole("button", { name: "不使用" })).toBeVisible();
});
