import type { ChangeImpactPreviewFacts } from "@digital/application";
import { expect, it } from "vitest";

import { type AssetViewFacts, projectAssetView } from "../src/index.ts";

const facts: ChangeImpactPreviewFacts = {
  id: "subject",
  sourceAssociations: [
    { sourceIdentity: "tmdb", nativeAddress: "https://example.org/movie/1" },
  ],
  relatedEntities: [],
  relationships: [],
  descriptions: [
    {
      target: { kind: "entity", entityId: "subject" },
      metadataUsageContext: "asset.ordinary",
      metadataScope: { kind: "all-available" },
      metadata: [
        {
          property: "asset.title",
          result: {
            status: "resolved",
            values: [
              {
                property: "asset.title",
                value: "预演标题",
                sourceSlot: "tmdb",
                sourceIdentity: "tmdb",
                reasoning: { kind: "unranked-source-assertion" },
                assertions: [],
              },
            ],
          },
        },
      ],
      artifactRoles: [],
      missingArtifactRoles: [],
      conflicts: [
        {
          kind: "artifact-association-conflict",
          role: "asset.primary-cover",
          references: [
            { kind: "artifact-association", associationId: "cover" },
          ],
          explanation: "同级封面冲突",
        },
      ],
    },
  ],
  locations: [
    {
      id: "location",
      artifactId: "artifact",
      kind: "observed",
      content: {
        status: "confirmed",
        target: {
          kind: "artifact-revision",
          artifactId: "artifact",
          revisionId: "revision",
        },
      },
      byteLength: 123,
    },
  ],
};

it("公开预演保留生效标题、来源、冲突和材料修订，不要求内部路径或来源记录", () => {
  const view = projectAssetView(facts);
  expect(view.title).toBe("预演标题");
  expect(view.film?.sources).toEqual([
    { label: "TMDB", officialPage: "https://example.org/movie/1" },
  ]);
  expect(view.factProblems?.[0]?.conflicts).toEqual(
    facts.descriptions[0]?.conflicts,
  );
  expect(view.files).toEqual([
    { name: "文件", format: "文件", revisionId: "revision", byteLength: 123 },
  ]);
  expect(view.fileTree).toEqual([]);
  expect(view.cover).toBeUndefined();
});

it("普通完整读取仍按实际路径投影文件名、目录和精确进度", () => {
  const ordinary: AssetViewFacts = {
    ...facts,
    descriptions: [],
    relationships: [],
    locations: facts.locations.map((location) => ({
      ...location,
      address: "/library/material/clip.wav",
      downloadUrl: "/api/download/revision",
    })),
    interactionStates: [
      {
        artifactRevisionId: "revision",
        positionMilliseconds: 90210,
        completed: false,
      },
    ],
  };
  const view = projectAssetView(ordinary);
  expect(view.files).toEqual([
    {
      name: "clip.wav",
      format: "WAV",
      revisionId: "revision",
      byteLength: 123,
      downloadUrl: "/api/download/revision",
      interaction: { positionMilliseconds: 90210, completed: false },
    },
  ]);
  expect(view.fileTree).toEqual(view.files);
});
