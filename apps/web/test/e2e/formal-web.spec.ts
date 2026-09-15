import { expect, test, type Page } from "@playwright/test";

import { mockCataloguePage } from "./catalogue-fixture";

async function mockCatalogueWithWideCover(page: Page) {
  await mockCataloguePage(page, {
    configured: true,
    assets: [
      {
        id: "wide-cover",
        title: "横幅封面样本",
        cover: "/covers/wide.svg",
        available: true,
        classifications: [],
        relationships: [],
      },
    ],
    executions: [],
    automation: [],
  });
  await page.route("**/covers/wide.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="320"><rect width="1200" height="320" fill="#2563eb"/></svg>',
    }),
  );
}

async function centerX(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box).not.toBeNull();
  return box!.x + box!.width / 2;
}

test("正式内容浏览使用可展开的侧栏导航", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "全部内容" })).toBeVisible();
  await expect(page.getByRole("button", { name: "切换侧栏" })).toHaveCount(1);
  await expect(
    page.locator('[data-sidebar="sidebar"]').getByRole("link", {
      name: "全部内容",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
    "data-state",
    "expanded",
  );
  await page.getByRole("button", { name: "切换侧栏" }).click();
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
    "data-state",
    "collapsed",
  );
  await expect
    .poll(
      async () =>
        (await page.getByTestId("sidebar-nav-home").boundingBox())?.width,
    )
    .toBeLessThanOrEqual(33);
  const logoCenter = await centerX(page, "sidebar-logo-mark");
  const intakeCenter = await centerX(page, "sidebar-intake-button");
  const homeCenter = await centerX(page, "sidebar-nav-home");
  expect(Math.abs(logoCenter - homeCenter)).toBeLessThanOrEqual(1);
  expect(Math.abs(intakeCenter - homeCenter)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "切换侧栏" }).click();
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
    "data-state",
    "expanded",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "切换侧栏" }).click();
  await expect(
    page.locator('[data-sidebar="sidebar"]').getByRole("link", {
      name: "设置",
    }),
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

test("正式内容浏览不把封面固定为纵向海报", async ({ page }) => {
  await mockCatalogueWithWideCover(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const coverImage = page.getByAltText(/的封面$/).first();
  await expect(coverImage).toBeVisible();
  await expect(coverImage).toHaveClass(/object-contain/);
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
  await expect(page.getByTestId("asset-cover")).not.toHaveClass(/aspect-/);
});

test("普通浏览和详情不重复显示正常的本地可用性", async ({ page }) => {
  await mockCataloguePage(page, {
    configured: true,
    assets: [
      {
        id: "available-asset",
        title: "正常内容",
        available: true,
        classifications: [],
        relationships: [],
      },
      {
        id: "unknown-asset",
        title: "状态尚未确认的内容",
        available: false,
        classifications: [],
        relationships: [],
      },
    ],
    executions: [],
    automation: [],
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("本地可用")).toHaveCount(0);
  await expect(page.getByText("本地状态未知")).toHaveCount(0);

  await page.getByRole("button", { name: "查看 状态尚未确认的内容" }).click();
  await expect(page).toHaveURL(/\/assets\/unknown-asset$/);
  await expect(
    page.getByRole("heading", { name: "状态尚未确认的内容" }),
  ).toBeVisible();
  await expect(page.getByText("本地可用")).toHaveCount(0);
  await expect(page.getByText("本地状态未知")).toHaveCount(0);
});

test("书籍从统一首页打开已有出版详情", async ({ page }) => {
  await mockCataloguePage(page, {
    configured: true,
    assets: [
      {
        id: "book-1",
        title: "幼女战记(1)",
        cardComponent: "book",
        detailComponent: "book",
        refreshTarget: { subjectId: "book-1" },
        available: true,
        classifications: [],
        relationships: [],
        officialPage: "https://example.test/book",
        sourceLabel: "国家图书馆",
        book: {
          title: "幼女战记(1)",
          cover: "/covers/book.svg",
          contributors: ["Carlo Zen 東條チカ"],
          isbn13: "9789864738281",
          publisher: "臺灣角川",
          publicationDate: "2017",
          language: "zh",
          format: "EPUB",
          files: [
            {
              name: "幼女战记(1).epub",
              format: "EPUB",
              byteLength: 2_621_440,
              downloadUrl: "/api/artifact-downloads/book-1/revision-1",
            },
          ],
        },
      },
    ],
    executions: [],
    automation: [],
  });
  await page.route("**/covers/book.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" />',
    }),
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("幼女战记(1)").first()).toBeVisible();
  await expect(page.getByText("Carlo Zen 東條チカ")).toBeVisible();
  await page.getByRole("button", { name: "查看 幼女战记(1)" }).click();
  await expect(page).toHaveURL(/\/assets\/book-1$/);
  await expect(
    page.getByRole("heading", { name: "幼女战记(1)" }),
  ).toBeVisible();
  await expect(page.getByText("出版信息")).toBeVisible();
  await expect(page.getByText("文件", { exact: true })).toBeVisible();
  await expect(page.getByText("2.5 MB")).toBeVisible();
  await expect(page.getByRole("link", { name: "下载原文件" })).toHaveAttribute(
    "href",
    "/api/artifact-downloads/book-1/revision-1",
  );
  await expect(page.getByRole("button", { name: "更多操作" })).toBeVisible();
  await expect(page.getByText("9789864738281")).toBeVisible();
  await expect(page.getByRole("link", { name: "国家图书馆" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
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

test("FANBOX 帖子分开展示随帖附件与本地文件树", async ({ page }) => {
  await mockCataloguePage(page, {
    configured: true,
    assets: [
      {
        id: "fanbox-post",
        title: "Movie | ひみつ",
        cardComponent: "fanbox",
        detailComponent: "fanbox",
        refreshTarget: { subjectId: "fanbox-post" },
        available: true,
        classifications: [],
        relationships: [],
        officialPage: "https://example.test/post",
        fileTree: [
          { name: "poster.jpg", format: "JPG", downloadUrl: "/files/poster" },
          {
            name: "video",
            children: [
              { name: "movie.mp4", format: "MP4", downloadUrl: "/files/movie" },
            ],
          },
        ],
        fanbox: {
          title: "Movie | ひみつ",
          publicationDateTime: "2024-03-07T22:55:32+09:00",
          creator: "Custom Udon",
          body: "帖子正文",
          hasOfficialCover: false,
          entitlement: "available",
          attachments: [
            { kind: "file", name: "Himitsu1-1.zip", byteLength: "1048576" },
          ],
        },
      },
    ],
    executions: [],
    automation: [],
  });

  await page.goto("/assets/fanbox-post", { waitUntil: "domcontentloaded" });

  await expect(
    page.getByRole("heading", { name: "Movie | ひみつ" }),
  ).toBeVisible();
  await expect(page.getByText("帖子正文")).toBeVisible();
  await expect(page.getByRole("heading", { name: "随帖附件" })).toBeVisible();
  await expect(page.getByText("Himitsu1-1.zip")).toBeVisible();
  await expect(page.getByRole("heading", { name: "本地内容" })).toBeVisible();
  await expect(page.getByText("video", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /movie\.mp4/u })).toHaveAttribute(
    "href",
    "/files/movie",
  );
  await expect(page.locator("video, audio")).toHaveCount(0);
});

test("影片从统一首页打开已有影视详情", async ({ page }) => {
  await mockCataloguePage(page, {
    configured: true,
    assets: [
      {
        id: "film-209764",
        title: "恐怖直播",
        cardComponent: "film",
        detailComponent: "film",
        refreshTarget: { subjectId: "film-209764" },
        cover: "/covers/film.svg",
        available: true,
        classifications: [],
        relationships: [],
        film: {
          title: "恐怖直播",
          cover: "/covers/film.svg",
          releaseDate: "2013-07-31",
          year: "2013",
          introduction: "一场无法停止的直播。",
          runtimeMinutes: "97",
          genres: ["惊悚", "犯罪"],
          directors: ["金秉祐"],
          cast: ["河正宇", "李璟荣"],
          ratings: [
            { label: "IMDb", value: "7.1/10" },
            { label: "烂番茄", value: "80%" },
          ],
          awards: "4 项获奖，13 项提名",
          boxOffice: "$4,133",
          sources: [
            {
              label: "TMDB",
              officialPage: "https://www.themoviedb.org/movie/209764",
            },
            {
              label: "OMDb",
            },
          ],
        },
      },
    ],
    executions: [],
    automation: [],
  });
  await page.route("**/covers/film.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#172554"/></svg>',
    }),
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByAltText("恐怖直播的封面")).toBeVisible();
  await page.getByRole("button", { name: "查看 恐怖直播" }).click();
  await expect(page).toHaveURL(/\/assets\/film-209764$/);

  await expect(page.getByTestId("film-detail")).toBeVisible();
  await expect(page.getByRole("heading", { name: "恐怖直播" })).toBeVisible();
  await expect(page.getByText("97 分钟")).toBeVisible();
  await expect(page.getByText("一场无法停止的直播。")).toBeVisible();
  await expect(page.getByText("河正宇")).toBeVisible();
  await expect(page.getByText("IMDb")).toBeVisible();
  await expect(page.getByRole("link", { name: /TMDB/ })).toBeVisible();
  await expect(page.getByText("OMDb", { exact: true })).toBeVisible();
  await expect(page.getByText("本地可用")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
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

test("添加内容和自动刷新使用清晰的中文操作", async ({ page }) => {
  await mockCataloguePage(page, {
    configured: true,
    assets: [],
    executions: [],
    automation: [],
    observedRoots: [{ id: "intake-root", displayName: "示例文件位置" }],
  });
  await page.goto("/intake", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "添加内容" })).toBeVisible();
  await expect(page.getByLabel("文件位置")).toBeVisible();
  await expect(page.getByText("检查文件，开始整理")).toBeVisible();
  await expect(
    page.locator("header").getByRole("button", { name: "检查文件" }),
  ).toBeVisible();

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "设置分类" }),
  ).toBeVisible();
});
