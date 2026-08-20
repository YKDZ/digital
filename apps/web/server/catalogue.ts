import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  CurrentAttentionPageRequest,
  CurrentCataloguePageRequest,
  ExecutionHost,
  WorkflowHistoryPageRequest,
} from "@digital/application";
import {
  composeAssetRefreshRuntime,
  type BangumiAuthorizationStart,
  type ComposedAssetRefresh,
  type SourceConnectionInspection,
} from "@digital/composition";
import {
  type AssetViewFacts,
  type AssetViewModel,
  type BangumiSeriesViewModel,
  type InformationRequirement,
  generalAssetViewInformationRequirement,
  informationRequirementForAssetView,
  projectAssetView,
  projectCatalogue,
} from "@digital/presentation";

import type {
  AttentionViewModel,
  AutomationViewModel,
  CatalogueSurfaceResponse,
  CatalogueSnapshot,
  ExecutionViewModel,
  ObservedRootViewModel,
} from "#/lib/catalogue";
import { processLifecycle } from "#/server/process-lifecycle";

const productDataEnvironment = "DIGITAL_PRODUCT_DATA";
const managedArtifactSegment = "managed-artifacts";

let runtime: ReturnType<typeof composeAssetRefreshRuntime> | undefined;
let automationStart: Promise<void> | undefined;
let shutdown: Promise<void> | undefined;
let terminalShutdown = false;
let startupFailure: string | undefined;

function assertCatalogueMayStart(): void {
  processLifecycle.assertMayStart();
  if (terminalShutdown) throw new Error("进程正在关闭，不能启动内容目录");
  if (shutdown !== undefined) throw new Error("内容目录正在关闭，请稍后重试");
}

function configuredProductDataDirectory(): string {
  const directory = process.env[productDataEnvironment]?.trim();
  if (!directory) {
    throw new Error("尚未配置内容目录");
  }
  return directory;
}

function composedRuntime() {
  assertCatalogueMayStart();
  runtime ??= composeAssetRefreshRuntime(configuredProductDataDirectory(), {
    automationInformationRequirementForAcceptedSubject:
      informationRequirementForAutomatedAcceptedSubject,
    onError(error) {
      console.error("自动刷新检查未完成", error);
    },
  });
  return runtime;
}

function application() {
  return composedRuntime().workflow;
}

/**
 * Source Connection 操作停留在 delivery 边界。Composition 持有能力专属私有授权；
 * 这个面向 HTTP 的用例只返回安全的运行投影。
 */
export function beginBangumiAuthorization(): BangumiAuthorizationStart {
  return application().sourceConnections.bangumi.beginAuthorization();
}

export async function completeBangumiAuthorizationCallback(
  callbackUrl: string,
): Promise<SourceConnectionInspection> {
  return await application().sourceConnections.bangumi.completeAuthorizationCallback(
    callbackUrl,
  );
}

export function revokeBangumiAuthorization(
  expectedVersion: number,
): SourceConnectionInspection {
  return application().sourceConnections.bangumi.revoke(expectedVersion);
}

function automation() {
  return composedRuntime().automationHost;
}

function executions() {
  return composedRuntime().executionHost;
}

/** 启动且仅启动一个进程内 host；导出它以便 delivery 测试等待。 */
export async function startCatalogueAutomation(): Promise<void> {
  assertCatalogueMayStart();
  if (!process.env[productDataEnvironment]?.trim()) return;
  automationStart ??= automation()
    .start()
    .catch((error: unknown) => {
      startupFailure = describeStartupFailure(error);
      automationStart = undefined;
      throw error;
    });
  await automationStart;
}

/** delivery 安全的运行状态；它不会自行打开 catalogue。 */
export function catalogueReady(): boolean {
  return (
    automationStart !== undefined &&
    runtime?.automationHost.recoveryReady === true
  );
}

