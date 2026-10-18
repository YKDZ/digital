import {
  deriveEffectiveArtifactAssociation,
  deriveEffectiveMetadata,
  deriveEffectiveRelationships,
  validateMetadataPolicy,
  type ArtifactAssociation,
  type ArtifactRevision,
  type ArtifactRoleDecision,
  type Blob,
  type CurrentRelatedEntity,
  type DescriptionTarget,
  type EffectiveMetadata,
  type EntityRelationship,
  type Location,
  type MetadataAssertion,
  type MetadataDecision,
  type MetadataPolicy,
  type RelationshipDecision,
  type RelationshipDecisionTarget,
  type SourceAssociation,
} from "@digital/domain";

import type { InformationRequirement } from "./index.ts";
import type { InformationReadiness } from "./information-fulfillment.ts";
import type { MetadataPolicyConfiguration } from "./metadata-policy-configuration.ts";

/** 可冻结、可序列化的关系求值依据；决定按支持目标匹配，绝不按显示名匹配。 */
export type RelationshipReadBasis = {
  readonly targets: readonly {
    readonly relationshipId: string;
    readonly target: RelationshipDecisionTarget;
  }[];
  readonly decisions: readonly RelationshipDecision[];
  readonly manualRelationshipIds: readonly string[];
  readonly participantResolutions?: readonly {
    readonly mentionId: string;
    readonly entityId: string;
  }[];
  readonly identityRepresentatives?: readonly {
    readonly entityId: string;
    readonly representativeId: string;
  }[];
};

/** 内部依据只用于求值及审计，普通读取不透传候选、历史修订或原始断言。 */
export type SubjectFactBasis = {
  readonly id: string;
  readonly sourceAssociations: readonly SourceAssociation[];
  readonly recognitionSourceAssociation?: SourceAssociation;
  readonly metadata: readonly MetadataAssertion[];
  readonly metadataDecisions?: readonly MetadataDecision[];
  readonly metadataSourceRecords?: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
  }[];
  readonly currentRelatedEntities?: readonly CurrentRelatedEntity[];
  readonly relationships?: readonly EntityRelationship[];
  readonly relationshipReadBasis?: RelationshipReadBasis;
  readonly artifactAssociations: readonly ArtifactAssociation[];
  /**
   * 每个目标加角色的当前头决定，只装决定本身，历史与候选集留在持久证据里。
   * 缺失时按既有政策求值；失效的人工选择只报告阻断问题，不会静默换图。
   */
  readonly artifactRoleDecisions?: readonly ArtifactRoleDecision[];
  readonly artifactRevisions: readonly ArtifactRevision[];
  readonly blobs: readonly Blob[];
  readonly locations: readonly Location[];
  readonly currentLocationRevisions?: readonly {
    readonly locationId: string;
    readonly revisionId: string;
  }[];
};

export type SelectedMetadataRead = Pick<
  EffectiveMetadata,
  | "property"
  | "value"
  | "qualifiers"
  | "sourceIdentity"
  | "sourceSlot"
  | "reasoning"
> & {
  readonly assertions: readonly Pick<
    MetadataAssertion,
    "target" | "sourceSlot" | "sourceRecordIds"
  >[];
  readonly sourceRecordIds: readonly string[];
};

export type FactReadConflict = {
  readonly kind:
    | "policy-conflict"
    | "metadata-value-conflict"
    | "artifact-association-conflict"
    | "artifact-role-decision-unusable"
    | "artifact-role-content-unavailable";
  readonly property?: string;
  readonly role?: string;
  readonly references: readonly (
    | {
        readonly kind: "metadata";
        readonly target: DescriptionTarget;
        readonly sourceSlot: string;
        readonly sourceRecordIds: readonly string[];
      }
    | { readonly kind: "artifact-association"; readonly associationId: string }
    | { readonly kind: "artifact-role-decision"; readonly decisionId: string }
  )[];
  readonly explanation: string;
};

export type EffectiveArtifactRoleRead = {
  readonly role: string;
  readonly artifactId: string;
  readonly associationIds: readonly string[];
  readonly observedArtifactParts?: readonly {
    readonly associationId: string;
    readonly artifactId: string;
    readonly revisionId: string;
    readonly locator: string;
  }[];
  readonly locationId?: string;
  readonly address?: string;
};

