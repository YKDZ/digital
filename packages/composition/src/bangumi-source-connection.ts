import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { SourceCollectionExecutionContext } from "@digital/application";
import {
  type BangumiOAuthGrant,
  type BangumiOAuthTransport,
  bangumiSourceConnectionCapability,
  createBangumiOAuthAuthorizationRequest,
  exchangeBangumiOAuthAuthorizationCode,
  isBangumiOAuthAuthorizationRejected,
  isBangumiOAuthRetryableResponse,
  refreshBangumiOAuthGrant,
} from "@digital/bangumi";
import type { RecognitionEvidence } from "@digital/domain";
import {
  ProductPrivateLease,
  type ProductPrivateLeaseOwnership,
  type ProductPrivateLeaseRecord,
  inspectPrivatePath,
  writePrivateJsonDurably,
} from "@digital/product-data";

import type { SourceConnectionInspection } from "./source-connections.js";

const privateDirectoryName = "private-source-connections";
const storageVersion = "bangumi-oauth-connection/1";
const authorizationLifetimeMilliseconds = 10 * 60 * 1000;
const expiryLeewayMilliseconds = 30_000;
const refreshLeaseLifetimeMilliseconds = 2 * 60 * 1000;
const refreshLeaseWaitMilliseconds = 2_000;
const refreshLeasePollMilliseconds = 20;
const connectionMutationLeaseLifetimeMilliseconds = 30_000;
const connectionMutationLeaseWaitMilliseconds = 250;
const privateStorageFailure = "Bangumi OAuth 私有存储不可用";

type BangumiClientConfiguration = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
};

type PrivateBangumiConnectionRecord =
  | {
      readonly version: typeof storageVersion;
      readonly configurationVersion: number;
      readonly credentialStatus: "configured";
      readonly availability: "available";
      readonly grant: BangumiOAuthGrant;
      readonly verifiedAt: string;
    }
  | {
      readonly version: typeof storageVersion;
      readonly configurationVersion: number;
      readonly credentialStatus: "configured";
      readonly availability: "unavailable";
      readonly reason: "authorization-failed";
      /** Keep the last complete grant intact for auditable repair only. */
      readonly grant: BangumiOAuthGrant;
    }
  | {
      readonly version: typeof storageVersion;
      readonly configurationVersion: number;
      readonly credentialStatus: "configured";
      readonly availability: "unavailable";
      /**
       * The provider may have rotated this grant after the durable preflight
       * marker but before the replacement grant was committed.  It is only
       * repairable by fresh user authorization, never retried automatically.
       */
      readonly reason: "authorization-uncertain";
      readonly grant: BangumiOAuthGrant;
      readonly verifiedAt: string;
      readonly refreshInProgress: RefreshInProgress;
    }
  | {
      readonly version: typeof storageVersion;
      readonly configurationVersion: 0;
      readonly credentialStatus: "unconfigured";
      readonly availability: "unavailable";
      readonly reason: "not-configured";
    }
  | {
      readonly version: typeof storageVersion;
      readonly configurationVersion: number;
      readonly credentialStatus: "revoked";
      readonly availability: "unavailable";
      readonly reason: "revoked";
    };

type InvalidBangumiConnectionRecord = {
  readonly configurationVersion: 0;
  readonly credentialStatus: "invalid";
  readonly availability: "unavailable";
  readonly reason: "storage-invalid" | "permissions-unsafe";
};

type ReadBangumiConnectionRecord =
  | PrivateBangumiConnectionRecord
  | InvalidBangumiConnectionRecord;

type PendingAuthorization = ProductPrivateLeaseRecord & {
  readonly schema: "product-private-lease/1";
  readonly version: "bangumi-oauth-pending/1";
  readonly state: string;
  readonly expiresAt: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly configurationVersion: number;
};

/**
 * A product-private, single-host lease. Its fingerprint binds the lease to
 * one exact persisted grant without putting a token in a filename or public
 * diagnostic. Its immutable generation is owned by one same-boot exact
 * PID/start-time identity, so a live holder cannot overlap another mutation;
 * a dead or reused PID remains recoverable without exposing a secret.
 */
type RefreshInProgress = {
  readonly version: "bangumi-oauth-refresh-in-progress/1";
  readonly leaseNonce: string;
  readonly grantFingerprint: string;
  readonly startedAt: string;
};

type RefreshLease = ProductPrivateLeaseRecord & {
  readonly version: "bangumi-oauth-refresh-lease/1";
  readonly connectionVersion: number;
  readonly grantFingerprint: string;
};

/** Serializes only the tiny read-compare-write critical sections. */
type ConnectionMutationLease = ProductPrivateLeaseRecord & {
  readonly version: "bangumi-oauth-connection-mutation/1";
};

export type BangumiAuthorizationStart = {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
};

/**
 * Capability-specific OAuth lifecycle owned by Composition.  The plugin
 * understands Bangumi's protocol; this product adapter owns private files,
 * one-time callback state, and the execution-version bridge.
 */
