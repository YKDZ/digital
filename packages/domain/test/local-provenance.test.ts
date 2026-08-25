import { describe, expect, it } from "vitest";

import {
  validateAcceptedRecognition,
  validateReevaluatedRecognition,
  type AcceptedRecognition,
} from "../src/index.ts";

function accepted(): AcceptedRecognition {
  const proposal = {
    id: "proposal",
    interpretation: {
      id: "interpretation",
      producer: {
        capabilityId: "source",
        capabilityVersion: "1",
        contractVersion: "1",
      },
      sourceRecordIds: ["official-record"],
      sourceIdentity: "official",
      sourceAddress: "https://example.test/book",
      metadata: [],
      sourceArtifacts: [],
    },
    ruleResults: [
      {
        capabilityId: "recognizer",
        capabilityVersion: "1",
        ruleId: "exact",
        ruleVersion: "1",
        outcome: "satisfied" as const,
        explanation: "exact",
        evidence: [],
      },
    ],
  };
  return {
    proposal,
    entity: { id: "asset", kind: "digital-asset" },
    sourceAssociation: {
      id: "association",
      subjectId: "asset",
      sourceIdentity: "official",
      nativeAddress: "https://example.test/book",
      proposalId: "proposal",
    },
    recognitionDecision: {
      id: "decision",
      proposalId: "proposal",
      assetId: "asset",
      acceptedRuleResults: proposal.ruleResults,
    },
    artifacts: [{ id: "epub" }, { id: "cover" }],
    locations: [],
    blobs: [
      {
        digest: "epub-digest",
        mediaType: "application/epub+zip",
        byteLength: 1,
      },
      { digest: "cover-digest", mediaType: "image/jpeg", byteLength: 1 },
    ],
    artifactRevisions: [
      { id: "epub-revision", artifactId: "epub", blobDigest: "epub-digest" },
      { id: "cover-revision", artifactId: "cover", blobDigest: "cover-digest" },
    ],
    artifactAssociations: [
      {
        id: "cover-association",
        subjectId: "asset",
        artifactId: "cover",
        role: "asset.primary-cover",
        observedArtifactPart: {
          artifactId: "epub",
          revisionId: "epub-revision",
          locator: "epub:cover",
        },
      },
    ],
    metadata: [
      {
        property: "asset.title",
        sourceSlot: "epub.opf.title",
        value: "本地标题",
        sourceRecordIds: [],
        observedArtifactPart: {
          artifactId: "epub",
          revisionId: "epub-revision",
          locator: "epub:opf/dc:title[1]",
        },
      },
    ],
  };
}

