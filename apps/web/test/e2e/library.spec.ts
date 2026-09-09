import type { AssetViewModel } from "@digital/web-delivery/client";
import { expect, test } from "@playwright/test";

import { mockCataloguePage } from "./catalogue-fixture";

function asset(index: number): AssetViewModel {
  return {
    id: `content-${index}`,
    refreshTarget: { subjectId: `content-${index}` },
    title: `内容 ${index}`,
    cardComponent: "generic",
    detailComponent: "generic",
    available: true,
    classifications: [],
    relationships: [],
  };
}

test("视图偏好在返回首页和刷新后保留，显式链接可改选视图", async ({ page }) => {
  await mockCataloguePage(page, {
    configured: true,
    assets: [asset(1)],
    executions: [],
    automation: [],
  });
  await page.goto("/");
  await page.getByRole("button", { name: "切换为列表模式" }).click();
  await page
    .getByRole("button", { name: "查看 内容 1", exact: true })
    .dblclick();
  await expect(page).toHaveURL(/\/assets\/content-1$/);
  await page.getByTestId("sidebar-nav-home").click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("table")).toBeVisible();
  await page.goto("/?view=covers");
  await expect(
    page.getByRole("list", { name: "内容", exact: true }),
  ).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByRole("list", { name: "内容", exact: true }),
  ).toBeVisible();
});

test("长预览在屏幕内独立滚动，不推动页面", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 650 });
  await mockCataloguePage(page, {
    configured: true,
    assets: [1, 2].map((index) => ({
      ...asset(index),
      summary: "已有简介。".repeat(100),
    })),
    executions: [],
    automation: [],
  });
  await page.goto("/?view=list");
  const preview = page.getByRole("complementary", {
    name: "预览",
    exact: true,
  });
  await expect(preview).toBeVisible();
  const scrollArea = page.getByRole("region", {
    name: "预览内容",
    exact: true,
  });
  await expect(scrollArea).toBeVisible();
  const before = await page.evaluate(() => window.scrollY);
  await scrollArea.hover();
  await page.mouse.wheel(0, 1000);
  await expect
    .poll(() => scrollArea.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  const bounds = await preview.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
  await page.getByRole("button", { name: "查看 内容 2", exact: true }).click();
  await expect
    .poll(() => scrollArea.evaluate((element) => element.scrollTop))
    .toBe(0);
});

test("列表选择预览已有简介，方向键换项，回车和双击进入所选详情", async ({
  page,
}) => {
  await mockCataloguePage(page, {
    configured: true,
    assets: [
      { ...asset(1), summary: "第一项的已有简介" },
      { ...asset(2), summary: "第二项的已有简介" },
    ],
    executions: [],
    automation: [],
  });
  await page.goto("/?view=list");
  const second = page.getByRole("button", { name: "查看 内容 2", exact: true });
  await second.click();
  await expect(page).toHaveURL(/\/?\?view=list$/);
  const preview = page.getByRole("complementary", {
    name: "预览",
    exact: true,
  });
  await expect(preview).toContainText("第二项的已有简介");
  await second.press("ArrowUp");
  await expect(preview).toContainText("第一项的已有简介");
  const first = page.getByRole("button", { name: "查看 内容 1", exact: true });
  await expect(first).toBeFocused();
  await first.press("Enter");
  await expect(page).toHaveURL(/\/assets\/content-1$/);
  await page.goto("/?view=list");
  await second.dblclick();
  await expect(page).toHaveURL(/\/assets\/content-2$/);
});

test.describe("触屏列表", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("单次点按直接进入无外部身份内容的详情", async ({ page }) => {
    await mockCataloguePage(page, {
      configured: true,
      assets: [asset(1)],
      executions: [],
      automation: [],
    });
    await page.goto("/?view=list");
    await page.getByRole("button", { name: "查看 内容 1", exact: true }).tap();
    await expect(page).toHaveURL(/\/assets\/content-1$/);
    await expect(
      page.getByRole("heading", { name: "内容 1", level: 1, exact: true }),
    ).toBeVisible();
  });
});

