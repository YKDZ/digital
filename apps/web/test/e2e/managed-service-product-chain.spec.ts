import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  asRecord,
  asRecords,
  confirmProductReady,
  loadHandoff,
  requestJson,
  type ManagedServiceHandoff,
} from "./support/managed-service.ts";

const repositoryRoot = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
);
const coverFile = path.join(
  repositoryRoot,
  "fixtures",
  "controlled-source-io",
  "responses",
  "dlsite-cover.png",
);
const libraryName = "受控夹具资产库";
const editedLibraryName = "受控夹具资产库已改名";
const unlistedProduct = "RJ01497788";

let handoff: ManagedServiceHandoff;
let assetSubjectId = "";

test.describe.configure({ mode: "serial" });

/** 侧栏也会列出同名的资产库链接，产品链路断言只盯设置面板里的那一行。 */
function settingsRegion(page: Page): Locator {
  return page.locator("main");
}

test.beforeAll(async () => {
  handoff = await loadHandoff();
});

test("受管理真实服务：浏览器从空白正式迁移起步，添加资产库、扫描并单独等待刷新工作流、改名后由同一服务读回并取回托管封面", async ({
  page,
}) => {
  test.setTimeout(540_000);
  await page.goto("/settings/automation");
  const ready = await confirmProductReady(page);
  expect(ready.status).toBe(200);

  // 请求只由正在提供页面的进程处理：产品数据根就是环境容器的数据根，
  // 而它显然不是测试进程自己起的实现。
  const before = asRecord(await requestJson(page, "/api/settings"));
  expect(before.productDataDirectory).toBe(handoff.productDataRoot);
  expect(handoff.run.pid).not.toBe(process.pid);
  expect(new URL(handoff.baseUrl).port).toBe(String(handoff.run.port));
  expect(asRecords(before.libraries)).toHaveLength(0);
  await expect(page.getByText("创建资产库，读取你整理好的内容")).toBeVisible();

  const voiceProfile = asRecords(before.recognitionProfiles).find(
    (profile) => profile.id === "dlsite-voice",
  );
  expect(voiceProfile).toBeDefined();
  const dlsiteSource = asRecords(before.librarySources).find(
    (source) => source.id === "dlsite",
  );
  expect(dlsiteSource).toBeDefined();

  await page
    .locator("div.border-dashed")
    .getByRole("button", { name: "添加资产库", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "添加资产库" }),
  ).toBeVisible();
  await dialog.getByLabel("名称", { exact: true }).fill(libraryName);
  await dialog.getByLabel("实际资产目录").fill(handoff.materialDirectory);
  const profileCheckbox = dialog
    .getByRole("group", { name: "资产类型" })
    .getByRole("checkbox", {
      name: String(voiceProfile!.displayName),
      exact: true,
    });
  await profileCheckbox.check();
  await expect(profileCheckbox).toBeChecked();
  await expect(
    dialog.getByRole("group", { name: "资料来源" }).getByRole("checkbox", {
      name: String(dlsiteSource!.displayName),
      exact: true,
    }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("资产库已保存")).toBeVisible();
  await expect(
    settingsRegion(page).getByRole("link", {
      name: libraryName,
      exact: true,
    }),
  ).toBeVisible();

  const savedSnapshot = asRecord(await requestJson(page, "/api/settings"));
  const savedLibrary = asRecords(savedSnapshot.libraries).find(
    (library) => library.displayName === libraryName,
  );
  expect(savedLibrary).toBeDefined();
  const libraryId = String(savedLibrary!.id);
  const directories = asRecords(savedLibrary!.directoryViews);
  expect(directories[0]!.containerPath).toBe(handoff.materialDirectory);
  const observedRootId = String(directories[0]!.observedRootId);

  // 资产刷新工作流由浏览器发起，其结果单独等待，不与就绪或页面可见混为一谈。
  const [refreshResponse] = await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/refresh",
    ),
    page.getByRole("button", { name: "扫描", exact: true }).click(),
  ]);
  const execution = asRecord(await refreshResponse.json());
  const executionId = String(execution.id);
  expect(executionId.length).toBeGreaterThan(0);
  await expect(page.getByText("已开始扫描资产库")).toBeVisible();

  await expect
    .poll(
      async () =>
        String(
          asRecord(await requestJson(page, `/api/executions/${executionId}`))
            .status,
        ),
      { timeout: 300_000 },
    )
    .toBe("completed");
  expect(
    asRecord(await requestJson(page, `/api/executions/${executionId}`)).outcome,
  ).toBe("accepted");

  const intake = asRecord(
    await requestJson(
      page,
      `/api/intake?rootId=${encodeURIComponent(observedRootId)}`,
    ),
  );
  const files = asRecords(intake.files);
  expect(files.length).toBeGreaterThan(0);
  const assetIds = files[0]!.assetIds;
  expect(Array.isArray(assetIds)).toBe(true);
  assetSubjectId = String((assetIds as unknown[])[0]);
  expect(assetSubjectId).toMatch(/^entity_/u);

  const subject = asRecord(
    await requestJson(page, `/api/correction-subjects/${assetSubjectId}`),
  );
  expect(subject.recognitionState).toBe("recognized");
  expect(JSON.stringify(subject.current)).toContain("RJ01668691");

  const cover = await readFile(coverFile);
  const coverDigest = createHash("sha256").update(cover).digest("hex");

  // 托管封面地址由同一服务在详情投影里给出，指向该产品自己按内容摘要服务的字节。
  await expect
    .poll(
      async () => {
        const detail = asRecord(
          await requestJson(
            page,
            `/api/catalogue/${encodeURIComponent(assetSubjectId)}?library=${encodeURIComponent(libraryId)}`,
          ),
        );
        const address = asRecord(detail.asset).cover;
        return typeof address === "string" ? address : "";
      },
      { timeout: 180_000 },
    )
    .toBe(`/api/artifacts/${coverDigest}`);

  // 内容网格在浏览器里挂载后向同一服务取目录；卡片是产品自己的按钮，导航也走真实路由。
  await page.goto(`/?library=${encodeURIComponent(libraryId)}`);
  const assetCard = page
    .getByRole("list", { name: "内容" })
    .getByRole("button", { name: /^查看 /u });
  await expect(assetCard).toHaveCount(1);
  await assetCard.click();
  await expect
    .poll(() => page.url())
    .toContain(`/assets/${encodeURIComponent(assetSubjectId)}`);
  const coverImage = page.locator(`img[src*="${coverDigest}"]`);
  await expect(coverImage.first()).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate((digest) => {
        const image = document.querySelector<HTMLImageElement>(
          `img[src*="${digest}"]`,
        );
        return image?.naturalWidth ?? 0;
      }, coverDigest),
    )
    .toBeGreaterThan(0);

  const artifact = await fetch(
    new URL(`/api/artifacts/${coverDigest}`, handoff.baseUrl),
  );
  expect(artifact.status).toBe(200);
  expect(artifact.headers.get("content-type")).toBe("image/png");
  await expect(artifact.bytes()).resolves.toEqual(cover);

  await page.goto("/settings/automation");
  await settingsRegion(page)
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const editDialog = page.getByRole("dialog");
  await expect(
    editDialog.getByRole("heading", { name: "编辑资产库" }),
  ).toBeVisible();
  await editDialog.getByLabel("名称", { exact: true }).fill(editedLibraryName);
  await editDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    settingsRegion(page).getByRole("link", {
      name: editedLibraryName,
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    settingsRegion(page).getByRole("link", {
      name: editedLibraryName,
      exact: true,
    }),
  ).toBeVisible();
  const editedSnapshot = asRecord(await requestJson(page, "/api/settings"));
  const editedLibrary = asRecords(editedSnapshot.libraries).find(
    (library) => library.id === libraryId,
  );
  expect(editedLibrary?.displayName).toBe(editedLibraryName);
});

