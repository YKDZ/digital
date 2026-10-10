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

function description(
  target: EffectiveDescriptionRead["target"],
  properties: Properties,
  roles: Roles,
): EffectiveDescriptionRead {
  const owner =
    target.kind === "entity"
      ? target.entityId
      : `${target.artifactId}-${target.revisionId}`;
  const metadata = properties.map(
    ([property, value]): EffectiveDescriptionRead["metadata"][number] => ({
      property,
      result: {
        status: "resolved",
        values: [
          {
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
          },
        ],
      },
    }),
  );
  return {
    target,
    metadataUsageContext: usageContext,
    metadataScope: { kind: "all-available" },
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
    missingArtifactRoles: [],
    conflicts: [],
  };
}

/** 实体目标的当前生效描述；封面等作品级角色读在这里。 */
export function entityDescription(
  entityId: string,
  properties: Properties = [],
  roles: Roles = [],
): EffectiveDescriptionRead {
  return description({ kind: "entity", entityId }, properties, roles);
}

/** 修订版本地描述；文件页图片等材料角色读在这里，只服务该精确修订版。 */
export function revisionDescription(
  artifactId: string,
  revisionId: string,
  properties: Properties = [],
  roles: Roles = [],
): EffectiveDescriptionRead {
  return description(
    { kind: "artifact-revision", artifactId, revisionId },
    properties,
    roles,
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
