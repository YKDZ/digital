import { randomUUID } from "node:crypto";

import type { DeclaredCapability, InformationRequirement } from "./index.ts";
import type { FrozenDirectoryAuthorization } from "./library-directory-grants.ts";

/** 有限、与视图无关且已经稳定的领域主体集合。 */
export type InformationSubjectSelection = {
  readonly subjectIds: readonly string[];
};

/** Application 规划任何工作前允许比较的事实。 */
export type InformationSubjectFacts = {
  readonly subjectId: string;
  readonly metadata: readonly { readonly property: string }[];
  readonly relationships: readonly { readonly type: string }[];
  /** `available` 表示普通关联具有可访问字节。 */
  readonly artifactAssociations: readonly {
    readonly role: string;
    readonly available?: boolean;
  }[];
  /** 已经适用于该精确主体的当前来源关联。 */
  readonly sourceAssociations: readonly {
    readonly sourceIdentity: string;
    /** 保留为后续工作计划选定的当前关联。 */
    readonly sourceAssociationId?: string;
  }[];
};

/**
 * 这里刻意声明一条窄履行路径，而不是提供方模型。来源身份保持开放字符串，但能力必须带着
 * 完整坐标：库范围过滤只按 ID、实现版本与契约版本一起决定该路径能否参与本次冻结配置。
 */
export type InformationFulfillmentCapability = {
  readonly declaration: DeclaredCapability;
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
  /** 到达调用方前，在 Application 边界再次净化。 */
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
 * 既有工作流执行接受主体后所请求履行的 Application 专用来源。稳定父 ID 刻意比自动化
 * 意图更窄：恢复的子执行必须保留自己的冻结工作流输入，而不是从当前自动化配置重新
 * 计算来源。
 */
export type InformationFulfillmentInitiation = {
  readonly version: "information-fulfillment-initiation/1";
  readonly parentExecutionId: string;
  /**
   * 父执行冻结的来源目录授权账目。派生工作因此沿同一份 I/O 权威继续，而不是回看今日授权；
   * 父执行早于该账目出现时省略。
   */
  readonly directoryAuthorizations?: readonly FrozenDirectoryAuthorization[];
  /**
   * 该履行请求来自父的耐久计划账本：子执行的插入必须与具体 operation 同事务绑定，已绑定时
   * 返回原执行而不启动第二份效果。普通交付轮询没有这个标记，因此绝不借用账本接缝。
   */
  readonly fromDurableLedger?: true;
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
  /** 必需输入决定该摘要；可选缺失仍保持可见。 */
  readonly status: InformationReadinessStatus;
  readonly inputs: readonly InformationInputReadiness[];
};

/** 可重建的 Application 结果，绝不是领域可用性事实。 */
export type InformationReadiness = {
  readonly requirement: InformationRequirement;
  readonly subjects: readonly InformationSubjectReadiness[];
};

/**
 * 一个已规划低成本工作项。它只包含中立选择与需求坐标，因此调度器不能根据视图、路由、
 * 组件或提供方输出模型分支。`operationId` 与完整 `DeclaredCapability` 一起构成耐久计划契约：
 * 首次无效果规划时生成稳定身份，账本据此原子绑定唯一子执行。
 */
export type InformationFulfillmentPlan = {
  readonly subjectId: string;
  readonly sourceIdentity: string;
  /** 不透明当前关联身份；只在旧版／测试事实中缺失。 */
  readonly sourceAssociationId?: string;
  readonly operation: InformationFulfillmentCapability["operation"];
  readonly capability: DeclaredCapability;
  readonly requirement: InformationRequirement;
  /** 父内该具体计划的稳定身份，随整批计划一次写入。 */
  readonly operationId: string;
};

/** 耐久账本保存一份具体计划时使用的版本化封装。 */
export type InformationFulfillmentPlanEnvelope = {
  readonly version: "information-fulfillment-plan/1";
  readonly plan: InformationFulfillmentPlan;
};

/**
 * 一次无效果规划的单个请求输入结果。`readiness` 缺失表示该输入由 `plan` 承载，仍待履行。
 */
export type InformationFulfillmentPreparedInput = {
  readonly identity: Omit<InformationInputReadiness, "status">;
  readonly readiness?: InformationInputReadiness;
  readonly plan?: InformationFulfillmentPlan;
};

/**
 * 一个已接受主体的完整规划处置。`no-work` 是正确性状态：它证明该主体已用原 planner 与冻结
 * 事实完成规划且没有子执行计划，因此与「从未规划」和「缺依据中断」可耐久区分。
 */
export type InformationFulfillmentPreparedSubject = {
  readonly subjectId: string;
  readonly requirement: InformationRequirement;
  readonly disposition: "no-work" | "planned" | "interrupted";
  readonly reason?: string;
  readonly inputs: readonly InformationFulfillmentPreparedInput[];
  readonly plans: readonly InformationFulfillmentPlan[];
};

/** 父仍 running 时得到的无效果规划快照；终态恢复只能消费已持久化的计划。 */
export type InformationFulfillmentPreparation = {
  readonly requirement: InformationRequirement;
  readonly subjects: readonly InformationFulfillmentPreparedSubject[];
};

type InformationFulfillmentTerminal = {
  readonly status: "unavailable" | "blocked";
  readonly reason: string;
  /** 等待中执行进入终态后保留耐久尝试。 */
  readonly workflowExecutionId?: string;
};

export type InformationFulfillmentStart =
  | {
      readonly status: "pending";
      readonly workflowExecutionId: string;
    }
  | InformationFulfillmentTerminal;

/**
 * 耐久执行可能在首次就绪投影后完成。该边界把其持久终态转换为稳定就绪结果，而不会在
 * 每次交付刷新时重试相同来源工作。
 */
export type InformationFulfillmentPendingReconciliation =
  | { readonly status: "pending" }
  | InformationFulfillmentTerminal;

/**
 * 产品策略可以允许有界精确来源补充。没有返回候选是普通情况；已声明集成绝不会仅因
 * 碰巧已经部署就扇出。
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
    requirement: InformationRequirement,
  ) => Promise<readonly InformationSubjectFacts[]>;
  readonly capabilities: readonly InformationFulfillmentCapability[];
  readonly policy?: InformationFulfillmentPolicy;
  readonly start: (
    plan: InformationFulfillmentPlan,
    initiation?: InformationFulfillmentInitiation,
  ) => Promise<InformationFulfillmentStart>;
  /** 可选，因为只有耐久工作流能够协调执行 ID。 */
  readonly reconcilePending?: (input: {
    readonly plan: InformationFulfillmentPlan;
    readonly workflowExecutionId: string;
  }) => Promise<InformationFulfillmentPendingReconciliation>;
};

