import {
  decodeSourceAssociationDecisionCheckpoint,
  validateSourceAssociationDecisionEnvelope,
  validateSourceAssociationDecisionPriorExecution,
} from "@digital/application";
import { describe, expect, it } from "vitest";

const createdCheckpoint = {
  version: "source-association-decision-checkpoint/1",
  state: "created",
  intent: "replace",
  assetId: "asset",
  sourceIdentity: "source",
  predecessor: {
    id: "association",
    subjectId: "asset",
    sourceIdentity: "source",
    nativeAddress: "source:a",
  },
  candidates: [],
  capturedSourceRecordIds: [],
} as const;

const normalizationContent = {
  version: "source-normalization-record/1",
  rawInput: { address: "source:b" },
  capability: {
    capabilityId: "source.addressing",
    capabilityVersion: "1",
    contractVersion: "1",
  },
  normalizedInput: { address: "source:b" },
  evidence: {
    kind: "directed-source-address",
    sourceIdentity: "source",
    sourceAddress: "source:b",
    explanation: "人工指定",
    producer: {
      capabilityId: "source.addressing",
      capabilityVersion: "1",
      contractVersion: "1",
    },
  },
} as const;
const normalization = {
  ...normalizationContent,
  integrityFingerprint:
    "a610a008687e498997f5cb4382ea857544dfaedf612e6dfb9c8d41894a576d2b",
} as const;

const compatibility = {
  workflowVersion: "asset-refresh/2" as const,
  policyVersion: "policy/1",
  capabilityCoordinates: ["source.addressing@1/1"],
};

