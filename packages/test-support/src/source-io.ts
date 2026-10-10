import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 受控外部来源 I/O 的窄出口：只读取清单与响应字节、精确匹配请求、构造响应对象，
 * 并在没有条目时拒绝。这里不认识来源、作品或资产，也不含任何录制回放状态。
 */
export const controlledSourceIoFormatVersion = 1;

/** 清单声明的普通请求条目。URL 采用完整已定义地址，未声明参数一律视为未知。 */
export type ControlledRequestEntryInput = {
  readonly id: string;
  readonly url: string;
  /** 校验后的方法，清单可省略并由解析给出 GET 默认。 */
  readonly method: string;
  readonly require?: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  };
  readonly status: number;
  readonly mediaType: string;
  readonly finalUrl?: string;
  readonly responseFile: string;
};

export type ControlledSourceIoManifestInput = {
  readonly formatVersion: number;
  readonly ordinary: readonly ControlledRequestEntryInput[];
  readonly session?: readonly ControlledSessionEntryInput[];
};

/**
 * 会话条目声明的是 FANBOX 封闭端点，不是 URL。端点种类、创作者范围、该端点必要的
 * limit／postId／access 以及合成私有上下文标识共同组成请求键，因此公开与已连接是
 * 两个不同条目，绝不互相借用。
 */
export type ControlledSessionEndpointKind =
  | "login-status"
  | "creator-summaries"
  | "post-detail";

export type ControlledSessionEntryInput = {
  readonly id: string;
  readonly creatorId: string;
  readonly endpoint: ControlledSessionEndpointKind;
  readonly limit?: 1 | 300;
  readonly postId?: string;
  readonly access?: "connected" | "public";
  /** 该条目可接受的合成私有上下文摘要；清单不重复凭据本身。 */
  readonly privateContextIdentity: string;
  readonly status: number;
  readonly mediaType: string;
  readonly responseFile: string;
};

/** 与 FANBOX 生产 transport 结构一致的封闭端点判别式，本模块不导入来源实现。 */
export type ControlledSessionEndpoint =
  | { readonly kind: "login-status" }
  | {
      readonly kind: "creator-summaries";
      readonly creatorId: string;
      readonly limit: 1 | 300;
    }
  | {
      readonly kind: "post-detail";
      readonly postId: string;
      readonly access: "connected" | "public";
    };

export type ControlledSessionResponse =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly mediaType: string | null;
      readonly body: Uint8Array;
    }
  | {
      readonly kind: "response-limit";
      readonly status: number;
      readonly mediaType: string | null;
    }
  | {
      readonly kind: "cloudflare-challenge";
      readonly status: number;
      readonly mediaType: string | null;
      readonly cfMitigated: "challenge" | null;
    };

export type ControlledPrivateBrowserContext = {
  readonly format: "fanbox-browser-request-context/2";
  readonly userAgent: string;
  readonly cookies: readonly {
    readonly name: string;
    readonly value: string;
    readonly domain: "fanbox.cc" | ".fanbox.cc";
    readonly path: string;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
    readonly sameSite?: "Strict" | "Lax" | "None";
    readonly expires?: number;
  }[];
};

export type ControlledSessionGet = (
  endpoint: ControlledSessionEndpoint,
) => Promise<ControlledSessionResponse>;

export type ControlledSessionTransport = {
  transact<Result>(input: {
    readonly creatorId: string;
    readonly privateContext: ControlledPrivateBrowserContext;
    readonly use: (get: ControlledSessionGet) => Promise<Result>;
  }): Promise<Result>;
  close(): Promise<void>;
};

export type ControlledResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type ControlledRequestInit = {
  readonly method?: string;
  readonly headers?: unknown;
  readonly body?: unknown;
};

export type ControlledRequest = (
  input: string,
  init?: ControlledRequestInit,
) => Promise<ControlledResponse>;

/** 清单在选择或读取阶段的失败：发生在产品准入与 ready 之前。 */
export class ControlledSourceIoStartupProblem extends Error {
  override readonly name = "ControlledSourceIoStartupProblem";
}

