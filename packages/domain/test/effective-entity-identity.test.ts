import { deriveEffectiveEntityIdentity } from "@digital/domain";
import { describe, expect, it } from "vitest";

describe("生效实体身份", () => {
  it("沿有向合并森林解析代表，并只撤回精确边", () => {
    const input = {
      entityIds: ["a", "b", "c"],
      merges: [
        {
          id: "b-into-a",
          retainedEntityId: "a",
          mergedEntityId: "b",
          actorId: "user:甲",
          commitmentId: "1",
        },
        {
          id: "c-into-b",
          retainedEntityId: "b",
          mergedEntityId: "c",
          actorId: "user:甲",
          commitmentId: "2",
        },
      ],
      retractions: [],
    };
    expect(deriveEffectiveEntityIdentity(input).representativeByEntity).toEqual(
      new Map([
        ["a", "a"],
        ["b", "a"],
        ["c", "a"],
      ]),
    );
    expect(
      deriveEffectiveEntityIdentity({
        ...input,
        retractions: [
          {
            id: "undo",
            mergeId: "b-into-a",
            actorId: "user:甲",
            commitmentId: "undo/1",
          },
        ],
      }).representativeByEntity,
    ).toEqual(
      new Map([
        ["a", "a"],
        ["b", "b"],
        ["c", "b"],
      ]),
    );
  });

  it("拒绝缺端点、重复被并入边和环", () => {
    const merge = {
      id: "merge",
      retainedEntityId: "a",
      mergedEntityId: "b",
      actorId: "user:甲",
      commitmentId: "1",
    };
    for (const merges of [
      [{ ...merge, retainedEntityId: "missing" }],
      [merge, { ...merge, id: "second", retainedEntityId: "c" }],
      [
        merge,
        { ...merge, id: "cycle", retainedEntityId: "b", mergedEntityId: "a" },
      ],
    ])
      expect(() =>
        deriveEffectiveEntityIdentity({
          entityIds: ["a", "b", "c"],
          merges,
          retractions: [],
        }),
      ).toThrow("实体身份合并");
  });
});
