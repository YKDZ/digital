import {
  array,
  boolean,
  maxLength,
  minLength,
  object,
  optional,
  pipe,
  record,
  string,
  union,
  literal,
  minValue,
  number,
  integer,
  type InferOutput,
} from "valibot";

import { currentAssetSchema } from "./contract.ts";

const coordinateSchema = pipe(string(), minLength(1), maxLength(2048));
const sourceInputSchema = record(coordinateSchema, string());

export const sourceInputRequirementSchema = object({
  sourceIdentity: coordinateSchema,
  displayName: coordinateSchema,
  fields: array(
    object({
      key: coordinateSchema,
      label: coordinateSchema,
      required: boolean(),
      acceptedInput: coordinateSchema,
      example: optional(string()),
    }),
  ),
});
export const sourceInputRequirementsSchema = array(
  sourceInputRequirementSchema,
);

export const directedRecognitionRequestSchema = object({
  registrationId: coordinateSchema,
  relativeScope: string(),
  sourceIdentity: coordinateSchema,
  sourceInput: sourceInputSchema,
});

const localIntakeFileSchema = object({
  relativePath: string(),
  size: pipe(number(), integer(), minValue(0)),
  assetIds: array(coordinateSchema),
  problem: optional(string()),
});

export const localIntakeRequestSchema = object({
  assetLibraryId: coordinateSchema,
  directoryId: optional(coordinateSchema),
  parentExecutionId: optional(coordinateSchema),
});

export const localIntakeSnapshotSchema = object({
  assetLibraryId: coordinateSchema,
  directories: array(
    object({
      id: coordinateSchema,
      displayName: coordinateSchema,
      status: union([literal("active"), literal("removed")]),
    }),
  ),
  directoryId: optional(coordinateSchema),
  files: array(localIntakeFileSchema),
  contents: array(currentAssetSchema),
  execution: optional(
    object({
      id: coordinateSchema,
      status: union([
        literal("running"),
        literal("completed"),
        literal("failed"),
      ]),
      outcome: optional(string()),
      reason: optional(string()),
    }),
  ),
});

export const prepareLocalContentRequestSchema = object({
  executionId: coordinateSchema,
  relativePaths: pipe(array(string()), minLength(1)),
  name: optional(string()),
  classification: optional(
    union([literal("book"), literal("audio"), literal("video")]),
  ),
});

export const localContentReviewSchema = object({
  executionId: coordinateSchema,
  status: union([literal("proposed"), literal("accepted")]),
  relativePaths: array(string()),
  content: currentAssetSchema,
});

export const localContentExecutionRequestSchema = object({
  executionId: coordinateSchema,
});

export const sourceEnrichmentRequestSchema = object({
  subjectId: coordinateSchema,
  sourceIdentity: coordinateSchema,
  sourceInput: sourceInputSchema,
  assetLibraryId: optional(coordinateSchema),
});

export const sourceEnrichmentRetryRequestSchema = object({
  executionId: coordinateSchema,
  subjectId: coordinateSchema,
  sourceIdentity: coordinateSchema,
});

const publicSourceAssociationSchema = object({
  id: coordinateSchema,
  subjectId: coordinateSchema,
  sourceIdentity: coordinateSchema,
  nativeAddress: string(),
});

export const retryableSourceEnrichmentSchema = object({
  executionId: coordinateSchema,
  subjectId: coordinateSchema,
  sourceIdentity: coordinateSchema,
  canRetry: boolean(),
});
export const retryableSourceEnrichmentListSchema = array(
  retryableSourceEnrichmentSchema,
);

export const sourceEnrichmentInspectionSchema = object({
  executionId: coordinateSchema,
  status: union([literal("running"), literal("completed"), literal("failed")]),
  outcome: optional(string()),
  reason: optional(string()),
  items: array(
    object({
      subjectId: coordinateSchema,
      sourceIdentity: coordinateSchema,
      sourceAddress: string(),
      input: optional(sourceInputSchema),
      status: union([
        literal("running"),
        literal("failed"),
        literal("completed"),
      ]),
      reason: optional(string()),
      canRetry: boolean(),
    }),
  ),
  sourceAssociations: array(
    object({
      sourceIdentity: coordinateSchema,
      nativeAddress: string(),
    }),
  ),
});

