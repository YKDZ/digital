import type { CapabilityDeclaration, InformationRequirement } from "./index.js";

/** A finite, view-independent set of already stable Domain subjects. */
export type InformationSubjectSelection = {
  readonly subjectIds: readonly string[];
};

/** The facts Application is allowed to compare before it plans any work. */
export type InformationSubjectFacts = {
  readonly subjectId: string;
  readonly metadata: readonly { readonly property: string }[];
  readonly relationships: readonly { readonly type: string }[];
  /** `available` means the ordinary association has accessible bytes. */
  readonly artifactAssociations: readonly {
    readonly role: string;
    readonly available?: boolean;
  }[];
  /** Current source associations already applicable to this exact subject. */
  readonly sourceAssociations: readonly {
    readonly sourceIdentity: string;
    /** Preserves the current association selected for the later work plan. */
    readonly sourceAssociationId?: string;
  }[];
};

/**
 * This is deliberately a declaration of one narrow fulfilment path, not a
 * provider model. Coordinates and source identities remain open strings.
 */
export type InformationFulfillmentCapability = {
  readonly declaration: CapabilityDeclaration;
  readonly operation:
    | "source-refresh"
    | "source-enrichment"
    | "source-artifact-acquisition";
  readonly sourceIdentities: readonly string[];
  readonly metadataProperties?: readonly string[];
  readonly relationshipTypes?: readonly string[];
  readonly artifactRoles?: readonly string[];
  readonly cost: "low" | "consequential";
  readonly availability: "available" | "unavailable" | "blocked";
  /** Sanitized again at the Application boundary before it reaches callers. */
  readonly reason?: string;
};

export type InformationReadinessStatus =
  | "available"
  | "pending"
  | "unavailable"
  | "blocked";

export type InformationExecutionReference = {
  readonly workflowExecutionId: string;
};

/**
 * Application-only provenance for a fulfillment requested after an existing
 * Workflow Execution accepted a subject. The stable parent ID is deliberately
 * narrower than an automation intent: a recovered child must keep its own
 * frozen Workflow Input rather than recomputing provenance from current
 * automation configuration.
 */
export type InformationFulfillmentInitiation = {
  readonly version: "information-fulfillment-initiation/1";
  readonly parentExecutionId: string;
};

export type InformationInputReadiness = {
  readonly kind: "metadata" | "relationship" | "artifact-role";
  readonly coordinate: string;
  readonly necessity: "required" | "optional";
  readonly status: InformationReadinessStatus;
  readonly reason?: string;
  readonly executionReferences?: readonly InformationExecutionReference[];
};

export type InformationSubjectReadiness = {
  readonly subjectId: string;
  /** Required inputs determine this summary; optional absence remains visible. */
  readonly status: InformationReadinessStatus;
  readonly inputs: readonly InformationInputReadiness[];
};

/** A rebuildable Application result, never a Domain availability fact. */
export type InformationReadiness = {
  readonly requirement: InformationRequirement;
  readonly subjects: readonly InformationSubjectReadiness[];
};

/**
 * One planned low-cost work item. It contains only neutral selection and
 * requirement coordinates, so the scheduler cannot branch on a View, route,
 * component, or provider output model.
 */
export type InformationFulfillmentPlan = {
  readonly subjectId: string;
  readonly sourceIdentity: string;
  /** Opaque current-association identity; absent only for legacy/test facts. */
  readonly sourceAssociationId?: string;
  readonly operation: InformationFulfillmentCapability["operation"];
  readonly capability: CapabilityDeclaration;
  readonly requirement: InformationRequirement;
};

type InformationFulfillmentTerminal = {
  readonly status: "unavailable" | "blocked";
  readonly reason: string;
  /** Retains the durable attempt after a pending execution reaches terminal. */
  readonly workflowExecutionId?: string;
};

export type InformationFulfillmentStart =
  | {
      readonly status: "pending";
      readonly workflowExecutionId: string;
    }
  | InformationFulfillmentTerminal;

/**
 * A durable execution may finish after the first readiness projection. This
 * boundary turns its persisted terminal state into a stable readiness result
 * without retrying the same source work on every delivery refresh.
 */
