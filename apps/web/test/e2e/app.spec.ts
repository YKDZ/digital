import { expect, test } from "@playwright/test";

test("serves formal routes as Simplified Chinese SSR documents", async ({
  request,
}) => {
  for (const path of ["/", "/intake"]) {
    const response = await request.get(path);

    expect(response.ok()).toBe(true);
    expect(await response.text()).toMatch(/<html lang="zh-CN">/u);
  }
});

test("renders the formal asset browser", async ({ page }) => {
  // Vike 可能在交互页面就绪后仍保留后台浏览器请求；下方可见 UI 断言才是真正的就绪契约。
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "全部内容" })).toBeVisible();
  await expect(
    page
      .locator('[data-sidebar="sidebar"]')
      .getByRole("link", { name: "添加内容" }),
  ).toBeVisible();
});
