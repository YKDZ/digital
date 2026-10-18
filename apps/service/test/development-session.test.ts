import { spawn } from "node:child_process";
import { execFile as execFileCallback } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectEnvironment, stopEnvironment } from "@digital/environment";
import { createPublicApiClient } from "@digital/public-api";
import { expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureMaterial = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/material"),
);
const environment = "development-session";
const environmentPortExclusions = new Set([4_321, 34_650]);
const ignoredWorkspaceSegments = new Set([
  ".agents",
  ".codex",
  ".digital",
  ".git",
  ".scratch",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

it(
  "领域、应用和来源更新进入 HTTP 服务，隔离测试与 TUI 共存【安装客户端】",
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "digital-development-session-"),
    );
    const copiedWorkspace = path.join(temporaryRoot, "workspace");
    await cp(workspaceRoot, copiedWorkspace, {
      recursive: true,
      filter: (source) =>
        !path
          .relative(workspaceRoot, source)
          .split(path.sep)
          .some((segment) => ignoredWorkspaceSegments.has(segment)),
    });

    const watcherProcesses: ReturnType<typeof spawn>[] = [];
    let passed = false;
    let watcherOutput = "";
    let firstEntryMilliseconds = 0;
    let savedConfigurationReentryMilliseconds = 0;
    let developmentEntryMilliseconds = 0;
    let explicitRefreshMilliseconds = 0;
    let applicationUpdateMilliseconds = 0;
    let domainUpdateMilliseconds = 0;
    let sourceUpdateMilliseconds = 0;
    let failedBuildRecoveryMilliseconds = 0;
    let isolatedTestMilliseconds = 0;

    const rememberOutput = (chunk: Buffer): void => {
      watcherOutput = `${watcherOutput}${chunk.toString("utf8")}`.slice(
        -4_000_000,
      );
    };

    try {
      await execFile("pnpm", ["install", "--frozen-lockfile", "--offline"], {
        cwd: copiedWorkspace,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      await execFile(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build",
          "--filter=@digital/service",
          "--filter=@digital/db-migrations",
          "--filter=@digital/tui",
          "--env-mode=loose",
        ],
        {
          cwd: copiedWorkspace,
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );

      const port = await availablePort();
      const inputDirectory = path.join(temporaryRoot, "observed-material");
      await mkdir(inputDirectory, { recursive: true });
      await cp(
        path.join(fixtureMaterial, "RJ01029383"),
        path.join(inputDirectory, "RJ01029383"),
        { recursive: true },
      );

      const firstEntryStarted = performance.now();
      const firstEntry = await runPnpm(copiedWorkspace, [
        "environment",
        "enter",
        "--workspace-path",
        copiedWorkspace,
        "--environment",
        environment,
        "--source-mode",
        "offline",
        "--input",
        inputDirectory,
        "--config-json",
        JSON.stringify({ webPort: port }),
      ]);
      firstEntryMilliseconds = performance.now() - firstEntryStarted;
      const firstEntryResult = lastJsonLine(firstEntry.stdout);
      expect(firstEntryResult).toMatchObject({
        variant: "entered",
        data: { run: { state: "ready" }, preparation: { status: "prepared" } },
      });

      let client = createPublicApiClient({
        baseUrl: `http://127.0.0.1:${String(port)}`,
      });
      const retainedLibrary = await client.saveAssetLibrary({
        displayName: "开发会话保留资料",
        directories: [inputDirectory],
        recognitionProfileIds: ["dlsite-voice"],
        sourceIdentities: ["dlsite"],
      });

      await runPnpm(copiedWorkspace, [
        "environment",
        "stop",
        "--workspace-path",
        copiedWorkspace,
        "--environment",
        environment,
      ]);
      const reentryStarted = performance.now();
      const reentry = await runPnpm(copiedWorkspace, [
        "environment",
        "enter",
        "--workspace-path",
        copiedWorkspace,
        "--environment",
        environment,
      ]);
      savedConfigurationReentryMilliseconds =
        performance.now() - reentryStarted;
      expect(lastJsonLine(reentry.stdout)).toMatchObject({
        variant: "entered",
        data: { preparation: { status: "reused" }, run: { state: "ready" } },
      });
      client = createPublicApiClient({
        baseUrl: `http://127.0.0.1:${String(port)}`,
      });
      await expect
        .poll(async () => (await client.listAssetLibraries()).items)
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: retainedLibrary.id,
              displayName: "开发会话保留资料",
            }),
          ]),
        );
      await runPnpm(copiedWorkspace, [
        "environment",
        "stop",
        "--workspace-path",
        copiedWorkspace,
        "--environment",
        environment,
      ]);

      const watcherStarted = performance.now();
      const watcher = spawn("pnpm", ["preview:dev", environment], {
        cwd: copiedWorkspace,
        detached: process.platform !== "win32",
        env: { ...process.env, TERM: "xterm-256color" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      watcherProcesses.push(watcher);
      watcher.stdout.on("data", (chunk: Buffer) => {
        rememberOutput(chunk);
      });
      watcher.stderr.on("data", (chunk: Buffer) => {
        rememberOutput(chunk);
      });
      const baseUrl = `http://127.0.0.1:${String(port)}`;
      await waitForReady(baseUrl, watcher, () => watcherOutput);
      developmentEntryMilliseconds = performance.now() - watcherStarted;
      client = createPublicApiClient({ baseUrl });
      expect(
        (await client.listAssetLibraries()).items.map(({ id }) => id),
      ).toContain(retainedLibrary.id);
      expect(
        (
          await client.listAssets({
            assetLibraryId: retainedLibrary.id,
            limit: 100,
          })
        ).items,
      ).toEqual([]);

      const developmentDomainArtifact = path.join(
        copiedWorkspace,
        "packages/domain/.turbo/development/dist/effective-metadata.js",
      );
      const developmentDomainArtifactBefore = await readFile(
        developmentDomainArtifact,
      );
      const librariesBeforeIsolatedTest = await client.listAssetLibraries();
      const isolatedTestStarted = performance.now();
      await execFile(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "test",
          "--filter=@digital/domain",
          "--env-mode=loose",
        ],
        {
          cwd: copiedWorkspace,
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      isolatedTestMilliseconds = performance.now() - isolatedTestStarted;
      expect(await readFile(developmentDomainArtifact)).toEqual(
        developmentDomainArtifactBefore,
      );
      expect((await fetch(new URL("/api/ready", baseUrl))).status).toBe(200);
      expect(await client.listAssetLibraries()).toEqual(
        librariesBeforeIsolatedTest,
      );

      const scanStarted = performance.now();
      const initialScan = await client.startAssetLibraryScan(
        retainedLibrary.id,
      );
      await waitForScan(client, initialScan.parentExecutionId);
      const firstAssets = await client.listAssets({
        assetLibraryId: retainedLibrary.id,
        limit: 100,
      });
      expect(firstAssets.items.length).toBeGreaterThan(0);
      const assetId = firstAssets.items[0]!.id;
      const oldMediaPath = path.join(
        inputDirectory,
        "RJ01029383",
        "おまけ音声",
        "12++_おまけ。30秒の寝息を30分ループ.wav",
      );
      const updatedMediaPath = path.join(
        path.dirname(oldMediaPath),
        "显式刷新后可见的音声.wav",
      );
      await rename(oldMediaPath, updatedMediaPath);
      const unchangedEvidence = await client.listAssetEvidence(assetId, {
        kind: "local-observations",
        limit: 100,
      });
      expect(
        unchangedEvidence.items.some(
          (item) =>
            item.kind === "local-observation" &&
            item.relativePath.includes("12++_おまけ"),
        ),
      ).toBe(true);

      const refreshed = await client.startAssetLibraryScan(retainedLibrary.id);
      const refreshedScan = await waitForScan(
        client,
        refreshed.parentExecutionId,
      );
      explicitRefreshMilliseconds = performance.now() - scanStarted;
      expect(
        refreshedScan.directories.some((directory) =>
          directory.files.some((file) =>
            file.relativePaths.some((relativePath) =>
              relativePath.includes("显式刷新后可见的音声.wav"),
            ),
          ),
        ),
      ).toBe(true);

      const sourceFile = path.join(
        copiedWorkspace,
        "packages/application/src/asset-libraries.ts",
      );
      const originalApplication = await readFile(sourceFile, "utf8");
      const displayNameExpression =
        "const displayName = input.displayName.trim();";
      expect(originalApplication).toContain(displayNameExpression);
      const updatedApplication = originalApplication.replace(
        displayNameExpression,
        'const displayName = input.displayName.trim().replace("开发更新旧标记", "开发更新新标记");',
      );
      const inFlightScanStart = await client.startAssetLibraryScan(
        retainedLibrary.id,
      );
      const inFlightScanBeforeUpdate = await client.inspectAssetLibraryScan(
        inFlightScanStart.parentExecutionId,
      );
      expect(inFlightScanBeforeUpdate.status).toBe("running");
      const previousApplicationGeneration = await inspectEnvironment({
        workspacePath: copiedWorkspace,
        environment,
      });
      expect(previousApplicationGeneration.run.pid).not.toBeNull();
      const applicationUpdateStarted = performance.now();
      await writeFile(sourceFile, updatedApplication);
      await waitForNewReady(
        copiedWorkspace,
        watcher,
        previousApplicationGeneration.run.runId ?? undefined,
        () => watcherOutput,
      );
      const updatedApplicationGeneration = await inspectEnvironment({
        workspacePath: copiedWorkspace,
        environment,
      });
      expect(updatedApplicationGeneration.run.runId).not.toBe(
        previousApplicationGeneration.run.runId,
      );
      expect(updatedApplicationGeneration.run.pid).not.toBeNull();
      expect(updatedApplicationGeneration.serviceReadiness).toBe("ready");
      await waitForProcessExit(previousApplicationGeneration.run.pid!);
      applicationUpdateMilliseconds =
        performance.now() - applicationUpdateStarted;
      client = createPublicApiClient({ baseUrl });
      const inFlightScanAfterUpdate = await client.inspectAssetLibraryScan(
        inFlightScanStart.parentExecutionId,
      );
      const completedInFlightScanAfterUpdate = await waitForScan(
        client,
        inFlightScanStart.parentExecutionId,
      );
      expect(inFlightScanAfterUpdate).toMatchObject({
        parentExecutionId: inFlightScanStart.parentExecutionId,
        assetLibraryId: retainedLibrary.id,
      });
      expect(inFlightScanAfterUpdate.directories.map(({ id }) => id)).toEqual(
        inFlightScanBeforeUpdate.directories.map(({ id }) => id),
      );
      expect(completedInFlightScanAfterUpdate).toMatchObject({
        parentExecutionId: inFlightScanStart.parentExecutionId,
        assetLibraryId: retainedLibrary.id,
        status: "completed",
      });
      const codeUpdatedLibrary = await client.saveAssetLibrary({
        displayName: "开发更新旧标记",
        directories: [inputDirectory],
        recognitionProfileIds: ["dlsite-voice"],
        sourceIdentities: ["dlsite"],
      });
      expect(codeUpdatedLibrary.displayName).toBe("开发更新新标记");
      expect(
        (await client.listAssetLibraries()).items.map(({ id }) => id),
      ).toContain(retainedLibrary.id);

      const pinnedTitle = await client.prepareMetadataDecision(assetId, {
        kind: "pin",
        property: "asset.title",
        value: "领域更新后仍保留的人工标题",
      });
      await expect(
        client.confirmMetadataDecision(pinnedTitle.previewId),
      ).resolves.toMatchObject({ status: "applied" });
      const domainFile = path.join(
        copiedWorkspace,
        "packages/domain/src/effective-metadata.ts",
      );
      const originalDomain = await readFile(domainFile, "utf8");
      const selectedPreferenceBranch = "  if (selectedPreferenceIndex === 0) {";
      expect(originalDomain).toContain(selectedPreferenceBranch);
      const updatedDomain = originalDomain.replace(
        selectedPreferenceBranch,
        "  if (selected.manualDecision === true)\n" +
          "    return unranked(selected, alternatives, contributors);\n" +
          selectedPreferenceBranch,
      );
      const previousDomainGeneration = await inspectEnvironment({
        workspacePath: copiedWorkspace,
        environment,
      });
      expect(previousDomainGeneration.run.pid).not.toBeNull();
      const domainUpdateStarted = performance.now();
      await writeFile(domainFile, updatedDomain);
      await waitForNewReady(
        copiedWorkspace,
        watcher,
        previousDomainGeneration.run.runId ?? undefined,
        () => watcherOutput,
      );
      await waitForProcessExit(previousDomainGeneration.run.pid!);
      domainUpdateMilliseconds = performance.now() - domainUpdateStarted;
      client = createPublicApiClient({ baseUrl });
      const currentAfterDomainUpdate = await client.listAssetEvidence(assetId, {
        kind: "current-values",
        limit: 100,
      });
      expect(currentAfterDomainUpdate.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "current-value",
            evidence: expect.objectContaining({
              property: "asset.title",
              result: expect.objectContaining({
                status: "resolved",
                values: expect.arrayContaining([
                  expect.objectContaining({
                    value: "领域更新后仍保留的人工标题",
                    reasoning: { kind: "unranked-source-assertion" },
                  }),
                ]),
              }),
            }),
          }),
        ]),
      );

      const providerFile = path.join(
        copiedWorkspace,
        "sources/dlsite/src/index.ts",
      );
      const originalProvider = await readFile(providerFile, "utf8");
      const providerDisplayName = 'displayName: "DLsite",';
      expect(originalProvider).toContain(providerDisplayName);
      const updatedProvider = originalProvider.replace(
        providerDisplayName,
        'displayName: "DLsite 开发更新",',
      );
      const previousSourceGeneration = await inspectEnvironment({
        workspacePath: copiedWorkspace,
        environment,
      });
      expect(previousSourceGeneration.run.pid).not.toBeNull();
      const sourceUpdateStarted = performance.now();
      await writeFile(providerFile, updatedProvider);
      await waitForNewReady(
        copiedWorkspace,
        watcher,
        previousSourceGeneration.run.runId ?? undefined,
        () => watcherOutput,
      );
      await waitForProcessExit(previousSourceGeneration.run.pid!);
      sourceUpdateMilliseconds = performance.now() - sourceUpdateStarted;
      client = createPublicApiClient({ baseUrl });
      expect(await client.listSourceInputRequirements()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceIdentity: "dlsite",
            displayName: "DLsite 开发更新",
          }),
        ]),
      );

      const failedSource = updatedApplication.replace(
        'const displayName = input.displayName.trim().replace("开发更新旧标记", "开发更新新标记");',
        "const displayName = input.displayName.trim().replace(;",
      );
      const currentRunId = (
        await inspectEnvironment({
          workspacePath: copiedWorkspace,
          environment,
        })
      ).run?.runId;
      await writeFile(sourceFile, failedSource);
      await waitForFailedUpdate(copiedWorkspace, watcher, () => watcherOutput);
      expect(watcher.exitCode).toBeNull();
      const failedInspection = await inspectEnvironment({
        workspacePath: copiedWorkspace,
        environment,
      });
      expect(failedInspection.development?.failure).toEqual(expect.any(String));
      expect(failedInspection.development?.failure?.length).toBeGreaterThan(0);
      const repairStarted = performance.now();
      await writeFile(sourceFile, updatedApplication);
      await waitForNewReady(
        copiedWorkspace,
        watcher,
        currentRunId ?? undefined,
        () => watcherOutput,
      );
      failedBuildRecoveryMilliseconds = performance.now() - repairStarted;
      client = createPublicApiClient({ baseUrl });
      expect((await client.listAssetLibraries()).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: retainedLibrary.id,
            displayName: "开发会话保留资料",
          }),
          expect.objectContaining({
            id: codeUpdatedLibrary.id,
            displayName: "开发更新新标记",
          }),
        ]),
      );

      const terminal =
        "stty cols 80 rows 24 -icanon -echo; terminalModeBefore=$(stty -g); " +
        `pnpm --filter @digital/service exec digital-tui --url ${shellQuote(baseUrl)}; ` +
        'terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; fi; echo TUI_EXITED';
      const terminalCommand = `{ sleep 0.6; printf q; } | script -qfec ${shellQuote(terminal)} /dev/null`;
      const terminalResult = await execFile("bash", ["-lc", terminalCommand], {
        cwd: copiedWorkspace,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLUMNS: "80",
          LINES: "24",
        },
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      expect(terminalResult.stdout).toContain("开发更新新标记");
      expect(terminalResult.stdout).toContain("TERMINAL_RESTORED");
      expect(terminalResult.stdout).toContain("TUI_EXITED");
      expect(terminalResult.stdout).not.toContain("turbo watch dev:serve");
      expect((await fetch(new URL("/api/ready", baseUrl))).status).toBe(200);

      const runningEnvironment = await inspectEnvironment({
        workspacePath: copiedWorkspace,
        environment,
      });
      expect(runningEnvironment.development?.update).toBe("ready");
      const turboLog = runningEnvironment.development?.logFile;
      const productLog = runningEnvironment.run?.productLogFile;
      expect(typeof turboLog).toBe("string");
      expect(typeof productLog).toBe("string");
      expect(turboLog).not.toBe(productLog);
      expect((await readFile(turboLog!, "utf8")).length).toBeGreaterThan(0);
      expect((await readFile(productLog!, "utf8")).length).toBeGreaterThan(0);

      const stopStarted = performance.now();
      await stopProcessGroup(watcher);
      const signalCleanupMilliseconds = performance.now() - stopStarted;
      const stoppedEnvironment = await inspectEnvironment({
        workspacePath: copiedWorkspace,
        environment,
      });
      expect(stoppedEnvironment.development?.state).toBe("ended");
      expect(stoppedEnvironment.run?.state).toBe("stopped");
      console.info(
        JSON.stringify({
          event: "development-session-timings",
          firstEntryMilliseconds,
          savedConfigurationReentryMilliseconds,
          developmentEntryMilliseconds,
          explicitRefreshMilliseconds,
          applicationUpdateMilliseconds,
          domainUpdateMilliseconds,
          sourceUpdateMilliseconds,
          failedBuildRecoveryMilliseconds,
          isolatedTestMilliseconds,
          inFlightScanBeforeUpdate: inFlightScanBeforeUpdate.status,
          inFlightScanAfterUpdate: inFlightScanAfterUpdate.status,
          inFlightScanCompletedAfterUpdate:
            completedInFlightScanAfterUpdate.status,
          previousApplicationRunId: previousApplicationGeneration.run.runId,
          previousApplicationPid: previousApplicationGeneration.run.pid,
          updatedApplicationRunId: updatedApplicationGeneration.run.runId,
          updatedApplicationPid: updatedApplicationGeneration.run.pid,
          previousApplicationPidExited: true,
          signalCleanupMilliseconds,
          turboLog,
          productLog,
          watcherStopped:
            watcher.exitCode !== null || watcher.signalCode !== null,
        }),
      );
      passed = true;
    } finally {
      for (const watcher of watcherProcesses) {
        if (watcher.exitCode !== null || watcher.signalCode !== null) continue;
        try {
          if (watcher.pid !== undefined && process.platform !== "win32")
            process.kill(-watcher.pid, "SIGTERM");
          else watcher.kill("SIGTERM");
        } catch {
          watcher.kill("SIGTERM");
        }
      }
      if (watcherProcesses.length > 0) {
        await Promise.all(
          watcherProcesses.map((watcher) =>
            waitForClose(watcher, 30_000).catch(() => undefined),
          ),
        );
      }
      const inspection = await inspectEnvironment({
        workspacePath: copiedWorkspace,
        environment,
      }).catch(() => undefined);
      if (
        inspection?.run !== null &&
        inspection?.run?.state !== "stopped" &&
        inspection?.run?.state !== undefined
      )
        await stopEnvironment({
          workspacePath: copiedWorkspace,
          environment,
          ...(inspection?.development?.sessionId === undefined
            ? {}
            : { developmentSession: inspection.development.sessionId }),
        });
      if (passed) await rm(temporaryRoot, { recursive: true, force: true });
      else
        console.error(
          `开发会话验收失败，保留隔离工作区供诊断：${temporaryRoot}`,
        );
    }
  },
  15 * 60_000,
);

