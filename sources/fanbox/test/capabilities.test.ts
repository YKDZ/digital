import {
  knownSourceAssociationEvidenceCapability,
  type SourceCollectionExecutionContext,
  type SourceCollector,
} from "@digital/application";
import { describe, expect, it, vi } from "vitest";

import {
  FanboxSessionTransportFault,
  fanboxEndpointAddress,
} from "../src/browser-session.ts";
import {
  FanboxArtifactAcquirer,
  FanboxDateDirectoryInterpreter,
  FanboxExactRecognizer,
  FanboxSourceInterpreter,
  createFanboxProductAssembly,
  decodeFanboxCollectionFailureCode,
  fanboxCreatorIdFromEvidence,
  fanboxOfficialCollectionCapability,
} from "../src/index.ts";
import * as fanboxPublic from "../src/public.ts";
import { createScriptedFanboxProductAssembly } from "../src/testing.ts";

describe("FANBOX 产品浏览器连接", () => {
  it("package root 不公开 collector 或独立验证入口", () => {
    expect(fanboxPublic).not.toHaveProperty("FanboxCollector");
    expect(fanboxPublic).not.toHaveProperty("validatedFanboxBrowserCredential");
    expect(fanboxPublic).not.toHaveProperty("verifyFanboxStoredCredential");
  });

  it("生产连接验证不经 Node fetch 发出端点请求", async () => {
    const nodeFetch = vi.fn(async () => {
      throw new Error("Node transport must be unreachable");
    });
    vi.stubGlobal("fetch", nodeFetch);
    const assembly = createFanboxProductAssembly();
    try {
      await expect(
        assembly.validatedBrowserCredential({
          creatorId: "customudon",
          browserCredential: {
            userAgent: "test-browser/1",
            cookies: [
              {
                name: "FANBOXSESSID",
                value: "test-private-session",
                domain: ".fanbox.cc",
                path: "/",
              },
            ],
          },
        }),
      ).rejects.toThrow("FANBOX 来源连接验证失败");
      expect(nodeFetch).not.toHaveBeenCalled();
    } finally {
      await assembly.close().catch(() => undefined);
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("把浏览器导出的 cookie 属性规范化为唯一 V2 私密串", async () => {
    const assembly = createScriptedFanboxProductAssembly(
      scriptedClosedGet(async (address) =>
        jsonResponse(
          address.includes("user.countUnreadMessages")
            ? { body: 0 }
            : address.includes("post.listCreator")
              ? {
                  body: {
                    posts: [
                      {
                        id: "9135862",
                        creatorId: "customudon",
                        title: "测试帖子",
                        publishedDatetime: "2025-01-01T00:11:17+09:00",
                      },
                    ],
                  },
                }
              : {
                  body: {
                    post: {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "测试帖子",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  },
                },
        ),
      ),
    );
    const privateConfiguration = await assembly.validatedBrowserCredential({
      creatorId: "customudon",
      browserCredential: {
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: "test-private-session",
            domain: ".fanbox.cc",
            path: "/creator",
            secure: true,
            httpOnly: true,
            sameSite: "no_restriction",
            expirationDate: 2_000_000_000,
            ignored: "not persisted",
          },
        ],
      },
    });

    expect(JSON.parse(privateConfiguration)).toEqual({
      format: "fanbox-browser-request-context/2",
      userAgent: "test-browser/1",
      cookies: [
        {
          name: "FANBOXSESSID",
          value: "test-private-session",
          domain: ".fanbox.cc",
          path: "/creator",
          secure: true,
          httpOnly: true,
          sameSite: "None",
          expires: 2_000_000_000,
        },
      ],
    });
  });

  it("硬拒绝 candidate-10 V1 私密串且不读取旧 cookieHeader", async () => {
    const request = vi.fn();
    const assembly = createScriptedFanboxProductAssembly(request);
    await expect(
      assembly.verifyStoredCredential({
        creatorId: "customudon",
        privateConfiguration: JSON.stringify({
          format: "fanbox-browser-request-context/1",
          cookieHeader: "FANBOXSESSID=test-private-session",
          userAgent: "test-browser/1",
        }),
      }),
    ).rejects.toThrow("FANBOX 来源连接验证失败");
    expect(request).not.toHaveBeenCalled();
  });
});

const snapshot = (root: string, files = ["content.bin"]) => ({
  id: "snapshot",
  root,
  complete: true,
  excluded: [],
  files: files.map((relativePath) => ({
    relativePath,
    size: 1,
    modifiedAt: "2026-07-29T00:00:00.000Z",
  })),
  observedAt: "2026-07-29T00:00:00.000Z",
});

/** 目录解释器交出工作项计划；旧调用只需要计划内的规范根证据。 */
function directoryEvidence(root: string, files?: string[]) {
  const plan = new FanboxDateDirectoryInterpreter().interpret(
    snapshot(root, files),
  );
  if (!("workItems" in plan))
    throw new Error("FANBOX 目录约定没有形成工作项计划");
  return plan.workItems.flatMap((workItem) => workItem.evidence);
}

function testPrivateConfiguration(
  cookieHeader: string,
  userAgent = "test-browser/1",
): string {
  return JSON.stringify({
    format: "fanbox-browser-request-context/2",
    userAgent,
    cookies: cookieHeader.split(/;\s*/u).map((pair) => {
      const separator = pair.indexOf("=");
      return {
        name: pair.slice(0, separator),
        value: pair.slice(separator + 1),
        domain: ".fanbox.cc",
        path: "/",
      };
    }),
  });
}

describe("FANBOX creator date convention", () => {
  it("keeps channel and publication-date grammar inside the integration", () => {
    const interpreter = new FanboxDateDirectoryInterpreter();

    expect(
      interpreter.interpret(snapshot("/library/2024-03-07")),
    ).toMatchObject({
      workItems: [
        {
          evidence: [
            {
              kind: "directory-convention",
              sourceIdentity: "fanbox",
              producer: interpreter.capability,
            },
          ],
        },
      ],
    });
    expect(
      interpreter.interpret(snapshot("/library/Custom Udon/24.03.07 ひみつ")),
    ).toEqual([]);
    expect(
      interpreter.interpret(snapshot("/library/24.13.07 invalid")),
    ).toEqual([]);
  });
});

describe("FANBOX official collection", () => {
  it.each([
    ["http:creator-summaries:400", 400, "4xx"],
    ["http:post-detail:599", 599, "5xx"],
  ] as const)(
    "decodes its bounded HTTP failure code %s",
    (code, status, statusClass) => {
      expect(
        decodeFanboxCollectionFailureCode({
          capability: fanboxOfficialCollectionCapability,
          code,
        }),
      ).toEqual({ category: "http-status", status, class: statusClass });
    },
  );

  it.each([
    "http:post-detail:302",
    "http:post-detail:600",
    "http:post-detail:403:extra",
  ])("rejects the malformed or out-of-range HTTP failure code %s", (code) => {
    expect(
      decodeFanboxCollectionFailureCode({
        capability: fanboxOfficialCollectionCapability,
        code,
      }),
    ).toBeUndefined();
  });

  it("rejects a failure code attributed to an adjacent capability coordinate", () => {
    expect(
      decodeFanboxCollectionFailureCode({
        capability: {
          ...fanboxOfficialCollectionCapability,
          implementationVersion: "adjacent",
        },
        code: "http:post-detail:403",
      }),
    ).toBeUndefined();
  });

  it("exposes a capability-owned secret-free transport code", async () => {
    const secret = "FANBOXSESSID=do-not-copy";
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(secret),
      request: async () => {
        throw new Error(`network failed with ${secret}`);
      },
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.failures[0]).toMatchObject({
      failureCode: "transport-failure",
    });
    expect(
      decodeFanboxCollectionFailureCode({
        capability: result.failures[0].capability,
        code: result.failures[0].failureCode!,
      }),
    ).toEqual({ category: "transport-failure" });
    expect(JSON.stringify(result.failures)).not.toContain("do-not-copy");
  });

  it("accepts only Application's exact known-association provenance for an existing FANBOX address", () => {
    const knownAddress = "https://www.fanbox.cc/@customudon/posts/9135862";
    const spoofed = {
      kind: "source-association",
      sourceIdentity: "fanbox",
      sourceAddress: knownAddress,
      explanation: "spoofed producer",
      producer: {
        ...knownSourceAssociationEvidenceCapability,
        kind: "directory-interpreter",
      },
    };
    const known = {
      ...spoofed,
      producer: knownSourceAssociationEvidenceCapability,
    };
    const spoofedDirectory = {
      kind: "directory-convention",
      sourceIdentity: "fanbox",
      sourceAddress: "fanbox-directory:customudon:2025-01-01",
      explanation: "spoofed directory producer",
      producer: {
        capabilityId: "fanbox.creator-date-directory",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    };
    const directoryCoordinateWithWrongEvidenceKind = {
      ...spoofedDirectory,
      kind: "source-association",
      producer: new FanboxDateDirectoryInterpreter().capability,
    };

    expect(fanboxCreatorIdFromEvidence(spoofed)).toBeUndefined();
    expect(fanboxCreatorIdFromEvidence(spoofedDirectory)).toBeUndefined();
    expect(
      fanboxCreatorIdFromEvidence(directoryCoordinateWithWrongEvidenceKind),
    ).toBeUndefined();
    expect(fanboxCreatorIdFromEvidence(known)).toBe("customudon");
  });

  it("retains one record for each real response without splitting a detail body and attachment listing", async () => {
    const requested: string[] = [];
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration("FANBOXSESSID=top-secret"),
      request: async (address) => {
        requested.push(address);
        const body = address.includes("post.listCreator")
          ? {
              body: {
                posts: [
                  {
                    id: "9135862",
                    creatorId: "customudon",
                    publishedDatetime: "2025-01-01T00:11:17+09:00",
                    title: "年始の挨拶(おまけ動画付き)",
                  },
                ],
              },
            }
          : {
              body: {
                post: {
                  id: "9135862",
                  creatorId: "customudon",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  title: "年始の挨拶(おまけ動画付き)",
                  type: "article",
                  coverImageUrl:
                    "https://downloads.fanbox.cc/images/post/cover.jpg",
                  body: {
                    blocks: [
                      { type: "p", text: "新年" },
                      { type: "file", fileId: "bonus" },
                    ],
                    fileMap: {
                      bonus: {
                        id: "bonus",
                        name: "bonus.mp4",
                        url: "https://downloads.fanbox.cc/files/post/bonus.mp4",
                      },
                    },
                  },
                },
              },
            };
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          arrayBuffer: async () =>
            new TextEncoder().encode(JSON.stringify(body)).buffer,
        };
      },
    });

    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];
    const result = await collector.collect(evidence);

    expect(result.failures).toEqual([]);
    expect(result.records.map((record) => record.coverage.id)).toEqual([
      "fanbox.creator-post-summaries",
      "fanbox.post-detail",
    ]);
    expect(result.records).toHaveLength(2);
    expect(JSON.parse(result.records[1].body)).toMatchObject({
      body: {
        post: {
          body: {
            blocks: expect.arrayContaining([
              expect.objectContaining({ type: "p", text: "新年" }),
              expect.objectContaining({ type: "file", fileId: "bonus" }),
            ]),
            fileMap: {
              bonus: expect.objectContaining({ name: "bonus.mp4" }),
            },
          },
        },
      },
    });
    expect(result.records.map((record) => record.nativeAddress)).toEqual([
      "https://www.fanbox.cc/@customudon/posts/9135862",
      "https://www.fanbox.cc/@customudon/posts/9135862",
    ]);
    expect(
      result.records.every((record) => !record.body.includes("top-secret")),
    ).toBe(true);
    expect(requested).toHaveLength(2);
  });

  it("uses a browser credential only when its frozen connection reference matches the creator scope", async () => {
    const privateSession = "fanbox-frozen-private-session";
    const requestedCookies: string[] = [];
    const collector = scriptedCollector({
      creatorIds: () => ["customudon"],
      privateConfigurationForExecution: ({ creatorId, context }) =>
        creatorId === "customudon" &&
        context?.configurationReferences.includes(
          "source-connection/fanbox/customudon@1",
        ) === true
          ? testPrivateConfiguration(`FANBOXSESSID=${privateSession}`)
          : undefined,
      request: async (address, init) => {
        requestedCookies.push(init.headers.Cookie ?? "");
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          arrayBuffer: async () =>
            new TextEncoder().encode(
              JSON.stringify(
                address.includes("post.listCreator")
                  ? {
                      body: {
                        posts: [
                          {
                            id: "9135862",
                            creatorId: "customudon",
                            title: "年始の挨拶",
                            publishedDatetime: "2025-01-01T00:11:17+09:00",
                          },
                        ],
                      },
                    }
                  : {
                      body: {
                        post: {
                          id: "9135862",
                          creatorId: "customudon",
                          title: "年始の挨拶",
                          publishedDatetime: "2025-01-01T00:11:17+09:00",
                          type: "text",
                          body: { text: "完整正文" },
                        },
                      },
                    },
              ),
            ).buffer,
        };
      },
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    await expect(collector.collect(evidence)).resolves.toMatchObject({
      records: [],
      failures: [
        expect.objectContaining({
          failureCode: "connection-unavailable",
          reason: expect.stringContaining("私有来源连接"),
        }),
      ],
    });
    await expect(
      collector.collect(evidence, {
        configurationReferences: ["source-connection/fanbox/another-creator@1"],
      }),
    ).resolves.toMatchObject({ records: [] });
    const collected = await collector.collect(evidence, {
      configurationReferences: ["source-connection/fanbox/customudon@1"],
    });

    expect(collected.records).toHaveLength(2);
    expect(requestedCookies).toEqual([
      `FANBOXSESSID=${privateSession}`,
      `FANBOXSESSID=${privateSession}`,
    ]);
    expect(JSON.stringify(collected)).not.toContain(privateSession);
  });

  it("fails authentication or network access without exposing credentials", async () => {
    const secret = "experiment=0; FANBOXSESSID=top-secret";
    const privateUserAgent = "private-browser-fingerprint/987654";
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(secret, privateUserAgent),
      request: async (_address, init) => {
        throw new Error(
          `HTTP 403 transport rejected ${secret} ${init.headers["User-Agent"]}`,
        );
      },
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([]);
    expect(JSON.stringify(result.failures)).not.toContain("top-secret");
    expect(JSON.stringify(result.failures)).not.toContain(privateUserAgent);
    expect(result.failures[0]?.reason).toContain("renderer request failed");
    expect(result.failures[0]?.reason).not.toContain("transport rejected");
    expect(result.failures[0]?.failureCode).toBe("transport-failure");
  });

  it("redacts raw, JSON-escaped, and percent-encoded browser-secret reflections", async () => {
    const secret = "session+private/token";
    const representations = [
      secret,
      Array.from(secret)
        .map(
          (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
        )
        .join(""),
      encodeURIComponent(secret),
    ];
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    for (const reflected of representations) {
      const collector = scriptedCollector({
        creatorId: "customudon",
        privateConfiguration: testPrivateConfiguration(
          `FANBOXSESSID=${secret}`,
        ),
        request: async () => {
          throw new Error(`remote request rejected: ${reflected}`);
        },
      });
      const result = await collector.collect(evidence);
      const observable = JSON.stringify(result);
      expect(observable).not.toContain(secret);
      expect(observable).not.toContain(reflected);
      expect(result.records).toEqual([]);
    }
  });

  it.each([{ error: null }, { errors: false }])(
    "does not retain an HTTP-success FANBOX envelope declaring an error %#",
    async (declaredError) => {
      const privateSession = "fanbox-semantic-error-session";
      const collector = scriptedCollector({
        creatorId: "customudon",
        privateConfiguration: testPrivateConfiguration(
          `FANBOXSESSID=${privateSession}`,
        ),
        request: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          arrayBuffer: async () =>
            new TextEncoder().encode(
              JSON.stringify({ body: { posts: [] }, ...declaredError }),
            ).buffer,
        }),
      });
      const evidence = directoryEvidence(
        "/library/customudon/25.01.01 post",
      )[0];

      const result = await collector.collect(evidence);

      expect(result.records).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toContain(
        "response was not a successful envelope",
      );
      expect(result.failures[0]?.failureCode).toBe("response-contract");
      expect(JSON.stringify(result)).not.toContain(privateSession);
    },
  );

  it("rejects an HTTP-success non-JSON response before it can form source evidence", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=non-json-semantic-session",
      ),
      request: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        arrayBuffer: async () =>
          new TextEncoder().encode('{"body":{"items":[]}}').buffer,
      }),
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    await expect(collector.collect(evidence)).resolves.toMatchObject({
      records: [],
      failures: [expect.any(Object)],
    });
  });

  it("rejects a selected summary with an invalid official publication datetime before any source record forms", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=invalid-summary-datetime-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "无效时间",
                  publishedDatetime: "2025-02-30T00:11:17+09:00",
                  type: "article",
                  body: { blocks: [{ type: "p", text: "正文" }] },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "无效时间",
                      publishedDatetime: "2025-02-30T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });
    const known = {
      kind: "source-association" as const,
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    };

    const result = await collector.collect(known);

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("rejects a selected summary whose title is only whitespace before any source record forms", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=blank-summary-title-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "有效详情标题",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "text",
                  body: { text: "完整正文" },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: " \t　\n ",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });

    const result = await collector.collect(knownFanboxPostEvidence());

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("rejects an RFC3339-shaped summary datetime with an impossible timezone offset before any source record forms", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=invalid-summary-offset-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "无效时区",
                  publishedDatetime: "2025-01-01T00:11:17+25:99",
                  type: "text",
                  body: { text: "正文" },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "无效时区",
                      publishedDatetime: "2025-01-01T00:11:17+25:99",
                    },
                  ],
                },
              },
        ),
    });
    const known = {
      kind: "source-association" as const,
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    };

    const result = await collector.collect(known);

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("accepts RFC3339 offsets through ±14:00 but rejects offsets beyond that bound", async () => {
    const known = {
      kind: "source-association" as const,
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    };
    const valid = [
      "2024-02-29T23:59:59Z",
      "2024-02-29T23:59:59+00:00",
      "2024-02-29T23:59:59+09:00",
      "2024-02-29T23:59:59+14:00",
      "2024-02-29T23:59:59-14:00",
    ];
    const invalid = [
      "2024-02-29T23:59:59+14:01",
      "2024-02-29T23:59:59+15:00",
      "2024-02-29T23:59:59-23:59",
    ];

    for (const publishedDatetime of valid) {
      const result = await collectorForDetail({
        type: "text",
        body: { text: "完整正文" },
        publishedDatetime,
      }).collect(known);

      expect(result.records).toHaveLength(2);
      expect(result.failures).toEqual([]);
    }
    for (const publishedDatetime of invalid) {
      const result = await collectorForDetail({
        type: "text",
        body: { text: "完整正文" },
        publishedDatetime,
      }).collect(known);

      expect(result.records).toEqual([]);
      expect(result.failures).toHaveLength(1);
    }
  });

  it("rejects a detail whose valid publication datetime contradicts the selected summary before either record forms", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=mismatched-datetime-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "日期不一致",
                  publishedDatetime: "2025-01-02T00:11:17+09:00",
                  type: "article",
                  body: { blocks: [{ type: "p", text: "正文" }] },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "日期不一致",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("rejects an invalid detail publication datetime before either source record forms", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=invalid-detail-datetime-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "无效详情时间",
                  publishedDatetime: "not-a-fanbox-datetime",
                  type: "text",
                  body: { text: "正文" },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "无效详情时间",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });
    const known = {
      kind: "source-association" as const,
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    };

    const result = await collector.collect(known);

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("rejects a whitespace-only detail title without retaining a falsely paired summary", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=blank-detail-title-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: " \t　\n ",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "text",
                  body: { text: "完整正文" },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "有效摘要标题",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });

    const result = await collector.collect(knownFanboxPostEvidence());

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("preserves a meaningful Unicode title verbatim while trim only decides whether it is blank", async () => {
    const title = "  次の動画の準備　🎙️  ";
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=unicode-title-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title,
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "text",
                  body: { text: "完整正文" },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title,
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });

    const evidence = knownFanboxPostEvidence();
    const result = await collector.collect(evidence);
    const [batch] = new FanboxSourceInterpreter().interpret({
      evidence: [evidence],
      sourceRecords: result.records,
    });

    expect(result.failures).toEqual([]);
    expect(result.records).toHaveLength(2);
    expect(batch.metadata).toContainEqual(
      expect.objectContaining({ property: "asset.title", value: title }),
    );
  });

  it("marks a selected post from an exactly 300-post creator summary as incomplete", async () => {
    const requested: string[] = [];
    const posts = Array.from({ length: 300 }, (_, index) => ({
      id: index === 299 ? "9135862" : `boundary-${index}`,
      creatorId: "customudon",
      title: index === 299 ? "边界帖子" : `其他帖子 ${index}`,
      publishedDatetime:
        index === 299
          ? "2025-01-01T00:11:17+09:00"
          : "2024-12-31T00:11:17+09:00",
    }));
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=boundary-summary-session",
      ),
      request: async (address) => {
        requested.push(address);
        return jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "边界帖子",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "article",
                  body: { blocks: [{ type: "p", text: "正文" }] },
                },
              }
            : { body: { posts } },
        );
      },
    });
    const known = {
      kind: "source-association" as const,
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    };

    const result = await collector.collect(known);

    expect(result.failures).toEqual([]);
    expect(result.records[0]?.coverage).toMatchObject({
      id: "fanbox.creator-post-summaries",
      completeness: "incomplete",
    });
    expect(requested[0]).toBe(
      "https://api.fanbox.cc/post.listCreator?creatorId=customudon&limit=300",
    );
    expect(requested).toHaveLength(2);
  });

  it("fails explicitly when an exactly 300-post creator summary omits the known post", async () => {
    const requested: string[] = [];
    const posts = Array.from({ length: 300 }, (_, index) => ({
      id: `boundary-${index}`,
      creatorId: "customudon",
      title: `其他帖子 ${index}`,
      publishedDatetime: "2024-12-31T00:11:17+09:00",
    }));
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=truncated-summary-session",
      ),
      request: async (address) => {
        requested.push(address);
        return jsonResponse({ body: { posts } });
      },
    });
    const known = {
      kind: "source-association" as const,
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    };

    const result = await collector.collect(known);

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain("truncated creator summaries");
    expect(result.failures[0]?.failureCode).toBe("summary-selection");
    expect(requested).toHaveLength(1);
  });

  it("rejects a successful summary whose addressed post belongs to another creator before a detail record can form", async () => {
    const requested: string[] = [];
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=semantic-summary-session",
      ),
      request: async (address) => {
        requested.push(address);
        return jsonResponse({
          body: {
            posts: [
              {
                id: "9135862",
                creatorId: "anothercreator",
                title: "错误范围",
                publishedDatetime: "2025-01-01T00:11:17+09:00",
              },
            ],
          },
        });
      },
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.failureCode).toBe("source-identity-conflict");
    expect(requested).toHaveLength(1);
  });

  it("classifies duplicate known-post summaries as a selection failure", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=duplicate-summary-session",
      ),
      request: async () =>
        jsonResponse({
          body: {
            posts: [
              {
                id: "9135862",
                creatorId: "customudon",
                title: "第一个摘要",
                publishedDatetime: "2025-01-01T00:11:17+09:00",
              },
              {
                id: "9135862",
                creatorId: "customudon",
                title: "冲突摘要",
                publishedDatetime: "2025-01-01T00:11:17+09:00",
              },
            ],
          },
        }),
    });
    const known = {
      kind: "source-association" as const,
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    };

    const result = await collector.collect(known);

    expect(result.records).toEqual([]);
    expect(result.failures[0]?.failureCode).toBe("summary-selection");
  });

  it("retains a valid summary but no fabricated detail record when the protected endpoint is structurally malformed", async () => {
    const details = [{ body: null }];
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    for (const detail of details) {
      const collector = scriptedCollector({
        creatorId: "customudon",
        privateConfiguration: testPrivateConfiguration(
          "FANBOXSESSID=malformed-detail-session",
        ),
        request: async (address) =>
          jsonResponse(
            address.includes("post.info")
              ? detail
              : {
                  body: {
                    posts: [
                      {
                        id: "9135862",
                        creatorId: "customudon",
                        title: "有效摘要",
                        publishedDatetime: "2025-01-01T00:11:17+09:00",
                      },
                    ],
                  },
                },
          ),
      });

      const result = await collector.collect(evidence);
      expect(result.records).toEqual([
        expect.objectContaining({
          coverage: expect.objectContaining({
            id: "fanbox.creator-post-summaries",
          }),
        }),
      ]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.failureCode).toBe("response-contract");
      expect(result.failures[0]?.coverage).toEqual({
        sourceIdentity: "fanbox",
        nativeAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
        coverageId: "fanbox.post-detail",
      });
    }
  });

  it("rejects contradictory protected detail identity without retaining a summary under that unresolved source identity", async () => {
    const details = [
      {
        body: {
          id: "9135863",
          creatorId: "customudon",
          title: "错误帖子",
          publishedDatetime: "2025-01-01T00:11:17+09:00",
          body: { text: "完整正文" },
        },
      },
      {
        body: {
          id: "9135862",
          creatorId: "anothercreator",
          title: "错误创作者",
          publishedDatetime: "2025-01-01T00:11:17+09:00",
          body: { text: "完整正文" },
        },
      },
    ];
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    for (const detail of details) {
      const collector = scriptedCollector({
        creatorId: "customudon",
        privateConfiguration: testPrivateConfiguration(
          "FANBOXSESSID=semantic-detail-session",
        ),
        request: async (address) =>
          jsonResponse(
            address.includes("post.info")
              ? detail
              : {
                  body: {
                    posts: [
                      {
                        id: "9135862",
                        creatorId: "customudon",
                        title: "有效摘要",
                        publishedDatetime: "2025-01-01T00:11:17+09:00",
                      },
                    ],
                  },
                },
          ),
      });

      const result = await collector.collect(evidence);
      expect(result.records).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.failureCode).toBe("source-identity-conflict");
    }
  });

  it("rejects an unrecognized official post form instead of claiming complete detail coverage", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=unknown-form-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "未知形式",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "newsletter",
                  body: { text: "不能按猜测的形式保留" },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "未知形式",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([
      expect.objectContaining({
        coverage: expect.objectContaining({
          id: "fanbox.creator-post-summaries",
        }),
      }),
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.failureCode).toBe("detail-contract");
  });

  it("rejects a public article with no usable body instead of retaining a false complete detail record", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=empty-article-body-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "空文章",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "article",
                  body: {},
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "空文章",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([
      expect.objectContaining({
        coverage: expect.objectContaining({
          id: "fanbox.creator-post-summaries",
        }),
      }),
    ]);
    expect(result.failures).toHaveLength(1);
  });

  it("rejects a public article with an empty block list instead of treating an empty body as complete", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=empty-article-blocks-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "空区块文章",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "article",
                  body: { blocks: [] },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "空区块文章",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([
      expect.objectContaining({
        coverage: expect.objectContaining({
          id: "fanbox.creator-post-summaries",
        }),
      }),
    ]);
    expect(result.failures).toHaveLength(1);
  });

  it("does not mistake whitespace-only text content for a complete public detail", async () => {
    const result = await collectorForDetail({
      type: "text",
      body: { text: " \t\n " },
    }).collect(knownFanboxPostEvidence());

    expectSummaryOnlyDetailFailure(result);
  });

  it("does not mistake whitespace-only article paragraphs or headers for content", async () => {
    for (const type of ["p", "header"]) {
      const result = await collectorForDetail({
        type: "article",
        body: { blocks: [{ type, text: " \n\t " }] },
      }).collect(knownFanboxPostEvidence());

      expectSummaryOnlyDetailFailure(result);
    }
  });

  it("requires an article embed block to resolve a source-native embed payload", async () => {
    const result = await collectorForDetail({
      type: "article",
      body: { blocks: [{ type: "embed", embedId: "embed-1" }] },
    }).collect(knownFanboxPostEvidence());

    expectSummaryOnlyDetailFailure(result);
  });

  it("accepts each official article content form when its referenced payload is valid", async () => {
    const file = {
      id: "file-1",
      url: "https://downloads.fanbox.cc/files/post/file-1.zip",
    };
    const image = {
      id: "image-1",
      originalUrl: "https://downloads.fanbox.cc/images/post/image-1.jpg",
    };
    const embed = {
      id: "embed-1",
      serviceProvider: "youtube",
      contentId: "video-1",
    };
    const urlEmbed = {
      id: "url-embed-1",
      type: "default",
      url: "https://example.com/embedded-post",
    };
    const bodies = [
      { blocks: [{ type: "p", text: "正文" }] },
      { blocks: [{ type: "header", text: "标题" }] },
      {
        blocks: [{ type: "file", fileId: file.id }],
        fileMap: { [file.id]: file },
      },
      {
        blocks: [{ type: "image", imageId: image.id }],
        imageMap: { [image.id]: image },
      },
      {
        blocks: [{ type: "embed", embedId: embed.id }],
        embedMap: { [embed.id]: embed },
      },
      {
        blocks: [{ type: "url_embed", urlEmbedId: urlEmbed.id }],
        urlEmbedMap: { [urlEmbed.id]: urlEmbed },
      },
    ];

    for (const body of bodies) {
      const result = await collectorForDetail({
        type: "article",
        body,
      }).collect(knownFanboxPostEvidence());

      expect(result.records).toHaveLength(2);
      expect(result.failures).toEqual([]);
    }
  });

  it("does not let a valid article sibling mask an empty or invalid content block", async () => {
    const file = {
      id: "file-1",
      url: "https://downloads.fanbox.cc/files/post/file-1.zip",
    };
    const bodies = [
      {
        blocks: [
          { type: "file", fileId: file.id },
          { type: "p", text: "  \t" },
        ],
        fileMap: { [file.id]: file },
      },
      {
        blocks: [
          { type: "p", text: "正文" },
          { type: "image", imageId: "missing-image" },
        ],
      },
      { blocks: [{}] },
    ];

    for (const body of bodies) {
      const result = await collectorForDetail({
        type: "article",
        body,
      }).collect(knownFanboxPostEvidence());

      expectSummaryOnlyDetailFailure(result);
    }
  });

  it("requires each file or image detail to contain nonempty fully valid attachments", async () => {
    const validFile = {
      id: "file-1",
      url: "https://downloads.fanbox.cc/files/post/file-1.zip",
    };
    const validImage = {
      id: "image-1",
      originalUrl: "https://downloads.fanbox.cc/images/post/image-1.jpg",
    };
    const cases = [
      {
        input: { type: "file", body: { files: [validFile] } },
        complete: true,
      },
      {
        input: { type: "image", body: { images: [validImage] } },
        complete: true,
      },
      { input: { type: "file", body: { files: [] } }, complete: false },
      { input: { type: "image", body: { images: [] } }, complete: false },
      {
        input: {
          type: "file",
          body: { files: [validFile, { ...validFile, id: " \t" }] },
        },
        complete: false,
      },
      {
        input: {
          type: "image",
          body: {
            images: [
              validImage,
              {
                ...validImage,
                id: "image-unofficial",
                originalUrl: "https://example.com/not-an-official-image.jpg",
              },
            ],
          },
        },
        complete: false,
      },
    ] as const;

    for (const testCase of cases) {
      const result = await collectorForDetail(testCase.input).collect(
        knownFanboxPostEvidence(),
      );

      if (testCase.complete) {
        expect(result.records).toHaveLength(2);
        expect(result.failures).toEqual([]);
      } else {
        expectSummaryOnlyDetailFailure(result);
      }
    }
  });

  it("rejects present but invalid official attachment names and byte lengths", async () => {
    const invalidFields = [
      { name: "" },
      { name: 42 },
      { size: -1 },
      { size: 1.5 },
      { size: Number.MAX_SAFE_INTEGER + 1 },
      { size: "42" },
    ] as const;

    for (const invalidField of invalidFields) {
      const result = await collectorForDetail({
        type: "file",
        body: {
          files: [
            {
              id: "file-1",
              url: "https://downloads.fanbox.cc/files/post/file-1.zip",
              ...invalidField,
            },
          ],
        },
      }).collect(knownFanboxPostEvidence());

      expectSummaryOnlyDetailFailure(result);
    }
  });

  it("requires a video detail to identify a supported source-native video", async () => {
    const valid = await collectorForDetail({
      type: "video",
      body: {
        video: { serviceProvider: "youtube", videoId: "video-1" },
      },
    }).collect(knownFanboxPostEvidence());
    const whitespaceIdentity = await collectorForDetail({
      type: "video",
      body: {
        video: { serviceProvider: "youtube", videoId: " \t" },
      },
    }).collect(knownFanboxPostEvidence());

    expect(valid.records).toHaveLength(2);
    expect(valid.failures).toEqual([]);
    expectSummaryOnlyDetailFailure(whitespaceIdentity);
  });

  it("rejects an article attachment block whose map entry is malformed instead of retaining partial detail coverage", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=bad-article-attachment-session",
      ),
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "错误附件",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "article",
                  body: {
                    blocks: [{ type: "file", fileId: "missing-url" }],
                    fileMap: { "missing-url": { id: "missing-url" } },
                  },
                },
              }
            : {
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "错误附件",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                },
              },
        ),
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([
      expect.objectContaining({
        coverage: expect.objectContaining({
          id: "fanbox.creator-post-summaries",
        }),
      }),
    ]);
    expect(result.failures).toHaveLength(1);
  });

  it("fails closed when an official response reflects private configuration into the capturable body", async () => {
    const secret = "super-secret-session-token";
    const privateUserAgent = "private-browser-fingerprint/response-123";
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        `p_ab_id=8; FANBOXSESSID=${secret}`,
        privateUserAgent,
      ),
      request: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        arrayBuffer: async () =>
          new TextEncoder().encode(
            JSON.stringify({
              body: {
                posts: [
                  {
                    id: "9135862",
                    creatorId: "customudon",
                    publishedDatetime: "2025-01-01T00:11:17+09:00",
                    title: privateUserAgent,
                  },
                ],
              },
            }),
          ).buffer,
      }),
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(privateUserAgent);
    expect(result.failures[0]?.reason).toContain("private configuration");
  });

  it("does not let short cookie values or raw browser errors cross the session seam", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(
        "FANBOXSESSID=test-private-session; p_ab_id=8; p_ab_id_2=2",
      ),
      request: async () => {
        throw new Error("HTTP 403 after 8 redirects");
      },
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.failures[0]?.reason).toContain("renderer request failed");
    expect(result.failures[0]?.reason).not.toContain("8 redirects");
    expect(JSON.stringify(result)).not.toContain("p_ab_id=8");
  });

  it("captures restricted post detail so its form remains sourced instead of inferred from the summary", async () => {
    let requests = 0;
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration("FANBOXSESSID=private"),
      request: async (address) => {
        requests += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          arrayBuffer: async () =>
            new TextEncoder().encode(
              JSON.stringify(
                address.includes("post.info")
                  ? {
                      body: {
                        post: {
                          id: "7576910",
                          creatorId: "customudon",
                          title: "Movie | ひみつ",
                          publishedDatetime: "2024-03-07T22:55:32+09:00",
                          type: "article",
                          isRestricted: true,
                          body: null,
                        },
                      },
                    }
                  : {
                      body: {
                        posts: [
                          {
                            id: "7576910",
                            creatorId: "customudon",
                            title: "Movie | ひみつ",
                            publishedDatetime: "2024-03-07T22:55:32+09:00",
                            isRestricted: true,
                          },
                        ],
                      },
                    },
              ),
            ).buffer,
        };
      },
    });
    const evidence = directoryEvidence("/library/customudon/24.03.07 post")[0];

    const result = await collector.collect(evidence);
    const [batch] = new FanboxSourceInterpreter().interpret({
      evidence: [evidence],
      sourceRecords: result.records,
    });

    expect(requests).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.records.map((record) => record.coverage.id)).toEqual([
      "fanbox.creator-post-summaries",
      "fanbox.post-detail",
    ]);
    expect(result.records[1]?.coverage.completeness).toBe("incomplete");
    expect(batch.sourceArtifacts).toEqual([]);
    expect(
      batch.metadata.find((item) => item.property === "fanbox.post.entitlement")
        ?.value,
    ).toBe("restricted");
  });

  it("retains the uniquely addressed summary when public detail transport is unavailable", async () => {
    let requests = 0;
    const cookies: (string | undefined)[] = [];
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration("FANBOXSESSID=private"),
      request: async (address, init) => {
        requests += 1;
        cookies.push(init.headers.Cookie);
        if (address.includes("post.info"))
          return {
            ok: false,
            status: 403,
            headers: { get: () => "application/json" },
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          arrayBuffer: async () =>
            new TextEncoder().encode(
              JSON.stringify({
                body: {
                  posts: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "年始の挨拶(おまけ動画付き)",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                      isRestricted: false,
                    },
                  ],
                },
              }),
            ).buffer,
        };
      },
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(requests).toBe(3);
    expect(cookies).toEqual([
      "FANBOXSESSID=private",
      "FANBOXSESSID=private",
      undefined,
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.coverage.id).toBe(
      "fanbox.creator-post-summaries",
    );
    expect(result.failures[0]).toMatchObject({
      failureCode: "http:post-detail:403",
      reason: expect.stringContaining("HTTP 403"),
      affects: {
        metadataProperties: ["fanbox.post.form", "asset.body"],
        artifactRoles: ["fanbox.attachment.*"],
      },
    });
  });

  it("identifies a Cloudflare challenge on protected detail without retaining its page or credentials", async () => {
    const secret = "FANBOXSESSID=top-secret";
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(secret),
      request: async (address) =>
        address.includes("post.info")
          ? {
              ok: false,
              status: 403,
              headers: { get: () => "text/html" },
              arrayBuffer: async () =>
                new TextEncoder().encode(
                  "<html><script>window._cf_chl_opt={};challenge-platform</script></html>",
                ).buffer,
            }
          : {
              ok: true,
              status: 200,
              headers: { get: () => "application/json" },
              arrayBuffer: async () =>
                new TextEncoder().encode(
                  JSON.stringify({
                    body: {
                      posts: [
                        {
                          id: "9135862",
                          creatorId: "customudon",
                          title: "年始の挨拶(おまけ動画付き)",
                          publishedDatetime: "2025-01-01T00:11:17+09:00",
                          isRestricted: false,
                        },
                      ],
                    },
                  }),
                ).buffer,
            },
    });
    const evidence = directoryEvidence("/library/customudon/25.01.01 post")[0];

    const result = await collector.collect(evidence);

    expect(result.records).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain("Cloudflare challenge");
    expect(result.failures[0]?.failureCode).toBe("cloudflare-challenge");
    expect(result.failures[0]?.reason).toContain("browser clearance");
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(JSON.stringify(result)).not.toContain("challenge-platform");
  });

  it("uses one public detail response after authenticated transport rejection without sending its Cookie", async () => {
    const secret = "public-retry-private-session";
    const detailCookies: (string | undefined)[] = [];
    const detailUserAgents: (string | undefined)[] = [];
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(`FANBOXSESSID=${secret}`),
      request: async (address, init) => {
        if (address.includes("post.listCreator"))
          return jsonResponse({
            body: {
              posts: [
                {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "公开详情",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                },
              ],
            },
          });
        detailCookies.push(init.headers.Cookie);
        detailUserAgents.push(init.headers["User-Agent"]);
        if (detailCookies.length === 1)
          return {
            ok: false,
            status: 403,
            headers: { get: () => "application/json" },
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        return jsonResponse({
          body: {
            post: {
              id: "9135862",
              creatorId: "customudon",
              title: "公开详情",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
              type: "text",
              body: { text: "公开完整正文" },
            },
          },
        });
      },
    });

    const result = await collector.collect(knownFanboxPostEvidence());

    expect(detailCookies).toEqual([`FANBOXSESSID=${secret}`, undefined]);
    expect(detailUserAgents).toEqual(["test-browser/1", "test-browser/1"]);
    expect(result.failures).toEqual([]);
    expect(result.records[1]).toMatchObject({
      acquisition: { authorized: false },
      coverage: { id: "fanbox.post-detail", completeness: "complete" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("retains a public restricted detail and the sanitized authenticated coverage failure", async () => {
    const secret = "restricted-retry-private-session";
    const detailCookies: (string | undefined)[] = [];
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration(`FANBOXSESSID=${secret}`),
      request: async (address, init) => {
        if (address.includes("post.listCreator"))
          return jsonResponse({
            body: {
              posts: [
                {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "受限详情",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                },
              ],
            },
          });
        detailCookies.push(init.headers.Cookie);
        if (detailCookies.length === 1)
          throw new Error(`HTTP 403 rejected FANBOXSESSID=${secret}`);
        return jsonResponse({
          body: {
            post: {
              id: "9135862",
              creatorId: "customudon",
              title: "受限详情",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
              type: "file",
              isRestricted: true,
            },
          },
        });
      },
    });

    const result = await collector.collect(knownFanboxPostEvidence());

    expect(detailCookies).toEqual([`FANBOXSESSID=${secret}`, undefined]);
    expect(result.records[1]).toMatchObject({
      acquisition: { authorized: false },
      coverage: { id: "fanbox.post-detail", completeness: "incomplete" },
    });
    expect(result.failures).toEqual([
      expect.objectContaining({
        coverage: expect.objectContaining({ coverageId: "fanbox.post-detail" }),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("reacquires a known FANBOX association without reinterpreting its directory", async () => {
    const collector = scriptedCollector({
      creatorId: "customudon",
      privateConfiguration: testPrivateConfiguration("FANBOXSESSID=private"),
      request: async (address) => {
        const payload = address.includes("post.listCreator")
          ? {
              body: {
                posts: [
                  {
                    id: "9135862",
                    creatorId: "customudon",
                    title: "年始の挨拶",
                    publishedDatetime: "2025-01-01T00:11:17+09:00",
                    isRestricted: false,
                  },
                ],
              },
            }
          : {
              body: {
                post: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "年始の挨拶",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "text",
                  body: { text: "完整正文" },
                },
              },
            };
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          arrayBuffer: async () =>
            new TextEncoder().encode(JSON.stringify(payload)).buffer,
        };
      },
    });
    const known = {
      kind: "source-association",
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    };

    expect(collector.canCollect(known)).toBe(true);
    await expect(collector.collect(known)).resolves.toMatchObject({
      records: [
        { nativeAddress: known.sourceAddress },
        { nativeAddress: known.sourceAddress },
      ],
      failures: [],
    });
  });
});

describe("FANBOX interpretation", () => {
  it("projects every supported article block while attachments remain source artifact candidate selection evidence", async () => {
    const file = {
      id: "file-1",
      name: "bonus.zip",
      extension: "zip",
      size: 42,
      url: "https://downloads.fanbox.cc/files/post/bonus.zip",
    };
    const image = {
      id: "image-1",
      name: "illustration.jpg",
      extension: "jpg",
      size: 84,
      originalUrl: "https://downloads.fanbox.cc/images/post/illustration.jpg",
    };
    const embed = {
      id: "embed-1",
      serviceProvider: "youtube",
      contentId: "video-1",
    };
    const urlEmbed = {
      id: "url-embed-1",
      type: "default",
      url: "https://example.com/official-reference",
    };
    const evidence = knownFanboxPostEvidence();
    const collected = await collectorForDetail({
      type: "article",
      body: {
        blocks: [
          { type: "header", text: "見出し" },
          { type: "p", text: "本文" },
          { type: "p", text: "" },
          { type: "embed", embedId: embed.id },
          { type: "file", fileId: file.id },
          { type: "image", imageId: image.id },
          { type: "url_embed", urlEmbedId: urlEmbed.id },
        ],
        fileMap: { [file.id]: file },
        imageMap: { [image.id]: image },
        embedMap: { [embed.id]: embed },
        urlEmbedMap: { [urlEmbed.id]: urlEmbed },
      },
    }).collect(evidence);

    expect(collected.failures).toEqual([]);
    const [batch] = new FanboxSourceInterpreter().interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });
    const [reinterpreted] = new FanboxSourceInterpreter().interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });

    expect(
      batch.metadata
        .filter((item) => item.property === "fanbox.post.body-block")
        .map((item) => ({
          value: JSON.parse(item.value),
          qualifiers: item.qualifiers,
        })),
    ).toEqual([
      {
        value: { type: "header", text: "見出し" },
        qualifiers: [
          { key: "fanbox.post.block-type", value: "header" },
          { key: "fanbox.post.block-ordinal", value: "0" },
        ],
      },
      {
        value: { type: "p", text: "本文" },
        qualifiers: [
          { key: "fanbox.post.block-type", value: "p" },
          { key: "fanbox.post.block-ordinal", value: "1" },
        ],
      },
      {
        value: { type: "p", text: "" },
        qualifiers: [
          { key: "fanbox.post.block-type", value: "p" },
          { key: "fanbox.post.block-ordinal", value: "2" },
        ],
      },
      {
        value: {
          type: "embed",
          embed: {
            id: "embed-1",
            serviceProvider: "youtube",
            contentId: "video-1",
          },
        },
        qualifiers: [
          { key: "fanbox.post.block-type", value: "embed" },
          { key: "fanbox.post.block-ordinal", value: "3" },
        ],
      },
      {
        value: { type: "file", fileId: "file-1" },
        qualifiers: [
          { key: "fanbox.post.block-type", value: "file" },
          { key: "fanbox.post.block-ordinal", value: "4" },
        ],
      },
      {
        value: { type: "image", imageId: "image-1" },
        qualifiers: [
          { key: "fanbox.post.block-type", value: "image" },
          { key: "fanbox.post.block-ordinal", value: "5" },
        ],
      },
      {
        value: {
          type: "url_embed",
          urlEmbed: {
            id: "url-embed-1",
            type: "default",
            url: "https://example.com/official-reference",
          },
        },
        qualifiers: [
          { key: "fanbox.post.block-type", value: "url_embed" },
          { key: "fanbox.post.block-ordinal", value: "6" },
        ],
      },
    ]);
    expect(
      batch.metadata.find((item) => item.property === "asset.body")?.value,
    ).toBe("本文");
    expect(
      batch.metadata.some((item) =>
        item.property.startsWith("fanbox.attachment."),
      ),
    ).toBe(false);
    expect(batch.sourceArtifacts).toEqual([
      expect.objectContaining({
        role: "fanbox.attachment.file",
        selectionEvidence: {
          suggestedFilename: "bonus.zip",
          declaredByteLength: 42,
          sourceOrdinal: 0,
        },
      }),
      expect.objectContaining({
        role: "fanbox.attachment.image",
        selectionEvidence: {
          suggestedFilename: "illustration.jpg",
          declaredByteLength: 84,
          sourceOrdinal: 1,
        },
      }),
    ]);
    expect(reinterpreted.sourceArtifacts.map((item) => item.id)).toEqual(
      batch.sourceArtifacts.map((item) => item.id),
    );
  });

  it("changes durable attachment ordinals when the official attachment array is reordered", async () => {
    const attachment = (id: "a" | "z") => ({
      id,
      name: `${id}.zip`,
      size: id === "z" ? 90 : 10,
      url: `https://downloads.fanbox.cc/files/post/${id}.zip`,
    });
    const projectedOrdinals = async (ids: readonly ("a" | "z")[]) => {
      const evidence = knownFanboxPostEvidence();
      const collected = await collectorForDetail({
        type: "file",
        body: { files: ids.map(attachment) },
      }).collect(evidence);
      const [batch] = new FanboxSourceInterpreter().interpret({
        evidence: [evidence],
        sourceRecords: collected.records,
      });
      return batch.sourceArtifacts.map((item) => [
        item.selectionEvidence?.suggestedFilename,
        item.selectionEvidence?.sourceOrdinal,
      ]);
    };

    await expect(projectedOrdinals(["z", "a"])).resolves.toEqual([
      ["z.zip", 0],
      ["a.zip", 1],
    ]);
    await expect(projectedOrdinals(["a", "z"])).resolves.toEqual([
      ["a.zip", 0],
      ["z.zip", 1],
    ]);
  });

  it("deduplicates download attachments by first occurrence with contiguous ordinals", async () => {
    const attachment = (id: "a" | "b") => ({
      id,
      name: `${id}.zip`,
      size: id === "a" ? 10 : 20,
      url: `https://downloads.fanbox.cc/files/post/${id}.zip`,
    });
    const evidence = knownFanboxPostEvidence();
    const project = async (
      detail: Parameters<typeof collectorForDetail>[0],
    ) => {
      const collected = await collectorForDetail(detail).collect(evidence);
      const [batch] = new FanboxSourceInterpreter().interpret({
        evidence: [evidence],
        sourceRecords: collected.records,
      });
      return {
        ordinals: batch.sourceArtifacts.map((item) => [
          item.selectionEvidence?.suggestedFilename,
          item.selectionEvidence?.sourceOrdinal,
        ]),
        blocks: batch.metadata
          .filter((item) => item.property === "fanbox.post.body-block")
          .map((item) => JSON.parse(item.value)),
      };
    };

    await expect(
      project({
        type: "article",
        body: {
          blocks: [
            { type: "file", fileId: "a" },
            { type: "file", fileId: "a" },
            { type: "file", fileId: "b" },
          ],
          fileMap: { a: attachment("a"), b: attachment("b") },
        },
      }),
    ).resolves.toEqual({
      ordinals: [
        ["a.zip", 0],
        ["b.zip", 1],
      ],
      blocks: [
        { type: "file", fileId: "a" },
        { type: "file", fileId: "a" },
        { type: "file", fileId: "b" },
      ],
    });
    await expect(
      project({
        type: "file",
        body: { files: [attachment("a"), attachment("a"), attachment("b")] },
      }),
    ).resolves.toMatchObject({
      ordinals: [
        ["a.zip", 0],
        ["b.zip", 1],
      ],
    });
  });

  it("does not reinterpret a retained unknown article block as complete body or attachment facts", () => {
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/9135862";
    const evidence = directoryEvidence("/library/customudon/25.01.01 post");
    const sourceRecords = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          posts: [
            {
              id: "9135862",
              creatorId: "customudon",
              title: "未知块",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
            },
          ],
        },
      }),
      sourceRecord("detail", nativeAddress, "fanbox.post-detail", {
        body: {
          id: "9135862",
          creatorId: "customudon",
          title: "未知块",
          publishedDatetime: "2025-01-01T00:11:17+09:00",
          type: "article",
          body: {
            blocks: [
              { type: "p", text: "有效兄弟" },
              { type: "future-material", url: "https://example.com/future" },
            ],
          },
        },
      }),
    ];

    expect(() =>
      new FanboxSourceInterpreter().interpret({ evidence, sourceRecords }),
    ).toThrow("FANBOX article block type was unsupported");
  });

  it("fails closed for malformed business members in a manually retained summary array", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/9135862";
    const evidence = directoryEvidence("/library/customudon/25.01.01 post");
    const recordSets = [
      [
        sourceRecord(
          "summary",
          nativeAddress,
          "fanbox.creator-post-summaries",
          {
            body: {
              posts: [
                {
                  id: "9135862",
                  creatorId: "customudon",
                  title: " \t　\n ",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                },
              ],
            },
          },
        ),
      ],
      [
        sourceRecord(
          "summary",
          nativeAddress,
          "fanbox.creator-post-summaries",
          {
            body: {
              posts: [
                {
                  id: "9135862",
                  creatorId: "customudon",
                  title: " \t　\n ",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                },
              ],
            },
          },
        ),
        sourceRecord("detail", nativeAddress, "fanbox.post-detail", {
          body: {
            id: "9135862",
            creatorId: "customudon",
            title: "有效详情标题",
            publishedDatetime: "2025-01-01T00:11:17+09:00",
            type: "text",
            body: { text: "完整正文" },
          },
        }),
      ],
      [
        sourceRecord(
          "summary",
          nativeAddress,
          "fanbox.creator-post-summaries",
          {
            body: {
              posts: [
                {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "有效摘要标题",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                },
              ],
            },
          },
        ),
        sourceRecord("detail", nativeAddress, "fanbox.post-detail", {
          body: {
            id: "9135862",
            creatorId: "customudon",
            title: " \t　\n ",
            publishedDatetime: "2025-01-01T00:11:17+09:00",
            type: "text",
            body: { text: "完整正文" },
          },
        }),
      ],
    ];

    for (const sourceRecords of recordSets) {
      expect(() => interpreter.interpret({ evidence, sourceRecords })).toThrow(
        "Missing FANBOX",
      );
    }
    const wrongCreator = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          posts: [
            {
              id: "9135862",
              creatorId: "customudon",
              title: "有效摘要标题",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
            },
            {
              id: "other",
              creatorId: "another-creator",
              title: "另一个成员",
              publishedDatetime: "2025-01-02T00:11:17+09:00",
            },
          ],
        },
      }),
    ];
    expect(() =>
      interpreter.interpret({ evidence, sourceRecords: wrongCreator }),
    ).toThrow("summary post creator differs from its scope");
  });

  it("retains a uniquely addressed summary as evidence without adopting detail-owned coordinates", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/7576910";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          posts: [
            {
              id: "7576910",
              creatorId: "customudon",
              title: "Movie | ひみつ",
              publishedDatetime: "2024-03-07T22:55:32+09:00",
              feeRequired: 100,
              isRestricted: true,
              cover: {
                url: "https://pixiv.pximg.net/fanbox/public/images/post/7576910/cover.jpeg",
              },
            },
          ],
        },
      }),
    ];
    const evidence = directoryEvidence("/library/customudon/24.03.07 post");

    expect(interpreter.canInterpret({ evidence, sourceRecords: records })).toBe(
      true,
    );
    const [batch] = interpreter.interpret({ evidence, sourceRecords: records });
    const proposal = new FanboxExactRecognizer().recognize({
      evidence,
      basis: { kind: "source-interpretation", interpretation: batch },
    });

    expect(batch.sourceRecordIds).toEqual(["summary"]);
    expect(batch.metadata).toEqual([]);
    expect(batch.sourceArtifacts).toEqual([]);
    expect(proposal.ruleResults[0]?.outcome).toBe("contradicted");
  });

  it("projects a post and creator through open metadata and relationship contracts without inventing attachment artifacts", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/9135862";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          posts: [
            {
              id: "9135862",
              creatorId: "customudon",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
              title: "年始の挨拶(おまけ動画付き)",
            },
          ],
        },
      }),
      sourceRecord("detail", nativeAddress, "fanbox.post-detail", {
        body: {
          id: "9135862",
          creatorId: "customudon",
          publishedDatetime: "2025-01-01T00:11:17+09:00",
          title: "年始の挨拶(おまけ動画付き)",
          excerpt: "あけましておめでとうございます。",
          type: "article",
          feeRequired: 0,
          likeCount: 1030,
          commentCount: 89,
          isRestricted: false,
          coverImageUrl: "https://downloads.fanbox.cc/images/post/cover.jpg",
          user: { name: "Custom_Udon" },
          body: {
            blocks: [
              { type: "p", text: "第一段" },
              { type: "p", text: "第二段" },
              { type: "file", fileId: "one" },
              { type: "image", imageId: "preview" },
            ],
            fileMap: {
              one: {
                id: "attachment",
                name: "bonus.mp4",
                extension: "mp4",
                size: 42,
                url: "https://downloads.fanbox.cc/files/post/bonus.mp4",
              },
            },
            imageMap: {
              preview: {
                id: "preview",
                name: "preview.jpg",
                extension: "jpg",
                size: 84,
                originalUrl:
                  "https://downloads.fanbox.cc/images/post/preview.jpg",
              },
            },
          },
        },
      }),
    ];
    const evidence = directoryEvidence("/library/customudon/25.01.01 post");

    const [batch] = interpreter.interpret({
      evidence,
      sourceRecords: records,
    });
    const proposal = new FanboxExactRecognizer().recognize({
      evidence,
      basis: { kind: "source-interpretation", interpretation: batch },
    });

    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "年始の挨拶(おまけ動画付き)",
        }),
        expect.objectContaining({
          property: "asset.publication-datetime",
          value: "2025-01-01T00:11:17+09:00",
        }),
        expect.objectContaining({
          property: "fanbox.post.form",
          value: "article",
        }),
        expect.objectContaining({
          property: "fanbox.post.entitlement",
          value: "available",
        }),
        expect.objectContaining({
          property: "fanbox.post.like-count",
          value: "1030",
        }),
        expect.objectContaining({
          property: "fanbox.post.comment-count",
          value: "89",
        }),
      ]),
    );
    expect(batch.entities).toMatchObject([
      {
        sourceKey: "customudon",
        identityNamespace: "fanbox.creator",
        label: "Custom_Udon",
      },
    ]);
    expect(batch.relationships).toMatchObject([
      { participants: [{ role: "fanbox.post.creator" }] },
    ]);
    expect(batch.sourceArtifacts).toHaveLength(3);
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.body",
          value: "第一段\n\n第二段",
        }),
      ]),
    );
    expect(batch.sourceArtifacts.map((item) => item.role)).toEqual([
      "asset.primary-cover",
      "fanbox.attachment.file",
      "fanbox.attachment.image",
    ]);
    expect(batch.sourceArtifacts[1]?.selectionEvidence).toEqual({
      suggestedFilename: "bonus.mp4",
      declaredByteLength: 42,
      sourceOrdinal: 0,
    });
    expect(proposal.ruleResults[0]?.outcome).toBe("satisfied");
    expect(batch.sourceArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "fanbox.attachment.file",
          acquisitionReference:
            "https://downloads.fanbox.cc/files/post/bonus.mp4",
        }),
        expect.objectContaining({
          role: "fanbox.attachment.image",
        }),
      ]),
    );
  });

  it("keeps the official summary cover when the retained detail omits cover fields", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/1739441";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          posts: [
            {
              id: "1739441",
              creatorId: "customudon",
              title: "今年も一年ありがとうございました。",
              publishedDatetime: "2020-12-29T19:08:45+09:00",
              isRestricted: false,
              cover: {
                url: "https://pixiv.pximg.net/fanbox/public/images/post/1739441/cover.jpeg",
              },
            },
          ],
        },
      }),
      sourceRecord("detail", nativeAddress, "fanbox.post-detail", {
        body: {
          id: "1739441",
          creatorId: "customudon",
          publishedDatetime: "2020-12-29T19:08:45+09:00",
          title: "今年も一年ありがとうございました。",
          type: "text",
          isRestricted: false,
          body: { text: "今年もありがとうございました。" },
        },
      }),
    ];
    const evidence = directoryEvidence("/library/customudon/20.12.29 post");

    const [batch] = interpreter.interpret({ evidence, sourceRecords: records });

    expect(batch.sourceArtifacts).toEqual([
      expect.objectContaining({
        sourceRecordId: "summary",
        role: "asset.primary-cover",
        acquisitionReference:
          "https://pixiv.pximg.net/fanbox/public/images/post/1739441/cover.jpeg",
      }),
    ]);
  });

  it("does not promote FANBOX image attachments to a primary cover", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/9135862";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          posts: [
            {
              id: "9135862",
              creatorId: "customudon",
              title: "年始の挨拶",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
              isRestricted: false,
            },
          ],
        },
      }),
      sourceRecord("detail", nativeAddress, "fanbox.post-detail", {
        body: {
          id: "9135862",
          creatorId: "customudon",
          publishedDatetime: "2025-01-01T00:11:17+09:00",
          title: "年始の挨拶",
          type: "article",
          isRestricted: false,
          body: {
            blocks: [{ type: "image", imageId: "preview" }],
            imageMap: {
              preview: {
                id: "preview",
                extension: "jpg",
                url: "https://downloads.fanbox.cc/images/post/preview.jpg",
              },
            },
          },
        },
      }),
    ];
    const evidence = directoryEvidence("/library/customudon/25.01.01 post");

    const [batch] = interpreter.interpret({ evidence, sourceRecords: records });

    expect(
      batch.sourceArtifacts.some((item) => item.role === "asset.primary-cover"),
    ).toBe(false);
    expect(batch.sourceArtifacts).toEqual([
      expect.objectContaining({
        role: "fanbox.attachment.image",
        acquisitionReference:
          "https://downloads.fanbox.cc/images/post/preview.jpg",
      }),
    ]);
  });

  it("does not project detail-owned business coordinates when only a public summary was retained", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/9135862";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          posts: [
            {
              id: "9135862",
              creatorId: "customudon",
              title: "年始の挨拶",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
              isRestricted: false,
            },
          ],
        },
      }),
    ];
    const evidence = directoryEvidence("/library/customudon/25.01.01 post");

    const [batch] = interpreter.interpret({ evidence, sourceRecords: records });

    expect(batch.metadata).toEqual([]);
  });

  it("does not preserve a creator-list excerpt as ordinary descriptive content", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/1739441";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          posts: [
            {
              id: "1739441",
              creatorId: "customudon",
              title: "今年も一年ありがとうございました。",
              publishedDatetime: "2020-12-29T19:08:45+09:00",
              isRestricted: false,
              excerpt: "新年まで残りわずかとなりました。試しに作った...",
            },
          ],
        },
      }),
    ];
    const evidence = directoryEvidence("/library/customudon/20.12.29 post");

    const [batch] = interpreter.interpret({ evidence, sourceRecords: records });

    expect(
      batch.metadata.some((item) => item.property === "asset.summary"),
    ).toBe(false);
    expect(
      batch.metadata.some((item) => item.property === "asset.preview"),
    ).toBe(false);
    expect(
      batch.metadata.some((item) => item.sourceSlot === "fanbox.post.excerpt"),
    ).toBe(false);
  });

  it("acquires only selected official image material", async () => {
    const acquirer = new FanboxArtifactAcquirer(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
    }));

    await expect(
      acquirer.acquire({
        id: "cover",
        sourceRecordId: "detail",
        role: "asset.primary-cover",
        acquisitionReference:
          "https://downloads.fanbox.cc/images/post/cover.jpg",
        mediaType: "image/jpeg",
      }),
    ).resolves.toMatchObject({
      candidateId: "cover",
      sourceRecordId: "detail",
    });
  });

  it("acquires an explicitly selected non-image attachment without closing the role vocabulary", async () => {
    const acquirer = new FanboxArtifactAcquirer(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "video/mp4" },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    }));

    await expect(
      acquirer.acquire({
        id: "attachment",
        sourceRecordId: "detail",
        role: "fanbox.attachment.future-material",
        acquisitionReference:
          "https://downloads.fanbox.cc/files/post/future.mp4",
        mediaType: "video/mp4",
      }),
    ).resolves.toMatchObject({
      candidateId: "attachment",
      sourceRecordId: "detail",
    });
  });
});