export const sourceAssociationDecisionRequestSchema = union([
  object({
    intent: literal("establish"),
    assetId: coordinateSchema,
    sourceIdentity: coordinateSchema,
    sourceInput: sourceInputSchema,
    initiatedBy: coordinateSchema,
  }),
  object({
    intent: literal("replace"),
    assetId: coordinateSchema,
    predecessorAssociationId: coordinateSchema,
    sourceInput: sourceInputSchema,
    initiatedBy: coordinateSchema,
  }),
  object({
    intent: literal("retract"),
    assetId: coordinateSchema,
    predecessorAssociationId: coordinateSchema,
    initiatedBy: coordinateSchema,
    reason: coordinateSchema,
  }),
]);

const sourceAssociationCandidateSchema = object({
  reference: coordinateSchema,
  outcome: union([literal("accepted"), literal("contradicted")]),
  sourceIdentity: coordinateSchema,
  nativeAddress: string(),
  explanation: string(),
  ruleResults: array(
    object({
      ruleId: coordinateSchema,
      ruleVersion: coordinateSchema,
      outcome: union([literal("satisfied"), literal("contradicted")]),
      explanation: string(),
    }),
  ),
});

const sourceAssociationDecisionPreviewSchema = object({
  previewId: coordinateSchema,
  assetId: coordinateSchema,
  status: union([
    literal("awaiting-confirmation"),
    literal("applied"),
    literal("stale"),
    literal("rejected"),
  ]),
  blockingConditions: array(string()),
});

export const sourceAssociationDecisionInspectionSchema = object({
  executionId: coordinateSchema,
  status: union([literal("running"), literal("completed"), literal("failed")]),
  state: coordinateSchema,
  assetId: coordinateSchema,
  intent: union([literal("establish"), literal("replace"), literal("retract")]),
  predecessor: optional(publicSourceAssociationSchema),
  currentAssociations: array(publicSourceAssociationSchema),
  historicalAssociations: array(
    object({
      association: publicSourceAssociationSchema,
      status: union([
        literal("superseded"),
        literal("retracted"),
        literal("legacy-retired"),
      ]),
      authorizedBy: optional(
        object({ kind: coordinateSchema, id: optional(coordinateSchema) }),
      ),
    }),
  ),
  inputRequirements: array(sourceInputRequirementSchema),
  candidates: array(sourceAssociationCandidateSchema),
  failure: optional(string()),
  preview: optional(sourceAssociationDecisionPreviewSchema),
  availableActions: array(
    union([
      literal("select"),
      literal("apply"),
      literal("reject"),
      literal("retry"),
      literal("cancel"),
    ]),
  ),
});

export const sourceAssociationCandidateSelectionSchema = object({
  candidateReference: coordinateSchema,
});

export const sourceAssociationDecisionStartSchema = object({
  executionId: coordinateSchema,
});

export type PublicSourceInputRequirement = InferOutput<
  typeof sourceInputRequirementSchema
>;
export type DirectedRecognitionRequest = InferOutput<
  typeof directedRecognitionRequestSchema
>;
export type PublicLocalIntakeRequest = InferOutput<
  typeof localIntakeRequestSchema
>;
export type PublicLocalIntakeSnapshot = InferOutput<
  typeof localIntakeSnapshotSchema
>;
export type PrepareLocalContentRequest = InferOutput<
  typeof prepareLocalContentRequestSchema
>;
export type PublicLocalContentReview = InferOutput<
  typeof localContentReviewSchema
>;
export type SourceEnrichmentRequest = InferOutput<
  typeof sourceEnrichmentRequestSchema
>;
export type SourceEnrichmentRetryRequest = InferOutput<
  typeof sourceEnrichmentRetryRequestSchema
>;
export type SourceEnrichmentInspection = InferOutput<
  typeof sourceEnrichmentInspectionSchema
>;
export type SourceAssociationDecisionRequest = InferOutput<
  typeof sourceAssociationDecisionRequestSchema
>;
export type SourceAssociationDecisionInspection = InferOutput<
  typeof sourceAssociationDecisionInspectionSchema
>;
