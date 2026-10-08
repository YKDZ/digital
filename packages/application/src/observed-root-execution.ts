import {
  assetRefreshSelectionVersion,
  derivedRegisteredFilesystemScopeRoot,
  freezeAssetRefreshSelection,
  type AssetRefreshSelection,
  type ResolvedAssetRefreshSelection,
} from "./asset-refresh-selection.ts";
import type { OperationLease } from "./execution-host.ts";
import { OperationLeaseInvalidated } from "./execution-host.ts";
import type { LibraryScanChildCoordinates } from "./library-scan-plan.ts";
import { normalizeObservedRelativeScope } from "./observed-root-authority.ts";
import type {
  BoundObservedScope,
  ObservedRootRegistrations,
  ObservedRootSnapshot,
} from "./observed-root-registrations.ts";
import { ObservedRootUnavailable } from "./observed-root-registrations.ts";
import { atPublicWorkflowBoundary } from "./workflow-invocation-lifecycle.ts";

/** Application 中每个新文件系统操作共同接受的输入。 */
export type RegisteredObservedRootRequest = {
  readonly registrationId: string;
  readonly relativeScope: string;
  readonly subjects?: AssetRefreshSelection["subjects"];
  /**
   * 本次调用的库语境。目录 I/O 权威只从该库自己的授权账目解析，另一库共享同一物理根
   * 不会为本目录续权。
   */
  readonly assetLibraryId?: string | undefined;
  /**
   * 库扫描父创建时冻结的本目录授权代次。存在时只重绑这一份权威；缺失表示本次新建的
   * 工作，只要求该目录当前仍是本库活动授权。
   */
  readonly directoryAuthorityVersion?: number | undefined;
  /**
   * 库扫描目录子的父归属坐标。它只随本次调用交给工作流，用于原子登记与只读覆盖；
   * 范围解析与授权仍完全来自被引用的观察根。
   */
  readonly libraryScanParent?: LibraryScanChildCoordinates | undefined;
  /**
   * 库扫描父创建时冻结的观察根权威。存在时目录子只能重新绑定这一份快照，绝不解析
   * 今日根来替换旧快照；这是父续跑与原配置漂移时诚实失败的唯一来源。
   */
  readonly libraryScanFrozenRoot?: ObservedRootSnapshot | undefined;
};

/**
 * 完整且已经授权的调用上下文。回调不会收到可供稍后重新解析的路径；所有耐久选择
 * 证据都来自同一个描述符绑定。
 */
export type RegisteredObservedRootInvocation = {
  readonly scope: BoundObservedScope;
  readonly requestedSelection: AssetRefreshSelection;
  readonly resolvedSelection: ResolvedAssetRefreshSelection;
  readonly libraryScanParent?: LibraryScanChildCoordinates | undefined;
  /**
   * 本次调用实际取得的库目录授权代次；调用方把它随耐久输入一起冻结，后续效果与提交
   * 因此复核这一份，而不是回看今日授权。
   */
  readonly directoryAuthorityVersion?: number | undefined;
};

type ObservedRootExecutionRegistrations = Pick<
  ObservedRootRegistrations,
  | "resolveActiveScope"
  | "rebindFrozenScope"
  | "closeBoundScope"
  | "reportCleanupFailure"
  | "bindDirectoryOperation"
>;

/** 为一次库目录工作创建一个尚未绑定的 Host 操作租约。 */
export type DirectoryOperationLeaseFactory = () => OperationLease;

/**
 * 扫描、重新刮削和定向识别共享的深层注册范围执行接缝。它持有调用方绝不能复制的
 * 顺序：解析权威、冻结选择、调用工作、释放适配器持有的精确描述符。
 */
export class ObservedRootExecution {
  private readonly registrations: ObservedRootExecutionRegistrations;
  private readonly directoryLeaseFactory:
    | DirectoryOperationLeaseFactory
    | undefined;

  constructor(
    registrations: ObservedRootExecutionRegistrations,
    directoryLeaseFactory?: DirectoryOperationLeaseFactory,
  ) {
    this.registrations = registrations;
    this.directoryLeaseFactory = directoryLeaseFactory;
  }

  async invoke<Result>(
    request: RegisteredObservedRootRequest,
    invocation: (input: RegisteredObservedRootInvocation) => Promise<Result>,
  ): Promise<Result> {
    return await atPublicWorkflowBoundary(
      async () => await this.invokeWithLifecycle(request, invocation),
    );
  }

