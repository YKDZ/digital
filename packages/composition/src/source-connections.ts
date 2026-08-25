import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  SourceCollectionExecutionContext,
  SourceConnectionExecutionConfiguration,
} from "@digital/application";
import {
  BangumiCollector,
  bangumiOfficialCollectionCapability,
} from "@digital/bangumi";
import type {
  CapabilityCoordinate,
  RecognitionEvidence,
} from "@digital/domain";
import {
  FanboxCollector,
  fanboxCreatorIdFromEvidence,
  fanboxOfficialCollectionCapability,
  fanboxSourceConnectionCapability,
} from "@digital/fanbox";
import { omdbSourceConnectionCapability, OmdbCollector } from "@digital/omdb";
import { tmdbSourceConnectionCapability, TmdbCollector } from "@digital/tmdb";

import { ProductBangumiSourceConnection } from "./bangumi-source-connection.ts";

const privateDirectoryName = "private-source-connections";
const storageVersion = "product-source-connection/1";

export type SourceConnectionCredentialStatus =
  | "unconfigured"
  | "configured"
  | "revoked"
  /** 私有存储存在，但无法安全地描述一份可用凭据。 */
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

/** 对交付层安全的运维投影；它刻意无法泄露秘密。 */
export type SourceConnectionInspection = {
  readonly id: string;
  readonly capability: CapabilityCoordinate;
  readonly version: number;
  readonly credentialStatus: SourceConnectionCredentialStatus;
  readonly availability: SourceConnectionAvailability;
  readonly verifiedAt?: string;
  readonly reason?: SourceConnectionUnavailableReason;
};

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

/**
 * 一条由能力拥有的私有秘密记录。它刻意只暴露窄化操作，而非通用凭据文档或模式。
 */
class PrivateSourceConnection {
  private readonly privateDirectory: string;
  private readonly filePath: string;
  private readonly definition: SourceConnectionDefinition;

  constructor(
    definition: SourceConnectionDefinition,
    productDataDirectory: string,
  ) {
    this.definition = definition;
    this.privateDirectory = path.join(
      productDataDirectory,
      privateDirectoryName,
    );
    this.filePath = path.join(
      this.privateDirectory,
      `${definition.storageKey ?? definition.id}.json`,
    );
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
    const directory = inspectPrivateStoragePath(
      this.privateDirectory,
      "directory",
    );
    if (directory === "permissions-unsafe")
      return invalidSourceConnection(directory);
    if (directory === "storage-invalid")
      return invalidSourceConnection(directory);
    if (directory === "missing") {
      const bootstrapSecret = normalisedSecret(this.definition.bootstrapSecret);
      if (bootstrapSecret === undefined) return unconfiguredSourceConnection();
      const bootstrapped: PrivateSourceConnectionRecord = {
        version: storageVersion,
        configurationVersion: 1,
        credentialStatus: "configured",
        availability: "available",
        secret: bootstrapSecret,
      };
      // 环境变量仅作为首次引导输入。只有确实提供了秘密时，它才成为产品状态；
      // 无配置启动保持只读，使无效的外部请求无法创建文件。
      try {
        this.write(bootstrapped);
        return bootstrapped;
      } catch {
        return invalidSourceConnection("storage-invalid");
      }
    }
    const file = inspectPrivateStoragePath(this.filePath, "file");
    if (file === "permissions-unsafe") return invalidSourceConnection(file);
    if (file === "storage-invalid") return invalidSourceConnection(file);
    if (file === "missing") {
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
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      return invalidSourceConnection("storage-invalid");
    }
    if (!isPrivateSourceConnectionRecord(value))
      return invalidSourceConnection("storage-invalid");
    return value;
  }

