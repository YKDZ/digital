import {
  array,
  boolean,
  integer,
  lazy,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  null_,
  number,
  object,
  optional,
  pipe,
  record,
  string,
  union,
  type GenericSchema,
  type InferOutput,
} from "valibot";

export * from "./inspection-contract.ts";
export * from "./metadata-decision-contract.ts";

const nonEmptyTextSchema = pipe(string(), minLength(1), maxLength(2048));
const pageLimitSchema = pipe(number(), integer(), minValue(1), maxValue(100));

export const publicErrorCodes = [
  "invalid-request",
  "conflict",
  "not-found",
  "not-ready",
  "unavailable",
  "internal",
] as const;

export const publicApiErrorSchema = object({
  code: union([
    literal("invalid-request"),
    literal("conflict"),
    literal("not-found"),
    literal("not-ready"),
    literal("unavailable"),
    literal("internal"),
  ]),
  message: nonEmptyTextSchema,
});

const descriptionTargetSchema = union([
  object({ kind: literal("entity"), entityId: nonEmptyTextSchema }),
  object({
    kind: literal("artifact-revision"),
    artifactId: nonEmptyTextSchema,
    revisionId: nonEmptyTextSchema,
  }),
]);

export type PublicJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly PublicJsonValue[]
  | { readonly [key: string]: PublicJsonValue };

const jsonValueSchema: GenericSchema<unknown, PublicJsonValue> = lazy(() =>
  union([
    string(),
    number(),
    boolean(),
    null_(),
    array(jsonValueSchema),
    record(string(), jsonValueSchema),
  ]),
);

export const assetLibrarySchema = object({
  id: nonEmptyTextSchema,
  displayName: nonEmptyTextSchema,
  configVersion: pipe(number(), integer(), minValue(1)),
  directories: array(
    object({
      id: nonEmptyTextSchema,
      displayName: nonEmptyTextSchema,
      path: nonEmptyTextSchema,
      status: union([literal("active"), literal("removed")]),
      reachable: boolean(),
      problem: optional(string()),
    }),
  ),
  recognitionProfileIds: array(nonEmptyTextSchema),
  sourceIdentities: array(nonEmptyTextSchema),
});

const assetLibraryCapabilitySchema = object({
  id: nonEmptyTextSchema,
  displayName: nonEmptyTextSchema,
});
export const assetLibraryOptionsSchema = object({
  recognitionProfiles: array(assetLibraryCapabilitySchema),
  sources: array(assetLibraryCapabilitySchema),
});

export const saveAssetLibraryRequestSchema = object({
  displayName: pipe(string(), minLength(1), maxLength(120)),
  directories: pipe(
    array(pipe(string(), minLength(1), maxLength(4096))),
    minLength(1),
  ),
  recognitionProfileIds: array(nonEmptyTextSchema),
  sourceIdentities: array(nonEmptyTextSchema),
});
export const createAssetLibraryRequestSchema = saveAssetLibraryRequestSchema;
export const updateAssetLibraryRequestSchema = object({
  expectedVersion: pipe(number(), integer(), minValue(1)),
  displayName: pipe(string(), minLength(1), maxLength(120)),
  directories: pipe(
    array(pipe(string(), minLength(1), maxLength(4096))),
    minLength(1),
  ),
  recognitionProfileIds: array(nonEmptyTextSchema),
  sourceIdentities: array(nonEmptyTextSchema),
});
export const removeAssetLibraryRequestSchema = object({
  expectedVersion: pipe(number(), integer(), minValue(1)),
});
export const assetLibraryRemovalSchema = object({
  removed: boolean(),
});
export const initialAssetLibraryConfigurationSavedSchema = object({
  libraryCount: pipe(number(), integer(), minValue(0)),
});
export type InitialAssetLibraryConfigurationSaved = InferOutput<
  typeof initialAssetLibraryConfigurationSavedSchema
>;
export const initialAssetLibraryConfigurationRestoreStatusSchema = object({
  status: union([
    literal("not-saved"),
    literal("not-managed"),
    literal("applied"),
    literal("pending"),
  ]),
  libraryCount: pipe(number(), integer(), minValue(0)),
  pendingDirectories: array(
    object({
      libraryName: nonEmptyTextSchema,
      path: nonEmptyTextSchema,
    }),
  ),
});
export type InitialAssetLibraryConfigurationRestoreStatus = InferOutput<
  typeof initialAssetLibraryConfigurationRestoreStatusSchema
