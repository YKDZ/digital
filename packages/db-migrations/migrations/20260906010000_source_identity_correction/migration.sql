ALTER TABLE workflow_executions ADD COLUMN source_association_decision_json TEXT;

CREATE TABLE source_association_change_proposals (
  id TEXT PRIMARY KEY NOT NULL,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('establish', 'replace', 'retract')),
  payload_json TEXT NOT NULL,
  proposed_by_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);
CREATE TABLE source_association_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES source_association_change_proposals(id),
  subject_id TEXT NOT NULL,
  decided_by_kind TEXT NOT NULL CHECK (decided_by_kind IN ('user', 'application-policy')),
  decided_by_coordinate TEXT NOT NULL
);
CREATE TABLE source_association_establishment_supports (
  association_id TEXT PRIMARY KEY NOT NULL REFERENCES source_associations(id),
  recognition_decision_id TEXT REFERENCES recognition_decisions(id),
  source_association_decision_id TEXT REFERENCES source_association_decisions(id),
  CHECK ((recognition_decision_id IS NOT NULL) <> (source_association_decision_id IS NOT NULL))
);
CREATE TABLE source_association_supersessions (
  id TEXT PRIMARY KEY NOT NULL,
  predecessor_association_id TEXT NOT NULL UNIQUE REFERENCES source_associations(id),
  successor_association_id TEXT NOT NULL UNIQUE REFERENCES source_associations(id),
  source_association_decision_id TEXT REFERENCES source_association_decisions(id),
  recognition_decision_id TEXT REFERENCES recognition_decisions(id),
  CHECK ((source_association_decision_id IS NOT NULL) <> (recognition_decision_id IS NOT NULL))
);
CREATE TABLE recognition_decision_retractions (
  id TEXT PRIMARY KEY NOT NULL,
  predecessor_decision_id TEXT NOT NULL UNIQUE REFERENCES recognition_decisions(id),
  proposed_by TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE source_association_retractions (
  id TEXT PRIMARY KEY NOT NULL,
  association_id TEXT NOT NULL UNIQUE REFERENCES source_associations(id),
  source_association_decision_id TEXT REFERENCES source_association_decisions(id),
  recognition_decision_supersession_id TEXT REFERENCES recognition_decision_supersessions(id),
  recognition_decision_retraction_id TEXT REFERENCES recognition_decision_retractions(id),
  CHECK ((source_association_decision_id IS NOT NULL) +
         (recognition_decision_supersession_id IS NOT NULL) +
         (recognition_decision_retraction_id IS NOT NULL) = 1)
);
CREATE TABLE source_association_legacy_retirements (
  association_id TEXT PRIMARY KEY NOT NULL REFERENCES source_associations(id),
  migration_id TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis = 'legacy-current-projection')
);

INSERT INTO source_association_establishment_supports
SELECT association.id, decision.id, NULL
FROM source_associations AS association
JOIN recognition_decisions AS decision ON decision.proposal_id = association.proposal_id
WHERE decision.asset_id = association.subject_id;

CREATE TEMP TABLE source_enrichment_authority AS
SELECT association.id AS association_id, association.subject_id,
       association.source_identity, association.native_address,
       execution.id AS execution_id,
       json_extract(execution.workflow_input_json, '$.initiatedBy') AS initiated_by,
       execution.workflow_input_json AS workflow_input_json,
       head.recognition_decision_id AS current_recognition_decision_id,
       checkpoint.value AS checkpoint_json,
       json_extract(checkpoint.value, '$.explicitInput') IS NOT NULL AS is_explicit,
       capability.value AS association_capability_json
FROM source_associations AS association
JOIN workflow_executions AS execution
  ON association.proposal_id LIKE 'source-enrichment:' || execution.id || ':%'
JOIN recognition_heads AS head ON head.subject_id = association.subject_id
JOIN json_each(execution.source_enrichments_json) AS checkpoint
  ON json_extract(checkpoint.value, '$.sourceAssociation.id') = association.id
 AND json_extract(checkpoint.value, '$.subjectId') = association.subject_id
 AND json_extract(checkpoint.value, '$.sourceAssociation.sourceIdentity') = association.source_identity
 AND json_extract(checkpoint.value, '$.sourceAssociation.nativeAddress') = association.native_address
