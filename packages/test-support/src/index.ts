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
  private readonly onClose:
    | ((source: InMemoryObservedByteSource) => void | Promise<void>)
    | undefined;
  readonly logicalLocation: string;

  constructor(
    logicalLocation: string,
    bytes: Uint8Array,
    onClose?: (source: InMemoryObservedByteSource) => void | Promise<void>,
  ) {
    this.logicalLocation = logicalLocation;
    this.bytes = bytes;
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
  readonly objectIdentityContract:
    | InMemoryFilesystemObjectIdentityContract
    | undefined;
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
};

export class InMemoryObservedRootRegistrationStore<
  Registration extends InMemoryVersionedRegistration,
> {
  private readonly registrations = new Map<string, Registration>();

  constructor(initial: readonly Registration[] = []) {
    for (const registration of initial) {
      if (this.registrations.has(registration.id)) {
        throw new Error(`duplicate in-memory registration: ${registration.id}`);
      }
      this.registrations.set(registration.id, registration);
    }
  }

  readonly queries = {
    getObservedRootRegistration: async (id: string) =>
      this.registrations.get(id),
    listObservedRootRegistrations: async () => [...this.registrations.values()],
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
    revokeObservedRootRegistration: async (input: {
      readonly expectedVersion: number;
      readonly registration: Registration;
    }) => this.replace(input),
  };

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
