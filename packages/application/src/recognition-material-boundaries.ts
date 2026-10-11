import path from "node:path";

import {
  recognitionMaterialBoundaryKey,
  type RecognitionMaterialBoundary,
} from "@digital/domain";

import type {
  AssetRefreshWorkItemPlan,
  FilesystemPackageSnapshot,
  AssetRefreshWorkPlan,
} from "./index.ts";
import type { ObservedRootSnapshot } from "./observed-root-registrations.ts";

/** 能力声明的资产范围；技术产物打包和本次成员清单各自独立。 */
export type PlannedMaterialBoundary =
  | { readonly kind: "directory"; readonly relativePath: string }
  | { readonly kind: "discrete"; readonly relativePaths: readonly string[] };

export type EffectiveRecognitionMaterialBoundary = {
  readonly assetId: string;
  readonly decisionId: string;
  readonly boundary: RecognitionMaterialBoundary;
  /** 内部观察坐标，只用于范围比较，不证明文件对象连续性。 */
  readonly rootPath: string;
};

/**
 * 一个识别决定的完整声明：全部声明成员连同各自实际绑定的观察根坐标，以及该决定
 * 当前是仍在生效还是已经结束。逐决定规划、完整声明相交和范围局部基线比较都只读
 * 这一形状，绝不以本次可见文件代替整个声明。
 */
export type MaterialScopeDeclaration = {
  readonly assetId: string;
  readonly decisionId: string;
  readonly members: readonly EffectiveRecognitionMaterialBoundary[];
  readonly status: "effective" | "ended";
  /** 结束原因；只在 `status === "ended"` 时存在。 */
  readonly endedAs?: "superseded" | "retracted";
  /** 该决定是否仍是该内容的当前身份头。 */
  readonly isHead: boolean;
};

/** 按决定聚合成完整声明；成员顺序无关，根坐标缺失的项由调用方先行剔除。 */
export function groupMaterialScopeDeclarations(
  effective: readonly EffectiveRecognitionMaterialBoundary[],
  options: {
    readonly ended?: readonly {
      readonly assetId: string;
      readonly decisionId: string;
      readonly endedAs: "superseded" | "retracted";
    }[];
    readonly headDecisionIds?: readonly string[];
  } = {},
): readonly MaterialScopeDeclaration[] {
  const members = new Map<string, EffectiveRecognitionMaterialBoundary[]>();
  for (const item of effective) {
    const items = members.get(item.decisionId) ?? [];
    items.push(item);
    members.set(item.decisionId, items);
  }
  const ended = new Map(
    (options.ended ?? []).map((item) => [item.decisionId, item.endedAs]),
  );
  const heads = new Set(options.headDecisionIds ?? []);
  return [...members].map(([decisionId, items]) => {
    const endedAs = ended.get(decisionId);
    return {
      assetId: items[0]!.assetId,
      decisionId,
      members: items,
      status: endedAs === undefined ? "effective" : "ended",
      ...(endedAs === undefined ? {} : { endedAs }),
      isHead: heads.has(decisionId),
    } satisfies MaterialScopeDeclaration;
  });
}

/**
 * 边界身份只相对本次实际绑定的观察根：`boundRoot` 必须是创建该快照的
 * `BoundObservedScope.root`，绝不能从冻结根数组里挑第一个包含项，否则重叠根会把
 * 同一子目录定位到不同范围身份。
 */
