import path from "node:path";

import type {
  AuthorizedObservedRootTarget,
  ObservedRootRegistration,
  ObservedRootSnapshot,
  ObservedRootSymlinkMode,
} from "./observed-root-registrations.ts";

export type ObservedRootAutomationScope = {
  /** 周期计划属于一个库内的目录，绝不指向可自由选择的全局观察根。 */
  readonly assetLibraryId: string;
  readonly observedRootId: string;
  readonly relativeScope: string;
};

/**
 * 一次性自动化授权中不含路径的部分。SQLite 在即时事务内使用该值，前序绑定则由
 * 描述符边界持有；两层都无需重新解释目标图。
 */
export type ObservedRootAutomationAuthorization = {
  readonly observedRootId: string;
  readonly configVersion: number;
  readonly authorizedTargetRoots: readonly {
    readonly id: string;
    readonly configVersion: number;
  }[];
};

export type ObservedRootAuthorityIndex = {
  readonly registrations: ReadonlyMap<string, ObservedRootRegistration>;
};

export type ObservedRootAuthorityResolution =
  | {
      readonly status: "available";
      readonly root: ObservedRootRegistration;
      readonly authorizedTargetRoots: readonly AuthorizedObservedRootTarget[];
    }
  | {
      readonly status: "unavailable";
      readonly reason: "missing-root" | "revoked-root" | "missing-target";
    };

export type ObservedRootDecodeResult<Value> =
  | { readonly valid: true; readonly value: Value }
  | { readonly valid: false; readonly reason: string };

/**
 * 构建每个权威决策使用的不可变索引。调用方持有自己的事务或查询生命周期；本模块
 * 只持有纯粹的图与版本语义。
 */
export function createObservedRootAuthorityIndex(
  registrations: readonly ObservedRootRegistration[],
): ObservedRootAuthorityIndex {
  const byId = new Map<string, ObservedRootRegistration>();
  for (const registration of registrations) {
    if (byId.has(registration.id)) throw new Error("文件位置配置包含重复编号");
    byId.set(registration.id, registration);
  }
  return Object.freeze({ registrations: byId });
}

/**
 * 解析完整的有向目标闭包，不让调用方了解如何遍历、排序或拒绝非活动注册。循环由
 * 注册身份限制，且绝不会把根本身提升进它的目标闭包。
 */
export function resolveObservedRootAuthority(
  index: ObservedRootAuthorityIndex,
  rootId: string,
): ObservedRootAuthorityResolution {
  const root = index.registrations.get(rootId);
  if (root === undefined)
    return { status: "unavailable", reason: "missing-root" };
  if (root.status !== "active")
    return { status: "unavailable", reason: "revoked-root" };
  const targets = new Map<string, AuthorizedObservedRootTarget>();
  const visit = (
    id: string,
  ):
    | Extract<
        ObservedRootAuthorityResolution,
        { readonly status: "unavailable" }
      >
    | undefined => {
    if (id === root.id || targets.has(id)) return undefined;
    const target = index.registrations.get(id);
    if (target === undefined || target.status !== "active")
      return { status: "unavailable", reason: "missing-target" };
    targets.set(target.id, {
      id: target.id,
      configVersion: target.configVersion,
      containerPath: target.containerPath,
      canonicalPath: target.canonicalPath,
    });
    for (const childId of target.allowedTargetRootIds) {
      const unavailable = visit(childId);
      if (unavailable !== undefined) return unavailable;
    }
    return undefined;
  };
  for (const targetId of root.allowedTargetRootIds) {
    const unavailable = visit(targetId);
    if (unavailable !== undefined) return unavailable;
  }
  return {
    status: "available",
    root,
    authorizedTargetRoots: Object.freeze(
      [...targets.values()].toSorted(compareTargetIds),
    ),
  };
}

/** 从一个当前有效的权威创建耐久描述符绑定证据。 */
export function freezeObservedRootSnapshot(
  authority: Extract<
    ObservedRootAuthorityResolution,
    { readonly status: "available" }
  >,
): ObservedRootSnapshot {
  const root = authority.root;
  return Object.freeze({
    version: "observed-root-snapshot/1" as const,
    id: root.id,
    configVersion: root.configVersion,
    containerPath: root.containerPath,
    canonicalPath: root.canonicalPath,
    readOnly: true as const,
    symlinkMode: root.symlinkMode,
    allowedTargetRootIds: Object.freeze([...root.allowedTargetRootIds]),
    authorizedTargetRoots: Object.freeze(
      authority.authorizedTargetRoots.map((target) =>
        Object.freeze({ ...target }),
      ),
    ),
  });
}

