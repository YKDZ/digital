import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  inspectProductionCatalogueReadiness,
  prepareProductionCatalogue,
} from "@digital/db-migrations";
import { readDerivedEntityCoverReadiness } from "@digital/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 旧自然错误派生实体封面的历史真实性与当前角色资格分离验证。
 *
 * fixture 是真实生产 Catalogue 归因闭包的逐列回放（多材料台本目录：track.wav + 台本
 * script.pdf），其 `asset.primary-cover` 封面由修正前的生成程序从 PDF 首页部件派生，
 * 完全没有任何代表材料依据。这里证明的是：这样的历史被严格还原后仍然完整、可重开，但
 * 绝不因此取得当前角色；而任何真实坐标错误都不会被当前观察证据臂伪造成确认。
 */

const materializationKey =
  "ed8abfd7ab1f8cf17bc5f2f5820cab3e316f624ff43c4f28160500788d2505eb";
const coverAssociationId = `artifact-association_${materializationKey}_entity-cover`;
const siblingAssociationId = `artifact-association_${materializationKey}`;
const sourceCoverAssociationId =
  "artifact-association_4224f43a746c4a9609970d1d888cf497a566d1b62471858bfeb47e73beec8e6f";
const renamedKey = "f".repeat(64);
const carrierArtifactId = "artifact_3120e1a1-244b-4fb6-a972-34800ad403dd";
const carrierRevisionId =
  "artifact-revision_c0d6b2518313a9b90aa75e287cbf9d4f478976511a74a2c3d2d68083ca08ba33";
const carrierLocationId =
  "location_651ac427419bcfb6432e4b7a97a4659858c30e1ae4092632c7812ae31416aee4";
const audioLocationId =
  "location_a915870f24ea166100fa0d812b0edbd048103b5c7621f44711628566a03dcd4a";
const sourceCoverRevisionId =
  "artifact-revision_4224f43a746c4a9609970d1d888cf497a566d1b62471858bfeb47e73beec8e6f";
const decisionId = "recognition-decision_bc6a2a76-8047-4f07-9061-665be91affda";
const proposalId = "recognition-proposal_c1a33de3-1a7f-4b1d-9997-ee123d8089f9";
const executionId = "execution_f3798db5-3835-4c73-ba95-359b47018d69";
const snapshotId = "snapshot_b5d2d631-7691-4202-9137-a1025d71e616";
const assetId = "entity_20a4c474-c87a-462d-84eb-163b62d2f369";
const carrierReference = "台本/script.pdf";
const workItemKey = "dlsite-directory:.";

/** 每次用例都要完整回放一遍旧库闭包并跑整条生产就绪管道，共享预算按最慢的双回放用例取。 */
const replayBudget = 240_000;

type ClosureRow = Record<string, string | number | null>;

const closureFixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/legacy-derived-entity-cover/attribution-closure.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, readonly ClosureRow[]>;

/** 回放顺序按依赖排列；空表（无 revision 确认与内容证明）在旧库里本就没有行。 */
const closureTables = [
  "observed_root_registrations",
  "asset_libraries",
  "library_directory_grants",
  "workflow_executions",
  "recognition_proposals",
  "recognition_decisions",
  "blobs",
  "artifact_revisions",
  "locations",
  "artifact_associations",
  "artifact_association_recognition_supports",
  "observed_material_boundaries",
  "observed_material_acceptances",
  "current_observed_material_supports",
  "current_file_observations",
  "current_file_observation_supports",
] as const;

function rowsOf(table: string): readonly ClosureRow[] {
  return closureFixture[table] ?? [];
}

/** 闭包只抽取了判定所需的关系表，产物与实体父行按这些关系自己的坐标补齐。 */
function closureParents(): {
  readonly artifacts: readonly string[];
  readonly entities: readonly string[];
} {
  const artifacts = new Set<string>();
  const entities = new Set<string>();
  for (const row of rowsOf("locations")) artifacts.add(String(row.artifact_id));
  for (const row of rowsOf("artifact_revisions"))
    artifacts.add(String(row.artifact_id));
  for (const row of rowsOf("artifact_associations")) {
    artifacts.add(String(row.artifact_id));
    if (typeof row.target_artifact_id === "string")
      artifacts.add(row.target_artifact_id);
    if (typeof row.target_entity_id === "string")
      entities.add(row.target_entity_id);
  }
  for (const row of rowsOf("recognition_decisions"))
    entities.add(String(row.asset_id));
  return {
    artifacts: [...artifacts].toSorted(),
    entities: [...entities].toSorted(),
  };
}