export class ProductBangumiSourceConnection {
  readonly capability = bangumiSourceConnectionCapability;
  private readonly privateDirectory: string;
  private readonly connectionPath: string;
  private readonly pendingPath: string;
  private readonly processingPath: string;
  private readonly connectionMutationPath: string;
  private readonly instanceNonce: string;
  private readonly pendingLease: ProductPrivateLease<PendingAuthorization>;
  private readonly processingLease: ProductPrivateLease<PendingAuthorization>;
  private readonly connectionMutationLease: ProductPrivateLease<ConnectionMutationLease>;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly request: BangumiOAuthTransport | undefined;
  private readonly now: () => Date;
  private readonly nextState: () => string;
  private readonly beforeRefreshGrantCommit: (() => void) | undefined;
  /** Test-only interleaving point immediately after mutation ownership check. */
  private readonly afterConnectionMutationOwnershipCheck:
    | (() => void)
    | undefined;
  private readonly leaseClock: {
    readonly monotonicNow?: () => number;
    readonly bootId?: () => string;
  };
  private refreshing: Promise<string> | undefined;

  constructor(input: {
    readonly productDataDirectory: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly request?: BangumiOAuthTransport;
    readonly now?: () => Date;
    /** Test-only deterministic Linux monotonic clock. */
    readonly monotonicNow?: () => number;
    /** Test-only deterministic Linux boot identity. */
    readonly bootId?: () => string;
    readonly nextState?: () => string;
    /** Test-only interruption point for the durable OAuth rotation window. */
    readonly beforeRefreshGrantCommit?: () => void;
    /** Test-only interleaving point after mutation ownership is verified. */
    readonly afterConnectionMutationOwnershipCheck?: () => void;
  }) {
    this.privateDirectory = path.join(
      input.productDataDirectory,
      privateDirectoryName,
    );
    this.connectionPath = path.join(
      this.privateDirectory,
      "bangumi-oauth.json",
    );
    this.pendingPath = path.join(
      this.privateDirectory,
      "bangumi-oauth-pending.json",
    );
    this.processingPath = path.join(
      this.privateDirectory,
      "bangumi-oauth-pending.processing.json",
    );
    this.connectionMutationPath = path.join(
      this.privateDirectory,
      "bangumi-oauth-connection.mutation.json",
    );
    this.environment = input.environment;
    this.request = input.request;
    this.now = input.now ?? (() => new Date());
    // Production takes the private lease module's /proc-backed defaults. A
    // deliberately injected wall clock is a test seam, so preserve its
    // deterministic expiry behavior unless that test supplies monotonic time.
    this.leaseClock = {
      ...(input.monotonicNow === undefined
        ? input.now === undefined
          ? {}
          : { monotonicNow: () => input.now!().getTime() }
        : { monotonicNow: input.monotonicNow }),
      ...(input.bootId === undefined ? {} : { bootId: input.bootId }),
    };
    this.instanceNonce = randomUUID();
    const callbackNamespacePath = path.join(
      this.privateDirectory,
      "bangumi-oauth-callback.lease-namespace",
    );
    this.pendingLease = new ProductPrivateLease({
      directory: this.privateDirectory,
      path: this.pendingPath,
      namespacePath: callbackNamespacePath,
      now: this.now,
      ...this.leaseClock,
      isRecord: isPendingAuthorization,
      failureMessage: privateStorageFailure,
    });
    this.processingLease = new ProductPrivateLease({
      directory: this.privateDirectory,
      path: this.processingPath,
      namespacePath: callbackNamespacePath,
      now: this.now,
      ...this.leaseClock,
      isRecord: isPendingAuthorization,
      failureMessage: privateStorageFailure,
    });
    this.connectionMutationLease = new ProductPrivateLease({
      directory: this.privateDirectory,
      path: this.connectionMutationPath,
      now: this.now,
      ...this.leaseClock,
      isRecord: isConnectionMutationLease,
      failureMessage: privateStorageFailure,
    });
    this.nextState =
      input.nextState ?? (() => randomBytes(32).toString("base64url"));
    this.beforeRefreshGrantCommit = input.beforeRefreshGrantCommit;
    this.afterConnectionMutationOwnershipCheck =
      input.afterConnectionMutationOwnershipCheck;
  }

  inspect(): SourceConnectionInspection {
    const record = this.readConnection();
    return {
      id: "bangumi",
      capability: this.capability,
      version: record.configurationVersion,
      credentialStatus: record.credentialStatus,
      availability: record.availability,
      ...("verifiedAt" in record ? { verifiedAt: record.verifiedAt } : {}),
      ...("reason" in record ? { reason: record.reason } : {}),
    };
  }

  beginAuthorization(): BangumiAuthorizationStart {
    const client = this.requireClientConfiguration();
    const record = this.readConnection();
    this.assertMutableStorage(record);
    this.assertNoCallbackInProgress();
    const state = this.nextState();
    if (!isState(state)) throw new Error("Bangumi OAuth 状态生成失败");
    const expiresAt = new Date(
      this.now().getTime() + authorizationLifetimeMilliseconds,
    );
    if (!Number.isFinite(expiresAt.getTime()))
      throw new Error("Bangumi OAuth 状态生成失败");
    const pending: PendingAuthorization = {
      schema: "product-private-lease/1",
      version: "bangumi-oauth-pending/1",
      instanceNonce: this.instanceNonce,
      leaseNonce: randomUUID(),
      fingerprint: pendingFingerprint(state),
      acquiredAt: this.now().toISOString(),
      state,
      expiresAt: expiresAt.toISOString(),
      redirectUri: client.redirectUri,
      clientId: client.clientId,
      configurationVersion: record.configurationVersion,
    };
    this.pendingLease.reclaimStale();
    if (!this.pendingLease.tryAcquire(pending))
      throw new Error("Bangumi OAuth 授权正在进行，请稍候重试");
    return {
      authorizationUrl: createBangumiOAuthAuthorizationRequest({
        clientId: client.clientId,
        redirectUri: client.redirectUri,
        state,
      }),
      expiresAt: pending.expiresAt,
    };
  }