export type EffectiveDescriptionRead = {
  readonly target: DescriptionTarget;
  readonly metadataUsageContext: string;
  readonly metadata: readonly {
    readonly property: string;
    readonly result:
      | {
          readonly status: "resolved";
          readonly values: readonly SelectedMetadataRead[];
        }
      | { readonly status: "missing" }
      | { readonly status: "conflict"; readonly conflict: FactReadConflict };
  }[];
  readonly metadataScope:
    | { readonly kind: "all-available" }
    | { readonly kind: "requested"; readonly selectors: readonly string[] };
  readonly artifactRoles: readonly EffectiveArtifactRoleRead[];
  readonly missingArtifactRoles: readonly string[];
  readonly conflicts: readonly FactReadConflict[];
};

export type CurrentLocationRead = Pick<
  Location,
  "id" | "artifactId" | "kind" | "address"
> & {
  readonly content:
    | { readonly status: "unconfirmed" }
    | {
        readonly status: "confirmed";
        readonly target: Extract<
          DescriptionTarget,
          { readonly kind: "artifact-revision" }
        >;
      };
  readonly byteLength?: number;
};

/** 普通资产查询唯一的事实契约；与识别提交及工作流检查 DTO 无继承关系。 */
export type EffectiveSubjectRead = {
  readonly id: string;
  readonly sourceAssociations: readonly Pick<
    SourceAssociation,
    "sourceIdentity" | "nativeAddress"
  >[];
  readonly recognitionSourceAssociation?: Pick<
    SourceAssociation,
    "sourceIdentity" | "nativeAddress"
  >;
  readonly descriptions: readonly EffectiveDescriptionRead[];
  readonly relatedEntities: readonly Pick<
    CurrentRelatedEntity,
    | "id"
    | "kind"
    | "label"
    | "sourceIdentity"
    | "identityNamespace"
    | "sourceKey"
  >[];
  readonly relationships: readonly Pick<
    EntityRelationship,
    "id" | "type" | "participants" | "qualifiers" | "sourceRecordIds"
  >[];
  readonly locations: readonly CurrentLocationRead[];
  readonly informationReadiness?: InformationReadiness["subjects"][number];
  /** 当前来源声明的可获取附件描述，不包含获取地址或执行凭据。 */
  readonly sourceArtifacts?: readonly {
    readonly role: string;
    readonly mediaType: string;
    readonly selectionEvidence?: {
      readonly suggestedFilename?: string;
      readonly declaredByteLength?: number;
      readonly sourceOrdinal?: number;
    };
  }[];
};

/** 单个已报告冲突候选：保留断言值、来源身份，以及可核对的支持记录标识。 */
export type SubjectConflictCandidateEvidence = {
  readonly value: string;
  readonly sourceIdentity: string;
  readonly sourceRecordIds: readonly string[];
};

/** 所选主体一项属性的已报告资料冲突候选，绝不包含被排除或非冲突断言。 */
export type SubjectConflictEvidence = {
  readonly property: string;
  readonly kind: "policy-conflict" | "metadata-value-conflict";
  readonly candidates: readonly SubjectConflictCandidateEvidence[];
};

/** 一条被求值的原始元数据候选；`exclusion` 只在共同规则明确未采用该值时出现。 */
export type SubjectMetadataCandidateEvidence = {
  /** 对精确候选及其来源支持计算的不透明引用，用于预演时再次核验。 */
  readonly reference?: string;
  readonly target: DescriptionTarget;
  readonly property: string;
  readonly value: string;
  readonly sourceIdentity: string;
  readonly sourceSlot: string;
  readonly sourceRecordIds: readonly string[];
  readonly qualifiers?: MetadataAssertion["qualifiers"];
  readonly exclusion?: import("@digital/domain").EffectiveMetadataAlternative["exclusion"];
};

/** 当前元数据裁决的有界依据，不改变普通读取的有效值。 */
export type SubjectMetadataEvidence = {
  readonly property: string;
  readonly result:
    | {
        readonly status: "resolved";
        readonly values: readonly SelectedMetadataRead[];
        readonly notSelected: readonly SubjectMetadataCandidateEvidence[];
      }
    | {
        readonly status: "conflict";
        readonly kind: "policy-conflict" | "metadata-value-conflict";
        readonly explanation: string;
        readonly candidates: readonly SubjectMetadataCandidateEvidence[];
      }
    | { readonly status: "missing" };
};