describe("local format provenance", () => {
  it.each([
    [
      "Source Association proposal",
      (value: AcceptedRecognition): AcceptedRecognition => ({
        ...value,
        sourceAssociation: {
          ...value.sourceAssociation,
          proposalId: "different-proposal",
        },
      }),
      "Source Association must reference the accepted Recognition Proposal",
    ],
    [
      "Recognition Decision proposal",
      (value: AcceptedRecognition): AcceptedRecognition => ({
        ...value,
        recognitionDecision: {
          ...value.recognitionDecision,
          proposalId: "different-proposal",
        },
      }),
      "Recognition Decision must reference the accepted Recognition Proposal",
    ],
    [
      "Source Association identity",
      (value: AcceptedRecognition): AcceptedRecognition => ({
        ...value,
        sourceAssociation: {
          ...value.sourceAssociation,
          sourceIdentity: "different-source",
        },
      }),
      "Source Association must match the Recognition Proposal source identity",
    ],
    [
      "Source Association address",
      (value: AcceptedRecognition): AcceptedRecognition => ({
        ...value,
        sourceAssociation: {
          ...value.sourceAssociation,
          nativeAddress: "https://example.test/different-book",
        },
      }),
      "Source Association must match the Recognition Proposal source address",
    ],
    [
      "Recognition Decision rules",
      (value: AcceptedRecognition): AcceptedRecognition => ({
        ...value,
        recognitionDecision: {
          ...value.recognitionDecision,
          acceptedRuleResults: value.proposal.ruleResults.map((result) => ({
            ...result,
            explanation: "different accepted decision rule",
          })),
        },
      }),
      "Recognition Decision rules must match the accepted Recognition Proposal",
    ],
  ])(
    "rejects a mismatched %s before it can be persisted",
    (_, mutate, error) => {
      expect(() => validateAcceptedRecognition(mutate(accepted()))).toThrow(
        error,
      );
    },
  );

  it("permits a new proposal to append facts only with its immutable identity predecessor", () => {
    const current = accepted();
    const refreshed: AcceptedRecognition = {
      ...current,
      proposal: {
        ...current.proposal,
        id: "refresh-proposal",
        interpretation: {
          ...current.proposal.interpretation,
          id: "refresh-interpretation",
        },
      },
    };

    expect(
      validateReevaluatedRecognition({ current, accepted: refreshed }),
    ).toBe(refreshed);
  });

  it.each([
    [
      "Source Association",
      (value: AcceptedRecognition): AcceptedRecognition => ({
        ...value,
        sourceAssociation: {
          ...value.sourceAssociation,
          proposalId: "refresh-proposal",
        },
      }),
      "immutable Source Association",
    ],
    [
      "Recognition Decision",
      (value: AcceptedRecognition): AcceptedRecognition => ({
        ...value,
        recognitionDecision: {
          ...value.recognitionDecision,
          proposalId: "refresh-proposal",
        },
      }),
      "immutable Recognition Decision",
    ],
  ])("rejects a refresh that rewrites its %s", (_, mutate, error) => {
    const current = accepted();
    const refreshed = mutate({
      ...current,
      proposal: {
        ...current.proposal,
        id: "refresh-proposal",
        interpretation: {
          ...current.proposal.interpretation,
          id: "refresh-interpretation",
        },
      },
    });

    expect(() =>
      validateReevaluatedRecognition({ current, accepted: refreshed }),
    ).toThrow(error);
  });

  it("rejects a local metadata assertion without either source or observed-part provenance", () => {
    const current = accepted();
    const metadata = { ...current.metadata[0] };
    delete metadata.observedArtifactPart;
    const invalid: AcceptedRecognition = {
      ...current,
      metadata: [metadata],
    };

    expect(() => validateAcceptedRecognition(invalid)).toThrow(
      "source or observed-part provenance",
    );
  });

  it("accepts an EPUB fact only when its parent revision belongs to its parent artifact", () => {
    expect(validateAcceptedRecognition(accepted())).toBeDefined();
    const current = accepted();
    const invalid: AcceptedRecognition = {
      ...current,
      metadata: [
        {
          ...current.metadata[0],
          observedArtifactPart: {
            artifactId: "cover",
            revisionId: "epub-revision",
            locator: "epub:opf/dc:title[1]",
          },
        },
      ],
    };
    expect(() => validateAcceptedRecognition(invalid)).toThrow(
      "source or observed-part provenance",
    );
  });

  it("rejects a metadata assertion that combines official and local provenance", () => {
    const current = accepted();
    const invalid: AcceptedRecognition = {
      ...current,
      metadata: [
        { ...current.metadata[0], sourceRecordIds: ["official-record"] },
      ],
    };
    expect(() => validateAcceptedRecognition(invalid)).toThrow(
      "source or observed-part provenance",
    );
  });

  it("rejects an embedded-cover association whose revision belongs to another artifact", () => {
    const current = accepted();
    const invalid: AcceptedRecognition = {
      ...current,
      artifactAssociations: [
        {
          ...current.artifactAssociations[0],
          observedArtifactPart: {
            artifactId: "cover",
            revisionId: "epub-revision",
            locator: "epub:cover",
          },
        },
      ],
    };
    expect(() => validateAcceptedRecognition(invalid)).toThrow(
      "Observed Artifact Part association",
    );
  });
});
