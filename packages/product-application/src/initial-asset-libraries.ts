import { InvalidObservedRootDirectory } from "@digital/application";
import type {
  AssetLibraryInitialConfigurationPersistence,
  AssetLibraries,
  InitialAssetLibrary,
  InitialAssetLibraryConfigurationRestoreStatus,
} from "@digital/application";

/** 把用户明确保存的资产库配置与当前数据世代恢复分开管理。 */
export class InitialAssetLibraries {
  readonly #assetLibraries: AssetLibraries;
  readonly #persistence: AssetLibraryInitialConfigurationPersistence;
  readonly #dataGeneration: string | undefined;
  #lastRestoreStatus: InitialAssetLibraryConfigurationRestoreStatus | undefined;

  constructor(input: {
    readonly assetLibraries: AssetLibraries;
    readonly persistence: AssetLibraryInitialConfigurationPersistence;
    readonly dataGeneration?: string;
  }) {
    this.#assetLibraries = input.assetLibraries;
    this.#persistence = input.persistence;
    this.#dataGeneration = input.dataGeneration;
  }

  /** 显式更新初始配置；来源授权由独立私密存储持有，不进入此快照。 */
  async save(): Promise<{ readonly libraryCount: number }> {
    const libraries = await this.#snapshot();
    await this.#persistence.write({
      version: 1,
      appliedDataGeneration: this.#dataGeneration ?? null,
      libraries,
    });
    this.#lastRestoreStatus = {
      status: this.#dataGeneration === undefined ? "not-managed" : "applied",
      libraryCount: libraries.length,
      pendingDirectories: [],
    };
    return { libraryCount: libraries.length };
  }

  /** 报告最近数据世代的恢复情况，不将局部目录故障升级成服务就绪失败。 */
  async inspectRestoreStatus(): Promise<InitialAssetLibraryConfigurationRestoreStatus> {
    const configuration = await this.#persistence.read();
    if (configuration === undefined)
      return this.#remember({
        status: "not-saved",
        libraryCount: 0,
        pendingDirectories: [],
      });
    if (this.#dataGeneration === undefined)
      return this.#remember({
        status: "not-managed",
        libraryCount: configuration.libraries.length,
        pendingDirectories: [],
      });
    if (configuration.appliedDataGeneration === this.#dataGeneration)
      return this.#remember({
        status: "applied",
        libraryCount: configuration.libraries.length,
        pendingDirectories: [],
      });
    return (
      this.#lastRestoreStatus ??
      this.#remember({
        status: "pending",
        libraryCount: configuration.libraries.length,
        pendingDirectories: configuration.libraries.flatMap((library) =>
          library.directories.map(({ path }) => ({
            libraryName: library.displayName,
            path,
          })),
        ),
      })
    );
  }

  /** 新数据世代启动或显式重试时，经资产库正式业务用例恢复已保存配置。 */
  async restoreForDataGeneration(): Promise<InitialAssetLibraryConfigurationRestoreStatus> {
    const generation = this.#dataGeneration;
    const configuration = await this.#persistence.read();
    if (configuration === undefined)
      return this.#remember({
        status: "not-saved",
        libraryCount: 0,
        pendingDirectories: [],
      });
    if (generation === undefined)
      return this.#remember({
        status: "not-managed",
        libraryCount: configuration.libraries.length,
        pendingDirectories: [],
      });
    if (configuration.appliedDataGeneration === generation)
      return this.#remember({
        status: "applied",
        libraryCount: configuration.libraries.length,
        pendingDirectories: [],
      });

    const restored = new Set<string>();
    const pendingDirectories: {
      readonly libraryName: string;
      readonly path: string;
    }[] = [];
    for (const library of configuration.libraries) {
      const current = await this.#assetLibraries.list();
      const matches: {
        readonly candidate: (typeof current)[number];
        readonly paths: readonly string[];
      }[] = [];
      for (const candidate of current) {
        if (restored.has(candidate.id)) continue;
        const paths = await this.#matchingDirectoryPaths(
          candidate.id,
          candidate,
          library,
        );
        if (paths !== undefined) matches.push({ candidate, paths });
      }
      const matching = matches.toSorted(
        (left, right) => right.paths.length - left.paths.length,
      )[0];
      if (
        matching !== undefined &&
        matching.paths.length === library.directories.length
      ) {
        restored.add(matching.candidate.id);
        continue;
      }

      let currentLibrary = matching?.candidate;
      const configuredPaths = [...(matching?.paths ?? [])];
      for (const directory of library.directories) {
        if (configuredPaths.includes(directory.path)) continue;
        const nextPaths = [...configuredPaths, directory.path];
        const selected = new Set(nextPaths);
        const selectedDirectories = library.directories.filter(({ path }) =>
          selected.has(path),
        );
        try {
          currentLibrary = await this.#assetLibraries.save({
            ...(currentLibrary === undefined
              ? {}
              : {
                  id: currentLibrary.id,
                  expectedVersion: currentLibrary.configVersion,
                }),
            displayName: library.displayName,
            directories: selectedDirectories.map(({ path }) => path),
            directoryLinks: selectedDirectories.map((selectedDirectory) => ({
              directory: selectedDirectory.path,
              symlinkMode: selectedDirectory.symlinkMode,
              targetDirectories: selectedDirectory.targetDirectories.filter(
                (target) => selected.has(target),
              ),
            })),
            recognitionProfileIds: library.recognitionProfileIds,
            sourceIdentities: library.sourceIdentities,
          });
          configuredPaths.push(directory.path);
        } catch (error) {
          if (!(error instanceof InvalidObservedRootDirectory)) throw error;
          pendingDirectories.push({
            libraryName: library.displayName,
            path: directory.path,
          });
        }
      }
      if (currentLibrary !== undefined) restored.add(currentLibrary.id);
    }
    if (pendingDirectories.length === 0) {
      await this.#persistence.write({
        ...configuration,
        appliedDataGeneration: generation,
      });
      return this.#remember({
        status: "applied",
        libraryCount: configuration.libraries.length,
        pendingDirectories: [],
      });
    }
    return this.#remember({
      status: "pending",
      libraryCount: configuration.libraries.length,
      pendingDirectories,
    });
  }

  #remember(
    status: InitialAssetLibraryConfigurationRestoreStatus,
  ): InitialAssetLibraryConfigurationRestoreStatus {
    this.#lastRestoreStatus = status;
    return status;
  }

  async #snapshot(): Promise<readonly InitialAssetLibrary[]> {
    const libraries = await this.#assetLibraries.list();
    return await Promise.all(
      libraries.map(async (library) => {
        const states = await this.#assetLibraries.directoryViews(library.id);
        const declared = library.rootIds.map((rootId) => {
          const state = states.find(
            (candidate) => candidate.observedRootId === rootId,
          );
          if (state === undefined)
            throw new Error("资产库目录不完整，不能保存初始配置");
          return state;
        });
        const directoryById = new Map(
          states.map((state) => [state.directoryId, state]),
        );
        return {
          displayName: library.displayName,
          directories: declared.map((directory) => ({
            path: directory.containerPath,
            symlinkMode: directory.symlinkMode,
            targetDirectories: directory.allowedTargetDirectoryIds.flatMap(
              (targetId) => {
                const target = directoryById.get(targetId);
                return target === undefined ? [] : [target.containerPath];
              },
            ),
          })),
          recognitionProfileIds: [...library.recognitionProfileIds],
          sourceIdentities: [...library.sourceIdentities],
        };
      }),
    );
  }

  async #matchingDirectoryPaths(
    id: string,
    current: Awaited<ReturnType<AssetLibraries["list"]>>[number],
    initial: InitialAssetLibrary,
  ): Promise<readonly string[] | undefined> {
    if (
      current.displayName !== initial.displayName ||
      !sameStrings(
        current.recognitionProfileIds,
        initial.recognitionProfileIds,
      ) ||
      !sameStrings(current.sourceIdentities, initial.sourceIdentities) ||
      current.rootIds.length > initial.directories.length
    )
      return undefined;
    const views = await this.#assetLibraries.directoryViews(id);
    const activeDirectories = views.filter(({ status }) => status === "active");
    if (
      views.length !== activeDirectories.length ||
      activeDirectories.length !== current.rootIds.length ||
      activeDirectories.length === 0
    )
      return undefined;
    const initialByPath = new Map(
      initial.directories.map((directory) => [directory.path, directory]),
    );
    const activePaths = activeDirectories.map(
      ({ containerPath }) => containerPath,
    );
    const activePathSet = new Set(activePaths);
    return activeDirectories.every((currentDirectory) => {
      const initialDirectory = initialByPath.get(
        currentDirectory.containerPath,
      );
      if (
        initialDirectory === undefined ||
        currentDirectory.symlinkMode !== initialDirectory.symlinkMode
      )
        return false;
      const targetDirectories = currentDirectory.allowedTargetDirectoryIds
        .map(
          (targetId) =>
            views.find((candidate) => candidate.directoryId === targetId)
              ?.containerPath,
        )
        .filter((value): value is string => value !== undefined);
      return sameStrings(
        targetDirectories,
        initialDirectory.targetDirectories.filter((target) =>
          activePathSet.has(target),
        ),
      );
    })
      ? activePaths
      : undefined;
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    [...left]
      .toSorted()
      .every((value, index) => value === [...right].toSorted()[index])
  );
}
