import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 开发预览调用方使用的正式产品入口客户端。
 *
 * 只通过真实 HTTP 调用运行中的产品：目录接入沿用资产库设置、刷新执行与工作流查询，
 * 浏览与封面读取沿用内容目录与受管产物入口。这里不复制产品内部实现，也不为预览
 * 建立第二套数据写入路径。
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type ProductReply = {
  readonly status: number;
  readonly body: JsonValue;
};

export type ProductArtifact = {
  readonly status: number;
  readonly mediaType: string | null;
  readonly bytes: Uint8Array;
};

export type ProductLibrary = {
  readonly id: string;
  readonly displayName: string;
  readonly configVersion: number;
  readonly directories: readonly string[];
  readonly observedRootIds: readonly string[];
};

export type ProductExecution = {
  readonly id: string;
  readonly status: string;
  readonly outcome: string | undefined;
  readonly reply: JsonValue;
};

export type ProductClient = {
  readonly address: string;
  get(
    pathname: string,
    query?: Record<string, string | number>,
  ): Promise<ProductReply>;
  post(pathname: string, body: JsonObject): Promise<ProductReply>;
  bytes(pathname: string): Promise<ProductArtifact>;
  readiness(): Promise<{ readonly status: number; readonly ready: boolean }>;
  libraries(): Promise<readonly ProductLibrary[]>;
  saveLibrary(input: {
    readonly displayName: string;
    readonly directories: readonly string[];
    readonly recognitionProfileIds: readonly string[];
    readonly sourceIdentities: readonly string[];
  }): Promise<string>;
  startRefresh(assetLibraryId: string): Promise<string>;
  awaitExecution(
    executionId: string,
    timeoutMs: number,
    pollMs?: number,
  ): Promise<ProductExecution>;
  inspectSubject(subjectId: string): Promise<JsonObject>;
  coverCandidates(subjectId: string): Promise<JsonObject>;
  chooseCover(input: {
    readonly entityId: string;
    readonly candidateReference: string;
  }): Promise<{ readonly previewId: string }>;
  applyPreview(previewId: string, actorId: string): Promise<JsonValue>;
};

const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * 受理只看产品实际返回的 2xx：`/api/refresh` 是 201、`/api/cover-decisions` 是 202，
 * 逐一硬编码状态码会把真实入口写歪；4xx 与 5xx 仍然原样报出，不静默通过。
 */
const expectAccepted = (reply: ProductReply, label: string): void => {
  if (reply.status < 200 || reply.status >= 300)
    throw new Error(
      `${label}未受理（${String(reply.status)}）：${JSON.stringify(reply.body).slice(0, 500)}`,
    );
};

const number = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number" ? value : undefined;

const object = (value: JsonValue | undefined): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const array = (value: JsonValue | undefined): readonly JsonValue[] =>
  Array.isArray(value) ? value : [];

function requiredText(
  source: JsonObject,
  key: string,
  context: string,
): string {
  const value = text(source[key]);
  if (value === undefined || value.length === 0)
    throw new Error(`${context}缺少字段 ${key}`);
  return value;
}

