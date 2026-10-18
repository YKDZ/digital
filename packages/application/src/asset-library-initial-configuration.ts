import type { ObservedRootSymlinkMode } from "./observed-root-registrations.ts";

/** 初始资产库的一个目录及其库内链接访问策略。 */
export type InitialAssetLibraryDirectory = {
  readonly path: string;
  readonly symlinkMode: ObservedRootSymlinkMode;
  readonly targetDirectories: readonly string[];
};

/** 显式保存的一个资产库配置，不包含来源授权或连接凭据。 */
export type InitialAssetLibrary = {
  readonly displayName: string;
  readonly directories: readonly InitialAssetLibraryDirectory[];
  readonly recognitionProfileIds: readonly string[];
  readonly sourceIdentities: readonly string[];
};

/** 环境数据世代之外保留的一份资产库基线。 */
export type AssetLibraryInitialConfiguration = {
  readonly version: 1;
  /** 最近一次成功应用基线的托管数据世代；显式保存时更新为当前世代。 */
  readonly appliedDataGeneration: string | null;
  readonly libraries: readonly InitialAssetLibrary[];
};

/** 新数据世代恢复期间未能配置的目录；状态不代表运行服务未就绪。 */
export type InitialAssetLibraryConfigurationRestoreStatus = {
  readonly status: "not-saved" | "not-managed" | "applied" | "pending";
  readonly libraryCount: number;
  readonly pendingDirectories: readonly {
    readonly libraryName: string;
    readonly path: string;
  }[];
};

/** 由产品数据基础设施实现的初始资产库配置存储端口。 */
export interface AssetLibraryInitialConfigurationPersistence {
  read(): Promise<AssetLibraryInitialConfiguration | undefined>;
  write(configuration: AssetLibraryInitialConfiguration): Promise<void>;
}
