import { describe, expect, it } from "vitest";

import { validateSourceInterpretationBatch } from "../src/index.ts";

function batchWithSelectionEvidence(selectionEvidence: {
  readonly suggestedFilename?: string;
  readonly declaredByteLength?: number;
  readonly sourceOrdinal?: number;
}) {
  return {
    id: "batch",
    producer: {
      capabilityId: "source.interpreter",
      capabilityVersion: "1",
      contractVersion: "1",
    },
    sourceRecordIds: ["record"],
    sourceIdentity: "source",
    sourceAddress: "source:subject",
    metadata: [],
    sourceArtifacts: [
      {
        id: "candidate",
        sourceRecordId: "record",
        role: "source.attachment",
        acquisitionReference: "opaque-reference",
        mediaType: "application/octet-stream",
        selectionEvidence,
      },
    ],
  } as const;
}

describe("来源产物候选选择证据", () => {
  it("accepts a source-supplied filename, byte length, and ordinal", () => {
    const batch = batchWithSelectionEvidence({
      suggestedFilename: "official.zip",
      declaredByteLength: 42,
      sourceOrdinal: 0,
    });

    expect(validateSourceInterpretationBatch(batch)).toBe(batch);
  });

  it.each([
    { suggestedFilename: " \t " },
    { declaredByteLength: -1 },
    { declaredByteLength: 1.5 },
    { declaredByteLength: Number.MAX_SAFE_INTEGER + 1 },
    { sourceOrdinal: -1 },
    { sourceOrdinal: 1.5 },
    { sourceOrdinal: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unusable candidate selection evidence %#", (evidence) => {
    expect(() =>
      validateSourceInterpretationBatch(batchWithSelectionEvidence(evidence)),
    ).toThrow("Source Artifact Candidate selection evidence is invalid");
  });

  it("rejects provider-specific fields outside the candidate selection evidence contract", () => {
    const evidence = {
      sourceOrdinal: 0,
      providerDiagnostic: "provider-only-note",
    } as unknown as Parameters<typeof batchWithSelectionEvidence>[0];

    expect(() =>
      validateSourceInterpretationBatch(batchWithSelectionEvidence(evidence)),
    ).toThrow("Source Artifact Candidate selection evidence is invalid");
  });
});
