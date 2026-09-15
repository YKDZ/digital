import { expect, test } from "@playwright/test";

import { mockCataloguePage, type CatalogueFixture } from "./catalogue-fixture";

const emptyCatalogue: CatalogueFixture = {
  configured: true,
  assets: [],
  executions: [],
  automation: [],
};

async function mockCatalogue(
  page: import("@playwright/test").Page,
  catalogue: CatalogueFixture = emptyCatalogue,
) {
  await mockCataloguePage(page, catalogue);
}

function frierenCatalogue(): CatalogueFixture {
  const episode = (
    workId: string,
    localPosition: number,
    continuousPosition: number,
  ) => ({
    assetId: `frieren-${continuousPosition}`,
    workId,
    title: `第 ${continuousPosition} 集`,
    localPosition,
    continuousPosition,
    available: true,
    officialPage: `https://bgm.tv/ep/${continuousPosition}`,
    actionTarget: { subjectId: `frieren-${continuousPosition}` },
  });
  const firstEpisodes = Array.from({ length: 28 }, (_, index) =>
    episode("frieren-work-1", index + 1, index + 1),
  );
  const secondEpisodes = Array.from({ length: 10 }, (_, index) =>
    episode("frieren-work-2", index + 1, index + 29),
  );
  return {
    ...emptyCatalogue,
    assets: [
      {
        id: "bangumi-series:frieren-work-1",
        component: "bangumi",
        title: "葬送的芙莉莲",
        works: [
          {
            id: "frieren-work-1",
            title: "葬送的芙莉莲",
            officialPage: "https://bgm.tv/subject/400602",
            episodes: firstEpisodes,
          },
          {
            id: "frieren-work-2",
            title: "葬送的芙莉莲 第二季",
            officialPage: "https://bgm.tv/subject/515759",
            episodes: secondEpisodes,
          },
        ],
        episodes: [...firstEpisodes, ...secondEpisodes],
      },
    ],
  };
}

test("剧集分组通过统一首页进入既有系列详情", async ({ page }) => {
  await mockCatalogue(page, frierenCatalogue());

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(
    page.getByRole("button", { name: "查看 葬送的芙莉莲" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "查看 葬送的芙莉莲" }).click();
  await expect(page).toHaveURL(/\/series\/bangumi-series%3Afrieren-work-1$/);
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`Bangumi ${viewport.name} detail navigates Works and targets the exact episode`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockCatalogue(page, frierenCatalogue());
    const seriesPath = "/series/bangumi-series%3Afrieren-work-1";
    const secondSeasonPath = `${seriesPath}?season=frieren-work-2`;
    await page.goto(secondSeasonPath, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("bangumi-detail")).toBeVisible();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(10);
    await page.reload();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(10);

    await page.goto(seriesPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(28);

    await page.getByRole("tab", { name: "葬送的芙莉莲 第二季" }).click();
    await expect(page).toHaveURL(secondSeasonPath);
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(10);
    await page.reload();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(10);
    await page.goBack();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(28);
    await page.goForward();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(10);
    await expect(page.getByText("本地可用")).toHaveCount(0);
    const episode29 = page
      .getByTestId("bangumi-episode-card")
      .filter({ hasText: "第 29 集" });
    await expect(episode29).toContainText("第 1 集");
    await expect(episode29).toHaveCount(1);
    await expect(episode29).toHaveAttribute("href", "/assets/frieren-29");

    await episode29.click();
    await expect(page).toHaveURL("/assets/frieren-29");
    await expect(page.getByTestId("bangumi-episode-detail")).toBeVisible();
    await expect(page.getByRole("heading", { name: "第 29 集" })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("bangumi-episode-detail")).toBeVisible();
    await expect(page.getByText("连续第 29 集")).toBeVisible();
    await expect(page.getByText("本地可用")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "返回葬送的芙莉莲 第二季" }),
    ).toHaveAttribute("href", secondSeasonPath);
    await page.getByRole("link", { name: "返回葬送的芙莉莲 第二季" }).click();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(10);
  });
}

test("添加内容用所选文件位置创建检查记录", async ({ page }) => {
  await mockCatalogue(page, {
    ...emptyCatalogue,
    observedRoots: [{ id: "work-root", displayName: "作品资料库" }],
  });
  let requestBody: unknown;
  await page.route("**/api/refresh", async (route) => {
    requestBody = await route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { id: "record-created" } });
  });

  await page.goto("/intake", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("检查文件，开始整理")).toBeVisible();
  await page.getByLabel("文件位置").click();
  await page.getByRole("option", { name: "作品资料库" }).click();
  await page.getByRole("button", { name: "检查文件" }).click();

  await expect(page.getByText("待整理的文件")).toBeVisible();
  expect(requestBody).toEqual({
    observedRootId: "work-root",
    relativeScope: ".",
  });
});