>;

const assetRefreshOutcomeSchema = union([
  literal("unresolved"),
  literal("proposal"),
  literal("accepted"),
  literal("partially-succeeded"),
  literal("failed"),
  literal("interrupted"),
  literal("cancelled"),
  literal("no-change"),
]);
export const assetLibraryScanStartSchema = object({
  parentExecutionId: nonEmptyTextSchema,
});
export const assetLibraryScanSchema = object({
  parentExecutionId: nonEmptyTextSchema,
  assetLibraryId: nonEmptyTextSchema,
  configVersion: pipe(number(), integer(), minValue(1)),
  status: union([literal("running"), literal("completed"), literal("failed")]),
  outcome: optional(assetRefreshOutcomeSchema),
  directories: array(
    object({
      id: nonEmptyTextSchema,
      displayName: nonEmptyTextSchema,
      stage: union([
        literal("queued"),
        literal("running"),
        literal("settled"),
        literal("cancelled"),
      ]),
      mode: union([literal("execute"), literal("covered")]),
      outcome: optional(assetRefreshOutcomeSchema),
      reason: optional(string()),
      workItemCount: pipe(number(), integer(), minValue(0)),
      unresolvedCount: pipe(number(), integer(), minValue(0)),
      failedCount: pipe(number(), integer(), minValue(0)),
      files: array(
        object({
          relativePaths: pipe(array(string()), minLength(1)),
          outcome: optional(assetRefreshOutcomeSchema),
          assetId: optional(nonEmptyTextSchema),
        }),
      ),
    }),
  ),
});

const sourceAssociationSchema = object({
  sourceIdentity: nonEmptyTextSchema,
  nativeAddress: string(),
});

const effectiveEntityKindSchema = union([
  object({ status: literal("ordinary") }),
  object({
    status: literal("effective"),
    kind: literal("digital-asset"),
    basis: literal("assertion"),
  }),
]);

const factReferenceSchema = union([
  object({
    kind: literal("metadata"),
    target: descriptionTargetSchema,
    sourceSlot: string(),
    sourceRecordIds: array(string()),
  }),
  object({ kind: literal("artifact-association"), associationId: string() }),
  object({ kind: literal("artifact-role-decision"), decisionId: string() }),
]);

const factConflictSchema = object({
  kind: nonEmptyTextSchema,
  property: optional(string()),
  role: optional(string()),
  references: array(factReferenceSchema),
  explanation: string(),
});

const metadataValueSchema = object({
  value: string(),
  sourceIdentity: nonEmptyTextSchema,
  sourceSlot: nonEmptyTextSchema,
  sourceRecordIds: array(string()),
  reasoning: jsonValueSchema,
  assertions: array(
    object({
      target: descriptionTargetSchema,
      sourceSlot: string(),
      sourceRecordIds: array(string()),
    }),
  ),
  qualifiers: optional(array(object({ key: string(), value: string() }))),
});

const metadataResultSchema = union([
  object({ status: literal("missing") }),
  object({ status: literal("resolved"), values: array(metadataValueSchema) }),
  object({ status: literal("conflict"), conflict: factConflictSchema }),
]);