/** 没有条目时的受控拒绝。诊断只定位边界与非秘密请求键。 */
export class ControlledRequestRefusal extends Error {
  override readonly name = "ControlledRequestRefusal";
  readonly requestKey: string;
  constructor(boundary: string, requestKey: string) {
    super(
      `受控来源拒绝：边界 ${boundary} 没有匹配条目（请求键 ${requestKey}）`,
    );
    this.requestKey = requestKey;
  }
}

export type LoadedControlledSourceIo = {
  readonly request: ControlledRequest;
  readonly sessionTransport?: ControlledSessionTransport;
  readonly contentIdentity: string;
  readonly entryIds: readonly string[];
};

type LoadedEntry = {
  readonly entry: ControlledRequestEntryInput;
  readonly bytes: Uint8Array;
};

export type LoadedSessionEntry = {
  readonly entry: ControlledSessionEntryInput;
  readonly bytes: Uint8Array;
};

function startupProblem(reason: string): ControlledSourceIoStartupProblem {
  return new ControlledSourceIoStartupProblem(`受控来源清单无效：${reason}`);
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 查询可能携带密钥，因此诊断只用方法、来源与路径定位请求。 */
function nonSecretRequestKey(url: string, method: string): string {
  const withoutQuery = url.split(/[?#]/u, 1)[0] ?? url;
  return `${method} ${withoutQuery}`;
}

function declaredHeader(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (headers as { get(value: string): unknown }).get(name);
    return typeof value === "string" ? value : undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    if (key.toLowerCase() === wanted && typeof value === "string") return value;
  }
  return undefined;
}

function declaredBody(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (Array.isArray(body) && body.every((item) => typeof item === "number")) {
    return new TextDecoder().decode(Uint8Array.from(body));
  }
  return undefined;
}

function requiredConditionsSatisfied(
  entry: ControlledRequestEntryInput,
  init: ControlledRequestInit | undefined,
): boolean {
  if (entry.require === undefined) return true;
  if (entry.require.body !== undefined) {
    if (declaredBody(init?.body) !== entry.require.body) return false;
  }
  for (const [name, expected] of Object.entries(entry.require.headers ?? {})) {
    if (declaredHeader(init?.headers, name) !== expected) return false;
  }
  return true;
}

function parseEntry(
  value: unknown,
  position: number,
  manifestDirectory: string,
): ControlledRequestEntryInput {
  if (value === null || typeof value !== "object") {
    throw startupProblem(`第 ${String(position)} 个普通条目不是对象`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "url",
    "method",
    "require",
    "status",
    "mediaType",
    "finalUrl",
    "responseFile",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw startupProblem(`普通条目包含未知字段 ${key}`);
  }
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    throw startupProblem(`第 ${String(position)} 个普通条目缺少条目标识`);
  }
  const url = record.url;
  if (typeof url !== "string" || !isExactAddress(url)) {
    throw startupProblem(`条目 ${id} 的请求地址不是完整已定义地址`);
  }
  const method = record.method ?? "GET";
  if (typeof method !== "string" || !/^[A-Z]+$/u.test(method)) {
    throw startupProblem(`条目 ${id} 的方法无效`);
  }
  const status = record.status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    throw startupProblem(`条目 ${id} 的响应状态无效`);
  }
  const mediaType = record.mediaType;
  if (typeof mediaType !== "string" || !/^[^/\s]+\/[^/\s;]+/u.test(mediaType)) {
    throw startupProblem(`条目 ${id} 的媒体类型无效`);
  }
  const finalUrl = record.finalUrl;
  if (
    finalUrl !== undefined &&
    (typeof finalUrl !== "string" || !isExactAddress(finalUrl))
  ) {
    throw startupProblem(`条目 ${id} 的最终地址无效`);
  }
  const responseFile = record.responseFile;
  if (
    typeof responseFile !== "string" ||
    path.isAbsolute(responseFile) ||
    responseFile.split(/[\\/]/u).some((segment) => segment === "..") ||
    !path
      .resolve(manifestDirectory, responseFile)
      .startsWith(`${manifestDirectory}${path.sep}`)
  ) {
    throw startupProblem(`条目 ${id} 的响应文件必须位于清单目录内`);
  }
  const require = record.require;
  let required: ControlledRequestEntryInput["require"];
  if (require === undefined) required = undefined;
  else {
    if (require === null || typeof require !== "object") {
      throw startupProblem(`条目 ${id} 的请求条件不是对象`);
    }
    const conditionRecord = require as Record<string, unknown>;
    const headers = conditionRecord.headers;
    const body = conditionRecord.body;
    if (
      headers !== undefined &&
      (headers === null ||
        typeof headers !== "object" ||
        Object.values(headers as Record<string, unknown>).some(
          (value) => typeof value !== "string",
        ))
    ) {
      throw startupProblem(`条目 ${id} 的请求头条件无效`);
    }
    if (body !== undefined && typeof body !== "string") {
      throw startupProblem(`条目 ${id} 的请求体条件无效`);
    }
    const unknownConditionKey =
      Object.keys(conditionRecord).find(
        (key) => key !== "headers" && key !== "body",
      ) !== undefined;
    if (unknownConditionKey) {
      throw startupProblem(`条目 ${id} 的请求条件包含未知字段`);
    }
    required = {
      ...(headers === undefined
        ? {}
        : { headers: headers as Readonly<Record<string, string>> }),
      ...(body === undefined ? {} : { body }),
    };
  }
  return {
    id,
    url,
    method,
    status,
    mediaType,
    responseFile,
    ...(finalUrl === undefined ? {} : { finalUrl }),
    ...(required === undefined ? {} : { require: required }),
  };
}

function isExactAddress(value: string): boolean {
  if (/\s/u.test(value)) return false;
  try {
    const address = new URL(value);
    return (
      (address.protocol === "https:" || address.protocol === "http:") &&
      address.hostname.length > 0 &&
      address.toString() === value
    );
  } catch {
    return false;
  }
}

function isValidStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

function isValidMediaType(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/[^/\s;]+/u.test(value);
}

function isResponseFileInsideManifest(
  value: unknown,
  manifestDirectory: string,
): value is string {
  return (
    typeof value === "string" &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).some((segment) => segment === "..") &&
    path
      .resolve(manifestDirectory, value)
      .startsWith(`${manifestDirectory}${path.sep}`)
  );
}