export type InformationFulfillmentPendingReconciliation =
  | { readonly status: "pending" }
  | InformationFulfillmentTerminal;

/**
 * Product policy may permit a bounded exact enrichment. Returning no
 * candidate is the ordinary case; declared integrations never fan out merely
 * because they happen to be deployed.
 */
export type InformationFulfillmentPolicy = {
  readonly permittedSourceEnrichments?: (input: {
    readonly subjectId: string;
    readonly coordinate: string;
    readonly kind: InformationInputReadiness["kind"];
    readonly facts: InformationSubjectFacts;
    readonly capabilities: readonly InformationFulfillmentCapability[];
  }) => readonly { readonly sourceIdentity: string }[];
};

export type InformationFulfillmentPorts = {
  readonly readSubjects: (
    selection: InformationSubjectSelection,
  ) => Promise<readonly InformationSubjectFacts[]>;
  readonly capabilities: readonly InformationFulfillmentCapability[];
  readonly policy?: InformationFulfillmentPolicy;
  readonly start: (
    plan: InformationFulfillmentPlan,
    initiation?: InformationFulfillmentInitiation,
  ) => Promise<InformationFulfillmentStart>;
  /** Optional because only a durable workflow can reconcile an execution ID. */
  readonly reconcilePending?: (input: {
    readonly plan: InformationFulfillmentPlan;
    readonly workflowExecutionId: string;
  }) => Promise<InformationFulfillmentPendingReconciliation>;
};

/**
 * Lifecycle shutdown does not retry, cancel, or reinterpret work already
 * planned by a caller. It reports the same neutral readiness shape instead
 * of allowing a new fulfillment to reach a closing persistence owner.
 */
export function blockedInformationReadiness(
  input: {
    readonly selection: InformationSubjectSelection;
    readonly requirement: InformationRequirement;
    readonly initiation?: InformationFulfillmentInitiation;
  },
  reason: string,
): InformationReadiness {
  validateSelection(input.selection);
  validateRequirement(input.requirement);
  validateInitiation(input.initiation);
  const requested = requestedInputs(input.requirement);
  return {
    requirement: input.requirement,
    subjects: input.selection.subjectIds.map((subjectId) => {
      const inputs = requested.map((requestedInput) => ({
        ...readinessIdentity(requestedInput),
        status: readinessStatusForInput(requestedInput, "blocked"),
        reason: sanitizeInformationReason(reason),
      }));
      return {
        subjectId,
        status: subjectReadinessStatus(inputs),
        inputs,
      };
    }),
  };
}

type RequestedInput = {
  readonly id: string;
  readonly kind: InformationInputReadiness["kind"];
  readonly coordinate: string;
  readonly necessity: InformationInputReadiness["necessity"];
  readonly metadata?: InformationRequirement["metadata"][number];
  readonly relationship?: InformationRequirement["relationshipTypes"][number];
  readonly artifact?: InformationRequirement["artifactRoles"][number];
};

type PlannedInput = {
  readonly subjectId: string;
  readonly input: RequestedInput;
  readonly sourceIdentity: string;
  /** Keeps separate current associations from being coalesced by identity. */
  readonly sourceAssociationId?: string;
  readonly capability: InformationFulfillmentCapability;
};

type PendingInformationWork = {
  readonly plan: InformationFulfillmentPlan;
  readonly result: Promise<InformationFulfillmentStart>;
};

/**
 * Deep, delivery-independent input planning. Current facts are reused first;
 * only an exact missing coordinate with an applicable low-cost declaration
 * can cause a scheduler request. The instance memoizes pending work so the
 * same interactive and automated requirement deduplicates naturally.
 */
export class InformationFulfillment {
  private readonly pending = new Map<string, PendingInformationWork>();

  constructor(private readonly ports: InformationFulfillmentPorts) {}

