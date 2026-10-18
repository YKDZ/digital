import {
  array,
  boolean,
  integer,
  literal,
  maxLength,
  minLength,
  minValue,
  maxValue,
  number,
  object,
  optional,
  pipe,
  string,
  union,
  type InferOutput,
} from "valibot";

const nonEmptyTextSchema = pipe(string(), minLength(1), maxLength(2048));

export const publicAutomationIntentSchema = object({
  id: nonEmptyTextSchema,
  scope: object({
    assetLibraryId: nonEmptyTextSchema,
    directoryId: optional(nonEmptyTextSchema),
    relativeScope: nonEmptyTextSchema,
  }),
  enabled: boolean(),
  disabledReason: optional(
    union([
      literal("observed-root-revoked"),
      literal("observed-root-unavailable"),
      literal("prerequisite-unavailable"),
      literal("invalid-configuration"),
    ]),
  ),
  intervalMilliseconds: pipe(
    number(),
    integer(),
    minValue(1),
    maxValue(Number.MAX_SAFE_INTEGER),
  ),
  acceptTrusted: boolean(),
});

export const publicAutomationIntentListSchema = object({
  items: array(publicAutomationIntentSchema),
});

export const enableAutomationIntentRequestSchema = object({
  assetLibraryId: nonEmptyTextSchema,
  directoryId: nonEmptyTextSchema,
  relativeScope: optional(nonEmptyTextSchema),
  intervalMilliseconds: pipe(
    number(),
    integer(),
    minValue(1),
    maxValue(Number.MAX_SAFE_INTEGER),
  ),
  acceptTrusted: boolean(),
});

export const automationIntentIdRequestSchema = object({
  intentId: nonEmptyTextSchema,
});

export const publicAutomationTriggerResultSchema = union([
  object({ status: literal("started"), executionId: nonEmptyTextSchema }),
  object({ status: literal("skipped"), reason: nonEmptyTextSchema }),
  object({ status: literal("disabled"), reason: nonEmptyTextSchema }),
]);

export const enableAutomationIntentResultSchema = object({
  intent: publicAutomationIntentSchema,
  initial: optional(publicAutomationTriggerResultSchema),
});

export const disableAutomationIntentResultSchema = object({
  status: literal("disabled"),
});

export type PublicAutomationIntent = InferOutput<
  typeof publicAutomationIntentSchema
>;
export type EnableAutomationIntentRequest = InferOutput<
  typeof enableAutomationIntentRequestSchema
>;
export type EnableAutomationIntentResult = InferOutput<
  typeof enableAutomationIntentResultSchema
>;
export type PublicAutomationTriggerResult = InferOutput<
  typeof publicAutomationTriggerResultSchema
>;
