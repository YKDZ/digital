import { describe, expect, it } from "vitest";

import {
  generalAssetViewInformationRequirement,
  projectCatalogue,
  projectBangumiCatalogue,
  type AssetViewFacts,
} from "../src/index";

function bloomFacts(): readonly AssetViewFacts[] {
  const workId = "entity_bangumi-subject_243981";
  return Array.from({ length: 13 }, (_, index) => {
    const position = index + 1;
    const assetId = `asset_bloom_${position}`;
    return {
      id: assetId,
      sourceAssociation: {
        sourceIdentity: "bangumi",
        nativeAddress: `https://bgm.tv/episode/${831400 + position}`,
      },
      metadata: [
        {
          property: "asset.title",
          value: `第 ${position} 集`,
        },
        {
          property: "bangumi.episode.season-position",
          value: String(position),
        },
        {
          property: "bangumi.episode.continuous-position",
          value: String(position),
        },
        {
          subjectId: workId,
          property: "bangumi.subject.name.zh-hans",
          value: "终将成为你",
        },
        {
          subjectId: workId,
          property: "bangumi.subject.description",
          value: "少女们逐渐理解自己的心意。",
        },
        {
          subjectId: workId,
          property: "bangumi.subject.date",
          value: "2018-10-05",
        },
      ],
      currentRelatedEntities: [
        {
          id: workId,
          label: "やがて君になる",
          kind: { status: "ordinary" },
          sourceIdentity: "bangumi",
          identityNamespace: "bangumi.subject",
          sourceKey: "243981",
        },
      ],
      relationships: [
        {
          participants: [
            { entityId: assetId, role: "asset" },
            { entityId: workId, role: "bangumi.subject.ordinary-episode" },
          ],
          type: "asset.membership",
        },
      ],
      artifactAssociations: [
        {
          target: { kind: "entity", entityId: workId },
          artifactId: "artifact_bloom_cover",
          role: "asset.primary-cover",
        },
      ],
      locations: [
        {
          artifactId: "artifact_bloom_cover",
          kind: "managed",
          address: "/managed/bloom-cover.jpg",
        },
        {
          artifactId: `artifact_bloom_episode_${position}`,
          kind: "observed",
          address: `/media/Bloom/S01E${String(position).padStart(2, "0")}.mkv`,
        },
      ],
    };
  });
}

function frierenFacts(): readonly AssetViewFacts[] {
  const firstWork = "entity_bangumi-subject_400602";
  const secondWork = "entity_bangumi-subject_515759";
  const episodes = (
    workId: string,
    workKey: string,
    workTitle: string,
    count: number,
    continuousOffset: number,
  ): readonly AssetViewFacts[] =>
    Array.from({ length: count }, (_, index) => {
      const local = index + 1;
      const continuous = continuousOffset + local;
      const assetId = `asset_frieren_${continuous}`;
      return {
        id: assetId,
        sourceAssociation: {
          sourceIdentity: "bangumi",
          nativeAddress: `https://bgm.tv/episode/${1575900 + continuous}`,
        },
        metadata: [
          { property: "asset.title", value: `第 ${continuous} 集` },
          {
            property: "bangumi.episode.season-position",
            value: String(local),
          },
          {
            property: "bangumi.episode.continuous-position",
            value: String(continuous),
          },
          {
            subjectId: workId,
            property: "bangumi.subject.name.zh-hans",
            value: workTitle,
          },
        ],
        currentRelatedEntities: [
          {
            id: firstWork,
            label: "葬送のフリーレン",
            kind: { status: "ordinary" },
            sourceIdentity: "bangumi",
            identityNamespace: "bangumi.subject",
            sourceKey: "400602",
          },
          ...(workId === firstWork
            ? []
            : [
                {
                  id: secondWork,
                  label: "葬送のフリーレン 第2期",
                  kind: { status: "ordinary" },
                  sourceIdentity: "bangumi",
                  identityNamespace: "bangumi.subject",
                  sourceKey: workKey,
                },
              ]),
        ],
        relationships: [
          {
            participants: [
              { entityId: assetId, role: "asset" },
              {
                entityId: workId,
                role: "bangumi.subject.ordinary-episode",
              },
            ],
            type: "asset.membership",
          },
          ...(workId === firstWork
            ? []
            : [
                {
                  participants: [
                    {
                      entityId: firstWork,
                      role: "bangumi.subject.predecessor",
                    },
                    { entityId: secondWork, role: "bangumi.subject.sequel" },
                  ],
                  type: "bangumi.subject.related",
                },
              ]),
        ],
        artifactAssociations: [
          {
            target: { kind: "entity", entityId: workId },
            artifactId: `artifact_cover_${workKey}`,
            role: "asset.primary-cover",
          },
        ],
        locations: [
          {
            artifactId: `artifact_cover_${workKey}`,
            kind: "managed",
            address: `/managed/${workKey}.jpg`,
          },
          {
            artifactId: `artifact_episode_${continuous}`,
            kind: "observed",
            address: `/media/Frieren/S${workId === firstWork ? "01" : "02"}E${String(local).padStart(2, "0")}.mkv`,
          },
        ],
      };
    });
  return [
    ...episodes(firstWork, "400602", "葬送的芙莉莲", 28, 0),
    ...episodes(secondWork, "515759", "葬送的芙莉莲 第二季", 10, 28),
  ];
}

describe("Bangumi Asset View", () => {
  it("owns mixed catalogue partition and component dispatch", () => {
    const ordinary: AssetViewFacts = {
      id: "ordinary-asset",
      sourceAssociation: {
        sourceIdentity: "source",
        nativeAddress: "opaque:ordinary",
      },
      metadata: [{ property: "asset.title", value: "Ordinary work" }],
      currentRelatedEntities: [],
      relationships: [],
      artifactAssociations: [],
      locations: [],
    };

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
    const facts = frierenFacts().map((fact, index) =>
      index === 0
        ? {
            ...fact,
            relationships: [
              ...fact.relationships,
              {
                participants: [
                  {
                    entityId: "entity_bangumi-subject_515759",
                    role: "bangumi.subject.predecessor",
                  },
                  {
                    entityId: "entity_bangumi-subject_400602",
                    role: "bangumi.subject.sequel",
                  },
                ],
                type: "bangumi.subject.related",
              },
            ],
          }
        : fact,
    );

    const projected = projectBangumiCatalogue(facts);

    expect(projected).toHaveLength(1);
    expect(projected[0].works).toHaveLength(2);
    expect(projected[0].episodes).toHaveLength(38);
  });
});
