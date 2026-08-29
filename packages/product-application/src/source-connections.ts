import type {
  SourceCollectionExecutionContext,
  SourceCollector,
  SourceConnectionExecutionConfiguration,
  SourceConnectionInspection,
  SourceConnectionPrivateStatePort,
  SourceConnectionUnavailableReason,
} from "@digital/application";
import type {
  CapabilityCoordinate,
  RecognitionEvidence,
} from "@digital/domain";

const storageVersion = "product-source-connection/1";

type PrivateSourceConnectionRecordBase = {
  readonly version: typeof storageVersion;
  readonly configurationVersion: number;
};

type ConfiguredAvailableSourceConnectionRecord =
  PrivateSourceConnectionRecordBase & {
    readonly credentialStatus: "configured";
    readonly availability: "available";
    readonly secret: string;
    readonly verifiedAt?: string;
    readonly reason?: never;
  };

type VerificationFailedSourceConnectionRecord =
  PrivateSourceConnectionRecordBase & {
    readonly credentialStatus: "configured";
    readonly availability: "unavailable";
    readonly secret: string;
    readonly reason: "verification-failed";
    readonly verifiedAt?: never;
  };

type UnconfiguredSourceConnectionRecord = Omit<
  PrivateSourceConnectionRecordBase,
  "configurationVersion"
> & {
  readonly configurationVersion: 0;
  readonly credentialStatus: "unconfigured";
  readonly availability: "unavailable";
  readonly reason: "not-configured";
  readonly secret?: never;
  readonly verifiedAt?: never;
};

type RevokedSourceConnectionRecord = PrivateSourceConnectionRecordBase & {
  readonly credentialStatus: "revoked";
  readonly availability: "unavailable";
  readonly reason: "revoked";
  readonly secret?: never;
  readonly verifiedAt?: never;
};

type PrivateSourceConnectionRecord =
  | ConfiguredAvailableSourceConnectionRecord
  | VerificationFailedSourceConnectionRecord
  | UnconfiguredSourceConnectionRecord
  | RevokedSourceConnectionRecord;

type InvalidPrivateSourceConnectionRecord = {
  readonly version: typeof storageVersion;
  readonly configurationVersion: 0;
  readonly credentialStatus: "invalid";
  readonly availability: "unavailable";
  readonly secret?: never;
  readonly verifiedAt?: never;
  readonly reason: Extract<
    SourceConnectionUnavailableReason,
    "storage-invalid" | "permissions-unsafe"
  >;
};

type ReadPrivateSourceConnectionRecord =
  | PrivateSourceConnectionRecord
  | InvalidPrivateSourceConnectionRecord;

type ConnectionVerifier = (secret: string) => Promise<void>;

type SourceConnectionDefinition = {
  readonly id: string;
  /** 安全的私有文件名片段；显示/引用 ID 可能包含 `/`。 */
  readonly storageKey?: string;
  readonly capability: CapabilityCoordinate;
  readonly bootstrapSecret: string | undefined;
  readonly verify: ConnectionVerifier;
};

export type ProductBangumiSourceConnection = {
  readonly capability: CapabilityCoordinate;
  inspect(): SourceConnectionInspection;
  beginAuthorization(): {
    readonly authorizationUrl: string;
    readonly expiresAt: string;
  };
  completeAuthorizationCallback(
    callbackUrl: string,
  ): Promise<SourceConnectionInspection>;
  revoke(expectedVersion?: number): SourceConnectionInspection;
  bindCollector(input: {
    readonly evidence: RecognitionEvidence;
    readonly configurationReferences: readonly string[];
  }): { readonly configurationReferences: readonly string[] };
  isConfigurationReferenceCurrent(reference: string): boolean;
  authorization(): {
    readonly bearer: (
      context?: SourceCollectionExecutionContext,
    ) => Promise<string>;
  };
};

