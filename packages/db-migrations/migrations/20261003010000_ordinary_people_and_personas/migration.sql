-- 人物与活动身份退出核心专门种类：先把退出生产语义的人工种类判断逐行封入迁移拥有的历史载体，
-- 再以数字资产为唯一种类重建断言表，最后确定性删除全部持久来源解释快照里的 entities[*].kind。

CREATE TABLE entity_kind_manual_history (
  source_table TEXT NOT NULL,
  source_primary_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  row_json TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  PRIMARY KEY (source_table, source_primary_key)
);
CREATE INDEX entity_kind_manual_history_entity ON entity_kind_manual_history (entity_id);

-- 原始行只按退出前的物理列顺序规范化，任何丢失或改写都必须让本次 prepare 回滚。
CREATE TEMP TABLE ordinary_entity_manual_history_expectations (
  source_table TEXT NOT NULL,
  source_primary_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  row_json TEXT NOT NULL
);
INSERT INTO ordinary_entity_manual_history_expectations (
  source_table, source_primary_key, entity_id, row_json
)
SELECT
  'local_entity_commitments',
  json_array(actor_id, commitment_id),
  entity_id,
  json_object(
    'actor_id', actor_id,
    'commitment_id', commitment_id,
    'entity_id', entity_id,
    'label', label,
    'submitted_kind', submitted_kind
  )
FROM local_entity_commitments
UNION ALL
SELECT
  'entity_kind_assertions',
  id,
  entity_id,
  json_object(
    'id', id,
    'entity_id', entity_id,
    'kind', kind,
    'basis', basis,
    'source_record_ids_json', source_record_ids_json,
    'actor_id', actor_id,
    'producer_json', producer_json
  )
FROM entity_kind_assertions
WHERE kind <> 'digital-asset' AND basis = 'manual'
UNION ALL
SELECT
  'entity_kind_decisions',
  id,
  entity_id,
  json_object(
    'id', id,
    'entity_id', entity_id,
    'selected_kind', selected_kind,
    'basis', basis,
    'replaces_decision_id', replaces_decision_id,
    'actor_id', actor_id,
    'operation', operation
  )
FROM entity_kind_decisions;

INSERT INTO entity_kind_manual_history (
  source_table, source_primary_key, entity_id, row_json, migration_id
)
SELECT
  source_table,
  source_primary_key,
  entity_id,
  row_json,
  '20261003010000_ordinary_people_and_personas'
FROM ordinary_entity_manual_history_expectations;

CREATE TEMP TABLE ordinary_entity_manual_history_guard (
  violations INTEGER NOT NULL CHECK (violations = 0)
);
INSERT INTO ordinary_entity_manual_history_guard (violations)
SELECT
  (SELECT COUNT(*) FROM (
     SELECT source_table, source_primary_key, entity_id, row_json
     FROM ordinary_entity_manual_history_expectations
     EXCEPT
     SELECT source_table, source_primary_key, entity_id, row_json
     FROM entity_kind_manual_history
   )) +
  (SELECT COUNT(*) FROM (
     SELECT source_table, source_primary_key, entity_id, row_json
     FROM entity_kind_manual_history
     EXCEPT
     SELECT source_table, source_primary_key, entity_id, row_json
     FROM ordinary_entity_manual_history_expectations
   )) +
  CASE WHEN (SELECT COUNT(*) FROM entity_kind_manual_history) =
            (SELECT COUNT(*) FROM ordinary_entity_manual_history_expectations)
       THEN 0 ELSE 1 END;

-- 每处持久来源解释都按同一条规则删除 entities 元素上的 kind；缺少该数组或它不是数组时保持原样。
UPDATE recognition_proposals
SET basis_json = json_set(
  basis_json,
  '$.interpretation.entities',
  json((SELECT json_group_array(json(json_remove(entity.value, '$.kind')))
        FROM json_each(recognition_proposals.basis_json, '$.interpretation.entities') AS entity))
)
WHERE json_type(basis_json, '$.interpretation.entities') = 'array';