  async completeAuthorizationCallback(
    callbackUrl: string,
  ): Promise<SourceConnectionInspection> {
    const callback = parseCallback(callbackUrl);
    this.assertMutableStorage(this.readConnection());
    this.assertNoCallbackInProgress();
    const pending = this.readPending();
    const state = singularCallbackParameter(callback, "state");
    const code = singularCallbackParameter(callback, "code");
    const rejected = hasOAuthErrorParameter(callback);
    if (
      state === undefined ||
      !isState(state) ||
      state !== pending.state ||
      !sameCallbackTarget(callback, pending.redirectUri) ||
      !this.pendingLease.isLive()
    ) {
      if (!this.pendingLease.isLive()) this.pendingLease.retireExact(pending);
      throw new Error("Bangumi OAuth 回调状态无效或已过期");
    }
    if (rejected) {
      const processing = this.consumePending(pending);
      try {
        throw new Error("Bangumi OAuth 授权未完成");
      } finally {
        processing.retire();
      }
    }
    if (code === undefined)
      throw new Error("Bangumi OAuth 回调状态无效或已过期");
    const client = this.requireClientConfiguration();
    if (
      client.clientId !== pending.clientId ||
      client.redirectUri !== pending.redirectUri
    ) {
      throw new Error("Bangumi OAuth 授权配置已变化，请重新开始授权");
    }
    const processing = this.consumePending(pending);
    try {
      const grant = await exchangeBangumiOAuthAuthorizationCode({
        ...client,
        code,
        state,
        now: this.now,
        ...(this.request === undefined ? {} : { request: this.request }),
      });
      return this.withConnectionMutation(() => {
        if (!processing.isCurrent())
          throw new Error("Bangumi OAuth 授权配置已变化，请重新开始授权");
        const current = this.readConnection();
        this.assertMutableStorage(current);
        if (current.configurationVersion !== pending.configurationVersion)
          throw new Error("Bangumi OAuth 授权配置已变化，请重新开始授权");
        this.writeConnectionUnchecked({
          version: storageVersion,
          configurationVersion: current.configurationVersion + 1,
          credentialStatus: "configured",
          availability: "available",
          grant,
          verifiedAt: this.now().toISOString(),
        });
        return this.inspect();
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("配置已变化"))
        throw error;
      // Do not reflect an authorization code, a client secret, token response,
      // or a transport error into CLI/Web diagnostics.
      throw new Error("Bangumi OAuth 回调换取授权失败");
    } finally {
      processing.retire();
    }
  }

  revoke(expectedVersion?: number): SourceConnectionInspection {
    return this.withConnectionMutation(() => {
      const current = this.readConnection();
      this.assertMutableStorage(current);
      this.assertExpectedVersion(current, expectedVersion);
      if (current.credentialStatus === "revoked") return this.inspect();
      this.writeConnectionUnchecked({
        version: storageVersion,
        configurationVersion: current.configurationVersion + 1,
        credentialStatus: "revoked",
        availability: "unavailable",
        reason: "revoked",
      });
      this.retirePendingIfCurrent();
      return this.inspect();
    });
  }

  bindCollector(input: {
    readonly evidence: RecognitionEvidence;
    readonly configurationReferences: readonly string[];
  }): { readonly configurationReferences: readonly string[] } {
    if (
      input.configurationReferences.some((reference) =>
        this.ownsReference(reference),
      )
    ) {
      return { configurationReferences: [] };
    }
    return { configurationReferences: [this.reference()] };
  }

  isConfigurationReferenceCurrent(reference: string): boolean {
    const record = this.readConnection();
    if (
      reference !== this.reference() ||
      record.credentialStatus !== "configured"
    ) {
      return false;
    }
    if (record.availability === "available") return true;
    // A normal token rotation is private maintenance of the same
    // configuration version. It stays current while its exact same-boot
    // owner remains live; a dead, boot-changed, or malformed marker becomes
    // ordinary unavailable repair work instead of silently retrying an old
    // refresh token.
    return (
      record.reason === "authorization-uncertain" &&
      this.refreshLease({
        connectionVersion: record.configurationVersion,
        grantFingerprint: record.refreshInProgress.grantFingerprint,
      }).isLive()
    );
  }

  authorization(): {
    readonly bearer: (
      context?: SourceCollectionExecutionContext,
    ) => Promise<string>;
  } {
    return {
      bearer: async (context) => await this.bearerForExecution(context),
    };
  }

  private async bearerForExecution(
    context: SourceCollectionExecutionContext | undefined,
  ): Promise<string> {
    const current = this.readConnection();
    if (
      current.credentialStatus !== "configured" ||
      context === undefined ||
      !context.configurationReferences.includes(this.reference())
    ) {
      throw new Error("Bangumi 来源连接当前不可用");
    }
    if (
      current.availability === "unavailable" &&
      current.reason === "authorization-uncertain"
    ) {
      this.refreshing ??= this.awaitRefreshResolution(current).finally(() => {
        this.refreshing = undefined;
      });
      return await this.refreshing;
    }
    if (current.availability !== "available")
      throw new Error("Bangumi 来源连接当前不可用");
    if (
      Date.parse(current.grant.expiresAt) >
      this.now().getTime() + expiryLeewayMilliseconds
    )
      return current.grant.accessToken;
    this.refreshing ??= this.refresh(current).finally(() => {
      this.refreshing = undefined;
    });
    return await this.refreshing;
  }

  /**
   * A second process may observe the durable pre-provider marker.  It waits
   * only for that one lease generation to settle; it never retries the old
   * refresh grant if a stopped process leaves the marker uncertain.
   */
  private async awaitRefreshResolution(
    observed: Extract<
      PrivateBangumiConnectionRecord,
      { readonly reason: "authorization-uncertain" }
    >,
  ): Promise<string> {
    const refreshLease = this.refreshLease({
      connectionVersion: observed.configurationVersion,
      grantFingerprint: observed.refreshInProgress.grantFingerprint,
    });
    // A post-crash uncertain marker must never authorize reuse of its old
    // token.  It may still clean a bounded stale/invalid lease immediately.
    refreshLease.reclaimStale();
    const startedAt = boundedWaitNow();
    while (boundedWaitNow() - startedAt <= refreshLeaseWaitMilliseconds) {
      if (!refreshLease.isLive()) {
        const settled = this.readConnection();
        if (
          settled.credentialStatus === "configured" &&
          settled.availability === "available" &&
          settled.configurationVersion === observed.configurationVersion &&
          Date.parse(settled.grant.expiresAt) >
            this.now().getTime() + expiryLeewayMilliseconds
        ) {
          return settled.grant.accessToken;
        }
        throw new Error("Bangumi 来源连接当前不可用");
      }
      await wait(refreshLeasePollMilliseconds);
      const latest = this.readConnection();
      if (
        latest.credentialStatus !== "configured" ||
        latest.configurationVersion !== observed.configurationVersion
      ) {
        throw new Error("Bangumi 来源连接当前不可用");
      }
      if (latest.availability === "available") {
        if (
          Date.parse(latest.grant.expiresAt) >
          this.now().getTime() + expiryLeewayMilliseconds
        ) {
          return latest.grant.accessToken;
        }
        // The prior holder had a known failed attempt. Do not turn one
        // contention wave into an immediate second provider request.
        throw new Error("Bangumi OAuth 授权更新失败");
      }
      if (latest.reason !== "authorization-uncertain")
        throw new Error("Bangumi 来源连接当前不可用");
    }
    // A no-longer-live uncertain lease can be retired for storage hygiene,
    // but no later process may reuse the possibly-rotated old refresh grant.
    refreshLease.reclaimStale();
    throw new Error("Bangumi 来源连接当前不可用");
  }

  private async refresh(
    current: Extract<
      PrivateBangumiConnectionRecord,
      {
        readonly credentialStatus: "configured";
        readonly availability: "available";
      }
    >,
  ): Promise<string> {
    const acquiredLease = await this.acquireRefreshLease(current);
    const { lease, ownership } = acquiredLease;
    try {
      if (!ownership.isCurrent()) throw new Error("Bangumi 来源连接已变化");
      const beforeRefresh = this.readConnection();
      if (
        beforeRefresh.credentialStatus !== "configured" ||
        beforeRefresh.availability !== "available" ||
        beforeRefresh.configurationVersion !== current.configurationVersion
      ) {
        throw new Error("Bangumi 来源连接已变化");
      }
      if (!sameGrant(beforeRefresh.grant, current.grant)) {
        if (
          Date.parse(beforeRefresh.grant.expiresAt) >
          this.now().getTime() + expiryLeewayMilliseconds
        ) {
          return beforeRefresh.grant.accessToken;
        }
        throw new Error("Bangumi 来源连接已变化");
      }
      if (
        Date.parse(beforeRefresh.grant.expiresAt) >
        this.now().getTime() + expiryLeewayMilliseconds
      ) {
        return beforeRefresh.grant.accessToken;
      }
      // Another process that held this generation's lease has already made
      // the one allowed provider attempt. Its transient failure remains
      // retryable for a later operation, but this waiting operation must not
      // turn one contention wave into a second concurrent refresh request.
      if (acquiredLease.waitedForOtherRefresh) {
        throw new Error("Bangumi OAuth 授权更新失败");
      }
      this.markRefreshInProgress(current, lease);
      if (!ownership.isCurrent()) throw new Error("Bangumi 来源连接已变化");
      let grant: BangumiOAuthGrant;
      try {
        grant = await refreshBangumiOAuthGrant({
          ...this.requireClientConfiguration(),
          refreshToken: current.grant.refreshToken,
          now: this.now,
          ...(this.request === undefined ? {} : { request: this.request }),
        });
      } catch (error) {
        if (isBangumiOAuthAuthorizationRejected(error)) {
          this.markRefreshAuthorizationFailure(current, lease);
        } else if (isBangumiOAuthRetryableResponse(error)) {
          // A completed HTTP retryable response (for example 503) proves the
          // endpoint answered this request. The source policy permits a later
          // refresh attempt with the retained token.
          this.restoreRefreshAvailability(current, lease);
        } else {
          // A transport abort cannot prove that the old refresh token was not
          // consumed. Keep the durable authorization-uncertain marker and
          // never restore or automatically retry that token.
        }
        throw new Error("Bangumi OAuth 授权更新失败");
      }
      try {
        this.beforeRefreshGrantCommit?.();
        return this.withConnectionMutation(() => {
          if (!ownership.isCurrent()) throw new Error("Bangumi 来源连接已变化");
          const latest = this.readConnection();
          if (
            latest.credentialStatus !== "configured" ||
            latest.availability !== "unavailable" ||
            latest.reason !== "authorization-uncertain" ||
            latest.configurationVersion !== current.configurationVersion ||
            !sameGrant(latest.grant, current.grant) ||
            latest.refreshInProgress.leaseNonce !== lease.leaseNonce ||
            latest.refreshInProgress.grantFingerprint !== lease.grantFingerprint
          ) {
            throw new Error("Bangumi 来源连接已变化");
          }
          this.writeConnectionUnchecked({
            version: storageVersion,
            configurationVersion: latest.configurationVersion,
            credentialStatus: "configured",
            availability: "available",
            grant,
            verifiedAt: this.now().toISOString(),
          });
          return grant.accessToken;
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Bangumi 来源连接已变化"
        ) {
          throw error;
        }
        // The old file is retained until the atomic rename succeeds.
        throw new Error("Bangumi OAuth 授权更新失败");
      }
    } finally {
      ownership.retire();
    }
  }

  private async acquireRefreshLease(
    current: Extract<
      PrivateBangumiConnectionRecord,
      {
        readonly credentialStatus: "configured";
        readonly availability: "available";
      }
    >,
  ): Promise<{
    readonly lease: RefreshLease;
    readonly ownership: ProductPrivateLeaseOwnership<RefreshLease>;
    readonly waitedForOtherRefresh: boolean;
  }> {
    const startedAt = boundedWaitNow();
    const candidate = this.newRefreshLease(current);
    const lease = this.refreshLease(candidate);
    let waitedForOtherRefresh = false;
    while (boundedWaitNow() - startedAt <= refreshLeaseWaitMilliseconds) {
      const ownership = lease.acquire(candidate);
      if (ownership !== undefined) {
        return { lease: candidate, ownership, waitedForOtherRefresh };
      }
      if (!lease.reclaimStale()) waitedForOtherRefresh = true;
      await wait(refreshLeasePollMilliseconds);
    }
    throw new Error("Bangumi OAuth 授权更新正在进行，请稍候重试");
  }

  private newRefreshLease(
    current: Extract<
      PrivateBangumiConnectionRecord,
      {
        readonly credentialStatus: "configured";
        readonly availability: "available";
      }
    >,
  ): RefreshLease {
    const acquiredAt = this.now();
    const expiresAt = new Date(
      acquiredAt.getTime() + refreshLeaseLifetimeMilliseconds,
    );
    if (
      !Number.isFinite(acquiredAt.getTime()) ||
      !Number.isFinite(expiresAt.getTime())
    ) {
      throw new Error("Bangumi OAuth 私有存储不可用");
    }
    return {
      schema: "product-private-lease/1",
      version: "bangumi-oauth-refresh-lease/1",
      instanceNonce: this.instanceNonce,
      leaseNonce: randomUUID(),
      fingerprint: grantFingerprint(current.grant),
      connectionVersion: current.configurationVersion,
      grantFingerprint: grantFingerprint(current.grant),
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private refreshLeasePathFor(lease: {
    readonly connectionVersion: number;
    readonly grantFingerprint: string;
  }): string {
    return path.join(
      this.privateDirectory,
      `bangumi-oauth-refresh-${lease.connectionVersion}-${lease.grantFingerprint}.lease.json`,
    );
  }

  private refreshLease(lease: {
    readonly connectionVersion: number;
    readonly grantFingerprint: string;
  }): ProductPrivateLease<RefreshLease> {
    return new ProductPrivateLease({
      directory: this.privateDirectory,
      path: this.refreshLeasePathFor(lease),
      now: this.now,
      ...this.leaseClock,
      isRecord: (value): value is RefreshLease =>
        isRefreshLease(value) &&
        value.connectionVersion === lease.connectionVersion &&
        value.grantFingerprint === lease.grantFingerprint,
      failureMessage: privateStorageFailure,
    });
  }

  private markRefreshInProgress(
    current: Extract<
      PrivateBangumiConnectionRecord,
      {
        readonly credentialStatus: "configured";
        readonly availability: "available";
      }
    >,
    lease: RefreshLease,
  ): void {
    this.withConnectionMutation(() => {
      const latest = this.readConnection();
      if (
        latest.credentialStatus !== "configured" ||
        latest.availability !== "available" ||
        latest.configurationVersion !== current.configurationVersion ||
        !sameGrant(latest.grant, current.grant)
      ) {
        throw new Error("Bangumi 来源连接已变化");
      }
      this.writeConnectionUnchecked({
        version: storageVersion,
        configurationVersion: latest.configurationVersion,
        credentialStatus: "configured",
        availability: "unavailable",
        reason: "authorization-uncertain",
        grant: latest.grant,
        verifiedAt: latest.verifiedAt,
        refreshInProgress: {
          version: "bangumi-oauth-refresh-in-progress/1",
          leaseNonce: lease.leaseNonce,
          grantFingerprint: lease.grantFingerprint,
          startedAt: this.now().toISOString(),
        },
      });
    });
  }

  private markRefreshAuthorizationFailure(
    current: Extract<
      PrivateBangumiConnectionRecord,
      {
        readonly credentialStatus: "configured";
        readonly availability: "available";
      }
    >,
    lease: RefreshLease,
  ): void {
    try {
      this.withConnectionMutation(() => {
        const latest = this.readConnection();
        if (
          latest.credentialStatus !== "configured" ||
          latest.availability !== "unavailable" ||
          latest.reason !== "authorization-uncertain" ||
          latest.configurationVersion !== current.configurationVersion ||
          !sameGrant(latest.grant, current.grant) ||
          latest.refreshInProgress.leaseNonce !== lease.leaseNonce ||
          latest.refreshInProgress.grantFingerprint !== lease.grantFingerprint
        ) {
          return;
        }
        this.writeConnectionUnchecked({
          version: storageVersion,
          configurationVersion: latest.configurationVersion,
          credentialStatus: "configured",
          availability: "unavailable",
          reason: "authorization-failed",
          grant: latest.grant,
        });
      });
    } catch {
      // A storage error must never overwrite the old private grant or surface
      // its value. The next inspection remains the authoritative repair path.
    }
  }

  private restoreRefreshAvailability(
    current: Extract<
      PrivateBangumiConnectionRecord,
      {
        readonly credentialStatus: "configured";
        readonly availability: "available";
      }
    >,
    lease: RefreshLease,
  ): void {
    try {
      this.withConnectionMutation(() => {
        const latest = this.readConnection();
        if (
          latest.credentialStatus !== "configured" ||
          latest.availability !== "unavailable" ||
          latest.reason !== "authorization-uncertain" ||
          latest.configurationVersion !== current.configurationVersion ||
          !sameGrant(latest.grant, current.grant) ||
          latest.refreshInProgress.leaseNonce !== lease.leaseNonce
        ) {
          return;
        }
        this.writeConnectionUnchecked({
          version: storageVersion,
          configurationVersion: latest.configurationVersion,
          credentialStatus: "configured",
          availability: "available",
          grant: latest.grant,
          verifiedAt: latest.verifiedAt,
        });
      });
    } catch {
      // If recovery cannot durably prove that the old token is usable, retain
      // the uncertain marker and require ordinary reauthorization instead.
    }
  }

  /**
   * Connection records are replaced with rename(2), but rename alone has no
   * compare-and-swap condition. Every record-changing operation therefore
   * enters this tiny product-private critical section, re-reads the record,
   * and commits only its still-current expectation. No network work happens
   * under this lock, so revoke and reauthorization remain responsive.
   */
  private withConnectionMutation<T>(work: () => T): T {
    const ownership = this.acquireConnectionMutationLease();
    try {
      if (!ownership.isCurrent())
        throw new Error("Bangumi 来源连接正在被其他操作修改，请刷新后重试");
      this.afterConnectionMutationOwnershipCheck?.();
      // A test seam may simulate an awaited boundary or a process state
      // change. Revalidate immediately before the protected mutation.
      if (!ownership.isCurrent())
        throw new Error("Bangumi 来源连接正在被其他操作修改，请刷新后重试");
      return work();
    } finally {
      ownership.retire();
    }
  }

  private acquireConnectionMutationLease(): ProductPrivateLeaseOwnership<ConnectionMutationLease> {
    const candidate = this.newConnectionMutationLease();
    const startedAt = boundedWaitNow();
    while (
      boundedWaitNow() - startedAt <=
      connectionMutationLeaseWaitMilliseconds
    ) {
      const ownership = this.connectionMutationLease.acquire(candidate);
      if (ownership !== undefined) return ownership;
      this.connectionMutationLease.reclaimStale();
      waitSynchronously(refreshLeasePollMilliseconds);
    }
    throw new Error("Bangumi 来源连接正在被其他操作修改，请刷新后重试");
  }

  private newConnectionMutationLease(): ConnectionMutationLease {
    const acquiredAt = this.now();
    const expiresAt = new Date(
      acquiredAt.getTime() + connectionMutationLeaseLifetimeMilliseconds,
    );
    if (
      !Number.isFinite(acquiredAt.getTime()) ||
      !Number.isFinite(expiresAt.getTime())
    ) {
      throw new Error("Bangumi OAuth 私有存储不可用");
    }
    return {
      schema: "product-private-lease/1",
      version: "bangumi-oauth-connection-mutation/1",
      instanceNonce: this.instanceNonce,
      leaseNonce: randomUUID(),
      fingerprint: "bangumi-oauth-connection-mutation",
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private reference(): string {
    return `source-connection/bangumi@${this.readConnection().configurationVersion}`;
  }

  private ownsReference(reference: string): boolean {
    return reference.startsWith("source-connection/bangumi@");
  }

  private requireClientConfiguration(): BangumiClientConfiguration {
    const clientId = nonBlank(this.environment.DIGITAL_BANGUMI_CLIENT_ID);
    const clientSecret = nonBlank(
      this.environment.DIGITAL_BANGUMI_CLIENT_SECRET,
    );
    const redirectUri = nonBlank(this.environment.DIGITAL_BANGUMI_REDIRECT_URI);
    if (
      clientId === undefined ||
      clientSecret === undefined ||
      redirectUri === undefined ||
      !allowedRedirectUri(redirectUri)
    ) {
      throw new Error("Bangumi OAuth 客户端配置不可用");
    }
    return { clientId, clientSecret, redirectUri };
  }

  private readConnection(): ReadBangumiConnectionRecord {
    const directory = inspectPrivatePath(this.privateDirectory, "directory");
    if (directory === "permissions-unsafe" || directory === "storage-invalid")
      return invalid(directory);
    if (directory === "missing") return unconfigured();
    const file = inspectPrivatePath(this.connectionPath, "file");
    if (file === "permissions-unsafe" || file === "storage-invalid")
      return invalid(file);
    if (file === "missing") return unconfigured();
    try {
      const record = JSON.parse(
        readFileSync(this.connectionPath, "utf8"),
      ) as unknown;
      return isPrivateBangumiConnectionRecord(record)
        ? record
        : invalid("storage-invalid");
    } catch {
      return invalid("storage-invalid");
    }
  }

  private readPending(): PendingAuthorization {
    try {
      const pending = this.pendingLease.currentRecord();
      if (pending === undefined) throw new Error("invalid");
      return pending;
    } catch {
      throw new Error("Bangumi OAuth 回调状态无效或已过期");
    }
  }

  /**
   * Processing is a distinct immutable namespace slot. Pending is closed only
   * after the processing generation is durably published, so a crash cannot
   * make a callback code available for a second token exchange.
   */
  private assertNoCallbackInProgress(): void {
    let processing: PendingAuthorization | undefined;
    try {
      processing = this.processingLease.currentRecord();
    } catch {
      throw new Error("Bangumi OAuth 私有存储不可用");
    }
    if (processing === undefined) return;
    try {
      if (this.processingLease.isLive())
        throw new Error("Bangumi OAuth 授权正在完成，请稍候重试");
      this.processingLease.reclaimStale();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Bangumi OAuth 授权正在完成，请稍候重试"
      ) {
        throw error;
      }
      throw new Error("Bangumi OAuth 私有存储不可用");
    }
  }

  private consumePending(
    expected: PendingAuthorization,
  ): ProductPrivateLeaseOwnership<PendingAuthorization> {
    try {
      const ownership = this.pendingLease.consumeToActive(
        expected,
        this.processingLease,
      );
      if (ownership === undefined) throw new Error("invalid");
      if (!samePending(ownership.record(), expected))
        throw new Error("invalid");
      return ownership;
    } catch {
      throw new Error("Bangumi OAuth 回调状态无效或已过期");
    }
  }

  private writeConnectionUnchecked(
    record: PrivateBangumiConnectionRecord,
  ): void {
    this.writePrivateJson(this.connectionPath, record);
  }

  private writePrivateJson(target: string, value: unknown): void {
    writePrivateJsonDurably({
      directory: this.privateDirectory,
      target,
      value,
      failureMessage: privateStorageFailure,
    });
  }

  private retirePendingIfCurrent(): void {
    try {
      this.pendingLease.retireExact(this.readPending());
    } catch {
      // A stale or malformed pending record can only leave later callbacks
      // fail-closed. Do not replace it or reveal private filesystem details.
    }
  }

  private assertMutableStorage(
    record: ReadBangumiConnectionRecord,
  ): asserts record is PrivateBangumiConnectionRecord {
    if (record.credentialStatus === "invalid")
      throw new Error("Bangumi OAuth 私有存储不可用");
  }

  private assertExpectedVersion(
    record: PrivateBangumiConnectionRecord,
    expectedVersion: number | undefined,
  ): void {
    if (
      expectedVersion !== undefined &&
      expectedVersion !== record.configurationVersion
    ) {
      throw new Error("来源连接已被其他设置修改，请刷新后重试");
    }
  }
}

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0
    ? undefined
    : value.trim();
}

function allowedRedirectUri(value: string): boolean {
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
    (address.hostname === "localhost" ||
      address.hostname === "127.0.0.1" ||
      address.hostname === "[::1]")
  );
}

function parseCallback(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("Bangumi OAuth 回调状态无效或已过期");
  }
}

function sameCallbackTarget(callback: URL, redirectUri: string): boolean {
  let expected: URL;
  try {
    expected = new URL(redirectUri);
  } catch {
    return false;
  }
  if (
    callback.protocol !== expected.protocol ||
    callback.username !== expected.username ||
    callback.password !== expected.password ||
    callback.host !== expected.host ||
    callback.pathname !== expected.pathname ||
    callback.hash !== ""
  ) {
    return false;
  }
  const actualStatic = new URLSearchParams(callback.search);
  for (const name of [
    "code",
    "state",
    "error",
    "error_description",
    "error_uri",
  ])
    actualStatic.delete(name);
  return actualStatic.toString() === expected.searchParams.toString();
}

function singularCallbackParameter(
  address: URL,
  name: string,
): string | undefined {
  const values = address.searchParams.getAll(name);
  return values.length === 1 && values[0]!.length > 0 ? values[0] : undefined;
}

function hasOAuthErrorParameter(address: URL): boolean {
  return ["error", "error_description", "error_uri"].some((name) =>
    address.searchParams.has(name),
  );
}

function isState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function unconfigured(): PrivateBangumiConnectionRecord {
  return {
    version: storageVersion,
    configurationVersion: 0,
    credentialStatus: "unconfigured",
    availability: "unavailable",
    reason: "not-configured",
  };
}

function invalid(
  reason: InvalidBangumiConnectionRecord["reason"],
): InvalidBangumiConnectionRecord {
  return {
    configurationVersion: 0,
    credentialStatus: "invalid",
    availability: "unavailable",
    reason,
  };
}

function isPrivateBangumiConnectionRecord(
  value: unknown,
): value is PrivateBangumiConnectionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== storageVersion ||
    !Number.isSafeInteger(record.configurationVersion) ||
    (record.configurationVersion as number) < 0
  ) {
    return false;
  }
  switch (record.credentialStatus) {
    case "configured":
      if (!isGrant(record.grant)) return false;
      if (record.availability === "available")
        return (
          record.reason === undefined &&
          record.refreshInProgress === undefined &&
          isCanonicalTimestamp(record.verifiedAt)
        );
      if (record.availability !== "unavailable") return false;
      if (record.reason === "authorization-failed")
        return (
          record.verifiedAt === undefined &&
          record.refreshInProgress === undefined
        );
      return (
        record.reason === "authorization-uncertain" &&
        isCanonicalTimestamp(record.verifiedAt) &&
        isRefreshInProgress(record.refreshInProgress) &&
        record.refreshInProgress.grantFingerprint ===
          grantFingerprint(record.grant)
      );
    case "unconfigured":
      return (
        record.configurationVersion === 0 &&
        record.availability === "unavailable" &&
        record.reason === "not-configured" &&
        record.grant === undefined &&
        record.verifiedAt === undefined
      );
    case "revoked":
      return (
        record.availability === "unavailable" &&
        record.reason === "revoked" &&
        record.grant === undefined &&
        record.verifiedAt === undefined
      );
    default:
      return false;
  }
}

