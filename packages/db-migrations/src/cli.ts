import { restoreOfflineProductDataBackup } from "@digital/product-data";

import {
  prepareProductionCatalogue,
  prepareRestoredProductionCatalogue,
} from "./index.js";

try {
  const [command] = process.argv.slice(2);
  const productDataDirectory = process.env.DIGITAL_PRODUCT_DATA?.trim();
  if (!productDataDirectory) {
    throw new Error("DIGITAL_PRODUCT_DATA 必须指向绝对产品数据目录");
  }
  if (!process.platform || !productDataDirectory.startsWith("/")) {
    throw new Error("DIGITAL_PRODUCT_DATA 必须是绝对路径");
  }
  if (command === "prepare-only") {
    await prepareProductionCatalogue({ productDataDirectory });
  } else if (command === "offline-restore") {
    const backupDirectory = process.argv
      .slice(3)
      .find((argument) => argument !== "--")
      ?.trim();
    if (!backupDirectory?.startsWith("/"))
      throw new Error("offline-restore 需要绝对备份目录");
    await restoreOfflineProductDataBackup({
      backupDirectory,
      productDataDirectory,
      prepareProductionCatalogue: async (stage) => {
        await prepareRestoredProductionCatalogue(stage);
      },
    });
  } else {
    throw new Error(
      "用法：digital-db-migrate prepare-only|offline-restore <绝对备份目录>",
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "未知准备失败";
  // 正式部署命令是运维接口，不是异常转储。持久账本保存分类；stderr 要可操作，
  // 但不能泄露驱动内部信息或 SQLite 堆栈。
  process.stderr.write(`生产数据库准备失败：${message}\n`);
  process.exitCode = 1;
}
