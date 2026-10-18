import {
  array,
  literal,
  maxLength,
  minLength,
  object,
  optional,
  pipe,
  regex,
  string,
  union,
  type InferOutput,
} from "valibot";

const coordinateTextSchema = pipe(string(), minLength(1), maxLength(2048));

export const prepareMetadataDecisionRequestSchema = union([
  object({
    kind: literal("pin"),
    property: coordinateTextSchema,
    metadataUsageContext: optional(coordinateTextSchema),
    value: pipe(string(), regex(/\S/)),
  }),
  object({
    kind: literal("adopt"),
    property: coordinateTextSchema,
    metadataUsageContext: optional(coordinateTextSchema),
    candidateReference: coordinateTextSchema,
  }),
  object({
    kind: literal("clear"),
    property: coordinateTextSchema,
    metadataUsageContext: optional(coordinateTextSchema),
  }),
]);

const metadataDecisionStateSchema = union([
  object({
    status: literal("resolved"),
    values: array(
      object({ value: string(), sourceIdentity: coordinateTextSchema }),
    ),
  }),
  object({
    status: literal("missing"),
    values: array(
      object({ value: string(), sourceIdentity: coordinateTextSchema }),
    ),
  }),
  object({
    status: literal("conflict"),
    values: array(
      object({ value: string(), sourceIdentity: coordinateTextSchema }),
    ),
  }),
]);

export const metadataDecisionPreviewSchema = object({
  previewId: coordinateTextSchema,
  assetId: coordinateTextSchema,
  property: coordinateTextSchema,
  metadataUsageContext: coordinateTextSchema,
  kind: union([literal("pin"), literal("clear")]),
  value: optional(string()),
  adoptedFromSourceIdentity: optional(coordinateTextSchema),
  status: union([
    literal("awaiting-confirmation"),
    literal("applied"),
    literal("stale"),
    literal("rejected"),
  ]),
  current: metadataDecisionStateSchema,
  projected: metadataDecisionStateSchema,
  impact: coordinateTextSchema,
  blockingConditions: array(string()),
});

export type PrepareMetadataDecisionRequest = InferOutput<
  typeof prepareMetadataDecisionRequestSchema
>;
export type MetadataDecisionPreview = InferOutput<
  typeof metadataDecisionPreviewSchema
>;

export type PublicMetadataDecisionClientMethods = {
  prepareMetadataDecision(
    assetId: string,
    input: PrepareMetadataDecisionRequest,
  ): Promise<MetadataDecisionPreview>;
  confirmMetadataDecision(previewId: string): Promise<MetadataDecisionPreview>;
  cancelMetadataDecision(previewId: string): Promise<MetadataDecisionPreview>;
};
