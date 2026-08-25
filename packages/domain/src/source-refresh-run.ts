/** 稳定的来源事实坐标；其覆盖边界绝不从界面选择器推断。 */
export type SourceCoverageScope = {
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
  readonly coverageId: string;
};

/**
 * 调用方请求从一个当前有效的来源关联重新获取事实。它表达意图，而不是响应的
 * 覆盖权威。
 */
export type SourceRefreshSelection = {
  readonly subjectId: string;
  readonly sourceAssociationId: string;
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
  readonly selectors: readonly SourceRefreshFactSelector[];
};

/** 开放的事实坐标保留领域命名空间，而不是界面标签。 */
export type SourceRefreshFactSelector =
  | { readonly kind: "metadata-property"; readonly property: string }
  | { readonly kind: "relationship-type"; readonly relationshipType: string }
  | { readonly kind: "artifact-fact-family"; readonly family: string }
  | {
      readonly kind: "extension";
      readonly namespace: string;
      readonly key: string;
    };

export type SourceRefreshLineageHead = SourceCoverageScope & {
  readonly sourceRecordId?: string;
};

export type SourceRefreshScope = {
  readonly coverage: SourceCoverageScope;
  readonly baselineSourceRecordId?: string;
  /** 耐久的范围检查点；`acquiring` 表示外部请求已经开始。 */
  readonly state:
    | "planned"
    | "acquiring"
    | "awaiting-review"
    | "applying"
    | "terminal";
  /** 每次有界传输尝试前递增；不隐含任何重试策略。 */
  readonly acquisitionAttempt: number;
  readonly changeSetId?: string;
  readonly candidateSourceRecordId?: string;
  readonly outcome?: SourceRefreshScopeOutcome;
  readonly reason?: string;
};

export type SourceRefreshScopeOutcome =
  | "applied"
  | "unchanged"
  | "failed"
  | "skipped"
  | "cancelled"
  | "stale";

export type SourceRefreshRunPhase =
  | "planning"
  | "acquiring"
  | "reviewing"
  | "applying"
  | "terminal";

export type SourceRefreshRunOutcome =
  | "succeeded"
  | "partially-succeeded"
  | "failed"
  | "cancelled";

export type SourceRefreshChange = {
  readonly kind:
    | "established"
    | "superseded"
    | "retracted"
    | "unchanged"
    | "conflicted"
    | "skipped"
    | "rejected";
  /** 不透明的事实或生命周期引用；审阅绝不改写单个条目。 */
  readonly factReference: string;
};

export type SourceRefreshChangeSet = {
  readonly id: string;
  readonly runId: string;
  readonly coverage: SourceCoverageScope;
  readonly baselineSourceRecordId?: string;
  readonly candidateSourceRecordId: string;
  readonly changes: readonly SourceRefreshChange[];
  readonly requiresReview: boolean;
  readonly disposition: "automatic" | "pending" | "approved" | "rejected";
};

/**
 * 一次特定来源元数据重新获取的耐久领域过程。整体结果始终从各自独立完成的范围
 * 推导，而不维护为另一份可变的工作流状态。
 */
export type SourceRefreshRun = {
  readonly id: string;
  readonly initiatedBy: string;
  readonly initiatedAt: string;
  readonly requestedSelection: SourceRefreshSelection;
  readonly reviewPolicy: "automatic" | "review";
  readonly phase: SourceRefreshRunPhase;
  readonly outcome?: SourceRefreshRunOutcome;
  readonly scopes: readonly SourceRefreshScope[];
  readonly changeSets: readonly SourceRefreshChangeSet[];
};

export type CreateSourceRefreshRunInput = {
  readonly id: string;
  readonly initiatedBy: string;
  readonly initiatedAt: string;
  readonly requestedSelection: SourceRefreshSelection;
  readonly reviewPolicy: SourceRefreshRun["reviewPolicy"];
  readonly baselineLineageHeads: readonly SourceRefreshLineageHead[];
};

