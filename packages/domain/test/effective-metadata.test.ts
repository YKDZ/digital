import { describe, expect, it } from "vitest";

import {
  deriveEffectiveMetadata,
  projectMetadataDecisionHead,
  type EffectiveMetadataInput,
  type MetadataDecision,
  type MetadataAssertion,
  type MetadataPolicy,
  type MetadataPolicyRule,
  validateMetadataPolicy,
} from "../src/index.ts";

const assetTarget = { kind: "entity", entityId: "asset-1" } as const;

function deriveAssetMetadata(
  input: Omit<EffectiveMetadataInput, "target" | "metadata"> & {
    readonly metadata: readonly Omit<MetadataAssertion, "target">[];
  },
) {
  return deriveEffectiveMetadata({
    ...input,
    target: assetTarget,
    metadata: input.metadata.map((assertion) => ({
      ...assertion,
      target: assetTarget,
    })),
  });
}

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
  return deriveAssetMetadata({
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
  it("坐标内的人工 pin 覆盖来源值和旧本地人工事实，且不改写其余属性", () => {
    const initialManual = {
      property: "asset.title",
      sourceSlot: "manual-boundary",
      value: "最初录入标题",
      sourceRecordIds: [],
      authoredBy: { initiatedBy: "local-user", proposalId: "initial" },
    };
    const decision: MetadataDecision = {
      id: "decision-1",
      target: assetTarget,
      property: "asset.title",
      metadataUsageContext: "asset.ordinary",
      kind: "pin",
      value: "人工修订标题",
      initiatedBy: "local-user",
    };
    const projection = deriveAssetMetadata({
      metadataUsageContext: "asset.ordinary",
      sourceRecords: [{ id: "source-1", sourceIdentity: "source-a" }],
      metadata: [
        initialManual,
        {
          property: "asset.title",
          sourceSlot: "source.title",
          value: "来源标题",
          sourceRecordIds: ["source-1"],
        },
        {
          property: "asset.title.year",
          sourceSlot: "source.year",
          value: "2026",
          sourceRecordIds: ["source-1"],
        },
      ],
      metadataDecisions: [decision],
    });

    expect(projection.conflicts).toEqual([]);
    expect(projection.values).toEqual([
      expect.objectContaining({
        property: "asset.title",
        value: "人工修订标题",
        sourceIdentity: "user",
        sourceRecordIds: [],
        selectedAssertion: expect.objectContaining({
          sourceSlot: "manual.metadata-decision",
          value: "人工修订标题",
        }),
      }),
      expect.objectContaining({ property: "asset.title.year", value: "2026" }),
    ]);
  });

  it("清除坐标 pin 后重新采用当前基础事实，包括最初的人工边界判断", () => {
    const initialManual = {
      property: "asset.title",
      sourceSlot: "manual-boundary",
      value: "最初录入标题",
      sourceRecordIds: [],
      authoredBy: { initiatedBy: "local-user", proposalId: "initial" },
    };
    const clear: MetadataDecision = {
      id: "decision-2",
      target: assetTarget,
      property: "asset.title",
      metadataUsageContext: "asset.ordinary",
      kind: "clear",
      predecessorDecisionId: "decision-1",
      initiatedBy: "local-user",
    };
    const projection = deriveAssetMetadata({
      metadataUsageContext: "asset.ordinary",
      sourceRecords: [{ id: "source-1", sourceIdentity: "source-a" }],
      metadata: [
        initialManual,
        {
          property: "asset.title",
          sourceSlot: "source.title",
          value: "来源标题",
          sourceRecordIds: ["source-1"],
        },
      ],
      metadataDecisions: [clear],
    });

    expect(projection.conflicts).toEqual([]);
    expect(projection.values).toEqual([
      expect.objectContaining({
        property: "asset.title",
        value: "最初录入标题",
        sourceIdentity: "user",
        selectedAssertion: expect.objectContaining({
          sourceSlot: "manual-boundary",
        }),
      }),
    ]);
  });

  it("采纳真实冲突候选后固定该值并保留精确候选依据", () => {
    const decision: MetadataDecision = {
      id: "decision-3",
      target: assetTarget,
      property: "asset.title",
      metadataUsageContext: "asset.ordinary",
      kind: "pin",
      value: "候选甲",
      initiatedBy: "local-user",
      adoptedFrom: {
        sourceIdentity: "source-a",
        sourceSlot: "source.title",
        sourceRecordIds: ["source-a-record"],
      },
    };
    const input: Omit<EffectiveMetadataInput, "target" | "metadata"> & {
      readonly metadata: readonly Omit<MetadataAssertion, "target">[];
    } = {
      metadataUsageContext: "asset.ordinary",
      policies: [
        policy([
          {
            property: "asset.title",
            preferredSourceIdentities: [],
            cardinality: "one",
          },
        ]),
      ],
      sourceRecords: [
        { id: "source-a-record", sourceIdentity: "source-a" },
        { id: "source-b-record", sourceIdentity: "source-b" },
      ],
      metadata: [
        {
          property: "asset.title",
          sourceSlot: "source.title",
          value: "候选甲",
          sourceRecordIds: ["source-a-record"],
        },
        {
          property: "asset.title",
          sourceSlot: "source.title",
          value: "候选乙",
          sourceRecordIds: ["source-b-record"],
        },
      ],
      metadataDecisions: [decision],
    };
    const projection = deriveAssetMetadata(input);

    expect(projection.conflicts).toEqual([]);
    expect(projection.values).toEqual([
      expect.objectContaining({
        value: "候选甲",
        sourceIdentity: "user",
        sourceRecordIds: [],
      }),
    ]);
    expect(decision.adoptedFrom).toEqual({
      sourceIdentity: "source-a",
      sourceSlot: "source.title",
      sourceRecordIds: ["source-a-record"],
    });
  });

  it("人工 pin 越过元数据策略冲突，clear 后重新显示当前冲突", () => {
    const sourceAssertions = [
      {
        property: "asset.title",
        sourceSlot: "source-a.title",
        value: "来源甲标题",
        sourceRecordIds: ["source-a-record"],
      },
      {
        property: "asset.title",
        sourceSlot: "source-b.title",
        value: "来源乙标题",
        sourceRecordIds: ["source-b-record"],
      },
    ] as const;
    const policies = [
      {
        ...policy([
          {
            property: "asset.title",
            preferredSourceIdentities: ["source-a"],
            cardinality: "one",
          },
        ]),
        id: "policy-a",
      },
      {
        ...policy([
          {
            property: "asset.title",
            preferredSourceIdentities: ["source-b"],
            cardinality: "one",
          },
        ]),
        id: "policy-b",
      },
    ];
    const base = {
      metadataUsageContext: "asset.ordinary",
      policies,
      sourceRecords: [
        { id: "source-a-record", sourceIdentity: "source-a" },
        { id: "source-b-record", sourceIdentity: "source-b" },
      ],
      metadata: sourceAssertions,
    } as const;
    const original = deriveAssetMetadata(base);
    expect(original.values).toEqual([]);
    expect(original.conflicts).toEqual([
      expect.objectContaining({ kind: "policy-conflict" }),
    ]);

    const pin: MetadataDecision = {
      id: "pin-1",
      target: assetTarget,
      property: "asset.title",
      metadataUsageContext: "asset.ordinary",
      kind: "pin",
      value: "人工优先标题",
      initiatedBy: "local-user",
    };
    const pinned = deriveAssetMetadata({ ...base, metadataDecisions: [pin] });
    expect(pinned.conflicts).toEqual([]);
    expect(pinned.values).toEqual([
      expect.objectContaining({
        property: "asset.title",
        value: "人工优先标题",
        sourceIdentity: "user",
      }),
    ]);

    const clear: MetadataDecision = {
      id: "clear-1",
      target: assetTarget,
      property: "asset.title",
      metadataUsageContext: "asset.ordinary",
      kind: "clear",
      predecessorDecisionId: pin.id,
      initiatedBy: "local-user",
    };
    const cleared = deriveAssetMetadata({
      ...base,
      metadataDecisions: [clear],
    });
    expect(cleared.values).toEqual([]);
    expect(cleared.conflicts).toEqual([
      expect.objectContaining({ kind: "policy-conflict" }),
    ]);
  });

  it("新决定只替换相同目标、属性和语境坐标的头", () => {
    const first: MetadataDecision = {
      id: "title-ordinary",
      target: assetTarget,
      property: "asset.title",
      metadataUsageContext: "asset.ordinary",
      kind: "pin",
      value: "人工标题",
      initiatedBy: "local-user",
    };
    const otherContext: MetadataDecision = {
      ...first,
      id: "title-email",
      metadataUsageContext: "email.subject",
    };
    const next: MetadataDecision = {
      id: "title-ordinary-next",
      target: assetTarget,
      property: "asset.title",
      metadataUsageContext: "asset.ordinary",
      kind: "clear",
      predecessorDecisionId: first.id,
      initiatedBy: "local-user",
    };

    expect(projectMetadataDecisionHead([first, otherContext], next)).toEqual([
      otherContext,
      next,
    ]);
  });

  it("单值语境不会从同一优先来源的不同值中任选首项", () => {
    const projection = deriveAssetMetadata({
      metadataUsageContext: "asset.ordinary",
      policies: [policy([exactRule])],
      sourceRecords: [{ id: "preferred-record", sourceIdentity: "preferred" }],
      metadata: [
        {
          property: "asset.title",
          sourceSlot: "preferred.title.0",
          value: "第一个标题",
          sourceRecordIds: ["preferred-record"],
        },
        {
          property: "asset.title",
          sourceSlot: "preferred.title.1",
          value: "第二个标题",
          sourceRecordIds: ["preferred-record"],
        },
      ],
    });

    expect(projection.values).toEqual([]);
    expect(projection.conflicts).toEqual([
      expect.objectContaining({
        kind: "metadata-value-conflict",
        property: "asset.title",
        metadataUsageContext: "asset.ordinary",
        candidates: [
          expect.objectContaining({ value: "第一个标题" }),
          expect.objectContaining({ value: "第二个标题" }),
        ],
      }),
    ]);
  });

  it("语义相同的多来源断言形成一个保留全部贡献来源的值", () => {
    const projection = deriveAssetMetadata({
      metadataUsageContext: "asset.ordinary",
      policies: [policy([exactRule])],
      sourceRecords: [
        { id: "preferred-record", sourceIdentity: "preferred" },
        { id: "fallback-record", sourceIdentity: "fallback" },
      ],
      metadata: [
        {
          property: "asset.title",
          sourceSlot: "preferred.title",
          value: "同一标题",
          sourceRecordIds: ["preferred-record"],
        },
        {
          property: "asset.title",
          sourceSlot: "fallback.title",
          value: "同一标题",
          sourceRecordIds: ["fallback-record"],
        },
      ],
    });

    expect(projection.conflicts).toEqual([]);
    expect(projection.values).toEqual([
      expect.objectContaining({
        value: "同一标题",
        sourceRecordIds: ["preferred-record", "fallback-record"],
        contributingAssertions: [
          expect.objectContaining({ sourceSlot: "preferred.title" }),
          expect.objectContaining({ sourceSlot: "fallback.title" }),
        ],
        alternatives: [],
      }),
    ]);
  });

  it("未排序来源给出不同单值时形成冲突而不按来源名任选", () => {
    const projection = deriveAssetMetadata({
      metadataUsageContext: "asset.ordinary",
      policies: [
        policy([
          {
            property: "asset.title",
            preferredSourceIdentities: ["absent"],
            cardinality: "one",
          },
        ]),
      ],
      sourceRecords: [
        { id: "alpha-record", sourceIdentity: "alpha" },
        { id: "zeta-record", sourceIdentity: "zeta" },
      ],
      metadata: [
        {
          property: "asset.title",
          sourceSlot: "alpha.title",
          value: "甲标题",
          sourceRecordIds: ["alpha-record"],
        },
        {
          property: "asset.title",
          sourceSlot: "zeta.title",
          value: "乙标题",
          sourceRecordIds: ["zeta-record"],
        },
      ],
    });

    expect(projection.values).toEqual([]);
    expect(projection.conflicts).toEqual([
      expect.objectContaining({
        kind: "metadata-value-conflict",
        candidates: [
          expect.objectContaining({ value: "甲标题" }),
          expect.objectContaining({ value: "乙标题" }),
        ],
      }),
    ]);
  });

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
            target: assetTarget,
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
    const projection = deriveAssetMetadata({
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
    const projection = deriveAssetMetadata({
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
    const projection = deriveAssetMetadata({
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
    expect(projection.values[0]).toEqual(
      expect.objectContaining({
        value: "Drama",
        sourceRecordIds: ["tmdb-record", "omdb-record"],
        contributingAssertions: [
          expect.objectContaining({ sourceSlot: "tmdb.movie.genre.0" }),
          expect.objectContaining({ sourceSlot: "omdb.movie.genre.0" }),
        ],
      }),
    );
  });

  it("全部首选来源缺失时保留所有未排序的多值而不按来源名选择", () => {
    const projection = deriveAssetMetadata({
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
          kind: "preferred-sources-absent-unranked",
          absentPreferredSources: ["tmdb", "omdb"],
        },
      ],
      [
        "Thriller",
        "catalogue",
        {
          kind: "preferred-sources-absent-unranked",
          absentPreferredSources: ["tmdb", "omdb"],
        },
      ],
      [
        "Mystery",
        "untrusted",
        {
          kind: "preferred-sources-absent-unranked",
          absentPreferredSources: ["tmdb", "omdb"],
        },
      ],
    ]);
    expect(
      projection.values.every((selected) => selected.alternatives.length === 0),
    ).toBe(true);
  });

  it("returns a no-value conflict when incomparable policies control the same property", () => {
    const projection = deriveAssetMetadata({
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
