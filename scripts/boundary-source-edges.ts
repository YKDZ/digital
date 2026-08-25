import { lstatSync, realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

type PackageRoot = {
  readonly name: string;
  readonly root: string;
};

type Manifest = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly imports?: Record<string, unknown>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

type AliasTarget = {
  /** 未解析模块说明符，或相对于 `base` 的路径。 */
  readonly specifier: string;
  readonly base: string;
};

type AliasMapping = {
  readonly pattern: string;
  readonly targets: readonly AliasTarget[];
};

type AliasContext = {
  /** 在 `package.json` 依赖值中声明的裸包别名。 */
  readonly dependencyAliases: ReadonlyMap<string, readonly string[]>;
  readonly mappings: readonly AliasMapping[];
  readonly tsconfigAliasCycles: readonly TsconfigAliasCycle[];
};

type DependencyAliasTarget = {
  readonly alias: string;
  readonly specifier: string;
};

type DependencyAliasSpecifierResolution =
  | { readonly kind: "resolved"; readonly specifier: string }
  | { readonly kind: "alias-cycle"; readonly specifier: string };

type DependencyAliasMap = ReadonlyMap<string, readonly string[]>;

type TsconfigAliasCycle = {
  readonly kind: "dependency-alias" | "extends";
  readonly owner: string;
  readonly realConfigPath: string;
  readonly specifier: string;
};

const noDependencyAliases: DependencyAliasMap = new Map();

type TsconfigResolverContext = {
  readonly dependencyAliasesByPackage: ReadonlyMap<string, DependencyAliasMap>;
  readonly packageRoots: readonly PackageRoot[];
};

type TsconfigAliasState = {
  /** 生效的绝对 `compilerOptions.baseUrl`。 */
  readonly baseUrl?: string;
  /** 如果已配置，表示生效的 `compilerOptions.paths` 对象。 */
  readonly paths?: ReadonlyMap<string, readonly string[]>;
  /** 提供生效 `paths` 选项的配置目录。 */
  readonly pathsBasePath?: string;
};

type WorkspaceResolution = {
  readonly kind: "workspace";
  readonly target: PackageRoot;
  /** 标签和依赖均允许时，包导出才合法。 */
  readonly access: "package-export" | "source-file";
};

type BareResolution = {
  readonly kind: "bare";
  readonly specifier: string;
};

type AliasCycleResolution = {
  readonly kind: "alias-cycle";
  readonly specifier: string;
};

type UnresolvablePathResolution = {
  readonly kind: "unresolvable-path";
  readonly path: string;
  readonly reason: "broken symlink" | "symlink cycle";
};

type CanonicalPath =
  | { readonly kind: "canonical"; readonly path: string }
  | { readonly kind: "lexical"; readonly path: string }
  | {
      readonly kind: "symlink-error";
      readonly path: string;
      readonly reason: UnresolvablePathResolution["reason"];
    };

type ModuleResolution =
  | WorkspaceResolution
  | BareResolution
  | AliasCycleResolution
  | UnresolvablePathResolution;

/**
 * 检查解析后的来源边，而不只检查恰好以 `@digital/` 开头的源码文本。否则内部包导入和
 * TypeScript 路径别名可能掩盖跨包导入或持久化实现。
 */
export async function checkSourceEdges(options: {
  readonly packagePaths: ReadonlyMap<string, string>;
  readonly packageTags: ReadonlyMap<string, readonly string[]>;
  readonly workspaceRoot: string;
}): Promise<readonly string[]> {
  const failures: string[] = [];
  const packageRoots = [...options.packagePaths].map(
    ([name, relativePath]) =>
      ({
        name,
        root: path.resolve(options.workspaceRoot, relativePath),
      }) satisfies PackageRoot,
  );
  const canonicalPackageRoots = packageRoots.map((packageRoot) => ({
    ...packageRoot,
    root: canonicalPath(packageRoot.root).path,
  }));
  const contexts = new Map<
    string,
    {
      readonly aliases: AliasContext;
      readonly manifest: Manifest;
      readonly workspaceDependencies: ReadonlySet<string>;
    }
  >();
  const manifests = new Map<string, Manifest>();
  const dependencyAliasesByPackage = new Map<string, DependencyAliasMap>();
  const reportedTsconfigCycles = new Set<string>();
  for (const owner of packageRoots) {
    const manifest = await readManifest(owner.root);
    manifests.set(owner.name, manifest);
    dependencyAliasesByPackage.set(
      owner.name,
      dependencyAliasesFromManifest(manifest),
    );
  }
  const tsconfigResolver: TsconfigResolverContext = {
    dependencyAliasesByPackage,
    packageRoots,
  };
  for (const owner of packageRoots) {
    const manifest = manifests.get(owner.name);
    if (manifest === undefined)
      throw new Error(`Missing manifest for ${owner.name}`);
    const dependencyAliases = dependencyAliasesByPackage.get(owner.name);
    if (dependencyAliases === undefined)
      throw new Error(`Missing dependency aliases for ${owner.name}`);
    const aliases = await readAliasContext(owner, manifest, tsconfigResolver);
    contexts.set(owner.name, {
      manifest,
      aliases,
      workspaceDependencies: declaredWorkspaceDependencies(
        manifest,
        dependencyAliases,
        packageRoots,
      ),
    });
  }

  for (const owner of packageRoots) {
    const context = contexts.get(owner.name);
    if (context === undefined)
      throw new Error(`Missing boundary context for ${owner.name}`);
    const ownerTags = options.packageTags.get(owner.name) ?? [];
    const persistenceForbidden =
      forbidsPersistenceImplementationImports(ownerTags);
    for (const cycle of context.aliases.tsconfigAliasCycles) {
      const failure = `${cycle.owner}: unresolvable tsconfig ${cycle.kind === "dependency-alias" ? "dependency alias" : "extends"} cycle ${cycle.specifier} at ${cycle.realConfigPath}`;
      if (!reportedTsconfigCycles.has(failure)) {
        failures.push(failure);
        reportedTsconfigCycles.add(failure);
      }
    }
    for (const file of await sourceFiles(owner.root)) {
      for (const specifier of moduleSpecifiers(await readFile(file, "utf8"))) {
        const resolutions = resolveModuleSpecifiers({
          aliases: context.aliases,
          file,
          owner,
          packageRoots: canonicalPackageRoots,
          specifier,
        });
        for (const resolution of resolutions) {
          if (resolution.kind === "alias-cycle") {
            failures.push(
              `${owner.name}: unresolvable source alias cycle ${specifier} from ${file}`,
            );
            continue;
          }
          if (resolution.kind === "unresolvable-path") {
            failures.push(
              `${owner.name}: unresolvable source path ${specifier} from ${file}: ${resolution.reason}`,
            );
            continue;
          }
          if (resolution.kind !== "workspace") continue;
          const target = resolution.target;
          if (target.name === owner.name) continue;
          if (resolution.access === "source-file") {
            failures.push(
              `${owner.name}: forbidden source import ${specifier} from ${file} to ${target.name}; cross-package imports must use declared package exports`,
            );
            continue;
          }
          const targetTag = (options.packageTags.get(target.name) ?? [])[0];
          if (
            targetTag === undefined ||
            !ownerTags.some((tag) => allowedTags(tag).has(targetTag))
          ) {
            failures.push(
              `${owner.name}: forbidden source import ${specifier} from ${file} to ${target.name}`,
            );
          }
          if (!context.workspaceDependencies.has(target.name)) {
            failures.push(
              `${owner.name}: undeclared workspace source import ${specifier} from ${file}`,
            );
          }
        }
        if (
          persistenceForbidden &&
          resolutionImportsPersistence(specifier, resolutions)
        ) {
          failures.push(
            `${owner.name}: forbidden persistence implementation import ${specifier} from ${file}`,
          );
        }
      }
    }
  }
  return failures;
}

function resolutionImportsPersistence(
  original: string,
  resolutions: readonly ModuleResolution[],
): boolean {
  return [
    original,
    ...resolutions.map((resolution) =>
      resolution.kind === "bare"
        ? resolution.specifier
        : resolution.kind === "workspace"
          ? resolution.target.name
          : resolution.kind === "unresolvable-path"
            ? resolution.path
            : resolution.specifier,
    ),
  ].some(isPersistenceImplementationImport);
}

function forbidsPersistenceImplementationImports(
  tags: readonly string[],
): boolean {
  return tags.some((tag) =>
    ["application", "delivery", "domain", "presentation"].includes(tag),
  );
}

function isPersistenceImplementationImport(specifier: string): boolean {
  return [
    "@digital/sqlite",
    "@libsql/client",
    "better-sqlite3",
    "drizzle-kit",
    "drizzle-orm",
    "node:sqlite",
    "sqlite3",
  ].some(
    (implementation) =>
      specifier === implementation ||
      specifier.startsWith(`${implementation}/`),
  );
}

function allowedTags(tag: string): ReadonlySet<string> {
  const rules: Record<string, readonly string[]> = {
    application: ["application", "domain"],
    composition: [
      "tooling",
      "integration",
      "infrastructure",
      "application",
      "domain",
    ],
    delivery: [
      "delivery",
      "presentation",
      "composition",
      "application",
      "domain",
    ],
    domain: ["domain"],
    infrastructure: ["application", "domain"],
    integration: ["application", "domain"],
    presentation: ["presentation", "application", "domain"],
    tooling: [
      "tooling",
      "integration",
      "infrastructure",
      "application",
      "domain",
    ],
  };
  return new Set(rules[tag] ?? []);
}

async function readManifest(root: string): Promise<Manifest> {
  return JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as Manifest;
}

function declaredWorkspaceDependencies(
  manifest: Manifest,
  dependencyAliases: ReadonlyMap<string, readonly string[]>,
  packageRoots: readonly PackageRoot[],
): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const [specifier] of manifestDependencyEntries(manifest)) {
    for (const workspace of resolveDependencyAliasToWorkspace(
      specifier,
      dependencyAliases,
      packageRoots,
    )) {
      declared.add(workspace.name);
    }
  }
  return declared;
}

