-- 实体身份独立于种类稳定；先把历史判别列迁移为可审计断言，再删除该列。
CREATE TABLE entity_kind_assertions (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('digital-asset', 'person', 'persona')),
  basis TEXT NOT NULL,
  source_record_ids_json TEXT NOT NULL DEFAULT '[]',
  actor_id TEXT,
  producer_json TEXT,
  UNIQUE (entity_id, kind, basis)
);
CREATE INDEX entity_kind_assertions_entity ON entity_kind_assertions(entity_id);

INSERT INTO entity_kind_assertions (id, entity_id, kind, basis, source_record_ids_json)
SELECT 'legacy-entity-kind:' || id, id, kind, 'legacy-migration', '[]'
FROM entities
WHERE kind <> 'entity';

CREATE TABLE entity_kind_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL,
  selected_kind TEXT CHECK (selected_kind IS NULL OR selected_kind IN ('digital-asset', 'person', 'persona')),
  basis TEXT NOT NULL,
  replaces_decision_id TEXT,
  actor_id TEXT,
  operation TEXT NOT NULL DEFAULT 'select'
);
CREATE INDEX entity_kind_decisions_entity ON entity_kind_decisions(entity_id);

CREATE TABLE local_entity_names (
  entity_id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  actor_id TEXT NOT NULL
);
CREATE INDEX local_entity_names_label ON local_entity_names(label);

ALTER TABLE entity_resolution_decisions ADD COLUMN basis TEXT NOT NULL DEFAULT 'source';
ALTER TABLE entity_resolution_decisions ADD COLUMN replaces_decision_id TEXT;
ALTER TABLE entity_resolution_decisions ADD COLUMN actor_id TEXT;
ALTER TABLE entity_resolution_decisions ADD COLUMN operation TEXT NOT NULL DEFAULT 'select';

ALTER TABLE entities DROP COLUMN kind;
