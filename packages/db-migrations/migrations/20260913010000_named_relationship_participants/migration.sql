-- 关系事实从固定主体／参与者二元组升级为具名参与者集合。生命周期仍保留其来源主体，
-- 因而来源槽位、取代和撤回的范围不因结构迁移而改变。
CREATE TABLE entity_relationships_next (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  participants_json TEXT NOT NULL,
  source_record_ids_json TEXT NOT NULL,
  qualifiers_json TEXT NOT NULL DEFAULT '[]',
  producer_json TEXT
);
CREATE TABLE entity_relationship_participants (
  relationship_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL,
  mention_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (relationship_id, entity_id, role)
);
CREATE INDEX entity_relationship_participants_entity
  ON entity_relationship_participants(entity_id);
CREATE INDEX entity_relationship_participants_relationship
  ON entity_relationship_participants(relationship_id);

INSERT INTO entity_relationships_next
  (id, type, participants_json, source_record_ids_json, qualifiers_json, producer_json)
SELECT id, type,
       json_array(
         json_object(
           'entityId', subject_id,
           'role', CASE
             WHEN type = 'bangumi.subject.related' AND role = 'bangumi.subject.sequel'
               THEN 'bangumi.subject.predecessor'
             ELSE 'asset'
           END
         ),
         json_object('entityId', participant_id, 'role', role)
       ),
       source_record_ids_json, qualifiers_json, producer_json
FROM entity_relationships;

INSERT INTO entity_relationship_participants
  (relationship_id, entity_id, role, mention_ids_json)
SELECT id, subject_id,
       CASE
         WHEN type = 'bangumi.subject.related' AND role = 'bangumi.subject.sequel'
           THEN 'bangumi.subject.predecessor'
         ELSE 'asset'
       END,
       '[]'
FROM entity_relationships;
INSERT INTO entity_relationship_participants
  (relationship_id, entity_id, role, mention_ids_json)
SELECT id, participant_id, role, '[]'
FROM entity_relationships;

ALTER TABLE relationship_lifecycles
  ADD COLUMN source_subject_id TEXT NOT NULL DEFAULT '';
UPDATE relationship_lifecycles
SET source_subject_id = (
  SELECT relationship.subject_id
  FROM entity_relationships AS relationship
  WHERE relationship.id = relationship_lifecycles.relationship_id
);

DROP TABLE entity_relationships;
ALTER TABLE entity_relationships_next RENAME TO entity_relationships;
DROP INDEX relationship_lifecycles_scope_slot;
CREATE INDEX relationship_lifecycles_scope_slot
  ON relationship_lifecycles(
    source_subject_id, source_identity, native_address, coverage_id, source_slot
  );
