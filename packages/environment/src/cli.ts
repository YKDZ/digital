#!/usr/bin/env node
import { createRequire } from "node:module";

import { nodeCliOutput } from "@ykdz/cli-contract/node";

import { runEnvironmentCli } from "./main.ts";

const require = createRequire(import.meta.url);
const manifest = require("../package.json") as { readonly version: string };

process.exitCode = await runEnvironmentCli({
  argv: process.argv,
  version: manifest.version,
  cwd: process.cwd(),
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
});
