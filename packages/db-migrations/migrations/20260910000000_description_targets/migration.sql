ALTER TABLE `artifact_associations` RENAME TO `artifact_associations_legacy`;
--> statement-breakpoint

CREATE TABLE `artifact_associations` (
	`id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_entity_id` text,
	`target_artifact_id` text,
	`target_revision_id` text,
	`subject_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`role` text NOT NULL,
	`source_record_ids_json` text DEFAULT '[]' NOT NULL,
	`observed_artifact_part_json` text,
	`producer_json` text,
	`source_association_id` text,
	CONSTRAINT `artifact_associations_pk` PRIMARY KEY(`id`),
	CONSTRAINT `artifact_associations_target` CHECK((`target_kind` = 'entity' AND `target_entity_id` IS NOT NULL AND `target_artifact_id` IS NULL AND `target_revision_id` IS NULL) OR (`target_kind` = 'artifact-revision' AND `target_entity_id` IS NULL AND `target_artifact_id` IS NOT NULL AND `target_revision_id` IS NOT NULL))
);
--> statement-breakpoint

INSERT INTO `artifact_associations` (
	`id`, `target_kind`, `target_entity_id`, `target_artifact_id`,
	`target_revision_id`, `subject_id`, `artifact_id`, `role`,
	`source_record_ids_json`, `observed_artifact_part_json`, `producer_json`,
	`source_association_id`
)
SELECT DISTINCT
	`id`,
	CASE WHEN `observed_artifact_part_json` IS NULL THEN 'entity' ELSE 'artifact-revision' END,
	CASE WHEN `observed_artifact_part_json` IS NULL THEN `subject_id` END,
	CASE WHEN `observed_artifact_part_json` IS NOT NULL THEN json_extract(`observed_artifact_part_json`, '$.artifactId') END,
	CASE WHEN `observed_artifact_part_json` IS NOT NULL THEN json_extract(`observed_artifact_part_json`, '$.revisionId') END,
	`subject_id`,
	`artifact_id`,
	CASE WHEN `observed_artifact_part_json` IS NOT NULL AND `role` = 'asset.primary-cover' THEN 'asset.material-image' ELSE `role` END,
	`source_record_ids_json`,
	`observed_artifact_part_json`,
	`producer_json`,
	`source_association_id`
FROM `artifact_associations_legacy`;
--> statement-breakpoint

DROP TABLE `artifact_associations_legacy`;
--> statement-breakpoint

ALTER TABLE `artifact_association_recognition_supports` RENAME TO `artifact_association_recognition_supports_legacy`;
--> statement-breakpoint

CREATE TABLE `artifact_association_recognition_supports` (
	`association_id` text NOT NULL REFERENCES `artifact_associations`(`id`),
	`recognition_decision_id` text NOT NULL REFERENCES `recognition_decisions`(`id`),
	CONSTRAINT `artifact_association_recognition_supports_pk` PRIMARY KEY(`association_id`, `recognition_decision_id`)
);
--> statement-breakpoint

INSERT INTO `artifact_association_recognition_supports` (`association_id`, `recognition_decision_id`)
SELECT `association_id`, `recognition_decision_id`
FROM `artifact_association_recognition_supports_legacy`;
--> statement-breakpoint

DROP TABLE `artifact_association_recognition_supports_legacy`;
--> statement-breakpoint

CREATE INDEX `artifact_association_recognition_supports_decision` ON `artifact_association_recognition_supports` (`recognition_decision_id`);
--> statement-breakpoint

CREATE INDEX `artifact_associations_source_association_role` ON `artifact_associations` (`subject_id`,`source_association_id`,`role`);
--> statement-breakpoint

CREATE INDEX `artifact_associations_subject` ON `artifact_associations` (`subject_id`);
--> statement-breakpoint

ALTER TABLE `metadata_assertions` RENAME TO `metadata_assertions_legacy`;
--> statement-breakpoint

CREATE TABLE `metadata_assertions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`target_kind` text NOT NULL,
	`target_entity_id` text,
	`target_artifact_id` text,
	`target_revision_id` text,
	`subject_id` text NOT NULL,
	`property` text NOT NULL,
	`value` text NOT NULL,
	`source_record_ids_json` text NOT NULL,
	`is_current` integer DEFAULT 1 NOT NULL,
	`source_slot` text,
	`observed_artifact_part_json` text,
	`qualifiers_json` text DEFAULT '[]' NOT NULL,
	`producer_json` text,
	`authored_by_json` text,
	`recognition_decision_id` text,
	CONSTRAINT `metadata_assertions_target` CHECK((`target_kind` = 'entity' AND `target_entity_id` IS NOT NULL AND `target_artifact_id` IS NULL AND `target_revision_id` IS NULL) OR (`target_kind` = 'artifact-revision' AND `target_entity_id` IS NULL AND `target_artifact_id` IS NOT NULL AND `target_revision_id` IS NOT NULL))
);
--> statement-breakpoint

