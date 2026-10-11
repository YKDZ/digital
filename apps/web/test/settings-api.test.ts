import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ObservedRootRegistrations } from "@digital/application";
import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { expect, it, vi } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

type DirectoryView = {
  id: string;
  displayName: string;
  configVersion: number;
  directories: string[];
  directoryViews: {
    directoryId: string;
    observedRootId: string;
    displayName: string;
    containerPath: string;
    status: string;
    reachable: boolean;
    problem?: string;
  }[];
};

const profileIds = (profiles: { id: string }[]): string[] =>
  profiles.map((profile) => profile.id);
const sourceIds = (sources: { id: string }[]): string[] =>
  sources.map((source) => source.id);

it("设置保存真实文件位置到资产库，拒绝冲突路径，撤权后可重新连接且不默认开启自动刷新", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-settings-test-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  const notes = path.join(temporary, "notes");
  await mkdir(media);
  await mkdir(notes);
  await prepareWebProductData(data);
  const product = runProduct(
    { productDataDirectory: data, environment: {} },
    {
      start: (application) => ({
        api: createWebDelivery(application).api,
        workflow: application.workflow as typeof application.workflow & {
          readonly observedRootRegistrations: Pick<
            ObservedRootRegistrations,
            "get"
          >;
        },
      }),
    },
  );
  try {
    const { api, workflow } = product.result;
    const libraryAction = async (body: object) =>
      await api.request("/settings/libraries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const settings = async () =>
      (await (await api.request("/settings")).json()) as {
        configured: boolean;
        productDataDirectory?: string;
        libraries: DirectoryView[];
        recognitionProfiles: { id: string }[];
        librarySources: { id: string }[];
        automation: unknown[];
      };

    const initial = await settings();
    expect(initial.configured).toBe(true);
    expect(initial.libraries).toEqual([]);
    expect(initial.automation).toEqual([]);
    const recognitionProfileIds = profileIds(initial.recognitionProfiles);
    const sourceIdentities = sourceIds(initial.librarySources);

    const created = await libraryAction({
      action: "save",
      displayName: "测试书籍",
      directories: [media, notes],
      recognitionProfileIds,
      sourceIdentities,
    });
    expect(created.status).toBe(200);
    const library = (await created.json()) as {
      id: string;
      displayName: string;
      configVersion: number;
      status: string;
      rootIds: string[];
    };
    expect(library).toMatchObject({
      displayName: "测试书籍",
      status: "active",
      configVersion: 1,
    });
    expect(library.rootIds).toHaveLength(2);

    // 冲突路径：产品数据目录不能被当作实际资产目录保存。
    const conflicting = await libraryAction({
      action: "save",
      displayName: "冲突位置",
      directories: [data],
      recognitionProfileIds,
      sourceIdentities,
    });
    expect(conflicting.status).toBe(400);
    await expect(conflicting.json()).resolves.toEqual({
      error: "文件位置不能与产品数据或托管产物目录重叠",
    });

    // 目录身份与可达性由现行库入口投影，仍是不自动刷新的只读观察。
    const saved = await settings();
    expect(saved.productDataDirectory).toBe(data);
    expect(saved.automation).toEqual([]);
    const [configured] = saved.libraries;
    if (configured === undefined) throw new Error("已保存资产库未显示");
    expect(configured.id).toBe(library.id);
    expect(configured.displayName).toBe("测试书籍");
    expect([...configured.directories].toSorted()).toEqual(
      [media, notes].toSorted(),
    );
    const mediaView = configured.directoryViews.find(
      (view) => view.containerPath === media,
    )!;
    expect(mediaView).toMatchObject({
      observedRootId: expect.any(String),
      displayName: "测试书籍",
      status: "active",
      reachable: true,
    });
    expect(library.rootIds).toContain(mediaView.observedRootId);
    expect(configured.directoryViews).toHaveLength(2);

    // 只读与窄链接范围：库入口建立的目录始终是 do-not-follow 且没有借来的目标。
    const registration = await workflow.observedRootRegistrations.get(
      mediaView.observedRootId,
    );
    expect(registration).toMatchObject({ readOnly: true });
    const states = await workflow.assetLibraries.directoryViews(library.id);
    const mediaState = states.find(
      (state) => state.directoryId === mediaView.directoryId,
    )!;
    expect(mediaState).toMatchObject({
      symlinkMode: "do-not-follow",
      allowedTargetDirectoryIds: [],
      status: "active",
    });

    // 陈旧配置版本不能覆盖已变更的库设置。
    const stale = await libraryAction({
      action: "save",
      id: library.id,
      expectedVersion: library.configVersion + 1,
      displayName: "过时写入",
      directories: [media],
      recognitionProfileIds,
      sourceIdentities,
    });
    expect(stale.status).toBe(400);
    await expect(stale.json()).resolves.toEqual({
      error: "资产库配置已变更，请刷新后重试",
    });

    // 撤权：从库设置里去掉一条目录，历史与身份留在账上，等待显式重连。
    const revoked = await libraryAction({
      action: "save",
      id: library.id,
      expectedVersion: library.configVersion,
      displayName: "测试书籍",
      directories: [notes],
      recognitionProfileIds,
      sourceIdentities,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      configVersion: library.configVersion + 1,
    });
    const revokedSnapshot = await settings();
    const [revokedLibrary] = revokedSnapshot.libraries;
    if (revokedLibrary === undefined) throw new Error("撤权后的资产库未显示");
    expect(revokedLibrary.directories).toEqual([notes]);
    const stillListed = revokedLibrary.directoryViews.find(
      (view) => view.directoryId === mediaView.directoryId,
    );
    expect(stillListed).toMatchObject({
      observedRootId: mediaView.observedRootId,
      status: "removed",
      reachable: false,
      problem: "已从资产库移除，等待重新连接后才会再次观察",
    });

    const reconnectUnknown = await libraryAction({
      action: "reconnect",
      id: library.id,
      directoryId: "directory-not-in-this-library",
    });
    expect(reconnectUnknown.status).toBe(400);
    await expect(reconnectUnknown.json()).resolves.toEqual({
      error: "该目录不属于此资产库，请选择要重新连接的目录",
    });
    const reconnectActive = await libraryAction({
      action: "reconnect",
      id: library.id,
      directoryId: revokedLibrary.directoryViews.find(
        (view) => view.status === "active",
      )!.directoryId,
    });
    expect(reconnectActive.status).toBe(400);
    await expect(reconnectActive.json()).resolves.toEqual({
      error: "该目录仍在资产库中，无需重新连接",
    });

    // 显式重连回到同一目录身份，不新建位置，也不自动开始观察之外的写入。
    const connected = await libraryAction({
      action: "reconnect",
      id: library.id,
      directoryId: mediaView.directoryId,
    });
    expect(connected.status).toBe(200);
    const reconnectedSnapshot = await settings();
    const [reconnected] = reconnectedSnapshot.libraries;
    if (reconnected === undefined) throw new Error("重连后的资产库未显示");
    expect([...reconnected.directories].toSorted()).toEqual(
      [media, notes].toSorted(),
    );
    expect(
      reconnected.directoryViews.find(
        (view) => view.directoryId === mediaView.directoryId,
      ),
    ).toMatchObject({ status: "active", reachable: true });
    expect(reconnectedSnapshot.automation).toEqual([]);

    // 整库移除只撤销本库授权，库不再出现在可编辑清单里。重连已推进配置版本，移除必须
    // 按最后一次读到的库版本提交，沿用撤权前的旧版本会被并发检查拒绝。
    const removed = await libraryAction({
      action: "remove",
      id: library.id,
      expectedVersion: reconnected.configVersion,
    });
    expect(removed.status).toBe(200);
    // 现行移除操作不回送投影文档：结果只由随后的可编辑清单证明。
    expect(await removed.text()).toBe("");
    expect((await settings()).libraries).toEqual([]);
    await expect((await api.request("/libraries")).json()).resolves.toEqual([]);

    const sourceAction = (body: object) =>
      api.request("/settings/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const oauth = await sourceAction({
      source: "bangumi",
      action: "configure-client",
      clientId: "settings-client",
      clientSecret: "test-secret-not-public",
      redirectUri:
        "http://localhost:53688/api/source-connections/bangumi/callback",
    });
    expect(oauth.status).toBe(200);
    const authorization = await (
      await sourceAction({ source: "bangumi", action: "authorize" })
    ).json();
    expect(
      new URL(authorization.authorizationUrl).searchParams.get("client_id"),
    ).toBe("settings-client");
    expect(
      JSON.stringify(await (await api.request("/settings")).json()),
    ).not.toContain("test-secret-not-public");
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const configuredTmdb = await (
        await sourceAction({
          source: "tmdb",
          action: "configure",
          secret: "test-access-token",
        })
      ).json();
      expect(configuredTmdb.availability).toBe("available");
      request.mockResolvedValue(new Response("{}", { status: 401 }));
      const failed = await (
        await sourceAction({ source: "tmdb", action: "verify" })
      ).json();
      expect(failed.availability).toBe("unavailable");
      expect(failed.credentialStatus).toBe("configured");
      const revokedSource = await (
        await sourceAction({
          source: "tmdb",
          action: "revoke",
          expectedVersion: failed.version,
        })
      ).json();
      expect(revokedSource.credentialStatus).toBe("revoked");
      expect(
        JSON.stringify(await (await api.request("/settings")).json()),
      ).not.toContain("test-access-token");
    } finally {
      request.mockRestore();
    }
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60000);

