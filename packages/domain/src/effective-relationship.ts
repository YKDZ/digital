import type { EntityRelationship, RelationshipDraft } from "./index.ts";

/**
 * 决定目标是一个既有事实支持范围的值对象：来源槽位、观察图槽位或独立人工目标。
 * 它刻意不含类型与参与者，因此同类型同参与者的不同事实互不撤销。
 */
export type RelationshipDecisionTarget =
  | {
      readonly kind: "source";
      readonly sourceSubjectId: string;
      readonly sourceIdentity: string;
      readonly nativeAddress: string;
      readonly coverageId: string;
      readonly sourceSlot: string;
    }
  | {
      readonly kind: "observed";
      readonly assetId: string;
      readonly artifactId: string;
      readonly capabilityId: string;
      readonly coverageId: string;
      readonly sourceSlot: string;
    }
  | { readonly kind: "manual"; readonly targetId: string };

export type RelationshipDecision = {
  readonly id: string;
  readonly target: RelationshipDecisionTarget;
  readonly kind: "select" | "fix" | "exclude" | "clear";
  /** fix 的替代事实与 select 点名的证据事实都在此字段上，两者同样只让一项生效。 */
  readonly manualRelationshipId?: string;
};

export type EffectiveRelationshipInput = {
  readonly relationships: readonly EntityRelationship[];
  /** 每项当前事实的稳定支持范围，由持久层按来源、观察或人工支持解析。 */
  readonly targets: ReadonlyMap<string, RelationshipDecisionTarget>;
  readonly decisions: readonly RelationshipDecision[];
  /** 由人工支持证明的不可变事实；它们只在所属决定的目标下生效。 */
  readonly manualRelationshipIds: ReadonlySet<string>;
};

/** 唯一的关系投影器。决定头按目标覆盖，clear 刻意回到读取时当前的来源事实。 */
export function deriveEffectiveRelationships(
  input: EffectiveRelationshipInput,
): readonly EntityRelationship[] {
  const groups = new Map<
    string,
    {
      readonly target: RelationshipDecisionTarget;
      readonly supported: EntityRelationship[];
      readonly manual: EntityRelationship[];
    }
  >();
  for (const relationship of input.relationships) {
    const target = input.targets.get(relationship.id);
    if (target === undefined) throw new Error("关系事实缺少可解析的决定目标");
    const key = relationshipTargetKey(target);
    const group = groups.get(key) ?? {
      target,
      supported: [],
      manual: [],
    };
    groups.set(key, group);
    (input.manualRelationshipIds.has(relationship.id)
      ? group.manual
      : group.supported
    ).push(relationship);
  }
  const decisionByTarget = new Map<string, RelationshipDecision>();
  for (const decision of input.decisions)
    decisionByTarget.set(relationshipTargetKey(decision.target), decision);

  return [...groups.values()].flatMap(
    ({ target, supported, manual }): readonly EntityRelationship[] => {
      const decision = decisionByTarget.get(relationshipTargetKey(target));
      if (decision === undefined) return supported;
      if (decision.kind === "exclude") return [];
      if (decision.kind === "clear")
        return target.kind === "manual" ? [] : supported;
      if (decision.kind === "select") {
        // 点名的选择只让被点名那一项人工证据生效，同目标下的其它人工事实不再复活。
        if (decision.manualRelationshipId !== undefined)
          return manual.filter(
            (relationship) => relationship.id === decision.manualRelationshipId,
          );
        // 没有点名证据的选择沿用该目标当前生效的事实。
        return target.kind === "manual" ? manual : supported;
      }
      // 更正只让它生成的那一项替代事实生效。
      return manual.filter(
        (relationship) => relationship.id === decision.manualRelationshipId,
      );
    },
  );
}

/** 目标键使用固定字段顺序的规范序列化，保证同一支持范围得到同一决定头。 */
export function relationshipTargetKey(
  target: RelationshipDecisionTarget,
): string {
  return JSON.stringify(
    target.kind === "source"
      ? {
          kind: "source",
          sourceSubjectId: target.sourceSubjectId,
          sourceIdentity: target.sourceIdentity,
          nativeAddress: target.nativeAddress,
          coverageId: target.coverageId,
          sourceSlot: target.sourceSlot,
        }
      : target.kind === "observed"
        ? {
            kind: "observed",
            assetId: target.assetId,
            artifactId: target.artifactId,
            capabilityId: target.capabilityId,
            coverageId: target.coverageId,
            sourceSlot: target.sourceSlot,
          }
        : { kind: "manual", targetId: target.targetId },
  );
}

/**
 * 人工草稿的规范内容：声明、类型、完整参与者与限定项。参与者与限定项的排列不影响结果，
 * 因此同一人工目标重复预演得到同一事实，而相同类型与参与者但声明不同的事实仍各自成立。
 */
export function canonicalRelationshipDraft(
  definitionId: string,
  draft: RelationshipDraft,
): string {
  return JSON.stringify({
    definitionId,
    type: draft.type,
    participants: [...draft.participants]
      .map(({ entityId, role }) => ({ entityId, role }))
      .toSorted((left, right) =>
        `${left.entityId}\u0000${left.role}`.localeCompare(
          `${right.entityId}\u0000${right.role}`,
        ),
      ),
    qualifiers: [...(draft.qualifiers ?? [])]
      .map(({ key, value }) => ({ key, value }))
      .toSorted((left, right) =>
        `${left.key}\u0000${left.value}`.localeCompare(
          `${right.key}\u0000${right.value}`,
        ),
      ),
  });
}
