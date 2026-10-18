import "@digital/service-host/process-lifecycle";
import { createPublicApiClient } from "@digital/public-api";
import {
  claimProductServiceProcessTemporaryRoot,
  closeProductServiceProcessTemporaryRoot,
  combineServiceBootstrapAbortFailure,
  shouldRetainServiceProcessTemporaryRoot,
} from "@digital/service-host";
import { resolveSourceIoFromEnvironment } from "@digital/test-support/source-io";
import { serve } from "srvx";

import { createProductPreparationProbe } from "./service.ts";

/**
 * 环境准备的只读核验：运行不恢复、不自动扫描的正式产品 API 于短暂本地 HTTP 端口，
 * 并经公开客户端读一页资产库。调用方已先完成正式迁移。
 */
const claim = await claimProductServiceProcessTemporaryRoot();
const arguments_ = process.argv
  .slice(2)
  .filter((argument) => argument !== "--");
let bootstrap:
  | Awaited<ReturnType<typeof createProductPreparationProbe>>
  | undefined;
let server: ReturnType<typeof serve> | undefined;
let committed = false;

try {
  claim.beginInitialization();
  const sourceIo = await resolveSourceIoFromEnvironment(process.env);
  bootstrap = await createProductPreparationProbe({
    ...(process.env.DIGITAL_PRODUCT_DATA === undefined
      ? {}
      : { productDataDirectory: process.env.DIGITAL_PRODUCT_DATA }),
    ...(process.env.DIGITAL_PRODUCT_INITIAL_CONFIGURATION === undefined
      ? {}
      : {
          initialAssetLibraryConfigurationDirectory:
            process.env.DIGITAL_PRODUCT_INITIAL_CONFIGURATION,
        }),
    ...(process.env.DIGITAL_PRODUCT_DATA_GENERATION === undefined
      ? {}
      : { dataGeneration: process.env.DIGITAL_PRODUCT_DATA_GENERATION }),
    environment: process.env,
    sourceIo,
  });
  server = serve({
    fetch: bootstrap.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
  });
  await server.ready();
  bootstrap.publish();
  claim.commit();
  committed = true;

  const baseUrl = server.url;
  if (baseUrl === undefined)
    throw new Error("准备核验服务未提供本地 HTTP 地址");
  const client = createPublicApiClient({ baseUrl });
  if (arguments_[0] === "--workflow-history") {
    const history = await client.listWorkflowHistory({ limit: 100 });
    process.stdout.write(
      `${JSON.stringify(history.items.map(({ execution }) => execution.id))}\n`,
    );
  } else {
    if (arguments_.length > 0) throw new Error("准备核验参数无效");
    const page = await client.listAssetLibraries({ limit: 1 });
    if (!Array.isArray(page.items))
      throw new Error("正式产品读取未返回合法资产库分页");
  }

  await server.close(true);
  await bootstrap.abort();
  await closeProductServiceProcessTemporaryRoot();
} catch (caught) {
  let error = caught;
  try {
    await server?.close(true);
  } catch (closeError) {
    error = new AggregateError(
      [error, closeError],
      "准备核验 HTTP 服务收尾失败",
    );
  }
  if (bootstrap !== undefined) {
    try {
      await bootstrap.abort();
    } catch (abortError) {
      error = combineServiceBootstrapAbortFailure(error, abortError);
    }
  }
  const retainRoot = shouldRetainServiceProcessTemporaryRoot(error);
  if (!committed) {
    if (retainRoot) claim.retain();
    else await claim.rollback();
  } else if (!retainRoot) {
    await closeProductServiceProcessTemporaryRoot().catch(() => undefined);
  }
  throw error;
}
