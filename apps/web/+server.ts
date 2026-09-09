import type { Server } from "vike/types";

import type { WebAppBootstrap } from "#/server/app";
import { claimWebProcessTemporaryRoot } from "#/server/process-temporary-root";

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
  bootstrap = await createWebServer({
    productDataDirectory: process.env.DIGITAL_PRODUCT_DATA,
    environment: process.env,
  });
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
