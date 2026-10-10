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

import { runCli as runCliEntry, type CliRuntime } from "../../src/main.ts";

const cleanupPaths: string[] = [];

/**
 * 自有收尾账本：清理要等「整条测试体异步链」真正落定，而不是只等当时已经登记的叶子 Promise
 * 快照。被超时放弃的用例之后仍会继续 mkdir／runProduct／scan／restore，此时撤 fetch 替身或
 * 删除自有临时根都会与仍在写入的链交错，留下与业务无关的 ENOTEMPTY 次生失败。
 * 判据复用用例自己声明的预算：那条链在预算内没有落定，就既不撤替身也不删除（宁可留下自有根），
 * 不做无限重试，也不新增产品锁或计时框架。
 */
const ownCaseBudgetMilliseconds = 120_000;
let ownChain:
  | { readonly givenUp: Promise<false>; readonly settled: Promise<unknown> }
  | undefined;

function runWithOwnChain(body: () => Promise<unknown>): Promise<unknown> {
  let giveUp: (settled: false) => void = () => {};
  const givenUp = new Promise<false>((resolve) => {
    giveUp = resolve;
  });
  const timer = setTimeout(() => giveUp(false), ownCaseBudgetMilliseconds);
  const settled = body().finally(() => clearTimeout(timer));
  ownChain = { givenUp, settled };
  return settled;
}

function runCli(runtime: CliRuntime): Promise<number> {
  return runCliEntry(runtime);
}

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

/** `workflow-history` 公开面的最小可读形状。 */
type SurfaceHistory = {
  readonly items: readonly {
    readonly execution: { readonly id: string; readonly outcome?: string };
  }[];
};

/**
 * `scan … --json` 的公开检查（`temporary-asset-refresh-inspection/v1`）在本用例里需要读到的
 * 父子位置。已接受资产身份挂在 `itemResults[i].accepted.entity` 上；父执行顶层的
 * `acceptedAssetId`／`reusedExecutionId` 仅在整执行级复用命中时发出，因此都是可选的。
 */
type ScanInspection = {
  readonly executionId: string;
  readonly execution: {
    readonly outcome: string;
    readonly status?: string;
    readonly acceptedAssetId?: string;
    readonly reusedExecutionId?: string;
    readonly workItems?: readonly {
      readonly key: string;
      readonly relativePaths: readonly string[];
      readonly outcome?: string;
      readonly reason?: string;
      readonly acceptedAssetId?: string;
      readonly retainedAssetId?: string;
      readonly reuseAcceptedBoundary?: boolean;
    }[];
  };
  readonly itemResults?: readonly {
    readonly key: string;
    readonly relativePaths: readonly string[];
    readonly outcome?: string;
    readonly reason?: string;
    readonly accepted?: {
      readonly entity?: { readonly id: string; readonly kind: string };
      readonly sourceAssociations?: readonly {
        readonly sourceIdentity: string;
        readonly nativeAddress: string;
      }[];
    };
  }[];
};

/**
 * 恢复后复扫的复用位置（真实脱敏公开 JSON 留档：
 * `R/current/07/evidence/07-scan-inspection-reopened.json`／
 * `07-scan-inspection-resumed.json`）：命中的是「按已接受边界逐项复用」这条终态，父执行顶层
 * 不发出 `acceptedAssetId`／`reusedExecutionId`；被复用的资产身份挂在子项 `retainedAssetId`／
 * `acceptedAssetId` 上，并与备份前按父子位置取到的同一条已接受资产互指，
 * `itemResults[i].accepted.entity` 也仍在。
 */
