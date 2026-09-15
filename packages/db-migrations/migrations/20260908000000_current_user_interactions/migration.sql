CREATE TABLE local_users (
  user_id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL UNIQUE REFERENCES entities(id)
);

-- 正式 prepare 唯一初始化本地 User→Person。若既有同名实体不是 Person，保留冲突
-- 供 readiness fail closed，绝不覆盖它。
INSERT INTO entities (id, kind)
SELECT 'person:local-user', 'person'
WHERE NOT EXISTS (
  SELECT 1 FROM entities WHERE id = 'person:local-user'
);
INSERT INTO local_users (user_id, person_id)
SELECT 'local-user', 'person:local-user'
WHERE EXISTS (
  SELECT 1 FROM entities
  WHERE id = 'person:local-user' AND kind = 'person'
)
  AND NOT EXISTS (
    SELECT 1 FROM local_users WHERE user_id = 'local-user'
  );

CREATE TABLE artifact_interaction_states (
  user_id TEXT NOT NULL REFERENCES local_users(user_id),
  revision_id TEXT NOT NULL REFERENCES artifact_revisions(id),
  position_milliseconds INTEGER NOT NULL CHECK (position_milliseconds >= 0),
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  PRIMARY KEY (user_id, revision_id)
);
CREATE INDEX artifact_interaction_states_revision
  ON artifact_interaction_states (revision_id);
