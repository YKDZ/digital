-- 本地关联支持在决定授权之外，同时保存建立它的那一次精确观察证据。
-- 证据整体为空表示迁移前的历史支持，只按原提案载体回查，不被当作当前观察。
ALTER TABLE `artifact_association_recognition_supports` ADD `observation_execution_id` text;
--> statement-breakpoint
ALTER TABLE `artifact_association_recognition_supports` ADD `observation_snapshot_id` text;
--> statement-breakpoint
ALTER TABLE `artifact_association_recognition_supports` ADD `observation_location_id` text;
--> statement-breakpoint
ALTER TABLE `artifact_association_recognition_supports` ADD `observation_material_kind` text;
--> statement-breakpoint
ALTER TABLE `artifact_association_recognition_supports` ADD `observation_revision_id` text;
--> statement-breakpoint
CREATE INDEX `artifact_association_recognition_supports_location` ON `artifact_association_recognition_supports` (`observation_location_id`);
