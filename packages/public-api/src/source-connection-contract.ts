import {
  array,
  check,
  integer,
  literal,
  maxLength,
  minLength,
  minValue,
  number,
  object,
  optional,
  pipe,
  regex,
  string,
  trim,
  unknown,
  union,
  type InferOutput,
} from "valibot";

const sourceConnectionIdSchema = pipe(string(), minLength(1), maxLength(512));
const keySourceConnectionIdSchema = union([literal("tmdb"), literal("omdb")]);
const publicSourceConnectionIdSchema = union([
  keySourceConnectionIdSchema,
  literal("bangumi"),
]);
const sourceConnectionVersionSchema = pipe(number(), integer(), minValue(0));
const authorizationAttemptIdSchema = pipe(
  string(),
  minLength(36),
  maxLength(36),
  regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  ),
);

export const publicSourceConnectionSchema = object({
  id: sourceConnectionIdSchema,
  version: sourceConnectionVersionSchema,
  credentialStatus: union([
    literal("unconfigured"),
    literal("configured"),
    literal("revoked"),
    literal("invalid"),
  ]),
  availability: union([literal("available"), literal("unavailable")]),
  verifiedAt: optional(pipe(string(), maxLength(64))),
  reason: optional(
    union([
      literal("not-configured"),
      literal("revoked"),
      literal("verification-pending"),
      literal("verification-failed"),
      literal("authorization-failed"),
      literal("authorization-uncertain"),
      literal("storage-invalid"),
      literal("permissions-unsafe"),
    ]),
  ),
});

export const publicSourceConnectionListSchema = object({
  items: array(publicSourceConnectionSchema),
});

export const sourceConnectionStateResponseSchema = publicSourceConnectionSchema;

export const sourceConnectionVerificationSchema = object({
  connection: publicSourceConnectionSchema,
  verification: union([
    literal("verified"),
    literal("failed"),
    literal("superseded"),
  ]),
});

export const sourceConnectionMutationRequestSchema = object({
  expectedVersion: sourceConnectionVersionSchema,
  secret: pipe(string(), trim(), minLength(1), maxLength(4096)),
});

export const sourceConnectionRevocationRequestSchema = object({
  expectedVersion: sourceConnectionVersionSchema,
});

export const sourceConnectionIdRequestSchema = object({
  sourceId: publicSourceConnectionIdSchema,
});

export const sourceConnectionRevokedSchema = object({
  connection: publicSourceConnectionSchema,
  revoked: literal(true),
});

export const bangumiAuthorizationStartSchema = object({
  attemptId: authorizationAttemptIdSchema,
  authorizationUrl: pipe(string(), minLength(1), maxLength(4096)),
  expiresAt: pipe(string(), maxLength(64)),
});

export const bangumiOAuthClientConfigurationRequestSchema = object({
  clientId: pipe(string(), trim(), minLength(1), maxLength(512)),
  clientSecret: pipe(string(), trim(), minLength(1), maxLength(4096)),
  redirectUri: pipe(
    string(),
    trim(),
    minLength(1),
    maxLength(4096),
    check(isAllowedBangumiRedirectUri),
  ),
});

export const bangumiOAuthClientConfigurationSchema = object({
  configured: literal(true),
});

export const publicBangumiAuthorizationAttemptSchema = object({
  attemptId: authorizationAttemptIdSchema,
  status: union([
    literal("waiting"),
    literal("processing"),
    literal("succeeded"),
    literal("failed"),
    literal("cancelled"),
    literal("expired"),
    literal("superseded"),
  ]),
  expiresAt: optional(pipe(string(), maxLength(64))),
});

export const bangumiAuthorizationAttemptRequestSchema = object({
  attemptId: authorizationAttemptIdSchema,
});

const fanboxCreatorIdSchema = pipe(
  string(),
  minLength(1),
  maxLength(128),
  regex(/^[a-zA-Z0-9_-]+$/u),
);
const fanboxConnectionRequestIdSchema = pipe(
  string(),
  minLength(36),
  maxLength(36),
  regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu),
);
const fanboxPairingCodeSchema = pipe(
  string(),
  minLength(43),
  maxLength(43),
  regex(/^[A-Za-z0-9_-]{43}$/u),
);

export const publicFanboxConnectionRequestSchema = object({
  id: fanboxConnectionRequestIdSchema,
  creatorId: fanboxCreatorIdSchema,
  instanceId: fanboxConnectionRequestIdSchema,
  status: union([
    literal("waiting"),
    literal("verifying"),
    literal("succeeded"),
    literal("failed"),
    literal("cancelled"),
    literal("expired"),
    literal("superseded"),
  ]),
  createdAt: pipe(string(), maxLength(64)),
  expiresAt: pipe(string(), maxLength(64)),
  reason: optional(
    union([
      literal("verification-failed"),
      literal("connection-changed"),
      literal("storage-unavailable"),
    ]),
  ),
});

export const createFanboxConnectionRequestRequestSchema = object({
  creatorId: fanboxCreatorIdSchema,
});

export const createFanboxConnectionRequestResponseSchema = object({
  request: publicFanboxConnectionRequestSchema,
  pairingCode: fanboxPairingCodeSchema,
});