export type ProductSourceConnectionAdapters = {
  readonly privateState: SourceConnectionPrivateStatePort;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly bangumi: {
    readonly connection: ProductBangumiSourceConnection;
    readonly collectorCapability: CapabilityCoordinate;
    createCollector(input: {
      readonly authorization: ReturnType<
        ProductBangumiSourceConnection["authorization"]
      >;
    }): SourceCollector;
  };
  readonly fanbox: {
    readonly connectionCapability: CapabilityCoordinate;
    readonly collectorCapability: CapabilityCoordinate;
    creatorIdFromEvidence(evidence: RecognitionEvidence): string | undefined;
    validatedBrowserCredential(input: {
      readonly creatorId: string;
      readonly browserCookies: unknown;
    }): Promise<string>;
    verifyStoredCredential(input: {
      readonly creatorId: string;
      readonly cookieHeader: string;
    }): Promise<void>;
    createCollector(input: {
      readonly creatorIds: () => readonly string[];
      readonly cookieHeaderForExecution: (input: {
        readonly creatorId: string;
        readonly context: SourceCollectionExecutionContext | undefined;
      }) => string | undefined;
    }): SourceCollector;
  };
  readonly tmdb: {
    readonly connectionCapability: CapabilityCoordinate;
    readonly collectorCapability: CapabilityCoordinate;
    verifyAccessToken(accessToken: string): Promise<void>;
    createCollector(input: {
      readonly accessTokenForExecution: (
        context: SourceCollectionExecutionContext | undefined,
      ) => string | undefined;
    }): SourceCollector;
  };
  readonly omdb: {
    readonly connectionCapability: CapabilityCoordinate;
    readonly collectorCapability: CapabilityCoordinate;
    verifyApiKey(apiKey: string): Promise<void>;
    createCollector(input: {
      readonly apiKeyForExecution: (
        context: SourceCollectionExecutionContext | undefined,
      ) => string | undefined;
    }): SourceCollector;
  };
};

/**
 * 一条由能力拥有的私有秘密记录。它刻意只暴露窄化操作，而非通用凭据文档或模式。
 */
class PrivateSourceConnection {
  private readonly privateState: SourceConnectionPrivateStatePort;
  private readonly storageKey: string;
  private readonly definition: SourceConnectionDefinition;

  constructor(
    definition: SourceConnectionDefinition,
    privateState: SourceConnectionPrivateStatePort,
  ) {
    this.definition = definition;
    this.privateState = privateState;
    this.storageKey = definition.storageKey ?? definition.id;
  }

  inspect(): SourceConnectionInspection {
    const record = this.read();
    return {
      id: this.definition.id,
      capability: this.definition.capability,
      version: record.configurationVersion,
      credentialStatus: record.credentialStatus,
      availability: record.availability,
      ...(record.verifiedAt === undefined
        ? {}
        : { verifiedAt: record.verifiedAt }),
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    };
  }

  configure(secret: string): SourceConnectionInspection {
    const previous = this.read();
    this.assertMutableStorage(previous);
    if (previous.credentialStatus === "configured") {
      throw new Error("来源连接已经配置，请使用替换操作");
    }
    return this.replaceRecord(previous, secret);
  }

  /**
   * 已经验证过私有材料的能力，可以通过一次本地写入将其提交为可用。普通连接保留各自的
   * 生命周期；浏览器 Cookie 导入器绝不会仅为稍后验证，而持久化未经检查的导出内容。
   */
  configureVerified(secret: string): SourceConnectionInspection {
    const previous = this.read();
    this.assertMutableStorage(previous);
    if (previous.credentialStatus === "configured") {
      throw new Error("来源连接已经配置，请使用替换操作");
    }
    return this.writeVerifiedRecord(previous, secret);
  }

  replace(
    secret: string,
    expectedVersion?: number,
  ): SourceConnectionInspection {
    const previous = this.read();
    this.assertMutableStorage(previous);
    this.assertExpectedVersion(previous, expectedVersion);
    return this.replaceRecord(previous, secret);
  }

