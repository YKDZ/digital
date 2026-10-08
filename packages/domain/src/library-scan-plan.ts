/**
 * 一次耐久库扫描父执行的目录计划载体。领域只保存归属坐标与相对引用，
 * 不解释文件系统路径，也不授予任何访问权限。
 */
export type LibraryScanDirectoryMode = "execute" | "covered";

/**
 * 该配置目录在本次冻结读取时不可用于观察的原因。它是归属诚实失败的类别，不是路径
 * 或服务器细节；交付层据此渲染稳定中文说明。不可用目录永远是独立条目，绝不覆盖别人。
 */
export type LibraryScanDirectoryUnavailable =
  | "missing"
  | "inactive"
  | "unavailable";

export type LibraryScanDirectoryPlan = {
  /** 该配置目录在本次父执行内的稳定键。 */
  readonly directoryKey: string;
  /** 该目录请求的观察根稳定 ID，即既有决定使用的同一 scopeReference 词汇。 */
  readonly scopeReference: string;
  readonly rootVersion: number;
  readonly relativeScope: string;
  readonly mode: LibraryScanDirectoryMode;
  /** covered 目录由哪个 execute 目录承载，以及相对该代表根的引用前缀。 */
  readonly executedByDirectoryKey?: string;
  readonly coveredByReference?: string;
  /**
   * 冻结时该根不可观察的诚实类别。它总是 execute 且从不覆盖或被覆盖；后续子据此如实
   * 失败，绝不借用今日根或猜测归属。
   */
  readonly unavailable?: LibraryScanDirectoryUnavailable;
};

export type LibraryScanPlan = {
  readonly version: "library-scan-plan/1";
  readonly assetLibraryId: string;
  readonly configVersion: number;
  readonly directories: readonly LibraryScanDirectoryPlan[];
};

/** 子执行携带的只读覆盖描述：物理观察在外层代表根，授权仍属于原决定坐标。 */
export type LibraryScanDirectoryCoverage = {
  readonly scopeReference: string;
  readonly rootVersion: number;
  readonly relativePrefix: string;
};

export function libraryScanDirectoryPlanKey(
  directory: LibraryScanDirectoryPlan,
): string {
  return JSON.stringify([
    directory.directoryKey,
    directory.scopeReference,
    directory.rootVersion,
    directory.relativeScope,
    directory.mode,
    directory.executedByDirectoryKey ?? "",
    directory.coveredByReference ?? "",
    directory.unavailable ?? "",
  ]);
}

/** 冻结计划的稳定身份：目录顺序变化不改变它。 */
export function libraryScanPlanKey(plan: LibraryScanPlan): string {
  return JSON.stringify([
    plan.assetLibraryId,
    plan.configVersion,
    plan.directories.map(libraryScanDirectoryPlanKey).toSorted(),
  ]);
}

function isReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRelativeReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.startsWith("/") &&
    !value.split("/").includes("..")
  );
}

export type LibraryScanPlanDecodeResult =
  | { readonly valid: true; readonly plan: LibraryScanPlan }
  | { readonly valid: false; readonly reason: string };

