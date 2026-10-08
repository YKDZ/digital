ALTER TABLE recognition_proposals ADD COLUMN boundaries_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE recognition_decisions ADD COLUMN boundaries_json TEXT NOT NULL DEFAULT '[]';

-- 只迁移历史明确选中的材料。旧目录名、技术打包和今天的识别规则不授予持续目录范围。
CREATE TEMP TABLE __boundary_documents (
  document_kind TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (document_kind, document_id)
);
INSERT INTO __boundary_documents
SELECT 'material', id, material_association_json FROM workflow_executions
WHERE material_association_json IS NOT NULL AND json_valid(material_association_json);
INSERT INTO __boundary_documents
SELECT 'audit', id, audit_json FROM workflow_executions
WHERE audit_json IS NOT NULL AND json_valid(audit_json);
INSERT INTO __boundary_documents
SELECT 'preview', id, preview_json FROM change_impact_previews
WHERE json_valid(preview_json);

CREATE TEMP TABLE __boundary_proposals (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  basis_json TEXT NOT NULL,
  boundaries_json TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO __boundary_proposals (id, execution_id, basis_json)
SELECT id, execution_id, basis_json FROM recognition_proposals;
-- 尚未接受的人工材料检查点同样携带明确选择，恢复时继续使用该离散范围。
INSERT OR IGNORE INTO __boundary_proposals (id, execution_id, basis_json)
SELECT json_extract(node.value, '$.id'), document.document_id,
       json_extract(node.value, '$.basis')
FROM __boundary_documents document, json_tree(document.document) node
WHERE document.document_kind IN ('material', 'audit') AND node.type = 'object'
  AND json_type(node.value, '$.basis') = 'object'
  AND json_type(node.value, '$.ruleResults') = 'array';

CREATE TEMP TABLE __boundary_inputs AS
SELECT proposal.id, execution.id AS execution_id,
       COALESCE(json_extract(execution.snapshot_json, '$.root'),
                json_extract(execution.material_association_json, '$.snapshot.root')) AS snapshot_root,
       (SELECT root.value FROM json_each(execution.workflow_input_json, '$.observedRoots') root
        WHERE json_extract(execution.snapshot_json, '$.root') = json_extract(root.value, '$.containerPath')
           OR substr(json_extract(execution.snapshot_json, '$.root'), 1,
                     length(rtrim(json_extract(root.value, '$.containerPath'), '/')) + 1)
              = rtrim(json_extract(root.value, '$.containerPath'), '/') || '/'
        ORDER BY length(json_extract(root.value, '$.containerPath')) DESC LIMIT 1) AS root_json,
       CASE
         WHEN json_extract(proposal.basis_json, '$.kind') = 'manual-boundary'
           THEN json_extract(proposal.basis_json, '$.materialReferences')
         WHEN EXISTS (SELECT 1 FROM json_each(execution.work_items_json) item
                      WHERE json_extract(item.value, '$.proposalId') = proposal.id)
           THEN (SELECT json_extract(item.value, '$.relativePaths')
                 FROM json_each(execution.work_items_json) item
                 WHERE json_extract(item.value, '$.proposalId') = proposal.id LIMIT 1)
         WHEN EXISTS (SELECT 1 FROM observed_material_acceptances acceptance
                      WHERE acceptance.proposal_id = proposal.id)
           THEN (SELECT json_group_array(observed_reference)
                 FROM (SELECT DISTINCT observed_reference FROM observed_material_acceptances
                       WHERE proposal_id = proposal.id ORDER BY observed_reference))
         WHEN execution.proposal_id = proposal.id
           THEN (SELECT json_group_array(json_extract(file.value, '$.relativePath'))
                 FROM json_each(execution.snapshot_json, '$.files') file)
         ELSE '[]'
       END AS references_json
FROM __boundary_proposals proposal JOIN workflow_executions execution ON execution.id = proposal.execution_id;

CREATE TEMP TABLE __boundary_references AS
SELECT input.id,
       COALESCE(json_extract(input.root_json, '$.id'), 'legacy-execution:' || input.execution_id) AS scope_reference,
       CASE WHEN input.root_json IS NULL
                  OR input.snapshot_root = json_extract(input.root_json, '$.containerPath')
            THEN reference.value
            ELSE substr(input.snapshot_root, length(rtrim(json_extract(input.root_json, '$.containerPath'), '/')) + 2)
                 || CASE WHEN reference.value = '.' THEN '' ELSE '/' || reference.value END
       END AS material_reference
FROM __boundary_inputs input, json_each(COALESCE(input.references_json, '[]')) reference
WHERE reference.type = 'text' AND length(reference.value) > 0;

UPDATE __boundary_proposals
SET boundaries_json = COALESCE((
  SELECT json_array(json_object('kind', 'discrete', 'scopeReference', scope_reference,
         'materialReferences', json_group_array(material_reference)))
  FROM (SELECT DISTINCT scope_reference, material_reference FROM __boundary_references
        WHERE id = __boundary_proposals.id ORDER BY material_reference)
  HAVING count(*) > 0
), '[]');
UPDATE recognition_proposals SET boundaries_json =
  (SELECT boundaries_json FROM __boundary_proposals WHERE id = recognition_proposals.id);
UPDATE recognition_decisions SET boundaries_json =
  (SELECT boundaries_json FROM recognition_proposals WHERE id = recognition_decisions.proposal_id);

-- 同步嵌入的不可变提案／决定副本；内容不重新识别，审计与列投影保持一致。
CREATE TEMP TABLE __boundary_json_updates AS
SELECT document.document_kind, document.document_id, node.fullkey || '.boundaries' AS json_path,
       COALESCE(proposal.boundaries_json, decision.boundaries_json, pending_decision.boundaries_json) AS boundaries_json,
       row_number() OVER (PARTITION BY document.document_kind, document.document_id ORDER BY node.id) AS ordinal
FROM __boundary_documents document, json_tree(document.document) node
LEFT JOIN __boundary_proposals proposal
  ON proposal.id = json_extract(CASE WHEN node.type = 'object' THEN node.value ELSE '{}' END, '$.id')
 AND json_type(CASE WHEN node.type = 'object' THEN node.value ELSE '{}' END, '$.basis') = 'object'
LEFT JOIN recognition_decisions decision
  ON decision.id = json_extract(CASE WHEN node.type = 'object' THEN node.value ELSE '{}' END, '$.id')
 AND json_type(CASE WHEN node.type = 'object' THEN node.value ELSE '{}' END, '$.acceptedRuleResults') = 'array'
LEFT JOIN __boundary_proposals pending_decision
  ON pending_decision.id = json_extract(CASE WHEN node.type = 'object' THEN node.value ELSE '{}' END, '$.proposalId')
 AND json_type(CASE WHEN node.type = 'object' THEN node.value ELSE '{}' END, '$.acceptedRuleResults') = 'array'
WHERE node.type = 'object' AND (proposal.id IS NOT NULL OR decision.id IS NOT NULL OR pending_decision.id IS NOT NULL);
WITH RECURSIVE rewritten(document_kind, document_id, ordinal, document) AS (
  SELECT document_kind, document_id, 0, document FROM __boundary_documents
  UNION ALL
  SELECT previous.document_kind, previous.document_id, next.ordinal,
         json_set(previous.document, next.json_path, json(next.boundaries_json))
  FROM rewritten previous JOIN __boundary_json_updates next
    ON next.document_kind = previous.document_kind AND next.document_id = previous.document_id
   AND next.ordinal = previous.ordinal + 1
)
UPDATE __boundary_documents SET document = (
  SELECT document FROM rewritten WHERE document_kind = __boundary_documents.document_kind
    AND document_id = __boundary_documents.document_id ORDER BY ordinal DESC LIMIT 1
);
UPDATE workflow_executions SET material_association_json =
  (SELECT document FROM __boundary_documents WHERE document_kind = 'material' AND document_id = workflow_executions.id)
WHERE id IN (SELECT document_id FROM __boundary_documents WHERE document_kind = 'material');
UPDATE workflow_executions SET audit_json =
  (SELECT document FROM __boundary_documents WHERE document_kind = 'audit' AND document_id = workflow_executions.id)
WHERE id IN (SELECT document_id FROM __boundary_documents WHERE document_kind = 'audit');
UPDATE change_impact_previews SET preview_json =
  (SELECT document FROM __boundary_documents WHERE document_kind = 'preview' AND document_id = change_impact_previews.id)
WHERE id IN (SELECT document_id FROM __boundary_documents WHERE document_kind = 'preview');

DROP TABLE __boundary_json_updates;
DROP TABLE __boundary_references;
DROP TABLE __boundary_inputs;
DROP TABLE __boundary_proposals;
DROP TABLE __boundary_documents;
