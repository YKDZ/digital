import { runProduct, type ProductConfiguration } from "@digital/composition";
import { createWebDelivery, type WebDelivery } from "@digital/web-delivery";
import vike from "@vikejs/hono";
import { Hono } from "hono";

import { processLifecycle } from "#/server/process-lifecycle";

export type WebServerOptions = {
  readonly api?: Hono;
  readonly startCatalogueAutomation?: () => Promise<void>;
  readonly catalogueReady?: () => boolean;
  readonly catalogueReadinessFailure?: () => string | undefined;
  readonly attachVike?: boolean;
  readonly createDelivery?: typeof createWebDelivery;
  /** 仅由可执行组合根持有；Web delivery 本身不能关闭产品资源。 */
  readonly closeProduct?: () => Promise<void>;
};

/** Web 可执行入口同时选择组合和独立交付，再注入同一产品应用。 */
export function createWebServer(
  configuration: ProductConfiguration,
  options: WebServerOptions = {},
) {
  const product = runProduct(configuration, {
    start(application) {
      return (options.createDelivery ?? createWebDelivery)(application);
    },
  });
  return createApp(product.result, {
    ...options,
    async closeProduct() {
      await product.close();
    },
  });
}

export function createApp(
  delivery: WebDelivery,
  options: WebServerOptions = {},
) {
  const lifecycleRegistration = processLifecycle.register({
    async shutdown() {
      await options.closeProduct?.();
    },
  });
  void lifecycleRegistration.ready;
  const app = new Hono();

  // host 由进程持有且幂等，因此开发和测试中重复创建 Vike app 不会产生重复定时器。
  const start =
    options.startCatalogueAutomation ?? delivery.startCatalogueAutomation;
  const ready = options.catalogueReady ?? delivery.catalogueReady;
  const readinessFailure =
    options.catalogueReadinessFailure ?? delivery.catalogueReadinessFailure;
  const startup = start();
  void startup.catch((error: unknown) => {
    console.error("自动刷新未启动", error);
  });

  // 在任何 API handler 读取或启动 catalogue 工作前，必须先分类 retained execution。
  // host 的启动 promise 在恢复屏障后才完成；长时间恢复的执行在其监督下继续，
  // 不会无限延迟就绪。
  app.use("/api/*", async (_context, next) => {
    // Liveness 只回答进程能否提供 HTTP 服务；不能等待 catalogue 恢复，也不能
    // 作为副作用打开 catalogue。
    if (
      _context.req.path === "/api/health" ||
      _context.req.path === "/api/live"
    ) {
      return _context.json({ ok: true, service: "digital-web" });
    }
    if (_context.req.path === "/api/ready") {
      if (ready()) return _context.json({ ok: true, service: "digital-web" });
      return _context.json(
        {
          ok: false,
          service: "digital-web",
          state: "not-ready",
          ...(readinessFailure() === undefined
            ? {}
            : { diagnostic: readinessFailure() }),
        },
        503,
      );
    }
    try {
      await startup;
    } catch {
      return _context.json(
        {
          error: "内容目录尚未准备，拒绝服务",
          ...(readinessFailure() === undefined
            ? {}
            : { diagnostic: readinessFailure() }),
        },
        503,
      );
    }
    if (!ready()) return _context.json({ error: "内容目录恢复尚未完成" }, 503);
    return await next();
  });

  app.route("/api", options.api ?? delivery.api);

  if (options.attachVike !== false) vike(app);

  return app;
}
