import { describe, expect, it } from "vitest";

import { deriveEffectiveArtifactAssociation } from "../src/index.ts";

const target = { kind: "entity" as const, entityId: "asset" };
const sources = [
  {
    id: "source-dlsite",
    subjectId: "asset",
    sourceIdentity: "dlsite",
    nativeAddress: "RJ1",
  },
];

describe("生效产物关联", () => {
  it("选择产品优先来源，且不受输入顺序影响", () => {
    const local = {
      id: "z",
      target,
      artifactId: "local-cover",
      role: "asset.primary-cover",
    };
    const official = {
      id: "a",
      target,
      artifactId: "official-cover",
      role: "asset.primary-cover",
      sourceAssociationId: "source-dlsite",
    };
    for (const associations of [
      [local, official],
      [official, local],
    ])
      expect(
        deriveEffectiveArtifactAssociation({
          target,
          role: "asset.primary-cover",
          associations,
          sourceAssociations: sources,
          preferredSourceIdentities: ["dlsite"],
        }),
      ).toMatchObject({ association: { artifactId: "official-cover" } });
  });

  it("同等合格的不同产物形成冲突，而不是按关联标识取首项", () => {
    const result = deriveEffectiveArtifactAssociation({
      target,
      role: "asset.primary-cover",
      associations: [
        { id: "z", target, artifactId: "cover-z", role: "asset.primary-cover" },
        { id: "a", target, artifactId: "cover-a", role: "asset.primary-cover" },
      ],
      sourceAssociations: [],
    });
    expect(result).toMatchObject({ kind: "artifact-association-conflict" });
  });

  it("同一产物的多项事实合并并保留全部贡献关联", () => {
    const associations = [
      { id: "first", target, artifactId: "cover", role: "asset.primary-cover" },
      {
        id: "second",
        target,
        artifactId: "cover",
        role: "asset.primary-cover",
      },
    ];
    expect(
      deriveEffectiveArtifactAssociation({
        target,
        role: "asset.primary-cover",
        associations,
        sourceAssociations: [],
      }),
    ).toMatchObject({
      association: { artifactId: "cover" },
      contributingAssociations: associations,
    });
  });
});
