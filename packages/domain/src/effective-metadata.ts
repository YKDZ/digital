import type {
  DescriptionTarget,
  MetadataAssertion,
} from "./metadata-assertion.ts";
import {
  metadataDecisionKey,
  validateMetadataDecision,
  type MetadataDecision,
} from "./metadata-decision.ts";

export type MetadataPolicyRule = {
  /** 精确属性、以 `*` 结尾的命名空间模式，或作为默认值的 `*`。 */
  readonly property: string;
  readonly preferredSourceIdentities: readonly string[];
  readonly cardinality: "one" | "many";
};

export type MetadataPolicy = {
  readonly id: string;
  readonly metadataUsageContext: string;
  readonly subjectIds: readonly string[];
  readonly rules: readonly MetadataPolicyRule[];
};

export type EffectiveMetadataAlternative = {
  readonly assertion: MetadataAssertion;
  readonly value: string;
  readonly sourceIdentity: string;
  readonly sourceRecordIds: readonly string[];
  readonly sourceSlot: string;
  readonly qualifiers?: MetadataAssertion["qualifiers"];
  readonly exclusion?: {
    readonly kind: "source-preference";
    readonly selectedSource: string;
    readonly disagreesWithSelected: boolean;
  };
};

export type EffectiveMetadata = {
  readonly property: string;
  readonly value: string;
  readonly selectedAssertion: MetadataAssertion;
  readonly contributingAssertions: readonly MetadataAssertion[];
  readonly sourceRecordIds: readonly string[];
  readonly sourceSlot: string;
  readonly sourceIdentity: string;
  readonly qualifiers?: MetadataAssertion["qualifiers"];
  readonly alternatives: readonly EffectiveMetadataAlternative[];
  readonly reasoning:
    | { readonly kind: "source-preference"; readonly preferredSource: string }
    | {
        readonly kind: "preferred-source-absent-fallback";
        readonly absentPreferredSources: readonly string[];
        readonly selectedFallbackSource: string;
      }
    | {
        readonly kind: "preferred-sources-absent-unranked";
        readonly absentPreferredSources: readonly string[];
      }
    | { readonly kind: "unranked-source-assertion" };
};

export type MetadataPolicyConflict = {
  readonly kind: "policy-conflict";
  readonly property: string;
  readonly metadataUsageContext: string;
  readonly policyIds: readonly string[];
  readonly candidates: readonly EffectiveMetadataAlternative[];
  readonly explanation: string;
};

export type MetadataValueConflict = {
  readonly kind: "metadata-value-conflict";
  readonly property: string;
  readonly metadataUsageContext: string;
  readonly candidates: readonly EffectiveMetadataAlternative[];
  readonly explanation: string;
};

export type EffectiveMetadataProjection = {
  readonly values: readonly EffectiveMetadata[];
  readonly conflicts: readonly (
    | MetadataPolicyConflict
    | MetadataValueConflict
  )[];
};

export type EffectiveMetadataInput = {
  readonly target: DescriptionTarget;
  readonly metadataUsageContext: string;
  readonly policies?: readonly MetadataPolicy[];
  readonly sourceRecords: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
  }[];
  readonly metadata: readonly MetadataAssertion[];
  /** 只传每个精确坐标的当前头；历史决定在检查依据中另行读取。 */
  readonly metadataDecisions?: readonly MetadataDecision[];
};

type ResolvedAssertion = {
  readonly assertion: MetadataAssertion;
  readonly sourceIdentity: string;
  readonly manualDecision?: boolean;
};

/**
 * 在一个提供方中立策略参与推导前对其验证。规则顺序不承载含义，因此重复坐标会产生
 * 歧义并被拒绝。
 */
