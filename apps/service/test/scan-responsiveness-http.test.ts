import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createPublicApiClient } from "@digital/public-api";
import { afterEach, expect, it } from "vitest";

const fixtureDirectory = path.dirname(
  fileURLToPath(
    import.meta
      .resolve("@digital/preview-corpus/publication-screen/manifest.json"),
  ),
);
const active: Array<{
  readonly root: string;
  service?: ReturnType<typeof spawn>;
}> = [];

afterEach(async () => {
  const waitForExit = async (
    service: ReturnType<typeof spawn>,
    timeoutMs: number,
  ): Promise<boolean> => {
    if (service.exitCode !== null || service.signalCode !== null) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        service.off("exit", onExit);
        resolve(exited);
      };
      const onExit = () => settle(true);
      const timeout = setTimeout(() => settle(false), timeoutMs);
      service.once("exit", onExit);
      if (service.exitCode !== null || service.signalCode !== null)
        settle(true);
    });
  };

  for (const item of active.splice(0).reverse()) {
    const service = item.service;
    let exited = service === undefined;
    if (service !== undefined) {
      if (service.exitCode !== null || service.signalCode !== null)
        exited = true;
      else {
        service.stdin?.write("stop\n");
        exited = await waitForExit(service, 10_000);
        if (!exited) {
          service.kill("SIGTERM");
          exited = await waitForExit(service, 5_000);
        }
      }
    }
    if (!exited) {
      throw new Error(
        `受控服务未确认退出；保留其数据目录以避免删除仍在使用的数据：${item.root}`,
      );
    }
    if (service !== undefined)
      process.stdout.write(
        `EW07 子服务已退出：pid=${String(service.pid)}，exitCode=${String(service.exitCode)}，signalCode=${String(service.signalCode)}\n`,
      );
    await rm(item.root, { recursive: true, force: true });
  }
}, 20_000);