/**
 * 将一个冻结权威与当前注册图比较。闭包机制引入前的快照只在目标声明为空时兼容；
 * 否则恢复过程会捏造从未冻结过的目标拼写。
 */
export function hasCurrentObservedRootAuthority(
  frozen: ObservedRootSnapshot,
  index: ObservedRootAuthorityIndex,
): boolean {
  const current = resolveObservedRootAuthority(index, frozen.id);
  if (current.status !== "available") return false;
  const root = current.root;
  if (
    root.configVersion !== frozen.configVersion ||
    root.containerPath !== frozen.containerPath ||
    root.canonicalPath !== frozen.canonicalPath ||
    root.readOnly !== frozen.readOnly ||
    root.symlinkMode !== frozen.symlinkMode ||
    !sameStringList(root.allowedTargetRootIds, frozen.allowedTargetRootIds)
  ) {
    return false;
  }
  const frozenTargets = frozen.authorizedTargetRoots;
  if (frozenTargets === undefined)
    return frozen.allowedTargetRootIds.length === 0;
  return sameAuthorizedTargetClosure(
    frozenTargets,
    current.authorizedTargetRoots,
  );
}

/**
 * 目标注册撤销后，根本身及所有传递依赖方都必须失去未来的自动化权威。
 */
export function observedRootIdsDependingOn(
  index: ObservedRootAuthorityIndex,
  revokedRootId: string,
): ReadonlySet<string> {
  const affected = new Set([revokedRootId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const root of index.registrations.values()) {
      if (affected.has(root.id)) continue;
      if (root.allowedTargetRootIds.some((id) => affected.has(id))) {
        affected.add(root.id);
        expanded = true;
      }
    }
  }
  return affected;
}

/**
 * 求值 SQLite 写入自动化意图前所使用的精确无路径证据。相对范围解析与目标闭包由
 * 注册和恢复共同复用，而不是在持久化层重新实现。
 */
export function isAutomationObservedRootAuthorizationCurrent(input: {
  readonly scope: ObservedRootAutomationScope;
  readonly authorization: ObservedRootAutomationAuthorization;
  readonly index: ObservedRootAuthorityIndex;
}): boolean {
  if (
    !isObservedRootAutomationScope(input.scope) ||
    input.scope.observedRootId !== input.authorization.observedRootId ||
    !isNonBlankString(input.authorization.observedRootId) ||
    !isPositiveSafeInteger(input.authorization.configVersion)
  ) {
    return false;
  }
  const current = resolveObservedRootAuthority(
    input.index,
    input.authorization.observedRootId,
  );
  if (
    current.status !== "available" ||
    current.root.configVersion !== input.authorization.configVersion
  ) {
    return false;
  }
  const expected = normalizeAutomationTargets(
    input.authorization.authorizedTargetRoots,
    input.authorization.observedRootId,
  );
  if (expected === undefined) return false;
  return sameAutomationTargetClosure(
    expected,
    current.authorizedTargetRoots.map((target) => ({
      id: target.id,
      configVersion: target.configVersion,
    })),
  );
}

/**
 * 把冻结的描述符授权投影为传递到原子自动化持久化边界的无路径证据。这里不解析当前
 * 注册；SQLite 在持有事务期间使用同一个求值器完成解析。
 */
export function freezeObservedRootAutomationAuthorization(
  root: ObservedRootSnapshot,
): ObservedRootAutomationAuthorization | undefined {
  const decoded = decodeObservedRootSnapshot(root);
  if (!decoded.valid) return undefined;
  const targets =
    decoded.value.authorizedTargetRoots ??
    (decoded.value.allowedTargetRootIds.length === 0 ? [] : undefined);
  if (targets === undefined) return undefined;
  return Object.freeze({
    observedRootId: decoded.value.id,
    configVersion: decoded.value.configVersion,
    authorizedTargetRoots: Object.freeze(
      targets
        .map((target) => ({
          id: target.id,
          configVersion: target.configVersion,
        }))
        .toSorted(compareAutomationTargetIds),
    ),
  });
}

export function isObservedRootAutomationScope(
  value: unknown,
): value is ObservedRootAutomationScope {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).length !== 3 ||
    !Object.keys(value).every((key) =>
      ["observedRootId", "relativeScope", "assetLibraryId"].includes(key),
    ) ||
    !isNonBlankString(value.observedRootId) ||
    !isNonBlankString(value.assetLibraryId) ||
    typeof value.relativeScope !== "string"
  ) {
    return false;
  }
  try {
    return (
      normalizeObservedRelativeScope(value.relativeScope) ===
      value.relativeScope
    );
  } catch {
    return false;
  }
}

