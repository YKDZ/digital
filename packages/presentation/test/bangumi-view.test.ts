import { describe, expect, it } from "vitest";

import {
  generalAssetViewInformationRequirement,
  projectCatalogue,
  projectBangumiCatalogue,
  type AssetViewFacts,
} from "../src/index";
import {
  entityDescription,
  relatedEntity,
  viewFacts,
  viewLocation,
  viewRelationship,
} from "./view-facts.ts";

type EpisodeFixture = {
  readonly assetId: string;
  readonly nativeAddress: string;
  /** 该集自身所属作品的成员关系；季内/连续序号挂在关系限定符上。 */
  readonly membership: {
    readonly workId: string;
    readonly localPosition: number;
    readonly continuousPosition: number;
  };
  readonly workMetadata: readonly (readonly [string, string])[];
  readonly cover: {
    readonly artifactId: string;
    readonly address: string;
  };
  readonly episodeAddress: string;
  readonly relatedWorks: readonly {
    readonly id: string;
    readonly label: string;
    readonly sourceKey: string;
  }[];
  readonly sequelEdges?: readonly {
    readonly predecessorId: string;
    readonly sequelId: string;
  }[];
};

/**
 * 现行读取契约的分层：序号属于「本集属于该作品」这条成员关系的限定符，集名属于资产自身的
 * 生效资料，作品名/简介/日期与作品封面属于被关联作品实体的生效资料，观察文件只声明当前修订版。
 */
function episodeFacts(input: EpisodeFixture): AssetViewFacts {
  return viewFacts({
    id: input.assetId,
    sourceAssociations: [
      { sourceIdentity: "bangumi", nativeAddress: input.nativeAddress },
    ],
    descriptions: [
      entityDescription(input.assetId, [
        ["asset.title", `第 ${input.membership.continuousPosition} 集`],
      ]),
      entityDescription(input.membership.workId, input.workMetadata, [
        ["asset.primary-cover", input.cover.artifactId, input.cover.address],
      ]),
    ],
    relatedEntities: input.relatedWorks.map((work) =>
      relatedEntity({
        id: work.id,
        label: work.label,
        sourceIdentity: "bangumi",
        identityNamespace: "bangumi.subject",
        sourceKey: work.sourceKey,
      }),
    ),
    relationships: [
      viewRelationship(
        `membership-${input.assetId}`,
        "asset.membership",
        [
          [input.assetId, "asset"],
          [input.membership.workId, "bangumi.subject.ordinary-episode"],
        ],
        [
          {
            key: "bangumi.episode.season-position",
            value: String(input.membership.localPosition),
          },
          {
            key: "bangumi.episode.continuous-position",
            value: String(input.membership.continuousPosition),
          },
        ],
      ),
      ...(input.sequelEdges ?? []).map((edge, index) =>
        viewRelationship(
          `related-${input.assetId}-${index}`,
          "bangumi.subject.related",
          [
            [edge.predecessorId, "bangumi.subject.predecessor"],
            [edge.sequelId, "bangumi.subject.sequel"],
          ],
        ),
      ),
    ],
    locations: [
      viewLocation({
        id: `cover-location-${input.assetId}`,
        artifactId: input.cover.artifactId,
        kind: "managed",
        address: input.cover.address,
      }),
      viewLocation({
        id: `episode-location-${input.assetId}`,
        artifactId: `artifact_${input.assetId}`,
        kind: "observed",
        address: input.episodeAddress,
      }),
    ],
  });
}

function bloomFacts(): readonly AssetViewFacts[] {
  const workId = "entity_bangumi-subject_243981";
  return Array.from({ length: 13 }, (_, index) => {
    const position = index + 1;
    return episodeFacts({
      assetId: `asset_bloom_${position}`,
      nativeAddress: `https://bgm.tv/episode/${831400 + position}`,
      membership: {
        workId,
        localPosition: position,
        continuousPosition: position,
      },
      workMetadata: [
        ["bangumi.subject.name.zh-hans", "终将成为你"],
        ["bangumi.subject.description", "少女们逐渐理解自己的心意。"],
        ["bangumi.subject.date", "2018-10-05"],
      ],
      cover: {
        artifactId: "artifact_bloom_cover",
        address: "/managed/bloom-cover.jpg",
      },
      episodeAddress: `/media/Bloom/S01E${String(position).padStart(2, "0")}.mkv`,
      relatedWorks: [
        { id: workId, label: "やがて君になる", sourceKey: "243981" },
      ],
    });
  });
}