function isGrant(value: unknown): value is BangumiOAuthGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const grant = value as Record<string, unknown>;
  return (
    typeof grant.accessToken === "string" &&
    grant.accessToken.length > 0 &&
    typeof grant.refreshToken === "string" &&
    grant.refreshToken.length > 0 &&
    isCanonicalTimestamp(grant.expiresAt)
  );
}

function isPendingAuthorization(value: unknown): value is PendingAuthorization {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const pending = value as Record<string, unknown>;
  return (
    pending.schema === "product-private-lease/1" &&
    pending.version === "bangumi-oauth-pending/1" &&
    isLeaseNonce(pending.instanceNonce) &&
    isLeaseNonce(pending.leaseNonce) &&
    typeof pending.fingerprint === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(pending.fingerprint) &&
    isCanonicalTimestamp(pending.acquiredAt) &&
    isState(pending.state) &&
    pending.fingerprint === pendingFingerprint(pending.state) &&
    isCanonicalTimestamp(pending.expiresAt) &&
    typeof pending.redirectUri === "string" &&
    allowedRedirectUri(pending.redirectUri) &&
    typeof pending.clientId === "string" &&
    pending.clientId.length > 0 &&
    Number.isSafeInteger(pending.configurationVersion) &&
    (pending.configurationVersion as number) >= 0
  );
}

