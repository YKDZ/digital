import type { ProductDelivery } from "@digital/product-application";

import { composeProductApplication } from "./runtime.ts";

export type ProductConfiguration = {
  readonly productDataDirectory?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

/** 可执行根保留组合资源的唯一关闭权；交付层永远不会取得该能力。 */
export type ProductRun<Result> = {
  readonly result: Result;
  close(): Promise<void>;
};

/**
 * 可执行根的唯一组合入口：先建立一个产品应用，再把它交给恰好一种交付方式。
 */
export function runProduct<Result>(
  configuration: ProductConfiguration,
  delivery: ProductDelivery<Result>,
): ProductRun<Result> {
  const product = composeProductApplication(configuration);
  return {
    result: delivery.start(product.application),
    async close() {
      await product.close();
    },
  };
}
