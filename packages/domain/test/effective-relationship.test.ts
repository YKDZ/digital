import { describe, expect, it } from "vitest";

import { deriveEffectiveRelationships } from "../src/index.ts";
import type {
  EffectiveRelationshipInput,
  RelationshipDecisionTarget,
} from "../src/index.ts";

const sourceTarget = (sourceSlot: string): RelationshipDecisionTarget => ({
  kind: "source",
  sourceSubjectId: "series",
  sourceIdentity: "fixture",
  nativeAddress: "fixture:address",
  coverageId: "fixture.coverage",
  sourceSlot,
});

/** 同类型同参与者，仅来源槽位或限定项不同：正是旧整体坐标会误伤的事实形状。 */
const fact = (id: string, position: string, slot = id) => ({
  id,
  type: "asset.membership",
  sourceSlot: slot,
  sourceRecordIds: [id],
  participants: [
    { entityId: "work", role: "member" },
    { entityId: "series", role: "series" },
    { entityId: "performer", role: "performer" },
  ],
  qualifiers: [{ key: "asset.membership.position", value: position }],
});

const manual = { ...fact("manual", "7", "manual"), sourceRecordIds: [] };

function project(
  relationships: EffectiveRelationshipInput["relationships"],
  targets: ReadonlyMap<string, RelationshipDecisionTarget>,
  decisions: EffectiveRelationshipInput["decisions"],
  manualRelationshipIds: readonly string[],
): readonly string[] {
  return deriveEffectiveRelationships({
    relationships,
    targets,
    decisions,
    manualRelationshipIds: new Set(manualRelationshipIds),
  }).map(({ id }) => id);
}

describe("effective entity relationships", () => {
  it("决定只作用于被点名事实的支持范围，同类型同参与者的其他事实保持生效", () => {
    const first = fact("first", "1");
    const second = fact("second", "2");
    const targets = new Map([
      [first.id, sourceTarget(first.sourceSlot)],
      [second.id, sourceTarget(second.sourceSlot)],
    ]);
    expect(project([first, second], targets, [], [])).toEqual([
      "first",
      "second",
    ]);
    expect(
      project(
        [first, second],
        targets,
        [
          {
            id: "exclude-first",
            kind: "exclude",
            target: sourceTarget(first.sourceSlot),
          },
        ],
        [],
      ),
    ).toEqual(["second"]);
    expect(
      project(
        [first, second],
        targets,
        [
          {
            id: "select-first",
            kind: "select",
            target: sourceTarget(first.sourceSlot),
          },
        ],
        [],
      ),
    ).toEqual(["first", "second"]);
  });

  it("更正只让选中目标的人工事实生效，清除回到当前来源事实", () => {
    const withdrawn = fact("withdrawn", "1");
    const current = fact("current", "2");
    const correctedTarget = sourceTarget(current.sourceSlot);
    const targets = new Map([
      [withdrawn.id, sourceTarget(withdrawn.sourceSlot)],
      [current.id, correctedTarget],
      [manual.id, correctedTarget],
    ]);
    const correction = {
      id: "decision",
      kind: "fix" as const,
      target: correctedTarget,
      manualRelationshipId: manual.id,
    };
    expect(
      project([withdrawn, current, manual], targets, [correction], [manual.id]),
    ).toEqual(["withdrawn", "manual"]);
    expect(
      project(
        [current, manual],
        targets,
        [{ ...correction, kind: "clear" as const }],
        [manual.id],
      ),
    ).toEqual(["current"]);
  });

  it("人工目标的选择与清除各自只作用于该人工事实", () => {
    const manualTarget: RelationshipDecisionTarget = {
      kind: "manual",
      targetId: "manual-target",
    };
    const targets = new Map([[manual.id, manualTarget]]);
    expect(
      project(
        [manual],
        targets,
        [{ id: "select", kind: "select", target: manualTarget }],
        [manual.id],
      ),
    ).toEqual(["manual"]);
    expect(
      project(
        [manual],
        targets,
        [{ id: "clear", kind: "clear", target: manualTarget }],
        [manual.id],
      ),
    ).toEqual([]);
  });

  it("缺少支持范围的事实无法被决定归属", () => {
    expect(() => project([fact("orphan", "1")], new Map(), [], [])).toThrow(
      "关系事实缺少可解析的决定目标",
    );
  });
});
