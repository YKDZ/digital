import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  legacyManualRepresentedReference,
  legacyRepresentedObservedMaterialReference,
  observedMaterialReferenceRepresentsEntity,
} from "@digital/application";
import type { RecognitionProposal } from "@digital/domain";

/**
 * 派生实体封面的历史真实性与当前角色资格接缝。
 *
 * 一条 `asset.primary-cover` 且带观察部件、目标为实体的关联只可能由本地有界部分的兄弟
 * 关联派生：它的历史权威是「该投影能由已知生成程序自然产生」的完整结构证明，它的当前
 * 权威是修正后的代表规则。两者在这里分别输出，绝不互相代替；代表规则本身只有一份，来自
 * Application 的纯判定出口。
 */

const entityCoverSuffix = "_entity-cover";
const entityCoverRole = "asset.primary-cover";
const deliveredMaterialRole = "asset.material-delivered";

export type ObservedPartCoordinates = {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly locator: string;
};

export type DerivedCoverAssociationRow = {
  readonly id: string;
  readonly subjectId: string;
  readonly artifactId: string;
  readonly role: string;
  readonly targetKind: string;
  readonly targetEntityId: string | null;
  readonly targetArtifactId: string | null;
  readonly targetRevisionId: string | null;
  readonly observedArtifactPartJson: string | null;
};

export type DerivedCoverSupportRow = {
  readonly associationId: string;
  readonly recognitionDecisionId: string;
  readonly observationExecutionId: string | null;
  readonly observationSnapshotId: string | null;
  readonly observationLocationId: string | null;
  readonly observationMaterialKind: string | null;
  readonly observationRevisionId: string | null;
};

export type DerivedCoverDecisionRow = {
  readonly id: string;
  readonly assetId: string;
  readonly proposalId: string;
};

export type DerivedCoverProposalRow = {
  readonly id: string;
  readonly executionId: string;
  readonly boundariesJson: string;
  readonly basisJson: string;
  readonly ruleResultsJson: string;
  readonly observedMaterialInterpretationJson: string | null;
};

export type DerivedCoverRevisionRow = {
  readonly id: string;
  readonly artifactId: string;
  readonly blobDigest: string;
};

export type DerivedCoverBlobRow = {
  readonly digest: string;
  readonly mediaType: string;
  readonly byteLength: number;
};

export type DerivedCoverLocationRow = {
  readonly id: string;
  readonly artifactId: string;
  readonly kind: string;
  readonly address: string;
};

export type DerivedCoverAcceptanceRow = {
  readonly executionId: string;
  readonly proposalId: string;
  readonly workItemKey: string;
  readonly acceptanceKind: string;
  readonly assetId: string;
  readonly artifactId: string;
  readonly locationId: string;
  readonly associationId: string;
  readonly snapshotId: string;
  readonly observedReference: string;
};

export type DerivedCoverExecutionRow = {
  readonly id: string;
  readonly snapshotJson: string;
  readonly workItemsJson: string | null;
};

/** 当前资格读取所需的最小行集；只读路径按现有依赖各自装载。 */
export type DerivedCoverCurrentRows = {
  readonly associations: readonly DerivedCoverAssociationRow[];
  readonly supports: readonly DerivedCoverSupportRow[];
  readonly decisions: readonly DerivedCoverDecisionRow[];
  readonly proposals: readonly DerivedCoverProposalRow[];
  readonly revisions: readonly DerivedCoverRevisionRow[];
};

/** 历史真实性读取所需行集：在当前行集之外还要载体接受、执行快照与产物坐标。 */
export type DerivedCoverHistoryRows = DerivedCoverCurrentRows & {
  readonly acceptances: readonly DerivedCoverAcceptanceRow[];
  readonly executions: readonly DerivedCoverExecutionRow[];
  readonly locations: readonly DerivedCoverLocationRow[];
  readonly blobs: readonly DerivedCoverBlobRow[];
};

export type DerivedCoverVerdict = {
  readonly historicallySupported: boolean;
  readonly currentlyRepresentative: boolean;
  readonly reasons: readonly string[];
};

