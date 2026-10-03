-- 关系决定的作用范围从「类型＋参与者」整体坐标改为被点名事实的稳定支持范围。
-- 旧决定只有在既有证据足以唯一确定目标时才绑定该事实的目标；证据不足时把人工事实
-- 保全为独立人工目标，让各来源事实恢复各自生效。迁移绝不猜测，也不留下旧坐标读取路径。

CREATE TEMP TABLE relationship_fact_support_targets AS
WITH candidates AS (
  SELECT lifecycle.relationship_id AS relationship_id,
         json_object(
           'kind', 'source',
           'sourceSubjectId', lifecycle.source_subject_id,
           'sourceIdentity', lifecycle.source_identity,
           'nativeAddress', lifecycle.native_address,
           'coverageId', lifecycle.coverage_id,
           'sourceSlot', lifecycle.source_slot) AS target_json
  FROM relationship_lifecycles AS lifecycle
  UNION
  SELECT member.relationship_id,
         json_object(
           'kind', 'observed',
           'assetId', support.asset_id,
           'artifactId', support.artifact_id,
           'capabilityId', json_extract(support.producer_json, '$.capabilityId'),
           'coverageId', support.coverage_id,
           'sourceSlot', member.source_slot)
  FROM observed_entity_graph_relationships AS member
  JOIN observed_entity_graph_supports AS support ON support.id = member.graph_id
  JOIN recognition_heads AS head
    ON head.subject_id = support.asset_id
   AND head.recognition_decision_id = support.recognition_decision_id
  WHERE json_extract(support.producer_json, '$.capabilityId') IS NOT NULL
)
SELECT relationship_id, min(target_json) AS target_json FROM candidates GROUP BY relationship_id;

-- 当前非人工事实：仍有来源或观察支持，且未被撤回或取代。
CREATE TEMP TABLE relationship_current_facts AS
SELECT fact.id AS relationship_id, fact.type AS type, support.target_json AS target_json
FROM entity_relationships AS fact
JOIN relationship_fact_support_targets AS support ON support.relationship_id = fact.id
WHERE NOT EXISTS (
  SELECT 1 FROM relationship_retractions AS retraction
  WHERE retraction.relationship_id = fact.id)
  AND NOT EXISTS (
  SELECT 1 FROM relationship_lifecycles AS successor
  WHERE successor.predecessor_relationship_id = fact.id)
  AND NOT EXISTS (
  SELECT 1 FROM relationship_manual_supports AS manual
  WHERE manual.relationship_id = fact.id);

-- 旧坐标按类型与参与者集合与事实匹配；这里只用结构比较，不依赖排序后的键文本。
CREATE TEMP TABLE relationship_bucket_members AS
SELECT decision.id AS decision_id, fact.relationship_id AS relationship_id
FROM relationship_decisions AS decision
JOIN relationship_current_facts AS fact
  ON fact.type = json_extract(decision.coordinate_json, '$.type')
 AND (SELECT count(*) FROM entity_relationship_participants AS participant
      WHERE participant.relationship_id = fact.relationship_id)
     = json_array_length(decision.coordinate_json, '$.participants')
 AND NOT EXISTS (
  SELECT 1 FROM entity_relationship_participants AS participant
  WHERE participant.relationship_id = fact.relationship_id
    AND NOT EXISTS (
      SELECT 1 FROM json_each(decision.coordinate_json, '$.participants') AS declared
      WHERE json_extract(declared.value, '$.entityId') = participant.entity_id
        AND json_extract(declared.value, '$.role') = participant.role))
 AND NOT EXISTS (
  SELECT 1 FROM json_each(decision.coordinate_json, '$.participants') AS declared
  WHERE NOT EXISTS (
    SELECT 1 FROM entity_relationship_participants AS participant
    WHERE participant.relationship_id = fact.relationship_id
      AND participant.entity_id = json_extract(declared.value, '$.entityId')
      AND participant.role = json_extract(declared.value, '$.role')));

-- 旧人工事实既没有来源生命周期也没有观察支持，只能由支持它的更正决定说明目标。
-- 恰有一项同坐标非人工当前事实时沿用该事实的目标；否则把人工修正保全为独立人工目标。
CREATE TEMP TABLE relationship_fix_targets AS
SELECT decision.id AS decision_id,
       COALESCE(bucket.target_json,
                json_object('kind', 'manual', 'targetId', 'legacy-manual-' || decision.id))
         AS target_json
