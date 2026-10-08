import type { ArtifactAssociation, ArtifactRole } from "./index.ts";
import type { DescriptionTarget } from "./metadata-assertion.ts";

/**
 * 用户从已有产物角色候选中作出的人工决定：坐标只是规范化的目标加角色，
 * 不含资产库、页面、媒体类型或使用语境。决定只追加，重新选择与撤回都写后继。
 */
export type ArtifactRoleDecision = {
  readonly id: string;
  readonly target: DescriptionTarget;
  readonly role: ArtifactRole;
  readonly kind: "select" | "clear";
  /** select 同时冻结所点名关联、产物与当时精确修订，三者不能只凭路径重建。 */
  readonly selected?: {
    readonly associationId: string;
    readonly artifactId: string;
    readonly revisionId: string;
  };
  readonly predecessorDecisionId?: string;
  readonly initiatedBy: string;
};

/** 一个目标加角色最多一个当前头，因此头按这一规范键唯一。 */
export function artifactRoleDecisionKey(
  target: DescriptionTarget,
  role: string,
): string {
  return JSON.stringify(
    target.kind === "entity"
      ? [role, target.kind, target.entityId]
      : [role, target.kind, target.artifactId, target.revisionId],
  );
}

/** 预演投影用的头替换：同坐标的旧头被这条后继唯一取代，其他坐标原样保留。 */
export function projectArtifactRoleDecisionHead(
  decisions: readonly ArtifactRoleDecision[],
  decision: ArtifactRoleDecision,
): readonly ArtifactRoleDecision[] {
  const key = artifactRoleDecisionKey(decision.target, decision.role);
  return [
    ...decisions.filter(
      (candidate) =>
        artifactRoleDecisionKey(candidate.target, candidate.role) !== key,
    ),
    decision,
  ];
}

/** 决定形状的领域不变量：select 必须带完整三坐标，clear 刻意不带选择。 */
export function validateArtifactRoleDecision(
  decision: ArtifactRoleDecision,
): void {
  if (decision.id.trim().length === 0) throw new Error("产物角色决定缺少标识");
  if (decision.role.trim().length === 0)
    throw new Error("产物角色决定缺少角色");
  if (decision.initiatedBy.trim().length === 0)
    throw new Error("产物角色决定缺少发起者");
  if (decision.kind === "clear") {
    if (decision.selected !== undefined)
      throw new Error("撤回产物角色决定不能携带选择");
    return;
  }
  const selected = decision.selected;
  if (
    selected === undefined ||
    selected.associationId.trim().length === 0 ||
    selected.artifactId.trim().length === 0 ||
    selected.revisionId.trim().length === 0
  )
    throw new Error("产物角色选择必须冻结关联、产物与精确修订");
}

export type EffectiveArtifactRoleDecisionUnusable = {
  readonly kind: "artifact-role-decision-unusable";
  readonly target: DescriptionTarget;
  readonly role: string;
  readonly decisionId: string;
  readonly candidates: readonly ArtifactAssociation[];
};
