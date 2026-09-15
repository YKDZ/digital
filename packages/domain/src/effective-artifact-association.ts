import type { ArtifactAssociation, SourceAssociation } from "./index.ts";
import type { DescriptionTarget } from "./metadata-assertion.ts";

export type EffectiveArtifactAssociation = {
  readonly association: ArtifactAssociation;
  readonly contributingAssociations: readonly ArtifactAssociation[];
  readonly sourceIdentity?: string;
};

export type EffectiveArtifactAssociationConflict = {
  readonly kind: "artifact-association-conflict";
  readonly target: DescriptionTarget;
  readonly role: string;
  readonly candidates: readonly ArtifactAssociation[];
};

/**
 * 选择一个单值产物角色。相同产物的事实合并贡献者；不同产物同等合格时显式冲突，
 * 绝不让关联 ID 或数组顺序成为业务决定。
 */
export function deriveEffectiveArtifactAssociation(input: {
  readonly target: DescriptionTarget;
  readonly role: string;
  readonly associations: readonly ArtifactAssociation[];
  readonly sourceAssociations: readonly SourceAssociation[];
  readonly preferredSourceIdentities?: readonly string[];
}):
  | EffectiveArtifactAssociation
  | EffectiveArtifactAssociationConflict
  | undefined {
  const sourceIdentityByAssociation = new Map(
    input.sourceAssociations.map(({ id, sourceIdentity }) => [
      id,
      sourceIdentity,
    ]),
  );
  const candidates = input.associations.filter(
    (association) =>
      association.role === input.role &&
      sameTarget(association.target, input.target),
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