function manifestDependencyEntries(
  manifest: Manifest,
): readonly (readonly [string, string])[] {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].flatMap((dependencies) => Object.entries(dependencies ?? {}));
}

function dependencyAliasesFromManifest(
  manifest: Manifest,
): ReadonlyMap<string, readonly string[]> {
  const aliases = new Map<string, string[]>();
  for (const [alias, range] of manifestDependencyEntries(manifest)) {
    const target = packageAliasTarget(range);
    if (target === undefined) continue;
    const targets = aliases.get(alias) ?? [];
    if (!targets.includes(target)) targets.push(target);
    aliases.set(alias, targets);
  }
  return aliases;
}

function packageAliasTarget(range: string): string | undefined {
  const target = range.startsWith("workspace:")
    ? range.slice("workspace:".length)
    : range.startsWith("npm:")
      ? range.slice("npm:".length)
      : undefined;
  return target === undefined ? undefined : packageNameFromAliasTarget(target);
}

function packageNameFromAliasTarget(target: string): string | undefined {
  if (target.length === 0 || target.startsWith(".") || target.startsWith("/"))
    return undefined;
  if (target.startsWith("@")) {
    const slash = target.indexOf("/");
    if (slash <= 1) return undefined;
    const version = target.indexOf("@", slash + 1);
    return version === -1 ? target : target.slice(0, version);
  }
  const version = target.indexOf("@");
  const name = version === -1 ? target : target.slice(0, version);
  return name.length === 0 || /[*/^~]/u.test(name) ? undefined : name;
}

