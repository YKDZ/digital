import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProduct } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import { createPublicHttpApi } from "@digital/http-delivery";
import type {
  ProductApplication,
  ProductAutomationHostOptions,
} from "@digital/product-application";
import { createPublicApiClient } from "@digital/public-api";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
  resolveSourceIoFromEnvironment,
} from "@digital/test-support/source-io";
import { Hono } from "hono";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { createProductService } from "../src/service.ts";
import { interactiveTerminalEnvironment } from "./interactive-terminal.ts";

const servers: Array<Awaited<ReturnType<typeof serve>>> = [];
const bootstraps: Array<Awaited<ReturnType<typeof createProductService>>> = [];
type TestProduct = ReturnType<typeof runProduct<ProductApplication>>;
const products: TestProduct[] = [];
const temporaryRoots: string[] = [];
const terminals: Array<ReturnType<typeof spawn>> = [];
const sourceGateReleases: Array<() => void> = [];
const servicePackageRoot = fileURLToPath(new URL("../", import.meta.url));
const audioMaterialRoot = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/material"),
);
const audioManifestPath = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/manifest.json"),
);

afterEach(async () => {
  for (const release of sourceGateReleases.splice(0).reverse()) release();
  for (const terminal of terminals.splice(0).reverse()) {
    if (terminal.pid !== undefined && terminal.exitCode === null) {
      try {
        process.kill(-terminal.pid, "SIGTERM");
      } catch {
        terminal.kill("SIGTERM");
      }
    }
  }
  for (const server of servers.splice(0).reverse()) await server.close(true);
  for (const bootstrap of bootstraps.splice(0).reverse())
    await bootstrap.abort();
  for (const product of products.splice(0).reverse()) await product.close();
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("通过公共 HTTP 查询持久自动刷新配置", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc18-automation-http-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  await prepareProductionCatalogue({ productDataDirectory });
  const sourceIo = await resolveSourceIoFromEnvironment({
    DIGITAL_SOURCE_MODE: "offline",
  });
  const bootstrap = await createProductService({
    productDataDirectory,
    environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
    sourceIo,
  });
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

  await expect
    .poll(async () => (await fetch(new URL("/api/ready", baseUrl))).status)
    .toBe(200);
  const client = createPublicApiClient({ baseUrl });
  await expect(client.listAutomationIntents()).resolves.toEqual({ items: [] });
});

it("将未知自动刷新查询故障转成不泄漏内部错误的 503", async () => {
  const api = createPublicHttpApi({
    workflow: {
      listAutomationIntents: async () => {
        throw new Error("sensitive sqlite detail");
      },
    },
  } as never);
  const response = await api.request("/automation-intents");
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    error: {
      code: "unavailable",
      message: "暂时无法读取自动刷新设置",
    },
  });
});

