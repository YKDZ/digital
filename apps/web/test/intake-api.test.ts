import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { expect, it } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

it("接入区从真实检查中整理文件，预览与添加后的普通详情一致，其他观察继续保留", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-intake-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  await mkdir(path.join(media, "手记"), { recursive: true });
  await writeFile(path.join(media, "手记", "上.txt"), "上篇");
  await writeFile(path.join(media, "手记", "下.txt"), "下篇");
  await writeFile(path.join(media, "剩余.txt"), "另一份材料");
  await writeFile(path.join(media, "损坏.pdf"), "损坏的文档");
  await prepareWebProductData(data);
  const product = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: createWebDelivery },
  );
  try {
    const { api } = product.result;
    const post = (route: string, body: object) =>
      api.request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const root = await (
      await post("/settings/roots", {
        action: "create",
        displayName: "材料",
        containerPath: media,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      })
    ).json();
    const scan = await (
      await post("/refresh", { observedRootId: root.id, relativeScope: "." })
    ).json();
    const read = async () =>
      await (
        await api.request(`/intake?rootId=${root.id}&executionId=${scan.id}`)
      ).json();
    await expect.poll(read).toMatchObject({
      execution: {
        id: scan.id,
        status: expect.stringMatching(/completed|failed/u),
      },
    });
    const inspected = await read();
    expect(inspected.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "手记/上.txt" }),
        expect.objectContaining({
          relativePath: "损坏.pdf",
          problem: expect.any(String),
        }),
      ]),
    );
    const previewResponse = await post("/intake", {
      action: "prepare",
      executionId: scan.id,
      relativePaths: ["手记/上.txt", "手记/下.txt"],
      name: "林间手记",
      classification: "book",
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      status: "proposed",
      asset: { title: "林间手记", cardComponent: "book" },
    });
    const saved = await (
      await post("/intake", {
        action: "confirm",
        executionId: preview.executionId,
      })
    ).json();
    expect(saved).toMatchObject({
      status: "accepted",
      asset: { id: preview.asset.id, title: "林间手记" },
    });
    const detail = await (
      await api.request(`/catalogue/${saved.asset.id}`)
    ).json();
    expect(detail.asset).toMatchObject({
      id: preview.asset.id,
      title: "林间手记",
      cardComponent: "book",
    });
    const refreshed = await read();
    expect(
      refreshed.files.find(
        (file: { relativePath: string }) => file.relativePath === "手记/上.txt",
      ).assetIds,
    ).toEqual([saved.asset.id]);
    expect(
      refreshed.files.find(
        (file: { relativePath: string }) => file.relativePath === "剩余.txt",
      ).assetIds,
    ).toEqual([]);
    expect(
      (
        await post("/intake", {
          action: "prepare",
          executionId: scan.id,
          relativePaths: ["../outside.txt"],
        })
      ).status,
    ).toBe(400);
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60000);