  async fulfill(input: {
    readonly selection: InformationSubjectSelection;
    readonly requirement: InformationRequirement;
    /** Internal Application provenance; delivery callers do not synthesize it. */
    readonly initiation?: InformationFulfillmentInitiation;
  }): Promise<InformationReadiness> {
    validateSelection(input.selection);
    validateRequirement(input.requirement);
    validateInitiation(input.initiation);
    const requested = requestedInputs(input.requirement);
    const facts = await this.ports.readSubjects(input.selection);
    const factsBySubject = new Map(
      facts.map((subject) => [subject.subjectId, subject]),
    );
    const initial = new Map<string, InformationInputReadiness>();
    const planned: PlannedInput[] = [];

    for (const subjectId of input.selection.subjectIds) {
      const subject = factsBySubject.get(subjectId);
      for (const requestedInput of requested) {
        const key = readinessKey(subjectId, requestedInput.id);
        if (subject === undefined) {
          initial.set(key, {
            ...readinessIdentity(requestedInput),
            status: "blocked",
            reason: "所选主体当前不可读取",
          });
          continue;
        }
        if (subjectSatisfies(subject, requestedInput)) {
          initial.set(key, {
            ...readinessIdentity(requestedInput),
            status: "available",
          });
          continue;
        }
        const resolution = this.resolveMissing(subject, requestedInput);
        if (resolution.kind === "plan") {
          planned.push({
            subjectId,
            input: requestedInput,
            sourceIdentity: resolution.sourceIdentity,
            ...(resolution.sourceAssociationId === undefined
              ? {}
              : { sourceAssociationId: resolution.sourceAssociationId }),
            capability: resolution.capability,
          });
          continue;
        }
        initial.set(key, {
          ...readinessIdentity(requestedInput),
          status: readinessStatusForInput(requestedInput, resolution.status),
          ...(resolution.reason === undefined
            ? {}
            : { reason: sanitizeInformationReason(resolution.reason) }),
        });
      }
    }

    for (const group of groupedPlans(planned, input.requirement)) {
      const start = await this.start(group.plan, input.initiation);
      for (const plannedInput of group.inputs) {
        const key = readinessKey(plannedInput.subjectId, plannedInput.input.id);
        initial.set(
          key,
          start.status === "pending"
            ? {
                ...readinessIdentity(plannedInput.input),
                status: "pending",
                executionReferences: [
                  { workflowExecutionId: start.workflowExecutionId },
                ],
              }
            : {
                ...readinessIdentity(plannedInput.input),
                status: readinessStatusForInput(
                  plannedInput.input,
                  start.status,
                ),
                reason: sanitizeInformationReason(start.reason),
                ...(executionReferencesFor(start) === undefined
                  ? {}
                  : {
                      executionReferences: executionReferencesFor(start),
                    }),
              },
        );
      }
    }

    return {
      requirement: input.requirement,
      subjects: input.selection.subjectIds.map((subjectId) => {
        const inputs = requested.map((requestedInput) => {
          const current = initial.get(
            readinessKey(subjectId, requestedInput.id),
          );
          if (current === undefined)
            throw new Error(
              "Information Fulfillment omitted a requested input",
            );
          return current;
        });
        return {
          subjectId,
          status: subjectReadinessStatus(inputs),
          inputs,
        };
      }),
    };
  }

  /**
   * A newly terminal Source Refresh is the only ordinary event that makes a
   * previously terminal source-work memo obsolete. This is intentionally not
   * a general retry button: unchanged delivery polling retains terminal
   * unavailable/blocked readiness instead of replaying remote work.
   */
  invalidateForSourceFacts(input: {
    readonly subjectId: string;
    readonly sourceIdentity: string;
    /** When supplied, do not evict a sibling current Source Association. */
    readonly sourceAssociationId?: string;
    readonly operations?: readonly InformationFulfillmentCapability["operation"][];
  }): void {
    for (const [key, pending] of this.pending) {
      if (
        pending.plan.subjectId === input.subjectId &&
        pending.plan.sourceIdentity === input.sourceIdentity &&
        (input.sourceAssociationId === undefined ||
          pending.plan.sourceAssociationId === input.sourceAssociationId) &&
        (input.operations === undefined ||
          input.operations.includes(pending.plan.operation))
      ) {
        this.pending.delete(key);
      }
    }
  }