/** 启动准入失败的脱敏 delivery 投影。 */
export function catalogueReadinessFailure(): string | undefined {
  if (startupFailure !== undefined) return startupFailure;
  if (!process.env[productDataEnvironment]?.trim())
    return "尚未配置产品数据目录；设置 DIGITAL_PRODUCT_DATA 后运行 digital-db-migrate prepare-only";
  return undefined;
}

/** 释放各进程持有的 composition，不越过所有权边界。 */
export async function shutdownCatalogue(options?: {
  readonly terminal?: boolean;
}): Promise<void> {
  if (options?.terminal === true) terminalShutdown = true;
  if (shutdown !== undefined) return await shutdown;
  const ownedRuntime = runtime;
  shutdown = (async () => {
    await ownedRuntime?.close();
  })().finally(() => {
    if (runtime === ownedRuntime) runtime = undefined;
    automationStart = undefined;
    startupFailure = undefined;
    if (!terminalShutdown) shutdown = undefined;
  });
  await shutdown;
}

function describeStartupFailure(error: unknown): string {
  if (!(error instanceof Error)) return "内容目录启动失败；检查部署诊断后重试";
  // Catalogue 就绪失败刻意包含运维动作，但不包含私有路径、连接 secret、SQLite
  // 堆栈或来源响应。
  return error.message.replaceAll(/\/[^\s]+/gu, "[路径已隐藏]");
}

function managedArtifactRoot(): string {
  return path.join(configuredProductDataDirectory(), managedArtifactSegment);
}

function managedArtifactDigest(address: string): string | undefined {
  const resolved = path.resolve(address);
  const root = managedArtifactRoot();
  if (!resolved.startsWith(`${root}${path.sep}`)) return undefined;
  const digest = path.basename(resolved);
  return /^[a-f0-9]{64}$/u.test(digest) ? digest : undefined;
}

function isPrivateFilesystemAddress(address: string): boolean {
  if (address.startsWith("/api/") || address.startsWith("/covers/")) {
    return false;
  }
  if (address.startsWith("file:")) return true;
  if (path.win32.isAbsolute(address)) return true;
  return path.isAbsolute(address);
}

export function deliveryAssetView(view: AssetViewModel): AssetViewModel {
  const delivered = withDeliveryCover(view);
  return {
    ...delivered,
    ...(delivered.fanbox === undefined
      ? {}
      : {
          fanbox: withDeliveryCover(delivered.fanbox),
        }),
    ...(delivered.dlsite === undefined
      ? {}
      : {
          dlsite: withDeliveryCover(delivered.dlsite),
        }),
    ...(delivered.book === undefined
      ? {}
      : {
          book: withDeliveryCover(delivered.book),
        }),
    ...(delivered.film === undefined
      ? {}
      : {
          film: withDeliveryCover(delivered.film),
        }),
  };
}

function withDeliveryCover<T extends { readonly cover?: string }>(value: T): T {
  const cover = deliveryCover(value.cover);
  if (cover !== undefined) return { ...value, cover };
  if (value.cover === undefined) return value;
  const { cover: _cover, ...withoutCover } = value;
  return withoutCover as T;
}

function deliveryCover(cover: string | undefined): string | undefined {
  if (cover === undefined) return undefined;
  const digest = managedArtifactDigest(cover);
  if (digest !== undefined) return `/api/artifacts/${digest}`;
  if (!isPrivateFilesystemAddress(cover)) return cover;
  return undefined;
}

function managedArtifactPath(digest: string): string {
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("未找到文件");
  }
  return path.join(managedArtifactRoot(), digest.slice(0, 2), digest);
}

function mediaTypeForBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  )
    return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return "application/octet-stream";
}

export async function managedArtifactResponse(
  digest: string,
): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
  const bytes = await readFile(managedArtifactPath(digest));
  return { bytes, mediaType: mediaTypeForBytes(bytes) };
}

type AcceptedPresentationSubject = NonNullable<
  NonNullable<Awaited<ReturnType<ComposedAssetRefresh["inspect"]>>>["accepted"]
>;

