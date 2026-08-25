import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 仅供测试使用的数据库准备。运行时 CLI 代码刻意不了解 Drizzle，
 * 产品数据未准备时必须以关闭方式失败。
 */
export async function prepareCliProductData(
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