test("添加内容只提交文件位置身份和固定范围", async ({ page }) => {
  await mockCatalogue(page, {
    ...emptyCatalogue,
    observedRoots: [{ id: "audio-root", displayName: "音声资料库" }],
  });
  let requestBody: unknown;
  await page.route("**/api/refresh", async (route) => {
    requestBody = await route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { id: "root-scope-record" } });
  });

  await page.goto("/intake", { waitUntil: "domcontentloaded" });
  await page.getByLabel("文件位置").click();
  await page.getByRole("option", { name: "音声资料库" }).click();
  await page.getByRole("button", { name: "检查文件" }).click();

  expect(requestBody).toEqual({
    observedRootId: "audio-root",
    relativeScope: ".",
  });
  expect(JSON.stringify(requestBody)).not.toContain("directory");
});

test("添加内容失败时显示服务返回的错误", async ({ page }) => {
  await mockCatalogue(page, {
    ...emptyCatalogue,
    observedRoots: [{ id: "work-root", displayName: "作品资料库" }],
  });
  await page.route("**/api/refresh", (route) =>
    route.fulfill({ status: 400, json: { error: "请选择可用的文件位置" } }),
  );

  await page.goto("/intake", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("检查文件，开始整理")).toBeVisible();
  await page.getByLabel("文件位置").click();
  await page.getByRole("option", { name: "作品资料库" }).click();
  await page.getByRole("button", { name: "检查文件" }).click();

  await expect(page.getByRole("alert")).toContainText("请选择可用的文件位置");
});

test("Episode B 详情把精确刷新主体提交给 API，不提交当前来源基线", async ({
  page,
}) => {
  await mockCatalogue(page, {
    ...emptyCatalogue,
    assets: [
      {
        id: "episode-b",
        refreshTarget: { subjectId: "episode-b" },
        cardComponent: "generic",
        detailComponent: "generic",
        title: "Episode B",
        available: true,
        classifications: [],
        relationships: [],
      },
    ],
  });
  let requestBody: unknown;
  await page.route("**/api/refresh", async (route) => {
    requestBody = await route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      json: { id: "episode-b-rescrape" },
    });
  });

  await page.goto("/assets/episode-b", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "重新刮削" }).click();

  await expect(page.getByText("已创建刷新记录，正在处理。")).toBeVisible();
  expect(requestBody).toEqual({
    target: { subjectId: "episode-b" },
    operation: "rescrape",
  });
  expect(JSON.stringify(requestBody)).not.toContain("source");
  expect(JSON.stringify(requestBody)).not.toContain("directory");
});

