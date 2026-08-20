import { describe, expect, it } from "vitest";

import {
  deriveEffectiveMetadata,
  type MetadataPolicy,
  type MetadataPolicyRule,
  validateMetadataPolicy,
} from "../src/index.ts";

const exactRule: MetadataPolicyRule = {
  property: "asset.title",
  preferredSourceIdentities: ["preferred", "fallback"],
  cardinality: "one",
};
const patternRule: MetadataPolicyRule = {
  property: "asset.*",
  preferredSourceIdentities: ["fallback", "preferred"],
  cardinality: "one",
};
const defaultRule: MetadataPolicyRule = {
  property: "*",
  preferredSourceIdentities: ["fallback", "preferred"],
  cardinality: "one",
};

function policy(rules: readonly MetadataPolicyRule[]): MetadataPolicy {
  return {
    id: "ordinary-display",
    metadataUsageContext: "asset.ordinary",
    subjectIds: ["asset-1"],
    rules,
  };
}

function derive(rules: readonly MetadataPolicyRule[]) {
  return deriveEffectiveMetadata({
    subjectId: "asset-1",
    metadataUsageContext: "asset.ordinary",
    policies: [policy(rules)],
    sourceRecords: [
      { id: "preferred-record", sourceIdentity: "preferred" },
      { id: "fallback-record", sourceIdentity: "fallback" },
    ],
    metadata: [
      {
        property: "asset.title",
        sourceSlot: "preferred.title",
        value: "Preferred title",
        sourceRecordIds: ["preferred-record"],
      },
      {
        property: "asset.title",
        sourceSlot: "fallback.title",
        value: "Fallback title",
        sourceRecordIds: ["fallback-record"],
      },
    ],
  });
}

