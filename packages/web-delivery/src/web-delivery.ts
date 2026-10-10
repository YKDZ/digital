import {
  type AssetLibraryDirectoryState,
  type AutomationDisabledReason,
  type AutomatedInformationPlanner,
  type CurrentAttentionPageRequest,
  type CurrentCataloguePageRequest,
  ExecutionHost,
  type LibraryScanInspectionDetail,
  type RecoveryClassification,
  type SourceConnectionInspection,
  type WorkflowHistoryPageRequest,
} from "@digital/application";
import {
  type AssetViewFacts,
  type AssetViewModel,
  type BangumiSeriesViewModel,
  type InformationRequirement,
  generalAssetViewInformationRequirement,
  informationRequirementForAssetView,
  projectAssetView,
  projectCatalogue,
  libraryIndexMetadataProperties,
} from "@digital/presentation";
import type {
  ProductApplication,
  ProductAssetRefresh,
  ProductWorkflowOperations,
} from "@digital/product-application";
import {
  ArtifactByteAccessError,
  ObservedRevisionConfirmationError,
  type ByteReadCancellation,
  type ConsumerPlaybackCapabilities,
  type PlaybackPreferences,
} from "@digital/product-application";
import type { Hono } from "hono";

import { createApi } from "./api.ts";
import type {
  CoverChoiceView,
  LibraryQuery,
  IntakeSnapshot,
  IntakeContent,
} from "./catalogue.ts";
import type { CatalogueSubjectResponse } from "./catalogue.ts";
import type { CatalogueSubjectLibraryChoice } from "./catalogue.ts";
import type { CatalogueSubjectSourceRetry } from "./catalogue.ts";
import type {
  AttentionViewModel,
  AutomationRecoveryViewModel,
  AutomationViewModel,
  CatalogueSurfaceResponse,
  CatalogueSnapshot,
  ExecutionViewModel,
  ObservedRootViewModel,
} from "./catalogue.ts";
import type {
  SettingsDirectoryView,
  SettingsLibrary,
  SettingsSnapshot,
} from "./catalogue.ts";
import { createIdentityMergeApi } from "./identity-merge-api.ts";
import { libraryItems, selectLibraryPage } from "./library-query.ts";
import { createRelationshipApi } from "./relationship-api.ts";

/** 接入区可选目录：该资产库配置里的活动目录，跨库共享的同一目录只列一次。 */
async function intakeDirectoryOptions(
  subject: ProductWorkflowOperations,
): Promise<readonly { readonly id: string; readonly displayName: string }[]> {
  const seen = new Set<string>();
  const options: { id: string; displayName: string }[] = [];
  for (const libraryId of (await subject.assetLibraries.list()).map(
    (library) => library.id,
  ))
    for (const directory of await subject.assetLibraries.directories(libraryId))
      if (!seen.has(directory.id)) {
        seen.add(directory.id);
        options.push(directory);
      }
  return options;
}

export async function intakeSnapshot(input: {
  readonly rootId?: string;
  readonly executionId?: string;
}): Promise<IntakeSnapshot> {
  const subject = application();
  const roots = await intakeDirectoryOptions(subject);
  const rootId = input.rootId;
  // 没有明确目录时不替用户挑“第一个活动根”，只给出该库配置的目录清单。
  if (rootId === undefined) return { roots, files: [], contents: [] };
  if (!roots.some((root) => root.id === rootId))
    throw new Error("文件位置不属于当前资产库，请重新选择");
  const intake = await subject.inspectLocalIntake({
    registrationId: rootId,
    ...(input.executionId === undefined
      ? {}
      : { executionId: input.executionId }),
  });
  const execution = deliveryExecution(intake.execution);
  return {
    roots,
    rootId,
    files: intake.files,
    contents: intake.contents.map((content) =>
      deliveryAssetView(projectAssetView(content)),
    ),
    ...(execution === undefined ? {} : { execution }),
  };
}

function intakeContent(
  review: Awaited<ReturnType<ProductAssetRefresh["prepareLocalContent"]>>,
): IntakeContent {
  return {
    executionId: review.executionId,
    status: review.status,
    relativePaths: review.relativePaths,
    asset: deliveryAssetView(projectAssetView(review.content.facts)),
  };
}

export async function inspectIntakeContent(
  executionId: string,
): Promise<IntakeContent> {
  return intakeContent(await application().inspectLocalContent(executionId));
}

export async function updateIntake(value: unknown): Promise<IntakeContent> {
  const input = settingsObject(value);
  const executionId = input.executionId;
  if (typeof executionId !== "string" || !executionId)
    throw new Error("请先检查文件");
  if (input.action === "confirm")
    return intakeContent(
      await application().confirmLocalContent({ executionId }),
    );
  if (
    input.action !== "prepare" ||
    !Array.isArray(input.relativePaths) ||
    !input.relativePaths.every((item: unknown) => typeof item === "string")
  )
    throw new Error("请选择待整理的文件");
  if (
    input.classification !== undefined &&
    (typeof input.classification !== "string" ||
      !["book", "audio", "video"].includes(input.classification))
  )
    throw new Error("请选择有效的内容类别");
  if (input.name !== undefined && typeof input.name !== "string")
    throw new Error("内容名称无效");
  return intakeContent(
    await application().prepareLocalContent({
      executionId,
      relativePaths: input.relativePaths,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.classification === undefined
        ? {}
        : { classification: input.classification }),
    }),
  );
}

/**
 * 一条库目录的交付视图：只投影友好名、用户自己整理的目录路径、本库授权状态与本次可达性。
 * 授权 ID、权威版本、链接策略与允许目标留在应用层，绝不进入这份 DTO，UI 因此无从显示内部机制。
 */
function toSettingsDirectoryView(
  state: AssetLibraryDirectoryState,
): SettingsDirectoryView {
  return {
    directoryId: state.directoryId,
    observedRootId: state.observedRootId,
    displayName: state.displayName,
    containerPath: state.containerPath,
    status: state.status,
    reachable: state.reachable,
    ...(state.problem === undefined ? {} : { problem: state.problem }),
  };
}

/** 交付层的可选目录只来自资产库配置：按库读取该库的目录，设置页不再持有全局根清单。 */
async function settingsLibraries(
  subject: ProductWorkflowOperations,
): Promise<readonly SettingsLibrary[]> {
  return await Promise.all(
    (await subject.assetLibraries.list()).map(async (library) => {
      const directoryViews = (
        await subject.assetLibraries.directoryViews(library.id)
      ).map(toSettingsDirectoryView);
      return {
        id: library.id,
        displayName: library.displayName,
        configVersion: library.configVersion,
        recognitionProfileIds: library.recognitionProfileIds,
        sourceIdentities: library.sourceIdentities,
        // 可编辑目录只列本库当前授权的目录；已移除目录等待显式重连，不自动回到清单。
        directories: directoryViews
          .filter((view) => view.status === "active")
          .map((view) => view.containerPath),
        directoryViews,
      };
    }),
  );
}

export async function settingsSnapshot(): Promise<SettingsSnapshot> {
  const product = configuredProductApplication();
  return {
    configured: product.configured,
    libraries: await settingsLibraries(product.workflow),
    recognitionProfiles: product.workflow.assetLibraries.recognitionProfiles,
    librarySources: product.workflow.assetLibraries.sources,
    ...(product.productDataDirectory === undefined
      ? {}
      : { productDataDirectory: product.productDataDirectory }),
    sources: product.workflow.sourceConnections.inspect(),
    automation: await toAutomationViews(
      product.workflow,
      await product.workflow.listAutomationIntents(),
    ),
    recovery: product.configured
      ? product.automation.startupRecovery().map(toAutomationRecoveryView)
      : [],
  };
}

export async function listLibraryViews() {
  if (productApplication?.configured !== true) return [];
  return (await application().assetLibraries.list()).map(
    ({ id, displayName }) => ({ id, displayName }),
  );
}

export async function updateSettingsLibrary(value: unknown) {
  const input = settingsObject(value);
  const libraries = application().assetLibraries;
  const action = settingsText(input, "action");
  if (action === "remove")
    return await libraries.remove({
      id: settingsText(input, "id"),
      expectedVersion: settingsVersion(input),
    });
  // 显式重连只点名库与目录，权威版本与配置版本都在服务端就地读取，版本号因此不出前端。
  if (action === "reconnect") {
    const libraryId = settingsText(input, "id");
    const directoryId = settingsText(input, "directoryId");
    const library = await libraries.get(libraryId);
    if (library === undefined) throw new Error("资产库不存在或已移除");
    const grant = (await libraries.directoryViews(libraryId)).find(
      (view) => view.directoryId === directoryId,
    );
    if (grant === undefined)
      throw new Error("该目录不属于此资产库，请选择要重新连接的目录");
    return await libraries.reconnect({
      id: libraryId,
      expectedVersion: library.configVersion,
      directoryId,
      expectedAuthorityVersion: grant.authorityVersion,
    });
  }
  if (action !== "save") throw new Error("未知资产库操作");
  const list = (key: string): readonly string[] => {
    const values = input[key];
    if (
      !Array.isArray(values) ||
      !values.every((item): item is string => typeof item === "string")
    )
      throw new Error("资产库设置无效");
    return values;
  };
  return await libraries.save({
    displayName: settingsText(input, "displayName"),
    directories: list("directories"),
    recognitionProfileIds: list("recognitionProfileIds"),
    sourceIdentities: list("sourceIdentities"),
    ...(input.id === undefined
      ? {}
      : {
          id: settingsText(input, "id"),
          expectedVersion: settingsVersion(input),
        }),
  });
}

function settingsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("设置请求无效");
  return value as Record<string, unknown>;
}

