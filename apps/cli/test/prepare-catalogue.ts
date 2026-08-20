import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Test-only database preparation. Runtime CLI code deliberately remains
 * unaware of Drizzle and must fail closed when product data is unprepared.
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
