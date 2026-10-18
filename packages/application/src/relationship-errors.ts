/** 已知关系输入不符合产品声明或当前允许的操作。 */
export class InvalidRelationshipOperation extends Error {
  constructor(message = "关系操作无效") {
    super(message);
    this.name = "InvalidRelationshipOperation";
  }
}

/** 请求点名的关系事实或关联实体已不存在。 */
export class RelationshipTargetNotFound extends Error {
  constructor(message = "关系目标不存在") {
    super(message);
    this.name = "RelationshipTargetNotFound";
  }
}

/** 请求点名的关联实体不存在或已不再可操作。 */
export class RelatedEntityNotFound extends Error {
  constructor(message = "关联实体不存在") {
    super(message);
    this.name = "RelatedEntityNotFound";
  }
}

/** 请求点名的实体指称不存在。 */
export class EntityMentionNotFound extends Error {
  constructor(message = "实体指称不存在") {
    super(message);
    this.name = "EntityMentionNotFound";
  }
}

/** 身份操作的结构、来源目标或提交坐标不符合现有业务约束。 */
export class InvalidIdentityOperation extends Error {
  constructor(message = "身份操作无效") {
    super(message);
    this.name = "InvalidIdentityOperation";
  }
}

/** 身份或关系操作与已经发生的业务事实冲突。 */
export class CatalogueDecisionConflict extends Error {
  constructor(message = "当前业务事实与请求冲突") {
    super(message);
    this.name = "CatalogueDecisionConflict";
  }
}
