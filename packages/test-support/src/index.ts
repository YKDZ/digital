import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";

/**
 * 仅供测试使用的实现，与绑定描述符的生产适配器采用相同能力契约。它刻意同时拥有范围绑定、
 * 观察、字节打开和释放，使应用层测试不会重新引入原始路径或逐夹具文件系统接缝。
 */
export type InMemoryCapabilityCoordinate = {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly contractVersion: string;
};

export type InMemoryFilesystemObjectIdentityContract =
  | { readonly kind: "snapshot-local" }
  | {
      readonly kind: "durable";
      readonly capability: InMemoryCapabilityCoordinate;
    };

export type InMemoryObservedFilesystemOptions = {
  readonly capability?: InMemoryCapabilityCoordinate;
  readonly objectIdentityContract?: InMemoryFilesystemObjectIdentityContract;
  readonly bytes?: Readonly<Record<string, Uint8Array | string>>;
  readonly observe?: (input: {
    readonly scope: InMemoryBoundObservedScope;
  }) =>
    | Promise<InMemoryFilesystemPackageSnapshot>
    | InMemoryFilesystemPackageSnapshot;
  readonly inspectReadableDirectory?: (candidate: string) =>
    | Promise<{
        readonly absolutePath: string;
        readonly canonicalPath: string;
      }>
    | {
        readonly absolutePath: string;
        readonly canonicalPath: string;
      };
  readonly onBind?: (input: {
    readonly root: InMemoryObservedRootSnapshot;
    readonly relativeScope: string;
  }) => void | Promise<void>;
  readonly onOpen?: (input: {
    readonly scope: InMemoryBoundObservedScope;
    readonly relativePath: string;
  }) => void | Promise<void>;
  readonly onClose?: (
    scope: InMemoryBoundObservedScope,
  ) => void | Promise<void>;
  readonly onByteSourceClose?: (
    source: InMemoryObservedByteSource,
  ) => void | Promise<void>;
};

export type InMemoryObservedRootSnapshot = {
  readonly version: "observed-root-snapshot/1";
  readonly id: string;
  readonly configVersion: number;
  readonly containerPath: string;
  readonly canonicalPath: string;
  readonly readOnly: true;
  readonly symlinkMode:
    | "do-not-follow"
    | "follow-file-links"
    | "follow-file-and-directory-links";
  readonly allowedTargetRootIds: readonly string[];
  readonly authorizedTargetRoots?: readonly {
    readonly id: string;
    readonly configVersion: number;
    readonly containerPath: string;
    readonly canonicalPath: string;
  }[];
};

export type InMemoryFilesystemPackageSnapshot = {
  readonly id: string;
  readonly root: string;
  readonly complete: boolean;
  readonly files: readonly {
    readonly relativePath: string;
    readonly size: number;
    readonly modifiedAt: string;
  }[];
  readonly directories?: readonly {
    readonly relativePath: string;
    readonly modifiedAt: string;
  }[];
  readonly excluded: readonly {
    readonly relativePath: string;
    readonly kind: "symbolic-link" | "special" | "unavailable";
  }[];
  readonly observedAt: string;
};

export class InMemoryBoundObservedScope {
  readonly version = "bound-observed-scope/1" as const;
  readonly root: InMemoryObservedRootSnapshot;
  readonly relativeScope: string;
  readonly logicalLocation: string;

  constructor(input: {
    readonly root: InMemoryObservedRootSnapshot;
    readonly relativeScope: string;
  }) {
    this.root = input.root;
    this.relativeScope = input.relativeScope;
    this.logicalLocation = path.resolve(
      input.root.containerPath,
      input.relativeScope,
    );
  }
}

export class InMemoryObservedByteSource {
  private closed = false;
  private readOnce = false;
  private readonly bytes: Uint8Array;
  private offset = 0;
  private readonly onClose:
    | ((source: InMemoryObservedByteSource) => void | Promise<void>)
    | undefined;
  readonly logicalLocation: string;
  readonly byteLength: number;
  readonly modifiedAt = "2026-08-03T00:00:00.000Z";

