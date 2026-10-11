import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  InformationFulfillment,
  type AssetRefreshInspection,
} from "@digital/application";
import { dlsiteInformationFulfillmentCapabilities } from "@digital/dlsite";
import { SqliteCatalogue } from "@digital/sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  composeAssetRefresh,
  composeAssetRefreshRuntime,
  composeOwnedAssetRefresh,
  type ComposedAssetRefresh,
} from "../src/runtime.ts";
import {
  disposePreparedCatalogueTemplate,
  prepareCatalogueAt,
} from "./prepared-catalogue.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await disposePreparedCatalogueTemplate();
});

/**
 * 生产观察者测试必须跨越已注册根边界。该辅助方法刻意避开旧版原始路径扫描入口，
 * 使 Node 观察者像交付层一样接收绑定描述符的权威。
 */
const authorizedDirectories = new Map<
  string,
  { readonly libraryId: string; readonly rootId: string }
>();

/**
 * 通过公开资产库入口为目录建立授权：只登记目录而不属于任何活动库时，现行产品既不给
 * 读取权威也不给自动刷新归属。同一目录复用同一份库授权，避免该目录同时点名进两个库。
 */
async function authorizeDirectory(
  workflow: Pick<ComposedAssetRefresh, "assetLibraries">,
  displayName: string,
  directory: string,
): Promise<{ readonly libraryId: string; readonly rootId: string }> {
  const seeded = authorizedDirectories.get(directory);
  if (seeded !== undefined) return seeded;
  const libraries = workflow.assetLibraries;
  const saved = await libraries.save({
    displayName,
    directories: [directory],
    recognitionProfileIds: libraries.recognitionProfiles.map(
      (profile) => profile.id,
    ),
    sourceIdentities: libraries.sources.map((source) => source.id),
  });
  const authorized = { libraryId: saved.id, rootId: saved.rootIds[0]! };
  authorizedDirectories.set(directory, authorized);
  return authorized;
}

async function scanRegisteredScope(
  workflow: Pick<ComposedAssetRefresh, "assetLibraries" | "scanObservedScope">,
  observed: string,
  input: Omit<
    Parameters<ComposedAssetRefresh["scanObservedScope"]>[0],
    "registrationId" | "relativeScope"
  >,
): Promise<AssetRefreshInspection> {
  const { rootId } = await authorizeDirectory(
    workflow,
    "测试观察目录",
    observed,
  );
  const result = await workflow.scanObservedScope({
    registrationId: rootId,
    relativeScope: ".",
    ...input,
  });
  return { ...result, accepted: singleAcceptedSubject(result) };
}

/** 此文件每次点名扫描一个作品；多工作项信封不能默取首项掩盖额外主体。 */
function singleAcceptedSubject(inspection: AssetRefreshInspection) {
  if (inspection.accepted !== undefined) return inspection.accepted;
  const accepted = (inspection.itemResults ?? []).flatMap((item) =>
    item.outcome === "accepted" && item.accepted !== undefined
      ? [item.accepted]
      : [],
  );
  expect(accepted).toHaveLength(1);
  return accepted[0]!;
}