function matchingDependencyAliasTargets(
  dependencyAliases: ReadonlyMap<string, readonly string[]>,
  specifier: string,
): readonly DependencyAliasTarget[] {
  const matchingAliases = [...dependencyAliases.entries()]
    .filter(
      ([alias]) => specifier === alias || specifier.startsWith(`${alias}/`),
    )
    .toSorted(([left], [right]) => right.length - left.length);
  const [alias, targets] = matchingAliases[0] ?? [];
  if (alias === undefined || targets === undefined) return [];
  const suffix = specifier.slice(alias.length);
  return targets.map((target) => ({
    alias,
    specifier: `${target}${suffix}`,
  }));
}

function resolveDependencyAliasToWorkspace(
  specifier: string,
  dependencyAliases: ReadonlyMap<string, readonly string[]>,
  packageRoots: readonly PackageRoot[],
): readonly PackageRoot[] {
  return resolveDependencyAliasSpecifiers(specifier, dependencyAliases).flatMap(
    (resolution) => {
      if (resolution.kind === "alias-cycle") return [];
      const workspace = workspacePackageForSpecifier(
        resolution.specifier,
        packageRoots,
      );
      return workspace === undefined ? [] : [workspace];
    },
  );
}

function resolveDependencyAliasSpecifiers(
  specifier: string,
  dependencyAliases: ReadonlyMap<string, readonly string[]>,
  aliasesSeen: ReadonlySet<string> = new Set(),
): readonly DependencyAliasSpecifierResolution[] {
  const targets = matchingDependencyAliasTargets(dependencyAliases, specifier);
  const firstTarget = targets[0];
  if (firstTarget === undefined) return [{ kind: "resolved", specifier }];
  const alias = firstTarget.alias;
  if (aliasesSeen.has(alias)) return [{ kind: "alias-cycle", specifier }];
  const nextAliases = new Set(aliasesSeen).add(alias);
  return targets.flatMap((target) =>
    resolveDependencyAliasSpecifiers(
      target.specifier,
      dependencyAliases,
      nextAliases,
    ),
  );
}

