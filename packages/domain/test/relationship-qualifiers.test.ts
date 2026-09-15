import { describe, expect, it } from "vitest";

import { validateSourceInterpretationBatch } from "../src/index.ts";

describe("Entity Relationship qualifiers", () => {
  const batch = (relationship: Record<string, unknown>) => ({
    id: "batch",
    producer: {
      capabilityId: "test",
      capabilityVersion: "1",
      contractVersion: "1",
    },
    sourceRecordIds: ["record"],
    sourceIdentity: "test",
    sourceAddress: "test:subject",
    metadata: [],
    sourceArtifacts: [],
    entities: [
      {
        id: "character",
        kind: "entity" as const,
        sourceIdentity: "test",
        sourceKey: "character",
        identityNamespace: "test.character",
        label: "Character",
        sourceRecordIds: ["record"],
      },
      {
        id: "performer",
        kind: "entity" as const,
        sourceIdentity: "test",
        sourceKey: "performer",
        identityNamespace: "test.performer",
        label: "Performer",
        sourceRecordIds: ["record"],
      },
    ],
    relationships: [relationship],
  });

  it("accepts one fact with named participants and permits one entity in distinct roles", () => {
    expect(() =>
      validateSourceInterpretationBatch(
        batch({
          participants: [
            { entityId: "character", role: "character" },
            { entityId: "performer", role: "performer" },
            { entityId: "performer", role: "credited-as" },
          ],
          subjectRole: "asset",
          requiredRoles: ["asset", "character", "performer", "credited-as"],
          type: "asset.performance",
          sourceSlot: "performance.1",
          sourceRecordIds: ["record"],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a relationship that omits one declared required role", () => {
    expect(() =>
      validateSourceInterpretationBatch(
        batch({
          participants: [{ entityId: "character", role: "character" }],
          subjectRole: "asset",
          requiredRoles: ["asset", "character", "performer"],
          type: "asset.performance",
          sourceSlot: "performance.1",
          sourceRecordIds: ["record"],
        }),
      ),
    ).toThrow("Entity Relationship violates its interpretation contract");
  });

  it("rejects an explicit relationship with fewer than two total participants", () => {
    expect(() =>
      validateSourceInterpretationBatch(
        batch({
          participants: [{ entityId: "character", role: "character" }],
          type: "asset.performance",
          sourceSlot: "performance.1",
          sourceRecordIds: ["record"],
        }),
      ),
    ).toThrow("Entity Relationship violates its interpretation contract");
  });

  it("requires an explicit lifecycle owner for a complete source relationship", () => {
    expect(() =>
      validateSourceInterpretationBatch(
        batch({
          participants: [
            { entityId: "character", role: "character" },
            { entityId: "performer", role: "performer" },
          ],
          type: "asset.performance",
          sourceSlot: "performance.1",
          sourceRecordIds: ["record"],
        }),
      ),
    ).toThrow("Entity Relationship violates its interpretation contract");
  });

  it("rejects an empty qualifier rather than silently preserving an unusable relationship context", () => {
    expect(() =>
      validateSourceInterpretationBatch(
        batch({
          participants: [{ entityId: "performer", role: "cast" }],
          subjectRole: "asset",
          requiredRoles: ["asset", "cast"],
          type: "asset.contribution",
          sourceSlot: "credit.1",
          sourceRecordIds: ["record"],
          qualifiers: [{ key: "", value: "" }],
        }),
      ),
    ).toThrow("Entity Relationship qualifier is invalid");
  });
});
