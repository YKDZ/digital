import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProduct, type ProductRun } from "@digital/composition";
import {
  loadControlledSourceIo,
  resolveSourceIoFromEnvironment,
  sourceIoConfigVariable,
  sourceIoIdentityVariable,
  sourceIoModeVariable,
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
  "controlled-fanbox-session",
);
const materialDirectory = path.join(fixtureDirectory, "material");
const credentialFile = path.join(
  fixtureDirectory,
  "connections",
  "synthetic-customudon.json",
);

const creatorId = "customudon";
const postId = "7225781";
// 既有来源契约把审阅到的发布时刻投影为该日期的公共日：`2023-12-31T17:10:55+09:00` → `2023-12-31`。
const publishedDate = "2023-12-31";
const postTitle = "Movie | コスプレ4";

const running: ProductRun<WebDelivery>[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const product of running.splice(0)) await product.close();
  for (const root of temporaryRoots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** 产品数据的可丢弃根必须位于系统临时目录正下方的 digital-disposable- 目录内。 */
async function disposableRoot(marker: string): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), `digital-disposable-${marker}-`),
  );
  temporaryRoots.push(root);
  return root;
}

async function json(response: Response): Promise<any> {
  return await response.json();
}

/**
 * 以托管环境相同的显式来源选择启动真实 Web 产品：清单路径与内容身份只经环境变量给出，
 * 因此受控清单无效或缺项时进程根本不会进入 ready。
 */
async function controlledWebProduct(input: {
  readonly manifest: string;
  readonly data: string;
}): Promise<{
  product: ProductRun<WebDelivery>;
  fetchSpy: ReturnType<typeof vi.fn>;
}> {
  const manifestPath = path.join(fixtureDirectory, input.manifest);
  const { contentIdentity } = await loadControlledSourceIo({ manifestPath });
  const resolved = await resolveSourceIoFromEnvironment({
    [sourceIoModeVariable]: "controlled",
    [sourceIoConfigVariable]: manifestPath,
    [sourceIoIdentityVariable]: contentIdentity,
  });
  if (resolved.mode === "real") throw new Error("受控选择不得落回真实装配");
  const fetchSpy = vi.fn(async () => {
    throw new Error("受控装配不应触达任何真实网络请求");
  });
  vi.stubGlobal("fetch", fetchSpy);
  const product = runProduct(
    {
      productDataDirectory: input.data,
      environment: {},
      sourceIo: resolved,
    },
    { start: createWebDelivery },
  );
  running.push(product);
  return { product, fetchSpy };
}

async function configureFanboxConnection(api: any): Promise<Response> {
  return await api.request("/settings/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "fanbox",
      action: "configure",
      creatorId,
      browserCredential: JSON.parse(await readFile(credentialFile, "utf8")),
    }),
  });
}

async function createFanboxLibrary(api: any): Promise<string> {
  const saved = await json(
    await api.request("/settings/libraries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save",
        displayName: "受控 FANBOX 会话库",
        directories: [materialDirectory],
        recognitionProfileIds: ["fanbox"],
        sourceIdentities: ["fanbox"],
      }),
    }),
  );
  return saved.id as string;
}

async function observedRootId(api: any, libraryId: string): Promise<string> {
  const settings = await json(await api.request("/settings"));
  return settings.libraries.find((item: any) => item.id === libraryId)!
    .directoryViews[0].observedRootId as string;
}

/** 等正式工作流进入明确终态；受控缺项可能把执行直接判为失败。 */
async function terminalExecution(api: any, executionId: string): Promise<any> {
  await expect
    .poll(
      async () => {
        const execution = await json(
          await api.request(`/executions/${executionId}`),
        );
        return execution.status === "completed" || execution.status === "failed"
          ? execution.status
          : "";
      },
      { timeout: 180_000 },
    )
    .not.toBe("");
  return await json(await api.request(`/executions/${executionId}`));
}

/** 等正式扫描/刷新工作流到终态，并返回该目录的首个资产标识。 */
async function scanUntilAsset(api: any, libraryId: string, rootId: string) {
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
  const execution = await json(await api.request(`/executions/${refresh.id}`));
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
  return { execution, assetId };
}