export function validateMetadataPolicy(policy: MetadataPolicy): MetadataPolicy {
  if (
    policy.id.length === 0 ||
    policy.metadataUsageContext.length === 0 ||
    policy.subjectIds.length === 0 ||
    hasEmptyOrDuplicate(policy.subjectIds)
  ) {
    throw new Error("Metadata Policy has an invalid identity or scope");
  }
  const properties = new Set<string>();
  for (const rule of policy.rules) {
    if (
      !isPropertySelector(rule.property) ||
      properties.has(rule.property) ||
      hasEmptyOrDuplicate(rule.preferredSourceIdentities)
    ) {
      throw new Error("Metadata Policy has an invalid or duplicate rule");
    }
    properties.add(rule.property);
  }
  return policy;
}

/**
 * 推导当前值和可检查策略冲突，但不创作断言。组合层可以选择策略定义，其稳定应用语义
 * 由本模块持有。
 */
export function deriveEffectiveMetadata(
  input: EffectiveMetadataInput,
): EffectiveMetadataProjection {
  const applicablePolicies = (input.policies ?? [])
    .map(validateMetadataPolicy)
    .filter(
      (policy) =>
        policy.metadataUsageContext === input.metadataUsageContext &&
        input.target.kind === "entity" &&
        policy.subjectIds.includes(input.target.entityId),
    );
  if (
    new Set(applicablePolicies.map((policy) => policy.id)).size !==
    applicablePolicies.length
  ) {
    throw new Error("Metadata Policy identifiers are not unique");
  }

  const currentDecisionByCoordinate = new Map<string, MetadataDecision>();
  for (const decision of input.metadataDecisions ?? []) {
    validateMetadataDecision(decision);
    const key = metadataDecisionKey(
      decision.target,
      decision.property,
      decision.metadataUsageContext,
    );
    if (currentDecisionByCoordinate.has(key))
      throw new Error("Metadata Decision coordinate has several current heads");
    currentDecisionByCoordinate.set(key, decision);
  }
  const effectiveDecisions = [...currentDecisionByCoordinate.values()].filter(
    (decision) => decision.metadataUsageContext === input.metadataUsageContext,
  );
  const pinnedDecisions = effectiveDecisions.filter(
    (decision) => decision.kind === "pin",
  );
  const facts = [
    ...resolveAssertions({
      ...input,
      metadata: input.metadata.filter(
        (assertion) =>
          !pinnedDecisions.some(
            (decision) =>
              decision.property === assertion.property &&
              sameDescriptionTarget(decision.target, assertion.target),
          ),
      ),
    }),
    ...pinnedDecisions.flatMap((decision): ResolvedAssertion[] => {
      if (!sameDescriptionTarget(decision.target, input.target)) return [];
      const assertion: MetadataAssertion = {
        target: decision.target,
        property: decision.property,
        sourceSlot: "manual.metadata-decision",
        value: decision.value!,
        sourceRecordIds: [],
        ...(decision.qualifiers === undefined
          ? {}
          : { qualifiers: decision.qualifiers }),
      };
      return [{ assertion, sourceIdentity: "user", manualDecision: true }];
    }),
  ];
  const byProperty = new Map<string, ResolvedAssertion[]>();
  for (const fact of facts) {
    const current = byProperty.get(fact.assertion.property) ?? [];
    current.push(fact);
    byProperty.set(fact.assertion.property, current);
  }

  const values: EffectiveMetadata[] = [];
  const conflicts: (MetadataPolicyConflict | MetadataValueConflict)[] = [];
  for (const property of [...byProperty.keys()].toSorted()) {
    const assertions = (byProperty.get(property) ?? []).toSorted(
      compareResolvedAssertions,
    );
    const userAssertions = assertions.filter(
      ({ assertion, manualDecision }) =>
        assertion.authoredBy !== undefined || manualDecision === true,
    );
    if (userAssertions.length > 0) {
      const selected = selectOne(
        assertions,
        ["user"],
        input.metadataUsageContext,
      );
      if (selected !== undefined && "kind" in selected)
        conflicts.push(selected);
      else if (selected !== undefined) values.push(selected);
      continue;
    }
    const controllers = applicablePolicies.flatMap((policy) => {
      const rule = controllingRule(policy.rules, property);
      return rule === undefined ? [] : [{ policy, rule }];
    });
    if (controllers.length > 1) {
      const policyIds = controllers.map(({ policy }) => policy.id).toSorted();
      conflicts.push({
        kind: "policy-conflict",
        property,
        metadataUsageContext: input.metadataUsageContext,
        policyIds,
        candidates: assertions.map((assertion) => alternative(assertion)),
        explanation: `Metadata Policies ${policyIds.join(", ")} are incomparable for ${property}`,
      });
      continue;
    }
    const rule = controllers[0]?.rule;
    if (
      rule === undefined ||
      (rule.cardinality === "many" &&
        rule.preferredSourceIdentities.length === 0)
    ) {
      values.push(...coalesceUnranked(assertions));
      continue;
    }
    if (rule.cardinality === "many") {
      values.push(...selectMany(assertions, rule.preferredSourceIdentities));
      continue;
    }
    const selected = selectOne(
      assertions,
      rule.preferredSourceIdentities,
      input.metadataUsageContext,
    );
    if (selected !== undefined && "kind" in selected) {
      conflicts.push(selected);
    } else if (selected !== undefined) {
      values.push(selected);
    }
  }
  return { values, conflicts };
}

