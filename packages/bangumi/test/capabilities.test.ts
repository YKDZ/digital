import { describe, expect, it } from "vitest";

import {
  BangumiCollector,
  BangumiEpisodicDirectoryInterpreter,
  BangumiEpisodicRecognizer,
  BangumiSourceInterpreter,
  createBangumiOAuthAuthorizationRequest,
  trustedBangumiEpisodicRule,
} from "../src/index.ts";

const snapshot = (files: readonly string[]) => ({
  id: "snapshot",
  root: "/corpus/葬送的芙莉莲 (2023)",
  complete: true,
  excluded: [],
  files: files.map((relativePath) => ({
    relativePath,
    size: 1,
    modifiedAt: "2026-07-30T00:00:00.000Z",
  })),
  observedAt: "2026-07-30T00:00:00.000Z",
});

const record = (id: string, coverage: string, body: unknown) => ({
  id,
  sourceIdentity: "bangumi",
  nativeAddress: "https://bgm.tv/subject/400602",
  mediaType: "application/json",
  acquiredAt: "2026-07-30T00:00:00.000Z",
  acquisition: {
    requestedAddress: `https://api.bgm.tv/v0/${coverage}`,
    method: "GET" as const,
    authorized: true,
  },
  coverage: {
    id: coverage,
    completeness: "complete" as const,
    authority: "official" as const,
  },
  digest: id,
  body: JSON.stringify(body),
});