function decodedPng(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  const signature = "89504e470d0a1a0a";
  if (Buffer.from(bytes).subarray(0, 8).toString("hex") !== signature)
    throw new Error("不是 PNG 签名");
  if (Buffer.from(bytes).subarray(12, 16).toString("ascii") !== "IHDR")
    throw new Error("PNG 首个分块不是 IHDR");
  return {
    width: Buffer.from(bytes).readUInt32BE(16),
    height: Buffer.from(bytes).readUInt32BE(20),
  };
}

it("受控 FANBOX 会话让真实 Web 产品完成连接验证、目录识别与主图托管", async () => {
  const temporary = await disposableRoot("t09-web-fanbox");
  const data = path.join(temporary, "data");
  await prepareWebProductData(data);
  const { product, fetchSpy } = await controlledWebProduct({
    manifest: "manifest.json",
    data,
  });
  const api = product.result.api;

  const configured = await json(await configureFanboxConnection(api));
  expect(configured).toMatchObject({
    creatorId,
    version: 1,
    credentialStatus: "configured",
    availability: "available",
  });
  // 合成凭据不进入交付视图，也不出现在错误诊断里。
  const credential = JSON.parse(await readFile(credentialFile, "utf8")) as {
    userAgent: string;
    cookies: { name: string; value: string }[];
  };
  for (const secret of [
    "FANBOXSESSID",
    credential.cookies[0]!.value,
    credential.userAgent,
  ])
    expect(JSON.stringify(configured)).not.toContain(secret);

  const libraryId = await createFanboxLibrary(api);
  const rootId = await observedRootId(api, libraryId);
  const { execution, assetId } = await scanUntilAsset(api, libraryId, rootId);
  expect(execution.outcome).toBe("accepted");

  const subject = await json(
    await api.request(`/correction-subjects/${assetId}`),
  );
  expect(subject.recognitionState).toBe("recognized");
  // 帖子只由正式目录识别工作流形成：关联指向审阅过的独立地址，含创作者与帖子标识。
  expect(subject.current).toEqual([
    {
      id: expect.any(String),
      subjectId: assetId,
      sourceIdentity: "fanbox",
      nativeAddress: `https://www.fanbox.cc/@${creatorId}/posts/${postId}`,
    },
  ]);
  const catalogue = JSON.stringify(
    await json(await api.request(`/catalogue/${assetId}`)),
  );
  expect(catalogue).toContain(postTitle);
  expect(catalogue).toContain(publishedDate);

  const cover = new Uint8Array(
    await readFile(
      path.join(fixtureDirectory, "responses", "fanbox-cover.png"),
    ),
  );
  const coverDigest = createHash("sha256").update(cover).digest("hex");
  const artifact = await api.request(`/artifacts/${coverDigest}`);
  expect(artifact.status).toBe(200);
  expect(artifact.headers.get("content-type")).toBe("image/png");
  const delivered = new Uint8Array(await artifact.arrayBuffer());
  expect(delivered).toEqual(cover);
  expect(decodedPng(delivered)).toEqual({ width: 8, height: 8 });
  expect(fetchSpy).not.toHaveBeenCalled();

  // 重启：合成上下文由产品私有连接取回，受控 transport 仍核对它，托管主图仍可正式读取。
  await product.close();
  running.splice(running.indexOf(product), 1);
  const restarted = await controlledWebProduct({
    manifest: "manifest.json",
    data,
  });
  const restartedApi = restarted.product.result.api;
  const verified = await json(
    await restartedApi.request("/settings/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "fanbox", action: "verify", creatorId }),
    }),
  );
  expect(verified).toMatchObject({ availability: "available" });
  expect(JSON.stringify(verified)).not.toContain("FANBOXSESSID");
  const metadataRefresh = await json(
    await restartedApi.request("/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId, intent: "metadata-refresh" }),
    }),
  );
  await expect
    .poll(
      async () =>
        (
          await json(
            await restartedApi.request(`/executions/${metadataRefresh.id}`),
          )
        ).status,
      { timeout: 120_000 },
    )
    .toBe("completed");
  const afterRestart = await restartedApi.request(`/artifacts/${coverDigest}`);
  expect(afterRestart.status).toBe(200);
  expect(new Uint8Array(await afterRestart.arrayBuffer())).toEqual(cover);
  expect(restarted.fetchSpy).not.toHaveBeenCalled();
}, 300_000);