/** 耐久计划必须完全自述；任何缺失或多余字段都让整份计划不可执行。 */
export function decodeLibraryScanPlan(
  value: unknown,
): LibraryScanPlanDecodeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { valid: false, reason: "库扫描目录计划必须是对象" };
  const plan = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(plan).toSorted()) !==
    JSON.stringify([
      "assetLibraryId",
      "configVersion",
      "directories",
      "version",
    ])
  )
    return { valid: false, reason: "库扫描目录计划字段集合无效" };
  if (plan.version !== "library-scan-plan/1")
    return { valid: false, reason: "库扫描目录计划版本不受支持" };
  if (!isReference(plan.assetLibraryId))
    return { valid: false, reason: "库扫描目录计划缺少资产库身份" };
  if (
    typeof plan.configVersion !== "number" ||
    !Number.isInteger(plan.configVersion) ||
    plan.configVersion <= 0
  )
    return { valid: false, reason: "库扫描目录计划配置版本无效" };
  if (!Array.isArray(plan.directories) || plan.directories.length === 0)
    return { valid: false, reason: "库扫描目录计划缺少目录条目" };
  const keys = new Set<string>();
  const directories: LibraryScanDirectoryPlan[] = [];
  for (const candidate of plan.directories) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    )
      return { valid: false, reason: "库扫描目录条目必须是对象" };
    const entry = candidate as Record<string, unknown>;
    const present = Object.keys(entry).toSorted();
    const required = [
      "directoryKey",
      "mode",
      "relativeScope",
      "rootVersion",
      "scopeReference",
    ];
    const optional = [
      "coveredByReference",
      "executedByDirectoryKey",
      "unavailable",
    ];
    if (
      present.length > required.length + optional.length ||
      required.some((key) => !present.includes(key)) ||
      present.some((key) => !required.includes(key) && !optional.includes(key))
    )
      return { valid: false, reason: "库扫描目录条目字段集合无效" };
    if (
      !isReference(entry.directoryKey) ||
      !isReference(entry.scopeReference) ||
      typeof entry.rootVersion !== "number" ||
      !Number.isInteger(entry.rootVersion) ||
      entry.rootVersion <= 0 ||
      !isRelativeReference(entry.relativeScope) ||
      (entry.mode !== "execute" && entry.mode !== "covered")
    )
      return { valid: false, reason: "库扫描目录条目坐标无效" };
    if (
      entry.unavailable !== undefined &&
      entry.unavailable !== "missing" &&
      entry.unavailable !== "inactive" &&
      entry.unavailable !== "unavailable"
    )
      return { valid: false, reason: "库扫描目录不可用类别无效" };
    // 不可用目录永远是独立代表：既不被别的目录覆盖，也不覆盖别人。
    if (
      entry.unavailable !== undefined &&
      (entry.mode !== "execute" ||
        entry.executedByDirectoryKey !== undefined ||
        entry.coveredByReference !== undefined)
    )
      return { valid: false, reason: "不可用目录必须是独立的执行条目" };
    if (
      (entry.mode === "covered") !==
      (entry.executedByDirectoryKey !== undefined &&
        entry.coveredByReference !== undefined)
    )
      return { valid: false, reason: "库扫描目录覆盖归属与模式不一致" };
    if (
      entry.executedByDirectoryKey !== undefined &&
      !isReference(entry.executedByDirectoryKey)
    )
      return { valid: false, reason: "库扫描目录代表键无效" };
    if (
      entry.coveredByReference !== undefined &&
      !isRelativeReference(entry.coveredByReference)
    )
      return { valid: false, reason: "库扫描目录覆盖前缀无效" };
    if (keys.has(entry.directoryKey))
      return { valid: false, reason: "库扫描目录键不能重复" };
    keys.add(entry.directoryKey);
    directories.push(entry as unknown as LibraryScanDirectoryPlan);
  }
  const covered = directories.filter((entry) => entry.mode === "covered");
  if (
    covered.some(
      (entry) =>
        !keys.has(entry.executedByDirectoryKey!) ||
        directories.find(
          (item) => item.directoryKey === entry.executedByDirectoryKey,
        )?.mode !== "execute",
    )
  )
    return { valid: false, reason: "库扫描目录覆盖必须指向本次代表目录" };
  return {
    valid: true,
    plan: {
      version: "library-scan-plan/1",
      assetLibraryId: plan.assetLibraryId as string,
      configVersion: plan.configVersion as number,
      directories,
    },
  };
}

export function decodeLibraryScanDirectoryCoverage(
  value: unknown,
): LibraryScanDirectoryCoverage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const entry = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(entry).toSorted()) !==
    JSON.stringify(["relativePrefix", "rootVersion", "scopeReference"])
  )
    return undefined;
  if (
    !isReference(entry.scopeReference) ||
    typeof entry.rootVersion !== "number" ||
    !Number.isInteger(entry.rootVersion) ||
    entry.rootVersion <= 0 ||
    !isRelativeReference(entry.relativePrefix)
  )
    return undefined;
  return entry as unknown as LibraryScanDirectoryCoverage;
}