  private resolveMissing(
    subject: InformationSubjectFacts,
    input: RequestedInput,
  ):
    | {
        readonly kind: "plan";
        readonly sourceIdentity: string;
        readonly sourceAssociationId?: string;
        readonly capability: InformationFulfillmentCapability;
      }
    | {
        readonly kind: "terminal";
        readonly status: "unavailable" | "blocked";
        readonly reason?: string;
      } {
    const operation =
      input.kind === "artifact-role"
        ? "source-artifact-acquisition"
        : "source-refresh";
    const matching = subject.sourceAssociations.flatMap((association) =>
      this.ports.capabilities
        .filter(
          (capability) =>
            capability.operation === operation &&
            capability.cost === "low" &&
            supportsSource(capability, association.sourceIdentity) &&
            supportsInput(capability, input),
        )
        .map((capability) => ({
          sourceIdentity: association.sourceIdentity,
          ...(association.sourceAssociationId === undefined
            ? {}
            : { sourceAssociationId: association.sourceAssociationId }),
          capability,
        })),
    );
    const available = matching.find(
      (candidate) => candidate.capability.availability === "available",
    );
    if (available !== undefined) return { kind: "plan", ...available };
    const blocked = matching.find(
      (candidate) => candidate.capability.availability === "blocked",
    );
    const enrichment = this.resolvePermittedEnrichment(subject, input);
    if (enrichment !== undefined) return enrichment;
    if (blocked !== undefined) {
      return {
        kind: "terminal",
        status: "blocked",
        ...(blocked.capability.reason === undefined
          ? {}
          : { reason: blocked.capability.reason }),
      };
    }
    if (matching.length > 0) {
      return {
        kind: "terminal",
        status: "unavailable",
        reason: "适用能力当前不可用",
      };
    }
    return {
      kind: "terminal",
      status: "unavailable",
      reason:
        subject.sourceAssociations.length === 0
          ? "当前主体没有可用来源关联"
          : "没有已声明能力可履行该信息输入",
    };
  }

  private resolvePermittedEnrichment(
    subject: InformationSubjectFacts,
    input: RequestedInput,
  ):
    | {
        readonly kind: "plan";
        readonly sourceIdentity: string;
        readonly capability: InformationFulfillmentCapability;
      }
    | undefined {
    const candidates = this.ports.policy?.permittedSourceEnrichments?.({
      subjectId: subject.subjectId,
      coordinate: input.coordinate,
      kind: input.kind,
      facts: subject,
      capabilities: this.ports.capabilities,
    });
    if (candidates === undefined) return undefined;
    for (const candidate of candidates) {
      const capability = this.ports.capabilities.find(
        (current) =>
          current.operation === "source-enrichment" &&
          current.cost === "low" &&
          current.availability === "available" &&
          supportsSource(current, candidate.sourceIdentity) &&
          supportsInput(current, input),
      );
      if (capability !== undefined) {
        return {
          kind: "plan",
          sourceIdentity: candidate.sourceIdentity,
          capability,
        };
      }
    }
    return undefined;
  }

  private async start(
    plan: InformationFulfillmentPlan,
    initiation?: InformationFulfillmentInitiation,
  ): Promise<InformationFulfillmentStart> {
    const key = JSON.stringify(plan);
    const existing = this.pending.get(key);
    if (existing !== undefined) {
      const started = await existing.result;
      if (started.status !== "pending") return started;
      const reconcile = this.ports.reconcilePending;
      if (reconcile === undefined) return started;
      let reconciled: InformationFulfillmentPendingReconciliation;
      try {
        reconciled = await reconcile({
          plan,
          workflowExecutionId: started.workflowExecutionId,
        });
      } catch (error) {
        reconciled = {
          status: "blocked",
          reason:
            error instanceof Error ? error.message : "信息履行状态无法协调",
        };
      }
      if (reconciled.status === "pending") return started;
      const terminalResult: InformationFulfillmentTerminal = {
        ...reconciled,
        workflowExecutionId:
          reconciled.workflowExecutionId ?? started.workflowExecutionId,
      };
      const terminal = Promise.resolve(terminalResult);
      // Keep this terminal observation until current facts change or an
      // explicit new workflow replaces it; catalogue polling must not turn a
      // failed/cancelled source run into an implicit retry loop.
      this.pending.set(key, { plan, result: terminal });
      return terminalResult;
    }
    const starting = this.startNew(plan, initiation);
    const pending = { plan, result: starting };
    this.pending.set(key, pending);
    const started = await starting;
    if (started.status !== "pending" && this.pending.get(key) === pending)
      this.pending.delete(key);
    return started;
  }