function parseJsonArray(value: string | null): readonly unknown[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function observedPartOf(
  association: DerivedCoverAssociationRow,
): ObservedPartCoordinates | undefined {
  if (association.observedArtifactPartJson === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(association.observedArtifactPartJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const part = parsed as Record<string, unknown>;
  if (
    typeof part.artifactId !== "string" ||
    typeof part.revisionId !== "string" ||
    typeof part.locator !== "string"
  )
    return undefined;
  return {
    artifactId: part.artifactId,
    revisionId: part.revisionId,
    locator: part.locator,
  };
}

export function isDerivedEntityCover(
  association: DerivedCoverAssociationRow,
): boolean {
  return (
    association.role === entityCoverRole &&
    association.targetKind === "entity" &&
    observedPartOf(association) !== undefined
  );
}

function siblingAssociationId(associationId: string): string | undefined {
  return associationId.endsWith(entityCoverSuffix)
    ? associationId.slice(0, -entityCoverSuffix.length)
    : undefined;
}

/** 派生封面所属的兄弟部件关联 ID；没有派生后缀就不是封面派生图，返回 undefined。 */
export function derivedCoverSiblingId(
  associationId: string,
): string | undefined {
  return siblingAssociationId(associationId);
}

function proposalFrom(
  row: DerivedCoverProposalRow | undefined,
): RecognitionProposal | undefined {
  if (row === undefined) return undefined;
  const boundaries = parseJsonArray(row.boundariesJson);
  const rules = parseJsonArray(row.ruleResultsJson);
  let basis: unknown;
  try {
    basis = JSON.parse(row.basisJson);
  } catch {
    return undefined;
  }
  if (
    boundaries === undefined ||
    rules === undefined ||
    typeof basis !== "object" ||
    basis === null
  )
    return undefined;
  const interpretation =
    row.observedMaterialInterpretationJson === null
      ? undefined
      : ((): unknown => {
          try {
            return JSON.parse(row.observedMaterialInterpretationJson ?? "");
          } catch {
            return undefined;
          }
        })();
  return {
    id: row.id,
    boundaries: boundaries as RecognitionProposal["boundaries"],
    basis: basis as RecognitionProposal["basis"],
    ruleResults: rules as RecognitionProposal["ruleResults"],
    ...(typeof interpretation === "object" && interpretation !== null
      ? (interpretation as Pick<
          RecognitionProposal,
          | "observedArtifactAssociations"
          | "observedArtifactParts"
          | "observedArtifactRevisions"
          | "observedMetadata"
        >)
      : {}),
  };
}

/**
 * 该提案行是否以「身份保持刷新」的身份点名这条决定与该次观察快照。
 */
function acceptedBoundaryRefreshCites(
  row: DerivedCoverProposalRow,
  decisionId: string,
  observationSnapshotId: string | null,
): boolean {
  if (observationSnapshotId === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.basisJson);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const basis = parsed as Record<string, unknown>;
  return (
    basis.kind === "accepted-boundary" &&
    basis.recognitionDecisionId === decisionId &&
    basis.observationSnapshotId === observationSnapshotId
  );
}

/**
 * 声明这条观察事实的提案：初始接受时就是决定自己的提案，且它必须属于该支持记录的那次观察执行。
 * 等尺寸等内容变更的身份保持刷新把新事实挂在同一条不可变决定上，声明它们的却是那次刷新自己的
 * accepted-boundary 提案——它同时点名这条决定与这次观察冻结的快照，别的执行、别的决定都不能
 * 充当依据。这里不放宽「谁声明」，只是把刷新这一已知生成程序补进模型；找不到确切声明行就按
 * 缺少依据判定，绝不退回去用一份坐标对不上的旧提案冒充。
 */
function declaringProposalRow(
  rows: DerivedCoverCurrentRows,
  decision: DerivedCoverDecisionRow,
  support: DerivedCoverSupportRow,
): DerivedCoverProposalRow | undefined {
  const own = rows.proposals.find((item) => item.id === decision.proposalId);
  if (
    own !== undefined &&
    support.observationExecutionId !== null &&
    own.executionId === support.observationExecutionId
  )
    return own;
  const citing = rows.proposals.filter(
    (item) =>
      support.observationExecutionId !== null &&
      item.executionId === support.observationExecutionId &&
      acceptedBoundaryRefreshCites(
        item,
        decision.id,
        support.observationSnapshotId,
      ),
  );
  return citing.length === 1 ? citing[0] : undefined;
}

/**
 * 封面部件在提案内的观察引用：同一角色与 locator 只声明一次，父修订唯一且摘要与载体
 * 实际修订相同，并且该引用同时被声明为交付材料。任何一项不成立都没有可判定的引用。
 */
function partObservedReference(input: {
  readonly proposal: RecognitionProposal;
  readonly materialRole: string;
  readonly locator: string;
  readonly carrierBlobDigest: string;
}): string | undefined {
  const parts = (input.proposal.observedArtifactParts ?? []).filter(
    (candidate) =>
      candidate.role === input.materialRole &&
      candidate.locator === input.locator,
  );
  if (parts.length !== 1) return undefined;
  const reference = parts[0]?.observedArtifactReference;
  if (typeof reference !== "string") return undefined;
  const revisions = (input.proposal.observedArtifactRevisions ?? []).filter(
    (candidate) => candidate.observedArtifactReference === reference,
  );
  if (
    revisions.length !== 1 ||
    revisions[0]?.blob.digest !== input.carrierBlobDigest
  )
    return undefined;
  const delivered = (input.proposal.observedArtifactAssociations ?? []).filter(
    (candidate) =>
      candidate.observedArtifactReference === reference &&
      candidate.role === deliveredMaterialRole,
  );
  return delivered.length === 1 ? reference : undefined;
}

function coverRepresentedById(
  proposal: RecognitionProposal,
  reference: string,
  allowLegacy: boolean,
): boolean {
  if (observedMaterialReferenceRepresentsEntity(proposal, reference))
    return true;
  return (
    allowLegacy &&
    (legacyRepresentedObservedMaterialReference(proposal) === reference ||
      legacyManualRepresentedReference(proposal) === reference)
  );
}

/** 封面与兄弟部件关联必须共用同一派生产物与同一部分坐标。 */
function coverSiblingConsistent(
  cover: DerivedCoverAssociationRow,
  sibling: DerivedCoverAssociationRow,
  part: ObservedPartCoordinates,
): boolean {
  const siblingPart = observedPartOf(sibling);
  return (
    sibling.role !== entityCoverRole &&
    sibling.targetKind === "artifact-revision" &&
    sibling.subjectId === cover.subjectId &&
    sibling.artifactId === cover.artifactId &&
    sibling.targetArtifactId === part.artifactId &&
    sibling.targetRevisionId === part.revisionId &&
    siblingPart !== undefined &&
    siblingPart.artifactId === part.artifactId &&
    siblingPart.revisionId === part.revisionId &&
    siblingPart.locator === part.locator
  );
}

function materializationKeyOf(input: {
  readonly digest: string;
  readonly role: string;
  readonly origin: string;
  readonly locator: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        digest: input.digest,
        role: input.role,
        origin: input.origin,
        locator: input.locator,
      }),
    )
    .digest("hex");
}

/**
 * 当前角色资格：只认修正规则，并要求授权决定未结束、主体即决定资产、兄弟部件坐标相同。
 * 返回 undefined 表示这条关联不是派生实体封面，调用方保持原有判定。
 */
export function derivedCoverCurrentlyRepresentative(
  rows: DerivedCoverCurrentRows,
  associationId: string,
  decisionEnded: (decisionId: string) => boolean = () => false,
): boolean | undefined {
  const cover = rows.associations.find(
    (association) => association.id === associationId,
  );
  if (cover === undefined) return undefined;
  if (!isDerivedEntityCover(cover)) return undefined;
  const part = observedPartOf(cover);
  if (part === undefined) return false;
  return rows.supports.some(
    (support) =>
      support.associationId === cover.id &&
      representableCoverSupport({
        rows,
        cover,
        part,
        support,
        allowLegacy: false,
        decisionEnded,
      }),
  );
}

function representableCoverSupport(input: {
  readonly rows: DerivedCoverCurrentRows;
  readonly cover: DerivedCoverAssociationRow;
  readonly part: ObservedPartCoordinates;
  readonly support: DerivedCoverSupportRow;
  readonly allowLegacy: boolean;
  readonly decisionEnded: (decisionId: string) => boolean;
}): boolean {
  const { rows, cover, part, support } = input;
  const decision = rows.decisions.find(
    (item) => item.id === support.recognitionDecisionId,
  );
  if (decision === undefined || input.decisionEnded(decision.id)) return false;
  if (decision.assetId !== cover.subjectId) return false;
  if (cover.targetEntityId !== decision.assetId) return false;
  const siblingId = siblingAssociationId(cover.id);
  if (siblingId === undefined) return false;
  const sibling = rows.associations.find(
    (association) => association.id === siblingId,
  );
  if (sibling === undefined || !coverSiblingConsistent(cover, sibling, part))
    return false;
  const revision = rows.revisions.find((item) => item.id === part.revisionId);
  if (revision === undefined || revision.artifactId !== part.artifactId)
    return false;
  const declaring = declaringProposalRow(rows, decision, support);
  const proposal = proposalFrom(declaring);
  if (proposal === undefined) return false;
  const reference = partObservedReference({
    proposal,
    materialRole: sibling.role,
    locator: part.locator,
    carrierBlobDigest: revision.blobDigest,
  });
  return (
    reference !== undefined &&
    coverRepresentedById(proposal, reference, input.allowLegacy)
  );
}

/**
 * 派生实体封面的完整历史校验：决定／提案／执行／工作项／原快照／载体接受／观察坐标／
 * 兄弟材料图／确定性 ID 逐项相符，代表条件满足修正规则或旧程序的准确历史公式之一。
 * 任何一项缺失都记为不成立，绝不按时间戳或角色名放宽。
 */
export function validateDerivedEntityCoverHistory(
  rows: DerivedCoverHistoryRows,
  support: DerivedCoverSupportRow,
): DerivedCoverVerdict {
  const reasons: string[] = [];
  const cover = rows.associations.find(
    (association) => association.id === support.associationId,
  );
  if (cover === undefined || !isDerivedEntityCover(cover))
    return {
      historicallySupported: false,
      currentlyRepresentative: false,
      reasons: ["unsupported-association"],
    };
  const part = observedPartOf(cover);
  if (part === undefined)
    return {
      historicallySupported: false,
      currentlyRepresentative: false,
      reasons: ["missing-part"],
    };
  const currentlyRepresentative = representableCoverSupport({
    rows,
    cover,
    part,
    support,
    allowLegacy: false,
    decisionEnded: () => false,
  });
  const historicallySupported = derivedCoverHistoryReasons({
    rows,
    cover,
    part,
    support,
    reasons,
  });
  return { historicallySupported, currentlyRepresentative, reasons };
}

function derivedCoverHistoryReasons(input: {
  readonly rows: DerivedCoverHistoryRows;
  readonly cover: DerivedCoverAssociationRow;
  readonly part: ObservedPartCoordinates;
  readonly support: DerivedCoverSupportRow;
  readonly reasons: string[];
}): boolean {
  const { rows, cover, part, support, reasons } = input;
  const fail = (reason: string): false => {
    reasons.push(reason);
    return false;
  };
  if (
    support.observationExecutionId === null ||
    support.observationSnapshotId === null ||
    support.observationLocationId === null ||
    support.observationRevisionId === null ||
    support.observationMaterialKind !== "file"
  )
    return fail("missing-observation-coordinates");
  if (support.observationRevisionId !== part.revisionId)
    return fail("part-revision-mismatch");
  const decision = rows.decisions.find(
    (item) => item.id === support.recognitionDecisionId,
  );
  if (decision === undefined) return fail("missing-decision");
  if (
    decision.assetId !== cover.subjectId ||
    cover.targetEntityId !== decision.assetId ||
    cover.targetKind !== "entity"
  )
    return fail("decision-subject-mismatch");
  const ownProposalRow = rows.proposals.find(
    (item) => item.id === decision.proposalId,
  );
  if (ownProposalRow === undefined) return fail("missing-proposal");
  const proposalRow = declaringProposalRow(rows, decision, support);
  if (proposalRow === undefined) return fail("proposal-execution-mismatch");
  const execution = rows.executions.find(
    (item) => item.id === proposalRow.executionId,
  );
  if (execution === undefined) return fail("missing-execution");
  let snapshotRoot: string | undefined;
  let snapshotId: string | undefined;
  try {
    const snapshot = JSON.parse(execution.snapshotJson) as {
      id?: unknown;
      root?: unknown;
    };
    snapshotId = typeof snapshot.id === "string" ? snapshot.id : undefined;
    snapshotRoot =
      typeof snapshot.root === "string" ? snapshot.root : undefined;
  } catch {
    return fail("unreadable-snapshot");
  }
  if (
    snapshotId === undefined ||
    snapshotId !== support.observationSnapshotId ||
    snapshotRoot === undefined
  )
    return fail("snapshot-coordinates-mismatch");
  const carrierRevision = rows.revisions.find(
    (item) => item.id === part.revisionId,
  );
  if (
    carrierRevision === undefined ||
    carrierRevision.artifactId !== part.artifactId
  )
    return fail("missing-carrier-revision");
  const carrierBlob = rows.blobs.find(
    (item) => item.digest === carrierRevision.blobDigest,
  );
  if (carrierBlob === undefined) return fail("missing-carrier-blob");
  const carrierLocation = rows.locations.find(
    (item) => item.id === support.observationLocationId,
  );
  if (
    carrierLocation === undefined ||
    carrierLocation.kind !== "observed" ||
    carrierLocation.artifactId !== part.artifactId
  )
    return fail("carrier-location-mismatch");
  const siblingId = siblingAssociationId(cover.id);
  if (siblingId === undefined) return fail("cover-id-shape");
  const sibling = rows.associations.find(
    (association) => association.id === siblingId,
  );
  if (sibling === undefined || !coverSiblingConsistent(cover, sibling, part))
    return fail("missing-sibling-material");
  const siblingSupport = rows.supports.some(
    (item) =>
      item.associationId === siblingId &&
      item.recognitionDecisionId === decision.id,
  );
  if (!siblingSupport) return fail("sibling-not-supported-by-decision");
  const derivedRevision = rows.revisions.find(
    (item) => item.artifactId === cover.artifactId,
  );
  if (derivedRevision === undefined) return fail("missing-derived-revision");
  const derivedBlob = rows.blobs.find(
    (item) => item.digest === derivedRevision.blobDigest,
  );
  if (derivedBlob === undefined) return fail("missing-derived-blob");
  const materializationKey = materializationKeyOf({
    digest: derivedRevision.blobDigest,
    role: sibling.role,
    origin: part.artifactId,
    locator: part.locator,
  });
  if (
    cover.id !==
      `artifact-association_${materializationKey}${entityCoverSuffix}` ||
    sibling.id !== `artifact-association_${materializationKey}` ||
    sibling.artifactId !== `artifact_${materializationKey}` ||
    derivedRevision.id !== `artifact-revision_${materializationKey}`
  )
    return fail("deterministic-identity-mismatch");
  const derivedLocation = rows.locations.find(
    (item) => item.id === `location_${materializationKey}`,
  );
  if (
    derivedLocation === undefined ||
    derivedLocation.kind !== "managed" ||
    derivedLocation.artifactId !== sibling.artifactId
  )
    return fail("missing-managed-location");
  const proposal = proposalFrom(proposalRow);
  if (proposal === undefined) return fail("unreadable-proposal");
  const reference = partObservedReference({
    proposal,
    materialRole: sibling.role,
    locator: part.locator,
    carrierBlobDigest: carrierRevision.blobDigest,
  });
  if (reference === undefined) return fail("undeclared-part-reference");
  if (carrierLocation.address !== `${snapshotRoot}/${reference}`)
    return fail("carrier-address-mismatch");
  const declaredRevision = (proposal.observedArtifactRevisions ?? []).find(
    (candidate) => candidate.observedArtifactReference === reference,
  );
  if (
    declaredRevision === undefined ||
    declaredRevision.blob.digest !== carrierBlob.digest ||
    declaredRevision.blob.mediaType !== carrierBlob.mediaType ||
    declaredRevision.blob.byteLength !== carrierBlob.byteLength
  )
    return fail("carrier-format-mismatch");
  const acceptance = rows.acceptances.find(
    (item) =>
      item.locationId === support.observationLocationId &&
      item.artifactId === part.artifactId &&
      item.snapshotId === support.observationSnapshotId &&
      item.observedReference === reference,
  );
  if (acceptance === undefined) return fail("missing-carrier-acceptance");
  if (
    acceptance.acceptanceKind !== "a-work-item" &&
    acceptance.acceptanceKind !== "b-local"
  )
    return fail("acceptance-kind-grants-no-derivation");
  if (
    acceptance.executionId !== support.observationExecutionId ||
    acceptance.proposalId !== proposalRow.id ||
    acceptance.assetId !== decision.assetId
  )
    return fail("acceptance-coordinates-mismatch");
  const carrierAssociation = rows.associations.find(
    (association) => association.id === acceptance.associationId,
  );
  if (
    carrierAssociation === undefined ||
    carrierAssociation.role !== deliveredMaterialRole ||
    carrierAssociation.subjectId !== decision.assetId ||
    carrierAssociation.targetKind !== "entity" ||
    carrierAssociation.targetEntityId !== decision.assetId ||
    carrierAssociation.artifactId !== acceptance.artifactId
  )
    return fail("carrier-association-mismatch");
  if (acceptance.acceptanceKind === "a-work-item") {
    const workItems = parseJsonArray(execution.workItemsJson) ?? [];
    const declared = workItems.some((item) => {
      if (typeof item !== "object" || item === null) return false;
      const workItem = item as Record<string, unknown>;
      return (
        workItem.key === acceptance.workItemKey &&
        workItem.proposalId === acceptance.proposalId &&
        workItem.acceptedAssetId === acceptance.assetId
      );
    });
    if (acceptance.workItemKey === "" || !declared)
      return fail("work-item-acceptance-mismatch");
  }
  return coverRepresentedById(proposal, reference, true);
}

/**
 * 就绪检查用的只读图加载：一次读取全部相关行，逐条派生封面支持输出独立判定。
 * 返回值里的 `supportKey` 是把该支持的精确观察坐标绑定回 SQL 历史分支的键。
 */
export type DerivedCoverReadinessEntry = {
  readonly supportKey: string;
  readonly verdict: DerivedCoverVerdict;
};

function supportKeyOf(support: DerivedCoverSupportRow): string {
  return [
    support.associationId,
    support.recognitionDecisionId,
    support.observationExecutionId ?? "",
    support.observationSnapshotId ?? "",
    support.observationLocationId ?? "",
    support.observationRevisionId ?? "",
  ].join("\u001f");
}

export function derivedCoverSupportKey(
  support: DerivedCoverSupportRow,
): string {
  return supportKeyOf(support);
}

const candidateSql = `
  SELECT support.association_id AS associationId,
         support.recognition_decision_id AS recognitionDecisionId,
         support.observation_execution_id AS observationExecutionId,
         support.observation_snapshot_id AS observationSnapshotId,
         support.observation_location_id AS observationLocationId,
         support.observation_material_kind AS observationMaterialKind,
         support.observation_revision_id AS observationRevisionId
  FROM artifact_association_recognition_supports AS support
  JOIN artifact_associations AS association
    ON association.id = support.association_id
  WHERE association.role = 'asset.primary-cover'
    AND association.target_kind = 'entity'
    AND association.observed_artifact_part_json IS NOT NULL
  ORDER BY support.association_id, support.recognition_decision_id
`;

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function nullableText(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

/**
 * 读取所有派生实体封面支持的历史图并给出判定。所有行在同一只读事务里取得，避免图读取
 * 期间被并发写入拆成两半。
 */
export function readDerivedEntityCoverReadiness(
  database: DatabaseSync,
): readonly DerivedCoverReadinessEntry[] {
  database.exec("SAVEPOINT derived_cover_read");
  try {
    const supports = database.prepare(candidateSql).all() as Record<
      string,
      unknown
    >[];
    if (supports.length === 0) {
      database.exec("RELEASE derived_cover_read");
      return [];
    }
    const associationIds = new Set<string>();
    const decisionIds = new Set<string>();
    const loaded = supports.map((row) => ({
      associationId: text(row, "associationId"),
      recognitionDecisionId: text(row, "recognitionDecisionId"),
      support: {
        associationId: text(row, "associationId"),
        recognitionDecisionId: text(row, "recognitionDecisionId"),
        observationExecutionId: nullableText(row, "observationExecutionId"),
        observationSnapshotId: nullableText(row, "observationSnapshotId"),
        observationLocationId: nullableText(row, "observationLocationId"),
        observationMaterialKind: nullableText(row, "observationMaterialKind"),
        observationRevisionId: nullableText(row, "observationRevisionId"),
      } satisfies DerivedCoverSupportRow,
    }));
    for (const item of loaded) {
      associationIds.add(item.associationId);
      const siblingId = siblingAssociationId(item.associationId);
      if (siblingId !== undefined) associationIds.add(siblingId);
      decisionIds.add(item.recognitionDecisionId);
    }
    const decisions = selectIds(
      database,
      `SELECT id AS id, asset_id AS assetId, proposal_id AS proposalId
       FROM recognition_decisions WHERE id IN (${placeholders(decisionIds.size)})`,
      [...decisionIds],
    );
    const proposalSelect = `
      SELECT id AS id, execution_id AS executionId, boundaries_json AS boundariesJson,
             basis_json AS basisJson, rule_results_json AS ruleResultsJson,
             observed_material_interpretation_json AS observedMaterialInterpretationJson
      FROM recognition_proposals`;
    const proposalIds = new Set(
      decisions.map((row) => text(row, "proposalId")),
    );
    // 内容变化的身份保持刷新由那次观察执行自己的 accepted-boundary 提案声明，判定要读到的正是
    // 那一行；只按决定的提案装载会让这条真实历史无法证明。多装载几行不放宽任何判定：具体依据
    // 仍由 `declaringProposalRow` 按「属于本观察执行、点名本决定、冻结本观察快照」逐条确认。
    const observationExecutionIds = new Set(
      loaded
        .map((item) => item.support.observationExecutionId)
        .filter((id): id is string => id !== null),
    );
    const proposals = [
      ...selectIds(
        database,
        `${proposalSelect} WHERE id IN (${placeholders(proposalIds.size)})`,
        [...proposalIds],
      ),
      ...selectIds(
        database,
        `${proposalSelect} WHERE execution_id IN (${placeholders(observationExecutionIds.size)})`,
        [...observationExecutionIds],
      ),
    ].filter(
      (row, index, rows) =>
        rows.findIndex(
          (candidate) => text(candidate, "id") === text(row, "id"),
        ) === index,
    );
    const executionIds = new Set(
      proposals.map((row) => text(row, "executionId")),
    );
    const executions = selectIds(
      database,
      `SELECT id AS id, snapshot_json AS snapshotJson, work_items_json AS workItemsJson
       FROM workflow_executions WHERE id IN (${placeholders(executionIds.size)})`,
      [...executionIds],
    );
    const allSupports = selectIds(
      database,
      `SELECT association_id AS associationId,
              recognition_decision_id AS recognitionDecisionId,
              observation_execution_id AS observationExecutionId,
              observation_snapshot_id AS observationSnapshotId,
              observation_location_id AS observationLocationId,
              observation_material_kind AS observationMaterialKind,
              observation_revision_id AS observationRevisionId
       FROM artifact_association_recognition_supports
       WHERE association_id IN (${placeholders(associationIds.size)})`,
      [...associationIds],
    );
    const associations = selectIds(
      database,
      `SELECT id AS id, subject_id AS subjectId, artifact_id AS artifactId, role AS role,
              target_kind AS targetKind, target_entity_id AS targetEntityId,
              target_artifact_id AS targetArtifactId,
              target_revision_id AS targetRevisionId,
              observed_artifact_part_json AS observedArtifactPartJson
       FROM artifact_associations WHERE id IN (${placeholders(associationIds.size)})`,
      [...associationIds],
    );
    const revisionIds = new Set<string>();
    const artifactIds = new Set<string>();
    for (const row of associations) {
      const part = observedPartOf(associationRow(row));
      const artifactId = nullableText(row, "artifactId");
      if (artifactId !== null) artifactIds.add(artifactId);
      if (part === undefined) continue;
      revisionIds.add(part.revisionId);
      artifactIds.add(part.artifactId);
      const targetArtifactId = nullableText(row, "targetArtifactId");
      if (targetArtifactId !== null) artifactIds.add(targetArtifactId);
    }
    const revisions =
      revisionIds.size === 0 || artifactIds.size === 0
        ? []
        : selectIds(
            database,
            `SELECT id AS id, artifact_id AS artifactId, blob_digest AS blobDigest
             FROM artifact_revisions
             WHERE id IN (${placeholders(revisionIds.size)})
                OR artifact_id IN (${placeholders(artifactIds.size)})`,
            [...revisionIds, ...artifactIds],
          );
    const digests = new Set(revisions.map((row) => text(row, "blobDigest")));
    const blobs = selectIds(
      database,
      `SELECT digest AS digest, media_type AS mediaType, byte_length AS byteLength
       FROM blobs WHERE digest IN (${placeholders(digests.size)})`,
      [...digests],
    );
    const observationLocationIds = new Set<string>();
    for (const item of loaded) {
      if (item.support.observationLocationId !== null)
        observationLocationIds.add(item.support.observationLocationId);
    }
    const managedLocationIds = new Set<string>();
    for (const row of associations) {
      const association = associationRow(row);
      if (observedPartOf(association) === undefined) continue;
      const key = /^artifact-association_([a-f0-9]{64})/u.exec(
        association.id,
      )?.[1];
      if (key !== undefined) managedLocationIds.add(`location_${key}`);
    }
    const allLocationIds = new Set([
      ...observationLocationIds,
      ...managedLocationIds,
    ]);
    const locations = selectIds(
      database,
      `SELECT id AS id, artifact_id AS artifactId, kind AS kind, address AS address
       FROM locations WHERE id IN (${placeholders(allLocationIds.size)})`,
      [...allLocationIds],
    );
    const carrierArtifactIds = new Set<string>();
    for (const row of associations) {
      const part = observedPartOf(associationRow(row));
      if (part !== undefined) carrierArtifactIds.add(part.artifactId);
    }
    const acceptances =
      observationLocationIds.size === 0 || carrierArtifactIds.size === 0
        ? []
        : selectIds(
            database,
            `SELECT execution_id AS executionId, proposal_id AS proposalId,
                    work_item_key AS workItemKey, acceptance_kind AS acceptanceKind,
                    asset_id AS assetId, artifact_id AS artifactId, location_id AS locationId,
                    association_id AS associationId, snapshot_id AS snapshotId,
                    observed_reference AS observedReference
             FROM observed_material_acceptances
             WHERE location_id IN (${placeholders(observationLocationIds.size)})
               AND artifact_id IN (${placeholders(carrierArtifactIds.size)})`,
            [...observationLocationIds, ...carrierArtifactIds],
          );
    // 载体交付关联不在封面兄弟集合里，按接受行的 association_id 再取一次。
    const carrierAssociationIds = new Set(
      acceptances.map((row) => text(row, "associationId")),
    );
    const carrierAssociations = selectIds(
      database,
      `SELECT id AS id, subject_id AS subjectId, artifact_id AS artifactId, role AS role,
              target_kind AS targetKind, target_entity_id AS targetEntityId,
              target_artifact_id AS targetArtifactId,
              target_revision_id AS targetRevisionId,
              observed_artifact_part_json AS observedArtifactPartJson
       FROM artifact_associations WHERE id IN (${placeholders(carrierAssociationIds.size)})`,
      [...carrierAssociationIds],
    );
    const historyRows: DerivedCoverHistoryRows = {
      associations: [
        ...associations.map(associationRow),
        ...carrierAssociations.map(associationRow),
      ],
      supports: allSupports.map(supportRow),
      decisions: decisions.map((row) => ({
        id: text(row, "id"),
        assetId: text(row, "assetId"),
        proposalId: text(row, "proposalId"),
      })),
      proposals: proposals.map((row) => ({
        id: text(row, "id"),
        executionId: text(row, "executionId"),
        boundariesJson: text(row, "boundariesJson"),
        basisJson: text(row, "basisJson"),
        ruleResultsJson: text(row, "ruleResultsJson"),
        observedMaterialInterpretationJson: nullableText(
          row,
          "observedMaterialInterpretationJson",
        ),
      })),
      revisions: revisions.map((row) => ({
        id: text(row, "id"),
        artifactId: text(row, "artifactId"),
        blobDigest: text(row, "blobDigest"),
      })),
      blobs: blobs.map((row) => ({
        digest: text(row, "digest"),
        mediaType: text(row, "mediaType"),
        byteLength: Number(row.byteLength ?? 0),
      })),
      locations: locations.map((row) => ({
        id: text(row, "id"),
        artifactId: text(row, "artifactId"),
        kind: text(row, "kind"),
        address: text(row, "address"),
      })),
      acceptances: acceptances.map((row) => ({
        executionId: text(row, "executionId"),
        proposalId: text(row, "proposalId"),
        workItemKey: text(row, "workItemKey"),
        acceptanceKind: text(row, "acceptanceKind"),
        assetId: text(row, "assetId"),
        artifactId: text(row, "artifactId"),
        locationId: text(row, "locationId"),
        associationId: text(row, "associationId"),
        snapshotId: text(row, "snapshotId"),
        observedReference: text(row, "observedReference"),
      })),
      executions: executions.map((row) => ({
        id: text(row, "id"),
        snapshotJson: text(row, "snapshotJson"),
        workItemsJson: nullableText(row, "workItemsJson"),
      })),
    };
    const entries = loaded.map((item) => ({
      supportKey: supportKeyOf(item.support),
      verdict: validateDerivedEntityCoverHistory(historyRows, item.support),
    }));
    database.exec("RELEASE derived_cover_read");
    return entries;
  } catch (error) {
    database.exec("ROLLBACK TO derived_cover_read");
    database.exec("RELEASE derived_cover_read");
    throw error;
  }
}

function selectIds(
  database: DatabaseSync,
  select: string,
  ids: readonly string[],
): Record<string, unknown>[] {
  if (ids.length === 0) return [];
  return database.prepare(select).all(...ids) as Record<string, unknown>[];
}

function placeholders(count: number): string {
  return Array.from({ length: Math.max(count, 1) }, () => "?").join(",");
}

function associationRow(
  row: Record<string, unknown>,
): DerivedCoverAssociationRow {
  return {
    id: text(row, "id"),
    subjectId: text(row, "subjectId"),
    artifactId: text(row, "artifactId"),
    role: text(row, "role"),
    targetKind: text(row, "targetKind"),
    targetEntityId: nullableText(row, "targetEntityId"),
    targetArtifactId: nullableText(row, "targetArtifactId"),
    targetRevisionId: nullableText(row, "targetRevisionId"),
    observedArtifactPartJson: nullableText(row, "observedArtifactPartJson"),
  };
}

function supportRow(row: Record<string, unknown>): DerivedCoverSupportRow {
  return {
    associationId: text(row, "associationId"),
    recognitionDecisionId: text(row, "recognitionDecisionId"),
    observationExecutionId: nullableText(row, "observationExecutionId"),
    observationSnapshotId: nullableText(row, "observationSnapshotId"),
    observationLocationId: nullableText(row, "observationLocationId"),
    observationMaterialKind: nullableText(row, "observationMaterialKind"),
    observationRevisionId: nullableText(row, "observationRevisionId"),
  };
}
