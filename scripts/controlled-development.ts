import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runVisible } from "./turbo-process.ts";

const taskName = "development:controlled";
const taskPackage = "@digital/workspace-automation";

export async function runControlledDevelopment(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const workspacePath = process.env.DIGITAL_AUTOMATION_WORKSPACE;
  if (workspacePath === undefined || workspacePath.trim() === "") {
    process.stderr.write(
      "受控开发入口必须通过 DIGITAL_AUTOMATION_WORKSPACE 指定工作区\n",
    );
    return 2;
  }

  return await runVisible(workspacePath, [
    "run",
    taskName,
    `--filter=${taskPackage}`,
    "--",
    ...args,
  ]);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runControlledDevelopment();
}
