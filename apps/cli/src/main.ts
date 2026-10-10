import { homedir } from "node:os";
import path from "node:path";

import {
  CliResources,
  createCliCommand,
  greet,
  runCli as runCliDelivery,
  type CliProductApplication,
  type CliRuntime,
  type Greeting,
} from "@digital/cli-delivery";
import { runProduct } from "@digital/composition";
import { resolveSourceIoFromEnvironment } from "@digital/test-support/source-io";

export { CliResources, createCliCommand, greet };
export type { CliProductApplication, CliRuntime, Greeting };

/** 可执行包只解析部署配置，然后把 CLI 交付绑定到产品应用。 */
export async function runCli(
  runtime: CliRuntime,
  application?: CliProductApplication,
): Promise<number> {
  const productDataDirectory = configuredProductDataDirectory(runtime);
  const configuredRuntime: CliRuntime = {
    ...runtime,
    env: {
      ...runtime.env,
      DIGITAL_PRODUCT_DATA: productDataDirectory,
    },
  };
  if (application !== undefined)
    return await runCliDelivery(configuredRuntime, application);
  // 来源装配在任何产品工作之前解析：受控清单无效时这条正式 CLI 入口直接失败，
  // 不会带着真实默认值继续。
  const sourceIo = await resolveSourceIoFromEnvironment(configuredRuntime.env);
  const product = runProduct(
    {
      productDataDirectory,
      environment: runtime.env,
      sourceIo,
    },
    {
      start: (product) => runCliDelivery(configuredRuntime, product),
    },
  );
  try {
    return await product.result;
  } finally {
    await product.close();
  }
}

function configuredProductDataDirectory(runtime: CliRuntime): string {
  return (
    runtime.env.DIGITAL_PRODUCT_DATA?.trim() ||
    path.join(
      runtime.env.XDG_DATA_HOME?.trim() ||
        path.join(homedir(), ".local", "share"),
      "digital",
    )
  );
}