/**
 * 会话请求键由创作者范围、封闭端点种类以及该端点必要的 limit／postId／access 共同决定，
 * 因此一个条目只会服务同一创作者的事务；access 与 limit 都是键的一部分。
 */
function sessionRequestKey(
  creatorId: string,
  endpoint: ControlledSessionEndpoint,
): string {
  if (endpoint.kind === "login-status") return `login-status/${creatorId}`;
  if (endpoint.kind === "creator-summaries")
    return `creator-summaries/${endpoint.creatorId}/limit=${String(
      endpoint.limit,
    )}`;
  return `post-detail/${creatorId}/${endpoint.postId}/access=${endpoint.access}`;
}

function declaredSessionEndpoint(
  entry: ControlledSessionEntryInput,
): ControlledSessionEndpoint {
  if (entry.endpoint === "login-status") return { kind: "login-status" };
  if (entry.endpoint === "creator-summaries")
    return {
      kind: "creator-summaries",
      creatorId: entry.creatorId,
      limit: entry.limit!,
    };
  return {
    kind: "post-detail",
    postId: entry.postId!,
    access: entry.access!,
  };
}

function parseSessionEntry(
  value: unknown,
  position: number,
  manifestDirectory: string,
): ControlledSessionEntryInput {
  const label = `第 ${String(position)} 个会话条目`;
  if (value === null || typeof value !== "object") {
    throw startupProblem(`${label}不是对象`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "creatorId",
    "endpoint",
    "limit",
    "postId",
    "access",
    "privateContextIdentity",
    "status",
    "mediaType",
    "responseFile",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw startupProblem(`${label}包含未知字段 ${key}`);
  }
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    throw startupProblem(`${label}缺少条目标识`);
  }
  const creatorId = record.creatorId;
  if (
    typeof creatorId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/u.test(creatorId) ||
    creatorId !== creatorId.trim()
  ) {
    throw startupProblem(`会话条目 ${id} 的创作者范围无效`);
  }
  const endpoint = record.endpoint;
  if (
    endpoint !== "login-status" &&
    endpoint !== "creator-summaries" &&
    endpoint !== "post-detail"
  ) {
    throw startupProblem(`会话条目 ${id} 的封闭端点种类无效`);
  }
  const limit = record.limit;
  const postId = record.postId;
  const access = record.access;
  if (endpoint === "login-status") {
    if (limit !== undefined || postId !== undefined || access !== undefined) {
      throw startupProblem(`会话条目 ${id} 的登录端点不接受附加参数`);
    }
  } else if (endpoint === "creator-summaries") {
    if (limit !== 1 && limit !== 300) {
      throw startupProblem(`会话条目 ${id} 的摘要 limit 无效`);
    }
    if (postId !== undefined || access !== undefined) {
      throw startupProblem(`会话条目 ${id} 的摘要端点不接受帖子参数`);
    }
  } else {
    if (typeof postId !== "string" || !/^\d+$/u.test(postId)) {
      throw startupProblem(`会话条目 ${id} 的帖子标识无效`);
    }
    if (access !== "connected" && access !== "public") {
      throw startupProblem(`会话条目 ${id} 的帖子访问范围无效`);
    }
    if (limit !== undefined) {
      throw startupProblem(`会话条目 ${id} 的详情端点不接受 limit`);
    }
  }
  const privateContextIdentity = record.privateContextIdentity;
  if (
    typeof privateContextIdentity !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(privateContextIdentity)
  ) {
    throw startupProblem(`会话条目 ${id} 必须给出合成私有上下文的 sha256 标识`);
  }
  const status = record.status;
  if (!isValidStatus(status)) {
    throw startupProblem(`会话条目 ${id} 的响应状态无效`);
  }
  const mediaType = record.mediaType;
  if (!isValidMediaType(mediaType)) {
    throw startupProblem(`会话条目 ${id} 的媒体类型无效`);
  }
  const responseFile = record.responseFile;
  if (!isResponseFileInsideManifest(responseFile, manifestDirectory)) {
    throw startupProblem(`会话条目 ${id} 的响应文件必须位于清单目录内`);
  }
  return {
    id,
    creatorId,
    endpoint,
    privateContextIdentity,
    status,
    mediaType,
    responseFile,
    ...(limit === undefined ? {} : { limit: limit as 1 | 300 }),
    ...(typeof postId === "string" ? { postId } : {}),
    ...(access === undefined
      ? {}
      : { access: access as "connected" | "public" }),
  };
}

