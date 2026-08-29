import type { CapabilityCoordinate } from "@digital/domain";

export type SourceConnectionCredentialStatus =
  | "unconfigured"
  | "configured"
  | "revoked"
  /** 私密存储存在，但无法安全地描述一份可用凭据。 */
  | "invalid";

export type SourceConnectionAvailability = "available" | "unavailable";

export type SourceConnectionUnavailableReason =
  | "not-configured"
  | "revoked"
  | "verification-failed"
  | "authorization-failed"
  | "authorization-uncertain"
  | "storage-invalid"
  | "permissions-unsafe";

/** 对交付层安全的来源连接运维投影；它刻意无法携带秘密。 */
export type SourceConnectionInspection = {
  readonly id: string;
  readonly capability: CapabilityCoordinate;
  readonly version: number;
  readonly credentialStatus: SourceConnectionCredentialStatus;
  readonly availability: SourceConnectionAvailability;
  readonly verifiedAt?: string;
  readonly reason?: SourceConnectionUnavailableReason;
};
