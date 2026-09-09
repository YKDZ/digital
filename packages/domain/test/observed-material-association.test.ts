import { describe, expect, it } from "vitest";

import {
  validateObservedMaterialAssociationSubmission,
  validateRecognitionProposal,
  type ArtifactAssociationRecognitionSupport,
  type ObservedMaterialAssociationSubmission,
  type RecognitionProposal,
} from "../src/index.ts";

describe("observed material association", () => {
  const proposal: RecognitionProposal = {
    id: "proposal-materials",
    basis: {
      kind: "manual-boundary",
      proposedBy: "person-1",
      observationSnapshotId: "snapshot-1",
      materialReferences: ["book.pdf", "notes.txt"],
      revisesProposalIds: [],
      metadata: [],
      evidence: [],
    },
    ruleResults: [],
    observedArtifactAssociations: [
      {
        observedArtifactReference: "book.pdf",
        role: "asset.material-delivered",
      },
      {
        observedArtifactReference: "notes.txt",
        role: "asset.material-delivered",
      },
    ],
    observedArtifactRevisions: [
      {
        observedArtifactReference: "book.pdf",
        blob: {
          digest: "pdf-digest",
          mediaType: "application/pdf",
          byteLength: 42,
        },
        producer: {
          capabilityId: "pdf",
          capabilityVersion: "1",
          contractVersion: "pdf/1",
        },
      },
      {
        observedArtifactReference: "notes.txt",
        blob: {
          digest: "text-digest",
          mediaType: "application/octet-stream",
          byteLength: 5,
        },
        producer: {
          capabilityId: "whole-file",
          capabilityVersion: "1",
          contractVersion: "whole-file/1",
        },
      },
    ],
  };

  const submission = (): ObservedMaterialAssociationSubmission => ({
    proposal,
    recognitionDecision: {
      id: "decision-materials",
      proposalId: proposal.id,
      assetId: "asset-existing",
      acceptedRuleResults: [],
    },
    artifacts: [{ id: "artifact-pdf" }, { id: "artifact-text" }],
    locations: [
      {
        id: "location-pdf",
        artifactId: "artifact-pdf",
        address: "/observed/book.pdf",
        kind: "observed",
      },
      {
        id: "location-text",
        artifactId: "artifact-text",
        address: "/observed/notes.txt",
        kind: "observed",
      },
    ],
    blobs: [
      { digest: "pdf-digest", mediaType: "application/pdf", byteLength: 42 },
      {
        digest: "text-digest",
        mediaType: "application/octet-stream",
        byteLength: 5,
      },
    ],
    artifactRevisions: [
      {
        id: "revision-pdf",
        artifactId: "artifact-pdf",
        blobDigest: "pdf-digest",
      },
      {
        id: "revision-text",
        artifactId: "artifact-text",
        blobDigest: "text-digest",
      },
    ],
    artifactAssociations: [
      {
        id: "association-pdf",
        subjectId: "asset-existing",
        artifactId: "artifact-pdf",
        role: "asset.material-delivered",
      },
      {
        id: "association-text",
        subjectId: "asset-existing",
        artifactId: "artifact-text",
        role: "asset.material-delivered",
      },
    ],
    projections: [
      {
        observedArtifactReference: "book.pdf",
        artifactId: "artifact-pdf",
        locationId: "location-pdf",
        revisionId: "revision-pdf",
        associationId: "association-pdf",
      },
      {
        observedArtifactReference: "notes.txt",
        artifactId: "artifact-text",
        locationId: "location-text",
        revisionId: "revision-text",
        associationId: "association-text",
      },
    ],
    supports: [
      {
        associationId: "association-pdf",
        recognitionDecisionId: "decision-materials",
      },
      {
        associationId: "association-text",
        recognitionDecisionId: "decision-materials",
      },
    ],
  });

  it("accepts one complete manual proposal projected to one target and decision support", () => {
    expect(validateRecognitionProposal(proposal)).toBe(proposal);
    const value = submission();
    expect(validateObservedMaterialAssociationSubmission(value)).toBe(value);
  });

  it.each([
    [
      "a non-whole role",
      (value: ObservedMaterialAssociationSubmission) => ({
        ...value,
        artifactAssociations: [
          { ...value.artifactAssociations[0]!, role: "asset.cover" },
          value.artifactAssociations[1]!,
        ],
      }),
    ],
    [
      "a cross-subject association",
      (value: ObservedMaterialAssociationSubmission) => ({
        ...value,
        artifactAssociations: [
          { ...value.artifactAssociations[0]!, subjectId: "asset-other" },
          value.artifactAssociations[1]!,
        ],
      }),
    ],
    [
      "a dangling support",
      (value: ObservedMaterialAssociationSubmission) => ({
        ...value,
        supports: [
          {
            associationId: "missing-association",
            recognitionDecisionId: "decision-materials",
          },
        ] as readonly ArtifactAssociationRecognitionSupport[],
      }),
    ],
  ])("rejects %s", (_, mutate) => {
    expect(() =>
      validateObservedMaterialAssociationSubmission(mutate(submission())),
    ).toThrow();
  });

  it("allows a second independent decision support without duplicating the association", () => {
    const value = submission();
    expect(
      validateObservedMaterialAssociationSubmission(value, {
        knownDecisions: [
          {
            id: "decision-other",
            proposalId: "proposal-other",
            assetId: "asset-existing",
            acceptedRuleResults: [],
          },
        ],
        additionalSupports: [
          {
            associationId: "association-pdf",
            recognitionDecisionId: "decision-other",
          },
        ],
      }),
    ).toBe(value);
  });

  it("rejects a batch that omits one selected material projection", () => {
    const value = submission();
    expect(() =>
      validateObservedMaterialAssociationSubmission({
        ...value,
        artifactAssociations: [value.artifactAssociations[0]!],
        supports: [value.supports[0]!],
      }),
    ).toThrow();
  });

  it("rejects facts that are not reachable from a selected material", () => {
    const value = submission();
    expect(() =>
      validateObservedMaterialAssociationSubmission({
        ...value,
        artifacts: [...value.artifacts, { id: "artifact-orphan" }],
      }),
    ).toThrow();
  });
});
