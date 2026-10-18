import {
  combineServiceBootstrapAbortFailure,
  shouldRetainServiceProcessTemporaryRoot,
} from "@digital/service-host";
import { resolveReadyIdentity } from "@digital/service-host/environment-ready-identity";
import { claimProductServiceProcessTemporaryRoot } from "@digital/service-host/process-temporary-root";
import { resolveSourceIoFromEnvironment } from "@digital/test-support/source-io";
import "@digital/service-host/process-lifecycle";
import { serve } from "srvx";

import { createProductService } from "./service.ts";

const claim = await claimProductServiceProcessTemporaryRoot();
let bootstrap: Awaited<ReturnType<typeof createProductService>> | undefined;
try {
  claim.beginInitialization();
  const sourceIo = await resolveSourceIoFromEnvironment(process.env);
  const identityResolution = resolveReadyIdentity();
  if ("problem" in identityResolution)
    console.error(identityResolution.problem);
  bootstrap = await createProductService(
    {
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
    },
    "identity" in identityResolution
      ? { readyIdentity: identityResolution.identity }
      : {},
  );
  const server = serve({
    fetch: bootstrap.app.fetch,
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    hostname: process.env.HOST ?? "127.0.0.1",
    gracefulShutdown: false,
  });
  await server.ready();
  bootstrap.publish();
  claim.commit();
} catch (caught) {
  let error = caught;
  if (bootstrap !== undefined) {
    try {
      await bootstrap.abort();
    } catch (abortError) {
      error = combineServiceBootstrapAbortFailure(error, abortError);
    }
  }
  if (shouldRetainServiceProcessTemporaryRoot(error)) claim.retain();
  else await claim.rollback().catch(() => undefined);
  throw error;
}
