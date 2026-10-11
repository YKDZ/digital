import type { RecognitionProposal } from "@digital/domain";

/**
 * 代表引用判定：一条本地材料的内容事实能否代表资产本身，只由**被接受的材料边界**决定，
 * 不由「本次格式检查恰好只覆盖一个修订」决定。三个允许来源是人工明确单材料、合法离散
 * 单材料与来源规则在目录内明确声明的代表材料；目录邻近、唯一被检查与封面缺失都不是依据。
 *
 * 生成、重扫 reconciliation 与持久化当前读取共用这一份纯判定，避免规则在各端各自漂移。
 */

/** 被本次本地检查覆盖的修订引用；这些是「同一条材料」坐标，不是代表依据本身。 */
function inspectedObservedReferences(
  proposal: RecognitionProposal,
): ReadonlySet<string> {
  return new Set(
    (proposal.observedArtifactRevisions ?? []).map(
      (candidate) => candidate.observedArtifactReference,
    ),
  );
}

/**
 * 该引用是否被接受边界自己的依据覆盖：`observed-evidence` 必须有 satisfied 规则检查该
 * 材料；`accepted-boundary` 用同一条决定冻结的 inspection 证据；人工明确单材料不强加不
 * 存在的自动规则。失败规则的 evidence 永远不能授予代表资格。
 */
function coveredByAcceptedBasis(
  proposal: RecognitionProposal,
  reference: string,
): boolean {
  const { basis } = proposal;
  if (basis.kind === "manual-boundary") return true;
  if (basis.kind === "observed-evidence")
    return basis.artifactRevisions.some(
      (candidate) =>
        candidate.observedArtifactReference === reference &&
        proposal.ruleResults.some(
          (result) =>
            result.outcome === "satisfied" &&
            result.evidence.some(
              (evidence) =>
                evidence.inspection?.observedArtifactReference === reference,
            ),
        ),
    );
  if (basis.kind === "accepted-boundary")
    return basis.evidence.some(
      (evidence) =>
        evidence.inspection?.observedArtifactReference === reference,
    );
  return false;
}

function representativeReferencesWithin(
  proposal: RecognitionProposal,
  inspected: ReadonlySet<string>,
): readonly string[] {
  const { basis } = proposal;
  if (basis.kind === "manual-boundary") {
    // 人工明确单材料：唯一被声明的材料兼任代表，但仍必须对应真实的候选修订。
    if (basis.materialReferences.length !== 1) return [];
    const [reference] = basis.materialReferences;
    return reference !== undefined && inspected.has(reference)
      ? [reference]
      : [];
  }
  if (basis.kind !== "observed-evidence" && basis.kind !== "accepted-boundary")
    return [];
  const [boundary] = proposal.boundaries;
  if (proposal.boundaries.length !== 1 || boundary === undefined) return [];
  if (boundary.kind === "discrete") {
    // 整条边界就是一个文件时，被接受材料与本次检查必须同指那一份内容。
    if (boundary.materialReferences.length !== 1) return [];
    const [reference] = boundary.materialReferences;
    if (
      reference === undefined ||
      inspected.size !== 1 ||
      !inspected.has(reference)
    )
      return [];
    if (
      basis.kind === "observed-evidence" &&
      basis.artifactRevisions.length !== 1
    )
      return [];
    return [reference];
  }
  // 目录范围只认来源规则明确声明的代表材料；核心不解析路径，也不按格式或顺序任选。
  return [
    ...new Set(
      (proposal.observedArtifactAssociations ?? [])
        .filter((candidate) => candidate.role === "asset.representative-body")
        .map((candidate) => candidate.observedArtifactReference)
        .filter((reference) => inspected.has(reference)),
    ),
  ].toSorted();
}

/** 可作为实体代表（封面、标题等）的观察材料引用集合。 */
export function representativeObservedMaterialReferences(
  proposal: RecognitionProposal,
): ReadonlySet<string> {
  const inspected = inspectedObservedReferences(proposal);
  const candidates = representativeReferencesWithin(proposal, inspected);
  return candidates.every((reference) =>
    coveredByAcceptedBasis(proposal, reference),
  )
    ? new Set(candidates)
    : new Set();
}

/**
 * 代表正文元数据适用的引用判定：与封面共用同一份代表依据，只保留其自身基类限制（人工
 * 边界不自动授予标题代表正文）。
 */
export function representativeBodyMaterialReferences(
  proposal: RecognitionProposal,
): ReadonlySet<string> {
  if (
    proposal.basis.kind !== "observed-evidence" &&
    proposal.basis.kind !== "accepted-boundary"
  )
    return new Set();
  return representativeObservedMaterialReferences(proposal);
}

/**
 * 修正前生成程序使用的准确历史公式：唯一被检查的修订加上引用出现在规则证据里即视为代表
 * （旧实现不检查 outcome）。仅供历史真实性校验复现「这条投影能由已知旧程序自然产生」，
 * 绝不授予当前角色。
 */
export function legacyRepresentedObservedMaterialReference(
  proposal: RecognitionProposal,
): string | undefined {
  const observedRevisions =
    proposal.basis.kind === "observed-evidence"
      ? proposal.basis.artifactRevisions
      : (proposal.observedArtifactRevisions ?? []);
  if (observedRevisions.length !== 1) return undefined;
  const [revision] = observedRevisions;
  if (revision === undefined) return undefined;
  return proposal.ruleResults.some((result) =>
    result.evidence.some(
      (evidence) =>
        evidence.inspection?.observedArtifactReference ===
        revision.observedArtifactReference,
    ),
  )
    ? revision.observedArtifactReference
    : undefined;
}

/** 历史公式的人工分支：唯一材料引用即视为代表。 */
export function legacyManualRepresentedReference(
  proposal: RecognitionProposal,
): string | undefined {
  if (proposal.basis.kind !== "manual-boundary") return undefined;
  return proposal.basis.materialReferences.length === 1
    ? proposal.basis.materialReferences[0]
    : undefined;
}

/** 这条本地部分引用按修正规则是否代表实体。 */
export function observedMaterialReferenceRepresentsEntity(
  proposal: RecognitionProposal,
  reference: string,
): boolean {
  return representativeObservedMaterialReferences(proposal).has(reference);
}