  private write(record: PrivateSourceConnectionRecord): void {
    mkdirSync(this.privateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.privateDirectory, 0o700);
    const temporary = `${this.filePath}.next`;
    writeFileSync(temporary, JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
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

/**
 * 损坏的私有连接是本地运维前置条件失败，而不是目录启动失败。将检查保留在私有存储边界，
 * 使环境引导和调用方都无法意外覆盖需要修复的证据。
 */
function inspectPrivateStoragePath(
  candidate: string,
  expected: "directory" | "file",
): "missing" | "permissions-unsafe" | "storage-invalid" | "usable" {
  try {
    const stat = lstatSync(candidate);
    if (
      stat.isSymbolicLink() ||
      (expected === "directory" ? !stat.isDirectory() : !stat.isFile())
    ) {
      return "storage-invalid";
    }
    return (stat.mode & 0o077) === 0 ? "usable" : "permissions-unsafe";
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return "missing";
    }
    return "storage-invalid";
  }
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
  private readonly productDataDirectory: string;

  constructor(productDataDirectory: string) {
    this.productDataDirectory = productDataDirectory;
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
    const cookieHeader = fanboxBrowserCookieHeader(input.browserCookies);
    await verifyFanboxBrowserCredentials(input.creatorId, cookieHeader);
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
    const cookieHeader = fanboxBrowserCookieHeader(input.browserCookies);
    await verifyFanboxBrowserCredentials(input.creatorId, cookieHeader);
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
    const privateDirectory = path.join(
      this.productDataDirectory,
      privateDirectoryName,
    );
    if (inspectPrivateStoragePath(privateDirectory, "directory") !== "usable")
      return [];
    try {
      return readdirSync(privateDirectory)
        .flatMap((name) => {
          const match = /^fanbox--([a-zA-Z0-9_-]+)\.json$/u.exec(name);
          return match === null ? [] : [match[1]!];
        })
        .toSorted();
    } catch {
      return [];
    }
  }

  bindCollector(input: {
    readonly evidence: RecognitionEvidence;
    readonly configurationReferences: readonly string[];
  }): { readonly configurationReferences: readonly string[] } {
    const creatorId = fanboxCreatorIdFromEvidence(input.evidence);
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

  collector(): FanboxCollector {
    return new FanboxCollector({
      creatorIds: () => this.creatorIds(),
      cookieHeaderForExecution: (input) => this.cookieHeaderForExecution(input),
    });
  }

  private connectionFor(creatorId: string): PrivateSourceConnection {
    return new PrivateSourceConnection(
      {
        id: `fanbox/${creatorId}`,
        storageKey: `fanbox--${creatorId}`,
        capability: fanboxSourceConnectionCapability,
        bootstrapSecret: undefined,
        verify: async (cookieHeader) =>
          await verifyFanboxBrowserCredentials(creatorId, cookieHeader),
      },
      this.productDataDirectory,
    );
  }
}

function assertFanboxCreatorId(value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value))
    throw new Error("FANBOX 创作者范围无效");
}

function fanboxBrowserCookieHeader(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("FANBOX 浏览器凭据格式无效");
  const pairs: string[] = [];
  let hasSession = false;
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new Error("FANBOX 浏览器凭据格式无效");
    const cookie = item as {
      readonly name?: unknown;
      readonly value?: unknown;
      readonly domain?: unknown;
    };
    if (
      typeof cookie.name !== "string" ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(cookie.name) ||
      typeof cookie.value !== "string" ||
      cookie.value.length === 0 ||
      !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/u.test(cookie.value) ||
      (cookie.domain !== undefined &&
        cookie.domain !== "fanbox.cc" &&
        cookie.domain !== ".fanbox.cc")
    ) {
      throw new Error("FANBOX 浏览器凭据格式无效");
    }
    pairs.push(`${cookie.name}=${cookie.value}`);
    hasSession ||= cookie.name === "FANBOXSESSID";
  }
  if (pairs.length === 0 || !hasSession)
    throw new Error("FANBOX 浏览器凭据缺少有效会话");
  return pairs.join("; ");
}

async function verifyFanboxBrowserCredentials(
  creatorId: string,
  cookieHeader: string,
): Promise<void> {
  // `post.listCreator` 是公开预览端点，因此成功响应既不能证明导入的浏览器会话有效，
  // 也不能证明其当前身份。受保护身份端点刻意没有创作者特定的授权声明：有效的已登录会话
  // 在后续刷新时仍可能只对所配置创作者拥有部分访问权限。
  const endpoint = new URL("https://api.fanbox.cc/user.me");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
        Origin: "https://www.fanbox.cc",
        Referer: `https://www.fanbox.cc/@${creatorId}`,
        "User-Agent": "digital-fanbox-integration/1",
      },
    });
  } catch {
    throw new Error("FANBOX 来源连接验证失败");
  }
  if (!response.ok) throw new Error("FANBOX 来源连接验证失败");
  if (!isJsonMediaType(response.headers.get("content-type")))
    throw new Error("FANBOX 来源连接验证失败");
  let envelope: unknown;
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024)
      throw new Error("invalid response");
    envelope = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("FANBOX 来源连接验证失败");
  }
  if (!fanboxAuthenticatedUser(envelope))
    throw new Error("FANBOX 来源连接验证失败");
}

