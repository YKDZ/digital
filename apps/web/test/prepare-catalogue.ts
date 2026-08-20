import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Test-only setup boundary. Web runtime code must not import Drizzle or use
 * this helper; an unprepared product-data directory intentionally fails closed.
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
