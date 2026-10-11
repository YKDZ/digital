import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { expect, test } from "@playwright/test";

import { prepareWebProductData } from "../prepare-catalogue";

test("浏览器把文件位置保存到资产库，刷新后编辑、撤权并重连且默认没有自动刷新计划", async ({
  page,
}) => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-completion-09-settings-browser-"),
  );
  const media = path.join(temporary, "media");
  const notes = path.join(temporary, "notes");
  const data = path.join(temporary, "data");
  await mkdir(media);
  await mkdir(notes);
  await prepareWebProductData(data);
  const product = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: createWebDelivery },
  );
  let passed = false;
  try {
    // 浏览器 HTTP 边界转交正式产品，不替换应用、持久化或文件系统。
    await page.route(/\/api\//, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      url.pathname = url.pathname.replace(/^\/api/, "");
      const response = await product.result.api.request(url.toString(), {
        method: request.method(),
        headers: request.headers(),
        ...(request.postData() === null ? {} : { body: request.postData()! }),
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    });
    const snapshot = await product.result.api.request("/settings");
    const profileName = (
      (await snapshot.json()) as {
        readonly recognitionProfiles: readonly {
          readonly displayName: string;
        }[];
      }
    ).recognitionProfiles[0]!.displayName;

    await page.goto("/settings/automation");
    const emptyLibraries = page.locator("div.border-dashed");
    await expect(
      emptyLibraries.getByText("创建资产库，读取你整理好的内容"),
    ).toBeVisible();
    await emptyLibraries
      .getByRole("button", { name: "添加资产库", exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "添加资产库" }),
    ).toBeVisible();
    await dialog.getByLabel("名称").fill("浏览器真实文件夹");
    await dialog.getByLabel("实际资产目录").fill(media);
    await dialog
      .getByRole("group", { name: "资产类型" })
      .getByRole("checkbox", { name: profileName, exact: true })
      .check();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page
        .getByRole("main")
        .getByRole("link", { name: "浏览器真实文件夹", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(media, { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText(media, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.getByLabel("名称").fill("已修改名称");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page
        .getByRole("main")
        .getByRole("link", { name: "已修改名称", exact: true }),
    ).toBeVisible();

    // 撤权：从本资产库的目录清单里去掉这个位置，历史与目录身份仍保留待重连。
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.getByLabel("实际资产目录").fill(notes);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已从资产库移除")).toBeVisible();
    const reconnect = page.getByRole("button", {
      name: "重新连接",
      exact: true,
    });
    await expect(reconnect).toBeVisible();

    await reconnect.click();
    await expect(page.getByText("已从资产库移除")).toHaveCount(0);
    await expect(page.getByText(media, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "自动刷新", exact: true }).click();
    await expect(
      page.getByText("还没有自动刷新计划。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "添加计划", exact: true }).click();
    await expect(
      dialog.getByRole("heading", { name: "自动刷新计划" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "保存并启用" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("switch")).toBeChecked();

    await page.reload();
    await page.getByRole("button", { name: "自动刷新", exact: true }).click();
    await expect(page.getByRole("switch")).toBeChecked();
    await page.getByRole("switch").click();
    await expect(
      page.getByText("已停止后续自动刷新；正在进行的处理不会取消。"),
    ).toBeVisible();
    await expect(page.getByRole("switch")).not.toBeChecked();
    await page.reload();
    await page.getByRole("button", { name: "自动刷新", exact: true }).click();
    await expect(page.getByRole("switch")).not.toBeChecked();
    passed = true;
  } finally {
    await product.close();
    if (passed) await rm(temporary, { recursive: true, force: true });
    else console.error(`保留失败现场：${temporary}`);
  }
});

test("设置展示服务器资产库目录，保存失败不关闭表单，连接撤销后刷新仍显示最新状态", async ({
  page,
}) => {
  const sources = [
    {
      id: "tmdb",
      version: 1,
      credentialStatus: "configured",
      availability: "available",
    },
  ];
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        configured: true,
        productDataDirectory: "/data/digital",
        libraries: [
          {
            id: "library-1",
            displayName: "我的书籍",
            configVersion: 3,
            recognitionProfileIds: ["book"],
            sourceIdentities: [],
            directories: ["/media/books"],
            directoryViews: [
              {
                directoryId: "directory-1",
                observedRootId: "root-1",
                displayName: "books",
                containerPath: "/media/books",
                status: "active",
                reachable: true,
              },
            ],
          },
        ],
        recognitionProfiles: [{ id: "book", displayName: "书籍" }],
        librarySources: [],
        sources,
        automation: [],
        recovery: [],
      },
    }),
  );
  await page.route("**/api/settings/libraries", (route) =>
    route.fulfill({
      status: 400,
      json: { error: "文件位置必须是当前可读的目录" },
    }),
  );
  await page.route("**/api/settings/connections", async (route) => {
    sources[0] = {
      ...sources[0]!,
      version: 2,
      credentialStatus: "revoked",
      availability: "unavailable",
    };
    await route.fulfill({ json: sources[0] });
  });
  await page.goto("/settings/automation");
  await expect(page.getByText("/media/books", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加资产库", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称").fill("不存在的位置");
  await dialog.getByLabel("实际资产目录").fill("/missing");
  await dialog
    .getByRole("group", { name: "资产类型" })
    .getByRole("checkbox", { name: "书籍", exact: true })
    .check();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "文件位置必须是当前可读的目录",
  );
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "来源连接", exact: true }).click();
  await page.getByRole("button", { name: "断开", exact: true }).click();
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await expect(page.getByText("已断开", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "来源连接", exact: true }).click();
  await expect(page.getByText("已断开", { exact: true })).toBeVisible();
});
