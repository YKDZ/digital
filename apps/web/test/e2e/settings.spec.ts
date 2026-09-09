import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { test, expect } from "@playwright/test";

import { prepareWebProductData } from "../prepare-catalogue";

test("浏览器保存文件位置到真实产品数据，刷新后编辑并停用和重新连接", async ({
  page,
}) => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-settings-browser-"),
  );
  const media = path.join(temporary, "media");
  const data = path.join(temporary, "data");
  await mkdir(media);
  await prepareWebProductData(data);
  const product = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: createWebDelivery },
  );
  try {
    // 浏览器 HTTP 边界转交正式产品，不替换应用、持久化或文件系统。
    await page.route(/\/api\/(settings|automation)/, async (route) => {
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
    await page.goto("/settings/automation");
    await page.getByRole("button", { name: "添加位置", exact: true }).click();
    await page.getByLabel("名称", { exact: true }).fill("浏览器真实文件夹");
    await page.getByLabel("文件夹路径", { exact: true }).fill(media);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "浏览器真实文件夹" }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText(media, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByLabel("名称", { exact: true }).fill("已修改名称");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "已修改名称" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "停用位置", exact: true }).click();
    await expect(page.getByText("已停用", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重新连接", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "停用位置", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "自动刷新", exact: true }).click();
    await expect(
      page.getByText("还没有自动刷新计划。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "添加计划", exact: true }).click();
    await page.getByRole("button", { name: "保存并启用", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("switch")).toBeChecked();
    await page.getByRole("switch").click();
    await expect(page.getByRole("switch")).not.toBeChecked();
    await page.reload();
    await page.getByRole("button", { name: "自动刷新", exact: true }).click();
    await expect(page.getByRole("switch")).not.toBeChecked();
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("设置展示服务器文件位置，保存失败不关闭表单，连接撤销后刷新仍显示最新状态", async ({
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
        roots: [
          {
            id: "books",
            displayName: "我的书籍",
            containerPath: "/media/books",
            status: "active",
            configVersion: 1,
            reachable: true,
            symlinkMode: "do-not-follow",
            allowedTargetRootIds: [],
          },
        ],
        sources,
        automation: [],
      },
    }),
  );
  await page.route("**/api/settings/roots", (route) =>
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
  await page.getByRole("button", { name: "添加位置", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("不存在的位置");
  await page.getByLabel("文件夹路径", { exact: true }).fill("/missing");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "文件位置必须是当前可读的目录",
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "来源连接", exact: true }).click();
  await page.getByRole("button", { name: "断开", exact: true }).click();
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await expect(page.getByText("已断开", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "来源连接", exact: true }).click();
  await expect(page.getByText("已断开", { exact: true })).toBeVisible();
});