function resolveAssertions(
  input: EffectiveMetadataInput,
): readonly ResolvedAssertion[] {
  const sourceByRecord = new Map<string, string>();
  for (const record of input.sourceRecords) {
    if (record.id.length === 0 || record.sourceIdentity.length === 0)
      throw new Error("Effective Metadata source reference is invalid");
    const current = sourceByRecord.get(record.id);
    if (current !== undefined && current !== record.sourceIdentity)
      throw new Error("Source Record has conflicting source identities");
    sourceByRecord.set(record.id, record.sourceIdentity);
  }
  return input.metadata.flatMap((assertion): readonly ResolvedAssertion[] => {
    if (!sameDescriptionTarget(assertion.target, input.target)) return [];
    if (assertion.authoredBy !== undefined)
      return [{ assertion, sourceIdentity: "user" }];
    const identities = [
      ...new Set(
        assertion.sourceRecordIds.flatMap((id) => {
          const identity = sourceByRecord.get(id);
          return identity === undefined ? [] : [identity];
        }),
      ),
    ];
    if (identities.length > 1)
      throw new Error(
        "Metadata Assertion spans several Metadata Source identities",
      );
    const sourceIdentity = identities[0];
    if (sourceIdentity !== undefined) return [{ assertion, sourceIdentity }];
    return assertion.observedArtifactPart === undefined
      ? []
      : [{ assertion, sourceIdentity: "local-observed" }];
  });
}

function sameDescriptionTarget(
  left: DescriptionTarget,
  right: DescriptionTarget,
): boolean {
  return left.kind === "entity" && right.kind === "entity"
    ? left.entityId === right.entityId
    : left.kind === "artifact-revision" && right.kind === "artifact-revision"
      ? left.artifactId === right.artifactId &&
        left.revisionId === right.revisionId
      : false;
}

function controllingRule(
  rules: readonly MetadataPolicyRule[],
  property: string,
): MetadataPolicyRule | undefined {
  const exact = rules.find((rule) => rule.property === property);
  if (exact !== undefined) return exact;
  const patterns = rules
    .filter(
      (rule) =>
        rule.property !== "*" &&
        rule.property.endsWith("*") &&
        property.startsWith(rule.property.slice(0, -1)),
    )
    .toSorted(
      (left, right) =>
        right.property.length - left.property.length ||
        compareText(left.property, right.property),
    );
  return patterns[0] ?? rules.find((rule) => rule.property === "*");
}

