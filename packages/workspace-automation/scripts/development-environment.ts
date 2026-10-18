import { developEnvironment } from "@digital/environment";

import { requireInput } from "./inputs.ts";

const environment = process.argv[2];
if (environment === undefined || process.argv.length > 3) {
  console.error(
    "用法：pnpm preview:dev <已准备并停止的环境名>；首次准备与启动使用 pnpm environment enter --environment <名称> --source-mode <offline|controlled|real>，停止使用 pnpm environment stop --environment <名称>。enter 只准备并启动，不做资料接入。",
  );
  process.exitCode = 2;
} else {
  const result = await developEnvironment({
    workspacePath: requireInput("DIGITAL_AUTOMATION_WORKSPACE"),
    environment,
    onOutput: (text) => process.stdout.write(text),
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "stopped" ? 0 : 1;
}
