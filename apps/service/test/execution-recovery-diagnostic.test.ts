import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareProductionCatalogue } from "@digital/db-migrations";
import {
  createPublicApiClient,
  PublicExecutionClientError,
} from "@digital/public-api";
import { resolveSourceIoFromEnvironment } from "@digital/test-support/source-io";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { createProductService } from "../src/service.ts";

const serviceServers: Array<Awaited<ReturnType<typeof serve>>> = [];
const proxies: Server[] = [];
const bootstraps: Array<Awaited<ReturnType<typeof createProductService>>> = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0).reverse())
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  for (const server of serviceServers.splice(0).reverse())
    await server.close(true);
  for (const bootstrap of bootstraps.splice(0).reverse())
    await bootstrap.abort();
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("查询连接被重置时保留同一正式执行，随后仍可读到后台结局", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-execution-recovery-"),
  );
  temporaryRoots.push(root);
  const materialDirectory = path.join(root, "ordinary-material");
  await mkdir(materialDirectory);
  await writeFile(path.join(materialDirectory, "ordinary.txt"), "普通资料\n");

  const productDataDirectory = path.join(root, "product-data");
  await prepareProductionCatalogue({ productDataDirectory });
  const sourceIo = await resolveSourceIoFromEnvironment({
    DIGITAL_SOURCE_MODE: "offline",
  });
  const bootstrap = await createProductService({
    productDataDirectory,
    environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
    ...(sourceIo === undefined ? {} : { sourceIo }),
  });
  bootstraps.push(bootstrap);
  const service = serve({
    fetch: bootstrap.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  serviceServers.push(service);
  await service.ready();
  bootstrap.publish();
  const serviceUrl = new URL(service.url!);
  const proxy = await startOneShotExecutionResetProxy(serviceUrl);
  const client = createPublicApiClient({ baseUrl: proxy.url });

  const library = await client.saveAssetLibrary({
    displayName: "执行恢复诊断资料库",
    directories: [materialDirectory],
    recognitionProfileIds: ["dlsite-voice"],
    sourceIdentities: [],
  });
  const { parentExecutionId: executionId } = await client.startAssetLibraryScan(
    library.id,
  );

  let queryFailure: unknown;
  try {
    await client.inspectExecution(executionId);
  } catch (error) {
    queryFailure = error;
  }

  await expect
    .poll(async () => (await client.inspectExecution(executionId)).status, {
      timeout: 60_000,
    })
    .toBe("completed");
  const recovered = await client.inspectExecution(executionId);
  const readyAfterDisconnect = await fetch(new URL("/api/ready", serviceUrl));
  expect(proxy.state).toMatchObject({
    resetExecutionId: executionId,
    responseStatus: 200,
    responseExecutionStatus: "running",
  });
  expect(readyAfterDisconnect.status).toBe(200);
  expect(proxy.state.scanPostCount).toBe(1);
  expect(recovered).toMatchObject({ id: executionId, status: "completed" });
  expect(queryFailure).toBeInstanceOf(PublicExecutionClientError);
  expect(queryFailure).toMatchObject({
    executionId,
    kind: "transport",
    cause: { cause: { code: "ECONNRESET" } },
  });
});

async function startOneShotExecutionResetProxy(serviceUrl: URL): Promise<{
  readonly url: URL;
  readonly state: {
    readonly resetExecutionId: string | undefined;
    readonly responseStatus: number | undefined;
    readonly responseExecutionStatus: string | undefined;
    scanPostCount: number;
  };
}> {
  const state: {
    resetExecutionId: string | undefined;
    responseStatus: number | undefined;
    responseExecutionStatus: string | undefined;
    scanPostCount: number;
  } = {
    resetExecutionId: undefined,
    responseStatus: undefined,
    responseExecutionStatus: undefined,
    scanPostCount: 0,
  };
  const proxy = createHttpServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const requestBody = Buffer.concat(chunks);
      const requestPath = incoming.url ?? "/";
      if (
        incoming.method === "POST" &&
        /^\/api\/v1\/asset-libraries\/[^/]+\/scans$/u.test(requestPath)
      )
        state.scanPostCount += 1;

      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (
          typeof value === "string" &&
          name !== "host" &&
          name !== "connection" &&
          name !== "content-length" &&
          name !== "transfer-encoding"
        )
          headers.set(name, value);
      const response = await fetch(new URL(requestPath, serviceUrl), {
        method: incoming.method,
        headers,
        ...(requestBody.length === 0
          ? {}
          : { body: new Uint8Array(requestBody) }),
      });
      const responseBody = new Uint8Array(await response.arrayBuffer());
      const executionPath = requestPath.match(
        /^\/api\/v1\/executions\/([^/?]+)/u,
      );
      if (
        state.resetExecutionId === undefined &&
        incoming.method === "GET" &&
        executionPath !== null
      ) {
        state.resetExecutionId = executionPath[1];
        state.responseStatus = response.status;
        const executionReply = JSON.parse(
          Buffer.from(responseBody).toString("utf8"),
        ) as { readonly status?: unknown };
        state.responseExecutionStatus =
          typeof executionReply.status === "string"
            ? executionReply.status
            : undefined;
        outgoing.socket?.resetAndDestroy();
        return;
      }

      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of response.headers)
        if (name !== "connection" && name !== "transfer-encoding")
          responseHeaders[name] = value;
      outgoing.writeHead(response.status, responseHeaders);
      outgoing.end(responseBody);
    })().catch((error: unknown) => {
      if (!outgoing.destroyed) outgoing.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  proxies.push(proxy);
  const address = proxy.address();
  if (address === null || typeof address === "string")
    throw new Error("诊断代理没有取得临时端口");
  const proxyUrl = new URL(`http://127.0.0.1:${String(address.port)}`);
  const proxyState = state;
  return { url: proxyUrl, state: proxyState };
}
