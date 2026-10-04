import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct, type ProductRun } from "@digital/composition";
import { createWebDelivery, type WebDelivery } from "@digital/web-delivery";
import { expect, it } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

type WebProduct = ProductRun<WebDelivery>;

it("removes an asset from the Web current catalogue after a successful scan confirms its only material is gone", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-catalogue-membership-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "local.txt"), "已确认的本地内容");
  await prepareWebProductData(data);
  let product: WebProduct | undefined = productFor(data);
  try {
    const root = await createRoot(product, media);
    await admitManualContent(product, root.id, "local.txt");
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ title: "本地内容" })],
    });

    await unlink(path.join(media, "local.txt"));
    const disappearanceScan = await startRefresh(product, root.id);
    await expect
      .poll(async () => intakeExecution(product, root.id, disappearanceScan.id))
      .toMatchObject({ execution: { status: "completed" } });

    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });
  } finally {
    await product?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("keeps current-catalogue membership when the registered location is temporarily unavailable", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-catalogue-membership-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  const unavailable = path.join(temporary, "media-unavailable");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "local.txt"), "已确认的本地内容");
  await prepareWebProductData(data);
  let product: WebProduct | undefined = productFor(data);
  try {
    const root = await createRoot(product, media);
    const assetId = await admitManualContent(product, root.id, "local.txt");
    await rename(media, unavailable);

    await expect(startRefresh(product, root.id)).resolves.toMatchObject({
      error: expect.stringMatching(/文件位置.*(缺失|不可读|越界)/u),
    });
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
  } finally {
    await product?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("removes a location's material from the Web current catalogue when the location is deactivated", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-catalogue-membership-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "local.txt"), "已确认的本地内容");
  await prepareWebProductData(data);
  let product: WebProduct | undefined = productFor(data);
  try {
    const root = await createRoot(product, media);
    const assetId = await admitManualContent(product, root.id, "local.txt");
    const settings = await (
      await product.result.api.request("/settings")
    ).json();
    const registration = settings.roots.find(
      (candidate: { readonly id: string }) => candidate.id === root.id,
    );
    const deactivation = await post(product.result.api, "/settings/roots", {
      action: "deactivate",
      id: root.id,
      expectedVersion: registration.configVersion,
    });
    expect(deactivation.status).toBe(200);

    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });
    await expect(
      product.result.api.request(`/catalogue/${assetId}`),
    ).resolves.toMatchObject({ status: 404 });
  } finally {
    await product?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("停用唯一观察根后关系 HTTP 与详情、当前目录一起退出已收录内容，人工关系历史在重开后仍可反查", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-relationship-http-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "local.txt"), "已确认的本地内容");
  await prepareWebProductData(data);
  let product: WebProduct | undefined = productFor(data);
  let seriesId = "";
  const relationshipRead = async (
    current: WebProduct,
  ): Promise<{
    accepted: { readonly entity: { readonly id: string } }[];
    relationships: { readonly type: string }[];
  }> =>
    await (
      await current.result.api.request(`/relationships/entities/${seriesId}`)
    ).json();
  try {
    const root = await createRoot(product, media);
    const assetId = await admitManualContent(product, root.id, "local.txt");
    seriesId = (
      await (
        await post(product.result.api, "/relationships/entities", {
          commitmentId: "membership-exit/series",
          label: "退出验证系列",
          actorId: "reader",
        })
      ).json()
    ).id as string;
    const preview = await (
      await post(product.result.api, "/relationships/preview", {
        changes: [
          {
            kind: "create",
            definitionId: "epub.series-membership",
            relationship: {
              type: "asset.membership",
              participants: [
                { entityId: assetId, role: "asset" },
                { entityId: seriesId, role: "series" },
              ],
              qualifiers: [{ key: "position", value: "1" }],
            },
          },
        ],
      })
    ).json();
    expect(
      (
        await post(product.result.api, "/relationships/apply", {
          actorId: "reader",
          preview,
        })
      ).status,
    ).toBe(200);

    // 停用前：详情、当前目录与关系 HTTP 对同一成员资格给出一致答案。
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
    expect(
      (await relationshipRead(product)).accepted.map(({ entity }) => entity.id),
    ).toEqual([assetId]);

    await deactivateRoot(product, root.id);

    // 停用后三面同时退出；关系历史没有被删除来换取一致性。
    await expect(
      product.result.api.request(`/catalogue/${assetId}`),
    ).resolves.toMatchObject({ status: 404 });
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });
    const exited = await relationshipRead(product);
    expect(exited.accepted).toEqual([]);
    expect(exited.relationships).toContainEqual(
      expect.objectContaining({ type: "asset.membership" }),
    );

    // 重开后判定不变。
    await product.close();
    product = productFor(data);
    const reopened = await relationshipRead(product);
    expect(reopened.accepted).toEqual([]);
    expect(reopened.relationships).toContainEqual(
      expect.objectContaining({ type: "asset.membership" }),
    );
  } finally {
    await product?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

it("keeps an asset in the Web current catalogue when another observed material remains current", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-catalogue-membership-"),
  );
  const data = path.join(temporary, "data");
  const primaryMedia = path.join(temporary, "primary");
  const supportingMedia = path.join(temporary, "supporting");
  await mkdir(primaryMedia, { recursive: true });
  await mkdir(supportingMedia, { recursive: true });
  await writeFile(path.join(primaryMedia, "local.txt"), "主要材料");
  await writeFile(path.join(supportingMedia, "appendix.txt"), "补充材料");
  await prepareWebProductData(data);
  let product: WebProduct | undefined;
  const application = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: (configured) => configured.workflow },
  );
  try {
    const primaryRoot =
      await application.result.observedRootRegistrations.create({
        displayName: "主要材料",
        containerPath: primaryMedia,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      });
    const initial = await application.result.scanObservedScope({
      registrationId: primaryRoot.id,
      relativeScope: ".",
      acceptTrusted: false,
    });
    const review = await application.result.prepareLocalContent({
      executionId: initial.execution.id,
      relativePaths: ["local.txt"],
      name: "本地内容",
      classification: "book",
    });
    const accepted = await application.result.confirmLocalContent({
      executionId: review.executionId,
    });
    const assetId = accepted.content.entity.id;
    const supportingRoot =
      await application.result.observedRootRegistrations.create({
        displayName: "补充材料",
        containerPath: supportingMedia,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      });
    const association =
      await application.result.prepareObservedMaterialAssociation({
        targetAssetId: assetId,
        registrationId: supportingRoot.id,
        relativeScope: ".",
        relativePaths: ["appendix.txt"],
        initiatedBy: "current-catalogue-test",
      });
    await application.result.confirmObservedMaterialAssociation({
      executionId: association.executionId,
      confirmedBy: "current-catalogue-test",
    });

    await unlink(path.join(primaryMedia, "local.txt"));
    await application.result.scanObservedScope({
      registrationId: primaryRoot.id,
      relativeScope: ".",
      acceptTrusted: false,
    });
    await application.close();
    product = productFor(data);

    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
  } finally {
    await application.close();
    await product?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("keeps independently scanned overlapping-root material until its last root is deactivated", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-overlap-"),
  );
  const data = path.join(temporary, "data");
  const parent = path.join(temporary, "media");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(child, "book.txt"), "独立位置支持");
  await prepareWebProductData(data);
  const product = productFor(data);
  try {
    const parentRoot = await createRoot(product, parent);
    const assetId = await admitManualContent(
      product,
      parentRoot.id,
      "child/book.txt",
    );
    const childRoot = await createRoot(product, child);
    const childScan = await startRefresh(product, childRoot.id);
    await expect
      .poll(async () => intakeExecution(product, childRoot.id, childScan.id))
      .toMatchObject({ execution: { status: "completed" } });
    await deactivateRoot(product, parentRoot.id);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
    await deactivateRoot(product, childRoot.id);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("requires a successful scan after reconnect before restoring current membership", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-reconnect-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  const scoped = path.join(media, "sub");
  const mounted = path.join(temporary, "mounted-media");
  await mkdir(scoped, { recursive: true });
  await writeFile(path.join(scoped, "book.txt"), "重连后需扫描");
  await prepareWebProductData(data);
  const product = productFor(data);
  try {
    const root = await createRoot(product, media);
    const assetId = await admitManualContent(product, root.id, "sub/book.txt");
    await deactivateRoot(product, root.id);
    await symlink(media, mounted);
    const revoked = await rootSettings(product, root.id);
    const reconnect = await post(product.result.api, "/settings/roots", {
      action: "reconnect",
      id: root.id,
      expectedVersion: revoked.configVersion,
      containerPath: mounted,
    });
    expect(reconnect.status).toBe(200);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });
    const scan = await startRefresh(product, root.id, "sub");
    await expect
      .poll(async () => intakeExecution(product, root.id, scan.id))
      .toMatchObject({ execution: { status: "completed" } });
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("invalidates a frozen target-root closure until its dependent root completes a new scan", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-authority-"),
  );
  const data = path.join(temporary, "data");
  const source = path.join(temporary, "source");
  const target = path.join(temporary, "target");
  const targetAlias = path.join(temporary, "target-alias");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "book.txt"), "冻结授权材料");
  await symlink(path.join(target, "book.txt"), path.join(source, "book.txt"));
  await prepareWebProductData(data);
  const product = productFor(data);
  try {
    const targetRoot = await (
      await post(product.result.api, "/settings/roots", {
        action: "create",
        displayName: "授权目标",
        containerPath: target,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      })
    ).json();
    const sourceRoot = await (
      await post(product.result.api, "/settings/roots", {
        action: "create",
        displayName: "依赖根",
        containerPath: source,
        symlinkMode: "follow-file-links",
        allowedTargetRootIds: [targetRoot.id],
      })
    ).json();
    const assetId = await admitManualContent(
      product,
      sourceRoot.id,
      "book.txt",
    );

    await deactivateRoot(product, targetRoot.id);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });

    await symlink(target, targetAlias);
    const revoked = await rootSettings(product, targetRoot.id);
    expect(
      (
        await post(product.result.api, "/settings/roots", {
          action: "reconnect",
          id: targetRoot.id,
          expectedVersion: revoked.configVersion,
          containerPath: targetAlias,
        })
      ).status,
    ).toBe(200);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });

    const scan = await startRefresh(product, sourceRoot.id);
    await expect
      .poll(async () => intakeExecution(product, sourceRoot.id, scan.id))
      .toMatchObject({ execution: { status: "completed" } });
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("uses an observed-material association's frozen target closure for current membership", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-material-authority-"),
  );
  const data = path.join(temporary, "data");
  const initial = path.join(temporary, "initial");
  const source = path.join(temporary, "source");
  const target = path.join(temporary, "target");
  const targetAlias = path.join(temporary, "target-alias");
  await mkdir(initial, { recursive: true });
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(initial, "initial.txt"), "初始材料");
  await writeFile(path.join(target, "linked.txt"), "授权链接材料");
  await symlink(
    path.join(target, "linked.txt"),
    path.join(source, "linked.txt"),
  );
  await prepareWebProductData(data);
  const product = productFor(data);
  try {
    const initialRoot = await createRoot(product, initial);
    const assetId = await admitManualContent(
      product,
      initialRoot.id,
      "initial.txt",
    );
    const targetRoot = await createConfiguredRoot(product, {
      displayName: "授权目标",
      containerPath: target,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const sourceRoot = await createConfiguredRoot(product, {
      displayName: "关联依赖根",
      containerPath: source,
      symlinkMode: "follow-file-links",
      allowedTargetRootIds: [targetRoot.id],
    });
    const prepared = await (
      await post(product.result.api, "/observed-material-associations", {
        targetAssetId: assetId,
        registrationId: sourceRoot.id,
        relativeScope: ".",
        relativePaths: ["linked.txt"],
        initiatedBy: "current-catalogue-test",
      })
    ).json();
    await expect
      .poll(async () =>
        (
          await product.result.api.request(
            `/observed-material-associations/${prepared.id}`,
          )
        ).json(),
      )
      .toMatchObject({ status: "awaiting-confirmation" });
    expect(
      (
        await post(
          product.result.api,
          `/observed-material-associations/${prepared.id}/confirm`,
          { confirmedBy: "current-catalogue-test" },
        )
      ).status,
    ).toBe(202);
    await expect
      .poll(async () =>
        (
          await product.result.api.request(
            `/observed-material-associations/${prepared.id}`,
          )
        ).json(),
      )
      .toMatchObject({ status: "accepted" });

    await deactivateRoot(product, initialRoot.id);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
    await deactivateRoot(product, targetRoot.id);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });

    await symlink(target, targetAlias);
    const revoked = await rootSettings(product, targetRoot.id);
    expect(
      (
        await post(product.result.api, "/settings/roots", {
          action: "reconnect",
          id: targetRoot.id,
          expectedVersion: revoked.configVersion,
          containerPath: targetAlias,
        })
      ).status,
    ).toBe(200);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });

    const scan = await startRefresh(product, sourceRoot.id);
    await expect
      .poll(async () => intakeExecution(product, sourceRoot.id, scan.id))
      .toMatchObject({ execution: { status: "completed" } });
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });

    await deactivateRoot(product, targetRoot.id);
    const again = await rootSettings(product, targetRoot.id);
    await expect(
      post(product.result.api, "/settings/roots", {
        action: "reconnect",
        id: targetRoot.id,
        expectedVersion: again.configVersion,
        containerPath: targetAlias,
      }),
    ).resolves.toMatchObject({ status: 200 });
    await rename(source, `${source}-unavailable`);
    await expect(startRefresh(product, sourceRoot.id)).resolves.toMatchObject({
      error: expect.any(String),
    });
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("keeps the last confirmed membership when a scan cannot complete", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-catalogue-incomplete-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  const outside = path.join(temporary, "outside.mkv");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "local.txt"), "已确认的本地内容");
  await writeFile(outside, "范围外内容");
  await prepareWebProductData(data);
  const product = productFor(data);
  try {
    const root = await createRoot(product, media);
    const assetId = await admitManualContent(product, root.id, "local.txt");

    await symlink(outside, path.join(media, "unfollowable.mkv"));
    const scan = await startRefresh(product, root.id);
    await expect
      .poll(async () => intakeExecution(product, root.id, scan.id))
      .toMatchObject({ execution: { status: "failed" } });

    // 无法完成的检查不是材料不存在，已确认身份与成员资格都保持。
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId, title: "本地内容" })],
    });
    await expect(
      product.result.api.request(`/catalogue/${assetId}`),
    ).resolves.toMatchObject({ status: 200 });
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("keeps pages, the search total, and a reopened database consistent as the middle material exits", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-catalogue-pagination-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  await mkdir(media, { recursive: true });
  const names = ["a.txt", "b.txt", "c.txt"] as const;
  for (const name of names)
    await writeFile(path.join(media, name), `已确认内容-${name}`);
  await prepareWebProductData(data);
  let product: WebProduct | undefined = productFor(data);
  try {
    const root = await createRoot(product, media);
    const admitted: string[] = [];
    for (const name of names)
      admitted.push(await admitManualContent(product, root.id, name));
    expect(await currentPageIds(product)).toHaveLength(3);
    expect(await currentSearchTotal(product)).toBe(3);

    await unlink(path.join(media, "b.txt"));
    const scan = await startRefresh(product, root.id);
    const beforeReopen = product;
    await expect
      .poll(async () => intakeExecution(beforeReopen, root.id, scan.id))
      .toMatchObject({ execution: { status: "completed" } });

    const survivor = admitted.find((id) => id !== admitted[1])!;
    const afterRemoval = await currentPageIds(product);
    expect(afterRemoval).toHaveLength(2);
    expect(afterRemoval).not.toContain(admitted[1]);
    expect(afterRemoval).toContain(survivor);
    expect(await currentSearchTotal(product)).toBe(2);
    await expect(
      product.result.api.request(`/catalogue/${admitted[1]}`),
    ).resolves.toMatchObject({ status: 404 });

    await product.close();
    product = productFor(data);
    expect(await currentPageIds(product)).toEqual(afterRemoval);
    expect(await currentSearchTotal(product)).toBe(2);
  } finally {
    await product?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

async function currentPageIds(product: WebProduct): Promise<readonly string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await (
      await product.result.api.request(
        `/catalogue?surface=current-catalogue&limit=1${
          cursor === undefined ? "" : `&cursor=${cursor}`
        }`,
      )
    ).json();
    for (const asset of page.assets) ids.push(asset.id as string);
    cursor = page.pagination?.nextCursor;
    if (cursor === undefined) return ids;
  }
}

