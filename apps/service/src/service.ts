import { runProduct, type ProductConfiguration } from "@digital/composition";
import { createPublicHttpApi } from "@digital/http-delivery";
import type {
  ProductApplication,
  ProductAutomationHostOptions,
} from "@digital/product-application";
import {
  createOwnedServiceApp,
  type ServiceAppBootstrap,
} from "@digital/service-host";
import type { ProcessLifecycleRegistry } from "@digital/service-host";
import type { ReadyIdentity } from "@digital/service-host/environment-ready-identity";
import { Hono } from "hono";

/** 独立服务拥有产品实例、正式 HTTP API 与自动化宿主。 */
export async function createProductService(
  configuration: ProductConfiguration,
  options: {
    readonly readyIdentity?: ReadyIdentity | undefined;
    readonly lifecycle?: ProcessLifecycleRegistry | undefined;
  } = {},
): Promise<ServiceAppBootstrap> {
  return await createOwnedServiceApp(
    {
      serviceName: "digital-product-service",
      ...(options.readyIdentity === undefined
        ? {}
        : { readyIdentity: options.readyIdentity }),
      ...(options.lifecycle === undefined
        ? {}
        : { lifecycle: options.lifecycle }),
    },
    undefined,
    (bindClose) => {
      const product = runProduct(configuration, {
        start(application) {
          return application;
        },
      });
      bindClose(async () => await product.close());
      const automation = createServiceAutomation(product.result);
      const api = new Hono().route("/v1", createPublicHttpApi(product.result));
      return {
        api,
        async start() {
          await product.result.initialAssetLibraries?.restoreForDataGeneration();
          await automation.start();
        },
        ready: () => automation.ready(),
        readinessFailure: () => automation.failure(),
      };
    },
  );
}

/**
 * 准备阶段的只读 API 探针：装配同一产品与正式 HTTP 资源，不恢复初始库或启动后台自动化。
 */
export async function createProductPreparationProbe(
  configuration: ProductConfiguration,
): Promise<ServiceAppBootstrap> {
  return await createOwnedServiceApp(
    { serviceName: "digital-product-service-prepare-check" },
    undefined,
    (bindClose) => {
      const product = runProduct(configuration, {
        start(application) {
          return application;
        },
      });
      bindClose(async () => await product.close());
      return {
        api: new Hono().route("/v1", createPublicHttpApi(product.result)),
        async start() {},
        ready: () => true,
        readinessFailure: () => undefined,
      };
    },
  );
}

/**
 * 服务宿主负责恢复自动化并以它的就绪事实接入 readiness；该运行生命周期不属于任何客户端交付。
 */
function createServiceAutomation(application: ProductApplication): {
  start(): Promise<void>;
  ready(): boolean;
  failure(): string | undefined;
} {
  let started: Promise<void> | undefined;
  let startupFailure: string | undefined;
  const options: ProductAutomationHostOptions = {
    onError(error) {
      console.error("自动刷新检查未完成", error);
    },
  };
  return {
    async start(): Promise<void> {
      if (!application.configured) return;
      started ??= application
        .startAutomation(options)
        .catch((error: unknown) => {
          startupFailure = describeStartupFailure(error);
          started = undefined;
          throw error;
        });
      await started;
    },
    ready(): boolean {
      return started !== undefined && application.automation.recoveryReady;
    },
    failure(): string | undefined {
      if (startupFailure !== undefined) return startupFailure;
      if (!application.configured)
        return "尚未配置产品数据目录；设置 DIGITAL_PRODUCT_DATA 后运行 digital-db-migrate prepare-only";
      return undefined;
    },
  };
}

function describeStartupFailure(error: unknown): string {
  if (!(error instanceof Error)) return "内容目录启动失败；检查部署诊断后重试";
  return error.message.replaceAll(/\/[^\s]+/gu, "[路径已隐藏]");
}