/** 在传输开始前创建来源刷新运行，只冻结当时观察到的 lineage。 */
export function createSourceRefreshRun(
  input: CreateSourceRefreshRunInput,
): SourceRefreshRun {
  assertNonEmpty(input.id, "Source Refresh Run requires an identity");
  assertNonEmpty(input.initiatedBy, "Source Refresh Run requires an initiator");
  assertNonEmpty(
    input.initiatedAt,
    "Source Refresh Run requires a domain-relevant start time",
  );
  assertSelection(input.requestedSelection);
  if (input.baselineLineageHeads.length === 0) {
    throw new Error(
      "Source Refresh Run requires at least one coverage baseline",
    );
  }

  const scopes = input.baselineLineageHeads.map((head) => {
    assertCoverage(head);
    if (
      head.sourceIdentity !== input.requestedSelection.sourceIdentity ||
      head.nativeAddress !== input.requestedSelection.nativeAddress
    ) {
      throw new Error(
        "Source Refresh Run baseline must belong to its requested Source Association",
      );
    }
    return {
      coverage: {
        sourceIdentity: head.sourceIdentity,
        nativeAddress: head.nativeAddress,
        coverageId: head.coverageId,
      },
      ...(head.sourceRecordId === undefined
        ? {}
        : { baselineSourceRecordId: head.sourceRecordId }),
      state: "planned" as const,
      acquisitionAttempt: 0,
    };
  });
  const keys = new Set(
    scopes.map(
      (scope) =>
        `${scope.coverage.sourceIdentity}\u0000${scope.coverage.nativeAddress}\u0000${scope.coverage.coverageId}`,
    ),
  );
  if (keys.size !== scopes.length)
    throw new Error("Source Refresh Run has duplicate coverage baselines");

  return {
    id: input.id,
    initiatedBy: input.initiatedBy,
    initiatedAt: input.initiatedAt,
    requestedSelection: input.requestedSelection,
    reviewPolicy: input.reviewPolicy,
    phase: "planning",
    scopes,
    changeSets: [],
  };
}

/**
 * 在一次有界采集器调用前立即记录耐久边界。后续重试策略可以创建另一次尝试，
 * 但这个领域迁移不决定是否重试或何时重试。
 */
export function beginSourceRefreshScopeAcquisition(
  run: SourceRefreshRun,
  coverage: SourceCoverageScope,
): SourceRefreshRun {
  assertNonTerminal(run);
  assertCoverage(coverage);
  let found = false;
  const scopes = run.scopes.map((scope) => {
    if (!sameCoverage(scope.coverage, coverage)) return scope;
    found = true;
    if (scope.state !== "planned") {
      throw new Error("Source Refresh Scope is not planned for acquisition");
    }
    return {
      ...scope,
      state: "acquiring" as const,
      acquisitionAttempt: scope.acquisitionAttempt + 1,
    };
  });
  if (!found)
    throw new Error("Source Refresh Scope is outside the planned coverage");
  return { ...run, phase: derivePhase(scopes), scopes };
}

export type StageSourceRefreshChangeSetInput = {
  readonly id: string;
  readonly coverage: SourceCoverageScope;
  readonly candidateSourceRecordId: string;
  readonly changes: readonly SourceRefreshChange[];
  /** 即使采用自动策略，撤回、范围扩张或身份冲突也可能强制进入审阅。 */
  readonly requiresReview?: boolean;
};

/**
 * 向一次来源刷新运行附加且仅附加一个候选范围。在整个变更集进入 `applying`，
 * 且持久化边界成功完成比较并追加之前，候选始终是非当前证据。
 */
export function stageSourceRefreshChangeSet(
  run: SourceRefreshRun,
  input: StageSourceRefreshChangeSetInput,
): SourceRefreshRun {
  assertNonTerminal(run);
  assertNonEmpty(input.id, "Source Refresh Change Set requires an identity");
  assertCoverage(input.coverage);
  assertNonEmpty(
    input.candidateSourceRecordId,
    "Source Refresh Change Set requires a candidate Source Record",
  );
  if (run.changeSets.some((changeSet) => changeSet.id === input.id))
    throw new Error("Source Refresh Run already contains that Change Set");
  if (
    run.changeSets.some(
      (changeSet) =>
        changeSet.candidateSourceRecordId === input.candidateSourceRecordId,
    )
  ) {
    throw new Error(
      "Source Refresh Run cannot reuse one Source Record across coverage scopes",
    );
  }
  for (const change of input.changes) {
    assertNonEmpty(
      change.factReference,
      "Source Refresh Change Set requires fact references",
    );
  }

  const index = run.scopes.findIndex((scope) =>
    sameCoverage(scope.coverage, input.coverage),
  );
  const scope = run.scopes[index];
  if (scope === undefined)
    throw new Error(
      "Source Refresh Change Set is outside the planned coverage",
    );
  if (scope.state !== "acquiring")
    throw new Error("Source Refresh Scope has no acquisition checkpoint");
  // 撤回是在完整来源边界上作出的缺失声明。即使调用方选择了自动策略，它仍会
  // 产生实质影响，因此始终由这个聚合而非适配器将其提升为整份变更集审阅。
  const requiresReview =
    input.requiresReview === true ||
    run.reviewPolicy === "review" ||
    input.changes.some((change) => change.kind === "retracted");
  const disposition = requiresReview ? "pending" : "automatic";
  const changeSet: SourceRefreshChangeSet = {
    id: input.id,
    runId: run.id,
    coverage: input.coverage,
    ...(scope.baselineSourceRecordId === undefined
      ? {}
      : { baselineSourceRecordId: scope.baselineSourceRecordId }),
    candidateSourceRecordId: input.candidateSourceRecordId,
    changes: input.changes,
    requiresReview,
    disposition,
  };
  const scopes = run.scopes.map((current, currentIndex) =>
    currentIndex !== index
      ? current
      : {
          ...current,
          state: requiresReview
            ? ("awaiting-review" as const)
            : ("applying" as const),
          changeSetId: changeSet.id,
          candidateSourceRecordId: changeSet.candidateSourceRecordId,
        },
  );
  return {
    ...run,
    phase: derivePhase(scopes),
    scopes,
    changeSets: [...run.changeSets, changeSet],
  };
}

