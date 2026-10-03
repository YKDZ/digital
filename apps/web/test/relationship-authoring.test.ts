import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { expect, it, vi } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

type Fact = {
  id: string;
  type: string;
  participants: { entityId: string; role: string }[];
  qualifiers?: { key: string; value: string }[];
  sources: unknown[];
};

async function openProduct(root: string) {
  const product = runProduct(
    { productDataDirectory: root, environment: {} },
    { start: createWebDelivery },
  );
  const request = (route: string, init?: RequestInit) =>
    product.result.api.request(`/relationships/${route}`, init);
  const post = (route: string, body: unknown) =>
    request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const json = async (response: Response) => await response.json();
  const entity = async (commitmentId: string, label: string) =>
    await json(
      await post("entities", {
        commitmentId,
        label,
        actorId: "reader",
      }),
    );
  const facts = async (id: string): Promise<Fact[]> =>
    ((await json(await request(`entities/${id}`))) as { relationships: Fact[] })
      .relationships;
  const positions = (relationships: readonly Fact[]) =>
    relationships
      .filter(({ type }) => type === "asset.membership")
      .map(({ participants, qualifiers, sources }) => ({
        parties: participants.length,
        position: qualifiers?.[0]?.value ?? "",
        sources: sources.length,
      }))
      .toSorted(
        (left, right) =>
          left.parties - right.parties ||
          left.position.localeCompare(right.position),
      );
  const decide = async (
    changes: readonly unknown[],
  ): Promise<{ status: number; body: unknown }> => {
    const response = await post("apply", {
      actorId: "reader",
      preview: await json(await post("preview", { changes })),
    });
    return { status: response.status, body: await json(response) };
  };
  return {
    close: () => product.close(),
    json,
    request,
    post,
    entity,
    facts,
    positions,
    decide,
  };
}