function sourceRecord(
  id: string,
  nativeAddress: string,
  coverage: string,
  body: unknown,
) {
  const retainedBody =
    coverage === "fanbox.post-detail" &&
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "body" in body &&
    body.body !== null &&
    typeof body.body === "object" &&
    !Array.isArray(body.body) &&
    !("post" in body.body)
      ? { body: { post: body.body } }
      : body;
  return {
    id,
    sourceIdentity: "fanbox",
    nativeAddress,
    mediaType: "application/json",
    acquiredAt: "2026-07-29T00:00:00.000Z",
    acquisition: {
      requestedAddress: `https://api.fanbox.cc/${coverage}`,
      method: "GET" as const,
      authorized: true,
    },
    coverage: {
      id: coverage,
      completeness: "complete" as const,
      authority: "official" as const,
    },
    digest: id.repeat(64).slice(0, 64),
    body: JSON.stringify(retainedBody),
  };
}

function jsonResponse(body: unknown) {
  const responseBody =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "body" in body &&
    body.body !== null &&
    typeof body.body === "object" &&
    !Array.isArray(body.body) &&
    "id" in body.body &&
    !("post" in body.body)
      ? { body: { post: body.body } }
      : body;
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(responseBody)).buffer,
  };
}

type ScriptedRequest = (
  address: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

function scriptedClosedGet(
  request: ScriptedRequest,
): Parameters<typeof createScriptedFanboxProductAssembly>[0] {
  return async ({ endpoint, privateContext }) => {
    let response: Awaited<ReturnType<ScriptedRequest>>;
    try {
      response = await request(fanboxEndpointAddress(endpoint), {
        headers:
          endpoint.kind === "post-detail" && endpoint.access === "public"
            ? { "User-Agent": privateContext.userAgent }
            : {
                Cookie: privateContext.cookies
                  .map((cookie) => `${cookie.name}=${cookie.value}`)
                  .join("; "),
                "User-Agent": privateContext.userAgent,
              },
      });
    } catch {
      throw new FanboxSessionTransportFault("network-failure");
    }
    const mediaType = response.headers.get("content-type");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const maximumBytes =
      endpoint.kind === "login-status" ? 1024 : 2 * 1024 * 1024;
    if (bytes.byteLength > maximumBytes)
      return { kind: "response-limit", status: response.status, mediaType };
    const rejectedNonJson =
      (response.status < 200 || response.status >= 300) &&
      mediaType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json";
    const normalized = rejectedNonJson
      ? new TextDecoder().decode(bytes).toLowerCase()
      : "";
    if (
      response.headers.get("cf-mitigated") === "challenge" ||
      normalized.includes("challenge-platform") ||
      normalized.includes("_cf_chl_opt") ||
      normalized.includes("cf-chl")
    )
      return {
        kind: "cloudflare-challenge",
        status: response.status,
        mediaType,
        cfMitigated:
          response.headers.get("cf-mitigated") === "challenge"
            ? "challenge"
            : null,
      };
    return {
      kind: "response",
      status: response.status,
      mediaType,
      body: bytes,
    };
  };
}

function scriptedCollector(options: {
  readonly creatorId?: string;
  readonly creatorIds?: () => readonly string[];
  readonly privateConfiguration?: string;
  readonly privateConfigurationForExecution?: (input: {
    readonly creatorId: string;
    readonly context: SourceCollectionExecutionContext | undefined;
  }) => string | undefined;
  readonly request?: ScriptedRequest;
}): SourceCollector {
  const assembly = createScriptedFanboxProductAssembly(
    scriptedClosedGet(
      options.request ??
        (async () => {
          throw new Error("unscripted FANBOX request");
        }),
    ),
  );
  return assembly.createCollector({
    creatorIds:
      options.creatorIds ??
      (() => (options.creatorId === undefined ? [] : [options.creatorId])),
    privateConfigurationForExecution:
      options.privateConfigurationForExecution ??
      (() => options.privateConfiguration),
  });
}

function collectorForDetail(input: {
  readonly type: string;
  readonly body: unknown;
  readonly publishedDatetime?: string;
}): SourceCollector {
  const publishedDatetime =
    input.publishedDatetime ?? "2025-01-01T00:11:17+09:00";
  return scriptedCollector({
    creatorId: "customudon",
    privateConfiguration: testPrivateConfiguration(
      "FANBOXSESSID=test-private-session",
    ),
    request: async (address) =>
      jsonResponse(
        address.includes("post.info")
          ? {
              body: {
                post: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "测试帖子",
                  publishedDatetime,
                  type: input.type,
                  body: input.body,
                },
              },
            }
          : {
              body: {
                posts: [
                  {
                    id: "9135862",
                    creatorId: "customudon",
                    title: "测试帖子",
                    publishedDatetime,
                  },
                ],
              },
            },
      ),
  });
}

function knownFanboxPostEvidence() {
  return {
    kind: "source-association" as const,
    sourceIdentity: "fanbox",
    sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
    explanation: "known",
    producer: knownSourceAssociationEvidenceCapability,
  };
}

function expectSummaryOnlyDetailFailure(
  result: Awaited<ReturnType<SourceCollector["collect"]>>,
): void {
  expect(result.records).toEqual([
    expect.objectContaining({
      coverage: expect.objectContaining({
        id: "fanbox.creator-post-summaries",
      }),
    }),
  ]);
  expect(result.failures).toEqual([
    expect.objectContaining({
      coverage: {
        sourceIdentity: "fanbox",
        nativeAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
        coverageId: "fanbox.post-detail",
      },
    }),
  ]);
  expect(JSON.stringify(result)).not.toContain("test-private-session");
}
