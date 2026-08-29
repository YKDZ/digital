import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  readFile,
  stat,
  type FileHandle,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  declareCapability,
  type DirectoryObservation,
  BoundObservedScope,
  type FilesystemObservationDiagnostic,
  type FilesystemPackageInterpreter,
  type FilesystemPackageSnapshot,
  type ManagedArtifactStore,
  ObservedByteSource,
  type ObservedFilesystemCapability,
  type CoverAcquisitionCheckpoint,
} from "@digital/application";

import { filesystemObservationTestHooksFor } from "./testing-hooks.ts";

/**
 * Linux 容器中的 `/proc/self/fd/<n>` 是相对描述符的锚点，而不是可变的注册路径名。
 * Node 没有公开 `openat`，因此缺少该设施的部署会失败闭合，而不会在授权后重新解析
 * 逻辑观察路径。
 */
type FrozenObservedAuthority = {
  readonly canonicalPath: string;
  readonly handle: FileHandle;
};

/**
 * 将一个冻结的注册路径拼写路由到已经验证的描述符。这里刻意不是通用别名表：绑定
 * 只为来源注册及其冻结授权闭包创建条目。
 */
type FrozenObservedRootBinding = {
  readonly containerPath: string;
  readonly canonicalPath: string;
  readonly authority: FrozenObservedAuthority;
};

class BoundPathFailure extends Error {
  readonly kind:
    | "outside-authorized-roots"
    | "symbolic-link-not-followed"
    | "directory-link-not-allowed"
    | "expected-file"
    | "expected-directory"
    | "symbolic-link-cycle"
    | "entry-identity-changed";

  constructor(
    kind:
      | "outside-authorized-roots"
      | "symbolic-link-not-followed"
      | "directory-link-not-allowed"
      | "expected-file"
      | "expected-directory"
      | "symbolic-link-cycle"
      | "entry-identity-changed",
  ) {
    super(kind);
    this.name = "BoundPathFailure";
    this.kind = kind;
  }
}

class NodeBoundDirectory {
  readonly authority: FrozenObservedAuthority;
  readonly handle: FileHandle;
  /** 只用于把链接路由到文件描述符的虚拟冻结规范地址。 */
  readonly virtualPath: string;
  readonly owned: boolean;

  constructor(
    authority: FrozenObservedAuthority,
    handle: FileHandle,
    virtualPath: string,
    owned: boolean,
  ) {
    this.authority = authority;
    this.handle = handle;
    this.virtualPath = virtualPath;
    this.owned = owned;
  }

  get descriptorPath(): string {
    return descriptorPath(this.handle);
  }

  async close(): Promise<void> {
    if (this.owned) await this.handle.close();
  }
}

class NodeBoundFile {
  readonly handle: FileHandle;
  readonly details: Awaited<ReturnType<FileHandle["stat"]>>;

  constructor(
    handle: FileHandle,
    details: Awaited<ReturnType<FileHandle["stat"]>>,
  ) {
    this.handle = handle;
    this.details = details;
  }
}

type ResolvedNodeEntry =
  | {
      readonly kind: "file";
      readonly file: NodeBoundFile;
      /** 符号链接解析器已经消费调用方剩余的后缀。 */
      readonly consumedRemainder?: true;
    }
  | {
      readonly kind: "directory";
      readonly directory: NodeBoundDirectory;
      readonly consumedRemainder?: true;
    }
  | { readonly kind: "special"; readonly consumedRemainder?: true };

/**
 * 冻结闭包中每个已接受的根只打开一次。此后链接解析在虚拟规范命名空间中表达，并
 * 映射回这些描述符锚点。尤其是，允许的目标路径名在授权后绝不会再次打开；将其替换
 * 为符号链接既不能扩大权威，也不能重定向进行中的观察。
 */
class NodeBoundObservedScope extends BoundObservedScope {
  readonly root: import("@digital/application").ObservedRootSnapshot;
  readonly relativeScope: string;
  readonly logicalLocation: string;
  private readonly authorities: readonly FrozenObservedAuthority[];
  private readonly bindings: readonly FrozenObservedRootBinding[];
  private closed = false;
  private scopeDirectory: NodeBoundDirectory | undefined;

  private constructor(
    root: import("@digital/application").ObservedRootSnapshot,
    relativeScope: string,
    authorities: readonly FrozenObservedAuthority[],
    bindings: readonly FrozenObservedRootBinding[],
  ) {
    super();
    this.root = root;
    this.relativeScope = relativeScope;
    this.authorities = authorities;
    this.bindings = bindings;
    this.logicalLocation = path.resolve(root.containerPath, relativeScope);
  }

