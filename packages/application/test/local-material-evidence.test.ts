/**
 * 第5/8/9节业务组：共同阶段的本地材料确认任务只沿执行自己冻结的那一份坐标推进。
 * 两个中断窗口都恢复同一任务，不重读已提交的效果、不换目标、不把失败折算成当前角色。
 */
import { describe, expect, it } from "vitest";

import {
  decodeObservedMaterialConfirmationCheckpoint,
  ensureRequestedLocalMaterialEvidence,
  findObservedMaterialConfirmationCheckpoint,
  localMaterialConfirmationDispositionKey,
  localMaterialConfirmationRequirementKey,
  localMaterialConfirmationStaleCode,
  localMaterialConfirmationTargetKey,
  markLocalMaterialConfirmationTerminalsStale,
  mergeRequestedLocalMaterialConfirmationTargets,
  staleLocalMaterialConfirmationAddresses,
  requestedLocalMaterialConfirmationVersion,
  type AssetRefreshWorkItem,
  type ExpectedObservedRevisionConfirmationResult,
  type FilesystemPackageSnapshot,
  type InformationRequirement,
  type LocalMaterialConfirmationCheckpointOutcome,
  type LocalMaterialConfirmationObservation,
  type LocalMaterialConfirmationPlanEntry,
  type LocalMaterialConfirmationCheckpointTarget,
  type LocalMaterialEvidencePersistence,
  type ObservedMaterialConfirmationCheckpoint,
  type RequestedLocalMaterialConfirmationTarget,
  type WorkflowExecution,
} from "../src/index.ts";

const requirement: InformationRequirement = {
  metadataUsageContext: "asset.current-catalogue",
  metadata: [],
  artifactRoles: [{ role: "asset.material-image", necessity: "required" }],
  relationshipTypes: [],
};

const requirementKey = localMaterialConfirmationRequirementKey({
  subjectIds: ["entity_subject"],
  informationRequirement: requirement,
});
const dispositionKey = localMaterialConfirmationDispositionKey(requirementKey);

const snapshot: FilesystemPackageSnapshot = {
  id: "snapshot_1",
  root: "/observed",
  complete: true,
  files: [],
  excluded: [],
  observedAt: "2026-10-09T00:00:00.000Z",
};

const observation: LocalMaterialConfirmationObservation = {
  selectionId: "selection_pdf",
  conditionalBaseline: "b".repeat(64),
};

function carrierTarget(
  overrides: Partial<RequestedLocalMaterialConfirmationTarget> = {},
): RequestedLocalMaterialConfirmationTarget {
  return {
    subjectId: "entity_subject",
    associationIds: ["artifact-association_pdf-page-1"],
    recognitionDecisionId: "recognition-decision_1",
    proposalId: "recognition-proposal_1",
    observedArtifactReference: "台本/script.pdf",
    carrierArtifactId: "artifact_carrier",
    locationId: "location_pdf",
    locationAddress: "/observed/RJ01668691/台本/script.pdf",
    observedReference: "台本/script.pdf",
    expectedRevisionId: "artifact-revision_pdf",
    expectedBlobDigest: "a".repeat(64),
    expectedByteLength: 329,
    frozenEntry: {
      snapshotId: "snapshot_1",
      snapshotRoot: "/observed",
      observedAt: "2026-10-09T00:00:00.000Z",
      size: 329,
      modifiedAt: "2026-10-09T00:00:00.000Z",
    },
    assetLibraryId: "asset-library_1",
    directoryAuthorityVersion: 3,
    ...overrides,
  };
}

function executionBase(
  dispositions: WorkflowExecution["dispositions"] = [],
): WorkflowExecution {
  return {
    id: "execution_1",
    selection: { informationRequirement: requirement },
    status: "running",
    stage: "recognition",
    sourceRecordIds: [],
    compatibility: {
      workflowVersion: "asset-refresh/2",
      policyVersion: "policy_1",
      capabilityCoordinates: ["dlsite.exact-directory@3@1"],
    },
    acceptedAssetId: "entity_subject",
    workItems: [
      {
        key: "dlsite-directory:.",
        relativePaths: ["track.wav", "台本/script.pdf"],
        sourceRecordIds: [],
        outcome: "accepted",
        acceptedAssetId: "entity_subject",
      },
    ] satisfies readonly AssetRefreshWorkItem[],
    filesystemSnapshots: [snapshot],
    dispositions,
  };
}