test("受管理真实服务：未列入受控清单的外部请求在产品进程内明确失败，不回退真实网络", async ({
  page,
}) => {
  test.setTimeout(300_000);
  expect(assetSubjectId).toMatch(/^entity_/u);
  await page.goto("/settings/automation");
  await confirmProductReady(page);

  const startedAt = Date.now();
  const refused = asRecord(
    await requestJson(page, "/api/source-enrichments", {
      method: "POST",
      body: JSON.stringify({
        subjectId: assetSubjectId,
        sourceIdentity: "dlsite",
        sourceInput: { product: unlistedProduct },
      }),
    }),
  );
  const enrichmentId = String(refused.id);
  await expect
    .poll(
      async () =>
        String(
          asRecord(
            await requestJson(page, `/api/source-enrichments/${enrichmentId}`),
          ).status,
        ),
      { timeout: 240_000 },
    )
    .toBe("failed");
  const view = JSON.stringify(
    asRecord(
      await requestJson(page, `/api/source-enrichments/${enrichmentId}`),
    ),
  );
  // 交付视图给出清楚的业务失败原因，但不带内部拒绝诊断里的边界标识与请求键。
  expect(view).toContain("无法取得");
  expect(view).not.toContain("受控来源拒绝");
  expect(view).not.toContain("请求键");
  expect(view).not.toContain("ordinary-request");

  // 调用方以受控来源模式准备了这个环境；产品把“受控来源拒绝”的唯一业务改写
  // 就是这句“外部来源内容尚未在当前环境准备”，它只在内部原因含拒绝标记时出现。
  expect(handoff.sourceMode).toBe("controlled");
  expect(existsSync(handoff.manifestPath)).toBe(true);
  expect(view).toContain("外部来源内容尚未在当前环境准备");

  // 真实网络回退会留下解析或连接错误；产品运行日志里一个都没有，并且拒绝是即时给出的。
  expect(handoff.productLogFile).toBeTruthy();
  const log = await readFile(String(handoff.productLogFile), "utf8");
  expect(log).not.toMatch(
    /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|proxy|https?:\/\/(?!127\.0\.0\.1|localhost)/u,
  );
  expect(Date.now() - startedAt).toBeLessThan(120_000);
});
