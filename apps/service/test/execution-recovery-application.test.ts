import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProduct } from "@digital/composition";
import { prepareProductionCatalogue } from "@digital/db-migrations";
import { productGeneralAutomationInformationRequirement } from "@digital/product-application";
import {
  loadControlledSourceIo,
  refusingSessionTransport,
} from "@digital/test-support/source-io";
import { afterEach, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const fixtureMaterialDirectory = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/material"),
);
const fixtureManifestPath = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/audio-posts/manifest.json"),
);
const directedMaterialDirectory = fileURLToPath(
  import.meta.resolve("@digital/preview-corpus/publication-screen/material"),
);
const directedManifestPath = fileURLToPath(
  import.meta
    .resolve("@digital/preview-corpus/publication-screen/manifest.json"),
);

afterEach(async () => {
  for (const root of temporaryRoots.splice(0).reverse())
    await rm(root, { recursive: true, force: true });
});

it("正式产品刷新用例沿同一 SQLite 工作流完成扫描、重新刮削和元数据刷新", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-refresh-operations-product-"),
  );
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialDirectory = path.join(root, "material");
  await mkdir(materialDirectory);
  await cp(
    path.join(fixtureMaterialDirectory, "RJ01668691"),
    path.join(materialDirectory, "RJ01668691"),
    { recursive: true },
  );
  await prepareProductionCatalogue({ productDataDirectory });
  const controlled = await loadControlledSourceIo({
    manifestPath: fixtureManifestPath,
  });
  let externalRequestBlocked = false;
  let markExternalRequestStarted!: () => void;
  let releaseExternalRequest!: () => void;
  const externalRequestStarted = new Promise<void>((resolve) => {
    markExternalRequestStarted = resolve;
  });
  const externalRequestRelease = new Promise<void>((resolve) => {
    releaseExternalRequest = resolve;
  });
  const product = runProduct(
    {
      productDataDirectory,
      environment: {},
      sourceIo: {
        mode: "controlled",
        async request(input, init) {
          if (externalRequestBlocked) {
            externalRequestBlocked = false;
            markExternalRequestStarted();
            await externalRequestRelease;
          }
          return await controlled.request(input, init);
        },
        sessionTransport:
          controlled.sessionTransport ?? refusingSessionTransport(),
      },
    },
    { start: (application) => application },
  );

  try {
    const application = product.result;
    const waitForRefresh = async (executionId: string) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const inspection = await application.refresh.inspect(executionId);
        if (inspection === undefined)
          throw new Error(`刷新执行不可读取：${executionId}`);
        const status =
          inspection.kind === "asset-library-scan"
            ? inspection.scan.status
            : inspection.execution.execution.status;
        if (status !== "running") return inspection;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`刷新执行未在期限内结束：${executionId}`);
    };
    const libraries = application.workflow.assetLibraries;
    const library = await libraries.save({
      displayName: "进度恢复产品用例",
      directories: [materialDirectory],
      recognitionProfileIds: ["dlsite-voice"],
      sourceIdentities: ["dlsite"],
    });

    const scan = await application.refresh.startLibraryScan({
      libraryId: library.id,
    });
    expect(scan.id.length).toBeGreaterThan(0);
    const scanInspection = await waitForRefresh(scan.id);
    expect(scanInspection.kind).toBe("asset-library-scan");
    if (scanInspection.kind !== "asset-library-scan")
      throw new Error("库扫描未返回父账本检查");
    expect(scanInspection.execution.execution.id).toBe(scan.id);
    expect(scanInspection.scan.parentExecutionId).toBe(scan.id);
    expect(scanInspection.scan.status).toBe("completed");
    expect(scanInspection.children).toHaveLength(1);

    const current = await application.workflow.listCurrentCataloguePage({
      assetLibraryId: library.id,
      limit: 20,
    });
    const accepted = current.items.find(
      (subject) => subject.sourceAssociations.length > 0,
    );
    if (accepted === undefined)
      throw new Error("受控正式扫描没有建立带来源的当前主体");

    await expect(
      application.refresh.startCurrentScopeRescrape({
        subjectId: accepted.id,
      }),
    ).rejects.toThrow("当前内容没有可重新刮削的识别来源");

    const completedMetadata = await application.refresh.startMetadataRefresh({
      subjectId: accepted.id,
    });
    const completedMetadataInspection = await waitForRefresh(
      completedMetadata.id,
    );
    expect(completedMetadataInspection.kind).toBe("execution");
    if (completedMetadataInspection.kind !== "execution")
      throw new Error("元数据刷新返回了非预期父检查");
    expect(completedMetadataInspection.execution.execution.id).toBe(
      completedMetadata.id,
    );
    expect(
      completedMetadataInspection.execution.sourceRefreshRuns?.length,
    ).toBeGreaterThan(0);
    expect(
      completedMetadataInspection.execution.sourceRefreshRuns?.every(
        (run) => run.changeSets.length > 0,
      ),
    ).toBe(true);

    externalRequestBlocked = true;
    const metadata = await application.refresh.startMetadataRefresh({
      subjectId: accepted.id,
    });
    let requestStartTimeout: ReturnType<typeof setTimeout> | undefined;
    const requestStarted = await Promise.race([
      externalRequestStarted.then(() => true),
      new Promise<boolean>((resolve) => {
        requestStartTimeout = setTimeout(() => resolve(false), 15_000);
      }),
    ]);
    if (requestStartTimeout !== undefined) clearTimeout(requestStartTimeout);
    expect(requestStarted).toBe(true);
    const cancellation = await application.refresh.cancel({
      executionId: metadata.id,
      requestedBy: "service-test",
      requestedAt: new Date().toISOString(),
      reason: "验证取消状态与后台结局",
    });
    expect(cancellation.status).toBe("requested");
    expect(cancellation.inspection.kind).toBe("execution");
    if (cancellation.inspection.kind !== "execution")
      throw new Error("元数据刷新取消返回了非预期父检查");
    expect(cancellation.inspection.execution.execution).toMatchObject({
      id: metadata.id,
      status: "failed",
      outcome: "cancelled",
      cancellation: { requestedBy: "service-test" },
    });
    expect(cancellation.inspection.execution.sourceRefreshRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "terminal", outcome: "cancelled" }),
      ]),
    );
    releaseExternalRequest();

    const metadataInspection = await waitForRefresh(metadata.id);
    expect(metadataInspection.kind).toBe("execution");
    if (metadataInspection.kind !== "execution")
      throw new Error("元数据刷新返回了非预期父检查");
    expect(metadataInspection.execution.execution.id).toBe(metadata.id);
    expect(metadataInspection.execution.execution.operationKind).toBe(
      "refresh-metadata",
    );
    expect(metadataInspection.execution.execution).toMatchObject({
      status: "failed",
      outcome: "cancelled",
    });
    expect(
      metadataInspection.execution.sourceRefreshRuns?.length,
    ).toBeGreaterThan(0);
  } finally {
    releaseExternalRequest();
    await product.close();
  }
}, 180_000);