it("Web 离线查询本地声明、建立参与实体、预演及采用，并从双方反查", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-relationships-"),
  );
  await prepareWebProductData(root);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("离线"));
  let product = await openProduct(root);
  try {
    const types = await product.request("types");
    expect(types.status).toBe(200);
    expect(await types.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "dlsite.contribution" }),
        expect.objectContaining({ id: "fanbox.post-creation" }),
        expect.objectContaining({
          id: "epub.contribution",
          additionalRoles: { label: "署名角色" },
        }),
      ]),
    );
    for (const kind of ["person", "persona", "digital-asset", "entity"]) {
      const rejected = await product.post("entities", {
        commitmentId: "retired",
        label: "旧种类请求",
        kind,
        actorId: "reader",
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: "创建实体不需要选择种类",
      });
    }
    expect(
      await (await product.request("entities?label=旧种类请求")).json(),
    ).toEqual([]);
    const predecessor = await product.entity("first", "离线前作");
    const sequel = await product.entity("second", "离线续作");
    const search = await product.request("entities?label=离线前作");
    expect(await search.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: predecessor.id })]),
    );
    const change = {
      kind: "create",
      definitionId: "bangumi.subject-sequel",
      relationship: {
        type: "bangumi.subject.related",
        participants: [
          { entityId: predecessor.id, role: "bangumi.subject.predecessor" },
          { entityId: sequel.id, role: "bangumi.subject.sequel" },
        ],
      },
    };
    const response = await product.post("preview", { changes: [change] });
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(
      (await product.post("apply", { actorId: "reader", preview })).status,
    ).toBe(200);
    const fromFirst = await product.facts(predecessor.id);
    expect(fromFirst).toMatchObject([
      { type: "bangumi.subject.related", sources: [] },
    ]);
    await product.close();
    product = await openProduct(root);
    expect(await product.facts(sequel.id)).toEqual(fromFirst);
    const invalid = await product.post("preview", {
      changes: [{ ...change, definitionId: "unknown" }],
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "所选关系类型暂不可用" });
    const malformed = await product.post("preview", {
      changes: [
        {
          ...change,
          relationship: { ...change.relationship, participants: null },
        },
      ],
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "关系操作未完成，请刷新后重试",
    });
    expect(
      (
        await product.post("preview", {
          changes: [
            {
              kind: "create",
              definitionId: "bangumi.subject-sequel",
              relationship: {
                ...change.relationship,
                participants: [
                  ...change.relationship.participants,
                  {
                    entityId: predecessor.id,
                    role: "bangumi.subject.predecessor",
                  },
                ],
              },
            },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await product.request("entities/missing")).status).toBe(404);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await product.close();
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("Web 正式入口按被点名事实决定多方关系，独立事实不被压制且排除、更正、清除与重开一致", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-relationship-targets-"),
  );
  await prepareWebProductData(root);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("离线"));
  let product = await openProduct(root);
  try {
    const declared = (await product.json(await product.request("types"))) as {
      id: string;
      roles?: { role: string }[];
    }[];
    const contribution = declared.find(
      ({ id }) => id === "dlsite.contribution",
    )!;
    const membership = declared.find(
      ({ id }) => id === "dlsite.series-membership",
    )!;
    const entities = await Promise.all([
      product.entity("work", "被点名作品""),
      product.entity("series", "被点名系列""),
      product.entity("circle", "被点名社团""),
      product.entity("voice", "被点名声优""),
      product.entity("scenario", "被点名脚本""),
    ]);
    const [work, series, circle, voice, scenario] = entities;
    expect(contribution.roles!.map(({ role }) => role)).toEqual(
      expect.arrayContaining(["asset", "circle", "voice", "scenario"]),
    );
    expect(membership.roles!.map(({ role }) => role)).toEqual(
      expect.arrayContaining(["asset", "dlsite.series.member"]),
    );

    // 多方人工事实：五个已声明角色各自保留，从每一位参与者都能反查同一项完整事实。
    expect(
      await product.decide([
        {
          kind: "create",
          definitionId: "dlsite.contribution",
          relationship: {
            type: "asset.contribution",
            participants: [
              { entityId: work.id, role: "asset" },
              { entityId: circle.id, role: "circle" },
              { entityId: voice.id, role: "voice" },
              { entityId: scenario.id, role: "scenario" },
              { entityId: series.id, role: "author" },
            ],
          },
        },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    const contributionViews = await Promise.all(
      entities.map(async ({ id }) =>
        (await product.facts(id)).filter(
          ({ type, participants }) =>
            type === "asset.contribution" && participants.length === 5,
        ),
      ),
    );
    expect(contributionViews).toHaveLength(5);
    const workContribution = contributionViews[0]!;
    expect(workContribution).toHaveLength(1);
    for (const view of contributionViews)
      expect(view).toEqual(workContribution);
    expect(workContribution[0]!).toMatchObject({
      sources: [],
      participants: [
        { role: "asset" },
        { role: "circle" },
        { role: "voice" },
        { role: "scenario" },
        { role: "author" },
      ],
    });

    // 同一类型与同一参与者的两项事实各自成立，后一项不再压掉前一项。
    const seriesFacts = [{ entityId: series.id, role: "dlsite.series.member" }];
    expect(
      await product.decide([
        {
          kind: "create",
          definitionId: "dlsite.series-membership",
          relationship: {
            type: "asset.membership",
            participants: [
              ...seriesFacts,
              { entityId: work.id, role: "asset" },
            ],
            qualifiers: [{ key: "asset.membership.position", value: "2" }],
          },
        },
        {
          kind: "create",
          definitionId: "dlsite.series-membership",
          relationship: {
            type: "asset.membership",
            participants: [
              ...seriesFacts,
              { entityId: work.id, role: "asset" },
            ],
            qualifiers: [{ key: "asset.membership.position", value: "5" }],
          },
        },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    const created = await product.facts(work.id);
    expect(product.positions(created)).toEqual([
      { parties: 2, position: "2", sources: 0 },
      { parties: 2, position: "5", sources: 0 },
    ]);
    expect(product.positions(await product.facts(series.id))).toEqual(
      product.positions(created),
    );
    const second = created.find(
      ({ qualifiers }) => qualifiers?.[0]?.value === "5",
    )!;
    const first = created.find(
      ({ qualifiers }) => qualifiers?.[0]?.value === "2",
    )!;

    // 排除只作用于被点名事实，另一项同坐标事实与多方署名事实都不受影响。
    expect(
      await product.decide([
        { kind: "exclude", targetRelationshipId: first.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual([
      { parties: 2, position: "5", sources: 0 },
    ]);
    expect(product.positions(await product.facts(series.id))).toEqual([
      { parties: 2, position: "5", sources: 0 },
    ]);
    expect(
      (await product.facts(circle.id)).filter(
        ({ type }) => type === "asset.membership",
      ),
    ).toHaveLength(0);
    expect(
      (await product.facts(voice.id)).filter(
        ({ type, participants }) =>
          type === "asset.contribution" && participants.length === 5,
      ),
    ).toHaveLength(1);

    // 更正只替换被点名事实，随后清除让人工事实退回其当前来源推导。
    expect(
      await product.decide([
        {
          kind: "replace",
          targetRelationshipId: second.id,
          definitionId: "dlsite.series-membership",
          relationship: {
            type: "asset.membership",
            participants: [
              ...seriesFacts,
              { entityId: work.id, role: "asset" },
            ],
            qualifiers: [{ key: "asset.membership.position", value: "6" }],
          },
        },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual([
      { parties: 2, position: "6", sources: 0 },
    ]);
    const replaced = (await product.facts(work.id)).find(
      ({ qualifiers }) => qualifiers?.[0]?.value === "6",
    )!;
    expect(
      await product.decide([
        { kind: "clear", targetRelationshipId: replaced.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual([]);
    // 被点名排除的事实仍在，可重新选用；多方署名事实的人工根据不被上述决定删除。
    expect(
      await product.decide([
        { kind: "select", targetRelationshipId: first.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual([
      { parties: 2, position: "2", sources: 0 },
    ]);
    expect(
      (await product.facts(voice.id)).filter(
        ({ type, participants }) =>
          type === "asset.contribution" && participants.length === 5,
      ),
    ).toHaveLength(1);

    // 陈旧预演在采用时被冲突拒绝，绝不叠加到已推进的决定之后。
    const stalePreview = await product.json(
      await product.post("preview", {
        changes: [{ kind: "exclude", targetRelationshipId: first.id }],
      }),
    );
    expect(
      await product.decide([
        { kind: "select", targetRelationshipId: first.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(
      (
        await product.post("apply", {
          actorId: "reader",
          preview: stalePreview,
        })
      ).status,
    ).toBe(409);
    expect(product.positions(await product.facts(work.id))).toEqual([
      { parties: 2, position: "2", sources: 0 },
    ]);

    await product.close();
    product = await openProduct(root);
    expect(product.positions(await product.facts(work.id))).toEqual([
      { parties: 2, position: "2", sources: 0 },
    ]);
    expect(
      (await product.facts(circle.id)).filter(
        ({ type }) => type === "asset.membership",
      ),
    ).toHaveLength(0);
    expect(
      (await product.facts(voice.id)).filter(
        ({ type, participants }) =>
          type === "asset.contribution" && participants.length === 5,
      ),
    ).toHaveLength(1);

    // 旧整体坐标合同没有产品读取路径：陈旧负载在共同边界被拒绝，不写任何决定。
    const legacyFix = await product.post("preview", {
      changes: [
        {
          kind: "fix",
          definitionId: "dlsite.series-membership",
          relationship: {
            type: "asset.membership",
            participants: [
              ...seriesFacts,
              { entityId: work.id, role: "asset" },
            ],
            qualifiers: [{ key: "asset.membership.position", value: "9" }],
          },
        },
      ],
    });
    expect(legacyFix.status).toBe(400);
    expect(await legacyFix.json()).toEqual({ error: "请选择关系操作" });
    const legacyNamed = await product.post("preview", {
      changes: [{ kind: "select", relationshipIds: [first.id] }],
    });
    expect(legacyNamed.status).toBe(400);
    expect(await legacyNamed.json()).toEqual({
      error: "请填写完整的关系信息",
    });
    expect(product.positions(await product.facts(work.id))).toEqual([
      { parties: 2, position: "2", sources: 0 },
    ]);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await product.close();
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("Web 对独立人工事实的选择只看被点名的当前替代，多次更正与重开语义一致", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-web-manual-select-"),
  );
  await prepareWebProductData(root);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("离线"));
  let product = await openProduct(root);
  try {
    const [work, series] = await Promise.all([
      product.entity("manual-work", "人工选择作品""),
      product.entity("manual-series", "人工选择系列""),
    ]);
    const membership = [{ entityId: series.id, role: "dlsite.series.member" }];
    const draft = (position: string) => ({
      kind: "create" as const,
      definitionId: "dlsite.series-membership",
      relationship: {
        type: "asset.membership",
        participants: [...membership, { entityId: work.id, role: "asset" }],
        qualifiers: [{ key: "asset.membership.position", value: position }],
      },
    });
    const locate = async (position: string) =>
      (await product.facts(work.id)).find(
        ({ qualifiers }) => qualifiers?.[0]?.value === position,
      )!;
    const only = (position: string) => [{ parties: 2, position, sources: 0 }];

    expect(await product.decide([draft("2")])).toEqual({
      status: 200,
      body: { status: "applied" },
    });
    const created = await locate("2");
    // 更正把同一人工目标改写到新事实，被更正的一项退为该目标下的人工历史。
    expect(
      await product.decide([
        { ...draft("7"), kind: "replace", targetRelationshipId: created.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    const replaced = await locate("7");
    expect(replaced.id).not.toBe(created.id);
    expect(product.positions(await product.facts(work.id))).toEqual(only("7"));

    // 对当前替代事实的选择只让被点名那一项生效，既不复活被更正项也不返回全部历史。
    expect(
      await product.decide([
        { kind: "select", targetRelationshipId: replaced.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual(only("7"));
    // 重复同一次选择只推进决定头，结果仍是单项当前事实。
    expect(
      await product.decide([
        { kind: "select", targetRelationshipId: replaced.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual(only("7"));
    expect(product.positions(await product.facts(series.id))).toEqual(
      only("7"),
    );

    // 再次更正、排除、选择逐项推进，任一时刻都只有一项当前事实。
    expect(
      await product.decide([
        { ...draft("8"), kind: "replace", targetRelationshipId: replaced.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    const latest = await locate("8");
    expect(product.positions(await product.facts(work.id))).toEqual(only("8"));
    expect(
      await product.decide([
        { kind: "exclude", targetRelationshipId: latest.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual([]);
    expect(
      await product.decide([
        { kind: "select", targetRelationshipId: latest.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual(only("8"));

    // 一次预演批量作用在两个相互独立的人工目标上，仍各自只按被点名事实生效。
    const [workB, seriesB] = await Promise.all([
      product.entity("manual-work-b", "人工批量作品""),
      product.entity("manual-series-b", "人工批量系列""),
    ]);
    const batchCreate = {
      kind: "create" as const,
      definitionId: "dlsite.series-membership",
      relationship: {
        type: "asset.membership",
        participants: [
          { entityId: seriesB.id, role: "dlsite.series.member" },
          { entityId: workB.id, role: "asset" },
        ],
        qualifiers: [{ key: "asset.membership.position", value: "1" }],
      },
    };
    expect(await product.decide([batchCreate])).toEqual({
      status: 200,
      body: { status: "applied" },
    });
    const batchFact = (await product.facts(workB.id))[0]!;
    expect(product.positions(await product.facts(workB.id))).toEqual(only("1"));
    expect(
      await product.decide([
        { kind: "exclude", targetRelationshipId: latest.id },
        { kind: "select", targetRelationshipId: batchFact.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual([]);
    expect(product.positions(await product.facts(workB.id))).toEqual(only("1"));
    expect(
      await product.decide([
        { kind: "select", targetRelationshipId: latest.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual(only("8"));

    // 陈旧预演在决定推进后被拒绝，绝不叠加到最新结果之上。
    const stalePreview = await product.json(
      await product.post("preview", {
        changes: [{ kind: "exclude", targetRelationshipId: latest.id }],
      }),
    );
    expect(
      await product.decide([
        { ...draft("9"), kind: "replace", targetRelationshipId: latest.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    const newest = await locate("9");
    expect(
      (
        await product.post("apply", {
          actorId: "reader",
          preview: stalePreview,
        })
      ).status,
    ).toBe(409);
    expect(product.positions(await product.facts(work.id))).toEqual(only("9"));

    // 人工目标没有来源事实：清除后仍为空，但人工历史保留并可再次选择。
    expect(
      await product.decide([
        { kind: "clear", targetRelationshipId: newest.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual([]);
    expect(
      await product.decide([
        { kind: "select", targetRelationshipId: newest.id },
      ]),
    ).toEqual({ status: 200, body: { status: "applied" } });
    expect(product.positions(await product.facts(work.id))).toEqual(only("9"));

    await product.close();
    product = await openProduct(root);
    expect(product.positions(await product.facts(work.id))).toEqual(only("9"));
    expect(product.positions(await product.facts(series.id))).toEqual(
      only("9"),
    );
    expect(network).not.toHaveBeenCalled();
  } finally {
    await product.close();
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
