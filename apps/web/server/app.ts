import vike from "@vikejs/hono";
import { Hono } from "hono";

import { api as defaultApi } from "#/server/api";
import {
  catalogueReady,
  catalogueReadinessFailure,
  shutdownCatalogue,
  startCatalogueAutomation,
} from "#/server/catalogue";
import { processLifecycle } from "#/server/process-lifecycle";

const lifecycleRegistration = processLifecycle.register({
  async shutdown(reason) {
    await shutdownCatalogue({ terminal: reason === "terminal" });
  },
});
await lifecycleRegistration.ready;

const hot = (
  import.meta as ImportMeta & {
    readonly hot?: {
      dispose(callback: (data: Record<string, unknown>) => void): void;
    };
  }
).hot;
if (hot) {
  hot.dispose((data) => {
    data.catalogueShutdown = lifecycleRegistration.dispose();
  });
}

export function createApp(
  options: {
    readonly api?: Hono;
    readonly startCatalogueAutomation?: () => Promise<void>;
    readonly catalogueReady?: () => boolean;
    readonly catalogueReadinessFailure?: () => string | undefined;
    readonly attachVike?: boolean;
  } = {},
) {
  const app = new Hono();

  // host 由进程持有且幂等，因此开发和测试中重复创建 Vike app 不会产生重复定时器。
  const start = options.startCatalogueAutomation ?? startCatalogueAutomation;
  const ready = options.catalogueReady ?? catalogueReady;
  const readinessFailure =
    options.catalogueReadinessFailure ?? catalogueReadinessFailure;
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

  app.route("/api", options.api ?? defaultApi);

  if (options.attachVike !== false) vike(app);

  return app;
}
