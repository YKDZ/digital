import type {
  ArtifactRoleDecision,
  EffectiveArtifactRoleDecisionUnusable,
} from "./artifact-role-decision.ts";
import type { ArtifactAssociation, SourceAssociation } from "./index.ts";
import type { DescriptionTarget } from "./metadata-assertion.ts";

export type EffectiveArtifactAssociation = {
  readonly association: ArtifactAssociation;
  readonly contributingAssociations: readonly ArtifactAssociation[];
  readonly sourceIdentity?: string;
  /** 生效来自哪一项人工决定；只在被点名关联与冻结修订仍然成立时出现。 */
  readonly decisionId?: string;
  /** 人工选择冻结的精确修订，交付地址只能取自它。 */
  readonly selectedRevisionId?: string;
};

export type EffectiveArtifactAssociationConflict = {
  readonly kind: "artifact-association-conflict";
  readonly target: DescriptionTarget;
  readonly role: string;
  readonly candidates: readonly ArtifactAssociation[];
};

/**
 * 选择一个单值产物角色。相同产物的事实合并贡献者；不同产物同等合格时显式冲突，
 * 绝不让关联 ID 或数组顺序成为业务决定。有效人工选择只合并被选产物的当前同角色
 * 关联；失效的人工选择报告阻断该角色的问题，绝不静默降级到本地或自动候选。
 */
export function deriveEffectiveArtifactAssociation(input: {
  readonly target: DescriptionTarget;
  readonly role: string;
  readonly associations: readonly ArtifactAssociation[];
  readonly sourceAssociations: readonly SourceAssociation[];
  readonly preferredSourceIdentities?: readonly string[];
  readonly preferredCapabilityIds?: readonly string[];
  /** 该目标与角色当前的头决定；clear 或缺失时原样调用既有政策求值。 */
  readonly decision?: ArtifactRoleDecision;
  /** 每条候选关联所属产物当前能精确解析出的图片修订；未确认或已非图片时缺席。 */
  readonly currentImageRevisions?: readonly {
    readonly associationId: string;
    readonly revisionId: string;
  }[];
}):
  | EffectiveArtifactAssociation
  | EffectiveArtifactAssociationConflict
  | EffectiveArtifactRoleDecisionUnusable
  | undefined {
  const sourceIdentityByAssociation = new Map(
    input.sourceAssociations.map(({ id, sourceIdentity }) => [
      id,
      sourceIdentity,
    ]),
  );
  const supported = input.associations.filter(
    (association) =>
      association.role === input.role &&
      sameTarget(association.target, input.target),
  );
  const decision = input.decision;
  if (
    decision !== undefined &&
    decision.kind === "select" &&
    decision.role === input.role &&
    sameTarget(decision.target, input.target)
  ) {
    const selected = decision.selected!;
    const chosen = supported.find(
      (association) => association.id === selected.associationId,
    );
    const current = input.currentImageRevisions?.find(
      (candidate) => candidate.associationId === selected.associationId,
    );
    if (
      chosen === undefined ||
      chosen.artifactId !== selected.artifactId ||
      current?.revisionId !== selected.revisionId
    )
      return {
        kind: "artifact-role-decision-unusable",
        target: input.target,
        role: input.role,
        decisionId: decision.id,
        candidates: chosen === undefined ? [] : [chosen],
      };
    const contributingAssociations = supported.filter(
      (association) => association.artifactId === chosen.artifactId,
    );
    const sourceIdentity =
      chosen.sourceAssociationId === undefined
        ? undefined
        : sourceIdentityByAssociation.get(chosen.sourceAssociationId);
    return {
      association: chosen,
      contributingAssociations,
      decisionId: decision.id,
      selectedRevisionId: selected.revisionId,
      ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
    };
  }
  const preferredCapability = input.preferredCapabilityIds?.find((id) =>
    supported.some((association) => association.producer?.capabilityId === id),
  );
  const candidates =
    preferredCapability === undefined
      ? supported
      : supported.filter(
          (association) =>
            association.producer?.capabilityId === preferredCapability,
        );
  if (candidates.length === 0) return undefined;
  const ranked = input.preferredSourceIdentities ?? [];
  const availableRank = ranked.findIndex((sourceIdentity) =>
    candidates.some(
      (association) =>
        association.sourceAssociationId !== undefined &&
        sourceIdentityByAssociation.get(association.sourceAssociationId) ===
          sourceIdentity,
    ),
  );
  const eligible =
    availableRank < 0
      ? candidates
      : candidates.filter(
          (association) =>
            association.sourceAssociationId !== undefined &&
            sourceIdentityByAssociation.get(association.sourceAssociationId) ===
              ranked[availableRank],
        );
  const byArtifact = new Map<string, ArtifactAssociation[]>();
  for (const association of eligible) {
    const current = byArtifact.get(association.artifactId) ?? [];
    current.push(association);
    byArtifact.set(association.artifactId, current);
  }
  if (byArtifact.size !== 1)
    return {
      kind: "artifact-association-conflict",
      target: input.target,
      role: input.role,
      candidates: eligible,
    };
  const contributingAssociations = [...byArtifact.values()][0]!;
  const association = contributingAssociations[0]!;
  const sourceIdentity =
    association.sourceAssociationId === undefined
      ? undefined
      : sourceIdentityByAssociation.get(association.sourceAssociationId);
  return {
    association,
    contributingAssociations,
    ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
  };
}

function sameTarget(
  left: DescriptionTarget,
  right: DescriptionTarget,
): boolean {
  return left.kind === "entity" && right.kind === "entity"
    ? left.entityId === right.entityId
    : left.kind === "artifact-revision" && right.kind === "artifact-revision"
      ? left.artifactId === right.artifactId &&
        left.revisionId === right.revisionId
      : false;
}
