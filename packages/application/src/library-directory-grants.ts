import type {
  ObservedRootRegistration,
  ObservedRootSymlinkMode,
} from "./observed-root-registrations.ts";

/**
 * 最小耐久库目录授权：一个活动库对一个稳定物理根的 I/O 授权。它是应用侧访问授权，
 * 不是资产或文件身份领域事实；removed 行保留以支持点名重连与历史连续性。
 */
export type LibraryDirectoryGrant = {
  readonly id: string;
  readonly libraryId: string;
  readonly observedRootId: string;
  readonly status: "active" | "removed";
  readonly authorityVersion: number;
  readonly symlinkMode: ObservedRootSymlinkMode;
  readonly allowedTargetGrantIds: readonly string[];
  /**
   * 显式重连只恢复 I/O 通路，不证明对象连续。置位期间本库经此根的历史 Location 暂不进入
   * current 投影，也不能被公开字节入口打开，直到一次完整授权观察清零。
   */
  readonly awaitingObservation: boolean;
};

/** 配置事务提交后必须精确送达执行服务的库目录失效坐标。 */
export type LibraryDirectoryInvalidation = {
  readonly assetLibraryId: string;
  readonly observedRootId: string;
  /**
   * 本次提交后仍然成立的活动授权版本：执行服务据此取消更早代次的在进程操作，同时放行这一
   * 新代次的新绑定。目录已不在本库（removed）时不带此字段，表示该坐标没有任何可绑定授权。
   */
  readonly keepVersion?: number;
};

/**
 * 将本库授权投影为既有观察根权威图：只有本库活动授权决定哪些根可以进入图，链接策略
 * 与目标来自授权本身；目标必须同样是本库活动授权，另一库共享同一物理根不会让本库
 * 自动取得目标资格。非本库活动目标的授权被丢弃，闭包解析按既有缺目标纪律诚实失败。
 */
export function projectLibraryDirectoryAuthority(input: {
  readonly grants: readonly LibraryDirectoryGrant[];
  readonly registrations: readonly ObservedRootRegistration[];
}): readonly ObservedRootRegistration[] {
  const grantById = new Map(input.grants.map((grant) => [grant.id, grant]));
  const activeByRoot = new Map<string, LibraryDirectoryGrant>();
  for (const grant of input.grants)
    if (grant.status === "active")
      activeByRoot.set(grant.observedRootId, grant);
  const projected: ObservedRootRegistration[] = [];
  for (const grant of activeByRoot.values()) {
    const registration = input.registrations.find(
      (candidate) => candidate.id === grant.observedRootId,
    );
    if (registration === undefined) continue;
    const allowedTargetRootIds = grant.allowedTargetGrantIds
      .map((targetGrantId) => grantById.get(targetGrantId))
      .filter(
        (target) =>
          target !== undefined &&
          target.status === "active" &&
          target.libraryId === grant.libraryId,
      )
      .map((target) => target!.observedRootId)
      .toSorted();
    projected.push({
      ...registration,
      symlinkMode: grant.symlinkMode,
      allowedTargetRootIds,
    });
  }
  return projected.toSorted((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

/**
 * 执行耐久输入里冻结的一条目录权威；普通配置编辑不改变它，目录或链接授权的明确
 * 撤销与重连才会推进授权版本，让旧执行在下一次效果、提交或恢复时被持久拒绝。
 */
export type FrozenDirectoryAuthorization = {
  readonly observedRootId: string;
  readonly authorityVersion: number;
};

export function decodeFrozenDirectoryAuthorizations(
  value: unknown,
): readonly FrozenDirectoryAuthorization[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded: FrozenDirectoryAuthorization[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return undefined;
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.observedRootId !== "string" ||
      record.observedRootId.length === 0 ||
      seen.has(record.observedRootId) ||
      typeof record.authorityVersion !== "number" ||
      !Number.isSafeInteger(record.authorityVersion) ||
      record.authorityVersion < 1
    )
      return undefined;
    seen.add(record.observedRootId);
    decoded.push({
      observedRootId: record.observedRootId,
      authorityVersion: record.authorityVersion,
    });
  }
  return decoded;
}
