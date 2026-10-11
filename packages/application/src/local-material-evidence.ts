import { createHash } from "node:crypto";

import type {
  FilesystemPackageSnapshot,
  InformationRequirement,
  WorkflowExecution,
  WorkItemDisposition,
} from "./index.ts";

/**
 * 本次普通刷新内、按实际信息需求对精确载体建立的真实确认任务。它是执行 disposition
 * 容器里一份有界、类型化的可选载荷，不是新的平台状态：目标一旦建立就不再扩大，恢复只
 * 沿同一份冻结坐标核对，绝不重新查询当前候选把较新观察错当成原任务。
 */
export const requestedLocalMaterialConfirmationVersion =
  "requested-local-material-confirmation/1" as const;

/** 检查点里表示「坐标已被更晚观察、接受或授权变化取代」的稳定失败码。 */
export const localMaterialConfirmationStaleCode =
  "local-material-observation-stale";

/**
 * 终态替换执行／最终投影的事务重核发现已确认目标已被取代时抛出：整笔事务不写入，
 * 只回带被取代的目标键，由 Application 折算 partial 后重试。它刻意定义在 Application，
 * 让 SQLite 适配器与调用方共享同一类型，而不让领域/应用反向依赖 SQLite。
 */
export class LocalMaterialConfirmationTerminalStaleError extends Error {
  readonly staleTargetKeys: readonly string[];
  constructor(staleTargetKeys: readonly string[]) {
    super("Local material confirmation terminals are stale");
    this.name = "LocalMaterialConfirmationTerminalStaleError";
    this.staleTargetKeys = staleTargetKeys;
  }
}

export function isLocalMaterialConfirmationTerminalStaleError(
  error: unknown,
): error is LocalMaterialConfirmationTerminalStaleError {
  return error instanceof LocalMaterialConfirmationTerminalStaleError;
}