  static override async bind(input: {
    readonly root: import("@digital/application").ObservedRootSnapshot;
    readonly relativeScope: string;
  }): Promise<NodeBoundObservedScope> {
    const relativeScope = validateBoundRelativeScope(input.relativeScope);
    const authorities: FrozenObservedAuthority[] = [];
    const bindings: FrozenObservedRootBinding[] = [];
    let scope: NodeBoundObservedScope | undefined;
    try {
      const bindRegistrationSpelling = async (
        containerPath: string,
        canonicalPath: string,
      ): Promise<void> => {
        // 打开每个冻结路径拼写可证明它仍解析到记录的身份。规范根相同时可共享第一个
        // 文件描述符，但绝不能仅因其他别名在本次绑定早些时候有效就信任当前别名。
        const checked = await openFrozenAuthority(
          containerPath,
          canonicalPath,
          true,
        );
        const existing = authorities.find(
          (authority) => authority.canonicalPath === canonicalPath,
        );
        const authority = existing ?? checked;
        if (existing !== undefined) await checked.handle.close();
        else authorities.push(checked);
        bindings.push({
          containerPath: path.resolve(containerPath),
          canonicalPath,
          authority,
        });
      };

      await bindRegistrationSpelling(
        input.root.containerPath,
        input.root.canonicalPath,
      );
      for (const target of input.root.authorizedTargetRoots ?? []) {
        await bindRegistrationSpelling(
          target.containerPath,
          target.canonicalPath,
        );
      }
      scope = new NodeBoundObservedScope(
        input.root,
        relativeScope,
        authorities,
        bindings,
      );
      scope.scopeDirectory = await scope
        .resolveVirtualPath(
          path.resolve(input.root.canonicalPath, relativeScope),
          "directory",
          new Set(),
        )
        .then((resolved) => {
          if (resolved.kind !== "directory") {
            if (resolved.kind === "file") void resolved.file.handle.close();
            throw new BoundPathFailure("expected-directory");
          }
          return resolved.directory;
        });
      return scope;
    } catch (error) {
      if (scope !== undefined) await scope.close();
      else await closeHandles(authorities.map((authority) => authority.handle));
      throw error;
    }
  }

  get boundDirectory(): NodeBoundDirectory {
    this.assertOpen();
    if (this.scopeDirectory === undefined)
      throw new Error("bound observed scope is incomplete");
    return this.scopeDirectory;
  }

  async list(directory: NodeBoundDirectory): Promise<readonly string[]> {
    this.assertOpen();
    return await readdir(directory.descriptorPath);
  }

  async lstatEntry(
    directory: NodeBoundDirectory,
    name: string,
  ): Promise<Awaited<ReturnType<typeof lstat>>> {
    this.assertOpen();
    return await lstat(entryPath(directory, name));
  }

  async resolveObservedEntry(input: {
    readonly directory: NodeBoundDirectory;
    readonly name: string;
    readonly expected: "file" | "directory" | "either";
    readonly initiallyObserved: Awaited<ReturnType<typeof lstat>>;
  }): Promise<ResolvedNodeEntry> {
    this.assertOpen();
    return await this.resolveVirtualPath(
      path.join(input.directory.virtualPath, input.name),
      input.expected,
      new Set(),
      input.initiallyObserved,
    );
  }

  async openByteSource(input: {
    readonly relativePath: string;
  }): Promise<ObservedByteSource> {
    this.assertOpen();
    const relativePath = validateBoundRelativePath(input.relativePath);
    const resolved = await this.resolveVirtualPath(
      path.resolve(this.boundDirectory.virtualPath, relativePath),
      "file",
      new Set(),
    );
    if (resolved.kind !== "file") {
      if (resolved.kind === "directory") await resolved.directory.close();
      throw new BoundPathFailure("expected-file");
    }
    return new NodeObservedByteSource(
      resolved.file.handle,
      path.resolve(this.logicalLocation, relativePath),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const scopeHandle = this.scopeDirectory?.owned
      ? this.scopeDirectory.handle
      : undefined;
    await closeHandles([
      ...(scopeHandle === undefined ? [] : [scopeHandle]),
      ...this.authorities.map((authority) => authority.handle),
    ]);
  }

  private async resolveVirtualPath(
    virtualPath: string,
    expected: "file" | "directory" | "either",
    linkTrail: ReadonlySet<string>,
    initiallyObserved?: Awaited<ReturnType<typeof lstat>>,
  ): Promise<ResolvedNodeEntry> {
    const routed = this.routeAuthorizedPath(virtualPath);
    if (routed === undefined)
      throw new BoundPathFailure("outside-authorized-roots");
    const authority = routed.authority;
    const canonicalVirtualPath = routed.virtualPath;
    const relative = path.relative(
      authority.canonicalPath,
      canonicalVirtualPath,
    );
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new BoundPathFailure("outside-authorized-roots");
    }
    const components = relative === "" ? [] : relative.split(path.sep);
    let current = new NodeBoundDirectory(
      authority,
      authority.handle,
      authority.canonicalPath,
      false,
    );
    try {
      if (components.length === 0) {
        if (expected === "file") throw new BoundPathFailure("expected-file");
        return { kind: "directory", directory: current };
      }
      for (let index = 0; index < components.length; index += 1) {
        const name = components[index]!;
        const final = index === components.length - 1;
        const expectation = final ? expected : "directory";
        const entryInput = {
          directory: current,
          name,
          expected: expectation,
          terminalExpected: expected,
          linkTrail,
          remaining: components.slice(index + 1),
        };
        const result = await this.resolveEntryFromDirectory(
          index === components.length - 1 && initiallyObserved !== undefined
            ? { ...entryInput, initiallyObserved }
            : entryInput,
        );
        if (result.kind === "file") {
          if (!final && result.consumedRemainder !== true) {
            await result.file.handle.close();
            throw new BoundPathFailure("expected-directory");
          }
          if (current.owned) await current.close();
          return result;
        }
        if (result.kind === "special") {
          if (current.owned) await current.close();
          return result;
        }
        if (current.owned) await current.close();
        current = result.directory;
        if (final || result.consumedRemainder === true) return result;
      }
      throw new Error("unreachable bound path resolution");
    } catch (error) {
      if (current.owned) await current.close();
      throw error;
    }
  }