async function readAliasContext(
  owner: PackageRoot,
  manifest: Manifest,
  tsconfigResolver: TsconfigResolverContext,
): Promise<AliasContext> {
  const mappings = importAliasMappings(manifest.imports, owner.root);
  const dependencyAliases = tsconfigResolver.dependencyAliasesByPackage.get(
    owner.name,
  );
  if (dependencyAliases === undefined)
    throw new Error(`Missing dependency aliases for ${owner.name}`);
  const tsconfigAliasCycles = new Map<string, TsconfigAliasCycle>();
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = await readdir(owner.root, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT")
      return { dependencyAliases, mappings, tsconfigAliasCycles: [] };
    throw error;
  }
  const configPaths = entries
    .filter(
      (entry) =>
        entry.isFile() && /^tsconfig(?:\..+)?\.json$/u.test(entry.name),
    )
    .map((entry) => path.join(owner.root, entry.name));
  const extendedConfigPaths = new Set<string>();
  for (const configPath of configPaths) {
    const config = await readJsonObject(configPath);
    if (config === undefined) continue;
    for (const parent of tsconfigExtends(config.extends)) {
      const parentPath = resolveTsconfigExtends(
        parent,
        configPath,
        tsconfigResolver,
        tsconfigAliasCycles,
      );
      if (parentPath !== undefined) extendedConfigPaths.add(parentPath);
    }
  }
  const entrypointConfigPaths = configPaths.filter(
    (configPath) => !extendedConfigPaths.has(path.resolve(configPath)),
  );
  for (const configPath of entrypointConfigPaths.length === 0
    ? configPaths
    : entrypointConfigPaths) {
    mappings.push(
      ...(await readTsconfigAliasMappings(
        configPath,
        tsconfigResolver,
        tsconfigAliasCycles,
        new Set(),
      )),
    );
  }
  return {
    dependencyAliases,
    mappings: deduplicateAliasMappings(mappings),
    tsconfigAliasCycles: [...tsconfigAliasCycles.values()],
  };
}