function expectRetainedAcceptedAsset(
  scan: ScanInspection,
  acceptedAssetId: string,
  backedUpSourceAssociation: {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  },
) {
  expect(scan.execution).toMatchObject({
    outcome: "no-change",
    status: "completed",
  });
  const [reusedWorkItem] = scan.execution.workItems ?? [];
  expect(reusedWorkItem).toMatchObject({
    relativePaths: ["track.wav"],
    outcome: "no-change",
    reason: "保留已经确认的资产范围",
    reuseAcceptedBoundary: true,
    retainedAssetId: acceptedAssetId,
    acceptedAssetId,
  });
  const itemResult = scan.itemResults?.find(
    ({ key }) => key === reusedWorkItem?.key,
  );
  expect(itemResult?.accepted?.entity).toMatchObject({
    id: acceptedAssetId,
    kind: "digital-asset",
  });
  expect(itemResult?.accepted?.sourceAssociations).toEqual([
    backedUpSourceAssociation,
  ]);
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

/**
 * 清理顺序：先等整条自有测试体链落定（其中每一步都在写自己的产品数据根），再撤全局替身，
 * 最后删除自有临时根；未落定时两者都跳过，避免与仍在写入的链并发 `rm -r`。
 */
afterEach(async () => {
  const chain = ownChain;
  ownChain = undefined;
  if (
    chain !== undefined &&
    (await Promise.race([
      chain.settled.then(
        () => true,
        () => true,
      ),
      chain.givenUp,
    ])) === false
  )
    return;
  vi.unstubAllGlobals();
  for (const directory of cleanupPaths.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("离线备份与恢复维护命令", () => {
  it(
    "拒绝运行中产品的备份，并只恢复允许的产品数据区域",
    () =>
      runWithOwnChain(async () => {
        const workspace = await temporaryDirectory(
          "completion-07-offline-backup-",
        );
        const sourceProductData = path.join(workspace, "source-product-data");
        const backupDirectory = path.join(workspace, "backup");
        const restoredProductData = path.join(
          workspace,
          "restored-product-data",
        );
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
          [
            "library-create",
            "恢复演练文件位置",
            "--directory",
            observedRoot,
            "--json",
          ],
          sourceProductData,
        );
        await expect(runCli(registered.runtime)).resolves.toBe(0);
        const rootId = (
          JSON.parse(registered.stdout()) as {
            readonly rootIds: readonly string[];
          }
        ).rootIds[0]!;

        const scanned = runtime(["scan", rootId, "--json"], sourceProductData);
        await expect(runCli(scanned.runtime)).resolves.toBe(0);
        const initialScan = JSON.parse(scanned.stdout()) as ScanInspection;
        const executionId = initialScan.executionId;
        expect(initialScan.execution).toMatchObject({ outcome: "accepted" });

        // 真实公开 JSON（完整脱敏留档：R/current/07/evidence/07-scan-inspection-initial.json）
        // 钉住这次目录包扫描的父子位置：父执行顶层没有 `accepted`，也没有
        // `execution.acceptedAssetId`；子项已接受资产只落在同 key 的
        // `execution.workItems[i].acceptedAssetId` 上，而 `accepted.entity` 只挂在
        // `itemResults[i].accepted.entity` —— 父子里侧量必须互指同一个资产身份。
        const [acceptedWorkItem] =
          initialScan.execution.workItems?.filter(
            ({ outcome, acceptedAssetId }) =>
              outcome === "accepted" && acceptedAssetId !== undefined,
          ) ?? [];
        expect(acceptedWorkItem?.key).toBe("dlsite-directory:.");
        expect(acceptedWorkItem?.relativePaths).toEqual(["track.wav"]);
        const acceptedItemResult = initialScan.itemResults?.find(
          ({ key }) => key === acceptedWorkItem?.key,
        );
        expect(acceptedItemResult?.accepted?.entity).toBeDefined();
        const acceptedAssetId = acceptedItemResult!.accepted!.entity!.id;
        expect(acceptedAssetId).toEqual(expect.any(String));
        expect(acceptedAssetId).toBe(acceptedWorkItem!.acceptedAssetId);
        expect(acceptedItemResult!.accepted!.entity!.kind).toBe(
          "digital-asset",
        );
        // 被备份的资产身份就是这条 DLsite 目录包所声明的数字资产及其来源关联。
        const backedUpSourceAssociation = {
          sourceIdentity: "dlsite",
          nativeAddress:
            "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
        } as const;
        expect(acceptedItemResult!.accepted!.sourceAssociations).toEqual([
          backedUpSourceAssociation,
        ]);

        const connections = runtime(
          ["source-connection-list"],
          sourceProductData,
          {
            DIGITAL_TMDB_ACCESS_TOKEN: secret,
          },
        );
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
            path.join(
              backupDirectory,
              "private-source-connections",
              "tmdb.json",
            ),
          ),
        ).toEqual(privateSecretBytes);
        expect(
          (
            await lstat(
              path.join(
                backupDirectory,
                "private-source-connections",
                "tmdb.json",
              ),
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

        const restoredRoot = runtime(
          ["scan", rootId, "--scope", ".", "--json"],
          restoredProductData,
        );
        await expect(runCli(restoredRoot.runtime)).resolves.toBe(0);
        const reopenedScan = JSON.parse(
          restoredRoot.stdout(),
        ) as ScanInspection;
        expectRetainedAcceptedAsset(
          reopenedScan,
          acceptedAssetId,
          backedUpSourceAssociation,
        );
        const reopenedExecutionId = reopenedScan.executionId;

        const restoredExecution = runtime(
          ["inspect", executionId, "--json"],
          restoredProductData,
        );
        await expect(runCli(restoredExecution.runtime)).resolves.toBe(0);
        expect(JSON.parse(restoredExecution.stdout())).toMatchObject({
          executionId,
          execution: { status: "completed" },
        });

        // 真实指纹（R/current/07/logs/07-batch-d-drift.log 的 SURFACE-FP 行）：恢复后的
        // current-catalogue 与 current-attention 与源库逐字段相等；workflow-history 是只增
        // 不减的执行台账，重开扫描自身追加一条 no-change 执行，源库那条已接受执行原样保留。
        for (const surface of [
          "current-catalogue",
          "current-attention",
        ] as const) {
          const restoredSurface = runtime(
            ["catalogue-surface", "--surface", surface],
            restoredProductData,
          );
          await expect(runCli(restoredSurface.runtime)).resolves.toBe(0);
          expect(JSON.parse(restoredSurface.stdout())).toEqual(
            sourceSurfaces.get(surface),
          );
        }

        const restoredHistorySurface = runtime(
          ["catalogue-surface", "--surface", "workflow-history"],
          restoredProductData,
        );
        await expect(runCli(restoredHistorySurface.runtime)).resolves.toBe(0);
        const restoredHistory = JSON.parse(
          restoredHistorySurface.stdout(),
        ) as SurfaceHistory;
        const sourceHistory = sourceSurfaces.get(
          "workflow-history",
        ) as SurfaceHistory;
        expect(sourceHistory.items).toHaveLength(1);
        expect(
          restoredHistory.items.map(({ execution }) => [
            execution.id,
            execution.outcome,
          ]),
        ).toEqual([
          [reopenedExecutionId, "no-change"],
          ...sourceHistory.items.map(({ execution }) => [
            execution.id,
            execution.outcome,
          ]),
        ]);
        // 被备份的已接受执行本身逐字段不变（含 sourceRecords、recognitionResults、
        // resultReferences 与 sourceRefreshRuns），历史面除重开自身外没有第二处新增。
        expect(restoredHistory.items[1]).toEqual(sourceHistory.items[0]);

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

        const refreshed = runtime(
          ["scan", rootId, "--json"],
          restoredProductData,
        );
        await expect(runCli(refreshed.runtime)).resolves.toBe(0);
        const resumedScan = JSON.parse(refreshed.stdout()) as ScanInspection;
        // 逐项核对与公开面检查之后再次复扫仍是同一条被复用的已接受资产（没有第二次接受）。
        expectRetainedAcceptedAsset(
          resumedScan,
          acceptedAssetId,
          backedUpSourceAssociation,
        );
        expect(resumedScan.executionId).not.toBe(executionId);
        expect(resumedScan.executionId).not.toBe(reopenedExecutionId);
      }),
    ownCaseBudgetMilliseconds,
  );
});
