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

import type { ObservedRootRegistrations } from "@digital/application";
import { runProduct, type ProductRun } from "@digital/composition";
import { createWebDelivery, type WebDelivery } from "@digital/web-delivery";
import { expect, it } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

/**
 * 本票的 Web 接缝：HTTP 交付负责当前内容，停用与重连由资产库推进。
 * 关联观察另沿既有公开登记操作设置窄链接范围；交付接口不增加登记能力。
 */
function webHandle(application: Parameters<typeof createWebDelivery>[0]) {
  return {
    ...createWebDelivery(application),
    workflow: application.workflow as typeof application.workflow & {
      readonly observedRootRegistrations: Pick<
        ObservedRootRegistrations,
        "get" | "update"
      >;
    },
  };
}

type WebProduct = ProductRun<ReturnType<typeof webHandle>>;

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

    await expect(refusedRefresh(product, root.id)).resolves.toMatchObject({
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
    const beforeDeactivation = await registrationState(product, root.id);
    expect(beforeDeactivation.status).toBe("active");
    await removeLibrary(product, root.libraryId);
    expect(await registrationState(product, root.id)).toMatchObject({
      status: "revoked",
      configVersion: beforeDeactivation.configVersion + 1,
    });

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
    accepted: { readonly id: string }[];
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
      (await relationshipRead(product)).accepted.map((item) => item.id),
    ).toEqual([assetId]);

    await removeLibrary(product, root.libraryId);

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
    const seedRoot = async (displayName: string, directory: string) => {
      const libraries = application.result.assetLibraries;
      const saved = await libraries.save({
        displayName,
        directories: [directory],
        recognitionProfileIds: libraries.recognitionProfiles.map(
          (profile) => profile.id,
        ),
        sourceIdentities: libraries.sources.map((source) => source.id),
      });
      return saved.rootIds[0]!;
    };
    const primaryRootId = await seedRoot("主要材料", primaryMedia);
    const initial = await application.result.scanObservedScope({
      registrationId: primaryRootId,
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
    const supportingRootId = await seedRoot("补充材料", supportingMedia);
    const association =
      await application.result.prepareObservedMaterialAssociation({
        targetAssetId: assetId,
        registrationId: supportingRootId,
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
      registrationId: primaryRootId,
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
    await removeLibrary(product, parentRoot.libraryId);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
    await removeLibrary(product, childRoot.libraryId);
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
  const unrelated = path.join(temporary, "unrelated");
  const unavailable = path.join(temporary, "media-unavailable");
  await mkdir(scoped, { recursive: true });
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(scoped, "book.txt"), "重连后需扫描");
  await prepareWebProductData(data);
  const product = productFor(data);
  let passed = false;
  try {
    // 撤权与重连都是本库目录的意图，因此这条库保留第二个目录：停用不会顺带移除整库。
    const [root] = await createLibraryRoots(product, {
      displayName: "本地内容",
      directories: [media, unrelated],
    });
    if (root === undefined) throw new Error("资产库目录未建立");
    const assetId = await admitManualContent(product, root.id, "sub/book.txt");

    await revokeDirectory(product, root);
    const revoked = await registrationState(product, root.id);
    expect(revoked.status).toBe("revoked");
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });

    // 位置当前读不出来时重连诚实失败：目录授权与物理位置都停在撤销状态，版本不推进。
    await rename(media, unavailable);
    await expect(reconnectDirectory(product, root)).rejects.toThrow(
      /当前可读/u,
    );
    expect(await registrationState(product, root.id)).toEqual(revoked);
    await rename(unavailable, media);

    await reconnectDirectory(product, root);
    expect(await registrationState(product, root.id)).toMatchObject({
      status: "active",
      configVersion: revoked.configVersion + 1,
    });
    // 重连接回的是同一目录身份与同一规范路径，没有新建位置。
    const [reconnectedView] = (
      await product.result.workflow.assetLibraries.directoryViews(
        root.libraryId,
      )
    ).filter((state) => state.directoryId === root.directoryId);
    expect(reconnectedView).toMatchObject({
      observedRootId: root.id,
      containerPath: media,
      status: "active",
    });
    // 只恢复 I/O 通路不足以重新确认材料：成员资格要等一次成功的完整观察。
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });
    const scan = await startRefresh(product, root.id);
    await expect
      .poll(async () => intakeExecution(product, root.id, scan.id))
      .toMatchObject({ execution: { status: "completed" } });
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
    passed = true;
  } finally {
    await product.close();
    if (passed) await rm(temporary, { recursive: true, force: true });
    else console.error(`09 成员资格失败数据保留：${temporary}`);
  }
}, 60_000);

