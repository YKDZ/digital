import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import journey, {
  acceptedProjection,
  assertSourceEnrichedFilm,
} from "../e2e/journeys/tmdb-omdb-live.journey.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("TMDB and OMDb live journey contract", () => {
  it("fails before it can run when either required private provider credential is absent", async () => {
    for (const [tmdb, omdb] of [
      [undefined, "test-omdb-key"],
      ["test-tmdb-token", undefined],
      ["", ""],
    ] as const) {
      vi.stubEnv("DIGITAL_TMDB_ACCESS_TOKEN", tmdb);
      vi.stubEnv("DIGITAL_OMDB_API_KEY", omdb);
      await expect(
        journey.setup({
          mode: "source",
          packageRoot: path.resolve(import.meta.dirname, "../.."),
          workDir: "/unused",
        }),
      ).rejects.toThrow(
        "TMDB and OMDb live journey requires DIGITAL_TMDB_ACCESS_TOKEN and DIGITAL_OMDB_API_KEY",
      );
      vi.unstubAllEnvs();
    }
  });

  it("plans strict recognition, exact directed recognition, reuse, and metadata refresh through one SQLite catalogue", async () => {
    vi.stubEnv("DIGITAL_TMDB_ACCESS_TOKEN", "test-tmdb-token");
    vi.stubEnv("DIGITAL_OMDB_API_KEY", "test-omdb-key");
    const context = {
      mode: "source",
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      workDir: "/temporary-work",
    } as const;
    await journey.setup(context);
    const commands = journey.commands(context);

    expect(commands.map((command) => command.name)).toEqual([
      "register strict TMDB film root",
      "register directed BDMV film root",
      "live accept strict TMDB film with OMDb enrichment",
      "live no-change strict TMDB film after SQLite restart",
      "live refresh strict film metadata from current sources",
      "live inspect refreshed strict film projection",
      "live accept directed BDMV film with OMDb enrichment",
      "live inspect directed BDMV film projection after SQLite restart",
      "live refresh directed BDMV film metadata from current sources",
      "live inspect refreshed directed BDMV film projection",
    ]);
    const result = (stdout: string) => ({
      commandName: "fixture",
      exitCode: 0,
      stdout,
      stderr: "",
    });
    const strictRoot = result(JSON.stringify({ id: "strict-root" }));
    const directedRoot = result(JSON.stringify({ id: "directed-root" }));
    const strictAccepted = result(
      JSON.stringify({ accepted: { entity: { id: "strict-asset" } } }),
    );
    const plannedArgs = (
      index: number,
      previous: readonly (typeof strictRoot)[],
    ) => {
      const args = commands[index]?.args;
      expect(typeof args).toBe("function");
      return typeof args === "function" ? args(previous) : args;
    };
    expect(plannedArgs(2, [strictRoot, directedRoot])).toEqual(
      expect.arrayContaining(["scan", "strict-root", "--scope", ".", "--json"]),
    );
    expect(plannedArgs(4, [strictRoot, directedRoot, strictAccepted])).toEqual(
      expect.arrayContaining(["refresh-metadata", "strict-asset", "--json"]),
    );
    expect(plannedArgs(6, [strictRoot, directedRoot])).toEqual(
      expect.arrayContaining([
        "scrape",
        "directed-root",
        "https://www.themoviedb.org/movie/9509",
        "--scope",
        ".",
        "--source-identity",
        "tmdb",
        "--json",
      ]),
    );
    expect(commands.every((command) => command.env !== undefined)).toBe(true);
  });

  it("uses the public legacy and itemized inspection projections without treating them as interchangeable", () => {
    const accepted = {
      entity: { id: "asset-1", kind: "digital-asset" },
      sourceAssociation: {
        sourceIdentity: "tmdb",
        nativeAddress: "https://www.themoviedb.org/movie/209764",
      },
      sourceAssociations: [
        {
          sourceIdentity: "tmdb",
          nativeAddress: "https://www.themoviedb.org/movie/209764",
        },
        {
          sourceIdentity: "omdb",
          nativeAddress: "omdb:imdb:tt2990738",
        },
      ],
      metadata: [],
      entities: [],
      entityMentions: [],
      entityResolutionDecisions: [],
      relationships: [],
      artifacts: [{ id: "managed-cover" }],
      locations: [
        {
          artifactId: "managed-cover",
          kind: "managed",
          address: "/managed-cover",
        },
      ],
      artifactAssociations: [
        { artifactId: "managed-cover", role: "asset.primary-cover" },
      ],
      effectiveMetadata: [
        {
          property: "asset.title",
          value: "恐怖直播",
          sourceIdentity: "tmdb",
          sourceRecordIds: ["tmdb-record"],
          sourceSlot: "tmdb.movie.title",
          selectedAssertion: {
            id: "assertion-tmdb-title",
            property: "asset.title",
            value: "恐怖直播",
            sourceRecordIds: ["tmdb-record"],
            sourceSlot: "tmdb.movie.title",
          },
          alternatives: [
            {
              assertion: {
                id: "assertion-omdb-title",
                property: "asset.title",
                value: "The Terror Live",
                sourceRecordIds: ["omdb-record"],
                sourceSlot: "omdb.movie.title",
              },
              value: "The Terror Live",
              sourceIdentity: "omdb",
              sourceRecordIds: ["omdb-record"],
              sourceSlot: "omdb.movie.title",
              exclusion: {
                kind: "source-preference",
                selectedSource: "tmdb",
                disagreesWithSelected: true,
              },
            },
          ],
          reasoning: { kind: "source-preference", preferredSource: "tmdb" },
        },
        {
          property: "rating.imdb",
          value: "6.6/10",
          sourceIdentity: "omdb",
          sourceRecordIds: ["omdb-record"],
          sourceSlot: "omdb.rating.rating.imdb",
          selectedAssertion: {
            id: "assertion-omdb-rating",
            property: "rating.imdb",
            value: "6.6/10",
            sourceRecordIds: ["omdb-record"],
            sourceSlot: "omdb.rating.rating.imdb",
            qualifiers: [{ key: "rating.unit", value: "score" }],
          },
          qualifiers: [{ key: "rating.unit", value: "score" }],
          alternatives: [],
          reasoning: { kind: "unranked-source-assertion" },
        },
      ],
      metadataPolicyConflicts: [],
      recognitionExplanation: "strict title and year",
    };
    const common = {
      format: "temporary-asset-refresh-inspection/v1",
      unstable: true,
      sourceRecords: [
        {
          id: "tmdb-record",
          sourceIdentity: "tmdb",
          nativeAddress: "https://www.themoviedb.org/movie/209764",
          coverage: {
            id: "tmdb.movie",
            completeness: "complete",
            authority: "official",
          },
          acquiredAt: "2026-01-01T00:00:00.000Z",
          digest: "tmdb",
        },
        {
          id: "omdb-record",
          sourceIdentity: "omdb",
          nativeAddress: "omdb:imdb:tt2990738",
          coverage: {
            id: "omdb.movie",
            completeness: "complete",
            authority: "official",
          },
          acquiredAt: "2026-01-01T00:00:00.000Z",
          digest: "omdb",
        },
      ],
    } as const;
    const legacy = {
      ...common,
      execution: {
        id: "legacy-execution",
        selection: { directory: "/movie" },
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        sourceRecordIds: ["tmdb-record", "omdb-record"],
        compatibility: { version: "1" },
        dispositions: [],
      },
      accepted,
    } as unknown as Parameters<typeof acceptedProjection>[0];
    const itemized = {
      ...common,
      execution: {
        id: "itemized-execution",
        selection: { intent: "directed-recognition" },
        status: "completed",
        stage: "completed",
        outcome: "accepted",
        sourceRecordIds: ["tmdb-record", "omdb-record"],
        compatibility: { version: "1" },
        dispositions: [],
      },
      itemResults: [
        {
          key: "directed-recognition",
          relativePaths: ["."],
          outcome: "accepted",
          accepted,
        },
      ],
    } as unknown as Parameters<typeof acceptedProjection>[0];

    expect(acceptedProjection(legacy, "legacy").entity.id).toBe("asset-1");
    expect(acceptedProjection(itemized, "itemized").entity.id).toBe("asset-1");
    expect(() => acceptedProjection(legacy, "itemized")).toThrow(
      "explicit work-item",
    );
    expect(() => acceptedProjection(itemized, "legacy")).toThrow(
      "legacy single-boundary",
    );
    expect(() =>
      assertSourceEnrichedFilm(
        legacy,
        "https://www.themoviedb.org/movie/209764",
        "omdb:imdb:tt2990738",
        "legacy",
      ),
    ).not.toThrow();
    expect(() =>
      assertSourceEnrichedFilm(
        itemized,
        "https://www.themoviedb.org/movie/209764",
        "omdb:imdb:tt2990738",
        "itemized",
      ),
    ).not.toThrow();
  });
});