JOIN json_each(execution.compatibility_json, '$.capabilityCoordinates') AS capability
  ON json_extract(capability.value, '$.capabilityId') =
     substr(association.proposal_id, length('source-enrichment:' || execution.id || ':') + 1)
WHERE json_extract(checkpoint.value, '$.stage') = 'applied';

CREATE TEMP TABLE source_association_migration_guard (
  invalid INTEGER NOT NULL CHECK (invalid = 0)
);
INSERT INTO source_association_migration_guard
SELECT 1 FROM source_associations AS association
LEFT JOIN source_association_establishment_supports AS support
  ON support.association_id = association.id
LEFT JOIN source_enrichment_authority AS enrichment
  ON enrichment.association_id = association.id
WHERE support.association_id IS NULL
GROUP BY association.id HAVING COUNT(enrichment.association_id) <> 1;
INSERT INTO source_association_migration_guard
SELECT 1 FROM source_enrichment_authority
WHERE initiated_by IS NULL OR initiated_by = ''
   OR checkpoint_json IS NULL
   OR workflow_input_json IS NULL
   OR json_extract(checkpoint_json, '$.subject.recognitionDecisionId')
      IS NOT current_recognition_decision_id
   OR json_extract(checkpoint_json, '$.interpretation.sourceIdentity')
      IS NOT source_identity
   OR json_extract(checkpoint_json, '$.interpretation.sourceAddress')
      IS NOT native_address
   OR json_extract(checkpoint_json, '$.evidence.sourceIdentity')
      IS NOT source_identity
   OR json_extract(checkpoint_json, '$.evidence.sourceAddress')
      IS NOT native_address
   OR json(json_extract(checkpoint_json, '$.sourceRecordIds'))
      IS NOT json(json_extract(checkpoint_json, '$.interpretation.sourceRecordIds'))
   OR association_capability_json IS NULL
   OR json_extract(association_capability_json, '$.capabilityId')
      IS NOT json_extract(checkpoint_json, '$.interpretation.producer.capabilityId')
   OR json_extract(association_capability_json, '$.capabilityVersion')
      IS NOT json_extract(checkpoint_json, '$.interpretation.producer.capabilityVersion')
   OR json_extract(association_capability_json, '$.contractVersion')
      IS NOT json_extract(checkpoint_json, '$.interpretation.producer.contractVersion');

-- 每个 captured ID 必须同时出现在 execution 审计列和真实不可变 Source Record 中，
-- 且该记录精确属于同一执行、来源和规范地址。只凭 checkpoint 文本不能建立 authority。
INSERT INTO source_association_migration_guard
SELECT 1
FROM source_enrichment_authority AS authority
JOIN json_each(authority.checkpoint_json, '$.sourceRecordIds') AS captured
LEFT JOIN source_records AS record ON record.id = captured.value
WHERE record.id IS NULL
   OR record.execution_id <> authority.execution_id
   OR record.source_identity <> authority.source_identity
   OR record.native_address <> authority.native_address
   OR NOT EXISTS (
     SELECT 1 FROM workflow_executions AS execution,
       json_each(execution.source_record_ids_json) AS execution_record
     WHERE execution.id = authority.execution_id
       AND execution_record.value = captured.value
   );

INSERT INTO source_association_migration_guard
SELECT 1
FROM source_enrichment_authority AS authority
WHERE (SELECT COUNT(*) FROM json_each(authority.checkpoint_json, '$.sourceRecordIds')) <>
      (SELECT COUNT(DISTINCT value) FROM json_each(authority.checkpoint_json, '$.sourceRecordIds'))
   OR (SELECT COUNT(*) FROM source_enrichment_authority AS duplicate
       WHERE duplicate.association_id = authority.association_id) <> 1;

