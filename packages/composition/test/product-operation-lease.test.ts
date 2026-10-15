import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProductDataOperations } from "@digital/product-data";
import { afterEach, describe, expect, it } from "vitest";

import {
  composeAssetRefresh,
  composeAssetRefreshRuntime,
  composeAutomationHost,
} from "../src/runtime.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("product operation lease", () => {
  it("atomically excludes maintenance after a writer wins a cross-process barrier", async () => {
    const productDataDirectory = await temporaryProductData();
    const writer = startLeaseHolder("writer", productDataDirectory);
    try {
      await writer.waitFor("held");

      expect(() =>
        ProductDataOperations.forRoot(productDataDirectory).startMaintenance(),
      ).toThrow("产品正在写入");
    } finally {
      await writer.release();
    }
  });

  it("atomically excludes a writer while maintenance owns the same product root", async () => {
    const productDataDirectory = await temporaryProductData();
    const maintenance =
      ProductDataOperations.forRoot(productDataDirectory).startMaintenance();
    const writer = startLeaseHolder("writer", productDataDirectory);
    try {
      await expect(writer.waitFor("rejected")).resolves.toBeUndefined();
      expect(writer.output()).toContain("产品正在维护");
    } finally {
      maintenance.close();
      await writer.release();
    }
  });

  it("admits no production writer construction path while maintenance is held", async () => {
    const productDataDirectory = await temporaryProductData();
    const maintenance =
      ProductDataOperations.forRoot(productDataDirectory).startMaintenance();
    try {
      expect(() => composeAssetRefresh(productDataDirectory, {})).toThrow(
        "产品正在维护",
      );
      expect(() => composeAutomationHost(productDataDirectory)).toThrow(
        "产品正在维护",
      );
      expect(() => composeAssetRefreshRuntime(productDataDirectory)).toThrow(
        "产品正在维护",
      );
    } finally {
      maintenance.close();
    }
  });

  it("ignores a structural fake at the public composition call and still obtains real writer authority", async () => {
    const productDataDirectory = await temporaryProductData();
    const maintenance =
      ProductDataOperations.forRoot(productDataDirectory).startMaintenance();
    try {
      const fake = { close() {}, isCurrent: () => true };
      expect(() =>
        composeAssetRefresh(productDataDirectory, {}, {
          productWriterLease: fake,
        } as never),
      ).toThrow("产品正在维护");
    } finally {
      maintenance.close();
    }
  });
});

async function temporaryProductData(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "digital-product-operation-"));
  temporaryRoots.push(root);
  return path.join(root, "product-data");
}

function startLeaseHolder(
  operation: "writer",
  productDataDirectory: string,
): {
  readonly waitFor: (state: "held" | "rejected") => Promise<void>;
  readonly output: () => string;
  readonly release: () => Promise<void>;
} {
  const moduleUrl = new URL("../../product-data/dist/index.js", import.meta.url)
    .href;
  const source = `
    import { ProductDataOperations } from ${JSON.stringify(moduleUrl)};
    let lease;
    try {
      lease = ProductDataOperations.forRoot(${JSON.stringify(productDataDirectory)}).${operation === "writer" ? "startWriter" : "startMaintenance"}();
      process.stdout.write(JSON.stringify({ state: "held" }) + "\\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ state: "rejected", message: error instanceof Error ? error.message : String(error) }) + "\\n");
    }
    process.stdin.once("data", () => {
      lease?.close();
      process.exit(0);
    });
  `;
  const child = spawn(
    process.execPath,
    ["--conditions=digital-source", "--input-type=module", "--eval", source],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    async waitFor(state) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve, reject) => {
        deadline = setTimeout(() => {
          reject(
            new Error(`lease child did not reach ${state}: ${stdout}${stderr}`),
          );
        }, 5_000);
        const observe = () => {
          const line = stdout.split("\n").find((entry) => entry.length > 0);
          if (line === undefined) return;
          try {
            const event = JSON.parse(line) as { readonly state?: string };
            if (event.state !== state) {
              reject(
                new Error(
                  `lease child reached ${event.state ?? "unknown"}, expected ${state}: ${stdout}${stderr}`,
                ),
              );
              return;
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        child.stdout.on("data", observe);
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          reject(
            new Error(
              `lease child exited before barrier: ${String(code)}/${String(signal)}: ${stdout}${stderr}`,
            ),
          );
        });
        observe();
      }).finally(() => {
        if (deadline !== undefined) clearTimeout(deadline);
      });
    },
    output: () => stdout,
    async release() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write("release\n");
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0 && signal === null) {
            resolve();
            return;
          }
          reject(
            new Error(
              `lease child failed while releasing: ${String(code)}/${String(signal)}: ${stdout}${stderr}`,
            ),
          );
        });
      });
    },
  };
}
