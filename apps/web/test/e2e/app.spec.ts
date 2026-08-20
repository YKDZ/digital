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
  // Vike can retain background browser requests after its interactive page is
  // ready; the visible UI assertions below are the actual readiness contract.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "全部内容" })).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "添加内容" }),
  ).toBeVisible();
});
