import { randomUUID } from "node:crypto";
import path from "node:path";

import type { CapabilityCoordinate } from "@digital/domain";

import type {
  FilesystemObjectIdentityContract,
  FilesystemPackageSnapshot,
} from "./index.js";
import {
  createObservedRootAuthorityIndex,
  freezeObservedRootSnapshot,
  hasCurrentObservedRootAuthority,
  normalizeObservedRelativeScope,
  resolveObservedRootAuthority,
} from "./observed-root-authority.js";

type BoundScopeOwnership = {
  readonly registrations: ObservedRootRegistrations;
  readonly expectedRoot: string;
};

/**
 * Bound scopes are adapter-owned opaque values. This module-level registry
 * adds the Application ownership proof that ties each one to the exact
 * registration service which bound it.
 */
const boundScopeOwnership = new WeakMap<
  BoundObservedScope,
  BoundScopeOwnership
>();

export type ObservedRootSymlinkMode =
  | "do-not-follow"
  | "follow-file-links"
  | "follow-file-and-directory-links";

export type ObservedRootRegistration = {
  readonly id: string;
  readonly displayName: string;
  /** Absolute path in the running container. Never a host path mapping. */
  readonly containerPath: string;
  /** Symlink-aware identity retained for overlap and reconnect checks. */
  readonly canonicalPath: string;
  readonly status: "active" | "revoked";
  readonly configVersion: number;
  readonly readOnly: true;
  readonly symlinkMode: ObservedRootSymlinkMode;
  readonly allowedTargetRootIds: readonly string[];
};

export type ObservedRootSnapshot = {
  readonly version: "observed-root-snapshot/1";
  readonly id: string;
  readonly configVersion: number;
  readonly containerPath: string;
  /**
   * Canonical identity frozen with the execution.  This is boundary evidence,
   * not a Location and never belongs to a Domain fact.
   */
  readonly canonicalPath: string;
  readonly readOnly: true;
  readonly symlinkMode: ObservedRootSymlinkMode;
  readonly allowedTargetRootIds: readonly string[];
  /**
   * Complete active transitive authorization closure frozen at the workflow
   * boundary.  A filesystem adapter receives paths from this list but never
   * has to interpret registration IDs or infer permission from a link.
   */
  readonly authorizedTargetRoots?: readonly AuthorizedObservedRootTarget[];
};

export type AuthorizedObservedRootTarget = {
  readonly id: string;
  readonly configVersion: number;
  /**
   * The registered container-visible spelling, frozen with the descriptor
   * authority. It may itself be a symbolic-link alias and is never inferred
   * from a resolved link target.
   */
  readonly containerPath: string;
  /** Canonical identity verified when this exact spelling is bound. */
  readonly canonicalPath: string;
};

/**
 * Application-internal filesystem authority resolved for one exact byte
 * source. Delivery may pass this to an infrastructure reader, but no caller
 * supplies an arbitrary server path and no Domain value carries this shape.
 */
/**
 * An Application-owned, adapter-bound observation scope. Its logical location
 * is retained only as Location evidence; filesystem consumers receive the
 * already-bound object rather than a path which they could resolve later.
 */
export abstract class BoundObservedScope {
  readonly version = "bound-observed-scope/1" as const;

  abstract readonly root: ObservedRootSnapshot;
  abstract readonly relativeScope: string;
  abstract readonly logicalLocation: string;
}

/**
 * A one-file read capability created by a BoundObservedScope. Consumers get
 * bytes, never an observed filesystem path or a descriptor they can reopen.
 */
export abstract class ObservedByteSource {
  abstract readonly logicalLocation: string;

  /** Reads the already-opened source and closes its underlying capability. */
  abstract read(): Promise<Uint8Array>;

  /** Idempotently releases an unread source when a workflow aborts early. */
  abstract close(): Promise<void>;
}

/**
 * A cleanup incident is an operational audit fact, rather than a Domain
 * outcome. It deliberately retains the original error separately so cleanup
 * must never rewrite the public result of an already-failed operation.
 */
export type ObservedRootCleanupFailure = {
  readonly operation: "observed-root-execution" | "open-active-byte-source";
  readonly cleanup: "close-bound-scope" | "close-byte-source";
  readonly rootId: string;
  readonly relativeScope: string;
  readonly error: unknown;
  readonly primaryError?: unknown;
};