async function currentSearchTotal(product: WebProduct): Promise<number> {
  const page = await (
    await product.result.api.request(
      "/catalogue?surface=current-catalogue&sort=recent&limit=1",
    )
  ).json();
  return page.total as number;
}

function productFor(data: string): WebProduct {
  return runProduct(
    { productDataDirectory: data, environment: {} },
    { start: createWebDelivery },
  );
}

async function createRoot(product: WebProduct, media: string) {
  return await createConfiguredRoot(product, {
    displayName: "本地内容",
    containerPath: media,
    symlinkMode: "do-not-follow",
    allowedTargetRootIds: [],
  });
}

async function createConfiguredRoot(
  product: WebProduct,
  input: {
    readonly displayName: string;
    readonly containerPath: string;
    readonly symlinkMode:
      | "do-not-follow"
      | "follow-file-links"
      | "follow-file-and-directory-links";
    readonly allowedTargetRootIds: readonly string[];
  },
) {
  return await (
    await post(product.result.api, "/settings/roots", {
      action: "create",
      ...input,
    })
  ).json();
}

async function startRefresh(
  product: WebProduct,
  rootId: string,
  relativeScope = ".",
) {
  return await (
    await post(product.result.api, "/refresh", {
      observedRootId: rootId,
      relativeScope,
    })
  ).json();
}