it("扫描进度查询可在 51 项首次及增量扫描中完成", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc07-scan-ready-"));
  const evidencePath =
    process.env["EW07_SCAN_RESULT_PATH"] ?? path.join(root, "scan-result.json");
  const activeService: { root: string; service?: ReturnType<typeof spawn> } = {
    root,
  };
  active.push(activeService);
  const productDataDirectory = path.join(root, "product-data");
  const materialRoot = path.join(root, "materials");
  const mediaRoot = path.join(fixtureDirectory, "material", "anime");
  const bloomTitle = "终将成为你 (2018)";
  const frierenTitle = "葬送的芙莉莲 (2023)";
  const episodeCounts = [
    { title: bloomTitle, season: 1, count: 13 },
    { title: frierenTitle, season: 1, count: 28 },
    { title: frierenTitle, season: 2, count: 10 },
  ] as const;
  const samplePaths = [
    path.join(mediaRoot, bloomTitle, "Season 1", "终将成为你 - S01E01.mp4"),
    path.join(mediaRoot, frierenTitle, "Season 1", "葬送的芙莉莲 - S01E01.mp4"),
    path.join(
      mediaRoot,
      frierenTitle,
      "Season 2",
      "葬送的芙莉莲 - S02E01 - 第 1 集.mp4",
    ),
  ];
  const copiedMaterials: string[] = [];
  for (const [index, specification] of episodeCounts.entries()) {
    const seasonRoot = path.join(
      materialRoot,
      specification.title,
      `Season ${String(specification.season)}`,
    );
    await mkdir(seasonRoot, { recursive: true });
    for (let episode = 1; episode <= specification.count; episode += 1) {
      const season = String(specification.season).padStart(2, "0");
      const number = String(episode).padStart(2, "0");
      const suffix =
        specification.season === 2 ? ` - 第 ${String(episode)} 集` : "";
      const filename = `${specification.title.slice(0, specification.title.lastIndexOf(" ("))} - S${season}E${number}${suffix}.mp4`;
      const destination = path.join(seasonRoot, filename);
      await copyFile(samplePaths[index]!, destination);
      copiedMaterials.push(destination);
    }
  }
  expect(copiedMaterials).toHaveLength(51);

  const serviceScript = fileURLToPath(
    new URL("./helpers/scan-responsiveness-service.ts", import.meta.url),
  );
  const service = spawn(
    process.execPath,
    ["--conditions=digital-source", serviceScript],
    {
      cwd: path.resolve("../.."),
      env: {
        ...process.env,
        EW07_SCAN_PRODUCT_DATA: productDataDirectory,
        EW07_SCAN_FIXTURE_DIRECTORY: fixtureDirectory,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  activeService.service = service;
  const serviceOutput: string[] = [];
  let stdoutBuffer = "";
  let resolveAddress: ((value: URL) => void) | undefined;
  let rejectAddress: ((reason: Error) => void) | undefined;
  const addressPromise = new Promise<URL>((resolve, reject) => {
    resolveAddress = resolve;
    rejectAddress = reject;
  });
  service.stdout.setEncoding("utf8");
  service.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      serviceOutput.push(line);
      const message = JSON.parse(line) as {
        readonly kind: string;
        readonly address?: string;
      };
      if (message.kind === "ready" && message.address !== undefined)
        resolveAddress?.(new URL(message.address));
    }
  });
  service.stderr.setEncoding("utf8");
  service.stderr.on("data", (chunk: string) =>
    serviceOutput.push(`stderr: ${chunk}`),
  );
  service.once("error", (error) => rejectAddress?.(error));
  service.once("exit", (code) => {
    if (resolveAddress !== undefined)
      rejectAddress?.(
        new Error(`受控服务在 readiness 前退出 (${String(code)})`),
      );
  });
  const baseUrl = await addressPromise;
  const overallDeadline = AbortSignal.timeout(180_000);
  const client = createPublicApiClient({
    baseUrl,
    fetch: (input, init) => {
      const requestSignal = init?.signal;
      return fetch(input, {
        ...init,
        signal:
          requestSignal === undefined || requestSignal === null
            ? overallDeadline
            : AbortSignal.any([requestSignal, overallDeadline]),
      });
    },
  });
  const callbackUrl = new URL(
    "/api/v1/source-connections/bangumi/callback",
    baseUrl,
  );
  await client.configureBangumiOAuthClient({
    clientId: "scan-readiness-controlled-client",
    clientSecret: "scan-readiness-controlled-secret",
    redirectUri: callbackUrl.toString(),
  });
  const authorization = await client.beginBangumiAuthorization();
  const state = new URL(authorization.authorizationUrl).searchParams.get(
    "state",
  );
  assert(state !== null);
  callbackUrl.searchParams.set("code", "scan-readiness-code");
  callbackUrl.searchParams.set("state", state);
  expect((await fetch(callbackUrl, { signal: overallDeadline })).status).toBe(
    200,
  );
  const library = await client.saveAssetLibrary({
    displayName: "扫描 readiness 回归库",
    directories: [materialRoot],
    recognitionProfileIds: ["anime"],
    sourceIdentities: ["bangumi"],
  });

  const readiness: Array<{
    readonly phase: "initial" | "incremental";
    readonly durationMs: number;
    readonly status?: number;
    readonly error?: string;
  }> = [];
  const readinessAbort = new AbortController();
  let readinessPhase: "initial" | "incremental" = "initial";
  const scanSummaries: Array<{
    readonly parentExecutionId: string;
    readonly status: string;
    readonly outcome?: string;
    readonly fileCount: number;
    readonly acceptedCount: number;
    readonly noChangeCount: number;
    readonly assetIds: readonly string[];
  }> = [];
  let currentAssetIdsAfterIncremental: readonly string[] | undefined;
  const inspectionAttempts: Array<{
    readonly phase: "initial" | "incremental";
    readonly parentExecutionId: string;
    readonly durationMs: number;
    readonly status?: string;
    readonly outcome?: string;
    readonly error?: string;
  }> = [];
  const persistEvidence = async () => {
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          testBaseCommit: "2f6b6b4eee640fc54808e2513e36f60b6be56863",
          evidencePath,
          scans: scanSummaries,
          currentAssetIdsAfterIncremental,
          naturalTransportFailures: inspectionAttempts.filter(
            (attempt) => attempt.error !== undefined,
          ),
          runningProgressObserved: inspectionAttempts.some(
            (attempt) => attempt.status === "running",
          ),
          maxReadinessDurationMs:
            readiness.length === 0
              ? undefined
              : Math.max(...readiness.map((sample) => sample.durationMs)),
          readiness,
          inspectionAttempts,
        },
        null,
        2,
      )}\n`,
    );
  };
  const inspectUntilTerminal = async (
    phase: "initial" | "incremental",
    parentExecutionId: string,
  ): Promise<Awaited<ReturnType<typeof client.inspectAssetLibraryScan>>> => {
    let latest:
      | Awaited<ReturnType<typeof client.inspectAssetLibraryScan>>
      | undefined;
    while (!overallDeadline.aborted) {
      const inspectionStarted = performance.now();
      const inspectionResult = await client
        .inspectAssetLibraryScan(parentExecutionId)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      const attempt =
        "value" in inspectionResult
          ? {
              phase,
              parentExecutionId,
              durationMs: performance.now() - inspectionStarted,
              status: inspectionResult.value.status,
              ...(inspectionResult.value.outcome === undefined
                ? {}
                : { outcome: inspectionResult.value.outcome }),
            }
          : {
              phase,
              parentExecutionId,
              durationMs: performance.now() - inspectionStarted,
              error:
                inspectionResult.error instanceof Error
                  ? `${inspectionResult.error.name}: ${inspectionResult.error.message}${
                      inspectionResult.error.cause instanceof Error
                        ? ` (cause ${inspectionResult.error.cause.name}: ${inspectionResult.error.cause.message})`
                        : ""
                    }`
                  : String(inspectionResult.error),
            };
      inspectionAttempts.push(attempt);
      if ("value" in inspectionResult) {
        latest = inspectionResult.value;
        if (latest.status !== "running") {
          const files = latest.directories.flatMap(
            (directory) => directory.files,
          );
          const summary = {
            parentExecutionId,
            status: latest.status,
            ...(latest.outcome === undefined
              ? {}
              : { outcome: latest.outcome }),
            fileCount: files.length,
            acceptedCount: files.filter((file) => file.outcome === "accepted")
              .length,
            noChangeCount: files.filter((file) => file.outcome === "no-change")
              .length,
            assetIds: files
              .flatMap((file) =>
                file.assetId === undefined ? [] : [file.assetId],
              )
              .toSorted(),
          };
          const existingIndex = scanSummaries.findIndex(
            (item) => item.parentExecutionId === parentExecutionId,
          );
          if (existingIndex === -1) scanSummaries.push(summary);
          else scanSummaries[existingIndex] = summary;
          await persistEvidence();
          return latest;
        }
      } else await persistEvidence();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await persistEvidence();
    if (latest !== undefined) return latest;
    throw new Error(`扫描 ${parentExecutionId} 未能在整体截止前读到结果`);
  };

  const readinessMonitor = (async () => {
    while (!overallDeadline.aborted && !readinessAbort.signal.aborted) {
      const startedAt = performance.now();
      try {
        const response = await fetch(new URL("/api/ready", baseUrl), {
          signal: AbortSignal.any([overallDeadline, readinessAbort.signal]),
        });
        readiness.push({
          phase: readinessPhase,
          durationMs: performance.now() - startedAt,
          status: response.status,
        });
      } catch (error) {
        readiness.push({
          phase: readinessPhase,
          durationMs: performance.now() - startedAt,
          error:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
        });
        if (overallDeadline.aborted || readinessAbort.signal.aborted) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();

  process.stdout.write(`EW07 扫描诊断证据：${evidencePath}\n`);
  try {
    const started = await client.startAssetLibraryScan(library.id);
    const initial = await inspectUntilTerminal(
      "initial",
      started.parentExecutionId,
    );
    const initialFiles = initial.directories.flatMap(
      (directory) => directory.files,
    );
    const initialAssetIds = initialFiles.flatMap((file) =>
      file.assetId === undefined ? [] : [file.assetId],
    );
    expect(initial.parentExecutionId).toBe(started.parentExecutionId);
    expect(initial).toMatchObject({ status: "completed", outcome: "accepted" });
    expect(initialFiles).toHaveLength(51);
    expect(initialFiles.every((file) => file.outcome === "accepted")).toBe(
      true,
    );
    expect(new Set(initialAssetIds).size).toBe(51);

    readinessPhase = "incremental";
    const incrementalStarted = await client.startAssetLibraryScan(library.id);
    const incremental = await inspectUntilTerminal(
      "incremental",
      incrementalStarted.parentExecutionId,
    );
    const incrementalFiles = incremental.directories.flatMap(
      (directory) => directory.files,
    );
    expect(incremental.parentExecutionId).toBe(
      incrementalStarted.parentExecutionId,
    );
    expect(incremental).toMatchObject({
      status: "completed",
      outcome: "no-change",
    });
    expect(incrementalFiles).toHaveLength(51);
    expect(incrementalFiles.every((file) => file.outcome === "no-change")).toBe(
      true,
    );
    const currentAssets = await client.listAssets({
      assetLibraryId: library.id,
      limit: 100,
    });
    currentAssetIdsAfterIncremental = currentAssets.items
      .map((asset) => asset.id)
      .toSorted();
    await persistEvidence();
    expect(currentAssetIdsAfterIncremental).toHaveLength(51);
    expect(currentAssetIdsAfterIncremental).toEqual(initialAssetIds.toSorted());

    expect(
      inspectionAttempts.every((attempt) => attempt.error === undefined),
    ).toBe(true);
    expect(
      inspectionAttempts.some((attempt) => attempt.status === "running"),
    ).toBe(true);
    expect(readiness.length).toBeGreaterThan(0);
    expect(serviceOutput.join("\n")).not.toContain("Error:");
  } finally {
    readinessAbort.abort();
    await readinessMonitor;
    await persistEvidence();
  }
}, 200_000);
