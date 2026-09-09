import { describe, expect, it } from "vitest";

import {
  validateAcceptedRecognition,
  validateRecognitionProposal,
  validateReevaluatedRecognition,
  type AcceptedRecognition,
  type RecognitionProposal,
} from "../src/index.ts";

function accepted(): AcceptedRecognition {
  const proposal = {
    id: "proposal",
    basis: {
      kind: "source-interpretation" as const,
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
    sourceAssociations: [
      {
        id: "association",
        subjectId: "asset",
        sourceIdentity: "official",
        nativeAddress: "https://example.test/book",
        proposalId: "proposal",
      },
    ],
    recognitionSourceAssociation: {
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
        recognitionSourceAssociation: {
          ...value.recognitionSourceAssociation!,
          sourceIdentity: "different-source",
        },
        sourceAssociations: value.sourceAssociations.map((association) => ({
          ...association,
          sourceIdentity: "different-source",
        })),
      }),
      "Source Association must match the Recognition Proposal source identity",
    ],
    [
      "Source Association address",
      (value: AcceptedRecognition): AcceptedRecognition => ({
        ...value,
        recognitionSourceAssociation: {
          ...value.recognitionSourceAssociation!,
          nativeAddress: "https://example.test/different-book",
        },
        sourceAssociations: value.sourceAssociations.map((association) => ({
          ...association,
          nativeAddress: "https://example.test/different-book",
        })),
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
        basis: {
          ...current.proposal.basis,
          interpretation: {
            ...current.proposal.basis.interpretation,
            id: "refresh-interpretation",
          },
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
        recognitionSourceAssociation: {
          ...value.recognitionSourceAssociation!,
          proposalId: "refresh-proposal",
        },
        sourceAssociations: value.sourceAssociations.map((association) => ({
          ...association,
          proposalId: "refresh-proposal",
        })),
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
        basis: {
          ...current.proposal.basis,
          interpretation: {
            ...current.proposal.basis.interpretation,
            id: "refresh-interpretation",
          },
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

describe("识别依据", () => {
  const inspector = {
    capabilityId: "epub-inspector",
    capabilityVersion: "1",
    contractVersion: "epub/3",
  };
  const revision = {
    observedArtifactReference: "book.epub",
    blob: {
      digest: "epub-digest",
      mediaType: "application/epub+zip",
      byteLength: 1,
    },
    producer: inspector,
  };
  const evidence = {
    kind: "format.valid-publication",
    explanation: "一个有效且边界完整的出版物修订版",
    producer: inspector,
    inspection: {
      identifiers: [],
      observedArtifactReference: "book.epub",
      revision: revision.blob,
      metadata: [],
      parts: [],
    },
  };
  const ruleResult = {
    capabilityId: "local-recognizer",
    capabilityVersion: "1",
    ruleId: "valid-single-revision",
    ruleVersion: "1",
    outcome: "satisfied" as const,
    explanation: "精确观察证据建立一个本地资产边界",
    evidence: [evidence],
  };

  function observedProposal(): RecognitionProposal {
    return {
      id: "local-proposal",
      basis: {
        kind: "observed-evidence",
        producer: inspector,
        evidence: [evidence],
        artifactRevisions: [revision],
      },
      ruleResults: [ruleResult],
    } as unknown as RecognitionProposal;
  }

  function observedProposalWithIdentifiers(
    identifiers: unknown,
  ): RecognitionProposal {
    const identifiedEvidence = {
      ...evidence,
      inspection: { ...evidence.inspection, identifiers },
    };
    const proposal = observedProposal();
    if (proposal.basis.kind !== "observed-evidence")
      throw new Error("测试提案缺少观察证据依据");
    return {
      ...proposal,
      basis: {
        ...proposal.basis,
        evidence: [identifiedEvidence],
      },
      ruleResults: proposal.ruleResults.map((result) => ({
        ...result,
        evidence: [identifiedEvidence],
      })),
    } as unknown as RecognitionProposal;
  }

  it("验证来源解释与观察证据两种互斥识别依据", () => {
    const legacy = accepted().proposal;
    if (legacy.basis.kind !== "source-interpretation")
      throw new Error("测试来源提案缺少来源解释依据");
    const source = {
      id: legacy.id,
      basis: {
        kind: "source-interpretation",
        interpretation: {
          ...legacy.basis.interpretation,
          recognitionEvidenceReferences: [
            { kind: "source-record", sourceRecordId: "official-record" },
          ],
        },
      },
      ruleResults: legacy.ruleResults.map((result) => ({
        ...result,
        evidenceReferences: [
          { kind: "source-record" as const, sourceRecordId: "official-record" },
        ],
      })),
    } as unknown as RecognitionProposal;

    expect(validateRecognitionProposal(source)).toBe(source);
    const observed = observedProposal();
    expect(validateRecognitionProposal(observed)).toBe(observed);
  });

  it.each([
    ["缺少 locators", [{ scheme: "isbn-13", value: "9784049131291" }]],
    [
      "locators 不是数组",
      [{ scheme: "isbn-13", value: "9784049131291", locators: "pdf:xmp" }],
    ],
    [
      "locators 为空数组",
      [{ scheme: "isbn-13", value: "9784049131291", locators: [] }],
    ],
    [
      "locator 为空白",
      [{ scheme: "isbn-13", value: "9784049131291", locators: [" "] }],
    ],
    [
      "locator 重复",
      [
        {
          scheme: "isbn-13",
          value: "9784049131291",
          locators: ["pdf:xmp/dc:identifier[1]", "pdf:xmp/dc:identifier[1]"],
        },
      ],
    ],
  ])("拒绝 identifier %s", (_, identifiers) => {
    expect(() =>
      validateRecognitionProposal(observedProposalWithIdentifiers(identifiers)),
    ).toThrow();
  });

  it("保留合法 identifier locator 的原顺序", () => {
    const locators = ["pdf:xmp/dc:identifier[2]", "pdf:xmp/dc:identifier[1]"];
    const proposal = observedProposalWithIdentifiers([
      { scheme: "isbn-13", value: "9784049131291", locators },
    ]);

    expect(validateRecognitionProposal(proposal)).toBe(proposal);
    if (proposal.basis.kind !== "observed-evidence")
      throw new Error("测试提案缺少观察证据依据");
    expect(
      proposal.basis.evidence[0]!.inspection!.identifiers[0]!.locators,
    ).toBe(locators);
  });

  it.each([
    [
      "空观察证据",
      (proposal: RecognitionProposal) => ({
        ...proposal,
        basis: { ...proposal.basis, evidence: [] },
      }),
    ],
    [
      "跨输入观察证据",
      (proposal: RecognitionProposal) => ({
        ...proposal,
        ruleResults: proposal.ruleResults.map((result) => ({
          ...result,
          evidence: [{ ...evidence, explanation: "不是所选输入" }],
        })),
      }),
    ],
    [
      "伪来源解释旁路",
      (proposal: RecognitionProposal) => ({
        ...proposal,
        basis: {
          ...proposal.basis,
          interpretation:
            accepted().proposal.basis.kind === "source-interpretation"
              ? accepted().proposal.basis.interpretation
              : undefined,
        },
      }),
    ],
  ])("拒绝%s", (_, mutate) => {
    expect(() =>
      validateRecognitionProposal(
        mutate(observedProposal()) as unknown as RecognitionProposal,
      ),
    ).toThrow();
  });
});