it("客户端退出并重启服务后保留自动刷新设置，按到期策略执行且停用后不再自动运行", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc18-due-automation-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const observedDirectory = path.join(root, "普通目录");
  await mkdir(observedDirectory);
  await prepareProductionCatalogue({ productDataDirectory });
  const sourceIo = await resolveSourceIoFromEnvironment({
    DIGITAL_SOURCE_MODE: "offline",
  });
  const now = { value: new Date() };
  const firstClock = controlledAutomationClock(now);
  const firstProduct = runProduct(
    {
      productDataDirectory,
      environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
      sourceIo,
    },
    { start: (application) => application },
  );
  products.push(firstProduct);
  await firstProduct.result.startAutomation({
    clock: firstClock.clock,
    pollIntervalMilliseconds: 1_000,
  });
  const firstServer = await startProductApi(firstProduct);
  const firstClient = createPublicApiClient({ baseUrl: firstServer.baseUrl });
  const options = await firstClient.listAssetLibraryOptions();
  const library = await firstClient.saveAssetLibrary({
    displayName: "自动刷新验收库",
    directories: [observedDirectory],
    recognitionProfileIds: options.recognitionProfiles.map(({ id }) => id),
    sourceIdentities: [],
  });
  const directory = library.directories.find(
    ({ status }) => status === "active",
  );
  if (directory === undefined) throw new Error("资产库没有返回活动目录");
  const automationUrl = new URL(
    "api/v1/automation-intents",
    firstServer.baseUrl,
  );
  const invalidRequest = await fetch(automationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assetLibraryId: library.id,
      directoryId: directory.id,
      intervalMilliseconds: 0,
      acceptTrusted: true,
    }),
  });
  expect(invalidRequest.status).toBe(400);
  await expect(invalidRequest.json()).resolves.toMatchObject({
    error: { code: "invalid-request" },
  });
  const staleDirectory = await fetch(automationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assetLibraryId: library.id,
      directoryId: "已撤销的目录授权",
      intervalMilliseconds: 60_000,
      acceptTrusted: true,
    }),
  });
  expect(staleDirectory.status).toBe(409);
  await expect(staleDirectory.json()).resolves.toMatchObject({
    error: { code: "conflict" },
  });
  for (const relativeScope of ["../outside", "/tmp"]) {
    const invalidScope = await fetch(automationUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assetLibraryId: library.id,
        directoryId: directory.id,
        relativeScope,
        intervalMilliseconds: 60_000,
        acceptTrusted: true,
      }),
    });
    expect(invalidScope.status).toBe(400);
    await expect(invalidScope.json()).resolves.toEqual({
      error: {
        code: "invalid-request",
        message: "自动刷新设置无效",
      },
    });
  }
  await expect(firstClient.listAutomationIntents()).resolves.toEqual({
    items: [],
  });
  const enabled = await firstClient.enableAutomationIntent({
    assetLibraryId: library.id,
    directoryId: directory.id,
    intervalMilliseconds: 60_000,
    acceptTrusted: true,
  });
  expect(enabled.intent).toMatchObject({
    scope: {
      assetLibraryId: library.id,
      directoryId: directory.id,
      relativeScope: ".",
    },
    enabled: true,
    intervalMilliseconds: 60_000,
    acceptTrusted: true,
  });
  expect(enabled.initial?.status).toBe("started");
  const initial = enabled.initial;
  if (initial?.status !== "started")
    throw new Error("首次自动刷新没有返回执行身份");
  const initialExecutionId = initial.executionId;
  await expect
    .poll(async () => await firstClient.inspectExecution(initialExecutionId))
    .toMatchObject({
      kind: "asset-library-scan",
      id: initialExecutionId,
      status: "completed",
    });
  const initialHistory = await firstClient.listWorkflowHistory({ limit: 100 });
  const initialIds = initialHistory.items.map(({ execution }) => execution.id);
  expect(initialIds).toContain(initialExecutionId);
  expect(
    initialHistory.items.some(
      ({ execution }) =>
        execution.id === initialExecutionId &&
        execution.automationIntentId === enabled.intent.id,
    ),
  ).toBe(true);

  await closeProductApi(firstServer);
  await closeProduct(firstProduct);

  const secondClock = controlledAutomationClock(now);
  const secondProduct = runProduct(
    {
      productDataDirectory,
      environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
      sourceIo,
    },
    { start: (application) => application },
  );
  products.push(secondProduct);
  await secondProduct.result.startAutomation({
    clock: secondClock.clock,
    pollIntervalMilliseconds: 1_000,
  });
  const secondServer = await startProductApi(secondProduct);
  const secondClient = createPublicApiClient({ baseUrl: secondServer.baseUrl });
  await expect(secondClient.listAutomationIntents()).resolves.toMatchObject({
    items: [
      expect.objectContaining({
        id: enabled.intent.id,
        enabled: true,
        intervalMilliseconds: 60_000,
      }),
    ],
  });
  const historyAfterRestart = await secondClient.listWorkflowHistory({
    limit: 100,
  });
  expect(
    historyAfterRestart.items.map(({ execution }) => execution.id).toSorted(),
  ).toEqual(initialIds.toSorted());

  now.value = new Date(now.value.getTime() + 61_000);
  secondClock.tick();
  await secondProduct.result.automation.settled();
  const dueHistory = await secondClient.listWorkflowHistory({ limit: 100 });
  expect(dueHistory.items).toHaveLength(initialHistory.items.length + 2);
  const dueExecutionId = dueHistory.items
    .map(({ execution }) => execution)
    .find(
      (execution) =>
        execution.operationKind === "scan-asset-library" &&
        !initialIds.includes(execution.id) &&
        execution.automationIntentId === enabled.intent.id,
    )?.id;
  if (dueExecutionId === undefined)
    throw new Error("到期自动刷新没有新增执行记录");
  await expect
    .poll(async () => await secondClient.inspectExecution(dueExecutionId))
    .toMatchObject({
      kind: "asset-library-scan",
      id: dueExecutionId,
      status: "completed",
    });

  await expect(
    secondClient.disableAutomationIntent(enabled.intent.id),
  ).resolves.toEqual({ status: "disabled" });
  await expect(secondClient.listAutomationIntents()).resolves.toMatchObject({
    items: [expect.objectContaining({ id: enabled.intent.id, enabled: false })],
  });
  const historyAfterDisable = await secondClient.listWorkflowHistory({
    limit: 100,
  });
  now.value = new Date(now.value.getTime() + 61_000);
  secondClock.tick();
  await secondProduct.result.automation.settled();
  const afterDisabledTick = await secondClient.listWorkflowHistory({
    limit: 100,
  });
  expect(
    afterDisabledTick.items.map(({ execution }) => execution.id).toSorted(),
  ).toEqual(
    historyAfterDisable.items.map(({ execution }) => execution.id).toSorted(),
  );
  const manual = await secondClient.triggerAutomationIntent(enabled.intent.id);
  expect(manual.status).toBe("started");
  if (manual.status !== "started") throw new Error("立即刷新没有开始");
  await expect
    .poll(async () => await secondClient.inspectExecution(manual.executionId))
    .toMatchObject({
      kind: "asset-library-scan",
      id: manual.executionId,
      status: "completed",
    });
}, 60_000);