function selectOne(
  assertions: readonly ResolvedAssertion[],
  preferredSources: readonly string[],
  metadataUsageContext: string,
): EffectiveMetadata | MetadataValueConflict | undefined {
  if (assertions.length === 0) return undefined;
  const selectedPreferenceIndex = preferredSources.findIndex((identity) =>
    assertions.some((assertion) => assertion.sourceIdentity === identity),
  );
  const selectedSource = preferredSources[selectedPreferenceIndex];
  const eligible =
    selectedPreferenceIndex < 0
      ? assertions
      : assertions.filter(
          (assertion) => assertion.sourceIdentity === selectedSource,
        );
  if (new Set(eligible.map(semanticValueKey)).size > 1) {
    return {
      kind: "metadata-value-conflict",
      property: assertions[0]!.assertion.property,
      metadataUsageContext,
      candidates: eligible.map((assertion) => alternative(assertion)),
      explanation:
        selectedSource === undefined
          ? `Unranked Metadata Sources supply several values for single-valued property ${assertions[0]!.assertion.property}`
          : `Metadata Source ${selectedSource} supplies several values for single-valued property ${assertions[0]!.assertion.property}`,
    };
  }
  const selected = eligible[0];
  if (selected === undefined) return undefined;
  const selectedValueKey = semanticValueKey(selected);
  const contributors = [
    selected,
    ...assertions.filter(
      (assertion) =>
        assertion !== selected &&
        semanticValueKey(assertion) === selectedValueKey,
    ),
  ];
  const alternatives = assertions
    .filter((assertion) => semanticValueKey(assertion) !== selectedValueKey)
    .map((assertion) =>
      alternative(assertion, {
        kind: "source-preference",
        selectedSource: selected.sourceIdentity,
        disagreesWithSelected:
          assertion.assertion.value !== selected.assertion.value,
      }),
    );
  if (selectedPreferenceIndex === 0) {
    return {
      ...effective(selected, alternatives, contributors),
      reasoning: {
        kind: "source-preference",
        preferredSource: selected.sourceIdentity,
      },
    };
  }
  if (selectedPreferenceIndex > 0) {
    return {
      ...effective(selected, alternatives, contributors),
      reasoning: {
        kind: "preferred-source-absent-fallback",
        absentPreferredSources: preferredSources.slice(
          0,
          selectedPreferenceIndex,
        ),
        selectedFallbackSource: selected.sourceIdentity,
      },
    };
  }
  if (preferredSources.length > 0) {
    return {
      ...effective(selected, [], contributors),
      reasoning: {
        kind: "preferred-sources-absent-unranked",
        absentPreferredSources: preferredSources,
      },
    };
  }
  return unranked(selected, alternatives);
}

function semanticValueKey(resolved: ResolvedAssertion): string {
  return JSON.stringify([
    resolved.assertion.value,
    [...(resolved.assertion.qualifiers ?? [])]
      .map((qualifier) => [qualifier.key, qualifier.value] as const)
      .toSorted(
        ([leftKey, leftValue], [rightKey, rightValue]) =>
          compareText(leftKey, rightKey) || compareText(leftValue, rightValue),
      ),
  ]);
}

function selectMany(
  assertions: readonly ResolvedAssertion[],
  preferredSources: readonly string[],
): readonly EffectiveMetadata[] {
  if (assertions.length === 0) return [];
  const selectedPreferenceIndex = preferredSources.findIndex((identity) =>
    assertions.some((assertion) => assertion.sourceIdentity === identity),
  );
  if (selectedPreferenceIndex < 0) {
    return coalesceBySemanticValue(assertions).map((group) => ({
      ...effective(group[0]!, [], group),
      reasoning: {
        kind: "preferred-sources-absent-unranked",
        absentPreferredSources: preferredSources,
      },
    }));
  }
  const selectedSource = preferredSources[selectedPreferenceIndex];
  if (selectedSource === undefined) return [];
  const selected = assertions.filter(
    (assertion) => assertion.sourceIdentity === selectedSource,
  );
  const selectedValues = new Set(selected.map(semanticValueKey));
  const alternatives = assertions
    .filter(
      (assertion) =>
        assertion.sourceIdentity !== selectedSource &&
        !selectedValues.has(semanticValueKey(assertion)),
    )
    .map((assertion) =>
      alternative(assertion, {
        kind: "source-preference",
        selectedSource,
        disagreesWithSelected: true,
      }),
    );
  const reasoning: EffectiveMetadata["reasoning"] =
    selectedPreferenceIndex === 0
      ? { kind: "source-preference", preferredSource: selectedSource }
      : {
          kind: "preferred-source-absent-fallback",
          absentPreferredSources: preferredSources.slice(
            0,
            selectedPreferenceIndex,
          ),
          selectedFallbackSource: selectedSource,
        };
  return coalesceBySemanticValue(selected).map((group) => ({
    ...effective(group[0]!, alternatives, [
      ...group,
      ...assertions.filter(
        (assertion) =>
          !group.includes(assertion) &&
          semanticValueKey(assertion) === semanticValueKey(group[0]!),
      ),
    ]),
    reasoning,
  }));
}