/** 规范化注册范围与意图使用的持久化拼写。 */
export function normalizeObservedRelativeScope(value: string): string {
  if (path.isAbsolute(value)) throw new Error("文件位置范围必须是相对路径");
  const normalized = path.normalize(value || ".");
  if (
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.includes(`..${path.sep}`)
  ) {
    throw new Error("文件位置范围不能越过登记根目录");
  }
  return normalized;
}

export function decodeObservedRootSnapshot(
  value: unknown,
): ObservedRootDecodeResult<ObservedRootSnapshot> {
  if (!isRecord(value)) return invalidSnapshot("文件位置快照必须是对象");
  const allowedKeys = [
    "version",
    "id",
    "configVersion",
    "containerPath",
    "canonicalPath",
    "readOnly",
    "symlinkMode",
    "allowedTargetRootIds",
    "authorizedTargetRoots",
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key)))
    return invalidSnapshot("文件位置快照包含不支持的字段");
  if (
    value.version !== "observed-root-snapshot/1" ||
    !isNonBlankString(value.id) ||
    !isPositiveSafeInteger(value.configVersion) ||
    !isAbsolutePath(value.containerPath) ||
    !isAbsolutePath(value.canonicalPath) ||
    value.readOnly !== true ||
    !isObservedRootSymlinkMode(value.symlinkMode)
  ) {
    return invalidSnapshot("文件位置快照字段无效");
  }
  const allowedTargetRootIds = decodeUniqueIdentifierList(
    value.allowedTargetRootIds,
  );
  if (allowedTargetRootIds === undefined)
    return invalidSnapshot("文件位置快照允许目标无效");
  const targets = decodeFrozenAuthorizedTargets(value.authorizedTargetRoots);
  if (targets === undefined) {
    if (
      value.authorizedTargetRoots === undefined &&
      allowedTargetRootIds.length === 0
    ) {
      return {
        valid: true,
        value: freezeDecodedSnapshot({
          id: value.id,
          configVersion: value.configVersion,
          containerPath: value.containerPath,
          canonicalPath: value.canonicalPath,
          symlinkMode: value.symlinkMode,
          allowedTargetRootIds,
        }),
      };
    }
    return invalidSnapshot("文件位置快照冻结目标无效");
  }
  const targetIds = new Set(targets.map((target) => target.id));
  if (
    targetIds.has(value.id) ||
    !allowedTargetRootIds.every((id) => targetIds.has(id))
  ) {
    return invalidSnapshot("文件位置快照冻结目标与登记目标不一致");
  }
  return {
    valid: true,
    value: freezeDecodedSnapshot({
      id: value.id,
      configVersion: value.configVersion,
      containerPath: value.containerPath,
      canonicalPath: value.canonicalPath,
      symlinkMode: value.symlinkMode,
      allowedTargetRootIds,
      authorizedTargetRoots: targets,
    }),
  };
}

/** 在 JSON 字段进入 unknown 边界后，严格解码 SQLite 传输行。 */
export function decodeObservedRootRegistration(
  value: unknown,
): ObservedRootDecodeResult<ObservedRootRegistration> {
  if (!isRecord(value))
    return invalidRegistration("文件位置持久配置必须是对象");
  const allowedKeys = [
    "id",
    "displayName",
    "containerPath",
    "canonicalPath",
    "status",
    "configVersion",
    "readOnly",
    "symlinkMode",
    "allowedTargetRootIds",
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key)))
    return invalidRegistration("文件位置持久配置包含不支持的字段");
  const allowedTargetRootIds = decodeUniqueIdentifierList(
    value.allowedTargetRootIds,
  );
  if (
    !isNonBlankString(value.id) ||
    !isNonBlankString(value.displayName) ||
    !isAbsolutePath(value.containerPath) ||
    !isAbsolutePath(value.canonicalPath) ||
    (value.status !== "active" && value.status !== "revoked") ||
    !isPositiveSafeInteger(value.configVersion) ||
    value.readOnly !== true ||
    !isObservedRootSymlinkMode(value.symlinkMode) ||
    allowedTargetRootIds === undefined
  ) {
    return invalidRegistration("文件位置持久配置字段无效");
  }
  return {
    valid: true,
    value: Object.freeze({
      id: value.id,
      displayName: value.displayName,
      containerPath: value.containerPath,
      canonicalPath: value.canonicalPath,
      status: value.status,
      configVersion: value.configVersion,
      readOnly: true as const,
      symlinkMode: value.symlinkMode,
      allowedTargetRootIds: Object.freeze([...allowedTargetRootIds]),
    }),
  };
}

