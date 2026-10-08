import { randomUUID } from "node:crypto";

import type {
  FrozenDirectoryAuthorization,
  LibraryDirectoryGrant,
  LibraryDirectoryInvalidation,
} from "./library-directory-grants.ts";
import { projectLibraryDirectoryAuthority } from "./library-directory-grants.ts";
import type { LibraryScanDirectoryCandidate } from "./library-scan-plan.ts";
import {
  createObservedRootAuthorityIndex,
  freezeObservedRootSnapshot,
  resolveObservedRootAuthority,
} from "./observed-root-authority.ts";
import type {
  ObservedRootDirectoryCandidate,
  ObservedRootRegistration,
  ObservedRootRegistrations,
  ObservedRootSnapshot,
  ObservedRootSymlinkMode,
} from "./observed-root-registrations.ts";

/** 识别能力的产品组合；名称和具体来源语义由组合方提供。 */
export type AssetLibraryRecognitionProfile = {
  readonly id: string;
  readonly displayName: string;
  readonly directoryInterpreterIds: readonly string[];
  readonly recognizerIds: readonly string[];
};

export type AssetLibrary = {
  readonly id: string;
  readonly displayName: string;
  readonly configVersion: number;
  readonly status: "active" | "removed";
  readonly rootIds: readonly string[];
  readonly recognitionProfileIds: readonly string[];
  readonly sourceIdentities: readonly string[];
};

/**
 * 操作开始时冻结的一条能力坐标：接缝 ID、实现版本与契约版本共同决定它能否参与本次工作。
 * 只冻结 ID 会让同一 ID 的新实现在后续部署里静默接管旧配置。
 */
export type AssetLibraryCapability = {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly contractVersion: string;
};

/** 该坐标的稳定比较拼写；解码、指纹与 scoped 过滤都只按完整坐标匹配。 */
export function assetLibraryCapabilityToken(
  capability: AssetLibraryCapability,
): string {
  return `${capability.capabilityId}@${capability.capabilityVersion}/${capability.contractVersion}`;
}

/**
 * 某个已选来源在本次发现内被允许使用的精确能力坐标。列表可以为空：已选但没有部署相应
 * 能力的来源仍然只是不产生任何外部工作，不借全局能力补齐。
 */
export type AssetLibrarySnapshotSource = {
  readonly identity: string;
  readonly collectors: readonly AssetLibraryCapability[];
  readonly sourceCandidateInterpreters: readonly AssetLibraryCapability[];
  readonly sourceInterpreters: readonly AssetLibraryCapability[];
  readonly sourceAssociationInterpreters: readonly AssetLibraryCapability[];
  readonly acquirers: readonly AssetLibraryCapability[];
  readonly informationFulfillments: readonly AssetLibraryCapability[];
};

/**
 * 一次发现冻结的配置；不携带来源凭据，不参与领域身份。每个能力接缝只从这份快照读取
 * 自己的范围，因此子执行与恢复都会重放同一份完整配置。
 */
export type AssetLibrarySnapshot = {
  readonly id: string;
  readonly configVersion: number;
  readonly rootIds: readonly string[];
  readonly directoryInterpreters: readonly AssetLibraryCapability[];
  readonly recognizers: readonly AssetLibraryCapability[];
  readonly sources: readonly AssetLibrarySnapshotSource[];
};

/** 该来源在本次冻结配置内的能力坐标；未启用来源没有范围。 */
export function assetLibrarySnapshotSourceScope(
  snapshot: AssetLibrarySnapshot,
  sourceIdentity: string,
): AssetLibrarySnapshotSource | undefined {
  return snapshot.sources.find(({ identity }) => identity === sourceIdentity);
}

export type AssetLibrarySource = {
  readonly id: string;
  readonly displayName: string;
  readonly collectorIds: readonly string[];
  readonly sourceCandidateInterpreterIds: readonly string[];
  readonly sourceInterpreterIds: readonly string[];
  readonly sourceAssociationInterpreterIds: readonly string[];
  readonly acquirerIds: readonly string[];
  readonly informationFulfillmentIds: readonly string[];
};

/**
 * 一条库目录的友好状态：本库授权决定它的链接策略、目标与是否仍可观察。removed 关系
 * 如实保留，交付层据此给出“待重新连接”，绝不把它渲染成文件被删除。
 */
export type AssetLibraryDirectoryState = {
  readonly directoryId: string;
  /** 该授权所附着的物理观察根，自动化计划据此引用；交付层不作为文本展示。 */
  readonly observedRootId: string;
  readonly displayName: string;
  readonly containerPath: string;
  readonly status: "active" | "removed";
  readonly reachable: boolean;
  readonly problem?: string;
  readonly symlinkMode: ObservedRootSymlinkMode;
  readonly allowedTargetDirectoryIds: readonly string[];
  readonly authorityVersion: number;
};

/** 本库目录的链接策略意图；目标只引用本次所选目录，绝不借用其他库的位置。 */
export type AssetLibraryDirectoryLink = {
  readonly directory: string;
  readonly symlinkMode: ObservedRootSymlinkMode;
  readonly targetDirectories: readonly string[];
};

/** 保存事务解析后交给持久化的一条目录意图：路径事实加本库链接配置。 */
export type AssetLibrarySaveDirectory = {
  readonly displayName: string;
  readonly containerPath: string;
  readonly canonicalPath: string;
  readonly symlinkMode: ObservedRootSymlinkMode;
  /** 同一集合内的目录规范身份，由持久化在同一事务内解析为本库授权 ID。 */
  readonly allowedTargetCanonicalPaths: readonly string[];
};