describe("source association decision checkpoint decoding", () => {
  it("fails closed for duplicate coordinates and fields forbidden by the state", () => {
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...createdCheckpoint,
        capturedSourceRecordIds: ["record", "record"],
      }).valid,
    ).toBe(false);
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...createdCheckpoint,
        failure: "must only belong to failed state",
      }).valid,
    ).toBe(false);
  });

  it("recursively rejects unknown nested association fields", () => {
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...createdCheckpoint,
        predecessor: { ...createdCheckpoint.predecessor, databaseRowId: 1 },
      }).valid,
    ).toBe(false);
  });

  it("recursively rejects an unaccountable or extended proposal", () => {
    const awaiting = {
      ...createdCheckpoint,
      state: "awaiting-confirmation",
      normalization,
      candidates: [
        {
          outcome: "accepted",
          sourceIdentity: "source",
          nativeAddress: "source:b",
          sourceRecordIds: ["record"],
          ruleResults: [],
          interpretation: {
            id: "interpretation",
            producer: {
              capabilityId: "source.interpreter",
              capabilityVersion: "1",
              contractVersion: "1",
            },
            sourceRecordIds: ["record"],
            sourceIdentity: "source",
            sourceAddress: "source:b",
            metadata: [],
            sourceArtifacts: [],
          },
          explanation: "候选",
        },
      ],
      capturedSourceRecordIds: ["record"],
      previewId: "preview",
      proposal: {
        id: "proposal",
        kind: "replace",
        subjectId: "asset",
        predecessorAssociationId: "association",
        successor: {
          id: "successor",
          subjectId: "asset",
          sourceIdentity: "source",
          nativeAddress: "source:b",
        },
        sourceRecordIds: ["record"],
        proposedBy: { kind: "user", actorId: "reviewer" },
        evidence: {
          observed: [],
          manual: [
            {
              kind: "directed-source-address",
              sourceIdentity: "source",
              sourceAddress: "source:b",
              explanation: "人工指定",
              producer: {
                capabilityId: "source.addressing",
                capabilityVersion: "1",
                contractVersion: "1",
              },
            },
          ],
          sourceCandidates: [
            {
              outcome: "accepted",
              sourceIdentity: "source",
              nativeAddress: "source:b",
              sourceRecordIds: ["record"],
              ruleResults: [],
              explanation: "候选",
            },
          ],
          conflicts: [],
        },
      },
    } as const;
    expect(decodeSourceAssociationDecisionCheckpoint(awaiting).valid).toBe(
      true,
    );
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...awaiting,
        proposal: {
          ...awaiting.proposal,
          proposedBy: { kind: "user", actorId: "reviewer", role: "admin" },
        },
      }).valid,
    ).toBe(false);
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...awaiting,
        candidates: [awaiting.candidates[0], awaiting.candidates[0]],
      }).valid,
    ).toBe(false);
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...awaiting,
        proposal: {
          ...awaiting.proposal,
          evidence: { ...awaiting.proposal.evidence, sourceCandidates: [] },
        },
      }).valid,
    ).toBe(false);
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...awaiting,
        proposal: {
          ...awaiting.proposal,
          evidence: {
            ...awaiting.proposal.evidence,
            observed: [awaiting.normalization.evidence],
          },
        },
      }).valid,
    ).toBe(false);
    expect(
      validateSourceAssociationDecisionEnvelope({
        id: "awaiting-execution",
        acceptedAssetId: "asset",
        sourceRecordIds: ["record"],
        compatibility,
        workflowInput: {
          version: "source-association-decision-input/1",
          trigger: "interactive",
          initiatedBy: "reviewer",
          acceptTrusted: false,
          configurationReferences: [],
          intent: "replace",
          assetId: "asset",
          sourceIdentity: "source",
          predecessorAssociationId: "association",
          sourceInput: { address: "source:b" },
        },
        sourceAssociationDecision: {
          ...awaiting,
          proposal: {
            ...awaiting.proposal,
            proposedBy: { kind: "user", actorId: "another-reviewer" },
          },
        },
      }),
    ).toBe(false);
    expect(
      validateSourceAssociationDecisionEnvelope({
        id: "mixed-normalization-result-execution",
        acceptedAssetId: "asset",
        sourceRecordIds: ["record"],
        compatibility,
        workflowInput: {
          version: "source-association-decision-input/1",
          trigger: "interactive",
          initiatedBy: "reviewer",
          acceptTrusted: false,
          configurationReferences: [],
          intent: "replace",
          assetId: "asset",
          sourceIdentity: "source",
          predecessorAssociationId: "association",
          sourceInput: { address: "source:b" },
        },
        sourceAssociationDecision: {
          ...awaiting,
          candidates: [
            {
              ...awaiting.candidates[0],
              nativeAddress: "source:c",
              interpretation: {
                ...awaiting.candidates[0].interpretation,
                sourceAddress: "source:c",
              },
            },
          ],
          proposal: {
            ...awaiting.proposal,
            successor: {
              ...awaiting.proposal.successor,
              nativeAddress: "source:c",
            },
            evidence: {
              ...awaiting.proposal.evidence,
              sourceCandidates: [
                {
                  ...awaiting.proposal.evidence.sourceCandidates[0],
                  nativeAddress: "source:c",
                },
              ],
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...awaiting,
        proposal: {
          ...awaiting.proposal,
          evidence: {
            ...awaiting.proposal.evidence,
            conflicts: ["并不存在的冲突"],
          },
        },
      }).valid,
    ).toBe(false);
  });

  it("binds a retraction reason, empty evidence and actor to its frozen action", () => {
    const retraction = {
      version: "source-association-decision-checkpoint/1",
      state: "awaiting-confirmation",
      intent: "retract",
      assetId: "asset",
      sourceIdentity: "source",
      predecessor: createdCheckpoint.predecessor,
      candidates: [],
      capturedSourceRecordIds: [],
      previewId: "retraction-preview",
      proposal: {
        id: "retraction-proposal",
        kind: "retract",
        subjectId: "asset",
        predecessorAssociationId: "association",
        proposedBy: { kind: "user", actorId: "reviewer" },
        reason: "地址归属错误",
        evidence: {
          observed: [],
          manual: [],
          sourceCandidates: [],
          conflicts: [],
        },
      },
    } as const;
    const execution = {
      id: "retraction-execution",
      acceptedAssetId: "asset",
      sourceRecordIds: [],
      compatibility,
      workflowInput: {
        version: "source-association-decision-input/1" as const,
        trigger: "interactive" as const,
        initiatedBy: "reviewer",
        acceptTrusted: false as const,
        configurationReferences: [],
        intent: "retract" as const,
        assetId: "asset",
        sourceIdentity: "source",
        predecessorAssociationId: "association",
        reason: "地址归属错误",
      },
      sourceAssociationDecision: retraction,
    };
    expect(decodeSourceAssociationDecisionCheckpoint(retraction).valid).toBe(
      true,
    );
    expect(validateSourceAssociationDecisionEnvelope(execution)).toBe(true);
    expect(
      validateSourceAssociationDecisionEnvelope({
        ...execution,
        sourceAssociationDecision: {
          ...retraction,
          proposal: { ...retraction.proposal, reason: "另一个原因" },
        },
      }),
    ).toBe(false);
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...retraction,
        proposal: {
          ...retraction.proposal,
          evidence: {
            ...retraction.proposal.evidence,
            conflicts: ["伪造冲突"],
          },
        },
      }).valid,
    ).toBe(false);
  });

  it("binds the workflow input to the same atomic normalization record", () => {
    const input = {
      version: "source-association-decision-input/1",
      trigger: "interactive",
      initiatedBy: "reviewer",
      acceptTrusted: false,
      configurationReferences: [],
      intent: "replace",
      assetId: "asset",
      sourceIdentity: "source",
      predecessorAssociationId: "association",
      sourceInput: { address: "SOURCE B RAW" },
    } as const;
    const executionNormalizationContent = {
      ...normalizationContent,
      rawInput: input.sourceInput,
    } as const;
    const execution = {
      id: "execution",
      workflowInput: input,
      acceptedAssetId: "asset",
      sourceRecordIds: [],
      compatibility,
      sourceAssociationDecision: {
        ...createdCheckpoint,
        state: "collecting" as const,
        normalization: {
          ...executionNormalizationContent,
          integrityFingerprint:
            "5512ec1ab72a2a2205a33aebc46e040f7c6c0525e439e0409450f7a7c1f710bb",
        },
      },
    };
    expect(
      decodeSourceAssociationDecisionCheckpoint(
        execution.sourceAssociationDecision,
      ).valid,
    ).toBe(true);
    expect(validateSourceAssociationDecisionEnvelope(execution)).toBe(true);
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...execution.sourceAssociationDecision,
        normalization: {
          ...execution.sourceAssociationDecision.normalization,
          normalizedInput: { address: "source:locally-mixed" },
        },
      }).valid,
    ).toBe(false);
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...execution.sourceAssociationDecision,
        normalization: {
          ...execution.sourceAssociationDecision.normalization,
          unownedReceipt: "伪造证明",
        },
      }).valid,
    ).toBe(false);
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...execution.sourceAssociationDecision,
        normalization: {
          ...execution.sourceAssociationDecision.normalization,
          evidence: {
            ...execution.sourceAssociationDecision.normalization.evidence,
            producer: {
              ...execution.sourceAssociationDecision.normalization.evidence
                .producer,
              capabilityVersion: "2",
            },
          },
        },
      }).valid,
    ).toBe(false);
    expect(
      validateSourceAssociationDecisionEnvelope({
        ...execution,
        workflowInput: { ...input, assetId: "other-asset" },
      }),
    ).toBe(false);
    expect(
      validateSourceAssociationDecisionEnvelope({
        ...execution,
        workflowInput: {
          ...input,
          sourceInput: { address: "source:another" },
        },
      }),
    ).toBe(false);
  });

  it("rejects optional fields forbidden by each durable state", () => {
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...createdCheckpoint,
        previewId: "preview-must-not-exist-yet",
      }).valid,
    ).toBe(false);
  });

  it("rejects confirmation without an exact selected candidate", () => {
    const awaiting = {
      ...createdCheckpoint,
      state: "awaiting-confirmation",
      normalization,
      capturedSourceRecordIds: ["record"],
      previewId: "preview",
      proposal: {
        id: "proposal",
        kind: "replace",
        subjectId: "asset",
        predecessorAssociationId: "association",
        successor: {
          id: "successor",
          subjectId: "asset",
          sourceIdentity: "source",
          nativeAddress: "source:b",
        },
        sourceRecordIds: ["record"],
        proposedBy: { kind: "user", actorId: "reviewer" },
        evidence: {
          observed: [],
          manual: [],
          sourceCandidates: [],
          conflicts: [],
        },
      },
    } as const;
    expect(decodeSourceAssociationDecisionCheckpoint(awaiting).valid).toBe(
      false,
    );
  });

  it("rejects candidate, interpretation, captured and proposal coordinate drift", () => {
    const candidate = {
      outcome: "accepted",
      sourceIdentity: "source",
      nativeAddress: "source:b",
      sourceRecordIds: ["record"],
      ruleResults: [],
      interpretation: {
        id: "interpretation",
        producer: {
          capabilityId: "source.interpreter",
          capabilityVersion: "1",
          contractVersion: "1",
        },
        sourceRecordIds: ["other-record"],
        sourceIdentity: "source",
        sourceAddress: "source:b",
        metadata: [],
        sourceArtifacts: [],
      },
      explanation: "候选",
    } as const;
    expect(
      decodeSourceAssociationDecisionCheckpoint({
        ...createdCheckpoint,
        state: "awaiting-confirmation",
        normalization,
        candidates: [candidate],
        capturedSourceRecordIds: ["record"],
        previewId: "preview",
        proposal: {
          id: "proposal",
          kind: "replace",
          subjectId: "asset",
          predecessorAssociationId: "association",
          successor: {
            id: "successor",
            subjectId: "asset",
            sourceIdentity: "source",
            nativeAddress: "source:b",
          },
          sourceRecordIds: ["record"],
          proposedBy: { kind: "user", actorId: "reviewer" },
          evidence: {
            observed: [],
            manual: [],
            sourceCandidates: [],
            conflicts: [],
          },
        },
      }).valid,
    ).toBe(false);
  });

  it("accepts only a real terminal prior execution for an exact frozen retry", () => {
    const workflowInput = {
      version: "source-association-decision-input/1" as const,
      trigger: "interactive" as const,
      initiatedBy: "reviewer",
      acceptTrusted: false as const,
      configurationReferences: [],
      intent: "replace" as const,
      assetId: "asset",
      sourceIdentity: "source",
      predecessorAssociationId: "association",
      sourceInput: { address: "source:b" },
    };
    const execution = {
      id: "retry",
      workflowInput: { ...workflowInput, priorExecutionId: "prior" },
    };
    const prior = {
      id: "prior",
      status: "failed" as const,
      workflowInput,
      sourceAssociationDecision: createdCheckpoint,
    };
    expect(
      validateSourceAssociationDecisionPriorExecution(execution, prior),
    ).toBe(false);
    expect(
      validateSourceAssociationDecisionPriorExecution(execution, undefined),
    ).toBe(false);
    expect(
      validateSourceAssociationDecisionPriorExecution(execution, {
        ...prior,
        status: "running",
      }),
    ).toBe(false);
    expect(
      validateSourceAssociationDecisionPriorExecution(execution, {
        ...prior,
        workflowInput: { ...workflowInput, assetId: "other-asset" },
      }),
    ).toBe(false);
  });
});