it("invalidates a frozen target-root closure until its dependent root completes a new scan", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-current-authority-"),
  );
  const data = path.join(temporary, "data");
  const source = path.join(temporary, "source");
  const target = path.join(temporary, "target");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  // 材料直接放在依赖目录里：本例检验的是观察时冻结的「授权目标闭包」，它是目录范围级
  // 权威账目，不依赖某个文件真的穿过链接；目标授权一旦被撤，闭包就不再成立。
  await writeFile(path.join(target, "book.txt"), "冻结授权目标材料");
  await writeFile(path.join(source, "book.txt"), "冻结授权材料");
  await prepareWebProductData(data);
  const product = productFor(data);
  let passed = false;
  try {
    // 现行模型里链接目标只能是同一资产库本次所选的目录，因此授权目标与依赖根同库配置。
    const [targetRoot, sourceRoot] = await createLinkedLibraryRoots(product, {
      displayName: "冻结授权",
      directories: [target, source],
      directoryLinks: [
        {
          directory: source,
          symlinkMode: "follow-file-links",
          targetDirectories: [target],
        },
      ],
    });
    if (targetRoot === undefined || sourceRoot === undefined)
      throw new Error("链接库目录未建立");
    const assetId = await admitManualContent(
      product,
      sourceRoot.id,
      "book.txt",
    );

    // 目标目录被撤权：本库依赖闭包同步推进源目录授权代次，沿旧闭包冻结的位置立即退出。
    await revokeDirectory(product, targetRoot);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });
    await expect(
      product.result.api.request(`/catalogue/${assetId}`),
    ).resolves.toMatchObject({ status: 404 });

    const revoked = await registrationState(product, targetRoot.id);
    expect(revoked.status).toBe("revoked");
    // 重连回到同一规范路径的同一目录身份；闭包仍要等源目录完成一次新的授权观察。
    await reconnectDirectory(product, targetRoot);
    expect(await registrationState(product, targetRoot.id)).toMatchObject({
      status: "active",
      configVersion: revoked.configVersion + 1,
    });
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
    passed = true;
  } finally {
    await product.close();
    if (passed) await rm(temporary, { recursive: true, force: true });
    else console.error(`09 成员资格失败数据保留：${temporary}`);
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
  let passed = false;
  try {
    const initialRoot = await createRoot(product, initial);
    const assetId = await admitManualContent(
      product,
      initialRoot.id,
      "initial.txt",
    );
    const [targetRoot, sourceRoot] = await createLinkedLibraryRoots(product, {
      displayName: "关联授权",
      directories: [target, source],
      directoryLinks: [
        {
          directory: source,
          symlinkMode: "follow-file-links",
          targetDirectories: [target],
        },
      ],
    });
    if (targetRoot === undefined || sourceRoot === undefined)
      throw new Error("链接库目录未建立");
    // 关联检查沿目录登记的权威解析跟链范围（它不带库语境），因此这里同时把源目录的
    // 登记更新为「跟随文件链接、允许目标为该目标目录」：库授权供扫描恢复使用，
    // 登记闭包供关联观察使用，两条路径各自取得同一条 S→T 授权，都不是默认全授权。
    const restoreSourceLink = async () => {
      const libraries = product.result.workflow.assetLibraries;
      const library = await libraries.get(sourceRoot.libraryId);
      if (library === undefined) throw new Error("链接库不存在或已移除");
      await libraries.save({
        id: library.id,
        expectedVersion: library.configVersion,
        displayName: library.displayName,
        directories: [target, source],
        directoryLinks: [
          {
            directory: source,
            symlinkMode: "follow-file-links",
            targetDirectories: [target],
          },
        ],
        recognitionProfileIds: library.recognitionProfileIds,
        sourceIdentities: library.sourceIdentities,
      });
    };
    const sourceRegistration =
      await product.result.workflow.observedRootRegistrations.get(
        sourceRoot.id,
      );
    if (sourceRegistration === undefined) throw new Error("源目录登记不存在");
    await product.result.workflow.observedRootRegistrations.update({
      id: sourceRoot.id,
      expectedVersion: sourceRegistration.configVersion,
      displayName: sourceRegistration.displayName,
      readOnly: true,
      symlinkMode: "follow-file-links",
      allowedTargetRootIds: [targetRoot.id],
    });
    const prepared = await post(
      product.result.api,
      "/observed-material-associations",
      {
        targetAssetId: assetId,
        registrationId: sourceRoot.id,
        relativeScope: ".",
        relativePaths: ["linked.txt"],
        initiatedBy: "current-catalogue-test",
      },
    );
    const started = await prepared.json();
    if (prepared.status !== 202)
      throw new Error(
        `观察材料关联未受理（${prepared.status}）：${JSON.stringify(started)}`,
      );
    const association = async () =>
      await (
        await product.result.api.request(
          `/observed-material-associations/${started.id}`,
        )
      ).json();
    /** 关联失败要把产品给的原因原样带出来，否则无法区分授权冲突与其它首因。 */
    const awaitAssociation = async (expected: string) =>
      await expect
        .poll(async () => {
          const state = await association();
          if (state.status === "failed")
            throw new Error(`观察材料关联失败：${JSON.stringify(state)}`);
          return state.status as string;
        })
        .toBe(expected);
    await awaitAssociation("awaiting-confirmation");
    const confirmed = await post(
      product.result.api,
      `/observed-material-associations/${started.id}/confirm`,
      { confirmedBy: "current-catalogue-test" },
    );
    expect(confirmed.status).toBe(202);
    await awaitAssociation("accepted");

    // 关联把材料接到本库这条闭包上之后，初始位置整库停用仍保留同一身份。
    await removeLibrary(product, initialRoot.libraryId);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: assetId })],
    });
    // 撤权链接目标：闭包整体退出，即使源目录仍在库里。
    await revokeDirectory(product, targetRoot);
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });

    const revoked = await registrationState(product, targetRoot.id);
    expect(revoked.status).toBe("revoked");
    await reconnectDirectory(product, targetRoot);
    expect(await registrationState(product, targetRoot.id)).toMatchObject({
      status: "active",
      configVersion: revoked.configVersion + 1,
    });
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });

    // 重连目标只恢复其目录身份，不恢复撤权时已删除的 S→T 链接；显式重新授权后再观察。
    await restoreSourceLink();
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

    await revokeDirectory(product, targetRoot);
    const again = await registrationState(product, targetRoot.id);
    expect(again.status).toBe("revoked");
    await reconnectDirectory(product, targetRoot);
    await restoreSourceLink();
    await rename(source, `${source}-unavailable`);
    await expect(refusedRefresh(product, sourceRoot.id)).resolves.toMatchObject(
      {
        error: expect.stringMatching(/文件位置.*(缺失|不可读|越界)/u),
      },
    );
    await expect(currentCatalogue(product)).resolves.toMatchObject({
      assets: [],
    });
    passed = true;
  } finally {
    await product.close();
    if (passed) await rm(temporary, { recursive: true, force: true });
    else console.error(`09 成员资格失败数据保留：${temporary}`);
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
    { start: webHandle },
  );
}