async function admitManualContent(
  product: WebProduct,
  rootId: string,
  relativePath: string,
): Promise<string> {
  const scan = await startRefresh(product, rootId);
  await expect
    .poll(async () => intakeExecution(product, rootId, scan.id))
    .toMatchObject({ execution: { status: "completed" } });
  const preview = await (
    await post(product.result.api, "/intake", {
      action: "prepare",
      executionId: scan.id,
      relativePaths: [relativePath],
      name: "本地内容",
      classification: "book",
    })
  ).json();
  const confirmation = await post(product.result.api, "/intake", {
    action: "confirm",
    executionId: preview.executionId,
  });
  expect(confirmation.status).toBe(200);
  return (await confirmation.json()).asset.id as string;
}

async function intakeExecution(
  product: WebProduct,
  rootId: string,
  executionId: string,
) {
  return await (
    await product.result.api.request(
      `/intake?rootId=${rootId}&executionId=${executionId}`,
    )
  ).json();
}

async function currentCatalogue(product: WebProduct) {
  return await (
    await product.result.api.request("/catalogue?surface=current-catalogue")
  ).json();
}

function post(api: WebDelivery["api"], route: string, body: object) {
  return Promise.resolve(
    api.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function rootSettings(product: WebProduct, id: string) {
  const settings = await (await product.result.api.request("/settings")).json();
  return settings.roots.find(
    (root: { readonly id: string }) => root.id === id,
  ) as { readonly configVersion: number };
}

async function deactivateRoot(product: WebProduct, id: string) {
  const root = await rootSettings(product, id);
  const response = await post(product.result.api, "/settings/roots", {
    action: "deactivate",
    id,
    expectedVersion: root.configVersion,
  });
  expect(response.status).toBe(200);
}
