import { expect, it, vi } from "vitest";

import { createPublicApiClient, PublicApiClientError } from "../src/index.ts";

it("通过同一公共客户端读写关系、指称解析和身份合并", async () => {
  const relatedEntity = {
    id: "entity-1",
    label: "G 线上的牡丹雪",
    kind: { status: "ordinary" },
    identity: "source",
  } as const;
  const relationshipPreview = {
    baseline: "relationship-baseline",
    changes: [
      {
        kind: "create",
        definitionId: "dlsite.contribution",
        relationship: {
          type: "asset.contribution",
          participants: [
            { entityId: "asset-1", role: "asset" },
            { entityId: "entity-1", role: "circle" },
          ],
        },
      },
    ],
    relationships: [
      {
        id: "relationship-1",
        type: "asset.contribution",
        participants: [
          { entityId: "asset-1", role: "asset" },
          { entityId: "entity-1", role: "circle" },
        ],
        sources: [],
      },
    ],
  } as const;
  const mentionResolution = {
    mentionId: "mention-1",
    label: "待确认声优",
    entityId: "entity-1",
    basis: "manual",
    decisionId: "resolution-1",
    actorId: "tester",
    sourceRecordIds: ["source-record-1"],
    baseline: "mention-baseline",
  } as const;
  const mergePreview = {
    retainedEntityId: "entity-1",
    mergedEntityId: "entity-2",
    members: ["entity-1", "entity-2"],
    relationshipIds: ["relationship-1"],
    metadata: [],
    metadataConflicts: [],
    metadataPolicyBaseline: "metadata-baseline",
    effectiveKind: { status: "ordinary" },
    baseline: "merge-baseline",
    mergeId: "merge-1",
  } as const;
  const responses: unknown[] = [
    [
      {
        id: "dlsite.contribution",
        type: "asset.contribution",
        label: "DLsite 创作署名",
        roles: [
          { role: "asset", label: "作品", minimum: 1, maximum: 1 },
          { role: "circle", label: "社团", minimum: 0 },
        ],
        qualifiers: [],
      },
    ],
    [relatedEntity],
    {
      entity: relatedEntity,
      relationships: [],
      metadata: [],
      metadataConflicts: [],
      accepted: [],
    },
    relatedEntity,
    relationshipPreview,
    { status: "applied" },
    mentionResolution,
    { status: "applied" },
    { status: "applied" },
    mergePreview,
    { status: "applied" },
    { status: "applied" },
  ];
  const requests: Array<{
    readonly url: string;
    readonly method: string;
    readonly body?: unknown;
  }> = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const responseBody = responses[requests.length];
      requests.push({
        url:
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input,
        method: init?.method ?? "GET",
        ...(typeof init?.body !== "string"
          ? {}
          : { body: JSON.parse(init.body) }),
      });
      return Response.json(responseBody);
    },
  );
  const client = createPublicApiClient({
    baseUrl: "http://127.0.0.1:4321",
    fetch,
  });

  await expect(client.listRelationshipTypeDefinitions()).resolves.toHaveLength(
    1,
  );
  await expect(client.findRelatedEntities("G 线上的牡丹雪")).resolves.toEqual([
    relatedEntity,
  ]);
  await expect(client.inspectRelatedEntity("entity-1")).resolves.toMatchObject({
    entity: { id: "entity-1" },
  });
  await expect(
    client.createLocalRelatedEntity({
      commitmentId: "local-entity-1",
      label: "本地身份",
      actorId: "tester",
    }),
  ).resolves.toEqual(relatedEntity);
  const preview = await client.previewRelationshipChange({
    changes: relationshipPreview.changes,
  });
  await expect(
    client.applyRelationshipChange({ actorId: "tester", preview }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.inspectEntityMentionResolution("mention-1"),
  ).resolves.toEqual(mentionResolution);
  await expect(
    client.resolveEntityMentionManually({
      mentionId: "mention-1",
      entityId: "entity-1",
      actorId: "tester",
      baseline: "mention-baseline",
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.retractEntityMentionResolution({
      mentionId: "mention-1",
      actorId: "tester",
      baseline: "mention-baseline",
    }),
  ).resolves.toEqual({ status: "applied" });
  const identityPreview = await client.previewEntityIdentityMerge({
    retainedEntityId: "entity-1",
    mergedEntityId: "entity-2",
  });
  await expect(
    client.applyEntityIdentityMerge({
      commitmentId: "merge-commitment",
      actorId: "tester",
      preview: identityPreview,
    }),
  ).resolves.toEqual({ status: "applied" });
  await expect(
    client.undoEntityIdentityMerge({
      commitmentId: "merge-retraction",
      actorId: "tester",
      preview: identityPreview,
    }),
  ).resolves.toEqual({ status: "applied" });

  expect(requests.map(({ url, method }) => [method, url])).toEqual([
    ["GET", "http://127.0.0.1:4321/api/v1/relationships/types"],
    [
      "GET",
      "http://127.0.0.1:4321/api/v1/relationships/entities?label=G+%E7%BA%BF%E4%B8%8A%E7%9A%84%E7%89%A1%E4%B8%B9%E9%9B%AA",
    ],
    ["GET", "http://127.0.0.1:4321/api/v1/relationships/entities/entity-1"],
    ["POST", "http://127.0.0.1:4321/api/v1/relationships/entities"],
    ["POST", "http://127.0.0.1:4321/api/v1/relationships/preview"],
    ["POST", "http://127.0.0.1:4321/api/v1/relationships/apply"],
    [
      "GET",
      "http://127.0.0.1:4321/api/v1/entity-mentions/mention-1/resolution",
    ],
    [
      "POST",
      "http://127.0.0.1:4321/api/v1/entity-mentions/mention-1/resolution",
    ],
    [
      "DELETE",
      "http://127.0.0.1:4321/api/v1/entity-mentions/mention-1/resolution",
    ],
    ["POST", "http://127.0.0.1:4321/api/v1/identity/preview"],
    ["POST", "http://127.0.0.1:4321/api/v1/identity/apply"],
    ["POST", "http://127.0.0.1:4321/api/v1/identity/undo"],
  ]);
  expect(requests[3]?.body).toEqual({
    commitmentId: "local-entity-1",
    label: "本地身份",
    actorId: "tester",
  });
  expect(requests[5]?.body).toEqual({ actorId: "tester", preview });
  expect(requests[10]?.body).toEqual({
    commitmentId: "merge-commitment",
    actorId: "tester",
    preview: identityPreview,
  });
});

it("把过期关系修改作为公共冲突返回调用方", async () => {
  const client = createPublicApiClient({
    baseUrl: "http://127.0.0.1:4321",
    fetch: async () =>
      Response.json(
        { error: { code: "conflict", message: "关系预演已过期，请重新检查" } },
        { status: 409 },
      ),
  });

  const result = client.applyRelationshipChange({
    actorId: "tester",
    preview: {
      baseline: "stale",
      changes: [
        {
          kind: "select",
          targetRelationshipId: "relationship-1",
        },
      ],
      relationships: [],
    },
  });

  await expect(result).rejects.toBeInstanceOf(PublicApiClientError);
  await expect(result).rejects.toMatchObject({ kind: "conflict", status: 409 });
});
