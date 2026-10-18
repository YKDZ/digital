import {
  array,
  boolean,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  optional,
  pipe,
  string,
  union,
  type InferOutput,
} from "valibot";

const nonEmptyTextSchema = pipe(string(), minLength(1), maxLength(4096));
const pageLimitSchema = pipe(number(), integer(), minValue(1), maxValue(100));
const codePointOffsetSchema = pipe(number(), integer(), minValue(0));
const codePointLimitSchema = pipe(
  number(),
  integer(),
  minValue(1),
  maxValue(4096),
);

export const assetEvidenceKindSchema = union([
  literal("local-observations"),
  literal("format-results"),
  literal("source-records"),
  literal("interpreted-facts"),
  literal("current-values"),
  literal("metadata-decisions"),
]);

const descriptionTargetSchema = union([
  object({ kind: literal("entity"), entityId: nonEmptyTextSchema }),
  object({
    kind: literal("artifact-revision"),
    artifactId: nonEmptyTextSchema,
    revisionId: nonEmptyTextSchema,
  }),
]);

const qualifiersSchema = array(
  object({ key: nonEmptyTextSchema, value: string() }),
);

const metadataReasoningSchema = union([
  object({
    kind: literal("source-preference"),
    preferredSource: nonEmptyTextSchema,
  }),
  object({
    kind: literal("preferred-source-absent-fallback"),
    absentPreferredSources: array(nonEmptyTextSchema),
    selectedFallbackSource: nonEmptyTextSchema,
  }),
  object({
    kind: literal("preferred-sources-absent-unranked"),
    absentPreferredSources: array(nonEmptyTextSchema),
  }),
  object({ kind: literal("unranked-source-assertion") }),
]);

const selectedMetadataSchema = object({
  property: nonEmptyTextSchema,
  value: string(),
  sourceIdentity: nonEmptyTextSchema,
  sourceSlot: nonEmptyTextSchema,
  reasoning: metadataReasoningSchema,
  sourceRecordIds: array(nonEmptyTextSchema),
  assertions: array(
    object({
      target: descriptionTargetSchema,
      sourceSlot: nonEmptyTextSchema,
      sourceRecordIds: array(nonEmptyTextSchema),
    }),
  ),
  qualifiers: optional(qualifiersSchema),
});

const metadataExclusionSchema = object({
  kind: literal("source-preference"),
  selectedSource: nonEmptyTextSchema,
  disagreesWithSelected: boolean(),
});

const metadataCandidateSchema = object({
  reference: optional(nonEmptyTextSchema),
  target: descriptionTargetSchema,
  property: nonEmptyTextSchema,
  value: string(),
  sourceIdentity: nonEmptyTextSchema,
  sourceSlot: nonEmptyTextSchema,
  sourceRecordIds: array(nonEmptyTextSchema),
  qualifiers: optional(qualifiersSchema),
  exclusion: optional(metadataExclusionSchema),
});

const metadataEvidenceResultSchema = union([
  object({
    status: literal("resolved"),
    values: array(selectedMetadataSchema),
    notSelected: array(metadataCandidateSchema),
  }),
  object({ status: literal("missing") }),
  object({
    status: literal("conflict"),
    kind: union([
      literal("policy-conflict"),
      literal("metadata-value-conflict"),
    ]),
    explanation: nonEmptyTextSchema,
    candidates: array(metadataCandidateSchema),
  }),
]);

const metadataEvidenceSchema = object({
  property: nonEmptyTextSchema,
  result: metadataEvidenceResultSchema,
});

const coverageSchema = object({
  id: nonEmptyTextSchema,
  completeness: union([literal("complete"), literal("incomplete")]),
  authority: literal("official"),
});

