import { publicApiErrorResponseSchema } from "@digital/public-api";
import { Hono } from "hono";
import { safeParse } from "valibot";

import {
  readyAttestation,
  readyNonceHeader,
  type ReadyIdentity,
} from "./environment-ready-identity.ts";
import {
  processLifecycle,
  type ProcessLifecycleRegistry,
  type ProcessOwnerRegistration,
} from "./process-lifecycle.ts";

export type HostedHttpDelivery = {
  readonly api: Hono;
  readonly start: () => Promise<void>;
  readonly ready: () => boolean;
  readonly readinessFailure: () => string | undefined;
};

export type ServiceHostOptions = {
  readonly api?: Hono;
  readonly start?: () => Promise<void>;
  readonly ready?: () => boolean;
  readonly readinessFailure?: () => string | undefined;
  readonly attach?: (app: Hono) => void;
  readonly lifecycle?: ProcessLifecycleRegistry;
  readonly readyIdentity?: ReadyIdentity;
  readonly closeProduct?: () => Promise<void>;
  readonly serviceName?: string;
};

export type ServiceAppBootstrap = {
  readonly app: Hono;
  publish(): void;
  abort(): Promise<void>;
};

/** 供正式 HTTP 宿主与旧交付共用产品资源登记、就绪屏障和退出合同。 */
export async function createOwnedServiceApp(
  options: ServiceHostOptions,
  initialClose: (() => Promise<void>) | undefined,
  acquire: (
    bindClose: (close: () => Promise<void>) => void,
  ) => HostedHttpDelivery,
): Promise<ServiceAppBootstrap> {
  const lifecycle = options.lifecycle ?? processLifecycle;
  let close = initialClose;
  const bindClose = (ownedClose: () => Promise<void>): void => {
    if (close !== undefined) throw new Error("产品服务关闭动作已绑定");
    close = ownedClose;
  };
  let registration: ProcessOwnerRegistration;
  try {
    lifecycle.assertMayStart();
    registration = lifecycle.register({
      async shutdown() {
        await close?.();
      },
    });
  } catch (registrationError) {
    try {
      await close?.();
    } catch (closeError) {
      throw new AggregateError(
        [registrationError, closeError],
        "产品服务登记失败且调用方清理未完成",
        { cause: closeError },
      );
    }
    throw registrationError;
  }
  await registration.ready;
  let app: Hono;
  try {
    app = assembleServiceApp(acquire(bindClose), options);
  } catch (assemblyError) {
    try {
      await registration.abort();
    } catch (disposeError) {
      throw new AggregateError(
        [assemblyError, disposeError],
        "产品服务装配失败且资源清理未完成",
        { cause: disposeError },
      );
    }
    throw assemblyError;
  }
  return {
    app,
    publish() {
      registration.publish();
    },
    async abort() {
      await registration.abort();
    },
  };
}

export function shouldRetainServiceProcessTemporaryRoot(
  error: unknown,
): boolean {
  return processLifecycle.hasCleanupIncomplete(error);
}

export function combineServiceBootstrapAbortFailure(
  bootstrapError: unknown,
  abortError: unknown,
): AggregateError {
  return new AggregateError(
    [bootstrapError, abortError],
    "产品服务启动失败且资源清理未完成",
  );
}

function assembleServiceApp(
  delivery: HostedHttpDelivery,
  options: ServiceHostOptions,
): Hono {
  const app = new Hono();
  const serviceName = options.serviceName ?? "digital-product-service";
  const start = options.start ?? delivery.start;
  const ready = options.ready ?? delivery.ready;
  const readinessFailure =
    options.readinessFailure ?? delivery.readinessFailure;
  const startup = start();
  void startup.catch((error: unknown) => {
    console.error("自动刷新恢复未完成", error);
  });

  app.use("/api/*", async (context, next) => {
    if (context.req.path === "/api/health" || context.req.path === "/api/live")
      return context.json({ ok: true, service: serviceName });
    if (context.req.path === "/api/ready") {
      if (ready()) {
        const nonce = context.req.header(readyNonceHeader);
        return context.json({
          ok: true,
          service: serviceName,
          ...(nonce === undefined || options.readyIdentity === undefined
            ? {}
            : readyAttestation(options.readyIdentity, nonce)),
        });
      }
      return context.json(
        {
          ok: false,
          service: serviceName,
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
      if (context.req.path.startsWith("/api/v1/"))
        return context.json(notReadyResponse(), 503);
      return context.json(
        {
          error: "产品资料尚未准备，暂时无法处理请求",
          ...(readinessFailure() === undefined
            ? {}
            : { diagnostic: readinessFailure() }),
        },
        503,
      );
    }
    if (!ready()) {
      if (context.req.path.startsWith("/api/v1/"))
        return context.json(notReadyResponse(), 503);
      return context.json({ error: "产品资料仍在恢复" }, 503);
    }
    return await next();
  });

  app.route("/api", options.api ?? delivery.api);
  options.attach?.(app);
  return app;
}

function notReadyResponse() {
  return safeParse(publicApiErrorResponseSchema, {
    error: { code: "not-ready", message: "产品资料正在准备，请稍后重试" },
  }).output;
}