it("公共 HTTP 自动刷新沿用冻结的产品信息需求，并在客户端断开后完成受控来源刷新", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc18-automation-product-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const observedDirectory = path.join(root, "RJ01668691");
  await cp(path.join(audioMaterialRoot, "RJ01668691"), observedDirectory, {
    recursive: true,
  });
  await prepareProductionCatalogue({ productDataDirectory });
  const controlled = await loadControlledSourceIo({
    manifestPath: audioManifestPath,
  });
  const requested: string[] = [];
  const productInfoUrl =
    "https://www.dlsite.com/maniax/product/info/ajax?product_id=RJ01668691";
  let pendingManualRequest:
    | {
        readonly entered: () => void;
        readonly release: Promise<void>;
      }
    | undefined;
  let releaseCover!: () => void;
  const coverGate = new Promise<void>((resolve) => {
    releaseCover = resolve;
  });
  sourceGateReleases.push(releaseCover);
  let markCoverRequested!: () => void;
  const coverRequested = new Promise<void>((resolve) => {
    markCoverRequested = resolve;
  });
  const coverUrl =
    "https://img.dlsite.jp/modpub/images2/work/doujin/RJ01669000/RJ01668691_img_main.jpg";
  const sourceIo = {
    mode: "controlled" as const,
    async request(
      url: string,
      init?: Parameters<typeof controlled.request>[1],
    ) {
      requested.push(url);
      if (url === coverUrl) {
        markCoverRequested();
        await coverGate;
      }
      if (url === productInfoUrl && pendingManualRequest !== undefined) {
        const gate = pendingManualRequest;
        pendingManualRequest = undefined;
        gate.entered();
        await gate.release;
      }
      return await controlled.request(url, init);
    },
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  const product = runProduct(
    {
      productDataDirectory,
      environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
      sourceIo,
    },
    { start: (application) => application },
  );
  products.push(product);
  await product.result.startAutomation({ pollIntervalMilliseconds: 1_000 });
  const firstServer = await startProductApi(product);
  const firstClient = createPublicApiClient({ baseUrl: firstServer.baseUrl });
  const options = await firstClient.listAssetLibraryOptions();
  expect(options.recognitionProfiles.map(({ id }) => id)).toContain(
    "dlsite-voice",
  );
  expect(options.sources.map(({ id }) => id)).toContain("dlsite");
  const library = await firstClient.saveAssetLibrary({
    displayName: "产品需求自动刷新验收库",
    directories: [observedDirectory],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: ["dlsite"],
  });
  const directory = library.directories[0];
  if (directory === undefined) throw new Error("自动刷新验收库没有目录");
  const enabled = await firstClient.enableAutomationIntent({
    assetLibraryId: library.id,
    directoryId: directory.id,
    intervalMilliseconds: 60_000,
    acceptTrusted: true,
  });
  expect(enabled.initial?.status).toBe("started");
  if (enabled.initial?.status !== "started")
    throw new Error("自动刷新没有启动正式产品扫描");
  const executionId = enabled.initial.executionId;

  await coverRequested;
  await closeProductApi(firstServer);
  releaseCover();
  await expect
    .poll(async () => await product.result.workflow.inspect(executionId), {
      timeout: 30_000,
    })
    .toMatchObject({ execution: { status: "completed", outcome: "accepted" } });

  const secondServer = await startProductApi(product);
  const secondClient = createPublicApiClient({ baseUrl: secondServer.baseUrl });
  await expect
    .poll(async () => await secondClient.inspectExecution(executionId))
    .toMatchObject({ status: "completed", outcome: "accepted" });
  const page = await secondClient.listAssets({
    assetLibraryId: library.id,
    limit: 100,
  });
  const asset = page.items.find(({ sourceAssociations }) =>
    sourceAssociations.some(
      ({ sourceIdentity, nativeAddress }) =>
        sourceIdentity === "dlsite" && nativeAddress.includes("RJ01668691"),
    ),
  );
  expect(asset).toMatchObject({
    sourceArtifacts: expect.arrayContaining([
      expect.objectContaining({ role: "asset.primary-cover" }),
    ]),
    descriptions: expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.arrayContaining([
          expect.objectContaining({
            property: "asset.title",
            result: expect.objectContaining({ status: "resolved" }),
          }),
        ]),
      }),
    ]),
  });
  expect(requested).toContain(coverUrl);
  expect(requested).toContain(productInfoUrl);

  let releaseManualRequest!: () => void;
  const manualRequestGate = new Promise<void>((resolve) => {
    releaseManualRequest = resolve;
  });
  sourceGateReleases.push(releaseManualRequest);
  let markManualRequest!: () => void;
  let manualRequestWasEntered = false;
  const manualRequestEntered = new Promise<void>((resolve) => {
    markManualRequest = () => {
      manualRequestWasEntered = true;
      resolve();
    };
  });
  pendingManualRequest = {
    entered: markManualRequest,
    release: manualRequestGate,
  };
  const manualTrigger = secondClient.triggerAutomationIntent(enabled.intent.id);
  let manualExecutionId: string | undefined;
  try {
    const triggerRace = await Promise.race([
      manualTrigger.then((result) => ({ result })),
      manualRequestEntered.then(() => ({ blocked: true as const })),
    ]);
    if ("blocked" in triggerRace) {
      releaseManualRequest();
      await manualTrigger;
      throw new Error("手动自动刷新等待产品执行完成后才返回执行身份");
    }
    expect(triggerRace.result.status).toBe("started");
    if (triggerRace.result.status !== "started")
      throw new Error("手动自动刷新没有返回执行身份");
    manualExecutionId = triggerRace.result.executionId;
    await expect.poll(() => manualRequestWasEntered).toBe(true);
    await expect
      .poll(async () => await secondClient.inspectExecution(manualExecutionId!))
      .toMatchObject({
        id: manualExecutionId,
        kind: "asset-library-scan",
      });
  } finally {
    releaseManualRequest();
  }
  if (manualExecutionId === undefined)
    throw new Error("手动自动刷新没有返回执行身份");
  await expect
    .poll(async () => await secondClient.inspectExecution(manualExecutionId!))
    .toMatchObject({ status: "completed" });
}, 60_000);