INSERT INTO source_association_change_proposals
SELECT 'migrated-source-association-proposal:' || association_id,
       subject_id, 'establish',
       json_object('successor', json_object(
         'id', association_id, 'subjectId', subject_id,
         'sourceIdentity', source_identity, 'nativeAddress', native_address),
         'sourceRecordIds', json_extract(checkpoint_json, '$.sourceRecordIds')),
       CASE WHEN is_explicit THEN json_object('kind', 'user', 'actorId', initiated_by)
            ELSE json_object('kind', 'capability', 'coordinate', json(association_capability_json)) END,
       json_object('observed', json_array(),
         'manual', CASE WHEN is_explicit THEN json_array(json_extract(checkpoint_json, '$.evidence')) ELSE json_array() END,
         'sourceCandidates', json_array(json_object(
           'outcome', 'accepted',
           'sourceIdentity', source_identity, 'nativeAddress', native_address,
           'sourceRecordIds', json_extract(checkpoint_json, '$.sourceRecordIds'),
           'ruleResults', json_array(), 'explanation', 'migrated exact interpretation')),
         'conflicts', json_array())
FROM source_enrichment_authority;

INSERT INTO source_association_decisions
SELECT 'migrated-source-association-decision:' || association_id,
       'migrated-source-association-proposal:' || association_id,
       subject_id,
       CASE WHEN is_explicit THEN 'user' ELSE 'application-policy' END,
       CASE WHEN is_explicit THEN initiated_by ELSE
         'source-enrichment/exact-interpretation/1@8643486680a06ddb656b78c473fc78476a63eda5:' ||
         json_extract(association_capability_json, '$.capabilityId') || ':' ||
         json_extract(association_capability_json, '$.capabilityVersion') || ':' ||
         json_extract(association_capability_json, '$.contractVersion') END
FROM source_enrichment_authority;

INSERT INTO source_association_establishment_supports
SELECT association_id, NULL, 'migrated-source-association-decision:' || association_id
FROM source_enrichment_authority;

INSERT INTO source_association_legacy_retirements
SELECT association.id, '20260906010000_source_identity_correction', 'legacy-current-projection'
FROM source_associations AS association
LEFT JOIN current_source_associations AS current
  ON current.association_id = association.id AND current.subject_id = association.subject_id
WHERE current.association_id IS NULL;

DELETE FROM current_source_associations;
INSERT INTO current_source_associations(subject_id, association_id)
SELECT association.subject_id, association.id
FROM source_associations AS association
JOIN source_association_establishment_supports AS support
  ON support.association_id = association.id
LEFT JOIN source_association_legacy_retirements AS retirement
  ON retirement.association_id = association.id
WHERE retirement.association_id IS NULL;

INSERT INTO source_association_migration_guard
SELECT 1 FROM source_associations AS association
LEFT JOIN source_association_establishment_supports AS support
  ON support.association_id = association.id
GROUP BY association.id HAVING COUNT(support.association_id) <> 1;

UPDATE change_impact_previews
SET preview_json = json_set(preview_json, '$.status', 'stale')
WHERE json_extract(preview_json, '$.status') = 'awaiting-confirmation';
UPDATE change_impact_previews
SET preview_json = json_set(preview_json, '$.version', 'legacy-recognition-preview/1')
WHERE json_extract(preview_json, '$.version') IS NULL;

ALTER TABLE source_associations DROP COLUMN proposal_id;
ALTER TABLE source_associations DROP COLUMN is_current;

CREATE TABLE recognition_heads_new (
  subject_id TEXT PRIMARY KEY NOT NULL,
  recognition_decision_id TEXT,
  recognition_source_association_id TEXT,
  CHECK (recognition_decision_id IS NOT NULL OR recognition_source_association_id IS NULL)
);
INSERT INTO recognition_heads_new SELECT * FROM recognition_heads;
DROP TABLE recognition_heads;
ALTER TABLE recognition_heads_new RENAME TO recognition_heads;

DROP TABLE source_association_migration_guard;
DROP TABLE source_enrichment_authority;