export const currentAssetSchema = object({
  id: nonEmptyTextSchema,
  sourceAssociations: array(sourceAssociationSchema),
  recognitionSourceAssociation: optional(sourceAssociationSchema),
  descriptions: array(
    object({
      target: descriptionTargetSchema,
      metadataUsageContext: nonEmptyTextSchema,
      metadata: array(
        object({ property: nonEmptyTextSchema, result: metadataResultSchema }),
      ),
      metadataScope: jsonValueSchema,
      artifactRoles: array(
        object({
          role: nonEmptyTextSchema,
          artifactId: nonEmptyTextSchema,
          associationIds: array(string()),
          observedArtifactParts: optional(
            array(
              object({
                associationId: nonEmptyTextSchema,
                artifactId: nonEmptyTextSchema,
                revisionId: nonEmptyTextSchema,
                locator: nonEmptyTextSchema,
              }),
            ),
          ),
          locationId: optional(string()),
          address: optional(string()),
        }),
      ),
      missingArtifactRoles: array(string()),
      conflicts: array(factConflictSchema),
    }),
  ),
  relatedEntities: array(
    object({
      id: nonEmptyTextSchema,
      kind: effectiveEntityKindSchema,
      label: string(),
      sourceIdentity: optional(string()),
      identityNamespace: optional(string()),
      sourceKey: optional(string()),
    }),
  ),
  relationships: array(
    object({
      id: nonEmptyTextSchema,
      type: nonEmptyTextSchema,
      participants: array(
        object({
          entityId: nonEmptyTextSchema,
          role: string(),
          mentionIds: optional(array(string())),
        }),
      ),
      sourceRecordIds: array(string()),
      qualifiers: optional(array(object({ key: string(), value: string() }))),
    }),
  ),
  locations: array(
    object({
      id: nonEmptyTextSchema,
      artifactId: nonEmptyTextSchema,
      kind: union([literal("observed"), literal("managed")]),
      address: string(),
      content: union([
        object({ status: literal("unconfirmed") }),
        object({
          status: literal("confirmed"),
          target: object({
            kind: literal("artifact-revision"),
            artifactId: nonEmptyTextSchema,
            revisionId: nonEmptyTextSchema,
          }),
        }),
      ]),
      byteLength: optional(pipe(number(), integer(), minValue(0))),
    }),
  ),
  informationReadiness: optional(jsonValueSchema),
  sourceArtifacts: optional(
    array(
      object({
        role: nonEmptyTextSchema,
        mediaType: nonEmptyTextSchema,
        selectionEvidence: optional(jsonValueSchema),
      }),
    ),
  ),
});

export const assetPageSchema = object({
  items: array(currentAssetSchema),
  nextCursor: optional(nonEmptyTextSchema),
});

const relationshipParticipantSchema = object({
  entityId: nonEmptyTextSchema,
  role: nonEmptyTextSchema,
});

const relationshipDraftSchema = object({
  type: nonEmptyTextSchema,
  participants: pipe(array(relationshipParticipantSchema), minLength(2)),
  qualifiers: optional(
    array(object({ key: nonEmptyTextSchema, value: string() })),
  ),
});

export const publicRelationshipChangeSchema = union([
  object({
    kind: literal("create"),
    definitionId: nonEmptyTextSchema,
    relationship: relationshipDraftSchema,
  }),
  object({
    kind: literal("replace"),
    targetRelationshipId: nonEmptyTextSchema,
    definitionId: nonEmptyTextSchema,
    relationship: relationshipDraftSchema,
  }),
  object({
    kind: union([literal("select"), literal("exclude"), literal("clear")]),
    targetRelationshipId: nonEmptyTextSchema,
  }),
]);

export const publicRelationshipTypeDefinitionSchema = object({
  id: nonEmptyTextSchema,
  type: nonEmptyTextSchema,
  label: nonEmptyTextSchema,
  roles: array(
    object({
      role: nonEmptyTextSchema,
      label: nonEmptyTextSchema,
      minimum: pipe(number(), integer(), minValue(0)),
      maximum: optional(pipe(number(), integer(), minValue(0))),
    }),
  ),
  additionalRoles: optional(object({ label: nonEmptyTextSchema })),
  qualifiers: array(
    object({ key: nonEmptyTextSchema, label: nonEmptyTextSchema }),
  ),
});

export const publicRelatedEntityIdentitySchema = object({
  id: nonEmptyTextSchema,
  label: string(),
  kind: effectiveEntityKindSchema,
  identity: union([literal("local"), literal("source")]),
});

const publicRelationshipParticipantEntitySchema = object({
  id: nonEmptyTextSchema,
  label: string(),
  kind: effectiveEntityKindSchema,
  sourceIdentity: optional(string()),
  sourceKey: optional(string()),
  identityNamespace: optional(string()),
});

const publicCatalogueEntityRelationshipSchema = object({
  id: nonEmptyTextSchema,
  type: nonEmptyTextSchema,
  participants: array(relationshipParticipantSchema),
  qualifiers: optional(array(object({ key: string(), value: string() }))),
  sources: array(
    object({ sourceIdentity: nonEmptyTextSchema, nativeAddress: string() }),
  ),
});