export function effectiveRelationships(
  relationships: readonly EntityRelationship[],
  basis: RelationshipReadBasis | undefined,
): readonly EntityRelationship[] {
  // 尚未持久化的来源解释没有人工决定；持久化当前读取必须提供稳定支持依据。
  if (basis === undefined) return relationships;
  const resolutions = new Map(
    (basis.participantResolutions ?? []).map((item) => [
      item.mentionId,
      item.entityId,
    ]),
  );
  const representatives = new Map(
    (basis.identityRepresentatives ?? []).map((item) => [
      item.entityId,
      item.representativeId,
    ]),
  );
  return deriveEffectiveRelationships({
    relationships,
    targets: new Map(
      basis.targets.map(({ relationshipId, target }) => [
        relationshipId,
        target,
      ]),
    ),
    decisions: basis.decisions,
    manualRelationshipIds: new Set(basis.manualRelationshipIds),
  }).map((relationship) => ({
    ...relationship,
    participants: relationship.participants.map((participant) => {
      const resolved =
        participant.mentionIds
          ?.map((mentionId) => resolutions.get(mentionId))
          .find((id) => id !== undefined) ?? participant.entityId;
      return {
        ...participant,
        entityId: representatives.get(resolved) ?? resolved,
      };
    }),
  }));
}

export function descriptionTargetKey(target: DescriptionTarget): string {
  return target.kind === "entity"
    ? JSON.stringify([target.kind, target.entityId])
    : JSON.stringify([target.kind, target.artifactId, target.revisionId]);
}

/** 普通读取和依据检查共同选择策略，后者可另外返回完整候选解释。 */
export function metadataPoliciesForSubject(
  id: string,
  sourceAssociations: readonly SourceAssociation[],
  configuration: MetadataPolicyConfiguration | undefined,
  metadataUsageContext: string,
): readonly MetadataPolicy[] {
  const definitions = new Map(
    (configuration?.policies ?? []).map((policy) => [policy.id, policy]),
  );
  if (
    configuration !== undefined &&
    (configuration.version.length === 0 ||
      definitions.size !== configuration.policies.length)
  )
    throw new Error("资料策略配置无效");
  const selectedIds = configuration?.select({ sourceAssociations }) ?? [];
  if (new Set(selectedIds).size !== selectedIds.length)
    throw new Error("资料策略选择包含重复项目");
  return selectedIds.flatMap((policyId) => {
    const definition = definitions.get(policyId);
    if (definition === undefined)
      throw new Error(`资料策略不存在：${policyId}`);
    const policy = validateMetadataPolicy({ ...definition, subjectIds: [id] });
    return policy.metadataUsageContext === metadataUsageContext ? [policy] : [];
  });
}

/** 重复实体到代表的稳定归一映射，供主体与其成员共用同一生效元数据裁决。 */
function identityRepresentativeMap(
  basis: SubjectFactBasis,
): Map<string, string> {
  return new Map(
    (basis.relationshipReadBasis?.identityRepresentatives ?? []).map((item) => [
      item.entityId,
      item.representativeId,
    ]),
  );
}

function projectEntityTarget(
  representatives: Map<string, string>,
  subjectId: string,
  target: DescriptionTarget,
): DescriptionTarget {
  return target.kind === "entity" && target.entityId !== subjectId
    ? {
        kind: "entity",
        entityId: representatives.get(target.entityId) ?? target.entityId,
      }
    : target;
}

function projectedMetadataAssertions(
  representatives: Map<string, string>,
  basis: SubjectFactBasis,
): readonly MetadataAssertion[] {
  return basis.metadata.map((assertion) => ({
    ...assertion,
    target: projectEntityTarget(representatives, basis.id, assertion.target),
  }));
}

function projectedMetadataDecisions(
  representatives: Map<string, string>,
  basis: SubjectFactBasis,
): readonly MetadataDecision[] {
  return (basis.metadataDecisions ?? []).map((decision) => ({
    ...decision,
    target: projectEntityTarget(representatives, basis.id, decision.target),
  }));
}

