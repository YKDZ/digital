import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, expect, it, vi } from "vitest";

import { runProduct } from "../src/index.ts";
import { composeAssetRefresh } from "../src/runtime.ts";
import {
  disposePreparedCatalogueTemplate,
  preparedCatalogueRoot,
} from "./prepared-catalogue.ts";

afterAll(disposePreparedCatalogueTemplate);

it("后台轮询不接管本次启动后仍在等待来源的人工检查", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-live-scan-"));
  await mkdir(path.join(media, "RJ01668691"));
  await writeFile(path.join(media, "RJ01668691", "notes.txt"), "音声附带材料");
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  vi.stubGlobal("fetch", async (address: string) => {
    entered.resolve();
    await release.promise;
    return new Response(
      address.includes("ajax")
        ? JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "雨夜的来信",
              regist_date: "2025-01-02",
            },
          })
        : "<html></html>",
      {
        headers: {
          "content-type": address.includes("ajax")
            ? "application/json"
            : "text/html",
        },
      },
    );
  });
  const product = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: (application) => application },
  );
  let timer: (() => void) | undefined;
  let scan: Promise<unknown> | undefined;
  try {
    const application = product.result;
    await application.startAutomation({
      clock: {
        now: () => new Date(),
        setInterval(callback) {
          timer = callback;
          return "automation-timer";
        },
        clearInterval() {},
      },
    });
    const root = await application.workflow.observedRootRegistrations.create({
      displayName: "材料",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    let executionId = "";
    const scanning = application.workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
      onExecutionStarted(execution) {
        executionId = execution.id;
      },
    });
    scan = scanning.catch(() => undefined);
    await entered.promise;
    timer?.();
    await application.automation.settled();
    expect(await application.workflow.inspect(executionId)).toMatchObject({
      execution: { status: "running" },
    });
    release.resolve();
    expect((await scanning).execution.outcome).toBe("accepted");
    expect(await application.workflow.listCurrentCatalogue()).toHaveLength(1);
  } finally {
    release.resolve();
    await scan;
    await product.close();
    vi.unstubAllGlobals();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("竞争整理同一批材料只采用一个范围，同一确认的并发重试仍返回同一资产", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-local-race-"));
  await writeFile(path.join(media, "one.txt"), "第一项材料");
  await writeFile(path.join(media, "two.txt"), "第二项材料");
  const workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "两份整理",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const first = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["one.txt"],
    });
    const second = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["one.txt", "two.txt"],
    });
    const results = await Promise.allSettled([
      workflow.confirmLocalContent({ executionId: first.executionId }),
      workflow.confirmLocalContent({ executionId: second.executionId }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toMatchObject([
      { reason: { message: expect.stringContaining("材料已经归入内容") } },
    ]);
    const winner = results[0]?.status === "fulfilled" ? first : second;
    const repeated = await Promise.all([
      workflow.confirmLocalContent({ executionId: winner.executionId }),
      workflow.confirmLocalContent({ executionId: winner.executionId }),
    ]);
    expect(repeated.map((item) => item.content.entity.id)).toEqual([
      winner.content.entity.id,
      winner.content.entity.id,
    ]);
    expect(await workflow.listCurrentCatalogue()).toHaveLength(1);
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("分次采用修订范围时保留未处理材料，全部采用后关闭原提案", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-local-revised-"));
  const workflow = composeAssetRefresh(data, {});
  try {
    await writeFile(path.join(media, "one.txt"), "第一项");
    await writeFile(path.join(media, "two.txt"), "第二项");
    const root = await workflow.observedRootRegistrations.create({
      displayName: "材料",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: false,
    });
    const whole = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["one.txt", "two.txt"],
    });
    const first = await workflow.prepareLocalContent({
      executionId: whole.executionId,
      relativePaths: ["one.txt"],
    });
    await workflow.confirmLocalContent({ executionId: first.executionId });
    expect(
      (await workflow.listCurrentAttentionPage()).items.map(
        (item) => item.executionId,
      ),
    ).toContain(whole.executionId);
    const second = await workflow.prepareLocalContent({
      executionId: whole.executionId,
      relativePaths: ["two.txt"],
    });
    await workflow.confirmLocalContent({ executionId: second.executionId });
    expect((await workflow.listCurrentAttentionPage()).items).toEqual([]);
    expect(await workflow.listCurrentCatalogue()).toHaveLength(2);
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("人工将多个未识别文件确认为一项无来源内容，重复确认和重开保留同一资产", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-local-intake-"));
  await mkdir(path.join(media, "notes"));
  await writeFile(path.join(media, "notes", "one.txt"), "第一段记录");
  await writeFile(path.join(media, "notes", "two.txt"), "第二段记录");
  await writeFile(path.join(media, "unselected.txt"), "另一项未选择的材料");
  let workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "本地材料",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const review = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["notes/one.txt", "notes/two.txt"],
    });
    expect(review.status).toBe("proposed");
    expect(review.content.sourceAssociations).toEqual([]);
    expect(await workflow.listCurrentCatalogue()).toHaveLength(0);
    expect((await workflow.listCurrentAttentionPage()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executionId: review.executionId }),
      ]),
    );
    const saved = await workflow.confirmLocalContent({
      executionId: review.executionId,
    });
    expect(saved.status).toBe("accepted");
    expect(saved.content.entity.id).toBe(review.content.entity.id);
    expect(saved.content.artifactAssociations).toHaveLength(2);
    expect(saved.content.sourceAssociations).toEqual([]);
    expect((await workflow.listCurrentAttentionPage()).items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executionId: review.executionId }),
      ]),
    );
    expect(
      (await workflow.confirmLocalContent({ executionId: review.executionId }))
        .content.entity.id,
    ).toBe(saved.content.entity.id);
    await workflow.close();
    workflow = composeAssetRefresh(data, {});
    expect(
      (await workflow.confirmLocalContent({ executionId: review.executionId }))
        .content.entity.id,
    ).toBe(saved.content.entity.id);
    const contents = await workflow.listCurrentCatalogue();
    expect(contents).toHaveLength(1);
    expect(
      contents[0]?.locations
        .map((location) => path.basename(location.address))
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["one.txt", "two.txt"]);
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("损坏文件不能经人工确认绕过检查，其余文件可整理但变化后必须重新确认", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-local-partial-"));
  await writeFile(path.join(media, "broken.pdf"), "这不是有效 PDF");
  await writeFile(path.join(media, "notes.txt"), "原始记录");
  const workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "部分可用",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    await expect(
      workflow.prepareLocalContent({
        executionId: scan.execution.id,
        relativePaths: ["broken.pdf", "notes.txt"],
      }),
    ).rejects.toThrow(/文件.*检查|格式/u);
    expect(await workflow.listCurrentCatalogue()).toHaveLength(0);
    const review = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["notes.txt"],
    });
    await writeFile(path.join(media, "notes.txt"), "已经替换成另一份新记录");
    await expect(
      workflow.confirmLocalContent({ executionId: review.executionId }),
    ).rejects.toThrow("所选文件已变化");
    expect(await workflow.listCurrentCatalogue()).toHaveLength(0);
    const rescanned = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const updated = await workflow.prepareLocalContent({
      executionId: rescanned.execution.id,
      relativePaths: ["notes.txt"],
    });
    expect(
      (await workflow.confirmLocalContent({ executionId: updated.executionId }))
        .status,
    ).toBe("accepted");
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("人工名称与分类作为有归属的事实保存，不要求来源或格式自带标题", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(
    path.join(tmpdir(), "digital-local-description-"),
  );
  await writeFile(path.join(media, "notes.txt"), "手记正文");
  let workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "手记",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const review = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["notes.txt"],
      name: "林间手记",
      classification: "book",
    });
    expect(review.content.effectiveMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "林间手记",
          sourceIdentity: "user",
        }),
        expect.objectContaining({
          property: "asset.content-classification",
          value: "book",
          sourceIdentity: "user",
        }),
      ]),
    );
    const saved = await workflow.confirmLocalContent({
      executionId: review.executionId,
    });
    await workflow.close();
    workflow = composeAssetRefresh(data, {});
    const content = await workflow.inspectCurrentCatalogueSubject(
      saved.content.entity.id,
    );
    expect(content?.effectiveMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "林间手记",
          sourceIdentity: "user",
        }),
      ]),
    );
    expect(content?.sourceAssociations).toEqual([]);
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);
