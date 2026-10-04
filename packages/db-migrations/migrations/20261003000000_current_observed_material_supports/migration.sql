CREATE TABLE `current_observed_material_supports` (
	`location_id` text NOT NULL,
	`observed_root_id` text NOT NULL,
	`observed_root_version` integer NOT NULL,
	`material_kind` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`observed_root_path` text NOT NULL,
	`authorized_targets_json` text NOT NULL DEFAULT '[]',
	CONSTRAINT `current_observed_material_supports_pk` PRIMARY KEY(`location_id`, `observed_root_id`, `observed_root_version`)
);
--> statement-breakpoint
CREATE INDEX `current_observed_material_supports_root` ON `current_observed_material_supports` (`observed_root_id`,`observed_root_version`);
--> statement-breakpoint
-- 观察 Location 的永久材料形态边界：正向支持被删除后仍保留形态，查询以本表为权威。
CREATE TABLE `observed_material_boundaries` (
	`location_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`material_kind` text NOT NULL,
	`derivation_kind` text NOT NULL,
	CONSTRAINT `observed_material_boundaries_material_kind` CHECK (material_kind IN ('file', 'directory')),
	CONSTRAINT `observed_material_boundaries_derivation_kind` CHECK (derivation_kind IN ('accepted-exact', 'legacy-exact', 'legacy-kind-equivalent')),
	CONSTRAINT `observed_material_boundaries_pk` PRIMARY KEY(`location_id`)
);
--> statement-breakpoint
-- 一次接受到 asset、Artifact、Location、delivered 关联、proposal、snapshot 与形态的精确映射。
CREATE TABLE `observed_material_acceptances` (
	`execution_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`work_item_key` text NOT NULL,
	`acceptance_kind` text NOT NULL,
	`asset_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`location_id` text NOT NULL,
	`association_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`observed_reference` text NOT NULL,
	CONSTRAINT `observed_material_acceptances_acceptance_kind` CHECK (acceptance_kind IN ('a-work-item', 'b-local', 'c-association', 'a-preview')),
	CONSTRAINT `observed_material_acceptances_pk` PRIMARY KEY(`execution_id`, `work_item_key`, `location_id`, `association_id`)
);
--> statement-breakpoint
CREATE INDEX `observed_material_acceptances_location` ON `observed_material_acceptances` (`location_id`);
--> statement-breakpoint
-- 回填关系集：以下临时表与视图只解析版本化 checkpoint/preview 路径和固定字段，
-- 与 packages/sqlite 的运行时接受写入和目录资格谓词同语义，两侧必须一起修改。
CREATE TEMP TABLE `digital_c01_binding` (
	`execution_sequence` integer NOT NULL,
	`execution_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`work_item_key` text NOT NULL,
	`acceptance_kind` text NOT NULL,
	`asset_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`location_id` text NOT NULL,
	`association_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`observed_reference` text NOT NULL,
	`material_kind` text NOT NULL,
	`observed_root_id` text NOT NULL,
	`observed_root_version` integer NOT NULL,
	`observed_root_path` text NOT NULL,
	`authorized_targets_json` text NOT NULL,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`execution_id`, `work_item_key`, `location_id`, `association_id`)
);
--> statement-breakpoint
-- 同址同形态的重复历史候选：只固定形态，不伪造 execution 归属，也不给出最早起点。
CREATE TEMP TABLE `digital_c01_kind_equivalent` (
	`location_id` text NOT NULL PRIMARY KEY,
	`artifact_id` text NOT NULL
);
--> statement-breakpoint
-- 健康库必须留下唯一精确载体；任何残留歧义都写入本表并以固定私有诊断名失败回滚。
CREATE TEMP TABLE `digital_c01_guard` (
	`location_id` text,
	CONSTRAINT `digital_c01_legacy_material_carrier_ambiguous` CHECK (FALSE)
);
--> statement-breakpoint
CREATE TEMP VIEW `digital_c01_root` AS
SELECT `executions`.`rowid` AS `execution_sequence`, `executions`.`id` AS `execution_id`,
	json_extract(`root`.`value`, '$.id') AS `root_id`,
	CAST(json_extract(`root`.`value`, '$.configVersion') AS INTEGER) AS `root_version`,
	json_extract(`root`.`value`, '$.containerPath') AS `root_path`,
	COALESCE(json_extract(`root`.`value`, '$.authorizedTargetRoots'), '[]') AS `authorized_targets_json`
FROM `workflow_executions` AS `executions`
CROSS JOIN json_each(COALESCE(json_extract(`executions`.`workflow_input_json`, '$.observedRoots'), '[]')) AS `root`
UNION ALL
-- 观察材料追加的 workflow input 本来就不带根；只取同执行 resolved selection 的冻结根，
-- 并与 accepted checkpoint 的 registration 坐标交叉校验。
SELECT `executions`.`rowid`, `executions`.`id`,
	json_extract(`scope`.`value`, '$.observedRoot.id'),
	CAST(json_extract(`scope`.`value`, '$.observedRoot.configVersion') AS INTEGER),
	json_extract(`scope`.`value`, '$.observedRoot.containerPath'),
	COALESCE(json_extract(`scope`.`value`, '$.observedRoot.authorizedTargetRoots'), '[]')
FROM `workflow_executions` AS `executions`
CROSS JOIN json_each(COALESCE(json_extract(`executions`.`resolved_selection_json`, '$.filesystemScopes'), '[]')) AS `scope`
WHERE json_extract(`executions`.`material_association_json`, '$.version') =
	'observed-material-association-checkpoint/1'
	AND json_extract(`executions`.`material_association_json`, '$.state') = 'accepted'
	AND json_extract(`scope`.`value`, '$.observedRoot.id') =
		json_extract(`executions`.`material_association_json`, '$.input.registrationId')
	AND CAST(json_extract(`scope`.`value`, '$.observedRoot.configVersion') AS INTEGER) =
		CAST(json_extract(`executions`.`material_association_json`, '$.input.registrationVersion') AS INTEGER);
--> statement-breakpoint
CREATE TEMP VIEW `digital_c01_snapshot` AS
SELECT `executions`.`rowid` AS `execution_sequence`, `executions`.`id` AS `execution_id`,
	json_extract(`snapshot`.`value`, '$.id') AS `snapshot_id`,
	json_extract(`snapshot`.`value`, '$.root') AS `snapshot_root`,
	json_extract(`snapshot`.`value`, '$.observedAt') AS `observed_at`,
	`snapshot`.`value` AS `snapshot_json`
FROM `workflow_executions` AS `executions`
CROSS JOIN json_each(`executions`.`filesystem_snapshots_json`) AS `snapshot`
WHERE `executions`.`filesystem_snapshots_json` IS NOT NULL
	AND json_extract(`snapshot`.`value`, '$.complete') = 1;
--> statement-breakpoint
CREATE TEMP VIEW `digital_c01_delivered` AS
SELECT `locations`.`id` AS `location_id`, `locations`.`address` AS `address`,
	`locations`.`artifact_id` AS `artifact_id`, `associations`.`id` AS `association_id`,
	`associations`.`subject_id` AS `asset_id`, `decisions`.`id` AS `decision_id`,
	`decisions`.`proposal_id` AS `proposal_id`
FROM `locations`
INNER JOIN `artifact_associations` AS `associations`
	ON `associations`.`artifact_id` = `locations`.`artifact_id`
	AND `associations`.`role` = 'asset.material-delivered'
	AND `associations`.`target_kind` = 'entity'
INNER JOIN `recognition_decisions` AS `decisions`
	ON `decisions`.`asset_id` = `associations`.`subject_id`
WHERE `locations`.`kind` = 'observed';
--> statement-breakpoint
-- 载体 1：accepted checkpoint 的每个 submission projection 逐项精确归属。
INSERT OR IGNORE INTO `digital_c01_binding` (`execution_sequence`, `execution_id`, `proposal_id`,
	`work_item_key`, `acceptance_kind`, `asset_id`, `artifact_id`, `location_id`, `association_id`,
	`snapshot_id`, `observed_reference`, `material_kind`, `observed_root_id`, `observed_root_version`,
	`observed_root_path`, `authorized_targets_json`, `observed_at`)
SELECT DISTINCT `executions`.`rowid`, `executions`.`id`,
	json_extract(`executions`.`material_association_json`, '$.submission.proposal.id'),
	'', 'c-association',
	json_extract(`executions`.`material_association_json`, '$.submission.recognitionDecision.assetId'),
	json_extract(`projection`.`value`, '$.artifactId'),
	json_extract(`projection`.`value`, '$.locationId'),
	json_extract(`projection`.`value`, '$.associationId'),
	json_extract(`executions`.`material_association_json`, '$.snapshot.id'),
	json_extract(`projection`.`value`, '$.observedArtifactReference'),
	'file', `root`.`root_id`, `root`.`root_version`, `root`.`root_path`,
	`root`.`authorized_targets_json`, `snapshot`.`observed_at`
FROM `workflow_executions` AS `executions`
CROSS JOIN json_each(COALESCE(json_extract(`executions`.`material_association_json`, '$.submission.projections'), '[]')) AS `projection`
INNER JOIN `digital_c01_snapshot` AS `snapshot`
	ON `snapshot`.`execution_id` = `executions`.`id`
	AND `snapshot`.`snapshot_id` = json_extract(`executions`.`material_association_json`, '$.snapshot.id')
	AND `snapshot`.`snapshot_id` = json_extract(`executions`.`material_association_json`, '$.submission.proposal.basis.observationSnapshotId')
INNER JOIN `digital_c01_root` AS `root` ON `root`.`execution_id` = `executions`.`id`
INNER JOIN `recognition_proposals` AS `proposal`
	ON `proposal`.`id` = json_extract(`executions`.`material_association_json`, '$.submission.proposal.id')
INNER JOIN `recognition_decisions` AS `decision`
	ON `decision`.`id` = json_extract(`executions`.`material_association_json`, '$.submission.recognitionDecision.id')
	AND `decision`.`proposal_id` = `proposal`.`id`
	AND `decision`.`asset_id` = json_extract(`executions`.`material_association_json`, '$.submission.recognitionDecision.assetId')
INNER JOIN `locations` AS `location`
	ON `location`.`id` = json_extract(`projection`.`value`, '$.locationId')
	AND `location`.`kind` = 'observed'
	AND `location`.`artifact_id` = json_extract(`projection`.`value`, '$.artifactId')
	AND `location`.`address` = CASE json_extract(`projection`.`value`, '$.observedArtifactReference')
		WHEN '.' THEN `snapshot`.`snapshot_root`
		ELSE `snapshot`.`snapshot_root` || '/' || json_extract(`projection`.`value`, '$.observedArtifactReference')
	END
INNER JOIN `artifact_associations` AS `association`
	ON `association`.`id` = json_extract(`projection`.`value`, '$.associationId')
	AND `association`.`artifact_id` = `location`.`artifact_id`
	AND `association`.`role` = 'asset.material-delivered'
	AND `association`.`target_kind` = 'entity'
	AND `association`.`subject_id` = `decision`.`asset_id`
	AND `association`.`target_entity_id` = `decision`.`asset_id`
WHERE `executions`.`operation_kind` = 'associate-observed-material'
	AND `executions`.`status` = 'completed'
	AND `executions`.`outcome` = 'accepted'
	AND json_extract(`executions`.`material_association_json`, '$.version') =
		'observed-material-association-checkpoint/1'
	AND json_extract(`executions`.`material_association_json`, '$.state') = 'accepted'
	AND EXISTS (
		SELECT 1 FROM json_each(COALESCE(json_extract(`executions`.`material_association_json`, '$.input.relativePaths'), '[]')) AS `selected`
		WHERE `selected`.`value` = json_extract(`projection`.`value`, '$.observedArtifactReference')
	)
	AND EXISTS (
		SELECT 1 FROM json_each(`snapshot`.`snapshot_json`, '$.files') AS `file`
		WHERE json_extract(`file`.`value`, '$.relativePath') =
			json_extract(`projection`.`value`, '$.observedArtifactReference')
	)
	AND (`snapshot`.`snapshot_root` = `root`.`root_path`
		OR substr(`snapshot`.`snapshot_root`, 1, length(`root`.`root_path`) + 1) = `root`.`root_path` || '/');
--> statement-breakpoint
-- 载体 2：只有已确认应用的识别取代 preview 才是接受载体；以 projected - current 的精确
-- ID 集合取得新增 Location 与 delivered 关联，proposal、execution 与 snapshot 都取自 preview 自己。
INSERT OR IGNORE INTO `digital_c01_binding` (`execution_sequence`, `execution_id`, `proposal_id`,
	`work_item_key`, `acceptance_kind`, `asset_id`, `artifact_id`, `location_id`, `association_id`,
	`snapshot_id`, `observed_reference`, `material_kind`, `observed_root_id`, `observed_root_version`,
	`observed_root_path`, `authorized_targets_json`, `observed_at`)
SELECT DISTINCT `executions`.`rowid`, `previews`.`execution_id`,
	json_extract(`previews`.`preview_json`, '$.change.proposal.id'),
	'', 'a-preview', `previews`.`asset_id`, `location`.`artifact_id`, `location`.`id`,
	`association`.`id`, `snapshot`.`snapshot_id`,
	CASE WHEN `location`.`address` = `snapshot`.`snapshot_root` THEN '.'
		ELSE substr(`location`.`address`, length(`snapshot`.`snapshot_root`) + 2) END,
	CASE WHEN `location`.`address` = `snapshot`.`snapshot_root` THEN 'directory' ELSE 'file' END,
	`root`.`root_id`, `root`.`root_version`, `root`.`root_path`,
	`root`.`authorized_targets_json`, `snapshot`.`observed_at`
FROM `change_impact_previews` AS `previews`
INNER JOIN `workflow_executions` AS `executions` ON `executions`.`id` = `previews`.`execution_id`
CROSS JOIN json_each(COALESCE(json_extract(`previews`.`preview_json`, '$.projected.locations'), '[]')) AS `projected_location`
CROSS JOIN json_each(COALESCE(json_extract(`previews`.`preview_json`, '$.projected.artifactAssociations'), '[]')) AS `projected_association`
INNER JOIN `locations` AS `location`
	ON `location`.`id` = json_extract(`projected_location`.`value`, '$.id')
	AND `location`.`kind` = 'observed'
INNER JOIN `artifact_associations` AS `association`
	ON `association`.`id` = json_extract(`projected_association`.`value`, '$.id')
	AND `association`.`artifact_id` = `location`.`artifact_id`
	AND `association`.`role` = 'asset.material-delivered'
	AND `association`.`target_kind` = 'entity'
	AND `association`.`subject_id` = `previews`.`asset_id`
	AND `association`.`target_entity_id` = `previews`.`asset_id`
INNER JOIN `digital_c01_snapshot` AS `snapshot` ON `snapshot`.`execution_id` = `executions`.`id`
INNER JOIN `digital_c01_root` AS `root` ON `root`.`execution_id` = `executions`.`id`
WHERE `previews`.`status` = 'applied'
	AND json_extract(`previews`.`preview_json`, '$.change.kind') = 'recognition-supersession'
	AND `executions`.`status` = 'completed'
	AND NOT EXISTS (
		SELECT 1 FROM json_each(COALESCE(json_extract(`previews`.`preview_json`, '$.current.locations'), '[]')) AS `current_location`
		WHERE json_extract(`current_location`.`value`, '$.id') = `location`.`id`
	)
	AND NOT EXISTS (
		SELECT 1 FROM json_each(COALESCE(json_extract(`previews`.`preview_json`, '$.current.artifactAssociations'), '[]')) AS `current_association`
		WHERE json_extract(`current_association`.`value`, '$.id') = `association`.`id`
	)
	AND (`location`.`address` = `snapshot`.`snapshot_root`
		OR (substr(`location`.`address`, 1, length(`snapshot`.`snapshot_root`) + 1) =
				`snapshot`.`snapshot_root` || '/'
			AND EXISTS (
				SELECT 1 FROM json_each(`snapshot`.`snapshot_json`, '$.files') AS `file`
				WHERE `snapshot`.`snapshot_root` || '/' || json_extract(`file`.`value`, '$.relativePath') = `location`.`address`
			)))
	AND (`snapshot`.`snapshot_root` = `root`.`root_path`
		OR substr(`snapshot`.`snapshot_root`, 1, length(`root`.`root_path`) + 1) = `root`.`root_path` || '/');
--> statement-breakpoint
-- 目录候选：保留的已接受 filesystem-package 工作项、其原始完整 snapshot 与该执行确实
-- 交付到 snapshot root 地址的 Location。先排除载体 1/2 已精确归属的 later file。
CREATE TEMP VIEW `digital_c01_package_candidate` AS
SELECT DISTINCT `executions`.`rowid` AS `execution_sequence`, `executions`.`id` AS `execution_id`,
	json_extract(`item`.`value`, '$.proposalId') AS `proposal_id`,
	json_extract(`item`.`value`, '$.key') AS `work_item_key`,
	json_extract(`item`.`value`, '$.acceptedAssetId') AS `asset_id`,
	`delivered`.`location_id` AS `location_id`, `delivered`.`association_id` AS `association_id`,
	`delivered`.`artifact_id` AS `artifact_id`, `delivered`.`address` AS `address`,
	`snapshot`.`snapshot_id` AS `snapshot_id`,
	`snapshot`.`observed_at` AS `observed_at`, `root`.`root_id` AS `observed_root_id`,
	`root`.`root_version` AS `observed_root_version`, `root`.`root_path` AS `observed_root_path`,
	`root`.`authorized_targets_json` AS `authorized_targets_json`
FROM `workflow_executions` AS `executions`
CROSS JOIN json_each(COALESCE(json_extract(`executions`.`work_items_json`, '$'), '[]')) AS `item`
INNER JOIN `digital_c01_snapshot` AS `snapshot` ON `snapshot`.`execution_id` = `executions`.`id`
INNER JOIN `digital_c01_root` AS `root` ON `root`.`execution_id` = `executions`.`id`
INNER JOIN `digital_c01_delivered` AS `delivered`
	ON `delivered`.`proposal_id` = json_extract(`item`.`value`, '$.proposalId')
	AND `delivered`.`asset_id` = json_extract(`item`.`value`, '$.acceptedAssetId')
	AND `delivered`.`address` = `snapshot`.`snapshot_root`
WHERE `executions`.`operation_kind` = 'scan-filesystem'
	AND `executions`.`status` = 'completed'
	AND json_extract(`item`.`value`, '$.observedArtifactBoundary') = 'filesystem-package'
	AND json_extract(`item`.`value`, '$.outcome') = 'accepted'
	AND COALESCE(json_extract(`item`.`value`, '$.proposalId'), '') <> ''
	AND COALESCE(json_extract(`item`.`value`, '$.acceptedAssetId'), '') <> ''
	AND COALESCE(json_extract(`item`.`value`, '$.observedArtifactBoundaryProducer.capabilityId'), '') <> ''
	AND COALESCE(json_extract(`item`.`value`, '$.observedArtifactBoundaryProducer.capabilityVersion'), '') <> ''
	AND COALESCE(json_extract(`item`.`value`, '$.observedArtifactBoundaryProducer.contractVersion'), '') <> ''
	-- 当前生产每次执行只冻结一个完整 snapshot；恢复不接受别的形状。
	AND (
		SELECT COUNT(*) FROM json_each(`executions`.`filesystem_snapshots_json`) AS `counted`
		WHERE json_extract(`counted`.`value`, '$.complete') = 1
	) = 1
	AND COALESCE(json_array_length(`item`.`value`, '$.relativePaths'), 0) > 0
	AND NOT EXISTS (
		SELECT 1 FROM json_each(COALESCE(json_extract(`item`.`value`, '$.relativePaths'), '[]')) AS `path`
		WHERE NOT EXISTS (
			SELECT 1 FROM json_each(`snapshot`.`snapshot_json`, '$.files') AS `file`
			WHERE json_extract(`file`.`value`, '$.relativePath') = `path`.`value`
		)
	)
	AND (`snapshot`.`snapshot_root` = `root`.`root_path`
		OR substr(`snapshot`.`snapshot_root`, 1, length(`root`.`root_path`) + 1) = `root`.`root_path` || '/');
--> statement-breakpoint
CREATE TEMP TABLE `digital_c01_package_remaining` AS
SELECT * FROM `digital_c01_package_candidate` AS `candidate`
WHERE NOT EXISTS (
	SELECT 1 FROM `digital_c01_binding` AS `exact` WHERE `exact`.`location_id` = `candidate`.`location_id`
);
--> statement-breakpoint
-- v6 §2.2：精确 C/preview 归属之后的剩余 package 候选按 (asset, 精确 Location 地址) 建
-- legacy directory 等价组。组内只有一个 Location 时该 Location 由这唯一候选精确归属；
-- 有多个时任何 execution→Location 归属都不成立，只固定 directory 形态。
CREATE TEMP TABLE `digital_c01_package_group` AS
SELECT `candidate`.*,
	(SELECT COUNT(DISTINCT `peer`.`location_id`) FROM `digital_c01_package_remaining` AS `peer`
	WHERE `peer`.`asset_id` = `candidate`.`asset_id`
		AND `peer`.`address` = `candidate`.`address`) AS `group_locations`
FROM `digital_c01_package_remaining` AS `candidate`;
--> statement-breakpoint
INSERT OR IGNORE INTO `digital_c01_binding` (`execution_sequence`, `execution_id`, `proposal_id`,
	`work_item_key`, `acceptance_kind`, `asset_id`, `artifact_id`, `location_id`, `association_id`,
	`snapshot_id`, `observed_reference`, `material_kind`, `observed_root_id`, `observed_root_version`,
	`observed_root_path`, `authorized_targets_json`, `observed_at`)
SELECT `single`.`execution_sequence`, `single`.`execution_id`, `single`.`proposal_id`,
	`single`.`work_item_key`, 'a-work-item', `single`.`asset_id`, `single`.`artifact_id`,
	`single`.`location_id`, `single`.`association_id`, `single`.`snapshot_id`, '.', 'directory',
	`single`.`observed_root_id`, `single`.`observed_root_version`, `single`.`observed_root_path`,
	`single`.`authorized_targets_json`, `single`.`observed_at`
FROM (
	SELECT `pack`.*, ROW_NUMBER() OVER (
		PARTITION BY `pack`.`location_id`
		ORDER BY `pack`.`execution_sequence`, `pack`.`execution_id`, `pack`.`work_item_key`
	) AS `candidate_order`
	FROM `digital_c01_package_group` AS `pack`
	WHERE `pack`.`group_locations` = 1
) AS `single`
WHERE `single`.`candidate_order` = 1;
--> statement-breakpoint
CREATE TEMP TABLE `digital_c01_directory_equivalent` AS
SELECT DISTINCT `location_id`, `artifact_id`, `asset_id`, `address`
FROM `digital_c01_package_group`
WHERE `group_locations` > 1;
--> statement-breakpoint
-- 文件候选：A 普通文件工作项逐 relativePaths、B 顶层人工接受逐 materialReferences。
-- 已由 package 等价组固定为 directory 的地址不参与 file 归属，避免同址双形态拼接。
CREATE TEMP TABLE `digital_c01_file_candidate` AS
-- A：普通文件工作项
SELECT DISTINCT `executions`.`rowid` AS `execution_sequence`, `executions`.`id` AS `execution_id`,
	json_extract(`item`.`value`, '$.proposalId') AS `proposal_id`,
	json_extract(`item`.`value`, '$.key') AS `work_item_key`,
	'a-work-item' AS `acceptance_kind`,
	json_extract(`item`.`value`, '$.acceptedAssetId') AS `asset_id`,
	`delivered`.`location_id` AS `location_id`, `delivered`.`association_id` AS `association_id`,
	`delivered`.`artifact_id` AS `artifact_id`, `snapshot`.`snapshot_id` AS `snapshot_id`,
	`path`.`value` AS `observed_reference`, `snapshot`.`observed_at` AS `observed_at`,
	`root`.`root_id` AS `observed_root_id`, `root`.`root_version` AS `observed_root_version`,
	`root`.`root_path` AS `observed_root_path`, `root`.`authorized_targets_json` AS `authorized_targets_json`
FROM `workflow_executions` AS `executions`
CROSS JOIN json_each(COALESCE(json_extract(`executions`.`work_items_json`, '$'), '[]')) AS `item`
INNER JOIN `digital_c01_snapshot` AS `snapshot` ON `snapshot`.`execution_id` = `executions`.`id`
INNER JOIN `digital_c01_root` AS `root` ON `root`.`execution_id` = `executions`.`id`
CROSS JOIN json_each(COALESCE(json_extract(`item`.`value`, '$.relativePaths'), '[]')) AS `path`
INNER JOIN `digital_c01_delivered` AS `delivered`
	ON `delivered`.`proposal_id` = json_extract(`item`.`value`, '$.proposalId')
	AND `delivered`.`asset_id` = json_extract(`item`.`value`, '$.acceptedAssetId')
	AND `delivered`.`address` = CASE `path`.`value`
		WHEN '.' THEN `snapshot`.`snapshot_root`
		ELSE `snapshot`.`snapshot_root` || '/' || `path`.`value`
	END
WHERE `executions`.`operation_kind` = 'scan-filesystem'
	AND `executions`.`status` = 'completed'
	AND json_extract(`item`.`value`, '$.outcome') = 'accepted'
	AND json_extract(`item`.`value`, '$.observedArtifactBoundary') IS NULL
	AND COALESCE(json_extract(`item`.`value`, '$.proposalId'), '') <> ''
	AND COALESCE(json_extract(`item`.`value`, '$.acceptedAssetId'), '') <> ''
	AND EXISTS (
		SELECT 1 FROM json_each(`snapshot`.`snapshot_json`, '$.files') AS `file`
		WHERE json_extract(`file`.`value`, '$.relativePath') = `path`.`value`
	)
	-- 顶层人工接受由 B 载体按 proposal 依据逐项归属，避免同一事件重复计入 A 工作项。
	AND NOT EXISTS (
		SELECT 1 FROM `recognition_proposals` AS `manual`
		WHERE `manual`.`id` = `executions`.`proposal_id`
			AND json_extract(`manual`.`basis_json`, '$.kind') = 'manual-boundary'
	)
	AND (`snapshot`.`snapshot_root` = `root`.`root_path`
		OR substr(`snapshot`.`snapshot_root`, 1, length(`root`.`root_path`) + 1) = `root`.`root_path` || '/')
UNION ALL
-- B：顶层人工本地内容按 manual-boundary 的 materialReferences 精确映射
SELECT DISTINCT `executions`.`rowid`, `executions`.`id`, `proposal`.`id`, '', 'b-local',
	`executions`.`accepted_asset_id`, `delivered`.`location_id`, `delivered`.`association_id`,
	`delivered`.`artifact_id`, `snapshot`.`snapshot_id`, `reference`.`value`,
	`snapshot`.`observed_at`, `root`.`root_id`, `root`.`root_version`, `root`.`root_path`,
	`root`.`authorized_targets_json`
FROM `workflow_executions` AS `executions`
INNER JOIN `recognition_proposals` AS `proposal` ON `proposal`.`id` = `executions`.`proposal_id`
INNER JOIN `recognition_decisions` AS `decision`
	ON `decision`.`proposal_id` = `proposal`.`id`
	AND `decision`.`asset_id` = `executions`.`accepted_asset_id`
INNER JOIN `digital_c01_snapshot` AS `snapshot`
	ON `snapshot`.`execution_id` = `executions`.`id`
	AND `snapshot`.`snapshot_id` = json_extract(`proposal`.`basis_json`, '$.observationSnapshotId')
INNER JOIN `digital_c01_root` AS `root` ON `root`.`execution_id` = `executions`.`id`
CROSS JOIN json_each(COALESCE(json_extract(`proposal`.`basis_json`, '$.materialReferences'), '[]')) AS `reference`
INNER JOIN `digital_c01_delivered` AS `delivered`
	ON `delivered`.`decision_id` = `decision`.`id`
	AND `delivered`.`address` = CASE `reference`.`value`
		WHEN '.' THEN `snapshot`.`snapshot_root`
		ELSE `snapshot`.`snapshot_root` || '/' || `reference`.`value`
	END
WHERE `executions`.`operation_kind` = 'scan-filesystem'
	AND `executions`.`status` = 'completed'
	AND `executions`.`outcome` = 'accepted'
	AND json_extract(`proposal`.`basis_json`, '$.kind') = 'manual-boundary'
	AND `executions`.`material_association_json` IS NULL
	AND EXISTS (
		SELECT 1 FROM json_each(`snapshot`.`snapshot_json`, '$.files') AS `file`
		WHERE json_extract(`file`.`value`, '$.relativePath') = `reference`.`value`
	)
	AND (`snapshot`.`snapshot_root` = `root`.`root_path`
		OR substr(`snapshot`.`snapshot_root`, 1, length(`root`.`root_path`) + 1) = `root`.`root_path` || '/');
--> statement-breakpoint
-- 只让同形态的精确载体优先排除 file witness：该 Location 一旦同时有 directory 证据，
-- 必须把它保留到第 7 步 mixed-kind guard，否则矛盾会在去重时被提前抹掉而任选形态。
DELETE FROM `digital_c01_file_candidate`
WHERE EXISTS (
	SELECT 1 FROM `digital_c01_binding` AS `exact`
	WHERE `exact`.`location_id` = `digital_c01_file_candidate`.`location_id`
		AND `exact`.`material_kind` = 'file'
)
	AND NOT EXISTS (
		SELECT 1 FROM `digital_c01_binding` AS `directory`
		WHERE `directory`.`location_id` = `digital_c01_file_candidate`.`location_id`
			AND `directory`.`material_kind` = 'directory'
	)
	AND NOT EXISTS (
		SELECT 1 FROM `digital_c01_directory_equivalent` AS `grouped`
		WHERE `grouped`.`location_id` = `digital_c01_file_candidate`.`location_id`
	);
--> statement-breakpoint
-- 载体 3/4/5 判定：同一路径引用只剩一个载体时精确归属；只剩多个同形态 file 候选时
-- 固定形态但不伪造 execution 归属；混合形态属于不合法历史库，交由固定诊断回滚。
INSERT OR IGNORE INTO `digital_c01_binding` (`execution_sequence`, `execution_id`, `proposal_id`,
	`work_item_key`, `acceptance_kind`, `asset_id`, `artifact_id`, `location_id`, `association_id`,
	`snapshot_id`, `observed_reference`, `material_kind`, `observed_root_id`, `observed_root_version`,
	`observed_root_path`, `authorized_targets_json`, `observed_at`)
SELECT `candidate`.`execution_sequence`, `candidate`.`execution_id`, `candidate`.`proposal_id`,
	`candidate`.`work_item_key`, `candidate`.`acceptance_kind`, `candidate`.`asset_id`,
	`candidate`.`artifact_id`, `candidate`.`location_id`, `candidate`.`association_id`,
	`candidate`.`snapshot_id`, `candidate`.`observed_reference`, 'file',
	`candidate`.`observed_root_id`, `candidate`.`observed_root_version`,
	`candidate`.`observed_root_path`, `candidate`.`authorized_targets_json`,
	`candidate`.`observed_at`
FROM `digital_c01_file_candidate` AS `candidate`
WHERE (
	SELECT COUNT(*) FROM `digital_c01_file_candidate` AS `peer`
	WHERE `peer`.`execution_id` = `candidate`.`execution_id`
		AND `peer`.`work_item_key` = `candidate`.`work_item_key`
		AND `peer`.`observed_reference` = `candidate`.`observed_reference`
	) = 1;
--> statement-breakpoint
INSERT OR IGNORE INTO `digital_c01_kind_equivalent` (`location_id`, `artifact_id`)
SELECT `candidate`.`location_id`, `candidate`.`artifact_id`
FROM `digital_c01_file_candidate` AS `candidate`
WHERE (
	SELECT COUNT(*) FROM `digital_c01_file_candidate` AS `peer`
	WHERE `peer`.`execution_id` = `candidate`.`execution_id`
		AND `peer`.`work_item_key` = `candidate`.`work_item_key`
		AND `peer`.`observed_reference` = `candidate`.`observed_reference`
	) > 1;
--> statement-breakpoint
-- v6 §3.1 第 7 步：一个 Location 只能有一种固定形态；同址同时得到 file 与 directory
-- 证明的库不符合 baseline 合同，写入固定私有诊断名并整体回滚。
INSERT INTO `digital_c01_guard` (`location_id`)
SELECT `location_id` FROM (
	SELECT `location_id`, `material_kind` FROM `digital_c01_binding`
	UNION ALL
	SELECT `location_id`, 'file' FROM `digital_c01_kind_equivalent`
	UNION ALL
	SELECT `location_id`, 'directory' FROM `digital_c01_directory_equivalent`
)
GROUP BY `location_id` HAVING COUNT(DISTINCT `material_kind`) > 1;
--> statement-breakpoint
INSERT OR IGNORE INTO `observed_material_boundaries`
	(`location_id`, `artifact_id`, `material_kind`, `derivation_kind`)
SELECT DISTINCT `location_id`, `artifact_id`, `material_kind`, 'legacy-exact'
FROM `digital_c01_binding`;
--> statement-breakpoint
INSERT OR IGNORE INTO `observed_material_boundaries`
	(`location_id`, `artifact_id`, `material_kind`, `derivation_kind`)
SELECT `location_id`, `artifact_id`, 'file', 'legacy-kind-equivalent'
FROM `digital_c01_kind_equivalent`;
--> statement-breakpoint
-- 重复 package 组只写永久 directory 形态；`observed_material_acceptances` 保持没有这些
-- Location 的行，因为库里不存在可证明的 execution→Location 归属。
INSERT OR IGNORE INTO `observed_material_boundaries`
	(`location_id`, `artifact_id`, `material_kind`, `derivation_kind`)
SELECT `location_id`, `artifact_id`, 'directory', 'legacy-kind-equivalent'
FROM `digital_c01_directory_equivalent`;
--> statement-breakpoint
INSERT OR IGNORE INTO `observed_material_acceptances`
	(`execution_id`, `proposal_id`, `work_item_key`, `acceptance_kind`, `asset_id`, `artifact_id`,
	`location_id`, `association_id`, `snapshot_id`, `observed_reference`)
SELECT `execution_id`, `proposal_id`, `work_item_key`, `acceptance_kind`, `asset_id`, `artifact_id`,
	`location_id`, `association_id`, `snapshot_id`, `observed_reference`
FROM `digital_c01_binding`;
--> statement-breakpoint
-- Location 的最早精确接受起点：在它之前只有同址路径的扫描不能证明该 Location。
CREATE TEMP VIEW `digital_c01_birth` AS
SELECT `location_id`, MIN(`execution_sequence`) AS `birth_sequence`
FROM `digital_c01_binding`
GROUP BY `location_id`;
--> statement-breakpoint
-- 扫描协调事件：成功完整 root scan 按 Location 的耐久 boundary 固定形态判断精确条目。
-- file 只有该地址当前登记的精确 Location（或唯一 file boundary）才取得正向支持，
-- 同址历史 Location 不因地址被复活；B 的人工选中 snapshot 与 C 的 selected projections
-- 都不展开为整根协调。
CREATE TEMP VIEW `digital_c01_coordination` AS
SELECT `locations`.`id` AS `location_id`, `root`.`root_id` AS `observed_root_id`,
	`root`.`root_version` AS `observed_root_version`, `root`.`root_path` AS `observed_root_path`,
	`root`.`authorized_targets_json` AS `authorized_targets_json`,
	`snapshot`.`snapshot_id` AS `snapshot_id`, `snapshot`.`observed_at` AS `observed_at`,
	`boundary`.`material_kind` AS `material_kind`, `boundary`.`derivation_kind` AS `derivation_kind`,
	CASE
		WHEN `boundary`.`material_kind` = 'directory' THEN EXISTS (
			SELECT 1 FROM json_each(`snapshot`.`snapshot_json`, '$.directories') AS `entry`
			WHERE json_extract(`entry`.`value`, '$.relativePath') = CASE
				WHEN `locations`.`address` = `snapshot`.`snapshot_root` THEN '.'
				ELSE substr(`locations`.`address`, length(`snapshot`.`snapshot_root`) + 2)
			END
		)
		ELSE EXISTS (
			SELECT 1 FROM json_each(`snapshot`.`snapshot_json`, '$.files') AS `entry`
			WHERE json_extract(`entry`.`value`, '$.relativePath') = CASE
				WHEN `locations`.`address` = `snapshot`.`snapshot_root` THEN '.'
				ELSE substr(`locations`.`address`, length(`snapshot`.`snapshot_root`) + 2)
			END
		) AND (`observations`.`location_id` = `locations`.`id`
			OR NOT EXISTS (
				SELECT 1 FROM `locations` AS `sibling`
				INNER JOIN `observed_material_boundaries` AS `sibling_boundary`
					ON `sibling_boundary`.`location_id` = `sibling`.`id`
					AND `sibling_boundary`.`material_kind` = 'file'
				WHERE `sibling`.`kind` = 'observed'
					AND `sibling`.`address` = `locations`.`address`
					AND `sibling`.`id` <> `locations`.`id`
			))
	END AS `present`,
	`executions`.`rowid` AS `execution_sequence`
FROM `workflow_executions` AS `executions`
INNER JOIN `digital_c01_snapshot` AS `snapshot` ON `snapshot`.`execution_id` = `executions`.`id`
INNER JOIN `digital_c01_root` AS `root` ON `root`.`execution_id` = `executions`.`id`
INNER JOIN `locations` AS `locations` ON `locations`.`kind` = 'observed'
INNER JOIN `observed_material_boundaries` AS `boundary`
	ON `boundary`.`location_id` = `locations`.`id`
LEFT JOIN `current_file_observations` AS `observations`
	ON `observations`.`address` = `locations`.`address`
WHERE `executions`.`operation_kind` = 'scan-filesystem'
	AND `executions`.`status` = 'completed'
	AND `executions`.`material_association_json` IS NULL
	AND NOT EXISTS (
		SELECT 1 FROM `recognition_proposals` AS `proposal`
		WHERE `proposal`.`id` = `executions`.`proposal_id`
			AND json_extract(`proposal`.`basis_json`, '$.kind') = 'manual-boundary'
	)
	AND (`snapshot`.`snapshot_root` = `root`.`root_path`
		OR substr(`snapshot`.`snapshot_root`, 1, length(`root`.`root_path`) + 1) = `root`.`root_path` || '/')
	AND (`locations`.`address` = `snapshot`.`snapshot_root`
		OR substr(`locations`.`address`, 1, length(`snapshot`.`snapshot_root`) + 1) =
			`snapshot`.`snapshot_root` || '/');
--> statement-breakpoint
-- 适用事件：精确载体只回放不早于其最早起点的接受与完整扫描；没有起点的同形态历史候选
-- 按形态取自己的证据来源——file 仍只用该坐标已有 coverage 上的完整事件（v5 §6.2），
-- directory 等价组则直接采用每个 root/version 自己覆盖该精确地址的完整扫描事件。
CREATE TEMP VIEW `digital_c01_event` AS
SELECT `location_id`, `observed_root_id`, `observed_root_version`, `observed_root_path`,
	`authorized_targets_json`, `snapshot_id`, `observed_at`, `material_kind`,
	1 AS `present`, `execution_sequence`
FROM `digital_c01_binding`
UNION ALL
SELECT `events`.`location_id`, `events`.`observed_root_id`, `events`.`observed_root_version`,
	`events`.`observed_root_path`, `events`.`authorized_targets_json`, `events`.`snapshot_id`,
	`events`.`observed_at`, `events`.`material_kind`, `events`.`present`,
	`events`.`execution_sequence`
FROM `digital_c01_coordination` AS `events`
LEFT JOIN `digital_c01_birth` AS `birth` ON `birth`.`location_id` = `events`.`location_id`
WHERE (`birth`.`birth_sequence` IS NOT NULL
		AND `events`.`execution_sequence` > `birth`.`birth_sequence`)
	OR (`birth`.`birth_sequence` IS NULL
		AND `events`.`derivation_kind` = 'legacy-kind-equivalent'
		AND CASE `events`.`material_kind`
			-- v6 §2.3：物理 directory 边界观察属于地址，不属于某个随机 Location；组内每个
			-- Location 已被独立证明同 asset、同址、同形态，因此同根同坐标的最近完整事件
			-- 逐 Location 等价投影，不借其他根的观察，也不被其他根的接受时间截断。
			WHEN 'directory' THEN EXISTS (
				SELECT 1 FROM `digital_c01_directory_equivalent` AS `group`
				WHERE `group`.`location_id` = `events`.`location_id`
			)
			ELSE EXISTS (
				SELECT 1 FROM `current_file_observation_supports` AS `coverage`
				WHERE `coverage`.`location_id` = `events`.`location_id`
					AND `coverage`.`observed_root_id` = `events`.`observed_root_id`
					AND `coverage`.`observed_root_version` = `events`.`observed_root_version`
			)
		END);
--> statement-breakpoint
-- 每个 (location, root, version) 只采用最近适用事件：时刻优先，再用保留的 workflow 行序
-- 作稳定并列判定。
CREATE TEMP VIEW `digital_c01_latest` AS
SELECT `location_id`, `observed_root_id`, `observed_root_version`, `observed_root_path`,
	`authorized_targets_json`, `snapshot_id`, `observed_at`, `material_kind`, `present`
FROM (
	SELECT `events`.*,
		ROW_NUMBER() OVER (
			PARTITION BY `events`.`location_id`, `events`.`observed_root_id`, `events`.`observed_root_version`
			ORDER BY `events`.`observed_at` DESC, `events`.`execution_sequence` DESC
		) AS `recency`
	FROM `digital_c01_event` AS `events`
)
WHERE `recency` = 1;
--> statement-breakpoint
-- 已确认目录 Location 也补齐覆盖历史：只有该坐标最近一次适用事件的根坐标留下一行，即使
-- 最近结果为 absent，避免已确认消失的旧目录回退到旧来源型进入规则。
INSERT INTO `current_file_observation_supports`
	(`location_id`, `observed_root_id`, `observed_root_version`, `observed_root_path`, `authorized_targets_json`)
SELECT `latest`.`location_id`, `latest`.`observed_root_id`, `latest`.`observed_root_version`,
	`latest`.`observed_root_path`, `latest`.`authorized_targets_json`
FROM `digital_c01_latest` AS `latest`
INNER JOIN `observed_material_boundaries` AS `boundary`
	ON `boundary`.`location_id` = `latest`.`location_id`
WHERE `boundary`.`material_kind` = 'directory'
ON CONFLICT(`location_id`, `observed_root_id`, `observed_root_version`) DO NOTHING;
--> statement-breakpoint
-- 只有最近结果为 present 的坐标才有正向支持，且 snapshot、时间、根坐标与授权闭包全部
-- 取自这一行事件。
INSERT INTO `current_observed_material_supports`
	(`location_id`, `observed_root_id`, `observed_root_version`, `material_kind`, `snapshot_id`,
	`observed_at`, `observed_root_path`, `authorized_targets_json`)
SELECT `latest`.`location_id`, `latest`.`observed_root_id`, `latest`.`observed_root_version`,
	`latest`.`material_kind`, `latest`.`snapshot_id`, `latest`.`observed_at`,
	`latest`.`observed_root_path`, `latest`.`authorized_targets_json`
FROM `digital_c01_latest` AS `latest`
WHERE `latest`.`present`
ON CONFLICT(`location_id`, `observed_root_id`, `observed_root_version`) DO NOTHING;