  replaceVerified(
    secret: string,
    expectedVersion?: number,
  ): SourceConnectionInspection {
    const previous = this.read();
    this.assertMutableStorage(previous);
    this.assertExpectedVersion(previous, expectedVersion);
    return this.writeVerifiedRecord(previous, secret);
  }

  revoke(expectedVersion?: number): SourceConnectionInspection {
    const previous = this.read();
    this.assertMutableStorage(previous);
    this.assertExpectedVersion(previous, expectedVersion);
    if (previous.credentialStatus === "revoked") return this.inspect();
    this.write({
      version: storageVersion,
      configurationVersion: previous.configurationVersion + 1,
      credentialStatus: "revoked",
      availability: "unavailable",
      reason: "revoked",
    });
    return this.inspect();
  }

  async verify(): Promise<SourceConnectionInspection> {
    const snapshot = this.read();
    if (
      snapshot.credentialStatus !== "configured" ||
      !nonEmptySecret(snapshot.secret)
    ) {
      return this.inspect();
    }
    let verificationFailed = false;
    try {
      await this.definition.verify(snapshot.secret);
    } catch {
      verificationFailed = true;
    }
    const current = this.read();
    // 并发替换/撤销是更新的产品状态；不要用旧验证结果覆盖它。
    if (
      current.configurationVersion !== snapshot.configurationVersion ||
      current.credentialStatus !== "configured" ||
      current.secret !== snapshot.secret
    ) {
      return this.inspect();
    }
    if (verificationFailed) {
      this.write({
        version: storageVersion,
        configurationVersion: current.configurationVersion,
        credentialStatus: "configured",
        availability: "unavailable",
        secret: current.secret,
        reason: "verification-failed",
      });
    } else {
      this.write({
        version: storageVersion,
        configurationVersion: current.configurationVersion,
        credentialStatus: "configured",
        availability: "available",
        secret: current.secret,
        verifiedAt: new Date().toISOString(),
      });
    }
    return this.inspect();
  }

  /** 冻结到工作流执行中的不透明、非秘密坐标。 */
  reference(): string {
    return `source-connection/${this.definition.id}@${this.read().configurationVersion}`;
  }

  ownsReference(reference: string): boolean {
    return reference.startsWith(`source-connection/${this.definition.id}@`);
  }

  isCurrentUsableReference(reference: string): boolean {
    const record = this.read();
    return (
      reference === this.reference() &&
      record.credentialStatus === "configured" &&
      record.availability === "available" &&
      nonEmptySecret(record.secret)
    );
  }

  secretForExecution(
    context: SourceCollectionExecutionContext | undefined,
  ): string | undefined {
    if (
      context === undefined ||
      !context.configurationReferences.includes(this.reference())
    )
      return undefined;
    const record = this.read();
    return this.isCurrentUsableReference(this.reference())
      ? record.secret
      : undefined;
  }

  private replaceRecord(
    previous: PrivateSourceConnectionRecord,
    secret: string,
  ): SourceConnectionInspection {
    if (!nonEmptySecret(secret)) throw new Error("来源连接密钥无效");
    this.write({
      version: storageVersion,
      configurationVersion: previous.configurationVersion + 1,
      credentialStatus: "configured",
      availability: "available",
      secret: secret.trim(),
    });
    return this.inspect();
  }

  private writeVerifiedRecord(
    previous: PrivateSourceConnectionRecord,
    secret: string,
  ): SourceConnectionInspection {
    if (!nonEmptySecret(secret)) throw new Error("来源连接密钥无效");
    this.write({
      version: storageVersion,
      configurationVersion: previous.configurationVersion + 1,
      credentialStatus: "configured",
      availability: "available",
      secret: secret.trim(),
      verifiedAt: new Date().toISOString(),
    });
    return this.inspect();
  }

  private assertExpectedVersion(
    record: PrivateSourceConnectionRecord,
    expectedVersion: number | undefined,
  ): void {
    if (
      expectedVersion !== undefined &&
      expectedVersion !== record.configurationVersion
    ) {
      throw new Error("来源连接已被其他设置修改，请刷新后重试");
    }
  }

