CREATE TABLE `current_file_observation_supports` (
	`location_id` text NOT NULL,
	`observed_root_id` text NOT NULL,
	`observed_root_version` integer NOT NULL,
	`observed_root_path` text NOT NULL,
	`authorized_targets_json` text NOT NULL DEFAULT '[]',
	CONSTRAINT `current_file_observation_supports_pk` PRIMARY KEY(`location_id`, `observed_root_id`, `observed_root_version`)
);
--> statement-breakpoint
CREATE INDEX `current_file_observation_supports_root` ON `current_file_observation_supports` (`observed_root_id`,`observed_root_version`);