/** 需求与选定主体的绑定；同一执行内的检查点据此识别自己属于哪一次需求。 */
export function localMaterialConfirmationRequirementKey(input: {
  readonly subjectIds: readonly string[];
  readonly informationRequirement: InformationRequirement;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        subjects: [...input.subjectIds].toSorted(),
        artifactRoles: input.informationRequirement.artifactRoles
          .map((role) => [role.role, role.necessity, role.maximum ?? null])
          .toSorted((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
        metadata: input.informationRequirement.metadata
          .map((item) => [item.property, item.necessity])
          .toSorted((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
      }),
    )
    .digest("hex");
}

/** 一条协调 disposition 的耐久键；同一需求在同一执行内只有一份。 */
export function localMaterialConfirmationDispositionKey(
  requirementKey: string,
) {
  return `local-material-confirmation:${requirementKey}`;
}

/** 本执行冻结快照中与载体已接受位置精确对应的那个条目。 */
export type LocalMaterialConfirmationFrozenEntry = {
  readonly snapshotId: string;
  readonly snapshotRoot: string;
  readonly observedAt: string;
  readonly size: number;
  readonly modifiedAt: string;
};

/** 需要消费的精确载体目标（规划阶段的返回项）。 */
export type RequestedLocalMaterialConfirmationTarget = {
  readonly subjectId: string;
  /** 该载体一次确认所服务的本地派生关联；同一载体的多张图共享一条任务。 */
  readonly associationIds: readonly string[];
  readonly recognitionDecisionId: string;
  readonly proposalId: string;
  readonly observedArtifactReference: string;
  readonly carrierArtifactId: string;
  readonly locationId: string;
  readonly locationAddress: string;
  /** 载体相对本次冻结根的路径；单位置正向投影只接受该精确条目。 */
  readonly observedReference: string;
  readonly expectedRevisionId: string;
  readonly expectedBlobDigest: string;
  readonly expectedByteLength: number;
  readonly frozenEntry: LocalMaterialConfirmationFrozenEntry;
  /** 库语境读取携带的授权坐标；独立读取省略。 */
  readonly assetLibraryId?: string | undefined;
  readonly directoryAuthorityVersion?: number | undefined;
};

/** 检查点事务内建立并随之提交的精确正向观察事实。 */
export type LocalMaterialConfirmationObservation = {
  readonly selectionId: string;
  readonly conditionalBaseline: string;
};

/** 准备查询读到的前置当前观察坐标；检查点事务必须核对它仍未变化。 */
export type LocalMaterialConfirmationObservationCoordinates = {
  readonly snapshotId: string;
  readonly observedAt: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly conditionalBaseline: string;
};

/** 规划一项的完整交付：目标、前置观察 CAS 基线，以及恢复时已有的耐久事实。 */
export type LocalMaterialConfirmationPlanEntry = {
  readonly target: RequestedLocalMaterialConfirmationTarget;
  /** `null` 表示准备时该位置没有当前观察；检查点事务对「不存在」同样 CAS。 */
  readonly prerequisiteObservation: LocalMaterialConfirmationObservationCoordinates | null;
  /** 恢复沿耐久检查点已建立的事实核对，绝不重新建立或覆盖观察。 */
  readonly establishedObservation?: LocalMaterialConfirmationObservation;
  /** 耐久检查点里该项已裁定的状态；恢复只处理 pending。 */
  readonly storedStatus?: LocalMaterialConfirmationTargetStatus;
};

export type LocalMaterialConfirmationTargetStatus =
  | "pending"
  | "confirmed"
  | "failed";

export type LocalMaterialConfirmationCheckpointTarget =
  RequestedLocalMaterialConfirmationTarget & {
    readonly status: LocalMaterialConfirmationTargetStatus;
    readonly observation?: LocalMaterialConfirmationObservation | undefined;
    /** 稳定失败坐标，供诚实 partial 与重扫诊断使用；不含内部路径。 */
    readonly failureCode?: string | undefined;
  };

export type ObservedMaterialConfirmationCheckpoint = {
  readonly version: typeof requestedLocalMaterialConfirmationVersion;
  readonly requirementKey: string;
  readonly subjectIds: readonly string[];
  readonly targets: readonly LocalMaterialConfirmationCheckpointTarget[];
};

/** 目标按载体观察坐标确定性合并与排序：同一载体、观察与预期修订只确认一次。 */
export function mergeRequestedLocalMaterialConfirmationTargets(
  targets: readonly RequestedLocalMaterialConfirmationTarget[],
): readonly RequestedLocalMaterialConfirmationTarget[] {
  const merged = new Map<
    string,
    {
      readonly target: RequestedLocalMaterialConfirmationTarget;
      readonly associationIds: string[];
    }
  >();
  for (const target of targets) {
    const key = localMaterialConfirmationTargetKey(target);
    const existing = merged.get(key);
    if (existing === undefined)
      merged.set(key, { target, associationIds: [...target.associationIds] });
    else
      for (const id of target.associationIds) existing.associationIds.push(id);
  }
  return [...merged.entries()]
    .toSorted((left, right) => left[0].localeCompare(right[0]))
    .map(([, entry]) => ({
      ...entry.target,
      associationIds: [...new Set(entry.associationIds)].toSorted(),
    }));
}

export function localMaterialConfirmationTargetKey(target: {
  readonly subjectId: string;
  readonly observedArtifactReference: string;
  readonly carrierArtifactId: string;
  readonly locationId: string;
  readonly expectedRevisionId: string;
  readonly expectedBlobDigest: string;
}): string {
  return JSON.stringify([
    target.subjectId,
    target.observedArtifactReference,
    target.carrierArtifactId,
    target.locationId,
    target.expectedRevisionId,
    target.expectedBlobDigest,
  ]);
}

/** 检查点事务对单个目标的裁定：需要真实读取、早已精确确认，或坐标已被取代。 */
export type LocalMaterialConfirmationCheckpointOutcome =
  | {
      readonly kind: "needs-confirmation";
      readonly target: RequestedLocalMaterialConfirmationTarget;
      readonly observation: LocalMaterialConfirmationObservation;
    }
  | {
      readonly kind: "exact-confirmed";
      readonly target: RequestedLocalMaterialConfirmationTarget;
      readonly observation: LocalMaterialConfirmationObservation;
    }
  | {
      readonly kind: "stale";
      readonly target: RequestedLocalMaterialConfirmationTarget;
      readonly observation?: LocalMaterialConfirmationObservation;
    };

/** 本次确认请求的窄入口结果，与既有用户显式确认入口共享真实读取实现。 */
export type ExpectedObservedRevisionConfirmationResult =
  | {
      readonly kind: "exact-confirmed" | "already-exact";
      readonly revisionId: string;
    }
  | { readonly kind: "failed"; readonly failureCode: string };

/**
 * SQLite 侧的窄持久端口：规划只读保留的接受图，检查点在同一 immediate 事务内建立单位置
 * 正向观察、CAS 前置当前观察事实并把精确 facts 连同检查点一起写入耐久状态。它不建立
 * confirmation，不推断其他材料消失，不清库的 awaitingObservation，也不提前写成 completed。
 */
export type LocalMaterialEvidencePersistence = {
  /** 无扫描履行只复用精确当前观察所引用的真实执行输入；没有待确认载体时零效果。 */
  findCurrentLocalMaterialObservationExecutions?(input: {
    readonly subjectIds: readonly string[];
    readonly informationRequirement: InformationRequirement;
    readonly assetLibraryId?: string;
  }): Promise<readonly WorkflowExecution[]>;
  planRequestedLocalMaterialConfirmations(input: {
    readonly subjectIds: readonly string[];
    readonly informationRequirement: InformationRequirement;
    readonly snapshots: readonly FilesystemPackageSnapshot[];
    readonly assetLibraryId?: string | undefined;
    readonly currentObservationsOnly?: boolean;
  }): Promise<readonly LocalMaterialConfirmationPlanEntry[]>;
  /**
   * 在同一 immediate 事务内核对执行 CAS/claim、接受图与冻结坐标、仍有效的根与库授权，把
   * 检查点连同单位置正向观察写入耐久状态，并返回写入后的执行与每目标的裁定。
   */
  checkpointRequestedLocalMaterialConfirmations(input: {
    readonly expectedExecution: WorkflowExecution;
    readonly execution: WorkflowExecution;
    readonly dispositionKey: string;
    readonly entries: readonly LocalMaterialConfirmationPlanEntry[];
    readonly resumeClaim?: { readonly token: string; readonly now: string };
  }): Promise<{
    readonly execution: WorkflowExecution;
    readonly outcomes: readonly LocalMaterialConfirmationCheckpointOutcome[];
  }>;
  /** 沿耐久检查点里已确认的目标核对当前事实是否仍逐字相同，返回被取代的目标键。 */
  verifyRequestedLocalMaterialConfirmationTerminals(input: {
    readonly execution: WorkflowExecution;
  }): Promise<readonly string[]>;
};

/** byte-access 提供的受约束精确修订确认入口（第6节操作3）。 */
export type ExpectedObservedRevisionConfirmation = {
  confirmExpectedObservedRevision(input: {
    readonly selectionId: string;
    readonly expectedArtifactId: string;
    readonly expectedRevisionId: string;
    readonly expectedDigest: string;
    readonly expectedByteLength: number;
    readonly assetLibraryId?: string;
  }): Promise<ExpectedObservedRevisionConfirmationResult>;
};

const targetFields = [
  "subjectId",
  "associationIds",
  "recognitionDecisionId",
  "proposalId",
  "observedArtifactReference",
  "carrierArtifactId",
  "locationId",
  "locationAddress",
  "observedReference",
  "expectedRevisionId",
  "expectedBlobDigest",
  "expectedByteLength",
  "status",
] as const;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`本地材料确认检查点字段 ${field} 不可读取`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`本地材料确认检查点字段 ${field} 不可读取`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 耐久载荷的读取验证：未知版本、字段类型错误或跨执行坐标都视为执行损坏，绝不按「没有
 * 该字段」忽略。旧执行没有该字段仍照常可读（由调用方处理 undefined）。
 */
export function decodeObservedMaterialConfirmationCheckpoint(
  value: unknown,
): ObservedMaterialConfirmationCheckpoint {
  if (!isRecord(value)) throw new Error("本地材料确认检查点载荷不是对象");
  if (value.version !== requestedLocalMaterialConfirmationVersion)
    throw new Error("本地材料确认检查点版本未知");
  const requirementKey = requiredText(value.requirementKey, "requirementKey");
  if (!Array.isArray(value.subjectIds) || value.subjectIds.length === 0)
    throw new Error("本地材料确认检查点缺少选定主体");
  const subjectIds = value.subjectIds.map((item) =>
    requiredText(item, "subjectIds"),
  );
  if (!Array.isArray(value.targets))
    throw new Error("本地材料确认检查点缺少目标数组");
  const targets = value.targets.map((item) => {
    if (!isRecord(item)) throw new Error("本地材料确认目标不是对象");
    const associationIdsValue = item.associationIds;
    if (!Array.isArray(associationIdsValue) || associationIdsValue.length === 0)
      throw new Error("本地材料确认检查点字段 associationIds 不可读取");
    const associationIds = associationIdsValue.map((entry) =>
      requiredText(entry, "associationIds"),
    );
    const status = requiredText(item.status, "status");
    if (status !== "pending" && status !== "confirmed" && status !== "failed")
      throw new Error("本地材料确认目标状态未知");
    const byteLength = item.expectedByteLength;
    if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength))
      throw new Error("本地材料确认目标字节长度不可读取");
    const frozenEntry = item.frozenEntry;
    if (!isRecord(frozenEntry))
      throw new Error("本地材料确认目标缺少冻结快照条目");
    // 区分「属性不存在」（合法的尚未建立观察）与「属性存在但类型错误」（耐久状态损坏）。
    // 后者绝不能被当成缺字段忽略：pending 目标可以合法携带崩溃窗口已提交的观察事实。
    const rawObservation = item.observation;
    if (rawObservation !== undefined && !isRecord(rawObservation))
      throw new Error("本地材料确认目标 observation 字段类型错误");
    const observation = isRecord(rawObservation) ? rawObservation : undefined;
    const target: LocalMaterialConfirmationCheckpointTarget = {
      subjectId: requiredText(item.subjectId, "subjectId"),
      associationIds,
      recognitionDecisionId: requiredText(
        item.recognitionDecisionId,
        "recognitionDecisionId",
      ),
      proposalId: requiredText(item.proposalId, "proposalId"),
      observedArtifactReference: requiredText(
        item.observedArtifactReference,
        "observedArtifactReference",
      ),
      carrierArtifactId: requiredText(
        item.carrierArtifactId,
        "carrierArtifactId",
      ),
      locationId: requiredText(item.locationId, "locationId"),
      locationAddress: requiredText(item.locationAddress, "locationAddress"),
      observedReference: requiredText(
        item.observedReference,
        "observedReference",
      ),
      expectedRevisionId: requiredText(
        item.expectedRevisionId,
        "expectedRevisionId",
      ),
      expectedBlobDigest: requiredText(
        item.expectedBlobDigest,
        "expectedBlobDigest",
      ),
      expectedByteLength: byteLength,
      frozenEntry: {
        snapshotId: requiredText(
          frozenEntry.snapshotId,
          "frozenEntry.snapshotId",
        ),
        snapshotRoot: requiredText(
          frozenEntry.snapshotRoot,
          "frozenEntry.snapshotRoot",
        ),
        observedAt: requiredText(
          frozenEntry.observedAt,
          "frozenEntry.observedAt",
        ),
        size: requiredNumber(frozenEntry.size, "frozenEntry.size"),
        modifiedAt: requiredText(
          frozenEntry.modifiedAt,
          "frozenEntry.modifiedAt",
        ),
      },
      status,
      ...(observation === undefined
        ? {}
        : {
            observation: {
              selectionId: requiredText(
                observation.selectionId,
                "observation.selectionId",
              ),
              conditionalBaseline: requiredText(
                observation.conditionalBaseline,
                "observation.conditionalBaseline",
              ),
            },
          }),
      ...(item.assetLibraryId === undefined
        ? {}
        : {
            assetLibraryId: requiredText(item.assetLibraryId, "assetLibraryId"),
          }),
      ...(item.directoryAuthorityVersion === undefined
        ? {}
        : {
            directoryAuthorityVersion: requiredNumber(
              item.directoryAuthorityVersion,
              "directoryAuthorityVersion",
            ),
          }),
      ...(item.failureCode === undefined
        ? {}
        : { failureCode: requiredText(item.failureCode, "failureCode") }),
    };
    for (const field of targetFields) {
      if (field === "status" || field === "associationIds") continue;
      if (target[field] === undefined || target[field] === null)
        throw new Error(`本地材料确认检查点字段 ${field} 不可读取`);
    }
    if (status === "failed" && target.failureCode === undefined)
      throw new Error("本地材料确认失败目标缺少失败坐标");
    if (
      (status === "confirmed" || status === "failed") &&
      target.observation === undefined
    )
      throw new Error("本地材料确认已裁定目标缺少精确观察事实");
    return target;
  });
  return {
    version: requestedLocalMaterialConfirmationVersion,
    requirementKey,
    subjectIds,
    targets,
  };
}

