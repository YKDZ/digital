-- 来源产物、刷新、更正和识别预演会重新读取已保存的解释。它们也必须硬迁移，
-- 否则关系表已升级但当前详情仍会消费二元关系。这里只处理四处已知产品快照，
-- 不改动保留的来源原文，也不在运行时保留旧结构分支。
CREATE TEMP TABLE relationship_payloads AS
SELECT 'lineage' AS owner, rowid AS owner_rowid, interpretation_json AS document
FROM current_source_artifact_candidate_lineages
WHERE interpretation_json LIKE '%"participantId"%'
UNION ALL
SELECT 'refresh', rowid, interpretation_json FROM source_refresh_change_sets
WHERE interpretation_json LIKE '%"participantId"%'
UNION ALL
SELECT 'proposal', rowid, basis_json FROM recognition_proposals
WHERE basis_json LIKE '%"participantId"%'
UNION ALL
SELECT 'preview', rowid, preview_json FROM change_impact_previews
WHERE preview_json LIKE '%"participantId"%';

CREATE TEMP TABLE relationship_payload_replacements AS
WITH old_relationships AS (
  SELECT payload.rowid AS payload_id, item.id AS item_id, item.fullkey AS path,
         item.value AS original,
         CASE
           WHEN json_extract(item.value, '$.type') = 'bangumi.subject.related'
             AND json_extract(item.value, '$.role') = 'bangumi.subject.sequel'
             THEN 'bangumi.subject.predecessor'
           ELSE 'asset'
         END AS subject_role,
         CASE WHEN json_type(item.value, '$.participantMentionIds') = 'array'
           THEN json_object(
             'entityId', json_extract(item.value, '$.participantId'),
             'role', json_extract(item.value, '$.role'),
             'mentionIds', json_extract(item.value, '$.participantMentionIds'))
           ELSE json_object(
             'entityId', json_extract(item.value, '$.participantId'),
             'role', json_extract(item.value, '$.role'))
         END AS participant
  FROM relationship_payloads AS payload, json_tree(payload.document) AS item
  WHERE item.type = 'object' AND item.path LIKE '%.relationships'
    AND json_type(item.value, '$.participantId') = 'text'
    AND json_type(item.value, '$.participants') IS NULL
), named AS (
  SELECT *, json_set(
    json_remove(original, '$.subjectId', '$.participantId', '$.role', '$.participantMentionIds'),
    '$.participants', json(CASE WHEN json_type(original, '$.subjectId') = 'text'
      THEN json_array(
        json_object('entityId', json_extract(original, '$.subjectId'), 'role', subject_role),
        json(participant))
      ELSE json_array(json(participant)) END)
  ) AS relationship
  FROM old_relationships
)
SELECT payload_id, row_number() OVER (PARTITION BY payload_id ORDER BY item_id) AS ordinal,
       path, CASE WHEN json_type(original, '$.subjectId') = 'text'
         THEN json_set(relationship, '$.sourceSubjectId', json_extract(original, '$.subjectId'))
         ELSE json_set(relationship, '$.subjectRole', subject_role)
       END AS relationship
FROM named;

CREATE TEMP TABLE named_relationship_payloads AS
WITH RECURSIVE patched(payload_id, ordinal, document) AS (
  SELECT rowid, 0, document FROM relationship_payloads
  UNION ALL
  SELECT patched.payload_id, replacement.ordinal,
         json_set(patched.document, replacement.path, json(replacement.relationship))
  FROM patched JOIN relationship_payload_replacements AS replacement
    ON replacement.payload_id = patched.payload_id AND replacement.ordinal = patched.ordinal + 1
)
SELECT payload_id, document FROM patched
WHERE NOT EXISTS (
  SELECT 1 FROM relationship_payload_replacements AS next
  WHERE next.payload_id = patched.payload_id AND next.ordinal = patched.ordinal + 1
);

UPDATE current_source_artifact_candidate_lineages AS target
SET interpretation_json = (
  SELECT named.document FROM named_relationship_payloads AS named
  JOIN relationship_payloads AS old ON old.rowid = named.payload_id
  WHERE old.owner = 'lineage' AND old.owner_rowid = target.rowid
) WHERE rowid IN (SELECT owner_rowid FROM relationship_payloads WHERE owner = 'lineage');
UPDATE source_refresh_change_sets AS target
SET interpretation_json = (
  SELECT named.document FROM named_relationship_payloads AS named
  JOIN relationship_payloads AS old ON old.rowid = named.payload_id
  WHERE old.owner = 'refresh' AND old.owner_rowid = target.rowid
) WHERE rowid IN (SELECT owner_rowid FROM relationship_payloads WHERE owner = 'refresh');
UPDATE recognition_proposals AS target
SET basis_json = (
  SELECT named.document FROM named_relationship_payloads AS named
  JOIN relationship_payloads AS old ON old.rowid = named.payload_id
  WHERE old.owner = 'proposal' AND old.owner_rowid = target.rowid
) WHERE rowid IN (SELECT owner_rowid FROM relationship_payloads WHERE owner = 'proposal');
UPDATE change_impact_previews AS target
SET preview_json = (
  SELECT named.document FROM named_relationship_payloads AS named
  JOIN relationship_payloads AS old ON old.rowid = named.payload_id
  WHERE old.owner = 'preview' AND old.owner_rowid = target.rowid
) WHERE rowid IN (SELECT owner_rowid FROM relationship_payloads WHERE owner = 'preview');
DROP TABLE named_relationship_payloads;
DROP TABLE relationship_payload_replacements;
DROP TABLE relationship_payloads;