function importAliasMappings(
  imports: Record<string, unknown> | undefined,
  base: string,
): AliasMapping[] {
  if (imports === undefined) return [];
  return Object.entries(imports)
    .map(([pattern, target]) => ({
      pattern,
      targets: importMapTargets(target).map((specifier) => ({
        specifier,
        base,
      })),
    }))
    .filter((mapping) => mapping.targets.length > 0);
}

function importMapTargets(target: unknown): string[] {
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) return target.flatMap(importMapTargets);
  if (isRecord(target)) return Object.values(target).flatMap(importMapTargets);
  return [];
}

async function readTsconfigAliasMappings(
  configPath: string,
  tsconfigResolver: TsconfigResolverContext,
  tsconfigAliasCycles: Map<string, TsconfigAliasCycle>,
  ancestors: ReadonlySet<string>,
): Promise<AliasMapping[]> {
  const state = await readTsconfigAliasState(
    configPath,
    tsconfigResolver,
    tsconfigAliasCycles,
    ancestors,
  );
  if (state.paths === undefined) return [];
  const base = state.baseUrl ?? state.pathsBasePath;
  if (base === undefined) return [];
  return [...state.paths.entries()]
    .map(([pattern, targets]) => ({
      pattern,
      targets: targets.map((specifier) => ({ specifier, base })),
    }))
    .filter((mapping) => mapping.targets.length > 0);
}

async function readTsconfigAliasState(
  configPath: string,
  tsconfigResolver: TsconfigResolverContext,
  tsconfigAliasCycles: Map<string, TsconfigAliasCycle>,
  ancestors: ReadonlySet<string>,
): Promise<TsconfigAliasState> {
  const normalizedPath = path.resolve(configPath);
  if (ancestors.has(normalizedPath)) return {};
  const config = await readJsonObject(normalizedPath);
  if (config === undefined) return {};
  const nextAncestors = new Set(ancestors).add(normalizedPath);
  let inherited: TsconfigAliasState = {};
  for (const parent of tsconfigExtends(config.extends)) {
    const parentPath = resolveTsconfigExtends(
      parent,
      normalizedPath,
      tsconfigResolver,
      tsconfigAliasCycles,
    );
    if (parentPath === undefined) continue;
    const normalizedParentPath = path.resolve(parentPath);
    if (nextAncestors.has(normalizedParentPath)) {
      recordTsconfigAliasCycle(
        tsconfigAliasCycles,
        "extends",
        packageRootForPath(normalizedPath, tsconfigResolver.packageRoots),
        parent,
        normalizedParentPath,
      );
      continue;
    }
    inherited = mergeTsconfigAliasStates(
      inherited,
      await readTsconfigAliasState(
        normalizedParentPath,
        tsconfigResolver,
        tsconfigAliasCycles,
        nextAncestors,
      ),
    );
  }
  const compilerOptions = isRecord(config.compilerOptions)
    ? config.compilerOptions
    : undefined;
  const configDirectory = path.dirname(normalizedPath);
  const own: TsconfigAliasState = {
    ...(typeof compilerOptions?.baseUrl === "string"
      ? { baseUrl: path.resolve(configDirectory, compilerOptions.baseUrl) }
      : {}),
    ...(compilerOptions !== undefined && Object.hasOwn(compilerOptions, "paths")
      ? {
          paths: tsconfigPaths(compilerOptions.paths),
          pathsBasePath: configDirectory,
        }
      : {}),
  };
  return mergeTsconfigAliasStates(inherited, own);
}

function tsconfigExtends(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function tsconfigPaths(value: unknown): ReadonlyMap<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>();
  if (!isRecord(value)) return paths;
  for (const [pattern, targets] of Object.entries(value)) {
    paths.set(
      pattern,
      Array.isArray(targets)
        ? targets.filter(
            (target): target is string => typeof target === "string",
          )
        : [],
    );
  }
  return paths;
}

