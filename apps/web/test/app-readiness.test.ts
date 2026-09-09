import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  catalogueReadinessFailure,
  createWebDelivery,
  type WebDelivery,
} from "@digital/web-delivery";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createWebServer,
  shouldRetainWebProcessTemporaryRoot,
} from "#/server/app";
import {
  createProcessLifecycleRegistry,
  processLifecycle,
} from "#/server/process-lifecycle";
import { createWebProcessTemporaryRootClaimRegistry } from "#/server/process-temporary-root";

import { prepareWebProductData } from "./prepare-catalogue";

function createTestLifecycle(
  closeTerminalProcessResources: () => Promise<void> = async () => undefined,
) {
  const listeners = new Map<NodeJS.Signals, () => void | Promise<void>>();
  const lifecycle = createProcessLifecycleRegistry(
    {
      addSignalListener(signal, listener) {
        listeners.set(signal, listener);
      },
      removeSignalListener(signal, listener) {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
      forceExit() {},
    },
    { closeTerminalProcessResources },
  );
  return {
    lifecycle,
    async signal(signal: NodeJS.Signals) {
      await listeners.get(signal)?.();
    },
  };
}

describe("catalogue startup delivery gates", () => {
  it("真实 Web replacement 在前驱 publish 后才创建第二个 delivery", async () => {
    const harness = createTestLifecycle();
    const events: string[] = [];
    let second!: ReturnType<typeof createWebServer>;
    const makeDelivery = (): WebDelivery => ({
      api: new Hono(),
      catalogueReady: () => false,
      catalogueReadinessFailure: () => undefined,
      startCatalogueAutomation: async () => undefined,
    });
    const first = createWebServer(
      { environment: {} },
      {
        attachVike: false,
        lifecycle: harness.lifecycle,
        createDelivery() {
          events.push("create:A");
          queueMicrotask(() => {
            second = createWebServer(
              { environment: {} },
              {
                attachVike: false,
                lifecycle: harness.lifecycle,
                createDelivery() {
                  events.push("create:B");
                  return makeDelivery();
                },
              },
            );
          });
          return makeDelivery();
        },
      },
    );

    const firstBootstrap = await first;
    firstBootstrap.publish();
    events.push("publish:A");
    const secondBootstrap = await second;
    secondBootstrap.publish();

    expect(events).toEqual(["create:A", "publish:A", "create:B"]);
    await secondBootstrap.abort();
  });

  it("同 tick replacement 不能在前驱 app 发布前关闭前驱产品", async () => {
    const harness = createTestLifecycle();
    const order: string[] = [];
    const secondDelivery: WebDelivery = {
      api: new Hono(),
      catalogueReady: () => false,
      catalogueReadinessFailure: () => undefined,
      startCatalogueAutomation: async () => {
        order.push("assemble:B");
      },
    };
    const bootstrap = async (
      delivery: WebDelivery,
      closeProduct: () => Promise<void>,
    ) =>
      await createApp(delivery, {
        attachVike: false,
        lifecycle: harness.lifecycle,
        closeProduct,
      });
    let second!: ReturnType<typeof bootstrap>;
    const first = bootstrap(
      {
        api: new Hono(),
        catalogueReady: () => false,
        catalogueReadinessFailure: () => undefined,
        startCatalogueAutomation: async () => {
          order.push("assemble:A");
          second = bootstrap(secondDelivery, async () => {
            order.push("close:B");
          });
        },
      },
      async () => {
        order.push("close:A");
      },
    );

    const firstBootstrap = await first;
    firstBootstrap.publish();
    order.push("commit/publish:A");
    const secondBootstrap = await second;
    secondBootstrap.publish();

    expect(order.slice(0, 3)).toEqual([
      "assemble:A",
      "commit/publish:A",
      "close:A",
    ]);
    await secondBootstrap.abort();
  });

  it("injects one product application into Web delivery at the executable composition root", async () => {
    let configured: boolean | undefined;
    const bootstrap = await createWebServer(
      { environment: {} },
      {
        attachVike: false,
        createDelivery(application) {
          configured = application.configured;
          return {
            api: new Hono(),
            catalogueReady: () => false,
            catalogueReadinessFailure: () => undefined,
            shutdown: async () => undefined,
            startCatalogueAutomation: async () => undefined,
          };
        },
      },
    );
    bootstrap.publish();
    const app = bootstrap.app;

    await expect(app.request("/api/live")).resolves.toMatchObject({
      status: 200,
    });
    expect(configured).toBe(false);
  });

  it("未配置产品数据时仍启动 Web，但只开放存活与未就绪状态", async () => {
    const harness = createTestLifecycle();
    const bootstrap = await createWebServer(
      { environment: {} },
      {
        attachVike: false,
        lifecycle: harness.lifecycle,
        createDelivery: createWebDelivery,
      },
    );
    try {
      bootstrap.publish();
      await expect(bootstrap.app.request("/api/live")).resolves.toMatchObject({
        status: 200,
      });
      const readiness = await bootstrap.app.request("/api/ready");
      expect(readiness.status).toBe(503);
      await expect(readiness.json()).resolves.toMatchObject({
        diagnostic: expect.stringContaining("DIGITAL_PRODUCT_DATA"),
      });
    } finally {
      await bootstrap.abort();
    }
  });

  it("gives an actionable, path-free readiness reason when product data is not configured", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    delete process.env.DIGITAL_PRODUCT_DATA;
    try {
      expect(catalogueReadinessFailure()).toContain("DIGITAL_PRODUCT_DATA");
      expect(catalogueReadinessFailure()).not.toContain("/");
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });

  it("starts the newly bound product after the prior composition root closes in the same process", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-web-restart-"),
    );
    const productDataDirectory = path.join(root, "product-data");
    let closeReplacement: (() => Promise<void>) | undefined;
    try {
      await prepareWebProductData(productDataDirectory);
      const configuration = { productDataDirectory, environment: {} };
      let initialStart: Promise<void> | undefined;
      const initial = await createWebServer(configuration, {
        attachVike: false,
        createDelivery(application) {
          const startAutomation = application.startAutomation.bind(application);
          vi.spyOn(application, "startAutomation").mockImplementation(
            async (options) => {
              initialStart = startAutomation(options);
              await initialStart;
            },
          );
          return createWebDelivery(application);
        },
      });
      initial.publish();
      await initialStart;

      const replacement = processLifecycle.register({
        async shutdown() {},
      });
      closeReplacement = async () => await replacement.dispose();
      await replacement.ready;
      replacement.publish();

      let reboundStartCalls = 0;
      let reboundStart: Promise<void> | undefined;
      const reboundBootstrap = await createWebServer(configuration, {
        attachVike: false,
        createDelivery(application) {
          const startAutomation = application.startAutomation.bind(application);
          vi.spyOn(application, "startAutomation").mockImplementation(
            async (options) => {
              reboundStartCalls += 1;
              reboundStart = startAutomation(options);
              await reboundStart;
            },
          );
          return createWebDelivery(application);
        },
      });
      reboundBootstrap.publish();
      const rebound = reboundBootstrap.app;

      expect(reboundStartCalls).toBe(1);
      await reboundStart;
      await expect(rebound.request("/api/ready")).resolves.toMatchObject({
        status: 200,
      });
      await expect(rebound.request("/api/catalogue")).resolves.toMatchObject({
        status: 200,
      });
    } finally {
      const closer = processLifecycle.register({
        async shutdown() {},
      });
      await closer.ready;
      closer.publish();
      await closer.dispose();
      await closeReplacement?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("createDelivery 同步失败会关闭已登记的真实 ProductRun 并允许后继接管", async () => {
    const harness = createTestLifecycle();
    const failure = new Error("delivery failed");
    await expect(
      createWebServer(
        { environment: {} },
        {
          lifecycle: harness.lifecycle,
          createDelivery() {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);

    const replacement = await createWebServer(
      { environment: {} },
      {
        attachVike: false,
        lifecycle: harness.lifecycle,
        createDelivery() {
          return {
            api: new Hono(),
            catalogueReady: () => false,
            catalogueReadinessFailure: () => undefined,
            startCatalogueAutomation: async () => undefined,
          };
        },
      },
    );
    replacement.publish();
    await replacement.abort();
  });

  it("answers liveness immediately, keeps readiness and business admission closed while recovery waits, then admits after recovery", async () => {
    let releaseStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    let ready = false;
    let catalogueCalls = 0;
    const api = new Hono().get("/catalogue", (context) => {
      catalogueCalls += 1;
      return context.json({ catalogue: true });
    });
    const bootstrap = await createWebServer(
      { environment: {} },
      {
        api,
        startCatalogueAutomation: () => startup,
        catalogueReady: () => ready,
        attachVike: false,
        createDelivery() {
          return {
            api,
            catalogueReady: () => ready,
            catalogueReadinessFailure: () => undefined,
            shutdown: async () => undefined,
            startCatalogueAutomation: () => startup,
          };
        },
      },
    );
    bootstrap.publish();
    const app = bootstrap.app;

    await expect(app.request("/api/live")).resolves.toMatchObject({
      status: 200,
    });
    await expect(app.request("/api/ready")).resolves.toMatchObject({
      status: 503,
    });
    const pendingBusiness = app.request("/api/catalogue");
    await Promise.resolve();
    expect(catalogueCalls).toBe(0);

    releaseStartup();
    await expect(pendingBusiness).resolves.toMatchObject({ status: 503 });
    expect(catalogueCalls).toBe(0);
    ready = true;
    await expect(app.request("/api/ready")).resolves.toMatchObject({
      status: 200,
    });
    await expect(app.request("/api/catalogue")).resolves.toMatchObject({
      status: 200,
    });
    expect(catalogueCalls).toBe(1);
  });

  it("checks terminal admission before constructing a Web product", async () => {
    let constructed = 0;
    const harness = createTestLifecycle();
    await harness.signal("SIGTERM");

    await expect(
      createWebServer(
        { environment: {} },
        {
          attachVike: false,
          lifecycle: harness.lifecycle,
          createDelivery() {
            constructed += 1;
            throw new Error("must not construct");
          },
        },
      ),
    ).rejects.toThrow("进程正在关闭，不能启动内容目录");
    expect(constructed).toBe(0);
  });

  it("非生产 createApp 接管前双失败不能伪造进程根保留授权", async () => {
    const harness = createTestLifecycle();
    const closeFailure = new Error("product cleanup failed");
    await harness.signal("SIGTERM");

    const error = await createApp(
      {
        api: new Hono(),
        catalogueReady: () => false,
        catalogueReadinessFailure: () => undefined,
        startCatalogueAutomation: async () => undefined,
      },
      {
        attachVike: false,
        lifecycle: harness.lifecycle,
        async closeProduct() {
          throw closeFailure;
        },
      },
    ).catch((caught: unknown) => caught);

    expect(shouldRetainWebProcessTemporaryRoot(error)).toBe(false);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "进程正在关闭，不能启动内容目录" }),
      closeFailure,
    ]);
  });

  it("同名稳定 Symbol 不能伪造待清理所有者证据", () => {
    const errorFromPriorModule = Object.assign(
      new AggregateError([], "prior module cleanup failure"),
      {
        [Symbol.for("digital.web.process-owner-cleanup-incomplete")]: true,
      },
    );

    expect(shouldRetainWebProcessTemporaryRoot(errorFromPriorModule)).toBe(
      false,
    );
  });

  it("旧 owner shutdown 拒绝时关闭未接纳 product 且不启动 automation", async () => {
    const harness = createTestLifecycle();
    const failure = new Error("old owner shutdown failed");
    let closeAttempts = 0;
    const old = harness.lifecycle.register({
      async shutdown() {
        closeAttempts += 1;
        if (closeAttempts === 1) throw failure;
      },
    });
    await old.ready;
    old.publish();
    let closes = 0;
    let automationStarts = 0;
    const bootstrap = createApp(
      {
        api: new Hono(),
        catalogueReady: () => false,
        catalogueReadinessFailure: () => undefined,
        startCatalogueAutomation: async () => {
          automationStarts += 1;
        },
      },
      {
        attachVike: false,
        lifecycle: harness.lifecycle,
        async closeProduct() {
          closes += 1;
        },
      },
    );

    const admissionError = await bootstrap.catch((error: unknown) => error);
    expect(harness.lifecycle.hasCleanupIncomplete(admissionError)).toBe(true);
    expect((admissionError as AggregateError).errors).toContain(failure);
    expect(closes).toBe(1);
    expect(automationStarts).toBe(0);
    await old.dispose();
  });

  it("replacement 初始化中 terminal 到达时关闭未接纳 product 且不启动 automation", async () => {
    const harness = createTestLifecycle();
    let enterShutdown!: () => void;
    const shutdownEntered = new Promise<void>((resolve) => {
      enterShutdown = resolve;
    });
    let releaseShutdown!: () => void;
    const shutdownBarrier = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const old = harness.lifecycle.register({
      async shutdown() {
        enterShutdown();
        await shutdownBarrier;
      },
    });
    await old.ready;
    old.publish();
    let closes = 0;
    let automationStarts = 0;
    const bootstrap = createApp(
      {
        api: new Hono(),
        catalogueReady: () => false,
        catalogueReadinessFailure: () => undefined,
        startCatalogueAutomation: async () => {
          automationStarts += 1;
        },
      },
      {
        attachVike: false,
        lifecycle: harness.lifecycle,
        async closeProduct() {
          closes += 1;
        },
      },
    );
    await shutdownEntered;
    const terminal = harness.signal("SIGTERM");
    releaseShutdown();

    await expect(bootstrap).rejects.toThrow("进程正在关闭，不能启动内容目录");
    expect(closes).toBe(1);
    expect(automationStarts).toBe(0);
    await terminal;
  });

  it("接纳后的 app assembly 同步失败会关闭并注销 product owner", async () => {
    const harness = createTestLifecycle();
    const failure = new Error("automation start failed");
    let closes = 0;

    await expect(
      createApp(
        {
          api: new Hono(),
          catalogueReady: () => false,
          catalogueReadinessFailure: () => undefined,
          startCatalogueAutomation() {
            throw failure;
          },
        },
        {
          attachVike: false,
          lifecycle: harness.lifecycle,
          async closeProduct() {
            closes += 1;
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(closes).toBe(1);

    const probe = harness.lifecycle.register({ async shutdown() {} });
    await probe.ready;
    probe.publish();
    expect(closes).toBe(1);
    await probe.dispose();
  });

  it("publish 后 bootstrap 提交同步失败会关闭产品并允许后继接管", async () => {
    const harness = createTestLifecycle();
    let closes = 0;
    const bootstrap = await createApp(
      {
        api: new Hono(),
        catalogueReady: () => false,
        catalogueReadinessFailure: () => undefined,
        startCatalogueAutomation: async () => undefined,
      },
      {
        attachVike: false,
        lifecycle: harness.lifecycle,
        async closeProduct() {
          closes += 1;
        },
      },
    );
    bootstrap.publish();

    const commitFailure = new Error("process root commit failed");
    await expect(
      (async () => {
        try {
          throw commitFailure;
        } catch (error) {
          await bootstrap.abort();
          throw error;
        }
      })(),
    ).rejects.toBe(commitFailure);
    expect(closes).toBe(1);

    const successor = harness.lifecycle.register({ async shutdown() {} });
    await successor.ready;
    successor.publish();
    await successor.abort();
  });

  it("assembly 与 product cleanup 双失败时保留进程根，并由后继重试 owner 后终止清理", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "digital-web-bootstrap-retain-"),
    );
    const environment: NodeJS.ProcessEnv = {};
    const rootRegistry = createWebProcessTemporaryRootClaimRegistry(
      environment,
      parent,
    );
    const harness = createTestLifecycle(async () => await rootRegistry.close());
    try {
      const claim = await rootRegistry.claim();
      const directory = environment.TMPDIR!;
      claim.beginInitialization();
      let closeAttempts = 0;
      let bootstrapError: unknown;
      try {
        await createApp(
          {
            api: new Hono(),
            catalogueReady: () => false,
            catalogueReadinessFailure: () => undefined,
            startCatalogueAutomation() {
              throw new Error("assembly failed");
            },
          },
          {
            attachVike: false,
            lifecycle: harness.lifecycle,
            async closeProduct() {
              closeAttempts += 1;
              if (closeAttempts === 1)
                throw new Error("product cleanup failed");
            },
          },
        );
      } catch (error) {
        bootstrapError = error;
      }
      expect(harness.lifecycle.hasCleanupIncomplete(bootstrapError)).toBe(true);
      claim.retain();
      expect(closeAttempts).toBe(1);
      expect(environment.TMPDIR).toBe(directory);
      await expect(lstat(directory)).resolves.toBeDefined();

      const successor = harness.lifecycle.register({ async shutdown() {} });
      await successor.ready;
      successor.publish();
      expect(closeAttempts).toBe(2);
      await harness.signal("SIGTERM");
      expect(environment.TMPDIR).toBeUndefined();
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("assembly 失败但 product 已清理时回滚进程根", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "digital-web-bootstrap-rollback-"),
    );
    const environment: NodeJS.ProcessEnv = {};
    const rootRegistry = createWebProcessTemporaryRootClaimRegistry(
      environment,
      parent,
    );
    const harness = createTestLifecycle();
    try {
      const claim = await rootRegistry.claim();
      const directory = environment.TMPDIR!;
      claim.beginInitialization();
      let closeAttempts = 0;
      let bootstrapError: unknown;
      try {
        await createApp(
          {
            api: new Hono(),
            catalogueReady: () => false,
            catalogueReadinessFailure: () => undefined,
            startCatalogueAutomation() {
              throw new Error("assembly failed");
            },
          },
          {
            attachVike: false,
            lifecycle: harness.lifecycle,
            async closeProduct() {
              closeAttempts += 1;
            },
          },
        );
      } catch (error) {
        bootstrapError = error;
      }
      expect(harness.lifecycle.hasCleanupIncomplete(bootstrapError)).toBe(
        false,
      );
      await claim.rollback();
      expect(closeAttempts).toBe(1);
      expect(environment.TMPDIR).toBeUndefined();
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
