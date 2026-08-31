CREATE TABLE `recognition_proposals_next` (
	`id` text NOT NULL,
	`execution_id` text NOT NULL,
	`basis_json` text NOT NULL,
	`rule_results_json` text NOT NULL,
	CONSTRAINT `recognition_proposals_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

INSERT INTO `recognition_proposals_next` (
	`id`, `execution_id`, `basis_json`, `rule_results_json`
)
SELECT
	`id`,
	`execution_id`,
	json_object(
		'kind', 'source-interpretation',
		'interpretation', json(`interpretation_json`)
	),
	`rule_results_json`
FROM `recognition_proposals`;
--> statement-breakpoint

DROP TABLE `recognition_proposals`;
--> statement-breakpoint

ALTER TABLE `recognition_proposals_next` RENAME TO `recognition_proposals`;
--> statement-breakpoint

CREATE INDEX `recognition_proposals_execution`
	ON `recognition_proposals` (`execution_id`);
--> statement-breakpoint

CREATE TABLE `recognition_heads_next` (
	`subject_id` text NOT NULL,
	`recognition_decision_id` text NOT NULL,
	`recognition_source_association_id` text,
	CONSTRAINT `recognition_heads_pk` PRIMARY KEY(`subject_id`)
);
--> statement-breakpoint

INSERT INTO `recognition_heads_next` (
	`subject_id`,
	`recognition_decision_id`,
	`recognition_source_association_id`
)
SELECT `subject_id`, `recognition_decision_id`, `association_id`
FROM `source_association_heads`;
--> statement-breakpoint

DROP TABLE `source_association_heads`;
--> statement-breakpoint

ALTER TABLE `recognition_heads_next` RENAME TO `recognition_heads`;
