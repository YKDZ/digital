-- 自动化库扫描父的父后信息履行处置账本：批次壳与父执行同事务建立，计划与 child 绑定各自窄事务收口。
CREATE TABLE `library_scan_fulfillment_batches` (
	`parent_execution_id` text NOT NULL,
	`version` text NOT NULL,
	`planner_coordinate` text NOT NULL,
	`stage` text NOT NULL,
	`reason` text,
	`planned_at` text,
	CONSTRAINT `library_scan_fulfillment_batches_pk` PRIMARY KEY(`parent_execution_id`)
);
--> statement-breakpoint
CREATE TABLE `library_scan_fulfillment_subjects` (
	`parent_execution_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`disposition` text NOT NULL,
	`requirement_json` text,
	`reason` text,
	`position` integer NOT NULL,
	CONSTRAINT `library_scan_fulfillment_subjects_pk` PRIMARY KEY(`parent_execution_id`, `subject_id`)
);
--> statement-breakpoint
CREATE INDEX `library_scan_fulfillment_subjects_parent` ON `library_scan_fulfillment_subjects` (`parent_execution_id`);
--> statement-breakpoint
CREATE TABLE `library_scan_fulfillment_operations` (
	`parent_execution_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`plan_json` text,
	`child_execution_id` text,
	`disposition` text NOT NULL,
	`reason` text,
	`position` integer NOT NULL,
	CONSTRAINT `library_scan_fulfillment_operations_pk` PRIMARY KEY(`parent_execution_id`, `operation_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_scan_fulfillment_operations_child` ON `library_scan_fulfillment_operations` (`child_execution_id`);
--> statement-breakpoint
CREATE INDEX `library_scan_fulfillment_operations_parent_subject` ON `library_scan_fulfillment_operations` (`parent_execution_id`, `subject_id`);
--> statement-breakpoint
CREATE INDEX `library_scan_fulfillment_operations_disposition` ON `library_scan_fulfillment_operations` (`disposition`);
