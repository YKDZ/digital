import type {
  DescriptionTarget,
  MetadataAssertion,
  MetadataAssertionCandidate,
} from "./metadata-assertion.ts";

export * from "./effective-metadata.ts";
export * from "./effective-artifact-association.ts";
export * from "./metadata-assertion.ts";
export * from "./source-refresh-run.ts";

/** 开放词汇。角色属于关联，绝不属于产物。 */
export type ArtifactRole = string;

/** 用户对一个明确产物修订版的播放交互；绝不沿资产、关系或修订版继承。 */
export type AssetInteractionState = {
  readonly artifactRevisionId: string;
  readonly positionMilliseconds: number;
  readonly completed: boolean;
};

export type CapabilityCoordinate = {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly contractVersion: string;
  /** 当前静态声明中存在；只在保留的旧事实中缺失。 */
  readonly identity?: string;
  readonly implementationVersion?: string;
  /** 开放的 Application 契约值；领域绝不枚举能力种类。 */
  readonly kind?: string;
  readonly interpretationContractVersions?: readonly string[];
};

export type SourceRecord = {
  readonly id: string;
  readonly sourceIdentity: string;
  /** 来源主体的不透明规范地址，而不是端点 URL。 */
  readonly nativeAddress: string;
  readonly mediaType: string;
  readonly acquiredAt: string;
  readonly acquisition: {
    readonly requestedAddress: string;
    /** 有界来源请求方法；采集器绝不保留请求头。 */
    readonly method: "GET" | "POST";
    readonly authorized: boolean;
  };
  readonly coverage: {
    readonly id: string;
    /** 不完整记录可以建立正向事实，但绝不能建立缺失。 */
    readonly completeness: "complete" | "incomplete";
    readonly authority: "official";
  };
  readonly digest: string;
  readonly body: string;
  /** 捕获该不可变响应的采集器坐标。 */
  readonly producer?: CapabilityCoordinate;
};

export type RecognitionEvidence = {
  readonly kind: string;
  readonly explanation: string;
  /** 已经关联不透明来源原生地址时必需。 */
  readonly sourceIdentity?: string;
  readonly sourceAddress?: string;
  readonly producer: CapabilityCoordinate;
  /** 由格式产生的开放证据；领域不解释其词汇。 */
  readonly inspection?: {
    readonly identifiers: readonly {
      readonly scheme: string;
      readonly value: string;
      readonly locators: readonly [string, ...string[]];
    }[];
    readonly observedArtifactReference: string;
    readonly revision: Blob;
    readonly metadata: readonly {
      readonly property: string;
      readonly sourceSlot: string;
      readonly value: string;
      readonly locator: string;
    }[];
    readonly parts: readonly {
      readonly role: string;
      readonly locator: string;
      readonly mediaType: string;
    }[];
    /**
     * 格式能力明确解释的局部实体图。核心只保存中立的出现、角色和限定项，
     * 不认识任何格式自己的字段词汇。
     */
    readonly entityGraph?: ObservedEntityGraphCandidate;
  };
};

/**
 * 由一个格式检查结果提出的局部实体图。键只在这一批观察内有效；Application 在
 * 绑定资产、产物和精确修订版后才分配耐久标识。
 */
export type ObservedEntityGraphCandidate = {
  readonly observedArtifactReference: string;
  readonly producer: CapabilityCoordinate;
  readonly coverage: { readonly id: string; readonly completeness: "complete" };
  readonly entities: readonly {
    readonly key: string;
    readonly occurrenceSlot: string;
    readonly label: string;
    readonly preservedValue: string;
    readonly locator: string;
  }[];
  readonly mentions: readonly {
    readonly key: string;
    readonly entityKey: string;
    readonly sourceSlot: string;
    readonly field: string;
    readonly role: string;
    readonly label: string;
    readonly locator: string;
  }[];
  readonly resolutions: readonly {
    readonly mentionKey: string;
    readonly entityKey: string;
  }[];
  readonly relationships: readonly {
    readonly sourceSlot: string;
    readonly type: string;
    readonly subjectRole: string;
    readonly participants: readonly {
      readonly entityKey: string;
      readonly role: string;
      readonly mentionKeys: readonly string[];
    }[];
    readonly qualifiers: readonly {
      readonly key: string;
      readonly value: string;
    }[];
    readonly locator: string;
  }[];
};

/** 已绑定资产、产物及修订版的观察图信封；不代表外部来源记录。 */
export type AcceptedObservedEntityGraph = {
  readonly assetId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly producer: CapabilityCoordinate;
  readonly coverageId: string;
  readonly complete: true;
  readonly entities: readonly {
    readonly id: string;
    readonly occurrenceSlot: string;
    readonly label: string;
    readonly preservedValue: string;
    readonly locator: string;
  }[];
  readonly mentions: readonly {
    readonly id: string;
    readonly entityId: string;
    readonly sourceSlot: string;
    readonly field: string;
    readonly role: string;
    readonly label: string;
    readonly locator: string;
  }[];
  readonly resolutions: readonly {
    readonly mentionId: string;
    readonly entityId: string;
  }[];
  readonly relationships: readonly EntityRelationship[];
};

/** 对生命周期由其他位置持有的证据作出的类型化耐久引用。 */
export type RecognitionEvidenceReference = {
  readonly kind: "source-record";
  readonly sourceRecordId: string;
};

export type SourceArtifactCandidate = {
  readonly id: string;
  readonly sourceRecordId: string;
  /**
   * 本材料服务的同一提议中，一个由来源解析的实体。省略时刻意表示已接受数字资产，从而
   * 保留普通单主体识别路径。
   */
  readonly subjectId?: string;
  readonly role: ArtifactRole;
  readonly acquisitionReference: string;
  readonly mediaType: string;
  /** 候选选择证据只描述尚未获取的来源材料，绝不是数字资产元数据或已观察 Blob。 */
  readonly selectionEvidence?: {
    readonly suggestedFilename?: string;
    readonly declaredByteLength?: number;
    readonly sourceOrdinal?: number;
  };
  /** 公开该候选的解释器坐标。 */
  readonly producer?: CapabilityCoordinate;
};

/**
 * 属于一个观察产物的有界格式条目。它不是外部来源响应；只有经授权托管物化明确请求时，
 * 才会成为独立产物。
 */
export type ObservedArtifactPartCandidate = {
  readonly id: string;
  readonly role: ArtifactRole;
  /** 观察器范围内的不透明引用；领域绝不解析文件系统语法。 */
  readonly observedArtifactReference: string;
  readonly locator: string;
  readonly mediaType: string;
  /** 发现该有界本地部分的格式检查器。 */
  readonly producer: CapabilityCoordinate;
};

/** Application 物化父修订前的本地格式事实。 */
export type ObservedArtifactMetadataCandidate = {
  readonly property: string;
  readonly sourceSlot: string;
  readonly value: string;
  readonly observedArtifactReference: string;
  readonly locator: string;
  /** 推导该本地元数据断言的格式检查器。 */
  readonly producer: CapabilityCoordinate;
};

/**
 * 格式能力检查本地产物时观察到的内容指纹。它使 Application 能在请求封面等派生部分前
 * 建立父修订。
 */
export type ObservedArtifactRevisionCandidate = {
  readonly observedArtifactReference: string;
  readonly blob: Blob;
  /** 观察到该父内容指纹的格式检查器。 */
  readonly producer: CapabilityCoordinate;
};

/**
 * 一个精确来源出现。它刻意保留解释契约产生的拼写：身份解析绝不能通过裁剪、规范化或
 * 去重改写该证据。
 */
export type EntityMention = {
  readonly id: string;
  readonly sourceRecordIds: readonly string[];
  readonly sourceIdentity: string;
  readonly field: string;
  readonly role: string;
  readonly label: string;
  readonly identityNamespace: string;
  readonly sourceKey: string;
  readonly producer?: CapabilityCoordinate;
};

/** 一个来源出现的可审计确定性解析。 */
export type EntityResolutionDecision = {
  readonly id: string;
  readonly mentionId: string;
  readonly entityId: string;
  readonly rule: "source-field-role-exact" | "manual";
  readonly sourceRecordIds: readonly string[];
  readonly producer?: CapabilityCoordinate;
};

