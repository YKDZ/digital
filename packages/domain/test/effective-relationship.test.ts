import { describe, expect, it } from "vitest";

import { deriveEffectiveRelationships } from "../src/index.ts";

const source = (id: string, position: string) => ({
  id,
  type: "asset.membership",
  sourceSlot: id,
  sourceRecordIds: [id],
  participants: [
    { entityId: "work", role: "member" },
    { entityId: "series", role: "series" },
    { entityId: "performer", role: "performer" },
  ],
  qualifiers: [{ key: "asset.membership.position", value: position }],
});

describe("effective entity relationships", () => {
  it("keeps a manual correction across source replacement and clear returns only current source facts", () => {
    const corrected = {
      ...source("manual", "7"),
      sourceRecordIds: [],
      sourceSlot: "manual",
    };
    const decision = {
      id: "decision",
      kind: "fix" as const,
      coordinate: {
        type: corrected.type,
        participants: corrected.participants,
      },
      relationshipIds: [],
      manualRelationshipId: corrected.id,
    };
    expect(
      deriveEffectiveRelationships({
        relationships: [
          source("withdrawn", "1"),
          source("current", "2"),
          corrected,
        ],
        decisions: [decision],
        manualRelationshipDecisionIds: new Map([[corrected.id, decision.id]]),
      }).map(({ id }) => id),
    ).toEqual(["manual"]);
    expect(
      deriveEffectiveRelationships({
        relationships: [source("current", "2"), corrected],
        decisions: [{ ...decision, kind: "clear" as const }],
        manualRelationshipDecisionIds: new Map([[corrected.id, decision.id]]),
      }).map(({ id }) => id),
    ).toEqual(["current"]);
  });

  it("selects or excludes only the explicit support and never overwrites another relationship position", () => {
    const first = source("first", "1");
    const second = source("second", "2");
    const otherSeries = {
      ...source("other-series", "9"),
      participants: [
        { entityId: "work", role: "member" },
        { entityId: "another-series", role: "series" },
        { entityId: "performer", role: "performer" },
      ],
    };
    const coordinate = { type: first.type, participants: first.participants };
    expect(
      deriveEffectiveRelationships({
        relationships: [first, second, otherSeries],
        decisions: [
          {
            id: "select",
            kind: "select",
            coordinate,
            relationshipIds: [second.id],
          },
        ],
        manualRelationshipDecisionIds: new Map(),
      }).map(({ id }) => id),
    ).toEqual(["second", "other-series"]);
    expect(
      deriveEffectiveRelationships({
        relationships: [first, second, otherSeries],
        decisions: [
          {
            id: "exclude",
            kind: "exclude",
            coordinate,
            relationshipIds: [first.id],
          },
        ],
        manualRelationshipDecisionIds: new Map(),
      }).map(({ id }) => id),
    ).toEqual(["second", "other-series"]);
  });
});