describe("information fulfillment composition", () => {
  it("waits for the workflow fulfillment drain before releasing composed persistence", async () => {
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const workflowClose = vi.fn(() => drain);
    const persistence = { close: vi.fn() };
    const workflow = composeOwnedAssetRefresh(
      { close: workflowClose } as never,
      persistence,
    );
    const closing = workflow.close();
    try {
      expect(workflow.close()).toBe(closing);
      expect(workflowClose).toHaveBeenCalledTimes(1);
      expect(persistence.close).toHaveBeenCalledTimes(0);
    } finally {
      releaseDrain();
      await closing;
    }
    expect(persistence.close).toHaveBeenCalledTimes(1);
  });

  it("releases composed persistence after a fulfillment terminalization failure", async () => {
    const terminalizationFailure = new Error("terminal write failed");
    const workflowClose = vi.fn(() => Promise.reject(terminalizationFailure));
    const persistence = { close: vi.fn() };
    const workflow = composeOwnedAssetRefresh(
      { close: workflowClose } as never,
      persistence,
    );

    const closing = workflow.close();
    expect(workflow.close()).toBe(closing);
    await expect(closing).rejects.toBe(terminalizationFailure);
    await expect(workflow.close()).rejects.toBe(terminalizationFailure);
    expect(workflowClose).toHaveBeenCalledTimes(1);
    expect(persistence.close).toHaveBeenCalledTimes(1);
  });

  it("在工作流排空后、持久化关闭前释放 FANBOX 产品装配", async () => {
    const order: string[] = [];
    const fanboxFailure = new Error("browser cleanup failed");
    const workflow = composeOwnedAssetRefresh(
      {
        async close() {
          order.push("workflow");
        },
      } as never,
      {
        close() {
          order.push("persistence");
        },
      },
      undefined,
      undefined,
      async () => {
        order.push("fanbox");
        throw fanboxFailure;
      },
    );

    await expect(workflow.close()).rejects.toBe(fanboxFailure);
    expect(order).toEqual(["workflow", "fanbox", "persistence"]);
  });

  it("shares one source-artifact fulfilment between delivery and the owned automation host", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-shared-seam-"));
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push(address);
      if (address.includes("/product/info/ajax")) {
        return new Response(
          JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "Exact work",
              regist_date: "2026-08-01",
              work_image: "//img.dlsite.jp/primary.jpg",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (address === "https://img.dlsite.jp/primary.jpg") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const coverRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [],
      relationshipTypes: [],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
    };
    let pollClock: (() => void) | undefined;
    const runtime = composeAssetRefreshRuntime(productData, {
      configuration: {},
      clock: {
        now: () => new Date("2099-01-01T00:00:00.000Z"),
        setInterval(callback) {
          pollClock = callback;
          return callback;
        },
        clearInterval() {
          pollClock = undefined;
        },
      },
      automationInformationRequirementForAcceptedSubject: {
        coordinate: "composition-cover-test/1",
        requirementForAcceptedSubject: () => coverRequirement,
      },
    });

    try {
      const recognized = await scanRegisteredScope(runtime.workflow, observed, {
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.title", necessity: "required" }],
          relationshipTypes: [],
          artifactRoles: [],
        },
      });
      const subjectId = recognized.accepted?.entity.id;
      if (subjectId === undefined)
        throw new Error("DLsite subject was not accepted");
      const refreshed = await runtime.workflow.refreshMetadata({
        selection: {
          version: "asset-refresh-selection/1",
          subjects: [
            {
              subjectId,
              explanations: [{ path: ["test", subjectId] }],
            },
          ],
          filesystemScopes: [],
        },
        informationRequirement: coverRequirement,
      });
      expect(refreshed.sourceRefreshRuns).toEqual([
        expect.objectContaining({ outcome: "succeeded", phase: "terminal" }),
      ]);
      const automationRoot = await authorizeDirectory(
        runtime.workflow,
        "自动刷新测试",
        observed,
      );
      const automated = await runtime.workflow.enableAutomation({
        assetLibraryId: automationRoot.libraryId,
        observedRootId: automationRoot.rootId,
        relativeScope: ".",
        intervalMilliseconds: 60_000,
        acceptTrusted: true,
        runInitial: false,
      });
      expect(automated.intent.id).toEqual(expect.any(String));

      const invoke = vi.spyOn(runtime.executionHost, "invoke");
      const interactive = runtime.workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: coverRequirement,
      });
      const repeatedInteractive = runtime.workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: coverRequirement,
      });
      const host = runtime.automationHost.start().then(async () => {
        expect(pollClock).toBeTypeOf("function");
        pollClock!();
        await runtime.automationHost.settled();
      });
      const [readiness, repeatedReadiness] = await Promise.all([
        interactive,
        repeatedInteractive,
        host,
      ]);
      const executionId =
        readiness.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId;
      expect(executionId).toEqual(expect.any(String));
      // Node 的不透明对象身份刻意限定在快照内。因此单独注册的自动化扫描拥有自己的
      // 来源获取边界，而不是借用本次扫描的文件身份。
      expect(
        repeatedReadiness.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId,
      ).toBe(executionId);
      expect(invoke).toHaveBeenCalledTimes(1);
      await waitForTerminalExecution(runtime.workflow, executionId!);
      expect(await runtime.workflow.listInspections()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            execution: expect.objectContaining({
              automationIntentId: automated.intent.id,
            }),
          }),
        ]),
      );

      // 初始已注册扫描及其自动后续操作属于不同快照，因此二者都不能复用 Node 本地对象身份证据。
      expect(
        requested.filter(
          (address) => address === "https://img.dlsite.jp/primary.jpg",
        ),
      ).toHaveLength(1);
    } finally {
      await runtime.close();
      await runtime.close();
    }
  });

  it("通过正式 DLsite 刷新采用两个作品，并从来源社团反查两项已收录作品", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-dlsite-circle-"));
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const firstObserved = path.join(root, "RJ01668691");
    const secondObserved = path.join(root, "RJ01668692");
    await mkdir(firstObserved);
    await mkdir(secondObserved);
    await Promise.all([
      writeFile(path.join(firstObserved, "first.wav"), "first observed bytes"),
      writeFile(
        path.join(secondObserved, "second.wav"),
        "second observed bytes",
      ),
    ]);
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const productId = /product_id=(RJ\d+)/u.exec(address)?.[1];
      if (productId !== undefined) {
        return new Response(
          JSON.stringify({
            [productId]: {
              site_id: "maniax",
              work_name: `Work ${productId}`,
              regist_date: "2026-08-01",
              maker_id: "RG123",
              maker_name: "Circle",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        '<a href="maker_id/RG123.html"><span>Circle</span></a>',
        {
          headers: { "content-type": "text/html" },
        },
      );
    });
    const workflow = composeAssetRefresh(productData, {});
    const requirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [{ property: "asset.title", necessity: "required" as const }],
      relationshipTypes: [],
      artifactRoles: [],
    };

    try {
      const first = await scanRegisteredScope(workflow, firstObserved, {
        acceptTrusted: true,
        informationRequirement: requirement,
      });
      const second = await scanRegisteredScope(workflow, secondObserved, {
        acceptTrusted: true,
        informationRequirement: requirement,
      });
      const firstAssetId = first.accepted?.entity.id;
      const secondAssetId = second.accepted?.entity.id;
      const circleId = first.accepted?.currentRelatedEntities?.find(
        (entity) => entity.sourceKey === "RG123",
      )?.id;
      if (
        firstAssetId === undefined ||
        secondAssetId === undefined ||
        circleId === undefined
      )
        throw new Error("DLsite 的正式采用没有产生两项作品和来源社团");

      const circle = await workflow.inspectCurrentCatalogueEntity(circleId);
      const firstWork =
        await workflow.inspectCurrentCatalogueSubject(firstAssetId);
      const secondWork =
        await workflow.inspectCurrentCatalogueSubject(secondAssetId);
      const circleRelationshipIds = circle?.relationships.map(({ id }) => id);
      const firstCircleRelationshipId = firstWork?.relationships.find(
        (relationship) =>
          relationship.participants.some(
            (participant) => participant.entityId === circleId,
          ),
      )?.id;
      const secondCircleRelationshipId = secondWork?.relationships.find(
        (relationship) =>
          relationship.participants.some(
            (participant) => participant.entityId === circleId,
          ),
      )?.id;
      expect(circle?.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            participants: expect.arrayContaining([
              { entityId: circleId, role: "circle" },
            ]),
          }),
        ]),
      );
      expect(circle?.accepted.map(({ id }) => id)).toEqual(
        expect.arrayContaining([firstAssetId, secondAssetId]),
      );
      expect(circleRelationshipIds).toContain(firstCircleRelationshipId);
      expect(circleRelationshipIds).toContain(secondCircleRelationshipId);
      expect(circleRelationshipIds).toHaveLength(2);
    } finally {
      await workflow.close();
    }
  });

  it("stops one deduplicated fulfillment child at its next SQLite checkpoint and recovers it with a replacement Host", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-hosted-fulfillment-"),
    );
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
    let releaseImage!: () => void;
    const imageRelease = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    let markImageStarted!: () => void;
    const imageStarted = new Promise<void>((resolve) => {
      markImageStarted = resolve;
    });
    let imageRequests = 0;
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
              work_name: "Hosted fulfillment",
              regist_date: "2026-08-01",
              work_image: "//img.dlsite.jp/hosted.jpg",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (address === "https://img.dlsite.jp/hosted.jpg") {
        imageRequests += 1;
        markImageStarted();
        await imageRelease;
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const coverRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [],
      relationshipTypes: [],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
    };
    const runtime = composeAssetRefreshRuntime(productData, {
      configuration: {},
    });
    let replacement: ReturnType<typeof composeAssetRefreshRuntime> | undefined;
    try {
      const recognized = await scanRegisteredScope(runtime.workflow, observed, {
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.title", necessity: "required" }],
          relationshipTypes: [],
          artifactRoles: [],
        },
      });
      const subjectId = recognized.accepted?.entity.id;
      if (subjectId === undefined) throw new Error("subject was not accepted");
      const invoke = vi.spyOn(runtime.executionHost, "invoke");
      const first = await runtime.workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: coverRequirement,
      });
      const executionId =
        first.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId;
      expect(executionId).toEqual(expect.any(String));
      await imageStarted;

      const duplicate = await runtime.workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: coverRequirement,
      });
      expect(
        duplicate.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId,
      ).toBe(executionId);
      expect(invoke).toHaveBeenCalledTimes(1);

      const hostClose = runtime.executionHost.close();
      await expect(runtime.workflow.close()).resolves.toBeUndefined();
      let hostClosed = false;
      void hostClose.then(() => {
        hostClosed = true;
      });
      await Promise.resolve();
      expect(hostClosed).toBe(false);
      releaseImage();
      await expect(hostClose).resolves.toBeUndefined();
      await expect(
        runtime.workflow.inspect(executionId!),
      ).resolves.toMatchObject({
        execution: {
          status: "running",
          stage: "source-artifacts-acquired",
        },
      });
      expect(imageRequests).toBe(1);

      await runtime.close();
      replacement = composeAssetRefreshRuntime(productData, {
        configuration: {},
      });
      await expect(
        replacement.workflow.inspect(executionId!),
      ).resolves.toMatchObject({
        execution: {
          workflowInput: {
            operation: {
              version: "information-fulfillment-operation/2",
              kind: "source-artifact-acquisition",
              subjectId,
              sourceIdentity: "dlsite",
            },
          },
        },
      });
      await replacement.automationHost.start();
      const recovered = await waitForTerminalExecution(
        replacement.workflow,
        executionId!,
      );
      expect(recovered.execution.reason).toBeUndefined();
      expect(recovered.execution).toMatchObject({
        status: "completed",
        outcome: "accepted",
      });
      expect(imageRequests).toBe(1);
    } finally {
      releaseImage();
      await runtime.close();
      await replacement?.close();
    }
  });

  it("attributes automatic metadata fulfillment to its parent execution instead of an interactive refresh", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-automatic-metadata-fulfillment-"),
    );
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
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
              work_name: "Exact work",
              regist_date: "2026-08-01",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const missingIntroduction = {
      metadataUsageContext: "asset.ordinary",
      metadata: [
        { property: "asset.introduction", necessity: "required" as const },
      ],
      relationshipTypes: [],
      artifactRoles: [],
    };
    const workflow = composeAssetRefresh(
      productData,
      {},
      {
        automationInformationRequirementForAcceptedSubject: {
          coordinate: "composition-introduction-test/1",
          requirementForAcceptedSubject: () => missingIntroduction,
        },
      },
    );

    try {
      const automationRoot = await authorizeDirectory(
        workflow,
        "自动刷新测试",
        observed,
      );
      const automated = await workflow.enableAutomation({
        assetLibraryId: automationRoot.libraryId,
        observedRootId: automationRoot.rootId,
        relativeScope: ".",
        intervalMilliseconds: 60_000,
        acceptTrusted: true,
      });
      const parent = automated.initial?.execution;
      const subjects =
        parent === undefined
          ? []
          : await workflow.acceptedSubjectsOfLibraryScan(parent.execution.id);
      expect(subjects).toHaveLength(1);
      const subjectId = subjects[0]?.subjectId;
      if (parent === undefined || subjectId === undefined)
        throw new Error(
          "automatic recognition did not retain an accepted subject",
        );

      const child = (await workflow.listInspections()).find(
        (inspection) =>
          inspection.execution.operationKind === "refresh-metadata" &&
          inspection.execution.requestedSelection?.subjects.some(
            (subject) => subject.subjectId === subjectId,
          ) === true,
      );
      expect(child?.execution.workflowInput).toMatchObject({
        trigger: "information-fulfillment",
        initiatedBy: `information-fulfillment:${parent.execution.id}:${subjectId}`,
      });
    } finally {
      await workflow.close();
    }
  });

  it("atomically supersedes a refreshed source cover within its source association", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-latest-artifact-"));
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
    let currentImage: "old" | "new" = "old";
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push(address);
      if (address.includes("/product/info/ajax")) {
        return new Response(
          JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "Exact work",
              regist_date: "2026-08-01",
              work_image: `//img.dlsite.jp/${currentImage}.jpg`,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (
        address === "https://img.dlsite.jp/old.jpg" ||
        address === "https://img.dlsite.jp/new.jpg"
      ) {
        return new Response(new Uint8Array([4, 3, 2, 1]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const coverRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [],
      relationshipTypes: [],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
    };
    let workflow = composeAssetRefresh(productData, {});
    const verifier = SqliteCatalogue.forProductData(productData);

    try {
      const library = await workflow.assetLibraries.save({
        displayName: "来源封面库",
        directories: [observed],
        recognitionProfileIds: ["dlsite-voice"],
        sourceIdentities: ["dlsite"],
      });
      const recognized = await workflow.scanObservedScope({
        registrationId: library.rootIds[0]!,
        relativeScope: ".",
        acceptTrusted: true,
        informationRequirement: coverRequirement,
      });
      expect(recognized.itemResults).toHaveLength(1);
      const subjectId = recognized.itemResults![0]!.accepted!.entity.id;
      if (subjectId === undefined)
        throw new Error(
          `DLsite subject was not accepted: ${JSON.stringify(recognized)}`,
        );
      const before = await verifier.findAcceptedForSubjects([subjectId]);
      const recognitionDecisionId = before[0]?.accepted.recognitionDecision.id;
      const recognitionProposalId = before[0]?.accepted.proposal.id;
      const sourceAssociationId = before[0]?.accepted.sourceAssociations.find(
        (association) => association.sourceIdentity === "dlsite",
      )?.id;
      if (
        recognitionDecisionId === undefined ||
        recognitionProposalId === undefined ||
        sourceAssociationId === undefined
      )
        throw new Error("DLsite recognition identity was not retained");
      const oldAssociationId = before[0]?.accepted.artifactAssociations.find(
        (association) => association.role === "asset.primary-cover",
      )?.id;
      expect(oldAssociationId).toEqual(expect.any(String));
      expect(requested).toContain("https://img.dlsite.jp/old.jpg");

      const initialCovers = await workflow.inspectArtifactRoleCovers({
        entityId: subjectId,
      });
      const selectedReference = initialCovers.candidates[0]!.reference;
      const manual = await workflow.prepareArtifactRoleDecision({
        entityId: subjectId,
        initiatedBy: "测试使用者",
        candidateReference: selectedReference,
      });
      await workflow.applyChangeImpactPreview({
        previewId: manual.id,
        confirmedBy: "测试使用者",
      });
      const metadataOnly = await workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        assetLibraryId: library.id,
        requirement: {
          ...coverRequirement,
          artifactRoles: [],
          relationshipTypes: [
            { type: "asset.membership", necessity: "optional" },
          ],
        },
      });
      const unchanged = await waitForTerminalExecution(
        workflow,
        metadataOnly.subjects[0]!.inputs[0]!.executionReferences![0]!
          .workflowExecutionId,
      );
      expect(
        unchanged.sourceRefreshRuns!.every((run) =>
          run.scopes.every((scope) => scope.outcome === "unchanged"),
        ),
      ).toBe(true);
      const retainedCovers = await workflow.inspectArtifactRoleCovers({
        entityId: subjectId,
      });
      expect(retainedCovers.decision).toEqual({
        kind: "select",
        reference: selectedReference,
      });
      expect(retainedCovers.effectiveReference).toBe(selectedReference);
      expect(
        requested.filter(
          (address) => address === "https://img.dlsite.jp/old.jpg",
        ),
      ).toHaveLength(1);

      await workflow.close();
      workflow = composeAssetRefresh(productData, {});
      expect(
        (await workflow.inspectArtifactRoleCovers({ entityId: subjectId }))
          .decision,
      ).toEqual({ kind: "select", reference: selectedReference });

      currentImage = "new";
      const refreshed = await workflow.refreshMetadata({
        selection: {
          version: "asset-refresh-selection/1",
          subjects: [
            {
              subjectId,
              explanations: [{ path: ["test", subjectId] }],
            },
          ],
          filesystemScopes: [],
        },
        informationRequirement: coverRequirement,
      });
      const refreshedRecordId = refreshed.sourceRefreshRuns?.flatMap((run) =>
        run.scopes.flatMap((scope) =>
          scope.candidateSourceRecordId === undefined
            ? []
            : [scope.candidateSourceRecordId],
        ),
      )[0];
      expect(refreshedRecordId).toEqual(expect.any(String));
      expect(requested).not.toContain("https://img.dlsite.jp/new.jpg");

      const [staleFacts] = await verifier.readCurrentInformationSubjectFacts({
        subjectIds: [subjectId],
      });
      // 来源刷新已结束旧支持；历史关联仍保留，但共同生效读取不再把它当当前封面。
      expect(
        staleFacts?.basis.artifactAssociations.some(
          (association) => association.id === oldAssociationId,
        ),
      ).toBe(false);
      expect(
        staleFacts?.sourceArtifactCurrency.some(
          (item) => item.associationId === oldAssociationId && item.current,
        ),
      ).toBe(false);
      const historicalLedger = new DatabaseSync(
        path.join(productData, "catalogue.sqlite"),
      );
      try {
        expect(
          historicalLedger
            .prepare(
              "SELECT id, source_association_id FROM artifact_associations WHERE id = ?",
            )
            .get(oldAssociationId!),
        ).toMatchObject({
          id: oldAssociationId,
          source_association_id: sourceAssociationId,
        });
      } finally {
        historicalLedger.close();
      }

      expect(
        (await workflow.inspectArtifactRoleCovers({ entityId: subjectId }))
          .decision,
      ).toEqual({ kind: "select" });
      const readiness = await workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: coverRequirement,
      });
      const executionId =
        readiness.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId;
      expect(executionId).toEqual(expect.any(String));
      const completed = await waitForTerminalExecution(workflow, executionId!);
      const after = await verifier.findAcceptedForSubjects([subjectId]);
      const newAssociationId = completed?.accepted?.artifactAssociations.find(
        (association) => association.role === "asset.primary-cover",
      )?.id;
      expect(completed?.execution.reason).toBeUndefined();
      expect(completed?.execution).toMatchObject({ status: "completed" });
      expect(newAssociationId).toEqual(expect.any(String));
      expect(completed?.accepted).toMatchObject({
        artifactAssociations: expect.arrayContaining([
          expect.objectContaining({
            target: { kind: "entity", entityId: subjectId },
            role: "asset.primary-cover",
            sourceRecordIds: [refreshedRecordId],
            sourceAssociationId,
          }),
        ]),
      });
      expect(after[0]?.accepted.recognitionDecision.id).toBe(
        recognitionDecisionId,
      );
      expect(after[0]?.accepted.proposal.id).toBe(recognitionProposalId);
      expect(
        requested.filter(
          (address) => address === "https://img.dlsite.jp/new.jpg",
        ),
      ).toHaveLength(1);

      const ledger = new DatabaseSync(
        path.join(productData, "catalogue.sqlite"),
      );
      try {
        expect(
          ledger
            .prepare(
              `SELECT aa.id, aa.source_association_id, aa.source_record_ids_json
               FROM artifact_associations aa
               WHERE aa.subject_id = ? AND aa.role = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM artifact_association_supersessions s
                   WHERE s.predecessor_association_id = aa.id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM artifact_association_retractions r
                   WHERE r.association_id = aa.id
                 )`,
            )
            .all(subjectId, "asset.primary-cover"),
        ).toEqual([
          {
            id: newAssociationId,
            source_association_id: sourceAssociationId,
            source_record_ids_json: JSON.stringify([refreshedRecordId]),
          },
        ]);
        expect(
          ledger
            .prepare(
              `SELECT predecessor.id AS predecessor_id, successor.id AS successor_id
               FROM artifact_association_supersessions transition
               JOIN artifact_associations predecessor
                 ON predecessor.id = transition.predecessor_association_id
               JOIN artifact_associations successor
                 ON successor.id = transition.successor_association_id
               WHERE predecessor.subject_id = ? AND predecessor.role = ?`,
            )
            .all(subjectId, "asset.primary-cover"),
        ).toEqual([
          {
            predecessor_id: oldAssociationId,
            successor_id: newAssociationId,
          },
        ]);
      } finally {
        ledger.close();
      }
    } finally {
      await workflow.close();
      verifier.close();
    }
  });

  it("reconciles a no-image primary-cover acquisition after its durable execution reaches terminal state", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-no-image-readiness-"),
    );
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
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
              work_name: "Exact work",
              regist_date: "2026-08-01",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const coverRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [],
      relationshipTypes: [],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
    };
    const optionalCoverRequirement = {
      ...coverRequirement,
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "optional" as const,
          maximum: 1,
        },
      ],
    };
    const workflow = composeAssetRefresh(productData, {});

    try {
      const recognized = await scanRegisteredScope(workflow, observed, {
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.title", necessity: "required" }],
          relationshipTypes: [],
          artifactRoles: [],
        },
      });
      const subjectId = recognized.accepted?.entity.id;
      if (subjectId === undefined)
        throw new Error("DLsite subject was not accepted");
      const refreshed = await workflow.refreshMetadata({
        selection: {
          version: "asset-refresh-selection/1",
          subjects: [
            {
              subjectId,
              explanations: [{ path: ["test", subjectId] }],
            },
          ],
          filesystemScopes: [],
        },
        informationRequirement: coverRequirement,
      });
      expect(refreshed.sourceRefreshRuns).toEqual([
        expect.objectContaining({ phase: "terminal", outcome: "succeeded" }),
      ]);

      const pending = await workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: coverRequirement,
      });
      const executionId =
        pending.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId;
      expect(executionId).toEqual(expect.any(String));
      await expect(
        waitForTerminalExecution(workflow, executionId!),
      ).resolves.toMatchObject({
        execution: {
          status: "failed",
          reason: "缺少必需的产物角色：asset.primary-cover",
        },
      });
      const executionsBeforeReconciliation = await workflow.listInspections();

      await expect(
        workflow.fulfillInformation({
          selection: { subjectIds: [subjectId] },
          requirement: coverRequirement,
        }),
      ).resolves.toMatchObject({
        subjects: [
          {
            status: "unavailable",
            inputs: [
              expect.objectContaining({
                status: "unavailable",
                reason: "当前来源未提供所需信息",
                executionReferences: [{ workflowExecutionId: executionId }],
              }),
            ],
          },
        ],
      });
      await expect(workflow.listInspections()).resolves.toHaveLength(
        executionsBeforeReconciliation.length,
      );

      const optionalPending = await workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: optionalCoverRequirement,
      });
      const optionalExecutionId =
        optionalPending.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId;
      expect(optionalExecutionId).toEqual(expect.any(String));
      await expect(
        waitForTerminalExecution(workflow, optionalExecutionId!),
      ).resolves.toMatchObject({ execution: { status: "failed" } });
      await expect(
        workflow.fulfillInformation({
          selection: { subjectIds: [subjectId] },
          requirement: optionalCoverRequirement,
        }),
      ).resolves.toMatchObject({
        subjects: [
          {
            status: "available",
            inputs: [
              expect.objectContaining({
                status: "unavailable",
                executionReferences: [
                  { workflowExecutionId: optionalExecutionId },
                ],
              }),
            ],
          },
        ],
      });
    } finally {
      await workflow.close();
    }
  });

  it("keeps readiness pending while a source refresh awaits review, then reconciles its rejected terminal run", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-review-readiness-"),
    );
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
    let includesLanguage = true;
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
              work_name: "Exact work",
              regist_date: "2026-08-01",
              ...(includesLanguage ? { work_lang: "Japanese" } : {}),
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const missingIntroduction = {
      metadataUsageContext: "asset.ordinary",
      metadata: [
        { property: "asset.introduction", necessity: "required" as const },
      ],
      relationshipTypes: [],
      artifactRoles: [],
    };
    const workflow = composeAssetRefresh(productData, {});

    try {
      const recognized = await scanRegisteredScope(workflow, observed, {
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.title", necessity: "required" }],
          relationshipTypes: [],
          artifactRoles: [],
        },
      });
      const subjectId = recognized.accepted?.entity.id;
      if (subjectId === undefined)
        throw new Error("DLsite subject was not accepted");

      includesLanguage = false;
      const initial = await workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: missingIntroduction,
      });
      const executionId =
        initial.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId;
      expect(executionId).toEqual(expect.any(String));
      await expect(workflow.inspect(executionId!)).resolves.toMatchObject({
        execution: {
          workflowInput: {
            trigger: "information-fulfillment",
            initiatedBy: "information-fulfillment",
          },
        },
      });
      const reviewing = await waitForSourceRefreshPhase(
        workflow,
        executionId!,
        "reviewing",
      );
      const pendingChangeSet = reviewing.sourceRefreshRuns?.flatMap((run) =>
        run.changeSets.filter(
          (changeSet) => changeSet.disposition === "pending",
        ),
      )[0];
      expect(pendingChangeSet).toMatchObject({
        requiresReview: true,
        disposition: "pending",
      });

      await expect(
        workflow.fulfillInformation({
          selection: { subjectIds: [subjectId] },
          requirement: missingIntroduction,
        }),
      ).resolves.toMatchObject({
        subjects: [
          {
            status: "pending",
            inputs: [
              expect.objectContaining({
                executionReferences: [{ workflowExecutionId: executionId }],
              }),
            ],
          },
        ],
      });

      const runId = reviewing.sourceRefreshRuns?.[0]?.id;
      expect(runId).toEqual(expect.any(String));
      await workflow.reviewSourceRefreshChangeSet({
        runId: runId!,
        changeSetId: pendingChangeSet!.id,
        disposition: "rejected",
      });
      await expect(
        waitForTerminalExecution(workflow, executionId!),
      ).resolves.toMatchObject({
        execution: { status: "completed", outcome: "partially-succeeded" },
        sourceRefreshRuns: [
          expect.objectContaining({
            phase: "terminal",
            outcome: "partially-succeeded",
          }),
        ],
      });
      const executionCount = (await workflow.listInspections()).length;

      await expect(
        workflow.fulfillInformation({
          selection: { subjectIds: [subjectId] },
          requirement: missingIntroduction,
        }),
      ).resolves.toMatchObject({
        subjects: [
          {
            status: "unavailable",
            inputs: [expect.objectContaining({ status: "unavailable" })],
          },
        ],
      });
      await expect(workflow.listInspections()).resolves.toHaveLength(
        executionCount,
      );
    } finally {
      await workflow.close();
    }
  });

  it("reconciles a failed terminal source refresh as blocked with a sanitized durable reason", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-failed-refresh-readiness-"),
    );
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
    let failRefresh = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (address.includes("/product/info/ajax")) {
        if (failRefresh)
          throw new Error("Authorization: Bearer private-refresh-token");
        return new Response(
          JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "Exact work",
              regist_date: "2026-08-01",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const missingIntroduction = {
      metadataUsageContext: "asset.ordinary",
      metadata: [
        { property: "asset.introduction", necessity: "required" as const },
      ],
      relationshipTypes: [],
      artifactRoles: [],
    };
    const workflow = composeAssetRefresh(productData, {});

    try {
      const recognized = await scanRegisteredScope(workflow, observed, {
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.title", necessity: "required" }],
          relationshipTypes: [],
          artifactRoles: [],
        },
      });
      const subjectId = recognized.accepted?.entity.id;
      if (subjectId === undefined)
        throw new Error("DLsite subject was not accepted");

      failRefresh = true;
      const pending = await workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: missingIntroduction,
      });
      const executionId =
        pending.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId;
      expect(executionId).toEqual(expect.any(String));
      await expect(
        waitForTerminalExecution(workflow, executionId!, {
          timeoutMilliseconds: 2_000,
        }),
      ).resolves.toMatchObject({
        execution: { status: "failed" },
        sourceRefreshRuns: [
          expect.objectContaining({ phase: "terminal", outcome: "failed" }),
        ],
      });
      const executionCount = (await workflow.listInspections()).length;

      await expect(
        workflow.fulfillInformation({
          selection: { subjectIds: [subjectId] },
          requirement: missingIntroduction,
        }),
      ).resolves.toMatchObject({
        subjects: [
          {
            status: "blocked",
            inputs: [
              expect.objectContaining({
                status: "blocked",
                reason:
                  "DLsite official source request failed: Authorization: [redacted]",
              }),
            ],
          },
        ],
      });
      await expect(workflow.listInspections()).resolves.toHaveLength(
        executionCount,
      );
    } finally {
      await workflow.close();
    }
  });

  it("fulfills a missing cover through the durable composed Asset Refresh path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "digital-fulfillment-"));
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push(address);
      if (address.includes("/product/info/ajax")) {
        return new Response(
          JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "Exact work",
              regist_date: "2026-08-01",
              work_image: "//img.dlsite.jp/primary.jpg",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (address === "https://img.dlsite.jp/primary.jpg") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const coverRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [],
      relationshipTypes: [],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
    };
    const mixedRequirement = {
      ...coverRequirement,
      metadata: [
        { property: "asset.declared-language", necessity: "optional" as const },
      ],
    };
    const workflow = composeAssetRefresh(
      productData,
      {},
      {
        automationInformationRequirementForAcceptedSubject: {
          coordinate: "composition-cover-test/1",
          requirementForAcceptedSubject: () => coverRequirement,
        },
      },
    );

    try {
      const recognized = await scanRegisteredScope(workflow, observed, {
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.title", necessity: "required" }],
          relationshipTypes: [],
          artifactRoles: [],
        },
      });
      const subjectId = recognized.accepted?.entity.id;
      if (subjectId === undefined)
        throw new Error(
          `DLsite subject was not accepted: ${JSON.stringify(recognized)}`,
        );
      expect(requested).not.toContain("https://img.dlsite.jp/primary.jpg");

      const readiness = await workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: mixedRequirement,
      });
      const metadataExecutionId = readiness.subjects[0]?.inputs.find(
        (input) => input.kind === "metadata",
      )?.executionReferences?.[0]?.workflowExecutionId;
      const artifactExecutionId = readiness.subjects[0]?.inputs.find(
        (input) => input.kind === "artifact-role",
      )?.executionReferences?.[0]?.workflowExecutionId;
      expect(readiness.subjects[0]).toMatchObject({ status: "pending" });
      expect(metadataExecutionId).toEqual(expect.any(String));
      expect(artifactExecutionId).toEqual(expect.any(String));

      const [refreshed, completed] = await Promise.all([
        waitForTerminalExecution(workflow, metadataExecutionId!),
        waitForTerminalExecution(workflow, artifactExecutionId!),
      ]);
      expect(refreshed).toMatchObject({
        execution: { id: metadataExecutionId, status: "completed" },
        sourceRefreshRuns: [
          expect.objectContaining({ outcome: "succeeded", phase: "terminal" }),
        ],
      });
      expect(completed).toMatchObject({
        execution: { id: artifactExecutionId, status: "completed" },
        accepted: {
          artifactAssociations: expect.arrayContaining([
            expect.objectContaining({
              target: { kind: "entity", entityId: subjectId },
              role: "asset.primary-cover",
              sourceRecordIds: [expect.any(String)],
            }),
          ]),
        },
      });
      expect(requested).toContain("https://img.dlsite.jp/primary.jpg");

      const executionCount = (await workflow.listInspections()).length;
      const reused = await workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: coverRequirement,
      });
      expect(reused.subjects[0]).toMatchObject({
        status: "available",
        inputs: [{ status: "available" }],
      });
      expect(await workflow.listInspections()).toHaveLength(executionCount);

      const automationRoot = await authorizeDirectory(
        workflow,
        "自动刷新测试",
        observed,
      );
      const automatic = await workflow.enableAutomation({
        assetLibraryId: automationRoot.libraryId,
        observedRootId: automationRoot.rootId,
        relativeScope: ".",
        intervalMilliseconds: 60_000,
        acceptTrusted: true,
      });
      expect(automatic.intent).not.toHaveProperty("informationRequirement");
      expect(automatic.initial).toMatchObject({
        status: "started",
        execution: {
          execution: { status: "completed", outcome: "no-change" },
        },
      });
      expect(
        requested.filter(
          (address) => address === "https://img.dlsite.jp/primary.jpg",
        ),
      ).toHaveLength(1);
      expect(
        await workflow.acceptedSubjectsOfLibraryScan(
          automatic.initial!.execution.execution.id,
        ),
      ).toEqual([expect.objectContaining({ subjectId })]);
      expect(await workflow.listInspections()).toHaveLength(executionCount + 2);
    } finally {
      await workflow.close();
    }
  });

  it("retains an initially accepted source-artifact candidate for a later cover-only request", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-initial-source-artifact-lineage-"),
    );
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push(address);
      if (address.includes("/product/info/ajax")) {
        return new Response(
          JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "Initial candidate work",
              regist_date: "2026-08-01",
              work_image: "//img.dlsite.jp/initial.jpg",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (address === "https://img.dlsite.jp/initial.jpg") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const titleRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [{ property: "asset.title", necessity: "required" as const }],
      relationshipTypes: [],
      artifactRoles: [],
    };
    const coverRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [],
      relationshipTypes: [],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
    };
    const workflow = composeAssetRefresh(productData, {});
    const verifier = SqliteCatalogue.forProductData(productData);

    try {
      const recognized = await scanRegisteredScope(workflow, observed, {
        acceptTrusted: true,
        informationRequirement: titleRequirement,
      });
      const subjectId = recognized.accepted?.entity.id;
      if (subjectId === undefined)
        throw new Error("DLsite subject was not accepted");
      const persisted = await verifier.findAcceptedForSubjects([subjectId]);
      const sourceAssociationId =
        persisted[0]?.accepted.sourceAssociations.find(
          (association) => association.sourceIdentity === "dlsite",
        )?.id;
      if (sourceAssociationId === undefined)
        throw new Error("DLsite source association was not retained");
      expect(requested).not.toContain("https://img.dlsite.jp/initial.jpg");

      // 在任何来源刷新前，当前持久候选谱系来自初始已接受解释，而不是读取识别提案。
      await expect(
        verifier.readCurrentSourceArtifactFacts({
          subjectId,
          sourceIdentity: "dlsite",
          sourceAssociationId,
        }),
      ).resolves.toMatchObject({
        sourceAssociation: { id: sourceAssociationId },
        candidates: [
          expect.objectContaining({
            candidate: expect.objectContaining({
              role: "asset.primary-cover",
              acquisitionReference: "https://img.dlsite.jp/initial.jpg",
            }),
          }),
        ],
      });

      const readiness = await workflow.fulfillInformation({
        selection: { subjectIds: [subjectId] },
        requirement: coverRequirement,
      });
      const executionId =
        readiness.subjects[0]?.inputs[0]?.executionReferences?.[0]
          ?.workflowExecutionId;
      expect(readiness.subjects[0]).toMatchObject({ status: "pending" });
      expect(executionId).toEqual(expect.any(String));
      await expect(
        waitForTerminalExecution(workflow, executionId!),
      ).resolves.toMatchObject({
        execution: { id: executionId, status: "completed" },
        accepted: {
          artifactAssociations: expect.arrayContaining([
            expect.objectContaining({
              target: { kind: "entity", entityId: subjectId },
              role: "asset.primary-cover",
            }),
          ]),
        },
      });
      expect(requested).toContain("https://img.dlsite.jp/initial.jpg");
      expect(
        requested.filter((address) => address.includes("/product/info/ajax")),
      ).toHaveLength(1);
    } finally {
      await workflow.close();
      verifier.close();
    }
  });

  it("does not treat an observed-only delivered association as fulfillment-ready", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-observed-readiness-"),
    );
    temporaryRoots.push(root);
    const productData = path.join(root, "product-data");
    await prepareCatalogueAt(productData);
    const observed = path.join(root, "RJ01668691");
    await mkdir(observed);
    await writeFile(path.join(observed, "track.wav"), "observed bytes");
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
              work_name: "Exact work",
              regist_date: "2026-08-01",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const deliveredRequirement = {
      metadataUsageContext: "asset.ordinary",
      metadata: [],
      relationshipTypes: [],
      artifactRoles: [
        {
          role: "asset.material-delivered",
          necessity: "required" as const,
          maximum: 1,
        },
      ],
    };
    const workflow = composeAssetRefresh(productData, {});
    const verifier = SqliteCatalogue.forProductData(productData);

    try {
      const recognized = await scanRegisteredScope(workflow, observed, {
        acceptTrusted: true,
        informationRequirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.title", necessity: "required" }],
          relationshipTypes: [],
          artifactRoles: [],
        },
      });
      const subjectId = recognized.accepted?.entity.id;
      if (subjectId === undefined)
        throw new Error("DLsite subject was not accepted");
      expect(recognized.accepted?.artifactAssociations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: { kind: "entity", entityId: subjectId },
            role: "asset.material-delivered",
          }),
        ]),
      );

      const [facts] = await verifier.readCurrentInformationSubjectFacts({
        subjectIds: [subjectId],
      });
      expect(facts?.basis.artifactAssociations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: { kind: "entity", entityId: subjectId },
            role: "asset.material-delivered",
          }),
        ]),
      );
      const delivered = facts!.basis.artifactAssociations.filter(
        (association) => association.role === "asset.material-delivered",
      );
      expect(
        facts!.basis.locations.filter(
          (location) =>
            location.kind === "managed" &&
            delivered.some(
              (association) => association.artifactId === location.artifactId,
            ),
        ),
      ).toEqual([]);

      await expect(
        workflow.fulfillInformation({
          selection: { subjectIds: [subjectId] },
          requirement: deliveredRequirement,
        }),
      ).resolves.toMatchObject({
        subjects: [
          {
            subjectId,
            status: "unavailable",
            inputs: [
              expect.objectContaining({
                kind: "artifact-role",
                coordinate: "asset.material-delivered",
                status: "unavailable",
              }),
            ],
          },
        ],
      });
    } finally {
      await workflow.close();
      verifier.close();
    }
  });

  it("plans a DLsite primary-cover acquisition only when the neutral requirement asks for that role", async () => {
    const starts: unknown[] = [];
    const fulfillment = new InformationFulfillment({
      async readSubjects() {
        return [
          {
            subjectId: "work",
            metadata: [],
            relationships: [],
            artifactAssociations: [],
            sourceAssociations: [{ sourceIdentity: "dlsite" }],
          },
        ];
      },
      capabilities: dlsiteInformationFulfillmentCapabilities,
      async start(plan) {
        starts.push(plan);
        return {
          status: "pending",
          workflowExecutionId: `execution-${plan.operation}`,
        };
      },
    });

    const readiness = await fulfillment.fulfill({
      selection: { subjectIds: ["work"] },
      requirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.title", necessity: "required" }],
        relationshipTypes: [],
        artifactRoles: [
          {
            role: "asset.primary-cover",
            necessity: "optional",
            maximum: 1,
          },
        ],
      },
    });

    expect(starts).toEqual([
      expect.objectContaining({
        sourceIdentity: "dlsite",
        operation: "source-refresh",
        requirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [{ property: "asset.title", necessity: "required" }],
          relationshipTypes: [],
          artifactRoles: [],
        },
      }),
      expect.objectContaining({
        sourceIdentity: "dlsite",
        operation: "source-artifact-acquisition",
        requirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [],
          relationshipTypes: [],
          artifactRoles: [
            {
              role: "asset.primary-cover",
              necessity: "optional",
              maximum: 1,
            },
          ],
        },
      }),
    ]);
    expect(readiness.subjects[0]).toMatchObject({ status: "pending" });
  });

  it("does not trigger the DLsite artifact acquirer when the same subject requirement omits the role", async () => {
    const starts: unknown[] = [];
    const fulfillment = new InformationFulfillment({
      async readSubjects() {
        return [
          {
            subjectId: "work",
            metadata: [],
            relationships: [],
            artifactAssociations: [],
            sourceAssociations: [{ sourceIdentity: "dlsite" }],
          },
        ];
      },
      capabilities: dlsiteInformationFulfillmentCapabilities,
      async start(plan) {
        starts.push(plan);
        return { status: "pending", workflowExecutionId: "execution-refresh" };
      },
    });

    await fulfillment.fulfill({
      selection: { subjectIds: ["work"] },
      requirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.title", necessity: "required" }],
        relationshipTypes: [],
        artifactRoles: [],
      },
    });

    expect(starts).toEqual([
      expect.objectContaining({ operation: "source-refresh" }),
    ]);
  });
});

async function waitForTerminalExecution(
  workflow: ReturnType<typeof composeAssetRefresh>,
  executionId: string,
  options: { readonly timeoutMilliseconds?: number } = {},
) {
  const deadline = Date.now() + (options.timeoutMilliseconds ?? 1_000);
  let latest: Awaited<ReturnType<typeof workflow.inspect>>;
  while (Date.now() < deadline) {
    latest = await workflow.inspect(executionId);
    if (latest?.execution.status !== "running") return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `fulfillment execution did not become terminal: ${JSON.stringify(latest)}`,
  );
}

async function waitForSourceRefreshPhase(
  workflow: ReturnType<typeof composeAssetRefresh>,
  executionId: string,
  phase: "reviewing",
) {
  let latest: Awaited<ReturnType<typeof workflow.inspect>>;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await workflow.inspect(executionId);
    if (latest?.sourceRefreshRuns?.some((run) => run.phase === phase))
      return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `fulfillment Source Refresh Run did not reach ${phase}: ${JSON.stringify(latest)}`,
  );
}