/** 从已接受的 Application 投影到 Presentation facts 的 delivery 中立桥接。 */
function assetViewFactsForAccepted(
  accepted: AcceptedPresentationSubject,
): AssetViewFacts {
  return {
    id: accepted.entity.id,
    sourceAssociation: accepted.sourceAssociation,
    sourceAssociations: accepted.sourceAssociations,
    metadata: accepted.effectiveMetadata,
    entities: accepted.entities,
    relationships: accepted.relationships,
    artifactAssociations: accepted.artifactAssociations,
    locations: accepted.locations,
  };
}

/**
 * Automation 仅在 subject 被接受后运行这个由 delivery 持有的 dispatch。返回
 * Application 的值是中立 contract；任何 View 或来源专属输出模型都不能越过边界。
 */
export function informationRequirementForAutomatedAcceptedSubject(
  accepted: AcceptedPresentationSubject,
): InformationRequirement {
  return informationRequirementForAssetView(
    assetViewFactsForAccepted(accepted),
  );
}

/**
 * Presentation 根据当前中立 facts 选择 requirement。Delivery 不会按来源身份分支，
 * 也不会要求 Application 提供所有已交付 View 可选输入的全局并集。
 */
async function informationRequirementForSubject(
  subject: Pick<ComposedAssetRefresh, "inspectCurrentCatalogueSubject">,
  subjectId: string,
  fallbackSourceAssociation?: AssetViewFacts["sourceAssociation"],
) {
  const accepted = await subject.inspectCurrentCatalogueSubject(subjectId);
  const facts =
    accepted === undefined ? undefined : assetViewFactsForAccepted(accepted);
  return informationRequirementForAssetView(
    facts ?? { sourceAssociation: fallbackSourceAssociation, metadata: [] },
  );
}

function deliveryBangumiView(
  view: BangumiSeriesViewModel,
): BangumiSeriesViewModel {
  const delivered = withDeliveryCover(view);
  return {
    ...delivered,
    works: delivered.works.map((work) => ({
      ...withDeliveryCover(work),
      episodes: work.episodes.map(withDeliveryArtwork),
    })),
    episodes: delivered.episodes.map(withDeliveryArtwork),
  };
}

function withDeliveryArtwork<T extends { readonly artwork?: string }>(
  value: T,
): T {
  const artwork = deliveryCover(value.artwork);
  if (artwork !== undefined) return { ...value, artwork };
  if (value.artwork === undefined) return value;
  const { artwork: _artwork, ...withoutArtwork } = value;
  return withoutArtwork as T;
}

export function projectCatalogueAssets(
  facts: readonly AssetViewFacts[],
): CatalogueSnapshot["assets"] {
  return projectCatalogue(facts).map((view) =>
    "works" in view ? deliveryBangumiView(view) : deliveryAssetView(view),
  );
}

function folderName(directory: string): string {
  return path.basename(directory) || "已选择的文件夹";
}

function toAutomationView(intent: {
  readonly id: string;
  readonly scope: {
    readonly observedRootId: string;
    readonly relativeScope: string;
  };
  readonly enabled: boolean;
  readonly intervalMilliseconds: number;
  readonly acceptTrusted: boolean;
}): AutomationViewModel {
  return {
    id: intent.id,
    folder: `${intent.scope.observedRootId}:${intent.scope.relativeScope}`,
    observedRootId: intent.scope.observedRootId,
    relativeScope: intent.scope.relativeScope,
    enabled: intent.enabled,
    intervalMilliseconds: intent.intervalMilliseconds,
    acceptTrusted: intent.acceptTrusted,
  };
}

async function activeObservedRootViews(
  subject: ComposedAssetRefresh,
): Promise<readonly ObservedRootViewModel[]> {
  return (await subject.observedRootRegistrations.list())
    .filter((registration) => registration.status === "active")
    .map(({ id, displayName }) => ({ id, displayName }));
}