function mergeTsconfigAliasStates(
  base: TsconfigAliasState,
  extension: TsconfigAliasState,
): TsconfigAliasState {
  return {
    ...(extension.baseUrl === undefined
      ? base.baseUrl === undefined
        ? {}
        : { baseUrl: base.baseUrl }
      : { baseUrl: extension.baseUrl }),
    ...(extension.paths === undefined
      ? base.paths === undefined
        ? {}
        : { paths: base.paths, pathsBasePath: base.pathsBasePath }
      : {
          paths: extension.paths,
          pathsBasePath: extension.pathsBasePath,
        }),
  };
}

function resolveTsconfigExtends(
  value: string,
  configPath: string,
  tsconfigResolver: TsconfigResolverContext,
  tsconfigAliasCycles: Map<string, TsconfigAliasCycle>,
): string | undefined {
  if (value.startsWith(".") || path.isAbsolute(value)) {
    const resolved = path.resolve(path.dirname(configPath), value);
    return path.extname(resolved) === "" ? `${resolved}.json` : resolved;
  }
  const owner = packageRootForPath(configPath, tsconfigResolver.packageRoots);
  const dependencyAliases =
    (owner === undefined
      ? undefined
      : tsconfigResolver.dependencyAliasesByPackage.get(owner.name)) ??
    noDependencyAliases;
  const dependencyResolutions = resolveDependencyAliasSpecifiers(
    value,
    dependencyAliases,
  );
  if (dependencyResolutions.some((result) => result.kind === "alias-cycle")) {
    recordTsconfigAliasCycle(
      tsconfigAliasCycles,
      "dependency-alias",
      owner,
      value,
      configPath,
    );
  }
  const [resolved] = dependencyResolutions.filter(
    (
      resolution,
    ): resolution is Extract<
      DependencyAliasSpecifierResolution,
      { readonly kind: "resolved" }
    > => resolution.kind === "resolved",
  );
  if (resolved === undefined) return undefined;
  const workspace = workspacePackageForSpecifier(
    resolved.specifier,
    tsconfigResolver.packageRoots,
  );
  if (workspace === undefined) return undefined;
  const subpath = resolved.specifier
    .slice(workspace.name.length)
    .replace(/^\//u, "");
  return path.join(workspace.root, subpath || "tsconfig.json");
}

function recordTsconfigAliasCycle(
  cycles: Map<string, TsconfigAliasCycle>,
  kind: TsconfigAliasCycle["kind"],
  owner: PackageRoot | undefined,
  specifier: string,
  realConfigPath: string,
): void {
  const normalizedConfigPath = path.resolve(realConfigPath);
  const ownerName = owner?.name ?? normalizedConfigPath;
  const cycle: TsconfigAliasCycle = {
    kind,
    owner: ownerName,
    realConfigPath: normalizedConfigPath,
    specifier,
  };
  cycles.set(
    `${cycle.owner}\u0000${cycle.specifier}\u0000${cycle.realConfigPath}`,
    cycle,
  );
}

function packageRootForPath(
  filename: string,
  packageRoots: readonly PackageRoot[],
): PackageRoot | undefined {
  const normalizedFilename = path.resolve(filename);
  return packageRoots
    .filter((packageRoot) => {
      const relative = path.relative(packageRoot.root, normalizedFilename);
      return (
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      );
    })
    .toSorted((left, right) => right.root.length - left.root.length)[0];
}

async function readJsonObject(
  filename: string,
): Promise<Record<string, unknown> | undefined> {
  let source: string;
  try {
    source = await readFile(filename, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(source) as unknown;
  if (!isRecord(parsed))
    throw new Error(`Expected ${filename} to contain a JSON object`);
  return parsed;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deduplicateAliasMappings(
  mappings: readonly AliasMapping[],
): AliasMapping[] {
  const unique = new Map<string, AliasMapping>();
  for (const mapping of mappings) {
    const targets = mapping.targets.filter(
      (target, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.base === target.base &&
            candidate.specifier === target.specifier,
        ) === index,
    );
    unique.set(
      `${mapping.pattern}\u0000${targets
        .map((target) => `${target.base}\u0000${target.specifier}`)
        .join("\u0001")}`,
      { ...mapping, targets },
    );
  }
  return [...unique.values()];
}

function resolveModuleSpecifiers(options: {
  readonly aliases: AliasContext;
  readonly file: string;
  readonly owner: PackageRoot;
  readonly packageRoots: readonly PackageRoot[];
  readonly specifier: string;
}): readonly ModuleResolution[] {
  const resolve = (
    specifier: string,
    aliasesSeen: ReadonlySet<string>,
    depth: number,
  ): readonly ModuleResolution[] => {
    if (depth > 32) return [];
    const aliasTargets = matchingAliasTargets(options.aliases, specifier);
    if (aliasTargets.length > 0) {
      const aliasCycleKey = `mapping:${specifier}`;
      if (aliasesSeen.has(aliasCycleKey))
        return [{ kind: "alias-cycle", specifier }];
      const nextAliases = new Set(aliasesSeen).add(aliasCycleKey);
      return aliasTargets.flatMap((target) =>
        isPathSpecifier(target.specifier)
          ? workspacePathResolution(
              path.resolve(target.base, target.specifier),
              options.packageRoots,
            )
          : resolve(target.specifier, nextAliases, depth + 1),
      );
    }
    const dependencyResolutions = resolveDependencyAliasSpecifiers(
      specifier,
      options.aliases.dependencyAliases,
    );
    if (dependencyResolutions.some((result) => result.kind === "alias-cycle"))
      return [{ kind: "alias-cycle", specifier }];
    const dependencySpecifiers = dependencyResolutions
      .filter(
        (
          resolution,
        ): resolution is Extract<
          DependencyAliasSpecifierResolution,
          { readonly kind: "resolved" }
        > => resolution.kind === "resolved",
      )
      .map((resolution) => resolution.specifier);
    if (dependencySpecifiers.some((target) => target !== specifier))
      return dependencySpecifiers.flatMap((target) =>
        resolve(target, aliasesSeen, depth + 1),
      );
    const workspace = workspacePackageForSpecifier(
      specifier,
      options.packageRoots,
    );
    if (workspace !== undefined)
      return [
        { kind: "workspace", target: workspace, access: "package-export" },
      ];
    if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
      const target = path.resolve(path.dirname(options.file), specifier);
      return workspacePathResolution(target, options.packageRoots);
    }
    return [{ kind: "bare", specifier }];
  };
  return deduplicateResolutions(resolve(options.specifier, new Set(), 0));
}

function matchingAliasTargets(
  context: AliasContext,
  specifier: string,
): AliasTarget[] {
  return context.mappings.flatMap((mapping) => {
    const replacement = aliasReplacement(mapping.pattern, specifier);
    if (replacement === undefined) return [];
    return mapping.targets.map((target) => ({
      ...target,
      specifier:
        replacement === null
          ? target.specifier
          : target.specifier.replaceAll("*", replacement),
    }));
  });
}

/** `null` 表示别名精确匹配；`undefined` 表示不匹配。 */
function aliasReplacement(
  pattern: string,
  specifier: string,
): string | null | undefined {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1) return pattern === specifier ? null : undefined;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (
    !specifier.startsWith(prefix) ||
    !specifier.endsWith(suffix) ||
    specifier.length < prefix.length + suffix.length
  )
    return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function isPathSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    path.isAbsolute(specifier)
  );
}

function workspacePathResolution(
  targetPath: string,
  packageRoots: readonly PackageRoot[],
): readonly ModuleResolution[] {
  const canonicalTarget = canonicalPath(targetPath);
  if (canonicalTarget.kind === "symlink-error") {
    return [
      {
        kind: "unresolvable-path",
        path: canonicalTarget.path,
        reason: canonicalTarget.reason,
      },
    ];
  }
  const canonicalTargetPath = canonicalTarget.path;
  const workspace = packageRoots
    .toSorted((left, right) => right.root.length - left.root.length)
    .find(
      (entry) =>
        canonicalTargetPath === entry.root ||
        canonicalTargetPath.startsWith(`${entry.root}${path.sep}`),
    );
  return workspace === undefined
    ? []
    : [{ kind: "workspace", target: workspace, access: "source-file" }];
}

function canonicalPath(targetPath: string): CanonicalPath {
  const lexicalPath = path.resolve(targetPath);
  try {
    return { kind: "canonical", path: realpathSync(lexicalPath) };
  } catch (error: unknown) {
    if (errorCode(error) === "ELOOP") {
      return {
        kind: "symlink-error",
        path: lexicalPath,
        reason: "symlink cycle",
      };
    }
    const reason = symlinkFailure(lexicalPath);
    return reason === undefined
      ? { kind: "lexical", path: lexicalPath }
      : { kind: "symlink-error", path: lexicalPath, reason };
  }
}

function symlinkFailure(
  targetPath: string,
): UnresolvablePathResolution["reason"] | undefined {
  const parsed = path.parse(targetPath);
  let currentPath = parsed.root;
  for (const segment of targetPath
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((segment) => segment.length > 0)) {
    currentPath = path.join(currentPath, segment);
    let status: import("node:fs").Stats;
    try {
      status = lstatSync(currentPath);
    } catch (error: unknown) {
      return errorCode(error) === "ELOOP" ? "symlink cycle" : undefined;
    }
    if (!status.isSymbolicLink()) continue;
    try {
      realpathSync(currentPath);
    } catch (error: unknown) {
      return errorCode(error) === "ELOOP" ? "symlink cycle" : "broken symlink";
    }
  }
  return undefined;
}

function workspacePackageForSpecifier(
  specifier: string,
  packageRoots: readonly PackageRoot[],
): PackageRoot | undefined {
  return packageRoots
    .toSorted((left, right) => right.name.length - left.name.length)
    .find(
      (entry) =>
        specifier === entry.name || specifier.startsWith(`${entry.name}/`),
    );
}

function deduplicateResolutions(
  resolutions: readonly ModuleResolution[],
): ModuleResolution[] {
  const unique = new Map<string, ModuleResolution>();
  for (const resolution of resolutions) {
    const key =
      resolution.kind === "bare"
        ? `bare:${resolution.specifier}`
        : resolution.kind === "workspace"
          ? `workspace:${resolution.access}:${resolution.target.name}`
          : resolution.kind === "unresolvable-path"
            ? `unresolvable-path:${resolution.reason}:${resolution.path}`
            : `alias-cycle:${resolution.specifier}`;
    unique.set(key, resolution);
  }
  return [...unique.values()];
}

async function sourceFiles(directory: string): Promise<readonly string[]> {
  try {
    return (
      await Promise.all(
        (
          await readdir(directory, { withFileTypes: true })
        ).map(async (entry) => {
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (ignoredSourceDirectoryNames.has(entry.name)) return [];
            return await sourceFiles(entryPath);
          }
          return /\.(?:[cm]?[jt]sx?|vue)$/u.test(entry.name) ? [entryPath] : [];
        }),
      )
    ).flat();
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

const ignoredSourceDirectoryNames = new Set([
  ".git",
  ".turbo",
  ".vite",
  ".vite-temp",
  "dist",
  "node_modules",
  "test",
  "test-results",
]);

function moduleSpecifiers(source: string): readonly string[] {
  return [
    ...source.matchAll(
      /(?:from\s*|import\s*\(|import\s*|require\s*\()["']([^"']+)["']/gu,
    ),
  ]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}
