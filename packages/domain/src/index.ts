import type { MetadataAssertion } from "./metadata-assertion.js";

export * from "./effective-metadata.js";
export * from "./metadata-assertion.js";
export * from "./source-refresh-run.js";

/** Open vocabulary. A role belongs to an association, never to an Artifact. */
export type ArtifactRole = string;

export type CapabilityCoordinate = {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly contractVersion: string;
  /** Present on current static declarations; absent only on retained legacy facts. */
  readonly identity?: string;
  readonly implementationVersion?: string;
  /** Open Application contract value; Domain never enumerates capability kinds. */
  readonly kind?: string;
  readonly interpretationContractVersions?: readonly string[];
};

export type SourceRecord = {
  readonly id: string;
  readonly sourceIdentity: string;
  /** Opaque canonical address of the source subject, not an endpoint URL. */
  readonly nativeAddress: string;
  readonly mediaType: string;
  readonly acquiredAt: string;
  readonly acquisition: {
    readonly requestedAddress: string;
    /** The bounded source request method; collectors never retain headers. */
    readonly method: "GET" | "POST";
    readonly authorized: boolean;
  };
  readonly coverage: {
    readonly id: string;
    /** Incomplete records may establish positive facts but never absence. */
    readonly completeness: "complete" | "incomplete";
    readonly authority: "official";
  };
  readonly digest: string;
  readonly body: string;
  /** The collector coordinate that captured this immutable response. */
  readonly producer?: CapabilityCoordinate;
};

