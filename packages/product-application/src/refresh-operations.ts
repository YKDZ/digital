import type {
  AssetRefreshInspection,
  LibraryScanInspectionDetail,
} from "@digital/application";

import {
  productAutomationInformationPlanner,
  productGeneralAutomationInformationRequirement,
  productRefreshPlanningInformationRequirement,
} from "./policies.ts";
import type {
  ProductExecutionOperations,
  ProductWorkflowOperations,
} from "./product.ts";

type ProductRefreshWorkflow = Pick<
  ProductWorkflowOperations,
  | "scanAssetLibrary"
  | "inspectAssetLibraryScan"
  | "inspectRefreshTarget"
  | "inspectCurrentCatalogueSubject"
  | "rescrapeCurrentObservedScope"
  | "refreshMetadata"
  | "inspect"
  | "cancel"
  | "cancelAssetLibraryScan"
>;

export type ProductLibraryScanRequest = {
  readonly libraryId: string;
  readonly acceptTrusted?: boolean;
  readonly initiatedBy?: string;
};

export type ProductSubjectRefreshRequest = {
  readonly subjectId: string;
};

export type ProductMetadataRefreshRequest = ProductSubjectRefreshRequest & {
  readonly initiatedBy?: string;
  readonly reviewPolicy?: "automatic" | "review";
};

export type ProductRefreshInspection =
  | {
      readonly kind: "execution";
      readonly execution: AssetRefreshInspection;
    }
  | {
      readonly kind: "asset-library-scan";
      readonly execution: AssetRefreshInspection;
      readonly scan: LibraryScanInspectionDetail;
      readonly children: readonly ProductRefreshChildInspection[];
    };

export type ProductRefreshChildInspection =
  | {
      readonly executionId: string;
      readonly status: "available";
      readonly inspection: AssetRefreshInspection;
    }
  | { readonly executionId: string; readonly status: "missing" };

export type ProductRefreshCancellation = {
  /** 该字段只报告请求是否受理；是否已经取消以 inspection 的持久状态为准。 */
  readonly status: "requested" | "already-finished";
  readonly inspection: ProductRefreshInspection;
};

export class InvalidProductRefreshRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProductRefreshRequest";
  }
}

export class ProductRefreshTargetNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductRefreshTargetNotFound";
  }
}

export class ProductRefreshTargetNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductRefreshTargetNotReady";
  }
}

export type ProductRefreshOperations = {
  startLibraryScan(
    request: ProductLibraryScanRequest,
  ): Promise<{ readonly id: string }>;
  startCurrentScopeRescrape(
    request: ProductSubjectRefreshRequest,
  ): Promise<{ readonly id: string }>;
  startMetadataRefresh(
    request: ProductMetadataRefreshRequest,
  ): Promise<{ readonly id: string }>;
  inspect(executionId: string): Promise<ProductRefreshInspection | undefined>;
  cancel(input: {
    readonly executionId: string;
    readonly requestedBy: string;
    readonly requestedAt: string;
    readonly reason?: string;
  }): Promise<ProductRefreshCancellation>;
};

/**
 * 显式刷新入口统一承担产品规则、执行宿主回调与父子结果展开；目录扫描与来源刷新
 * 本身仍由 Application 的既有正式工作流处理。
 */