/**
 * Application owns the audit contract while outer composition chooses where
 * it is recorded. Implementations must make cleanup failures observable and
 * must not turn a cleanup incident into a silent best-effort operation.
 */
export type ObservedRootCleanupFailureReporter = {
  reportCleanupFailure(input: ObservedRootCleanupFailure): void | Promise<void>;
};

/**
 * The primary audit adapter is itself an outer capability and can fail.  This
 * fallback receives that operational incident without being allowed to affect
 * filesystem cleanup or the public failure selected by the workflow.
 */
export type ObservedRootCleanupReportingFailure = {
  readonly cleanupFailure: ObservedRootCleanupFailure;
  readonly reporterError: unknown;
};

export type ObservedRootCleanupFailureFallback = {
  reportCleanupReportingFailure(
    input: ObservedRootCleanupReportingFailure,
  ): void | Promise<void>;
};

export type ObservedRootRegistrationQueries = {
  getObservedRootRegistration(
    id: string,
  ): Promise<ObservedRootRegistration | undefined>;
  listObservedRootRegistrations(): Promise<readonly ObservedRootRegistration[]>;
};

export type ObservedRootRegistrationCommands = {
  createObservedRootRegistration(
    registration: ObservedRootRegistration,
  ): Promise<void>;
  replaceObservedRootRegistration(input: {
    readonly expectedVersion: number;
    readonly registration: ObservedRootRegistration;
  }): Promise<boolean>;
  /**
   * One durable application operation: revoke future filesystem authority and
   * disable every Automation Intent whose selected scope depends on it.  The
   * persistence adapter owns the transaction; this configuration service does
   * not learn Automation's storage shape.
   */
  revokeObservedRootRegistration(input: {
    readonly expectedVersion: number;
    readonly registration: ObservedRootRegistration;
  }): Promise<boolean>;
};

export type ObservedRootPathInspector = {
  inspectReadableDirectory(candidate: string): Promise<{
    readonly absolutePath: string;
    readonly canonicalPath: string;
  }>;
  canonicalize(candidate: string): Promise<string>;
};

/**
 * One adapter-owned descriptor capability for every observed-root operation.
 * The opaque bound scope is valid only for the adapter instance that created
 * it; Application never rebuilds it from a path or asks a concrete adapter
 * for private descriptor details.
 */
export type ObservedFilesystemCapability = ObservedRootPathInspector & {
  /** The same deployed capability that binds, observes, opens, and closes. */
  readonly capability: CapabilityCoordinate;
  /** Omitted when this capability emits no object-identity evidence. */
  readonly objectIdentityContract?: FilesystemObjectIdentityContract;
  bindScope(input: {
    /** Frozen actual authority, including the exact target-root closure. */
    readonly root: ObservedRootSnapshot;
    readonly relativeScope: string;
  }): Promise<BoundObservedScope>;
  observe(scope: BoundObservedScope): Promise<FilesystemPackageSnapshot>;
  openByteSource(input: {
    readonly scope: BoundObservedScope;
    readonly relativePath: string;
  }): Promise<ObservedByteSource>;
  closeScope(scope: BoundObservedScope): Promise<void>;
};

export class ObservedRootConfigurationConflict extends Error {
  constructor() {
    super("文件位置已被其他设置修改，请刷新后重试");
    this.name = "ObservedRootConfigurationConflict";
  }
}

export class ObservedRootUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservedRootUnavailable";
  }
}

export class ObservedRootRegistrations {
  constructor(
    private readonly ports: {
      readonly commands: ObservedRootRegistrationCommands;
      readonly queries: ObservedRootRegistrationQueries;
      readonly filesystem: ObservedFilesystemCapability;
      readonly productDataDirectory: string;
      readonly managedArtifactDirectory: string;
      readonly cleanupFailureReporter: ObservedRootCleanupFailureReporter;
      /** A separate outer sink for failures of the primary cleanup audit. */
      readonly cleanupFailureFallback: ObservedRootCleanupFailureFallback;
    },
  ) {}

  /**
   * Capability provenance is exposed only through the registration authority,
   * ensuring a workflow cannot bind scopes through one adapter and freeze the
   * declarations of another.
   */
  get capability(): CapabilityCoordinate {
    return this.ports.filesystem.capability;
  }

