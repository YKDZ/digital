import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareProductionCatalogue } from "@digital/db-migrations";
import type { FanboxEndpointSessionTransport } from "@digital/fanbox";
import { createPublicApiClient } from "@digital/public-api";
import { createProcessLifecycleRegistry } from "@digital/service-host";
import { refusingSessionTransport } from "@digital/test-support/source-io";
import {
  chromium,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { serve } from "srvx";
import { afterEach, it } from "vitest";

import { createProductService } from "../src/service.ts";
import { interactiveTerminalEnvironment } from "./interactive-terminal.ts";

const servers: Array<Awaited<ReturnType<typeof serve>>> = [];
const bootstraps: Array<Awaited<ReturnType<typeof createProductService>>> = [];
const browserContexts: BrowserContext[] = [];
const terminalChildren: Array<ReturnType<typeof spawn>> = [];
const temporaryRoots: string[] = [];
const capturedContexts: Array<{
  readonly creatorId: string;
  readonly cookieValue: string;
  readonly userAgent: string;
}> = [];

afterEach(async () => {
  for (const child of terminalChildren.splice(0).reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else child.kill("SIGTERM");
    }
  }
  for (const context of browserContexts.splice(0).reverse())
    await context.close();
  for (const server of servers.splice(0).reverse()) await server.close(true);
  for (const bootstrap of bootstraps.splice(0).reverse())
    await bootstrap.abort();
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
  capturedContexts.length = 0;
});

it("在 Chromium 中按正式清单安装并加载扩展【安装客户端】", async () => {
  const extensionDirectory = fileURLToPath(
    import.meta.resolve("@digital/fanbox-extension/extension"),
  );
  const profile = await mkdtemp(
    path.join(tmpdir(), "digital-fanbox-production-chromium-"),
  );
  temporaryRoots.push(profile);
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      "--no-sandbox",
    ],
  });
  browserContexts.push(context);
  const [existingWorker] = context.serviceWorkers();
  const worker =
    existingWorker ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("h1")).toHaveText("连接 FANBOX");
  await expect(
    popup.getByRole("button", { name: "检查目标与创作者范围" }),
  ).toBeVisible();
}, 60_000);

