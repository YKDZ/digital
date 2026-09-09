ALTER TABLE recognition_proposals ADD COLUMN observed_material_interpretation_json TEXT;
ALTER TABLE workflow_executions ADD COLUMN material_association_json TEXT;

CREATE TABLE artifact_association_recognition_supports (
  association_id TEXT NOT NULL REFERENCES artifact_associations(id),
  recognition_decision_id TEXT NOT NULL REFERENCES recognition_decisions(id),
  CONSTRAINT artifact_association_recognition_supports_pk PRIMARY KEY (association_id, recognition_decision_id)
);
CREATE INDEX artifact_association_recognition_supports_decision
  ON artifact_association_recognition_supports (recognition_decision_id);

CREATE TEMP TABLE observed_material_selected (
  asset_id TEXT NOT NULL, decision_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
  reference TEXT, root TEXT, digest TEXT, proof_count INTEGER NOT NULL,
  PRIMARY KEY (decision_id, reference)
);

INSERT INTO observed_material_selected
SELECT head.subject_id, decision.id, proposal.id, material.value,
       json_extract(execution.snapshot_json, '$.root'),
       MIN(json_extract(evidence.value, '$.inspection.revision.digest')),
       COUNT(DISTINCT json_extract(evidence.value, '$.inspection.revision.digest'))
FROM recognition_heads AS head
JOIN recognition_decisions AS decision ON decision.id = head.recognition_decision_id
 AND decision.asset_id = head.subject_id
JOIN recognition_proposals AS proposal ON proposal.id = decision.proposal_id
JOIN workflow_executions AS execution ON execution.id = proposal.execution_id
 AND execution.accepted_asset_id = head.subject_id AND execution.outcome = 'accepted'
JOIN json_each(json_extract(proposal.basis_json, '$.materialReferences')) AS material
LEFT JOIN json_each(json_extract(proposal.basis_json, '$.evidence')) AS evidence
 ON json_extract(evidence.value, '$.inspection.observedArtifactReference') = material.value
WHERE json_extract(proposal.basis_json, '$.kind') = 'manual-boundary'
GROUP BY head.subject_id, decision.id, proposal.id, material.value,
         json_extract(execution.snapshot_json, '$.root');

INSERT INTO observed_material_selected
SELECT head.subject_id, decision.id, proposal.id,
       json_extract(material.value, '$.observedArtifactReference'),
       json_extract(execution.snapshot_json, '$.root'),
       json_extract(material.value, '$.blob.digest'), 1
FROM recognition_heads AS head
JOIN recognition_decisions AS decision ON decision.id = head.recognition_decision_id
 AND decision.asset_id = head.subject_id
JOIN recognition_proposals AS proposal ON proposal.id = decision.proposal_id
JOIN workflow_executions AS execution ON execution.id = proposal.execution_id
 AND execution.accepted_asset_id = head.subject_id AND execution.outcome = 'accepted'
JOIN json_each(json_extract(proposal.basis_json, '$.artifactRevisions')) AS material
WHERE json_extract(proposal.basis_json, '$.kind') = 'observed-evidence';

CREATE TEMP TABLE observed_material_replayed (
  association_id TEXT NOT NULL, decision_id TEXT NOT NULL,
  reference TEXT NOT NULL, location_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, ended INTEGER NOT NULL,
  PRIMARY KEY (association_id, decision_id, reference, location_id, revision_id)
);
INSERT INTO observed_material_replayed
SELECT association.id, selected.decision_id, selected.reference,
       location.id, artifact.id, revision.id,
       CASE WHEN EXISTS (
         SELECT 1 FROM artifact_association_retractions AS ending
         WHERE ending.association_id = association.id
       ) OR EXISTS (
         SELECT 1 FROM artifact_association_supersessions AS ending
         WHERE ending.predecessor_association_id = association.id
       ) THEN 1 ELSE 0 END
FROM observed_material_selected AS selected
JOIN locations AS location ON location.address = selected.root || '/' || selected.reference
 AND location.kind = 'observed'
JOIN artifacts AS artifact ON artifact.id = location.artifact_id
JOIN artifact_revisions AS revision ON revision.artifact_id = artifact.id
 AND revision.blob_digest = selected.digest
JOIN blobs AS blob ON blob.digest = revision.blob_digest
JOIN artifact_associations AS association ON association.artifact_id = artifact.id
 AND association.subject_id = selected.asset_id
 AND association.role = 'asset.material-delivered'
 AND association.source_record_ids_json = '[]'
 AND association.source_association_id IS NULL
;

CREATE TEMP TABLE observed_material_classification (
  association_id TEXT PRIMARY KEY NOT NULL,
  classification TEXT NOT NULL CHECK (
    classification IN ('proven-initial', 'independently-sourced', 'other-legacy')
  ),
  decision_id TEXT
);
INSERT INTO observed_material_classification
SELECT association.id,
  CASE
    WHEN association.source_record_ids_json <> '[]'
      OR association.source_association_id IS NOT NULL THEN 'independently-sourced'
    WHEN EXISTS (
      SELECT 1 FROM observed_material_replayed AS replayed
      WHERE replayed.association_id = association.id AND replayed.ended = 0
    ) THEN 'proven-initial'
    ELSE 'other-legacy'
  END,
  (SELECT replayed.decision_id FROM observed_material_replayed AS replayed
   WHERE replayed.association_id = association.id
     AND replayed.ended = 0
   GROUP BY replayed.decision_id HAVING COUNT(*) >= 1)
FROM artifact_associations AS association
;

CREATE TEMP TABLE observed_material_migration_guard (
  invalid INTEGER NOT NULL CHECK (invalid = 0)
);

INSERT INTO observed_material_migration_guard
SELECT 1 FROM observed_material_replayed
WHERE ended = 0
GROUP BY association_id HAVING COUNT(DISTINCT decision_id) <> 1;

INSERT INTO observed_material_migration_guard
SELECT 1 FROM observed_material_selected
WHERE reference IS NULL OR reference = '' OR root IS NULL OR root = ''
 OR digest IS NULL OR digest = '' OR proof_count <> 1;

INSERT INTO observed_material_migration_guard
SELECT 1
FROM observed_material_selected AS selected
LEFT JOIN observed_material_replayed AS replayed
 ON replayed.decision_id = selected.decision_id AND replayed.reference = selected.reference
GROUP BY selected.decision_id, selected.reference
HAVING COUNT(replayed.association_id) <> 1;

INSERT INTO observed_material_migration_guard
SELECT 1 FROM artifact_associations AS association
LEFT JOIN observed_material_classification AS classification
 ON classification.association_id = association.id
GROUP BY association.id HAVING COUNT(classification.association_id) <> 1;

INSERT INTO artifact_association_recognition_supports
SELECT association_id, decision_id FROM observed_material_classification
WHERE classification = 'proven-initial';

INSERT INTO observed_material_migration_guard
SELECT 1
FROM artifact_association_recognition_supports AS support
LEFT JOIN artifact_associations AS association ON association.id = support.association_id
LEFT JOIN recognition_decisions AS decision ON decision.id = support.recognition_decision_id
LEFT JOIN recognition_proposals AS proposal ON proposal.id = decision.proposal_id
WHERE association.id IS NULL OR decision.id IS NULL OR proposal.id IS NULL
 OR association.subject_id <> decision.asset_id;

DROP TABLE observed_material_migration_guard;
DROP TABLE observed_material_classification;
DROP TABLE observed_material_replayed;
DROP TABLE observed_material_selected;