FROM relationship_decisions AS decision
LEFT JOIN (
  SELECT members.decision_id AS decision_id, min(facts.target_json) AS target_json
  FROM relationship_bucket_members AS members
  JOIN relationship_current_facts AS facts ON facts.relationship_id = members.relationship_id
  GROUP BY members.decision_id HAVING count(*) = 1
) AS bucket ON bucket.decision_id = decision.id
WHERE decision.kind = 'fix';

CREATE TEMP TABLE relationship_fact_targets AS
SELECT relationship_id, target_json FROM relationship_fact_support_targets
UNION ALL
SELECT manual.relationship_id, fix.target_json
FROM relationship_manual_supports AS manual
JOIN relationship_fix_targets AS fix ON fix.decision_id = manual.decision_id;

-- 损坏数据必须让迁移失败：决定头或人工支持引用缺失事实、一项人工支持同时归入多个目标、
-- 点名事实无法解析到任何支持范围，或旧坐标结构不完整。
CREATE TEMP TABLE relationship_migration_guard (
  invalid INTEGER NOT NULL CHECK (invalid = 0)
);
INSERT INTO relationship_migration_guard
SELECT 1 FROM relationship_decision_heads AS head
LEFT JOIN relationship_decisions AS decision ON decision.id = head.decision_id
WHERE decision.id IS NULL;
INSERT INTO relationship_migration_guard
SELECT 1 FROM relationship_manual_supports AS manual
LEFT JOIN entity_relationships AS fact ON fact.id = manual.relationship_id
LEFT JOIN relationship_fix_targets AS fix ON fix.decision_id = manual.decision_id
LEFT JOIN relationship_fact_support_targets AS support
  ON support.relationship_id = manual.relationship_id
WHERE fact.id IS NULL OR fix.decision_id IS NOT NULL AND support.relationship_id IS NOT NULL;
INSERT INTO relationship_migration_guard
SELECT 1 FROM relationship_manual_supports AS manual
LEFT JOIN relationship_decisions AS decision ON decision.id = manual.decision_id
WHERE decision.id IS NULL OR decision.kind <> 'fix'
   OR decision.manual_relationship_id IS NOT manual.relationship_id;
INSERT INTO relationship_migration_guard
SELECT 1 FROM relationship_decisions AS decision
WHERE json_valid(decision.coordinate_json) = 0
   OR json_type(decision.coordinate_json, '$.type') <> 'text'
   OR json_type(decision.coordinate_json, '$.participants') <> 'array'
   OR json_array_length(decision.coordinate_json, '$.participants') < 2
   OR json_valid(decision.relationship_ids_json) = 0
   OR json_type(decision.relationship_ids_json) <> 'array';
INSERT INTO relationship_migration_guard
SELECT 1 FROM relationship_decisions AS decision
JOIN relationship_decision_heads AS head ON head.decision_id = decision.id
JOIN json_each(decision.relationship_ids_json) AS named
LEFT JOIN relationship_fact_targets AS target ON target.relationship_id = named.value
WHERE decision.kind IN ('select', 'exclude')
  AND (target.relationship_id IS NULL OR named.type <> 'text');
INSERT INTO relationship_migration_guard
SELECT 1 FROM relationship_decisions AS decision
JOIN relationship_decision_heads AS head ON head.decision_id = decision.id
WHERE decision.kind = 'select' AND json_array_length(decision.relationship_ids_json) = 0;

CREATE TEMP TABLE relationship_migrated_decisions (
  id TEXT NOT NULL,
  target_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  manual_relationship_id TEXT,
  actor_id TEXT NOT NULL,
  origin_rowid INTEGER NOT NULL,
  is_head INTEGER NOT NULL
);

-- 更正决定保留原 ID，使既有人工支持继续指向同一决定；目标按上面的证据规则确定。
INSERT INTO relationship_migrated_decisions
SELECT decision.id, fix.target_json, 'fix', decision.manual_relationship_id, decision.actor_id,
       decision.rowid, head.decision_id IS NOT NULL
FROM relationship_decisions AS decision
JOIN relationship_fix_targets AS fix ON fix.decision_id = decision.id
LEFT JOIN relationship_decision_heads AS head ON head.decision_id = decision.id;

