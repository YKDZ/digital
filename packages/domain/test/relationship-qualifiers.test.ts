import { describe, expect, it } from "vitest";

import { validateSourceInterpretationBatch } from "../src/index.ts";

describe("Entity Relationship qualifiers", () => {
  it("rejects an empty qualifier rather than silently preserving an unusable relationship context", () => {
    expect(() =>
      validateSourceInterpretationBatch({
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
            id: "person",
            kind: "entity",
            sourceIdentity: "test",
            sourceKey: "person",
            identityNamespace: "test.person",
            label: "Person",
            sourceRecordIds: ["record"],
          },
        ],
        relationships: [
          {
            participantId: "person",
            type: "asset.contribution",
            role: "cast",
            sourceSlot: "credit.1",
            sourceRecordIds: ["record"],
            qualifiers: [{ key: "", value: "" }],
          },
        ],
      }),
    ).toThrow("Entity Relationship qualifier is invalid");
  });
});
