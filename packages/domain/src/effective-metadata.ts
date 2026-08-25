import type { MetadataAssertion } from "./metadata-assertion.ts";

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
    readonly kind: "source-preference" | "deterministic-assertion-order";
    readonly selectedSource: string;
    readonly disagreesWithSelected: boolean;
  };
};

export type EffectiveMetadata = {
  readonly property: string;
  readonly value: string;
  readonly selectedAssertion: MetadataAssertion;
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

export type EffectiveMetadataProjection = {
  readonly values: readonly EffectiveMetadata[];
  readonly conflicts: readonly MetadataPolicyConflict[];
};

export type EffectiveMetadataInput = {
  readonly subjectId: string;
  readonly metadataUsageContext: string;
  readonly policies?: readonly MetadataPolicy[];
  readonly sourceRecords: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
  }[];
  readonly metadata: readonly MetadataAssertion[];
};

type ResolvedAssertion = {
  readonly assertion: MetadataAssertion;
  readonly sourceIdentity: string;
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
        policy.subjectIds.includes(input.subjectId),
    );
  if (
    new Set(applicablePolicies.map((policy) => policy.id)).size !==
    applicablePolicies.length
  ) {
    throw new Error("Metadata Policy identifiers are not unique");
  }

  const facts = resolveAssertions(input);
  const byProperty = new Map<string, ResolvedAssertion[]>();
  for (const fact of facts) {
    const current = byProperty.get(fact.assertion.property) ?? [];
    current.push(fact);
    byProperty.set(fact.assertion.property, current);
  }

  const values: EffectiveMetadata[] = [];
  const conflicts: MetadataPolicyConflict[] = [];
  for (const property of [...byProperty.keys()].toSorted()) {
    const assertions = (byProperty.get(property) ?? []).toSorted(
      compareResolvedAssertions,
    );
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
      values.push(...assertions.map((assertion) => unranked(assertion)));
      continue;
    }
    if (rule.cardinality === "many") {
      values.push(...selectMany(assertions, rule.preferredSourceIdentities));
      continue;
    }
    const selected = selectOne(assertions, rule.preferredSourceIdentities);
    if (selected !== undefined) values.push(selected);
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
    if (
      assertion.subjectId !== undefined &&
      assertion.subjectId !== input.subjectId
    )
      return [];
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
): EffectiveMetadata | undefined {
  if (assertions.length === 0) return undefined;
  const selectedPreferenceIndex = preferredSources.findIndex((identity) =>
    assertions.some((assertion) => assertion.sourceIdentity === identity),
  );
  const selected =
    selectedPreferenceIndex < 0
      ? assertions[0]
      : assertions.find(
          (assertion) =>
            assertion.sourceIdentity ===
            preferredSources[selectedPreferenceIndex],
        );
  if (selected === undefined) return undefined;
  const alternatives = assertions
    .filter((assertion) => assertion !== selected)
    .map((assertion) =>
      alternative(assertion, {
        kind:
          selectedPreferenceIndex < 0
            ? "deterministic-assertion-order"
            : "source-preference",
        selectedSource: selected.sourceIdentity,
        disagreesWithSelected:
          assertion.assertion.value !== selected.assertion.value,
      }),
    );
  if (selectedPreferenceIndex === 0) {
    return {
      ...effective(selected, alternatives),
      reasoning: {
        kind: "source-preference",
        preferredSource: selected.sourceIdentity,
      },
    };
  }
  if (selectedPreferenceIndex > 0) {
    return {
      ...effective(selected, alternatives),
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
      ...effective(selected, alternatives),
      reasoning: {
        kind: "preferred-source-absent-fallback",
        absentPreferredSources: preferredSources,
        selectedFallbackSource: selected.sourceIdentity,
      },
    };
  }
  return unranked(selected, alternatives);
}

function selectMany(
  assertions: readonly ResolvedAssertion[],
  preferredSources: readonly string[],
): readonly EffectiveMetadata[] {
  if (assertions.length === 0) return [];
  const selectedPreferenceIndex = preferredSources.findIndex((identity) =>
    assertions.some((assertion) => assertion.sourceIdentity === identity),
  );
  const selectedSource =
    selectedPreferenceIndex < 0
      ? assertions[0]?.sourceIdentity
      : preferredSources[selectedPreferenceIndex];
  if (selectedSource === undefined) return [];
  const selected = assertions.filter(
    (assertion) => assertion.sourceIdentity === selectedSource,
  );
  const selectedValues = new Set(
    selected.map((assertion) => assertion.assertion.value),
  );
  const alternatives = assertions
    .filter((assertion) => assertion.sourceIdentity !== selectedSource)
    .map((assertion) =>
      alternative(assertion, {
        kind:
          selectedPreferenceIndex < 0
            ? "deterministic-assertion-order"
            : "source-preference",
        selectedSource,
        disagreesWithSelected: !selectedValues.has(assertion.assertion.value),
      }),
    );
  const reasoning: EffectiveMetadata["reasoning"] =
    selectedPreferenceIndex === 0
      ? { kind: "source-preference", preferredSource: selectedSource }
      : {
          kind: "preferred-source-absent-fallback",
          absentPreferredSources:
            selectedPreferenceIndex < 0
              ? preferredSources
              : preferredSources.slice(0, selectedPreferenceIndex),
          selectedFallbackSource: selectedSource,
        };
  return selected.map((assertion) => ({
    ...effective(assertion, alternatives),
    reasoning,
  }));
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
): Omit<EffectiveMetadata, "reasoning"> {
  const assertion = resolved.assertion;
  return {
    property: assertion.property,
    value: assertion.value,
    selectedAssertion: assertion,
    sourceIdentity: resolved.sourceIdentity,
    sourceRecordIds: assertion.sourceRecordIds,
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
): EffectiveMetadata {
  return {
    ...effective(assertion, alternatives),
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