it("已安装终端可配置、查询和触发自动刷新，退出不停止产品服务【安装客户端】", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc18-automation-tui-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const observedDirectory = path.join(root, "普通目录");
  await mkdir(path.join(observedDirectory, "n"), { recursive: true });
  await mkdir(path.join(observedDirectory, "m"), { recursive: true });
  await prepareProductionCatalogue({ productDataDirectory });
  const sourceIo = await resolveSourceIoFromEnvironment({
    DIGITAL_SOURCE_MODE: "offline",
  });
  const product = runProduct(
    {
      productDataDirectory,
      environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
      sourceIo,
    },
    { start: (application) => application },
  );
  products.push(product);
  await product.result.startAutomation({ pollIntervalMilliseconds: 1_000 });
  const service = await startProductApi(product);
  const client = createPublicApiClient({ baseUrl: service.baseUrl });
  const options = await client.listAssetLibraryOptions();
  const library = await client.saveAssetLibrary({
    displayName: "终端验收库",
    directories: [observedDirectory],
    recognitionProfileIds: options.recognitionProfiles.map(({ id }) => id),
    sourceIdentities: [],
  });

  const terminalCommand = `stty cols 80 rows 24 -icanon -echo; pnpm --filter @digital/tui exec digital-tui --url ${service.baseUrl.origin}; printf '\\nTUI_EXITED\\n'`;
  const terminal = spawn("script", ["-qfec", terminalCommand, "/dev/null"], {
    cwd: servicePackageRoot,
    env: interactiveTerminalEnvironment({
      TERM: "xterm-256color",
      COLUMNS: "80",
      LINES: "24",
    }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  terminals.push(terminal);
  const output: Buffer[] = [];
  terminal.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  terminal.stderr.on("data", (chunk: Buffer) => output.push(chunk));
  const terminalText = () => Buffer.concat(output).toString("utf8");

  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes(library.displayName),
    "TUI 未显示正式资产库",
  );
  terminal.stdin.write("a");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes("自动刷新："),
    "TUI 未打开自动刷新设置",
  );
  terminal.stdin.write("i");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes("新设置：6 小时"),
    "TUI 未切换自动刷新间隔",
  );
  terminal.stdin.write("t");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes("信任结果：需审阅"),
    "TUI 未切换自动刷新信任策略",
  );
  terminal.stdin.write("f");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes("编辑中：."),
    "TUI 未打开扫描范围编辑",
  );
  const scopeEditOutputStart = terminalText().length;
  terminal.stdin.write("\u0015");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().slice(scopeEditOutputStart).includes("编辑中："),
    "TUI 未清空相对扫描范围输入",
  );
  terminal.stdin.write("n");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes("编辑中：n"),
    "TUI 未读取相对扫描范围输入",
  );
  terminal.stdin.write("\r");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes("扫描范围（相对目录）：n"),
    "TUI 未保存相对扫描范围",
  );
  terminal.stdin.write("e");
  await expect
    .poll(async () => await client.listAutomationIntents(), {
      timeout: 15_000,
    })
    .toMatchObject({
      items: [
        expect.objectContaining({
          scope: expect.objectContaining({
            assetLibraryId: library.id,
            relativeScope: "n",
          }),
          enabled: true,
          intervalMilliseconds: 21_600_000,
          acceptTrusted: false,
        }),
      ],
    });
  const configured = (await client.listAutomationIntents()).items[0];
  if (configured === undefined) throw new Error("终端没有创建自动刷新设置");
  const initialHistory = await client.listWorkflowHistory({ limit: 100 });
  const initialExecutionIds = initialHistory.items.map(
    ({ execution }) => execution.id,
  );

  const outputBeforeTrigger = terminalText().length;
  terminal.stdin.write("s");
  let triggered: string | undefined;
  await expect
    .poll(
      async () => {
        const history = await client.listWorkflowHistory({ limit: 100 });
        triggered = history.items.find(
          ({ execution }) =>
            execution.operationKind === "scan-asset-library" &&
            execution.automationIntentId === configured.id &&
            !initialExecutionIds.includes(execution.id),
        )?.execution.id;
        return triggered;
      },
      { timeout: 15_000 },
    )
    .toBeDefined();
  if (triggered === undefined) throw new Error("终端没有触发立即刷新");
  await expect
    .poll(async () => await client.inspectExecution(triggered!), {
      timeout: 15_000,
    })
    .toMatchObject({ kind: "asset-library-scan", status: "completed" });
  await waitForTerminalText(
    terminal,
    terminalText,
    () =>
      terminalText().slice(outputBeforeTrigger).includes("当前执行：无变更"),
    "TUI 未显示自动刷新实际结局",
  );
  terminal.stdin.write("d");
  await expect
    .poll(async () => await client.listAutomationIntents(), {
      timeout: 15_000,
    })
    .toMatchObject({
      items: [expect.objectContaining({ id: configured.id, enabled: false })],
    });

  const secondScopeEditOutputStart = terminalText().length;
  terminal.stdin.write("f");
  await waitForTerminalText(
    terminal,
    terminalText,
    () =>
      terminalText().slice(secondScopeEditOutputStart).includes("编辑中：n"),
    "TUI 未为停用的目录打开扫描范围编辑",
  );
  const clearSecondScopeOutputStart = terminalText().length;
  terminal.stdin.write("\u0015");
  await waitForTerminalText(
    terminal,
    terminalText,
    () =>
      terminalText().slice(clearSecondScopeOutputStart).includes("编辑中："),
    "TUI 未清空第二次扫描范围输入",
  );
  terminal.stdin.write("m");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes("编辑中：m"),
    "TUI 未读取第二次相对扫描范围",
  );
  terminal.stdin.write("\r");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes("扫描范围（相对目录）：m"),
    "TUI 未保存第二次相对扫描范围",
  );
  terminal.stdin.write("e");
  let latestConfigured: typeof configured | undefined;
  await expect
    .poll(async () => {
      const intents = await client.listAutomationIntents();
      latestConfigured = intents.items.at(-1);
      return intents.items.map(({ id, scope, enabled }) => ({
        id,
        relativeScope: scope.relativeScope,
        enabled,
      }));
    })
    .toEqual([
      { id: configured.id, relativeScope: "n", enabled: false },
      expect.objectContaining({ relativeScope: "m", enabled: true }),
    ]);
  if (latestConfigured === undefined)
    throw new Error("第二次启用没有创建新的自动刷新设置");
  expect(latestConfigured.id).not.toBe(configured.id);
  await expect
    .poll(async () => {
      const history = await client.listWorkflowHistory({ limit: 100 });
      return history.items.find(
        ({ execution }) =>
          execution.automationIntentId === latestConfigured?.id &&
          execution.operationKind === "scan-asset-library",
      )?.execution.status;
    })
    .toBe("completed");
  const disableLatestOutputStart = terminalText().length;
  terminal.stdin.write("d");
  await expect
    .poll(async () => await client.listAutomationIntents(), {
      timeout: 15_000,
    })
    .toMatchObject({
      items: [
        expect.objectContaining({ id: configured.id, enabled: false }),
        expect.objectContaining({ id: latestConfigured.id, enabled: false }),
      ],
    });
  await waitForTerminalText(
    terminal,
    terminalText,
    () => {
      const currentOutput = terminalText().slice(disableLatestOutputStart);
      return (
        currentOutput.includes("扫描范围（相对目录）：m") &&
        currentOutput.includes("已停用")
      );
    },
    "TUI 未显示最新的已停用扫描范围",
  );
  const outputBeforeLatestTrigger = terminalText().length;
  const historyBeforeLatestTrigger = await client.listWorkflowHistory({
    limit: 100,
  });
  const previousExecutionIds = new Set(
    historyBeforeLatestTrigger.items.map(({ execution }) => execution.id),
  );
  terminal.stdin.write("s");
  let latestTriggeredIntentId: string | undefined;
  let latestTriggeredExecutionId: string | undefined;
  await expect
    .poll(
      async () => {
        const history = await client.listWorkflowHistory({ limit: 100 });
        const execution = history.items.find(
          ({ execution }) =>
            execution.operationKind === "scan-asset-library" &&
            !previousExecutionIds.has(execution.id),
        )?.execution;
        latestTriggeredIntentId = execution?.automationIntentId;
        latestTriggeredExecutionId = execution?.id;
        return latestTriggeredIntentId;
      },
      { timeout: 15_000 },
    )
    .toBe(latestConfigured.id);
  if (latestTriggeredExecutionId === undefined)
    throw new Error("终端没有触发最新自动刷新设置");
  await expect
    .poll(
      async () => await client.inspectExecution(latestTriggeredExecutionId!),
    )
    .toMatchObject({ kind: "asset-library-scan", status: "completed" });
  await waitForTerminalText(
    terminal,
    terminalText,
    () =>
      terminalText()
        .slice(outputBeforeLatestTrigger)
        .includes("当前执行：无变更"),
    "TUI 未显示最新设置所触发的执行结局",
  );
  const outputBeforeReturn = terminalText().length;
  terminal.stdin.write("q");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().slice(outputBeforeReturn).includes("a 自动刷新"),
    "TUI 未返回资产库菜单",
  );
  terminal.stdin.write("q");
  await waitForTerminalText(
    terminal,
    terminalText,
    () => terminalText().includes("TUI_EXITED"),
    "TUI 未能正常退出",
  );
  const history = await client.listWorkflowHistory({ limit: 100 });
  const publicIds = [
    configured.id,
    latestConfigured.id,
    ...history.items.map(({ execution }) => execution.id),
  ];
  expect(publicIds.every((id) => !terminalText().includes(id))).toBe(true);
  expect(terminalText()).not.toContain(observedDirectory);
  expect(JSON.stringify(await client.listAutomationIntents())).not.toContain(
    observedDirectory,
  );
  await expect(client.listAutomationIntents()).resolves.toMatchObject({
    items: [
      expect.objectContaining({ id: configured.id, enabled: false }),
      expect.objectContaining({ id: latestConfigured.id, enabled: false }),
    ],
  });
}, 60_000);

