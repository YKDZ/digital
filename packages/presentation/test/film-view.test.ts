import { describe, expect, it } from "vitest";

import {
  filmViewInformationRequirement,
  informationRequirementForAssetView,
  projectAssetView,
} from "../src/index";

describe("Film View", () => {
  it("requests the neutral facts consumed by the formal film presentation", () => {
    expect(
      informationRequirementForAssetView({
        sourceAssociation: {
          sourceIdentity: "tmdb",
          nativeAddress: "https://www.themoviedb.org/movie/209764",
        },
        metadata: [],
      }),
    ).toBe(filmViewInformationRequirement);
    expect(filmViewInformationRequirement.metadata).toEqual(
      expect.arrayContaining([
        { property: "asset.runtime-minutes", necessity: "optional" },
        { property: "asset.genre", necessity: "optional" },
        { property: "asset.awards", necessity: "optional" },
        { property: "asset.box-office", necessity: "optional" },
        { property: "rating.*", necessity: "optional" },
      ]),
    );
  });

  it("selects a film component from its accepted source association and projects display roles", () => {
    const view = projectAssetView({
      id: "film-209764",
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
      sourceAssociation: {
        sourceIdentity: "tmdb",
        nativeAddress: "https://www.themoviedb.org/movie/209764",
      },
      metadata: [
        { property: "asset.title", value: "恐怖直播" },
        { property: "asset.introduction", value: "一场无法停止的直播。" },
        { property: "asset.release-date", value: "2013-07-31" },
        { property: "asset.runtime-minutes", value: "97" },
        { property: "asset.genre", value: "惊悚" },
        { property: "asset.genre", value: "犯罪" },
        { property: "rating.imdb", value: "7.1/10" },
        { property: "rating.rotten-tomatoes", value: "80%" },
        { property: "asset.awards", value: "4 wins & 13 nominations" },
        { property: "asset.box-office", value: "$4,133" },
      ],
      entities: [
        { id: "director", label: "金秉祐" },
        { id: "cast-1", label: "河正宇" },
        { id: "cast-2", label: "李璟荣" },
      ],
      relationships: [
        {
          participantId: "director",
          role: "director",
          type: "asset.contribution",
        },
        {
          participantId: "cast-1",
          role: "cast",
          type: "asset.contribution",
        },
        {
          participantId: "cast-2",
          role: "cast",
          type: "asset.contribution",
        },
      ],
      artifactAssociations: [
        { artifactId: "poster", role: "asset.primary-cover" },
      ],
      locations: [
        {
          artifactId: "poster",
          kind: "managed",
          address: "/managed/poster.jpg",
        },
      ],
    });

    expect(view).toMatchObject({
      cardComponent: "film",
      detailComponent: "film",
      film: {
        title: "恐怖直播",
        cover: "/managed/poster.jpg",
        releaseDate: "2013-07-31",
        year: "2013",
        introduction: "一场无法停止的直播。",
        runtimeMinutes: "97",
        genres: ["惊悚", "犯罪"],
        directors: ["金秉祐"],
        cast: ["河正宇", "李璟荣"],
        ratings: [
          { label: "IMDb", value: "7.1/10" },
          { label: "烂番茄", value: "80%" },
        ],
        awards: "4 wins & 13 nominations",
        boxOffice: "$4,133",
        sources: [
          {
            label: "TMDB",
            officialPage: "https://www.themoviedb.org/movie/209764",
          },
          {
            label: "OMDb",
          },
        ],
      },
    });
    expect(JSON.stringify(view)).not.toContain("tmdb.movie");
    expect(JSON.stringify(view)).not.toContain("rating.imdb");
  });
});
