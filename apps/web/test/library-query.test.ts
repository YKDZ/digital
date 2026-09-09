import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runProduct } from "@digital/composition";
import { createWebDelivery } from "@digital/web-delivery";
import { expect, it } from "vitest";

import { prepareWebProductData } from "./prepare-catalogue";

/** 用保留的来源事实准备目录；断言始终经过真实产品 HTTP 查询。 */
function seedContent(
  database: DatabaseSync,
  id: string,
  title: string,
  book: boolean,
) {
  const record = `record-${id}`;
  const address = `https://source.invalid/${id}`;
  const metadata = [
    { property: "asset.title", value: title },
    ...(book
      ? [
          { property: "book.isbn-13", value: "9784000000000" },
          { property: "book.contributor", value: "林一" },
        ]
      : []),
  ].map((item) => ({
    ...item,
    sourceSlot: item.property,
    sourceRecordIds: [record],
  }));
  const basis = {
    kind: "source-interpretation",
    interpretation: {
      id: `interpretation-${id}`,
      producer: {
        capabilityId: "fixture",
        capabilityVersion: "1",
        contractVersion: "1",
      },
      sourceIdentity: "fixture",
      sourceAddress: address,
      sourceRecordIds: [record],
      metadata,
      sourceArtifacts: [],
    },
  };
  database
    .prepare("INSERT INTO entities (id, kind) VALUES (?, 'digital-asset')")
    .run(id);
  database
    .prepare(
      "INSERT INTO recognition_proposals (id, execution_id, basis_json, rule_results_json) VALUES (?, ?, ?, '[]')",
    )
    .run(`proposal-${id}`, `execution-${id}`, JSON.stringify(basis));
  database
    .prepare(
      "INSERT INTO recognition_decisions (id, proposal_id, asset_id, accepted_rule_results_json) VALUES (?, ?, ?, '[]')",
    )
    .run(`decision-${id}`, `proposal-${id}`, id);
  database
    .prepare(
      "INSERT INTO source_associations (id, subject_id, source_identity, native_address) VALUES (?, ?, 'fixture', ?)",
    )
    .run(`association-${id}`, id, address);
  database
    .prepare(
      "INSERT INTO source_association_establishment_supports (association_id, recognition_decision_id) VALUES (?, ?)",
    )
    .run(`association-${id}`, `decision-${id}`);
  database
    .prepare(
      "INSERT INTO current_source_associations (subject_id, association_id) VALUES (?, ?)",
    )
    .run(id, `association-${id}`);
  database
    .prepare(
      "INSERT INTO recognition_heads (subject_id, recognition_decision_id, recognition_source_association_id) VALUES (?, ?, ?)",
    )
    .run(id, `decision-${id}`, `association-${id}`);
  database
    .prepare(
      "INSERT INTO source_records (id, execution_id, source_identity, native_address, media_type, acquired_at, acquisition_json, coverage_json, digest, body) VALUES (?, ?, 'fixture', ?, 'application/json', '2026-09-05T00:00:00Z', '{}', '{}', 'fixture', '{}')",
    )
    .run(record, `execution-${id}`, address);
  for (const item of metadata) {
    const result = database
      .prepare(
        "INSERT INTO metadata_assertions (subject_id, property, value, source_record_ids_json, source_slot) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        id,
        item.property,
        item.value,
        JSON.stringify([record]),
        item.sourceSlot,
      );
    database
      .prepare(
        "INSERT INTO metadata_assertion_lifecycles (assertion_id, source_identity, native_address, coverage_id, source_slot, source_record_id) VALUES (?, 'fixture', ?, 'complete', ?, ?)",
      )
      .run(result.lastInsertRowid, address, item.sourceSlot, record);
  }
}

it("在全库筛选创作者和浏览类别后按名称分页，不受首批内容或标识符顺序限制", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-disposable-library-query-"),
  );
  let close: (() => Promise<void>) | undefined;
  try {
    await prepareWebProductData(root);
    const database = new DatabaseSync(path.join(root, "catalogue.sqlite"));
    try {
      seedContent(database, "a-later-title", "紫色的书", true);
      seedContent(database, "b-unclassified", "其他内容", false);
      seedContent(database, "z-first-title", "白色的书", true);
    } finally {
      database.close();
    }
    const product = runProduct(
      { productDataDirectory: root, environment: {} },
      { start: createWebDelivery },
    );
    close = () => product.close();
    const response = await product.result.api.request(
      "/catalogue?surface=current-catalogue&sort=name&category=book&q=林一&limit=1",
    );
    expect(response.status).toBe(200);
    const first = await response.json();
    expect(first).toMatchObject({
      total: 2,
      assets: [{ id: "z-first-title", title: "白色的书" }],
    });
    const second = await product.result.api.request(
      `/catalogue?surface=current-catalogue&sort=name&category=book&q=林一&limit=1&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
    );
    expect(await second.json()).toMatchObject({
      total: 2,
      assets: [{ id: "a-later-title", title: "紫色的书" }],
      pagination: {},
    });
    const detail = await product.result.api.request("/catalogue/z-first-title");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      asset: { id: "z-first-title", title: "白色的书" },
    });
    const recent = await product.result.api.request(
      "/catalogue?surface=current-catalogue&sort=recent&limit=2",
    );
    expect(await recent.json()).toMatchObject({
      total: 3,
      assets: [{ id: "z-first-title" }, { id: "b-unclassified" }],
    });
    const empty = await product.result.api.request(
      "/catalogue?surface=current-catalogue&sort=name&q=不存在",
    );
    expect(await empty.json()).toMatchObject({
      total: 0,
      assets: [],
      pagination: {},
    });
    const wrongQuery = await product.result.api.request(
      `/catalogue?surface=current-catalogue&sort=recent&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
    );
    expect(wrongQuery.status).toBe(400);
    expect(
      (
        await product.result.api.request(
          "/catalogue?surface=current-catalogue&sort=name&category=unknown",
        )
      ).status,
    ).toBe(400);
    expect(
      (await product.result.api.request("/catalogue/missing-subject")).status,
    ).toBe(404);
  } finally {
    await close?.();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