function samePending(
  left: PendingAuthorization,
  right: PendingAuthorization,
): boolean {
  return (
    left.instanceNonce === right.instanceNonce &&
    left.leaseNonce === right.leaseNonce &&
    left.fingerprint === right.fingerprint &&
    left.acquiredAt === right.acquiredAt &&
    left.state === right.state &&
    left.expiresAt === right.expiresAt &&
    left.redirectUri === right.redirectUri &&
    left.clientId === right.clientId &&
    left.configurationVersion === right.configurationVersion
  );
}

function sameGrant(left: BangumiOAuthGrant, right: BangumiOAuthGrant): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedWaitNow(): number {
  return performance.now();
}

function grantFingerprint(grant: BangumiOAuthGrant): string {
  return createHash("sha256")
    .update(grant.accessToken)
    .update("\u0000")
    .update(grant.refreshToken)
    .update("\u0000")
    .update(grant.expiresAt)
    .digest("base64url");
}

function pendingFingerprint(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

function isRefreshLease(value: unknown): value is RefreshLease {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const lease = value as Record<string, unknown>;
  return (
    lease.schema === "product-private-lease/1" &&
    lease.version === "bangumi-oauth-refresh-lease/1" &&
    isLeaseNonce(lease.instanceNonce) &&
    isLeaseNonce(lease.leaseNonce) &&
    typeof lease.fingerprint === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(lease.fingerprint) &&
    Number.isSafeInteger(lease.connectionVersion) &&
    (lease.connectionVersion as number) >= 0 &&
    typeof lease.grantFingerprint === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(lease.grantFingerprint) &&
    lease.fingerprint === lease.grantFingerprint &&
    isCanonicalTimestamp(lease.acquiredAt) &&
    isCanonicalTimestamp(lease.expiresAt)
  );
}

function isConnectionMutationLease(
  value: unknown,
): value is ConnectionMutationLease {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const lease = value as Record<string, unknown>;
  return (
    lease.schema === "product-private-lease/1" &&
    lease.version === "bangumi-oauth-connection-mutation/1" &&
    isLeaseNonce(lease.instanceNonce) &&
    isLeaseNonce(lease.leaseNonce) &&
    lease.fingerprint === "bangumi-oauth-connection-mutation" &&
    isCanonicalTimestamp(lease.acquiredAt) &&
    isCanonicalTimestamp(lease.expiresAt)
  );
}

function isRefreshInProgress(value: unknown): value is RefreshInProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const marker = value as Record<string, unknown>;
  return (
    marker.version === "bangumi-oauth-refresh-in-progress/1" &&
    isLeaseNonce(marker.leaseNonce) &&
    typeof marker.grantFingerprint === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(marker.grantFingerprint) &&
    isCanonicalTimestamp(marker.startedAt)
  );
}

function isLeaseNonce(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function waitSynchronously(milliseconds: number): void {
  const signal = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  Atomics.wait(signal, 0, 0, milliseconds);
}
