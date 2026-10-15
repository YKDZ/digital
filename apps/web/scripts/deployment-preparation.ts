import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  acceptanceInputs,
  type AcceptanceInputs,
} from "./acceptance-inputs.ts";

export const preparedDeploymentPath = path.resolve(
  import.meta.dirname,
  "../.turbo/deployment/prepared.json",
);

export type PreparedDeployment = AcceptanceInputs & {
  readonly standaloneImage: string;
  readonly runtimeImage: string;
};

export async function deploymentImages(): Promise<PreparedDeployment> {
  const inputs = await acceptanceInputs();
  const standaloneImage = process.env.DIGITAL_DEPLOYMENT_STANDALONE_IMAGE;
  const runtimeImage = process.env.DIGITAL_DEPLOYMENT_RUNTIME_IMAGE;
  if (standaloneImage !== undefined || runtimeImage !== undefined) {
    if (!standaloneImage || !runtimeImage)
      throw new Error(
        "显式部署需要同时提供 standalone 与 runtime 两份镜像引用",
      );
    return {
      ...inputs,
      standaloneImage,
      runtimeImage,
    };
  }
  let prepared: PreparedDeployment;
  try {
    prepared = JSON.parse(
      await readFile(preparedDeploymentPath, "utf8"),
    ) as PreparedDeployment;
  } catch (error) {
    throw new Error(
      "部署镜像尚未准备；请通过 deployment 的 Turbo 任务运行其正式前置",
      { cause: error },
    );
  }
  if (
    prepared.workspacePath !== inputs.workspacePath ||
    prepared.sourceDirectory !== inputs.sourceDirectory ||
    prepared.composeFile !== inputs.composeFile ||
    !prepared.standaloneImage ||
    !prepared.runtimeImage
  )
    throw new Error("已准备镜像与本次工作区不一致；请重新运行正式部署准备");
  return prepared;
}