function frierenFacts(): readonly AssetViewFacts[] {
  const firstWork = "entity_bangumi-subject_400602";
  const secondWork = "entity_bangumi-subject_515759";
  const works = {
    [firstWork]: {
      id: firstWork,
      label: "葬送のフリーレン",
      sourceKey: "400602",
    },
    [secondWork]: {
      id: secondWork,
      label: "葬送のフリーレン 第2期",
      sourceKey: "515759",
    },
  };
  const episodes = (
    workId: string,
    workTitle: string,
    count: number,
    continuousOffset: number,
  ): readonly AssetViewFacts[] =>
    Array.from({ length: count }, (_, index) => {
      const local = index + 1;
      const continuous = continuousOffset + local;
      const season = workId === firstWork ? "01" : "02";
      const isSequel = workId !== firstWork;
      return episodeFacts({
        assetId: `asset_frieren_${continuous}`,
        nativeAddress: `https://bgm.tv/episode/${1575900 + continuous}`,
        membership: {
          workId,
          localPosition: local,
          continuousPosition: continuous,
        },
        workMetadata: [["bangumi.subject.name.zh-hans", workTitle]],
        cover: {
          artifactId: `artifact_cover_${workId}`,
          address: `/managed/${works[workId]!.sourceKey}.jpg`,
        },
        episodeAddress: `/media/Frieren/S${season}E${String(local).padStart(2, "0")}.mkv`,
        relatedWorks: isSequel
          ? [works[firstWork]!, works[secondWork]!]
          : [works[firstWork]!],
        sequelEdges: isSequel
          ? [{ predecessorId: firstWork, sequelId: secondWork }]
          : [],
      });
    });
  return [
    ...episodes(firstWork, "葬送的芙莉莲", 28, 0),
    ...episodes(secondWork, "葬送的芙莉莲 第二季", 10, 28),
  ];
}

describe("Bangumi Asset View", () => {
  it("owns mixed catalogue partition and component dispatch", () => {
    const ordinary: AssetViewFacts = viewFacts({
      id: "ordinary-asset",
      sourceAssociations: [
        { sourceIdentity: "source", nativeAddress: "opaque:ordinary" },
      ],
      descriptions: [
        entityDescription("ordinary-asset", [["asset.title", "Ordinary work"]]),
      ],
    });

    const projected = projectCatalogue([...bloomFacts(), ordinary]);

    expect(projected).toHaveLength(2);
    expect(projected).toEqual([
      expect.objectContaining({
        component: "bangumi",
        episodes: expect.arrayContaining([
          expect.objectContaining({ assetId: "asset_bloom_1" }),
        ]),
      }),
      expect.objectContaining({
        id: "ordinary-asset",
        cardComponent: "generic",
        title: "Ordinary work",
      }),
    ]);
  });

  it("demands official sequel facts at the Application read boundary", () => {
    expect(
      generalAssetViewInformationRequirement.relationshipTypes,
    ).toContainEqual({
      type: "bangumi.subject.related",
      necessity: "optional",
    });
  });

  it("browses one accepted Bloom Work instead of thirteen episode cards", () => {
    const projected = projectBangumiCatalogue(bloomFacts());

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: "bangumi-series:entity_bangumi-subject_243981",
      title: "终将成为你",
      cover: "/managed/bloom-cover.jpg",
      works: [
        {
          id: "entity_bangumi-subject_243981",
          title: "终将成为你",
          date: "2018-10-05",
        },
      ],
    });
    expect(projected[0]).not.toHaveProperty("actionTarget");
    expect(projected[0].episodes).toHaveLength(13);
    expect(projected[0].episodes[0]).toMatchObject({
      assetId: "asset_bloom_1",
      localPosition: 1,
      continuousPosition: 1,
      available: true,
      actionTarget: { subjectId: "asset_bloom_1" },
    });
    expect(projected[0].episodes[0]).not.toHaveProperty("artwork");
  });

  it("navigates two officially related Frieren Works while retaining both episode orders", () => {
    const projected = projectBangumiCatalogue(frierenFacts());

    expect(projected).toHaveLength(1);
    expect(projected[0].works.map((work) => work.title)).toEqual([
      "葬送的芙莉莲",
      "葬送的芙莉莲 第二季",
    ]);
    expect(projected[0].works[0].episodes).toHaveLength(28);
    expect(projected[0].works[1].episodes).toHaveLength(10);
    expect(projected[0].episodes).toHaveLength(38);
    expect(
      projected[0].works[1].episodes.map((episode) => [
        episode.localPosition,
        episode.continuousPosition,
      ]),
    ).toEqual(
      Array.from({ length: 10 }, (_, index) => [index + 1, index + 29]),
    );
    expect(
      projected[0].episodes.filter((episode) => episode.artwork !== undefined),
    ).toEqual([]);
  });

  it("groups and orders the official Work graph independently of response order", () => {
    const forward = projectBangumiCatalogue(frierenFacts());
    const reversed = projectBangumiCatalogue(frierenFacts().toReversed());

    expect(reversed).toEqual(forward);
    expect(
      reversed[0].episodes.map((episode) => episode.continuousPosition),
    ).toEqual(Array.from({ length: 38 }, (_, index) => index + 1));
  });

  it("projects malformed sequel cycles once and finitely", () => {
    const firstWork = "entity_bangumi-subject_400602";
    const secondWork = "entity_bangumi-subject_515759";
    const facts = frierenFacts().map((fact, index) =>
      index === 0
        ? viewFacts({
            ...fact,
            relationships: [
              ...fact.relationships,
              viewRelationship("related-cyclic", "bangumi.subject.related", [
                [secondWork, "bangumi.subject.predecessor"],
                [firstWork, "bangumi.subject.sequel"],
              ]),
            ],
          })
        : fact,
    );

    const projected = projectBangumiCatalogue(facts);

    expect(projected).toHaveLength(1);
    expect(projected[0].works).toHaveLength(2);
    expect(projected[0].episodes).toHaveLength(38);
  });
});