test("刷新记录将各项结构化结果显示为中文", async ({ page }) => {
  await mockCatalogue(page, {
    ...emptyCatalogue,
    executions: [
      {
        id: "completed",
        folder: "完成",
        intent: "scan-now",
        status: "completed",
        outcome: "accepted",
        dispositions: [
          { key: "scan", status: "completed", output: "已产生结果" },
        ],
      },
      {
        id: "unchanged",
        folder: "无变化",
        intent: "scan-now",
        status: "completed",
        outcome: "no-change",
        dispositions: [{ key: "scan", status: "no-change" }],
      },
      {
        id: "failed",
        folder: "失败",
        intent: "scan-now",
        status: "failed",
        outcome: "failed",
        dispositions: [
          { key: "source", status: "failed", reason: "暂时无法连接" },
        ],
      },
      {
        id: "interrupted",
        folder: "中断",
        intent: "scan-now",
        status: "failed",
        outcome: "interrupted",
        dispositions: [],
      },
      {
        id: "reuse",
        folder: "复用",
        intent: "scan-now",
        status: "completed",
        dispositions: [
          { key: "old", status: "reused" },
          { key: "overlap", status: "skipped" },
        ],
      },
    ],
  });

  await page.goto("/inspection", { waitUntil: "domcontentloaded" });

  for (const label of [
    "已完成",
    "没有变化",
    "未完成",
    "已中断",
    "已复用",
    "已跳过",
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText("已产生结果")).toBeVisible();
});

function proposalCatalogue(
  previewStatus:
    | "awaiting-confirmation"
    | "rejected"
    | "applied"
    | "stale" = "awaiting-confirmation",
): CatalogueFixture {
  return {
    ...emptyCatalogue,
    executions: [
      {
        id: "proposal-record",
        folder: "建议内容",
        intent: "directed-recognition",
        status: "completed",
        outcome: "proposal",
        dispositions: [],
        preview: {
          id: "preview-1",
          status: previewStatus,
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
}

for (const result of [
  ["reject", "rejected", "不使用", "已保留当前内容。"],
  ["apply", "applied", "确认使用", "已使用建议内容。"],
  ["apply", "stale", "确认使用", "建议内容已经过期，请重新查看。"],
] as const) {
  test(`建议内容 ${result[1]} 时给出准确反馈`, async ({ page }) => {
    await mockCatalogue(page, proposalCatalogue());
    await page.route("**/api/preview", (route) =>
      route.fulfill({ json: { status: result[1] } }),
    );

    await page.goto("/inspection?record=proposal-record", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: result[2] }).click();

    await expect(page.getByRole("alert")).toContainText(result[3]);
  });
}

async function mockSettings(
  page: import("@playwright/test").Page,
  plans = true,
) {
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        configured: true,
        roots: [
          {
            id: "book-root",
            displayName: "已保存的文件夹",
            containerPath: "/media/books",
            status: "active",
            reachable: true,
            configVersion: 1,
            symlinkMode: "do-not-follow",
            allowedTargetRootIds: [],
          },
        ],
        sources: [],
        automation: plans
          ? [
              {
                id: "automation-1",
                folder: "已保存的文件夹",
                observedRootId: "book-root",
                relativeScope: ".",
                enabled: true,
                intervalMilliseconds: 3600000,
                acceptTrusted: true,
              },
            ]
          : [],
      },
    }),
  );
}

test("重新载入后仍显示已保存的自动刷新设置", async ({ page }) => {
  await mockSettings(page);

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "自动刷新", exact: true }).click();
  await expect(page.getByText("已保存的文件夹", { exact: true })).toBeVisible();
  await expect(page.getByText("整个文件位置 · 每小时")).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "自动刷新", exact: true }).click();
  await expect(page.getByText("已保存的文件夹", { exact: true })).toBeVisible();
});

test("新增自动刷新只提交文件位置身份和相对范围", async ({ page }) => {
  await mockSettings(page, false);
  let requestBody: unknown;
  await page.route("**/api/automation", async (route) => {
    requestBody = await route.request().postDataJSON();
    await route.fulfill({
      json: {
        initialStatus: "started",
        initialExecution: { id: "automation-root-scope-record" },
      },
    });
  });

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "自动刷新", exact: true }).click();
  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await page.getByLabel("范围（相对路径）").fill("轻小说");
  await page.getByRole("button", { name: "保存并启用" }).click();

  expect(requestBody).toEqual({
    action: "enable",
    observedRootId: "book-root",
    relativeScope: "轻小说",
    intervalMilliseconds: 3_600_000,
    acceptTrusted: true,
  });
  expect(JSON.stringify(requestBody)).not.toContain("directory");
});

test("立即刷新创建记录后提供详情链接", async ({ page }) => {
  await mockSettings(page);
  await page.route("**/api/automation", (route) =>
    route.fulfill({
      json: { status: "started", execution: { id: "record-now" } },
    }),
  );

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "自动刷新", exact: true }).click();
  await page.getByRole("button", { name: "立即检查" }).click();

  await expect(page.getByText("已开始刷新", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看刷新记录" }).click();
  await expect(page).toHaveURL(/\/inspection\?record=record-now$/);
});

test("重叠的立即刷新说明本次已跳过", async ({ page }) => {
  await mockSettings(page);
  await page.route("**/api/automation", (route) =>
    route.fulfill({ json: { status: "skipped" } }),
  );

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "自动刷新", exact: true }).click();
  await page.getByRole("button", { name: "立即检查" }).click();

  await expect(
    page.getByText("本次触发已跳过：当前仍有处理进行中。"),
  ).toBeVisible();
});

test("停用自动刷新明确保留正在进行的处理", async ({ page }) => {
  await mockSettings(page);
  await page.route("**/api/automation", (route) =>
    route.fulfill({ json: { status: "disabled" } }),
  );

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "自动刷新", exact: true }).click();
  await page.getByRole("switch").click();

  await expect(
    page.getByText("已停止后续自动刷新；正在进行的处理不会取消。"),
  ).toBeVisible();
});
