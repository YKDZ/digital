import { expect, it } from "vitest";

import {
  subjectMetadataEvidence,
  type SubjectFactBasis,
} from "../src/effective-fact-reads.ts";

const basis: SubjectFactBasis = {
  id: "asset-1",
  sourceAssociations: [
    {
      id: "association-official",
      subjectId: "asset-1",
      sourceIdentity: "official",
      nativeAddress: "作品/1",
    },
    {
      id: "association-mirror",
      subjectId: "asset-1",
      sourceIdentity: "mirror",
      nativeAddress: "作品/1",
    },
  ],
  metadataSourceRecords: [
    { id: "record-official", sourceIdentity: "official" },
    { id: "record-mirror", sourceIdentity: "mirror" },
  ],
  metadata: [
    {
      target: { kind: "entity", entityId: "asset-1" },
      property: "asset.title",
      sourceSlot: "official-title",
      value: "采用标题",
      sourceRecordIds: ["record-official"],
    },
    {
      target: { kind: "entity", entityId: "asset-1" },
      property: "asset.title",
      sourceSlot: "mirror-title",
      value: "未采用标题",
      sourceRecordIds: ["record-mirror"],
    },
    {
      target: { kind: "entity", entityId: "asset-1" },
      property: "asset.creator",
      sourceSlot: "official-creator",
      value: "甲",
      sourceRecordIds: ["record-official"],
    },
    {
      target: { kind: "entity", entityId: "asset-1" },
      property: "asset.creator",
      sourceSlot: "mirror-creator",
      value: "乙",
      sourceRecordIds: ["record-mirror"],
    },
  ],
  artifactAssociations: [],
  artifactRevisions: [],
  blobs: [],
  locations: [],
};

it("把当前值、未采用值、冲突候选和缺失项分层呈现并沿用有效事实规则", () => {
  const evidence = subjectMetadataEvidence(
    basis,
    {
      version: "metadata-policy/1",
      policies: [
        {
          id: "prefer-official-title",
          metadataUsageContext: "asset.ordinary",
          rules: [
            {
              property: "asset.title",
              preferredSourceIdentities: ["official"],
              cardinality: "one",
            },
            {
              property: "asset.creator",
              preferredSourceIdentities: [],
              cardinality: "one",
            },
          ],
        },
      ],
      select: () => ["prefer-official-title"],
    },
    "asset.ordinary",
    ["asset.publisher"],
  );

  expect(evidence).toMatchObject([
    {
      property: "asset.creator",
      result: {
        status: "conflict",
        candidates: [
          { value: "乙", sourceIdentity: "mirror" },
          { value: "甲", sourceIdentity: "official" },
        ],
      },
    },
    {
      property: "asset.publisher",
      result: { status: "missing" },
    },
    {
      property: "asset.title",
      result: {
        status: "resolved",
        values: [{ value: "采用标题", sourceIdentity: "official" }],
        notSelected: [
          {
            value: "未采用标题",
            sourceIdentity: "mirror",
            exclusion: {
              kind: "source-preference",
              selectedSource: "official",
              disagreesWithSelected: true,
            },
          },
        ],
      },
    },
  ]);
});