-- 点名的选择与排除各自绑定被点名事实的目标；同坐标其他事实不再被撤销。
INSERT INTO relationship_migrated_decisions
SELECT decision.id || ':' || named.value, target.target_json, decision.kind, NULL,
       decision.actor_id, decision.rowid, 1
FROM relationship_decisions AS decision
JOIN relationship_decision_heads AS head ON head.decision_id = decision.id
JOIN json_each(decision.relationship_ids_json) AS named
JOIN relationship_fact_targets AS target ON target.relationship_id = named.value
WHERE decision.kind IN ('select', 'exclude')
  AND json_array_length(decision.relationship_ids_json) > 0;

-- 清除回到当前适用来源推导：按当时每项当前事实的目标写下决定头，来源历史不改写。
INSERT INTO relationship_migrated_decisions
SELECT decision.id || ':' || fact.relationship_id, fact.target_json, 'clear', NULL,
       decision.actor_id, decision.rowid, 1
FROM relationship_decisions AS decision
JOIN relationship_decision_heads AS head ON head.decision_id = decision.id
JOIN relationship_bucket_members AS member ON member.decision_id = decision.id
JOIN relationship_current_facts AS fact ON fact.relationship_id = member.relationship_id
WHERE decision.kind = 'clear';

-- 没有证据可绑定的决定行保留为历史，不写决定头，因此不会改变任何事实的生效结果。
INSERT INTO relationship_migrated_decisions
SELECT decision.id,
       json_object('kind', 'manual', 'targetId', 'legacy-inert-' || decision.id),
       decision.kind, NULL, decision.actor_id, decision.rowid, 0
FROM relationship_decisions AS decision
LEFT JOIN relationship_decision_heads AS head ON head.decision_id = decision.id
WHERE decision.kind <> 'fix'
  AND (head.decision_id IS NULL
       OR decision.kind IN ('select', 'exclude')
          AND json_array_length(decision.relationship_ids_json) = 0
       OR decision.kind = 'clear'
          AND NOT EXISTS (
            SELECT 1 FROM relationship_bucket_members AS member
            WHERE member.decision_id = decision.id));

CREATE TABLE relationship_decisions_new (
  id TEXT PRIMARY KEY NOT NULL,
  target_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  definition_id TEXT,
  manual_relationship_id TEXT,
  actor_id TEXT NOT NULL
);
INSERT INTO relationship_decisions_new
  (id, target_json, kind, definition_id, manual_relationship_id, actor_id)
SELECT id, target_json, kind, NULL, manual_relationship_id, actor_id
FROM relationship_migrated_decisions;

CREATE TABLE relationship_decision_heads_new (
  target_key TEXT PRIMARY KEY NOT NULL,
  decision_id TEXT NOT NULL
);
INSERT INTO relationship_decision_heads_new (target_key, decision_id)
SELECT target_json, id FROM (
  SELECT target_json, id,
         row_number() OVER (PARTITION BY target_json ORDER BY origin_rowid DESC, id) AS ordinal
  FROM relationship_migrated_decisions WHERE is_head = 1
) WHERE ordinal = 1;

CREATE TABLE relationship_manual_supports_new (
  relationship_id TEXT PRIMARY KEY NOT NULL,
  decision_id TEXT NOT NULL
);
INSERT INTO relationship_manual_supports_new (relationship_id, decision_id)
SELECT relationship_id, decision_id FROM relationship_manual_supports;

DROP TABLE relationship_decisions;
DROP TABLE relationship_decision_heads;
DROP TABLE relationship_manual_supports;
ALTER TABLE relationship_decisions_new RENAME TO relationship_decisions;
ALTER TABLE relationship_decision_heads_new RENAME TO relationship_decision_heads;
ALTER TABLE relationship_manual_supports_new RENAME TO relationship_manual_supports;
CREATE INDEX relationship_manual_supports_decision
  ON relationship_manual_supports(decision_id);

DROP TABLE relationship_migrated_decisions;
DROP TABLE relationship_fact_targets;
DROP TABLE relationship_fix_targets;
DROP TABLE relationship_bucket_members;
DROP TABLE relationship_current_facts;
DROP TABLE relationship_fact_support_targets;
DROP TABLE relationship_migration_guard;
