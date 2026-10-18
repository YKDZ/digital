import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLayout } from "../src/internal/paths.ts";
import { HeldCommands } from "../src/internal/processes.ts";
import { assertProductRootOffline } from "../src/internal/product-offline.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("环境正式维护命令合同", () => {
  it("选定工作区没有正式维护命令时拒绝确认离线", async () => {
    const result = await checkIsolatedWorkspace({
      maintenancePackage: "absent",
    });

    expect(result.reason).toContain("离线核验未成功");
  });

  it("正式维护命令找到包但交付产物无法执行时拒绝而不确认残余", async () => {
    const result = await checkIsolatedWorkspace({
      maintenancePackage: "broken",
    });

    expect(result.reason).toContain("离线核验未成功");
  });
});

async function checkIsolatedWorkspace(input: {
  readonly maintenancePackage: "absent" | "broken";
}): Promise<{ readonly reason: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "digital-offline-command-"));
  temporaryRoots.push(root);
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });

  if (input.maintenancePackage === "broken") {
    await writeFile(
      path.join(workspacePath, "package.json"),
      JSON.stringify({
        name: "isolated-maintenance-workspace",
        private: true,
        scripts: {
          "product:maintenance":
            "pnpm --silent --filter @digital/product-maintenance --fail-if-no-match run cli",
        },
      }),
    );
    await writeFile(
      path.join(workspacePath, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    const packageDirectory = path.join(
      workspacePath,
      "packages",
      "product-maintenance",
    );
    await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
    await writeFile(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "@digital/product-maintenance",
        version: "1.0.0",
        scripts: { cli: "node dist/cli.js" },
      }),
    );
    await writeFile(
      path.join(packageDirectory, "dist", "cli.js"),
      'import "./missing-chunk.mjs";\n',
    );
  }

  const layout = createLayout(workspacePath, "offline-check");
  if ("reason" in layout) throw new Error(layout.reason);
  await mkdir(layout.productDataRoot, { recursive: true });
  const held = new HeldCommands();
  const result = await assertProductRootOffline({
    layout,
    inputs: [],
    continuationEligible: true,
    logFile: path.join(workspacePath, "offline-check.log"),
    held,
  });
  await held.close();

  expect(result).toHaveProperty("reason");
  return result as { readonly reason: string };
}