/** 执行里该需求已有的检查点；旧执行没有该字段返回 undefined。 */
export function findObservedMaterialConfirmationCheckpoint(
  dispositions: readonly WorkItemDisposition[],
  dispositionKey: string,
): ObservedMaterialConfirmationCheckpoint | undefined {
  for (const disposition of dispositions) {
    if (disposition.key !== dispositionKey) continue;
    const payload = disposition.observedMaterialConfirmation;
    if (payload === undefined) return undefined;
    return decodeObservedMaterialConfirmationCheckpoint(payload);
  }
  return undefined;
}

/**
 * 把检查点事务算出的精确 facts 与裁定注入 Application 建立的目标列表。目标顺序与数量
 * 都不变：这是同一份冻结任务在事务前后的两个视图，绝不借合并扩大任务或换目标。
 */
export function attachLocalMaterialConfirmationObservations(
  checkpoint: ObservedMaterialConfirmationCheckpoint,
  outcomes: readonly {
    readonly targetKey: string;
    readonly status: LocalMaterialConfirmationTargetStatus;
    readonly observation?: LocalMaterialConfirmationObservation;
    readonly failureCode?: string;
  }[],
): ObservedMaterialConfirmationCheckpoint {
  const byKey = new Map(outcomes.map((item) => [item.targetKey, item]));
  return {
    ...checkpoint,
    targets: checkpoint.targets.map((target) => {
      const outcome = byKey.get(localMaterialConfirmationTargetKey(target));
      if (outcome === undefined) return target;
      return {
        ...target,
        status: outcome.status,
        ...(outcome.observation === undefined
          ? {}
          : { observation: outcome.observation }),
        ...(outcome.failureCode === undefined
          ? {}
          : { failureCode: outcome.failureCode }),
      };
    }),
  };
}