/**
 * 一次库配置事务的结果：配置行与需要送达执行服务的精确失效库目录坐标。坐标只在事务
 * 提交成功后使用，因此崩溃不会留下“已通知但未生效”或“已生效但未通知”的伪状态。
 */
export type AssetLibrarySaveReceipt = {
  readonly library: AssetLibrary;
  readonly invalidations: readonly LibraryDirectoryInvalidation[];
};

/**
 * 一次保存的完整意图；目录引用由持久化在同一事务内解析为观察根，库目录授权在同一事务内
 * 建立、保留或撤销。
 */
export type AssetLibrarySave = {
  readonly id: string;
  readonly displayName: string;
  readonly configVersion: number;
  readonly status: AssetLibrary["status"];
  readonly expectedVersion?: number;
  readonly recognitionProfileIds: readonly string[];
  readonly sourceIdentities: readonly string[];
  readonly directories?: readonly AssetLibrarySaveDirectory[];
};

/** 点名一条保留的库目录授权并携带其权威版本，作为重连的因果前置。 */
export type AssetLibraryDirectoryReconnect = {
  readonly libraryId: string;
  readonly expectedConfigVersion: number;
  readonly directoryId: string;
  readonly expectedAuthorityVersion: number;
  /**
   * 当该目录的物理根已被末引用撤销时，重连必须在同一事务里把根从 revoked 原子恢复为 active；
   * 携带根编号与其当前配置版本做 CAS。省略时（根仍被其他库持有）不动 registration 行。
   */
  readonly reactivateRegistration?: {
    readonly observedRootId: string;
    readonly expectedVersion: number;
  };
};

export type AssetLibraryPersistence = {
  listAssetLibraries(): Promise<readonly AssetLibrary[]>;
  getAssetLibrary(id: string): Promise<AssetLibrary | undefined>;
  /**
   * 同一事务比较配置版本、复用或登记目录引用、维护本库目录授权并保存完整配置。配置版本
   * 冲突或写入失败时整笔回滚并返回 undefined，此时既不产生库也不留下可授予访问的观察根
   * 注册。遇本库保留的 removed 目录按同路径自动复活会被整笔拒绝，改由显式重连接管。
   */
  saveAssetLibrary(
    save: AssetLibrarySave,
  ): Promise<AssetLibrarySaveReceipt | undefined>;
  /**
   * 显式重连：点名 retained 授权并对其权威版本做 CAS，同时在同一事务内把目录附回库配置。
   * 冲突返回 undefined，授权保持 removed。
   */
  reconnectAssetLibraryDirectory(
    input: AssetLibraryDirectoryReconnect,
  ): Promise<AssetLibrarySaveReceipt | undefined>;
};

export type AssetLibraryConfiguration = {
  readonly displayName: string;
  readonly directories: readonly string[];
  readonly directoryLinks?: readonly AssetLibraryDirectoryLink[];
  readonly recognitionProfileIds: readonly string[];
  readonly sourceIdentities: readonly string[];
};

/**
 * 组合根在启动时提供的已部署能力坐标，按接缝分组。快照只冻结这里真实存在的坐标，因此
 * 配置意图里的裸 ID 不会在运行期被同 ID 的后续实现静默替换。
 */
export type AssetLibraryDeployedCapabilities = {
  readonly directoryInterpreters: readonly AssetLibraryCapability[];
  readonly recognizers: readonly AssetLibraryCapability[];
  readonly collectors: readonly AssetLibraryCapability[];
  readonly sourceCandidateInterpreters: readonly AssetLibraryCapability[];
  readonly sourceInterpreters: readonly AssetLibraryCapability[];
  readonly sourceAssociationInterpreters: readonly AssetLibraryCapability[];
  readonly acquirers: readonly AssetLibraryCapability[];
  readonly informationFulfillments: readonly AssetLibraryCapability[];
};

type CapabilitySeam = keyof AssetLibraryDeployedCapabilities;

const CAPABILITY_SEAM_LABELS: Record<CapabilitySeam, string> = {
  directoryInterpreters: "目录解释能力",
  recognizers: "识别能力",
  collectors: "采集能力",
  sourceCandidateInterpreters: "来源候选解释能力",
  sourceInterpreters: "资料解释能力",
  sourceAssociationInterpreters: "关联解释能力",
  acquirers: "产物获取能力",
  informationFulfillments: "信息履行能力",
};

type CapabilityCatalogue = {
  readonly [Seam in CapabilitySeam]: ReadonlyMap<
    string,
    AssetLibraryCapability
  >;
};

/**
 * 冻结只保留稳定坐标三字段：快照必须能原样往返耐久输入，部署对象附带的身份、种类、
 * 解释契约清单等描述字段既不参与匹配，也不能进入被严格校验的持久化形状。
 */
function freezeCapabilityCoordinate(
  capability: AssetLibraryCapability,
): AssetLibraryCapability {
  return {
    capabilityId: capability.capabilityId,
    capabilityVersion: capability.capabilityVersion,
    contractVersion: capability.contractVersion,
  };
}

/**
 * 同一接缝里同一 ID 出现两个版本意味着部署冲突：任选一个都会让快照冻结的坐标和真正
 * 参与工作的坐标不一致，因此启动即拒绝。
 */