  private async resolveEntryFromDirectory(input: {
    readonly directory: NodeBoundDirectory;
    readonly name: string;
    readonly expected: "file" | "directory" | "either";
    /** 穿过中间链接后仍保留原始的最终类型预期。 */
    readonly terminalExpected: "file" | "directory" | "either";
    readonly linkTrail: ReadonlySet<string>;
    readonly initiallyObserved?: Awaited<ReturnType<typeof lstat>>;
    readonly remaining: readonly string[];
  }): Promise<ResolvedNodeEntry> {
    const physical = entryPath(input.directory, input.name);
    const details = await lstat(physical);
    if (
      input.initiallyObserved !== undefined &&
      !sameNodeObject(input.initiallyObserved, details)
    ) {
      throw new BoundPathFailure("entry-identity-changed");
    }
    if (!details.isSymbolicLink()) {
      if (details.isDirectory()) {
        if (input.expected === "file")
          throw new BoundPathFailure("expected-file");
        return {
          kind: "directory",
          directory: await openVerifiedDirectory(
            input.directory,
            input.name,
            details,
            path.join(input.directory.virtualPath, input.name),
          ),
        };
      }
      if (details.isFile()) {
        if (input.expected === "directory")
          throw new BoundPathFailure("expected-directory");
        return {
          kind: "file",
          file: await openVerifiedFile(input.directory, input.name, details),
        };
      }
      return { kind: "special" };
    }
    if (this.root.symlinkMode === "do-not-follow")
      throw new BoundPathFailure("symbolic-link-not-followed");
    const virtualLink = path.join(input.directory.virtualPath, input.name);
    if (input.linkTrail.has(virtualLink))
      throw new BoundPathFailure("symbolic-link-cycle");
    const rawTarget = await readlink(physical);
    const target = path.resolve(input.directory.virtualPath, rawTarget);
    if (this.routeAuthorizedPath(target) === undefined)
      throw new BoundPathFailure("outside-authorized-roots");
    // 链接下方的路径必然把该链接作为目录穿过，即使最终组成部分是文件。解析最终来源
    // 之前，先证明并约束这次穿越。
    if (input.remaining.length > 0) {
      const linkedDirectory = await this.resolveVirtualPath(
        target,
        "directory",
        new Set([...input.linkTrail, virtualLink]),
      );
      if (linkedDirectory.kind !== "directory") {
        if (linkedDirectory.kind === "file")
          await linkedDirectory.file.handle.close();
        throw new BoundPathFailure("expected-directory");
      }
      try {
        if (!allowsDirectoryLinks(this.root.symlinkMode))
          throw new BoundPathFailure("directory-link-not-allowed");
      } finally {
        await linkedDirectory.directory.close();
      }
    }
    const resolved = await this.resolveVirtualPath(
      path.join(target, ...input.remaining),
      input.terminalExpected,
      new Set([...input.linkTrail, virtualLink]),
    );
    if (resolved.kind === "file" && !allowsFileLinks(this.root.symlinkMode)) {
      await resolved.file.handle.close();
      throw new BoundPathFailure("symbolic-link-not-followed");
    }
    if (
      resolved.kind === "directory" &&
      !allowsDirectoryLinks(this.root.symlinkMode)
    ) {
      await resolved.directory.close();
      throw new BoundPathFailure("directory-link-not-allowed");
    }
    return { ...resolved, consumedRemainder: true };
  }

  /**
   * 只把冻结的注册路径拼写转换到其描述符的规范虚拟命名空间。它绝不对链接目标调用
   * `realpath`：即使操作系统会把未注册别名解析到同一 inode 树，该别名仍在权威之外。
   */
  private routeAuthorizedPath(candidate: string):
    | {
        readonly virtualPath: string;
        readonly authority: FrozenObservedAuthority;
      }
    | undefined {
    const fromRegisteredSpelling = this.bindings
      .filter((binding) => isAncestorOrEqual(binding.containerPath, candidate))
      .toSorted(
        (left, right) =>
          right.containerPath.length - left.containerPath.length ||
          (left.containerPath < right.containerPath
            ? -1
            : left.containerPath > right.containerPath
              ? 1
              : 0),
      )[0];
    if (fromRegisteredSpelling !== undefined) {
      const suffix = path.relative(
        fromRegisteredSpelling.containerPath,
        candidate,
      );
      return {
        virtualPath: path.resolve(fromRegisteredSpelling.canonicalPath, suffix),
        authority: fromRegisteredSpelling.authority,
      };
    }
    const canonicalBinding = this.bindings
      .filter((binding) => isAncestorOrEqual(binding.canonicalPath, candidate))
      .toSorted(
        (left, right) =>
          right.canonicalPath.length - left.canonicalPath.length ||
          (left.canonicalPath < right.canonicalPath
            ? -1
            : left.canonicalPath > right.canonicalPath
              ? 1
              : 0),
      )[0];
    return canonicalBinding === undefined
      ? undefined
      : { virtualPath: candidate, authority: canonicalBinding.authority };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("bound observed scope is closed");
  }
}

class NodeObservedByteSource extends ObservedByteSource {
  private closed = false;
  private consumed = false;
  private readonly handle: FileHandle;
  readonly logicalLocation: string;

  constructor(handle: FileHandle, logicalLocation: string) {
    super();
    this.handle = handle;
    this.logicalLocation = logicalLocation;
  }