it("会话链路任一支缺失都不会让真实 Web 产品把合成连接当作可用", async () => {
  const temporary = await disposableRoot("t09-web-fanbox-refusal");
  const data = path.join(temporary, "data");
  await prepareWebProductData(data);
  for (const manifest of [
    "manifest-without-session.json",
    "manifest-without-login-status.json",
    "manifest-without-verify-summaries.json",
    "manifest-without-post-detail.json",
    "manifest-public-detail-only.json",
    "manifest-mismatched-context.json",
    "manifest-other-creator.json",
    // 只有详情条目声明另一个创作者：错配必须落在详情边界，而不是被 login 先挡住。
    "manifest-detail-creator-mismatch.json",
    "manifest-public-detail-creator-mismatch.json",
  ]) {
    const { product, fetchSpy } = await controlledWebProduct({
      manifest,
      data,
    });
    const response = await configureFanboxConnection(product.result.api);
    const body = await response.text();
    expect(response.status, manifest).toBe(400);
    // 验证不成功的连接不会被保存：设置视图里没有任何该创作者的连接。
    const settings = await json(await product.result.api.request("/settings"));
    expect(
      JSON.stringify(
        (settings.connections ?? []).filter((item: any) =>
          JSON.stringify(item).includes(creatorId),
        ),
      ),
      manifest,
    ).toBe("[]");
    // 交付视图只给业务可读的失败，不泄露边界标识或请求键。
    expect(body, manifest).not.toContain("受控来源拒绝");
    expect(body, manifest).not.toContain("请求键");
    expect(body, manifest).not.toContain("fanbox-session");
    expect(body, manifest).not.toContain("FANBOXSESSID");
    expect(fetchSpy, manifest).not.toHaveBeenCalled();
    await product.close();
    running.splice(running.indexOf(product), 1);
  }
}, 180_000);

it("采集摘要或独立图片缺失时，真实 Web 产品不会把帖子或主图当作已满足", async () => {
  const cases: readonly {
    readonly manifest: string;
    readonly expect: "帖子" | "主图";
  }[] = [
    {
      manifest: "manifest-without-collect-summaries.json",
      expect: "帖子",
    },
    { manifest: "manifest-without-cover-image.json", expect: "主图" },
  ];
  for (const item of cases) {
    const temporary = await disposableRoot("t09-web-fanbox-partial");
    const data = path.join(temporary, "data");
    await prepareWebProductData(data);
    const { product, fetchSpy } = await controlledWebProduct({
      manifest: item.manifest,
      data,
    });
    const api = product.result.api;
    expect(await json(await configureFanboxConnection(api))).toMatchObject({
      availability: "available",
    });
    const libraryId = await createFanboxLibrary(api);
    const rootId = await observedRootId(api, libraryId);
    const refresh = await json(
      await api.request("/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetLibraryId: libraryId }),
      }),
    );
    const execution = await terminalExecution(api, refresh.id);
    const intake = await json(await api.request(`/intake?rootId=${rootId}`));
    const assetId: string = intake.files?.[0]?.assetIds?.[0] ?? "";
    const delivered = JSON.stringify({ execution, intake });
    expect(delivered, item.manifest).not.toContain("受控来源拒绝");
    expect(fetchSpy, item.manifest).not.toHaveBeenCalled();
    // 两种缺失都不会让本次来源获取的主图进入托管：正式摘要读取一律 404。
    const cover = new Uint8Array(
      await readFile(
        path.join(fixtureDirectory, "responses", "fanbox-cover.png"),
      ),
    );
    const digest = createHash("sha256").update(cover).digest("hex");
    const missing = await api.request(`/artifacts/${digest}`);
    expect(missing.status, item.manifest).toBe(404);
    if (item.expect === "帖子") {
      expect(execution.outcome, item.manifest).not.toBe("accepted");
      expect(delivered, item.manifest).not.toContain(postId);
    } else {
      expect(assetId, item.manifest).toMatch(/^entity_/u);
      const subject = await json(
        await api.request(`/correction-subjects/${assetId}`),
      );
      expect(JSON.stringify(subject), item.manifest).toContain(postId);
    }
    await product.close();
    running.splice(running.indexOf(product), 1);
  }
}, 300_000);
