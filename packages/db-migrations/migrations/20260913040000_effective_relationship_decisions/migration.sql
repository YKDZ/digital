CREATE TABLE relationship_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  coordinate_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  relationship_ids_json TEXT NOT NULL DEFAULT '[]',
  manual_relationship_id TEXT,
  actor_id TEXT NOT NULL
);
CREATE TABLE relationship_decision_heads (
  coordinate_key TEXT PRIMARY KEY NOT NULL,
  decision_id TEXT NOT NULL
);
CREATE TABLE relationship_manual_supports (
  relationship_id TEXT PRIMARY KEY NOT NULL,
  decision_id TEXT NOT NULL
);
CREATE INDEX relationship_manual_supports_decision
  ON relationship_manual_supports(decision_id);

-- Position is relationship context, never a global asset field.
DELETE FROM metadata_assertion_lifecycles
WHERE assertion_id IN (
  SELECT id FROM metadata_assertions WHERE property = 'asset.series-position'
);
DELETE FROM metadata_assertion_retractions
WHERE assertion_id IN (
  SELECT id FROM metadata_assertions WHERE property = 'asset.series-position'
);
DELETE FROM metadata_assertions WHERE property = 'asset.series-position';
