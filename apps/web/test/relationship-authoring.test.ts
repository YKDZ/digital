import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { expect, it, vi } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

it("Web 离线查询本地声明、建立参与实体、预演及采用，并从双方反查", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-relationships-"),
  );
  await prepareWebProductData(root);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("离线"));
  const open = () =>
    runProduct(
      { productDataDirectory: root, environment: {} },
      { start: createWebDelivery },
    );
  let product = open();
  const post = (route: string, body: unknown) =>
    product.result.api.request(`/relationships/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const types = await product.result.api.request("/relationships/types");
    expect(types.status).toBe(200);
    expect(await types.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "dlsite.contribution" }),
        expect.objectContaining({ id: "fanbox.post-creation" }),
        expect.objectContaining({
          id: "epub.contribution",
          additionalRoles: { label: "署名角色" },
        }),
      ]),
    );
    const predecessor = await (
      await post("entities", {
        commitmentId: "first",
        label: "离线前作",
        kind: "entity",
        actorId: "reader",
      })
    ).json();
    const sequel = await (
      await post("entities", {
        commitmentId: "second",
        label: "离线续作",
        kind: "entity",
        actorId: "reader",
      })
    ).json();
    const search = await product.result.api.request(
      "/relationships/entities?label=离线前作",
    );
    expect(await search.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: predecessor.id })]),
    );
    const change = {
      kind: "fix",
      definitionId: "bangumi.subject-sequel",
      relationship: {
        type: "bangumi.subject.related",
        participants: [
          { entityId: predecessor.id, role: "bangumi.subject.predecessor" },
          { entityId: sequel.id, role: "bangumi.subject.sequel" },
        ],
      },
    };
    const response = await post("preview", { changes: [change] });
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect((await post("apply", { actorId: "reader", preview })).status).toBe(
      200,
    );
    const fromFirst = await (
      await product.result.api.request(
        `/relationships/entities/${predecessor.id}`,
      )
    ).json();
    expect(fromFirst.relationships).toMatchObject([
      { type: "bangumi.subject.related", sources: [] },
    ]);
    await product.close();
    product = open();
    const fromSecond = await (
      await product.result.api.request(`/relationships/entities/${sequel.id}`)
    ).json();
    expect(fromSecond.relationships).toEqual(fromFirst.relationships);
    const invalid = await post("preview", {
      changes: [{ ...change, definitionId: "unknown" }],
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "所选关系类型暂不可用" });
    const malformed = await product.result.api.request(
      "/relationships/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "关系操作未完成，请刷新后重试",
    });
    expect(
      (
        await post("preview", {
          changes: [
            {
              ...change,
              relationship: { ...change.relationship, participants: null },
            },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await product.result.api.request("/relationships/entities/missing"))
        .status,
    ).toBe(404);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await product.close();
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