/** 插件中立解释；尚不是识别提议。 */
export type SourceInterpretationBatch = {
  readonly id: string;
  readonly producer: CapabilityCoordinate;
  readonly sourceRecordIds: readonly string[];
  readonly sourceIdentity: string;
  readonly sourceAddress: string;
  /**
   * 用于建立识别的来源记录，包括不描述所投影来源主体的记录。
   */
  readonly recognitionEvidenceReferences?: readonly RecognitionEvidenceReference[];
  readonly metadata: readonly MetadataAssertionCandidate[];
  readonly sourceArtifacts: readonly SourceArtifactCandidate[];
  /** 在任何来源范围解析前的精确署名／社团出现。 */
  readonly entityMentions?: readonly EntityMention[];
  /** 将指称解析为提议实体的明确决策。 */
  readonly entityResolutionDecisions?: readonly EntityResolutionDecision[];
  /** 一份解释提议的来源范围已解析身份。 */
  readonly entities?: readonly SourcedEntity[];
  /** 角色属于参与关系、绝不属于实体种类的贡献事实。 */
  readonly relationships?: readonly ProposedEntityRelationship[];
};

export type RecognitionRuleResult = {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly outcome: "satisfied" | "contradicted";
  readonly explanation: string;
  readonly evidence: readonly RecognitionEvidence[];
  readonly evidenceReferences?: readonly RecognitionEvidenceReference[];
};

/**
 * 识别器唯一可以贡献的解释。Application 持有已经绑定的来源解释批次、输入证据和本地
 * 格式事实，并在验证规则后把该草稿与这些输入结合。
 */
export type RecognitionProposalDraft = {
  readonly id: string;
  readonly ruleResults: readonly RecognitionRuleResult[];
};

export type RecognitionBasis =
  | {
      readonly kind: "manual-boundary";
      readonly proposedBy: string;
      readonly observationSnapshotId: string;
      /** 观察器范围内的不透明材料引用；核心不解释路径。 */
      readonly materialReferences: readonly string[];
      readonly revisesProposalIds: readonly string[];
      readonly metadata: readonly {
        readonly property: string;
        readonly value: string;
      }[];
      /** 文件检查事实与人的范围判断各自保留归属，不充当自动识别规则。 */
      readonly evidence: readonly RecognitionEvidence[];
    }
  | {
      readonly kind: "source-interpretation";
      readonly interpretation: SourceInterpretationBatch;
    }
  | {
      readonly kind: "observed-evidence";
      /** 产生所选观察事实的精确能力坐标。 */
      readonly producer: CapabilityCoordinate;
      readonly evidence: readonly RecognitionEvidence[];
      readonly artifactRevisions: readonly ObservedArtifactRevisionCandidate[];
    };

export type RecognitionProposal = {
  readonly id: string;
  readonly basis: RecognitionBasis;
  readonly ruleResults: readonly RecognitionRuleResult[];
  /** 本地物化计划与外部来源解释分离。 */
  readonly observedArtifactParts?: readonly ObservedArtifactPartCandidate[];
  /** 本地格式事实保留在外部来源解释之外。 */
  readonly observedMetadata?: readonly ObservedArtifactMetadataCandidate[];
  /** 本地检查事实的父修订独立于各部分。 */
  readonly observedArtifactRevisions?: readonly ObservedArtifactRevisionCandidate[];
  /** 人工材料提案把每个不透明观察引用固定投影为一个产物角色。 */
  readonly observedArtifactAssociations?: readonly ObservedArtifactAssociationCandidate[];
  /** 仅来自格式检查器的中立观察图候选。 */
  readonly observedEntityGraphs?: readonly ObservedEntityGraphCandidate[];
};

export type ObservedArtifactAssociationCandidate = {
  readonly observedArtifactReference: string;
  readonly role: ArtifactRole;
};

export type Entity = {
  readonly id: string;
  /** 当前可解释种类投影；身份本身不以此字段固定。 */
  readonly kind: "digital-asset" | "entity";
};

/** Core 拥有这套封闭词汇；提供方原生标签不得进入。 */
export type EntityKind = "digital-asset";

export type EntityKindAssertion = {
  readonly id: string;
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly basis: "source" | "manual" | "legacy-migration";
  readonly sourceRecordIds?: readonly string[];
  /** 人工断言保留明确操作者，自动断言保留产生它的能力。 */
  readonly actorId?: string;
  readonly producer?: CapabilityCoordinate;
};

export type EffectiveEntityKind =
  | { readonly status: "ordinary" }
  | {
      readonly status: "effective";
      readonly kind: EntityKind;
      readonly basis: "assertion";
    };

/** 当前已接受图中的相关实体；种类只能来自唯一的生效投影。 */
export type CurrentRelatedEntity = SourcedEntity & {
  readonly kind: EffectiveEntityKind;
};

/** 唯一种类投影规则：数字资产准入事实生效，否则为普通实体。 */
export function deriveEffectiveEntityKind(input: {
  readonly assertions: readonly EntityKindAssertion[];
}): EffectiveEntityKind {
  const [kind] = [
    ...new Set(input.assertions.map((assertion) => assertion.kind)),
  ];
  if (kind === undefined) return { status: "ordinary" };
  return { status: "effective", kind, basis: "assertion" };
}

export type DigitalAsset = Entity & {
  readonly kind: "digital-asset";
};

/** 只在精确来源命名空间内建立的普通实体；没有核心专门种类。 */
export type SourcedEntity = {
  readonly id: string;
  readonly sourceIdentity: string;
  readonly sourceKey: string;
  readonly identityNamespace: string;
  readonly label: string;
  readonly sourceRecordIds: readonly string[];
  readonly producer?: CapabilityCoordinate;
};

/** 一条关系事实中的具名实体参与。 */
export type EntityRelationshipParticipant = {
  readonly entityId: string;
  readonly role: string;
  /** 支持此参与的已解析来源出现；不成为图节点。 */
  readonly mentionIds?: readonly string[];
};

/** 一条可从每个具名参与者遍历的来源关系事实。 */
export type EntityRelationship = {
  readonly id: string;
  readonly participants: readonly EntityRelationshipParticipant[];
  /** 来源生命周期的明确所属实体；不是关系的二元主体。 */
  readonly sourceSubjectId?: string;
  /** 开放关系词汇；语义与约束属于证据／能力。 */
  readonly type: string;
  /** 一个覆盖 lineage 内的稳定来源契约槽位。 */
  readonly sourceSlot: string;
  readonly sourceRecordIds: readonly string[];
  readonly producer?: CapabilityCoordinate;
  /** 开放的来源范围上下文，例如署名角色名。 */
  readonly qualifiers?: readonly {
    readonly key: string;
    readonly value: string;
  }[];
};

/** 人工编写一项完整关系事实所需的有界草稿；它绝不携带来源坐标。 */
export type RelationshipDraft = {
  readonly type: string;
  readonly participants: readonly EntityRelationshipParticipant[];
  readonly qualifiers?: EntityRelationship["qualifiers"];
};

export type ProposedEntityRelationship = Omit<
  EntityRelationship,
  "id" | "participants"
> & {
  /** 已由解释器解析的具名参与者；产品在采用时补入当前数字资产参与者。 */
  readonly participants: readonly [
    EntityRelationshipParticipant,
    ...EntityRelationshipParticipant[],
  ];
  /** 当前采用的数字资产在该来源事实中的具名角色；省略表示参与者已经完整。 */
  readonly subjectRole?: string;
  /** 来源／扩展对该关系类型声明的最低参与角色。 */
  readonly requiredRoles?: readonly string[];
};

export {
  canonicalRelationshipDraft,
  deriveEffectiveRelationships,
  relationshipTargetKey,
  type EffectiveRelationshipInput,
  type RelationshipDecision,
  type RelationshipDecisionTarget,
} from "./effective-relationship.ts";
export {
  deriveEffectiveEntityIdentity,
  type EffectiveEntityIdentity,
  type EntityIdentityMerge,
  type EntityIdentityMergeRetraction,
} from "./effective-entity-identity.ts";

export type SourceAssociation = {
  readonly id: string;
  readonly subjectId: string;
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
};

export type EvidenceComparison = {
  readonly observed: readonly RecognitionEvidence[];
  readonly manual: readonly RecognitionEvidence[];
  readonly sourceCandidates: readonly {
    /** 私有执行内候选引用；公开投影只回传其不可逆值。 */
    readonly reference?: string;
    readonly outcome: "accepted" | "contradicted";
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
    readonly sourceRecordIds: readonly string[];
    readonly ruleResults: readonly RecognitionRuleResult[];
    readonly explanation: string;
  }[];
  readonly conflicts: readonly string[];
};

export type ProposalAuthor =
  | { readonly kind: "user"; readonly actorId: string }
  | { readonly kind: "capability"; readonly coordinate: CapabilityCoordinate };

export type DecisionAuthority =
  | { readonly kind: "user"; readonly actorId: string }
  | { readonly kind: "application-policy"; readonly policyCoordinate: string };

