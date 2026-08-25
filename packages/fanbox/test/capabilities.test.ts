import { knownSourceAssociationEvidenceCapability } from "@digital/application";
import { describe, expect, it } from "vitest";

import {
  FanboxArtifactAcquirer,
  FanboxCollector,
  FanboxDateDirectoryInterpreter,
  FanboxExactRecognizer,
  FanboxSourceInterpreter,
  fanboxCreatorIdFromEvidence,
} from "../src/index.ts";

const snapshot = (root: string) => ({
  id: "snapshot",
  root,
  complete: true,
  excluded: [],
  files: [],
  observedAt: "2026-07-29T00:00:00.000Z",
});

describe("FANBOX creator date convention", () => {
  it("keeps channel and publication-date grammar inside the integration", () => {
    const interpreter = new FanboxDateDirectoryInterpreter("customudon");

    expect(
      interpreter.interpret(snapshot("/library/Custom Udon/24.03.07 ひみつ")),
    ).toMatchObject([
      {
        kind: "directory-convention",
        sourceIdentity: "fanbox",
      },
    ]);
    expect(interpreter.interpret(snapshot("/library/2024-03-07"))).toHaveLength(
      1,
    );
    expect(
      interpreter.interpret(snapshot("/library/24.13.07 invalid")),
    ).toEqual([]);
  });

  it("reads configured creator scopes when a later execution begins", () => {
    const creators = ["customudon"];
    const interpreter = new FanboxDateDirectoryInterpreter(() => creators);

    expect(
      interpreter
        .interpret(snapshot("/library/25.01.01 post"))
        .map((evidence) => evidence.sourceAddress),
    ).toEqual(["fanbox-directory:customudon:2025-01-01"]);
    creators.push("anothercreator");
    expect(
      interpreter
        .interpret(snapshot("/library/25.01.01 post"))
        .map((evidence) => evidence.sourceAddress),
    ).toEqual([
      "fanbox-directory:anothercreator:2025-01-01",
      "fanbox-directory:customudon:2025-01-01",
    ]);
  });
});