function controlledAutomationClock(now: { value: Date }) {
  type AutomationClock = NonNullable<ProductAutomationHostOptions["clock"]>;
  let poll: (() => void) | undefined;
  const clock: AutomationClock = {
    now: () => new Date(now.value),
    setInterval(callback, milliseconds) {
      if (milliseconds !== 1_000)
        throw new Error("自动刷新轮询间隔与验收配置不一致");
      poll = callback;
      return "ewc18-automation-clock";
    },
    clearInterval() {
      poll = undefined;
    },
  };
  return {
    clock,
    tick() {
      if (poll === undefined) throw new Error("自动刷新宿主尚未启动");
      poll();
    },
  };
}

async function startProductApi(product: TestProduct) {
  const api = new Hono().route("/api/v1", createPublicHttpApi(product.result));
  const server = serve({
    fetch: api.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  servers.push(server);
  await server.ready();
  return { server, baseUrl: new URL(server.url!) };
}

async function closeProductApi(service: {
  readonly server: Awaited<ReturnType<typeof serve>>;
}) {
  const index = servers.indexOf(service.server);
  if (index >= 0) servers.splice(index, 1);
  await service.server.close(true);
}

async function closeProduct(product: TestProduct) {
  const index = products.indexOf(product);
  if (index >= 0) products.splice(index, 1);
  await product.close();
}

async function waitForTerminalText(
  terminal: ReturnType<typeof spawn>,
  output: () => string,
  condition: () => boolean,
  description: string,
) {
  await expect
    .poll(
      () => {
        const satisfied = condition();
        if (satisfied) return true;
        if (terminal.exitCode !== null || terminal.signalCode !== null)
          throw new Error(
            `${description}；TUI 已退出：${output().slice(-1500)}`,
          );
        return false;
      },
      {
        timeout: 15_000,
        message: `${description}；终端输出 ${output().slice(-1500)}`,
      },
    )
    .toBe(true);
}
