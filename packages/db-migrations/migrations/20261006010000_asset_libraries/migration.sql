CREATE TABLE asset_libraries (
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  root_ids_json TEXT NOT NULL,
  recognition_profile_ids_json TEXT NOT NULL,
  source_identities_json TEXT NOT NULL,
  PRIMARY KEY (id)
);

-- 既有目录配置转为一个资产库，保留根身份和原来全部已部署能力的选择。
-- 只迁移配置，不重新解释资产、不改写用户文件。
INSERT INTO asset_libraries (id, display_name, config_version, status, root_ids_json, recognition_profile_ids_json, source_identities_json)
SELECT 'asset_library_legacy_' || id, display_name, 1,
       CASE WHEN status = 'active' THEN 'active' ELSE 'removed' END,
       json_array(id),
       '["anime","books","dlsite-voice","fanbox","movies"]',
       '["bangumi","dlsite","fanbox","kadokawa-jp","nbinet","omdb","taiwan-kadokawa","tmdb"]'
FROM observed_root_registrations;

-- 既有周期设置继续使用原目录，并绑定迁移产生的资产库配置。
UPDATE automation_intents
SET scope_json = json_set(scope_json, '$.assetLibraryId', 'asset_library_legacy_' || json_extract(scope_json, '$.observedRootId'))
WHERE json_valid(scope_json)
  AND json_extract(scope_json, '$.observedRootId') IN (SELECT id FROM observed_root_registrations);