describe("Effective Metadata", () => {
  it("applies an exact property rule before matching patterns and the default regardless of rule order", () => {
    const exactFirst = derive([exactRule, patternRule, defaultRule]);
    const exactLast = derive([defaultRule, patternRule, exactRule]);

    for (const projection of [exactFirst, exactLast]) {
      expect(projection.conflicts).toEqual([]);
      expect(projection.values).toEqual([
        expect.objectContaining({
          property: "asset.title",
          value: "Preferred title",
          sourceIdentity: "preferred",
          sourceRecordIds: ["preferred-record"],
          sourceSlot: "preferred.title",
          selectedAssertion: expect.objectContaining({
            sourceSlot: "preferred.title",
          }),
          reasoning: {
            kind: "source-preference",
            preferredSource: "preferred",
          },
        }),
      ]);
    }
  });

  it("preserves the selected assertion, disagreeing alternatives, qualifiers, and source-preference reasoning", () => {
    const projection = derive([exactRule]);

    expect(projection).toEqual({
      conflicts: [],
      values: [
        expect.objectContaining({
          property: "asset.title",
          value: "Preferred title",
          selectedAssertion: {
            property: "asset.title",
            sourceSlot: "preferred.title",
            value: "Preferred title",
            sourceRecordIds: ["preferred-record"],
          },
          sourceIdentity: "preferred",
          sourceRecordIds: ["preferred-record"],
          sourceSlot: "preferred.title",
          alternatives: [
            expect.objectContaining({
              assertion: expect.objectContaining({
                sourceSlot: "fallback.title",
              }),
              value: "Fallback title",
              sourceIdentity: "fallback",
              sourceRecordIds: ["fallback-record"],
              sourceSlot: "fallback.title",
              exclusion: {
                kind: "source-preference",
                selectedSource: "preferred",
                disagreesWithSelected: true,
              },
            }),
          ],
          reasoning: {
            kind: "source-preference",
            preferredSource: "preferred",
          },
        }),
      ],
    });
  });

  it("explains every absent preferred source before selecting an available fallback", () => {
    const projection = deriveEffectiveMetadata({
      subjectId: "asset-1",
      metadataUsageContext: "asset.ordinary",
      policies: [
        policy([
          {
            property: "asset.introduction",
            preferredSourceIdentities: [
              "first-preference",
              "second-preference",
              "fallback",
            ],
            cardinality: "one",
          },
        ]),
      ],
      sourceRecords: [{ id: "fallback-record", sourceIdentity: "fallback" }],
      metadata: [
        {
          property: "asset.introduction",
          sourceSlot: "fallback.introduction",
          value: "Fallback overview",
          sourceRecordIds: ["fallback-record"],
        },
      ],
    });

    expect(projection.values).toEqual([
      expect.objectContaining({
        value: "Fallback overview",
        reasoning: {
          kind: "preferred-source-absent-fallback",
          absentPreferredSources: ["first-preference", "second-preference"],
          selectedFallbackSource: "fallback",
        },
      }),
    ]);
  });

  it("keeps many-valued assertions and their native qualifiers separate", () => {
    const projection = deriveEffectiveMetadata({
      subjectId: "asset-1",
      metadataUsageContext: "asset.ordinary",
      policies: [
        policy([
          {
            property: "rating.*",
            preferredSourceIdentities: [],
            cardinality: "many",
          },
        ]),
      ],
      sourceRecords: [{ id: "record", sourceIdentity: "source" }],
      metadata: [
        {
          property: "rating.score",
          sourceSlot: "source.score",
          value: "7.7/10",
          sourceRecordIds: ["record"],
          qualifiers: [
            { key: "rating.unit", value: "score" },
            { key: "rating.scale", value: "10" },
          ],
        },
        {
          property: "rating.percent",
          sourceSlot: "source.percent",
          value: "39%",
          sourceRecordIds: ["record"],
        },
      ],
    });

    expect(
      projection.values.map((value) => [value.property, value.value]),
    ).toEqual([
      ["rating.percent", "39%"],
      ["rating.score", "7.7/10"],
    ]);
    expect(
      projection.values.find((value) => value.property === "rating.score")
        ?.qualifiers,
    ).toEqual([
      { key: "rating.unit", value: "score" },
      { key: "rating.scale", value: "10" },
    ]);
  });

  it("selects a preferred source's complete many-valued group and preserves lower-source alternatives", () => {
    const projection = deriveEffectiveMetadata({
      subjectId: "asset-1",
      metadataUsageContext: "asset.ordinary",
      policies: [
        policy([
          {
            property: "asset.genre",
            preferredSourceIdentities: ["tmdb", "omdb"],
            cardinality: "many",
          },
        ]),
      ],
      sourceRecords: [
        { id: "omdb-record", sourceIdentity: "omdb" },
        { id: "tmdb-record", sourceIdentity: "tmdb" },
      ],
      metadata: [
        {
          property: "asset.genre",
          sourceSlot: "tmdb.movie.genre.0",
          value: "Drama",
          sourceRecordIds: ["tmdb-record"],
        },
        {
          property: "asset.genre",
          sourceSlot: "tmdb.movie.genre.1",
          value: "Thriller",
          sourceRecordIds: ["tmdb-record"],
        },
        {
          property: "asset.genre",
          sourceSlot: "omdb.movie.genre.0",
          value: "Drama",
          sourceRecordIds: ["omdb-record"],
        },
        {
          property: "asset.genre",
          sourceSlot: "omdb.movie.genre.1",
          value: "Mystery",
          sourceRecordIds: ["omdb-record"],
        },
      ],
    });

    expect(
      projection.values.map((value) => [
        value.value,
        value.sourceIdentity,
        value.sourceSlot,
        value.reasoning,
      ]),
    ).toEqual([
      [
        "Drama",
        "tmdb",
        "tmdb.movie.genre.0",
        { kind: "source-preference", preferredSource: "tmdb" },
      ],
      [
        "Thriller",
        "tmdb",
        "tmdb.movie.genre.1",
        { kind: "source-preference", preferredSource: "tmdb" },
      ],
    ]);
    for (const selected of projection.values) {
      expect(selected.alternatives).toEqual([
        expect.objectContaining({
          value: "Drama",
          sourceIdentity: "omdb",
          exclusion: {
            kind: "source-preference",
            selectedSource: "tmdb",
            disagreesWithSelected: false,
          },
        }),
        expect.objectContaining({
          value: "Mystery",
          sourceIdentity: "omdb",
          exclusion: {
            kind: "source-preference",
            selectedSource: "tmdb",
            disagreesWithSelected: true,
          },
        }),
      ]);
    }
  });

  it("selects a deterministic fallback source's complete many-valued group", () => {
    const projection = deriveEffectiveMetadata({
      subjectId: "asset-1",
      metadataUsageContext: "asset.ordinary",
      policies: [
        policy([
          {
            property: "asset.genre",
            preferredSourceIdentities: ["tmdb", "omdb"],
            cardinality: "many",
          },
        ]),
      ],
      sourceRecords: [
        { id: "catalogue-record", sourceIdentity: "catalogue" },
        { id: "untrusted-record", sourceIdentity: "untrusted" },
      ],
      metadata: [
        {
          property: "asset.genre",
          sourceSlot: "catalogue.genre.0",
          value: "Drama",
          sourceRecordIds: ["catalogue-record"],
        },
        {
          property: "asset.genre",
          sourceSlot: "catalogue.genre.1",
          value: "Thriller",
          sourceRecordIds: ["catalogue-record"],
        },
        {
          property: "asset.genre",
          sourceSlot: "untrusted.genre.0",
          value: "Mystery",
          sourceRecordIds: ["untrusted-record"],
        },
      ],
    });

    expect(
      projection.values.map((value) => [
        value.value,
        value.sourceIdentity,
        value.reasoning,
      ]),
    ).toEqual([
      [
        "Drama",
        "catalogue",
        {
          kind: "preferred-source-absent-fallback",
          absentPreferredSources: ["tmdb", "omdb"],
          selectedFallbackSource: "catalogue",
        },
      ],
      [
        "Thriller",
        "catalogue",
        {
          kind: "preferred-source-absent-fallback",
          absentPreferredSources: ["tmdb", "omdb"],
          selectedFallbackSource: "catalogue",
        },
      ],
    ]);
    for (const selected of projection.values) {
      expect(selected.alternatives).toEqual([
        expect.objectContaining({
          value: "Mystery",
          sourceIdentity: "untrusted",
          exclusion: {
            kind: "deterministic-assertion-order",
            selectedSource: "catalogue",
            disagreesWithSelected: true,
          },
        }),
      ]);
    }
  });

  it("returns a no-value conflict when incomparable policies control the same property", () => {
    const projection = deriveEffectiveMetadata({
      subjectId: "asset-1",
      metadataUsageContext: "asset.ordinary",
      policies: [
        policy([exactRule]),
        {
          ...policy([
            {
              ...exactRule,
              preferredSourceIdentities: ["fallback", "preferred"],
            },
          ]),
          id: "competing",
        },
      ],
      sourceRecords: [{ id: "preferred-record", sourceIdentity: "preferred" }],
      metadata: [
        {
          property: "asset.title",
          sourceSlot: "preferred.title",
          value: "Preferred title",
          sourceRecordIds: ["preferred-record"],
        },
      ],
    });

    expect(projection.values).toEqual([]);
    expect(projection.conflicts).toEqual([
      expect.objectContaining({
        kind: "policy-conflict",
        property: "asset.title",
        metadataUsageContext: "asset.ordinary",
        policyIds: ["competing", "ordinary-display"],
        candidates: [
          expect.objectContaining({
            value: "Preferred title",
            sourceIdentity: "preferred",
            sourceRecordIds: ["preferred-record"],
            sourceSlot: "preferred.title",
          }),
        ],
      }),
    ]);
  });

  it("rejects duplicate rule coordinates because array order carries no precedence", () => {
    expect(() =>
      validateMetadataPolicy(
        policy([
          exactRule,
          { ...exactRule, preferredSourceIdentities: ["fallback"] },
        ]),
      ),
    ).toThrow("invalid or duplicate rule");
  });
});
