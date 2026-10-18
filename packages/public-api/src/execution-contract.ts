import {
  array,
  boolean,
  integer,
  literal,
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

const nonEmptyTextSchema = pipe(string(), minLength(1));

const executionStatusSchema = union([
  literal("running"),
  literal("completed"),
  literal("failed"),
]);

const executionOutcomeSchema = union([
  literal("unresolved"),
  literal("proposal"),
  literal("accepted"),
  literal("partially-succeeded"),
  literal("failed"),
  literal("interrupted"),
  literal("cancelled"),
  literal("no-change"),
]);

const executionOperationKindSchema = union([
  literal("scan-filesystem"),
  literal("scan-asset-library"),
  literal("refresh-metadata"),
  literal("rescrape"),
  literal("associate-observed-material"),
]);

const executionStageSchema = union([
  literal("recognition"),
  literal("source-records-retained"),
  literal("source-artifacts-acquired"),
  literal("source-artifacts-stored"),
  literal("cover-acquired"),
  literal("cover-stored"),
  literal("completed"),
  literal("failed"),
]);

const cancellationDetailsSchema = object({
  requestedBy: nonEmptyTextSchema,
  requestedAt: nonEmptyTextSchema,
  reason: optional(string()),
});

const refreshOperationRequestSchema = union([
  object({
    operation: literal("rescrape"),
    subjectId: nonEmptyTextSchema,
  }),
  object({
    operation: literal("metadata-refresh"),
    subjectId: nonEmptyTextSchema,
    reviewPolicy: optional(union([literal("automatic"), literal("review")])),
  }),
]);

const sourceRefreshCoverageSchema = object({
  sourceIdentity: nonEmptyTextSchema,
  nativeAddress: string(),
  coverageId: nonEmptyTextSchema,
});

const sourceRefreshSelectorSchema = union([
  object({
    kind: literal("metadata-property"),
    property: nonEmptyTextSchema,
  }),
  object({
    kind: literal("relationship-type"),
    relationshipType: nonEmptyTextSchema,
  }),
  object({
    kind: literal("artifact-fact-family"),
    family: nonEmptyTextSchema,
  }),
  object({
    kind: literal("extension"),
    namespace: nonEmptyTextSchema,
    key: nonEmptyTextSchema,
  }),
]);

const sourceRefreshScopeSchema = object({
  coverage: sourceRefreshCoverageSchema,
  baselineSourceRecordId: optional(nonEmptyTextSchema),
  state: union([
    literal("planned"),
    literal("acquiring"),
    literal("awaiting-review"),
    literal("applying"),
    literal("terminal"),
  ]),
  acquisitionAttempt: pipe(number(), integer(), minValue(0)),
  changeSetId: optional(nonEmptyTextSchema),
  candidateSourceRecordId: optional(nonEmptyTextSchema),
  outcome: optional(
    union([
      literal("applied"),
      literal("unchanged"),
      literal("failed"),
      literal("skipped"),
      literal("cancelled"),
      literal("stale"),
    ]),
  ),
  reason: optional(string()),
});

export const sourceRefreshChangeSetSchema = object({
  id: nonEmptyTextSchema,
  runId: nonEmptyTextSchema,
  coverage: sourceRefreshCoverageSchema,
  baselineSourceRecordId: optional(nonEmptyTextSchema),
  candidateSourceRecordId: nonEmptyTextSchema,
  changes: array(
    object({
      kind: union([
        literal("established"),
        literal("superseded"),
        literal("retracted"),
        literal("unchanged"),
        literal("conflicted"),
        literal("skipped"),
        literal("rejected"),
      ]),
      factReference: nonEmptyTextSchema,
    }),
  ),
  requiresReview: boolean(),
  disposition: union([
    literal("automatic"),
    literal("pending"),
    literal("approved"),
    literal("rejected"),
  ]),
});

export const sourceRefreshRunSchema = object({
  id: nonEmptyTextSchema,
  initiatedBy: nonEmptyTextSchema,
  initiatedAt: nonEmptyTextSchema,
  requestedSelection: object({
    subjectId: nonEmptyTextSchema,
    sourceAssociationId: nonEmptyTextSchema,
    sourceIdentity: nonEmptyTextSchema,
    nativeAddress: string(),
    selectors: array(sourceRefreshSelectorSchema),
  }),
  reviewPolicy: union([literal("automatic"), literal("review")]),
  phase: union([
    literal("planning"),
    literal("acquiring"),
    literal("reviewing"),
    literal("applying"),
    literal("terminal"),
  ]),
  outcome: optional(
    union([
      literal("succeeded"),
      literal("partially-succeeded"),
      literal("failed"),
      literal("cancelled"),
    ]),
  ),
  scopes: array(sourceRefreshScopeSchema),
  changeSets: array(sourceRefreshChangeSetSchema),
});

export type PublicSourceRefreshRun = InferOutput<typeof sourceRefreshRunSchema>;

const publicExecutionProgressSchema = object({
  dispositions: array(
    object({
      key: nonEmptyTextSchema,
      status: union([
        literal("running"),
        literal("completed"),
        literal("failed"),
        literal("skipped"),
        literal("reused"),
        literal("no-change"),
      ]),
      reason: optional(string()),
    }),
  ),
  workItems: array(
    object({
      key: nonEmptyTextSchema,
      relativePaths: array(string()),
      retainedAssetId: optional(nonEmptyTextSchema),
      plannedAssetId: optional(nonEmptyTextSchema),
      acceptedAssetId: optional(nonEmptyTextSchema),
      outcome: optional(executionOutcomeSchema),
      reason: optional(string()),
    }),
  ),
  targets: array(
    object({
      key: nonEmptyTextSchema,
      kind: union([literal("subject"), literal("filesystem-scope")]),
      subjectId: optional(nonEmptyTextSchema),
      status: union([
        literal("running"),
        literal("completed"),
        literal("reused"),
        literal("skipped"),
        literal("blocked"),
        literal("failed"),
        literal("no-change"),
      ]),
      reason: optional(string()),
    }),
  ),
});

const workflowExecutionDetailsSchema = object({
  status: executionStatusSchema,
  stage: executionStageSchema,
  outcome: optional(executionOutcomeSchema),
  reason: optional(string()),
  cancellation: optional(cancellationDetailsSchema),
  progress: publicExecutionProgressSchema,
  sourceRefreshRuns: array(sourceRefreshRunSchema),
});

const workflowExecutionInspectionSchema = object({
  kind: literal("execution"),
  id: nonEmptyTextSchema,
  operationKind: optional(executionOperationKindSchema),
  ...workflowExecutionDetailsSchema.entries,
});

const libraryScanParentInspectionSchema = object({
  kind: literal("asset-library-scan"),
  id: nonEmptyTextSchema,
  status: executionStatusSchema,
  outcome: optional(executionOutcomeSchema),
  cancellationRequested: optional(cancellationDetailsSchema),
  children: array(
    union([
      object({
        executionId: nonEmptyTextSchema,
        status: literal("missing"),
      }),
      object({
        executionId: nonEmptyTextSchema,
        status: literal("available"),
        execution: workflowExecutionDetailsSchema,
      }),
    ]),
  ),
});

export const publicRefreshOperationRequestSchema =
  refreshOperationRequestSchema;

export const publicRefreshExecutionIdSchema = object({
  id: nonEmptyTextSchema,
});

export const publicExecutionInspectionSchema = union([
  workflowExecutionInspectionSchema,
  libraryScanParentInspectionSchema,
]);

export const publicExecutionCancellationRequestSchema = object({
  reason: optional(string()),
});

export const publicExecutionCancellationSchema = object({
  requestStatus: union([literal("requested"), literal("already-finished")]),
  inspection: publicExecutionInspectionSchema,
});

export type PublicRefreshOperationRequest = InferOutput<
  typeof publicRefreshOperationRequestSchema
>;
export type PublicRefreshExecutionId = InferOutput<
  typeof publicRefreshExecutionIdSchema
>;
export type PublicExecutionInspection = InferOutput<
  typeof publicExecutionInspectionSchema
>;
export type PublicExecutionCancellationRequest = InferOutput<
  typeof publicExecutionCancellationRequestSchema
>;
export type PublicExecutionCancellation = InferOutput<
  typeof publicExecutionCancellationSchema
>;