  private assertMutableStorage(
    record: ReadPrivateSourceConnectionRecord,
  ): asserts record is PrivateSourceConnectionRecord {
    if (record.credentialStatus === "invalid")
      throw new Error("私有来源连接存储不可用");
  }

  private read(): ReadPrivateSourceConnectionRecord {
    const stored = this.privateState.read(this.storageKey);
    if (stored.status === "missing") {
      const bootstrapSecret = normalisedSecret(this.definition.bootstrapSecret);
      if (bootstrapSecret === undefined) return unconfiguredSourceConnection();
      const bootstrapped: PrivateSourceConnectionRecord = {
        version: storageVersion,
        configurationVersion: 1,
        credentialStatus: "configured",
        availability: "available",
        secret: bootstrapSecret,
      };
      try {
        this.write(bootstrapped);
        return bootstrapped;
      } catch {
        return invalidSourceConnection("storage-invalid");
      }
    }
    if (stored.status !== "usable")
      return invalidSourceConnection(stored.status);
    if (!isPrivateSourceConnectionRecord(stored.value))
      return invalidSourceConnection("storage-invalid");
    return stored.value;
  }

  private write(record: PrivateSourceConnectionRecord): void {
    this.privateState.write({
      key: this.storageKey,
      value: record,
      failureMessage: "私有来源连接存储不可用",
    });
  }
}