it("编辑已核对的服务和请求后必须重新检查才会捕获浏览器会话【安装客户端】", async () => {
  const firstBaseUrl = await startService(controlledSourceIo());
  const secondBaseUrl = await startService(controlledSourceIo());
  const firstClient = createPublicApiClient({ baseUrl: firstBaseUrl });
  const secondClient = createPublicApiClient({ baseUrl: secondBaseUrl });
  const first = await firstClient.createFanboxConnectionRequest({
    creatorId: "customudon",
  });
  const second = await secondClient.createFanboxConnectionRequest({
    creatorId: "customudon",
  });
  const builtExtensionDirectory = fileURLToPath(
    import.meta.resolve("@digital/fanbox-extension/extension"),
  );
  const profile = await mkdtemp(
    path.join(tmpdir(), "digital-fanbox-review-binding-"),
  );
  temporaryRoots.push(profile);
  const extensionDirectory = path.join(profile, "extension");
  await cp(builtExtensionDirectory, extensionDirectory, { recursive: true });
  const manifestPath = path.join(extensionDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    optional_host_permissions?: string[];
    host_permissions?: string[];
  };
  delete manifest.optional_host_permissions;
  manifest.host_permissions = [
    `${firstBaseUrl.origin}/*`,
    `${secondBaseUrl.origin}/*`,
    "https://fanbox.cc/*",
    "https://*.fanbox.cc/*",
  ];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      "--no-sandbox",
    ],
  });
  browserContexts.push(context);
  const [existingWorker] = context.serviceWorkers();
  const worker =
    existingWorker ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  await fillPairing(popup, {
    serviceAddress: firstBaseUrl.origin,
    instanceId: first.request.instanceId,
    requestId: first.request.id,
    pairingCode: first.pairingCode,
  });
  await popup.getByRole("button", { name: "检查目标与创作者范围" }).click();
  await expect(popup.locator("#scope")).toContainText(
    `目标实例：${first.request.instanceId}`,
  );
  await expect(
    popup.getByRole("button", { name: "使用此浏览器登录状态连接" }),
  ).toBeEnabled();

  await context.addCookies([
    {
      name: "FANBOXSESSID",
      value: "synthetic-review-binding-session-value",
      domain: ".fanbox.cc",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "None",
    },
  ]);
  await fillPairing(popup, {
    serviceAddress: secondBaseUrl.origin,
    instanceId: second.request.instanceId,
    requestId: second.request.id,
    pairingCode: second.pairingCode,
  });
  await popup.getByRole("button", { name: "使用此浏览器登录状态连接" }).click();

  await expect(popup.locator("#status")).toContainText(
    "目标信息已更改，请重新检查",
  );
  expect(capturedContexts).toHaveLength(0);
  expect(
    (await firstClient.getFanboxConnectionRequest(first.request.id)).status,
  ).toBe("waiting");
  expect(
    (await secondClient.getFanboxConnectionRequest(second.request.id)).status,
  ).toBe("waiting");
  expect(
    (await firstClient.listSourceConnections()).items.some(
      ({ id }) => id === "fanbox/customudon",
    ),
  ).toBe(false);
  expect(
    (await secondClient.listSourceConnections()).items.some(
      ({ id }) => id === "fanbox/customudon",
    ),
  ).toBe(false);

  await popup.getByRole("button", { name: "检查目标与创作者范围" }).click();
  await expect(popup.locator("#scope")).toContainText(
    `目标实例：${second.request.instanceId}`,
  );
  await popup.getByRole("button", { name: "使用此浏览器登录状态连接" }).click();
  await expect(popup.locator("#status")).toContainText("FANBOX 连接成功");
  await expect
    .poll(
      async () =>
        (await secondClient.getFanboxConnectionRequest(second.request.id))
          .status,
    )
    .toBe("succeeded");
  expect(capturedContexts).toMatchObject([
    {
      creatorId: "customudon",
      cookieValue: "synthetic-review-binding-session-value",
    },
  ]);
  expect(JSON.stringify(await fanboxConnection(secondClient))).not.toContain(
    "synthetic-review-binding-session-value",
  );
  expect(
    (await firstClient.getFanboxConnectionRequest(first.request.id)).status,
  ).toBe("waiting");
}, 60_000);