const assetEvidenceItemSchema = union([
  object({
    kind: literal("local-observation"),
    snapshotId: nonEmptyTextSchema,
    observedAt: nonEmptyTextSchema,
    relativePath: string(),
    entry: union([
      object({
        kind: literal("file"),
        size: pipe(number(), integer(), minValue(0)),
        modifiedAt: nonEmptyTextSchema,
      }),
      object({ kind: literal("directory"), modifiedAt: nonEmptyTextSchema }),
      object({
        kind: literal("excluded"),
        reason: union([
          literal("symbolic-link"),
          literal("special"),
          literal("unavailable"),
        ]),
      }),
    ]),
  }),
  object({
    kind: literal("format-result"),
    format: nonEmptyTextSchema,
    explanation: nonEmptyTextSchema,
    observedArtifactReference: nonEmptyTextSchema,
    detail: union([
      object({
        kind: literal("result"),
        digest: nonEmptyTextSchema,
        byteLength: pipe(number(), integer(), minValue(0)),
        mediaType: nonEmptyTextSchema,
      }),
      object({
        kind: literal("identifier"),
        scheme: nonEmptyTextSchema,
        value: string(),
        locators: array(nonEmptyTextSchema),
      }),
      object({
        kind: literal("metadata"),
        property: nonEmptyTextSchema,
        sourceSlot: nonEmptyTextSchema,
        value: string(),
        locator: string(),
      }),
      object({
        kind: literal("part"),
        role: nonEmptyTextSchema,
        locator: string(),
        mediaType: nonEmptyTextSchema,
      }),
      object({
        kind: literal("entity-graph"),
        entityCount: pipe(number(), integer(), minValue(0)),
        mentionCount: pipe(number(), integer(), minValue(0)),
        relationshipCount: pipe(number(), integer(), minValue(0)),
      }),
    ]),
  }),
  object({
    kind: literal("source-record"),
    id: nonEmptyTextSchema,
    status: union([literal("available"), literal("missing")]),
    sourceIdentity: optional(nonEmptyTextSchema),
    nativeAddress: optional(string()),
    mediaType: optional(nonEmptyTextSchema),
    acquiredAt: optional(nonEmptyTextSchema),
    coverage: optional(coverageSchema),
    digest: optional(nonEmptyTextSchema),
  }),
  object({
    kind: literal("interpreted-fact"),
    target: descriptionTargetSchema,
    property: nonEmptyTextSchema,
    value: string(),
    sourceIdentity: optional(nonEmptyTextSchema),
    sourceSlot: nonEmptyTextSchema,
    sourceRecordIds: array(nonEmptyTextSchema),
    qualifiers: optional(qualifiersSchema),
    observedArtifactPart: optional(
      object({
        artifactId: nonEmptyTextSchema,
        revisionId: nonEmptyTextSchema,
        locator: string(),
      }),
    ),
  }),
  object({
    kind: literal("current-value"),
    target: descriptionTargetSchema,
    evidence: metadataEvidenceSchema,
  }),
  object({
    kind: literal("metadata-decision"),
    target: descriptionTargetSchema,
    property: nonEmptyTextSchema,
    metadataUsageContext: nonEmptyTextSchema,
    decision: union([literal("pin"), literal("clear")]),
    decisionId: nonEmptyTextSchema,
    initiatedBy: nonEmptyTextSchema,
    predecessorDecisionId: optional(nonEmptyTextSchema),
    value: optional(string()),
    current: boolean(),
    adoptedFrom: optional(
      object({
        sourceIdentity: nonEmptyTextSchema,
        sourceSlot: nonEmptyTextSchema,
        sourceRecordIds: array(nonEmptyTextSchema),
      }),
    ),
  }),
]);

export const assetInspectionOverviewSchema = object({
  assetId: nonEmptyTextSchema,
  entity: object({
    id: nonEmptyTextSchema,
    kind: union([literal("digital-asset"), literal("entity")]),
  }),
  sections: array(
    object({
      kind: assetEvidenceKindSchema,
      count: pipe(number(), integer(), minValue(0)),
      status: union([literal("available"), literal("missing")]),
    }),
  ),
});

export const assetEvidencePageSchema = object({
  assetId: nonEmptyTextSchema,
  kind: assetEvidenceKindSchema,
  status: union([literal("available"), literal("missing")]),
  items: array(assetEvidenceItemSchema),
  nextCursor: optional(nonEmptyTextSchema),
});