/** 检查点事务已提交的样子：目标 pending，但精确 facts 与正向观察已随之耐久。 */
function durablePendingExecution(
  targets: ObservedMaterialConfirmationCheckpoint["targets"],
  status: "running" | "completed" | "failed" = "running",
): WorkflowExecution {
  return executionBase([
    {
      key: dispositionKey,
      status,
      observedMaterialConfirmation: {
        version: requestedLocalMaterialConfirmationVersion,
        requirementKey,
        subjectIds: ["entity_subject"],
        targets,
      },
    },
  ]);
}

function pendingTarget(
  target: RequestedLocalMaterialConfirmationTarget = carrierTarget(),
) {
  return { ...target, status: "pending" as const, observation };
}

function confirmedTarget(
  target: RequestedLocalMaterialConfirmationTarget = carrierTarget(),
) {
  return { ...target, status: "confirmed" as const, observation };
}

type Calls = {
  plan: number;
  confirmations: {
    selectionId: string;
    expectedArtifactId: string;
    expectedRevisionId: string;
    expectedDigest: string;
    expectedByteLength: number;
    assetLibraryId?: string;
  }[];
  checkpointInputs: {
    dispositionKey: string;
    entries: number;
    resumeClaim?: { token: string; now: string };
  }[];
  transitions: { from: string; to: string; resumeClaim?: boolean }[];
};

function harness(input: {
  readonly execution?: WorkflowExecution;
  readonly planEntries?: readonly LocalMaterialConfirmationPlanEntry[];
  readonly outcomes?: readonly LocalMaterialConfirmationCheckpointOutcome[];
  readonly respond?: (
    call: Calls["confirmations"][number],
  ) => ExpectedObservedRevisionConfirmationResult;
}): {
  calls: Calls;
  run: () => Promise<
    Awaited<ReturnType<typeof ensureRequestedLocalMaterialEvidence>>
  >;
} {
  const calls: Calls = {
    plan: 0,
    confirmations: [],
    checkpointInputs: [],
    transitions: [],
  };
  const execution = input.execution ?? executionBase();
  const persistence: LocalMaterialEvidencePersistence = {
    async planRequestedLocalMaterialConfirmations() {
      calls.plan += 1;
      return input.planEntries ?? [];
    },
    async checkpointRequestedLocalMaterialConfirmations(request) {
      calls.checkpointInputs.push({
        dispositionKey: request.dispositionKey,
        entries: request.entries.length,
        ...(request.resumeClaim === undefined
          ? {}
          : { resumeClaim: request.resumeClaim }),
      });
      return {
        execution: request.execution,
        outcomes: input.outcomes ?? [],
      };
    },
    async verifyRequestedLocalMaterialConfirmationTerminals() {
      return [];
    },
  };
  const confirmation = {
    async confirmExpectedObservedRevision(
      request: Calls["confirmations"][number],
    ): Promise<ExpectedObservedRevisionConfirmationResult> {
      calls.confirmations.push(request);
      return (
        input.respond?.(request) ?? {
          kind: "exact-confirmed" as const,
          revisionId: request.expectedRevisionId,
        }
      );
    },
  };
  return {
    calls,
    run: () =>
      ensureRequestedLocalMaterialEvidence({
        execution,
        subjectIds: ["entity_subject"],
        informationRequirement: requirement,
        snapshots: [snapshot],
        assetLibraryId: "asset-library_1",
        persistence,
        confirmation,
        transition: async (expected, next, resumeClaim) => {
          calls.transitions.push({
            from: expected.id,
            to: next.id,
            resumeClaim: resumeClaim !== undefined,
          });
        },
      }),
  };
}

function settled(execution: WorkflowExecution) {
  const checkpoint = findObservedMaterialConfirmationCheckpoint(
    execution.dispositions,
    dispositionKey,
  );
  return {
    disposition: execution.dispositions.find(
      (item) => item.key === dispositionKey,
    ),
    checkpoint,
  };
}

