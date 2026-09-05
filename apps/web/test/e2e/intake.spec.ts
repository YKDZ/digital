import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { test, expect } from "@playwright/test";

import { prepareWebProductData } from "../prepare-catalogue";

test("文件树整理真实材料为无身份内容，重开预览后添加并在首页和详情查看", async ({
  page,
}) => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-intake-browser-"),
  );
  const media = path.join(temporary, "media");
  const data = path.join(temporary, "data");
  await mkdir(path.join(media, "手记", "林间"), { recursive: true });
  await writeFile(path.join(media, "手记", "林间", "上.txt"), "上篇正文");
  await writeFile(path.join(media, "手记", "林间", "下.txt"), "下篇正文");
  await writeFile(path.join(media, "另一份.txt"), "另一份观察");
  await writeFile(path.join(media, "损坏.pdf"), "损坏的文档");
  await prepareWebProductData(data);
  const product = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: createWebDelivery },
  );
  try {
    await product.result.api.request("/settings/roots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create",
        displayName: "本地手记",
        containerPath: media,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      }),
    });
    // HTTP 请求交给完整产品，浏览器和真实 SQLite／文件系统之间没有领域替身。
    await page.route(/\/api\//u, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      url.pathname = url.pathname.replace(/^\/api/u, "");
      const response = await product.result.api.request(url.toString(), {
        method: request.method(),
        headers: request.headers(),
        ...(request.postData() === null ? {} : { body: request.postData()! }),
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    await page.goto("/intake");
    await page
      .getByRole("button", { name: "检查文件", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("checkbox", { name: "选择 损坏.pdf", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "选择文件夹 手记/林间", exact: true })
      .click();
    await page
      .getByRole("button", { name: "组成一项内容", exact: true })
      .click();
    await page.getByLabel("名称", { exact: true }).fill("林间手记");
    await page.getByRole("button", { name: "完成整理", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "林间手记", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "林间手记", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "添加 1 项内容", exact: true })
      .click();
    await expect(
      page.getByText("已添加", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "选择 另一份.txt", exact: true }),
    ).toBeEnabled();
    await page.getByRole("link", { name: "林间手记", exact: true }).click();
    await expect(page).toHaveURL(/\/assets\//u);
    await expect(
      page.getByRole("heading", { name: "林间手记", exact: true }),
    ).toBeVisible();
    await page.goto("/");
    await expect(page.getByText("林间手记", { exact: true })).toBeVisible();
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
