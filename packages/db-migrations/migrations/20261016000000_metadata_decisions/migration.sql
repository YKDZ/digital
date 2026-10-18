-- 人工元数据决定按精确目标、属性与使用语境保留仅追加历史及当前头。
CREATE TABLE `metadata_decisions` (
	`id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_entity_id` text,
	`target_artifact_id` text,
	`target_revision_id` text,
	`property` text NOT NULL,
	`metadata_usage_context` text NOT NULL,
	`kind` text NOT NULL,
	`value` text,
	`qualifiers_json` text,
	`adopted_from_json` text,
	`predecessor_decision_id` text,
	`initiated_by` text NOT NULL,
	CONSTRAINT `metadata_decisions_pk` PRIMARY KEY(`id`),
	CONSTRAINT `metadata_decisions_target` CHECK ((target_kind = 'entity' AND target_entity_id IS NOT NULL AND target_artifact_id IS NULL AND target_revision_id IS NULL) OR (target_kind = 'artifact-revision' AND target_entity_id IS NULL AND target_artifact_id IS NOT NULL AND target_revision_id IS NOT NULL)),
	CONSTRAINT `metadata_decisions_value` CHECK ((kind = 'pin' AND value IS NOT NULL) OR (kind = 'clear' AND value IS NULL AND qualifiers_json IS NULL AND adopted_from_json IS NULL))
);

CREATE INDEX `metadata_decisions_predecessor` ON `metadata_decisions` (`predecessor_decision_id`);
--> statement-breakpoint
CREATE INDEX `metadata_decisions_coordinate` ON `metadata_decisions` (`target_kind`,`target_entity_id`,`target_artifact_id`,`target_revision_id`,`property`,`metadata_usage_context`);
--> statement-breakpoint
CREATE TABLE `metadata_decision_heads` (
	`target_key` text NOT NULL,
	`decision_id` text NOT NULL,
	CONSTRAINT `metadata_decision_heads_pk` PRIMARY KEY(`target_key`)
);
