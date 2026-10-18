import type {
  AssetRefreshInspection,
  LibraryScanInspectionDetail,
} from "@digital/application";
import { ExecutionHost } from "@digital/application";
import { expect, it, vi } from "vitest";

import { createProductRefreshOperations } from "../src/index.ts";

type RefreshWorkflow = Parameters<typeof createProductRefreshOperations>[0];

it("库扫描通过唯一父执行身份启动并采用有限产品信息需求", async () => {
  let observed: Record<string, unknown> | undefined;
  const workflow = {
    async scanAssetLibrary(input: Record<string, unknown>) {
      observed = input;
      (
        input.onExecutionStarted as
          | ((execution: { id: string }) => void)
          | undefined
      )?.({
        id: "parent-execution",
      });
      return { parentExecutionId: "parent-execution" };
    },
  };
  const execution = new ExecutionHost();
  const operations = createProductRefreshOperations(
    workflow as unknown as RefreshWorkflow,
    execution,
  );

  await expect(
    operations.startLibraryScan({ libraryId: "library-fixture" }),
  ).resolves.toEqual({ id: "parent-execution" });
  const requirement = observed?.informationRequirement as
    | { metadata: readonly { property: string }[] }
    | undefined;
  expect(requirement?.metadata.map(({ property }) => property)).toContain(
    "asset.title",
  );
  expect(requirement?.metadata.map(({ property }) => property)).not.toContain(
    "*",
  );
  await execution.close();
});

it("按已接受主体的来源事实选择重新刮削和元数据刷新需求", async () => {
  const rescrape = vi.fn(async (input: Record<string, unknown>) => {
    (
      input.onExecutionStarted as
        | ((execution: { id: string }) => void)
        | undefined
    )?.({
      id: "rescrape-execution",
    });
    return {};
  });
  const refresh = vi.fn(async (input: Record<string, unknown>) => {
    (
      input.onExecutionStarted as
        | ((execution: { id: string }) => void)
        | undefined
    )?.({
      id: "metadata-execution",
    });
    return {};
  });
  const workflow = {
    async inspectRefreshTarget() {
      return {
        subjectId: "subject-fixture",
        filesystemScope: {
          observedRootId: "root-fixture",
          relativeScope: "publication",
        },
        sourceAssociations: [],
        recognitionSourceAssociation: {
          sourceIdentity: "dlsite",
          nativeAddress: "https://example.invalid/work/RJ01668691",
        },
      };
    },
    async inspectCurrentCatalogueSubject() {
      return {
        id: "subject-fixture",
        sourceAssociations: [
          {
            sourceIdentity: "dlsite",
            nativeAddress: "https://example.invalid/work/RJ01668691",
          },
        ],
        descriptions: [],
        locations: [],
      };
    },
    rescrapeCurrentObservedScope: rescrape,
    refreshMetadata: refresh,
  };
  const execution = new ExecutionHost();
  const operations = createProductRefreshOperations(
    workflow as unknown as RefreshWorkflow,
    execution,
  );

  await expect(
    operations.startCurrentScopeRescrape({ subjectId: "subject-fixture" }),
  ).resolves.toEqual({ id: "rescrape-execution" });
  await expect(
    operations.startMetadataRefresh({ subjectId: "subject-fixture" }),
  ).resolves.toEqual({ id: "metadata-execution" });

  const rescrapeInput = rescrape.mock.calls[0]?.[0];
  const refreshInput = refresh.mock.calls[0]?.[0];
  expect(rescrapeInput).toMatchObject({
    subjectId: "subject-fixture",
    registrationId: "root-fixture",
    relativeScope: "publication",
  });
  if (rescrapeInput === undefined || refreshInput === undefined)
    throw new Error("刷新工作流未被调用");
  expect(
    (
      rescrapeInput.informationRequirement as {
        metadata: readonly { property: string }[];
      }
    ).metadata.map(({ property }) => property),
  ).toContain("dlsite.product.price-jpy");
  expect(refreshInput).toMatchObject({
    selection: {
      subjects: [{ subjectId: "subject-fixture" }],
      filesystemScopes: [],
    },
    reviewPolicy: "automatic",
  });
  expect(
    (
      refreshInput.informationRequirement as {
        metadata: readonly { property: string }[];
      }
    ).metadata.map(({ property }) => property),
  ).toContain("dlsite.product.price-jpy");
  await execution.close();
});

