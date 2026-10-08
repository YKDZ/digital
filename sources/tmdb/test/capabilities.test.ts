import { createHash } from "node:crypto";

import { prerequisiteUnavailableFailure } from "@digital/application";
import { describe, expect, it } from "vitest";

import {
  TmdbArtifactAcquirer,
  TmdbCollector,
  TmdbSourceInterpreter,
  TmdbSourceAddressing,
  TmdbStrictFilmDirectoryInterpreter,
  TmdbStrictFilmRecognizer,
  trustedTmdbDirectedFilmRule,
  trustedTmdbStrictFilmRule,
} from "../src/index.ts";

describe("TMDB 明确电影输入", () => {
  const addressing = new TmdbSourceAddressing();

  it("将电影编号和规范电影页归一为同一来源地址", () => {
    expect(addressing.normalize({ movie: "9509" })).toMatchObject({
      status: "accepted",
      normalizedInput: {
        movie: "https://www.themoviedb.org/movie/9509",
      },
      evidence: {
        sourceIdentity: "tmdb",
        sourceAddress: "https://www.themoviedb.org/movie/9509",
      },
    });
    expect(
      addressing.normalize({
        movie: "https://www.themoviedb.org/movie/9509",
      }),
    ).toMatchObject({
      status: "accepted",
      evidence: {
        sourceAddress: "https://www.themoviedb.org/movie/9509",
      },
    });
  });

  it("拒绝未知字段和非电影地址", () => {
    expect(addressing.normalize({ id: "9509" })).toMatchObject({
      status: "invalid",
    });
    expect(
      addressing.normalize({ movie: "https://example.com/movie/9509" }),
    ).toMatchObject({ status: "invalid" });
  });
});

const snapshot = (root: string, directories: readonly string[] = []) => ({
  id: "snapshot",
  root,
  complete: true,
  excluded: [],
  files: [
    {
      relativePath: "content.bin",
      size: 1,
      modifiedAt: "2026-07-31T00:00:00.000Z",
    },
  ],
  directories: directories.map((relativePath) => ({
    relativePath,
    modifiedAt: "2026-07-31T00:00:00.000Z",
  })),
  observedAt: "2026-07-31T00:00:00.000Z",
});

/** 目录解释器交出工作项计划；既有调用只消费计划内的规范根证据。 */
function filmEvidence(root: string, directories: readonly string[] = []) {
  const plan = new TmdbStrictFilmDirectoryInterpreter().interpret(
    snapshot(root, directories),
  );
  if (!("workItems" in plan))
    throw new Error("TMDB 目录约定没有形成工作项计划");
  return plan.workItems.flatMap((workItem) => workItem.evidence);
}

describe("TMDB strict film directory convention", () => {
  it("accepts only one exact title, ASCII space, and four-digit ASCII year", () => {
    const interpreter = new TmdbStrictFilmDirectoryInterpreter();

    expect(
      interpreter.interpret(snapshot("/library/恐怖直播 (2013)")),
    ).toMatchObject({
      workItems: [
        {
          evidence: [
            {
              kind: "directory-convention",
              sourceIdentity: "tmdb",
              sourceAddress:
                "tmdb-search:%E6%81%90%E6%80%96%E7%9B%B4%E6%92%AD:2013",
            },
          ],
        },
      ],
    });
    for (const invalid of [
      "/library/恐怖直播(2013)",
      "/library/恐怖直播  (2013)",
      "/library/恐怖直播 （2013）",
      "/library/恐怖直播 (13)",
      "/library/恐怖直播 (2013) 1080p",
      "/library/[怒火救援].Man.on.Fire.2004.Blu-ray",
    ]) {
      expect(interpreter.interpret(snapshot(invalid))).toEqual([]);
    }
  });

  it("does not interpret an episodic root with a direct strict Season directory as a film", () => {
    const interpreter = new TmdbStrictFilmDirectoryInterpreter();

    expect(
      interpreter.interpret(
        snapshot("/library/葬送的芙莉莲 (2023)", [
          ".",
          "Season 1",
          "Season 2",
          "Season 1/extras",
        ]),
      ),
    ).toEqual([]);
    expect(
      interpreter.interpret(snapshot("/library/恐怖直播 (2013)")),
    ).toMatchObject({ workItems: [expect.anything()] });
    expect(
      interpreter.interpret(
        snapshot("/library/恐怖直播 (2013)", [
          ".",
          "extras/Season 1",
          "Season 1 extras",
          "season 1",
        ]),
      ),
    ).toMatchObject({ workItems: [expect.anything()] });
  });
});

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  arrayBuffer: async () =>
    new TextEncoder().encode(JSON.stringify(body)).buffer,
});