describe("local material confirmation checkpoint", () => {
  it("窗口一：目标与正向观察已提交、字节未读时，恢复沿同一冻结 selection 只读一次", async () => {
    const target = carrierTarget();
    const first = harness({
      planEntries: [
        {
          target,
          prerequisiteObservation: {
            snapshotId: "snapshot_1",
            observedAt: "2026-10-09T00:00:00.000Z",
            size: 329,
            modifiedAt: "2026-10-09T00:00:00.000Z",
            conditionalBaseline: observation.conditionalBaseline,
          },
        },
      ],
      outcomes: [{ kind: "needs-confirmation", target, observation }],
    });
    // 崩溃在读取字节之前：终态 transition 尚未发生，持久状态仍停在检查点事务的结果上。
    await expect(first.run()).resolves.toBeDefined();

    const crashed = durablePendingExecution([pendingTarget(target)]);
    const recovery = harness({
      execution: crashed,
      outcomes: [{ kind: "needs-confirmation", target, observation }],
    });
    const result = await recovery.run();

    expect(recovery.calls.plan).toBe(0);
    expect(recovery.calls.confirmations).toHaveLength(1);
    expect(recovery.calls.confirmations[0]).toMatchObject({
      selectionId: observation.selectionId,
      expectedArtifactId: target.carrierArtifactId,
      expectedRevisionId: target.expectedRevisionId,
      expectedDigest: target.expectedBlobDigest,
      expectedByteLength: target.expectedByteLength,
      assetLibraryId: "asset-library_1",
    });
    expect(result.confirmed).toBe(1);
    expect(result.failed).toBe(0);
    const { disposition, checkpoint } = settled(result.execution);
    expect(disposition?.status).toBe("completed");
    expect(checkpoint?.targets).toEqual([
      { ...pendingTarget(target), status: "confirmed" },
    ]);
    // 恢复只裁定自己固定的目标：主体身份与工作项结果不被改写。
    expect(result.execution.acceptedAssetId).toBe("entity_subject");
    expect(result.execution.workItems?.[0]?.outcome).toBe("accepted");
  });

  it("窗口二：proof 已提交而执行进度未持久时，恢复按精确事实核对，不重复读取字节", async () => {
    const target = carrierTarget();
    const durable = durablePendingExecution([pendingTarget(target)]);
    const recovery = harness({
      execution: durable,
      outcomes: [{ kind: "exact-confirmed", target, observation }],
    });
    const result = await recovery.run();

    expect(recovery.calls.plan).toBe(0);
    expect(recovery.calls.confirmations).toEqual([]);
    expect(result.confirmed).toBe(1);
    expect(settled(result.execution).disposition?.status).toBe("completed");
  });

  it("全部目标已确认后重复进入阶段只核对并复用，不再读取也不再规划", async () => {
    const target = carrierTarget();
    const done = durablePendingExecution(
      [confirmedTarget(target)],
      "completed",
    );
    const again = harness({ execution: done });
    const result = await again.run();

    expect(again.calls.plan).toBe(0);
    expect(again.calls.confirmations).toEqual([]);
    expect(result.confirmed).toBe(1);
    expect(result.failed).toBe(0);
    expect(settled(result.execution).checkpoint?.targets).toEqual([
      confirmedTarget(target),
    ]);
  });

  it("观察先变是 CAS 陈旧：目标改判失败，不以旧 proof 成功，也不换成新目标", async () => {
    const target = carrierTarget();
    const replacement = carrierTarget({
      locationId: "location_pdf_newer",
      expectedRevisionId: "artifact-revision_newer",
    });
    const stage = harness({
      planEntries: [
        {
          target,
          prerequisiteObservation: {
            snapshotId: "snapshot_1",
            observedAt: "2026-10-09T00:00:00.000Z",
            size: 329,
            modifiedAt: "2026-10-09T00:00:00.000Z",
            conditionalBaseline: observation.conditionalBaseline,
          },
        },
      ],
      outcomes: [{ kind: "stale", target, observation }],
      respond: () => {
        throw new Error("陈旧目标不应再读取字节");
      },
    });
    const result = await stage.run();

    expect(stage.calls.confirmations).toEqual([]);
    expect(result.confirmed).toBe(0);
    expect(result.failed).toBe(1);
    const { disposition, checkpoint } = settled(result.execution);
    expect(disposition?.status).toBe("failed");
    expect(checkpoint?.targets).toHaveLength(1);
    expect(checkpoint?.targets[0]).toMatchObject({
      locationId: target.locationId,
      expectedRevisionId: target.expectedRevisionId,
      status: "failed",
      failureCode: localMaterialConfirmationStaleCode,
    });
    expect(localMaterialConfirmationTargetKey(checkpoint!.targets[0]!)).toBe(
      localMaterialConfirmationTargetKey(target),
    );
    expect(
      localMaterialConfirmationTargetKey(checkpoint!.targets[0]!),
    ).not.toBe(localMaterialConfirmationTargetKey(replacement));
    expect(staleLocalMaterialConfirmationAddresses(result.execution)).toEqual([
      target.locationAddress,
    ]);
  });

  it("位置已无可观察事实的陈旧目标保留为未完成，不制造空成功", async () => {
    const target = carrierTarget();
    const stage = harness({
      planEntries: [{ target, prerequisiteObservation: null }],
      outcomes: [{ kind: "stale", target }],
    });
    const result = await stage.run();

    const { disposition, checkpoint } = settled(result.execution);
    expect(result.confirmed).toBe(0);
    expect(result.failed).toBe(1);
    expect(checkpoint?.targets[0]?.status).toBe("pending");
    expect(checkpoint?.targets[0]?.failureCode).toBe(
      localMaterialConfirmationStaleCode,
    );
    expect(disposition?.status).toBe("failed");
  });

  it("同大小同mtime的内容变更击中真实摘要：目标失败且不提交替代修订", async () => {
    const target = carrierTarget();
    const stage = harness({
      planEntries: [{ target, prerequisiteObservation: null }],
      outcomes: [{ kind: "needs-confirmation", target, observation }],
      respond: () => ({
        kind: "failed" as const,
        failureCode: "expected-revision-digest-mismatch",
      }),
    });
    const result = await stage.run();

    expect(stage.calls.confirmations).toHaveLength(1);
    // 请求的仍是冻结的预期修订与摘要，绝不借失败结果建立另一个 current 修订。
    expect(stage.calls.confirmations[0]).toMatchObject({
      expectedRevisionId: target.expectedRevisionId,
      expectedDigest: target.expectedBlobDigest,
    });
    const { checkpoint } = settled(result.execution);
    expect(checkpoint?.targets[0]).toMatchObject({
      status: "failed",
      failureCode: "expected-revision-digest-mismatch",
      observation,
    });
    expect(result.confirmed).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("授权在提交前撤销时保留已确认的独立目标，已接受身份不被改写", async () => {
    const audio = carrierTarget({
      locationId: "location_wav",
      observedArtifactReference: "track.wav",
      observedReference: "track.wav",
      locationAddress: "/observed/RJ01668691/track.wav",
    });
    const pdf = carrierTarget();
    // 音轨已真实确认，PDF 的字节读取在提交前被撤权打断：同一冻结任务里的两个目标各自裁定。
    const stage = harness({
      execution: durablePendingExecution(
        [confirmedTarget(audio), pendingTarget(pdf)],
        "running",
      ),
      outcomes: [
        {
          kind: "needs-confirmation",
          target: pdf,
          observation: {
            selectionId: "selection_pdf_2",
            conditionalBaseline: "c".repeat(64),
          },
        },
      ],
      respond: () => ({
        kind: "failed" as const,
        failureCode: "directory-authority-revoked",
      }),
    });
    const result = await stage.run();

    const { disposition, checkpoint } = settled(result.execution);
    expect(disposition?.status).toBe("failed");
    expect(result.confirmed).toBe(1);
    expect(result.failed).toBe(1);
    expect(
      checkpoint?.targets.find(
        (target) => target.observedArtifactReference === "track.wav",
      )?.status,
    ).toBe("confirmed");
    expect(
      checkpoint?.targets.find(
        (target) => target.observedArtifactReference === "台本/script.pdf",
      ),
    ).toMatchObject({
      status: "failed",
      failureCode: "directory-authority-revoked",
    });
    expect(result.execution.acceptedAssetId).toBe("entity_subject");
    expect(result.execution.workItems?.[0]?.outcome).toBe("accepted");
  });

  it("没有目标时零效果：不新增检查点、不折算 partial、执行原样返回", async () => {
    const execution = executionBase();
    const stage = harness({ execution, planEntries: [] });
    const result = await stage.run();

    expect(result.execution).toBe(execution);
    expect(result.confirmed).toBe(0);
    expect(result.failed).toBe(0);
    expect(stage.calls.checkpointInputs).toEqual([]);
    expect(stage.calls.transitions).toEqual([]);
    expect(result.execution.dispositions).toEqual([]);
  });

  it("恢复携带同一 claim 令牌：检查点与终态转换都按同一 CAS 提交", async () => {
    const target = carrierTarget();
    const calls: Calls = {
      plan: 0,
      confirmations: [],
      checkpointInputs: [],
      transitions: [],
    };
    const persistence: LocalMaterialEvidencePersistence = {
      async planRequestedLocalMaterialConfirmations() {
        calls.plan += 1;
        return [{ target, prerequisiteObservation: null }];
      },
      async checkpointRequestedLocalMaterialConfirmations(request) {
        calls.checkpointInputs.push({
          dispositionKey: request.dispositionKey,
          entries: request.entries.length,
          ...(request.resumeClaim === undefined
            ? {}
            : { resumeClaim: request.resumeClaim }),
        });
        return {
          execution: request.execution,
          outcomes: [{ kind: "needs-confirmation", target, observation }],
        };
      },
      async verifyRequestedLocalMaterialConfirmationTerminals() {
        return [];
      },
    };
    await ensureRequestedLocalMaterialEvidence({
      execution: executionBase(),
      subjectIds: ["entity_subject"],
      informationRequirement: requirement,
      snapshots: [snapshot],
      assetLibraryId: "asset-library_1",
      resumeClaim: { token: "claim_1", now: "2026-10-09T01:00:00.000Z" },
      persistence,
      confirmation: {
        async confirmExpectedObservedRevision() {
          return {
            kind: "exact-confirmed",
            revisionId: target.expectedRevisionId,
          };
        },
      },
      transition: async (_expected, _next, resumeClaim) => {
        calls.transitions.push({
          from: "x",
          to: "y",
          resumeClaim: resumeClaim !== undefined,
        });
      },
    });

    expect(calls.checkpointInputs[0]?.resumeClaim).toEqual({
      token: "claim_1",
      now: "2026-10-09T01:00:00.000Z",
    });
    expect(calls.transitions[0]?.resumeClaim).toBe(true);
    expect(calls.checkpointInputs[0]?.dispositionKey).toBe(dispositionKey);
  });

  it("检查点只按载体合并任务：同一载体的多张图共享一条确认，目标不因新发现文件扩大", () => {
    const merged = mergeRequestedLocalMaterialConfirmationTargets([
      carrierTarget({ associationIds: ["association_b"] }),
      carrierTarget({ associationIds: ["association_a"] }),
      carrierTarget({
        associationIds: ["association_c"],
        locationId: "location_other",
      }),
    ]);
    expect(merged).toHaveLength(2);
    // 目标数组按精确坐标确定性排序，同一载体的多次消费只留一条任务。
    expect(merged[0]?.locationId).toBe("location_other");
    expect(merged[0]?.associationIds).toEqual(["association_c"]);
    expect(merged[1]?.locationId).toBe("location_pdf");
    expect(merged[1]?.associationIds).toEqual([
      "association_a",
      "association_b",
    ]);
  });

  it("区分「尚未建立观察」与「observation 字段类型错误」：前者合法，后者按损坏拒绝", () => {
    const pending: LocalMaterialConfirmationCheckpointTarget = {
      ...carrierTarget(),
      status: "pending",
    };
    const checkpoint: ObservedMaterialConfirmationCheckpoint = {
      version: requestedLocalMaterialConfirmationVersion,
      requirementKey,
      subjectIds: ["entity_subject"],
      targets: [pending],
    };
    // 属性缺失是合法的「还没读」：pending 目标可以完全没有观察事实。
    expect(
      decodeObservedMaterialConfirmationCheckpoint(checkpoint).targets,
    ).toEqual([pending]);
    // 崩溃窗口已随检查点提交观察、字节尚未确认时，pending 携带精确事实同样合法。
    const pendingWithObservation = {
      ...pending,
      observation: {
        selectionId: "selection_pdf",
        conditionalBaseline: "b".repeat(64),
      },
    };
    expect(
      decodeObservedMaterialConfirmationCheckpoint({
        ...checkpoint,
        targets: [pendingWithObservation],
      }).targets,
    ).toEqual([pendingWithObservation]);

    // 属性存在但类型错误是耐久状态损坏，绝不能降格成「没有该字段」继续。
    for (const wrong of ["selection_pdf", 42, true, null, ["selection_pdf"]])
      expect(() =>
        decodeObservedMaterialConfirmationCheckpoint({
          ...checkpoint,
          targets: [{ ...pending, observation: wrong }],
        }),
      ).toThrow(/observation 字段类型错误/);
    // 对象但字段不齐同样是损坏，只是由逐字段读取判定。
    expect(() =>
      decodeObservedMaterialConfirmationCheckpoint({
        ...checkpoint,
        targets: [
          { ...pending, observation: { selectionId: "selection_pdf" } },
        ],
      }),
    ).toThrow(/本地材料确认/);
  });

  it("载荷不可读时按执行损坏处理，绝不按没有该字段忽略", () => {
    const target = confirmedTarget();
    const checkpoint: ObservedMaterialConfirmationCheckpoint = {
      version: requestedLocalMaterialConfirmationVersion,
      requirementKey,
      subjectIds: ["entity_subject"],
      targets: [target],
    };
    expect(
      decodeObservedMaterialConfirmationCheckpoint(checkpoint).targets[0],
    ).toEqual(target);

    const broken: Record<string, unknown>[] = [
      { ...checkpoint, version: "requested-local-material-confirmation/2" },
      { ...checkpoint, subjectIds: [] },
      { ...checkpoint, targets: undefined },
      {
        ...checkpoint,
        targets: [{ ...target, expectedByteLength: "329" }],
      },
      { ...checkpoint, targets: [{ ...target, status: "skipped" }] },
      { ...checkpoint, targets: [{ ...target, frozenEntry: undefined }] },
      {
        ...checkpoint,
        targets: [{ ...target, status: "failed", failureCode: undefined }],
      },
      {
        ...checkpoint,
        targets: [{ ...target, status: "confirmed", observation: undefined }],
      },
    ];
    for (const value of broken)
      expect(() => decodeObservedMaterialConfirmationCheckpoint(value)).toThrow(
        /本地材料确认/,
      );

    // 旧执行没有该字段仍照常可读，恢复据此建立新检查点而不是失败。
    expect(
      findObservedMaterialConfirmationCheckpoint(
        executionBase([{ key: "source-enrichment:1", status: "completed" }])
          .dispositions,
        dispositionKey,
      ),
    ).toBeUndefined();
    expect(() =>
      findObservedMaterialConfirmationCheckpoint(
        durablePendingExecution([
          { ...target, status: "confirmed", observation: undefined },
        ]).dispositions,
        dispositionKey,
      ),
    ).toThrow(/本地材料确认/);
  });

  it("终态核对只改判被取代的成功目标，其余冻结坐标逐字保留", () => {
    const staleTarget = carrierTarget();
    const kept = carrierTarget({
      locationId: "location_other",
      observedArtifactReference: "其他/other.pdf",
      observedReference: "其他/other.pdf",
      locationAddress: "/observed/RJ01668691/其他/other.pdf",
    });
    const execution = durablePendingExecution(
      [confirmedTarget(staleTarget), confirmedTarget(kept)],
      "completed",
    );
    const unchanged = markLocalMaterialConfirmationTerminalsStale(
      execution,
      [],
    );
    expect(unchanged.failed).toBe(0);
    expect(unchanged.execution).toEqual(execution);

    const stale = markLocalMaterialConfirmationTerminalsStale(execution, [
      localMaterialConfirmationTargetKey(staleTarget),
    ]);
    expect(stale.failed).toBe(1);
    const checkpoint = findObservedMaterialConfirmationCheckpoint(
      stale.execution.dispositions,
      dispositionKey,
    );
    expect(checkpoint?.targets).toHaveLength(2);
    expect(checkpoint?.targets[0]).toEqual({
      ...confirmedTarget(staleTarget),
      status: "failed",
      failureCode: localMaterialConfirmationStaleCode,
    });
    expect(checkpoint?.targets[1]).toEqual(confirmedTarget(kept));
    expect(
      stale.execution.dispositions.find((item) => item.key === dispositionKey)
        ?.status,
    ).toBe("failed");
    expect(staleLocalMaterialConfirmationAddresses(stale.execution)).toEqual([
      staleTarget.locationAddress,
    ]);
  });
});