/** 当前内容与图片资格只有这一条规则；共同求值与人工候选列表共用它的结果。 */
function currentContentReads(basis: SubjectFactBasis): {
  readonly revisions: ReadonlyMap<string, ArtifactRevision>;
  readonly locations: readonly CurrentLocationRead[];
  readonly currentImageRevisionByArtifact: ReadonlyMap<string, string>;
  readonly imageLocationByArtifact: ReadonlyMap<string, CurrentLocationRead>;
  readonly imageLocationByRevision: ReadonlyMap<string, CurrentLocationRead>;
} {
  const revisions = new Map(
    basis.artifactRevisions.map((revision) => [revision.id, revision]),
  );
  const currentByLocation = new Map(
    (basis.currentLocationRevisions ?? []).map((selection) => [
      selection.locationId,
      selection.revisionId,
    ]),
  );
  const blobs = new Map(basis.blobs.map((blob) => [blob.digest, blob]));
  const locations: CurrentLocationRead[] = basis.locations.map((location) => {
    // managed 位置的地址指向不可变内容；观察位置只能采用精确确认，不能猜历史修订。
    const candidates =
      location.kind === "managed"
        ? basis.artifactRevisions.filter(
            (revision) => revision.artifactId === location.artifactId,
          )
        : [];
    const revisionId =
      currentByLocation.get(location.id) ??
      (candidates.length === 1 ? candidates[0]?.id : undefined);
    const revision =
      revisionId === undefined ? undefined : revisions.get(revisionId);
    const confirmed =
      revision?.artifactId === location.artifactId ? revision : undefined;
    const byteLength =
      confirmed === undefined
        ? undefined
        : blobs.get(confirmed.blobDigest)?.byteLength;
    return {
      id: location.id,
      artifactId: location.artifactId,
      kind: location.kind,
      address: location.address,
      content:
        confirmed === undefined
          ? { status: "unconfirmed" }
          : {
              status: "confirmed",
              target: {
                kind: "artifact-revision",
                artifactId: location.artifactId,
                revisionId: confirmed.id,
              },
            },
      ...(byteLength === undefined ? {} : { byteLength }),
    };
  });
  // 图片角色只认已确认当前内容且 Blob 仍是图片的修订；人工选择冻结的修订必须与
  // 这一精确当前修订相同，同路径换过的字节不会继承旧选择。
  const currentImageRevisionByArtifact = new Map<string, string>();
  const imageLocationByArtifact = new Map<string, CurrentLocationRead>();
  const imageLocationByRevision = new Map<string, CurrentLocationRead>();
  for (const location of locations) {
    if (location.content.status !== "confirmed") continue;
    const revision = revisions.get(location.content.target.revisionId);
    const blob =
      revision === undefined ? undefined : blobs.get(revision.blobDigest);
    if (
      revision === undefined ||
      blob === undefined ||
      !blob.mediaType.startsWith("image/")
    )
      continue;
    if (!currentImageRevisionByArtifact.has(location.artifactId)) {
      currentImageRevisionByArtifact.set(location.artifactId, revision.id);
      imageLocationByArtifact.set(location.artifactId, location);
    }
    imageLocationByRevision.set(revision.id, location);
  }
  return {
    revisions,
    locations,
    currentImageRevisionByArtifact,
    imageLocationByArtifact,
    imageLocationByRevision,
  };
}

/** 人工可点名封面的候选：只有这一目标当前带精确图片修订依据的角色关联才合格。 */
export type ArtifactRoleCandidate = {
  readonly associationId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly locationId: string;
  readonly kind: "observed" | "managed";
  readonly address: string;
};

export function artifactRoleCandidates(
  basis: SubjectFactBasis,
  target: DescriptionTarget,
  role: string,
): readonly ArtifactRoleCandidate[] {
  const representatives = identityRepresentativeMap(basis);
  const { currentImageRevisionByArtifact, imageLocationByArtifact } =
    currentContentReads(basis);
  return basis.artifactAssociations
    .filter(
      (association) =>
        association.role === role &&
        descriptionTargetKey(
          projectEntityTarget(representatives, basis.id, association.target),
        ) === descriptionTargetKey(target),
    )
    .flatMap((association) => {
      const revisionId = currentImageRevisionByArtifact.get(
        association.artifactId,
      );
      const location = imageLocationByArtifact.get(association.artifactId);
      return revisionId === undefined || location === undefined
        ? []
        : [
            {
              associationId: association.id,
              artifactId: association.artifactId,
              revisionId,
              locationId: location.id,
              kind: location.kind,
              address: location.address,
            },
          ];
    })
    .toSorted((left, right) =>
      left.associationId.localeCompare(right.associationId),
    );
}

