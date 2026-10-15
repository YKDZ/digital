import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  acceptanceInputsPath,
  type AcceptanceInputs,
} from "./acceptance-inputs.ts";

const flags = new Map<string, string>();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index];
  const value = argv[index + 1];
  if (
    !key ||
    !["--workspace", "--source-directory", "--compose-file"].includes(key) ||
    !value
  )
    throw new Error(`验收准备参数无效：${argv.slice(index).join(" ")}`);
  flags.set(key, value);
}
function absolutePath(flag: string): string {
  const value = flags.get(flag);
  if (!value || !path.isAbsolute(value))
    throw new Error(`验收准备需要显式绝对路径 ${flag}`);
  return value;
}
const inputs: AcceptanceInputs = {
  workspacePath: absolutePath("--workspace"),
  sourceDirectory: absolutePath("--source-directory"),
  composeFile: absolutePath("--compose-file"),
};
for (const directory of [inputs.workspacePath, inputs.sourceDirectory])
  if (!(await stat(directory)).isDirectory())
    throw new Error(`验收输入不是目录：${directory}`);
if (!(await stat(inputs.composeFile)).isFile())
  throw new Error(`Compose 输入不是文件：${inputs.composeFile}`);
await mkdir(path.dirname(acceptanceInputsPath), { recursive: true });
const temporary = `${acceptanceInputsPath}.${process.pid}`;
await writeFile(temporary, `${JSON.stringify(inputs, null, 2)}\n`);
await rename(temporary, acceptanceInputsPath);
