import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it } from "vitest";

const servers: ReturnType<typeof createServer>[] = [];
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  for (const child of children.splice(0).reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else child.kill("SIGTERM");
    }
  }
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("运行安装入口、处理分页键，并在窄终端退出时恢复输入状态", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push(`${url.pathname}${url.search}`);
    servePublicPage(url, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const terminalCommand = `stty cols 34 rows 10 -icanon -echo; terminalModeBefore=$(stty -g); (sleep 5; stty cols 46 rows 14 < /dev/tty) & ./dist/cli.js --url http://127.0.0.1:${address.port}; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const keyInput =
    "{ sleep 0.5; printf n; sleep 0.6; printf p; sleep 0.6; printf '/'; sleep 0.4; printf '本地资料库x'; sleep 0.8; printf '\\177'; sleep 0.5; printf '\\r'; sleep 0.5; printf '\\r'; sleep 0.5; printf n; for _ in {1..8}; do sleep 0.1; printf j; done; sleep 0.8; printf p; sleep 0.4; printf 3; sleep 0.4; printf q; }";
  const command = `set -o pipefail; ${keyInput} | script -qfec ${shellQuote(terminalCommand)} /dev/null`;
  const child = spawn("bash", ["-lc", command], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: "34", LINES: "10" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.push(child);
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
    setTimeout(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, 10_000).unref();
  });
  const terminalOutput = Buffer.concat(output).toString("utf8");
  const errorOutput = Buffer.concat(errors).toString("utf8");

  expect(exitCode, `${errorOutput}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain("数字资料库");
  expect(terminalOutput).toContain("本地资料库");
  expect(terminalOutput).toContain("第二页资料库");
  expect(terminalOutput).toContain("筛选本页：本地资料库x");
  expect(terminalOutput).toContain("当前页没有匹配内容");
  expect(terminalOutput).toContain("筛选本页：本地资料库（1/1）");
  expect(terminalOutput).toContain("第一页资产");
  expect(terminalOutput).toContain("第二页资产");
  expect(terminalOutput).toContain("未识别材料");
  expect(terminalOutput).toContain("未识别样本.pdf");
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(terminalOutput).toContain("↑↓移动 r重读 q退出 /筛选");
  expect(terminalOutput).toContain("p上一页");
  expect(terminalOutput).toContain("第 1-3/20 项");
  expect(terminalOutput).toContain("第 3-9/20 项");
  expect(terminalOutput).not.toContain("asset-id-");
  expect(requests).toContain("/api/v1/asset-libraries?limit=20");
  expect(requests).toContain(
    "/api/v1/asset-libraries?limit=20&cursor=library-page-2",
  );
  expect(requests).toContain(
    "/api/v1/assets?assetLibraryId=library-1&limit=20&cursor=page-2",
  );
  expect(
    requests.filter(
      (request) =>
        request === "/api/v1/assets?assetLibraryId=library-1&limit=20",
    ).length,
  ).toBeGreaterThan(1);
  expect(requests).toContain(
    "/api/v1/unrecognized-materials?assetLibraryId=library-1&limit=20",
  );
}, 15_000);