it("库扫描检查展开同一父的所有子执行及来源刷新变更集", async () => {
  const parent = {
    execution: {
      id: "parent-execution",
      operationKind: "scan-asset-library",
      status: "running",
    },
  } as unknown as AssetRefreshInspection;
  const child = {
    execution: {
      id: "child-execution",
      operationKind: "scan-filesystem",
      status: "completed",
    },
    sourceRefreshRuns: [
      {
        id: "source-run",
        phase: "terminal",
        outcome: "succeeded",
        changeSets: [{ id: "change-set", disposition: "automatic" }],
      },
    ],
  } as unknown as AssetRefreshInspection;
  const scan = {
    parentExecutionId: "parent-execution",
    assetLibraryId: "library-fixture",
    configVersion: 1,
    status: "running",
    directories: [
      {
        directoryKey: "directory-fixture",
        childExecutionId: "child-execution",
      },
    ],
  } as unknown as LibraryScanInspectionDetail;
  const workflow = {
    inspect: vi.fn(async (id: string) =>
      id === "parent-execution" ? parent : child,
    ),
    inspectAssetLibraryScan: vi.fn(async () => scan),
  };
  const operations = createProductRefreshOperations(
    workflow as unknown as RefreshWorkflow,
    new ExecutionHost(),
  );

  const inspected = await operations.inspect("parent-execution");
  expect(inspected?.kind).toBe("asset-library-scan");
  if (inspected?.kind !== "asset-library-scan")
    throw new Error("wrong inspection");
  expect(inspected.execution.execution.id).toBe("parent-execution");
  expect(inspected.scan.directories).toHaveLength(1);
  expect(inspected.children[0]).toMatchObject({
    executionId: "child-execution",
    status: "available",
    inspection: {
      sourceRefreshRuns: [
        { id: "source-run", changeSets: [{ id: "change-set" }] },
      ],
    },
  });
});

it("取消库扫描只向父账本请求取消并返回耐久请求状态", async () => {
  const parent = {
    execution: {
      id: "parent-execution",
      operationKind: "scan-asset-library",
      status: "running",
    },
  } as unknown as AssetRefreshInspection;
  let scan = {
    parentExecutionId: "parent-execution",
    assetLibraryId: "library-fixture",
    configVersion: 1,
    status: "running",
    directories: [],
  } as unknown as LibraryScanInspectionDetail;
  const cancelAssetLibraryScan = vi.fn(async () => {
    scan = {
      ...scan,
      cancellationRequested: {
        requestedBy: "operator",
        requestedAt: "2026-10-16T00:00:00.000Z",
      },
    };
    return scan;
  });
  const workflow = {
    async inspect() {
      return parent;
    },
    async inspectAssetLibraryScan() {
      return scan;
    },
    cancelAssetLibraryScan,
  };
  const operations = createProductRefreshOperations(
    workflow as unknown as RefreshWorkflow,
    new ExecutionHost(),
  );

  const result = await operations.cancel({
    executionId: "parent-execution",
    requestedBy: "operator",
    requestedAt: "2026-10-16T00:00:00.000Z",
  });
  expect(result.status).toBe("requested");
  expect(cancelAssetLibraryScan).toHaveBeenCalledWith({
    parentExecutionId: "parent-execution",
    requestedBy: "operator",
    requestedAt: "2026-10-16T00:00:00.000Z",
  });
  expect(result.inspection.kind).toBe("asset-library-scan");
  if (result.inspection.kind !== "asset-library-scan")
    throw new Error("wrong inspection");
  expect(result.inspection.scan.cancellationRequested?.requestedBy).toBe(
    "operator",
  );
});

