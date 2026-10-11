import type {
  CapabilityCoordinate,
  ObservedArtifactRevisionCandidate,
  RecognitionEvidence,
  RecognitionProposal,
  RecognitionRuleResult,
} from "@digital/domain";
import { describe, expect, it } from "vitest";

import {
  legacyManualRepresentedReference,
  legacyRepresentedObservedMaterialReference,
  observedMaterialReferenceRepresentsEntity,
  representativeBodyMaterialReferences,
  representativeObservedMaterialReferences,
} from "../src/index.ts";

/**
 * 代表材料判定的业务正负组：一条本地材料能否代表资产，只由被接受的材料边界与明确代表
 * 依据决定。多材料台本目录里唯一被格式检查过的附件必须继续只是材料图，绝不冒充实体封面；
 * 合法离散单材料、人工明确单材料与目录明确声明的代表正文必须仍然取得代表资格。
 *
 * 生成、重扫 reconciliation 与持久化当前读取都调用这同一份纯判定，所以这里成立即三端成立。
 */

const inspector: CapabilityCoordinate = {
  capabilityId: "artifact-format-inspection",
  capabilityVersion: "1",
  contractVersion: "1",
};
const producer: CapabilityCoordinate = {
  capabilityId: "dlsite.exact-directory",
  capabilityVersion: "3",
  contractVersion: "1",
};

const pdfRevision = {
  observedArtifactReference: "台本/script.pdf",
  blob: {
    digest: "4f6420b173401ac277b9570bb3359b0bd1298a6c4a70b3b4f9f143ea0ef89680",
    mediaType: "application/pdf",
    byteLength: 329,
  },
  producer: inspector,
};
const audioRevision = {
  observedArtifactReference: "track.wav",
  blob: {
    digest: "9a1c0c39b3a5f0d0e6f2b0f6e2e1af0e6f2b0f6e2e1af0e6f2b0f6e2e1af0e6f",
    mediaType: "audio/wav",
    byteLength: 44,
  },
  producer: inspector,
};

/** 一次格式检查事实：代表判定只读它引用的那份材料与父修订坐标。 */
function inspected(
  revision: ObservedArtifactRevisionCandidate,
): RecognitionEvidence {
  return {
    kind: "artifact-format-inspection",
    explanation: `已检查 ${revision.observedArtifactReference}`,
    producer: inspector,
    inspection: {
      observedArtifactReference: revision.observedArtifactReference,
      revision: revision.blob,
      identifiers: [],
      metadata: [],
      parts: [],
    },
  };
}

function rule(
  revision: ObservedArtifactRevisionCandidate,
  outcome: RecognitionRuleResult["outcome"],
): RecognitionRuleResult {
  return {
    capabilityId: "dlsite.exact-directory",
    capabilityVersion: "3",
    ruleId: "asset.single-material-body",
    ruleVersion: "1",
    outcome,
    explanation: `${revision.observedArtifactReference} 规则${outcome === "satisfied" ? "满足" : "被反驳"}`,
    evidence: [inspected(revision)],
  };
}

/** 真实生产提议的形状：目录边界内两份交付材料，只有台本 PDF 被格式检查并派生出材料图。 */
function scriptDirectoryProposal(
  overrides: {
    readonly bodyDeclared?: boolean;
    readonly outcome?: RecognitionRuleResult["outcome"];
  } = {},
): RecognitionProposal {
  const evidence = [inspected(pdfRevision)];
  return {
    id: "recognition-proposal_c1a33de3-1a7f-4b1d-9997-ee123d8089f9",
    boundaries: [
      {
        kind: "directory",
        scopeReference: "observed-root-registration_dlsite",
        directoryReference: ".",
      },
    ],
    basis: {
      kind: "observed-evidence",
      producer,
      evidence: [
        {
          kind: "source-address",
          explanation: "RJ01668691",
          sourceIdentity: "dlsite",
          sourceAddress: "RJ01668691",
          producer,
        },
        ...evidence,
      ],
      artifactRevisions: [pdfRevision],
    },
    ruleResults: [rule(pdfRevision, overrides.outcome ?? "satisfied")],
    observedArtifactAssociations: [
      {
        observedArtifactReference: "track.wav",
        role: "asset.material-delivered",
        producer,
      },
      {
        observedArtifactReference: "台本/script.pdf",
        role: "asset.material-delivered",
        producer,
      },
      ...(overrides.bodyDeclared === true
        ? [
            {
              observedArtifactReference: "台本/script.pdf",
              role: "asset.representative-body",
              producer,
            },
          ]
        : []),
    ],
    observedArtifactParts: [
      {
        id: "observed-part_pdf-page-1",
        role: "asset.material-image",
        observedArtifactReference: "台本/script.pdf",
        locator: "pdf:page[1]",
        mediaType: "image/png",
        producer: inspector,
      },
    ],
    observedArtifactRevisions: [pdfRevision],
  };
}

