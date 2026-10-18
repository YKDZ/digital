import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ProductConfiguration } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
} from "@digital/test-support/source-io";
import { serve } from "srvx";

import { createProductService } from "../../src/service.ts";

const productDataDirectory = process.env["EW07_SCAN_PRODUCT_DATA"];
const fixtureDirectory = process.env["EW07_SCAN_FIXTURE_DIRECTORY"];
if (productDataDirectory === undefined || fixtureDirectory === undefined)
  throw new Error("扫描 readiness 受控服务配置不完整");

await prepareProductionCatalogue({ productDataDirectory });
const fixture = await loadControlledSourceIo({
  manifestPath: path.join(fixtureDirectory, "manifest.json"),
});
const episodeDetails = new Map<string, unknown>();
for (const subjectId of [243981, 400602, 515759]) {
  const page = JSON.parse(
    await readFile(
      path.join(
        fixtureDirectory,
        "responses",
        `bangumi-episodes-${String(subjectId)}.json`,
      ),
      "utf8",
    ),
  ) as { readonly data: readonly Record<string, unknown>[] };
  for (const episode of page.data)
    episodeDetails.set(String(episode["id"]), episode);
}
const sourceIo: NonNullable<ProductConfiguration["sourceIo"]> = {
  mode: "controlled",
  async request(input, init) {
    const url = new URL(input);
    const match = /^\/v0\/episodes\/(\d+)$/u.exec(url.pathname);
    if (url.origin === "https://api.bgm.tv" && match !== null) {
      const episode = episodeDetails.get(match[1]!);
      if (episode === undefined)
        throw new Error(`公开受控 episode 列表中没有 ${match[1]}`);
      return new Response(JSON.stringify(episode), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fixture.request(input, init);
  },
  sessionTransport: fixture.sessionTransport ?? refusingSessionTransport(),
};
const bootstrap = await createProductService({
  productDataDirectory,
  environment: { DIGITAL_PRODUCT_DATA: productDataDirectory },
  sourceIo,
});
const server = serve({
  fetch: bootstrap.app.fetch,
  port: 0,
  hostname: "127.0.0.1",
  silent: true,
  gracefulShutdown: false,
});
await server.ready();
bootstrap.publish();
process.stdout.write(
  `${JSON.stringify({ kind: "ready", address: server.url })}\n`,
);

let closing = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (!chunk.split(/\s+/u).includes("stop") || closing) return;
  closing = true;
  process.stdin.destroy();
  void (async () => {
    await server.close(true);
    await bootstrap.abort();
    process.stdout.write(`${JSON.stringify({ kind: "stopped" })}\n`);
  })().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
});
