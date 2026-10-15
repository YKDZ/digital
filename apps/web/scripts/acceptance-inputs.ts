import { readFile } from "node:fs/promises";
import path from "node:path";

export const acceptanceInputsPath = path.resolve(
  import.meta.dirname,
  "../.turbo/acceptance/inputs.json",
);

export type AcceptanceInputs = {
  readonly workspacePath: string;
  readonly sourceDirectory: string;
  readonly composeFile: string;
};

export async function acceptanceInputs(): Promise<AcceptanceInputs> {
  try {
    const inputs = JSON.parse(
      await readFile(acceptanceInputsPath, "utf8"),
    ) as AcceptanceInputs;
    for (const value of [
      inputs.workspacePath,
      inputs.sourceDirectory,
      inputs.composeFile,
    ])
      if (typeof value !== "string" || !path.isAbsolute(value))
        throw new Error(
          "验收输入必须包含工作区、受控来源与 Compose 文件的绝对路径",
        );
    return inputs;
  } catch (cause) {
    throw new Error(
      "验收输入尚未准备；请通过 Turbo 任务运行正式 acceptance:prepare 前置",
      {
        cause,
      },
    );
  }
}
