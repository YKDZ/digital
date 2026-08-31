CREATE TABLE `observed_revision_confirmations` (
	`revision_id` text NOT NULL,
	`location_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`size` integer NOT NULL,
	`modified_at` text NOT NULL,
	`conditional_baseline` text NOT NULL,
	PRIMARY KEY(`revision_id`, `location_id`)
);
--> statement-breakpoint
CREATE INDEX `observed_revision_confirmations_revision` ON `observed_revision_confirmations` (`revision_id`);
--> statement-breakpoint
CREATE INDEX `observed_revision_confirmations_location` ON `observed_revision_confirmations` (`location_id`);
--> statement-breakpoint
CREATE TABLE `current_file_observations` (
	`location_id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`size` integer NOT NULL,
	`modified_at` text NOT NULL,
	`conditional_baseline` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `current_file_observations_snapshot` ON `current_file_observations` (`snapshot_id`);
--> statement-breakpoint
CREATE TABLE `artifact_content_proofs` (
	`blob_digest` text PRIMARY KEY NOT NULL,
	`scheme` text NOT NULL,
	`byte_length` integer NOT NULL,
	`frame_size` integer NOT NULL,
	`frame_count` integer NOT NULL,
	`manifest_digest` text NOT NULL,
	CONSTRAINT "artifact_content_proofs_scheme" CHECK(scheme = 'artifact-frame-manifest/1'),
	CONSTRAINT "artifact_content_proofs_frame_size" CHECK(frame_size = 1048576),
	CONSTRAINT "artifact_content_proofs_length" CHECK(byte_length >= 0),
	CONSTRAINT "artifact_content_proofs_count" CHECK(frame_count = (byte_length + 1048575) / 1048576),
	CONSTRAINT "artifact_content_proofs_blob_digest" CHECK(length(blob_digest) = 64 AND blob_digest NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "artifact_content_proofs_manifest_digest" CHECK(length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_content_proofs_manifest` ON `artifact_content_proofs` (`manifest_digest`);