export const publicEntityMentionResolutionSchema = object({
  mentionId: nonEmptyTextSchema,
  label: string(),
  entityId: optional(nonEmptyTextSchema),
  basis: optional(union([literal("source"), literal("manual")])),
  decisionId: optional(nonEmptyTextSchema),
  actorId: optional(nonEmptyTextSchema),
  sourceRecordIds: array(string()),
  baseline: nonEmptyTextSchema,
});

const publicMetadataConflictSchema = object({
  subjectId: nonEmptyTextSchema,
  property: nonEmptyTextSchema,
  reason: union([literal("policy-conflict"), literal("multiple-values")]),
  cardinality: union([literal("one"), literal("conflicting")]),
  metadataUsageContext: nonEmptyTextSchema,
});

export const relatedEntityInspectionSchema = object({
  entity: publicRelationshipParticipantEntitySchema,
  relationships: array(publicCatalogueEntityRelationshipSchema),
  metadata: array(
    object({
      subjectId: nonEmptyTextSchema,
      property: nonEmptyTextSchema,
      value: string(),
      sourceIdentity: optional(nonEmptyTextSchema),
    }),
  ),
  metadataConflicts: array(publicMetadataConflictSchema),
  accepted: array(currentAssetSchema),
});

export const relationshipChangePreviewSchema = object({
  baseline: nonEmptyTextSchema,
  changes: array(publicRelationshipChangeSchema),
  relationships: array(publicCatalogueEntityRelationshipSchema),
});

export const publicEntityIdentityMergePreviewSchema = object({
  retainedEntityId: nonEmptyTextSchema,
  mergedEntityId: nonEmptyTextSchema,
  members: array(nonEmptyTextSchema),
  relationshipIds: array(nonEmptyTextSchema),
  metadata: array(
    object({
      entityId: nonEmptyTextSchema,
      property: nonEmptyTextSchema,
      value: string(),
    }),
  ),
  metadataConflicts: array(publicMetadataConflictSchema),
  metadataPolicyBaseline: nonEmptyTextSchema,
  effectiveKind: effectiveEntityKindSchema,
  baseline: nonEmptyTextSchema,
  mergeId: optional(nonEmptyTextSchema),
});

export const relationshipStatusSchema = object({
  status: union([literal("applied")]),
});

export const relationshipTypeDefinitionListSchema = array(
  publicRelationshipTypeDefinitionSchema,
);

export const listRelatedEntitiesRequestSchema = object({
  label: pipe(string(), minLength(1), maxLength(2048)),
});

export const relatedEntityIdRequestSchema = object({
  entityId: nonEmptyTextSchema,
});

export const entityMentionIdRequestSchema = object({
  mentionId: nonEmptyTextSchema,
});

export const createRelatedEntityRequestSchema = object({
  commitmentId: nonEmptyTextSchema,
  label: pipe(string(), minLength(1), maxLength(2048)),
  actorId: nonEmptyTextSchema,
});

export const relatedEntityIdentityListSchema = array(
  publicRelatedEntityIdentitySchema,
);

export const relationshipChangeRequestSchema = object({
  changes: pipe(array(publicRelationshipChangeSchema), minLength(1)),
});

export const applyRelationshipChangeRequestSchema = object({
  actorId: nonEmptyTextSchema,
  preview: relationshipChangePreviewSchema,
});

export const resolveEntityMentionRequestSchema = object({
  entityId: nonEmptyTextSchema,
  actorId: nonEmptyTextSchema,
  baseline: nonEmptyTextSchema,
});

export const retractEntityMentionRequestSchema = object({
  actorId: nonEmptyTextSchema,
  baseline: nonEmptyTextSchema,
});

export const entityIdentityMergeRequestSchema = object({
  retainedEntityId: nonEmptyTextSchema,
  mergedEntityId: nonEmptyTextSchema,
});

export const applyEntityIdentityMergeRequestSchema = object({
  commitmentId: nonEmptyTextSchema,
  actorId: nonEmptyTextSchema,
  preview: publicEntityIdentityMergePreviewSchema,
});

export const undoEntityIdentityMergeRequestSchema =
  applyEntityIdentityMergeRequestSchema;

export type PublicRelationshipChange = InferOutput<
  typeof publicRelationshipChangeSchema
>;
export type PublicRelationshipTypeDefinition = InferOutput<
  typeof publicRelationshipTypeDefinitionSchema