  get objectIdentityContract(): FilesystemObjectIdentityContract | undefined {
    return this.ports.filesystem.objectIdentityContract;
  }

  /**
   * Cleanup reporting is intentionally non-throwing. Reporter failure is an
   * observable operational incident, but an audit adapter cannot overwrite a
   * work/open/close failure or prevent the next actual cleanup step.
   */
  async reportCleanupFailure(input: ObservedRootCleanupFailure): Promise<void> {
    try {
      await this.ports.cleanupFailureReporter.reportCleanupFailure(input);
    } catch (reporterError) {
      try {
        await this.ports.cleanupFailureFallback.reportCleanupReportingFailure({
          cleanupFailure: input,
          reporterError,
        });
      } catch {
        // A last-resort audit sink is still an outer adapter. Its failure is
        // suppressed so it cannot control descriptor release or public error
        // precedence. There is no further sink to invoke without recursion.
      }
    }
  }

  async create(input: {
    readonly displayName: string;
    readonly containerPath: string;
    readonly readOnly: true;
    readonly symlinkMode: ObservedRootSymlinkMode;
    readonly allowedTargetRootIds: readonly string[];
  }): Promise<ObservedRootRegistration> {
    const displayName = validateDisplayName(input.displayName);
    validateReadOnly(input.readOnly);
    validateSymlinkMode(input.symlinkMode);
    const inspected = await this.inspectNewPath(input.containerPath);
    const allowedTargetRootIds = await this.validateAllowedTargets(
      input.allowedTargetRootIds,
    );
    const registration: ObservedRootRegistration = {
      id: `observed_root_${randomUUID()}`,
      displayName,
      containerPath: inspected.absolutePath,
      canonicalPath: inspected.canonicalPath,
      status: "active",
      configVersion: 1,
      readOnly: true,
      symlinkMode: input.symlinkMode,
      allowedTargetRootIds,
    };
    await this.ports.commands.createObservedRootRegistration(registration);
    return registration;
  }

  async get(id: string): Promise<ObservedRootRegistration | undefined> {
    return await this.ports.queries.getObservedRootRegistration(id);
  }

  async list(): Promise<readonly ObservedRootRegistration[]> {
    return await this.ports.queries.listObservedRootRegistrations();
  }