function indexDeployedCapabilities(
  seam: CapabilitySeam,
  deployed: readonly AssetLibraryCapability[],
): ReadonlyMap<string, AssetLibraryCapability> {
  const index = new Map<string, AssetLibraryCapability>();
  for (const capability of deployed) {
    if (index.has(capability.capabilityId))
      throw new Error(
        `${CAPABILITY_SEAM_LABELS[seam]}存在多条同 ID 但版本不同的已部署能力`,
      );
    index.set(capability.capabilityId, freezeCapabilityCoordinate(capability));
  }
  return index;
}

function capabilityCatalogue(
  deployed: AssetLibraryDeployedCapabilities,
): CapabilityCatalogue {
  return {
    directoryInterpreters: indexDeployedCapabilities(
      "directoryInterpreters",
      deployed.directoryInterpreters,
    ),
    recognizers: indexDeployedCapabilities("recognizers", deployed.recognizers),
    collectors: indexDeployedCapabilities("collectors", deployed.collectors),
    sourceCandidateInterpreters: indexDeployedCapabilities(
      "sourceCandidateInterpreters",
      deployed.sourceCandidateInterpreters,
    ),
    sourceInterpreters: indexDeployedCapabilities(
      "sourceInterpreters",
      deployed.sourceInterpreters,
    ),
    sourceAssociationInterpreters: indexDeployedCapabilities(
      "sourceAssociationInterpreters",
      deployed.sourceAssociationInterpreters,
    ),
    acquirers: indexDeployedCapabilities("acquirers", deployed.acquirers),
    informationFulfillments: indexDeployedCapabilities(
      "informationFulfillments",
      deployed.informationFulfillments,
    ),
  };
}

function byCapabilityToken(
  left: AssetLibraryCapability,
  right: AssetLibraryCapability,
): number {
  return assetLibraryCapabilityToken(left).localeCompare(
    assetLibraryCapabilityToken(right),
  );
}

/** 配置意图里的裸 ID 只在启动时解析为部署坐标；未被部署的选项从可选意图里拒绝。 */
function freezeCapabilitySelection(
  seam: CapabilitySeam,
  index: ReadonlyMap<string, AssetLibraryCapability>,
  owner: string,
  ids: readonly string[],
): readonly AssetLibraryCapability[] {
  const selected = new Set(
    checkedSelection(
      ids,
      [...index.keys()],
      `${owner}的${CAPABILITY_SEAM_LABELS[seam]}`,
    ),
  );
  return [...index.values()]
    .filter((capability) => selected.has(capability.capabilityId))
    .toSorted(byCapabilityToken);
}

type FrozenRecognitionProfile = {
  readonly directoryInterpreters: readonly AssetLibraryCapability[];
  readonly recognizers: readonly AssetLibraryCapability[];
};

export class AssetLibraries {
  private readonly persistence: AssetLibraryPersistence;
  private readonly roots: ObservedRootRegistrations;
  readonly recognitionProfiles: readonly AssetLibraryRecognitionProfile[];
  readonly sources: readonly AssetLibrarySource[];
  private readonly frozenProfiles: ReadonlyMap<
    string,
    FrozenRecognitionProfile
  >;
  private readonly frozenSources: ReadonlyMap<
    string,
    AssetLibrarySnapshotSource
  >;

  constructor(input: {
    readonly persistence: AssetLibraryPersistence;
    readonly roots: ObservedRootRegistrations;
    readonly recognitionProfiles: readonly AssetLibraryRecognitionProfile[];
    readonly sources: readonly AssetLibrarySource[];
    readonly capabilities: AssetLibraryDeployedCapabilities;
  }) {
    this.persistence = input.persistence;
    this.roots = input.roots;
    this.recognitionProfiles = input.recognitionProfiles;
    this.sources = input.sources;
    const catalogue = capabilityCatalogue(input.capabilities);
    const frozenProfiles = new Map<string, FrozenRecognitionProfile>();
    for (const profile of input.recognitionProfiles) {
      const owner = `资产识别方式「${profile.displayName}」`;
      frozenProfiles.set(profile.id, {
        directoryInterpreters: freezeCapabilitySelection(
          "directoryInterpreters",
          catalogue.directoryInterpreters,
          owner,
          profile.directoryInterpreterIds,
        ),
        recognizers: freezeCapabilitySelection(
          "recognizers",
          catalogue.recognizers,
          owner,
          profile.recognizerIds,
        ),
      });
    }
    this.frozenProfiles = frozenProfiles;
    const frozenSources = new Map<string, AssetLibrarySnapshotSource>();
    for (const source of input.sources) {
      const owner = `资料来源「${source.displayName}」`;
      frozenSources.set(source.id, {
        identity: source.id,
        collectors: freezeCapabilitySelection(
          "collectors",
          catalogue.collectors,
          owner,
          source.collectorIds,
        ),
        sourceCandidateInterpreters: freezeCapabilitySelection(
          "sourceCandidateInterpreters",
          catalogue.sourceCandidateInterpreters,
          owner,
          source.sourceCandidateInterpreterIds,
        ),
        sourceInterpreters: freezeCapabilitySelection(
          "sourceInterpreters",
          catalogue.sourceInterpreters,
          owner,
          source.sourceInterpreterIds,
        ),
        sourceAssociationInterpreters: freezeCapabilitySelection(
          "sourceAssociationInterpreters",
          catalogue.sourceAssociationInterpreters,
          owner,
          source.sourceAssociationInterpreterIds,
        ),
        acquirers: freezeCapabilitySelection(
          "acquirers",
          catalogue.acquirers,
          owner,
          source.acquirerIds,
        ),
        informationFulfillments: freezeCapabilitySelection(
          "informationFulfillments",
          catalogue.informationFulfillments,
          owner,
          source.informationFulfillmentIds,
        ),
      });
    }
    this.frozenSources = frozenSources;
  }