  constructor(
    logicalLocation: string,
    bytes: Uint8Array,
    onClose?: (source: InMemoryObservedByteSource) => void | Promise<void>,
  ) {
    this.logicalLocation = logicalLocation;
    this.bytes = bytes;
    this.byteLength = bytes.byteLength;
    this.onClose = onClose;
  }

  async read(): Promise<Uint8Array> {
    if (this.readOnce)
      throw new Error("in-memory observed byte source was already read");
    this.readOnce = true;
    try {
      return this.bytes;
    } finally {
      await this.close();
    }
  }

  async readChunk(
    offset: number,
    maximumBytes: number,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly done: boolean;
  }> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes <= 0
    )
      throw new Error("读取块上限必须为正安全整数");
    if (this.closed)
      throw new Error("in-memory observed byte source is closed");
    const bytes = this.bytes.slice(offset, offset + maximumBytes);
    this.offset = offset + bytes.byteLength;
    return { bytes, done: this.offset === this.bytes.byteLength };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.onClose?.(this);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export class InMemoryObservedFilesystemCapability {
  private readonly scopes = new WeakSet<InMemoryBoundObservedScope>();
  private readonly options: InMemoryObservedFilesystemOptions;
  readonly capability: InMemoryCapabilityCoordinate;
  readonly objectIdentityContract?: InMemoryFilesystemObjectIdentityContract;
  readonly boundScopes: InMemoryBoundObservedScope[] = [];
  readonly openedPaths: string[] = [];
  readonly closedScopes: InMemoryBoundObservedScope[] = [];

  constructor(options: InMemoryObservedFilesystemOptions = {}) {
    this.options = options;
    this.capability = options.capability ?? {
      capabilityId: "test.in-memory-observed-filesystem",
      capabilityVersion: "1",
      contractVersion: "1",
    };
    if (options.objectIdentityContract !== undefined)
      this.objectIdentityContract = options.objectIdentityContract;
  }

  async inspectReadableDirectory(candidate: string): Promise<{
    readonly absolutePath: string;
    readonly canonicalPath: string;
  }> {
    if (this.options.inspectReadableDirectory !== undefined)
      return await this.options.inspectReadableDirectory(candidate);
    if (!path.isAbsolute(candidate)) throw new Error("not absolute");
    const absolutePath = path.resolve(candidate);
    return { absolutePath, canonicalPath: absolutePath };
  }

  async canonicalize(candidate: string): Promise<string> {
    if (this.options.inspectReadableDirectory !== undefined)
      return (await this.options.inspectReadableDirectory(candidate))
        .canonicalPath;
    return path.resolve(candidate);
  }

  async bindScope(input: {
    readonly root: InMemoryObservedRootSnapshot;
    readonly relativeScope: string;
  }): Promise<InMemoryBoundObservedScope> {
    await this.options.onBind?.(input);
    const scope = new InMemoryBoundObservedScope(input);
    this.scopes.add(scope);
    this.boundScopes.push(scope);
    return scope;
  }

  async observe(
    scope: InMemoryBoundObservedScope,
  ): Promise<InMemoryFilesystemPackageSnapshot> {
    this.assertBound(scope);
    if (this.options.observe !== undefined)
      return await this.options.observe({ scope });
    return {
      id: `memory-snapshot-${this.boundScopes.indexOf(scope)}`,
      root: scope.logicalLocation,
      complete: true,
      files: [],
      excluded: [],
      observedAt: "2026-08-03T00:00:00.000Z",
    };
  }

  async openByteSource(input: {
    readonly scope: InMemoryBoundObservedScope;
    readonly relativePath: string;
  }): Promise<InMemoryObservedByteSource> {
    this.assertBound(input.scope);
    await this.options.onOpen?.(input);
    this.openedPaths.push(input.relativePath);
    const value = this.options.bytes?.[input.relativePath] ?? new Uint8Array();
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : value;
    return new InMemoryObservedByteSource(
      path.resolve(input.scope.logicalLocation, input.relativePath),
      bytes,
      this.options.onByteSourceClose,
    );
  }

  async closeScope(scope: InMemoryBoundObservedScope): Promise<void> {
    this.assertBound(scope);
    this.closedScopes.push(scope);
    try {
      await this.options.onClose?.(scope);
    } finally {
      this.scopes.delete(scope);
    }
  }

  private assertBound(scope: InMemoryBoundObservedScope): void {
    if (this.scopes.has(scope)) return;
    throw new Error(
      "in-memory filesystem scope does not belong to this capability",
    );
  }
}