it("安装入口可补充来源、检查失败依据并重试", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let sourceEnrichmentInspections = 0;
  const technicalFailureReason =
    "DLsite official source request failed: 受控来源拒绝：边界 ordinary-request 没有匹配条目（请求键 GET https://www.dlsite.com/maniax/product/info/ajax）";
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body =
        chunks.length === 0
          ? undefined
          : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      const url = new URL(request.url ?? "/", "http://localhost");
      requests.push({
        method: request.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        ...(body === undefined ? {} : { body }),
      });

      if (url.pathname === "/api/v1/asset-libraries")
        return json(response, {
          items: [
            {
              id: "library-1",
              displayName: "来源补充库",
              configVersion: 1,
              directories: [],
              recognitionProfileIds: [],
              sourceIdentities: ["nbinet"],
            },
          ],
        });
      if (url.pathname === "/api/v1/assets")
        return json(response, { items: [asset("待补来源的作品", 0)] });
      if (url.pathname === "/api/v1/assets/asset-id-0/inspection")
        return json(response, {
          assetId: "asset-id-0",
          entity: { id: "asset-id-0", kind: "digital-asset" },
          sections: [
            { kind: "source-records", count: 0, status: "missing" },
            { kind: "current-values", count: 1, status: "available" },
          ],
        });
      if (url.pathname === "/api/v1/source-input-requirements")
        return json(response, [
          {
            sourceIdentity: "nbinet",
            displayName: "國家圖書館",
            fields: [
              {
                key: "isbn",
                label: "ISBN",
                required: true,
                acceptedInput: "ISBN-13",
                example: "9789864738281",
              },
            ],
          },
        ]);
      if (
        request.method === "POST" &&
        url.pathname === "/api/v1/source-enrichments"
      )
        return json(response, { executionId: "enrichment-1" }, 202);
      if (
        request.method === "GET" &&
        url.pathname === "/api/v1/source-enrichments/enrichment-1"
      ) {
        sourceEnrichmentInspections += 1;
        if (sourceEnrichmentInspections === 1)
          return json(response, {
            executionId: "enrichment-1",
            status: "running",
            outcome: "running",
            items: [],
            sourceAssociations: [],
          });
        return json(response, {
          executionId: "enrichment-1",
          status: "failed",
          outcome: "failed",
          reason: "受控来源当前没有可用资料",
          items: [
            {
              subjectId: "asset-id-0",
              sourceIdentity: "nbinet",
              sourceAddress: "https://data.ncl.edu.tw/isbn/9789864738281",
              input: { isbn: "9789864738281" },
              status: "failed",
              reason: technicalFailureReason,
              canRetry: true,
            },
          ],
          sourceAssociations: [],
        });
      }
      if (
        url.pathname === "/api/v1/assets/asset-id-0/source-enrichment-retries"
      )
        return json(response, [
          {
            executionId: "enrichment-1",
            subjectId: "asset-id-0",
            sourceIdentity: "nbinet",
            canRetry: true,
          },
        ]);
      if (
        request.method === "POST" &&
        url.pathname === "/api/v1/source-enrichment-retries"
      )
        return json(response, { executionId: "enrichment-2" }, 202);
      if (
        request.method === "GET" &&
        url.pathname === "/api/v1/source-enrichments/enrichment-2"
      )
        return json(response, {
          executionId: "enrichment-2",
          status: "completed",
          outcome: "accepted",
          items: [
            {
              subjectId: "asset-id-0",
              sourceIdentity: "nbinet",
              sourceAddress: "https://data.ncl.edu.tw/isbn/9789864738281",
              input: { isbn: "9789864738281" },
              status: "completed",
              canRetry: false,
            },
          ],
          sourceAssociations: [
            {
              sourceIdentity: "nbinet",
              nativeAddress: "https://data.ncl.edu.tw/isbn/9789864738281",
            },
          ],
        });
      return json(
        response,
        { error: { code: "not-found", message: "没有此页面" } },
        404,
      );
    })().catch((cause: unknown) => {
      json(
        response,
        {
          error: {
            code: "internal",
            message: cause instanceof Error ? cause.message : "响应失败",
          },
        },
        500,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const terminalCommand = `stty cols 54 rows 16 -icanon -echo; terminalModeBefore=$(stty -g); ./dist/cli.js --url http://127.0.0.1:${address.port}; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const keyInput =
    "{ sleep 0.5; printf '\\r'; sleep 0.6; printf i; sleep 0.6; printf e; sleep 0.8; printf '9789864738281'; sleep 0.3; printf '\\r'; sleep 1.0; printf r; sleep 1.3; printf '\\033'; sleep 0.3; printf q; }";
  const command = `set -o pipefail; ${keyInput} | script -qfec ${shellQuote(terminalCommand)} /dev/null`;
  const child = spawn("bash", ["-lc", command], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: "54", LINES: "16" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.push(child);
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
    setTimeout(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, 10_000).unref();
  });
  const terminalOutput = Buffer.concat(output).toString("utf8");
  const errorOutput = Buffer.concat(errors).toString("utf8");

  expect(exitCode, `${errorOutput}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain("来源补充");
  expect(terminalOutput).toContain("正在补充来源，请稍候");
  expect(terminalOutput).not.toContain("enrichment-1");
  expect(terminalOutput).toContain("nbinet");
  expect(terminalOutput).toContain("isbn 9789864738281");
  expect(terminalOutput).toContain("nbinet · isbn 9789864738281 · 未完成");
  expect(terminalOutput).toContain("来源补充 · 未完成");
  expect(terminalOutput).toContain("可按 r 再次获取当前失败项");
  expect(terminalOutput).not.toContain("DLsite official source request failed");
  expect(terminalOutput).not.toContain("ordinary-request");
  expect(terminalOutput).not.toContain(
    "https://www.dlsite.com/maniax/product/info/ajax",
  );
  expect(terminalOutput).toContain("受控来源当前没有可用资料");
  expect(terminalOutput).toContain("已关联：nbinet");
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(requests).toContainEqual({
    method: "POST",
    path: "/api/v1/source-enrichments",
    body: {
      subjectId: "asset-id-0",
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "9789864738281" },
    },
  });
  expect(requests).toContainEqual({
    method: "POST",
    path: "/api/v1/source-enrichment-retries",
    body: {
      executionId: "enrichment-1",
      subjectId: "asset-id-0",
      sourceIdentity: "nbinet",
    },
  });
}, 15_000);