it("重新刮削从当前主体的识别来源继续，并保留相同主体身份", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-refresh-rescrape-product-"),
  );
  temporaryRoots.push(root);
  const productDataDirectory = path.join(root, "product-data");
  const materialDirectory = path.join(root, "material");
  const sourceMaterialDirectory = path.join(
    directedMaterialDirectory,
    "films",
    "[怒火救援].Man.on.Fire.2004.Blu-ray.1080p.AVC.DTS-HD.MA5.1-CMCT",
  );
  await cp(sourceMaterialDirectory, materialDirectory, { recursive: true });
  await writeFile(
    path.join(materialDirectory, "BDMV", "MovieObject.bdmv"),
    "movie",
  );
  await prepareProductionCatalogue({ productDataDirectory });
  const controlled = await loadControlledSourceIo({
    manifestPath: directedManifestPath,
  });
  const product = runProduct(
    {
      productDataDirectory,
      environment: {},
      sourceIo: {
        mode: "controlled",
        request: controlled.request,
        sessionTransport:
          controlled.sessionTransport ?? refusingSessionTransport(),
      },
    },
    { start: (application) => application },
  );

  try {
    const application = product.result;
    const workflow = application.workflow;
    workflow.sourceConnections.tmdb.configureAccessToken(
      "controlled-test-tmdb-token",
    );
    await workflow.sourceConnections.tmdb.verify();
    const library = await workflow.assetLibraries.save({
      displayName: "重新刮削受控影视库",
      directories: [materialDirectory],
      recognitionProfileIds: ["movies"],
      sourceIdentities: ["tmdb"],
    });
    const [rootRegistration] = await workflow.assetLibraries.directories(
      library.id,
    );
    if (rootRegistration === undefined)
      throw new Error("正式资产库未登记影视资料目录");
    const initial = await workflow.directedRecognitionSourceInputObservedScope({
      registrationId: rootRegistration.id,
      relativeScope: ".",
      sourceIdentity: "tmdb",
      sourceInput: { movie: "9509" },
      informationRequirement: productGeneralAutomationInformationRequirement,
    });
    expect(initial.execution.status).toBe("completed");
    expect(["accepted", "partially-succeeded"]).toContain(
      initial.execution.outcome,
    );
    const subjectId = initial.itemResults?.[0]?.accepted?.entity.id;
    if (subjectId === undefined)
      throw new Error("定向影视识别没有建立当前主体");
    const initialTarget = await workflow.inspectRefreshTarget(subjectId);
    expect(initialTarget?.recognitionSourceAssociation).toMatchObject({
      sourceIdentity: "tmdb",
    });

    const rescrape = await application.refresh.startCurrentScopeRescrape({
      subjectId,
    });
    expect(rescrape.id).toBeTruthy();
    const deadline = Date.now() + 120_000;
    let inspection = await application.refresh.inspect(rescrape.id);
    while (
      inspection?.kind === "execution" &&
      inspection.execution.execution.status === "running" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await application.refresh.inspect(rescrape.id);
    }
    expect(inspection?.kind).toBe("execution");
    if (inspection?.kind !== "execution")
      throw new Error("重新刮削执行不可读取");
    expect(inspection.execution.execution).toMatchObject({
      id: rescrape.id,
      operationKind: "rescrape",
      status: "completed",
    });
    expect(["accepted", "no-change", "partially-succeeded"]).toContain(
      inspection.execution.execution.outcome,
    );
    const currentAfter = await workflow.inspectRefreshTarget(subjectId);
    expect(currentAfter?.subjectId).toBe(subjectId);
    expect(currentAfter?.recognitionSourceAssociation?.sourceIdentity).toBe(
      "tmdb",
    );
  } finally {
    await product.close();
  }
}, 180_000);
