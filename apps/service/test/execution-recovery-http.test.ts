import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { runProduct } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import { createPublicHttpApi } from "@digital/http-delivery";
import {
  createPublicApiClient,
  PublicExecutionClientError,
} from "@digital/public-api";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
} from "@digital/test-support/source-io";
import { Hono } from "hono";
import { serve } from "srvx";
import { afterEach, expect, it } from "vitest";

import { interactiveTerminalEnvironment } from "./interactive-terminal.ts";

const products: Array<ReturnType<typeof runProduct>> = [];
const serviceServers: Array<Awaited<ReturnType<typeof serve>>> = [];
const proxies: Server[] = [];
const terminals: Array<ReturnType<typeof spawn>> = [];
const sourceGates: Array<ReturnType<typeof blockNextSourceRequest>> = [];
const temporaryRoots: string[] = [];
const servicePackageRoot = fileURLToPath(new URL("../", import.meta.url));
const materialRoot = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/publication-screen/material"),
);
const manifestPath = fileURLToPath(
  import.meta
    .resolve("@digital/preview-corpus/publication-screen/manifest.json"),
);

afterEach(async () => {
  for (const gate of sourceGates.splice(0).reverse()) gate.releaseRequest();
  for (const terminal of terminals.splice(0).reverse()) {
    if (terminal.exitCode !== null || terminal.signalCode !== null) continue;
    if (terminal.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-terminal.pid, "SIGTERM");
      } catch {
        terminal.kill("SIGTERM");
      }
    } else terminal.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (terminal.pid !== undefined && process.platform !== "win32") {
          try {
            process.kill(-terminal.pid, "SIGKILL");
          } catch {
            terminal.kill("SIGKILL");
          }
        } else terminal.kill("SIGKILL");
        resolve();
      }, 2_000);
      terminal.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  for (const proxy of proxies.splice(0).reverse()) {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
  for (const server of serviceServers.splice(0).reverse())
    await server.close(true);
  for (const product of products.splice(0).reverse()) await product.close();
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("真实 HTTP 执行在查询连接重置后以原 ID 恢复，取消与来源变更结局分开", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc07-public-http-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialDirectory = path.join(root, "影视收藏");
  const sourceMaterial = path.join(
    materialRoot,
    "films",
    "[怒火救援].Man.on.Fire.2004.Blu-ray.1080p.AVC.DTS-HD.MA5.1-CMCT",
  );
  await cp(sourceMaterial, materialDirectory, { recursive: true });
  await writeFile(
    path.join(materialDirectory, "BDMV", "MovieObject.bdmv"),
    "受控目录结构标记",
  );
  await prepareProductionCatalogue({ productDataDirectory });

  const controlled = await loadControlledSourceIo({ manifestPath });
  let nextGate:
    | {
        readonly entered: Promise<void>;
        readonly markEntered: () => void;
        readonly release: Promise<void>;
        readonly releaseRequest: () => void;
      }
    | undefined;
  const sourceIo = {
    mode: "controlled" as const,
    async request(
      input: string,
      init?: Parameters<typeof controlled.request>[1],
    ) {
      const gate = nextGate;
      if (gate !== undefined) {
        nextGate = undefined;
        gate.markEntered();
        await gate.release;
      }
      return await controlled.request(input, init);
    },
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  const product = runProduct(
    {
      productDataDirectory,
      environment: {},
      sourceIo,
    },
    { start: (application) => application },
  );
  products.push(product);
  const application = product.result;
  application.workflow.sourceConnections.tmdb.configureAccessToken(
    "controlled-test-tmdb-token",
  );
  await application.workflow.sourceConnections.tmdb.verify();

  let refreshPostCount = 0;
  const api = new Hono();
  api.use("/api/v1/refreshes", async (context, next) => {
    if (context.req.method === "POST") refreshPostCount += 1;
    await next();
  });
  api.route("/api/v1", createPublicHttpApi(application));
  const server = serve({
    fetch: api.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  serviceServers.push(server);
  await server.ready();
  const baseUrl = new URL(server.url!);
  const client = createPublicApiClient({ baseUrl });

  const library = await application.workflow.assetLibraries.save({
    displayName: "07 受控影视库",
    directories: [materialDirectory],
    recognitionProfileIds: ["movies"],
    sourceIdentities: ["tmdb"],
  });
  const [registration] = await application.workflow.assetLibraries.directories(
    library.id,
  );
  if (registration === undefined) throw new Error("正式资产库没有登记影视目录");
  await expect(
    client.startDirectedRecognition({
      registrationId: registration.id,
      relativeScope: ".",
      sourceIdentity: "tmdb",
      sourceInput: { movie: "invalid" },
    }),
  ).rejects.toMatchObject({ kind: "invalid-request", status: 400 });
  const failedStartDatabase = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  failedStartDatabase.exec(`
    CREATE TRIGGER reject_directed_recognition_start
    BEFORE INSERT ON workflow_executions
    BEGIN
      SELECT RAISE(ABORT, '10 confidential recognition start failure');
    END;
  `);
  try {
    const failedStart = await fetch(
      new URL("/api/v1/directed-recognitions", baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          registrationId: registration.id,
          relativeScope: ".",
          sourceIdentity: "tmdb",
          sourceInput: { movie: "9509" },
        }),
      },
    );
    const body = await failedStart.text();
    expect(failedStart.status).toBe(503);
    expect(body).toContain("暂时无法发起指定来源识别");
    expect(body).not.toContain("10 confidential recognition start failure");
    expect(body).not.toContain("SQLITE_CONSTRAINT_TRIGGER");
  } finally {
    failedStartDatabase.exec("DROP TRIGGER reject_directed_recognition_start");
    failedStartDatabase.close();
  }
  const directed = await client.startDirectedRecognition({
    registrationId: registration.id,
    relativeScope: ".",
    sourceIdentity: "tmdb",
    sourceInput: { movie: "9509" },
  });
  const established = await waitForExecution(client, directed.id);
  expect(established).toMatchObject({
    kind: "execution",
    id: directed.id,
    operationKind: "scan-filesystem",
    status: "completed",
  });
  expect(["accepted", "partially-succeeded"]).toContain(established.outcome);
  const subjectId =
    established.kind === "execution"
      ? established.progress.workItems[0]?.acceptedAssetId
      : undefined;
  if (subjectId === undefined)
    throw new Error("正式产品用例没有建立受控影视主体");
  const covers = await client.inspectArtifactRoleCovers(subjectId);
  const selectedCover = covers.candidates[0];
  if (selectedCover === undefined)
    throw new Error("受控来源识别没有留下封面候选");
  const coverPreview = await client.prepareArtifactRoleDecision(subjectId, {
    initiatedBy: "operator",
    candidateReference: selectedCover.reference,
  });
  expect(coverPreview.status).toBe("awaiting-confirmation");
  const failedConfirmationDatabase = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  failedConfirmationDatabase.exec(`
    CREATE TRIGGER reject_artifact_role_decision_insert
    BEFORE INSERT ON artifact_role_decisions
    BEGIN
      SELECT RAISE(ABORT, '10 confidential cover write failure');
    END;
  `);
  try {
    const failedConfirmation = await fetch(
      new URL(
        `/api/v1/change-impact-previews/${encodeURIComponent(coverPreview.previewId)}/confirm`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmedBy: "operator" }),
      },
    );
    const body = await failedConfirmation.text();
    expect(failedConfirmation.status).toBe(503);
    expect(body).toContain("暂时无法确认变更影响");
    expect(body).not.toContain("10 confidential cover write failure");
    expect(body).not.toContain("SQLITE_CONSTRAINT_TRIGGER");
  } finally {
    failedConfirmationDatabase.exec(
      "DROP TRIGGER reject_artifact_role_decision_insert",
    );
    failedConfirmationDatabase.close();
  }
  await expect(
    client.confirmChangeImpactPreview(coverPreview.previewId, "operator"),
  ).resolves.toMatchObject({ status: "applied" });
  await expect(
    client.inspectArtifactRoleCovers(subjectId),
  ).resolves.toMatchObject({
    effectiveReference: selectedCover.reference,
    decision: { kind: "select", reference: selectedCover.reference },
  });
  const unavailableCoverDatabase = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  unavailableCoverDatabase.exec(
    "ALTER TABLE artifact_role_decisions RENAME TO unavailable_artifact_role_decisions",
  );
  try {
    const unavailableCover = await fetch(
      new URL(
        `/api/v1/assets/${encodeURIComponent(subjectId)}/artifact-role-covers`,
        baseUrl,
      ),
    );
    const body = await unavailableCover.text();
    expect(unavailableCover.status).toBe(503);
    expect(body).toContain("暂时无法检查封面候选");
    expect(body).not.toContain("no such table");
  } finally {
    unavailableCoverDatabase.exec(
      "ALTER TABLE unavailable_artifact_role_decisions RENAME TO artifact_role_decisions",
    );
    unavailableCoverDatabase.close();
  }

  const scanDirectory = path.join(root, "扫描用普通目录");
  await mkdir(scanDirectory);
  await writeFile(path.join(scanDirectory, "普通说明.txt"), "扫描目录材料\n");
  const scanLibrary = await client.saveAssetLibrary({
    displayName: "07 普通目录扫描",
    directories: [scanDirectory],
    recognitionProfileIds: ["movies"],
    sourceIdentities: [],
  });
  const scanStart = await client.startAssetLibraryScan(scanLibrary.id);
  const scan = await waitForScan(client, scanStart.parentExecutionId);
  expect(scan).toMatchObject({
    parentExecutionId: scanStart.parentExecutionId,
    status: "completed",
  });
  const scanExecution = await client.inspectExecution(
    scanStart.parentExecutionId,
  );
  expect(scanExecution).toMatchObject({
    kind: "asset-library-scan",
    id: scanStart.parentExecutionId,
    status: "completed",
    children: [
      {
        executionId: expect.stringContaining("execution_"),
        status: "available",
      },
    ],
  });

  const rescrape = await client.startCurrentScopeRescrape({ subjectId });
  const rescraped = await waitForExecution(client, rescrape.id);
  expect(rescraped).toMatchObject({
    kind: "execution",
    id: rescrape.id,
    operationKind: "rescrape",
    status: "completed",
  });
  const listedAssets = await client.listAssets({ limit: 100 });
  expect(listedAssets.items.some((asset) => asset.id === subjectId)).toBe(true);

  const metadata = await client.startMetadataRefresh({ subjectId });
  const metadataResult = await waitForExecution(client, metadata.id);
  expect(metadataResult).toMatchObject({
    kind: "execution",
    id: metadata.id,
    operationKind: "refresh-metadata",
    status: "completed",
    sourceRefreshRuns: expect.arrayContaining([
      expect.objectContaining({
        phase: "terminal",
        changeSets: expect.arrayContaining([
          expect.objectContaining({ id: expect.any(String) }),
        ]),
      }),
    ]),
  });
  if (metadataResult.kind !== "execution")
    throw new Error("元数据刷新返回了库扫描检查");
  expect(["succeeded", "partially-succeeded"]).toContain(
    metadataResult.sourceRefreshRuns[0]?.outcome,
  );
  const changeSetId = metadataResult.sourceRefreshRuns[0]?.changeSets[0]?.id;
  expect(changeSetId).toBeTruthy();

  const reviewExecution = await client.startMetadataRefresh({
    subjectId,
    reviewPolicy: "review",
  });
  await expect
    .poll(
      async () => {
        const inspection = await client.inspectExecution(reviewExecution.id);
        return inspection.kind === "execution"
          ? inspection.sourceRefreshRuns.flatMap((run) =>
              run.changeSets.filter(
                (changeSet) => changeSet.disposition === "pending",
              ),
            ).length
          : 0;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const reviewInspection = await client.inspectExecution(reviewExecution.id);
  if (reviewInspection.kind !== "execution")
    throw new Error("来源更新审核返回了资料库扫描");
  const reviewRun = reviewInspection.sourceRefreshRuns[0];
  const pendingChangeSet = reviewRun?.changeSets.find(
    (changeSet) => changeSet.disposition === "pending",
  );
  if (reviewRun === undefined || pendingChangeSet === undefined)
    throw new Error("来源更新没有待审核变更集");
  await expect(
    client.reviewSourceRefreshChangeSet(reviewRun.id, {
      changeSetId: "missing-change-set",
      disposition: "approved",
    }),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });
  const reviewedRun = await client.reviewSourceRefreshChangeSet(reviewRun.id, {
    changeSetId: pendingChangeSet.id,
    disposition: "approved",
  });
  expect(
    reviewedRun.changeSets.find(({ id }) => id === pendingChangeSet.id),
  ).toMatchObject({ disposition: "approved" });
  await expect(
    client.inspectSourceRefreshRun(reviewRun.id),
  ).resolves.toMatchObject({
    changeSets: expect.arrayContaining([
      expect.objectContaining({
        id: pendingChangeSet.id,
        disposition: "approved",
      }),
    ]),
  });

  const resetGate = blockNextSourceRequest();
  nextGate = resetGate;
  const beforeRecoveryPostCount = refreshPostCount;
  const pending = await client.startMetadataRefresh({ subjectId });
  await resetGate.entered;
  const proxy = await startExecutionResetProxy(baseUrl, pending.id);
  const interruptedClient = createPublicApiClient({ baseUrl: proxy.url });
  let queryError: unknown;
  try {
    await interruptedClient.inspectExecution(pending.id);
  } catch (error) {
    queryError = error;
  }
  expect(proxy.state).toMatchObject({
    resetExecutionId: pending.id,
    responseStatus: 200,
    responseExecutionStatus: "running",
  });
  expect(queryError).toBeInstanceOf(PublicExecutionClientError);
  expect(queryError).toMatchObject({
    kind: "transport",
    executionId: pending.id,
    cause: { cause: { code: "ECONNRESET" } },
  });
  expect(
    (await fetch(new URL("/api/v1/asset-libraries", baseUrl))).status,
  ).toBe(200);
  resetGate.releaseRequest();
  const recovered = await waitForExecution(client, pending.id);
  expect(recovered).toMatchObject({
    kind: "execution",
    id: pending.id,
    status: "completed",
  });
  expect(refreshPostCount).toBe(beforeRecoveryPostCount + 1);

  const cancelGate = blockNextSourceRequest();
  nextGate = cancelGate;
  const cancellable = await client.startMetadataRefresh({ subjectId });
  await cancelGate.entered;
  const cancellation = await client.cancelExecution(cancellable.id, {
    reason: "验证取消请求与实际结局分离",
  });
  expect(cancellation.requestStatus).toBe("requested");
  expect(cancellation.inspection).toMatchObject({
    kind: "execution",
    id: cancellable.id,
    status: "failed",
    outcome: "cancelled",
    cancellation: { requestedBy: "public-api" },
    sourceRefreshRuns: [
      expect.objectContaining({ phase: "terminal", outcome: "cancelled" }),
    ],
  });
  cancelGate.releaseRequest();
  const cancelled = await waitForExecution(client, cancellable.id);
  expect(cancelled).toMatchObject({
    kind: "execution",
    id: cancellable.id,
    status: "failed",
    outcome: "cancelled",
  });
  await expect(
    client.inspectExecution("execution-missing"),
  ).rejects.toMatchObject({
    kind: "not-found",
    status: 404,
  });
  const sourceHistory = await client.inspectSourceAssociationHistory(subjectId);
  const currentAssociation = sourceHistory.current[0];
  if (currentAssociation === undefined)
    throw new Error("正式来源识别没有建立可修复的来源关联");
  const decisionStart = await client.startSourceAssociationDecision({
    intent: "retract",
    assetId: subjectId,
    predecessorAssociationId: currentAssociation.id,
    initiatedBy: "operator",
    reason: "验证公开来源关联撤回流程",
  });
  const decision = await client.inspectSourceAssociationDecision(
    decisionStart.executionId,
  );
  expect(decision).toMatchObject({
    executionId: decisionStart.executionId,
    intent: "retract",
    predecessor: { id: currentAssociation.id },
    preview: { status: "awaiting-confirmation" },
  });
  const unavailableDecisionDatabase = new DatabaseSync(
    path.join(productDataDirectory, "catalogue.sqlite"),
  );
  unavailableDecisionDatabase.exec(
    "ALTER TABLE workflow_executions RENAME TO unavailable_workflow_executions",
  );
  try {
    const unavailableDecision = await fetch(
      new URL(
        `/api/v1/source-association-decisions/${encodeURIComponent(decisionStart.executionId)}`,
        baseUrl,
      ),
    );
    const body = await unavailableDecision.text();
    expect(unavailableDecision.status).toBe(503);
    expect(body).toContain("暂时无法读取来源关联决定");
    expect(body).not.toContain("no such table");
  } finally {
    unavailableDecisionDatabase.exec(
      "ALTER TABLE unavailable_workflow_executions RENAME TO workflow_executions",
    );
    unavailableDecisionDatabase.close();
  }
  await expect(
    client.selectSourceAssociationCandidate(
      decisionStart.executionId,
      "candidate-from-another-decision",
    ),
  ).rejects.toMatchObject({ kind: "conflict", status: 409 });
  const associationRetraction = await client.confirmChangeImpactPreview(
    decision.preview!.previewId,
    "operator",
  );
  expect(associationRetraction.status).toBe("applied");
  const retractedHistory =
    await client.inspectSourceAssociationHistory(subjectId);
  expect(retractedHistory.current).toEqual([]);
  expect(retractedHistory.historical).toContainEqual(
    expect.objectContaining({
      association: expect.objectContaining({ id: currentAssociation.id }),
      status: "retracted",
    }),
  );
  expect(changeSetId).toBeTruthy();
}, 180_000);