UPDATE source_refresh_change_sets
SET interpretation_json = json_set(
  interpretation_json,
  '$.entities',
  json((SELECT json_group_array(json(json_remove(entity.value, '$.kind')))
        FROM json_each(source_refresh_change_sets.interpretation_json, '$.entities') AS entity))
)
WHERE json_type(interpretation_json, '$.entities') = 'array';

UPDATE current_source_artifact_candidate_lineages
SET interpretation_json = json_set(
  interpretation_json,
  '$.entities',
  json((SELECT json_group_array(json(json_remove(entity.value, '$.kind')))
        FROM json_each(current_source_artifact_candidate_lineages.interpretation_json, '$.entities') AS entity))
)
WHERE json_type(interpretation_json, '$.entities') = 'array';

UPDATE change_impact_previews
SET preview_json = json_set(
  preview_json,
  '$.current.entities',
  json((SELECT json_group_array(json(json_remove(entity.value, '$.kind')))
        FROM json_each(change_impact_previews.preview_json, '$.current.entities') AS entity))
)
WHERE json_type(preview_json, '$.current.entities') = 'array';

UPDATE change_impact_previews
SET preview_json = json_set(
  preview_json,
  '$.projected.entities',
  json((SELECT json_group_array(json(json_remove(entity.value, '$.kind')))
        FROM json_each(change_impact_previews.preview_json, '$.projected.entities') AS entity))
)
WHERE json_type(preview_json, '$.projected.entities') = 'array';

UPDATE change_impact_previews
SET preview_json = json_set(
  preview_json,
  '$.proposal.basis.interpretation.entities',
  json((SELECT json_group_array(json(json_remove(entity.value, '$.kind')))
        FROM json_each(change_impact_previews.preview_json, '$.proposal.basis.interpretation.entities') AS entity))
)
WHERE json_type(preview_json, '$.proposal.basis.interpretation.entities') = 'array';

UPDATE change_impact_previews
SET preview_json = json_set(
  preview_json,
  '$.change.proposal.basis.interpretation.entities',
  json((SELECT json_group_array(json(json_remove(entity.value, '$.kind')))
        FROM json_each(change_impact_previews.preview_json, '$.change.proposal.basis.interpretation.entities') AS entity))
)
WHERE json_type(preview_json, '$.change.proposal.basis.interpretation.entities') = 'array';

-- 耐久 checkpoint 与已确认决定草稿各自内嵌一份解释；两者都要变换。
UPDATE workflow_executions
SET source_enrichments_json = (
      SELECT json_group_array(
               CASE WHEN json_type(checkpoint.value, '$.interpretation.entities') = 'array'
                    THEN json_set(
                           checkpoint.value,
                           '$.interpretation.entities',
                           json((SELECT json_group_array(json(json_remove(entity.value, '$.kind')))
                                 FROM json_each(checkpoint.value, '$.interpretation.entities') AS entity))
                         )
                    ELSE checkpoint.value END
           )
      FROM json_each(workflow_executions.source_enrichments_json) AS checkpoint
    )
WHERE json_type(source_enrichments_json) = 'array';

UPDATE workflow_executions
SET source_association_decision_json = json_set(
  source_association_decision_json,
  '$.candidates',
  json((SELECT json_group_array(
               CASE WHEN json_type(candidate.value, '$.interpretation.entities') = 'array'
                    THEN json_set(
                           candidate.value,
                           '$.interpretation.entities',
                           json((SELECT json_group_array(json(json_remove(entity.value, '$.kind')))
                                 FROM json_each(candidate.value, '$.interpretation.entities') AS entity))
                         )
                    ELSE candidate.value END
           )
        FROM json_each(workflow_executions.source_association_decision_json, '$.candidates') AS candidate))
)
WHERE json_type(source_association_decision_json, '$.candidates') = 'array';