async function runPnpm(
  cwd: string,
  arguments_: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFile("pnpm", arguments_, {
    cwd,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function availablePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    if (!environmentPortExclusions.has(address.port)) return address.port;
  }
}

async function waitForReady(
  baseUrl: string,
  watcher: ReturnType<typeof spawn>,
  readOutput: () => string,
): Promise<void> {
  await eventually(async () => {
    if (watcher.exitCode !== null || watcher.signalCode !== null)
      throw new Error(`preview:dev 提前退出：${readOutput().slice(-12_000)}`);
    const response = await fetch(new URL("/api/ready", baseUrl), {
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined);
    return response?.status === 200;
  }, readOutput);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`旧开发服务进程 ${String(pid)} 在期限内仍存活`);
}

async function waitForNewReady(
  workspacePath: string,
  watcher: ReturnType<typeof spawn>,
  previousRunId: string | undefined,
  readOutput: () => string,
): Promise<void> {
  await eventually(async () => {
    if (watcher.exitCode !== null || watcher.signalCode !== null)
      throw new Error(`preview:dev 提前退出：${readOutput().slice(-12_000)}`);
    const inspection = await inspectEnvironment({
      workspacePath,
      environment,
    });
    const run = inspection.run;
    if (
      inspection.development?.update !== "ready" ||
      run === undefined ||
      run === null ||
      run.runtime !== "development" ||
      run.runId === previousRunId ||
      run.address === null
    )
      return false;
    const response = await fetch(new URL("/api/ready", run.address)).catch(
      () => undefined,
    );
    return response?.status === 200;
  }, readOutput);
}

async function waitForFailedUpdate(
  workspacePath: string,
  watcher: ReturnType<typeof spawn>,
  readOutput: () => string,
): Promise<void> {
  await eventually(async () => {
    if (watcher.exitCode !== null || watcher.signalCode !== null)
      throw new Error(`preview:dev 提前退出：${readOutput().slice(-12_000)}`);
    const inspection = await inspectEnvironment({
      workspacePath,
      environment,
    });
    return inspection.development?.update === "failed";
  }, readOutput);
}

async function eventually(
  condition: () => Promise<boolean>,
  readOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (readOutput().includes('"state":"failed"'))
      throw new Error(`开发编译被报告失败：${readOutput().slice(-12_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待开发行为超时：${readOutput().slice(-12_000)}`);
}

async function waitForScan(
  client: ReturnType<typeof createPublicApiClient>,
  executionId: string,
): Promise<Awaited<ReturnType<typeof client.inspectAssetLibraryScan>>> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const scan = await client.inspectAssetLibraryScan(executionId);
    if (scan.status === "completed") return scan;
    if (scan.status === "failed")
      throw new Error(`显式目录扫描${scan.status}：${executionId}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`显式目录扫描等待超时：${executionId}`);
}

function lastJsonLine(output: string): Record<string, unknown> {
  for (const line of output.split("\n").toReversed()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null)
        return parsed as Record<string, unknown>;
    } catch {
      // environment CLI 前面的 pnpm 命令行不是结果对象。
    }
  }
  throw new Error(`environment CLI 没有交出结构化结果：${output}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitForClose(
  child: ReturnType<typeof spawn>,
  timeoutMilliseconds: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("开发会话测试进程未在期限内结束")),
      timeoutMilliseconds,
    );
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function stopProcessGroup(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else child.kill("SIGTERM");
  await waitForClose(child, 30_000);
}