/**
 * 合成私有上下文的非秘密标识：只哈希 user agent、Cookie 名与顺序等结构事实之外的完整
 * 规范化串，因此清单能约束可接受的上下文，却不需要重复凭据本身。
 */
export function fanboxPrivateContextIdentity(
  context: ControlledPrivateBrowserContext,
): string {
  return `sha256:${digestBytes(
    new TextEncoder().encode(
      canonicalJson({
        format: context.format,
        userAgent: context.userAgent,
        cookies: context.cookies,
      }),
    ),
  )}`;
}

/**
 * 读取并校验清单，把所引用响应字节一次性载入内存。任何无效输入都在这一步抛出，
 * 调用方不得捕获后以真实模式继续。
 */
export async function loadControlledSourceIo(input: {
  readonly manifestPath: string;
  readonly expectedContentIdentity?: string;
}): Promise<LoadedControlledSourceIo> {
  const manifestDirectory = path.resolve(
    path.dirname(path.resolve(input.manifestPath)),
  );
  const text = await readFile(input.manifestPath, "utf8").catch((error) => {
    throw startupProblem(
      `清单 ${input.manifestPath} 无法读取（${
        error instanceof Error ? error.message : "未知错误"
      }）`,
    );
  });
  const parsed: unknown = JSON.parse(text, undefined);
  if (parsed === null || typeof parsed !== "object") {
    throw startupProblem("清单根节点不是对象");
  }
  const document = parsed as Record<string, unknown>;
  const unknownKey = Object.keys(document).find(
    (key) => key !== "formatVersion" && key !== "ordinary" && key !== "session",
  );
  if (unknownKey !== undefined) {
    throw startupProblem(`清单包含本格式版本不认识的条目集合 ${unknownKey}`);
  }
  if (document.formatVersion !== controlledSourceIoFormatVersion) {
    throw startupProblem(
      `清单格式版本 ${String(document.formatVersion)} 不受支持，只支持 ${String(
        controlledSourceIoFormatVersion,
      )}`,
    );
  }
  if (!Array.isArray(document.ordinary)) {
    throw startupProblem("普通条目集合必须是数组");
  }
  const entries = document.ordinary.map((value, position) =>
    parseEntry(value, position, manifestDirectory),
  );
  const session = parseSessionEntries(
    document.session,
    manifestDirectory,
    entries.map(({ id }) => id),
  );

  const byKey = new Map<string, LoadedEntry>();
  const identities: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const bytes = new Uint8Array(
      await readFile(path.resolve(manifestDirectory, entry.responseFile)).catch(
        () => {
          throw startupProblem(`条目 ${entry.id} 的响应字节无法读取`);
        },
      ),
    );
    const key = `${entry.method} ${entry.url}`;
    if (byKey.has(key)) {
      throw startupProblem(
        `请求键重复：${nonSecretRequestKey(entry.url, entry.method)}`,
      );
    }
    byKey.set(key, { entry, bytes });
    identities.push({ ...entry, responseDigest: digestBytes(bytes) });
  }
  const sessionEntries = new Map<string, LoadedSessionEntry>();
  for (const entry of session ?? []) {
    const bytes = new Uint8Array(
      await readFile(path.resolve(manifestDirectory, entry.responseFile)).catch(
        () => {
          throw startupProblem(`会话条目 ${entry.id} 的响应字节无法读取`);
        },
      ),
    );
    const key = sessionRequestKey(
      entry.creatorId,
      declaredSessionEndpoint(entry),
    );
    if (sessionEntries.has(key)) {
      throw startupProblem(`会话请求键重复：${key}`);
    }
    sessionEntries.set(key, { entry, bytes });
    identities.push({ ...entry, responseDigest: digestBytes(bytes) });
  }

  const contentIdentity = `sha256:${digestBytes(
    new TextEncoder().encode(
      canonicalJson(
        identities.toSorted((left, right) =>
          String(left.id).localeCompare(String(right.id)),
        ),
      ),
    ),
  )}`;
  if (
    input.expectedContentIdentity !== undefined &&
    input.expectedContentIdentity !== contentIdentity
  ) {
    throw startupProblem(
      `清单内容身份不符：期望 ${input.expectedContentIdentity}，实际 ${contentIdentity}`,
    );
  }

  const request: ControlledRequest = async (url, init) => {
    const method =
      init?.method === undefined ? "GET" : String(init.method).toUpperCase();
    const match = byKey.get(`${method} ${url}`);
    if (match === undefined) {
      throw new ControlledRequestRefusal(
        "ordinary-request",
        nonSecretRequestKey(url, method),
      );
    }
    if (!requiredConditionsSatisfied(match.entry, init)) {
      throw new ControlledRequestRefusal(
        `ordinary-request/${match.entry.id}`,
        nonSecretRequestKey(url, method),
      );
    }
    const bytes = match.bytes;
    return {
      ok: match.entry.status >= 200 && match.entry.status < 300,
      status: match.entry.status,
      url: match.entry.finalUrl ?? url,
      headers: {
        get(name: string): string | null {
          return name.toLowerCase() === "content-type"
            ? match.entry.mediaType
            : null;
        },
      },
      // 每次调用给出新的字节副本，响应从不被共享或提前消费。
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    };
  };
  return {
    request,
    ...(session === undefined
      ? {}
      : {
          sessionTransport: createControlledSessionTransport({
            responses: [...sessionEntries.values()],
          }),
        }),
    contentIdentity,
    entryIds: [
      ...entries.map(({ id }) => id),
      ...(session === undefined ? [] : session.map(({ id }) => id)),
    ],
  };
}