test("初次失败可重试，续页失败保留内容且不自动反复请求", async ({ page }) => {
  let attempts = 0;
  let nextAttempts = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/catalogue*", async (route) => {
    const next = new URL(route.request().url()).searchParams.has("cursor");
    const failed = next ? ++nextAttempts === 1 : ++attempts === 1;
    await route.fulfill(
      failed
        ? { status: 503, json: { error: "暂不可用" } }
        : {
            json: {
              surface: "current-catalogue",
              configured: true,
              assets: next
                ? [asset(25)]
                : Array.from({ length: 24 }, (_, index) => asset(index + 1)),
              pagination: next ? {} : { nextCursor: "next" },
            },
          },
    );
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "暂时无法加载内容" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "查看 内容 1", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.getByRole("alert")).toHaveText("下一页未能加载");
  await expect(page.getByRole("button", { name: /^查看 内容 / })).toHaveCount(
    24,
  );
  await page.getByRole("button", { name: "切换为列表模式" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  expect(nextAttempts).toBe(1);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "查看 内容 25", exact: true }),
  ).toBeVisible();
  expect(nextAttempts).toBe(2);
  expect(errors).toEqual([]);
});

test("首页只读取当前内容，滚动续载后切换视图仍保留内容并在末尾停止", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/catalogue*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query.toString());
    await route.fulfill({
      json: {
        surface: "current-catalogue",
        configured: true,
        assets: query.has("cursor")
          ? [asset(25)]
          : Array.from({ length: 24 }, (_, index) => asset(index + 1)),
        pagination: query.has("cursor") ? {} : { nextCursor: "next-page" },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "查看 内容 1", exact: true }),
  ).toBeVisible();
  expect(requests[0]).toContain("surface=current-catalogue");
  await expect(
    page.getByRole("button", { name: "加载更多", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(
    page.getByRole("button", { name: "查看 内容 25", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "切换为列表模式" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "查看 内容 25", exact: true }),
  ).toHaveCount(1);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.getByText("已显示全部内容", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
});

test("搜索和类别改变查询范围，旧续页不会混入新结果，切换视图保留条件", async ({
  page,
}) => {
  let releaseOldPage: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    releaseOldPage = resolve;
  });
  await page.route("**/api/catalogue*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has("cursor")) await pending;
    await route.fulfill({
      json: {
        surface: "current-catalogue",
        configured: true,
        assets: query.has("q")
          ? [{ ...asset(99), title: "搜索结果" }]
          : query.has("cursor")
            ? [asset(25)]
            : Array.from({ length: 24 }, (_, index) => asset(index + 1)),
        pagination:
          query.has("cursor") || query.has("q")
            ? {}
            : { nextCursor: "old-page" },
        total: query.has("q") ? 1 : 25,
        categories: [{ id: "book", label: "书籍" }],
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "查看 内容 1", exact: true }),
  ).toBeVisible();
  const oldRequest = page.waitForRequest((request) =>
    request.url().includes("cursor=old-page"),
  );
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await oldRequest;
  await expect(page.getByRole("textbox", { name: "搜索内容" })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索内容" }).fill("林一");
  const newRequest = page.waitForRequest((request) =>
    request.url().includes("category=book"),
  );
  await page.getByRole("combobox", { name: "筛选内容" }).click();
  await page.getByRole("option", { name: "书籍", exact: true }).click();
  await newRequest;
  await expect(
    page.getByRole("button", { name: "查看 搜索结果" }),
  ).toBeVisible();
  releaseOldPage?.();
  await page.getByRole("button", { name: "切换为列表模式" }).click();
  await expect(page.getByRole("textbox", { name: "搜索内容" })).toHaveValue(
    "林一",
  );
  await expect(page.getByRole("combobox", { name: "筛选内容" })).toContainText(
    "书籍",
  );
  await expect(
    page.getByRole("button", { name: "查看 内容 25", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查看 搜索结果" }),
  ).toBeVisible();
});