  async list(): Promise<readonly AssetLibrary[]> {
    return (await this.persistence.listAssetLibraries()).filter(
      (library) => library.status === "active",
    );
  }

  async get(id: string): Promise<AssetLibrary | undefined> {
    const library = await this.persistence.getAssetLibrary(id);
    return library?.status === "active" ? library : undefined;
  }

  async save(
    input: AssetLibraryConfiguration & {
      readonly id?: string;
      readonly expectedVersion?: number;
    },
  ): Promise<AssetLibrary> {
    const displayName = input.displayName.trim();
    if (displayName.length === 0 || displayName.length > 120)
      throw new Error("资产库名称必须为 1 至 120 个字符");
    const recognitionProfileIds = checkedSelection(
      input.recognitionProfileIds,
      this.recognitionProfiles.map((profile) => profile.id),
      "资产识别方式",
    );
    const sourceIdentities = checkedSelection(
      input.sourceIdentities,
      this.sources.map((source) => source.id),
      "资料来源",
    );
    if (recognitionProfileIds.length === 0)
      throw new Error("请选择至少一种资产识别方式");
    const directories = [
      ...new Set(input.directories.map((value) => value.trim())),
    ];
    if (
      directories.length === 0 ||
      directories.some((value) => value.length === 0)
    )
      throw new Error("请选择至少一个实际资产目录");
    const current =
      input.id === undefined ? undefined : await this.get(input.id);
    if (
      input.id !== undefined &&
      (current === undefined || current.configVersion !== input.expectedVersion)
    )
      throw new Error("资产库配置已变更，请刷新后重试");
    const candidateByRequestPath = new Map<
      string,
      ObservedRootDirectoryCandidate
    >();
    const candidatesByCanonicalPath = new Map<
      string,
      ObservedRootDirectoryCandidate
    >();
    for (const directory of directories) {
      const candidate = await this.roots.libraryRootCandidate({
        displayName,
        containerPath: directory,
      });
      candidateByRequestPath.set(directory, candidate);
      // 同一请求里指向同一实际目录的不同路径写法只登记一次引用。
      if (!candidatesByCanonicalPath.has(candidate.canonicalPath))
        candidatesByCanonicalPath.set(candidate.canonicalPath, candidate);
    }
    const saveDirectories = await this.resolveDirectoryIntents(
      input,
      candidateByRequestPath,
      candidatesByCanonicalPath,
      current?.id,
    );
    const receipt = await this.persistence.saveAssetLibrary({
      id: current?.id ?? `asset_library_${randomUUID()}`,
      displayName,
      configVersion: (current?.configVersion ?? 0) + 1,
      status: "active",
      ...(current === undefined
        ? {}
        : { expectedVersion: current.configVersion }),
      recognitionProfileIds,
      sourceIdentities,
      directories: saveDirectories,
    });
    if (receipt === undefined)
      throw new Error("资产库或目录配置已变更，请刷新后重试");
    this.notifyDirectoryInvalidations(receipt.invalidations);
    await this.releaseUnusedRoots(current?.rootIds ?? []);
    return receipt.library;
  }

  /**
   * 把用户给出的链接意图解析成同一集合内的目录规范身份：目标必须出现在本次所选目录里，
   * 因此一个库永远不能借另一个库的位置取得目标资格。未被点名的目录延续本库现有授权的
   * 策略与目标（只保留仍在集合内的目标），普通配置编辑不会静默重置访问授权。
   */
  private async resolveDirectoryIntents(
    input: AssetLibraryConfiguration,
    candidateByRequestPath: ReadonlyMap<string, ObservedRootDirectoryCandidate>,
    candidatesByCanonicalPath: ReadonlyMap<
      string,
      ObservedRootDirectoryCandidate
    >,
    libraryId: string | undefined,
  ): Promise<readonly AssetLibrarySaveDirectory[]> {
    // 新建库没有既有授权；已存在的库只读取自己账本，绝不借其他库的授权延续。
    const grants =
      libraryId === undefined
        ? []
        : await this.roots.libraryDirectoryGrants(libraryId);
    const registrations = new Map(
      (await this.roots.list()).map((registration) => [
        registration.id,
        registration,
      ]),
    );
    const grantById = new Map(grants.map((grant) => [grant.id, grant]));
    const retainedByCanonicalPath = new Map<string, LibraryDirectoryGrant>();
    for (const grant of grants) {
      const registration = registrations.get(grant.observedRootId);
      if (registration !== undefined && grant.status === "active")
        retainedByCanonicalPath.set(registration.canonicalPath, grant);
    }
    const links = input.directoryLinks ?? [];
    const intents: AssetLibrarySaveDirectory[] = [];
    for (const candidate of candidatesByCanonicalPath.values()) {
      const link = links.find(
        (entry) =>
          candidateByRequestPath.get(entry.directory.trim())?.canonicalPath ===
          candidate.canonicalPath,
      );
      if (link !== undefined)
        for (const target of link.targetDirectories)
          if (candidateByRequestPath.get(target.trim()) === undefined)
            throw new Error("允许的链接目标必须是本资产库所选的目录");
      const retained = retainedByCanonicalPath.get(candidate.canonicalPath);
      const symlinkMode =
        link?.symlinkMode ?? retained?.symlinkMode ?? "do-not-follow";
      const targets =
        link === undefined
          ? (retained?.allowedTargetGrantIds ?? [])
              .map((grantId) =>
                this.targetCanonicalPath(
                  grantById.get(grantId),
                  registrations,
                  candidatesByCanonicalPath,
                ),
              )
              .filter((value): value is string => value !== undefined)
          : link.targetDirectories
              .map(
                (target) =>
                  candidateByRequestPath.get(target.trim())?.canonicalPath,
              )
              .filter(
                (value): value is string =>
                  value !== undefined && value !== candidate.canonicalPath,
              );
      intents.push({
        displayName: candidate.displayName,
        containerPath: candidate.containerPath,
        canonicalPath: candidate.canonicalPath,
        symlinkMode,
        allowedTargetCanonicalPaths: [...new Set(targets)].toSorted(),
      });
    }
    return intents;
  }

