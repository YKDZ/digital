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
  optional,
  pipe,
  regex,
  string,
  strictObject,
  union,
  type InferOutput,
} from "valibot";

const nonEmptyTextSchema = pipe(string(), minLength(1), maxLength(2048));
const artifactRevisionIdSchema = pipe(string(), minLength(1), maxLength(256));
const digestSchema = pipe(string(), regex(/^[a-f0-9]{64}$/u));

const consumerPlaybackCapabilitiesSchema = strictObject({
  contractVersion: literal("consumer-playback/1"),
  supportsByteRanges: boolean(),
  media: pipe(
    array(
      strictObject({
        mediaType: pipe(
          string(),
          minLength(1),
          maxLength(255),
          regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u),
        ),
        codecs: optional(
          pipe(
            array(pipe(string(), minLength(1), maxLength(127), regex(/\S/u))),
            maxLength(32),
          ),
        ),
      }),
    ),
    maxLength(128),
  ),
});

const playbackPreferencesSchema = strictObject({
  audioTrackId: optional(
    pipe(string(), minLength(1), maxLength(256), regex(/\S/u)),
  ),
  subtitleTrackId: optional(
    pipe(string(), minLength(1), maxLength(256), regex(/\S/u)),
  ),
  quality: optional(literal("source")),
});

export const playbackPlanRequestSchema = strictObject({
  consumer: consumerPlaybackCapabilitiesSchema,
  preferences: playbackPreferencesSchema,
});

const playbackIncompatibilityReasonSchema = union([
  literal("format-unknown"),
  literal("byte-ranges-required"),
  literal("container-unsupported"),
  literal("codec-unsupported"),
  literal("preference-unavailable"),
]);

export const publicPlaybackPlanSchema = union([
  strictObject({
    status: literal("incompatible"),
    reason: playbackIncompatibilityReasonSchema,
  }),
  strictObject({
    status: literal("ready"),
    revisionId: artifactRevisionIdSchema,
    blobDigest: digestSchema,
    rendition: strictObject({
      kind: literal("direct"),
      mediaType: nonEmptyTextSchema,
      codecs: array(string()),
      byteLength: pipe(
        number(),
        integer(),
        minValue(0),
        maxValue(Number.MAX_SAFE_INTEGER),
      ),
    }),
    mediaUrl: nonEmptyTextSchema,
  }),
]);

export const confirmedObservedMaterialSchema = strictObject({
  artifactRevisionId: artifactRevisionIdSchema,
  blobDigest: digestSchema,
  byteLength: pipe(
    number(),
    integer(),
    minValue(0),
    maxValue(Number.MAX_SAFE_INTEGER),
  ),
  mediaType: nonEmptyTextSchema,
});

export const playbackInteractionStateSchema = strictObject({
  artifactRevisionId: artifactRevisionIdSchema,
  positionMilliseconds: pipe(
    number(),
    integer(),
    minValue(0),
    maxValue(Number.MAX_SAFE_INTEGER),
  ),
  completed: boolean(),
});

export const playbackInteractionListSchema = strictObject({
  items: array(playbackInteractionStateSchema),
});

export const savePlaybackInteractionRequestSchema =
  playbackInteractionStateSchema;
export const playbackInteractionReadRequestSchema = strictObject({
  artifactRevisionIds: pipe(array(artifactRevisionIdSchema), maxLength(128)),
});
export const playbackInteractionSavedSchema = strictObject({
  status: literal("saved"),
});

export type PlaybackPlanRequest = InferOutput<typeof playbackPlanRequestSchema>;
export type PublicPlaybackPlan = InferOutput<typeof publicPlaybackPlanSchema>;
export type ConfirmedObservedMaterial = InferOutput<
  typeof confirmedObservedMaterialSchema
>;
export type PublicPlaybackInteraction = InferOutput<
  typeof playbackInteractionStateSchema
>;