function freezeDecodedSnapshot(input: {
  readonly id: string;
  readonly configVersion: number;
  readonly containerPath: string;
  readonly canonicalPath: string;
  readonly symlinkMode: ObservedRootSymlinkMode;
  readonly allowedTargetRootIds: readonly string[];
  readonly authorizedTargetRoots?: readonly AuthorizedObservedRootTarget[];
}): ObservedRootSnapshot {
  return Object.freeze({
    version: "observed-root-snapshot/1" as const,
    id: input.id,
    configVersion: input.configVersion,
    containerPath: input.containerPath,
    canonicalPath: input.canonicalPath,
    readOnly: true as const,
    symlinkMode: input.symlinkMode,
    allowedTargetRootIds: Object.freeze([...input.allowedTargetRootIds]),
    ...(input.authorizedTargetRoots === undefined
      ? {}
      : {
          authorizedTargetRoots: Object.freeze(
            input.authorizedTargetRoots.map((target) =>
              Object.freeze({ ...target }),
            ),
          ),
        }),
  });
}

function decodeFrozenAuthorizedTargets(
  value: unknown,
): readonly AuthorizedObservedRootTarget[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const targets: AuthorizedObservedRootTarget[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined;
    const keys = Object.keys(candidate);
    if (
      keys.length !== 4 ||
      !keys.every((key) =>
        ["id", "configVersion", "containerPath", "canonicalPath"].includes(key),
      ) ||
      !isNonBlankString(candidate.id) ||
      !isPositiveSafeInteger(candidate.configVersion) ||
      !isAbsolutePath(candidate.containerPath) ||
      !isAbsolutePath(candidate.canonicalPath) ||
      ids.has(candidate.id)
    ) {
      return undefined;
    }
    ids.add(candidate.id);
    targets.push({
      id: candidate.id,
      configVersion: candidate.configVersion,
      containerPath: candidate.containerPath,
      canonicalPath: candidate.canonicalPath,
    });
  }
  return targets.toSorted(compareTargetIds);
}

function normalizeAutomationTargets(
  targets: readonly { readonly id: string; readonly configVersion: number }[],
  rootId: string,
):
  | readonly { readonly id: string; readonly configVersion: number }[]
  | undefined {
  const ids = new Set<string>();
  const normalized: Array<{
    readonly id: string;
    readonly configVersion: number;
  }> = [];
  for (const target of targets) {
    if (
      !isNonBlankString(target.id) ||
      target.id === rootId ||
      !isPositiveSafeInteger(target.configVersion) ||
      ids.has(target.id)
    ) {
      return undefined;
    }
    ids.add(target.id);
    normalized.push({ id: target.id, configVersion: target.configVersion });
  }
  return normalized.toSorted(compareAutomationTargetIds);
}

function compareAutomationTargetIds(
  left: { readonly id: string },
  right: { readonly id: string },
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function sameAutomationTargetClosure(
  left: readonly { readonly id: string; readonly configVersion: number }[],
  right: readonly { readonly id: string; readonly configVersion: number }[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].toSorted((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return left.every(
    (target, index) =>
      target.id === sortedRight[index]?.id &&
      target.configVersion === sortedRight[index]?.configVersion,
  );
}

function sameAuthorizedTargetClosure(
  left: readonly AuthorizedObservedRootTarget[],
  right: readonly AuthorizedObservedRootTarget[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].toSorted(compareTargetIds);
  const sortedRight = [...right].toSorted(compareTargetIds);
  return sortedLeft.every(
    (target, index) =>
      target.id === sortedRight[index]?.id &&
      target.configVersion === sortedRight[index]?.configVersion &&
      target.containerPath === sortedRight[index]?.containerPath &&
      target.canonicalPath === sortedRight[index]?.canonicalPath,
  );
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function decodeUniqueIdentifierList(
  value: unknown,
): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every(isNonBlankString)) return undefined;
  const ids = new Set(value);
  return ids.size === value.length ? value : undefined;
}

function isObservedRootSymlinkMode(
  value: unknown,
): value is ObservedRootSymlinkMode {
  return (
    value === "do-not-follow" ||
    value === "follow-file-links" ||
    value === "follow-file-and-directory-links"
  );
}

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && path.isAbsolute(value)
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareTargetIds(
  left: AuthorizedObservedRootTarget,
  right: AuthorizedObservedRootTarget,
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function invalidSnapshot(reason: string): ObservedRootDecodeResult<never> {
  return { valid: false, reason };
}

function invalidRegistration(reason: string): ObservedRootDecodeResult<never> {
  return { valid: false, reason };
}