function nonEmptySecret(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalisedSecret(value: string | undefined): string | undefined {
  return nonEmptySecret(value) ? value.trim() : undefined;
}

function unconfiguredSourceConnection(): PrivateSourceConnectionRecord {
  return {
    version: storageVersion,
    configurationVersion: 0,
    credentialStatus: "unconfigured",
    availability: "unavailable",
    reason: "not-configured",
  };
}

function invalidSourceConnection(
  reason: Extract<
    SourceConnectionUnavailableReason,
    "storage-invalid" | "permissions-unsafe"
  >,
): InvalidPrivateSourceConnectionRecord {
  return {
    version: storageVersion,
    configurationVersion: 0,
    credentialStatus: "invalid",
    availability: "unavailable",
    reason,
  };
}

function isPrivateSourceConnectionRecord(
  value: unknown,
): value is PrivateSourceConnectionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== storageVersion ||
    typeof record.configurationVersion !== "number" ||
    !Number.isInteger(record.configurationVersion) ||
    record.configurationVersion < 0
  ) {
    return false;
  }

  switch (record.credentialStatus) {
    case "configured":
      if (!nonEmptySecret(record.secret)) return false;
      if (record.availability === "available") {
        return (
          record.reason === undefined &&
          (record.verifiedAt === undefined ||
            isCanonicalTimestamp(record.verifiedAt))
        );
      }
      return (
        record.availability === "unavailable" &&
        record.reason === "verification-failed" &&
        record.verifiedAt === undefined
      );
    case "unconfigured":
      return (
        record.configurationVersion === 0 &&
        record.availability === "unavailable" &&
        record.reason === "not-configured" &&
        record.secret === undefined &&
        record.verifiedAt === undefined
      );
    case "revoked":
      return (
        record.availability === "unavailable" &&
        record.reason === "revoked" &&
        record.secret === undefined &&
        record.verifiedAt === undefined
      );
    default:
      return false;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

export class TmdbSourceConnection {
  private readonly connection: PrivateSourceConnection;

  constructor(connection: PrivateSourceConnection) {
    this.connection = connection;
  }

  inspect(): SourceConnectionInspection {
    return this.connection.inspect();
  }

  configureAccessToken(accessToken: string): SourceConnectionInspection {
    return this.connection.configure(accessToken);
  }

  replaceAccessToken(
    accessToken: string,
    expectedVersion?: number,
  ): SourceConnectionInspection {
    return this.connection.replace(accessToken, expectedVersion);
  }

  revoke(expectedVersion?: number): SourceConnectionInspection {
    return this.connection.revoke(expectedVersion);
  }

  async verify(): Promise<SourceConnectionInspection> {
    return await this.connection.verify();
  }

  accessTokenForExecution(
    context: SourceCollectionExecutionContext | undefined,
  ): string | undefined {
    return this.connection.secretForExecution(context);
  }
}

export class OmdbSourceConnection {
  private readonly connection: PrivateSourceConnection;

  constructor(connection: PrivateSourceConnection) {
    this.connection = connection;
  }

  inspect(): SourceConnectionInspection {
    return this.connection.inspect();
  }

  configureApiKey(apiKey: string): SourceConnectionInspection {
    return this.connection.configure(apiKey);
  }

  replaceApiKey(
    apiKey: string,
    expectedVersion?: number,
  ): SourceConnectionInspection {
    return this.connection.replace(apiKey, expectedVersion);
  }

  revoke(expectedVersion?: number): SourceConnectionInspection {
    return this.connection.revoke(expectedVersion);
  }

  async verify(): Promise<SourceConnectionInspection> {
    return await this.connection.verify();
  }

  apiKeyForExecution(
    context: SourceCollectionExecutionContext | undefined,
  ): string | undefined {
    return this.connection.secretForExecution(context);
  }
}

/**
 * FANBOX 凭据刻意按创作者限定范围。首个公开投影为只读；导入、验证和采集绑定的加入，
 * 不会把浏览器 Cookie 变成应用层凭据类型。
 */
export class ProductFanboxSourceConnections {
  private readonly privateState: SourceConnectionPrivateStatePort;
  private readonly adapter: ProductSourceConnectionAdapters["fanbox"];

  constructor(input: {
    readonly privateState: SourceConnectionPrivateStatePort;
    readonly adapter: ProductSourceConnectionAdapters["fanbox"];
  }) {
    this.privateState = input.privateState;
    this.adapter = input.adapter;
  }

  inspect(creatorId: string): SourceConnectionInspection & {
    readonly creatorId: string;
  } {
    assertFanboxCreatorId(creatorId);
    return {
      ...this.connectionFor(creatorId).inspect(),
      creatorId,
    };
  }

  async importBrowserCredentials(input: {
    readonly creatorId: string;
    readonly browserCookies: unknown;
  }): Promise<
    SourceConnectionInspection & {
      readonly creatorId: string;
    }
  > {
    assertFanboxCreatorId(input.creatorId);
    const cookieHeader = await this.adapter.validatedBrowserCredential(input);
    const connection = this.connectionFor(input.creatorId);
    return {
      ...connection.configureVerified(cookieHeader),
      creatorId: input.creatorId,
    };
  }

  async replaceBrowserCredentials(input: {
    readonly creatorId: string;
    readonly browserCookies: unknown;
    readonly expectedVersion?: number;
  }): Promise<
    SourceConnectionInspection & {
      readonly creatorId: string;
    }
  > {
    assertFanboxCreatorId(input.creatorId);
    const cookieHeader = await this.adapter.validatedBrowserCredential(input);
    const connection = this.connectionFor(input.creatorId);
    return {
      ...connection.replaceVerified(cookieHeader, input.expectedVersion),
      creatorId: input.creatorId,
    };
  }

  revoke(input: {
    readonly creatorId: string;
    readonly expectedVersion?: number;
  }): SourceConnectionInspection & { readonly creatorId: string } {
    assertFanboxCreatorId(input.creatorId);
    return {
      ...this.connectionFor(input.creatorId).revoke(input.expectedVersion),
      creatorId: input.creatorId,
    };
  }

  inspectAll(): readonly (SourceConnectionInspection & {
    readonly creatorId: string;
  })[] {
    return this.creatorIds().map((creatorId) => this.inspect(creatorId));
  }

  /**
   * 创作者范围属于产品配置，而非识别语义。FANBOX 适配器只接收这份最小范围列表，
   * 并自行决定如何把证据映射到其中一项。
   */
  creatorIds(): readonly string[] {
    const listing = this.privateState.list();
    if (listing.status !== "usable") return [];
    return listing.keys
      .flatMap((key) => {
        const match = /^fanbox--([a-zA-Z0-9_-]+)$/u.exec(key);
        return match === null ? [] : [match[1]!];
      })
      .toSorted();
  }

  bindCollector(input: {
    readonly evidence: RecognitionEvidence;
    readonly configurationReferences: readonly string[];
  }): { readonly configurationReferences: readonly string[] } {
    const creatorId = this.adapter.creatorIdFromEvidence(input.evidence);
    if (creatorId === undefined || !this.creatorIds().includes(creatorId))
      return { configurationReferences: [] };
    const connection = this.connectionFor(creatorId);
    if (
      input.configurationReferences.some((reference) =>
        connection.ownsReference(reference),
      )
    ) {
      return { configurationReferences: [] };
    }
    return { configurationReferences: [connection.reference()] };
  }

  isConfigurationReferenceCurrent(reference: string): boolean {
    const creatorId = this.creatorIds().find((candidate) =>
      this.connectionFor(candidate).ownsReference(reference),
    );
    return (
      creatorId !== undefined &&
      this.connectionFor(creatorId).isCurrentUsableReference(reference)
    );
  }

  cookieHeaderForExecution(input: {
    readonly creatorId: string;
    readonly context: SourceCollectionExecutionContext | undefined;
  }): string | undefined {
    if (!this.creatorIds().includes(input.creatorId)) return undefined;
    return this.connectionFor(input.creatorId).secretForExecution(
      input.context,
    );
  }

  collector(): SourceCollector {
    return this.adapter.createCollector({
      creatorIds: () => this.creatorIds(),
      cookieHeaderForExecution: (input) => this.cookieHeaderForExecution(input),
    });
  }

  private connectionFor(creatorId: string): PrivateSourceConnection {
    return new PrivateSourceConnection(
      {
        id: `fanbox/${creatorId}`,
        storageKey: `fanbox--${creatorId}`,
        capability: this.adapter.connectionCapability,
        bootstrapSecret: undefined,
        verify: async (cookieHeader) =>
          await this.adapter.verifyStoredCredential({
            creatorId,
            cookieHeader,
          }),
      },
      this.privateState,
    );
  }
}

function assertFanboxCreatorId(value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value))
    throw new Error("FANBOX 创作者范围无效");
}