export async function updateSettingsConnection(value: unknown) {
  const input = settingsObject(value);
  const source = settingsText(input, "source");
  const action = settingsText(input, "action");
  const connections = application().sourceConnections;
  if (source === "bangumi") {
    if (action === "authorize") return connections.bangumi.beginAuthorization();
    if (action === "revoke")
      return connections.bangumi.revoke(settingsVersion(input));
    if (action === "configure-client") {
      connections.bangumi.configureClient({
        clientId: settingsText(input, "clientId"),
        clientSecret: settingsText(input, "clientSecret"),
        redirectUri: settingsText(input, "redirectUri"),
      });
      return connections.bangumi.inspect();
    }
    if (action === "verify") {
      await connections.bangumi.authorization().bearer();
      return connections.bangumi.inspect();
    }
  }
  if (source === "fanbox") {
    const creatorId = settingsText(input, "creatorId");
    if (action === "verify") return await connections.fanbox.verify(creatorId);
    if (action === "revoke")
      return connections.fanbox.revoke({
        creatorId,
        expectedVersion: settingsVersion(input),
      });
    if (action === "configure")
      return await connections.fanbox.importBrowserCredentials({
        creatorId,
        browserCredential: input.browserCredential,
      });
    if (action === "replace")
      return await connections.fanbox.replaceBrowserCredentials({
        creatorId,
        browserCredential: input.browserCredential,
        expectedVersion: settingsVersion(input),
      });
  }
  if (source === "tmdb" || source === "omdb") {
    const connection = connections[source];
    if (action === "verify") return await connection.verify();
    if (action === "revoke") return connection.revoke(settingsVersion(input));
    if (action === "configure" || action === "replace") {
      const secret = settingsText(input, "secret");
      if (source === "tmdb") {
        if (action === "configure")
          connections.tmdb.configureAccessToken(secret);
        else
          connections.tmdb.replaceAccessToken(secret, settingsVersion(input));
      } else {
        if (action === "configure") connections.omdb.configureApiKey(secret);
        else connections.omdb.replaceApiKey(secret, settingsVersion(input));
      }
      return await connection.verify();
    }
  }
  throw new Error("未知来源连接操作");
}
function settingsText(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result.trim())
    throw new Error("请填写完整的设置");
  return result.trim();
}
function settingsVersion(value: Record<string, unknown>): number {
  const result = value.expectedVersion;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
    throw new Error("设置版本无效，请刷新后重试");
  return result;
}

export type BangumiAuthorizationStart = ReturnType<
  ProductAssetRefresh["sourceConnections"]["bangumi"]["beginAuthorization"]
>;

/** Web delivery 的完整进程接口；可执行根只需把已组合的产品应用交给它。 */
export type WebDelivery = {
  readonly api: Hono;
  readonly startCatalogueAutomation: () => Promise<void>;
  readonly catalogueReady: () => boolean;
  readonly catalogueReadinessFailure: () => string | undefined;
};

/**
 * 将已组合的产品操作绑定到 Web delivery。这里不选择适配器，也不拥有组合资源。
 */
export function createWebDelivery(
  application: ProductApplication,
): WebDelivery {
  if (application.configured)
    application.setAutomationInformationRequirementForAcceptedSubject(
      informationRequirementForAutomatedAcceptedSubject,
    );
  productApplication = application;
  const catalogueAutomation = createCatalogueAutomation(application);
  activeCatalogueAutomation = catalogueAutomation;
  return {
    api: createApi()
      .route(
        "/relationships",
        createRelationshipApi(() => application.workflow),
      )
      .route(
        "/identity",
        createIdentityMergeApi(() => application.workflow),
      ),
    startCatalogueAutomation: catalogueAutomation.start,
    catalogueReady: catalogueAutomation.ready,
    catalogueReadinessFailure: catalogueAutomation.failure,
  };
}

let productApplication: ProductApplication | undefined;
let activeCatalogueAutomation: CatalogueAutomation | undefined;

type CatalogueAutomation = {
  readonly start: () => Promise<void>;
  readonly ready: () => boolean;
  readonly failure: () => string | undefined;
};

function createCatalogueAutomation(
  application: ProductApplication,
): CatalogueAutomation {
  let automationStart: Promise<void> | undefined;
  let startupFailure: string | undefined;
  return {
    async start(): Promise<void> {
      if (!application.configured) return;
      automationStart ??= application
        .startAutomation({
          onError(error) {
            console.error("自动刷新检查未完成", error);
          },
        })
        .catch((error: unknown) => {
          startupFailure = describeStartupFailure(error);
          automationStart = undefined;
          throw error;
        });
      await automationStart;
    },
    ready(): boolean {
      return (
        automationStart !== undefined && application.automation.recoveryReady
      );
    },
    failure(): string | undefined {
      if (startupFailure !== undefined) return startupFailure;
      if (!application.configured)
        return "尚未配置产品数据目录；设置 DIGITAL_PRODUCT_DATA 后运行 digital-db-migrate prepare-only";
      return undefined;
    },
  };
}

function configuredProductApplication(): ProductApplication {
  if (productApplication === undefined)
    throw new Error("Web 交付尚未注入产品应用");
  return productApplication;
}

function application() {
  return configuredProductApplication().workflow;
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

function executions() {
  return configuredProductApplication().execution;
}

/** 启动且仅启动一个进程内 host；导出它以便 delivery 测试等待。 */
export async function startCatalogueAutomation(): Promise<void> {
  await configuredCatalogueAutomation().start();
}

/** delivery 安全的运行状态；它不会自行打开 catalogue。 */
export function catalogueReady(): boolean {
  return configuredCatalogueAutomation().ready();
}

/** 启动准入失败的脱敏 delivery 投影。 */
export function catalogueReadinessFailure(): string | undefined {
  return (
    activeCatalogueAutomation?.failure() ??
    "尚未配置产品数据目录；设置 DIGITAL_PRODUCT_DATA 后运行 digital-db-migrate prepare-only"
  );
}

function configuredCatalogueAutomation(): CatalogueAutomation {
  if (activeCatalogueAutomation === undefined)
    throw new Error("Web 交付尚未注入产品应用");
  return activeCatalogueAutomation;
}

function describeStartupFailure(error: unknown): string {
  if (!(error instanceof Error)) return "内容目录启动失败；检查部署诊断后重试";
  // Catalogue 就绪失败刻意包含运维动作，但不包含私有路径、连接 secret、SQLite
  // 堆栈或来源响应。
  return error.message.replaceAll(/\/[^\s]+/gu, "[路径已隐藏]");
}

function managedArtifactDigest(address: string): string | undefined {
  return configuredProductApplication().managedArtifactReference(address)
    ?.digest;
}

function isPrivateFilesystemAddress(address: string): boolean {
  if (address.startsWith("/api/") || address.startsWith("/covers/")) {
    return false;
  }
  if (address.startsWith("file:")) return true;
  return /^(?:[a-zA-Z]:[\\/]|\/)/u.test(address);
}

export function deliveryAssetView(view: AssetViewModel): AssetViewModel {
  const delivered = withDeliveryCover(view);
  return {
    ...delivered,
    ...(delivered.files === undefined
      ? {}
      : { files: delivered.files.map(withDeliveryFileImage) }),
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
          book: {
            ...withDeliveryCover(delivered.book),
            files: delivered.book.files.map(withDeliveryFileImage),
          },
        }),
    ...(delivered.film === undefined
      ? {}
      : {
          film: withDeliveryCover(delivered.film),
        }),
  };
}

function withDeliveryFileImage<T extends { readonly image?: string }>(
  value: T,
): T {
  const image = deliveryCover(value.image);
  if (image !== undefined) return { ...value, image };
  if (value.image === undefined) return value;
  const { image: _image, ...withoutImage } = value;
  return withoutImage as T;
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
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("未找到文件");
  const bytes =
    await configuredProductApplication().readManagedArtifact(digest);
  return { bytes, mediaType: mediaTypeForBytes(bytes) };
}

const artifactDownloadChunkBytes = 64 * 1024;

function artifactRevisionSelection(value: string, assetLibraryId?: string) {
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  )
    throw new Error("产物修订版身份无效");
  return {
    artifactRevisionId: value,
    ...(assetLibraryId === undefined || assetLibraryId.length === 0
      ? {}
      : { assetLibraryId }),
  };
}

function playbackRevisionSelection(value: string, assetLibraryId?: string) {
  if (!/^artifact-revision_[A-Za-z0-9][A-Za-z0-9._~-]{0,220}$/u.test(value))
    throw new Error("产物修订版身份无效");
  return artifactRevisionSelection(value, assetLibraryId);
}