/**
 * 不启动任何履行的终态就绪。生命周期关闭与库语境缺失都报告相同的中立形状，绝不把调用方
 * 已经规划的工作改写为重试，也不让新履行到达正在关闭的持久化持有者。
 */
export function terminalInformationReadiness(
  input: {
    readonly selection: InformationSubjectSelection;
    readonly requirement: InformationRequirement;
    readonly initiation?: InformationFulfillmentInitiation;
  },
  status: Extract<InformationReadinessStatus, "blocked" | "unavailable">,
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
        status: readinessStatusForInput(requestedInput, status),
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
  /** 防止不同当前关联仅因身份相同而合并。 */
  readonly sourceAssociationId?: string;
  readonly capability: InformationFulfillmentCapability;
};

type PendingInformationWork = {
  readonly plan: InformationFulfillmentPlan;
  readonly result: Promise<InformationFulfillmentStart>;
};

/**
 * 深层、交付层无关输入规划。优先复用当前事实；只有具备适用低成本声明的精确缺失坐标
 * 才能触发调度请求。实例记忆等待中工作，使相同交互和自动需求自然去重。
 */
export class InformationFulfillment {
  private readonly pending = new Map<string, PendingInformationWork>();
  private readonly ports: InformationFulfillmentPorts;

  constructor(ports: InformationFulfillmentPorts) {
    this.ports = ports;
  }

