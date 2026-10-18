import {
  array,
  boolean,
  integer,
  maxLength,
  minLength,
  minValue,
  number,
  object,
  optional,
  pipe,
  string,
  union,
  literal,
  type InferOutput,
} from "valibot";

const coordinateSchema = pipe(string(), minLength(1), maxLength(2048));
const associationSchema = object({
  sourceIdentity: coordinateSchema,
  nativeAddress: string(),
});

const projectionSchema = object({
  recognitionState: optional(
    union([literal("recognized"), literal("unresolved")]),
  ),
  recognitionDecisionId: optional(coordinateSchema),
  sourceAssociations: array(associationSchema),
  recognitionSourceAssociation: optional(associationSchema),
});

export const changeImpactPreviewSchema = object({
  previewId: coordinateSchema,
  executionId: coordinateSchema,
  assetId: coordinateSchema,
  status: union([
    literal("awaiting-confirmation"),
    literal("rejected"),
    literal("applied"),
    literal("stale"),
  ]),
  current: projectionSchema,
  projected: projectionSchema,
  evidenceConflicts: array(string()),
  blockingConditions: array(string()),
  primaryCoverArtifactId: optional(coordinateSchema),
});

export const recognitionRetractionRequestSchema = object({
  assetId: coordinateSchema,
  predecessorDecisionId: coordinateSchema,
  proposedBy: coordinateSchema,
  reason: coordinateSchema,
});

export const sourceAssociationHistorySchema = object({
  recognitionState: union([literal("recognized"), literal("unresolved")]),
  recognitionDecisionId: optional(coordinateSchema),
  current: array(
    object({
      id: coordinateSchema,
      subjectId: coordinateSchema,
      sourceIdentity: coordinateSchema,
      nativeAddress: string(),
    }),
  ),
  historical: array(
    object({
      association: object({
        id: coordinateSchema,
        subjectId: coordinateSchema,
        sourceIdentity: coordinateSchema,
        nativeAddress: string(),
      }),
      status: union([
        literal("superseded"),
        literal("retracted"),
        literal("legacy-retired"),
      ]),
      authorizedBy: optional(
        object({
          kind: coordinateSchema,
          id: optional(coordinateSchema),
        }),
      ),
    }),
  ),
});

export const recognitionScopeAmendmentRequestSchema = object({
  sourceExecutionId: coordinateSchema,
  workItemKey: coordinateSchema,
  decisionId: optional(coordinateSchema),
  proposedBy: coordinateSchema,
  reason: coordinateSchema,
});

export const changeImpactPreviewIdRequestSchema = object({
  previewId: coordinateSchema,
});
export const changeImpactConfirmationRequestSchema = object({
  confirmedBy: coordinateSchema,
});
export const changeImpactRejectionRequestSchema = object({
  rejectedBy: coordinateSchema,
});

export const artifactRoleCoverInspectionSchema = object({
  entityId: coordinateSchema,
  candidates: array(
    object({
      reference: coordinateSchema,
      kind: union([literal("observed"), literal("managed")]),
      title: string(),
    }),
  ),
  effectiveReference: optional(coordinateSchema),
  decision: optional(
    object({
      kind: union([literal("select"), literal("clear")]),
      reference: optional(coordinateSchema),
    }),
  ),
  problems: array(string()),
});

export const artifactRoleDecisionRequestSchema = object({
  initiatedBy: coordinateSchema,
  candidateReference: optional(coordinateSchema),
});

export const observedMaterialAssociationRequestSchema = object({
  targetAssetId: coordinateSchema,
  assetLibraryId: coordinateSchema,
  directoryId: coordinateSchema,
  relativeScope: string(),
  relativePaths: pipe(array(string()), minLength(1)),
  initiatedBy: coordinateSchema,
});
export const observedMaterialAssociationStartSchema = object({
  executionId: coordinateSchema,
});
export const observedMaterialAssociationInspectionSchema = object({
  executionId: coordinateSchema,
  status: union([
    literal("created"),
    literal("observing"),
    literal("inspecting"),
    literal("awaiting-confirmation"),
    literal("confirmation-recorded"),
    literal("revalidating"),
    literal("accepted"),
    literal("no-change"),
    literal("stale"),
    literal("failed"),
    literal("interrupted"),
  ]),
  failure: optional(
    union([
      literal("invalid-target"),
      literal("authority-stale"),
      literal("material-stale"),
      literal("unavailable"),
      literal("interrupted"),
    ]),
  ),
  reason: optional(string()),
  target: object({ id: coordinateSchema, title: optional(string()) }),
  observedRoot: object({
    id: coordinateSchema,
    displayName: optional(string()),
    relativeScope: string(),
  }),
  files: array(
    object({
      relativePath: string(),
      byteLength: pipe(number(), integer(), minValue(0)),
      digest: string(),
      mediaType: string(),
      disposition: union([
        literal("new-artifact"),
        literal("existing-artifact"),
      ]),
      formatValid: boolean(),
    }),
  ),
  proposal: object({
    id: string(),
    proposedBy: coordinateSchema,
    materials: array(
      object({
        relativePath: string(),
        role: literal("asset.material-delivered"),
      }),
    ),
  }),
  confirmedBy: optional(coordinateSchema),
  decisionId: optional(coordinateSchema),
  associationIds: optional(array(coordinateSchema)),
});
export const observedMaterialConfirmationRequestSchema = object({
  confirmedBy: coordinateSchema,
});

export const sourceRefreshChangeSetReviewRequestSchema = object({
  changeSetId: coordinateSchema,
  disposition: union([literal("approved"), literal("rejected")]),
});
export const sourceRefreshRunIdRequestSchema = object({
  runId: coordinateSchema,
});

export type PublicChangeImpactPreview = InferOutput<
  typeof changeImpactPreviewSchema
>;
export type RecognitionRetractionRequest = InferOutput<
  typeof recognitionRetractionRequestSchema
>;
export type PublicSourceAssociationHistory = InferOutput<
  typeof sourceAssociationHistorySchema
>;
export type RecognitionScopeAmendmentRequest = InferOutput<
  typeof recognitionScopeAmendmentRequestSchema
>;
export type PublicArtifactRoleCoverInspection = InferOutput<
  typeof artifactRoleCoverInspectionSchema
>;
export type ArtifactRoleDecisionRequest = InferOutput<
  typeof artifactRoleDecisionRequestSchema
>;
export type ObservedMaterialAssociationRequest = InferOutput<
  typeof observedMaterialAssociationRequestSchema
>;
export type PublicObservedMaterialAssociationInspection = InferOutput<
  typeof observedMaterialAssociationInspectionSchema
>;
export type SourceRefreshChangeSetReviewRequest = InferOutput<
  typeof sourceRefreshChangeSetReviewRequestSchema
>;
