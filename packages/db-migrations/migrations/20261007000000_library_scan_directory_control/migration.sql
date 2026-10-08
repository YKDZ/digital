-- 一次耐久库扫描父执行的目录条目：与目录子执行在同一条事务内登记，避免崩溃孤儿。
CREATE TABLE `library_scan_directories` (
	`parent_execution_id` text NOT NULL,
	`directory_key` text NOT NULL,
	`scope_reference` text NOT NULL,
	`root_version` integer NOT NULL,
	`relative_scope` text NOT NULL,
	`mode` text NOT NULL,
	`executed_by_key` text,
	`covered_prefix` text,
	`child_execution_id` text,
	`stage` text NOT NULL,
	`outcome` text,
	`reason` text,
	`work_item_count` integer NOT NULL,
	`unresolved_count` integer NOT NULL,
	`failed_count` integer NOT NULL,
	`position` integer NOT NULL,
	CONSTRAINT `library_scan_directories_pk` PRIMARY KEY(`parent_execution_id`, `directory_key`)
);
--> statement-breakpoint
CREATE INDEX `library_scan_directories_parent` ON `library_scan_directories` (`parent_execution_id`);
--> statement-breakpoint
CREATE INDEX `library_scan_directories_child` ON `library_scan_directories` (`child_execution_id`);
--> statement-breakpoint
CREATE TABLE `library_scan_cancellations` (
	`parent_execution_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` text NOT NULL,
	`reason` text,
	CONSTRAINT `library_scan_cancellations_pk` PRIMARY KEY(`parent_execution_id`)
);