export function localMaterialConfirmationDispositions(
  dispositions: readonly WorkItemDisposition[],
  dispositionKey: string,
  checkpoint: ObservedMaterialConfirmationCheckpoint,
  status: "running" | "completed" | "failed",
): readonly WorkItemDisposition[] {
  const entry: WorkItemDisposition = {
    key: dispositionKey,
    status,
    observedMaterialConfirmation: checkpoint,
  };
  const replaced = dispositions.map((disposition) =>
    disposition.key === dispositionKey ? entry : disposition,
  );
  return dispositions.some((disposition) => disposition.key === dispositionKey)
    ? replaced
    : [...dispositions, entry];
}

/** 检查点里所有被取代的载体位置；终态完整投影必须跳过这些精确坐标。 */
export function staleLocalMaterialConfirmationAddresses(
  execution: WorkflowExecution,
): readonly string[] {
  const addresses: string[] = [];
  for (const disposition of execution.dispositions) {
    const payload = disposition.observedMaterialConfirmation;
    if (payload === undefined) continue;
    const checkpoint = decodeObservedMaterialConfirmationCheckpoint(payload);
    for (const target of checkpoint.targets)
      if (target.failureCode === localMaterialConfirmationStaleCode)
        addresses.push(target.locationAddress);
  }
  return [...new Set(addresses)];
}