  /** 目标只有仍是本库活动授权且仍被本次集合选择时才延续，否则随目录移除一起失效。 */
  private targetCanonicalPath(
    grant: LibraryDirectoryGrant | undefined,
    registrations: ReadonlyMap<string, ObservedRootRegistration>,
    candidatesByCanonicalPath: ReadonlyMap<
      string,
      ObservedRootDirectoryCandidate
    >,
  ): string | undefined {
    if (grant === undefined || grant.status !== "active") return undefined;
    const registration = registrations.get(grant.observedRootId);
    if (registration === undefined) return undefined;
    return candidatesByCanonicalPath.has(registration.canonicalPath)
      ? registration.canonicalPath
      : undefined;
  }

  /**
   * 整库移除：同一事务里本库全部活动授权标 removed 并推进权威版本，自身计划停用；共享
   * 物理根只在最后引用被撤销时才失去根权威，因此另一个库的目录与运行不受影响。
   */
  async remove(input: {
    readonly id: string;
    readonly expectedVersion: number;
  }): Promise<void> {
    const current = await this.get(input.id);
    if (
      current === undefined ||
      current.configVersion !== input.expectedVersion
    )
      throw new Error("资产库配置已变更，请刷新后重试");
    const receipt = await this.persistence.saveAssetLibrary({
      id: current.id,
      displayName: current.displayName,
      configVersion: current.configVersion + 1,
      status: "removed",
      expectedVersion: current.configVersion,
      recognitionProfileIds: current.recognitionProfileIds,
      sourceIdentities: current.sourceIdentities,
    });
    if (receipt === undefined)
      throw new Error("资产库配置已变更，请刷新后重试");
    this.notifyDirectoryInvalidations(receipt.invalidations);
    await this.releaseUnusedRoots(current.rootIds);
  }

