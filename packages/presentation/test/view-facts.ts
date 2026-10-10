import type {
  EffectiveDescriptionRead,
  EffectiveSubjectRead,
} from "@digital/application";

import type { AssetViewFacts } from "../src/index.ts";

/**
 * 合成正式生效事实读取的窄夹具。它只补足现行读取契约要求的结构性字段（目标、使用语境、
 * 支持记录、范围），绝不补造业务值：缺失的属性不写入，未选中的角色不出现。
 */

type Properties = readonly (readonly [property: string, value: string])[];
type Roles = readonly (readonly [
  role: string,
  artifactId: string,
  address: string,
])[];

const usageContext = "asset.ordinary";

/** 正式读取会表达的负向事实：确定缺失的属性、缺失的角色与同级冲突。 */
type DescriptionExtras = {
  readonly missingProperties?: readonly string[];
  readonly missingArtifactRoles?: readonly string[];
  readonly conflicts?: EffectiveDescriptionRead["conflicts"];
  /**
   * 本次读取的请求选择器。正式读取只有在 requested 范围里才把未解析属性写成确定缺失，
   * all-available 范围不产生缺失项，因此确定缺失的夹具必须给出它真正请求的坐标集。
   */
  readonly requestedMetadata?: readonly string[];
};

function description(
  target: EffectiveDescriptionRead["target"],
  properties: Properties,
  roles: Roles,
  extras: DescriptionExtras = {},
): EffectiveDescriptionRead {
  const owner =
    target.kind === "entity"
      ? target.entityId
      : `${target.artifactId}-${target.revisionId}`;
  // 正式生效读取按属性分组：同一属性的全部选中值进入该项的 result.values。
  type ResolvedValues = Extract<
    EffectiveDescriptionRead["metadata"][number]["result"],
    { status: "resolved" }
  >["values"];
  const valuesByProperty = new Map<string, ResolvedValues>();
  for (const [property, value] of properties) {
    const selected = valuesByProperty.get(property) ?? [];
    selected.push({
      property,
      value,
      sourceIdentity: "synthetic",
      sourceSlot: property,
      reasoning: { kind: "unranked-source-assertion" },
      assertions: [
        {
          target,
          sourceSlot: property,
          sourceRecordIds: [`record-${owner}`],
        },
      ],
      sourceRecordIds: [`record-${owner}`],
    });
    valuesByProperty.set(property, selected);
  }
  const conflictsByProperty = new Map(
    (extras.conflicts ?? [])
      .filter((conflict) => conflict.property !== undefined)
      .map((conflict) => [conflict.property!, conflict]),
  );
  // 正式读取把同级冲突表达为该属性项的 conflict 结果，而不是再另列一个已解决值。
  const metadata = [...valuesByProperty.entries()].map(
    ([property, values]): EffectiveDescriptionRead["metadata"][number] => {
      const conflict = conflictsByProperty.get(property);
      return {
        property,
        result:
          conflict === undefined
            ? { status: "resolved", values }
            : { status: "conflict", conflict },
      };
    },
  );
  for (const property of extras.missingProperties ?? []) {
    if (valuesByProperty.has(property) || conflictsByProperty.has(property))
      continue;
    metadata.push({ property, result: { status: "missing" } });
  }
  return {
    target,
    metadataUsageContext: usageContext,
    metadataScope:
      extras.requestedMetadata === undefined
        ? { kind: "all-available" }
        : { kind: "requested", selectors: [...extras.requestedMetadata] },
    metadata,
    artifactRoles: roles.map(
      ([role, artifactId, address]) =>
        ({
          role,
          artifactId,
          associationIds: [`association-${owner}-${role}-${artifactId}`],
          address,
        }) satisfies EffectiveDescriptionRead["artifactRoles"][number],
    ),
    missingArtifactRoles: [...(extras.missingArtifactRoles ?? [])],
    conflicts: [...(extras.conflicts ?? [])],
  };
}

/** 实体目标的当前生效描述；封面等作品级角色读在这里。 */
export function entityDescription(
  entityId: string,
  properties: Properties = [],
  roles: Roles = [],
  extras: DescriptionExtras = {},
): EffectiveDescriptionRead {
  return description({ kind: "entity", entityId }, properties, roles, extras);
}

/** 修订版本地描述；文件页图片等材料角色读在这里，只服务该精确修订版。 */
export function revisionDescription(
  artifactId: string,
  revisionId: string,
  properties: Properties = [],
  roles: Roles = [],
  extras: DescriptionExtras = {},
): EffectiveDescriptionRead {
  return description(
    { kind: "artifact-revision", artifactId, revisionId },
    properties,
    roles,
    extras,
  );
}

/** 当前观察位置；只有确认了精确修订版的内容才携带可下载的 revisionId。 */
export function viewLocation(input: {
  readonly id: string;
  readonly artifactId: string;
  readonly kind: "managed" | "observed";
  readonly address: string;
  readonly confirmedRevisionId?: string;
}): EffectiveSubjectRead["locations"][number] {
  return {
    id: input.id,
    artifactId: input.artifactId,
    kind: input.kind,
    address: input.address,
    content:
      input.confirmedRevisionId === undefined
        ? { status: "unconfirmed" }
        : {
            status: "confirmed",
            target: {
              kind: "artifact-revision",
              artifactId: input.artifactId,
              revisionId: input.confirmedRevisionId,
            },
          },
  };
}

export function relatedEntity(input: {
  readonly id: string;
  readonly label: string;
  readonly sourceIdentity: string;
  readonly identityNamespace: string;
  readonly sourceKey: string;
}): AssetViewFacts["relatedEntities"][number] {
  return {
    id: input.id,
    label: input.label,
    kind: { status: "ordinary" },
    sourceIdentity: input.sourceIdentity,
    identityNamespace: input.identityNamespace,
    sourceKey: input.sourceKey,
  };
}

export function viewRelationship(
  id: string,
  type: string,
  participants: readonly (readonly [entityId: string, role: string])[],
  qualifiers?: readonly { readonly key: string; readonly value: string }[],
): AssetViewFacts["relationships"][number] {
  return {
    id,
    type,
    participants: participants.map(([entityId, role]) => ({ entityId, role })),
    sourceRecordIds: [`record-${id}`],
    ...(qualifiers === undefined ? {} : { qualifiers }),
  };
}

/** 补满现行读取契约的空集合，让每个用例只书写它真正断言的事实。 */
export function viewFacts(
  input: Omit<Partial<AssetViewFacts>, "id"> & { readonly id: string },
): AssetViewFacts {
  return {
    sourceAssociations: [],
    descriptions: [],
    relatedEntities: [],
    relationships: [],
    locations: [],
    ...input,
  } as AssetViewFacts;
}
