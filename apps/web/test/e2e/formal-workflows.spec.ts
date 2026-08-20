import { expect, test } from "@playwright/test";

type CatalogueFixture = {
  readonly configured: boolean;
  readonly assets: readonly unknown[];
  readonly executions: readonly unknown[];
  readonly automation: readonly unknown[];
  readonly observedRoots?: readonly {
    readonly id: string;
    readonly displayName: string;
  }[];
};

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
  await page.route("**/api/catalogue", (route) =>
    route.fulfill({ json: catalogue }),
  );
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

test("Bangumi browse renders one stable series card instead of 38 episode cards", async ({
  page,
}) => {
  await mockCatalogue(page, frierenCatalogue());

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("bangumi-card")).toHaveCount(1);
  await expect(page.getByText("38 集本地内容")).toBeVisible();
  await expect(page.getByTestId("bangumi-card")).toHaveAttribute(
    "href",
    "/series/bangumi-series%3Afrieren-work-1",
  );
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
    let requestBody: unknown;
    await page.route("**/api/refresh", async (route) => {
      requestBody = await route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        json: { id: "frieren-29-rescrape" },
      });
    });

    await page.goto("/series/bangumi-series%3Afrieren-work-1", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("bangumi-detail")).toBeVisible();
    await expect(page.getByTestId("bangumi-episode")).toHaveCount(28);

    await page.getByRole("tab", { name: "葬送的芙莉莲 第二季" }).click();
    await expect(page.getByTestId("bangumi-episode")).toHaveCount(10);
    await expect(page.getByText("本地可用")).toHaveCount(0);
    const episode29 = page
      .getByTestId("bangumi-episode")
      .filter({ hasText: "连续第 29 集" });
    await expect(episode29).toContainText("第 1 集");
    await expect(episode29.getByRole("link").first()).toHaveAttribute(
      "href",
      "/assets/frieren-29",
    );
    await episode29.getByRole("button", { name: "重新刮削" }).click();

    expect(requestBody).toEqual({
      target: { subjectId: "frieren-29" },
      operation: "rescrape",
    });

    await episode29.getByRole("link").first().click();
    await expect(page).toHaveURL("/assets/frieren-29");
    await expect(page.getByTestId("bangumi-episode-detail")).toBeVisible();
    await expect(page.getByRole("heading", { name: "第 29 集" })).toBeVisible();
    await expect(page.getByTestId("bangumi-episode")).toHaveCount(0);
    await expect(page.getByText("本地可用")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "返回葬送的芙莉莲 第二季" }),
    ).toHaveAttribute("href", "/series/bangumi-series%3Afrieren-work-1");
  });
}

test("添加内容成功后创建记录并链接详情", async ({ page }) => {
  await mockCatalogue(page, {
    ...emptyCatalogue,
    observedRoots: [{ id: "work-root", displayName: "作品资料库" }],
  });
  await page.route("**/api/refresh", (route) =>
    route.fulfill({ status: 201, json: { id: "record-created" } }),
  );

  await page.goto("/intake", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("还没有刷新记录。")).toBeVisible();
  await page.getByLabel("文件位置").click();
  await page.getByRole("option", { name: "作品资料库" }).click();
  await page.getByRole("button", { name: "开始处理" }).click();

  await expect(page.getByText("已创建刷新记录，正在处理。")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看刷新记录" }),
  ).toHaveAttribute("href", "/inspection?record=record-created");
});

test("添加内容只提交文件位置身份和相对范围", async ({ page }) => {
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
  await page.getByLabel("范围（相对路径）").fill("作品/RJ01668691");
  await page.getByRole("button", { name: "开始处理" }).click();

  expect(requestBody).toEqual({
    observedRootId: "audio-root",
    relativeScope: "作品/RJ01668691",
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
  await expect(page.getByText("还没有刷新记录。")).toBeVisible();
  await page.getByLabel("文件位置").click();
  await page.getByRole("option", { name: "作品资料库" }).click();
  await page.getByRole("button", { name: "开始处理" }).click();

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

const persistedAutomation: CatalogueFixture = {
  ...emptyCatalogue,
  automation: [
    {
      id: "automation-1",
      folder: "已保存的文件夹",
      enabled: true,
      intervalMilliseconds: 3_600_000,
      acceptTrusted: true,
    },
  ],
};

test("重新载入后仍显示已保存的自动刷新设置", async ({ page }) => {
  await mockCatalogue(page, persistedAutomation);

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("已保存的文件夹", { exact: true })).toBeVisible();
  await expect(page.getByText("已启用 · 每小时")).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("已保存的文件夹", { exact: true })).toBeVisible();
});

test("新增自动刷新只提交文件位置身份和相对范围", async ({ page }) => {
  await mockCatalogue(page, {
    ...emptyCatalogue,
    observedRoots: [{ id: "book-root", displayName: "书籍资料库" }],
  });
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
  await page.getByLabel("文件位置").click();
  await page.getByRole("option", { name: "书籍资料库" }).click();
  await page.getByLabel("范围（相对路径）").fill("轻小说");
  await page.getByRole("button", { name: "启用自动刷新" }).click();

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
  await mockCatalogue(page, persistedAutomation);
  await page.route("**/api/automation", (route) =>
    route.fulfill({
      json: { status: "started", execution: { id: "record-now" } },
    }),
  );

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "立即刷新" }).click();

  await expect(
    page.getByText("已完成立即刷新，可查看刷新记录。"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看刷新记录" }),
  ).toHaveAttribute("href", "/inspection?record=record-now");
});

test("重叠的立即刷新说明本次已跳过", async ({ page }) => {
  await mockCatalogue(page, persistedAutomation);
  await page.route("**/api/automation", (route) =>
    route.fulfill({ json: { status: "skipped" } }),
  );

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "立即刷新" }).click();

  await expect(
    page.getByText("本次触发已跳过：当前仍有处理进行中。"),
  ).toBeVisible();
});

test("停用自动刷新明确保留正在进行的处理", async ({ page }) => {
  await mockCatalogue(page, persistedAutomation);
  await page.route("**/api/automation", (route) =>
    route.fulfill({ json: { status: "disabled" } }),
  );

  await page.goto("/settings/automation", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "停用" }).click();

  await expect(
    page.getByText("已停止后续自动刷新；正在进行的处理不会取消。"),
  ).toBeVisible();
});
