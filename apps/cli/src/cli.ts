#!/usr/bin/env node
import { createRequire } from "node:module";

import { claimProcessTemporaryRoot } from "@digital/composition/process-temporary-root";

const processTemporaryRoot = await claimProcessTemporaryRoot(process.env, {
  prefix: "digital-cli-process-",
});

let failed = false;
let failure: unknown;
try {
  const { runCli } = await import("#main");
  const require = createRequire(import.meta.url);
  const packageManifest = require("../package.json") as { version: string };

  const runtime = {
    argv: process.argv,
    streams: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    },
    cwd: process.cwd(),
    env: process.env,
    tty: {
      stdin: process.stdin.isTTY,
      stdout: process.stdout.isTTY,
      stderr: process.stderr.isTTY,
    },
    version: packageManifest.version,
    waitForShutdown: async () =>
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      }),
  };

  process.exitCode = await processTemporaryRoot.closeAfterSuccessful(
    runCli(runtime),
  );
} catch (error) {
  failed = true;
  failure = error;
}
if (failed) throw failure;