describe("TMDB collection and interpretation", () => {
  it("retries a bounded transient official movie request inside the source capability", async () => {
    let detailAttempts = 0;
    const collector = new TmdbCollector({
      accessToken: "private-token",
      delay: async () => {},
      request: async (address) => {
        const pathname = new URL(address).pathname;
        if (pathname.endsWith("/credits"))
          return jsonResponse({ id: 9509, crew: [], cast: [] });
        if (pathname.endsWith("/translations"))
          return jsonResponse({ id: 9509, translations: [] });
        detailAttempts += 1;
        if (detailAttempts === 1)
          throw new TypeError("temporary transport failure");
        return jsonResponse({
          id: 9509,
          title: "怒火救援",
          release_date: "2004-04-23",
          genres: [],
        });
      },
    });

    const result = await collector.collect({
      kind: "directed-source-address",
      sourceIdentity: "tmdb",
      sourceAddress: "https://www.themoviedb.org/movie/9509",
      explanation: "directed",
      producer: {
        capabilityId: "application.directed-recognition",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    });

    expect(result.failures).toEqual([]);
    expect(detailAttempts).toBe(2);
  });

  it("publishes the upgraded collection and interpretation coordinates without changing the recognition rule coordinate", () => {
    expect(new TmdbCollector().capability).toEqual({
      capabilityId: "tmdb.official-film-collection",
      capabilityVersion: "3",
      contractVersion: "2",
      identity: "tmdb.official-film-collection",
      implementationVersion: "3",
      kind: "source-collector",
      interpretationContractVersions: ["2"],
    });
    expect(new TmdbSourceInterpreter().capability).toEqual({
      capabilityId: "tmdb.film-interpretation",
      capabilityVersion: "2",
      contractVersion: "2",
      identity: "tmdb.film-interpretation",
      implementationVersion: "2",
      kind: "source-interpreter",
      interpretationContractVersions: ["2"],
    });
    expect(new TmdbStrictFilmRecognizer().capability).toEqual({
      capabilityId: "tmdb.strict-film-recognizer",
      capabilityVersion: "2",
      contractVersion: "1",
      identity: "tmdb.strict-film-recognizer",
      implementationVersion: "2",
      kind: "recognizer",
      interpretationContractVersions: ["1"],
    });
  });

  it("uses the official release-year query and collects every declared search page before interpreting identity", async () => {
    const requested: URL[] = [];
    const collector = new TmdbCollector({
      accessToken: "private-token",
      delay: async () => {},
      request: async (address) => {
        const url = new URL(address);
        requested.push(url);
        if (url.pathname.endsWith("/search/movie")) {
          expect(url.searchParams.get("primary_release_year")).toBe("2013");
          expect(url.searchParams.has("year")).toBe(false);
          return jsonResponse(
            url.searchParams.get("page") === "2"
              ? {
                  page: 2,
                  total_pages: 2,
                  results: [{ id: 209764 }],
                }
              : {
                  page: 1,
                  total_pages: 2,
                  results: [{ id: 100 }],
                },
          );
        }
        if (url.pathname.endsWith("/credits"))
          return jsonResponse({ id: 209764, crew: [], cast: [] });
        if (url.pathname.endsWith("/translations"))
          return jsonResponse({ id: 209764, translations: [] });
        const id = Number(url.pathname.split("/").at(-1));
        return jsonResponse({
          id,
          title: id === 209764 ? "恐怖直播" : "另一个作品",
          release_date: "2013-07-31",
          genres: [],
        });
      },
    });
    const evidence = filmEvidence("/library/恐怖直播 (2013)");

    const collected = await collector.collect(evidence[0]);
    const [interpreted] = new TmdbSourceInterpreter().interpret({
      evidence,
      sourceRecords: collected.records,
    });

    expect(collected.failures).toEqual([]);
    expect(collected.records.map((record) => record.coverage.id)).toEqual([
      "tmdb.search.page.1",
      "tmdb.search.page.2",
      "tmdb.movie",
      "tmdb.movie",
      "tmdb.credits.directors",
      "tmdb.credits",
      "tmdb.translations",
    ]);
    expect(
      requested
        .filter((url) => url.pathname.endsWith("/search/movie"))
        .map((url) => url.searchParams.get("page")),
    ).toEqual(["1", "2"]);
    expect(interpreted.sourceAddress).toBe(
      "https://www.themoviedb.org/movie/209764",
    );
  });

  it("retains official localized titles from the independent translations record without weakening strict title matching", async () => {
    const collector = new TmdbCollector({
      accessToken: "private-token",
      request: async (address) => {
        const url = new URL(address);
        if (url.pathname.endsWith("/search/movie"))
          return jsonResponse({
            page: 1,
            total_pages: 1,
            results: [{ id: 209764 }],
          });
        if (url.pathname.endsWith("/translations"))
          return jsonResponse({
            id: 209764,
            translations: [
              {
                iso_639_1: "en",
                iso_3166_1: "US",
                data: { title: "The Terror Live" },
              },
            ],
          });
        if (url.pathname.endsWith("/credits"))
          return jsonResponse({ id: 209764, crew: [], cast: [] });
        return jsonResponse({
          id: 209764,
          title: "恐怖直播",
          original_title: "더 테러 라이브",
          release_date: "2013-07-31",
          genres: [],
          alternative_titles: { titles: [{ title: "The Terror, LIVE" }] },
        });
      },
    });
    const evidence = filmEvidence("/library/恐怖直播 (2013)");

    const collection = await collector.collect(evidence[0]);
    const [interpreted] = new TmdbSourceInterpreter().interpret({
      evidence,
      sourceRecords: collection.records,
    });

    const translation = collection.records.find(
      (record) => record.coverage.id === "tmdb.translations",
    );
    expect(translation).toBeDefined();
    expect(interpreted.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title.alternative",
          value: "The Terror Live",
          sourceRecordIds: [translation?.id],
          sourceSlot: "tmdb.translations.title.0",
          qualifiers: [
            { key: "language", value: "en" },
            { key: "region", value: "US" },
          ],
        }),
      ]),
    );
  });

  it("retains a mismatched translations response for audit without admitting it into title interpretation lineage", async () => {
    const collector = new TmdbCollector({
      accessToken: "private-token",
      request: async (address) => {
        const url = new URL(address);
        if (url.pathname.endsWith("/search/movie"))
          return jsonResponse({
            page: 1,
            total_pages: 1,
            results: [{ id: 209764 }],
          });
        if (url.pathname.endsWith("/translations"))
          return jsonResponse({
            id: 999999,
            translations: [
              {
                iso_639_1: "en",
                iso_3166_1: "US",
                data: { title: "Must not be interpreted" },
              },
            ],
          });
        if (url.pathname.endsWith("/credits"))
          return jsonResponse({ id: 209764, crew: [], cast: [] });
        return jsonResponse({
          id: 209764,
          title: "恐怖直播",
          release_date: "2013-07-31",
          genres: [],
        });
      },
    });
    const evidence = filmEvidence("/library/恐怖直播 (2013)");

    const collection = await collector.collect(evidence[0]);
    const [interpreted] = new TmdbSourceInterpreter().interpret({
      evidence,
      sourceRecords: collection.records,
    });
    const rejectedTranslation = collection.records.find(
      (record) => record.coverage.id === "tmdb.translations.subject-mismatch",
    );

    expect(rejectedTranslation).toMatchObject({
      coverage: {
        id: "tmdb.translations.subject-mismatch",
        completeness: "incomplete",
        authority: "official",
      },
    });
    expect(collection.failures).toEqual([
      expect.objectContaining({
        affects: { metadataProperties: ["asset.title.alternative"] },
      }),
    ]);
    expect(interpreted.sourceRecordIds).not.toContain(rejectedTranslation?.id);
    expect(interpreted.metadata).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "Must not be interpreted" }),
      ]),
    );
  });

  it("does not declare a unique identity when another exact candidate appears on a later search page", async () => {
    let creditsRequested = false;
    const collector = new TmdbCollector({
      accessToken: "private-token",
      request: async (address) => {
        const url = new URL(address);
        if (url.pathname.endsWith("/search/movie"))
          return jsonResponse({
            page: Number(url.searchParams.get("page")),
            total_pages: 2,
            results: [
              {
                id: url.searchParams.get("page") === "2" ? 209765 : 209764,
              },
            ],
          });
        if (url.pathname.endsWith("/credits")) {
          creditsRequested = true;
          return jsonResponse({ id: 209764, crew: [], cast: [] });
        }
        const id = Number(url.pathname.split("/").at(-1));
        return jsonResponse({
          id,
          title: "恐怖直播",
          release_date: "2013-07-31",
          genres: [],
        });
      },
    });
    const evidence = filmEvidence("/library/恐怖直播 (2013)");

    const collected = await collector.collect(evidence[0]);

    expect(
      new TmdbSourceInterpreter().canInterpret({
        evidence,
        sourceRecords: collected.records,
      }),
    ).toBe(false);
    expect(creditsRequested).toBe(false);
  });

  it("treats TMDB's page-one zero-results pagination as unresolved instead of failed", async () => {
    const requested: URL[] = [];
    const collector = new TmdbCollector({
      accessToken: "private-token",
      request: async (address) => {
        const url = new URL(address);
        requested.push(url);
        return jsonResponse({
          page: 1,
          total_pages: 0,
          total_results: 0,
          results: [],
        });
      },
    });
    const evidence = filmEvidence("/library/不存在的作品 (2013)");

    const collected = await collector.collect(evidence[0]);

    expect(collected.failures).toEqual([]);
    expect(collected.records.map((record) => record.coverage.id)).toEqual([
      "tmdb.search.page.1",
    ]);
    expect(requested).toHaveLength(1);
    expect(
      new TmdbSourceInterpreter().canInterpret({
        evidence,
        sourceRecords: collected.records,
      }),
    ).toBe(false);
  });

  it("retains every successful bounded response when a sibling TMDB endpoint fails", async () => {
    const collector = new TmdbCollector({
      accessToken: "private-token",
      delay: async () => {},
      request: async (address) => {
        const url = new URL(address);
        if (url.pathname.endsWith("/search/movie"))
          return jsonResponse({
            page: 1,
            total_pages: 1,
            results: [{ id: 209764 }, { id: 999999 }],
          });
        if (url.pathname.endsWith("/999999"))
          return {
            ok: false,
            status: 503,
            headers: { get: () => "application/json" },
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        return jsonResponse({
          id: 209764,
          title: "恐怖直播",
          release_date: "2013-07-31",
          genres: [],
        });
      },
    });
    const evidence = filmEvidence("/library/恐怖直播 (2013)");

    const collected = await collector.collect(evidence[0]);

    expect(collected.records.map((record) => record.coverage.id)).toEqual([
      "tmdb.search.page.1",
      "tmdb.movie",
    ]);
    expect(collected.failures).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("HTTP 503"),
        affects: { recognition: true },
      }),
    ]);
  });

  it("retains successful search and detail records when detail schema prevents complete uniqueness", async () => {
    const collector = new TmdbCollector({
      accessToken: "private-token",
      request: async (address) => {
        const url = new URL(address);
        if (url.pathname.endsWith("/search/movie"))
          return jsonResponse({
            page: 1,
            total_pages: 1,
            results: [{ id: 209764 }],
          });
        return jsonResponse({
          id: "not-an-official-numeric-id",
          title: "恐怖直播",
          release_date: "2013-07-31",
          genres: [],
        });
      },
    });
    const evidence = filmEvidence("/library/恐怖直播 (2013)");

    const collected = await collector.collect(evidence[0]);

    expect(collected.records.map((record) => record.coverage.id)).toEqual([
      "tmdb.search.page.1",
      "tmdb.movie",
    ]);
    expect(collected.failures).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("有效标识"),
        affects: { recognition: true },
      }),
    ]);
  });

  it("leaves zero or multiple exact title-and-year candidates unresolved", () => {
    const interpreter = new TmdbSourceInterpreter();
    const evidence = filmEvidence("/library/恐怖直播 (2013)");
    const detail = (id: number, title: string) => ({
      id: `detail-${id}`,
      sourceIdentity: "tmdb",
      nativeAddress: `https://www.themoviedb.org/movie/${id}`,
      mediaType: "application/json",
      acquiredAt: "2026-07-31T00:00:00.000Z",
      acquisition: {
        requestedAddress: `https://api.themoviedb.org/3/movie/${id}`,
        method: "GET" as const,
        authorized: true,
      },
      coverage: {
        id: "tmdb.movie",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: `detail-${id}`,
      body: JSON.stringify({
        id,
        title,
        release_date: "2013-07-31",
        genres: [],
      }),
    });

    expect(
      interpreter.canInterpret({
        evidence,
        sourceRecords: [detail(1, "另一个作品")],
      }),
    ).toBe(false);
    expect(
      interpreter.canInterpret({
        evidence,
        sourceRecords: [detail(1, "恐怖直播"), detail(2, "恐怖直播")],
      }),
    ).toBe(false);
  });

  it("uses a unique exact official title/year record and scopes complete directors apart from the leading-cast projection", async () => {
    const requested: string[] = [];
    const collector = new TmdbCollector({
      accessToken: "private-token",
      request: async (address, init) => {
        requested.push(address);
        expect(init?.headers?.Authorization).toBe("Bearer private-token");
        if (address.includes("/search/movie"))
          return jsonResponse({
            page: 1,
            total_pages: 1,
            results: [{ id: 209764 }],
          });
        if (address.includes("/credits"))
          return jsonResponse({
            id: 209764,
            crew: [{ id: 1293082, name: "金秉祐", job: "Director" }],
            cast: Array.from({ length: 12 }, (_, index) => ({
              id: 75913 + index,
              name: `演员 ${index + 1}`,
              character: `角色 ${index + 1}`,
              // 刻意不同于响应数组顺序；解释契约遵循 TMDB 声明的顺序。
              order: (index + 5) % 12,
            })),
          });
        return jsonResponse({
          id: 209764,
          title: "恐怖直播",
          original_title: "더 테러 라이브",
          overview: "官方简介",
          release_date: "2013-07-31",
          runtime: 98,
          genres: [{ id: 53, name: "惊悚" }],
          poster_path: "/poster.jpg",
          backdrop_path: "/backdrop.jpg",
          imdb_id: "tt2990738",
          alternative_titles: { titles: [{ title: "The Terror Live" }] },
        });
      },
    });
    const evidence = filmEvidence("/library/恐怖直播 (2013)");
    const collected = await collector.collect(evidence[0]);
    const [interpreted] = new TmdbSourceInterpreter().interpret({
      evidence,
      sourceRecords: collected.records,
    });
    const proposal = new TmdbStrictFilmRecognizer().recognize({
      evidence,
      basis: { kind: "source-interpretation", interpretation: interpreted },
    });

    expect(collected.failures).toEqual([]);
    expect(collected.records.map((record) => record.coverage.id)).toEqual([
      "tmdb.search.page.1",
      "tmdb.movie",
      "tmdb.credits.directors",
      "tmdb.credits",
      "tmdb.translations",
    ]);
    expect(
      collected.records
        .filter((record) => record.coverage.id.startsWith("tmdb.credits"))
        .map((record) => record.coverage.completeness),
    ).toEqual(["complete", "incomplete"]);
    expect(requested).toHaveLength(4);
    expect(interpreted.sourceAddress).toBe(
      "https://www.themoviedb.org/movie/209764",
    );
    expect(interpreted.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "asset.title", value: "恐怖直播" }),
        expect.objectContaining({
          property: "asset.title.original",
          value: "더 테러 라이브",
        }),
        expect.objectContaining({
          property: "asset.release-date",
          value: "2013-07-31",
        }),
        expect.objectContaining({
          property: "asset.runtime-minutes",
          value: "98",
        }),
        expect.objectContaining({
          property: "external.imdb-id",
          value: "tt2990738",
        }),
      ]),
    );
    expect(interpreted.sourceArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "asset.primary-cover",
          acquisitionReference:
            "https://image.tmdb.org/t/p/original/poster.jpg",
        }),
        expect.objectContaining({ role: "asset.background" }),
      ]),
    );
    expect(interpreted.entities).toHaveLength(11);
    expect(
      interpreted.entities?.every(
        (entity) =>
          entity.identityNamespace === "tmdb.person" &&
          entity.sourceKey.length > 0,
      ),
    ).toBe(true);
    expect(interpreted.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participants: [expect.objectContaining({ role: "director" })],
        }),
        expect.objectContaining({
          participants: [
            expect.objectContaining({
              entityId: "entity_tmdb_person_75920",
              role: "cast",
            }),
          ],
          qualifiers: [
            { key: "character", value: "角色 8" },
            { key: "tmdb.cast-order", value: "0" },
          ],
        }),
      ]),
    );
    const cast = interpreted.relationships?.filter((item) =>
      item.participants.some(({ role }) => role === "cast"),
    );
    expect(cast).toHaveLength(10);
    expect(cast?.map((item) => item.participants[0]?.entityId)).toEqual([
      "entity_tmdb_person_75920",
      "entity_tmdb_person_75921",
      "entity_tmdb_person_75922",
      "entity_tmdb_person_75923",
      "entity_tmdb_person_75924",
      "entity_tmdb_person_75913",
      "entity_tmdb_person_75914",
      "entity_tmdb_person_75915",
      "entity_tmdb_person_75916",
      "entity_tmdb_person_75917",
    ]);
    const [
      searchRecord,
      detailRecord,
      directorsRecord,
      creditsRecord,
      translationsRecord,
    ] = collected.records;
    expect(interpreted.sourceRecordIds).toEqual([
      detailRecord.id,
      directorsRecord.id,
      creditsRecord.id,
      translationsRecord.id,
    ]);
    expect(
      interpreted.relationships?.find((item) =>
        item.participants.some(({ role }) => role === "director"),
      )?.sourceRecordIds,
    ).toEqual([directorsRecord.id]);
    expect(
      interpreted.relationships?.find((item) =>
        item.participants.some(({ role }) => role === "cast"),
      )?.sourceRecordIds,
    ).toEqual([creditsRecord.id]);
    expect(proposal.ruleResults[0]?.evidenceReferences).toEqual([
      { kind: "source-record", sourceRecordId: searchRecord.id },
      { kind: "source-record", sourceRecordId: detailRecord.id },
    ]);
    expect(proposal.ruleResults).toMatchObject([
      { ...trustedTmdbStrictFilmRule, outcome: "satisfied" },
    ]);
  });

  it("recognizes a directed exact TMDB address without broadening the directory grammar", async () => {
    const collector = new TmdbCollector({
      accessToken: "private-token",
      request: async (address) =>
        address.includes("credits")
          ? jsonResponse({ id: 9509, crew: [], cast: [] })
          : jsonResponse({
              id: 9509,
              title: "怒火救援",
              original_title: "Man on Fire",
              release_date: "2004-04-23",
              genres: [],
            }),
    });
    const evidence = [
      {
        kind: "directed-source-address",
        sourceIdentity: "tmdb",
        sourceAddress: "https://www.themoviedb.org/movie/9509",
        explanation: "directed",
        producer: {
          capabilityId: "application.directed-recognition",
          capabilityVersion: "1",
          contractVersion: "1",
        },
      },
    ] as const;
    const collected = await collector.collect(evidence[0]);
    const [interpreted] = new TmdbSourceInterpreter().interpret({
      evidence,
      sourceRecords: collected.records,
    });
    const proposal = new TmdbStrictFilmRecognizer().recognize({
      evidence,
      basis: { kind: "source-interpretation", interpretation: interpreted },
    });

    expect(collected.records.map((record) => record.coverage.id)).toEqual([
      "tmdb.movie",
      "tmdb.credits.directors",
      "tmdb.credits",
      "tmdb.translations",
    ]);
    expect(proposal.ruleResults[0]).toMatchObject({
      ...trustedTmdbDirectedFilmRule,
      ruleId: "exact-directed-official-address",
      outcome: "satisfied",
    });
    expect(proposal.ruleResults[0]?.evidenceReferences).toEqual([
      {
        kind: "source-record",
        sourceRecordId: collected.records[0].id,
      },
    ]);
  });

  it("does not interpret a directed response whose body identifies another movie", async () => {
    const collector = new TmdbCollector({
      accessToken: "private-token",
      request: async (address) =>
        address.includes("credits")
          ? jsonResponse({ id: 999, crew: [], cast: [] })
          : jsonResponse({
              id: 999,
              title: "另一个作品",
              release_date: "2004-04-23",
              genres: [],
            }),
    });
    const evidence = [
      {
        kind: "directed-source-address",
        sourceIdentity: "tmdb",
        sourceAddress: "https://www.themoviedb.org/movie/9509",
        explanation: "directed",
        producer: {
          capabilityId: "application.directed-recognition",
          capabilityVersion: "1",
          contractVersion: "1",
        },
      },
    ] as const;
    const collected = await collector.collect(evidence[0]);

    expect(
      new TmdbSourceInterpreter().canInterpret({
        evidence,
        sourceRecords: collected.records,
      }),
    ).toBe(false);
  });

  it("does not interpret directed credits whose response body identifies another movie", async () => {
    const collector = new TmdbCollector({
      accessToken: "private-token",
      request: async (address) =>
        address.includes("credits")
          ? jsonResponse({ id: 999, crew: [], cast: [] })
          : jsonResponse({
              id: 9509,
              title: "怒火救援",
              release_date: "2004-04-23",
              genres: [],
            }),
    });
    const evidence = [
      {
        kind: "directed-source-address",
        sourceIdentity: "tmdb",
        sourceAddress: "https://www.themoviedb.org/movie/9509",
        explanation: "directed",
        producer: {
          capabilityId: "application.directed-recognition",
          capabilityVersion: "1",
          contractVersion: "1",
        },
      },
    ] as const;
    const collected = await collector.collect(evidence[0]);

    expect(
      new TmdbSourceInterpreter().canInterpret({
        evidence,
        sourceRecords: collected.records,
      }),
    ).toBe(false);
  });

  it("does not create a request for unconfigured credentials and only acquires official image candidates", async () => {
    const missing = await new TmdbCollector().collect({
      kind: "directed-source-address",
      sourceIdentity: "tmdb",
      sourceAddress: "https://www.themoviedb.org/movie/209764",
      explanation: "directed",
      producer: {
        capabilityId: "application.directed-recognition",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    });
    expect(missing.records).toEqual([]);
    expect(missing.failures[0]?.reason).toContain("私有访问令牌");
    expect(missing.failures[0]?.failureClassification).toEqual(
      prerequisiteUnavailableFailure,
    );
    expect(
      new TmdbArtifactAcquirer().canAcquire({
        id: "poster",
        sourceRecordId: "record",
        role: "asset.primary-cover",
        mediaType: "image/jpeg",
        acquisitionReference: "https://image.tmdb.org/t/p/original/poster.jpg",
      }),
    ).toBe(true);
    expect(
      new TmdbArtifactAcquirer().canAcquire({
        id: "foreign",
        sourceRecordId: "record",
        role: "asset.primary-cover",
        mediaType: "image/jpeg",
        acquisitionReference: "https://example.test/poster.jpg",
      }),
    ).toBe(false);
  });

  it("does not copy an Authorization-bearing request failure into its public collection result", async () => {
    const evidence = filmEvidence("/library/Private Failure Film (2004)")[0];
    const result = await new TmdbCollector({
      accessToken: "tmdb-error-token",
      delay: async () => {},
      request: async () => {
        throw new Error("request failed with Bearer tmdb-error-token");
      },
    }).collect(evidence);

    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        reason: "TMDB 官方来源请求失败：网络请求未完成",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("tmdb-error-token");
  });

  it("retries a transient official poster request before materializing bytes", async () => {
    let attempts = 0;
    const acquirer = new TmdbArtifactAcquirer(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("temporary transport failure");
        return {
          ok: true,
          status: 200,
          headers: { get: () => "image/jpeg" },
          arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
        };
      },
      async () => {},
    );

    const acquired = await acquirer.acquire({
      id: "poster",
      sourceRecordId: "record",
      role: "asset.primary-cover",
      mediaType: "image/jpeg",
      acquisitionReference: "https://image.tmdb.org/t/p/original/poster.jpg",
    });

    expect(attempts).toBe(2);
    expect(acquired.bytes.byteLength).toBe(3);
  });

  it("redacts an exact reflected access token before retaining a TMDB source record", async () => {
    const accessToken = "tmdb-reflected-private-token";
    const reflectedResponse = (body: unknown) => ({
      ...jsonResponse(body),
      headers: {
        get: () => `application/json; private=${accessToken}`,
      },
    });
    const evidence = {
      kind: "directed-source-address" as const,
      sourceIdentity: "tmdb",
      sourceAddress: "https://www.themoviedb.org/movie/9509",
      explanation: "directed",
      producer: {
        capabilityId: "application.directed-recognition",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    };
    const result = await new TmdbCollector({
      accessToken,
      request: async (address) => {
        if (address.includes("/credits"))
          return reflectedResponse({
            id: 9509,
            crew: [],
            cast: [],
            accessToken,
          });
        if (address.includes("/translations"))
          return reflectedResponse({ id: 9509, translations: [], accessToken });
        return reflectedResponse({
          id: 9509,
          title: "怒火救援",
          release_date: "2004-04-23",
          genres: [],
          accessToken,
        });
      },
    }).collect(evidence);

    expect(result.failures).toEqual([]);
    expect(result.records).not.toHaveLength(0);
    for (const record of result.records) {
      expect(record.body).toContain("[REDACTED]");
      expect(record.body).not.toContain(accessToken);
      expect(record.mediaType).toBe("application/json");
      expect(record.digest).toBe(
        createHash("sha256").update(record.body).digest("hex"),
      );
    }
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  it("uses TMDB's ordered poster carousel only when the official primary poster is absent", () => {
    const interpreter = new TmdbSourceInterpreter();
    const detail = {
      id: "detail",
      sourceIdentity: "tmdb",
      nativeAddress: "https://www.themoviedb.org/movie/209764",
      mediaType: "application/json",
      acquiredAt: "2026-07-31T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://api.themoviedb.org/3/movie/209764",
        method: "GET" as const,
        authorized: true,
      },
      coverage: {
        id: "tmdb.movie",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "detail",
      body: JSON.stringify({
        id: 209764,
        title: "恐怖直播",
        release_date: "2013-07-31",
        genres: [],
        images: {
          posters: [{ file_path: "/first.jpg" }, { file_path: "/second.jpg" }],
        },
      }),
    };
    const credits = {
      ...detail,
      id: "credits",
      coverage: {
        id: "tmdb.credits",
        completeness: "incomplete" as const,
        authority: "official" as const,
      },
      body: JSON.stringify({ id: 209764, crew: [], cast: [] }),
    };
    const directorCredits = {
      ...credits,
      id: "director-credits",
      coverage: {
        id: "tmdb.credits.directors",
        completeness: "complete" as const,
        authority: "official" as const,
      },
    };
    const evidence = filmEvidence("/library/恐怖直播 (2013)");
    const [interpreted] = interpreter.interpret({
      evidence,
      sourceRecords: [detail, directorCredits, credits],
    });

    expect(interpreted.sourceArtifacts).toContainEqual(
      expect.objectContaining({
        role: "asset.primary-cover",
        acquisitionReference: "https://image.tmdb.org/t/p/original/first.jpg",
      }),
    );
  });

  it("omits blank semantic values and trims meaningful projected text without rewriting retained evidence", () => {
    const detailBody = JSON.stringify({
      id: 209764,
      title: "恐怖直播",
      original_title: " \n ",
      overview: "\t",
      release_date: "2013-07-31",
      genres: [{ name: " " }, { name: "  惊悚  " }],
      poster_path: " ",
      imdb_id: "\n",
      alternative_titles: {
        titles: [{ title: "  The Terror Live  " }, { title: " " }],
      },
    });
    const creditsBody = JSON.stringify({
      id: 209764,
      crew: [
        { id: 1, name: " ", job: "Director" },
        { id: 2, name: "  金秉祐  ", job: " Director " },
      ],
      cast: [
        { id: 3, name: "\t", character: "角色", order: 0 },
        { id: 4, name: "  河正宇  ", character: "  尹英华  ", order: 1 },
      ],
    });
    const detail = {
      id: "detail",
      sourceIdentity: "tmdb",
      nativeAddress: "https://www.themoviedb.org/movie/209764",
      mediaType: "application/json",
      acquiredAt: "2026-07-31T00:00:00.000Z",
      acquisition: {
        requestedAddress: "https://api.themoviedb.org/3/movie/209764",
        method: "GET" as const,
        authorized: true,
      },
      coverage: {
        id: "tmdb.movie",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "detail",
      body: detailBody,
    };
    const credits = {
      ...detail,
      id: "credits",
      coverage: {
        id: "tmdb.credits",
        completeness: "incomplete" as const,
        authority: "official" as const,
      },
      digest: "credits",
      body: creditsBody,
    };
    const directorCredits = {
      ...credits,
      id: "director-credits",
      coverage: {
        id: "tmdb.credits.directors",
        completeness: "complete" as const,
        authority: "official" as const,
      },
    };
    const evidence = filmEvidence("/library/恐怖直播 (2013)");

    const [interpreted] = new TmdbSourceInterpreter().interpret({
      evidence,
      sourceRecords: [detail, directorCredits, credits],
    });

    expect(detail.body).toBe(detailBody);
    expect(directorCredits.body).toBe(creditsBody);
    expect(credits.body).toBe(creditsBody);
    expect(interpreted.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "asset.title", value: "恐怖直播" }),
        expect.objectContaining({
          property: "asset.genre",
          sourceSlot: "tmdb.movie.genre.1",
          value: "惊悚",
        }),
        expect.objectContaining({
          property: "asset.title.alternative",
          value: "The Terror Live",
        }),
      ]),
    );
    expect(
      interpreted.metadata.every((fact) => fact.value.trim().length > 0),
    ).toBe(true);
    expect(interpreted.entities).toEqual([
      expect.objectContaining({ label: "金秉祐" }),
      expect.objectContaining({ label: "河正宇" }),
    ]);
    expect(interpreted.relationships).toEqual([
      expect.objectContaining({
        participants: [expect.objectContaining({ role: "director" })],
        sourceSlot: "tmdb.credits.crew.1",
      }),
      expect.objectContaining({
        participants: [expect.objectContaining({ role: "cast" })],
        qualifiers: [
          { key: "character", value: "尹英华" },
          { key: "tmdb.cast-order", value: "1" },
        ],
      }),
    ]);
    expect(interpreted.sourceArtifacts).toEqual([]);
  });
});