export type SourceAssociationChangeProposal =
  | {
      readonly id: string;
      readonly kind: "establish";
      readonly subjectId: string;
      readonly successor: SourceAssociation;
      readonly sourceRecordIds: readonly string[];
      readonly proposedBy: ProposalAuthor;
      readonly evidence: EvidenceComparison;
    }
  | {
      readonly id: string;
      readonly kind: "replace";
      readonly subjectId: string;
      readonly predecessorAssociationId: string;
      readonly successor: SourceAssociation;
      readonly sourceRecordIds: readonly string[];
      readonly proposedBy: ProposalAuthor;
      readonly evidence: EvidenceComparison;
    }
  | {
      readonly id: string;
      readonly kind: "retract";
      readonly subjectId: string;
      readonly predecessorAssociationId: string;
      readonly proposedBy: ProposalAuthor;
      readonly reason: string;
      readonly evidence: EvidenceComparison;
    };

export type SourceAssociationDecision = {
  readonly id: string;
  readonly proposalId: string;
  readonly subjectId: string;
  readonly decidedBy: DecisionAuthority;
};

export type SourceAssociationEstablishmentSupport = {
  readonly associationId: string;
  readonly establishedBy:
    | { readonly kind: "recognition-decision"; readonly decisionId: string }
    | {
        readonly kind: "source-association-decision";
        readonly decisionId: string;
      };
};

export type SourceAssociationSupersession = {
  readonly id: string;
  readonly predecessorAssociationId: string;
  readonly successorAssociationId: string;
  readonly authorizedBy:
    | {
        readonly kind: "source-association-decision";
        readonly decisionId: string;
      }
    | { readonly kind: "recognition-decision"; readonly decisionId: string };
};

export type SourceAssociationRetraction = {
  readonly id: string;
  readonly associationId: string;
  readonly authorizedBy:
    | {
        readonly kind: "source-association-decision";
        readonly decisionId: string;
      }
    | {
        readonly kind: "recognition-decision-supersession";
        readonly supersessionId: string;
      }
    | {
        readonly kind: "recognition-decision-retraction";
        readonly retractionId: string;
      };
};

export type RecognitionDecisionSupersession = {
  readonly id: string;
  readonly predecessorDecisionId: string;
  readonly successorDecisionId: string;
};

/**
 * 验证由身份取代授权的精确来源关联撤回。调用者必须提供完整不可变因果链，不能用裸
 * 后继决定代替取代事实。
 */
export function validateRecognitionSupersessionSourceRetraction(input: {
  readonly retraction: SourceAssociationRetraction;
  readonly association: SourceAssociation;
  readonly establishmentSupport: SourceAssociationEstablishmentSupport;
  readonly supersession: RecognitionDecisionSupersession;
  readonly predecessorDecision: RecognitionDecision;
  readonly successorDecision: RecognitionDecision;
  readonly successorProposal: RecognitionProposal;
  readonly alreadySuperseded?: boolean;
  readonly alreadyRetracted?: boolean;
}): SourceAssociationRetraction {
  const {
    retraction,
    association,
    establishmentSupport,
    supersession,
    predecessorDecision,
    successorDecision,
    successorProposal,
  } = input;
  if (
    retraction.authorizedBy.kind !== "recognition-decision-supersession" ||
    !retraction.id ||
    retraction.associationId !== association.id ||
    retraction.authorizedBy.supersessionId !== supersession.id ||
    establishmentSupport.associationId !== association.id ||
    establishmentSupport.establishedBy.kind !== "recognition-decision" ||
    establishmentSupport.establishedBy.decisionId !==
      supersession.predecessorDecisionId ||
    predecessorDecision.id !== supersession.predecessorDecisionId ||
    successorDecision.id !== supersession.successorDecisionId ||
    predecessorDecision.id === successorDecision.id ||
    predecessorDecision.assetId !== association.subjectId ||
    successorDecision.assetId !== association.subjectId ||
    successorDecision.proposalId !== successorProposal.id ||
    recognitionSourceInterpretation(successorProposal) !== undefined ||
    input.alreadySuperseded === true ||
    input.alreadyRetracted === true
  )
    throw new Error(
      "Recognition Supersession cannot authorize this Source Association retraction",
    );
  return retraction;
}

export type RecognitionDecisionRetractionIntent = {
  readonly predecessorDecisionId: string;
  readonly proposedBy: string;
  readonly reason: string;
};

export type RecognitionDecisionRetraction =
  RecognitionDecisionRetractionIntent & {
    readonly id: string;
    readonly decidedBy: string;
  };

export function validateSourceAssociationChange(input: {
  readonly proposal: SourceAssociationChangeProposal;
  readonly decision?: SourceAssociationDecision;
  readonly predecessor?: SourceAssociation;
}): SourceAssociationChangeProposal {
  const { proposal, decision, predecessor } = input;
  if (
    !proposal.id ||
    !proposal.subjectId ||
    (decision !== undefined &&
      (decision.proposalId !== proposal.id ||
        decision.subjectId !== proposal.subjectId ||
        !decision.id))
  )
    throw new Error("Source Association decision does not accept its proposal");
  if (
    (proposal.proposedBy.kind === "user" && !proposal.proposedBy.actorId) ||
    (proposal.proposedBy.kind === "capability" &&
      (!proposal.proposedBy.coordinate.capabilityId ||
        !proposal.proposedBy.coordinate.capabilityVersion ||
        !proposal.proposedBy.coordinate.contractVersion)) ||
    (decision !== undefined &&
      ((decision.decidedBy.kind === "user" && !decision.decidedBy.actorId) ||
        (decision.decidedBy.kind === "application-policy" &&
          !decision.decidedBy.policyCoordinate)))
  )
    throw new Error("Source Association authorship must be attributable");
  if (proposal.kind === "establish") {
    if (predecessor !== undefined)
      throw new Error("Source Association establishment has no predecessor");
  } else {
    if (
      predecessor === undefined ||
      predecessor.id !== proposal.predecessorAssociationId ||
      predecessor.subjectId !== proposal.subjectId
    )
      throw new Error("Source Association predecessor is invalid");
  }
  if (proposal.kind !== "retract") {
    if (
      proposal.successor.subjectId !== proposal.subjectId ||
      !proposal.successor.id ||
      !proposal.successor.sourceIdentity ||
      !proposal.successor.nativeAddress
    )
      throw new Error("Source Association successor is invalid");
    if (
      proposal.kind === "replace" &&
      (proposal.successor.sourceIdentity !== predecessor!.sourceIdentity ||
        proposal.successor.nativeAddress === predecessor!.nativeAddress)
    )
      throw new Error(
        "Source Association replacement must change one address within its source",
      );
  } else if (!proposal.reason) {
    throw new Error("Source Association retraction requires a reason");
  }
  return proposal;
}

export type RecognitionDecision = {
  readonly id: string;
  readonly proposalId: string;
  readonly assetId: string;
  readonly acceptedRuleResults: readonly RecognitionRuleResult[];
};

export type Artifact = {
  readonly id: string;
};

export type Location = {
  readonly id: string;
  readonly artifactId: string;
  readonly address: string;
  readonly kind: "observed" | "managed";
};

export type Blob = {
  readonly digest: string;
  readonly mediaType: string;
  readonly byteLength: number;
};

export type ArtifactRevision = {
  readonly id: string;
  readonly artifactId: string;
  readonly blobDigest: string;
  /** 获取该修订所表示字节的能力。 */
  readonly producer?: CapabilityCoordinate;
};

export type ArtifactAssociation = {
  readonly id: string;
  readonly target: DescriptionTarget;
  readonly artifactId: string;
  readonly role: ArtifactRole;
  /** 本地声明关联中为空；来源持有事实中填充。 */
  readonly sourceRecordIds?: readonly string[];
  /** 持有一个托管来源产物的精确当前来源关联。 */
  readonly sourceAssociationId?: string;
  /** 建立来源持有关联的解释能力。 */
  readonly producer?: CapabilityCoordinate;
  /** 本地容器来源；区别于外部来源记录。 */
  readonly observedArtifactPart?: {
    readonly artifactId: string;
    readonly revisionId: string;
    readonly locator: string;
  };
};

/** 一个识别决定对一条产物关联的不可变、多对多支持。 */
export type ArtifactAssociationRecognitionSupport = {
  readonly associationId: string;
  readonly recognitionDecisionId: string;
};

/** 一份被选择的完整材料到其全部耐久事实的显式投影。 */
export type ObservedMaterialAssociationProjection = {
  readonly observedArtifactReference: string;
  readonly artifactId: string;
  readonly locationId: string;
  readonly revisionId: string;
  readonly associationId: string;
};