INSERT INTO `metadata_assertions` (
	`id`, `target_kind`, `target_entity_id`, `target_artifact_id`,
	`target_revision_id`, `subject_id`, `property`, `value`,
	`source_record_ids_json`, `is_current`, `source_slot`,
	`observed_artifact_part_json`, `qualifiers_json`, `producer_json`,
	`authored_by_json`, `recognition_decision_id`
)
SELECT
	`id`,
	CASE WHEN `observed_artifact_part_json` IS NULL THEN 'entity' ELSE 'artifact-revision' END,
	CASE WHEN `observed_artifact_part_json` IS NULL THEN `subject_id` END,
	CASE WHEN `observed_artifact_part_json` IS NOT NULL THEN json_extract(`observed_artifact_part_json`, '$.artifactId') END,
	CASE WHEN `observed_artifact_part_json` IS NOT NULL THEN json_extract(`observed_artifact_part_json`, '$.revisionId') END,
	`subject_id`, `property`, `value`, `source_record_ids_json`, `is_current`,
	`source_slot`, `observed_artifact_part_json`, `qualifiers_json`,
	`producer_json`, `authored_by_json`, NULL
FROM `metadata_assertions_legacy`;
--> statement-breakpoint

DROP TABLE `metadata_assertions_legacy`;
--> statement-breakpoint

CREATE INDEX `metadata_assertions_subject_property` ON `metadata_assertions` (`subject_id`,`property`);
--> statement-breakpoint

ALTER TABLE `current_file_observations` RENAME TO `current_file_observations_legacy`;
--> statement-breakpoint

CREATE TABLE `current_file_observations` (
	`location_id` text NOT NULL,
	`address` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`size` integer NOT NULL,
	`modified_at` text NOT NULL,
	`conditional_baseline` text NOT NULL,
	CONSTRAINT `current_file_observations_pk` PRIMARY KEY(`location_id`)
);
--> statement-breakpoint

INSERT INTO `current_file_observations` (
	`location_id`, `address`, `snapshot_id`, `observed_at`, `size`,
	`modified_at`, `conditional_baseline`
)
SELECT `location_id`, `address`, `snapshot_id`, `observed_at`, `size`,
	`modified_at`, `conditional_baseline`
FROM (
	SELECT current_observation.*,
		location.address,
		row_number() OVER (
			PARTITION BY location.address
			ORDER BY current_observation.observed_at DESC, current_observation.location_id
		) AS address_rank
	FROM `current_file_observations_legacy` AS current_observation
	JOIN `locations` AS location ON location.id = current_observation.location_id
)
WHERE address_rank = 1;
--> statement-breakpoint

DROP TABLE `current_file_observations_legacy`;
--> statement-breakpoint

CREATE INDEX `current_file_observations_snapshot` ON `current_file_observations` (`snapshot_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `current_file_observations_address` ON `current_file_observations` (`address`);
--> statement-breakpoint

INSERT INTO `artifact_associations` (
	`id`, `target_kind`, `target_entity_id`, `subject_id`, `artifact_id`, `role`,
	`source_record_ids_json`, `observed_artifact_part_json`, `producer_json`
)
SELECT DISTINCT
	image.`id` || ':entity-primary-cover',
	'entity', delivered.`target_entity_id`, delivered.`subject_id`, image.`artifact_id`,
	'asset.primary-cover', image.`source_record_ids_json`, image.`observed_artifact_part_json`,
	image.`producer_json`
FROM `artifact_associations` AS delivered
JOIN `locations` AS delivered_location
	ON delivered_location.`artifact_id` = delivered.`artifact_id`
JOIN `current_file_observations` AS current_observation
	ON current_observation.`location_id` = delivered_location.`id`
JOIN `artifact_revisions` AS delivered_revision
	ON delivered_revision.`artifact_id` = delivered.`artifact_id`
JOIN `artifact_associations` AS image
	ON image.`target_kind` = 'artifact-revision'
	AND image.`target_artifact_id` = delivered_revision.`artifact_id`
	AND image.`target_revision_id` = delivered_revision.`id`
	AND image.`role` = 'asset.material-image'
WHERE delivered.`target_kind` = 'entity'
	AND delivered.`role` = 'asset.material-delivered'
	AND NOT EXISTS (
		SELECT 1 FROM `artifact_associations` AS existing_cover
		WHERE existing_cover.`target_kind` = 'entity'
			AND existing_cover.`target_entity_id` = delivered.`target_entity_id`
			AND existing_cover.`role` = 'asset.primary-cover'
	)
	AND 1 = (
		SELECT COUNT(DISTINCT current_location.`address`)
		FROM `artifact_associations` AS current_delivered
		JOIN `locations` AS current_location
			ON current_location.`artifact_id` = current_delivered.`artifact_id`
		JOIN `current_file_observations` AS current_file
			ON current_file.`location_id` = current_location.`id`
		WHERE current_delivered.`target_kind` = 'entity'
			AND current_delivered.`target_entity_id` = delivered.`target_entity_id`
			AND current_delivered.`role` = 'asset.material-delivered'
	);
--> statement-breakpoint

DROP TABLE `metadata_policy_enrollments`;
