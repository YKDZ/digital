import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ControlledRequestRefusal,
  ControlledSourceIoStartupProblem,
  createControlledSessionTransport,
  fanboxPrivateContextIdentity,
  loadControlledSourceIo,
  resolveSourceIoFromEnvironment,
  sourceIoConfigVariable,
  sourceIoIdentityVariable,
  sourceIoModeVariable,
  type ControlledPrivateBrowserContext,
  type ControlledRequestEntryInput,
  type ControlledSessionEndpoint,
  type ControlledSessionEntryInput,
  type ControlledSessionGet,
  type ControlledSessionTransport,
} from "../src/source-io.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const syntheticContext: ControlledPrivateBrowserContext = {
  format: "fanbox-browser-request-context/2",
  userAgent: "合成受控用户代理/1.0",
  cookies: [
    {
      name: "FANBOXSESSID",
      value: "合成会话值-无真实登录能力",
      domain: ".fanbox.cc",
      path: "/",
    },
  ],
};

const substitutedContext: ControlledPrivateBrowserContext = {
  ...syntheticContext,
  cookies: [{ ...syntheticContext.cookies[0]!, value: "替换后的合成值" }],
};

const coverEntry: ControlledRequestEntryInput = {
  id: "fanbox-cover-image",
  url: "https://downloads.fanbox.cc/images/post/7225781/controlled-cover.png",
  method: "GET",
  status: 200,
  mediaType: "image/png",
  responseFile: "responses/cover.png",
};

/** 会话条目的响应文件与正文按端点键固定，便于逐份清单复用同一批字节。 */
const declaredResponses: Readonly<Record<string, string>> = {
  "fanbox-login-status": '{"body":0}',
  "fanbox-verify-summaries": '{"body":{"posts":[{"id":"7225781"}]}}',
  "fanbox-collect-summaries": '{"body":{"posts":[{"id":"7225781"}]}}',
  "fanbox-post-detail-connected": '{"body":{"post":{"id":"7225781"}}}',
  "fanbox-post-detail-public": '{"body":{"post":{"id":"7225781"}}}',
};

function sessionEntry(
  endpoint: ControlledSessionEndpoint,
  privateContextIdentity = fanboxPrivateContextIdentity(syntheticContext),
): ControlledSessionEntryInput {
  const id =
    endpoint.kind === "login-status"
      ? "fanbox-login-status"
      : endpoint.kind === "creator-summaries"
        ? `fanbox-${endpoint.limit === 1 ? "verify" : "collect"}-summaries`
        : `fanbox-post-detail-${endpoint.access}`;
  return {
    id,
    creatorId:
      endpoint.kind === "creator-summaries" ? endpoint.creatorId : "customudon",
    endpoint: endpoint.kind,
    ...(endpoint.kind === "creator-summaries" ? { limit: endpoint.limit } : {}),
    ...(endpoint.kind === "post-detail"
      ? { postId: endpoint.postId, access: endpoint.access }
      : {}),
    privateContextIdentity,
    status: 200,
    mediaType: "application/json",
    responseFile: `responses/${id}.json`,
  };
}

const successEntries: readonly ControlledSessionEntryInput[] = [
  sessionEntry({ kind: "login-status" }),
  sessionEntry({
    kind: "creator-summaries",
    creatorId: "customudon",
    limit: 1,
  }),
  sessionEntry({
    kind: "creator-summaries",
    creatorId: "customudon",
    limit: 300,
  }),
  sessionEntry({
    kind: "post-detail",
    postId: "7225781",
    access: "connected",
  }),
];

/** 写出清单与其引用的响应字节；每次都在独立临时目录里，便于制造字节篡改。 */
async function writeManifest(input: {
  readonly ordinary?: readonly ControlledRequestEntryInput[];
  readonly session?: readonly unknown[];
}): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "t09-controlled-session-"),
  );
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "responses"), { recursive: true });
  await writeFile(path.join(directory, "responses/cover.png"), "封面字节");
  for (const value of Array.isArray(input.session) ? input.session : []) {
    const entry = value as ControlledSessionEntryInput;
    if (typeof entry?.responseFile !== "string") continue;
    await writeFile(
      path.join(directory, entry.responseFile),
      declaredResponses[entry.id] ?? '{"body":0}',
    );
  }
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      formatVersion: 1,
      ordinary: input.ordinary ?? [],
      ...(input.session === undefined ? {} : { session: input.session }),
    }),
  );
  return manifestPath;
}