function parseSessionEntries(
  value: unknown,
  manifestDirectory: string,
  ordinaryIds: readonly string[],
): readonly ControlledSessionEntryInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw startupProblem("会话条目集合必须是数组");
  }
  if (value.length === 0) {
    throw startupProblem("会话条目集合不能为空；缺少会话条目时应省略该集合");
  }
  const entries = value.map((item, position) =>
    parseSessionEntry(item, position, manifestDirectory),
  );
  const ids = new Set<string>(ordinaryIds);
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw startupProblem(`条目标识重复：${entry.id}`);
    }
    ids.add(entry.id);
  }
  return entries;
}

/**
 * 清单驱动的 FANBOX 会话 transport。它只做三件事：核对合成私有上下文标识、按封闭端点
 * 键匹配条目、给出响应字节的新的副本。没有浏览器、没有网络、没有回放游标；close 幂等，
 * 关闭后的新事务一律拒绝。
 */
export function createControlledSessionTransport(input: {
  readonly responses: readonly LoadedSessionEntry[];
}): ControlledSessionTransport {
  const byKey = new Map<string, LoadedSessionEntry>();
  for (const loaded of input.responses) {
    const key = sessionRequestKey(
      loaded.entry.creatorId,
      declaredSessionEndpoint(loaded.entry),
    );
    if (byKey.has(key)) {
      throw startupProblem(`会话请求键重复：${key}`);
    }
    byKey.set(key, loaded);
  }
  let closed = false;
  return {
    async transact<Result>(transaction: {
      readonly creatorId: string;
      readonly privateContext: ControlledPrivateBrowserContext;
      readonly use: (get: ControlledSessionGet) => Promise<Result>;
    }): Promise<Result> {
      if (closed) {
        throw new ControlledRequestRefusal(
          "fanbox-session/closed",
          `transact/${transaction.creatorId}`,
        );
      }
      return await transaction.use(async (endpoint) => {
        if (closed) {
          throw new ControlledRequestRefusal(
            "fanbox-session/closed",
            sessionRequestKey(transaction.creatorId, endpoint),
          );
        }
        if (
          endpoint.kind === "creator-summaries" &&
          endpoint.creatorId !== transaction.creatorId
        ) {
          throw new ControlledRequestRefusal(
            "fanbox-session/creator-scope",
            sessionRequestKey(transaction.creatorId, endpoint),
          );
        }
        const key = sessionRequestKey(transaction.creatorId, endpoint);
        const match = byKey.get(key);
        if (match === undefined) {
          throw new ControlledRequestRefusal("fanbox-session", key);
        }
        // 合成私有上下文标识是会话请求键的一部分；不符时不给出任何响应字节。
        if (
          match.entry.privateContextIdentity !==
          fanboxPrivateContextIdentity(transaction.privateContext)
        ) {
          throw new ControlledRequestRefusal("fanbox-session/context", key);
        }
        return {
          kind: "response",
          status: match.entry.status,
          mediaType: match.entry.mediaType,
          // 每次请求给出新的字节副本；响应条目可重复读取，不依赖到达顺序。
          body: Uint8Array.from(match.bytes),
        };
      });
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

/**
 * FANBOX 会话 transport 的拒绝实现：`offline` 模式与只声明普通条目的清单都用它。
 * 没有会话条目时不存在任何可满足的封闭端点，事务在触达来源之前即失败。
 * 结构由调用方的类型检查确认与来源接口兼容。
 */
export function refusingSessionTransport(): {
  transact(): Promise<never>;
  close(): Promise<void>;
} {
  let closed = false;
  return {
    transact: async () => {
      if (closed) throw new Error("受控 FANBOX 会话 transport 已关闭");
      throw new ControlledRequestRefusal(
        "fanbox-session",
        "受控装配未声明任何会话条目",
      );
    },
    close: async () => {
      closed = true;
    },
  };
}

/**
 * 全拒绝的普通请求：没有清单可匹配，任何外部来源工作在到达网络之前失败。
 * 诊断沿用了同一条非秘密请求键规则，不记录 Cookie、Authorization 或查询参数。
 */
export function refusingOrdinaryRequest(): ControlledRequest {
  return async (url, init) => {
    const method =
      init?.method === undefined ? "GET" : String(init.method).toUpperCase();
    throw new ControlledRequestRefusal(
      "offline-request",
      nonSecretRequestKey(url, method),
    );
  };
}

export const sourceIoModeVariable = "DIGITAL_SOURCE_IO_MODE";
export const sourceIoConfigVariable = "DIGITAL_SOURCE_IO_CONFIG";
export const sourceIoIdentityVariable = "DIGITAL_SOURCE_IO_IDENTITY";

export type ResolvedProductSourceIo =
  | { readonly mode: "real" }
  | {
      readonly mode: "controlled" | "offline";
      readonly request: ControlledRequest;
      readonly sessionTransport:
        | ControlledSessionTransport
        | ReturnType<typeof refusingSessionTransport>;
    };

/**
 * 可执行根共用的启动解析。托管环境总会显式给出选择：`offline` 注入全拒绝依赖集合，
 * `controlled` 必须给出有效清单与身份；缺清单、缺身份、身份不符、显式模式与清单混用
 * 都在产品准入之前失败，绝不回退。只有不经环境管理的既有裸部署会缺少模式变量，
 * 按已接受设计保留原来的真实启动行为。
 */
export async function resolveSourceIoFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedProductSourceIo> {
  const mode = environment[sourceIoModeVariable];
  const manifestPath = environment[sourceIoConfigVariable];
  const identity = environment[sourceIoIdentityVariable];
  if (mode === undefined || mode === "real" || mode === "offline") {
    if (manifestPath !== undefined || identity !== undefined) {
      throw new ControlledSourceIoStartupProblem(
        `来源模式 ${mode ?? "real"} 不加载受控清单，不能同时给出清单配置`,
      );
    }
    if (mode === "offline") {
      return {
        mode: "offline",
        request: refusingOrdinaryRequest(),
        sessionTransport: refusingSessionTransport(),
      };
    }
    return { mode: "real" };
  }
  if (mode !== "controlled") {
    throw new ControlledSourceIoStartupProblem(
      `未知来源模式 ${mode}，只接受 offline、controlled 或 real`,
    );
  }
  if (manifestPath === undefined || manifestPath.length === 0) {
    throw new ControlledSourceIoStartupProblem(
      "受控来源模式必须给出调用方选择的响应清单绝对路径",
    );
  }
  if (!path.isAbsolute(manifestPath)) {
    throw new ControlledSourceIoStartupProblem(
      "受控来源清单路径必须是绝对路径",
    );
  }
  if (identity === undefined || !/^sha256:[a-f0-9]{64}$/u.test(identity)) {
    throw new ControlledSourceIoStartupProblem(
      "受控来源清单必须同时给出 sha256 内容身份",
    );
  }
  const loaded = await loadControlledSourceIo({
    manifestPath,
    expectedContentIdentity: identity,
  });
  return {
    mode: "controlled",
    request: loaded.request,
    // 只声明普通条目的清单没有可满足的封闭端点，会话仍走拒绝实现；带会话集合的清单
    // 才装配按端点键匹配的 transport，两条边界互不代替。
    sessionTransport: loaded.sessionTransport ?? refusingSessionTransport(),
  };
}
