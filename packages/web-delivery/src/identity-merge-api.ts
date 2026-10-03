import type { EntityIdentityMergePreview } from "@digital/application";
import type { ProductWorkflowOperations } from "@digital/product-application";
import { Hono } from "hono";

type EffectiveKind = EntityIdentityMergePreview["effectiveKind"];
type Metadata = EntityIdentityMergePreview["metadata"][number];
type Conflict = EntityIdentityMergePreview["metadataConflicts"][number];

/** 只做 HTTP 输入转换；影响预演、采用与撤销始终走共用产品操作。 */
export function createIdentityMergeApi(
  workflow: () => ProductWorkflowOperations,
): Hono {
  return new Hono()
    .onError((error, c) => c.json({ error: identityErrorMessage(error) }, 400))
    .post("/preview", async (c) => {
      const input = object(await c.req.json());
      return c.json(
        await workflow().previewEntityIdentityMerge({
          retainedEntityId: text(input.retainedEntityId),
          mergedEntityId: text(input.mergedEntityId),
        }),
      );
    })
    .post("/apply", async (c) => {
      const input = object(await c.req.json());
      const status = await workflow().applyEntityIdentityMerge({
        commitmentId: text(input.commitmentId),
        actorId: text(input.actorId),
        preview: parsePreview(input.preview),
      });
      return c.json({ status }, status === "stale" ? 409 : 200);
    })
    .post("/undo", async (c) => {
      const input = object(await c.req.json());
      const status = await workflow().undoEntityIdentityMerge({
        commitmentId: text(input.commitmentId),
        actorId: text(input.actorId),
        preview: parsePreview(input.preview),
      });
      return c.json({ status }, status === "stale" ? 409 : 200);
    });
}

function identityErrorMessage(error: unknown): string {
  const messages: Readonly<Record<string, string>> = {
    不能将实体合并到自身: "请选择两个不同的身份",
    待合并相关实体不存在: "所选身份已不可用，请重新选择",
    待合并相关实体不是当前身份: "所选身份已不是当前身份，请重新选择",
    数字资产不能进行身份合并: "已入库的资产不能进行身份合并",
    身份合并会使现有关系结构无效: "这次合并会让现有关系矛盾，请重新选择",
    "身份合并已经采用；请重用原提交标识": "该合并已生效，请使用原来的提交标识",
    身份合并提交坐标与既有内容冲突: "该提交标识已用于不同的合并",
    身份合并撤销提交坐标与既有内容冲突: "该撤销标识已用于不同的合并",
    当前没有可撤销的身份合并: "所选身份当前没有可撤销的合并",
    请填写完整的身份合并信息: "请填写完整的身份合并信息",
    身份合并请求无效: "身份合并请求无效",
  };
  const message = error instanceof Error ? error.message : "";
  return messages[message] ?? "身份合并操作未完成，请刷新后重试";
}

function parsePreview(value: unknown): EntityIdentityMergePreview {
  const input = object(value);
  return {
    retainedEntityId: text(input.retainedEntityId),
    mergedEntityId: text(input.mergedEntityId),
    members: strings(input.members),
    relationshipIds: strings(input.relationshipIds),
    metadata: array(input.metadata).map(metadataEntry),
    metadataConflicts: array(input.metadataConflicts).map(conflictEntry),
    metadataPolicyBaseline: text(input.metadataPolicyBaseline),
    effectiveKind: parseEffectiveKind(input.effectiveKind),
    baseline: text(input.baseline),
    ...(input.mergeId === undefined ? {} : { mergeId: text(input.mergeId) }),
  };
}

function parseEffectiveKind(value: unknown): EffectiveKind {
  const input = object(value);
  if (input.status === "ordinary") return { status: "ordinary" };
  if (input.status === "effective")
    return {
      status: "effective",
      kind: input.kind as Extract<
        EffectiveKind,
        { status: "effective" }
      >["kind"],
      basis: input.basis as Extract<
        EffectiveKind,
        { status: "effective" }
      >["basis"],
    };
  throw new Error("身份合并请求无效");
}

function metadataEntry(value: unknown): Metadata {
  const input = object(value);
  return {
    entityId: text(input.entityId),
    property: text(input.property),
    value: text(input.value),
  };
}

function conflictEntry(value: unknown): Conflict {
  const input = object(value);
  return {
    subjectId: text(input.subjectId),
    property: text(input.property),
    reason: input.reason as Conflict["reason"],
    cardinality: input.cardinality as Conflict["cardinality"],
    metadataUsageContext: text(input.metadataUsageContext),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("身份合并请求无效");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("请填写完整的身份合并信息");
  return value;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("身份合并请求无效");
  return value;
}

function strings(value: unknown): readonly string[] {
  return array(value).map(text);
}