async function loadedSuccessTransport(): Promise<ControlledSessionTransport> {
  const loaded = await loadControlledSourceIo({
    manifestPath: await writeManifest({
      ordinary: [coverEntry],
      session: successEntries,
    }),
  });
  if (loaded.sessionTransport === undefined)
    throw new Error("完整成功清单必须给出会话 transport");
  return loaded.sessionTransport;
}

function transaction(
  transport: ControlledSessionTransport,
  input: {
    readonly creatorId?: string;
    readonly privateContext?: ControlledPrivateBrowserContext;
    readonly endpoint: ControlledSessionEndpoint;
  },
): Promise<unknown> {
  return transport.transact({
    creatorId: input.creatorId ?? "customudon",
    privateContext: input.privateContext ?? syntheticContext,
    use: async (get) => await get(input.endpoint),
  });
}

describe("受控 FANBOX 会话清单的加载", () => {
  it("会话条目与普通条目一起进入清单身份，并共用同一标识集合", async () => {
    const manifestPath = await writeManifest({
      ordinary: [coverEntry],
      session: successEntries,
    });
    const loaded = await loadControlledSourceIo({ manifestPath });
    expect(loaded.entryIds).toEqual([
      "fanbox-cover-image",
      "fanbox-login-status",
      "fanbox-verify-summaries",
      "fanbox-collect-summaries",
      "fanbox-post-detail-connected",
    ]);
    expect(loaded.sessionTransport).toBeDefined();

    const reordered = await loadControlledSourceIo({
      manifestPath: await writeManifest({
        ordinary: [coverEntry],
        session: [...successEntries].toReversed(),
      }),
    });
    expect(reordered.contentIdentity).toBe(loaded.contentIdentity);
  });

  it("会话响应字节被内容身份覆盖，改写后同一身份校验失败", async () => {
    const manifestPath = await writeManifest({ session: successEntries });
    const loaded = await loadControlledSourceIo({ manifestPath });
    await writeFile(
      path.join(
        path.dirname(manifestPath),
        "responses/fanbox-post-detail-connected.json",
      ),
      '{"body":{"post":{"id":"被篡改"}}}',
    );
    await expect(
      loadControlledSourceIo({
        manifestPath,
        expectedContentIdentity: loaded.contentIdentity,
      }),
    ).rejects.toBeInstanceOf(ControlledSourceIoStartupProblem);
  });

  it("只声明普通条目的旧清单仍然加载，但会话事务在触达来源之前被拒", async () => {
    const manifestPath = await writeManifest({ ordinary: [coverEntry] });
    const loaded = await loadControlledSourceIo({ manifestPath });
    expect(loaded.sessionTransport).toBeUndefined();
    await expect(loaded.request(coverEntry.url)).resolves.toMatchObject({
      ok: true,
    });

    const resolved = await resolveSourceIoFromEnvironment({
      [sourceIoModeVariable]: "controlled",
      [sourceIoConfigVariable]: manifestPath,
      [sourceIoIdentityVariable]: loaded.contentIdentity,
    });
    if (resolved.mode === "real") throw new Error("受控选择不得落回真实装配");
    const refusal = (await resolved.sessionTransport
      .transact({
        creatorId: "customudon",
        privateContext: syntheticContext,
        use: async (get) => await get({ kind: "login-status" }),
      })
      .catch((error: unknown) => error)) as ControlledRequestRefusal;
    expect(refusal).toBeInstanceOf(ControlledRequestRefusal);
    expect(refusal.message).toContain("受控装配未声明任何会话条目");
  });

  it("空集合、无效端点参数、越界响应文件与重复键都在读取阶段失败", async () => {
    const documents: readonly Record<string, unknown>[] = [
      { ordinary: [], session: [] },
      { ordinary: [], session: { id: "fanbox-login-status" } },
      { ordinary: [], session: [coverEntry] },
      { ordinary: [], session: [{ ...successEntries[0]!, extra: 1 }] },
      {
        ordinary: [],
        session: [{ ...successEntries[0]!, endpoint: "post-list" }],
      },
      {
        ordinary: [],
        session: [{ ...successEntries[0]!, creatorId: "含 空 格" }],
      },
      {
        ordinary: [],
        session: [
          { ...successEntries[0]!, privateContextIdentity: "sha256:不足" },
        ],
      },
      {
        ordinary: [],
        session: [{ ...successEntries[1]!, limit: 50 }],
      },
      { ordinary: [], session: [{ ...successEntries[2]!, limit: undefined }] },
      { ordinary: [], session: [{ ...successEntries[0]!, postId: "7225781" }] },
      {
        ordinary: [],
        session: [{ ...successEntries[3]!, access: "anonymous" }],
      },
      {
        ordinary: [],
        session: [{ ...successEntries[3]!, limit: 1 }],
      },
      {
        ordinary: [],
        session: [{ ...successEntries[3]!, postId: "不是数字" }],
      },
      {
        ordinary: [],
        session: [{ ...successEntries[0]!, responseFile: "../outside.json" }],
      },
      {
        // 同一封闭端点键声明两次；换标识也不能重复声明同一端点。
        ordinary: [],
        session: [
          successEntries[0]!,
          successEntries[1]!,
          { ...successEntries[1]!, id: "fanbox-summaries-repeated" },
        ],
      },
      {
        ordinary: [coverEntry],
        session: [{ ...successEntries[0]!, id: coverEntry.id }],
      },
    ];
    for (const rest of documents) {
      await expect(
        loadControlledSourceIo({
          manifestPath: await writeManifest({
            ordinary: (rest.ordinary ??
              []) as readonly ControlledRequestEntryInput[],
            session: rest.session as readonly unknown[],
          }),
        }),
      ).rejects.toBeInstanceOf(ControlledSourceIoStartupProblem);
    }
  });

  it("引用无法读取的响应文件在读取阶段失败，而不是将来自未知请求", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "t09-controlled-session-"),
    );
    temporaryDirectories.push(directory);
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        formatVersion: 1,
        ordinary: [],
        session: successEntries,
      }),
    );
    await expect(
      loadControlledSourceIo({ manifestPath }),
    ).rejects.toBeInstanceOf(ControlledSourceIoStartupProblem);
  });
});

