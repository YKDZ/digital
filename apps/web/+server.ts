import { resolveSourceIoFromEnvironment } from "@digital/test-support/source-io";
import type { Server } from "vike/types";

import type { WebAppBootstrap } from "#/server/app";
import {
  resolveReadyIdentity,
  type ReadyIdentity,
} from "#/server/environment-ready-identity";
// 只为了在任何启动步骤之前接管信号：环境的停止只发出一次 SIGTERM，收尾必须走产品
// 既有生命周期，而不是 Node 的默认终止。
import "#/server/process-lifecycle";
import { claimWebProcessTemporaryRoot } from "#/server/process-temporary-root";

const readyIdentityResolution = resolveReadyIdentity();
const readyIdentity: ReadyIdentity | undefined =
  "identity" in readyIdentityResolution
    ? readyIdentityResolution.identity
    : undefined;

// 来源装配选择在任何产品准入之前解析：显式受控而清单缺失或无效时进程直接失败，
// 不带着真实默认值继续，也永不把受控启动降级。
const sourceIo = await resolveSourceIoFromEnvironment(process.env);

const processTemporaryRootClaim = await claimWebProcessTemporaryRoot();
let app;
let bootstrap: WebAppBootstrap | undefined;
let shouldRetainProcessTemporaryRoot: ((error: unknown) => boolean) | undefined;
let combineAbortFailure:
  | ((bootstrapError: unknown, abortError: unknown) => unknown)
  | undefined;
try {
  const {
    combineWebBootstrapAbortFailure,
    createWebServer,
    shouldRetainWebProcessTemporaryRoot,
  } = await import("#/server/app");
  shouldRetainProcessTemporaryRoot = shouldRetainWebProcessTemporaryRoot;
  combineAbortFailure = combineWebBootstrapAbortFailure;
  processTemporaryRootClaim.beginInitialization();
  if ("problem" in readyIdentityResolution)
    // 身份无法建立时如实报告，服务照常提供，但环境的认证探测会看到缺少证明。
    console.error(readyIdentityResolution.problem);
  bootstrap = await createWebServer(
    {
      productDataDirectory: process.env.DIGITAL_PRODUCT_DATA,
      environment: process.env,
      sourceIo,
    },
    readyIdentity === undefined ? {} : { readyIdentity },
  );
  bootstrap.publish();
  processTemporaryRootClaim.commit();
  app = bootstrap.app;
} catch (caught) {
  let error = caught;
  if (bootstrap !== undefined) {
    try {
      await bootstrap.abort();
    } catch (abortError) {
      error = combineAbortFailure?.(error, abortError) ?? abortError;
    }
  }
  if (shouldRetainProcessTemporaryRoot?.(error))
    processTemporaryRootClaim.retain();
  else await processTemporaryRootClaim.rollback().catch(() => undefined);
  throw error;
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

export default {
  fetch: app.fetch,
  prod: {
    port,
  },
} satisfies Server;
