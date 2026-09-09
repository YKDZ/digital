import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct, type ProductRun } from "@digital/composition";
import { createWebDelivery, type WebDelivery } from "@digital/web-delivery";
import { expect, it, vi } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

type WebProduct = ProductRun<WebDelivery>;

it("已有资产来源补充在耐久 ID 后早返，并在安全检查点关闭后由恢复明确终止", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-enrichment-lifecycle-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "local.txt"), "已确认的本地内容");
  await prepareWebProductData(data);
  const delayed = delayedNbinetResponse();
  vi.stubGlobal("fetch", delayed.fetch);
  let product: WebProduct | undefined = productFor(data);
  let restarted: WebProduct | undefined;
  try {
    const assetId = await createManualAsset(product, media);
    const pendingResponse = post(product.result.api, "/source-enrichments", {
      subjectId: assetId,
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "9789864738281" },
    });
    await delayed.entered.promise;
    const returnedBeforeSource = await settlesWithin(pendingResponse, 100);
    if (!returnedBeforeSource) delayed.release.resolve();
    const response = await pendingResponse;
    expect(returnedBeforeSource).toBe(true);
    expect(response.status).toBe(201);
    const started = await response.json();
    expect(started).toEqual({ id: expect.any(String) });

    const closing = product.close();
    delayed.release.resolve();
    await closing;
    product = undefined;

    restarted = productFor(data);
    await expect(
      inspectSourceEnrichment(restarted.result.api, started.id),
    ).resolves.toMatchObject({
      id: started.id,
      status: "running",
      sourceAssociations: [],
    });
    await restarted.result.startCatalogueAutomation();
    await expect(
      inspectSourceEnrichment(restarted.result.api, started.id),
    ).resolves.toMatchObject({
      id: started.id,
      status: "failed",
      outcome: "interrupted",
      reason: expect.stringMatching(/.+/u),
      sourceEnrichments: [
        expect.objectContaining({ input: { isbn: "9789864738281" } }),
      ],
      sourceAssociations: [],
    });
    const retry = await post(restarted.result.api, "/source-enrichments", {
      subjectId: assetId,
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "9789864738281" },
    });
    const retried = await retry.json();
    expect(retried.id).not.toBe(started.id);
    await expect
      .poll(async () =>
        inspectSourceEnrichment(restarted!.result.api, retried.id),
      )
      .toMatchObject({
        status: "completed",
        outcome: "accepted",
        sourceAssociations: [
          expect.objectContaining({
            sourceIdentity: "nbinet",
          }),
        ],
      });
    await expect(
      (await restarted.result.api.request(`/catalogue/${assetId}`)).json(),
    ).resolves.toMatchObject({
      asset: {
        id: assetId,
        sources: [expect.objectContaining({ sourceIdentity: "nbinet" })],
      },
    });
  } finally {
    delayed.release.resolve();
    await product?.close();
    await restarted?.close();
    vi.unstubAllGlobals();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it("结构化定向新材料在耐久 ID 后早返，并在安全检查点关闭后由恢复明确终止", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-directed-lifecycle-"),
  );
  const data = path.join(temporary, "data");
  const media = path.join(temporary, "media");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "new.pdf"), syntheticPdf());
  await prepareWebProductData(data);
  const delayed = delayedNbinetResponse();
  vi.stubGlobal("fetch", delayed.fetch);
  let product: WebProduct | undefined = productFor(data);
  let restarted: WebProduct | undefined;
  try {
    const root = await (
      await post(product.result.api, "/settings/roots", {
        action: "create",
        displayName: "定向材料",
        containerPath: media,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      })
    ).json();
    const pendingResponse = post(product.result.api, "/refresh", {
      observedRootId: root.id,
      relativeScope: ".",
      directedSourceIdentity: "nbinet",
      directedSourceInput: { isbn: "9789864738281" },
    });
    await delayed.entered.promise;
    expect(await settlesWithin(pendingResponse, 100)).toBe(true);
    const response = await pendingResponse;
    expect(response.status).toBe(201);
    const started = await response.json();
    expect(started).toEqual({ id: expect.any(String) });

    const closing = product.close();
    delayed.release.resolve();
    await closing;
    product = undefined;

    restarted = productFor(data);
    await expect(
      inspectIntakeExecution(restarted.result.api, root.id, started.id),
    ).resolves.toMatchObject({
      execution: { id: started.id, status: "running" },
      contents: [],
    });
    await restarted.result.startCatalogueAutomation();
    await expect(
      inspectIntakeExecution(restarted.result.api, root.id, started.id),
    ).resolves.toMatchObject({
      execution: {
        id: started.id,
        status: "failed",
        outcome: "interrupted",
        reason: expect.stringMatching(/.+/u),
      },
      contents: [],
    });
    const retry = await post(restarted.result.api, "/refresh", {
      observedRootId: root.id,
      relativeScope: ".",
      directedSourceIdentity: "nbinet",
      directedSourceInput: { isbn: "9789864738281" },
    });
    const retried = await retry.json();
    expect(retried.id).not.toBe(started.id);
    await expect
      .poll(async () =>
        inspectIntakeExecution(restarted!.result.api, root.id, retried.id),
      )
      .toMatchObject({
        execution: { status: "completed", outcome: "accepted" },
        contents: [
          expect.objectContaining({
            sources: [expect.objectContaining({ sourceIdentity: "nbinet" })],
          }),
        ],
      });
  } finally {
    delayed.release.resolve();
    await product?.close();
    await restarted?.close();
    vi.unstubAllGlobals();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

function productFor(data: string): WebProduct {
  return runProduct(
    { productDataDirectory: data, environment: {} },
    { start: createWebDelivery },
  );
}

async function createManualAsset(
  product: WebProduct,
  media: string,
): Promise<string> {
  const api = product.result.api;
  const root = await (
    await post(api, "/settings/roots", {
      action: "create",
      displayName: "本地内容",
      containerPath: media,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    })
  ).json();
  const scan = await (
    await post(api, "/refresh", {
      observedRootId: root.id,
      relativeScope: ".",
    })
  ).json();
  await expect
    .poll(async () => inspectIntakeExecution(api, root.id, scan.id))
    .toMatchObject({
      execution: { status: expect.stringMatching(/completed|failed/u) },
    });
  const preview = await (
    await post(api, "/intake", {
      action: "prepare",
      executionId: scan.id,
      relativePaths: ["local.txt"],
      name: "本地内容",
      classification: "book",
    })
  ).json();
  const saved = await (
    await post(api, "/intake", {
      action: "confirm",
      executionId: preview.executionId,
    })
  ).json();
  return saved.asset.id as string;
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

async function inspectSourceEnrichment(
  api: WebDelivery["api"],
  executionId: string,
) {
  return await (await api.request(`/source-enrichments/${executionId}`)).json();
}

async function inspectIntakeExecution(
  api: WebDelivery["api"],
  rootId: string,
  executionId: string,
) {
  return await (
    await api.request(`/intake?rootId=${rootId}&executionId=${executionId}`)
  ).json();
}

async function settlesWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(resolve, milliseconds, false)),
  ]);
}

function delayedNbinetResponse() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    entered,
    release,
    fetch: vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return new Response(
        JSON.stringify({
          docs: [
            {
              pnx: {
                display: { title: ["延迟来源书名"] },
                addata: { isbn: ["9789864738281"] },
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  };
}

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
