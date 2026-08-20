/** A stable source fact coordinate; its coverage boundary is never inferred from a UI selector. */
export type SourceCoverageScope = {
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
  readonly coverageId: string;
};

/**
 * A caller's request to reacquire facts from one already-current Source
 * Association. It is intent, not the coverage authority of a response.
 */
export type SourceRefreshSelection = {
  readonly subjectId: string;
  readonly sourceAssociationId: string;
  readonly sourceIdentity: string;
  readonly nativeAddress: string;
  readonly selectors: readonly SourceRefreshFactSelector[];
};

/** Open fact coordinates retain their domain namespace rather than UI labels. */
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
  /** Durable scope checkpoint; `acquiring` means an external request began. */
  readonly state:
    | "planned"
    | "acquiring"
    | "awaiting-review"
    | "applying"
    | "terminal";
  /** Increments before each bounded transport attempt; no retry policy is implied. */
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
  /** An opaque fact or lifecycle reference; review never alters individual entries. */
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
 * The durable domain process for one source-specific metadata reacquisition.
 * Its overall outcome will always be derived from its independently completed
 * scopes rather than maintained as another mutable workflow status.
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

/** Creates a Run before transport begins, freezing only the lineage it observed. */
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
 * Records the durable boundary immediately before one bounded collector call.
 * A later retry policy may create another attempt, but this domain transition
 * does not decide whether or when to retry.
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
  /** Retraction, expansion, or identity conflict may force review under an automatic policy. */
  readonly requiresReview?: boolean;
};

/**
 * Attaches exactly one candidate scope to a Run. The candidate remains
 * non-current evidence until the whole Change Set reaches `applying` and the
 * persistence boundary successfully compare-and-appends it.
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
  // Retraction is an absence claim made at a complete source boundary. It is
  // consequential even when a caller selected automatic policy, so this
  // aggregate—not an adapter—always promotes it to whole-Change-Set review.
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

/** Completes only one compare-and-append scope; siblings keep their own state. */
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
 * Reviews the complete externally authored Change Set. A rejection keeps its
 * candidate record as non-current evidence and ends only that one scope.
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
 * Cancellation is forward-only: it terminates scopes that have not committed
 * their compare-and-append and deliberately leaves accepted sibling history
 * intact.
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

/** Records a terminal operational or stale-lineage result for exactly one scope. */
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

/** Rebuilds the read model of a persisted Run from its authoritative scopes. */
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