let templateDirectory = "";

async function temporaryProductData(): Promise<string> {
  return path.join(
    await mkdtemp(path.join(tmpdir(), "digital-derived-entity-cover-")),
    "product-data",
  );
}

async function replayedCatalogue(
  damage: (database: DatabaseSync) => void = () => {},
): Promise<string> {
  const directory = await temporaryProductData();
  await cp(templateDirectory, directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, "catalogue.sqlite"));
  try {
    const parents = closureParents();
    for (const id of parents.artifacts)
      database.prepare("INSERT INTO artifacts (id) VALUES (?)").run(id);
    for (const id of parents.entities)
      database.prepare("INSERT INTO entities (id) VALUES (?)").run(id);
    for (const table of closureTables) {
      for (const row of rowsOf(table)) {
        const columns = Object.keys(row);
        const values = columns.map((column) => {
          const value: string | number | null | undefined = row[column];
          if (value === undefined)
            throw new Error(`fixture 行缺少声明列 ${table}.${column}`);
          return value;
        });
        database
          .prepare(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
              .map(() => "?")
              .join(", ")})`,
          )
          .run(...values);
      }
    }
    database
      .prepare(
        "INSERT INTO recognition_heads (subject_id, recognition_decision_id) VALUES (?, ?)",
      )
      .run(assetId, decisionId);
    damage(database);
  } finally {
    database.close();
  }
  return directory;
}

async function inspect(
  directory: string,
): Promise<Awaited<ReturnType<typeof inspectProductionCatalogueReadiness>>> {
  return inspectProductionCatalogueReadiness({
    productDataDirectory: directory,
  });
}

function coverEntries(directory: string) {
  const database = new DatabaseSync(path.join(directory, "catalogue.sqlite"), {
    readOnly: true,
  });
  try {
    return readDerivedEntityCoverReadiness(database);
  } finally {
    database.close();
  }
}

function coverEntry(directory: string, associationId = coverAssociationId) {
  const entries = coverEntries(directory);
  const entry = entries.find(
    (item) => item.supportKey.split("\u001f")[0] === associationId,
  );
  if (entry === undefined)
    throw new Error(
      `派生封面校验条目缺失：${JSON.stringify(entries.map((item) => item.supportKey))}`,
    );
  return entry;
}

describe("legacy derived entity cover history", () => {
  beforeAll(async () => {
    templateDirectory = await temporaryProductData();
    await prepareProductionCatalogue({
      productDataDirectory: templateDirectory,
    });
  }, 120_000);

  afterAll(async () => {
    await rm(templateDirectory, { recursive: true, force: true });
  });

  it(
    "旧自然错误的派生封面历史被严格还原后仍然完整且可重开",
    async () => {
      const directory = await replayedCatalogue();
      try {
        await expect(inspect(directory)).resolves.toMatchObject({
          state: "ready",
        });
        const entry = coverEntry(directory);
        expect(entry.verdict.historicallySupported).toBe(true);
        expect(entry.verdict.reasons).toEqual([]);
        // 历史结构完整不等于当前角色：目录内唯一被检查过的附件不代表实体。
        expect(entry.verdict.currentlyRepresentative).toBe(false);
        // 逐支持键包含封面自己的完整冻结事件坐标，不是按关联或角色名批量放行。
        expect(entry.supportKey.split("\u001f")).toEqual([
          coverAssociationId,
          decisionId,
          executionId,
          snapshotId,
          carrierLocationId,
          carrierRevisionId,
        ]);
        // 兄弟材料图与来源官方封面都不属于派生封面校验集合，仍由原有各臂各自判定。
        const associationIds: readonly string[] = coverEntries(directory).map(
          (item) => item.supportKey.split("\u001f")[0] ?? "",
        );
        expect(associationIds).not.toContain(siblingAssociationId);
        expect(associationIds.some((id) => id.endsWith("_entity-cover"))).toBe(
          true,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    replayBudget,
  );

  it(
    "同一载体上真实存在的材料图与来源封面不因封面历史判定而被抹除",
    async () => {
      const directory = await replayedCatalogue();
      try {
        const database = new DatabaseSync(
          path.join(directory, "catalogue.sqlite"),
          { readOnly: true },
        );
        try {
          const surviving = database
            .prepare(
              `SELECT association.id AS associationId,
                    (SELECT COUNT(*) FROM artifact_association_recognition_supports AS support
                      WHERE support.association_id = association.id) AS supports
             FROM artifact_associations AS association
             WHERE association.id IN (?, ?)`,
            )
            .all(
              siblingAssociationId,
              sourceCoverAssociationId,
            ) as unknown as readonly {
            associationId: string;
            supports: number;
          }[];
          expect(
            surviving.find((row) => row.associationId === siblingAssociationId)
              ?.supports,
          ).toBe(1);
          // 来源官方封面走来源记录依据，不是观察部件派生图，历史校验完全不接管它。
          expect(
            surviving.find(
              (row) => row.associationId === sourceCoverAssociationId,
            )?.supports,
          ).toBe(0);
          const coverRole = database
            .prepare(
              "SELECT role, target_kind AS targetKind FROM artifact_associations WHERE id = ?",
            )
            .get(coverAssociationId) as unknown as {
            role: string;
            targetKind: string;
          };
          expect(coverRole).toEqual({
            role: "asset.primary-cover",
            targetKind: "entity",
          });
        } finally {
          database.close();
        }
        await expect(inspect(directory)).resolves.toMatchObject({
          state: "ready",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    replayBudget,
  );

  it(
    "目录明确声明代表正文时同一派生封面重新取得当前资格",
    async () => {
      const directory = await replayedCatalogue((database) => {
        database
          .prepare(
            `UPDATE recognition_proposals
           SET observed_material_interpretation_json = json_insert(
                 observed_material_interpretation_json,
                 '$.observedArtifactAssociations[#]', json(?))
           WHERE id = ?`,
          )
          .run(
            JSON.stringify({
              observedArtifactReference: carrierReference,
              role: "asset.representative-body",
            }),
            proposalId,
          );
      });
      try {
        await expect(inspect(directory)).resolves.toMatchObject({
          state: "ready",
        });
        const entry = coverEntry(directory);
        expect(entry.verdict.historicallySupported).toBe(true);
        // 代表依据来自被接受边界明确声明，与历史完整性无关。
        expect(entry.verdict.currentlyRepresentative).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    replayBudget,
  );

  /**
   * 派生身份被改写：只换封面与兄弟关联自己的 ID（连同各自观察支持行的关联引用），
   * 产物/修订/位置/部件坐标都保持真实，因此唯一可能失败的检查是确定性 ID 公式本身。
   */
  const renameDerivedIdentity = (database: DatabaseSync) => {
    // 改名同时触及父行与自己的观察支持行：放在同一事务里，外键在两侧都写完时才校验。
    database.exec("BEGIN IMMEDIATE");
    database.exec("PRAGMA defer_foreign_keys = ON");
    try {
      for (const [from, to] of [
        [coverAssociationId, `artifact-association_${renamedKey}_entity-cover`],
        [siblingAssociationId, `artifact-association_${renamedKey}`],
      ] as const) {
        database
          .prepare("UPDATE artifact_associations SET id = ? WHERE id = ?")
          .run(to, from);
        database
          .prepare(
            "UPDATE artifact_association_recognition_supports SET association_id = ? WHERE association_id = ?",
          )
          .run(to, from);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const rejected = [
    {
      name: "封面部件指向另一个修订",
      reason: "part-revision-mismatch",
      damage: (database: DatabaseSync) => {
        database
          .prepare(
            `UPDATE artifact_associations
             SET observed_artifact_part_json = json_set(
               observed_artifact_part_json, '$.revisionId', ?)
             WHERE id = ?`,
          )
          .run(sourceCoverRevisionId, coverAssociationId);
      },
    },
    {
      name: "封面部件 locator 与声明的部分不一致",
      reason: "missing-sibling-material",
      damage: (database: DatabaseSync) => {
        database
          .prepare(
            `UPDATE artifact_associations
             SET observed_artifact_part_json = json_set(
               observed_artifact_part_json, '$.locator', 'pdf:page[2]')
             WHERE id = ?`,
          )
          .run(coverAssociationId);
      },
    },
    {
      name: "兄弟材料图属于另一个主体",
      reason: "missing-sibling-material",
      damage: (database: DatabaseSync) => {
        database
          .prepare(
            "UPDATE artifact_associations SET subject_id = ? WHERE id = ?",
          )
          .run("entity_unrelated", siblingAssociationId);
      },
    },
    {
      name: "封面观察支持指向另一个执行",
      reason: "proposal-execution-mismatch",
      damage: (database: DatabaseSync) => {
        database
          .prepare(
            "UPDATE artifact_association_recognition_supports SET observation_execution_id = ? WHERE association_id = ?",
          )
          .run("execution_unrelated", coverAssociationId);
      },
    },
    {
      name: "封面观察支持指向另一个载体位置",
      reason: "carrier-location-mismatch",
      damage: (database: DatabaseSync) => {
        database
          .prepare(
            "UPDATE artifact_association_recognition_supports SET observation_location_id = ? WHERE association_id = ?",
          )
          .run(audioLocationId, coverAssociationId);
      },
    },
    {
      name: "工作项声明的提案与接受行不一致",
      reason: "work-item-acceptance-mismatch",
      damage: (database: DatabaseSync) => {
        database
          .prepare(
            `UPDATE workflow_executions
             SET work_items_json = json_set(work_items_json,
               '$[0].proposalId', 'recognition-proposal_unrelated')
             WHERE id = ?`,
          )
          .run(executionId);
      },
    },
    {
      name: "载体接受改成本执行自己的关联提交",
      reason: "acceptance-kind-grants-no-derivation",
      damage: (database: DatabaseSync) => {
        database
          .prepare(
            "UPDATE observed_material_acceptances SET acceptance_kind = 'c-association' WHERE location_id = ?",
          )
          .run(carrierLocationId);
      },
    },
    {
      name: "封面派生身份不再是该部件坐标的确定性结果",
      reason: "deterministic-identity-mismatch",
      coverId: `artifact-association_${renamedKey}_entity-cover`,
      damage: renameDerivedIdentity,
    },
  ] as const;

  for (const case_ of rejected) {
    it(
      `真实错误的封面历史被拒绝：${case_.name}`,
      async () => {
        const directory = await replayedCatalogue(case_.damage);
        try {
          const coverId =
            "coverId" in case_ ? case_.coverId : coverAssociationId;
          const entry = coverEntry(directory, coverId);
          expect(entry.verdict.historicallySupported).toBe(false);
          expect(entry.verdict.reasons).toContain(case_.reason);
          await expect(inspect(directory)).resolves.toMatchObject({
            state: "catalogue-integrity-failed",
          });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      replayBudget,
    );
  }

  it(
    "当前观察证据齐全也不能替错误封面伪造确认",
    async () => {
      const confirmCarrier = (database: DatabaseSync) => {
        const observed = database
          .prepare(
            `SELECT snapshot_id AS snapshotId, observed_at AS observedAt, size,
                  modified_at AS modifiedAt, conditional_baseline AS baseline
           FROM current_file_observations WHERE location_id = ?`,
          )
          .get(carrierLocationId) as unknown as {
          snapshotId: string;
          observedAt: string;
          size: number;
          modifiedAt: string;
          baseline: string;
        };
        // 这条确认让封面支持满足 current 观察证据臂；它依旧不能替代历史结构校验。
        database
          .prepare(
            `INSERT INTO observed_revision_confirmations (
             revision_id, location_id, snapshot_id, observed_at, size,
             modified_at, conditional_baseline)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            carrierRevisionId,
            carrierLocationId,
            observed.snapshotId,
            observed.observedAt,
            observed.size,
            observed.modifiedAt,
            observed.baseline,
          );
      };
      const intact = await replayedCatalogue(confirmCarrier);
      try {
        await expect(inspect(intact)).resolves.toMatchObject({
          state: "ready",
        });
        expect(coverEntry(intact).verdict.historicallySupported).toBe(true);
      } finally {
        await rm(intact, { recursive: true, force: true });
      }
      const broken = await replayedCatalogue((database) => {
        confirmCarrier(database);
        renameDerivedIdentity(database);
      });
      try {
        const entry = coverEntry(
          broken,
          `artifact-association_${renamedKey}_entity-cover`,
        );
        expect(entry.verdict.historicallySupported).toBe(false);
        expect(entry.verdict.reasons).toContain(
          "deterministic-identity-mismatch",
        );
        await expect(inspect(broken)).resolves.toMatchObject({
          state: "catalogue-integrity-failed",
        });
      } finally {
        await rm(broken, { recursive: true, force: true });
      }
    },
    replayBudget,
  );

  it(
    "封面历史过期或消失时图仍然结构完整且保持可重开",
    async () => {
      const retracted = await replayedCatalogue((database) => {
        database
          .prepare(
            `INSERT INTO artifact_association_retractions (
             id, association_id, recognition_decision_id, source_record_ids_json)
           VALUES ('retraction-legacy-cover', ?, ?, '[]')`,
          )
          .run(coverAssociationId, decisionId);
      });
      try {
        await expect(inspect(retracted)).resolves.toMatchObject({
          state: "ready",
        });
        const entry = coverEntry(retracted);
        // 结束事实不改变历史：曾经如何产生仍按结构证明判定，也不因此取得当前角色。
        expect(entry.verdict.historicallySupported).toBe(true);
        expect(entry.verdict.currentlyRepresentative).toBe(false);
      } finally {
        await rm(retracted, { recursive: true, force: true });
      }

      const gone = await replayedCatalogue((database) => {
        database
          .prepare(
            "DELETE FROM artifact_association_recognition_supports WHERE association_id = ?",
          )
          .run(coverAssociationId);
        database
          .prepare("DELETE FROM artifact_associations WHERE id = ?")
          .run(coverAssociationId);
      });
      try {
        await expect(inspect(gone)).resolves.toMatchObject({ state: "ready" });
        expect(coverEntries(gone)).toEqual([]);
        const database = new DatabaseSync(path.join(gone, "catalogue.sqlite"), {
          readOnly: true,
        });
        try {
          const sibling = database
            .prepare(
              "SELECT COUNT(*) AS count FROM artifact_association_recognition_supports WHERE association_id = ?",
            )
            .get(siblingAssociationId) as unknown as { count: number };
          expect(sibling.count).toBe(1);
        } finally {
          database.close();
        }
      } finally {
        await rm(gone, { recursive: true, force: true });
      }
    },
    replayBudget,
  );

  it(
    "回放忠实于真实旧库：多材料台本边界与唯一被检查修订同时成立",
    async () => {
      const directory = await replayedCatalogue();
      try {
        const database = new DatabaseSync(
          path.join(directory, "catalogue.sqlite"),
          { readOnly: true },
        );
        try {
          const proposal = database
            .prepare(
              `SELECT json_extract(basis_json, '$.kind') AS basis,
                    json_extract(
                      observed_material_interpretation_json,
                      '$.observedArtifactRevisions[#-1]') IS NOT NULL AS revised
             FROM recognition_proposals WHERE id = ?`,
            )
            .get(proposalId) as unknown as { basis: string; revised: number };
          expect(proposal.basis).toBe("observed-evidence");
          expect(proposal.revised).toBe(1);
          const delivered = database
            .prepare(
              `SELECT COUNT(*) AS count FROM artifact_associations
             WHERE role = 'asset.material-delivered' AND subject_id = ?`,
            )
            .get(assetId) as unknown as { count: number };
          // 两份材料（音轨与台本 PDF）都真实交付，正是「唯一被检查」冒充封面的场景。
          expect(delivered.count).toBe(2);
          const boundaries = database
            .prepare(
              "SELECT COUNT(*) AS count FROM observed_material_boundaries",
            )
            .get() as unknown as { count: number };
          expect(boundaries.count).toBe(
            rowsOf("observed_material_boundaries").length,
          );
          const carrier = database
            .prepare(
              "SELECT artifact_id AS artifactId FROM locations WHERE id = ?",
            )
            .get(carrierLocationId) as unknown as { artifactId: string };
          expect(carrier.artifactId).toBe(carrierArtifactId);
          // 载体按执行自己声明的工作项被接受：工作项键与快照 ID 都是历史校验逐项相符的坐标。
          const acceptance = database
            .prepare(
              `SELECT acceptance_kind AS acceptanceKind, work_item_key AS workItemKey,
                    snapshot_id AS snapshotId
             FROM observed_material_acceptances WHERE location_id = ?`,
            )
            .get(carrierLocationId) as unknown as {
            acceptanceKind: string;
            workItemKey: string;
            snapshotId: string;
          };
          expect(acceptance).toEqual({
            acceptanceKind: "a-work-item",
            workItemKey,
            snapshotId,
          });
        } finally {
          database.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    replayBudget,
  );
});