export function deliveryExecution(
  inspection: Awaited<ReturnType<ComposedAssetRefresh["inspect"]>>,
): ExecutionViewModel | undefined {
  if (!inspection) return undefined;
  return {
    id: inspection.execution.id,
    folder:
      inspection.execution.selection.directory === undefined
        ? "selection"
        : folderName(inspection.execution.selection.directory),
    intent: inspection.execution.selection.intent ?? "scan-now",
    status: inspection.execution.status,
    outcome: inspection.execution.outcome,
    reason: inspection.execution.reason,
    acceptedAssetId: inspection.execution.acceptedAssetId,
    dispositions: inspection.execution.dispositions.map((item) => ({
      key: item.key,
      status: item.status,
      reason: item.reason,
    })),
    ...(inspection.execution.targetDispositions === undefined
      ? {}
      : {
          targets: inspection.execution.targetDispositions.map((item) => ({
            key: item.key,
            label:
              item.target.kind === "subject"
                ? `内容 ${item.target.subjectId}`
                : `文件范围 ${folderName(item.target.root)}`,
            status: item.status,
            reason: item.reason,
            sourceRecordIds: item.sourceRecordIds,
            outputReferences: item.outputReferences,
          })),
        }),
    ...(inspection.itemResults === undefined
      ? {}
      : {
          items: inspection.itemResults.map((item) => ({
            key: item.key,
            relativePaths: item.relativePaths,
            outcome: item.outcome,
            reason: item.reason,
            recognition: item.recognition,
            acceptedAssetId: item.accepted?.entity.id,
            acceptedSource: item.accepted?.sourceAssociation.nativeAddress,
          })),
        }),
    recognition: inspection.recognition,
    ...(inspection.changeImpactPreview === undefined
      ? {}
      : {
          preview: {
            id: inspection.changeImpactPreview.id,
            status: inspection.changeImpactPreview.status,
            blockingConditions:
              inspection.changeImpactPreview.blockingConditions,
            current: deliveryAssetView(
              projectAssetView({
                id: inspection.changeImpactPreview.assetId,
                ...inspection.changeImpactPreview.current,
              }),
            ),
            proposed: deliveryAssetView(
              projectAssetView({
                id: inspection.changeImpactPreview.assetId,
                ...inspection.changeImpactPreview.projected,
              }),
            ),
          },
        }),
  };
}

function deliveryAttention(input: {
  readonly id: string;
  readonly kind: AttentionViewModel["kind"];
  readonly executionId?: string;
  readonly assetId?: string;
  readonly summary: string;
  readonly recognitionProposalId?: string;
  readonly changeImpactPreviewId?: string;
  readonly sourceRefreshChangeSetId?: string;
  readonly automationIntentId?: string;
}): AttentionViewModel {
  return input;
}

export type CatalogueSnapshotRequest = {
  readonly currentCatalogue?: CurrentCataloguePageRequest;
  readonly workflowHistory?: WorkflowHistoryPageRequest;
  readonly currentAttention?: CurrentAttentionPageRequest;
};

export type CatalogueSurfaceRequest =
  | {
      readonly surface: "current-catalogue";
      readonly page?: CurrentCataloguePageRequest;
    }
  | {
      readonly surface: "workflow-history";
      readonly page?: WorkflowHistoryPageRequest;
    }
  | {
      readonly surface: "current-attention";
      readonly page?: CurrentAttentionPageRequest;
    }
  | { readonly surface: "automation" };

function emptyCatalogueSnapshot(configured: boolean): CatalogueSnapshot {
  return {
    configured,
    assets: [],
    executions: [],
    attention: [],
    automation: [],
    observedRoots: [],
    pagination: {
      currentCatalogue: {},
      workflowHistory: {},
      currentAttention: {},
    },
  };
}