it("安装入口可检查待处理变更的影响并明确确认", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let confirmed = false;
  const preview = (status: "awaiting-confirmation" | "applied") => ({
    previewId: "preview-1",
    executionId: "execution-1",
    assetId: "asset-1",
    status,
    current: {
      recognitionState: "recognized",
      recognitionDecisionId: "decision-1",
      sourceAssociations: [
        { sourceIdentity: "tmdb", nativeAddress: "https://movie/1" },
      ],
    },
    projected: {
      recognitionState: "unresolved",
      sourceAssociations: [],
    },
    evidenceConflicts: ["撤回后该内容等待重新识别"],
    blockingConditions: [],
  });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body =
        chunks.length === 0
          ? undefined
          : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      const url = new URL(request.url ?? "/", "http://localhost");
      requests.push({
        method: request.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        ...(body === undefined ? {} : { body }),
      });
      if (url.pathname === "/api/v1/asset-libraries")
        return json(response, { items: [] });
      if (url.pathname === "/api/v1/attention")
        return json(response, {
          items: confirmed
            ? []
            : [
                {
                  id: "review-1",
                  kind: "change-impact-review",
                  executionId: "execution-1",
                  assetId: "asset-1",
                  summary: "撤回来源识别后需要检查影响",
                  changeImpactPreviewId: "preview-1",
                },
              ],
        });
      if (
        request.method === "GET" &&
        url.pathname === "/api/v1/change-impact-previews/preview-1"
      )
        return json(response, preview("awaiting-confirmation"));
      if (
        request.method === "POST" &&
        url.pathname === "/api/v1/change-impact-previews/preview-1/confirm"
      ) {
        confirmed = true;
        return json(response, preview("applied"));
      }
      return json(
        response,
        { error: { code: "not-found", message: "没有此页面" } },
        404,
      );
    })().catch((cause: unknown) => {
      json(
        response,
        {
          error: {
            code: "internal",
            message: cause instanceof Error ? cause.message : "响应失败",
          },
        },
        500,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const terminalCommand = `stty cols 64 rows 16 -icanon -echo; terminalModeBefore=$(stty -g); ./dist/cli.js --url http://127.0.0.1:${address.port}; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const keyInput =
    "{ sleep 0.5; printf 5; sleep 0.7; printf v; sleep 0.7; printf a; sleep 0.8; printf '\\033'; sleep 0.3; printf q; }";
  const command = `set -o pipefail; ${keyInput} | script -qfec ${shellQuote(terminalCommand)} /dev/null`;
  const child = spawn("bash", ["-lc", command], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: "64", LINES: "16" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.push(child);
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
    setTimeout(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, 10_000).unref();
  });
  const terminalOutput = Buffer.concat(output).toString("utf8");
  const errorOutput = Buffer.concat(errors).toString("utf8");

  expect(exitCode, `${errorOutput}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain("变更影响");
  expect(terminalOutput).toContain("已识别 → 待识别");
  expect(terminalOutput).toContain("撤回后该内容等待重新识别");
  expect(terminalOutput).toContain("变更已确认");
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(confirmed).toBe(true);
  expect(requests).toContainEqual({
    method: "POST",
    path: "/api/v1/change-impact-previews/preview-1/confirm",
    body: { confirmedBy: "tui-user" },
  });
}, 15_000);

it("显示服务端读取错误并可重新读取", async () => {
  let libraryRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/asset-libraries") {
      libraryRequests += 1;
      if (libraryRequests === 1)
        return json(
          response,
          {
            error: {
              code: "unavailable",
              message: "资产库暂时不可用",
            },
          },
          503,
        );
      return json(response, {
        items: [
          {
            id: "library-1",
            displayName: "恢复后的资料库",
            configVersion: 1,
            directories: [],
            recognitionProfileIds: [],
            sourceIdentities: [],
          },
        ],
      });
    }
    return json(
      response,
      { error: { code: "not-found", message: "没有此页面" } },
      404,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const terminalCommand = `stty cols 48 rows 12 -icanon -echo; terminalModeBefore=$(stty -g); ./dist/cli.js --url http://127.0.0.1:${address.port}; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const keyInput = "{ sleep 0.6; printf r; sleep 0.6; printf q; }";
  const command = `set -o pipefail; ${keyInput} | script -qfec ${shellQuote(terminalCommand)} /dev/null`;
  const child = spawn("bash", ["-lc", command], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: "48", LINES: "12" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.push(child);
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
    setTimeout(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, 10_000).unref();
  });
  const terminalOutput = Buffer.concat(output).toString("utf8");
  const errorOutput = Buffer.concat(errors).toString("utf8");

  expect(exitCode, `${errorOutput}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain("资产库暂时不可用");
  expect(terminalOutput).toContain(
    `${String.fromCharCode(27)}[31m资产库暂时不可用`,
  );
  expect(terminalOutput).toContain("恢复后的资料库");
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(libraryRequests).toBe(2);
}, 15_000);

it("安装入口可跟踪三种操作、请求取消并展示同一执行的最终来源结果", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let rescrapeCancelRequested = false;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body =
        chunks.length === 0
          ? undefined
          : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      const url = new URL(request.url ?? "/", "http://localhost");
      requests.push({
        method: request.method ?? "GET",
        path: url.pathname,
        ...(body === undefined ? {} : { body }),
      });

      if (url.pathname === "/api/v1/asset-libraries")
        return json(response, {
          items: [
            {
              id: "library-1",
              displayName: "执行流程资料库",
              configVersion: 1,
              directories: [],
              recognitionProfileIds: [],
              sourceIdentities: [],
            },
          ],
        });
      if (url.pathname === "/api/v1/assets")
        return json(response, { items: [asset("受控作品", 1)] });
      if (request.method === "POST" && url.pathname.endsWith("/scans"))
        return json(response, { parentExecutionId: "execution-scan" }, 202);
      if (request.method === "POST" && url.pathname === "/api/v1/refreshes") {
        const operation = (body as { operation: string }).operation;
        return json(
          response,
          {
            id:
              operation === "rescrape"
                ? "execution-rescrape"
                : "execution-metadata",
          },
          202,
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/v1/executions/execution-rescrape/cancel"
      ) {
        rescrapeCancelRequested = true;
        return json(response, {
          requestStatus: "requested",
          inspection: execution("execution-rescrape", {
            operationKind: "rescrape",
            status: "running",
            cancellation: {
              requestedBy: "public-api",
              requestedAt: "2026-10-16T00:00:00.000Z",
            },
          }),
        });
      }
      if (url.pathname === "/api/v1/executions/execution-scan")
        return json(response, {
          kind: "asset-library-scan",
          id: "execution-scan",
          status: "completed",
          outcome: "no-change",
          children: [],
        });
      if (url.pathname === "/api/v1/asset-library-scans/execution-scan")
        return json(response, {
          parentExecutionId: "execution-scan",
          assetLibraryId: "library-1",
          configVersion: 1,
          status: "completed",
          outcome: "no-change",
          directories: [],
        });
      if (url.pathname === "/api/v1/executions/execution-rescrape")
        return json(
          response,
          rescrapeCancelRequested
            ? execution("execution-rescrape", {
                operationKind: "rescrape",
                status: "failed",
                outcome: "cancelled",
                cancellation: {
                  requestedBy: "public-api",
                  requestedAt: "2026-10-16T00:00:00.000Z",
                },
              })
            : execution("execution-rescrape", {
                operationKind: "rescrape",
                status: "running",
                stage: "recognition",
              }),
        );
      if (url.pathname === "/api/v1/executions/execution-metadata")
        return json(
          response,
          execution("execution-metadata", {
            operationKind: "refresh-metadata",
            status: "completed",
            outcome: "accepted",
            sourceRefreshRuns: [sourceRefreshRun()],
          }),
        );
      return json(
        response,
        { error: { code: "not-found", message: "没有此页面" } },
        404,
      );
    })().catch((error: unknown) => {
      if (!response.destroyed) response.destroy(error as Error);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const terminalCommand = `stty cols 58 rows 16 -icanon -echo; terminalModeBefore=$(stty -g); ./dist/cli.js --url http://127.0.0.1:${address.port}; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const keyInput =
    "{ sleep 0.6; printf s; sleep 0.8; printf l; sleep 0.4; printf 2; sleep 0.7; printf x; sleep 0.8; printf c; sleep 1.2; printf l; sleep 0.4; printf 2; sleep 0.7; printf m; sleep 1.2; printf q; }";
  const command = `set -o pipefail; ${keyInput} | script -qfec ${shellQuote(terminalCommand)} /dev/null`;
  const child = spawn("bash", ["-lc", command], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: "58", LINES: "16" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.push(child);
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
    setTimeout(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, 12_000).unref();
  });
  const terminalOutput = Buffer.concat(output).toString("utf8");
  const errorOutput = Buffer.concat(errors).toString("utf8");

  expect(exitCode, `${errorOutput}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain("execution-scan");
  expect(terminalOutput).toContain("execution-rescrape");
  expect(terminalOutput).toContain("execution-metadata");
  expect(terminalOutput).toContain("取消请求已提交");
  expect(terminalOutput).toContain("刷新已取消");
  expect(terminalOutput).toContain("刷新已完成：已识别");
  expect(terminalOutput).not.toContain("accepted");
  expect(terminalOutput).not.toContain("状态：失败 /");
  expect(terminalOutput).toContain("change-set-1");
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(
    requests
      .filter(
        ({ method, path }) => method === "POST" && path === "/api/v1/refreshes",
      )
      .map(({ body }) => body),
  ).toEqual([
    { operation: "rescrape", subjectId: "asset-id-1" },
    { operation: "metadata-refresh", subjectId: "asset-id-1" },
  ]);
  expect(
    requests.filter(
      ({ method, path }) =>
        method === "POST" &&
        path === "/api/v1/executions/execution-rescrape/cancel",
    ),
  ).toHaveLength(1);
  expect(
    requests.filter(
      ({ method, path }) =>
        method === "POST" && path === "/api/v1/asset-libraries/library-1/scans",
    ),
  ).toHaveLength(1);
}, 15_000);

it("读取连接中断后保留原执行身份并自动恢复查询，不重提刷新", async () => {
  let executionReads = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/executions/execution-resume") {
      executionReads += 1;
      if (executionReads === 1) {
        response.socket?.resetAndDestroy();
        return;
      }
      return json(
        response,
        execution("execution-resume", {
          operationKind: "refresh-metadata",
          status: "completed",
          outcome: "accepted",
          sourceRefreshRuns: [sourceRefreshRun()],
        }),
      );
    }
    return json(
      response,
      { error: { code: "not-found", message: "没有此页面" } },
      404,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const terminalCommand = `stty cols 58 rows 16 -icanon -echo; terminalModeBefore=$(stty -g); ./dist/cli.js --url http://127.0.0.1:${address.port} --execution execution-resume; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const keyInput = "{ sleep 3.5; printf q; }";
  const command = `set -o pipefail; ${keyInput} | script -qfec ${shellQuote(terminalCommand)} /dev/null`;
  const child = spawn("bash", ["-lc", command], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: "58", LINES: "16" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.push(child);
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
    setTimeout(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, 9_000).unref();
  });
  const terminalOutput = Buffer.concat(output).toString("utf8");
  const errorOutput = Buffer.concat(errors).toString("utf8");

  expect(exitCode, `${errorOutput}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain("execution-resume");
  expect(terminalOutput).toContain("执行结局仍未知");
  expect(terminalOutput).toContain("change-set-1");
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(executionReads).toBeGreaterThanOrEqual(2);
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function servePublicPage(
  url: URL,
  response: ServerResponse<IncomingMessage>,
): void {
  if (url.pathname === "/api/v1/asset-libraries")
    return json(
      response,
      url.searchParams.get("cursor") === "library-page-2"
        ? {
            items: [
              {
                id: "library-2",
                displayName: "第二页资料库",
                configVersion: 1,
                directories: [
                  {
                    id: "root-2",
                    displayName: "书架二",
                    path: "/ordinary/library-2",
                    status: "active",
                    reachable: true,
                  },
                ],
                recognitionProfileIds: [],
                sourceIdentities: [],
              },
            ],
          }
        : {
            items: [
              {
                id: "library-1",
                displayName: "本地资料库",
                configVersion: 1,
                directories: [
                  {
                    id: "root-1",
                    displayName: "书架",
                    path: "/ordinary/library-1",
                    status: "active",
                    reachable: true,
                  },
                ],
                recognitionProfileIds: [],
                sourceIdentities: [],
              },
            ],
            nextCursor: "library-page-2",
          },
    );
  if (url.pathname === "/api/v1/assets") {
    const next = url.searchParams.get("cursor") === "page-2";
    return json(response, {
      items: next
        ? Array.from({ length: 20 }, (_, index) =>
            asset(`第二页资产${String(index + 1).padStart(2, "0")}`, index),
          )
        : [asset("第一页资产", 0)],
      ...(!next ? { nextCursor: "page-2" } : {}),
    });
  }
  if (url.pathname === "/api/v1/unrecognized-materials")
    return json(response, {
      items: [
        {
          kind: "work-item",
          parentExecutionId: "parent-1",
          directoryKey: "书架",
          childExecutionId: "child-1",
          workItemKey: "item-1",
          observedRootId: "root-1",
          relativeScope: ".",
          relativePaths: ["未识别样本.pdf"],
        },
      ],
    });
  return json(
    response,
    { error: { code: "not-found", message: "没有此页面" } },
    404,
  );
}

function asset(title: string, index: number) {
  const id = `asset-id-${index}`;
  return {
    id,
    sourceAssociations: [],
    descriptions: [
      {
        target: { kind: "entity", entityId: id },
        metadataUsageContext: "public",
        metadata: [
          {
            property: "asset.title",
            result: {
              status: "resolved",
              values: [
                {
                  value: title,
                  sourceIdentity: "fixture",
                  sourceSlot: "asset.title",
                  sourceRecordIds: [],
                  reasoning: {},
                  assertions: [],
                },
              ],
            },
          },
        ],
        metadataScope: {},
        artifactRoles: [],
        missingArtifactRoles: [],
        conflicts: [],
      },
    ],
    relatedEntities: [],
    relationships: [],
    locations: [],
  };
}

function execution(
  id: string,
  options: {
    readonly operationKind?: "rescrape" | "refresh-metadata";
    readonly status?: "running" | "completed" | "failed";
    readonly stage?: "recognition" | "completed" | "failed";
    readonly outcome?: "accepted" | "cancelled";
    readonly cancellation?: {
      readonly requestedBy: string;
      readonly requestedAt: string;
    };
    readonly sourceRefreshRuns?: readonly unknown[];
  } = {},
) {
  const status = options.status ?? "completed";
  return {
    kind: "execution",
    id,
    operationKind: options.operationKind ?? "rescrape",
    status,
    stage:
      options.stage ?? (status === "running" ? "recognition" : "completed"),
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    ...(options.cancellation === undefined
      ? {}
      : { cancellation: options.cancellation }),
    progress: { dispositions: [], workItems: [], targets: [] },
    sourceRefreshRuns: options.sourceRefreshRuns ?? [],
  };
}

function sourceRefreshRun() {
  const coverage = {
    sourceIdentity: "source-fixture",
    nativeAddress: "https://source.invalid/item/1",
    coverageId: "coverage-1",
  };
  return {
    id: "source-run-1",
    initiatedBy: "public-api",
    initiatedAt: "2026-10-16T00:00:00.000Z",
    requestedSelection: {
      subjectId: "asset-id-1",
      sourceAssociationId: "association-1",
      sourceIdentity: "source-fixture",
      nativeAddress: "https://source.invalid/item/1",
      selectors: [{ kind: "metadata-property", property: "asset.title" }],
    },
    reviewPolicy: "automatic",
    phase: "terminal",
    outcome: "succeeded",
    scopes: [
      {
        coverage,
        state: "terminal",
        acquisitionAttempt: 1,
        changeSetId: "change-set-1",
        candidateSourceRecordId: "source-record-1",
        outcome: "applied",
      },
    ],
    changeSets: [
      {
        id: "change-set-1",
        runId: "source-run-1",
        coverage,
        candidateSourceRecordId: "source-record-1",
        changes: [{ kind: "established", factReference: "fact-1" }],
        requiresReview: false,
        disposition: "automatic",
      },
    ],
  };
}

function json(
  response: ServerResponse<IncomingMessage>,
  body: unknown,
  status = 200,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
