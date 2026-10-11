import path from "node:path";

import { developEnvironment } from "../packages/environment/src/index.ts";

const environment = process.argv[2];
if (environment === undefined || process.argv.length > 3) {
  console.error(
    "用法：pnpm preview:dev <已准备的环境名>；首次资料接入使用 pnpm preview，独立停止使用 pnpm preview stop",
  );
  process.exitCode = 2;
} else {
  const result = await developEnvironment({
    workspacePath: path.resolve(import.meta.dirname, ".."),
    environment,
    onOutput: (text) => process.stdout.write(text),
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "stopped" ? 0 : 1;
}