/**
 * 为注册测试刻意保持浅层的持久化适配器。它只拥有记录和乐观版本检查；应用层真正的
 * `ObservedRootRegistrations` 仍是唯一的权威评估器、范围绑定器、规范化器和所有权边界。
 */
export type InMemoryVersionedRegistration = {
  readonly id: string;
  readonly configVersion: number;
  readonly status?: "active" | "revoked";
};

/** 测试夹具声明的一个资产库；未声明的库不会给任何观察根提供 I/O 授权。 */
export type InMemoryAuthorizedLibrary = {
  readonly id: string;
  readonly status: "active" | "removed";
  readonly rootIds: readonly string[];
  readonly configVersion?: number;
  /**
   * 本库某目录的链接意图；省略时按生产默认取最窄授权（不跟随链接、无目标）。
   * 目标只引用同一库内的目录，另一库共享同一物理根不会为本库取得目标资格。
   */
  readonly directoryLinks?: readonly {
    readonly observedRootId: string;
    readonly symlinkMode: InMemoryLibraryDirectorySymlinkMode;
    readonly targetObservedRootIds?: readonly string[];
  }[];
};

/** 与生产 ObservedRootSymlinkMode 同一取值；test-support 不导入应用类型，故本地声明。 */
export type InMemoryLibraryDirectorySymlinkMode =
  | "do-not-follow"
  | "follow-file-links"
  | "follow-file-and-directory-links";

/** 测试夹具声明的一条库目录授权，保留 removed 关系以支持点名重连。 */
export type InMemoryLibraryDirectoryGrant = {
  readonly id: string;
  readonly libraryId: string;
  readonly observedRootId: string;
  readonly status: "active" | "removed";
  readonly authorityVersion: number;
  readonly symlinkMode: InMemoryLibraryDirectorySymlinkMode;
  readonly allowedTargetGrantIds: readonly string[];
  readonly awaitingObservation: boolean;
};

/** 一条库目录授权的稳定账本键：一个库对一个观察根只有一份授权。 */
function inMemoryGrantKey(libraryId: string, observedRootId: string): string {
  return `${libraryId}\u0000${observedRootId}`;
}

/** 授权账本的一次重连意图，逐字段照生产 AssetLibraries.reconnect 的前置做 CAS。 */
export type InMemoryLibraryDirectoryReconnect = {
  readonly libraryId: string;
  readonly observedRootId: string;
  readonly expectedAuthorityVersion: number;
  /** 省略时只核对授权版本；给出时库配置版本必须相等，否则整笔不动。 */
  readonly expectedConfigVersion?: number;
  /** 末引用撤销的物理根须在同一笔里恢复；版本 CAS 落空即整笔回滚。 */
  readonly reactivateRegistration?: {
    readonly observedRootId: string;
    readonly expectedVersion: number;
  };
};

export type InMemoryObservedRootAuthorization = {
  readonly libraries?: readonly InMemoryAuthorizedLibrary[];
  readonly grants?: readonly InMemoryLibraryDirectoryGrant[];
};

/** 账本里一份库配置的当前事实：状态、目录集合、配置版本与本库全部授权行。 */
export type InMemoryLibraryLedgerEntry = {
  readonly id: string;
  readonly status: "active" | "removed";
  readonly rootIds: readonly string[];
  readonly configVersion: number;
  readonly grants: readonly InMemoryLibraryDirectoryGrant[];
};