/**
 * 由产品应用拥有的当前已部署来源连接入口。组合层只注入具体适配器；应用层只看到
 * 不透明配置引用，且这里不提供按字符串查询的通用注册表。
 */
export class ProductSourceConnections implements SourceConnectionExecutionConfiguration {
  private readonly all: readonly PrivateSourceConnection[];
  private readonly tmdbPrivate: PrivateSourceConnection;
  private readonly omdbPrivate: PrivateSourceConnection;
  readonly tmdb: TmdbSourceConnection;
  readonly omdb: OmdbSourceConnection;
  readonly fanbox: ProductFanboxSourceConnections;
  readonly bangumi: ProductBangumiSourceConnection;
  readonly #adapters: ProductSourceConnectionAdapters;

  constructor(adapters: ProductSourceConnectionAdapters) {
    this.#adapters = adapters;
    const tmdb = new PrivateSourceConnection(
      {
        id: "tmdb",
        capability: adapters.tmdb.connectionCapability,
        bootstrapSecret: adapters.environment.DIGITAL_TMDB_ACCESS_TOKEN,
        verify: async (accessToken) =>
          await adapters.tmdb.verifyAccessToken(accessToken),
      },
      adapters.privateState,
    );
    const omdb = new PrivateSourceConnection(
      {
        id: "omdb",
        capability: adapters.omdb.connectionCapability,
        bootstrapSecret: adapters.environment.DIGITAL_OMDB_API_KEY,
        verify: async (apiKey) => await adapters.omdb.verifyApiKey(apiKey),
      },
      adapters.privateState,
    );
    this.tmdbPrivate = tmdb;
    this.omdbPrivate = omdb;
    this.tmdb = new TmdbSourceConnection(tmdb);
    this.omdb = new OmdbSourceConnection(omdb);
    this.fanbox = new ProductFanboxSourceConnections({
      privateState: adapters.privateState,
      adapter: adapters.fanbox,
    });
    this.bangumi = adapters.bangumi.connection;
    this.all = [tmdb, omdb];
  }

