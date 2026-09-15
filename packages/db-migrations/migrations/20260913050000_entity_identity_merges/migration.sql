CREATE TABLE entity_identity_merges (
  id TEXT PRIMARY KEY NOT NULL,
  retained_entity_id TEXT NOT NULL,
  merged_entity_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  impact_fingerprint TEXT NOT NULL,
  UNIQUE (actor_id, commitment_id)
);
CREATE TABLE entity_identity_merge_retractions (
  id TEXT PRIMARY KEY NOT NULL,
  merge_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  UNIQUE (merge_id)
  , UNIQUE (actor_id, commitment_id)
);