  private async startNew(
    plan: InformationFulfillmentPlan,
    initiation?: InformationFulfillmentInitiation,
  ): Promise<InformationFulfillmentStart> {
    try {
      const started = await this.ports.start(plan, initiation);
      return started;
    } catch (error) {
      return {
        status: "blocked",
        reason: error instanceof Error ? error.message : "信息履行未能启动",
      };
    }
  }
}

function requestedInputs(
  requirement: InformationRequirement,
): readonly RequestedInput[] {
  return [
    ...requirement.metadata.map((metadata) => ({
      id: `metadata:${metadata.property}`,
      kind: "metadata" as const,
      coordinate: metadata.property,
      necessity: metadata.necessity,
      metadata,
    })),
    ...requirement.relationshipTypes.map((relationship) => ({
      id: `relationship:${relationship.type}`,
      kind: "relationship" as const,
      coordinate: relationship.type,
      necessity: relationship.necessity,
      relationship,
    })),
    ...requirement.artifactRoles.map((artifact) => ({
      id: `artifact-role:${artifact.role}`,
      kind: "artifact-role" as const,
      coordinate: artifact.role,
      necessity: artifact.necessity,
      artifact,
    })),
  ];
}

function subjectSatisfies(
  subject: InformationSubjectFacts,
  input: RequestedInput,
): boolean {
  switch (input.kind) {
    case "metadata":
      return subject.metadata.some((fact) =>
        coordinateMatches(input.coordinate, fact.property),
      );
    case "relationship":
      return subject.relationships.some((fact) =>
        coordinateMatches(input.coordinate, fact.type),
      );
    case "artifact-role":
      return subject.artifactAssociations.some(
        (fact) =>
          coordinateMatches(input.coordinate, fact.role) &&
          fact.available !== false,
      );
  }
}

function supportsSource(
  capability: InformationFulfillmentCapability,
  sourceIdentity: string,
): boolean {
  return capability.sourceIdentities.some((candidate) =>
    coordinateMatches(candidate, sourceIdentity),
  );
}

function supportsInput(
  capability: InformationFulfillmentCapability,
  input: RequestedInput,
): boolean {
  const coordinates =
    input.kind === "metadata"
      ? capability.metadataProperties
      : input.kind === "relationship"
        ? capability.relationshipTypes
        : capability.artifactRoles;
  return (coordinates ?? []).some((candidate) =>
    coordinateMatches(candidate, input.coordinate),
  );
}

function coordinateMatches(pattern: string, value: string): boolean {
  if (pattern === value || pattern === "*") return true;
  return pattern.endsWith(".*") && value.startsWith(pattern.slice(0, -1));
}

function readinessIdentity(
  input: RequestedInput,
): Omit<InformationInputReadiness, "status"> {
  return {
    kind: input.kind,
    coordinate: input.coordinate,
    necessity: input.necessity,
  };
}

/** A terminal failure of optional work is absence, never a subject blocker. */
function readinessStatusForInput(
  input: RequestedInput,
  status: InformationReadinessStatus,
): InformationReadinessStatus {
  return input.necessity === "optional" && status === "blocked"
    ? "unavailable"
    : status;
}

function executionReferencesFor(
  result: InformationFulfillmentStart,
): readonly InformationExecutionReference[] | undefined {
  if (result.workflowExecutionId === undefined) return undefined;
  return [{ workflowExecutionId: result.workflowExecutionId }];
}

