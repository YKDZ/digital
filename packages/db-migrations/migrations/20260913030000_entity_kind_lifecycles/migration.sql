CREATE TABLE local_entity_commitments (
  actor_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  label TEXT NOT NULL,
  submitted_kind TEXT NOT NULL CHECK (submitted_kind IN ('entity', 'person', 'persona')),
  PRIMARY KEY (actor_id, commitment_id)
);

CREATE TABLE entity_kind_source_supports (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL,
  source_subject_id TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  native_address TEXT NOT NULL,
  coverage_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  assertion_id TEXT,
  predecessor_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('assert', 'retract'))
);
CREATE UNIQUE INDEX entity_kind_source_support_predecessor
  ON entity_kind_source_supports (predecessor_id);
CREATE INDEX entity_kind_source_support_scope
  ON entity_kind_source_supports (entity_id, source_subject_id, source_identity, native_address, coverage_id);

CREATE TABLE entity_kind_assertions_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('digital-asset', 'person', 'persona')),
  basis TEXT NOT NULL,
  source_record_ids_json TEXT NOT NULL DEFAULT '[]',
  actor_id TEXT,
  producer_json TEXT
);
INSERT INTO entity_kind_assertions_v3
SELECT id, entity_id, kind, basis, source_record_ids_json, actor_id, producer_json
FROM entity_kind_assertions;
DROP TABLE entity_kind_assertions;
ALTER TABLE entity_kind_assertions_v3 RENAME TO entity_kind_assertions;
CREATE INDEX entity_kind_assertions_entity ON entity_kind_assertions (entity_id);
