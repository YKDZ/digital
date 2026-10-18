import type {
  DescriptionTarget,
  MetadataAssertion,
} from "./metadata-assertion.ts";

/** 精确属性与使用语境上的可撤回人工值；候选依据只供审计，pin 始终保存确定值。 */
export type MetadataDecision = {
  readonly id: string;
  readonly target: DescriptionTarget;
  readonly property: string;
  readonly metadataUsageContext: string;
  readonly kind: "pin" | "clear";
  readonly value?: string;
  readonly qualifiers?: MetadataAssertion["qualifiers"];
  readonly adoptedFrom?: {
    readonly sourceIdentity: string;
    readonly sourceSlot: string;
    readonly sourceRecordIds: readonly string[];
  };
  readonly predecessorDecisionId?: string;
  readonly initiatedBy: string;
};

/** 目标、属性和使用语境共同确定唯一当前决定。 */
export function metadataDecisionKey(
  target: DescriptionTarget,
  property: string,
  metadataUsageContext: string,
): string {
  return JSON.stringify([
    target.kind === "entity"
      ? [target.kind, target.entityId]
      : [target.kind, target.artifactId, target.revisionId],
    property,
    metadataUsageContext,
  ]);
}

/** 只以前驱已冻结的精确坐标替换当前头，其他属性与使用语境互不影响。 */
export function projectMetadataDecisionHead(
  decisions: readonly MetadataDecision[],
  decision: MetadataDecision,
): readonly MetadataDecision[] {
  const key = metadataDecisionKey(
    decision.target,
    decision.property,
    decision.metadataUsageContext,
  );
  return [
    ...decisions.filter(
      (candidate) =>
        metadataDecisionKey(
          candidate.target,
          candidate.property,
          candidate.metadataUsageContext,
        ) !== key,
    ),
    decision,
  ];
}

/** 决定的领域不变量：撤回无值，pin 固定一个值，采纳依据完整保留但不驱动刷新。 */
export function validateMetadataDecision(decision: MetadataDecision): void {
  if (
    decision.id.trim().length === 0 ||
    decision.property.trim().length === 0 ||
    decision.metadataUsageContext.trim().length === 0 ||
    decision.initiatedBy.trim().length === 0
  )
    throw new Error("元数据决定缺少坐标或发起者");
  if (
    (decision.target.kind === "entity" &&
      decision.target.entityId.trim().length === 0) ||
    (decision.target.kind === "artifact-revision" &&
      (decision.target.artifactId.trim().length === 0 ||
        decision.target.revisionId.trim().length === 0))
  )
    throw new Error("元数据决定目标无效");
  if (decision.predecessorDecisionId?.trim() === "")
    throw new Error("元数据决定的前驱标识无效");
  if (decision.kind === "clear") {
    if (
      decision.value !== undefined ||
      decision.qualifiers !== undefined ||
      decision.adoptedFrom !== undefined
    )
      throw new Error("撤回元数据决定不能携带值或候选依据");
    return;
  }
  if (decision.value === undefined || decision.value.trim().length === 0)
    throw new Error("固定元数据决定必须携带非空精确值");
  if (decision.adoptedFrom !== undefined) {
    const { sourceIdentity, sourceSlot, sourceRecordIds } =
      decision.adoptedFrom;
    if (
      sourceIdentity.trim().length === 0 ||
      sourceSlot.trim().length === 0 ||
      sourceRecordIds.length === 0 ||
      sourceRecordIds.some((id) => id.trim().length === 0) ||
      new Set(sourceRecordIds).size !== sourceRecordIds.length
    )
      throw new Error("采纳的元数据候选依据无效");
  }
}