function attachmentDisposition(filename: string): string {
  const fallback =
    filename
      .replaceAll(/[^\u0020-\u007e]|["\\/]/gu, "_")
      .trim()
      .slice(0, 150) || "artifact";
  const extended = encodeURIComponent(filename).replaceAll(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

function requestCancellation(signal: AbortSignal): ByteReadCancellation {
  return {
    get cancelled() {
      return signal.aborted;
    },
    onCancel(listener) {
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
      return () => signal.removeEventListener("abort", listener);
    },
  };
}

/** 把 Product Application 的有界租约映射为附件 body；这里从不接收或解析服务器路径。 */
export async function artifactDownloadResponse(
  revisionId: string,
  request: Request,
  assetLibraryId?: string,
): Promise<Response> {
  const selection = artifactRevisionSelection(revisionId, assetLibraryId);
  const descriptor =
    await configuredProductApplication().prepareArtifactDownload(selection);
  return await artifactByteResponse(selection, descriptor, request, true);
}

/** 只交付当前生效图片角色选中的本地材料，字节授权沿既有观察文件确认链。 */
export async function observedArtworkResponse(
  subjectId: string,
  locationId: string,
  request: Request,
  assetLibraryId?: string,
): Promise<Response> {
  const facts = await application().inspectCurrentCatalogueSubject(
    subjectId,
    undefined,
    assetLibraryId,
  );
  const selected = facts?.descriptions.some((description) =>
    description.artifactRoles.some(
      (role) =>
        role.locationId === locationId &&
        ["asset.primary-cover", "asset.material-image"].includes(role.role),
    ),
  );
  if (!selected)
    return Response.json({ error: "此图片当前不可用" }, { status: 404 });
  const download =
    await configuredProductApplication().observedFileDownloadForLocation(
      locationId,
    );
  if (download === undefined)
    return Response.json({ error: "此图片当前不可用" }, { status: 404 });
  const response = await confirmedObservedArtifactDownloadResponse(
    download.selectionId,
    request,
    assetLibraryId,
  );
  response.headers.set("content-disposition", "inline");
  return response;
}

async function artifactByteResponse(
  selection: {
    readonly artifactRevisionId: string;
    readonly assetLibraryId?: string;
  },
  descriptor: Awaited<
    ReturnType<ProductApplication["prepareArtifactDownload"]>
  >,
  request: Request,
  attachment: boolean,
): Promise<Response> {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-length": String(descriptor.byteLength),
    "content-type": descriptor.mediaType,
    etag: `"sha256:${descriptor.blobDigest}"`,
  });
  if (attachment)
    headers.set(
      "content-disposition",
      attachmentDisposition(descriptor.suggestedFilename),
    );
  const etag = headers.get("etag")!;
  const ifMatch = request.headers.get("if-match");
  if (ifMatch !== null) {
    const tags = parseEntityTagList(ifMatch);
    if (tags === undefined) return jsonRequestError("条件请求格式无效", 400);
    if (
      tags !== "*" &&
      !tags.some((tag) => !tag.weak && entityTagText(tag) === etag)
    ) {
      headers.delete("content-length");
      return new Response(null, { status: 412, headers });
    }
  }
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    const tags = parseEntityTagList(ifNoneMatch);
    if (tags === undefined) return jsonRequestError("条件请求格式无效", 400);
    if (tags === "*" || tags.some((tag) => entityTagText(tag) === etag))
      return new Response(null, { status: 304, headers });
  }
  let interval =
    descriptor.byteLength === 0
      ? undefined
      : { startInclusive: 0, endInclusive: descriptor.byteLength - 1 };
  let status = 200;
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  if (
    range !== null &&
    (ifRange === null || (!ifRange.startsWith("W/") && ifRange === etag))
  ) {
    const parsed = parseSingleByteRange(range, descriptor.byteLength);
    if (parsed.status === "malformed")
      return jsonRequestError("字节范围格式无效", 400);
    if (parsed.status === "unsatisfied") {
      headers.set("content-range", `bytes */${descriptor.byteLength}`);
      headers.delete("content-length");
      return new Response(null, { status: 416, headers });
    }
    if (parsed.status === "partial") {
      interval = parsed.interval;
      status = 206;
      headers.set(
        "content-range",
        `bytes ${interval.startInclusive}-${interval.endInclusive}/${descriptor.byteLength}`,
      );
      headers.set(
        "content-length",
        String(interval.endInclusive - interval.startInclusive + 1),
      );
    }
  }
  if (interval === undefined) return new Response(null, { status, headers });
  const lease = await configuredProductApplication().openArtifactBytes({
    selection,
    expectedBlobDigest: descriptor.blobDigest,
    interval,
  });
  const cancellation = requestCancellation(request.signal);
  let settled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled) return;
      try {
        const next = await lease.read({
          maximumBytes: artifactDownloadChunkBytes,
          cancellation,
        });
        if (next.bytes.byteLength > 0) controller.enqueue(next.bytes);
        if (next.done) {
          settled = true;
          await lease.close("completed");
          controller.close();
        }
      } catch (error) {
        settled = true;
        try {
          await lease.close(
            cancellation.cancelled ? "client-cancelled" : "failed",
          );
        } catch {
          // body 的主读取错误保持可见，资源清理失败不能把它改写为另一响应。
        }
        controller.error(error);
      }
    },
    async cancel() {
      if (settled) return;
      settled = true;
      await lease.close("client-cancelled");
    },
  });
  return new Response(body, { status, headers });
}

export async function playbackPlanResponse(
  revisionId: string,
  value: unknown,
  assetLibraryId?: string,
): Promise<
  | { readonly status: "incompatible"; readonly reason: string }
  | {
      readonly status: "ready";
      readonly revisionId: string;
      readonly blobDigest: string;
      readonly rendition: {
        readonly kind: "direct";
        readonly mediaType: string;
        readonly codecs: readonly string[];
        readonly byteLength: number;
      };
      readonly mediaUrl: string;
    }
> {
  const selection = playbackRevisionSelection(revisionId, assetLibraryId);
  const input = playbackPlanInput(value);
  const result = await configuredProductApplication().planPlayback(
    selection,
    input.consumer,
    input.preferences,
  );
  if (result.status === "incompatible") return result;
  const library =
    assetLibraryId === undefined || assetLibraryId.length === 0
      ? ""
      : `?library=${encodeURIComponent(assetLibraryId)}`;
  return {
    ...result,
    mediaUrl: `/api/playback-media/${encodeURIComponent(result.revisionId)}/${result.blobDigest}${library}`,
  };
}

export async function playbackMediaResponse(
  revisionId: string,
  blobDigest: string,
  request: Request,
  assetLibraryId?: string,
): Promise<Response> {
  if (!/^[a-f0-9]{64}$/u.test(blobDigest))
    throw new ArtifactByteAccessError("artifact-integrity-failed");
  const selection = playbackRevisionSelection(revisionId, assetLibraryId);
  const descriptor =
    await configuredProductApplication().prepareArtifactDownload(selection);
  if (descriptor.blobDigest !== blobDigest)
    throw new ArtifactByteAccessError("artifact-integrity-failed");
  return await artifactByteResponse(selection, descriptor, request, false);
}

function playbackPlanInput(value: unknown): {
  readonly consumer: ConsumerPlaybackCapabilities;
  readonly preferences: PlaybackPreferences;
} {
  const object = strictObject(value, ["consumer", "preferences"]);
  const consumerObject = strictObject(object.consumer, [
    "contractVersion",
    "supportsByteRanges",
    "media",
  ]);
  if (
    consumerObject.contractVersion !== "consumer-playback/1" ||
    typeof consumerObject.supportsByteRanges !== "boolean" ||
    !Array.isArray(consumerObject.media) ||
    consumerObject.media.length > 128
  )
    throw new Error("消费者播放能力无效");
  const media = consumerObject.media.map((candidate) => {
    const entry = strictObject(candidate, ["mediaType", "codecs"], ["codecs"]);
    if (
      typeof entry.mediaType !== "string" ||
      !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(entry.mediaType.trim()) ||
      (entry.codecs !== undefined &&
        (!Array.isArray(entry.codecs) ||
          entry.codecs.length > 32 ||
          !entry.codecs.every(
            (codec) =>
              typeof codec === "string" &&
              codec.trim().length > 0 &&
              codec.length <= 127,
          )))
    )
      throw new Error("消费者播放能力无效");
    return {
      mediaType: entry.mediaType,
      ...(entry.codecs === undefined
        ? {}
        : { codecs: entry.codecs as string[] }),
    };
  });
  const preferencesObject = strictObject(
    object.preferences,
    ["audioTrackId", "subtitleTrackId", "quality"],
    ["audioTrackId", "subtitleTrackId", "quality"],
  );
  const optionalText = (candidate: unknown) =>
    candidate === undefined ||
    (typeof candidate === "string" &&
      candidate.trim().length > 0 &&
      candidate.length <= 256);
  if (
    !optionalText(preferencesObject.audioTrackId) ||
    !optionalText(preferencesObject.subtitleTrackId) ||
    (preferencesObject.quality !== undefined &&
      preferencesObject.quality !== "source")
  )
    throw new Error("播放偏好无效");
  return {
    consumer: {
      contractVersion: "consumer-playback/1",
      supportsByteRanges: consumerObject.supportsByteRanges,
      media,
    },
    preferences: {
      ...(preferencesObject.audioTrackId === undefined
        ? {}
        : { audioTrackId: preferencesObject.audioTrackId as string }),
      ...(preferencesObject.subtitleTrackId === undefined
        ? {}
        : { subtitleTrackId: preferencesObject.subtitleTrackId as string }),
      ...(preferencesObject.quality === undefined
        ? {}
        : { quality: "source" as const }),
    },
  };
}

function strictObject(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("播放计划输入无效");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !keys.includes(key)) ||
    keys.some((key) => !optional.includes(key) && !(key in object))
  )
    throw new Error("播放计划输入无效");
  return object;
}

export async function confirmedObservedArtifactDownloadResponse(
  observedFileSelectionId: string,
  request: Request,
  assetLibraryId?: string,
): Promise<Response> {
  if (
    !/^observed-file-selection_1_[a-f0-9]{64}$/u.test(observedFileSelectionId)
  )
    return jsonRequestError("观察文件选择已失效", 400);
  const confirmed =
    await configuredProductApplication().confirmObservedFileRevision({
      observedFileSelectionId,
      ...(assetLibraryId === undefined || assetLibraryId.length === 0
        ? {}
        : { assetLibraryId }),
    });
  return await artifactDownloadResponse(
    confirmed.artifactRevisionId,
    request,
    assetLibraryId,
  );
}