export type ObservedMaterialAssociationAudit = {
  readonly association: ArtifactAssociation;
  readonly supports: readonly {
    readonly support: ArtifactAssociationRecognitionSupport;
    readonly decision: RecognitionDecision;
    readonly proposal: RecognitionProposal;
    readonly projection: ObservedMaterialAssociationProjection;
    readonly location: Location;
    readonly revision: ArtifactRevision;
    readonly blob: Blob;
  }[];
};

export function validateObservedMaterialAssociationAudit(
  audit: ObservedMaterialAssociationAudit,
): ObservedMaterialAssociationAudit {
  if (audit.supports.length === 0)
    throw new Error("Artifact Association has no valid decision support");
  for (const item of audit.supports) {
    const candidates = item.proposal.observedArtifactAssociations ?? [];
    if (
      item.support.associationId !== audit.association.id ||
      item.support.recognitionDecisionId !== item.decision.id ||
      audit.association.target.kind !== "entity" ||
      item.decision.assetId !== audit.association.target.entityId ||
      item.decision.proposalId !== item.proposal.id ||
      item.projection.associationId !== audit.association.id ||
      item.projection.artifactId !== audit.association.artifactId ||
      item.location.id !== item.projection.locationId ||
      item.location.artifactId !== item.projection.artifactId ||
      item.revision.id !== item.projection.revisionId ||
      item.revision.artifactId !== item.projection.artifactId ||
      item.revision.blobDigest !== item.blob.digest ||
      !candidates.some(
        (candidate) =>
          candidate.observedArtifactReference ===
            item.projection.observedArtifactReference &&
          candidate.role === audit.association.role,
      )
    )
      throw new Error("Artifact Association decision support chain is invalid");
  }
  return audit;
}

/** 给既有数字资产补充观察材料时提交的完整领域事实批次。 */
export type ObservedMaterialAssociationSubmission = {
  readonly proposal: RecognitionProposal;
  readonly recognitionDecision: RecognitionDecision;
  readonly artifacts: readonly Artifact[];
  readonly locations: readonly Location[];
  readonly blobs: readonly Blob[];
  readonly artifactRevisions: readonly ArtifactRevision[];
  readonly artifactAssociations: readonly ArtifactAssociation[];
  readonly projections: readonly ObservedMaterialAssociationProjection[];
  readonly supports: readonly ArtifactAssociationRecognitionSupport[];
};

export function validateObservedMaterialAssociationSubmission(
  submission: ObservedMaterialAssociationSubmission,
  context?: {
    readonly knownDecisions?: readonly RecognitionDecision[];
    readonly additionalSupports?: readonly ArtifactAssociationRecognitionSupport[];
  },
): ObservedMaterialAssociationSubmission {
  const proposal = validateRecognitionProposal(submission.proposal);
  if (proposal.basis.kind !== "manual-boundary")
    throw new Error("Observed material proposal must use a manual boundary");
  const basis = proposal.basis;
  const candidates = proposal.observedArtifactAssociations ?? [];
  const revisions = proposal.observedArtifactRevisions ?? [];
  if (
    basis.metadata.length !== 0 ||
    basis.revisesProposalIds.length !== 0 ||
    proposal.ruleResults.length !== 0 ||
    candidates.length !== basis.materialReferences.length ||
    revisions.length !== basis.materialReferences.length ||
    candidates.some(
      (candidate) =>
        candidate.role !== "asset.material-delivered" ||
        !basis.materialReferences.includes(candidate.observedArtifactReference),
    ) ||
    revisions.some(
      (revision) =>
        !basis.materialReferences.includes(revision.observedArtifactReference),
    ) ||
    new Set(candidates.map((candidate) => candidate.observedArtifactReference))
      .size !== candidates.length ||
    new Set(revisions.map((revision) => revision.observedArtifactReference))
      .size !== revisions.length
  ) {
    throw new Error(
      "Observed material proposal must completely project selected whole materials",
    );
  }
  const decision = submission.recognitionDecision;
  if (
    !decision.id ||
    decision.proposalId !== proposal.id ||
    !decision.assetId ||
    decision.acceptedRuleResults.length !== 0
  )
    throw new Error(
      "Observed material decision must accept the target proposal",
    );

  const artifactIds = new Set(
    submission.artifacts.map((artifact) => artifact.id),
  );
  const associationIds = new Set(
    submission.artifactAssociations.map((association) => association.id),
  );
  const locations = new Map(
    submission.locations.map((location) => [location.id, location]),
  );
  const artifactRevisions = new Map(
    submission.artifactRevisions.map((revision) => [revision.id, revision]),
  );
  const associations = new Map(
    submission.artifactAssociations.map((association) => [
      association.id,
      association,
    ]),
  );
  const revisionsByReference = new Map(
    revisions.map((revision) => [revision.observedArtifactReference, revision]),
  );
  const projectionReferences = new Set(
    submission.projections.map(
      (projection) => projection.observedArtifactReference,
    ),
  );
  if (
    artifactIds.size !== submission.artifacts.length ||
    submission.projections.length !== candidates.length ||
    projectionReferences.size !== candidates.length ||
    candidates.some(
      (candidate) =>
        !projectionReferences.has(candidate.observedArtifactReference),
    ) ||
    submission.projections.some((projection) => {
      const revisionCandidate = revisionsByReference.get(
        projection.observedArtifactReference,
      );
      const location = locations.get(projection.locationId);
      const revision = artifactRevisions.get(projection.revisionId);
      const association = associations.get(projection.associationId);
      return (
        revisionCandidate === undefined ||
        location?.artifactId !== projection.artifactId ||
        revision?.artifactId !== projection.artifactId ||
        revision.blobDigest !== revisionCandidate.blob.digest ||
        association?.artifactId !== projection.artifactId ||
        association.target.kind !== "entity" ||
        association.target.entityId !== decision.assetId ||
        association.role !== "asset.material-delivered"
      );
    }) ||
    new Set(submission.projections.map((item) => item.artifactId)).size !==
      artifactIds.size ||
    new Set(submission.projections.map((item) => item.locationId)).size !==
      locations.size ||
    new Set(submission.projections.map((item) => item.revisionId)).size !==
      artifactRevisions.size ||
    new Set(submission.projections.map((item) => item.associationId)).size !==
      associationIds.size ||
    submission.artifactAssociations.some(
      (association) =>
        !association.id ||
        association.target.kind !== "entity" ||
        association.target.entityId !== decision.assetId ||
        association.role !== "asset.material-delivered" ||
        !artifactIds.has(association.artifactId) ||
        association.sourceAssociationId !== undefined ||
        association.sourceRecordIds?.length,
    ) ||
    associationIds.size !== submission.artifactAssociations.length
  )
    throw new Error("Observed material associations must belong to one target");

  const decisions = new Map(
    [decision, ...(context?.knownDecisions ?? [])].map((item) => [
      item.id,
      item,
    ]),
  );
  const supports = [
    ...submission.supports,
    ...(context?.additionalSupports ?? []),
  ];
  if (
    submission.artifactAssociations.some(
      (association) =>
        !submission.supports.some(
          (support) =>
            support.associationId === association.id &&
            support.recognitionDecisionId === decision.id,
        ),
    ) ||
    supports.some((support) => {
      const supportedDecision = decisions.get(support.recognitionDecisionId);
      return (
        !associationIds.has(support.associationId) ||
        supportedDecision === undefined ||
        supportedDecision.assetId !== decision.assetId ||
        (support.recognitionDecisionId === decision.id &&
          supportedDecision.proposalId !== proposal.id)
      );
    }) ||
    new Set(
      supports.map(
        (support) =>
          `${support.associationId}\u0000${support.recognitionDecisionId}`,
      ),
    ).size !== supports.length
  )
    throw new Error(
      "Observed material decision support is incomplete or invalid",
    );

  const blobDigests = new Set(submission.blobs.map((blob) => blob.digest));
  if (
    blobDigests.size !== submission.blobs.length ||
    new Set(submission.artifactRevisions.map((revision) => revision.blobDigest))
      .size !== blobDigests.size ||
    submission.blobs.some(
      (blob) =>
        !submission.artifactRevisions.some(
          (revision) => revision.blobDigest === blob.digest,
        ),
    ) ||
    submission.locations.some(
      (location) => !artifactIds.has(location.artifactId),
    ) ||
    submission.artifactRevisions.some(
      (revision) =>
        !artifactIds.has(revision.artifactId) ||
        !blobDigests.has(revision.blobDigest),
    )
  )
    throw new Error("Observed material facts contain dangling references");
  return submission;
}

/**
 * 对来源持有产物关联作出的不可变终止。它由重新求值提议及使原关联缺失的完整来源记录
 * 提供依据；绝不改作原先支持该关联的早期识别决策。
 */
