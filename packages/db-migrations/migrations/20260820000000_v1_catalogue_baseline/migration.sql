CREATE TABLE `artifact_association_retractions` (
	`id` text NOT NULL,
	`association_id` text NOT NULL,
	`recognition_decision_id` text,
	`proposal_id` text,
	`source_record_ids_json` text DEFAULT '[]' NOT NULL,
	CONSTRAINT `artifact_association_retractions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `artifact_association_supersessions` (
	`id` text NOT NULL,
	`predecessor_association_id` text NOT NULL,
	`successor_association_id` text NOT NULL,
	CONSTRAINT `artifact_association_supersessions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `artifact_associations` (
	`id` text NOT NULL,
	`subject_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`role` text NOT NULL,
	`source_record_ids_json` text DEFAULT '[]' NOT NULL,
	`observed_artifact_part_json` text,
	`producer_json` text,
	`source_association_id` text,
	CONSTRAINT `artifact_associations_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `artifact_revisions` (
	`id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`blob_digest` text NOT NULL,
	`producer_json` text,
	CONSTRAINT `artifact_revisions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `artifacts` (
	`id` text NOT NULL,
	CONSTRAINT `artifacts_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `automation_intents` (
	`id` text NOT NULL,
	`scope_json` text NOT NULL,
	`enabled` integer NOT NULL,
	`disabled_reason` text,
	`interval_milliseconds` integer NOT NULL,
	`workflow_input_version` text NOT NULL,
	`policy_references_json` text NOT NULL,
	`accept_trusted` integer NOT NULL,
	`run_initial` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `automation_intents_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `automation_runtime` (
	`intent_id` text NOT NULL,
	`active_execution_id` text,
	`last_automatic_trigger_at` text,
	CONSTRAINT `automation_runtime_pk` PRIMARY KEY(`intent_id`)
);
--> statement-breakpoint

CREATE TABLE `blobs` (
	`digest` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	CONSTRAINT `blobs_pk` PRIMARY KEY(`digest`)
);
--> statement-breakpoint

CREATE TABLE `change_impact_previews` (
	`id` text NOT NULL,
	`execution_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`preview_json` text NOT NULL,
	`status` text GENERATED ALWAYS AS (json_extract(preview_json, '$.status')) VIRTUAL,
	CONSTRAINT `change_impact_previews_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `current_source_artifact_candidate_lineages` (
	`subject_id` text NOT NULL,
	`source_association_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`native_address` text NOT NULL,
	`coverage_id` text NOT NULL,
	`source_record_id` text NOT NULL,
	`interpretation_json` text NOT NULL,
	CONSTRAINT `current_source_artifact_candidate_lineages_pk` PRIMARY KEY(`subject_id`, `source_association_id`, `source_identity`, `native_address`, `coverage_id`)
);
--> statement-breakpoint

CREATE TABLE `current_source_associations` (
	`subject_id` text NOT NULL,
	`association_id` text NOT NULL,
	CONSTRAINT `current_source_associations_pk` PRIMARY KEY(`subject_id`, `association_id`)
);
--> statement-breakpoint

CREATE TABLE `entities` (
	`id` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `entities_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `entity_mentions` (
	`id` text NOT NULL,
	`source_identity` text NOT NULL,
	`field` text NOT NULL,
	`role` text NOT NULL,
	`label` text NOT NULL,
	`identity_namespace` text NOT NULL,
	`source_key` text NOT NULL,
	`source_record_ids_json` text NOT NULL,
	`producer_json` text,
	CONSTRAINT `entity_mentions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `entity_relationships` (
	`id` text NOT NULL,
	`subject_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`type` text NOT NULL,
	`role` text NOT NULL,
	`source_record_ids_json` text NOT NULL,
	`is_current` integer DEFAULT 1 NOT NULL,
	`qualifiers_json` text DEFAULT '[]' NOT NULL,
	`producer_json` text,
	CONSTRAINT `entity_relationships_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `entity_resolution_decisions` (
	`id` text NOT NULL,
	`mention_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`rule` text NOT NULL,
	`source_record_ids_json` text NOT NULL,
	`producer_json` text,
	CONSTRAINT `entity_resolution_decisions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `locations` (
	`id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`address` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `locations_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `metadata_assertion_lifecycles` (
	`assertion_id` INTEGER NOT NULL,
	`source_identity` text NOT NULL,
	`native_address` text NOT NULL,
	`coverage_id` text NOT NULL,
	`source_slot` text NOT NULL,
	`source_record_id` text NOT NULL,
	`predecessor_assertion_id` integer,
	CONSTRAINT `metadata_assertion_lifecycles_pk` PRIMARY KEY(`assertion_id`)
);
--> statement-breakpoint

CREATE TABLE `metadata_assertion_retractions` (
	`id` text NOT NULL,
	`assertion_id` integer NOT NULL,
	`source_record_id` text NOT NULL,
	CONSTRAINT `metadata_assertion_retractions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `metadata_assertion_sources` (
	`assertion_id` integer NOT NULL,
	`source_record_id` text NOT NULL,
	CONSTRAINT `metadata_assertion_sources_pk` PRIMARY KEY(`assertion_id`, `source_record_id`)
);
--> statement-breakpoint

CREATE TABLE `metadata_assertions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`subject_id` text NOT NULL,
	`property` text NOT NULL,
	`value` text NOT NULL,
	`source_record_ids_json` text NOT NULL,
	`is_current` integer DEFAULT 1 NOT NULL,
	`source_slot` text,
	`observed_artifact_part_json` text,
	`qualifiers_json` text DEFAULT '[]' NOT NULL,
	`producer_json` text
);
--> statement-breakpoint

CREATE TABLE `metadata_policy_enrollments` (
	`subject_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`execution_id` text NOT NULL,
	CONSTRAINT `metadata_policy_enrollments_pk` PRIMARY KEY(`subject_id`, `policy_id`)
);
--> statement-breakpoint

CREATE TABLE `observed_root_registrations` (
	`id` text NOT NULL,
	`display_name` text NOT NULL,
	`container_path` text NOT NULL,
	`canonical_path` text NOT NULL,
	`status` text NOT NULL,
	`config_version` integer NOT NULL,
	`read_only` integer NOT NULL,
	`symlink_mode` text NOT NULL,
	`allowed_target_root_ids_json` text NOT NULL,
	CONSTRAINT `observed_root_registrations_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `recognition_decision_supersessions` (
	`id` text NOT NULL,
	`predecessor_decision_id` text NOT NULL,
	`successor_decision_id` text NOT NULL,
	CONSTRAINT `recognition_decision_supersessions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `recognition_decisions` (
	`id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`accepted_rule_results_json` text NOT NULL,
	CONSTRAINT `recognition_decisions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `recognition_proposals` (
	`id` text NOT NULL,
	`execution_id` text NOT NULL,
	`interpretation_json` text NOT NULL,
	`rule_results_json` text NOT NULL,
	CONSTRAINT `recognition_proposals_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `relationship_lifecycles` (
	`relationship_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`native_address` text NOT NULL,
	`coverage_id` text NOT NULL,
	`source_record_id` text NOT NULL,
	`source_slot` text DEFAULT '' NOT NULL,
	`predecessor_relationship_id` text,
	CONSTRAINT `relationship_lifecycles_pk` PRIMARY KEY(`relationship_id`)
);
--> statement-breakpoint

CREATE TABLE `relationship_retractions` (
	`id` text NOT NULL,
	`relationship_id` text NOT NULL,
	`source_record_id` text NOT NULL,
	CONSTRAINT `relationship_retractions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `relationship_sources` (
	`relationship_id` text NOT NULL,
	`source_record_id` text NOT NULL,
	CONSTRAINT `relationship_sources_pk` PRIMARY KEY(`relationship_id`, `source_record_id`)
);
--> statement-breakpoint

CREATE TABLE `schema_migrations` (
	`id` text NOT NULL,
	`applied_at` text NOT NULL,
	CONSTRAINT `schema_migrations_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `source_association_heads` (
	`subject_id` text NOT NULL,
	`association_id` text NOT NULL,
	`recognition_decision_id` text NOT NULL,
	CONSTRAINT `source_association_heads_pk` PRIMARY KEY(`subject_id`)
);
--> statement-breakpoint

CREATE TABLE `source_associations` (
	`id` text NOT NULL,
	`subject_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`native_address` text NOT NULL,
	`proposal_id` text NOT NULL,
	`is_current` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `source_associations_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `source_lineage_heads` (
	`subject_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`native_address` text NOT NULL,
	`coverage_id` text NOT NULL,
	`source_record_id` text NOT NULL,
	CONSTRAINT `source_lineage_heads_pk` PRIMARY KEY(`subject_id`, `source_identity`, `native_address`, `coverage_id`)
);
--> statement-breakpoint

CREATE TABLE `source_records` (
	`id` text NOT NULL,
	`execution_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`native_address` text NOT NULL,
	`media_type` text NOT NULL,
	`acquired_at` text NOT NULL,
	`acquisition_json` text NOT NULL,
	`coverage_json` text NOT NULL,
	`digest` text NOT NULL,
	`body` text NOT NULL,
	`producer_json` text,
	CONSTRAINT `source_records_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `source_refresh_change_sets` (
	`id` text NOT NULL,
	`run_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`native_address` text NOT NULL,
	`coverage_id` text NOT NULL,
	`baseline_source_record_id` text,
	`candidate_source_record_id` text NOT NULL,
	`changes_json` text NOT NULL,
	`interpretation_json` text NOT NULL,
	`requires_review` integer NOT NULL,
	`disposition` text NOT NULL,
	CONSTRAINT `source_refresh_change_sets_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `source_refresh_changes` (
	`id` text NOT NULL,
	`execution_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`native_address` text NOT NULL,
	`coverage_id` text NOT NULL,
	`baseline_source_record_id` text,
	`source_record_id` text NOT NULL,
	`completeness` text NOT NULL,
	CONSTRAINT `source_refresh_changes_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `source_refresh_runs` (
	`id` text NOT NULL,
	`workflow_execution_id` text NOT NULL,
	`initiated_by` text NOT NULL,
	`initiated_at` text NOT NULL,
	`requested_selection_json` text NOT NULL,
	`review_policy` text NOT NULL,
	CONSTRAINT `source_refresh_runs_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `source_refresh_scopes` (
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`source_identity` text NOT NULL,
	`native_address` text NOT NULL,
	`coverage_id` text NOT NULL,
	`baseline_source_record_id` text,
	`state` text NOT NULL,
	`change_set_id` text,
	`candidate_source_record_id` text,
	`outcome` text,
	`reason` text,
	`acquisition_attempt` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `source_refresh_scopes_pk` PRIMARY KEY(`run_id`, `source_identity`, `native_address`, `coverage_id`)
);
--> statement-breakpoint

CREATE TABLE `sourced_entities` (
	`id` text NOT NULL,
	`source_identity` text NOT NULL,
	`source_key` text NOT NULL,
	`identity_namespace` text NOT NULL,
	`label` text NOT NULL,
	`role` text,
	`source_record_ids_json` text NOT NULL,
	`producer_json` text,
	CONSTRAINT `sourced_entities_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `workflow_executions` (
	`id` text NOT NULL,
	`selection_directory` text,
	`snapshot_json` text,
	`status` text NOT NULL,
	`stage` text NOT NULL,
	`outcome` text,
	`source_record_ids_json` text NOT NULL,
	`proposal_id` text,
	`accepted_asset_id` text,
	`reason` text,
	`reuse_plan_json` text,
	`reused_execution_id` text,
	`selection_intent` text DEFAULT 'scan-now' NOT NULL,
	`compatibility_json` text NOT NULL,
	`dispositions_json` text DEFAULT '[]' NOT NULL,
	`cover_acquisition_json` text,
	`managed_cover_json` text,
	`automation_intent_id` text,
	`trigger_kind` text,
	`information_requirement_json` text NOT NULL,
	`resume_claim_token` text,
	`resume_claim_expires_at` text,
	`work_items_json` text DEFAULT '[]' NOT NULL,
	`operation_kind` text,
	`requested_selection_json` text,
	`resolved_selection_json` text,
	`target_dispositions_json` text,
	`filesystem_snapshots_json` text,
	`source_enrichments_json` text DEFAULT '[]' NOT NULL,
	`source_refresh_run_ids_json` text DEFAULT '[]' NOT NULL,
	`audit_json` text,
	`workflow_input_json` text,
	`cancellation_json` text,
	CONSTRAINT `workflow_executions_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE UNIQUE INDEX `artifact_association_retractions_association` ON `artifact_association_retractions` (`association_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `artifact_association_supersessions_predecessor` ON `artifact_association_supersessions` (`predecessor_association_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `artifact_association_supersessions_successor` ON `artifact_association_supersessions` (`successor_association_id`);
--> statement-breakpoint

CREATE INDEX `artifact_associations_source_association_role` ON `artifact_associations` (`subject_id`,`source_association_id`,`role`);
--> statement-breakpoint

CREATE INDEX `artifact_associations_subject` ON `artifact_associations` (`subject_id`);
--> statement-breakpoint

CREATE INDEX `artifact_revisions_artifact` ON `artifact_revisions` (`artifact_id`);
--> statement-breakpoint

CREATE INDEX `artifact_revisions_blob` ON `artifact_revisions` (`blob_digest`);
--> statement-breakpoint

CREATE INDEX `change_impact_previews_asset` ON `change_impact_previews` (`asset_id`);
--> statement-breakpoint

CREATE INDEX `change_impact_previews_execution` ON `change_impact_previews` (`execution_id`);
--> statement-breakpoint

CREATE INDEX `change_impact_previews_status` ON `change_impact_previews` (`status`);
--> statement-breakpoint

CREATE INDEX `current_source_artifact_candidate_lineages_current` ON `current_source_artifact_candidate_lineages` (`subject_id`,`source_association_id`,`source_identity`,`native_address`,`source_record_id`);
--> statement-breakpoint

CREATE INDEX `entity_mentions_source_key` ON `entity_mentions` (`source_identity`,`source_key`);
--> statement-breakpoint

CREATE INDEX `entity_relationships_participant` ON `entity_relationships` (`participant_id`);
--> statement-breakpoint

CREATE INDEX `entity_relationships_subject` ON `entity_relationships` (`subject_id`);
--> statement-breakpoint

CREATE INDEX `entity_relationships_subject_type` ON `entity_relationships` (`subject_id`,`type`);
--> statement-breakpoint

CREATE INDEX `entity_resolution_decisions_entity` ON `entity_resolution_decisions` (`entity_id`);
--> statement-breakpoint

CREATE INDEX `entity_resolution_decisions_mention` ON `entity_resolution_decisions` (`mention_id`);
--> statement-breakpoint

CREATE INDEX `locations_address` ON `locations` (`address`);
--> statement-breakpoint

CREATE INDEX `locations_artifact` ON `locations` (`artifact_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `metadata_assertion_lifecycles_predecessor` ON `metadata_assertion_lifecycles` (`predecessor_assertion_id`);
--> statement-breakpoint

CREATE INDEX `metadata_assertion_lifecycles_scope_slot` ON `metadata_assertion_lifecycles` (`source_identity`,`native_address`,`coverage_id`,`source_slot`);
--> statement-breakpoint

CREATE UNIQUE INDEX `metadata_assertion_retractions_assertion` ON `metadata_assertion_retractions` (`assertion_id`);
--> statement-breakpoint

CREATE INDEX `metadata_assertions_subject_property` ON `metadata_assertions` (`subject_id`,`property`);
--> statement-breakpoint

CREATE INDEX `observed_root_registrations_canonical_path` ON `observed_root_registrations` (`canonical_path`);
--> statement-breakpoint

CREATE INDEX `observed_root_registrations_container_path` ON `observed_root_registrations` (`container_path`);
--> statement-breakpoint

CREATE INDEX `observed_root_registrations_status` ON `observed_root_registrations` (`status`);
--> statement-breakpoint

CREATE UNIQUE INDEX `recognition_decision_supersessions_predecessor` ON `recognition_decision_supersessions` (`predecessor_decision_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `recognition_decision_supersessions_successor` ON `recognition_decision_supersessions` (`successor_decision_id`);
--> statement-breakpoint

CREATE INDEX `recognition_decisions_asset` ON `recognition_decisions` (`asset_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `recognition_decisions_proposal` ON `recognition_decisions` (`proposal_id`);
--> statement-breakpoint

CREATE INDEX `recognition_proposals_execution` ON `recognition_proposals` (`execution_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `relationship_lifecycles_predecessor` ON `relationship_lifecycles` (`predecessor_relationship_id`);
--> statement-breakpoint

CREATE INDEX `relationship_lifecycles_scope_slot` ON `relationship_lifecycles` (`source_identity`,`native_address`,`coverage_id`,`source_slot`);
--> statement-breakpoint

CREATE UNIQUE INDEX `relationship_retractions_relationship` ON `relationship_retractions` (`relationship_id`);
--> statement-breakpoint

CREATE INDEX `source_associations_address` ON `source_associations` (`source_identity`,`native_address`);
--> statement-breakpoint

CREATE INDEX `source_associations_subject` ON `source_associations` (`subject_id`);
--> statement-breakpoint

CREATE INDEX `source_lineage_heads_record` ON `source_lineage_heads` (`source_record_id`);
--> statement-breakpoint

CREATE INDEX `source_records_execution` ON `source_records` (`execution_id`);
--> statement-breakpoint

CREATE INDEX `source_records_lineage` ON `source_records` (`source_identity`,`native_address`);
--> statement-breakpoint

CREATE INDEX `source_refresh_change_sets_run` ON `source_refresh_change_sets` (`run_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `source_refresh_change_sets_scope` ON `source_refresh_change_sets` (`run_id`,`source_identity`,`native_address`,`coverage_id`);
--> statement-breakpoint

CREATE INDEX `source_refresh_changes_execution` ON `source_refresh_changes` (`execution_id`);
--> statement-breakpoint

CREATE INDEX `source_refresh_changes_scope` ON `source_refresh_changes` (`subject_id`,`source_identity`,`native_address`,`coverage_id`);
--> statement-breakpoint

CREATE INDEX `source_refresh_runs_execution` ON `source_refresh_runs` (`workflow_execution_id`);
--> statement-breakpoint

CREATE INDEX `source_refresh_scopes_run_ordinal` ON `source_refresh_scopes` (`run_id`,`ordinal`);
--> statement-breakpoint

CREATE UNIQUE INDEX `sourced_entities_exact_identity` ON `sourced_entities` (`source_identity`,`identity_namespace`,`source_key`);
--> statement-breakpoint

CREATE INDEX `workflow_executions_accepted_asset` ON `workflow_executions` (`accepted_asset_id`);
--> statement-breakpoint

CREATE INDEX `workflow_executions_automation_running` ON `workflow_executions` (`automation_intent_id`,`status`);
--> statement-breakpoint

CREATE INDEX `workflow_executions_reuse` ON `workflow_executions` (`outcome`,`reused_execution_id`);
--> statement-breakpoint
