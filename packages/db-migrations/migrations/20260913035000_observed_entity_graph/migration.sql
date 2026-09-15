CREATE TABLE observed_entity_graph_supports (
  id TEXT PRIMARY KEY NOT NULL,
  recognition_decision_id TEXT NOT NULL REFERENCES recognition_decisions(id),
  asset_id TEXT NOT NULL REFERENCES entities(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  revision_id TEXT NOT NULL REFERENCES artifact_revisions(id),
  producer_json TEXT NOT NULL,
  coverage_id TEXT NOT NULL,
  UNIQUE(recognition_decision_id, artifact_id, revision_id, producer_json, coverage_id)
);
CREATE INDEX observed_entity_graph_supports_current
  ON observed_entity_graph_supports(asset_id, recognition_decision_id);

CREATE TABLE observed_entities (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  producer_json TEXT NOT NULL,
  coverage_id TEXT NOT NULL,
  occurrence_slot TEXT NOT NULL,
  preserved_value TEXT NOT NULL,
  label TEXT NOT NULL,
  locator TEXT NOT NULL
);
CREATE UNIQUE INDEX observed_entities_local_identity
  ON observed_entities(asset_id, artifact_id, producer_json, coverage_id, occurrence_slot, preserved_value);

CREATE TABLE observed_entity_graph_entities (
  graph_id TEXT NOT NULL REFERENCES observed_entity_graph_supports(id),
  entity_id TEXT NOT NULL REFERENCES observed_entities(id),
  PRIMARY KEY(graph_id, entity_id)
);
CREATE INDEX observed_entity_graph_entities_entity
  ON observed_entity_graph_entities(entity_id);

CREATE TABLE observed_entity_mentions (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  source_slot TEXT NOT NULL,
  field TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT NOT NULL,
  locator TEXT NOT NULL
);
CREATE INDEX observed_entity_mentions_entity ON observed_entity_mentions(entity_id);

CREATE TABLE observed_entity_resolutions (
  mention_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (mention_id, entity_id)
);
CREATE TABLE observed_entity_graph_relationships (
  graph_id TEXT NOT NULL REFERENCES observed_entity_graph_supports(id),
  relationship_id TEXT NOT NULL REFERENCES entity_relationships(id),
  source_slot TEXT NOT NULL,
  PRIMARY KEY(graph_id, relationship_id)
);
CREATE INDEX observed_entity_graph_relationships_relationship
  ON observed_entity_graph_relationships(relationship_id);