const httpResponse = (body: string, mediaType: string) => ({
  ok: true,
  status: 200,
  headers: { get: () => mediaType },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

describe("Bangumi OAuth authorization-code protocol", () => {
  it("builds the official authorization request with the exact callback and CSRF state", () => {
    const authorization = createBangumiOAuthAuthorizationRequest({
      clientId: "digital-client",
      redirectUri:
        "https://digital.example.test/api/source-connections/bangumi/callback",
      state: "secure-state-value",
    });

    const address = new URL(authorization);
    expect(address.origin + address.pathname).toBe(
      "https://bgm.tv/oauth/authorize",
    );
    expect(Object.fromEntries(address.searchParams)).toEqual({
      client_id: "digital-client",
      redirect_uri:
        "https://digital.example.test/api/source-connections/bangumi/callback",
      response_type: "code",
      state: "secure-state-value",
    });
  });
});

describe("Bangumi episodic directory convention", () => {
  it("plans one ordinary observed episode per boundary and rejects Season 0", () => {
    const interpreter = new BangumiEpisodicDirectoryInterpreter();
    const plan = interpreter.interpret(
      snapshot([
        "Season 1/葬送的芙莉莲 - S01E01.mkv",
        "Season 2/葬送的芙莉莲 - S02E01 - 第 1 集.mkv",
        "Season 0/葬送的芙莉莲 - S00E01.mkv",
        "Season 1/葬送的芙莉莲 - S01E02 - NCOP.mkv",
        "Season 1/葬送的芙莉莲 - S01E03 - 第 2 集.mkv",
      ]),
    );
    expect(plan.workItems.map((item) => item.key)).toEqual([
      "bangumi:season-1:episode-1",
      "bangumi:season-2:episode-1",
    ]);
    expect(plan.workItems.flatMap((item) => item.relativePaths)).toEqual([
      "Season 1/葬送的芙莉莲 - S01E01.mkv",
      "Season 2/葬送的芙莉莲 - S02E01 - 第 1 集.mkv",
    ]);
    expect(plan.workItems[0]?.evidence[0]?.explanation).toContain("v1");
  });

  it("requires one exact source-name/year root and a unique sequel path", () => {
    const plan = new BangumiEpisodicDirectoryInterpreter().interpret(
      snapshot(["Season 2/葬送的芙莉莲 - S02E01 - 第 1 集.mkv"]),
    );
    const evidence = plan.workItems[0]!.evidence;
    const records = [
      record("s1", "bangumi.subject:400602", {
        id: 400602,
        type: 2,
        name: "葬送のフリーレン",
        name_cn: "葬送的芙莉莲",
        date: "2023-09-29",
        summary: "subject",
      }),
      record("r1", "bangumi.relationships:400602", [
        {
          id: 515759,
          relation: "续集",
          name: "葬送のフリーレン 第2期",
          name_cn: "葬送的芙莉莲 第二季",
          type: 2,
        },
      ]),
      record("s2", "bangumi.subject:515759", {
        id: 515759,
        type: 2,
        name: "葬送のフリーレン 第2期",
        name_cn: "葬送的芙莉莲 第二季",
        date: "2026-01-16",
        summary: "season two",
        images: { large: "https://lain.bgm.tv/pic/cover/l/cover.jpg" },
      }),
      record("e2", "bangumi.ordinary-episodes:515759:0", {
        total: 10,
        limit: 100,
        offset: 0,
        data: [
          {
            id: 1575936,
            subject_id: 515759,
            type: 0,
            sort: 29,
            ep: 1,
            name: "旅立ち",
            name_cn: "启程",
            desc: "episode",
            airdate: "2026-01-16",
          },
        ],
      }),
    ];
    const batch = new BangumiSourceInterpreter().interpret({
      evidence,
      sourceRecords: records,
    });
    const proposal = new BangumiEpisodicRecognizer().recognize({
      evidence,
      interpretation: batch,
    });
    expect(batch.sourceAddress).toBe("https://bgm.tv/episode/1575936");
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "bangumi.episode.season-position",
          value: "1",
        }),
        expect.objectContaining({
          property: "bangumi.episode.continuous-position",
          value: "29",
        }),
        expect.objectContaining({ property: "asset.title", value: "旅立ち" }),
        expect.objectContaining({
          property: "asset.title.zh-hans",
          value: "启程",
        }),
        expect.objectContaining({
          property: "bangumi.subject.name",
          value: "葬送のフリーレン 第2期",
          subjectId: expect.any(String),
        }),
      ]),
    );
    expect(batch.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKey: "515759",
          identityNamespace: "bangumi.subject",
        }),
      ]),
    );
    expect(batch.sourceArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "asset.primary-cover",
          subjectId: expect.any(String),
        }),
      ]),
    );
    expect(batch.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "bangumi.subject.related",
          subjectId: expect.any(String),
          participantId: expect.any(String),
        }),
      ]),
    );
    expect(proposal.ruleResults[0]).toMatchObject({
      ...trustedBangumiEpisodicRule,
      outcome: "satisfied",
    });
  });

  it("projects every official relation along one unique compatible Season 3 path", () => {
    const evidence = new BangumiEpisodicDirectoryInterpreter().interpret(
      snapshot(["Season 3/葬送的芙莉莲 - S03E01.mkv"]),
    ).workItems[0]!.evidence;
    const records = [
      record("s1", "bangumi.subject:400602", {
        id: 400602,
        type: 2,
        name: "葬送のフリーレン",
        name_cn: "葬送的芙莉莲",
        date: "2023-09-29",
      }),
      record("r1", "bangumi.relationships:400602", [
        { id: 515759, relation: "续集" },
      ]),
      record("s2", "bangumi.subject:515759", {
        id: 515759,
        type: 2,
        name: "葬送のフリーレン 第2期",
        date: "2026-01-16",
      }),
      record("r2", "bangumi.relationships:515759", [
        { id: 700003, relation: "续集" },
      ]),
      record("e2", "bangumi.ordinary-episodes:515759:0", {
        total: 1,
        data: [
          {
            id: 1575936,
            subject_id: 515759,
            type: 0,
            sort: 29,
            ep: 1,
            name: "第二季第一集",
          },
        ],
      }),
      record("s3", "bangumi.subject:700003", {
        id: 700003,
        type: 2,
        name: "葬送のフリーレン 第3期",
        date: "2027-01-16",
      }),
      record("e3", "bangumi.ordinary-episodes:700003:0", {
        total: 1,
        data: [
          {
            id: 1700003,
            subject_id: 700003,
            type: 0,
            sort: 39,
            ep: 1,
            name: "第三季第一集",
          },
        ],
      }),
    ];

    const batch = new BangumiSourceInterpreter().interpret({
      evidence,
      sourceRecords: records,
    });

    expect(batch.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceSlot: "bangumi.subject.sequel:400602:515759",
        }),
        expect.objectContaining({
          sourceSlot: "bangumi.subject.sequel:515759:700003",
        }),
      ]),
    );
  });

  it("leaves a branching sequel path unresolved instead of using response order", () => {
    const evidence = new BangumiEpisodicDirectoryInterpreter().interpret(
      snapshot(["Season 2/葬送的芙莉莲 - S02E01.mkv"]),
    ).workItems[0]!.evidence;
    const records = [
      record("s1", "bangumi.subject:400602", {
        id: 400602,
        type: 2,
        name: "葬送のフリーレン",
        name_cn: "葬送的芙莉莲",
        date: "2023-09-29",
      }),
      record("r1", "bangumi.relationships:400602", [
        { id: 515759, relation: "续集" },
        { id: 999, relation: "续集" },
      ]),
    ];
    expect(() =>
      new BangumiSourceInterpreter().interpret({
        evidence,
        sourceRecords: records,
      }),
    ).toThrow("unique compatible");
  });

  it("filters incompatible captured sequel candidates before requiring one path", () => {
    const evidence = new BangumiEpisodicDirectoryInterpreter().interpret(
      snapshot(["Season 2/葬送的芙莉莲 - S02E01.mkv"]),
    ).workItems[0]!.evidence;
    const records = [
      record("s1", "bangumi.subject:400602", {
        id: 400602,
        type: 2,
        name: "葬送のフリーレン",
        name_cn: "葬送的芙莉莲",
        date: "2023-09-29",
      }),
      record("r1", "bangumi.relationships:400602", [
        { id: 515759, relation: "续集" },
        { id: 999, relation: "续集" },
      ]),
      record("s2", "bangumi.subject:515759", {
        id: 515759,
        type: 2,
        name: "葬送のフリーレン 第2期",
        date: "2026-01-16",
      }),
      record("e2", "bangumi.ordinary-episodes:515759:0", {
        total: 1,
        data: [
          {
            id: 1575936,
            subject_id: 515759,
            type: 0,
            sort: 29,
            ep: 1,
            name: "旅立ち",
          },
        ],
      }),
      record("other", "bangumi.subject:999", {
        id: 999,
        type: 1,
        name: "not an ordinary work",
        date: "2026-01-16",
      }),
    ];
    expect(
      new BangumiSourceInterpreter().interpret({
        evidence,
        sourceRecords: records,
      }),
    ).toMatchObject({ sourceAddress: "https://bgm.tv/episode/1575936" });
  });

  it("captures each official endpoint independently and never retains its bearer", async () => {
    const requested: string[] = [];
    const collector = new BangumiCollector({
      authorization: {
        async bearer() {
          return "private-grant";
        },
      },
      async request(address, init) {
        requested.push(`${init?.method ?? "GET"} ${address}`);
        const body = address.endsWith("/search/subjects")
          ? {
              data: [
                {
                  id: 243981,
                  name: "やがて君になる",
                  name_cn: "终将成为你",
                  date: "2018-10-05",
                },
              ],
            }
          : address.endsWith("/subjects/243981")
            ? {
                id: 243981,
                name: "やがて君になる",
                name_cn: "终将成为你",
                date: "2018-10-05",
              }
            : address.endsWith("/subjects/243981/subjects")
              ? []
              : {
                  total: 1,
                  data: [
                    {
                      id: 831401,
                      subject_id: 243981,
                      type: 0,
                      sort: 1,
                      ep: 1,
                      name: "我喜欢你",
                    },
                  ],
                };
        return httpResponse(JSON.stringify(body), "application/json");
      },
    });
    const evidence = new BangumiEpisodicDirectoryInterpreter().interpret({
      ...snapshot(["Season 1/终将成为你 - S01E01.mkv"]),
      root: "/corpus/终将成为你 (2018)",
    }).workItems[0]!.evidence[0]!;
    const result = await collector.collect(evidence);
    expect(result.failures).toEqual([]);
    expect(requested).toEqual(
      expect.arrayContaining([
        "POST https://api.bgm.tv/v0/search/subjects",
        "GET https://api.bgm.tv/v0/subjects/243981",
        "GET https://api.bgm.tv/v0/subjects/243981/subjects",
        "GET https://api.bgm.tv/v0/episodes?subject_id=243981&type=0&limit=100&offset=0",
      ]),
    );
    expect(result.records.map((item) => item.coverage.id)).toEqual([
      "bangumi.subject-search",
      "bangumi.subject:243981",
      "bangumi.relationships:243981",
      "bangumi.ordinary-episodes:243981:0",
      "bangumi.episode:831401",
    ]);
    expect(JSON.stringify(result.records)).not.toContain("private-grant");
    expect(result.records[0]?.acquisition.method).toBe("POST");
  });

  it("collects a Season 3 path by path depth despite an earlier branch and cycle", async () => {
    const requested: string[] = [];
    const collector = new BangumiCollector({
      async request(address) {
        requested.push(address);
        const subjectId = /\/subjects\/(\d+)(?:\/subjects)?$/u.exec(
          address,
        )?.[1];
        const relationshipId = /\/subjects\/(\d+)\/subjects$/u.exec(
          address,
        )?.[1];
        const episodeSubject = /subject_id=(\d+)/u.exec(address)?.[1];
        const body = address.endsWith("/search/subjects")
          ? {
              data: [
                {
                  id: 1,
                  type: 2,
                  name: "葬送的芙莉莲",
                  date: "2023-09-29",
                },
              ],
            }
          : relationshipId === "1"
            ? [
                { id: 9, relation: "续集" },
                { id: 2, relation: "续集" },
              ]
            : relationshipId === "2"
              ? [{ id: 3, relation: "续集" }]
              : relationshipId === "3"
                ? [{ id: 1, relation: "续集" }]
                : relationshipId === "9"
                  ? []
                  : subjectId === undefined
                    ? {
                        total: 1,
                        data: [
                          {
                            id: 100 + Number(episodeSubject),
                            subject_id: Number(episodeSubject),
                            type: 0,
                            sort: 1,
                            ep: 1,
                            name: "ordinary",
                          },
                        ],
                      }
                    : {
                        id: Number(subjectId),
                        type: 2,
                        name:
                          subjectId === "1"
                            ? "葬送的芙莉莲"
                            : `Season ${subjectId}`,
                        date: "2023-09-29",
                      };
        return httpResponse(JSON.stringify(body), "application/json");
      },
    });
    const evidence = new BangumiEpisodicDirectoryInterpreter().interpret(
      snapshot(["Season 3/葬送的芙莉莲 - S03E01.mkv"]),
    ).workItems[0]!.evidence[0]!;

    const result = await collector.collect(evidence);

    expect(result.failures).toEqual([]);
    expect(result.records.map((item) => item.coverage.id)).toEqual(
      expect.arrayContaining([
        "bangumi.subject:1",
        "bangumi.subject:2",
        "bangumi.subject:3",
        "bangumi.subject:9",
      ]),
    );
    expect(
      requested.filter((address) => address.endsWith("/subjects/1")),
    ).toHaveLength(1);
  });

  it("does not resolve a Season 4 request by following a 1 → 2 → 3 → 1 cycle", async () => {
    const requested: string[] = [];
    const collector = new BangumiCollector({
      async request(address) {
        requested.push(address);
        const subjectId = /\/subjects\/(\d+)(?:\/subjects)?$/u.exec(
          address,
        )?.[1];
        const relationshipId = /\/subjects\/(\d+)\/subjects$/u.exec(
          address,
        )?.[1];
        const episodeSubject = /subject_id=(\d+)/u.exec(address)?.[1];
        const body = address.endsWith("/search/subjects")
          ? {
              data: [
                {
                  id: 1,
                  type: 2,
                  name: "葬送的芙莉莲",
                  date: "2023-09-29",
                },
              ],
            }
          : relationshipId !== undefined
            ? [
                {
                  id:
                    relationshipId === "1" ? 2 : relationshipId === "2" ? 3 : 1,
                  relation: "续集",
                },
              ]
            : episodeSubject !== undefined
              ? {
                  total: 1,
                  data: [
                    {
                      id: 100 + Number(episodeSubject),
                      subject_id: Number(episodeSubject),
                      type: 0,
                      sort: 1,
                      ep: 1,
                      name: "ordinary",
                    },
                  ],
                }
              : {
                  id: Number(subjectId),
                  type: 2,
                  name:
                    subjectId === "1" ? "葬送的芙莉莲" : `Season ${subjectId}`,
                  date: "2023-09-29",
                };
        return httpResponse(JSON.stringify(body), "application/json");
      },
    });
    const evidence = new BangumiEpisodicDirectoryInterpreter().interpret(
      snapshot(["Season 4/葬送的芙莉莲 - S04E01.mkv"]),
    ).workItems[0]!.evidence[0]!;

    const result = await collector.collect(evidence);

    expect(result.failures).toEqual([]);
    expect(
      requested.filter((address) => address.endsWith("/subjects/1")),
    ).toHaveLength(1);
    expect(
      result.records.filter((item) => item.coverage.id === "bangumi.subject:1"),
    ).toHaveLength(1);
    expect(() =>
      new BangumiSourceInterpreter().interpret({
        evidence: [evidence],
        sourceRecords: result.records,
      }),
    ).toThrow("unique compatible");
  });

  it("refreshes an accepted episode through its associated source address without re-recognizing it", async () => {
    const collector = new BangumiCollector({
      async request(address) {
        expect(address).toBe("https://api.bgm.tv/v0/episodes/831401");
        return httpResponse(
          JSON.stringify({
            id: 831401,
            subject_id: 243981,
            type: 0,
            sort: 1,
            ep: 1,
            name: "我喜欢你",
            name_cn: "我喜欢你",
            desc: "更新后的单集简介",
            airdate: "2018-10-05",
          }),
          "application/json",
        );
      },
    });
    const evidence = {
      kind: "source-association",
      sourceIdentity: "bangumi",
      sourceAddress: "https://bgm.tv/episode/831401",
      explanation: "当前来源关联",
      producer: {
        capabilityId: "application.known-source-association",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    } as const;
    expect(collector.coverageScopeIds(evidence)).toEqual([
      "bangumi.episode:831401",
    ]);
    const collected = await collector.collect(evidence);
    expect(collected.failures).toEqual([]);
    const batch = new BangumiSourceInterpreter().interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });
    expect(batch).toMatchObject({
      sourceAddress: evidence.sourceAddress,
      sourceArtifacts: [],
      entities: [],
      relationships: [],
      metadata: expect.arrayContaining([
        expect.objectContaining({
          property: "asset.description",
          value: "更新后的单集简介",
        }),
      ]),
    });
  });

  it("retains completed bounded records when a later official endpoint fails", async () => {
    const collector = new BangumiCollector({
      async request(address) {
        if (address.endsWith("/subjects/243981/subjects"))
          throw new Error("network interrupted");
        const body = address.endsWith("/search/subjects")
          ? {
              data: [
                {
                  id: 243981,
                  name: "やがて君になる",
                  name_cn: "终将成为你",
                  date: "2018-10-05",
                },
              ],
            }
          : {
              id: 243981,
              name: "やがて君になる",
              name_cn: "终将成为你",
              date: "2018-10-05",
            };
        return httpResponse(JSON.stringify(body), "application/json");
      },
    });
    const evidence = new BangumiEpisodicDirectoryInterpreter().interpret({
      ...snapshot(["Season 1/终将成为你 - S01E01.mkv"]),
      root: "/corpus/终将成为你 (2018)",
    }).workItems[0]!.evidence[0]!;
    const result = await collector.collect(evidence);
    expect(result.records.map((item) => item.coverage.id)).toEqual([
      "bangumi.subject-search",
      "bangumi.subject:243981",
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("network interrupted"),
      }),
    ]);
  });
});
