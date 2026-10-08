-- 人工产物角色决定：中立目标加角色的仅追加历史，与按规范化坐标唯一的当前头。
CREATE TABLE `artifact_role_decisions` (
	`id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_entity_id` text,
	`target_artifact_id` text,
	`target_revision_id` text,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`selected_association_id` text,
	`selected_artifact_id` text,
	`selected_revision_id` text,
	`predecessor_decision_id` text,
	`initiated_by` text NOT NULL,
	CONSTRAINT `artifact_role_decisions_pk` PRIMARY KEY(`id`),
	CONSTRAINT `artifact_role_decisions_target` CHECK ((target_kind = 'entity' AND target_entity_id IS NOT NULL AND target_artifact_id IS NULL AND target_revision_id IS NULL) OR (target_kind = 'artifact-revision' AND target_entity_id IS NULL AND target_artifact_id IS NOT NULL AND target_revision_id IS NOT NULL)),
	CONSTRAINT `artifact_role_decisions_selection` CHECK ((kind = 'select' AND selected_association_id IS NOT NULL AND selected_artifact_id IS NOT NULL AND selected_revision_id IS NOT NULL) OR (kind = 'clear' AND selected_association_id IS NULL AND selected_artifact_id IS NULL AND selected_revision_id IS NULL))
);

CREATE INDEX `artifact_role_decisions_predecessor` ON `artifact_role_decisions` (`predecessor_decision_id`);

--> statement-breakpoint
CREATE TABLE `artifact_role_decision_heads` (
	`target_key` text NOT NULL,
	`decision_id` text NOT NULL,
	CONSTRAINT `artifact_role_decision_heads_pk` PRIMARY KEY(`target_key`)
);