  /**
   * 显式重连一条保留的库目录授权：点名授权并对权威版本做 CAS，物理根仍被其他库使用时
   * 直接附接，最后引用已撤销时沿既有根重连（旧根身份加当前只读 canonical 校验）。这里
   * 不制造缺失快照，也不恢复历史 current 位置；只有新的完整授权观察才重新确认文件。
   */
  async reconnect(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly directoryId: string;
    readonly expectedAuthorityVersion: number;
  }): Promise<AssetLibrary> {
    const current = await this.get(input.id);
    if (
      current === undefined ||
      current.configVersion !== input.expectedVersion
    )
      throw new Error("资产库配置已变更，请刷新后重试");
    const grants = await this.roots.libraryDirectoryGrants(current.id);
    const grant = grants.find(
      (candidate) => candidate.id === input.directoryId,
    );
    if (grant === undefined || grant.libraryId !== current.id)
      throw new Error("该目录不属于此资产库，请选择要重新连接的目录");
    if (grant.status !== "removed")
      throw new Error("该目录仍在资产库中，无需重新连接");
    if (grant.authorityVersion !== input.expectedAuthorityVersion)
      throw new Error("该目录的授权已变更，请刷新后重试");
    const registration = await this.roots.get(grant.observedRootId);
    if (registration === undefined)
      throw new Error("该目录的位置记录已不存在，请重新选择目录");
    // 末引用撤销的物理根：只读校验目录仍可访问，真正的 revoked→active 翻转交给下面的事务，
    // 与 grant 激活、库引用附接同笔提交，任何一步 CAS 失败都整笔回滚，保持 removed/revoked。
    const reactivatedVersion =
      registration.status === "revoked"
        ? (await this.roots.validateReconnect(registration),
          registration.configVersion + 1)
        : undefined;
    const receipt = await this.persistence.reconnectAssetLibraryDirectory({
      libraryId: current.id,
      expectedConfigVersion: current.configVersion,
      directoryId: grant.id,
      expectedAuthorityVersion: grant.authorityVersion,
      ...(registration.status === "revoked"
        ? {
            reactivateRegistration: {
              observedRootId: registration.id,
              expectedVersion: registration.configVersion,
            },
          }
        : {}),
    });
    if (receipt === undefined)
      throw new Error("资产库或目录授权已变更，请刷新后重试");
    if (reactivatedVersion !== undefined)
      this.roots.notifyRegistrationReactivated({
        registrationId: registration.id,
        keepVersion: reactivatedVersion,
      });
    this.notifyDirectoryInvalidations(receipt.invalidations);
    return receipt.library;
  }

  /** 提交成功之后才通知，因此崩溃只会留下“未通知但已持久拒绝”，不会出现虚假通知。 */
  private notifyDirectoryInvalidations(
    invalidations: readonly LibraryDirectoryInvalidation[],
  ): void {
    for (const invalidation of invalidations)
      this.roots.notifyLibraryDirectoryInvalidation({
        assetLibraryId: invalidation.assetLibraryId,
        observedRootId: invalidation.observedRootId,
      });
  }

  async snapshot(id: string): Promise<AssetLibrarySnapshot> {
    const library = await this.get(id);
    if (library === undefined) throw new Error("资产库不存在或已移除");
    return this.buildSnapshot(library);
  }

  /** 从已读到的库配置派生冻结快照；profile 与来源解析都是内存查找。 */
  private buildSnapshot(library: AssetLibrary): AssetLibrarySnapshot {
    const directoryInterpreters = new Map<string, AssetLibraryCapability>();
    const recognizers = new Map<string, AssetLibraryCapability>();
    for (const profileId of library.recognitionProfileIds) {
      const frozen = this.frozenProfiles.get(profileId);
      if (frozen === undefined) throw new Error("资产库所选识别方式当前不可用");
      for (const capability of frozen.directoryInterpreters)
        directoryInterpreters.set(
          assetLibraryCapabilityToken(capability),
          capability,
        );
      for (const capability of frozen.recognizers)
        recognizers.set(assetLibraryCapabilityToken(capability), capability);
    }
    return {
      id: library.id,
      configVersion: library.configVersion,
      rootIds: [...library.rootIds],
      directoryInterpreters: [...directoryInterpreters.values()].toSorted(
        byCapabilityToken,
      ),
      recognizers: [...recognizers.values()].toSorted(byCapabilityToken),
      sources: library.sourceIdentities.toSorted().map((identity) => {
        const frozen = this.frozenSources.get(identity);
        if (frozen === undefined)
          throw new Error("资产库所选资料来源当前不可用");
        return frozen;
      }),
    };
  }

  async snapshotForRoot(input: {
    readonly registrationId: string;
    readonly libraryId?: string;
  }): Promise<AssetLibrarySnapshot> {
    const candidates = (await this.list()).filter(
      (library) =>
        library.rootIds.includes(input.registrationId) &&
        (input.libraryId === undefined || library.id === input.libraryId),
    );
    if (candidates.length !== 1)
      throw new Error(
        candidates.length === 0
          ? "此目录已不属于当前资产库"
          : "此目录属于多个资产库，请选择要扫描的资产库",
      );
    return await this.snapshot(candidates[0]!.id);
  }

  async isCurrent(snapshot: AssetLibrarySnapshot): Promise<boolean> {
    const current = await this.get(snapshot.id);
    return (
      current !== undefined && current.configVersion === snapshot.configVersion
    );
  }

  /**
   * 该库的友好目录清单。交付界面据此显示与操作库内目录，不再枚举全局观察根，
   * 也就不会把某个库的目录误当成可自由选择的全局根。
   */
  async directories(
    id: string,
  ): Promise<readonly { readonly id: string; readonly displayName: string }[]> {
    const library = await this.get(id);
    if (library === undefined) throw new Error("资产库不存在或已移除");
    const listed: { id: string; displayName: string }[] = [];
    for (const rootId of library.rootIds) {
      const root = await this.roots.get(rootId);
      if (root === undefined) continue;
      listed.push({ id: root.id, displayName: root.displayName });
    }
    return listed;
  }

  /**
   * 父创建时一次冻结读取：同一次配置读取同时固定完整库快照与全部配置目录的归并输入。
   * 每个可用根从其权威闭包派生冻结 snapshot（canonical 实际根 + 完整授权闭包 + 观察策略），
   * 既作为计划判断坐标，也作为后续子绑定的耐久权威；缺失、停用或闭包不可用的根不静默
   * 省略，而是各自产出一条 unavailable 候选，由扫描逐目录诚实失败。调用方拿到的是同一时刻
   * 的一致性视图，之后任何今日配置变化都不影响本次计划或子绑定。
   */
  async freezeLibraryScan(id: string): Promise<{
    readonly snapshot: AssetLibrarySnapshot;
    readonly candidates: readonly LibraryScanDirectoryCandidate[];
    readonly frozenRoots: readonly ObservedRootSnapshot[];
    /** 本库目录授权账目：实际目录工作与耐久复核都按这份版本判定，不看今日配置。 */
    readonly directoryAuthorizations: readonly FrozenDirectoryAuthorization[];
  }> {
    const library = await this.get(id);
    if (library === undefined) throw new Error("资产库不存在或已移除");
    const grants = await this.roots.libraryDirectoryGrants(library.id);
    const grantByRootId = new Map(
      grants
        .filter((grant) => grant.status === "active")
        .map((grant) => [grant.observedRootId, grant]),
    );
    const index = createObservedRootAuthorityIndex(
      projectLibraryDirectoryAuthority({
        grants,
        registrations: await this.roots.list(),
      }),
    );
    const candidates: LibraryScanDirectoryCandidate[] = [];
    const frozenRoots: ObservedRootSnapshot[] = [];
    const directoryAuthorizations: FrozenDirectoryAuthorization[] = [];
    for (const rootId of library.rootIds) {
      const grant = grantByRootId.get(rootId);
      const registration = index.registrations.get(rootId);
      if (grant === undefined || registration === undefined) {
        candidates.push({
          id: rootId,
          configVersion: library.configVersion,
          containerPath: "",
          canonicalPath: "",
          symlinkMode: "do-not-follow",
          authorizedTargetRoots: [],
          unavailable: "missing",
        });
        continue;
      }
      if (registration.status !== "active") {
        candidates.push({
          id: registration.id,
          configVersion: registration.configVersion,
          containerPath: registration.containerPath,
          canonicalPath: registration.canonicalPath,
          symlinkMode: grant.symlinkMode,
          authorizedTargetRoots: [],
          unavailable: "inactive",
        });
        continue;
      }
      const authority = resolveObservedRootAuthority(index, registration.id);
      if (authority.status !== "available") {
        candidates.push({
          id: registration.id,
          configVersion: registration.configVersion,
          containerPath: registration.containerPath,
          canonicalPath: registration.canonicalPath,
          symlinkMode: grant.symlinkMode,
          authorizedTargetRoots: [],
          unavailable: "unavailable",
        });
        continue;
      }
      const snapshot = freezeObservedRootSnapshot(authority);
      frozenRoots.push(snapshot);
      directoryAuthorizations.push({
        observedRootId: snapshot.id,
        authorityVersion: grant.authorityVersion,
      });
      candidates.push({
        id: snapshot.id,
        configVersion: snapshot.configVersion,
        containerPath: snapshot.containerPath,
        canonicalPath: snapshot.canonicalPath,
        symlinkMode: snapshot.symlinkMode,
        authorizedTargetRoots: snapshot.authorizedTargetRoots ?? [],
      });
    }
    return {
      snapshot: this.buildSnapshot(library),
      candidates,
      frozenRoots,
      directoryAuthorizations,
    };
  }

  /**
   * 该库目录的交付视图：友好名、容器拼写、本库授权状态与本次可达性。removed 授权如实
   * 出现在这里并等待显式重连，可达性由库持有的窄根能力就地探测，交付层因此不必枚举全局
   * 根清单，也不会把别的库的目录当成本库可选目录。
   */
  async directoryViews(
    id: string,
  ): Promise<readonly AssetLibraryDirectoryState[]> {
    const library = await this.get(id);
    if (library === undefined) throw new Error("资产库不存在或已移除");
    const grants = await this.roots.libraryDirectoryGrants(library.id);
    const registrations = new Map(
      (await this.roots.list()).map((registration) => [
        registration.id,
        registration,
      ]),
    );
    const activeGrants = grants.filter((grant) => grant.status === "active");
    const states: AssetLibraryDirectoryState[] = [];
    for (const grant of grants) {
      const registration = registrations.get(grant.observedRootId);
      if (registration === undefined) continue;
      const probe = await this.probeDirectory(grant, registration);
      states.push({
        directoryId: grant.id,
        observedRootId: grant.observedRootId,
        displayName: registration.displayName,
        containerPath: registration.containerPath,
        status: grant.status,
        reachable: probe.reachable,
        ...(probe.problem === undefined ? {} : { problem: probe.problem }),
        symlinkMode: grant.symlinkMode,
        allowedTargetDirectoryIds: grant.allowedTargetGrantIds.filter(
          (targetId) =>
            activeGrants.some(
              (candidate) =>
                candidate.id === targetId &&
                registrations.has(candidate.observedRootId),
            ),
        ),
        authorityVersion: grant.authorityVersion,
      });
    }
    return states;
  }

  /**
   * 就地探测一条目录授权：可达性必须由**该库**的授权解析得出，因此共享同一物理根的另一
   * 库不能替它续权，本库被移除的目录也只会被报告为待重新连接，绝不伪造缺失快照。
   */
  private async probeDirectory(
    grant: LibraryDirectoryGrant,
    registration: ObservedRootRegistration,
  ): Promise<{ readonly reachable: boolean; readonly problem?: string }> {
    if (grant.status === "removed")
      return {
        reachable: false,
        problem: "已从资产库移除，等待重新连接后才会再次观察",
      };
    if (registration.status !== "active")
      return { reachable: false, problem: "该目录的位置已停用，请重新连接" };
    try {
      const bound = await this.roots.resolveActiveScope({
        registrationId: registration.id,
        relativeScope: ".",
        assetLibraryId: grant.libraryId,
      });
      await this.roots.closeBoundScope(bound.scope);
      return { reachable: true };
    } catch (error) {
      return {
        reachable: false,
        problem:
          error instanceof Error
            ? error.message
            : "该目录当前无法访问，请稍后重试",
      };
    }
  }

  private async releaseUnusedRoots(rootIds: readonly string[]): Promise<void> {
    const retained = new Set(
      (await this.list()).flatMap((library) => library.rootIds),
    );
    for (const id of rootIds) {
      if (retained.has(id)) continue;
      const root = await this.roots.get(id);
      if (root !== undefined)
        await this.roots.deactivate({
          id,
          expectedVersion: root.configVersion,
        });
    }
  }
}

