import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { expect, it, vi } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

it("Web HTTP 通过同一产品接口准备、检查并确认观察材料关联", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-material-association-"),
  );
  const data = path.join(temporary, "data");
  const initial = path.join(temporary, "initial");
  const supplemental = path.join(temporary, "supplemental");
  await mkdir(initial, { recursive: true });
  await mkdir(supplemental, { recursive: true });
  await writeFile(path.join(initial, "initial.txt"), "initial material");
  await writeFile(
    path.join(supplemental, "more.txt"),
    new Uint8Array(16 * 1024 * 1024).fill(109),
  );
  await prepareWebProductData(data);
  let product = runProduct(
    { productDataDirectory: data, environment: {} },
    { start: createWebDelivery },
  );
  try {
    let { api } = product.result;
    const post = (route: string, body: object) =>
      api.request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const createRoot = async (displayName: string, containerPath: string) =>
      await (
        await post("/settings/roots", {
          action: "create",
          displayName,
          containerPath,
          symlinkMode: "do-not-follow",
          allowedTargetRootIds: [],
        })
      ).json();
    const initialRoot = await createRoot("Initial", initial);
    const scan = await (
      await post("/refresh", {
        observedRootId: initialRoot.id,
        relativeScope: ".",
      })
    ).json();
    await expect
      .poll(
        async () =>
          (
            await (
              await api.request(
                `/intake?rootId=${initialRoot.id}&executionId=${scan.id}`,
              )
            ).json()
          ).execution?.status,
      )
      .toMatch(/completed|failed/u);
    const preview = await (
      await post("/intake", {
        action: "prepare",
        executionId: scan.id,
        relativePaths: ["initial.txt"],
        name: "Existing target",
      })
    ).json();
    const saved = await (
      await post("/intake", {
        action: "confirm",
        executionId: preview.executionId,
      })
    ).json();
    const supplementalRoot = await createRoot("Supplemental", supplemental);
    const preparing = await post("/observed-material-associations", {
      targetAssetId: saved.asset.id,
      registrationId: supplementalRoot.id,
      relativeScope: ".",
      relativePaths: ["more.txt"],
      initiatedBy: "web-prepare",
    });
    expect(preparing.status).toBe(202);
    const started = await preparing.json();
    expect(started).toEqual({ id: expect.any(String) });
    await product.close();
    product = runProduct(
      { productDataDirectory: data, environment: {} },
      { start: createWebDelivery },
    );
    api = product.result.api;
    await expect
      .poll(
        async () =>
          await (
            await api.request(`/observed-material-associations/${started.id}`)
          ).json(),
      )
      .toMatchObject({
        executionId: started.id,
        status: "failed",
        target: { id: saved.asset.id },
      });
    const interrupted = await (
      await api.request(`/observed-material-associations/${started.id}`)
    ).json();
    expect(JSON.stringify(interrupted)).not.toContain(supplemental);
    const retryResponse = await post("/observed-material-associations", {
      targetAssetId: saved.asset.id,
      registrationId: supplementalRoot.id,
      relativeScope: ".",
      relativePaths: ["more.txt"],
      initiatedBy: "web-retry",
    });
    expect(retryResponse.status).toBe(202);
    const retry = await retryResponse.json();
    await expect
      .poll(
        async () =>
          await (
            await api.request(`/observed-material-associations/${retry.id}`)
          ).json(),
      )
      .toMatchObject({
        executionId: retry.id,
        status: "awaiting-confirmation",
        target: { id: saved.asset.id },
        files: [
          expect.objectContaining({
            relativePath: "more.txt",
            mediaType: "application/octet-stream",
          }),
        ],
      });
    const confirming = await post(
      `/observed-material-associations/${retry.id}/confirm`,
      { confirmedBy: "web-confirm" },
    );
    expect(confirming.status).toBe(202);
    await expect
      .poll(
        async () =>
          await (
            await api.request(`/observed-material-associations/${retry.id}`)
          ).json(),
      )
      .toMatchObject({
        status: "accepted",
        confirmedBy: "web-confirm",
        decisionId: expect.any(String),
        associationIds: [expect.any(String)],
      });
    const inspection = await (
      await api.request(`/observed-material-associations/${retry.id}`)
    ).json();
    expect(JSON.stringify(inspection)).not.toContain(supplemental);
  } finally {
    await product.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

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

it("HTTP 交付公开真实来源要求并通过产品用例补充来源", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-source-enrichment-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "local.txt"), "已确认的本地内容");
  await prepareWebProductData(data);
  let responseKind: "zero" | "multiple" | "unique" = "zero";
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          docs:
            responseKind === "zero"
              ? []
              : [
                  {
                    pnx: {
                      display: { title: ["HTTP 来源书名"] },
                      addata: { isbn: ["9789864738281"] },
                    },
                  },
                  ...(responseKind === "multiple"
                    ? [
                        {
                          pnx: {
                            display: { title: ["另一个候选"] },
                            addata: { isbn: ["9789864738281"] },
                          },
                        },
                      ]
                    : []),
                ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
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
    const requirements = await (await api.request("/source-inputs")).json();
    expect(requirements).toEqual([
      expect.objectContaining({
        sourceIdentity: "dlsite",
        fields: [expect.objectContaining({ key: "product", required: true })],
      }),
      expect.objectContaining({
        sourceIdentity: "nbinet",
        fields: [expect.objectContaining({ key: "isbn", required: true })],
      }),
      expect.objectContaining({
        sourceIdentity: "taiwan-kadokawa",
        fields: [expect.objectContaining({ key: "isbn", required: true })],
      }),
      expect.objectContaining({
        sourceIdentity: "kadokawa-jp",
        fields: [expect.objectContaining({ key: "isbn", required: true })],
      }),
    ]);
    const root = await (
      await post("/settings/roots", {
        action: "create",
        displayName: "本地内容",
        containerPath: media,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      })
    ).json();
    const scan = await (
      await post("/refresh", { observedRootId: root.id, relativeScope: "." })
    ).json();
    await expect
      .poll(
        async () =>
          await (
            await api.request(
              `/intake?rootId=${root.id}&executionId=${scan.id}`,
            )
          ).json(),
      )
      .toMatchObject({
        execution: { status: expect.stringMatching(/completed|failed/u) },
      });
    const preview = await (
      await post("/intake", {
        action: "prepare",
        executionId: scan.id,
        relativePaths: ["local.txt"],
        name: "本地内容",
        classification: "book",
      })
    ).json();
    const saved = await (
      await post("/intake", {
        action: "confirm",
        executionId: preview.executionId,
      })
    ).json();
    const invalid = await post("/source-enrichments", {
      subjectId: saved.asset.id,
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "not-an-isbn" },
    });
    expect(invalid.status).toBe(400);
    const zero = await post("/source-enrichments", {
      subjectId: saved.asset.id,
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "9789864738281" },
    });
    expect(zero.status).toBe(201);
    const zeroStarted = await zero.json();
    await expect
      .poll(
        async () =>
          await (
            await api.request(`/source-enrichments/${zeroStarted.id}`)
          ).json(),
      )
      .toMatchObject({
        outcome: "failed",
        sourceAssociations: [],
      });
    responseKind = "multiple";
    const multiple = await post("/source-enrichments", {
      subjectId: saved.asset.id,
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "9789864738281" },
    });
    expect(multiple.status).toBe(201);
    const multipleStarted = await multiple.json();
    let multipleResult: Record<string, unknown> | undefined;
    await expect
      .poll(async () => {
        multipleResult = (await (
          await api.request(`/source-enrichments/${multipleStarted.id}`)
        ).json()) as Record<string, unknown>;
        return multipleResult;
      })
      .toMatchObject({
        outcome: "failed",
        sourceEnrichments: [
          {
            sourceIdentity: "nbinet",
            input: { isbn: "9789864738281" },
            status: "failed",
            canRetry: true,
          },
        ],
        sourceAssociations: [],
      });
    expect(
      await (await api.request(`/catalogue/${saved.asset.id}`)).json(),
    ).toMatchObject({
      asset: { id: saved.asset.id, sources: [] },
    });
    expect(
      await (
        await api.request(`/source-enrichments/${multipleStarted.id}`)
      ).json(),
    ).toMatchObject({
      id: multipleStarted.id,
      sourceEnrichments: [expect.objectContaining({ canRetry: true })],
    });
    responseKind = "unique";
    const response = await post("/source-enrichments", {
      subjectId: saved.asset.id,
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "9789864738281" },
    });
    expect(response.status).toBe(201);
    const acceptedStarted = await response.json();
    await expect
      .poll(
        async () =>
          await (
            await api.request(`/source-enrichments/${acceptedStarted.id}`)
          ).json(),
      )
      .toMatchObject({ outcome: "accepted" });
    expect(
      await (await api.request(`/catalogue/${saved.asset.id}`)).json(),
    ).toMatchObject({
      asset: {
        id: saved.asset.id,
        sources: [expect.objectContaining({ sourceIdentity: "nbinet" })],
      },
    });
  } finally {
    await product.close();
    vi.unstubAllGlobals();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60000);