-- 候选引用是由解释内容派生的不可逆句柄；解释去掉 kind 后旧句柄必然失效。同一事务丢掉这些
-- 持久副本，让运行时按迁移后的字节重新派生（与从未写入句柄的行同一条路径），不保留错配句柄。
UPDATE workflow_executions
SET source_association_decision_json = json_set(
  source_association_decision_json,
  '$.proposal.evidence.sourceCandidates',
  json((SELECT json_group_array(json_remove(candidate.value, '$.reference'))
        FROM json_each(
          workflow_executions.source_association_decision_json,
          '$.proposal.evidence.sourceCandidates'
        ) AS candidate))
)
WHERE json_type(
  source_association_decision_json,
  '$.proposal.evidence.sourceCandidates'
) = 'array';

UPDATE change_impact_previews
SET preview_json = json_set(
  preview_json,
  '$.change.proposal.evidence.sourceCandidates',
  json((SELECT json_group_array(json_remove(candidate.value, '$.reference'))
        FROM json_each(
          change_impact_previews.preview_json,
          '$.change.proposal.evidence.sourceCandidates'
        ) AS candidate))
)
WHERE json_type(
  preview_json,
  '$.change.proposal.evidence.sourceCandidates'
) = 'array';

UPDATE change_impact_previews
SET preview_json = json_set(
  preview_json,
  '$.evidenceComparison.sourceCandidates',
  json((SELECT json_group_array(json_remove(candidate.value, '$.reference'))
        FROM json_each(
          change_impact_previews.preview_json,
          '$.evidenceComparison.sourceCandidates'
        ) AS candidate))
)
WHERE json_type(
  preview_json,
  '$.evidenceComparison.sourceCandidates'
) = 'array';

-- 耐久审计的 payload 是同一执行的镜像；两份必须在同一事务内以已变换的列重新对齐。
UPDATE workflow_executions
SET audit_json = json_set(
  audit_json,
  '$.payload.sourceEnrichments',
  json(source_enrichments_json)
)
WHERE audit_json IS NOT NULL
  AND json_extract(audit_json, '$.payload.sourceEnrichments') IS NOT NULL;

UPDATE workflow_executions
SET audit_json = json_set(
  audit_json,
  '$.payload.sourceAssociationDecision',
  json(source_association_decision_json)
)
WHERE audit_json IS NOT NULL
  AND source_association_decision_json IS NOT NULL
  AND json_extract(audit_json, '$.payload.sourceAssociationDecision') IS NOT NULL;

-- 数字资产断言逐行原样复制；人工种类判断已经只存在于历史载体中。
CREATE TABLE entity_kind_assertions_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'digital-asset'),
  basis TEXT NOT NULL,
  source_record_ids_json TEXT NOT NULL DEFAULT '[]',
  actor_id TEXT,
  producer_json TEXT
);
INSERT INTO entity_kind_assertions_v2 (
  id, entity_id, kind, basis, source_record_ids_json, actor_id, producer_json
)
SELECT id, entity_id, kind, basis, source_record_ids_json, actor_id, producer_json
FROM entity_kind_assertions
WHERE kind = 'digital-asset';
DROP TABLE entity_kind_assertions;
ALTER TABLE entity_kind_assertions_v2 RENAME TO entity_kind_assertions;
CREATE INDEX entity_kind_assertions_entity ON entity_kind_assertions (entity_id);

-- 本地身份提交只保留幂等坐标；实体、名称与 actor 归属不变。
CREATE TABLE local_entity_commitments_v2 (
  actor_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (actor_id, commitment_id)
);
INSERT INTO local_entity_commitments_v2 (actor_id, commitment_id, entity_id, label)
SELECT actor_id, commitment_id, entity_id, label FROM local_entity_commitments;
DROP TABLE local_entity_commitments;
ALTER TABLE local_entity_commitments_v2 RENAME TO local_entity_commitments;

-- 旧人工种类决定与来源种类生命周期整体退出生产合同。
DROP TABLE entity_kind_decisions;
DROP TABLE entity_kind_source_supports;

DROP TABLE ordinary_entity_manual_history_guard;
DROP TABLE ordinary_entity_manual_history_expectations;