function coalesceUnranked(
  assertions: readonly ResolvedAssertion[],
): readonly EffectiveMetadata[] {
  return coalesceBySemanticValue(assertions).map((group) =>
    unranked(group[0]!, [], group),
  );
}

function coalesceBySemanticValue(
  assertions: readonly ResolvedAssertion[],
): readonly (readonly ResolvedAssertion[])[] {
  const groups = new Map<string, ResolvedAssertion[]>();
  for (const assertion of assertions) {
    const key = semanticValueKey(assertion);
    const group = groups.get(key) ?? [];
    group.push(assertion);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function alternative(
  resolved: ResolvedAssertion,
  exclusion?: EffectiveMetadataAlternative["exclusion"],
): EffectiveMetadataAlternative {
  const assertion = resolved.assertion;
  return {
    assertion,
    value: assertion.value,
    sourceIdentity: resolved.sourceIdentity,
    sourceRecordIds: assertion.sourceRecordIds,
    sourceSlot: assertion.sourceSlot,
    ...(assertion.qualifiers === undefined
      ? {}
      : { qualifiers: assertion.qualifiers }),
    ...(exclusion === undefined ? {} : { exclusion }),
  };
}

function effective(
  resolved: ResolvedAssertion,
  alternatives: readonly EffectiveMetadataAlternative[],
  contributors: readonly ResolvedAssertion[] = [resolved],
): Omit<EffectiveMetadata, "reasoning"> {
  const assertion = resolved.assertion;
  return {
    property: assertion.property,
    value: assertion.value,
    selectedAssertion: assertion,
    contributingAssertions: contributors.map((item) => item.assertion),
    sourceIdentity: resolved.sourceIdentity,
    sourceRecordIds: [
      ...new Set(
        contributors.flatMap((item) => item.assertion.sourceRecordIds),
      ),
    ],
    sourceSlot: assertion.sourceSlot,
    ...(assertion.qualifiers === undefined
      ? {}
      : { qualifiers: assertion.qualifiers }),
    alternatives,
  };
}

function unranked(
  assertion: ResolvedAssertion,
  alternatives: readonly EffectiveMetadataAlternative[] = [],
  contributors: readonly ResolvedAssertion[] = [assertion],
): EffectiveMetadata {
  return {
    ...effective(assertion, alternatives, contributors),
    reasoning: { kind: "unranked-source-assertion" },
  };
}

function compareResolvedAssertions(
  left: ResolvedAssertion,
  right: ResolvedAssertion,
): number {
  return (
    compareText(left.sourceIdentity, right.sourceIdentity) ||
    compareText(left.assertion.sourceSlot, right.assertion.sourceSlot) ||
    compareText(
      left.assertion.sourceRecordIds.join("\u0000"),
      right.assertion.sourceRecordIds.join("\u0000"),
    ) ||
    compareText(left.assertion.value, right.assertion.value)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPropertySelector(value: string): boolean {
  if (value.length === 0) return false;
  const firstWildcard = value.indexOf("*");
  return (
    firstWildcard < 0 ||
    (firstWildcard === value.length - 1 &&
      value.lastIndexOf("*") === firstWildcard)
  );
}

function hasEmptyOrDuplicate(values: readonly string[]): boolean {
  return (
    values.some((value) => value.length === 0) ||
    new Set(values).size !== values.length
  );
}