  private async invokeWithLifecycle<Result>(
    request: RegisteredObservedRootRequest,
    invocation: (input: RegisteredObservedRootInvocation) => Promise<Result>,
  ): Promise<Result> {
    const relativeScope = normalizeObservedRelativeScope(request.relativeScope);
    const resolved =
      request.libraryScanFrozenRoot === undefined
        ? await this.registrations.resolveActiveScope({
            registrationId: request.registrationId,
            relativeScope: request.relativeScope,
            ...(request.assetLibraryId === undefined
              ? {}
              : { assetLibraryId: request.assetLibraryId }),
          })
        : {
            scope: await this.registrations.rebindFrozenScope({
              root: request.libraryScanFrozenRoot,
              relativeScope: request.relativeScope,
              ...(request.assetLibraryId === undefined
                ? {}
                : { assetLibraryId: request.assetLibraryId }),
              ...(request.directoryAuthorityVersion === undefined
                ? {}
                : {
                    directoryAuthorityVersion:
                      request.directoryAuthorityVersion,
                  }),
            }),
            relativeScope,
            root: request.libraryScanFrozenRoot,
            directoryAuthorityVersion: request.directoryAuthorityVersion,
          };
    // 库目录工作复用同一 ExecutionHost：把本次真实 I/O 绑定到其冻结的库、根与授权代次，
    // remove/重连撤销该坐标时，打开来源的后续块与下一效果前的复核据此一并停住。中立范围不绑定。
    let directoryLease: OperationLease | undefined;
    let directoryBinding: { release(): void } | undefined;
    if (
      request.assetLibraryId !== undefined &&
      this.directoryLeaseFactory !== undefined
    ) {
      const lease = this.directoryLeaseFactory();
      try {
        directoryBinding = lease.bindObservedRoot({
          registrationId: resolved.root.id,
          registrationVersion: resolved.root.configVersion,
          assetLibraryId: request.assetLibraryId,
          ...(resolved.directoryAuthorityVersion === undefined
            ? {}
            : {
                directoryAuthorityVersion: resolved.directoryAuthorityVersion,
              }),
        });
      } catch (error) {
        lease.release();
        if (error instanceof OperationLeaseInvalidated)
          throw new ObservedRootUnavailable(
            "此目录已从资产库移除或重新连接，本次工作不能继续",
          );
        throw error;
      }
      directoryLease = lease;
      this.registrations.bindDirectoryOperation(resolved.scope, lease);
    }
    let result!: Result;
    let workFailed = false;
    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      const requestedSelection: AssetRefreshSelection = {
        version: assetRefreshSelectionVersion,
        subjects: request.subjects ?? [],
        filesystemScopes: [
          {
            root: derivedRegisteredFilesystemScopeRoot({
              observedRoot: resolved.root,
              relativeScope: resolved.relativeScope,
            }),
            observedRoot: resolved.root,
            relativeScope: resolved.relativeScope,
            explanations: [
              {
                path: [
                  "observed-root-registration",
                  resolved.root.id,
                  resolved.relativeScope,
                ],
              },
            ],
          },
        ],
      };
      const resolvedSelection =
        await freezeAssetRefreshSelection(requestedSelection);
      result = await invocation({
        scope: resolved.scope,
        requestedSelection,
        resolvedSelection,
        ...(resolved.directoryAuthorityVersion === undefined
          ? {}
          : { directoryAuthorityVersion: resolved.directoryAuthorityVersion }),
        ...(request.libraryScanParent === undefined
          ? {}
          : { libraryScanParent: request.libraryScanParent }),
      });
    } catch (error) {
      workFailed = true;
      primaryError = error;
    } finally {
      try {
        await this.registrations.closeBoundScope(resolved.scope);
      } catch (error) {
        cleanupError = error;
        await this.reportCleanupFailure({
          operation: "observed-root-execution",
          cleanup: "close-bound-scope",
          rootId: resolved.root.id,
          relativeScope: resolved.relativeScope,
          error,
          ...(workFailed ? { primaryError } : {}),
        });
      }
      directoryBinding?.release();
      directoryLease?.release();
    }
    if (workFailed) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;
    return result;
  }

  /**
   * 注册服务通常会把报告器错误送往独立的后备接收端。此边界仍需保持防御性：替换的
   * 外层适配器绝不能覆盖工作或关闭阶段的主错误。
   */
  private async reportCleanupFailure(
    input: Parameters<ObservedRootRegistrations["reportCleanupFailure"]>[0],
  ): Promise<void> {
    try {
      await this.registrations.reportCleanupFailure(input);
    } catch {
      // 报告失败是被抑制的操作证据，绝不是工作流控制流。具体注册服务在到达这个最终
      // 防御边界前，已经尝试了配置的后备接收端。
    }
  }
}