/** 一条实际资产目录经现行库入口取得自己的观察根身份。 */
type LibraryRoot = {
  readonly id: string;
  readonly libraryId: string;
  readonly directoryId: string;
};

type DirectoryLink = {
  readonly directory: string;
  readonly symlinkMode:
    | "do-not-follow"
    | "follow-file-links"
    | "follow-file-and-directory-links";
  readonly targetDirectories: readonly string[];
};

async function librarySettings(product: WebProduct) {
  const settings = (await (
    await product.result.api.request("/settings")
  ).json()) as {
    recognitionProfiles: { id: string }[];
    librarySources: { id: string }[];
  };
  return {
    recognitionProfileIds: settings.recognitionProfiles.map(
      (profile) => profile.id,
    ),
    sourceIdentities: settings.librarySources.map((source) => source.id),
  };
}

async function createLibraryRoots(
  product: WebProduct,
  input: {
    readonly displayName: string;
    readonly directories: readonly string[];
  },
): Promise<readonly LibraryRoot[]> {
  const selection = await librarySettings(product);
  const response = await post(product.result.api, "/settings/libraries", {
    action: "save",
    displayName: input.displayName,
    directories: [...input.directories],
    ...selection,
  });
  expect(response.status).toBe(200);
  const library = (await response.json()) as { id: string; rootIds: string[] };
  expect(library.rootIds).toHaveLength(input.directories.length);
  const snapshot = (await (
    await product.result.api.request("/settings")
  ).json()) as {
    libraries: {
      id: string;
      directoryViews: {
        directoryId: string;
        observedRootId: string;
        containerPath: string;
      }[];
    }[];
  };
  const views =
    snapshot.libraries.find((candidate) => candidate.id === library.id)
      ?.directoryViews ?? [];
  return input.directories.map((directory) => {
    const view = views.find(
      (candidate) => candidate.containerPath === directory,
    );
    if (view === undefined) throw new Error("资产库目录未投影出目录身份");
    return {
      id: view.observedRootId,
      libraryId: library.id,
      directoryId: view.directoryId,
    };
  });
}