it("通过实际 Chromium 扩展与正式 FANBOX 验证器完成 TUI 连接【安装客户端】", async () => {
  const verificationGate = createVerificationGate();
  const baseUrl = await startService(controlledSourceIo(verificationGate));
  const wrongTargetUrl = await startService(refusingSourceIo());
  const client = createPublicApiClient({ baseUrl });
  const terminal = await startTui(baseUrl.origin);

  await terminal.waitFor("还没有资产库");
  await terminal.send("7");
  await terminal.waitFor("当前没有来源连接");
  await terminal.send("f");
  await terminal.waitFor("连接 FANBOX 创作者");
  await terminal.send("customudon");
  await terminal.waitFor("customudon");
  await terminal.send("\r");
  await terminal.waitFor("限时配对码：");

  const prompt = terminal.output();
  const instanceId = matchAfter(prompt, /目标实例：\s*([0-9a-f-]{36})/iu);
  const requestId = matchAfter(prompt, /请求编号：\s*([0-9a-f-]{36})/iu);
  const pairingCode = matchAfter(prompt, /限时配对码：\s*([A-Za-z0-9_-]{43})/u);
  const builtExtensionDirectory = fileURLToPath(
    import.meta.resolve("@digital/fanbox-extension/extension"),
  );
  const profile = await mkdtemp(
    path.join(tmpdir(), "digital-fanbox-chromium-"),
  );
  temporaryRoots.push(profile);
  const extensionDirectory = path.join(profile, "extension");
  await cp(builtExtensionDirectory, extensionDirectory, { recursive: true });
  const manifestPath = path.join(extensionDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    optional_host_permissions?: string[];
    host_permissions?: string[];
  };
  delete manifest.optional_host_permissions;
  manifest.host_permissions = [
    `${baseUrl.origin}/*`,
    `${wrongTargetUrl.origin}/*`,
    "https://fanbox.cc/*",
    "https://*.fanbox.cc/*",
  ];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      "--no-sandbox",
    ],
  });
  browserContexts.push(context);
  const [existingWorker] = context.serviceWorkers();
  const worker =
    existingWorker ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  await fillPairing(popup, {
    serviceAddress: wrongTargetUrl.origin,
    instanceId,
    requestId,
    pairingCode,
  });
  await popup.getByRole("button", { name: "检查目标与创作者范围" }).click();
  await expect(popup.locator("#status")).toContainText("配对信息无效");
  expect(capturedContexts).toHaveLength(0);

  await popup.locator("#service-url").fill(baseUrl.origin);
  await popup.getByRole("button", { name: "检查目标与创作者范围" }).click();
  await expect(popup.locator("#scope")).toContainText("创作者范围：customudon");
  await expect(popup.locator("#scope")).toContainText(
    `目标实例：${instanceId}`,
  );
  await expect(
    popup.getByRole("button", { name: "使用此浏览器登录状态连接" }),
  ).toBeEnabled();

  await popup.getByRole("button", { name: "使用此浏览器登录状态连接" }).click();
  await expect(popup.locator("#status")).toContainText("没有 FANBOX 登录会话");
  expect(capturedContexts).toHaveLength(0);
  expect((await client.getFanboxConnectionRequest(requestId)).status).toBe(
    "waiting",
  );

  await context.addCookies([
    {
      name: "FANBOXSESSID",
      value: "synthetic-controlled-session-value",
      domain: ".fanbox.cc",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "None",
    },
  ]);
  await popup.getByRole("button", { name: "使用此浏览器登录状态连接" }).click();
  await expect(popup.locator("#status")).toContainText("正在由目标服务验证");
  await verificationGate.started;
  await terminal.waitFor("当前状态：正在验证 FANBOX 登录状态");
  verificationGate.release();
  await expect(popup.locator("#status")).toContainText("FANBOX 连接成功", {
    timeout: 20_000,
  });
  await expect
    .poll(
      async () => (await client.getFanboxConnectionRequest(requestId)).status,
    )
    .toBe("succeeded");
  expect(capturedContexts).toHaveLength(1);
  expect(capturedContexts[0]).toMatchObject({
    creatorId: "customudon",
    cookieValue: "synthetic-controlled-session-value",
  });
  expect(capturedContexts[0]?.userAgent).toBeTruthy();
  expect(JSON.stringify(await fanboxConnection(client))).not.toContain(
    "synthetic-controlled-session-value",
  );
  expect(terminal.output()).not.toContain("synthetic-controlled-session-value");

  await terminal.send("q");
  await terminal.waitFor("FANBOX customudon：可用");
  const secondCreatorPromptOffset = terminal.output().length;
  await terminal.send("f");
  await terminal.waitForAfter("连接 FANBOX 创作者", secondCreatorPromptOffset);
  const secondCreatorValueOffset = terminal.output().length;
  await terminal.send("customudon");
  await terminal.waitForAfter("customudon", secondCreatorValueOffset);
  const secondPairingPromptOffset = terminal.output().length;
  await terminal.send("\r");
  await terminal.waitForAfter("限时配对码：", secondPairingPromptOffset);
  const failedPrompt = terminal.output();
  const failedInstanceId = matchAfter(
    failedPrompt,
    /目标实例：\s*([0-9a-f-]{36})/iu,
  );
  const failedRequestId = matchAfter(
    failedPrompt,
    /请求编号：\s*([0-9a-f-]{36})/iu,
  );
  const failedPairingCode = matchAfter(
    failedPrompt,
    /限时配对码：\s*([A-Za-z0-9_-]{43})/u,
  );
  await fillPairing(popup, {
    serviceAddress: baseUrl.origin,
    instanceId: failedInstanceId,
    requestId: failedRequestId,
    pairingCode: failedPairingCode,
  });
  await popup.getByRole("button", { name: "检查目标与创作者范围" }).click();
  await expect(popup.locator("#status")).toContainText("请核对上方服务实例");
  await expect(popup.locator("#scope")).toContainText("创作者范围：customudon");
  await expect(
    popup.getByRole("button", { name: "使用此浏览器登录状态连接" }),
  ).toBeEnabled();
  await context.clearCookies();
  await context.addCookies([
    {
      name: "FANBOXSESSID",
      value: "synthetic-rejected-session-value",
      domain: ".fanbox.cc",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "None",
    },
  ]);
  await popup.getByRole("button", { name: "使用此浏览器登录状态连接" }).click();
  await expect(popup.locator("#status")).toContainText("验证失败", {
    timeout: 20_000,
  });
  await expect
    .poll(
      async () =>
        (await client.getFanboxConnectionRequest(failedRequestId)).status,
    )
    .toBe("failed");
  await terminal.waitFor("当前状态：验证失败");
  expect(capturedContexts.map(({ cookieValue }) => cookieValue)).toEqual([
    "synthetic-controlled-session-value",
    "synthetic-rejected-session-value",
  ]);
  expect(JSON.stringify(await fanboxConnection(client))).not.toContain(
    "synthetic-rejected-session-value",
  );

  expect((await fanboxConnection(client)).version).toBe(1);
  const replacementListOffset = terminal.output().length;
  await terminal.send("q");
  await terminal.waitForAfter("FANBOX customudon：可用", replacementListOffset);
  const replacementCreatorOffset = terminal.output().length;
  await terminal.send("f");
  await terminal.waitForAfter("连接 FANBOX 创作者", replacementCreatorOffset);
  const replacementCreatorValueOffset = terminal.output().length;
  await terminal.send("customudon");
  await terminal.waitForAfter("customudon", replacementCreatorValueOffset);
  const replacementPairingOffset = terminal.output().length;
  await terminal.send("\r");
  await terminal.waitForAfter("限时配对码：", replacementPairingOffset);
  const replacementPrompt = terminal.output();
  const replacementInstanceId = matchAfter(
    replacementPrompt,
    /目标实例：\s*([0-9a-f-]{36})/iu,
  );
  const replacementRequestId = matchAfter(
    replacementPrompt,
    /请求编号：\s*([0-9a-f-]{36})/iu,
  );
  const replacementPairingCode = matchAfter(
    replacementPrompt,
    /限时配对码：\s*([A-Za-z0-9_-]{43})/u,
  );
  await fillPairing(popup, {
    serviceAddress: baseUrl.origin,
    instanceId: replacementInstanceId,
    requestId: replacementRequestId,
    pairingCode: replacementPairingCode,
  });
  await popup.getByRole("button", { name: "检查目标与创作者范围" }).click();
  await expect(popup.locator("#status")).toContainText("请核对上方服务实例");
  await expect(
    popup.getByRole("button", { name: "使用此浏览器登录状态连接" }),
  ).toBeEnabled();
  await context.clearCookies();
  await context.addCookies([
    {
      name: "FANBOXSESSID",
      value: "synthetic-replacement-session-value",
      domain: ".fanbox.cc",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "None",
    },
  ]);
  await popup.getByRole("button", { name: "使用此浏览器登录状态连接" }).click();
  await expect(popup.locator("#status")).toContainText("FANBOX 连接成功", {
    timeout: 20_000,
  });
  await expect
    .poll(
      async () =>
        (await client.getFanboxConnectionRequest(replacementRequestId)).status,
    )
    .toBe("succeeded");
  await terminal.waitFor("当前状态：连接成功");
  expect((await fanboxConnection(client)).version).toBe(2);
  expect(capturedContexts.map(({ cookieValue }) => cookieValue)).toEqual([
    "synthetic-controlled-session-value",
    "synthetic-rejected-session-value",
    "synthetic-replacement-session-value",
  ]);
  expect(JSON.stringify(await fanboxConnection(client))).not.toContain(
    "synthetic-replacement-session-value",
  );
  expect(terminal.output()).not.toContain(
    "synthetic-replacement-session-value",
  );

  const finalListOffset = terminal.output().length;
  await terminal.send("q");
  await terminal.waitForAfter("FANBOX customudon：可用", finalListOffset);
  const mainMenuOffset = terminal.output().length;
  await terminal.send("q");
  await terminal.waitForAfter("3 未识别材料", mainMenuOffset);
  await terminal.send("q");
  expect(await terminal.close()).toBe(0);
  expect(terminal.output()).toContain("TERMINAL_RESTORED");
}, 60_000);

