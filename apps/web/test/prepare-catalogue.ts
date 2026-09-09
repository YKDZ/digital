import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 仅供测试使用的设置边界。先建立已审阅物理模式，再经正式迁移入口写入生产账本；
 * Web 运行时代码不得导入或使用该辅助方法，未准备目录仍刻意以关闭方式失败。
 */
export async function prepareWebProductData(
  productDataDirectory: string,
): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["packages/sqlite/dist/prepare-test-product-data.js"],
    {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        DIGITAL_DISPOSABLE_PRODUCT_DATA_ROOT: productDataDirectory,
      },
    },
  );
  await execFileAsync(
    process.execPath,
    ["packages/db-migrations/dist/cli.js", "prepare-only"],
    {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: { ...process.env, DIGITAL_PRODUCT_DATA: productDataDirectory },
    },
  );
}