describe("受控 FANBOX 会话 transport 的封闭端点匹配", () => {
  it("按端点键给出声明的状态、媒体类型与可重复读取的字节副本", async () => {
    const transport = await loadedSuccessTransport();
    const seen: string[] = [];
    const outcome = await transport.transact({
      creatorId: "customudon",
      privateContext: syntheticContext,
      use: async (get) => {
        const login = await get({ kind: "login-status" });
        const verify = await get({
          kind: "creator-summaries",
          creatorId: "customudon",
          limit: 1,
        });
        const detail = await get({
          kind: "post-detail",
          postId: "7225781",
          access: "connected",
        });
        if (
          login.kind !== "response" ||
          verify.kind !== "response" ||
          detail.kind !== "response"
        )
          throw new Error("受控会话应给出完整响应");
        seen.push(
          `${String(login.status)}/${login.mediaType ?? ""}`,
          `${String(verify.status)}/${verify.mediaType ?? ""}`,
        );
        login.body[0] = 0;
        const again = await get({ kind: "login-status" });
        return {
          again:
            again.kind === "response"
              ? new TextDecoder().decode(again.body)
              : "",
          detail: new TextDecoder().decode(detail.body),
        };
      },
    });
    expect(seen).toEqual(["200/application/json", "200/application/json"]);
    // 响应条目不共享字节，也不依赖到达顺序。
    expect(outcome.again).toBe('{"body":0}');
    expect(outcome.detail).toContain("7225781");
  });

  it("未知帖子、公开与已连接混用、未声明 limit 与创作者范围不符都被点名拒绝", async () => {
    const transport = await loadedSuccessTransport();
    const requestKeys: string[] = [];
    for (const endpoint of [
      { kind: "post-detail", postId: "9135862", access: "connected" },
      { kind: "post-detail", postId: "7225781", access: "public" },
    ] as const) {
      const error = (await transaction(transport, {
        endpoint,
      }).catch((caught: unknown) => caught)) as ControlledRequestRefusal;
      expect(error).toBeInstanceOf(ControlledRequestRefusal);
      expect(error.message).toContain("fanbox-session");
      requestKeys.push(error.requestKey);
    }
    expect(requestKeys).toEqual([
      "post-detail/customudon/9135862/access=connected",
      "post-detail/customudon/7225781/access=public",
    ]);

    const verifyOnly = await loadControlledSourceIo({
      manifestPath: await writeManifest({
        session: [successEntries[0]!, successEntries[1]!],
      }),
    });
    await expect(
      transaction(verifyOnly.sessionTransport!, {
        endpoint: {
          kind: "creator-summaries",
          creatorId: "customudon",
          limit: 300,
        },
      }),
    ).rejects.toThrow("creator-summaries/customudon/limit=300");

    // 事务创作者范围与端点声明不一致时，先在范围边界被拒。
    await expect(
      transaction(transport, {
        creatorId: "另一个创作者",
        endpoint: {
          kind: "creator-summaries",
          creatorId: "customudon",
          limit: 1,
        },
      }),
    ).rejects.toThrow("fanbox-session/creator-scope");
    const foreign = (await transaction(transport, {
      endpoint: {
        kind: "creator-summaries",
        creatorId: "另一个创作者",
        limit: 1,
      },
    }).catch((caught: unknown) => caught)) as ControlledRequestRefusal;
    expect(foreign.requestKey).toBe("creator-summaries/另一个创作者/limit=1");
  });

  it("只声明公开详情的清单服务公开键，但不把已连接请求接到它上面", async () => {
    const publicOnly = await loadControlledSourceIo({
      manifestPath: await writeManifest({
        session: [
          successEntries[0]!,
          sessionEntry({
            kind: "post-detail",
            postId: "7225781",
            access: "public",
          }),
        ],
      }),
    });
    await expect(
      transaction(publicOnly.sessionTransport!, {
        endpoint: { kind: "post-detail", postId: "7225781", access: "public" },
      }),
    ).resolves.toMatchObject({ kind: "response", status: 200 });
    const error = (await transaction(publicOnly.sessionTransport!, {
      endpoint: {
        kind: "post-detail",
        postId: "7225781",
        access: "connected",
      },
    }).catch((caught: unknown) => caught)) as ControlledRequestRefusal;
    expect(error).toBeInstanceOf(ControlledRequestRefusal);
    expect(error.requestKey).toBe(
      "post-detail/customudon/7225781/access=connected",
    );
  });

  it("详情条目声明的创作者也属于会话请求键：connected 与 public 都不能跨范围", async () => {
    // 只把详情条目的声明创作者换成另一个范围；login、摘要、上下文与正文照旧。
    const connectedMismatch = await loadControlledSourceIo({
      manifestPath: await writeManifest({
        session: [
          successEntries[0]!,
          successEntries[1]!,
          { ...successEntries[3]!, creatorId: "customudon-other" },
        ],
      }),
    });
    const given: string[] = [];
    const connected = (await connectedMismatch
      .sessionTransport!.transact({
        creatorId: "customudon",
        privateContext: syntheticContext,
        use: async (get) => {
          const login = await get({ kind: "login-status" });
          const verify = await get({
            kind: "creator-summaries",
            creatorId: "customudon",
            limit: 1,
          });
          given.push(login.kind, verify.kind);
          return await get({
            kind: "post-detail",
            postId: "7225781",
            access: "connected",
          });
        },
      })
      .catch((caught: unknown) => caught)) as ControlledRequestRefusal;
    // 前两步照常成功，错范围详情不给任何响应字节。
    expect(given).toEqual(["response", "response"]);
    expect(connected).toBeInstanceOf(ControlledRequestRefusal);
    expect(connected.requestKey).toBe(
      "post-detail/customudon/7225781/access=connected",
    );

    const publicMismatch = await loadControlledSourceIo({
      manifestPath: await writeManifest({
        session: [
          successEntries[0]!,
          sessionEntry({
            kind: "post-detail",
            postId: "7225781",
            access: "public",
          }),
        ].map((entry) =>
          entry.endpoint === "post-detail"
            ? { ...entry, creatorId: "customudon-other" }
            : entry,
        ),
      }),
    });
    await expect(
      transaction(publicMismatch.sessionTransport!, {
        endpoint: { kind: "post-detail", postId: "7225781", access: "public" },
      }),
    ).rejects.toThrow("post-detail/customudon/7225781/access=public");
    // 同一清单声明回事务创作者后，公开详情仍然正常给出。
    const declared = await loadControlledSourceIo({
      manifestPath: await writeManifest({
        session: [
          successEntries[0]!,
          sessionEntry({
            kind: "post-detail",
            postId: "7225781",
            access: "public",
          }),
        ],
      }),
    });
    await expect(
      transaction(declared.sessionTransport!, {
        endpoint: { kind: "post-detail", postId: "7225781", access: "public" },
      }),
    ).resolves.toMatchObject({ kind: "response", status: 200 });
  });

  it("错误合成上下文不给出任何响应字节，诊断也不含凭据值", async () => {
    const transport = await loadedSuccessTransport();
    const error = (await transaction(transport, {
      privateContext: substitutedContext,
      endpoint: { kind: "login-status" },
    }).catch((caught: unknown) => caught)) as ControlledRequestRefusal;
    expect(error).toBeInstanceOf(ControlledRequestRefusal);
    expect(error.message).toContain("fanbox-session/context");
    expect(error.message).toContain("login-status/customudon");
    expect(error.message).not.toContain("FANBOXSESSID");
    expect(error.message).not.toContain("合成会话值");
    expect(error.message).not.toContain("替换后的合成值");
    expect(fanboxPrivateContextIdentity(syntheticContext)).not.toEqual(
      fanboxPrivateContextIdentity(substitutedContext),
    );
  });

  it("close 幂等，关闭后的在途取用与新事务都被拒", async () => {
    const transport = await loadedSuccessTransport();
    let lingeringGet: ControlledSessionGet | undefined;
    await expect(
      transport.transact({
        creatorId: "customudon",
        privateContext: syntheticContext,
        use: async (get) => {
          lingeringGet = get;
          return await get({ kind: "login-status" });
        },
      }),
    ).resolves.toMatchObject({ kind: "response", status: 200 });
    await transport.close();
    await transport.close();
    await expect(lingeringGet!({ kind: "login-status" })).rejects.toThrow(
      "fanbox-session/closed",
    );
    await expect(
      transaction(transport, { endpoint: { kind: "login-status" } }),
    ).rejects.toThrow("fanbox-session/closed");
  });

  it("手工装配的 transport 只服务已声明条目，普通请求边界不被代替", async () => {
    const transport = createControlledSessionTransport({
      responses: [{ entry: successEntries[0]!, bytes: new Uint8Array([123]) }],
    });
    await expect(
      transaction(transport, {
        endpoint: {
          kind: "creator-summaries",
          creatorId: "customudon",
          limit: 1,
        },
      }),
    ).rejects.toBeInstanceOf(ControlledRequestRefusal);
    await expect(
      transaction(transport, { endpoint: { kind: "login-status" } }),
    ).resolves.toMatchObject({ kind: "response" });
    await transport.close();
  });

  it("装配同一端点键的两份条目在构造阶段失败", () => {
    expect(() =>
      createControlledSessionTransport({
        responses: [
          { entry: successEntries[0]!, bytes: new Uint8Array([1]) },
          { entry: successEntries[0]!, bytes: new Uint8Array([2]) },
        ],
      }),
    ).toThrow(ControlledSourceIoStartupProblem);
  });
});
