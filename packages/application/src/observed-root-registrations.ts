import { randomUUID } from "node:crypto";
import path from "node:path";

import type { CapabilityCoordinate } from "@digital/domain";

import type {
  FilesystemObjectIdentityContract,
  FilesystemPackageSnapshot,
} from "./index.ts";
import {
  createObservedRootAuthorityIndex,
  freezeObservedRootSnapshot,
  hasCurrentObservedRootAuthority,
  normalizeObservedRelativeScope,
  resolveObservedRootAuthority,
} from "./observed-root-authority.ts";

type BoundScopeOwnership = {
  readonly registrations: ObservedRootRegistrations;
  readonly expectedRoot: string;
};

/**
 * 绑定范围是适配器持有的不透明值。这个模块级登记表补充 Application 持有权证明，
 * 将每个范围绑定到实际创建它的精确注册服务。
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
  /** 运行容器内的绝对路径；绝不是宿主机路径映射。 */
  readonly containerPath: string;
  /** 为重叠与重新连接检查保留的、感知符号链接的身份。 */
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
   * 随执行一同冻结的规范身份。它是边界证据，不是位置，也绝不属于领域事实。
   */
  readonly canonicalPath: string;
  readonly readOnly: true;
  readonly symlinkMode: ObservedRootSymlinkMode;
  readonly allowedTargetRootIds: readonly string[];
  /**
   * 在工作流边界冻结的完整活动传递授权闭包。文件系统适配器从该列表接收路径，但
   * 无需解释注册 ID，也无需从链接推断权限。
   */
  readonly authorizedTargetRoots?: readonly AuthorizedObservedRootTarget[];
};

export type AuthorizedObservedRootTarget = {
  readonly id: string;
  readonly configVersion: number;
  /**
   * 已注册且容器可见的路径拼写，与描述符权威一同冻结。它自身可以是符号链接别名，
   * 并且绝不从解析后的链接目标反推。
   */
  readonly containerPath: string;
  /** 绑定这个精确路径拼写时验证的规范身份。 */
  readonly canonicalPath: string;
};

/**
 * 为一个精确字节来源解析的 Application 内部文件系统权威。交付层可以将其传给
 * 基础设施读取器，但调用方不能提供任意服务器路径，领域值也不携带这种形状。
 */
/**
 * 由 Application 持有、适配器绑定的观察范围。其逻辑位置只作为位置证据保留；
 * 文件系统消费者收到已经绑定的对象，而不是可供稍后重新解析的路径。
 */
export abstract class BoundObservedScope {
  readonly version = "bound-observed-scope/1" as const;

  abstract readonly root: ObservedRootSnapshot;
  abstract readonly relativeScope: string;
  abstract readonly logicalLocation: string;
}

/**
 * 由绑定观察范围创建的单文件读取能力。消费者只能取得字节，绝不会取得观察文件
 * 系统路径或可重新打开的描述符。
 */
export abstract class ObservedByteSource {
  abstract readonly logicalLocation: string;

  /** 读取已经打开的来源，并关闭其底层能力。 */
  abstract read(): Promise<Uint8Array>;

  /** 工作流提前中止时，幂等释放尚未读取的来源。 */
  abstract close(): Promise<void>;
}

/**
 * 清理事件是操作审计事实，而不是领域结果。它刻意单独保留原始错误，因此清理过程
 * 绝不能改写已经失败操作的公开结果。
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
 * Application 持有审计契约，外层组合负责选择记录位置。实现必须让清理失败可观察，
 * 不能把清理事件降格为静默的尽力而为操作。
 */
export type ObservedRootCleanupFailureReporter = {
  reportCleanupFailure(input: ObservedRootCleanupFailure): void | Promise<void>;
};

/**
 * 主审计适配器本身也是外层能力，因此可能失败。该后备接收端接收此操作事件，但不得
 * 影响文件系统清理，也不得改变工作流选定的公开失败。
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
   * 一个耐久应用操作：撤销未来文件系统权威，并停用所有选定范围依赖它的自动化意图。
   * 持久化适配器持有事务；此配置服务无需了解自动化的存储形状。
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
 * 所有观察根操作共用一个由适配器持有的描述符能力。不透明绑定范围只对创建它的
 * 适配器实例有效；Application 绝不从路径重建它，也不向具体适配器索取私有描述符细节。
 */