  async read(): Promise<Uint8Array> {
    if (this.consumed) throw new Error("observed byte source was already read");
    this.consumed = true;
    try {
      return new Uint8Array(await this.handle.readFile());
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

function descriptorPath(handle: FileHandle): string {
  if (process.platform !== "linux")
    throw new Error("descriptor-bound observed roots are unavailable");
  return `/proc/self/fd/${handle.fd}`;
}

async function openBoundDirectory(
  candidate: string,
  followFinalSymbolicLink = false,
): Promise<FileHandle> {
  if (process.platform !== "linux")
    throw new Error("descriptor-bound observed roots are unavailable");
  return await open(
    candidate,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      (followFinalSymbolicLink ? 0 : fsConstants.O_NOFOLLOW),
  );
}

async function canonicalHandlePath(handle: FileHandle): Promise<string> {
  return await realpath(descriptorPath(handle));
}

async function openFrozenAuthority(
  candidate: string,
  canonical: string,
  followFinalSymbolicLink: boolean,
): Promise<FrozenObservedAuthority> {
  const handle = await openBoundDirectory(candidate, followFinalSymbolicLink);
  try {
    if ((await canonicalHandlePath(handle)) !== canonical)
      throw new Error("bound authority no longer matches its frozen identity");
    return { canonicalPath: canonical, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openVerifiedDirectory(
  parent: NodeBoundDirectory,
  name: string,
  initiallyObserved: Awaited<ReturnType<typeof lstat>>,
  virtualPath: string,
): Promise<NodeBoundDirectory> {
  const handle = await openBoundDirectory(entryPath(parent, name));
  try {
    const details = await handle.stat();
    if (!details.isDirectory() || !sameNodeObject(initiallyObserved, details))
      throw new BoundPathFailure("entry-identity-changed");
    return new NodeBoundDirectory(parent.authority, handle, virtualPath, true);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openVerifiedFile(
  parent: NodeBoundDirectory,
  name: string,
  initiallyObserved: Awaited<ReturnType<typeof lstat>>,
): Promise<NodeBoundFile> {
  const handle = await open(
    entryPath(parent, name),
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const details = await handle.stat();
    if (!details.isFile() || !sameNodeObject(initiallyObserved, details))
      throw new BoundPathFailure("entry-identity-changed");
    return new NodeBoundFile(handle, details);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function sameNodeObject(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function entryPath(directory: NodeBoundDirectory, name: string): string {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes(path.sep)
  )
    throw new Error("invalid observed entry name");
  return path.join(directory.descriptorPath, name);
}

async function closeHandles(handles: readonly FileHandle[]): Promise<void> {
  let firstFailure: unknown;
  for (const handle of [...new Set(handles)].toReversed()) {
    try {
      await handle.close();
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

function validateBoundRelativeScope(value: string): string {
  if (value === ".") return value;
  return validateBoundRelativePath(value);
}

function validateBoundRelativePath(value: string): string {
  if (path.isAbsolute(value)) throw new Error("file path is not relative");
  const normalized = path.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error("file path escapes bound scope");
  }
  return normalized;
}

/**
 * BDMV 具有明确的包根契约。该解析器只建立技术性产物边界，不提供来源身份或媒体模型。
 */
export class BdmvFilesystemPackageInterpreter implements FilesystemPackageInterpreter {
  readonly capability = declareCapability({
    identity: "filesystem.bdmv-package",
    implementationVersion: "1",
    kind: "filesystem-package-interpreter",
    contractVersion: "1",
    interpretationContractVersions: ["1"],
  });

  interpretPackage(
    snapshot: FilesystemPackageSnapshot,
  ): { readonly observedArtifactBoundary: "filesystem-package" } | undefined {
    const files = new Set(snapshot.files.map((file) => file.relativePath));
    const directories = new Set(
      snapshot.directories?.map((directory) => directory.relativePath) ?? [],
    );
    return files.has("BDMV/index.bdmv") &&
      files.has("BDMV/MovieObject.bdmv") &&
      directories.has("BDMV") &&
      directories.has("BDMV/PLAYLIST") &&
      directories.has("BDMV/STREAM")
      ? { observedArtifactBoundary: "filesystem-package" }
      : undefined;
  }
}

/**
 * 生产观察文件系统能力。一个实例持有注册路径检查，以及它绑定、观察、打开和关闭的
 * 每个描述符。绑定观察范围在本模块之外刻意保持不透明：调用方必须把它交回同一个
 * 能力，而不能依赖 Node 专用方法。
 */
export class ReadOnlyFilesystemObserver implements ObservedFilesystemCapability {
  readonly capability = declareCapability({
    identity: "filesystem.read-only-observer",
    implementationVersion: "1",
    kind: "filesystem-observer",
    contractVersion: "1",
    interpretationContractVersions: ["1"],
  });

  /**
   * Linux 的 dev/inode 值可在一次描述符绑定遍历中归组硬链接，但不提供跨观察的耐久
   * 实例或世代保证。
   */
  readonly objectIdentityContract = { kind: "snapshot-local" } as const;

  private readonly boundScopes = new WeakMap<
    BoundObservedScope,
    NodeBoundObservedScope
  >();

  async inspectReadableDirectory(candidate: string): Promise<{
    readonly absolutePath: string;
    readonly canonicalPath: string;
  }> {
    if (!path.isAbsolute(candidate)) throw new Error("not absolute");
    const absolutePath = path.resolve(candidate);
    const details = await stat(absolutePath);
    if (!details.isDirectory()) throw new Error("not a directory");
    await access(absolutePath, fsConstants.R_OK);
    return { absolutePath, canonicalPath: await realpath(absolutePath) };
  }

  async canonicalize(candidate: string): Promise<string> {
    return await canonicalPath(candidate);
  }

  async bindScope(input: {
    readonly root: import("@digital/application").ObservedRootSnapshot;
    readonly relativeScope: string;
  }): Promise<BoundObservedScope> {
    const scope = await NodeBoundObservedScope.bind(input);
    this.boundScopes.set(scope, scope);
    return scope;
  }

  async openByteSource(input: {
    readonly scope: BoundObservedScope;
    readonly relativePath: string;
  }): Promise<ObservedByteSource> {
    return await this.requireBoundScope(input.scope).openByteSource({
      relativePath: input.relativePath,
    });
  }

  async closeScope(scope: BoundObservedScope): Promise<void> {
    await this.requireBoundScope(scope).close();
  }

  async observe(scope: BoundObservedScope): Promise<FilesystemPackageSnapshot> {
    const bound = this.requireBoundScope(scope);
    const snapshotId = `snapshot_${randomUUID()}`;
    // Node 的 dev+ino 证据没有跨进程执行的挂载实例或世代契约。它只对本次不可变快照
    // 内的别名有用，因此其不透明范围会刻意随每次扫描改变。
    const objectIdentityScope = `node-posix-dev-ino/snapshot/${snapshotId}`;
    const files: import("@digital/application").FileObservation[] = [];
    const directories: DirectoryObservation[] = [];
    const excluded: Array<{
      readonly relativePath: string;
      readonly kind: "symbolic-link" | "special" | "unavailable";
    }> = [];
    const diagnostics: FilesystemObservationDiagnostic[] = [];
    const rootDetails = await bound.boundDirectory.handle.stat();
    const rootKey = nodeDirectoryKey(rootDetails);
    await this.readDirectory({
      bound,
      directory: bound.boundDirectory,
      relativeDirectory: ".",
      files,
      directories,
      excluded,
      diagnostics,
      objectIdentityScope,
      activeDirectoryTargets:
        rootKey === undefined ? new Set() : new Set([rootKey]),
      visitedDirectoryTargets:
        rootKey === undefined ? new Set() : new Set([rootKey]),
    });
    return {
      id: snapshotId,
      root: scope.logicalLocation,
      complete: excluded.length === 0 && diagnostics.length === 0,
      files: files.toSorted(compareRelativePath),
      directories: directories.toSorted(compareRelativePath),
      excluded: excluded.toSorted(compareRelativePath),
      ...(diagnostics.length === 0
        ? {}
        : { diagnostics: diagnostics.toSorted(compareRelativePath) }),
      observedAt: new Date().toISOString(),
    };
  }

  private async readDirectory(input: {
    readonly bound: NodeBoundObservedScope;
    readonly directory: NodeBoundDirectory;
    readonly relativeDirectory: string;
    readonly files: import("@digital/application").FileObservation[];
    readonly directories: DirectoryObservation[];
    readonly excluded: Array<{
      readonly relativePath: string;
      readonly kind: "symbolic-link" | "special" | "unavailable";
    }>;
    readonly diagnostics: FilesystemObservationDiagnostic[];
    readonly objectIdentityScope: string;
    readonly activeDirectoryTargets: ReadonlySet<string>;
    readonly visitedDirectoryTargets: Set<string>;
  }): Promise<void> {
    let directoryDetails: Awaited<ReturnType<FileHandle["stat"]>>;
    try {
      directoryDetails = await input.directory.handle.stat();
    } catch (error) {
      this.excludeUnavailable(input, input.relativeDirectory, error);
      return;
    }
    input.directories.push({
      relativePath: input.relativeDirectory,
      modifiedAt: directoryDetails.mtime.toISOString(),
    });
    let names: readonly string[];
    try {
      names = (await input.bound.list(input.directory)).toSorted();
    } catch (error) {
      this.excludeUnavailable(input, input.relativeDirectory, error);
      return;
    }
    for (const name of names) {
      const relativePath = relativeChild(input.relativeDirectory, name);
      let details: Awaited<ReturnType<typeof lstat>>;
      try {
        details = await input.bound.lstatEntry(input.directory, name);
        await filesystemObservationTestHooksFor(this)?.afterEntryLstat?.({
          relativePath,
        });
      } catch (error) {
        this.excludeUnavailable(input, relativePath, error);
        continue;
      }
      if (details.isSymbolicLink()) {
        // 在不跟随模式下，该分支在 `lstat` 后刻意不执行 `stat`、`realpath`、
        // `readlink` 或目标打开。
        if (input.bound.root.symlinkMode === "do-not-follow") {
          input.excluded.push({ relativePath, kind: "symbolic-link" });
          input.diagnostics.push({
            relativePath,
            kind: "symbolic-link-not-followed",
          });
          continue;
        }
        await this.readSymbolicLink({ ...input, name, relativePath, details });
        continue;
      }
      if (details.isDirectory()) {
        await this.readDirectoryEntry({
          ...input,
          name,
          relativePath,
          details,
        });
        continue;
      }
      if (details.isFile()) {
        await this.readFileEntry({ ...input, name, relativePath, details });
        continue;
      }
      input.excluded.push({ relativePath, kind: "special" });
    }
  }

  private async readFileEntry(input: {
    readonly bound: NodeBoundObservedScope;
    readonly directory: NodeBoundDirectory;
    readonly relativeDirectory: string;
    readonly files: import("@digital/application").FileObservation[];
    readonly directories: DirectoryObservation[];
    readonly excluded: Array<{
      readonly relativePath: string;
      readonly kind: "symbolic-link" | "special" | "unavailable";
    }>;
    readonly diagnostics: FilesystemObservationDiagnostic[];
    readonly objectIdentityScope: string;
    readonly activeDirectoryTargets: ReadonlySet<string>;
    readonly visitedDirectoryTargets: Set<string>;
    readonly name: string;
    readonly relativePath: string;
    readonly details: Awaited<ReturnType<typeof lstat>>;
  }): Promise<void> {
    try {
      const resolved = await input.bound.resolveObservedEntry({
        directory: input.directory,
        name: input.name,
        expected: "file",
        initiallyObserved: input.details,
      });
      if (resolved.kind !== "file") {
        if (resolved.kind === "directory") await resolved.directory.close();
        input.excluded.push({
          relativePath: input.relativePath,
          kind: "special",
        });
        return;
      }
      try {
        input.files.push(
          fileObservation(
            input.relativePath,
            resolved.file.details,
            input.objectIdentityScope,
          ),
        );
      } finally {
        await resolved.file.handle.close();
      }
    } catch (error) {
      this.excludeUnavailable(input, input.relativePath, error);
    }
  }

  private async readDirectoryEntry(input: {
    readonly bound: NodeBoundObservedScope;
    readonly directory: NodeBoundDirectory;
    readonly relativeDirectory: string;
    readonly files: import("@digital/application").FileObservation[];
    readonly directories: DirectoryObservation[];
    readonly excluded: Array<{
      readonly relativePath: string;
      readonly kind: "symbolic-link" | "special" | "unavailable";
    }>;
    readonly diagnostics: FilesystemObservationDiagnostic[];
    readonly objectIdentityScope: string;
    readonly activeDirectoryTargets: ReadonlySet<string>;
    readonly visitedDirectoryTargets: Set<string>;
    readonly name: string;
    readonly relativePath: string;
    readonly details: Awaited<ReturnType<typeof lstat>>;
  }): Promise<void> {
    try {
      const resolved = await input.bound.resolveObservedEntry({
        directory: input.directory,
        name: input.name,
        expected: "directory",
        initiallyObserved: input.details,
      });
      if (resolved.kind !== "directory") {
        if (resolved.kind === "file") await resolved.file.handle.close();
        input.excluded.push({
          relativePath: input.relativePath,
          kind: "special",
        });
        return;
      }
      await this.readResolvedDirectory(input, resolved.directory);
    } catch (error) {
      this.excludeUnavailable(input, input.relativePath, error);
    }
  }

  private async readSymbolicLink(input: {
    readonly bound: NodeBoundObservedScope;
    readonly directory: NodeBoundDirectory;
    readonly relativeDirectory: string;
    readonly files: import("@digital/application").FileObservation[];
    readonly directories: DirectoryObservation[];
    readonly excluded: Array<{
      readonly relativePath: string;
      readonly kind: "symbolic-link" | "special" | "unavailable";
    }>;
    readonly diagnostics: FilesystemObservationDiagnostic[];
    readonly objectIdentityScope: string;
    readonly activeDirectoryTargets: ReadonlySet<string>;
    readonly visitedDirectoryTargets: Set<string>;
    readonly name: string;
    readonly relativePath: string;
    readonly details: Awaited<ReturnType<typeof lstat>>;
  }): Promise<void> {
    try {
      const resolved = await input.bound.resolveObservedEntry({
        directory: input.directory,
        name: input.name,
        expected: "either",
        initiallyObserved: input.details,
      });
      if (resolved.kind === "file") {
        try {
          input.files.push(
            fileObservation(
              input.relativePath,
              resolved.file.details,
              input.objectIdentityScope,
            ),
          );
        } finally {
          await resolved.file.handle.close();
        }
        return;
      }
      if (resolved.kind === "directory") {
        await this.readResolvedDirectory(input, resolved.directory);
        return;
      }
      input.excluded.push({
        relativePath: input.relativePath,
        kind: "symbolic-link",
      });
      input.diagnostics.push({
        relativePath: input.relativePath,
        kind: "symbolic-link-not-followed",
      });
    } catch (error) {
      this.excludeLinkFailure(input, input.relativePath, error);
    }
  }

  private async readResolvedDirectory(
    input: {
      readonly bound: NodeBoundObservedScope;
      readonly relativeDirectory: string;
      readonly files: import("@digital/application").FileObservation[];
      readonly directories: DirectoryObservation[];
      readonly excluded: Array<{
        readonly relativePath: string;
        readonly kind: "symbolic-link" | "special" | "unavailable";
      }>;
      readonly diagnostics: FilesystemObservationDiagnostic[];
      readonly objectIdentityScope: string;
      readonly activeDirectoryTargets: ReadonlySet<string>;
      readonly visitedDirectoryTargets: Set<string>;
      readonly relativePath: string;
    },
    directory: NodeBoundDirectory,
  ): Promise<void> {
    try {
      const key = nodeDirectoryKey(await directory.handle.stat());
      if (key !== undefined && input.activeDirectoryTargets.has(key)) {
        input.excluded.push({
          relativePath: input.relativePath,
          kind: "symbolic-link",
        });
        input.diagnostics.push({
          relativePath: input.relativePath,
          kind: "symbolic-link-cycle",
        });
        return;
      }
      if (key !== undefined && input.visitedDirectoryTargets.has(key)) {
        input.excluded.push({
          relativePath: input.relativePath,
          kind: "symbolic-link",
        });
        input.diagnostics.push({
          relativePath: input.relativePath,
          kind: "repeated-directory-target",
        });
        return;
      }
      if (key !== undefined) input.visitedDirectoryTargets.add(key);
      await this.readDirectory({
        ...input,
        directory,
        relativeDirectory: input.relativePath,
        activeDirectoryTargets:
          key === undefined
            ? input.activeDirectoryTargets
            : new Set([...input.activeDirectoryTargets, key]),
      });
    } finally {
      await directory.close();
    }
  }

  private excludeUnavailable(
    input: {
      readonly excluded: Array<{
        readonly relativePath: string;
        readonly kind: "symbolic-link" | "special" | "unavailable";
      }>;
      readonly diagnostics: FilesystemObservationDiagnostic[];
    },
    relativePath: string,
    error: unknown,
  ): void {
    input.excluded.push({ relativePath, kind: "unavailable" });
    input.diagnostics.push({
      relativePath,
      kind: diagnosticForUnavailable(error),
    });
  }

  private excludeLinkFailure(
    input: {
      readonly excluded: Array<{
        readonly relativePath: string;
        readonly kind: "symbolic-link" | "special" | "unavailable";
      }>;
      readonly diagnostics: FilesystemObservationDiagnostic[];
    },
    relativePath: string,
    error: unknown,
  ): void {
    input.excluded.push({ relativePath, kind: "symbolic-link" });
    input.diagnostics.push({
      relativePath,
      kind: diagnosticForLinkFailure(error),
    });
  }

  private requireBoundScope(scope: BoundObservedScope): NodeBoundObservedScope {
    const bound = this.boundScopes.get(scope);
    if (bound === undefined)
      throw new Error("filesystem scope does not belong to this capability");
    return bound;
  }
}

function allowsFileLinks(
  mode:
    | "do-not-follow"
    | "follow-file-links"
    | "follow-file-and-directory-links",
): boolean {
  return (
    mode === "follow-file-links" || mode === "follow-file-and-directory-links"
  );
}

function allowsDirectoryLinks(
  mode:
    | "do-not-follow"
    | "follow-file-links"
    | "follow-file-and-directory-links",
): boolean {
  return mode === "follow-file-and-directory-links";
}

function fileObservation(
  relativePath: string,
  details: Awaited<ReturnType<FileHandle["stat"]>>,
  objectIdentityScope: string,
): {
  readonly relativePath: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly objectIdentity?: {
    readonly version: "filesystem-object-identity/2";
    readonly kind: "snapshot-local";
    readonly value: string;
  };
} {
  if (
    typeof details.size !== "number" ||
    !Number.isSafeInteger(details.size) ||
    details.size < 0
  )
    throw new Error(
      `Filesystem observation has an unsafe file size: ${relativePath}`,
    );
  const identity = opaqueObjectIdentity(details, objectIdentityScope);
  return {
    relativePath,
    size: details.size,
    modifiedAt: details.mtime.toISOString(),
    ...(identity === undefined ? {} : { objectIdentity: identity }),
  };
}

function opaqueObjectIdentity(
  details: Awaited<ReturnType<FileHandle["stat"]>>,
  observerScope: string,
):
  | {
      readonly version: "filesystem-object-identity/2";
      readonly kind: "snapshot-local";
      readonly value: string;
    }
  | undefined {
  if (
    typeof details.dev !== "number" ||
    typeof details.ino !== "number" ||
    !Number.isSafeInteger(details.dev) ||
    !Number.isSafeInteger(details.ino) ||
    details.dev < 0 ||
    details.ino < 0
  )
    return undefined;
  if (observerScope.trim().length === 0) return undefined;
  return {
    version: "filesystem-object-identity/2",
    kind: "snapshot-local",
    value: createHash("sha256")
      .update(`${observerScope}\u0000${details.dev}\u0000${details.ino}`)
      .digest("hex"),
  };
}

function nodeDirectoryKey(details: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}): string | undefined {
  if (
    (typeof details.dev !== "number" && typeof details.dev !== "bigint") ||
    (typeof details.ino !== "number" && typeof details.ino !== "bigint")
  ) {
    return undefined;
  }
  return `${details.dev}:${details.ino}`;
}

function relativeChild(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function diagnosticForUnavailable(
  error: unknown,
):
  | "entry-missing"
  | "entry-inaccessible"
  | "symbolic-link-cycle"
  | "entry-identity-changed" {
  if (error instanceof BoundPathFailure) {
    if (error.kind === "entry-identity-changed") return error.kind;
    if (error.kind === "symbolic-link-cycle") return error.kind;
  }
  if (isMissingPath(error)) return "entry-missing";
  if (errorCode(error) === "ELOOP") return "symbolic-link-cycle";
  return "entry-inaccessible";
}

function diagnosticForLinkFailure(
  error: unknown,
): FilesystemObservationDiagnostic["kind"] {
  if (error instanceof BoundPathFailure) {
    if (error.kind === "outside-authorized-roots")
      return "link-target-outside-authorized-roots";
    if (error.kind === "directory-link-not-allowed") return error.kind;
    if (error.kind === "symbolic-link-cycle") return error.kind;
    if (error.kind === "entry-identity-changed") return error.kind;
    return "symbolic-link-not-followed";
  }
  if (isMissingPath(error)) return "broken-symbolic-link";
  if (errorCode(error) === "ELOOP") return "symbolic-link-cycle";
  return "inaccessible-symbolic-link";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * 在 SQLite、托管存储或其他产品持有的写入者创建路径前验证效果根。既有和尚不存在的
 * 路径都通过最深的既有祖先规范化，使符号链接父目录无法绕过观察根边界。
 */
export async function assertRootsDoNotOverlap(
  observedRoot: string,
  ...productRoots: readonly string[]
): Promise<string> {
  const observed = await canonicalPath(observedRoot);
  for (const productRoot of productRoots) {
    const product = await canonicalPath(productRoot);
    if (pathsOverlap(observed, product)) {
      throw new Error(
        `Observed root and product data root must not overlap: ${observed} <> ${product}`,
      );
    }
  }
  return observed;
}

async function canonicalPath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const existing = await realpath(current);
      return path.join(existing, ...missing.toReversed());
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isAncestorOrEqual(left, right) || isAncestorOrEqual(right, left);
}

function isAncestorOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative.length === 0 ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/** 刻意不依赖区域设置，使快照顺序可移植且可复现。 */
function compareRelativePath(
  left: { readonly relativePath: string },
  right: { readonly relativePath: string },
): number {
  return left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath
      ? 1
      : 0;
}

export class ContentAddressedManagedArtifactStore implements ManagedArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** 将内部文件位置收窄为交付安全的内容摘要。 */
  reference(address: string): { readonly digest: string } | undefined {
    const resolved = path.resolve(address);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) return undefined;
    const digest = path.basename(resolved);
    if (!/^[a-f0-9]{64}$/u.test(digest)) return undefined;
    const expected = path.join(this.root, digest.slice(0, 2), digest);
    return resolved === expected ? { digest } : undefined;
  }

  /** 通过摘要读取一个正式托管产物，不接受文件系统路径。 */
  async read(digest: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("未找到托管产物");
    return new Uint8Array(
      await readFile(path.join(this.root, digest.slice(0, 2), digest)),
    );
  }

  async store(content: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<{
    readonly blob: {
      readonly digest: string;
      readonly mediaType: string;
      readonly byteLength: number;
    };
    readonly location: { readonly address: string };
  }> {
    const digest = createHash("sha256").update(content.bytes).digest("hex");
    const directory = path.join(this.root, digest.slice(0, 2));
    const location = path.join(directory, digest);
    await mkdir(directory, { recursive: true });
    try {
      await stat(location);
    } catch {
      const temporary = path.join(directory, `.${digest}.${randomUUID()}`);
      await writeFile(temporary, content.bytes, { flag: "wx" });
      await rename(temporary, location).catch(async (error: unknown) => {
        try {
          await stat(location);
        } catch {
          throw error;
        }
      });
    }
    return {
      blob: {
        digest,
        mediaType:
          content.mediaType.split(";", 1)[0]?.trim().toLowerCase() ??
          content.mediaType,
        byteLength: content.bytes.byteLength,
      },
      location: { address: location },
    };
  }

  async stage(content: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly idempotencyKey: string;
    readonly candidateId: string;
    readonly sourceRecordId: string;
    readonly role?: string;
  }): Promise<CoverAcquisitionCheckpoint> {
    const digest = createHash("sha256").update(content.bytes).digest("hex");
    const key = createHash("sha256")
      .update(content.idempotencyKey)
      .digest("hex");
    const directory = path.join(this.root, "staging");
    const location = path.join(directory, key);
    await mkdir(directory, { recursive: true });
    try {
      const existing = await readFile(location);
      if (createHash("sha256").update(existing).digest("hex") !== digest) {
        throw new Error(
          "Managed staging idempotency key refers to different bytes",
        );
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      await writeFile(location, content.bytes, { flag: "wx" }).catch(
        async (writeError: unknown) => {
          // 竞态进程可能已经暂存完全相同的幂等键。
          if (
            !(
              typeof writeError === "object" &&
              writeError !== null &&
              "code" in writeError &&
              writeError.code === "EEXIST"
            )
          )
            throw writeError;
          const existing = await readFile(location);
          if (createHash("sha256").update(existing).digest("hex") !== digest)
            throw writeError;
        },
      );
    }
    return {
      candidateId: content.candidateId,
      sourceRecordId: content.sourceRecordId,
      role: content.role ?? "asset.primary-cover",
      stagedReference: location,
      digest,
      mediaType: content.mediaType,
    };
  }

  async storeStaged(checkpoint: CoverAcquisitionCheckpoint): Promise<{
    readonly blob: {
      readonly digest: string;
      readonly mediaType: string;
      readonly byteLength: number;
    };
    readonly location: { readonly address: string };
  }> {
    const bytes = new Uint8Array(await readFile(checkpoint.stagedReference));
    if (
      createHash("sha256").update(bytes).digest("hex") !== checkpoint.digest
    ) {
      throw new Error(
        "Managed staging bytes no longer match their durable checkpoint",
      );
    }
    return await this.store({ bytes, mediaType: checkpoint.mediaType });
  }

  async isAvailable(address: string): Promise<boolean> {
    try {
      return (await stat(address)).isFile();
    } catch {
      return false;
    }
  }
}