export type ArtifactAssociationRetraction = {
  readonly id: string;
  readonly associationId: string;
  readonly proposalId: string;
  readonly sourceRecordIds: readonly string[];
};

/**
 * 接受一个提议所建立的完整不可变事实集；在一个由 Application 持有的条件事务中提交。
 */
export type AcceptedRecognition = {
  readonly proposal: RecognitionProposal;
  readonly entity: DigitalAsset;
  /** 真实且当前的全部来源关联；本地识别的正常初始值为空数组。 */
  readonly sourceAssociations: readonly SourceAssociation[];
  /** 只有来源解释依据才建立这条准入来源关联。 */
  readonly recognitionSourceAssociation?: SourceAssociation;
  readonly recognitionDecision: RecognitionDecision;
  readonly artifacts: readonly Artifact[];
  readonly locations: readonly Location[];
  readonly blobs: readonly Blob[];
  readonly artifactRevisions: readonly ArtifactRevision[];
  readonly artifactAssociations: readonly ArtifactAssociation[];
  readonly metadata: readonly MetadataAssertion[];
  readonly entities?: readonly SourcedEntity[];
  readonly entityMentions?: readonly EntityMention[];
  readonly entityResolutionDecisions?: readonly EntityResolutionDecision[];
  readonly relationships?: readonly EntityRelationship[];
  /** 不依赖 SourceRecord 的本地格式实体图支持。 */
  readonly observedEntityGraphs?: readonly AcceptedObservedEntityGraph[];
};

export function validateObservedEntityGraphCandidates(
  graphs: readonly ObservedEntityGraphCandidate[],
): void {
  for (const graph of graphs) {
    const entityKeys = new Set(graph.entities.map((entity) => entity.key));
    const mentionKeys = new Set(graph.mentions.map((mention) => mention.key));
    if (
      !graph.observedArtifactReference ||
      !graph.coverage.id ||
      graph.coverage.completeness !== "complete" ||
      !graph.producer.capabilityId ||
      !graph.producer.capabilityVersion ||
      !graph.producer.contractVersion ||
      entityKeys.size !== graph.entities.length ||
      mentionKeys.size !== graph.mentions.length ||
      graph.entities.some(
        (entity) =>
          !entity.key ||
          !entity.occurrenceSlot ||
          !entity.label ||
          !entity.preservedValue ||
          !entity.locator,
      ) ||
      graph.mentions.some(
        (mention) =>
          !mention.key ||
          !entityKeys.has(mention.entityKey) ||
          !mention.sourceSlot ||
          !mention.field ||
          !mention.role ||
          !mention.label ||
          !mention.locator,
      ) ||
      graph.resolutions.some(
        (resolution) =>
          !mentionKeys.has(resolution.mentionKey) ||
          !entityKeys.has(resolution.entityKey),
      ) ||
      graph.relationships.some(
        (relationship) =>
          !relationship.sourceSlot ||
          !relationship.type ||
          !relationship.subjectRole ||
          !relationship.locator ||
          relationship.participants.length === 0 ||
          relationship.participants.some(
            (participant) =>
              !entityKeys.has(participant.entityKey) ||
              !participant.role ||
              participant.mentionKeys.length === 0 ||
              !participant.mentionKeys.every((key) => mentionKeys.has(key)),
          ) ||
          new Set(
            relationship.participants.map(
              (participant) =>
                `${participant.entityKey}\u0000${participant.role}`,
            ),
          ).size !== relationship.participants.length ||
          relationship.qualifiers.some(
            (qualifier) => !qualifier.key || !qualifier.value,
          ),
      )
    )
      throw new Error("Observed entity graph candidate is invalid");
  }
}

export function validateRecognitionProposal(
  proposal: RecognitionProposal,
): RecognitionProposal {
  validateObservedEntityGraphCandidates(proposal.observedEntityGraphs ?? []);
  if (proposal.basis.kind === "manual-boundary") {
    const basis = proposal.basis;
    if (
      !basis.proposedBy.trim() ||
      !basis.observationSnapshotId ||
      !basis.materialReferences.length ||
      basis.materialReferences.some((reference) => !reference) ||
      new Set(basis.materialReferences).size !==
        basis.materialReferences.length ||
      basis.revisesProposalIds.some(
        (reference) => !reference || reference === proposal.id,
      ) ||
      new Set(basis.revisesProposalIds).size !==
        basis.revisesProposalIds.length ||
      basis.metadata.some(
        (assertion) => !assertion.property || !assertion.value.trim(),
      ) ||
      new Set(basis.metadata.map((assertion) => assertion.property)).size !==
        basis.metadata.length ||
      basis.evidence.some(
        (evidence) =>
          evidence.inspection === undefined ||
          !basis.materialReferences.includes(
            evidence.inspection.observedArtifactReference,
          ) ||
          !evidence.producer.capabilityId ||
          !evidence.producer.capabilityVersion ||
          !evidence.producer.contractVersion,
      ) ||
      proposal.ruleResults.length !== 0
    )
      throw new Error(
        "人工范围提案必须保留明确材料、判断归属和修订来源，不能伪造规则结果",
      );
    return proposal;
  }
  if (proposal.ruleResults.length === 0) {
    throw new Error("Recognition Proposal requires Recognition Rule Results");
  }
  if (proposal.basis.kind === "source-interpretation") {
    assertExactKeys(
      proposal.basis,
      ["kind", "interpretation"],
      "Recognition source basis",
    );
    const interpretation = proposal.basis.interpretation;
    if (interpretation.sourceRecordIds.length === 0) {
      throw new Error("Recognition Proposal requires Source Record references");
    }
    validateSourceInterpretationBatch(interpretation);
    const interpretationEvidence = new Set(
      (interpretation.recognitionEvidenceReferences ?? []).map(
        recognitionEvidenceReferenceKey,
      ),
    );
    for (const result of proposal.ruleResults) {
      for (const reference of result.evidenceReferences ?? []) {
        if (
          !interpretationEvidence.has(
            recognitionEvidenceReferenceKey(reference),
          )
        )
          throw new Error(
            "Recognition Rule Result references evidence outside its interpretation",
          );
      }
    }
    return proposal;
  }
  assertExactKeys(
    proposal.basis,
    ["kind", "producer", "evidence", "artifactRevisions"],
    "Recognition observed basis",
  );
  validateObservedRecognitionBasis(proposal.basis, proposal.ruleResults);
  return proposal;
}

/** 来源能力与本地观察能力的分支只在领域查询函数中暴露。 */
export function recognitionSourceInterpretation(
  proposal: RecognitionProposal,
): SourceInterpretationBatch | undefined {
  return proposal.basis.kind === "source-interpretation"
    ? proposal.basis.interpretation
    : undefined;
}

export function recognitionObservedEvidence(
  proposal: RecognitionProposal,
):
  | Extract<RecognitionBasis, { readonly kind: "observed-evidence" }>
  | undefined {
  return proposal.basis.kind === "observed-evidence"
    ? proposal.basis
    : undefined;
}

function validateObservedRecognitionBasis(
  basis: Extract<RecognitionBasis, { readonly kind: "observed-evidence" }>,
  ruleResults: readonly RecognitionRuleResult[],
): void {
  if (
    basis.producer.capabilityId.length === 0 ||
    basis.producer.capabilityVersion.length === 0 ||
    basis.producer.contractVersion.length === 0 ||
    basis.evidence.length === 0 ||
    basis.artifactRevisions.length === 0
  ) {
    throw new Error(
      "Observed recognition basis requires selected evidence and revisions",
    );
  }
  const producer = canonicalJson(basis.producer);
  const revisions = new Map<string, ObservedArtifactRevisionCandidate>();
  for (const revision of basis.artifactRevisions) {
    if (
      revision.observedArtifactReference.length === 0 ||
      canonicalJson(revision.producer) !== producer ||
      revision.blob.digest.length === 0 ||
      revision.blob.mediaType.length === 0 ||
      !Number.isSafeInteger(revision.blob.byteLength) ||
      revision.blob.byteLength < 0 ||
      revisions.has(revision.observedArtifactReference)
    ) {
      throw new Error(
        "Observed recognition revision is invalid or cross-capability",
      );
    }
    revisions.set(revision.observedArtifactReference, revision);
  }
  const selected = new Set<string>();
  for (const evidence of basis.evidence) {
    const inspection = evidence.inspection;
    const revision =
      inspection === undefined
        ? undefined
        : revisions.get(inspection.observedArtifactReference);
    const key = canonicalJson(evidence);
    if (
      canonicalJson(evidence.producer) !== producer ||
      inspection === undefined ||
      revision === undefined ||
      canonicalJson(inspection.revision) !== canonicalJson(revision.blob) ||
      selected.has(key)
    ) {
      throw new Error(
        "Observed recognition evidence is invalid or cross-input",
      );
    }
    for (const identifier of inspection.identifiers) {
      const locators = identifier.locators;
      if (
        !Array.isArray(locators) ||
        locators.length === 0 ||
        locators.some(
          (locator) => typeof locator !== "string" || locator.trim() === "",
        ) ||
        new Set(locators).size !== locators.length
      )
        throw new Error(
          "Observed recognition identifier requires unique non-empty locators",
        );
    }
    selected.add(key);
  }
  const referenced = new Set<string>();
  for (const result of ruleResults) {
    if (result.evidence.length === 0)
      throw new Error(
        "Observed Recognition Rule Result requires selected evidence",
      );
    for (const evidence of result.evidence) {
      const key = canonicalJson(evidence);
      if (!selected.has(key))
        throw new Error(
          "Recognition Rule Result references evidence outside its observed input",
        );
      referenced.add(key);
    }
    if ((result.evidenceReferences ?? []).length > 0)
      throw new Error("Observed recognition cannot reference Source Records");
  }
  if (referenced.size !== selected.size)
    throw new Error(
      "Observed recognition basis contains unreferenced evidence",
    );
}