/** 当前读取和冻结预演共用此求值；来源语义及具体视图不进入此模块。 */
export function readEffectiveSubject(
  basis: SubjectFactBasis,
  configuration: MetadataPolicyConfiguration | undefined,
  metadataUsageContext = "asset.ordinary",
  requirement?: Pick<InformationRequirement, "metadata" | "artifactRoles">,
): EffectiveSubjectRead {
  const representatives = identityRepresentativeMap(basis);
  const projectTarget = (target: DescriptionTarget): DescriptionTarget =>
    projectEntityTarget(representatives, basis.id, target);
  const metadataAssertions = projectedMetadataAssertions(
    representatives,
    basis,
  );
  const originalAssertions = new Map(
    metadataAssertions.map((assertion, index) => [
      assertion,
      basis.metadata[index]!,
    ]),
  );
  const assertionReference = (assertion: MetadataAssertion) => {
    const { target, sourceSlot, sourceRecordIds } =
      originalAssertions.get(assertion) ?? assertion;
    return { target, sourceSlot, sourceRecordIds };
  };
  const associations = basis.artifactAssociations.map((association) => ({
    ...association,
    target: projectTarget(association.target),
  }));
  const relatedEntities = [
    ...new Map(
      (basis.currentRelatedEntities ?? []).map((entity) => {
        const id = representatives.get(entity.id) ?? entity.id;
        const representative = basis.currentRelatedEntities?.find(
          (candidate) => candidate.id === id,
        );
        return [id, { ...(representative ?? entity), id }];
      }),
    ).values(),
  ];
  const policies = metadataPoliciesForSubject(
    basis.id,
    basis.sourceAssociations,
    configuration,
    metadataUsageContext,
  );
  const {
    locations,
    currentImageRevisionByArtifact,
    imageLocationByArtifact,
    imageLocationByRevision,
  } = currentContentReads(basis);
  const currentRevisionTargets = locations.flatMap((location) =>
    location.content.status === "confirmed" ? [location.content.target] : [],
  );
  const targets = [
    ...new Map<string, DescriptionTarget>(
      [
        { kind: "entity" as const, entityId: basis.id },
        ...relatedEntities.map((entity) => ({
          kind: "entity" as const,
          entityId: entity.id,
        })),
        ...currentRevisionTargets,
      ].map((target) => [descriptionTargetKey(target), target]),
    ).values(),
  ];
  const descriptions = targets.map((target): EffectiveDescriptionRead => {
    const targetRequirement =
      target.kind === "entity" && target.entityId === basis.id
        ? requirement
        : undefined;
    const metadata = deriveEffectiveMetadata({
      target,
      metadataUsageContext,
      policies,
      sourceRecords: basis.metadataSourceRecords ?? [],
      metadata: metadataAssertions,
      metadataDecisions: projectedMetadataDecisions(
        identityRepresentativeMap(basis),
        basis,
      ),
    });
    const conflicts: FactReadConflict[] = metadata.conflicts.map(
      (conflict) => ({
        kind: conflict.kind,
        property: conflict.property,
        references: conflict.candidates.map(({ assertion }) => ({
          kind: "metadata",
          ...assertionReference(assertion),
        })),
        explanation: conflict.explanation,
      }),
    );
    const roles = [
      ...new Set([
        ...associations
          .filter(
            (association) =>
              descriptionTargetKey(association.target) ===
              descriptionTargetKey(target),
          )
          .map((association) => association.role),
        // 明确选择即使已失去当前支持也要继续裁决该角色，才能报告失效而不是无声消失。
        ...(basis.artifactRoleDecisions ?? [])
          .filter(
            (decision) =>
              decision.kind === "select" &&
              descriptionTargetKey(decision.target) ===
                descriptionTargetKey(target),
          )
          .map((decision) => decision.role),
      ]),
    ];
    const artifactRoles = roles.flatMap((role): EffectiveArtifactRoleRead[] => {
      // 材料是多值事实；图片角色采用共同的单值裁决，保留同等候选冲突。
      if (role === "asset.material-delivered") return [];
      if (
        role !== "asset.primary-cover" &&
        role !== "asset.material-image" &&
        targetRequirement?.artifactRoles.find((input) => input.role === role)
          ?.maximum !== 1
      ) {
        const byArtifact = new Map<string, ArtifactAssociation[]>();
        for (const association of associations.filter(
          (association) =>
            association.role === role &&
            descriptionTargetKey(association.target) ===
              descriptionTargetKey(target),
        )) {
          const current = byArtifact.get(association.artifactId) ?? [];
          current.push(association);
          byArtifact.set(association.artifactId, current);
        }
        return [...byArtifact].map(([artifactId, contributing]) => {
          const location = locations.find(
            (location) => location.artifactId === artifactId,
          );
          return {
            role,
            artifactId,
            associationIds: contributing.map((association) => association.id),
            ...observedArtifactParts(contributing),
            ...(location === undefined
              ? {}
              : { address: location.address, locationId: location.id }),
          };
        });
      }
      const rule = configuration?.artifactAssociationRules?.find(
        (item) =>
          item.usageContext === metadataUsageContext && item.role === role,
      );
      const decision = (basis.artifactRoleDecisions ?? []).find(
        (candidate) =>
          candidate.role === role &&
          descriptionTargetKey(candidate.target) ===
            descriptionTargetKey(target),
      );
      const currentImageRevisions = associations
        .filter(
          (association) =>
            association.role === role &&
            descriptionTargetKey(association.target) ===
              descriptionTargetKey(target),
        )
        .flatMap((association) => {
          const revisionId = currentImageRevisionByArtifact.get(
            association.artifactId,
          );
          return revisionId === undefined
            ? []
            : [{ associationId: association.id, revisionId }];
        });
      const result = deriveEffectiveArtifactAssociation({
        target,
        role,
        associations,
        sourceAssociations: basis.sourceAssociations,
        ...(decision === undefined ? {} : { decision, currentImageRevisions }),
        ...(rule === undefined
          ? {}
          : {
              preferredSourceIdentities: rule.preferredSourceIdentities,
              ...(rule.preferredCapabilityIds === undefined
                ? {}
                : { preferredCapabilityIds: rule.preferredCapabilityIds }),
            }),
      });
      if (result === undefined) return [];
      if ("kind" in result) {
        conflicts.push(
          result.kind === "artifact-role-decision-unusable"
            ? {
                kind: result.kind,
                role,
                references: [
                  {
                    kind: "artifact-role-decision",
                    decisionId: result.decisionId,
                  },
                  ...result.candidates.map((candidate) => ({
                    kind: "artifact-association" as const,
                    associationId: candidate.id,
                  })),
                ],
                explanation: "已选封面不再是当前内容，请重新选择或撤回",
              }
            : {
                kind: result.kind,
                role,
                references: result.candidates.map((candidate) => ({
                  kind: "artifact-association",
                  associationId: candidate.id,
                })),
                explanation: "当前图片存在多个同等合格的选择",
              },
        );
        return [];
      }
      // 可交付性只认这一精确当前修订；位置存在但未确认时保留产物与问题，地址为空。
      const location =
        result.selectedRevisionId === undefined
          ? imageLocationByArtifact.get(result.association.artifactId)
          : imageLocationByRevision.get(result.selectedRevisionId);
      if (location === undefined) {
        conflicts.push({
          kind: "artifact-role-content-unavailable",
          role,
          references: result.contributingAssociations.map((association) => ({
            kind: "artifact-association",
            associationId: association.id,
          })),
          explanation: "这项内容的封面有尚未确认的当前内容",
        });
        return [
          {
            role,
            artifactId: result.association.artifactId,
            associationIds: result.contributingAssociations.map(
              (association) => association.id,
            ),
            ...observedArtifactParts(result.contributingAssociations),
          },
        ];
      }
      return [
        {
          role,
          artifactId: result.association.artifactId,
          associationIds: result.contributingAssociations.map(
            (association) => association.id,
          ),
          ...observedArtifactParts(result.contributingAssociations),
          address: location.address,
          locationId: location.id,
        },
      ];
    });
    const values = metadata.values.map(
      ({
        property,
        value,
        qualifiers,
        sourceIdentity,
        sourceSlot,
        reasoning,
        contributingAssertions,
        sourceRecordIds,
      }) => ({
        property,
        value,
        sourceIdentity,
        sourceSlot,
        reasoning,
        sourceRecordIds,
        assertions: contributingAssertions.map(assertionReference),
        ...(qualifiers === undefined ? {} : { qualifiers }),
      }),
    );
    const properties = [
      ...new Set([
        ...values.map((value) => value.property),
        ...metadata.conflicts.map((conflict) => conflict.property),
        ...(targetRequirement?.metadata.flatMap(({ property }) =>
          property.includes("*") ? [] : [property],
        ) ?? []),
      ]),
    ];
    return {
      target,
      metadataUsageContext,
      metadata: properties.map((property) => {
        const selected = values.filter((value) => value.property === property);
        const conflict = conflicts.find(
          (conflict) => conflict.property === property,
        );
        return {
          property,
          result:
            conflict !== undefined
              ? { status: "conflict", conflict }
              : selected.length > 0
                ? { status: "resolved", values: selected }
                : { status: "missing" },
        };
      }),
      metadataScope:
        targetRequirement === undefined
          ? { kind: "all-available" }
          : {
              kind: "requested",
              selectors: targetRequirement.metadata.map(
                ({ property }) => property,
              ),
            },
      artifactRoles,
      missingArtifactRoles:
        targetRequirement?.artifactRoles.flatMap(({ role }) =>
          artifactRoles.some((result) => result.role === role) ||
          conflicts.some((conflict) => conflict.role === role)
            ? []
            : [role],
        ) ?? [],
      conflicts,
    };
  });
  return {
    id: basis.id,
    sourceAssociations: basis.sourceAssociations.map(
      ({ sourceIdentity, nativeAddress }) => ({
        sourceIdentity,
        nativeAddress,
      }),
    ),
    ...(basis.recognitionSourceAssociation === undefined
      ? {}
      : {
          recognitionSourceAssociation: {
            sourceIdentity: basis.recognitionSourceAssociation.sourceIdentity,
            nativeAddress: basis.recognitionSourceAssociation.nativeAddress,
          },
        }),
    descriptions,
    relatedEntities: relatedEntities.map(
      ({ id, kind, label, sourceIdentity, identityNamespace, sourceKey }) => ({
        id,
        kind,
        label,
        sourceIdentity,
        identityNamespace,
        sourceKey,
      }),
    ),
    relationships: effectiveRelationships(
      basis.relationships ?? [],
      basis.relationshipReadBasis,
    ).map(({ id, type, participants, qualifiers, sourceRecordIds }) => ({
      id,
      type,
      participants,
      sourceRecordIds,
      ...(qualifiers === undefined ? {} : { qualifiers }),
    })),
    locations,
  };
}

