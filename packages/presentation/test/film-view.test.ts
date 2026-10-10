import { describe, expect, it } from "vitest";

import {
  filmViewInformationRequirement,
  informationRequirementForAssetView,
  projectAssetView,
} from "../src/index";
import {
  entityDescription,
  relatedEntity,
  viewFacts,
  viewLocation,
  viewRelationship,
} from "./view-facts.ts";

describe("Film View", () => {
  it("requests the neutral facts consumed by the formal film presentation", () => {
    expect(
      informationRequirementForAssetView(
        viewFacts({
          id: "film-209764",
          sourceAssociations: [
            {
              sourceIdentity: "tmdb",
              nativeAddress: "https://www.themoviedb.org/movie/209764",
            },
          ],
        }),
      ),
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
    const view = projectAssetView(
      viewFacts({
        id: "film-209764",
        recognitionSourceAssociation: {
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
        descriptions: [
          entityDescription(
            "film-209764",
            [
              ["asset.title", "恐怖直播"],
              ["asset.introduction", "一场无法停止的直播。"],
              ["asset.release-date", "2013-07-31"],
              ["asset.runtime-minutes", "97"],
              ["asset.genre", "惊悚"],
              ["asset.genre", "犯罪"],
              ["rating.imdb", "7.1/10"],
              ["rating.rotten-tomatoes", "80%"],
              ["asset.awards", "4 wins & 13 nominations"],
              ["asset.box-office", "$4,133"],
            ],
            [["asset.primary-cover", "poster", "/managed/poster.jpg"]],
          ),
        ],
        relatedEntities: [
          relatedEntity({
            id: "director",
            label: "金秉祐",
            sourceIdentity: "tmdb",
            identityNamespace: "tmdb.person",
            sourceKey: "director",
          }),
          relatedEntity({
            id: "cast-1",
            label: "河正宇",
            sourceIdentity: "tmdb",
            identityNamespace: "tmdb.person",
            sourceKey: "cast-1",
          }),
          relatedEntity({
            id: "cast-2",
            label: "李璟荣",
            sourceIdentity: "tmdb",
            identityNamespace: "tmdb.person",
            sourceKey: "cast-2",
          }),
        ],
        relationships: [
          viewRelationship("contribution-director", "asset.contribution", [
            ["film-209764", "asset"],
            ["director", "director"],
          ]),
          viewRelationship("contribution-cast-1", "asset.contribution", [
            ["film-209764", "asset"],
            ["cast-1", "cast"],
          ]),
          viewRelationship("contribution-cast-2", "asset.contribution", [
            ["film-209764", "asset"],
            ["cast-2", "cast"],
          ]),
        ],
        locations: [
          viewLocation({
            id: "poster-location",
            artifactId: "poster",
            kind: "managed",
            address: "/managed/poster.jpg",
          }),
        ],
      }),
    );

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