export function createProductRefreshOperations(
  workflow: ProductRefreshWorkflow,
  execution: ProductExecutionOperations,
): ProductRefreshOperations {
  const inspect = async (
    executionId: string,
  ): Promise<ProductRefreshInspection | undefined> => {
    const parent = await workflow.inspect(executionId);
    if (parent === undefined) return undefined;
    if (parent.execution.operationKind !== "scan-asset-library")
      return { kind: "execution", execution: parent };

    const scan = await workflow.inspectAssetLibraryScan(executionId);
    if (scan === undefined) throw new Error("库扫描父执行缺少耐久目录账本");
    const childExecutionIds = [
      ...new Set(
        scan.directories.flatMap((directory) =>
          directory.childExecutionId === undefined
            ? []
            : [directory.childExecutionId],
        ),
      ),
    ];
    const children = await Promise.all(
      childExecutionIds.map(async (childExecutionId) => {
        const inspection = await workflow.inspect(childExecutionId);
        return inspection === undefined
          ? { executionId: childExecutionId, status: "missing" as const }
          : {
              executionId: childExecutionId,
              status: "available" as const,
              inspection,
            };
      }),
    );
    return { kind: "asset-library-scan", execution: parent, scan, children };
  };

  const informationRequirementFor = async (subjectId: string) => {
    const accepted = await workflow.inspectCurrentCatalogueSubject(
      subjectId,
      productRefreshPlanningInformationRequirement,
    );
    if (accepted === undefined)
      throw new ProductRefreshTargetNotFound("所选主体没有当前已接受身份");
    return productAutomationInformationPlanner.requirementForAcceptedSubject(
      accepted,
    );
  };

  return {
    async startLibraryScan(request) {
      const libraryId = request.libraryId.trim();
      if (libraryId.length === 0)
        throw new InvalidProductRefreshRequest("资产库标识不能为空");
      return await execution.invoke(async (control) => {
        await workflow.scanAssetLibrary({
          libraryId,
          acceptTrusted: request.acceptTrusted ?? true,
          ...(request.initiatedBy === undefined
            ? {}
            : { initiatedBy: request.initiatedBy }),
          informationRequirement:
            productGeneralAutomationInformationRequirement,
          onExecutionStarted(created) {
            control.executionStarted(created.id);
          },
          onHostCheckpoint() {
            control.safeCheckpoint();
          },
        });
      });
    },

    async startCurrentScopeRescrape(request) {
      const subjectId = request.subjectId.trim();
      if (subjectId.length === 0)
        throw new InvalidProductRefreshRequest("内容标识不能为空");
      const target = await workflow.inspectRefreshTarget(subjectId);
      if (target === undefined)
        throw new ProductRefreshTargetNotFound("未找到可重新刮削的当前内容");
      if (target.recognitionSourceAssociation === undefined)
        throw new ProductRefreshTargetNotReady(
          "当前内容没有可重新刮削的识别来源",
        );
      const informationRequirement = await informationRequirementFor(subjectId);
      return await execution.invoke(async (control) => {
        await workflow.rescrapeCurrentObservedScope({
          subjectId,
          registrationId: target.filesystemScope.observedRootId,
          relativeScope: target.filesystemScope.relativeScope,
          informationRequirement,
          onExecutionStarted(created) {
            control.executionStarted(created.id);
          },
          onHostCheckpoint() {
            control.safeCheckpoint();
          },
        });
      });
    },

    async startMetadataRefresh(request) {
      const subjectId = request.subjectId.trim();
      if (subjectId.length === 0)
        throw new InvalidProductRefreshRequest("内容标识不能为空");
      const informationRequirement = await informationRequirementFor(subjectId);
      return await execution.invoke(async (control) => {
        await workflow.refreshMetadata({
          selection: {
            version: "asset-refresh-selection/1",
            subjects: [
              {
                subjectId,
                explanations: [{ path: ["explicit-refresh", subjectId] }],
              },
            ],
            filesystemScopes: [],
          },
          informationRequirement,
          ...(request.initiatedBy === undefined
            ? {}
            : { initiatedBy: request.initiatedBy }),
          reviewPolicy: request.reviewPolicy ?? "automatic",
          onExecutionStarted(created) {
            control.executionStarted(created.id);
          },
          onHostCheckpoint() {
            control.safeCheckpoint();
          },
        });
      });
    },

    inspect,

    async cancel(input) {
      const before = await inspect(input.executionId);
      if (before === undefined)
        throw new ProductRefreshTargetNotFound("未找到刷新记录");
      if (isTerminal(before))
        return { status: "already-finished", inspection: before };

      try {
        if (before.kind === "asset-library-scan") {
          await workflow.cancelAssetLibraryScan({
            parentExecutionId: input.executionId,
            requestedBy: input.requestedBy,
            requestedAt: input.requestedAt,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          });
        } else {
          await workflow.cancel({
            executionId: input.executionId,
            requestedBy: input.requestedBy,
            requestedAt: input.requestedAt,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          });
        }
      } catch (error) {
        const afterFailure = await inspect(input.executionId);
        if (afterFailure !== undefined && isTerminal(afterFailure))
          return { status: "already-finished", inspection: afterFailure };
        throw error;
      }

      const after = await inspect(input.executionId);
      if (after === undefined)
        throw new ProductRefreshTargetNotFound("刷新记录在取消后不可读取");
      if (
        after.kind === "asset-library-scan" &&
        after.scan.status !== "running" &&
        after.scan.cancellationRequested === undefined
      )
        return { status: "already-finished", inspection: after };
      if (
        after.kind === "execution" &&
        after.execution.execution.status !== "running" &&
        after.execution.execution.cancellation === undefined
      )
        return { status: "already-finished", inspection: after };
      return { status: "requested", inspection: after };
    },
  };
}

function isTerminal(inspection: ProductRefreshInspection): boolean {
  return inspection.kind === "asset-library-scan"
    ? inspection.scan.status !== "running"
    : inspection.execution.execution.status !== "running";
}