export function bindRecognitionMaterialBoundaries(input: {
  readonly snapshot: FilesystemPackageSnapshot;
  readonly boundRoot: ObservedRootSnapshot;
  readonly relativePaths: readonly string[];
  readonly materialBoundary?: PlannedMaterialBoundary;
}): readonly RecognitionMaterialBoundary[] {
  const root = input.boundRoot;
  if (!isWithinObservedDirectory(root.containerPath, input.snapshot.root))
    throw new Error("识别材料范围缺少冻结的观察根");
  const reference = (value: string): string => {
    const address = path.resolve(input.snapshot.root, value);
    if (!isWithinObservedDirectory(input.snapshot.root, address))
      throw new Error("识别材料范围超出本次观察");
    return (
      path.relative(root.containerPath, address).split(path.sep).join("/") ||
      "."
    );
  };
  if (input.materialBoundary?.kind === "directory") {
    const directory = input.materialBoundary.relativePath;
    if (
      directory !== "." &&
      !input.snapshot.directories?.some(
        (item) => item.relativePath === directory,
      )
    )
      throw new Error("持续材料范围必须引用本次明确观察的目录");
    const address = path.resolve(input.snapshot.root, directory);
    if (
      input.relativePaths.some(
        (value) =>
          !isWithinObservedDirectory(
            address,
            path.resolve(input.snapshot.root, value),
          ),
      ) ||
      input.snapshot.files.some(
        (file) =>
          isWithinObservedDirectory(
            address,
            path.resolve(input.snapshot.root, file.relativePath),
          ) && !input.relativePaths.includes(file.relativePath),
      )
    )
      throw new Error("目录资产候选必须完整选择该目录内已观察的材料");
    return [
      {
        kind: "directory",
        scopeReference: root.id,
        directoryReference: reference(directory),
      },
    ];
  }
  const references =
    input.materialBoundary?.relativePaths ?? input.relativePaths;
  if (
    references.length !== input.relativePaths.length ||
    references.some((value) => !input.relativePaths.includes(value)) ||
    references.some(
      (value) =>
        !input.snapshot.files.some((file) => file.relativePath === value),
    )
  )
    throw new Error("离散资产范围必须与本次明确选择的观察材料一致");
  return references.length === 0
    ? []
    : [
        {
          kind: "discrete",
          scopeReference: root.id,
          materialReferences: [
            ...new Set(references.map(reference)),
          ].toSorted(),
        },
      ];
}

/** 观察坐标的稳定实际地址：范围比较只用它，绝不解释路径含义。 */
export function observedAddress(
  containerPath: string,
  relativePath: string,
): string {
  return path.resolve(containerPath, relativePath);
}