export type ObservedFilesystemCapability = ObservedRootPathInspector & {
  /** 负责绑定、观察、打开和关闭的同一个已部署能力。 */
  readonly capability: CapabilityCoordinate;
  /** 该能力不产生对象身份凭证时省略。 */
  readonly objectIdentityContract?: FilesystemObjectIdentityContract;
  bindScope(input: {
    /** 冻结的实际权威，包括精确的目标根闭包。 */
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

type ObservedRootRegistrationPorts = {
  readonly commands: ObservedRootRegistrationCommands;
  readonly queries: ObservedRootRegistrationQueries;
  readonly filesystem: ObservedFilesystemCapability;
  readonly productDataDirectory: string;
  readonly managedArtifactDirectory: string;
  readonly cleanupFailureReporter: ObservedRootCleanupFailureReporter;
  /** 主清理审计失败时使用的独立外层接收端。 */
  readonly cleanupFailureFallback: ObservedRootCleanupFailureFallback;
};

export class ObservedRootRegistrations {
  private readonly ports: ObservedRootRegistrationPorts;

  constructor(ports: ObservedRootRegistrationPorts) {
    this.ports = ports;
  }

  /**
   * 能力来源只通过注册权威公开，确保工作流不能通过一个适配器绑定范围，却冻结另一个
   * 适配器的声明。
   */
  get capability(): CapabilityCoordinate {
    return this.ports.filesystem.capability;
  }

  get objectIdentityContract(): FilesystemObjectIdentityContract | undefined {
    return this.ports.filesystem.objectIdentityContract;
  }

  /**
   * 清理报告刻意不抛出错误。报告器失败是可观察的操作事件，但审计适配器不能覆盖
   * 工作、打开或关闭失败，也不能阻止下一个实际清理步骤。
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
        // 最终后备审计接收端仍是外层适配器。其失败会被抑制，因而无法控制描述符释放
        // 或公开错误的优先级；若要避免递归，已不存在可继续调用的接收端。
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
    /** 本次调用的绑定权威；刻意不作耐久化。 */
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
   * 只有在证明当前根权威后才打开一个字节来源。这是未来下载或播放呈现共用的交付
   * 接缝；它绝不返回调用方可在授权后重新打开的路径名。
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
   * 通过创建范围的同一个能力观察已经绑定的范围。工作流绝不会取得第二个文件系统
   * 观察器接缝。
   */
  async observeBoundScope(
    scope: BoundObservedScope,
  ): Promise<FilesystemPackageSnapshot> {
    const ownership = this.requireOwnedBoundScope(scope);
    let snapshot: FilesystemPackageSnapshot;
    try {
      snapshot = await this.ports.filesystem.observe(scope);
    } catch {
      // 描述符可能比挂载、权限或目录项变更存活更久。不要泄漏适配器错误，也不要迫使
      // 调用方解析 errno 诊断。
      throw new ObservedRootUnavailable("文件位置当前缺失、不可读或范围越界");
    }
    if (snapshot.root !== ownership.expectedRoot) {
      throw new ObservedRootUnavailable("文件位置观察结果超出已登记范围");
    }
    return snapshot;
  }

  /**
   * 工作流每次打开字节时都把不透明范围交回注册能力。权威在边界冻结后，它不能重新
   * 打开逻辑位置。
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

  /** 严格通过绑定器释放一个由适配器持有的描述符范围。 */
  async closeBoundScope(scope: BoundObservedScope): Promise<void> {
    this.requireOwnedBoundScope(scope);
    try {
      await this.ports.filesystem.closeScope(scope);
    } finally {
      boundScopeOwnership.delete(scope);
    }
  }

  /**
   * 恢复的执行必须重新绑定原始授权，而不是解析当前可变路径或静默采用后续设置。
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
   * 在 Application 求值器中只解析一次图语义，同时保留外层适配器的责任：证明每个
   * 注册路径拼写在本进程中仍然可读。
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
   * 恢复和兼容性检查与实时绑定共用完全相同的冻结闭包规则。文件系统可达性仍由重新
   * 绑定检查。
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

  /** 仅在所有具体清理都已经尝试后报告。 */
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