async function startService(
  sessionTransport: FanboxEndpointSessionTransport,
): Promise<URL> {
  const root = await mkdtemp(path.join(tmpdir(), "digital-fanbox-extension-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  await prepareProductionCatalogue({ productDataDirectory });
  const bootstrap = await createProductService(
    {
      productDataDirectory,
      environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
      sourceIo: {
        mode: "controlled",
        request: async () => {
          throw new Error("受控 FANBOX 验收不允许未声明的普通来源请求");
        },
        sessionTransport,
      },
    },
    { lifecycle: createIsolatedLifecycle() },
  );
  bootstraps.push(bootstrap);
  const server = serve({
    fetch: bootstrap.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  servers.push(server);
  await server.ready();
  bootstrap.publish();
  const baseUrl = new URL(server.url!);
  await waitUntilReady(baseUrl);
  return baseUrl;
}

function controlledSourceIo(
  verificationGate?: ReturnType<typeof createVerificationGate>,
): FanboxEndpointSessionTransport {
  let gateUsed = false;
  return {
    async transact(input) {
      const cookie = input.privateContext.cookies.find(
        ({ name }) => name === "FANBOXSESSID",
      );
      if (cookie === undefined)
        throw new Error("受控会话缺少 FANBOX 登录 Cookie");
      capturedContexts.push({
        creatorId: input.creatorId,
        cookieValue: cookie.value,
        userAgent: input.privateContext.userAgent,
      });
      if (
        cookie.value === "synthetic-controlled-session-value" &&
        verificationGate !== undefined &&
        !gateUsed
      ) {
        gateUsed = true;
        verificationGate.markStarted();
        await verificationGate.wait;
      }
      return await input.use(async (endpoint) => {
        const body =
          cookie.value === "synthetic-rejected-session-value"
            ? { error: "controlled rejection" }
            : responseFor(endpoint);
        return {
          kind: "response",
          status: 200,
          mediaType: "application/json",
          body: new TextEncoder().encode(JSON.stringify(body)),
        };
      });
    },
    async close() {},
  };
}

function createVerificationGate() {
  let release!: () => void;
  let markStarted!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return { started, wait, release, markStarted };
}

function responseFor(endpoint: { readonly kind: string }): unknown {
  switch (endpoint.kind) {
    case "login-status":
      return { body: 0 };
    case "creator-summaries":
      return {
        body: {
          posts: [
            {
              id: "9135862",
              creatorId: "customudon",
              title: "受控验收帖子",
              publishedDatetime: "2025-01-01T00:00:00+09:00",
            },
          ],
        },
      };
    case "post-detail":
      return {
        body: {
          post: {
            id: "9135862",
            creatorId: "customudon",
            title: "受控验收帖子",
            publishedDatetime: "2025-01-01T00:00:00+09:00",
          },
        },
      };
    default:
      throw new Error("FANBOX 适配器请求了未定义的验收端点");
  }
}

function refusingSourceIo(): FanboxEndpointSessionTransport {
  return refusingSessionTransport();
}

async function fanboxConnection(
  client: ReturnType<typeof createPublicApiClient>,
) {
  const connections = await client.listSourceConnections();
  const connection = connections.items.find(
    ({ id }) => id === "fanbox/customudon",
  );
  if (connection === undefined) throw new Error("FANBOX 私密连接没有写入");
  return connection;
}

function createIsolatedLifecycle() {
  return createProcessLifecycleRegistry({
    addSignalListener() {},
    removeSignalListener() {},
    forceExit() {},
  });
}

async function waitUntilReady(baseUrl: URL): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await fetch(new URL("/api/v1/source-connections", baseUrl))).ok)
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("受控 FANBOX 服务未就绪");
}

async function startTui(serviceAddress: string) {
  const terminalCommand = [
    "stty cols 100 rows 24 -icanon -echo",
    "terminalModeBefore=$(stty -g)",
    `pnpm --filter @digital/service exec digital-tui --url ${shellQuote(serviceAddress)}`,
    "terminalModeAfter=$(stty -g)",
    'if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi',
  ].join("; ");
  const child = spawn("script", ["-qfec", terminalCommand, "/dev/null"], {
    cwd: process.cwd(),
    env: interactiveTerminalEnvironment({
      TERM: "xterm-256color",
      COLUMNS: "100",
      LINES: "24",
    }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  terminalChildren.push(child);
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  return {
    output: () => stripAnsi(output),
    async waitFor(text: string, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stripAnsi(output).includes(text)) return;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `TUI 未显示“${text}”：${errors}\n${stripAnsi(output).slice(-3000)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `TUI 未显示“${text}”：${errors}\n${stripAnsi(output).slice(-3000)}`,
      );
    },
    async waitForAfter(text: string, offset: number, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stripAnsi(output).slice(offset).includes(text)) return;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `TUI 未显示新的“${text}”：${errors}\n${stripAnsi(output).slice(-3000)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `TUI 未显示新的“${text}”：${errors}\n${stripAnsi(output).slice(-3000)}`,
      );
    },
    async send(text: string) {
      child.stdin.write(text);
      await new Promise((resolve) => setTimeout(resolve, 120));
    },
    async close() {
      child.stdin.end();
      const exitCode = await closed;
      if (child.pid !== undefined && process.platform !== "win32")
        terminalChildren.splice(terminalChildren.indexOf(child), 1);
      return exitCode;
    },
  };
}

async function fillPairing(
  popup: Page,
  input: {
    readonly serviceAddress: string;
    readonly instanceId: string;
    readonly requestId: string;
    readonly pairingCode: string;
  },
): Promise<void> {
  await popup.locator("#service-url").fill(input.serviceAddress);
  await popup.locator("#instance-id").fill(input.instanceId);
  await popup.locator("#request-id").fill(input.requestId);
  await popup.locator("#pairing-code").fill(input.pairingCode);
}

function matchAfter(value: string, pattern: RegExp): string {
  const matches = [...value.matchAll(new RegExp(pattern.source, "gu"))];
  const match = matches.at(-1);
  if (match?.[1] === undefined)
    throw new Error("TUI 没有显示完整 FANBOX 配对信息");
  return match[1];
}

function stripAnsi(value: string): string {
  let stripped = "";
  let inEscapeSequence = false;
  for (const character of value) {
    if (inEscapeSequence) {
      if (character >= "@" && character <= "~") inEscapeSequence = false;
    } else if (character === String.fromCharCode(27)) {
      inEscapeSequence = true;
    } else stripped += character;
  }
  return stripped;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