export function isWithinObservedDirectory(
  directory: string,
  address: string,
): boolean {
  const relative = path.relative(directory, address);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export function materialBoundaryIncludesAddress(
  item: EffectiveRecognitionMaterialBoundary,
  address: string,
): boolean {
  return item.boundary.kind === "directory"
    ? isWithinObservedDirectory(
        path.resolve(item.rootPath, item.boundary.directoryReference),
        address,
      )
    : item.boundary.materialReferences.some(
        (reference) =>
          path.resolve(item.rootPath, reference) === path.resolve(address),
      );
}

/**
 * 该有效范围是否与一次刷新的观察范围相交：范围落在本次范围内，或本次范围落在
 * 该目录／材料所在的观察目录内。Application 冻结基线与 SQLite 事务内重算共用。
 */
export function recognitionMaterialBoundaryIntersectsScope(
  item: EffectiveRecognitionMaterialBoundary,
  scopeAddress: string,
): boolean {
  return (
    materialBoundaryIncludesAddress(item, scopeAddress) ||
    (item.boundary.kind === "directory"
      ? isWithinObservedDirectory(
          scopeAddress,
          path.resolve(item.rootPath, item.boundary.directoryReference),
        )
      : item.boundary.materialReferences.some((reference) =>
          isWithinObservedDirectory(
            scopeAddress,
            path.resolve(item.rootPath, reference),
          ),
        ))
  );
}

/**
 * 普通刷新的提交基线：相交的每个有效决定及其规范边界。取代与撤回头已经体现在
 * `effective` 的筛选里，因此基线变化即范围身份变化。Application 规划与 SQLite
 * 事务内比较共用这一形状。
 */
export function recognitionBoundaryBaseline(
  effective: readonly {
    readonly decisionId: string;
    readonly boundary: RecognitionMaterialBoundary;
  }[],
): readonly string[] {
  return effective
    .map(
      (item) =>
        `${item.decisionId}\u0000${recognitionMaterialBoundaryKey(item.boundary)}`,
    )
    .toSorted();
}

/** 冻结范围基线与提交时仍然生效的范围不一致；这次刷新不能产生任何写入。 */
export class RecognitionBoundaryBaselineStale extends Error {
  constructor() {
    super("材料范围已被其他决定修改，请重新检查后再刷新");
    this.name = "RecognitionBoundaryBaselineStale";
  }
}

/** 声明成员在其实际绑定根下的目录地址；离散成员没有目录地址。 */
function memberDirectoryAddress(
  member: EffectiveRecognitionMaterialBoundary,
): string | undefined {
  return member.boundary.kind === "directory"
    ? path.resolve(member.rootPath, member.boundary.directoryReference)
    : undefined;
}

/**
 * 声明成员实际钉住的观察地址：离散成员逐引用给出；目录成员是开放范围，只有配合本次
 * 快照时才能枚举其内已观察的材料。
 */
export function memberMaterialAddresses(
  member: EffectiveRecognitionMaterialBoundary,
  snapshot?: FilesystemPackageSnapshot,
): readonly string[] {
  if (member.boundary.kind === "discrete")
    return member.boundary.materialReferences.map((reference) =>
      path.resolve(member.rootPath, reference),
    );
  const directory = memberDirectoryAddress(member);
  if (directory === undefined || snapshot === undefined) return [];
  return snapshot.files
    .filter((file) =>
      isWithinObservedDirectory(
        directory,
        path.resolve(snapshot.root, file.relativePath),
      ),
    )
    .map((file) => path.resolve(snapshot.root, file.relativePath));
}

/**
 * 本次观察是否仍证明该声明成员被完整看到：落在本次根内的目录必须仍是明确观察到的目录、
 * 扫描仍完整，且范围内没有排除项或诊断。文件祖先只证明目录存在，不赋持续授权；缺失
 * `directories` 的旧版仅文件记录只能证明根本身。
 */
export function observationKeepsDeclarationIntegrity(
  snapshot: FilesystemPackageSnapshot,
  member: EffectiveRecognitionMaterialBoundary,
): boolean {
  const directory = memberDirectoryAddress(member);
  if (directory === undefined) return true;
  if (!snapshot.complete) return false;
  const inside = (relativePath: string) =>
    isWithinObservedDirectory(
      directory,
      path.resolve(snapshot.root, relativePath),
    );
  if (
    isWithinObservedDirectory(snapshot.root, directory) &&
    !(
      snapshot.directories?.some(
        (item) => path.resolve(snapshot.root, item.relativePath) === directory,
      ) ?? directory === snapshot.root
    )
  )
    return false;
  if (snapshot.excluded.some((item) => inside(item.relativePath))) return false;
  return !(snapshot.diagnostics ?? []).some((item) =>
    inside(item.relativePath),
  );
}

/**
 * 两个声明成员是否相交：目录祖先或相同、离散引用落在目录内、离散集合共享引用。只用
 * 稳定实际根坐标与路径段，绝不以本次读取成功的文件代替整个声明。
 */
function recognitionMaterialMembersIntersect(
  left: EffectiveRecognitionMaterialBoundary,
  right: EffectiveRecognitionMaterialBoundary,
): boolean {
  const leftDirectory = memberDirectoryAddress(left);
  const rightDirectory = memberDirectoryAddress(right);
  if (leftDirectory !== undefined && rightDirectory !== undefined)
    return (
      isWithinObservedDirectory(leftDirectory, rightDirectory) ||
      isWithinObservedDirectory(rightDirectory, leftDirectory)
    );
  if (leftDirectory !== undefined || rightDirectory !== undefined) {
    const directory = leftDirectory ?? rightDirectory!;
    const inner = leftDirectory === undefined ? left : right;
    return (
      inner.boundary.kind === "discrete" &&
      inner.boundary.materialReferences.some((reference) =>
        isWithinObservedDirectory(
          directory,
          path.resolve(inner.rootPath, reference),
        ),
      )
    );
  }
  const references = new Set(
    left.boundary.kind === "discrete"
      ? left.boundary.materialReferences.map((reference) =>
          path.resolve(left.rootPath, reference),
        )
      : [],
  );
  return (
    right.boundary.kind === "discrete" &&
    right.boundary.materialReferences.some((reference) =>
      references.has(path.resolve(right.rootPath, reference)),
    )
  );
}

/** 完整声明相交：比较两侧全部声明成员，任一成员相交即相交。 */
export function materialScopeDeclarationsIntersect(
  left: MaterialScopeDeclaration,
  right: MaterialScopeDeclaration,
): boolean {
  return left.members.some((member) =>
    right.members.some((other) =>
      recognitionMaterialMembersIntersect(member, other),
    ),
  );
}

/**
 * 范围局部提交基线：相交集合内每个决定的身份、资产、当前或结束状态，以及其完整声明
 * 边界，顺序无关。Application 冻结与 SQLite 事务内重算共用，因此相交决定的新增、撤回、
 * 取代或边界变更都不会遗漏；比较只覆盖该范围，绝不限制跨库或多决定支持。
 */
export function materialScopeDeclarationBaseline(
  declarations: readonly MaterialScopeDeclaration[],
): readonly string[] {
  return declarations
    .flatMap((declaration) => [
      `${declaration.decisionId}\u0000${declaration.assetId}\u0000${declaration.status}${declaration.endedAs ?? ""}`,
      ...declaration.members.map(
        (member) =>
          `${declaration.decisionId}\u0000${member.assetId}\u0000${recognitionMaterialBoundaryKey(member.boundary)}`,
      ),
    ])
    .toSorted();
}

/**
 * 本次候选的完整声明形状：边界已由识别器明确声明并用实际绑定根固定，根坐标就是那个
 * 根。资产与决定身份在这里只是候选自己的占位，供相交比较复用同一形状。
 */
export function candidateMaterialScopeDeclaration(
  plan: Pick<AssetRefreshWorkItemPlan, "key" | "boundaries">,
  boundRoot: ObservedRootSnapshot,
): MaterialScopeDeclaration {
  const candidate = `candidate\u0000${plan.key}`;
  return {
    assetId: candidate,
    decisionId: candidate,
    members: (plan.boundaries ?? []).map((boundary) => ({
      assetId: candidate,
      decisionId: candidate,
      boundary,
      rootPath: boundRoot.containerPath,
    })),
    status: "effective",
    isHead: true,
  };
}

/**
 * 该候选成员是否已在这个声明成员之内：持续目录吸收其内的目录或材料；离散范围只有
 * 与本次声明完全相同才算未变，扩大或改变必须由明确决定处理。
 */
function candidateMemberCoveredByDeclaration(
  candidate: EffectiveRecognitionMaterialBoundary,
  owner: EffectiveRecognitionMaterialBoundary,
): boolean {
  const ownerDirectory = memberDirectoryAddress(owner);
  if (ownerDirectory === undefined) {
    const candidateReferences =
      candidate.boundary.kind === "discrete"
        ? candidate.boundary.materialReferences
        : undefined;
    if (candidateReferences === undefined || owner.boundary.kind !== "discrete")
      return false;
    const declared = new Set(
      owner.boundary.materialReferences.map((reference) =>
        path.resolve(owner.rootPath, reference),
      ),
    );
    const selected = candidateReferences.map((reference) =>
      path.resolve(candidate.rootPath, reference),
    );
    return (
      selected.length === declared.size &&
      selected.every((reference) => declared.has(reference))
    );
  }
  if (candidate.boundary.kind === "directory") {
    const candidateDirectory = memberDirectoryAddress(candidate)!;
    return isWithinObservedDirectory(ownerDirectory, candidateDirectory);
  }
  return candidate.boundary.materialReferences.every((reference) =>
    isWithinObservedDirectory(
      ownerDirectory,
      path.resolve(candidate.rootPath, reference),
    ),
  );
}

/**
 * 两份声明是否指向同一材料范围：被覆盖方向已经成立，这里再要求已确认声明的每个成员都
 * 落在候选自己声明的成员之内。只用路径包含关系，绝不比较来源地址或标题。
 */
function declarationMembersAreSameMaterialRange(
  candidate: MaterialScopeDeclaration,
  owner: MaterialScopeDeclaration,
): boolean {
  return owner.members.every((held) =>
    candidate.members.some((member) =>
      candidateMemberCoveredByDeclaration(held, member),
    ),
  );
}

/**
 * 一份完整声明是否可被本次候选原样复用：候选每个成员都落在该声明某成员之内，且本次观察
 * 仍证明那个成员完整可见。候选自报独立身份时，只有两份声明指向同一份材料才算常规刷新，
 * 严格落在更大范围内就是需要明确处理的反证。
 */
function declarationCoversCandidate(
  candidate: MaterialScopeDeclaration,
  owner: MaterialScopeDeclaration,
  plan: AssetRefreshWorkItemPlan,
  snapshot: FilesystemPackageSnapshot,
): boolean {
  return (
    candidate.members.every((member) =>
      owner.members.some(
        (held) =>
          candidateMemberCoveredByDeclaration(member, held) &&
          observationKeepsDeclarationIntegrity(snapshot, held),
      ),
    ) &&
    (plan.independentIdentityDeclaredBy === undefined ||
      declarationMembersAreSameMaterialRange(candidate, owner))
  );
}

/**
 * 逐决定规划：每个候选只与实际支持它的那一份完整声明比较，绝不先把同资产的全部材料
 * 合并再逐项判断；已结束的决定只留下可按稳定 ID 检查的历史入口，不自动重建身份。
 */
export function reconcileRecognitionMaterialPlans(input: {
  readonly snapshot: FilesystemPackageSnapshot;
  readonly boundRoot: ObservedRootSnapshot;
  readonly plans: readonly AssetRefreshWorkItemPlan[];
  readonly effective: readonly EffectiveRecognitionMaterialBoundary[];
  readonly formatInterpretation: readonly AssetRefreshWorkPlan[];
  /** 含已结束决定与主头标识的完整声明；缺省时只按当前有效边界分组。 */
  readonly declarations?: readonly MaterialScopeDeclaration[];
}): readonly AssetRefreshWorkItemPlan[] {
  const declarations =
    input.declarations ?? groupMaterialScopeDeclarations(input.effective);
  const effectiveDeclarations = declarations.filter(
    (declaration) => declaration.status === "effective",
  );
  const endedDeclarations = declarations.filter(
    (declaration) => declaration.status === "ended",
  );
  const scopeAddress = path.resolve(input.snapshot.root);
  const reusedDecisions = new Set<string>();
  const candidatesByDecision = new Map<string, AssetRefreshWorkItemPlan[]>();
  const plans = input.plans.flatMap((plan): AssetRefreshWorkItemPlan[] => {
    const candidate = candidateMaterialScopeDeclaration(plan, input.boundRoot);
    if (candidate.members.length === 0) return [plan];
    const owners = effectiveDeclarations.filter((declaration) =>
      materialScopeDeclarationsIntersect(candidate, declaration),
    );
    if (owners.length === 0) {
      // 只剩已结束的范围：材料仍能被稳定检查，但绝不凭历史自动恢复身份或主头。
      const history = [
        ...new Set(
          endedDeclarations
            .filter((declaration) =>
              materialScopeDeclarationsIntersect(candidate, declaration),
            )
            .map(
              (declaration) =>
                `${declaration.assetId}\u0000${declaration.decisionId}`,
            ),
        ),
      ].map((key) => {
        const [assetId, decisionId] = key.split("\u0000");
        return { assetId: assetId!, decisionId: decisionId! };
      });
      if (history.length === 0) return [plan];
      const [first] = history;
      return [
        {
          ...plan,
          retainedAssetId: first!.assetId,
          retainedDecisionId: first!.decisionId,
          boundaryConflict:
            history.length > 1
              ? "这些材料曾由多个已结束的识别决定授权，需要点名一个决定后再形成预演"
              : "这些材料曾由已结束的识别决定授权，需要明确决定后才能继续，不会自动重建身份",
        },
      ];
    }
    // 相交的每一份已确认声明都各自完整覆盖本次候选：这是既有材料被多个资产／决定合法
    // 共同支持，逐份按自己的完整声明刷新，绝不退化成跨范围冲突或候选竞争。
    const covering = owners.filter((declaration) =>
      declarationCoversCandidate(candidate, declaration, plan, input.snapshot),
    );
    if (covering.length > 1 && covering.length === owners.length) {
      for (const declaration of covering) {
        reusedDecisions.add(declaration.decisionId);
        candidatesByDecision.set(declaration.decisionId, [
          ...(candidatesByDecision.get(declaration.decisionId) ?? []),
          plan,
        ]);
      }
      return [];
    }
    if (new Set(owners.map((declaration) => declaration.assetId)).size > 1)
      return [
        {
          ...plan,
          boundaryConflict: "候选材料跨越多个已确认资产范围，需要明确决定",
        },
      ];
    if (owners.length > 1)
      return [
        {
          ...plan,
          retainedAssetId: owners[0]!.assetId,
          boundaryConflict:
            "候选范围同时与多个已确认决定相交，需要点名一个决定后再形成预演",
        },
      ];
    const owner = owners[0]!;
    // 覆盖判定逐成员进行，并要求本次观察仍能证明被复用那份声明完整可见：目录范围吸收
    // 其内的新增材料，离散范围只有与本次声明完全相同才算未变。
    if (declarationCoversCandidate(candidate, owner, plan, input.snapshot)) {
      reusedDecisions.add(owner.decisionId);
      candidatesByDecision.set(owner.decisionId, [
        ...(candidatesByDecision.get(owner.decisionId) ?? []),
        plan,
      ]);
      return [];
    }
    // 扩大或改变已确认范围不是复用：旧观察仍参与解释，新材料只形成待明确决定的修订。
    // 落在更大已确认范围内的独立身份候选继续走到正常能力链，由识别结论决定如何处置。
    return [
      {
        ...plan,
        retainedAssetId: owner.assetId,
        retainedDecisionId: owner.decisionId,
      },
    ];
  });
  for (const declaration of effectiveDeclarations) {
    // 耐久工作项引用来自该决定的完整声明，而不是本次恰好可见或已被候选选中的文件。
    const references = [
      ...new Set(
        declaration.members
          .flatMap((member) => memberMaterialAddresses(member, input.snapshot))
          .map((address) =>
            path
              .relative(input.snapshot.root, address)
              .split(path.sep)
              .join("/"),
          ),
      ),
    ]
      .filter((relativePath) =>
        input.snapshot.files.some((file) => file.relativePath === relativePath),
      )
      .toSorted();
    if (references.length === 0) continue;
    if (
      !reusedDecisions.has(declaration.decisionId) &&
      plans.some((plan) => plan.retainedDecisionId === declaration.decisionId)
    )
      continue;
    const absorbed = candidatesByDecision.get(declaration.decisionId) ?? [];
    plans.push({
      key: `accepted-boundary:${declaration.assetId}:${declaration.decisionId}`,
      relativePaths: references,
      // 边界就是这一个决定的完整声明；同资产其他决定的材料绝不并进来。
      boundaries: declaration.members.map((member) => member.boundary),
      // 提交基线沿用 06 的规则：覆盖该资产与本次范围相交的全部有效边界。
      boundaryBaseline: recognitionBoundaryBaseline(
        input.effective.filter(
          (item) =>
            item.assetId === declaration.assetId &&
            recognitionMaterialBoundaryIntersectsScope(item, scopeAddress),
        ),
      ),
      retainedAssetId: declaration.assetId,
      retainedDecisionId: declaration.decisionId,
      reuseAcceptedBoundary: true,
      observedArtifactAssociations: absorbed.flatMap(
        (item) => item.observedArtifactAssociations ?? [],
      ),
      // 刷新只吸收普通材料，但被吸收候选仍有效的目录与来源依据必须留在耐久工作项上，
      // 交由正常提案／修正处理，绝不因为范围合并而丢掉后补线索。格式解释与候选计划引用
      // 同一批检查证据对象，并按集合而不是按拼接次数交给代表判断，否则一次检查会被算成
      // 两条待协调的部分关联，让未变材料被误判成需要修订。
      evidence: [
        ...new Set([
          ...input.formatInterpretation.flatMap((interpretation) =>
            interpretation.workItems.flatMap((item) => item.evidence),
          ),
          ...absorbed.flatMap((item) => item.evidence),
        ]),
      ].filter((evidence) =>
        evidence.inspection === undefined
          ? absorbed.some((item) => item.evidence.includes(evidence))
          : references.includes(evidence.inspection.observedArtifactReference),
      ),
    });
  }
  // 候选之间的竞争按完整声明比较：可见文件不重叠但声明嵌套同样竞争，且与顺序无关。
  const candidates = plans.filter(
    (plan) =>
      plan.retainedAssetId === undefined &&
      plan.reuseAcceptedBoundary !== true &&
      plan.boundaryConflict === undefined,
  );
  return plans.map((plan) =>
    plan.boundaryConflict !== undefined || !candidates.includes(plan)
      ? plan
      : candidates.some(
            (other) =>
              other !== plan &&
              materialScopeDeclarationsIntersect(
                candidateMaterialScopeDeclaration(plan, input.boundRoot),
                candidateMaterialScopeDeclaration(other, input.boundRoot),
              ),
          )
        ? {
            ...plan,
            boundaryConflict: "多个候选资产范围声明了相同材料，需要明确决定",
          }
        : plan,
  );
}