export const fanboxConnectionRequestIdRequestSchema = object({
  requestId: fanboxConnectionRequestIdSchema,
});

export const fanboxConnectionRequestPairingRequestSchema = object({
  requestId: fanboxConnectionRequestIdSchema,
  pairingCode: fanboxPairingCodeSchema,
});

export const fanboxConnectionRequestCompletionRequestSchema = object({
  requestId: fanboxConnectionRequestIdSchema,
  pairingCode: fanboxPairingCodeSchema,
  browserCredential: unknown(),
});

export const fanboxSourceConnectionRevocationRequestSchema = object({
  creatorId: fanboxCreatorIdSchema,
  expectedVersion: sourceConnectionVersionSchema,
});

export type PublicSourceConnection = InferOutput<
  typeof publicSourceConnectionSchema
>;
export type PublicSourceConnectionList = InferOutput<
  typeof publicSourceConnectionListSchema
>;
export type PublicSourceConnectionVerification = InferOutput<
  typeof sourceConnectionVerificationSchema
>;
export type PublicBangumiAuthorizationAttempt = InferOutput<
  typeof publicBangumiAuthorizationAttemptSchema
>;
export type BangumiAuthorizationStart = InferOutput<
  typeof bangumiAuthorizationStartSchema
>;
export type BangumiOAuthClientConfiguration = InferOutput<
  typeof bangumiOAuthClientConfigurationRequestSchema
>;
export type KeySourceConnectionId = InferOutput<
  typeof keySourceConnectionIdSchema
>;
export type PublicSourceConnectionId = InferOutput<
  typeof publicSourceConnectionIdSchema
>;
export type SourceConnectionMutationRequest = InferOutput<
  typeof sourceConnectionMutationRequestSchema
>;
export type SourceConnectionRevocationRequest = InferOutput<
  typeof sourceConnectionRevocationRequestSchema
>;
export type PublicFanboxConnectionRequest = InferOutput<
  typeof publicFanboxConnectionRequestSchema
>;
export type CreateFanboxConnectionRequestResponse = InferOutput<
  typeof createFanboxConnectionRequestResponseSchema
>;

export type PublicSourceConnectionClientMethods = {
  listSourceConnections(): Promise<PublicSourceConnectionList>;
  getSourceConnection(
    id: PublicSourceConnectionId,
  ): Promise<PublicSourceConnection>;
  configureSourceConnection(
    input: SourceConnectionMutationRequest & {
      readonly sourceId: KeySourceConnectionId;
    },
  ): Promise<PublicSourceConnectionVerification>;
  replaceSourceConnection(
    input: SourceConnectionMutationRequest & {
      readonly sourceId: KeySourceConnectionId;
    },
  ): Promise<PublicSourceConnectionVerification>;
  revokeSourceConnection(input: {
    readonly sourceId: KeySourceConnectionId;
    readonly expectedVersion: number;
  }): Promise<InferOutput<typeof sourceConnectionRevokedSchema>>;
  /** 保存或替换私密 OAuth 应用配置；更换时会撤销旧授权，须重新授权。 */
  configureBangumiOAuthClient(
    input: BangumiOAuthClientConfiguration,
  ): Promise<InferOutput<typeof bangumiOAuthClientConfigurationSchema>>;
  beginBangumiAuthorization(): Promise<BangumiAuthorizationStart>;
  getBangumiAuthorizationAttempt(
    attemptId: string,
  ): Promise<PublicBangumiAuthorizationAttempt>;
  cancelBangumiAuthorization(
    attemptId: string,
  ): Promise<PublicBangumiAuthorizationAttempt>;
  revokeBangumiSourceConnection(input: {
    readonly expectedVersion: number;
  }): Promise<InferOutput<typeof sourceConnectionRevokedSchema>>;
  createFanboxConnectionRequest(input: {
    readonly creatorId: string;
  }): Promise<CreateFanboxConnectionRequestResponse>;
  getFanboxConnectionRequest(
    requestId: string,
  ): Promise<PublicFanboxConnectionRequest>;
  getFanboxConnectionRequestForPairing(input: {
    readonly requestId: string;
    readonly pairingCode: string;
  }): Promise<PublicFanboxConnectionRequest>;
  completeFanboxConnectionRequest(input: {
    readonly requestId: string;
    readonly pairingCode: string;
    readonly browserCredential: unknown;
  }): Promise<PublicFanboxConnectionRequest>;
  cancelFanboxConnectionRequest(input: {
    readonly requestId: string;
    readonly pairingCode: string;
  }): Promise<PublicFanboxConnectionRequest>;
  revokeFanboxSourceConnection(input: {
    readonly creatorId: string;
    readonly expectedVersion: number;
  }): Promise<InferOutput<typeof sourceConnectionRevokedSchema>>;
};

function isAllowedBangumiRedirectUri(value: string): boolean {
  let address: URL;
  try {
    address = new URL(value);
  } catch {
    return false;
  }
  if (address.username || address.password || address.hash) return false;
  if (address.protocol === "https:") return true;
  return (
    address.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
  );
}