function assertExactKeys(
  value: object,
  keys: readonly string[],
  label: string,
): void {
  if (
    canonicalJson(Object.keys(value).toSorted()) !==
    canonicalJson([...keys].toSorted())
  )
    throw new Error(`${label} mixes incompatible fields`);
}

/**
 * 在 Application 授权任何效果前验证每项解释器贡献。这里刻意使用单一批次边界：畸形
 * 署名、来源链接、关系或产物候选不能让表面可用投影的其余部分被提交。
 */
export function validateSourceInterpretationBatch(
  batch: SourceInterpretationBatch,
): SourceInterpretationBatch {
  const knownSources = new Set(batch.sourceRecordIds);
  const hasProvenance = (ids: readonly string[]) =>
    ids.length > 0 && ids.every((id) => knownSources.has(id));
  const recognitionEvidence = new Set<string>();
  for (const reference of batch.recognitionEvidenceReferences ?? []) {
    const key = recognitionEvidenceReferenceKey(reference);
    if (reference.sourceRecordId.length === 0 || recognitionEvidence.has(key))
      throw new Error("Recognition evidence reference is invalid");
    recognitionEvidence.add(key);
  }
  if (
    batch.sourceIdentity.length === 0 ||
    batch.sourceAddress.length === 0 ||
    batch.producer.capabilityId.length === 0 ||
    batch.producer.capabilityVersion.length === 0 ||
    batch.producer.contractVersion.length === 0 ||
    !hasProvenance(batch.sourceRecordIds)
  ) {
    throw new Error(
      "Source Interpretation Batch has an invalid identity contract",
    );
  }
  const metadataSlots = new Set<string>();
  for (const assertion of batch.metadata) {
    if (
      assertion.property.length === 0 ||
      assertion.sourceSlot.length === 0 ||
      metadataSlots.has(assertion.sourceSlot) ||
      !hasProvenance(assertion.sourceRecordIds)
    ) {
      throw new Error("Metadata Assertion requires interpretation provenance");
    }
    for (const qualifier of assertion.qualifiers ?? []) {
      if (qualifier.key.length === 0 || qualifier.value.length === 0)
        throw new Error("Metadata Assertion qualifier is invalid");
    }
    metadataSlots.add(assertion.sourceSlot);
  }
  const candidates = new Set<string>();
  for (const candidate of batch.sourceArtifacts) {
    const selectionEvidence = candidate.selectionEvidence;
    if (
      candidate.id.length === 0 ||
      candidate.role.length === 0 ||
      candidate.acquisitionReference.length === 0 ||
      candidate.mediaType.length === 0 ||
      !knownSources.has(candidate.sourceRecordId) ||
      candidates.has(candidate.id)
    ) {
      throw new Error(
        "Source Artifact Candidate is invalid or lacks provenance",
      );
    }
    if (
      selectionEvidence !== undefined &&
      (Object.keys(selectionEvidence).some(
        (key) =>
          key !== "suggestedFilename" &&
          key !== "declaredByteLength" &&
          key !== "sourceOrdinal",
      ) ||
        (selectionEvidence.suggestedFilename !== undefined &&
          selectionEvidence.suggestedFilename.trim().length === 0) ||
        (selectionEvidence.declaredByteLength !== undefined &&
          (!Number.isSafeInteger(selectionEvidence.declaredByteLength) ||
            selectionEvidence.declaredByteLength < 0)) ||
        (selectionEvidence.sourceOrdinal !== undefined &&
          (!Number.isSafeInteger(selectionEvidence.sourceOrdinal) ||
            selectionEvidence.sourceOrdinal < 0)))
    ) {
      throw new Error(
        "Source Artifact Candidate selection evidence is invalid",
      );
    }
    candidates.add(candidate.id);
  }
  const entityIds = new Set<string>();
  for (const entity of batch.entities ?? []) {
    if (
      entityIds.has(entity.id) ||
      entity.sourceIdentity !== batch.sourceIdentity ||
      entity.identityNamespace.length === 0 ||
      entity.sourceKey.length === 0 ||
      entity.label.length === 0 ||
      !hasProvenance(entity.sourceRecordIds)
    ) {
      throw new Error(
        "Sourced Entity has an invalid identity namespace or provenance",
      );
    }
    entityIds.add(entity.id);
  }
  for (const assertion of batch.metadata) {
    if (
      assertion.subjectId !== undefined &&
      !entityIds.has(assertion.subjectId)
    ) {
      throw new Error(
        "Metadata Assertion target must be a sourced resolved Entity in its proposal",
      );
    }
  }
  for (const candidate of batch.sourceArtifacts) {
    if (
      candidate.subjectId !== undefined &&
      !(batch.entities ?? []).some(
        (entity) =>
          entity.id === candidate.subjectId &&
          entity.sourceRecordIds.includes(candidate.sourceRecordId),
      )
    ) {
      throw new Error(
        "Source Artifact Candidate target must be a sourced resolved Entity in its proposal",
      );
    }
  }
  const mentionIds = new Set<string>();
  for (const mention of batch.entityMentions ?? []) {
    if (
      mentionIds.has(mention.id) ||
      mention.sourceIdentity !== batch.sourceIdentity ||
      mention.field.length === 0 ||
      mention.role.length === 0 ||
      mention.label.length === 0 ||
      mention.identityNamespace.length === 0 ||
      mention.sourceKey.length === 0 ||
      !hasProvenance(mention.sourceRecordIds)
    ) {
      throw new Error(
        "Entity Mention is invalid or lacks exact source provenance",
      );
    }
    mentionIds.add(mention.id);
  }
  const decidedMentions = new Set<string>();
  for (const decision of batch.entityResolutionDecisions ?? []) {
    if (
      decision.rule !== "source-field-role-exact" ||
      decidedMentions.has(decision.mentionId) ||
      !mentionIds.has(decision.mentionId) ||
      !entityIds.has(decision.entityId) ||
      !hasProvenance(decision.sourceRecordIds)
    ) {
      throw new Error("Entity Resolution Decision is invalid");
    }
    decidedMentions.add(decision.mentionId);
  }
  const relationshipSlots = new Set<string>();
  for (const relationship of batch.relationships ?? []) {
    if (
      relationship.type.length === 0 ||
      relationship.sourceSlot.length === 0 ||
      relationshipSlots.has(relationship.sourceSlot) ||
      !hasProvenance(relationship.sourceRecordIds) ||
      relationship.participants.length === 0 ||
      (relationship.subjectRole === undefined &&
        (relationship.participants.length < 2 ||
          relationship.sourceSubjectId === undefined)) ||
      (relationship.sourceSubjectId !== undefined &&
        (!entityIds.has(relationship.sourceSubjectId) ||
          !relationship.participants.some(
            (participant) =>
              participant.entityId === relationship.sourceSubjectId,
          ))) ||
      relationship.participants.some(
        (participant) =>
          participant.entityId.length === 0 ||
          participant.role.length === 0 ||
          !entityIds.has(participant.entityId) ||
          (participant.mentionIds !== undefined &&
            (participant.mentionIds.length === 0 ||
              !participant.mentionIds.every((id) => decidedMentions.has(id)))),
      ) ||
      new Set(
        relationship.participants.map(
          (item) => `${item.entityId}\u0000${item.role}`,
        ),
      ).size !== relationship.participants.length ||
      (relationship.requiredRoles !== undefined &&
        (relationship.requiredRoles.length === 0 ||
          relationship.requiredRoles.some(
            (role) =>
              role.length === 0 ||
              (relationship.subjectRole !== role &&
                !relationship.participants.some(
                  (participant) => participant.role === role,
                )),
          )))
    ) {
      throw new Error(
        "Entity Relationship violates its interpretation contract",
      );
    }
    relationshipSlots.add(relationship.sourceSlot);
    for (const qualifier of relationship.qualifiers ?? []) {
      if (qualifier.key.length === 0 || qualifier.value.length === 0)
        throw new Error("Entity Relationship qualifier is invalid");
    }
  }
  return batch;
}

