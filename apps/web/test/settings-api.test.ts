import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { expect, it, vi } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

it("设置保存真实文件位置，拒绝冲突路径，停用后可重新连接且不默认开启自动刷新", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-settings-test-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  await mkdir(media);
  await prepareWebProductData(data);
  const product = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: createWebDelivery },
  );
  try {
    const { api } = product.result;
    const post = (body: object) =>
      api.request("/settings/roots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const fields = {
      displayName: "测试书籍",
      containerPath: media,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    };
    const created = await post({ action: "create", ...fields });
    expect(created.status).toBe(200);
    const root = await created.json();
    expect(
      (await post({ action: "create", ...fields, containerPath: data })).status,
    ).toBe(400);
    const snapshot = await (await api.request("/settings")).json();
    expect(snapshot.roots).toEqual([
      expect.objectContaining({
        id: root.id,
        displayName: "测试书籍",
        reachable: true,
      }),
    ]);
    expect(snapshot.automation).toEqual([]);
    expect(snapshot.productDataDirectory).toBe(data);
    const disabled = await (
      await post({
        action: "deactivate",
        id: root.id,
        expectedVersion: root.configVersion,
      })
    ).json();
    expect(disabled.status).toBe("revoked");
    expect(
      (
        await post({
          action: "update",
          ...fields,
          id: root.id,
          expectedVersion: root.configVersion,
        })
      ).status,
    ).toBe(400);
    const connected = await (
      await post({
        action: "reconnect",
        id: root.id,
        expectedVersion: disabled.configVersion,
        containerPath: media,
      })
    ).json();
    expect(connected.status).toBe("active");
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
      const configured = await (
        await sourceAction({
          source: "tmdb",
          action: "configure",
          secret: "test-access-token",
        })
      ).json();
      expect(configured.availability).toBe("available");
      request.mockResolvedValue(new Response("{}", { status: 401 }));
      const failed = await (
        await sourceAction({ source: "tmdb", action: "verify" })
      ).json();
      expect(failed.availability).toBe("unavailable");
      expect(failed.credentialStatus).toBe("configured");
      const revoked = await (
        await sourceAction({
          source: "tmdb",
          action: "revoke",
          expectedVersion: failed.version,
        })
      ).json();
      expect(revoked.credentialStatus).toBe("revoked");
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