function readinessKey(subjectId: string, inputId: string): string {
  return `${subjectId}\u0000${inputId}`;
}

function subjectReadinessStatus(
  inputs: readonly InformationInputReadiness[],
): InformationReadinessStatus {
  const required = inputs.filter((input) => input.necessity === "required");
  if (required.some((input) => input.status === "blocked")) return "blocked";
  if (required.some((input) => input.status === "pending")) return "pending";
  if (required.some((input) => input.status === "unavailable"))
    return "unavailable";
  return "available";
}

function groupedPlans(
  planned: readonly PlannedInput[],
  requirement: InformationRequirement,
): readonly {
  readonly plan: InformationFulfillmentPlan;
  readonly inputs: readonly PlannedInput[];
}[] {
  const groups = new Map<string, PlannedInput[]>();
  for (const item of planned) {
    const key = [
      item.subjectId,
      item.sourceIdentity,
      item.sourceAssociationId ?? "",
      item.capability.operation,
      item.capability.declaration.identity,
    ].join("\u0000");
    const current = groups.get(key) ?? [];
    current.push(item);
    groups.set(key, current);
  }
  return [...groups.values()].map((inputs) => {
    const first = inputs[0];
    if (first === undefined)
      throw new Error("Information Fulfillment plan was empty");
    return {
      inputs,
      plan: {
        subjectId: first.subjectId,
        sourceIdentity: first.sourceIdentity,
        ...(first.sourceAssociationId === undefined
          ? {}
          : { sourceAssociationId: first.sourceAssociationId }),
        operation: first.capability.operation,
        capability: first.capability.declaration,
        requirement: subsetRequirement(
          requirement,
          inputs.map((input) => input.input),
        ),
      },
    };
  });
}

function subsetRequirement(
  requirement: InformationRequirement,
  inputs: readonly RequestedInput[],
): InformationRequirement {
  const requested = new Set(inputs.map((input) => input.id));
  return {
    metadataUsageContext: requirement.metadataUsageContext,
    metadata: requirement.metadata.filter((item) =>
      requested.has(`metadata:${item.property}`),
    ),
    relationshipTypes: requirement.relationshipTypes.filter((item) =>
      requested.has(`relationship:${item.type}`),
    ),
    artifactRoles: requirement.artifactRoles.filter((item) =>
      requested.has(`artifact-role:${item.role}`),
    ),
  };
}

function validateSelection(selection: InformationSubjectSelection): void {
  const seen = new Set<string>();
  for (const subjectId of selection.subjectIds) {
    if (subjectId.trim().length === 0 || seen.has(subjectId))
      throw new Error(
        "Information Fulfillment requires unique stable subject identifiers",
      );
    seen.add(subjectId);
  }
}

function validateRequirement(requirement: InformationRequirement): void {
  if (requirement.metadataUsageContext.trim().length === 0)
    throw new Error(
      "Information Requirement requires a metadata usage context",
    );
  const coordinates = new Set<string>();
  for (const input of requestedInputs(requirement)) {
    if (input.coordinate.trim().length === 0 || coordinates.has(input.id))
      throw new Error(
        "Information Requirement contains a duplicate or empty coordinate",
      );
    coordinates.add(input.id);
  }
}

function validateInitiation(
  initiation: InformationFulfillmentInitiation | undefined,
): void {
  if (initiation === undefined) return;
  if (initiation.version !== "information-fulfillment-initiation/1")
    throw new Error(
      "Information Fulfillment initiation version is unsupported",
    );
  if (initiation.parentExecutionId.trim().length === 0)
    throw new Error(
      "Information Fulfillment initiation requires a parent execution",
    );
}

/** Remove likely credentials and transport details from caller-visible state. */
export function sanitizeInformationReason(reason: string): string {
  return reason
    .replace(/[\r\n\t]+/gu, " ")
    .replace(
      /\b(authorization|token|secret|password|cookie)\b\s*([:=])\s*(?:bearer\s+)?[^\s,;]+/giu,
      (_match, label: string, separator: string) =>
        `${label}${separator} [redacted]`,
    )
    .trim()
    .slice(0, 500);
}
