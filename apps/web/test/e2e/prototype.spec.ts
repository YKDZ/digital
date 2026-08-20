import { expect, test } from "@playwright/test";

const screens = [
  ["overview", "总览"],
  ["assets", "全部内容"],
  ["asset", "葬送的芙莉莲"],
  ["drop", "选择文件或文件夹"],
  ["inspection", "刷新记录"],
  ["attention", "需要处理"],
  ["automation", "自动刷新"],
  ["export", "整理与导出"],
  ["settings", "设置"],
] as const;

for (const [screen, heading] of screens) {
  test(`${screen} 桌面布局`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.goto(`/prototype?screen=${screen}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: heading }).first(),
    ).toBeVisible();

    const overflows = await page.locator("body").evaluate(() => ({
      horizontal:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      vertical:
        document.documentElement.scrollHeight >
        document.documentElement.clientHeight,
    }));
    expect(overflows.horizontal).toBe(false);
    expect(overflows.vertical).toBe(false);
    expect(errors).toEqual([]);
  });
}

test("移动端导航与详情页", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/prototype?screen=asset", {
    waitUntil: "domcontentloaded",
  });

  await expect(
    page.getByRole("heading", { name: "葬送的芙莉莲" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "切换侧栏" }).click();
  await expect(
    page.locator('[data-slot="sidebar"]').getByText("添加内容"),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("body")
        .evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
    )
    .toBe(true);
});

test("总览可以前往内容详情并刷新元数据", async ({ page }) => {
  await page.goto("/prototype", { waitUntil: "domcontentloaded" });
  await page
    .locator('[data-slot="card"]')
    .filter({ hasText: "葬送的芙莉莲" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "葬送的芙莉莲" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "刷新元数据" }).click();
  await expect(page.getByText("正在刷新元数据").first()).toBeVisible();
});

test("需要处理的建议可以采用", async ({ page }) => {
  await page.goto("/prototype?screen=attention", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "本次使用这个结果" }).click();
  await page.getByRole("button", { name: "确认使用" }).click();
  await expect(page.getByText("当前没有需要处理的问题")).toBeVisible();
});

test("整理与导出先预览再开始", async ({ page }) => {
  await page.goto("/prototype?screen=export", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "预览更改" }).click();
  await expect(page.getByRole("heading", { name: "导出预览" })).toBeVisible();
  await page.getByRole("button", { name: "开始导出" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "开始导出" })
    .click();
  await expect(page.getByRole("button", { name: "导出已开始" })).toBeVisible();
});
