-- 产品用户不再绑定人物实体：把用户注册重建为单列，并逐行保全精确修订版交互状态。
CREATE TABLE local_users_v2 (
  user_id TEXT PRIMARY KEY NOT NULL
);
INSERT INTO local_users_v2 (user_id)
SELECT user_id FROM local_users;

CREATE TABLE artifact_interaction_states_v2 (
  user_id TEXT NOT NULL REFERENCES local_users_v2(user_id),
  revision_id TEXT NOT NULL REFERENCES artifact_revisions(id),
  position_milliseconds INTEGER NOT NULL CHECK (position_milliseconds >= 0),
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  PRIMARY KEY (user_id, revision_id)
);
INSERT INTO artifact_interaction_states_v2 (
  user_id, revision_id, position_milliseconds, completed
)
SELECT user_id, revision_id, position_milliseconds, completed
FROM artifact_interaction_states;

DROP TABLE artifact_interaction_states;
DROP TABLE local_users;
ALTER TABLE local_users_v2 RENAME TO local_users;
ALTER TABLE artifact_interaction_states_v2 RENAME TO artifact_interaction_states;
CREATE INDEX artifact_interaction_states_revision
  ON artifact_interaction_states (revision_id);

-- 只有本次 prepare 从空目录运行完整冻结历史时，冻结迁移刚生成、尚未对外成为产品数据的
-- 引导节点才随绑定一起消失；既有 catalogue 的人物实体与其全部事实保持原状。
DELETE FROM entity_kind_assertions
WHERE entity_id = 'person:local-user'
  AND basis = 'legacy-migration'
  AND EXISTS (
    SELECT 1 FROM temp.__digital_prepare_context WHERE fresh_catalogue = 1
  );
DELETE FROM entities
WHERE id = 'person:local-user'
  AND EXISTS (
    SELECT 1 FROM temp.__digital_prepare_context WHERE fresh_catalogue = 1
  );