it("已安装 TUI 在查询连接重置后按原 ID 恢复并取消真实执行【安装客户端】", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ewc07-execution-tui-"));
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialDirectory = path.join(root, "影视收藏");
  const sourceMaterial = path.join(
    materialRoot,
    "films",
    "[怒火救援].Man.on.Fire.2004.Blu-ray.1080p.AVC.DTS-HD.MA5.1-CMCT",
  );
  await cp(sourceMaterial, materialDirectory, { recursive: true });
  await writeFile(
    path.join(materialDirectory, "BDMV", "MovieObject.bdmv"),
    "受控目录结构标记",
  );
  await prepareProductionCatalogue({ productDataDirectory });

  const controlled = await loadControlledSourceIo({ manifestPath });
  let nextGate: ReturnType<typeof blockNextSourceRequest> | undefined;
  const sourceIo = {
    mode: "controlled" as const,
    async request(
      input: string,
      init?: Parameters<typeof controlled.request>[1],
    ) {
      const gate = nextGate;
      if (gate !== undefined) {
        nextGate = undefined;
        gate.markEntered();
        await gate.release;
      }
      return await controlled.request(input, init);
    },
    sessionTransport: controlled.sessionTransport ?? refusingSessionTransport(),
  };
  const product = runProduct(
    {
      productDataDirectory,
      environment: {},
      sourceIo,
    },
    { start: (application) => application },
  );
  products.push(product);
  const application = product.result;
  application.workflow.sourceConnections.tmdb.configureAccessToken(
    "controlled-test-tmdb-token",
  );
  await application.workflow.sourceConnections.tmdb.verify();
  const api = new Hono();
  api.route("/api/v1", createPublicHttpApi(application));
  const server = serve({
    fetch: api.fetch,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  });
  serviceServers.push(server);
  await server.ready();
  const baseUrl = new URL(server.url!);
  const client = createPublicApiClient({ baseUrl });
  const library = await application.workflow.assetLibraries.save({
    displayName: "07 受控影视库",
    directories: [materialDirectory],
    recognitionProfileIds: ["movies"],
    sourceIdentities: ["tmdb"],
  });
  const [registration] = await application.workflow.assetLibraries.directories(
    library.id,
  );
  if (registration === undefined) throw new Error("正式资产库没有登记影视目录");
  const directed = await client.startDirectedRecognition({
    registrationId: registration.id,
    relativeScope: ".",
    sourceIdentity: "tmdb",
    sourceInput: { movie: "9509" },
  });
  const established = await waitForExecution(client, directed.id);
  expect(established).toMatchObject({
    kind: "execution",
    id: directed.id,
    operationKind: "scan-filesystem",
    status: "completed",
  });
  expect(["accepted", "partially-succeeded"]).toContain(
    established.kind === "execution" ? established.outcome : undefined,
  );
  const subjectId =
    established.kind === "execution"
      ? established.progress.workItems[0]?.acceptedAssetId
      : undefined;
  if (subjectId === undefined)
    throw new Error("正式产品用例没有建立受控影视主体");

  const libraries = await client.listAssetLibraries({ limit: 100 });
  const terminalLibraryIndex = libraries.items.findIndex(
    ({ id }) => id === library.id,
  );
  expect(terminalLibraryIndex).toBeGreaterThanOrEqual(0);
  const terminalAssets = await client.listAssets({
    assetLibraryId: library.id,
    limit: 20,
  });
  const terminalAssetIndex = terminalAssets.items.findIndex(
    ({ id }) => id === subjectId,
  );
  expect(terminalAssetIndex).toBeGreaterThanOrEqual(0);
  const terminalAsset = terminalAssets.items[terminalAssetIndex];
  if (terminalAsset === undefined)
    throw new Error("正式资产主体不在终端资产页中");
  const terminalAssetTitle = terminalAsset.descriptions
    .filter(
      (description) =>
        description.target.kind === "entity" &&
        description.target.entityId === terminalAsset.id,
    )
    .flatMap((description) => description.metadata)
    .find(
      (metadata) =>
        metadata.property === "asset.title" &&
        metadata.result.status === "resolved",
    )?.result;
  const terminalAssetLabel =
    (terminalAssetTitle?.status === "resolved"
      ? terminalAssetTitle.values[0]?.value
      : undefined) ??
    terminalAsset.relatedEntities.find(
      (entity) => entity.id === terminalAsset.id,
    )?.label;
  if (terminalAssetLabel === undefined)
    throw new Error("正式资产主体没有可显示的名称");

  const terminalGate = blockNextSourceRequest();
  nextGate = terminalGate;
  const terminalProxy = await startExecutionResetProxy(baseUrl);
  const terminalCommand = `stty cols 58 rows 18 -icanon -echo; terminalModeBefore=$(stty -g); pnpm --filter @digital/service exec digital-tui --url ${terminalProxy.url.origin}; terminalModeAfter=$(stty -g); if [ "$terminalModeBefore" = "$terminalModeAfter" ]; then echo TERMINAL_RESTORED; else echo TERMINAL_NOT_RESTORED; fi`;
  const terminal = spawn("script", ["-qfec", terminalCommand, "/dev/null"], {
    cwd: servicePackageRoot,
    env: interactiveTerminalEnvironment({
      TERM: "xterm-256color",
      COLUMNS: "58",
      LINES: "18",
    }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  terminals.push(terminal);
  const terminalOutputChunks: Buffer[] = [];
  const terminalErrorChunks: Buffer[] = [];
  const terminalText = () =>
    Buffer.concat(terminalOutputChunks).toString("utf8");
  terminal.stdout.on("data", (chunk: Buffer) =>
    terminalOutputChunks.push(chunk),
  );
  terminal.stderr.on("data", (chunk: Buffer) =>
    terminalErrorChunks.push(chunk),
  );

  await waitForProxy(
    terminalProxy.state,
    () =>
      terminalProxy.state.completedPaths.includes(
        "/api/v1/asset-libraries?limit=20",
      ),
    "TUI 未读取真实资产库列表",
  );
  await waitForProxy(
    terminalProxy.state,
    () => terminalText().includes("07 受控影视库"),
    "终端未显示正式资产库",
  );
  const firstLibrary = libraries.items[0];
  if (firstLibrary === undefined) throw new Error("正式资产库列表为空");
  await waitForTerminal(
    () => terminalText().includes(`› ${firstLibrary.displayName}`),
    terminal,
    terminalText,
    "TUI 未显示初始选中的资产库",
  );
  for (let index = 0; index < terminalLibraryIndex; index += 1) {
    const nextLibrary = libraries.items[index + 1];
    if (nextLibrary === undefined)
      throw new Error("资产库列表索引超出当前结果");
    terminal.stdin.write("j");
    await waitForTerminal(
      () => terminalText().includes(`› ${nextLibrary.displayName}`),
      terminal,
      terminalText,
      "TUI 未移动到目标资产库",
    );
  }
  await waitForTerminal(
    () => terminalText().includes(`› ${library.displayName}`),
    terminal,
    terminalText,
    "终端未选择目标资产库",
  );
  terminal.stdin.write("\r");
  const assetListPath = `/api/v1/assets?assetLibraryId=${encodeURIComponent(library.id)}&limit=20`;
  await waitForProxy(
    terminalProxy.state,
    () => terminalProxy.state.completedPaths.includes(assetListPath),
    () =>
      `TUI 未读取正式资产主体；请求 ${JSON.stringify(terminalProxy.state.requests)}；终端错误 ${Buffer.concat(terminalErrorChunks).toString("utf8")}；终端输出 ${terminalText()}`,
    5_000,
  );
  await waitForTerminal(
    () =>
      terminalText().includes("m 元数据刷新") &&
      terminalText().includes(`› ${terminalAssetLabel.slice(0, 18)}`),
    terminal,
    terminalText,
    "TUI 未显示目标资产及元数据刷新操作",
    5_000,
  );
  for (let index = 0; index < terminalAssetIndex; index += 1) {
    const nextAsset = terminalAssets.items[index + 1];
    if (nextAsset === undefined) throw new Error("正式资产页索引超出当前结果");
    const nextTitle = nextAsset.descriptions
      .filter(
        (description) =>
          description.target.kind === "entity" &&
          description.target.entityId === nextAsset.id,
      )
      .flatMap((description) => description.metadata)
      .find(
        (metadata) =>
          metadata.property === "asset.title" &&
          metadata.result.status === "resolved",
      )?.result;
    const nextLabel =
      (nextTitle?.status === "resolved"
        ? nextTitle.values[0]?.value
        : undefined) ??
      nextAsset.relatedEntities.find((entity) => entity.id === nextAsset.id)
        ?.label;
    if (nextLabel === undefined) throw new Error("资产页包含无法显示的主体");
    terminal.stdin.write("j");
    await waitForTerminal(
      () => terminalText().includes(`› ${nextLabel.slice(0, 18)}`),
      terminal,
      terminalText,
      "TUI 未移动到下一资产",
    );
  }
  terminal.stdin.write("m");
  await waitForProxy(
    terminalProxy.state,
    () => terminalGate.hasEntered(),
    () =>
      `TUI 元数据刷新未触发来源请求；gateEntered=${terminalGate.hasEntered()}；请求 ${JSON.stringify(terminalProxy.state.requests)}；终端错误 ${Buffer.concat(terminalErrorChunks).toString("utf8")}；终端输出 ${terminalText()}`,
  );
  await waitForProxy(
    terminalProxy.state,
    () => terminalProxy.state.startedExecutionId !== undefined,
    "TUI 未通过真实 HTTP 发起元数据刷新",
  );
  const terminalExecutionId = terminalProxy.state.startedExecutionId;
  if (terminalExecutionId === undefined)
    throw new Error("TUI 刷新没有取得正式执行身份");
  await waitForProxy(
    terminalProxy.state,
    () => terminalProxy.state.resetExecutionId === terminalExecutionId,
    "真实 TUI 执行查询没有遇到受控连接中断",
  );
  await waitForProxy(
    terminalProxy.state,
    () =>
      terminalProxy.state.executionResponses.filter(
        ({ id }) => id === terminalExecutionId,
      ).length >= 2,
    "TUI 未以原执行 ID 恢复查询",
  );
  terminal.stdin.write("c");
  await waitForProxy(
    terminalProxy.state,
    () => terminalProxy.state.cancelRequestExecutionId === terminalExecutionId,
    "TUI 未通过真实 HTTP 提交原执行取消请求",
  );
  terminalGate.releaseRequest();
  await waitForProxy(
    terminalProxy.state,
    () =>
      terminalProxy.state.executionResponses.some(
        ({ id, outcome }) =>
          id === terminalExecutionId && outcome === "cancelled",
      ),
    "TUI 未读取原执行的持久取消结局",
  );
  await waitForProxy(
    terminalProxy.state,
    () =>
      terminalText().includes("刷新已取消") &&
      terminalText().includes("状态：已取消"),
    "终端未显示真实取消结局",
  );
  terminal.stdin.write("q");
  const terminalExitCode = await new Promise<number | null>(
    (resolve, reject) => {
      terminal.once("error", reject);
      terminal.once("close", (code) => resolve(code));
      setTimeout(() => {
        if (terminal.pid === undefined) return;
        try {
          process.kill(-terminal.pid, "SIGTERM");
        } catch {
          terminal.kill("SIGTERM");
        }
      }, 15_000).unref();
    },
  );
  const terminalOutput = terminalText();
  const terminalError = Buffer.concat(terminalErrorChunks).toString("utf8");
  expect(terminalExitCode, `${terminalError}\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain(terminalExecutionId);
  expect(terminalOutput).toContain("执行结局仍未知");
  expect(terminalOutput).toContain("刷新已取消");
  expect(terminalOutput).toContain("状态：已取消");
  expect(terminalOutput).toContain("来源刷新");
  expect(terminalOutput).toContain("TERMINAL_RESTORED");
  expect(
    terminalProxy.state.requests.filter(
      ({ method, path }) => method === "POST" && path === "/api/v1/refreshes",
    ),
  ).toHaveLength(1);
  expect(
    terminalProxy.state.requests.filter(
      ({ method, path }) =>
        method === "POST" &&
        path === `/api/v1/executions/${terminalExecutionId}/cancel`,
    ),
  ).toHaveLength(1);
}, 180_000);

function blockNextSourceRequest(): {
  readonly entered: Promise<void>;
  readonly markEntered: () => void;
  readonly release: Promise<void>;
  readonly releaseRequest: () => void;
  readonly hasEntered: () => boolean;
} {
  let markEntered!: () => void;
  let releaseRequest!: () => void;
  let enteredSourceRequest = false;
  const entered = new Promise<void>((resolve) => {
    markEntered = () => {
      enteredSourceRequest = true;
      resolve();
    };
  });
  const release = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const gate = {
    entered,
    markEntered,
    release,
    releaseRequest: () => releaseRequest(),
    hasEntered: () => enteredSourceRequest,
  };
  sourceGates.push(gate);
  return gate;
}

async function waitForExecution(
  client: ReturnType<typeof createPublicApiClient>,
  executionId: string,
): Promise<Awaited<ReturnType<typeof client.inspectExecution>>> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const inspection = await client.inspectExecution(executionId);
    if (inspection.status !== "running") return inspection;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`执行未在期限内结束：${executionId}`);
}

async function waitForScan(
  client: ReturnType<typeof createPublicApiClient>,
  executionId: string,
): Promise<Awaited<ReturnType<typeof client.inspectAssetLibraryScan>>> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const scan = await client.inspectAssetLibraryScan(executionId);
    if (scan.status !== "running") return scan;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`扫描未在期限内结束：${executionId}`);
}

type ExecutionResetProxyState = {
  resetExecutionId: string | undefined;
  responseStatus: number | undefined;
  responseExecutionStatus: string | undefined;
  startedExecutionId: string | undefined;
  cancelRequestExecutionId: string | undefined;
  readonly requests: Array<{ readonly method: string; readonly path: string }>;
  readonly completedPaths: string[];
  readonly executionResponses: Array<{
    readonly id: string;
    readonly status: string;
    readonly outcome: string | undefined;
  }>;
};

async function waitForProxy(
  state: ExecutionResetProxyState,
  condition: () => boolean,
  failure: string | (() => string),
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `${typeof failure === "function" ? failure() : failure}；请求数 ${state.requests.length}`,
  );
}

async function waitForTerminal(
  condition: () => boolean,
  terminal: ReturnType<typeof spawn>,
  output: () => string,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    if (terminal.exitCode !== null || terminal.signalCode !== null)
      throw new Error(
        `${description}；TUI 已退出，状态 ${terminal.exitCode ?? terminal.signalCode}；终端输出 ${output()}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${description}；终端输出 ${output()}`);
}

async function startExecutionResetProxy(
  serviceUrl: URL,
  executionId?: string,
): Promise<{
  readonly url: URL;
  readonly state: ExecutionResetProxyState;
}> {
  const state: ExecutionResetProxyState = {
    resetExecutionId: undefined,
    responseStatus: undefined,
    responseExecutionStatus: undefined,
    startedExecutionId: undefined,
    cancelRequestExecutionId: undefined,
    requests: [],
    completedPaths: [],
    executionResponses: [],
  };
  const proxy = createHttpServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const requestBody = Buffer.concat(chunks);
      const requestPath = incoming.url ?? "/";
      const method = incoming.method ?? "GET";
      state.requests.push({ method, path: requestPath });
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (
          typeof value === "string" &&
          name !== "host" &&
          name !== "connection" &&
          name !== "content-length" &&
          name !== "transfer-encoding"
        )
          headers.set(name, value);
      const response = await fetch(new URL(requestPath, serviceUrl), {
        method,
        headers,
        ...(requestBody.length === 0
          ? {}
          : { body: new Uint8Array(requestBody) }),
      });
      const responseBody = new Uint8Array(await response.arrayBuffer());
      if (method === "POST" && requestPath === "/api/v1/refreshes") {
        const started = JSON.parse(
          Buffer.from(responseBody).toString("utf8"),
        ) as { readonly id?: unknown };
        state.startedExecutionId =
          typeof started.id === "string" ? started.id : undefined;
      }
      if (method === "POST") {
        const cancellationPath = requestPath.match(
          /^\/api\/v1\/executions\/([^/]+)\/cancel$/,
        );
        if (cancellationPath?.[1] !== undefined)
          state.cancelRequestExecutionId = decodeURIComponent(
            cancellationPath[1],
          );
      }
      const executionPath = requestPath.match(
        /^\/api\/v1\/executions\/([^/]+)$/,
      );
      if (method === "GET" && executionPath?.[1] !== undefined) {
        const executionReply = JSON.parse(
          Buffer.from(responseBody).toString("utf8"),
        ) as {
          readonly id?: unknown;
          readonly status?: unknown;
          readonly outcome?: unknown;
        };
        if (
          typeof executionReply.id === "string" &&
          typeof executionReply.status === "string"
        )
          state.executionResponses.push({
            id: executionReply.id,
            status: executionReply.status,
            outcome:
              typeof executionReply.outcome === "string"
                ? executionReply.outcome
                : undefined,
          });
      }
      const resetTarget = executionId ?? state.startedExecutionId;
      if (
        state.resetExecutionId === undefined &&
        method === "GET" &&
        resetTarget !== undefined &&
        requestPath === `/api/v1/executions/${resetTarget}`
      ) {
        state.resetExecutionId = resetTarget;
        state.responseStatus = response.status;
        const executionReply = state.executionResponses.at(-1);
        state.responseExecutionStatus = executionReply?.status;
        outgoing.socket?.resetAndDestroy();
        return;
      }
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of response.headers)
        if (name !== "connection" && name !== "transfer-encoding")
          responseHeaders[name] = value;
      outgoing.writeHead(response.status, responseHeaders);
      outgoing.end(responseBody, () => {
        state.completedPaths.push(requestPath);
      });
    })().catch((error: unknown) => {
      if (!outgoing.destroyed) outgoing.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  proxies.push(proxy);
  const address = proxy.address();
  if (address === null || typeof address === "string")
    throw new Error("执行恢复代理没有取得端口");
  return {
    url: new URL(`http://127.0.0.1:${String(address.port)}`),
    state,
  };
}