  /**
   * 只读取事实并完成规划，绝不启动任何效果。自动化父因此在仍 running 时就能为每个接受主体
   * 得到完整处置，并把计划与原父终态同事务提交。
   */
  async prepare(input: {
    readonly selection: InformationSubjectSelection;
    readonly requirement: InformationRequirement;
    /** Application 内部来源；交付调用方不构造它。 */
    readonly initiation?: InformationFulfillmentInitiation;
  }): Promise<InformationFulfillmentPreparation> {
    validateSelection(input.selection);
    validateRequirement(input.requirement);
    validateInitiation(input.initiation);
    const requested = requestedInputs(input.requirement);
    const facts = await this.ports.readSubjects(
      input.selection,
      input.requirement,
    );
    const factsBySubject = new Map(
      facts.map((subject) => [subject.subjectId, subject]),
    );
    const subjects: InformationFulfillmentPreparedSubject[] = [];

    for (const subjectId of input.selection.subjectIds) {
      const subject = factsBySubject.get(subjectId);
      const planned: PlannedInput[] = [];
      const resolved: {
        readonly inputId: string;
        readonly identity: Omit<InformationInputReadiness, "status">;
        readonly readiness?: InformationInputReadiness;
      }[] = [];
      for (const requestedInput of requested) {
        const identity = readinessIdentity(requestedInput);
        if (subject === undefined) {
          resolved.push({
            inputId: requestedInput.id,
            identity,
            readiness: {
              ...identity,
              status: "blocked",
              reason: "所选主体当前不可读取",
            },
          });
          continue;
        }
        if (subjectSatisfies(subject, requestedInput)) {
          resolved.push({
            inputId: requestedInput.id,
            identity,
            readiness: { ...identity, status: "available" },
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
          resolved.push({ inputId: requestedInput.id, identity });
          continue;
        }
        resolved.push({
          inputId: requestedInput.id,
          identity,
          readiness: {
            ...identity,
            status: readinessStatusForInput(requestedInput, resolution.status),
            ...(resolution.reason === undefined
              ? {}
              : { reason: sanitizeInformationReason(resolution.reason) }),
          },
        });
      }
      const plans = groupedPlans(planned, input.requirement);
      const planByInputId = new Map<string, InformationFulfillmentPlan>();
      for (const group of plans)
        for (const plannedInput of group.inputs)
          planByInputId.set(plannedInput.input.id, group.plan);
      subjects.push({
        subjectId,
        requirement: input.requirement,
        disposition:
          subject === undefined
            ? "interrupted"
            : plans.length === 0
              ? "no-work"
              : "planned",
        ...(subject === undefined
          ? { reason: "所选主体当前不可读取" }
          : plans.length === 0
            ? { reason: unplannedReason(resolved) }
            : {}),
        inputs: resolved.map((item) => {
          if (item.readiness !== undefined)
            return { identity: item.identity, readiness: item.readiness };
          const plan = planByInputId.get(item.inputId);
          if (plan === undefined)
            throw new Error(
              "Information Fulfillment planned an input without a plan",
            );
          return { identity: item.identity, plan };
        }),
        plans: plans.map((group) => group.plan),
      });
    }
    return { requirement: input.requirement, subjects };
  }

  /**
   * 执行一次已经完成的无效果规划。等待中工作仍按父与逻辑计划隔离，因此相同主体的轮询不会
   * 将同一来源工作变成第二份效果。
   */
  async fulfillPrepared(
    preparation: InformationFulfillmentPreparation,
    /** Application 内部来源；交付调用方不构造它。 */
    initiation?: InformationFulfillmentInitiation,
  ): Promise<InformationReadiness> {
    validateInitiation(initiation);
    const subjects: InformationSubjectReadiness[] = [];
    for (const subject of preparation.subjects) {
      const started = new Map<string, InformationFulfillmentStart>();
      for (const plan of subject.plans)
        started.set(plan.operationId, await this.start(plan, initiation));
      const inputs = subject.inputs.map((input) => {
        if (input.readiness !== undefined) return input.readiness;
        const plan = input.plan;
        if (plan === undefined)
          throw new Error("Information Fulfillment omitted a requested input");
        const result = started.get(plan.operationId);
        if (result === undefined)
          throw new Error(
            "Information Fulfillment filled an unknown planned input",
          );
        return readinessForStart(input.identity, result);
      });
      subjects.push({
        subjectId: subject.subjectId,
        status: subjectReadinessStatus(inputs),
        inputs,
      });
    }
    return { requirement: preparation.requirement, subjects };
  }

  async fulfill(input: {
    readonly selection: InformationSubjectSelection;
    readonly requirement: InformationRequirement;
    /** Application 内部来源；交付调用方不构造它。 */
    readonly initiation?: InformationFulfillmentInitiation;
  }): Promise<InformationReadiness> {
    return await this.fulfillPrepared(
      await this.prepare(input),
      input.initiation,
    );
  }

  /**
   * 新进入终态的来源刷新，是唯一能使先前终态来源工作记忆过期的普通事件。这里刻意不是
   * 通用重试按钮：没有变化的交付轮询保留终态不可用／阻塞就绪，而不重放远程工作。
   */
  invalidateForSourceFacts(input: {
    readonly subjectId: string;
    readonly sourceIdentity: string;
    /** 提供时，不逐出同级当前来源关联。 */
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
    // 在途复用只在这一次发起的父之内生效。同一个计划由另一个父发起时，命中别人的 pending
    // 会让本父既没有自己那一份耐久子登记，又继续用另一个父冻结的库配置与目录授权干活。
    const key = pendingKey(plan, initiation);
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
      // 保留该终态观察，直到当前事实变化或明确的新工作流替换它；Catalogue 轮询不得把
      // 失败／取消的来源运行变成隐式重试循环。
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

/** 一个已启动计划对请求输入的确定就绪结果。 */
function readinessForStart(
  identity: Omit<InformationInputReadiness, "status">,
  start: InformationFulfillmentStart,
): InformationInputReadiness {
  const executionReferences = executionReferencesFor(start);
  return start.status === "pending"
    ? {
        ...identity,
        status: "pending",
        executionReferences: [
          { workflowExecutionId: start.workflowExecutionId },
        ],
      }
    : {
        ...identity,
        status: readinessStatusForInput(identity, start.status),
        reason: sanitizeInformationReason(start.reason),
        ...(executionReferences === undefined ? {} : { executionReferences }),
      };
}

/** 没有计划时给主体的稳定说明，绝不是「尚未规划」。 */
function unplannedReason(
  resolved: readonly { readonly readiness?: InformationInputReadiness }[],
): string {
  const missing = resolved.flatMap((item) =>
    item.readiness !== undefined && item.readiness.status !== "available"
      ? [item.readiness]
      : [],
  );
  if (missing.length === 0) return "所需信息已由当前事实满足";
  const blocked = missing.find((item) => item.status === "blocked");
  return (blocked ?? missing[0])?.reason ?? "没有已声明能力可履行该信息输入";
}

/** 可选工作的终态失败表示缺失，绝不是主体阻塞条件。 */
function readinessStatusForInput(
  input: { readonly necessity: InformationInputReadiness["necessity"] },
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

/**
 * 在途与终态记忆的判重键。带发起父时按父隔离，父之后的耐久登记因此逐父重建；没有发起父的
 * 普通调用沿用逻辑计划本身，同一交互仍然自然去重。稳定 operation 身份刻意排除在外：它由
 * 每次规划新生成，不能把同一逻辑工作误判成两份。
 */
function pendingKey(
  plan: InformationFulfillmentPlan,
  initiation: InformationFulfillmentInitiation | undefined,
): string {
  const logical = JSON.stringify({
    subjectId: plan.subjectId,
    sourceIdentity: plan.sourceIdentity,
    sourceAssociationId: plan.sourceAssociationId ?? null,
    operation: plan.operation,
    capability: plan.capability,
    requirement: plan.requirement,
  });
  return initiation === undefined
    ? logical
    : `${initiation.parentExecutionId}\u0000${logical}`;
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
        operationId: `information-fulfillment-operation-${randomUUID()}`,
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

/** 从调用方可见状态中移除疑似凭据和传输细节。 */
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