export function createProductClient(address: string): ProductClient {
  const base = address.replace(/\/+$/u, "");
  const url = (pathname: string, query?: Record<string, string | number>) => {
    const target = new URL(`${base}/api${pathname}`);
    for (const [key, value] of Object.entries(query ?? {}))
      target.searchParams.set(key, String(value));
    return target.toString();
  };

  async function json(
    method: "GET" | "POST",
    pathname: string,
    options: {
      readonly query?: Record<string, string | number> | undefined;
      readonly body?: JsonObject | undefined;
    } = {},
  ): Promise<ProductReply> {
    const response = await fetch(url(pathname, options.query), {
      method,
      ...(options.body === undefined
        ? {}
        : {
            body: JSON.stringify(options.body),
            headers: { "content-type": "application/json" },
          }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = (
      contentType.includes("application/json")
        ? await response.json()
        : await response.text()
    ) as JsonValue;
    if (response.status >= 500)
      throw new Error(
        `产品入口 ${method} ${pathname} 返回 ${String(response.status)}：${JSON.stringify(body).slice(0, 500)}`,
      );
    return { status: response.status, body };
  }

  return {
    address: base,

    get: (pathname, query) => json("GET", pathname, { query }),

    post: (pathname, body) => json("POST", pathname, { body }),

    async bytes(pathname) {
      const response = await fetch(url(pathname));
      return {
        status: response.status,
        mediaType: response.headers.get("content-type"),
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },

    async readiness() {
      const reply = await json("GET", "/ready");
      const body = object(reply.body);
      return {
        status: reply.status,
        ready: body?.["ok"] === true,
      };
    },

    async libraries() {
      const reply = await json("GET", "/settings");
      const settings = object(reply.body);
      if (settings === undefined) throw new Error("产品设置快照不是对象");
      return array(settings["libraries"]).map((entry) => {
        const library = object(entry);
        if (library === undefined) throw new Error("资产库条目不是对象");
        return {
          id: requiredText(library, "id", "资产库条目"),
          displayName: text(library["displayName"]) ?? "",
          configVersion: number(library["configVersion"]) ?? 0,
          directories: array(library["directories"]).filter(
            (item): item is string => typeof item === "string",
          ),
          observedRootIds: array(library["directoryViews"])
            .map((view) => object(view)?.["observedRootId"])
            .filter((value): value is string => typeof value === "string"),
        };
      });
    },

    async saveLibrary(input) {
      const reply = await json("POST", "/settings/libraries", {
        body: {
          action: "save",
          displayName: input.displayName,
          directories: input.directories,
          recognitionProfileIds: input.recognitionProfileIds,
          sourceIdentities: input.sourceIdentities,
        },
      });
      expectAccepted(reply, "资产库登记");
      return requiredText(object(reply.body) ?? {}, "id", "资产库登记结果");
    },

    async startRefresh(assetLibraryId) {
      const reply = await json("POST", "/refresh", {
        body: { assetLibraryId },
      });
      expectAccepted(reply, "目录刷新");
      return requiredText(object(reply.body) ?? {}, "id", "刷新执行结果");
    },

    async awaitExecution(executionId, timeoutMs, pollMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const reply = await json("GET", `/executions/${executionId}`);
        const execution = object(reply.body);
        if (execution === undefined)
          throw new Error(`执行 ${executionId} 的记录不是对象`);
        const status = requiredText(execution, "status", "执行记录");
        if (
          status === "completed" ||
          status === "failed" ||
          status === "cancelled"
        )
          return {
            id: executionId,
            status,
            outcome: text(execution["outcome"]),
            reply: reply.body,
          };
        if (Date.now() >= deadline)
          throw new Error(
            `执行 ${executionId} 在 ${String(timeoutMs)} 毫秒内未进入终态（当前 ${status}）`,
          );
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },

    async inspectSubject(subjectId) {
      const reply = await json("GET", `/correction-subjects/${subjectId}`);
      const subject = object(reply.body);
      if (subject === undefined)
        throw new Error(`内容 ${subjectId} 的更正视图不是对象`);
      return subject;
    },

    async coverCandidates(subjectId) {
      const reply = await json("GET", `/cover-choice/${subjectId}`);
      const choice = object(reply.body);
      if (choice === undefined)
        throw new Error(`内容 ${subjectId} 的封面选择视图不是对象`);
      return choice;
    },

    async chooseCover(input) {
      const reply = await json("POST", "/cover-decisions", {
        body: {
          entityId: input.entityId,
          initiatedBy: "开发预览",
          candidateReference: input.candidateReference,
        },
      });
      expectAccepted(reply, "封面决定");
      return {
        previewId: requiredText(
          object(reply.body) ?? {},
          "previewId",
          "封面决定预演",
        ),
      };
    },

    async applyPreview(previewId, actorId) {
      const reply = await json("POST", "/preview", {
        body: { action: "apply", actorId, previewId },
      });
      expectAccepted(reply, "封面决定应用");
      return reply.body;
    },
  };
}

export type IntakeOutcome = {
  readonly assetLibraryId: string;
  readonly observedRootIds: readonly string[];
  readonly executionId: string;
  readonly executionStatus: string;
  readonly executionOutcome: string | undefined;
  readonly assetIds: readonly string[];
  readonly reused: boolean;
};

/**
 * 就绪之后的正式目录接入：登记普通目录→刷新→读取工作流终态→读取准入结果。
 * 同一目录已在库内时只复用并复核，不重复制造接入；接入结论与服务就绪结论分别返回。
 */
export async function intakeDirectories(
  client: ProductClient,
  input: {
    readonly displayName: string;
    readonly directories: readonly string[];
    readonly recognitionProfileIds: readonly string[];
    readonly sourceIdentities: readonly string[];
    readonly workflowTimeoutMs: number;
    readonly actorHint?: string;
  },
): Promise<IntakeOutcome> {
  const libraries = await client.libraries();
  const wanted = new Set(input.directories);
  const existing = libraries.find((library) =>
    library.directories.some((directory) => wanted.has(directory)),
  );
  const assetLibraryId =
    existing?.id ??
    (await client.saveLibrary({
      displayName: input.displayName,
      directories: input.directories,
      recognitionProfileIds: input.recognitionProfileIds,
      sourceIdentities: input.sourceIdentities,
    }));
  const executionId = await client.startRefresh(assetLibraryId);
  const execution = await client.awaitExecution(
    executionId,
    input.workflowTimeoutMs,
  );
  if (execution.status !== "completed")
    throw new Error(
      `目录接入工作流未成功完成：执行 ${execution.id} 状态 ${execution.status}，结论 ${execution.outcome ?? "无"}`,
    );
  const refreshed = (await client.libraries()).find(
    (library) => library.id === assetLibraryId,
  );
  if (refreshed === undefined)
    throw new Error("刷新后找不到本预览登记的资产库");
  const assetIds: string[] = [];
  for (const rootId of refreshed.observedRootIds) {
    const reply = await client.get("/intake", { rootId });
    for (const file of array(object(reply.body)?.["files"])) {
      for (const assetId of array(object(file)?.["assetIds"]))
        if (typeof assetId === "string") assetIds.push(assetId);
    }
  }
  return {
    assetLibraryId,
    observedRootIds: refreshed.observedRootIds,
    executionId: execution.id,
    executionStatus: execution.status,
    executionOutcome: execution.outcome,
    assetIds,
    reused: existing !== undefined,
  };
}

/**
 * 普通目录的内容指纹：按相对路径排序后串接每个常规文件的摘要。
 * 只读遍历，绝不写入或修改素材；用于证明预览运行与重建都没有改动输入。
 */
export async function digestDirectory(directory: string): Promise<string> {
  const entries = await collectFiles(directory, "");
  entries.sort((left, right) => (left.relative < right.relative ? -1 : 1));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.relative);
    hash.update("\0");
    hash.update(entry.digest);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function collectFiles(
  directory: string,
  prefix: string,
): Promise<{ readonly relative: string; readonly digest: string }[]> {
  const found: { readonly relative: string; readonly digest: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative =
      prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      found.push(...(await collectFiles(absolute, relative)));
    else if (entry.isFile())
      found.push({
        relative,
        digest: createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      });
  }
  return found;
}
