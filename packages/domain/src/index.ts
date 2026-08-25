import type { MetadataAssertion } from "./metadata-assertion.ts";

export * from "./effective-metadata.ts";
export * from "./metadata-assertion.ts";
export * from "./source-refresh-run.ts";

/** 开放词汇。角色属于关联，绝不属于产物。 */
export type ArtifactRole = string;

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
  };
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
  readonly rule: "source-field-role-exact";
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
  readonly metadata: readonly MetadataAssertion[];
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

export type RecognitionProposal = {
  readonly id: string;
  readonly interpretation: SourceInterpretationBatch;
  readonly ruleResults: readonly RecognitionRuleResult[];
  /** 本地物化计划与外部来源解释分离。 */
  readonly observedArtifactParts?: readonly ObservedArtifactPartCandidate[];
  /** 本地格式事实保留在外部来源解释之外。 */
  readonly observedMetadata?: readonly ObservedArtifactMetadataCandidate[];
  /** 本地检查事实的父修订独立于各部分。 */
  readonly observedArtifactRevisions?: readonly ObservedArtifactRevisionCandidate[];
};

export type Entity = {
  readonly id: string;
  readonly kind: "digital-asset" | "entity" | "person" | "persona";
};

export type DigitalAsset = Entity & {
  readonly kind: "digital-asset";
};

/** 只在精确来源命名空间内建立的通用实体或活动身份。 */
export type SourcedEntity = Entity & {
  readonly kind: "entity" | "person" | "persona";
  readonly sourceIdentity: string;
  readonly sourceKey: string;
  readonly identityNamespace: string;
  readonly label: string;
  readonly sourceRecordIds: readonly string[];
  readonly producer?: CapabilityCoordinate;
};

/** 一条可遍历来源关系，以资产作为其声明主体。 */
export type EntityRelationship = {
  readonly id: string;
  readonly subjectId: string;
  readonly participantId: string;
  /** 开放关系词汇；语义与约束属于证据／能力。 */
  readonly type: string;
  readonly role: string;
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

export type ProposedEntityRelationship = Omit<
  EntityRelationship,
  "id" | "subjectId"
> & {
  /**
   * 本提议中一个由来源解析的实体。省略时刻意表示已接受数字资产，从而保留普通单主体路径。
   */
  readonly subjectId?: string;
  /** 支持已解析参与者的来源出现。 */
  readonly participantMentionIds?: readonly string[];
};

export type SourceAssociation = {
  readonly id: string;
  readonly subjectId: string;
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
  readonly proposalId: string;
};

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
  readonly subjectId: string;
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
  readonly sourceAssociation: SourceAssociation;
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
};

export function validateRecognitionProposal(
  proposal: RecognitionProposal,
): RecognitionProposal {
  if (proposal.interpretation.sourceRecordIds.length === 0) {
    throw new Error("Recognition Proposal requires Source Record references");
  }
  if (proposal.ruleResults.length === 0) {
    throw new Error("Recognition Proposal requires Recognition Rule Results");
  }
  validateSourceInterpretationBatch(proposal.interpretation);
  const interpretationEvidence = new Set(
    (proposal.interpretation.recognitionEvidenceReferences ?? []).map(
      recognitionEvidenceReferenceKey,
    ),
  );
  for (const result of proposal.ruleResults) {
    for (const reference of result.evidenceReferences ?? []) {
      if (
        !interpretationEvidence.has(recognitionEvidenceReferenceKey(reference))
      )
        throw new Error(
          "Recognition Rule Result references evidence outside its interpretation",
        );
    }
  }
  return proposal;
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
      relationship.role.length === 0 ||
      relationship.sourceSlot.length === 0 ||
      relationshipSlots.has(relationship.sourceSlot) ||
      !entityIds.has(relationship.participantId) ||
      (relationship.subjectId !== undefined &&
        !entityIds.has(relationship.subjectId)) ||
      !hasProvenance(relationship.sourceRecordIds) ||
      (relationship.participantMentionIds !== undefined &&
        (relationship.participantMentionIds.length === 0 ||
          !relationship.participantMentionIds.every((id) =>
            decidedMentions.has(id),
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
  if (accepted.sourceAssociation.proposalId !== accepted.proposal.id) {
    throw new Error(
      "Source Association must reference the accepted Recognition Proposal",
    );
  }
  if (
    accepted.sourceAssociation.sourceIdentity !==
    accepted.proposal.interpretation.sourceIdentity
  ) {
    throw new Error(
      "Source Association must match the Recognition Proposal source identity",
    );
  }
  if (
    accepted.sourceAssociation.nativeAddress !==
    accepted.proposal.interpretation.sourceAddress
  ) {
    throw new Error(
      "Source Association must match the Recognition Proposal source address",
    );
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
  return accepted;
}

/**
 * 验证身份保持刷新。不同于初次接受，新提议提供仅追加来源事实，不能改写建立当前身份的
 * 不可变关联或决策。身份替换使用独立的提议—预览—取代路径。
 */
export function validateReevaluatedRecognition(input: {
  readonly current: AcceptedRecognition;
  readonly accepted: AcceptedRecognition;
}): AcceptedRecognition {
  validateAcceptedRecognition(input.current);
  validateRecognitionFactShape(input.accepted);
  if (input.current.entity.id !== input.accepted.entity.id) {
    throw new Error(
      "Identity-preserving refresh must retain the accepted Digital Asset",
    );
  }
  if (
    canonicalJson(input.current.sourceAssociation) !==
    canonicalJson(input.accepted.sourceAssociation)
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
  if (
    input.accepted.proposal.interpretation.sourceIdentity !==
      input.current.sourceAssociation.sourceIdentity ||
    input.accepted.proposal.interpretation.sourceAddress !==
      input.current.sourceAssociation.nativeAddress
  ) {
    throw new Error(
      "Identity-preserving refresh must retain the current Source Association address",
    );
  }
  return input.accepted;
}

function validateRecognitionFactShape(accepted: AcceptedRecognition): void {
  validateRecognitionProposal(accepted.proposal);
  const interpretationSources = new Set(
    accepted.proposal.interpretation.sourceRecordIds,
  );
  const hasKnownProvenance = (sourceRecordIds: readonly string[]): boolean =>
    sourceRecordIds.length > 0 &&
    sourceRecordIds.every((sourceRecordId) =>
      interpretationSources.has(sourceRecordId),
    );
  if (accepted.entity.kind !== "digital-asset") {
    throw new Error("Accepted recognition requires a Digital Asset entity");
  }
  if (accepted.sourceAssociation.subjectId !== accepted.entity.id) {
    throw new Error("Source Association must belong to the accepted asset");
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
    if (!entityIds.has(association.subjectId)) {
      throw new Error("Artifact Association references an unresolved Entity");
    }
    if (
      association.subjectId !== accepted.entity.id &&
      (!sourcedEntityIds.has(association.subjectId) ||
        association.sourceRecordIds === undefined)
    ) {
      throw new Error(
        "Artifact Association target must be a sourced resolved Entity with provenance",
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
      !entityIds.has(relationship.subjectId) ||
      !entityIds.has(relationship.participantId) ||
      !hasKnownProvenance(relationship.sourceRecordIds)
    ) {
      throw new Error(
        "Entity Relationship requires resolved sourced participants",
      );
    }
  }
  for (const assertion of accepted.metadata) {
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
          localPart.locator.length === 0)) ||
      (assertion.subjectId !== undefined && !entityIds.has(assertion.subjectId))
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
      input.proposal.interpretation.sourceRecordIds.includes(id),
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
