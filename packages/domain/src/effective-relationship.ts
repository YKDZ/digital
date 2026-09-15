import type {
  EntityRelationship,
  EntityRelationshipParticipant,
} from "./index.ts";

/** 坐标刻意排除 qualifier：更正后的序位仍是同一关系的竞争解释，而不是另一项全局资产属性。 */
export type RelationshipSemanticCoordinate = {
  readonly type: string;
  readonly participants: readonly EntityRelationshipParticipant[];
};

export type RelationshipDecision = {
  readonly id: string;
  readonly coordinate: RelationshipSemanticCoordinate;
  readonly kind: "select" | "fix" | "exclude" | "clear";
  /** select/exclude 决定显式点名的来源事实。 */
  readonly relationshipIds: readonly string[];
  /** fix 是独立且有人工作为支持的事实。 */
  readonly manualRelationshipId?: string;
};

export type EffectiveRelationshipInput = {
  readonly relationships: readonly EntityRelationship[];
  readonly decisions: readonly RelationshipDecision[];
  readonly manualRelationshipDecisionIds: ReadonlyMap<string, string>;
};

/** 唯一的关系投影器。决定作用于完整的关系语义坐标；clear 刻意回到读取时当前的来源事实。 */
export function deriveEffectiveRelationships(
  input: EffectiveRelationshipInput,
): readonly EntityRelationship[] {
  const byCoordinate = new Map<string, EntityRelationship[]>();
  for (const relationship of input.relationships) {
    const key = relationshipCoordinateKey(relationship);
    byCoordinate.set(key, [...(byCoordinate.get(key) ?? []), relationship]);
  }
  const decisionByCoordinate = new Map<string, RelationshipDecision>();
  for (const decision of input.decisions)
    decisionByCoordinate.set(
      relationshipCoordinateKey(decision.coordinate),
      decision,
    );

  return [...byCoordinate.entries()].flatMap(([coordinate, relationships]) => {
    const decision = decisionByCoordinate.get(coordinate);
    if (decision === undefined || decision.kind === "clear")
      return relationships.filter(
        (relationship) =>
          input.manualRelationshipDecisionIds.get(relationship.id) ===
          undefined,
      );
    if (decision.kind === "exclude")
      return relationships.filter(
        (relationship) =>
          !decision.relationshipIds.includes(relationship.id) &&
          input.manualRelationshipDecisionIds.get(relationship.id) ===
            undefined,
      );
    if (decision.kind === "select")
      return relationships.filter((relationship) =>
        decision.relationshipIds.includes(relationship.id),
      );
    return relationships.filter(
      (relationship) =>
        input.manualRelationshipDecisionIds.get(relationship.id) ===
        decision.id,
    );
  });
}

export function relationshipCoordinateKey(
  relationship:
    | Pick<EntityRelationship, "type" | "participants">
    | RelationshipSemanticCoordinate,
): string {
  return JSON.stringify({
    type: relationship.type,
    participants: [...relationship.participants]
      .map(({ entityId, role }) => ({ entityId, role }))
      .toSorted((left, right) =>
        `${left.entityId}\u0000${left.role}`.localeCompare(
          `${right.entityId}\u0000${right.role}`,
        ),
      ),
  });
}