/**
 * 链接范围只在同一库内声明：目标必须是本次所选目录，因此一个库借不到另一个库的位置。
 * 该意图由资产库的公开配置操作建立，HTTP 设置交付不暴露链接策略字段。
 */
async function createLinkedLibraryRoots(
  product: WebProduct,
  input: {
    readonly displayName: string;
    readonly directories: readonly string[];
    readonly directoryLinks: readonly DirectoryLink[];
  },
): Promise<readonly LibraryRoot[]> {
  const selection = await librarySettings(product);
  const libraries = product.result.workflow.assetLibraries;
  const saved = await libraries.save({
    displayName: input.displayName,
    directories: [...input.directories],
    directoryLinks: input.directoryLinks,
    ...selection,
  });
  const views = await libraries.directoryViews(saved.id);
  return input.directories.map((directory) => {
    const view = views.find(
      (candidate) => candidate.containerPath === directory,
    );
    if (view === undefined) throw new Error("链接库目录未投影出目录身份");
    return {
      id: view.observedRootId,
      libraryId: saved.id,
      directoryId: view.directoryId,
    };
  });
}

async function createRoot(
  product: WebProduct,
  media: string,
): Promise<LibraryRoot> {
  const [root] = await createLibraryRoots(product, {
    displayName: "本地内容",
    directories: [media],
  });
  if (root === undefined) throw new Error("资产库目录未建立");
  return root;
}

/** 本库该目录的当前授权账本；停用与重连都按这份版本推进。 */
async function registrationState(
  product: WebProduct,
  id: string,
): Promise<{ readonly configVersion: number; readonly status: string }> {
  const registration =
    await product.result.workflow.observedRootRegistrations.get(id);
  if (registration === undefined) throw new Error("文件位置记录不存在");
  return {
    configVersion: registration.configVersion,
    status: registration.status,
  };
}

