import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliRuntime } from "../../src/main.ts";

const cleanupPaths: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

function runtime(
  args: readonly string[],
  productDataDirectory: string,
  environment: Record<string, string> = {},
) {
  let stdout = "";
  let stderr = "";
  return {
    runtime: {
      argv: ["node", "cli", ...args],
      streams: {
        stdin: {},
        stdout: { write: (chunk: string) => (stdout += chunk) },
        stderr: { write: (chunk: string) => (stderr += chunk) },
      },
      cwd: repositoryRoot,
      env: { DIGITAL_PRODUCT_DATA: productDataDirectory, ...environment },
      tty: { stdin: false, stdout: false, stderr: false },
      version: "1.2.3",
    } satisfies CliRuntime,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function prepareWithFormalMigration(
  productDataDirectory: string,
): Promise<void> {
  const result = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["--filter", "@digital/db-migrations", "prepare-only"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DIGITAL_PRODUCT_DATA: productDataDirectory },
        stdio: "pipe",
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  expect(result).toBe(0);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("离线备份与恢复维护命令", () => {
  it("拒绝运行中产品的备份，并只恢复允许的产品数据区域", async () => {
    const workspace = await temporaryDirectory("digital-offline-backup-");
    const sourceProductData = path.join(workspace, "source-product-data");
    const backupDirectory = path.join(workspace, "backup");
    const restoredProductData = path.join(workspace, "restored-product-data");
    const observedRoot = path.join(workspace, "RJ01668691");
    const secret = "offline-backup-test-secret-must-never-be-printed";
    await prepareWithFormalMigration(sourceProductData);
    await mkdir(observedRoot);
    await writeFile(path.join(observedRoot, "track.wav"), "observed bytes");
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (address.includes("/product/info/ajax")) {
        return new Response(
          JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "离线恢复去重演练作品",
              regist_date: "2026-08-01",
              work_image: "//img.dlsite.jp/offline-rehearsal.jpg",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (address === "https://img.dlsite.jp/offline-rehearsal.jpg") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });

    const activeProduct = runProduct(
      { productDataDirectory: sourceProductData, environment: {} },
      { start: (application) => application },
    );
    void activeProduct.result.workflow;
    const whileRunning = runtime(
      ["offline-backup", backupDirectory],
      sourceProductData,
    );
    await expect(runCli(whileRunning.runtime)).resolves.toBe(1);
    expect(whileRunning.stderr()).toContain("产品正在运行");
    await activeProduct.close();

    const registered = runtime(
      ["root-create", "恢复演练文件位置", observedRoot],
      sourceProductData,
    );
    await expect(runCli(registered.runtime)).resolves.toBe(0);
    const rootId = (JSON.parse(registered.stdout()) as { readonly id: string })
      .id;

    const scanned = runtime(["scan", rootId, "--json"], sourceProductData);
    await expect(runCli(scanned.runtime)).resolves.toBe(0);
    const initialScan = JSON.parse(scanned.stdout()) as {
      readonly executionId: string;
      readonly execution: {
        readonly outcome: string;
        readonly acceptedAssetId?: string;
      };
      readonly accepted?: { readonly entity?: { readonly id?: string } };
    };
    const executionId = initialScan.executionId;
    expect(initialScan.execution).toMatchObject({ outcome: "accepted" });
    const acceptedAssetId =
      initialScan.accepted?.entity?.id ?? initialScan.execution.acceptedAssetId;
    expect(acceptedAssetId).toEqual(expect.any(String));

    const connections = runtime(["source-connection-list"], sourceProductData, {
      DIGITAL_TMDB_ACCESS_TOKEN: secret,
    });
    await expect(runCli(connections.runtime)).resolves.toBe(0);
    expect(connections.stdout()).not.toContain(secret);
    const sourceConnectionInspection = JSON.parse(connections.stdout());

    const privateSecretPath = path.join(
      sourceProductData,
      "private-source-connections",
      "tmdb.json",
    );
    const privateSecretBytes = await readFile(privateSecretPath);
    await expect(lstat(privateSecretPath)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    await chmod(privateSecretPath, 0o600);
    await mkdir(path.join(sourceProductData, "cache"));
    await writeFile(
      path.join(sourceProductData, "cache", "rebuildable"),
      "cache",
    );
    await mkdir(path.join(sourceProductData, "future-durable-area"));
    await writeFile(
      path.join(sourceProductData, "future-durable-area", "state"),
      "future durable state",
    );
    const managedArtifactPath = path.join(
      sourceProductData,
      "managed-artifacts",
      "maintenance-rehearsal.bin",
    );
    const managedArtifactBytes = new Uint8Array([7, 6, 5, 4]);
    await writeFile(managedArtifactPath, managedArtifactBytes);
    await chmod(managedArtifactPath, 0o640);
    const surfaces = [
      "current-catalogue",
      "current-attention",
      "workflow-history",
    ] as const;
    const sourceSurfaces = new Map<string, unknown>();
    for (const surface of surfaces) {
      const sourceSurface = runtime(
        ["catalogue-surface", "--surface", surface],
        sourceProductData,
      );
      await expect(runCli(sourceSurface.runtime)).resolves.toBe(0);
      sourceSurfaces.set(surface, JSON.parse(sourceSurface.stdout()));
    }

    const backup = runtime(
      ["offline-backup", backupDirectory],
      sourceProductData,
    );
    await expect(runCli(backup.runtime)).resolves.toBe(0);
    expect(backup.stdout()).not.toContain(secret);
    await expect(
      lstat(path.join(backupDirectory, "cache")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(
        path.join(backupDirectory, "future-durable-area", "state"),
        "utf8",
      ),
    ).resolves.toBe("future durable state");
    await expect(
      lstat(path.join(backupDirectory, "observed-media")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await readFile(
        path.join(backupDirectory, "private-source-connections", "tmdb.json"),
      ),
    ).toEqual(privateSecretBytes);
    expect(
      (
        await lstat(
          path.join(backupDirectory, "private-source-connections", "tmdb.json"),
        )
      ).mode & 0o777,
    ).toBe(0o600);
    expect(
      await readFile(
        path.join(
          backupDirectory,
          "managed-artifacts",
          "maintenance-rehearsal.bin",
        ),
      ),
    ).toEqual(Buffer.from(managedArtifactBytes));
    expect(
      (
        await lstat(
          path.join(
            backupDirectory,
            "managed-artifacts",
            "maintenance-rehearsal.bin",
          ),
        )
      ).mode & 0o777,
    ).toBe(0o640);

    await mkdir(restoredProductData);
    const restored = runtime(
      ["offline-restore", backupDirectory],
      restoredProductData,
    );
    await expect(runCli(restored.runtime)).resolves.toBe(0);
    expect(restored.stdout()).not.toContain(secret);
    expect(
      await readFile(
        path.join(
          restoredProductData,
          "managed-artifacts",
          "maintenance-rehearsal.bin",
        ),
      ),
    ).toEqual(Buffer.from(managedArtifactBytes));
    expect(
      (
        await lstat(
          path.join(
            restoredProductData,
            "managed-artifacts",
            "maintenance-rehearsal.bin",
          ),
        )
      ).mode & 0o777,
    ).toBe(0o640);

    const restoredRoots = runtime(["root-list"], restoredProductData);
    await expect(runCli(restoredRoots.runtime)).resolves.toBe(0);
    expect(JSON.parse(restoredRoots.stdout())).toMatchObject([
      {
        id: rootId,
        displayName: "恢复演练文件位置",
        containerPath: observedRoot,
      },
    ]);

    const restoredExecution = runtime(
      ["inspect", executionId, "--json"],
      restoredProductData,
    );
    await expect(runCli(restoredExecution.runtime)).resolves.toBe(0);
    expect(JSON.parse(restoredExecution.stdout())).toMatchObject({
      executionId,
      execution: { status: "completed" },
    });

    for (const surface of surfaces) {
      const restoredSurface = runtime(
        ["catalogue-surface", "--surface", surface],
        restoredProductData,
      );
      await expect(runCli(restoredSurface.runtime)).resolves.toBe(0);
      expect(JSON.parse(restoredSurface.stdout())).toEqual(
        sourceSurfaces.get(surface),
      );
    }

    const restoredConnections = runtime(
      ["source-connection-list"],
      restoredProductData,
    );
    await expect(runCli(restoredConnections.runtime)).resolves.toBe(0);
    expect(restoredConnections.stdout()).toContain('"id":"tmdb"');
    expect(restoredConnections.stdout()).not.toContain(secret);
    expect(JSON.parse(restoredConnections.stdout())).toEqual(
      sourceConnectionInspection,
    );

    const refreshed = runtime(["scan", rootId, "--json"], restoredProductData);
    await expect(runCli(refreshed.runtime)).resolves.toBe(0);
    const resumedScan = JSON.parse(refreshed.stdout()) as {
      readonly executionId: string;
      readonly execution: {
        readonly outcome: string;
        readonly acceptedAssetId?: string;
        readonly reusedExecutionId?: string;
      };
      readonly accepted?: { readonly entity?: { readonly id?: string } };
    };
    expect(resumedScan.execution).toMatchObject({
      outcome: "no-change",
      acceptedAssetId,
      reusedExecutionId: executionId,
    });
    expect(
      resumedScan.accepted?.entity?.id ?? resumedScan.execution.acceptedAssetId,
    ).toBe(acceptedAssetId);
    expect(resumedScan.executionId).not.toBe(executionId);
  }, 120_000);
});