describe("representative material basis", () => {
  it("多材料台本目录里唯一被检查的附件只代表它自己，不冒充实体封面", () => {
    const proposal = scriptDirectoryProposal();
    expect([...representativeObservedMaterialReferences(proposal)]).toEqual([]);
    expect([...representativeBodyMaterialReferences(proposal)]).toEqual([]);
    expect(
      observedMaterialReferenceRepresentsEntity(proposal, "台本/script.pdf"),
    ).toBe(false);
    expect(
      observedMaterialReferenceRepresentsEntity(proposal, "track.wav"),
    ).toBe(false);
    // 旧公式确实会把这份唯一被检查的 PDF 当作代表：这正是需要纠正的生成来源。
    expect(legacyRepresentedObservedMaterialReference(proposal)).toBe(
      "台本/script.pdf",
    );
  });

  it("目录里唯一被检查的音轨同样不因邻近而取得代表资格", () => {
    const proposal = scriptDirectoryProposal();
    const audioOnlyInspected: RecognitionProposal = {
      ...proposal,
      basis:
        proposal.basis.kind === "observed-evidence"
          ? { ...proposal.basis, artifactRevisions: [audioRevision] }
          : proposal.basis,
      ruleResults: [rule(audioRevision, "satisfied")],
      observedArtifactRevisions: [audioRevision],
    };
    expect([
      ...representativeObservedMaterialReferences(audioOnlyInspected),
    ]).toEqual([]);
    expect(legacyRepresentedObservedMaterialReference(audioOnlyInspected)).toBe(
      "track.wav",
    );
  });

  it("来源规则在目录内明确声明代表正文时同一 PDF 取得代表资格", () => {
    const proposal = scriptDirectoryProposal({ bodyDeclared: true });
    expect(
      [...representativeObservedMaterialReferences(proposal)].toSorted(),
    ).toEqual(["台本/script.pdf"]);
    expect([...representativeBodyMaterialReferences(proposal)]).toEqual([
      "台本/script.pdf",
    ]);
    expect(
      observedMaterialReferenceRepresentsEntity(proposal, "台本/script.pdf"),
    ).toBe(true);
  });

  it("被反驳规则的证据不授予代表资格，即使它精确指向那份材料", () => {
    const proposal = scriptDirectoryProposal({
      bodyDeclared: true,
      outcome: "contradicted",
    });
    expect([...representativeObservedMaterialReferences(proposal)]).toEqual([]);
    // 历史公式不检查 outcome，所以旧库里的封面仍能由它自然产生。
    expect(legacyRepresentedObservedMaterialReference(proposal)).toBe(
      "台本/script.pdf",
    );
  });

  it("合法离散单材料取得代表资格", () => {
    const reference = "台本/script.pdf";
    const proposal: RecognitionProposal = {
      ...scriptDirectoryProposal(),
      boundaries: [
        {
          kind: "discrete",
          scopeReference: "observed-root-registration_dlsite",
          materialReferences: [reference],
        },
      ],
      observedArtifactAssociations: [
        {
          observedArtifactReference: reference,
          role: "asset.material-delivered",
          producer,
        },
      ],
    };
    expect([...representativeObservedMaterialReferences(proposal)]).toEqual([
      reference,
    ]);
    expect([...representativeBodyMaterialReferences(proposal)]).toEqual([
      reference,
    ]);
  });

  it("离散边界声明两份材料而只检查其一时没有代表", () => {
    const proposal: RecognitionProposal = {
      ...scriptDirectoryProposal(),
      boundaries: [
        {
          kind: "discrete",
          scopeReference: "observed-root-registration_dlsite",
          materialReferences: ["track.wav", "台本/script.pdf"],
        },
      ],
    };
    expect([...representativeObservedMaterialReferences(proposal)]).toEqual([]);
  });

  it("人工明确单材料取得封面代表但不自动取得标题正文", () => {
    const reference = "台本/script.pdf";
    const proposal: RecognitionProposal = {
      ...scriptDirectoryProposal(),
      boundaries: [
        {
          kind: "discrete",
          scopeReference: "observed-root-registration_dlsite",
          materialReferences: [reference],
        },
      ],
      basis: {
        kind: "manual-boundary",
        proposedBy: "local-user",
        observationSnapshotId: "snapshot_b5d2d631-7691-4202-9137-a1025d71e616",
        materialReferences: [reference],
        revisesProposalIds: [],
        metadata: [],
        evidence: [inspected(pdfRevision)],
      },
    };
    expect([...representativeObservedMaterialReferences(proposal)]).toEqual([
      reference,
    ]);
    // 人工边界不强加不存在的自动规则，但也不把「唯一声明」升格为标题正文代表。
    expect([...representativeBodyMaterialReferences(proposal)]).toEqual([]);
    expect(legacyManualRepresentedReference(proposal)).toBe(reference);
  });

  it("人工边界声明多份材料时没有代表", () => {
    const proposal: RecognitionProposal = {
      ...scriptDirectoryProposal(),
      basis: {
        kind: "manual-boundary",
        proposedBy: "local-user",
        observationSnapshotId: "snapshot_b5d2d631-7691-4202-9137-a1025d71e616",
        materialReferences: ["track.wav", "台本/script.pdf"],
        revisesProposalIds: [],
        metadata: [],
        evidence: [inspected(pdfRevision)],
      },
    };
    expect([...representativeObservedMaterialReferences(proposal)]).toEqual([]);
    expect(legacyManualRepresentedReference(proposal)).toBeUndefined();
  });

  it("已接受边界的重扫沿用同一份判定：单材料取得、多材料目录不取得", () => {
    const reference = "台本/script.pdf";
    const acceptedSingle: RecognitionProposal = {
      ...scriptDirectoryProposal(),
      boundaries: [
        {
          kind: "discrete",
          scopeReference: "observed-root-registration_dlsite",
          materialReferences: [reference],
        },
      ],
      basis: {
        kind: "accepted-boundary",
        recognitionDecisionId:
          "recognition-decision_bc6a2a76-8047-4f07-9061-665be91affda",
        observationSnapshotId: "snapshot_b5d2d631-7691-4202-9137-a1025d71e616",
        materialReferences: [reference],
        evidence: [inspected(pdfRevision)],
      },
      observedArtifactAssociations: [
        {
          observedArtifactReference: reference,
          role: "asset.material-delivered",
          producer,
        },
      ],
    };
    expect([
      ...representativeObservedMaterialReferences(acceptedSingle),
    ]).toEqual([reference]);

    const acceptedDirectory: RecognitionProposal = {
      ...scriptDirectoryProposal(),
      basis:
        scriptDirectoryProposal().basis.kind === "observed-evidence"
          ? {
              kind: "accepted-boundary",
              recognitionDecisionId:
                "recognition-decision_bc6a2a76-8047-4f07-9061-665be91affda",
              observationSnapshotId:
                "snapshot_b5d2d631-7691-4202-9137-a1025d71e616",
              materialReferences: ["track.wav", reference],
              evidence: [inspected(pdfRevision)],
            }
          : scriptDirectoryProposal().basis,
    };
    expect([
      ...representativeObservedMaterialReferences(acceptedDirectory),
    ]).toEqual([]);
  });
});
