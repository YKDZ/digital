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
    path.join(tmpdir(), "digital-disposable-completion-09-intake-browser-"),
  );
  const media = path.join(temporary, "media");
  const data = path.join(temporary, "data");
  await mkdir(path.join(media, "手记", "林间"), { recursive: true });
  await writeFile(path.join(media, "手记", "林间", "上.txt"), "上篇正文");
  await writeFile(path.join(media, "手记", "林间", "下.txt"), "下篇正文");
  await writeFile(path.join(media, "手记", "林间", "台本.pdf"), syntheticPdf());
  await writeFile(path.join(media, "另一份.txt"), "另一份观察");
  await writeFile(path.join(media, "损坏.pdf"), "损坏的文档");
  await prepareWebProductData(data);
  const product = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: createWebDelivery },
  );
  let passed = false;
  try {
    // 合法前置：接入区的可选目录来自资产库的活动目录，因此先按现行接口保存一个资产库。
    const initial = (await (
      await product.result.api.request("/settings")
    ).json()) as {
      readonly recognitionProfiles: readonly { readonly id: string }[];
      readonly librarySources: readonly { readonly id: string }[];
    };
    const created = await product.result.api.request("/settings/libraries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save",
        displayName: "本地手记",
        directories: [media],
        recognitionProfileIds: initial.recognitionProfiles.map(
          (profile) => profile.id,
        ),
        sourceIdentities: initial.librarySources.map((source) => source.id),
      }),
    });
    expect(created.status).toBe(200);
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
    // 服务端不替用户挑目录：先按产品给出的可选位置选定文件位置。
    const intakeOptions = (await (
      await product.result.api.request("/intake")
    ).json()) as {
      readonly roots: readonly { readonly displayName: string }[];
    };
    await page.getByLabel("文件位置").click();
    await page
      .getByRole("option", { name: intakeOptions.roots[0]!.displayName })
      .click();
    await page
      .locator("div.border-dashed")
      .getByRole("button", { name: "检查文件", exact: true })
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
    const group = page.getByRole("dialog");
    await expect(
      group.getByRole("heading", { name: "组成一项内容" }),
    ).toBeVisible();
    await group.getByLabel("名称", { exact: true }).fill("林间手记");
    await group.getByRole("button", { name: "完成整理", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "林间手记", exact: true }),
    ).toBeVisible();
    await page.reload();
    // 重开后仍由用户明确选择同一文件位置，读取已保存的整理预览；不再次检查或整理。
    await page.getByLabel("文件位置").click();
    await page
      .getByRole("option", { name: intakeOptions.roots[0]!.displayName })
      .click();
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
    await expect(page.getByText("暂无封面", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("img", { name: "林间手记的封面", exact: true }),
    ).toHaveCount(0);
    const subjectId = decodeURIComponent(
      new URL(page.url()).pathname.split("/").at(-1) ?? "",
    );
    const detail = await page.evaluate(async (id) => {
      const response = await fetch(`/api/catalogue/${encodeURIComponent(id)}`);
      if (!response.ok)
        throw new Error(`Catalogue detail failed: ${response.status}`);
      return (await response.json()) as {
        asset: {
          cover?: string;
        };
      };
    }, subjectId);
    expect(detail.asset.cover).toBeUndefined();
    const catalogue = await page.evaluate(async () => {
      const response = await fetch("/api/catalogue");
      if (!response.ok) throw new Error(`Catalogue failed: ${response.status}`);
      return (await response.json()) as {
        assets: Array<{
          files?: Array<{
            name: string;
            revisionId?: string;
            image?: string;
          }>;
        }>;
      };
    });
    const pdf = catalogue.assets
      .flatMap((asset) => asset.files ?? [])
      .find((file) => file.name === "台本.pdf");
    expect(pdf).toEqual(
      expect.objectContaining({
        revisionId: expect.any(String),
        image: expect.stringMatching(/^\/api\/artifacts\//u),
      }),
    );
    const imageStatus = await page.evaluate(async (address) => {
      const response = await fetch(address!);
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
      };
    }, pdf?.image);
    expect(imageStatus).toEqual({ status: 200, contentType: "image/png" });
    await page.goto("/");
    await expect(page.getByText("林间手记", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("img", { name: "林间手记的封面", exact: true }),
    ).toHaveCount(0);
    passed = true;
  } finally {
    await product.close();
    if (passed) await rm(temporary, { recursive: true, force: true });
    else console.error(`保留失败现场：${temporary}`);
  }
});

function syntheticPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>",
  ];
  let source = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}