it("普通执行取消经现有工作流协调并返回实际终态", async () => {
  let current = {
    execution: {
      id: "metadata-execution",
      operationKind: "refresh-metadata",
      status: "running",
    },
  } as unknown as AssetRefreshInspection;
  const cancel = vi.fn(async () => {
    current = {
      execution: {
        id: "metadata-execution",
        operationKind: "refresh-metadata",
        status: "cancelled",
        cancellation: {
          requestedBy: "operator",
          requestedAt: "2026-10-16T00:00:00.000Z",
        },
      },
      sourceRefreshRuns: [
        { id: "source-run", phase: "terminal", outcome: "cancelled" },
      ],
    } as unknown as AssetRefreshInspection;
    return current;
  });
  const workflow = {
    async inspect() {
      return current;
    },
    cancel,
  };
  const operations = createProductRefreshOperations(
    workflow as unknown as RefreshWorkflow,
    new ExecutionHost(),
  );

  const result = await operations.cancel({
    executionId: "metadata-execution",
    requestedBy: "operator",
    requestedAt: "2026-10-16T00:00:00.000Z",
  });
  expect(result.status).toBe("requested");
  expect(cancel).toHaveBeenCalledWith({
    executionId: "metadata-execution",
    requestedBy: "operator",
    requestedAt: "2026-10-16T00:00:00.000Z",
  });
  expect(result.inspection).toMatchObject({
    kind: "execution",
    execution: {
      execution: { status: "cancelled" },
      sourceRefreshRuns: [
        { id: "source-run", phase: "terminal", outcome: "cancelled" },
      ],
    },
  });
});

it("执行已结束时不再请求取消并返回已持久结局", async () => {
  const completed = {
    execution: {
      id: "metadata-execution",
      operationKind: "refresh-metadata",
      status: "completed",
      outcome: "partially-succeeded",
    },
  } as unknown as AssetRefreshInspection;
  const cancel = vi.fn();
  const operations = createProductRefreshOperations(
    {
      async inspect() {
        return completed;
      },
      cancel,
    } as unknown as RefreshWorkflow,
    new ExecutionHost(),
  );

  const result = await operations.cancel({
    executionId: "metadata-execution",
    requestedBy: "operator",
    requestedAt: "2026-10-16T00:00:00.000Z",
  });
  expect(result.status).toBe("already-finished");
  expect(result.inspection).toMatchObject({
    kind: "execution",
    execution: {
      execution: {
        id: "metadata-execution",
        status: "completed",
        outcome: "partially-succeeded",
      },
    },
  });
  expect(cancel).not.toHaveBeenCalled();
});

it("取消命令失败但执行已同时结束时返回实际结局", async () => {
  let current = {
    execution: {
      id: "metadata-execution",
      operationKind: "refresh-metadata",
      status: "running",
    },
  } as unknown as AssetRefreshInspection;
  const cancel = vi.fn(async () => {
    current = {
      execution: {
        id: "metadata-execution",
        operationKind: "refresh-metadata",
        status: "completed",
        outcome: "no-change",
      },
    } as unknown as AssetRefreshInspection;
    throw new Error("执行已经结束");
  });
  const operations = createProductRefreshOperations(
    {
      async inspect() {
        return current;
      },
      cancel,
    } as unknown as RefreshWorkflow,
    new ExecutionHost(),
  );

  const result = await operations.cancel({
    executionId: "metadata-execution",
    requestedBy: "operator",
    requestedAt: "2026-10-16T00:00:00.000Z",
  });
  expect(result.status).toBe("already-finished");
  expect(result.inspection).toMatchObject({
    kind: "execution",
    execution: {
      execution: {
        id: "metadata-execution",
        status: "completed",
        outcome: "no-change",
      },
    },
  });
});

it("取消失败且执行仍在运行时保留取消错误", async () => {
  const current = {
    execution: {
      id: "metadata-execution",
      operationKind: "refresh-metadata",
      status: "running",
    },
  } as unknown as AssetRefreshInspection;
  const workflow = {
    async inspect() {
      return current;
    },
    async cancel() {
      throw new Error("来源运行无法接受取消请求");
    },
  };
  const operations = createProductRefreshOperations(
    workflow as unknown as RefreshWorkflow,
    new ExecutionHost(),
  );

  await expect(
    operations.cancel({
      executionId: "metadata-execution",
      requestedBy: "operator",
      requestedAt: "2026-10-16T00:00:00.000Z",
    }),
  ).rejects.toThrow("来源运行无法接受取消请求");
});