function checkedSelection(
  values: readonly string[],
  allowed: readonly string[],
  label: string,
): readonly string[] {
  if (values.some((value) => !allowed.includes(value)))
    throw new Error(`${label}包含当前不可用的选项`);
  return [...new Set(values)].toSorted();
}

const SNAPSHOT_KEYS = [
  "id",
  "configVersion",
  "rootIds",
  "directoryInterpreters",
  "recognizers",
  "sources",
] as const;

const SNAPSHOT_SOURCE_KEYS = [
  "identity",
  "collectors",
  "sourceCandidateInterpreters",
  "sourceInterpreters",
  "sourceAssociationInterpreters",
  "acquirers",
  "informationFulfillments",
] as const;

const CAPABILITY_KEYS = [
  "capabilityId",
  "capabilityVersion",
  "contractVersion",
] as const;

function isIdentityList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0) &&
    new Set(value).size === value.length
  );
}

/**
 * 一条冻结坐标只能以完整三元组回来。只带 ID 的旧输入不借当前实现补版本，而是按结构
 * 不完整处理，由既有恢复纪律给出明确终态。
 */
function decodeAssetLibraryCapability(
  value: unknown,
): AssetLibraryCapability | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== CAPABILITY_KEYS.length ||
    !CAPABILITY_KEYS.every((key) => Object.hasOwn(record, key))
  )
    return undefined;
  const { capabilityId, capabilityVersion, contractVersion } = record;
  if (
    typeof capabilityId !== "string" ||
    capabilityId.length === 0 ||
    typeof capabilityVersion !== "string" ||
    capabilityVersion.length === 0 ||
    typeof contractVersion !== "string" ||
    contractVersion.length === 0
  )
    return undefined;
  return { capabilityId, capabilityVersion, contractVersion };
}