it("资产库链接范围只覆盖本库所选目录，不能借用其他库的位置", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-settings-link-scope-"),
  );
  const data = path.join(temporary, "data");
  const first = path.join(temporary, "first");
  const second = path.join(temporary, "second");
  const other = path.join(temporary, "other");
  await mkdir(first);
  await mkdir(second);
  await mkdir(other);
  await prepareWebProductData(data);
  const product = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: (application) => application.workflow },
  );
  try {
    const workflow = product.result;
    const profiles = workflow.assetLibraries.recognitionProfiles.map(
      (profile) => profile.id,
    );
    const sources = workflow.assetLibraries.sources.map((source) => source.id);
    const otherLibrary = await workflow.assetLibraries.save({
      displayName: "另一座库",
      directories: [other],
      recognitionProfileIds: profiles,
      sourceIdentities: sources,
    });
    const library = await workflow.assetLibraries.save({
      displayName: "本库",
      directories: [first, second],
      recognitionProfileIds: profiles,
      sourceIdentities: sources,
    });
    expect(library.rootIds).toHaveLength(2);
    expect(
      (await workflow.assetLibraries.directoryViews(library.id)).every(
        (state) =>
          state.symlinkMode === "do-not-follow" &&
          state.allowedTargetDirectoryIds.length === 0,
      ),
    ).toBe(true);

    // 链接目标只能点名本次所选目录，因此一个库永远借不到另一个库的位置。
    await expect(
      workflow.assetLibraries.save({
        id: library.id,
        expectedVersion: library.configVersion,
        displayName: "本库",
        directories: [first, second],
        directoryLinks: [
          {
            directory: first,
            symlinkMode: "follow-file-and-directory-links",
            targetDirectories: [other],
          },
        ],
        recognitionProfileIds: profiles,
        sourceIdentities: sources,
      }),
    ).rejects.toThrow("允许的链接目标必须是本资产库所选的目录");
    expect((await workflow.assetLibraries.get(library.id))!.configVersion).toBe(
      library.configVersion,
    );

    const linked = await workflow.assetLibraries.save({
      id: library.id,
      expectedVersion: library.configVersion,
      displayName: "本库",
      directories: [first, second],
      directoryLinks: [
        {
          directory: first,
          symlinkMode: "follow-file-and-directory-links",
          targetDirectories: [second],
        },
      ],
      recognitionProfileIds: profiles,
      sourceIdentities: sources,
    });
    const states = await workflow.assetLibraries.directoryViews(linked.id);
    const granted = states.find((state) => state.containerPath === first)!;
    const target = states.find((state) => state.containerPath === second)!;
    expect(granted.symlinkMode).toBe("follow-file-and-directory-links");
    expect(granted.allowedTargetDirectoryIds).toEqual([target.directoryId]);
    expect(target.symlinkMode).toBe("do-not-follow");
    expect(target.allowedTargetDirectoryIds).toEqual([]);
    expect(otherLibrary.rootIds).toHaveLength(1);
    expect(
      (await workflow.assetLibraries.directoryViews(otherLibrary.id)).map(
        (state) => state.allowedTargetDirectoryIds,
      ),
    ).toEqual([[]]);
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60000);