  inspect(): readonly SourceConnectionInspection[] {
    return [
      ...this.all.map((connection) => connection.inspect()),
      this.bangumi.inspect(),
      ...this.fanbox.inspectAll(),
    ];
  }

  async bindCollector(input: {
    readonly collector: CapabilityCoordinate;
    readonly evidence: RecognitionEvidence;
    readonly configurationReferences: readonly string[];
  }): Promise<{ readonly configurationReferences: readonly string[] }> {
    if (
      sameCapabilityCoordinate(
        input.collector,
        this.#adapters.bangumi.collectorCapability,
      )
    ) {
      return this.bangumi.bindCollector(input);
    }
    if (
      sameCapabilityCoordinate(
        input.collector,
        this.#adapters.fanbox.collectorCapability,
      )
    ) {
      return this.fanbox.bindCollector(input);
    }
    const connection = sameCapabilityCoordinate(
      input.collector,
      this.#adapters.tmdb.collectorCapability,
    )
      ? this.tmdbPrivate
      : sameCapabilityCoordinate(
            input.collector,
            this.#adapters.omdb.collectorCapability,
          )
        ? this.omdbPrivate
        : undefined;
    if (connection === undefined) return { configurationReferences: [] };
    // 一旦本次执行拥有某个引用，就绝不以更新配置替换它。之后发生替换时应显式失败，
    // 而不是静默借用当前秘密。
    if (
      input.configurationReferences.some((reference) =>
        connection.ownsReference(reference),
      )
    ) {
      return { configurationReferences: [] };
    }
    return { configurationReferences: [connection.reference()] };
  }

  isConfigurationReferenceCurrent(reference: string): boolean {
    const connection = this.all.find((candidate) =>
      candidate.ownsReference(reference),
    );
    // 静态工作流引用由组合层的独立注册表检查。该能力绝不能仅因为某个任意不透明值
    // 不属于自己的引用，就认可它。
    return (
      connection?.isCurrentUsableReference(reference) === true ||
      this.bangumi.isConfigurationReferenceCurrent(reference) ||
      this.fanbox.isConfigurationReferenceCurrent(reference)
    );
  }

  bangumiCollector(): SourceCollector {
    return this.#adapters.bangumi.createCollector({
      authorization: this.bangumi.authorization(),
    });
  }

  tmdbCollector(): SourceCollector {
    return this.#adapters.tmdb.createCollector({
      accessTokenForExecution: (context) =>
        this.tmdb.accessTokenForExecution(context),
    });
  }

  omdbCollector(): SourceCollector {
    return this.#adapters.omdb.createCollector({
      apiKeyForExecution: (context) => this.omdb.apiKeyForExecution(context),
    });
  }

  fanboxCollector(): SourceCollector {
    return this.fanbox.collector();
  }

  get capabilityDeclarations(): readonly CapabilityCoordinate[] {
    return [
      this.#adapters.tmdb.connectionCapability,
      this.#adapters.omdb.connectionCapability,
      this.bangumi.capability,
      this.#adapters.fanbox.connectionCapability,
    ];
  }
}

function sameCapabilityCoordinate(
  candidate: CapabilityCoordinate,
  expected: CapabilityCoordinate,
): boolean {
  return (
    candidate.capabilityId === expected.capabilityId &&
    candidate.capabilityVersion === expected.capabilityVersion &&
    candidate.contractVersion === expected.contractVersion &&
    candidate.identity === expected.identity &&
    candidate.implementationVersion === expected.implementationVersion &&
    candidate.kind === expected.kind
  );
}