/** Application 交付错误已公开的业务码：分类只认识这份封闭清单。 */
const artifactByteAccessErrorCodes = [
  "artifact-revision-not-found",
  "artifact-bytes-unavailable",
  "artifact-location-revoked",
  "artifact-bytes-changed",
  "artifact-integrity-failed",
  "client-cancelled",
  "application-shutting-down",
  "byte-read-in-progress",
] as const satisfies readonly ArtifactByteAccessError["code"][];

const observedRevisionConfirmationErrorCodes = [
  "observed-selection-stale",
  "confirmation-stale",
  "confirmation-commit-failed",
  "artifact-bytes-changed",
  "artifact-location-revoked",
] as const satisfies readonly ObservedRevisionConfirmationError["code"][];

/**
 * 服务端 SSR 分包会把这两个 Application 错误类再内联一份，而产品经外部 `@digital/composition`
 * 载入的是另一构造器身份，`instanceof` 因此跨不过两边，业务错误会被统一压成兜底 409。
 * 分类沿既有合同改为「错误名 + 封闭业务码表」判定：只有下面清单里的码会被原样外送，
 * 未知名称、未知码与非错误对象仍走既有兜底，绝不外送 message、堆栈或私有路径。
 */
function knownDeliveryErrorCode<Code extends string>(
  error: unknown,
  name: string,
  codes: readonly Code[],
): Code | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  if (candidate.name !== name) return undefined;
  return codes.find((code) => code === candidate.code);
}

export function artifactDeliveryErrorResponse(error: unknown): Response {
  if (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      ["播放计划输入无效", "消费者播放能力无效", "播放偏好无效"].includes(
        error.message,
      ))
  )
    return Response.json({ error: "播放计划输入无效" }, { status: 400 });
  if (error instanceof Error && error.message === "产物修订版身份无效")
    return Response.json({ error: error.message }, { status: 400 });
  const byteAccessCode = knownDeliveryErrorCode(
    error,
    "ArtifactByteAccessError",
    artifactByteAccessErrorCodes,
  );
  if (byteAccessCode !== undefined) {
    const status =
      byteAccessCode === "artifact-revision-not-found"
        ? 404
        : byteAccessCode === "application-shutting-down"
          ? 503
          : 409;
    return Response.json({ error: byteAccessCode }, { status });
  }
  const confirmationCode = knownDeliveryErrorCode(
    error,
    "ObservedRevisionConfirmationError",
    observedRevisionConfirmationErrorCodes,
  );
  if (confirmationCode !== undefined) {
    return Response.json(
      { error: confirmationCode },
      { status: confirmationCode === "confirmation-commit-failed" ? 503 : 409 },
    );
  }
  return Response.json(
    { error: "artifact-bytes-unavailable" },
    { status: 409 },
  );
}

type ParsedEntityTag = {
  readonly weak: boolean;
  readonly opaque: string;
};

function parseEntityTagList(
  value: string,
): readonly ParsedEntityTag[] | "*" | undefined {
  let index = skipOws(value, 0);
  if (value[index] === "*")
    return skipOws(value, index + 1) === value.length ? "*" : undefined;
  const tags: ParsedEntityTag[] = [];
  while (index < value.length) {
    let weak = false;
    if (value.startsWith("W/", index)) {
      weak = true;
      index += 2;
    }
    if (value[index] !== '"') return undefined;
    index += 1;
    const start = index;
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index);
      if (
        !(
          code === 0x21 ||
          (code >= 0x23 && code <= 0x7e) ||
          (code >= 0x80 && code <= 0xff)
        )
      )
        return undefined;
      index += 1;
    }
    if (value[index] !== '"') return undefined;
    tags.push({ weak, opaque: value.slice(start, index) });
    index = skipOws(value, index + 1);
    if (index === value.length) return tags;
    if (value[index] !== ",") return undefined;
    index = skipOws(value, index + 1);
    if (index === value.length) return undefined;
  }
  return tags.length === 0 ? undefined : tags;
}

function entityTagText(tag: ParsedEntityTag): string {
  return `"${tag.opaque}"`;
}

function skipOws(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t") index += 1;
  return index;
}

function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/gu, "");
}

type ParsedRange =
  | { readonly status: "ignored" }
  | { readonly status: "malformed" }
  | { readonly status: "unsatisfied" }
  | {
      readonly status: "partial";
      readonly interval: {
        readonly startInclusive: number;
        readonly endInclusive: number;
      };
    };

function parseSingleByteRange(value: string, length: number): ParsedRange {
  const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=(.*)$/u.exec(value);
  if (match === null) return { status: "malformed" };
  if (match[1]!.toLowerCase() !== "bytes") return { status: "ignored" };
  const members = match[2]!.split(",").map(trimOws);
  if (members.length !== 1) {
    return members.every(validByteRangeMember)
      ? { status: "unsatisfied" }
      : { status: "malformed" };
  }
  const member = members[0]!;
  if (!validByteRangeSyntax(member)) return { status: "malformed" };
  if (length === 0) return { status: "unsatisfied" };
  const [first, last] = member.split("-") as [string, string];
  if (first.length === 0) {
    const suffix = boundedDecimal(last);
    if (suffix === undefined) return { status: "malformed" };
    if (suffix === 0) return { status: "unsatisfied" };
    return {
      status: "partial",
      interval: {
        startInclusive: Math.max(0, length - suffix),
        endInclusive: length - 1,
      },
    };
  }
  const start = boundedDecimal(first);
  if (start === undefined) return { status: "malformed" };
  if (start >= length) return { status: "unsatisfied" };
  if (last.length === 0)
    return {
      status: "partial",
      interval: { startInclusive: start, endInclusive: length - 1 },
    };
  const requestedEnd = boundedDecimal(last);
  if (requestedEnd === undefined || requestedEnd < start)
    return { status: "malformed" };
  return {
    status: "partial",
    interval: {
      startInclusive: start,
      endInclusive: Math.min(requestedEnd, length - 1),
    },
  };
}

function validByteRangeMember(value: string): boolean {
  if (!validByteRangeSyntax(value)) return false;
  const [first, last] = value.split("-") as [string, string];
  if (first.length === 0) return boundedDecimal(last) !== undefined;
  const start = boundedDecimal(first);
  if (start === undefined) return false;
  if (last.length === 0) return true;
  const end = boundedDecimal(last);
  return end !== undefined && end >= start;
}

function validByteRangeSyntax(value: string): boolean {
  return /^(?:[0-9]+-[0-9]*|-[0-9]+)$/u.test(value);
}