function recognitionEvidenceReferenceKey(
  reference: RecognitionEvidenceReference,
): string {
  return `${reference.kind}:${reference.sourceRecordId}`;
}

export type SourceSlotLifecycleChangeSet = {
  readonly superseded: readonly string[];
  readonly retracted: readonly string[];
  readonly retained: readonly string[];
};

/**
 * 一个精确来源身份／地址／覆盖 lineage 的领域规则。缺失只在完整覆盖下有意义；槽位
 * 相等性由来源解释契约提供，而不是从属性猜测。
 */
export function deriveSourceSlotLifecycleChanges(input: {
  readonly currentSlots: readonly string[];
  readonly nextSlots: readonly string[];
  readonly coverageCompleteness: "complete" | "incomplete";
}): SourceSlotLifecycleChangeSet {
  const next = new Set(input.nextSlots);
  const superseded = input.currentSlots.filter((slot) => next.has(slot));
  const absent = input.currentSlots.filter((slot) => !next.has(slot));
  return {
    superseded,
    retracted: input.coverageCompleteness === "complete" ? absent : [],
    retained: input.coverageCompleteness === "incomplete" ? absent : [],
  };
}

export function validateAcceptedRecognition(
  accepted: AcceptedRecognition,
): AcceptedRecognition {
  validateRecognitionFactShape(accepted);
  validateRecognitionIdentityBaseline(accepted);
  return accepted;
}

function validateRecognitionIdentityBaseline(
  accepted: AcceptedRecognition,
): void {
  validateRecognitionProposal(accepted.proposal);
  if (accepted.entity.kind !== "digital-asset") {
    throw new Error("Accepted recognition requires a Digital Asset entity");
  }
  if (
    accepted.sourceAssociations.some(
      (association) => association.subjectId !== accepted.entity.id,
    )
  ) {
    throw new Error("Source Associations must belong to the accepted asset");
  }
  if (accepted.recognitionDecision.assetId !== accepted.entity.id) {
    throw new Error("Recognition Decision must accept the same asset");
  }
  const interpretation = recognitionSourceInterpretation(accepted.proposal);
  const recognitionAssociation = accepted.recognitionSourceAssociation;
  if (interpretation === undefined) {
    if (recognitionAssociation !== undefined)
      throw new Error(
        "Observed recognition cannot manufacture a Source Association",
      );
  } else {
    if (recognitionAssociation === undefined)
      throw new Error("Source recognition requires its Source Association");
    if (
      recognitionAssociation.sourceIdentity !== interpretation.sourceIdentity
    ) {
      throw new Error(
        "Source Association must match the Recognition Proposal source identity",
      );
    }
    if (recognitionAssociation.nativeAddress !== interpretation.sourceAddress) {
      throw new Error(
        "Source Association must match the Recognition Proposal source address",
      );
    }
    if (
      !accepted.sourceAssociations.some(
        (association) =>
          canonicalJson(association) === canonicalJson(recognitionAssociation),
      )
    )
      throw new Error("Recognition Source Association must be current");
  }
  if (accepted.recognitionDecision.proposalId !== accepted.proposal.id) {
    throw new Error(
      "Recognition Decision must reference the accepted Recognition Proposal",
    );
  }
  if (
    canonicalJson(accepted.recognitionDecision.acceptedRuleResults) !==
    canonicalJson(accepted.proposal.ruleResults)
  ) {
    throw new Error(
      "Recognition Decision rules must match the accepted Recognition Proposal",
    );
  }
}

/**
 * 验证身份保持刷新。不同于初次接受，新提议提供仅追加来源事实，不能改写建立当前身份的
 * 不可变关联或决策。身份替换使用独立的提议—预览—取代路径。
 */
export function validateReevaluatedRecognition(input: {
  readonly current: AcceptedRecognition;
  readonly accepted: AcceptedRecognition;
}): AcceptedRecognition {
  validateRecognitionIdentityBaseline(input.current);
  validateRecognitionFactShape(input.accepted);
  if (input.current.entity.id !== input.accepted.entity.id) {
    throw new Error(
      "Identity-preserving refresh must retain the accepted Digital Asset",
    );
  }
  if (
    canonicalOptionalJson(input.current.recognitionSourceAssociation) !==
    canonicalOptionalJson(input.accepted.recognitionSourceAssociation)
  ) {
    throw new Error(
      "Identity-preserving refresh must retain the immutable Source Association",
    );
  }
  if (
    canonicalJson(input.current.recognitionDecision) !==
    canonicalJson(input.accepted.recognitionDecision)
  ) {
    throw new Error(
      "Identity-preserving refresh must retain the immutable Recognition Decision",
    );
  }
  const nextInterpretation = recognitionSourceInterpretation(
    input.accepted.proposal,
  );
  const currentRecognitionAssociation =
    input.current.recognitionSourceAssociation;
  if (
    (nextInterpretation === undefined) !==
      (currentRecognitionAssociation === undefined) ||
    (nextInterpretation !== undefined &&
      currentRecognitionAssociation !== undefined &&
      (nextInterpretation.sourceIdentity !==
        currentRecognitionAssociation.sourceIdentity ||
        nextInterpretation.sourceAddress !==
          currentRecognitionAssociation.nativeAddress))
  ) {
    throw new Error(
      "Identity-preserving refresh must retain the current Source Association address",
    );
  }
  return input.accepted;
}

