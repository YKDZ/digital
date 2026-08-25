import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 仅供测试使用的设置边界。Web 运行时代码不得导入 Drizzle 或使用该辅助方法；
 * 未准备的产品数据目录刻意以关闭方式失败。
 */
export async function prepareWebProductData(
  productDataDirectory: string,
): Promise<void> {
  await execFileAsync(
    "pnpm",
    ["--filter", "@digital/sqlite", "db:prepare:test-product-data"],
    {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        DIGITAL_DISPOSABLE_PRODUCT_DATA_ROOT: productDataDirectory,
      },
    },
  );
}