describe("FANBOX official collection", () => {
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
      producer: new FanboxDateDirectoryInterpreter("customudon").capability,
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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=top-secret",
      request: async (address) => {
        requested.push(address);
        const body = address.includes("post.listCreator")
          ? {
              body: {
                items: [
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

    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];
    const result = await collector.collect(evidence);

    expect(result.failures).toEqual([]);
    expect(result.records.map((record) => record.coverage.id)).toEqual([
      "fanbox.creator-post-summaries",
      "fanbox.post-detail",
    ]);
    expect(result.records).toHaveLength(2);
    expect(JSON.parse(result.records[1].body)).toMatchObject({
      body: {
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
    const collector = new FanboxCollector({
      creatorIds: () => ["customudon"],
      cookieHeaderForExecution: ({ creatorId, context }) =>
        creatorId === "customudon" &&
        context?.configurationReferences.includes(
          "source-connection/fanbox/customudon@1",
        ) === true
          ? `FANBOXSESSID=${privateSession}`
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
                        items: [
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
                        id: "9135862",
                        creatorId: "customudon",
                        title: "年始の挨拶",
                        publishedDatetime: "2025-01-01T00:11:17+09:00",
                        type: "text",
                        body: { text: "完整正文" },
                      },
                    },
              ),
            ).buffer,
        };
      },
    });
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    await expect(collector.collect(evidence)).resolves.toMatchObject({
      records: [],
      failures: [
        expect.objectContaining({
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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: secret,
      request: async () => {
        throw new Error(`HTTP 403 transport rejected ${secret}`);
      },
    });
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([]);
    expect(JSON.stringify(result.failures)).not.toContain("top-secret");
    expect(result.failures[0]?.reason).toContain("HTTP 403");
    expect(result.failures[0]?.reason).toContain("transport rejected");
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    for (const reflected of representations) {
      const collector = new FanboxCollector({
        creatorId: "customudon",
        cookieHeader: `FANBOXSESSID=${secret}`,
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

  it("does not retain an HTTP-success FANBOX error envelope as a complete source record", async () => {
    const privateSession = "fanbox-semantic-error-session";
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: `FANBOXSESSID=${privateSession}`,
      request: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        arrayBuffer: async () =>
          new TextEncoder().encode(
            JSON.stringify({ error: "not authorized", body: null }),
          ).buffer,
      }),
    });
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(privateSession);
  });

  it("rejects an HTTP-success non-JSON response before it can form source evidence", async () => {
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=non-json-semantic-session",
      request: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        arrayBuffer: async () =>
          new TextEncoder().encode('{"body":{"items":[]}}').buffer,
      }),
    });
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    await expect(collector.collect(evidence)).resolves.toMatchObject({
      records: [],
      failures: [expect.any(Object)],
    });
  });

  it("rejects a selected summary with an invalid official publication datetime before any source record forms", async () => {
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=invalid-summary-datetime-session",
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
                  items: [
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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=blank-summary-title-session",
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
                  items: [
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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=invalid-summary-offset-session",
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
                  items: [
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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=mismatched-datetime-session",
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
                  items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("rejects an invalid detail publication datetime before either source record forms", async () => {
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=invalid-detail-datetime-session",
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
                  items: [
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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=blank-detail-title-session",
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
                  items: [
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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=unicode-title-session",
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
                  items: [
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
    const batch = new FanboxSourceInterpreter().interpret({
      evidence: [evidence],
      sourceRecords: result.records,
    });

    expect(result.failures).toEqual([]);
    expect(result.records).toHaveLength(2);
    expect(batch.metadata).toContainEqual(
      expect.objectContaining({ property: "asset.title", value: title }),
    );
  });

  it("does not claim complete creator-summary coverage when the selected page exposes a next URL", async () => {
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=paged-summary-session",
      request: async (address) =>
        jsonResponse(
          address.includes("post.info")
            ? {
                body: {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "分页帖子",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                  type: "article",
                  body: { blocks: [{ type: "p", text: "正文" }] },
                },
              }
            : {
                body: {
                  items: [
                    {
                      id: "9135862",
                      creatorId: "customudon",
                      title: "分页帖子",
                      publishedDatetime: "2025-01-01T00:11:17+09:00",
                    },
                  ],
                  nextUrl:
                    "https://api.fanbox.cc/post.listCreator?creatorId=customudon&maxPublishedDatetime=2024-12-31T00%3A00%3A00%2B09%3A00",
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

    expect(result.failures).toEqual([]);
    expect(result.records[0]?.coverage).toMatchObject({
      id: "fanbox.creator-post-summaries",
      completeness: "incomplete",
    });
  });

  it("follows the official next URL until a known post is found on a later bounded summary page", async () => {
    const requested: string[] = [];
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=later-page-session",
      request: async (address) => {
        requested.push(address);
        if (address.includes("post.info"))
          return jsonResponse({
            body: {
              id: "9135862",
              creatorId: "customudon",
              title: "第二页帖子",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
              type: "article",
              body: { blocks: [{ type: "p", text: "正文" }] },
            },
          });
        if (address.includes("page=2"))
          return jsonResponse({
            body: {
              items: [
                {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "第二页帖子",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                },
              ],
            },
          });
        return jsonResponse({
          body: {
            items: [
              {
                id: "9135861",
                creatorId: "customudon",
                title: "首页其他帖子",
                publishedDatetime: "2025-01-02T00:11:17+09:00",
              },
            ],
            nextUrl:
              "https://api.fanbox.cc/post.listCreator?creatorId=customudon&page=2",
          },
        });
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
    expect(result.records).toHaveLength(2);
    expect(result.records[0]?.acquisition.requestedAddress).toContain("page=2");
    expect(requested).toHaveLength(3);
  });

  it("continues bounded creator-summary pagination to resolve a directory publication date on a later page", async () => {
    const requested: string[] = [];
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=later-date-page-session",
      request: async (address) => {
        requested.push(address);
        if (address.includes("post.info"))
          return jsonResponse({
            body: {
              id: "9135862",
              creatorId: "customudon",
              title: "第二页日期帖子",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
              type: "text",
              body: { text: "正文" },
            },
          });
        if (address.includes("page=2"))
          return jsonResponse({
            body: {
              items: [
                {
                  id: "9135862",
                  creatorId: "customudon",
                  title: "第二页日期帖子",
                  publishedDatetime: "2025-01-01T00:11:17+09:00",
                },
              ],
            },
          });
        return jsonResponse({
          body: {
            items: [
              {
                id: "9135861",
                creatorId: "customudon",
                title: "首页其他帖子",
                publishedDatetime: "2025-01-02T00:11:17+09:00",
              },
            ],
            nextUrl:
              "https://api.fanbox.cc/post.listCreator?creatorId=customudon&page=2",
          },
        });
      },
    });
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(result.failures).toEqual([]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]?.acquisition.requestedAddress).toContain("page=2");
    expect(requested).toHaveLength(3);
  });

  it("fails without source records when creator-summary pagination loops before the requested post is found", async () => {
    const requested: string[] = [];
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=summary-loop-session",
      request: async (address) => {
        requested.push(address);
        return jsonResponse({
          body: {
            items: [
              {
                id: "9135861",
                creatorId: "customudon",
                title: "其他帖子",
                publishedDatetime: "2025-01-02T00:11:17+09:00",
              },
            ],
            nextUrl:
              "https://api.fanbox.cc/post.listCreator?creatorId=customudon&limit=300",
          },
        });
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
    expect(result.failures[0]?.reason).toContain("repeated a next URL");
    expect(requested).toHaveLength(1);
  });

  it("rejects a successful summary whose addressed post belongs to another creator before a detail record can form", async () => {
    const requested: string[] = [];
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=semantic-summary-session",
      request: async (address) => {
        requested.push(address);
        return jsonResponse({
          body: {
            items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(requested).toHaveLength(1);
  });

  it("retains a valid summary but no fabricated detail record when the protected endpoint is structurally malformed", async () => {
    const details = [{ body: null }];
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    for (const detail of details) {
      const collector = new FanboxCollector({
        creatorId: "customudon",
        cookieHeader: "FANBOXSESSID=malformed-detail-session",
        request: async (address) =>
          jsonResponse(
            address.includes("post.info")
              ? detail
              : {
                  body: {
                    items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    for (const detail of details) {
      const collector = new FanboxCollector({
        creatorId: "customudon",
        cookieHeader: "FANBOXSESSID=semantic-detail-session",
        request: async (address) =>
          jsonResponse(
            address.includes("post.info")
              ? detail
              : {
                  body: {
                    items: [
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
    }
  });

  it("rejects an unrecognized official post form instead of claiming complete detail coverage", async () => {
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=unknown-form-session",
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
                  items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

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

  it("rejects a public article with no usable body instead of retaining a false complete detail record", async () => {
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=empty-article-body-session",
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
                  items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=empty-article-blocks-session",
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
                  items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=bad-article-attachment-session",
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
                  items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

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
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: `p_ab_id=8; FANBOXSESSID=${secret}`,
      request: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        arrayBuffer: async () =>
          new TextEncoder().encode(
            JSON.stringify({
              body: {
                items: [
                  {
                    id: "9135862",
                    publishedDatetime: "2025-01-01T00:11:17+09:00",
                    title: secret,
                  },
                ],
              },
            }),
          ).buffer,
      }),
    });
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(result.records).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.failures[0]?.reason).toContain("private configuration");
  });

  it("does not let short cookie values damage ordinary HTTP diagnostics", async () => {
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "p_ab_id=8; p_ab_id_2=2",
      request: async () => {
        throw new Error("HTTP 403 after 8 redirects");
      },
    });
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(result.failures[0]?.reason).toContain("HTTP 403 after 8 redirects");
    expect(JSON.stringify(result)).not.toContain("p_ab_id=8");
  });

  it("captures restricted post detail so its form remains sourced instead of inferred from the summary", async () => {
    let requests = 0;
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=private",
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
                        id: "7576910",
                        creatorId: "customudon",
                        title: "Movie | ひみつ",
                        publishedDatetime: "2024-03-07T22:55:32+09:00",
                        type: "file",
                        isRestricted: true,
                      },
                    }
                  : {
                      body: {
                        items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/24.03.07 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(requests).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.records.map((record) => record.coverage.id)).toEqual([
      "fanbox.creator-post-summaries",
      "fanbox.post-detail",
    ]);
    expect(result.records[1]?.coverage.completeness).toBe("incomplete");
  });

  it("retains the uniquely addressed summary when public detail transport is unavailable", async () => {
    let requests = 0;
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=private",
      request: async (address) => {
        requests += 1;
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
                  items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(requests).toBe(2);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.coverage.id).toBe(
      "fanbox.creator-post-summaries",
    );
    expect(result.failures[0]).toMatchObject({
      reason: expect.stringContaining("HTTP 403"),
      affects: {
        metadataProperties: [
          "fanbox.post.form",
          "asset.body",
          "fanbox.attachment.*",
        ],
        artifactRoles: ["fanbox.attachment.*"],
      },
    });
  });

  it("identifies a Cloudflare challenge on protected detail without retaining its page or credentials", async () => {
    const secret = "FANBOXSESSID=top-secret";
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: secret,
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
                      items: [
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    )[0];

    const result = await collector.collect(evidence);

    expect(result.records).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain("Cloudflare challenge");
    expect(result.failures[0]?.reason).toContain("browser clearance");
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(JSON.stringify(result)).not.toContain("challenge-platform");
  });

  it("reacquires a known FANBOX association without reinterpreting its directory", async () => {
    const collector = new FanboxCollector({
      creatorId: "customudon",
      cookieHeader: "FANBOXSESSID=private",
      request: async (address) => {
        const payload = address.includes("post.listCreator")
          ? {
              body: {
                items: [
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
                id: "9135862",
                creatorId: "customudon",
                title: "年始の挨拶",
                publishedDatetime: "2025-01-01T00:11:17+09:00",
                type: "text",
                body: { text: "完整正文" },
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
  it("fails closed for manually retained FANBOX records whose selected title is only whitespace", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/9135862";
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    );
    const recordSets = [
      [
        sourceRecord(
          "summary",
          nativeAddress,
          "fanbox.creator-post-summaries",
          {
            body: {
              items: [
                {
                  id: "9135862",
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
              items: [
                {
                  id: "9135862",
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
              items: [
                {
                  id: "9135862",
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
  });

  it("accepts a uniquely addressed summary while preserving protected detail as unavailable", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/7576910";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          items: [
            {
              id: "7576910",
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/24.03.07 post"),
    );

    expect(interpreter.canInterpret({ evidence, sourceRecords: records })).toBe(
      true,
    );
    const batch = interpreter.interpret({ evidence, sourceRecords: records });
    const proposal = new FanboxExactRecognizer().recognize({
      evidence,
      interpretation: batch,
    });

    expect(batch.sourceRecordIds).toEqual(["summary"]);
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "Movie | ひみつ",
          sourceRecordIds: ["summary"],
        }),
        expect.objectContaining({
          property: "asset.publication-datetime",
          value: "2024-03-07T22:55:32+09:00",
        }),
        expect.objectContaining({
          property: "fanbox.post.entitlement",
          value: "restricted",
        }),
      ]),
    );
    expect(
      batch.metadata.some((item) => item.property === "fanbox.post.form"),
    ).toBe(false);
    expect(batch.metadata.some((item) => item.property === "asset.body")).toBe(
      false,
    );
    expect(batch.sourceArtifacts).toEqual([
      expect.objectContaining({
        role: "asset.primary-cover",
        acquisitionReference:
          "https://pixiv.pximg.net/fanbox/public/images/post/7576910/cover.jpeg",
      }),
    ]);
    expect(proposal.ruleResults[0]?.outcome).toBe("satisfied");
  });

  it("projects a post and creator through open metadata and relationship contracts without inventing attachment artifacts", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/9135862";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: { items: [] },
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
              {
                type: "future-material",
                url: "https://downloads.fanbox.cc/files/post/future.bin",
              },
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
          },
        },
      }),
    ];
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    );

    const batch = interpreter.interpret({
      evidence,
      sourceRecords: records,
    });
    const proposal = new FanboxExactRecognizer().recognize({
      evidence,
      interpretation: batch,
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
        kind: "entity",
        sourceKey: "customudon",
        identityNamespace: "fanbox.creator",
        label: "Custom_Udon",
      },
    ]);
    expect(batch.relationships).toMatchObject([
      { role: "fanbox.post.creator" },
    ]);
    expect(batch.sourceArtifacts).toHaveLength(3);
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.body",
          value: "第一段\n\n第二段",
        }),
        expect.objectContaining({
          property: "fanbox.attachment.name",
          value: "bonus.mp4",
        }),
      ]),
    );
    expect(batch.sourceArtifacts.map((item) => item.role)).toEqual([
      "asset.primary-cover",
      "fanbox.attachment.file",
      "fanbox.attachment.future-material",
    ]);
    expect(proposal.ruleResults[0]?.outcome).toBe("satisfied");
    expect(batch.sourceArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "fanbox.attachment.file",
          acquisitionReference:
            "https://downloads.fanbox.cc/files/post/bonus.mp4",
        }),
        expect.objectContaining({
          role: "fanbox.attachment.future-material",
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
          items: [
            {
              id: "1739441",
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
          type: "article",
          isRestricted: false,
          body: { text: "今年もありがとうございました。" },
        },
      }),
    ];
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/20.12.29 post"),
    );

    const batch = interpreter.interpret({ evidence, sourceRecords: records });

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
          items: [
            {
              id: "9135862",
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
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    );

    const batch = interpreter.interpret({ evidence, sourceRecords: records });

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

  it("does not claim a public entitlement was verified when only its summary was retained", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/9135862";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          items: [
            {
              id: "9135862",
              title: "年始の挨拶",
              publishedDatetime: "2025-01-01T00:11:17+09:00",
              isRestricted: false,
            },
          ],
        },
      }),
    ];
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/25.01.01 post"),
    );

    const batch = interpreter.interpret({ evidence, sourceRecords: records });

    expect(batch.metadata).toContainEqual(
      expect.objectContaining({
        property: "fanbox.post.entitlement",
        value: "unverified",
      }),
    );
  });

  it("does not preserve a creator-list excerpt as ordinary descriptive content", () => {
    const interpreter = new FanboxSourceInterpreter();
    const nativeAddress = "https://www.fanbox.cc/@customudon/posts/1739441";
    const records = [
      sourceRecord("summary", nativeAddress, "fanbox.creator-post-summaries", {
        body: {
          items: [
            {
              id: "1739441",
              title: "今年も一年ありがとうございました。",
              publishedDatetime: "2020-12-29T19:08:45+09:00",
              isRestricted: false,
              excerpt: "新年まで残りわずかとなりました。試しに作った...",
            },
          ],
        },
      }),
    ];
    const evidence = new FanboxDateDirectoryInterpreter("customudon").interpret(
      snapshot("/library/20.12.29 post"),
    );

    const batch = interpreter.interpret({ evidence, sourceRecords: records });

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
    body: JSON.stringify(body),
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}

function collectorForDetail(input: {
  readonly type: string;
  readonly body: unknown;
  readonly publishedDatetime?: string;
}): FanboxCollector {
  const publishedDatetime =
    input.publishedDatetime ?? "2025-01-01T00:11:17+09:00";
  return new FanboxCollector({
    creatorId: "customudon",
    cookieHeader: "FANBOXSESSID=test-private-session",
    request: async (address) =>
      jsonResponse(
        address.includes("post.info")
          ? {
              body: {
                id: "9135862",
                creatorId: "customudon",
                title: "测试帖子",
                publishedDatetime,
                type: input.type,
                body: input.body,
              },
            }
          : {
              body: {
                items: [
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
  result: Awaited<ReturnType<FanboxCollector["collect"]>>,
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