/** 只执行一个 delivery surface，不执行同级 Application 查询。 */
export async function catalogueSurface(
  input: CatalogueSurfaceRequest,
): Promise<CatalogueSurfaceResponse> {
  const configured = Boolean(process.env[productDataEnvironment]?.trim());
  if (!configured) {
    if (input.surface === "current-catalogue")
      return { surface: input.surface, configured, assets: [], pagination: {} };
    if (input.surface === "workflow-history")
      return {
        surface: input.surface,
        configured,
        executions: [],
        pagination: {},
      };
    if (input.surface === "current-attention")
      return {
        surface: input.surface,
        configured,
        attention: [],
        pagination: {},
      };
    return { surface: input.surface, configured, automation: [] };
  }
  const subject = application();
  if (input.surface === "current-catalogue") {
    const page = await subject.listCurrentCataloguePage(input.page);
    const facts = page.items.map(assetViewFactsForAccepted);
    await Promise.all(
      facts.map((fact) =>
        subject.fulfillInformation({
          selection: { subjectIds: [fact.id] },
          requirement: informationRequirementForAssetView(fact),
        }),
      ),
    );
    return {
      surface: input.surface,
      configured,
      assets: projectCatalogueAssets(facts),
      pagination:
        page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    };
  }
  if (input.surface === "workflow-history") {
    const page = await subject.listWorkflowHistoryPage(input.page);
    return {
      surface: input.surface,
      configured,
      executions: page.items
        .map(deliveryExecution)
        .filter((item): item is NonNullable<typeof item> => item !== undefined),
      pagination:
        page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    };
  }
  if (input.surface === "current-attention") {
    const page = await subject.listCurrentAttentionPage(input.page);
    return {
      surface: input.surface,
      configured,
      attention: page.items.map(deliveryAttention),
      pagination:
        page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    };
  }
  return {
    surface: input.surface,
    configured,
    automation: (await subject.listAutomationIntents()).map(toAutomationView),
  };
}

export async function catalogueSnapshot(
  input: CatalogueSnapshotRequest = {},
): Promise<CatalogueSnapshot> {
  if (!process.env[productDataEnvironment]?.trim()) {
    return emptyCatalogueSnapshot(false);
  }
  const subject = application();
  const [currentCatalogue, history, attention, automation, observedRoots] =
    await Promise.all([
      subject.listCurrentCataloguePage(input.currentCatalogue),
      subject.listWorkflowHistoryPage(input.workflowHistory),
      subject.listCurrentAttentionPage(input.currentAttention),
      subject.listAutomationIntents(),
      activeObservedRootViews(subject),
    ]);
  const facts = currentCatalogue.items.map(assetViewFactsForAccepted);
  await Promise.all(
    facts.map((fact) =>
      subject.fulfillInformation({
        selection: { subjectIds: [fact.id] },
        requirement: informationRequirementForAssetView(fact),
      }),
    ),
  );
  return {
    configured: true,
    assets: projectCatalogueAssets(facts),
    executions: history.items
      .map(deliveryExecution)
      .filter((item): item is NonNullable<typeof item> => item !== undefined),
    attention: attention.items.map(deliveryAttention),
    automation: automation.map(toAutomationView),
    observedRoots,
    pagination: {
      currentCatalogue:
        currentCatalogue.nextCursor === undefined
          ? {}
          : { nextCursor: currentCatalogue.nextCursor },
      workflowHistory:
        history.nextCursor === undefined
          ? {}
          : { nextCursor: history.nextCursor },
      currentAttention:
        attention.nextCursor === undefined
          ? {}
          : { nextCursor: attention.nextCursor },
    },
  };
}

export async function startRefresh(input: {
  readonly observedRootId?: string;
  readonly relativeScope?: string;
  readonly assetId?: string;
  readonly target?: { readonly subjectId: string };
  readonly operation?: "metadata-refresh" | "rescrape";
  readonly intent?: "scan-now" | "metadata-refresh";
  readonly rescrape?: boolean;
  readonly directedSourceAddress?: string;
  readonly directedSourceIdentity?: string;
}): Promise<{ readonly id: string }> {
  return await startRefreshWith(application(), input, executions());
}

export async function createObservedRoot(input: {
  readonly displayName: string;
  readonly containerPath: string;
  readonly symlinkMode:
    | "do-not-follow"
    | "follow-file-links"
    | "follow-file-and-directory-links";
}) {
  return await application().observedRootRegistrations.create({
    ...input,
    readOnly: true,
    allowedTargetRootIds: [],
  });
}