function decodeAssetLibraryCapabilityList(
  value: unknown,
): readonly AssetLibraryCapability[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const capabilities: AssetLibraryCapability[] = [];
  for (const entry of value) {
    const capability = decodeAssetLibraryCapability(entry);
    if (capability === undefined) return undefined;
    capabilities.push(capability);
  }
  return new Set(capabilities.map(assetLibraryCapabilityToken)).size ===
    capabilities.length
    ? capabilities
    : undefined;
}

export function decodeAssetLibrarySnapshot(
  value: unknown,
): AssetLibrarySnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  const { id, configVersion, rootIds, sources } = candidate;
  const directoryInterpreters = decodeAssetLibraryCapabilityList(
    candidate.directoryInterpreters,
  );
  const recognizers = decodeAssetLibraryCapabilityList(candidate.recognizers);
  if (
    Object.keys(candidate).length !== SNAPSHOT_KEYS.length ||
    !SNAPSHOT_KEYS.every((key) => Object.hasOwn(candidate, key)) ||
    typeof id !== "string" ||
    id.length === 0 ||
    typeof configVersion !== "number" ||
    !Number.isSafeInteger(configVersion) ||
    configVersion < 1 ||
    !isIdentityList(rootIds) ||
    rootIds.length === 0 ||
    directoryInterpreters === undefined ||
    recognizers === undefined ||
    !Array.isArray(sources)
  )
    return undefined;
  const decoded: AssetLibrarySnapshotSource[] = [];
  for (const entry of sources) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return undefined;
    const source = entry as Record<string, unknown>;
    if (
      Object.keys(source).length !== SNAPSHOT_SOURCE_KEYS.length ||
      !SNAPSHOT_SOURCE_KEYS.every((key) => Object.hasOwn(source, key)) ||
      typeof source.identity !== "string" ||
      source.identity.length === 0
    )
      return undefined;
    const collectors = decodeAssetLibraryCapabilityList(source.collectors);
    const sourceCandidateInterpreters = decodeAssetLibraryCapabilityList(
      source.sourceCandidateInterpreters,
    );
    const sourceInterpreters = decodeAssetLibraryCapabilityList(
      source.sourceInterpreters,
    );
    const sourceAssociationInterpreters = decodeAssetLibraryCapabilityList(
      source.sourceAssociationInterpreters,
    );
    const acquirers = decodeAssetLibraryCapabilityList(source.acquirers);
    const informationFulfillments = decodeAssetLibraryCapabilityList(
      source.informationFulfillments,
    );
    if (
      collectors === undefined ||
      sourceCandidateInterpreters === undefined ||
      sourceInterpreters === undefined ||
      sourceAssociationInterpreters === undefined ||
      acquirers === undefined ||
      informationFulfillments === undefined
    )
      return undefined;
    decoded.push({
      identity: source.identity,
      collectors,
      sourceCandidateInterpreters,
      sourceInterpreters,
      sourceAssociationInterpreters,
      acquirers,
      informationFulfillments,
    });
  }
  if (new Set(decoded.map(({ identity }) => identity)).size !== decoded.length)
    return undefined;
  return {
    id,
    configVersion,
    rootIds: [...rootIds],
    directoryInterpreters,
    recognizers,
    sources: decoded,
  };
}

function capabilityTokens(
  capabilities: readonly AssetLibraryCapability[],
): readonly string[] {
  return capabilities.map(assetLibraryCapabilityToken).toSorted();
}

/**
 * 稳定的冻结值指纹。组合根用它区分同一库的不同配置快照，而不必把内部坐标暴露给调用方。
 * 坐标版本参与指纹，因此同接缝同 ID 但实现或契约版本不同的配置不会被误认为同一次冻结。
 */
export function assetLibrarySnapshotFingerprint(
  snapshot: AssetLibrarySnapshot,
): string {
  return JSON.stringify({
    id: snapshot.id,
    configVersion: snapshot.configVersion,
    rootIds: [...snapshot.rootIds].toSorted(),
    directoryInterpreters: capabilityTokens(snapshot.directoryInterpreters),
    recognizers: capabilityTokens(snapshot.recognizers),
    sources: snapshot.sources
      .map((source) => ({
        identity: source.identity,
        collectors: capabilityTokens(source.collectors),
        sourceCandidateInterpreters: capabilityTokens(
          source.sourceCandidateInterpreters,
        ),
        sourceInterpreters: capabilityTokens(source.sourceInterpreters),
        sourceAssociationInterpreters: capabilityTokens(
          source.sourceAssociationInterpreters,
        ),
        acquirers: capabilityTokens(source.acquirers),
        informationFulfillments: capabilityTokens(
          source.informationFulfillments,
        ),
      }))
      .toSorted((left, right) => left.identity.localeCompare(right.identity)),
  });
}
