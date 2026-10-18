import {
  validateRecognitionSupersessionSourceRetraction,
  type RecognitionDecision,
  type RecognitionProposal,
  type SourceAssociation,
  type SourceAssociationEstablishmentSupport,
  type SourceAssociationRetraction,
} from "@digital/domain";
import { expect, it } from "vitest";

const association: SourceAssociation = {
  id: "source-association-old",
  subjectId: "asset",
  sourceIdentity: "source",
  nativeAddress: "source:old",
};
const establishmentSupport: SourceAssociationEstablishmentSupport = {
  associationId: association.id,
  establishedBy: {
    kind: "recognition-decision",
    decisionId: "recognition-decision-old",
  },
};
const predecessorDecision: RecognitionDecision = {
  id: "recognition-decision-old",
  proposalId: "recognition-proposal-old",
  assetId: "asset",
  boundaries: [],
  acceptedRuleResults: [],
};
const successorDecision: RecognitionDecision = {
  id: "recognition-decision-new",
  proposalId: "recognition-proposal-new",
  assetId: "asset",
  boundaries: [],
  acceptedRuleResults: [],
};
const successorProposal: RecognitionProposal = {
  id: successorDecision.proposalId,
  boundaries: [],
  basis: {
    kind: "manual-boundary",
    proposedBy: "operator",
    observationSnapshotId: "snapshot",
    materialReferences: ["book.pdf"],
    revisesProposalIds: [predecessorDecision.proposalId],
    metadata: [],
    evidence: [],
  },
  ruleResults: [],
};
const supersession = {
  id: "recognition-supersession",
  predecessorDecisionId: predecessorDecision.id,
  successorDecisionId: successorDecision.id,
};
const retraction: SourceAssociationRetraction = {
  id: "source-retraction",
  associationId: association.id,
  authorizedBy: {
    kind: "recognition-decision-supersession",
    supersessionId: supersession.id,
  },
};

it("accepts only the Recognition Supersession that ended the establishing decision", () => {
  expect(
    validateRecognitionSupersessionSourceRetraction({
      retraction,
      association,
      establishmentSupport,
      supersession,
      predecessorDecision,
      successorDecision,
      successorProposal,
    }),
  ).toEqual(retraction);
});

it.each([
  [
    "a bare or wrong authorizer",
    {
      retraction: {
        ...retraction,
        authorizedBy: {
          kind: "recognition-decision-supersession" as const,
          supersessionId: successorDecision.id,
        },
      },
    },
  ],
  [
    "non-predecessor establishment support",
    {
      establishmentSupport: {
        ...establishmentSupport,
        establishedBy: {
          kind: "recognition-decision" as const,
          decisionId: "unrelated-decision",
        },
      },
    },
  ],
  [
    "cross-subject successor",
    { successorDecision: { ...successorDecision, assetId: "other-asset" } },
  ],
  [
    "a successor that still has source interpretation",
    {
      successorProposal: {
        ...successorProposal,
        basis: {
          kind: "source-interpretation" as const,
          interpretation: {
            id: "interpretation",
            producer: {
              capabilityId: "source.interpreter",
              capabilityVersion: "1",
              contractVersion: "1",
            },
            sourceRecordIds: ["record"],
            sourceIdentity: "source",
            sourceAddress: "source:new",
            metadata: [],
            sourceArtifacts: [],
          },
        },
      },
    },
  ],
  ["an already terminated Association", { alreadySuperseded: true }],
] as const)("rejects %s", (_label, override) => {
  expect(() =>
    validateRecognitionSupersessionSourceRetraction({
      retraction,
      association,
      establishmentSupport,
      supersession,
      predecessorDecision,
      successorDecision,
      successorProposal,
      ...override,
    }),
  ).toThrow(
    "Recognition Supersession cannot authorize this Source Association retraction",
  );
});
