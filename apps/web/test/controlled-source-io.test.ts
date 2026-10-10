import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProduct, type ProductRun } from "@digital/composition";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
} from "@digital/test-support/source-io";
import { createWebDelivery, type WebDelivery } from "@digital/web-delivery";
import { afterEach, expect, it, vi } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const fixtureDirectory = path.join(
  workspaceRoot,
  "fixtures",
  "controlled-source-io",
);

const running: ProductRun<WebDelivery>[] = [];

afterEach(async () => {
  for (const product of running.splice(0)) await product.close();
  vi.unstubAllGlobals();
});

async function controlledProduct(data: string): Promise<{
  product: ProductRun<WebDelivery>;
  fetchSpy: ReturnType<typeof vi.fn>;
}> {
  const loaded = await loadControlledSourceIo({
    manifestPath: path.join(fixtureDirectory, "manifest.json"),
  });
  const fetchSpy = vi.fn(async () => {
    throw new Error("受控装配不应触达任何真实网络请求");
  });
  vi.stubGlobal("fetch", fetchSpy);
  const product = runProduct(
    {
      productDataDirectory: data,
      environment: {},
      sourceIo: {
        mode: "controlled",
        request: loaded.request,
        sessionTransport: refusingSessionTransport(),
      },
    },
    { start: createWebDelivery },
  );
  running.push(product);
  return { product, fetchSpy };
}

async function json(response: Response): Promise<any> {
  return await response.json();
}

it("受控清单为真实产品进程提供全部普通来源请求，未列入的请求一律被拒", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-controlled-io-"),
  );
  const data = path.join(temporary, "data");
  await prepareWebProductData(data);
  const { product, fetchSpy } = await controlledProduct(data);
  try {
    const api = product.result.api;
    const saved = await json(
      await api.request("/settings/libraries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save",
          displayName: "受控夹具库",
          directories: [path.join(fixtureDirectory, "material", "RJ01668691")],
          recognitionProfileIds: ["dlsite-voice"],
          sourceIdentities: ["dlsite"],
        }),
      }),
    );
    const libraryId: string = saved.id;
    const settings = await json(await api.request("/settings"));
    const rootId: string = settings.libraries.find(
      (item: any) => item.id === libraryId,
    )!.directoryViews[0].observedRootId;
    const refresh = await json(
      await api.request("/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetLibraryId: libraryId }),
      }),
    );
    await expect
      .poll(
        async () =>
          (await json(await api.request(`/executions/${refresh.id}`))).status,
        { timeout: 120_000 },
      )
      .toBe("completed");
    const execution = await json(
      await api.request(`/executions/${refresh.id}`),
    );
    expect(execution.outcome).toBe("accepted");
    let assetId = "";
    await expect
      .poll(
        async () => {
          const intake = await json(
            await api.request(`/intake?rootId=${rootId}`),
          );
          assetId = intake.files?.[0]?.assetIds?.[0] ?? "";
          return assetId;
        },
        { timeout: 60_000 },
      )
      .toMatch(/^entity_/u);

    const subject = await json(
      await api.request(`/correction-subjects/${assetId}`),
    );
    expect(subject.recognitionState).toBe("recognized");
    expect(JSON.stringify(subject.current)).toContain("RJ01668691");

    const cover = new Uint8Array(
      await readFile(
        path.join(fixtureDirectory, "responses", "dlsite-cover.png"),
      ),
    );
    const coverDigest = createHash("sha256").update(cover).digest("hex");
    const artifact = await api.request(`/artifacts/${coverDigest}`);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("content-type")).toBe("image/png");
    await expect(artifact.bytes()).resolves.toEqual(cover);

    const refused = await json(
      await api.request("/source-enrichments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subjectId: assetId,
          sourceIdentity: "dlsite",
          sourceInput: { product: "RJ01497788" },
        }),
      }),
    );
    await expect
      .poll(
        async () =>
          (await json(await api.request(`/source-enrichments/${refused.id}`)))
            .status,
        { timeout: 120_000 },
      )
      .toBe("failed");
    const enrichment = await json(
      await api.request(`/source-enrichments/${refused.id}`),
    );
    const deliveredView = JSON.stringify(enrichment);
    // 交付视图给出清楚的业务失败原因，但不带内部拒绝诊断里的边界标识与请求键。
    expect(enrichment.sourceEnrichments[0].reason).toContain("无法取得");
    expect(deliveredView).not.toContain("受控来源拒绝");
    expect(deliveredView).not.toContain("请求键");
    expect(deliveredView).not.toContain("ordinary-request");
    // 未列入的普通来源请求仍在触达任何网络之前被拒。
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);

it("受控装配缺少可核验清单时不启动产品请求通道", async () => {
  await expect(
    loadControlledSourceIo({
      manifestPath: path.join(fixtureDirectory, "不存在的清单.json"),
    }),
  ).rejects.toThrow("受控来源清单无效");
});
