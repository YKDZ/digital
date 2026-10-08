-- 一个活动库对一个稳定物理根的最小耐久 I/O 授权；removed 行保留以支持点名重连与历史连续性。
CREATE TABLE `library_directory_grants` (
	`id` text NOT NULL,
	`library_id` text NOT NULL,
	`observed_root_id` text NOT NULL,
	`status` text NOT NULL,
	`authority_version` integer NOT NULL,
	`symlink_mode` text NOT NULL,
	`allowed_target_grant_ids_json` text NOT NULL,
	CONSTRAINT `library_directory_grants_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_directory_grants_library_root` ON `library_directory_grants` (`library_id`, `observed_root_id`);
--> statement-breakpoint
CREATE INDEX `library_directory_grants_library` ON `library_directory_grants` (`library_id`);
--> statement-breakpoint
CREATE INDEX `library_directory_grants_root` ON `library_directory_grants` (`observed_root_id`);
--> statement-breakpoint
-- 既有库目录引用逐条落成 v1 活动授权；链接策略沿用原全局字段，之后编辑只影响本库。
INSERT INTO `library_directory_grants` (
	`id`,
	`library_id`,
	`observed_root_id`,
	`status`,
	`authority_version`,
	`symlink_mode`,
	`allowed_target_grant_ids_json`
)
SELECT
	'library_directory_grant_' || `l`.`id` || '_' || `root`.`value`,
	`l`.`id`,
	`root`.`value`,
	'active',
	1,
	`o`.`symlink_mode`,
	'[]'
FROM `asset_libraries` AS `l`,
	json_each(`l`.`root_ids_json`) AS `root`
JOIN `observed_root_registrations` AS `o` ON `o`.`id` = `root`.`value`
WHERE `l`.`status` = 'active';
--> statement-breakpoint
-- 原全局允许目标按同库授权 ID 复制；不在本库目录集合中的旧引用不进入本库授权闭包。
UPDATE `library_directory_grants`
SET `allowed_target_grant_ids_json` = COALESCE((
		SELECT json_group_array(`target`.`id`)
		FROM `observed_root_registrations` AS `source`,
			json_each(`source`.`allowed_target_root_ids_json`) AS `target_root`
		JOIN `library_directory_grants` AS `target` ON `target`.`library_id` = `library_directory_grants`.`library_id`
			AND `target`.`observed_root_id` = `target_root`.`value`
		WHERE `source`.`id` = `library_directory_grants`.`observed_root_id`
	), '[]');