export type RecognitionEvidence = {
  readonly kind: string;
  readonly explanation: string;
  /** Required whenever an opaque source-native address is already associated. */
  readonly sourceIdentity?: string;
  readonly sourceAddress?: string;
  readonly producer: CapabilityCoordinate;
  /** Open, format-produced evidence. Domain does not interpret its vocabulary. */
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

/** A typed durable reference to evidence whose lifecycle is owned elsewhere. */
export type RecognitionEvidenceReference = {
  readonly kind: "source-record";
  readonly sourceRecordId: string;
};

export type SourceArtifactCandidate = {
  readonly id: string;
  readonly sourceRecordId: string;
  /**
   * A source-resolved Entity in the same proposal that this material serves.
   * Omission deliberately means the accepted Digital Asset, preserving the
   * ordinary one-subject recognition path.
   */
  readonly subjectId?: string;
  readonly role: ArtifactRole;
  readonly acquisitionReference: string;
  readonly mediaType: string;
  /** The interpreter coordinate that exposed this candidate. */
  readonly producer?: CapabilityCoordinate;
};

/**
 * A bounded format entry belonging to an observed Artifact. It is not an
 * external source response and becomes a separate Artifact only when an
 * authorized managed materialization explicitly requests it.
 */
export type ObservedArtifactPartCandidate = {
  readonly id: string;
  readonly role: ArtifactRole;
  /** Opaque observer-scoped reference; Domain never parses filesystem grammar. */
  readonly observedArtifactReference: string;
  readonly locator: string;
  readonly mediaType: string;
  /** The format inspector that discovered this bounded local Part. */
  readonly producer: CapabilityCoordinate;
};

/** A local format fact before Application has materialized its parent revision. */
export type ObservedArtifactMetadataCandidate = {
  readonly property: string;
  readonly sourceSlot: string;
  readonly value: string;
  readonly observedArtifactReference: string;
  readonly locator: string;
  /** The format inspector that derived this local metadata assertion. */
  readonly producer: CapabilityCoordinate;
};

/**
 * A content fingerprint observed while a format capability inspected a local
 * Artifact.  It lets the Application establish the parent revision before a
 * derivative Part (such as a cover) is ever requested.
 */
export type ObservedArtifactRevisionCandidate = {
  readonly observedArtifactReference: string;
  readonly blob: Blob;
  /** The format inspector that observed this parent content fingerprint. */
  readonly producer: CapabilityCoordinate;
};

/**
 * An exact source occurrence.  It deliberately preserves the spelling emitted
 * by the interpretation contract: identity resolution may never rewrite this
 * evidence by trimming, normalising, or de-duplicating it.
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

/** The auditable deterministic resolution of one source occurrence. */
export type EntityResolutionDecision = {
  readonly id: string;
  readonly mentionId: string;
  readonly entityId: string;
  readonly rule: "source-field-role-exact";
  readonly sourceRecordIds: readonly string[];
  readonly producer?: CapabilityCoordinate;
};

/** A plugin-neutral interpretation; it is not yet a Recognition Proposal. */
export type SourceInterpretationBatch = {
  readonly id: string;
  readonly producer: CapabilityCoordinate;
  readonly sourceRecordIds: readonly string[];
  readonly sourceIdentity: string;
  readonly sourceAddress: string;
  /**
   * Source Records used to establish recognition, including records that do
   * not describe the projected source subject.
   */
  readonly recognitionEvidenceReferences?: readonly RecognitionEvidenceReference[];
  readonly metadata: readonly MetadataAssertion[];
  readonly sourceArtifacts: readonly SourceArtifactCandidate[];
  /** Exact credit/circle occurrences, before any source-scoped resolution. */
  readonly entityMentions?: readonly EntityMention[];
  /** Explicit decisions which resolve the mentions into proposed entities. */
  readonly entityResolutionDecisions?: readonly EntityResolutionDecision[];
  /** Source-scoped resolved identities proposed by one interpretation. */
  readonly entities?: readonly SourcedEntity[];
  /** Contribution facts whose roles belong to participations, never Entity kinds. */
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
 * The only interpretation a Recognizer may contribute. Application owns the
 * already-bound Source Interpretation Batch, input Evidence, and local format
 * facts, then joins this draft to those inputs after validating the rule.
 */
export type RecognitionProposalDraft = {
  readonly id: string;
  readonly ruleResults: readonly RecognitionRuleResult[];
};

export type RecognitionProposal = {
  readonly id: string;
  readonly interpretation: SourceInterpretationBatch;
  readonly ruleResults: readonly RecognitionRuleResult[];
  /** Local materialization plan is separate from external source interpretation. */
  readonly observedArtifactParts?: readonly ObservedArtifactPartCandidate[];
  /** Local format facts remain outside the external source interpretation. */
  readonly observedMetadata?: readonly ObservedArtifactMetadataCandidate[];
  /** Parent revisions for locally inspected facts are independent of Parts. */
  readonly observedArtifactRevisions?: readonly ObservedArtifactRevisionCandidate[];
};

export type Entity = {
  readonly id: string;
  readonly kind: "digital-asset" | "entity" | "person" | "persona";
};

export type DigitalAsset = Entity & {
  readonly kind: "digital-asset";
};

/** A generic Entity or Persona established only inside an exact source namespace. */
export type SourcedEntity = Entity & {
  readonly kind: "entity" | "person" | "persona";
  readonly sourceIdentity: string;
  readonly sourceKey: string;
  readonly identityNamespace: string;
  readonly label: string;
  readonly sourceRecordIds: readonly string[];
  readonly producer?: CapabilityCoordinate;
};

/** One traversable sourced relationship, with the asset as its declared subject. */
export type EntityRelationship = {
  readonly id: string;
  readonly subjectId: string;
  readonly participantId: string;
  /** Open relationship vocabulary; semantics and constraints belong to evidence/capabilities. */
  readonly type: string;
  readonly role: string;
  /** Stable source-contract slot within one coverage lineage. */
  readonly sourceSlot: string;
  readonly sourceRecordIds: readonly string[];
  readonly producer?: CapabilityCoordinate;
  /** Open source-scoped context, for example a credited character name. */
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
   * A source-resolved Entity in this proposal. Omission deliberately means
   * the accepted Digital Asset, preserving the ordinary one-subject path.
   */
  readonly subjectId?: string;
  /** The source occurrences supporting the resolved participant. */
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
  /** The capability that acquired the bytes represented by this revision. */
  readonly producer?: CapabilityCoordinate;
};

export type ArtifactAssociation = {
  readonly id: string;
  readonly subjectId: string;
  readonly artifactId: string;
  readonly role: ArtifactRole;
  /** Empty for locally asserted associations; populated for source-owned facts. */
  readonly sourceRecordIds?: readonly string[];
  /** The exact current Source Association that owns a managed source artifact. */
  readonly sourceAssociationId?: string;
  /** The interpretation capability that established a source-owned association. */
  readonly producer?: CapabilityCoordinate;
  /** Local container provenance; distinct from an external Source Record. */
  readonly observedArtifactPart?: {
    readonly artifactId: string;
    readonly revisionId: string;
    readonly locator: string;
  };
};

/**
 * An immutable end to a source-owned Artifact Association.  It is justified
 * by the reevaluation proposal and the complete Source Record(s) that made
 * the former association absent; it never repurposes the earlier Recognition
 * Decision that originally supported the association.
 */
export type ArtifactAssociationRetraction = {
  readonly id: string;
  readonly associationId: string;
  readonly proposalId: string;
  readonly sourceRecordIds: readonly string[];
};

/**
 * The complete immutable fact set established by accepting one proposal. It is
 * submitted in one Application-owned conditional transaction.
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
 * Validates every interpreter contribution before Application authorises any
 * effect.  This is intentionally a single batch boundary: a malformed credit,
 * provenance link, relationship, or artifact candidate cannot leave the rest
 * of a superficially useful projection committed.
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
 * Domain rule for one exact source-identity/address/coverage lineage.
 * Absence has meaning only under complete coverage; slot equality is supplied
 * by the source interpretation contract rather than guessed from properties.
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
 * Validates an identity-preserving refresh.  Unlike an initial acceptance,
 * the new proposal supplies append-only sourced facts; it cannot rewrite the
 * immutable Association or Decision that established the current identity.
 * Identity replacement has its separate proposal-preview-supersession path.
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

/** Domain facts compare structural JSON values, never object insertion order. */
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

/** Validates the provenance required to end one source-owned association. */
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