function observedArtifactParts(
  associations: readonly ArtifactAssociation[],
): Pick<EffectiveArtifactRoleRead, "observedArtifactParts"> {
  const parts = associations.flatMap(({ id, observedArtifactPart }) =>
    observedArtifactPart === undefined
      ? []
      : [{ associationId: id, ...observedArtifactPart }],
  );
  return parts.length === 0 ? {} : { observedArtifactParts: parts };
}

/**
 * 仅投影所选主体已报告的资料冲突候选。这里复用与共同读取完全相同的代表归一、策略选择
 * 与生效元数据规则，只取真正参与冲突的候选断言值及其来源身份和支持记录；普通读取刻意
 * 丢弃候选值，因此依据核对单独走这一只读接缝，绝不重新裁决，也不透传被排除的断言。
 */
export function subjectConflictEvidence(
  basis: SubjectFactBasis,
  configuration: MetadataPolicyConfiguration | undefined,
  metadataUsageContext = "asset.ordinary",
): readonly SubjectConflictEvidence[] {
  const { conflicts } = deriveEffectiveMetadata({
    target: { kind: "entity", entityId: basis.id },
    metadataUsageContext,
    policies: metadataPoliciesForSubject(
      basis.id,
      basis.sourceAssociations,
      configuration,
      metadataUsageContext,
    ),
    sourceRecords: basis.metadataSourceRecords ?? [],
    metadata: projectedMetadataAssertions(
      identityRepresentativeMap(basis),
      basis,
    ),
    metadataDecisions: projectedMetadataDecisions(
      identityRepresentativeMap(basis),
      basis,
    ),
  });
  return conflicts.map((conflict) => ({
    property: conflict.property,
    kind: conflict.kind,
    candidates: conflict.candidates.map(
      ({ value, sourceIdentity, sourceRecordIds }) => ({
        value,
        sourceIdentity,
        sourceRecordIds,
      }),
    ),
  }));
}