function boundedDecimal(value: string): number | undefined {
  try {
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

function jsonRequestError(message: string, status: 400): Response {
  return Response.json({ error: message }, { status });
}

// 普通读取直接进入 Presentation；此处只添加交付地址。

function deliveryFactAddresses(
  facts: AssetViewFacts,
  assetLibraryId?: string,
): AssetViewFacts {
  const library =
    assetLibraryId === undefined || assetLibraryId.length === 0
      ? ""
      : `?library=${encodeURIComponent(assetLibraryId)}`;
  return {
    ...facts,
    descriptions: facts.descriptions.map((description) => ({
      ...description,
      artifactRoles: description.artifactRoles.map((role) => {
        // 只为读取层已判定可用的图片补充交付地址；不可用内容不凭空造 URL。
        if (role.address === undefined) return role;
        const location = facts.locations.find(
          (location) => location.id === role.locationId,
        );
        return location?.kind === "observed"
          ? {
              ...role,
              address: `/api/observed-artwork/${encodeURIComponent(facts.id)}/${encodeURIComponent(location.id)}${library}`,
            }
          : role;
      }),
    })),
  };
}

async function withCurrentFileDownloads(
  facts: AssetViewFacts,
  assetLibraryId?: string,
): Promise<AssetViewFacts> {
  const library =
    assetLibraryId === undefined || assetLibraryId.length === 0
      ? ""
      : `?library=${encodeURIComponent(assetLibraryId)}`;
  const locations = await Promise.all(
    facts.locations.map(async (location) => {
      if (location.kind !== "observed" || location.id === undefined)
        return location;
      const observedDownload =
        await configuredProductApplication().observedFileDownloadForLocation(
          location.id,
        );
      if (observedDownload !== undefined)
        return {
          ...location,
          byteLength: observedDownload.byteLength,
          downloadUrl: `/api/observed-file-downloads/${encodeURIComponent(observedDownload.selectionId)}${library}`,
        };
      return location.content.status !== "confirmed"
        ? location
        : {
            ...location,
            downloadUrl:
              "/api/artifact-downloads/" +
              encodeURIComponent(location.content.target.revisionId) +
              library,
          };
    }),
  );
  return { ...facts, locations };
}

/**
 * Automation 仅在 subject 被接受后使用这份由 delivery 持有的规划规则。返回 Application 的值
 * 是中立 contract；任何 View 或来源专属输出模型都不能越过边界。coordinate 是这份规则的稳定身份：
 * 自动化库扫描父在创建时冻结它，之后只有坐标精确相等的部署才允许继续补完那份计划，所以改变
 * 规则本体必须同时改这里，未改变的旧父才会如实中断而不是被今日规则顶替。
 */
export const informationRequirementForAutomatedAcceptedSubject = {
  coordinate: "information-planner:asset-view/1",
  requirementForAcceptedSubject: (accepted: AssetViewFacts) =>
    informationRequirementForAssetView(accepted),
} satisfies AutomatedInformationPlanner;

/**
 * Presentation 根据当前中立 facts 选择 requirement。Delivery 不会按来源身份分支，
 * 也不会要求 Application 提供所有已交付 View 可选输入的全局并集。
 */
async function informationRequirementForSubject(
  subject: Pick<ProductAssetRefresh, "inspectCurrentCatalogueSubject">,
  subjectId: string,
  fallbackSourceAssociation?: AssetViewFacts["recognitionSourceAssociation"],
) {
  const facts = await subject.inspectCurrentCatalogueSubject(subjectId);
  return informationRequirementForAssetView(
    facts ?? {
      id: subjectId,
      sourceAssociations:
        fallbackSourceAssociation === undefined
          ? []
          : [fallbackSourceAssociation],
      descriptions: [],
    },
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
  assetLibraryId?: string,
): CatalogueSnapshot["assets"] {
  return projectCatalogue(
    facts.map((fact) => deliveryFactAddresses(fact, assetLibraryId)),
  ).map((view) =>
    "works" in view ? deliveryBangumiView(view) : deliveryAssetView(view),
  );
}

/** 详情按稳定主体读取，不依赖首页恰好加载了哪一页。库语境缺失时只接受唯一归属。 */
export async function catalogueSubject(
  id: string,
  assetLibraryId?: string,
): Promise<CatalogueSubjectResponse | undefined> {
  if (productApplication?.configured !== true) return undefined;
  const library =
    assetLibraryId === undefined || assetLibraryId.length === 0
      ? undefined
      : assetLibraryId;
  const direct = await application().inspectCurrentCatalogueSubject(
    id,
    undefined,
    library,
  );
  if (direct !== undefined) {
    const requirement = informationRequirementForAssetView(direct);
    const contextual =
      requirement.metadataUsageContext === "asset.ordinary"
        ? direct
        : ((await application().inspectCurrentCatalogueSubject(
            id,
            requirement,
            library,
          )) ?? direct);
    const readiness = await application().fulfillInformation({
      selection: { subjectIds: [id] },
      requirement,
      ...(library === undefined ? {} : { assetLibraryId: library }),
    });
    const informationReadiness = readiness.subjects.find(
      (subject) => subject.subjectId === id,
    );
    const facts = await withCurrentFileDownloads(contextual, library);
    const revisionIds = facts.locations.flatMap((location) =>
      location.content.status === "confirmed"
        ? [location.content.target.revisionId]
        : [],
    );
    const interactionStates =
      await configuredProductApplication().interactions.read(revisionIds);
    return {
      asset: deliveryAssetView(
        projectAssetView(
          deliveryFactAddresses(
            {
              ...facts,
              interactionStates,
              ...(informationReadiness === undefined
                ? {}
                : { informationReadiness }),
            },
            library,
          ),
        ),
      ),
      ...(await subjectSourceRetries(id)),
      ...(await subjectLibraryChoices(id)),
    };
  }
  const items = libraryItems(
    await application().listCurrentCatalogueIndex(
      libraryIndexMetadataProperties,
      library,
    ),
  );
  const item = items.find(
    (entry) => entry.view.id === id || entry.subjectIds.includes(id),
  );
  if (item === undefined) return undefined;
  const assets = await catalogueViewsForSubjects(item.subjectIds, {
    withFileDownloads: true,
    assetLibraryId: library,
  });
  const asset = assets.find((view) => view.id === item.view.id);
  if (asset === undefined) return undefined;
  return {
    asset,
    ...("works" in asset && asset.id !== id ? { selectedEpisodeId: id } : {}),
    ...(await subjectSourceRetries(id)),
    ...(await subjectLibraryChoices(id)),
  };
}

/** 无采集地投影该主体已终止的失败来源补充，供页面重开/刷新展示友好"再次获取"；不外显地址或内部坐标。 */
async function subjectSourceRetries(subjectId: string): Promise<{
  readonly sourceRetries?: readonly CatalogueSubjectSourceRetry[];
}> {
  const retries = (
    await application().inspectRetryableSourceEnrichments(subjectId)
  ).map((item) => ({
    executionId: item.executionId,
    sourceIdentity: item.sourceIdentity,
    canRetry: item.canRetry,
  }));
  return retries.length === 0 ? {} : { sourceRetries: retries };
}

/**
 * 无采集地把多库共享主体的归属库投影成友好的名称选项，供定向页显式选择；唯一或零归属
 * 不返回选项，交由既有能力沿用明确库语境或耐久唯一归属自动解析，绝不任选其一或外显内部坐标。
 */
async function subjectLibraryChoices(subjectId: string): Promise<{
  readonly libraryChoices?: readonly CatalogueSubjectLibraryChoice[];
}> {
  const ownerIds = await application().assetLibraryIdsOwningSubject(subjectId);
  if (ownerIds.length < 2) return {};
  const libraries = await application().assetLibraries.list();
  const choices = libraries
    .filter((library) => ownerIds.includes(library.id))
    .map(({ id, displayName }) => ({ id, displayName }));
  return choices.length >= 2 ? { libraryChoices: choices } : {};
}

async function catalogueViewsForSubjects(
  subjectIds: readonly string[],
  options: {
    readonly withFileDownloads?: boolean;
    readonly assetLibraryId?: string | undefined;
  } = {},
) {
  const facts: AssetViewFacts[] = [];
  for (let offset = 0; offset < subjectIds.length; offset += 100) {
    const batch = subjectIds.slice(offset, offset + 100);
    const page = await application().listCurrentCataloguePage({
      limit: batch.length,
      subjectIds: batch,
      ...(options.assetLibraryId === undefined
        ? {}
        : { assetLibraryId: options.assetLibraryId }),
    });
    for (const accepted of page.items) {
      const viewFacts = accepted;
      facts.push(
        options.withFileDownloads === true
          ? await withCurrentFileDownloads(viewFacts, options.assetLibraryId)
          : viewFacts,
      );
    }
  }
  return await projectCatalogueAssetsForCurrentUser(
    facts,
    options.assetLibraryId,
  );
}

async function projectCatalogueAssetsForCurrentUser(
  facts: readonly AssetViewFacts[],
  assetLibraryId?: string,
): Promise<CatalogueSnapshot["assets"]> {
  const contexts = new Map<
    string,
    { requirement: InformationRequirement; facts: AssetViewFacts[] }
  >();
  for (const fact of facts) {
    const requirement = informationRequirementForAssetView(fact);
    const context = contexts.get(requirement.metadataUsageContext) ?? {
      requirement,
      facts: [],
    };
    if (
      fact.descriptions.some(
        (description) =>
          description.metadataUsageContext !== requirement.metadataUsageContext,
      )
    )
      context.facts.push(fact);
    contexts.set(requirement.metadataUsageContext, context);
  }
  const contextual = new Map(facts.map((fact) => [fact.id, fact]));
  for (const { requirement, facts: selected } of contexts.values()) {
    for (let offset = 0; offset < selected.length; offset += 100) {
      const batch = selected.slice(offset, offset + 100);
      const page = await application().listCurrentCataloguePage({
        subjectIds: batch.map((fact) => fact.id),
        limit: batch.length,
        informationRequirement: requirement,
        ...(assetLibraryId === undefined ? {} : { assetLibraryId }),
      });
      for (const fact of page.items) {
        const original = contextual.get(fact.id)!;
        contextual.set(fact.id, {
          ...fact,
          locations: fact.locations.map((location) => {
            const downloadUrl = original.locations.find(
              (candidate) => candidate.id === location.id,
            )?.downloadUrl;
            return downloadUrl === undefined
              ? location
              : { ...location, downloadUrl };
          }),
        });
      }
    }
  }
  const ready = await Promise.all(
    [...contextual.values()].map(async (fact) => {
      const readiness = await application().fulfillInformation({
        selection: { subjectIds: [fact.id] },
        requirement: informationRequirementForAssetView(fact),
        ...(assetLibraryId === undefined ? {} : { assetLibraryId }),
      });
      const informationReadiness = readiness.subjects.find(
        (subject) => subject.subjectId === fact.id,
      );
      return informationReadiness === undefined
        ? fact
        : { ...fact, informationReadiness };
    }),
  );
  const revisionIds = ready.flatMap((fact) =>
    fact.locations.flatMap((location) =>
      location.content.status === "confirmed"
        ? [location.content.target.revisionId]
        : [],
    ),
  );
  const interactionStates =
    await configuredProductApplication().interactions.read(revisionIds);
  return projectCatalogueAssets(
    ready.map((fact) => ({ ...fact, interactionStates })),
    assetLibraryId,
  );
}

export async function saveCurrentPlaybackInteraction(input: {
  readonly artifactRevisionId: string;
  readonly positionMilliseconds: number;
  readonly completed: boolean;
}): Promise<void> {
  await configuredProductApplication().interactions.save(input);
}

function folderName(directory: string): string {
  return directory.split(/[\\/]/u).filter(Boolean).at(-1) || "已选择的文件夹";
}

/** 系统代为停用时给使用者的中文原因；用户自己停用没有这条说明。 */
function automationDisabledReasonText(
  reason: AutomationDisabledReason | undefined,
): string | undefined {
  switch (reason) {
    case "observed-root-revoked":
      return "这个目录已从资产库移除，自动刷新已停用";
    case "observed-root-unavailable":
      return "暂时打不开这个目录，恢复访问后可以重新启用";
    case "prerequisite-unavailable":
      return "需要的信息暂时取不到，可以稍后重新启用";
    case "invalid-configuration":
      return "计划记录的目录配置已失效，请重新设置自动刷新";
    case undefined:
      return undefined;
  }
}

type AutomationIntentView = {
  readonly id: string;
  readonly scope: {
    readonly assetLibraryId?: string;
    readonly observedRootId: string;
    readonly relativeScope: string;
  };
  readonly enabled: boolean;
  readonly disabledReason?: AutomationDisabledReason;
  readonly intervalMilliseconds: number;
  readonly acceptTrusted: boolean;
};

/**
 * 计划标题只由资产库名与目录名拼成。同一份清单里每个库最多查一次，编号与容器路径
 * 因此没有机会流到界面上。
 */
function createAutomationNameLookup(subject: ProductWorkflowOperations) {
  const libraries = new Map<string, string>();
  const directories = new Map<string, string>();
  return async (
    intent: AutomationIntentView,
  ): Promise<{ readonly library: string; readonly directory: string }> => {
    // 名称必须在读完本库目录之后才取，否则第一条计划会把仍在清单里的目录误报成已移除。
    const assetLibraryId = intent.scope.assetLibraryId;
    if (assetLibraryId !== undefined && !libraries.has(assetLibraryId)) {
      const library = await subject.assetLibraries.get(assetLibraryId);
      libraries.set(assetLibraryId, library?.displayName ?? "已移除的资产库");
      for (const view of await subject.assetLibraries.directoryViews(
        assetLibraryId,
      ))
        directories.set(view.observedRootId, view.displayName);
    }
    return {
      library:
        assetLibraryId === undefined
          ? "已移除的资产库"
          : (libraries.get(assetLibraryId) ?? "已移除的资产库"),
      directory: directories.get(intent.scope.observedRootId) ?? "已移除的目录",
    };
  };
}

async function toAutomationViews(
  subject: ProductWorkflowOperations,
  intents: readonly AutomationIntentView[],
): Promise<readonly AutomationViewModel[]> {
  const names = createAutomationNameLookup(subject);
  const views: AutomationViewModel[] = [];
  for (const intent of intents)
    views.push(await toAutomationView(intent, names));
  return views;
}

async function toAutomationView(
  intent: AutomationIntentView,
  names: (
    intent: AutomationIntentView,
  ) => Promise<{ readonly library: string; readonly directory: string }>,
): Promise<AutomationViewModel> {
  const { library, directory } = await names(intent);
  const disabledReason = automationDisabledReasonText(
    intent.enabled ? undefined : intent.disabledReason,
  );
  return {
    id: intent.id,
    ...(intent.scope.assetLibraryId === undefined
      ? {}
      : { assetLibraryId: intent.scope.assetLibraryId }),
    folder: `${library} · ${directory}`,
    observedRootId: intent.scope.observedRootId,
    relativeScope: intent.scope.relativeScope,
    enabled: intent.enabled,
    intervalMilliseconds: intent.intervalMilliseconds,
    acceptTrusted: intent.acceptTrusted,
    ...(disabledReason === undefined ? {} : { disabledReason }),
  };
}

// 中断原因里带着旧版坐标、能力版本与载荷字段名，那些只留在耐久执行记录里供诊断；
// 界面这里换成说清「为什么没法继续」的普通解释，下一步动作仍走既有通道。
function automationRecoveryReasonText(reason: string): string {
  if (reason.includes("旧版未登记文件位置范围"))
    return "这次刷新用的文件夹范围是旧版记录，没有登记到具体文件位置，无法安全继续";
  if (reason.includes("实现或契约不兼容"))
    return "这次刷新所用的功能版本已经更新，旧记录对不上，无法安全继续";
  if (reason.includes("版本化输入"))
    return "这次刷新的记录缺少继续所需的信息，无法安全继续";
  // 受控来源在没有匹配条目时会拒绝请求；内部边界名、方法与请求地址只留在耐久
  // 执行记录里供诊断，界面这里只说明来源内容当前取不到，不泄漏这些技术细节。
  if (reason.includes("受控来源拒绝"))
    return "这次刷新所需的外部来源内容尚未在当前环境准备，暂时无法取得";
  return reason;
}

function toAutomationRecoveryView(
  item: RecoveryClassification,
): AutomationRecoveryViewModel {
  return {
    status:
      item.category === "waiting"
        ? "等待你的确认"
        : item.category === "continuable"
          ? "正在继续"
          : item.category === "wrap-up"
            ? "正在补齐登记"
            : "已中断",
    subject: item.subject,
    ...(item.reason === undefined
      ? {}
      : { reason: automationRecoveryReasonText(item.reason) }),
    ...(item.nextAction === undefined ? {} : { nextAction: item.nextAction }),
  };
}

async function activeObservedRootViews(
  subject: ProductWorkflowOperations,
): Promise<readonly ObservedRootViewModel[]> {
  return await intakeDirectoryOptions(subject);
}

/**
 * 普通执行交付沿用同一份友好解释：同一条中断在设置页、工作流历史和单条记录里说法一致，
 * 内部坐标只留在耐久记录本身。
 */
function deliveryReasonText(reason: string | undefined): string | undefined {
  return reason === undefined ? reason : automationRecoveryReasonText(reason);
}

export function deliveryExecution(
  inspection: Awaited<ReturnType<ProductWorkflowOperations["inspect"]>>,
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
    reason: deliveryReasonText(inspection.execution.reason),
    acceptedAssetId: inspection.execution.acceptedAssetId,
    dispositions: inspection.execution.dispositions.map((item) => ({
      key: item.key,
      status: item.status,
      reason: deliveryReasonText(item.reason),
    })),
    ...(inspection.execution.targetDispositions === undefined
      ? {}
      : {
          targets: inspection.execution.targetDispositions.map(
            (item, index) => ({
              key: item.key,
              // 主体内部 ID 只留在传输键里，可见标签用序号区分同一执行的多个主体。
              label:
                item.target.kind === "subject"
                  ? `内容 ${index + 1}`
                  : `文件范围 ${folderName(item.target.root)}`,
              status: item.status,
              reason: deliveryReasonText(item.reason),
              sourceRecordIds: item.sourceRecordIds,
              outputReferences: item.outputReferences,
            }),
          ),
        }),
    ...(inspection.itemResults === undefined
      ? {}
      : {
          items: inspection.itemResults.map((item) => ({
            key: item.key,
            relativePaths: item.relativePaths,
            outcome: item.outcome,
            reason: deliveryReasonText(item.reason),
            recognition: item.recognition,
            acceptedAssetId: item.accepted?.entity.id,
            acceptedSource:
              item.accepted?.recognitionSourceAssociation?.nativeAddress,
          })),
        }),
    recognition: inspection.recognition,
    ...(inspection.changeImpactPreview?.facts === undefined
      ? {}
      : {
          preview: {
            id: inspection.changeImpactPreview.id,
            status: inspection.changeImpactPreview.status,
            blockingConditions:
              inspection.changeImpactPreview.blockingConditions,
            current: deliveryAssetView(
              projectAssetView(
                deliveryFactAddresses(
                  inspection.changeImpactPreview.facts.current,
                ),
              ),
            ),
            proposed: deliveryAssetView(
              projectAssetView(
                deliveryFactAddresses(
                  inspection.changeImpactPreview.facts.projected,
                ),
              ),
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

type CatalogueSurfaceRequest =
  | {
      readonly surface: "current-catalogue";
      readonly page?: CurrentCataloguePageRequest;
      readonly query?: LibraryQuery;
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
  const configured = productApplication?.configured === true;
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
    if (input.query !== undefined) {
      const selected = selectLibraryPage(
        await subject.listCurrentCatalogueIndex(
          libraryIndexMetadataProperties,
          input.query.assetLibraryId,
        ),
        input.query,
        input.page,
      );
      const views = await catalogueViewsForSubjects(selected.subjectIds, {
        assetLibraryId: input.query.assetLibraryId,
      });
      const items = new Map(views.map((item) => [item.id, item]));
      return {
        surface: input.surface,
        configured,
        assets: selected.ids.flatMap((id) => {
          const item = items.get(id);
          return item === undefined ? [] : [item];
        }),
        total: selected.total,
        categories: selected.categories,
        pagination: selected.pagination,
      };
    }
    const page = await subject.listCurrentCataloguePage(input.page);
    const facts = page.items;
    return {
      surface: input.surface,
      configured,
      assets: await projectCatalogueAssetsForCurrentUser(facts),
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
    automation: await toAutomationViews(
      subject,
      await subject.listAutomationIntents(),
    ),
  };
}

export async function catalogueSnapshot(
  input: CatalogueSnapshotRequest = {},
): Promise<CatalogueSnapshot> {
  if (productApplication?.configured !== true) {
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
  const facts = currentCatalogue.items;
  return {
    configured: true,
    assets: await projectCatalogueAssetsForCurrentUser(facts),
    executions: history.items
      .map(deliveryExecution)
      .filter((item): item is NonNullable<typeof item> => item !== undefined),
    attention: attention.items.map(deliveryAttention),
    automation: await toAutomationViews(subject, automation),
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
  readonly assetLibraryId?: string;
  readonly observedRootId?: string;
  readonly relativeScope?: string;
  readonly assetId?: string;
  readonly target?: { readonly subjectId: string };
  readonly operation?: "metadata-refresh" | "rescrape";
  readonly intent?: "scan-now" | "metadata-refresh";
  readonly rescrape?: boolean;
  readonly directedSourceAddress?: string;
  readonly directedSourceIdentity?: string;
  readonly directedSourceInput?: Readonly<Record<string, string>>;
  readonly acceptTrusted?: boolean;
}): Promise<{ readonly id: string }> {
  return await startRefreshWith(application(), input, executions());
}

export function sourceInputRequirements() {
  return application().sourceInputRequirements();
}

export async function startSourceEnrichment(value: unknown) {
  const input = settingsObject(value);
  const subjectId = settingsText(input, "subjectId");
  const sourceIdentity = settingsText(input, "sourceIdentity");
  if (
    typeof input.sourceInput !== "object" ||
    input.sourceInput === null ||
    Array.isArray(input.sourceInput) ||
    !Object.values(input.sourceInput).every((item) => typeof item === "string")
  )
    throw new Error("来源输入无效");
  return await executions().invoke(async (control) => {
    await application().enrichSource({
      subjectId,
      sourceIdentity,
      sourceInput: input.sourceInput as Readonly<Record<string, string>>,
      informationRequirement: generalAssetViewInformationRequirement,
      ...(typeof input.assetLibraryId === "string" &&
      input.assetLibraryId.length > 0
        ? { assetLibraryId: input.assetLibraryId }
        : {}),
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onHostCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function inspectSourceEnrichment(executionId: string) {
  const inspection = await application().inspect(executionId);
  if (inspection === undefined || inspection.sourceEnrichments === undefined)
    return undefined;
  return {
    id: inspection.execution.id,
    status: inspection.execution.status,
    ...(inspection.execution.outcome === undefined
      ? {}
      : { outcome: inspection.execution.outcome }),
    ...(inspection.execution.reason === undefined
      ? {}
      : { reason: deliveryReasonText(inspection.execution.reason) }),
    sourceEnrichments: inspection.sourceEnrichments.map((item) => ({
      ...item,
      ...(item.reason === undefined
        ? {}
        : { reason: deliveryReasonText(item.reason) }),
    })),
    sourceAssociations: inspection.accepted?.sourceAssociations ?? [],
  };
}

/** 明确"再次获取"一个已终止失败的来源补充项：新执行、新 ID，关联前次失败项。 */
export async function retrySourceEnrichment(value: unknown) {
  const input = settingsObject(value);
  const executionId = settingsText(input, "executionId");
  const subjectId = settingsText(input, "subjectId");
  const sourceIdentity = settingsText(input, "sourceIdentity");
  return await executions().invoke(async (control) => {
    await application().retrySourceEnrichment({
      executionId,
      subjectId,
      sourceIdentity,
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onHostCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function startSourceAssociationDecision(value: unknown) {
  const input = settingsObject(value);
  const intent = settingsText(input, "intent");
  if (!new Set(["establish", "replace", "retract"]).has(intent))
    throw new Error("来源关联决定意图无效");
  const assetId = settingsText(input, "assetId");
  const initiatedBy = settingsText(input, "initiatedBy");
  const sourceInput = (): Readonly<Record<string, string>> => {
    if (
      typeof input.sourceInput !== "object" ||
      input.sourceInput === null ||
      Array.isArray(input.sourceInput) ||
      !Object.values(input.sourceInput).every(
        (item) => typeof item === "string",
      )
    )
      throw new Error("来源输入无效");
    return input.sourceInput as Readonly<Record<string, string>>;
  };
  return await executions().invoke(async (control) => {
    const onExecutionStarted = (execution: { readonly id: string }) =>
      control.executionStarted(execution.id);
    const onHostCheckpoint = () => control.safeCheckpoint();
    if (intent === "establish")
      await application().prepareConflictedEstablishment({
        assetId,
        sourceIdentity: settingsText(input, "sourceIdentity"),
        sourceInput: sourceInput(),
        initiatedBy,
        onExecutionStarted,
        onHostCheckpoint,
      });
    else if (intent === "replace")
      await application().prepareReplacement({
        assetId,
        predecessorAssociationId: settingsText(
          input,
          "predecessorAssociationId",
        ),
        sourceInput: sourceInput(),
        initiatedBy,
        onExecutionStarted,
        onHostCheckpoint,
      });
    else
      await application().prepareRetraction({
        assetId,
        predecessorAssociationId: settingsText(
          input,
          "predecessorAssociationId",
        ),
        initiatedBy,
        reason: settingsText(input, "reason"),
        onExecutionStarted,
        onHostCheckpoint,
      });
  });
}

export async function inspectSourceAssociationDecision(executionId: string) {
  return await application().inspectSourceAssociationDecision(executionId);
}

export async function inspectCorrectionSubject(assetId: string) {
  return await application().inspectCorrectionSubject(assetId);
}

/** 只读核对所选内容真正导致资料冲突的候选值；主体不存在返回 undefined。 */
export async function inspectSubjectConflictEvidence(assetId: string) {
  return await application().inspectSubjectConflictEvidence(assetId);
}

/** 按稳定执行 ID 读取单条刷新记录；目标不存在返回 undefined，绝不退回其它执行。 */
export async function inspectExecution(
  executionId: string,
): Promise<ExecutionViewModel | undefined> {
  if (productApplication?.configured !== true) return undefined;
  return deliveryExecution(await application().inspect(executionId));
}

export async function selectSourceAssociationDecisionCandidate(
  executionId: string,
  value: unknown,
) {
  const input = settingsObject(value);
  if (Object.keys(input).length !== 1)
    throw new Error("来源候选选择包含未知字段");
  return await application().selectSourceAssociationCandidate({
    executionId,
    candidateReference: settingsText(input, "candidateReference"),
  });
}

export async function retrySourceAssociationDecision(executionId: string) {
  return await executions().invoke(async (control) => {
    await application().retrySourceAssociationDecision({
      executionId,
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onHostCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function cancelExecution(executionId: string, value: unknown) {
  const input = settingsObject(value);
  if (Object.keys(input).some((key) => key !== "requestedBy"))
    throw new Error("取消请求包含不支持的字段");
  const result = await application().cancel({
    executionId,
    requestedBy: settingsText(input, "requestedBy"),
    requestedAt: new Date().toISOString(),
  });
  return {
    id: result.execution.id,
    status: result.execution.status,
    outcome: result.execution.outcome,
  };
}

export async function startRecognitionRetraction(value: unknown) {
  const input = settingsObject(value);
  return await executions().invoke(async (control) => {
    await application().prepareRecognitionRetraction({
      assetId: settingsText(input, "assetId"),
      predecessorDecisionId: settingsText(input, "predecessorDecisionId"),
      proposedBy: settingsText(input, "proposedBy"),
      reason: settingsText(input, "reason"),
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
    });
  });
}

export async function startRecognitionScopeAmendment(value: unknown) {
  const input = settingsObject(value);
  const allowed = new Set([
    "sourceExecutionId",
    "workItemKey",
    "decisionId",
    "proposedBy",
    "reason",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error("范围决定请求包含不支持的字段");
  return await executions().invoke(async (control) => {
    await application().prepareRecognitionScopeAmendment({
      sourceExecutionId: settingsText(input, "sourceExecutionId"),
      workItemKey: settingsText(input, "workItemKey"),
      proposedBy: settingsText(input, "proposedBy"),
      reason: settingsText(input, "reason"),
      ...(input.decisionId === undefined
        ? {}
        : { decisionId: settingsText(input, "decisionId") }),
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
    });
  });
}

// 封面图复用既有授权地址；观察文件走观察图片路由，库内图片收窄为摘要地址。
function coverImageUrl(
  entityId: string,
  candidate: {
    kind: "observed" | "managed";
    locationId: string;
    address: string;
  },
): string | undefined {
  return candidate.kind === "observed"
    ? `/api/observed-artwork/${encodeURIComponent(entityId)}/${encodeURIComponent(candidate.locationId)}`
    : deliveryCover(candidate.address);
}

function coverImageTitle(address: string): string {
  const name = (address.split(/[\\/]/).at(-1) ?? "").trim();
  return /^[0-9a-f]{32,}(?:\.(?:jpe?g|png|webp|avif|gif))?$/iu.test(name) ||
    name === ""
    ? "封面候选"
    : name;
}

export async function coverChoice(subjectId: string): Promise<CoverChoiceView> {
  const inspection = await application().inspectArtifactRoleCovers({
    entityId: subjectId,
  });
  const candidates = inspection.candidates.map((candidate) => {
    const imageUrl = coverImageUrl(subjectId, candidate);
    return {
      reference: candidate.reference,
      title: coverImageTitle(candidate.address),
      ...(imageUrl === undefined ? {} : { imageUrl }),
    };
  });
  const current = candidates.find(
    (candidate) => candidate.reference === inspection.effectiveReference,
  );
  const manualIntent = inspection.decision?.kind === "select";
  const manualReference = inspection.decision?.reference;
  return {
    candidates,
    ...(current?.imageUrl === undefined
      ? {}
      : { currentImageUrl: current.imageUrl }),
    ...(manualIntent && manualReference !== undefined
      ? { manualReference }
      : {}),
    // 失效的人工意图仍然只是用户的决定，撤回必须可达，不能只留一句提示。
    ...(manualIntent && manualReference === undefined
      ? { manualStale: true }
      : {}),
    problems: inspection.problems,
  };
}

export async function startCoverDecision(value: unknown): Promise<{
  readonly previewId: string;
  readonly status: string;
}> {
  const input = settingsObject(value);
  const allowed = new Set(["entityId", "initiatedBy", "candidateReference"]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error("封面选择请求包含不支持的字段");
  const preview = await application().prepareArtifactRoleDecision({
    entityId: settingsText(input, "entityId"),
    initiatedBy: settingsText(input, "initiatedBy"),
    ...(input.candidateReference === undefined
      ? {}
      : { candidateReference: settingsText(input, "candidateReference") }),
  });
  return { previewId: preview.id, status: preview.status };
}

export async function startObservedMaterialAssociation(value: unknown) {
  const input = settingsObject(value);
  const allowed = new Set([
    "targetAssetId",
    "registrationId",
    "relativeScope",
    "relativePaths",
    "initiatedBy",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error("观察材料关联请求包含不支持的字段");
  if (
    typeof input.targetAssetId !== "string" ||
    !input.targetAssetId ||
    typeof input.registrationId !== "string" ||
    !input.registrationId ||
    typeof input.relativeScope !== "string" ||
    typeof input.initiatedBy !== "string" ||
    !input.initiatedBy.trim() ||
    !Array.isArray(input.relativePaths) ||
    input.relativePaths.length === 0 ||
    !input.relativePaths.every((item) => typeof item === "string" && item)
  )
    throw new Error("观察材料关联请求无效");
  return await executions().invoke(async (control) => {
    await application().prepareObservedMaterialAssociation({
      targetAssetId: input.targetAssetId as string,
      registrationId: input.registrationId as string,
      relativeScope: input.relativeScope as string,
      relativePaths: input.relativePaths as string[],
      initiatedBy: input.initiatedBy as string,
      onExecutionStarted(execution) {
        control.executionStarted(execution.id);
      },
      onHostCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

export async function inspectObservedMaterialAssociation(executionId: string) {
  return await application().inspectObservedMaterialAssociation(executionId);
}

export async function confirmObservedMaterialAssociation(value: unknown) {
  const input = settingsObject(value);
  if (
    Object.keys(input).some(
      (key) => key !== "executionId" && key !== "confirmedBy",
    ) ||
    typeof input.executionId !== "string" ||
    !input.executionId ||
    typeof input.confirmedBy !== "string" ||
    !input.confirmedBy.trim()
  )
    throw new Error("观察材料确认请求无效");
  return await executions().invoke(async (control) => {
    control.executionStarted(input.executionId as string);
    await application().confirmObservedMaterialAssociation({
      executionId: input.executionId as string,
      confirmedBy: input.confirmedBy as string,
      onHostCheckpoint() {
        control.safeCheckpoint();
      },
    });
  });
}

/**
 * 一次库扫描对用户的呈现：每个配置目录都有友好名称、状态、结果与计数，被覆盖的目录
 * 只看到属于自己范围的工作项。
 */
function libraryScanView(inspection: LibraryScanInspectionDetail): {
  readonly id: string;
  readonly status: LibraryScanInspectionDetail["status"];
  readonly outcome?: LibraryScanInspectionDetail["outcome"];
  readonly cancellationRequested: boolean;
  readonly directories: readonly {
    readonly id: string;
    readonly name: string;
    readonly stage: LibraryScanInspectionDetail["directories"][number]["stage"];
    readonly outcome?: LibraryScanInspectionDetail["directories"][number]["outcome"];
    readonly reason?: string;
    readonly workItemCount: number;
    readonly unresolvedCount: number;
    readonly failedCount: number;
    readonly files: readonly {
      readonly relativePaths: readonly string[];
      readonly outcome?: string;
    }[];
  }[];
} {
  return {
    id: inspection.parentExecutionId,
    status: inspection.status,
    ...(inspection.outcome === undefined
      ? {}
      : { outcome: inspection.outcome }),
    cancellationRequested: inspection.cancellationRequested !== undefined,
    directories: inspection.directories.map((directory) => ({
      id: directory.directoryKey,
      name: directory.displayName,
      stage: directory.stage,
      ...(directory.outcome === undefined
        ? {}
        : { outcome: directory.outcome }),
      ...(directory.reason === undefined ? {} : { reason: directory.reason }),
      workItemCount: directory.workItemCount,
      unresolvedCount: directory.unresolvedCount,
      failedCount: directory.failedCount,
      files: directory.workItems.map((item) => ({
        relativePaths: item.relativePaths,
        ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
      })),
    })),
  };
}

export async function inspectAssetLibraryScan(parentExecutionId: string) {
  const inspection =
    await application().inspectAssetLibraryScan(parentExecutionId);
  if (inspection === undefined) throw new Error("未找到刷新记录");
  return libraryScanView(inspection);
}

export async function cancelAssetLibraryScan(
  parentExecutionId: string,
  value: unknown,
) {
  const input = settingsObject(value);
  if (
    Object.keys(input).some((key) => key !== "requestedBy" && key !== "reason")
  )
    throw new Error("取消库扫描请求包含不支持的字段");
  return libraryScanView(
    await application().cancelAssetLibraryScan({
      parentExecutionId,
      requestedBy: settingsText(input, "requestedBy"),
      requestedAt: new Date().toISOString(),
      ...(input.reason === undefined
        ? {}
        : { reason: settingsText(input, "reason") }),
    }),
  );
}

/** 未形成决定的观察材料：给出可核对的归属，用户由此进入既有人工整理入口。 */
export async function unrecognizedLibraryScanObservations(
  query: Record<string, string | undefined>,
) {
  const limit = query.limit === undefined ? undefined : Number(query.limit);
  return await application().unrecognizedLibraryScanObservations({
    ...(query.scanId === undefined ? {} : { parentExecutionId: query.scanId }),
    ...(query.assetLibraryId === undefined
      ? {}
      : { assetLibraryId: query.assetLibraryId }),
    ...(query.directoryId === undefined
      ? {}
      : { directoryKey: query.directoryId }),
    ...(limit === undefined ? {} : { limit }),
  });
}

export async function startRefreshWith(
  subject: ProductWorkflowOperations,
  input: Parameters<typeof startRefresh>[0],
  host: Pick<ExecutionHost, "invoke">,
): Promise<{ readonly id: string }> {
  if (input.assetLibraryId !== undefined) {
    if (
      typeof input.assetLibraryId !== "string" ||
      input.assetLibraryId.length === 0 ||
      input.observedRootId !== undefined ||
      input.assetId !== undefined ||
      input.target !== undefined ||
      input.operation !== undefined ||
      input.directedSourceInput !== undefined
    )
      throw new Error("资产库扫描范围无效");
    return await host.invoke(async (control) => {
      // 父执行先耐久落下并是本次调用唯一公布的刷新记录；全部目录与子执行的完整结果
      // 由父检查展开，交付层不再只看到第一个目录。
      await subject.scanAssetLibrary({
        libraryId: input.assetLibraryId!,
        acceptTrusted: input.acceptTrusted ?? true,
        informationRequirement: generalAssetViewInformationRequirement,
        onExecutionStarted(execution) {
          control.executionStarted(execution.id);
        },
        onHostCheckpoint() {
          control.safeCheckpoint();
        },
      });
    });
  }
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
  if (input.directedSourceInput !== undefined) {
    if (
      input.directedSourceIdentity === undefined ||
      input.directedSourceAddress !== undefined ||
      typeof input.directedSourceInput !== "object" ||
      Array.isArray(input.directedSourceInput) ||
      !Object.values(input.directedSourceInput).every(
        (item) => typeof item === "string",
      )
    )
      throw new Error("明确来源输入无效");
    return await host.invoke(async (control) => {
      await subject.directedRecognitionSourceInputObservedScope({
        registrationId: observedRootId,
        relativeScope: input.relativeScope ?? ".",
        sourceIdentity: input.directedSourceIdentity!,
        sourceInput: input.directedSourceInput!,
        informationRequirement: generalAssetViewInformationRequirement,
        onExecutionStarted(execution) {
          control.executionStarted(execution.id);
        },
        onHostCheckpoint() {
          control.safeCheckpoint();
        },
      });
    });
  }
  if (
    input.directedSourceAddress !== undefined ||
    input.directedSourceIdentity !== undefined
  )
    throw new Error("明确来源必须按来源输入要求提交");
  return await host.invoke(async (control) => {
    await subject.scanObservedScope({
      registrationId: observedRootId,
      relativeScope: input.relativeScope ?? ".",
      acceptTrusted: input.acceptTrusted ?? true,
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
    ProductWorkflowOperations,
    | "inspectCurrentCatalogueSubject"
    | "inspectRefreshTarget"
    | "rescrapeCurrentObservedScope"
  >,
  subjectId: string,
  host: Pick<ExecutionHost, "invoke">,
): Promise<{ readonly id: string }> {
  const target = await subject.inspectRefreshTarget(subjectId);
  if (target === undefined) throw new Error("未找到可重新刮削的当前内容");
  const recognitionSourceAssociation = target.recognitionSourceAssociation;
  if (recognitionSourceAssociation === undefined)
    throw new Error("当前内容没有可重新刮削的识别来源");
  return await startAssetRescrape(
    subject,
    {
      assetId: target.subjectId,
      observedRootId: target.filesystemScope.observedRootId,
      relativeScope: target.filesystemScope.relativeScope,
      sourceIdentity: recognitionSourceAssociation.sourceIdentity,
      sourceAddress: recognitionSourceAssociation.nativeAddress,
    },
    host,
    await informationRequirementForSubject(
      subject,
      subjectId,
      recognitionSourceAssociation,
    ),
  );
}

export async function startAssetRescrape(
  subject: Pick<ReturnType<typeof application>, "rescrapeCurrentObservedScope">,
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
      id: input.assetId,
      sourceAssociations: [
        {
          sourceIdentity: input.sourceIdentity,
          nativeAddress: input.sourceAddress,
        },
      ],
      descriptions: [],
    },
  ),
): Promise<{ readonly id: string }> {
  return await host.invoke(async (control) => {
    await subject.rescrapeCurrentObservedScope({
      subjectId: input.assetId,
      registrationId: input.observedRootId,
      relativeScope: input.relativeScope,
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
  readonly assetLibraryId?: string;
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
    if (!input.assetLibraryId) throw new Error("请先选择要自动刷新的资产库");
    if (!input.observedRootId || !input.intervalMilliseconds)
      throw new Error("请填写刷新范围和间隔");
    const assetLibraryId = input.assetLibraryId;
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
        assetLibraryId,
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
      intent: await toAutomationView(
        intent,
        createAutomationNameLookup(subject),
      ),
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
  readonly actorId: string;
}): Promise<{
  readonly status: "awaiting-confirmation" | "rejected" | "applied" | "stale";
}> {
  const preview =
    input.action === "apply"
      ? await application().applyChangeImpactPreview({
          previewId: input.previewId,
          confirmedBy: input.actorId,
        })
      : await application().rejectChangeImpactPreview({
          previewId: input.previewId,
          rejectedBy: input.actorId,
        });
  return { status: preview.status };
}