  async update(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly displayName: string;
    readonly readOnly: true;
    readonly symlinkMode: ObservedRootSymlinkMode;
    readonly allowedTargetRootIds: readonly string[];
  }): Promise<ObservedRootRegistration> {
    const current = await this.required(input.id);
    if (current.status !== "active") throw new Error("文件位置已停用");
    validateExpectedVersion(input.expectedVersion);
    validateReadOnly(input.readOnly);
    validateSymlinkMode(input.symlinkMode);
    const replacement: ObservedRootRegistration = {
      ...current,
      displayName: validateDisplayName(input.displayName),
      configVersion: current.configVersion + 1,
      symlinkMode: input.symlinkMode,
      allowedTargetRootIds: await this.validateAllowedTargets(
        input.allowedTargetRootIds,
        input.id,
      ),
    };
    return await this.replace(input.expectedVersion, replacement);
  }

  async deactivate(input: {
    readonly id: string;
    readonly expectedVersion: number;
  }): Promise<ObservedRootRegistration> {
    const current = await this.required(input.id);
    validateExpectedVersion(input.expectedVersion);
    if (current.configVersion !== input.expectedVersion)
      throw new ObservedRootConfigurationConflict();
    if (current.status === "revoked") return current;
    const replacement: ObservedRootRegistration = {
      ...current,
      status: "revoked",
      configVersion: current.configVersion + 1,
    };
    if (
      !(await this.ports.commands.revokeObservedRootRegistration({
        expectedVersion: input.expectedVersion,
        registration: replacement,
      }))
    ) {
      throw new ObservedRootConfigurationConflict();
    }
    return replacement;
  }

  async reconnect(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly containerPath: string;
    readonly readOnly: true;
  }): Promise<ObservedRootRegistration> {
    const current = await this.required(input.id);
    if (current.status !== "revoked") throw new Error("文件位置仍处于启用状态");
    validateReadOnly(input.readOnly);
    const inspected = await this.inspectNewPath(input.containerPath, input.id);
    if (inspected.canonicalPath !== current.canonicalPath) {
      throw new Error("不能把原文件位置重新指向无关路径，请创建新的文件位置");
    }
    const replacement: ObservedRootRegistration = {
      ...current,
      containerPath: inspected.absolutePath,
      canonicalPath: inspected.canonicalPath,
      status: "active",
      configVersion: current.configVersion + 1,
    };
    return await this.replace(input.expectedVersion, replacement);
  }

  async resolveActiveScope(input: {
    readonly registrationId: string;
    readonly relativeScope: string;
  }): Promise<{
    /** Bound authority for this invocation; it is intentionally not durable. */
    readonly scope: BoundObservedScope;
    readonly relativeScope: string;
    readonly root: ObservedRootSnapshot;
  }> {
    const registration = await this.required(input.registrationId);
    if (registration.status !== "active")
      throw new ObservedRootUnavailable("文件位置已停用");
    const relativeScope = normalizeObservedRelativeScope(input.relativeScope);
    const authority = await this.resolveActiveAuthority(registration);
    await this.currentReadableLocation(authority.root);
    await Promise.all(
      authority.authorizedTargetRoots.map(
        async (target) => await this.currentReadableLocation(target),
      ),
    );
    const root = freezeObservedRootSnapshot(authority);
    let scope: BoundObservedScope;
    try {
      scope = await this.ports.filesystem.bindScope({
        root,
        relativeScope,
      });
    } catch {
      throw new ObservedRootUnavailable("文件位置当前缺失、不可读或范围越界");
    }
    this.rememberBoundScope(scope, root, relativeScope);
    return {
      scope,
      relativeScope,
      root,
    };
  }

  /**
   * Opens one byte source only after proving current root authority. This is
   * the shared delivery seam for a later download or Playback Rendition; it
   * never returns a pathname that a caller can reopen after authorization.
   */
  async openActiveByteSource(input: {
    readonly registrationId: string;
    readonly relativePath: string;
  }): Promise<ObservedByteSource> {
    const relativePath = validateRelativeFilePath(input.relativePath);
    const resolved = await this.resolveActiveScope({
      registrationId: input.registrationId,
      relativeScope: ".",
    });
    let source: ObservedByteSource | undefined;
    let openingError: unknown;
    let scopeCloseError: unknown;
    let sourceCloseError: unknown;
    const cleanupFailures: ObservedRootCleanupFailure[] = [];
    try {
      source = await this.openBoundByteSource({
        scope: resolved.scope,
        relativePath,
      });
    } catch {
      openingError = new ObservedRootUnavailable(
        "文件位置当前缺失、不可读或范围越界",
      );
    } finally {
      try {
        await this.closeBoundScope(resolved.scope);
      } catch (error) {
        scopeCloseError = error;
        cleanupFailures.push({
          operation: "open-active-byte-source",
          cleanup: "close-bound-scope",
          rootId: resolved.root.id,
          relativeScope: resolved.relativeScope,
          error,
          ...(openingError === undefined ? {} : { primaryError: openingError }),
        });
        if (source !== undefined) {
          const primaryError = openingError ?? scopeCloseError;
          try {
            await source.close();
          } catch (error) {
            sourceCloseError = error;
            cleanupFailures.push({
              operation: "open-active-byte-source",
              cleanup: "close-byte-source",
              rootId: resolved.root.id,
              relativeScope: resolved.relativeScope,
              error,
              primaryError,
            });
          }
        }
      }
    }
    await this.reportCleanupFailures(cleanupFailures);
    if (openingError !== undefined) throw openingError;
    if (scopeCloseError !== undefined) throw scopeCloseError;
    if (sourceCloseError !== undefined) throw sourceCloseError;
    if (source === undefined)
      throw new Error("已打开的文件位置字节来源意外缺失");
    return source;
  }

  /**
   * Observes an already-bound scope through the same capability that created
   * it. A workflow never receives a second filesystem observer seam.
   */
  async observeBoundScope(
    scope: BoundObservedScope,
  ): Promise<FilesystemPackageSnapshot> {
    const ownership = this.requireOwnedBoundScope(scope);
    let snapshot: FilesystemPackageSnapshot;
    try {
      snapshot = await this.ports.filesystem.observe(scope);
    } catch {
      // A descriptor can outlive a mount, permission, or entry change. Do not
      // leak adapter errors or make callers parse errno diagnostics.
      throw new ObservedRootUnavailable("文件位置当前缺失、不可读或范围越界");
    }
    if (snapshot.root !== ownership.expectedRoot) {
      throw new ObservedRootUnavailable("文件位置观察结果超出已登记范围");
    }
    return snapshot;
  }

  /**
   * A workflow returns its opaque scope to the registration capability for
   * every byte open.  It cannot reopen a logical location after authority was
   * frozen at the boundary.
   */
  async openBoundByteSource(input: {
    readonly scope: BoundObservedScope;
    readonly relativePath: string;
  }): Promise<ObservedByteSource> {
    this.requireOwnedBoundScope(input.scope);
    try {
      return await this.ports.filesystem.openByteSource(input);
    } catch {
      throw new ObservedRootUnavailable("文件位置当前缺失、不可读或范围越界");
    }
  }

  /** Releases one adapter-owned descriptor scope exactly through its binder. */
  async closeBoundScope(scope: BoundObservedScope): Promise<void> {
    this.requireOwnedBoundScope(scope);
    try {
      await this.ports.filesystem.closeScope(scope);
    } finally {
      boundScopeOwnership.delete(scope);
    }
  }

  /**
   * A recovered execution must bind its original authorization again instead
   * of resolving current mutable paths or silently adopting later settings.
   */
  async rebindFrozenScope(input: {
    readonly root: ObservedRootSnapshot;
    readonly relativeScope: string;
  }): Promise<BoundObservedScope> {
    const relativeScope = normalizeObservedRelativeScope(input.relativeScope);
    await this.assertFrozenRootsCurrent([input.root]);
    try {
      const scope = await this.ports.filesystem.bindScope({
        root: input.root,
        relativeScope,
      });
      this.rememberBoundScope(scope, input.root, relativeScope);
      return scope;
    } catch {
      throw new ObservedRootUnavailable(
        "刷新记录的冻结文件位置当前不可用或版本已变更",
      );
    }
  }

  private async currentReadableLocation(
    registration: Pick<
      ObservedRootRegistration,
      "containerPath" | "canonicalPath"
    >,
  ): Promise<{
    readonly absolutePath: string;
    readonly canonicalPath: string;
  }> {
    let current: Awaited<
      ReturnType<ObservedFilesystemCapability["inspectReadableDirectory"]>
    >;
    try {
      current = await this.ports.filesystem.inspectReadableDirectory(
        registration.containerPath,
      );
    } catch {
      throw new ObservedRootUnavailable("文件位置当前缺失、不可读或范围越界");
    }
    if (current.canonicalPath !== registration.canonicalPath) {
      throw new ObservedRootUnavailable(
        "文件位置当前已不是登记的位置，请重新连接",
      );
    }
    return current;
  }

  /**
   * Resolves graph semantics once in the Application evaluator, then retains
   * the outer adapter's responsibility for proving each registered spelling
   * is still readable in this process.
   */
  private async resolveActiveAuthority(
    registration: ObservedRootRegistration,
  ): Promise<
    Extract<
      ReturnType<typeof resolveObservedRootAuthority>,
      { readonly status: "available" }
    >
  > {
    const index = createObservedRootAuthorityIndex(
      await this.ports.queries.listObservedRootRegistrations(),
    );
    const authority = resolveObservedRootAuthority(index, registration.id);
    if (authority.status === "available") return authority;
    if (authority.reason === "missing-target") {
      throw new ObservedRootUnavailable("允许的链接目标文件位置不可用");
    }
    throw new ObservedRootUnavailable("文件位置当前缺失、不可读或范围越界");
  }

  /**
   * Recovery and compatibility checks share the exact frozen closure rule
   * used by live binding. Filesystem reachability remains checked by rebind.
   */
  async assertFrozenRootsCurrent(
    roots: readonly ObservedRootSnapshot[],
  ): Promise<void> {
    const index = createObservedRootAuthorityIndex(
      await this.ports.queries.listObservedRootRegistrations(),
    );
    if (roots.every((root) => hasCurrentObservedRootAuthority(root, index)))
      return;
    throw new ObservedRootUnavailable(
      "刷新记录的冻结文件位置当前不可用或版本已变更",
    );
  }

  private rememberBoundScope(
    scope: BoundObservedScope,
    root: ObservedRootSnapshot,
    relativeScope: string,
  ): void {
    boundScopeOwnership.set(scope, {
      registrations: this,
      expectedRoot: path.resolve(root.containerPath, relativeScope),
    });
  }

  /** Reports only after every concrete cleanup has been attempted. */
  private async reportCleanupFailures(
    failures: readonly ObservedRootCleanupFailure[],
  ): Promise<void> {
    for (const failure of failures) {
      await this.reportCleanupFailure(failure);
    }
  }

  private requireOwnedBoundScope(
    scope: BoundObservedScope,
  ): BoundScopeOwnership {
    const ownership = boundScopeOwnership.get(scope);
    if (ownership?.registrations === this) return ownership;
    throw new ObservedRootUnavailable("文件位置范围不属于当前文件位置登记");
  }

  private async inspectNewPath(
    candidate: string,
    excludedId?: string,
  ): Promise<{
    readonly absolutePath: string;
    readonly canonicalPath: string;
  }> {
    if (!path.isAbsolute(candidate))
      throw new Error("文件位置必须使用容器内绝对路径");
    let inspected: Awaited<
      ReturnType<ObservedFilesystemCapability["inspectReadableDirectory"]>
    >;
    try {
      inspected =
        await this.ports.filesystem.inspectReadableDirectory(candidate);
    } catch {
      throw new Error("文件位置必须是当前可读的目录");
    }
    const productData = await this.ports.filesystem.canonicalize(
      this.ports.productDataDirectory,
    );
    const managedArtifacts = await this.ports.filesystem.canonicalize(
      this.ports.managedArtifactDirectory,
    );
    if (
      pathsOverlap(
        inspected.absolutePath,
        path.resolve(this.ports.productDataDirectory),
      ) ||
      pathsOverlap(
        inspected.absolutePath,
        path.resolve(this.ports.managedArtifactDirectory),
      ) ||
      pathsOverlap(inspected.canonicalPath, productData) ||
      pathsOverlap(inspected.canonicalPath, managedArtifacts)
    ) {
      throw new Error("文件位置不能与产品数据或托管产物目录重叠");
    }
    void excludedId;
    return inspected;
  }

  private async validateAllowedTargets(
    ids: readonly string[],
    ownId?: string,
  ): Promise<readonly string[]> {
    const result = [...new Set(ids)];
    if (result.some((id) => id.length === 0 || id === ownId))
      throw new Error("允许的链接目标文件位置无效");
    for (const id of result) {
      const target = await this.ports.queries.getObservedRootRegistration(id);
      if (target === undefined) throw new Error("允许的链接目标文件位置不存在");
    }
    return result.toSorted();
  }

  private async required(id: string): Promise<ObservedRootRegistration> {
    if (id.trim().length === 0) throw new Error("文件位置编号不能为空");
    const registration =
      await this.ports.queries.getObservedRootRegistration(id);
    if (registration === undefined) throw new Error("文件位置不存在");
    return registration;
  }

  private async replace(
    expectedVersion: number,
    registration: ObservedRootRegistration,
  ): Promise<ObservedRootRegistration> {
    validateExpectedVersion(expectedVersion);
    if (
      !(await this.ports.commands.replaceObservedRootRegistration({
        expectedVersion,
        registration,
      }))
    ) {
      throw new ObservedRootConfigurationConflict();
    }
    return registration;
  }
}

function validateDisplayName(value: string): string {
  const result = value.trim();
  if (result.length === 0 || result.length > 120)
    throw new Error("文件位置名称必须为 1 至 120 个字符");
  return result;
}

function validateReadOnly(value: true): void {
  if (!value) throw new Error("文件位置必须明确登记为只读");
}

function validateSymlinkMode(value: string): void {
  if (
    value !== "do-not-follow" &&
    value !== "follow-file-links" &&
    value !== "follow-file-and-directory-links"
  ) {
    throw new Error("文件位置链接策略无效");
  }
}

function validateExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("文件位置配置版本无效");
}

function validateRelativeFilePath(value: string): string {
  const normalized = normalizeObservedRelativeScope(value);
  if (normalized === ".") throw new Error("文件路径必须指向一个文件");
  return normalized;
}

function pathsOverlap(left: string, right: string): boolean {
  return isAncestorOrEqual(left, right) || isAncestorOrEqual(right, left);
}

function isAncestorOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