/** 一次库目录授权失效坐标，逐字对应生产的 LibraryDirectoryInvalidation。 */
export type InMemoryLibraryDirectoryInvalidation = {
  readonly assetLibraryId: string;
  readonly observedRootId: string;
  /** 本次提交后仍活动的授权版本；移除坐标省略，与生产receipt一致。 */
  readonly keepVersion?: number;
};

/** `authorization.saveLibrary` 的一次目录意图；目标只引用同一库内的目录。 */
export type InMemoryLibraryDirectorySave = {
  readonly libraryId: string;
  readonly directories: readonly {
    readonly observedRootId: string;
    readonly symlinkMode: InMemoryLibraryDirectorySymlinkMode;
    readonly targetObservedRootIds?: readonly string[];
  }[];
};

/** 保存后的新配置版本与必须送达执行服务的精确失效坐标。 */
export type InMemoryLibraryLedgerSaveReceipt = {
  readonly configVersion: number;
  readonly invalidations: readonly InMemoryLibraryDirectoryInvalidation[];
};

export class InMemoryObservedRootRegistrationStore<
  Registration extends InMemoryVersionedRegistration,
> {
  private readonly registrations = new Map<string, Registration>();
  private readonly libraries = new Map<
    string,
    {
      readonly id: string;
      status: "active" | "removed";
      rootIds: string[];
      configVersion: number;
    }
  >();
  private readonly directoryGrants = new Map<
    string,
    InMemoryLibraryDirectoryGrant
  >();

  constructor(
    initial: readonly Registration[] = [],
    authorization: InMemoryObservedRootAuthorization = {},
  ) {
    for (const registration of initial) {
      if (this.registrations.has(registration.id)) {
        throw new Error(`duplicate in-memory registration: ${registration.id}`);
      }
      this.registrations.set(registration.id, registration);
    }
    const declared = authorization.grants ?? [];
    for (const grant of declared) {
      this.directoryGrants.set(
        inMemoryGrantKey(grant.libraryId, grant.observedRootId),
        grant,
      );
    }
    for (const library of authorization.libraries ?? []) {
      this.libraries.set(library.id, {
        id: library.id,
        status: library.status,
        rootIds: [...library.rootIds],
        configVersion: library.configVersion ?? 1,
      });
      // 点名了本库授权就按点名生效；否则按生产默认派生最窄的活动授权（不跟随链接、无目标）。
      if (declared.some((grant) => grant.libraryId === library.id)) continue;
      for (const observedRootId of library.rootIds) {
        const link = library.directoryLinks?.find(
          (candidate) => candidate.observedRootId === observedRootId,
        );
        this.directoryGrants.set(inMemoryGrantKey(library.id, observedRootId), {
          id: `grant:${library.id}:${observedRootId}`,
          libraryId: library.id,
          observedRootId,
          status: library.status === "active" ? "active" : "removed",
          // 整库移除同样推进权威版本，旧执行不能沿移除前的代次继续取得访问。
          authorityVersion: library.status === "active" ? 1 : 2,
          symlinkMode: link?.symlinkMode ?? "do-not-follow",
          allowedTargetGrantIds: (link?.targetObservedRootIds ?? [])
            .map((target) => `grant:${library.id}:${target}`)
            .toSorted(),
          awaitingObservation: false,
        });
      }
      // 目标必须是本库内的授权：未挂在本库上的目标路径写法不会为本库取得目标资格。
      for (const grant of this.directoryGrants.values()) {
        if (grant.libraryId !== library.id) continue;
        this.directoryGrants.set(
          inMemoryGrantKey(grant.libraryId, grant.observedRootId),
          {
            ...grant,
            allowedTargetGrantIds: grant.allowedTargetGrantIds.filter((id) =>
              [...this.directoryGrants.values()].some(
                (candidate) =>
                  candidate.libraryId === library.id && candidate.id === id,
              ),
            ),
          },
        );
      }
    }
  }

  readonly queries = {
    getObservedRootRegistration: async (id: string) =>
      this.registrations.get(id),
    listObservedRootRegistrations: async () => [...this.registrations.values()],
    listAuthorizedObservedRootRegistrations: async () =>
      [...this.registrations.values()].filter(
        (registration) =>
          registration.status !== "revoked" &&
          [...this.libraries.values()].some(
            (library) =>
              library.status === "active" &&
              library.rootIds.includes(registration.id),
          ),
      ),
    listLibraryDirectoryGrants: async (libraryId: string) =>
      [...this.directoryGrants.values()]
        .filter((grant) => grant.libraryId === libraryId)
        .toSorted((left, right) =>
          left.observedRootId.localeCompare(right.observedRootId),
        ),
  };

  readonly commands = {
    createObservedRootRegistration: async (registration: Registration) => {
      if (this.registrations.has(registration.id)) {
        throw new Error(`duplicate in-memory registration: ${registration.id}`);
      }
      this.registrations.set(registration.id, registration);
    },
    replaceObservedRootRegistration: async (input: {
      readonly expectedVersion: number;
      readonly registration: Registration;
    }) => this.replace(input),
    /** 与 SQLite 同一纪律：仍被活动资产库引用的物理根不能经登记服务撤销，必须先移除库或目录。 */
    revokeObservedRootRegistration: async (input: {
      readonly expectedVersion: number;
      readonly registration: Registration;
    }) => {
      const retained = [...this.libraries.values()].some(
        (library) =>
          library.status === "active" &&
          library.rootIds.includes(input.registration.id),
      );
      if (retained) return false;
      return this.replace(input);
    },
  };

  /**
   * 授权账本的只读视图：库配置行与目录授权的唯一权威仍是这个 store 本身，消费者（例如内存
   * 资产库持久化适配器）只从这里读取状态、目录集合与配置版本，绝不另存一份可写的授权。
   */
  readonly libraryLedger = {
    read: (libraryId: string): InMemoryLibraryLedgerEntry | undefined => {
      const library = this.libraries.get(libraryId);
      if (library === undefined) return undefined;
      return {
        id: library.id,
        status: library.status,
        rootIds: [...library.rootIds],
        configVersion: library.configVersion,
        grants: [...this.directoryGrants.values()]
          .filter((grant) => grant.libraryId === libraryId)
          .toSorted((left, right) =>
            left.observedRootId.localeCompare(right.observedRootId),
          ),
      };
    },
    readAll: (): readonly InMemoryLibraryLedgerEntry[] =>
      [...this.libraries.keys()]
        .toSorted()
        .map((libraryId) => this.libraryLedger.read(libraryId)!),
  };

  /**
   * 授权账本的变更入口与真实配置操作保持同一因果前置：调用方是测试夹具本身，
   * 语义逐条对应 AssetLibraries.remove / AssetLibraries.reconnect / 一次完整授权观察。
   */
  readonly authorization = {
    /**
     * 建立或更新一份库配置：目录集合与链接意图逐条对应 SQLite saveAssetLibrary 的纪律——
     * 新目录取得代次 1 的活动授权，仍在集合内的目录延续既有策略与目标，被点名的链接变化
     * 推进代次，离开集合的活动授权标为 removed 并推进代次。配置版本不匹配时返回 undefined，
     * 与生产的乐观冲突同一表达。
     */
    saveLibrary: (
      input: InMemoryLibraryDirectorySave & {
        readonly expectedConfigVersion?: number;
      },
    ): InMemoryLibraryLedgerSaveReceipt | undefined => {
      const current = this.libraries.get(input.libraryId);
      if (
        input.expectedConfigVersion !== undefined &&
        current?.configVersion !== input.expectedConfigVersion
      )
        return undefined;
      if (current === undefined)
        throw new Error(`unknown in-memory library: ${input.libraryId}`);
      for (const directory of input.directories)
        if (
          this.directoryGrants.get(
            inMemoryGrantKey(input.libraryId, directory.observedRootId),
          )?.status === "removed"
        )
          throw new Error(
            "该目录此前已从本资产库移除，请使用重新连接而不是重复添加",
          );
      const invalidations: InMemoryLibraryDirectoryInvalidation[] = [];
      const previous = [...this.directoryGrants.values()].filter(
        (grant) =>
          grant.libraryId === input.libraryId && grant.status === "active",
      );
      const grantByRootId = new Map(
        previous.map((grant) => [grant.observedRootId, grant]),
      );
      for (const directory of input.directories) {
        const retained = grantByRootId.get(directory.observedRootId);
        if (retained === undefined) {
          this.directoryGrants.set(
            inMemoryGrantKey(input.libraryId, directory.observedRootId),
            {
              id: `grant:${input.libraryId}:${directory.observedRootId}`,
              libraryId: input.libraryId,
              observedRootId: directory.observedRootId,
              status: "active",
              authorityVersion: 1,
              symlinkMode: directory.symlinkMode,
              allowedTargetGrantIds: (directory.targetObservedRootIds ?? [])
                .map((target) => `grant:${input.libraryId}:${target}`)
                .toSorted(),
              awaitingObservation: false,
            },
          );
          continue;
        }
        const targets = (directory.targetObservedRootIds ?? [])
          .map((target) => `grant:${input.libraryId}:${target}`)
          .toSorted();
        if (
          retained.symlinkMode === directory.symlinkMode &&
          retained.allowedTargetGrantIds.join("\u0000") ===
            targets.join("\u0000")
        )
          continue;
        // 链接范围变化必须换代表：旧执行不能沿撤销前的授权代次继续读取新的链接意图。
        this.directoryGrants.set(
          inMemoryGrantKey(input.libraryId, directory.observedRootId),
          {
            ...retained,
            symlinkMode: directory.symlinkMode,
            allowedTargetGrantIds: targets,
            authorityVersion: retained.authorityVersion + 1,
          },
        );
        invalidations.push({
          assetLibraryId: input.libraryId,
          observedRootId: directory.observedRootId,
          keepVersion: retained.authorityVersion + 1,
        });
      }
      for (const grant of previous)
        if (
          !input.directories.some(
            (directory) => directory.observedRootId === grant.observedRootId,
          )
        ) {
          this.directoryGrants.set(
            inMemoryGrantKey(grant.libraryId, grant.observedRootId),
            {
              ...grant,
              status: "removed",
              authorityVersion: grant.authorityVersion + 1,
            },
          );
          invalidations.push({
            assetLibraryId: input.libraryId,
            observedRootId: grant.observedRootId,
          });
        }
      // 目标授权改变后，依赖它的同库旧闭包也不能继续读取；新授权和其他库不被推进。
      const seeds = new Set(
        previous
          .filter((grant) =>
            invalidations.some(
              (item) => item.observedRootId === grant.observedRootId,
            ),
          )
          .map((grant) => grant.id),
      );
      const dirty = new Set(seeds);
      let grew = true;
      while (grew) {
        grew = false;
        for (const grant of this.directoryGrants.values())
          if (
            grant.libraryId === input.libraryId &&
            grant.status === "active" &&
            !dirty.has(grant.id) &&
            grant.allowedTargetGrantIds.some((id) => dirty.has(id))
          ) {
            dirty.add(grant.id);
            grew = true;
          }
      }
      for (const grant of this.directoryGrants.values())
        if (
          grant.libraryId === input.libraryId &&
          grant.status === "active" &&
          dirty.has(grant.id) &&
          !seeds.has(grant.id) &&
          grantByRootId.has(grant.observedRootId)
        ) {
          this.directoryGrants.set(
            inMemoryGrantKey(input.libraryId, grant.observedRootId),
            { ...grant, authorityVersion: grant.authorityVersion + 1 },
          );
          invalidations.push({
            assetLibraryId: input.libraryId,
            observedRootId: grant.observedRootId,
            keepVersion: grant.authorityVersion + 1,
          });
        }
      const desired = input.directories
        .map((directory) => directory.observedRootId)
        .toSorted();
      if (desired.join("\u0000") !== current.rootIds.toSorted().join("\u0000"))
        current.rootIds = desired;
      current.configVersion += 1;
      return { configVersion: current.configVersion, invalidations };
    },
    removeLibrary: (libraryId: string): void => {
      const library = this.requireLibrary(libraryId);
      library.status = "removed";
      library.configVersion += 1;
      for (const grant of this.directoryGrants.values())
        if (grant.libraryId === libraryId && grant.status === "active")
          this.directoryGrants.set(
            inMemoryGrantKey(grant.libraryId, grant.observedRootId),
            {
              ...grant,
              status: "removed",
              authorityVersion: grant.authorityVersion + 1,
            },
          );
    },
    removeDirectory: (input: {
      readonly libraryId: string;
      readonly observedRootId: string;
    }): void => {
      const library = this.requireLibrary(input.libraryId);
      const grant = this.requireGrant(input.libraryId, input.observedRootId);
      if (grant.status !== "active")
        throw new Error(
          `in-memory grant is not active: ${input.libraryId}/${input.observedRootId}`,
        );
      library.rootIds = library.rootIds.filter(
        (rootId) => rootId !== input.observedRootId,
      );
      library.configVersion += 1;
      this.directoryGrants.set(
        inMemoryGrantKey(grant.libraryId, grant.observedRootId),
        {
          ...grant,
          status: "removed",
          authorityVersion: grant.authorityVersion + 1,
        },
      );
    },
    /** 前置不成立时返回 false 且账本一字不动：撤权后的旧权威不会被静默续期。 */
    reconnectDirectory: (input: InMemoryLibraryDirectoryReconnect): boolean => {
      const library = this.libraries.get(input.libraryId);
      if (
        library === undefined ||
        library.status !== "active" ||
        (input.expectedConfigVersion !== undefined &&
          library.configVersion !== input.expectedConfigVersion)
      )
        return false;
      const key = inMemoryGrantKey(input.libraryId, input.observedRootId);
      const grant = this.directoryGrants.get(key);
      if (
        grant === undefined ||
        grant.status !== "removed" ||
        grant.authorityVersion !== input.expectedAuthorityVersion
      )
        return false;
      if (input.reactivateRegistration !== undefined) {
        const registration = this.registrations.get(
          input.reactivateRegistration.observedRootId,
        );
        if (
          registration === undefined ||
          registration.status !== "revoked" ||
          registration.configVersion !==
            input.reactivateRegistration.expectedVersion
        )
          return false;
        this.registrations.set(registration.id, {
          ...registration,
          status: "active",
          configVersion: registration.configVersion + 1,
        });
      }
      // 重连只恢复 I/O 通路：新的权威版本让旧执行被持久拒绝，awaitingObservation 让本库
      // 经此根的历史位置在一次完整授权观察前不进入 current 投影。
      this.directoryGrants.set(key, {
        ...grant,
        status: "active",
        authorityVersion: grant.authorityVersion + 1,
        awaitingObservation: true,
      });
      if (!library.rootIds.includes(input.observedRootId))
        library.rootIds = [...library.rootIds, input.observedRootId].toSorted();
      library.configVersion += 1;
      return true;
    },
    /** 只有携带当前权威版本的活动授权提交才清零等待观察标记，与 SQLite 同一条件。 */
    completeAuthorizedObservation: (input: {
      readonly libraryId: string;
      readonly observedRootId: string;
      readonly authorityVersion: number;
    }): boolean => {
      const key = inMemoryGrantKey(input.libraryId, input.observedRootId);
      const grant = this.directoryGrants.get(key);
      if (
        grant === undefined ||
        grant.status !== "active" ||
        grant.authorityVersion !== input.authorityVersion ||
        !grant.awaitingObservation
      )
        return false;
      this.directoryGrants.set(key, { ...grant, awaitingObservation: false });
      return true;
    },
  };

  private requireLibrary(libraryId: string) {
    const library = this.libraries.get(libraryId);
    if (library === undefined)
      throw new Error(`unknown in-memory library: ${libraryId}`);
    return library;
  }

  private requireGrant(libraryId: string, observedRootId: string) {
    const grant = this.directoryGrants.get(
      inMemoryGrantKey(libraryId, observedRootId),
    );
    if (grant === undefined)
      throw new Error(
        `unknown in-memory grant: ${libraryId}/${observedRootId}`,
      );
    return grant;
  }

  private replace(input: {
    readonly expectedVersion: number;
    readonly registration: Registration;
  }): boolean {
    const current = this.registrations.get(input.registration.id);
    if (current?.configVersion !== input.expectedVersion) return false;
    this.registrations.set(input.registration.id, input.registration);
    return true;
  }
}