export async function startRefreshWith(
  subject: ComposedAssetRefresh,
  input: Parameters<typeof startRefresh>[0],
  host: Pick<ExecutionHost, "invoke">,
): Promise<{ readonly id: string }> {
  const subjectId = input.target?.subjectId ?? input.assetId;
  if (
    input.target !== undefined &&
    input.assetId !== undefined &&
    input.target.subjectId !== input.assetId
  )
    throw new Error("刷新请求包含冲突的主体标识");
  if (
    (input.operation === "metadata-refresh" ||
      input.intent === "metadata-refresh") &&
    subjectId !== undefined
  ) {
    return await startAssetMetadataRefresh(
      subject,
      subjectId,
      host,
      await informationRequirementForSubject(subject, subjectId),
    );
  }
  if (
    (input.operation === "rescrape" || input.rescrape === true) &&
    subjectId !== undefined
  ) {
    if (
      input.observedRootId !== undefined ||
      input.directedSourceAddress !== undefined ||
      input.directedSourceIdentity !== undefined
    )
      throw new Error("重新刮削的当前范围与来源关联必须由服务端解析");
    return await startAssetRescrapeForSubject(subject, subjectId, host);
  }
  if (input.observedRootId === undefined)
    throw new Error("扫描必须选择已登记的文件位置");
  const observedRootId = input.observedRootId;
  if (
    input.rescrape ||
    input.operation !== undefined ||
    input.intent === "metadata-refresh"
  )
    throw new Error("该操作需要精确内容标识");
  return await host.invoke(async (control) => {
    await subject.scanObservedScope({
      registrationId: observedRootId,
      relativeScope: input.relativeScope ?? ".",
      acceptTrusted: true,
      // scan 被接受前不存在专门 View；General Asset View 持有这个有界初始需求。
      informationRequirement: generalAssetViewInformationRequirement,
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function startAssetRescrapeForSubject(
  subject: Pick<
    ComposedAssetRefresh,
    | "inspectCurrentCatalogueSubject"
    | "inspectRefreshTarget"
    | "rescrapeObservedScope"
  >,
  subjectId: string,
  host: Pick<ExecutionHost, "invoke">,
): Promise<{ readonly id: string }> {
  const target = await subject.inspectRefreshTarget(subjectId);
  if (target === undefined) throw new Error("未找到可重新刮削的当前内容");
  return await startAssetRescrape(
    subject,
    {
      assetId: target.subjectId,
      observedRootId: target.filesystemScope.observedRootId,
      relativeScope: target.filesystemScope.relativeScope,
      sourceIdentity: target.sourceAssociation.sourceIdentity,
      sourceAddress: target.sourceAssociation.nativeAddress,
    },
    host,
    await informationRequirementForSubject(
      subject,
      subjectId,
      target.sourceAssociation,
    ),
  );
}

export async function startAssetRescrape(
  subject: Pick<ReturnType<typeof application>, "rescrapeObservedScope">,
  input: {
    readonly assetId: string;
    readonly observedRootId: string;
    readonly relativeScope: string;
    readonly sourceAddress: string;
    readonly sourceIdentity: string;
  },
  host: Pick<ExecutionHost, "invoke">,
  informationRequirement: InformationRequirement = informationRequirementForAssetView(
    {
      sourceAssociation: {
        sourceIdentity: input.sourceIdentity,
        nativeAddress: input.sourceAddress,
      },
      metadata: [],
    },
  ),
): Promise<{ readonly id: string }> {
  return await host.invoke(async (control) => {
    await subject.rescrapeObservedScope({
      subjectId: input.assetId,
      registrationId: input.observedRootId,
      relativeScope: input.relativeScope,
      sourceAddress: input.sourceAddress,
      sourceIdentity: input.sourceIdentity,
      informationRequirement,
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function startAssetMetadataRefresh(
  subject: Pick<ReturnType<typeof application>, "refreshMetadata">,
  assetId: string,
  host: Pick<ExecutionHost, "invoke">,
  informationRequirement: InformationRequirement = generalAssetViewInformationRequirement,
): Promise<{ readonly id: string }> {
  return await host.invoke(async (control) => {
    await subject.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: assetId,
            explanations: [{ path: ["asset-detail", assetId] }],
          },
        ],
        filesystemScopes: [],
      },
      informationRequirement,
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function updateAutomation(input: {
  readonly action: "enable" | "disable" | "scan-now";
  readonly intentId?: string;
  readonly observedRootId?: string;
  readonly relativeScope?: string;
  readonly intervalMilliseconds?: number;
  readonly acceptTrusted?: boolean;
}): Promise<
  | {
      readonly intent: AutomationViewModel;
      readonly initialStatus?: string;
      readonly initialExecution?: { readonly id: string };
    }
  | { readonly status: "disabled" }
  | {
      readonly status: "started" | "skipped" | "disabled";
      readonly execution?: { readonly id: string };
      readonly reason?: string;
    }
> {
  const subject = application();
  if (input.action === "enable") {
    if (!input.observedRootId || !input.intervalMilliseconds)
      throw new Error("请填写刷新范围和间隔");
    const observedRootId = input.observedRootId;
    const intervalMilliseconds = input.intervalMilliseconds;
    let announceIntent!: (
      intent: Awaited<ReturnType<typeof subject.enableAutomation>>["intent"],
    ) => void;
    const intentCreated = new Promise<
      Awaited<ReturnType<typeof subject.enableAutomation>>["intent"]
    >((resolve) => {
      announceIntent = resolve;
    });
    const initialExecution = executions().invoke(async (control) => {
      await subject.enableAutomation({
        observedRootId,
        relativeScope: input.relativeScope ?? ".",
        intervalMilliseconds,
        acceptTrusted: input.acceptTrusted ?? true,
        onIntentCreated: announceIntent,
        onInitialExecutionStarted(execution) {
          control.executionStarted(execution.id);
        },
        onInitialCheckpoint() {
          control.safeCheckpoint();
        },
      });
    });
    const [intent, execution] = await Promise.all([
      intentCreated,
      initialExecution,
    ]);
    return {
      intent: toAutomationView(intent),
      initialStatus: "started",
      initialExecution: execution,
    };
  }
  if (!input.intentId) throw new Error("未找到自动刷新设置");
  if (input.action === "disable") {
    await subject.disableAutomation(input.intentId);
    return { status: "disabled" };
  }
  return await startAutomationNowWith(subject, executions(), input.intentId);
}

export async function startAutomationNowWith(
  subject: Pick<ReturnType<typeof application>, "triggerAutomation">,
  host: Pick<ExecutionHost, "invoke">,
  intentId: string,
): Promise<
  | {
      readonly status: "started";
      readonly execution: { readonly id: string };
    }
  | { readonly status: "skipped" | "disabled"; readonly reason: string }
> {
  let completed: ReturnType<typeof subject.triggerAutomation> | undefined;
  const accepted = host.invoke((control) => {
    completed = subject.triggerAutomation(intentId, "scan-now", new Date(), {
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onCheckpoint() {
        control.safeCheckpoint();
      },
    });
    return completed.then(() => undefined);
  });
  try {
    const execution = await accepted;
    return { status: "started", execution };
  } catch (error) {
    if (completed === undefined) throw error;
    const disposition = await completed;
    if (disposition.status !== "started") return disposition;
    throw error;
  }
}

export async function updatePreview(input: {
  readonly action: "apply" | "reject";
  readonly previewId: string;
}): Promise<{
  readonly status: "awaiting-confirmation" | "rejected" | "applied" | "stale";
}> {
  const preview =
    input.action === "apply"
      ? await application().applyChangeImpactPreview(input.previewId)
      : await application().rejectChangeImpactPreview(input.previewId);
  return { status: preview.status };
}