/**
 * 将所选主体的当前元数据与共同求值器报告的未采用值、冲突候选和缺失项一起投影。
 * 这个检查路径不会另行选择事实，也不会暴露未参与本次有效求值的断言。
 */
export function subjectMetadataEvidence(
  basis: SubjectFactBasis,
  configuration: MetadataPolicyConfiguration | undefined,
  metadataUsageContext = "asset.ordinary",
  requestedProperties: readonly string[] = [],
  target: DescriptionTarget = { kind: "entity", entityId: basis.id },
): readonly SubjectMetadataEvidence[] {
  const representatives = identityRepresentativeMap(basis);
  const assertions = projectedMetadataAssertions(representatives, basis);
  const originalAssertions = new Map(
    assertions.map((assertion, index) => [assertion, basis.metadata[index]!]),
  );
  const projection = deriveEffectiveMetadata({
    target,
    metadataUsageContext,
    policies: metadataPoliciesForSubject(
      basis.id,
      basis.sourceAssociations,
      configuration,
      metadataUsageContext,
    ),
    sourceRecords: basis.metadataSourceRecords ?? [],
    metadata: assertions,
    metadataDecisions: projectedMetadataDecisions(representatives, basis),
  });
  const assertionEvidence = (
    assertion: MetadataAssertion,
    sourceIdentity: string,
    exclusion?: import("@digital/domain").EffectiveMetadataAlternative["exclusion"],
  ): SubjectMetadataCandidateEvidence => {
    const original = originalAssertions.get(assertion) ?? assertion;
    return {
      target: original.target,
      property: original.property,
      value: original.value,
      sourceIdentity,
      sourceSlot: original.sourceSlot,
      sourceRecordIds: original.sourceRecordIds,
      ...(original.qualifiers === undefined
        ? {}
        : { qualifiers: original.qualifiers }),
      ...(exclusion === undefined ? {} : { exclusion }),
    };
  };
  const valuesByProperty = new Map<string, SelectedMetadataRead[]>();
  for (const value of projection.values) {
    const current = valuesByProperty.get(value.property) ?? [];
    current.push({
      property: value.property,
      value: value.value,
      sourceIdentity: value.sourceIdentity,
      sourceSlot: value.sourceSlot,
      reasoning: value.reasoning,
      sourceRecordIds: value.sourceRecordIds,
      assertions: value.contributingAssertions.map((assertion) => {
        const original = originalAssertions.get(assertion) ?? assertion;
        return {
          target: original.target,
          sourceSlot: original.sourceSlot,
          sourceRecordIds: original.sourceRecordIds,
        };
      }),
      ...(value.qualifiers === undefined
        ? {}
        : { qualifiers: value.qualifiers }),
    });
    valuesByProperty.set(value.property, current);
  }
  const conflictByProperty = new Map(
    projection.conflicts.map((conflict) => [conflict.property, conflict]),
  );
  const properties = [
    ...new Set([
      ...valuesByProperty.keys(),
      ...conflictByProperty.keys(),
      ...requestedProperties.filter(
        (property) => property.length > 0 && !property.includes("*"),
      ),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
  return properties.map((property) => {
    const conflict = conflictByProperty.get(property);
    if (conflict !== undefined) {
      return {
        property,
        result: {
          status: "conflict" as const,
          kind: conflict.kind,
          explanation: conflict.explanation,
          candidates: conflict.candidates.map(({ assertion, sourceIdentity }) =>
            assertionEvidence(assertion, sourceIdentity),
          ),
        },
      };
    }
    const values = valuesByProperty.get(property) ?? [];
    if (values.length === 0)
      return { property, result: { status: "missing" as const } };
    const notSelected = projection.values
      .filter((value) => value.property === property)
      .flatMap((value) =>
        value.alternatives.map((alternative) =>
          assertionEvidence(
            alternative.assertion,
            alternative.sourceIdentity,
            alternative.exclusion,
          ),
        ),
      )
      .filter(
        (candidate, index, candidates) =>
          candidates.findIndex(
            (other) =>
              other.sourceIdentity === candidate.sourceIdentity &&
              other.sourceSlot === candidate.sourceSlot &&
              other.value === candidate.value &&
              JSON.stringify(other.sourceRecordIds) ===
                JSON.stringify(candidate.sourceRecordIds),
          ) === index,
      );
    return {
      property,
      result: {
        status: "resolved" as const,
        values,
        notSelected,
      },
    };
  });
}