async function startRefresh(
  product: WebProduct,
  rootId: string,
  relativeScope = ".",
) {
  const response = await post(product.result.api, "/refresh", {
    observedRootId: rootId,
    relativeScope,
  });
  const started = await response.json();
  if (response.status !== 201)
    throw new Error(
      `目录观察未受理（${response.status}）：${JSON.stringify(started)}`,
    );
  return started;
}

/**
 * 位置不可读时的诚实拒绝：交付层必须就地给出可懂原因，而不是受理一次后台扫描。
 * 与 startRefresh 分开，正项因此不会把错误响应误当成执行编号继续往下跑。
 */
async function refusedRefresh(product: WebProduct, rootId: string) {
  return await (
    await post(product.result.api, "/refresh", {
      observedRootId: rootId,
      relativeScope: ".",
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
  const prepared = await post(product.result.api, "/intake", {
    action: "prepare",
    executionId: scan.id,
    relativePaths: [relativePath],
    name: "本地内容",
    classification: "book",
  });
  const preview = await prepared.json();
  if (prepared.status !== 200)
    throw new Error(
      `人工内容预演未受理（${prepared.status}）：${JSON.stringify(preview)}`,
    );
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

/**
 * 现行模型里目录身份的停用与重连都属于资产库：观察根登记只是库投影出的物理位置账本，
 * 只要还有一处活动库引用它，登记接缝就诚实拒绝单独撤销。因此这里沿库意图推进：
 * 撤权=保存同一库但不再选择该目录；重连=点名保留下来的 removed 授权并对其权威版本做 CAS。
 */
async function revokeDirectory(
  product: WebProduct,
  root: LibraryRoot,
): Promise<void> {
  const libraries = product.result.workflow.assetLibraries;
  const library = await libraries.get(root.libraryId);
  if (library === undefined) throw new Error("资产库不存在或已移除");
  const remaining = (await libraries.directoryViews(library.id))
    .filter(
      (state) => state.status === "active" && state.observedRootId !== root.id,
    )
    .map((state) => state.containerPath);
  if (remaining.length === 0)
    throw new Error("该目录是本库唯一目录，停用需整库移除");
  await libraries.save({
    id: library.id,
    expectedVersion: library.configVersion,
    displayName: library.displayName,
    directories: remaining,
    recognitionProfileIds: library.recognitionProfileIds,
    sourceIdentities: library.sourceIdentities,
  });
}

/** 唯一目录的位置停用即整库移除：本库授权全部标 removed，末引用的物理根随之撤销。 */
async function removeLibrary(
  product: WebProduct,
  libraryId: string,
): Promise<void> {
  const libraries = product.result.workflow.assetLibraries;
  const library = await libraries.get(libraryId);
  if (library === undefined) throw new Error("资产库不存在或已移除");
  await libraries.remove({
    id: library.id,
    expectedVersion: library.configVersion,
  });
}

/**
 * 重连只把同一目录身份接回原规范路径，不新建位置，也不会自行恢复当前目录成员资格。
 */
async function reconnectDirectory(product: WebProduct, root: LibraryRoot) {
  const libraries = product.result.workflow.assetLibraries;
  const library = await libraries.get(root.libraryId);
  if (library === undefined) throw new Error("资产库不存在或已移除");
  const [state] = (await libraries.directoryViews(library.id)).filter(
    (candidate) => candidate.directoryId === root.directoryId,
  );
  if (state === undefined) throw new Error("该目录授权未保留，无法重连");
  return await libraries.reconnect({
    id: library.id,
    expectedVersion: library.configVersion,
    directoryId: state.directoryId,
    expectedAuthorityVersion: state.authorityVersion,
  });
}
