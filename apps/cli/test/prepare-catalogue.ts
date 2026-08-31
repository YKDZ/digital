import { prepareProductionCatalogue } from "@digital/db-migrations";

/**
 * 仅供端到端测试使用的产品数据准备。旅程复用正式迁移入口，使源码态与
 * 构建产物态接受完全相同的迁移账本；运行时 CLI 仍然不了解迁移实现。
 */
export async function prepareCliProductData(
  productDataDirectory: string,
): Promise<void> {
  await prepareProductionCatalogue({ productDataDirectory });
}