export type CompleteSourceRefreshChangeSetInput = {
  readonly changeSetId: string;
  readonly outcome: Extract<SourceRefreshScopeOutcome, "applied" | "unchanged">;
};

/** 只完成一个比较并追加范围；同级范围各自保留自己的状态。 */
export function completeSourceRefreshChangeSet(
  run: SourceRefreshRun,
  input: CompleteSourceRefreshChangeSetInput,
): SourceRefreshRun {
  assertNonTerminal(run);
  const changeSet = run.changeSets.find(
    (candidate) => candidate.id === input.changeSetId,
  );
  if (changeSet === undefined || changeSet.disposition === "pending") {
    throw new Error(
      "Source Refresh Change Set is not approved for application",
    );
  }
  if (changeSet.disposition === "rejected")
    throw new Error("Rejected Source Refresh Change Set cannot be applied");
  const scopes = run.scopes.map((scope) => {
    if (scope.changeSetId !== input.changeSetId) return scope;
    if (scope.state !== "applying")
      throw new Error("Source Refresh Change Set is not applying");
    return { ...scope, state: "terminal" as const, outcome: input.outcome };
  });
  return withDerivedTerminalOutcome({ ...run, scopes });
}

export type ReviewSourceRefreshChangeSetInput = {
  readonly changeSetId: string;
  readonly disposition: "approved" | "rejected";
};

/**
 * 审阅完整的外部来源变更集。拒绝时保留候选记录作为非当前证据，并且只结束该范围。
 */
export function reviewSourceRefreshChangeSet(
  run: SourceRefreshRun,
  input: ReviewSourceRefreshChangeSetInput,
): SourceRefreshRun {
  assertNonTerminal(run);
  const reviewed = run.changeSets.find(
    (candidate) => candidate.id === input.changeSetId,
  );
  if (reviewed?.disposition !== "pending") {
    throw new Error("Source Refresh Change Set is not awaiting review");
  }
  const changeSets = run.changeSets.map((changeSet) =>
    changeSet.id === input.changeSetId
      ? { ...changeSet, disposition: input.disposition }
      : changeSet,
  ) as readonly SourceRefreshChangeSet[];
  const scopes = run.scopes.map((scope) => {
    if (scope.changeSetId !== input.changeSetId) return scope;
    if (scope.state !== "awaiting-review") {
      throw new Error(
        "Source Refresh Change Set does not own an awaiting scope",
      );
    }
    return input.disposition === "approved"
      ? { ...scope, state: "applying" as const }
      : {
          ...scope,
          state: "terminal" as const,
          outcome: "skipped" as const,
        };
  });
  return withDerivedTerminalOutcome({ ...run, scopes, changeSets });
}

/**
 * 取消只向前生效：终止尚未提交比较并追加的范围，并刻意保持已接受同级范围的历史
 * 完整不变。
 */
export function cancelSourceRefreshRun(
  run: SourceRefreshRun,
): SourceRefreshRun {
  assertNonTerminal(run);
  const scopes = run.scopes.map((scope) =>
    scope.state === "terminal"
      ? scope
      : {
          ...scope,
          state: "terminal" as const,
          outcome: "cancelled" as const,
        },
  );
  return withDerivedTerminalOutcome({ ...run, scopes });
}

export type FailSourceRefreshScopeInput = {
  readonly coverage: SourceCoverageScope;
  readonly outcome: Extract<SourceRefreshScopeOutcome, "failed" | "stale">;
  readonly reason: string;
};