function validateRecognitionFactShape(accepted: AcceptedRecognition): void {
  validateRecognitionProposal(accepted.proposal);
  const interpretation = recognitionSourceInterpretation(accepted.proposal);
  const interpretationSources = new Set(interpretation?.sourceRecordIds ?? []);
  const hasKnownProvenance = (sourceRecordIds: readonly string[]): boolean =>
    sourceRecordIds.length > 0 &&
    sourceRecordIds.every((sourceRecordId) =>
      interpretationSources.has(sourceRecordId),
    );
  if (accepted.entity.kind !== "digital-asset") {
    throw new Error("Accepted recognition requires a Digital Asset entity");
  }
  if (
    accepted.sourceAssociations.some(
      (association) => association.subjectId !== accepted.entity.id,
    )
  ) {
    throw new Error("Source Associations must belong to the accepted asset");
  }
  if (accepted.recognitionDecision.assetId !== accepted.entity.id) {
    throw new Error("Recognition Decision must accept the same asset");
  }
  const artifactIds = new Set(
    accepted.artifacts.map((artifact) => artifact.id),
  );
  const revisions = new Map(
    accepted.artifactRevisions.map((revision) => [revision.id, revision]),
  );
  for (const graph of accepted.observedEntityGraphs ?? []) {
    if (
      graph.assetId !== accepted.entity.id ||
      !artifactIds.has(graph.artifactId) ||
      revisions.get(graph.revisionId)?.artifactId !== graph.artifactId ||
      !graph.complete ||
      !graph.coverageId ||
      !graph.producer.capabilityId ||
      !graph.producer.capabilityVersion ||
      !graph.producer.contractVersion
    )
      throw new Error(
        "Observed entity graph requires its exact artifact revision support",
      );
    const entityIds = new Set(graph.entities.map((entity) => entity.id));
    const mentionIds = new Set(graph.mentions.map((mention) => mention.id));
    if (
      entityIds.size !== graph.entities.length ||
      mentionIds.size !== graph.mentions.length ||
      graph.entities.some(
        (entity) =>
          !entity.id ||
          !entity.occurrenceSlot ||
          !entity.label ||
          !entity.preservedValue ||
          !entity.locator,
      ) ||
      graph.mentions.some(
        (mention) =>
          !entityIds.has(mention.entityId) ||
          !mention.sourceSlot ||
          !mention.field ||
          !mention.role ||
          !mention.label ||
          !mention.locator,
      ) ||
      graph.resolutions.some(
        (resolution) =>
          !mentionIds.has(resolution.mentionId) ||
          !entityIds.has(resolution.entityId),
      ) ||
      graph.relationships.some(
        (relationship) =>
          relationship.sourceRecordIds.length !== 0 ||
          relationship.participants.length < 2 ||
          relationship.participants.some(
            (participant) =>
              !entityIds.has(participant.entityId) &&
              participant.entityId !== accepted.entity.id,
          ),
      )
    )
      throw new Error("Observed entity graph contains invalid local facts");
  }
  for (const location of accepted.locations) {
    if (!artifactIds.has(location.artifactId)) {
      throw new Error("Location references an unknown Artifact");
    }
  }
  for (const association of accepted.artifactAssociations) {
    if (!artifactIds.has(association.artifactId)) {
      throw new Error("Artifact Association references an unknown Artifact");
    }
    if (
      association.sourceRecordIds !== undefined &&
      !hasKnownProvenance(association.sourceRecordIds)
    ) {
      throw new Error("Artifact Association has unknown source provenance");
    }
    if (
      association.observedArtifactPart !== undefined &&
      (!artifactIds.has(association.observedArtifactPart.artifactId) ||
        revisions.get(association.observedArtifactPart.revisionId)
          ?.artifactId !== association.observedArtifactPart.artifactId ||
        association.sourceRecordIds !== undefined)
    ) {
      throw new Error(
        "Observed Artifact Part association has invalid provenance",
      );
    }
  }
  const entityIds = new Set([
    accepted.entity.id,
    ...(accepted.entities ?? []).map((entity) => entity.id),
  ]);
  const sourcedEntityIds = new Set(
    (accepted.entities ?? []).map((entity) => entity.id),
  );
  for (const association of accepted.artifactAssociations) {
    if (association.target.kind === "entity") {
      if (!entityIds.has(association.target.entityId))
        throw new Error(
          `Artifact Association references unresolved Entity ${association.target.entityId}`,
        );
      if (
        association.target.entityId !== accepted.entity.id &&
        (!sourcedEntityIds.has(association.target.entityId) ||
          association.sourceRecordIds === undefined)
      )
        throw new Error(
          "Artifact Association target must be a sourced resolved Entity with provenance",
        );
    } else if (
      revisions.get(association.target.revisionId)?.artifactId !==
        association.target.artifactId ||
      association.observedArtifactPart?.artifactId !==
        association.target.artifactId ||
      association.observedArtifactPart.revisionId !==
        association.target.revisionId
    ) {
      throw new Error(
        "Artifact Association revision target must match observed-part provenance",
      );
    }
  }
  for (const entity of accepted.entities ?? []) {
    if (
      !hasKnownProvenance(entity.sourceRecordIds) ||
      entity.identityNamespace.length === 0 ||
      entity.sourceKey.length === 0
    ) {
      throw new Error("Sourced Entity requires exact identity provenance");
    }
  }
  const mentions = accepted.entityMentions ?? [];
  const mentionIds = new Set(mentions.map((mention) => mention.id));
  for (const mention of mentions) {
    if (
      !hasKnownProvenance(mention.sourceRecordIds) ||
      mention.label.length === 0
    ) {
      throw new Error("Entity Mention requires interpretation provenance");
    }
  }
  const decisions = accepted.entityResolutionDecisions ?? [];
  for (const decision of decisions) {
    if (
      !mentionIds.has(decision.mentionId) ||
      !entityIds.has(decision.entityId) ||
      !hasKnownProvenance(decision.sourceRecordIds)
    ) {
      throw new Error(
        "Entity Resolution Decision requires known mention and entity",
      );
    }
  }
  for (const relationship of accepted.relationships ?? []) {
    if (
      relationship.participants.length < 2 ||
      relationship.participants.some(
        (participant) =>
          !entityIds.has(participant.entityId) || participant.role.length === 0,
      ) ||
      new Set(
        relationship.participants.map(
          (item) => `${item.entityId}\u0000${item.role}`,
        ),
      ).size !== relationship.participants.length ||
      !hasKnownProvenance(relationship.sourceRecordIds)
    ) {
      throw new Error(
        "Entity Relationship requires resolved sourced participants",
      );
    }
  }
  for (const assertion of accepted.metadata) {
    if (assertion.authoredBy !== undefined) {
      const basis = accepted.proposal.basis;
      if (
        basis.kind !== "manual-boundary" ||
        assertion.authoredBy.initiatedBy !== basis.proposedBy ||
        assertion.authoredBy.proposalId !== accepted.proposal.id ||
        assertion.sourceRecordIds.length !== 0 ||
        assertion.observedArtifactPart !== undefined ||
        assertion.producer !== undefined ||
        assertion.target.kind !== "entity" ||
        assertion.target.entityId !== accepted.entity.id ||
        assertion.recognitionDecisionId !== undefined ||
        !basis.metadata.some(
          (item) =>
            item.property === assertion.property &&
            item.value === assertion.value,
        )
      )
        throw new Error("人工元数据必须来自该提案的明确判断");
      continue;
    }
    const localPart = assertion.observedArtifactPart;
    if (
      (assertion.sourceRecordIds.length === 0 && localPart === undefined) ||
      (assertion.sourceRecordIds.length > 0 &&
        (!hasKnownProvenance(assertion.sourceRecordIds) ||
          localPart !== undefined)) ||
      (localPart !== undefined &&
        (!artifactIds.has(localPart.artifactId) ||
          revisions.get(localPart.revisionId)?.artifactId !==
            localPart.artifactId ||
          localPart.locator.length === 0 ||
          (assertion.target.kind === "artifact-revision"
            ? assertion.target.artifactId !== localPart.artifactId ||
              assertion.target.revisionId !== localPart.revisionId ||
              assertion.recognitionDecisionId !== undefined
            : assertion.target.entityId !== accepted.entity.id ||
              assertion.recognitionDecisionId !==
                accepted.recognitionDecision.id))) ||
      (localPart === undefined &&
        (assertion.target.kind !== "entity" ||
          !entityIds.has(assertion.target.entityId) ||
          assertion.recognitionDecisionId !== undefined))
    ) {
      throw new Error(
        "Metadata Assertion requires source or observed-part provenance",
      );
    }
  }
  const blobDigests = new Set(accepted.blobs.map((blob) => blob.digest));
  for (const revision of accepted.artifactRevisions) {
    if (
      !artifactIds.has(revision.artifactId) ||
      !blobDigests.has(revision.blobDigest)
    ) {
      throw new Error("Artifact Revision requires an Artifact and Blob");
    }
  }
}

/** 领域事实比较结构化 JSON 值，绝不比较对象插入顺序。 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Domain fact is not JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Domain fact is not JSON");
}

function canonicalOptionalJson(value: unknown): string {
  return value === undefined ? "undefined" : canonicalJson(value);
}

/** 验证终止一个来源持有关联所需的来源信息。 */
export function validateArtifactAssociationRetraction(input: {
  readonly retraction: ArtifactAssociationRetraction;
  readonly predecessor: ArtifactAssociation;
  readonly predecessorSourceRecords: readonly SourceRecord[];
  readonly proposal: RecognitionProposal;
  readonly sourceRecords: readonly SourceRecord[];
}): ArtifactAssociationRetraction {
  const predecessorSources = input.predecessor.sourceRecordIds ?? [];
  const nextById = new Map(
    input.sourceRecords.map((record) => [record.id, record]),
  );
  const predecessorById = new Map(
    input.predecessorSourceRecords.map((record) => [record.id, record]),
  );
  if (
    input.retraction.id.length === 0 ||
    input.retraction.associationId !== input.predecessor.id ||
    input.retraction.proposalId !== input.proposal.id ||
    predecessorSources.length === 0 ||
    input.retraction.sourceRecordIds.length === 0 ||
    !input.retraction.sourceRecordIds.every((id) =>
      (
        recognitionSourceInterpretation(input.proposal)?.sourceRecordIds ?? []
      ).includes(id),
    )
  ) {
    throw new Error(
      "Artifact Association Retraction requires its reevaluation proposal and source provenance",
    );
  }
  for (const sourceRecordId of input.retraction.sourceRecordIds) {
    const next = nextById.get(sourceRecordId);
    if (
      next === undefined ||
      next.coverage.completeness !== "complete" ||
      next.coverage.authority !== "official" ||
      !predecessorSources.some((predecessorId) => {
        const predecessor = predecessorById.get(predecessorId);
        return (
          predecessor !== undefined &&
          predecessor.sourceIdentity === next.sourceIdentity &&
          predecessor.nativeAddress === next.nativeAddress &&
          predecessor.coverage.id === next.coverage.id
        );
      })
    ) {
      throw new Error(
        "Artifact Association Retraction requires complete source coverage in the predecessor lineage",
      );
    }
  }
  return input.retraction;
}
