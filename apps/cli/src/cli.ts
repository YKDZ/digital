#!/usr/bin/env node
import { createRequire } from "node:module";

import { runCli, type CliRuntime } from "#main";

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json") as { version: string };

const runtime: CliRuntime = {
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

process.exitCode = await runCli(runtime);
