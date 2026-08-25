import {
  assetRefreshSelectionVersion,
  derivedRegisteredFilesystemScopeRoot,
  freezeAssetRefreshSelection,
  type AssetRefreshSelection,
  type ResolvedAssetRefreshSelection,
} from "./asset-refresh-selection.ts";
import type {
  BoundObservedScope,
  ObservedRootRegistrations,
} from "./observed-root-registrations.ts";
import { atPublicWorkflowBoundary } from "./workflow-invocation-lifecycle.ts";

/** Application 中每个新文件系统操作共同接受的输入。 */
export type RegisteredObservedRootRequest = {
  readonly registrationId: string;
  readonly relativeScope: string;
  readonly subjects?: AssetRefreshSelection["subjects"];
};

/**
 * 完整且已经授权的调用上下文。回调不会收到可供稍后重新解析的路径；所有耐久选择
 * 证据都来自同一个描述符绑定。
 */
export type RegisteredObservedRootInvocation = {
  readonly scope: BoundObservedScope;
  readonly requestedSelection: AssetRefreshSelection;
  readonly resolvedSelection: ResolvedAssetRefreshSelection;
};

type ObservedRootExecutionRegistrations = Pick<
  ObservedRootRegistrations,
  "resolveActiveScope" | "closeBoundScope" | "reportCleanupFailure"
>;

/**
 * 扫描、重新刮削和定向识别共享的深层注册范围执行接缝。它持有调用方绝不能复制的
 * 顺序：解析权威、冻结选择、调用工作、释放适配器持有的精确描述符。
 */
export class ObservedRootExecution {
  private readonly registrations: ObservedRootExecutionRegistrations;

  constructor(registrations: ObservedRootExecutionRegistrations) {
    this.registrations = registrations;
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
    const resolved = await this.registrations.resolveActiveScope({
      registrationId: request.registrationId,
      relativeScope: request.relativeScope,
    });
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