>;
export type PublicRelatedEntityIdentity = InferOutput<
  typeof publicRelatedEntityIdentitySchema
>;
export type PublicRelatedEntityInspection = InferOutput<
  typeof relatedEntityInspectionSchema
>;
export type PublicRelationshipChangePreview = InferOutput<
  typeof relationshipChangePreviewSchema
>;
export type PublicEntityMentionResolution = InferOutput<
  typeof publicEntityMentionResolutionSchema
>;
export type PublicEntityIdentityMergePreview = InferOutput<
  typeof publicEntityIdentityMergePreviewSchema
>;
export type CreateRelatedEntityRequest = InferOutput<
  typeof createRelatedEntityRequestSchema
>;
export type ResolveEntityMentionRequest = InferOutput<
  typeof resolveEntityMentionRequestSchema
>;
export type RetractEntityMentionRequest = InferOutput<
  typeof retractEntityMentionRequestSchema
>;
export type EntityIdentityMergeRequest = InferOutput<
  typeof entityIdentityMergeRequestSchema
>;
export type ApplyEntityIdentityMergeRequest = InferOutput<
  typeof applyEntityIdentityMergeRequestSchema
>;
const unrecognizedMaterialCoordinatesSchema = {
  parentExecutionId: nonEmptyTextSchema,
  directoryKey: nonEmptyTextSchema,
  childExecutionId: nonEmptyTextSchema,
  observedRootId: nonEmptyTextSchema,
  relativeScope: string(),
  relativePaths: pipe(array(string()), minLength(1)),
};
export const unrecognizedMaterialSchema = union([
  object({
    kind: literal("work-item"),
    ...unrecognizedMaterialCoordinatesSchema,
    workItemKey: nonEmptyTextSchema,
  }),
  object({
    kind: literal("filesystem-observation"),
    ...unrecognizedMaterialCoordinatesSchema,
    observationId: nonEmptyTextSchema,
  }),
]);
export const unrecognizedMaterialPageSchema = object({
  items: array(unrecognizedMaterialSchema),
  nextCursor: optional(nonEmptyTextSchema),
});
export const assetLibraryListSchema = object({
  items: array(assetLibrarySchema),
  nextCursor: optional(nonEmptyTextSchema),
});
export const publicApiErrorResponseSchema = object({
  error: publicApiErrorSchema,
});

export const listAssetsRequestSchema = object({
  assetLibraryId: optional(nonEmptyTextSchema),
  limit: optional(pageLimitSchema),
  cursor: optional(nonEmptyTextSchema),
});
export const listAssetLibrariesRequestSchema = object({
  limit: optional(pageLimitSchema),
  cursor: optional(nonEmptyTextSchema),
});
export const listUnrecognizedMaterialsRequestSchema = object({
  assetLibraryId: optional(nonEmptyTextSchema),
  parentExecutionId: optional(nonEmptyTextSchema),
  limit: optional(pageLimitSchema),
  cursor: optional(nonEmptyTextSchema),
});

export type PublicAssetLibraryOptions = InferOutput<
  typeof assetLibraryOptionsSchema
>;
export type SaveAssetLibraryRequest = InferOutput<
  typeof saveAssetLibraryRequestSchema
>;
export type UpdateAssetLibraryRequest = InferOutput<
  typeof updateAssetLibraryRequestSchema
>;
export type RemoveAssetLibraryRequest = InferOutput<
  typeof removeAssetLibraryRequestSchema
>;
export type PublicAssetLibraryScan = InferOutput<typeof assetLibraryScanSchema>;

export type PublicApiError = InferOutput<typeof publicApiErrorSchema>;
export type PublicCurrentAsset = InferOutput<typeof currentAssetSchema>;
export type PublicAssetLibrary = InferOutput<typeof assetLibrarySchema>;
export type PublicUnrecognizedMaterial = InferOutput<
  typeof unrecognizedMaterialSchema
>;
export type PublicPage<Item> = {
  readonly items: readonly Item[];
  readonly nextCursor?: string | undefined;
};
export type ListAssetsRequest = InferOutput<typeof listAssetsRequestSchema>;
export type ListAssetLibrariesRequest = InferOutput<
  typeof listAssetLibrariesRequestSchema
>;
export type ListUnrecognizedMaterialsRequest = InferOutput<
  typeof listUnrecognizedMaterialsRequestSchema
>;
