import {
  assetRefreshSelectionVersion,
  derivedRegisteredFilesystemScopeRoot,
  freezeAssetRefreshSelection,
  type AssetRefreshSelection,
  type ResolvedAssetRefreshSelection,
} from "./asset-refresh-selection.js";
import type {
  BoundObservedScope,
  ObservedRootRegistrations,
} from "./observed-root-registrations.js";
import { atPublicWorkflowBoundary } from "./workflow-invocation-lifecycle.js";

/** Input accepted by every new filesystem operation in Application. */
export type RegisteredObservedRootRequest = {
  readonly registrationId: string;
  readonly relativeScope: string;
  readonly subjects?: AssetRefreshSelection["subjects"];
};

/**
 * The complete, already-authorized invocation context. No callback receives
 * a path that it can later resolve, and all durable selection evidence came
 * from the same descriptor binding.
 */
export type RegisteredObservedRootInvocation = {
  readonly scope: BoundObservedScope;
  readonly requestedSelection: AssetRefreshSelection;
  readonly resolvedSelection: ResolvedAssetRefreshSelection;
};

/**
 * Deep registered-scope execution seam shared by scan, re-scrape, and
 * directed recognition. It owns the ordering that must never be copied by
 * callers: resolve authority, freeze its selection, invoke work, release the
 * exact adapter-owned descriptor.
 */
export class ObservedRootExecution {
  constructor(
    private readonly registrations: Pick<
      ObservedRootRegistrations,
      "resolveActiveScope" | "closeBoundScope" | "reportCleanupFailure"
    >,
  ) {}

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
   * The registration service normally routes reporter errors to its separate
   * fallback sink. Keep this boundary defensive as well: a substituted outer
   * adapter is never allowed to overwrite the work/close primary error.
   */
  private async reportCleanupFailure(
    input: Parameters<ObservedRootRegistrations["reportCleanupFailure"]>[0],
  ): Promise<void> {
    try {
      await this.registrations.reportCleanupFailure(input);
    } catch {
      // Reporting failure is suppressed operational evidence, never workflow
      // control flow. The concrete registration service already attempts its
      // configured fallback before this last defensive boundary.
    }
  }
}
