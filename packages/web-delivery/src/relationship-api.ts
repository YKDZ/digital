import type { RelationshipChange } from "@digital/application";
import type { ProductWorkflowOperations } from "@digital/product-application";
import { Hono } from "hono";

/** 只做 HTTP 输入转换；声明、预演和采用始终走共用产品操作。 */
export function createRelationshipApi(
  workflow: () => ProductWorkflowOperations,
): Hono {
  return new Hono()
    .onError((error, c) =>
      c.json({ error: relationshipErrorMessage(error) }, 400),
    )
    .get("/types", (c) => c.json(workflow().relationshipTypeDefinitions()))
    .get("/entities", async (c) =>
      c.json(await workflow().findRelatedEntities(text(c.req.query("label")))),
    )
    .get("/entities/:id", async (c) => {
      const entity = await workflow().inspectCurrentCatalogueEntity(
        c.req.param("id"),
      );
      return entity === undefined
        ? c.json({ error: "找不到这项内容" }, 404)
        : c.json(entity);
    })
    .post("/entities", async (c) => {
      const input = object(await c.req.json());
      if (
        input.kind !== "entity" &&
        input.kind !== "person" &&
        input.kind !== "persona"
      )
        throw new Error("请选择实体种类");
      return c.json(
        await workflow().createLocalRelatedEntity({
          commitmentId: text(input.commitmentId),
          label: text(input.label),
          kind: input.kind,
          actorId: text(input.actorId),
        }),
      );
    })
    .post("/preview", async (c) => {
      const input = object(await c.req.json());
      return c.json(
        await workflow().previewRelationshipChange({
          changes: changes(input.changes),
        }),
      );
    })
    .post("/apply", async (c) => {
      const input = object(await c.req.json());
      const preview = object(input.preview);
      const status = await workflow().applyRelationshipChange({
        actorId: text(input.actorId),
        preview: {
          baseline: text(preview.baseline),
          changes: changes(preview.changes),
          relationships: [],
        },
      });
      return c.json({ status }, status === "stale" ? 409 : 200);
    });
}

function relationshipErrorMessage(error: Error): string {
  const messages: Readonly<Record<string, string>> = {
    关系类型尚未声明: "所选关系类型暂不可用",
    关系类型与声明不一致: "请重新选择关系类型",
    关系包含未声明的角色: "请选择适用的参与角色",
    关系包含未声明的限定项: "请重新检查补充信息",
    更正关系引用了不存在的实体: "所选内容已不可用，请重新选择",
    更正关系不能为空: "请先选择需要调整的关系",
    更正关系必须包含类型和参与者: "请选择关系类型和参与者",
    更正关系结构无效: "请检查参与者和补充信息",
    请填写完整的关系信息: "请填写完整的关系信息",
    请选择实体种类: "请选择实体种类",
    请选择关系操作: "请选择关系操作",
  };
  if (error.message.startsWith("关系缺少必需角色："))
    return "请补全关系所需的参与者";
  if (error.message.startsWith("关系角色数量超出要求："))
    return "请检查每个角色的参与者数量";
  return messages[error.message] ?? "关系操作未完成，请刷新后重试";
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("关系请求无效");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("请填写完整的关系信息");
  return value;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("关系请求无效");
  return value;
}

function changes(value: unknown): readonly RelationshipChange[] {
  return array(value).map((value): RelationshipChange => {
    const input = object(value);
    if (input.kind === "fix") {
      const relationship = object(input.relationship);
      return {
        kind: "fix",
        definitionId: text(input.definitionId),
        ...(input.relationshipIds === undefined
          ? {}
          : { relationshipIds: array(input.relationshipIds).map(text) }),
        relationship: {
          type: text(relationship.type),
          participants: array(relationship.participants).map((value) => {
            const participant = object(value);
            return {
              entityId: text(participant.entityId),
              role: text(participant.role),
            };
          }),
          ...(relationship.qualifiers === undefined
            ? {}
            : {
                qualifiers: array(relationship.qualifiers).map((value) => {
                  const qualifier = object(value);
                  return {
                    key: text(qualifier.key),
                    value: text(qualifier.value),
                  };
                }),
              }),
        },
      };
    }
    if (
      input.kind !== "select" &&
      input.kind !== "exclude" &&
      input.kind !== "clear"
    )
      throw new Error("请选择关系操作");
    return {
      kind: input.kind,
      relationshipIds: array(input.relationshipIds).map(text),
    };
  });
}