/** 为且仅为一个范围记录终态操作结果或过期 lineage 结果。 */
export function failSourceRefreshScope(
  run: SourceRefreshRun,
  input: FailSourceRefreshScopeInput,
): SourceRefreshRun {
  assertNonTerminal(run);
  assertCoverage(input.coverage);
  assertNonEmpty(
    input.reason,
    "Source Refresh Scope failure requires a reason",
  );
  let found = false;
  const scopes = run.scopes.map((scope) => {
    if (!sameCoverage(scope.coverage, input.coverage)) return scope;
    found = true;
    if (scope.state === "terminal")
      throw new Error("Source Refresh Scope is already terminal");
    return {
      ...scope,
      state: "terminal" as const,
      outcome: input.outcome,
      reason: input.reason,
    };
  });
  if (!found)
    throw new Error("Source Refresh Scope is outside the planned coverage");
  return withDerivedTerminalOutcome({ ...run, scopes });
}

/** 从各权威范围重建已持久化来源刷新运行的读取模型。 */
export function projectSourceRefreshRun(
  run: Omit<SourceRefreshRun, "phase" | "outcome">,
): SourceRefreshRun {
  return withDerivedTerminalOutcome({ ...run, phase: derivePhase(run.scopes) });
}

function assertSelection(selection: SourceRefreshSelection): void {
  assertNonEmpty(
    selection.subjectId,
    "Source Refresh Selection requires a subject",
  );
  assertNonEmpty(
    selection.sourceAssociationId,
    "Source Refresh Selection requires a Source Association",
  );
  assertNonEmpty(
    selection.sourceIdentity,
    "Source Refresh Selection requires a source identity",
  );
  assertNonEmpty(
    selection.nativeAddress,
    "Source Refresh Selection requires a source-native address",
  );
  for (const selector of selection.selectors) {
    switch (selector.kind) {
      case "metadata-property":
        assertNonEmpty(
          selector.property,
          "Metadata selector requires a property",
        );
        break;
      case "relationship-type":
        assertNonEmpty(
          selector.relationshipType,
          "Relationship selector requires a type",
        );
        break;
      case "artifact-fact-family":
        assertNonEmpty(
          selector.family,
          "Artifact selector requires a fact family",
        );
        break;
      case "extension":
        assertNonEmpty(
          selector.namespace,
          "Extension selector requires a namespace",
        );
        assertNonEmpty(selector.key, "Extension selector requires a key");
        break;
    }
  }
}

function assertNonTerminal(run: SourceRefreshRun): void {
  if (run.phase === "terminal")
    throw new Error(
      "Terminal Source Refresh Runs are immutable; create a retry",
    );
}

function sameCoverage(
  left: SourceCoverageScope,
  right: SourceCoverageScope,
): boolean {
  return (
    left.sourceIdentity === right.sourceIdentity &&
    left.nativeAddress === right.nativeAddress &&
    left.coverageId === right.coverageId
  );
}

function derivePhase(
  scopes: readonly SourceRefreshScope[],
): SourceRefreshRunPhase {
  if (scopes.every((scope) => scope.state === "terminal")) return "terminal";
  if (scopes.some((scope) => scope.state === "awaiting-review"))
    return "reviewing";
  if (scopes.some((scope) => scope.state === "applying")) return "applying";
  if (scopes.some((scope) => scope.state === "acquiring")) return "acquiring";
  return "planning";
}

function withDerivedTerminalOutcome(run: SourceRefreshRun): SourceRefreshRun {
  const phase = derivePhase(run.scopes);
  if (phase !== "terminal") {
    const { outcome: _outcome, ...open } = run;
    return { ...open, phase };
  }
  return {
    ...run,
    phase,
    outcome: deriveOutcome(run.scopes),
  };
}

function deriveOutcome(
  scopes: readonly SourceRefreshScope[],
): SourceRefreshRunOutcome {
  const outcomes = scopes.map((scope) => scope.outcome);
  const applied = outcomes.some(
    (outcome) => outcome === "applied" || outcome === "unchanged",
  );
  if (
    applied &&
    outcomes.every(
      (outcome) => outcome === "applied" || outcome === "unchanged",
    )
  )
    return "succeeded";
  if (applied) return "partially-succeeded";
  if (outcomes.every((outcome) => outcome === "cancelled")) return "cancelled";
  return "failed";
}

function assertCoverage(scope: SourceCoverageScope): void {
  assertNonEmpty(
    scope.sourceIdentity,
    "Source Coverage Scope requires a source identity",
  );
  assertNonEmpty(
    scope.nativeAddress,
    "Source Coverage Scope requires an address",
  );
  assertNonEmpty(
    scope.coverageId,
    "Source Coverage Scope requires a coverage id",
  );
}

function assertNonEmpty(value: string, message: string): void {
  if (value.length === 0) throw new Error(message);
}