function fanboxAuthenticatedUser(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const envelope = value as Record<string, unknown>;
  if (
    !Object.hasOwn(envelope, "body") ||
    (Object.hasOwn(envelope, "error") &&
      envelope.error !== undefined &&
      envelope.error !== null &&
      envelope.error !== false &&
      envelope.error !== "") ||
    (Object.hasOwn(envelope, "errors") &&
      envelope.errors !== undefined &&
      envelope.errors !== null &&
      envelope.errors !== false)
  ) {
    return false;
  }
  const body = envelope.body;
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return false;
  const userId = (body as Record<string, unknown>).userId;
  return (
    (typeof userId === "string" && userId.trim().length > 0) ||
    (typeof userId === "number" && Number.isSafeInteger(userId) && userId > 0)
  );
}

function isJsonMediaType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/**
 * 由产品拥有的当前已部署来源连接注册表。它保留在组合层，因为只有组合层知道哪个集成
 * 接收哪个私有句柄；应用层只看到不透明配置引用。
 */
export class ProductSourceConnections implements SourceConnectionExecutionConfiguration {
  private readonly byCollectorCapability: ReadonlyMap<
    string,
    PrivateSourceConnection
  >;
  private readonly all: readonly PrivateSourceConnection[];
  readonly tmdb: TmdbSourceConnection;
  readonly omdb: OmdbSourceConnection;
  readonly fanbox: ProductFanboxSourceConnections;
  readonly bangumi: ProductBangumiSourceConnection;

  constructor(
    productDataDirectory: string,
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    const tmdb = new PrivateSourceConnection(
      {
        id: "tmdb",
        capability: tmdbSourceConnectionCapability,
        bootstrapSecret: environment.DIGITAL_TMDB_ACCESS_TOKEN,
        verify: verifyTmdbAccessToken,
      },
      productDataDirectory,
    );
    const omdb = new PrivateSourceConnection(
      {
        id: "omdb",
        capability: omdbSourceConnectionCapability,
        bootstrapSecret: environment.DIGITAL_OMDB_API_KEY,
        verify: verifyOmdbApiKey,
      },
      productDataDirectory,
    );
    this.tmdb = new TmdbSourceConnection(tmdb);
    this.omdb = new OmdbSourceConnection(omdb);
    this.fanbox = new ProductFanboxSourceConnections(productDataDirectory);
    this.bangumi = new ProductBangumiSourceConnection({
      productDataDirectory,
      environment,
    });
    this.all = [tmdb, omdb];
    this.byCollectorCapability = new Map([
      ["tmdb.official-film-collection", tmdb],
      ["omdb.film-enrichment-collection", omdb],
    ]);
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
        bangumiOfficialCollectionCapability,
      )
    ) {
      return this.bangumi.bindCollector(input);
    }
    if (
      sameCapabilityCoordinate(
        input.collector,
        fanboxOfficialCollectionCapability,
      )
    ) {
      return this.fanbox.bindCollector(input);
    }
    const connection = this.byCollectorCapability.get(
      input.collector.capabilityId,
    );
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

  bangumiCollector(): BangumiCollector {
    return new BangumiCollector({
      authorization: this.bangumi.authorization(),
    });
  }

  tmdbCollector(): TmdbCollector {
    return new TmdbCollector({
      accessTokenForExecution: (context) =>
        this.tmdb.accessTokenForExecution(context),
    });
  }

  omdbCollector(): OmdbCollector {
    return new OmdbCollector({
      apiKeyForExecution: (context) => this.omdb.apiKeyForExecution(context),
    });
  }

  fanboxCollector(): FanboxCollector {
    return this.fanbox.collector();
  }

  get capabilityDeclarations(): readonly CapabilityCoordinate[] {
    return [
      tmdbSourceConnectionCapability,
      omdbSourceConnectionCapability,
      this.bangumi.capability,
      fanboxSourceConnectionCapability,
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

async function verifyTmdbAccessToken(accessToken: string): Promise<void> {
  const response = await fetch("https://api.themoviedb.org/3/authentication", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error("TMDB 来源连接验证失败");
}

async function verifyOmdbApiKey(apiKey: string): Promise<void> {
  const endpoint = new URL("https://www.omdbapi.com/");
  endpoint.searchParams.set("apikey", apiKey);
  endpoint.searchParams.set("i", "tt3896198");
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error("OMDb 来源连接验证失败");
  // OMDb 会在成功 HTTP 响应中报告密钥被拒绝。只有其显式成功载荷才可视为可用连接；
  // 远端诊断可能包含请求上下文，因此应保持私有。
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(await response.arrayBuffer()),
    ) as unknown;
  } catch {
    throw new Error("OMDb 来源连接验证失败");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as Record<string, unknown>).Response !== "True"
  ) {
    throw new Error("OMDb 来源连接验证失败");
  }
}