/** 供应用层所有清理审计契约使用的无害收集槽。 */
export class InMemoryObservedRootCleanupReporter {
  readonly cleanupFailures: unknown[] = [];
  readonly reportingFailures: unknown[] = [];

  async reportCleanupFailure(input: unknown): Promise<void> {
    this.cleanupFailures.push(input);
  }

  async reportCleanupReportingFailure(input: unknown): Promise<void> {
    this.reportingFailures.push(input);
  }
}

export type RawFilesystemEntry = {
  readonly relativePath: string;
  readonly kind: "directory" | "regular-file" | "symbolic-link" | "special";
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly byteLength: number;
  readonly modifiedAtNanoseconds: string;
  readonly changedAtNanoseconds: string;
  readonly symbolicLinkTarget?: string;
  readonly contentDigest?: string;
};

export type RawFilesystemSnapshot = {
  readonly root: string;
  readonly entries: readonly RawFilesystemEntry[];
};

export async function captureRawFilesystemSnapshot(
  root: string,
  options: { readonly contentDigests?: boolean } = {},
): Promise<RawFilesystemSnapshot> {
  const entries = await captureEntries(root, ".", options.contentDigests);
  return Object.freeze({
    root,
    entries: Object.freeze(entries),
  });
}

async function captureEntries(
  root: string,
  relativePath: string,
  contentDigests: boolean | undefined,
): Promise<readonly RawFilesystemEntry[]> {
  const absolutePath =
    relativePath === "." ? root : path.join(root, ...relativePath.split("/"));
  const details = await lstat(absolutePath, { bigint: true });
  const kind = details.isDirectory()
    ? "directory"
    : details.isFile()
      ? "regular-file"
      : details.isSymbolicLink()
        ? "symbolic-link"
        : "special";
  const byteLength = Number(details.size);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new Error(
      `filesystem entry byte length is outside the safe integer range: ${relativePath}`,
    );
  const current = Object.freeze({
    relativePath,
    kind,
    device: details.dev.toString(),
    inode: details.ino.toString(),
    mode: Number(details.mode),
    byteLength,
    modifiedAtNanoseconds: details.mtimeNs.toString(),
    changedAtNanoseconds: details.ctimeNs.toString(),
    ...(kind === "symbolic-link"
      ? { symbolicLinkTarget: await readlink(absolutePath) }
      : {}),
    ...(kind === "regular-file" && contentDigests === true
      ? { contentDigest: await sha256(absolutePath) }
      : {}),
  }) satisfies RawFilesystemEntry;
  if (kind !== "directory") return [current];
  const children = (
    await readdir(absolutePath, { withFileTypes: true })
  ).toSorted((left, right) => compareCodeUnits(left.name, right.name));
  const descendants = await Promise.all(
    children.map(
      async (child) =>
        await captureEntries(
          root,
          relativePath === "." ? child.name : `${relativePath}/${child.name}`,
          contentDigests,
        ),
    ),
  );
  return [current, ...descendants.flat()];
}

async function sha256(location: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(location)) digest.update(chunk);
  return digest.digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
