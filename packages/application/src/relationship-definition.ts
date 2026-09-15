import type { EntityRelationship } from "@digital/domain";

/** 来源或格式模块提供的关系说明；类型含义由声明方持有。 */
export type RelationshipTypeDefinition = {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly roles: readonly {
    readonly role: string;
    readonly label: string;
    readonly minimum: number;
    readonly maximum?: number;
  }[];
  /** 部分格式保留原生署名角色；这不允许另造关系类型。 */
  readonly additionalRoles?: { readonly label: string };
  readonly qualifiers: readonly {
    readonly key: string;
    readonly label: string;
  }[];
};

/** 自动解释与人工提交均按声明校验参与结构和限定项。 */
export function validateRelationshipDefinition(
  definition: RelationshipTypeDefinition,
  relationship: {
    readonly type: string;
    readonly participants: readonly { readonly role: string }[];
    readonly qualifiers?: EntityRelationship["qualifiers"];
  },
): void {
  if (relationship.type !== definition.type)
    throw new Error("关系类型与声明不一致");
  for (const role of definition.roles) {
    const count = relationship.participants.filter(
      (participant) => participant.role === role.role,
    ).length;
    if (count < role.minimum)
      throw new Error(`关系缺少必需角色：${role.label}`);
    if (role.maximum !== undefined && count > role.maximum)
      throw new Error(`关系角色数量超出要求：${role.label}`);
  }
  if (
    definition.additionalRoles === undefined &&
    relationship.participants.some(
      (participant) =>
        !definition.roles.some((role) => role.role === participant.role),
    )
  )
    throw new Error("关系包含未声明的角色");
  if (
    relationship.qualifiers?.some(
      (qualifier) =>
        !definition.qualifiers.some(
          (declared) => declared.key === qualifier.key,
        ),
    )
  )
    throw new Error("关系包含未声明的限定项");
}

/** 新生成的自动事实共用人工规则；历史读取不调用此验证。 */
export function validateDeclaredRelationships(
  definitions: readonly RelationshipTypeDefinition[],
  relationships: readonly {
    readonly type: string;
    readonly subjectRole?: string;
    readonly participants: readonly { readonly role: string }[];
    readonly qualifiers?: EntityRelationship["qualifiers"];
  }[],
): void {
  for (const relationship of relationships) {
    const candidates = definitions.filter(
      ({ type }) => type === relationship.type,
    );
    if (candidates.length === 0) throw new Error("关系类型尚未声明");
    let failure: unknown;
    for (const definition of candidates) {
      try {
        validateRelationshipDefinition(definition, {
          ...relationship,
          participants: [
            ...relationship.participants,
            ...(relationship.subjectRole === undefined
              ? []
              : [{ role: relationship.subjectRole }]),
          ],
        });
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
      }
    }
    if (failure !== undefined) throw failure;
  }
}