export const assetSourceRecordChunkSchema = object({
  assetId: nonEmptyTextSchema,
  record: object({
    id: nonEmptyTextSchema,
    sourceIdentity: nonEmptyTextSchema,
    nativeAddress: string(),
    mediaType: nonEmptyTextSchema,
    acquiredAt: nonEmptyTextSchema,
    coverage: coverageSchema,
    digest: nonEmptyTextSchema,
  }),
  offset: codePointOffsetSchema,
  nextOffset: codePointOffsetSchema,
  complete: boolean(),
  content: string(),
});

export const currentAttentionPageSchema = object({
  items: array(
    object({
      id: nonEmptyTextSchema,
      kind: union([
        literal("recognition-review"),
        literal("change-impact-review"),
        literal("source-refresh-review"),
        literal("prerequisite-unavailable"),
      ]),
      executionId: optional(nonEmptyTextSchema),
      assetId: optional(nonEmptyTextSchema),
      summary: nonEmptyTextSchema,
      recognitionProposalId: optional(nonEmptyTextSchema),
      changeImpactPreviewId: optional(nonEmptyTextSchema),
      sourceRefreshChangeSetId: optional(nonEmptyTextSchema),
      automationIntentId: optional(nonEmptyTextSchema),
    }),
  ),
  nextCursor: optional(nonEmptyTextSchema),
});

export const workflowHistoryPageSchema = object({
  items: array(
    object({
      execution: object({
        id: nonEmptyTextSchema,
        status: union([
          literal("running"),
          literal("completed"),
          literal("failed"),
        ]),
        stage: nonEmptyTextSchema,
        outcome: optional(nonEmptyTextSchema),
        operationKind: optional(nonEmptyTextSchema),
        automationIntentId: optional(nonEmptyTextSchema),
      }),
      resultReferences: object({
        acceptedAssetIds: array(nonEmptyTextSchema),
        affectedSubjectIds: array(nonEmptyTextSchema),
        sourceRecordIds: array(nonEmptyTextSchema),
        sourceRefreshRunIds: array(nonEmptyTextSchema),
        changeImpactPreviewIds: array(nonEmptyTextSchema),
      }),
      recognitionResults: array(
        object({
          proposalId: nonEmptyTextSchema,
          explanation: string(),
          status: union([literal("proposed"), literal("accepted")]),
        }),
      ),
    }),
  ),
  nextCursor: optional(nonEmptyTextSchema),
});

export const listAssetEvidenceRequestSchema = object({
  kind: assetEvidenceKindSchema,
  limit: optional(pageLimitSchema),
  cursor: optional(nonEmptyTextSchema),
});

export const assetSourceRecordChunkRequestSchema = object({
  offset: optional(codePointOffsetSchema),
  limit: optional(codePointLimitSchema),
});

export const inspectionPageRequestSchema = object({
  limit: optional(pageLimitSchema),
  cursor: optional(nonEmptyTextSchema),
});

export type AssetEvidenceKind = InferOutput<typeof assetEvidenceKindSchema>;
export type AssetInspectionOverview = InferOutput<
  typeof assetInspectionOverviewSchema
>;
export type AssetEvidenceItem = InferOutput<typeof assetEvidenceItemSchema>;
export type AssetEvidencePage = InferOutput<typeof assetEvidencePageSchema>;
export type AssetSourceRecordChunk = InferOutput<
  typeof assetSourceRecordChunkSchema
>;
export type CurrentAttentionPage = InferOutput<
  typeof currentAttentionPageSchema
>;
export type WorkflowHistoryPage = InferOutput<typeof workflowHistoryPageSchema>;
export type ListAssetEvidenceRequest = InferOutput<
  typeof listAssetEvidenceRequestSchema
>;
export type AssetSourceRecordChunkRequest = InferOutput<
  typeof assetSourceRecordChunkRequestSchema
>;
export type InspectionPageRequest = InferOutput<
  typeof inspectionPageRequestSchema
>;