/**
 * 终态核对把被取代的成功目标改判失败：只改状态与失败坐标，目标列表与冻结坐标不变，
 * 因此同一次终态折算既能诚实反映 partial，也让投影跳过这些精确坐标。
 */
export function markLocalMaterialConfirmationTerminalsStale(
  execution: WorkflowExecution,
  staleTargetKeys: readonly string[],
): { readonly execution: WorkflowExecution; readonly failed: number } {
  const stale = new Set(staleTargetKeys);
  let failed = 0;
  const dispositions = execution.dispositions.map((disposition) => {
    const payload = disposition.observedMaterialConfirmation;
    if (payload === undefined) return disposition;
    const checkpoint = decodeObservedMaterialConfirmationCheckpoint(payload);
    let changed = false;
    const targets = checkpoint.targets.map((target) => {
      if (
        !stale.has(localMaterialConfirmationTargetKey(target)) ||
        target.status === "failed"
      )
        return target;
      changed = true;
      failed += 1;
      return {
        ...target,
        status: "failed" as const,
        failureCode: localMaterialConfirmationStaleCode,
      };
    });
    if (!changed) return disposition;
    const nextCheckpoint = { ...checkpoint, targets };
    return localMaterialConfirmationDispositions(
      [disposition],
      disposition.key,
      nextCheckpoint,
      // 状态按改判后的目标判定：被取代的成功项已不再是全部确认，不能沿用旧数组写成 completed。
      targets.every((target) => target.status === "confirmed")
        ? "completed"
        : "failed",
    )[0]!;
  });
  return { execution: { ...execution, dispositions }, failed };
}

