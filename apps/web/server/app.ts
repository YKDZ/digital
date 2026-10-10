import { runProduct, type ProductConfiguration } from "@digital/composition";
import { createWebDelivery, type WebDelivery } from "@digital/web-delivery";
import vike from "@vikejs/hono";
import { Hono } from "hono";

import {
  readyAttestation,
  readyNonceHeader,
  type ReadyIdentity,
} from "#/server/environment-ready-identity";
import {
  processLifecycle,
  type ProcessLifecycleRegistry,
  type ProcessOwnerRegistration,
} from "#/server/process-lifecycle";

export type WebServerOptions = {
  readonly api?: Hono;
  readonly startCatalogueAutomation?: () => Promise<void>;
  readonly catalogueReady?: () => boolean;
  readonly catalogueReadinessFailure?: () => string | undefined;
  readonly attachVike?: boolean;
  readonly createDelivery?: typeof createWebDelivery;
  readonly lifecycle?: ProcessLifecycleRegistry;
  /** 由环境外层启动时才有；缺席时 ready 响应形状与独立部署完全一致。 */
  readonly readyIdentity?: ReadyIdentity;
  /** 仅由可执行组合根持有；Web delivery 本身不能关闭产品资源。 */
  readonly closeProduct?: () => Promise<void>;
};

export type WebAppBootstrap = {
  readonly app: Hono;
  publish(): void;
  abort(): Promise<void>;
};

/** 仅供 Web 可执行 bootstrap 决定失败时是否必须保留进程临时根。 */
export function shouldRetainWebProcessTemporaryRoot(error: unknown): boolean {
  return processLifecycle.hasCleanupIncomplete(error);
}

export function combineWebBootstrapAbortFailure(
  bootstrapError: unknown,
  abortError: unknown,
): AggregateError {
  return new AggregateError(
    [bootstrapError, abortError],
    "Web bootstrap 失败且产品清理未完成",
  );
}

/** Web 可执行入口同时选择组合和独立交付，再注入同一产品应用。 */
export async function createWebServer(
  configuration: ProductConfiguration,
  options: WebServerOptions = {},
): Promise<WebAppBootstrap> {
  const lifecycle = options.lifecycle ?? processLifecycle;
  return await createOwnedWebApp(lifecycle, options, undefined, (bindClose) => {
    const product = runProduct(configuration, {
      start(application) {
        return application;
      },
    });
    bindClose(async () => await product.close());
    return (options.createDelivery ?? createWebDelivery)(product.result);
  });
}

export async function createApp(
  delivery: WebDelivery,
  options: WebServerOptions = {},
): Promise<WebAppBootstrap> {
  const lifecycle = options.lifecycle ?? processLifecycle;
  return await createOwnedWebApp(
    lifecycle,
    options,
    async () => await options.closeProduct?.(),
    () => delivery,
  );
}

async function createOwnedWebApp(
  lifecycle: ProcessLifecycleRegistry,
  options: WebServerOptions,
  initialClose: (() => Promise<void>) | undefined,
  acquire: (bindClose: (close: () => Promise<void>) => void) => WebDelivery,
): Promise<WebAppBootstrap> {
  let close = initialClose;
  const bindClose = (ownedClose: () => Promise<void>): void => {
    if (close !== undefined) throw new Error("Web 产品关闭动作已绑定");
    close = ownedClose;
  };
  let lifecycleRegistration: ProcessOwnerRegistration;
  try {
    lifecycle.assertMayStart();
    lifecycleRegistration = lifecycle.register({
      async shutdown() {
        await close?.();
      },
    });
  } catch (registrationError) {
    // register 同步失败前 registry 尚未接管；只有这条理论边界仍由调用者关闭。
    try {
      await close?.();
    } catch (closeError) {
      throw new AggregateError(
        [registrationError, closeError],
        "Web 产品登记失败且调用者清理未完成",
        { cause: closeError },
      );
    }
    throw registrationError;
  }
  await lifecycleRegistration.ready;
  let app: Hono;
  try {
    app = assembleApp(acquire(bindClose), options);
  } catch (assemblyError) {
    try {
      await lifecycleRegistration.abort();
    } catch (disposeError) {
      throw new AggregateError(
        [assemblyError, disposeError],
        "Web app assembly 失败且产品清理未完成",
        { cause: disposeError },
      );
    }
    throw assemblyError;
  }
  return {
    app,
    publish() {
      lifecycleRegistration.publish();
    },
    async abort() {
      await lifecycleRegistration.abort();
    },
  };
}

function assembleApp(delivery: WebDelivery, options: WebServerOptions): Hono {
  const app = new Hono();
  const readyIdentity = options.readyIdentity;

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
      if (ready()) {
        // 只有带一次性 nonce 的环境认证请求才追加签名；浏览器与其他调用看到的
        // 响应与独立部署完全一致，身份与密钥都不进入普通响应。
        const nonce = _context.req.header(readyNonceHeader);
        return _context.json({
          ok: true,
          service: "digital-web",
          ...(nonce === undefined || readyIdentity === undefined
            ? {}
            : readyAttestation(readyIdentity, nonce)),
        });
      }
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
