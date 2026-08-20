import { expect, test } from "@playwright/test";

const catalogue = {
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
        { key: "recognition", status: "failed", reason: "需要确认" },
      ],
      recognition: { status: "proposed", explanation: "发现需要确认的变更" },
      preview: {
        id: "preview-1",
        status: "awaiting-confirmation",
        blockingConditions: [],
        current: {
          id: "asset-1",
          title: "当前内容",
          classifications: [],
          available: true,
          relationships: [],
        },
        proposed: {
          id: "asset-1",
          title: "建议内容",
          classifications: [],
          available: true,
          relationships: [],
        },
      },
    },
  ],
};

test("刷新记录按记录号展示结构化结果和同一资产视图", async ({ page }) => {
  await page.route("**/api/catalogue", (route) =>
    route.fulfill({ json: catalogue }),
  );
  await page.goto("/inspection?record=record-1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByRole("heading", { name: "刷新详情" })).toBeVisible();
  await expect(
    page.locator("h1").filter({ hasText: "当前内容" }),
  ).toBeVisible();
  await expect(
    page.locator("h1").filter({ hasText: "建议内容" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "确认使用" })).toBeVisible();
  await expect(page.getByText("已产生结果")).toBeVisible();
});