export type LocalMaterialEvidenceRunInput = {
  readonly execution: WorkflowExecution;
  readonly subjectIds: readonly string[];
  readonly informationRequirement: InformationRequirement;
  readonly snapshots: readonly FilesystemPackageSnapshot[];
  readonly assetLibraryId?: string | undefined;
  readonly resumeClaim?: { readonly token: string; readonly now: string };
  readonly persistence: LocalMaterialEvidencePersistence;
  readonly confirmation: ExpectedObservedRevisionConfirmation;
  readonly transition: (
    expected: WorkflowExecution,
    next: WorkflowExecution,
    resumeClaim?: { readonly token: string; readonly now: string },
  ) => Promise<void>;
};

export type LocalMaterialEvidenceRunResult = {
  readonly execution: WorkflowExecution;
  readonly confirmed: number;
  readonly failed: number;
};

/**
 * 第5节共同阶段：本地识别接受/重评估全部落库之后、按当前事实规划来源信息补充之前，为
 * 本次实际需求消费的精确载体建立真实确认。它只裁定自己固定的目标，零目标时不制造任何
 * partial，也不改变已接受身份。
 */
export async function ensureRequestedLocalMaterialEvidence(
  input: LocalMaterialEvidenceRunInput,
): Promise<LocalMaterialEvidenceRunResult> {
  const subjects = [...new Set(input.subjectIds)].toSorted();
  if (subjects.length === 0 || input.snapshots.length === 0)
    return { execution: input.execution, confirmed: 0, failed: 0 };
  const requirementKey = localMaterialConfirmationRequirementKey({
    subjectIds: subjects,
    informationRequirement: input.informationRequirement,
  });
  const dispositionKey =
    localMaterialConfirmationDispositionKey(requirementKey);
  const existing = findObservedMaterialConfirmationCheckpoint(
    input.execution.dispositions,
    dispositionKey,
  );
  const entries: readonly LocalMaterialConfirmationPlanEntry[] =
    existing === undefined
      ? await input.persistence.planRequestedLocalMaterialConfirmations({
          subjectIds: subjects,
          informationRequirement: input.informationRequirement,
          snapshots: input.snapshots,
          ...(input.execution.operationKind === "refresh-metadata"
            ? { currentObservationsOnly: true }
            : {}),
          ...(input.assetLibraryId === undefined
            ? {}
            : { assetLibraryId: input.assetLibraryId }),
        })
      : existing.targets.map((target) => ({
          target,
          prerequisiteObservation: null,
          ...(target.observation === undefined
            ? {}
            : { establishedObservation: target.observation }),
          storedStatus: target.status,
        }));
  if (entries.length === 0)
    return { execution: input.execution, confirmed: 0, failed: 0 };
  const checkpoint: ObservedMaterialConfirmationCheckpoint = {
    version: requestedLocalMaterialConfirmationVersion,
    requirementKey,
    subjectIds: subjects,
    targets: entries.map((entry) => ({
      ...entry.target,
      status:
        entry.storedStatus === "confirmed" || entry.storedStatus === "failed"
          ? entry.storedStatus
          : "pending",
      ...(entry.establishedObservation === undefined
        ? {}
        : { observation: entry.establishedObservation }),
      ...(entry.target.assetLibraryId === undefined
        ? {}
        : { assetLibraryId: entry.target.assetLibraryId }),
      ...(entry.target.directoryAuthorityVersion === undefined
        ? {}
        : {
            directoryAuthorityVersion: entry.target.directoryAuthorityVersion,
          }),
    })),
  };
  const pendingExecution: WorkflowExecution = {
    ...input.execution,
    dispositions: localMaterialConfirmationDispositions(
      input.execution.dispositions,
      dispositionKey,
      checkpoint,
      "running",
    ),
  };
  const { execution: durableExecution, outcomes } =
    await input.persistence.checkpointRequestedLocalMaterialConfirmations({
      expectedExecution: input.execution,
      execution: pendingExecution,
      dispositionKey,
      entries,
      ...(input.resumeClaim === undefined
        ? {}
        : { resumeClaim: input.resumeClaim }),
    });
  const durableCheckpoint = findObservedMaterialConfirmationCheckpoint(
    durableExecution.dispositions,
    dispositionKey,
  );
  if (durableCheckpoint === undefined)
    throw new Error("本地材料确认检查点未随正向观察提交");
  const statuses: {
    readonly targetKey: string;
    readonly status: LocalMaterialConfirmationTargetStatus;
    readonly observation?: LocalMaterialConfirmationObservation;
    readonly failureCode?: string;
  }[] = [];
  const outcomeObservations = new Map<
    string,
    LocalMaterialConfirmationObservation
  >();
  for (const outcome of outcomes) {
    const targetKey = localMaterialConfirmationTargetKey(outcome.target);
    if (outcome.observation !== undefined)
      outcomeObservations.set(targetKey, outcome.observation);
    if (outcome.kind === "stale") {
      statuses.push({
        // 位置已无可观察事实时保留为未完成目标：状态仍 pending，但有界失败码留在载荷里，
        // 既不会被当成空成功，也不会伪造一份观察。
        targetKey,
        status: outcome.observation === undefined ? "pending" : "failed",
        ...(outcome.observation === undefined
          ? {}
          : { observation: outcome.observation }),
        failureCode: localMaterialConfirmationStaleCode,
      });
      continue;
    }
    if (outcome.kind === "exact-confirmed") {
      statuses.push({
        targetKey,
        status: "confirmed",
        observation: outcome.observation,
      });
      continue;
    }
    const confirmed = await input.confirmation.confirmExpectedObservedRevision({
      selectionId: outcome.observation.selectionId,
      expectedArtifactId: outcome.target.carrierArtifactId,
      expectedRevisionId: outcome.target.expectedRevisionId,
      expectedDigest: outcome.target.expectedBlobDigest,
      expectedByteLength: outcome.target.expectedByteLength,
      ...(outcome.target.assetLibraryId === undefined
        ? {}
        : { assetLibraryId: outcome.target.assetLibraryId }),
    });
    if (confirmed.kind === "failed")
      statuses.push({
        targetKey,
        status: "failed",
        observation: outcome.observation,
        failureCode: confirmed.failureCode,
      });
    else
      statuses.push({
        targetKey,
        status: "confirmed",
        observation: outcome.observation,
      });
  }
  for (const entry of entries) {
    if (entry.storedStatus === undefined) continue;
    const targetKey = localMaterialConfirmationTargetKey(entry.target);
    if (
      outcomes.some(
        (item) => localMaterialConfirmationTargetKey(item.target) === targetKey,
      )
    )
      continue;
    statuses.push({
      targetKey,
      status: entry.storedStatus,
      ...(entry.establishedObservation === undefined
        ? {}
        : { observation: entry.establishedObservation }),
    });
  }
  const settledCheckpoint = attachLocalMaterialConfirmationObservations(
    durableCheckpoint,
    statuses,
  );
  const failed = settledCheckpoint.targets.filter(
    (target) =>
      target.status === "failed" ||
      (target.status === "pending" && target.failureCode !== undefined),
  ).length;
  const confirmed = settledCheckpoint.targets.filter(
    (target) => target.status === "confirmed",
  ).length;
  const settledExecution: WorkflowExecution = {
    ...durableExecution,
    dispositions: localMaterialConfirmationDispositions(
      durableExecution.dispositions,
      dispositionKey,
      settledCheckpoint,
      failed === 0 ? "completed" : "failed",
    ),
  };
  await input.transition(durableExecution, settledExecution, input.resumeClaim);
  return { execution: settledExecution, confirmed, failed };
}
