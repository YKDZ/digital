/** 一项不可变的“被并入 → 保留”身份决定。 */
export type EntityIdentityMerge = {
  readonly id: string;
  readonly retainedEntityId: string;
  readonly mergedEntityId: string;
  readonly actorId: string;
  readonly commitmentId: string;
};

/** 只撤回精确的身份合并决定。 */
export type EntityIdentityMergeRetraction = {
  readonly id: string;
  readonly mergeId: string;
  readonly actorId: string;
  readonly commitmentId: string;
};

export type EffectiveEntityIdentity = {
  readonly representativeByEntity: ReadonlyMap<string, string>;
  readonly membersByRepresentative: ReadonlyMap<string, readonly string[]>;
};

/**
 * 当前身份合并是有向森林：每个节点至多一条出边，沿边到唯一根。
 * 损坏的边绝不按时间或标识猜测修复。
 */
export function deriveEffectiveEntityIdentity(input: {
  readonly entityIds: readonly string[];
  readonly merges: readonly EntityIdentityMerge[];
  readonly retractions: readonly EntityIdentityMergeRetraction[];
}): EffectiveEntityIdentity {
  const entities = new Set(input.entityIds);
  const retracted = new Set(input.retractions.map(({ mergeId }) => mergeId));
  const parent = new Map<string, string>();
  for (const merge of input.merges) {
    if (retracted.has(merge.id)) continue;
    if (
      !entities.has(merge.retainedEntityId) ||
      !entities.has(merge.mergedEntityId) ||
      merge.retainedEntityId === merge.mergedEntityId ||
      parent.has(merge.mergedEntityId)
    )
      throw new Error("实体身份合并森林损坏");
    parent.set(merge.mergedEntityId, merge.retainedEntityId);
  }
  const representativeByEntity = new Map<string, string>();
  const representative = (entityId: string): string => {
    const known = representativeByEntity.get(entityId);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    let current = entityId;
    while (parent.has(current)) {
      if (seen.has(current)) throw new Error("实体身份合并形成环");
      seen.add(current);
      current = parent.get(current)!;
    }
    for (const member of seen) representativeByEntity.set(member, current);
    representativeByEntity.set(entityId, current);
    return current;
  };
  const membersByRepresentative = new Map<string, string[]>();
  for (const entityId of input.entityIds) {
    const root = representative(entityId);
    membersByRepresentative.set(root, [
      ...(membersByRepresentative.get(root) ?? []),
      entityId,
    ]);
  }
  return { representativeByEntity, membersByRepresentative };
}
